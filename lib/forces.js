/*!
 * MrAwU（阿物先生）— lib/forces.js
 * 力组件库：把"力律"变成有测试的声明式组件 + 组合器。
 *
 * 为什么需要它（上一轮 track 模型 20 分钟代价几乎全在力律层）：
 *   ① `makePath` 漏拷直线段 `side` ⇒ 法向反号 ⇒ N=−1.252 N 被**静默跳过**，
 *      症状伪装成"自由落体、机械能 −162 J"，指向完全错误的方向；
 *   ② 势能记了两遍：引擎 verlet.js 已自己加 mgy，模型的 potential 又返回 mgy−qEx
 *      ⇒ 机械能根本不守恒；
 *   ③ 投影里的几何用上一步的弧长 ⇒ 法向方向滞后 ⇒ 理想约束做净正功 m·v⁴h²/2R²；
 *   ④ 每个模型各写一份力律 ⇒ 同类错误反复发生。
 *   本库用三个结构性约束消灭它们：
 *     · **力/势能成对**：每个组件同时给出力与"额外势能"，组合器统一求和（见 potential 注释 ⚠️）；
 *     · **接触法向 N<0 必须报错或显式处理**，禁止静默跳过（curveNormal 的 onNeg）；
 *     · **只有一个地方定义引擎记账约定**：force 只返回分项，potential 只返回 mgy 之外的额外项。
 *
 * 与引擎的接口（先读 lib/verlet.js 的 substep / accelOf / bookDelta，别猜）：
 *   · verlet 的 accelOf 把 parts 里**所有**分项求和（PARTS = gravity/gravitation/electric/
 *     normal/friction/applied/joint/damping，未给的视为不存在），所以力表只要给出现的分项；
 *   · 力按**子步中点时刻**取，且同一子步内 F1/F2 共用 lock(S) ⇒ 组件必须能接受 (t, S, lock)；
 *   · verlet buildFrame 里 `stats.potential += m·g·(y−refY)` **引擎自己加**，
 *     然后 `stats.mechanical += laws.potential(t,S)` —— 所以本库的 potential 只能返回"额外项"；
 *   · 事件/约束直接改速度的部分由 verlet.bookDelta(fn, defaultPart) 记账，
 *     组件本身**不**碰状态（纯函数），脱轨/投影仍归模型管。
 *
 * 力表形状：force(t,S,lock) → { <bodyId>: { parts: { gravity, electric, normal, friction,
 *            joint, applied, damping, gravitation: [fx,fy] } } }（缺省项视为 [0,0]）
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.PFA = root.PFA || {};
    root.PFA.forces = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // 与 verlet.PARTS 同名同序：写错名字的分项会被 accelOf 丢掉（力表里却看得见），
  // 这是"图上画得出来、物理上不生效"的经典死法，所以这里显式列出来做校验。
  var PARTS = ['gravity', 'gravitation', 'electric', 'normal', 'friction', 'applied', 'joint', 'damping'];

  function isFn(v) { return typeof v === 'function'; }
  function vec(v) { return [v[0] || 0, v[1] || 0]; }
  function add2(a, b) { return [a[0] + b[0], a[1] + b[1]]; }
  function dot(a, b) { return a[0] * b[0] + a[1] * b[1]; }
  function perp(t) { return [-t[1], t[0]]; }

  function bodyOf(ctx) {
    var S = ctx.S, id = ctx.body;
    if (!S || !S[id]) {
      throw new Error('forces: 状态里没有刚体 "' + id + '"（力组件必须作用在**动态**刚体上；' +
        '静态刚体不在 verlet 积分状态 S 里）。现有: ' + (S ? Object.keys(S).join(',') : '(空)'));
    }
    return S[id];
  }
  function need(v, what, hint) {
    if (v == null) throw new Error('forces: ' + what + ' 缺失' + (hint ? '（' + hint + '）' : ''));
    return v;
  }

  // ================================================================ 组件
  /**
   * 重力：F = [0, −m·g]。
   *
   * ⚠️ potential **必须返回 0**：引擎 verlet.js 的 buildFrame 已经自己把
   *    `stats.potential += m·g·(y−refY)` 加进机械能了。这里再返回 m·g·y 就是把重力势能
   *    记两遍 ⇒ mechanical = KE + 2mgy − qEx，沿轨道不守恒（上一轮实测初值 6.799 J，
   *    而正确初值是 5.000 J）。所以重力的"额外势能"恒为 0，见下方 assertPairing 的恒等检查。
   */
  function gravity(o) {
    var id = need(o.body, 'gravity.body');
    var m = need(o.m, 'gravity.m');
    var g = need(o.g, 'gravity.g');
    return {
      id: o.id || ('gravity:' + id),
      part: 'gravity',
      body: id,
      force: function () { return [0, -m * g]; },
      potential: function () { return 0; }   // ← 引擎已含 mgy，刻意返回 0
    };
  }

  /**
   * 匀强电场：F = q·E（水平/任意方向）。
   *   E: [Ex,Ey]（V/m）；q（C）；regions: null/[] = 全场，否则 [{x0,x1,y0,y1}] 含边界。
   * potential = −q(E·r)（**额外**势能：电场势能不在引擎的 mgy 里，必须由这里给出）。
   *
   * ⚠️ 区域分段：跨边界时势能**可以不连续**（界面处有面电荷），而且力在那里跳变。
   *    能量守恒**只在段内严格成立**；跨边界必须用事件切步（nextEvent 切到边界），
   *    否则一步跨过界面会白得/白失 qE·Δx 的能量，听起来像"永动机"。
   *    这里 force 与 potential 用**同一个 inRegion 判据**，保证段内力/势能严格配对。
   */
  function uniformElectric(o) {
    var id = need(o.body, 'uniformElectric.body');
    var q = need(o.q, 'uniformElectric.q');
    var E = vec(need(o.E, 'uniformElectric.E'));
    var regions = o.regions || null;
    if (!q || (!E[0] && !E[1])) {
      return { id: o.id || ('electric:' + id), part: 'electric', body: id,
               force: function () { return [0, 0]; }, potential: function () { return 0; } };
    }
    function inRegion(x, y) {
      if (!regions || !regions.length) return true;
      for (var i = 0; i < regions.length; i++) {
        var r = regions[i];
        if (x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1) return true;
      }
      return false;
    }
    return {
      id: o.id || ('electric:' + id),
      part: 'electric',
      body: id,
      inRegion: inRegion,
      E: E, q: q,
      force: function (ctx) {
        var b = bodyOf(ctx);
        return inRegion(b.x, b.y) ? [q * E[0], q * E[1]] : [0, 0];
      },
      potential: function (ctx) {
        var b = bodyOf(ctx);
        // −∇U = −∇(−q E·r) = qE ⇒ 与 force 严格配对（段内）
        return inRegion(b.x, b.y) ? -q * (E[0] * b.x + E[1] * b.y) : 0;
      }
    };
  }

  /**
   * 固定点电荷系对**运动点电荷**的库仑力 + 库仑势能（力/势能成对，见约定 ①）。
   *
   *   charges = [{ x, y, Q }]（Q 单位 C，**自带符号**：Q>0 为斥力；也接受 field.js 的 `q` 键）
   *   F(r) = Σ k·q·Qᵢ·(rᵢ)/|rᵢ|³ ,  rᵢ = 小球位置 − 第 i 个点电荷位置
   *   U(r) = Σ k·q·Qᵢ/|rᵢ|          ← **额外**势能（引擎 verlet 只自己加 mgy，见约定 ①）
   * 自检：−∇U = F（node/tests.mjs 用中心差分核过），所以势能必须逐电荷都写成 kqQ/r 的形式。
   *
   * ⚠️ r → 0：**抛错并打印状态**（点电荷重合处场强发散，真跑下去只会得到 NaN/Infinity
   *    或 1e11 N 这种没有任何教学意义的数）。这里不做"静默钳制"——
   *    题目要求"显式抛错并打印状态"。若模型需要"到点电荷附近就停"，请自己给 exitPolicy
   *    并在 project 里停住，不要把钳制塞进力组件。
   * ⚠️ 与 gravity 一样是**纯函数**：只在 force()/potential() 里读 ctx.S，绝不写回状态
   *    （verlet 同一子步会调 force 两次：子步起点 + 预测点，写回 ⇒ 残差爆炸）。
   */
  function coulomb(o) {
    var id = need(o.body, 'coulomb.body');
    var q = need(o.q, 'coulomb.q');
    var k = o.k == null ? 8.9875517923e9 : o.k;            // 库仑常量 k = 1/(4πε₀)
    var rMin = o.rMin == null ? 1e-9 : o.rMin;             // 重合判据（m）：低于它就是"几何不合法"
    if (!(rMin > 0)) throw new Error('forces: coulomb.rMin 必须是正数（实得 ' + rMin + '）');
    var src = o.charges || [];
    var charges = [];
    src.forEach(function (c, i) {
      if (!c) return;
      var Q = c.Q != null ? c.Q : c.q;                     // 兼容 lib/field.js 的 { x, y, q }
      var x = Number(c.x), y = Number(c.y), QQ = Number(Q);
      if (!isFinite(x) || !isFinite(y) || !isFinite(QQ)) {
        throw new Error('forces: coulomb.charges[' + i + '] 必须是有限数 { x, y, Q }；实得 ' +
          JSON.stringify(c));
      }
      charges.push({ x: x, y: y, Q: QQ });
    });
    if (!charges.length) throw new Error('forces: coulomb 至少需要一个固定点电荷（charges 为空 ⇒ ' +
      '这题里既没有力也没有势能，属于建模错误，不静默返回 0）');

    /** rᵢ = 小球位置 − 电荷位置；共用的重合检查（force / potential 同一判据，力/势能必须严格配对） */
    function sep(b, c) {
      var rx = b.x - c.x, ry = b.y - c.y;
      var r = Math.sqrt(rx * rx + ry * ry);
      if (!(r > rMin) || !isFinite(r)) {
        throw new Error('forces: coulomb 在 t=' + Number(ctxT).toFixed(6) + ' s 处小球与点电荷 ' +
          '重合/过近（r=' + r + ' m ≤ rMin=' + rMin + ' m；球 (' + b.x + ',' + b.y + ')，' +
          '电荷 (' + c.x + ',' + c.y + ')）—— 场强与势能在此发散。禁止静默给 NaN/Infinity：' +
          '请按 exitPolicy 在到达点电荷之前停住，或调整几何/参数。');
      }
      return { rx: rx, ry: ry, r: r };
    }
    var ctxT = 0;                                          // 只用于错误信息（不参与物理）
    return {
      id: o.id || ('coulomb:' + id),
      part: o.part || 'electric',                          // 库仑力记在 electric 分项（见任务约定）
      body: id,
      k: k, q: q, charges: charges,
      rMin: rMin,
      force: function (ctx) {
        ctxT = ctx.t;
        var b = bodyOf(ctx);
        var fx = 0, fy = 0;
        for (var i = 0; i < charges.length; i++) {
          var s = sep(b, charges[i]);
          var c = k * q * charges[i].Q / (s.r * s.r * s.r);
          fx += c * s.rx; fy += c * s.ry;
        }
        if (!isFinite(fx) || !isFinite(fy)) {
          throw new Error('forces: coulomb 算出非有限力 (' + fx + ',' + fy + ') —— 检查电荷/几何');
        }
        return [fx, fy];
      },
      potential: function (ctx) {
        ctxT = ctx.t;
        var b = bodyOf(ctx);
        var u = 0;
        for (var i = 0; i < charges.length; i++) {
          var s = sep(b, charges[i]);
          u += k * q * charges[i].Q / s.r;
        }
        if (!isFinite(u)) {
          throw new Error('forces: coulomb 算出非有限势能 ' + u + ' —— 检查电荷/几何');
        }
        return u;
      }
    };
  }

  /**
   * 曲线上接触（内壁）的解析法向力：
   *     N = m·v_t²·κ − F_其它·n̂ ,   n̂ 指向曲率中心（内壁）;  v_t = v·t̂
   * 其中 F_其它 = 重力 + 电场力（+ 其它不沿切向的已知外力，用 others 传入）。
   * 力的方向 = N·n̂。直线段 κ=0，法向由路径的 side 决定（"球在哪一侧"）。
   *
   * ⚠️ N < 0 = 轨道推不住球 = 脱离。**禁止静默跳过**（上一轮就是这么丢掉 N=−1.252 N 的：
   *    力表里法向凭空消失，症状伪装成自由落体、机械能 −162 J，指向完全错误的方向）。
   *    两种合法处置：
   *      · onNeg = null（默认）：**抛错**，并把 t / s / N / κ / v_t / 位置一起打印出来；
   *      · onNeg = function (info) {...}：由模型显式处理（例如按 exitPolicy 调 leaveTrack）。
   *    第三个参数 lock 里可以放 { negHandled:true }，用于"已按策略处理、别再报错"的场景。
   *
   * path 接口（lib/track.js 的 makePath 返回值，别猜）：
   *   pointAt(s)   → [x,y]                 曲线上弧长 s 处的点
   *   tangentAt(s) → [tx,ty]               单位切向（s 增大方向 = 运动方向）
   *   normalAt(s)  → [nx,ny]               **内法向**：指向曲率中心；直线段取 side 那一侧
   *   kappaAt(s)   → κ = 1/R（直线段 = 0）
   *   muAt(s)      → 该段摩擦因数（本组件不用，交给 kineticFriction）
   *   sOf(x,y)     → 全局最近点弧长（**只用于初始定位**；绕圈/接点处会跳段，运行期要用局部锚点）
   *   segEnd(i)    → 第 i 段末端弧长；segIndexAt(s) → s 落在第几段
   *   segs[i]      → { kind, s0, len, mu, side, r, c, cyclic, ... }
   *
   * geometry(ctx, commit) → { s, p, t, n, k, mu }：**由模型注入**的路径状态函数。
   *   commit=true 只允许在 project 里调用（提交弧长基准）；force/nextEvent 里必须按传入状态
   *   算几何但不提交（否则预测点污染弧长基准；而如果沿用上一步的几何，法向方向滞后，
   *   理想约束会做净正功 ≈ m·v⁴h²/2R²，实测 0.35 J/s @ v=10,R=1,h=1/1440）。
   */
  function curveNormal(o) {
    var id = need(o.body, 'curveNormal.body');
    var m = need(o.m, 'curveNormal.m');
    var g = o.g == null ? 0 : o.g;
    var geom = need(o.geometry, 'curveNormal.geometry',
      '形如 function (ctx, commit) { return { s, p, t, n, k, mu } }');
    var onNeg = o.onNeg || null;
    if (o.onNeg !== undefined && o.onNeg !== null && !isFn(o.onNeg)) {
      throw new Error('forces: curveNormal.onNeg 必须是函数或 null（null = N<0 直接抛错）');
    }

    return {
      id: o.id || ('normal:' + id),
      part: 'normal',
      body: id,
      /**
       * N 的解析式（**不施加力**）：project / 脱离判定 / 探针必须复用同一个数，
       * 否则"力表里的 N"和"判定脱离用的 N"会各算一份、慢慢分叉。
       * ctx.__ps 由 force() 顺带写回，命中时直接复用同一份几何（避免同子步两次不同几何）。
       */
      normalForce: function (ctx, ps) {
        var b = bodyOf(ctx);
        var g0 = (ctx && ctx.__ps && ctx.__ps.t) ? ctx.__ps : (ps || geom(ctx, false));
        var vt = b.vx * g0.t[0] + b.vy * g0.t[1];
        var other = [0, -m * g];
        other = add2(other, isFn(o.electric) ? vec(o.electric(ctx)) : [0, 0]);
        (o.others || []).forEach(function (f) { other = add2(other, vec(isFn(f) ? f(ctx) : f)); });
        return m * vt * vt * g0.k - dot(other, g0.n);
      },
      force: function (ctx, lock) {
        var b = bodyOf(ctx);
        var ps = geom(ctx, false);
        var vt = b.vx * ps.t[0] + b.vy * ps.t[1];
        var other = [0, -(o.m) * g];                       // 重力
        var Fe = isFn(o.electric) ? vec(o.electric(ctx)) : [0, 0];
        other = add2(other, Fe);
        (o.others || []).forEach(function (f) { other = add2(other, vec(isFn(f) ? f(ctx) : f)); });
        var N = m * vt * vt * ps.k - dot(other, ps.n);
        ctx.__ps = ps;                                     // 让 project / 审计复用同一份几何
        if (N < 0) {
          var info = {
            component: 'curveNormal', body: id, t: ctx.t, s: ps.s,
            N: N, kappa: ps.k, vt: vt, p: ps.p, n: ps.n, t_: ps.t,
            parts: { gravity: [0, -m * g], electric: Fe }, other: other
          };
          if (lock && lock.negHandled) return [0, 0];
          if (isFn(onNeg)) {
            // onNeg(info, S)：info 是脱离诊断；第二个参数是**当前子步的完整状态**，
            // 便于模型立即按 exitPolicy 处置（例如冻结速度）。返回力矢量或 null（=0）。
            var r = onNeg(info, ctx.S);
            return isFn(r) ? r(ctx) : vec(r || [0, 0]);
          }
          throw new Error('forces: curveNormal 在 t=' + Number(ctx.t).toFixed(6) +
            ' s、s=' + ps.s.toFixed(6) + ' m 处算出 N=' + N.toFixed(6) + ' N < 0 —— ' +
            '球已脱离内壁。禁止静默跳过：请给 onNeg（显式处理，例如按 exitPolicy 停/转抛体）' +
            '或把 exitPolicy 判定放在 project 里。');
        }
        // 直线段 κ=0 时 N 也可能 >0（外力把球压向轨道）——同样按 N·n̂ 施加，方向由 side 决定
        return [N * ps.n[0], N * ps.n[1]];
      },
      potential: function () { return 0; }   // 接触力不做功（理想约束）：额外势能恒为 0
    };
  }

  /**
   * 动/静摩擦（一个组件，两个分支，判据只写一次）：
   *   切向其它力 F_t = (F_其它)·t̂ （重力 + 电场 + ...，摩擦力自己是未知量）
   *   · 近静止（|v_t| ≤ vEps）且 |F_t| ≤ μN ⇒ **静摩擦咬住**，f = −F_t（合力切向为 0）
   *   · 否则动摩擦：f = −sign(v_t)·μN
   *   ⚠️ 皮带模型（belt）当前缺"v0 = 带速时的静摩擦分支"：物块与带共速时若还按
   *      动摩擦 −sign(v_t)·μN 取，就等于凭空多一个恒力 ⇒ 加速度错、随后又触发共速事件抖动。
   *      这里把正确判据实现一次，其它模型照抄这一处即可。
   *   surfaceNormal：法向力提供者，二选一
   *      · function (ctx) → N（解析回代：曲线上用 curveNormal 的 N，斜面用 mg·cosα+qE·sinα）
   *      · { n:[nx,ny], N:number|function } 直接给方向与大小
   *   方向 n̂ 必须与 surfaceNormal 一致（曲线上即指向曲率中心的 n̂）。
   */
  function kineticFriction(o) {
    var id = need(o.body, 'kineticFriction.body');
    var mu = need(o.mu, 'kineticFriction.mu');
    var geom = o.geometry || null;
    if (!isFn(o.surfaceNormal) && !(o.surfaceNormal && o.surfaceNormal.n)) {
      throw new Error('forces: kineticFriction.surfaceNormal 必须是 function(ctx)→N 或 {n,N}');
    }
    var vEps = o.vEps == null ? 1e-6 : o.vEps;
    /** 法向单位矢量 n̂：优先用同一子步的路径几何，其次用显式给的 surfaceNormal.n */
    function nOf(ctx) {
      var ps = ctx.__ps || (geom ? geom(ctx, false) : null);
      if (ps && ps.n) return ps.n;
      if (o.surfaceNormal && o.surfaceNormal.n) return vec(o.surfaceNormal.n);
      throw new Error('forces: kineticFriction 拿不到法向方向（需要 geometry 或 surfaceNormal.n）');
    }
    /** 支持力大小 N：函数式（解析回代）或 { n, N } 形式 */
    function NOf(ctx) {
      if (isFn(o.surfaceNormal)) return o.surfaceNormal(ctx);
      return isFn(o.surfaceNormal.N) ? o.surfaceNormal.N(ctx) : o.surfaceNormal.N;
    }
    /** 唯一判据：返回 { N, t̂, v_t, F_t, f, stick }（力、探针、审计全走这一处） */
    function stateOf(ctx) {
      var b = bodyOf(ctx);
      var n = nOf(ctx);
      var t = geom ? geom(ctx, false).t : perp(n);
      var N = NOf(ctx);
      var tt = [-n[1], n[0]];                               // n̂ 逆时针转 90° 的候选切向
      if (dot(tt, t) < 0) tt = [n[1], -n[0]];               // 与本段切向对齐（保证 v_t 的符号有意义）
      // 切向"其它力"（重力 + 电场 + 显式 others）：摩擦力自己是未知量，不算在内
      var oth = [0, -(o.m == null ? 0 : o.m) * (o.g == null ? 0 : o.g)];
      oth = add2(oth, isFn(o.electric) ? vec(o.electric(ctx)) : [0, 0]);
      (o.others || []).forEach(function (f) { oth = add2(oth, vec(isFn(f) ? f(ctx) : f)); });
      var Ft = dot(oth, tt);
      var vt = b.vx * tt[0] + b.vy * tt[1];
      var fmax = mu * Math.max(0, N);
      var stick = N > 0 && Math.abs(vt) <= vEps && Math.abs(Ft) <= fmax;
      return { N: N, t: tt, v_t: vt, F_t: Ft, f_max: fmax,
               f: N > 0 ? (stick ? -Ft : -Math.sign(vt || 1) * fmax) : 0, stick: stick };
    }
    return {
      id: o.id || ('friction:' + id),
      part: 'friction',
      body: id,
      /** 判据本体（公开给探针/测试：`N`、`f`、`stick` 与实际施加的力同源） */
      state: stateOf,
      force: function (ctx) {
        var st = stateOf(ctx);
        return [st.f * st.t[0], st.f * st.t[1]];
      },
      potential: function () { return 0; }   // 摩擦耗散，不进势能
    };
  }
  /** 静摩擦是同一判据的"咬住"分支，单独导出便于在模型里显式声明意图 */
  function staticFriction(o) {
    var c = kineticFriction(o);
    var stOf = c.state;
    return {
      id: o.id || ('staticFriction:' + o.body), part: 'friction', body: c.body,
      state: stOf,
      force: function (ctx) {
        var st = stOf(ctx);
        return st.stick ? [st.f * st.t[0], st.f * st.t[1]] : [0, 0];
      },
      potential: function () { return 0; }
    };
  }

  /**
   * 弹簧（线性、可带阻尼）：F = −k(|r|−rest)·r̂ − c·v（r = 位置 − anchor）。
   * potential = ½k(|r|−rest)²（**额外**势能，引擎不含它）。
   * 阻尼（c>0）不是保守力 ⇒ potential 里不含它（会破坏"力/势能成对"，这是有意的）。
   */
  function spring(o) {
    var id = need(o.body, 'spring.body');
    var k = need(o.k, 'spring.k');
    var rest = o.rest == null ? 0 : o.rest;
    var c = o.c || 0;
    var anchor = vec(o.anchor || [0, 0]);
    function rel(ctx) {
      var b = bodyOf(ctx);
      return [b.x - anchor[0], b.y - anchor[1]];
    }
    return {
      id: o.id || ('spring:' + id), part: 'applied', body: id,
      force: function (ctx) {
        var b = bodyOf(ctx), r = rel(ctx);
        var L = Math.hypot(r[0], r[1]) || 1e-12;
        var f = -k * (L - rest) / L;
        return [f * r[0] - c * b.vx, f * r[1] - c * b.vy];
      },
      potential: function (ctx) {
        var r = rel(ctx), L = Math.hypot(r[0], r[1]);
        return 0.5 * k * (L - rest) * (L - rest);
      }
    };
  }

  /** 线性阻力：F = −c·v（耗散，额外势能 0）。 */
  function drag(o) {
    var id = need(o.body, 'drag.body');
    var c = need(o.c, 'drag.c');
    return {
      id: o.id || ('drag:' + id), part: 'damping', body: id,
      force: function (ctx) { var b = bodyOf(ctx); return [-c * b.vx, -c * b.vy]; },
      potential: function () { return 0; }
    };
  }

  // ================================================================ 组合器
  /**
   * composeForces(components, opts) → { components, force, potential, hasPotential, audits }
   *   opts.geometry  注入的路径状态函数（curveNormal / kineticFriction 用）
   *   opts.potential 追加的"额外势能"函数（例如皮带/场外的手写项）
   *   opts.body      单刚体简写（组件的 body 缺省值）
   *
   * force(t,S,lock)：把每个组件的力**按 part 累加**进力表；缺省分项不写（引擎视为 0）。
   * potential(t,S)：把每个组件的额外势能相加 —— ⚠️ **引擎已经自己加了 mgy**，
   *   所以这里只返回 mgy 之外的部分（重力组件恒返回 0，见 gravity 注释）。
   * audits：可被模型 expect 或 node/tests.mjs 直接调用的能量审计（见 energyAudit）。
   */
  function composeForces(components, opts) {
    var o = opts || {};
    var comps = (components || []).filter(Boolean);
    var potFun = o.potential || null;
    if (!comps.length && !potFun) throw new Error('forces: composeForces 至少需要一个组件');
    comps.forEach(function (c) {
      if (!c || !isFn(c.force)) throw new Error('forces: 组件缺少 force(ctx)：' + (c && c.id));
      if (!isFn(c.potential)) {
        throw new Error('forces: 组件 "' + c.id + '" 缺少 potential(ctx) —— ' +
          '力/势能必须成对提供（不产生势能的力请显式 potential(){return 0}），' +
          '否则"势能记两遍/漏记"这类错误又会在结构上重新出现');
      }
      var p = c.part || 'applied';
      if (PARTS.indexOf(p) === -1) {
        throw new Error('forces: 组件 "' + c.id + '" 的分项名 "' + p + '" 不在引擎 PARTS 里（' +
          PARTS.join('/') + '）：这种力会被 verlet.accelOf 丢掉，力表里却看得见');
      }
    });

    var lastInfo = null;   // 供 onNeg 之外的诊断读取（最后一次 force 的几何）

    function context(t, S, lock) {
      return {
        t: t, S: S, lock: lock || null,
        geometry: o.geometry || null,
        __ps: null
      };
    }
    /** 单刚体 ctx（组件 force/potential 的调用约定：ctx.body 一定是当前那个刚体） */
    function forceOne(id, t, S, lock) {
      var ctx = context(t, S, lock);
      ctx.body = id;
      var parts = {};
      var total = [0, 0];
      comps.forEach(function (c) {
        if (c.body && c.body !== id) return;
        ctx.__ps = null;
        var f = c.force(ctx, lock);
        if (f == null) return;
        f = vec(f);
        var p = c.part || 'applied';
        parts[p] = parts[p] ? add2(parts[p], f) : f;
        total = add2(total, f);
      });
      lastInfo = ctx.__ps ? { s: ctx.__ps.s } : lastInfo;
      return { id: id, parts: parts, total: total, geometry: ctx.__ps };
    }

    function force(t, S, lock) {
      var out = {};
      Object.keys(S || {}).forEach(function (id) { out[id] = { parts: forceOne(id, t, S, lock).parts }; });
      return out;
    }
    /** 带 total / geometry 的详细版（审计、脱离判定、力表探针都能用；引擎仍只吃 force()） */
    function forceDetail(t, S, lock) {
      var out = {};
      Object.keys(S || {}).forEach(function (id) { out[id] = forceOne(id, t, S, lock); });
      return out;
    }
    function potential(t, S) {
      var sum = 0;
      Object.keys(S || {}).forEach(function (id) {
        var ctx = context(t, S, null);
        ctx.body = id;
        comps.forEach(function (c) {
          if (c.body && c.body !== id) return;
          if (!isFn(c.potential)) return;
          var u = c.potential(ctx);
          if (u == null) return;
          if (!isFinite(u)) throw new Error('forces: 组件 "' + c.id + '" 的势能不是有限数：' + u +
            '（位置 ' + S[id].x + ',' + S[id].y + '）—— 静默累加会把机械能变成 NaN');
          sum += u;
        });
      });
      if (potFun) {
        var extra = potFun(t, S);
        if (isFinite(extra)) sum += extra;
      }
      return sum;
    }
    function byId(id) {
      return comps.filter(function (c) { return !c.body || c.body === id; });
    }
    return {
      components: comps,
      force: force,
      forceDetail: forceDetail,
      potential: potential,
      hasPotential: comps.some(function (c) { return c.part !== 'none'; }) || !!potFun,
      byId: byId,
      lastInfo: function () { return lastInfo; },
      /** 独立能量审计：不读模型自己的 analytics，只用帧数据与 components 的势能 */
      audits: {
        energy: function (frames, auditOpts) {
          return energyAudit(frames, Object.assign({ components: comps, potential: potFun }, auditOpts || {}), o.g);
        }
      }
    };
  }

  // ================================================================ 能量审计
  /**
   * 独立能量审计：用**仿真帧数据**独立算 E = KE + m·g·y + U_额外（额外项由组件给出），
   * 报告相对初值的最大漂移与末帧漂移。刻意**不读**模型自己的 analytics / stats.mechanical，
   * 这样"势能记两遍"这种 bug 不会同时污染被测量与测量者（上一轮正是没法自查）。
   *
   * frames: verlet 的帧数组；opts.body: 只审计这个刚体（缺省=所有动态刚体）；
   * opts.potential: 额外势能 function(state)（给不出就用组件自带的势能）。
   * 返回 { ok, E0, Elast, dE_last, dE_worst, rel_worst, worstT, samples }
   */
  function energyAudit(frames, opts, gFallback) {
    var o = opts || {};
    var comps = o.components || [];
    var g = o.g != null ? o.g : (gFallback != null ? gFallback : 9.8);
    if (!frames || !frames.length) throw new Error('forces.energyAudit: 需要非空 frames');
    function extra(S) {
      if (isFn(o.potential)) return o.potential(S);
      var sum = 0;
      comps.forEach(function (c) {
        if (c.body && o.body && c.body !== o.body) return;
        if (!isFn(c.potential)) return;
        sum += c.potential({ t: 0, S: S, body: c.body }) || 0;
      });
      return sum;
    }
    function total(f) {
      var S = {}, ke = 0, uy = 0;
      Object.keys(f.bodies).forEach(function (id) {
        var b = f.bodies[id];
        if (b.type !== 'dynamic') return;
        if (o.body && id !== o.body) return;
        S[id] = { x: b.x, y: b.y, vx: b.vx, vy: b.vy };
        ke += 0.5 * b.mass * (b.vx * b.vx + b.vy * b.vy);
        uy += b.mass * g * b.y;
      });
      return { E: ke + uy + extra(S), ke: ke, uy: uy, u: extra(S), S: S };
    }
    var first = total(frames[0]), E0 = first.E;
    var last = total(frames[frames.length - 1]);
    var worst = 0, worstT = 0;
    for (var i = 0; i < frames.length; i++) {
      var d = total(frames[i]).E - E0;
      if (Math.abs(d) > Math.abs(worst)) { worst = d; worstT = frames[i].t; }
    }
    var scale = Math.max(Math.abs(E0), 1e-12);
    return {
      E0: E0, Elast: last.E,
      dE_last: last.E - E0, dE_worst: worst,
      rel_worst: Math.abs(worst) / scale, worstT: worstT,
      samples: frames.length,
      ok: Math.abs(worst) / scale <= (o.tolerance == null ? 1e-4 : o.tolerance),
      note: 'KE + mgy + 额外势能（独立于模型 analytics）；漂移按相对初值报告'
    };
  }

  // ================================================================ 自检
  /**
   * 力/势能配对检查（数值求导）：对每个组件在每个采样点上核对
   *     F ≈ −∇U ，即 Fi ≈ −(U(r+h·ei) − U(r−h·ei)) / (2h)
   * 重力势能由引擎提供、组件返回 0 ⇒ 这里对 gravity 只检查"potential 恒为 0 且 −∇U=0≠F"，
   * 用 expectPairing:false 跳过（这正是要显式记录的约定）。
   * 返回 { ok, rows:[{id, comp, err, scale}] }
   */
  function assertPairing(comps, samples, cfg) {
    var c = cfg || {};
    var h = c.h || 1e-6;
    var tol = c.tol == null ? 1e-4 : c.tol;
    var rows = [];
    (comps || []).forEach(function (comp) {
      if (!isFn(comp.potential) || !isFn(comp.force)) return;
      if (comp.expectPairing === false) return;   // gravity：势能由引擎提供，这里刻意不参与
      var worst = 0, worstAt = null;
      (samples || []).forEach(function (S) {
        var id = comp.body || Object.keys(S)[0];
        if (!S[id]) return;
        var f = vec(comp.force({ t: 0, S: S, body: id, lock: null }));
        var grad = [0, 0];
        [0, 1].forEach(function (k) {
          var Sp = {}, Sm = {};
          Object.keys(S).forEach(function (bid) {
            Sp[bid] = Object.assign({}, S[bid]); Sm[bid] = Object.assign({}, S[bid]);
          });
          if (k === 0) { Sp[id].x += h; Sm[id].x -= h; } else { Sp[id].y += h; Sm[id].y -= h; }
          grad[k] = ((comp.potential({ t: 0, S: Sp, body: id }) || 0) -
                     (comp.potential({ t: 0, S: Sm, body: id }) || 0)) / (2 * h);
        });
        var scale = Math.max(1e-9, Math.abs(f[0]) + Math.abs(f[1]));
        var rel = Math.hypot(f[0] + grad[0], f[1] + grad[1]) / scale;
        if (rel > worst) { worst = rel; worstAt = { S: S, f: f, grad: grad }; }
      });
      rows.push({ id: comp.id, comp: comp.id, rel: worst, ok: worst <= tol, at: worstAt });
    });
    return { ok: rows.every(function (r) { return r.ok; }), rows: rows, tol: tol };
  }

  /**
   * 组合器级自检（**结构断言**，与具体模型无关）：
   *   ① 组件必须成对给出 force/potential；
   *   ② 分项名必须落在引擎 PARTS 内；
   *   ③ 力表的分项之和必须等于 forceDetail 的 total（力表按 part 记账，别漏项）；
   *   ④ 势能必须有限；⑤ 重力类组件不许返回 mgy（potential 必须恒为 0）。
   * 在组合时调用（composeForces 里已内建 ①②），③ 在测试里对给定状态调用。
   */
  function auditForceTable(forced, S) {
    var errs = [];
    Object.keys(forced.parts || {}).forEach(function (p) {
      if (PARTS.indexOf(p) === -1) errs.push('分项 "' + p + '" 不在引擎 PARTS 里，会被 accelOf 丢掉');
    });
    var sx = 0, sy = 0;
    Object.keys(forced.parts).forEach(function (p) { sx += forced.parts[p][0]; sy += forced.parts[p][1]; });
    var tx = forced.total[0], ty = forced.total[1];
    if (Math.hypot(sx - tx, sy - ty) > 1e-12 * Math.max(1, Math.hypot(tx, ty))) {
      errs.push('分项之和 (' + sx + ',' + sy + ') ≠ total (' + tx + ',' + ty + ')');
    }
    return errs;
  }

  return {
    PARTS: PARTS,
    gravity: gravity,
    uniformElectric: uniformElectric,
    coulomb: coulomb,
    curveNormal: curveNormal,
    kineticFriction: kineticFriction,
    staticFriction: staticFriction,
    spring: spring,
    drag: drag,
    composeForces: composeForces,
    energyAudit: energyAudit,
    assertPairing: assertPairing,
    auditForceTable: auditForceTable
  };
});
