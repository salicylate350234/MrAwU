#!/usr/bin/env node
/*!
 * MrAwU（阿物先生）— node/solve.mjs
 * 临界条件求解器（扫描 + 二分）：求"让某个观察量恰好等于目标值"的那个参数值。
 *
 * 为什么需要它：高考题里大量出现"临界 / 最小 / 恰好"——"初速度至少多大才能不脱离圆轨道内壁"
 * 等价于"临界点法向力恰好为 0"。以前只能在 node/sim.mjs 里改参数反复试算，费时且容易
 * 漏掉真正的临界区间。这里把"试算"自动化。
 *
 * 为什么是"扫描 + 二分"而不是直接解方程：模型的受力律是**数值的**（lib/verlet.js 只接受
 * force(t,S) 形式，组合模型的临界位置由几何决定），解析式并不总能拿到；而观察量关于参数
 * 通常单调或分段单调，所以先用较粗的扫描定位"符号变化区间"，再在区间内二分到 --tol。
 *
 * 为什么观察量必须走 lib/verify.js 的 probe 体系：工具读到的量要与浏览器右下角的对照表、
 * 与 node/tests.mjs 的回归项是**同一个 measure 实现**。否则"工具找到的解"和"题目里问的量"
 * 会各说各话，找到的临界值没法解释。
 *
 * 用法：
 *   node node/solve.mjs --model <id> --param <key> --range <lo:hi> [--step 0.01]
 *        --watch <观察量> --target <值> [--tol 1e-3] [--params '{...}'] [--json]
 * 退出码：0 = 找到临界值且对照项全 PASS；1 = 找到但有对照项未通过；3 = 未找到；2 = 用法/运行错误
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sceneLib = require(path.join(ROOT, 'lib/scene.js'));
const simLib = require(path.join(ROOT, 'lib/sim.js'));
const verifyLib = require(path.join(ROOT, 'lib/verify.js'));
const planck = require(path.join(ROOT, 'vendor/planck.min.js'));
const models = require(path.join(ROOT, 'lib/models/index.js'));

const HELP = [
  'MrAwU 临界条件求解器 —— 求"使某个观察量恰好等于目标值"的参数',
  '',
  '用法： node node/solve.mjs --model <id> --param <key> --range <lo:hi> [--step 0.01]',
  '                        --watch <观察量> --target <值> [--tol 1e-3] [--params \'{...}\'] [--json]',
  '',
  '参数：',
  '  --model <id>       模型 id（node node/sim.mjs --list 可列全部）',
  '  --param <key>      要反求的参数 key',
  '  --range <lo:hi>    扫描区间（含端点）',
  '  --step <n>         扫描步长（默认 0.01；只用于定位符号变化区间，最终精度由 --tol 决定）',
  '  --target <v>       观察量的目标值（临界条件通常写 0）',
  '  --tol <n>          二分收敛容差，判据是"参数区间宽度 ≤ tol"（默认 1e-3）',
  '  --params \'{...}\'  其余参数（JSON），缺省用模型默认值',
  '  --json             只输出一行 JSON（便于脚本消费）',
  '',
  '观察量（probe 规格与 lib/verify.js 完全一致）：',
  '  normal:<body>[:mag]                法向力（:mag 取大小；否则按 --project 取分量）',
  '  force:<body>:<comp>[:mag]          某个力的分量：gravity/gravitation/electric/normal/',
  '                                     friction/joint/applied/damping/total',
  '  velocity:<body>:mag|x|y            速度（大小 / 分量）',
  '  accel:<body>:mag|x|y               加速度（分量由帧内 Δv/dt 给出，与对照项同源）',
  '  position:<body>:mag|x|y            位置',
  '  eventTime:<body>:<axis>:<at>       刚体首次越过坐标 at 的时刻（axis = x|y，dir 默认 +1）',
  '  stat:<key> / statDelta:<key>       末帧统计量 / 统计量变化（mechanical、kinetic…）',
  '',
  '微调：',
  '  --project x,y      分量方向（默认 [1,0]）；:x / :y 是它的简写',
  '  --dir <±1>         eventTime 的穿越方向（+1 = 沿坐标增大方向穿过 at）',
  '  --reduce <r>       时间窗内如何取一个数：min|max|last|first|mean|sum|maxAbs（默认 min）',
  '  --window <a:b>     只在这一时间段内取值（默认全程，首帧不计）',
  '  --around <c>:<d>[:pad]  把时间窗自动套在轨迹极值点上：c = x|y|speed，d = max|min',
  '                     （pad 默认 0.08 s；配 --around-first 取"第一次"到达该极值）',
  '  --around-first     周期运动取第一次到达极值（避免后面几圈已累积离散耗散）',
  '  --zero <eps>       观察量与目标之差多少算"命中"（默认 1e-12 × max(1,|target|)）',
  '',
  '说明：',
  '  · 默认 reduce=min：临界条件的物理含义是"全程最不利处仍要满足"，所以取时间窗内的最小值。',
  '    要取末值 / 峰值请显式给 --reduce last / max。',
  '  · 分量模式（--project / :x / :y）默认保留正负号——找符号变化必须保留正负。',
  '  · 找到临界值后，工具会用同一参数再跑一遍模型自带的 expect 对照项，确认"整题都自洽"。',
  '  · 扫描区间里没有符号变化时，工具只报告端点值，不做任何外推猜测。',
  '  · eventTime 是"首次越过某坐标"的时刻，只能精确到输出帧（默认 1/60 s），',
  '    所以时间类观察量的分辨极限是 1 帧，--tol 给得再小也不会更准；reduce/window 对它无效。',
  ''
].join('\n');

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[key] = true;
      else { out[key] = next; i++; }
    } else out._.push(a);
  }
  return out;
}

const FORCE_KEYS = ['gravity', 'gravitation', 'electric', 'normal', 'friction', 'joint', 'applied', 'damping', 'total'];
const VECTOR_KINDS = ['force', 'velocity', 'accel', 'position'];
const REDUCES = ['min', 'max', 'last', 'first', 'mean', 'sum', 'maxAbs'];

function fail(msg) {
  const e = new Error(msg);
  e.usage = true;
  throw e;
}

function num(name, v, fallback) {
  if (v === undefined || v === true) {
    if (fallback === undefined) fail('缺少 ' + name);
    return fallback;
  }
  const n = Number(v);
  if (!isFinite(n)) fail(name + ' 需要一个数，收到 ' + JSON.stringify(v));
  return n;
}

function parseProject(s) {
  const p = String(s).split(',').map(function (t) { return Number(t.trim()); });
  if (p.length !== 2 || !isFinite(p[0]) || !isFinite(p[1])) {
    fail('--project 需要形如 x,y 的两个数，收到 ' + JSON.stringify(s));
  }
  return p;
}

const AXES = { x: [1, 0], y: [0, 1] };

/**
 * 把 --watch 规格翻译成 lib/verify.js 的 probe 对象。
 * 刻意**不做**任何"自定义测量"：这里产出的 probe 直接交给 verifyLib.measure，
 * 与模型 expect() 里的探针走同一段代码，所以工具的结果天然与对照表可比。
 */
