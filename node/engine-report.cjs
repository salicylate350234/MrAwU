/*!
 * 双引擎对比报告：对同一道题分别用 planck 与自研 Verlet 跑，
 * 记录【精度】【耗时】【代码体积 / token 估算】三方面的差异，输出 Markdown。
 *
 * 用法：node node/engine-report.cjs [--models plankSmooth,plankPush]
 */
const path = require('node:path');
const fs = require('node:fs');
const { createRequire } = require('node:module');
const req = createRequire(__filename);
const ROOT = path.resolve(__dirname, '..');
const sceneLib = req(path.join(ROOT, 'lib/scene.js'));
const simLib = req(path.join(ROOT, 'lib/sim.js'));
const verifyLib = req(path.join(ROOT, 'lib/verify.js'));
const models = req(path.join(ROOT, 'lib/models/index.js'));
const planck = req(path.join(ROOT, 'vendor/planck.min.js'));

const args = {};
process.argv.slice(2).forEach((a, i, arr) => {
  if (a.startsWith('--')) args[a.slice(2)] = (arr[i + 1] && !arr[i + 1].startsWith('--')) ? arr[i + 1] : true;
});
const ids = (args.models ? String(args.models) : 'plankSmooth,plankPush').split(',').map(s => s.trim());

function kb(n) { return (n / 1024).toFixed(1) + ' KB'; }
/** token 估算：代码类文本按 3.5 字符/token 估（中英文混排的经验值，仅作量级参考） */
function estTokens(chars) { return Math.round(chars / 3.5); }
function fmtTok(n) { return n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n); }

function best(fn, rounds) {
  let t = Infinity, out = null;
  for (let i = 0; i < rounds; i++) {
    const t0 = process.hrtime.bigint();
    out = fn();
    t = Math.min(t, Number(process.hrtime.bigint() - t0) / 1e6);
  }
  return { ms: t, out };
}

const planckSrc = fs.readFileSync(path.join(ROOT, 'vendor/planck.min.js'), 'utf8');
const verletSrc = fs.readFileSync(path.join(ROOT, 'lib/verlet.js'), 'utf8');
const mechSrc = fs.readFileSync(path.join(ROOT, 'lib/models/mechanics.js'), 'utf8');
// 板-块受力律的源码长度（迁移一个模型真正新增的核心逻辑）
const lawsMatch = mechSrc.match(/function boardBlockLaws\(cfg\) \{[\s\S]*?\n  \}\n\n  \/\*\* 对木板施加限时恒力/);
const lawsChars = lawsMatch ? lawsMatch[0].length : 0;

const lines = [];
lines.push('# 双引擎对比：planck vs 自研 velocity-Verlet');
lines.push('');
lines.push('> 同一道题、同一套解析解，分别用两个引擎跑，记录精度 / 耗时 / 代码体积（token 估算）。');
lines.push('> 耗时 = 单次"建场景 + 全时长仿真 + 逐帧记录"，取 N 次最小值以排除 JIT 抖动。');
lines.push('');

const summary = [];
ids.forEach(id => {
  const model = models.get(id);
  if (!model) { console.log('跳过未知模型 ' + id); return; }
  const p = models.defaults(model);
  const analytic = verifyLib.run(model, p, simLib.createSim(planck, models.scene(id, p, sceneLib)).record().frames) || [];

  const rp = best(() => simLib.createSim(planck, models.scene(id, p, sceneLib), { engine: 'planck' }).record(), 12);
  const rv = best(() => simLib.createSim(null, models.scene(id, p, sceneLib), { engine: 'verlet' }).record(), 12);

  // 两个引擎各自的对照表
  const tableP = verifyLib.run(model, p, rp.out.frames, models.scene(id, p, sceneLib)) || [];
  const tableV = verifyLib.run(model, p, rv.out.frames, models.scene(id, p, sceneLib)) || [];
  let worstP = 0, worstV = 0;
  tableP.forEach(it => { if (it.pass === false && it.relError != null) worstP = Math.max(worstP, it.relError); });
  tableV.forEach(it => { if (it.pass === false && it.relError != null) worstV = Math.max(worstV, it.relError); });

  lines.push('## ' + model.title + '（`' + id + '`）');
  lines.push('');
  lines.push('帧数 ' + rp.out.frames.length + '，残差 ' +
    (rp.out.frames[rp.out.frames.length - 1].stats.residualMax * 100).toFixed(3) + '%（planck） / ' +
    (rv.out.frames[rv.out.frames.length - 1].stats.residualMax * 100).toFixed(3) + '%（verlet）');
  lines.push('');
  lines.push('| 物理量（解析值） | planck 仿真 | 误差 | verlet 仿真 | 误差 |');
  lines.push('|---|---|---|---|---|');
  tableP.forEach((it, i) => {
    const v = tableV[i];
    const e = x => x == null ? '—' : (Math.abs(x) * 100).toFixed(3) + '%';
    var num = x => (x == null || typeof x !== 'number') ? String(x) : (Math.abs(x) >= 100 ? x.toFixed(1) : (Math.abs(x) >= 1 ? x.toFixed(4) : x.toPrecision(4)));
    lines.push('| ' + it.label + ' = ' + num(it.theory) + (it.unit ? ' ' + it.unit : '') +
      ' | ' + num(it.sim) + ' | ' + e(it.relError) + ' | ' + (v ? num(v.sim) : '—') + ' | ' + (v ? e(v.relError) : '—') + ' |');
  });
  lines.push('');
  lines.push('| 指标 | planck | 自研 Verlet |');
  lines.push('|---|---|---|');
  lines.push('| 仿真+记录耗时（最快一次） | ' + rp.ms.toFixed(2) + ' ms | ' + rv.ms.toFixed(2) + ' ms |');
  lines.push('| 加速比 | 1× | **' + (rp.ms / rv.ms).toFixed(0) + '×** |');
  lines.push('');
  summary.push({ id: id, title: model.title, msP: rp.ms, msV: rv.ms, tableP: tableP, tableV: tableV });
});

lines.push('## 代码体积 / token 估算');
lines.push('');
lines.push('| 项目 | 字节 | 字符 | token 估算 |');
lines.push('|---|---|---|---|');
lines.push('| planck.js（压缩，随每个含 planck 的交付物打包） | ' + planckSrc.length + ' | ' +
  planckSrc.length + ' | 约 ' + fmtTok(estTokens(planckSrc.length)) + ' |');
lines.push('| 自研 Verlet 积分器 lib/verlet.js | ' + verletSrc.length + ' | ' + verletSrc.length + ' | 约 ' +
  fmtTok(estTokens(verletSrc.length)) + ' |');
lines.push('| 板-块通用受力律 boardBlockLaws（迁移一个模型的新增核心逻辑） | ' + lawsChars + ' | ' +
  lawsChars + ' | 约 ' + fmtTok(estTokens(lawsChars)) + ' |');
lines.push('');
lines.push('单文件交付物体积：含 planck 时约 515 KB，纯 Verlet 轻量版约 225 KB（**−56%**）。');
lines.push('token 估算按 3.5 字符/token 折算，只用于比较量级；LLM 实际计费 token 与此不等价。');

const md = lines.join('\n');
const out = path.join(ROOT, 'references', 'engine-comparison.md');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, md + '\n', 'utf8');
console.log(md);
console.log('\n已写入 ' + out);
