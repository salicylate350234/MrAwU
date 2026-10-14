# 契约速查（一页纸）——权威：源码；本页只做索引

> **任何模型任务先读这一页 + `engine-contract.md` + `model-contract.md`。**
> 与源码不一致时以源码为准，并把差异记回本节。核对基准（本页数据来源）：
> `lib/verlet.js`、`lib/sim.js`、`lib/scene.js`、`lib/verify.js`、`lib/draw.js`、`lib/models/*.js`。

## 1. 模型契约（`lib/models/index.js`）

```
{ id, title, group, params[], build(params[, extra]) -> scene, expect(params, ctx) -> items[] }
```
| 字段 | 约定 |
|---|---|
| `params[]` | `{ key, label, unit, min, max, step, value }`；`defaults()` 按 `it.value` 生成默认参数，HTML 滑杆按此渲染 |
| `build(p, extra)` | 必须返回**纯数据**（可 JSON 序列化）；`extra.charges`/`extra.probes` 是播放器手动编辑的电荷/探针 |
| `expect(p, ctx)` | `ctx = { scene, frames }`；组合模组靠 `ctx.scene.compose` 拿"刚跑过的阶段时间表" |
| `hidden: true` | 不进下拉，但仍可被测试点名（`index.js:40`） |
| `verletOnly: true` | 跳过 planck 对拍。**仅在 planck 侧根本没有这种力时加**：相互万有引力、点电荷场、电场力、无动力学纯场模型（`gravity.js:105`、`electric.js:144/308/409`、`combo.js:174`）；有 planck 等价实现就**不加**，否则丢掉唯一的独立验证 |
| 注册 | `register(add)` 内 `add({...})`；`index.js` 按组装配 |

## 2. `laws` 接口（`scene.laws`；最贵也最容易写错）

调用点全在 `lib/verlet.js`。状态 `S = { bodyId: { x, y, vx, vy } }`，只含 `type:'dynamic'` 的刚体。

| 成员 | 签名 / 返回 | 何时被调用（关键） |
|---|---|---|
| `initial` | `{ bodyId: [x,y,vx,vy] }`，元素可缺省 | 建 sim 时**一次性**覆盖初始状态（`verlet.js:65`） |
| `lock(S)` | `{ slidingSign: ±1 }` 或 `null` | **每个子步开头一次**，把受力分支锁定整个子步（`verlet.js:105`） |
| `force(t, S, lock)` | `{ bodyId: { parts: { gravity,gravitation,electric,normal,friction,joint,applied,damping: [fx,fy] } } }`；也接受 `{ bodyId: { f:[fx,fy] } }` 简写 | ⚠️ **每个子步调用 2 次**：F1 用子步起点状态 + `t=子步中点`，F2 用预测状态 `S1` + **同一个** `t`（`verlet.js:106,118`） |
| `nextEvent(t, S)` | 严格大于 `t` 的时刻或 `null` | **每个子步一次，在子步之前**；返回的时刻会把子步切短，绝不跨过（`verlet.js:173-176`） |
| `onEvent(t, S)` | `{ bodyId: { part: 'normal'|'friction'|... } }` 或 `null` | 子步**推进到事件时刻之后**调用一次，状态改动经 `bookDelta` 记账（`verlet.js:179-184`） |
| `project(t, S)` | 同上（可返回 `null` 表示没改状态） | **每个子步之后都调用一次**；直接改 `S` 的位置/速度做约束/消漂移（`verlet.js:187`） |
| `potential(t, S)` | 一个 number（额外势能） | **每帧一次**（`buildFrame`，`verlet.js:273-276`） |
| `jointItems(t, S)` | `[{ id, kind, body, force:[fx,fy], torque?, side? }]` | **每帧一次**，供受力表显示绳/杆张力（`verlet.js:205`） |

### ⚠️ 三条致命约定

1. **`force` 里绝对不能写回 `S`**。同一子步内它被调用两次（F1 起点、F2 预测点），写回会污染第二次的输入：
   上一轮就在 `force` 里更新了"弧长基准"，导致每个子步记两次、持续能量泄漏 ✗。`force` 必须是**纯函数**：
   只读 `t/S/lock`，返回力表；要改状态一律放 `project` / `onEvent`。