function buildWatch(spec, opts) {
  const seg = String(spec).split(':');
  const kind = seg[0];
  const body = seg[1];
  const tail = seg[2];
  if (!kind || !body) fail('--watch 至少要写成 <种类>:<刚体>（收到 ' + JSON.stringify(spec) + '）');

  const project = opts.project ? parseProject(opts.project) : [1, 0];
  const probe = { body: body };
  let human = '';

  if (kind === 'normal' || kind === 'force') {
    const comp = kind === 'normal' ? 'normal' : tail;
    if (kind === 'force') {
      if (!comp || FORCE_KEYS.indexOf(comp) < 0) {
        fail('force 的分量必须是 ' + FORCE_KEYS.join('/') + '（收到 ' + JSON.stringify(String(tail)) + '）');
      }
      // force:<body>:<comp>[:mag] —— comp 后面的 mag 才是取模
      probe.mode = seg[3] === 'mag' ? 'mag' : 'dot';
      human = 'force.' + comp;
    } else {
      probe.comp = 'normal';
      probe.mode = tail === 'mag' ? 'mag' : 'dot';
      human = 'force.normal';
    }
    probe.kind = 'force';
    probe.comp = comp;
  } else if (kind === 'velocity' || kind === 'accel' || kind === 'position') {
    probe.kind = kind;
    if (tail === 'mag') probe.mode = 'mag';
    else if (tail === 'x' || tail === 'y') { probe.mode = 'dot'; probe.project = opts.project ? project : AXES[tail]; }
    else if (tail === undefined) {
      // 没给方向的向量量：必须靠 --project 指明方向，否则"取哪一个数"是不确定的
      if (!opts.project) fail(kind + ':' + body + ' 缺少方向，请写成 :mag/:x/:y 或给 --project x,y');
      probe.mode = 'dot'; probe.project = project;
    } else fail(kind + ' 的方向只能是 mag/x/y（收到 ' + JSON.stringify(String(tail)) + '）');
    human = kind;
  } else if (kind === 'eventTime') {
    const axis = seg[2], at = seg[3];
    if (axis !== 'x' && axis !== 'y') fail('eventTime 需要 <axis>，只能是 x 或 y（收到 ' + JSON.stringify(String(axis)) + '）');
    if (at === undefined) fail('eventTime 需要 <at>：eventTime:<body>:<axis>:<at>');
    probe.kind = 'eventTime';
    probe.axis = axis;
    probe.at = Number(at);
    if (!isFinite(probe.at)) fail('eventTime 的 at 需要是数，收到 ' + JSON.stringify(String(at)));
    probe.dir = opts.dir != null ? num('--dir', opts.dir) : 1;
    human = 'eventTime';
  } else if (kind === 'stat' || kind === 'statDelta') {
    // stat 的第二段是统计量 key 而不是刚体名（probe.body 可为空）
    probe.kind = kind;
    probe.key = body;
    delete probe.body;
    human = kind + ':' + body;
  } else {
    fail('不认识的观察量种类 ' + JSON.stringify(kind) + '，见 --help');
  }

  // 分量的默认值：保留正负号（找符号变化的前提），取模模式忽略 project
  if (probe.mode !== 'mag') {
    probe.project = probe.project || project;
    probe.signed = true;
  }
  if (opts.reduce != null) {
    if (REDUCES.indexOf(String(opts.reduce)) < 0) fail('--reduce 只能是 ' + REDUCES.join('/'));
    probe.reduce = String(opts.reduce);
  } else probe.reduce = 'min';       // 见文件头与 --help：临界条件取"最不利处"
  if (opts.around != null) {
    // around 是 lib/verify.js 已有的探针字段：自动把采样窗套在"轨迹的某个极值点"上。
    // 临界题的问法常常是"最高点/最低点的力恰好为 0"，用固定时间窗去凑既脆弱又难读，
    // 所以这里直接把 around 透传下去（与模型 expect 里用的是同一段实现）。
    const a = String(opts.around).split(':');
    if (['x', 'y', 'speed'].indexOf(a[0]) < 0) fail('--around 的 comp 只能是 x|y|speed');
    if (a[1] !== 'max' && a[1] !== 'min') fail('--around 的 dir 只能是 max|min');
    probe.around = { comp: a[0], dir: a[1], pad: a[2] != null ? Number(a[2]) : 0.08 };
    if (a[2] != null && !isFinite(probe.around.pad)) fail('--around 的 pad 需要是数');
    if (opts['around-first']) probe.around.first = true;
  }
  if (opts.window != null) {
    const w = String(opts.window).split(':').map(Number);
    if (w.length !== 2 || !w.every(isFinite) || !(w[0] < w[1])) fail('--window 需要形如 a:b 且 a<b');
    probe.window = w;
  }
  return { probe: probe, human: human };
}

