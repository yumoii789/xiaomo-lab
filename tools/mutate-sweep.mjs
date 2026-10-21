#!/usr/bin/env node
/**
 * 变异体扫描器 / 闸门审计（task-39）
 *
 * 治的根因：tools/zero-regression.mjs 是**硬编码清单**（没有 readdirSync）
 * ⇒ 一支新探针只要没被人手工登记，就永远**绿在闸门外** —— 那种绿是**假绿**。
 *
 * 本文件**只读**：不改任何文件、不改闸门、不启动浏览器、不起窗口。入册由 lead 决定。
 *
 * 分类（三类，逐类都有对应报数字段）：
 *   ① inGate  —— 盘上存在、且闸门清单里有它的 cmd ⇒ 已被闸门覆盖。
 *   ② outside —— 盘上存在、闸门清单里没有 ⇒ **最要命的一类**：它有自己的绿档，但没人跑它。
 *                只跑它的**绿档**（默认 node <探针>），记录 exit / 耗时 / 能否解析出计数。
 *   ③ ghosts  —— 闸门清单里有 cmd、但**盘上文件不存在**的条目（清单在骗人）。
 * 另记 gateNonProbe：清单里指向非 *-probe.mjs 的条目（check / guard-plugins / …），不是缺口。
 *
 * 判定口径（**缺失 ≠ 空**）：
 *   · 解析不出任何计数 ⇒ status 为 unknown，**绝不当 0、绝不当通过**。
 *   · status 取值：ok（解析出 fail===0 且 exit===0）/ red（fail>0）/
 *     exit-mismatch（exit≠0 但解析出 fail===0）/ unknown（解析不出）/ timeout /
 *     **needs-env**（环境不满足 ⇒ 结论作废：① 命中 browser 标记、被跳过；② exit===2「跑不起来」）。
 *     needs-env **既不当红、也不当通过** —— 它不含任何断言失败信息，把它算成任何一边都是撒谎。
 *   · **退出码不进内部判据**：它只被**记录**（字段 exit），判定一律看解析出来的字段。
 *   · ok（整体）= 无幽灵 **且** 闸门外为空（严格模式）。--allow-gaps 时只报告、仍 exit 0。
 *
 * 用法：
 *   node tools/mutate-sweep.mjs                        # 严格：有缺口 ⇒ exit 1
 *   node tools/mutate-sweep.mjs --allow-gaps           # 只报告（供入网用），exit 0
 *   node tools/mutate-sweep.mjs --no-run               # 只分类，不跑闸门外绿档
 *   node tools/mutate-sweep.mjs --timeout 45000        # 单支探针超时（毫秒，默认 90000）
 *   node tools/mutate-sweep.mjs --tools-dir <dir> --gate <file>   # 夹具用（%TEMP% 假 tools 目录）
 *   node tools/mutate-sweep.mjs --json-only            # stdout 只留那一行 JSON
 *   node tools/mutate-sweep.mjs --run-browser          # **显式**放行：连会 spawn 无头浏览器的探针也跑（见下）
 *
 * ⚠ 公共场所安全（lead 立的纪律，硬约束）：
 *   · 有些探针**自己会 spawn 无头 Edge**（要我实测确认过的：credit / motion / settings，另 glass-motion 也是同类
 *     但它在闸门里，本工具本来就不跑闸门内的）。它们还需要 http://127.0.0.1:7373 的静态服务（仓库根 server.mjs）；
 *     服务不在 ⇒ 导航超时 ⇒ exit 2「跑不起来」（耗时 38.7 / 35.7 / 68 s，settings 自带一次重试 ⇒ 双倍）。
 *   · 因此**默认跳过一切命中 browser 标记的探针**，记 needs-env / kind=browser，并回报命中了哪几条规则。
 *   · 要跑必须显式 `--run-browser`：**串行、一次一支**，且每支**前后各报一次**「无头实例数」
 *     （Get-CimInstance 按命令行 `--headless` 且不含 `--type=` 过滤；**读不出 ⇒ null = 未知，绝不当 0**），
 *     跑完对**只含 --headless 的 PID** 定点收尾。非无头（可视）模式**一律禁止** ✗。
 *   · 判定规则是**宁可错杀**的文本表（下一条注释里逐条列出）：命中即视为 browser 类，逐条写进报告可复核。
 *
 * 支持解析的字段名（别名表，全部写在这里，没有隐含约定）：
 *   计数：items | total | count | cases
 *   通过：pass  | passed
 *   失败：fail  | failed | failures
 *   形态：顶层对象，或顶层对象**再嵌一层**（如 done 里嵌 fail/total）。
 */

