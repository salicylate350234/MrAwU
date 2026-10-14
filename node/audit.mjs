/*!
 * MrAwU（阿物先生）— node/audit.mjs
 * 受力审计：逐个模型检查两件事
 *   1) 牛顿第二定律：|ΣF − m·a| 的残差（每帧）
 *   2) 受力可见性：非零的力会不会因为太小而被画布"吞掉"（老师会说"这里没有摩擦力"）
 * 第 2 点是渲染问题而不是物理问题，但同样会让受力图失真，所以必须一并审计。
 *
 * 用法： node node/audit.mjs [--verbose] [--brief] [--quiet]
 *   （默认）   逐模型一行，末尾给总结
 *   --brief   只打印汇总 1~2 行（通过数/总数 + 失败项清单）；有失败时仍打印失败详情
 *   --quiet   只打印一行结论
 * 退出码：0 = 全部通过；1 = 有模型需要关注（三种模式语义相同）
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sceneLib = require(path.join(ROOT, 'lib/scene.js'));
const simLib = require(path.join(ROOT, 'lib/sim.js'));
const drawLib = require(path.join(ROOT, 'lib/draw.js'));
const planck = require(path.join(ROOT, 'vendor/planck.min.js'));
const models = require(path.join(ROOT, 'lib/models/index.js'));

const argv = process.argv.slice(2);
const verbose = argv.includes('--verbose');
const brief = argv.includes('--brief');
const quiet = argv.includes('--quiet');
const MIN_PX = 5;                       // 与 lib/draw.js 里的绘制阈值保持一致
const VIEW_W = 1000, VIEW_H = 560;

const COMPONENTS = ['gravity', 'gravitation', 'electric', 'normal', 'friction', 'joint', 'applied'];
const NAMES = { gravity: '重力', gravitation: '万有引力', electric: '电场力', normal: '支持力', friction: '摩擦力', joint: '绳/杆张力', applied: '外力' };

/** 检查一个模型，返回 { id, resMax, flags, neverSeen } 或 { id, error } */
function inspect(model) {
  const params = models.defaults(model);
  let scene, frames;
  try {
    scene = models.scene(model.id, params, sceneLib);
    scene.view.width = VIEW_W; scene.view.height = VIEW_H;
    frames = simLib.createSim(planck, scene).record().frames;
  } catch (e) {
    return { id: model.id, error: (e && e.message) || String(e) };
  }
  const view = drawLib.makeView(frames, scene);
  const resMax = Math.max.apply(null, frames.slice(1).map(f => f.stats.residualMax));

  // 两遍统计：先求每个分量的峰值，再判断"显著却被画布吞掉"的帧。
  // 判定与 lib/draw.js 一致：真实长度 ≥5px 一定会画出来（不足 14px 的会被放大到 14px）。
  // 只有「超过峰值 15% 却仍短于 5px」才算问题；力本身过零（共速瞬间摩擦力、圆周最高点张力）
  // 是正确物理，不该报警。
  const maxMag = {};
  frames.slice(1).forEach(function (f) {
    Object.keys(f.bodies).forEach(function (id) {
      const b = f.bodies[id];
      if (b.type !== 'dynamic') return;
      COMPONENTS.forEach(function (k) {
        const m = Math.hypot(b.forces[k][0], b.forces[k][1]);
        if (m > (maxMag[k] || 0)) maxMag[k] = m;
      });
    });
  });
  const invisible = {};
  frames.slice(1).forEach(function (f) {
    Object.keys(f.bodies).forEach(function (id) {
      const b = f.bodies[id];
      if (b.type !== 'dynamic') return;
      COMPONENTS.forEach(function (k) {
        const m = Math.hypot(b.forces[k][0], b.forces[k][1]);
        if (m <= 1e-9) return;
        // 与 lib/draw.js 的绘制规则完全一致：
        //   真实长度 <5px → 不画；显著但短于 14px → 放大到 14px 保证可见
        var truePx = m * view.forceScale * view.pxPerM;
        var drawnPx = (truePx < 14 && m > 0.02 * view.maxForce) ? 14 : truePx;
        if (drawnPx < MIN_PX && m > 0.15 * (maxMag[k] || m)) {
          invisible[k] = Math.max(invisible[k] || 0, m);
        }
      });
    });
  });

  const flags = Object.keys(invisible).map(function (k) {
    const pct = maxMag[k] ? (invisible[k] / maxMag[k] * 100).toFixed(0) : '?';
    return NAMES[k] + '(峰值 ' + maxMag[k].toFixed(1) + 'N，其中画不出的部分最大 ' + invisible[k].toFixed(2) + 'N，占峰值 ' + pct + '%)';
  });

  // 关键分量：只把「非零却被画布吞掉」当成问题；
  // "某个力从未出现"多数是物理上就应该为 0（平抛没有接触力、光滑面没有摩擦），只作提示。
  const neverSeen = [];
  COMPONENTS.forEach(function (k) {
    if (!maxMag[k]) neverSeen.push(NAMES[k]);
  });

  return { id: model.id, resMax: resMax, flags: flags, neverSeen: neverSeen };
}

/** 一行/一条的呈现，与默认模式逐字一致 */
function rowText(r) {
  if (r.error) return r.id.padEnd(22) + '运行异常: ' + r.error;
  return r.id.padEnd(22) +
    (r.resMax * 100).toFixed(3).padStart(7) + '%  ' +
    (r.flags.length ? '⚠ ' + r.flags.join('；') : 'ok') +
    (r.neverSeen.length && verbose ? '    [本场景不出现: ' + r.neverSeen.join('/') + ']' : '');
}

const rows = models.list.map(inspect);
const bad = rows.filter(function (r) { return r.error || r.resMax > 0.005 || r.flags.length; });
const problems = bad.length;
const total = rows.length;

if (quiet) {
  console.log('受力审计：' + (total - problems) + '/' + total + ' 通过' +
    (problems ? '（需关注：' + bad.map(r => r.id).join('、') + '）' : ''));
} else if (brief) {
  console.log('受力审计：' + (total - problems) + '/' + total + ' 通过' +
    (problems ? '，需关注 ' + problems + ' 个：' + bad.map(r => r.id).join('、') : '') +
    (problems ? '' : '（判据：残差 max <0.5% 且没有"非零却画不出来"的力）'));
  if (problems) {
    console.log('失败详情（模型 / 残差 max / 画不出来的非零力）：');
    bad.forEach(function (r) { console.log('  ' + rowText(r)); });
  }
} else {
  console.log('模型'.padEnd(22) + '残差max'.padEnd(10) + '画不出来的非零力（会被误认为"没有这个力"）');
  console.log('-'.repeat(100));
  rows.forEach(function (r) { console.log(rowText(r)); });
  console.log('-'.repeat(100));
  console.log(problems ? ('有 ' + problems + ' 个模型需要关注') : '全部模型通过：残差 <0.5%、无非零力被画布吞掉、支持力与摩擦力都出现过');
}
process.exit(problems ? 1 : 0);
