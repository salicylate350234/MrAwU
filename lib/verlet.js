/*!
 * MrAwU（阿物先生）— lib/verlet.js
 * 自研速度-Verlet 积分后端（用于替代 planck 的轻量路线）。
 *
 * 与 planck 后端的关系：产出**完全相同**的 frames 结构，所以 draw / graph / verify / player 一行不用改。
 *
 * 设计要点（也是这条路唯一的真风险所在）：
 *  1) 积分器只负责"绝不跨过临界时刻"：把 t_F、共速瞬间这类事件解析求出来，把步子切到事件点为止，
 *     在事件点上重新判定受力分支。跨过事件再切换分支会产生一阶误差（实测 L_min 差 0.84%）。
 *  2) 受力律由模型提供（scene.laws）。摩擦/支持力的大小由模型自己给出，
 *     因此残差 ΣJ−Δp 在这条路径上是代数恒等式，**不再构成独立验证**——
 *     物理正确性要靠 node/compare-engines.cjs 与解析解/planck 对拍来保证。
 *  3) 只在模型声明了 laws 时才可用；未声明的模型仍走 planck。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.PFA = root.PFA || {};
    root.PFA.verlet = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var sceneLib = (typeof module === 'object' && module.exports)
    ? require('./scene.js') : (typeof globalThis !== 'undefined' ? globalThis.PFA.scene : null);

  var PARTS = ['gravity', 'gravitation', 'electric', 'normal', 'friction', 'applied', 'joint', 'damping'];
  var EPS_T = 1e-12;

  function blank() { return { fx: 0, fy: 0 }; }

  /**
   * laws 需要提供：
   *   force(t, S)      → { bodyId: { parts: {gravity:[fx,fy], normal, friction, applied, joint, damping} } }
   *   nextEvent(t, S)  → 严格大于 t 的下一个临界时刻（没有则 null）—— 用于"临界处手动计算"
   *   initial          → 可选，覆盖初始位置/速度
   * S 形如 { bodyId: { x, y, vx, vy } }
   */
  function createVerletSim(rawScene, options) {
    var opts = options || {};
    var s = rawScene.schema === sceneLib.SCHEMA ? rawScene : sceneLib.normalize(rawScene);
    var laws = s.laws;
    if (!laws || typeof laws.force !== 'function') {
      throw new Error('verlet 引擎需要 scene.laws.force（模型未声明受力律）');
    }

    var dyn = s.bodies.filter(function (b) { return b.type === 'dynamic'; });
    // 允许没有动态刚体：静电场这类"场可视化"模型全是静态电荷，
    // 只需要录出静态帧供渲染/探针使用，不需要积分。
    var mass = {};
    dyn.forEach(function (b) { mass[b.id] = b.mass || 1; });

    var dtOut = s.meta.dt;
    var dtSim = s.meta.simDt;
    var subSteps = s.meta.subSteps;
    var nFrames = opts.frames != null ? opts.frames : s.meta.frames;

    // ---- 状态 ----
    var t = 0;
    var S = {};
    dyn.forEach(function (b) {
      var v = b.velocity || [0, 0];
      S[b.id] = { x: b.at[0], y: b.at[1], vx: v[0], vy: v[1] };
      if (laws.initial && laws.initial[b.id]) {
        var iv = laws.initial[b.id];
        if (iv[0] != null) S[b.id].x = iv[0];
        if (iv[1] != null) S[b.id].y = iv[1];
        if (iv[2] != null) S[b.id].vx = iv[2];
        if (iv[3] != null) S[b.id].vy = iv[3];
      }
    });

    // ---- 本帧的受力冲量累加 ----
    var acc = {};
    function resetAcc() {
      acc = {};
      dyn.forEach(function (b) {
        var a = { parts: {} };
        PARTS.forEach(function (k) { a.parts[k] = blank(); });
        a.total = blank();
        a.impulse = blank();        // ΣJ（本帧所有子步的平均力 × 步长）
        acc[b.id] = a;
      });
    }

    function accelOf(id, F) {
      var p = F[id] && F[id].parts ? F[id].parts : null;
      var fx = 0, fy = 0;
      if (p) PARTS.forEach(function (k) { if (p[k]) { fx += p[k][0]; fy += p[k][1]; } });
      else if (F[id] && F[id].f) { fx = F[id].f[0]; fy = F[id].f[1]; }
      return { ax: fx / mass[id], ay: fy / mass[id], fx: fx, fy: fy };
    }

    /**
     * 一个子步：速度-Verlet。返回本步的平均力（用于冲量累加，与梯形速度更新一致）
     * @param {number} h 步长
     * @param {number} cap 本步**允许到达的最大时刻**（事件/帧边界）
     * @param {number} tm 本步中点时刻（力按中点取；与 h 必须用同一个 h 算出来）
     */
    function substep(h, cap, tm) {
      // h 由调用方**先**按事件/帧边界切好再传进来（见 advanceTo）：早期实现在这里又算一次
      // `h = min(h, tTarget - t)`，于是"事件把该子步切短"只作用于积分推进，力却仍按**整步中点**
      // 取 —— 实测出板瞬间 v_y 偏 0.0025%（20.0005 vs 20.0000），且不随步长变细而减小。
      var tm = t + 0.5 * h;
      // 子步开始时就锁定受力分支（滑动方向），F1/F2 两次求力沿用同一分支：
      // 否则预测点越过临界点时 F2 会换分支，该子步平均力算错（实测加速度只剩一半）。
      var lk = typeof laws.lock === 'function' ? laws.lock(S) : null;
      var F1 = laws.force(tm, S, lk);
      var A1 = {};
      dyn.forEach(function (b) { A1[b.id] = accelOf(b.id, F1); });
      var S1 = {};
      dyn.forEach(function (b) {
        S1[b.id] = {
          x: S[b.id].x + S[b.id].vx * h + 0.5 * A1[b.id].ax * h * h,
          y: S[b.id].y + S[b.id].vy * h + 0.5 * A1[b.id].ay * h * h,
          vx: S[b.id].vx + A1[b.id].ax * h,
          vy: S[b.id].vy + A1[b.id].ay * h
        };
      });
      var F2 = laws.force(tm, S1, lk);
      var A2 = {};
      dyn.forEach(function (b) { A2[b.id] = accelOf(b.id, F2); });
      dyn.forEach(function (b) {
        S[b.id].vx += 0.5 * (A1[b.id].ax + A2[b.id].ax) * h;
        S[b.id].vy += 0.5 * (A1[b.id].ay + A2[b.id].ay) * h;
        S[b.id].x = S1[b.id].x;
        S[b.id].y = S1[b.id].y;
      });
      // 只在 cap 处（事件 / 帧边界）做一次"落到边界上"的钳制：
      // 浮点上 t + h 可能差 1 ulp 落到 cap 的另一侧，那一步就会跨过事件。
      t = (cap != null && t + h >= cap) ? cap : t + h;
      // 平均力 = (F1+F2)/2，于是 ΣJ = mΔv 精确成立
      dyn.forEach(function (b) {
        var a = acc[b.id];
        PARTS.forEach(function (k) {
          var p1 = (F1[b.id] && F1[b.id].parts && F1[b.id].parts[k]) || [0, 0];
          var p2 = (F2[b.id] && F2[b.id].parts && F2[b.id].parts[k]) || [0, 0];
          var dx = 0.5 * (p1[0] + p2[0]) * h, dy = 0.5 * (p1[1] + p2[1]) * h;
          a.parts[k].fx += dx;
          a.parts[k].fy += dy;
          a.impulse.fx += dx;                     // 总冲量（碰撞冲量探针要读它）
          a.impulse.fy += dy;
        });
      });
      return h;
    }

    /**
     * 执行一次"直接改状态"的操作（临界投影 / 约束投影），并把它记成冲量。
     * 不记账的话 ΣJ ≠ Δp，残差会莫名飙升（实测 7.69%）。
     * fn 可返回 { bodyId: { part: 'normal'|'friction'|... } } 指明这笔冲量算在哪一类力上。
     */
    function bookDelta(fn, defaultPart) {
      var before = {};
      dyn.forEach(function (b) { before[b.id] = { vx: S[b.id].vx, vy: S[b.id].vy }; });
      var hint = fn();
      dyn.forEach(function (b) {
        var dx = mass[b.id] * (S[b.id].vx - before[b.id].vx);
        var dy = mass[b.id] * (S[b.id].vy - before[b.id].vy);
        if (Math.abs(dx) < 1e-15 && Math.abs(dy) < 1e-15) return;
        var part = (hint && hint[b.id] && hint[b.id].part) || defaultPart || 'friction';
        if (!acc[b.id].parts[part]) part = 'friction';
        acc[b.id].parts[part].fx += dx;
        acc[b.id].parts[part].fy += dy;
        acc[b.id].impulse.fx += dx;              // 事件/约束冲量也计入总冲量
        acc[b.id].impulse.fy += dy;
      });
    }

    /** 推进到 tTarget：遇临界时刻精确停住，绝不跨过（这是精度的关键） */
    var eventLog = [];
    function advanceTo(tTarget) {
      // hMin 只是保险丝（把"剩余时间"归零，免得浮点上永远差 1 ulp）；
      // 真正的停止判据是**步进精确**：早期实现用绝对容差 `t < tTarget - 1e-12` 当条件，
      // 在微观时间尺度（真实电子题 dt = 6.8e-12 s、8 子步 ⇒ dtSim = 8.5e-13 s）下
      // 该容差比一个子步还大，于是**每帧少走 1 个子步**、时间永远差 12.5%：
      //   末帧 v_y = −5.95e-2 m/s（应 −6.8e-2）、帧内平均加速度 −8.75e9（应 −1e10）、
      //   出板偏移 1.75e-8 m（应 2.0e-8）—— 三条对照项全线 FAIL，症状却伪装成"物理不对"。
      var hMin = dtSim * 1e-3;
      var guard = 0;
      // 两层结构：外层保证"本帧一定走到 tTarget"，内层把子步推进到 stopAt（帧尾或下一个事件）。
      // ⚠️ 事件时刻是**推进上限**（stopAt）：帧的显示时刻是 i·dt，而物理时间在事件处停住；
      // 若不这样，显示时刻会跑在物理状态前面 —— 实测宏观格里 t₁ 恰好是帧边界时，
      // 探针在 t = t₁ 那一帧读到的是 t₁ 之后的位置，荧光屏吸收完全失效（Y 偏 0.053%）。
      while (t < tTarget) {
        if (++guard > 200000) throw new Error('verlet 子步过多，疑似事件重复触发');
        var ev = (typeof laws.nextEvent === 'function') ? laws.nextEvent(t, S) : null;
        // 事件恰好落在子步边界时也要先切到它，否则"事件在步内"的判定不成立、onEvent 永不触发
        // （实测：碰撞时刻恰好是 1/240 的整数倍，冲量因此从未施加）。
        // ⚠️ 上界必须含**等于 tTarget** 这一支：事件正好落在帧边界时 ev 与 tTarget 是同一个浮点数，
        // 用 `ev < tTarget` 会把它排除，帧内最后一个子步冲到事件之后，事件在帧尾才补上
        // （实测荧光屏吸收因此失效、屏上偏移偏 0.053%）。
        var stopAt = (ev != null && ev > t && ev <= tTarget) ? ev : tTarget;
        while (t < stopAt) {
          if (++guard > 200000) throw new Error('verlet 子步过多，疑似事件重复触发');
          var h = Math.min(dtSim, stopAt - t);
          var cap = t + h;
          substep(h, cap);
          // 收尾：剩余时间小到"再加一个子步就会跨过 stopAt"时直接归零（浮点保险丝）
          var last = t < stopAt && (stopAt - t) <= hMin;
          if (last) t = stopAt;
          // 约束投影（例如小球不能穿进地面、物块必须留在斜面上）：
          // 位置/速度被直接修正的部分同样要记成冲量，否则残差会对不上。
          if (typeof laws.project === 'function') bookDelta(function () { return laws.project(t, S); }, 'normal');
          if (last) break;
        }
        // 到达临界时刻就施加事件（碰撞冲量 / 共速投影）
        if (ev != null && ev <= t) {
          eventLog.push(ev);
          if (typeof laws.onEvent === 'function') {
            bookDelta(function () { return laws.onEvent(t, S); }, 'friction');
          }
          // 可选的 laws.enter：事件时刻的"入场处理"（例如打到荧光屏被吸收 → 位置钳到屏面、
          // 速度归零）。⚠️ 不接这一支的话，模型里写的 enter 永远不会被调用（实测：粒子穿过
          // 荧光屏继续飞，屏上偏移读到穿屏之后的位置，偏 0.053%）。
          // 模型必须在 nextEvent 里**只**在真正的入场时刻返回该事件（例如出板事件不返回 enter），
          // 否则 enter 会在错误的事件上触发。改速度的部分按惯例记账。
          if (ev != null && ev <= t && typeof laws.enter === 'function') {
            bookDelta(function () { return laws.enter(t, S); }, 'electric');
          }
        }
        if (stopAt >= tTarget) break;
      }
      t = tTarget;
    }

    // ---- 帧 ----
    var stateStart = null, frameIndex = 0;

    function snap() {
      var o = {};
      dyn.forEach(function (b) { o[b.id] = { x: S[b.id].x, y: S[b.id].y, vx: S[b.id].vx, vy: S[b.id].vy }; });
      return o;
    }

    function buildFrame(frameDt, firstFrame) {
      var bodies = {};
      // 关节力（绳张力等）：约束由 project() 隐式产生，但受力表需要显示它，
      // 所以由模型用 laws.jointItems(t, S) 给出解析值。
      var jItems = (typeof laws.jointItems === 'function') ? (laws.jointItems(t, S) || []) : [];
      var stats = {
        kinetic: 0, potential: 0, mechanical: 0, momentumX: 0, momentumY: 0,
        residualMax: 0, residualAbsMax: 0, appliedForceNames: []
      };
      var refY = s.meta.energyRefY != null ? s.meta.energyRefY : 0;
      s.bodies.forEach(function (def) {
        var isDyn = def.type === 'dynamic';
        // 静态刚体不在积分状态里：位置取场景定义，速度恒为 0
        var st = S[def.id] || { x: def.at[0], y: def.at[1], vx: 0, vy: 0 };
        var a = acc[def.id];
        var forces = {}, totalX = 0, totalY = 0;
        PARTS.forEach(function (k) {
          var imp = a && a.parts[k] ? a.parts[k] : { fx: 0, fy: 0 };
          forces[k] = frameDt > 0 ? [imp.fx / frameDt, imp.fy / frameDt] : [0, 0];
          totalX += forces[k][0]; totalY += forces[k][1];
        });
        var dpX = 0, dpY = 0, sumX = 0, sumY = 0, residual = 0, absErr = 0;
        if (!firstFrame && isDyn && a) {
          dpX = mass[def.id] * (st.vx - stateStart[def.id].vx);
          dpY = mass[def.id] * (st.vy - stateStart[def.id].vy);
          PARTS.forEach(function (k) { sumX += a.parts[k].fx; sumY += a.parts[k].fy; });
          var scale = Math.max(1e-6, Math.abs(dpX) + Math.abs(dpY) + Math.abs(sumX) + Math.abs(sumY));
          residual = Math.hypot(sumX - dpX, sumY - dpY) / scale;
          absErr = Math.hypot(sumX - dpX, sumY - dpY);
        }
        if (residual > stats.residualMax) stats.residualMax = residual;
        if (absErr > stats.residualAbsMax) stats.residualAbsMax = absErr;

        var m = isDyn ? mass[def.id] : 0;
        var KE = isDyn ? 0.5 * m * (st.vx * st.vx + st.vy * st.vy) : 0;
        if (isDyn) {
          stats.kinetic += KE;
          stats.potential += m * s.meta.g * (st.y - refY);
          stats.momentumX += m * st.vx;
          stats.momentumY += m * st.vy;
        }
        bodies[def.id] = {
          id: def.id, label: def.label, type: def.type, isBelt: !!def.isBelt,
          x: st.x, y: st.y, angle: def.angle || 0,
          vx: st.vx, vy: st.vy, w: 0,
          mass: m, inertia: 0,
          // 分项表按 PARTS 通用构造：写死 6 项会让新增分项（万有引力/电场力）
          // 在帧里凭空消失——图上画得出来、探针却读不到。
          forces: (function () {
            var o = {};
            PARTS.forEach(function (k) { o[k] = forces[k]; });
            o.total = [totalX, totalY];
            o.totalTorque = 0;
            return o;
          })(),
          accel: (!firstFrame && isDyn)
            ? [(st.vx - stateStart[def.id].vx) / frameDt, (st.vy - stateStart[def.id].vy) / frameDt]
            : [0, 0],
          impulse: (!firstFrame && isDyn && a) ? [a.impulse.fx, a.impulse.fy] : [0, 0],
          momentum: isDyn ? [m * st.vx, m * st.vy] : [0, 0],
          residual: residual,
          contacts: [],
          joints: jItems.filter(function (it) { return !it.body || it.body === def.id; })
            .map(function (it) {
              return { id: it.id, kind: it.kind || 'rod', side: it.side || 1,
                       force: it.force, torque: it.torque || 0 };
            })
        };
      });
      stats.mechanical = stats.kinetic + stats.potential;
      // 模型可提供额外势能（例如万有引力势能 −Gm₁m₂/r）：
      // 没有它，轨道这类模型的"机械能守恒"就无从谈起。
      if (typeof laws.potential === 'function') {
        var extra = laws.potential(t, S);
        if (typeof extra === 'number' && isFinite(extra)) stats.mechanical += extra;
      }
      stats.duration = s.meta.duration;
      return { t: t, index: frameIndex++, dt: frameDt, bodies: bodies, stats: stats };
    }

    function record() {
      if (frameIndex > 0) throw new Error('同一个 sim 实例只能 record() 一次，请重新 createSim');
      resetAcc();
      stateStart = snap();
      var frames = [buildFrame(0, true)];
      for (var i = 1; i <= nFrames; i++) {
        var tTarget = i * dtOut;
        resetAcc();
        stateStart = snap();
        advanceTo(tTarget);
        frames.push(buildFrame(dtOut, false));
      }
      return {
        scene: s,
        built: { engine: 'verlet', world: null, byId: S, events: eventLog.slice() },
        frames: frames,
        variables: {}
      };
    }

    return { record: record, state: function () { return S; }, events: function () { return eventLog.slice(); } };
  }

  return { createVerletSim: createVerletSim, PARTS: PARTS };
});
