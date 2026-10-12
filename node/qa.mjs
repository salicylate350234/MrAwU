/*!
 * MrAwU（阿物先生）— node/qa.mjs
 * 把指定模型的若干关键帧渲染成 PNG，用于人工/模型自检（浏览器截图在受限环境下不可用，
 * 但这里用的是与 HTML 完全相同的 lib/draw.js，所以看到的就是最终画面）。
 *
 * 依赖（仅本工具需要）：@napi-rs/canvas
 *   cd <skill> && npm i @napi-rs/canvas --cache <可写目录>
 *
 * 用法：
 *   node node/qa.mjs --model incline --times 0.2,0.8,1.6 --out build/qa
 *   node node/qa.mjs --model belt --frames 10,40,90
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sceneLib = require(path.join(ROOT, 'lib/scene.js'));
const simLib = require(path.join(ROOT, 'lib/sim.js'));
const drawLib = require(path.join(ROOT, 'lib/draw.js'));
const planck = require(path.join(ROOT, 'vendor/planck.min.js'));
const models = require(path.join(ROOT, 'lib/models/index.js'));

function loadCanvas() {
  const candidates = [
    path.join(ROOT, 'node_modules/@napi-rs/canvas'),
    process.env.PFA_CANVAS || '',
    path.resolve(ROOT, '../../../_env_probe/sim/node_modules/@napi-rs/canvas')
  ].filter(Boolean);
  for (const c of candidates) {
    try { return require(c); } catch (e) { /* try next */ }
  }
  throw new Error('未找到 @napi-rs/canvas。请在 skill 目录执行：npm i @napi-rs/canvas --cache <工作区内目录>\n' +
    '（该依赖只用于生成预览 PNG / GIF，浏览器端播放器完全不需要它。）');
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const k = argv[i].slice(2), v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) out[k] = true; else { out[k] = v; i++; }
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const canvasMod = loadCanvas();
const { createCanvas } = canvasMod;

// Node 端渲染需要显式注册中文字体，否则标签会变成方框（浏览器不需要这一步）
(function registerFont() {
  if (!canvasMod.GlobalFonts || !canvasMod.GlobalFonts.registerFromPath) return;
  const candidates = [
    'C:/Windows/Fonts/msyh.ttc', 'C:/Windows/Fonts/msyhl.ttc', 'C:/Windows/Fonts/simhei.ttf',
    'C:/Windows/Fonts/simsun.ttc', '/System/Library/Fonts/PingFang.ttc',
    '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc'
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        const ok = canvasMod.GlobalFonts.registerFromPath(p, 'PFA CJK');
        if (ok) { drawLib.setFont('"PFA CJK"'); return; }
      }
    } catch (e) { /* next */ }
  }
})();

const modelId = args.model || 'incline';
const model = models.get(modelId);
if (!model) throw new Error('未知模型: ' + modelId);
const params = args.params
  ? Object.assign(models.defaults(model), JSON.parse(args.params))
  : models.defaults(model);
const scene = models.scene(modelId, params, sceneLib);
scene.view.width = Number(args.width || scene.view.width || 1000);
scene.view.height = Number(args.height || scene.view.height || 560);

const result = simLib.createSim(planck, scene).record();
const frames = result.frames;
const view = drawLib.makeView(frames, scene);

let idxs;
if (args.frames) idxs = String(args.frames).split(',').map(Number);
else if (args.times) {
  const times = String(args.times).split(',').map(Number);
  idxs = times.map(t => {
    let best = 0, bd = Infinity;
    frames.forEach((f, i) => { const d = Math.abs(f.t - t); if (d < bd) { bd = d; best = i; } });
    return best;
  });
} else {
  const n = frames.length - 1;
  idxs = [Math.round(n * 0.15), Math.round(n * 0.45), Math.round(n * 0.75), n];
}

const outDir = path.resolve(args.out || path.join(ROOT, 'build/qa'));
fs.mkdirSync(outDir, { recursive: true });
// 超采样：和页面里一样至少 2 倍分辨率光栅化，导出图/截图更清晰
const SCALE = Math.min(3, Math.max(1, args.scale ? Number(args.scale) : 2));
const canvas = createCanvas(Math.round(view.width * SCALE), Math.round(view.height * SCALE));
const ctx = canvas.getContext('2d');
ctx.scale(SCALE, SCALE);

const written = [];
idxs.forEach((i, k) => {
  const frame = frames[Math.max(0, Math.min(frames.length - 1, i))];
  drawLib.render(ctx, view, frame, scene, {
    layers: { forces: true, velocity: true, grid: true, trail: true, dims: true },
    theme: args.theme ? String(args.theme) : 'dark',
    arrowMode: args['arrow-mode'] ? String(args['arrow-mode']) : 'all',
    labelMode: args['label-mode'] ? String(args['label-mode']) : 'full',
    labelSize: args['label-size'] ? Number(args['label-size']) : 12,
    trailFrames: frames.slice(0, Math.max(0, Math.min(frames.length - 1, i)) + 1),
    velocityScale: args.vscale ? Number(args.vscale) : (1.8 / Math.max(0.15, maxSpeed(frames))),
    showZeroForces: !!args.zeros,
    built: result.built
  });
  if (args['no-legend'] !== true) drawLib.drawLegend(ctx, view);
  if (args['no-hud'] !== true) drawLib.drawHud(ctx, view, frame);
  const suffix = (args['label-mode'] && args['label-mode'] !== 'full' ? '-' + args['label-mode'] : '') +
    (args['arrow-mode'] ? '-' + args['arrow-mode'] : '') + (args.theme === 'light' ? '-light' : '');
  const file = path.join(outDir, `${modelId}-${k + 1}-t${frame.t.toFixed(2)}${suffix}.png`);
  fs.writeFileSync(file, canvas.toBuffer('image/png'));
  written.push(file);
});

function maxSpeed(frames) {
  let m = 0;
  frames.forEach(f => Object.keys(f.bodies).forEach(id => {
    const b = f.bodies[id];
    if (b.type === 'dynamic') m = Math.max(m, Math.hypot(b.vx, b.vy));
  }));
  return m;
}

console.log('渲染完成：' + scene.title);
console.log('  力标尺 1 m ↔ ' + (1 / view.forceScale).toFixed(2) + ' N，取景比例 ' + view.pxPerM.toFixed(1) + ' px/m');
written.forEach(f => console.log('  ' + f));
