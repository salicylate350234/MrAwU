#!/usr/bin/env node
/**
 * MrAwU / DSH 会话成本统计（Phase 0 基线测量）
 *
 * 用法:
 *   node node/cost.mjs                 # 人类可读摘要（<=60 行）
 *   node node/cost.mjs --json          # 机器可读 JSON
 *   node node/cost.mjs --dir <目录>    # 自定义 sessions 目录
 *   node node/cost.mjs --skip-current  # 跳过"本会话"（默认跳过 session-47e1...，它正在写入）
 *
 * 数据来源: <sessions>\<sessionId>\session.v4.jsonl.zstd
 *   该文件是「多个 zstd 帧首尾相接」的追加式日志（一次写入 = 一帧）。
 *   Node 内置 zlib.zstdDecompressSync 只解第一帧，因此这里按 magic(28 B5 2F FD)
 *   切帧后逐帧解压再拼接；无法解压的切片被丢弃（属噪声，不作为数据）。
 *   实测本机 node v24.21.0 支持 zstdDecompressSync，无需任何依赖。
 *
 * 实测字段（assistant/message 事件 → data.usage）:
 *   inputTokens / outputTokens / cacheReadTokens / cacheWriteTokens / totalTokens
 *   恒等式校验: totalTokens === inputTokens + cacheReadTokens + outputTokens
 *   （即 inputTokens 是「未命中缓存的新输入」，cacheReadTokens 是「命中缓存的上下文重放」）
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const DEFAULT_DIR = 'C:\\Users\\wakx\\.dsh\\sessions\\--C-Users-wakx-Documents-deepseek-harness-default-workspace--';
const DEFAULT_SKIP = 'session-47e1f363-8841-477a-a3a8-fb29313e0bbc';
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

const argv = process.argv.slice(2);
const ARGS = {
  json: argv.includes('--json'),
  dir: valueOf('--dir') || DEFAULT_DIR,
  skip: argv.includes('--include-current') ? null : (valueOf('--skip') || DEFAULT_SKIP),
};
function valueOf(flag) {
  const i = argv.indexOf(flag);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : null;
}

/* ---------------- 解压 ---------------- */

function decodeZstdJsonl(file) {
  const raw = fs.readFileSync(file);
  const parts = [];
  let frames = 0;
  let offset = raw.indexOf(ZSTD_MAGIC);
  if (offset === -1) {
    // 单帧且 magic 不在 0 位置（正常不会发生）
    return { text: zlib.zstdDecompressSync(raw).toString('utf8'), frames: 1, method: 'zstd(single)' };
  }
  while (offset !== -1) {
    const next = raw.indexOf(ZSTD_MAGIC, offset + 4);
    const end = next === -1 ? raw.length : next;
    try {
      parts.push(zlib.zstdDecompressSync(raw.subarray(offset, end)));
      frames++;
    } catch { /* 数据内部偶然出现的假 magic，丢弃该切片 */ }
    offset = next;
  }
  return { text: Buffer.concat(parts).toString('utf8'), frames, method: 'zstd(multi-frame)' };
}

/* ---------------- 工具 → 阶段 归类（启发式） ---------------- */

const STAGE_OF = {
  read: '读文件/检索', grep: '读文件/检索', glob: '读文件/检索', skill: '读文件/检索',
  cordis_inspect_list: '读文件/检索', cordis_inspect_query: '读文件/检索',
  list_agents: '读文件/检索', job_list: '读文件/检索', job_output: '读文件/检索',
  job_kill: '读文件/检索', interrupt_agent: '读文件/检索',
  write: '写文件', edit: '写文件',
  pwsh: '跑命令', load_workspace_dependencies: '跑命令',
  read_image: '图片读取',
  present: '出图/交付', deliverables_presented: '出图/交付',
  subagent: '子代理', send_message: '子代理', ask_user_question: '交互',
  todo_write: '其他', web_fetch: '其他', web_search: '其他',
};
function stageOfTool(name) {
  if (!name) return '未归类';
  if (/browser|screenshot|playwright|puppeteer|snapshot|capture/i.test(name)) return '浏览器截图';
  return STAGE_OF[name] || '其他';
}

/* ---------------- 单会话分析 ---------------- */

