/*!
 * MrAwU（阿物先生）— lib/sim.js
 * 仿真与受力记录：按固定步长推进，并在每个输出帧内用「冲量累加」做严格的受力分解。
 *
 * 为什么用冲量而不是瞬时力：
 *   冲量-动量定理 ΣJ = Δp 在一帧内严格成立，所以
 *   残差 |ΣJ − Δp| 可以直接当作"受力图画得对不对"的机器自检，
 *   同时碰撞这类冲激过程也不会因为采样时刻不同而抖动。
 *   对外展示时再除以帧时长换算成平均力（N）。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    var v = null;
    try { v = require('./verlet.js'); } catch (e) { v = null; }
    module.exports = factory(require('./scene.js'), require('./world.js'), v);
  } else {
    root.PFA = root.PFA || {};
    root.PFA.sim = factory(root.PFA.scene, root.PFA.world, root.PFA.verlet);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (sceneLib, worldLib, verletLib) {
  'use strict';

  function createSim(planckMod, rawScene, options) {
    var opts = options || {};
    var s = rawScene.schema === sceneLib.SCHEMA ? rawScene : sceneLib.normalize(rawScene);
    // 引擎选择：verlet = 自研速度-Verlet（模型需声明 scene.laws）；默认 planck
    var engine = opts.engine || (s.laws ? 'verlet' : 'planck');
    if (engine === 'verlet') {
      if (!verletLib) throw new Error('verlet 后端未加载');
      return verletLib.createVerletSim(s, opts);
    }
    var built = worldLib.build(planckMod, s);
    var world = built.world;
    var byId = built.byId;
    var P = planckMod || (typeof planck !== 'undefined' ? planck : null);
    var V = P.Vec2;

    var dtOut = s.meta.dt;
    var dtSim = s.meta.simDt;
    var subSteps = s.meta.subSteps;
    var dynamicIds = s.bodies.filter(function (b) { return b.type === 'dynamic'; }).map(function (b) { return b.id; });
    var allIds = s.bodies.map(function (b) { return b.id; });

    var t = 0;
    var frameIndex = 0;
    var acc = null;
    var stateStart = null;

    function blank() { return { fx: 0, fy: 0, torque: 0 }; }
    function blankAcc() {
      var a = {};
      allIds.forEach(function (id) {
        a[id] = {
          gravity: blank(), gravitation: blank(), electric: blank(),
          normal: blank(), friction: blank(),
          applied: blank(), joint: blank(), damping: blank(),
          contacts: {}, jointItems: {}
        };
      });
      return a;
    }

    function snapState() {
      var st = {};
      allIds.forEach(function (id) {
        var b = byId[id];
        var v = b.getLinearVelocity();
        st[id] = {
          vx: v.x, vy: v.y, w: b.getAngularVelocity(),
          x: b.getPosition().x, y: b.getPosition().y, angle: b.getAngle()
        };
      });
      return st;
    }

    // ---- 接触冲量：post-solve 给出本步施加在 fixtureB 上的冲量 ----
    world.on('post-solve', function (contact, impulse) {
      if (!acc) return;
      var manifold = contact.getManifold();
      if (!manifold || !manifold.pointCount) return;
      var wm = null;
      try { wm = contact.getWorldManifold(null); } catch (e) { wm = null; }
      var nx, ny;
      if (wm && wm.normal) { nx = wm.normal.x; ny = wm.normal.y; }
      else { nx = manifold.localNormal.x; ny = manifold.localNormal.y; }
      var tx = ny, ty = -nx;                       // Box2D 约定：tangent = cross(normal, 1)
      var fa = contact.getFixtureA(), fb = contact.getFixtureB();
      var ia = fa.getBody().__id, ib = fb.getBody().__id;
      var count = Math.min(manifold.pointCount, impulse.normalImpulses.length);

      for (var i = 0; i < count; i++) {
        var Jn = impulse.normalImpulses[i];
        var Jt = impulse.tangentImpulses ? impulse.tangentImpulses[i] : 0;
        // 冲量作用在 B 上沿 +n/+t，作用在 A 上沿 −n/−t
        var px = wm && wm.points && wm.points[i] ? wm.points[i].x : 0;
        var py = wm && wm.points && wm.points[i] ? wm.points[i].y : 0;
        var nfx = Jn * nx, nfy = Jn * ny;
        var tfx = Jt * tx, tfy = Jt * ty;

        function put(id, sgn) {
          var a = acc[id];
          if (!a) return;
          a.normal.fx += sgn * nfx; a.normal.fy += sgn * nfy;
          a.friction.fx += sgn * tfx; a.friction.fy += sgn * tfy;
          var key = (id === ia ? ib : ia);
          var c = a.contacts[key] || (a.contacts[key] = { fx: 0, fy: 0, fnx: 0, fny: 0, n: 0, px: 0, py: 0, fn: 0, ft: 0 });
          c.fx += sgn * nfx; c.fy += sgn * nfy;
          c.fn += Jn; c.ft += Jt;
          c.fnx += sgn * nx; c.fny += sgn * ny;
          c.n++; c.px = px; c.py = py;
          // 力矩冲量 r × J
          var bp = byId[id].getPosition();
          a.normal.torque += (px - bp.x) * (sgn * nfy) - (py - bp.y) * (sgn * nfx);
          a.friction.torque += (px - bp.x) * (sgn * tfy) - (py - bp.y) * (sgn * tfx);
        }
        put(ib, 1);
        put(ia, -1);
      }
    });

    function stepFrame() {
      stateStart = snapState();
      acc = blankAcc();
      var frameApplied = {};
      var dts = dtSim;
      for (var k = 0; k < subSteps; k++) {
        var applied = built.applyForces(t);   // 传入当前时刻，支持「作用一段时间后撤去」的外力
        // 记录显式外力冲量
        for (var id in applied) {
          var a = acc[id]; if (!a) continue;
          a.applied.fx += applied[id].fx * dts;
          a.applied.fy += applied[id].fy * dts;
          a.applied.torque += applied[id].torque * dts;
          if (!frameApplied[id]) frameApplied[id] = { fx: 0, fy: 0, torque: 0, items: [] };
          frameApplied[id].fx += applied[id].fx; frameApplied[id].fy += applied[id].fy;
          frameApplied[id].torque += applied[id].torque;
        }
        // 重力冲量
        dynamicIds.forEach(function (id) {
          var b = byId[id];
          var m = b.getMass();
          var gs = typeof b.getGravityScale === 'function' ? b.getGravityScale() : 1;
          var g = world.getGravity();
          acc[id].gravity.fx += m * g.x * gs * dts;
          acc[id].gravity.fy += m * g.y * gs * dts;
        });
        // 线性/角阻尼冲量（默认 0，非 0 时才计入分解）
        dynamicIds.forEach(function (id) {
          var b = byId[id];
          var ld = b.getLinearDamping ? b.getLinearDamping() : 0;
          var ad = b.getAngularDamping ? b.getAngularDamping() : 0;
          if (ld > 0) {
            var v = b.getLinearVelocity();
            var m = b.getMass();
            var f = -m * ld / (1 + dts * ld);
            acc[id].damping.fx += f * v.x * dts;
            acc[id].damping.fy += f * v.y * dts;
          }
          if (ad > 0) {
            var I = b.getInertia();
            var w = b.getAngularVelocity();
            var ft = -I * ad / (1 + dts * ad);
            acc[id].damping.torque += ft * w * dts;
          }
        });

        world.step(dts, s.meta.velocityIterations, s.meta.positionIterations);
        t += dts;

        // 关节反力冲量。
        // rod/rope/pivot 等：getReactionForce 返回"作用在 bodyB 上的力"，A 取反。
        // pulley：返回值的方向随绳段朝向变化，因此改用自己的几何量：
        //         张力大小 T = |F|，A、B 各自沿"自身绳段指向地面锚点"的方向受力。
        // 任何符号/方向错误都会立刻表现为残差 |ΣJ−Δp| ≈ 100%。
        built.joints.forEach(function (entry) {
          var j = entry.joint;
          if (!j) return;
          var inv = 1 / dts;
          var F = j.getReactionForce(inv);
          var T = j.getReactionTorque ? j.getReactionTorque(inv) : 0;
          var FA, FB;
          if (entry.def.kind === 'pulley' && j.getGroundAnchorA) {
            var Tmag = Math.hypot(F.x, F.y);
            var gA = j.getGroundAnchorA(), gB = j.getGroundAnchorB();
            var pA = j.getAnchorA(), pB = j.getAnchorB();
            function unit(from, to) {
              var dx = to.x - from.x, dy = to.y - from.y;
              var l = Math.hypot(dx, dy) || 1e-9;
              return { x: dx / l * Tmag, y: dy / l * Tmag };
            }
            FA = unit(pA, gA);
            FB = unit(pB, gB);
          } else {
            FA = { x: -F.x, y: -F.y };
            FB = { x: F.x, y: F.y };
          }
          var aId = entry.def.a, bId = entry.def.b;
          function accum(id, Fv, sgnT) {
            if (!id || id === 'world' || !acc[id]) return;
            acc[id].joint.fx += Fv.x * dts; acc[id].joint.fy += Fv.y * dts;
            acc[id].joint.torque += sgnT * dts;
            var it = acc[id].jointItems[entry.joint.__id] ||
              (acc[id].jointItems[entry.joint.__id] = { fx: 0, fy: 0, torque: 0, kind: entry.def.kind, id: entry.joint.__id });
            it.fx += Fv.x * dts; it.fy += Fv.y * dts; it.torque += sgnT * dts;
          }
          accum(aId, FA, -T);
          accum(bId, FB, T);
        });
      }
      return buildFrame(frameApplied);
    }

    function buildFrame(frameApplied) {
      var frameDt = subSteps * dtSim;
      var stateEnd = snapState();
      var bodies = {};
      var stats = {
        kinetic: 0, potential: 0, mechanical: 0,
        momentumX: 0, momentumY: 0, residualMax: 0, residualAbsMax: 0,
        appliedForceNames: []
      };
      var refY = s.meta.energyRefY != null ? s.meta.energyRefY : 0;

      allIds.forEach(function (id) {
        var b = byId[id];
        var def = b.__def;
        var a = acc[id];
        var st0 = stateStart[id], st1 = stateEnd[id];
        var isDyn = def.type === 'dynamic';
        var m = isDyn ? b.getMass() : 0;
        var I = isDyn ? b.getInertia() : 0;
        var pos = b.getPosition();

        function toF(v) { return [v.fx / frameDt, v.fy / frameDt]; }
        var gravity = toF(a.gravity), normal = toF(a.normal), friction = toF(a.friction);
        var gravitation = toF(a.gravitation || blank()), electric = toF(a.electric || blank());
        var applied = toF(a.applied), jointF = toF(a.joint), damping = toF(a.damping);
        var totalX = gravity[0] + normal[0] + friction[0] + applied[0] + jointF[0] + damping[0] + gravitation[0] + electric[0];
        var totalY = gravity[1] + normal[1] + friction[1] + applied[1] + jointF[1] + damping[1] + gravitation[1] + electric[1];
        var totalT = (a.gravity.torque + a.normal.torque + a.friction.torque + a.applied.torque + a.joint.torque + a.damping.torque) / frameDt;

        var dpX = isDyn ? m * (st1.vx - st0.vx) : 0;
        var dpY = isDyn ? m * (st1.vy - st0.vy) : 0;
        var dL = isDyn ? I * (st1.w - st0.w) : 0;
        var sumX = (a.gravity.fx + a.normal.fx + a.friction.fx + a.applied.fx + a.joint.fx + a.damping.fx);
        var sumY = (a.gravity.fy + a.normal.fy + a.friction.fy + a.applied.fy + a.joint.fy + a.damping.fy);
        var scale = Math.max(1e-6, Math.abs(dpX) + Math.abs(dpY) + Math.abs(sumX) + Math.abs(sumY));
        var residual = isDyn ? Math.hypot(sumX - dpX, sumY - dpY) / scale : 0;
        if (residual > stats.residualMax) stats.residualMax = residual;
        // 绝对残差（N·s）：整体几乎不动时 ΣF 与 Δp 同时趋于 0，相对残差会出现 0/0 假警报，
        // 所以同时记录绝对量，判定时"相对够小 或 绝对够小"都算通过。
        var absErr = isDyn ? Math.hypot(sumX - dpX, sumY - dpY) : 0;
        if (absErr > stats.residualAbsMax) stats.residualAbsMax = absErr;

        var contacts = Object.keys(a.contacts).map(function (other) {
          var c = a.contacts[other];
          var nlen = c.n || 1;
          return {
            other: other,
            point: [c.px, c.py],
            normal: [c.fnx / nlen, c.fny / nlen],
            normalForce: c.fn / frameDt,
            frictionForce: c.ft / frameDt,
            force: [c.fx / frameDt, c.fy / frameDt]
          };
        });
        var jointItems = Object.keys(a.jointItems).map(function (k) {
          var it = a.jointItems[k];
          return {
            id: it.id, kind: it.kind, side: it.side,
            force: [it.fx / frameDt, it.fy / frameDt],
            torque: it.torque / frameDt
          };
        });

        if (isDyn) {
          var KE = 0.5 * m * (st1.vx * st1.vx + st1.vy * st1.vy) + 0.5 * I * st1.w * st1.w;
          stats.kinetic += KE;
          stats.potential += m * s.meta.g * (pos.y - refY);
          stats.momentumX += m * st1.vx;
          stats.momentumY += m * st1.vy;
        }

        bodies[id] = {
          id: id, label: def.label, type: def.type, isBelt: !!def.isBelt,
          x: pos.x, y: pos.y, angle: b.getAngle(),
          vx: st1.vx, vy: st1.vy, w: st1.w,
          mass: m, inertia: I,
          forces: {
            gravity: gravity, gravitation: gravitation, electric: electric,
            normal: normal, friction: friction,
            applied: applied, joint: jointF, damping: damping,
            total: [totalX, totalY], totalTorque: totalT
          },
          accel: isDyn ? [(st1.vx - st0.vx) / frameDt, (st1.vy - st0.vy) / frameDt] : [0, 0],
          impulse: [sumX, sumY],
          momentum: isDyn ? [m * st1.vx, m * st1.vy] : [0, 0],
          residual: residual,
          contacts: contacts,
          joints: jointItems
        };
      });

      stats.mechanical = stats.kinetic + stats.potential;
      stats.duration = s.meta.duration;     // 场景时长（弹道模型用来对照"落地时刻"）
      return {
        t: t, index: frameIndex++, dt: frameDt,
        bodies: bodies, stats: stats
      };
    }

    function record() {
      if (frameIndex > 0) throw new Error('同一个 sim 实例只能 record() 一次，请重新 createSim');
      // t = 0 的初始帧：接触/关节尚未产生，只有重力
      var frameDt0 = subSteps * dtSim;
      stateStart = snapState();
      acc = blankAcc();
      dynamicIds.forEach(function (id) {
        var b = byId[id], m = b.getMass(), g = world.getGravity();
        var gs = typeof b.getGravityScale === 'function' ? b.getGravityScale() : 1;
        acc[id].gravity.fx += m * g.x * gs * frameDt0;
        acc[id].gravity.fy += m * g.y * gs * frameDt0;
      });
      var frames = [];
      frames.push(buildFrame({}));

      var requested = opts.frames != null ? opts.frames : s.meta.frames;
      for (var i = 0; i < requested; i++) {
        frames.push(stepFrame());
      }
      return { scene: s, built: built, frames: frames, variables: variables() };
    }

    function variables() {
      var vars = {};
      allIds.forEach(function (id) {
        vars[id] = {
          x: function () { return byId[id].getPosition().x; },
          y: function () { return byId[id].getPosition().y; },
          vx: function () { return byId[id].getLinearVelocity().x; },
          vy: function () { return byId[id].getLinearVelocity().y; },
          angle: function () { return byId[id].getAngle(); },
          speed: function () { return byId[id].getLinearVelocity().length(); }
        };
      });
      return vars;
    }

    /** 无渲染快速预演：用于相机取景、统计与"预期值"对照 */
    function preview(maxFrames) {
      var frames = [];
      var n = maxFrames != null ? maxFrames : s.meta.frames;
      frameIndex = 0; t = 0;
      stateStart = snapState(); acc = blankAcc();
      frames.push(buildFrame({}));
      for (var i = 0; i < n; i++) frames.push(stepFrame());
      return frames;
    }

    return {
      scene: s, built: built, world: world, byId: byId,
      record: record, preview: preview, stepFrame: function () { return stepFrame(); },
      get time() { return t; },
      variables: variables,
      allIds: allIds, dynamicIds: dynamicIds
    };
  }

  return { createSim: createSim };
});
