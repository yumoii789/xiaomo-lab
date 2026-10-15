// ══════════════════════════════════════════════════════════
// 装载守卫 —— 证明「真实的 ALL_PLUGINS 全部装得上」
//
//   node tools/guard-plugins.mjs
//
// 为什么要有它：`tools/check.mjs` 的 45 项用例只 import 了自己声明的少数
// 插件，从不用真实的 ALL_PLUGINS，于是 `xiaomo.ui.interaction` 的 setup
// 在 `this.app.setStatusTool is not a function` 上抛错、整个插件的涟漪与
// 拖尾监听器从未注册，而检查套件依然全绿。
//
// 这个脚本把**真正启动用的那一批插件**（唯一的名单：src/plugins/index.js）
// 在 DOM 替身下完整装载一遍，只输出一行 JSON。它跑在独立进程里，
// 副作用（rAF 循环、插槽渲染）不会污染 check.mjs 的其余用例。
// ══════════════════════════════════════════════════════════

import { ALL_PLUGINS } from '../src/plugins/index.js';

const quiet = process.argv.includes('--quiet');

// ─────────────────────────────────────────────────────────
// DOM 替身：能力刚好够跑通引导，不是 DOM 实现。
// 故意做得能"接住"任何调用（元素属性缺失就补一个空函数），
// 因为这里的判据只有一条：有没有插件在 setup 里抛错。
// 替身能力不足会表现为题外错误（null is not a function 等），
// 与真实缺陷（this.app.setStatusTool is not a function）在字符串上分得开。
// ─────────────────────────────────────────────────────────
function nullCtx() {
  const grad = { addColorStop() {} };
  return new Proxy({}, {
    get(_t, k) {
      if (k === 'canvas') return { width: 1280, height: 820 };
      if (k === 'measureText') return () => ({ width: 10 });
      if (k === 'createLinearGradient' || k === 'createRadialGradient' || k === 'createPattern') return () => grad;
      if (k === 'getImageData') return () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 });
      if (k === 'createImageData') return () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 });
      if (typeof k === 'symbol') return undefined;
      return () => {};
    },
    set() { return true; },
  });
}

/**
 * 模块级：属性 API 调用计数（跨所有替身元素聚合 ✓）。
 * 存在的理由：判据不能只看「没抛」✗ —— 必须能证明某条产品分支**真的执行了** ✓，
 * 而分支执行在替身里只留下这一次 API 调用 ✓（先例：ui.log 的监听器计数 ✓）。
 */
const attrOps = new Map();
const countAttr = (op, n) => {
  const k = `${op}:${n}`;
  attrOps.set(k, (attrOps.get(k) || 0) + 1);
};

