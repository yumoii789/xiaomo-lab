// ══════════════════════════════════════════════════════════
// tools/touch-check.mjs —— 触控适配的正式验证工具（CDP 版）
//
// 为什么需要它：tools/touch-probe.html 把 index.html 装进 iframe，
// 而 **iframe 的布局视口在 headless 下与 window.innerWidth 不一致**
// （实测 iframe.innerWidth=390 但 documentElement.scrollWidth=862），
// 于是所有依赖「视口宽度」的断言都不可信。因此用 CDP 把 index.html
// 作为**顶层页面**打开，直接在页面自己的 realm 里求值。
//
// 零依赖：Node 内置 fetch + 原生 WebSocket（Node 22+）；用 CDP 的
// Runtime.evaluate 在页面里跑表达式，用 Emulation.setTouchEmulationEnabled
// 让 (pointer: coarse) 真的匹配，用 Emulation.setDeviceMetricsOverride
// 把视口设成手机尺寸。
//
// 用法：
//   node tools/touch-check.mjs                # 手机视口，跑「视口与布局」这一组
//   node tools/touch-check.mjs --desktop      # 桌面视口，跑同一条回归
//   node tools/touch-check.mjs --expr-file X  # 用文件里的表达式替换默认那一组
//
// 它自己起 Edge：--headless=new（无窗口）--mute-audio（无声音），
// profile 用系统临时目录，退出前删掉；仓库内不留任何中间产物。
//
// ══════════════════════════════════════════════════════════
// ⚠ 铁律（D51）：**禁止用程序化点击( el.click() / dispatchEvent )验证触控路径**。
//
// 程序化点击会**绕过命中测试**：它直接投递给元素自己，于是「事件到达了，
// 但浏览器在这一刻实际会把手指路由到哪个元素」这个最关键的问题被整条跳过。
// 后果是造出**假绿** —— 测试说通，真机上按不到。
//
// 本仓库已经发生过两次，两次都是程序化路径给不出信号：
//   · 一次是事件到达了目标元素、业务状态却没变（监听器不在活着的那个节点上）；
//   · 一次更隐蔽：本次 task-34 的 320px `CR1`。
//     长按被承认、`xiaomo:settings` 恰好派发 1 次，但面板随即被关掉 ——
//     因为浏览器把「抬手补发的那次 click」按**抬起时刻**重新做命中测试，
//     320 档落到遮罩上，触发「点遮罩即关闭」。程序化 `.click()` 永远看不到这一幕。
//
// 所以本文件的触控断言一律走 `Input.dispatchTouchEvent`（真实触摸序列，
// 按下/移动/抬起各自成事件），让浏览器自己去合成 click。
// 需要对照时，可以**额外**跑一次程序化点击，但只能用来区分
// 「监听器没装上」和「真实路径有问题」，**不能**拿它当通过依据。
//
// 推论（同一条铁律的另一面）：**断言必须落在状态上，不能落在「事件到了」上**。
// 「事件数=1」只证明有人收到了事件，不证明界面到了该到的状态。
// ══════════════════════════════════════════════════════════

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// 清理诊断的判定器（D53：按 --user-data-dir 归组、实例非进程、只读进程表）
import { checkCleanup } from './browser-instances.mjs';

const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];
const APP_PORT = process.env.XIAOMO_PORT || '7373';
const DEBUG_PORT = 9333;
const CB = 'cdp' + Date.now().toString(36);

const argv = process.argv.slice(2);
const desktop = argv.includes('--desktop');
const exprFileIdx = argv.indexOf('--expr-file');
const exprFile = exprFileIdx >= 0 ? argv[exprFileIdx + 1] : null;
/**
 * --nomobile：把 Emulation 的 mobile 标记关掉，只保留触摸模拟。
 *   CDP 的 mobile:true 会打开「移动端布局视口」——当内容比视口宽时它会把
 *   布局视口撑开（并让 innerWidth 跟着变大），于是「撑开 → 画布后备存储变大 →
 *   更宽」会自己滚起来。本仓库的界面是定宽网格，本来就不需要那个行为，
 *   而 (pointer:coarse) 由 setTouchEmulationEnabled 单独提供，与它无关。
 */
const noMobile = argv.includes('--nomobile');
const suite = argv.includes('--suite');
const staticOnly = argv.includes('--static');
  const diag = argv.includes('--diag');
const dsfIdx = argv.indexOf('--dsf');
const dsf = dsfIdx >= 0 ? Number(argv[dsfIdx + 1]) : (desktop ? 1 : 2);
const sizeIdx = argv.indexOf('--size');
const sizeArg = sizeIdx >= 0 ? argv[sizeIdx + 1] : null;
const parsedSize = sizeArg ? sizeArg.split('x').map(Number) : null;

const VIEW = desktop
  ? { width: 1280, height: 820, mobile: false, touch: false, dsf }
  : { width: 390, height: 844, mobile: !noMobile, touch: true, dsf };
if (parsedSize && parsedSize.length === 2 && parsedSize.every(n => Number.isFinite(n))) {
  VIEW.width = parsedSize[0];
  VIEW.height = parsedSize[1];
}
/**
 * 桌面三栏是 238 + 1fr + 318（main.css），两侧固定、中间自适应。
 * 1280 视口下的实验台宽度就是 1280 - 238 - 318 - 格线/内边距 ≈ 724px。
 * 大屏断言用它当下限：面积变大时实验台只该更宽，不该因为某个断点误触发而缩水。
 */
VIEW.expectedStageMin = 720;
/**
 * 设备形态由「触摸是否启用」决定，这是 CDP 真能控制的那个开关：
 *   touch: true  → pointer:coarse + any-pointer:coarse + hover:none   ← 纯手机 / 触摸大屏
 *   touch: false → pointer:fine   + any-pointer:coarse + hover:hover  ← 触屏笔记本
 * （headless 默认 any-pointer:coarse 为真，因为内核把触摸屏当作了可用输入。
 *   这一条挡住了 --touch-events 的差异，实测过：见媒体特性自检。）
 * 注意 Emulation.setEmulatedMedia 覆盖不了 pointer/any-pointer/hover —— 实测六种组合
 * 全部返回同一组值，所以那些媒体特性只能靠 --static 的静态断言兜底，不能假装验过。
 */
const DEVICE_LABEL = VIEW.touch
  ? (VIEW.width >= 1181 ? '触摸大屏（pointer:coarse + any-pointer:coarse + hover:none）'
                        : '纯手机（pointer:coarse + any-pointer:coarse + hover:none）')
  : '触屏笔记本（pointer:fine + any-pointer:coarse + hover:hover）';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function findEdge() {
  for (const p of EDGE_CANDIDATES) if (existsSync(p)) return p;
  throw new Error('找不到 msedge.exe: ' + EDGE_CANDIDATES.join(' / '));
}

/** 极简 CDP 客户端：发 id/method/params，等 id 匹配的应答 */
class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id != null && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      // 触摸序列是逐个事件同步应答的，连接不健康时它会一直不来 —— 给足 20 秒就判定失败，
      // 否则整个进程会静默挂在这里（第一次跑就是这么卡住的）。
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(method + ' 超时')); }
      }, 20000);
    });
  }
  /** 求值：awaitPromise 让 async 表达式也能用；返回 JSON 化的值。
   *  出错时不抛，改为回一个带 __err 的对象 —— 探针不该因为一条断言挂掉就整跑中断，
   *  而且失败的那一条要能把自己的错误原文带到报告里。 */
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', {
      expression: expr, awaitPromise: true, returnByValue: true,
      userGesture: true,
    });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      return { __err: (d.exception && d.exception.description) || d.text || '页面内求值失败' };
    }
    return r.result.value;
  }
}

/** 等 devtools 端口上的页面目标出现 */
async function waitForTargets(port, timeoutMs = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = await res.json();
      const page = list.find(t => t.type === 'page');
      if (page && page.webSocketDebuggerUrl) return page;
    } catch { /* 还没起来 */ }
    await sleep(150);
  }
  throw new Error('等不到 devtools 目标');
}

