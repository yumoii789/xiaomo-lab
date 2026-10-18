#!/usr/bin/env node
/**
 * tools/display-runner.mjs —— `tools/display-probe.html` 的**仓库内跑手**
 *
 * ## 为什么它必须进仓库（这是本文件存在的唯一理由）
 *
 * display-probe.html 的第 43~44 行原本写着：
 *   「无头跑法（tools/ 里不留脚手架）：node %TEMP%\display-runner.mjs」
 * 于是这个跑手只活在 `%TEMP%` 里 —— **临时目录一被清理，701 行、40 条断言就再也没有人
 * 能在不做重建工作的情况下跑起来**。task-64 报告把它记为「仓库里没有它的跑手」，
 * 迁移包交接时那个 `%TEMP%` 跑手已经不存在了。
 *
 * ⇒ 那份探针**事实上已经不再是一份证据**：它的结论只存在于历史报告的文字里。
 *   这就是「**静默失去覆盖**」——不是断言被删掉，而是**跑不起来**。
 *
 * 「tools/ 里不留脚手架」这条约束本身也已经失效：`tools/` 下现在有 40 多个探针，
 * 而且 display-probe.html 自己的第 14 行写明「**tools/ 不参与打包，属仓库外内容**」——
 * 所以放进来既不进产物、也不违反任何安全理由。**留下一个永远跑不起来的探针，
 * 比留下一个脚手架糟得多。**
 *
 * ## 用法
 *
 *   node server.mjs &                          # 必须：探针要从 127.0.0.1:7373 取 index.html
 *   node tools/display-runner.mjs              # 全部：主套件 + ⑥触控 + ⑦reduce + ⑨命中矩阵
 *   node tools/display-runner.mjs --main-only  # 只跑主套件（约 185 s，就是 task-64 §5.3 那条）
 *   node tools/display-runner.mjs --matrix     # 只跑 ⑨ 命中矩阵四次调用
 *   node tools/display-runner.mjs --touch      # 只跑 ⑥⑦（需要媒体模拟，正是它们常被 SKIP 的原因）
 *
 * 尾行输出一行 `DISPLAY_RUNNER_JSON {...}` 便于机器读取。
 *
 * ## 本跑手刻意**不**做的两件事
 *
 * 1. **不摘掉内联主套件**。task-64 报告提到用「请求层摘掉内联套件」把 ⑨ 单独跑快一点 ——
 *    那是拿改被测对象换速度。本跑手选择**忠实**：主套件照跑，看它自己的 `__probeDone`。
 *    要快就用 `--matrix`，而不是把套件从页面上抠掉。
 * 2. **不重试**。⑨ 的第四次调用带 `sabotage=true` 做红绿自证；若它量不出差别，
 *    那是**真问题**（假自证），重试只会把它盖住。
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkCleanup } from './browser-instances.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EDGE = process.env.EDGE_PATH
  || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
if (!existsSync(EDGE)) throw new Error('找不到 Edge：' + EDGE + '（可用环境变量 EDGE_PATH 指定）');

const argv = process.argv.slice(2);
const FLAGS = new Set(argv.filter((a) => a.startsWith('--')));
const BASE = argv.find((a) => /^https?:\/\//.test(a)) || 'http://127.0.0.1:7373/tools/display-probe.html';

const DO_MAIN = FLAGS.has('--main-only') || FLAGS.has('--all') || FLAGS.size === 0;
const DO_TOUCH = FLAGS.has('--touch') || FLAGS.has('--all') || FLAGS.size === 0;
const DO_MATRIX = FLAGS.has('--matrix') || FLAGS.has('--all') || FLAGS.size === 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const prof = mkdtempSync(join(tmpdir(), 'xm-display-runner-'));
const port = 9300 + Math.floor(Math.random() * 2000);
const child = spawn(EDGE, ['--headless=new', '--mute-audio', '--disable-gpu', '--no-first-run',
  `--user-data-dir=${prof}`, `--remote-debugging-port=${port}`, '--window-size=1920,1080',
  'about:blank'], { stdio: 'ignore', windowsHide: true });

async function wsUrl() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch { /* devtools 还没起来 */ }
    await sleep(250);
  }
  throw new Error('DevTools 端口没起来');
}

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); }
  static async open(u) {
    const ws = new WebSocket(u);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const c = new CDP(ws);
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && c.pending.has(m.id)) {
        const { res, rej } = c.pending.get(m.id); c.pending.delete(m.id);
        m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
      }
    };
    return c;
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
}

const result = { main: null, touch: null, reduce: null, matrix: [], ok: true, notes: [] };
let cdp = null;

