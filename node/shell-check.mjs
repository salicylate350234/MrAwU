/*!
 * MrAwU（阿物先生）— node/shell-check.mjs
 * 自检本机 shell 环境：pwsh 是否可用、脚本里是否还残留 'powershell' 调用。
 *
 * 为什么要它：本机曾因 pwsh 不在 PATH 而让 DSH 工具调用回退到 Windows PowerShell 5.1，
 * 5.1 会吃原生命令参数里的双引号、并给 Set-Content 写 BOM —— 这两类坑在本项目反复出现过。
 * 用法： node node/shell-check.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let bad = 0;
const ok = (m) => console.log('  [✓] ' + m);
const warn = (m) => { bad++; console.log('  [!] ' + m); };

console.log('MrAwU shell 环境自检');

// 1) 本进程的 shell 版本（Node 跑在什么 shell 里看不出来，但可报告 PATH 上有没有 pwsh）
const found = spawnSync('pwsh', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'], { encoding: 'utf8' });
if (found.status === 0 && found.stdout.trim()) ok('PATH 上的 pwsh 可用：' + found.stdout.trim());
else warn('PATH 上找不到可用的 pwsh（DSH 的 pwsh 调用可能回退到 Windows PowerShell 5.1）');

// 2) 绝对路径兜底
const abs = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe';
if (fs.existsSync(abs)) {
  const r = spawnSync(abs, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'], { encoding: 'utf8' });
  ok('绝对路径 pwsh 可用：' + (r.stdout || '').trim() + '  (' + abs + ')');
} else {
  warn('未找到 ' + abs + '（需要时请安装 PowerShell 7）');
}

// 3) 脚本里是否还有 'powershell' 调用（应全部是 pwsh 或纯 Node）
const hits = [];
for (const dir of ['node', 'lib', 'browser']) {
  const d = path.join(ROOT, dir);
  if (!fs.existsSync(d)) continue;
  for (const f of fs.readdirSync(d)) {
    if (!/\.(mjs|cjs|js)$/.test(f)) continue;
    const txt = fs.readFileSync(path.join(d, f), 'utf8');
    txt.split('\n').forEach((line, i) => {
      if (/spawn(Sync)?\(\s*['"]powershell['"]/.test(line) || /exec(Sync)?\(\s*['"]powershell['"]/.test(line)) {
        hits.push(dir + '/' + f + ':' + (i + 1));
      }
    });
  }
}
if (hits.length) warn('以下脚本仍调用 powershell（应改为纯 Node 或 pwsh）：' + hits.join(', '));
else ok('node/ lib/ browser/ 中没有硬编码的 powershell 调用');

console.log(bad ? '结论：有 ' + bad + ' 项需要注意' : '结论：shell 环境就绪');
process.exit(0);
