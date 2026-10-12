/*!
 * MrAwU（阿物先生）— lib/verify.js
 * 「解析值 vs 仿真值」对照：按 probe 规格从帧序列里取出对应的物理量并求平均/极值，
 * 再与模型给出的解析解比较，算出相对误差。
 * 浏览器与 Node 共用，所以动画可以自己证明自己。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    var F = null; try { F = require('./field.js'); } catch (e) { F = null; }
    module.exports = factory(F);
  } else {
    root.PFA = root.PFA || {};
    root.PFA.verify = factory(root.PFA.field);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (fieldLib) {
  'use strict';

  function dot(v, p) { return v[0] * p[0] + v[1] * p[1]; }
  function mag(v) { return Math.hypot(v[0], v[1]); }

  function windowFrames(frames, w) {
    if (!w) return frames.slice(1);
    var t0 = w[0], t1 = w[1];
    var out = frames.filter(function (f) { return f.t > t0 && f.t <= t1; });
    return out.length ? out : frames.slice(1);
  }

  /**
   * 支持 probe.around：自动把采样窗口套在"轨迹的某个极值点"上。
   * 物理题里大量问"在最高点/最低点的力是多少"，用固定时间窗口去凑既脆弱又难读，
   * 直接用极值点定位最稳：
   *   around: { comp: 'y' | 'x' | 'speed', dir: 'max' | 'min', pad: 0.08 }
   */
  function aroundWindow(frames, body, probe) {
    var ar = probe.around;
    if (!ar) return probe.window;
    var best = null, bestVal = null;
    frames.forEach(function (f) {
      var b = f.bodies[body];
      if (!b) return;
      var val = ar.comp === 'x' ? b.x : (ar.comp === 'speed' ? Math.hypot(b.vx, b.vy) : b.y);
      if (bestVal === null || (ar.dir === 'min' ? val < bestVal : val > bestVal)) {
        bestVal = val; best = f;
      }
    });
    if (!best) return probe.window;
    // around.first = true：取「第一次」到达该极值的时刻。
    // 圆周运动之类的周期运动会反复经过最高点，若取全局最大可能落在后面某一圈上，
    // 那时离散耗散已经累积，测出来的速率会莫名其妙偏低。
    if (ar.first && ar.dir === 'max') {
      var th = ar.firstTol != null ? ar.firstTol : 0.02;
      for (var i = 0; i < frames.length; i++) {
        var bi = frames[i].bodies[body];
        if (!bi) continue;
        var vi = ar.comp === 'x' ? bi.x : (ar.comp === 'speed' ? Math.hypot(bi.vx, bi.vy) : bi.y);
        if (vi >= bestVal * (1 - th)) { best = frames[i]; break; }
      }
    }
    var pad = ar.pad != null ? ar.pad : 0.1;
    return [Math.max(0, best.t - pad), best.t + pad];
  }

  /** 从帧序列里取一个标量（probe 规格见 references/scene-schema.md）；ctx.scene 供"场"类探针使用 */
  function measure(frames, probe, ctx) {
    var body = probe.body;
    var mode = probe.mode || 'dot';
    var signed = !!probe.signed;
    var project = probe.project || [1, 0];

    // 静电场这类"场可视化"模型：直接按电荷分布重算该点的 E 或 V。
    // 期望值由模型侧独立实现算出，这里用 lib/field.js 的实现，两条路径互相对拍。
    if (probe.kind === 'fieldAt') {
      var sc = ctx && ctx.scene;
      if (!sc || !sc.field) return null;
      var ch = sc.field.charges, kk = sc.field.k;
      if (!fieldLib) return null;
      var ff = fieldLib.fieldAt(ch, probe.at[0], probe.at[1], kk);
      return probe.part === 'V' ? ff.v : ff.mag;
    }
    if (probe.kind === 'chargeCount') {
      var sc2 = ctx && ctx.scene;
      return (sc2 && sc2.field) ? sc2.field.charges.length : null;
    }

    // 模组接口探针：直接核对"阶段交接"这件事本身。
    //   pos     —— 交接点与后一阶段入口的坐标差（理想为 0）
    //   vel     —— 未声明突变时，交接瞬间的速度跳变（理想为 0）
    //   impulse —— 声明了突变时，记账冲量与 mΔv 之差（理想为 0）
    //
    // 关键技巧：交接**瞬间**的速度由组合器记在 handoff.v 里（事件里抓的，精确）；
    // 交接后的速度用后一帧状态**反推**回交接时刻（扣掉那一帧的合法加速度），
    // 两者之差才是真正的"非法速度跳变"，不会被正常加速度污染。
    if (probe.kind === 'interface') {
      var sc3 = ctx && ctx.scene;
      var hs = (sc3 && sc3.handoffs) || [];
      var h = hs[probe.index || 0];
      if (!h) return null;
      var bid = h.body || 'ion';
      // 交接瞬间的**精确状态**（组合器在事件里抓的，不受 1/60 采样影响）：
      // 阶段出口量（出板偏移、交接速度…）直接读它，比从帧序列里凑要准得多。
      if (probe.which === 'state') {
        var c = probe.comp || 'vx';
        if (c === 'x') return h.at[0];
        if (c === 'y') return h.at[1];
        if (c === 'vx') return h.v[0];
        if (c === 'vy') return h.v[1];
        if (c === 'speed') return Math.hypot(h.v[0], h.v[1]);
        return null;
      }
      if (probe.which === 'pos') {
        var st = (sc3.stages || [])[probe.index + 1];
        if (!st) return 0;
        var ax = st.axis || 'x';
        var target = ax === 'x' ? st.x0 : (st.y0 != null ? st.y0 : st.x0);
        var got = ax === 'x' ? h.at[0] : h.at[1];
        return Math.abs(got - target);
      }
      // 找到交接后的第一帧，用它反推交接瞬间的"应有速度"
      var fNext = null;
      for (var q = 0; q < frames.length; q++) {
        if (frames[q].t > h.t) { fNext = frames[q]; break; }
      }
      if (!fNext || !fNext.bodies[bid]) return null;
      var bn = fNext.bodies[bid];
      var bPrev = null;
      for (var q1 = 0; q1 < frames.length; q1++) {
        if (frames[q1].t <= h.t) bPrev = frames[q1].bodies[bid]; else break;
      }
      var dt = fNext.t - h.t;
      if (!(dt > 1e-9)) dt = fNext.dt || 1 / 60;
      var mass = bn.mass || 1;
      // 用"交接后那一瞬间的真实受力"反推应有速度；取不到才退回帧平均加速度
      var accX, accY;
      if (h.fAfter) { accX = h.fAfter[0] / mass; accY = h.fAfter[1] / mass; }
      else { accX = bn.accel ? bn.accel[0] : 0; accY = bn.accel ? bn.accel[1] : 0; }
      var vAfterX = bn.vx - accX * dt, vAfterY = bn.vy - accY * dt;
      var dvx = vAfterX - h.v[0], dvy = vAfterY - h.v[1];
      if (probe.which === 'vel') {
        var scale = Math.max(1e-9, Math.hypot(h.v[0], h.v[1]));
        return Math.hypot(dvx, dvy) / scale;      // 相对速度跳变
      }
      if (probe.which === 'impulse') {
        var mass = bn.mass || 0;
        var dp = Math.hypot(dvx, dvy) * mass;
        // 交接后的第一帧里累计的冲量（事件冲量也计入其中）
        var jj = bPrev && bPrev.impulse ? Math.hypot(bPrev.impulse[0], bPrev.impulse[1]) : 0;
        var jn = bn.impulse ? Math.hypot(bn.impulse[0], bn.impulse[1]) : 0;
        var booked = Math.max(jj, jn);
        return Math.abs(booked - dp);
      }
      return null;
    }

    if (probe.kind === 'stat') {
      var f = probe.at === 'first' ? frames[0] : frames[frames.length - 1];
      if (probe.body && probe.key.indexOf('.') < 0) {
        // 刚体级的末态量：angularVelocity / x / vx / angle ...（取不到时回落到场景统计）
        var bv = f.bodies[probe.body][probe.key];
        if (bv !== undefined) return bv;
      }
      if (probe.key.indexOf('.') > 0) {
        var parts = probe.key.split('.');
        return f.bodies[body][parts[0]][parts[1]];
      }
      return f.stats[probe.key];
    }
    // 过程量的变化：末帧统计值 − 初帧统计值（机械能变化、动量变化都用它）
    if (probe.kind === 'eventTime') {
      // 位置临界时刻：给出 at（世界坐标沿 axis 的位置）时，找刚体**首次越过**它的时刻，
      // 用线性插值给出精确到帧内的时间。用于"出板时刻""到达极板时刻"这类临界点。
      if (probe.at != null) {
        var ax = probe.axis === 'y' ? 1 : 0;
        for (var k = 1; k < frames.length; k++) {
          var pa = frames[k - 1].bodies[body], pb = frames[k].bodies[body];
          if (!pa || !pb) continue;
          var va = ax ? pa.y : pa.x, vb = ax ? pb.y : pb.x;
          var dir = probe.dir || 1;
          if ((va - probe.at) * dir < 0 && (vb - probe.at) * dir >= 0) {
            var t0 = (probe.at - va) / (vb - va);
            return frames[k - 1].t + t0 * frames[k].dt;
          }
        }
        return null;
      }
      // 临界「时刻」探针：找出相对速度首次降到 tol 以内的那一帧的时刻。
      // 板块/传送带题的"共速时刻"是时间量，不能用 relative（位移）去比。
      var rtol = probe.tol != null ? probe.tol : 1e-3;
      for (var i = 0; i < frames.length; i++) {
        var ba = frames[i].bodies[body], bb = frames[i].bodies[probe.ref];
        if (!ba || !bb) continue;
        var vrel = probe.axis === 'y' ? Math.abs(ba.vy - bb.vy)
          : (probe.axis === 'x' ? Math.abs(ba.vx - bb.vx) : Math.hypot(ba.vx - bb.vx, ba.vy - bb.vy));
        if (vrel <= rtol) return frames[i].t;
      }
      return null;
    }
    if (probe.kind === 'statDelta') {
      return frames[frames.length - 1].stats[probe.key] - frames[0].stats[probe.key];
    }
    if (probe.kind === 'period') {
      // 用投影坐标的过零（同向）测周期
      var sig = frames.map(function (f) {
        var b = f.bodies[body];
        return dot([b.x, b.y], project) - (probe.center != null ? probe.center : 0);
      });
      var crossings = [];
      for (var i = 1; i < sig.length; i++) {
        // 同向过零（上升沿）。要求相邻样本严格跨号，避免信号长期贴着 0 时反复触发。
        if (sig[i - 1] < 0 && sig[i] > 0) {
          var frac = -sig[i - 1] / (sig[i] - sig[i - 1]);
          crossings.push(frames[i - 1].t + frac * frames[i].dt);
        }
      }
      if (crossings.length < 2) return null;
      return (crossings[crossings.length - 1] - crossings[0]) / (crossings.length - 1);
    }

    var sel = windowFrames(frames, aroundWindow(frames, body, probe));
    var vals = sel.map(function (f) {
      var b = f.bodies[body];
      if (!b) return 0;
      var v;
      if (probe.kind === 'accel') v = b.accel;
      else if (probe.kind === 'velocity') v = [b.vx, b.vy];
      else if (probe.kind === 'position') v = [b.x, b.y];
      else if (probe.kind === 'force') v = b.forces[probe.comp || 'total'];
      else if (probe.kind === 'impulse') v = b.impulse;
      else if (probe.kind === 'contactNormal') v = b.forces.normal;
      else v = b.forces.total;
      // 多个关节同时作用时（比如双绳悬挂），可以用 jointId 只取某一根绳对刚体的力
      if (probe.jointId && (probe.comp === 'joint' || probe.kind === 'force')) {
        var acc = [0, 0], found = false;
        (b.joints || []).forEach(function (it) {
          if (it.id !== probe.jointId) return;
          found = true;
          acc[0] += it.force[0]; acc[1] += it.force[1];
        });
        if (found) v = acc;
      }
      // 相对量（板块/传送带题的核心是「相对滑动位移」）：
      //   kind:'relative' → 该刚体相对 probe.ref 的位移矢量
      //   relativeTo:'initial' → 再减去初始帧的值，直接得到「相对滑动位移」
      if (probe.kind === 'relative') {
        var rb = f.bodies[probe.ref];
        if (!rb) return 0;
        v = [b.x - rb.x, b.y - rb.y];
        if (probe.relativeTo === 'initial') {
          var i0 = frames[0].bodies[body], r0 = frames[0].bodies[probe.ref];
          v = [v[0] - (i0.x - r0.x), v[1] - (i0.y - r0.y)];
        }
      }
      if (mode === 'mag') return mag(v);
      var d = dot(v, project);
      return signed ? d : Math.abs(d);
    });
    if (!vals.length) return null;
    if (probe.reduce === 'max') return Math.max.apply(null, vals);
    if (probe.reduce === 'last') return vals[vals.length - 1];
    if (probe.reduce === 'first') return vals[0];
    // 冲量这类「过程量」必须求和，不能按帧平均：
    // 一次碰撞的冲量只出现在 1~2 帧里，取平均会得到 1/N 的错误结果。
    if (probe.reduce === 'sum') return vals.reduce(function (a, b) { return a + b; }, 0);
    if (probe.reduce === 'maxAbs') return Math.max.apply(null, vals.map(Math.abs));
    var sum = vals.reduce(function (a, b) { return a + b; }, 0);
    return sum / vals.length;
  }

  function run(model, params, frames, scene) {
    // 把场景也交给 expect：组合模组的阶段交接时刻是**运行后**才知道的，
    // 只有拿到刚刚跑过的那一个场景实例，各阶段的对照窗口才对得上。
    var items = typeof model.expect === 'function'
      ? model.expect(params, { scene: scene, frames: frames })
      : (model.expect || []);
    return items.map(function (it) {
      var sim = null, err = null;
      var tol = it.tolerance != null ? it.tolerance
        : (it.probe && it.probe.tolerance != null ? it.probe.tolerance : 0.005);
      try { sim = measure(frames, it.probe, { scene: scene }); } catch (e) { sim = null; }
      if (sim != null && isFinite(sim) && isFinite(it.value)) {
        // 显式给了 absTolerance → 一律按绝对误差判定。
        // 用于"解析值本身接近 0"的物理量（例如最高点恰好满足临界条件时的杆作用力），
        // 这种量的相对误差没有物理意义。
        if (it.absTolerance != null) {
          return {
            label: it.label, unit: it.unit || '', theory: it.value, sim: sim,
            relError: Math.abs(sim - it.value), absolute: true, tolerance: it.absTolerance,
            pass: Math.abs(sim - it.value) <= it.absTolerance
          };
        }
        if (Math.abs(it.value) < 1e-6) {
          // 解析值为 0（例如"应当保持静止"）→ 用绝对误差判定
          var absTol = it.absTolerance != null ? it.absTolerance : 0.01;
          return {
            label: it.label, unit: it.unit || '', theory: 0, sim: sim,
            relError: Math.abs(sim), absolute: true, tolerance: absTol,
            pass: Math.abs(sim) <= absTol
          };
        }
        var denom = Math.max(Math.abs(it.value), 1e-9);
        err = Math.abs(sim - it.value) / denom;
      }
      return {
        label: it.label, unit: it.unit || '', theory: it.value, sim: sim,
        relError: err, tolerance: tol, pass: err != null && err <= tol
      };
    });
  }

  return { measure: measure, run: run };
});
