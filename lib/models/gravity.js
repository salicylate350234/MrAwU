/*!
 * MrAwU（阿物先生）— 万有引力模型组
 *
 * 与力学组一样：每个模型自带 expect()，给出解析解与对应的 probe，
 * 动画运行时逐项对照；自研 Verlet 引擎把它当成"只有中心力的二体问题"来积分。
 *
 * 双星模型是这一组的第一个模型：
 *   两星绕共同质心做圆周运动，万有引力提供向心力。
 *   解析解：r₁ = m₂r/(m₁+m₂)、r₂ = m₁r/(m₁+m₂)
 *           ω = √(G(m₁+m₂)/r³)，T = 2π/ω
 *           v₁ = ωr₁（反比于质量），F = Gm₁m₂/r²，E = −Gm₁m₂/(2r)
 *   这些都是"可以手算核对"的量，所以每一项都能变成机器可验证的对照项。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.PFA = root.PFA || {};
    root.PFA.models_gravity = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /** 双星几何：两星绕质心的圆周运动，质心固定在原点 */
  function binaryGeom(p) {
    var G = p.G, m1 = p.mass1, m2 = p.mass2, r = p.r;
    var M = m1 + m2;
    var r1 = m2 * r / M, r2 = m1 * r / M;             // 各自到质心的距离
    var omega = Math.sqrt(G * M / (r * r * r));        // 角速度
    var v1 = omega * r1, v2 = omega * r2;              // 线速度
    var T = 2 * Math.PI / omega;                       // 周期
    var F = G * m1 * m2 / (r * r);                     // 相互引力
    var mu = m1 * m2 / M;
    var E = -G * m1 * m2 / (2 * r);                    // 机械能（含动能与引力势能）
    var L = mu * Math.sqrt(G * M * r);                 // 角动量
    // 星半径按"密度相同"取（∛m），让质量大的星看着更大
    var k = 0.16;
    var R1 = k * Math.cbrt(m1), R2 = k * Math.cbrt(m2);
    // 演示时长默认 2.1 个周期：周期探针需要"两次同向过零"，
    // 正好取 2T 时第二次穿越会卡在最后一帧之外，测不到周期。
    var dur = p.duration > 0 ? p.duration : 2.1 * T;
    var w = [0.55 * dur, 0.95 * dur];
    return {
      G: G, m1: m1, m2: m2, M: M, r: r, r1: r1, r2: r2,
      omega: omega, v1: v1, v2: v2, T: T, F: F, mu: mu, E: E, L: L,
      R1: R1, R2: R2, dur: dur, w: w
    };
  }

  /**
   * 受力律：每颗星只受另一颗星的万有引力（平方反比、沿连线）。
   * 用中点时刻求力 + 事件机制，这个模型的机械能与角动量都能守恒得很好。
   */
  function binaryLaws(p) {
    var G = p.G, m1 = p.mass1, m2 = p.mass2;
    function sep(S) {
      var dx = S.star2.x - S.star1.x, dy = S.star2.y - S.star1.y;
      var d = Math.sqrt(dx * dx + dy * dy);
      return d < 1e-9 ? 1e-9 : d;
    }
    function force(t, S) {
      var dx = S.star2.x - S.star1.x, dy = S.star2.y - S.star1.y;
      var d = sep(S);
      var F = G * m1 * m2 / (d * d);
      var ux = dx / d, uy = dy / d;                    // 星1 → 星2 的单位矢量
      return {
        star1: {
          parts: {
            gravity: [0, 0], gravitation: [F * ux, F * uy], electric: [0, 0],
            normal: [0, 0], friction: [0, 0], applied: [0, 0], joint: [0, 0], damping: [0, 0]
          }
        },
        star2: {
          parts: {
            gravity: [0, 0], gravitation: [-F * ux, -F * uy], electric: [0, 0],
            normal: [0, 0], friction: [0, 0], applied: [0, 0], joint: [0, 0], damping: [0, 0]
          }
        }
      };
    }
    // 万有引力势能（取无穷远为零）：E_p = −Gm₁m₂/r
    function potential(t, S) { return -G * m1 * m2 / sep(S); }
    return { force: force, potential: potential };
  }

  function binary(p) {
    var q = binaryGeom(p);
    return {
      title: '双星系统',
      subtitle: '两星绕共同质心做圆周运动，万有引力提供向心力',
      tags: ['万有引力', '双星', '圆周运动', '质心'],
      meta: { g: 0, duration: q.dur, dt: 1 / 60, subSteps: 8, energyRefY: 0 },
      view: { height: 620, grid: true },
      bodies: [
        { id: 'star1', type: 'dynamic', shape: { kind: 'circle', r: q.R1 },
          at: [q.r1, 0], velocity: [0, q.v1], mass: q.m1,
          label: '星1 m₁=' + q.m1 + 'kg', color: '#e8934a', showForces: true },
        { id: 'star2', type: 'dynamic', shape: { kind: 'circle', r: q.R2 },
          at: [-q.r2, 0], velocity: [0, -q.v2], mass: q.m2,
          label: '星2 m₂=' + q.m2 + 'kg', color: '#5fa8ff', showForces: true }
      ],
      joints: [], forces: [],
      // planck 侧没有"相互引力"这一种力，所以本模型只用自研引擎跑；
      // 自检改为"全部对照项对解析解"（二体问题的解析解本身是精确的）。
      verletOnly: true,
      markers: [
        { t: q.T, label: '一个周期',
          note: '双星转过一整圈：T = 2π√(r³/(G(m₁+m₂))) = ' + q.T.toFixed(3) +
            ' s。两星始终在连线的两端、到质心的距离比等于质量反比（r₁:r₂ = m₂:m₁ = ' +
            (q.r1 / q.r2).toFixed(3) + '）。' }
      ].filter(function (mk) { return mk.t <= q.dur * 1.001; }),
      notes: '解析：ω = √(G(m₁+m₂)/r³)，T = 2π/ω = ' + q.T.toFixed(3) + ' s；' +
        'r₁ = m₂r/(m₁+m₂) = ' + q.r1.toFixed(3) + ' m，r₂ = ' + q.r2.toFixed(3) + ' m；' +
        'v₁ = ωr₁ = ' + q.v1.toFixed(3) + ' m/s，v₂ = ' + q.v2.toFixed(3) + ' m/s（速率比 = 质量反比）；' +
        'F = Gm₁m₂/r² = ' + q.F.toPrecision(4) + ' N；E = −Gm₁m₂/(2r) = ' + q.E.toPrecision(4) + ' J',
      laws: binaryLaws(p)
    };
  }

  binary.expect = function (p) {
    var q = binaryGeom(p);
    var w = q.w;
    var items = [
      { label: '两星间距 r（圆轨道下保持不变）', unit: 'm', value: q.r,
        probe: { kind: 'relative', body: 'star2', ref: 'star1', mode: 'mag',
                 window: w, reduce: 'max', tolerance: 0.01 } },
      { label: '万有引力 F = Gm₁m₂/r²', unit: 'N', value: q.F,
        probe: { kind: 'force', body: 'star1', comp: 'gravitation', mode: 'mag',
                 window: w, reduce: 'last', tolerance: 0.02 } },
      { label: '星1 速率 v₁ = ωr₁', unit: 'm/s', value: q.v1,
        probe: { kind: 'velocity', body: 'star1', mode: 'mag', window: w, reduce: 'last', tolerance: 0.02 } },
      { label: '星2 速率 v₂ = ωr₂', unit: 'm/s', value: q.v2,
        probe: { kind: 'velocity', body: 'star2', mode: 'mag', window: w, reduce: 'last', tolerance: 0.02 } },
      { label: '总动量（质心静止，应为 0）', unit: 'kg·m/s', value: 0,
        probe: { kind: 'stat', key: 'momentumX', at: 'last', absTolerance: 1e-6 } },
      { label: '机械能 E = −Gm₁m₂/(2r)', unit: 'J', value: q.E,
        probe: { kind: 'stat', key: 'mechanical', at: 'last', tolerance: 0.02 } },
      { label: '公转周期 T = 2π√(r³/(G(m₁+m₂)))', unit: 's', value: q.T,
        probe: { kind: 'period', body: 'star1', project: [0, 1], center: 0, tolerance: 0.03 } }
    ];
    return items;
  };

  function register(add) {
    add({
      id: 'binaryStar', title: '双星系统（万有引力）', group: '万有引力',
      params: [
        { key: 'mass1', label: '星1 质量 m₁', unit: 'kg', min: 1, max: 10, step: 0.5, value: 4 },
        { key: 'mass2', label: '星2 质量 m₂', unit: 'kg', min: 1, max: 10, step: 0.5, value: 2 },
        { key: 'r', label: '两星间距 r', unit: 'm', min: 2, max: 12, step: 0.5, value: 4 },
        { key: 'G', label: '引力常量 G', unit: 'N·m²/kg²', min: 0.5, max: 3, step: 0.1, value: 1 },
        { key: 'duration', label: '演示时长', unit: 's', min: 2, max: 30, step: 1, value: 0 }
      ],
      build: binary, expect: binary.expect
    });
  }

  return { register: register };
});