2. **`project`/`onEvent` 里改状态必须返回分类**（`{bodyId:{part:'normal'}}`），否则 `bookDelta` 会用兜底分类
   （`onEvent` 默认 `friction`，`project` 默认 `normal`，`verlet.js:182/187`），残差 `|ΣJ−Δp|` 会飙到百分之几 ✗
   （实测 7.69%）。只改位置、不改速度 → 不会产生冲量，返回 `null` 即可（对比 `slopeLaws.project` 与 `connectorLaws.project`）。
3. **`potential` 的返回值是"加在引擎已有势能之上"的额外项**。引擎已经自己累加了 `m·g·(y − meta.energyRefY)`
   （`verlet.js:238`），所以**重力和 mgy 绝不能再写进 `potential`**：上一轮 `mgy` 记了两遍，
   机械能根本不守恒 ✗。`potential` 只放引擎不会算的项：万有引力势 `−Gm₁m₂/r`（`gravity.js:82`）、
   电势能 `−qEx`（`electric.js:292`，注意零场区必须写 `Math.min` 钳成常量）。

## 2.5 `lib/pacing.js` —— 动画时长/步长标定（**时长由解析总时间决定**）

约定：**不再固定 `dt = 1/60 s`**。固定步长只在"秒级宏观"题上成立；电子/微观题总时间常在
ns~μs 量级，固定步长会把整段运动挤进一帧（实测 `efieldDeflect` 真实电子参数：只出 **1 帧**，
加速度仿真 −1200 vs 解析 −1e10 m/s²）。所有模型都应把解析总时间交给 `pacing()`。

```js
var pacing = require('../pacing.js').pacing;      // 浏览器：window.PFA.pacing.pacing
var pace = pacing({ tTotal: L.dur, frames: 600, subSteps: 8 });
// → { duration, dt, subSteps, frames, tTotal, margin }
//   duration = tTotal × 1.02（默认 2% 余量）；dt = duration / frames（frames 默认 600，
//   被 minFrames(520)/maxFrames(4000) 约束）；subSteps 原样返回（离散化敏感度由模型定）
```
- `tTotal ≤ 0` / NaN / `frames < 1` / `minFrames > maxFrames` 一律**抛错并打印入参**，不静默兜底。
- 极端尺度稳：`tTotal ∈ [1e-10, 1e3] s`（只做除法，不按秒取整）。
- ⚠️ **配套的引擎修复**（`lib/verlet.js`）：早期 `advanceTo` 用绝对容差 `t < tTarget − 1e-12`
  当停止条件，微观尺度下（`dtSim = 8.5e-13 s`）**每帧少走 1 个子步**、时间永远差 12.5%
  （帧内平均加速度 −8.75e9 vs −1e10）。现在改成步进精确 + 事件时刻作为推进上限 +
  `laws.enter`（事件时刻的入场处理）也会被调用。改这三处后 495 项回归保持 0 失败。

### 2.6 `pacing.assertResolution()` —— "整段挤进一帧"的兜底闸门

```js
var assertResolution = require('../pacing.js').assertResolution;   // 浏览器：window.PFA.pacing.assertResolution
var pace = pacing({ tTotal: 解析总时间, frames: 600, subSteps: 8 });
assertResolution({ duration: pace.duration, characteristicTime: pace.dt / pace.subSteps,
                   frames: pace.frames, minFramesPerChar: 50 });
// → { duration, characteristicTime, frames, minFramesPerChar, ratio }；不达标**抛错并打印实际数值**
```
- **语义**：`characteristicTime` 传的是**引擎内层实际步长**（`dt / subSteps`，再加 `1e-12 s`
  的浮点地板），不是题目总时间。于是判据 `duration / characteristicTime >= 50` 等价于
  **"整段至少 50 个内层步"**（正常走 `pacing()` 时恒等于 `frames × subSteps ≥ 3000`；
  注意该比值只反映"步长是否跟着解析总时间走"，与题目参数无关）。
