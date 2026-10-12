/*!
 * MrAwU（阿物先生）— node/check-env.mjs
 * 一键环境自检：列出运行本 skill 需要的全部东西，并逐项确认是否就绪。
 * 目标场景：在任何一台电脑上装好清单里的东西后，就能"在 DSH 里拍张物理题照片发过来
 * → 模型读图建模 → 调用 planck 计算 → 产出对应的受力动画"。
 *
 * 用法： node node/check-env.mjs
 * 退出码 0 = 必需项全部就绪；1 = 有必需项缺失。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let fail = 0, warn = 0;
function ok(label, detail) { console.log('  [✓] ' + label + (detail ? '  — ' + detail : '')); }
function bad(label, how) { fail++; console.log('  [✗] ' + label + (how ? '\n        修复：' + how : '')); }
function soft(label, detail) { warn++; console.log('  [–] ' + label + (detail ? '  — ' + detail : '')); }

console.log('');
console.log('阿物先生（MrAwU） · 环境清单自检');
console.log('skill 目录：' + ROOT);
console.log('');

// ---------------------------------------------------------------- 必需项
console.log('【必需项】');
const nodeMajor = Number(process.versions.node.split('.')[0]);
if (nodeMajor >= 18) ok('Node.js', 'v' + process.versions.node + '（DSH 自带运行时，无需单独安装）');
else bad('Node.js 版本过低', '需要 ≥18，当前 v' + process.versions.node);

// 1. 物理引擎（已随 skill 打包，不需要 npm install）
const planckPath = path.join(ROOT, 'vendor', 'planck.min.js');
let planck = null;
if (fs.existsSync(planckPath)) {
  try {
    planck = require(planckPath);
    ok('物理引擎（双后端）', 'planck.js ' + (fs.statSync(planckPath).size / 1024).toFixed(0) +
      ' KB（13 个模型全可用）＋ 自研 velocity-Verlet（已迁移模型可用；轻量版不打包 planck，体积约 −57%）');
  } catch (e) {
    bad('planck.js 无法加载', String(e && e.message));
  }
} else {
  bad('缺少 vendor/planck.min.js', '重新解压 skill 目录');
}

// 2. 源码文件完整性
const REQUIRED = [
  'SKILL.md', 'README.md', 'CHECKLIST.md',
  'lib/scene.js', 'lib/compose.js', 'lib/world.js', 'lib/sim.js', 'lib/verify.js', 'lib/draw.js', 'lib/graph.js', 'lib/field.js', 'lib/verlet.js',
  'lib/models/index.js', 'lib/models/shared.js', 'lib/models/mechanics.js', 'lib/models/motion.js', 'lib/models/gravity.js', 'lib/models/electric.js', 'lib/models/combo.js',
  'browser/template.html', 'browser/player.js',
  'node/sim.mjs', 'node/tests.mjs', 'node/build.mjs', 'node/qa.mjs', 'node/audit.mjs', 'node/package.mjs',
  'node/compare-engines.cjs', 'node/bench.cjs', 'node/engine-report.cjs', 'node/evalcheck.cjs',
  'references/scene-schema.md', 'references/image-to-scene.md', 'references/verification.md'
];
const missing = REQUIRED.filter(f => !fs.existsSync(path.join(ROOT, f)));
if (!missing.length) ok('源码文件完整', REQUIRED.length + ' 个文件全部就位');
else bad('缺少 ' + missing.length + ' 个文件: ' + missing.join(', '), '重新解压完整 skill 目录');

// 3. 引擎能真正跑起来 + 全部模型能构建
if (planck && !missing.length) {
  try {
    const sceneLib = require(path.join(ROOT, 'lib/scene.js'));
    const simLib = require(path.join(ROOT, 'lib/sim.js'));
    const models = require(path.join(ROOT, 'lib/models/index.js'));
    let badModels = [];
    models.list.forEach(function (m) {
      try {
        const scene = models.scene(m.id, null, sceneLib);
        const frames = simLib.createSim(planck, scene).record().frames;
        const resMax = Math.max.apply(null, frames.slice(1).map(f => f.stats.residualMax));
        if (!(resMax < 0.005)) badModels.push(m.id + '(残差 ' + (resMax * 100).toFixed(2) + '%)');
      } catch (e) { badModels.push(m.id + '(' + (e && e.message) + ')'); }
    });
    if (!badModels.length) ok('物理引擎可用 + 全部模型通过受力自检', models.list.length + ' 个模型，残差均 <0.5%');
    else bad('以下模型未通过: ' + badModels.join('; '), '运行 node node/tests.mjs 查看详情');
  } catch (e) {
    bad('引擎运行测试失败', String(e && e.message));
  }
}

// 4. 交付物是否已生成
const distHtml = path.join(ROOT, 'dist', '阿物先生.html');
if (fs.existsSync(distHtml)) {
  ok('单文件动画已生成', (fs.statSync(distHtml).size / 1024).toFixed(0) + ' KB — 可直接双击或发给别人');
} else {
  soft('尚未生成单文件 HTML', '运行 node node/package.mjs 生成');
}

// 5. 产物是否**过期**（教训：改完源码只跑了 build.mjs、没跑 package.mjs，
//    老师打开的交付包里还是旧构建，"明明修好了却还是老毛病"）
const srcDirs = ['lib', 'browser', 'node', 'references'];
let newestSrc = 0, newestName = '';
const touch = (p) => {
  const st = fs.statSync(p);
  if (st.mtimeMs > newestSrc) { newestSrc = st.mtimeMs; newestName = path.relative(ROOT, p); }
};
const walk = (dir) => {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p); else touch(p);
  }
};
srcDirs.forEach((d) => walk(path.join(ROOT, d)));
touch(path.join(ROOT, 'SKILL.md'));

const artifacts = [];
const distDir = path.join(ROOT, 'dist');
if (fs.existsSync(distDir)) {
  for (const e of fs.readdirSync(distDir, { withFileTypes: true })) {
    if (!e.isFile()) continue;
    if (!/\.(html|zip)$/i.test(e.name)) continue;
    artifacts.push(path.join(distDir, e.name));
  }
}
const stale = artifacts.filter((p) => fs.statSync(p).mtimeMs < newestSrc);
if (!artifacts.length) {
  soft('还没有产物', '运行 node node/package.mjs');
} else if (stale.length) {
  soft(stale.length + ' 个产物**已过期**（源码比它新）',
    '最新源码：' + newestName + '\n        过期产物：' + stale.map((p) => path.basename(p)).join('、') +
    '\n        → 重新运行 node node/package.mjs（只跑 build.mjs 不会更新交付包）');
} else {
  ok('产物是最新的', artifacts.length + ' 个（源码与 dist/ 同步）');
}

// ---------------------------------------------------------------- 可选项
console.log('');
console.log('【可选项】（不装也能用：只影响 GIF 导出与 Node 端预览图）');
try {
  require('@napi-rs/canvas');
  ok('@napi-rs/canvas', '已安装 → 可导出 GIF / 预览 PNG（node/qa.mjs）');
} catch (e) {
  soft('@napi-rs/canvas 未安装', '需要时执行：npm i @napi-rs/canvas --cache "' + ROOT + '\\.npm-cache"\n' +
    '        （npm 默认缓存在工作区外会被沙箱拒绝，必须用 --cache 指到工作区内）');
}

// ---------------------------------------------------------------- 拍照工作流
console.log('');
console.log('【拍照 → 模型 工作流】');
console.log('  1. 在 DSH 对话里直接贴一张物理题照片/截图（作为图片附件发过来）');
console.log('  2. 模型读图，先给出"量测表"：图上标注的用标注值，没标注的声明为默认值，关键量会先跟你确认');
console.log('  3. 已有题型 → 直接算： node node/sim.mjs --model <id> --params \'{...}\'');
console.log('     新题型 → 在 lib/models/ 里新增模型（build 生成场景 + expect 给出解析解对照）');
console.log('  4. node node/tests.mjs   全绿（解析解对照 + 牛顿第二定律残差 <0.5%）');
console.log('  5. node node/audit.mjs   确认没有"非零却画不出来"的力');
console.log('  6. node node/package.mjs 生成单文件 HTML → dist/阿物先生-交付包/');
console.log('  7. 关键帧目视复验（node/qa.mjs + read_image），然后交付/转发');
console.log('');

if (fail) {
  console.log('结论：有 ' + fail + ' 个必需项未通过，请按上面的"修复"提示处理后重跑。');
  process.exit(1);
} else {
  console.log('结论：必需项全部就绪' + (warn ? '（' + warn + ' 个可选项未安装，不影响使用）' : '') +
    '。可以直接发照片给模型出模型了。');
}
