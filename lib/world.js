/*!
 * MrAwU（阿物先生）— lib/world.js
 * 把规范化场景装配成 planck 世界：刚体、夹具、关节、外力（弹簧/恒力/阻力）。
 * 双模：Node require('../vendor/planck.min.js')，浏览器用 globalThis.planck。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./scene.js'), require('../vendor/planck.min.js'));
  } else {
    root.PFA = root.PFA || {};
    root.PFA.world = factory(root.PFA.scene, root.planck);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (scene, planck) {
  'use strict';

  // 注意：轻量版（--engine verlet）里不会打包 planck，但 world.js 仍会被内联进来。
  // 所以这里**不能在加载时解引用 planck**，否则整个 LIB 脚本块会中断，
  // 后面的 draw.js/graph.js 都不会注册（表现为画面全空、报 PFA.draw 未定义）。
  var Vec2 = planck ? planck.Vec2 : null;

  function fixtureFor(P, shape) {
    if (!P) throw new Error('这个模型需要 planck.js；当前是自研 Verlet 轻量版（未打包 planck）');
    var k = shape.kind;
    if (k === 'circle') return new P.Circle(shape.r);
    if (k === 'edge') return new P.Edge(P.Vec2(shape.a[0], shape.a[1]), P.Vec2(shape.b[0], shape.b[1]));
    var pts = scene.shapePoints(shape);
    if (!pts) throw new Error('不支持的形状: ' + k);
    return new P.Polygon(pts.map(function (p) { return P.Vec2(p[0], p[1]); }));
  }

  function build(planckMod, s) {
    var P = planckMod || planck;
    var V = P.Vec2;
    var world = new P.World({ gravity: V(0, -s.meta.g) });
    // 必须关闭休眠：静止刚体一旦休眠，求解器就不再产生接触冲量，
    // 受力图会突然全部归零（静态受力图场景会完全失效）。
    if (typeof world.setAllowSleeping === 'function') world.setAllowSleeping(false);
    else if (typeof world.setAllowSleep === 'function') world.setAllowSleep(false);
    else if ('allowSleep' in world) world.allowSleep = false;

    var byId = {};
    var anchors = [];   // 世界锚点用的无夹具静态体，收集以便清理

    function makeAnchorBody(at) {
      var b = world.createBody({ type: 'static', position: V(at[0], at[1]) });
      b.__id = '__world_anchor_' + anchors.length;
      b.__isAnchor = true;
      anchors.push(b);
      return b;
    }

    // ---------------------------------------------------------- 刚体
    s.bodies.forEach(function (def) {
      var type = def.type === 'dynamic' ? 'dynamic' : def.type === 'kinematic' ? 'kinematic' : 'static';
      var body = world.createBody({
        type: type,
        position: V(def.at[0], def.at[1]),
        angle: def.angle || 0,
        fixedRotation: !!def.fixedRotation,
        bullet: !!def.bullet,
        linearDamping: type === 'dynamic' ? (def.linearDamping != null ? def.linearDamping : s.meta.linearDamping) : 0,
        angularDamping: type === 'dynamic' ? (def.angularDamping != null ? def.angularDamping : s.meta.angularDamping) : 0
      });
      body.__id = def.id;
      body.__def = def;
      if (def.gravityScale != null && def.gravityScale !== 1 && typeof body.setGravityScale === 'function') {
        body.setGravityScale(def.gravityScale);
      }

      var area = scene.shapeArea(def.shape);
      var density = 0;
      if (type === 'dynamic') {
        if (def.mass != null) density = area > 0 ? def.mass / area : 0;
        else density = def.density != null ? def.density : 1;
      }
      var fxOpts = {
        friction: def.friction != null ? def.friction : 0.4,
        restitution: def.restitution != null ? def.restitution : 0,
        density: density,
        isSensor: !!def.sensor
      };

      if (def.shape.kind === 'track') {
        // 圆轨道：用 n 段边近似（弦高误差随段数平方衰减）。
        // 关键：边坐标用「刚体局部坐标」，这样刚体自身的角度/位置会自动生效，
        // 与 lib/draw.js 的圆环绘制完全一致。
        var seg = def.shape.segments || 64;
        var R = def.shape.r;
        for (var i = 0; i < seg; i++) {
          var a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
          var p0 = V(R * Math.cos(a0), R * Math.sin(a0));
          var p1 = V(R * Math.cos(a1), R * Math.sin(a1));
          body.createFixture(new P.Edge(p0, p1), { friction: fxOpts.friction, restitution: fxOpts.restitution });
        }
      } else {
        body.createFixture(fixtureFor(P, def.shape), fxOpts);
      }

      if (type === 'dynamic') {
        body.setLinearVelocity(V(def.velocity[0], def.velocity[1]));
        body.setAngularVelocity(def.angularVelocity || 0);
      }
      if (type === 'kinematic') {
        // kinematic 刚体不受力、不被求解器推动，速度完全由我们设定：
        //   angularVelocity → 转盘（物块靠静摩擦跟着转）
        //   velocity        → 平移的传送带/平板
        // 必须在夹具创建之后设置，否则某些 planck 版本的 setTransform 会清掉速度。
        body.setLinearVelocity(V(def.velocity ? def.velocity[0] : 0, def.velocity ? def.velocity[1] : 0));
        body.setAngularVelocity(def.angularVelocity || 0);
      }
      if (def.isBelt) body.setLinearVelocity(V(def.beltSpeed, 0));
      byId[def.id] = body;
    });

    // ---------------------------------------------------------- 关节
    function resolve(ref) {
      if (!ref || ref === 'world') return null;
      var b = byId[ref];
      if (!b) throw new Error('关节引用了不存在的刚体: ' + ref);
      return b;
    }

    function jointBody(ref, at) {
      var b = resolve(ref);
      if (b) return b;
      return makeAnchorBody(at || [0, 0]);
    }

    var joints = [];
    s.joints.forEach(function (j, idx) {
      var A, B, def = null, joint = null;
      switch (j.kind) {
        case 'rod':
        case 'rope': {
          var wa = j.worldAnchorA || j.worldAnchor || (j.a === 'world' ? [0, 0] : null);
          var wb = j.worldAnchorB || j.worldAnchor || (j.b === 'world' ? [0, 0] : null);
          A = jointBody(j.a, wa);
          B = jointBody(j.b, wb);
          // 世界锚点：把锚点坐标解释为 A/B 的世界位置
          if (A.__isAnchor && wa) A.setTransform(V(wa[0], wa[1]), 0);
          if (B.__isAnchor && wb) B.setTransform(V(wb[0], wb[1]), 0);
          var pA = j.worldAnchorA ? V(j.worldAnchorA[0], j.worldAnchorA[1]) : A.getPosition();
          var pB = j.worldAnchorB ? V(j.worldAnchorB[0], j.worldAnchorB[1]) : B.getPosition();
          var length = j.length != null ? j.length : P.Vec2.distance(pA, pB);
          if (j.kind === 'rod') {
            joint = new P.DistanceJoint({
              bodyA: A, bodyB: B,
              localAnchorA: A.getLocalPoint(pA),
              localAnchorB: B.getLocalPoint(pB),
              length: length,
              // 关键：DistanceJoint 默认是「质量-弹簧-阻尼」软约束（frequencyHz 非零）。
              // 不显式置 0，杆就会像弹簧一样储能/耗能——摆动的圆周运动会持续掉机械能
              // （实测半圈掉 5%，最低点张力偏低 9%）。置 0 才是真正的刚性杆。
              frequencyHz: j.frequencyHz != null ? j.frequencyHz : 0,
              dampingRatio: j.dampingRatio != null ? j.dampingRatio : 0,
              collideConnected: !!j.collideConnected
            });
          } else {
            joint = new P.RopeJoint({
              bodyA: A, bodyB: B,
              localAnchorA: A.getLocalPoint(pA),
              localAnchorB: B.getLocalPoint(pB),
              maxLength: length,
              collideConnected: !!j.collideConnected
            });
          }
          break;
        }
        case 'pivot': {
          var anchor = j.worldAnchor || j.anchor || [0, 0];
          A = jointBody(j.a, anchor);
          B = jointBody(j.b, anchor);
          if (A.__isAnchor) A.setTransform(V(anchor[0], anchor[1]), 0);
          var w = V(anchor[0], anchor[1]);
          joint = new P.RevoluteJoint({
            bodyA: A, bodyB: B,
            localAnchorA: A.getLocalPoint(w),
            localAnchorB: B.getLocalPoint(w),
            referenceAngle: j.referenceAngle || 0,
            enableMotor: !!j.enableMotor,
            motorSpeed: j.motorSpeed || 0,
            maxMotorTorque: j.maxMotorTorque != null ? j.maxMotorTorque : 0,
            enableLimit: !!j.enableLimit,
            lowerAngle: (j.lowerAngleDeg || 0) * Math.PI / 180,
            upperAngle: (j.upperAngleDeg || 0) * Math.PI / 180,
            collideConnected: !!j.collideConnected
          });
          break;
        }
        case 'slider': {
          var an = j.worldAnchor || j.anchor || [0, 0];
          A = jointBody(j.a, an);
          B = jointBody(j.b, an);
          if (A.__isAnchor) A.setTransform(V(an[0], an[1]), 0);
          var ang = (j.axisDeg || 0) * Math.PI / 180;
          joint = new P.PrismaticJoint({
            bodyA: A, bodyB: B,
            localAnchorA: A.getLocalPoint(V(an[0], an[1])),
            localAnchorB: B.getLocalPoint(V(an[0], an[1])),
            localAxisA: V(Math.cos(ang), Math.sin(ang)),
            referenceAngle: j.referenceAngle || 0,
            enableMotor: !!j.enableMotor,
            motorSpeed: j.motorSpeed || 0,
            maxMotorForce: j.maxMotorForce != null ? j.maxMotorForce : 0,
            enableLimit: !!j.enableLimit,
            lowerTranslation: j.lowerTranslation || 0,
            upperTranslation: j.upperTranslation || 0,
            collideConnected: !!j.collideConnected
          });
          break;
        }
        case 'pulley': {
          var gA = j.groundAnchorA || [0, 0], gB = j.groundAnchorB || [0, 0];
          A = jointBody(j.a, gA);
          B = jointBody(j.b, gB);
          var aA = j.worldAnchorA || (A.__isAnchor ? gA : [A.getPosition().x, A.getPosition().y]);
          var aB = j.worldAnchorB || (B.__isAnchor ? gB : [B.getPosition().x, B.getPosition().y]);
          // planck 的 PulleyJointDef 需要 lengthA/lengthB（而不是 length）
          joint = new P.PulleyJoint({
            bodyA: A, bodyB: B,
            groundAnchorA: V(gA[0], gA[1]),
            groundAnchorB: V(gB[0], gB[1]),
            anchorA: V(aA[0], aA[1]),
            anchorB: V(aB[0], aB[1]),
            localAnchorA: A.getLocalPoint(V(aA[0], aA[1])),
            localAnchorB: B.getLocalPoint(V(aB[0], aB[1])),
            lengthA: j.lengthA != null ? j.lengthA : P.Vec2.distance(V(gA[0], gA[1]), V(aA[0], aA[1])),
            lengthB: j.lengthB != null ? j.lengthB : P.Vec2.distance(V(gB[0], gB[1]), V(aB[0], aB[1])),
            ratio: j.ratio != null ? j.ratio : 1,
            collideConnected: !!j.collideConnected
          });
          break;
        }
        case 'weld': {
          var wc = j.worldAnchor || [0, 0];
          A = jointBody(j.a, wc);
          B = jointBody(j.b, wc);
          if (A.__isAnchor) A.setTransform(V(wc[0], wc[1]), 0);
          joint = new P.WeldJoint({
            bodyA: A, bodyB: B,
            localAnchorA: A.getLocalPoint(V(wc[0], wc[1])),
            localAnchorB: B.getLocalPoint(V(wc[0], wc[1])),
            referenceAngle: j.referenceAngle || 0,
            collideConnected: !!j.collideConnected
          });
          break;
        }
        case 'wheel': {
          var wa2 = j.worldAnchor || [0, 0];
          A = jointBody(j.a, wa2);
          B = jointBody(j.b, wa2);
          if (A.__isAnchor) A.setTransform(V(wa2[0], wa2[1]), 0);
          var ax = (j.axisDeg || 0) * Math.PI / 180;
          joint = new P.WheelJoint({
            bodyA: A, bodyB: B,
            localAnchorA: A.getLocalPoint(V(wa2[0], wa2[1])),
            localAnchorB: B.getLocalPoint(V(wa2[0], wa2[1])),
            localAxisA: V(Math.cos(ax), Math.sin(ax)),
            enableMotor: !!j.enableMotor,
            motorSpeed: j.motorSpeed || 0,
            maxMotorTorque: j.maxMotorTorque != null ? j.maxMotorTorque : 0,
            frequencyHz: j.frequencyHz != null ? j.frequencyHz : 0,
            dampingRatio: j.dampingRatio != null ? j.dampingRatio : 0.7,
            collideConnected: !!j.collideConnected
          });
          break;
        }
        default:
          throw new Error('不支持的关节类型: ' + j.kind);
      }
      var created = world.createJoint(joint);
      if (created) {
        created.__id = j.id || (j.kind + '_' + idx);
        created.__def = j;
        joints.push({ def: j, joint: created });
      } else {
        joints.push({ def: j, joint: null, failed: true });
      }
    });

    // ---------------------------------------------------------- 外力
    var forceDefs = s.forces.map(function (f) { return f; });

    function pointOn(ref, wAnchor, bAnchor, isB) {
      var b = ref && ref !== 'world' ? byId[ref] : null;
      if (!b) return wAnchor ? V(wAnchor[0], wAnchor[1]) : null;
      var local = bAnchor ? V(bAnchor[0], bAnchor[1]) : V(0, 0);
      return b.getWorldPoint(local);
    }

    /** 每步仿真前施加显式外力；返回本步各刚体受到的外力（用于受力分解）
     *  tNow 为当前仿真时刻（秒），用于支持「作用一段时间后撤去」的外力（from / until）。 */
    function applyForces(tNow) {
      var applied = {};
      var now = tNow || 0;
      function add(id, fx, fy, px, py) {
        if (!applied[id]) applied[id] = { fx: 0, fy: 0, torque: 0, items: [] };
        applied[id].fx += fx; applied[id].fy += fy;
        if (px != null) {
          var b = byId[id];
          var p = b.getPosition();
          applied[id].torque += (px - p.x) * fy - (py - p.y) * fx;
        }
      }
      forceDefs.forEach(function (f) {
        // 限时外力：f.until 之后撤去、f.from 之前不施加（物理题里"作用 2s 后撤去"极常见）
        if (f.until != null && now > f.until) return;
        if (f.from != null && now < f.from) return;
        if (f.kind === 'constant') {
          var b = byId[f.body];
          if (!b || !b.isDynamic()) return;
          var lp = f.at || [0, 0];
          var wp = b.getWorldPoint(V(lp[0], lp[1]));
          b.applyForce(V(f.force[0], f.force[1]), wp, true);
          add(f.body, f.force[0], f.force[1], wp.x, wp.y);
        } else if (f.kind === 'drag') {
          var b2 = byId[f.body];
          if (!b2 || !b2.isDynamic()) return;
          var v = b2.getLinearVelocity();
          var fx = -(f.k != null ? f.k : 0.5) * v.x, fy = -(f.k != null ? f.k : 0.5) * v.y;
          if (f.quadratic) {
            var sp = Math.hypot(v.x, v.y);
            fx = -f.k * sp * v.x; fy = -f.k * sp * v.y;
          }
          b2.applyForceToCenter(V(fx, fy), true);
          add(f.body, fx, fy);
        } else if (f.kind === 'torque') {
          var b3 = byId[f.body];
          if (!b3 || !b3.isDynamic()) return;
          b3.applyTorque(f.value, true);
          if (!applied[f.body]) applied[f.body] = { fx: 0, fy: 0, torque: 0, items: [] };
          applied[f.body].torque += f.value;
        } else if (f.kind === 'spring') {
          var bA = f.a && f.a !== 'world' ? byId[f.a] : null;
          var bB = f.b && f.b !== 'world' ? byId[f.b] : null;
          var la = f.anchorA || [0, 0], lb = f.anchorB || [0, 0];
          var Pa = bA ? bA.getWorldPoint(V(la[0], la[1])) : (f.worldAnchorA ? V(f.worldAnchorA[0], f.worldAnchorA[1]) : null);
          var Pb = bB ? bB.getWorldPoint(V(lb[0], lb[1])) : (f.worldAnchorB ? V(f.worldAnchorB[0], f.worldAnchorB[1]) : null);
          if (!Pa || !Pb) return;
          var dx = Pb.x - Pa.x, dy = Pb.y - Pa.y;
          var len = Math.hypot(dx, dy) || 1e-9;
          var ux = dx / len, uy = dy / len;
          var relVx = 0, relVy = 0;
          if (bB) { var vB = bB.getLinearVelocityFromWorldPoint(Pb); relVx += vB.x; relVy += vB.y; }
          if (bA) { var vA = bA.getLinearVelocityFromWorldPoint(Pa); relVx -= vA.x; relVy -= vA.y; }
          var vrel = relVx * ux + relVy * uy;
          // 弹簧是「拉」不是「推」：伸长时把 B 拉回 A。
          // u 由 A 指向 B，vrel > 0 表示两者在分离，故两项都取负号。
          var mag = -((f.k || 0) * (len - (f.rest || 0)) + (f.c || 0) * vrel);
          var Fx = mag * ux, Fy = mag * uy;
          if (bB && bB.isDynamic()) { bB.applyForce(V(Fx, Fy), Pb, true); add(f.b, Fx, Fy, Pb.x, Pb.y); }
          if (bA && bA.isDynamic()) { bA.applyForce(V(-Fx, -Fy), Pa, true); add(f.a, -Fx, -Fy, Pa.x, Pa.y); }
        }
      });
      return applied;
    }

    // 每对接触面的精确摩擦/恢复系数（覆盖 planck 默认的几何平均）
    var pairRules = (s.meta.frictionPairs || []).map(function (p) {
      return { a: p.a, b: p.b, friction: p.friction, restitution: p.restitution };
    });
    if (pairRules.length) {
      world.on('pre-solve', function (contact) {
        var ia = contact.getFixtureA().getBody().__id;
        var ib = contact.getFixtureB().getBody().__id;
        for (var i = 0; i < pairRules.length; i++) {
          var r = pairRules[i];
          if ((r.a === ia && r.b === ib) || (r.a === ib && r.b === ia)) {
            if (r.friction != null) contact.setFriction(r.friction);
            if (r.restitution != null) contact.setRestitution(r.restitution);
            return;
          }
        }
      });
    }

    return {
      scene: s,
      world: world,
      byId: byId,
      joints: joints,
      anchors: anchors,
      applyForces: applyForces,
      dt: s.meta.simDt
    };
  }

  return { build: build, fixtureFor: fixtureFor };
});
