/*!
 * MrAwU（阿物先生）— 电磁学模型组
 *
 * 静电场（点电荷系）：电荷静止，没有动力学，属于"场可视化"类模型。
 * 因此这个模型的重点不是时间演化，而是：
 *   · 电场线（每根线从正电荷出发、终止于负电荷或边界）
 *   · 等势线（对 V 做 marching squares）
 *   · 场点的场强矢量（网格箭矢）
 * 三者可任意组合，且电场线 ⊥ 等势线本身就是可视化的正确性判据。
 *
 * 电荷既可以由"题目约束"预设导入（等边三角形、正方形、直线排列、偶极子…），
 * 也可以在画布上手动添加/拖动（由播放器负责交互，电荷列表通过 extra.charges 传进来）。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.PFA = root.PFA || {};
    root.PFA.models_electric = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var K = 9e9;   // 静电力常量（配合 μC 时 E 的量级是 kV/m）

  /**
   * 题目约束预设：把常见题图的排布直接变成坐标。
   * 单位：米；电量单位：μC。
   */
  var PRESETS = {
    single: {
      label: '单个正电荷',
      charges: [{ x: 0, y: 0, q: 2 }]
    },
    dipole: {
      label: '等量异种电荷（偶极子）',
      charges: [{ x: -1.2, y: 0, q: 2 }, { x: 1.2, y: 0, q: -2 }]
    },
    same: {
      label: '等量同种电荷',
      charges: [{ x: -1.2, y: 0, q: 2 }, { x: 1.2, y: 0, q: 2 }]
    },
    unequal: {
      label: '不等量异种（+2q : −q）',
      charges: [{ x: -1.2, y: 0, q: 4 }, { x: 1.2, y: 0, q: -2 }]
    },
    triangle: {
      label: '等边三角形（三个等量正电荷）',
      charges: (function () {
        var R = 1.6, out = [];
        for (var i = 0; i < 3; i++) {
          var a = Math.PI / 2 + i * 2 * Math.PI / 3;
          out.push({ x: R * Math.cos(a), y: R * Math.sin(a), q: 2 });
        }
        return out;
      })()
    },
    triangleMix: {
      label: '等边三角形（两正一负）',
      charges: (function () {
        var R = 1.6, q = [2, 2, -2], out = [];
        for (var i = 0; i < 3; i++) {
          var a = Math.PI / 2 + i * 2 * Math.PI / 3;
          out.push({ x: R * Math.cos(a), y: R * Math.sin(a), q: q[i] });
        }
        return out;
      })()
    },
    square: {
      label: '正方形（两正两负，四角）',
      charges: (function () {
        var R = 1.5, out = [];
        for (var i = 0; i < 4; i++) {
          var a = Math.PI / 4 + i * Math.PI / 2;
          out.push({ x: R * Math.cos(a), y: R * Math.sin(a), q: i % 2 ? -2 : 2 });
        }
        return out;
      })()
    },
    line: {
      label: '直线等距排列（+ − +）',
      charges: [{ x: -2, y: 0, q: 2 }, { x: 0, y: 0, q: -2 }, { x: 2, y: 0, q: 2 }]
    },
    quadrupole: {
      label: '四极子（+− 上下对称）',
      charges: [
        { x: -1.2, y: -1.2, q: 2 }, { x: 1.2, y: -1.2, q: -2 },
        { x: -1.2, y: 1.2, q: -2 }, { x: 1.2, y: 1.2, q: 2 }
      ]
    }
  };

  function clampCharges(list) {
    var out = [];
    (list || []).slice(0, 10).forEach(function (c) {
      out.push({
        x: Math.max(-40, Math.min(40, Number(c.x) || 0)),
        y: Math.max(-40, Math.min(40, Number(c.y) || 0)),
        q: Math.max(-20, Math.min(20, Number(c.q) || 0))
      });
    });
    return out;
  }

  /**
   * 场景构建：
   *   extra.charges 优先（手动编辑后的电荷列表）；
   *   否则用参数里的预设。
   * 电荷作为**静态刚体**放进场景，这样它会被常规渲染器画出来（也便于框选/缩放），
   * 而场线/等势线/场强矢量由 lib/field.js 单独绘制。
   */
  function efield(p, extra) {
    var preset = PRESETS[p.preset] ? p.preset : 'dipole';
    var charges = clampCharges(extra && extra.charges ? extra.charges : PRESETS[preset].charges);
    if (!charges.length) charges = PRESETS[preset].charges.slice();
    // 缩放：把预设的米制尺寸乘上比例参数（题目尺度可调）
    var s = p.scale || 1;
    charges = charges.map(function (c) { return { x: c.x * s, y: c.y * s, q: c.q }; });
    // 场点：只用来读该处的场强，不产生场
    var probes = (extra && extra.probes ? extra.probes : []).slice(0, 10).map(function (pt) {
      return { x: Math.max(-60, Math.min(60, Number(pt.x) || 0)),
               y: Math.max(-60, Math.min(60, Number(pt.y) || 0)) };
    });

    var bodies = charges.map(function (c, i) {
      return {
        id: 'q' + (i + 1), type: 'static',
        shape: { kind: 'circle', r: 0.001 },              // 真实图案由 field.js 按像素画，这里只占位
        at: [c.x, c.y], label: (c.q > 0 ? '+' : '') + c.q + 'μC',
        color: c.q > 0 ? '#ff5d5d' : '#4da3ff', showForces: false,
        overlay: true                                      // 交给 field.js 画（带 +/− 号）
      };
    });

    return {
      title: '静电场（点电荷系）',
      subtitle: 'E = Σ kqᵢr̂ᵢ/rᵢ²：电场线从正电荷出发、终止于负电荷，等势线处处与电场线垂直',
      tags: ['静电场', '点电荷', '电场线', '等势线', '叠加原理'],
      meta: { g: 0, duration: 1 / 60, dt: 1 / 60, subSteps: 1, frames: 1 },
      view: { height: 620, grid: true },
      bodies: bodies,
      joints: [], forces: [],
      noGraph: true,            // 静电场与时间无关，隐藏 x-t / v-t 图
      verletOnly: true,         // 无动力学；planck 侧没有"点电荷场"这种力
      field: {
        charges: charges,
        probes: probes,
        k: K,
        preset: preset,
        presetLabel: PRESETS[preset].label
      },
      laws: { force: function () { return {}; } },   // 无受力（电荷静止）
      notes: '静电力常量 k = 9×10⁹ N·m²/C²，电量单位 μC。' +
        '单个点电荷：E = kq/r²、V = kq/r；多个电荷按矢量叠加。' +
        '在设置里可以新增正电荷 / 负电荷 / 场点：选中后能直接改电量，' +
        '场点会按"力的表示方式"画出该处的场强大小与方向。'
    };
  }

  /**
   * 对照项：这些是"场"的量，直接从电荷分布解析算出，
   * 再用 kind:'fieldAt' 探针在同一个点上重新算一遍（两条独立路径），
   * 用来验证叠加原理与场强公式没有写错。
   */
  efield.expect = function (p) {
    var sc = efield(p, null);
    var ch = sc.field.charges, k = sc.field.k;
    var items = [];

    // 1) 在若干"题目里常问"的位置核对场强
    var pts = [];
    if (ch.length === 1) {
      pts.push({ at: [ch[0].x + 1, ch[0].y], label: '距电荷 1 m 处的场强 E = kq/r²' });
    } else if (ch.length === 2) {
      pts.push({ at: [(ch[0].x + ch[1].x) / 2, (ch[0].y + ch[1].y) / 2],
                 label: '两电荷连线中点的场强（叠加）' });
      pts.push({ at: [ch[0].x, ch[0].y + 1.5], label: '电荷1 上方 1.5 m 处的场强' });
    } else {
      // 对称排布（三角形/正方形）：几何中心处场强应为 0
      var cx = 0, cy = 0;
      ch.forEach(function (c) { cx += c.x; cy += c.y; });
      cx /= ch.length; cy /= ch.length;
      pts.push({ at: [cx, cy], label: '对称中心处的场强（正负电荷对称时应为 0）' });
      pts.push({ at: [ch[0].x + 1.2, ch[0].y], label: '电荷1 右侧 1.2 m 处的场强' });
    }

    var ana = require_fieldMath();
    pts.forEach(function (pt) {
      var f = ana.fieldAt(ch, pt.at[0], pt.at[1], k);
      items.push({
        label: pt.label, unit: 'N/C', value: f.mag,
        probe: { kind: 'fieldAt', at: pt.at, mode: 'mag', tolerance: 1e-6,
                 absTolerance: Math.max(1e-6, f.mag * 1e-6) }
      });
    });

    // 2) 电势：叠加原理
    if (ch.length >= 2) {
      var mid = { x: (ch[0].x + ch[1].x) / 2, y: (ch[0].y + ch[1].y) / 2 };
      var v = ana.potentialAt(ch, mid.x, mid.y, k);
      items.push({
        label: '两电荷连线中点的电势 V = Σ kqᵢ/rᵢ', unit: 'V', value: v,
        probe: { kind: 'fieldAt', at: [mid.x, mid.y], part: 'V', tolerance: 1e-6,
                 absTolerance: Math.max(1e-6, Math.abs(v) * 1e-6) }
      });
    }

    // 3) 电荷个数（保证手动编辑后仍能被核对）
    items.push({
      label: '电荷个数（题目约束或手动添加）', unit: '个', value: ch.length,
      probe: { kind: 'chargeCount', tolerance: 0 }
    });
    return items;
  };

  /** 与 lib/field.js 相同的公式（独立实现，用于交叉验证） */
  function require_fieldMath() {
    function fieldAt(charges, x, y, k) {
      var ex = 0, ey = 0;
      charges.forEach(function (c) {
        var dx = x - c.x, dy = y - c.y;
        var r2 = dx * dx + dy * dy;
        if (r2 < 1e-12) return;
        var r = Math.sqrt(r2);
        var f = k * c.q / (r2 * r);
        ex += f * dx; ey += f * dy;
      });
      return { ex: ex, ey: ey, mag: Math.hypot(ex, ey) };
    }
    function potentialAt(charges, x, y, k) {
      var v = 0;
      charges.forEach(function (c) {
        var r = Math.hypot(x - c.x, y - c.y);
        if (r < 1e-9) return;
        v += k * c.q / r;
      });
      return v;
    }
    return { fieldAt: fieldAt, potentialAt: potentialAt };
  }

  // ============================================================ 匀强电场（有动力学）
  //
  // 与上面"静电场可视化"不同，这里是**带电粒子在匀强电场中运动**：
  // 场由平行板产生，粒子受恒力 F = qE = qU/d，是标准的匀变速问题。
  // 因为力是恒力，速度-Verlet 对它**精确**（恒加速度下二阶积分无误差），
  // 所以这类模型的对照项能做到 0.000%。

  /** 极板对的公共几何：d 为板间距，L 为板长，U 为电压（E = U/d） */
  function platePair(p, opt) {
    var o = opt || {};
    return {
      E: p.U / p.d,                       // 场强大小 V/m
      a: (p.q * 1e-6) * (p.U / p.d) / (p.mass * 1e-3),   // 加速度 m/s²（q 用 μC、m 用 g）
      q: p.q * 1e-6, m: p.mass * 1e-3
    };
  }

  /**
   * 加速电场：粒子沿场方向被加速（两块垂直于运动方向的极板）。
   *   a = qU/(md)，v² = v₀² + 2qU/m，t = (v − v₀)/a，动能增量 = qU
   * 电场只存在于两板之间（0 ≤ x ≤ d），所以力是分段的，用 nextEvent 精确停在出板时刻。
   */
  function accelLaws(p) {
    var m = p.mass * 1e-3, q = p.q * 1e-6, E = p.U / p.d, d = p.d, g = 0;   // 重力按题设忽略
    var a = q * E / m;
    var vEnd = Math.sqrt(Math.max(0, p.v0 * p.v0 + 2 * a * d));
    var tEnd = a > 1e-12 ? (vEnd - p.v0) / a : 0;
    function force(t, S) {
      // 区域判据用**时间**而不是位置：位置判据会被浮点噪声坑到——
      // 事件把子步切在 x = d 上，但此时 x 实际是 d − 1e-16，`x < d` 仍为真，
      // 于是出界那一子步的 F1 又加了半个子步的力（实测末速度多 0.00088 m/s）。
      // 用中点时刻与出界时刻比较则完全稳健，且与 nextEvent 的分割严格一致。
      var inside = t < tEnd;
      var F = inside ? q * E : 0;                  // 沿 +x 方向（由 + 板指向 − 板）
      return {
        ion: {
          parts: {
            gravity: [0, -m * g], gravitation: [0, 0],
            electric: [F, 0], normal: [0, 0], friction: [0, 0],
            applied: [0, 0], joint: [0, 0], damping: [0, 0]
          }
        }
      };
    }
    function nextEvent(t, S) {
      return S.ion.x < d - 1e-12 ? tEnd : null;    // 精确停在到达另一块板的时刻
    }
    // 电势能 U = −qEx（力沿 +x，所以 U 随 x 增大而减小）。
    // 关键：零场区里 U 必须**保持常量**——直接写 −qEx 会让"穿出孔之后"的电势能继续变化，
    // 机械能守恒就假性不成立（实测差 1.8e-4 J）。
    function potential(t, S) { return -q * E * Math.min(S.ion.x, d); }
    return { force: force, nextEvent: nextEvent, potential: potential, a: a, vEnd: vEnd, tEnd: tEnd };
  }

  function efieldAccel(p) {
    var L = accelLaws(p);
    // 演示时长留出一段「穿出孔后匀速」的尾巴：末速度在零场区里测量最干净
    var dur = Math.max(0.05, L.tEnd * 1.3);
    var q = p.q * 1e-6, m = p.mass * 1e-3;
    var U = p.U;
    return {
      title: '加速电场（平行板）',
      subtitle: '带电粒子沿场方向被加速：a = qU/(md)，v² = v₀² + 2qU/m，动能增量 = qU',
      tags: ['匀强电场', '加速', '动能定理', '平行板'],
      meta: { g: 0, duration: dur, dt: 1 / 60, subSteps: 8, energyRefY: 0 },
      view: { height: 560, grid: true },
      verletOnly: true,           // planck 侧没有电场力
      bodies: [
        { id: 'plateL', type: 'static', shape: { kind: 'box', w: 0.035, h: p.plateH },
          at: [-0.0175, 0], color: '#ff5d5d', sign: '+', label: '+ 极板' },
        { id: 'plateR', type: 'static', shape: { kind: 'box', w: 0.035, h: p.plateH },
          at: [p.d + 0.0175, 0], color: '#4da3ff', sign: '−', label: '− 极板' },
        { id: 'ion', type: 'dynamic', shape: { kind: 'circle', r: 0.035 },
          at: [0, 0], velocity: [p.v0, 0], mass: m,
          label: '带电粒子 q=' + p.q + 'μC', color: '#e8934a', showForces: true }
      ],
      joints: [], forces: [],
      // 匀强电场：两板之间画一排平行带箭头的场线（由 + 板指向 − 板）
      field: { uniform: { x0: 0, x1: p.d, y0: -p.plateH / 2, y1: p.plateH / 2, ex: 1, ey: 0 } },
      dimensions: [
        { a: 'plateL', anchorA: 'right', b: 'plateR', anchorB: 'left', axis: 'x',
          offset: -p.plateH * 0.62, label: '板间距 d' }
      ],
      markers: [{ t: dur, label: '到达极板',
        note: '末速度 v = √(v₀² + 2qU/m) = ' + L.vEnd.toFixed(3) + ' m/s；' +
          '动能增量 ΔEₖ = ½mv² − ½mv₀² = qU = ' + (q * U).toPrecision(4) + ' J（动能定理）。' }],
      notes: '解析：a = qE/m = qU/(md) = ' + L.a.toFixed(4) + ' m/s²；' +
        'v = √(v₀² + 2qU/m) = ' + L.vEnd.toFixed(3) + ' m/s；t = ' + L.tEnd.toFixed(4) + ' s；' +
        '电场力 F = qE = ' + (q * p.U / p.d).toPrecision(4) + ' N。' +
        '取 q = ' + p.q + ' μC、m = ' + p.mass + ' g、U = ' + p.U + ' V、d = ' + p.d + ' m。',
      laws: accelLaws(p)
    };
  }

  efieldAccel.expect = function (p) {
    var L = accelLaws(p);
    var q = p.q * 1e-6, m = p.mass * 1e-3, U = p.U;
    var w = [0.15 * L.tEnd, 0.85 * L.tEnd];
    return [
      { label: '加速度 a = qU/(md)', unit: 'm/s²', value: L.a,
        probe: { kind: 'accel', body: 'ion', project: [1, 0], signed: true, window: w, tolerance: 1e-6,
                 absTolerance: Math.max(1e-9, L.a * 1e-6) } },
      { label: '末速度 v = √(v₀² + 2qU/m)', unit: 'm/s', value: L.vEnd,
        // 在场区之后（零场区）测量：那里速度严格恒定，不受出界那一子步的混合影响
        probe: { kind: 'velocity', body: 'ion', project: [1, 0], signed: true, window: [L.tEnd * 1.12, L.tEnd * 1.3], reduce: 'last', tolerance: 1e-6, absTolerance: 1e-9 } },
      { label: '加速时间 t = (v − v₀)/a（受 1/60 s 采样限制）', unit: 's', value: L.tEnd,
        probe: { kind: 'eventTime', body: 'ion', at: p.d, axis: 'x', tolerance: 2e-3, absTolerance: 1e-9 } },
      { label: '动能增量 = qU（动能定理）', unit: 'J', value: q * U,
        probe: { kind: 'statDelta', key: 'kinetic', tolerance: 1e-6, absTolerance: Math.max(1e-12, q * U * 1e-6) } }
    ];
  };

  /**
   * 偏转电场：粒子以 v₀ 垂直进入场区，出场后做匀速直线运动打到荧光屏。
   *   a = qE/m，t₁ = L/v₀，y₁ = qEL²/(2mv₀²)，tanθ = qEL/(mv₀²)
   *   打到屏上的总偏移 Y = y₁ + v_y·D/v₀ = tanθ·(L/2 + D)
   *   最后这个等式就是教材里的"偏转后反向延长线过极板中点"——可以当作几何定理来核对。
   */
  function deflectLaws(p) {
    var m = p.mass * 1e-3, q = p.q * 1e-6, E = p.U / p.d, L = p.plateLen, D = p.screenDist, g = 0;  // 忽略重力
    var a = q * E / m;
    var t1 = L / p.v0;
    var y1 = 0.5 * a * t1 * t1;
    var vy = a * t1;
    var tan = vy / p.v0;
    var yScreen = y1 + vy * (D / p.v0);
    var t2 = D / p.v0;
    function force(t, S) {
      // 同样用时间判据（见加速电场里的说明）：与 nextEvent 的出板时刻严格一致
      var inside = t < t1;
      var Fy = inside ? -q * E : 0;                 // 场由上方 + 板指向下方 − 板（−y 方向）
      return {
        ion: {
          parts: {
            gravity: [0, -m * g], gravitation: [0, 0],
            electric: [0, Fy], normal: [0, 0], friction: [0, 0],
            applied: [0, 0], joint: [0, 0], damping: [0, 0]
          }
        }
      };
    }
    function nextEvent(t, S) {
      return S.ion.x < L - 1e-9 ? t1 : null;        // 精确停在出板时刻
    }
    // 电势能 U = +qEy；但场只存在于 0 ≤ x < L，所以出场后 U 取**出场点**的值并保持常量
    // （否则漂移段的 y 继续变、电势能也跟着变，机械能守恒就假性不成立）。
    function potential(t, S) { return q * E * (S.ion.x < L ? S.ion.y : -y1); }
    return { force: force, nextEvent: nextEvent, potential: potential,
             a: a, t1: t1, y1: y1, vy: vy, tan: tan, yScreen: yScreen, t2: t2,
             dur: t1 + t2 };
  }

  function efieldDeflect(p) {
    var q = p.q * 1e-6, m = p.mass * 1e-3;
    var L = deflectLaws(p);
    if (Math.abs(L.y1) > p.d / 2) {
      throw new Error('这组参数下粒子会打在极板上：出板偏移 y₁ = ' + L.y1.toFixed(4) +
        ' m 超过板间距的一半 d/2 = ' + (p.d / 2).toFixed(4) + ' m。请减小 U、增大 v₀ 或加大 d。');
    }
    var dur = L.dur * 1.02;
    var screenH = Math.max(0.24, Math.abs(L.yScreen) * 3.2);
    return {
      title: '偏转电场（示波管原理）',
      subtitle: '垂直进入场区：y₁ = qEL²/(2mv₀²)，出场后匀速直线，屏上总偏移 Y = tanθ·(L/2 + D)',
      tags: ['匀强电场', '偏转', '类平抛', '示波管'],
      meta: { g: 0, duration: dur, dt: 1 / 60, subSteps: 8, energyRefY: 0 },
      view: { height: 620, grid: true },
      verletOnly: true,           // planck 侧没有电场力
      bodies: [
        { id: 'plateTop', type: 'static', shape: { kind: 'box', w: p.plateLen, h: 0.02 },
          at: [p.plateLen / 2, p.d / 2 + 0.01], color: '#ff5d5d', sign: '+', label: '+ 极板' },
        { id: 'plateBot', type: 'static', shape: { kind: 'box', w: p.plateLen, h: 0.02 },
          at: [p.plateLen / 2, -p.d / 2 - 0.01], color: '#4da3ff', sign: '−', label: '− 极板' },
        { id: 'screen', type: 'static', shape: { kind: 'box', w: 0.02, h: screenH },
          at: [p.plateLen + p.screenDist, 0], color: '#8fa3c2', label: '荧光屏' },
        { id: 'ion', type: 'dynamic', shape: { kind: 'circle', r: 0.024 },
          at: [0, 0], velocity: [p.v0, 0], mass: m,
          label: '带电粒子 q=' + p.q + 'μC', color: '#e8934a', showForces: true }
      ],
      joints: [], forces: [],
      // 匀强电场（两板之间）：平行带箭头场线，方向由上板指向下板（−y）
      field: { uniform: { x0: 0, x1: p.plateLen, y0: -p.d / 2, y1: p.d / 2, ex: 0, ey: -1 } },
      dimensions: [
        { a: 'plateTop', anchorA: 'center', b: 'plateBot', anchorB: 'center', axis: 'y',
          offset: -p.plateLen * 0.12, label: '板间距 d' },
        { a: 'screen', anchorA: 'center', b: 'ion', anchorB: 'center', axis: 'y',
          offset: p.plateLen * 0.10, label: '屏上偏移 Y' }
      ],
      markers: [
        { t: L.t1, label: '出板',
          note: '出场偏移 y₁ = qEL²/(2mv₀²) = ' + L.y1.toFixed(4) + ' m，' +
            'tanθ = v_y/v₀ = ' + L.tan.toFixed(4) + '（θ = ' + (Math.atan(L.tan) * 180 / Math.PI).toFixed(2) + '°）。' },
        { t: dur, label: '打到荧光屏',
          note: '屏上总偏移 Y = y₁ + v_y·D/v₀ = ' + L.yScreen.toFixed(4) + ' m；' +
            '按几何关系 Y = tanθ·(L/2 + D) = ' + (L.tan * (p.plateLen / 2 + p.screenDist)).toFixed(4) +
            ' m —— 两者相等，就是"偏转后的反向延长线过极板中点"。' }
      ],
      notes: '解析：a = qE/m = qU/(md) = ' + L.a.toFixed(3) + ' m/s²；t₁ = L/v₀ = ' + L.t1.toFixed(4) + ' s；' +
        'y₁ = ' + L.y1.toFixed(4) + ' m；v_y = ' + L.vy.toFixed(4) + ' m/s；' +
        'Y = ' + L.yScreen.toFixed(4) + ' m。重力按题设忽略（g = 0）。',
      laws: deflectLaws(p)
    };
  }

  efieldDeflect.expect = function (p) {
    var L = deflectLaws(p);
    var wIn = [0.15 * L.t1, 0.85 * L.t1];              // 场区内
    var wOut = [L.t1 * 0.97, L.t1 * 1.03];             // 出板瞬间
    var wEnd = [0.96 * L.dur, 1.0 * L.dur];            // 打到屏
    return [
      { label: '场区内加速度 a = qE/m', unit: 'm/s²', value: -L.a,
        probe: { kind: 'accel', body: 'ion', project: [0, 1], signed: true, window: wIn, tolerance: 1e-6,
                 absTolerance: Math.max(1e-9, L.a * 1e-6) } },
      { label: '场区内飞行时间 t₁ = L/v₀（受 1/60 s 采样限制）', unit: 's', value: L.t1,
        probe: { kind: 'eventTime', body: 'ion', at: p.plateLen, axis: 'x', tolerance: 2e-3, absTolerance: 1e-9 } },
      { label: '出板偏移 y₁ = qEL²/(2mv₀²)', unit: 'm', value: -L.y1,
        probe: { kind: 'position', body: 'ion', project: [0, 1], signed: true, window: wOut, reduce: 'last', tolerance: 1e-6, absTolerance: 1e-6 } },
      { label: '出板时 v_y = at₁', unit: 'm/s', value: -L.vy,
        probe: { kind: 'velocity', body: 'ion', project: [0, 1], signed: true, window: wOut, reduce: 'last', tolerance: 1e-6, absTolerance: 1e-6 } },
      { label: '屏上总偏移 Y = y₁ + v_y·D/v₀', unit: 'm', value: -L.yScreen,
        probe: { kind: 'position', body: 'ion', project: [0, 1], signed: true, window: wEnd, reduce: 'last', tolerance: 1e-6, absTolerance: 1e-6 } },
      { label: '几何定理：Y = tanθ·(L/2 + D)', unit: 'm', value: -L.tan * (p.plateLen / 2 + p.screenDist),
        probe: { kind: 'position', body: 'ion', project: [0, 1], signed: true, window: wEnd, reduce: 'last', tolerance: 1e-6, absTolerance: 1e-6 } },
      { label: '能量守恒 ½mv² + qEy（初末相同）', unit: 'J', value: 0,
        probe: { kind: 'statDelta', key: 'mechanical', tolerance: 1e-6, absTolerance: 1e-9 } }
    ];
  };

  function register(add) {
    var presetOpts = Object.keys(PRESETS).map(function (kp) { return kp; });
    add({
      id: 'efield', title: '静电场（点电荷系·电场线与等势线）', group: '电磁学',
      params: [
        { key: 'preset', label: '题目约束排布', type: 'preset', options: presetOpts,
          labels: presetOpts.map(function (kp) { return PRESETS[kp].label; }), value: 'dipole' },
        { key: 'scale', label: '整体尺度', unit: '×', min: 0.4, max: 3, step: 0.1, value: 1 }
      ],
      build: efield, expect: efield.expect,
      presets: PRESETS
    });

    add({
      id: 'efieldAccel', title: '加速电场（平行板）', group: '电磁学',
      params: [
        { key: 'q', label: '电量 q', unit: 'μC', min: 0.5, max: 10, step: 0.5, value: 2 },
        { key: 'mass', label: '质量 m', unit: 'g', min: 0.5, max: 10, step: 0.5, value: 2 },
        { key: 'v0', label: '初速度 v₀', unit: 'm/s', min: 0, max: 4, step: 0.1, value: 0 },
        { key: 'U', label: '板间电压 U', unit: 'V', min: 50, max: 3000, step: 50, value: 800 },
        { key: 'd', label: '板间距 d', unit: 'm', min: 0.1, max: 1.2, step: 0.05, value: 0.4 },
        { key: 'plateH', label: '极板高度', unit: 'm', min: 0.2, max: 1.2, step: 0.05, value: 0.5 }
      ],
      build: efieldAccel, expect: efieldAccel.expect
    });

    add({
      id: 'efieldDeflect', title: '偏转电场（示波管原理）', group: '电磁学',
      params: [
        { key: 'q', label: '电量 q', unit: 'μC', min: 0.5, max: 10, step: 0.5, value: 2 },
        { key: 'mass', label: '质量 m', unit: 'g', min: 0.5, max: 10, step: 0.5, value: 2 },
        { key: 'v0', label: '入射速度 v₀', unit: 'm/s', min: 0.5, max: 6, step: 0.25, value: 2 },
        { key: 'U', label: '偏转电压 U', unit: 'V', min: 20, max: 600, step: 10, value: 150 },
        { key: 'd', label: '板间距 d', unit: 'm', min: 0.04, max: 0.4, step: 0.01, value: 0.1 },
        { key: 'plateLen', label: '板长 L', unit: 'm', min: 0.1, max: 1.2, step: 0.05, value: 0.4 },
        { key: 'screenDist', label: '板到屏距离 D', unit: 'm', min: 0.1, max: 1.5, step: 0.05, value: 0.4 }
      ],
      build: efieldDeflect, expect: efieldDeflect.expect
    });
  }

  return { register: register, PRESETS: PRESETS, efield: efield };
});
 