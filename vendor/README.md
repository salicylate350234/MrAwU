# vendor/ — 第三方代码

| 文件 | 组件 | 版本 | 许可 |
|---|---|---|---|
| `planck.min.js` | [Planck.js](https://github.com/piqnt/planck.js)（Box2D 的 JavaScript 移植） | 1.5.0 | MIT（© Erin Catto, Ali Shakiba） |

## 它在这里做什么

**只用于 Node 侧的自检对拍**（`node/compare-engines.cjs`）：把本项目自研的 velocity-Verlet
积分器算出的末态，与这个独立实现的引擎对照，用来降低"自检脚本自己给自己判分"的风险
（见 `AI_DISCLOSURE.md` §2.4）。

## 重要：不要把它打进交付文件

- 交付给老师的单文件 HTML **不包含** planck：`node/build.mjs` 默认 `--engine verlet`，
  只内联自研引擎（体积也因此从约 950 KB 降到约 400 KB）。
- `--engine planck` 仅用于生成对照版做本地复核，不用于交付。

## 更新方式

换版本时直接替换本文件，然后跑：

```bash
node node/compare-engines.cjs   # 应保持 26/26 通过
```

许可证头保留在文件开头（`@license The MIT license`），不要删除。
