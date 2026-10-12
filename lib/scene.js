/*!
 * MrAwU（阿物先生）— lib/scene.js
 * 场景契约：单位、坐标、形状几何、默认值、校验。
 * 双模：Node 用 require()，浏览器挂到 globalThis.PFA.scene
 *
 * 约定：物理世界一律 SI 单位（米、千克、秒），y 轴向上；
 *       画布 y 轴向下，由 lib/draw.js 统一翻转。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.PFA = root.PFA || {};
    root.PFA.scene = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var SCHEMA = 'mrawu/scene@1';

  var PALETTE = [
    '#e8934a', '#5fa8ff', '#4fd08a', '#c58cff', '#ffd166',
    '#ff7b8a', '#7ce0d3', '#b8b8ff', '#f4a261', '#8ecae6'
  ];

  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function num(v, d) { return isNum(v) ? v : d; }

  // ---------------------------------------------------------------- 形状几何

  function wedgePoints(w, angleDeg) {
    // 直角三角形：左下角为原点，底边长 w，斜面与水平夹角 angleDeg
    var h = w * Math.tan(angleDeg * Math.PI / 180);
    return [[0, 0], [w, 0], [w, h]];
  }

  function shapePoints(shape) {
    var k = shape.kind;
    if (k === 'box') {
      var hw = shape.w / 2, hh = shape.h / 2;
      return [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]];
    }
    if (k === 'wedge') return wedgePoints(shape.w, shape.angleDeg);
    if (k === 'polygon') return shape.points.map(function (p) { return [p[0], p[1]]; });
    if (k === 'plank') {
      var hw2 = shape.w / 2, hh2 = shape.h / 2;
      return [[-hw2, -hh2], [hw2, -hh2], [hw2, hh2], [-hw2, hh2]];
    }
    return null;
  }

  function polygonArea(pts) {
    var a = 0;
    for (var i = 0; i < pts.length; i++) {
      var p = pts[i], q = pts[(i + 1) % pts.length];
      a += p[0] * q[1] - q[0] * p[1];
    }
    return Math.abs(a) / 2;
  }

  /** 面积（m²）。静态/线状形状返回 0。 */
  function shapeArea(shape) {
    var k = shape.kind;
    if (k === 'circle') return Math.PI * shape.r * shape.r;
    if (k === 'edge' || k === 'track' || k === 'ground' || k === 'belt') {
      if (k === 'belt') return (shape.w || 0) * (shape.h || 0.2);
      if (k === 'ground') return (shape.w || 0) * (shape.h || 0.5);
      return 0;
    }
    var pts = shapePoints(shape);
    return pts ? polygonArea(pts) : 0;
  }

  function shapeCentroidOffset(shape) {
    // 相对刚体原点的质心偏移：凸多边形用面积加权，圆为 0
    var pts = shapePoints(shape);
    if (!pts) return [0, 0];
    var a = 0, cx = 0, cy = 0;
    for (var i = 0; i < pts.length; i++) {
      var p = pts[i], q = pts[(i + 1) % pts.length];
      var cross = p[0] * q[1] - q[0] * p[1];
      a += cross;
      cx += (p[0] + q[0]) * cross;
      cy += (p[1] + q[1]) * cross;
    }
    if (Math.abs(a) < 1e-12) return [0, 0];
    return [cx / (3 * a), cy / (3 * a)];
  }

  /** 形状的局部包围盒 [[xmin,ymin],[xmax,ymax]] */
  function shapeBounds(shape) {
    if (shape.kind === 'circle') {
      return [[-shape.r, -shape.r], [shape.r, shape.r]];
    }
    if (shape.kind === 'edge') {
      return [[Math.min(shape.a[0], shape.b[0]), Math.min(shape.a[1], shape.b[1])],
              [Math.max(shape.a[0], shape.b[0]), Math.max(shape.a[1], shape.b[1])]];
    }
    if (shape.kind === 'track') {
      var ro = shape.r + (shape.thickness || 0.12);
      return [[-ro, -ro], [ro, ro]];
    }
    var pts = shapePoints(shape);
    if (!pts) return [[0, 0], [0, 0]];
    var xmin = Infinity, ymin = Infinity, xmax = -Infinity, ymax = -Infinity;
    pts.forEach(function (p) {
      xmin = Math.min(xmin, p[0]); xmax = Math.max(xmax, p[0]);
      ymin = Math.min(ymin, p[1]); ymax = Math.max(ymax, p[1]);
    });
    return [[xmin, ymin], [xmax, ymax]];
  }

  // ---------------------------------------------------------------- 归一化

  var DEFAULT_BODY = {
    type: 'dynamic',
    angle: 0,
    mass: null,
    density: null,
    friction: 0.4,
    restitution: 0.0,
    color: null,
    label: null,
    showForces: true,
    fixedRotation: false,
    gravityScale: 1,
    velocity: [0, 0],
    angularVelocity: 0,
    bullet: false,
    sensor: false
  };

  var DEFAULT_META = {
    g: 10,
    dt: 1 / 60,
    subSteps: 4,
    duration: 3,
    velocityIterations: 8,
    positionIterations: 3,
    linearDamping: 0,
    angularDamping: 0,
    frictionPairs: [],
    stopWhenAsleep: false
  };

  var DEFAULT_VIEW = {
    width: 1000,
    height: 560,
    padding: 48,
    fit: 'auto',            // auto | fixed
    follow: null,           // 刚体 id：镜头跟随（仅在 fit 失败时使用）
    pxPerM: null,
    center: null,
    background: '#0d1220',
    grid: true,
    gridStep: 1
  };

  function normalize(scene) {
    if (!scene || typeof scene !== 'object') throw new Error('scene 必须是对象');
    var s = {
      schema: SCHEMA,
      id: scene.id || 'scene',
      title: scene.title || '未命名场景',
      subtitle: scene.subtitle || '',
      notes: scene.notes || '',
      mode: scene.mode || 'dynamic',       // dynamic | static
      meta: Object.assign({}, DEFAULT_META, scene.meta || {}),
      view: Object.assign({}, DEFAULT_VIEW, scene.view || {}),
      bodies: [],
      joints: [],
      forces: [],
      // 尺寸标注：板块/传送带题的关键量是「相对位移」，画成带箭头的尺寸线 + 数值
      // { a, anchorA, b, anchorB, axis:'x'|'y'|'auto', offset:米, label:'Δx' }
      dimensions: scene.dimensions || [],
      // 临界时刻：x-t/v-t 的时间轴在这些时刻断开一点，鼠标移上去弹出物理说明
      // { t: 秒, label: '共速', note: '为什么这里是临界' }
      markers: scene.markers || [],
      // 自研 Verlet 后端的受力律（声明了它就不用 planck；见 lib/verlet.js）
      laws: scene.laws || null,
      // 只有自研引擎能算的模型（例如双星的相互引力，planck 侧没有这种力）：
      // 自检时跳过 planck，只对解析解
      verletOnly: !!scene.verletOnly,
      // 场可视化模型（静电场）：电荷表 + 场参数，由 lib/field.js 绘制
      field: scene.field || null,
      noGraph: !!scene.noGraph,
      // 组合模组：chain 实例（阶段时间表 / 交接记录都在它上面）+ 阶段清单。
      // 不登记这两个字段，expect 就拿不到"刚刚跑过的那一份"阶段时间，窗口会全变 NaN。
      compose: scene.compose || null,
      stages: scene.stages || (scene.compose ? scene.compose.stages : null),
      handoffs: scene.handoffs || (scene.compose ? scene.compose.handoffs() : null),
      // 受力小窗用的分析坐标系 x 轴（模型声明；不声明则用世界水平/垂直）：
      //   斜面 → 沿斜面向下；平抛/类平抛/圆周 → 水平。见 SKILL.md 4g。
      analysisAxis: scene.analysisAxis || null,
      params: scene.params || null,
      expect: scene.expect || null,
      tags: scene.tags || []
    };
    if (!scene.bodies || !scene.bodies.length) throw new Error('scene.bodies 不能为空');
    var seen = {};
    s.bodies = scene.bodies.map(function (b, i) {
      if (!b.id) throw new Error('bodies[' + i + '] 缺少 id');
      if (seen[b.id]) throw new Error('重复的刚体 id: ' + b.id);
      seen[b.id] = true;
      if (!b.shape || !b.shape.kind) throw new Error('刚体 ' + b.id + ' 缺少 shape.kind');
      var nb = Object.assign({}, DEFAULT_BODY, b);
      nb.at = b.at ? [b.at[0], b.at[1]] : [0, 0];
      if (b.angleDeg != null) nb.angle = b.angleDeg * Math.PI / 180;
      // 静态几何（地面/斜面/天花板）用中性深色，别去抢动态物体的调色板颜色，
      // 否则"地面"会被画成和滑块一样的橙色粗条。
      nb.color = nb.color || (nb.type === 'static' ? '#3a4a63' : PALETTE[i % PALETTE.length]);
      nb.label = nb.label || b.id;
      if (nb.type === 'belt') {
        nb.type = 'kinematic';
        nb.isBelt = true;
        nb.beltSpeed = num(b.speed, 2);
        delete nb.speed;
      }
      return nb;
    });
    s.joints = (scene.joints || []).map(function (j, i) {
      if (!j.kind) throw new Error('joints[' + i + '] 缺少 kind');
      return j;
    });
    s.forces = (scene.forces || []).map(function (f, i) {
      if (!f.kind) throw new Error('forces[' + i + '] 缺少 kind');
      if (f.kind === 'spring') {
        if (!f.a && !f.b) throw new Error('forces[' + i + '] (spring) 需要 a 或 b');
      } else if (!f.body) {
        throw new Error('forces[' + i + '] 需要 body');
      }
      return f;
    });
    if (s.meta.subSteps < 1) s.meta.subSteps = 1;
    s.meta.simDt = s.meta.dt / s.meta.subSteps;
    s.meta.frames = Math.max(1, Math.round(s.meta.duration / s.meta.dt));
    return s;
  }

  function validate(scene) {
    var errs = [], warns = [];
    var s = scene;
    var ids = {};
    s.bodies.forEach(function (b) { ids[b.id] = b; });
    s.bodies.forEach(function (b) {
      var a = shapeArea(b.shape);
      if (b.type === 'dynamic') {
        if (b.mass == null && b.density == null) {
          if (a > 0) warns.push(b.id + ': 未给 mass/density，按 density=1 处理');
          else errs.push(b.id + ': 动态刚体需要 mass 或 density');
        }
        if (b.mass != null && a <= 0) errs.push(b.id + ': 形状面积为 0，无法由 mass 推 density，请改给 density');
      }
      var pts = shapePoints(b.shape);
      if (pts && polygonArea(pts) < 1e-9 && b.shape.kind !== 'box') {
        warns.push(b.id + ': 形状面积近似为 0');
      }
    });
    s.joints.forEach(function (j, i) {
      ['a', 'b'].forEach(function (side) {
        var ref = j[side];
        if (ref && ref !== 'world' && !ids[ref]) errs.push('joints[' + i + '].' + side + ' 指向不存在的刚体 ' + ref);
      });
      if (j.kind === 'distance' && !(j.length > 0) && !(j.length === 0)) {
        warns.push('joints[' + i + '] (distance) 未给 length，将由初始位置推算');
      }
    });
    s.forces.forEach(function (f, i) {
      if (f.kind === 'spring') {
        ['a', 'b'].forEach(function (side) {
          if (f[side] && f[side] !== 'world' && !ids[f[side]]) errs.push('forces[' + i + '].' + side + ' 指向不存在的刚体 ' + f[side]);
        });
      } else if (!ids[f.body]) {
        errs.push('forces[' + i + '].body 指向不存在的刚体 ' + f.body);
      }
    });
    return { ok: errs.length === 0, errors: errs, warnings: warns };
  }

  /** 静态几何 (不含动态体轨迹) 的世界包围盒 */
  function staticBounds(s) {
    var xmin = Infinity, ymin = Infinity, xmax = -Infinity, ymax = -Infinity;
    function add(x, y) {
      xmin = Math.min(xmin, x); xmax = Math.max(xmax, x);
      ymin = Math.min(ymin, y); ymax = Math.max(ymax, y);
    }
    s.bodies.forEach(function (b) {
      if (b.type === 'dynamic' && !b.includeInBounds) return;
      var bb = shapeBounds(b.shape);
      [[bb[0][0], bb[0][1]], [bb[1][0], bb[1][1]], [bb[0][0], bb[1][1]], [bb[1][0], bb[0][1]]]
        .forEach(function (p) {
          var c = Math.cos(b.angle), sn = Math.sin(b.angle);
          add(b.at[0] + p[0] * c - p[1] * sn, b.at[1] + p[0] * sn + p[1] * c);
        });
    });
    if (!isFinite(xmin)) { xmin = -1; xmax = 1; ymin = -1; ymax = 1; }
    return { xmin: xmin, ymin: ymin, xmax: xmax, ymax: ymax };
  }

  return {
    SCHEMA: SCHEMA,
    PALETTE: PALETTE,
    shapeArea: shapeArea,
    shapePoints: shapePoints,
    shapeBounds: shapeBounds,
    shapeCentroidOffset: shapeCentroidOffset,
    wedgePoints: wedgePoints,
    polygonArea: polygonArea,
    normalize: normalize,
    validate: validate,
    staticBounds: staticBounds,
    num: num
  };
});