import { readdirSync, readFileSync, existsSync, statSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const SELF = fileURLToPath(import.meta.url);
const REPO = path.dirname(path.dirname(SELF));

/**
 * browser 类判定表（**宁可错杀、不可漏杀**；每条命中都写进报告的 browserMarkers）。
 * 规则来源：lead 的实测 + 本次 grep 出来的真实调用点（credit:421-423 / motion:577-579 / settings:365-367 等）。
 * 判据是**纯文本**的：同一份源码 ⇒ 同一个结论，可复现、可复核。
 */
const BROWSER_MARKERS = [
  { id: 'headless', re: /--headless/ },
  { id: 'user-data-dir', re: /--user-data-dir/ },
  { id: 'remote-debugging-port', re: /--remote-debugging-port/ },
  { id: 'puppeteer', re: /puppeteer/i },
  { id: 'playwright', re: /playwright/i },
  { id: 'chrome-launcher', re: /chrome-launcher/i },
  { id: 'msedge', re: /msedge/i },
  { id: 'chrome-exe', re: /chrome\.exe/i },
  { id: 'chromium', re: /chromium/i },
  { id: 'cdp-json-version', re: /json\/version/ },
  { id: 'static-server-7373', re: /server\.mjs|127\.0\.0\.1:7373/ },
];
const DQ = String.fromCharCode(34);

/** 一支探针源码命中哪些 browser 标记（顺序即上表顺序）。 */
function browserMarks(src) {
  const hits = [];
  for (const m of BROWSER_MARKERS) if (m.re.test(src)) hits.push(m.id);
  return hits;
}

/**
 * 无头实例快照 —— **只数「疑似探针起的」那些**，读不出就返回 null（未知 ≠ 0）。
 * 判据（lead 实测修正后）：
 *   · 排除 DSH 自己的内嵌浏览器：命令行含 `embedded-browser`（`C:\Users\Admin\.dsh\embedded-browser\profile`，带 49559 端口）✗
 *   · 计入「疑似探针实例」：命令行含 `--headless` **且** `--user-data-dir` 匹配 `xm-` 或落在 %TEMP% ✓
 *   · 其余无头实例单列 other（既不计入、也不去杀：可能不是我们起的）
 * 返回 { mine, dsh, other }：mine 是「这次该担心的」，dsh 是「本来就在的」，other 是「说不清的」。
 */
const HEADLESS_RULE_MINE = "--headless 且 (--user-data-dir 匹配 xm- 或落在 %TEMP%) 且不含 embedded-browser";
function headlessSnapshot() {
  const ps = [
    '$a = @(Get-CimInstance Win32_Process -Filter ' + DQ + "Name='msedge.exe'" + DQ + " | Where-Object { $_.CommandLine -match '--headless' })",
    "$dsh = @($a | Where-Object { $_.CommandLine -match 'embedded-browser' }).Count",
    "$mine = @($a | Where-Object { $_.CommandLine -notmatch 'embedded-browser' -and ($_.CommandLine -match 'xm-' -or $_.CommandLine -match [regex]::Escape($env:TEMP)) }).Count",
    '$other = $a.Count - $dsh - $mine',
    DQ + '$mine $dsh $other' + DQ,
  ].join('; ');
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', timeout: 20000 });
  if (r.error || r.status !== 0) return null;
  const parts = String(r.stdout || '').trim().split(/\s+/).map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return null;
  return { mine: parts[0], dsh: parts[1], other: parts[2] };
}

/** 收尾①：只对**疑似探针的无头实例**定点收掉（绝不动 DSH 内嵌浏览器，也绝不动用户的可视 Edge）。 */
function killHeadless() {
  const ps = 'Get-CimInstance Win32_Process -Filter ' + DQ + "Name='msedge.exe'" + DQ +
    " | Where-Object { $_.CommandLine -match '--headless' -and $_.CommandLine -notmatch 'embedded-browser'" +
    " -and ($_.CommandLine -match 'xm-' -or $_.CommandLine -match [regex]::Escape($env:TEMP)) }" +
    ' | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }';
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', timeout: 20000 });
  return { attempted: true, ok: !r.error && r.status === 0, err: r.error ? String(r.error.message) : null };
}

/** 收尾②：把探针留在 %TEMP% 的临时 profile 目录收掉（**只收目录名含 probe 的 xm-* 目录**，别误删别人的东西）。 */
function cleanupProfiles() {
  const tmp = os.tmpdir();
  const removed = [], failed = [];
  let names = [];
  try { names = readdirSync(tmp); } catch (e) {
    return { attempted: true, scanErr: String(e.message).slice(0, 120), removed, failed };
  }
  for (const name of names) {
    if (!/^xm-.*probe/i.test(name)) continue;
    const p = path.join(tmp, name);
    try { if (!statSync(p).isDirectory()) continue; } catch { continue; }
    try { rmSync(p, { recursive: true, force: true }); removed.push(name); }
    catch (e) { failed.push({ name, err: String(e.message).slice(0, 120) }); }   // 失败不算错，但要报出来
  }
  return { attempted: true, removed, failed };
}

const COUNT_KEYS = ['items', 'total', 'count', 'cases'];
const PASS_KEYS = ['pass', 'passed'];
const FAIL_KEYS = ['fail', 'failed', 'failures'];

function parseArgs(argv) {
  const o = {
    toolsDir: path.join(REPO, 'tools'),
    gate: path.join(REPO, 'tools', 'zero-regression.mjs'),
    allowGaps: false, noRun: false, jsonOnly: false, runBrowser: false, timeout: 90000,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--tools-dir') o.toolsDir = path.resolve(argv[++i]);
    else if (a === '--gate') o.gate = path.resolve(argv[++i]);
    else if (a === '--timeout') o.timeout = Number(argv[++i]) || 90000;
    else if (a === '--allow-gaps') o.allowGaps = true;
    else if (a === '--no-run') o.noRun = true;
    else if (a === '--json-only') o.jsonOnly = true;
    else if (a === '--run-browser') o.runBrowser = true;
    else if (a === '--help' || a === '-h') { console.log('用法见本文件头注释'); process.exit(0); }
    else { console.error('未知参数：' + a); process.exit(2); }
  }
  o.root = path.dirname(path.resolve(o.toolsDir));
  return o;
}

/** 从闸门源码切出条目：**行首锚定**的 id / cmd（注释行天然不匹配）。 */
function readGate(gateFile) {
  const src = readFileSync(gateFile, 'utf8');
  const entries = [];
  let lastId = null, lastIdLine = null;
  src.split(String.fromCharCode(10)).forEach((line, idx) => {
    const mi = line.match(/^\s*id:\s*['"]([^'"]+)['"]/);
    if (mi) { lastId = mi[1]; lastIdLine = idx + 1; }
    const mc = line.match(/^\s*cmd:\s*\[\s*['"]([^'"]+)['"]/);
    if (mc) { entries.push({ id: lastId, idLine: lastIdLine, cmd: mc[1], line: idx + 1 }); lastId = null; lastIdLine = null; }
  });
  return { src, entries };
}

/** 扫描文本里所有能 JSON.parse 的对象（串内/转义安全）。 */
function jsonObjects(text) {
  const out = [];
  const DQ = String.fromCharCode(34);
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') continue;
    let depth = 0, inStr = false, esc = false, end = -1;
    for (let j = i; j < text.length; j++) {
      const c = text[j];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === DQ) inStr = false;
        continue;
      }
      if (c === DQ) { inStr = true; continue; }
      if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) { end = j; break; } }
    }
    if (end < 0) continue;
    try { out.push(JSON.parse(text.slice(i, end + 1))); } catch { /* 不是 JSON，跳过 */ }
    i = end;
  }
  return out;
}