function analyzeSession(sessionId, file) {
  const size = fs.statSync(file).size;
  const { text, frames, method } = decodeZstdJsonl(file);
  const lines = text.split('\n').filter(Boolean);
  const ev = [];
  let bad = 0;
  for (const l of lines) {
    try { ev.push(JSON.parse(l)); } catch { bad++; }
  }
  const types = {};
  for (const e of ev) types[e.type] = (types[e.type] || 0) + 1;

  const assistants = ev.filter((e) => e.type === 'assistant/message');
  const toolCalls = ev.filter((e) => e.type === 'tool/call');
  const toolResults = ev.filter((e) => e.type === 'tool/result');
  const turnStarts = ev.filter((e) => e.type === 'turn/start');
  const turnEnds = ev.filter((e) => e.type === 'turn/end');
  const userMsgs = ev.filter((e) => e.type === 'user/message');

  // 真实用户输入 = 非 "Current runtime context" / 非系统回灌
  const realUser = userMsgs.filter((e) => {
    const t = textOf(e.data.content ?? (e.data.message && e.data.message.content));
    return t && !/^Current runtime context/.test(t) && !/^The approval policy/.test(t);
  });

  // usage（实测）
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 };
  const models = {};
  for (const a of assistants) {
    const u = a.data && a.data.usage;
    if (u) for (const k of Object.keys(usage)) usage[k] += u[k] || 0;
    const src = a.data && a.data.message && a.data.message.source;
    if (src && src.model) models[src.model] = (models[src.model] || 0) + 1;
  }
  const hasUsage = assistants.some((a) => a.data && a.data.usage);

  // 把 tool/call 按「时间上紧邻的上一条 assistant 消息」归到同一个 step
  const byStep = [];
  let cur = null;
  for (const e of ev) {
    if (e.type === 'assistant/message') {
      cur = { at: e.time, toolCalls: [], usage: (e.data && e.data.usage) || null };
      byStep.push(cur);
    } else if (e.type === 'tool/call') {
      if (!cur) { cur = { at: e.time, toolCalls: [], usage: null }; byStep.push(cur); }
      cur.toolCalls.push(e);
    }
  }

  // 工具调用延迟（实测）：按 seq 顺序把「该 call 之后第一条同 callId 的 result」配对。
  // 必须用「之后第一条」：callId 可能在后续轮次复用，若直接建 Map 会把延迟算成几十小时。
  const resultByCallId = new Map();
  {
    const pending = new Map(); // callId -> [result...]（按时间升序）
    for (const r of toolResults) {
      const id = r.data.toolCallId || (r.data.message && r.data.message.toolCallId);
      if (!id) continue;
      if (!pending.has(id)) pending.set(id, []);
      pending.get(id).push(r);
    }
    for (const arr of pending.values()) arr.sort((a, b) => a.time - b.time);
    for (const c of toolCalls) {
      const arr = pending.get(c.data.callId);
      if (!arr || !arr.length) continue;
      const k = arr.findIndex((r) => r.time >= c.time);
      if (k !== -1) resultByCallId.set(c.seq, arr.splice(k, 1)[0]);
    }
  }
  const toolByName = {};
  const stage = {};
  const errors = [];
  for (const c of toolCalls) {
    const name = c.data.name || '(unknown)';
    const st = stageOfTool(name);
    toolByName[name] = (toolByName[name] || 0) + 1;
    stage[st] = stage[st] || { calls: 0, ms: 0, paired: 0, maxMs: 0 };
    stage[st].calls++;
    const r = resultByCallId.get(c.seq);
    if (r) {
      const dt = Math.max(0, r.time - c.time);
      stage[st].ms += dt;
      stage[st].paired++;
      if (dt > stage[st].maxMs) stage[st].maxMs = dt;
    }
    if (r && r.data.message && r.data.message.isError) errors.push({ name, at: c.time });
  }
  // 估算口径：把该 step 的 usage 平均分摊到该 step 的每个 tool call 上
  for (const s of byStep) {
    if (!s.usage || s.toolCalls.length === 0) continue;
    const per = {
      inputTokens: s.usage.inputTokens / s.toolCalls.length,
      outputTokens: s.usage.outputTokens / s.toolCalls.length,
      cacheReadTokens: s.usage.cacheReadTokens / s.toolCalls.length,
      totalTokens: s.usage.totalTokens / s.toolCalls.length,
    };
    for (const c of s.toolCalls) {
      const st = stageOfTool(c.data.name);
      const g = stage[st];
      g.estInput = (g.estInput || 0) + per.inputTokens;
      g.estOutput = (g.estOutput || 0) + per.outputTokens;
      g.estCacheRead = (g.estCacheRead || 0) + per.cacheReadTokens;
      g.estTotal = (g.estTotal || 0) + per.totalTokens;
    }
  }

  // 墙钟：turn 区间之和（实测）+ 全程跨度
  let turnMs = 0;
  const n = Math.min(turnStarts.length, turnEnds.length);
  for (let i = 0; i < n; i++) turnMs += Math.max(0, turnEnds[i].time - turnStarts[i].time);
  const times = ev.map((e) => e.time).filter(Number.isFinite);
  const spanMs = times.length ? Math.max(...times) - Math.min(...times) : 0;

  return {
    sessionId, file, size, frames, decodedBytes: text.length, decodeMethod: method, lines: lines.length, badLines: bad,
    eventTypes: types, models,
    messages: ev.length, assistantTurns: assistants.length, toolCalls: toolCalls.length,
    toolResults: toolResults.length, userMessages: userMsgs.length, realUserMessages: realUser.length,
    usage, hasUsage, toolByName, stage, errors: errors.length,
    turnCount: turnStarts.length, turnMs, spanMs,
    times: times.length ? { first: Math.min(...times), last: Math.max(...times) } : null,
  };
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (c && (c.text || c.type)) || '').join(' ');
  return '';
}

