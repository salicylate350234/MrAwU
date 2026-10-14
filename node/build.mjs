/*!
 * MrAwU（阿物先生）— node/build.mjs
 * 把引擎、库、模型、播放器、模板全部内联成一个**单文件 HTML**。
 * 目标：老师只需拿到这一个文件，双击就能用 —— 不需要 node、不需要 python、不需要联网、不需要服务器。
 *
 * 用法：
 *   node node/build.mjs                     # 生成 dist/阿物先生.html（含全部模型）
 *   node node/build.mjs --out dist/foo.html
 *   node node/build.mjs --title "高中物理受力分析演示"
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);   // 用来在构建期校验模型是否已迁移到 Verlet

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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
const OUT = path.resolve(args.out || path.join(ROOT, 'dist/阿物先生.html'));
const TITLE = args.title || '阿物先生 · 物理受力分析动画演示器';
// --models plankPush  → 只打包这道题对应的模型（交给老师的文件里不会有无关模型）
const MODEL_FILTER = args.models ? String(args.models).split(',').map(s => s.trim()).filter(Boolean) : [];
// --engine verlet → 不打包 planck（模型必须都已迁移到自研 Verlet，构建时强制校验）
// 全部模型已迁移到自研 Verlet：默认就是 verlet（不打包 planck）；
// 需要时用 --engine planck 显式要求对照版。
const ENGINE = args.engine === 'planck' ? 'planck' : 'verlet';

// 顺序有意义：各 lib 在加载时就解析自己的依赖（浏览器端 UMD），
// 所以 scene 必须在最前、verlet 必须在 sim 之前。
const LIB_FILES = [
  'lib/scene.js', 'lib/field.js', 'lib/compose.js', 'lib/track.js', 'lib/verlet.js', 'lib/world.js', 'lib/sim.js', 'lib/verify.js',
  'lib/draw.js', 'lib/graph.js'
];
const MODEL_FILES = [
  'lib/models/shared.js', 'lib/models/mechanics.js', 'lib/models/motion.js',
  'lib/models/gravity.js', 'lib/models/electric.js', 'lib/models/combo.js', 'lib/models/track.js', 'lib/models/index.js'
];

function read(rel) {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) throw new Error('缺少文件: ' + rel);
  return fs.readFileSync(p, 'utf8');
}

/** 内联到 <script> 里必须避免出现 </script>，否则 HTML 解析会提前结束 */
function safeForScript(code) {
  return code.replace(/<\/script/gi, '<\\/script');
}

function banner(name, code) {
  return '\n/* ================= ' + name + ' ================= */\n' + code + '\n';
}

const planckCode = ENGINE === 'verlet' ? '' : read('vendor/planck.min.js');

// 轻量引擎的硬性前置条件：白名单里每个模型都必须声明 laws（否则它在页面里跑不起来）
if (ENGINE === 'verlet') {
  const registry = require(path.join(ROOT, 'lib/models/index.js'));
  const sceneLib = require(path.join(ROOT, 'lib/scene.js'));
  const ids = MODEL_FILTER.length ? MODEL_FILTER : registry.list.map(m => m.id);
  const missing = ids.filter(id => {
    const m = registry.byId[id];
    if (!m) return true;
    try { return !registry.scene(id, registry.defaults(m), sceneLib).laws; } catch (e) { return true; }
  });
  if (missing.length) {
    console.error('✗ --engine verlet 不可用：以下模型还没迁移到自研积分器（未声明 laws）：' + missing.join(', '));
    process.exit(1);
  }
}

const libCode = LIB_FILES.map(f => banner(f, read(f))).join('');
const modelCode = MODEL_FILES.map(f => banner(f, read(f))).join('');
const playerCode = banner('browser/player.js', read('browser/player.js'));

let html = read('browser/template.html');
const must = ['/*PFA:LIB*/', '/*PFA:GRAPH*/', '/*PFA:MODELS*/', '/*PFA:PLAYER*/'];
if (ENGINE !== 'verlet') must.push('/*PFA:PLANCK*/');
must.forEach(m => {
  if (html.indexOf(m) === -1) throw new Error('模板缺少占位符 ' + m);
});

html = html
  .split('__PFA_TITLE__').join(TITLE)
  .replace('<!--PFA:FILTER-->', (MODEL_FILTER.length || ENGINE === 'verlet')
    ? '<script>window.PFA_MODEL_FILTER = ' + JSON.stringify(MODEL_FILTER) +
      '; window.PFA_ENGINE = ' + JSON.stringify(ENGINE) + ';<\/script>'
    : '')
  .replace('/*PFA:PLANCK*/', () => ENGINE === 'verlet'
    ? '/* 轻量版：不含 planck.js，全部由自研 velocity-Verlet 积分器计算 */'
    : safeForScript(planckCode))
  .replace('/*PFA:LIB*/', () => safeForScript(libCode))
  .replace('/*PFA:MODELS*/', () => safeForScript(modelCode))
  .replace('/*PFA:PLAYER*/', () => safeForScript(playerCode));

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, html);

// ---- 自检：单文件必须真正自包含 ----
const problems = [];
const externalScript = html.match(/<script[^>]+src=/gi);
const externalLink = html.match(/<link[^>]+href=/gi);
const externalFetch = html.match(/fetch\s*\(|XMLHttpRequest|import\s*\(/g);
if (externalScript) problems.push('存在外链脚本: ' + externalScript.length + ' 处');
if (externalLink) problems.push('存在外链样式: ' + externalLink.length + ' 处');
if (externalFetch) problems.push('存在网络请求代码: ' + externalFetch.join(', '));
if (html.indexOf('type="module"') !== -1) problems.push('包含 ES module（file:// 下会被 CORS 拦截）');

const kb = (fs.statSync(OUT).size / 1024).toFixed(0);
console.log('已生成单文件：' + OUT);
console.log('  体积 ' + kb + ' KB');
console.log('  引擎：' + (ENGINE === 'verlet'
  ? '自研 velocity-Verlet（不含 planck，省掉 290 KB）'
  : (ENGINE === 'auto' ? '按模型自动选择（声明 laws 的用 Verlet）' : 'planck.js')));
if (MODEL_FILTER.length) {
  console.log('  模型白名单：' + MODEL_FILTER.join(', ') + '（交给老师的文件里只会出现这些模型）');
} else {
  console.log('  含全部模型：' + (modelCode.match(/id: '/g) || []).length + ' 个（含参数表内的引用）');
}
if (problems.length) {
  console.log('  ⚠ 自包含检查未通过：');
  problems.forEach(p => console.log('    - ' + p));
  process.exitCode = 1;
} else {
  console.log('  自包含检查通过：无外链、无网络请求、无 ES module（可直接 file:// 双击打开）');
}
