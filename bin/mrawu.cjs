#!/usr/bin/env node
/**
 * 阿物先生 MrAwU —— 命令行入口（零依赖）
 *
 *   npx mrawu                     把单文件 HTML 生成/取出到当前目录
 *   npx mrawu --out <文件|目录>    指定输出位置
 *   npx mrawu --list              列出全部模型
 *   npx mrawu --install-skill     把本 skill 安装到 <工作区>/.dsh/skills/MrAwU
 *   npx mrawu --check             跑环境自检 + 回归 + 受力审计 + 双引擎对拍
 *   npx mrawu --build [--] ...    从源码重新构建单文件 HTML（参数透传给 node/build.mjs）
 *
 * 设计原则：默认动作不依赖任何第三方包，也不需要联网——
 * 包里已经带了构建好的单文件 HTML，直接复制出来即可给老师用。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const HTML_NAME = '阿物先生.html';
const BUILT = path.join(ROOT, 'dist', HTML_NAME);
const SKILL_FILES = ['SKILL.md', 'README.md', 'CHECKLIST.md', 'AI_DISCLOSURE.md', 'LICENSE', 'package.json'];
const SKILL_DIRS = ['lib', 'browser', 'node', 'vendor', 'references', 'examples', 'docs'];

const HELP = `
阿物先生 MrAwU v${PKG.version} —— 把物理题图变成可交互的受力动画（单个离线 HTML）

用法：
  npx mrawu                    把单文件 HTML 写到当前目录（${HTML_NAME}）
  npx mrawu --out <文件|目录>   指定输出位置
  npx mrawu --list             列出全部可用模型
  npx mrawu --install-skill    把本 skill 装到 <工作区>/.dsh/skills/MrAwU（默认当前目录）
  npx mrawu --install-skill <目录> [--force]
  npx mrawu --check            环境自检 + 回归测试 + 受力审计 + 双引擎对拍
  npx mrawu --build [参数...]   从源码重新构建（参数透传给 node/build.mjs）
  npx mrawu --version | --help

说明：
  · 交付给老师的只有 ${HTML_NAME} 一个文件，双击就能用，不需要 Node / Python / 联网。
  · 物理计算由包内自研的 velocity-Verlet 引擎完成；Planck.js 只用于开发期的对拍复核，
    不会进入交付文件（详见 AI_DISCLOSURE.md 与 README 第六节）。
`.trim();

function log(s) { process.stdout.write(s + '\n'); }
function die(s) { process.stderr.write(s + '\n'); process.exit(1); }

function run(script, args) {
  // 用当前 Node 解释器跑包内脚本；stdio 继承，输出实时可见
  const r = spawnSync(process.execPath, [path.join(ROOT, 'node', script)].concat(args || []), {
    stdio: 'inherit', cwd: ROOT
  });
  if (r.error) die('执行失败：' + r.error.message);
  return r.status === 0;
}

/** 取（必要时构建）单文件 HTML */
function ensureHtml() {
  if (fs.existsSync(BUILT)) return BUILT;
  log('包里没有预构建的 HTML，正在从源码构建…');
  if (!run('build.mjs', ['--out', BUILT])) die('构建失败，请查看上面的报错。');
  if (!fs.existsSync(BUILT)) die('构建结束但没找到 ' + BUILT);
  return BUILT;
}

function copyHtml(out) {
  const src = ensureHtml();
  let dst = out || path.join(process.cwd(), HTML_NAME);
  // 传目录（或以分隔符结尾）时落到目录内的同名文件
  if (fs.existsSync(dst) && fs.statSync(dst).isDirectory()) dst = path.join(dst, HTML_NAME);
  else if (/[\\/]$/.test(out || '')) { fs.mkdirSync(dst, { recursive: true }); dst = path.join(dst, HTML_NAME); }
  fs.mkdirSync(path.dirname(path.resolve(dst)), { recursive: true });
  fs.copyFileSync(src, dst);
  const kb = (fs.statSync(dst).size / 1024).toFixed(0);
  log('已生成：' + path.resolve(dst) + '  (' + kb + ' KB)');
  log('');
  log('接下来：双击这个文件（Edge / Chrome 均可）。不需要装 Node、Python，也不需要联网。');
  log('想把它发给别人：直接发这一个文件就行。');
}

function installSkill(target, force) {
  const base = path.resolve(target || process.cwd());
  if (fs.existsSync(base) && !fs.statSync(base).isDirectory()) {
    die('安装目标是文件而不是目录：' + base + '\n请传一个目录（例如你的 DSH 工作区根目录）。');
  }
  const dest = path.join(base, '.dsh', 'skills', 'MrAwU');
  if (fs.existsSync(dest) && !force) {
    die('目标已存在：' + dest + '\n如需覆盖请加 --force（会先删除该目录）。');
  }
  try {
    if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(dest, { recursive: true });
    SKILL_FILES.forEach((f) => {
      const s = path.join(ROOT, f);
      if (fs.existsSync(s)) fs.copyFileSync(s, path.join(dest, f));
    });
    SKILL_DIRS.forEach((d) => {
      const s = path.join(ROOT, d);
      if (fs.existsSync(s)) fs.cpSync(s, path.join(dest, d), { recursive: true });
    });
  } catch (e) {
    die('安装失败：' + (e && e.message) + '\n目标：' + dest);
  }
  log('已安装 skill 到：' + dest);
  log('');
  log('注意两点：');
  log('  1. 文件夹名必须保持 MrAwU，且要与 SKILL.md 里的 name 字段一致；');
  log('  2. DSH 的 skill 清单在会话启动时加载 —— 请新开一个会话才能看到它。');
}

function main() {
  const argv = process.argv.slice(2);
  const has = (f) => argv.indexOf(f) >= 0;
  const valOf = (f, dflt) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt; };

  if (has('--version') || has('-v')) return log(PKG.version);
  if (has('--help') || has('-h')) return log(HELP);

  if (has('--list')) { run('sim.mjs', ['--list']); return; }

  if (has('--check')) {
    const steps = [['check-env.mjs', '环境自检'], ['tests.mjs', '回归测试（解析解对照）'],
      ['audit.mjs', '受力可见性审计'], ['compare-engines.cjs', '双引擎对拍']];
    let ok = true;
    steps.forEach((s) => { log('\n==== ' + s[1] + ' ===='); if (!run(s[0])) ok = false; });
    if (!ok) die('\n有检查项未通过。');
    return log('\n全部通过。');
  }

  if (has('--build')) {
    const i = argv.indexOf('--build');
    const rest = argv.slice(i + 1).filter((a) => a !== '--');
    if (!run('build.mjs', rest)) die('构建失败。');
    return;
  }

  if (has('--install-skill')) return installSkill(valOf('--install-skill', null), has('--force'));

  return copyHtml(valOf('--out', null));
}

main();
