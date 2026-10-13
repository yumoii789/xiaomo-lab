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
    setAttribute() {}, getAttribute: () => null, removeAttribute() {}, hasAttribute: () => false,
    appendChild(c) { this.children.push(c); this.childNodes.push(c); if (c) c.parentNode = this; return c; },
    insertBefore(c) { this.children.unshift(c); this.childNodes.unshift(c); return c; },
    removeChild() {}, replaceChildren() {}, remove() {}, cloneNode() { return makeEl(tag); },
    addEventListener() {}, removeEventListener() {}, dispatchEvent: () => true,
    querySelector: () => null, querySelectorAll: () => [],
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
  if (!slotEls.has(key)) slotEls.set(key, makeEl('div'));
  return slotEls.get(key);
};
const queryOne = (sel) => {
  const s = String(sel).trim();
  if (s.startsWith('#') && !s.includes(' ')) return byId[s.slice(1)] || null;
  for (const e of Object.values(byId)) {
    if (e.className && s.includes('.' + e.className)) return e;
    if (e.textContent && s.includes(e.textContent)) return e;
  }
  // data-slot="xxx" 这类：给一个稳定可复用的元素替身（插槽渲染要用它当容器）
  if (/^\[data-slot=/.test(s)) return persistEl(s);
  return null;
};
const queryAll = (sel, root) => {
  if (sel === 'button' && root === sideTabs) return tabBtns;
  if (sel === '#sidebar .pane' || sel === '.pane') return panes;
  return [];
};
for (const e of Object.values(byId)) {
  e.querySelector = (s) => queryOne(s) || persistEl(String(s));
  e.querySelectorAll = (s) => queryAll(s, e);
}

const doc = {
  body: makeEl('body'),
  head: makeEl('head'),
  documentElement: makeEl('html'),
  getElementById: (id) => byId[id] || (byId[id] = el('div', id)),
  querySelector: (s) => queryOne(s) || makeEl(),
  querySelectorAll: (s) => queryAll(s),
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

if (!quiet) {
  console.error('[guard] 装载结果：'
    + `${out.installed}/${out.total} 装载成功，失败 ${out.failed} 个`);
  for (const f of out.failures) console.error(`[guard]   失败：${f.id} — ${f.error}`);
  if (out.bootThrew) console.error('[guard] 引导异常：' + out.bootThrew + (out.bootStack ? '\n' + out.bootStack : ''));
}

// 只输出一行 JSON，给 tools/check.mjs 的守卫断言读
console.log('GUARD_JSON ' + JSON.stringify(out));
process.exit(0);
