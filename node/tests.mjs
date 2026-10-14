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
const trackLib = require(path.join(ROOT, 'lib/track.js'));
const forcesLib = require(path.join(ROOT, 'lib/forces.js'));

const args = process.argv.slice(2);
const verbose = args.includes('--verbose');
const only = (() => {
  const i = args.indexOf('--only');
  return i >= 0 && args[i + 1] ? args[i + 1].split(',') : null;
})();

const CASES = {
  // 电磁学组：匀强电场（加速 / 偏转）
  // 半圆槽 + A 处固定点电荷（本题）：默认 κ≈2.4；再给两组"改 q / 改 R"的参数验证解析式随参数走
  semicircleCoulomb: [
    {},
    { q: 2.0 },                       // 减小 q ⇒ κ 变小 ⇒ M 更靠近 A
    { R: 0.8, mass: 0.8 }             // 换尺度
  ],
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
  ],
  // ---- 组合模组：斜面 → 竖直圆轨道内壁 → 匀强电场（lib/models/track.js）----
  // 解析基线已推广到一般倾角：v_B² = v0² − 2gR(1+secα)、v_crit² = v0² − 4gR·secα、
  // v_min² = 5gR·secα（α=37° 时退化为题面给的 4.5 / 5 / 6.25 gR）。
  trackSlopeLoopE: [
    {},                                  // 默认 v0=10 > v_min：斜面切向加速度 0 → 过临界点 → 过 B
    { v0: 7.0 },                         // v0 < v_min：脱离 → 按题意停止（末帧速度 0）
    { v0: 0 },                           // 静止在斜面上（平衡场强把球"托住"）
    { v0: 7.95 },                        // 刚过 v_min = √(6.261gR) = 7.912：贴壁裕度很小
    { R: 0.8, v0: 12 },                  // 换半径
    { mass: 0.2, q: 2, v0: 12 },         // 电荷/质量同比放大（E 自动跟着变，轨迹应当不变）
    { Efac: 1.3 },                       // 非平衡场强：只校能量守恒（其余解析式不再适用）
    { theta: 30, v0: 10 },               // 缓角：v_min=√(5·10·1.1547)=7.598，裕度 1.32×
    { theta: 45, v0: 11 },               // v_min=√(5·10·1.4142)=8.409
    { theta: 53, v0: 12 }                // 陡角：v_min=√(5·10·1.6616)=9.115，斜面段只剩 ~0.17 s
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
        ' / 仿真 ' + (r.sim == null ? '—' : r.sim.toFixed(4)) + ' (' +
        // 按绝对容差判定的项要标"绝对"，否则会把绝对差当成百分比印出来（看着像 6% 的误差）
        (r.relError == null ? '—' : (r.absolute ? '绝对 ' + r.relError.toFixed(4) + '，容差 ' + r.tolerance
          : (r.relError * 100).toFixed(3) + '%')) + ')'));
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

// ================================================================ 组件级单元测试
// 目标：把"力律"本身的约定钉死，**不依赖任何具体模型**。
// 每个检查都直接对应 references/force-library.md 里的三条约定：
//   ① potential 只含额外项（重力不许再记 mgy）  ② 接触法向指向曲率中心且 N<0 必须报错
//   ③ 力表按 part 记账（分项名必须在引擎 PARTS 里、分项和 = total）
const F = forcesLib;
const comp = { cases: 0, checks: 0, fails: 0, list: [] };
function chk(label, got, want, tol, note) {
  comp.checks++;
  const t = tol == null ? 1e-9 : tol;
  const ok = Math.abs(got - want) <= t;
  if (!ok) { comp.fails++; comp.list.push(label); }
  console.log((ok ? 'ok    ' : 'FAIL  ') + '[forces] ' + label +
    '  期望 ' + want.toPrecision(6) + ' / 实得 ' + (typeof got === 'number' ? got.toPrecision(6) : got) +
    (note ? '  （' + note + '）' : ''));
  return ok;
}
function ok(label, cond, note) {
  comp.checks++;
  if (!cond) { comp.fails++; comp.list.push(label); }
  console.log((cond ? 'ok    ' : 'FAIL  ') + '[forces] ' + label + (note ? '  （' + note + '）' : ''));
  return cond;
}
const st1 = (x, y, vx, vy) => ({ ball: { x: x, y: y, vx: vx || 0, vy: vy || 0 } });
const ctxOf = (S) => ({ t: 0, S: S, body: 'ball', lock: null });