- **它拦的是"模型自己固定步长"**：若把 §① 那个 4 ns 电子题按旧写法（`duration = 1/60 s`、
  4 子步）交上来 → `duration/内层步 = 4.0 < 50` 直接抛错，而不是给出"落地 / 偏转在第一帧
  就完成了"的动画（自测见 `node/_assert_probe.cjs --bad`）。
- 已接入：`lib/models/motion.js` 的 `projectile`、`lib/models/mechanics.js` 的 `freefall`
  （两者时长改为由**解析滞空 / 落地时间**反推）。

### 2.7 为什么其余模型**故意保留固定时长**（不需要 pacing）

用户的要求是"所有题目都按解析总时间定时长"。本轮迁移了两个"时间随参数变化明显"的低风险
模型（`projectile`、`freefall`）；其余 11 个评估后**保留固定 / 参数化时长**，理由分四类：

| 类 | 为什么固定时长是对的 |
|---|---|
| 秒级宏观题（`energy`、`collision`、`circular`、`balance`、`atwood`） | `dt = 1/60 s` 本来就有 30 ~ 200 帧，特征时间 0.5 ~ 10 s；时长就是用户滑杆的"演示时长"，改成"解析总时间"只会把过程之外的静止段一起拉长 |
| 时长已由**解析周期**推出（`spring`、`pendulum`、`wave` 等） | `T = 2π√(m/k)` / `2π√(L/g)` 本身就是解析量，与"按解析总时间定时长"等价 |
| 时长已按**解析位移**反推行程（`incline`、`connector`） | 几何随"演示时长 × 解析加速度"自动展开（`inclineEdgeLen`），不存在采样不足 |
| 时长由**解析时间表**驱动（`belt`、`plank`、`plankPush` 等） | 共速 / 相对滑动结束这类时刻由 `nextEvents` 精确触发，帧内事件不会丢 |

判据：只有当"题目特征时间可能比 `1/60 s` 小几个量级"时固定步长才退化；上面各条都满足
`特征时间 ≫ dt`，所以保留固定时长不产生采样问题。`assertResolution` 就是这条判断的兜底 ——
以后谁把某个模型推到微观参数（或固定一个过小的 frames），它会立刻抛错，不会静默给出垃圾。
详见 `references/pitfalls.md` 的 ③。


## 3. 力表形状与渲染映射

- 八个分项**固定**：`gravity, gravitation, electric, normal, friction, joint, applied, damping`
  （`verlet.js:28` 的 `PARTS`；帧里按它通用构造，写死 6 项会让新分项凭空消失，`verlet.js:249`）。
  单项可不写 → 按 0 处理（`accelOf` 有 `if (p[k])` 守卫，`verlet.js:90`）；但**帧里永远有全 8 项**。
  ⚠️ 不过 planck 路径的 `total` 是**显式相加 8 项**（`sim.js:238`），verlet 路径只累加 `force()` 真给出的项——
  少数 laws（如 `mechanics.js:622` 的 `slopeLaws`）省略 `gravitation/electric`，于是同一场景两条路径的
  帧内 `total` 会差一个 0。单引擎下自洽、不影响残差，但**跨引擎比 `total` 前先看这条**；稳妥做法是把 8 项都显式写出来。
- 帧内每项是**平均力** `[fx,fy]`（N）= 本帧冲量 / 帧时长（`verlet.js:219`）；`impulse` 是未除时长的 ΣJ。
- 渲染/读数映射：`lib/draw.js` 的 `LABELS`（`draw.js:28`，`gravity→重力 G`、`gravitation→万有引力 F引`、
  `electric→电场力 F电`、`normal→支持力 N`、`friction→摩擦力 f`、`joint→绳/杆张力 T`、`applied→外力 F`、
  `damping→阻尼`、`total→合力`）与 `T.arrow[k]`（`draw.js:51` 主题色表，`|| T.arrow.total` 兜底）。
- 受力小窗在**以运动方向为 x 轴的坐标系**里做正交分解（`draw.js:1080`）；
  `scene.analysisAxis = [xAxis, yAxis]` 覆盖世界水平/垂直（`scene.js:194`），
  **只有斜面题声明它**（`mechanics.js:55`、`mechanics.js:137`），播放器按实际运动方向翻转符号（`browser/player.js:303`）。

