/**
 * dotscan —— 逐个检查「主题配色圆点」这一列的真实可命中范围。
 *
 * 为什么单独有一个工具（而不是并进 tools/hitscan.mjs）：
 *   hitscan 按「选择器取第一个匹配」采样，而 .theme-dot 有 3 个：
 *   三个圆点是一列、间距靠 margin 压出来，**彼此可能重叠**，
 *   重叠区的像素归属由浏览器决定 —— 也就是说「第一个圆点多大」代表不了另外两个。
 *   本工具第一次跑就量出了这个缺陷：
 *     圆点 0 = 1×23px、圆点 1 = 1×23px、圆点 2 = 44×44px
 *   根因是 touch.css 给圆点写了 `margin: -14px 0`（想让 6px 列间距「吃掉一半」），
 *   44px 的盒子因此只占 16px 排版高度，相邻圆点重叠 28px，只有最后一个拿到完整命中区
 *   —— 三个圆点里两个基本按不到。修法是 margin:0 + gap:0，让盒子首尾相接。
 *   修复后本工具的输出是 44×44 / 44×44 / 44×44。
 *
 * 用法：
 *   node tools/dotscan.mjs [URL] [宽] [高]
 *     node tools/dotscan.mjs                       # 默认 390×844（手机档，触摸模拟）
 *     node tools/dotscan.mjs http://127.0.0.1:7373/index.html 1936 1018
 *   node tools/dotscan.mjs [URL] [宽] [高] --sel <选择器>   # 整矩形逐像素覆盖扫描
 *     node tools/dotscan.mjs http://127.0.0.1:7373/index.html 1920 1080 --sel .fx-orb
 *
 * --sel 与默认模式的关系（task-34 追加，两种结果都只是读数、不改任何东西）：
 *   默认模式 = 中心点向外步进（单点采样，hitscan 也一样）；
 *   --sel     = 对 rect 覆盖的**每个整数像素**调 elementFromPoint，数有多少像素命中。
 *   全域采样严格强于单点采样，所以 `--sel` 是判据升级，不是「换算法以便通过」：
 *   同一个元素若两者不一致，**以 --sel 为准**，并按上面的口径去查为什么单点会偏。
 *
 * 输出（一行 JSON）：
 *   默认模式：colRect / colPE / dots[]（i / cls / rect / margin / z / pe / centerHit / realHit）
 *             centerHit 是「中心点上最顶层的元素」，用来区分
 *             「命中区小」和「中心点被别的元素压住」这两种不同的坏法。
 *   --sel  ：sel / offscreen / viewport / rect / intRect / rectArea / covered / coverage
 *             / hitW / hitH / cssHeight / cssMinHeight / boxSizing / centerCoords
 *             / missSample（没命中的前 6 个像素及其命中者）/ chain（祖先链的 z/pos/pe/ov）
 *
 * 前提：本地静态服务要在跑（默认 7373）。自起无头 Edge，临时 profile 用完即删。
 * 需要 Node 24+（内置 WebSocket / fetch）。
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// 清理诊断的判定器（D53：按 --user-data-dir 归组、实例非进程、只读进程表）
import { checkCleanup } from './browser-instances.mjs';

const EDGE = process.env.EDGE_PATH
  || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
if (!existsSync(EDGE)) throw new Error('找不到 Edge：' + EDGE + '（可用环境变量 EDGE_PATH 指定）');

const APP = process.argv[2] || 'http://127.0.0.1:7373/index.html';
const W = Number(process.argv[3] || 390);
const H = Number(process.argv[4] || 844);
/**
 * --sel <选择器>：对**任意**元素做整矩形逐像素覆盖扫描（task-34 追加）。
 *
 * 为什么要有它（不能只靠 hitscan 的「中心点向外步进」）：
 *   中心点步进是**单点采样**：它先算一个中心点，再沿四个方向一条线地走。
 *   当元素的中心恰好落在**小数边界**上时（本仓库真实发生过：同一个 .fx-orb，
 *   两个探针用 `Math.round(top + height/2)` 分别算出 cy=84 与 cy=85），
 *   两条采样线会落在不同的整数行上，于是同一个元素量出 43 与 44 两个值。
 *   本项扫描把判据换成「该元素矩形内**有多少像素**真正命中它」——
 *   单点采样是全域采样的特例，全域严格更强，所以这不是「换算法以便通过」，
 *   而是把判据升级到不依赖那一个采样点。
 *
 * 口径：对 rect 覆盖的每个整数像素 (x, y) 调 elementFromPoint，
 *   命中自己或自己的后代即算「这个像素点得到」。
 * 输出：rect / rectArea / covered / coverage(0~1) / hitW / hitH / rowsHit / colsHit
 *   hitW = 得到过的不同 x 列数，hitH = 得到过的不同 y 行数（即真实可命中的外接矩形）
 */