function makeEl(tag = 'div') {
  const el = {
    tagName: String(tag).toUpperCase(),
    id: '', className: '', textContent: '', innerHTML: '', value: '', checked: false,
    disabled: false, hidden: false, href: '', download: '', type: '', name: '',
    style: new Proxy({}, {
      get(t, k) { return k in t ? t[k] : (k === 'setProperty' || k === 'removeProperty' || k === 'getPropertyValue' ? () => '' : ''); },
      set(t, k, v) { t[k] = v; return true; },
    }),
    dataset: {},
    children: [], childNodes: [], parentNode: null, ownerDocument: null,
    offsetWidth: 120, offsetHeight: 24, offsetLeft: 0, offsetTop: 0,
    clientWidth: 900, clientHeight: 600, scrollTop: 0, scrollHeight: 600,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false, replace() {} },
    /**
     * 真属性表（task-37 续）—— 此前这四个是「恒 null / 恒 false」的地板 ✗ ⇒
     * 凡用 `getAttribute` / `hasAttribute` 判分支的产品路径，在闸门里**永远走不到** ✗。
     * 同类扫描实测到一处真缺口：`src/ui/palette.js:149` 的
     * `else if (row.hasAttribute('data-pack')) row.removeAttribute('data-pack')` 清理分支
     * —— 行复用后换成「非器材包」条目时浏览器里会执行 ✓，闸门里永不执行 ✗。
     * 现在写入 / 读出 / 查存在 / 删除落在同一张表上 ✓，且每次调用都计数 ✓ ——
     * 计数是这里唯一能证明「这条分支真的跑了」的痕迹 ✓（照 `ui.log` 的监听器计数先例 ✓）。
     * ⚠ 边界：**不动** `dataset`（仍是独立普通对象 ✓）—— 今天没有任何产品路径依赖
     * 「`dataset` 写入 ↔ `data-*` 读出」这一对 ✓（唯一的 `hasAttribute` 调用点，其属性由
     * `setAttribute` 写入 ✓）。**将来若真有路径依赖它，那条路径在闸门里会先以「某条判据变红」
     * 的形式暴露出来，那时再把它接到同一张表** ✓ —— 不是「永远别改」✗，是「等它自己报警」✓。
     */
    setAttribute(n, v) {
      (this.__attrs || (this.__attrs = new Map())).set(String(n), String(v));
      countAttr('setAttribute', n);
    },
    getAttribute(n) { const t = this.__attrs; return t && t.has(String(n)) ? t.get(String(n)) : null; },
    hasAttribute(n) { return !!(this.__attrs && this.__attrs.has(String(n))); },
    removeAttribute(n) {
      if (this.__attrs) this.__attrs.delete(String(n));
      countAttr('removeAttribute', n);
    },
    /**
     * `toggleAttribute` 与上面共用同一张表 ✓。它曾因**整个 API 缺失**让触控层第三步
     * 整段抛异常、被插件自己的 try/catch 吞掉 —— 「装了但缺件，看起来和装好了一样」✗。
     */
    toggleAttribute(name, force) {
      const k = String(name);
      const on = force === undefined ? !this.hasAttribute(k) : !!force;
      if (on) this.setAttribute(k, ''); else this.removeAttribute(k);
      countAttr('toggleAttribute', k);
      return on;
    },
    appendChild(c) { if (!c) return c; this.children.push(c); this.childNodes.push(c); c.parentNode = this; return c; },
    insertBefore(c) { if (!c) return c; this.children.unshift(c); this.childNodes.unshift(c); c.parentNode = this; return c; },
    removeChild(c) {
      const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1);
      const j = this.childNodes.indexOf(c); if (j >= 0) this.childNodes.splice(j, 1);
      if (c) c.parentNode = null;
      return c;
    },
    /** 真 DOM 的 append/prepend 收节点**或字符串**；替身按同签名收下 —— 缺了它渲染函数会在半途抛 */
    append(...ns) { for (const n of ns) this.appendChild(n && typeof n === 'object' ? n : { nodeType: 3, textContent: String(n) }); },
    prepend(...ns) { for (const n of ns) this.insertBefore(n && typeof n === 'object' ? n : { nodeType: 3, textContent: String(n) }); },
    replaceChildren(...ns) { this.children.length = 0; this.childNodes.length = 0; this.append(...ns); },
    before() {}, after() {}, replaceWith() {}, insertAdjacentHTML() {}, insertAdjacentElement(_p, e) { return e; },
    remove() {}, cloneNode() { return makeEl(tag); },
    /**
     * 记录式监听器：替身不是 DOM，但**"注册成功"必须可观测** ✓
     * 没有它，闸门就无法判断渲染函数有没有走到最后一行 —— 那正是本文件此前 11 条覆盖缺口的成因 ✗。
     */
    addEventListener(type, fn) { (this.__ls || (this.__ls = [])).push({ type, fn }); },
    removeEventListener(type, fn) {
      const i = (this.__ls || []).findIndex((l) => l.type === type && l.fn === fn);
      if (i >= 0) this.__ls.splice(i, 1);
    },
    dispatchEvent(e) { (this.__ls || []).filter((l) => l.type === (e && e.type)).forEach((l) => l.fn(e)); return true; },
    /**
     * 元素级 querySelector **必须返回替身，不能返回 null** ✗。
     * 真 DOM 里只有"确实不存在"才返回 null；而替身**不解析 innerHTML**
     * （`bar.innerHTML = '<button id=btnClearLog>'` 在替身里只是一个字符串 ✗），
     * 于是 `bar.querySelector('#btnClearLog')` 恒 null ⇒ 渲染函数半途抛错 ⇒
     * 该路径在闸门里从未走到最后一行 ✗（"日志印红、结论是绿"的成因）。
     * 口径与 doc.querySelector 一致：同一个选择器给**同一个**替身（真 DOM 也是这个语义），
     * 因此渲染函数注册上去的监听器可以被观测到 ✓。
     */
    querySelector(s) {
      const k = String(s).trim();
      if (!this.__sub) this.__sub = new Map();
      if (!this.__sub.has(k)) this.__sub.set(k, makeEl());
      return queryOne(k) || this.__sub.get(k);
    },
    querySelectorAll(s) { const hits = queryAll(s, this); return hits.length ? hits : subAll(this, s); },
    get firstElementChild() { return this.children[0] || null; },
    get lastElementChild() { return this.children[this.children.length - 1] || null; },
    get childElementCount() { return this.children.length; },
    closest: () => null, contains: () => false, matches: () => false,
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 1280, bottom: 820, width: 1280, height: 820, x: 0, y: 0 }),
    focus() {}, blur() {}, click() {}, select() {}, scrollIntoView() {}, removeAttributeNode() {},
    getContext: () => nullCtx(), toDataURL: () => 'data:,', setPointerCapture() {}, releasePointerCapture() {},
  };
  el.ownerDocument = null;
  return el;
}

const byId = {};
const el = (tag, id, cls) => {
  const e = makeEl(tag);
  e.id = id || ''; e.className = cls || '';
  if (id) byId[id] = e;
  return e;
};

