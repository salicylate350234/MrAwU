/*!
 * MrAwU（阿物先生）— node/tests.mjs
 * 回归测试：对每个模型（含若干参数组合）检查
 *   1) 受力分解残差 |ΣJ − Δp| —— 受力图画得对不对的机器自检
 *   2) 解析解 vs 仿真值 —— 物理对不对
 * 退出码非 0 表示有失败项。
 *
 * 用法： node node/tests.mjs [--verbose] [--only incline,spring]
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

const args = process.argv.slice(2);
const verbose = args.includes('--verbose');
const only = (() => {
  const i = args.indexOf('--only');
  return i >= 0 && args[i + 1] ? args[i + 1].split(',') : null;
})();

const CASES = {
  // 电磁学组：匀强电场（加速 / 偏转）
  efieldAccel: [
    {},
    { v0: 1 },                          // 有初速度
    { U: 2000 },                        // 大电压
    { mass: 6, q: 1 },                  // 大质量小电量
    { d: 0.8, U: 400 }
  ],
  comboAccelDeflect: [
    {},
    // 换粒子种类：Y 必须完全不变（这正是"与 q、m 无关"那条对照项要验的）
    { q: 1, mass: 4 },
    // 下面两组顺手把电压/板长调到合法范围：否则粒子会打在偏转极板上，模型会直接报错
    { U1: 2000, U2: 300 },
    { plateLen: 0.5, screenDist: 0.6, U2: 60 }
  ],
  efieldDeflect: [
    {},
    { v0: 3 },                          // 入射更快 → 偏转更小
    { U: 400, v0: 3 },                  // 电压更大
    // 更长的极板与更远的屏：注意 L=0.8 时若还用默认电压，y₁ 会超过 d/2（粒子打在极板上），
    // 此时模型会**主动报错**而不是画出穿板而过的假动画，所以这里同时把 U、d 调到合法范围
    { plateLen: 0.8, screenDist: 0.8, U: 60, d: 0.12 },
    { q: 1, mass: 4 }
  ],
  // 电磁学组：静电场（题目约束排布 + 手动电荷列表）
  efield: [
    {},
    { preset: 'single' },
    { preset: 'triangle' },        // 等边三角形：几何中心场强应为 0（对称性）
    { preset: 'square' },
    { preset: 'line' },
    { preset: 'single', scale: 2 }
  ],
  // 万有引力组：双星（等质量 / 悬殊质量 / 不同间距）
  binaryStar: [
    {},
    { mass1: 1, mass2: 1 },                       // 等质量双星：两者速率相同
    { mass1: 9, mass2: 1, r: 8 },                 // 质量悬殊：大星几乎不动
    { mass1: 2, mass2: 5, r: 3, G: 2.5 }          // 反向质量比 + 大 G
  ],
  incline: [{}, { theta: 45, mu: 0.1 }, { theta: 15, mu: 0.9 }, { theta: 30, mu: 0.6, mass: 5 }],
  freefall: [{}, { height: 5 }, { height: 45, mass: 5 }],
  belt: [{}, { v: 6, v0: 0, mu: 0.5 }, { v: 0, v0: 8, mu: 0.4 }, { v: -4, v0: 3, mu: 0.3 }],
  plank: [{}, { mu2: 0.1, v0: 8 }, { plankMass: 8, mass: 1 }],
  // 题图同款：对木板施加限时水平恒力（F=26N 作用 2s，答 4 m / 5.2 m）
  // 覆盖三种情形：一起运动 / 相对滑动 / F 太小整体不动
  plankPush: [
    {},
    { force: 20 },                       // 恰好临界，一起运动
    { force: 5 },                        // F = f₂，刚好推不动
    { force: 45, tF: 1.5, mu2: 0.05 },
    { mass: 1, boardMass: 5, mu1: 0.5 }
  ],
  connector: [{}, { force: 30, mass1: 5, mass2: 1 }],
  atwood: [{}, { mass1: 4, mass2: 2 }, { mass1: 1, mass2: 3 }],
  spring: [{}, { k: 80, mass: 2, amplitude: 0.5 }, { k: 400, mass: 0.5 }],
  // ---- 运动学模型组（lib/models/motion.js）----
  // 平抛（θ=0）、斜抛、大高度平抛、斜下抛（反直觉：射程反而更短）
  projectile: [
    {},
    { angle: 35, v0: 20, height: 8 },
    { angle: 0, v0: 18, height: 40, mass: 3 },
    { angle: -20, v0: 10, height: 12 }
  ],
  // 水平面匀速圆周 / 转盘 / 竖直轨道（能过顶 + 过不了顶两种边界）
  // 竖直面内圆周运动：杆约束，能完成整圈 / 初速度不足则往复摆动
  // 注意：这个模型用的是 DistanceJoint，快速转动时位置修正会耗散约 1% 机械能，
  // 所以模型内部把子步加密到 48（dt=1/2880），容差取 2%（详见模型 notes）。
  circular: [
    {},
    { r: 0.4, v0: 5.0, mass: 0.5 },
    { r: 0.9, v0: 8.0, mass: 2 },
    { r: 0.6, v0: 3.0 }                  // v₀² < 4gL：摆动，摆不过最高点
  ],
  // 完全非弹性 / 弹性 / 重撞轻 / 轻撞重（反直觉：e=1 且 m₁<m₂ 时 m₁ 被弹回）
  collision: [
    {},
    { restitution: 0, v0: 6 },
    { restitution: 1, mass1: 3, mass2: 3, v0: 5 },
    { restitution: 0.8, mass1: 1, mass2: 6 },
    { restitution: 1, mass1: 5, mass2: 1, v0: 6 }
  ],
  // 对称悬挂 / 偏置（两绳张力不等）/ 锚点很远（绳接近竖直）
  balance: [
    {},
    { offset: 0.5 },
    { spread: 2.2, height: 1.2, mass: 5 },
    { offset: -0.6, mass: 0.5, spread: 0.3, height: 4 }
  ]
};

const RESIDUAL_TOL = 0.005;
let failures = 0, checks = 0, cases = 0;
const failuresList = [];

Object.keys(CASES).forEach((id) => {
  if (only && only.indexOf(id) === -1) return;
  const model = models.get(id);
  if (!model) { console.log('!! 缺少模型 ' + id); failures++; return; }
  CASES[id].forEach((over, ci) => {
    cases++;
    const params = Object.assign(models.defaults(model), over);
    const label = id + ' #' + (ci + 1) + ' ' + JSON.stringify(over);
    let frames, scene;
    try {
      scene = models.scene(id, params, sceneLib);
      const v = sceneLib.validate(scene);
      if (!v.ok) throw new Error('场景校验失败: ' + v.errors.join('; '));
      frames = simLib.createSim(planck, scene).record().frames;
    } catch (e) {
      console.log('FAIL  ' + label + '\n      运行异常: ' + (e && e.message));
      failures++; failuresList.push(label + ' (异常)');
      return;
    }
    const resMax = Math.max.apply(null, frames.slice(1).map(f => f.stats.residualMax));
    const absMax = Math.max.apply(null, frames.slice(1).map(f => f.stats.residualAbsMax || 0));
    // 绝对判据：整场重力冲量（Σmg·dt）的 1%。用于"整体几乎不动"的场景，
    // 此时相对残差会出现 0/0 假警报，但绝对误差其实小到没有物理意义。
    const weight = scene.bodies.filter(b => b.type === 'dynamic').reduce((s, b) => s + (b.mass || 0) * scene.meta.g, 0);
    const absTol = 0.01 * weight * scene.meta.dt;
    const rows = verifyLib.run(model, params, frames, scene);
    const bad = rows.filter(r => !r.pass);
    const residualOk = resMax <= RESIDUAL_TOL || absMax <= absTol;
    checks += rows.length + 1;
    if (residualOk && !bad.length) {
      console.log('ok    ' + label + '  残差 ' + (resMax * 100).toFixed(3) + '%' +
        (resMax > RESIDUAL_TOL ? '（绝对 ' + absMax.toFixed(4) + ' N·s 在容差内）' : '') +
        '  对照 ' + rows.length + ' 项全过');
      if (verbose) rows.forEach(r => console.log('        · ' + r.label + ': 解析 ' + r.theory.toFixed(4) +
        ' / 仿真 ' + (r.sim == null ? '—' : r.sim.toFixed(4)) + ' (' + (r.relError == null ? '—' : (r.relError * 100).toFixed(3) + '%') + ')'));
    } else {
      failures++;
      failuresList.push(label);
      console.log('FAIL  ' + label + (residualOk ? '' : '  残差 ' + (resMax * 100).toFixed(3) + '% 超限'));
      bad.forEach(r => console.log('        × ' + r.label + ': 解析 ' + (r.theory == null ? '—' : r.theory.toFixed(4)) +
        ' / 仿真 ' + (r.sim == null ? '—' : r.sim.toFixed(4)) +
        ' (' + (r.relError == null ? '无法测量' : (r.absolute ? '绝对 ' + r.relError.toFixed(4) : (r.relError * 100).toFixed(3) + '%')) + ')'));
    }
  });
});

console.log('');
console.log('用例 ' + cases + ' 个，检查项 ' + checks + ' 项，失败 ' + failures + ' 项');
if (failures) {
  console.log('失败用例：');
  failuresList.forEach(f => console.log('  - ' + f));
}
process.exit(failures ? 1 : 0);