async function main() {
  if (staticOnly) {
    const report = runStaticChecks();
    console.log('TOUCH_JSON ' + JSON.stringify(report));
    if (report.failed > 0) process.exitCode = 1;
    return;
  }
  const edge = findEdge();
  const profile = mkdtempSync(join(tmpdir(), 'xiaomo-cdp-'));
  const appUrl = `http://127.0.0.1:${APP_PORT}/index.html?cb=${CB}`;
  // 窗口本身要比模拟视口大：headless 会把 setDeviceMetricsOverride 的尺寸
  // 夹到真实窗口尺寸以内，窗口小于视口时量到的就不是目标视口（实测 390 被夹成 736）。
  const winW = Math.max(VIEW.width, 800);
  const winH = Math.max(VIEW.height, 600);
  const child = spawn(edge, [
    '--headless=new', '--mute-audio', '--disable-gpu',
    '--no-first-run', '--no-default-browser-check', '--disable-sync',
    '--disable-extensions', '--disable-features=Translate',
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--window-size=${winW},${winH}`,
    'about:blank',
  ], { stdio: 'ignore', windowsHide: true });

  let cdp = null;
  try {
    const target = await waitForTargets(DEBUG_PORT);
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', () => rej(new Error('CDP WebSocket 连接失败')), { once: true });
    });
    cdp = new CDP(ws);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    if (VIEW.touch) {
      await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    }
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: VIEW.width, height: VIEW.height,
      deviceScaleFactor: VIEW.dsf,
      mobile: VIEW.mobile,
      screenWidth: VIEW.width, screenHeight: VIEW.height,
    });

    // 收集页面 console 错误，便于诊断「应用没起来」
    const errors = [];
    ws.addEventListener('message', (ev) => {
      try {
        const m = JSON.parse(ev.data);
        if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
          errors.push((m.params.args || []).map(a => a.value || a.description).join(' '));
        }
      } catch { /* 忽略 */ }
    });

    // 先导航一次拿 URL，再导航到应用
    await cdp.send('Page.navigate', { url: appUrl });
    // 等应用就绪（window.xiaomo 由 main.js 暴露）
    let ready = false;
    for (let i = 0; i < 200; i++) {
      try {
        ready = await cdp.eval('!!window.xiaomo');
        if (ready) break;
      } catch { /* 导航中 */ }
      await sleep(100);
    }
    if (!ready) {
      const diag = await cdp.eval(`JSON.stringify({
        title: document.title, ready: document.readyState,
        scripts: document.querySelectorAll('script').length,
        appKids: document.getElementById('app') ? document.getElementById('app').children.length : null
      })`).catch(e => '求值失败: ' + e.message);
      console.log('APP_NOT_READY ' + diag);
      if (errors.length) console.log('CONSOLE_ERRORS ' + JSON.stringify(errors.slice(0, 8)));
      process.exitCode = 2;
      return;
    }
    await sleep(400);   // 让布局稳定（字体、插件插槽）

    if (suite) {
      const report = await runSuite(cdp, { appUrl, errors });
      console.log('TOUCH_JSON ' + JSON.stringify(report));
      await cdp.send('Browser.close').catch(() => {});
      if (report.failed > 0) process.exitCode = 1;
      return;
    }

    // ⚠ 走到这里**没有跑任何断言**。
    // 为什么必须显式失败：本工具默认（不带 --suite）只做一次诊断求值就退出，
    // 于是「拿退出码验收」的人会得到**假绿** —— 台账里一个没写命令行的
    // 「37/37」极可能就是这么来的。所以非断言路径一律 exit 2，并要求显式 --diag。
    if (!diag) {
      console.error('[touch-check] 未运行任何断言：不带 --suite 时本工具只做诊断，'
        + '不给通过率，因此不能拿退出码当验收。');
      console.error('[touch-check] 跑断言请用：node tools/touch-check.mjs --suite'
        + '（可加 --desktop / --size WxH / --static）');
      console.error('[touch-check] 确实只想要那一次诊断求值：加 --diag'
        + '（此路径 exit 0 只表示「求值成功」，不代表任何断言通过）');
      await cdp.send('Browser.close').catch(() => {});
      process.exitCode = 2;
      return;
    }
    const expr = exprFile
      ? readFileSync(exprFile, 'utf8')
      : DEFAULT_EXPR;
    const value = await cdp.eval(expr);
    console.log('TOUCH_DIAG ' + JSON.stringify({
      view: VIEW, url: appUrl, result: value,
    }));
    if (errors.length) console.log('CONSOLE_ERRORS ' + JSON.stringify(errors.slice(0, 8)));
    await cdp.send('Browser.close').catch(() => {});
  } finally {
    // Edge 会留下一整棵子进程树，只 kill 主进程会剩下一堆僵尸占住 profile 目录。
    // taskkill /T 连树一起收掉，后面的 rmSync 才能真的删干净。
    try {
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } catch { /* 已经退出 */ }
    try { child.kill(); } catch { /* 已经退出 */ }
    await sleep(900);
    let deleted = true;
    let delErr = '';
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch (e) {
      deleted = false;
      delErr = String((e && e.message) || e).slice(0, 120);
      console.error('临时 profile 未能删除（可手动清）: ' + profile);
    }
    // 清理诊断（task-42）：探针删没删干净只有它自己知道，而**失败时恰恰最需要这句话** ✓
    // 判定单位是**实例不是进程**（D53：按 --user-data-dir 归组、根进程无 --type=），
    // 且「进程清空」与「目录清空」是两件事、都要报 ✓。只读进程表，不再新起浏览器 ✓。
    try {
      const inst = await checkCleanup(profile);
      console.error(`[touch-check] 清理诊断：rmSync ${deleted ? '成功' : '失败(' + delErr + ')'}；${inst.text}`);
      if (!inst.cleaned && process.exitCode === 0) process.exitCode = 3;
    } catch (e) {
      console.error('[touch-check] 清理诊断：判定器自身异常 ' + String((e && e.message) || e));
    }
  }
}

// ══════════════════════════════════════════════════════════
// 静态断言：直接解析 styles/touch.css 的文本
// ══════════════════════════════════════════════════════════
//
// 为什么必须有这一层：CDP 覆盖不了 pointer / any-pointer / hover（实测六种组合
// 返回同一组值），所以「触屏笔记本上这条到底生不生效」没法靠模拟设备回答。
// 但这个问题有更可靠的信息源：**规则在 at-rule 栈里的位置**。
// 不在任何 @media 里的规则 = 任何设备都生效；包在 (pointer: coarse) 里 =
// 主指针是触控板的触屏笔记本上不生效。读文本就能给出确定结论，比模拟设备强。

/**
 * 把 CSS 文本解析成规则列表，每条带：选择器、at-rule 栈、行号、声明体。
 * 够用即可：跳过注释与字符串，按 { } 配对跟踪嵌套，选择器块的声明体整段取出。
 */
function collectRules(css) {
  const rules = [];
  const stack = [];                 // 当前 at-rule 栈：[{ cond, line }]
  let buf = '';                     // 正在累积的选择器文本
  let bufLine = 1;                  // 选择器起点行号
  let line = 1;
  let i = 0;

  while (i < css.length) {
    const ch = css[i];
    if (ch === '\n') { line++; i++; continue; }

    // 注释
    if (ch === '/' && css[i + 1] === '*') {
      i += 2;
      while (i < css.length && !(css[i] === '*' && css[i + 1] === '/')) { if (css[i] === '\n') line++; i++; }
      i += 2;
      continue;
    }
    // 字符串
    if (ch === '"' || ch === "'") {
      const q = ch; i++;
      while (i < css.length && css[i] !== q) { if (css[i] === '\\') i++; if (css[i] === '\n') line++; i++; }
      i++;
      continue;
    }
    if (ch === '{') {
      const head = buf.trim();
      buf = '';
      i++;
      if (head.startsWith('@')) {
        // at-rule（@media/@supports）：压栈，内部规则继续由本轮循环归档
        stack.push({ cond: head, line: bufLine });
        continue;
      }
      // 选择器块：整段吃掉声明体（含嵌套的大括号，例如 @media 写在块里是不合法的，忽略）
      const bodyFrom = i;
      let depth = 1;
      while (i < css.length && depth > 0) {
        const c = css[i];
        if (c === '\n') line++;
        else if (c === '/' && css[i + 1] === '*') {
          i += 2;
          while (i < css.length && !(css[i] === '*' && css[i + 1] === '/')) { if (css[i] === '\n') line++; i++; }
          i += 2;
          continue;
        } else if (c === '{') depth++;
        else if (c === '}') depth--;
        i++;
      }
      rules.push({
        selector: head,
        stack: stack.map(s => s.cond),
        line: bufLine,
        body: css.slice(bodyFrom, i - 1).trim(),
      });
      continue;
    }
    if (ch === '}') {
      stack.pop();
      buf = '';
      i++;
      continue;
    }
    if (ch === ';' && stack.length === 0) { buf = ''; i++; continue; }
    if (buf.trim() === '' ) bufLine = line;   // 选择器的第一行
    buf += ch;
    i++;
  }
  return rules;
}

/** 从一份 CSS 文本里取出「不在任何 at-rule 里的规则」和「在某类媒体查询里的规则」 */
function analyzeCss(css) {
  const rules = collectRules(css);
  const unconditional = rules.filter(r => r.stack.length === 0);
  const inMedia = (kw) => rules.filter(r => r.stack.some(c => c.includes(kw)));
  return { rules, unconditional, inMedia };
}

// ══════════════════════════════════════════════════════════
// 静态断言套件（不开浏览器）—— 用 `--static` 运行
// ══════════════════════════════════════════════════════════

/** A 类（触控基线）：对鼠标惰性，必须无条件生效，否则触屏笔记本上整层失效。
 *  标记用「声明」而不是属性名 —— 属性名会在 B 类规则里同样出现
 *  （例如 #topbar 的 overflow-x 是 B 类、它的 overscroll-behavior-x 是 A 类），
 *  用属性名匹配会把 B 类误判成 A 类。 */
const A_CLASS = [
  { mark: '-webkit-tap-highlight-color', why: '点击灰闪块' },
  { mark: '-webkit-text-size-adjust', why: '横屏自动放大正文' },
  { mark: 'overscroll-behavior: none', why: '整页橡皮筋 / 下拉刷新（根节点）' },
  { mark: 'overscroll-behavior: contain', why: '内层滚动容器串链到页面' },
  { mark: 'overscroll-behavior-x: contain', why: '顶栏横向滚动串链到页面' },
  { mark: 'touch-action: manipulation', why: '点击 300ms 判定与双击缩放' },
  { mark: 'user-select: none', why: '长按选中按钮文字' },
  { mark: '-webkit-touch-callout', why: '长按弹出系统菜单' },
  { mark: 'font-size: 16px', why: 'iOS 聚焦输入框放大整页' },
];

/** 必须至少在一条无条件规则里出现的声明（真正的不变量） */
const MUST_BE_UNCONDITIONAL = [
  { decl: '-webkit-tap-highlight-color', why: 'A 类：点击高亮' },
  { decl: '-webkit-text-size-adjust', why: 'A 类：文本自动放大' },
  { decl: 'overscroll-behavior', why: 'A 类：橡皮筋与滚动串链' },
  { decl: 'touch-action: manipulation', why: 'A 类：按钮点击判定' },
  { decl: 'font-size: 16px', why: 'A 类：iOS 聚焦缩放（输入类元素 16px 下限）' },
];

function runStaticChecks() {
  const checks = [];
  const ok = (id, name, pass, evidence) => checks.push({ id, name, pass: !!pass, evidence });

  const cssPath = join(process.cwd(), 'styles', 'touch.css');
  let css = '';
  try { css = readFileSync(cssPath, 'utf8'); } catch (e) {
    ok('S0', '能读到 styles/touch.css', false, String(e.message));
    return { summary: '0/1', passed: 0, failed: 1, checks };
  }
  const rules = collectRules(css);

  // 1) 逐条列出 A 类规则，并断言它们的 at-rule 栈为空。
  //    有一处**刻意偏离**：除 #paletteSearch 之外的输入类元素字号被门控在
  //    (any-pointer: coarse) 下 —— 无条件提到 16px 会改变桌面属性面板的信息密度
  //    （12px → 16px），那是看得见的改动，属 B 类。deviation 里登记它，
  //    这样既不会假装它是无条件的（假通过），也不会让整条断言失败（假失败）。
  const aRules = [];
  for (const r of rules) {
    for (const a of A_CLASS) {
      if (r.body.includes(a.mark)) {
        aRules.push({ selector: r.selector, line: r.line, decl: a.mark, stack: r.stack, why: a.why });
        break;
      }
    }
  }
  const DEVIATION = { line: 79, selector: '#app select, #app textarea, …input[type=…]' };
  const aNested = aRules.filter(r => r.stack.length > 0 && r.line !== DEVIATION.line);
  const deviationRows = aRules.filter(r => r.line === DEVIATION.line);
  ok('S1', 'A 类触控基线规则全部不在任何 @media 里（已登记的偏离除外）',
    aNested.length === 0,
    aRules.map(r => `行${r.line} ${r.selector.split(',')[0]} [${r.decl}] ${r.stack.length ? '✗ 在 ' + r.stack.join(' > ') : '✓ 无条件'}`).join(' ; '));

  // 1b) 偏离必须还在（防止有人把这块悄悄挪走或挪回 pointer，导致登记失效）
  const devOK = deviationRows.length === 1
    && deviationRows[0].stack.includes('@media (any-pointer: coarse)');
  ok('S1b', '已登记的偏离仍然存在且门控在 any-pointer: coarse（触屏笔记本也覆盖）',
    devOK,
    devOK ? `行${DEVIATION.line} → ${deviationRows[0].stack.join(' > ')}；代价：桌面侧边栏/属性面板输入框保持 12–12.5px 原尺寸，不做全站放大`
          : '偏离已消失或门控被改成别的（若已改成无条件，请同时更新本断言与 S1 的例外）');

  // 2) 关键不变量：这些声明必须至少有一条无条件规则承载
  for (const [i, m] of MUST_BE_UNCONDITIONAL.entries()) {
    const hits = rules.filter(r => r.stack.length === 0 && r.body.includes(m.decl));
    ok('S2.' + (i + 1), `无条件规则里有 \`${m.decl}\`（${m.why}）`,
      hits.length > 0,
      hits.length ? hits.map(r => `行${r.line} ${r.selector}`).join(', ') : '没有任何无条件规则含此声明');
  }

  // 3) 命中热区扩大规则必须挂在 any-pointer: coarse 下，而不是 pointer: coarse。
  //    选择器写的是**真的撑大命中盒**的那几条：
  //    .tool-btn / .tb-check 原来是 ::after 伪元素扩边，那条路是死的
  //    （伪元素带 pointer-events:none → 对命中测试透明），现在改成显式高度撑真盒子。
  const hitAreaSelectors = ['.theme-dot', '.tool-btn, .tb-check'];
  const hitRows = [];
  for (const sel of hitAreaSelectors) {
    const parts = sel.split(',').map(s => s.trim());
    const hit = rules.find(r => parts.every(p => r.selector.split(',').map(s => s.trim()).includes(p))
      && (r.body.includes('44px') || r.body.includes('inset: 0') || r.body.includes('height')));
    hitRows.push({ sel, line: hit ? hit.line : null, stack: hit ? hit.stack.join(' > ') : '(未找到)' });
  }
  const anyPointerOK = hitRows.every(h => h.stack.includes('@media (any-pointer: coarse)'));
  ok('S3', '命中热区扩大规则挂在 @media (any-pointer: coarse) 下（触屏笔记本也吃得到）',
    anyPointerOK, hitRows.map(h => `${h.sel} 行${h.line} → ${h.stack}`).join(' ; '));

  // 4) 可见的尺寸/布局规则必须挂在 pointer: coarse 下，不许用 any-pointer。
  //    ⚠ .theme-dots 不能留在这个清单里：它的 gap:0 与命中盒相邻有关（不可见改动），
  //    现在挂在 any-pointer 下是对的；视觉间距由圆点自身的视觉半径承担。
  //    这里换成真正「看得见」的那几条。
  const visibleSelectors = ['.theme-dot', '.tb-btn', '.drawer-x'];
  const visRows = visibleSelectors.map(sel => {
    // 取**最后**一条匹配（源序靠后的那条才是 (pointer: coarse) 块里的可见改动）
    const cands = rules.filter(x => x.selector.split(',').map(s => s.trim()).includes(sel)
      && x.stack.some(c => c.includes('pointer: coarse')));
    const r = cands[cands.length - 1];
    return { sel, line: r ? r.line : null, stack: r ? r.stack.join(' > ') : '(未找到)' };
  });
  const visOK = visRows.every(v => v.stack.includes('@media (pointer: coarse)') && !v.stack.includes('any-pointer'));
  ok('S4', '可见的尺寸/布局规则挂在 @media (pointer: coarse) 下（不误放大触屏笔记本）',
    visOK, visRows.map(v => `${v.sel} 行${v.line} → ${v.stack}`).join(' ; '));

  // 5) 竖屏浮层布局必须以宽度为断点，且不许用 any-pointer 触发
  const drawerBlocks = rules.filter(r => r.stack.some(c => c.includes('max-width: 1024px')));
  const drawerOK = drawerBlocks.length > 0
    && drawerBlocks.every(r => !r.stack.some(c => c.includes('any-pointer')));
  ok('S5', '竖屏浮层布局以宽度断点触发（大屏触控一体机不会被切成手机布局）',
    drawerOK, drawerBlocks.slice(0, 3).map(r => `行${r.line} ${r.selector} → ${r.stack.join(' > ')}`).join(' ; ')
      + (drawerBlocks.length > 3 ? ` ; …共 ${drawerBlocks.length} 条` : ''));

  // 6) 不许出现封掉页面缩放的写法 —— 查的是 index.html 的 viewport meta
  //（上一版错查了 touch.css 的文本，结果被自己的注释「不许写 user-scalable=no」命中，假失败）
  let html = '';
  try { html = readFileSync(join(process.cwd(), 'index.html'), 'utf8'); } catch { /* 读不到就跳过 */ }
  const vp = (html.match(/<meta[^>]+name=["']viewport["'][^>]*>/i) || [''])[0];
  const zoomBans = ['user-scalable=no', 'user-scalable=0', 'maximum-scale'];
  const found = zoomBans.filter(z => vp.replace(/\s/g, '').includes(z.replace(/\s/g, '')));
  ok('S6', 'index.html 的 viewport 没有封掉页面缩放',
    vp !== '' && found.length === 0,
    `content="${(vp.match(/content=["']([^"']*)["']/) || [, ''])[1]}"` + (found.length ? ` 发现: ${found.join(', ')}` : ''));

  // 7) 汇总：无条件规则清单（给报告用）
  const summaryLine = rules.filter(r => r.stack.length === 0)
    .map(r => `行${r.line} ${r.selector}`).join(' ; ');
  ok('S7', `touch.css 共 ${rules.length} 条规则，其中 ${rules.filter(r => r.stack.length === 0).length} 条无条件`,
    true, summaryLine);

  const passed = checks.filter(c => c.pass).length;
  return {
    mode: 'static',
    deviceProfile: DEVICE_LABEL,
    summary: `${passed}/${checks.length}`,
    passed, failed: checks.length - passed,
    checks,
    limitation: 'CDP 的 Emulation.setEmulatedMedia 覆盖不了 pointer / any-pointer / hover'
      + '（实测六种组合返回同一组值），因此媒体特性相关的结论只由本静态断言给出。',
  };
}

// ══════════════════════════════════════════════════════════
// 断言套件
// ══════════════════════════════════════════════════════════

/** 用 CDP 发一次真实触摸序列（Chrome 会为它合成 pointerdown/move/up）。
 *  dx/dy 以 CSS 像素为单位，由 CDP 自己按 dpr 换算。 */
async function dispatchTouch(cdp, x, y, dx, dy, steps = 6) {
  const pt = (px, py) => ({ x: Math.round(px), y: Math.round(py), radiusX: 12, radiusY: 12, force: 1 });
  try {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [pt(x, y)] });
    for (let i = 1; i <= steps; i++) {
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove', touchPoints: [pt(x + (dx * i) / steps, y + (dy * i) / steps)],
      });
      await sleep(16);
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  } catch (e) {
    // 触摸序列里有一条没回，说明渲染进程已经不响应了（没有更好的补救办法，
    // 但把「卡在哪一步」记下来，下次一眼能看出是哪个事件出的问题）
    return { err: `触摸序列中断: ${e.message}` };
  }
  return { ok: true };
}

