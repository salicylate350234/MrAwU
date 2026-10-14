# 精度边界与常见坑

> 从 `SKILL.md` 移出（原文逐字保留）。什么时候读：数值对不上、残差异常、图形被裁，
> 或要如实告诉用户精度边界时。

## 精度与边界（必须如实告知用户）

- **2D 平面力学**。planck 是 Box2D 的移植，没有三维。圆锥摆、空间力系做不了。
- **刚体 + 库仑摩擦**。接触力在求解器里是冲量，程序按 `J/Δt` 折算成力；
  碰撞瞬间的接触力会随步长（默认 1/240 s）变化，所以同时给逐帧值与区间平均值。
- **静摩擦**在求解器里是"接触点约束力"，不是真静摩擦模型；大 μ 静止时读数可靠，
  但接近临界角（μ≈tanθ）时会有微小抖动。
- 绳索用刚性杆（`rod`）或最大长度约束（`rope`）近似，都是无质量、无伸长的理想绳。
- 弹簧是显式力（`spring`：F = −k(x−x₀) − cv），不是隐式约束，
  所以周期会有 O((ωΔt)²) 的离散误差（实测 < 0.01%）。
- 传送带用**运动学带面**实现（planck 没有带面速度原语），已实测与解析解一致。
- 滑轮在某一侧绳长趋于 0 时会退化（Box2D 的已知问题），所以几何要按行程自动展开。

## 常见坑（都踩过）

1. **必须关闭休眠**：`world.setAllowSleeping(false)`。planck 的方法名是 `setAllowSleeping`，
   写错成 `setAllowSleep` 会静默失效——结果静止刚体休眠，接触力全部归零，静态受力图直接失效。
2. `body.getLinearVelocity()` 返回的是**内部引用**，会随仿真变化。要留存历史值必须先取标量（`.x`/`.length()`）再深拷贝。
3. `PulleyJointDef` 要的是 `lengthA`/`lengthB`，不是 `length`；还要给 `anchorA`/`anchorB`。
4. 关节反力的符号约定各关节不统一（`PulleyJoint` 与其它相反），所以滑轮改用几何量算张力方向；
   **任何符号错误都会立刻表现为残差≈100%**，用残差守门。
5. 力箭头会被画布边缘裁掉——取景的边距里必须包含箭头长度（`draw.js` 里做了迭代自洽）。

### 已知覆盖缺口：belt 在 v0 = 带速时（求解器 node/solve.mjs 顺带发现）

- 现象：`belt` 模型当 `v0` 恰等于带速时**不存在相对滑动**，而它的 expect 仍按“滑动摩擦 f = μN”“相对滑动阶段加速度 = μg”断言，
  于是 2/3 项 FAIL。回归只跑默认参数，所以一直没暴露。
- 影响：只影响“恰好共速”这一点的对照项，不影响其它参数下的结论。
- 待办：补“无相对滑动分支”的对照项（此时 f 由静摩擦决定、a = 0），或在 expect 里显式标注适用条件 v0 ≠ 带速。

### 临界条件求解器的适用边界（node/solve.mjs）

- 它按“观察量过 `--target` 的**连续**符号变化”找临界值，已在 4 个手算例子上验证（误差 1.1e-7 ~ 0.2%）。
- 若模型的临界表现为**阶跃**（例：`trackSlopeLoopE` 在 v0 < v_min 时直接“脱离→冻结”，法向力被钳到 0），
  则扫描端点会一直“高于目标”，工具如实报“未找到临界值”而不是瞎猜。
- 这种情形请改用“二分一个布尔量”（例如“是否发生冻结”）；`trackSlopeLoopE` 的 v_min 就是这样独立核对的：
  实测 c_min = 5·secα 在 θ = 20/30/37/45/53/60° 上偏差 ≤0.007%，与解析式一致。

### ⚠️ force() 里绝对不能改状态（力库重构时实测踩到）

- 现象：让“组件层发现的 N<0”在 `force()` 里直接调用离开轨道/冻结 —— **残差飙到 84.77%、末帧速度 4206 m/s**。
- 原因：`force()` 每个子步被调用**两次**（F1 用起点态、F2 用预测态），在其中改动状态会被该子步的 A1/A2 写回，且冲量记账对不上。
- 正解：`force()` 只**声明**（例如声明脱离、本子步余下分项给 0），一切状态改动放到 `project()`/`onEvent()`，由引擎 `bookDelta` 记账。

### 跨引擎不对称：forces.total 与 totalTorque