/* ---------------- 汇总 ---------------- */

const SESSION_FILE = 'session.v4.jsonl.zstd';

function findSessions(dir, skip) {
  if (!fs.existsSync(dir)) return { dir, error: 'sessions 目录不存在', sessions: [] };
  // ② 单个会话目录：<dir>/session.v4.jsonl.zstd 直接存在 ⇒ 只统计这一个会话
  const direct = path.join(dir, SESSION_FILE);
  if (fs.existsSync(direct) && fs.statSync(direct).isFile()) {
    const sessionId = path.basename(path.resolve(dir));
    return { dir, error: null, sessions: sessionId === skip ? [] : [{ sessionId, file: direct }] };
  }
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const f = path.join(dir, name, 'session.v4.jsonl.zstd');
    if (name === skip) continue;
    if (fs.existsSync(f)) out.push({ sessionId: name, file: f });
  }
  out.sort((a, b) => fs.statSync(b.file).size - fs.statSync(a.file).size);
  return { dir, error: null, sessions: out };
}

const { dir, error, sessions } = findSessions(ARGS.dir, ARGS.skip);
const reports = [];
for (const s of sessions) {
  try { reports.push(analyzeSession(s.sessionId, s.file)); }
  catch (e) { reports.push({ sessionId: s.sessionId, file: s.file, error: e.message }); }
}

const agg = { sessions: reports.length, toolCalls: 0, toolResults: 0, assistantTurns: 0, messages: 0, realUserMessages: 0, turnMs: 0, bySize: 0, decodedBytes: 0, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 } };
const aggStage = {};
const aggTools = {};
for (const r of reports) {
  if (r.error) continue;
  agg.bySize += r.size;
  agg.decodedBytes += r.decodedBytes || 0;
  agg.toolCalls += r.toolCalls; agg.toolResults += r.toolResults;
  agg.assistantTurns += r.assistantTurns; agg.messages += r.messages;
  agg.realUserMessages += r.realUserMessages; agg.turnMs += r.turnMs;
  for (const k of Object.keys(agg.usage)) agg.usage[k] += r.usage[k] || 0;
  for (const [k, v] of Object.entries(r.stage)) {
    const g = (aggStage[k] = aggStage[k] || { calls: 0, ms: 0, maxMs: 0, estTotal: 0, estInput: 0, estOutput: 0, estCacheRead: 0 });
    g.calls += v.calls; g.ms += v.ms;
    if ((v.maxMs || 0) > g.maxMs) g.maxMs = v.maxMs || 0;
    g.estTotal += v.estTotal || 0; g.estInput += v.estInput || 0; g.estOutput += v.estOutput || 0; g.estCacheRead += v.estCacheRead || 0;
  }
  for (const [k, v] of Object.entries(r.toolByName)) aggTools[k] = (aggTools[k] || 0) + v;
}

const result = {
  generatedAt: new Date().toISOString(),
  node: process.version,
  zstdBuiltin: typeof zlib.zstdDecompressSync === 'function',
  sessionsDir: dir, error, skippedSessionId: ARGS.skip,
  usageFields: ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'totalTokens'],
  identityCheck: 'totalTokens = inputTokens + cacheReadTokens + outputTokens',
  estimateCaveat: '阶段 token 为估算：step 的 usage 按该 step 内 tool call 数均摊，非真实逐调用计费；次数与耗时(ms)为实测。',
  sessions: reports.map((r) => (r.error ? r : {
    sessionId: r.sessionId, sizeBytes: r.size, frames: r.frames, lines: r.lines, badLines: r.badLines,
    messages: r.messages, assistantTurns: r.assistantTurns, toolCalls: r.toolCalls,
    toolResults: r.toolResults, userMessages: r.userMessages, realUserMessages: r.realUserMessages,
    usage: r.usage, hasUsage: r.hasUsage, models: r.models, errors: r.errors,
    turnCount: r.turnCount, turnMs: r.turnMs, spanMs: r.spanMs, eventTypes: r.eventTypes,
    toolByName: r.toolByName,
    stage: Object.fromEntries(Object.entries(r.stage).map(([k, v]) => [k, v])),
  })),
  total: agg,
  totalStage: aggStage,
  totalToolByName: aggTools,
};