const SEL_IDX = process.argv.indexOf('--sel');
const SEL = SEL_IDX >= 0 ? process.argv[SEL_IDX + 1] : null;
const OUTSIDE = SEL_IDX >= 0;   // 带 --sel 时只输出该元素的矩形扫描，不输出圆点矩阵
/**
 * 触摸模拟开关：与 tools/hitscan.mjs 的第 5 个参数同义（touch 默认 / fine 关闭）。
 * 为什么必须补上它：本工具原来**无条件**打开触摸模拟，于是 (pointer:coarse) 恒为真，
 * 量 1920×1080 时也会命中「粗指针」那套规则 —— 同一个 .fx-orb 在这里读到 44×52、
 * 而 hitscan 传 fine 读到 38×45。那不是页面有两种行为，是**两个工具开关不一致**。
 * ⚠ 取值不能直接用 argv[5]：加了 `--sel <选择器>` 之后，argv[5] 是 **--sel 的值**，
 *   `fine` 被挤到了 argv[6] —— 第一版就是这么错的（传了 fine 仍读到粗指针）。
 *   所以这里**跳过所有以 - 开头的参数及其取值**，只认「第 5 个纯位置参数」。
 */
const POS = (() => {
  const out = [];
  for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i].startsWith('-')) { i++; continue; }   // 跳过 flag 及其取值
    out.push(process.argv[i]);
  }
  return out;   // [URL, 宽, 高, touch|fine]
})();
const touch = (POS[3] || 'touch') !== 'fine';
const url = APP + (APP.includes('?') ? '&' : '?') + 'cb=' + Math.random().toString(36).slice(2, 10);

const prof = mkdtempSync(join(tmpdir(), 'dotscan-'));
/**
 * 端口必须**宽**取：原来是 9900 + random*90（只有 90 个候选），与平行跑的
 * task-27/task-26 探针、以及别的 dotscan 一起抢同一个端口是常事。
 * 端口被占时 Edge 的 DevTools 起不来，而 wsUrl() 会连上**那台已经在监听的浏览器**
 * —— 于是量到的是**别人那份模拟设置**下的页面：实测 (pointer:coarse) 恒为 true、
 * 明明传了 fine 还是读到粗指针那套规则（.fx-orb 44×52 而不是 38×45）。
 * 取 2000 个候选，冲突概率降一个数量级，并且与 hitscan 的做法一致。
 */
const port = 9300 + Math.floor(Math.random() * 2000);
const child = spawn(EDGE, ['--headless=new', '--mute-audio', '--disable-gpu', '--no-first-run',
  `--user-data-dir=${prof}`, `--remote-debugging-port=${port}`, `--window-size=${W},${H}`,
  'about:blank'], { stdio: 'ignore' });

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function wsUrl() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = list.find(t => t.type === 'page');
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
  async eval(expression) {
    const r = await this.send('Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    }
    return r.result.value;
  }
}

