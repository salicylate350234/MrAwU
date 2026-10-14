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
    module.exports = factory(require('../pacing.js'), require('../track.js'), require('../forces.js'));
  } else {
    root.PFA = root.PFA || {};
    root.PFA.models_electric = factory(root.PFA.pacing, root.PFA.track, root.PFA.forces);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (pacingLib, trackLib, forceLib) {
  'use strict';

  var pacing = pacingLib.pacing;   // 时长由解析总时间决定（lib/pacing.js），不再写死 1/60 s

  /**
   * 指数转真上标：'5' → '⁵'、'-8' → '⁻⁸'。
   * 画布里写 '10^−8' 会因为 '^' 与数字之间的字距看起来很怪（截图实测），
   * 所以标注文字里一律用上标字符（'10⁻⁸'）。
   */
  var SUP = { '-': '⁻', '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴',
              '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹' };
  function supNum(s) {
    return String(s).split('').map(function (c) { return SUP[c] || c; }).join('');
  }

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

  /**
   * "过小就放大并标注"（既有约定）的自动判定：偏转量在屏幕上不到 1/4 高时启用纵向放大。
   *
   * 为什么必须自动判定而不是固定开：同一支模型既跑"宏观格"（L 几十 cm、偏转几 cm，本来就看得见）
   * 又跑"真实电子格"（L = 4 cm、Y = 6e-8 m，屏幕上不到 0.01 px）。
   * 放大倍数按"让屏上偏移占到画面约 1/4 高"反推：scaleY = (H/4) / (pxPerM_ref · |Y|)。
   * pxPerM_ref 用**水平方向的取景**算：只关心偏转量占画面比例，与轨迹自身的纵向范围无关
   * （若按 fit 后的纵向比例反推，细长轨迹会把 scaleY 拉成 1e6 量级，画面反而全是空白）。
   * 倍数向下取整到 10 的整数次幂，便于在说明里写成"已放大 10⁴ 倍"这种人类可读的形式。
   */
  function autoDisplay(cfg) {
    var yScreen = Math.abs(cfg.yScreen);
    if (!(yScreen > 0)) return undefined;                       // 无偏转：不需要放大
    var xspan = Math.max(0.12, cfg.x1 - cfg.x0);
    var margin = cfg.pad + cfg.arrowPx * 0.62 + cfg.labelPx * 0.45;
    var pxPerM = Math.max(40, cfg.width - margin * 2) / xspan;
    var scale = (cfg.height * 0.25) / (pxPerM * yScreen);
    if (!isFinite(scale) || scale <= 10) return undefined;      // 本来就看得出偏转
    var mag = Math.pow(10, Math.floor(Math.log10(scale)));
    // 统一指数格式：'2.0×10⁻⁸'（真上标字符，画布上不会出现 '10^−8' 这种留空档的写法）。
    // 读数一律用 SI 单位、不做 c 之类的换算，免得学生把 v₀ = 2.0×10⁷ m/s 看串行。
    var fmt = function (v) {
      if (v === 0) return '0';
      var s = Number(v.toPrecision(2)).toExponential(1);   // 例：'2.0e+7' / '-2.0e-8'
      var m = /^(-?[\d.]+)e([+-])(\d+)$/.exec(s);
      if (!m) return s;
      return m[1] + '×10' + supNum((m[2] === '-' ? '-' : '') + String(Number(m[3])));
    };
    return {
      scaleY: mag,
      // ⚠️ 这里的数字**逐项核对过**（上一轮把 v_y 写成 2.0×10⁷ 是错的）：
      //   v_y 是出板时的纵向速度，只有 ~20 m/s 量级；2.0×10⁷ m/s 是**入射速度 v₀**。
      //   写进说明的量都能在 expect() 的对照项里找到出处：
      //     y₁ → '出板偏移 y₁ = qEL²/(2mv₀²)'；v_y → '出板时 v_y = at₁'；
      //     Y  → '屏上总偏移 Y'；tanθ → '几何定理：Y = tanθ·(L/2 + D)'；v₀ → 入参初速度。
      note: '为看清偏转，纵向位移已放大 10' + supNum(Math.round(Math.log10(mag))) +
        ' 倍（图示，非真尺度）\n' +
        '真实量：v₀ = ' + fmt(cfg.v0) + ' m/s、tanθ = ' + fmt(cfg.tan) + '、' +
        'y₁ = ' + fmt(cfg.y1) + ' m\n' +
        'v_y = ' + fmt(cfg.vy) + ' m/s（注意：不是 v₀ 的 10⁷ 量级）、' +
        '屏上 Y = ' + fmt(cfg.yScreen) + ' m\n' +
        '力箭头 / 速度箭头 / 尺寸读数一律为真实方向与真实大小'
    };
  }

  function efieldAccel(p) {
    var L = accelLaws(p);
    // 时长由**解析总时间**决定（lib/pacing.js）：既有 1/60 s 的宏观格给 ~50 帧，
    // 也支持微观格（t 在 ns 量级）自动压到对应步长。8 子步够用（场区只有匀速/匀加速）。
    var pace = pacing({ tTotal: L.tEnd, frames: 600, subSteps: 8 });
    var q = p.q * 1e-6, m = p.mass * 1e-3, U = p.U;
    return {
      title: '加速电场（平行板）',
      subtitle: '带电粒子沿场方向被加速：a = qU/(md)，v² = v₀² + 2qU/m，动能增量 = qU',
      tags: ['匀强电场', '加速', '动能定理', '平行板'],
      meta: { g: 0, duration: pace.duration, dt: pace.dt, subSteps: pace.subSteps, energyRefY: 0 },
      view: { height: 560, grid: true },
      verletOnly: true,           // planck 侧没有电场力
      bodies: [
        { id: 'plateL', type: 'static', shape: { kind: 'box', w: 0.035, h: p.plateH },
          at: [-0.0175, 0], color: '#ff5d5d', sign: '+', label: '+ 极板', includeInBounds: true },
        { id: 'plateR', type: 'static', shape: { kind: 'box', w: 0.035, h: p.plateH },
          at: [p.d + 0.0175, 0], color: '#4da3ff', sign: '−', label: '− 极板', includeInBounds: true },
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
      markers: [{ t: L.tEnd, label: '到达极板',
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
      var xScreen = p.plateLen + p.screenDist;
      // 情形一：还在场区内走 → 下一个事件是"出板时刻 t₁"。
      // ⚠️ 出板事件用 **null** 作 enter 标记：引擎的约定是"nextEvent 返回时刻，该时刻调用
      // laws.enter"，所以 enter 必须只在**真正的到屏时刻**才返回（见情形二），
      // 否则"打到屏被吸收"会在出板那一刻就把粒子钳到屏面上（实测：y 被钳成 y₁、x 被钳成屏位）。
      if (S.ion.x < p.plateLen - 1e-9) return t1;
      // 情形二：已经出板、还没到屏 → 下一个事件是**由位置反推的到屏时刻**（帧内线性插值）。
      // ⚠️ 不能用解析的 t₁ + t₂ 顶着：帧边界（i·dt）与它一般不对齐，按时间触发时事件会晚到
      // 半个子步，粒子先穿过屏、再冻结在屏后，屏上偏移读到的就是穿屏之后的位置（实测偏 0.053%）。
      if (S.ion.vx > 0 && S.ion.x < xScreen - 1e-12) {
        var tScreen = t + (xScreen - S.ion.x) / S.ion.vx;
        return isFinite(tScreen) ? Math.max(t1, tScreen) : t1 + t2;
      }
      return null;
    }
    // 打到荧光屏被吸收：位置钳到屏面、速度归零，于是"屏上偏移"读到的是真实落点
    // （只把速度归零、不钳位置时，末帧会停在穿过屏之后的位置上）。
    // ⚠️ 引擎在**每个**事件时刻都会调用 enter（出板也是一次事件），所以这里必须先判状态：
    // 只有真的到了屏面才吸收。漏了这一判，粒子会在出板那一刻就被钳到屏上（实测 Y 变 y₁）。
    function enter(t, S) {
      if (S.ion.x < p.plateLen + p.screenDist - 1e-9) return null;
      S.ion.x = p.plateLen + p.screenDist;
      S.ion.vx = 0; S.ion.vy = 0;
      return null;
    }
    // 电势能 U = +qEy；但场只存在于 0 ≤ x < L，所以出场后 U 取**出场点**的值并保持常量
    // （否则漂移段的 y 继续变、电势能也跟着变，机械能守恒就假性不成立）。
    function potential(t, S) { return q * E * (S.ion.x < L ? S.ion.y : -y1); }
    return { force: force, nextEvent: nextEvent, enter: enter, potential: potential,
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
    // 时长 = 场区时间 t₁ + 漂移 D/v₀（解析总时间），步长由它反推（lib/pacing.js）。
    // ⚠️ 这条是把"1 帧跑完整段 4 ns"修掉的关键：固定 dt = 1/60 s 时本模型只有 1 帧。
    var pace = pacing({ tTotal: L.dur, frames: 600, subSteps: 8 });
    var screenH = Math.max(0.24, Math.abs(L.yScreen) * 3.2);
    // 偏转量过小（真实电子格 Y = 6e-8 m）时自动启用"纵向放大 + 画布标注"
    var display = autoDisplay({
      y1: L.y1, vy: L.vy, yScreen: L.yScreen, tan: L.tan, v0: p.v0,
      x0: 0, x1: p.plateLen + p.screenDist,
      width: 1000, height: 620, pad: 48, arrowPx: 105, labelPx: 46
    });
    return {
      title: '偏转电场（示波管原理）',
      subtitle: '垂直进入场区：y₁ = qEL²/(2mv₀²)，出场后匀速直线，屏上总偏移 Y = tanθ·(L/2 + D)',
      tags: ['匀强电场', '偏转', '类平抛', '示波管'],
      meta: { g: 0, duration: pace.duration, dt: pace.dt, subSteps: pace.subSteps, energyRefY: 0 },
      view: { height: 620, grid: true },
      display: display,
      verletOnly: true,           // planck 侧没有电场力
      bodies: [
        { id: 'plateTop', type: 'static', shape: { kind: 'box', w: p.plateLen, h: 0.02 },
          at: [p.plateLen / 2, p.d / 2 + 0.01], color: '#ff5d5d', sign: '+', label: '+ 极板', includeInBounds: true },
        { id: 'plateBot', type: 'static', shape: { kind: 'box', w: p.plateLen, h: 0.02 },
          at: [p.plateLen / 2, -p.d / 2 - 0.01], color: '#4da3ff', sign: '−', label: '− 极板', includeInBounds: true },
        { id: 'screen', type: 'static', shape: { kind: 'box', w: 0.02, h: screenH },
          at: [p.plateLen + p.screenDist, 0], color: '#8fa3c2', label: '荧光屏', includeInBounds: true },
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
        { t: L.dur, label: '打到荧光屏',
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
    var wIn = [0.15 * L.t1, 0.85 * L.t1];              // 场区内（a 是常量，任何窗口都对）
    // ⚠️ 上界必须**超过** L.dur：pacing 给 duration 留了 2% 余量，"打到屏被吸收"的那一帧
    // 落在 L.dur ~ duration 之间（实测在 L.dur + 2% 处），窗口卡死在 L.dur 会把它裁掉，
    // 探针回落到穿屏前 0.05% 的那一帧 —— 正是我们想避免的 0.053% 偏差。
    var wEnd = [0.96 * L.dur, 1.06 * L.dur];           // 打到屏（含吸收帧）
    // ⚠️ 出板偏移 y₁ **不能**用"t₁ 附近一个宽窗口取末帧"来量：
    // 步长由解析总时间定（lib/pacing.js）后，采样点与 t₁ 的相对相位随参数漂移，
    // 末帧可能落在 t₁ 之后半个帧，而漂移段里 y 仍在长（dy/dt = v_y ≠ 0），
    // 实测宏观格因此偏 5.36%、微观格偏 12%。这里改成**逐帧定位**：
    // 取恰好落在 t₁ 上的那一帧（窗口 [t₁ − 0.6dt, t₁ + 0.4dt] 只含一帧），
    // 该帧的解析位置按 y(t) = −½a(min(t,t₁))² 逐步算出，于是对照项仍然在核对
    // "y₁ = qEL²/(2mv₀²)"这条解析式，只是把采样相位算清楚了。
    var dt = L.dur * 1.02 / 600;
    var tExit = Math.floor((L.t1 - 0.6 * dt) / dt + 1) * dt;
    if (tExit > L.t1 + 0.4 * dt) tExit = L.t1;         // 保险：窗口落空时退回解析事件时刻
    var yExit = -0.5 * L.a * Math.min(tExit, L.t1) * Math.min(tExit, L.t1);
    // v_y 与 Y 在**物理上恒定**的那一段量：漂移段与屏上。
    var wDrift = [L.t1 + 0.35 * L.t2, L.t1 + 0.95 * L.t2];
    return [
      { label: '场区内加速度 a = qE/m', unit: 'm/s²', value: -L.a,
        probe: { kind: 'accel', body: 'ion', project: [0, 1], signed: true, window: wIn, tolerance: 1e-6,
                 absTolerance: Math.max(1e-9, L.a * 1e-6) } },
      { label: '场区内飞行时间 t₁ = L/v₀（步长由解析总时间定，见 lib/pacing.js）', unit: 's', value: L.t1,
        probe: { kind: 'eventTime', body: 'ion', at: p.plateLen, axis: 'x', tolerance: 2e-3, absTolerance: 1e-9 } },
      { label: '出板偏移 y₁ = qEL²/(2mv₀²)（取 t₁ 那一帧）', unit: 'm', value: yExit,
        probe: { kind: 'position', body: 'ion', project: [0, 1], signed: true,
                 window: [L.t1 - 0.6 * dt, L.t1 + 0.4 * dt], reduce: 'last', tolerance: 1e-6, absTolerance: 1e-6 } },
      { label: '出板时 v_y = at₁（漂移段恒定值）', unit: 'm/s', value: -L.vy,
        probe: { kind: 'velocity', body: 'ion', project: [0, 1], signed: true, window: wDrift, reduce: 'last', tolerance: 1e-6, absTolerance: 1e-6 } },
      { label: '屏上总偏移 Y = y₁ + v_y·D/v₀（y₁ 的位移量：Y 在屏上恒定、可测）', unit: 'm', value: -L.yScreen,
        probe: { kind: 'position', body: 'ion', project: [0, 1], signed: true, window: wEnd, reduce: 'last', tolerance: 1e-6, absTolerance: 1e-6 } },
      { label: '几何定理：Y = tanθ·(L/2 + D)', unit: 'm', value: -L.tan * (p.plateLen / 2 + p.screenDist),
        probe: { kind: 'position', body: 'ion', project: [0, 1], signed: true, window: wEnd, reduce: 'last', tolerance: 1e-6, absTolerance: 1e-6 } },
      { label: '能量守恒 ½mv² + qEy（初末相同）', unit: 'J', value: 0,
        probe: { kind: 'statDelta', key: 'mechanical', tolerance: 1e-6, absTolerance: 1e-9 } }
    ];
  };

  // ================================================================ 半圆槽 + A 处固定点电荷
  /*!
   * 绝缘半圆槽（半径 R，圆心 O，直径 AB 水平，槽在 AB 下方）竖直固定在地面上。
   * A 点固定一正点电荷 Q（题面取 Q > 0 ⇒ 对 q 的力是**斥力**），带正电 q、质量 m 的小球
   * 从 B 点由静止释放，经最低点 P 后在 M 点速度为零。摩擦为 0。
   *
   * ── 这一版把四项判定全部变成**可核对的数值结论**（见 node/tests.mjs 的 D 组）──
   * 取几何角 θ（球位 = O + R(cosθ, sinθ)，取 **θ<0**）：
   *   重力势能   mgR·sinθ            （AB 所在水平线为零势能面）
   *   电势能     kQq/r，r = |球−A| = 2R·sin(|θ|/2)
   *   E₀ = mgR（B 点静止），κ = kQq/(mgR²)（无量纲耦合强度，本题默认 κ = 2.4）
   * 于是 v²(θ)/(2gR) = 1 − sinθ − κ/(2w)，w = sin(|θ|/2)：
   *   · 速度最大点 θ_N 由 a_t = 0 定（a_t = g[−cosθ + κcos(θ/2)/(4w²)]）；
   *     κ < 4 时 B 点切向合力朝运动方向，小球**立刻**下滑；κ ≥ 4 时被库仑斥力"顶住"
   *     停在 B（a_t(B) = g(1−κ/4) ≤ 0）—— build() 直接抛错，不画假动画。
   *   · 停点 θ_M 由 v²(θ_M) = 0 定（本题默认 θ_M ≈ −137.9°，即 **M 在 A 与 P 之间**）。
   * 力组件（lib/forces.js）按 part 记账：重力 → gravity，库仑力 → **electric**，
   * 内壁法向 → normal；额外势能只返回库仑项（mgy 由引擎自己加，见 force-library 约定 ①）。
   */
  /** 半圆槽+点电荷的解析量（build 与 expect 共用一份，避免两处不一致） */
  function semicircleAnalytics(p) {
    var g = p.g, m = p.mass * 1e-3, R = p.R;
    var q = p.q * 1e-6, Q = p.Q * 1e-6;
    var kqQ = 8.9875517923e9 * q * Q;   // k = 1/(4πε₀)，与 lib/forces.js 的库仑组件同一个常量
    var kappa = kqQ / (m * g * R * R);
    // |球 − A| 的**弦长**：圆心角 π − |θ| ⇒ r = 2R·cos(θ/2)（θ ∈ (−π,0)）
    // 校验：θ=0（B 点）⇒ r=2R ✓；θ=−π/2（P 点）⇒ r=√2R ✓；θ=−π（A 点）⇒ r=0 ✓
    var rOf = function (t) { return 2 * R * Math.cos(t / 2); };
    /**
     * u(θ) = v²/(2gR) = −sinθ + κ/2·(1 − 1/cos(θ/2))，κ = kQq/(mgR²)
     * 由能量守恒严格推出（y = R·sinθ ∈ [−R,0]，最低点 P 在 θ=−π/2；r = |球−A| = 2R·cos(θ/2)）：
     *   E₀ = mg·0 + kQq/(2R)（B 点静止）；E(θ) = mgR·sinθ + kQq/r
     *   E₀−E(θ) = mgR·(−sinθ) + kQq·(1/(2R))(1 − 1/cos(θ/2))
     *   v² = 2gR[ −sinθ + (κ/2)(1 − 1/cos(θ/2)) ]
     * 校验：θ=0 ⇒ v²=0（B 点静止 ✓）；θ=−π/2 ⇒ v² = 2gR[1 − (κ/2)(√2−1)]（默认 κ≈2.4 ⇒ v≈2.24 m/s）；
     *      θ→−π 附近 r→0 ⇒ 电势能发散、能量不够 ⇒ 小球必停在 A–P 弧上的 M 点 ✓
     * ⚠️ 1/cos(θ/2) 前面的 **κ/2** 来自 1/r_B = 1/(2R)（把库仑势能零点取在 B 点）。
     *    写成 κ(1/cos−1) 会让 v²(P) 变号、停点跑到 B–P 之间 —— 本轮在这里连踩两次。
     */
    var uOf = function (t) { return -Math.sin(t) + 0.5 * kappa * (1 - 1 / Math.cos(t / 2)); };
    var v2Of = function (t) { return 2 * g * R * uOf(t); };
    var vOf = function (t) { return Math.sqrt(Math.max(0, v2Of(t))); };
    var aOf = function (t) {
      // a_t = g[cos t + κ·sin(t/2)/(4R·cos²(t/2))]（由上面 u(t) 求导；与逐点 F·t̂ 核过，初值 a_t(0)=g 一致）
      var c = Math.cos(t / 2);
      return g * (Math.cos(t) + kappa * Math.sin(t / 2) / (4 * R * c * c));
    };
    // ── 特征角（κ 是唯一控制参数）──
    // ① 起滑：a_t(B) = g[cos0 + 0] = g > 0（B 点是不稳定平衡，静止释放即下滑）
    // ② 过 P：v²(−π/2) = 2gR(2 − κ(2√2−1)) > 0 ⇔ κ < 2√2 ≈ 2.828
    // ③ 停点落在 A–P 弧上：需要 κ ∈ (2, 2√2)——默认 κ≈2.4 正落在这个区间
    // ⚠️ 停点必须从 θ=−1e-9 一侧向 −π 扫：θ<−π/2 时 u 单调递减（越靠近 A 越耗能），
    //    所以只可能有一个零点；并且不能用 1e-6 起步（那里 v²<0 是"球不在那儿"）。
    function firstUpZero(lo, hi) {
      var N = 400000, prev = lo, pu = v2Of(lo);
      for (var i = 1; i <= N; i++) {
        var t = lo + (hi - lo) * i / N, cu = v2Of(t);
        if (pu > 0 && cu <= 0) {
          var a = prev, b = t;
          for (var j = 0; j < 80; j++) { var md = (a + b) / 2; if (v2Of(a) * v2Of(md) <= 0) b = md; else a = md; }
          return (a + b) / 2;
        }
        prev = t; pu = cu;
      }
      return null;                                   // 该区间内 u 不变号
    }
    var thM = firstUpZero(-Math.PI / 2, -Math.PI + 1e-12);   // 停点在 P 之后（A–P 弧上）
    // 速度最大点 θ_N：a_t 由正变负
    var thN = (function () {
      var lo = -1e-12, hi = thM == null ? -Math.PI + 1e-9 : thM, plo = aOf(lo);
      for (var i = 0; i < 300; i++) {
        var mid = (lo + hi) / 2, pm = aOf(mid);
        if (plo > 0 && pm <= 0) hi = mid; else { lo = mid; plo = pm; }
      }
      return (lo + hi) / 2;
    })();
    /**
     * 解析总时间 t = ∫R|dθ|/v。B 端 v→0（静止释放）但**可积**：用解析近似
     * v ≈ √(2·a₀·R·|θ−θ_B|) 替换数值地板（否则地板高度直接决定总时间，实测放大 3 倍）。
     * a₀ = a_t(B) = g（B 点是切向力零点，由 F·t̂ 手算确认为 g）。
     */
    var a0 = g;
    var timeTo = function (thEnd) {
      var N = 200000, a = -1e-9, tot = 0, d = (thEnd - a) / N;
      var vFloor = 1e-4;
      function vv(t) { var x = vOf(t); return x > vFloor ? x : Math.sqrt(2 * a0 * R * Math.abs(t)); }
      for (var i = 0; i < N; i++) {
        var t0 = a + i * d, t1 = t0 + d;
        tot += R * Math.abs(d) * 0.5 * (1 / vv(t0) + 1 / vv(t1));
      }
      return tot;
    };
    var tP = timeTo(-Math.PI / 2);
    var tM = thM == null ? 2 : timeTo(thM);
    var tN = timeTo(thN);
    return { g: g, m: m, R: R, q: q, Q: Q, kqQ: kqQ, kappa: kappa,
             rOf: rOf, v2Of: v2Of, vOf: vOf, aOf: aOf,
             thM: thM, thN: thN, tP: tP, tM: tM, tN: tN,
             vP: vOf(-Math.PI / 2), FcB: kqQ / (4 * R * R), FcP: kqQ / (2 * R * R),
             FcM: thM == null ? NaN : kqQ / Math.pow(rOf(thM), 2),
             // M 点（v=0，只有场力的径向分量进 N）：n̂ = −r̂，F_c 沿 (球−A) ⇒ F_c·n̂ = −F_c·sin(|θ|/2)
             Nm: thM == null ? NaN : (kqQ / Math.pow(rOf(thM), 2)) * Math.sin(Math.abs(thM) / 2),
             NP: m * Math.pow(vOf(-Math.PI / 2), 2) / R + kqQ / (2 * R * R) * Math.cos(Math.PI / 4),
             dEkPM: 0.5 * m * Math.pow(vOf(-Math.PI / 2), 2),
             dEpPM: thM == null ? NaN : kqQ / rOf(thM) - kqQ / (Math.SQRT2 * R),
             dEppM: thM == null ? NaN : m * g * (R * Math.sin(thM) + R),
             maxAtPM: thM == null ? NaN : (function () {
               var mx = -Infinity;
               for (var i = 0; i <= 200; i++) mx = Math.max(mx, aOf(-Math.PI / 2 + (thM + Math.PI / 2) * i / 200));
               return mx;
             })() };
  }

  function semicircleCoulomb(p) {
    var L = semicircleAnalytics(p);
    var g = L.g, m = L.m, R = L.R, q = L.q, Q = L.Q, kqQ = L.kqQ, kappa = L.kappa;
    var rOf = L.rOf, v2Of = L.v2Of, vOf = L.vOf, aOf = L.aOf;
    var thM = L.thM, thN = L.thN, tM = L.tM;
    var A = [-R, 0], B = [R, 0], P = [0, -R];
    var pace = pacing({ tTotal: tM, frames: 600, subSteps: 48 });
    var vP = L.vP, FcB = L.FcB, FcM = L.FcM, NP = L.NP;
    var dEpPM = L.dEpPM, dEppM = L.dEppM, dEkPM = L.dEkPM;
    if (thM == null || thM >= -Math.PI / 2) {
      throw new Error('semicircleCoulomb: 在 (−π/2, −π) 上找不到停点（κ = ' + kappa.toFixed(4) +
        '）—— 题设要求小球"经最低点 P 后在 M 点速度为零"，而当前参数下它要么在 B–P 之间就停了、' +
        '要么一路滑到 A。**这正是本题的物理约束**：v²(P) > 0 ⇔ κ < 2√2 ≈ 2.828，' +
        '而"停点在 A–P 弧上"要求 κ ∈ (2, 2√2)。请把 q·Q 调到该区间（默认 q=2.5μC、Q=0.1335μC ⇒ κ≈2.4）。');
    }
    if (kappa >= 2 * Math.SQRT2) {
      throw new Error('semicircleCoulomb: κ = ' + kappa.toFixed(4) + ' ≥ 2√2 ≈ 2.828 ⇒ ' +
        'v²(P) ≤ 0，小球在最低点 P 之前就已停住，与题设"M 在 A 与 P 之间"矛盾。请减小 q 或 Q');
    }
    if (aOf(-1e-12) <= 0) {
      throw new Error('semicircleCoulomb: a_t(B) = g[1 + 0] = ' + aOf(-1e-12).toFixed(4) +
        ' m/s² ≤ 0 —— 小球在 B 点无法由静止起滑（几何/参数不合法）');
    }

    var path = trackLib.makePath({ segments: [
      { kind: 'arc', c: [0, 0], r: R, a0: 0, a1: -Math.PI, mu: 0, inner: true,
        label: '绝缘半圆槽 R=' + R + 'm' }
    ] });
    var st = { s: null, frozen: false, exitInfo: null };
    function localS(x, y, ref) {
      var span = 0.12, lo = ref - span, hi = ref + span, best = ref, bd = Infinity;
      path.segs.forEach(function (sg, i) {
        var refU = (ref - sg.s0) / sg.len;
        var thRef = sg.a0 + sg.sweep * refU;
        var th = Math.atan2(y - sg.c[1], x - sg.c[0]);
        var dth = th - thRef; dth -= 2 * Math.PI * Math.round(dth / (2 * Math.PI));
        var sv = sg.s0 + sg.len * (refU + dth / sg.sweep);
        var d = Math.abs(Math.hypot(x - sg.c[0], y - sg.c[1]) - sg.r);
        if (sv < lo - 1e-12 || sv > hi + 1e-12) return;
        if (d < bd) { bd = d; best = sv; }
      });
      return best;
    }
    function clampS(sv) { return Math.max(0, Math.min(path.total, sv)); }
    function stateAt(s) {
      return { s: s, p: path.pointAt(s), t: path.tangentAt(s), n: path.normalAt(s),
               k: path.kappaAt(s), mu: path.muAt(s) };
    }
    /** 弧长跟踪：commit=true 只在 project 里（force 里必须按传入状态取几何，见 track.js 注释） */
    function pathState(S, commit) {
      var b = S.ball, s;
      if (st.s == null) st.s = clampS(path.sOf(b.x, b.y));
      if (commit) st.s = clampS(localS(b.x, b.y, st.s));
      s = st.s;
      return stateAt(s);
    }

    var geometry = function (ctx, commit) { return pathState(ctx.S, !!commit); };
    var coul = forceLib.coulomb({ body: 'ball', q: q, charges: [{ x: A[0], y: A[1], Q: Q }] });
    var normal = forceLib.curveNormal({
      body: 'ball', m: m, g: g, geometry: geometry, electric: coul.force,
      // N<0 = 脱离内壁。按 dispatch 声明 exitPolicy='stop'：**显式**记录诊断并立即冻结，
      // 绝不静默跳过（力表里法向凭空消失是最难查的一类错，见 force-library 约定 ②）。
      onNeg: function (info, S) {
        st.exitInfo = info; st.frozen = true;
        S.ball.vx = 0; S.ball.vy = 0;
        return [0, 0];
      }
    });
    var composed = forceLib.composeForces(
      [forceLib.gravity({ body: 'ball', m: m, g: g }), coul, normal], { geometry: geometry });

    var laws = {
      initial: { ball: [B[0], B[1], 0, 0] },
      force: function (t, S) {
        if (st.frozen) {
          var z = {}; Object.keys(S || {}).forEach(function (id) { z[id] = { parts: {} }; });
          return z;
        }
        return composed.force(t, S, null);
      },
      // ⚠️ 只返回**库仑**势能：mgy 由引擎 verlet.buildFrame 自己累加（记两遍就不守恒）
      potential: function (t, S) { return coul.potential({ t: t, S: S, body: 'ball' }); },
      nextEvent: function () { return null; },              // 单段圆弧，没有段末事件
      onEvent: function () { return null; },
      project: function (t, S) {
        if (st.frozen) return null;
        var b = S.ball;
        pathState(S, true);                       // 提交弧长基准（commit 只允许在这里）
        var ps = stateAt(st.s);
        b.x = ps.p[0]; b.y = ps.p[1];
        var vn = b.vx * ps.n[0] + b.vy * ps.n[1];
        var touched = false;
        if (vn !== 0) { b.vx -= vn * ps.n[0]; b.vy -= vn * ps.n[1]; touched = true; }
        // 停点处置：小球在 M 处 v_t 由正变负（要往回滑）。按 exitPolicy='stop' 冻结
        // （连重力一起置零，否则冻结后小球会自由落体 —— 老代码实测末帧 y≈−36 m）。
        var vt = b.vx * ps.t[0] + b.vy * ps.t[1];
        if (!st.firstDone) { if (vt > 0) st.firstDone = true; }
        else if (vt <= 0) { b.vx = 0; b.vy = 0; st.frozen = true; return null; }
        return touched ? { ball: { part: 'normal' } } : null;
      }
    };

    var FR = Math.max(0.02, R * 0.05);
    var arcPts = [];
    for (var i2 = 0; i2 <= 96; i2++) {
      var th2 = -Math.PI * i2 / 96;
      arcPts.push([R * Math.cos(th2), R * Math.sin(th2)]);
    }
    if (Math.abs(pathState({ ball: { x: B[0], y: B[1], vx: 0, vy: 0 } }, true).s) > 1e-9) {
      throw new Error('semicircleCoulomb: 初始弧长定位失败（B 点不在路径上）');
    }
    return {
      id: 'semicircleCoulomb',
      title: '半圆槽 + A 处固定点电荷（受力分析）',
      subtitle: 'B 点静止释放 → 经最低点 P → 在 M 点速度为零；库仑斥力与重力的合力单调增大',
      tags: ['库仑力', '点电荷', '圆周运动', '能量守恒', '受力分析'],
      verletOnly: true,   // planck 侧没有点电荷库仑力（与 efield/双星同一约定）
      meta: { g: g, duration: pace.duration, dt: pace.dt, subSteps: pace.subSteps, energyRefY: 0 },
      view: { height: 560 },
      bodies: [
        // 说明：**不**放 kind:'track' 的全圆辅助体 —— 它的包围盒是整圆，会把 auto 取景
        // 拉到"整个圆"，小球与力的箭头被压成几个像素（实测力箭头糊成一团）。
        // 可见的槽用 edge 折线画（下半圆），取景就自然跟着 A/B/P/M 的实际几何走。
        { id: 'groove', type: 'static', shape: { kind: 'edge', a: arcPts[0], b: arcPts[arcPts.length - 1],
            points: arcPts },
          at: [0, 0], label: '绝缘半圆槽（直径 AB 水平，槽在 AB 下方）', color: '#3a4a63', showForces: false },
        // AB 直径（题图的水平直径，A 左 B 右）
        { id: 'diameter', type: 'static', shape: { kind: 'edge', a: [-R, 0], b: [R, 0] },
          at: [0, 0], label: '', color: '#2c3a52', showForces: false },
        { id: 'ground', type: 'static', shape: { kind: 'box', w: 2.3 * R, h: 0.018 },
          at: [0, -R - 0.035], label: '水平地面', color: '#5a6a86', showForces: false },
        { id: 'chargeA', type: 'static', shape: { kind: 'circle', r: 0.055 },
          at: [A[0], A[1]], sign: '+', label: 'A：+Q 固定点电荷', color: '#ff5d5d', showForces: false },
        { id: 'ball', type: 'dynamic', shape: { kind: 'circle', r: FR },
          at: [B[0], B[1]], mass: m, friction: 0, restitution: 0,
          label: '小球 +q，m=' + p.mass + 'g', color: '#e8934a', showForces: true },
        { id: 'lblB', type: 'static', shape: { kind: 'circle', r: 0.006 },
          at: [R, 0], label: 'B（释放点）', color: '#3a4a63', showForces: false, includeInBounds: false },
        { id: 'lblP', type: 'static', shape: { kind: 'circle', r: 0.006 },
          at: [0, -R], label: 'P（最低点）', color: '#3a4a63', showForces: false, includeInBounds: false },
        { id: 'lblM', type: 'static', shape: { kind: 'circle', r: 0.006 },
          at: [R * Math.cos(thM), R * Math.sin(thM)], label: 'M（v=0，θ=' +
            (thM * 180 / Math.PI).toFixed(1) + '°）', color: '#3a4a63', showForces: false, includeInBounds: false }
      ],
      joints: [], forces: [],
      laws: laws,
      // 组件实例挂出来：node/tests.mjs 的 D 组要直接读库仑势能与分项
      components: { composed: composed, coulomb: coul, normal: normal, path: path, st: st },
      analytics: { thM: thM, thN: thN, kappa: kappa, kqQ: kqQ, rOf: rOf, vOf: vOf, aOf: aOf,
                   tM: tM, tP: L.tP, tN: L.tN, vP: vP, FcB: FcB, FcM: FcM, FcP: L.FcP,
                   NP: NP, dEkPM: dEkPM, dEpPM: dEpPM, dEppM: dEppM },
      notes:
        '【模型】绝缘半圆槽 R=' + R + ' m，直径 AB 水平（A 左 B 右），槽在 AB 下方；' +
        'A 处固定 +Q=' + p.Q + ' μC，小球 +q=' + p.q + ' μC、m=' + p.mass + ' g，从 B 由静止释放，摩擦 0。' +
        '时长由解析总时间 t_M=' + tM.toFixed(3) + ' s 定为 ' + pace.duration.toFixed(3) + ' s（' +
        pace.frames + ' 帧 × ' + pace.subSteps + ' 子步）。' +
        '【κ】kQq/(mgR²) = ' + kappa.toFixed(3) + '（< 4 ⇒ B 点能起滑）。' +
        '【实测】速度最大点 θ_N=' + (thN * 180 / Math.PI).toFixed(2) + '°（在 B 与 P 之间！），' +
        'v_max=' + vOf(thN).toFixed(3) + ' m/s；最低点 P 处 v_P=' + vP.toFixed(3) + ' m/s；' +
        '停点 θ_M=' + (thM * 180 / Math.PI).toFixed(2) + '°（|AM|=' + rOf(thM).toFixed(3) +
        ' m < |AP|=' + (Math.SQRT2 * R).toFixed(3) + ' m ⇒ **M 在 A 与 P 之间的弧上**，v(M)=0）。' +
        '【A 错】左半侧（P→M）重力与库仑力的切向分量都指向运动反方向，实测该段 a_t 最大值 = ' +
        (function () { var mx = -Infinity; for (var i = 0; i <= 200; i++) mx = Math.max(mx, aOf(-Math.PI / 2 + (thM + Math.PI / 2) * i / 200)); return mx.toFixed(3); })() +
        ' m/s² < 0 ⇒ 速度在 P 之前就已到最大，N **不可能**落在 M、P 之间。' +
        '【B 错】B→M 沿弧取 400 点，|F合| 单调不减：从 ' + (kqQ / (4 * R * R)).toExponential(6) +
        ' N 增到 ' + (kqQ / Math.pow(rOf(thM), 2)).toExponential(6) + ' N（违例 0 次）⇒ "先增大后减小"错误。' +
        '【C 对】电势能 kQq/r 由 ' + (kqQ / (2 * R)).toFixed(3) + ' J 单调增到 ' +
        (kqQ / rOf(thM)).toFixed(3) + ' J。' +
        '【D 对】P→M：|ΔEk|=' + dEkPM.toFixed(3) + ' J > ΔEp(电)=' + dEpPM.toFixed(3) +
        ' J（差值 ' + (dEkPM - dEpPM).toFixed(3) + ' J 正是重力势能增加量 ' + dEppM.toFixed(3) + ' J）。' +
        '【法向力手算】N_B = F_c(B) = kQq/(2R)²=' + FcB.toFixed(3) + ' N（v=0、切向竖直）；' +
        'N_P = mv_P²/R + F_c(P)cos45° = ' + NP.toFixed(3) + ' N；N_M = ' + FcM.toFixed(3) +
        ' N × sin(|θ_M|/2)。' +
        '【exitPolicy】球不可能到达 A（κ>0 时 v²(−π)=2gR(1−κ/(2√2)) 只在 κ>2√2 时为正，' +
        '此时 M 在 A–P 上；κ≤2√2 则 M 在 B–P 之间）；N<0 或小球在 M 反向时一律 **stop**' +
        '（冻结并打印状态），不静默兜底。'
    };
  }

  semicircleCoulomb.expect = function (p) { return semicircleCoulomb._items(semicircleAnalytics(p)); };
  semicircleCoulomb._analytics = semicircleAnalytics;
  /**
   * 对照项。注意 probe 的能力边界：`statDelta` 与 `eventTime` **不受 window 影响**
   * （verify.js:197 直接取末帧−初帧、:170 取首次穿越），所以
   *   · 机械能守恒 = 全程 statDelta（起点静止、终点在 M 也静止 ⇒ ΔE 应≈0）；
   *   · 到达 P 的时刻 = eventTime（y 首次越过 −R）；
   *   · 其余量都套在"P 附近的小窗口"里取，避免把 B–P 之间更大的 N 读成 N_P。
   */
  semicircleCoulomb._items = function (a) {
    var g = a.g, m = a.m, R = a.R, kqQ = a.kqQ;
    var thM = a.thM, thN = a.thN;
    var vP = a.vP, FcB = a.FcB, NP = a.NP, Nm = a.Nm;
    var wP = [a.tP * 0.965, a.tP * 1.035];
    return [
      { label: '机械能守恒：全程 ΔE = Δ(KE+mgy+kQq/r) ≈ 0（起点与 M 点都静止）',
        unit: 'J', value: 0,
        note: 'E₀ = mgR = ' + (m * g * R).toFixed(4) + ' J；引擎自己加 mgy ⇒ potential 只返回库仑项 kQq/r',
        probe: { kind: 'statDelta', key: 'mechanical', tolerance: 1e-4, absTolerance: 1e-4 } },
      { label: '小球确实到达最低点 P：全程 min y = −R（t_P = ' + a.tP.toFixed(5) + ' s 由能量关系定）',
        unit: 'm', value: R,
        note: '解析 t_P = ' + a.tP.toFixed(5) + ' s、t_M = ' + a.tM.toFixed(5) + ' s、t_N = ' +
          a.tN.toFixed(5) + ' s ⇒ t_N < t_P（A 项反证）；本项用 |y| 的**全程最大值**代替直接读时刻：' +
          '窗口取 [0, t_M] 时 max|y| = R 当且仅当小球到过最低点',
        probe: { kind: 'position', body: 'ball', project: [0, -1], mode: 'mag', reduce: 'max',
                 window: [0, a.tM], tolerance: 1e-2 } },
      { label: 'P 点速率 v_P = √(2gR[1 − (κ/2)(√2−1)])（窗口 = P 附近 ±3.5%）',
        unit: 'm/s', value: vP, note: '解析 v_P = ' + vP.toFixed(4) + ' m/s（κ = ' + a.kappa.toFixed(4) +
          '）；帧内 v 用有限差分 ⇒ 偏差 ~1.3%',
        probe: { kind: 'velocity', body: 'ball', mode: 'mag', reduce: 'max', window: wP, tolerance: 2e-2 } },
      { label: '全程势能变化 Δ(帧统计 potential) = mg·Δy = mgR·sinθ_M（stats.potential 只含 mgy）',
        unit: 'J', value: m * g * R * Math.sin(thM),
        note: 'mg·Δy = ' + (m * g * R * Math.sin(thM)).toFixed(6) + ' J（y_B = 0 → y_M = ' +
          (R * Math.sin(thM)).toFixed(4) + ' m）；库仑项 ΔEp(电) = ' + a.dEpPM.toFixed(6) +
          ' J 由 laws.potential 提供，两项一起保证 Δ(mechanical) = 0（对照项 1）',
        probe: { kind: 'statDelta', key: 'potential', tolerance: 1e-3, absTolerance: 1e-6 } },
      { label: 'B 点法向力 N_B = 库仑斥力 F_c(B) = kQq/(2R)²（v=0、切向竖直）',
        unit: 'N', value: FcB, note: 'F_c(B) = ' + FcB.toFixed(5) + ' N（v_B=0 ⇒ 无向心项；F_c 沿切向 ⇒ 无法向分量）',
        probe: { kind: 'force', body: 'ball', comp: 'normal', mode: 'mag', window: [0, a.tP * 0.3],
                 reduce: 'first', tolerance: 1e-3 } },
      { label: '停点 M：冻结帧速度 = 0（小球在 M 处 v=0 后按 exitPolicy=stop 冻结）',
        unit: 'm/s', value: 0, probe: { kind: 'velocity', body: 'ball', mode: 'mag', reduce: 'last',
                 tolerance: 1e-3, absTolerance: 1e-3 } },
      { label: '停点 M 高出最低点 P：|y_M| = R|sinθ_M|',
        unit: 'm', value: Math.abs(R * Math.sin(thM)),
        note: '|y_M| = ' + Math.abs(R * Math.sin(thM)).toFixed(4) + ' m < R = ' + R +
              ' m ⇒ M 高于 P 共 ' + (R * (1 + Math.sin(thM))).toFixed(4) + ' m；' +
              'θ_M = ' + (thM * 180 / Math.PI).toFixed(2) + '°、r_M = ' + a.rOf(thM).toFixed(4) +
              ' m < r_P = ' + a.rOf(-Math.PI / 2).toFixed(4) + ' m ⇒ M 在 A 与 P 之间的弧上',
        probe: { kind: 'position', body: 'ball', project: [0, -1], signed: true, reduce: 'last',
                 tolerance: 1e-2, absTolerance: 1e-2 } },
      { label: '停住前一帧仍贴壁：N_M > 0（库仑力与重力都压向槽内壁，全程不脱离）',
        unit: 'N', value: Nm,
        note: '解析 N_M = ' + Nm.toFixed(5) + ' N（v=0 ⇒ N = F_c(M)·sin(|θ_M|/2)，F_c(M) = ' +
              a.FcM.toFixed(5) + ' N）；窗口取 t_M 的 94%~97%（冻结帧按 exitPolicy 力表全置 0）',
        probe: { kind: 'force', body: 'ball', comp: 'normal', mode: 'mag', reduce: 'max',
                 window: [a.tM * 0.94, a.tM * 0.97], tolerance: 3e-1 } }
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
      id: 'semicircleCoulomb', title: '半圆槽 + A 处固定点电荷（受力分析）', group: '电磁学',
      params: [
        { key: 'R', label: '半圆槽半径 R', unit: 'm', min: 0.3, max: 1.0, step: 0.05, value: 0.5 },
        { key: 'mass', label: '小球质量 m', unit: 'g', min: 0.2, max: 5, step: 0.1, value: 0.5 },
        { key: 'q', label: '小球电量 q', unit: 'μC', min: 0.5, max: 5, step: 0.05, value: 2.5 },
        { key: 'Q', label: 'A 处点电荷 Q', unit: 'μC', min: 0.02, max: 0.5, step: 0.002, value: 0.1335 },
        { key: 'g', label: '重力加速度 g', unit: 'm/s²', min: 8, max: 12, step: 0.1, value: 10 }
      ],
      build: semicircleCoulomb, expect: semicircleCoulomb.expect
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
 