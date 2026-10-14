/*!
 * MrAwU（阿物先生）— 力学模型组：斜面、自由落体、传送带、板块、连接体、滑轮、弹簧
 * 每个模型自带 expect()：给出解析解与对应的 probe，动画运行时可以逐项对照。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./shared.js'), require('../pacing.js'), require('../forces.js'));
  } else {
    root.PFA = root.PFA || {};
    root.PFA.models_mechanics = factory(root.PFA.lawsShared, root.PFA.pacing, root.PFA.forces);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (shared, pacingLib, forceLib) {
  'use strict';

  var DEG = Math.PI / 180;
  var groundBallLaws = shared.groundBallLaws;   // 与平抛/斜抛共用同一份实现
  // 时长由解析总时间决定（lib/pacing.js），不再写死 1/60 s；assertResolution 是兜底闸门
  var pacing = pacingLib.pacing;
  var assertResolution = pacingLib.assertResolution;

  // =============================================================== 1. 斜面滑块
  // 斜面长度随「演示时长」自适应：这样不需要再去截断用户设的时长，物块也不会滑出斜面
  function inclineEdgeLen(duration, aAlong, s0) {
    var travel = aAlong > 1e-6 ? 0.5 * aAlong * duration * duration : 0;
    return Math.max(40, s0 + travel + 8);
  }
  function incline(p) {
    var g = p.g, th = p.theta * DEG, m = p.mass;
    var moving = Math.tan(th) > p.mu;
    var L = 0.9;                                  // 物块边长
    var N = m * g * Math.cos(th);
    var s0 = 4.0;                                 // 起始位置沿斜面的距离参数
    var dir = [Math.cos(th), Math.sin(th)];        // 沿斜面向上的单位矢量
    var nor = [-Math.sin(th), Math.cos(th)];       // 斜面法向
    var pos = [s0 * dir[0] + (L / 2) * nor[0], s0 * dir[1] + (L / 2) * nor[1]];

    var aAlong = moving ? g * (Math.sin(th) - p.mu * Math.cos(th)) : 0;
    var duration = p.duration;                     // 不再截断，几何跟着变长
    var EDGE = inclineEdgeLen(duration, aAlong, s0);

    return {
      title: '斜面滑块',
      subtitle: moving ? '动摩擦：物块沿斜面下滑' : '静摩擦：物块保持静止（μ ≥ tan θ）',
      tags: ['斜面', '摩擦', '牛顿第二定律'],
      meta: { g: g, duration: duration, dt: 1 / 60, subSteps: 4 },
      view: { height: 560 },
      bodies: [
        { id: 'incline', type: 'static', shape: { kind: 'edge', a: [-EDGE, 0], b: [EDGE, 0] },
          at: [0, 0], angle: th, friction: p.mu, label: '斜面', color: '#3a4a63', showForces: false },
        { id: 'block', type: 'dynamic', shape: { kind: 'box', w: L, h: L }, at: pos, angle: th,
          mass: m, friction: p.mu, restitution: 0, label: '物块 m', color: '#e8934a', showForces: true }
      ],
      joints: [], forces: [],
      notes: '解析：a = g(sinθ − μcosθ)，N = mg cosθ，f = μN（相对滑动时）',
      // 受力小窗的分析坐标系：**整系旋转**（屏幕上的坐标轴是斜的），力的箭头保持真实方向。
      //   x 沿斜面上升方向（播放器按实际运动把 x 翻成"沿斜面向下"）
      //   y 取斜面外法向（远离斜面一侧），于是重力天然分解成 +x / −y 两个分量
      analysisAxis: [[Math.cos(th), Math.sin(th)], [-Math.sin(th), Math.cos(th)]],
      laws: slopeLaws(p)
    };
  }

  incline.expect = function (p) {
    var g = p.g, th = p.theta * DEG, m = p.mass;
    var moving = Math.tan(th) > p.mu;
    var N = m * g * Math.cos(th);
    var up = [Math.cos(th), Math.sin(th)];
    var down = [-Math.cos(th), -Math.sin(th)];
    var nor = [-Math.sin(th), Math.cos(th)];
    var w = [0.15, 0.95];
    var items = [
      { label: '支持力 N', unit: 'N', value: N, probe: { kind: 'force', body: 'block', comp: 'normal', project: nor, signed: true, mode: 'dot', window: w } }
    ];
    if (moving) {
      items.unshift({ label: '沿斜面向下的加速度 a', unit: 'm/s²', value: g * (Math.sin(th) - p.mu * Math.cos(th)),
        probe: { kind: 'accel', body: 'block', project: down, signed: true, window: w } });
      items.push({ label: '摩擦力 f = μN', unit: 'N', value: p.mu * N,
        probe: { kind: 'force', body: 'block', comp: 'friction', project: up, signed: true, window: w } });
    } else {
      items.unshift({ label: '沿斜面方向加速度 a（应保持静止）', unit: 'm/s²', value: 0, absTolerance: 0.01,
        probe: { kind: 'accel', body: 'block', project: up, signed: true, window: w } });
      items.push({ label: '静摩擦力 f = mg sinθ', unit: 'N', value: m * g * Math.sin(th),
        probe: { kind: 'force', body: 'block', comp: 'friction', project: up, signed: true, window: w } });
    }
    return items;
  };

  // =============================================================== 1b. 斜面上受水平推力
  // 来自题图：倾角 37°、m=2kg、μ=0.5，水平推力 F=50N 指向斜面内侧（向左）
  // 反直觉点：F 的分量既把物块压向斜面（N 变大），又把它沿斜面向下推。
  function inclinePushMath(p) {
    var th = p.theta * DEG, cs = Math.cos(th), sn = Math.sin(th);
    var n = [-sn, cs];                              // 斜面外法向（指向物块一侧）
    // 沿法向平衡：N + (重力·n) + (F·n) = 0，其中 重力·n = −mgcosθ、F·n = −Fsinθ
    // 于是 N = mgcosθ + Fsinθ。F<0（向左推）会减小 N，甚至把物块推离斜面。
    var N = p.mass * p.g * cs + p.F * sn;
    var up = [cs, sn];
    var drive = p.F * cs;                           // 推力沿斜面的分量
    var gcomp = -p.mass * p.g * sn;                 // 重力沿斜面的分量
    var net0 = drive + gcomp;
    var fmax = Math.max(0, p.mu * N);
    var f, aUp;
    if (Math.abs(net0) <= fmax) { f = -net0; aUp = 0; }
    else { f = (net0 > 0 ? -1 : 1) * fmax; aUp = (net0 + f) / p.mass; }
    return {
      th: th, cs: cs, sn: sn, n: n, up: up, N: N, f: f, aUp: aUp,
      sliding: Math.abs(net0) > fmax,
      contact: N > 1.0                               // N≤0 物理上不可能：物块会脱离斜面
    };
  }

  function inclinePush(p) {
    var q = inclinePushMath(p);
    if (!q.contact) {
      throw new Error('该水平推力会把物块推离斜面（N = ' + q.N.toFixed(1) + ' N ≤ 0），' +
        '本题不成立。请把 F 调大（向右推）或改用其它模型。');
    }
    var L = 0.9, s0 = 5.0;
    var pos = [s0 * q.up[0] + (L / 2) * q.n[0], s0 * q.up[1] + (L / 2) * q.n[1]];
    var duration = p.duration;                     // 不再截断，斜面长度跟着变长
    var EDGE = inclineEdgeLen(duration, Math.abs(q.aUp), s0);
    return {
      title: '斜面 + 水平推力',
      subtitle: q.sliding
        ? '水平推力一方面把物块压向斜面（N 变大），一方面沿斜面向上推，摩擦力沿斜面向下'
        : '静摩擦足以平衡，物块保持静止',
      tags: ['斜面', '正交分解', '摩擦', '受力分析'],
      meta: { g: p.g, duration: duration, dt: 1 / 60, subSteps: 4 },
      view: { height: 560 },
      bodies: [
        { id: 'incline', type: 'static', shape: { kind: 'edge', a: [-EDGE, 0], b: [EDGE, 0] },
          at: [0, 0], angle: q.th, friction: p.mu, label: '斜面', color: '#3a4a63', showForces: false },
        { id: 'block', type: 'dynamic', shape: { kind: 'box', w: L, h: L }, at: pos, angle: q.th,
          mass: p.mass, friction: p.mu, restitution: 0, label: '物块 m', color: '#e8934a', showForces: true }
      ],
      joints: [],
      forces: [{ kind: 'constant', body: 'block', force: [p.F, 0], at: [0, 0], label: 'F' }],
      notes: '解析：N = mgcosθ − Fsinθ；沿斜面方向 Fcosθ − mgsinθ，与 μN 比较判断是否滑动。' +
             '约定：F > 0 表示水平向右推（会把物块向上推），F < 0 表示水平向左推（压向斜面并向下推）。',
      analysisAxis: [[q.cs, q.sn], [-q.sn, q.cs]],   // x 沿斜面上升方向，y 为斜面外法向
      laws: slopeLaws(p, { force: p.F })
    };
  }

  inclinePush.expect = function (p) {
    var q = inclinePushMath(p);
    var w = [0.15, 0.95];
    var items = [
      { label: '支持力 N = mgcosθ + Fsinθ', unit: 'N', value: q.N,
        probe: { kind: 'force', body: 'block', comp: 'normal', project: q.n, signed: true, window: w } },
      { label: '摩擦力（沿斜面向上为正）', unit: 'N', value: q.f,
        probe: { kind: 'force', body: 'block', comp: 'friction', project: q.up, signed: true, window: w } }
    ];
    if (q.sliding) {
      items.unshift({ label: '沿斜面加速度（向上为正）', unit: 'm/s²', value: q.aUp,
        probe: { kind: 'accel', body: 'block', project: q.up, signed: true, window: w } });
    } else {
      items.unshift({ label: '沿斜面加速度（应保持静止）', unit: 'm/s²', value: 0, absTolerance: 0.01,
        probe: { kind: 'accel', body: 'block', project: q.up, signed: true, window: w } });
    }
    return items;
  };

  // =============================================================== 2. 自由落体
  var FF_R = 0.22;
  function ffTimes(p) {
    var tFall = Math.sqrt(2 * p.height / p.g);
    // 不再截断演示时长：落地后小球会停在地面上（这本身也是可看的信息）。
    // 解析对照项的采样窗口一律以「落地时刻」为基准，与演示时长无关。
    return { tFall: tFall, dur: p.duration };
  }
  function freefall(p) {
    var t = ffTimes(p);
    // 时长按**解析落地时间**定（lib/pacing.js）：演示至少覆盖 tFall 的全过程，
    // 且不短于用户设的「演示时长」——落地后小球停在地面上也是可看的信息。
    // 旧写法 dt = 1/60 s 在 h 很小（微观/数值实验）时会把整段落地挤进极少数帧，
    // 由 assertResolution 兜底拦住（见 references/pitfalls.md ③）。
    var pace = pacing({ tTotal: Math.max(1.02 * t.tFall, p.duration), frames: 600, subSteps: 4,
                        minFrames: 50 });
    assertResolution({ duration: pace.duration, characteristicTime: Math.max(pace.dt / pace.subSteps, 1e-12),
                       frames: pace.frames, minFramesPerChar: 50 });
    return {
      title: '自由落体',
      subtitle: '只受重力：a = g，与质量无关',
      tags: ['自由落体', '匀变速'],
      meta: { g: p.g, duration: pace.duration, dt: pace.dt, subSteps: pace.subSteps },
      view: { height: 560 },
      bodies: [
        { id: 'ball', type: 'dynamic', shape: { kind: 'circle', r: FF_R }, at: [0, p.height + FF_R],
          mass: p.mass, restitution: 0.0, friction: 0, label: '小球 m=' + p.mass + 'kg', color: '#5fa8ff', showForces: true },
        { id: 'ground', type: 'static', shape: { kind: 'box', w: 6, h: 0.3 }, at: [0, -0.15],
          friction: 0.6, label: '地面', showForces: false }
      ],
      markers: [{ t: t.tFall, label: '落地',
        note: '小球落地的瞬间：下落时间 t = √(2h/g) = ' + t.tFall.toFixed(3) +
          ' s，落地速率 v = gt = √(2gh) = ' + (p.g * t.tFall).toFixed(2) +
          ' m/s。v-t 图在这里是过原点、斜率 = g = ' + p.g + ' m/s² 的直线。' }],
      notes: '解析：v = gt，h = ½gt²，末速度 v = √(2gh)',
      laws: groundBallLaws({ mass: p.mass, g: p.g, r: FF_R, tFall: t.tFall })
    };
  }

  freefall.expect = function (p) {
    var t = ffTimes(p);
    var dt = 1 / 60;
    // 采样点：落地前一帧；若演示时长比落地还短，就取演示的最后一帧
    var kLand = Math.max(1, Math.ceil(t.tFall / dt) - 1);
    var kLast = Math.max(1, Math.round(p.duration / dt));
    var tEnd = Math.min(kLand, kLast) * dt;
    return [
      { label: '加速度 a = g', unit: 'm/s²', value: p.g,
        probe: { kind: 'accel', body: 'ball', project: [0, -1], signed: true,
                 window: [0.05, 0.85 * Math.min(t.tFall, p.duration)] } },
      { label: (kLand <= kLast ? '落地前速率 v = gt' : '演示结束时的速率 v = gt'), unit: 'm/s', value: p.g * tEnd,
        probe: { kind: 'velocity', body: 'ball', mode: 'mag',
                 window: [Math.max(0, tEnd - 0.1), tEnd + 1e-6], reduce: 'last', tolerance: 0.002 } }
    ];
  };

  // =============================================================== 3. 传送带
  function beltGeom(p) {
    var mu = p.mu, v = p.v, v0 = p.v0, x0 = -2;
    var aSign = (v > v0 ? 1 : -1) * mu * p.g;            // 相对滑动阶段的加速度
    var tCommon = Math.abs(v - v0) / (mu * p.g);         // 达到共速所需时间
    var tSlide = Math.min(p.duration, tCommon);
    function blockX(t) {
      if (t <= tSlide) return x0 + v0 * t + 0.5 * aSign * t * t;
      var xs = x0 + v0 * tSlide + 0.5 * aSign * tSlide * tSlide;
      return xs + v * (t - tSlide);
    }
    // 带面自身以 v 平移，故用「物块位置 − 带面位移」的极值确定带面所需范围
    var mMin = Infinity, mMax = -Infinity;
    for (var i = 0; i <= 200; i++) {
      var tt = p.duration * i / 200;
      var m = blockX(tt) - v * tt;
      if (m < mMin) mMin = m;
      if (m > mMax) mMax = m;
    }
    return {
      x0: x0, tCommon: tCommon, aSign: aSign,
      spanMin: mMin - 1.5, spanMax: mMax + 1.5,
      xEnd: blockX(p.duration)
    };
  }
  function belt(p) {
    var mu = p.mu, v = p.v, m = p.mass, L = 0.7;
    var g0 = beltGeom(p);
    var beltW = g0.spanMax - g0.spanMin;
    var beltX = (g0.spanMax + g0.spanMin) / 2;
    return {
      title: '传送带模型',
      subtitle: p.v0 === 0 ? '物块静止放上传送带，先加速后共速' : '物块以初速度冲上传送带',
      tags: ['传送带', '摩擦力', '共速'],
      meta: { g: p.g, duration: p.duration, dt: 1 / 60, subSteps: 4 },
      view: { height: 560 },
      bodies: [
        { id: 'belt', type: 'belt', speed: v, shape: { kind: 'box', w: beltW, h: 0.24 },
          at: [beltX, -0.12], friction: mu, label: '传送带 v=' + v + ' m/s', color: '#41506b' },
        { id: 'block', type: 'dynamic', shape: { kind: 'box', w: L, h: L }, at: [g0.x0, L / 2 + 0.001],
          mass: m, friction: mu, velocity: [p.v0, 0], label: '物块 m', color: '#e8934a', showForces: true }
      ],
      markers: [
        { t: g0.tCommon, label: '共速',
          note: '物块速度追上带速 v = ' + v + ' m/s，相对速度归零 → 滑动摩擦力消失。' +
            '本题相对滑动用了 t = |v − v₀|/(μg) = ' + g0.tCommon.toFixed(2) +
            ' s；之后若无其他水平外力，物块随带一起匀速运动。' }
      ].filter(function (mk) { return mk.t > 0.01 && mk.t <= p.duration * 1.001; }),
      notes: '解析：相对滑动时 a = μg（方向由相对速度决定）；共速后摩擦力降为 0（或静摩擦平衡外力）',
      laws: beltLaws(p)
    };
  }

  belt.expect = function (p) {
    var mu = p.mu, N = p.mass * p.g;
    var g0 = beltGeom(p);
    var tEnd = Math.max(0.12, Math.min(g0.tCommon * 0.8, p.duration * 0.7));
    var w1 = [0.15, Math.max(0.2, tEnd)];
    var fwd = p.v > p.v0 ? 1 : -1;                       // 摩擦力方向
    var aTheory = fwd * mu * p.g;
    return [
      { label: '正压力 N = mg', unit: 'N', value: N,
        probe: { kind: 'force', body: 'block', comp: 'normal', project: [0, 1], signed: true, window: w1 } },
      { label: '滑动摩擦 f = μN', unit: 'N', value: fwd * mu * N,
        probe: { kind: 'force', body: 'block', comp: 'friction', project: [1, 0], signed: true, window: w1 } },
      { label: '相对滑动阶段加速度 a = μg（带比块快取正）', unit: 'm/s²', value: aTheory,
        probe: { kind: 'accel', body: 'block', project: [1, 0], signed: true, window: w1 } }
    ];
  };

  // =============================================================== 4. 板块模型
  function plankGeom(p) {
    var m = p.mass, M = p.plankMass, mu1 = p.mu1, mu2 = p.mu2 || 0, g = p.g;
    var a1 = -mu1 * g;
    var a2 = (mu1 * m * g - mu2 * (m + M) * g) / M;
    var arel = a1 - a2;                                  // 相对加速度（负=相对速度在减小）
    var tSlide = p.duration;
    if (arel < 0) tSlide = Math.min(p.duration, p.v0 / (-arel));
    var relMax = p.v0 * tSlide + 0.5 * arel * tSlide * tSlide;
    // 小尺度模式（题图那种"最小板长 9 cm"的题）：按解析滑动距离等比定几何，
    // 否则物块（0.8 m）会比整块木板（L_min = 0.09 m）还大，画出来毫无意义。
    var auto = !p.blockSize || p.blockSize <= 0;
    var L, PH, plankLen, blockStart;
    if (auto) {
      L = 0.8; PH = 0.9;
      plankLen = Math.max(4, Math.abs(relMax) + 3);
      blockStart = -plankLen / 2 + 1.5;
    } else {
      L = p.blockSize;
      PH = Math.max(0.004, L * 0.3);
      plankLen = Math.abs(relMax) * 1.35 + L;            // 留出余量，保证能看到"没滑出去"
      blockStart = -plankLen / 2 + L / 2;                // 滑块从木板左端滑上（题图描述）
    }
    // 采样窗口必须整段落在"还在相对滑动"的区间内：一旦越过共速时刻，
    // 加速度立刻变 0，取平均就会得到一半的值（实测 50% 误差）。
    var wHi = Math.max(0.02, Math.min(0.8 * tSlide, 0.9 * p.duration));
    var wLo = Math.min(0.15 * tSlide, Math.max(1 / 120, 0.4 * wHi));
    var w = [wLo, wHi];
    return {
      a1: a1, a2: a2, tSlide: tSlide, plankLen: plankLen, blockStart: blockStart,
      w: w, L: L, PH: PH, relMax: relMax
    };
  }
  function plank(p) {
    var m = p.mass, M = p.plankMass, mu1 = p.mu1, mu2 = p.mu2 || 0;
    var g0 = plankGeom(p);
    var L = g0.L, PH = g0.PH;                    // 物块与木板的尺寸（可由 blockSize 指定小尺度）
    return {
      title: p.blockSize > 0 ? '板块模型·光滑地面' : '板块模型',
      subtitle: '滑块在木板上相对滑动，摩擦力驱动木板',
      tags: ['板块', '相对滑动', '动量'],
      meta: {
        g: p.g, duration: p.duration, dt: 1 / 60, subSteps: 4,
        frictionPairs: [
          { a: 'block', b: 'board', friction: mu1 },
          { a: 'board', b: 'ground', friction: mu2 }
        ]
      },
      view: { height: 560 },
      bodies: [
        { id: 'ground', type: 'static', shape: { kind: 'box', w: 80, h: 0.4 }, at: [0, -0.2], friction: mu2, label: '地面', showForces: false },
        { id: 'board', type: 'dynamic', shape: { kind: 'box', w: g0.plankLen, h: PH }, at: [0, PH / 2 + 0.001],
          mass: M, friction: mu1, label: '木板 M', color: '#5fa8ff', showForces: true },
        { id: 'block', type: 'dynamic', shape: { kind: 'box', w: L, h: L }, at: [g0.blockStart, PH + L / 2 + 0.01],
          mass: m, friction: mu1, velocity: [p.v0, 0], label: '滑块 m', color: '#e8934a', showForces: true }
      ],
      markers: (function () {
        // 滑块滑上木板后，相对速度以 |a_rel| 收敛；把"共速"这一刻标在时间轴上
        var rel0 = Math.abs(p.v0), arelAbs = Math.abs(g0.a1 - g0.a2);
        if (arelAbs < 1e-9) return [];
        var tc = rel0 / arelAbs;
        if (!(tc > 0.01) || tc > p.duration * 1.001) return [];
        return [{ t: tc, label: '共速',
          note: '滑块与木板达到共同速度，之后两者一起运动（或按外力重新判断）。' +
            '本题相对速率以 |a_rel| = ' + arelAbs.toFixed(2) + ' m/s² 收敛，用时 v₀/|a_rel| = ' +
            tc.toFixed(2) + ' s。' }];
      })(),
      notes: '解析：a块 = −μ₁g；a板 = [μ₁mg − μ₂(m+M)g]/M；地面光滑时动量守恒 v共 = mv₀/(m+M)',
      // 自研 Verlet 后端的受力律（声明了它，这个模型就能不用 planck 跑）
      laws: plankLaws(p)
    };
  }

  plank.expect = function (p) {
    var m = p.mass, M = p.plankMass, mu1 = p.mu1, mu2 = p.mu2 || 0;
    var g0 = plankGeom(p);
    var items = [
      { label: '滑块加速度 a₁ = −μ₁g', unit: 'm/s²', value: g0.a1,
        probe: { kind: 'accel', body: 'block', project: [1, 0], signed: true, window: g0.w } },
      { label: '木板加速度 a₂', unit: 'm/s²', value: g0.a2,
        probe: { kind: 'accel', body: 'board', project: [1, 0], signed: true, window: g0.w, tolerance: 0.03 } },
      { label: '滑块-木板摩擦力（作用在滑块上）', unit: 'N', value: -mu1 * m * p.g,
        probe: { kind: 'force', body: 'block', comp: 'friction', project: [1, 0], signed: true, window: g0.w } }
    ];
    if (mu2 === 0) {
      items.push({
        label: '动量守恒：末动量等于初动量', unit: 'kg·m/s', value: m * p.v0,
        probe: { kind: 'stat', key: 'momentumX', at: 'last', tolerance: 0.02 }
      });
    }
    // 共速时刻与最小板长（把"最小板长"这个题问量也变成机器可核对的对照项）
    var arelAbs = Math.abs(g0.a1 - g0.a2);
    if (arelAbs > 1e-9 && p.v0 > 0) {
      var tc = p.v0 / arelAbs;
      var lmin = p.v0 * p.v0 / (2 * arelAbs);          // = Δx（相对滑动位移）
      items.push({
        label: '共速所需时间 t = v₀/|a_rel|', unit: 's', value: tc,
        probe: { kind: 'eventTime', body: 'block', ref: 'board', axis: 'x', tol: 1e-3, tolerance: 0.05 }
      });
      items.push({
        label: '最小板长 L_min = v₀²/(2|a_rel|)', unit: 'm', value: lmin,
        probe: { kind: 'relative', body: 'block', ref: 'board', relativeTo: 'initial',
                 project: [1, 0], signed: true, window: [0, 1e9], reduce: 'last', tolerance: 0.01 }
      });
    }
    return items;
  };

  // =============================================================== 4b. 板块模型（对木板施加水平恒力）
  // 题源：足够长的木板放在水平面上，物块在木板左端，对**木板**施加水平恒力 F，
  //       作用 t_F 秒后撤去。物块靠板间摩擦被动跟随。
  // 三问一体的经典题：
  //   (1) 恰好一起运动 → a = μ₁g（物块能获得的最大加速度）→ F₀ = (M+m)a + μ₂(M+m)g
  //   (2) F > F₀ → 相对滑动：a_块 = μ₁g，a_板 = (F − μ₁mg − μ₂(M+m)g)/M
  //   (3) 撤去 F 后木板减速、物块继续加速，相对速率以 (μ₁g + (μ₁mg+μ₂(M+m)g)/M) 收敛，
  //       继续滑动的距离 = v_rel²/(2a_rel)，物块不滑离 → 板长 ≥ 总相对滑动位移
  function plankPushMath(p) {
    var m = p.mass, M = p.boardMass, mu1 = p.mu1, mu2 = p.mu2, g = p.g, F = p.force, tF = p.tF;
    var f1 = mu1 * m * g;                       // 物块与木板间的滑动摩擦（也是最大静摩擦）
    var f2 = mu2 * (m + M) * g;                 // 木板与地面间的滑动摩擦
    var aMax = f1 / m;                          // 物块能获得的最大加速度 = μ₁g
    var Fcrit = (m + M) * aMax + f2;            // 恰好一起运动所需的力
    var stalled = F <= f2 + 1e-9;               // 力太小，整体不动
    var together = !stalled && F <= Fcrit + 1e-9;
    var aBlock, aBoard;
    if (stalled) { aBlock = 0; aBoard = 0; }
    else if (together) { aBlock = aBoard = (F - f2) / (m + M); }
    else { aBlock = aMax; aBoard = (F - f1 - f2) / M; }

    var vBlock = aBlock * tF, vBoard = aBoard * tF;
    var vRel = vBoard - vBlock;                 // 木板比物块多走的速率 = 相对滑动速率
    var aBoard2 = (f1 + f2) / M;                // 撤力后木板减速（与运动反向）
    var aBlock2 = f1 / m;                       // 物块继续被摩擦加速（与运动同向）
    var aRel = aBlock2 + aBoard2;               // 相对速率在收敛
    var slide1 = 0.5 * (aBoard - aBlock) * tF * tF;                 // 0~t_F 的相对滑动位移
    var slide2 = vRel > 1e-9 ? vRel * vRel / (2 * aRel) : 0;        // 撤力后继续滑动
    var tClose = vRel > 1e-9 ? vRel / aRel : 0;
    var tStop = tF + tClose;
    // 任意时刻的相对滑动位移（演示时长可长可短，期望值都要对得上）
    function slideAt(t) {
      if (t <= 0) return 0;
      if (t <= tF) return 0.5 * (aBoard - aBlock) * t * t;
      var s = slide1, dt2 = Math.min(t, tStop) - tF;
      if (dt2 <= 0) return s;
      return s + vRel * dt2 - 0.5 * aRel * dt2 * dt2;
    }
    return {
      m: m, M: M, g: g, f1: f1, f2: f2, aMax: aMax, Fcrit: Fcrit,
      stalled: stalled, together: together, aBlock: aBlock, aBoard: aBoard,
      aBlock2: aBlock2, aBoard2: aBoard2, vBlock: vBlock, vBoard: vBoard, vRel: vRel,
      slide1: slide1, slide2: slide2, slideAtTF: slide1, slideMax: slide1 + slide2,
      slideAt: slideAt, tClose: tClose, tStop: tStop
    };
  }

  /**
   * 「板 + 块」系统的**通用受力律**（plankPush / plank / plankSmooth 共用同一份）。
   * 这是整条轻量路线唯一的真风险所在：**每一步的受力分支判定**——
   *   - 板间是相对滑动还是相对静止（静摩擦够不够）
   *   - 地面是静摩擦（推不动）还是滑动摩擦
   * 并用 nextEvent() 把"共速瞬间"解析求出来交给积分器，保证不跨过临界点。
   * cfg: { m, M, g, mu1, mu2, applied(t) → 作用在木板上的外力（可空）, tF: 撤力时刻（可空） }
   */
  function boardBlockLaws(cfg) {
    var m = cfg.m, M = cfg.M, g = cfg.g;
    var f1max = (cfg.mu1 || 0) * m * g;           // 板-块最大静摩擦
    var f2max = (cfg.mu2 || 0) * (m + M) * g;     // 板-地最大静摩擦
    var EPS = 1e-9;                               // 判定"板间是否相对滑动"的相对速度阈值
    // 判定"共速"的捕捉阈值：落到事件点时残留的相对速度只要小于它就直接投影成共同速度。
    // 物理上 |v_rel| ≤ 5 mm/s 已可视作相对静止；由此引入的位移误差量级 O(ε²/2a) ≈ 1e-6 m，
    // 但可以彻底消除"共速附近来回抖动"（否则切换时刻会被磨偏、L_min 少 0.1%）。
    var EPS_CAPTURE = 5e-3;
    var EPS_T = 1e-12;
    var tF = cfg.tF != null ? cfg.tF : null;
    function Fa(t) { return cfg.applied ? cfg.applied(t) : 0; }
    function sumX(parts) {
      return parts.gravity[0] + parts.normal[0] + parts.friction[0] + parts.applied[0] +
        parts.joint[0] + parts.damping[0];
    }

    /**
     * 子步分支锁定：把"这个子步开始时的相对滑动方向"固定下来。
     * 为什么必须锁：速度-Verlet 要算 F1（子步起点）与 F2（预测点）两次受力。
     * 当预测点因浮点噪声刚好越过共速点时，F2 会掉进"相对静止"分支、
     * 摩擦瞬间变 0，于是该子步的平均加速度只剩一半
     * （实测：0.15 s 的共速点被推到 0.152 s，共速时刻误差 11%）。
     * 真实的受力分支切换只发生在临界时刻，而临界时刻由 nextEvent 精确停住，
     * 所以子步内部必须沿用同一个分支。
     */
    function lock(S) {
      var vr = S.block.vx - S.board.vx;
      return Math.abs(vr) > EPS ? { slidingSign: Math.sign(vr) } : null;
    }

    /** 给定时刻与状态，判定受力分支并给出每个刚体的力分解 */
    function force(t, S, lk) {
      var vb = S.board.vx, vk = S.block.vx;
      var f = Fa(t);                              // 外力（作用在木板上）
      var vrel = vk - vb;
      var fBlock, fBoard, fg, regime;

      if ((lk && lk.slidingSign) || Math.abs(vrel) > EPS) {
        // ---- 板间相对滑动：摩擦力大小 = μ₁mg，方向反对相对运动 ----
        regime = 'sliding';
        var sgn = (lk && lk.slidingSign) ? lk.slidingSign : Math.sign(vrel);
        fBlock = -sgn * f1max;
        fBoard = -fBlock;
        fg = Math.abs(vb) > EPS ? -Math.sign(vb) * f2max : -Math.sign(f + fBoard) * f2max;
      } else {
        // ---- 板间相对静止：先定地面，再看板间静摩擦够不够 ----
        if (Math.abs(vb) > EPS) fg = -Math.sign(vb) * f2max;
        else if (Math.abs(f) <= f2max) fg = -f;              // 静止且推不动 → 静摩擦平衡
        else fg = -Math.sign(f) * f2max;
        var aCom = (f + fg) / (m + M);
        var fNeed = m * aCom;                                // 要一起走，物块需要这么大摩擦
        if (Math.abs(fNeed) <= f1max + 1e-9) {
          regime = 'together';
          fBlock = fNeed; fBoard = -fNeed;
        } else {
          regime = 'breakaway';
          fBlock = Math.sign(aCom) * f1max;
          fBoard = -fBlock;
        }
      }

      // 支持力取「净接触支持力」：本模型竖直方向无加速度，故净支持力 = mg。
      // 注意不能写成地面托板的 (m+M)g——那会漏掉物块压在板上的 mg，
      // 竖直方向净剩 mg 就会让木板飞起来（实测 4 s 飞 53 m）。
      var Nblock = m * g, Nboard = M * g;
      return {
        board: {
          parts: {
            gravity: [0, -M * g],
            normal: [0, Nboard],
            friction: [fBoard + fg, 0],
            applied: [f, 0],
            joint: [0, 0], damping: [0, 0]
          },
          regime: regime
        },
        block: {
          parts: {
            gravity: [0, -m * g],
            normal: [0, Nblock],
            friction: [fBlock, 0],
            applied: [0, 0],
            joint: [0, 0], damping: [0, 0]
          },
          regime: regime
        }
      };
    }

    /**
     * 到达临界时刻时的状态投影：把相对速度精确置 0（动量守恒地取共同速度）。
     * 不做这一步的话，"共速"会在步长尺度上反复触发、把切换时刻磨到 2.5994 而不是 2.6。
     */
    function onEvent(t, S) {
      var vb = S.board.vx, vk = S.block.vx;
      var vrel = vk - vb;
      if (Math.abs(vrel) > EPS_CAPTURE) return;     // 不是共速事件（例如撤去外力），不投影
      var vcom = (m * vk + M * vb) / (m + M);       // 动量守恒地取共同速度
      S.board.vx = vcom; S.block.vx = vcom;
    }

    /**
     * 临界时刻（严格大于 t）：交给积分器"停在事件点上"。
     *  1) 撤去外力的时刻 t_F
     *  2) 板间相对速度过零的时刻（在当前分支下解析求解）：a_rel 恒定 → t* = t − v_rel/a_rel
     */
    function nextEvent(t, S) {
      var best = null;
      if (tF != null && t < tF - EPS_T) best = tF;
      var F = force(t, S);
      var fb = F.board.parts, fk = F.block.parts;
      var aB = sumX(fb) / M, aK = sumX(fk) / m;
      var arel = aK - aB, vrel = S.block.vx - S.board.vx;
      if (Math.abs(arel) > 1e-12 && vrel * arel < 0) {
        var tCross = t - vrel / arel;
        if (tCross > t + EPS_T && (best == null || tCross < best)) best = tCross;
      }
      return best;
    }
    function sumX(parts) {
      return parts.gravity[0] + parts.normal[0] + parts.friction[0] + parts.applied[0] +
        parts.joint[0] + parts.damping[0];
    }

    return { force: force, nextEvent: nextEvent, onEvent: onEvent, lock: lock };
  }

  /** 弹簧振子：F = −k(x−rest) − c·v（一维，无接触） */
  function springLaws(p) {
    var m = p.mass, k = p.k, c = p.damping || 0;
    var wallX = -3.0, rest = 2.0;
    var x0 = wallX + rest + p.amplitude;
    function springF(S) {
      var dx = S.cart.x - (wallX + rest);
      return -k * dx - c * S.cart.vx;
    }
    function force(t, S) {
      var F = springF(S);
      var body = {
        cart: {
          parts: {
            gravity: [0, -m * p.g], normal: [0, m * p.g], friction: [0, 0],
            // 弹簧力在 planck 路径里也是记在 applied 下的（expect 的 probe 就查这一项）
            applied: [F, 0], joint: [0, 0], damping: [0, 0]
          }
        }
      };
      return body;
    }
    // 初始位置由场景给出（at = x0），与 build 保持一致
    return {
      force: force,
      initial: { cart: [x0, 0.351, 0, 0] },
      math: { wallX: wallX, rest: rest }
    };
  }

  /**
   * 斜面上物块的受力律（incline / inclinePush 共用）。
   * 关键点：法向力取解析值 mg cosθ − F sinθ，于是"重力+支持力"的**垂直斜面分量精确抵消**，
   * 物块自然只沿斜面运动，不需要额外的速度约束；
   * project() 只修位置（不修速度）来消除浮点漂移，因此不会引入未记账的冲量。
   */
  function slopeLaws(p, opt) {
    var m = p.mass, g = p.g, th = p.theta * DEG, mu = p.mu, L = 0.9;
    var sx = Math.cos(th), sy = Math.sin(th);          // 沿斜面向上
    var nx = -Math.sin(th), ny = Math.cos(th);         // 法向（指向物块一侧）
    var F = opt && opt.force != null ? opt.force : 0;

    function force(t, S) {
      // 法向投影平衡 → N = mgcosθ + Fsinθ（F 为水平 +x 推力；F<0 向左推会减小 N）
      var N = m * g * Math.cos(th) + F * Math.sin(th);
      if (N < 0) N = 0;                                 // 推力足够大时物块会离开斜面
      var vAlong = S.block.vx * sx + S.block.vy * sy;
      var drive = -m * g * sy + F * sx;                 // 沿斜面的驱动力（重力沿斜面 + 推力沿斜面）
      var f;
      if (Math.abs(vAlong) > 1e-9) f = -Math.sign(vAlong) * mu * N;
      else if (Math.abs(drive) <= mu * N) f = -drive;   // 静摩擦正好平衡 → 保持静止
      else f = -Math.sign(drive) * mu * N;
      return {
        block: {
          parts: {
            gravity: [0, -m * g],
            normal: [N * nx, N * ny],
            friction: [f * sx, f * sy],
            applied: [F, 0], joint: [0, 0], damping: [0, 0]
          }
        }
      };
    }
    function project(t, S) {
      var b = S.block;
      var s = b.x * sx + b.y * sy;                      // 只保留沿斜面分量 + 半个物块高的法向偏移
      b.x = s * sx + (L / 2) * nx;
      b.y = s * sy + (L / 2) * ny;
      return null;                                      // 速度未改 → 不需要记账
    }
    return { force: force, project: project };
  }

  /**
   * 传送带上物块的受力律：滑动摩擦 = μmg、方向由**相对带面**的速度决定；
   * 相对速度过零的那一刻由 nextEvent 解析给出，并在那一刻把物块速度精确置为带速。
   */
  function beltLaws(p) {
    var m = p.mass, g = p.g, mu = p.mu, vBelt = p.v;
    var fmax = mu * m * g;
    function force(t, S) {
      var rel = S.block.vx - vBelt;
      var f = Math.abs(rel) > 1e-9 ? -Math.sign(rel) * fmax : 0;
      return {
        block: {
          parts: {
            gravity: [0, -m * g], normal: [0, m * g], friction: [f, 0],
            applied: [0, 0], joint: [0, 0], damping: [0, 0]
          }
        }
      };
    }
    function nextEvent(t, S) {
      var rel = S.block.vx - vBelt;
      if (Math.abs(rel) < 1e-9) return null;
      var a = -Math.sign(rel) * mu * g;
      if (rel * a >= 0) return null;
      var tc = t - rel / a;
      return tc > t + 1e-12 ? tc : null;
    }
    function onEvent(t, S) {
      if (Math.abs(S.block.vx - vBelt) > 5e-3) return null;
      S.block.vx = vBelt;                    // 带面"抓住"物块；冲量由带面提供，记在摩擦名下
      return { block: { part: 'friction' } };
    }
    return { force: force, nextEvent: nextEvent, onEvent: onEvent };
  }

  /**
   * 粗糙地面上两物块用绳连接（connector）：绳约束用动量守恒的速度投影实现，
   * 张力由 project() 产生的冲量自动得到，受力表里作为 joint 显示。
   */
  function connectorLaws(p) {
    var mA = p.mass1, mB = p.mass2, g = p.g, F = p.force;
    var L0 = null, T = 0;
    function force(t, S) {
      return {
        A: {
          parts: { gravity: [0, -mA * g], normal: [0, mA * g], friction: [0, 0], applied: [0, 0], joint: [T, 0], damping: [0, 0] }
        },
        B: {
          parts: { gravity: [0, -mB * g], normal: [0, mB * g], friction: [0, 0], applied: [F, 0], joint: [-T, 0], damping: [0, 0] }
        }
      };
    }
    function project(t, S) {
      if (L0 == null) L0 = S.B.x - S.A.x;
      if (S.B.x - S.A.x <= L0 + 1e-9) return null;        // 绳只拉不推
      var vrel = S.B.vx - S.A.vx;
      if (vrel > 0) {
        // 动量守恒地把相对分离速度抹掉（两个物块各分一半冲量）
        S.A.vx += vrel * mB / (mA + mB);
        S.B.vx -= vrel * mA / (mA + mB);
      }
      // 绳绷紧后两者一起加速：a = F/(mA+mB)，张力 T = mA·a
      T = mA * F / (mA + mB);
      return { A: { part: 'joint' }, B: { part: 'joint' } };
    }
    function jointItems() {
      return [
        { id: 'rope', kind: 'rope', body: 'A', force: [T, 0] },
        { id: 'rope', kind: 'rope', body: 'B', force: [-T, 0] }
      ];
    }
    return { force: force, project: project, jointItems: jointItems };
  }

  /** Atwood 机：绳长约束 y₁+y₂ = 常数，张力由约束冲量自动得到 */
  function atwoodLaws(p) {
    var m1 = p.mass1, m2 = p.mass2, g = p.g;
    var C0 = null;
    function force(t, S) {
      return {
        m1: { parts: { gravity: [0, -m1 * g], normal: [0, 0], friction: [0, 0], applied: [0, 0], joint: [0, 0], damping: [0, 0] } },
        m2: { parts: { gravity: [0, -m2 * g], normal: [0, 0], friction: [0, 0], applied: [0, 0], joint: [0, 0], damping: [0, 0] } }
      };
    }
    function project(t, S) {
      if (C0 == null) C0 = S.m1.y + S.m2.y;
      // 约束 C = y₁+y₂−C₀ = 0，梯度都是 1；**必须按质量加权**分配修正量：
      // 等权修正会把两者一起拉回原处（净运动为 0，实测加速度误差 100%）。
      // 正确做法 Δyᵢ = −λ·wᵢ，wᵢ = 1/mᵢ，λ = C/(w₁+w₂)，等价于一次精确的约束冲量求解。
      var w1 = 1 / m1, w2 = 1 / m2;
      var lam = ((S.m1.y + S.m2.y) - C0) / (w1 + w2);
      S.m1.y -= lam * w1;
      S.m2.y -= lam * w2;
      var vlam = (S.m1.vy + S.m2.vy) / (w1 + w2);
      S.m1.vy -= vlam * w1;
      S.m2.vy -= vlam * w2;
      return { m1: { part: 'joint' }, m2: { part: 'joint' } };
    }
    function jointItems() {
      // 理想滑轮：T = 2m₁m₂g/(m₁+m₂)
      var T = 2 * m1 * m2 * g / (m1 + m2);
      return [
        { id: 'rope', kind: 'rope', body: 'm1', force: [0, T] },
        { id: 'rope', kind: 'rope', body: 'm2', force: [0, T] }
      ];
    }
    return { force: force, project: project, jointItems: jointItems };
  }

  function plankPushLaws(p) {
    var laws = boardBlockLaws({
      m: p.mass, M: p.boardMass, g: p.g, mu1: p.mu1, mu2: p.mu2,
      applied: function (t) { return t < p.tF - 1e-12 ? -p.force : 0; }, tF: p.tF
    });
    laws.math = plankPushMath(p);
    return laws;
  }

  /** 无外力：滑块以初速度滑上木板（plank / plankSmooth） */
  function plankLaws(p) {
    var laws = boardBlockLaws({
      m: p.mass, M: p.plankMass, g: p.g, mu1: p.mu1, mu2: p.mu2 || 0
    });
    laws.math = plankGeom(p);
    return laws;
  }

  function plankPush(p) {
    var q = plankPushMath(p);
    var BW = 1.4, PH = 1.4;                      // 画粗：这是个"长距离"题，薄板在 18px/m 下只有十几像素
    // 木板长度按解析解自动取够：留 1.2 m 余量，保证物块一定能看到"停在板上"
    var Lb = Math.max(3, q.slideMax + BW + 1.2);
    var dur = p.duration;                        // 不再自动截断：滑杆给多长就演示多长
    var yBoard = PH / 2 + 0.001;
    var yBlock = PH + BW / 2 + 0.005;
    var startX = -Lb / 2 + BW / 2;               // 物块左面与木板左端齐平（Δx 从 0 起算）
    var dims = [
      // Δx 量的是「木板左端 → 物块左面」，与课本定义一致；标注放在向上箭头之上避免压字
      { a: 'board', anchorA: [-Lb / 2, 0], b: 'block', anchorB: [-BW / 2, 0], axis: 'x',
        offset: yBlock + BW / 2 + 3.6, label: 'Δx 相对滑动位移' },
      // 理论最小板长：从木板左端量到 L_min 处的固定刻度，物块最后正好停在这里
      { a: 'board', anchorA: [-Lb / 2, 0], b: 'board', anchorB: [-Lb / 2 + q.slideMax, 0],
        axis: 'x', offset: -1.4, label: 'L_min（理论最小板长）' }
    ];
    return {
      title: '板块模型（对木板施加水平恒力）',
      subtitle: q.stalled ? 'F 太小，整体不动'
        : q.together ? 'F 恰好使两者一起运动（F = ' + q.Fcrit.toFixed(1) + ' N 为临界）'
        : 'F > 临界值 → 相对滑动：板跑得快，物块被摩擦拖着走',
      tags: ['板块', '相对滑动', '摩擦力', '牛顿第二定律'],
      meta: {
        g: p.g, duration: dur, dt: 1 / 60, subSteps: 8,
        frictionPairs: [
          { a: 'block', b: 'board', friction: p.mu1 },
          { a: 'board', b: 'ground', friction: p.mu2 }
        ]
      },
      view: { height: 560 },
      bodies: [
        { id: 'ground', type: 'static', shape: { kind: 'box', w: 120, h: 0.2 },
          at: [-30, -0.1], friction: p.mu2, label: '地面', showForces: false },
        { id: 'board', type: 'dynamic', shape: { kind: 'box', w: Lb, h: PH }, at: [0, yBoard],
          mass: p.boardMass, friction: p.mu1, restitution: 0, label: '木板 M', color: '#5fa8ff', showForces: true },
        { id: 'block', type: 'dynamic', shape: { kind: 'box', w: BW, h: BW }, at: [startX, yBlock],
          mass: p.mass, friction: p.mu1, restitution: 0, label: '物块 m', color: '#e8934a', showForces: true }
      ],
      joints: [],
      // 恒力作用 t_F 秒后撤去（world.js 的 from/until 支持）
      forces: [{ kind: 'constant', body: 'board', force: [-p.force, 0], until: p.tF, label: 'F' }],
      dimensions: dims,
      // 自研 Verlet 后端的受力律（声明了它，这个模型就能不用 planck 跑）
      laws: plankPushLaws(p),
      // 临界时刻：时间轴在这些时刻断开一点，鼠标移上去弹出物理说明
      markers: [
        { t: p.tF, label: '撤去 F',
          note: '撤去 F 的瞬间：木板 ' + q.vBoard.toFixed(2) + ' m/s、物块 ' + q.vBlock.toFixed(2) +
            ' m/s，相对速率 ' + q.vRel.toFixed(2) + ' m/s。此后木板只受两个"刹车"力——物块对它的摩擦 ' +
            q.f1.toFixed(1) + ' N + 地面摩擦 ' + q.f2.toFixed(1) + ' N，减速度 a₂′ = (' +
            q.f1.toFixed(1) + '+' + q.f2.toFixed(1) + ')/' + p.boardMass.toFixed(1) + ' = ' + q.aBoard2.toFixed(2) +
            ' m/s²；物块仍被摩擦推着加速 a₁′ = ' + q.aBlock2.toFixed(2) + ' m/s²。' },
        q.tClose > 0.02 ? { t: q.tStop, label: '刚好共速',
          note: '两者达到共同速度（相对速度归零）的瞬间，摩擦力方向随之改变，此后一起运动。' +
            '这一刻相对滑动位移达到最大值 ' + q.slideMax.toFixed(2) +
            ' m，正好就是第(3)问的最小板长 L_min = ' + q.slideMax.toFixed(2) + ' m。' +
            '撤去 F 到这一刻，相对速度以 a_rel = a₁′ + |a₂′| = ' + q.aBlock2.toFixed(2) + ' + ' +
            Math.abs(q.aBoard2).toFixed(2) + ' = ' + (q.aBlock2 + Math.abs(q.aBoard2)).toFixed(2) +
            ' m/s² 收敛，用了 ' + q.tClose.toFixed(2) + ' s，又滑了 ' + q.slide2.toFixed(2) + ' m。' } : null
      ].filter(Boolean),
      notes: '解析：临界 F₀ = (M+m)μ₁g + μ₂(M+m)g = ' + q.Fcrit.toFixed(1) + ' N；' +
        '相对滑动位移 Δx(t_F) = ' + q.slideAtTF.toFixed(2) + ' m，最大 ' + q.slideMax.toFixed(2) + ' m（= 最小板长 L_min）'
    };
  }

  plankPush.expect = function (p) {
    var q = plankPushMath(p);
    var F = p.force;
    var fwd = [-1, 0];                                  // F 指向 −x，取它为"正方向"
    var wAct = [0.15, Math.max(0.3, p.tF - 0.1)];       // 力的作用阶段
    var wAfter = [p.tF + 0.1, p.tF + Math.max(0.2, q.tClose * 0.6)];
    // "撤去 F 的时刻"要留半帧余量：帧时刻是 1/60 的整数倍，浮点累加后会略大于 tF，
    // 若窗口上界正好取 tF，最后一帧会被 >t1 排除掉，测出来的速率正好少一帧（偏低 0.83%）。
    var wTF = [Math.max(0, p.tF - 0.1), p.tF + 1 / 120];
    var items = [
      { label: '物块加速度 a₁ = μ₁g（' + (q.together ? '一起运动，实为共同加速度' : '相对滑动') + '）',
        unit: 'm/s²', value: q.aBlock,
        probe: { kind: 'accel', body: 'block', project: fwd, signed: true, window: wAct } },
      { label: '木板加速度 a₂ = (F − μ₁mg − μ₂(M+m)g)/M', unit: 'm/s²', value: q.aBoard,
        probe: { kind: 'accel', body: 'board', project: fwd, signed: true, window: wAct } },
      { label: '撤去 F 时相对滑动位移 Δx', unit: 'm', value: q.slideAtTF,
        probe: { kind: 'relative', body: 'block', ref: 'board', relativeTo: 'initial',
                 project: [1, 0], signed: true, window: wTF, reduce: 'last', tolerance: 0.01 } }
    ];
    // 演示时长够长时，末帧就是"最大相对滑动位移 = 最小板长"；缩短时长时按解析式给出该时刻的值
    var endsAfterStop = p.duration >= q.tStop - 1e-9;
    items.push({
      label: endsAfterStop ? '最大相对滑动位移 = 最小板长 L_min' : '演示结束时的相对滑动位移',
      unit: 'm', value: endsAfterStop ? q.slideMax : q.slideAt(p.duration),
      probe: { kind: 'relative', body: 'block', ref: 'board', relativeTo: 'initial',
               project: [1, 0], signed: true, window: [0, 1e9], reduce: 'last', tolerance: 0.01 }
    });
    if (q.slide2 > 0.01 && p.duration > p.tF + 0.2) {
      items.push({ label: '撤去 F 后木板的减速度', unit: 'm/s²', value: -q.aBoard2,
        probe: { kind: 'accel', body: 'board', project: fwd, signed: true, window: wAfter, tolerance: 0.05 } });
      items.push({ label: '撤去 F 后物块的加速度（仍沿原方向）', unit: 'm/s²', value: q.aBlock2,
        probe: { kind: 'accel', body: 'block', project: fwd, signed: true, window: wAfter, tolerance: 0.05 } });
    }
    items.push({ label: '撤去 F 时木板速率 v₂ = a₂·t_F', unit: 'm/s', value: q.vBoard,
      probe: { kind: 'velocity', body: 'board', mode: 'mag', window: wTF, reduce: 'last', tolerance: 0.005 } });
    items.push({ label: '撤去 F 时物块速率 v₁ = a₁·t_F', unit: 'm/s', value: q.vBlock,
      probe: { kind: 'velocity', body: 'block', mode: 'mag', window: wTF, reduce: 'last', tolerance: 0.005 } });
    return items;
  };

  // =============================================================== 5. 连接体（水平拉）
  function connector(p) {
    var m1 = p.mass1, m2 = p.mass2, F = p.force, ropeL = 0.9;
    var a = F / (m1 + m2);
    var T = m2 * a;
    var x1 = -1.6, x2 = x1 + ropeL + 0.3 + 0.3;
    return {
      title: '连接体（绳连接、水平拉力）',
      subtitle: '光滑水平面上两物块用轻绳连接，外力 F 拉动',
      tags: ['连接体', '绳张力', '牛顿第二定律'],
      meta: { g: p.g, duration: p.duration, dt: 1 / 60, subSteps: 4 },
      view: { height: 560 },
      bodies: [
        { id: 'ground', type: 'static', shape: { kind: 'box', w: 30, h: 0.4 }, at: [0, -0.2], friction: 0, label: '光滑地面' },
        { id: 'A', type: 'dynamic', shape: { kind: 'box', w: 0.6, h: 0.6 }, at: [x1, 0.301],
          mass: m1, friction: 0, label: 'm₁', color: '#e8934a', showForces: true },
        { id: 'B', type: 'dynamic', shape: { kind: 'box', w: 0.6, h: 0.6 }, at: [x2, 0.301],
          mass: m2, friction: 0, label: 'm₂', color: '#5fa8ff', showForces: true }
      ],
      joints: [
        { kind: 'rod', a: 'A', b: 'B', worldAnchorA: [x1 + 0.3, 0.3], worldAnchorB: [x2 - 0.3, 0.3], length: ropeL, id: 'rope' }
      ],
      forces: [{ kind: 'constant', body: 'B', force: [F, 0], at: [0.3, 0], label: 'F' }],
      notes: '解析：a = F/(m₁+m₂)，绳张力 T = m₁a（绳拉着后面的 m₁）',
      laws: connectorLaws(p)
    };
  }

  connector.expect = function (p) {
    var a = p.force / (p.mass1 + p.mass2);
    return [
      { label: '整体加速度 a = F/(m₁+m₂)', unit: 'm/s²', value: a,
        probe: { kind: 'accel', body: 'A', project: [1, 0], signed: true, window: [0.2, 1e9] } },
      { label: '绳张力 T = m₁a', unit: 'N', value: p.mass1 * a,
        probe: { kind: 'force', body: 'A', comp: 'joint', project: [1, 0], signed: true, window: [0.2, 1e9] } }
    ];
  };

  // =============================================================== 6. Atwood 机（滑轮）
  function atwoodGeom(p) {
    var a = (p.mass1 - p.mass2) * p.g / (p.mass1 + p.mass2);   // 有符号：>0 表示 m₁ 下落
    var travel = 0.5 * Math.abs(a) * p.duration * p.duration;
    var y0 = travel + 0.8;
    var top = y0 + travel + 1.0;
    return { a: a, travel: travel, y0: y0, top: top, w: [0.15, Math.max(0.25, Math.min(0.6 * p.duration, 0.9 * p.duration))] };
  }
  function atwood(p) {
    var m1 = p.mass1, m2 = p.mass2, g = p.g;
    var q = atwoodGeom(p);
    return {
      title: '滑轮连接体（Atwood 机）',
      subtitle: '轻绳跨过定滑轮连接两个物块，绳长约束 lengthA + lengthB = 常数',
      tags: ['滑轮', '连接体', '绳张力'],
      meta: { g: g, duration: p.duration, dt: 1 / 60, subSteps: 4 },
      view: { height: 620 },
      bodies: [
        { id: 'm1', type: 'dynamic', shape: { kind: 'box', w: 0.6, h: 0.6 }, at: [-0.7, q.y0],
          mass: m1, label: 'm₁=' + m1 + 'kg', color: '#e8934a', showForces: true },
        { id: 'm2', type: 'dynamic', shape: { kind: 'box', w: 0.6, h: 0.6 }, at: [0.7, q.y0],
          mass: m2, label: 'm₂=' + m2 + 'kg', color: '#5fa8ff', showForces: true },
        { id: 'pulleyMark', type: 'static', shape: { kind: 'circle', r: 0.2 }, at: [0, q.top],
          label: '定滑轮', color: '#8899bb', showForces: false }
      ],
      joints: [{
        kind: 'pulley', id: 'pulley', a: 'm1', b: 'm2',
        groundAnchorA: [-0.7, q.top], groundAnchorB: [0.7, q.top],
        worldAnchorA: [-0.7, q.y0], worldAnchorB: [0.7, q.y0],
        lengthA: q.top - q.y0, lengthB: q.top - q.y0, ratio: 1
      }],
      laws: atwoodLaws(p),
      notes: '解析：a = (m₁−m₂)g/(m₁+m₂)，T = 2m₁m₂g/(m₁+m₂)。' +
             '几何按行程自动展开，避免某一侧绳长趋于 0 时滑轮退化。'
    };
  }

  atwood.expect = function (p) {
    var m1 = p.mass1, m2 = p.mass2, g = p.g;
    var q = atwoodGeom(p);
    var T = 2 * m1 * m2 * g / (m1 + m2);
    return [
      { label: 'm₁ 的竖直加速度（向下为正）', unit: 'm/s²', value: q.a,
        probe: { kind: 'accel', body: 'm1', project: [0, -1], signed: true, window: q.w, tolerance: 0.01 } },
      { label: 'm₂ 的竖直加速度（向上为正）', unit: 'm/s²', value: q.a,
        probe: { kind: 'accel', body: 'm2', project: [0, 1], signed: true, window: q.w, tolerance: 0.01 } },
      { label: '绳张力 T（作用在 m₁，向上）', unit: 'N', value: T,
        probe: { kind: 'force', body: 'm1', comp: 'joint', project: [0, 1], signed: true, window: q.w, tolerance: 0.01 } },
      { label: '绳张力 T（作用在 m₂，向上）', unit: 'N', value: T,
        probe: { kind: 'force', body: 'm2', comp: 'joint', project: [0, 1], signed: true, window: q.w, tolerance: 0.01 } }
    ];
  };

  // =============================================================== 7. 弹簧振子
  function spring(p) {
    var m = p.mass, k = p.k, A = p.amplitude;
    var wallX = -3.0, rest = 2.0;
    var x0 = wallX + rest + A;
    return {
      title: '弹簧振子（简谐运动）',
      subtitle: '水平光滑面，弹簧一端固定于墙',
      tags: ['简谐运动', '弹簧', '胡克定律'],
      meta: { g: p.g, duration: Math.max(p.duration, 2.2 * 2 * Math.PI * Math.sqrt(m / k)), dt: 1 / 60, subSteps: 4 },
      view: { height: 460 },
      bodies: [
        { id: 'ground', type: 'static', shape: { kind: 'box', w: 30, h: 0.4 }, at: [0, -0.2], friction: 0, label: '光滑地面' },
        { id: 'wall', type: 'static', shape: { kind: 'box', w: 0.3, h: 1.6 }, at: [wallX - 0.15, 0.8], friction: 0, label: '墙', color: '#3a4a63', showForces: false },
        { id: 'cart', type: 'dynamic', shape: { kind: 'box', w: 0.7, h: 0.7 }, at: [x0, 0.351],
          mass: m, friction: 0, label: '滑块 m', color: '#e8934a', showForces: true }
      ],
      joints: [],
      forces: [{
        kind: 'spring', a: 'world', b: 'cart', worldAnchorA: [wallX, 0.35], anchorB: [0, 0],
        rest: rest, k: k, c: p.damping || 0, label: '弹力 F = −kx'
      }],
      notes: '解析：T = 2π√(m/k)，v_max = Aω，a_max = Aω²',
      laws: springLaws(p)
    };
  }

  spring.expect = function (p) {
    var m = p.mass, k = p.k, A = p.amplitude;
    var w = Math.sqrt(k / m);
    return [
      { label: '周期 T = 2π√(m/k)', unit: 's', value: 2 * Math.PI / w,
        probe: { kind: 'period', body: 'cart', project: [1, 0], center: -1.0, tolerance: 0.01 } },
      { label: '最大回复力 kA', unit: 'N', value: k * A,
        probe: { kind: 'force', body: 'cart', comp: 'applied', project: [1, 0], mode: 'mag', reduce: 'max', window: [0, 1e9], tolerance: 0.02 } }
    ];
  };

  // 注册表
  // =============================================================== 8. E_p–x 势能曲线滑块（电场 + 摩擦）
  // 题（图甲）：绝缘水平面上带负电的滑块；E_p–x 图线最低点 P(3 m, 2 J)，x = 1 m 处 E_p = 4 J
  //（P 左侧较缓、右侧较陡）。滑块从 x = 1 m 以 v = 2 m/s 沿 +x 出发，μ = 0.1、g = 10 m/s²。
  //
  // 选定解析式（与图甲一致，逐点值写进 notes）：
  //     x ≤ 3 m：E_p = 0.5·(x−3)² + 2      （k₁ = 0.5 J/m²，由 E_p(1) = 4 J 定：4k₁ + 2 = 4）
  //     x > 3 m：E_p = 2.0·(x−3)² + 2      （k₂ = 2.0 J/m²，右支更陡 ⇒ E_p(4) = 4 J）
  //     E_p(1) = 4 J、E_p(3) = 2 J（最低点 P）、E_p(4) = 4 J
  // 两段在 x = 3 处**值与一阶导都连续**（dE/dx = 0）⇒ 电场力连续，不需要切步事件。
  var PW_K1 = 0.5, PW_K2 = 2.0, PW_XP = 3, PW_EPMIN = 2;
  function pwEp(x) { var d = x - PW_XP; return (x <= PW_XP ? PW_K1 : PW_K2) * d * d + PW_EPMIN; }
  function pwDEdx(x) { var d = x - PW_XP; return 2 * (x <= PW_XP ? PW_K1 : PW_K2) * d; }

  /**
   * 解析量 + **与渲染引擎相互独立的**特征时间积分（只用来定演示时长，交给 lib/pacing.js）。
   *   · 左支 E_p = ½k(x−3)² + 2 ⇒ F_e = 2k₁(3−x) = (3−x) N（k₁ = 0.5 N/m），净力零点 x_N = 3 − μmg/k
   *   · x = 1→3 的电场功 ∫F_e dx = 2 J、摩擦功 −μmg·2 m = −2 J ⇒ ΔEk = 0（v(3) 仍是 2 m/s）
   * 积分用半隐式欧拉 h = 1e-4 s，摩擦判据与 laws 里**同一套**：滑动 ⇒ f = μmg 逆速度；
   * 速度过零且 |F_e| ≤ μmg ⇒ 静摩擦咬住、停住（这正是"最后停在哪"的判据）。
   */
  var PW_H = 1e-4, PW_MAXSTEP = 400000;    // 40 s 上限：正常参数 3.4 s 内停下
  function pwMath(p) {
    var m = p.mass, g = p.g, mu = p.mu;
    var N = m * g, fMax = mu * N;
    var x0 = 1.0, v0 = 2.0;
    var xMin = 0.6, xMax = 4.6;
    var kN = 2 * PW_K1;                               // 左支劲度（N/m）
    var xN = PW_XP - fMax / kN;                       // 净力为零处：x < 3 m（x=3 处 F_e = 0，不是它）
    // v²(b) = v₀² + (2/m)∫(F_e − f)dx，左支 F_e − f = kN(x_N − x) ⇒ ∫ₐᵇ = x_N(b−a) − (b²−a²)/2
    function intLeft(a, b) { return xN * (b - a) - (b * b - a * a) / 2; }
    var peakInside = xN > x0;                          // 净力零点在起点右侧才有加速段
    var vMax = peakInside ? Math.sqrt(v0 * v0 + (2 * kN / m) * intLeft(x0, xN)) : v0;
    var vAt3 = Math.sqrt(Math.max(0, v0 * v0 + (2 * kN / m) * intLeft(x0, PW_XP)));

    var x = x0, v = v0, t = 0, guard = 0;
    var out = { tX2: null, tX3: null, tStop: null, xStop: null, xReach: x0 };
    for (;;) {
      if (guard++ > PW_MAXSTEP) {
        throw new Error('potentialWellBlock: 特征时间积分在 ' + (PW_MAXSTEP * PW_H).toFixed(0) +
          ' s 内没有停下（x = ' + x + ' m、v = ' + v + ' m/s、μ = ' + mu + '、m = ' + m +
          '）—— μ 太小则滑块长时间来回振荡，请调大 μ');
      }
      var fe = -pwDEdx(x);
      var f;
      if (Math.abs(v) > 1e-9) f = fe - (v > 0 ? 1 : -1) * fMax;
      else if (Math.abs(fe) <= fMax) { out.tStop = t; out.xStop = x; break; }
      else f = fe - (fe > 0 ? 1 : -1) * fMax;
      var vNew = v + (f / m) * PW_H;
      var xNew = x + vNew * PW_H;
      if (out.tX2 === null && x < 2 && xNew >= 2) out.tX2 = t + (2 - x) / (xNew - x) * PW_H;
      if (out.tX3 === null && x < PW_XP && xNew >= PW_XP) out.tX3 = t + (PW_XP - x) / (xNew - x) * PW_H;
      if (xNew > out.xReach) out.xReach = xNew;
      // 速度过零：|F_e| ≤ μmg ⇒ 静摩擦咬住（停住）；否则是折返点，继续动
      if (v * vNew < 0 && Math.abs(-pwDEdx(xNew)) <= fMax) { out.tStop = t + PW_H; out.xStop = xNew; break; }
      x = xNew; v = vNew; t += PW_H;
    }
    return { m: m, g: g, mu: mu, N: N, fMax: fMax, x0: x0, v0: v0, xMin: xMin, xMax: xMax,
             kN: kN, xN: xN, vMax: vMax, vAt3: vAt3, Ep: pwEp, dEp: pwDEdx,
             Fe: function (xx) { return -pwDEdx(xx); }, t: out };
  }

  /**
   * 受力律：电场力来自 **lib/forces.js 的 potentialCurve 组件**（力/势能成对，见 §8 配方），
   * 摩擦与支持力是水平面上的常量项（verlet 路径没有接触求解器，N 必须显式给否则物块会掉下去）。
   *   · potentialCurve 的 part 传 'electric'：本题的 E_p 曲线就是电场势能 ⇒ 力箭头显示"电场力 F电"；
   *   · lock(S) 把本子步的摩擦分支钉住（滑动方向 / 静摩擦咬住），F1/F2 沿用同一分支；
   *   · project 只在"速度已很小且静摩擦咬得住"时把 v 归零，并按 §2 约定 2 返回 friction 分类记账。
   */
  function pwLaws(p, M) {
    var m = p.mass, g = p.g, fMax = M.fMax;
    var curveComp = forceLib.potentialCurve({
      body: 'block', curve: M.Ep, dEdx: M.dEp, xMin: M.xMin, xMax: M.xMax,
      part: 'electric', id: 'potentialCurve:block'
    });
    function feOf(x) { return -pwDEdx(x); }
    function branch(S, lock) {
      if (lock && lock.slidingSign != null) return lock.slidingSign;   // 0 = 静摩擦咬住
      var b = S.block;
      if (!b) throw new Error('potentialWellBlock: 状态里没有 block 刚体（现有 ' +
        (S ? Object.keys(S).join(',') : '(空)') + '）');
      if (Math.abs(b.vx) > 1e-9) return b.vx > 0 ? 1 : -1;
      var fe = feOf(b.x);
      return Math.abs(fe) <= fMax ? 0 : (fe > 0 ? 1 : -1);
    }
    var c = forceLib.composeForces([
      forceLib.gravity({ body: 'block', m: m, g: g }),
      curveComp,
      { id: 'pwNormal:block', part: 'normal', body: 'block',
        potential: function () { return 0; },                 // 支持力不做功、不进势能
        force: function () { return [0, m * g]; } },          // 水平面 ⇒ N = mg（抵消重力）
      { id: 'pwFriction:block', part: 'friction', body: 'block',
        potential: function () { return 0; },                 // 摩擦耗散，不是势能
        force: function (ctx) {
          var b = ctx.S.block;
          var sign = branch(ctx.S, ctx.lock);
          if (sign === 0) return [-feOf(b.x), 0];             // 静摩擦：恰好平衡电场力 ⇒ 合力 0
          return [-sign * fMax, 0];                           // 动摩擦：逆速度，|f| = μmg
        } }
    ]);
    return {
      force: c.force,
      potential: c.potential,
      lock: function (S) {
        if (!S.block) return null;
        return { slidingSign: branch(S, null) };
      },
      project: function (t, S) {
        var b = S.block;
        if (!b || b.vx === 0) return null;
        if (Math.abs(b.vx) > 5e-3) return null;               // 还在明显滑动
        if (Math.abs(feOf(b.x)) > fMax) return null;          // 静摩擦咬不住 ⇒ 必须继续动
        b.vx = 0;
        return { block: { part: 'friction' } };               // 冲量 m·Δv 记进 friction 分项
      },
      _components: c
    };
  }

  function potentialWellBlock(p) {
    var M = pwMath(p);
    // 时长按**数值特征时间**（滑块从出发到被摩擦停住的总时间）定，交给 lib/pacing.js
    var pace = pacing({ tTotal: M.t.tStop, frames: 600, subSteps: 8 });
    assertResolution({ duration: pace.duration, characteristicTime: Math.max(pace.dt / pace.subSteps, 1e-12),
                       frames: pace.frames, minFramesPerChar: 50 });
    // 视图按尺度自适应：地面宽度由"实际走过的范围"反推，换 μ / m 时画面自动重新取景
    var lo = M.x0 - 1.2, hi = Math.max(M.t.xReach, PW_XP) + 0.8;
    var BW = 0.34;
    var notes = '解析：E_p(x) = 0.5(x−3)² + 2（x ≤ 3 m）、E_p(x) = 2.0(x−3)² + 2（x > 3 m）；' +
      'E_p(1) = ' + M.Ep(1).toFixed(2) + ' J、E_p(3) = ' + M.Ep(3).toFixed(2) + ' J（最低点 P）、E_p(4) = ' +
      M.Ep(4).toFixed(2) + ' J。F_e = −dE_p/dx，f = μmg = ' + M.fMax.toFixed(2) + ' N。' +
      'x=1→3 m：电场做功 +2 J、摩擦做功 −2 J ⇒ ΔEk = 0 ⇒ v(3) = ' + M.vAt3.toFixed(3) + ' m/s。' +
      '速度最大点在 x_N = ' + M.xN.toFixed(3) + ' m（< 3 m，由 F_e = f 定）；x = 3 m 处 F_e = 0，' +
      '那里合力 = −f 仍在减速 ⇒ 最大速率点不是图线最低点。' +
      '特征时间（数值积分）：过 x=2 m 用 ' + (M.t.tX2 == null ? '—' : M.t.tX2.toFixed(3)) +
      ' s、过 x=3 m 用 ' + (M.t.tX3 == null ? '—' : M.t.tX3.toFixed(3)) +
      ' s、停在 x = ' + M.t.xStop.toFixed(3) + ' m 用 ' + M.t.tStop.toFixed(3) + ' s。';
    return {
      title: 'E_p–x 势能曲线：电场中的滑块',
      subtitle: '绝缘水平面 + 带负电滑块：E_p(x) 图给定电场，μ = ' + p.mu + '、v₀ = 2 m/s',
      tags: ['势能曲线', '电场力', '摩擦力', '能量守恒'],
      meta: { g: p.g, duration: pace.duration, dt: pace.dt, subSteps: pace.subSteps },
      view: { height: 560 },
      bodies: [
        { id: 'ground', type: 'static', shape: { kind: 'box', w: hi - lo, h: 0.3 },
          at: [(hi + lo) / 2, -0.15], friction: p.mu, color: '#41506b', showForces: false,
          label: '绝缘水平面 μ=' + p.mu },
        { id: 'block', type: 'dynamic', shape: { kind: 'box', w: BW, h: BW }, at: [M.x0, BW / 2 + 0.001],
          mass: p.mass, friction: p.mu, velocity: [M.v0, 0], color: '#e8934a', showForces: true,
          label: '滑块 m=' + p.mass + ' kg（带负电）' }
      ],
      markers: [
        { t: M.t.tX2, label: '速度最大 v_max = ' + M.vMax.toFixed(3) + ' m/s',
          note: '净力 F_e − f = 0 的点在 x_N = ' + M.xN.toFixed(3) + ' m（< 3 m）。' +
            'x = 3 m 处 F_e = −dE_p/dx = 0，那里合力 = −f 仍在减速 ⇒ 速度最大点**不是**图线最低点（本题陷阱）。' },
        { t: M.t.tX3, label: '过 x = 3 m（图线最低点）',
          note: 'x = 1→3 m：电场做功 +2 J、摩擦做功 −2 J ⇒ ΔEk = 0，v 仍为 ' + M.vAt3.toFixed(3) +
            ' m/s（此后 F_e 反向、摩擦继续，开始减速）。' }
      ].filter(function (mk) { return mk.t != null && mk.t > 0.01 && mk.t <= pace.duration * 1.001; }),
      notes: notes,
      verletOnly: true,   // planck 侧没有"由势能曲线给定的保守力"（同 §1 的电场力一类），跳过对拍
      laws: pwLaws(p, M)
    };
  }
  potentialWellBlock._math = pwMath;     // 供 node/tests.mjs 取解析量（同 semicircleCoulomb._analytics 的用法）

  potentialWellBlock.expect = function (p) {
    var M = pwMath(p);
    var w3 = [Math.max(0, M.t.tX3 - 0.03), M.t.tX3 + 0.03];
    return [
      { label: '过 x=3 m 时的速率 v = 2 m/s（x=1→3 电场做功 +2 J、摩擦做功 −2 J ⇒ ΔEk = 0）',
        unit: 'm/s', value: M.vAt3, tolerance: 0.01,
        probe: { kind: 'velocity', body: 'block', mode: 'mag', window: w3 } },
      { label: '最大速率 v_max = √5 ≈ 2.236 m/s（出现在 x_N = ' + M.xN.toFixed(3) + ' m < 3 m）',
        unit: 'm/s', value: M.vMax, tolerance: 0.01,
        probe: { kind: 'velocity', body: 'block', mode: 'mag', window: [0, M.t.tX3], reduce: 'max' } },
      { label: 'x=1 m 处电场力 F_e = −dE_p/dx = +2 N（图线下降段 ⇒ 力沿 +x）',
        unit: 'N', value: M.Fe(M.x0), tolerance: 0.01,
        probe: { kind: 'force', body: 'block', comp: 'electric', project: [1, 0], signed: true,
                 window: [0, 0.02], reduce: 'first' } },
      { label: 'x=3 m（最低点）处电场力 F_e = 0 ⇒ 速度最大点不可能在 x=3',
        unit: 'N', value: 0, absTolerance: 0.02,
        probe: { kind: 'force', body: 'block', comp: 'electric', project: [1, 0], signed: true, window: w3 } }
    ];
  };

  function register(add) {
    add({
      id: 'incline', title: '斜面滑块', group: '经典力学',
      params: [
        { key: 'theta', label: '倾角 θ', unit: '°', min: 5, max: 70, step: 1, value: 30 },
        { key: 'mass', label: '物块质量 m', unit: 'kg', min: 0.5, max: 10, step: 0.1, value: 2 },
        { key: 'mu', label: '动摩擦因数 μ', unit: '', min: 0, max: 1.2, step: 0.01, value: 0.2 },
        { key: 'g', label: '重力加速度 g', unit: 'm/s²', min: 9.8, max: 10, step: 0.1, value: 10 },
        { key: 'duration', label: '演示时长', unit: 's', min: 0.5, max: 12, step: 0.5, value: 2.5 }
      ],
      build: incline, expect: incline.expect
    });
    add({
      id: 'inclinePush', title: '斜面 + 水平推力', group: '经典力学',
      params: [
        { key: 'theta', label: '倾角 θ', unit: '°', min: 10, max: 60, step: 1, value: 37 },
        { key: 'mass', label: '物块质量 m', unit: 'kg', min: 0.5, max: 10, step: 0.5, value: 2 },
        { key: 'mu', label: '动摩擦因数 μ', unit: '', min: 0, max: 1, step: 0.05, value: 0.5 },
        { key: 'F', label: '水平推力 F（右为正）', unit: 'N', min: -20, max: 80, step: 5, value: 50 },
        { key: 'g', label: '重力加速度 g', unit: 'm/s²', min: 9.8, max: 10, step: 0.1, value: 10 },
        { key: 'duration', label: '演示时长', unit: 's', min: 0.5, max: 3, step: 0.1, value: 1.2 }
      ],
      build: inclinePush, expect: inclinePush.expect
    });
    add({
      id: 'freefall', title: '自由落体', group: '经典力学',
      params: [
        { key: 'height', label: '下落高度 h', unit: 'm', min: 1, max: 40, step: 1, value: 5 },
        { key: 'mass', label: '质量 m', unit: 'kg', min: 0.1, max: 10, step: 0.1, value: 1 },
        { key: 'g', label: '重力加速度 g', unit: 'm/s²', min: 9.8, max: 10, step: 0.1, value: 10 },
        { key: 'duration', label: '演示时长', unit: 's', min: 0.5, max: 5, step: 0.5, value: 2.5 }
      ],
      build: freefall, expect: freefall.expect
    });
    add({
      id: 'belt', title: '传送带模型', group: '经典力学',
      params: [
        { key: 'v', label: '带速 v', unit: 'm/s', min: -8, max: 8, step: 0.5, value: 4 },
        { key: 'v0', label: '物块初速度', unit: 'm/s', min: -8, max: 8, step: 0.5, value: 0 },
        { key: 'mu', label: '动摩擦因数 μ', unit: '', min: 0.05, max: 1, step: 0.05, value: 0.3 },
        { key: 'mass', label: '物块质量 m', unit: 'kg', min: 0.5, max: 10, step: 0.5, value: 2 },
        { key: 'g', label: '重力加速度 g', unit: 'm/s²', min: 9.8, max: 10, step: 0.1, value: 10 },
        { key: 'duration', label: '演示时长', unit: 's', min: 0.5, max: 12, step: 0.5, value: 3 }
      ],
      build: belt, expect: belt.expect
    });
    add({
      id: 'plank', title: '板块模型', group: '经典力学',
      params: [
        { key: 'v0', label: '滑块初速度 v₀', unit: 'm/s', min: 1, max: 12, step: 0.5, value: 6 },
        { key: 'mass', label: '滑块质量 m', unit: 'kg', min: 0.5, max: 10, step: 0.5, value: 2 },
        { key: 'plankMass', label: '木板质量 M', unit: 'kg', min: 0.5, max: 10, step: 0.5, value: 3 },
        { key: 'mu1', label: '滑块-木板 μ₁', unit: '', min: 0.05, max: 1, step: 0.05, value: 0.4 },
        { key: 'mu2', label: '木板-地面 μ₂', unit: '', min: 0, max: 0.5, step: 0.05, value: 0 },
        { key: 'g', label: '重力加速度 g', unit: 'm/s²', min: 9.8, max: 10, step: 0.1, value: 10 },
        { key: 'duration', label: '演示时长', unit: 's', min: 0.5, max: 12, step: 0.5, value: 2 }
      ],
      build: plank, expect: plank.expect
    });
    // 题图变体：光滑地面 + 小尺度（最小板长只有 9 cm 那种题）。
    // 物理与 plank 完全同一套公式，只是 μ₂ 固定为 0、几何按解析滑动距离等比缩小。
    add({
      id: 'plankSmooth', title: '板块模型·光滑地面（滑块滑上木板）', group: '经典力学',
      params: [
        { key: 'v0', label: '滑块初速度 v₀', unit: 'm/s', min: 0.2, max: 3, step: 0.1, value: 1.2 },
        { key: 'mass', label: '滑块质量 m', unit: 'kg', min: 0.1, max: 2, step: 0.1, value: 0.2 },
        { key: 'plankMass', label: '木板质量 M', unit: 'kg', min: 0.1, max: 2, step: 0.1, value: 0.2 },
        { key: 'mu1', label: '滑块-木板 μ₁', unit: '', min: 0.1, max: 0.8, step: 0.05, value: 0.4 },
        { key: 'g', label: '重力加速度 g', unit: 'm/s²', min: 9.8, max: 10, step: 0.1, value: 10 },
        { key: 'blockSize', label: '滑块边长（画图用）', unit: 'm', min: 0.01, max: 0.1, step: 0.005, value: 0.027 },
        { key: 'duration', label: '演示时长', unit: 's', min: 0.1, max: 2, step: 0.05, value: 0.3 }
      ],
      build: plank, expect: plank.expect
    });
    add({
      id: 'plankPush', title: '板块模型（拉木板·限时力）', group: '经典力学',
      params: [
        { key: 'force', label: '水平恒力 F', unit: 'N', min: 4, max: 60, step: 1, value: 26 },
        { key: 'tF', label: 'F 作用时长', unit: 's', min: 0.5, max: 4, step: 0.5, value: 2 },
        { key: 'mass', label: '物块质量 m', unit: 'kg', min: 0.5, max: 10, step: 0.5, value: 2 },
        { key: 'boardMass', label: '木板质量 M', unit: 'kg', min: 0.5, max: 10, step: 0.5, value: 3 },
        { key: 'mu1', label: '物块-木板 μ₁', unit: '', min: 0.05, max: 1, step: 0.05, value: 0.3 },
        { key: 'mu2', label: '木板-地面 μ₂', unit: '', min: 0, max: 0.5, step: 0.05, value: 0.1 },
        { key: 'g', label: '重力加速度 g', unit: 'm/s²', min: 9.8, max: 10, step: 0.1, value: 10 },
        { key: 'duration', label: '演示时长', unit: 's', min: 2, max: 12, step: 0.5, value: 4 }
      ],
      build: plankPush, expect: plankPush.expect
    });
    add({
      id: 'connector', title: '连接体（绳+拉力）', group: '经典力学',
      params: [
        { key: 'force', label: '拉力 F', unit: 'N', min: 1, max: 60, step: 1, value: 12 },
        { key: 'mass1', label: 'm₁', unit: 'kg', min: 0.5, max: 10, step: 0.5, value: 2 },
        { key: 'mass2', label: 'm₂', unit: 'kg', min: 0.5, max: 10, step: 0.5, value: 3 },
        { key: 'g', label: '重力加速度 g', unit: 'm/s²', min: 9.8, max: 10, step: 0.1, value: 10 },
        { key: 'duration', label: '演示时长', unit: 's', min: 0.5, max: 5, step: 0.5, value: 2 }
      ],
      build: connector, expect: connector.expect
    });
    add({
      id: 'atwood', title: '滑轮连接体（Atwood）', group: '经典力学',
      params: [
        { key: 'mass1', label: 'm₁', unit: 'kg', min: 0.5, max: 10, step: 0.5, value: 3 },
        { key: 'mass2', label: 'm₂', unit: 'kg', min: 0.5, max: 10, step: 0.5, value: 1.5 },
        { key: 'g', label: '重力加速度 g', unit: 'm/s²', min: 9.8, max: 10, step: 0.1, value: 10 },
        { key: 'duration', label: '演示时长', unit: 's', min: 0.5, max: 4, step: 0.5, value: 1.5 }
      ],
      build: atwood, expect: atwood.expect
    });
    add({
      id: 'spring', title: '弹簧振子', group: '经典力学',
      params: [
        { key: 'k', label: '劲度系数 k', unit: 'N/m', min: 20, max: 600, step: 10, value: 200 },
        { key: 'mass', label: '质量 m', unit: 'kg', min: 0.2, max: 5, step: 0.1, value: 1 },
        { key: 'amplitude', label: '振幅 A', unit: 'm', min: 0.1, max: 1.5, step: 0.1, value: 0.8 },
        { key: 'damping', label: '阻尼 c', unit: 'N·s/m', min: 0, max: 6, step: 0.1, value: 0 },
        { key: 'g', label: '重力加速度 g', unit: 'm/s²', min: 9.8, max: 10, step: 0.1, value: 10 },
        { key: 'duration', label: '演示时长', unit: 's', min: 1, max: 8, step: 0.5, value: 2.5 }
      ],
      build: spring, expect: spring.expect
    });
    add({
      id: 'potentialWellBlock', title: 'E_p–x 势能曲线滑块（电场+摩擦）', group: '经典力学',
      params: [
        { key: 'mass', label: '滑块质量 m', unit: 'kg', min: 0.5, max: 2, step: 0.1, value: 1 },
        { key: 'mu', label: '动摩擦因数 μ', unit: '', min: 0.05, max: 0.25, step: 0.01, value: 0.1 },
        { key: 'g', label: '重力加速度 g', unit: 'm/s²', min: 9.8, max: 10, step: 0.1, value: 10 }
      ],
      build: potentialWellBlock, expect: potentialWellBlock.expect
    });
  }

  return { register: register };
});