const RECT_EXPR = (sel) => `(() => {
  const el = document.querySelector(${JSON.stringify(sel)});
  if (!el) return { missing: true };
  // .drawer-x 藏在未打开的抽屉里，不打开就量到 0×0（空白页）。只在这一个选择器上
  // 临时加类名打开，量完立刻还原 —— 不给页面留痕迹，也不去点真实入口（那会引入时序）。
  const restore = (() => {
    if (!/\\.drawer-x/.test(${JSON.stringify(sel)})) return () => {};
    const x = document.querySelector('.drawer-x');
    if (!x) return () => {};
    const m = x.closest('.drawer-mask') || x.parentElement;
    if (!m) return () => {};
    const had = { show: m.classList.contains('show'), in: m.classList.contains('in') };
    m.classList.add('show'); m.classList.add('in');
    return () => { if (!had.show) m.classList.remove('show'); if (!had.in) m.classList.remove('in'); };
  })();
  const r = el.getBoundingClientRect();
  const owns = (hit) => !!hit && (hit === el || el.contains(hit));
  const x0 = Math.max(0, Math.floor(r.left)), x1 = Math.min(innerWidth - 1, Math.ceil(r.right) - 1);
  const y0 = Math.max(0, Math.floor(r.top)), y1 = Math.min(innerHeight - 1, Math.ceil(r.bottom) - 1);
  let covered = 0, area = 0;
  const cols = new Set(), rows = new Set();
  const missSample = [];
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      area++;
      if (owns(document.elementFromPoint(x, y))) { covered++; cols.add(x); rows.add(y); }
      else if (missSample.length < 6) {
        const h = document.elementFromPoint(x, y);
        missSample.push({ x, y, hit: h ? (h.tagName + '.' + (h.className || '')) : '(null)' });
      }
    }
  }
  // 完全落在视口外时 area 会是 0，此时必须显式说明，不能报 0/0 让人误读成「一个像素都没有」
  const offscreen = r.right <= 0 || r.bottom <= 0 || r.left >= innerWidth || r.top >= innerHeight;
  const cs = getComputedStyle(el);
  const chain = [];
  for (let e = el; e && chain.length < 8; e = e.parentElement) {
    const c = getComputedStyle(e);
    chain.push({ sel: (e.id ? '#' + e.id : '') + (typeof e.className === 'string' && e.className ? '.' + e.className.trim().split(/\\s+/).join('.') : ''),
                 z: c.zIndex, pos: c.position, pe: c.pointerEvents, ov: c.overflow });
  }
  const out = {
    sel: ${JSON.stringify(sel)},
    offscreen, viewport: [innerWidth, innerHeight],
    mq: { coarse: matchMedia('(pointer: coarse)').matches,
          anyCoarse: matchMedia('(any-pointer: coarse)').matches,
          hover: matchMedia('(hover: hover)').matches },
    rect: [Math.round(r.left * 100) / 100, Math.round(r.top * 100) / 100,
           Math.round(r.width * 100) / 100, Math.round(r.height * 100) / 100],
    intRect: [x0, y0, x1, y1],
    rectArea: area, covered, coverage: area ? Math.round(covered / area * 10000) / 10000 : null,
    hitW: cols.size, hitH: rows.size,
    cssHeight: cs.height, cssMinHeight: cs.minHeight, boxSizing: cs.boxSizing,
    centerCoords: [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)],
    missSample, chain,
  };
  restore();          // 量完还原抽屉状态，不留痕迹
  return out;
})()`;

const EXPR = `(() => {
  const dots = [...document.querySelectorAll('.theme-dot')];
  const col = document.querySelector('.theme-dots');
  const who = (x, y) => { const h = document.elementFromPoint(x, y); return h ? (h.tagName + '.' + (h.className || '')) : '(null)'; };
  return {
    colPos: col ? getComputedStyle(col).position : null,
    colPE: col ? getComputedStyle(col).pointerEvents : null,
    colRect: col ? (() => { const r = col.getBoundingClientRect();
      return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]; })() : null,
    dots: dots.map((d, i) => {
      const r = d.getBoundingClientRect();
      const cx = Math.round(r.left + r.width / 2), cy = Math.round(r.top + r.height / 2);
      const cs = getComputedStyle(d);
      const owns = (hit) => !!hit && (hit === d || d.contains(hit));
      const step = (dx, dy) => {
        let n = 0;
        for (let k = 1; k <= 80; k++) {
          if (!owns(document.elementFromPoint(cx + dx * k, cy + dy * k))) break;
          n = k;
        }
        return n;
      };
      return {
        i, cls: d.className,
        rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
        margin: cs.margin, z: cs.zIndex, pe: cs.pointerEvents,
        centerHit: who(cx, cy),
        realHit: { w: step(-1, 0) + step(1, 0) + 1, h: step(0, -1) + step(0, 1) + 1 },
      };
    }),
  };
})()`;

