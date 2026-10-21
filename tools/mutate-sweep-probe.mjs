#!/usr/bin/env node
/**
 * 变异体扫描器 的探针（task-39）：给 tools/mutate-sweep.mjs 装闸门。
 *
 * 判据分两半：
 *   ① **夹具**（%TEMP% 里现造的假 tools 目录）—— 只跑假探针，钉**行为**：
 *      能解析 ⇒ ok；解析不出 ⇒ unknown（绝不当 0/通过）；崩溃 ⇒ unknown+crash；
 *      exit≠0 但印了 JSON ⇒ exit-mismatch；别名表（total/passed/failed）真的生效；
 *      幽灵条目被数出来；闸门里**注释掉**的 cmd 不许被计入。
 *   ② **真仓不变量** —— 只跑 --no-run 做分类（不起子进程、秒级），钉**结构**：
 *      盘上探针集合 == 闸门内 ∪ 闸门外、两者不交、ok == (闸门外+幽灵==0)、幽灵必须真的不存在。
 *      ⇒ 闸门里以后**多登记**几支探针，这些断言**不会红**（不变量，不是快照）。
 *
 * 红档：变异体打到 tools/mutate-sweep.mjs（副本落 %TEMP%，仓库零副作用），子进程（--judge）
 * 用 MUTATE_SWEEP_TOOL 指向变异体、只走绿档路径；判定通道是**子进程 stdout**，退出码不进判据。
 * 两面镜子：金丝雀必红 + null 对照（语义零改动）必 0 红。
 */

import { mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const SELF = fileURLToPath(import.meta.url);
const ROOT = path.dirname(path.dirname(SELF));
const TOOL_PATH = process.env.MUTATE_SWEEP_TOOL || path.join(ROOT, 'tools', 'mutate-sweep.mjs');
const TAG = 'MUTATE_SWEEP_JSON';
const Q = String.fromCharCode(39);
const NL = String.fromCharCode(10);
const MUTATE = process.argv.includes('--mutate');
const JUDGE = process.argv.includes('--judge');

const seen = [];
const reds = [];
let items = 0, pass = 0;
function check(id, ok, detail) {
  items++;
  if (ok) pass++;
  else reds.push(id);
  seen.push({ id: id, ok: ok === true, detail: String(detail === undefined ? '' : detail).slice(0, 200) });
}

function runTool(args) {
  const r = spawnSync(process.execPath, [TOOL_PATH].concat(args), {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 26, timeout: 120000,
  });
  const out = String(r.stdout || '');
  const lines = out.split(NL).filter((l) => l.indexOf(TAG) >= 0);
  let json = null, parseErr = null;
  if (lines.length) {
    const s = lines[lines.length - 1];
    try { json = JSON.parse(s.slice(s.indexOf('{'))); } catch (e) { parseErr = String(e.message); }
  }
  return { exit: typeof r.status === 'number' ? r.status : null, json: json, tagLines: lines.length,
    parseErr: parseErr, stderr: String(r.stderr || '').slice(-300) };
}

// browser 标记字面量在这里**拆开拼**：本探针自己的源码里不出现任何完整标记（否则自己命中那张表 = 自伤），
// 但 lit() 拼**进夹具文件**的是完整标记 ⇒ 判定表要抓的就是文件里那份 ✓
const HL = '--head' + 'less=new';
const UDD = '--user-data' + '-dir=xm-fake-profile';
const EDGE = 'ms' + 'edge.exe';
const FIX = path.join(os.tmpdir(), 'xm-sweep-fix-' + process.pid + '-' + Date.now().toString(36));
function writeFix() {
  mkdirSync(path.join(FIX, 'tools'), { recursive: true });
  const w = (rel, body) => writeFileSync(path.join(FIX, rel), body.join(NL) + NL, 'utf8');
  const lit = (s) => Q + s + Q;
  w('tools/a-parse-probe.mjs', [
    'const o = { items: 4, pass: 4, fail: 0 };',
    'console.log(' + lit('A_JSON') + ' + JSON.stringify(o));',
  ]);
  w('tools/b-noparse-probe.mjs', [
    'console.log(' + lit('这支探针只印人读文本，没有任何 JSON') + ');',
  ]);
  w('tools/c-crash-probe.mjs', [
    'throw new Error(' + lit('夹具：故意崩溃') + ');',
  ]);
  w('tools/d-exitmismatch-probe.mjs', [
    'console.log(' + lit('D_JSON') + ' + JSON.stringify({ items: 3, pass: 3, fail: 0 }));',
    'process.exit(1);',
  ]);
  w('tools/e-alias-probe.mjs', [
    'console.log(' + lit('E_JSON') + ' + JSON.stringify({ total: 7, passed: 7, failed: 0 }));',
  ]);
  // ⑥ 能解析（标准字段名）+ **没被登记** ⇒ 扫描器会真的跑它（a-parse-probe 被登记了 ⇒ 不进闸门外，不会被跑）
  w('tools/f-parse-probe.mjs', [
    'console.log(' + lit('F_JSON') + ' + JSON.stringify({ items: 6, pass: 6, fail: 0 }));',
  ]);
  // ⑦ browser 类：**写出来的文件里**带完整标记，但它自己**不 spawn 任何东西**（万一被跑也绝对无害）
  w('tools/g-headless-probe.mjs', [
    'const fakeArgs = [' + lit(HL) + ', ' + lit(UDD) + ', ' + lit(EDGE) + '];',
    'console.log(' + lit('夹具：browser 类（默认不该被跑）') + ');',
    'console.log(fakeArgs.length);',
  ]);
  // ⑧ exit 2 = 本仓库约定的「跑不起来（环境不满足）」⇒ needs-env，既不当红也不当通过
  w('tools/h-exit2-probe.mjs', [
    'console.log(' + lit('夹具：跑不起来（环境不满足）') + ');',
    'process.exit(2);',
  ]);
  w('tools/check.mjs', ['console.log(' + lit('夹具：非探针') + ');']);
  w('zero-regression.mjs', [
    'const SUITE = [',
    '  {',
    '    id: ' + lit('a-parse-probe') + ',',
    '    cmd: [' + lit('tools/a-parse-probe.mjs') + '],',
    '    expect: ' + lit('A_JSON') + ',',
    '  },',
    '  // {',
    '  //   id: ' + lit('commented') + ',',
    '  //   cmd: [' + lit('tools/commented-probe.mjs') + '],',
    '  // },',
    '  {',
    '    id: ' + lit('ghost-probe') + ',',
    '    cmd: [' + lit('tools/ghost-probe.mjs') + '],',
    '  },',
    '  {',
    '    id: ' + lit('check-nonprobe') + ',',
    '    cmd: [' + lit('tools/check.mjs') + '],',
    '  },',
    '];',
  ]);
}
const fixArgs = (extra) => ['--tools-dir', path.join(FIX, 'tools'), '--gate', path.join(FIX, 'zero-regression.mjs')].concat(extra || []);
const byId = (j, id) => (j && j.outside ? j.outside.find((r) => r.id === id) : undefined);

function green() {
  writeFix();
  const fx = runTool(fixArgs(['--json-only']));
  const j = fx.json;
  const c = j ? j.counts : null;
  check('TOOL-JSON-ONE-LINE', fx.tagLines === 1 && j !== null, 'tagLines=' + fx.tagLines + ' parseErr=' + fx.parseErr);
  check('FIX-CLASSIFY', !!c && c.probes === 8 && c.inGate === 1 && c.outside === 7 && c.ghosts === 1 &&
    c.gateEntries === 3 && c.gateNonProbe === 1 && c.gateProbeEntries === 2, JSON.stringify(c));
  const a = byId(j, 'f-parse-probe');
  check('FIX-OK-JSON', !!a && a.status === 'ok' && a.kind === 'json' && a.parsed && a.parsed.items === 6 &&
    a.parsed.pass === 6 && a.parsed.fail === 0 && a.parsed.fields.join(',') === 'items,pass,fail',
    JSON.stringify(a && [a.status, a.parsed]));
  const b = byId(j, 'b-noparse-probe');
  check('FIX-NOJSON-UNKNOWN', !!b && b.status === 'unknown' && b.kind === 'no-json' && b.parsed === null,
    JSON.stringify(b && [b.status, b.kind, b.parsed]));
  const cx = byId(j, 'c-crash-probe');
  check('FIX-CRASH-UNKNOWN', !!cx && cx.status === 'unknown' && cx.kind === 'crash' && cx.exit === 1 && cx.parsed === null,
    JSON.stringify(cx && [cx.status, cx.kind, cx.exit]));
  const d = byId(j, 'd-exitmismatch-probe');
  check('FIX-EXIT-MISMATCH', !!d && d.status === 'exit-mismatch' && d.kind === 'json' && d.exit === 1 &&
    d.parsed && d.parsed.fail === 0, JSON.stringify(d && [d.status, d.exit]));
  const e = byId(j, 'e-alias-probe');
  check('FIX-ALIAS-FIELDS', !!e && e.status === 'ok' && e.parsed && e.parsed.items === 7 && e.parsed.pass === 7 &&
    e.parsed.fail === 0 && e.parsed.fields.join(',') === 'total,passed,failed', JSON.stringify(e && e.parsed));
  check('FIX-GHOST-REPORTED', !!j && j.ghosts.length === 1 && j.ghosts[0].cmd === 'tools/ghost-probe.mjs' &&
    j.ok === false && j.exitReason === 'outside=7 ghosts=1', JSON.stringify(j && [j.ghosts, j.ok, j.exitReason]));
  check('FIX-COMMENT-NOT-COUNTED', !!c && c.gateEntries === 3 && c.gateProbeEntries === 2 && j && j.gateNonProbe.length === 1,
    JSON.stringify(c && [c.gateEntries, c.gateProbeEntries]));
  check('FIX-COUNTS-CONSISTENT', !!c && c.ran + c.outsideSkipped === c.outside &&
    c.outsideOk + c.outsideRed + c.outsideUnknown + c.outsideExitMismatch + c.outsideTimeout + c.outsideNeedsEnv === c.outside &&
    c.kindJson + c.kindNoJson + c.kindCrash + c.kindTimeout + c.kindEnv + c.kindBrowser === c.outside &&
    j.statuses.ok.length === c.outsideOk && j.statuses.unknown.length === c.outsideUnknown, JSON.stringify(c));
  const ag = runTool(fixArgs(['--allow-gaps', '--json-only']));
  // 只比**稳定子集**：counts.totalMs 是耗时，逐次不同 —— 拿它比会把「确定性」判错。
  const stable = (x) => (x ? [x.probes, x.inGate, x.outside, x.ghosts, x.gateEntries, x.gateNonProbe,
    x.gateProbeEntries, x.ran, x.outsideOk, x.outsideRed, x.outsideUnknown, x.outsideExitMismatch,
    x.outsideTimeout, x.outsideNeedsEnv, x.outsideSkipped, x.kindJson, x.kindNoJson, x.kindCrash,
    x.kindEnv, x.kindBrowser, x.browserOnDisk].join('/') : 'null');
  check('ALLOW-GAPS-EXIT0', ag.exit === 0 && !!ag.json && ag.json.ok === false && stable(ag.json.counts) === stable(c),
    'exit=' + ag.exit + ' ok=' + (ag.json && ag.json.ok) + ' A=' + stable(ag.json && ag.json.counts) + ' B=' + stable(c));
  const nr = runTool(fixArgs(['--no-run', '--json-only']));
  const nc = nr.json ? nr.json.counts : null;
  check('NORUN-CLASSIFY-SAME', !!nc && nc.ran === 0 && nc.probes === c.probes && nc.inGate === c.inGate &&
    nc.outside === c.outside && nc.ghosts === c.ghosts && nc.gateEntries === c.gateEntries, JSON.stringify(nc));

  //   // ── browser 类与 needs-env：公共场所纪律的三条（默认不跑 / exit 2 作废 / 要跑必须显式放行）
  const g = byId(j, 'g-headless-probe');
  check('FIX-BROWSER-SKIPPED', !!g && g.run === false && g.status === 'needs-env' && g.kind === 'browser' &&
    g.skipReason === 'spawns-browser' && Array.isArray(g.browserMarkers) && g.browserMarkers.indexOf('headless') >= 0 &&
    g.stdoutBytes === 0 && g.stderrBytes === 0 && g.parsed === null && g.ms === 0 && g.exit === null && c.outsideSkipped === 1,
    JSON.stringify(g && [g.run, g.status, g.kind, g.browserMarkers, g.stdoutBytes]));
  const h = byId(j, 'h-exit2-probe');
  check('FIX-EXIT2-NEEDSENV', !!h && h.run === true && h.status === 'needs-env' && h.kind === 'env' && h.exit === 2 &&
    h.parsed === null, JSON.stringify(h && [h.run, h.status, h.kind, h.exit]));
  check('FIX-NEEDSENV-NOT-RED', !!j && j.statuses.needsEnv.length === 2 &&
    j.statuses.needsEnv.indexOf('g-headless-probe') >= 0 && j.statuses.needsEnv.indexOf('h-exit2-probe') >= 0 &&
    j.statuses.red.length === 0 && c.outsideOk === 2 && c.outsideNeedsEnv === 2, JSON.stringify(j && j.statuses));
  check('FIX-SKIP-INVARIANT', !!j && j.outside.some((r) => r.run === false) && j.outside.every((r) => r.run !== false ||
    (r.status === 'needs-env' && r.kind === 'browser' && Array.isArray(r.browserMarkers) && r.browserMarkers.length > 0 &&
     r.stdoutBytes === 0 && r.parsed === null && r.exit === null)),
    JSON.stringify((j ? j.outside.filter((r) => r.run === false) : []).map((r) => r.file)));
  check('TOOL-RULE-DOCUMENTED', !!j && j.browserRule && j.browserRule.markers.length === 11 &&
    j.browserRule.markers.some((m) => m.indexOf('headless:') === 0) &&
    j.browserProbes.some((p) => p.file === 'g-headless-probe.mjs' && p.markers.indexOf('headless') >= 0) &&
    !!j.headlessRule && j.headlessRule.mine.indexOf('embedded-browser') >= 0,
    JSON.stringify(j && j.browserRule && j.browserRule.markers));
  // --run-browser 是显式放行：放行后那支必须真的被跑（run:true），且前后快照字段在场
  const rb = runTool(fixArgs(['--run-browser', '--json-only']));
  const rg = byId(rb.json, 'g-headless-probe');
  check('FIX-RUNBROWSER-OPTS-IN', !!rg && rg.run === true && rg.status !== 'needs-env' && !!rg.headless &&
    typeof rg.headless === 'object' && 'before' in rg.headless && 'after' in rg.headless &&
    !!rb.json.cleanup && rb.json.cleanup.headless.attempted === true && rb.json.cleanup.profiles.attempted === true,
    JSON.stringify(rg && [rg.run, rg.status, rg.headless]));

  // ⚠ 真仓这一次必须显式给路径：变异体副本躺在 %TEMP% 里，探针按自身位置算出的 REPO 会是那个目录，
  //   于是 REAL-* 六条断言会对**每一个**变异体（包括 null 对照）一起变红 —— 那就等于没有对照 ✗（实测踩到过）。
  const realArgs = ['--no-run', '--json-only',
    '--tools-dir', path.join(ROOT, 'tools'), '--gate', path.join(ROOT, 'tools', 'zero-regression.mjs')];
  const real = runTool(realArgs);
  const rj = real.json;
  const rc = rj ? rj.counts : null;
  const onDisk = readdirSync(path.join(ROOT, 'tools')).filter((f) => f.endsWith('-probe.mjs')).sort();
  const union = (rj ? rj.inGate.concat(rj.outsideNames) : []).slice().sort();
  check('REAL-PROBE-COUNT', !!rc && rc.probes === onDisk.length, 'reported=' + (rc && rc.probes) + ' onDisk=' + onDisk.length);
  check('REAL-PARTITION', union.length === onDisk.length && union.every((f, i) => f === onDisk[i]) &&
    (rj ? rj.inGate.every((f) => rj.outsideNames.indexOf(f) < 0) : false),
    'union=' + union.length + ' onDisk=' + onDisk.length);
  check('REAL-GATE-BREAKDOWN', !!rc && rc.gateNonProbe + rc.gateProbeEntries === rc.gateEntries &&
    rc.inGate <= rc.gateProbeEntries, JSON.stringify(rc));
  check('REAL-OK-EQUALS-GAPS', !!rj && rj.ok === (rc.outside + rc.ghosts === 0),
    'ok=' + (rj && rj.ok) + ' outside=' + (rc && rc.outside) + ' ghosts=' + (rc && rc.ghosts));
  check('REAL-GHOSTS-MATCH', !!rj && rj.ghosts.length === rc.ghosts &&
    rj.ghosts.every((g) => !existsSync(path.join(ROOT, g.cmd))) && rj.outside.length === rc.ran,
    JSON.stringify(rj && rj.ghosts));
  check('REAL-NO-SNAPSHOT', !!rc && rc.inGate + rc.outside === onDisk.length && rc.gateEntries > 0, JSON.stringify(rc));
}

const A_IN = 'const inGate = all.filter((f) => cmds.includes(' + Q + 'tools/' + Q + ' + f));';
const A_SELF = 'const SELF = fileURLToPath(import.meta.url);';
const A_UNK = '  else if (!parsed) status = ' + Q + 'unknown' + Q + ';';
const A_GHOST = 'const ghosts = entries.filter((e) => !existsSync(path.join(o.root, e.cmd)))';
const A_COUNTK = 'const COUNT_KEYS = [' + Q + 'items' + Q + ', ' + Q + 'total' + Q + ', ' + Q + 'count' + Q + ', ' + Q + 'cases' + Q + '];';
const A_EXITM = '  else if (exit !== 0) status = ' + Q + 'exit-mismatch' + Q + ';';
const A_ALL = 'const all = readdirSync(o.toolsDir).filter((f) => /-probe\\.mjs$/.test(f)).sort();';
const A_SCAN = '  src.split(String.fromCharCode(10)).forEach((line, idx) => {';
const A_OKCNT = '  outsideOk: byStatus(' + Q + 'ok' + Q + ').length, outsideRed: byStatus(' + Q + 'red' + Q + ').length,';
const A_NONPROBE = 'const gateNonProbe = entries.filter((e) => !/-probe\\.mjs$/.test(e.cmd)).map((e) => e.cmd);';
const A_GAPS = 'const gaps = counts.outside + counts.ghosts;';
const A_LOG = 'const o = parseArgs(process.argv.slice(2));';
const A_NORUN = 'if (!o.noRun) {';
const A_EXIT = 'process.exit(out.ok || o.allowGaps ? 0 : 1);';
const A_SKIP = 'file: f, run: false, status: ';
const R_SKIP = 'file: f, run: true, status: ';
const A_E2 = 'else if (exit === 2) status = ';
const R_E2 = 'else if (false) status = ';
const A_MARK = 'for (const m of BROWSER_MARKERS) if (m.re.test(src)) hits.push(m.id);';
const R_MARK = 'for (const m of BROWSER_MARKERS) if (false) hits.push(m.id);';
const A_OPTO = 'if (marks.length && !o.runBrowser) {';
const R_OPTO = 'if (marks.length) {';

const MUTANTS = [
  { id: 'M0-CANARY', kind: 'canary',
    why: '把闸门内直接当成全部探针（假装都登记过）⇒ 缺口必须立刻现形',
    anchor: A_IN, repl: 'const inGate = all.slice();', expect: ['FIX-CLASSIFY', 'REAL-GATE-BREAKDOWN', 'REAL-NO-SNAPSHOT', 'REAL-PARTITION'] },
  { id: 'M1-NULL', kind: 'null',
    why: '语义零改动：只在一个分号前加一个空格（它红一条就说明判据不可信）',
    anchor: A_SELF, repl: 'const SELF = fileURLToPath(import.meta.url) ;', expect: [] },
  { id: 'M2', kind: 'semantic',
    why: '解析不出时改判 ok（缺失当通过）⇒ 夹具里两支解析不出的必须察觉',
    anchor: A_UNK, repl: '  else if (!parsed) status = ' + Q + 'ok' + Q + ';', expect: ['FIX-CRASH-UNKNOWN', 'FIX-NEEDSENV-NOT-RED', 'FIX-NOJSON-UNKNOWN'] },
  { id: 'M3', kind: 'semantic',
    why: '幽灵条目不再被数出来（清单骗人也不报）⇒ 幽灵那几条断言必须察觉',
    anchor: A_GHOST, repl: 'const ghosts = entries.filter(() => false)', expect: ['FIX-CLASSIFY', 'FIX-GHOST-REPORTED'] },
  { id: 'M4', kind: 'semantic',
    why: '把计数别名表砍成一个名字 ⇒ 用 total/passed/failed 的探针就读不出来',
    anchor: A_COUNTK, repl: 'const COUNT_KEYS = [' + Q + 'items' + Q + '];', expect: ['FIX-ALIAS-FIELDS'] },
  { id: 'M5', kind: 'semantic',
    why: 'exit≠0 但印了合法 JSON 的情况不再单列 ⇒ 它会被误当 ok',
    anchor: A_EXITM, repl: '  else if (false) status = ' + Q + 'exit-mismatch' + Q + ';', expect: ['FIX-EXIT-MISMATCH', 'FIX-NEEDSENV-NOT-RED'] },
  { id: 'M6', kind: 'semantic',
    why: '探针文件名筛子改成永不匹配 ⇒ 盘上一支探针都发现不了',
    anchor: A_ALL, repl: 'const all = readdirSync(o.toolsDir).filter((f) => /-probe2\\.mjs$/.test(f)).sort();', expect: ['FIX-ALIAS-FIELDS', 'FIX-BROWSER-SKIPPED', 'FIX-CLASSIFY', 'FIX-CRASH-UNKNOWN', 'FIX-EXIT-MISMATCH', 'FIX-EXIT2-NEEDSENV', 'FIX-GHOST-REPORTED', 'FIX-NEEDSENV-NOT-RED', 'FIX-NOJSON-UNKNOWN', 'FIX-OK-JSON', 'FIX-RUNBROWSER-OPTS-IN', 'FIX-SKIP-INVARIANT', 'REAL-NO-SNAPSHOT', 'REAL-PARTITION', 'REAL-PROBE-COUNT', 'TOOL-RULE-DOCUMENTED'] },
  { id: 'M7', kind: 'semantic',
    why: '扫描前先剥掉注释 ⇒ 闸门里注释掉的 cmd 会被当成真条目（行首锚定失效）',
    anchor: A_SCAN, repl: '  src.replace(/^[ ' + '\\t' + ']*\\/\\//gm, ' + Q + Q + ').split(String.fromCharCode(10)).forEach((line, idx) => {', expect: ['FIX-CLASSIFY', 'FIX-COMMENT-NOT-COUNTED', 'FIX-GHOST-REPORTED'] },
  { id: 'M8', kind: 'semantic',
    why: '「闸门外 ok 的支数」写成总运行支数 ⇒ 计数与状态表不再自洽',
    anchor: A_OKCNT, repl: '  outsideOk: runs.length, outsideRed: byStatus(' + Q + 'red' + Q + ').length,', expect: ['FIX-COUNTS-CONSISTENT', 'FIX-NEEDSENV-NOT-RED'] },
  { id: 'M9', kind: 'semantic',
    why: '「闸门里非探针条目」不数了 ⇒ 闸门条目分账对不上',
    anchor: A_NONPROBE, repl: 'const gateNonProbe = [];', expect: ['FIX-CLASSIFY', 'FIX-COMMENT-NOT-COUNTED', 'REAL-GATE-BREAKDOWN'] },
  { id: 'M10', kind: 'semantic',
    why: '缺口数只算幽灵、漏掉闸门外 ⇒ ok 会在有缺口时为真',
    anchor: A_GAPS, repl: 'const gaps = counts.ghosts;', expect: ['REAL-OK-EQUALS-GAPS'] },
  { id: 'M11', kind: 'semantic',
    why: '在真 JSON 之前多印一行带标签的行 ⇒ 「stdout 只有一行可预测 JSON」这条必须察觉',
    anchor: A_LOG, repl: 'console.log(' + Q + 'MUTATE_SWEEP_JSON ahead' + Q + '); ' + A_LOG.slice(0, -2) + ' );', expect: ['TOOL-JSON-ONE-LINE'] },
  { id: 'M12', kind: 'semantic',
    why: '--no-run 不生效（照跑闸门外绿档）⇒ 分类与运行两档不再可分',
    anchor: A_NORUN, repl: 'if (true) {', expect: ['NORUN-CLASSIFY-SAME', 'REAL-GHOSTS-MATCH'] },
  { id: 'M13', kind: 'semantic',
    why: '--allow-gaps 不再放行 ⇒ 只报告模式失去意义',
    anchor: A_EXIT, repl: 'process.exit(out.ok ? 0 : 1);', expect: ['ALLOW-GAPS-EXIT0'] },
  { id: 'M14', kind: 'semantic',
    why: '被跳过的支谎报「跑过了」（run:false → run:true）⇒ 公共场所那条纪律必须察觉',
    anchor: A_SKIP, repl: R_SKIP, expect: ['FIX-BROWSER-SKIPPED', 'FIX-COUNTS-CONSISTENT', 'FIX-SKIP-INVARIANT'] },
  { id: 'M15', kind: 'semantic',
    why: 'exit 2「跑不起来」不再单列 ⇒ 环境问题会被读成结论（unknown 或通过）',
    anchor: A_E2, repl: R_E2, expect: ['FIX-EXIT2-NEEDSENV', 'FIX-NEEDSENV-NOT-RED'] },
  { id: 'M16', kind: 'semantic',
    why: 'browser 判定表整张失效 ⇒ 谁也不被判为 browser 类（报告里那条规则形同虚设）',
    anchor: A_MARK, repl: R_MARK, expect: ['FIX-BROWSER-SKIPPED', 'FIX-NEEDSENV-NOT-RED', 'FIX-SKIP-INVARIANT', 'TOOL-RULE-DOCUMENTED'] },
  { id: 'M17', kind: 'semantic',
    why: '--run-browser 显式开关失效（无条件跳过）⇒ 放行了也跑不起来',
    anchor: A_OPTO, repl: R_OPTO, expect: ['FIX-RUNBROWSER-OPTS-IN'] },
];

function runJudgeWith(toolFile) {
  const r = spawnSync(process.execPath, [SELF, '--judge'], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 26, timeout: 300000,
    env: { ...process.env, MUTATE_SWEEP_TOOL: toolFile },
  });
  const out = String(r.stdout || '');
  const line = out.split(NL).find((l) => l.indexOf('MUTATE_SWEEP_PROBE_JSON') >= 0);
  if (!line) return { ok: false, why: '子进程没印 JSON：' + String(r.stderr || '').slice(-160) };
  try {
    const j = JSON.parse(line.slice(line.indexOf('{')));
    if (!Array.isArray(j.reds)) return { ok: false, why: 'reds 不是数组 ⇒ 基础设施（缺失≠空）' };
    return { ok: true, json: j, reds: j.reds.slice().sort(), items: j.items, pass: j.pass };
  } catch (e) { return { ok: false, why: 'JSON 解析失败：' + e.message }; }
}