comp.cases++;
// ---- 1. 重力：力分量正确，且 potential **必须是 0**（引擎已含 mgy） ----
{
  const g = F.gravity({ body: 'ball', m: 0.4, g: 10 });
  const f = g.force(ctxOf(st1(3, 7)));
  chk('重力 F = [0,−mg]（m=0.4,g=10）', f[0], 0);
  chk('重力 Fy = −mg', f[1], -4, 1e-12);
  chk('重力 potential ≡ 0（⚠ 引擎 verlet 已自己加 mgy，再返回 mgy 就是记两遍）',
    g.potential(ctxOf(st1(3, 7))), 0, 1e-12);
  chk('重力 potential 与位置无关（y=7 与 y=700 都返回 0）',
    g.potential(ctxOf(st1(3, 700))) - g.potential(ctxOf(st1(3, 7))), 0, 1e-12);
}
// ---- 2. 匀强电场：F=qE；potential=−qE·r；数值求导 −∇U 必须等于 F（力/势能成对） ----
{
  const q = 2e-3, E = [1.5e3, -400];
  const e = F.uniformElectric({ body: 'ball', q: q, E: E });
  const S = st1(0.7, 1.3);
  const f = e.force(ctxOf(S));
  chk('电场 Fx = qEx', f[0], q * E[0], 1e-12);
  chk('电场 Fy = qEy', f[1], q * E[1], 1e-12);
  const U = (x, y) => e.potential(ctxOf(st1(x, y)));
  const h = 1e-6;
  const gx = -(U(0.7 + h, 1.3) - U(0.7 - h, 1.3)) / (2 * h);
  const gy = -(U(0.7, 1.3 + h) - U(0.7, 1.3 - h)) / (2 * h);
  chk('电场 −∂U/∂x = qEx（数值求导）', gx, f[0], Math.abs(f[0]) * 1e-6);
  chk('电场 −∂U/∂y = qEy（数值求导）', gy, f[1], Math.max(1e-9, Math.abs(f[1]) * 1e-6));
  const pair = F.assertPairing([e], [st1(0.7, 1.3), st1(-2, 0.4)], { tol: 1e-6 });
  ok('assertPairing：电场力/势能成对（−∇U=F）', pair.ok, '最大相对偏差 ' + pair.rows[0].rel.toExponential(2));
}
// ---- 3. 电场分区：区域边界判定（含边界点），并给出分段势能 ----
{
  const e = F.uniformElectric({ body: 'ball', q: 1, E: [100, 0],
    regions: [{ x0: 0, x1: 1, y0: -1, y1: 1 }] });
  chk('区域内 Fx = qE', e.force(ctxOf(st1(0.5, 0)))[0], 100, 1e-12);
  chk('区域外 Fx = 0', e.force(ctxOf(st1(1.5, 0)))[0], 0, 1e-12);
  chk('边界点 x=x1 视为区域**内**（含边界判据）', e.force(ctxOf(st1(1.0, 0)))[0], 100, 1e-12);
  chk('边界点 y=y0 视为区域内', e.force(ctxOf(st1(0.5, -1)))[0], 100, 1e-12);
  chk('区域外 potential = 0（跨边界势能可不连续：只在段内守恒）',
    e.potential(ctxOf(st1(1.5, 0))), 0, 1e-12);
  chk('区域内 potential = −qE·r', e.potential(ctxOf(st1(0.5, 0))), -100 * 0.5, 1e-12);
  const pair = F.assertPairing([e], [st1(0.2, 0.3), st1(0.9, -0.4)], { tol: 1e-6 });
  ok('assertPairing：分区电场在**段内**力/势能成对', pair.ok,
    '最大相对偏差 ' + pair.rows[0].rel.toExponential(2));
}
// ---- 4. 曲线上接触：N = m·v²κ − F_其它·n̂ 的**手算值**（不许用容差蒙混） ----
{
  // 直线段路径：从 (0,0) 到 (1,0)，side=+1 ⇒ t̂=(1,0)、n̂=(0,1)（球压在线的上侧）
  const line = trackLib.makePath({ segments: [{ kind: 'line', a: [0, 0], b: [1, 0], side: 1 }] });
  const geometry = (ctx) => {
    const b = ctx.S.ball, s = Math.max(0, Math.min(1, b.x));
    return { s: s, p: line.pointAt(s), t: line.tangentAt(s), n: line.normalAt(s),
             k: line.kappaAt(s), mu: line.muAt(s) };
  };
  const m = 0.5, g = 10, q = 1e-3, Ex = 200;             // 电场水平，沿切向（无法向分量）
  const elec = F.uniformElectric({ body: 'ball', q: q, E: [Ex, 0] });
  const n = F.curveNormal({ body: 'ball', m: m, g: g, geometry: geometry, electric: elec.force });
  const f0 = n.force(ctxOf(st1(0.5, 0, 0, 0)));
  chk('直线段 κ=0、静止、无横向外力 ⇒ N = mg（手算 5 N）', Math.hypot(f0[0], f0[1]), m * g, 1e-12);
  chk('法向方向 = n̂ = (0,1)（直线段由 side 决定）', f0[1], m * g, 1e-12);
  chk('切向的电场力不进入 N（n̂·Ê=0）', f0[0], 0, 1e-12);
  // 圆弧段：**取 g=0、q=0** 把"纯净的 N = m·v²κ"钉死（重力/电场的分量会引入浮点残差）。
  // 圆心 (0.5,0)、R=0.5（κ=2，直线段是 0）；球在面内角 θ₀=atan2(4,3)=53.13° 处，
  // n̂=(−cosθ₀,−sinθ₀)=−(0.6,0.8)、t̂=(−0.8,0.6)。取 v=3 m/s 纯切向、v_t²=9：
  //   N = m·v²·κ − F_其它·n̂ = 2·9·2 − 0 = 36 N（手算，精确）
  const arc = trackLib.makePath({ segments: [{ kind: 'arc', c: [0.5, 0], r: 0.5, a0: 0, a1: Math.PI }] });
  const th0 = Math.atan2(4, 3);
  const P0 = arc.pointAt(0.5 * th0);
  const geomArc = (ctx) => {
    const b = ctx.S.ball;
    const s = Math.max(0, Math.min(arc.total, 0.5 * Math.atan2(b.y, b.x - 0.5)));
    return { s: s, p: arc.pointAt(s), t: arc.tangentAt(s), n: arc.normalAt(s), k: arc.kappaAt(s), mu: 0 };
  };
  const na = F.curveNormal({ body: 'ball', m: 2, g: 0, geometry: geomArc, electric: elec.force });
  // 本段单独用**中性电场**（q=0），免得电场的法向分量混进手算值
  const naPure = F.curveNormal({ body: 'ball', m: 2, g: 0, geometry: geomArc,
    electric: F.uniformElectric({ body: 'ball', q: 0, E: [200, 0] }).force });
  const Sarc = st1(P0[0], P0[1], -0.8 * 3, 0.6 * 3);
  const fArc = naPure.force(ctxOf(Sarc));
  chk('圆弧段 N = m·v²·κ（g=0、q=0，手算 36 N，精确）', Math.hypot(fArc[0], fArc[1]), 36, 1e-12);
  chk('法向力方向 = n̂ = (−0.6,−0.8)（指向曲率中心，内壁）',
    fArc[0] / Math.hypot(fArc[0], fArc[1]), -0.6, 1e-12);
  // 同一子步法向力必须与"投影里用的 N"同源（project 用 normalForce 回代，两边不许各算一份）
  chk('normalForce() 回代值与 force() 的 |F| 一致', naPure.normalForce(ctxOf(Sarc)),
    Math.hypot(fArc[0], fArc[1]), 1e-12);
  // 电场的法向分量必须进 N（不能只算 m·v²κ）：n̂·qE = (−0.6)(0.2) ⇒ N = 36 − (−0.12) = 36.12
  chk('N 里含 F_其它·n̂ 项（n̂·qE = −0.12 N ⇒ N = 36.12）',
    Math.hypot(na.force(ctxOf(Sarc))[0], na.force(ctxOf(Sarc))[1]), 36.12, 1e-9);
}
// ---- 5. N<0 的符号约定：必须**抛错**（默认）或走 onNeg，禁止静默跳过 ----
{
  const line = trackLib.makePath({ segments: [{ kind: 'line', a: [0, 0], b: [1, 0], side: 1 }] });
  const geometry = (ctx) => {
    const s = Math.max(0, Math.min(1, ctx.S.ball.x));
    return { s: s, p: line.pointAt(s), t: line.tangentAt(s), n: line.normalAt(s), k: line.kappaAt(s), mu: 0 };
  };
  // 直线段上 N = −F_其它·n̂ = mg − qEy：取 qEy > mg ⇒ N<0（球被电场往上推离轨道）
  const elec = F.uniformElectric({ body: 'ball', q: 1, E: [0, 20] });
  const n = F.curveNormal({ body: 'ball', m: 0.5, g: 10, geometry: geometry, electric: elec.force });
  let threw = null;
  try { n.force(ctxOf(st1(0.5, 0, 0, 0))); } catch (e) { threw = e; }
  ok('N<0 且没有 onNeg ⇒ 抛错（默认行为，专治"静默跳过"）', !!threw,
    threw ? threw.message.slice(0, 46) + '…' : '竟然没抛错');
  let got = null;
  const n2 = F.curveNormal({ body: 'ball', m: 0.5, g: 10, geometry: geometry, electric: elec.force,
    onNeg: (info) => { got = info; return [0, 0]; } });
  const f2 = n2.force(ctxOf(st1(0.5, 0, 0, 0)));
  ok('给了 onNeg ⇒ 不抛错、返回 0 力，并把诊断交出来', f2[0] === 0 && f2[1] === 0 && !!got,
    got ? 'N=' + got.N.toFixed(4) + ' N, s=' + got.s.toFixed(4) + ' m' : '');
  chk('onNeg 收到的 N 与解析式一致（m=0.5,g=10,qEy=20 ⇒ N=5−20=−15）', got ? got.N : NaN, -15, 1e-12);
}
// ---- 6. 摩擦：动摩擦方向 + 静摩擦"咬住"判据（belt 缺的那条分支） ----
{
  const line = trackLib.makePath({ segments: [{ kind: 'line', a: [0, 0], b: [1, 0], side: 1, mu: 0.5 }] });
  const geometry = (ctx) => {
    const s = Math.max(0, Math.min(1, ctx.S.ball.x));
    return { s: s, p: line.pointAt(s), t: line.tangentAt(s), n: line.normalAt(s), k: 0, mu: 0.5 };
  };
  const m = 1, g = 10, mu = 0.5;
  const elec = F.uniformElectric({ body: 'ball', q: 1, E: [0, 0] });
  const normal = F.curveNormal({ body: 'ball', m: m, g: g, geometry: geometry, electric: elec.force });
  const fr = F.kineticFriction({ body: 'ball', m: m, g: g, mu: mu, geometry: geometry,
    electric: elec.force, surfaceNormal: (ctx) => normal.normalForce(ctx) });
  const fSlide = fr.force(ctxOf(st1(0.5, 0, 1, 0)));
  chk('动摩擦大小 = μN = 0.5·10 = 5 N', Math.hypot(fSlide[0], fSlide[1]), mu * m * g, 1e-9);
  chk('动摩擦方向与 v 相反（v 沿 +x ⇒ f 沿 −x）', fSlide[0], -mu * m * g, 1e-9);
  const s0 = fr.state(ctxOf(st1(0.5, 0, 0, 0)));
  ok('近静止且 F_t=0 ≤ μN ⇒ 静摩擦咬住（stick）', s0.stick === true && s0.f === 0);
  // 静摩擦咬住的第二种情形：v0 = 带速（相对速度 0）但外力 |F_t| ≤ μN ⇒ 必须咬住而不是乱给 μN
  const elecPush = F.uniformElectric({ body: 'ball', q: 1, E: [3, 0] });   // F_t = −3 N，|F_t| < 5 N
  const fr2 = F.kineticFriction({ body: 'ball', m: m, g: g, mu: mu, geometry: geometry,
    electric: elecPush.force, surfaceNormal: (ctx) => normal.normalForce(ctx) });
  const s1x = fr2.state(ctxOf(st1(0.5, 0, 0, 0)));
  ok('v=0（与带共速）且 |F_t|=3 N ≤ μN=5 N ⇒ 咬住，f = −F_t = +3 N',
    s1x.stick === true && Math.abs(Math.abs(s1x.f) - 3) < 1e-9,
    'f=' + s1x.f.toFixed(4) + ' N, stick=' + s1x.stick);
  const elecBig = F.uniformElectric({ body: 'ball', q: 1, E: [8, 0] });    // F_t = −8 N > μN
  const fr3 = F.kineticFriction({ body: 'ball', m: m, g: g, mu: mu, geometry: geometry,
    electric: elecBig.force, surfaceNormal: (ctx) => normal.normalForce(ctx) });
  const s2x = fr3.state(ctxOf(st1(0.5, 0, 0, 0)));
  ok('|F_t|=8 N > μN=5 N ⇒ 不咬住，转为动摩擦 |f| = μN = 5 N',
    s2x.stick === false && Math.abs(Math.abs(s2x.f) - 5) < 1e-9, 'f=' + s2x.f.toFixed(4) + ' N');
  const st = F.staticFriction({ body: 'ball', m: m, g: g, mu: mu, geometry: geometry,
    electric: elecPush.force, surfaceNormal: (ctx) => normal.normalForce(ctx) });
  const fs = st.force(ctxOf(st1(0.5, 0, 0, 0)));
  // 注意 n̂=(0,1) ⇒ t̂=(−1,0)，所以"大小 3 N、方向与电场力相反"在 x 分量上表现为 −3
  ok('staticFriction 组件在咬住时给出 |f| = |F_t| = 3 N（t̂=−x ⇒ fx=−3）',
    Math.abs(fs[0]) === 3 && Math.abs(fs[1]) < 1e-12, 'f=(' + fs[0] + ',' + fs[1] + ') N');
}
// ---- 7. 弹簧 / 阻力：力与势能成对 ----
{
  const sp = F.spring({ body: 'ball', k: 40, anchor: [0, 0], rest: 0.5 });
  const S = st1(1.0, 0, 0, 0);
  const f = sp.force(ctxOf(S));
  chk('弹簧 F = −k(L−rest)·r̂（L=1, k=40, rest=0.5 ⇒ −20 N）', f[0], -20, 1e-9);
  chk('弹簧势能 ½k(L−rest)²（=5 J）', sp.potential(ctxOf(S)), 5, 1e-12);
  const pr = F.assertPairing([sp], [st1(1.0, 0.3), st1(-0.4, 0.9)], { tol: 1e-5 });
  ok('assertPairing：弹簧力/势能成对', pr.ok, '最大相对偏差 ' + pr.rows[0].rel.toExponential(2));
  const d = F.drag({ body: 'ball', c: 2 });
  const fd = d.force(ctxOf(st1(0, 0, 3, -1)));
  chk('阻力 F = −c·v（c=2, v=(3,−1) ⇒ (−6,2)）', fd[0] * 100 + fd[1], -598, 1e-9);
  chk('阻力不产生势能（耗散力）', d.potential(ctxOf(st1(0, 0, 3, -1))), 0, 1e-12);
}
// ---- 8. 分项名与力表记账（force 的返回值必须落在 verlet.PARTS 里） ----
{
  const okParts = F.PARTS.join(',');
  ok('组件库 PARTS 与引擎 verlet.PARTS 一致', okParts === require(path.join(ROOT, 'lib/verlet.js')).PARTS.join(','),
    okParts);
  let bombed = null;
  try { F.composeForces([{ id: 'x', part: 'magnet', force: () => [1, 0], potential: () => 0 }]); }
  catch (e) { bombed = e; }
  ok('未知分项名必须在组合时就报错（否则力表看得见、引擎 accelOf 却丢掉）', !!bombed);
  let bombed2 = null;
  try { F.composeForces([{ id: 'y', part: 'gravity', force: () => [1, 0] }]); }
  catch (e) { bombed2 = e; }
  ok('组件缺 potential 必须在组合时就报错（力/势能强制成对）', !!bombed2);
  const gr = F.gravity({ body: 'ball', m: 1, g: 10 });
  const el = F.uniformElectric({ body: 'ball', q: 0.1, E: [100, 0] });
  const c = F.composeForces([gr, el]);
  const det = c.forceDetail(0, st1(0, 0))['ball'];
  ok('力表分项和 = total（力表按 part 记账）', F.auditForceTable(det, st1(0, 0)).length === 0,
    'ΣF=' + JSON.stringify(det.total) + ' parts=' + JSON.stringify(det.parts));
  chk('组合后 potential = 额外势能之和（重力 0 + 电场 −qEx）',
    c.potential(0, st1(2, 0)), 0 + (-0.1 * 100 * 2), 1e-12);
}
// ---- 9. 能量审计：独立于模型 analytics（对 trackSlopeLoopE 的帧数据直接算 KE+mgy−qEx） ----
{
  const model = models.get('trackSlopeLoopE');
  const params = models.defaults(model);
  const scene = models.scene('trackSlopeLoopE', params, sceneLib);
  const frames = simLib.createSim(planck, scene).record().frames;
  const m = params.mass, q = params.q * 1e-3, Ex = scene.laws.components.electric.E[0];
  const audit = F.energyAudit(frames, {
    body: 'ball', g: params.g,
    // 独立势能：只写电场势能 −qE·x；重力势能由审计自己用 mgy 加（与引擎 stats.potential 同口径）
    potential: (S) => -q * Ex * S.ball.x
  });
  // 手算（帧 0）：½mv₀² + mgy₀ − qE·x₀ —— 起点 A 与 B 等高、(1) 的平衡关系 qE·x_A = mgy_A
  // ⇒ KE₀ + mgy_A − qE·x_A = KE₀ = 2.45 J（这正是"势能不该记两遍"的数值体现）
  const hand = 0.5 * m * params.v0 * params.v0;
  chk('energyAudit 的初能量 = KE₀ + mgy₀ − qEx₀（手算 2.45 J，含平衡场强 mgy_A=qE·x_A）',
    audit.E0, hand, 1e-9, 'qE·x_A=' + (q * Ex * 2.3868699395908446).toPrecision(6) +
    ' J 与 mg·y_A=' + (m * params.g * 1.7986355100472926).toPrecision(6) + ' J 相等');
  chk('energyAudit 与引擎 stats.mechanical 相互独立且一致（初值 5.000000 J）',
    audit.E0 - frames[0].stats.mechanical, 0, 1e-9);
  ok('energyAudit 报出的漂移量级与引擎 mechanical 一致（|ΔE| < 1e−4 J）',
    Math.abs(audit.dE_last) < 1e-4, 'dE_last=' + audit.dE_last.toExponential(3) +
    ' J，相对 ' + (audit.rel_worst * 100).toExponential(3) + '%');
}
console.log('');
console.log('[forces] 单元测试：' + comp.checks + ' 项检查，失败 ' + comp.fails + ' 项');
comp.list.forEach(f => console.log('  - ' + f));
failures += comp.fails;
cases += comp.cases;

