/*!
 * MrAwU（阿物先生）— 组合模组
 *
 * 这里只用标准接口（lib/compose.js）把已有模组首尾接起来，不写新的物理：
 *   · comboAccelDeflect      加速电场 → 偏转电场（示波管）：接口处真正交出去的只有速度
 *   · comboBoardProjectile   板块（推动木板）→ 平抛：接口处是"离开木板末端"
 *
 * 组合的收益不只是省事：接口一致性本身变成了**可校验的对照项**
 * （交接点重合 / 速度连续 / 突变已记账），时间轴上还会在接口处打一个断口。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./../compose.js'), require('../pacing.js'));
  } else {
    root.PFA = root.PFA || {};
    root.PFA.models_combo = factory(root.PFA.compose, root.PFA.pacing);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (compose, pacingLib) {
  'use strict';

  var pacing = pacingLib.pacing;   // 时长由解析总时间决定（lib/pacing.js）
  var K = 9e9;

  // ==================================================== 一、加速电场 → 偏转电场
  //
  // 阶段1 加速：场 E₁ = U₁/d₁，从静止开始被加速，出口在 x = d₁
  // 阶段2 偏转：场 E₂ = U₂/d₂，垂直进入，出口在 x = d₁ + L
  // 阶段3 漂移：无场匀速，直到打到荧光屏 x = d₁ + L + D
  //
  // 接口①：加速出口 (d₁, 0)、速度 (v₁, 0) → 偏转入口 (d₁, 0)，速度必须连续
  // 接口②：偏转出口 (d₁+L, y₁)、速度 (v₁, v_y) → 漂移入口，速度必须连续
  // 经典结论：屏上总偏移 Y 与 q、m 无关 —— 因为 v₁² = 2qU₁/m 正好把 q/m 约掉。
  function comboAccelDeflect(p) {
    var m = p.mass * 1e-3, q = p.q * 1e-6;
    var E1 = p.U1 / p.d1, E2 = p.U2 / p.d2;
    var a1 = q * E1 / m, a2 = q * E2 / m;
    var v1 = Math.sqrt(2 * a1 * p.d1);
    var t1 = v1 / a1;
    var L = p.plateLen, D = p.screenDist;
    var t2 = L / v1;
    var y1 = -0.5 * a2 * t2 * t2;
    var vy = -a2 * t2;
    var t3 = D / v1;
    var Y = y1 + vy * t3;
    var xPlate0 = p.d1, xPlate1 = p.d1 + L, xScreen = p.d1 + L + D;
    var dur = t1 + t2 + t3;
    // 时长 = 各阶段解析时间之和（加速 t₁ + 偏转 t₂ + 漂移 t₃），步长由它反推；
    // 24 子步是接口精度的标定值（见下方 meta 注释）。
    var pace = pacing({ tTotal: dur, frames: 600, subSteps: 24 });
    if (Math.abs(y1) > p.d2 / 2) {
      throw new Error('这组参数下粒子会打在偏转极板上：出板偏移 |y₁| = ' + Math.abs(y1).toFixed(4) +
        ' m 超过 d₂/2 = ' + (p.d2 / 2).toFixed(4) + ' m。请减小 U₂、增大 U₁ 或加大 d₂。');
    }

    function parts(fx, fy) {
      return {
        ion: {
          parts: {
            gravity: [0, 0], gravitation: [0, 0], electric: [fx, fy],
            normal: [0, 0], friction: [0, 0], applied: [0, 0], joint: [0, 0], damping: [0, 0]
          }
        }
      };
    }

    var ch = compose.chain({
      stages: [
        {
          id: 'accel', title: '加速电场', axis: 'x', dir: 1, x0: 0, x1: xPlate0, obj: 'ion',
          aAxis: function () { return a1; },
          force: function (t) { return parts(t < t1 ? q * E1 : 0, 0); },
          potential: function (t, S) { return -q * E1 * Math.min(S.ion.x, xPlate0); },
          bodies: [
            { id: 'accelPlateL', type: 'static', shape: { kind: 'box', w: 0.03, h: p.plateH },
              at: [-0.015, 0], color: '#ff5d5d', sign: '+', label: '+ 加速板' },
            { id: 'accelPlateR', type: 'static', shape: { kind: 'box', w: 0.03, h: p.plateH },
              at: [p.d1 + 0.015, 0], color: '#4da3ff', sign: '−', label: '− 加速板' }
          ],
          field: { uniform: { x0: 0, x1: p.d1, y0: -p.plateH / 2, y1: p.plateH / 2, ex: 1, ey: 0 } },
          expect: function (pp, w) {
            return [
              { label: '加速段：加速度 a₁ = qU₁/(m d₁)', unit: 'm/s²', value: a1,
                probe: { kind: 'accel', body: 'ion', project: [1, 0], signed: true,
                         window: [w.t0 + 0.15 * (w.t1 - w.t0), w.t0 + 0.85 * (w.t1 - w.t0)],
                         tolerance: 1e-6, absTolerance: 1e-9 } },
              // 出场速度直接读接口记下的**交接瞬间**状态（不受 1/60 采样限制）
              { label: '加速段：出场速度 v₁ = √(2qU₁/m)（接口交接值，子步边界精度 1%）', unit: 'm/s', value: v1,
                probe: { kind: 'interface', which: 'state', index: 0, comp: 'vx',
                         tolerance: 1e-2, absTolerance: 2e-3 } }
            ];
          }
        },
        {
          id: 'deflect', title: '偏转电场', axis: 'x', dir: 1, x0: xPlate0, x1: xPlate1, obj: 'ion',
          aAxis: function () { return 0; },          // 沿 x 匀速（偏转只在 y 方向）
          force: function (t) { return parts(0, t < t1 + t2 ? -q * E2 : 0); },
          potential: function (t, S) { return q * E2 * (S.ion.x < xPlate1 ? S.ion.y : y1); },
          bodies: [
            { id: 'defPlateTop', type: 'static', shape: { kind: 'box', w: L, h: 0.016 },
              at: [xPlate0 + L / 2, p.d2 / 2 + 0.008], color: '#ff5d5d', sign: '+', label: '+ 偏转板' },
            { id: 'defPlateBot', type: 'static', shape: { kind: 'box', w: L, h: 0.016 },
              at: [xPlate0 + L / 2, -p.d2 / 2 - 0.008], color: '#4da3ff', sign: '−', label: '− 偏转板' }
          ],
          field: { uniform: { x0: xPlate0, x1: xPlate1, y0: -p.d2 / 2, y1: p.d2 / 2, ex: 0, ey: -1 } },
          expect: function (pp, w) {
            var tw = w.t1 - w.t0;
            return [
              { label: '偏转段：横向加速度 a₂ = qU₂/(m d₂)', unit: 'm/s²', value: -a2,
                probe: { kind: 'accel', body: 'ion', project: [0, 1], signed: true,
                         window: [w.t0 + 0.15 * tw, w.t0 + 0.85 * tw], tolerance: 1e-6, absTolerance: 1e-9 } },
              // 出板瞬间的偏移与 v_y 同样直接读接口交接值（比从 1/60 采样帧里凑准得多）
              { label: '偏转段：出板偏移 y₁ = ½a₂t₂²（接口交接值，1%）', unit: 'm', value: y1,
                probe: { kind: 'interface', which: 'state', index: 1, comp: 'y',
                         tolerance: 1e-2, absTolerance: 1e-3 } },
              { label: '偏转段：出板时 v_y = a₂t₂（接口交接值，1%）', unit: 'm/s', value: vy,
                probe: { kind: 'interface', which: 'state', index: 1, comp: 'vy',
                         tolerance: 1e-2, absTolerance: 1e-2 } }
            ];
          }
        },
        {
          id: 'drift', title: '匀速漂移段', axis: 'x', dir: 1, x0: xPlate1, x1: xScreen, obj: 'ion',
          aAxis: function () { return 0; },
          force: function () { return parts(0, 0); },
          bodies: [
            { id: 'screen', type: 'static', shape: { kind: 'box', w: 0.02, h: Math.max(0.3, Math.abs(Y) * 3) },
              at: [xScreen, 0], color: '#8fa3c2', label: '荧光屏' }
          ],
          expect: function (pp, w) {
            var Yana = y1 + vy * (D / v1);
            // 与 q、m 无关的推论：Y = U₂L(L/2+D)/(2U₁d₂)
            var Yfree = p.U2 * L * (L / 2 + D) / (2 * p.U1 * p.d2);
            return [
              { label: '屏上总偏移 Y = y₁ + v_y·D/v₁', unit: 'm', value: Yana,
                probe: { kind: 'position', body: 'ion', project: [0, 1], signed: true,
                         window: [w.t1 - 3 * (w.dt || 1 / 60), w.t1 + 3 * (w.dt || 1 / 60)], reduce: 'last',
                         tolerance: 1e-2, absTolerance: 3e-3 } },
              { label: '与 q、m 无关：Y = U₂L(L/2+D)/(2U₁d₂)', unit: 'm', value: -Yfree,
                probe: { kind: 'position', body: 'ion', project: [0, 1], signed: true,
                         window: [w.t1 - 3 * (w.dt || 1 / 60), w.t1 + 3 * (w.dt || 1 / 60)], reduce: 'last',
                         tolerance: 1e-2, absTolerance: 3e-3 } },
              { label: '能量守恒 ½mv² + qU（加速+偏转）', unit: 'J', value: 0,
                probe: { kind: 'statDelta', key: 'mechanical', tolerance: 1e-6, absTolerance: 1e-9 } }
            ];
          }
        },
        {
          // 零长度阶段：到屏就"停住"（荧光屏吸收粒子）。
          // 没有它的话，动画时长会略微超过到屏时刻，末帧测到的位置就不是屏上落点，
          // 屏上偏移会平白偏 5%（实测 -0.1630 vs 解析 -0.1547）。
          id: 'screen', title: '打到荧光屏', axis: 'x', dir: 1,
          x0: xScreen, x1: xScreen + 1e-9, obj: 'ion',
          aAxis: function () { return 0; },
          force: function () { return parts(0, 0); },
          // 打到屏被吸收：这是一次**声明过的**速度突变，冲量交给荧光屏（不参与后续阶段）
          jump: { part: 'electric', note: '打到荧光屏被吸收，动量交给屏' },
          enter: function (t, S) { S.ion.vx = 0; S.ion.vy = 0; },
          bodies: [],
          expect: function () { return []; }
        }
      ]
    });

    return {
      title: '组合模组：加速电场 → 偏转电场（示波管）',
      subtitle: '阶段接口：加速段交出的速度就是偏转段的入口速度；两处接口都要求位置与速度连续',
      tags: ['组合模组', '匀强电场', '加速', '偏转', '示波管'],
      // subSteps 取 24：组合模型的接口精度直接受子步长度影响（8 子步时快速情形偏 2%），
      // 加密到 24 后接口量都在 1% 以内。这个模型很便宜（十几毫秒），多花得起。
      // 时长 = **各阶段解析时间之和** t₁ + t₂ + t₃（lib/pacing.js 反推步长），
      // 不再固定 dt = 1/60 s —— 否则微观格（t 在 ns 量级）整段运动会挤进一帧。
      meta: { g: 0, duration: pace.duration, dt: pace.dt, subSteps: pace.subSteps, energyRefY: 0 },
      view: { height: 560, grid: true },
      bodies: [
        { id: 'ion', type: 'dynamic', shape: { kind: 'circle', r: 0.022 },
          at: [0, 0], velocity: [0, 0], mass: m,
          label: '带电粒子 q=' + p.q + 'μC', color: '#e8934a', showForces: true }
      ].concat(ch.bodies()),
      joints: [], forces: [],
      verletOnly: true,
      // 场线：把各阶段的匀强场拼起来画（lib/field.js 的 uniforms 支持多段）
      field: { uniforms: [
        { x0: 0, x1: p.d1, y0: -p.plateH / 2, y1: p.plateH / 2, ex: 1, ey: 0 },
        { x0: xPlate0, x1: xPlate1, y0: -p.d2 / 2, y1: p.d2 / 2, ex: 0, ey: -1 }
      ] },
      dimensions: [
        { a: 'accelPlateL', anchorA: 'center', b: 'accelPlateR', anchorB: 'center', axis: 'x',
          offset: -p.plateH * 0.62, label: '加速区 d₁' },
        { a: 'screen', anchorA: 'center', b: 'ion', anchorB: 'center', axis: 'y',
          offset: p.plateLen * 0.08, label: '屏上偏移 Y' }
      ],
      markers: ch.markers(),
      laws: ch.laws,
      compose: ch,
      notes: '解析：v₁ = √(2qU₁/m) = ' + v1.toFixed(4) + ' m/s（加速段出口速度，也就是偏转段入口速度）；' +
        't₁ = ' + t1.toFixed(4) + ' s，t₂ = ' + t2.toFixed(4) + ' s，t₃ = ' + t3.toFixed(4) + ' s；' +
        'y₁ = ' + y1.toFixed(4) + ' m，v_y = ' + vy.toFixed(4) + ' m/s，Y = ' + Y.toFixed(4) + ' m。' +
        '把 v₁² = 2qU₁/m 代入 Y 的表达式，q 与 m 全部约掉：Y = U₂L(L/2+D)/(2U₁d₂) = ' + Y.toFixed(4) +
        ' m —— 这就是"示波管偏转量与粒子种类无关"。'
    };
  }

  comboAccelDeflect.expect = function (p, ctx) {
    // 关键：必须用**刚刚跑完的那一个场景**里的 chain 实例——
    // 阶段交接时刻是运行后记录在 chain 上的，重新 build 一份会得到空的时间表，
    // 各阶段窗口就全成了 NaN（实测会让加速度测成 45%）。
    if (ctx && ctx.scene && ctx.scene.compose) return ctx.scene.compose.expect(p, { frames: ctx.frames });
    return comboAccelDeflect(p).compose.expect(p, { frames: null });
  };

  // ==================================================== 二、板块（推木板）→ 平抛
  //
  // 阶段1 板块：物块在木板上被摩擦带动（相对滑动阶段 → 共速后一起运动），
  //             到木板右端离开（出口 x = 板长）
  // 阶段2 平抛：离开后在重力下做平抛，落到地面（出口 y = 0）
  //
  // 接口：物块离开木板瞬间**位置连续、速度连续**（离开不是碰撞，接口不许出现速度跳变）。
  // 这正是标准接口能挡住的一类典型错误：把"离开木板"写成一次碰撞/重置速度。
  function comboBoardProjectile(p) {
    var m = p.mass, M = p.boardMass, mu = p.mu1, g = p.g;
    var F = p.force, tF = p.tF;
    var Lb = p.boardLen;                       // 板长
    var fBoardGround = p.mu2 * (m + M) * g;
    var fSlideMax = mu * m * g;

    // 先用"整体/木板单独"两类假设解析求出运动，判断是否真的会相对滑动
    var drive = F - fBoardGround;
    var boardAcc, blockAcc, slides;
    if (Math.abs(drive) <= fSlideMax) {
      // 一起运动（或都不动）
      boardAcc = (Math.abs(drive) <= fBoardGround + 1e-9 && F <= fBoardGround + fSlideMax) ? 0 : drive / (m + M);
      blockAcc = boardAcc;
      slides = false;
    } else {
      slides = true;
      boardAcc = (drive - fSlideMax) / M;
      blockAcc = fSlideMax / m;
    }
    // 物块相对木板的加速度与到达右端的时间
    var relA = slides ? (blockAcc - boardAcc) : 0;
    var tLeave = relA > 1e-9 ? Math.sqrt(2 * Lb / relA) : Infinity;
    var vBoardLeave = boardAcc * Math.min(tLeave, tF);
    var vBlockLeave = slides ? blockAcc * tLeave : vBoardLeave;
    var h = p.height;                          // 桌面高度
    var tFall = Math.sqrt(2 * h / g);
    var xFlight = vBlockLeave * tFall;
    var dur = tLeave + tFall;

    if (!isFinite(tLeave) || !slides) {
      throw new Error('这组参数下物块不会相对木板滑动到右端（需要 F 足够大或 μ 足够小）：' +
        'F = ' + F + ' N，地面摩擦能提供 ' + fBoardGround.toFixed(1) + ' N。');
    }

    var xBoard0 = 0, xBoard1 = Lb;

    function blockParts(fx, fy) {
      return {
        block: {
          parts: {
            gravity: [0, -m * g], gravitation: [0, 0], electric: [0, 0],
            normal: [0, m * g], friction: [fx, 0], applied: [0, 0], joint: [0, 0], damping: [0, 0]
          }
        }
      };
    }

    var ch = compose.chain({
      stages: [
        {
          id: 'board', title: '板块（木板被拉动）', axis: 'x', dir: 1, x0: xBoard0, x1: xBoard1, obj: 'block',
          aAxis: function () { return blockAcc; },
          force: function (t) {
            // 物块受木板给的滑动摩擦力（向右），木板另外受外力与地面摩擦（画在木板上）
            var f = t < tF ? fSlideMax : 0;
            return blockParts(f, 0);
          },
          bodies: [
            { id: 'board', type: 'dynamic', shape: { kind: 'box', w: Lb, h: 0.05 },
              at: [Lb / 2, -0.03], velocity: [0, 0], mass: M, friction: 0, showForces: false,
              label: '木板 M=' + M + 'kg', color: '#8fa3c2' }
          ],
          expect: function (pp, w) {
            var tEnd = Math.min(w.t1, tF);
            return [
              { label: '板块段：物块加速度 a = μg（木板带动的摩擦）', unit: 'm/s²', value: blockAcc,
                probe: { kind: 'accel', body: 'block', project: [1, 0], signed: true,
                         window: [w.t0 + 0.15 * (tEnd - w.t0), tEnd * 0.9 + w.t0 * 0.1],
                         tolerance: 1e-3, absTolerance: 1e-6 } },
              { label: '板块段：离开木板时的速度', unit: 'm/s', value: vBlockLeave,
                probe: { kind: 'velocity', body: 'block', project: [1, 0], signed: true,
                         window: [w.t1 * 0.98, w.t1 + (w.t1 - w.t0) * 0.1], reduce: 'last',
                         tolerance: 1e-3, absTolerance: 1e-6 } }
            ];
          }
        },
        {
          id: 'flight', title: '平抛（离开木板后）', axis: 'x', dir: 1, x0: xBoard1, x1: xBoard1 + xFlight, obj: 'block',
          aAxis: function () { return 0; },        // 水平方向匀速
          force: function () { return blockParts(0, 0); },
          bodies: [
            { id: 'ground2', type: 'static', shape: { kind: 'box', w: Math.max(2, xFlight * 1.4), h: 0.04 },
              at: [xBoard1 + xFlight * 0.5, -h - 0.02], color: '#4a5a75', label: '地面' }
          ],
          expect: function (pp, w) {
            var tw = w.t1 - w.t0;
            return [
              { label: '平抛段：落地水平射程 x = v·√(2h/g)', unit: 'm', value: xFlight,
                probe: { kind: 'stat', body: 'block', key: 'x', at: 'last', tolerance: 1e-3, absTolerance: 2e-3 } },
              { label: '平抛段：竖直方向 a = g', unit: 'm/s²', value: -g,
                probe: { kind: 'accel', body: 'block', project: [0, 1], signed: true,
                         window: [w.t0 + 0.2 * tw, w.t0 + 0.8 * tw], tolerance: 5e-3, absTolerance: 5e-3 } },
              { label: '平抛段：水平方向匀速（aₓ = 0）', unit: 'm/s²', value: 0,
                probe: { kind: 'accel', body: 'block', project: [1, 0], signed: true,
                         window: [w.t0 + 0.2 * tw, w.t0 + 0.8 * tw], absTolerance: 1e-3 } }
            ];
          }
        }
      ]
    });

    return {
      title: '组合模组：板块 → 平抛',
      subtitle: '物块被木板带动到右端后离开，接口处位置与速度都连续，随后做平抛',
      tags: ['组合模组', '板块模型', '平抛', '摩擦力'],
      meta: { g: g, duration: dur * 1.02, dt: 1 / 60, subSteps: 8, energyRefY: 0 },
      view: { height: 560, grid: true },
      bodies: [
        { id: 'block', type: 'dynamic', shape: { kind: 'box', w: 0.16, h: 0.16 },
          at: [0.08, 0.05], velocity: [0, 0], mass: m,
          label: '物块 m=' + m + 'kg', color: '#e8934a', showForces: true }
      ].concat(ch.bodies()),
      joints: [], forces: [],
      markers: ch.markers(),
      laws: ch.laws,
      compose: ch,
      notes: '解析：木板受合力 F − μ₂(m+M)g − μ₁mg，物块受木板摩擦 μ₁mg；' +
        '相对加速度 ' + relA.toFixed(3) + ' m/s²，离开木板时 t = ' + tLeave.toFixed(3) +
        ' s、v = ' + vBlockLeave.toFixed(3) + ' m/s；随后平抛 t = √(2h/g) = ' + tFall.toFixed(3) +
        ' s、水平射程 ' + xFlight.toFixed(3) + ' m。' +
        '接口只交出"位置 + 速度"，离开木板不是碰撞，所以接口处速度必须连续。'
    };
  }

  comboBoardProjectile.expect = function (p, ctx) {
    if (ctx && ctx.scene && ctx.scene.compose) return ctx.scene.compose.expect(p, { frames: ctx.frames });
    return comboBoardProjectile(p).compose.expect(p, { frames: null });
  };

  function register(add) {
    add({
      id: 'comboAccelDeflect', title: '组合·加速电场→偏转电场（示波管）', group: '组合模组',
      params: [
        { key: 'q', label: '电量 q', unit: 'μC', min: 0.5, max: 6, step: 0.5, value: 2 },
        { key: 'mass', label: '质量 m', unit: 'g', min: 0.5, max: 8, step: 0.5, value: 2 },
        { key: 'U1', label: '加速电压 U₁', unit: 'V', min: 100, max: 2000, step: 50, value: 800 },
        { key: 'd1', label: '加速区长度 d₁', unit: 'm', min: 0.1, max: 0.6, step: 0.05, value: 0.3 },
        { key: 'plateH', label: '加速板高度', unit: 'm', min: 0.2, max: 0.8, step: 0.05, value: 0.4 },
        { key: 'U2', label: '偏转电压 U₂', unit: 'V', min: 20, max: 600, step: 10, value: 150 },
        { key: 'd2', label: '偏转板间距 d₂', unit: 'm', min: 0.04, max: 0.3, step: 0.01, value: 0.1 },
        { key: 'plateLen', label: '偏转板长 L', unit: 'm', min: 0.15, max: 0.8, step: 0.05, value: 0.3 },
        { key: 'screenDist', label: '板到屏 D', unit: 'm', min: 0.1, max: 1.0, step: 0.05, value: 0.4 }
      ],
      build: comboAccelDeflect, expect: comboAccelDeflect.expect
    });
    // 板块 → 平抛：接口机制本身已经工作（交接点重合 0.000%、交接速度连续 0.2%），
    // 但这条链还需要两个框架能力才能算对，所以暂时**不注册**（代码留在这里，补完再开）：
    //   ① 阶段按**相对位移**推进：木板自己也在动，"物块滑到木板右端"是相对量，
    //      用绝对坐标去判会判错（实测离开速度偏 65%）；
    //   ② 平抛段的出口是"落到地面"，那是 y 方向的几何条件，不是沿轴的坐标穿越。
    add({
      id: 'comboBoardProjectile', title: '组合·板块→平抛', group: '组合模组',
      params: [
        { key: 'mass', label: '物块质量 m', unit: 'kg', min: 0.2, max: 3, step: 0.1, value: 1 },
        { key: 'boardMass', label: '木板质量 M', unit: 'kg', min: 0.5, max: 6, step: 0.5, value: 2 },
        { key: 'mu1', label: '物块-木板 μ₁', min: 0.1, max: 0.8, step: 0.05, value: 0.4 },
        { key: 'mu2', label: '木板-地面 μ₂', min: 0, max: 0.4, step: 0.02, value: 0.1 },
        { key: 'force', label: '拉木板的外力 F', unit: 'N', min: 2, max: 40, step: 1, value: 14 },
        { key: 'tF', label: '力作用时间', unit: 's', min: 0.2, max: 3, step: 0.1, value: 1.5 },
        { key: 'boardLen', label: '木板长度', unit: 'm', min: 0.4, max: 3, step: 0.1, value: 1.2 },
        { key: 'height', label: '桌面高度 h', unit: 'm', min: 0.3, max: 2, step: 0.1, value: 0.8 },
        { key: 'g', label: '重力加速度 g', unit: 'm/s²', min: 9, max: 10, step: 1, value: 10 }
      ],
      build: comboBoardProjectile, expect: comboBoardProjectile.expect,
      hidden: true                 // 等上面两点补完再取消隐藏（hidden 的模型不进下拉但可被测试点名）
    });
  }

  return { register: register, comboAccelDeflect: comboAccelDeflect, comboBoardProjectile: comboBoardProjectile };
});