/** 在一个对象里按别名表取计数；本层取不到就往下嵌一层。 */
function pickFields(obj) {
  const found = { items: null, pass: null, fail: null, fields: [] };
  const eat = (o) => {
    if (!o || typeof o !== 'object' || Array.isArray(o)) return;
    let any = false;
    const grab = (keys, slot) => {
      for (const k of keys) {
        if (typeof o[k] === 'number' && found[slot] === null) { found[slot] = o[k]; found.fields.push(k); any = true; return; }
      }
    };
    grab(COUNT_KEYS, 'items'); grab(PASS_KEYS, 'pass'); grab(FAIL_KEYS, 'fail');
    if (!any) for (const v of Object.values(o)) eat(v);
  };
  eat(obj);
  return found;
}

/** 解析探针 stdout：取别名命中最多者；平票取**最后**一个（收尾 JSON 在最后）。 */
function parseProbeOut(text) {
  let best = null;
  for (const obj of jsonObjects(text)) {
    const f = pickFields(obj);
    if (f.fields.length === 0) continue;
    if (!best || f.fields.length >= best.fields.length) best = f;
  }
  return best;
}

function runProbe(o, rel) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [rel], {
    cwd: o.root, encoding: 'utf8', timeout: o.timeout, killSignal: 'SIGKILL',
    maxBuffer: 32 * 1024 * 1024,
  });
  const ms = Date.now() - t0;
  const out = String(r.stdout || '') + String(r.stderr || '');
  const parsed = parseProbeOut(String(r.stdout || ''));
  const errCode = r.error ? String(r.error.code || r.error.message) : '';
  const timedOut = errCode.indexOf('ETIMEDOUT') >= 0;
  const exit = typeof r.status === 'number' ? r.status : null;
  // kind 是**机制分类**（为什么读不出来），status 是**语义裁定**（能不能算通过）—— 两者分开记：
  // 「崩溃」与「只是没印 JSON」都是 unknown，但对人判断「这探针能不能入网」完全不是一回事。
  let kind;
  if (timedOut) kind = 'timeout';
  else if (exit === 2) kind = 'env';
  else if (!parsed) kind = exit !== 0 ? 'crash' : 'no-json';
  else kind = 'json';
  let status;
  // exit 2 = 本仓库约定的「跑不起来（环境不满足）」⇒ 结论作废：既不当红、也不当通过。
  if (timedOut) status = 'timeout';
  else if (exit === 2) status = 'needs-env';
  else if (!parsed) status = 'unknown';
  else if (parsed.fail !== null && parsed.fail > 0) status = 'red';
  else if (exit !== 0) status = 'exit-mismatch';
  else status = 'ok';
  return { exit, ms, timedOut, kind, status, parsed, stdoutBytes: String(r.stdout || '').length, stderrBytes: String(r.stderr || '').length, errCode: errCode || null, sample: (status === 'unknown' || status === 'needs-env') ? out.slice(-240) : null };
}

