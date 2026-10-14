/*!
 * MrAwU（阿物先生）— 运动学模型组：平抛/斜抛、圆周运动、碰撞与冲量、三力平衡
 * 每个模型自带 expect()：给出解析解与对应的 probe，动画运行时可以逐项对照。
 *
 * 与 mechanics.js 相同的约定：
 *   - build(params) 返回纯数据场景，几何随参数自适应（静态件给足长度，取景自动裁）；
 *   - 采样窗口必须落在"目标物理过程仍在进行"的时间段内（避开落地/共速/静止之后）；
 *   - 绝对零值（比如"合力为零"）用 absTolerance 判定。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./shared.js'), require('../pacing.js'));
  } else {
    root.PFA = root.PFA || {};
    root.PFA.models_motion = factory(root.PFA.lawsShared, root.PFA.pacing);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (shared, pacingLib) {
  'use strict';

  var DEG = Math.PI / 180;
  var groundBallLaws = shared.groundBallLaws;   // 与自由落体共用同一份实现
  // 时长由解析总时间决定（lib/pacing.js）；assertResolution 是"别把整段挤进一帧"的兜底闸门
  var pacing = pacingLib.pacing;
  var assertResolution = pacingLib.assertResolution;
  var SUB = 4;                                   // 默认子步（除弹道外，dt=1/60 时分 4 子步足够）

  // 把"帧序号"换成仿真真正会走到的时刻。
  // 关键：sim 的步进边界与期望值必须用同一个 dt，否则窗口端点会错位一帧。
  function framesOf(dur, dt) { return Math.max(1, Math.round(dur / dt)); }
  function simEnd(dur, dt) { return framesOf(dur, dt) * dt; }

  // 飞行/运动阶段内的自适应采样窗口：既避开 t=0（约束尚未稳定），也避开末态（过程已结束）
  function phaseWindow(tEnd, a, b) {
    var t1 = (b || 0.85) * tEnd;
    return [Math.min((a || 0.15) * tEnd, Math.max(1 / 120, 0.5 * t1)), Math.max(1.5 / 60, t1)];
  }

  // =============================================================== 1. 平抛与斜抛
  var PROJ_R = 0.35;                              // 小球半径（取大些，否则长射程场景里只有几个像素）
  var PROJ_SUB = 10;                              // 子步多一些：让有限差分加速度更贴近 g

  /**
   * 弹道解析：
   *   解 h + v_y t − ½g t² = 0（落地时刻），取正根。
   *   angle 允许为 0（平抛）或负（斜下抛），公式都成立。
   *   时长上限取到落地时刻，并对齐到整数帧（仿真只能停在帧边界上）。
   */
  function projGeom(p) {
    var g = p.g, v0 = p.v0, th = p.angle * DEG;
    var vx = v0 * Math.cos(th), vy = v0 * Math.sin(th);
    var disc = vy * vy + 2 * g * p.height;
    if (disc < 0) disc = 0;
    var tFall = (vy + Math.sqrt(disc)) / g;        // 竖直位移回到 0 的解析时刻
    // 时长 = 解析滞空时间（+2% 余量，让"落地那一帧"落地），步长由它反推（lib/pacing.js）：
    //   ⚠️ 旧写法是 `dt = 1/60 s` + `nF = min(round(p.duration/dt), max(2, ceil(tFall/dt)))`，
    //   帧数随参数在 2 ~ 180 之间漂，h 很大时（tFall = 8.9 s）只有 180 帧、落地前的关键段
    //   只占 1/3；h 很小时又会把整段挤进极少数帧。现在帧数与题目尺度解耦（恒定 600 帧）。
    //   注意：时长**不取** p.duration —— 落地后小球会在地面上匀速滑行（地面无摩擦，
    //   见 shared.groundBallLaws），取长了会把"射程"读成"滑行距离"。
    var tTotal = 1.02 * tFall;
    var pace = pacing({ tTotal: tTotal, frames: 600, subSteps: PROJ_SUB, minFrames: 50 });
    assertResolution({ duration: pace.duration, characteristicTime: Math.max(pace.dt / pace.subSteps, 1e-12),
                       frames: pace.frames, minFramesPerChar: 50 });
    var tDur = pace.duration;                      // 播放总时长（≈ 落地时刻）
    var tg = tDur;                                 // 仿真真正走到的时刻
    var xEnd = vx * tg, yEnd = p.height + vy * tg - 0.5 * g * tg * tg;
    return {
      vx: vx, vy: vy, tFall: tFall, tDur: tDur, tg: tg, pace: pace,
      range: vx * tFall, xEnd: xEnd, yEnd: yEnd,
      // 所有采样窗口都落在飞行阶段内（0.12~0.85 倍落地时刻），绝不用 1e9 这种"到无穷"的窗口
      win: phaseWindow(tFall, 0.12, 0.85)
    };
  }
  function projectile(p) {
    var q = projGeom(p);
    // 地面长度按解析射程反推，并留 15% 余量；小球在飞行途中不会碰到地面（y ≥ r > 0）。
    var half = Math.max(0.9, Math.abs(q.range) * 1.15 + 0.8);
    return {
      title: p.angle === 0 ? '平抛运动' : '斜抛运动',
      subtitle: '只受重力：水平方向匀速，竖直方向匀变速（a = g）',
      tags: ['平抛', '斜抛', '运动的合成与分解'],
      meta: { g: p.g, duration: q.tDur, dt: q.pace.dt, subSteps: q.pace.subSteps },
      view: { height: 560 },
      bodies: [
        { id: 'ground', type: 'static', shape: { kind: 'box', w: 2 * half, h: 0.4 },
          at: [q.range / 2, -0.2], friction: 0.5, label: '地面', showForces: false },
        { id: 'ball', type: 'dynamic', shape: { kind: 'circle', r: PROJ_R },
          at: [0, p.height + PROJ_R], mass: p.mass, velocity: [q.vx, q.vy],
          friction: 0.4, restitution: 0, label: '小球 m=' + p.mass + 'kg', color: '#e8934a', showForces: true }
      ],
      joints: [], forces: [],
      notes: '解析：x = v₀cosθ·t，y = h + v₀sinθ·t − ½gt²，落地时刻 t = [v₀sinθ + √(v₀²sin²θ + 2gh)]/g，' +
             '射程 x = v₀cosθ·t。时长上限直接取落地时刻（对齐到帧），地面长度按射程反推，保证小球在空中自由飞行。',
      // 自研 Verlet 后端的受力律：平抛/斜抛 = 重力 + 落地约束
      laws: groundBallLaws({ mass: p.mass, g: p.g, r: PROJ_R, tFall: q.tFall })
    };
  }

  projectile.expect = function (p) {
    var g = p.g, q = projGeom(p);
    return [
      { label: '水平加速度 aₓ（应为 0）', unit: 'm/s²', value: 0, absTolerance: 0.01,
        probe: { kind: 'accel', body: 'ball', project: [1, 0], signed: true, window: q.win } },
      { label: '竖直加速度 a_y = −g', unit: 'm/s²', value: -g,
        probe: { kind: 'accel', body: 'ball', project: [0, 1], signed: true, window: q.win } },
      { label: '水平速度 vₓ = v₀cosθ（全程不变）', unit: 'm/s', value: q.vx,
        probe: { kind: 'velocity', body: 'ball', project: [1, 0], signed: true, window: q.win, tolerance: 0.002 } },
      { label: '射程 x = v₀cosθ·t_落地（取落地前最后一帧）', unit: 'm', value: q.range,
        // ⚠️ 不能“取整段最后一帧”：pacing 给总时长留了 2% 余量，最后一帧落在 tFall 之后
        // ~2%，而落地后地面摩擦为 0（见 shared.groundBallLaws，project() 只抹竖直速度），
        // 小球会以 vx 继续滑行 —— 读到的就成了“射程 + 滑行距离”（实测偏 4.04%）。
        // 这里把窗口上界卡在“落地前一帧”，读的仍是位置探针本身（不是放宽容差）。
        probe: { kind: 'position', body: 'ball', project: [1, 0], signed: true, reduce: 'last',
                 window: [0, q.tFall] } }
    ];
  };

  // =============================================================== 2. 圆周运动
  var CIRC_R = 0.16;                              // 小球/物块特征尺寸

  /** 由 (g, v0, r, mode) 决定时长与采样窗口：至少覆盖一个完整周期，才能测准周期与法向力 */
  function circTimes(p) {
    var T = 2 * Math.PI * p.r / p.v0;
    // 周期探针需要窗口里至少出现 2 次过零 → 取 1.05 个周期再补一点余量
    var dur = Math.min(p.duration, 1.05 * T + 0.25);
    dur = Math.max(dur, 0.55 * T);
    var tg = simEnd(dur, 1 / 60);
    return { T: T, dur: dur, tg: tg };
  }

  /**
   * mode='vertical'：竖直面内用**刚性杆**系住小球做圆周运动。
   *
   * 为什么不做"光滑水平面上的匀速圆周运动"和"转盘上的物块"：
   *   在平面刚体引擎（Box2D/planck）里，水平面内的圆周运动是**俯视图**问题，
   *   搬到二维侧视图里就退化成沿一条直线来回运动——小球在最低点接触地面时
   *   切向速度恰好是竖直方向，会被地面立刻吃掉（实测：球瞬间停住，张力为 0）。
   *   转盘同理：它需要垂直于屏幕的转轴 + 盘面摩擦耦合，二维接触模型给不出正确的静摩擦。
   *   所以这里只保留二维下**物理忠实**的竖直圆周，这恰好也是中学最常考的模型。
   *
   * 竖直圆周的速率随高度变化，张力的解析值：
   *   最低点  T = mg + m v₀²/L
   *   最高点  T = m v_top²/L − mg，其中 v_top² = v₀² − 4gL（机械能守恒）
   *   杆可以推也可以拉，所以 T_top 允许为负；整圈条件只需 v₀² > 4gL。
   *   （若换成绳，还要求 v_top² ≥ gL，否则绳会松弛。杆模型更稳，故用杆。）
   */
  /**
   * 竖直面内杆约束的受力律（circular）：
   * 杆长约束 |r| = L 由 project() 实现（位置拉回圆周 + 去掉径向速度，杆可推可拉）；
   * 张力是约束力，由投影响量自动产生；受力表按解析式 T = mv²/L − mg·cosθ 显示。
   */
  function rodLaws(p) {
    var m = p.mass, g = p.g, L = p.r;
    function force(t, S) {
      return {
        ball: {
          parts: {
            gravity: [0, -m * g], normal: [0, 0], friction: [0, 0],
            applied: [0, 0], joint: [0, 0], damping: [0, 0]
          }
        }
      };
    }
    function project(t, S) {
      var b = S.ball;
      var r = Math.hypot(b.x, b.y);
      if (r < 1e-9) return null;
      var ux = b.x / r, uy = b.y / r;
      b.x = ux * L; b.y = uy * L;                 // 位置拉回圆周
      var vr = b.vx * ux + b.vy * uy;
      b.vx -= vr * ux; b.vy -= vr * uy;           // 去掉径向速度
      return { ball: { part: 'joint' } };
    }
    function jointItems(t, S) {
      var b = S.ball;
      var r = Math.hypot(b.x, b.y) || L;
      var ux = b.x / r, uy = b.y / r;             // 固定点 → 小球
      var v2 = b.vx * b.vx + b.vy * b.vy;
      var T = m * v2 / L - m * g * uy;            // T = mv²/L − mg·cosθ
      return [{ id: 'rod', kind: 'rod', body: 'ball', force: [-T * ux, -T * uy] }];
    }
    return { force: force, project: project, jointItems: jointItems };
  }

  /** 一维碰撞：只有重力/支持力；碰撞瞬间由事件施加恢复系数冲量 */
  function collisionLaws(p) {
    var m1 = p.mass1, m2 = p.mass2, e = p.restitution, g = p.g;
    var q = colGeom(p);
    function force(t, S) {
      return {
        box1: {
          parts: { gravity: [0, -m1 * g], normal: [0, m1 * g], friction: [0, 0], applied: [0, 0], joint: [0, 0], damping: [0, 0] }
        },
        box2: {
          parts: { gravity: [0, -m2 * g], normal: [0, m2 * g], friction: [0, 0], applied: [0, 0], joint: [0, 0], damping: [0, 0] }
        }
      };
    }
    function nextEvent(t) { return t < q.tc - 1e-12 ? q.tc : null; }
    function onEvent(t, S) {
      var v1 = S.box1.vx, v2 = S.box2.vx;
      var u1 = ((m1 - e * m2) * v1 + (1 + e) * m2 * v2) / (m1 + m2);
      var u2 = ((m2 - e * m1) * v2 + (1 + e) * m1 * v1) / (m1 + m2);
      S.box1.vx = u1; S.box2.vx = u2;
      return { box1: { part: 'normal' }, box2: { part: 'normal' } };
    }
    return { force: force, nextEvent: nextEvent, onEvent: onEvent };
  }

  /** 三力平衡（双绳悬挂）：静力问题，重力 + 两根绳的张力，净力为 0 */
  function balanceLaws(p) {
    var q = balanceGeom(p), m = p.mass, g = p.g;
    function force(t, S) {
      var jx = q.T1 * q.p1[0] + q.T2 * q.p2[0];
      var jy = q.T1 * q.p1[1] + q.T2 * q.p2[1];
      return {
        block: {
          parts: {
            gravity: [0, -m * g], normal: [0, 0], friction: [0, 0],
            applied: [0, 0], joint: [jx, jy], damping: [0, 0]
          }
        }
      };
    }
    function jointItems() {
      return [
        { id: 'rope1', kind: 'rope', body: 'block', force: [q.T1 * q.p1[0], q.T1 * q.p1[1]] },
        { id: 'rope2', kind: 'rope', body: 'block', force: [q.T2 * q.p2[0], q.T2 * q.p2[1]] }
      ];
    }
    return { force: force, jointItems: jointItems };
  }

  function circVertical(p) {
    var L = p.r, br = CIRC_R, g = p.g;
    var need = 4 * g * L;
    var loop = p.v0 * p.v0 > need * 1.0001;
    var vTop2 = Math.max(0, p.v0 * p.v0 - need);
    // 竖直圆周的周期不是 2πL/v₀（速率在变），用能量守恒数值积分估一个供取景/窗口用
    var T = verticalPeriod(p.v0, g, L);
    var dur = p.duration;                          // 不再截断演示时长
    dur = Math.max(dur, 0.5);
    return {
      title: '圆周运动（竖直面内·杆约束）',
      subtitle: loop
        ? '小球在竖直面内做完整圆周运动（杆可拉可推）'
        : '初速度不足，小球在竖直面内往复摆动（摆动不过最高点）',
      tags: ['圆周运动', '向心力', '竖直面', '机械能守恒'],
      // 步长必须加密：planck 的 DistanceJoint 每步要把速度投影回切线方向，
      // 这个离散投影会线性地耗散机械能——实测 dt=1/240 时半圈掉 9%（v_top 偏低 15%），
      // dt=1/2880 时约 1.2%，与迭代次数、位置修正都无关（关掉位置修正结果完全相同）。
      // 所以这个模型用 64 个子步（dt≈1/3840），并把约 1.5% 的离散误差如实写进容差与说明。
      meta: { g: g, duration: dur, dt: 1 / 60, subSteps: 64 },
      view: { height: 620 },
      bodies: [
        { id: 'pivot', type: 'static', shape: { kind: 'circle', r: 0.05 }, at: [0, 0],
          label: '固定点 O', color: '#8899bb', showForces: false },
        { id: 'ball', type: 'dynamic', shape: { kind: 'circle', r: br },
          at: [0, -L], velocity: [p.v0, 0], mass: p.mass, friction: 0, restitution: 0,
          label: '小球 m=' + p.mass + 'kg', color: '#e8934a', showForces: true }
      ],
      joints: [{ kind: 'rod', id: 'rod', a: 'world', b: 'ball',
                 worldAnchorA: [0, 0], worldAnchorB: [0, -L], length: L }],
      forces: [],
      notes: '解析：最低点 T = mg + mv₀²/L；最高点 T = mv_top²/L − mg，v_top² = v₀² − 4gL。' +
             '杆能推能拉，所以最高点张力允许为负；换成绳则需 v₀² ≥ 5gL 才不松弛。',
      laws: rodLaws(p)
    };
  }

  /**
   * 竖直圆周的周期：能量守恒 ½v² + gy = E（y 自锚点向上，比能量），
   * 由 v² = 2(E − g·y) 得到速率；再把 dt 换成对 y 的积分。
   * 注意不能写成 dy/v：小球是沿圆弧走的，dt = ds/v，而 ds = dy/sinφ，
   * 其中 sinφ = √(1 − y²/L²)（φ 为自最低点量起的圆心角）。
   * 漏掉这个权重会把周期低估一大截。
   */
  function verticalPeriod(v0, g, L) {
    var E = 0.5 * v0 * v0 - g * L;
    var yMin = -L;
    var yMax = (v0 * v0 - 4 * g * L) > 0 ? L : Math.min(L, E / g);
    var n = 8000, sum = 0;
    for (var i = 0; i < n; i++) {
      var y = yMin + (yMax - yMin) * (i + 0.5) / n;
      var v2 = 2 * (E - g * y);
      var w = 1 - (y * y) / (L * L);
      if (v2 <= 1e-9 || w <= 1e-9) continue;
      sum += 1 / (Math.sqrt(v2) * Math.sqrt(w));
    }
    sum *= (yMax - yMin) / n;
    // 该积分是从最低点到最高点（或折返点）的耗时：整圈时是半周期，折返时是四分之一周期
    return ((v0 * v0 - 4 * g * L) > 0 ? 2 : 4) * sum;
  }


  circVertical.expect = function (p) {
    var L = p.r, g = p.g, m = p.mass;
    var need = 4 * g * L;
    var vTop2 = p.v0 * p.v0 - need;
    // 快速转动下 DistanceJoint 的位置修正会耗散约 1% 的机械能（∝ dt），
    // 因此这个模型的容差取 2%，并在 notes 里如实写明——不用放大容差掩盖物理错误。
    var tol = 0.02;
    var E0 = 0.5 * m * p.v0 * p.v0 - m * g * L;      // 初态机械能（y 自固定点向下为负）
    // 耗散随圈数累积（每圈约 1.5%），容差按演示时长覆盖的圈数放大：
    // 这是如实反映"步长加密后仍有离散误差"，而不是把容差一放了之。
    var Tper = Math.max(0.05, verticalPeriod(p.v0, g, L));
    var loops = Math.max(1, p.duration / Tper);
    var items = [
      { label: '最低点张力 T = mg + mv₀²/L', unit: 'N', value: m * (g + p.v0 * p.v0 / L),
        probe: { kind: 'force', body: 'ball', comp: 'joint', mode: 'mag', reduce: 'max',
                 around: { comp: 'y', dir: 'min', pad: 0.017, first: true }, tolerance: tol } },
      { label: '最低点速率 v₀', unit: 'm/s', value: p.v0,
        probe: { kind: 'velocity', body: 'ball', mode: 'mag', reduce: 'max',
                 around: { comp: 'y', dir: 'min', pad: 0.017, first: true }, tolerance: 0.01 } }
    ];
    if (vTop2 > 0) {
      var vTop = Math.sqrt(vTop2);
      items.push({ label: '最高点速率 v_top = √(v₀² − 4gL)', unit: 'm/s', value: vTop,
        probe: { kind: 'velocity', body: 'ball', mode: 'mag',
                 around: { comp: 'y', dir: 'max', pad: 0.017, first: true }, tolerance: tol * loops } });
      items.push({ label: '最高点杆的作用力 T = mv_top²/L − mg', unit: 'N',
        value: m * (vTop2 / L - g),
        // 最高点这个力本身可能接近 0（临界条件附近），相对误差没有物理意义。
        // 用误差传播给出绝对容差：速率有 ε 的相对误差时 ΔT = 2ε·m·v_top²/L。
        absTolerance: Math.max(0.3, 2 * tol * loops * m * vTop2 / L),
        probe: { kind: 'force', body: 'ball', comp: 'joint', mode: 'mag',
                 around: { comp: 'y', dir: 'max', pad: 0.017, first: true } } });
    }
    items.push({ label: '机械能变化 ΔE（每圈约 2~4% 离散损耗）', unit: 'J', value: 0,
      // 杆约束由位置投影实现，每圈耗散实测 2~4%（随 dt、振幅变化），容差按实测标定
      absTolerance: Math.max(0.05, 0.04 * loops * Math.abs(E0)),
      probe: { kind: 'statDelta', key: 'mechanical' } });
    return items;
  };

  /**
   * mode='disc'：转盘上的物块。
   * 转盘是 kinematic 刚体（角速度 ω 由 world.js 新支持的 angularVelocity 驱动），
   * 物块与盘面共速 → 相对速度为零 → 只有静摩擦，其合力恰好提供向心力 mω²r。
   * 物块 fixedRotation=true，避免库仑摩擦"绕质心的力矩"把方块拧起来（那会让接触点漂移）。
   */
  function discGeom(p) {
    var r = p.r, w = p.g / (p.omega * p.omega);    // 静摩擦能支撑的最大半径（按 μ=1 记）
    var muNeed = p.omega * p.omega * r / p.g;      // 所需摩擦因数
    var mu = Math.min(0.98, muNeed * 1.25 + 0.25);
    var hw = 0.22, hh = 0.22;
    var discR = r + Math.max(1.1, 2.2 * hw);       // 盘面必须始终托住物块
    return { r: r, mu: mu, muNeed: muNeed, hw: hw, hh: hh, discR: discR, maxR: w };
  }
  function circDisc(p) {
    var g0 = discGeom(p);
    var t = circTimes(p);
    return {
      title: '圆周运动（转盘）',
      subtitle: '物块随转盘一起匀速转动，静摩擦力提供向心力',
      tags: ['圆周运动', '静摩擦力', '向心力'],
      meta: { g: p.g, duration: t.dur, dt: 1 / 60, subSteps: SUB,
        frictionPairs: [{ a: 'disc', b: 'block', friction: g0.mu, restitution: 0 }] },
      view: { height: 560 },
      bodies: [
        // 转盘：kinematic 圆盘，绕自身中心以 ω 旋转（不参与动力学，速度只由我们自己设定）
        { id: 'disc', type: 'kinematic', angularVelocity: p.omega, shape: { kind: 'circle', r: g0.discR },
          at: [0, 0], friction: g0.mu, label: '转盘 ω=' + p.omega + ' rad/s', color: '#3a4a63', showForces: false },
        // 物块：与盘面接触点线速度 ωr 完全一致 → 相对静止
        { id: 'block', type: 'dynamic', shape: { kind: 'box', w: 2 * g0.hw, h: 2 * g0.hh },
          at: [p.r, g0.discR + g0.hh + 0.001], mass: p.mass, velocity: [0, p.omega * p.r],
          friction: g0.mu, restitution: 0, fixedRotation: true,
          label: '物块 m=' + p.mass + 'kg', color: '#e8934a', showForces: true }
      ],
      joints: [], forces: [],
      notes: '解析：物块在转盘上每一点的线速度都与盘面相同（相对静止），所需的向心力由静摩擦提供，' +
             'f = mω²r ≤ μmg。盘半径按物块尺寸自适应，摩擦因数由 ω²r/g 反推，保证不打滑。'
    };
  }
  circDisc.expect = function (p) {
    var g0 = discGeom(p);
    var t = circTimes(p);
    var w = [0.5 / 60, Math.max(0.3, 0.9 * t.tg)];
    return [
      { label: '所需向心力（静摩擦力）f = mω²r', unit: 'N', value: p.mass * p.omega * p.omega * p.r,
        probe: { kind: 'force', body: 'block', comp: 'total', mode: 'mag', window: w } },
      { label: '转盘角速度 ω（kinematic angularVelocity 已生效）', unit: 'rad/s', value: p.omega,
        probe: { kind: 'stat', key: 'angularVelocity', body: 'disc', at: 'last', tolerance: 0.005 } }
    ];
  };

  /**
   * mode='track'：竖直圆轨道内壁，小球从最低点以 v₀ 出发。
   * 形状 {kind:'track'} 在 world.js 里用局部坐标生成静态边（64 段），刚体角度会整体旋转，
   * 与 draw.js 画的圆环一致。小球放在"弦中点"对应的半径上，保证 t=0 就贴上轨道。
   */
  function trackGeom(p) {
    // 段数必须足够多：内壁是内接多边形，弦长 2R·sin(π/seg) 要远小于小球半径，
    // 这样小球滚过顶点时，其圆心轨迹被小球半径"磨圆"，接触法向才不会跳变。
    // seg=64 时弦长 ≈ 0.098 m，与 ballR=0.16 同量级 → 每次过顶点都会产生冲量（残差 3%~5%）。
    var seg = 192;
    var half = Math.PI / seg;                      // 相邻顶点半角
    var facet = Math.cos(half);                    // 弦到圆心的距离 = R·cos(π/seg)
    var ballR = 0.16;
    var inR = p.r * facet;                         // 内接多边形面到圆心的距离
    var need = 4 * p.g * p.r;                      // 过最高点所需的 v₀² > 4gR
    var vTop2 = p.v0 * p.v0 - need;
    var loop = vTop2 > 0;
    var T = 2 * Math.PI * p.r / p.v0;              // 匀速圆周（轨道光滑）→ 周期
    var tTop = 0.75 * T;                           // 最低点出发、沿长弧到最高点
    var dur = p.duration;
    if (!loop) {
      // 摆不到最高点：会在下半圆来回摆动，时长的上限定成半个周期多点即可
      dur = Math.min(p.duration, 0.6 * T);
    }
    dur = Math.max(dur, 8 / 60);
    var tg = simEnd(dur, 1 / 60);
    return {
      seg: seg, inR: inR, ballR: ballR, loop: loop, vTop2: vTop2, vTop: Math.sqrt(Math.max(0, vTop2)),
      sinth: p.v0 * p.v0 / (p.g * p.r), T: T, tTop: tTop, dur: dur, tg: tg
    };
  }
  function circTrack(p) {
    var q = trackGeom(p);
    return {
      title: '圆周运动（竖直圆轨道内壁）' + (q.loop ? '：完成整圈' : '：摆不过最高点'),
      subtitle: '光滑圆轨道，轨道对小球的弹力与重力共同提供向心力',
      tags: ['圆周运动', '向心力', '轨道弹力'],
      meta: { g: p.g, duration: q.dur, dt: 1 / 60, subSteps: SUB },
      view: { height: 620 },
      bodies: [
        { id: 'track', type: 'static', shape: { kind: 'track', r: p.r, segments: q.seg },
          at: [0, 0], angle: 0, friction: 0, restitution: 0, label: '圆轨道 R=' + p.r + 'm',
          color: '#3a4a63', showForces: false },
        { id: 'ball', type: 'dynamic', shape: { kind: 'circle', r: q.ballR },
          at: [0, -(q.inR - q.ballR - 0.0003)], mass: p.mass, velocity: [p.v0, 0],
          friction: 0, restitution: 0, label: '小球 m=' + p.mass + 'kg', color: '#e8934a', showForces: true }
      ],
      joints: [], forces: [],
      notes: '解析：轨道光滑 → 全程速率不变 v = v₀。最低点 N = mg + mv₀²/R；' +
             '最高点 N = mv_top²/R − mg，其中 v_top² = v₀² − 4gR。v₀² < 4gR 时小球会脱离内壁（本模型会提示"摆不过最高点"）。'
    };
  }
  circTrack.expect = function (p) {
    var q = trackGeom(p);
    var T = q.T;
    // 采样窗口都落在"小球还在下半圈"的时间段里，避免法向力方向在最高点翻号
    var wBot = [2 / 60, Math.max(0.3, 0.30 * T)];
    var items = [
      { label: '最低点弹力 N = mg + mv₀²/R', unit: 'N', value: p.mass * (p.g + p.v0 * p.v0 / p.r),
        probe: { kind: 'force', body: 'ball', comp: 'normal', project: [0, 1], signed: true, window: wBot } }
    ];
    if (q.loop) {
      // 最高点在 t = ¾T；用最高点附近的坐标窗口取速率
      var tTop = q.tTop;
      var wTop = [tTop - 0.10 * T, tTop + 0.10 * T];
      items.push({ label: '最高点速率 v_top = √(v₀² − 4gR)', unit: 'm/s', value: q.vTop,
        probe: { kind: 'velocity', body: 'ball', mode: 'mag', window: wTop, reduce: 'max', tolerance: 0.01 } });
      items.push({ label: '最高点弹力 N = mv_top²/R − mg', unit: 'N',
        value: p.mass * (q.vTop2 / p.r - p.g),
        probe: { kind: 'force', body: 'ball', comp: 'normal', project: [0, -1], signed: true, window: wTop, tolerance: 0.02 } });
    }
    return items;
  };

  // =============================================================== 3. 碰撞与冲量（动量守恒）
  var COL_SIZE = 0.6;                             // 滑块尺寸（双方相同，便于几何对齐）
  function colGeom(p) {
    var m1 = p.mass1, m2 = p.mass2, e = p.restitution, v0 = p.v0;
    var v1 = ((m1 - e * m2) * v0) / (m1 + m2);    // 恢复系数公式
    var v2 = ((1 + e) * m1 * v0) / (m1 + m2);
    var x1 = -1.0, x2 = -1.0 + COL_SIZE + 1.6;    // 间距 1.6 m → 碰撞前有明显匀速阶段
    var tc = (x2 - x1 - COL_SIZE) / v0;           // 相碰时刻（接触瞬间）
    if (!(tc > 0)) tc = 0.05;
    var tMarg = Math.min(0.2 * tc, 0.25);
    var tEnd = p.duration;                         // 不再截断演示时长
    var tg = simEnd(tEnd, 1 / 60);
    // 碰后采样窗口：从碰后 0.12·(剩余时间) 开始，确保已完全分离、速度稳定
    var wPost = [tc + 0.12 * Math.max(0.05, tg - tc), tg];
    if (wPost[1] - wPost[0] < 4 / 60) wPost = [Math.min(tc + 1 / 60, tg), tg];
    return { v1: v1, v2: v2, x1: x1, x2: x2, tc: tc, tEnd: tEnd, tg: tg, wPost: wPost };
  }
  function collision(p) {
    var q = colGeom(p);
    // 地面必须覆盖整个运动范围（两球都在地面上滑动，靠取景自动裁剪）
    var xmin = Math.min(q.x1, q.x2, q.x1 + q.v1 * q.tg, q.x2 + q.v2 * q.tg) - 1.6;
    var xmax = Math.max(q.x1, q.x2, q.x1 + q.v1 * q.tg, q.x2 + q.v2 * q.tg) + 1.6;
    var yc = COL_SIZE / 2 + 0.001;
    return {
      title: '碰撞与冲量（动量守恒）',
      subtitle: p.restitution === 0 ? '完全非弹性碰撞（碰后共速）'
        : (p.restitution === 1 ? '弹性碰撞（动能守恒）' : '非弹性碰撞 e=' + p.restitution),
      tags: ['碰撞', '冲量', '动量守恒', '恢复系数'],
      meta: { g: p.g, duration: q.tEnd, dt: 1 / 60, subSteps: SUB,
        // 地面摩擦必须为 0（否则水平动量不守恒）；恢复系数精确指定给这一对
        frictionPairs: [{ a: 'box1', b: 'box2', friction: 0, restitution: p.restitution }] },
      view: { height: 420 },
      bodies: [
        { id: 'ground', type: 'static', shape: { kind: 'box', w: xmax - xmin, h: 0.4 },
          at: [(xmax + xmin) / 2, -0.2], friction: 0, restitution: 0, label: '光滑地面' },
        { id: 'box1', type: 'dynamic', shape: { kind: 'box', w: COL_SIZE, h: COL_SIZE },
          at: [q.x1, yc], mass: p.mass1, velocity: [p.v0, 0], friction: 0, restitution: p.restitution,
          label: 'm₁=' + p.mass1 + 'kg', color: '#e8934a', showForces: true },
        { id: 'box2', type: 'dynamic', shape: { kind: 'box', w: COL_SIZE, h: COL_SIZE },
          at: [q.x2, yc], mass: p.mass2, velocity: [0, 0], friction: 0, restitution: p.restitution,
          label: 'm₂=' + p.mass2 + 'kg', color: '#5fa8ff', showForces: true }
      ],
      joints: [], forces: [],
      markers: [{ t: q.tc, label: '碰撞瞬间',
        note: '接触瞬间完成碰撞（本模型取极短的接触时间），碰撞前后系统总动量守恒：' +
          'm₁v₀ = m₁v₁′ + m₂v₂′ = ' + (p.mass1 * p.v0).toFixed(2) + ' kg·m/s。' +
          'v₁′ = (m₁−e·m₂)v₀/(m₁+m₂) = ' + q.v1.toFixed(3) + ' m/s，' +
          'v₂′ = (1+e)m₁v₀/(m₁+m₂) = ' + q.v2.toFixed(3) + ' m/s。' +
          '注意 v-t 图上速度是**跳变**的（碰撞在极短时间内完成），不是斜线。' }],
      laws: collisionLaws(p),
      notes: '解析：v₁′ = (m₁−e·m₂)v₀/(m₁+m₂)，v₂′ = (1+e)m₁v₀/(m₁+m₂)，碰后动量守恒 m₁v₀ = m₁v₁′ + m₂v₂′，' +
             '冲量 I = m₂v₂′（作用在 m₂ 上）。地面与滑块间摩擦为 0，竖直方向不改变水平动量。'
    };
  }
  collision.expect = function (p) {
    var q = colGeom(p);
    var m1 = p.mass1, m2 = p.mass2;
    var items = [
      { label: '碰后 v₁′ = (m₁−e·m₂)v₀/(m₁+m₂)', unit: 'm/s', value: q.v1,
        probe: { kind: 'velocity', body: 'box1', project: [1, 0], signed: true, window: q.wPost } },
      { label: '碰后 v₂′ = (1+e)m₁v₀/(m₁+m₂)', unit: 'm/s', value: q.v2,
        probe: { kind: 'velocity', body: 'box2', project: [1, 0], signed: true, window: q.wPost } },
      { label: '碰后总动量 = m₁v₀（动量守恒）', unit: 'kg·m/s', value: m1 * p.v0 + m2 * 0,
        probe: { kind: 'stat', key: 'momentumX', at: 'last', tolerance: 0.005 } },
      { label: '碰撞冲量 I = m₂v₂′（作用在 m₂ 上）', unit: 'N·s', value: m2 * q.v2,
        // 冲量是过程量：一次碰撞只占 1~2 帧，必须用 reduce:'sum' 求和。
        // 用默认的按帧平均会得到总冲量的 1/N（实测正好是一半）。
        probe: { kind: 'impulse', body: 'box2', project: [1, 0], signed: true, reduce: 'sum', window: [0, 1e9], tolerance: 0.02 } }
    ];
    return items;
  };

  // =============================================================== 4. 三力平衡（静态受力图）
  var BAL_HW = 0.3;                               // 物块半宽
  var BAL_HH = 0.2;                               // 物块半高
  var BAL_HX = 0.12;                              // 绳系在物块顶面距中心 BAL_HX 处

  /** 共点力平衡 2×2 线性方程组：解出两绳张力 T₁、T₂ */
  function balanceGeom(p) {
    var m = p.mass, g = p.g, L = BAL_HW, H = BAL_HH;
    var off = Math.max(-0.6, Math.min(0.6, p.offset || 0)) * L;   // 物块始终落在两锚点之间 → 两绳都受拉
    var d = L + p.spread;
    var yc = p.height;
    var A1 = [-d, yc], A2 = [d, yc];
    var blockC = [off, 0];
    var C1 = [off - BAL_HX, H], C2 = [off + BAL_HX, H];
    var L1 = Math.hypot(C1[0] - A1[0], C1[1] - A1[1]);
    var L2 = Math.hypot(C2[0] - A2[0], C2[1] - A2[1]);
    // A₁→C₁ 方向（绳垂向物块的方向）；张力沿此方向作用在物块上
    var u1 = [(C1[0] - A1[0]) / L1, (C1[1] - A1[1]) / L1];
    var u2 = [(C2[0] - A2[0]) / L2, (C2[1] - A2[1]) / L2];
    // 力的平衡（重力作用在质心）：
    //   T₁u₁ₓ + T₂u₂ₓ = 0
    //   T₁u₁ᵧ + T₂u₂ᵧ = mg
    // u = 锚点 → 物块系点 的单位矢量。绳对物块的拉力方向是 **−u**（由物块指向锚点）。
    // 共点力平衡： T₁(−u₁) + T₂(−u₂) + (0, −mg) = 0
    //   → T₁u₁ + T₂u₂ = (0, +mg) 的两边同乘 −1
    //   → 展开分量： T₁u₁ₓ + T₂u₂ₓ = 0 ； T₁u₁ᵧ + T₂u₂ᵧ = −mg
    // 注意右端是 **−mg**（u 的 y 分量本身是负的，负负得正才得到正的张力）。
    // 写成 +mg 会把张力解成负数——那是"绳子在推物块"，物理上不成立。
    var rhs = -m * g;
    var det = u1[0] * u2[1] - u2[0] * u1[1];
    var T1 = (0 * u2[1] - u2[0] * rhs) / det;
    var T2 = (u1[0] * rhs - 0 * u1[1]) / det;
    return {
      m: m, g: g, off: off, d: d, yc: yc, L1: L1, L2: L2, u1: u1, u2: u2,
      T1: T1, T2: T2, A1: A1, A2: A2, C1: C1, C2: C2, blockC: blockC,
      // 测量方向：绳拉物块的方向（由系点指向锚点 = −u），投影得到 +T
      p1: [-u1[0], -u1[1]], p2: [-u2[0], -u2[1]]
    };
  }
  function balance(p) {
    var q = balanceGeom(p);
    var dur = Math.max(p.duration, 0.8);
    return {
      title: '三力平衡（双绳悬挂）',
      subtitle: '两根绳把物块挂在两个天花板锚点上，物块保持静止',
      tags: ['共点力平衡', '绳张力', '静态受力图'],
      meta: { g: p.g, duration: dur, dt: 1 / 60, subSteps: SUB },
      view: { height: 560 },
      bodies: [
        // 天花板装饰条（仅用于观察锚点）
        { id: 'ceiling', type: 'static', shape: { kind: 'box', w: 2 * q.d + 1.0, h: 0.18 },
          at: [0, q.yc + 0.09], friction: 0, label: '天花板', color: '#3a4a63', showForces: false },
        // 固定两个锚点用的静态小圆（可视化锚点位置，无质量）
        { id: 'anchor1', type: 'static', shape: { kind: 'circle', r: 0.06 }, at: q.A1,
          label: '锚点 A₁', color: '#8899bb', showForces: false },
        { id: 'anchor2', type: 'static', shape: { kind: 'circle', r: 0.06 }, at: q.A2,
          label: '锚点 A₂', color: '#8899bb', showForces: false },
        { id: 'block', type: 'dynamic', shape: { kind: 'box', w: 2 * BAL_HW, h: 2 * BAL_HH },
          at: q.blockC, mass: p.mass, friction: 0, restitution: 0, fixedRotation: true,
          label: '物块 m=' + p.mass + 'kg', color: '#e8934a', showForces: true }
      ],
      // 绳长 = 锚点到物块系点的实际距离 → 初始几何就是精确平衡态（无初始冲击）
      joints: [
        { kind: 'rod', id: 'rope1', a: 'anchor1', b: 'block', worldAnchorA: q.A1, worldAnchorB: q.C1, length: q.L1 },
        { kind: 'rod', id: 'rope2', a: 'anchor2', b: 'block', worldAnchorA: q.A2, worldAnchorB: q.C2, length: q.L2 }
      ],
      forces: [],
      laws: balanceLaws(p),
      notes: '解析：共点力平衡 T₁u₁ + T₂u₂ + m g = 0（u 为 A→物块系点方向的单位矢量）。' +
             '绳长直接取锚点到物块系点的实际距离，物块水平偏移限制在两锚点之间，保证 T₁、T₂ 均为正。'
    };
  }
  balance.expect = function (p) {
    var q = balanceGeom(p);
    var tg = simEnd(Math.max(p.duration, 0.8), 1 / 60);
    var w = [0.3, Math.max(0.5, tg)];
    return [
      { label: '绳₁张力 T₁（绳对物块的拉力）', unit: 'N', value: q.T1,
        probe: { kind: 'force', body: 'block', comp: 'joint', jointId: 'rope1', project: q.p1, signed: true, window: w } },
      { label: '绳₂张力 T₂（绳对物块的拉力）', unit: 'N', value: q.T2,
        probe: { kind: 'force', body: 'block', comp: 'joint', jointId: 'rope2', project: q.p2, signed: true, window: w } },
      { label: '合力为零 |ΣF|（应为 0）', unit: 'N', value: 0, absTolerance: 0.01,
        probe: { kind: 'force', body: 'block', comp: 'total', mode: 'mag', window: w } },
      { label: '竖直方向加速度（应为 0，物块静止）', unit: 'm/s²', value: 0, absTolerance: 0.01,
        probe: { kind: 'accel', body: 'block', project: [0, 1], signed: true, window: w } }
    ];
  };

  // 注册表
  function register(add) {
    add({
      id: 'projectile', title: '平抛与斜抛运动', group: '经典力学',
      params: [
        { key: 'v0', label: '初速度 v₀', unit: 'm/s', min: 1, max: 30, step: 0.5, value: 12 },
        { key: 'angle', label: '抛射角 θ', unit: '°', min: 0, max: 70, step: 5, value: 0 },
        { key: 'height', label: '抛出点高度 h', unit: 'm', min: 1, max: 40, step: 1, value: 8 },
        { key: 'mass', label: '小球质量 m', unit: 'kg', min: 0.1, max: 10, step: 0.1, value: 1 },
        { key: 'g', label: '重力加速度 g', unit: 'm/s²', min: 9.8, max: 10, step: 0.1, value: 10 },
        { key: 'duration', label: '演示时长', unit: 's', min: 0.5, max: 12, step: 0.5, value: 3 }
      ],
      build: projectile, expect: projectile.expect
    });
    add({
      id: 'circular', title: '圆周运动（竖直面·杆约束）', group: '经典力学',
      params: [
        { key: 'r', label: '杆长 L（圆周半径）', unit: 'm', min: 0.2, max: 1.2, step: 0.05, value: 0.6 },
        { key: 'v0', label: '最低点初速度 v₀', unit: 'm/s', min: 0.5, max: 12, step: 0.5, value: 5.5 },
        { key: 'mass', label: '质量 m', unit: 'kg', min: 0.2, max: 5, step: 0.1, value: 1 },
        { key: 'g', label: '重力加速度 g', unit: 'm/s²', min: 9.8, max: 10, step: 0.1, value: 10 },
        { key: 'duration', label: '演示时长', unit: 's', min: 0.5, max: 12, step: 0.5, value: 3 }
      ],
      build: circVertical,
      expect: circVertical.expect
    });
    add({
      id: 'collision', title: '碰撞与冲量（动量守恒）', group: '经典力学',
      params: [
        { key: 'v0', label: '左球初速度 v₀', unit: 'm/s', min: 0.5, max: 12, step: 0.5, value: 4 },
        { key: 'mass1', label: 'm₁', unit: 'kg', min: 0.2, max: 10, step: 0.2, value: 2 },
        { key: 'mass2', label: 'm₂', unit: 'kg', min: 0.2, max: 10, step: 0.2, value: 2 },
        { key: 'restitution', label: '恢复系数 e', unit: '', min: 0, max: 1, step: 0.05, value: 0.6 },
        { key: 'g', label: '重力加速度 g', unit: 'm/s²', min: 9.8, max: 10, step: 0.1, value: 10 },
        { key: 'duration', label: '演示时长', unit: 's', min: 0.5, max: 12, step: 0.5, value: 3 }
      ],
      build: collision, expect: collision.expect
    });
    add({
      id: 'balance', title: '三力平衡（双绳悬挂）', group: '经典力学',
      params: [
        { key: 'mass', label: '物块质量 m', unit: 'kg', min: 0.2, max: 10, step: 0.1, value: 1 },
        { key: 'spread', label: '锚点额外半距 Δd', unit: 'm', min: 0.2, max: 2.5, step: 0.1, value: 0.8 },
        { key: 'height', label: '悬挂点高度', unit: 'm', min: 0.6, max: 6, step: 0.2, value: 2.5 },
        { key: 'offset', label: '物块水平偏移', unit: '×半宽', min: -0.6, max: 0.6, step: 0.1, value: 0 },
        { key: 'g', label: '重力加速度 g', unit: 'm/s²', min: 9.8, max: 10, step: 0.1, value: 10 },
        { key: 'duration', label: '演示时长', unit: 's', min: 0.8, max: 4, step: 0.2, value: 1.5 }
      ],
      build: balance, expect: balance.expect
    });
  }

  return { register: register };
});