// ---- 10. 库仑力组件：−∇U=F、斥力/引力符号、1/r² 标度、多电荷叠加、r→0 抛错、分项名 ----
{
  const K = 8.9875517923e9;
  const KAPPA_U = 8.9875517923e9;
  const kk = KAPPA_U;
  // ① 单电荷斥力数值
  const q = 2e-6, Q = 3e-6;
  const c1 = F.coulomb({ body: 'ball', q: q, charges: [{ x: 0, y: 0, Q: Q }] });
  const S = st1(0.3, 0.4);                       // r = 0.5
  const f = c1.force(ctxOf(S));
  chk('库仑斥力 |F| = kQq/r²（r=0.5, q=2μC, Q=3μC ⇒ 0.2157 N）',
    Math.hypot(f[0], f[1]), kk * q * Q / 0.25, 1e-12);
  chk('库仑斥力方向沿 r̂ = (0.6,0.8)（正电荷 ⇒ 斥力，背离点电荷）', f[0] / Math.hypot(f[0], f[1]), 0.6, 1e-12);
  chk('库仑势能 U = kQq/r（0.1079 J）', c1.potential(ctxOf(S)), kk * q * Q / 0.5, 1e-12);
  // ② 引力（Q<0）：符号反转、大小相同
  const c2 = F.coulomb({ body: 'ball', q: q, charges: [{ x: 0, y: 0, Q: -Q }] });
  const f2 = c2.force(ctxOf(S));
  chk('Q<0 ⇒ 引力，方向与斥力相反', f2[0] + f[0], 0, 1e-12);
  chk('Q<0 ⇒ 势能变负（吸引）', c2.potential(ctxOf(S)), -kk * q * Q / 0.5, 1e-12);
  // ③ 1/r² 标度：r 加倍 ⇒ 力降到 1/4
  const S2 = st1(0.6, 0.8);
  chk('1/r² 标度：r 加倍 ⇒ |F| → 1/4', Math.hypot.apply(null, c1.force(ctxOf(S2))),
    Math.hypot(f[0], f[1]) / 4, 1e-15);
  // ④ 多电荷叠加（线性）
  const c3 = F.coulomb({ body: 'ball', q: q, charges: [{ x: 0, y: 0, Q: Q }, { x: 1, y: 0, Q: -Q }] });
  const fA = c1.force(ctxOf(S));
  const c4 = F.coulomb({ body: 'ball', q: q, charges: [{ x: 1, y: 0, Q: -Q }] });
  const fB = c4.force(ctxOf(S));
  const f3 = c3.force(ctxOf(S));
  chk('多电荷叠加：F = ΣFᵢ（x 分量）', f3[0], fA[0] + fB[0], 1e-12);
  chk('多电荷叠加：U = ΣUᵢ', c3.potential(ctxOf(S)),
    c1.potential(ctxOf(S)) + c4.potential(ctxOf(S)), 1e-12);
  // ⑤ r→0：必须抛错并打印状态（不许静默 NaN/Infinity）
  let threw = null;
  try { c1.force(ctxOf(st1(0, 0))); } catch (e) { threw = e; }
  ok('r→0（球与点电荷重合）必须抛错并打印状态，禁止静默 NaN/Infinity', !!threw,
    threw ? threw.message.slice(0, 58) + '…' : '竟然没抛错');
  let threwP = null;
  try { c1.potential(ctxOf(st1(1e-12, 0))); } catch (e) { threwP = e; }
  ok('potential 在 r≤rMin 时同样抛错（力/势能同一判据）', !!threwP);
  let threwEmpty = null;
  try { F.coulomb({ body: 'ball', q: q, charges: [] }); } catch (e) { threwEmpty = e; }
  ok('charges 为空 ⇒ 组合时直接抛错（不静默返回 0 力）', !!threwEmpty);
  // ⑥ 分项名与力表记账：库仑力记在 electric，且 Σ分项 = total
  ok('coulomb 的分项名 = electric（库仑力记在 electric 分项）', c1.part === 'electric', c1.part);
  const comp2 = F.composeForces([F.gravity({ body: 'ball', m: 0.5, g: 10 }), c1]);
  const det = comp2.forceDetail(0, st1(0.3, 0.4))['ball'];
  ok('力表分项 = gravity + electric（Σ分项 = total）',
    F.auditForceTable(det, st1(0.3, 0.4)).length === 0,
    'parts=' + Object.keys(det.parts).join('+') + ' total=' + JSON.stringify(det.total));
  chk('组合后 potential 只含库仑项（重力组件恒返回 0）',
    comp2.potential(0, st1(0.3, 0.4)), kk * q * Q / 0.5, 1e-12);
  // ⑦ −∇U = F（中心差分，独立于解析求导）
  const pair = F.assertPairing([c1], [st1(0.3, 0.4), st1(-0.7, 0.25), st1(0.05, -0.9)], { tol: 1e-6 });
  ok('assertPairing：库仑力/势能成对（−∇U = F，中心差分）', pair.ok,
    '最大相对偏差 ' + pair.rows[0].rel.toExponential(2));
}
// ---- 11. semicircleCoulomb：四项判定的数值证据（D 组） ----
{
  const model = models.get('semicircleCoulomb');
  const params = models.defaults(model);
  const scene = models.scene('semicircleCoulomb', params, sceneLib);
  const frames = simLib.createSim(planck, scene).record().frames;
  const A = model.build._analytics(params);
  const R = params.R, m = params.mass * 1e-3, g = params.g, kqQ = A.kqQ;
  const ball = frames.map(f => f.bodies.ball);
  const speed = ball.map(b => Math.hypot(b.vx, b.vy));
  const dt = frames[1].t - frames[0].t;
  // (1) 速度最大点在 P 之前：t_N < t_P
  let iN = 0; speed.forEach((v, i) => { if (v > speed[iN]) iN = i; });
  const tN = frames[iN].t, tP = A.tP;
  ok('【A 反证】速度最大帧 t_N < 到达 P 的时刻 t_P', tN < tP,
    't_N=' + tN.toFixed(5) + ' s（θ_N=' + (A.thN * 180 / Math.PI).toFixed(2) + '°）、t_P=' +
    tP.toFixed(5) + ' s（θ_P=−90°）⇒ 速度最大点不在 M–P 之间');
  ok('N 落在 B 与 P 之间（θ_N > −90°）', A.thN > -Math.PI / 2,
    'θ_N=' + (A.thN * 180 / Math.PI).toFixed(4) + '°');
  // (2) B→M 沿弧 40+ 采样：|F合| 单调不减
  const Fnet = (th) => {
    const rx = R * Math.cos(th) + R, ry = R * Math.sin(th), r = Math.hypot(rx, ry);
    return [kqQ * rx / (r * r * r), kqQ * ry / (r * r * r) - m * g];
  };
  const NPT = 40, mags = [], Uels = [];
  for (let i = 0; i <= NPT; i++) {
    const th = -1e-9 + (A.thM + 1e-9) * i / NPT;
    mags.push(Math.hypot.apply(null, Fnet(th)));
    Uels.push(kqQ / A.rOf(th));
  }
  let viol = 0, minF = Infinity, minAt = 0;
  for (let i = 0; i < mags.length; i++) {
    if (mags[i] < minF) { minF = mags[i]; minAt = -1e-9 + (A.thM + 1e-9) * i / NPT; }
    if (i && mags[i] < mags[i - 1] - 1e-12) viol++;
  }
  ok('【B 反证】B→M 沿弧 ' + (NPT + 1) + ' 点 |F合| 单调不减（顺序违例 0）', viol === 0,
    '|F合| min=' + minF.toFixed(6) + ' N @θ=' + (minAt * 180 / Math.PI).toFixed(2) + '°、max=' +
    mags[mags.length - 1].toFixed(6) + ' N、违例 ' + viol + ' 次');
  // (3) B→M 电势能单调增
  let violU = 0;
  for (let i = 1; i < Uels.length; i++) if (Uels[i] < Uels[i - 1] - 1e-15) violU++;
  ok('【C 证据】B→M 电势能 kQq/r 单调增', violU === 0,
    'U 起 ' + Uels[0].toExponential(6) + ' J → 止 ' + Uels[Uels.length - 1].toExponential(6) +
    ' J（违例 ' + violU + ' 次）');
  // (4) P→M：|ΔEk| > ΔEp(电)
  const EkP = 0.5 * m * A.vP * A.vP;
  const dEp = kqQ / A.rOf(A.thM) - kqQ / A.rOf(-Math.PI / 2);
  ok('【D 证据】P→M 动能减少量 |ΔEk| > 电势能增加量 ΔEp(电)', EkP > dEp,
    '|ΔEk|=' + EkP.toExponential(6) + ' J > ΔEp(电)=' + dEp.toExponential(6) + ' J（差 ' +
    (EkP - dEp).toExponential(6) + ' J = 重力势能增加量 ' +
    (m * g * (R * Math.sin(A.thM) + R)).toExponential(6) + ' J）');
  // (5) 左半侧（P→M）切向加速度恒为负
  let maxAt = -Infinity;
  for (let i = 0; i <= 200; i++) {
    const th = -Math.PI / 2 + (A.thM + Math.PI / 2) * i / 200;
    maxAt = Math.max(maxAt, A.aOf(th));
  }
  ok('【A 直接证据】P→M 段切向加速度全部 < 0（200 点采样）', maxAt < 0,
    'max a_t = ' + maxAt.toExponential(4) + ' m/s² < 0');
  // (6) 停点在 A–P 之间（题设几何）+ 全程不脱离
  ok('停点 M 落在 A 与 P 之间的弧上（θ_M < −90°）', A.thM < -Math.PI / 2,
    'θ_M=' + (A.thM * 180 / Math.PI).toFixed(4) + '°、r_M=' + A.rOf(A.thM).toFixed(5) +
    ' m < r_P=' + A.rOf(-Math.PI / 2).toFixed(5) + ' m');
  let Nmin = Infinity;
  for (let i = 0; i <= 400; i++) {
    const th = -1e-9 + (A.thM + 1e-9) * i / 400;
    const vv = A.vOf(th);
    const Fn = Fnet(th);
    Nmin = Math.min(Nmin, m * vv * vv / R - (Fn[0] * -Math.cos(th) + Fn[1] * -Math.sin(th)));
  }
  ok('全程法向力 N > 0（库仑力与重力都压向槽内壁，不脱离）', Nmin > 0,
    'N_min=' + Nmin.toExponential(4) + ' N');
  comp.cases += 0;
  cases += 0;
  checks += 0;
}

console.log('');
console.log('用例 ' + cases + ' 个，检查项 ' + (checks + comp.checks) + ' 项（模型 ' + checks +
  ' + 力组件 ' + comp.checks + '），失败 ' + failures + ' 项');if (failures) {
  console.log('失败用例：');
  failuresList.forEach(f => console.log('  - ' + f));
}
process.exit(failures ? 1 : 0);