## 4. 场景字段白名单（`lib/scene.js` `normalize()`）⚠️

`normalize()` **只放行它认识的键，其余静默丢弃**（这个坑已重犯多次 ✗）。新增字段**必须**同时登记。

| 字段 | 说明 | 默认 |
|---|---|---|
| `schema` | 固定 `'mrawu/scene@1'` | 自动 |
| `id/title/subtitle/notes/mode` | 元信息；`mode: dynamic\|static` | `scene`/`未命名场景`/`''`/`''`/`dynamic` |
| `meta` | `g, dt, subSteps, duration, velocityIterations, positionIterations, linearDamping, angularDamping, frictionPairs, stopWhenAsleep`；`normalize` 另算 `simDt=dt/subSteps`、`frames=duration/dt`。⚠️ `meta` 是 `Object.assign` **整体合并、不过白名单**，`energyRefY`（势能零点，`verlet.js:210`）就是这么传的 | `g=10, dt=1/60, subSteps=4, duration=3` |
| `view` | `width, height, padding, fit, follow, pxPerM, center, background, grid, gridStep` | `1000×560, padding 48, fit auto` |
| `bodies` | 见 `scene.js:115` 的 `DEFAULT_BODY`；`type:'belt'` 会被改写成 `kinematic + isBelt + beltSpeed`。形状 `kind` 白名单见 `shapePoints/shapeArea/shapeBounds`：`box, circle, wedge, plank, polygon, edge, track, ground, belt`（几何只认这些；`line/arc` 是并行的 `lib/track.js` 新加的，加完需同步登记）。刚体上另有读取点：`includeInBounds`（取景，`scene.js:288`）、`sign`（极板正负号，`draw.js:769`）、`angleDeg`（会被换算成 `angle`） | 必填非空 |
| `joints` | `{ kind, a, b, worldAnchorA/B, length, … }` | `[]` |
| `forces` | `{ kind:'constant'\|'drag'\|'spring'\|'torque', body, force, k, rest, c }` | `[]` |
| `dimensions` | `{ a, anchorA, b, anchorB, axis, offset, label }`（相对位移尺寸线） | `[]` |
| `markers` | `{ t, label, note }`（临界时刻，x-t/v-t 断开 + tooltip） | `[]` |
| `laws` | 受力律对象；**声明了它就走 verlet**（`sim.js:27`） | `null` |
| `verletOnly` | 布尔，跳过 planck 对拍 | `false` |
| `field` | `{ charges, k, … }`，静电场（`lib/field.js`） | `null` |
| `noGraph` | 不画 x-t/v-t | `false` |
| `compose` / `stages` / `handoffs` | 组合模组实例 + 阶段表 + 交接记录（后两者缺省会从 `compose` 推） | `null` |
| `analysisAxis` | `[xAxis, yAxis]`，受力小窗建系 | `null` |
| `display` | `{ scaleY, note, target, vertical }`，**过小就放大并标注**：`scaleY` 只作用于物体位置与轨迹的绘制（力/速度箭头、尺寸读数一律真实）。未登记会被 `normalize()` 静默丢弃 ⚠️ | `null`（scopeY≠1 才生效） |
| `params` / `expect` / `tags` | `index.js` 会自动回填 `params`；`expect` 供对照表用 | `null`/`null`/`[]` |

## 5. `expect` 探针规格（`lib/verify.js` `measure`/`run`）

对照项：`{ label, unit, value, probe, tolerance?, absTolerance? }`。

