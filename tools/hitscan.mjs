/**
 * hitscan —— 逐像素测「真实可命中范围」的命令行工具。
 *
 * 为什么需要它（而不是「盒子尺寸 + 伪元素外扩」那种算术）：
 *   命中盒不能靠算。伪元素为了不挡住宿主必须写 pointer-events:none，
 *   而带这个属性的盒子对命中测试是**完全透明**的 —— 那圈「外扩」一个像素都点不到。
 *   本工具第一次跑就把这个坑量出来了：
 *     · .tool-btn  盒子 32×32，算术「命中 44×44」，逐像素实测只有 32×33
 *     · .tb-check  盒子 79×32，算术「命中 ≥44」，逐像素实测只有 79×33
 *     · .dock-btn  盒子 44×44，伪元素再扩 4px「命中 52×52」，实测就是 44×45
 *   也就是三处「注释写着已达标、实测没达标」。唯一的真相来源是 elementFromPoint。
 *
 * 用法：
 *   node tools/hitscan.mjs [URL] [宽] [高] [touch|fine]
 *
 *   例：
 *     node tools/hitscan.mjs                                  # 默认 390×844 触摸（手机档）
 *     node tools/hitscan.mjs http://127.0.0.1:7373/index.html 1936 1018 touch
 *     node tools/hitscan.mjs http://127.0.0.1:7373/index.html 1280 820 fine
 *
 *   参数：
 *     URL    默认 http://127.0.0.1:7373/index.html?cb=<随机>（自动加 cache-buster）
 *     宽 高  默认 390 844
 *     touch  默认（开触摸模拟）；传 fine 关闭触摸模拟
 *
 * 输出（一行 JSON）：viewport / mq / out
 *   mq         pointer:coarse 与 any-pointer:coarse 的实测值
 *   out[键]    rect       CSS 盒子 [x, y, w, h]
 *              realHit    真实可命中 {w, h}
 *              edges      从上/下/左/右各能走几像素（用于看是哪一边被接走了）
 *              vis         视觉盒（与 rect 同，保留字段名兼容）
 *              blockers    四条边外一格是谁：定位「被谁接走了」用
 *              offscreen   元素不在视口里（此时 realHit 无意义，只有 rect）
 *
 * 覆盖元素：.fx-orb / .theme-dot / .tool-btn / .tb-check / #btnPalette
 *          / .tb-btn / .tb-select / .drawer-x（task-34 追加的后三个）
 *   顶栏在窄屏是横向可滑动的，右侧控件初始在视口外 —— 本工具会**逐个**把元素
 *   滚到视口中央再量，量完还原顶栏滚动位置（不能统一滑到底再逐个量：
 *   滑动是全局状态，量后面那个时前面那个已经被推出视口了）。
 *
 * 关于 .drawer-x（task-34 追加）：它默认藏在未打开的抽屉里，不打开就量不到。
 *   本工具会**按类名直接把它所在的那张抽屉打开**（加 .show/.in），而不是去点
 *   设置按钮 —— 因为用量工具不该依赖「设置插件是否已装配」，且点按钮会引入
 *   与命中测试无关的时序。打开后量到的才是用户真正会碰到的那块面积。
 *   量完把类名还原，不在页面里留下痕迹。
 *
 * 前提：本地静态服务要在跑（默认 7373）。服务不在时会一直等不到 window.xiaomo。
 * 实现：自起无头 Edge（--headless=new --mute-audio），临时 profile 用完即删，
 *       不在仓库里留任何产物。需要 Node 24+（内置 WebSocket / fetch）。
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

const CB = Math.random().toString(36).slice(2, 10);
const APP = process.argv[2] || 'http://127.0.0.1:7373/index.html';
const W = Number(process.argv[3] || 390);
const H = Number(process.argv[4] || 844);
const touch = (process.argv[5] || 'touch') !== 'fine';
const url = APP + (APP.includes('?') ? '&' : '?') + 'cb=' + CB;

const prof = mkdtempSync(join(tmpdir(), 'hitscan-'));
const port = 9500 + Math.floor(Math.random() * 400);
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

const EXPR = `(() => {
  const q = (s) => document.querySelector(s);
  const owns = (el, hit) => !!hit && (hit === el || el.contains(hit));
  const who = (x, y) => { const h = document.elementFromPoint(x, y); return h ? (h.className || h.tagName) : '(null)'; };
  const inView = (el) => {
    const r = el.getBoundingClientRect();
    return r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight;
  };
  /** 逐个把顶栏里的元素滚到视口中央再量；量完还原滚动位置 */
  const withScroll = (el, fn) => {
    const bar = document.querySelector('#topbar');
    const isInBar = !!(bar && el.closest && el.closest('#topbar'));
    const prev = bar ? bar.scrollLeft : 0;
    if (isInBar) {
      const b = el.getBoundingClientRect();
      const mid = b.left + b.width / 2 - bar.getBoundingClientRect().width / 2;
      bar.scrollLeft = Math.max(0, Math.min(bar.scrollWidth, bar.scrollLeft + mid));
    }
    const out = fn();
    if (isInBar) bar.scrollLeft = prev;
    return out;
  };
  const scan = (el) => withScroll(el, () => {
    const r = el.getBoundingClientRect();
    if (!inView(el)) return { offscreen: true,
      rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] };
    const cx = Math.round(r.left + r.width / 2), cy = Math.round(r.top + r.height / 2);
    const step = (dx, dy) => {
      let n = 0;
      for (let i = 1; i <= 80; i++) {
        if (!owns(el, document.elementFromPoint(cx + dx * i, cy + dy * i))) break;
        n = i;
      }
      return n;
    };
    const up = step(0, -1), down = step(0, 1), left = step(-1, 0), right = step(1, 0);
    return {
      rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
      realHit: { w: left + right + 1, h: up + down + 1 },
      edges: { up, down, left, right },
      blockers: { above: who(cx, Math.round(r.top) - 1), below: who(cx, Math.round(r.bottom) + 1),
                  leftOf: who(Math.round(r.left) - 1, cy), rightOf: who(Math.round(r.right) + 1, cy) },
    };
  });
  const out = {};
  /** 把第一张带 .drawer-x 的抽屉打开（只为量它），返回还原函数。
   *  ⚠ 必须**只**在量 .drawer-x 时打开：遮罩一开就盖住整页，
   *    其余控件全都会被遮罩接走、量成 1×1（第一版就是这么错的）。 */
  const openDrawer = () => {
    const x = document.querySelector('.drawer-x');
    if (!x) return () => {};
    const mask = x.closest('.drawer-mask') || x.parentElement;
    if (!mask) return () => {};
    const had = { show: mask.classList.contains('show'), in: mask.classList.contains('in') };
    mask.classList.add('show'); mask.classList.add('in');
    return () => {
      if (!had.show) mask.classList.remove('show');
      if (!had.in) mask.classList.remove('in');
    };
  };
  for (const [key, sel] of [['fxOrb', '.fx-orb'], ['themeDot', '.theme-dot'],
                            ['toolBtn', '.tool-btn'], ['tbCheck', '.tb-check'],
                            ['dockPal', '#btnPalette'], ['tbBtn', '.tb-btn'],
                            ['tbSelect', '.tb-select']]) {
    const el = q(sel);
    out[key] = el ? scan(el) : 'missing';
  }
  // .drawer-x 单独处理：只有它需要把抽屉打开
  {
    const el = q('.drawer-x');
    if (!el) out.drawerX = 'missing';
    else {
      const restore = openDrawer();
      try { out.drawerX = scan(el); } finally { restore(); }
    }
  }
  return {
    viewport: [innerWidth, innerHeight],
    mq: { coarse: matchMedia('(pointer: coarse)').matches,
          anyCoarse: matchMedia('(any-pointer: coarse)').matches },
    out,
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
  await sleep(600);
  if (!ready) {
    // ⚠ 这里**不能**用 `process.exit(2)` ✗✗ —— 本轮实测出来的真缺陷：
    //   process.exit() 是**立即终止**，不会展开调用栈 ⇒ 下面的 `finally` **根本不会执行** ⇒
    //   浏览器实例没人收、`rmSync` 没人跑、清理诊断没人打 —— 而这条恰恰是
    //   **最需要清理诊断**的失败路径（此时浏览器**确实已经起来了**，实测 22s 后仍占着实例）✗。
    //   正确做法：**先置 exitCode 再 throw** —— 控制流走 `finally` ✓，退出码仍是 2 ✓
    //   （直接 throw 会得到 1，等于把既有退出码契约改掉了；显式 exitCode 不会被覆盖）✓
    process.exitCode = 2;
    throw new Error('[hitscan] 20s 内没等到 window.xiaomo + 触控层就绪。'
      + '先确认静态服务在跑（默认 7373）。');
  }
  console.log(JSON.stringify(await cdp.eval(EXPR), null, 1));
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
    console.error(`[hitscan] 清理诊断：rmSync ${deleted ? '成功' : '失败(' + delErr + ')'}；${inst.text}`);
    if (!inst.cleaned) process.exitCode = 3;
  } catch (e) {
    console.error('[hitscan] 清理诊断：判定器自身异常 ' + String((e && e.message) || e));
  }
}
})().catch((e) => {
  // 顶层捕获：清理已由上面的 finally 跑完；这里只负责把原因说清楚并把退出码锁在 2
  console.error(String((e && e.message) || e));
  process.exitCode = 2;
});
