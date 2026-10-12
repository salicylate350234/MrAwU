# 场景契约（scene schema）

场景是纯数据（可直接 JSON 序列化），所以能内联进 HTML、也能让老师粘贴到播放器里运行。
单位一律 **SI**（米、千克、秒、牛顿），世界坐标 **y 轴向上**；画布 y 轴向下由渲染器统一翻转。

```jsonc
{
  "schema": "mrawu/scene@1",
  "id": "incline",
  "title": "斜面滑块",
  "subtitle": "动摩擦：物块沿斜面下滑",
  "notes": "解析：a = g(sinθ − μcosθ)，N = mg cosθ，f = μN",

  "meta": {
    "g": 10,                 // 重力加速度 m/s²
    "duration": 2.5,         // 动画时长 s
    "dt": 0.016666666666666666, // 输出帧间隔（默认 1/60）
    "subSteps": 4,           // 每个输出帧内部再分几步积分（默认 4 → 内部 1/240 s）
    "velocityIterations": 8,
    "positionIterations": 3,
    "linearDamping": 0,
    "angularDamping": 0,
    "energyRefY": 0,         // 势能零点
    "frictionPairs": [       // 精确指定某一对接触面的摩擦/恢复系数
      { "a": "block", "b": "board", "friction": 0.4 }
    ]
  },

  "view": {
    "width": 1000, "height": 560,
    "padding": 48,           // 固定留白（像素）；取景还会额外为力箭头留 1.1 m
    "grid": true,
    "background": "#0d1220"
  },

  "bodies": [ /* 见下 */ ],
  "joints": [ /* 见下 */ ],
  "forces": [ /* 见下 */ ]
}
```

## bodies[]

| 字段 | 说明 |
|---|---|
| `id` | 唯一标识，关节/外力用它引用 |
| `type` | `static` / `dynamic` / `kinematic` / `belt`（belt 是 kinematic 的特例，自带带速） |
| `shape` | 形状，见下表 |
| `at` | `[x, y]` 初始位置（m） |
| `angle` / `angleDeg` | 初始转角（弧度 / 度） |
| `mass` | 质量（kg）。给了 mass 就按面积反推密度，planck 会据此算转动惯量 |
| `density` | 或者直接给密度（kg/m²） |
| `friction` | 摩擦因数，默认 0.4 |
| `restitution` | 恢复系数，默认 0 |
| `velocity` | `[vx, vy]` 初速度（m/s） |
| `angularVelocity` | 初角速度（rad/s）；kinematic 刚体用它做匀速转动（如转盘） |
| `fixedRotation` | 是否禁用转动 |
| `bullet` | 高速物体开启连续碰撞检测 |
| `gravityScale` | 重力倍率（默认 1） |
| `label` / `color` | 显示用 |
| `showForces` | 是否画受力箭头（静态支撑面通常设为 false） |
| `sensor` | 是否只做检测不产生接触力 |

### shape

| kind | 字段 | 说明 |
|---|---|---|
| `box` | `w`, `h` | 矩形（宽、高，以中心为原点） |
| `circle` | `r` | 圆 |
| `polygon` | `points: [[x,y], ...]` | 凸多边形（局部坐标） |
| `wedge` | `w`, `angleDeg` | 直角三角形斜面（左下角为原点） |
| `edge` | `a`, `b` | 线段（局部坐标）。**斜面用这个**：给足长度，再配合 `angle` |
| `track` | `r`, `segments`, `thickness` | 圆轨道：用 n 段静态边近似（弦高误差随段数平方衰减，64 段足够） |
| `belt` | `w`, `h` | 传送带面（配合 `type: "belt"` 与 `speed`） |

> `edge` 用**局部坐标**存储，刚体的 `angle` 会整体旋转它；渲染与碰撞用的是同一套变换。

## joints[]