function mutate() {
  const src = readFileSync(TOOL_PATH, 'utf8');
  const dir = path.join(os.tmpdir(), 'xm-sweep-mut-' + Date.now().toString(36));
  mkdirSync(path.join(dir, 'tools'), { recursive: true });
  const file = path.join(dir, 'tools', 'mutate-sweep.mjs');
  const results = [];
  for (const m of MUTANTS) {
    const hits = src.split(m.anchor).length - 1;
    const at = src.indexOf(m.anchor);
    const line = at >= 0 ? src.slice(0, at).split(NL).length : -1;
    const sent = hits === 1 ? src.split(m.anchor).join(m.repl) : src;
    const textDelta = sent.length - src.length;
    const deltaExpected = hits === 1 ? m.repl.length - m.anchor.length : 0;
    writeFileSync(file, sent, 'utf8');
    const back = readFileSync(file, 'utf8');
    const anchorGone = hits === 1 && back.split(m.anchor).length - 1 === 0;
    const replAdded = hits === 1 && back.split(m.repl).length - 1 === src.split(m.repl).length - 1 + 1;
    const jr = runJudgeWith(file);
    const observed = jr.reds || [];
    const declared = (m.expect || []).slice().sort();
    results.push({ id: m.id, kind: m.kind, why: m.why, anchorHits: hits, anchorLine: line,
      textDelta: textDelta, deltaExpected: deltaExpected,
      landInCode: hits === 1 && anchorGone && replAdded && textDelta === deltaExpected,
      declaredReds: declared, observedReds: observed, redsUsable: Array.isArray(jr.reds),
      childAssertions: (jr.json && Array.isArray(jr.json.assertions)) ? jr.json.assertions.slice().sort() : null,
      childItems: jr.items === undefined ? null : jr.items,
      aligned: declared.join(',') === observed.join(','), childWhy: jr.ok ? null : jr.why });
  }
  rmSync(dir, { recursive: true, force: true });
  return results;
}

