/*!
 * 可行性验证原型 v2：velocity-Verlet + 手动临界判据 复算"板块·拉木板"，
 * 与解析解、planck 对比精度与耗时。
 * 关键对照：临界时刻恰好落在步边界 vs 落在步中间（检验"临界处手动计算"的必要性）。
 * 只为评估用，不参与正式产物。
 */
const path = require('node:path');
const { createRequire } = require('node:module');
const req = createRequire(__filename);
const ROOT = path.resolve(__dirname, '..');
const sceneLib = req(path.join(ROOT, 'lib/scene.js'));
const simLib = req(path.join(ROOT, 'lib/sim.js'));
const models = req(path.join(ROOT, 'lib/models/index.js'));
const planck = req(path.join(ROOT, 'vendor/planck.min.js'));

const BASE = { m: 2, M: 3, mu1: 0.3, mu2: 0.1, g: 10, F: 26, tF: 2, T: 4, dt: 1 / 60 };
const EPS = 1e-9;

/**
 * 单个子步的加速度。核心难点不在积分，而在这里：
 * "这一步到底是相对滑动还是相对静止？地面摩擦是静摩擦还是滑动摩擦？"
 */
function accel(P, t, vb, vk) {
  const Fa = t < P.tF ? -P.F : 0;                       // 外力（向左为负）
  const f1max = P.mu1 * P.m * P.g;                      // 板-块最大摩擦
  const f2max = P.mu2 * (P.m + P.M) * P.g;              // 板-地最大摩擦
  const vrel = vk - vb;

  if (Math.abs(vrel) > EPS) {                           // ---- 相对滑动 ----
    const fBlock = -Math.sign(vrel) * f1max;            // 物块受的摩擦：反对相对运动
    const fBoard = -fBlock;                             // 反作用
    const fg = Math.abs(vb) > EPS ? -Math.sign(vb) * f2max : -Math.sign(Fa + fBoard) * f2max;
    return { ab: (Fa + fBoard + fg) / P.M, ak: fBlock / P.m };
  }

  // ---- 相对静止：先看地面，再看板间静摩擦够不够 ----
  let fg;
  if (Math.abs(vb) > EPS) fg = -Math.sign(vb) * f2max;
  else if (Math.abs(Fa) <= f2max) fg = -Fa;             // 静止且外力推不动 → 静摩擦平衡
  else fg = -Math.sign(Fa) * f2max;
  const aCom = (Fa + fg) / (P.m + P.M);
  const fNeed = P.m * aCom;                             // 要一起走，物块需要这么大摩擦
  if (Math.abs(fNeed) <= f1max + 1e-12) return { ab: aCom, ak: aCom };

  const fBlock = Math.sign(aCom) * f1max;               // 不够 → 物块落后，按满摩擦滑
  return { ab: (Fa - fBlock + fg) / P.M, ak: fBlock / P.m };
}

/** velocity-Verlet。event=true 时对"相对速度过零"做步内切分（即临界处手动计算） */
function run(P, event) {
  let xb = 0, vb = 0, xk = 0, vk = 0, t = 0;
  const n = Math.round(P.T / P.dt), hist = [];
  let maxRel = 0;
  for (let i = 0; i < n; i++) {
    const a1 = accel(P, t, vb, vk);
    let nxb = xb + vb * P.dt + 0.5 * a1.ab * P.dt * P.dt;
    let nxk = xk + vk * P.dt + 0.5 * a1.ak * P.dt * P.dt;
    const vb0 = vb + a1.ab * P.dt, vk0 = vk + a1.ak * P.dt;
    const a2 = accel(P, t + P.dt, vb0, vk0);
    let nvb = vb + 0.5 * (a1.ab + a2.ab) * P.dt;
    let nvk = vk + 0.5 * (a1.ak + a2.ak) * P.dt;
    if (event) {
      const r0 = vk - vb, r1 = nvk - nvb;
      if (r0 * r1 < 0) {                                // 这一步跨过了相对速度零点
        const frac = r0 / (r0 - r1);
        const vcom = vb + (nvb - vb) * frac;
        const xbAt = xb + (nxb - xb) * frac, xkAt = xk + (nxk - xk) * frac;
        const rem = P.dt * (1 - frac);
        const a3 = accel(P, t + P.dt * frac, vcom, vcom);
        nxb = xbAt + vb * rem + 0.5 * a3.ab * rem * rem * 0;   // 位置已推进，只需速度归并
        nxk = xkAt + vk * rem + 0.5 * a3.ak * rem * rem * 0;
        nvb = vcom + a3.ab * rem; nvk = vcom + a3.ak * rem;
        nxb = xbAt + vcom * rem; nxk = xkAt + vcom * rem;      // 之后一起运动
      }
    }
    xb = nxb; vb = nvb; xk = nxk; vk = nvk; t += P.dt;
    const rel = xk - xb;
    if (Math.abs(rel) > maxRel) maxRel = Math.abs(rel);
    hist.push({ t: t, rel: rel, vb: vb, vk: vk });
  }
  return { vb: vb, vk: vk, hist: hist, maxRel: maxRel };
}