if (ARGS.json) {
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
} else {
  process.stdout.write(render(result) + '\n');
}

/* ---------------- 人类可读渲染（<=60 行） ---------------- */

function render(r) {
  const L = [];
  const nf = (n) => Number(n || 0).toLocaleString('en-US');
  const mins = (ms) => (ms / 60000).toFixed(1) + 'min';
  L.push('== MrAwU / DSH 会话成本基线 ==  node ' + r.node + '  zstd内置=' + r.zstdBuiltin);
  L.push('sessions: ' + r.sessionsDir);
  if (r.error) L.push('!! ' + r.error);
  L.push('usage 字段(实测): ' + r.usageFields.join(', '));
  L.push('恒等式(已校验): ' + r.identityCheck);
  L.push('');
  L.push('-- 每会话 --');
  L.push('会话id(短)          消息 assist 工具call 真用户 日志MB 帧数     input    cacheRead     output      total      墙钟(turn)');
  for (const s of r.sessions) {
    if (s.error) { L.push(s.sessionId.slice(0, 18).padEnd(20) + 'ERR ' + s.error); continue; }
    L.push(
      s.sessionId.slice(0, 18).padEnd(20) +
      String(s.messages).padStart(6) + String(s.assistantTurns).padStart(7) +
      String(s.toolCalls).padStart(9) + String(s.realUserMessages).padStart(7) +
      (s.sizeBytes / 1048576).toFixed(1).padStart(7) + String(s.frames).padStart(7) +
      nf(s.usage.inputTokens).padStart(11) + nf(s.usage.cacheReadTokens).padStart(13) +
      nf(s.usage.outputTokens).padStart(12) + nf(s.usage.totalTokens).padStart(13) +
      '  ' + mins(s.turnMs) + '(跨度' + mins(s.spanMs) + ')'
    );
  }
  L.push('');
  L.push('-- 阶段归类 Top（次数/耗时=实测；token=估算）--');
  L.push('阶段            次数  工具耗时(s) 最长一次(s)  估算 input  估算 cacheRead  估算 output   估算 total');
  const stages = Object.entries(r.totalStage).sort((a, b) => b[1].calls - a[1].calls).slice(0, 8);
  for (const [k, v] of stages) {
    L.push(
      k.padEnd(15) + String(v.calls).padStart(5) + (v.ms / 1000).toFixed(0).padStart(11) +
      ((v.maxMs || 0) / 1000).toFixed(0).padStart(12) +
      nf(Math.round(v.estInput || 0)).padStart(12) + nf(Math.round(v.estCacheRead || 0)).padStart(15) +
      nf(Math.round(v.estOutput || 0)).padStart(14) + nf(Math.round(v.estTotal || 0)).padStart(14)
    );
  }
  L.push('');
  const tools = Object.entries(r.totalToolByName).sort((a, b) => b[1] - a[1]).slice(0, 8);
  L.push('工具次数 Top: ' + tools.map(([k, v]) => k + '=' + v).join(' '));
  L.push('合计: ' + nf(r.total.toolCalls) + ' 工具调用 / ' + nf(r.total.assistantTurns) + ' assistant 轮 / ' +
    nf(r.total.realUserMessages) + ' 真实用户输入 / 墙钟(turn 之和) ' + mins(r.total.turnMs) +
    ' / 解压后文本 ' + (r.total.decodedBytes / 1048576).toFixed(0) + 'MB');
  L.push('');
  L.push('== 口径 ==');
  L.push('实测: 消息/轮/调用次数、日志体积、zstd 帧数、工具耗时(call→result, 按序配对)、turn 墙钟、usage 五项 token。');
  L.push('估算: 阶段 token——把每个 step 的 usage 均摊到该 step 的 tool call 上，仅用于排序，不可当账单。');
  L.push('注: 「跨度」含会话中断的挂机间隔，不代表工作时长；墙钟只累加 turn/start→turn/end。');
  L.push('未测: 出图墙钟(题图→成品 HTML)未单独埋点；子代理自身会话日志不计入本统计。');
  return L.join('\n');
}
