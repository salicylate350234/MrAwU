# 新增模型契约与 probe 规格

> 从 `SKILL.md` 移出（原文逐字保留）。什么时候读：往 `lib/models/` 里加一个模型时。

## 新增模型契约

在 `lib/models/mechanics.js` 或 `motion.js` 里加一个对象，风格照抄现有模型（ES5 写法、UMD-lite 包装）：

```js
function myModel(p) {           // p = 参数对象
  return {
    title: '模型名', subtitle: '一句话说明', tags: [...],
    meta: { g: p.g, duration: ..., dt: 1/60, subSteps: 4 },
    view: { height: 560 },
    bodies: [ { id, type, shape, at, angle, mass, friction, restitution, label, color, showForces, velocity } ],
    joints: [ { kind: 'rod'|'rope'|'pivot'|'slider'|'pulley'|'weld', a, b, worldAnchorA, worldAnchorB, length, ... } ],
    forces: [ { kind: 'constant'|'drag'|'spring'|'torque', body, force, k, rest, c, ... } ],
    notes: '解析：...'
  };
}
myModel.expect = function (p) {   // 解析解 + 对应的测量探针
  return [ { label: '加速度 a', unit: 'm/s²', value: 计算值,
             probe: { kind: 'accel', body: 'block', project: [cos, sin], signed: true, window: [0.2, 1.5] } } ];
};
```

注册到 `register(add)` 里，参数表 `params` 决定 HTML 里出现哪些滑杆。

**几何必须随参数自适应**：静态几何给足长度（取景会自动裁到轨迹上），
或者按解析行程反推必需长度与时长上限，绝不能让物块滑出斜面/带面/木板，
也不能让采样窗口落在物理已经结束的阶段——否则平均值对不上解析解。

### probe 规格（`lib/verify.js`）

| 字段 | 含义 |
|---|---|
| `kind` | `accel` / `velocity` / `position` / `force` / `impulse` / `stat` / `period` |
| `body` | 刚体 id |
| `comp` | 当 kind=force 时取哪个分量：`gravity`/`normal`/`friction`/`joint`/`applied`/`total` |
| `project` | 投影方向（世界坐标单位矢量），如沿斜面方向 `[cosθ, sinθ]` |
| `signed` | true 保留符号，false 取绝对值 |
| `mode` | `dot`（投影，默认）或 `mag`（矢量模长） |
| `window` | `[t0, t1]` 秒，只在该区间求平均 |
| `reduce` | `max` / `last` / `first`（默认平均） |
| `center` | 仅 `period`：过零点的中心位置 |

解析值为 0 的项用 `absTolerance`（绝对容差），不要用相对误差。