- verlet 路径只累加 `force()` **实际返回**的分项（`verlet.js:90`），planck 路径显式相加固定 8 项（`sim.js:238`）。省略分项的模型（如 `slopeLaws` 省了 gravitation/electric）**跨引擎比 total 构成本身会不同**（单引擎自洽，残差不受影响）。
- verlet 的 `totalTorque` 恒为 0，planck 会计入关节/接触力矩（现有探针未使用，影响未验证）。
- 原则：新力库的组合器应始终输出完整 8 分项（含 0），让用库的模型天然跨引擎一致。

### 场景字段/形状白名单的静默陷阱（清单补充）

- `scene.js` 的 `normalize()` 只放行认识的字面量：新增场景字段必须同时登记，否则**静默丢弃**。
- 刚体 `kind` 必须在 `shapePoints/shapeArea/shapeBounds` 三处都认识，否则几何退化成 `[[0,0],[0,0]]`（**解析路径**不受此限：`lib/track.js` 的 `kind:line/arc` 是路径声明、不是刚体形状）。
- 已被真实读取但不在白名单表里的项：`meta.energyRefY`、刚体 `includeInBounds`、刚体 `sign`。
- 本轮新增并已登记：`scene.display`（`{scaleY, note, target, vertical}`，见 api-index §4），
  以及 `lib/pacing.js` 的 `pacing()` 接口（见 api-index §2.5）。

### ① 固定 `dt = 1/60 s` 在 ns 尺度题目上会退化成一帧（实测）

- 现象：真实电子题（L=4 cm、E=91/1600 V/m、m=9.1e-31 kg、q=1.6e-19 C、v₀=2e7 m/s，
  解析总时间 t = 4e-9 s）跑 `efieldDeflect`：
  ```
  时长 0.00 s / 1 帧（dt = 1/60 s，8 子步）
  场区内加速度  解析 −1.0e10 m/s²  vs  仿真 −1200 m/s²（差 100%，FAIL）
  出板偏移 y₁   解析 −2.0e-8 m   vs  仿真 −0.3333 m
  ```
  整个 4 ns 的过程落在 16.7 ms 的一帧里，帧内平均加速度只剩 a·t₁/dt ≈ −1200。**这不是精度问题，是采样定理问题。**
- 正解：`lib/pacing.js` 的 `pacing({tTotal, frames:600, subSteps})` 由**解析总时间**反推
  `dt = 1.02·tTotal/frames`。修完 600 帧、全部对照项 PASS（含能量守恒）。
- 连带坑（同一根因，必须一起修，否则"步长对了但时间还是错的"）：
  `lib/verlet.js` 的 `advanceTo` 用绝对容差 `1e-12 s` 当停止条件，微观尺度下**每帧少走 1 个子步**，
  时间永远差 12.5%（帧内平均加速度 −8.75e9 vs −1e10）；事件判据 `ev < tTarget` 排除了
  "事件正好在帧边界"这一支，荧光屏吸收因此失效（屏上偏移偏 0.053%）。两处都已修。

### ② PowerShell 会吃掉 JSON 双引号：给 CLI 传 JSON 要用 Node spawn 或写文件

- 现象：本会话被咬三次——`node node/sim.mjs --params '{"q":1.6e-13,...}'` 在 PowerShell 里
  引号被剥掉/重排，参数根本没传进去，跑出来还是默认参数（症状：以为模型有 bug）。
- 正解（二选一）：
  1. 用 Node 的 `child_process.spawnSync(node, ['node/sim.mjs', '--params', JSON.stringify(p)])`
     —— 参数是**数组元素**，不过 shell 解析；
  2. 或把 JSON 写进文件再 `--params @file`（同理，写文件用 `fs.writeFileSync(p, t, 'utf8')`，
     **别用 `Set-Content -Encoding UTF8`**：Windows PowerShell 会写入 BOM）。
- 另注：`Select-String` / `-replace` 处理探针脚本时容易静默不匹配（本会话踩过一次：
  替换没生效却以为生效，白追了 4 轮参数标定）。
- **同一个坑还有第三种形态（本会话又踩到）**：用 PowerShell 的 `-replace ... | Set-Content -Encoding ascii`
  改中文源码会把非 ASCII 字符全部写成 `?`（实测把 `node/_assert_probe.cjs` 的中文注释全变成
  `????`，脚本直接 `SyntaxError`）。改文件一律 `fs.writeFileSync(p, t, 'utf8')` 或编辑器工具，
  别让 PowerShell 碰编码。

### ③ `pacing` 的兜底断言：`assertResolution()`（本轮新增）

