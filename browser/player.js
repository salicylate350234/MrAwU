/*!
 * MrAwU（阿物先生）— browser/player.js
 * 浏览器端播放器：全部计算都在本机浏览器里完成（planck 已内联），不需要 node、不需要联网。
 * 与 node 端共用 lib/ 下的同一份代码：场景装配、受力分解、渲染器完全一致。
 */
(function (root) {
  'use strict';
  var PFA = root.PFA = root.PFA || {};

  var state = {
    modelId: null,
    params: {},
    scene: null,
    frames: null,
    view: null,
    verify: [],
    index: 0,
    playing: false,
    speed: 1,
    loop: true,
    velocityScale: 1,
    lastTs: 0,
    acc: 0,
    layers: { forces: true, velocity: true, grid: true, trail: true, legend: true, hud: true, dims: true },
    // 箭头显示：分力 / 合力 / 速度 三选一（一次只显示一种，画面最干净）
    arrowMode: 'forces',     // forces | total | velocity
    labelMode: 'full',       // full | value | off
    labelSize: 12,
    theme: 'dark',           // dark | light（白底、黑框空心、黑色箭头——教材/试卷风格）
    // 框选缩放：crop 用画布 CSS 像素记录，null = 不缩放
    cropEdit: false, cropDrag: null,
    // 模型变换（模型自己的 position/scale）与屏幕上的控制框；相机不受影响
    modelTransform: null, modelBox: null,
    // 受力小窗：折叠 / 隐藏 / 当前对象
    fpCollapsed: false, fpHidden: false, fpBody: null,
    // 力箭头交互：hover = {scope,body,key}；pinned = { 'body|key': true }
    hover: null, pinned: {},
    // 静电场：手动编辑过的电荷列表 + 场几何缓存 + 显示开关
    fieldCharges: null, fieldProbes: [], fieldGeom: null, selCharge: -1, selProbe: -1, selKind: null,
    fieldOpts: { lines: true, equipotential: true, vectors: true, values: false },
    selected: null,
    error: null,
    // x-t / v-t 图相关
    graphInfo: null, tipPinned: false, tipShown: null
  };

  var els = {};

  function $(id) { return document.getElementById(id); }

  function fmt(v, d) {
    if (v == null || !isFinite(v)) return '—';
    return Number(v).toFixed(d == null ? 2 : d);
  }

  // ------------------------------------------------------------------ 计算

  /**
   * 引擎选择：
   *   - 构建时用 --engine verlet 指定轻量版 → 全用自研 Verlet；
   *   - 否则模型只要声明了 laws 就用 Verlet（不含 planck 的构建里也没有别的选择）；
   *   - 其余情况回落到 planck。
   */
  function pickEngine(scene) {
    var forced = (typeof window !== 'undefined' && window.PFA_ENGINE) || null;
    if (forced === 'verlet') return 'verlet';
    if (!scene.laws) return 'planck';
    return PFA.verlet ? 'verlet' : 'planck';
  }

  /**
   * 取景：
   *  · 静电场这类"场可视化"模型**锁定取景**——拖动电荷时画面不跟着重新取景，
   *    否则每拖一下整个坐标系都在缩放平移，根本没法摆电荷。
   *    只有换模型/换预设/点"重新取景"时才重新适配。
   *  · 其他模型照旧按轨迹自动适配。
   */
  function computeView(scene, refit) {
    var fitted = PFA.draw.makeView(state.frames, scene);
    if (!scene.field) { state.pinnedView = null; return fitted; }
    if (refit || !state.pinnedView) {
      state.pinnedView = { cx: fitted.cx, cy: fitted.cy, pxPerM: fitted.pxPerM };
    }
    return PFA.draw.makeView(state.frames, scene, {
      cx: state.pinnedView.cx, cy: state.pinnedView.cy, pxPerM: state.pinnedView.pxPerM
    });
  }

  function bake(keepTime, refit) {
    var model = PFA.models.get(state.modelId);
    if (!model) { state.error = '未知模型: ' + state.modelId; renderPanels(); return; }
    var frac = 1;
    if (keepTime && state.frames && state.frames.length > 1) {
      frac = state.index / (state.frames.length - 1);
    }
    try {
      // 静电场：把手动编辑过的电荷列表传进场景（否则用参数里的题目预设）
      var extra = (state.fieldCharges && state.fieldCharges.length)
        ? { charges: state.fieldCharges, probes: state.fieldProbes } : null;
      var scene = PFA.models.scene(state.modelId, state.params, PFA.scene, extra);
      var problems = PFA.scene.validate(scene);
      if (!problems.ok) throw new Error(problems.errors.join('；'));
      scene.view.width = els.canvas.clientWidth || 1000;
      scene.view.height = els.canvas.clientHeight || 560;
      var sim = PFA.sim.createSim(root.planck, scene, { engine: pickEngine(scene) });
      var result = sim.record();
      state.scene = scene;
      state.frames = result.frames;
      state.view = computeView(scene, !!refit);
      state.verify = (typeof model.expect === 'function') ? PFA.verify.run(model, state.params, state.frames, state.scene) : [];
      // 场可视化：点电荷静电场才需要同步电荷列表（拖动时编辑的就是它）；
      // 匀强场（加速/偏转电场）只有场线，没有可编辑电荷。
      if (scene.field && scene.field.charges) {
        if (!state.fieldCharges) {
          state.fieldCharges = scene.field.charges.map(function (c) { return { x: c.x, y: c.y, q: c.q }; });
        }
        state.fieldGeom = null;
      } else {
        state.fieldCharges = null; state.fieldGeom = null; state.fieldProbes = [];
        state.selCharge = -1; state.selProbe = -1; state.selKind = null;
      }
      // 换模型/重算后原来的固定选中可能不再存在，清掉
      if (state.scene.modelId !== state._lastModelId) { state.pinned = {}; state.hover = null; state._lastModelId = state.scene.modelId; }
      if (els.fieldBar) els.fieldBar.style.display = (scene.field && scene.field.charges) ? '' : 'none';
      var fcard = document.getElementById('card-field');
      if (fcard) fcard.style.display = (scene.field && scene.field.charges) ? '' : 'none';
      if (state.refreshFieldPanel) state.refreshFieldPanel();
      var maxV = 0.5;
      state.frames.forEach(function (f) {
        scene.bodies.forEach(function (b) {
          if (b.type !== 'dynamic') return;
          var fb = f.bodies[b.id];
          if (!fb) return;
          maxV = Math.max(maxV, Math.hypot(fb.vx, fb.vy));
        });
      });
      // 速度箭头按"最长约 1.8 m"定标：原来按 1.0 m 定标时，起步阶段速度很小，
      // 箭头不足 2px 被跳过 → 看起来"速度矢量根本没显示"。
      state.velocityScale = 1.8 / maxV;
      state.error = null;
      var n = state.frames.length - 1;
      state.index = Math.max(0, Math.min(n, Math.round(frac * n)));
      if (!state.selected || !state.scene.bodies.some(function (b) { return b.id === state.selected; })) {
        var first = state.scene.bodies.filter(function (b) { return b.type === 'dynamic'; })[0];
        state.selected = first ? first.id : null;
      }
    } catch (e) {
      state.error = (e && e.message) || String(e);
      state.frames = null;
      state.scene = null;
    }
    renderPanels();
    renderParams();
    draw();
  }

  // ------------------------------------------------------------------ 绘制

  /**
   * 右上角"受力小窗"：把选中物体受到的各个分力**平移到同一个作用点**画成受力图。
   *
   * 与原"数据条"的区别：数据条只报数，这里把力本身画出来，而且窗口尺寸随内容自适应
   * （包围盒 + 标签余量），所以"刚好装下"，不会在画布上占一大块。
   * 多物体模型（板块等）先在窗口里选对象。
   */
  function drawForcePanel(frame) {
    var fp = els.forcePanel, cv = els.fpCanvas;
    if (!fp || !cv || !frame || !state.scene) return;
    if (state.fpHidden) { fp.classList.add('hidden'); return; }
    fp.classList.remove('hidden');

    // 可分析的物体：受力可见的动态刚体
    var dyn = state.scene.bodies.filter(function (b) {
      return b.type === 'dynamic' && b.showForces !== false && frame.bodies[b.id];
    });
    if (!dyn.length) { fp.classList.add('hidden'); return; }
    if (!state.fpBody || !dyn.some(function (b) { return b.id === state.fpBody; })) {
      // 默认选"合力最大"的那个（通常是主动运动的主体）
      var best = dyn[0], bm = -1;
      dyn.forEach(function (b) {
        var f = frame.bodies[b.id].forces.total || [0, 0];
        var m = Math.hypot(f[0], f[1]);
        if (m > bm) { bm = m; best = b; }
      });
      state.fpBody = best.id;
      syncBodySelect(dyn, state.fpBody);
    } else {
      syncBodySelect(dyn, state.fpBody);
    }

    var fb = frame.bodies[state.fpBody];
    // 坐标系：x 轴正方向 = 物体**运动方向**。
    // 当前速度为零时（起步/最高点/停下）向前找最近的非零速度——那才是它"要往哪走"；
    // 实在找不到就退回世界 x 轴。
    var ax = motionAxis(state.fpBody, frame);
    var layout = PFA.draw.freeBodyLayout(frame, state.fpBody, ax, {});
    if (!layout) { fp.classList.add('hidden'); return; }
    var W = layout.fit.w, H = layout.fit.h;
    var dpr = Math.min(3, Math.max(2, window.devicePixelRatio || 1));
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) {
      cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    }
    cv.style.width = W + 'px'; cv.style.height = H + 'px';
    els.fpCtx = els.fpCtx || cv.getContext('2d');
    PFA.draw.drawFreeBody(els.fpCtx, W, H, layout, {
      dpr: dpr,
      hlKeys: fpHighlight(state.fpBody),
      tipKeys: fpTips(state.fpBody, layout)
    });
  }

  // ---- 力箭头的悬停 / 固定（画布与小窗都支持）----
  function arrowId(body, key) { return body + '|' + key; }
  function isPinned(body, key) { return !!state.pinned[arrowId(body, key)]; }
  function isHot(body, key) {
    return isPinned(body, key) ||
      (state.hover && state.hover.body === body && state.hover.key === key);
  }
  /** 主画布的高亮集合（hover + 已固定） */
  function hlArrows() {
    var out = {};
    Object.keys(state.pinned).forEach(function (id) { out[id] = true; });
    if (state.hover && state.hover.body) out[arrowId(state.hover.body, state.hover.key)] = true;
    return out;
  }
  /** 提示框内容：名称 / 大小 / 方向 / 在分析坐标系下的分量 / 作用对象 */
  function forceTipLines(body, key, frame, vec, mag) {
    var fb = frame.bodies[body];
    var def = (state.scene.bodies || []).filter(function (b) { return b.id === body; })[0] || {};
    var L = PFA.draw.LABELS || {};
    var ax = motionAxis(body, frame);
    var fx = vec[0] * ax[0][0] + vec[1] * ax[0][1];
    var fy = vec[0] * ax[1][0] + vec[1] * ax[1][1];
    var ang = Math.atan2(vec[1], vec[0]) * 180 / Math.PI;
    return [
      (L[key] || key) + (isPinned(body, key) ? '（已固定）' : ''),
      '大小 ' + fmtForceLocal(mag),
      '方向 ' + ang.toFixed(0) + '°（世界系）',
      '分量 x 轴 ' + fmtForceLocal(fx) + '，y 轴 ' + fmtForceLocal(fy),
      '对象 ' + (def.label || body)
    ];
  }
  function fmtForceLocal(v) {
    var a = Math.abs(v);
    if (a <= 1e-12) return '0 N';
    if (a >= 100) return v.toFixed(1) + ' N';
    if (a >= 1) return v.toFixed(2) + ' N';
    if (a >= 0.01) return (v * 1e3).toFixed(1) + ' mN';
    return v.toExponential(1) + ' N';
  }
  function buildTips(list) {
    var out = {};
    var frame = state.frames[Math.round(state.index)];
    if (!frame) return out;
    list.forEach(function (it) {
      var f = frame.bodies[it.body];
      if (!f || !f.forces[it.key]) return;
      var v = f.forces[it.key];
      out[arrowId(it.body, it.key)] = forceTipLines(it.body, it.key, frame, v, Math.hypot(v[0], v[1]));
    });
    return out;
  }
  function canvasTips() {
    var list = [];
    Object.keys(state.pinned).forEach(function (id) {
      var p = id.split('|');
      list.push({ body: p[0], key: p[1] });
    });
    if (state.hover && state.hover.body) list.push({ body: state.hover.body, key: state.hover.key });
    return buildTips(list);
  }
  function fpHighlight(body) {
    var out = {};
    Object.keys(state.pinned).forEach(function (id) {
      var p = id.split('|');
      if (p[0] === '*' || p[0] === body) out[p[1]] = true;
    });
    if (state.hover && state.hover.scope === 'panel') out[state.hover.key] = true;
    return out;
  }
  function fpTips(body, layout) {
    var out = {};
    (layout.items || []).forEach(function (it) {
      var key = arrowId('*', it.key);
      if (state.pinned[key] || (state.hover && state.hover.scope === 'panel' && state.hover.key === it.key)) {
        var frame = state.frames[Math.round(state.index)];
        if (!frame) return;
        out[it.key] = forceTipLines(state.fpBody, it.key, frame, it.vec, it.mag);
      }
    });
    return out;
  }

  /**
   * 受力小窗的分析坐标系：返回 [x̂, ŷ] 两条轴。
   *   · **只有斜面**（模型声明了 analysisAxis）沿斜面建系：x 轴按实际运动翻成"沿斜面向下"，
   *     y 轴用模型给的外法向（**不翻**，始终指向远离斜面一侧）；
   *   · 其余模型一律世界水平竖直（x 轴水平、y 轴竖直）。
   * 声明的两种写法都支持：[x̂] 或 [x̂, ŷ]（只给 x̂ 时 y 轴按数学惯例逆时针 90°）。
   */
  function motionAxis(bodyId, frame) {
    var frames = state.frames || [];
    var decl = state.scene && state.scene.analysisAxis;
    if (!decl) return [[1, 0], [0, 1]];
    var dxv = Array.isArray(decl[0]) ? decl[0] : decl;                 // x 轴
    var dyv = Array.isArray(decl[0]) ? (decl[1] || [-dxv[1], dxv[0]]) // y 轴（可选）
                                     : [-decl[1], decl[0]];
    var first = frames.length ? frames[0].bodies[bodyId] : null;
    var last = frames.length ? frames[frames.length - 1].bodies[bodyId] : null;
    var dx = (last && first) ? last.x - first.x : 0;
    var dy = (last && first) ? last.y - first.y : 0;
    var along = dx * dxv[0] + dy * dxv[1];
    var x = along < 0 ? [-dxv[0], -dxv[1]] : [dxv[0], dxv[1]];
    return [x, dyv];
  }

  function syncBodySelect(dyn, cur) {
    var sel = els.fpBody;
    if (!sel) return;
    var sig = dyn.map(function (b) { return b.id; }).join(',') + '|' + cur;
    if (sel.dataset.sig === sig) return;         // 避免每帧重建 select 打断交互
    sel.dataset.sig = sig;
    sel.innerHTML = '';
    dyn.forEach(function (b) {
      var o = document.createElement('option');
      o.value = b.id;
      o.textContent = b.label || b.id;
      sel.appendChild(o);
    });
    sel.value = cur;
  }

  function draw() {
    if (!state.frames || !state.scene) {
      els.ctx.clearRect(0, 0, els.canvas.width, els.canvas.height);
      return;
    }
    var frame = state.frames[Math.round(state.index)];
    var trail = state.layers.trail ? state.frames.slice(0, Math.round(state.index) + 1) : null;
    var layers = {
      forces: state.layers.forces, velocity: state.layers.velocity, grid: state.layers.grid,
      trail: state.layers.trail, dims: state.layers.dims
    };
    PFA.draw.setTheme(state.theme);
    // 相机（取景）永远是最初的自动适配，**不再做裁剪变焦**；
    // 控制框改的是模型变换 view.mt —— 模型自己的 position/scale。
    var view = Object.assign({}, state.view, { mt: state.modelTransform || null });
    // 场可视化：几何按**当前取景的世界矩形**计算，电场线才能一直画到画布边缘；
    // 只在电荷/开关/取景变动时重算（每帧重算 marching squares 太浪费）。
    var fieldOpts = null;
    if (state.scene.field) {
      // 匀强场（加速/偏转电场）的场线只由极板位置决定，与取景无关 → 不做失效判断，
      // 否则每帧都会重算一次。
      if (state.scene.field.uniform) {
        if (!state.fieldGeom) {
          state.fieldGeom = PFA.field.compute(state.scene, { lines: true, equipotential: false });
        }
      } else {
        var fdom = PFA.field.viewDomain(view);
        var g = state.fieldGeom;
        var stale = !g || !g.dom ||
          Math.abs(g.dom.xmin - fdom.xmin) > 1e-6 || Math.abs(g.dom.xmax - fdom.xmax) > 1e-6 ||
          Math.abs(g.dom.ymin - fdom.ymin) > 1e-6 || Math.abs(g.dom.ymax - fdom.ymax) > 1e-6;
        if (stale) {
          state.fieldGeom = PFA.field.compute(state.scene, {
            lines: state.fieldOpts.lines, equipotential: state.fieldOpts.equipotential, domain: fdom
          });
        }
      }
      layers.fieldLines = state.fieldOpts.lines;
      layers.equipotential = state.fieldOpts.equipotential;
      fieldOpts = { fieldGeom: state.fieldGeom, selectedCharge: state.selKind === 'charge' ? state.selCharge : -1,
        selectedProbe: state.selKind === 'probe' ? state.selProbe : -1 };
    }
    PFA.draw.render(els.ctx, view, frame, state.scene, Object.assign({
      layers: layers,
      theme: state.theme,
      arrowMode: state.arrowMode,
      labelMode: state.labelMode,
      labelSize: state.labelSize,
      trailFrames: trail,
      velocityScale: state.velocityScale,
      hlArrows: hlArrows(),
      tipArrows: canvasTips(),
      built: null
    }, fieldOpts || {}));
    if (state.layers.legend) PFA.draw.drawLegend(els.ctx, view);
    drawForcePanel(frame);          // 右上角"受力小窗"（取代原数据条）
    if (els.graph) els.graph.parentElement.style.display = state.scene.noGraph ? 'none' : '';
    if (state.cropEdit) {
      var cw = els.canvas.clientWidth, ch = els.canvas.clientHeight;
      if (!state.modelBox) state.modelBox = state.baseBoxScreen();
      if (state.modelBox) PFA.draw.drawCropFrame(els.ctx, cw, ch, state.modelBox, {});
    }
    drawGraph();
    renderReadout(frame);
    renderTime();
  }

  function renderTime() {
    var n = state.frames.length - 1;
    els.scrub.value = String(state.index);
    els.scrub.max = String(n);
    els.timeLabel.textContent = 't = ' + fmt(state.frames[Math.round(state.index)].t, 2) + ' s / ' +
      fmt(state.frames[n].t, 2) + ' s';
  }

  function renderReadout(frame) {
    // 页面底部的"当前帧受力表"已按需求移除；保留函数以便以后需要时再挂回来
    if (!els.readout) return;
    var rows = [];
    Object.keys(frame.bodies).forEach(function (id) {
      var b = frame.bodies[id];
      if (b.type !== 'dynamic') return;
      var f = b.forces;
      function pair(v) { return '[' + fmt(v[0], 1) + ', ' + fmt(v[1], 1) + ']'; }
      rows.push('<tr class="' + (id === state.selected ? 'sel' : '') + '">' +
        '<td>' + (b.label || id) + '</td>' +
        '<td>' + fmt(b.mass, 2) + '</td>' +
        '<td class="g">' + pair(f.gravity) + '</td>' +
        '<td class="n">' + pair(f.normal) + '</td>' +
        '<td class="fr">' + pair(f.friction) + '</td>' +
        '<td class="j">' + pair(f.joint) + '</td>' +
        '<td class="a">' + pair(f.applied) + '</td>' +
        '<td class="t">' + pair(f.total) + '</td>' +
        '<td>' + pair(b.accel) + '</td>' +
        '<td class="r">' + fmt(b.residual * 100, 3) + '%</td>' +
        '</tr>');
    });
    els.readout.innerHTML =
      '<table><thead><tr><th>刚体</th><th>质量<br>kg</th><th>重力<br>N</th><th>支持力<br>N</th>' +
      '<th>摩擦<br>N</th><th>绳/杆<br>N</th><th>外力<br>N</th><th>合力<br>N</th>' +
      '<th>加速度<br>m/s²</th><th>残差</th></tr></thead><tbody>' + rows.join('') + '</tbody></table>';
  }

  function renderPanels() {
    // 模型信息
    var model = PFA.models.get(state.modelId);
    if (els.title) els.title.textContent = state.scene ? state.scene.title : (model ? model.title : '');
    if (els.subtitle) els.subtitle.textContent = state.scene ? (state.scene.subtitle || '') : '';
    if (els.notes) els.notes.textContent = state.scene ? (state.scene.notes || '') : '';
    if (els.alert) {
      if (state.error) {
        els.alert.style.display = 'block';
        els.alert.textContent = '构建失败：' + state.error;
      } else {
        els.alert.style.display = 'none';
      }
    }

    // 解析值 vs 仿真值（页面底部的表格已被移除，这里只在元素存在时才渲染）
    if (!els.verify) return;
    if (!state.verify.length) {
      els.verify.innerHTML = '<div class="muted">该模型没有提供解析对照项</div>';
    } else {
      var rows = state.verify.map(function (r) {
        var errTxt = r.relError == null ? '—'
          : (r.absolute ? '绝对 ' + fmt(r.relError, 4) : fmt(r.relError * 100, 3) + '%');
        return '<tr class="' + (r.pass ? 'pass' : 'fail') + '">' +
          '<td>' + r.label + '</td>' +
          '<td class="num">' + fmt(r.theory, 4) + '</td>' +
          '<td class="num">' + fmt(r.sim, 4) + '</td>' +
          '<td class="num">' + errTxt + '</td>' +
          '<td>' + (r.pass ? '一致' : (r.sim == null ? '无法测量' : '偏差')) + '</td>' +
          '</tr>';
      });
      els.verify.innerHTML = '<table><thead><tr><th>物理量</th><th>解析值</th><th>仿真值</th>' +
        '<th>误差</th><th>判定</th></tr></thead><tbody>' + rows.join('') + '</tbody></table>';
    }
  }

  function renderParams() {
    var model = PFA.models.get(state.modelId);
    if (!model) return;
    els.params.innerHTML = '';
    (model.params || []).forEach(function (p) {
      var wrap = document.createElement('div');
      wrap.className = 'param';
      // 下拉型参数（题目约束排布等）
      if (p.type === 'preset' || p.type === 'select' || p.options) {
        var opts = (p.options || []).map(function (v, i) {
          var lab = p.labels ? p.labels[i] : v;
          return '<option value="' + v + '"' + (state.params[p.key] === v ? ' selected' : '') + '>' + lab + '</option>';
        }).join('');
        wrap.innerHTML = '<label><span>' + p.label + '</span></label>' +
          '<select data-key="' + p.key + '">' + opts + '</select>';
        els.params.appendChild(wrap);
        var sel = wrap.querySelector('select');
        sel.addEventListener('change', function () {
          state.params[p.key] = sel.value;
          state.fieldCharges = null;      // 换题目约束 → 丢弃手动编辑，回到预设
          state.selCharge = -1;
          state.pinnedView = null;
          bake(false, true);
          draw();
        });
        return;
      }
      wrap.innerHTML = '<label><span>' + p.label + '</span>' +
        '<b id="pv-' + p.key + '">' + fmt(state.params[p.key], 2) + (p.unit ? ' ' + p.unit : '') + '</b></label>' +
        '<input type="range" min="' + p.min + '" max="' + p.max + '" step="' + p.step +
        '" value="' + state.params[p.key] + '" data-key="' + p.key + '">';
      els.params.appendChild(wrap);
      var input = wrap.querySelector('input');
      input.addEventListener('input', function () {
        state.params[p.key] = Number(input.value);
        $('pv-' + p.key).textContent = fmt(state.params[p.key], 2) + (p.unit ? ' ' + p.unit : '');
        scheduleBake();
      });
    });
  }

  // 滑杆连续拖动时只重建一次
  var bakeTimer = null;
  function scheduleBake() {
    if (bakeTimer) clearTimeout(bakeTimer);
    bakeTimer = setTimeout(function () { bake(true); }, 90);
  }

  // ------------------------------------------------------------------ 主题

  /** 画布用 draw.js 的主题，页面外壳（页头/卡片/表格）用 CSS 变量同步切换 */
  function applyTheme() {
    document.body.classList.toggle('light', state.theme === 'light');
    PFA.draw.setTheme(state.theme);
  }

  /** 图片主题（给 graph.js 用） */
  function graphTheme() {
    return state.theme === 'light' ? {
      bg: '#ffffff', axis: '#111111', text: '#111111', textMuted: '#666666',
      panelLine: '#dcdcd6', mark: 'rgba(169,119,10,0.55)', markText: '#a9770a',
      playhead: '#d33a2c', playheadText: '#ffffff'
    } : {
      bg: '#0c111c', axis: 'rgba(200,220,255,0.55)', text: '#e6edf8', textMuted: '#8fa3c2',
      panelLine: 'rgba(140,170,215,0.28)', mark: 'rgba(255,214,102,0.5)', markText: '#ffd666',
      playhead: '#ff5d5d', playheadText: '#0a0e17'
    };
  }
  var SERIES_DARK = ['#ffb020', '#4da3ff', '#35d07f'];
  var SERIES_LIGHT = ['#b3261e', '#1a56b8', '#0f7a3d'];

  /**
   * 画下方的 x-t / v-t 图像。画布同样做超采样，绘制坐标保持在 CSS 像素上。
   * 返回命中测试需要的信息（布局 + 临界时刻）。
   */
  function drawGraph() {
    if (!els.graph || !state.frames || !state.scene) return null;
    var w = els.graph.clientWidth, h = els.graph.clientHeight;
    if (!w || !h) return null;
    var dpr = Math.min(3, Math.max(2, window.devicePixelRatio || 1));
    var bw = Math.round(w * dpr), bh = Math.round(h * dpr);
    var gctx = els.graph.getContext('2d');
    if (els.graph.width !== bw || els.graph.height !== bh) {
      els.graph.width = bw; els.graph.height = bh;
    }
    gctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    state.graphInfo = PFA.graph.draw(gctx, {
      width: w, height: h,
      frames: state.frames, scene: state.scene,
      tNow: state.frames[Math.round(state.index)].t,
      theme: graphTheme(),
      seriesColors: state.theme === 'light' ? SERIES_LIGHT : SERIES_DARK
    });
    return state.graphInfo;
  }

  /** 鼠标在时间轴上悬停/点击断口 → 弹说明 */
  function updateMarkerTip(mx, my, force) {
    if (!els.graph || !els.tip || !state.graphInfo) return;
    var m = PFA.graph.hitMarker(state.graphInfo.layout, state.graphInfo.markers, mx, my);
    if (m && (force || !state.tipPinned)) {
      els.tip.style.display = 'block';
      els.tip.innerHTML = '<b>' + (m.label || '临界时刻') + '</b>' +
        ' <span class="tip-t">t = ' + m.t.toFixed(2) + ' s</span><br>' +
        (m.note || '');
      var wrapW = els.graph.parentElement.clientWidth;
      var tw = Math.min(400, els.tip.offsetWidth || 360);
      var left = Math.max(4, Math.min(mx + 14, wrapW - tw - 12));
      els.tip.style.left = left + 'px';
      els.tip.style.top = Math.max(2, my - els.tip.offsetHeight - 10) + 'px';
      state.tipShown = m;
    } else if (!state.tipPinned) {
      els.tip.style.display = 'none';
      state.tipShown = null;
    }
  }

  // ------------------------------------------------------------------ 主循环

  function tick(ts) {
    requestAnimationFrame(tick);
    if (!state.frames) return;
    var dtWall = state.lastTs ? Math.min(0.1, (ts - state.lastTs) / 1000) : 0;
    state.lastTs = ts;
    if (!state.playing) return;
    var frameDt = state.frames[1] ? state.frames[1].dt : 1 / 60;
    state.index += (dtWall * state.speed) / frameDt;
    var n = state.frames.length - 1;
    if (state.index >= n) {
      if (state.loop) state.index = state.index % n;
      else { state.index = n; setPlaying(false); }
    }
    draw();
  }

  function setPlaying(v) {
    state.playing = v;
    if (v && state.frames && state.index >= state.frames.length - 1) state.index = 0;
    // 播放键是图标：切换 ▶ / ⏸ 两个 SVG（浅色模式下按钮为天蓝色）
    var ip = els.play.querySelector('.ico-play'), iz = els.play.querySelector('.ico-pause');
    if (ip && iz) { ip.style.display = v ? 'none' : ''; iz.style.display = v ? '' : 'none'; }
    els.play.setAttribute('aria-label', v ? '暂停' : '播放');
    els.play.title = v ? '暂停（空格）' : '播放（空格）';
    els.play.classList.toggle('playing', !!v);
  }

  // ------------------------------------------------------------------ 事件

  function bind() {
    // 齿轮抽屉：侧边栏默认完全收起，画布占满宽度
    // 侧边栏：布局里的一格，折叠后画布自动变宽（和 Office 工具栏同理）
    function setDrawer(open) {
      els.side.classList.toggle('open', open);
      if (state.pendingResize !== false) setTimeout(resize, 0);
    }
    state.setDrawer = setDrawer;
    els.gear.addEventListener('click', function () { setDrawer(!els.side.classList.contains('open')); });
    if (els.close) els.close.addEventListener('click', function () { setDrawer(false); });
    // 下边栏：折叠后画布自动变高
    function setBottom(open) {
      var bp = document.getElementById('bottom-panel');
      if (!bp) return;
      bp.classList.toggle('collapsed', !open);
      var btn = document.getElementById('btn-bottom-toggle');
      if (btn) btn.classList.toggle('primary', !!open);
      setTimeout(resize, 0);
    }
    if (els.bottomToggle) els.bottomToggle.addEventListener('click', function () {
      var bp = document.getElementById('bottom-panel');
      setBottom(bp ? bp.classList.contains('collapsed') : true);
    });
    state.setBottom = setBottom;

    els.play.addEventListener('click', function () { setPlaying(!state.playing); });
    els.reset.addEventListener('click', function () { state.index = 0; setPlaying(false); draw(); });
    els.step.addEventListener('click', function () {
      setPlaying(false);
      state.index = Math.min(state.frames ? state.frames.length - 1 : 0, Math.round(state.index) + 1);
      draw();
    });
    els.back.addEventListener('click', function () {
      setPlaying(false);
      state.index = Math.max(0, Math.round(state.index) - 1);
      draw();
    });
    els.speed.addEventListener('change', function () { state.speed = Number(els.speed.value); });
    els.loop.addEventListener('change', function () { state.loop = els.loop.checked; });
    els.scrub.addEventListener('input', function () {
      setPlaying(false);
      state.index = Number(els.scrub.value);
      draw();
    });
    els.modelSelect.addEventListener('change', function () {
      state.modelId = els.modelSelect.value;
      state.params = PFA.models.defaults(PFA.models.get(state.modelId));
      state.frames = null;
      bake(false);
      setPlaying(true);
    });
    ['grid', 'trail', 'legend', 'hud', 'dims'].forEach(function (k) {
      var box = $('layer-' + k);
      if (!box) return;
      box.addEventListener('change', function () {
        state.layers[k] = box.checked;
        draw();
      });
    });
    if (els.arrowMode) {
      els.arrowMode.addEventListener('change', function () {
        state.arrowMode = els.arrowMode.value;
        draw();
      });
    }

    // ---- 静电场：显示开关 + 新增（选种类/电量）+ 选中编辑 + 拖动 ----
    (function () {
      var FE = {
        card: $('card-field'), addKind: $('add-kind'), addQ: $('add-q'), addQW: $('add-q-wrap'),
        pvAddQ: $('pv-addq'), btnAdd: $('btn-add'), selWrap: $('sel-wrap'),
        selQW: $('sel-q-wrap'), selQ: $('sel-q'), pvSelQ: $('pv-selq'),
        selBtnW: $('sel-btn-wrap'), btnFlip: $('btn-flip'), btnDel: $('btn-del-charge'),
        lines: $('field-lines'), equi: $('field-equi')
      };
      if (!FE.card) return;
      function afterFieldChange() {
        state.fieldGeom = null;        // 电荷/场点变了 → 场几何要重算
        bake(true, false);             // 取景锁定：拖动时画面不跟着缩放平移
      }
      function refreshSelUI() {
        var isCharge = state.selKind === 'charge' && state.selCharge >= 0;
        var isProbe = state.selKind === 'probe' && state.selProbe >= 0;
        FE.selQW.style.display = isCharge ? '' : 'none';
        FE.selBtnW.style.display = (isCharge || isProbe) ? '' : 'none';
        FE.btnFlip.style.display = isCharge ? '' : 'none';
        if (isCharge) {
          var q = state.fieldCharges[state.selCharge].q;
          FE.selQ.value = String(Math.abs(q));
          FE.pvSelQ.textContent = (q > 0 ? '+' : '−') + Math.abs(q).toFixed(1) + ' μC';
          FE.selWrap.textContent = '已选中：电荷 ' + (q > 0 ? '+' : '−') + Math.abs(q).toFixed(1) + ' μC（拖动可移动）';
        } else if (isProbe) {
          FE.selWrap.textContent = '已选中：场点（拖动可移动，画面上显示该处 E 的大小与方向）';
        } else {
          FE.selWrap.textContent = '未选中任何对象。点画布上的电荷/场点即可选中。';
        }
      }
      function kindChanged() {
        FE.addQW.style.display = FE.addKind.value === 'probe' ? 'none' : '';
      }
      if (FE.addKind) FE.addKind.addEventListener('change', kindChanged);
      kindChanged();
      if (FE.addQ) FE.addQ.addEventListener('input', function () {
        var v = Number(FE.addQ.value);
        FE.pvAddQ.textContent = '+' + v.toFixed(1) + ' μC';
      });
      if (FE.lines) FE.lines.addEventListener('change', function () {
        state.fieldOpts.lines = FE.lines.checked; state.fieldGeom = null; draw();
      });
      if (FE.equi) FE.equi.addEventListener('change', function () {
        state.fieldOpts.equipotential = FE.equi.checked; state.fieldGeom = null; draw();
      });
      if (FE.btnAdd) FE.btnAdd.addEventListener('click', function () {
        var kind = FE.addKind.value;
        var v = state.view;
        if (kind === 'probe') {
          if (state.fieldProbes.length >= 10) { window.alert('最多 10 个场点'); return; }
          state.fieldProbes.push({ x: v.cx, y: v.cy });
          state.selKind = 'probe'; state.selProbe = state.fieldProbes.length - 1; state.selCharge = -1;
        } else {
          if (!state.fieldCharges) return;
          if (state.fieldCharges.length >= 10) { window.alert('最多 10 个电荷'); return; }
          var mag = Number(FE.addQ.value) * (kind === 'neg' ? -1 : 1);
          // 稍微错开，避免叠在已有电荷上
          var k = state.fieldCharges.length;
          state.fieldCharges.push({ x: v.cx + (k % 3 - 1) * 0.5, y: v.cy + (Math.floor(k / 3) % 3 - 1) * 0.5, q: mag });
          state.selKind = 'charge'; state.selCharge = state.fieldCharges.length - 1; state.selProbe = -1;
        }
        refreshSelUI();
        afterFieldChange();
      });
      if (FE.selQ) FE.selQ.addEventListener('input', function () {
        if (state.selKind !== 'charge' || state.selCharge < 0) return;
        var c = state.fieldCharges[state.selCharge];
        var sign = c.q >= 0 ? 1 : -1;
        c.q = sign * Number(FE.selQ.value);
        FE.pvSelQ.textContent = (c.q > 0 ? '+' : '−') + Math.abs(c.q).toFixed(1) + ' μC';
        state.fieldGeom = null;
        bake(true, false);
      });
      if (FE.btnFlip) FE.btnFlip.addEventListener('click', function () {
        if (state.selKind !== 'charge' || state.selCharge < 0) return;
        state.fieldCharges[state.selCharge].q *= -1;
        refreshSelUI(); afterFieldChange();
      });
      if (FE.btnDel) FE.btnDel.addEventListener('click', function () {
        if (state.selKind === 'charge' && state.selCharge >= 0) {
          state.fieldCharges.splice(state.selCharge, 1);
          state.selCharge = -1; state.selKind = null;
        } else if (state.selKind === 'probe' && state.selProbe >= 0) {
          state.fieldProbes.splice(state.selProbe, 1);
          state.selProbe = -1; state.selKind = null;
        } else return;
        refreshSelUI(); afterFieldChange();
      });
      state.refreshFieldPanel = function () { refreshSelUI(); kindChanged(); };
      var refitBtn = $('btn-refit');
      if (refitBtn) refitBtn.addEventListener('click', function () { state.pinnedView = null; bake(true, true); draw(); });

      var drag = null;                       // 'charge' | 'probe'
      function canvasPos(ev) {
        var r = els.canvas.getBoundingClientRect();
        return { x: ev.clientX - r.left, y: ev.clientY - r.top };
      }
      els.canvas.addEventListener('mousedown', function (ev) {
        if (!state.scene || !state.scene.field || state.cropEdit) return;
        var p = canvasPos(ev);
        var ic = PFA.field.hitCharge(state.view, state.fieldCharges || [], p.x, p.y);
        if (ic >= 0) {
          state.selKind = 'charge'; state.selCharge = ic; state.selProbe = -1;
          drag = 'charge'; state.refreshFieldPanel(); draw(); ev.preventDefault(); return;
        }
        var ip = PFA.field.hitProbe(state.view, state.fieldProbes || [], p.x, p.y);
        if (ip >= 0) {
          state.selKind = 'probe'; state.selProbe = ip; state.selCharge = -1;
          drag = 'probe'; state.refreshFieldPanel(); draw(); ev.preventDefault(); return;
        }
        state.selKind = null; state.selCharge = -1; state.selProbe = -1;
        state.refreshFieldPanel(); draw();
      });
      els.canvas.addEventListener('mousemove', function (ev) {
        if (!drag) return;
        var p = canvasPos(ev);
        var w = PFA.draw.unproject(state.view, p.x, p.y);
        var x = Math.max(-60, Math.min(60, w[0])), y = Math.max(-60, Math.min(60, w[1]));
        if (drag === 'charge' && state.selCharge >= 0) {
          var c = state.fieldCharges[state.selCharge];
          state.fieldCharges[state.selCharge] = { x: x, y: y, q: c.q };
        } else if (drag === 'probe' && state.selProbe >= 0) {
          state.fieldProbes[state.selProbe] = { x: x, y: y };
        }
        afterFieldChange();
      });
      window.addEventListener('mouseup', function () { drag = null; });
      els.canvas.addEventListener('contextmenu', function (ev) {
        if (!state.scene || !state.scene.field) return;
        var p = canvasPos(ev);
        var ic = PFA.field.hitCharge(state.view, state.fieldCharges || [], p.x, p.y);
        if (ic >= 0) {
          ev.preventDefault();
          state.fieldCharges.splice(ic, 1);
          state.selKind = null; state.selCharge = -1;
          state.refreshFieldPanel(); afterFieldChange(); return;
        }
        var ip = PFA.field.hitProbe(state.view, state.fieldProbes || [], p.x, p.y);
        if (ip >= 0) {
          ev.preventDefault();
          state.fieldProbes.splice(ip, 1);
          state.selKind = null; state.selProbe = -1;
          state.refreshFieldPanel(); afterFieldChange();
        }
      });
      refreshSelUI();
    })();

    // ---- 控制框：改的是**模型自己的 position / scale**，相机（取景）完全不动 ----
    //
    // 与"相机变焦"的区别很关键：相机变焦会把框外内容裁掉、也改不了模型本身；
    // 模型变换只把模型几何整体平移+缩放，画布上其余部分（网格、其它参照物）原地不动，
    // 也不会因为"放大"而让原有内容跑出画面。
    function baseBoxScreen() {
      var v = state.view, c = v && v.content;
      if (!c) return null;
      var p0 = PFA.draw.project(v, c.xmin, c.ymax);
      var p1 = PFA.draw.project(v, c.xmax, c.ymin);
      return {
        x: Math.min(p0[0], p1[0]), y: Math.min(p0[1], p1[1]),
        w: Math.abs(p1[0] - p0[0]), h: Math.abs(p1[1] - p0[1])
      };
    }
    /** 由屏幕上的框反推模型变换：sx/sy 是缩放，tx/ty 是平移（世界米） */
    function boxToTransform(box) {
      var base = baseBoxScreen();
      var v = state.view, c = v && v.content;
      if (!base || !c || base.w < 1 || base.h < 1) return null;
      var dcx = (box.x + box.w / 2) - (base.x + base.w / 2);
      var dcy = (box.y + box.h / 2) - (base.y + base.h / 2);
      return {
        cx: c.cx, cy: c.cy,
        sx: box.w / base.w, sy: box.h / base.h,
        tx: dcx / v.pxPerM, ty: -dcy / v.pxPerM
      };
    }
    state.baseBoxScreen = baseBoxScreen;
    state.boxToTransform = boxToTransform;
    function resetModelTransform() {
      state.modelTransform = null;
      state.modelBox = baseBoxScreen();
      draw();
    }
    state.resetModelTransform = resetModelTransform;

    if (els.cropBtn) {
      els.cropBtn.addEventListener('click', function () {
        state.cropEdit = !state.cropEdit;
        els.cropBtn.classList.toggle('primary', state.cropEdit);
        els.cropBtn.textContent = state.cropEdit ? '完成变换' : '变换模型';
        if (state.cropEdit && !state.modelBox) state.modelBox = baseBoxScreen();
        if (els.cropReset) els.cropReset.style.display = state.cropEdit ? '' : 'none';
        draw();
      });
    }
    if (els.cropReset) {
      els.cropReset.addEventListener('click', function () {
        resetModelTransform();
        state.modelBox = baseBoxScreen();
      });
    }
    (function () {
      var dragging = null, last = null;
      function pos(ev) {
        var r = els.canvas.getBoundingClientRect();
        return { x: ev.clientX - r.left, y: ev.clientY - r.top };
      }
      els.canvas.addEventListener('mousedown', function (ev) {
        if (!state.cropEdit || !state.modelBox) return;
        var cw = els.canvas.clientWidth, ch = els.canvas.clientHeight;
        var p = pos(ev);
        var b = state.modelBox;
        var key = PFA.draw.hitCropHandle(b, p.x, p.y, cw, ch);
        var inBox = p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h;
        if (!key && !inBox) return;
        dragging = key ? { mode: 'resize', key: key } : { mode: 'move' };
        state.cropDrag = dragging;
        last = p;
        ev.preventDefault();
      });
      els.canvas.addEventListener('mousemove', function (ev) {
        var cw = els.canvas.clientWidth, ch = els.canvas.clientHeight;
        if (state.cropEdit && state.modelBox) {
          var p0 = pos(ev), b0 = state.modelBox;
          var k = PFA.draw.hitCropHandle(b0, p0.x, p0.y, cw, ch);
          els.canvas.style.cursor = k ? (k === 'n' || k === 's' ? 'ns-resize' : (k === 'e' || k === 'w' ? 'ew-resize' : 'nwse-resize'))
            : (p0.x >= b0.x && p0.x <= b0.x + b0.w && p0.y >= b0.y && p0.y <= b0.y + b0.h ? 'move' : 'default');
        } else {
          els.canvas.style.cursor = '';
        }
        if (!dragging) return;
        var p = pos(ev);
        state.modelBox = PFA.draw.dragCrop(state.modelBox, dragging.mode, dragging.key,
          p.x - last.x, p.y - last.y, cw, ch,
          // 模型变换的钳制：只防退化，不强制半屏、也不把框夹在画布内
          { minW: 24, minH: 24, clamp: false });
        state.modelTransform = boxToTransform(state.modelBox);   // 框 → 模型 position/scale
        last = p;
        draw();
      });
      window.addEventListener('mouseup', function () {
        if (dragging) { dragging = null; state.cropDrag = null; draw(); }
      });
    })();
    if (els.fpBtn) {
      els.fpBtn.addEventListener('click', function () {
        state.fpHidden = !state.fpHidden;
        els.fpBtn.classList.toggle('primary', !state.fpHidden);
        draw();
      });
    }
    // ---- 力箭头：悬停显示属性（桌面 tooltip 那样），点击固定，再点一次取消 ----
    (function () {
      function pos(ev) {
        var r = els.canvas.getBoundingClientRect();
        return { x: ev.clientX - r.left, y: ev.clientY - r.top };
      }
      // 捕获阶段先于"框选/电荷拖拽"处理：压到箭头就吃掉这次事件，避免误触发别的拖拽
      els.canvas.addEventListener('mousedown', function (ev) {
        if (state.cropEdit) return;
        var p = pos(ev);
        var hit = PFA.draw.hitArrows(p.x, p.y, 9);
        if (!hit) return;
        var id = arrowId(hit.body, hit.key);
        if (state.pinned[id]) delete state.pinned[id]; else state.pinned[id] = true;
        state.hover = { scope: 'canvas', body: hit.body, key: hit.key };
        ev.stopPropagation(); ev.preventDefault();
        draw();
      }, true);
      els.canvas.addEventListener('mousemove', function (ev) {
        if (state.cropEdit || state.cropDrag) { state.hover = null; return; }
        var p = pos(ev);
        var hit = PFA.draw.hitArrows(p.x, p.y, 9);
        var next = hit ? { scope: 'canvas', body: hit.body, key: hit.key } : null;
        var same = (!next && !state.hover) ||
          (next && state.hover && state.hover.scope === 'canvas' &&
           state.hover.body === next.body && state.hover.key === next.key);
        els.canvas.style.cursor = hit ? 'pointer' : '';
        if (same) return;                       // 状态没变就不重绘
        state.hover = next;
        draw();
      });
      els.canvas.addEventListener('mouseleave', function () {
        if (!state.hover) return;
        state.hover = null;
        draw();
      });
      // 小窗里的箭头同样支持
      if (els.fpCanvas) {
        var fpos = function (ev) {
          var r = els.fpCanvas.getBoundingClientRect();
          return { x: ev.clientX - r.left, y: ev.clientY - r.top };
        };
        els.fpCanvas.addEventListener('mousemove', function (ev) {
          var p = fpos(ev);
          var hit = PFA.draw.hitFreeBody(p.x, p.y, 9);
          var next = hit ? { scope: 'panel', body: '*', key: hit.key } : null;
          var same = (!next && !state.hover) ||
            (next && state.hover && state.hover.scope === 'panel' && state.hover.key === next.key);
          els.fpCanvas.style.cursor = hit ? 'pointer' : '';
          if (same) return;
          state.hover = next;
          draw();
        });
        els.fpCanvas.addEventListener('mousedown', function (ev) {
          var p = fpos(ev);
          var hit = PFA.draw.hitFreeBody(p.x, p.y, 9);
          if (!hit) return;
          var id = arrowId('*', hit.key);
          if (state.pinned[id]) delete state.pinned[id]; else state.pinned[id] = true;
          state.hover = { scope: 'panel', body: '*', key: hit.key };
          ev.stopPropagation(); ev.preventDefault();
          draw();
        });
        els.fpCanvas.addEventListener('mouseleave', function () {
          if (!state.hover || state.hover.scope !== 'panel') return;
          state.hover = null;
          draw();
        });
      }
    })();

    if (els.fpToggle) {
      els.fpToggle.addEventListener('click', function () {
        var fp = els.forcePanel;
        if (!fp) return;
        state.fpCollapsed = !state.fpCollapsed;
        fp.classList.toggle('collapsed', state.fpCollapsed);
        els.fpToggle.textContent = state.fpCollapsed ? '▸' : '▾';
      });
    }
    if (els.fpBody) {
      els.fpBody.addEventListener('change', function () {
        state.fpBody = els.fpBody.value;
        draw();
      });
    }
    if (els.graph) {
      var dragging = false;
      function mousePos(ev) {
        var r = els.graph.getBoundingClientRect();
        return { x: ev.clientX - r.left, y: ev.clientY - r.top };
      }
      function seekAt(x) {
        if (!state.graphInfo) return;
        var t = state.graphInfo.layout.x2t(x);
        state.index = Math.max(0, Math.min(state.frames.length - 1,
          Math.round(t / (state.frames[1] ? state.frames[1].t : 1 / 60))));
        if (els.scrub) els.scrub.value = String(Math.round((state.index / (state.frames.length - 1)) * 100));
        draw();
      }
      els.graph.addEventListener('mousedown', function (ev) {
        var p = mousePos(ev);
        var m = state.graphInfo && PFA.graph.hitMarker(state.graphInfo.layout, state.graphInfo.markers, p.x, p.y);
        if (m) { state.tipPinned = true; updateMarkerTip(p.x, p.y, true); return; }
        setPlaying(false);
        dragging = true;
        seekAt(p.x);
      });
      els.graph.addEventListener('mousemove', function (ev) {
        var p = mousePos(ev);
        updateMarkerTip(p.x, p.y, false);
        var onBreak = state.graphInfo &&
          PFA.graph.hitMarker(state.graphInfo.layout, state.graphInfo.markers, p.x, p.y);
        els.graph.style.cursor = onBreak ? 'help' : (dragging ? 'grabbing' : 'crosshair');
        if (dragging) seekAt(p.x);
      });
      window.addEventListener('mouseup', function () { dragging = false; });
      els.graph.addEventListener('mouseleave', function () {
        dragging = false;
        if (!state.tipPinned) { els.tip.style.display = 'none'; state.tipShown = null; }
      });
      document.addEventListener('click', function (ev) {
        if (state.tipPinned && ev.target !== els.graph && ev.target !== els.tip) {
          state.tipPinned = false;
          els.tip.style.display = 'none';
        }
      });
    }
    if (els.labelMode) {
      els.labelMode.addEventListener('change', function () {
        state.labelMode = els.labelMode.value;
        draw();
      });
    }
    if (els.labelSize) {
      els.labelSize.addEventListener('input', function () {
        state.labelSize = Number(els.labelSize.value);
        draw();
      });
    }
    if (els.theme) {
      els.theme.addEventListener('change', function () {
        state.theme = els.theme.value === 'light' ? 'light' : 'dark';
        applyTheme();
        draw();
        try { localStorage.setItem('mrawu-theme', state.theme); } catch (e) { /* 忽略 */ }
      });
    }
    document.addEventListener('keydown', function (e) {
      if (e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
      if (e.key === 'Escape') { setDrawer(false); return; }
      if (e.key === ' ') { e.preventDefault(); setPlaying(!state.playing); }
      else if (e.key === 'ArrowRight') { els.step.click(); }
      else if (e.key === 'ArrowLeft') { els.back.click(); }
      else if (e.key === 'r' || e.key === 'R') { els.reset.click(); }
    });

    // 场景 JSON 导入/导出
    if (els.loadScene) {
      els.loadScene.addEventListener('click', function () {
        try {
          var raw = JSON.parse(els.sceneJson.value);
          var scene = PFA.scene.normalize(raw);
          var problems = PFA.scene.validate(scene);
          if (!problems.ok) throw new Error(problems.errors.join('；'));
          scene.view.width = els.canvas.clientWidth || 1000;
          scene.view.height = els.canvas.clientHeight || 560;
          var sim = PFA.sim.createSim(root.planck, scene, { engine: pickEngine(scene) });
          var result = sim.record();
          state.scene = scene;
          state.frames = result.frames;
          state.view = computeView(scene, true);   // 导入的场景一律重新取景
          state.verify = [];
          state.error = null;
          state.index = 0;
          state.selected = null;
          var maxV = 0.5;
          state.frames.forEach(function (f) {
            Object.keys(f.bodies).forEach(function (id) {
              var b = f.bodies[id];
              if (b.type === 'dynamic') maxV = Math.max(maxV, Math.hypot(b.vx, b.vy));
            });
          });
          state.velocityScale = 1.8 / maxV;
          els.modelSelect.value = '';
          renderPanels(); renderParams(); draw();
        } catch (e) {
          state.error = (e && e.message) || String(e);
          renderPanels();
        }
      });
    }
    if (els.exportScene) {
      els.exportScene.addEventListener('click', function () {
        if (!state.scene) return;
        var copy = JSON.parse(JSON.stringify({
          id: state.scene.id, title: state.scene.title, subtitle: state.scene.subtitle,
          notes: state.scene.notes, meta: state.scene.meta, view: state.scene.view,
          bodies: state.scene.bodies, joints: state.scene.joints, forces: state.scene.forces
        }));
        els.sceneJson.value = JSON.stringify(copy, null, 2);
      });
    }

    // 尺寸自适应
    var rt = null;
    window.addEventListener('resize', function () {
      if (rt) clearTimeout(rt);
      rt = setTimeout(resize, 150);
    });
  }

  /**
   * 重新取景。capScale=true 时**只允许缩小以适配，不允许因画布变大而放大**。
   *
   * 为什么必须这样：makeView 的力标尺 ARROW_PX 是按 min(画布宽,高) 定的，
   * 而它又算进"给箭头留的边距"再从画布尺寸里扣掉。折叠下边栏让画布变高时，
   * 边距跟着变大、拟合出的比例反而从 108 涨到 158 —— 画面被**放大**了，
   * 原来看得见的范围反而跑到屏幕外。老师要的是"收起下边栏 → 画布真的变大、看到更多"。
   */
  function refitView(capScale) {
    var fitted = PFA.draw.makeView(state.frames, state.scene);
    if (state.scene.field && state.pinnedView) {
      // 场可视化模型取景是锁定的（拖动电荷不重新取景）
      return PFA.draw.makeView(state.frames, state.scene, {
        cx: state.pinnedView.cx, cy: state.pinnedView.cy, pxPerM: state.pinnedView.pxPerM
      });
    }
    var keep = (capScale && state.view) ? Math.min(fitted.pxPerM, state.view.pxPerM) : fitted.pxPerM;
    return PFA.draw.makeView(state.frames, state.scene, {
      cx: fitted.cx, cy: fitted.cy, pxPerM: keep
    });
  }

  /**
   * 画布按"至少 2 倍"的超采样渲染：
   *   canvas.width/height 用 dpr 倍的物理像素，再用 setTransform 把绘图坐标保持在 CSS 像素上。
   * 这样即使老师用的是 1× 的普通 1080p 屏，文字和箭头也会以 2 倍分辨率光栅化后由浏览器缩小，
   * 明显更锐利（3× 屏就按 3 倍）。代价只是每帧多几次填充，对这种图形量完全无压力。
   */
  function resize() {
    var w = els.canvas.clientWidth, h = els.canvas.clientHeight;
    if (!w || !h) return;
    var dpr = Math.min(3, Math.max(2, window.devicePixelRatio || 1));
    var bw = Math.round(w * dpr), bh = Math.round(h * dpr);
    if (els.canvas.width !== bw || els.canvas.height !== bh) {
      els.canvas.width = bw;          // 改 width 会重置上下文状态，所以下面重新设一次变换
      els.canvas.height = bh;
    }
    els.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    state.dpr = dpr;
    if (state.scene) {
      state.scene.view.width = w;
      state.scene.view.height = h;
      state.view = refitView(true);
      state.fieldGeom = null;         // 场线/等势线的计算域跟着取景走，要重算
    }
    draw();
  }

  // ------------------------------------------------------------------ 启动

  function init() {
    // 任何脚本级错误都显示出来，而不是白屏（老师反馈问题时能看到具体报错）
    window.addEventListener('error', function (e) {
      var box = document.getElementById('alert');
      if (box) { box.style.display = 'block'; box.textContent = '脚本错误：' + (e.message || e); }
    });
    els.canvas = $('stage');
    els.ctx = els.canvas.getContext('2d');
    els.play = $('btn-play'); els.reset = $('btn-reset'); els.step = $('btn-step');
    els.back = $('btn-back'); els.speed = $('speed'); els.loop = $('loop');
    els.scrub = $('scrub'); els.timeLabel = $('time-label');
    els.readout = $('readout'); els.verify = $('verify'); els.params = $('params');
    els.title = $('scene-title'); els.subtitle = $('scene-subtitle'); els.notes = $('scene-notes');    els.alert = $('alert'); els.modelSelect = $('model-select');
    els.sceneJson = $('scene-json'); els.loadScene = $('btn-load-scene'); els.exportScene = $('btn-export-scene');
    els.labelMode = $('label-mode'); els.labelSize = $('label-size');
    if (els.labelMode) els.labelMode.value = state.labelMode;
    if (els.labelSize) els.labelSize.value = String(state.labelSize);
    els.gear = $('btn-gear'); els.close = $('btn-close'); els.side = $('side'); els.backdrop = $('backdrop');
    els.bottomToggle = $('btn-bottom-toggle');
    els.forcePanel = $('force-panel'); els.fpCanvas = $('fp-canvas');
    els.fpBody = $('fp-body'); els.fpToggle = $('fp-toggle');
    els.theme = $('theme'); els.arrowMode = $('arrow-mode');
    els.cropBtn = $('btn-crop'); els.cropReset = $('btn-crop-reset');
    els.fieldBar = $('field-bar');
    els.graph = $('graph'); els.tip = $('marker-tip');
    if (els.arrowMode) els.arrowMode.value = state.arrowMode;
    // 记忆上次选的主题（file:// 下 localStorage 也可用，失败就忽略）
    try {
      var savedTheme = localStorage.getItem('mrawu-theme');
      if (savedTheme === 'light' || savedTheme === 'dark') state.theme = savedTheme;
    } catch (e) { /* 忽略 */ }
    if (els.theme) els.theme.value = state.theme;
    applyTheme();

    // 模型下拉：按分组（经典力学 / 万有引力 / 电磁学…）用 optgroup 组织
    (function () {
      var groups = [];
      PFA.models.list.forEach(function (m) {
        var g = m.group || '其他';
        if (groups.indexOf(g) < 0) groups.push(g);
      });
      groups.forEach(function (g) {
        var og = document.createElement('optgroup');
        og.label = g;
        PFA.models.list.forEach(function (m) {
          if ((m.group || '其他') !== g) return;
          var opt = document.createElement('option');
          opt.value = m.id;
          opt.textContent = m.title;
          og.appendChild(opt);
        });
        els.modelSelect.appendChild(og);
      });
    })();
    // 只打包了本题对应模型时，模型卡片没有意义（下拉里就一项）→ 直接隐藏
    var cardModel = $('card-model');
    if (cardModel && PFA.models.list.length <= 1) cardModel.style.display = 'none';
    var initial = (location.hash || '').replace('#', '');
    state.modelId = PFA.models.byId[initial] ? initial : (PFA.models.list[0] && PFA.models.list[0].id);
    els.modelSelect.value = state.modelId;
    state.params = PFA.models.defaults(PFA.models.get(state.modelId));

    bind();
    resize();
    bake(false);
    setPlaying(true);
    requestAnimationFrame(tick);
  }

  // 供测试/截图脚本驱动：初始布局 = 侧边栏收起 + 下边栏展开（画布最大）
  PFA.player = { init: init, state: state, bake: bake,
    setDrawer: function (v) { if (state.setDrawer) state.setDrawer(v); },
    setBottom: function (v) { if (state.setBottom) state.setBottom(v); } };
})(typeof globalThis !== 'undefined' ? globalThis : this);
