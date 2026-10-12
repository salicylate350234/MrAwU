#!/usr/bin/env node
/**
 * 单独进程里打一个 zip：
 *   node node/zip-one.cjs <srcDir> <outZip> [entry]
 *
 * 为什么单独一个脚本：本机上在 package.mjs 主进程里直接压缩会让 Node 崩溃
 * （exit 0xC0000409），但同样的调用放到独立 Node 进程里执行是正常的。
 * 隔离出去之后，即使压缩进程出问题，父进程也能照常收尾并给出提示。
 */
'use strict';

const zip = require('./ziputil.cjs');

const [srcDir, outZip, entry] = process.argv.slice(2);
if (!srcDir || !outZip) {
  console.error('用法：node node/zip-one.cjs <srcDir> <outZip> [entry]');
  process.exit(2);
}

try {
  const r = zip.zipDir(srcDir, outZip, entry || null);
  console.log('  已压缩 ' + r.files + ' 个文件 → ' + outZip + '  (' + (r.bytes / 1024).toFixed(0) + ' KB)');
} catch (e) {
  console.error('压缩失败：' + (e && e.message));
  process.exit(1);
}
