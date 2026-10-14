/*!
 * MrAwU（阿物先生）— lib/pacing.js
 * 动画时长/步长标定：**时长由解析总时间决定**（不再固定 dt = 1/60 s）
 *
 * 为什么需要它（实测驱动，不是审美问题）：
 *   过去所有模型都写死 `meta.dt = 1/60 s`。这条约定只在"秒级宏观"题上成立：
 *   斜面上的物块、传送带、圆周运动，特征时间本来就是 0.5 ~ 10 s，1/60 s 的步长能给出
 *   几十到几百帧，动画既连续又看得清。
 *   但电子/微观题的总时间常在 **ns ~ μs** 量级，固定步长会让整段运动挤进一帧：
 *
 *   实测（真实电子题：L = 4 cm、E = 91/1600 V/m、m = 9.1e-31 kg、q = 1.6e-19 C、v₀ = 2e7 m/s）
 *     解析：a = qE/m = 1.0e10 m/s²、t₁ = L/v₀ = 2e-9 s、t₂ = D/v₀ = 2e-9 s、总时间 t = 4e-9 s
 *     `node node/sim.mjs --model efieldDeflect --params '{...}'`
 *       → 时长 0.00 s / **1 帧**（dt = 1/60 s，8 子步）
 *       → 场区内加速度 仿真 −1200 m/s² vs 解析 −1.0e10 m/s²（差 100%，判 FAIL）
 *       → 出板偏移 y₁ 仿真 −0.3333 m vs 解析 −2.0e-8 m
 *   整个 4 ns 的过程落在一个 16.7 ms 的帧里，帧内平均加速度只剩 a·t₁/dt ≈ −1200 m/s²，
 *   方向和量级都被平均掉了 —— 这不是精度问题，是**采样定理**问题。
 *
 * 约定（本文件是唯一实现处）：
 *   duration = tTotal × (1 + margin)        // 默认 2% 余量：看清"打到屏/出板"之后的一瞬
 *   dt       = duration / frames            // frames 由 minFrames/maxFrames 约束
 *   子步     = subSteps（原样传回，调用方按离散化敏感度决定）
 * 于是"帧数"成为与题目无关的常量（默认 ~600），步长自动跟随题目时间尺度。
 *
 * 极端尺度：tTotal ∈ [1e-10, 1e3] s 全部稳（浮点双精度下 dt 仍在 1e-13 ~ 10 s 内，
 * 只在 duration/frames 上做除法，不做任何"按秒取整"的操作）。
 * 非法输入（tTotal ≤ 0、NaN、frames ≤ 0 等）**直接抛错并打印入参**，不静默兜底。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.PFA = root.PFA || {};
    root.PFA.pacing = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var DEFAULTS = {
    frames: 600,        // 与题目尺度无关的"目标帧数"
    subSteps: 8,        // 离散化敏感度由调用方决定（组合/轨道模型给 24 ~ 48）
    minFrames: 520,     // 下限：再少就看不出"偏转是条曲线"
    maxFrames: 4000,    // 上限：再多只是浪费内存（每帧约 1 KB）
    margin: 0.02        // 时长余量（2%）
  };

  function bad(msg, input) {
    throw new Error('pacing: ' + msg + '；入参 = ' + JSON.stringify(input));
  }

  /**
   * @param {object} spec
   * @param {number} spec.tTotal   解析总时间（秒，> 0）
   * @param {number} [spec.frames] 目标帧数（默认 600）
   * @param {number} [spec.subSteps] 子步数（默认 8，原样返回）
   * @param {number} [spec.minFrames] / [spec.maxFrames] 帧数约束
   * @param {number} [spec.margin] 时长余量（默认 0.02）
   * @returns {{duration:number, dt:number, subSteps:number, frames:number, tTotal:number, margin:number}}
   */
  function pacing(spec) {
    var s = spec || {};
    var tTotal = s.tTotal;
    if (!(typeof tTotal === 'number') || !isFinite(tTotal) || tTotal <= 0) {
      bad('tTotal 必须是有限正数（解析总时间，秒）', s);
    }
    var margin = s.margin == null ? DEFAULTS.margin : s.margin;
    if (!isFinite(margin) || margin < 0) bad('margin 必须是非负有限数', s);
    var nFrames = s.frames == null ? DEFAULTS.frames : s.frames;
    if (!isFinite(nFrames) || nFrames < 1) bad('frames 必须是 ≥ 1 的有限数', s);
    var minF = s.minFrames == null ? DEFAULTS.minFrames : s.minFrames;
    var maxF = s.maxFrames == null ? DEFAULTS.maxFrames : s.maxFrames;
    if (!isFinite(minF) || !isFinite(maxF) || minF < 1 || maxF < minF) {
      bad('要求 1 ≤ minFrames ≤ maxFrames', s);
    }
    var sub = s.subSteps == null ? DEFAULTS.subSteps : s.subSteps;
    if (!isFinite(sub) || sub < 1) bad('subSteps 必须是 ≥ 1 的有限数', s);

    var frames = Math.round(Math.min(maxF, Math.max(minF, nFrames)));
    var duration = tTotal * (1 + margin);
    if (!isFinite(duration) || duration <= 0) bad('duration 计算失败', s);
    var dt = duration / frames;
    if (!isFinite(dt) || dt <= 0) bad('dt = duration/frames 计算失败', s);
    return { duration: duration, dt: dt, subSteps: Math.round(sub), frames: frames,
             tTotal: tTotal, margin: margin };
  }

  /* ==================================================================== 分辨率断言
   *
   * `pacing()` 只能保证 "dt = duration / frames"。它保证不了 "这个 dt 足以把题目
   * 的特征时间分辨出来" —— 一旦参数把某题推到"整段运动落进一帧"，`pacing` 依旧
   * 老老实实返回一个 dt，仿真也依旧老老实实给出帧，但帧里的平均加速度只剩 a·t_特征/dt，
   * 方向和量级都被平均掉，**静默地**给出垃圾（就是 §① 那个 4 ns 电子题：1 帧、
   * 加速度 −1200 vs 解析 −1e10 m/s²）。
   *
   * 这个断言就是这么用的：模型在 build() 里把 "解析总时长" 与 "解析特征时间" 一起交上来，
   * 比值不达标就**抛错并打印实际数值**，绝不返回一个看起来正常的场景。
   *
   * 语义（characteristicTime 传的是"引擎实际走的步长"，不是题目总时间）：
   *   duration           —— 交给引擎的**播放总时长**（秒，正数）
   *   characteristicTime —— 引擎**内层实际步长**（秒，正数）：一般就是 `dt / subSteps`
   *                          （外层帧步长 dt = duration/frames，内层子步 = dt/subSteps）。
   *                          极端尺度下再加一个 1e-12 s 的浮点地板（`lib/verlet.js` 的
   *                          推进判据就在这个量级），免得"步长已经小于浮点分辨力"也算过关。
   *   frames             —— 引擎实际输出的帧数（缺省用 duration/dt 反推的 round 值）
   *   minFramesPerChar   —— 整段时长里至少要有的"内层步数"（默认 50）
   *
   * 判据：
   *   duration / characteristicTime >= minFramesPerChar            （整段覆盖 ≥ N 个内层步）
   *   且 frames >= minFramesPerChar                                 （帧预算本身不能太少）
   *
   * 为什么这样就够：`duration / (dt/subSteps) = frames × subSteps`。正常走 `pacing()`
   * 的模型这里恒等于 `600 × subSteps ≥ 3000`，稳过；而**退回固定 dt = 1/60 s** 的模型
   * 在微观题上会立刻变成 `4e-9 / (1/480) = 1.9e-6 < 50` → 抛错，而不是给出
   * "落地/偏转在第一帧就完成了"的动画（对照 pitfalls.md ③ 的实测：1 帧、−1200 vs −1e10）。
   */
  function assertResolution(spec) {
    var s = spec || {};
    var duration = s.duration;
    var charT = s.characteristicTime;
    var minPer = s.minFramesPerChar == null ? 50 : s.minFramesPerChar;
    var frames = s.frames;

    if (!(typeof duration === 'number') || !isFinite(duration) || duration <= 0) {
      bad('assertResolution: duration 必须是有限正数（秒）', s);
    }
    if (!(typeof charT === 'number') || !isFinite(charT) || charT <= 0) {
      bad('assertResolution: characteristicTime 必须是有限正数（秒，解析特征时间）', s);
    }
    if (!isFinite(minPer) || minPer < 1) {
      bad('assertResolution: minFramesPerChar 必须是 ≥ 1 的有限数', s);
    }
    if (frames == null || !isFinite(frames)) frames = Math.round(duration / charT);
    if (!isFinite(frames) || frames < 1) {
      bad('assertResolution: 无法确定 frames（请显式给出 frames 或让 duration/characteristicTime ≥ 1）', s);
    }

    var ratio = duration / charT;
    var problems = [];
    if (!(ratio >= minPer)) {
      problems.push('整段时长只覆盖 ' + ratio.toPrecision(6) + ' 倍特征时间（要求 ≥ ' + minPer + '）');
    }
    if (!(frames >= minPer)) {
      problems.push('帧数 ' + frames + ' 少于一个特征时间里应有的 ' + minPer + ' 帧');
    }
    if (problems.length) {
      throw new Error('pacing.assertResolution: 分辨率不足，整段运动会被挤进极少数帧里（' +
        problems.join('；') + '）。实际数值：duration = ' + duration + ' s、characteristicTime = ' +
        charT + ' s、frames = ' + frames + '、minFramesPerChar = ' + minPer +
        '。修法：用 `pacing({ tTotal: <解析总时间>, frames: 600 })` 让步长跟随特征时间，' +
        '不要再让模型固定 dt = 1/60 s。入参 = ' + JSON.stringify(s));
    }
    return { duration: duration, characteristicTime: charT, frames: frames,
             minFramesPerChar: minPer, ratio: ratio };
  }

  pacing.DEFAULTS = DEFAULTS;
  return { pacing: pacing, assertResolution: assertResolution, DEFAULTS: DEFAULTS };
});
