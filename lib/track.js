/*!
 * MrAwU（阿物先生）— lib/track.js
 * 通用"轨道"抽象：分段路径（直线 + 圆弧）· 弧长参数化 · 内壁解析法向力
 *
 * 为什么需要它（Phase 1 的核心）：
 *   过去"斜面滑下 → 平滑滑上圆轨道 → 整个装置在电场中"这类组合题，
 *   每一段都是现成模型，但组合方式不在能力范围内，只能每题重写一遍几何与受力律。
 *   这里把"轨道"变成一个**通用模型**：路径由若干段声明式拼成
 *     - line: 从 a 到 b（s 增大方向就是运动方向）
 *     - arc : 圆心 c、半径 R、角度从 a0 变到 a1（内壁：法向指向圆心）
 *   状态仍是 (x, y, vx, vy)（渲染/校验都不用改），约束用 project 施加：
 *     · 力表里给出**解析法向力** N（不是靠多边形接触近似）→ 力读数、探针都精确
 *     · project 只做几何纠偏（把位置拉回曲线、去掉残余法向速度），纠偏量记账成正常冲量
 *   相切拼接由 checkTangency 静态校验：差一点直接报错，不允许带着错的几何跑。
 *
 * 离开轨道（N→0）的处置按场景声明（见 SKILL.md / references）：
 *   'stop' : 模拟停止（冻结 + 标记），用于"题目要的答案都已产生、且未提到后续运动"
 *   'free' : 不提示、自动转抛体（同样只受 mg 与 qE）
 *   'error': 答案还没出来就脱离 → 直接报错（说明建模与题设不符）
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.PFA = root.PFA || {};
    root.PFA.track = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var EPS = 1e-9;
  var TAU = 2 * Math.PI;

  // ---------------------------------------------------------------- 路径
  /**
   * 由段声明构造路径。段按顺序首尾相接，累计弧长用于参数化。
   *   { kind:'line', a:[x,y], b:[x,y], mu, side }   // side: 球在前进方向的哪一侧（-1 = 右侧/下侧）
   *   { kind:'arc',  c:[x,y], r, a0, a1, mu }       // a1 可小于 a0（反向绕行）
   * 圆弧段可加 cyclic:true 表示"首尾重合的闭环"（整圈轨道 r≤R 的内壁把球关在里面）：
   * 此时弧长参数在段末自动折回段首（同一物理点，θ 差 2π），球可以一直绕圈。
   */
  function makePath(spec) {
    var segs = [];
    var s = 0;
    (spec.segments || []).forEach(function (sg) {
      if (sg.kind === 'line') {
        var len = Math.hypot(sg.b[0] - sg.a[0], sg.b[1] - sg.a[1]);
        if (!(len > EPS)) throw new Error('track: 直线段长度为 0');
        segs.push({
          kind: 'line', a: sg.a, b: sg.b, len: len, s0: s, mu: sg.mu || 0, label: sg.label || '',
          // side 必须原样带上：normalAt 靠它决定直线段法向朝向哪一侧。
          // 漏掉它会让法向反号 ⇒ 解析法向力 N 变成负的 ⇒ 力表里法向力凭空消失，
          // 而且 onEvent 会误判"脱离轨道"（实测：小球在斜面末端就被判脱离并冻结）。
          side: sg.side
        });
        s += len;
      } else if (sg.kind === 'arc') {
        var sweep = sg.a1 - sg.a0;
        var len2 = Math.abs(sweep) * sg.r;
        if (!(len2 > EPS)) throw new Error('track: 圆弧段弧长为 0');
        segs.push({
          kind: 'arc', c: sg.c, r: sg.r, a0: sg.a0, a1: sg.a1, sweep: sweep,
          dir: sweep >= 0 ? 1 : -1, len: len2, s0: s, mu: sg.mu || 0, label: sg.label || '',
          inner: sg.inner !== false,           // 默认内壁（法向指向圆心）
          cyclic: sg.cyclic === true           // 闭环：弧长到段末折回段首
        });
        s += len2;
      } else {
        throw new Error('track: 未知段类型 ' + sg.kind);
      }
    });
    if (!segs.length) throw new Error('track: 至少要有一段');
    var total = s;

    function segIndexAt(sv) {
      if (sv <= 0) return 0;
      for (var i = 0; i < segs.length; i++) {
        if (sv <= segs[i].s0 + segs[i].len + EPS) return i;
      }
      return segs.length - 1;
    }
    function localOf(sv) {
      var i = segIndexAt(sv);
      var sg = segs[i];
      return { i: i, sg: sg, u: Math.max(0, Math.min(1, (sv - sg.s0) / sg.len)) };
    }
    function pointAt(sv) {
      var L = localOf(sv), sg = L.sg;
      if (sg.kind === 'line') {
        return [sg.a[0] + (sg.b[0] - sg.a[0]) * L.u, sg.a[1] + (sg.b[1] - sg.a[1]) * L.u];
      }
      var th = sg.a0 + sg.sweep * L.u;
      return [sg.c[0] + sg.r * Math.cos(th), sg.c[1] + sg.r * Math.sin(th)];
    }
    function tangentAt(sv) {
      var L = localOf(sv), sg = L.sg;
      if (sg.kind === 'line') {
        var dx = sg.b[0] - sg.a[0], dy = sg.b[1] - sg.a[1], n = Math.hypot(dx, dy);
        return [dx / n, dy / n];
      }
      var th = sg.a0 + sg.sweep * L.u;
      return [-Math.sin(th) * sg.dir, Math.cos(th) * sg.dir];
    }
    /** 内法向：指向曲率中心（内壁时轨道推力的方向）；直线段取"球所在的一侧" */
    function normalAt(sv) {
      var L = localOf(sv), sg = L.sg;
      if (sg.kind === 'line') {
        var t = tangentAt(sv);
        var sign = sg.side === -1 ? -1 : 1;              // 直线段需声明球在哪一侧
        return [-t[1] * sign, t[0] * sign];
      }
      var th = sg.a0 + sg.sweep * L.u;
      return sg.inner ? [-Math.cos(th), -Math.sin(th)] : [Math.cos(th), Math.sin(th)];
    }
    function kappaAt(sv) {
      var sg = localOf(sv).sg;
      return sg.kind === 'arc' ? 1 / sg.r : 0;            // 直线段曲率为 0
    }
    function muAt(sv) { return localOf(sv).sg.mu || 0; }
    /** 由世界坐标反查弧长（用于把初始位置放到轨道上） */
    function sOf(x, y) {
      var best = null, bd = Infinity;
      for (var i = 0; i < segs.length; i++) {
        var sg = segs[i], u, d;
        if (sg.kind === 'line') {
          var dx = sg.b[0] - sg.a[0], dy = sg.b[1] - sg.a[1], L2 = dx * dx + dy * dy;
          u = ((x - sg.a[0]) * dx + (y - sg.a[1]) * dy) / L2;
          u = Math.max(0, Math.min(1, u));
          d = Math.hypot(x - (sg.a[0] + dx * u), y - (sg.a[1] + dy * u));
        } else {
          var th = Math.atan2(y - sg.c[1], x - sg.c[0]);
          var rel = (th - sg.a0) / sg.sweep;             // 归一化到 [0,1]
          rel = Math.max(0, Math.min(1, rel));
          u = rel;
          d = Math.abs(Math.hypot(x - sg.c[0], y - sg.c[1]) - sg.r);
        }
        if (d < bd) { bd = d; best = sg.s0 + sg.len * u; }
      }
      return best;
    }
    /** 相切校验：相邻段在接点处的切向必须一致（差一点都报错） */
    function checkTangency(tol) {
      var t0 = tol == null ? 1e-6 : tol;
      var bad = [];
      for (var i = 0; i + 1 < segs.length; i++) {
        var pA = segs[i].s0 + segs[i].len - 1e-7, pB = segs[i + 1].s0 + 1e-7;
        var tA = tangentAt(pA), tB = tangentAt(pB);
        var dot = tA[0] * tB[0] + tA[1] * tB[1];
        if (dot < 1 - t0) {
          bad.push({ i: i, dot: dot,
            at: pointAt(segs[i].s0 + segs[i].len) });
        }
      }
      return bad;
    }
    return {
      segs: segs, total: total,
      pointAt: pointAt, tangentAt: tangentAt, normalAt: normalAt,
      kappaAt: kappaAt, muAt: muAt, sOf: sOf, segIndexAt: segIndexAt,
      segEnd: function (i) { return segs[i].s0 + segs[i].len; },
      checkTangency: checkTangency
    };
  }

  // ---------------------------------------------------------------- 受力律
  /**
   * cfg = {
   *   path,                       // makePath 的返回值
   *   body: 'ball',               // 轨道上的物体 id
   *   mass, g,
   *   q,                          // 电荷（C）；无电场填 0
   *   field: null | { E:[Ex,Ey], regions:null | [{x0,x1,y0,y1}] },
   *   exitPolicy: 'stop' | 'free' | 'error',
   *   answersReadyAt: 数值|函数,   // 判定"答案是否已产生"（用于 exitPolicy 的安全检查）
   *   slip: 'auto'                // 是否允许静止（stiction）；默认自动
   * }
   */
  function makeTrackLaws(cfg) {
    var path = cfg.path, id = cfg.body || 'ball', m = cfg.mass, g = cfg.g;
    var q = cfg.q || 0;
    var policy = cfg.exitPolicy || 'stop';
    var st = { seg: 0, exited: false, exitT: null, exitReason: null, s: null, stopped: false };

    /** 电场力（匀强；regions 为空=全场；给了 regions 就按区域判定） */
    function eForce(x, y) {
      var f = cfg.field;
      if (!f || !q) return [0, 0];
      var inField = true;
      if (f.regions && f.regions.length) {
        inField = f.regions.some(function (r) {
          return x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1;
        });
      }
      return inField ? [q * f.E[0], q * f.E[1]] : [0, 0];
    }
    /** 电势能：V = −qE·r（全场时唯一；分区域时按区域分段） */
    function ePotential(x, y) {
      var f = cfg.field;
      if (!f || !q) return 0;
      if (f.regions && f.regions.length) {
        var v = 0;
        f.regions.forEach(function (r) {
          if (x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1) v -= q * (f.E[0] * x + f.E[1] * y);
        });
        return v;
      }
      return -q * (f.E[0] * x + f.E[1] * y);
    }
    /**
     * 弧长跟踪：以**上一次弧长**为锚点，在当前邻域内做增量推进（不做全局最近点搜索）。
     *
     * 为什么不能全局搜索：直线段与圆弧段在切点处相切，两段的点集在那附近几乎重合，
     * 全局最近点会在接点附近来回跳段，project 于是把球硬拽回去，表现为持续的能量泄漏。
     *
     * 圆弧段还必须用「角度增量」而不是「把 atan2 的角度夹进 [a0,a1]」：
     * atan2 只给出模 2π 的角度，θ 一旦越过 −180°（正是等效最高点与 B 所在的区域）
     * 夹取就会把它算成 rel=0，于是球在绕到下半圈后被硬拽回切点。
     * 这里统一改成：由锚点算 thRef，取 Δθ 归一到 (−π,π]，再沿弧长推进 Δs。
     */
    function localS(x, y, ref) {
      var span = 0.12, lo = ref - span, hi = ref + span;
      var best = ref, bd = Infinity;
      for (var i = 0; i < path.segs.length; i++) {
        var sg = path.segs[i], sv, d;
        if (sg.kind === 'line') {
          var dx = sg.b[0] - sg.a[0], dy = sg.b[1] - sg.a[1], L2 = dx * dx + dy * dy;
          var u = Math.max(0, Math.min(1, ((x - sg.a[0]) * dx + (y - sg.a[1]) * dy) / L2));
          sv = sg.s0 + sg.len * u;
          d = Math.hypot(x - (sg.a[0] + dx * u), y - (sg.a[1] + dy * u));
        } else {
          var refU = (ref - sg.s0) / sg.len;
          var thRef = sg.a0 + sg.sweep * refU;
          var th = Math.atan2(y - sg.c[1], x - sg.c[0]);
          var dth = th - thRef;
          dth -= TAU * Math.round(dth / TAU);
          sv = sg.s0 + sg.len * (refU + dth / sg.sweep);
          d = Math.abs(Math.hypot(x - sg.c[0], y - sg.c[1]) - sg.r);
        }
        if (sv < lo - 1e-12 || sv > hi + 1e-12) continue;
        if (d < bd) { bd = d; best = sv; }
      }
      return best;
    }
    /** 弧长归一化：闭环段折回段内（跨圈时保留超出的那一段），其它情形夹到 [0, total] */
    function canon(sv) {
      if (!(sv >= 0)) sv = 0;
      if (sv > path.segs[path.segs.length - 1].s0) {
        // 落在最后一段（可能是闭环弧）里：先交给 segIndexAt 判段，再做折回
        var i = path.segIndexAt(sv), sg = path.segs[i];
        if (sg.cyclic) {
          var u = (sv - sg.s0) / sg.len;
          u -= Math.floor(u);
          return sg.s0 + sg.len * u;
        }
      }
      if (sv > path.total) sv = path.total;
      return sv;
    }
    /** 提交式：唯一允许把弧长写回 st.s 的入口（只在 project 里调用） */
    function syncS(x, y) {
      if (st.s == null) { st.s = canon(path.sOf(x, y)); return st.s; }
      st.s = canon(localS(x, y, st.s));
      return st.s;
    }
    function stateAt(s) {
      return { s: s, p: path.pointAt(s), t: path.tangentAt(s), n: path.normalAt(s), k: path.kappaAt(s), mu: path.muAt(s) };
    }
    /**
     * 取路径状态。
     * commit=true（只在 project 里）：按当前位置提交弧长基准。
     * commit=false（force / nextEvent / onEvent 里）：**按传进来的那个状态的位置**算几何，
     *   但不写回基准。
     *
     * 为什么后者也必须按位置算几何（而不是沿用上一次提交的 st.s）：
     * 引擎每个子步会用**预测状态 S1** 再调一次 force()。如果这一次仍然用上一步的
     * n̂ / t̂ / κ，则子步内速度方向已经转过 Δθ = v·h/R，而法向力还指着旧方向，
     * 理想约束于是做了净正功 ≈ m·v⁴·h²/(2R²)（= 0.35 J/s @ v=10, R=1, h=1/1440，
     * 与实测的能量增长 0.35 J/s 完全一致）。改成按各自状态取几何后，约束做功降到 O(h³)。
     * 注意这里只「读」不「提交」，所以预测点不会污染弧长基准。
     */
    function pathState(S, commit) {
      var b = S[id];
      var s;
      if (commit) s = syncS(b.x, b.y);
      else {
        if (st.s == null) st.s = canon(path.sOf(b.x, b.y));
        s = canon(localS(b.x, b.y, st.s));
      }
      return stateAt(s);
    }
    /** 把任意状态折算成 (s, v_t) —— 供事件预测与探针使用 */
    function along(S) {
      var b = S[id], ps = pathState(S);
      var vt = b.vx * ps.t[0] + b.vy * ps.t[1];
      return { ps: ps, vt: vt };
    }

    /**
     * 解析法向力：N = m·v_t²·κ − F_其它·n̂
     * 其中 n̂ 指向曲率中心（内壁），F_其它 = 重力 + 电场力（摩擦力沿切向，无法向分量）。
     * N ≥ 0 表示仍贴着轨道；N < 0 表示脱离。
     */
    function normalForce(S, a) {
      var b = S[id];
      var ps = a ? a.ps : pathState(S);
      var t = a ? a.vt : (b.vx * ps.t[0] + b.vy * ps.t[1]);
      var Fg = [0, -m * g];
      var Fe = eForce(b.x, b.y);
      var other = [Fg[0] + Fe[0], Fg[1] + Fe[1]];
      var proj = other[0] * ps.n[0] + other[1] * ps.n[1];
      return m * t * t * ps.k - proj;
    }

    function force(t, S, lock) {
      var b = S[id];
      var out = { gravity: [0, -m * g], normal: [0, 0], friction: [0, 0], electric: [0, 0], applied: [0, 0], joint: [0, 0], damping: [0, 0] };
      if (st.stopped) {
        // 冻结：**连重力也要置零**。只把速度清零、却仍然施加重力的话，
        // 球会从冻结那一刻起自由落体（实测末帧 y≈−36 m、机械能 −162 J），
        // 而且"末帧速度=0"这条判据也保不住。冻结后本帧 ΣJ=0、Δp=0，残差仍然为 0。
        Object.keys(out).forEach(function (k) { out[k] = [0, 0]; });
        return r0(out);
      }
      var a = along(S), ps = a.ps;
      var N = normalForce(S, a);
      if (st.exited) {
        // 已脱离且策略为 free：只受重力 + 电场（抛体）
        var Fe2 = eForce(b.x, b.y);
        out.electric = Fe2;
        return r1(out);
      }
      out.electric = eForce(b.x, b.y);
      if (N > 0) {
        out.normal = [N * ps.n[0], N * ps.n[1]];
        var mu = ps.mu;
        if (mu > 0) {
          // 动摩擦沿切向反向；近静止时若静摩擦足够则"咬住"（这一段保持静止）
          var Ft = (out.gravity[0] + out.electric[0]) * ps.t[0] + (out.gravity[1] + out.electric[1]) * ps.t[1];
          var fmax = mu * N;
          var vTiny = Math.abs(a.vt) < 1e-6;
          var fr;
          if (vTiny && Math.abs(Ft) <= fmax) fr = -Ft;
          else fr = -Math.sign(a.vt || 1) * fmax;
          out.friction = [fr * ps.t[0], fr * ps.t[1]];
        }
      }
      return r1(out);
      function r0(o) { var z = {}; z[id] = { parts: o }; return z; }
      function r1(o) { var z = {}; z[id] = { parts: o }; return z; }
    }

    /**
     * 约束投影：位置放回曲线 + 去掉残余法向速度（纠偏量由引擎记账成 normal 冲量）。
     * 顺便承担"脱离轨道"的检测：N ≤ 0 说明轨道推不住球了。
     * 放在这里是因为 project 每个子步都被调用（引擎的 nextEvent 只能拿到
     * 外力与预测点，N 的变化率里还含 n̂ 随弧长的转动，预测不可靠）；
     * 每子步判一次，最迟一个子步（≈7 mm）就能发现，误差可忽略。
     */
    function project(t, S) {
      if (st.stopped || st.exited) return null;
      var b = S[id];
      var ps = stateAt(syncS(b.x, b.y));
      var p = ps.p, tan = ps.t, nor = ps.n;
      var vt = b.vx * tan[0] + b.vy * tan[1];
      var F = fOther(b);
      var N = m * vt * vt * ps.k - (F[0] * nor[0] + F[1] * nor[1]);
      if (N <= 0) return leaveTrack(t, S);
      // 位置纠偏：真的把球放回曲线上（p 就是曲线上的最近点）。
      // 原来是 b = p + (off·n̂)·n̂ —— 因为 p 是最近点、偏移必然沿 n̂，这一步其实是恒等式
      // （等于什么都没做），球半径的离散漂移只能靠自己慢慢积累。改成 b = p 后半径恒为 R，
      // 实测全程 |ΔE| 还略有下降（默认场景 5.2e−5 J → 4.7e−5 J）。
      b.x = p[0]; b.y = p[1];
      var vn = b.vx * nor[0] + b.vy * nor[1];
      if (Math.abs(vn) > 0) {
        b.vx -= vn * nor[0]; b.vy -= vn * nor[1];
        return makeHint('normal');
      }
      return null;
      function fOther(bb) {
        var Fe = eForce(bb.x, bb.y);
        return [Fe[0], -m * g + Fe[1]];
      }
      function makeHint(part) { var h = {}; h[id] = { part: part }; return h; }
    }

    /** 脱离轨道：按场景声明的策略处置（stop = 冻结并标记；free = 转抛体；error = 直接报错） */
    function leaveTrack(t, S) {
      var b = S[id];
      st.exited = true; st.exitT = t;
      if (policy === 'stop') {
        st.stopped = true; st.exitReason = 'left-track';
        b.vx = 0; b.vy = 0;                               // 冻结：按题意模拟到此为止
      } else if (policy === 'error') {
        throw new Error('track: 在 t=' + t.toFixed(4) + ' 脱离轨道，但题目要求的答案尚未产生 —— 建模与题设不符');
      }
      // policy === 'free'：什么都不做，后续按抛体运动
      return null;
    }

    /**
     * 事件预测：只剩"到达段末"。引擎靠它把步子切到段末，之后弧长自然
     * 落到下一段（相切 ⇒ 速度天然连续），不需要额外的状态机。
     */
    function nextEvent(t, S) {
      if (st.stopped || st.exited) return null;
      var a = along(S), ps = a.ps;
      var i = path.segIndexAt(ps.s), end = path.segEnd(i);
      if (i < path.segs.length - 1 && a.vt > EPS) return t + (end - ps.s) / a.vt;
      return null;
    }

    /** 事件处理：段末（切段）；脱离的兜底判定（正常情况下 project 已经处理掉） */
    function onEvent(t, S) {
      var a = along(S), ps = a.ps;
      var i = path.segIndexAt(ps.s), end = path.segEnd(i);
      if (i < path.segs.length - 1 && ps.s > end - 1e-6) {
        st.seg = i + 1;                                   // 切到下一段（相切 ⇒ 速度天然连续）
        return null;
      }
      if (normalForce(S, a) <= 0) return leaveTrack(t, S);
      return null;
    }

    /**
     * 额外势能。**引擎已经自己加了 mgy**（见 verlet.js 的 stats.potential），
     * 所以这里只能返回"mgy 之外"的那部分 —— 即电场势能 −qE·r。
     * 以前这里返回 mgy − qE·x，等于把 mgy 记了两遍：
     * stats.mechanical = KE + 2mgy − qE·x，它沿轨道并不守恒（实测初值 6.799 J）。
     */
    function potential(t, S) {
      var b = S[id];
      return ePotential(b.x, b.y);
    }

    return {
      force: force, project: project, nextEvent: nextEvent, onEvent: onEvent, potential: potential,
      _st: st, _normalAt: function (S) { return normalForce(S, null); },
      _along: along, _path: path,
      // 只读暴露：供 lib/forces.js 的组件（curveNormal / kineticFriction）取路径几何。
      // 语义与内部调用完全一致：commit=true 只在 project 里用；force 侧必须 commit=false，
      // 否则子步预测点会污染弧长基准。**没有改动任何既有逻辑**。
      _pathState: pathState,
      // 只读暴露：给力组件层在 N<0 时**显式**按 exitPolicy 处置（leaveTrack 本身一字未改）
      _leaveTrack: leaveTrack
    };
  }

  return { makePath: makePath, makeTrackLaws: makeTrackLaws };
});