| `probe.kind` | 读什么 |
|---|---|
| `force` | `b.forces[probe.comp \|\| 'total']`（`comp` 取八个分项之一或 `total`） |
| `velocity` / `position` / `accel` | `[vx,vy]` / `[x,y]` / `b.accel` |
| `impulse` | `b.impulse`（一帧的 ΣJ，碰撞要用 `reduce:'sum'`） |
| `contactNormal` | `b.forces.normal` |
| `relative` | 相对 `probe.ref` 的位移；`relativeTo:'initial'` → 相对滑动位移 |
| `stat` | 末帧（或 `at:'first'` 初帧）刚体量或 `stats[key]`；`key:'a.b'` 取两级 |
| `statDelta` | 末帧 − 初帧的 `stats[key]`（机械能/动量变化） |
| `eventTime` | 给了 `at`（+`axis`, `dir`）→ 首次越过该位置**帧内插值**时刻；否则 → 相对速度首次 ≤ `tol` 的时刻 |
| `period` | 投影坐标同向过零的间隔（`center` 给中心位置） |
| `fieldAt` | 由 `lib/field.js` 独立重算该点场；`part:'V'` 取电势否则取场强 |
| `chargeCount` | `scene.field.charges.length` |
| `interface` | 组合交接：`which:'state'`(读 `h.at`/`h.v`) / `'pos'` / `'vel'`(相对速度跳变) / `'impulse'` |

通用修饰：`body`(刚体 id)、`project`(单位矢量，默认 `[1,0]`)、`mode:'dot'|'mag'`(默认 dot)、
`signed`(true 保号 / false 取绝对值，默认 false)、`window:[t0,t1]`（`t > t0 && t <= t1`，取不到帧就回落到全部帧）、
`around:{comp:'x'|'y'|'speed', dir:'max'|'min', pad, first, firstTol}`（自动把窗口套在轨迹极值点上）、
`reduce:'max'|'last'|'first'|'sum'|'maxAbs'`（**默认平均**；冲量必须 `sum`）、`jointId`（多绳时只取某一根）。

判定：`tolerance` 优先取对照项上的，其次 `probe.tolerance`，都没有则 **0.005**；
`|value| < 1e-6` 时自动切绝对误差（默认 0.01）。

⚠️ **`absTolerance` 必须写在对照项上，不能写进 `probe`**：`run()` 只读 `it.absTolerance`
（`verify.js:283`），写进 `probe` 是死代码，会被当成相对误差判定 ✗（上一轮踩过）。

## 6. 读文件的正确姿势

1. 先读本页 + `engine-contract.md` + `model-contract.md`（三份加起来百余行，覆盖 90% 的接口问题）。
2. 再用 `grep` 定位符号，**用行范围读**（`read --offset/--limit`），不要整读。
3. **禁止通读 >300 行的文件**（`draw.js` 1350 行、`solve.mjs` 509 行、`sim.js` 370 行、
   `verlet.js` 305 行、`track.js`）：先在本页找到"在哪一节/哪个函数"，再定向读那 20–40 行。
4. 改任何"引擎/场景契约"前，先确认本页对应条目与源码一致；不一致就改文档，别照猜的写。

## 7. 常用命令速查（`node` 用绝对路径）

| 命令 | 用途 |
|---|---|
| `node node/quick.mjs --model <id> [--params '{...}'] [--brief] [--engine verlet\|planck] [--list]` | 单模型秒级反馈（≤12 行）：末态/残差/能量漂移/对照项 |
| `node node/sim.mjs --model <id> [--params] [--report] [--scene f.json] [--export f.json] [--list]` | 无头仿真 + 受力报告 |
| `node node/solve.mjs --model <id> --param <k> --range lo:hi [--step] --watch <量> --target <v> [--tol] [--json]` | 临界值扫描 + 二分 + 复验（退出码 3 = 未找到） |
| `node node/audit.mjs [--brief\|--quiet\|--verbose]` | `\|ΣF − m·a\|` 残差 + 力箭头可见性审计 |
| `node node/compare-engines.cjs [--model <id>] [--brief\|--quiet]` | verlet vs planck 双引擎对拍（交付闸门） |
| `node node/tests.mjs [--only a,b] [--verbose]` | 全库回归（全绿才算过） |
| `node node/build.mjs --title "题名" --models <id,id> --out "dist/题名.html" [--engine verlet\|planck]` | 打包单文件 HTML（`--models` 是硬规则） |
| `node node/qa.mjs --model <id> --times 0.2,1.2,2.4` | 出 PNG 帧供目视自检 |