// ⚠ 顶层必须显式 catch，否则退出码会被引擎强制成 1 ✗ —— 本轮实测（三种写法都试过）：
//   ① `process.exitCode = 2; throw` ⇒ exit **1**（未处理的 reject 覆盖 exitCode）
//   ② 同上 + `process.on('unhandledRejection', …)` ⇒ 仍然 exit **1**（该监听器不改变退出码）
//   ③ 顶层 `catch` 里设 exitCode ⇒ exit **2** ✓
//   所以把「起浏览器之后的全部动作」包进一个 async IIFE 并接住它：
//   `finally` 先跑完清理诊断 ✓，再由 catch 把退出码锁在 2（既有契约）✓，
//   同时把失败原因打在 stderr 上便于排查 ✓。
(async () => {
try {
  const cdp = await CDP.open(await wsUrl());
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  if (touch) await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await cdp.send('Emulation.setDeviceMetricsOverride',
    { width: W, height: H, deviceScaleFactor: 1, mobile: false, screenWidth: W, screenHeight: H });
  await cdp.send('Page.navigate', { url });
  let ready = false;
  for (let i = 0; i < 80; i++) {
    try {
      if (await cdp.eval('!!window.xiaomo && document.documentElement.dataset.touchLayer') === 'ready') {
        ready = true; break;
      }
    } catch { /* 导航中 */ }
    await sleep(250);
  }
  await sleep(700);
  if (!ready) {
    // ⚠ 这里**不能**用 `process.exit(2)` ✗✗ —— 本轮实测出来的真缺陷：
    //   process.exit() 是**立即终止**，不会展开调用栈 ⇒ 下面的 `finally` **根本不会执行** ⇒
    //   浏览器实例没人收、`rmSync` 没人跑、清理诊断没人打 —— 而这条恰恰是
    //   **最需要清理诊断**的失败路径（此时浏览器**确实已经起来了**，实测 22s 后仍占着实例）✗。
    //   正确做法：**先置 exitCode 再 throw** —— 控制流走 `finally` ✓，退出码仍是 2 ✓
    //   （直接 throw 会得到 1，等于把既有退出码契约改掉了；显式 exitCode 不会被覆盖）✓
    process.exitCode = 2;
    throw new Error('[dotscan] 20s 内没等到 window.xiaomo + 触控层就绪。'
      + '先确认静态服务在跑（默认 7373）。');
  }
  console.log(JSON.stringify(await cdp.eval(OUTSIDE ? RECT_EXPR(SEL) : EXPR), null, 1));
  cdp.ws.close();
} finally {
  // ⚠ 必须 taskkill /T 连树收掉，不能只 child.kill()：
  //   一个 Edge 实例 = 1 根 + 12 个带 --type= 的子进程（实测），只杀直接子进程 ⇒
  //   子进程树继续占着 profile 目录 ⇒ 下面 rmSync 失败 ⇒ 被 catch 悄悄吞掉 ⇒ **静默残留** ✗✗。
  //   /PID + /T 定位到**本组根进程**：绝不按镜像名杀（会误杀用户自己的 Edge）、
  //   也绝不按调试端口杀（端口可复用，会撞上并发跑手）✗。
  try {
    spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  } catch { /* 已经退出 */ }
  try { child.kill(); } catch { /* 已经退出 */ }
  await sleep(700);
  let deleted = true;
  let delErr = '';
  try { rmSync(prof, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
  catch (e) { deleted = false; delErr = String((e && e.message) || e).slice(0, 120); }
  // 清理诊断：探针删没删干净只有它自己知道，而**失败时恰恰最需要这句话** ✓
  // 判定单位是**实例不是进程**（D53），且「进程清空」与「目录清空」两件事都要报 ✓
  try {
    const inst = await checkCleanup(prof);
    console.error(`[dotscan] 清理诊断：rmSync ${deleted ? '成功' : '失败(' + delErr + ')'}；${inst.text}`);
    if (!inst.cleaned) process.exitCode = 3;
  } catch (e) {
    console.error('[dotscan] 清理诊断：判定器自身异常 ' + String((e && e.message) || e));
  }
}
})().catch((e) => {
  // 顶层捕获：清理已由上面的 finally 跑完；这里只负责把原因说清楚并把退出码锁在 2
  console.error(String((e && e.message) || e));
  process.exitCode = 2;
});