if (MUTATE && !JUDGE) {
  const muts = mutate();
  const find = (k) => muts.find((m) => m.kind === k) || { observedReds: [] };
  // 覆盖并集：**子进程实测**红过的断言并集，必须等于子进程报出来的断言全集（缺一条 = 有断言不可能红）✗
  const assertionSet = (muts[0] && muts[0].childAssertions) || [];
  const unionRed = Array.from(new Set(muts.reduce((s, m) => s.concat(m.observedReds), []))).sort();
  const uncovered = assertionSet.filter((a) => unionRed.indexOf(a) < 0);
  const out = {
    probe: 'mutate-sweep-probe', mode: 'mutate',
    expectedRed: muts.reduce((s, m) => s + m.declaredReds.length, 0),
    observedRed: muts.reduce((s, m) => s + m.observedReds.length, 0),
    aligns: muts.every((m) => m.aligned), lands: muts.every((m) => m.landInCode),
    usable: muts.every((m) => m.redsUsable),
    canaryRed: find('canary').observedReds.length > 0, nullClean: find('null').observedReds.length === 0,
    assertionCount: assertionSet.length, unionRed: unionRed, uncovered: uncovered,
    coverageComplete: assertionSet.length > 0 && uncovered.length === 0,
    childNoJSON: muts.filter((m) => !m.redsUsable).length,
    infra: muts.some((m) => !m.redsUsable) || assertionSet.length === 0,
    mutants: muts,
  };
  console.log('MUTATE_SWEEP_PROBE_JSON ' + JSON.stringify(out));
  process.exit(0);
}

try { green(); } catch (e) {
  check('INFRA-GREEN-THREW', false, String(e && e.stack ? e.stack.split(NL)[0] : e).slice(0, 200));
} finally { rmSync(FIX, { recursive: true, force: true }); }
const out = { probe: 'mutate-sweep-probe', mode: 'green', items: items, pass: pass, fail: items - pass,
  reds: reds.slice().sort(), assertions: seen.map((s) => s.id).sort(),
  tool: TOOL_PATH.indexOf(ROOT) === 0 ? 'repo' : 'temp' };
console.log('MUTATE_SWEEP_PROBE_JSON ' + JSON.stringify(out));
if (!JUDGE && reds.length) {
  console.error('未过断言：' + reds.slice().sort().join(' '));
  for (const s of seen) if (!s.ok) console.error('  ' + s.id + ' :: ' + s.detail);
}
process.exit(0);
