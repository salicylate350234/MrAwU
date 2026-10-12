/* 为"是否用 Verlet 数值积分替换 planck"做量化基线：引擎体积/行数、构建与仿真耗时、每模型规模 */
const { createRequire } = require('node:module');
const req = createRequire(__filename);
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');

const sceneLib = req(path.join(ROOT, 'lib/scene.js'));
const simLib = req(path.join(ROOT, 'lib/sim.js'));
const verifyLib = req(path.join(ROOT, 'lib/verify.js'));
const models = req(path.join(ROOT, 'lib/models/index.js'));
const planckPath = path.join(ROOT, 'vendor/planck.min.js');
const planckCode = fs.readFileSync(planckPath, 'utf8');

function kb(n) { return (n / 1024).toFixed(0) + ' KB'; }
function lines(s) { return s.split('\n').length; }

console.log('=== 1. 引擎与源码体积 ===');
console.log('planck.min.js      ' + kb(planckCode.length).padStart(8) + '   1 行（压缩）');
let srcChars = 0, srcLines = 0;
['lib/scene.js', 'lib/world.js', 'lib/sim.js', 'lib/verify.js', 'lib/draw.js', 'lib/graph.js',
 'lib/models/index.js', 'lib/models/mechanics.js', 'lib/models/motion.js',
 'browser/player.js', 'browser/template.html'].forEach(f => {
  const c = fs.readFileSync(path.join(ROOT, f), 'utf8');
  srcChars += c.length; srcLines += lines(c);
});
console.log('其余自有源码       ' + kb(srcChars).padStart(8) + '   ' + srcLines + ' 行');
const dist = path.join(ROOT, 'dist/板块模型·拉木板（题图 15 题）.html');
if (fs.existsSync(dist)) {
  const total = fs.statSync(dist).size;
  console.log('单文件 HTML        ' + kb(total).padStart(8) + '   其中引擎占 ' +
    (planckCode.length / total * 100).toFixed(0) + '%');
}

console.log('\n=== 2. planck 的解析/编译耗时（Node 侧代理指标） ===');
let t0 = Date.now();
new Function(planckCode)();
console.log('首次 compile+evaluate：' + (Date.now() - t0) + ' ms');
t0 = Date.now();
for (let i = 0; i < 5; i++) new Function(planckCode)();
console.log('再 5 次平均：' + ((Date.now() - t0) / 5).toFixed(1) + ' ms');

console.log('\n=== 3. 每个模型的规模与耗时（仿真 = planck 每帧步进） ===');
console.log('模型'.padEnd(14) + '帧数'.padStart(6) + '  刚体/关节/接触对'.padStart(18) +
  '  建场景'.padStart(9) + '  仿真+记录'.padStart(11) + '  校验'.padStart(8));
const planck = req(planckPath);
const rows = [];
models.list.forEach(m => {
  const p = models.defaults(m);
  let s0 = process.hrtime.bigint();
  const scene = models.scene(m.id, p, sceneLib);
  let s1 = process.hrtime.bigint();
  const res = simLib.createSim(planck, scene).record();
  let s2 = process.hrtime.bigint();
  let verify = [];
  try { verify = verifyLib.run(scene.expect || [], res.frames, scene) || []; } catch (e) { verify = []; }
  let s3 = process.hrtime.bigint();
  const ms = (a, b) => Number(b - a) / 1e6;
  const dyn = scene.bodies.filter(b => b.type === 'dynamic').length;
  const stat = scene.bodies.filter(b => b.type !== 'dynamic').length;
  const fric = scene.bodies.filter(b => b.friction > 0).length;
  rows.push({ id: m.id, frames: res.frames.length, msSim: ms(s1, s2) });
  console.log(m.id.padEnd(14) + String(res.frames.length).padStart(6) +
    ('  ' + dyn + '动/' + stat + '静/' + (scene.joints || []).length + '关节/' + fric + '带摩擦').padStart(18) +
    (ms(s0, s1).toFixed(1) + 'ms').padStart(9) +
    (ms(s1, s2).toFixed(1) + 'ms').padStart(11) +
    (ms(s2, s3).toFixed(1) + 'ms').padStart(8));
});
const totalFrames = rows.reduce((a, r) => a + r.frames, 0);
const totalSim = rows.reduce((a, r) => a + r.msSim, 0);
console.log('合计 ' + rows.length + ' 个模型 / ' + totalFrames + ' 帧 / 仿真 ' + totalSim.toFixed(1) + ' ms');
console.log('平均每帧 ' + (totalSim / totalFrames).toFixed(3) + ' ms');

console.log('\n=== 4. 关键：模型是否需要"接触求解" ===');
console.log('需要（块与板/带/地面之间的法向力+摩擦力+静摩擦判据）: plank, plankPush, belt, connector, circular');
console.log('不需要（只有重力/外力/简单约束/事件冲量）: freefall, projectile, incline, inclinePush, atwood, spring, collision, balance');
