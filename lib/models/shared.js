/*!
 * MrAwU（阿物先生）— lib/models/shared.js
 * 跨模型文件共享的受力律构件。
 * 为什么要单独一个文件：每个模型文件（mechanics.js / motion.js）都是独立的 UMD 工厂，
 * 互相拿不到对方的内部函数。把"重力 + 水平地面"这种通用受力律放在这里，
 * 平抛、斜抛、自由落体就能共用同一份**已验证**的实现，而不是各写一遍。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.PFA = root.PFA || {};
    root.PFA.lawsShared = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /**
   * 「重力 + 水平地面」受力律（自由落体 / 平抛 / 斜抛共用）。
   *   - 落地前只有重力；
   *   - 接触地面后净支持力 = mg（竖直方向不再加速）；
   *   - project() 把小球限制在地面之上，被抹掉的那部分速度由积分器记成支持力冲量；
   *   - nextEvent() 把落地时刻解析给出，积分器精确停在那一刻。
   */
  function groundBallLaws(opt) {
    var m = opt.mass, g = opt.g, R = opt.r;
    function force(t, S) {
      var contact = S.ball.y <= R + 1e-9;
      return {
        ball: {
          parts: {
            gravity: [0, -m * g],
            normal: contact ? [0, m * g] : [0, 0],
            friction: [0, 0], applied: [0, 0], joint: [0, 0], damping: [0, 0]
          }
        }
      };
    }
    function project(t, S) {
      if (S.ball.y >= R) return null;
      S.ball.y = R;
      if (S.ball.vy < 0) S.ball.vy = 0;              // 完全非弹性着地，不反弹
      return { ball: { part: 'normal' } };
    }
    function nextEvent(t) {
      if (opt.tFall == null || t >= opt.tFall - 1e-12) return null;
      return opt.tFall;
    }
    return { force: force, project: project, nextEvent: nextEvent };
  }

  return { groundBallLaws: groundBallLaws };
});
