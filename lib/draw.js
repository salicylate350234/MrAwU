/*!
 * MrAwU（阿物先生）— lib/draw.js
 * 渲染器：把一帧的位姿 + 受力画到任意 canvas-2D 上下文。
 * 浏览器与 Node（@napi-rs/canvas）共用同一份代码，保证「我看到的」=「你看到的」。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    var F = null; try { F = require('./field.js'); } catch (e) { F = null; }
    module.exports = factory(require('./scene.js'), F);
  } else {
    root.PFA = root.PFA || {};
    root.PFA.draw = factory(root.PFA.scene, root.PFA.field);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (sceneLib, fieldLib) {
  'use strict';

  var COLORS = {
    gravity: '#4da3ff',
    normal: '#35d07f',
    friction: '#ffb020',
    joint: '#b26bff',
    applied: '#ff5d5d',
    damping: '#7a8ba8',
    total: '#ffffff',
    velocity: '#00d4d4',
    trail: 'rgba(232,147,74,0.32)'
  };
  var LABELS = {
    gravity: '重力 G', gravitation: '万有引力 F引', electric: '电场力 F电',
    normal: '支持力 N', friction: '摩擦力 f',
    joint: '绳/杆张力 T', applied: '外力 F', damping: '阻尼', total: '合力'
  };

  /**
   * 两套主题。
   * dark  —— 屏幕演示用；
   * light —— 印卷/板书风格：白底、淡黄护眼网格、物体一律黑框空心、力全部黑色箭头、
   *          合力画成白色空心箭头（与教材、试卷的画法一致）。
   */
  var THEMES = {
    dark: {
      name: 'dark',
      bgTop: '#101828', bg: '#0d1220',
      grid: 'rgba(120,150,200,0.13)', gridWidth: 1,
      staticFill: '#3a4a63', staticStroke: 'rgba(180,205,240,0.5)', staticWidth: 1.6,
      edgeWidth: 5,
      bodyHollow: false, bodyStroke: 'rgba(255,255,255,0.55)', bodyWidth: 1.6,
      beltFill: '#41506b', beltTread: 'rgba(175,205,245,0.5)',
      ropeColor: '#c9b28a', rodColor: '#9fb4d8', jointFill: '#1b2436', jointStroke: '#9fb4d8',
      pulleyStroke: '#8899bb', pulleyFill: '#2b3550',
      arrow: { gravity: '#4da3ff', gravitation: '#ff7ad9', electric: '#7ce0ff', normal: '#35d07f', friction: '#ffb020', joint: '#b26bff', applied: '#ff5d5d', damping: '#7a8ba8', total: '#ffffff', velocity: '#00d4d4' },
      totalHollow: false,
      // 深色模式下所有受力箭头描一圈薄黑边，避免和背景/彼此糊在一起
      forceOutline: 'rgba(3,6,12,0.92)',
      labelHalo: 'rgba(6,10,18,0.85)', labelText: null,   // labelText=null → 用箭头本身的颜色
      trail: 'rgba(232,147,74,0.32)', velocityDash: null,
      panelBg: 'rgba(8,12,20,0.68)', panelLine: 'rgba(140,170,215,0.25)',
      text: '#dce6f5', textMuted: '#8fa3c2', hudText: '#c7d5ea', hudBg: 'rgba(8,12,20,0.62)',
      dim: 'rgba(255,214,102,0.95)', dimLine: 'rgba(255,214,102,0.75)', dimHalo: 'rgba(6,10,18,0.9)',
      // 静电场等"场可视化"模型的配色
      field: {
        line: 'rgba(126,214,255,0.62)', arrow: 'rgba(160,226,255,0.95)', equi: 'rgba(255,214,102,0.38)',
        probe: '#ffd666', probeText: '#ffe9a8', halo: 'rgba(6,10,18,0.85)',
        positive: '#ff5d5d', negative: '#4da3ff', chargeEdge: 'rgba(255,255,255,0.85)',
        select: '#35d07f', text: '#e6edf8'
      }
    },
    light: {
      name: 'light',
      bgTop: '#ffffff', bg: '#ffffff',
      grid: 'rgba(226,196,74,0.55)', gridWidth: 1,          // 淡黄护眼网格
      staticFill: '#ffffff', staticStroke: '#111111', staticWidth: 2,
      edgeWidth: 3,
      bodyHollow: true, bodyStroke: '#111111', bodyWidth: 2,
      beltFill: '#ffffff', beltTread: 'rgba(20,20,20,0.55)',
      ropeColor: '#111111', rodColor: '#111111', jointFill: '#ffffff', jointStroke: '#111111',
      pulleyStroke: '#111111', pulleyFill: '#ffffff',
      arrow: { gravity: '#111111', gravitation: '#111111', electric: '#111111', normal: '#111111', friction: '#111111', joint: '#111111', applied: '#111111', damping: '#111111', total: '#111111', velocity: '#111111' },
      totalHollow: true,
      forceOutline: null,      // 浅色模式下箭头本身就是黑的，不需要再描边
      labelHalo: 'rgba(255,255,255,0.92)', labelText: '#111111',
      trail: 'rgba(20,20,20,0.22)', velocityDash: null,
      panelBg: 'rgba(255,255,255,0.9)', panelLine: '#cfcfcf',
      text: '#111111', textMuted: '#666666', hudText: '#333333', hudBg: 'rgba(255,255,255,0.85)',
      dim: '#a9770a', dimLine: 'rgba(169,119,10,0.85)', dimHalo: 'rgba(255,255,255,0.92)',
      tipBg: 'rgba(255,255,255,0.98)', tipLine: 'rgba(0,0,0,0.22)',
      tipTitle: '#0b3a55', tipText: '#243244',
      field: {
        line: 'rgba(40,110,190,0.6)', arrow: 'rgba(20,80,160,0.95)', equi: 'rgba(200,150,20,0.5)',
        probe: '#a9770a', probeText: '#7a5505', halo: 'rgba(255,255,255,0.92)',
        positive: '#d33a2c', negative: '#1f6feb', chargeEdge: '#111111',
        select: '#0f7a3d', text: '#111111'
      }
    }
  };
  var THEME = THEMES.dark;
  var FONT = 'system-ui, "Microsoft YaHei", "PingFang SC", sans-serif';
  function setFont(f) { FONT = f; }
  function setTheme(name) { THEME = THEMES[name] || THEMES.dark; return THEME; }
  function currentTheme() { return THEME; }

  /**
   * 取景：**按内容自适应**（模型自己的尺度），不假定任何"米"的量级。
   *
   * 两处曾写死过尺寸，尺度一变就失衡：
   *   · 边距固定 0.15 m：厘米级题目（电场偏转 L=4 cm）里它比内容还大，取景被撑到内容的 5 倍，
   *     屏上偏移只剩十几个像素；
   *   · 只按动态轨迹取景：静态几何（极板/荧光屏）反被裁到画外，学生看到"粒子在空场里飞"。
   *     所以显式标了 `includeInBounds` 的静态刚体要一起进框。
   * 现在边距取"内容跨度的 8%，且不超过 0.15 m"：宏观题观感与原来一致，微观题刚好装下。
   */
  function makeView(frames, scene, override) {
    var v = scene.view;
    var xmin = Infinity, ymin = Infinity, xmax = -Infinity, ymax = -Infinity;
    var hasDynamic = false;
    function addPoint(x, y) {
      if (x < xmin) xmin = x; if (x > xmax) xmax = x;
      if (y < ymin) ymin = y; if (y > ymax) ymax = y;
    }
    scene.bodies.forEach(function (b) {
      // 静态几何：只有显式声明 includeInBounds（极板/屏/轨道这类"题目本体"）才进框
      if (b.type !== 'dynamic') {
        if (!b.includeInBounds) return;
        var sb2 = sceneLib.shapeBounds(b.shape);
        var ca = Math.cos(b.angle || 0), sa = Math.sin(b.angle || 0);
        [[sb2[0][0], sb2[0][1]], [sb2[1][0], sb2[1][1]], [sb2[0][0], sb2[1][1]], [sb2[1][0], sb2[0][1]]]
          .forEach(function (q) { addPoint(b.at[0] + q[0] * ca - q[1] * sa, b.at[1] + q[0] * sa + q[1] * ca); });
        return;
      }
      hasDynamic = true;
      // ⚠️ 动态刚体的包围盒**不再加 0.15 m 的世界边距**：那是"按米写死"的量级假设，
      // 厘米级题目里 0.15 m 比整段轨迹还大，画面被撑成一小团（实测 L=4 cm 时只占画面 10%）。
      // 现在只取刚体自身半径，余量统一交给下面的**自适应边距**（内容跨度的 8%，上限 0.15 m）。
      var bb = sceneLib.shapeBounds(b.shape);
      var halo = Math.max(Math.abs(bb[0][0]), Math.abs(bb[1][0]), Math.abs(bb[0][1]), Math.abs(bb[1][1]));
      frames.forEach(function (f) {
        var s = f.bodies[b.id];
        if (!s) return;
        addPoint(s.x - halo, s.y - halo);
        addPoint(s.x + halo, s.y + halo);
      });
    });
    if (!hasDynamic || !isFinite(xmin)) {
      var sb = sceneLib.staticBounds(scene);
      xmin = sb.xmin; ymin = sb.ymin; xmax = sb.xmax; ymax = sb.ymax;
    }
    // 边距自适应：内容跨度的 8%，上限仍是 0.15 m（宏观题观感不变）
    var padAuto = Math.min(0.15, Math.max(xmax - xmin, ymax - ymin) * 0.08);
    xmin -= padAuto; xmax += padAuto; ymin -= padAuto; ymax += padAuto;
    // 视野下限：只为防止"完全退化成一个点"，不能设成 1 m——
    // 厘米级题（例如最小板长 9 cm 的板块题）会被这 1 m 下限压得什么都看不清。
    var w = Math.max(xmax - xmin, 0.12), h = Math.max(ymax - ymin, 0.12);
    var cx = (xmin + xmax) / 2, cy = (ymin + ymax) / 2;
    var padPx = v.padding != null ? v.padding : 40;

    // ---- 力标尺 ----
    // 1) 参考长度用**像素**而不是"世界米"。用世界米会让箭头随取景一起缩小：
    //    斜面场景里重力 20N 的箭头只有 45px，摩擦力 3.5N 就被压到 8px 以下、
    //    干脆不画——老师看到的现象就是"这个模型没有摩擦力"。
    // 2) 参考值用 95% 分位数而不是绝对最大值：碰撞瞬间的法向力尖峰能到 384N，
    //    若按它定标，同场景里 20N 的重力就只剩几个像素、同样看不见。
    var ARROW_PX = Math.max(56, Math.min(v.width, v.height) * 0.17);
    var LABEL_PX = 46;
    // 边距只需要"不让箭头/标签出画"，不需要按整支箭头的长度留。
    // 早先按 ARROW_PX*1.15 留，画布偏矮时（收起面板前只有 ~490px）光边距就吃掉 360px，
    // 拟合比例被迫压到很小、内容显得又小又空。
    var margin = padPx + ARROW_PX * 0.62 + LABEL_PX * 0.45;
    var pxPerM = Math.min(
      Math.max(40, v.width - margin * 2) / w,
      Math.max(40, v.height - margin * 2) / h
    );

    var mags = [];
    var maxSpeed = 1e-9;
    frames.forEach(function (f) {
      Object.keys(f.bodies).forEach(function (id) {
        var b = f.bodies[id];
        if (b.type !== 'dynamic') return;
        ['gravity', 'gravitation', 'electric', 'normal', 'friction', 'joint', 'applied', 'damping'].forEach(function (k) {
          var m = Math.hypot(b.forces[k][0], b.forces[k][1]);
          if (m > 1e-9) mags.push(m);
        });
        var sp = Math.hypot(b.vx, b.vy);
        if (sp > maxSpeed) maxSpeed = sp;
      });
    });
    mags.sort(function (a, b) { return a - b; });
    var maxF = mags.length ? mags[Math.min(mags.length - 1, Math.floor(mags.length * 0.95))] : 1;
    if (!(maxF > 1e-6)) maxF = 1e-6;

    // 允许调用方覆盖取景中心与比例（静电场锁定取景时用）：
    // 覆盖后力标尺要跟着重算，否则箭头长度不再正比于力。
    if (override) {
      if (override.cx != null) cx = override.cx;
      if (override.cy != null) cy = override.cy;
      if (override.pxPerM != null) pxPerM = override.pxPerM;
    }
    // 这道题到底有哪几类力在起作用（图例据此只列真正出现的力，受力分析更干净）
    var present = {};
    frames.forEach(function (f) {
      Object.keys(f.bodies).forEach(function (id) {
        var b = f.bodies[id];
        if (b.type !== 'dynamic' || !b.forces) return;
        Object.keys(b.forces).forEach(function (k) {
          if (k === 'total' || k === 'totalTorque') return;
          var v2 = b.forces[k];
          if (v2 && Math.hypot(v2[0], v2[1]) > 1e-9) present[k] = true;
        });
      });
    });
    if (maxF > 1e-12) present.total = true;
    return {
      cx: cx, cy: cy, pxPerM: pxPerM,
      width: v.width, height: v.height,
      maxForce: maxF,
      maxSpeed: maxSpeed,      arrowPx: ARROW_PX,
      // 单位：米每牛顿（渲染时乘 pxPerM 得到像素长度）
      forceScale: (ARROW_PX / pxPerM) / maxF,   // 与最终 pxPerM 一致
      presentForces: present,
      // 模型自身的基准包围盒（未变换）：控制框据此换算出模型的 position/scale
      content: { xmin: xmin, xmax: xmax, ymin: ymin, ymax: ymax, cx: cx, cy: cy },
      grid: v.grid !== false,
      background: v.background || '#0d1220'
    };
  }

  /** 力值格式化：小力用 mN，保证标签始终有 2~3 位有效数字（3 mN 不再显示成 0.0N） */
  function fmtForce(v) {
    var a = Math.abs(v);
    if (a <= 1e-12) return '0N';
    if (a >= 100) return v.toFixed(0) + 'N';
    if (a >= 1) return v.toFixed(1) + 'N';
    if (a >= 0.1) return v.toFixed(2) + 'N';
    if (a >= 1e-4) return (v * 1e3).toFixed(a >= 1e-2 ? 1 : 2) + 'mN';
    return v.toExponential(1) + 'N';
  }

  function project(view, x, y) {
    // ---- 模型变换（模型自己的 position / scale），与相机分开 ----
    // 控制框拖动改的是**这里**：把模型几何整体平移+缩放，相机（取景）完全不动。
    // 早先改的是 view.cx/cy/pxPerM，那是"相机变焦"，会把框外内容裁掉、也改不了模型本身。
    var mt = view.mt;
    if (mt) {
      x = (x - mt.cx) * mt.sx + mt.cx + mt.tx;
      y = (y - mt.cy) * mt.sy + mt.cy + mt.ty;
    }
    return [
      (x - view.cx) * view.pxPerM + view.width / 2,
      view.height / 2 - (y - view.cy) * view.pxPerM + (view.yShiftPx || 0)
    ];
  }

  /** 模型变换对"向量"的作用（力箭头、速度箭头、线宽都要跟着模型一起缩放） */
  function modelVec(view, vx, vy) {
    var mt = view.mt;
    if (!mt) return [vx, vy];
    return [vx * mt.sx, vy * mt.sy];
  }
  /** 模型变换对"长度"的作用（半径、线宽按两轴平均） */
  function modelLen(view, v) {
    var mt = view.mt;
    if (!mt) return v;
    return v * Math.sqrt(Math.abs(mt.sx * mt.sy)) || v;
  }

  function unproject(view, px, py) {
    return [
      view.cx + (px - view.width / 2) / view.pxPerM,
      view.cy - (py - view.height / 2) / view.pxPerM
    ];
  }

  /**
   * 把"框选区域"变成真正的取景：框内的世界内容放大铺满整块画布。
   * crop 用画布 CSS 像素表示 {x,y,w,h}（全画布 = {0,0,width,height}，即不缩放）。
   * 做法是改 cx/cy/pxPerM，而**不是**给 ctx 加缩放——
   * 这样文字、箭头粗细、线宽都保持 1:1，只有模型本身被放大，画面才是清晰的。
   * 力标尺按新比例重算，箭头长度仍然严格正比于力的大小。
   */
  function cropView(base, crop) {
    if (!crop || !(crop.w > 0) || !(crop.h > 0)) return base;
    var k = Math.min(base.width / crop.w, base.height / crop.h);
    var c = unproject(base, crop.x + crop.w / 2, crop.y + crop.h / 2);
    var out = {
      cx: c[0], cy: c[1], pxPerM: base.pxPerM * k,
      width: base.width, height: base.height,
      maxForce: base.maxForce, maxSpeed: base.maxSpeed,
      arrowPx: base.arrowPx,
      // 力标尺 = base 的像素参考长度 / 新比例，所以箭头在屏幕上的长度不随缩放变化
      forceScale: (base.arrowPx / (base.pxPerM * k)) / base.maxForce,
      grid: base.grid,
      background: base.background,
      base: base, crop: crop, zoom: k
    };
    return out;
  }

  /** 画"框选"覆盖层（8 个控制点：4 角 + 4 边中点，可缩放/平移，不旋转） */
  function drawCropFrame(ctx, W, H, crop, opts) {
    var o = opts || {};
    var r = crop || { x: 0, y: 0, w: W, h: H };
    ctx.save();
    // 框外压暗，突出"输出会保留的区域"
    ctx.fillStyle = 'rgba(4,8,14,0.45)';
    ctx.beginPath();
    ctx.rect(0, 0, W, H);
    ctx.rect(r.x, r.y, r.w, r.h);
    ctx.fill('evenodd');
    ctx.strokeStyle = o.color || '#4da3ff';
    ctx.lineWidth = 2;
    ctx.setLineDash(o.dash || [7, 5]);
    ctx.strokeRect(r.x + 1, r.y + 1, r.w - 2, r.h - 2);
    ctx.setLineDash([]);
    // 三分线（构图参考）
    ctx.strokeStyle = 'rgba(77,163,255,0.35)';
    ctx.lineWidth = 1;
    [1, 2].forEach(function (i) {
      var x = r.x + r.w * i / 3, y = r.y + r.h * i / 3;
      ctx.beginPath(); ctx.moveTo(x, r.y); ctx.lineTo(x, r.y + r.h); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(r.x, y); ctx.lineTo(r.x + r.w, y); ctx.stroke();
    });
    // 8 个控制点
    var hs = 9;
    cropHandles(r, W, H).forEach(function (h) {
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = o.color || '#4da3ff';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.rect(h.x - hs / 2, h.y - hs / 2, hs, hs);
      ctx.fill();
      ctx.stroke();
    });
    ctx.restore();
    return r;
  }

  /** 8 个控制点：4 角 + 4 边中点（key 标明它控制哪条边/哪个角） */
  function cropHandles(r, W, H) {
    var x0 = r.x, y0 = r.y, x1 = r.x + r.w, y1 = r.y + r.h;
    return [
      { key: 'nw', x: x0, y: y0 }, { key: 'n', x: (x0 + x1) / 2, y: y0 },
      { key: 'ne', x: x1, y: y0 }, { key: 'e', x: x1, y: (y0 + y1) / 2 },
      { key: 'se', x: x1, y: y1 }, { key: 's', x: (x0 + x1) / 2, y: y1 },
      { key: 'sw', x: x0, y: y1 }, { key: 'w', x: x0, y: (y0 + y1) / 2 }
    ];
  }

  /**
   * 拖动处理：返回新的 crop。
   * mode = 'move' 平移；否则按控制点 key 缩放（对角/对边保持不动，不支持旋转）。
   * 约束：框必须留在画布内；且最小尺寸 = 画布的 50%（"输出时框要占屏幕一半以上"）。
   */
  /**
   * 拖动控制框。
   * opts 用来区分两种用途（早先只有"相机裁剪"一种、参数写死，结果误伤了模型变换）：
   *   · 相机裁剪（默认）：框至少占半屏、且夹在画布内
   *   · 模型变换：模型包围盒本来就可能小于半屏，**不能**在第一次拖动时被弹到 50%
   *     ——那样 sx/sy 会突跳，看起来就是"模型瞬间变扁"；框也允许移出画布（把模型平移到画面外是合法的）
   */
  function dragCrop(crop, mode, key, dx, dy, W, H, opts) {
    var o = opts || {};
    var minW = o.minW != null ? o.minW : W * 0.5;
    var minH = o.minH != null ? o.minH : H * 0.5;
    var clampToCanvas = o.clamp !== false;
    var r = { x: crop.x, y: crop.y, w: crop.w, h: crop.h };
    if (mode === 'move') {
      r.x += dx; r.y += dy;
    } else {
      var x0 = r.x, y0 = r.y, x1 = r.x + r.w, y1 = r.y + r.h;
      if (key.indexOf('w') >= 0) x0 += dx;
      if (key.indexOf('e') >= 0) x1 += dx;
      if (key.indexOf('n') >= 0) y0 += dy;
      if (key.indexOf('s') >= 0) y1 += dy;
      r.x = Math.min(x0, x1); r.y = Math.min(y0, y1);
      r.w = Math.abs(x1 - x0); r.h = Math.abs(y1 - y0);
    }
    r.w = Math.max(minW, r.w);
    r.h = Math.max(minH, r.h);
    if (clampToCanvas) {
      r.x = Math.max(0, Math.min(W - r.w, r.x));
      r.y = Math.max(0, Math.min(H - r.h, r.y));
    }
    return r;
  }

  function hitCropHandle(crop, px, py, W, H) {
    var best = null, bd = 14;
    cropHandles(crop, W, H).forEach(function (h) {
      var d = Math.hypot(h.x - px, h.y - py);
      if (d < bd) { bd = d; best = h.key; }
    });
    return best;
  }

  /**
   * 画一个箭头。style 支持三种画法：
   *   outline —— 先描一圈黑边再画彩色的（深色模式下受力箭头都用它，避免和背景糊在一起）
   *   hollow  —— 白心黑框的空心箭头（浅色模式下的"合力"，与教材画法一致）
   *   dash    —— 虚线（只在需要时用）
   */
  function arrow(ctx, view, x0, y0, dx, dy, color, width, label, withLabel, labelSlot, fontPx, style) {
    var st = style || {};
    var p0 = project(view, x0, y0);
    var p1 = project(view, x0 + dx, y0 + dy);
    var ax = p1[0] - p0[0], ay = p1[1] - p0[1];
    var len = Math.hypot(ax, ay);
    if (len < 2.5) return;
    var ux = ax / len, uy = ay / len;
    var head = Math.min(11, Math.max(5, len * 0.28));
    var w = width || 2.4;
    var outline = st.outline || null;
    // 选中（悬停/固定）的力：外发光 + 已加粗，配合变亮的颜色一眼可辨
    if (st.glow) { ctx.shadowColor = st.glow; ctx.shadowBlur = 9; }
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (st.dash) ctx.setLineDash(st.dash);

    function shaft(color2, lw) {
      ctx.strokeStyle = color2;
      ctx.lineWidth = lw;
      ctx.beginPath();
      ctx.moveTo(p0[0], p0[1]);
      ctx.lineTo(p1[0] - ux * head * 0.9, p1[1] - uy * head * 0.9);
      ctx.stroke();
    }
    function headPath() {
      ctx.beginPath();
      ctx.moveTo(p1[0], p1[1]);
      ctx.lineTo(p1[0] - ux * head + uy * head * 0.42, p1[1] - uy * head - ux * head * 0.42);
      ctx.lineTo(p1[0] - ux * head - uy * head * 0.42, p1[1] - uy * head + ux * head * 0.42);
      ctx.closePath();
    }
    function headShape(fill, stroke, lw) {
      headPath();
      if (fill) { ctx.fillStyle = fill; ctx.fill(); }
      if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = lw; ctx.stroke(); }
    }

    if (st.hollow) {
      // 空心箭头：白心黑框。先画黑色外框（线宽更大），再用白色覆盖内部
      shaft(outline || color, w + 3.4);
      headShape(outline || color, outline || color, 2.4);
      shaft('#ffffff', w);
      headShape('#ffffff', outline || color, Math.max(1.7, w * 0.75));
    } else {
      if (outline) {
        // 深色模式的薄黑边：整支箭头先用黑色画粗一点，再画彩色的盖在上面
        ctx.setLineDash(st.dash || []);
        shaft(outline, w + 2.6);
        headShape(outline, outline, 2.2);
        if (st.dash) ctx.setLineDash(st.dash);
      }
      shaft(color, w);
      headShape(color, null, 0);
    }
    ctx.setLineDash([]);

    if (label && withLabel !== false && len > 16) {
      ctx.font = '600 ' + (fontPx || 12) + 'px ' + FONT;
      ctx.textBaseline = 'middle';
      // 所有力都从重心出发，箭头尖端容易挤在一起 → 标签沿法向交替错开
      var slot = labelSlot || 0;
      var side = (slot % 2 === 0) ? 1 : -1;
      var off = side * (13 + Math.floor(slot / 2) * 15);
      var lx = p1[0] + ux * 7 + (-uy) * off;
      var ly = p1[1] + uy * 7 + ux * off;
      // 锚点落在箭头左侧时改成右对齐，让文字朝外长，否则还是会压到箭头/别的标签上
      ctx.textAlign = (lx < p1[0]) ? 'right' : 'left';
      ctx.lineWidth = 3;
      ctx.strokeStyle = THEME.labelHalo;
      ctx.strokeText(label, lx, ly);
      ctx.fillStyle = THEME.labelText || color;
      ctx.fillText(label, lx, ly);
    }
    ctx.restore();
  }

  function bodyPath(ctx, view, def, fb) {
    var x = fb.x, y = fb.y, ang = fb.angle || 0;
    var sh = def.shape;
    var ca = Math.cos(ang), sa = Math.sin(ang);
    function world(p) { return [x + p[0] * ca - p[1] * sa, y + p[0] * sa + p[1] * ca]; }
    ctx.beginPath();
    if (sh.kind === 'circle') {
      var c = project(view, x, y);
      // 小球在长距离场景（平抛、自由落体）里会只有几个像素，看不见。
      // 这里给一个最小屏幕半径（5 px）保证可见；真实几何仍在物理里，只有画面被放大。
      ctx.arc(c[0], c[1], Math.max(5, modelLen(view, sh.r * view.pxPerM)), 0, Math.PI * 2);
      return;
    }
    if (sh.kind === 'edge') {
      var aw = world(sh.a), bw = world(sh.b);
      var a = project(view, aw[0], aw[1]);
      var b = project(view, bw[0], bw[1]);
      ctx.moveTo(a[0], a[1]);
      ctx.lineTo(b[0], b[1]);
      return;
    }
    if (sh.kind === 'track') {
      var cc = project(view, x, y);
      ctx.arc(cc[0], cc[1], modelLen(view, sh.r * view.pxPerM), 0, Math.PI * 2);
      return;
    }
    var pts = sceneLib.shapePoints(sh) || [];
    var sp = [];
    for (var j = 0; j < pts.length; j++) sp.push(project(view, world(pts[j])[0], world(pts[j])[1]));
    // 最小可见尺寸：长距离场景里木板会被压成一条线（6.5m×0.3m 在 25px/m 下只有 7px 高），
    // 连"长方体"的形状都看不出来。这里对不足 10px 的方向做等比放大，
    // 只影响画面观感，物理量、接触点、受力都不变。
    var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (var q = 0; q < sp.length; q++) {
      if (sp[q][0] < minX) minX = sp[q][0];
      if (sp[q][0] > maxX) maxX = sp[q][0];
      if (sp[q][1] < minY) minY = sp[q][1];
      if (sp[q][1] > maxY) maxY = sp[q][1];
    }
    var MIN_DRAW = 10;
    var bw = maxX - minX, bh = maxY - minY;
    var ccx = (minX + maxX) / 2, ccy = (minY + maxY) / 2;
    var kx = bw < MIN_DRAW ? MIN_DRAW / Math.max(bw, 0.5) : 1;
    var ky = bh < MIN_DRAW ? MIN_DRAW / Math.max(bh, 0.5) : 1;
    for (var i2 = 0; i2 < sp.length; i2++) {
      var X = ccx + (sp[i2][0] - ccx) * kx;
      var Y = ccy + (sp[i2][1] - ccy) * ky;
      if (i2 === 0) ctx.moveTo(X, Y); else ctx.lineTo(X, Y);
    }
    ctx.closePath();
  }

  /** 传送带：画成带滚动纹路的输送面（带体本身在平移，纹理由位置相位决定） */
  function drawBelt(ctx, view, def, fb) {
    ctx.save();
    bodyPath(ctx, view, def, fb);
    ctx.fillStyle = THEME.beltFill;
    ctx.fill();
    ctx.restore();

    ctx.save();
    bodyPath(ctx, view, def, fb);
    ctx.clip();
    var pTop = project(view, fb.x, fb.y + def.shape.h / 2);
    var pBot = project(view, fb.x, fb.y - def.shape.h / 2);
    var pL = project(view, fb.x - def.shape.w / 2, fb.y);
    var pR = project(view, fb.x + def.shape.w / 2, fb.y);
    var spacing = Math.max(18, 0.5 * view.pxPerM);
    var phase = ((fb.x * view.pxPerM) % spacing + spacing) % spacing;
    ctx.strokeStyle = THEME.beltTread;
    ctx.lineWidth = 2;
    for (var x = pL[0] - spacing + phase; x < pR[0] + spacing; x += spacing) {
      ctx.beginPath();
      ctx.moveTo(x, pBot[1] - 3);
      ctx.lineTo(x + spacing * 0.42, (pTop[1] + pBot[1]) / 2);
      ctx.lineTo(x, pTop[1] + 3);
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawSpring(ctx, view, ax, ay, bx, by) {
    var n = 14;
    var dx = bx - ax, dy = by - ay;
    var len = Math.hypot(dx, dy);
    if (len < 1e-6) return;
    var ux = dx / len, uy = dy / len;
    var nx = -uy, ny = ux;
    var amp = Math.min(0.16, len * 0.08);
    ctx.save();
    ctx.strokeStyle = THEME.rodColor;
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (var i = 0; i <= n; i++) {
      var t = i / n;
      var off = (i === 0 || i === n) ? 0 : (i % 2 === 0 ? amp : -amp);
      var wx = ax + ux * len * t + nx * off;
      var wy = ay + uy * len * t + ny * off;
      var p = project(view, wx, wy);
      if (i === 0) ctx.moveTo(p[0], p[1]); else ctx.lineTo(p[0], p[1]);
    }
    ctx.stroke();
    ctx.restore();
  }

  function anchorPos(frame, ref, localAnchor, worldAnchor) {
    if (ref && ref !== 'world' && frame.bodies[ref]) {
      var fb = frame.bodies[ref];
      var ca = Math.cos(fb.angle || 0), sa = Math.sin(fb.angle || 0);
      var a = localAnchor || [0, 0];
      return [fb.x + a[0] * ca - a[1] * sa, fb.y + a[0] * sa + a[1] * ca];
    }
    return worldAnchor || null;
  }

  function drawJoints(ctx, view, scene, frame) {
    scene.joints.forEach(function (j) {
      if (j.kind === 'pulley') {
        var A = anchorPos(frame, j.a, null, j.worldAnchorA);
        var B = anchorPos(frame, j.b, null, j.worldAnchorB);
        var gA = j.groundAnchorA, gB = j.groundAnchorB;
        ctx.save();
        ctx.strokeStyle = THEME.ropeColor;
        ctx.lineWidth = 1.8;
        if (gA && gB) {
          // 两个地面锚点离得近时，画成一个真正的定滑轮：轮缘正好过两个锚点，
          // 绳从一侧竖直上来 → 沿轮缘绕过顶端 → 另一侧竖直下去。
          var pA = project(view, gA[0], gA[1]);
          var pB = project(view, gB[0], gB[1]);
          var rad = Math.hypot(pB[0] - pA[0], pB[1] - pA[1]) / 2;
          var midX = (pA[0] + pB[0]) / 2, midY = (pA[1] + pB[1]) / 2;
          if (rad <= 46) {
            ctx.beginPath();
            if (A) { var qa = project(view, A[0], A[1]); ctx.moveTo(qa[0], qa[1]); ctx.lineTo(pA[0], pA[1]); }
            ctx.arc(midX, midY, rad, Math.PI, Math.PI * 2);
            if (B) { var qb = project(view, B[0], B[1]); ctx.lineTo(pB[0], pB[1]); ctx.lineTo(qb[0], qb[1]); }
            ctx.stroke();
            ctx.beginPath();
            ctx.arc(midX, midY, rad, 0, Math.PI * 2);
            ctx.fillStyle = THEME.pulleyFill;
            ctx.fill();
            ctx.strokeStyle = THEME.pulleyStroke;
            ctx.lineWidth = 2;
            ctx.stroke();
            ctx.beginPath();
            ctx.arc(midX, midY, Math.max(3, rad * 0.16), 0, Math.PI * 2);
            ctx.fillStyle = '#8899bb';
            ctx.fill();
          } else {
            // 锚点相距很远（例如复滑轮），退化成两条独立绳段 + 两个小轮
            [[A, gA], [B, gB]].forEach(function (seg) {
              if (!seg[0] || !seg[1]) return;
              var q0 = project(view, seg[0][0], seg[0][1]);
              var q1 = project(view, seg[1][0], seg[1][1]);
              ctx.beginPath(); ctx.moveTo(q0[0], q0[1]); ctx.lineTo(q1[0], q1[1]); ctx.stroke();
            });
            [gA, gB].forEach(function (g) {
              var p = project(view, g[0], g[1]);
              ctx.beginPath(); ctx.arc(p[0], p[1], 11, 0, Math.PI * 2);
              ctx.fillStyle = THEME.pulleyFill; ctx.fill();
              ctx.strokeStyle = THEME.pulleyStroke; ctx.lineWidth = 2; ctx.stroke();
            });
          }
        }
        ctx.restore();
        return;
      }
      if (j.kind === 'rod' || j.kind === 'rope') {
        var a2 = anchorPos(frame, j.a, null, j.worldAnchorA);
        var b2 = anchorPos(frame, j.b, null, j.worldAnchorB);
        if (!a2 || !b2) return;
        ctx.save();
        ctx.strokeStyle = j.kind === 'rope' ? THEME.ropeColor : THEME.rodColor;
        ctx.lineWidth = 2;
        if (j.kind === 'rope') ctx.setLineDash([6, 4]);
        var q0 = project(view, a2[0], a2[1]);
        var q1 = project(view, b2[0], b2[1]);
        ctx.beginPath();
        ctx.moveTo(q0[0], q0[1]);
        ctx.lineTo(q1[0], q1[1]);
        ctx.stroke();
        ctx.restore();
        return;
      }
      if (j.kind === 'pivot' || j.kind === 'weld' || j.kind === 'slider') {
        var an = j.worldAnchor || j.anchor;
        if (!an) return;
        var p = project(view, an[0], an[1]);
        ctx.save();
        if (j.kind === 'slider') {
          var ang = (j.axisDeg || 0) * Math.PI / 180;
          var e0 = project(view, an[0] - Math.cos(ang) * 6, an[1] - Math.sin(ang) * 6);
          var e1 = project(view, an[0] + Math.cos(ang) * 6, an[1] + Math.sin(ang) * 6);
          ctx.strokeStyle = THEME.panelLine;
          ctx.setLineDash([5, 5]);
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.moveTo(e0[0], e0[1]);
          ctx.lineTo(e1[0], e1[1]);
          ctx.stroke();
          ctx.setLineDash([]);
        }
        ctx.fillStyle = THEME.jointFill;
        ctx.strokeStyle = THEME.jointStroke;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(p[0], p[1], 6, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.restore();
      }
    });

    scene.forces.forEach(function (f) {
      if (f.kind !== 'spring') return;
      var A = anchorPos(frame, f.a, f.anchorA, f.worldAnchorA);
      var B = anchorPos(frame, f.b, f.anchorB, f.worldAnchorB);
      if (A && B) drawSpring(ctx, view, A[0], A[1], B[0], B[1]);
    });
  }

  function render(ctx, view, frame, scene, options) {
    var opts = options || {};
    var layers = opts.layers || {};
    // 主题：dark（屏幕演示）/ light（白底、黑框空心、黑色箭头——教材/试卷风格）
    var T = setTheme(opts.theme || THEME.name);
    // 标注模式：full=力的名称+数值；value=只留数值（力和速度都变纯数字）；off=完全不画文字
    var labelMode = opts.labelMode || (layers.labels === false ? 'off' : 'full');
    var showLabels = labelMode !== 'off';
    var labelPx = opts.labelSize || (labelMode === 'value' ? 11 : 12);
    function forceText(k, m) {
      if (!showLabels) return null;
      var t = fmtForce(m);
      return labelMode === 'value' ? t : LABELS[k] + ' ' + t;
    }
    var W = view.width, H = view.height;

    ctx.clearRect(0, 0, W, H);
    if (T.name === 'light') {
      ctx.fillStyle = T.bg;
      ctx.fillRect(0, 0, W, H);
    } else {
      var grd = ctx.createLinearGradient(0, 0, 0, H);
      grd.addColorStop(0, T.bgTop);
      grd.addColorStop(1, view.background || T.bg);
      ctx.fillStyle = grd;
      ctx.fillRect(0, 0, W, H);
    }

    if (view.grid && layers.grid !== false) {
      // 网格只是装饰（图纸底纹）：间距固定为 48 像素，**不对应任何整数米**，
      // 所以它不承担比例尺功能；比例尺由图例里的"1 m 长度 = X N"和尺寸标注负责。
      // 线随内容一起平移（锚在世界原点），但间距永远是 48px。
      var pitchM = 48 / view.pxPerM;
      var gx0 = Math.floor((view.cx - W / 2 / view.pxPerM) / pitchM) * pitchM;
      var gx1 = view.cx + W / 2 / view.pxPerM;
      var gy0 = Math.floor((view.cy - H / 2 / view.pxPerM) / pitchM) * pitchM;
      var gy1 = view.cy + H / 2 / view.pxPerM;
      ctx.save();
      ctx.strokeStyle = T.grid;
      ctx.lineWidth = T.gridWidth;
      for (var gx = gx0; gx <= gx1; gx += pitchM) {
        var p = project(view, gx, 0);
        if (p[0] < -2 || p[0] > W + 2) continue;
        ctx.beginPath(); ctx.moveTo(p[0], 0); ctx.lineTo(p[0], H); ctx.stroke();
      }
      for (var gy = gy0; gy <= gy1; gy += pitchM) {
        var q = project(view, 0, gy);
        if (q[1] < -2 || q[1] > H + 2) continue;
        ctx.beginPath(); ctx.moveTo(0, q[1]); ctx.lineTo(W, q[1]); ctx.stroke();
      }
      ctx.restore();
    }

    if (layers.trail && opts.trailFrames && opts.trailFrames.length > 1) {
      ctx.save();
      ctx.strokeStyle = THEME.trail;
      ctx.lineWidth = 2;
      scene.bodies.forEach(function (b) {
        if (b.type !== 'dynamic') return;
        ctx.beginPath();
        var started = false;
        opts.trailFrames.forEach(function (f) {
          var fb = f.bodies[b.id];
          if (!fb) return;
          // 轨迹同样按显示放大绘制（否则放大后的物体"贴不上"自己的轨迹）
          var dp = displayPoint(displayFor(scene, b.id), fb);
          var sp = project(view, dp.x, dp.y);
          if (!started) { ctx.moveTo(sp[0], sp[1]); started = true; } else ctx.lineTo(sp[0], sp[1]);
        });
        ctx.stroke();
      });
      ctx.restore();
    }

    scene.bodies.forEach(function (def) {
      var fb = frame.bodies[def.id];
      if (!fb) return;
      if (def.isBelt) { drawBelt(ctx, view, def, fb); return; }
      if (def.overlay) return;               // 场可视化里的电荷：由 field.js 画（带 +/− 号）
      if (def.type === 'dynamic') return;
      ctx.save();
      bodyPath(ctx, view, def, fb);
      if (def.shape.kind === 'edge') {
        // 浅色主题下斜面/地面画成黑色实线（教材画法）
        ctx.strokeStyle = T.bodyHollow ? T.staticStroke : (def.color || '#3a4a63');
        ctx.lineWidth = T.edgeWidth;
        ctx.lineCap = 'round';
        ctx.stroke();
      } else if (def.shape.kind === 'track') {
        ctx.strokeStyle = T.bodyHollow ? T.staticStroke : (def.color || '#3a4a63');
        ctx.lineWidth = Math.max(3, modelLen(view, (def.shape.thickness || 0.12) * view.pxPerM));
        ctx.stroke();
      } else {
        ctx.fillStyle = T.bodyHollow ? T.staticFill : (def.color || '#3a4a63');
        ctx.globalAlpha = T.bodyHollow ? 1 : 0.9;
        ctx.fill();
        ctx.globalAlpha = 1;
        // 极板极性等标记：静态刚体自带 +/- 时画在中心（匀强电场的两块极板）
        if (def.sign) {
          var sp = [(fb.x - view.cx) * view.pxPerM + view.width / 2,
                    view.height / 2 - (fb.y - view.cy) * view.pxPerM];
          ctx.fillStyle = def.color === '#4da3ff' ? '#ffffff' : '#ffffff';
          ctx.font = '700 15px ' + FONT;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(def.sign, sp[0], sp[1]);
        }
        ctx.strokeStyle = T.bodyHollow ? T.staticStroke : T.staticStroke;
        ctx.lineWidth = T.bodyHollow ? T.staticWidth : 1.6;
        ctx.stroke();
      }
      ctx.restore();
    });

    // ---- 场可视化（静电场）：电场线 / 等势线画在物体之下，场强矢量画在物体之上 ----
    var fGeom = null;
    if (scene.field && fieldLib) {
      fGeom = opts.fieldGeom || fieldLib.compute(scene, { lines: true, equipotential: true });
      fieldLib.drawLines(ctx, view, fGeom, T.field, {
        lines: layers.fieldLines !== false, equipotential: layers.equipotential !== false
      });
    }

    drawJoints(ctx, view, scene, frame);

    scene.bodies.forEach(function (def) {
      if (def.type !== 'dynamic') return;
      var fb = frame.bodies[def.id];
      if (!fb) return;
      // 仅动态刚体的**位置**被显示放大（见 displayOf）；半径/线宽不放大，否则物体会涨成气球
      var dsp = displayFor(scene, def.id);
      var dview = dsp ? displayView(view, dsp.scaleY) : view;
      var dfb = dsp ? displayPoint(dsp, fb) : fb;
      ctx.save();
      bodyPath(ctx, dview, def, dfb);
      // 浅色主题：物体一律黑框空心（与教材、试卷一致）
      ctx.fillStyle = T.bodyHollow ? '#ffffff' : def.color;
      ctx.fill();
      ctx.strokeStyle = T.bodyStroke;
      ctx.lineWidth = T.bodyWidth;
      ctx.stroke();
      ctx.restore();
      // 不在画布上画刚体的汉字名字：遮挡太厉害。
      // 颜色 + 图例 + 右下角受力表已经能对应到具体刚体。
    });

    // ---- 电荷符号与场强矢量（画在物体之上，便于读数） ----
    if (scene.field && fieldLib) {
      fieldLib.drawCharges(ctx, view, (fGeom && fGeom.charges) || scene.field.charges, T.field, {
        values: showLabels, labels: true, selected: opts.selectedCharge, font: FONT
      });
      if (fGeom && fGeom.probes && fGeom.probes.length) {
        fieldLib.drawProbes(ctx, view, fGeom, T.field, { selectedProbe: opts.selectedProbe, font: FONT });
      }
    }

    // 尺寸标注（相对位移/板长）画在刚体之上、受力箭头之下
    if (layers.dims !== false) drawDimensions(ctx, view, scene, frame, labelMode);

    // 显示放大的说明文字（"过小就放大并标注"约定）：画在几何之上、箭头之下，
    // 保证"力箭头/速度箭头保持真实长度"这一条不会被说明文字盖住。
    drawDisplayNote(ctx, view, scene);

    // 箭头显示模式：forces=只画分力；total=只画合力；velocity=只画速度；all=全都画
    var arrowMode = opts.arrowMode || 'forces';
    var drawComponents = (arrowMode === 'forces' || arrowMode === 'all') && layers.forces !== false;
    var drawTotal = (arrowMode === 'total' || arrowMode === 'all') && layers.forces !== false;
    var drawVelocity = (arrowMode === 'velocity' || arrowMode === 'all') && layers.velocity !== false;

    if (drawVelocity && opts.velocityScale) {
      scene.bodies.forEach(function (def) {
        if (def.type !== 'dynamic') return;
        var fb = frame.bodies[def.id];
        if (!fb) return;
        var sp = Math.hypot(fb.vx, fb.vy);
        if (sp <= 1e-9) return;
        var vx = fb.vx * opts.velocityScale, vy = fb.vy * opts.velocityScale;
        var truePx = Math.hypot(vx, vy) * view.pxPerM;
        if (truePx < 2.5) return;
        // 速度箭头同样"过短就放大到可见"：否则低速阶段（例如刚起步）会整段看不到，
        // 这正是之前"速度矢量没显示出来"的原因之一——箭头按全程最大速率定标，
        // 起步阶段 0.1 m/s 的箭头不到 2px 就被跳过了。
        var drawPx = truePx;
        if (truePx < 22 && sp > 0.02 * view.maxSpeed) drawPx = 22;
        var kv = drawPx / truePx;
        var ux = vx / Math.hypot(vx, vy), uy = vy / Math.hypot(vx, vy);
        // 另一个原因：箭头从重心出发，会被物体本体盖住（7.8m 长的木板里画 16px 箭头＝看不见）。
        // 速度矢量改从物体边缘起画，保证露在物体外面；力箭头仍按要求画在重心。
        var bb = sceneLib.shapeBounds(def.shape);
        var halfDiag = Math.hypot(bb[1][0] - bb[0][0], bb[1][1] - bb[0][1]) / 2;
        var offM = Math.min(halfDiag * 0.85, (drawPx / view.pxPerM) * 0.45);
        // ⚠️ 显示放大只改"箭头的起点位置"（物体画在哪），**方向与长度仍是真实速度矢量**：
        // 起点用放大后的显示坐标，方向取真实速度方向，长度按真实速率定标（displayNote 注明）。
        var vdsp = displayFor(scene, def.id);
        var vAnchor = displayPoint(vdsp, fb);
        var sx = vAnchor.x + ux * offM, sy = vAnchor.y + uy * offM;
        var vtxt = !showLabels ? null
          : (labelMode === 'value' ? sp.toFixed(1) + 'm/s' : 'v ' + sp.toFixed(1) + ' m/s');
        // 速度就是普通箭头（不虚线、不空心），靠三选一的"显示：速度"和其它模式区分
        arrow(ctx, view, sx, sy, vx * kv, vy * kv, T.arrow.velocity, 2, vtxt, showLabels, 3, labelPx);
      });
    }

    if (drawComponents || drawTotal) {
      var fs = view.forceScale;
      var minPx = 5;   // 只要有一点点长度就画出来（配合数值标签），不再设高门槛把真实的力吞掉
      // 全部受力统一画在**重心**处：支持力与摩擦力用「该刚体受到的所有接触力的合力」，
      // 不再逐个接触点画（那样箭头藏在物块底下，看起来像"没有摩擦力"）。
      var order = ['gravity', 'gravitation', 'electric', 'normal', 'friction', 'joint', 'applied', 'damping'];
      arrowHits = [];                                  // 每次渲染重建命中区
      scene.bodies.forEach(function (def, bi) {
        if (def.showForces === false) return;
        if (def.type !== 'dynamic') return;
        var fb = frame.bodies[def.id];
        if (!fb) return;

        // 每个刚体用不同的标签槽位基数，避免两个刚体的同类力标签叠在一起
        var slotBase = bi * 9;
        var slot = 0;
        // 画一支分力（含悬停/固定时的"变亮变粗 + 提示框"）
        function drawOne(k, vec, mag, slotIdx) {
          var m = mag;
          var truePx = m * fs * view.pxPerM;
          if (truePx < 5) return;
          var drawPx = truePx;
          if (truePx < 14 && m > 0.02 * view.maxForce) drawPx = 14;
          var k2 = drawPx / truePx;
          var id = def.id + '|' + k;
          var hl = opts.hlArrows && opts.hlArrows[id];
          var tip = opts.tipArrows && opts.tipArrows[id];
          // 真实屏幕线段（长度按绘制像素算，命中区才和看到的箭头一致）
          var a0 = project(view, fb.x, fb.y);
          var ux = vec[0], uy = vec[1];
          var um = Math.hypot(ux, uy) || 1;
          var segLen = drawPx;
          var hit = { body: def.id, key: k, mag: m,
                      x0: a0[0], y0: a0[1],
                      x1: a0[0] + (ux / um) * segLen, y1: a0[1] - (uy / um) * segLen };
          arrowHits.push(hit);
          var col = T.arrow[k] || T.arrow.total;
          var wid = k === 'gravity' ? 2.8 : 2.4;
          var style = T.forceOutline ? { outline: T.forceOutline } : {};
          if (hl) {
            var hs = highlightStyle(col, wid, T);
            col = hs.color; wid = hs.width;
            style = { outline: T.forceOutline, glow: hs.glow, halo: hs.halo };
          }
          arrow(ctx, view, fb.x, fb.y, vec[0] * fs * k2, vec[1] * fs * k2, col, wid,
            forceText(k, m), showLabels, slotIdx, labelPx, style);
          if (tip) drawTipBox(ctx, view.width, view.height, hit.x1, hit.y1, tip, T);
          return hit;
        }
        if (drawComponents) {
          order.forEach(function (k) {
            var v = fb.forces[k];
            var m = Math.hypot(v[0], v[1]);
            if (m <= 1e-9) return;
            drawOne(k, v, m, slotBase + (slot++));
          });
        }

        if (drawTotal) {
          var tot = fb.forces.total;
          var tm = Math.hypot(tot[0], tot[1]);
          if (tm * fs * view.pxPerM >= 5) {
            // 合力跟分力一样是普通实心箭头，只把线宽加粗作为区分；
            // 悬停/固定时同样变亮变粗并弹提示框。
            var tid = def.id + '|total';
            var thl = opts.hlArrows && opts.hlArrows[tid];
            var ttip = opts.tipArrows && opts.tipArrows[tid];
            var ta0 = project(view, fb.x, fb.y);
            var tum = Math.hypot(tot[0], tot[1]) || 1;
            var tpx = Math.max(5, tm * fs * view.pxPerM);
            arrowHits.push({ body: def.id, key: 'total', mag: tm,
              x0: ta0[0], y0: ta0[1],
              x1: ta0[0] + (tot[0] / tum) * tpx, y1: ta0[1] - (tot[1] / tum) * tpx });
            var tcol = T.arrow.total, twid = 3.4;
            var tstyle = T.forceOutline ? { outline: T.forceOutline } : {};
            if (thl) {
              var ths = highlightStyle(T.arrow.total, 3.4, T);
              tcol = ths.color; twid = ths.width;
              tstyle = { outline: T.forceOutline, glow: ths.glow, halo: ths.halo };
            }
            var ttxt = !showLabels ? null
              : (labelMode === 'value' ? fmtForce(tm) : '合力 ' + fmtForce(tm));
            arrow(ctx, view, fb.x, fb.y, tot[0] * fs, tot[1] * fs, tcol, twid,
              ttxt, showLabels, slotBase + 5, labelPx, tstyle);
            if (ttip) {
              var th = arrowHits[arrowHits.length - 1];
              drawTipBox(ctx, view.width, view.height, th.x1, th.y1, ttip, T);
            }
          }
        }
      });
    }
  }

  /**
   * 显示放大（"过小就放大并标注"约定）——**只作用于物体位置与轨迹的绘制**。
   *
   * 为什么必须限定作用范围：纵向位移真实只有 1e-8 m 的题目，若不放大就整段贴在轴上、
   * 学生看不到"偏转"这件事；可一旦把力箭头/速度箭头也一起拉伸，箭头的方向与相对长度
   * 就都失真了 —— 那比看不见更糟（会教出错的受力图）。
   * 所以这里只给出"世界 y → 屏幕 y"的额外纵向缩放，力/速度箭头仍从真实几何算起，
   * 箭头本身按真实矢量绘制（见 render 里 drawVelocity / drawTotal 的位置处理）。
   * 数值标注（尺寸线、力标签）也因此仍读真实物理量。
   */
  function displayOf(scene) {
    var d = scene && scene.display;
    if (!d) return null;
    var sy = Number(d.scaleY);
    if (!isFinite(sy) || sy <= 1) return null;
    return { scaleY: sy, target: d.target || null, note: d.note || '', vertical: d.vertical !== false };
  }

  /** 作用在刚体 id 上的显示放大（target 为空表示作用于全部动态刚体） */
  function displayFor(scene, id) {
    var d = displayOf(scene);
    if (!d) return null;
    if (d.target && id && id !== d.target) return null;
    return d;
  }

  /**
   * 带显示放大的取景：**只额外平移一个 y 方向的像素偏移** —— 不动 pxPerM。
   *
   * ⚠️ 早先的实现是 `cx/pxPerM` 同改（Camera 变焦那一套），结果把"放大"做成了整体 zoom：
   * 物体半径、尺寸标注、力箭头全跟着涨，1e5 倍下整个画面被一团橙色糊满（实测截图先踩到）。
   * 现在只把"世界 y 被放大后的位置"映射到正确的屏幕 y：世界 y 处的物体画在
   * (y·sy) 处，两点之间的 y 间距因此被放大 sy 倍，而**像素尺度/线宽/半径保持 1:1**。
   */
  function displayView(view, sy) {
    var out = Object.create(view);
    out.yShiftPx = -view.cy * (sy - 1) * view.pxPerM;
    out.displayScaleY = sy;
    return out;
  }

  /** 刚体状态的显示坐标（未放大时原样返回，零开销） */
  function displayPoint(d, fb) {
    return d ? { x: fb.x, y: fb.y * d.scaleY } : fb;
  }

  /**
   * 画布上的放大说明（例如"纵向位移已放大 10⁵ 倍（图示，非真尺度）；真实量 v₀ = …"）。
   *
   * ⚠️ 位置：**左上角**。上一轮画在右上角，正好压在 `#force-panel`（`browser/template.html` 里
   * `position:absolute; top:20px; right:22px`）底下，截图里被裁掉 —— 说明文字被面板遮住，
   * 等于"过小就放大"这条约定失效。
   * 为什么左上角是安全的：左下角是力标尺图例（drawLegend），右上角是受力小窗，左上角空着。
   * 面板另有 top:20px / right:22px 的内缩，这里用 18px 的左边距 + 18px 的上边距，
   * 与右侧面板在水平方向上完全分离（面板宽度不会伸到画布左半区）。
   */
  function drawDisplayNote(ctx, view, scene) {
    var d = displayOf(scene);
    if (!d || !d.note) return;
    var lines = String(d.note).split('\n');
    ctx.save();
    ctx.font = '600 12px ' + FONT;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    var wMax = 0;
    lines.forEach(function (t) { wMax = Math.max(wMax, ctx.measureText(t).width); });
    var x = 18, y = 18;                 // 左上角：不与受力小窗（右上）、力标尺图例（左下）重叠
    var boxW = wMax + 22, boxH = lines.length * 17 + 14;
    ctx.fillStyle = THEME.panelBg;
    ctx.strokeStyle = THEME.dimHalo || 'rgba(255,255,255,0.25)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.rect(x, y, boxW, boxH);
    ctx.fill();
    ctx.stroke();
    lines.forEach(function (t, i) {
      ctx.fillStyle = i === 0 ? (THEME.text || '#e8eefc') : (THEME.dim || '#9fb3d1');
      ctx.fillText(t, x + 11, y + 8 + i * 17);
    });
    ctx.restore();
  }

  /** 尺寸锚点若挂在被显示放大的刚体上，返回放大后的锚点（读数另取真实坐标，见 drawDimensions） */
  function dimAnchorDisplay(scene, frame, bodyId, worldAnchor, A) {
    if (worldAnchor || !bodyId) return A;
    var d = displayFor(scene, bodyId);
    if (!d) return A;
    return [A[0], A[1] * d.scaleY];
  }

  /** 尺寸标注：把「相对位移 / 板长」这类几何量画成带箭头的尺寸线 + 实时数值。
   *  量相对位移时，两端各取「板左端」与「物块左面」的局部锚点，
   *  这样有限尺寸的物块不会把它自身的半宽算进读数里，与课本答案完全一致。 */
  function drawDimensions(ctx, view, scene, frame, labelMode) {
    var mode = labelMode || 'full';
    (scene.dimensions || []).forEach(function (d) {
      var A = anchorPos(frame, d.a, d.anchorA, d.worldAnchorA);
      var B = anchorPos(frame, d.b, d.anchorB, d.worldAnchorB);
      if (!A || !B) return;
      // 尺寸线两端若落在被放大的动态刚体上，锚点要跟着放大（否则"屏上偏移 Y"的尺寸线
      // 会从放大后的落点斜连回轴上的真实位置）；但**读数仍取未放大的真实坐标差**（见下）。
      var A0 = A, B0 = B;
      A = dimAnchorDisplay(scene, frame, d.a, d.worldAnchorA, A);
      B = dimAnchorDisplay(scene, frame, d.b, d.worldAnchorB, B);
      var off = d.offset || 0;
      var ax = d.axis || 'x';
      var a2 = [A[0], A[1] + off], b2 = [B[0], B[1] + off];
      if (ax === 'x') { b2[1] = a2[1]; } else if (ax === 'y') { b2[0] = a2[0]; }
      var p0 = project(view, a2[0], a2[1]);
      var p1 = project(view, b2[0], b2[1]);
      var spanPx = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
      var value = ax === 'x' ? Math.abs(B0[0] - A0[0]) : ax === 'y' ? Math.abs(B0[1] - A0[1])
        : Math.hypot(B0[0] - A0[0], B0[1] - A0[1]);
      ctx.save();
      ctx.strokeStyle = THEME.dimLine;
      ctx.fillStyle = THEME.dim;
      ctx.lineWidth = 1.4;
      // 相对位移刚开始时为 0，尺寸线短到没有意义：此时只显示数值，不画线
      if (spanPx >= 14) {
        ctx.setLineDash([5, 4]);
        var q0 = project(view, A[0], A[1]), q1 = project(view, B[0], B[1]);
        ctx.beginPath();
        ctx.moveTo(q0[0], q0[1]); ctx.lineTo(p0[0], p0[1]);
        ctx.moveTo(q1[0], q1[1]); ctx.lineTo(p1[0], p1[1]);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.beginPath(); ctx.moveTo(p0[0], p0[1]); ctx.lineTo(p1[0], p1[1]); ctx.stroke();
        arrow(ctx, view, b2[0], b2[1], a2[0] - b2[0], a2[1] - b2[1], THEME.dim, 1.4, null, false);
        arrow(ctx, view, a2[0], a2[1], b2[0] - a2[0], b2[1] - a2[1], THEME.dim, 1.4, null, false);
      }
      // 数值
      var mx = (p0[0] + p1[0]) / 2, my = (p0[1] + p1[1]) / 2;
      var text = mode === 'full' ? ((d.label ? d.label + ' = ' : '') + value.toFixed(2) + ' m')
        : mode === 'value' ? (value.toFixed(2) + 'm') : null;
      if (text) {
        ctx.font = '600 ' + (mode === 'value' ? 11 : 12) + 'px ' + FONT;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.lineWidth = 3;
        ctx.strokeStyle = THEME.dimHalo;
        ctx.strokeText(text, mx, my - 11);
        ctx.fillStyle = THEME.dim;
        ctx.fillText(text, mx, my - 11);
      }
      ctx.restore();
    });
  }

  /** 图例 + 力标尺 */
  function drawLegend(ctx, view) {
    var items = [
      ['gravity', '重力'], ['gravitation', '万有引力'], ['electric', '电场力'],
      ['normal', '支持力'], ['friction', '摩擦力'],
      ['joint', '绳/杆张力'], ['applied', '外力'], ['total', '合力']
    ];
    // 只列这道题真的出现过的力：受力分析一眼就知道有几个力在起作用
    if (view.presentForces) {
      items = items.filter(function (it) { return view.presentForces[it[0]]; });
      if (!items.length) return;
    }
    var x = 20, y = view.height - 16 - items.length * 15;
    ctx.save();
    var boxW = 170, boxH = items.length * 15 + 50;
    ctx.fillStyle = THEME.panelBg;
    ctx.strokeStyle = THEME.panelLine;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.rect(x - 10, y - 38, boxW, boxH);
    ctx.fill();
    ctx.stroke();
    ctx.font = '600 11px ' + FONT;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = THEME.text;
    // 力很小时（例如电场力只有 3 mN）"1 m = 0.0 N" 毫无信息量，按数量级换格式
    var nPerM = 1 / view.forceScale;
    var rulerTxt = nPerM >= 1 ? nPerM.toFixed(1)
      : nPerM >= 0.01 ? nPerM.toFixed(3) : nPerM.toExponential(1);
    ctx.fillText('力标尺：1 m = ' + rulerTxt + ' N', x, y - 24);
    ctx.font = '10px ' + FONT;
    ctx.fillStyle = THEME.textMuted;
    ctx.fillText('箭头按标尺；过短的力已放大', x, y - 10);
    ctx.fillStyle = THEME.text;
    items.forEach(function (it, i) {
      var yy = y + 8 + i * 15;
      ctx.strokeStyle = THEME.arrow[it[0]];
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(x, yy);
      ctx.lineTo(x + 20, yy);
      ctx.stroke();
      ctx.fillStyle = THEME.hudText;
      ctx.font = '11px ' + FONT;
      ctx.fillText(it[1], x + 27, yy);
    });
    ctx.restore();
  }

  /** 画布内的数据条：时刻、动量、机械能、受力残差 */
  function drawHud(ctx, view, frame) {
    var lines = [
      't = ' + frame.t.toFixed(2) + ' s',
      'p = (' + frame.stats.momentumX.toFixed(2) + ', ' + frame.stats.momentumY.toFixed(2) + ') kg·m/s',
      'E = ' + frame.stats.mechanical.toFixed(2) + ' J',
      '残差 = ' + (frame.stats.residualMax * 100).toFixed(3) + ' %'
    ];
    ctx.save();
    ctx.font = '11px ' + FONT;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    var W = view.width;
    ctx.fillStyle = THEME.hudBg;
    ctx.fillRect(W - 216, 10, 206, lines.length * 15 + 12);
    ctx.fillStyle = THEME.hudText;
    lines.forEach(function (l, i) { ctx.fillText(l, W - 20, 17 + i * 15); });
    ctx.restore();
  }

  /**
   * 受力小窗的布局：把分力在**以运动方向为 x 轴的坐标系**里做正交分解。
   *
   * axis = [x̂x, x̂y]：x 轴单位矢量（播放器按物体速度方向给），y 轴由它逆时针转 90°。
   * 返回 { items（含原始矢量与坐标轴内分量）、fit（窗口该多大）、axis, axisY }
   */
  var FB_KEYS = ['gravity', 'gravitation', 'electric', 'normal', 'friction', 'joint', 'applied', 'damping', 'total'];
  function freeBodyLayout(frame, bodyId, axis, opts) {
    var o = opts || {};
    var fb = frame && frame.bodies ? frame.bodies[bodyId] : null;
    if (!fb || !fb.forces) return null;
    // axis 可以是 [x̂] 或 [x̂, ŷ]；只给 x̂ 时 y 轴按数学惯例逆时针 90°
    var ax = (axis && axis[0]) ? axis[0] : [1, 0];
    var n = Math.hypot(ax[0], ax[1]) || 1;
    ax = [ax[0] / n, ax[1] / n];
    var ay = (axis && axis[1]) ? axis[1] : [-ax[1], ax[0]];
    var ny = Math.hypot(ay[0], ay[1]) || 1;
    ay = [ay[0] / ny, ay[1] / ny];
    var items = [];
    FB_KEYS.forEach(function (k) {
      var v = fb.forces[k];
      if (!v) return;
      var mag = Math.hypot(v[0], v[1]);
      if (mag <= 1e-12) return;
      items.push({
        key: k, vec: [v[0], v[1]], mag: mag,
        // 分量只用于定尺寸与画垂足，力的箭头本身仍按真实方向画
        comp: [v[0] * ax[0] + v[1] * ax[1], v[0] * ay[0] + v[1] * ay[1]]
      });
    });
    return { items: items, fit: freeBodySize(items, o.margin), axis: ax, axisY: ay };
  }

  function freeBodySize(items, margin) {
    // 边距要同时容纳"箭头头部的宽度""投影虚线"和"旁边的文字标签"，否则标签会被窗口边缘裁掉
    var m = margin != null ? margin : 52;
    var maxM = 0;
    items.forEach(function (it) { if (it.mag > maxM) maxM = it.mag; });
    if (!(maxM > 0)) return { w: 160, h: 120, pxPerN: 1 };
    // 窗口要装下：①各力箭头的真实端点 ②旋转后坐标轴的四个端点（负向也要）
    var spanX = 0, spanY = 0;      // 真实方向的跨度（决定窗口）
    var projX = 0, projY = 0;      // 沿两轴的分量跨度（决定轴画多长）
    items.forEach(function (it) {
      spanX = Math.max(spanX, Math.abs(it.vec[0]) / maxM);
      spanY = Math.max(spanY, Math.abs(it.vec[1]) / maxM);
      if (it.comp) {
        projX = Math.max(projX, Math.abs(it.comp[0]) / maxM);
        projY = Math.max(projY, Math.abs(it.comp[1]) / maxM);
      }
    });
    var REF = 74;                                    // 最长箭头约 74px（与画布上的力箭头同量级）
    return {
      // 宽度额外 +42：箭头旁的"名称+数值"标签挂在箭头右侧，不给够就会被窗口边缘裁掉
      w: Math.round(Math.max(160, spanX * REF * 2 + m * 2 + 42)),
      h: Math.round(Math.max(132, spanY * REF * 2 + m * 2)),
      // 坐标轴要伸出最长分量一点点，留出箭头与 x/y 标签的位置
      ax: Math.round(Math.max(projX * REF, 30) * 1.12),
      ay: Math.round(Math.max(projY * REF, 30) * 1.12),
      pxPerN: REF / maxM
    };
  }

  function drawFreeBody(ctx, W, H, layout, opts) {
    var o = opts || {};
    var T = THEME;
    ctx.setTransform(o.dpr || 1, 0, 0, o.dpr || 1, 0, 0);
    ctx.clearRect(0, 0, W, H);
    var items = (layout && layout.items) || [];
    if (!items.length) {
      ctx.fillStyle = T.textMuted;
      ctx.font = '12px ' + FONT;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('当前没有非零受力', W / 2, H / 2);
      return null;
    }
    var fit = (layout && layout.fit) || freeBodySize(items, o.margin);
    var pxPerN = fit.pxPerN;
    // 坐标系：**整系旋转**——坐标轴在屏幕上按 axis 的方向倾斜，力的箭头保持真实方向。
    var ax = (layout && layout.axis) || [1, 0];
    var ay = (layout && layout.axisY) || [-ax[1], ax[0]];

    // 内容包围盒 = 力的箭头端点 ∪ 两条坐标轴的端点（含负向），据此把内容居中
    var axLen = fit.ax || 60, ayLen = fit.ay || 60;
    var minX = 0, maxX = 0, minY = 0, maxY = 0;
    function acc(x, y) {
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
    items.forEach(function (it) { acc(it.vec[0] * pxPerN, it.vec[1] * pxPerN); });
    [[axLen, 0], [-axLen, 0]].forEach(function (t) { acc(t[0] * ax[0], t[0] * ax[1]); });
    [[ayLen, 0], [-ayLen, 0]].forEach(function (t) { acc(t[0] * ay[0], t[0] * ay[1]); });

    var fv = { cx: 0, cy: 0, pxPerM: 1, width: W, height: H };   // 虚拟视图：原点即窗口中心
    var ox = -(minX + maxX) / 2, oy = -(minY + maxY) / 2;
    var P = function (x, y) { return project(fv, ox + x, oy + y); };
    var O = P(0, 0);

    // ---- ① 坐标轴（细线，先画，保证力的图层在它上方）----
    ctx.save();
    ctx.lineWidth = 1;                       // 细一些，避免和力箭头抢视觉
    ctx.strokeStyle = T.axisLine || 'rgba(180,200,230,0.55)';
    ctx.fillStyle = ctx.strokeStyle;
    var heads = [
      [O, P(axLen * ax[0], axLen * ax[1]), 'x'], [O, P(-axLen * ax[0], -axLen * ax[1]), null],
      [O, P(ayLen * ay[0], ayLen * ay[1]), 'y'], [O, P(-ayLen * ay[0], -ayLen * ay[1]), null]
    ];
    heads.forEach(function (h) {
      var a = h[0], b = h[1];
      var dx = b[0] - a[0], dy = b[1] - a[1];
      var len = Math.hypot(dx, dy) || 1;
      var ux = dx / len, uy = dy / len;
      ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
      if (h[2]) {                            // 正方向端画个小箭头
        var hs = 5;
        ctx.beginPath();
        ctx.moveTo(b[0], b[1]);
        ctx.lineTo(b[0] - ux * hs + uy * hs * 0.5, b[1] - uy * hs - ux * hs * 0.5);
        ctx.lineTo(b[0] - ux * hs - uy * hs * 0.5, b[1] - uy * hs + ux * hs * 0.5);
        ctx.closePath(); ctx.fill();
        ctx.font = '600 11px ' + FONT;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(h[2], b[0] + ux * 10, b[1] + uy * 10);
      }
    });
    ctx.restore();

    // ---- ② 非轴上的力：从箭头尖端向两条轴作垂线（虚线）表示投影 ----
    ctx.save();
    ctx.setLineDash([3, 3]);
    ctx.lineWidth = 1;
    ctx.strokeStyle = T.projLine || 'rgba(150,175,210,0.5)';
    items.forEach(function (it) {
      if (it.key === 'total') return;         // 合力不画投影，避免和分力的投影叠在一起
      var fx = it.comp[0], fy = it.comp[1];
      if (Math.abs(fx) * pxPerN < 3 || Math.abs(fy) * pxPerN < 3) return;  // 已在某条轴上
      var tip = P(it.vec[0] * pxPerN, it.vec[1] * pxPerN);
      // 垂足：沿 x 轴的分量（保留 fx·x̂），沿 y 轴的分量（保留 fy·ŷ）
      var footX = P(fx * pxPerN * ax[0], fx * pxPerN * ax[1]);
      var footY = P(fy * pxPerN * ay[0], fy * pxPerN * ay[1]);
      ctx.beginPath(); ctx.moveTo(tip[0], tip[1]); ctx.lineTo(footX[0], footX[1]); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(tip[0], tip[1]); ctx.lineTo(footY[0], footY[1]); ctx.stroke();
    });
    ctx.restore();

    // ---- ③ 力的箭头（真实方向，画在最上层）----
    ctx.save();
    ctx.beginPath(); ctx.arc(O[0], O[1], 2.6, 0, Math.PI * 2);
    ctx.fillStyle = T.text; ctx.fill();
    var slot = 0;
    fpHits = [];                                   // 小窗的命中区，供 tooltip 用
    items.forEach(function (it) {
      var label = o.showLabels === false ? null
        : ((LABELS[it.key] || it.key) + ' ' + fmtForce(it.mag));
      var id = it.key;
      var hl = o.hlKeys && o.hlKeys[id];
      var tip = o.tipKeys && o.tipKeys[id];
      var col = T.arrow[it.key] || T.arrow.total;
      var wid = it.key === 'total' ? 2.8 : 2.4;
      var style = T.forceOutline ? { outline: T.forceOutline } : {};
      if (hl) {
        var hs = highlightStyle(col, wid, T);
        col = hs.color; wid = hs.width;
        style = { outline: T.forceOutline, glow: hs.glow, halo: hs.halo };
      }
      var tipP = P(it.vec[0] * pxPerN, it.vec[1] * pxPerN);
      fpHits.push({ key: it.key, mag: it.mag, x0: O[0], y0: O[1], x1: tipP[0], y1: tipP[1] });
      arrow(ctx, fv, ox, oy, it.vec[0] * pxPerN, it.vec[1] * pxPerN,
        col, wid, label, !!label, slot++, o.font || 11, style);
      if (tip) drawTipBox(ctx, W, H, tipP[0], tipP[1], tip, T);
    });
    ctx.restore();
    return fit;
  }

  /**
   * 力箭头的"命中区"与提示框。
   *
   * 渲染时把每个力箭头的屏幕线段记进 arrowHits / fpHits，
   * 鼠标事件因此可以问"我压到哪支箭头了"——就是桌面 tooltip 的做法。
   * 悬停显示 / 点击固定由播放器决定；这里只负责记录命中区、命中测试、画提示框。
   */
  var arrowHits = [];      // 主画布：[{body, key, x0, y0, x1, y1, mag}]
  var fpHits = [];         // 受力小窗：[{key, x0, y0, x1, y1, mag}]

  function segDist(px, py, x0, y0, x1, y1) {
    var dx = x1 - x0, dy = y1 - y0;
    var L2 = dx * dx + dy * dy;
    var t = L2 > 1e-9 ? ((px - x0) * dx + (py - y0) * dy) / L2 : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (x0 + t * dx), py - (y0 + t * dy));
  }
  function nearestHit(list, px, py, tol) {
    var best = null, bd = tol != null ? tol : 9;
    list.forEach(function (h) {
      var d = segDist(px, py, h.x0, h.y0, h.x1, h.y1);
      if (d <= bd) { bd = d; best = h; }
    });
    return best;
  }

  /** 提示框：圆角矩形 + 若干行文字，自动避开画布边界 */
  function drawTipBox(ctx, W, H, px, py, lines, theme) {
    if (!lines || !lines.length) return;
    var T = theme || THEME;
    var font = '11.5px ' + FONT;
    ctx.save();
    ctx.font = font;
    var wMax = 0;
    lines.forEach(function (t) { wMax = Math.max(wMax, ctx.measureText(t).width); });
    var padX = 9, padY = 7, lh = 16;
    var bw = wMax + padX * 2, bh = lines.length * lh + padY * 2 - 3;
    var bx = px + 14, by = py - bh - 8;
    if (bx + bw > W - 6) bx = px - bw - 14;
    if (bx < 6) bx = 6;
    if (by < 6) by = py + 14;
    if (by + bh > H - 6) by = H - 6 - bh;
    ctx.fillStyle = T.tipBg || 'rgba(10,16,26,0.94)';
    ctx.strokeStyle = T.tipLine || 'rgba(255,255,255,0.28)';
    ctx.lineWidth = 1;
    var r = 7;
    ctx.beginPath();
    ctx.moveTo(bx + r, by);
    ctx.lineTo(bx + bw - r, by); ctx.quadraticCurveTo(bx + bw, by, bx + bw, by + r);
    ctx.lineTo(bx + bw, by + bh - r); ctx.quadraticCurveTo(bx + bw, by + bh, bx + bw - r, by + bh);
    ctx.lineTo(bx + r, by + bh); ctx.quadraticCurveTo(bx, by + bh, bx, by + bh - r);
    ctx.lineTo(bx, by + r); ctx.quadraticCurveTo(bx, by, bx + r, by);
    ctx.closePath();
    ctx.fill(); ctx.stroke();
    ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    lines.forEach(function (t, i) {
      ctx.fillStyle = i === 0 ? (T.tipTitle || T.text) : (T.tipText || T.textMuted);
      ctx.font = i === 0 ? ('600 12px ' + FONT) : font;
      ctx.fillText(t, bx + padX, by + padY + i * lh);
    });
    ctx.restore();
  }

  /** 选中样式：两种主题各用各的做法 */
  function highlightStyle(baseColor, width, theme) {
    var T = theme || THEME;
    if (T.name === 'light') {
      // 浅色模式下力本来就是黑的：不做提亮（会变灰），也不加任何发光/高亮带
      // （黑箭头衬天蓝底很丑）。**只加粗**就够醒目了，配合提示框完全够用。
      return { color: baseColor, width: width * 1.85 };
    }
    return { color: mixWhite(baseColor, 0.45), width: width * 1.9, glow: baseColor };
  }
  function mixWhite(c, k) {
    var m = /^#([0-9a-f]{6})$/i.exec(c || '');
    if (!m) return c;
    var n = parseInt(m[1], 16);
    var r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    r = Math.round(r + (255 - r) * k);
    g = Math.round(g + (255 - g) * k);
    b = Math.round(b + (255 - b) * k);
    return 'rgb(' + r + ',' + g + ',' + b + ')';
  }

  return {
    COLORS: COLORS, LABELS: LABELS, setFont: setFont,
    setTheme: setTheme, currentTheme: currentTheme, THEMES: THEMES,
    makeView: makeView, project: project, unproject: unproject, render: render,
    cropView: cropView, drawCropFrame: drawCropFrame, dragCrop: dragCrop,
    hitCropHandle: hitCropHandle, cropHandles: cropHandles,
    drawLegend: drawLegend, drawHud: drawHud, arrow: arrow,
    drawFreeBody: drawFreeBody, freeBodySize: freeBodySize, freeBodyLayout: freeBodyLayout,
    hitArrows: function (px, py, tol) { return nearestHit(arrowHits, px, py, tol); },
    hitFreeBody: function (px, py, tol) { return nearestHit(fpHits, px, py, tol); },
    drawTipBox: drawTipBox, highlightStyle: highlightStyle
  };
});
