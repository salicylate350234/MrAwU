/*!
 * MrAwU（阿物先生）— lib/models/track.js
 * 轨道类组合模型（Phase 1 首个用例）：斜面 → 竖直圆轨道内壁 → 全场匀强电场
 *
 * 题面：带正电 q、质量 m 的小球恰能静止在光滑绝缘斜面（倾角 α=37°）上的 A 点；
 *   半径 R 的竖直圆轨道与斜面**平缓对接**（相切于切点 J）；A 与圆轨道最高点 B 等高；
 *   整个装置处于水平向右的匀强电场中。求 (1) E (2) 能通过 B 的最小初速度 (3) 该情况下到 B 的速度。
 *
 * 解析基线（手推；临界点在**等效重力最高点**而不是 B —— 这是本题的考点）
 *   几何（切点在圆轨道右下侧，球下滑后沿**底部**上行到 B）：
 *     O = J + R(−sinα, cosα)，B = O + (0,R)，t_AJ = R(1+cosα)/sinα，x_B − x_A = −R(1+cosα)/sinα
 *   (1) 斜面光滑且静止 ⇒ qE·cosα = mg·sinα ⇒ E = mg·tanα/q
 *   (2) 等效重力 g_eff = g/cosα = g·secα（方向垂直斜面向内）。球从 J 沿底部上行，先经过等效最高点：
 *       N = m·v²/R − m·g·secα ≥ 0 ⇒ v_crit,lim² = gR·secα；B 点条件 v_B² ≥ gR 较松。
 *       A→B：重力做功 0（等高），电场做功 qE·Δx = −mgR(1+secα) ⇒ v_A² = v_B² + 2gR(1+secα)
 *   (3) 临界点 v_crit² = v0² − 4gR·secα（B 之后再少 2gR(secα−1)）
 *  通用（任意 v0 ≥ v_min，任意 α）：
 *     v_B²    = v0² − 2gR(1 + secα)
 *     v_crit² = v0² − 4gR·secα
 *     v_min²  = 5gR·secα          （临界点贴壁极限 v_crit² = gR·secα）
 *     最小情形下 v_B² = gR(3secα − 2)、v_crit² = gR·secα
 *  v0 < v_min 时球在到 B 之前脱离轨道 ⇒ 按题意（未提及后续抛体）**模拟停止**并冻结。
 *
 * 一般式怎么来的（把 3-4-5 理想化换成 secα）与怎么验的
 *   · α=37° 且取 tan37°=3/4、sin37°=3/5、cos37°=4/5 时 secα=1.25，
 *     上面三式分别给出 4.5 / 5 / 6.25 —— 题面基线就是它的特例（不是另一套答案）。
 *   · 一般式**用仿真自己的帧数据独立核过**（node/cost 无此脚本，脚本在工作区外）：
 *     固定 θ、取 8 个 v0，从帧里直接算 KE+mgy−qE·x（自写 U = mgy − Efac·m·g·tanα·x，
 *     不用模型的 potential），整条轨迹漂移 ≤ 3.8e−5 相对量；再把帧速率按已知势能差
 *     修正到几何点，得实测系数（θ=20/30/37/45/53/60°）：
 *       c_B    = 2(1+secα)  实测 4.1285 / 4.3096 / 4.5045 / 4.8287 / 5.3235 / 6.0004
 *       c_crit = 4secα      实测 4.2569 / 4.6190 / 5.0087 / 5.6571 / 6.6468 / 8.0004
 *       c_min  = 5secα      实测（二分"到底冻不冻结"）全部吻合到 0.001%
 *     与解析式的偏差 ≤ 0.007%。
 *   · 结论：expect 的四条解析项对**任意 θ(20–60°)** 都成立，不再只在 37° 有意义。
 *
 * 轨道本体取**整圈**内壁（题图也是整圈），闭环的墙把球关在里面：球到 B 之后
 * 会继续绕圈，不会退回来爬斜面。路径就是按整圈 cyclic 弧建的。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../track.js'), require('../scene.js'));
  } else {
    root.PFA = root.PFA || {};
    root.PFA.models = root.PFA.models || {};
    root.PFA.models_track = factory(root.PFA.track, root.PFA.scene);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (trackLib, sceneLib) {
  'use strict';

  var DEG = Math.PI / 180;
  // 圆弧段曲率大，子步取密一点。48（dt=1/2880）是标定出来的：
  // 约束投影的残余离散耗散 ≈ h^1.8 —— 24 时全程(6 s / 约 8 圈) |ΔE|≈2.0e−4 J，
  // 48 时 ≈5e−5 J（初值 5 J 的 1e−3 %），96 时 ≈1.3e−5 J。取 48 已远超精度要求。
  var SUB = 48;

  function geom(p) {
    var R = p.R, al = (p.theta || 37) * DEG;
    var cs = Math.cos(al), sn = Math.sin(al);
    var J = [0, 0];
    var O = [J[0] - R * sn, J[1] + R * cs];
    var B = [O[0], O[1] + R];
    var tA = R * (1 + cs) / sn;
    var A = [J[0] + tA * cs, J[1] + tA * sn];
    var thJ = Math.atan2(J[1] - O[1], J[0] - O[0]);
    var thB = Math.PI / 2;
    // 从切点沿 θ 减小方向绕行到底部、经左侧上行到 B（球下滑的切向决定了这个方向）
    var sweep = -((thJ < thB ? thJ + 2 * Math.PI - thB : thJ - thB));
    var thCrit = thJ - Math.PI;                   // 等效重力最高点（球必经过）
    return {
      R: R, al: al, cs: cs, sn: sn, J: J, O: O, B: B, A: A, tA: tA,
      thJ: thJ, thB: thB, sweep: sweep, thCrit: thCrit,
      // 轨道本体是**整圈**内壁（题图也是整圈），物理上球在闭环内壁里被关住，
      // 走到 B 之后会继续绕圈 —— 所以路径取整圈 sweepFull = −2π 并标成 cyclic。
      sweepFull: -2 * Math.PI,
      crit: [O[0] + R * Math.cos(thCrit), O[1] + R * Math.sin(thCrit)],
      xB: B[0], xA: A[0]
    };
  }

  function makePath(g, mu) {
    return trackLib.makePath({
      segments: [
        { kind: 'line', a: g.A, b: g.J, mu: mu, side: -1, label: '光滑斜面' },
        { kind: 'arc', c: g.O, r: g.R, a0: g.thJ, a1: g.thJ + g.sweepFull, mu: mu,
          inner: true, cyclic: true, label: '圆轨道内壁' }
      ]
    });
  }

  /**
   * 关键解析式集中在这里，build 与 expect 共用，避免两处不一致。
   * 一般倾角形式（用仿真帧数据独立核过，偏差 ≤0.007%，见文件头注释）：
   *   v_B²    = v0² − 2gR(1 + secα)
   *   v_crit² = v0² − 4gR·secα
   *   v_min²  = 5gR·secα
   * α=37°（3-4-5，secα=1.25）时分别退化为题面给的 4.5gR / 5gR / 6.25gR。
   */
  function analytics(p) {
    var g = geom(p);
    var m = p.mass, q = p.q * 1e-3, R = g.R, gg = p.g, cs = g.cs;
    var sec = 1 / cs;                                      // secα = 1/cosα
    var cB = 2 * (1 + sec);                                // v_B²   的系数（以 gR 计）
    var cCrit = 4 * sec;                                   // v_crit² 的系数
    var cMin = 5 * sec;                                    // v_min²  的系数
    var Eeq = m * gg * Math.tan(g.al) / q;                 // (1)
    var E = (p.Efac != null ? p.Efac : 1) * Eeq;
    var vA2 = p.v0 * p.v0;
    var vB2 = vA2 - cB * gg * R;                           // A→B：重力做功 0，电场做功 −mgR(1+secα)
    var vCrit2 = vA2 - cCrit * gg * R;                     // 等效最高点：B 之后再少 2gR(secα−1)
    var vMin2 = cMin * gg * R;                             // 最小初速度（临界点贴壁极限）
    var vCritLimit2 = gg * R * sec;                        // 临界点贴壁条件 v² ≥ gR·secα
    var Ncrit = m * vCrit2 / R - m * gg * sec;             // 临界点法向力
    return {
      g: g, m: m, q: q, R: R, Eeq: Eeq, E: E, vA2: vA2, sec: sec,
      cB: cB, cCrit: cCrit, cMin: cMin,
      vB2: vB2, vCrit2: vCrit2, vMin2: vMin2, vCritLimit2: vCritLimit2, Ncrit: Ncrit,
      /** 相对贴壁裕度 (v0² − v_min²)/v_min²：<0 走"脱离→停止"，≈0 是临界点本身 */
      margin: (vA2 - vMin2) / vMin2,
      /** 球能否走完全程（贴壁条件是否全程满足） */
      ok: vA2 >= vMin2 - 1e-12
    };
  }

  function build(p) {
    var L = analytics(p), g = L.g, m = L.m;
    var path = makePath(g, p.mu || 0);
    var bad = path.checkTangency(1e-6);
    if (bad.length) throw new Error('track: 斜面与圆弧未相切（dot=' + bad[0].dot.toFixed(6) + '）');

    var laws = trackLib.makeTrackLaws({
      path: path, body: 'ball', mass: m, g: p.g, q: L.q,
      field: { E: [L.E, 0], regions: null },               // 全场匀强、水平向右
      exitPolicy: 'stop'                                   // 本题未提及后续抛体 ⇒ 脱离即停止模拟
    });

    return {
      id: 'trackSlopeLoopE',
      title: '斜面 → 竖直圆轨道（内壁）+ 匀强电场',
      subtitle: '光滑斜面与圆轨道平缓对接；等效重力沿斜面向内，临界点在等效最高点而非 B',
      tags: ['组合', '轨道', '圆周运动', '电场', '临界条件'],
      // 轨道约束（解析法向力 + 位置/速度投影）只有自研引擎认得：planck 侧没有这种力，
      // 拿它去对拍只会得到一条自由落体的假轨迹。声明 verletOnly 让 CI 的
      // compare-engines 跳过 planck 侧、改为对解析解自检（与双星/电场模型同一约定）。
      verletOnly: true,
      meta: { g: p.g, duration: p.duration || 6, dt: 1 / 60, subSteps: SUB },
      view: { height: 620 },
      bodies: [
        { id: 'arc', type: 'static', shape: { kind: 'track', r: g.R, segments: 192 },
          at: [g.O[0], g.O[1]], angle: 0, friction: 0, restitution: 0,
          label: '圆轨道 R=' + g.R + 'm', color: '#3a4a63', showForces: false },
        { id: 'ramp', type: 'static', shape: { kind: 'box', w: g.tA, h: 0.04 },
          at: [(g.A[0] + g.J[0]) / 2, (g.A[1] + g.J[1]) / 2],
          angle: p.theta || 37, friction: 0, restitution: 0,
          label: '光滑斜面 α=' + (p.theta || 37) + '°', color: '#3a4a63', showForces: false },
        { id: 'ball', type: 'dynamic', shape: { kind: 'circle', r: Math.max(0.03, g.R * 0.055) },
          at: [g.A[0], g.A[1]], mass: m, velocity: [-p.v0 * g.cs, -p.v0 * g.sn],
          friction: 0, restitution: 0, label: '小球 m=' + m + 'kg', color: '#e8934a', showForces: true }
      ],
      joints: [], forces: [],
      laws: laws,
      notes: '(1) E = mg·tanα/q = ' + L.Eeq.toFixed(1) + ' V/m（本场景取 ' + (p.Efac != null ? p.Efac : 1).toFixed(2) + ' 倍）。' +
             '(2) 临界点在等效最高点：N = mv²/R − mg/cosα ≥ 0 ⇒ v_crit,lim² = gR/cosα = gR·secα，得 v_min = √(5gR·secα) = ' +
             Math.sqrt(L.vMin2).toFixed(3) + ' m/s（α=37° 时即 √(25gR/4)）。' +
             '(3) 该情况下 v_B = √(gR(3secα−2)) = ' + Math.sqrt(Math.max(0, p.g * g.R * (3 * L.sec - 2))).toFixed(3) +
             ' m/s（α=37° 时即 √(7gR/4)）。' +
             '通用能量关系（任意 α）：v_B² = v0² − 2gR(1+secα)、v_crit² = v0² − 4gR·secα；' +
             '本场景 secα = ' + L.sec.toFixed(3) + ' ⇒ 系数 ' + L.cB.toFixed(2) + 'gR / ' + L.cCrit.toFixed(2) + 'gR。' +
             '圆轨道是**整圈**内壁（闭环），球过 B 之后继续贴着内壁绕圈，不会退回来爬斜面。' +
             (L.margin > 1e-3 ? '' : (L.margin < -1e-3
               ? ' ⚠ 当前 v0 < v_min，球会在到 B 之前脱离轨道（按题意模拟停止）。'
               : ' ⚠ 当前 v0 恰在临界点附近（|v0²−v_min²|/v_min² < 0.1%）：能否贴壁过顶由离散误差决定' +
                 '（实测离散阈值比解析值高约 1e-5 相对量），本场景不对"是否走完"下断言。'))
    };
  }

  build.expect = function (p, ctx) {
    var L = analytics(p), g = L.g, m = L.m, R = L.R, gg = p.g;
    // 下面这些解析式都是在 E = mg·tanα/q（"恰能静止"的平衡场强）下推出来的：
    // 换了场强，等效重力方向与等效最高点都会移位，这套式子不再成立，
    // 与其报出几行假 FAIL，不如只在 Efac=1 时给出（能量守恒那条与 Efac 无关，始终保留）。
    var eqField = (p.Efac == null || Math.abs(p.Efac - 1) < 1e-12);
    var items = [];

    if (eqField) {
      // (1) 的通用检验：E 取平衡值时斜面上切向合力恒为 0 ⇒ 切向加速度 = 0（对任意 v0 都成立）。
      // 投影方向取"沿斜面向下"的单位矢量，signed ⇒ 直接读出切向加速度（含符号）。
      // 不能用"球静止不动"来验：那只在 v0≈0 时才成立，默认 v0=10 时球本来就在滑动。
      // 窗口必须留在斜面段内：上斜面的时间 t_AJ = tA/v0（解析值），陡角 + 大 v0 时它会短到 0.1 s
      // （θ=53°、v0=12 时 t_AJ≈0.17 s），固定用 [1/60, 0.2] 会把已经进圆弧的帧也读进来。
      var tIn = p.v0 > 1e-9 ? Math.max(1 / 60, Math.min(0.2, 0.9 * g.tA / p.v0)) : 0.2;
      items.push({
        label: '(1) 平衡场强 E = mg·tanα/q ⇒ 斜面段切向加速度 = 0', unit: 'm/s²', value: 0,
        note: 'E = ' + L.Eeq.toFixed(1) + ' V/m（' + ((p.theta || 37)) + '°、q=' + p.q + ' mC）；窗口取斜面段内的 [0, ' + tIn.toFixed(3) + '] s',
        probe: { kind: 'accel', body: 'ball', project: [-g.cs, -g.sn], signed: true,
                 window: [0, tIn], reduce: 'mean', tolerance: 1e-6, absTolerance: 1e-3 }
      });
    }

    // 临界点本身的窄带（|Δv0²|/v_min² < 0.1%）：这里"贴不贴得住"完全由离散误差决定
    // ——实测离散阈值比解析 v_min 高约 1e-5 相对量，恰好取 v0 = v_min 时模型判"能过"、
    // 仿真却会在临界点 N=0 处判脱离并冻结。这一段不下断言（只保留与贴壁无关的
    // 斜面切向加速度检验），免得报出"由离散误差说了算"的假 FAIL。
    if (Math.abs(L.margin) < 1e-3) {
      fillWindows(items, ctx, g, L);
      return items;
    }

    if (!L.ok) {
      // v0 不足：验证"按题意停止"（脱离后冻结、速度归零）
      items.push({
        label: 'v0 < v_min ⇒ 球在到 B 前脱离轨道，按题意**模拟停止**（末帧速度应为 0）', unit: 'm/s', value: 0,
        note: 'v_min = √(5gR·secα) = ' + Math.sqrt(L.vMin2).toFixed(3) + ' m/s',
        probe: { kind: 'velocity', body: 'ball', mode: 'mag', window: 'auto@last', reduce: 'max',
                 tolerance: 1e-6, absTolerance: 1e-6 }
      });
      fillWindows(items, ctx, g, L);
      return items;
    }

    if (eqField) {
      items.push({
        label: '(3) B 点速度 v_B = √(v0² − ' + L.cB.toFixed(2) + 'gR)' +
               '  [2(1+secα)，α=37° 时 = 4.5]',
        unit: 'm/s', value: Math.sqrt(Math.max(0, L.vB2)),
        probe: { kind: 'velocity', body: 'ball', mode: 'mag', window: 'auto@top', reduce: 'max', tolerance: 0.02 }
      });
      items.push({
        label: '(2) 临界点（等效最高点）速度 v_crit = √(v0² − ' + L.cCrit.toFixed(2) + 'gR)' +
               '  [4secα，α=37° 时 = 5]',
        unit: 'm/s',
        value: Math.sqrt(Math.max(0, L.vCrit2)),
        probe: { kind: 'velocity', body: 'ball', mode: 'mag', window: 'auto@crit', reduce: 'max', tolerance: 0.02 }
      });
      // 临界点法向力本身可能接近 0（贴壁极限附近），相对误差没有物理意义 ——
      // 用误差传播给绝对容差：速率有 ε 的相对误差时 ΔN = 2ε·m·v_crit²/R（ε 取 1%）。
      // 注意 absTolerance 必须挂在**对照项**上：verify.js 只读 it.absTolerance，
      // 写在 probe 里是死代码（原来就是这么写的，贴壁附近会报假 FAIL）。
      items.push({
        label: '临界点法向力 N = mv_crit²/R − mg/cosα（贴壁裕度）', unit: 'N', value: L.Ncrit,
        absTolerance: Math.max(0.02 * m * gg, 0.02 * m * L.vCrit2 / R),
        probe: { kind: 'force', body: 'ball', comp: 'normal', mode: 'mag', window: 'auto@crit', reduce: 'min' }
      });
    }
    // 能量守恒与场强取值无关（只要球没脱离轨道），任何 Efac 下都该成立
    items.push({
      label: '机械能（含电场势能）全程守恒 ΔE = 0', unit: 'J', value: 0,
      note: '全程（含绕圈的每一圈）末帧−初帧；实测 |ΔE| ≈ 5e−5 J（SUB=' + SUB + '，约为初值的 1e−3 %）',
      probe: { kind: 'statDelta', key: 'mechanical', tolerance: 1e-6,
               absTolerance: 0.002 * m * gg * R }
    });
    fillWindows(items, ctx, g, L);
    return items;
  };

  /**
   * 用轨迹自身定位 B 点 / 临界点 / 末帧：取**到解析点距离最小**的那一帧。
   *
   * 不能用"y 最大"来定位 B：起点 A 与 B 等高（y = 1.8），最大值出现在第 0 帧，
   * 于是 B 点窗口被安在了出发点（实测 B 点速度读到的就是初速度 10.0）。
   * 几何点直接取自 geom()，是题目给定的已知几何，不构成自证。
   */
  function fillWindows(items, ctx, g, L) {
    var frames = ctx && ctx.frames;
    if (!frames || !frames.length) return;
    var iTop = nearestIndex(frames, g.B);
    var iCrit = nearestIndex(frames, L.g.crit);
    var dt = frames.length > 1 ? (frames[1].t - frames[0].t) : 1 / 60;
    var wTop = win(iTop), wCrit = win(iCrit), wLast = [frames[Math.max(0, frames.length - 2)].t, frames[frames.length - 1].t];
    items.forEach(function (it) {
      if (it.probe.window === 'auto@top') it.probe.window = wTop;
      if (it.probe.window === 'auto@crit') it.probe.window = wCrit;
      if (it.probe.window === 'auto@last') it.probe.window = wLast;
    });
    function win(i) {
      // 只保留最近的那**一帧**（±dt/4）：以前用 ±1 帧再取 max，会把"下一帧"的
      // 加速也读进来，B 点速度因此系统性偏高 1.6%（几乎顶到 2% 容差）。
      return [frames[i].t - dt * 0.25, frames[i].t + dt * 0.25];
    }
    /**
     * 到解析几何点最近的一帧。
     * 球在闭环里会一圈圈反复经过同一个点，所以取**第一次**"先靠近再远离"的局部极小；
     * 直接取全局最小会随机落到第 N 圈上（实测默认场景落到了第 4 圈 t≈4.07 s）。
     * 距离阈值 0.6R 用来排掉一个假极小：B 点到斜面上各点的距离在切点 J 处有个 1.9R 的
     * 局部极小（切线与 B 的方位关系），它不是 B 点。
     */
    function nearestIndex(frames, P) {
      var d = [], i;
      for (i = 0; i < frames.length; i++) {
        var b = frames[i].bodies && frames[i].bodies.ball;
        d.push(b ? Math.hypot(b.x - P[0], b.y - P[1]) : Infinity);
      }
      var k = 0, bd = Infinity;
      for (i = 0; i < d.length; i++) if (d[i] < bd) { bd = d[i]; k = i; }
      for (i = 1; i + 1 < d.length; i++) {
        if (d[i] <= d[i - 1] && d[i] <= d[i + 1] && d[i] <= 0.6 * g.R) return i;
      }
      return k;
    }
  }

  function register(add) {
    add({
      id: 'trackSlopeLoopE', title: '斜面→圆轨道内壁+匀强电场（组合·临界）', group: '组合模组',
      params: [
        { key: 'R', label: '圆轨道半径 R', unit: 'm', min: 0.4, max: 1.2, step: 0.05, value: 1.0 },
        { key: 'mass', label: '小球质量 m', unit: 'kg', min: 0.05, max: 0.5, step: 0.01, value: 0.1 },
        { key: 'q', label: '电荷量 q', unit: 'mC', min: 0.1, max: 5, step: 0.1, value: 1.0 },
        { key: 'Efac', label: '场强（× 平衡值）', unit: '×', min: 0, max: 2, step: 0.01, value: 1.0 },
        { key: 'v0', label: 'A 点初速度 v₀', unit: 'm/s', min: 0, max: 20, step: 0.05, value: 10 },
        { key: 'theta', label: '斜面倾角 α', unit: '°', min: 20, max: 60, step: 1, value: 37 },
        { key: 'mu', label: '摩擦因数 μ', unit: '', min: 0, max: 0.5, step: 0.01, value: 0 },
        { key: 'g', label: '重力加速度 g', unit: 'm/s²', min: 9.8, max: 10, step: 0.1, value: 10 }
      ],
      tag: { level: '核心', note: '斜面+圆轨道内壁+匀强电场；临界点在等效重力最高点' },
      build: build, expect: build.expect
    });
  }

  return { register: register, geom: geom, analytics: analytics, makePath: makePath, build: build, _sub: SUB };
});
