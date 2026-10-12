/*!
 * MrAwU（阿物先生）— node/package.mjs
 * 生成"可以直接发给别人"的交付包：
 *   dist/阿物先生-交付包/
 *     阿物先生.html     ← 双击即用，不需要 node/python/联网
 *     使用说明.txt                     ← 给不熟悉电脑的老师看的最短说明
 *     详细说明.md                      ← README 的副本
 *   阿物先生-交付包.zip            ← 直接发微信/邮件/U 盘
 *
 * 用法： node node/package.mjs [--title "..."]
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import zip from './ziputil.cjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const ti = args.indexOf('--title');
const TITLE = ti >= 0 ? args[ti + 1] : '阿物先生';

function run(script, extra) {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'node', script)].concat(extra || []), {
    stdio: 'inherit', cwd: ROOT
  });
  if (r.status !== 0) throw new Error(script + ' 执行失败');
}

console.log('\n【1/5】先跑回归测试（必须全绿才打包）');
run('tests.mjs');

console.log('\n【2/5】受力可见性审计（确认没有"非零却画不出来"的力）');
run('audit.mjs');

console.log('\n【3/5】双引擎对拍（已迁移到自研 Verlet 的模型必须与 planck/解析解一致）');
run('compare-engines.cjs');

console.log('\n【4/5】生成单文件 HTML');
run('build.mjs', ['--title', TITLE]);

const pkgDir = path.join(ROOT, 'dist', '阿物先生-交付包');
// 清空交付目录：**逐项删除**而不是整树 fs.rmSync ——
// 本机上对整棵树做 rmSync 会让 Node 进程直接崩（exit 0xC0000409），
// 逐项删则正常（怀疑是安全软件挂钩了批量删除）。
if (fs.existsSync(pkgDir)) {
  for (const e of fs.readdirSync(pkgDir)) {
    fs.rmSync(path.join(pkgDir, e), { recursive: true, force: true });
  }
} else {
  fs.mkdirSync(pkgDir, { recursive: true });
}

const htmlSrc = path.join(ROOT, 'dist', '阿物先生.html');
// 交付文件名固定，不随 --title 变化（标题只影响页面内显示），避免每次改名后找不到文件
const htmlDst = path.join(pkgDir, '阿物先生.html');
fs.copyFileSync(htmlSrc, htmlDst);
fs.copyFileSync(path.join(ROOT, 'README.md'), path.join(pkgDir, '详细说明.md'));
fs.copyFileSync(path.join(ROOT, 'CHECKLIST.md'), path.join(pkgDir, '环境清单.md'));
// AI 使用披露：随交付包一起发，老师/学校有权知道内容由 AI 参与生成、责任归属与记录可查
fs.copyFileSync(path.join(ROOT, 'AI_DISCLOSURE.md'), path.join(pkgDir, 'AI_DISCLOSURE.md'));
fs.copyFileSync(path.join(ROOT, 'LICENSE'), path.join(pkgDir, 'LICENSE'));
// README（= 包里的「详细说明.md」）引用了 docs/ 下的预览图；
// 不把 docs/ 一起带上，老师打开详细说明就会看到裂图。
if (fs.existsSync(path.join(ROOT, 'docs'))) {
  fs.cpSync(path.join(ROOT, 'docs'), path.join(pkgDir, 'docs'), { recursive: true });
}

const readmeTxt = [
  '阿物先生 —— 使用说明',
  '=====================================',
  '',
  '【怎么打开】',
  '  双击本文件夹里的「阿物先生.html」即可，用 Edge 或 Chrome 打开。',
  '  不需要安装 Node.js、不需要安装 Python、不需要联网、不需要放到特定目录。',
  '  从 U 盘、微信、邮件附件里直接双击都能用。',
  '',
  '【怎么用】',
  '  左上「模型」下拉：切换 斜面/传送带/板块/连接体/滑轮/弹簧/平抛/圆周/碰撞/三力平衡 等模型。',
  '  左栏滑杆：拖动就重算，动画和受力立刻跟着变。',
  '  「播放 / 上一帧 / 下一帧 / 重置」+ 速度 0.1x~2x：逐帧讲解很方便。',
  '  「显示图层」：可以只留受力箭头，或关掉网格/轨迹让画面更干净。',
  '  键盘：空格=播放暂停，←→=单帧，R=重置。',
  '',
  '【颜色含义】',
  '  蓝=重力   绿=法向力/支持力   橙=摩擦力   紫=绳张力/杆约束力   红=外力   白=合力',
  '  所有力一律画在物体的重心处，箭头长度按左下角「力标尺」的比例。',
  '',
  '【怎么确认它没算错】',
  '  下边栏「解析值 vs 仿真值」：左边是公式算出来的，右边是物理引擎算出来的，还有误差。',
  '  其中「残差」一列正常是 0.000%，接近 100% 就说明受力方向错了。',
  '',
  '【怎么发给别人】',
  '  直接把「阿物先生.html」这一个文件发出去就行。',
  '  体积约 400 KB，内含完整物理引擎，所以离线也能算。',
  '',
  '【已知边界】',
  '  只支持二维平面力学（圆锥摆、三维力系做不了）。',
  '  碰撞瞬间的接触力是冲量折算的平均力；平滑过程（斜面、连接体、简谐）精度最高。',
  '',
  '更详细的说明见同目录「详细说明.md」。',
  '想在 DSH 里"拍张物理题照片就出动画"，见同目录「环境清单.md」。',
  '本工具的内容由 AI 助手在人机交互会话中生成，责任归属与记录查阅方式见「AI_DISCLOSURE.md」。',
  ''
].join('\r\n');
fs.writeFileSync(path.join(pkgDir, '使用说明.txt'), readmeTxt, 'utf8');

// 压缩交给**独立子进程**（node/zip-one.cjs → node/ziputil.cjs）：
// 本机上在主进程里压缩会让 Node 直接崩（exit 0xC0000409），隔离后父进程不受影响，
// 而且调 Node 自身的 spawnSync 在本环境是正常的（调 powershell/tar 才崩）。
function zipDir(srcDir, outZip, entry) {
  const args = [path.join(ROOT, 'node', 'zip-one.cjs'), srcDir, outZip];
  if (entry) args.push(entry);
  const r = spawnSync(process.execPath, args, { stdio: 'inherit' });
  if (r.error || r.status !== 0) {
    console.log('（zip 生成失败：' + (r.error ? r.error.message : '子进程退出码 ' + r.status) +
      '，可手动压缩 ' + srcDir + '）');
    return false;
  }
  return true;
}

console.log('\n【5/5】压缩成 zip');
const zipPath = path.join(ROOT, 'dist', '阿物先生-交付包.zip');
zipDir(pkgDir, zipPath, null);

console.log('\n【5/5】打包源码（给需要二次开发/加题型的老师）');
const srcStage = path.join(ROOT, 'build', 'src-pkg', 'MrAwU');
fs.rmSync(path.join(ROOT, 'build', 'src-pkg'), { recursive: true, force: true });
fs.mkdirSync(srcStage, { recursive: true });
['SKILL.md', 'README.md', 'AI_DISCLOSURE.md', 'LICENSE', 'package.json'].forEach(function (f) {
  fs.copyFileSync(path.join(ROOT, f), path.join(srcStage, f));
});
// bin/ 是 npm 包的命令行入口，源码包也要带上（否则拿到源码的人没有 npx mrawu）
['bin', 'lib', 'browser', 'node', 'vendor', 'references', 'examples', 'docs'].forEach(function (d) {
  const src = path.join(ROOT, d);
  if (fs.existsSync(src)) fs.cpSync(src, path.join(srcStage, d), { recursive: true });
});
const srcZip = path.join(ROOT, 'dist', '阿物先生-源码包.zip');
zipDir(path.join(ROOT, 'build', 'src-pkg'), srcZip, 'MrAwU');

console.log('\n交付包已生成：');
console.log('  目录: ' + pkgDir);
if (fs.existsSync(zipPath)) console.log('  教师包: ' + zipPath + '  (' + (fs.statSync(zipPath).size / 1024).toFixed(0) + ' KB)');
console.log('  HTML  : ' + htmlDst + '  (' + (fs.statSync(htmlDst).size / 1024).toFixed(0) + ' KB)');
if (fs.existsSync(srcZip)) console.log('  源码包: ' + srcZip + '  (' + (fs.statSync(srcZip).size / 1024).toFixed(0) + ' KB)');