const o = parseArgs(process.argv.slice(2));
const gate = readGate(o.gate);
const entries = gate.entries;
const cmds = entries.map((e) => e.cmd);
const all = readdirSync(o.toolsDir).filter((f) => /-probe\.mjs$/.test(f)).sort();
const inGate = all.filter((f) => cmds.includes('tools/' + f));
const outside = all.filter((f) => !cmds.includes('tools/' + f));
const ghosts = entries.filter((e) => !existsSync(path.join(o.root, e.cmd)))
  .map((e) => ({ id: e.id, cmd: e.cmd, line: e.line }));
const gateNonProbe = entries.filter((e) => !/-probe\.mjs$/.test(e.cmd)).map((e) => e.cmd);

// 盘上**每一支**探针都过一遍 browser 判定表（含闸门内的）：
// 报告要能回答「这仓库里哪些探针会 spawn 浏览器」，而不只是「这次跑了哪些」。
const browserProbes = [];
for (const f of all) {
  const marks = browserMarks(readFileSync(path.join(o.toolsDir, f), 'utf8'));
  if (marks.length) browserProbes.push({ file: f, markers: marks, inGate: inGate.includes(f) });
}
const markOf = (f) => (browserProbes.find((b) => b.file === f) || { markers: [] }).markers;

const runs = [];
const skipped = [];
let cleanup = null;
if (!o.noRun) {
  for (const f of outside) {
    const marks = markOf(f);
    if (marks.length && !o.runBrowser) {
      // 默认**不跑**：记 needs-env（环境不满足），既不当红也不当通过。stdout/ms 全 0 ⇒ 可反证「真的没执行」。
      const e = { id: f.replace(/\.mjs$/, ''), file: f, run: false, status: 'needs-env', kind: 'browser',
        skipReason: 'spawns-browser', browserMarkers: marks, exit: null, ms: 0, timedOut: false, parsed: null,
        stdoutBytes: 0, stderrBytes: 0, errCode: null, sample: null };
      runs.push(e); skipped.push(e);   // 也进 outside 数组：报告里这支必须在场，不能因为没跑就消失
      continue;
    }
    // --run-browser：**串行、一次一支**，每支前后各报一次无头实例数（读不出 ⇒ null）。
    const before = o.runBrowser ? headlessSnapshot() : null;
    const rr = runProbe(o, 'tools/' + f);
    const after = o.runBrowser ? headlessSnapshot() : null;
    if (o.runBrowser) {
      rr.headless = { before, after,
        grew: (before === null || after === null) ? null : after.mine > before.mine };
    }
    runs.push({ id: f.replace(/\.mjs$/, ''), file: f, run: true, ...rr });
  }
  if (o.runBrowser) cleanup = { headless: killHeadless(), profiles: cleanupProfiles() };
}

