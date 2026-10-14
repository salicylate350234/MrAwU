/*!
 * MrAwU（阿物先生）— node/quick.mjs
 * 单模型快问快答：只跑一个模型，回答四件事——
 *   ① 末态在哪、多快  ② 残差 max  ③ 能量漂移  ④ 该模型 expect() 对照项的 PASS/FAIL 汇总
 * 用途：迭代物理（改参数、调受力律）时不要每次都跑全库；
 *       tests.mjs / audit.mjs / compare-engines.cjs 是交付前的完整闸门，这里只求"秒级反馈"。
 *
 * 用法：
 *   node node/quick.mjs --model incline [--params '{"theta":37,"mu":0.25}'] [--brief]
 *                       [--engine verlet|planck] [--list]
 *   默认输出 ≤12 行；--brief ≤5 行（失败项仍然一行一条）。
 *
 * 引擎：默认跑"交付用的那个后端"——模型声明了 laws 就是自研 verlet，否则 planck；
 *       需要对照时用 --engine planck 显式指定（模型没迁移到 verlet 时也只能用 planck）。
 * 退出码：0 = 对照项全 PASS；1 = 有对照项 FAIL / 无法测量；2 = 用法或运行错误。
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sceneLib = require(path.join(ROOT, 'lib/scene.js'));
const simLib = require(path.join(ROOT, 'lib/sim.js'));
const verifyLib = require(path.join(ROOT, 'lib/verify.js'));
const planck = require(path.join(ROOT, 'vendor/planck.min.js'));
const models = require(path.join(ROOT, 'lib/models/index.js'));

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

function fmt(v, d = 3) {
  return (v == null || !isFinite(v)) ? '—' : Number(v).toFixed(d);
}

function usage(msg) {
  if (msg) console.error('错误: ' + msg);
  console.error('用法: node node/quick.mjs --model <id> [--params \'{...}\'] [--brief] [--engine verlet|planck]');
  console.error('可用模型: ' + models.list.map(m => m.id).join(', '));
}

const args = parseArgs(process.argv.slice(2));
if (args.list) {
  models.list.forEach(m => console.log(m.id.padEnd(18) + m.title + '  [' + m.group + ']'));
  process.exit(0);
}
if (!args.model || args._.length) {
  usage('必须给 --model <id>（或 --list 看清单）');
  process.exit(2);
}

const model = models.get(args.model);
if (!model) {
  usage('未知模型: ' + args.model);
  process.exit(2);
}

let params;
try {
  params = args.params ? Object.assign(models.defaults(model), JSON.parse(args.params)) : models.defaults(model);
} catch (e) {
  usage('--params 不是合法 JSON: ' + e.message);
  process.exit(2);
}

const scene = models.scene(model.id, params, sceneLib);
const problems = sceneLib.validate(scene);
problems.warnings.forEach(w => console.error('警告: ' + w));
if (!problems.ok) {
  problems.errors.forEach(e => console.error('错误: ' + e));
  process.exit(2);
}

// 默认跑交付用的后端：声明了 laws 的模型走自研 verlet，其余走 planck
const engine = (args.engine === 'planck' || args.engine === 'verlet') ? args.engine : (scene.laws ? 'verlet' : 'planck');

let frames;
const t0 = Date.now();
try {
  frames = simLib.createSim(engine === 'planck' ? planck : null, scene, { engine: engine }).record().frames;
} catch (e) {
  console.error('错误: ' + engine + ' 运行失败: ' + (e && e.message));
  process.exit(2);
}
const ms = Date.now() - t0;

if (!frames || frames.length < 2) {
  console.error('错误: 仿真没有产生帧');
  process.exit(2);
}

const first = frames[0];
const last = frames[frames.length - 1];
const resMax = Math.max.apply(null, frames.slice(1).map(f => f.stats.residualMax));
const e0 = first.stats.mechanical, e1 = last.stats.mechanical;
const drift = (e0 == null || e1 == null) ? null : (e1 - e0);
const driftPct = (drift == null || !e0) ? null : (drift / Math.abs(e0) * 100);

const rows = (typeof model.expect === 'function') ? (verifyLib.run(model, params, frames, scene) || []) : [];
const fails = rows.filter(r => r.pass !== true);
const okCount = rows.length - fails.length;

function failLine(r) {
  const head = '  ✗ ' + r.label + '  解析 ' + fmt(r.theory, 4) + '  仿真 ' + fmt(r.sim, 4);
  return r.relError == null ? (head + '  无法测量') : (head + '  误差 ' + (r.relError * 100).toFixed(3) + '%');
}

const dyn = Object.keys(last.bodies).filter(id => last.bodies[id].type === 'dynamic');
function bodyText(id) {
  const b = last.bodies[id];
  return (b.label || id) + '  x=' + fmt(b.x, 3) + ' m  y=' + fmt(b.y, 3) +
    ' m  v=(' + fmt(b.vx, 3) + ', ' + fmt(b.vy, 3) + ') m/s  |v|=' + fmt(Math.hypot(b.vx, b.vy), 3);
}

const lines = [];
if (args.brief) {
  lines.push(model.id + '  ' + (fails.length ? 'FAIL' : 'PASS') + '  ' +
    (rows.length ? okCount + '/' + rows.length + ' 对照项' : '无对照项') +
    '  残差max ' + (resMax * 100).toFixed(3) + '%' +
    '  能量漂移 ' + (drift == null ? '—' : fmt(drift, 4) + ' J') +
    (driftPct == null ? '' : '（' + driftPct.toFixed(3) + '%）'));
  if (dyn.length) {
    lines.push('末态 ' + dyn.slice(0, 2).map(bodyText).join('  |  ') + (dyn.length > 2 ? '  |  另 ' + (dyn.length - 2) + ' 个刚体' : ''));
  }
  let shown = 0;
  for (const r of fails) {
    if (lines.length >= 4 && fails.length - shown > 1) break;
    lines.push(failLine(r)); shown++;
  }
  if (shown < fails.length) lines.push('  …另有 ' + (fails.length - shown) + ' 项失败');
} else {
  lines.push('模型     : ' + model.id + ' — ' + model.title + (model.group ? '  [' + model.group + ']' : ''));
  lines.push('引擎/帧数: ' + engine + ' / ' + (frames.length - 1) + ' 帧（' + scene.meta.duration.toFixed(2) +
    ' s，子步 ' + scene.meta.subSteps + '，耗时 ' + ms + ' ms）');
  if (dyn.length) {
    dyn.slice(0, 2).forEach(id => lines.push('末态     : ' + bodyText(id)));
    if (dyn.length > 2) lines.push('末态     : 另 ' + (dyn.length - 2) + ' 个动态刚体（--brief 或 sim.mjs 看全表）');
  } else {
    lines.push('末态     : （无动态刚体：静态/场类场景）');
  }
  lines.push('残差 max : ' + (resMax * 100).toFixed(3) + '%（判据 <0.5%）');
  lines.push('能量漂移 : ' + (drift == null ? '—' : fmt(drift, 4) + ' J') +
    (driftPct == null ? '' : '（相对 ' + driftPct.toFixed(4) + '%）') +
    '  ※机械能；有摩擦/碰撞/非保守力时不守恒，仅供参考');
  lines.push('对照项   : ' + (rows.length ? okCount + '/' + rows.length + (fails.length ? ' PASS 有失败' : ' PASS') : '该模型没有 expect()，仅报告末态与残差'));
  let shown = 0;
  for (const r of fails) {
    if (lines.length >= 11 && fails.length - shown > 1) break;
    lines.push(failLine(r)); shown++;
  }
  if (shown < fails.length) {
    lines.push('  …另有 ' + (fails.length - shown) + ' 项失败，用 node node/sim.mjs --model ' + model.id + ' 看全表');
  }
}

lines.forEach(l => console.log(l));
process.exit(fails.length ? 1 : 0);