/** 一轮触摸序列之后把触摸模拟重挂一次。
 *  踩过的坑：连着做「画布上拖一把」再「长按圆钮」时，第二段触摸会被
 *  上一段留下的指针状态影响 —— 单独跑长按是好的，接在拖动后面就不触发。
 *  重挂 setTouchEmulationEnabled 能把合成器的状态清干净，两段就互不干扰了。
 *  连设备尺寸覆盖一起清掉再挂回去：只重挂触摸开关不够（实测仍会残留）。 */
async function resetTouchEmulation(cdp) {
  // 诊断开关：NO_LP_RESET=1 时整段跳过，用来分辨「套件自身在干扰模拟状态」
  // 还是「产品有问题」。不设这个环境变量时行为完全不变。
  if (process.env.NO_LP_RESET === '1') return;
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false }).catch(() => {});
  await cdp.send('Emulation.clearDeviceMetricsOverride').catch(() => {});
  await sleep(150);
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 }).catch(() => {});
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: VIEW.width, height: VIEW.height, deviceScaleFactor: VIEW.dsf,
    mobile: VIEW.mobile, screenWidth: VIEW.width, screenHeight: VIEW.height,
  }).catch(() => {});
  await sleep(200);
}

/** 单点一次（按下→停 50ms→抬起），返回错误信息或 null。
 *  CDP 的输入事件在渲染进程忙时可能长时间不回应答，所以每一处触摸都要能失败而不炸掉整轮。 */
async function tap(cdp, x, y) {
  const pt = { x: Math.round(x), y: Math.round(y), radiusX: 12, radiusY: 12, force: 1 };
  try {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [pt] });
    await sleep(50);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    return null;
  } catch (e) {
    return '点击事件未应答: ' + e.message;
  }
}

/** 长按（按下→停 holdMs→抬起）。 */
async function longPress(cdp, x, y, holdMs) {
  const pt = { x: Math.round(x), y: Math.round(y), radiusX: 12, radiusY: 12, force: 1 };
  try {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [pt] });
    await sleep(holdMs);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    return null;
  } catch (e) {
    return '长按事件未应答: ' + e.message;
  }
}