function fmt(v, d) {
  if (v == null || !isFinite(v)) return '—';
  if (v === 0) return '0';
  const a = Math.abs(v);
  if (a >= 1e6 || a < 1e-4) return v.toExponential(3);
  return v.toFixed(d == null ? 6 : d);
}

/** 参数值展示：给足有效位，避免"工具算到 1e-9 却只显示 3 位" */
function fmtParam(v) { return String(Number(v.toPrecision(10))); }

const CLASS_NAME = { '+': '高于目标', '-': '低于目标', '0': '命中目标', nan: '观察量测不到', err: '不可用' };
// 二分把"观察量 vs 目标"的类别压成一个可比较的序：+ < 0 < − < 测不到。
// 有了这个序，二分就不必纠结"中点恰好命中目标"该算哪一侧——按序比较即可，
// 于是"扫描点正好踩在根上"（很常见，因为根常是步长的整数倍）也不会把二分卡死。
const RANK = { '+': -1, '0': 0, '-': 1, nan: 2 };

function classify(rec, target, zeroEps) {
  if (rec.error) return 'err';
  if (rec.value == null) return 'nan';
  const d = rec.value - target;
  if (Math.abs(d) <= zeroEps) return '0';
  return d > 0 ? '+' : '-';
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.h) { console.log(HELP); return 0; }
  if (args.list) {
    models.list.forEach(m => console.log(m.id.padEnd(22) + m.title));
    return 0;
  }

  const modelId = args.model;
  if (!modelId || modelId === true) fail('缺少 --model（可先跑 node node/sim.mjs --list 看全部模型）');
  const model = models.get(modelId);
  if (!model) fail('未知模型 ' + JSON.stringify(String(modelId)) + '（可用：' + models.list.map(m => m.id).join(', ') + '）');

  const paramKey = args.param;
  if (!paramKey || paramKey === true) fail('缺少 --param');
  const declared = (model.params || []).some(it => it.key === paramKey);

  const rangeRaw = String(args.range || '');
  const rs = rangeRaw.split(':');
  if (rs.length !== 2) fail('--range 需要形如 lo:hi');
  const lo = num('--range lo', rs[0]), hi = num('--range hi', rs[1]);
  if (!(hi > lo)) fail('--range 需要 lo < hi');
  const step = num('--step', args.step, 0.01);
  if (!(step > 0)) fail('--step 必须 > 0');

  const target = num('--target', args.target);
  const tol = num('--tol', args.tol, 1e-3);
  if (!(tol > 0)) fail('--tol 必须 > 0');
  const zeroEps = args.zero != null ? num('--zero', args.zero) : 1e-12 * Math.max(1, Math.abs(target));

  const overrides = args.params ? JSON.parse(String(args.params)) : {};
  if (overrides[paramKey] !== undefined) delete overrides[paramKey];   // --param 由扫描接管
  const baseParams = Object.assign(models.defaults(model), overrides);

  const { probe, human } = buildWatch(args.watch, args);
  if (probe.kind === 'stat' || probe.kind === 'statDelta') probe.body = undefined;

  // ---- 扫描点数：先算清楚再跑 ----
  // 每扫一个点就是一次完整仿真（组合模型 ~30 ms），所以默认步长在小参数区间上可能要求几千个点。
  // 这里**自动放宽步长**而不是直接报错退出：扫描只用来定位符号变化区间，最终精度由二分保证，
  // 放宽步长的代价只是"可能把很窄的区间跳过去"。放宽时会在输出里写明，不偷偷改。
  const MAX_SCAN = 500;
  let effStep = step, stepNote = '';
  let nScan = Math.max(2, Math.ceil((hi - lo) / effStep) + 1);
  if (nScan > MAX_SCAN) {
    effStep = (hi - lo) / (MAX_SCAN - 1);
    nScan = MAX_SCAN;
    stepNote = '（--step ' + step + ' 要跑 ' + (Math.ceil((hi - lo) / step) + 1) +
      ' 个点，已自动放宽到 ' + Number(effStep.toPrecision(4)) + '；要更细请显式给 --step 或缩小 --range）';
  }

  // 缓存**轻量结果**（参数值 → 观察量），不缓存帧：一帧序列几 MB，扫描上百个点会把内存吃光。
  // 需要帧（算 expect 对照项）时只在最终解处重新跑一次完整仿真。
  const cache = new Map();
  let simCount = 0;

  function simulate(x) {
    simCount++;
    const params = Object.assign({}, baseParams);
    params[paramKey] = x;
    const scene = models.scene(model.id, params, sceneLib);
    const frames = simLib.createSim(planck, scene).record().frames;
    return { params: params, scene: scene, frames: frames };
  }

  function evaluate(x) {
    const key = String(x);
    if (cache.has(key)) return cache.get(key);
    let rec;
    try {
      const s = simulate(x);
      const value = verifyLib.measure(s.frames, probe, { scene: s.scene });
      rec = { x: x, value: (value != null && isFinite(value)) ? value : null, error: null };
    } catch (e) {
      // 单个点失败（模型主动报错 / 观察量没有定义）不该让整次求解崩掉，记下来继续扫。
      rec = { x: x, value: null, error: (e && e.message) || String(e) };
    }
    cache.set(key, rec);
    return rec;
  }

  // ---- 1. 扫描：找符号变化区间 ----
  const t0scan = Date.now();
  const cols = [];
  for (let i = 0; i < nScan; i++) {
    const x = i === nScan - 1 ? hi : lo + i * effStep;
    const rec = evaluate(x);
    cols.push({ x: x, rec: rec, cls: classify(rec, target, zeroEps) });
  }
  const brackets = [];
  for (let i = 0; i + 1 < cols.length; i++) {
    const a = cols[i], b = cols[i + 1];
    if (a.cls === 'err' || b.cls === 'err') continue;   // 跨"不可用"区间不做符号判定
    if (a.cls !== b.cls) brackets.push({ lo: a, hi: b });
  }
  // 把"夹着过渡点（命中目标 / 测不到）的相邻区间"合成一次符号变化：
  // 扫描步长正好踩在根上时会得到 [+,0] 与 [0,−] 两个相邻区间，其实只是同一次穿越，
  // 不合并就会把"1 处符号变化"错报成 2 处，让人误以为有多解。
  const crossings = [];
  brackets.forEach(function (b) {
    const last = crossings[crossings.length - 1];
    if (last && last.hi === b.lo && (b.lo.cls === '0' || b.lo.cls === 'nan')) {
      last.hi = b.hi;
      last.span = last.span + 1;
    } else crossings.push({ lo: b.lo, hi: b.hi, span: 1 });
  });
  const errCount = cols.filter(c => c.cls === 'err').length;

  const head = [];
  head.push('MrAwU 临界条件求解 · ' + model.id + '（' + model.title + '）');
  head.push('参数      : ' + paramKey + ' ∈ [' + lo + ', ' + hi + ']，步长 ' + Number(effStep.toPrecision(4)) +
    '（' + nScan + ' 个扫描点）' + stepNote +
    (declared ? '' : '  ⚠ 该参数未在模型参数表里声明，按原样注入'));
  head.push('观察量    : ' + String(args.watch) + '  probe{kind=' + probe.kind + (probe.comp ? ', comp=' + probe.comp : '') +
    (probe.key ? ', key=' + probe.key : '') + (probe.body ? ', body=' + probe.body : '') +
    (probe.mode ? ', mode=' + probe.mode : '') +
    (VECTOR_KINDS.indexOf(probe.kind) >= 0 && probe.mode !== 'mag' ? ', project=[' + probe.project + ']' : '') + '}' +
    '  reduce=' + probe.reduce + '  窗口=' + (probe.around
      ? 'auto@' + probe.around.comp + (probe.around.dir === 'max' ? '最高' : '最低') + (probe.around.first ? '(首次)' : '')
      : (probe.window ? probe.window.join(':') : '全程')));
  head.push('目标/容差 : 目标 ' + target + '，零判定 ' + zeroEps + '，参数收敛 tol ' + tol);

  if (!crossings.length) {
    const a = cols[0], b = cols[cols.length - 1];
    head.push('扫描      : **未发现符号变化**（' + nScan + ' 个点全程在目标同一侧' +
      (errCount ? '，另有 ' + errCount + ' 个点不可用' : '') + '）');
    head.push('端点值    : ' + paramKey + '=' + fmtParam(a.x) + ' → ' + fmt(a.rec.value) + ' [' + CLASS_NAME[a.cls] + ']' +
      '；' + paramKey + '=' + fmtParam(b.x) + ' → ' + fmt(b.rec.value) + ' [' + CLASS_NAME[b.cls] + ']');
    head.push('结论      : **未找到临界值**——请扩大/移动 --range，或换一个 --watch 观察量；');
    head.push('            工具只报告扫到的信息，不做外推或猜测（共 ' + simCount + ' 次仿真，' + (Date.now() - t0scan) + ' ms）');
    if (errCount) {
      const e0 = cols.find(c => c.cls === 'err');
      head.push('扫描异常  : ' + errCount + ' 个点运行失败，例如 ' + paramKey + '=' + fmtParam(e0.x) + ' → ' + e0.rec.error);
      // 模型主动报错的点常常"正好"是物理边界（例如 N≤0 时模型拒绝建模）。
      // 但"用不了"不等于"观察量过了目标"，跨过它做符号判定就是猜，所以只提示、不二分。
      head.push('            提示：这些"不可用"点常常正落在物理边界上，但工具不在"不可用"两侧做符号判定；');
      head.push('            请把 --range 收窄到边界两侧都测得到的范围再跑一次。');
    }
    if (args.json) {
      console.log(JSON.stringify({
        model: model.id, param: paramKey, watch: String(args.watch), target: target,
        found: false, scanPoints: nScan, errors: errCount,
        endpoints: [
          { param: a.x, value: a.rec.value, class: a.cls },
          { param: b.x, value: b.rec.value, class: b.cls }
        ]
      }));
    } else {
      head.forEach(l => console.log(l));
    }
    return 3;
  }

  // ---- 2. 二分：收敛第一处符号变化 ----
  // 二分只在**原始区间**（两端类别必然不同）里做，保证每步都能前进；
  // 方向由两端类别的序决定，于是"中点恰好命中目标"也能正常压区间。
  const br = brackets[0];
  const grp = crossings[0];
  const increasing = RANK[br.hi.cls] > RANK[br.lo.cls];
  const hitRank = RANK[br.hi.cls];
  let blo = br.lo, bhi = br.hi;
  let iters = 0, aborted = null;
  while (bhi.x - blo.x > tol && iters < 200) {
    iters++;
    const mid = 0.5 * (blo.x + bhi.x);
    const rec = evaluate(mid);
    const cls = classify(rec, target, zeroEps);
    if (cls === 'err') { aborted = '二分中点 ' + paramKey + '=' + fmtParam(mid) + ' 运行失败：' + rec.error; break; }
    const reached = increasing ? (RANK[cls] >= hitRank) : (RANK[cls] <= hitRank);
    if (reached) bhi = { x: mid, rec: rec, cls: cls };
    else blo = { x: mid, rec: rec, cls: cls };
    // 区间两端被压成同一类（例如中间出现了"测不到"）→ 已经不是符号变化区间，停下来如实报告
    if (RANK[blo.cls] === RANK[bhi.cls]) {
      aborted = '二分区间两端落到同一类别（' + CLASS_NAME[blo.cls] + '），观察量关于该参数不单调/' +
        '存在无定义段，已停在区间 [' + fmtParam(blo.x) + ', ' + fmtParam(bhi.x) + ']';
      break;
    }
  }
  const xStar = 0.5 * (blo.x + bhi.x);

  // ---- 3. 在解处跑一遍完整仿真：拿实测值 + 模型自带的 expect 对照项 ----
  let atStar = null, rows = null, expectError = null, starFrames = null;
  try {
    const s = simulate(xStar);
    starFrames = s.frames;
    const value = verifyLib.measure(s.frames, probe, { scene: s.scene });
    atStar = (value != null && isFinite(value)) ? value : null;
    if (typeof model.expect === 'function' || (model.expect && model.expect.length)) {
      rows = verifyLib.run(model, s.params, s.frames, s.scene);
    }
  } catch (e) {
    expectError = (e && e.message) || String(e);
  }

  const passRows = rows ? rows.filter(r => r.pass) : [];
  const failRows = rows ? rows.filter(r => !r.pass) : [];

  head.push('扫描      : ' + crossings.length + ' 处符号变化' +
    (crossings.length > 1 ? '（观察量不单调或有多解，下面只用第一处）' : '') +
    '；区间 [' + fmtParam(grp.lo.x) + ', ' + fmtParam(grp.hi.x) + ']（低端 ' + fmt(grp.lo.rec.value) + ' [' +
    CLASS_NAME[grp.lo.cls] + '] → 高端 ' + fmt(grp.hi.rec.value) + ' [' + CLASS_NAME[grp.hi.cls] + ']）');
  if (errCount) head.push('扫描异常  : ' + errCount + ' 个点不可用（已跳过，不影响符号判定）');
  head.push('★ 临界值  : ' + paramKey + '* = ' + fmtParam(xStar) +
    '   （二分 ' + iters + ' 次，最终区间 [' + fmtParam(blo.x) + ', ' + fmtParam(bhi.x) + ']）');
  head.push('解处实测  : ' + human + ' = ' + fmt(atStar) +
    (atStar == null ? '（**测不到**，解可能落在观察量无定义的边界上）'
      : '（目标 ' + target + '，偏差 ' + fmt(atStar - target) + '）'));
  if (probe.kind === 'eventTime') {
    const fdt = starFrames && starFrames.length > 1 ? starFrames[1].dt : 1 / 60;
    head.push('时间量化  : eventTime 只能定位到输出帧边界（1 帧 = ' + fmt(fdt, 5) + ' s），' +
      '所以时间类观察量的分辨极限就是 1 帧；');
    head.push('            扫描里出现"整段跳变"是这个原因，不是模型误差，--tol 给得再小也不会更准');
  }
  if (expectError) {
    head.push('对照项    : 无法运行 expect —— ' + expectError);
  } else if (!rows) {
    head.push('对照项    : 该模型未声明 expect 对照项，无法交叉确认整题自洽性');
  } else {
    // 人读输出控制在 15 行以内，所以对照项最多列 5 条；FAIL 的排在前面（那才是要看的）。
    const MAX_ROWS = 5;
    const ordered = failRows.concat(passRows);
    const shown = ordered.slice(0, MAX_ROWS);
    head.push('对照项    : ' + passRows.length + '/' + rows.length + ' PASS' +
      (failRows.length ? '  ⚠ 有 ' + failRows.length + ' 项未通过' : '') +
      '（同一参数下的模型 expect 机制' +
      (ordered.length > MAX_ROWS ? '；失败项优先，只列前 ' + MAX_ROWS + ' 项，全部 ' + rows.length + ' 项见 --json' : '') + '）');
    shown.forEach(function (r) {
      head.push('            [' + (r.pass ? 'PASS' : 'FAIL') + '] ' + r.label + '  解析 ' + fmt(r.theory, 4) +
        ' / 仿真 ' + fmt(r.sim, 4) +
        (r.relError == null ? '' : (r.absolute ? '  绝对误差 ' + fmt(r.relError) : '  相对误差 ' + (r.relError * 100).toFixed(3) + '%')));
    });
  }

  const okAll = !expectError && (!rows || failRows.length === 0);
  if (aborted) head.push('注意      : ' + aborted);
  head.push('结论      : ' + (aborted ? '临界值可能不准（见上）' : '找到临界值') +
    (atStar == null ? '，但观察量在该处测不到' : '') +
    (okAll ? '，且该参数下整题自洽' : '，但对照项未全通过') +
    '（共 ' + simCount + ' 次仿真，' + (Date.now() - t0scan) + ' ms）');

  if (args.json) {
    console.log(JSON.stringify({
      model: model.id, param: paramKey, watch: String(args.watch), target: target,
      found: true, paramValue: xStar,
      bracket: [blo.x, bhi.x], bisectIterations: iters, aborted: aborted,
      watchValue: atStar, probe: probe, scanPoints: nScan, errors: errCount,
      crossings: crossings.map(c => ({
        from: c.lo.x, to: c.hi.x, fromClass: c.lo.cls, toClass: c.hi.cls,
        fromValue: c.lo.rec.value, toValue: c.hi.rec.value
      })),
      expect: rows ? rows.map(r => ({ label: r.label, theory: r.theory, sim: r.sim, relError: r.relError, pass: r.pass })) : null,
      expectError: expectError
    }));
    return aborted || !okAll ? 1 : 0;
  }

  head.forEach(l => console.log(l));
  if (aborted || !okAll) return 1;
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().then(code => process.exit(code)).catch((e) => {
    if (e && e.usage) { console.error('用法错误: ' + e.message + '\n\n' + HELP); process.exit(2); }
    console.error(e);
    process.exit(2);
  });
}
