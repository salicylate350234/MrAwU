/**
 * 极简 zip 打包器（纯 Node，无依赖，跨平台）。
 *
 * 为什么不用系统命令：
 *   早先 dev 用 spawnSync('powershell', Compress-Archive) 压缩，在本机环境下
 *   会让 Node 进程直接崩溃（exit 0xC0000409），换成 tar.exe 也一样——凡是
 *   spawnSync 调**外部程序**都会崩，只有调 Node 自身正常。
 *   于是改成纯 JS 写 zip：既不崩，也不再依赖 Windows 专有命令（macOS/Linux 同样能跑）。
 *
 * 实现要点：
 *   · deflate 用 zlib.deflateRawSync（method 8），CRC32 自算（不依赖 Node 版本）
 *   · 文件名一律用正斜杠；通用位标记 bit 11 = 1，声明文件名为 UTF-8（中文名必需）
 *   · ZIP64 不实现——本项目的包体量（< 4 GB / < 65535 文件）用不到
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/** DOS 时间（zip 的时间字段是 1980 起算的旧格式） */
function dosTime(d) {
  const time = ((d.getHours() << 11) | (d.getMinutes() << 5) | (Math.floor(d.getSeconds() / 2))) & 0xffff;
  const date = (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff;
  return { time, date };
}

/** 递归收集文件，返回 [{ abs, rel（正斜杠） }] */
function collect(dir, base, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    const rel = (base ? base + '/' : '') + e.name;
    if (e.isDirectory()) collect(abs, rel, out);
    else if (e.isFile()) out.push({ abs, rel });
  }
  return out;
}

/**
 * 把 srcDir 的内容打成 zip。
 * entry 传目录名时，zip 内会多一层该目录（源码包需要 MrAwU/ 这一层）。
 */
function zipDir(srcDir, outZip, entry) {
  const root = entry ? path.dirname(srcDir) : srcDir;
  const base = entry ? path.basename(srcDir) : '';
  const files = collect(srcDir, base, []);

  const chunks = [];
  const central = [];
  let offset = 0;

  for (const f of files) {
    const data = fs.readFileSync(f.abs);
    const comp = zlib.deflateRawSync(data, { level: 9 });
    const name = Buffer.from(f.rel, 'utf8');
    const { time, date } = dosTime(fs.statSync(f.abs).mtime);
    const crc = crc32(data);
    const useDeflate = comp.length < data.length;
    const body = useDeflate ? comp : data;
    const method = useDeflate ? 8 : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);            // version needed
    local.writeUInt16LE(0x0800, 6);        // bit 11：文件名为 UTF-8
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);            // extra length

    chunks.push(local, name, body);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);               // version made by
    cd.writeUInt16LE(20, 6);               // version needed
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(time, 12);
    cd.writeUInt16LE(date, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt16LE(0, 30);               // extra
    cd.writeUInt16LE(0, 32);               // comment
    cd.writeUInt16LE(0, 34);               // disk number
    cd.writeUInt16LE(0, 36);               // internal attrs
    cd.writeUInt32LE(0, 38);               // external attrs
    cd.writeUInt32LE(offset, 42);          // local header offset
    central.push(cd, name);

    offset += local.length + name.length + body.length;
  }

  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  fs.rmSync(outZip, { force: true });
  fs.mkdirSync(path.dirname(outZip), { recursive: true });
  fs.writeFileSync(outZip, Buffer.concat([Buffer.concat(chunks), cdBuf, eocd]));
  void root;
  return { files: files.length, bytes: fs.statSync(outZip).size };
}

module.exports = { zipDir, crc32 };
