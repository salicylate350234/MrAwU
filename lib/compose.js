/*!
 * MrAwU（阿物先生）— lib/compose.js
 * 模组组合的标准接口（chain）
 *
 * 为什么需要它：把两个模组首尾接起来时，最容易错的三件事是
 *   ① 几何不接（A 的出口和 B 的入口差了一截，B 的场/摩擦就作用在错误的位置上）
 *   ② 接口处速度无故突变（例如 B 的约束一激活就把径向速度吃掉），而冲量没记账
 *   ③ 时间基准没对齐（B 内部公式还在用 t，而不是"入场后的时间"）
 * 所以这里把接口变成**声明式 + 可校验**的：
 *
 *   阶段（stage）= {
 *     id, title,
 *     axis: 'x',              // 沿哪个轴推进（决定"走到哪了"）
 *     dir: +1 | -1,           // 推进方向
 *     x0, x1,                 // 入口 / 出口坐标（世界坐标）
 *     y0, y1,                 // 入口 / 出口处的横向坐标（用于几何连续性校验）
 *     aAxis(S) -> number,     // 沿轴加速度（组合器据此解析求出"到达出口的时刻"）
 *     force(t, S) -> parts,   // 阶段内力分解（与单模组完全同构）
 *     potential(t,S), project(t,S), nextEvent(t,S), onEvent(t,S),  // 都可选
 *     jump: null | { part, note },   // 若接口处**必须**速度突变，就在这里声明（并据此记账）
 *     expect: [{label, unit, value, probe}]   // 本阶段对照项；window 交给组合器裁剪
 *   }
 *
 * 组合器提供：
 *   · checkInterface()   静态校验：首尾必须相接（差一点都直接报错，不让你带着错跑）
 *   · laws               把各阶段拼成一个 Laws 对象交给 verlet：按位置分派、到边界精确切停、
 *                        事件里切换阶段并把状态记进 handoffs
 *   · interfaceItems()   把"接口一致性"本身变成对照项（位置连续 / 速度连续 / 突变已记账）
 *   · markers()          每个接口在时间轴上打一个断口，注明详情
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.PFA = root.PFA || {};
    root.PFA.compose = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var TOL_POS = 1e-9;      // 接口处位置容差（几何校验按米）
  // 接口速度连续性容差：这是**帧采样估计**（用 1/60 s 的帧去反推交接瞬间），
  // 噪声量级 ≈ a·dt/|v|，对"加速度大、阶段短"的情形能到百分之几，所以给 5%。
  // 它要抓的是"约束/碰撞悄悄吃掉速度"那种量级的错误（通常 >50%）。
  var TOL_VEL = 5e-2;

  function axisOf(st) { return st.axis || 'x'; }
  function coordOf(S, st) { return st.obj ? S[st.obj][axisOf(st)] : S[axisOf(st)]; }
  function velOf(S, st) { return st.obj ? S[st.obj]['v' + axisOf(st)] : S['v' + axisOf(st)]; }

  /**
   * 沿轴匀加速求解：从当前状态出发到达坐标 xAt 需要多久。
   * 阶段只要给出 aAxis(S)，组合器就能**精确**停在出口（而不是靠下一子步去发现已经越界）。
   */
  function solveAxis(st, xAt, S) {
    var x = coordOf(S, st), v = velOf(S, st);
    var a = st.aAxis ? st.aAxis(S) : 0;
    if (!isFinite(a) || Math.abs(a) < 1e-12) {
      if (Math.abs(v) < 1e-12) return null;
      var t0 = (xAt - x) / v;
      return t0 > 1e-12 ? t0 : null;
    }
    var disc = v * v + 2 * a * (xAt - x);
    if (disc < 0) return null;
    var r = Math.sqrt(disc);
    var cands = [(-v + r) / a, (-v - r) / a].filter(function (t) { return t > 1e-12; });
    return cands.length ? Math.min.apply(null, cands) : null;
  }

  /** 静态接口校验：相邻阶段的出口必须与下一阶段的入口重合 */
  function checkInterface(stages) {
    var errs = [];
    for (var i = 0; i + 1 < stages.length; i++) {
      var a = stages[i], b = stages[i + 1];
      if (axisOf(a) !== axisOf(b)) {
        errs.push('接口 ' + (i + 1) + '：「' + a.title + '」沿 ' + axisOf(a) +
          ' 推进，而「' + b.title + '」沿 ' + axisOf(b) + ' 推进，无法直接相接');
        continue;
      }
      var dx = Math.abs(a.x1 - b.x0);
      if (dx > TOL_POS) {
        errs.push('接口 ' + (i + 1) + '：「' + a.title + '」出口 ' + axisOf(a) + ' = ' + a.x1 +
          '，但「' + b.title + '」入口 ' + axisOf(b) + ' = ' + b.x0 + '，相差 ' + dx.toFixed(6) + ' m');
      }
      var dy = Math.abs((a.y1 || 0) - (b.y0 || 0));
      if (dy > TOL_POS) {
        errs.push('接口 ' + (i + 1) + '：「' + a.title + '」出口横向坐标 ' + (a.y1 || 0) +
          '，但「' + b.title + '」入口横向坐标 ' + (b.y0 || 0) + '，相差 ' + dy.toFixed(6) + ' m');
      }
    }
    return errs;
  }

  /**
   * 把若干阶段组合成一条链。
   * 返回 { stages, laws, bodies, markers, interfaceItems, handoffs, state, errors }
   */
  function chain(spec) {
    var stages = spec.stages || [];
    var errors = checkInterface(stages);
    if (!stages.length) errors.push('chain 至少要有一个阶段');

    var state = { idx: 0, times: [0], handoffs: [], entered: [], dtSim: spec.dtSim || 1 / 480 };
    var potOffset = 0, potOffsets = [0];

    /** 当前处于第几阶段：取"已经越过其入口"的最后一个阶段 */
    function stageIndexFor(S) {
      var idx = 0;
      for (var i = 0; i < stages.length; i++) {
        var st = stages[i], d = st.dir || 1;
        if (d * (coordOf(S, st) - st.x0) >= -1e-12) idx = i;
      }
      return Math.min(idx, stages.length - 1);
    }

    /** 是否已经走到本阶段出口（含容差） */
    function atExit(st, S) {
      var d = st.dir || 1;
      return d * (coordOf(S, st) - st.x1) >= -1e-12;
    }

    /** 写一条交接记录（exact=true 表示这是精确边界时刻的那一份，以此为准） */
    function writeHandoff(k, t, S, exact) {
      var from = stages[k], to = stages[k + 1], o = from.obj || 'ion';
      // 交接**之后**那一瞬间的真实受力：接口速度连续性校验用它反推"应有速度"，
      // 比用后一帧的平均加速度准得多（后一帧常常横跨接口，平均值被污染）。
      var fAfter = [0, 0];
      try {
        var fp = to.force ? to.force(t, S) : null;
        var pp = fp && fp[o] && fp[o].parts;
        if (pp) {
          Object.keys(pp).forEach(function (kk) {
            fAfter[0] += pp[kk][0] || 0;
            fAfter[1] += pp[kk][1] || 0;
          });
        }
      } catch (e) { /* 受力律在边界上取不到就退回帧加速度估计 */ }
      state.times[k + 1] = t;
      state.handoffs[k] = {
        index: k + 1, from: from.id, fromTitle: from.title,
        to: to.id, toTitle: to.title, t: t, body: o,
        at: [S[o] ? S[o].x : S.x, S[o] ? S[o].y : S.y],
        v: [S[o] ? S[o].vx : S.vx, S[o] ? S[o].vy : S.vy],
        fAfter: fAfter,
        declared: !!(to.jump || from.jump),
        exact: !!exact
      };
      if (from.potential && to.potential) {
        potOffset += (from.potential(t, S) || 0) - (to.potential(t, S) || 0);
      }
      potOffsets[k + 1] = potOffset;
      if (exact && to.enter) to.enter(t, S);      // 阶段可选的"入场处理"（例如打到屏就停住）
    }

    /**
     * 把"当前阶段号"推进到与位置一致，并把跨过的每个接口都记下来。
     *
     * 两个坑：
     *  · 不能只写 `state.idx = stageIndexFor(S)`：刚碰到出口的那一瞬间索引就已经指向下一段了，
     *    "记录交接"的逻辑于是永远在看**新阶段**的出口，一个 handoff 都记不到。
     *  · 交接状态必须取**精确边界时刻**那一份。子步的**预测点**（F2）会先一步碰到边界，
     *    所以 force() 里往往会先记下一条"中点版本"（实测出板偏移因此偏 0.9%）；
     *    真正的精确值要等 onEvent 来**刷新**（见 onEvent）。
     */
    function syncIndex(t, S, exact) {
      var i = stageIndexFor(S);
      while (state.idx < i) {
        var prev = state.handoffs[state.idx];
        if (exact || !prev) writeHandoff(state.idx, t, S, exact);
        state.idx++;
      }
      return state.idx;
    }

    var laws = {
      force: function (t, S) {
        var i = syncIndex(t, S);
        var st = stages[i];
        var out = st.force ? st.force(t, S) : {};
        return out || {};
      },
      nextEvent: function (t, S) {
        var i = syncIndex(t, S);
        var st = stages[i];
        var cands = [];
        if (st.nextEvent) {
          var e = st.nextEvent(t, S);
          if (e != null) cands.push(e);
        }
        if (i + 1 < stages.length) {
          var tau = solveAxis(st, st.x1, S);
          if (tau != null) cands.push(t + tau);
        }
        return cands.length ? Math.min.apply(null, cands) : null;
      },
      onEvent: function (t, S) {
        var i = syncIndex(t, S, false);
        // 事件时刻就是精确边界：把刚跨过的那条"中点版本"记录刷新成精确值。
        // 只在它确实刚刚发生（必要时刻在几个子步以内）时才刷新，避免污染阶段内部的临界点。
        var k = state.idx - 1;
        var h = k >= 0 ? state.handoffs[k] : null;
        if (h && !h.exact && Math.abs(t - h.t) <= 4 * (state.dtSim || 0.005)) {
          writeHandoff(k, t, S, true);
        }
        var st = stages[i];
        return st.onEvent ? st.onEvent(t, S) : null;
      },
      project: function (t, S) {
        var st = stages[syncIndex(t, S)];
        return st.project ? st.project(t, S) : null;
      },
      potential: function (t, S) {
        var i = syncIndex(t, S);
        var st = stages[i];
        return (st.potential ? st.potential(t, S) : 0) + (potOffsets[i] || 0);
      }
    };

    function bodies() {
      var out = [];
      stages.forEach(function (st) { out = out.concat(st.bodies || []); });
      return out;
    }
    function dimensions() {
      var out = [];
      stages.forEach(function (st) { out = out.concat(st.dimensions || []); });
      return out;
    }

    /** 时间轴断口：每个接口一个，注明交接点、速度与是否声明了突变 */
    function markers() {
      var out = [];
      stages.forEach(function (st) { out = out.concat(st.markers || []); });
      state.handoffs.filter(Boolean).forEach(function (h) {
        out.push({
          t: h.t, label: '接口' + h.index + '：' + h.toTitle,
          note: '阶段交接：' + h.fromTitle + ' → ' + h.toTitle + '。' +
            '交接点在 (' + h.at[0].toFixed(4) + ', ' + h.at[1].toFixed(4) + ') m，' +
            '交接速度 (' + h.v[0].toFixed(4) + ', ' + h.v[1].toFixed(4) + ') m/s。' +
            (h.declared
              ? '此处**声明了速度突变**（例如进入约束/碰撞），冲量已计入对应分项。'
              : '此处要求**速度与位置都连续**（接口校验项会核对）。')
        });
      });
      return out;
    }

    /** 接口一致性本身变成对照项：位置连续 + 速度连续（或已声明的突变已记账） */
    function interfaceItems(probes) {
      var items = [];
      state.handoffs.filter(Boolean).forEach(function (h, k) {
        var base = '接口' + h.index + '（' + h.fromTitle + '→' + h.toTitle + '）：';
        // 注意：tolerance / absTolerance 必须放在**条目级**——verify 读的是 it.absTolerance，
        // 放进 probe 会被忽略，于是"解析值为 0"的条目会退回默认 0.01 的绝对容差。
        items.push({
          label: base + '交接点与后一阶段入口重合', unit: 'm', value: 0,
          tolerance: 1e-6, absTolerance: 1e-6,
          probe: { kind: 'interface', which: 'pos', index: k }
        });
        if (!h.declared) {
          items.push({
            label: base + '速度连续（帧采样估计，容差 5%）', unit: 'm/s', value: 0,
            tolerance: TOL_VEL, absTolerance: 6e-2,
            probe: { kind: 'interface', which: 'vel', index: k, ref: 1 }
          });
        } else {
          items.push({
            label: base + '速度突变已记账（ΣJ = mΔv）', unit: 'kg·m/s', value: 0,
            tolerance: 1e-3, absTolerance: 1e-3,
            probe: { kind: 'interface', which: 'impulse', index: k }
          });
        }
      });
      return items;
    }

    /**
     * 合并各阶段的对照项：把 window 裁剪到本阶段的时间区间，
     * 避免"用阶段 A 的窗口去量阶段 B 的物理量"这种典型错误。
     */
    function expect(p, ctx) {
      var out = [];
      var frames = (ctx && ctx.frames) || null;
      var tEnd = frames && frames.length ? frames[frames.length - 1].t : null;
      stages.forEach(function (st, i) {
        if (typeof st.expect !== 'function') return;
        var t0 = state.times[i] || 0;
        var t1 = state.times[i + 1] != null ? state.times[i + 1] : (tEnd != null ? tEnd : st.tEnd);
        var dt = frames && frames.length > 1 ? (frames[1].t - frames[0].t) : 1 / 60;
        (st.expect(p, { t0: t0, t1: t1, dt: dt }) || []).forEach(function (it) {
          var w = it.probe && it.probe.window;
          // 注意：接口附近的窗口一定要带上 ±1 帧的余量。
          // 只取 [t1*0.99, t1] 这种窄窗在 1/60 采样下一帧都命中不到，
          // 探针会回落到"全部帧"，于是测出来的是末帧的值（实测偏了 286%）。
          if (w && t1 != null && isFinite(t1)) {
            // 上界留 2 帧余量：接口量（出板偏移、到屏位置）常常只能在交接**之后**那几帧里读到，
            // 卡死在阶段结束时刻会把它们全部裁掉，探针只好回落到末帧（实测偏 2.3%）。
            it.probe = Object.assign({}, it.probe, {
              window: [Math.max(w[0], t0), Math.min(w[1], t1 + 2 * dt)]
            });
          }
          out.push(it);
        });
      });
      if (frames) out = out.concat(interfaceItems());
      return out;
    }

    return {
      stages: stages, laws: laws, state: state,
      bodies: bodies, dimensions: dimensions,
      markers: markers, expect: expect, interfaceItems: interfaceItems,
      errors: errors,
      // 必须返回**同一个数组对象**（不能 filter 出新数组）：
      // 场景规范化时拿的就是这个引用，之后运行期写进去的交接记录才看得见。
      handoffs: function () { return state.handoffs; },
      stageTimes: function () { return state.times.slice(); },
      solveAxis: solveAxis
    };
  }

  return { chain: chain, checkInterface: checkInterface, solveAxis: solveAxis,
           TOL_POS: TOL_POS, TOL_VEL: TOL_VEL };
});