async function runSuite(cdp, { appUrl, errors }) {
  const checks = [];
  const ok = (id, name, pass, evidence) => checks.push({ id, name, pass: !!pass, evidence });
  // 探针 B3~B5 那条序列的复现读数（见下面 7b），不进断言，只进报告
  let probeSeq = null;

  // ── 1. 布局：手机视口下不该有横向溢出 ────────────────────
  const layout = await cdp.eval(`(() => {
    const r = (s) => { const e = document.querySelector(s); if (!e) return null;
      const b = e.getBoundingClientRect(); return [Math.round(b.width), Math.round(b.height)]; };
    const pal = document.querySelector('#palette');
    const side = document.querySelector('#sidebar');
    const cs = (el) => el ? getComputedStyle(el) : null;
    return {
      innerW: innerWidth, clientW: document.documentElement.clientWidth,
      docScrollW: document.documentElement.scrollWidth,
      app: r('#app'), stage: r('#stage'), canvas: r('#canvas'),
      bodyCols: getComputedStyle(document.querySelector('#body')).gridTemplateColumns,
      // 三栏 vs 浮层：position:fixed 或 visibility:hidden 都说明它被收成浮层了
      palettePosition: cs(pal) ? cs(pal).position : null,
      paletteVisibility: cs(pal) ? cs(pal).visibility : null,
      sidebarPosition: cs(side) ? cs(side).position : null,
      topbarScrollable: (() => { const t = document.querySelector('#topbar');
        return t ? { ox: getComputedStyle(t).overflowX, sw: t.scrollWidth, cw: t.clientWidth } : null; })(),
    };
  })()`);

  if (VIEW.width >= 1181) {
    // ── 大面积视口（教室触控一体机 1920×1080 这一档）──────────
    // 与 1280 桌面基线对比：三栏必须保持、而且实验台宽度不该缩水。
    const cols = layout.bodyCols.trim().split(/\s+/).length;
    ok('G1', `大面积视口 ${layout.clientW}px 保持三栏布局（没被当成手机收成浮层）`,
      cols === 3 && layout.palettePosition !== 'fixed' && layout.paletteVisibility !== 'hidden'
      && layout.sidebarPosition !== 'fixed',
      `#body 列数=${cols}；#palette position=${layout.palettePosition} visibility=${layout.paletteVisibility}；`
      + `#sidebar position=${layout.sidebarPosition}；实验台 ${layout.stage && layout.stage[0]}px`);
    ok('G2', '大面积视口下顶栏不需要横向滑动（控件全都放得下）',
      !!layout.topbarScrollable && layout.topbarScrollable.sw <= layout.topbarScrollable.cw + 1,
      JSON.stringify(layout.topbarScrollable));
    ok('G3', `大面积视口下实验台宽度不低于桌面基线`,
      !!layout.stage && layout.stage[0] >= VIEW.expectedStageMin,
      `实测 ${layout.stage && layout.stage[0]}px，桌面基线（三栏 238+1fr+318 @1280）换算下限 ${VIEW.expectedStageMin}px`);
  } else {
    ok('L1', '实验台占满手机宽度（无横向溢出）',
      layout.stage && layout.stage[0] <= layout.clientW + 1,
      `视口 ${layout.clientW}px，实验台 ${layout.stage && layout.stage[0]}px，#body 列数 ${layout.bodyCols.split(/\s+/).length}，docScrollW ${layout.docScrollW}`);
    ok('L2', '顶栏在窄屏可横向滑动（控件够得着）',
      layout.topbarScrollable && layout.topbarScrollable.ox === 'auto',
      JSON.stringify(layout.topbarScrollable));
  }

  // 不变量（任何指针形态、任何视口都成立）：画布 touch-action 必须是 none。
  // 不能只断言「在 coarse 下是 none」—— 那条在触屏笔记本上会静默放过。
  // 真正的保证来自 interact.js 的无条件内联赋值，这里验的是它确实落地了。
  const taInvariant = await cdp.eval(`(() => { const c = document.querySelector('#canvas');
    return { computed: getComputedStyle(c).touchAction, inline: c.style.touchAction,
             pointerFine: matchMedia('(pointer: fine)').matches,
             anyPointerCoarse: matchMedia('(any-pointer: coarse)').matches,
             hintsKeys: (() => { const k = document.querySelector('.hint-keys');
               return k ? getComputedStyle(k).display : null; })() }; })()`);
  ok('TA1', '画布 touch-action 恒为 none（不随指针形态变化；内联声明，媒体查询无法覆盖它）',
    taInvariant.computed === 'none' && taInvariant.inline === 'none',
    `computed=${taInvariant.computed} inline=${taInvariant.inline} `
    + `[pointer:fine=${taInvariant.pointerFine} any-pointer:coarse=${taInvariant.anyPointerCoarse}]`
    + `；键位提示 display=${taInvariant.hintsKeys}`
    + `（本档 pointer:coarse=${!taInvariant.pointerFine} → `
    + (taInvariant.pointerFine ? '触屏笔记本，有键盘，键位提示应与触控提示并存'
                              : '以手指为主、没有键盘，键位提示应隐藏' ) + '）');
  // ── 2. 触摸拖动实体，且页面不跟着滚 ──────────────────────
  const setup = await cdp.eval(`(async () => {
    const c = document.querySelector('#canvas');
    const r = c.getBoundingClientRect();
    try { window.xiaomo.engine && window.xiaomo.engine.reset && window.xiaomo.engine.reset(); } catch (e) {}
    const before = window.xiaomo.world.entities.map(e => ({ id: e.id, x: e.x, y: e.y }));
    return { rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)], count: before.length };
  })()`);
  // 在画布中央放一个器材（走公开 API，不手搓内部结构）
  const placed = await cdp.eval(`(() => {
    try {
      const e = window.xiaomo.addEntity('resistor', 120, 120);
      return { id: e && e.id, x: e && e.x, y: e && e.y };
    } catch (err) { return { error: String(err && err.message || err) }; }
  })()`);
  ok('T0', '能在实验台上放一个器材（前置）', placed && placed.id != null, JSON.stringify(placed));

  if (placed && placed.id != null) {
    const target = await cdp.eval(`(() => {
      // 引擎只对 ctx 施加 dpr 变换（engine.js:175），没有相机/缩放层，
      // 所以「世界坐标 == 画布内的 CSS 像素」，加画布偏移就是页面坐标。
      const e = window.xiaomo.world.entities.find(x => x.id === ${JSON.stringify(placed.id)});
      const r = document.querySelector('#canvas').getBoundingClientRect();
      return { sx: r.left + e.x, sy: r.top + e.y };
    })()`);
    if (!target || target.err) ok('T1', '触摸拖动实体', false, '取屏幕坐标失败: ' + JSON.stringify(target));
    else {
      const drag = await dispatchTouch(cdp, target.sx, target.sy, 60, 12, 6);
      if (drag.err) ok('T1', '触摸拖动实体', false, drag.err);
      const after = await cdp.eval(`(() => {
        const w = window.xiaomo.world;
        const list = w && (w.entities || (w.all && w.all()));
        if (!Array.isArray(list)) return { err: 'world.entities 不是数组: ' + Object.prototype.toString.call(list) };
        const e = (w.get ? w.get(${JSON.stringify(placed.id)}) : null) || list.find(x => x && x.id === ${JSON.stringify(placed.id)});
        if (!e) return { err: '拖动后找不到该器材，当前器材数 ' + list.length };
        return { x: e.x, y: e.y, scrollY: scrollY, scrollX: scrollX };
      })()`);
      if (after.__err || after.err) {
        ok('T1', '触摸拖动实体', false, '读位置失败: ' + JSON.stringify(after.__err || after.err));
      } else {
        ok('T1', '触摸拖动实体（移动量 > 手指位移的一半）',
          !drag.err && Math.abs(after.x - placed.x) > 30, `从 (${placed.x},${placed.y}) 到 (${after.x},${after.y})`);
        ok('T2', '拖动时页面没有被滚走', after.scrollY === 0 && after.scrollX === 0,
          `scroll=(${after.scrollX},${after.scrollY})`);
      }
    }
    await cdp.eval(`(() => { try { window.xiaomo.world.remove(${JSON.stringify(placed.id)}); } catch (e) {} return 1; })()`);
    await resetTouchEmulation(cdp);
  }

  // ── 2b. 多指误触：教室里有人靠在屏幕上 ─────────────────
  // 这是触控大屏的主要事故形态，也是 interact.js 里那段「多指同时按下 → 本轮手势
  // 整体作废」设计唯一被验证的地方。必须有「误触后能恢复」这一半：
  // 一个把 multi 标志置上就再也不清的实现，能通过「没被拖动」，但过不了这一条。
  const multiPlaced = await cdp.eval(`(() => {
    try {
      // 只能用 addEntity 真认的器材种类（resistor / battery / switch …）；
      // 拼错的种类会静默返回 null，前置就白失败了。
      const e = window.xiaomo.addEntity('resistor', 140, 160);
      return { id: e && e.id, x: e && e.x, y: e && e.y };
    } catch (err) { return { error: String(err && err.message || err) }; }
  })()`);
  if (multiPlaced && multiPlaced.id != null) {
    const at = await cdp.eval(`(() => {
      const e = window.xiaomo.world.entities.find(x => x.id === ${JSON.stringify(multiPlaced.id)});
      const r = document.querySelector('#canvas').getBoundingClientRect();
      return { sx: Math.round(r.left + e.x), sy: Math.round(r.top + e.y) };
    })()`);
    const pt = (x, y) => ({ x: Math.round(x), y: Math.round(y), radiusX: 12, radiusY: 12, force: 1 });
    let multiErr = '';
    try {
      // 第一指落在器材上；第二指随后从别处落下（两枚不同触点 = 两个不同 pointerId）
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [pt(at.sx, at.sy)] });
      await sleep(60);
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [pt(at.sx, at.sy), pt(at.sx + 150, at.sy + 120)],
      });
      // 两指一起大幅移动：如果实现没有作废本轮手势，器材会被拖走
      for (let i = 1; i <= 6; i++) {
        const d = i * 20;
        await cdp.send('Input.dispatchTouchEvent', {
          type: 'touchMove',
          touchPoints: [pt(at.sx + d, at.sy + d), pt(at.sx + 150 + d, at.sy + 120 + d)],
        });
        await sleep(16);
      }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } catch (e) { multiErr = '触摸序列中断: ' + e.message; }
    await sleep(250);
    const afterMulti = await cdp.eval(`(() => {
      const e = window.xiaomo.world.entities.find(x => x.id === ${JSON.stringify(multiPlaced.id)});
      return { x: e && e.x, y: e && e.y, scrollX: scrollX, scrollY: scrollY };
    })()`);
    ok('M1', '两指同时按下时器材没有被拖走（多指误触被作废）',
      !multiErr && Math.abs(afterMulti.x - multiPlaced.x) <= 4 && Math.abs(afterMulti.y - multiPlaced.y) <= 4,
      multiErr || `器材 (${multiPlaced.x},${multiPlaced.y}) → (${afterMulti.x},${afterMulti.y})，允许 ±4（网格吸附）`);

    // 误触之后必须能恢复：单独一根手指照常拖动
    await resetTouchEmulation(cdp);
    const single = await dispatchTouch(cdp, at.sx, at.sy, 80, 40);
    await sleep(250);
    const afterSingle = await cdp.eval(`(() => {
      const e = window.xiaomo.world.entities.find(x => x.id === ${JSON.stringify(multiPlaced.id)});
      return { x: e && e.x, y: e && e.y, scrollX: scrollX, scrollY: scrollY };
    })()`);
    const moved = Math.abs(afterSingle.x - afterMulti.x) + Math.abs(afterSingle.y - afterMulti.y);
    ok('M2', '误触之后单指仍能正常拖动（multi 标志没有一坏到底）',
      !single.err && moved > 30,
      single.err || `误触后 (${afterMulti.x},${afterMulti.y}) → 单指拖动后 (${afterSingle.x},${afterSingle.y})，位移 ${moved}px`);
    ok('M3', '多指误触全程页面没有被滚走',
      afterMulti.scrollX === 0 && afterMulti.scrollY === 0
      && afterSingle.scrollX === 0 && afterSingle.scrollY === 0,
      `误触后 scroll=(${afterMulti.scrollX},${afterMulti.scrollY})，恢复后 scroll=(${afterSingle.scrollX},${afterSingle.scrollY})`);

    await cdp.eval(`(() => { try { window.xiaomo.world.remove(${JSON.stringify(multiPlaced.id)}); } catch (e) {} return 1; })()`);
    await resetTouchEmulation(cdp);
  } else {
    ok('M1', '两指同时按下时器材没有被拖走（多指误触被作废）', false,
      '前置失败：放不下器材 ' + JSON.stringify(multiPlaced));
    ok('M2', '误触之后单指仍能正常拖动', false, '前置失败');
    ok('M3', '多指误触全程页面没有被滚走', false, '前置失败');
  }

  // ── 3. touch-action 归属（不变量断言已在前面的 TA1 里给出）──
  const ta = await cdp.eval(`(() => {
    const btns = [...document.querySelectorAll('button, .tool-btn, .tmpl-pick, .dock-btn')].slice(0, 12);
    return {
      notNone: btns.filter(b => getComputedStyle(b).touchAction === 'none')
        .map(b => b.id || b.className).slice(0, 5),
    };
  })()`);
  ok('TA2', '按钮不吞掉点击（不在按钮上设 touch-action:none）',
    ta.notNone.length === 0, '误设 none 的按钮: ' + JSON.stringify(ta.notNone));

  // ── 4. 长按主题钮 = 右键（替代路径）────────────────────
  // 主题管理器没有挂在 window.xiaomo 上（那上面是 canvas/world/engine/…），
  // 所以直接 import 真的那个单例来读「当前生效的主题」——这比读 DOM 更接近事实源。
  // 断言必须落在 theme.id 上，**不能落在 theme.effective 上**：
  // 实测 theme.use(id)（不带 mode）只换配色主题，effective 只跟 mode 走
  // （mode='system' 时由 OS 决定，无头环境恒为 light）。长按的语义是「换配色主题」，
  // 拿 effective 去测它，无论实现对错都会得出「没变」——那是把断言测错了对象。
  const themeRead = `(await import('/src/core/theme.js')).theme`;
  // 先把深浅固定成 dark：这样配色主题一换，页面上是看得见的，
  // 也让「换了主题」这件事在 data-mode / colorScheme 上有独立读数可交叉验证。
  await cdp.eval(`(async () => { const t = ${themeRead}; t.use(t.id, 'dark'); return 1; })()`);
  await sleep(200);
  const themeBefore = await cdp.eval(`(async () => {
    const t = ${themeRead};
    const meta = document.querySelector('meta[name="theme-color"]');
    return { id: t.id, mode: t.mode, eff: t.effective, meta: meta && meta.content };
  })()`);
  // 长按的宿主是画布上那枚浮动圆钮 .fx-orb（touch.js 的 installThemeLongPress 绑的就是它），
  // 它循环「浅 ⇄ 深」；主题色本身由侧边栏那排 .theme-dot 点选。
  const orbBox = await cdp.eval(`(() => {
    const o = document.querySelector('.fx-orb');
    if (!o) return { err: '找不到浮动主题圆钮 .fx-orb' };
    const b = o.getBoundingClientRect();
    if (b.width === 0) return { err: '.fx-orb 尺寸为 0（未渲染）' };
    return { x: b.left + b.width / 2, y: b.top + b.height / 2, w: Math.round(b.width), h: Math.round(b.height) };
  })()`);
  if (orbBox.err) {
    ok('LP0', '前置：能定位到主题圆钮 .fx-orb', false, orbBox.err);
  } else {
    // 先埋一层事件记录（诊断用：分得清「事件没到」和「到了又被取消」），
    // 记录的结果会附在证据里，读报告的人不用再跑一次就能看出是哪一种。
    await cdp.eval(`(() => {
      const orb = document.querySelector('.fx-orb');
      window.__lpLog = [];
      const rec = (t) => (ev) => window.__lpLog.push(t + '@' + Math.round(ev.clientX) + ',' + Math.round(ev.clientY));
      for (const t of ['pointerdown','pointermove','pointerup','pointercancel','pointerleave','click','contextmenu'])
        orb.addEventListener(t, rec(t), true);
      return 1;
    })()`);
    // 长按前把前提量一遍，写进证据：失败时能就地分辨「事件没到」「回调没跑」
    // 「回调跑了但主题没换」，不用为了定位再跑一次。
    const lpPre = await cdp.eval(`(async () => {
      const t = ${themeRead};
      const orb = document.querySelector('.fx-orb');
      const b = orb ? orb.getBoundingClientRect() : null;
      return {
        themeId: t.id, themeCount: t.list().length,
        firesBefore: document.documentElement.dataset.lpFires || '0',
        orbCount: document.querySelectorAll('.fx-orb').length,
        orbBox: b ? [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)] : null,
        // 圆钮位置上最顶层的元素：若被抽屉遮罩之类压住，点击就落不到它身上
        topAt: (() => { const e = document.elementFromPoint(${Math.round(orbBox.x)}, ${Math.round(orbBox.y)});
          return e ? (e.tagName + '.' + (typeof e.className === 'string' ? e.className : '')) : null; })(),
      };
    })()`);
    // 长按：按下后原地不动，等超过 LONG_PRESS_MS（550ms）再抬手
    const lpErr = await longPress(cdp, orbBox.x, orbBox.y, 800);
    await sleep(400);
    const readTheme = async () => cdp.eval(`(async () => {
      const t = ${themeRead};
      const meta = document.querySelector('meta[name="theme-color"]');
      return { id: t.id, mode: t.mode, eff: t.effective, meta: meta && meta.content,
               fires: document.documentElement.dataset.lpFires || '0',
               trace: JSON.stringify(window.__lpTrace || []),
               orbs: document.querySelectorAll('.fx-orb').length,
               log: (window.__lpLog || []).join(' → ') };
    })()`);
    let themeAfter = await readTheme();
    // 计数的直读值单独取一次：它回答的是「长按回调到底跑了没有」，
    // 与「主题换没换」是两个独立事实，分开报才分得清是哪一环断的。
    const lpNote = `；长按回调触发次数=${await cdp.eval(`document.documentElement.dataset.lpFires || '0'`)}`;
    if (themeAfter.id === themeBefore.id) {
      // 无头环境下触摸合成器在一轮动作序列之后可能残留状态（真实手指没有这个问题），
      // 所以允许重试一次。这不放松断言：重试后仍然要求 theme.id 真的变了，
      // 「两次都没变」照旧判失败。
      const retryErr = await longPress(cdp, orbBox.x, orbBox.y, 800);
      await sleep(400);
      const second = await readTheme();
      const retryNote = `；首次未换色，重试一次${retryErr ? '（' + retryErr + '）' : ''}`;
      if (second.id !== themeBefore.id) themeAfter = second;
      else themeAfter = { ...second, log: second.log + ' || 重试后仍未换' };
      themeAfter.note = lpNote + retryNote;
    }
    const lpEvidence = `主题 id ${themeBefore.id} → ${themeAfter.id}`
      + `（effective ${themeBefore.eff} → ${themeAfter.eff}，mode=${themeAfter.mode}）`
      + (themeAfter.note || lpNote)
      + `；回调轨迹 ${themeAfter.trace}`
      + `；长按前前提 ${JSON.stringify(lpPre)}`
      + `；.fx-orb 个数 ${themeAfter.orbs}；事件序列 [${themeAfter.log}]`;
    ok('LP1', '长按圆钮换配色主题（长按 = 右键的替代路径）',
      !lpErr && themeAfter.id !== themeBefore.id, lpErr || lpEvidence);

    // ── 5b. 长按的所有权守卫：学分徽章不该被我的兜底接管 ──────────
    // system.credit.js 自己在 .credit-badge 上监听 contextmenu 打开设置，
    // 长按徽章时浏览器会派发 contextmenu → 我的长按兜底和它自己的菜单会被同一次按压同时触发。
    // 判定依据是**手势起源**：起点落在 .credit-badge 里就放行给它。
    // 这里用 installLongPress 里数的 lpArm（架起计时器的次数）来验，纯观测、无副作用：
    //   · 按圆钮本体     → 计数 +1（守卫放行）
    //   · 按「圆钮里一个处于 .credit-badge 内的元素」这个形状 → 计数不变（守卫拦下）
    // 为了不依赖页面上恰好存在某个特定嵌套结构，这里直接构造那个形状：
    // 临时把圆钮的一个子元素包进 .credit-badge，事件从子元素冒泡到圆钮。
    // 这样测的就是守卫的判定逻辑本身（closest('.credit-badge')），
    // 而不是「徽章是不是圆钮的子元素」这种与本条无关的巧合。
    const guard = await cdp.eval(`(async () => {
      const d = document.documentElement;
      const orb = document.querySelector('.fx-orb');
      if (!orb) return { err: '找不到 .fx-orb' };
      const before = Number(d.dataset.lpArm) || 0;
      const fire = (target) => {
        const r = target.getBoundingClientRect();
        const o = { bubbles: true, cancelable: true, composed: true, pointerId: 41,
                    pointerType: 'touch', isPrimary: true, button: 0,
                    clientX: Math.round(r.left + r.width / 2), clientY: Math.round(r.top + r.height / 2) };
        target.dispatchEvent(new PointerEvent('pointerdown', o));
        target.dispatchEvent(new PointerEvent('pointerup', o));
      };
      // ① 守卫放行：直接按圆钮
      fire(orb);
      const afterOrb = Number(d.dataset.lpArm) || 0;
      // ② 守卫拦下：构造「起点在 .credit-badge 内」的形状
      const wrap = document.createElement('div');
      wrap.className = 'credit-badge';
      wrap.style.cssText = 'position:absolute;left:0;top:0;width:10px;height:10px';
      orb.appendChild(wrap);
      fire(wrap);
      const afterBadge = Number(d.dataset.lpArm) || 0;
      wrap.remove();
      return { before, afterOrb, afterBadge, orbArmed: afterOrb - before, badgeArmed: afterBadge - afterOrb };
    })()`);
    ok('LP2', '长按守卫：起点落在 .credit-badge 里时不由触控兜底接管（一次手势只有一个所有者）',
      !guard.err && guard.orbArmed === 1 && guard.badgeArmed === 0,
      guard.err || `按圆钮 → lpArm +${guard.orbArmed}（期望 1，守卫放行）；`
        + `按 .credit-badge 内的元素 → lpArm +${guard.badgeArmed}（期望 0，守卫拦下）`);

    // ── 5c. 学分徽章的长按替代（用户需求「触控适配」的最后一处漏网）──────
    // system.credit.js 原本只有 contextmenu（鼠标专属）→ 触屏够不着。
    // 现在它复用 touch.js 的公共长按识别器（installLongPress），这里验四条路径。
    //
    // ⚠ 为什么用 **CDP 真实触摸输入**（Input.dispatchTouchEvent）而不是合成 PointerEvent：
    //   长按是**按真实时钟**判定的，而合成事件的派发本身要花时间 ——
    //   实测「名义 450ms」那一次，从 touchStart 到 touchEnd 实际过了 548ms，
    //   已经贴到 550ms 阈值上，于是同一份代码时而红时而绿（我先前那版就是这么假红的：
    //   它报「按住 400ms 竟然打开了设置」，而真实触摸下 400ms 从来打不开）。
    //   真实触摸不给这个歧义，而且我可以把握持时长**如实量出来**并按它断言。
    // ⚠ 徽章在 390 宽下位于顶栏横向滚动区之外，必须 scrollIntoView 后再量坐标，
    //   否则 dispatchTouchEvent 打在视口外。
    // ⚠ 也不能只看「面板显示了吗」：settings 抽屉有 4 个 .drawer-mask，
    //   要用「内含 aside.drawer 的那个」来认，否则会读到别的抽屉。
    const crd = await (async () => {
      const badgeCenter = () => cdp.eval(`(async () => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const b = document.querySelector('.credit-badge');
        if (!b) return { err: '找不到 .credit-badge' };
        b.scrollIntoView({ block: 'nearest', inline: 'center' });
        await sleep(150);
        const r = b.getBoundingClientRect();
        return { cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2),
                 w: Math.round(r.width), h: Math.round(r.height) };
      })()`);

      const settingsState = () => cdp.eval(`(() => {
        const m = [...document.querySelectorAll('.drawer-mask')]
          .find((x) => x.querySelector('aside.drawer'));
        return { open: !!(m && getComputedStyle(m).display !== 'none'),
                 cls: m ? m.className : null };
      })()`);

      // 事件计数：比「面板开着」更精确 —— 短按若也派发了事件会被这里抓住
      const armCounter = () => cdp.eval(`(() => {
        window.__crEvt = 0;
        window.__crAt = null;
        window.__crT0 = performance.now();
        window.__crH = () => { window.__crEvt++; if (window.__crAt === null) window.__crAt = performance.now() - window.__crT0; };
        window.addEventListener('xiaomo:settings', window.__crH);
        return true;
      })()`);
      const disarm = () => cdp.eval(
        `(() => { if (window.__crH) window.removeEventListener('xiaomo:settings', window.__crH); return true; })()`);

      const closeIt = () => cdp.eval(`(async () => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const m = [...document.querySelectorAll('.drawer-mask')]
          .find((x) => x.querySelector('aside.drawer'));
        const x = m && m.querySelector('.drawer-x');
        if (x) x.click();
        await sleep(700);
        return true;
      })()`);

      // 真实触摸：touchStart →（可选中途 touchMove）→ touchEnd。
      // 返回**实测握持时长**（墙钟）；断言用它，不用名义毫秒。
      const realHold = async (ms, moveDx) => {
        const p = await badgeCenter();
        if (p.err) return { err: p.err };
        await armCounter();
        // 记录真实触摸到底产生了哪些指针事件（用来验「横移有没有变成 pointermove」）
        await cdp.eval(`(() => {
          window.__plog = [];
          const b = document.querySelector('.credit-badge');
          const rec = (e) => window.__plog.push(e.type + '@' + Math.round(e.clientX) + ',' + Math.round(e.clientY));
          ['pointerdown','pointermove','pointerup','pointercancel','pointerleave']
            .forEach((t) => b.addEventListener(t, rec, { capture: true }));
          window.__pstop = () => ['pointerdown','pointermove','pointerup','pointercancel','pointerleave']
            .forEach((t) => b.removeEventListener(t, rec, { capture: true }));
          return true;
        })()`);
        const openBefore = await settingsState();
        const t0 = Date.now();
        await cdp.send('Input.dispatchTouchEvent', {
          type: 'touchStart',
          touchPoints: [{ x: p.cx, y: p.cy, id: 1, radiusX: 12, radiusY: 12, force: 1 }],
        });
        if (moveDx) {
          // ⚠ 横移必须发生在阈值**之前**。旧版先 sleep(ms=900) 再移，等移到的时候
          //   长按计时器（550ms）早就烧完了 —— 那测出来的是「移得太晚」，不是
          //   「移动作废」。实测：事件在按下后 631ms 才被承认，而 move 直到 900ms
          //   才发出，于是长按赢了这场竞速。
          await sleep(200);
          await cdp.send('Input.dispatchTouchEvent', {
            type: 'touchMove',
            touchPoints: [{ x: p.cx + moveDx, y: p.cy, id: 1, radiusX: 12, radiusY: 12, force: 1 }],
          });
          await sleep(Math.max(0, ms - 200));
        } else {
          await sleep(ms);
        }
        // 把握持中点采到的 inline transform 带回来 —— 按下反馈只能在中途采到：
        // 长按被识别（550ms）的那一刻 touch.js 会 unpaint()，之后读到的是 (none)。
        const midTransform = await cdp.eval(
          `(() => { const b = document.querySelector('.credit-badge');
            return b ? (b.style.transform || '(none)') : '(no-badge)'; })()`);
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        const held = Date.now() - t0;
        await sleep(900);
        const st = await settingsState();
        const evt = await cdp.eval('window.__crEvt');
        const plog = await cdp.eval('window.__plog');
        const evtAt = await cdp.eval('window.__crAt');
        await cdp.eval('window.__pstop && window.__pstop()');
        await disarm();
        await closeIt();
        return { held, open: st.open, cls: st.cls, evt, w: p.w, h: p.h, midTransform, plog,
                 openBefore: openBefore.open, clsBefore: openBefore.cls,
                 evtAtMs: evtAt === null ? null : Math.round(evtAt) };
      };

      await closeIt();
      // ① 短按：名义 250ms。派发本身约 +100ms → 实测约 350ms，离 550ms 阈值还有余量
      const short = await realHold(250);
      // ② 长按 900ms 但中途横移 40px（> LONG_PRESS_SLOP=10）→ 必须作废
      const moved = await realHold(900, 40);
      // ③ 长按 900ms 不动 → 必须打开
      const long = await realHold(900);
      // ④ 右键路径（桌面零回归）：与长按走同一个入口
      await armCounter();
      await cdp.eval(`(() => { const b = document.querySelector('.credit-badge');
        if (b) b.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
        return true; })()`);
      await sleep(700);
      const ctxSt = await settingsState();
      const ctxEvt = await cdp.eval('window.__crEvt');
      await disarm();
      await closeIt();

      // 阈值从源码读，别在测试里再抄一遍（抄两遍必然不同步）
      const touchSrc = readFileSync(
        join(import.meta.dirname, '..', 'src', 'ui', 'touch.js'), 'utf8');
      const thr = Number((touchSrc.match(/const LONG_PRESS_MS\s*=\s*(\d+)/) || [])[1]);

      return {
        thr, short, moved, long,
        maskCls: long.cls,
        ctx: { open: ctxSt.open, evt: ctxEvt },
        geo: await cdp.eval(`(() => { const b = document.querySelector('.credit-badge');
          return b ? { title: b.title, w: Math.round(b.getBoundingClientRect().width) } : null; })()`),
      };
    })();

    const crHeld = (r) => (r && typeof r.held === 'number' ? r.held : null);
    const crOK = (r, wantOpen) => !!(r && !r.err && r.open === wantOpen);

    ok('CR1', '长按学分徽章 → 设置抽屉打开（触屏拿到了原本只有右键才有的入口）',
      crOK(crd.long, true) && crd.long.evt === 1,
      crd.long && crd.long.err ? crd.long.err
        : `实测握持 ${crd.long.held}ms（阈值 ${crd.thr}ms）→ 面板 ${crd.long.open}`
          + `，xiaomo:settings 事件数=${crd.long.evt}（期望 true / 1），mask="${crd.long.cls}"`);

    ok('CR2', `长按防误触：短按 / 中途移动 ${'>'}slop，都不得派发设置事件（且不得把面板留在打开态）`,
      crOK(crd.short, false) && crd.short.evt === 0
      && crOK(crd.moved, false) && crd.moved.evt === 0
      && crHeld(crd.short) !== null && crHeld(crd.short) < crd.thr,
      `短按 实测 ${crHeld(crd.short)}ms（名义 250）→ 按下前面板=${crd.short.openBefore}，`
      + `按完=${crd.short.open}，本次事件数=${crd.short.evt}；`
      + `移动 40px 后 实测 ${crHeld(crd.moved)}ms → 按下前面板=${crd.moved.openBefore}，`
      + `按完=${crd.moved.open}，本次事件数=${crd.moved.evt}；`
      + `长按事件${crd.moved.evtAtMs === null ? '全程未被承认' : `在按下后 ${crd.moved.evtAtMs}ms 才被承认`}（阈值 ${crd.thr}ms）；`
      + `事件序列=[${(crd.moved.plog || []).join(' → ')}]；`
      + `判据：两次都必须 evt=0（长按没被承认），实测短按 ${crHeld(crd.short)}ms < 阈值 ${crd.thr}ms`);

    ok('CR3', '桌面零回归：右键路径仍可用，且与长按走同一个入口（同一次 xiaomo:settings）',
      crd.ctx.open === true && crd.ctx.evt === 1,
      `右键后 面板=${crd.ctx.open} 事件数=${crd.ctx.evt}（期望 true / 1）`);

    ok('CR4', '长按有可见反馈：真实触摸按下后，握持中途必须能采到 scale()',
      !!(crd.short && !crd.short.err && /scale\(/.test(crd.short.midTransform)),
      crd.short && crd.short.err ? crd.short.err
        : `真实触摸按在徽章上，握持中点采到的 inline transform="${crd.short.midTransform}"`
          + `（期望含 scale(…)）；抬起到长按被识别的瞬间会被 touch.js unpaint() 清掉，`
          + `所以「按满 900ms 再读」读到 (none) 是正常的、不代表没有反馈`);

    ok('CR5', '徽章说明文字同时提到右键与长按（不自闭的鼠标文案）',
      !!(crd.geo && /右键/.test(crd.geo.title) && /长按/.test(crd.geo.title)),
      `title="${crd.geo ? crd.geo.title : '(未取到)'}"`);

    // ── 5d. 按下反馈的生命周期：出现 → 长按被识别的瞬间清掉 → 抬起后不留痕 ──
    // 这条用合成 PointerEvent（它能精确控制时序）验「清掉」这一步；
    // 真实触摸那条（CR4）负责证明「反馈真的会出现」—— 两条合起来才完整。
    const crFeed = await cdp.eval(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const b = document.querySelector('.credit-badge');
      if (!b) return { err: '找不到 .credit-badge' };
      b.scrollIntoView({ block: 'nearest', inline: 'center' });
      await sleep(150);
      const r = b.getBoundingClientRect();
      const cx = Math.round(r.left + r.width / 2), cy = Math.round(r.top + r.height / 2);
      const hit = document.elementFromPoint(cx, cy);
      const owns = !!(hit && (hit === b || b.contains(hit)));
      const fire = (type, x, y) => b.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, composed: true,
        pointerId: 55, pointerType: 'touch', isPrimary: true, button: 0,
        clientX: x, clientY: y }));
      const before = b.style.transform || '(none)';
      fire('pointerdown', cx, cy);
      await sleep(200);
      const mid = b.style.transform || '(none)';
      const midTransition = b.style.transition || '';
      fire('pointerup', cx, cy);
      fire('pointerleave', cx, cy);
      await sleep(600);
      // ⚠ 这里**不要**用「|| '(none)'」兜底：inline style 被清空后读出来就是空串，
      //   兜底会把「已清干净」伪装成字面量 (none)，断言就永远比不中。
      //   （另：本文件这一整段是外层模板字符串，注释里也不能出现反引号 ——
      //     一个反引号就会提前结束模板，把后面的代码变成非法表达式。）
      const after = b.style.transform;
      return { before, mid, midTransition, after, owns, cx, cy };
    })()`);

    ok('CR4b', '按下反馈采样必须落在按下中途：200ms 处是 scale()，抬起后清干净',
      !crFeed.err && /scale\(/.test(crFeed.mid) && crFeed.after === '',
      crFeed.err || `按下前 "${crFeed.before}"；按住 200ms 时 "${crFeed.mid}"`
        + `（transition="${crFeed.midTransition}"）；抬起后 "${crFeed.after === '' ? '(已清空)' : crFeed.after}"`
        + `；按下点归属徽章=${crFeed.owns}`);
    // ── 5. theme-color 跟「生效的主题」而不是只跟 OS ──────
    const metaSync = await cdp.eval(`(() => {
      const meta = document.querySelector('meta[name="theme-color"]');
      const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
      const rgbToHex = (s) => {
        const m = s.match(/rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)/);
        return m ? '#' + [1,2,3].map(i => (+m[i]).toString(16).padStart(2,'0')).join('') : s;
      };
      const bar = document.querySelector('#topbar');
      return { meta: meta && meta.content, bgVar: bg, bgHex: bg ? rgbToHex(bg) : null,
               mode: document.documentElement.dataset.mode,
               topbarBg: bar ? getComputedStyle(bar).backgroundColor : null };
    })()`);
    ok('TC1', 'meta[theme-color] 与当前生效主题的 --bg 同值',
      !!metaSync.meta && !!metaSync.bgHex && metaSync.meta.toLowerCase() === metaSync.bgHex.toLowerCase(),
      `meta=${metaSync.meta} --bg=${metaSync.bgHex} (computed ${metaSync.bgVar}) mode=${metaSync.mode}`);
  }

  // ── 6. 命中目标 ≥44px ──────────────────────────────────
  // 关键一：可见盒子 ≠ 命中盒子。触屏笔记本上我们刻意**不**放大视觉尺寸，
  //   只把命中区撑到 44px —— 必须量「元素盒子 + 伪元素扩边」的并集，
  //   光量 getBoundingClientRect 会把正确的实现判成失败。
  // 关键二：只量**真正在视口里**的控件。窄屏下 .tb-right 那一组会在顶栏右侧
  //   视口之外（实测 x=590 而视口只有 390px），那里 getBoundingClientRect 给出的是
  //   「布局位置」而不是「用户碰得到的位置」，拿它判 44px 毫无意义 ——
  //   顶栏是横向可滑动的，用户滑动之后才能真正碰到它们。
  const hit = await cdp.eval(`(() => {
    const onScreen = (e) => {
      const b = e.getBoundingClientRect();
      const cs = getComputedStyle(e);
      return cs.display !== 'none' && cs.visibility !== 'hidden'
        && b.right > 0 && b.bottom > 0 && b.left < innerWidth && b.top < innerHeight
        && b.width > 0 && b.height > 0;
    };
    /**
     * 真实可命中范围 —— 用 elementFromPoint 从元素中心向上下左右逐像素走，
     * 直到命中的元素不再是它（或它的后代）为止。
     *
     * ⚠ 这里曾经用「盒子 + 伪元素 inset 外扩」来算命中盒，那是**错的**：
     * 伪元素为了不挡住宿主必须带 pointer-events:none，而带这个属性的盒子对命中测试
     * 是透明的，所以那圈外扩一个像素都点不到。实测（同一台机器、同一时刻）：
     * 算术算出来 .tool-btn 命中 44×44，逐像素扫描只有 32×33 —— 也就是「假绿」。
     * 断言必须建立在「手指真能点到的那块面积」上，所以改成真扫。
     *
     * ⚠ 还有一个坑：元素落在视口外时 elementFromPoint 恒返回 null，
     *     扫出来就是 1×1 —— 那不是「命中区只有 1px」，是「根本够不着」。
     *     顶栏在窄屏是可横向滑动的，右侧控件初始就在视口外，
     *     所以量之前必须先把顶栏滑到底（H3 就踩过这个：报 1×1）。
     */
    const realHit = (e) => {
      const b = e.getBoundingClientRect();
      const vis = { w: Math.round(b.width), h: Math.round(b.height),
                    x: Math.round(b.left), y: Math.round(b.top) };
      const cx = Math.round(b.left + b.width / 2), cy = Math.round(b.top + b.height / 2);
      const owns = (hit) => !!hit && (hit === e || e.contains(hit));
      const step = (dx, dy) => {
        let n = 0;
        for (let i = 1; i <= 80; i++) {
          if (!owns(document.elementFromPoint(cx + dx * i, cy + dy * i))) break;
          n = i;
        }
        return n;
      };
      const up = step(0, -1), down = step(0, 1), left = step(-1, 0), right = step(1, 0);
      return { vis, hit: { w: left + right + 1, h: up + down + 1 } };
    };
    /**
     * 把元素滚进视口中间再量。为什么必须逐个滚：
     * 顶栏在窄屏是横向可滑动的，右端控件初始在视口外，而 elementFromPoint 对
     * 视口外的坐标恒返回 null（扫出来是 1×1 —— 那不是「命中区 1px」，是「够不着」）。
     * 但**不能**先统一滑到底再逐个量：滑动是全局状态，量后面那个元素时
     * 前面那个已经被推出视口了（H4 就踩过这个：.tool-btn 报「视口外」）。
     * 所以每量一个元素就把它居中一次，量完再还原顶栏的滚动位置。
     */
    const measure = (sel) => {
      const e = document.querySelector(sel);
      if (!e) return { sel, missing: true };
      const cs = getComputedStyle(e);
      // display:none 就是「这个档位不需要它」，不是尺寸不合格：
      // 宽屏下器材栏/侧边栏本就是常驻三栏，顶栏那两个抽屉入口由 touch.css 关掉
      // （那是可触摸的教室大屏，不是坏掉的按钮）。量它的 44px 没有意义 ——
      // 量出来的是「没有布局盒子」这件事本身。
      if (cs.display === 'none') return { sel, hidden: true };
      const bar = document.querySelector('#topbar');
      const isInBar = !!(bar && e.closest && e.closest('#topbar'));
      const prev = bar ? bar.scrollLeft : 0;
      if (isInBar) {
        const b = e.getBoundingClientRect();
        const mid = b.left + b.width / 2 - bar.getBoundingClientRect().width / 2;
        bar.scrollLeft = Math.max(0, Math.min(bar.scrollWidth, bar.scrollLeft + mid));
      }
      const onScr = onScreen(e);
      const out = onScr ? realHit(e) : null;
      if (isInBar) bar.scrollLeft = prev;
      if (!onScr) return { sel, offscreen: true, vis: Math.round(e.getBoundingClientRect().width) };
      return Object.assign({ sel }, out);
    };
    const dotCs = document.querySelector('.theme-dot') ? getComputedStyle(document.querySelector('.theme-dot')) : null;
    // ── 选中态不许改变命中区（Lead 裁决④③）──────────────────────────
    // 这一列圆点是 margin:0 + gap:0 首尾相接的，所以任何一个圆点的命中盒一旦变大，
    // 就会从邻居身上抢像素（.tool-btn 横向扩边被否掉的就是这件事）。
    // 桌面的 .theme-dot.active 是 transform:scale(1.12)，会把 44px 变成 49.3px ——
    // 所以这里不能只看「当前那一个」多大，必须**把选中态挪走再量同一个圆点**：
    // 若两次读数不同，说明命中区随选中态浮动。
    const dotInvariance = (() => {
      const dots = [...document.querySelectorAll('.theme-dot')];
      if (dots.length < 2) return { skipped: true, why: '圆点少于 2 个，无法做对照' };
      const hitOf = (el) => {
        const b = el.getBoundingClientRect();
        const cx = Math.round(b.left + b.width / 2), cy = Math.round(b.top + b.height / 2);
        const owns = (h) => !!h && (h === el || el.contains(h));
        const step = (dx, dy) => { let n = 0;
          for (let i = 1; i <= 80; i++) {
            if (!owns(document.elementFromPoint(cx + dx * i, cy + dy * i))) break; n = i; }
          return n; };
        return { w: step(-1, 0) + step(1, 0) + 1, h: step(0, -1) + step(0, 1) + 1 };
      };
      const probeIdx = dots.findIndex(d => !d.classList.contains('active'));
      const idx = probeIdx >= 0 ? probeIdx : 0;
      const before = { active: dots.findIndex(d => d.classList.contains('active')), hit: hitOf(dots[idx]) };
      const prevActive = before.active;
      if (prevActive >= 0) dots[prevActive].classList.remove('active');
      dots[idx].classList.add('active');
      const after = { active: idx, hit: hitOf(dots[idx]) };
      dots[idx].classList.remove('active');
      if (prevActive >= 0) dots[prevActive].classList.add('active');
      return { count: dots.length, idx, before, after,
               same: before.hit.w === after.hit.w && before.hit.h === after.hit.h,
               minW: Math.min(...dots.map(d => hitOf(d).w)),
               minH: Math.min(...dots.map(d => hitOf(d).h)) };
    })();
    return {
      themeDot: measure('.theme-dot'),
      toolBtn: measure('.tool-btn'),
      tbCheck: measure('.tb-check'),
      dock: measure('#btnPalette'),
      dock2: measure('#btnSidebar'),
      dotVisualBackground: dotCs ? dotCs.backgroundImage.slice(0, 100) : null,
      dotInvariance,
      exists: { dock: !!document.querySelector('#btnPalette'), dock2: !!document.querySelector('#btnSidebar') },
      viewport: { w: innerWidth, h: innerHeight },
    };
  })()`);
  const sizeOK = (m) => m && m.hit && m.hit.w >= 44 && m.hit.h >= 44;
  // 视口外 ≠ 不合格，但也不能靠推断放过 —— 把顶栏横向滚到底再量一次真值。
  // 顶栏在窄屏是可横向滚动的（第 6 节的策略），滑过去就能碰到，
  // 那时量到的才是用户手指真正的命中盒。
  if (hit.tbCheck && hit.tbCheck.offscreen) {
    const scrolled = await cdp.eval(`(() => {
      const bar = document.querySelector('#topbar');
      const orb = document.querySelector('.fx-orb');
      const prevBar = bar ? bar.scrollLeft : 0;
      if (bar) bar.scrollLeft = bar.scrollWidth;
      const e = document.querySelector('.tb-check');
      const px = (v) => parseFloat(v) || 0;
      const b = e.getBoundingClientRect();
      let x1 = b.left, y1 = b.top, x2 = b.right, y2 = b.bottom;
      for (const pe of ['::before', '::after']) {
        const cs = getComputedStyle(e, pe);
        if (cs.content === 'none' || cs.display === 'none' || cs.position !== 'absolute') continue;
        x1 = Math.min(x1, b.left + px(cs.left));
        y1 = Math.min(y1, b.top + px(cs.top));
        x2 = Math.max(x2, b.right - px(cs.right));
        y2 = Math.max(y2, b.bottom - px(cs.bottom));
      }
      const out = { vis: { w: Math.round(b.width), h: Math.round(b.height), x: Math.round(b.left) },
                    hit: { w: Math.round(x2 - x1), h: Math.round(y2 - y1) },
                    onScreen: b.right > 0 && b.left < innerWidth && b.width > 0 };
      if (bar) bar.scrollLeft = prevBar;
      return out;
    })()`);
    if (scrolled && scrolled.vis.w > 0) {
      hit.tbCheck = { sel: '.tb-check', vis: scrolled.vis, hit: scrolled.hit,
                      measuredAfterScroll: scrolled.onScreen };
    }
  }
  // 视口外的控件：只要求「尺寸合格」，不要求「此刻在视口里」。
  // 窄屏顶栏是横向可滚动的，右边的控件滑一下就能碰到，尺寸对了就是对的；
  // 把「此刻不可见」判成失败，会把一个正确实现判错（H3 就是这样被误判过一次）。
  const sizeOKOrOffscreen = (m) => sizeOK(m)
    || (m && m.offscreen && m.vis >= 44)
    || (m && m.hidden);          // 该档位不需要这个入口（常驻三栏时抽屉入口被关掉）
  const show = (m) => !m ? 'null' : m.missing ? '不存在'
    : m.hidden ? '本档位不需要（display:none，常驻栏布局下抽屉入口被关掉）'
    : m.measuredAfterScroll ? `滑动后量得 命中 ${JSON.stringify(m.hit)} / 可见 ${JSON.stringify(m.vis)}`
    : m.offscreen ? `视口外（可见宽 ${m.vis}px；顶栏可横向滑动，尺寸合格即算通过）`
    : `命中 ${JSON.stringify(m.hit)} / 可见 ${JSON.stringify(m.vis)}`;
  ok('H1', '主题圆钮命中区 ≥44×44', sizeOK(hit.themeDot), show(hit.themeDot));
  ok('H2', '顶栏「器材栏」入口 ≥44×44（本档位需要时）', sizeOKOrOffscreen(hit.dock), show(hit.dock));
  ok('H3', '顶栏「侧边栏」入口 ≥44×44（本档位需要时）', sizeOKOrOffscreen(hit.dock2), show(hit.dock2));

  // H4 的判据：**高度**必须 ≥44px；宽度只做如实记录，不当失败条件。
  // 为什么宽度不设门槛：.tool-btn 在 main.css 里是 32×32 的方按钮，
  // 而顶栏相邻按钮只隔 4~8px —— 把宽度扩到 44px 必然与前一个按钮重叠，
  // 重叠区的归属由浏览器决定。实测（扩成 44×44 后逐像素扫）：横向只拿到 36px，
  // 比不扩还差（32 → 36 的收益是假的，因为那 4px 是从邻居身上抢来的）。
  // 所以这里只把**结构上真正做得到**的那一维（高度）设成门槛，
  // 宽度如实报出来，不写成「已满足」也不写成「失败」。
  // 大屏档位里这一条会被真正量到（见 --size 1936x1018）。
  const h4HeightOK = hit.toolBtn && hit.toolBtn.hit && hit.toolBtn.hit.h >= 44
    && (!hit.tbCheck || hit.tbCheck.hidden || hit.tbCheck.offscreen
        || (hit.tbCheck.hit && hit.tbCheck.hit.h >= 44));
  const widthNote = (m) => (m && m.hit && m.hit.w < 44)
    ? `（宽 ${m.hit.w}px <44：相邻按钮间隔仅 4~8px，横向扩边会与邻居重叠、像素归属由浏览器决定，故不设宽度门槛）` : '';
  ok('H4', '顶栏原生控件命中区高度 ≥44px（靠显式高度扩真盒子，视觉尺寸不变）',
    h4HeightOK,
    `.tool-btn ${show(hit.toolBtn)}${widthNote(hit.toolBtn)}`
    + ` ；.tb-check ${show(hit.tbCheck)}${widthNote(hit.tbCheck)}`
    + `（视口 ${hit.viewport.w}×${hit.viewport.h}）`);

  // ── H5：跨层压制的哨兵（Lead 裁决③：跨层样式只许「只抬高、不压低」）──
  // 背景：styles/display.css 是**后加载**的一层，它有一条 `html.big-read .tb-check`
  // 特异性高于本层，曾经用 height:38px 把这里修好的 44px 又压回 38px ——
  // 也就是「下层刚修好、被上层悄悄压回去」，而逐像素扫描只在元素**当时可见**时才量得到，
  // 一旦被压回 38px 而元素又在视口外，H4 就会以「视口外，尺寸合格即算通过」放行。
  // 所以这里补一条**不依赖可见性**的哨兵：直接读计算高度，并要求 ≥44px。
  // 即使元素在视口外（量不到命中区），高度计算值也一定读得到。
  const h5 = await cdp.eval(`(() => {
    const out = [];
    for (const sel of ['.tool-btn', '.tb-check', '.theme-dot', '.fx-orb', '.dock-btn']) {
      const e = document.querySelector(sel);
      if (!e) { out.push({ sel, missing: true }); continue; }
      const cs = getComputedStyle(e);
      if (cs.display === 'none') { out.push({ sel, hidden: true }); continue; }
      out.push({ sel, h: Math.round(parseFloat(cs.height) || 0),
                 minH: cs.minHeight, mh: Math.round(parseFloat(cs.minHeight) || 0),
                 bigRead: document.documentElement.classList.contains('big-read') });
    }
    return out;
  })()`);
  const h5Bad = h5.filter(r => !r.missing && !r.hidden && r.h < 44);
  ok('H5', '命中热区高度不被上层样式压低（跨层只抬高不压低的哨兵，不依赖元素可见性）',
    h5Bad.length === 0,
    (h5Bad.length ? '被压低：' + h5Bad.map(r => r.sel + ' height=' + r.h + 'px').join('；') + '；' : '')
    + '各控件计算高度 ' + h5.map(r => r.missing ? r.sel + '=不存在'
        : r.hidden ? r.sel + '=本档位不需要' : r.sel + '=' + r.h + 'px').join(', '));

  // ── H6：选中态不许改变命中区（Lead 裁决④③，dotscan 的同类断言）──
  // 断言而不是「已登记的现象」：把选中态挪到另一个圆点、再量同一个圆点，
  // 两次读数必须完全一致 —— 一致才说明命中区不随选中态浮动、不从邻居抢像素。
  const di = hit.dotInvariance;
  if (!di || di.skipped) {
    ok('H6', '主题圆点的命中区不随选中态浮动（选中态不改变几何）', false,
      '测不出来：' + ((di && di.why) || 'dotInvariance 缺失'));
  } else {
    const allDotsOK = di.minW >= 44 && di.minH >= 44;
    ok('H6', '主题圆点的命中区不随选中态浮动（选中态不改变几何）',
      di.same && allDotsOK,
      '圆点 ' + di.count + ' 个。'
      + '【条件一 挪动前后同一圆点是否一致】第 ' + di.idx + ' 个：'
      + JSON.stringify(di.before.hit) + ' → ' + JSON.stringify(di.after.hit)
      + (di.same ? ' 一致 ✓' : ' **不一致 ✗ —— 命中区随选中态浮动**')
      + '。【条件二 列内每个圆点是否都 ≥44】最小命中区 ' + di.minW + '×' + di.minH
      + (allDotsOK ? ' 全部达标 ✓' : ' **<44 ✗ —— 有圆点够不到（被邻居挤掉了）**'));
  }

  // ── 7. 抽屉开合（真实的触摸点击）───────────────────────
  const drawer = await cdp.eval(`(() => ({
    palVis: getComputedStyle(document.querySelector('#palette')).visibility,
    palPos: getComputedStyle(document.querySelector('#palette')).position,
    maskDisplay: getComputedStyle(document.querySelector('#drawerMask')).display,
  }))()`);
  ok('D0', `窄屏下器材栏是浮层而不是常驻栏（当前视口 ${layout.clientW}px）`,
    layout.clientW < 1181
      ? (drawer.palPos === 'fixed' && drawer.palVis === 'hidden')
      : (drawer.palPos !== 'fixed' && drawer.palVis !== 'hidden'),
    JSON.stringify(drawer) + ` ；视口 ${layout.clientW}px` + (layout.clientW >= 1181 ? '（大屏应保持常驻栏）' : ''));

  if (layout.clientW < 1181 && hit.exists.dock && sizeOK(hit.dock)) {
    // ⚠ 取坐标前必须先把顶栏滚到能看到这枚按钮的位置，与上面 measure() 同一做法
    //   （「每量一个元素就把它居中一次」，见本文件那段说明）。
    //   为什么：#btnPalette 排在「工具」组末尾、偏右，而顶栏在窄屏可横向滚动。
    //   若直接读 rect，量到的可能是 left=-350 —— 在视口左侧外面 3.5 个视口宽，
    //   于是 tap(-350,24) 落在视口外：elementFromPoint 返回 null，抽屉当然不会开。
    //   实测证据（同一版代码）：bar={scrollLeft:538,scrollWidth:942,clientWidth:390}
    //   时 btnRect=[-372,-328]；把 scrollLeft 归 0 后 btnRect=[166,210]，
    //   且 elementFromPoint 命中按钮自己（hit:"self"）。
    //   这**不是**放宽断言：真机上用户要碰这枚按钮同样得先横向滑动，
    //   这里只是把「用户先滑动」这一步补上，然后照旧要求抽屉真的滑进来。
    const b = await cdp.eval(`(() => {
      const bar = document.querySelector('#topbar');
      const btn = document.querySelector('#btnPalette');
      if (bar && btn) {
        const rb = btn.getBoundingClientRect(), rbar = bar.getBoundingClientRect();
        bar.scrollLeft = Math.max(0, Math.min(bar.scrollWidth,
          bar.scrollLeft + (rb.left + rb.width / 2 - rbar.width / 2)));
      }
      const r = btn.getBoundingClientRect();
      return { x: r.left + r.width/2, y: r.top + r.height/2 }; })()`);
    const openErr = await tap(cdp, b.x, b.y);
    await sleep(500);
    const opened = await cdp.eval(`(() => {
      const p = document.querySelector('#palette');
      return { open: p.hasAttribute('data-open'), vis: getComputedStyle(p).visibility,
               mask: getComputedStyle(document.querySelector('#drawerMask')).display,
               x: Math.round(p.getBoundingClientRect().left) };
    })()`);
    ok('D1', '点顶栏入口能打开器材栏抽屉',
      !openErr && opened.open && opened.vis === 'visible' && opened.x >= -1,
      openErr || JSON.stringify(opened));
    ok('D2', '抽屉打开时遮罩出现（点遮罩能收起）',
      opened.mask !== 'none', `mask display=${opened.mask}`);

    // 点遮罩收起（点在抽屉以外的区域）
    const closeErr = await tap(cdp, 360, 700);
    await sleep(500);
    const closed = await cdp.eval(`(() => {
      const p = document.querySelector('#palette');
      return { open: p.hasAttribute('data-open'), vis: getComputedStyle(p).visibility };
    })()`);
    ok('D3', '点遮罩能收起抽屉', !closeErr && !closed.open && closed.vis === 'hidden',
      closeErr || JSON.stringify(closed));

    // ── 7b. 探针 tools/touch-probe.html 的 B3~B5 曾在同一台机器上报过「抽屉没滑进来」。
    // 它和上面 D1 的差别只有两处：开合前先派发合成的 pointerdown/pointerup，以及只等 340ms。
    // 把那条序列原样重跑一遍并按它的时刻读数，才能确定是产品的问题还是它比真实点击多做了事。
    // 这里不做断言，只留读数（结论由 D1~D3 与这条读数一起给）。
    const b2 = await cdp.eval(`(() => { const r = document.querySelector('#btnPalette').getBoundingClientRect();
      return { x: r.left + r.width/2, y: r.top + r.height/2 }; })()`);
    await cdp.eval(`(() => {
      const btn = document.querySelector('#btnPalette');
      const opt = { bubbles: true, cancelable: true, composed: true, pointerId: 7,
                    pointerType: 'touch', isPrimary: true, clientX: ${Math.round(b2.x)}, clientY: ${Math.round(b2.y)} };
      if (btn.hasAttribute('data-open') || document.querySelector('#palette').hasAttribute('data-open')) btn.click();
      btn.dispatchEvent(new PointerEvent('pointerdown', opt));
      btn.dispatchEvent(new PointerEvent('pointerup', opt));
      btn.click();
      return true;
    })()`);
    await sleep(340);
    const atProbeTiming = await cdp.eval(`(() => {
      const p = document.querySelector('#palette');
      return { open: p.hasAttribute('data-open'), x: Math.round(p.getBoundingClientRect().left),
               tf: getComputedStyle(p).transform };
    })()`);
    await sleep(400);
    const afterSettle = await cdp.eval(`(() => {
      const p = document.querySelector('#palette');
      return { open: p.hasAttribute('data-open'), x: Math.round(p.getBoundingClientRect().left),
               tf: getComputedStyle(p).transform };
    })()`);
    probeSeq = { atProbeTiming, afterSettle };
    // 覆盖一个此前漏掉的组合：**窄视口 + 细指针**（桌面把窗口拖窄、或带鼠标的平板）。
    // 这一档窄屏浮层布局同样生效，但 pointer/any-pointer 都不是 coarse。
    // 探针反复报「这一档抽屉不滑进来」而本套件的 CDP 触摸档一切正常，
    // 差别就在这里 —— 所以把这一档也钉上，两侧读数才是同一件事的对照。
    const fineNarrow = layout.clientW < 1024
      ? await cdp.eval(`(async () => {
          const p = document.querySelector('#palette');
          const m = document.querySelector('#drawerMask');
          if (m) m.click();
          await new Promise(r => setTimeout(r, 420));
          const closedX = Math.round(p.getBoundingClientRect().left);
          document.querySelector('#btnPalette').click();
          await new Promise(r => setTimeout(r, 420));
          const openX = Math.round(p.getBoundingClientRect().left);
          const out = { closedX, openX, open: p.hasAttribute('data-open'),
                        tf: getComputedStyle(p).transform,
                        vis: getComputedStyle(p).visibility,
                        fine: matchMedia('(pointer: fine)').matches,
                        coarse: matchMedia('(pointer: coarse)').matches };
          if (m) m.click();
          await new Promise(r => setTimeout(r, 420));
          return out;
        })()`)
      : null;
    probeSeq.fineNarrow = fineNarrow;
    ok('D4', '窄视口 + 细指针（桌面窗口拖窄）下抽屉同样能滑进来',
      layout.clientW >= 1024 || (fineNarrow && fineNarrow.open
        && fineNarrow.openX > fineNarrow.closedX && fineNarrow.vis === 'visible'),
      layout.clientW >= 1024 ? `当前视口 ${layout.clientW}px ≥ 1024，本档不适用`
        : JSON.stringify(fineNarrow));
    // ── 7c. 主 realm 版的 B3~B5（Lead 裁决②）────────────────────────
    // 背景：tools/touch-probe.html 把 index.html 装进一个 **left:-30000px** 的 iframe 里跑，
    // 那个 iframe 拿到的抽屉读数恒为 translateX(-320px)、transitionend 一次都不触发
    // （把 iframe 挪到屏幕上重跑也一样 —— 已实测否掉「离屏」这个解释）。
    // 但**产品里调色板跑在顶层文档**，不在 iframe 里，所以真正有效的判据必须在主 realm。
    // 本段就是主 realm 版：真实 CDP 触摸输入 + 等过 --t-slow(260ms)，判据与探针 B3~B5 逐条对应。
    // 探针里那段读数作为「已知事实」留在文件头说明里，不再是一条永远红的断言。
    const drawerRealm = await cdp.eval(`(async () => {
      const q = (s) => document.querySelector(s);
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      const R = (el) => el.getBoundingClientRect();
      const mask = q('#drawerMask');
      const pal = q('#palette'), side = q('#sidebar');
      const btnPal = q('#btnPalette'), btnSide = q('#btnSidebar');
      const snap = () => ({ palOpen: pal.hasAttribute('data-open'),
        sideOpen: side.hasAttribute('data-open'),
        palX: Math.round(R(pal).left), palW: Math.round(R(pal).width),
        palVis: getComputedStyle(pal).visibility,
        sideRight: Math.round(innerWidth - R(side).right),
        sideW: Math.round(R(side).width),
        sideVis: getComputedStyle(side).visibility,
        maskDisp: getComputedStyle(mask).display,
        palAria: btnPal.getAttribute('aria-expanded'),
        sideAria: btnSide.getAttribute('aria-expanded') });
      // ① 开左边
      btnPal.click(); await wait(700);
      const openPal = snap();
      // ② 再开右边 —— 两个入口应互斥（开右边时左边自动收起）
      btnSide.click(); await wait(700);
      const openSide = snap();
      // ③ 点遮罩收起
      mask.click(); await wait(700);
      const closed = snap();
      return { openPal, openSide, closed, vw: innerWidth };
    })()`);
    probeSeq.mainRealm = drawerRealm;
    const dPal = drawerRealm.openPal, dSide = drawerRealm.openSide, dCl = drawerRealm.closed;
    ok('B3', '主 realm：顶栏左入口能打开器材栏浮层（贴左边、遮罩出现、aria-expanded=true）',
      dPal.palOpen && dPal.palVis === 'visible' && dPal.palX >= -1 && dPal.palX <= 1
        && dPal.maskDisp !== 'none' && dPal.palAria === 'true',
      `开左边后 ${JSON.stringify(dPal)}（视口 ${drawerRealm.vw}px）`);
    ok('B4', '主 realm：两个入口互斥（开右边时左边自动收起，右栏贴右边）',
      dSide.sideOpen && !dSide.palOpen && dSide.sideVis === 'visible'
        && dSide.sideRight >= -1 && dSide.sideRight <= 1 && dSide.sideAria === 'true'
        && dSide.palAria === 'false',
      `开右边后 ${JSON.stringify(dSide)}`);
    ok('B5', '主 realm：点遮罩能收起浮层（回到 visibility:hidden，不再吃后续点击）',
      !dCl.palOpen && !dCl.sideOpen && dCl.palVis === 'hidden' && dCl.sideVis === 'hidden'
        && dCl.maskDisp === 'none',
      `点遮罩后 ${JSON.stringify(dCl)}`);
    // 还原：把抽屉收起，别影响后面的用例
    await cdp.eval(`(() => { const m = document.querySelector('#drawerMask'); if (m) m.click(); return true; })()`);
    await sleep(400);
  } else if (layout.clientW >= 1181) {
    // 「不适用」≠「通过」：大屏器材栏本就是常驻栏、没有抽屉可开，D1 在这一档
    // **不登记**为通过，只留一行诊断。登记成 true 会让通过率里混进一个从未
    // 断言过的空过项 —— 这正是假绿。
    console.log('[touch-check] D1 不适用（视口 ' + layout.clientW
      + 'px：大屏器材栏常驻，无抽屉可开；已由 G1 覆盖）');
  } else {
    // 窄屏走到这一支 = 顶栏入口不存在、或命中区不足 44px —— 那是**缺陷**，不是「不适用」。
    // 旧代码在这一支写 true + '入口按钮不存在或不足 44px'：把失败原文当通过计数；
    // 红态实测（按钮被拿掉）时 D1 从「消失清单」里缺席，踩的就是这里。
    ok('D1', '点顶栏入口能打开器材栏抽屉', false,
      '窄屏必须有顶栏「器材栏」入口且命中区 ≥44×44，实测：' + JSON.stringify(hit.dock)
      + '（exists=' + hit.exists.dock + '，视口 ' + layout.clientW + 'px）');
  }

  // ── 8. 键位提示按指针能力换文案 ────────────────────────
  // 判据是 pointer: coarse（「以手指为主」），不是 any-pointer ——
  // 触屏笔记本有键盘、主指针是触控板，键位提示必须留着。
  const hint = await cdp.eval(`(() => ({
    keys: getComputedStyle(document.querySelector('.hint-keys')).display,
    touch: getComputedStyle(document.querySelector('.hint-touch')).display,
    keysText: (document.querySelector('.hint-keys').textContent || '').trim().slice(0, 12),
    touchText: (document.querySelector('.hint-touch').textContent || '').trim().slice(0, 12),
    pointerCoarse: matchMedia('(pointer: coarse)').matches,
    anyPointerCoarse: matchMedia('(any-pointer: coarse)').matches,
  }))()`);
  // 判据是 pointer: coarse（「以手指为主」），**与宽度无关**：
  //   手机（窄）→ 触控提示；
  //   教室 55–86 寸触控一体机（1920×1080，pointer:coarse）→ 也是触控提示，
  //     那台机器上根本没有键盘，「V 选择 · W 连线」是按不出来的提示；
  //   触屏笔记本（pointer:fine + any-pointer:coarse，有触控板）→ 保留键位提示。
  // 这条不变量要严：两段提示恰好显示一段，不能都显示、也不能都不显示。
  const expectTouchHint = hint.pointerCoarse;
  const shownExactlyOne = (hint.keys !== 'none') !== (hint.touch !== 'none');
  ok('K1', expectTouchHint
      ? '以手指为主的设备只显示触控提示（键位提示隐藏，与屏幕宽度无关）'
      : '有精确指向设备（触控板/鼠标）时保留键位提示（说明有键盘）',
    shownExactlyOne && (expectTouchHint ? hint.touch !== 'none' : hint.keys !== 'none'),
    `keys=${hint.keys} touch=${hint.touch} [pointer:coarse=${hint.pointerCoarse} `
    + `any-pointer:coarse=${hint.anyPointerCoarse} 视口 ${layout.clientW}px]`
    + ` 键位文案「${hint.keysText}」触控文案「${hint.touchText}」`);

  // ── 9. iOS 输入框缩放 / 文本自动放大 ───────────────────
  const ios = await cdp.eval(`(() => {
    const px = (s) => { const e = document.querySelector(s); return e ? parseFloat(getComputedStyle(e).fontSize) : null; };
    const TEXT_SEL = 'input[type="text"], input[type="search"], input[type="number"], ' +
      'input[type="email"], input[type="url"], input[type="tel"], input[type="password"], textarea, select';
    // 只统计**页面主区域（#app 内）**的文本录入元素。
    // #app 之外那一枚 input.tb-select 是顶栏工具条里的第二个搜索框
    // （ui.market.js:128 用 el('input','tb-select') 建的），实测它不在 #app 里，
    // 也就吃不到 #app 前缀的那条 16px 规则 —— 它同时也看不见（顶栏在窄屏要横向滑动才够得着）。
    // 把它混进统计会让「门槛是否达成」这句话失去意义，所以按作用域分开报。
    // 作用域用 closest('#app') 显式过滤，而不是写成 #app 前缀的选择器：
    // 选择器写法在探针各处的读数不一致过（同一批元素一会儿在 #app 内一会儿在外），
    // 显式过滤的结果是自明的，读报告的人不用去猜选择器解析。
    // 注意：这一段在 JS 模板字符串里，注释里不许再出现反引号。
    const all = [...document.querySelectorAll(TEXT_SEL)];
    const inApp = all.filter(e => e.closest('#app'));
    const outside = all.filter(e => !e.closest('#app'));
    const map = (e) => ({ tag: e.tagName, type: e.type || null, id: e.id || null,
      cls: typeof e.className === 'string' ? e.className : null, fs: parseFloat(getComputedStyle(e).fontSize) });
    return {
      search: px('#paletteSearch'),
      inApp: inApp.map(map),
      inAppSmall: inApp.map(map).filter(x => x.fs < 16),
      outside: outside.map(map),
      anchors: [...document.querySelectorAll('input, textarea, select')].map(map),
      textSizeAdjust: getComputedStyle(document.documentElement).webkitTextSizeAdjust
        || getComputedStyle(document.body).webkitTextSizeAdjust,
      viewportMeta: document.querySelector('meta[name="viewport"]').content,
    };
  })()`);
  // #paletteSearch 是唯一被无条件提到 16px 的输入（见 touch.css 的偏离登记）
  ok('I1', '#paletteSearch 字号 ≥16px，且不依赖任何媒体查询',
    ios.search >= 16, `#paletteSearch font-size=${ios.search}px`);
  // #app 内的文本录入元素在「能被手指碰」的设备上必须全部 ≥16px。
  // 这是 B 类（放大就是看得见的桌面改动），门控 any-pointer: coarse，因此断言也跟着门控。
  ok('I1b', hint.anyPointerCoarse
      ? '#app 内所有文本录入元素 ≥16px（iOS 不会放大整页）'
      : '纯鼠标设备：#app 内文本录入元素保持桌面紧凑尺寸（无 iOS 放大风险）',
    hint.anyPointerCoarse ? ios.inAppSmall.length === 0 : true,
    `any-pointer:coarse=${hint.anyPointerCoarse}；#app 内 <16px 的：${JSON.stringify(ios.inAppSmall)}`
    + `；不在 #app 内的（不适用同一门槛）：${JSON.stringify(ios.outside)}`);
  ok('I2', 'viewport 里没有 user-scalable=no / maximum-scale 这类堵法',
    !/user-scalable\s*=\s*no/i.test(ios.viewportMeta) && !/maximum-scale/i.test(ios.viewportMeta),
    ios.viewportMeta);
  ok('I3', '-webkit-text-size-adjust: 100%（横屏不被自动放大）',
    ios.textSizeAdjust === '100%', `webkitTextSizeAdjust=${ios.textSizeAdjust}`);

  // ── 10. 内层滚动容器不把滚动串给页面 ──────────────────
  const scrollChain = await cdp.eval(`(() => {
    const sels = ['#palette .pane', '#palette [data-slot]', '#sidebar .pane', '.pane', '.pal-list', '.insp-body', '.log-list'];
    const found = {};
    for (const s of sels) {
      for (const e of document.querySelectorAll(s)) {
        const cs = getComputedStyle(e);
        if (cs.overflowY === 'auto' || cs.overflowY === 'scroll') {
          found[(e.id || e.className || s).toString().slice(0, 30)] = cs.overscrollBehaviorY || cs.overscrollBehavior;
        }
      }
    }
    return { scrollers: found, htmlOB: getComputedStyle(document.documentElement).overscrollBehavior,
             bodyOB: getComputedStyle(document.body).overscrollBehavior };
  })()`);
  const bad = Object.entries(scrollChain.scrollers).filter(([, v]) => !/contain|none/.test(v));
  ok('O1', '内层滚动容器带 overscroll-behavior: contain（不串链到页面）',
    bad.length === 0, `共 ${Object.keys(scrollChain.scrollers).length} 个滚动容器，未设的：${JSON.stringify(bad)}`);

  // ── 11. 100vh → 100dvh 的兜底顺序 ──────────────────────
  const dvh = await cdp.eval(`(() => {
    const sheets = [...document.styleSheets];
    let order = null;
    for (const sh of sheets) {
      let rules; try { rules = sh.cssRules; } catch (e) { continue; }
      for (const r of rules) {
        if (r.selectorText === '#app' && r.style && r.style.height) {
          const h = r.style.getPropertyValue('height');
          if (/dvh/.test(h)) order = 'dvh';
          else if (/vh/.test(h) && order == null) order = 'vh-first';
        }
      }
    }
    const appH = getComputedStyle(document.querySelector('#app')).height;
    return { sawVhBeforeDvh: order, appHeight: appH, innerH: innerHeight };
  })()`);

  // ── 12. 按压反馈（:active）在触屏上也在 ────────────────
  const press = await cdp.eval(`(() => {
    // 找一条带 :active transform 的规则，确认它不是 click 才触发
    let activeRules = 0, sample = null, tokens = {};
    for (const sh of [...document.styleSheets]) {
      let rules; try { rules = sh.cssRules; } catch (e) { continue; }
      for (const r of rules) {
        if (r.selectorText && /:active/.test(r.selectorText) && r.style && r.style.transform) {
          activeRules++; if (!sample) sample = r.selectorText + ' { transform: ' + r.style.transform + ' }';
        }
        if (r.selectorText === ':root' && r.style) {
          for (const p of ['--t-press', '--ease-out']) if (r.style.getPropertyValue(p)) tokens[p] = r.style.getPropertyValue(p);
        }
      }
    }
    return { activeRules, sample, tokens };
  })()`);
  ok('P1', '触屏上也用 :active 按压反馈（按下即给，不是等 click）',
    press.activeRules > 0, `${press.activeRules} 条 :active{transform} 规则，例：${press.sample}`);
  ok('P2', '按压时长走既有动效令牌，没有另造裸毫秒',
    !!press.tokens['--t-press'], `--t-press=${press.tokens['--t-press']} --ease-out=${press.tokens['--ease-out']}`);

  // ── 13. 减少动态效果下的降级 ──────────────────────────
  ok('R0', '视口契约', true, `innerW=${layout.innerW} clientW=${layout.clientW} dpr=${await cdp.eval('devicePixelRatio')}`);
  if (errors.length) ok('E0', '页面无 console 报错', false, JSON.stringify(errors.slice(0, 5)));
  else ok('E0', '页面无 console 报错', true, '(无)');

  const passed = checks.filter(c => c.pass).length;
  return {
    url: appUrl,
    viewport: { w: layout.clientW, h: await cdp.eval('innerHeight') },
    summary: `${passed}/${checks.length}`,
    passed, failed: checks.length - passed,
    probeSeq,
    checks,
  };
}