- **现象（同一个根因的另一种触发）**：`pacing()` 只保证 `dt = duration / frames`，保证不了
  "这个 dt 够不够分辨题目"。谁要是**自己固定一个步长**（例如旧写法的 `dt = 1/60 s`）而题目
  特征时间是 ns 级，界面照样出帧、数值照样算，但帧里只剩平均量 —— 就是 ① 里那个
  `-1200 vs -1e10 m/s²`。这类错误**不会自己喊**。
- **写法**：`assertResolution({ duration, characteristicTime, frames, minFramesPerChar })`，
  默认要求 `duration / characteristicTime >= 50`。`characteristicTime` 传**引擎内层步长**
  （`dt / subSteps`，含 `1e-12 s` 浮点地板），于是判据就是"整段至少 50 个内层步"。
  不满足 → **抛错并打印实际数值**（`duration / characteristicTime / frames / minFramesPerChar`
  与入参 JSON），绝不返回一个看起来正常的场景。
- **实测**（`node node/_assert_probe.cjs --bad`，固定 1/60 s + 1 帧）：
  ```
  整段时长只覆盖 4.00000 倍特征时间（要求 ≥ 50）；帧数 1 少于一个特征时间里应有的 50 帧
  实际数值：duration = 0.016666666666666666 s、characteristicTime = 0.004166666666666667 s、
            frames = 1、minFramesPerChar = 50
  ```
- ⚠️ **这个比值与题目参数无关**（正常走 `pacing()` 时恒等于 `frames × subSteps`）：所以
  "把 h 改成 1e-6 m" 这种极端参数**不会**触发它 —— 会触发的是"步长没跟着解析总时间走"。
  想验证断言真的会响，就得把步长（或 frames）按旧写法喂进去，别指望极端参数。
- 本轮迁移：`projectile`（解析滞空时间）、`freefall`（√(2h/g)）；其余 11 个模型保留固定时长
  的理由见 `references/api-index.md` §2.7。

### ④ 展示层两个坑（本轮修掉）

- **画布上的说明文字别放右上角**：右上角浮着 `#force-panel`（受力小窗，`position:absolute;
  top:20px; right:22px`），`drawDisplayNote` 原来画在右上角 → 截图里被面板压住 / 裁掉，
  等于"过小就放大并标注"这条约定失效 ✗。现在改画**左上角**（左下角是力标尺图例、
  右上角是受力小窗，左上角空着）。
- **微观题的时间读数换格式**：`t = 0.00 s` 对 4 ns 的题等于没显示（老师会以为时间没在走）。
  现在 `t < 1e-3 s` 用科学计数法（`t = 2.0×10⁻⁹ s`）；播放倍率另开一栏显示
  （自适应 = 整段约 6 s 播完，界面写 `自适应 ×1.5×10⁹`），并且**倍率只影响播放**、
  不乘进 `t`。
- **标注里的数字必须逐项核对**：上一轮把 `v_y`（20 m/s）写成了 `2.0×10⁷`（那是 `v₀`）。
  标错数字比不标更糟 —— 写进说明的量必须在 `expect()` 里有对应出处。
改脚本后**先打印那一行确认**再跑。

### ⑤ 本机 shell 现状：DSH 工具调用可能落在 Windows PowerShell 5.1（务必知道）

- 自检事实：本机 `pwsh` 曾**不在 PATH** 上，于是 DSH 的 `pwsh -Command` 回退到 **Windows PowerShell 5.1**（`PSEdition: Desktop`）✗。
  5.1 的两大坑：**原生命令参数里的双引号会被吃掉**（传 JSON 必炸）、**`Set-Content -Encoding UTF8` 会写 BOM**（EF BB BF）。
- 对策（按可靠性排序）：
  1. 给原生命令传 JSON 等复杂参数：**用 Node `spawnSync` 自己控制 argv**，或写进文件；不要指望 shell 转义。
  2. 写文本文件：用 Node 的 `fs.writeFileSync(p, t, 'utf8')`，或指定绝对路径的 pwsh：
     `& "C:\Program Files\PowerShell\7\pwsh.exe" -NoProfile -Command ...`（PS 7 的 `Set-Content -Encoding utf8` 不写 BOM）。
  3. 让 harness 直接用 pwsh：把 `C:\Program Files\PowerShell\7` 加入 PATH 并**重启 DSH**（PATH 变更不会影响已运行的进程）。
- 自检命令：`node node/shell-check.mjs`（会报告 pwsh 是否可用、脚本里是否还有 `powershell` 调用）。