function analytic(P) {
  const f1 = P.mu1 * P.m * P.g, f2 = P.mu2 * (P.m + P.M) * P.g;
  const a1 = P.mu1 * P.g;
  const a2 = (P.F - f1 - f2) / P.M;
  const dx = 0.5 * (a2 - a1) * P.tF * P.tF;
  const v1 = a1 * P.tF, v2 = a2 * P.tF;
  const ab2 = (f1 + f2) / P.M, ak2 = P.mu1 * P.g;
  const arel = ab2 + ak2;
  const close = (v2 - v1) / arel;
  const extra = (v2 - v1) * (v2 - v1) / (2 * arel);
  return { dx: dx, L: dx + extra, v1: v1, v2: v2, tStop: P.tF + close };
}

function measure(P, ev, rounds) {
  const t0 = process.hrtime.bigint();
  let r;
  for (let k = 0; k < rounds; k++) r = run(P, ev);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6 / rounds;
  return { r: r, ms: ms };
}

function report(tag, P) {
  const A = analytic(P);
  const n = Math.round(P.T / P.dt);
  const at2 = Math.round(P.tF / P.dt) - 1;
  const raw = measure(P, false, 300);
  const ev = measure(P, true, 300);
  const e = v => Math.abs(v).toFixed(4);
  console.log(tag);
  console.log('  解析解            Δx(2s)=' + A.dx.toFixed(4) + '  L_min=' + A.L.toFixed(4) +
    '  共速时刻=' + A.tStop.toFixed(4) + 's' +
    '  (共速点' + (Math.abs(A.tStop * 60 - Math.round(A.tStop * 60)) < 1e-9 ? '正好在步边界)' : '落在步中间)'));
  console.log('  Verlet 按步判据    Δx=' + e(raw.r.hist[at2].rel) + ' m (' +
    (Math.abs(Math.abs(raw.r.hist[at2].rel) - A.dx) / A.dx * 100).toFixed(3) + '%)  L_min=' +
    raw.r.maxRel.toFixed(4) + ' m (' + (Math.abs(raw.r.maxRel - A.L) / A.L * 100).toFixed(3) +
    '%)  全程 ' + raw.ms.toFixed(3) + ' ms');
  console.log('  Verlet 临界步内切分 Δx=' + e(ev.r.hist[at2].rel) + ' m (' +
    (Math.abs(Math.abs(ev.r.hist[at2].rel) - A.dx) / A.dx * 100).toFixed(3) + '%)  L_min=' +
    ev.r.maxRel.toFixed(4) + ' m (' + (Math.abs(ev.r.maxRel - A.L) / A.L * 100).toFixed(3) +
    '%)  全程 ' + ev.ms.toFixed(3) + ' ms');
  return { A: A, raw: raw, ev: ev };
}

console.log('=== Verlet 原型 vs 解析解（耗时 = 单次 4 秒全过程的纯积分时间） ===\n');
report('【A】μ₁=0.30（本题：共速时刻 2.6000 s = 第 156 步，正好落在步边界）', BASE);

const P2 = { ...BASE, mu1: 0.31 };
report('\n【B】μ₁=0.31（只是把摩擦因数挪动一点，共速时刻就不再落在步边界）', P2);

// planck 对照（本题参数）
const scene = models.scene('plankPush', { ...models.defaults(models.get('plankPush')), duration: 4 }, sceneLib);
let msP = 1e9;
for (let k = 0; k < 3; k++) {
  const t0 = process.hrtime.bigint();
  simLib.createSim(planck, scene).record();
  msP = Math.min(msP, Number(process.hrtime.bigint() - t0) / 1e6);
}
console.log('\n【对照】planck 同一模型同一时长：最快一次 ' + msP.toFixed(1) + ' ms（含建世界、接触检测、求解、逐帧记录）');
console.log('        Verlet 纯积分 ' + measure(BASE, true, 300).ms.toFixed(3) + ' ms  →  约 ' +
  (msP / measure(BASE, true, 300).ms).toFixed(0) + ' 倍');

console.log('\n=== 步长收敛性：L_min 误差随 dt 如何下降（本题 μ₁=0.30） ===');
console.log('dt'.padStart(10) + '步数'.padStart(8) + '  Δx误差'.padStart(11) + '  L_min误差'.padStart(12) + '  耗时'.padStart(11));
[60, 120, 240, 480, 960].forEach(div => {
  const P3 = { ...BASE, dt: 1 / div };
  const A = analytic(P3);
  const m = measure(P3, false, 200);
  const at = Math.round(P3.tF / P3.dt) - 1;
  console.log(String('1/' + div).padStart(10) + String(Math.round(P3.T / P3.dt)).padStart(8) +
    (Math.abs(Math.abs(m.r.hist[at].rel) - A.dx) / A.dx * 100).toFixed(4).padStart(11) +
    (Math.abs(m.r.maxRel - A.L) / A.L * 100).toFixed(4).padStart(12) +
    (m.ms.toFixed(3) + 'ms').padStart(11));
});
