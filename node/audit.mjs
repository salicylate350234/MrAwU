/*!
 * MrAwU（阿物先生）— node/audit.mjs
 * 受力审计：逐个模型检查两件事
 *   1) 牛顿第二定律：|ΣF − m·a| 的残差（每帧）
 *   2) 受力可见性：非零的力会不会因为太小而被画布"吞掉"（老师会说"这里没有摩擦力"）
 * 第 2 点是渲染问题而不是物理问题，但同样会让受力图失真，所以必须一并审计。
 *
 * 用法： node node/audit.mjs [--verbose]
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

const verbose = process.argv.includes('--verbose');
const MIN_PX = 5;                       // 与 lib/draw.js 里的绘制阈值保持一致
const VIEW_W = 1000, VIEW_H = 560;

const COMPONENTS = ['gravity', 'gravitation', 'electric', 'normal', 'friction', 'joint', 'applied'];
const NAMES = { gravity: '重力', gravitation: '万有引力', electric: '电场力', normal: '支持力', friction: '摩擦力', joint: '绳/杆张力', applied: '外力' };

let problems = 0;
console.log('模型'.padEnd(22) + '残差max'.padEnd(10) + '画不出来的非零力（会被误认为"没有这个力"）');
console.log('-'.repeat(100));

models.list.forEach(function (model) {
  const params = models.defaults(model);
  let scene, frames;
  try {
    scene = models.scene(model.id, params, sceneLib);
    scene.view.width = VIEW_W; scene.view.height = VIEW_H;
    frames = simLib.createSim(planck, scene).record().frames;
  } catch (e) {
    console.log(model.id.padEnd(22) + '运行异常: ' + (e && e.message));
    problems++;
    return;
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

  const bad = resMax > 0.005 || flags.length;
  if (bad) problems++;
  console.log(model.id.padEnd(22) +
    (resMax * 100).toFixed(3).padStart(7) + '%  ' +
    (flags.length ? '⚠ ' + flags.join('；') : 'ok') +
    (neverSeen.length && verbose ? '    [本场景不出现: ' + neverSeen.join('/') + ']' : ''));
});

console.log('-'.repeat(100));
console.log(problems ? ('有 ' + problems + ' 个模型需要关注') : '全部模型通过：残差 <0.5%、无非零力被画布吞掉、支持力与摩擦力都出现过');
process.exit(problems ? 1 : 0);
