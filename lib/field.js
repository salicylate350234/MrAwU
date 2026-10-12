/*!
 * MrAwU（阿物先生）— lib/field.js
 * 静电场可视化：点电荷系的电场线、等势线、场点场强矢量。
 *
 * 为什么单独一个模块：静电场没有动力学（电荷静止），
 * 它的"物理"全在 E(r) = Σ k qᵢ (r−rᵢ)/|r−rᵢ|³ 与 V(r) = Σ k qᵢ/|r−rᵢ| 里，
 * 所以这一层只做"场 → 几何"，画出来的东西与引擎无关。
 *
 * 三个可选项互相独立，可任意组合：
 *   lines        电场线（从每个正电荷出发、终止于负电荷或边界）
 *   equipotential 等势线（对 V 做 marching squares）
 *   vectors      场点的场强矢量（网格箭矢，长度按 log 压缩，颜色示意强弱）
 * 因为电场线沿 E、等势线垂直于 E，两套线天然正交——这本身就是一个可视化的正确性判据。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.PFA = root.PFA || {};
    root.PFA.field = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /** 电场与电势：charges = [{x, y, q}]，q 单位为 μC，k 单位 N·m²/C²（配合 μC 时 E 的单位是 kV/m 量级） */
  function fieldAt(charges, x, y, k) {
    var ex = 0, ey = 0, v = 0;
    for (var i = 0; i < charges.length; i++) {
      var c = charges[i];
      var dx = x - c.x, dy = y - c.y;
      var r2 = dx * dx + dy * dy;
      if (r2 < 1e-9) continue;
      var r = Math.sqrt(r2);
      var f = k * c.q / (r2 * r);
      ex += f * dx; ey += f * dy;
      v += k * c.q / r;
    }
    return { ex: ex, ey: ey, v: v, mag: Math.hypot(ex, ey) };
  }

  /** 计算域（默认）：把电荷包围盒往外扩 60%，只在拿不到取景信息时兜底 */
  function domain(charges, pad) {
    if (!charges.length) return { xmin: -2, ymin: -2, xmax: 2, ymax: 2 };
    var xmin = Infinity, ymin = Infinity, xmax = -Infinity, ymax = -Infinity;
    charges.forEach(function (c) {
      xmin = Math.min(xmin, c.x); xmax = Math.max(xmax, c.x);
      ymin = Math.min(ymin, c.y); ymax = Math.max(ymax, c.y);
    });
    var w = Math.max(xmax - xmin, 0.6), h = Math.max(ymax - ymin, 0.6);
    var p = pad != null ? pad : 0.6;
    return {
      xmin: xmin - w * p, xmax: xmax + w * p,
      ymin: ymin - h * p, ymax: ymax + h * p
    };
  }

  /**
   * 取景对应的世界矩形（再往外留 8% 余量）。
   * 电场线应当**一直画到画布边缘**，而不是画到一个围绕电荷的小矩形里——
   * 后者就是"场线突然消失、围成一个突兀方框"的原因。
   */
  function viewDomain(view, margin) {
    var m = margin != null ? margin : 0.08;
    var w = view.width / view.pxPerM, h = view.height / view.pxPerM;
    var xmin = view.cx - w / 2 - w * m, xmax = view.cx + w / 2 + w * m;
    var ymin = view.cy - h / 2 - h * m, ymax = view.cy + h / 2 + h * m;
    // 模型被缩放/平移时，画布对应的世界范围要按**逆变换**折算；
    // 否则模型放大后场线只覆盖原范围，边缘会缺一块。
    var mt = view.mt;
    if (mt && mt.sx && mt.sy) {
      var x0 = (xmin - mt.cx - mt.tx) / mt.sx + mt.cx;
      var x1 = (xmax - mt.cx - mt.tx) / mt.sx + mt.cx;
      var y0 = (ymin - mt.cy - mt.ty) / mt.sy + mt.cy;
      var y1 = (ymax - mt.cy - mt.ty) / mt.sy + mt.cy;
      xmin = Math.min(x0, x1); xmax = Math.max(x0, x1);
      ymin = Math.min(y0, y1); ymax = Math.max(y0, y1);
    }
    return { xmin: xmin, xmax: xmax, ymin: ymin, ymax: ymax };
  }

  /**
   * 电场线：正电荷向外、负电荷向内。
   *
   * 平滑度是这里的关键：固定步长在电荷附近会明显折线（曲率大、步长显得太粗）。
   * 所以用**自适应步长的 RK4**——步长按"到最近电荷的距离"缩放，
   * 靠近电荷时自动细化、远处自动放大，任何电荷间距下线条都光滑。
   */
  function traceLines(charges, k, opt) {
    var o = opt || {};
    var dom = o.domain || domain(charges);
    var span = Math.max(dom.xmax - dom.xmin, dom.ymax - dom.ymin);
    var hMax = span * (o.stepFrac != null ? o.stepFrac : 0.012);
    var hMin = hMax / 12;
    var maxSteps = o.maxSteps || 2600;
    var qmax = Math.max.apply(null, charges.map(function (c) { return Math.abs(c.q); }).concat([1e-9]));
    var out = [];

    function nearest(x, y) {
      var d = Infinity;
      for (var i = 0; i < charges.length; i++) {
        var dd = Math.hypot(x - charges[i].x, y - charges[i].y);
        if (dd < d) d = dd;
      }
      return d;
    }
    function unit(x, y, dir) {
      var f = fieldAt(charges, x, y, k);
      if (!(f.mag > 1e-12)) return null;
      return [dir * f.ex / f.mag, dir * f.ey / f.mag];
    }
    function rk4(x, y, h, dir) {
      var a = unit(x, y, dir); if (!a) return null;
      var b = unit(x + a[0] * h / 2, y + a[1] * h / 2, dir); if (!b) return null;
      var c = unit(x + b[0] * h / 2, y + b[1] * h / 2, dir); if (!c) return null;
      var d = unit(x + c[0] * h, y + c[1] * h, dir); if (!d) return null;
      return [x + h * (a[0] + 2 * b[0] + 2 * c[0] + d[0]) / 6,
              y + h * (a[1] + 2 * b[1] + 2 * c[1] + d[1]) / 6];
    }

    charges.forEach(function (c) {
      if (Math.abs(c.q) < 1e-9) return;
      // 线数与电荷量成正比（等量电荷就得到等量线数，符合教材图）
      var n = Math.max(4, Math.min(24, Math.round(10 * Math.abs(c.q) / qmax)));
      var dir = c.q > 0 ? 1 : -1;                    // 正电荷沿 +E，负电荷反向追踪
      var r0 = hMin * 1.5;
      for (var i = 0; i < n; i++) {
        var ang = 2 * Math.PI * (i + 0.5) / n;
        var x = c.x + r0 * Math.cos(ang), y = c.y + r0 * Math.sin(ang);
        var pts = [{ x: x, y: y }];
        for (var s = 0; s < maxSteps; s++) {
          var h = Math.max(hMin, Math.min(hMax, 0.5 * nearest(x, y)));
          var nx = rk4(x, y, h, dir);
          if (!nx) break;
          x = nx[0]; y = nx[1];
          pts.push({ x: x, y: y });
          if (x < dom.xmin || x > dom.xmax || y < dom.ymin || y > dom.ymax) break;
          var hit = false;
          for (var j = 0; j < charges.length; j++) {
            var o2 = charges[j];
            if (o2 === c || o2.q * c.q > 0) continue;
            if (Math.hypot(x - o2.x, y - o2.y) < hMin * 3) { hit = true; break; }
          }
          if (hit) break;
        }
        if (pts.length > 2) out.push(pts);
      }
    });
    return out;
  }

  /**
   * 等势线：对 V 做 marching squares。
   * 等势值取几何级数（±V₀·2ⁿ），这样既画出贴近电荷的密集小圈，
   * 也画出远处的稀疏大圈，视觉上能直接看出"等势面越密场越强"。
   */
  function traceContours(charges, k, opt) {
    var o = opt || {};
    var dom = o.domain || domain(charges);
    var nx = o.nx || 96, ny = o.ny || 72;
    var qmax = Math.max.apply(null, charges.map(function (c) { return Math.abs(c.q); }).concat([1e-9]));
    var dmin = Math.min(dom.xmax - dom.xmin, dom.ymax - dom.ymin);
    var v0 = k * qmax / Math.max(0.25, dmin * 0.18);
    var levels = [];
    [0.25, 0.5, 1, 2, 4, 8].forEach(function (m) { levels.push(v0 * m); levels.push(-v0 * m); });

    var dx = (dom.xmax - dom.xmin) / nx, dy = (dom.ymax - dom.ymin) / ny;
    var V = [];
    for (var j = 0; j <= ny; j++) {
      V[j] = [];
      for (var i = 0; i <= nx; i++) {
        V[j][i] = fieldAt(charges, dom.xmin + i * dx, dom.ymin + j * dy, k).v;
      }
    }
    var segs = [];
    levels.forEach(function (lv) {
      for (var j = 0; j < ny; j++) {
        for (var i = 0; i < nx; i++) {
          var x0 = dom.xmin + i * dx, y0 = dom.ymin + j * dy;
          var a = V[j][i], b = V[j][i + 1], c = V[j + 1][i + 1], d = V[j + 1][i];
          var pts = [];
          function ip(v1, v2, p1, p2) {
            var t = (lv - v1) / (v2 - v1);
            return [p1[0] + t * (p2[0] - p1[0]), p1[1] + t * (p2[1] - p1[1])];
          }
          var P00 = [x0, y0], P10 = [x0 + dx, y0], P11 = [x0 + dx, y0 + dy], P01 = [x0, y0 + dy];
          if ((a - lv) * (b - lv) < 0) pts.push(ip(a, b, P00, P10));
          if ((b - lv) * (c - lv) < 0) pts.push(ip(b, c, P10, P11));
          if ((c - lv) * (d - lv) < 0) pts.push(ip(c, d, P11, P01));
          if ((d - lv) * (a - lv) < 0) pts.push(ip(d, a, P01, P00));
          if (pts.length === 2) segs.push({ lv: lv, a: pts[0], b: pts[1] });
          else if (pts.length === 4) {
            // 鞍点：连两段
            segs.push({ lv: lv, a: pts[0], b: pts[1] });
            segs.push({ lv: lv, a: pts[2], b: pts[3] });
          }
        }
      }
    });
    return { segs: segs, levels: levels, dom: dom, v0: v0 };
  }

  /**
   * 场点：在指定位置算出场强矢量，并按"之前力的表示方式"画成箭矢 + 数值。
   * 参考长度取所有场点场强的 95% 分位（避免个别点贴到电荷上把其它箭头压得看不见）。
   */
  function probeVectors(charges, k, probes) {
    var pts = (probes || []).map(function (p) {
      return { x: p.x, y: p.y, e: fieldAt(charges, p.x, p.y, k) };
    });
    var mags = pts.map(function (p) { return p.e.mag; }).sort(function (a, b) { return a - b; });
    var ref = mags.length ? mags[Math.min(mags.length - 1, Math.floor(mags.length * 0.95))] : 1;
    if (!(ref > 0)) ref = 1;
    return { pts: pts, ref: ref };
  }

  /** 一次算好所有几何（电荷变动时才需要重算，绘制时可以复用） */
  function compute(scene, opts) {
    var o = opts || {};
    var spec = scene.field || {};
    var charges = spec.charges || [];
    var k = spec.k != null ? spec.k : 9e9;
    if (!charges.length) {
      // 匀强场没有点电荷：这里也必须照常给出平行场线（早先直接返回，导致匀强场一条线都不画）
      var r0 = {
        charges: charges, k: k, dom: domain(charges), uniform: spec.uniform || null,
        lines: [], contours: { segs: [] }, probes: spec.probes || []
      };
      if (spec.uniform) r0.lines = uniformLines(spec, {});
      // uniforms：多段匀强场（组合模组里加速区与偏转区各有各的场，要分别画）
      if (spec.uniforms) {
        spec.uniforms.forEach(function (u) { r0.lines = r0.lines.concat(uniformLines({ uniform: u }, {})); });
      }
      return r0;
    }
    var dom = o.domain || domain(charges, spec.pad);
    var res = { charges: charges, k: k, dom: dom, uniform: spec.uniform || null };
    if (spec.uniform) {
      // 匀强场：不追踪，直接画一排平行线（不依赖取景，稳）
      res.lines = uniformLines(spec, { count: spec.uniform.count });
    } else if (o.lines !== false) {
      res.lines = traceLines(charges, k, { domain: dom, step: spec.lineStep, maxSteps: spec.lineSteps });
    }
    if (o.equipotential !== false) res.contours = traceContours(charges, k, { domain: dom, nx: spec.gridX, ny: spec.gridY });
    res.probes = spec.probes || [];
    return res;
  }

  /**
   * 匀强电场的场线：与 E 平行的等间距直线，方向由 + 板指向 − 板。
   * region = {x0,x1,y0,y1}（两板之间的区域），e = [ex,ey]（场强方向）。
   * 这就是教材上"两板之间画一排平行带箭头直线"的画法。
   */
  function uniformLines(spec, opts) {
    var u = spec.uniform;
    if (!u) return [];
    var ex = u.ex, ey = u.ey;
    var mag = Math.hypot(ex, ey);
    if (!(mag > 0)) return [];
    var ux = ex / mag, uy = ey / mag;
    var px = -uy, py = ux;                       // 垂直方向
    var corners = [[u.x0, u.y0], [u.x1, u.y0], [u.x1, u.y1], [u.x0, u.y1]];
    var tmin = Infinity, tmax = -Infinity, smin = Infinity, smax = -Infinity;
    corners.forEach(function (c) {
      var t = c[0] * ux + c[1] * uy, s = c[0] * px + c[1] * py;
      if (t < tmin) tmin = t; if (t > tmax) tmax = t;
      if (s < smin) smin = s; if (s > smax) smax = s;
    });
    var span = smax - smin;
    if (!(span > 0)) return [];
    var n = (opts && opts.count) || u.count || Math.max(4, Math.min(12, Math.round(span / 0.055)));
    var t0 = tmin + (tmax - tmin) * 0.02, t1 = tmax - (tmax - tmin) * 0.02;
    var out = [];
    for (var i = 0; i < n; i++) {
      var s = smin + span * (i + 0.5) / n;
      out.push([
        { x: ux * t0 + px * s, y: uy * t0 + py * s },
        { x: ux * t1 + px * s, y: uy * t1 + py * s }
      ]);
    }
    return out;
  }

  /**
   * 在折线上按等弧长插箭头（屏幕像素间距），方向沿走线方向。
   * 静电场原来只有线、没有箭头，"往哪边指"全靠读者自己判断；加上箭头才算真正画出方向。
   */
  function lineArrows(ctx, view, pts, color, spacingPx, size) {
    if (!pts || pts.length < 2) return;
    var sp = spacingPx || 76, sz = size || 7;
    var screen = pts.map(function (p) { return proj(view, p.x, p.y); });
    var acc = sp * 0.55;                          // 起点附近也放一个，别让近处没有箭头
    for (var i = 1; i < screen.length; i++) {
      var ax = screen[i - 1][0], ay = screen[i - 1][1];
      var bx = screen[i][0], by = screen[i][1];
      var seg = Math.hypot(bx - ax, by - ay);
      if (seg < 1e-6) continue;
      var ux = (bx - ax) / seg, uy = (by - ay) / seg;
      while (acc <= seg) {
        var cx = ax + ux * acc, cy = ay + uy * acc;
        ctx.beginPath();
        ctx.moveTo(cx - ux * sz + uy * sz * 0.5, cy - uy * sz - ux * sz * 0.5);
        ctx.lineTo(cx + ux * sz * 0.7, cy + uy * sz * 0.7);
        ctx.lineTo(cx - ux * sz - uy * sz * 0.5, cy - uy * sz + ux * sz * 0.5);
        ctx.closePath();
        ctx.fillStyle = color;
        ctx.fill();
        acc += sp;
      }
      acc -= seg;
    }
  }

  /** 画电场线（含箭头）+ 等势线（画在物体之下，避免盖住电荷） */
  function drawLines(ctx, view, geom, theme, opts) {
    var o = opts || {};
    ctx.save();
    if (o.equipotential !== false && geom.contours) {
      ctx.strokeStyle = theme.equi;
      ctx.lineWidth = 1;
      ctx.beginPath();
      geom.contours.segs.forEach(function (s) {
        var p = proj(view, s.a[0], s.a[1]), q = proj(view, s.b[0], s.b[1]);
        ctx.moveTo(p[0], p[1]); ctx.lineTo(q[0], q[1]);
      });
      ctx.stroke();
    }
    if (o.lines !== false && geom.lines) {
      ctx.strokeStyle = theme.line;
      ctx.lineWidth = 1.4;
      geom.lines.forEach(function (pts) {
        ctx.beginPath();
        pts.forEach(function (pt, i) {
          var p = proj(view, pt.x, pt.y);
          if (i === 0) ctx.moveTo(p[0], p[1]); else ctx.lineTo(p[0], p[1]);
        });
        ctx.stroke();
      });
      if (o.arrows !== false) {
        var sp = o.arrowSpacing || 76;
        geom.lines.forEach(function (pts) {
          lineArrows(ctx, view, pts, theme.arrow || theme.line, sp, o.arrowSize);
        });
      }
    }
    ctx.restore();
  }

  function proj(view, x, y) {
    // 与 draw.project 一致：先过模型变换（view.mt），再过相机
    var mt = view.mt;
    if (mt) {
      x = (x - mt.cx) * mt.sx + mt.cx + mt.tx;
      y = (y - mt.cy) * mt.sy + mt.cy + mt.ty;
    }
    return [
      (x - view.cx) * view.pxPerM + view.width / 2,
      view.height / 2 - (y - view.cy) * view.pxPerM
    ];
  }

  /**
   * 画场点：小十字标记 + 场强箭矢 + 数值。
   * "和之前力的表示一样"——箭矢从场点出发、长度正比于 |E|（按参考值定标），
   * 旁边标出大小（带描边保证任何底色上都看得清）。
   */
  function drawProbes(ctx, view, geom, theme, opts) {
    var o = opts || {};
    var probes = geom.probes || [];
    if (!probes.length) return null;
    var pv = probeVectors(geom.charges, geom.k, probes);
    var ARROW_PX = Math.max(56, Math.min(view.width, view.height) * 0.15);
    var pxPerM = view.pxPerM;
    var refLen = ARROW_PX / pxPerM / pv.ref;          // 米/（N/C）：参考场强对应 ARROW_PX 像素
    ctx.save();
    pv.pts.forEach(function (p, i) {
      var p0 = proj(view, p.x, p.y);
      // 场点标记
      ctx.strokeStyle = theme.probe;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(p0[0] - 5, p0[1]); ctx.lineTo(p0[0] + 5, p0[1]);
      ctx.moveTo(p0[0], p0[1] - 5); ctx.lineTo(p0[0], p0[1] + 5);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(p0[0], p0[1], 3, 0, Math.PI * 2);
      ctx.fillStyle = theme.probe;
      ctx.fill();
      if (o.selectedProbe === i) {
        ctx.strokeStyle = theme.select;
        ctx.setLineDash([5, 4]);
        ctx.beginPath(); ctx.arc(p0[0], p0[1], 10, 0, Math.PI * 2); ctx.stroke();
        ctx.setLineDash([]);
      }
      var mag = p.e.mag;
      if (!(mag > 0)) {
        label(ctx, 'E = 0', p0[0], p0[1] - 10, theme);
        return;
      }
      var len = Math.max(16, mag * refLen * pxPerM);   // 过短的场强也放大到可见
      var ux = p.e.ex / mag, uy = p.e.ey / mag;
      var p1 = [p0[0] + ux * len, p0[1] - uy * len];
      ctx.strokeStyle = theme.probe;
      ctx.fillStyle = theme.probe;
      ctx.lineWidth = 2.4;
      ctx.beginPath(); ctx.moveTo(p0[0], p0[1]); ctx.lineTo(p1[0], p1[1]); ctx.stroke();
      var head = Math.max(6, Math.min(11, len * 0.3));
      ctx.beginPath();
      ctx.moveTo(p1[0], p1[1]);
      ctx.lineTo(p1[0] - ux * head - uy * head * 0.42, p1[1] + uy * head - ux * head * 0.42);
      ctx.lineTo(p1[0] - ux * head + uy * head * 0.42, p1[1] + uy * head + ux * head * 0.42);
      ctx.closePath();
      ctx.fill();
      label(ctx, 'E ' + fmtE(mag) + ' N/C', p1[0] + ux * 6, p1[1] - uy * 6 - 8, theme);
    });
    ctx.restore();
    return pv;
  }

  function label(ctx, txt, x, y, theme) {
    ctx.font = '600 11px system-ui, "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 3;
    ctx.strokeStyle = theme.halo;
    ctx.strokeText(txt, x, y);
    ctx.fillStyle = theme.probeText || theme.probe;
    ctx.fillText(txt, x, y);
  }

  /** 命中测试：场点（屏幕像素） */
  function hitProbe(view, probes, px, py) {
    for (var i = (probes || []).length - 1; i >= 0; i--) {
      var p = proj(view, probes[i].x, probes[i].y);
      if (Math.hypot(p[0] - px, p[1] - py) <= 14) return i;
    }
    return -1;
  }

  function fmtE(v) {
    if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M';
    if (v >= 1e3) return (v / 1e3).toFixed(1) + 'k';
    if (v >= 1) return v.toFixed(0);
    return v.toPrecision(2);
  }

  /** 在电荷上标出 +/− 与电量 */
  function drawCharges(ctx, view, charges, theme, opts) {
    var o = opts || {};
    ctx.save();
    charges.forEach(function (c, i) {
      var p = proj(view, c.x, c.y);
      // 电荷画成固定屏幕尺寸（12~20 px）：按 pxPerM 等比会被放大成占满屏幕的大圆
      var r = Math.max(12, Math.min(20, 0.03 * view.pxPerM));
      var pos = c.q > 0;
      ctx.beginPath();
      ctx.arc(p[0], p[1], r, 0, Math.PI * 2);
      ctx.fillStyle = pos ? theme.positive : theme.negative;
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = theme.chargeEdge;
      ctx.stroke();
      // +/− 号
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = Math.max(2, r * 0.22);
      ctx.beginPath();
      ctx.moveTo(p[0] - r * 0.5, p[1]); ctx.lineTo(p[0] + r * 0.5, p[1]);
      if (pos) { ctx.moveTo(p[0], p[1] - r * 0.5); ctx.lineTo(p[0], p[1] + r * 0.5); }
      ctx.stroke();
      if (o.values !== false && o.labels !== false) {
        var txt = (pos ? '+' : '') + c.q + 'μC';
        ctx.font = '600 11px ' + (o.font || 'system-ui, sans-serif');
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.lineWidth = 3;
        ctx.strokeStyle = theme.halo;
        ctx.strokeText(txt, p[0], p[1] - r - 3);
        ctx.fillStyle = theme.text;
        ctx.fillText(txt, p[0], p[1] - r - 3);
      }
      // 选中高亮
      if (o.selected === i) {
        ctx.strokeStyle = theme.select;
        ctx.lineWidth = 2.5;
        ctx.setLineDash([5, 4]);
        ctx.beginPath();
        ctx.arc(p[0], p[1], r + 6, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    });
    ctx.restore();
  }

  /** 命中测试：点到了第几个电荷（屏幕像素） */
  function hitCharge(view, charges, px, py) {
    for (var i = charges.length - 1; i >= 0; i--) {
      var p = proj(view, charges[i].x, charges[i].y);
      if (Math.hypot(p[0] - px, p[1] - py) <= Math.max(16, Math.min(26, 0.03 * view.pxPerM + 6))) return i;
    }
    return -1;
  }

  return {
    fieldAt: fieldAt, domain: domain, viewDomain: viewDomain, compute: compute,
    traceLines: traceLines, traceContours: traceContours, probeVectors: probeVectors,
    drawLines: drawLines, drawProbes: drawProbes, drawCharges: drawCharges,
    uniformLines: uniformLines, lineArrows: lineArrows,
    hitCharge: hitCharge, hitProbe: hitProbe, proj: proj, fmtE: fmtE
  };
});
