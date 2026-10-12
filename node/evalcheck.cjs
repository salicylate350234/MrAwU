/* 诊断：把生成好的单文件 HTML 里的 <script> 块按顺序求值，报告哪一块抛错、注册了哪些 PFA 模块 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const file = process.argv[2];
if (!file) { console.error('用法: node node/_evalcheck.cjs <html>'); process.exit(2); }
const html = fs.readFileSync(file, 'utf8');
const blocks = [];
const re = /<script>([\s\S]*?)<\/script>/g;
let m;
while ((m = re.exec(html))) blocks.push(m[1]);

const sandbox = {
  console: console, setTimeout: setTimeout, clearTimeout: clearTimeout,
  document: { addEventListener() {}, getElementById() { return null; }, createElement() { return { style: {}, classList: { add() {}, toggle() {} }, appendChild() {} }; }, body: { appendChild() {}, classList: { toggle() {} } }, querySelectorAll() { return []; } },
  window: {}, navigator: { userAgent: 'node' }, requestAnimationFrame() {}, performance: { now: () => Date.now() },
  localStorage: { getItem() { return null; }, setItem() {} }, MouseEvent: function () {}, Event: function () {}
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
const ctx = vm.createContext(sandbox);

console.log('共 ' + blocks.length + ' 个 <script> 块');
blocks.forEach((code, i) => {
  const head = code.trim().slice(0, 46).replace(/\s+/g, ' ');
  try {
    vm.runInContext(code, ctx, { filename: 'block' + i + '.js' });
    const keys = sandbox.PFA ? Object.keys(sandbox.PFA) : [];
    console.log('  [' + i + '] OK   ' + (code.length / 1024).toFixed(0) + ' KB  ' + head +
      (keys.length ? '   PFA={' + keys.join(',') + '}' : ''));
  } catch (e) {
    console.log('  [' + i + '] ✗ 抛错 ' + (code.length / 1024).toFixed(0) + ' KB  ' + head);
    console.log('        ' + e.constructor.name + ': ' + e.message);
    const line = (e.stack || '').split('\n').find(l => /block\d+\.js:\d+/.test(l));
    if (line) console.log('        ' + line.trim());
  }
});