const byStatus = (s) => runs.filter((r) => r.status === s).map((r) => r.id);
const byKind = (k) => runs.filter((r) => r.kind === k).map((r) => r.id);
const counts = {
  probes: all.length, gateEntries: entries.length, inGate: inGate.length, outside: outside.length,
  ghosts: ghosts.length, gateNonProbe: gateNonProbe.length,
  ran: runs.filter((r) => r.run !== false).length,
  gateProbeEntries: entries.filter((e) => /-probe\.mjs$/.test(e.cmd)).length,
  outsideOk: byStatus('ok').length, outsideRed: byStatus('red').length,
  outsideUnknown: byStatus('unknown').length, outsideExitMismatch: byStatus('exit-mismatch').length,
  outsideTimeout: byStatus('timeout').length, outsideNeedsEnv: byStatus('needs-env').length,
  outsideSkipped: skipped.length,
  kindJson: byKind('json').length, kindNoJson: byKind('no-json').length,
  kindCrash: byKind('crash').length, kindTimeout: byKind('timeout').length,
  kindEnv: byKind('env').length, kindBrowser: byKind('browser').length,
  browserOnDisk: browserProbes.length, browserInGate: browserProbes.filter((b) => b.inGate).length,
  browserOutside: browserProbes.filter((b) => !b.inGate).length,
  totalMs: runs.reduce((s, r) => s + r.ms, 0),
};
const gaps = counts.outside + counts.ghosts;
const out = {
  probe: 'mutate-sweep', mode: 'audit',
  toolsDir: o.toolsDir, gate: o.gate, root: o.root,
  aliases: { count: COUNT_KEYS, pass: PASS_KEYS, fail: FAIL_KEYS },
  browserRule: {
    // 判定规则**原文**：命中任一条即视为 browser 类（宁可错杀）
    markers: BROWSER_MARKERS.map((m) => m.id + ':' + m.re.source),
    note: '文本表；命中即 browser 类 ⇒ 默认不跑（needs-env / kind=browser）。要跑必须 --run-browser。',
  },
  headlessRule: { mine: HEADLESS_RULE_MINE, excludedDsh: "命令行含 embedded-browser（DSH 内嵌浏览器）", kill: '只杀 mine 那一类', profiles: '只删 %TEMP% 下目录名匹配 ^xm-.*probe 的目录' },
  counts, inGate, gateNonProbe,
  outside: runs,
  outsideNames: outside,
  skipped,
  browserProbes,
  ghosts,
  statuses: {
    ok: byStatus('ok'), red: byStatus('red'), unknown: byStatus('unknown'),
    exitMismatch: byStatus('exit-mismatch'), timeout: byStatus('timeout'),
    needsEnv: byStatus('needs-env'),
  },
  run: !o.noRun, runBrowser: o.runBrowser, cleanup,
  allowGaps: o.allowGaps,
  ok: gaps === 0, exitReason: 'outside=' + counts.outside + ' ghosts=' + counts.ghosts,
};

if (!o.jsonOnly) {
  console.error('变异体扫描器 / 闸门审计：盘上探针 ' + counts.probes + ' · 闸门条目 ' + counts.gateEntries +
    ' · 闸门内 ' + counts.inGate + ' · 闸门外 ' + counts.outside + ' · 幽灵 ' + counts.ghosts);
  if (runs.length) console.error('闸门外绿档：ok ' + counts.outsideOk + ' / red ' + counts.outsideRed +
    ' / unknown ' + counts.outsideUnknown + ' / exit-mismatch ' + counts.outsideExitMismatch +
    ' / timeout ' + counts.outsideTimeout + '（合计 ' + counts.totalMs + 'ms）');
  for (const r of runs) {
    const nums = r.parsed
      ? ' items=' + r.parsed.items + ' pass=' + r.parsed.pass + ' fail=' + r.parsed.fail + ' 字段[' + r.parsed.fields.join(',') + ']'
      : ' 解析不出 ⇒ unknown';
    console.error('  ' + r.status.padEnd(13) + r.file + ' exit=' + r.exit + ' ' + r.ms + 'ms' + nums);
  }
  for (const r of skipped) console.error('  ' + 'needs-env'.padEnd(13) + r.file + ' 跳过（命中 browser 标记：' + r.browserMarkers.join(',') + '）');
  if (browserProbes.length) console.error('browser 类探针（默认不跑）：' + browserProbes.map((b) => b.file + '[' + b.markers.join(',') + ']' + (b.inGate ? '(闸门内)' : '')).join(' '));
  for (const g of ghosts) console.error('幽灵条目：' + (g.id || '(无 id)') + ' → ' + g.cmd + '（清单第 ' + g.line + ' 行）');
}
console.log('MUTATE_SWEEP_JSON ' + JSON.stringify(out));
process.exit(out.ok || o.allowGaps ? 0 : 1);
