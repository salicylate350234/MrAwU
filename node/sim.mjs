/*!
 * MrAwU（阿物先生）— node/sim.mjs
 * 无头仿真 CLI：跑模型 / 跑自定义场景，输出受力报告与「解析值 vs 仿真值」对照。
 *
 * 用法：
 *   node node/sim.mjs --model incline --params '{"theta":30,"mu":0.2}'
 *   node node/sim.mjs --model belt --report --export build/frames.json
 *   node node/sim.mjs --scene examples/incline.json
 *   node node/sim.mjs --list
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const sceneLib = require('../lib/scene.js');
const worldLib = require('../lib/world.js');
const simLib = require('../lib/sim.js');
const verifyLib = require('../lib/verify.js');
const planck = require('../vendor/planck.min.js');
const models = require('../lib/models/index.js');

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[key] = true;
      else { out[key] = next; i++; }
    } else out._.push(a);
  }
  return out;
}

export function loadScene(args) {
  if (args.scene) {
    const raw = JSON.parse(fs.readFileSync(path.resolve(args.scene), 'utf8'));
    return { scene: sceneLib.normalize(raw), model: null, params: null };
  }
  const id = args.model || 'incline';
  const model = models.get(id);
  if (!model) throw new Error('未知模型: ' + id + '（可用：' + models.list.map(m => m.id).join(', ') + '）');
  const params = args.params
    ? Object.assign(models.defaults(model), JSON.parse(args.params))
    : models.defaults(model);
  return { scene: models.scene(id, params, sceneLib), model, params };
}

export function runScene(scene) {
  const sim = simLib.createSim(planck, scene);
  return sim.record();
}

function fmt(v, d = 3) {
  return (v == null || !isFinite(v)) ? '—' : Number(v).toFixed(d);
}

function report(result, model, params) {
  const { scene, frames } = result;
  const last = frames[frames.length - 1];
  console.log('场景     : ' + scene.title + (scene.subtitle ? ' — ' + scene.subtitle : ''));
  console.log('时长/帧数: ' + scene.meta.duration.toFixed(2) + ' s / ' + (frames.length - 1) +
    ' 帧（dt=' + scene.meta.dt.toFixed(5) + ' s，子步=' + scene.meta.subSteps + '）');
  console.log('残差 |ΣJ−Δp| 最大相对值 : ' + (Math.max.apply(null, frames.slice(1).map(f => f.stats.residualMax)) * 100).toFixed(4) + ' %');
  console.log('机械能 初 → 末          : ' + fmt(frames[0].stats.mechanical) + ' → ' + fmt(last.stats.mechanical) + ' J');
  console.log('');
  console.log('刚体受力（末帧，单位 N / N·m）');
  console.log('  ' + ['刚体', '重力', '法向', '摩擦', '关节', '外力', '合力', '质量', '加速度'].join('\t'));
  Object.keys(last.bodies).forEach((id) => {
    const b = last.bodies[id];
    if (b.type !== 'dynamic') return;
    const f = b.forces;
    const fm = (v) => '[' + fmt(v[0], 2) + ',' + fmt(v[1], 2) + ']';
    console.log('  ' + [b.label || id, fm(f.gravity), fm(f.normal), fm(f.friction), fm(f.joint),
      fm(f.applied), fm(f.total), fmt(b.mass, 2), fm(b.accel)].join('\t'));
  });

  if (model && typeof model.expect === 'function') {
    const rows = verifyLib.run(model, params, frames, scene);
    console.log('');
    console.log('解析值 vs 仿真值');
    console.log('  ' + ['物理量', '解析值', '仿真值', '相对误差', '判定'].join('\t'));
    rows.forEach((r) => {
      console.log('  ' + [r.label, fmt(r.theory, 4), fmt(r.sim, 4),
        r.relError == null ? '—' : (r.relError * 100).toFixed(3) + '%',
        r.pass ? 'PASS' : (r.relError == null ? '无法测量' : 'FAIL')].join('\t'));
    });
    return rows;
  }
  return [];
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.list) {
    models.list.forEach(m => console.log(m.id.padEnd(14) + m.title + '  [' + m.group + ']'));
    return 0;
  }
  const { scene, model, params } = loadScene(args);
  const problems = sceneLib.validate(scene);
  problems.warnings.forEach(w => console.error('警告: ' + w));
  if (!problems.ok) {
    problems.errors.forEach(e => console.error('错误: ' + e));
    return 2;
  }
  const t0 = Date.now();
  const result = runScene(scene);
  const ms = Date.now() - t0;
  const rows = report(result, model, params);
  console.log('');
  console.log('仿真耗时 ' + ms + ' ms，' + result.frames.length + ' 帧');
  if (args.export) {
    const out = path.resolve(args.export);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify({
      scene: {
        id: scene.id, title: scene.title, subtitle: scene.subtitle, notes: scene.notes,
        meta: scene.meta, view: scene.view, bodies: scene.bodies, joints: scene.joints,
        forces: scene.forces, modelId: scene.modelId, params: scene.params
      },
      frames: result.frames
    }));
    console.log('已导出帧数据: ' + out + ' (' + (fs.statSync(out).size / 1024).toFixed(0) + ' KB)');
  }
  const failed = rows.filter(r => !r.pass && r.sim != null);
  return failed.length ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().then(code => process.exit(code)).catch((e) => { console.error(e); process.exit(2); });
}
