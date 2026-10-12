/*!
 * MrAwU（阿物先生）— lib/graph.js
 * 画布下方的 x-t / v-t 图像：两个图共用一条平铺在最下方的时间轴，
 * 并带一个剪辑软件风格的「播放头 / 当前时间指示器」（可拖动定位）。
 * 有明显临界时刻的模型（板块/传送带到共速、碰撞瞬间、落地…）会在时间轴上把轴断开一点，
 * 鼠标移到断开处会弹出该临界时刻的物理说明。
 * 浏览器与 Node 共用。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.PFA = root.PFA || {};
    root.PFA.graph = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var FONT = 'system-ui, "Microsoft YaHei", "PingFang SC", sans-serif';
  var FORCE_ORDER = ['gravity', 'gravitation', 'electric', 'normal', 'friction', 'joint', 'applied', 'damping', 'total'];
var PAD_L = 56, PAD_R = 16, PAD_T = 12, PAD_B = 26, GAP = 14;
  var AXIS_H = 22;                 // 时间轴带的高度
  var BREAK_HALF = 5;              // 时间轴断开处的半宽（px）
  var HIT_PX = 11;                 // 鼠标离断开处多近算命中

  /** 每个刚体取哪个分量画图：横向运动为主就画 x，竖向为主就画 y */
  function axisOf(frames, bodyId) {
    var rx = 0, ry = 0, minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    frames.forEach(function (f) {
      var b = f.bodies[bodyId];
      if (!b) return;
      if (b.x < minX) minX = b.x;
      if (b.x > maxX) maxX = b.x;
      if (b.y < minY) minY = b.y;
      if (b.y > maxY) maxY = b.y;
    });
    rx = maxX - minX;
    ry = maxY - minY;
    return ry > rx * 1.5 ? 'y' : 'x';
  }

  function series(frames, bodyId, axis) {
    return frames.map(function (f) {
      var b = f.bodies[bodyId];
      if (!b) return null;
      return {
        t: f.t,
        p: axis === 'y' ? b.y : b.x,
        v: axis === 'y' ? b.vy : b.vx
      };
    }).filter(Boolean);
  }

  /** 计算布局：两个绘图区 + 最下方的时间轴带 */
  function layout(width, height, tMax, scene) {
    var axisY = height - PAD_B - AXIS_H;              // 时间轴横线所在 y
    var plotTop = PAD_T;
    var usable = axisY - plotTop - GAP;
    var paneH = Math.max(38, usable / 2);
    var plotX = PAD_L, plotW = Math.max(60, width - PAD_L - PAD_R);
    return {
      width: width, height: height,
      plotX: plotX, plotW: plotW, plotRight: plotX + plotW,
      xPane: { top: plotTop, bottom: plotTop + paneH, height: paneH },
      vPane: { top: plotTop + paneH + GAP, bottom: plotTop + paneH + GAP + paneH, height: paneH },
      axisY: axisY,
      axisBand: { top: axisY - 14, bottom: axisY + 18 },
      tMax: tMax,
      t2x: function (t) { return plotX + (tMax > 0 ? (t / tMax) * plotW : 0); },
      x2t: function (px) {
        var t = ((px - plotX) / plotW) * tMax;
        return Math.max(0, Math.min(tMax, t));
      }
    };
  }

  function fmt(v) {
    var a = Math.abs(v);
    if (a >= 100) return v.toFixed(0);
    if (a >= 10) return v.toFixed(1);
    return v.toFixed(a >= 1 ? 1 : 2);
  }

  /** 一组数据的上下界（带 8% 余量，且保证不退化成一个点） */
  function rangeOf(all) {
    var lo = Infinity, hi = -Infinity;
    all.forEach(function (s) {
      s.forEach(function (d) {
        if (d.p < lo) lo = d.p;
        if (d.p > hi) hi = d.p;
      });
    });
    if (!isFinite(lo)) { lo = 0; hi = 1; }
    if (hi - lo < 1e-6) { lo -= 0.5; hi += 0.5; }
    var pad = (hi - lo) * 0.1;
    return [lo - pad, hi + pad];
  }

  function rangeV(all) {
    var lo = Infinity, hi = -Infinity;
    all.forEach(function (s) {
      s.forEach(function (d) {
        if (d.v < lo) lo = d.v;
        if (d.v > hi) hi = d.v;
      });
    });
    if (!isFinite(lo)) { lo = -1; hi = 1; }
    // 让 0 一定在范围内，v-t 图才能看出正负
    lo = Math.min(lo, 0); hi = Math.max(hi, 0);
    if (hi - lo < 1e-6) { lo -= 0.5; hi += 0.5; }
    var pad = (hi - lo) * 0.1;
    return [lo - pad, hi + pad];
  }

  function mapY(v, r, pane) {
    return pane.bottom - ((v - r[0]) / (r[1] - r[0])) * pane.height;
  }

  /** 画一个纵向的数值轴 + 水平网格 */
  function yAxis(ctx, T, L, pane, r, unit, title) {
    ctx.save();
    ctx.strokeStyle = T.axis;
    ctx.lineWidth = 1;
    ctx.font = '10px ' + FONT;
    ctx.fillStyle = T.textMuted;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    var ticks = 3;
    for (var i = 0; i <= ticks; i++) {
      var v = r[0] + (r[1] - r[0]) * (i / ticks);
      var y = mapY(v, r, pane);
      ctx.globalAlpha = 0.45;
      ctx.beginPath();
      ctx.moveTo(L.plotX, y);
      ctx.lineTo(L.plotRight, y);
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.fillText(fmt(v), L.plotX - 6, y);
    }
    ctx.textAlign = 'left';
    ctx.font = '600 10.5px ' + FONT;
    ctx.fillStyle = T.text;
    ctx.fillText(title + '（' + unit + '）', 4, pane.top + 6);
    ctx.restore();
  }

  /**
   * 主绘制。
   * opts: { width, height, frames, scene, tNow, theme, seriesColors, hoverT }
   */
  function draw(ctx, opts) {
    var T = opts.theme;
    var frames = opts.frames || [];
    if (!frames.length) return null;
    var scene = opts.scene;
    var tMax = frames[frames.length - 1].t || 1;
    var L = layout(opts.width, opts.height, tMax, scene);

    ctx.save();
    ctx.clearRect(0, 0, L.width, L.height);
    ctx.fillStyle = T.bg;
    ctx.fillRect(0, 0, L.width, L.height);

    // 参与绘图的刚体
    var defs = scene.bodies.filter(function (b) {
      return b.type === 'dynamic' && frames[frames.length - 1].bodies[b.id];
    });
    var data = defs.map(function (d, i) {
      var ax = axisOf(frames, d.id);
      return { def: d, axis: ax, s: series(frames, d.id, ax), color: (opts.seriesColors || [])[i % 3] || '#888' };
    });
    var rP = rangeOf(data.map(function (d) { return d.s; }));
    var rV = rangeV(data.map(function (d) { return d.s; }));

    // 两个绘图区的边框
    [L.xPane, L.vPane].forEach(function (p) {
      ctx.strokeStyle = T.panelLine;
      ctx.lineWidth = 1;
      ctx.strokeRect(L.plotX + 0.5, p.top + 0.5, L.plotW - 1, p.height - 1);
    });

    var unitP = data[0] && data[0].axis === 'y' ? 'm' : 'm';
    yAxis(ctx, T, L, L.xPane, rP, unitP, (data[0] && data[0].axis === 'y' ? 'y-t 图像' : 'x-t 图像'));
    yAxis(ctx, T, L, L.vPane, rV, 'm/s', 'v-t 图像');

    // 临界时刻：贯穿两图的虚线
    var markers = (scene.markers || []).filter(function (m) { return m.t >= 0 && m.t <= tMax * 1.001; });
    markers.forEach(function (m) {
      var x = L.t2x(m.t);
      ctx.save();
      ctx.strokeStyle = T.mark;
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 4]);
      ctx.beginPath();
      ctx.moveTo(x, L.xPane.top);
      ctx.lineTo(x, L.vPane.bottom);
      ctx.stroke();
      ctx.restore();
    });

    // 曲线
    data.forEach(function (d) {
      ctx.save();
      ctx.strokeStyle = d.color;
      ctx.lineWidth = 2;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      d.s.forEach(function (pt, i) {
        var x = L.t2x(pt.t);
        var y = mapY(pt.p, rP, L.xPane);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.stroke();
      // v-t
      ctx.beginPath();
      d.s.forEach(function (pt, i) {
        var x = L.t2x(pt.t);
        var y = mapY(pt.v, rV, L.vPane);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.stroke();
      ctx.restore();
    });

    // 曲线末端的名字（比图例省地方）
    ctx.save();
    ctx.font = '600 10.5px ' + FONT;
    ctx.textBaseline = 'middle';
    data.forEach(function (d, i) {
      var last = d.s[d.s.length - 1];
      if (!last) return;
      var x = L.t2x(last.t), y = mapY(last.p, rP, L.xPane);
      ctx.fillStyle = d.color;
      ctx.textAlign = 'right';
      ctx.fillText(d.def.label || d.def.id, Math.min(x - 4, L.plotRight - 2), Math.max(L.xPane.top + 7, y - 8));
    });
    ctx.restore();

    // ---- 时间轴（平铺在最下方，两个图共用） ----
    ctx.save();
    ctx.strokeStyle = T.axis;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    var breaks = markers.slice().sort(function (a, b) { return a.t - b.t; });
    var cursor = L.plotX;
    breaks.forEach(function (m) {
      var x = L.t2x(m.t);
      var a = Math.max(cursor, x - BREAK_HALF), b = Math.min(L.plotRight, x + BREAK_HALF);
      if (a > cursor) { ctx.moveTo(cursor, L.axisY); ctx.lineTo(a, L.axisY); }
      // 断开处：两小段斜向的断裂标记，像被"剪开"一样
      ctx.moveTo(a, L.axisY);
      ctx.lineTo(a + 3, L.axisY - 4);
      ctx.moveTo(b, L.axisY);
      ctx.lineTo(b - 3, L.axisY - 4);
      cursor = b;
    });
    if (cursor < L.plotRight) { ctx.moveTo(cursor, L.axisY); ctx.lineTo(L.plotRight, L.axisY); }
    ctx.stroke();

    // 刻度
    ctx.font = '10.5px ' + FONT;
    ctx.fillStyle = T.textMuted;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    var stepT = niceStep(tMax / 6);
    for (var t = 0; t <= tMax + 1e-9; t += stepT) {
      var xt = L.t2x(t);
      var okBreak = breaks.every(function (m) { return Math.abs(L.t2x(m.t) - xt) > BREAK_HALF + 8; });
      if (!okBreak) continue;
      ctx.strokeStyle = T.axis;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(xt, L.axisY);
      ctx.lineTo(xt, L.axisY + 4);
      ctx.stroke();
      ctx.fillText(fmt(t) + 's', xt, L.axisY + 7);
    }
    ctx.restore();

    // ---- 每个断开处的标签 ----
    markers.forEach(function (m) {
      var x = L.t2x(m.t);
      ctx.save();
      ctx.font = '600 10px ' + FONT;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillStyle = T.markText;
      ctx.fillText(m.label || '临界', x, L.axisY - 6);
      ctx.restore();
    });

    // ---- 播放头 / 当前时间指示器 ----
    var xNow = L.t2x(opts.tNow || 0);
    ctx.save();
    ctx.strokeStyle = T.playhead;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(xNow, L.xPane.top - 4);
    ctx.lineTo(xNow, L.axisY + 6);
    ctx.stroke();
    // 顶部小三角（剪辑软件播放头样式）
    ctx.fillStyle = T.playhead;
    ctx.beginPath();
    ctx.moveTo(xNow - 6, L.xPane.top - 12);
    ctx.lineTo(xNow + 6, L.xPane.top - 12);
    ctx.lineTo(xNow, L.xPane.top - 3);
    ctx.closePath();
    ctx.fill();
    // 底部手柄 + 当前时刻
    ctx.beginPath();
    ctx.moveTo(xNow - 5, L.axisY + 6);
    ctx.lineTo(xNow + 5, L.axisY + 6);
    ctx.lineTo(xNow + 5, L.axisY + 13);
    ctx.lineTo(xNow - 5, L.axisY + 13);
    ctx.closePath();
    ctx.fill();
    var lab = (opts.tNow || 0).toFixed(2) + 's';
    ctx.font = '700 10.5px ' + FONT;
    var tw = ctx.measureText(lab).width;
    var bx = Math.max(L.plotX, Math.min(xNow - tw / 2 - 4, L.plotRight - tw - 8));
    ctx.fillStyle = T.playhead;
    ctx.fillRect(bx, L.axisY + 15, tw + 8, 13);
    ctx.fillStyle = T.playheadText;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(lab, bx + 4, L.axisY + 22);
    ctx.restore();

    // 当前帧读数：在每个图里点一个点
    ctx.save();
    data.forEach(function (d) {
      var pt = null, best = 1e9;
      d.s.forEach(function (q) { var dd = Math.abs(q.t - (opts.tNow || 0)); if (dd < best) { best = dd; pt = q; } });
      if (!pt) return;
      ctx.fillStyle = d.color;
      var ys = [mapY(pt.p, rP, L.xPane), mapY(pt.v, rV, L.vPane)];
      ys.forEach(function (yy) {
        ctx.beginPath();
        ctx.arc(L.t2x(pt.t), yy, 3.2, 0, Math.PI * 2);
        ctx.fill();
      });
    });
    ctx.restore();

    return { layout: L, markers: markers, ranges: { p: rP, v: rV }, data: data };
  }

  function niceStep(raw) {
    var p = Math.pow(10, Math.floor(Math.log(raw) / Math.LN10));
    var n = raw / p;
    var m = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
    return m * p;
  }

  /**
   * 命中测试：鼠标是否落在时间轴的某个"断开处"上。
   * 返回 { marker, index } 或 null。
   */
  function hitMarker(L, markers, mx, my) {
    if (!markers || !markers.length) return null;
    var inBand = my >= L.axisBand.top && my <= L.axisBand.bottom;
    if (!inBand) return null;
    var best = null, bestD = 1e9;
    markers.forEach(function (m) {
      var d = Math.abs(L.t2x(m.t) - mx);
      if (d < bestD) { bestD = d; best = m; }
    });
    if (best && bestD <= HIT_PX) return best;
    return null;
  }

  function forceName(k) {
    return ({ gravity: '重力', gravitation: '万有引力', electric: '电场力', normal: '支持力',
      friction: '摩擦力', joint: '绳/杆张力', applied: '外力', damping: '阻尼', total: '合力' })[k] || k;
  }

  return {
    draw: draw, layout: layout, hitMarker: hitMarker, axisOf: axisOf, series: series,
    forceName: forceName, FORCE_ORDER: FORCE_ORDER,
    PAD_L: PAD_L, PAD_R: PAD_R, AXIS_H: AXIS_H
  };
});