| kind | 关键字段 | 说明 |
|---|---|---|
| `rod` | `a`, `b`, `length`, `worldAnchorA/B` | 刚性杆（DistanceJoint），固定长度，可拉可推 |
| `rope` | 同上 | 绳（RopeJoint），只能拉，长度是上限 |
| `pivot` | `a`, `b`, `worldAnchor` | 转动铰链（RevoluteJoint）；`enableMotor`/`motorSpeed`/`maxMotorTorque` 可驱动转动 |
| `slider` | `a`, `b`, `worldAnchor`, `axisDeg` | 移动副（PrismaticJoint）；`lowerTranslation`/`upperTranslation` 限位 |
| `pulley` | `a`, `b`, `groundAnchorA/B`, `worldAnchorA/B`, `lengthA`, `lengthB`, `ratio` | 滑轮（约束 lengthA + ratio·lengthB = 常数） |
| `weld` | `a`, `b`, `worldAnchor` | 焊接 |
| `wheel` | `a`, `b`, `worldAnchor`, `axisDeg` | 带弹簧的轮轴（frequencyHz / dampingRatio） |

`a` 或 `b` 写 `"world"` 表示接到世界（会自动建一个无夹具的静态锚点）。
关节默认不与自己连接的两个刚体碰撞（`collideConnected: true` 可打开）。

> **滑轮注意**：planck 的 `PulleyJointDef` 要 `lengthA`/`lengthB`，不是 `length`；
> 且某一侧绳长趋于 0 时关节会退化，几何必须按行程自动展开（见 Atwood 模型的写法）。

## forces[]（显式外力，每步仿真前施加）

| kind | 字段 | 说明 |
|---|---|---|
| `constant` | `body`, `force: [fx,fy]`, `at: [lx,ly]` | 恒力；`at` 是作用点（局部坐标），影响力矩 |
| `drag` | `body`, `k`, `quadratic` | 阻力 `F = −k·v`（`quadratic: true` 时为 `−k·|v|·v`） |
| `spring` | `a`, `b`, `anchorA/B`, `worldAnchorA/B`, `rest`, `k`, `c` | 弹簧/弹性绳：`F = −k(x−x₀) − c·v_rel`，两端各受反向力 |
| `torque` | `body`, `value` | 恒定力矩（N·m） |

> 弹簧是**显式力**而不是隐式约束（planck 1.5 的 DistanceJoint 没有刚度参数），
> 所以它会如实出现在受力分解里，代价是有 O((ωΔt)²) 的离散误差（实测 < 0.01%）。

## 帧结构（仿真的输出，用于渲染与对照）

```jsonc
{
  "t": 0.0166,
  "dt": 0.0166,
  "bodies": {
    "block": {
      "x": 3.7, "y": 3.36, "angle": 0.64,
      "vx": 1.94, "vy": 1.46, "w": 0,
      "mass": 2, "inertia": 0.27,
      "forces": {                       // 单位：N
        "gravity": [0, -20], "normal": [-27.7, 36.8], "friction": [-18.4, -13.9],
        "joint": [0, 0], "applied": [50, 0], "damping": [0, 0],
        "total": [3.9, 2.9], "totalTorque": 0
      },
      "contacts": [                     // 逐个接触点，含真实法向与大小
        { "other": "incline", "point": [x, y], "normal": [-0.6, 0.8],
          "normalForce": 46.06, "frictionForce": -23.03, "force": [x, y] }
      ],
      "joints": [ { "id": "rope", "kind": "rod", "side": "B", "force": [x, y], "torque": 0 } ],
      "accel": [1.94, 1.46],
      "impulse": [0.065, 0.049],        // 本帧受到的总冲量 J（N·s）
      "momentum": [3.9, 2.9],           // 本帧动量 p = mv
      "residual": 0.0                   // |ΣJ − Δp| 的相对残差（受力自检）
    }
  },
  "stats": {
    "kinetic": 1.2, "potential": 66.2, "mechanical": 67.4,
    "momentumX": 0.71, "momentumY": 0.54, "residualMax": 0.0
  }
}
```

**为什么用冲量做分解**：冲量-动量定理 `ΣJ = Δp` 在每一帧内严格成立，
所以 `residual = |ΣJ − Δp| / (|Δp| + |ΣJ|)` 可以当作"受力图画得对不对"的机器自检。
正常是 0.0xx%，出现 ~100% 说明某个力的符号/方向错了。
碰撞这类冲激过程也不会因为采样时刻不同而抖动。展示时再除以帧时长换算成平均力（N）。
