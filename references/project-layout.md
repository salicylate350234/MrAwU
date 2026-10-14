# 项目全貌、目录结构与运行环境

> 从 `SKILL.md` 移出（原文逐字保留）。什么时候读：需要弄清这个 skill 的分工与卖点、某个目录/脚本负责什么，
> 或在新机器上准备运行环境时。

## 分工与核心卖点（原文）

把一张物理图变成"会动、能验算"的受力动画。分工是固定的：

| 环节 | 由谁做 |
|---|---|
| 识图、判断题型、量测几何、建模 | 你（模型）读图 + 推理 |
| 数值积分、接触力/约束力求解 | planck.js（Box2D 的 JS 移植） |
| 展示、播放、滑杆调参 | 单文件 HTML（只负责显示，不含任何业务逻辑上的"猜"） |

核心卖点是**动画能自我验算**：每个模型都带解析解对照表（例如斜面 `a = g(sinθ−μcosθ)`、`N = mgcosθ`），
以及一个严格的机器自检 `|ΣJ − Δp|`（冲量-动量定理残差）。残差≈0 说明受力图画对了；对照表全绿说明物理对了。

## 目录结构

```
MrAwU/
  SKILL.md               本文件
  README.md              给老师的部署与使用说明（可直接转发）
  lib/                   浏览器与 Node 共用的同一份代码
    scene.js             场景契约：单位、坐标、形状几何、校验
    world.js             场景 → planck 世界（刚体/关节/外力/传送带）
    sim.js               仿真 + 受力分解 + 逐帧记录 + 残差自检
    verify.js            「解析值 vs 仿真值」对照
    draw.js              渲染器（受力箭头、图例、HUD、两套主题）
    graph.js             画布下方的 x-t / v-t 图像 + 播放头 + 时间轴断口
    field.js             静电场可视化：电场线追踪、等势线 marching squares、场强矢量网格
    verlet.js            自研速度-Verlet 积分后端（轻量版用它替代 planck）
    models/              模型库（每个模型自带 build + expect）
      shared.js          跨文件共享的受力律构件（如"重力+地面"）
      mechanics.js       经典力学：斜面/自由落体/传送带/板块/连接体/滑轮/弹簧
      motion.js          经典力学：平抛斜抛/圆周运动/碰撞/三力平衡
      gravity.js         万有引力：双星系统
      electric.js        电磁学：静电场（点电荷系·电场线/等势线/场强矢量）
      index.js            注册表（分组：经典力学 / 万有引力 / 电磁学）
  browser/
    template.html        播放器页面骨架（构建时把一切内联进去）
    player.js            播放器逻辑（滑杆、逐帧、图层、对照表）
  node/
    check-env.mjs        环境自检（一条命令列出必需项并逐项确认）
    sim.mjs              单模型/单场景无头仿真 + 报告
    tests.mjs            回归测试（解析解 + 残差，全绿才算过）
    audit.mjs            受力可见性审计（非零却画不出来的力）
    build.mjs            打包成单文件 HTML
    package.mjs          跑测试+审计+构建，产出交付包与源码包
    qa.mjs               把关键帧渲染成 PNG 供目视自检
  CHECKLIST.md           环境清单 + "拍照 → 出模型"全流程（可直接转发）
  vendor/planck.min.js   物理引擎（MIT），构建时内联，运行时不联网
  dist/                  交付物：单文件 HTML + 交付包/源码包 zip
  build/                 中间产物（报告、QA 图片）
```

## 环境

系统 PATH 里可能没有 `node`，用绝对路径；**不要** `npm install` 任何东西来跑主流程（引擎已 vendored）：

```
NODE = <DSH 自带 node>\node.exe   （本机示例：C:\Users\<你的用户名>\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe）
```

仅生成 GIF/预览 PNG 才需要可选依赖 `@napi-rs/canvas`（已装在 skill 目录下）。

**改这些源码文件时只用 write/edit 工具，绝不要用 PowerShell 的 `Get-Content`/`Set-Content` 管道改写**——
会按 ANSI 重写 UTF-8，中文变乱码并吞掉换行（踩过一次，整个文件报废）。