// index.html 里引导阶段会被访问到的节点
const stageEl = el('section', 'stage');
const layerEl = el('div', '', 'stage-fx');
stageEl.appendChild(layerEl);
const canvasEl = el('canvas', 'canvas');
const sideTabs = el('nav', 'sideTabs');
const sideInk = el('span', 'sideInk', 'side-ink');
const panes = ['inspector', 'data', 'log'].map((p) => el('div', 'pane-' + p, 'pane'));
const tabBtns = ['inspector', 'data', 'log'].map((p, i) => {
  const b = el('button', '', i === 0 ? 'active' : '');
  b.dataset.pane = p;
  sideTabs.appendChild(b);
  return b;
});
el('div', 'hint', 'hint');
el('div', 'toast', 'toast');

const norm = (s) => String(s).replace(/[#.][\w-]+|\s+/g, ' ').trim().toLowerCase();
/** 选择器 → 同一个元素替身（真实 DOM 里同一个选择器就是同一个节点） */
const slotEls = new Map();
const persistEl = (key) => {
  const k = String(key).replace(/["']/g, '').trim();   // [data-slot=x] 与 [data-slot="x"] 必须是**同一个**替身
  if (!slotEls.has(k)) slotEls.set(k, makeEl('div'));
  return slotEls.get(k);
};
const queryOne = (sel) => {
  const s = String(sel).trim();
  if (s.startsWith('#') && !s.includes(' ')) return byId[s.slice(1)] || null;
  // ⚠ 这条必须排在下面的模糊匹配**之前** ✗：`[data-slot="sidebar.pane.data"]` 里含 `.pane` 子串，
  //   先跑模糊匹配会把三个 pane 插槽全部解析到同一个 `.pane` 元素上 —— 那是替身把三个插槽
  //   焊成了一个（实测三条槽痕迹逐字相同才发现 ✗），覆盖证据会整体失真 ✗。
  if (/^\[data-slot=/.test(s)) return persistEl(s);
  for (const e of Object.values(byId)) {
    if (e.className && s.includes('.' + e.className)) return e;
    if (e.textContent && s.includes(e.textContent)) return e;
  }
  return null;
};
const queryAll = (sel, root) => {
  if (sel === 'button' && root === sideTabs) return tabBtns;
  if (sel === '#sidebar .pane' || sel === '.pane') return panes;
  return [];
};
/**
 * 替身不知道文档里**真实有几个**匹配（它不解析 innerHTML ✗），但必须给一个**非空且稳定**的列表 ✓。
 * 否则 `$$('[data-tool]', host).forEach(b => b.addEventListener(...))`（ui.toolbar.js:33）这类
 * 「只在迭代体里执行的末行」根本不跑 ✗ —— 而它**不抛错**：比 task-39 那类抛错更隐蔽的覆盖缺口 ✗。
 * ⚠ 长度是**替身的下限（1 个）**，不是产品的真实数量 ✗ —— 因此痕迹只能证明「走到了」✓。
 */
const subAll = (owner, sel) => {
  const k = String(sel).trim();
  if (!owner.__subAll) owner.__subAll = new Map();
  if (!owner.__subAll.has(k)) owner.__subAll.set(k, [makeEl()]);
  return owner.__subAll.get(k);
};
for (const e of Object.values(byId)) {
  e.querySelector = (s) => queryOne(s) || persistEl(String(s));
  e.querySelectorAll = (s) => { const hits = queryAll(s, e); return hits.length ? hits : subAll(e, s); };
}

const doc = {
  body: makeEl('body'),
  head: makeEl('head'),
  documentElement: makeEl('html'),
  getElementById: (id) => byId[id] || (byId[id] = el('div', id)),
  querySelector: (s) => queryOne(s) || persistEl(String(s)),
  querySelectorAll: (s) => { const hits = queryAll(s); return hits.length ? hits : subAll(doc, s); },
  createElement: (tag) => makeEl(tag),
  createElementNS: (_ns, tag) => makeEl(tag),
  createTextNode: (t) => ({ nodeType: 3, textContent: t }),
  createDocumentFragment: () => makeEl('fragment'),
  addEventListener() {}, removeEventListener() {},
  hidden: false, visibilityState: 'visible', activeElement: null,
};
for (const e of Object.values(byId)) e.ownerDocument = doc;

const store = new Map();
const localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
  key: (i) => [...store.keys()][i] ?? null,
  get length() { return store.size; },
};

const raf = (fn) => setTimeout(() => fn(performance.now()), 0);
const win = {
  document: doc,
  addEventListener() {}, removeEventListener() {}, dispatchEvent: () => true,
  matchMedia: (q) => ({
    media: q, matches: false, onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
  }),
  getComputedStyle: () => ({
    getPropertyValue: (p) => (/^--t-/.test(p) ? '200ms' : ''),
    animationDuration: '200ms', transitionDuration: '200ms',
  }),
  devicePixelRatio: 1, innerWidth: 1280, innerHeight: 820,
  requestAnimationFrame: raf, cancelAnimationFrame: (id) => clearTimeout(id),
  setTimeout, clearTimeout, setInterval, clearInterval,
  localStorage, location: { href: 'http://127.0.0.1:7373/', search: '', hash: '', reload() {} },
  navigator: { userAgent: 'node-guard', platform: 'node', language: 'zh-CN', clipboard: { writeText: async () => {} } },
  performance,
  CustomEvent: class CustomEvent { constructor(t, o) { this.type = t; this.detail = o && o.detail; } },
  Blob: class Blob { constructor(p) { this.parts = p; } },
  URL: { createObjectURL: () => 'blob:guard', revokeObjectURL() {} },
  Audio: class Audio { play() {} pause() {} },
  Image: class Image { constructor() { this.src = ''; } },
  fetch: async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => '' }),
  alert() {}, confirm: () => false, prompt: () => null,
  console,
};

/** 有些内建全局（navigator / location）在 Node 里是只读 getter，赋值会直接抛 */
const setGlobal = (k, v) => { try { globalThis[k] = v; } catch { /* 只读就用 Node 自带的 */ } };

setGlobal('window', win);
setGlobal('document', doc);
setGlobal('self', win);
setGlobal('getComputedStyle', win.getComputedStyle);
setGlobal('matchMedia', win.matchMedia);
setGlobal('localStorage', localStorage);
setGlobal('requestAnimationFrame', raf);
setGlobal('cancelAnimationFrame', win.cancelAnimationFrame);
setGlobal('navigator', win.navigator);
setGlobal('location', win.location);
setGlobal('CustomEvent', win.CustomEvent);
setGlobal('Blob', win.Blob);
setGlobal('HTMLElement', class HTMLElement {});
setGlobal('Element', class Element {});
setGlobal('Node', class Node {});
setGlobal('Event', class Event { constructor(t) { this.type = t; } });
setGlobal('PointerEvent', class PointerEvent { constructor(t) { this.type = t; } });
setGlobal('MouseEvent', class MouseEvent { constructor(t) { this.type = t; } });

// ─────────────────────────────────────────────────────────
// 「日志印红、结论是绿」的收口（D35 近亲）
// 替身环境里渲染函数抛错本身是**预期**的（替身不是 DOM），但当场印一行 TypeError、
// 结论却是 failed:0，会让读者挑对自己有利的那个 ✗；更糟的是它掩盖**覆盖缺口** ——
// 那条渲染路径根本没走到最后一行 ✗。所以：收下每一条落进 GUARD_JSON（可断言 ✓），
// 重印时加 `[替身预期]` 前缀（一眼能分辨 ✓，且**不静默** ✗）。
// ─────────────────────────────────────────────────────────
const renderFailures = [];
const realConsoleError = console.error.bind(console);
console.error = (...a) => {
  const s = a.map((x) => (x && x.stack ? x.message : String(x))).join(' ');
  if (/\[slot\][^\n]*渲染失败/.test(s)) { renderFailures.push(s.trim()); realConsoleError('[替身预期] ' + s); return; }
  realConsoleError(...a);
};

// ─────────────────────────────────────────────────────────
// 真跑一遍引导：main.js 用同一批 ALL_PLUGINS 建 App、装插件、挂插槽
// ─────────────────────────────────────────────────────────
const out = { total: 0, installed: 0, failed: 0, skipped: 0, pluginCount: 0, listMismatch: false, failures: [], interaction: null, bootThrew: null };
try {
  const mod = await import('../src/main.js');
  const app = globalThis.window.xiaomo;
  out.pluginCount = Array.isArray(mod.ALL_PLUGINS) ? mod.ALL_PLUGINS.length : -1;
  out.listMismatch = !Array.isArray(mod.ALL_PLUGINS)
    || mod.ALL_PLUGINS.length !== ALL_PLUGINS.length
    || mod.ALL_PLUGINS.some((p, i) => p !== ALL_PLUGINS[i]);
  if (!app) {
    out.bootThrew = 'main.js 没有导出可用的 window.xiaomo（引导中断）';
  } else {
    const st = app.bootStats || (app.host && app.host.stats()) || {};
    Object.assign(out, { total: st.total, installed: st.installed, failed: st.failed, skipped: st.skipped || 0 });
    out.stats = st;
    out.failures = (app.host ? app.host.list() : [])
      .filter((r) => r.error)
      .map((r) => ({ id: r.id, error: r.error, enabled: r.enabled }));
    const rec = app.host && app.host.list().find((r) => r.id === 'xiaomo.ui.interaction');
    out.interaction = rec
      ? { id: rec.id, enabled: rec.enabled, installed: rec.installed, error: rec.error }
      : { id: 'xiaomo.ui.interaction', enabled: null, installed: null, error: '记录不存在' };
    out.interactionLive = !!(app.interaction && typeof app.interaction.setTool === 'function');
  }
} catch (err) {
  out.bootThrew = (err && err.message) || String(err);
  out.bootStack = String(err && err.stack).split('\n').slice(1, 5).join('\n');
}

// ─────────────────────────────────────────────────────────
// 只读清单：在真实宿主上验 T1 的契约
//
// 界面从此只读这份清单，所以「清单在真实 23 个插件上算得对不对、是不是真的改不动、
// 订阅者会不会被叫醒」必须由守卫机械证明，不能靠人眼看截图。
// 阶段词表在这里独立写一份字面量，是有意的：守卫要断言词汇表**恰好**是这五个词，
// 从被检查的模块里 import 词表就等于用同一个错误答案给自己判卷。
// ─────────────────────────────────────────────────────────
const PHASE_WORDS = ['pending', 'loading', 'active', 'failed', 'unloading'];
// 注意：`app` 是在上面那个 try 块里用 const 声明的，块外引用会直接 ReferenceError
// 把整个守卫打死（连 GUARD_JSON 都打不出来）。所以这里重新取一次同一个对象。
const appRef = globalThis.window && globalThis.window.xiaomo;
const recOf = (id) => (appRef && appRef.host ? appRef.host.list() : []).find((r) => r.id === id) || null;

if (appRef && appRef.inventory && appRef.host) {
  try {
    const snap = appRef.inventory.snapshot();
    const recs = appRef.host.list();
    const frozen = (fn) => { try { fn(); return 'mutable'; } catch { return 'frozen'; } };
    const inv = {
      total: snap.total,
      counts: snap.counts,
      countsKeys: Object.keys(snap.counts),
      itemCount: snap.items.length,
      allActive: snap.items.every((it) => it.phase === 'active'),
      allOffByNull: snap.items.every((it) => it.offBy === null),
      // 快照条目必须是拷贝而不是宿主记录本身，否则「只读」只是嘴上说说
      isCopy: !!(recs.length && snap.items.length && snap.items[0] !== recs[0]),
      frozenCounts: frozen(() => { snap.counts.pending = 99; }),
      frozenItems: frozen(() => { snap.items.push({}); }),
      unknownPhase: snap.items.filter((it) => !PHASE_WORDS.includes(it.phase)).map((it) => it.id),
    };

    // 订阅者真的会被叫醒，而且五个桶里那两个瞬时态确实报得出来。
    // 只订 plugin:changed 的话 loading / unloading 永远不可见 —— 那两个桶只在迁移途中存在。
    const seen = new Set();
    let pushes = 0;
    const off = appRef.inventory.onChange((s) => {
      pushes++;
      for (const k of Object.keys(s.counts)) if (s.counts[k] > 0) seen.add(k);
    });
    appRef.host.disable('xiaomo.ui.log', 'item');
    appRef.host.enable('xiaomo.ui.log');
    off();
    inv.subscriberPushed = pushes;
    inv.phasesSeen = [...seen].sort();
    const logRec = recOf('xiaomo.ui.log');
    inv.roundTripPhase = logRec && logRec.phase;
    inv.roundTripEnabled = logRec && logRec.enabled;
    out.inventory = inv;
  } catch (e) {
    out.inventory = { error: (e && e.message) || String(e), stack: String(e && e.stack).split('\n').slice(1, 4).join('\n') };
  }
}

// ─────────────────────────────────────────────────────────
// 渲染路径的覆盖证据（D35：**不抛 ≠ 走到了** ✗）
// 槽替身与渲染函数拿到的是**同一个对象**（main.js:116/133 用 `[data-slot="${name}"]`，
// persistEl 记忆化 ⇒ 同一个键同一个替身 ✓），所以「渲染函数真的跑到底」可以落在
// 可观测痕迹上：它建出来的节点 + 它注册上去的监听器 ✓
// （监听器正是 ui.log 渲染函数的**最后一行** —— 没有记录式 addEventListener 就无从判断 ✗）。
//
// task-43：痕迹必须**每个槽一条** ✓ —— 「该槽没有 renderFailures」不构成痕迹 ✗（那正是要挡的东西）。
// 每条痕迹都对准某个渲染函数的**真末行**（文件:行写在 what 里，逐个人工读过 ✓）：
// 只有执行到那里才会出现的效果，才叫「走到了」。凑数的痕迹比没有更坏 ✗（D44）。
// ─────────────────────────────────────────────────────────
const slotEl = (name) => doc.querySelector(`[data-slot="${name}"]`);
/** 子树：替身不解析 innerHTML，树很浅，但 append/prepend 出来的节点都在这里 ✓ */
const subtree = (e, out = []) => {
  for (const c of (e && e.children) || []) { out.push(c); subtree(c, out); }
  return out;
};
const lsCount = (e, type) => (e && e.__ls ? e.__ls.filter((l) => !type || l.type === type).length : 0);
const deepLs = (e, type) => subtree(e).reduce((n, c) => n + lsCount(c, type), 0);

const slotNames = (appRef && appRef.host && typeof appRef.host.slotNames === 'function')
  ? appRef.host.slotNames() : [];
const trace = {};
for (const name of slotNames) {
  const e = slotEl(name);
  // 条目级视图：main.js:176 的 _slotCache 记着「本轮被协调器认领的条目」及其产出节点 ✓
  const cache = (appRef && appRef._slotCache && appRef._slotCache.get(name)) || new Map();
  trace[name] = {
    children: e.children.length,
    deepNodes: subtree(e).length,
    listeners: lsCount(e),
    deepListeners: deepLs(e),
    textLen: [e, ...subtree(e)].reduce((n, x) => n + String(x.textContent || '').length, 0),
    entries: [...cache.entries()].map(([id, v]) => ({
      plugin: String(id).split('\u0000')[0],     // main.js:152 的身份 = pluginId\0seq\0key ✓
      nodes: v.nodes.length,
      listeners: v.nodes.reduce((n, x) => n + deepLs(x, null) + lsCount(x, null), 0),
      renderThrew: v.ok === false,
    })),
  };
}

/**
 * 逐槽「最后一行痕迹」表 ✓ —— 每条都是**只有执行到渲染函数末尾才会成立**的效果。
 * `floor: true` = 该数字是**替身下限**（替身不知道真实匹配数 ✗），只用来证明「走到了」✓。
 * `aggregate: true` = 该槽有多个条目，这条只证明「至少一个条目走到了」✗（比逐条目弱，如实标注 ✓）。
 */
const tailOf = {
  'topbar.tools': () => {          // ui.toolbar.js:76-77  $$('[data-tool]',host).forEach(b => b.addEventListener('click',…))
    const list = slotEl('topbar.tools').__subAll && slotEl('topbar.tools').__subAll.get('[data-tool]');
    const n = (list || []).reduce((s, b) => s + lsCount(b, 'click'), 0);
    return { what: 'ui.toolbar.js:76-77 [data-tool] 上各注册 click 监听（末行在迭代体里）', value: n, want: n >= 1, floor: true };
  },
  'topbar.actions': () => {        // ui.toolbar.js:48-52  五个 $('#'+id,host).addEventListener('click',…)
    const host = slotEl('topbar.actions');
    const ids = ['#btnRun', '#btnReset', '#btnUndo', '#btnRedo', '#btnSave', '#btnLoad', '#btnPng'];
    const hit = ids.filter((id) => lsCount(host.querySelector(id), 'click') >= 1);
    // ⚠ C9（k1-kernel）在 `#btnReset` 后插入 `#btnUndo`/`#btnRedo`（复用 .tb-btn，无新样式）⇒
    //   这一段整体下移，本锚点跟着从「五个按钮 :48-52」提到「七个按钮 :83-102」✓。
    //   这是**我的痕迹**⇒锚点随实现更新属正常维护 ✓（判据仍是「那条断言本来要抓的东西在不在」：
    //   它抓的是"渲染执行到了逐行注册监听的那一段"，七个按钮各自都注册上了，同一条断言仍成立 ✓）。
    return { what: 'ui.toolbar.js:83-102 七个按钮各自的 click 监听（逐行末段；C9 加入 #btnUndo/#btnRedo）', value: hit.length + '/' + ids.length, want: hit.length === ids.length };
  },
  'topbar.right': () => {          // ui.toolbar.js:112-130  #selPreset/#selSpeed 的 change 监听 + populatePresets()
    const host = slotEl('topbar.right');
    const a = lsCount(host.querySelector('#selPreset'), 'change');
    const b = lsCount(host.querySelector('#selSpeed'), 'change');
    // ⚠ B1（k1-kernel）把「慢动作」复选框换成了速度档 select：`#chkSlow` → `#selSpeed`。
    //   改前本锚点指着 `#chkSlow`，而它已不在 byId 里 ⇒ 替身走 `persistEl` 新建**空**元素
    //   ⇒ 该值恒 0（实测量到 "1/0"）。**是"恒 0"不是"刚好 0"** ⇒ 锚点过期，不是功能丢失 ✓。
    // ⚠ 本锚点在**末段**、非真末行（真末行是紧随其后的 `app.populatePresets()`）—— 如实标注 ✓。
    //   备选（锚 `populatePresets()` 的效果 + 给 bootApp 加计数器）**已否决** ✗：要动 boot 装配，
    //   比这里一行重。记在此处，免得下一个人再提一次。
    return {
      what: 'ui.toolbar.js:112-130 #selPreset 与 #selSpeed 的 change 监听（末段；B1：慢动作复选框 → 速度档 select；C9 后整体下移）',
      value: a + '/' + b, want: a >= 1 && b >= 1,
    };
  },
  'stage.overlay': () => {         // ui.themeswitch.js:84-86  theme.onChange(syncDots); buildDots(); host.appendChild(dots)
    const host = slotEl('stage.overlay');
    const dots = host.children.find((c) => c && c.className === 'theme-dots') || null;
    return {
      what: 'ui.themeswitch.js:86 末行 appendChild(dots)，且 :85 buildDots() 往 dots 里放了圆点',
      value: `${host.children.length}子/${dots ? dots.children.length : -1}点`,
      want: host.children.length >= 2 && !!dots && dots.children.length >= 1,
    };
  },
  'palette': () => {               // ui.palette.js:46-53  #paletteSearch 的 input + #paletteTabs button 的 click
    const host = slotEl('palette');
    const search = lsCount(host.querySelector('#paletteSearch'), 'input');
    const tabs = host.__subAll && host.__subAll.get('#paletteTabs button');
    const tabLs = (tabs || []).reduce((s, b) => s + lsCount(b, 'click'), 0);
    return {
      what: 'ui.palette.js:47/50 #paletteSearch 的 input + #paletteTabs button 的 click（均在最末段）',
      value: search + '/' + tabLs, want: search >= 1 && tabLs >= 1, floor: true,
    };
  },
  'sidebar.pane.log': () => {      // ui.log.js:26  bar.querySelector('#btnClearLog').addEventListener('click',…)
    const bar = slotEl('sidebar.pane.log').children.find((c) => c && c.className === 'log-bar') || null;
    const n = bar ? lsCount(bar.querySelector('#btnClearLog'), 'click') : 0;
    return { what: 'ui.log.js:26 #btnClearLog 的 click 监听（渲染函数末行）', value: n, want: n >= 1 };
  },
  'sidebar.pane.data': () => {     // ui.data.js:14  末行 ctx.app.data = new DataPanel(host, ctx.app)
    const host = slotEl('sidebar.pane.data');
    const ok = !!(appRef && appRef.data && appRef.data.el === host && typeof appRef.data.step === 'function');
    return { what: 'ui.data.js:14 末行赋值成功，且构造器收下的正是本槽', value: ok, want: ok === true };
  },
  'sidebar.pane.inspector': () => { // ui.inspector.js:14  末行 ctx.app.inspector = new Inspector(host, ctx.app)
    const host = slotEl('sidebar.pane.inspector');
    // ⚠ 按**真字段**判：Inspector 存的是 this.root（src/ui/inspector.js:12），不是 .el
    const ok = !!(appRef && appRef.inspector && appRef.inspector.root === host);
    return { what: 'ui.inspector.js:14 末行赋值成功，且构造器收下的正是本槽（this.root）', value: ok, want: ok === true };
  },
  'overlay': () => {               // 六个条目的聚合（settings/manager/pack/market/credit/desktop）
    const e = slotEl('overlay');
    const named = (trace.overlay.entries || []).filter((x) => x.listeners > 0).map((x) => x.plugin);
    return {
      what: 'overlay 的六个条目（注册点 src/plugins/ui.settings.js:100 / ui.manager.js:284 /'
        + ' system.pack.js:437 / ui.market.js:600 / system.credit.js:311 / system.desktop.js:150）'
        + '里**至少一个**在末段注册了监听器 —— 聚合口径，锚在注册点而非末行 ✗（如实标注）',
      value: named.length + ' 个条目有监听：' + (named.join('、') || '无'),
      want: named.length >= 1, aggregate: true,
    };
  },
};

const slotTail = {};
for (const name of slotNames) slotTail[name] = tailOf[name] ? tailOf[name]() : null;

out.slotNames = slotNames;
out.slotTail = slotTail;
out.renderTrace = trace;
out.renderFailures = renderFailures;
// ── 触控层的装配**真的跑了**吗（task-37）──────────────────────────
// 「闸门没红」不足以下这个结论 ✗ —— 闸门绿可以只是**没人跑** ✗。判据用宿主
// （src/main.js:97 的 bootTouch()）写下的观测键（src/ui/touch.js:413）✓：
// 只有「跑到了，并且状态落对了」才让它成立 ✓。
const dtDs = (doc.documentElement && doc.documentElement.dataset) || {};
out.touchLayer = dtDs.touchLayer || null;
out.touchSteps = dtDs.touchSteps || null;   // 形如 "theme>dock>drawers>" —— 依赖顺序的证据 ✓
out.touchMissing = dtDs.touchMissing || null;
out.touchError = dtDs.touchError || null;
// ── 属性 API 的**可达性**证明（task-37 续）────────────────────
// 闸门场景里 31 个内置插件都没有 pack ⇒ `src/ui/palette.js:149` 那条
// 「行复用后换成非器材包条目」的清理分支在场景里**不可达** ✗（实测计数为 0 ✓，如实记录 ✓）。
// 所以这里**直接驱动产品函数** `makeRow` + `paintRow` 把它逼出来 ✓。
// 口径必须说清 ✗：这**不是**经插件 setup 的完整路径 ✓，是直接调用产品函数 —— 但分支本身
// 是产品代码 ✓，而「替身能不能返回真值」正是由这条分支决定的 ✓。
{
  const { Palette } = await import('../src/ui/palette.js');
  const pal = Object.create(Palette.prototype);   // 不跑 constructor：它要 listEl + app，且会立刻 sync
  pal.app = {};
  const d = { type: '__attr_probe', name: '探针', icon: '·', desc: '', domain: 'physics' };
  const row = pal.makeRow(d);
  pal.paintRow(row, { ...d, pack: '__attr_probe_pack' });   // ⇒ setAttribute('data-pack','1')
  pal.paintRow(row, d);                                     // ⇒ hasAttribute 命中 ⇒ removeAttribute ✓
}
out.packAttrWrites = attrOps.get('setAttribute:data-pack') || 0;
out.packAttrCleanups = attrOps.get('removeAttribute:data-pack') || 0;
/**
 * 判据：**写入过、且随后被清理过** ✓。
 * 为什么不能只查「现在没有 data-pack」✗：地板替身下它也恒为「没有」✗ —— 两个世界读数相同，
 * 那条分支跑没跑根本分不出来 ✓。所以要的是**调用痕迹**，不是终态 ✓。
 */
out.packAttrOk = out.packAttrWrites >= 1 && out.packAttrCleanups >= 1;
out.attrOps = [...attrOps.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([k, v]) => `${k}=${v}`);
out.touchReady = out.touchLayer === 'ready';      // 只证明「写到了」✓
// 「写到了」**不等于**「全成了」✗ —— t1 的逐步 try/catch 会接住步骤异常，layer 照样 'ready' ✗。
// 所以再要两条：没有异常残留 ✓、步骤串里没有 '!' 记号 ✓（'!' 是 t1 专为「跑了但没装成」设计的 ✓）。
//
// ⚠ 判据边界 —— **看到这条红，先读这段再决定要不要「修」它** ✗：
//   ① `touchError` 在产品代码里是「**只在步骤抛异常时写、成功时不清**」（src/ui/touch.js:405）——
//      那是 t1 的写法，**不是本探针的缺陷** ✗：它有意把「这个 boot 里曾经抛过」留成痕迹 ✓；
//   ② 后果：若同一次 boot 里「先失败、后被 MutationObserver 重试救回来」，`touchError` 会留下
//      **陈旧**字符串 ⇒ 本判据那时会**红** ✓ —— **这是有意的**：一个曾经装不成的 boot
//      不该被算成健康 ✓（宁可红，也不要把它读成「从来没问题」✗）；
//   ③ 同时说清它**不是**产品缺陷：`readyState !== 'loading'` ⇒ 闸门里 boot 只跑一次 ⇒ 本批不涉及 ✓。
//   ⇒ 因此：**不要**去改 `touchError` 的清除逻辑来让它变绿 ✗ —— 那是改产品行为，不是修闸门 ✗。
out.touchStepsBad = typeof out.touchSteps === 'string' && out.touchSteps.includes('!');
out.touchOk = out.touchReady === true && out.touchError === null && out.touchStepsBad === false;
// 「没有痕迹表的槽」与「痕迹不成立的槽」分开报：前者是我没做到 ✗，后者是覆盖缺口 ✗ —— 都不许静默变绿。
out.tailMissing = slotNames.filter((n) => !slotTail[n]);
out.tailBad = slotNames.filter((n) => slotTail[n] && slotTail[n].want !== true);
out.renderOk = renderFailures.length === 0
  && slotNames.length >= 9                       // 空集合会让 every() 恒真（D35）✗ ⇒ 先证明集合非空且足量
  && out.tailMissing.length === 0
  && out.tailBad.length === 0
  && out.touchOk === true                        // 装配跑到了、三步全成了、没有异常残留 ✓
  && out.packAttrOk === true;                    // 属性替身能返回真值 ⇒ palette 的清理分支真的跑到了 ✓

console.error = realConsoleError;   // 替身期结束，输出恢复原样（前缀只作用于替身期）

if (!quiet) {
  console.error('[guard] 装载结果：'
    + `${out.installed}/${out.total} 装载成功，失败 ${out.failed} 个`);
  for (const f of out.failures) console.error(`[guard]   失败：${f.id} — ${f.error}`);
  if (out.bootThrew) console.error('[guard] 引导异常：' + out.bootThrew + (out.bootStack ? '\n' + out.bootStack : ''));
  // 结论落在「渲染路径走到了」上，不是「没抛」✗ —— 与 GUARD_JSON 里的字段同源 ✓
  console.error('GUARD_RENDER ' + (out.renderOk ? 'ok' : 'FAIL')
    + ` 渲染失败=${renderFailures.length} 槽=${slotNames.length}`
    + ` 无痕迹=${out.tailMissing.length} 痕迹不成立=${out.tailBad.length}`
    + ` 触控层=${out.touchLayer || '✗未装配'} 步骤=${out.touchSteps || '✗'} 触控判据=${out.touchOk ? 'ok' : 'FAIL'}`
    + ` 触控异常=${out.touchError || '无'}`
    + ` data-pack=写${out.packAttrWrites}/清${out.packAttrCleanups}${out.packAttrOk ? '✓' : '✗'}`);
  for (const name of slotNames) {
    const t = out.slotTail[name];
    console.error(`[guard]   痕迹 ${name}：`
      + (t ? `${t.want === true ? 'ok' : 'FAIL'} ${JSON.stringify(t.value)} — ${t.what}` : '（无痕迹表项 ✗）'));
  }
}

// 只输出一行 JSON，给 tools/check.mjs 的守卫断言读
console.log('GUARD_JSON ' + JSON.stringify(out));
// 渲染路径没走到底 ⇒ 退出码非零：替身缺口是**覆盖缺口**，不能只印一行 ✗（绿时仍是 0 ✓）。
process.exit(out.renderOk ? 0 : 1);