try {
  cdp = await CDP.open(await wsUrl());
  const S = cdp.send.bind(cdp);
  await S('Page.enable');
  await S('Runtime.enable');

  const ev = async (expr) => {
    const r = await S('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) {
      throw new Error('[页面异常] ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    }
    return r.result.value;
  };

  const cb = 'runner' + Math.floor(Math.random() * 1e9);
  await S('Page.navigate', { url: BASE + (BASE.includes('?') ? '&' : '?') + 'cb=' + cb });

  // 就绪：页面脚本一上来就跑主套件，所以「注入的 pre#out 出现」是唯一不含歧义的信号。
  let up = false;
  for (let i = 0; i < 200; i++) {
    try {
      if (await ev('!!document.getElementById("out")')) { up = true; break; }
    } catch { /* 上下文还在建 */ }
    await sleep(100);
  }
  if (!up) throw new Error('探针页面没起来（out 节点始终没出现）');

  if (DO_MAIN) {
    console.log('▶ 主套件（加载即跑；task-64 §5.3 的 185 s 就是这一段）…');
    let done = null;
    // 主套件实测 185 s 跑完（含两个视口）。给 6 分钟余量。
    for (let i = 0; i < 720; i++) {
      try {
        const d = await ev('window.__probeDone ? JSON.parse(JSON.stringify(window.__probeDone)) : null');
        if (d) { done = d; break; }
      } catch { /* 页面还在跑 */ }
      await sleep(500);
    }
    const text = await ev('document.getElementById("out").textContent');
    const m = String(text).match(/DISPLAY_JSON (\{[\s\S]*\})/);
    let json = null;
    if (m) { try { json = JSON.parse(m[1]); } catch (e) { result.notes.push('DISPLAY_JSON 解析失败：' + e.message); } }
    result.main = { done, json, failLabels: json ? json.checks.filter((c) => !c.ok).map((c) => c.label) : null };
    if (!done) { result.ok = false; result.notes.push('主套件 6 分钟内没跑完（__probeDone 一直为 null）'); }
    else {
      console.log(`  主套件：${done.total - done.fail}/${done.total} 通过${done.fail ? `，失败 ${done.fail} 项` : ''}`);
      if (json) json.checks.filter((c) => !c.ok).forEach((c) => console.log(`    ✗ ${c.label}`));
    }
    if (json && json.table) result.matrix.push({ note: 'main-suite-table', rows: Array.isArray(json.table) ? json.table.length : null });
  }

  if (DO_TOUCH) {
    console.log('▶ ⑥ 触控共存（Emulation.setTouchEmulationEnabled）…');
    await S('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    const mt = await ev('JSON.stringify({coarse: matchMedia("(any-pointer: coarse)").matches, hover: matchMedia("(hover: none)").matches})');
    result.touch = { media: JSON.parse(mt), res: await ev('(async () => JSON.stringify(await window.__probeTouch()))()').then((s) => JSON.parse(s)) };
    console.log('  媒体实际值 ' + mt);

    console.log('▶ ⑦ reduce-motion（Emulation.setEmulatedMedia）…');
    await S('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    const mr = await ev('matchMedia("(prefers-reduced-motion: reduce)").matches');
    result.reduce = { matched: mr, res: await ev('(async () => JSON.stringify(await window.__probeReduce()))()').then((s) => JSON.parse(s)) };
    console.log('  prefers-reduced-motion:reduce 实际匹配 = ' + mr);
    await S('Emulation.setEmulatedMedia', { features: [] });
  }

  if (DO_MATRIX) {
    // 四次调用：2 视口 × 2 形态。第 4 次带 sabotage（红绿自证）。
    // ⚠ sabotage 能量出差别的前提是「关态确实有 44px 地板」，也就是 any-pointer: coarse 为真
    //   （display-probe.html 第 473 行自己写明了）。所以先开触摸模拟，让第 4 次有意义。
    await S('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    const CALLS = [
      [1920, 1080, 'mouse', false],
      [3840, 2160, 'mouse', false],
      [1920, 1080, 'touch', true],
      [3840, 2160, 'touch', false],
    ];
    for (const [w, h, form, sab] of CALLS) {
      console.log(`▶ ⑨ 命中矩阵 ${w}×${h} ${form}${sab ? ' (sabotage 红绿自证)' : ''}…`);
      const raw = await ev(`(async () => JSON.stringify(await window.__probeHitMatrix(${w}, ${h}, ${JSON.stringify(form)}, ${sab})))()`);
      const r = JSON.parse(raw);
      // ⚠ cells 是**列**（大屏模式关/开），行在别的字段里；只记 length 会拿不到
      //   sabotage 的「注入前 vs 注入后」差别 —— 而那正是「这张表不是恒绿表」的唯一证据。
      //   所以 sabotage 那次把完整单元格一并留下（其余三次只留计数，避免输出膨胀）。
      result.matrix.push({ w, h, form, sabotage: sab, error: r.error, cells: r.cells ? r.cells.length : null,
        sabotageRes: r.sabotage, cellsRaw: sab ? r.cells : null });
      console.log(`  单元格 ${r.cells ? r.cells.length : 0} 个${r.error ? '；error=' + r.error : ''}`);
      if (r.error) { result.ok = false; }
    }
  }
} catch (e) {
  result.ok = false;
  result.notes.push('runner 异常：' + (e && e.message ? e.message : String(e)));
} finally {
  try { if (cdp) cdp.ws.close(); } catch { /* 已经断了 */ }
  try { child.kill(); } catch { /* 已经退了 */ }
  await sleep(400);
  try { rmSync(prof, { recursive: true, force: true }); } catch { /* 有句柄占着，交给 checkCleanup */ }
}

// 跑手自己也会留 profile —— 用仓库现成的清理辅助核一遍，别让它变成新的 %TEMP% 垃圾源。
try {
  const cleanup = await checkCleanup(['xm-display-runner-']);
  result.cleanup = cleanup && cleanup.summary ? cleanup.summary : null;
} catch (e) {
  result.cleanup = 'checkCleanup 失败：' + e.message;
}

if (result.main && result.main.done && result.main.done.fail > 0) result.ok = false;
if (result.matrix.some((m) => m.error)) result.ok = false;

console.log('');
console.log('DISPLAY_RUNNER_JSON ' + JSON.stringify(result));
process.exit(result.ok ? 0 : 1);
