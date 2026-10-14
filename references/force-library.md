# 力组件库（lib/forces.js）——一页纸

> 什么时候读：给模型写/改受力律时；怀疑"力读数和物理对不上"时。
> 上一轮修 `lib/models/track.js` 花了 20 分钟，代价几乎全在力律层：`side` 漏拷 ⇒ 法向反号却
> 被**静默跳过**（症状伪装成自由落体、机械能 −162 J）；`potential` 又返回 `mgy−qEx` ⇒
> 重力势能记两遍；投影用上一步弧长 ⇒ 理想约束做净功。库化就是为了从结构上消灭这四类错。

## 组件清单

| 组件 | 力 | 额外势能 U | 备注 |
|---|---|---|---|
| `gravity({body,m,g})` | `[0,−mg]` | **恒为 0** | 引擎已自己加 mgy，见约定 ① |
| `uniformElectric({body,q,E,regions})` | `qE`（区域外 0） | `−q(E·r)`（区域外 0） | regions 空=全场；含边界 |
| `coulomb({body,q,charges,k,rMin})` | `Σ k·q·Qᵢ·rᵢ/\|rᵢ\|³` | `Σ k·q·Qᵢ/\|rᵢ\|` | 固定点电荷系；`charges=[{x,y,Q}]`（Q 自带符号，也接受 field.js 的 `q` 键）；r→0 **抛错并打印状态**，不钳制不静默 |
| `curveNormal({body,m,g,geometry,electric})` | `N·n̂` | 0 | `N=m·v_t²κ−F_其它·n̂`；见约定 ② |
| `kineticFriction({body,mu,geometry,electric,surfaceNormal})` | `f·t̂`（含静摩擦咬住） | 0 | 判据：近静止且 `|F_t|≤μN` ⇒ `f=−F_t` |
| `staticFriction(...)` | 同上，只留咬住分支 | 0 | 与动摩擦**同一处判据** |
| `spring({body,k,c,anchor,rest})` | `−k(L−rest)r̂−c·v` | `½k(L−rest)²` | 阻尼项不进势能 |
| `drag({body,c})` | `−c·v` | 0 | 耗散 |

组合器：`composeForces(components,{geometry,potential})` → `{force,potential,forceDetail,audits}`。
`force(t,S,lock)` 可直接挂到模型的 `laws` 上；`audits.energy(frames,{body,potential})` 用**帧数据**
独立算 `KE+mgy+U`（不读模型自己的 analytics/mechanical），报 `dE_last / dE_worst / rel_worst`。

## 三个必须记住的约定

1. **势能只含额外项。** 引擎 `verlet.buildFrame` 已经 `stats.potential += m·g·(y−refY)`，
   再把 `laws.potential` 的返回值**累加**上去。所以 `potential` 只能返回 mgy 之外的部分
   （重力组件恒返回 0，电场返回 `−qE·r`）。返回 `mgy−qEx` ⇒ `KE+2mgy−qEx`，全程不守恒。
2. **接触法向 `n̂` 指向曲率中心（内壁），且 `N<0` 必须报错。** `N<0` 表示已脱离；库的默认行为是
   **抛错并打印 t/s/N/κ/v_t**。要么给 `onNeg(info,S)` 显式处理（脱离信号 + 按 exitPolicy 处置），
   要么把判定放 `project`。**禁止静默跳过**（跳过 = 力表里法向凭空消失，症状指向完全错误的物理）。
   直线段 `κ=0`，`n̂` 取"球所在的一侧"，**由段的 `side` 决定**（漏拷 `side` 就是上一轮的坑）。
3. **力表按 part 记账。** 返回 `{bodyId:{parts:{gravity,electric,normal,friction,…}}}`，分项名
   必须取自引擎 `PARTS`（`verlet.js`）；写错名字的力**不会产生任何效果**、力表里却看得见。
   组合器在 `composeForces` 时就校验分项名，并要求每个组件都给出 `potential`（力/势能强制成对）。
   事件/约束直接改速度的部分归 `verlet.bookDelta` 记账，组件本身是**纯函数**（不碰状态）。

## 30 行内组合一个新模型（斜面 + 圆轨道内壁 + 匀强电场）

```js
var path = trackLib.makePath({ segments: [
  { kind: 'line', a: A, b: J, mu: mu, side: -1 },                       // side 必须给！
  { kind: 'arc', c: O, r: R, a0: thJ, a1: thJ - 2*Math.PI, mu: mu, inner: true, cyclic: true }
]});
if (path.checkTangency(1e-6).length) throw new Error('未相切');          // 几何先校验，别带着错跑
var laws = trackLib.makeTrackLaws({ path: path, body: 'ball', mass: m, g: g, q: q,
  field: { E: [E, 0], regions: null }, exitPolicy: 'stop' });            // 几何/弧长/事件/脱离归它
var geometry = function (ctx, commit) { return laws._pathState(ctx.S, !!commit); };  // commit=false！
var elec = forces.uniformElectric({ body: 'ball', q: q, E: [E, 0] });
var normal = forces.curveNormal({ body: 'ball', m: m, g: g, geometry: geometry,
  electric: elec.force, onNeg: function (info) { pending = info; return [0, 0]; } });  // 见约定 ②
var fr = forces.kineticFriction({ body: 'ball', m: m, g: g, mu: mu, geometry: geometry,
  electric: elec.force, surfaceNormal: function (c) { return normal.normalForce(c); } });
var c = forces.composeForces([forces.gravity({ body: 'ball', m: m, g: g }), elec, normal, fr],
  { geometry: geometry });
laws.force = c.force;              // ⚠️ 只覆盖 force/potential；project/nextEvent/onEvent 归 track.js
laws.potential = c.potential;      // 额外势能（电场）；重力势能由引擎加
// 自检：c.audits.energy(frames, { body: 'ball', potential: function(S){ return -q*E*S.ball.x; } })
```
要点：`geometry(ctx, commit)` 里 **commit 只在 `project` 中为 true**；`force` 里必须按传入状态
取几何（`__ps` 已在组件间共享），否则法向方向滞后 ⇒ 约束做净正功 ≈ `m·v⁴h²/2R²`（实测 0.35 J/s）。
组件级测试见 `node/tests.mjs` 末尾（数值求导核对 `−∇U=F`、边界判定、`N<0` 抛错、静摩擦咬住）。