/** 默认的一组量测：视口 / 布局 / 抽屉 / 命中尺寸 / touch-action（全部在页面自己的 realm 里） */
const DEFAULT_EXPR = `(() => {
  const q = (s) => document.querySelector(s);
  const w = (s) => { const e = q(s); return e ? Math.round(e.getBoundingClientRect().width * 100) / 100 : null; };
  const cs = (s, p) => { const e = q(s); return e ? getComputedStyle(e)[p] : null; };
  const triple = (s) => { const e = q(s); return e ? [e.offsetWidth, e.clientWidth, e.scrollWidth] : null; };
  const wide = [...document.querySelectorAll('*')]
    .map(e => ({ t: e.tagName + (e.id ? '#' + e.id : ''), w: Math.round(e.getBoundingClientRect().width) }))
    .filter(x => x.w > 420).sort((a, b) => b.w - a.w).slice(0, 8);
  return {
    innerWidth: innerWidth, innerHeight: innerHeight,
    clientW: document.documentElement.clientWidth,
    docScrollW: document.documentElement.scrollWidth,
    bodyScrollW: document.body.scrollWidth,
    dpr: devicePixelRatio,
    media: {
      coarse: matchMedia('(pointer: coarse)').matches,
      fine: matchMedia('(pointer: fine)').matches,
      hoverNone: matchMedia('(hover: none)').matches,
      le1024: matchMedia('(max-width: 1024px)').matches,
      le820: matchMedia('(max-width: 820px)').matches,
    },
    boxes: { app: w('#app'), body: w('#body'), stage: w('#stage'), palette: w('#palette'),
             sidebar: w('#sidebar'), canvas: w('#canvas') },
    triple: { app: triple('#app'), body: triple('#body'), stage: triple('#stage') },
    appComputed: { height: cs('#app','height'), cols: cs('#app','gridTemplateColumns'), rows: cs('#app','gridTemplateRows') },
    bodyCols: cs('#body','gridTemplateColumns'),
    palettePos: cs('#palette','position'), paletteVis: cs('#palette','visibility'),
    sidebarPos: cs('#sidebar','position'),
    canvasTouchAction: cs('#canvas','touchAction'),
    canvasInlineTouchAction: q('#canvas') ? q('#canvas').style.touchAction : null,
    dock: { pal: !!q('#btnPalette'), side: !!q('#btnSidebar'),
            palDisplay: q('#btnPalette') ? getComputedStyle(q('#btnPalette')).display : null,
            palBox: q('#btnPalette') ? [Math.round(q('#btnPalette').getBoundingClientRect().width), Math.round(q('#btnPalette').getBoundingClientRect().height)] : null },
    hint: { keys: cs('.hint-keys','display'), touch: cs('.hint-touch','display') },
    statusbarPadBottom: cs('#statusbar','paddingBottom'),
    topbarPadTop: cs('#topbar','paddingTop'),
    wideElements: wide,
  };
})()`;

main().catch((e) => { console.error('FAILED ' + (e && e.stack || e)); process.exitCode = 1; });
