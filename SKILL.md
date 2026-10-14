---
name: MrAwU
description: 阿物先生（MrAwU）——把物理受力分析图或题目图片转成可交互的受力动画（单文件 HTML）。识别图中的物体、斜面、绳滑轮、传送带、圆轨道、匀强电场、静电场、双星等，用自研 velocity-Verlet 积分器精确计算每一帧的受力（重力/支持力/摩擦力/绳张力/外力/电场力/万有引力/合力），并生成带力箭头、力读数、正交分解、解析值对照的离线动画。适用于中学及大学力学与电磁学教学、受力分析讲解、习题演示。当用户提供物理题图片、受力图、斜面/传送带/板块/滑轮/圆周运动/碰撞/电场/双星等场景，或要求生成受力动画、受力分析演示、物理动画时使用。
---

# 阿物先生（MrAwU）

把物理题图变成"会动、能验算"的受力动画（单文件 HTML，离线可用）。
识图 / 判断题型 / 量测几何 / 建模由你读图 + 推理；积分与接触力求解由自研 velocity-Verlet（`lib/verlet.js`，交付物唯一后端）；
展示与滑杆调参由 HTML 负责。每个模型都带解析解对照表与残差自检 `|ΣJ − Δp|`：
**残差≈0 说明受力图画对了，对照表全绿说明物理对了。** 原文分工表与卖点见 `references/project-layout.md`。

## 安全底线（任何一步都不能省）

1. **力的作用点 = 重心**：所有箭头从重心起画（受力小窗把各分力平移到同一作用点再正交分解）；
   接触力方向用真实法向/切向，箭头不允许被画布裁掉。
2. **牛顿第二定律残差必须过**：`|ΣF − m·a|`、`|ΣJ − Δp|` 最大相对值 < 0.5%（≈100% = 受力符号/方向错了）。
3. **解析解对照必须全 PASS**：`expect()` 手算值 vs 仿真值 ≤ 0.5%；对不上先怀疑探针/窗口/几何，最后才怀疑引擎。
4. **双引擎对拍必须过**：`node node/compare-engines.cjs` 全绿才能交付。
   自研路径残差是代数恒等式、**不再是独立验证**，正确性只由"对解析解 + 对 planck"保证。
5. **二维做不了的题不许硬做**：如实告知（清单见 `references/archetypes.md`）。

## 标准工作流

```
拍照/题图 → 量测表 → 选题型 → 填参数或写模型 → 验证 → 出 HTML → 目视自检 → 交付
```

1. **量测**：`read_image` 后先写量测表（量 / 是否标注 / 采用值 / 依据）；没标的量必须问用户或声明默认值，像素只定比值。
2. **选题型**：按下面决策树；能用现成模型就只改参数（`node node/sim.mjs --list`）。
3. **建模**：`node node/quick.mjs --model <id> --params '{...}'` 秒级试参数；新模型见 `references/model-contract.md`。
4. **验证**：`quick.mjs` → `audit.mjs --brief` → `compare-engines.cjs --brief` → `tests.mjs`（全库回归必须 0 失败）。
5. **出 HTML**：`node node/build.mjs --title "题名" --models <id> --out "dist/题名.html"`。
   **`--models` 是硬规则**：单文件里只能有这道题对应的模型，绝不混进无关题型。
6. **目视自检**：`node node/qa.mjs --model <id> --times 0.2,1.2,2.4` + `read_image` 看 PNG（数值对但图画歪同样不可交付）。
7. **交付**：`present` 那个 HTML，说明"双击就能用、不装 node/python、不联网"；`AI_DISCLOSURE.md` 与 `LICENSE` 随包。

## 决策树：遇到题先判断

| 情形 | 怎么做 | 去哪读 |
|---|---|---|
| 已有题型 | 现成模型改参数（改动越小越可靠） | `references/archetypes.md` |
| 两个模组首尾相接（加速电场→偏转电场、斜面→圆轨道内壁） | `compose.chain()` + 接口静态校验 | `references/field-and-compose.md` |
| 静电场 / 匀强电场 / 场叠加 | `scene.field` + 场探针 | `references/field-and-compose.md` |
| 反求临界（"至少 / 恰好 / 最小"） | `node node/solve.mjs` 扫描 + 二分 + 复验 | `README.md` 第三节 |
| 必须新建模型 | 写 `build(p)` + `expect(p)`，再对拍全绿 | `references/model-contract.md` |
| 二维做不了（水平面内圆周、转盘、空间力系…） | 如实告知，不硬做 | `references/archetypes.md` |

## 按需查阅索引（一句话说明何时该读；文件都在 `references/` 下）

| 文件 | 什么时候读 |
|---|---|
| `archetypes.md` | 判断题型 / 组合配方，二维能不能做。 |
| `project-layout.md` | 项目全貌、目录与脚本清单、环境准备。 |
| `workflow.md` | 标准流程细节与命令速查。 |
| `engine-contract.md` | 迁移 / 新增受力律 `xxxLaws`、怀疑引擎物理分支。 |
| `field-and-compose.md` | 静电场 / 匀强电场、模组首尾拼接。 |
| `view-ui.md` | 渲染取景、模型/视图变换、受力小窗与建系、QA 截图。 |
| `model-contract.md` | 新增模型：`build(p)`、`expect(p)` 探针规格、几何自适应。 |
| `pitfalls.md` | 数值对不上、残差异常、图形被裁、精度边界。 |
| `scene-schema.md` | 场景 JSON 完整字段（bodies / joints / forces / 帧）。 |
| `verification.md` | 解释"凭什么算得对"、核对回归判据。 |
| `image-to-scene.md` | 识图建模规范与外法向符号校验实例。 |
| `engine-comparison.md` | planck vs Verlet 的精度 / 耗时 / 体积实测。 |
| `optimization-baseline.md` | 成本基线（token / 工具次数 / 单题画像）。 |
| `README.md` | 老师端部署说明；兼容性声明在第六节（改依赖必须同步）。 |
| `CHECKLIST.md` | 可直接转发的环境清单与全流程。 |

## 环境

`node` 可能不在 PATH，用绝对路径（本机：`C:\Users\<用户名>\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe`）；
主流程**不要** `npm install`。改源码**只用 write/edit**，绝不用 PowerShell `Get-Content`/`Set-Content` 改写（会按 ANSI 重写 UTF-8、中文乱码）。
