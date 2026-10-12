/*!
 * MrAwU（阿物先生）— 模型注册表
 * 模型 = { id, title, subtitle, tags, params[], build(params) -> scene, expect(params) -> 对照项[] }
 * build 必须返回纯数据（可直接 JSON 序列化），这样浏览器端无需 fetch 即可内联。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory([
      require('./shared.js'),
      require('./mechanics.js'),
      require('./motion.js'),
      require('./gravity.js'),
      require('./electric.js'),
      require('./combo.js')
    ]);
  } else {
    root.PFA = root.PFA || {};
    root.PFA.models = factory([
      root.PFA.models_mechanics,
      root.PFA.models_motion,
      root.PFA.models_gravity,
      root.PFA.models_electric,
      root.PFA.models_combo
    ]);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (groups) {
  'use strict';
  var list = [];
  groups.forEach(function (g) {
    if (!g || typeof g.register !== 'function') return;
    g.register(function (m) { list.push(m); });
  });
  // 模型白名单：构建「只给某一道题」的单文件 HTML 时由模板注入
  //   window.PFA_MODEL_FILTER = ["plankPush"]
  // 这样交给老师的文件里就只有这道题对应的模型，不会混进斜面、圆周运动等无关模型。
  // （Node 端工具不过滤，保持全量以便跑回归测试。）
  // hidden: true 的模型不进下拉（框架已就绪但还没补完的组合）
  list = list.filter(function (m) { return !m.hidden; });
  var filter = (typeof globalThis !== 'undefined' && globalThis.PFA_MODEL_FILTER) || null;
  if (filter && filter.length) {
    var kept = list.filter(function (m) { return filter.indexOf(m.id) >= 0; });
    if (kept.length) list = kept;
  }

  var byId = {};
  list.forEach(function (m) { byId[m.id] = m; });

  function defaults(model) {
    var p = {};
    (model.params || []).forEach(function (it) { p[it.key] = it.value; });
    return p;
  }

  return {
    list: list,
    byId: byId,
    get: function (id) { return byId[id]; },
    defaults: defaults,
    /** 用参数构造并规范化一个场景；extra 用于传入"手动编辑过"的额外数据（如静电场的手动电荷列表） */
    scene: function (id, params, sceneLib, extra) {
      var m = byId[id];
      if (!m) throw new Error('未知模型: ' + id);
      var p = Object.assign(defaults(m), params || {});
      var raw = m.build(p, extra);
      raw.id = raw.id || id;
      raw.params = p;
      raw.modelId = id;
      return sceneLib ? sceneLib.normalize(raw) : raw;
    }
  };
});
