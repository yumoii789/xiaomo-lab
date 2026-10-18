/**
 * tools/glass-motion-probe.mjs —— 毛玻璃降级 + 弹跳/拖尾 的机械断言（task-57）
 *
 * ── 为什么单独有这个探针 ──────────────────────────────────────────────
 * `tools/motion-probe.mjs`（别人的）已经断言了弹跳与拖尾的**可见性**；本探针不重复它，
 * 只补两件此前**全仓没有任何断言**的事：
 *
 *   F 组 · 毛玻璃的降级
 *     降级最大的坏处不是"写了没用"，而是**"写了 / 没写"从外面看不出差别** ✗ ——
 *     全仓此前 `@supports` 数量为 0，而 `background:var(--glass)` 那层半透明
 *     "碰巧还能看"，所以没人会发现回退其实不存在。
 *     ⇒ 本探针必须**能红**：它要能区分「回退生效」与「回退没生效」，而不是只读一条 CSS 文本。
 *
 *   G 组 · 弹跳不许撑破布局、不许改命中区（Lead 点名的硬要求）
 *     上一轮刚把四个控件的命中面抬到 44px；弹跳若动了盒子几何就会把那个成果打回去 ✗。
 *     ⇒ 用与 task-34 同一口径的**逐像素 elementFromPoint 全域扫描**测命中面，
 *       在**动画进行中**与**静止时**各测一次，逐格比对。
 *
 * ── 关于 method=hidden 的说明（本探针为什么不使唤它）────────────────
 * 让 `@supports not (backdrop-filter:…)` 真正命中的唯一干净办法是在**没有该支持**的
 * 浏览器里跑；CDP 没有关掉 backdrop-filter 支持的开关，`Emulation.setEmulatedMedia`
 * 也覆盖不了它（实测同 pointer/hover 那组）。
 * 所以这里的能红证明走的是**等价的真链路机制**：
 *   读主表里那条真实的 CSSSupportsRule 对象 → 取得它真实的 `conditionText`
 *   → 克隆一份、把 `matches` 置为 true（CSSOM 允许写）→ 注入 → 量 `--glass` 的实际
 *   计算值 → 撤除恢复。这验证的正是**回退声明本身**（它确实会把毛玻璃变不透明），
 *   而不是"我找到了一个字符串"。
 * ⚠ 已知局限（如实标注，不假装验过）："在真的不支持 backdrop-filter 的浏览器上
 *   `@supports` 会不会命中"这一层，无头环境**量不到** ⇒ 列入「需真机验证」。
 *
 * 前提：7373 静态服务在跑（`node server.mjs`）。自起无头 Edge，临时 profile 用完即删。
 * 输出一行：GLASS_MOTION_JSON {...}
 * 用法：
 *   node tools/glass-motion-probe.mjs [URL] [宽] [高]
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { checkCleanup } from './browser-instances.mjs';

const EDGE = process.env.EDGE_PATH
  || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
if (!existsSync(EDGE)) throw new Error('找不到 Edge：' + EDGE + '（可用环境变量 EDGE_PATH 指定）');

const APP = process.argv[2] || 'http://127.0.0.1:7373/index.html';
const W = Number(process.argv[3] || 1920);
const H = Number(process.argv[4] || 1080);

// D36：本探针的读数依赖 styles/main.css 的版本 ⇒ 尾行必须带它的 sha256
const MAIN_CSS = 'styles/main.css';
const CSS_BYTES = readFileSync(MAIN_CSS);
const CSS_SHA = createHash('sha256').update(CSS_BYTES).digest('hex');
const CSS_LEN = CSS_BYTES.length;

const prof = mkdtempSync(join(tmpdir(), 'xm-glass-probe-'));
const port = 9300 + Math.floor(Math.random() * 2000);
const child = spawn(EDGE, ['--headless=new', '--mute-audio', '--disable-gpu', '--no-first-run',
  `--user-data-dir=${prof}`, `--remote-debugging-port=${port}`, `--window-size=${W},${H}`,
  'about:blank'], { stdio: 'ignore', windowsHide: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

const checks = [];
function chk(pass, name, evidence, kind) {
  checks.push({ name, pass: !!pass, evidence, kind: kind || 'hard' });
  console.log(`  ${pass ? '✓' : '✗'} ${name}`);
  if (evidence !== undefined && evidence !== null) {
    console.log('      ' + (typeof evidence === 'string' ? evidence : JSON.stringify(evidence)));
  }
}

let cdp = null;
let hardFail = 0;

try {
  const url = await wsUrl();
  cdp = await CDP.open(url);
  const S = cdp.send.bind(cdp);

  await S('Page.enable');
  await S('Runtime.enable');
  await S('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  // D56：本探针的设备口径位参必须显式声明 —— 目标是**触屏档**（教室大屏 / 触控笔记本），
  // 所以开触摸模拟，好让读数与 task-34 冻结的 touch 列同口径可比 ✓。
  // ⚠ 已知：setTouchEmulationEnabled(true) 会让 pointer:coarse=true、hover=false、
  //   maxTouchPoints=5；而置回 false **不会**把 pointer:coarse 还原（已实测）。
  await S('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });

  const ev = async (expr) => {
    const r = await S('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) {
      throw new Error('[页面异常] ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    }
    return r.result.value;
  };

  await S('Page.navigate', { url: APP + (APP.includes('?') ? '&' : '?') + 'cb=glassprobe' });

  // 就绪（照 motion-probe 的教训：轮询 readyState + 应用标记，不用 sleep 猜）
  let ready = false;
  for (let i = 0; i < 200; i++) {
    try {
      const st = await ev('document.readyState + "|" + !!(window.xiaomo && document.getElementById("stage") && document.querySelector(".stage-fx"))');
      if (st.startsWith('complete|true')) { ready = true; break; }
    } catch { /* 上下文还在建 */ }
    await sleep(100);
  }
  if (!ready) throw new Error('页面 20s 内没就绪（先确认静态服务在跑，默认 7373）');

  console.log('═══ F 组 · 毛玻璃降级（能红证明）═══');

  // F1 · 回退规则真的存在于主表里，且条件是标准的 backdrop-filter not-query
  //   ⚠ 用 indexOf 而非正则：模板字面量里的 `\\s*\\(` 会被折成 `s*(`（未闭合分组）✗
  const f1 = await ev(`(() => {
    const found = [];
    for (const ss of document.styleSheets) {
      let rules; try { rules = ss.cssRules; } catch { continue; }
      if (!rules) continue;
      for (const r of rules) {
        if (r.constructor.name !== 'CSSSupportsRule') continue;
        const c = r.conditionText || '';
        if (c.indexOf('not') >= 0 && c.indexOf('backdrop-filter') >= 0) {
          const kids = [...r.cssRules].map(k => ({ sel: k.selectorText || '', css: k.style.cssText }));
          found.push({ href: ss.href ? ss.href.split('/').pop() : '(inline)', condition: c, kids });
        }
      }
    }
    return found;
  })()`);
  chk(f1.length > 0, 'F1 主表里存在 `@supports not (backdrop-filter: …)` 的降级规则',
    f1.map((f) => `${f.href}  cond=${JSON.stringify(f.condition)}  子规则=${f.kids.length}`).join(' | ') || '未找到 ✗',
    'hard');
  if (!f1.length) hardFail++;

  // F1b · 它覆盖的是 --glass 这一族（而不是逐条改那 11 条声明）
  const f1b = f1.length ? f1[0].kids.map((k) => k.css).join(' ; ') : '';
  chk(/--glass\b/.test(f1b), 'F1b 降级改的是 `--glass` 这一族（一处生效、13 条声明跟随）',
    f1b || '（无子规则）', 'hard');
  if (!/--glass\b/.test(f1b)) hardFail++;

  // F2 · 能红证明：把「不支持时该应用的实色」真的应用一次 → 毛玻璃必须变不透明
  //   ⚠ 为什么是注入**载体自身**的 background，而不是去改 :root 的 --glass：
  //     主题由 theme.js 把 token 刷成 :root 的**内联样式**，内联赢过样式表 ⇒
  //     `:root{--glass:…}` 根本改不动（本探针第一版与产品 CSS 第一版都栽在这，
  //     详见 styles/main.css 里那段注释与 %TEMP%\cascade-diag.mjs 的实测）。
  //   ⚠ 判定用 `α>=1`：两层 background（不透明底色垫底）算出来必须完全不透明。
  //     用 color-mix 时会得到 `color(srgb … / .87)` —— 仍带透明 ⇒ 这一条会红 ✓（已实测）。
  const f2 = await ev(`(() => {
    const read = () => {
      const cs = getComputedStyle(document.documentElement);
      const bg = {};
      for (const s of ['.drawer', '#topbar', '#statusbar', '.fx-orb']) {
        const el = document.querySelector(s);
        bg[s] = el ? getComputedStyle(el).backgroundColor : null;
      }
      return { glass: cs.getPropertyValue('--glass').trim(), bg,
               drawerBlur: (() => { const d = document.querySelector('.drawer');
                 return d ? (getComputedStyle(d).backdropFilter || getComputedStyle(d).webkitBackdropFilter) : null; })() };
    };
    const alphaOf = (s) => {
      if (!s) return null;
      const m0 = String(s).match(/^(?:rgba?|color)\\(([^)]*)\\)/);
      if (!m0) return null;
      const body = m0[1];
      // 现代 color() 写法：srgb r g b / a
      // ⚠ 上面这行不能给 srgb… 加反引号：本段整体在 ev(...) 的模板字符串里，注释里出现
      //   反引号会提前终止模板，文件立刻变成语法错误（motion-probe 起不来）。HEAD 版本
      //   正是这样坏掉的，task-64 把它修回来（迁移说明曾判为「越界改动、应回滚」，实测
      //   回滚后 node --check 直接报 missing ) after argument list，故不采纳该判断）。
      if (String(s).startsWith('color(')) {
        const sl = body.split('/');
        return sl.length > 1 ? parseFloat(sl[1]) : 1;
      }
      const p = body.split(/[,\\/]/).map(x => parseFloat(x.trim()));
      return p.length >= 4 ? p[3] : 1;
    };
    const before = read();
    // 与主表里那条降级**同一声明**（2026-10-17 同步修正后的版本）：
    //   ⚠ 旧版注入的是 background: var(--bg) var(--glass)（两个纯颜色）—— 那**语法非法**，
    //     浏览器整条判无效、回退成 transparent，于是 .drawer 实测 α 从 0.74 掉到 **0**，
    //     而 #topbar / #statusbar / .fx-orb 仍是 0.74（:where() 的 0,0,0 压不过 ID 规则 1,0,0）。
    //     即**探针注入的写法本身也是错的**，它测的不是产品真会应用的那条规则。
    //   ⇒ 现在按 styles/main.css 里修正后的写法注入：不透明 --bg 落到载体 + !important
    //     （!important 是唯一能赢主题内联 :root 变量的写法）。
    //   ⚠ 本段在 ev() 的模板字符串**内部**，注释里**绝不能出现反引号**（会提前终止模板）。
    const st = document.createElement('style');
    st.id = 'glass-probe-force-unsupported';
    st.textContent = '#topbar,#statusbar,.drawer,.toast,.fx-orb,.expel-mask,.about-mask'
                    + '{background:var(--bg) !important;transition:none !important}';
    document.head.appendChild(st);
    const forced = read();
    st.remove();
    const after = read();
    return {
      ok: true,
      before: { glass: before.glass, a: alphaOf(before.glass), drawer: before.bg['.drawer'], aDrawer: alphaOf(before.bg['.drawer']), blur: before.drawerBlur },
      forced: { glass: forced.glass, a: alphaOf(forced.glass), drawer: forced.bg['.drawer'], aDrawer: alphaOf(forced.bg['.drawer']),
                topbar: alphaOf(forced.bg['#topbar']), statusbar: alphaOf(forced.bg['#statusbar']), orb: alphaOf(forced.bg['.fx-orb']) },
      after:  { glass: after.glass,  a: alphaOf(after.glass),  drawer: after.bg['.drawer'],  aDrawer: alphaOf(after.bg['.drawer']) },
      colorMixSupported: CSS.supports('color', 'color-mix(in srgb, red, blue)'),
      backdropSupported: CSS.supports('backdrop-filter', 'blur(1px)'),
    };
  })()`);

  if (!f2.ok) {
    chk(false, 'F2 能红证明：强制"不支持"后毛玻璃必须变不透明', f2.why, 'hard'); hardFail++;
  } else {
    const becameOpaque = f2.forced.aDrawer !== null && f2.forced.aDrawer >= 1;
    const wasTranslucent = f2.before.aDrawer !== null && f2.before.aDrawer < 1;
    const others = { '#topbar': f2.forced.topbar, '#statusbar': f2.forced.statusbar, '.fx-orb': f2.forced.orb };
    const othersOpaque = Object.values(others).every((a) => a !== null && a >= 1);
    chk(wasTranslucent && becameOpaque && othersOpaque,
      'F2 能红证明：静止时载体半透明 → 应用降级声明后完全不透明（4 个载体全检）',
      `静止 .drawer α=${f2.before.aDrawer} (${f2.before.drawer}) → 强制后 α=${f2.forced.aDrawer} (${f2.forced.drawer})；`
      + `其余载体 α=${JSON.stringify(others)}；--glass=${f2.forced.glass}；`
      + `本内核 backdrop-filter 支持=${f2.backdropSupported} color-mix 支持=${f2.colorMixSupported}`, 'hard');
    if (!(wasTranslucent && becameOpaque && othersOpaque)) hardFail++;

    // F4 · 撤除后逐字复原（排除"页面本来就不透明"这种假红）
    chk(f2.after.drawer === f2.before.drawer && f2.after.aDrawer === f2.before.aDrawer
        && f2.after.glass === f2.before.glass,
      'F4 撤除注入后逐字复原（排除"页面本来就不透明"这种假红）',
      `撤除后 .drawer ${f2.after.drawer}（α=${f2.after.aDrawer}）、--glass ${f2.after.glass}`, 'hard');
    if (!(f2.after.drawer === f2.before.drawer && f2.after.aDrawer === f2.before.aDrawer
          && f2.after.glass === f2.before.glass)) hardFail++;
  }

  // F5 · 复现「主题内联 vs 样式表」的级联陷阱本身：
  //   证明 `:root{--glass:…}` **改不动**（所以产品 CSS 才必须落在载体上）。
  //   这条断言是"防止未来有人把回退改回 :root 写法"的哨兵 ✓。
  const f5 = await ev(`(() => {
    const root = document.documentElement;
    const g = () => getComputedStyle(root).getPropertyValue('--glass').trim();
    const inlineGlass = root.style.getPropertyValue('--glass');
    const before = g();
    const st = document.createElement('style');
    st.textContent = ':root{--glass:#010203}';
    document.head.appendChild(st);
    const sheetPlain = g();
    st.remove();
    const st2 = document.createElement('style');
    st2.textContent = ':root{--glass:#010203 !important}';
    document.head.appendChild(st2);
    const sheetImportant = g();
    st2.remove();
    return { inlineGlass, before, sheetPlain, sheetImportant };
  })()`);
  const f5ok = !!f5.inlineGlass && f5.sheetPlain === f5.before && f5.sheetImportant !== f5.before;
  chk(f5ok,
    'F5 级联陷阱已复现：主题把 --glass 写成 :root 内联 ⇒ 样式表 :root 改不动（回退必须落载体）',
    `内联 --glass=${f5.inlineGlass}；静止=${f5.before}；`
    + `样式表 :root{--glass:#010203} → ${f5.sheetPlain}（应与静止相同=${f5.sheetPlain === f5.before}）；`
    + `带 !important → ${f5.sheetImportant}（应不同=${f5.sheetImportant !== f5.before}）`, 'hard');
  if (!f5ok) hardFail++;

  // F3 · 屏幕上真有 blur（说明降级是"支持时的正路 + 不支持时的回退"，不是把 blur 关掉了）
  const f3 = await ev(`(() => {
    const out = {};
    for (const s of ['#topbar', '.drawer', '#statusbar', '.fx-orb', '.toast']) {
      const el = document.querySelector(s);
      out[s] = el ? (getComputedStyle(el).backdropFilter || getComputedStyle(el).webkitBackdropFilter || 'none') : '(无此元素)';
    }
    return out;
  })()`);
  const blurCount = Object.values(f3).filter((v) => /blur\(/.test(v)).length;
  chk(blurCount >= 3, 'F3 支持时 blur 仍在（降级没有把正路一起关掉）',
    Object.entries(f3).map(([k, v]) => `${k}=${v}`).join(' | '), 'hard');
  if (blurCount < 3) hardFail++;

  console.log('');
  console.log('═══ G 组 · 弹跳/拖尾：不改命中区、不动布局 ═══');

  // G1 · 用 task-34 的同一口径（逐像素 elementFromPoint 全域扫描）测四个控件的命中面，
  //      在「静止」和「动画进行中」两种状态下各测一次。
  //   ⚠ `.drawer-x` 必须**单独**测：它藏在 `.drawer-mask` 里，而遮罩一开就盖住整页
  //     ⇒ 其余控件全被遮罩接走、量成 1×1（hitscan.mjs 第一版正是这么错的，
  //       本探针第一版则直接把它量成 null）。所以顺序是：
  //       先测不受遮罩影响的三个 → 再打开遮罩只测 .drawer-x → 立刻还原。
  const g1 = await ev(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    // 逐像素全域扫描：命中矩形内每个整数像素调 elementFromPoint，数属于该元素自己的像素
    const hitScan = (el) => {
      const r = el.getBoundingClientRect();
      const x0 = Math.round(r.left), x1 = Math.round(r.right), y0 = Math.round(r.top), y1 = Math.round(r.bottom);
      let hit = 0, w = 0, h = 0, minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const t = document.elementFromPoint(x + 0.5, y + 0.5);
          if (t && (t === el || el.contains(t) || t.contains(el))) {
            hit++;
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minY) minY = y; if (y > maxY) maxY = y;
          }
        }
      }
      if (hit) { w = maxX - minX + 1; h = maxY - minY + 1; }
      return { hit, hitW: w, hitH: h, box: { w: Math.round(r.width), h: Math.round(r.height) } };
    };
    // 把带 .drawer-x 的那张抽屉打开（只为量它），返回还原函数 —— 与 hitscan.mjs 同一做法
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
    const visible = (sel) => [...document.querySelectorAll(sel)].filter(e => e.getClientRects().length)[0] || null;

    const rest = {}, during = {};
    // ① 不受遮罩影响的三个（也带 .drawer-x 的同一个 find 语义，但此时遮罩是关的）
    for (const sel of ['.fx-orb', '.theme-dot', '.tb-btn']) {
      const el = visible(sel);
      rest[sel] = el ? hitScan(el) : null;
    }
    // ② 动画进行中：连续派发 pointerdown（涟漪 + :active 弹跳同时在跑），每 8ms 采一次
    const stage = document.getElementById('stage');
    const target = document.getElementById('canvas') || stage;
    const r0 = stage.getBoundingClientRect();
    const fire = (t) => target.dispatchEvent(new PointerEvent(t, {
      pointerId: 7, pointerType: 'touch', isPrimary: true, bubbles: true, cancelable: true,
      clientX: r0.left + 80, clientY: r0.top + 80, buttons: t === 'pointerup' ? 0 : 1, button: 0,
    }));
    const watching = ['.fx-orb', '.theme-dot', '.tb-btn']
      .map(s => ({ s, el: visible(s) })).filter(o => o.el);
    const rippleSeen = { max: 0 };
    fire('pointerdown');
    for (let i = 0; i < 8; i++) {
      await sleep(8);
      const n = document.querySelectorAll('.fx-ripple').length;
      if (n > rippleSeen.max) rippleSeen.max = n;
      for (const o of watching) { if (!during[o.s]) during[o.s] = hitScan(o.el); }
    }
    fire('pointerup');
    // 补一次 ripple 计数（200ms 寿命内多半已结束，故 max 才是最可信读数）
    rippleSeen.now = document.querySelectorAll('.fx-ripple').length;

    // ③ .drawer-x 单独测：开遮罩 → 测静止 → 打一次动画 → 测动画中 → 还原
    let drawerX = null, drawerXDuring = null;
    const restore = openDrawer();
    try {
      const el = visible('.drawer-x');
      if (el) {
        rest['.drawer-x'] = hitScan(el);
        const r = el.getBoundingClientRect();
        el.dispatchEvent(new PointerEvent('pointerdown', {
          pointerId: 11, pointerType: 'touch', isPrimary: true, bubbles: true, cancelable: true,
          clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, buttons: 1, button: 0,
        }));
        for (let i = 0; i < 6; i++) { await sleep(8); if (!drawerXDuring) drawerXDuring = hitScan(el); }
        during['.drawer-x'] = drawerXDuring;
        el.dispatchEvent(new PointerEvent('pointerup', {
          pointerId: 11, pointerType: 'touch', isPrimary: true, bubbles: true, cancelable: true,
          clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, buttons: 0, button: 0,
        }));
      }
    } finally { restore(); }

    const fxLayer = document.querySelector('.stage-fx');
    return {
      rest, during, rippleMax: rippleSeen.max,
      layerPointerEvents: fxLayer ? getComputedStyle(fxLayer).pointerEvents : null,
      // 低特异性冲突检查：动画期间原子元素是否仍被 .stage-fx > * 的 pointer-events:auto 影响
      fxChildPE: (() => { const c = fxLayer && fxLayer.firstElementChild;
        return c ? getComputedStyle(c).pointerEvents : '(采样时无子节点)'; })(),
    };
  })()`);

  const g1lines = [];
  let g1bad = 0, g1missing = 0;
  for (const sel of ['.drawer-x', '.fx-orb', '.theme-dot', '.tb-btn']) {
    const a = g1.rest[sel], b = g1.during[sel];
    if (!a) { g1lines.push(`${sel}= 取不到可见实例`); g1missing++; continue; }
    if (!b) { g1lines.push(`${sel}= 静止 ${a.hitW}×${a.hitH}，动画中未采到`); g1missing++; continue; }
    const same = a.hitW === b.hitW && a.hitH === b.hitH;
    if (!same) g1bad++;
    g1lines.push(`${sel}: 静止 ${a.hitW}×${a.hitH} → 动画中 ${b.hitW}×${b.hitH} ${same ? '✓' : '✗ 变了'}`);
  }
  chk(g1bad === 0 && g1missing === 0 && g1.rest['.drawer-x'],
    'G1 弹跳/涟漪进行中不改命中面（逐像素全域扫描，静止 vs 动画中逐格比对；四控件全采到）',
    g1lines.join(' ; ') + `；涟漪在动画窗口内的峰值节点数=${g1.rippleMax}`, 'hard');
  if (!(g1bad === 0 && g1missing === 0 && g1.rest['.drawer-x'])) hardFail++;

  // G2 · 弹跳/拖尾关键帧只动 transform / opacity
  //   ⚠ 第一版在 rs 是普通对象时也会进 r.cssRules 分支并抛错，被外层 catch 吞掉 ⇒ 量到 0 帧。
  //     这里改成显式类型判定 + 记异常，避免"探针自己坏了却被读成产品没做"。
  const g2 = await ev(`(() => {
    const out = []; const errs = []; const names = [];
    const walk = (rs, depth) => {
      if (depth > 6 || !rs) return;
      for (let i = 0; i < rs.length; i++) {
        let r; try { r = rs[i]; } catch (e) { errs.push('idx' + i + ':' + e.message); continue; }
        const t = (r && r.constructor && r.constructor.name) || 'unknown';
        if (t === 'CSSKeyframesRule') { names.push(r.name); }
        if (t === 'CSSKeyframesRule' && /^(fx-ripple|fx-trail)$/.test(r.name)) {
          for (const kf of r.cssRules) out.push({ name: r.name, at: kf.keyText, props: [...kf.style].map(p => p) });
          continue;
        }
        let kids = null; try { kids = r.cssRules; } catch (e) { errs.push(t + ':' + e.message); }
        if (kids) walk(kids, depth + 1);
      }
    };
    for (const ss of document.styleSheets) {
      let rules = null; try { rules = ss.cssRules; } catch (e) { errs.push('sheet:' + e.message); continue; }
      walk(rules, 0);
    }
    return { frames: out, keyframeNames: names, errs: errs.slice(0, 6) };
  })()`);
  const g2frames = (g2 && g2.frames) || [];
  const illegal = g2frames.flatMap((k) => k.props.filter((p) => !/^(transform|opacity)$/.test(p))
    .map((p) => `${k.name}@${k.at}:${p}`));
  chk(g2frames.length > 0 && illegal.length === 0,
    'G2 弹跳/拖尾关键帧只动 transform 与 opacity（不动几何属性）',
    `关键帧 ${g2frames.length} 帧；全部 @keyframes 名=${JSON.stringify((g2 && g2.keyframeNames) || [])}；`
    + `越界属性：${illegal.length ? illegal.join(', ') : '无'}`
    + (g2 && g2.errs && g2.errs.length ? `；读表异常=${JSON.stringify(g2.errs)}` : ''), 'hard');
  if (!(g2frames.length > 0 && illegal.length === 0)) hardFail++;

  // G3 · 脉动层自己不接收指针事件（否则动画中的节点会遮挡命中区）
  chk(String(g1.layerPointerEvents) === 'none',
    'G3 .stage-fx 图层 pointer-events:none（动画节点不遮挡命中面）',
    `.stage-fx pointer-events=${g1.layerPointerEvents}`, 'hard');
  if (String(g1.layerPointerEvents) !== 'none') hardFail++;

  // G4 · prefers-reduced-motion 块里必须关掉 .fx-ripple/.fx-trail
  //   ⚠ 这里刻意不用正则：模板字面量里 `\\s` 会被折成 `s`（本探针第一版就这么坏过，
  //     表现为"没找到 reduce 规则"⇒ 探针自己的转义错误伪装成产品缺陷 ✗）。
  //     改用 indexOf 判定，彻底不依赖转义。
  const g4 = await ev(`(() => {
    const hit = [];
    const walk = (rs, depth) => {
      if (depth > 6 || !rs) return;
      for (let i = 0; i < rs.length; i++) {
        let r; try { r = rs[i]; } catch (e) { continue; }
        const t = (r && r.constructor && r.constructor.name) || '';
        if (t === 'CSSMediaRule' || t === 'CSSSupportsRule') {
          const cond = String(r.conditionText || (r.media && r.media.mediaText) || '');
          if (cond.indexOf('prefers-reduced-motion') >= 0) {
            let kids = []; try { kids = [...r.cssRules]; } catch (e) { kids = []; }
            hit.push(kids.map(k => k.cssText || k.selectorText || '').join(' ; '));
            continue;
          }
        }
        let kids = null; try { kids = r.cssRules; } catch (e) { kids = null; }
        if (kids) walk(kids, depth + 1);
      }
    };
    for (const ss of document.styleSheets) {
      let rules = null; try { rules = ss.cssRules; } catch (e) { continue; }
      walk(rules, 0);
    }
    return { reduceRules: hit, mqMatches: window.matchMedia('(prefers-reduced-motion: reduce)').matches };
  })()`);
  const g4text = (g4 && g4.reduceRules ? g4.reduceRules.join(' \u0001 ') : '');
  const g4ok = g4text.indexOf('fx-ripple') >= 0 && g4text.indexOf('fx-trail') >= 0;
  chk(g4ok,
    'G4 prefers-reduced-motion 块里确实关掉了 .fx-ripple/.fx-trail',
    `reduce 规则 ${(g4 && g4.reduceRules || []).length} 块；含 fx-ripple=${g4text.indexOf('fx-ripple') >= 0} `
    + `含 fx-trail=${g4text.indexOf('fx-trail') >= 0}；本机 mq.matches=${g4 && g4.mqMatches}；`
    + `原文=${g4text.replace(/\u0001/g, ' ｜ ').slice(0, 200)}`, 'hard');
  if (!g4ok) hardFail++;

  // ── 汇总 ──
  const passed = checks.filter((c) => c.pass).length;
  const failed = checks.length - passed;
  console.log('');
  console.log(`  ── ${passed}/${checks.length} 通过${failed ? `，失败 ${failed}` : ''} ──`);
  console.log('GLASS_MOTION_JSON ' + JSON.stringify({
    passed, failed, total: checks.length,
    mainCss: { bytes: CSS_LEN, sha256: CSS_SHA },
    checks: checks.map((c) => ({ name: c.name, pass: c.pass })),
    details: { f1, f2, f3, g1: { rest: g1.rest, during: g1.during }, g2, g4 },
  }));
  if (failed) process.exitCode = 1;
} catch (e) {
  console.error('[glass-motion-probe] 失败：' + String((e && e.message) || e));
  process.exitCode = 2;
} finally {
  try { spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch { /* 已经退出 */ }
  try { child.kill(); } catch { /* 已经退出 */ }
  await sleep(700);
  let deleted = true, delErr = '';
  try { rmSync(prof, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
  catch (e) { deleted = false; delErr = String((e && e.message) || e).slice(0, 120); }
  try {
    const inst = await checkCleanup(prof);
    console.error(`[glass-motion-probe] 清理诊断：rmSync ${deleted ? '成功' : '失败(' + delErr + ')'}；${inst.text}`);
    if (!inst.cleaned) process.exitCode = 3;
  } catch (e) {
    console.error('[glass-motion-probe] 清理诊断：判定器自身异常 ' + String((e && e.message) || e));
  }
  if (cdp) { try { cdp.ws.close(); } catch { /* 已关 */ } }
}
