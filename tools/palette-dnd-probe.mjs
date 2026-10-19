// ══════════════════════════════════════════════════════════
// tools/palette-dnd-probe.mjs —— 器材栏「拖出落位」的正式验证工具
//
// 为什么必须存在：这一条功能**改的是一条坐标契约**（手指在哪 ⇒ 器材落在哪）。
//   · 落点错了，器材会落在「看得见但点不中」的地方 —— 与平移/缩放那类缺陷同族；
//   · 而它同时要**不弄坏另外两条**：点击落位（freeSpot 避让）与触屏上滑动列表。
//   三者互相拉扯，谁只做一半都可能全绿而功能错，所以判据必须把三条一起钉住。
//
// 零浏览器：整条链路是「Pointer Events 状态机 + screenToWorld + 注册表」，
//   在 Node 里给一小撮 DOM 替身就能断言。因此这里不启任何可见窗口
//   （本机在公共场所），也不碰仓库任何中间产物 —— 只有读。
//
// ⚠ 跨元素指针路由（指针离开 #palette 落到 #drawerMask 上之后事件去哪了）
//   这种**真实事件模型**才说得清的问题，本文件只做「setPointerCapture 被调用」
//   这一层的断言；真浏览器里由 tools/touch-probe.html 那一类 iframe 探针复核。
//   哪些必须真浏览器、见交付说明里的清单。
//
// 用法：
//   node tools/palette-dnd-probe.mjs              # 全部断言
//   node tools/palette-dnd-probe.mjs --mutate     # 变异体自证：每个变异体只准打红它该打红的那几条
// 绿：全部通过：N 项（exit 0）／红：合计 N 项，失败 M 项（exit 1）
// ══════════════════════════════════════════════════════════

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TMP = process.env.TEMP ? process.env.TEMP.replace(/\\/g, '/') : '/tmp';
const MUT = process.argv.includes('--mutate');

// ══════════════════════════════════════════════════════════
// 0. DOM 替身：只做 Palette 真正用到的那一小撮
//    （与 pan-probe 的 mkCanvas 同一路数：替身越小，误报越少）
// ══════════════════════════════════════════════════════════

class El {
  constructor(tag) {
    this.tagName = String(tag || 'div').toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.attributes = {};
    this.dataset = {};
    this.style = {};
    this.textContent = '';
    this._listeners = {};
    this._cls = new Set();
    const self = this;
    this.classList = {
      add: (...cs) => cs.forEach((c) => self._cls.add(c)),
      remove: (...cs) => cs.forEach((c) => self._cls.delete(c)),
      contains: (c) => self._cls.has(c),
      toggle: (c, on) => { const want = on === undefined ? !self._cls.has(c) : !!on; if (want) self._cls.add(c); else self._cls.delete(c); return want; },
    };
  }
  get className() { return [...this._cls].join(' '); }
  set className(v) { this._cls = new Set(String(v).split(/\s+/).filter(Boolean)); }
  get firstChild() { return this.children[0] || null; }
  get lastChild() { return this.children[this.children.length - 1] || null; }
  get firstElementChild() { return this.children[0] || null; }
  get lastElementChild() { return this.children[this.children.length - 1] || null; }
  get nextSibling() {
    if (!this.parentNode) return null;
    const i = this.parentNode.children.indexOf(this);
    return i < 0 ? null : (this.parentNode.children[i + 1] || null);
  }
  appendChild(n) {
    if (n.parentNode) n.remove();
    n.parentNode = this;
    this.children.push(n);
    return n;
  }
  append(...ns) { ns.forEach((n) => this.appendChild(n)); }
  insertBefore(n, ref) {
    if (n.parentNode) n.remove();
    n.parentNode = this;
    const i = ref ? this.children.indexOf(ref) : -1;
    if (i < 0) this.children.push(n); else this.children.splice(i, 0, n);
    return n;
  }
  remove() {
    if (!this.parentNode) return;
    const i = this.parentNode.children.indexOf(this);
    if (i >= 0) this.parentNode.children.splice(i, 1);
    this.parentNode = null;
  }
  setAttribute(k, v) { this.attributes[k] = String(v); if (k === 'id') this.id = String(v); }
  getAttribute(k) { return k in this.attributes ? this.attributes[k] : null; }
  hasAttribute(k) { return k in this.attributes; }
  removeAttribute(k) { delete this.attributes[k]; }
  addEventListener(t, fn, opts) { (this._listeners[t] ||= []).push({ fn, opts }); }
  removeEventListener(t, fn) {
    const a = this._listeners[t]; if (!a) return;
    this._listeners[t] = a.filter((x) => x.fn !== fn);
  }
  /** 派发一次事件：事件对象由调用方给（探针要的就是「谁收到、收到什么」） */
  fire(type, ev = {}) {
    const a = this._listeners[type] || [];
    ev.type = type;
    ev.target = ev.target || this;
    ev.currentTarget = this;
    if (!ev.preventDefault) ev.preventDefault = () => { ev.defaultPrevented = true; };
    if (!ev.stopPropagation) ev.stopPropagation = () => {};
    let prevented = false;
    for (const { fn } of a) fn(ev);
    return ev;
  }
  /** 记录 click 被调用（collapseDrawer 走的就是这条路） */
  click() { this.clicked = (this.clicked || 0) + 1; this.fire('click', {}); }
  getBoundingClientRect() { return { left: 0, top: 0, width: 320, height: 500 }; }
  setPointerCapture(id) { this.captured = id; (this.captureCalls = (this.captureCalls || 0) + 1); }
  releasePointerCapture(id) { this.released = id; }
}

function mkDocument() {
  const body = new El('body');
  const byId = new Map();
  const doc = {
    body,
    _byId: byId,
    createElement: (t) => new El(t),
    getElementById: (id) => {
      const found = byId.get(id);
      return found && found.parentNode ? found : (found || null);
    },
    querySelector: (sel) => {
      const m = /^#([\w-]+)$/.exec(sel);
      if (m) { const e = byId.get(m[1]); return (e && inTree(e, body)) ? e : null; }
      return null;
    },
  };
  return doc;
}
function inTree(node, root) {
  let n = node;
  while (n) { if (n === root) return true; n = n.parentNode; }
  return false;
}

let DOC = mkDocument();
globalThis.document = DOC;
globalThis.localStorage = {
  _d: {},
  getItem(k) { return k in this._d ? this._d[k] : null; },
  setItem(k, v) { this._d[k] = String(v); },
  removeItem(k) { delete this._d[k]; },
};

// ── window / canvas / 2D 上下文替身（Engine 要的那一份，照 pan-probe）──
const WIN = {
  innerWidth: 1280, innerHeight: 800, devicePixelRatio: 1,
  matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
  _ev: {},
  addEventListener(t, fn) { (WIN._ev[t] ||= []).push(fn); },
  removeEventListener() {},
};
globalThis.window = WIN;
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);

function mkCanvas(w = 800, h = 600) {
  const g = {
    canvas: null,
    setTransform: () => {}, translate: () => {}, clearRect: () => {},
    save: () => {}, restore: () => {}, scale: () => {},
  };
  for (const k of ['beginPath', 'moveTo', 'lineTo', 'arc', 'arcTo', 'stroke', 'fill', 'closePath',
    'quadraticCurveTo', 'rotate', 'fillRect', 'setLineDash', 'measureText', 'fillText', 'clip',
    'rect', 'ellipse', 'bezierCurveTo', 'roundRect']) g[k] = () => {};
  g.createLinearGradient = () => ({ addColorStop() {} });
  const cv = {
    width: 0, height: 0, style: {}, _listeners: {},
    getContext: () => g,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: w, height: h }),
    addEventListener(t, fn) { (cv._listeners[t] ||= []).push(fn); },
    removeEventListener() {},
    hasPointerCapture: () => false,
    setPointerCapture() {}, releasePointerCapture() {}, focus() {},
  };
  g.canvas = cv;
  return cv;
}

// ══════════════════════════════════════════════════════════
// 1. 载入产品模块
// ══════════════════════════════════════════════════════════

const { Engine } = await import(pathToFileURL(join(ROOT, 'src/core/engine.js')).href);
const { World } = await import(pathToFileURL(join(ROOT, 'src/core/world.js')).href);
const { create: mkEnt, bindRegistry, equipmentPlugins } = await import(pathToFileURL(join(ROOT, 'src/equipment/index.js')).href);
const { PluginHost } = await import(pathToFileURL(join(ROOT, 'src/core/plugin.js')).href);

const bootApp = {
  services: {}, ticks: [], world: null, selected: null,
  log: { push() {}, clear() {} }, toast() {}, addTick(fn) { this.ticks.push(fn); return () => {}; },
};
{
  const host = new PluginHost(bootApp);
  for (const p of equipmentPlugins) host.define(p);
  host.installAll();
  bindRegistry(host.registry('equipment'));
}

// ══════════════════════════════════════════════════════════
// 2. 源码：读原文件 / 造变异体（写 %TEMP%，仓库零字节副作用）
// ══════════════════════════════════════════════════════════

const PALETTE_REL = 'src/ui/palette.js';
const srcRaw = readFileSync(join(ROOT, PALETTE_REL), 'utf8');
const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

/** 剥注释：与全仓探针同一口径（行首注释 + 整行 * 或 /*） */
const stripComments = (s) => s.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

/** 取一个**方法定义**的源码切片（从定义点走到它自己的收尾 `\n  }`）。
 *  用于对**代码**（而不是全文）做静态判据 —— 全文里注释会写满 pan/zoom，
 *  拿全文去匹配只会得到假绿。
 *
 * ⚠ 这里**不能**用 `src.indexOf(name + '(')`：那是「第一次文本出现」，而
 *   `dropWorld` 在文件里第一次出现是**调用点**（onRowDown 里的
 *   `this.dropWorld(st, ev)`），不是定义点。锚错在调用点上会切出一段既没有
 *   `screenToWorld(` 也没有 `pan` 的「函数体」，于是断言以**提取失败**的样子红掉，
 *   伪装成「产品有问题」—— 与假绿方向相反、代价一样。
 *   （元教训 AV：定位一个符号时「第一次文本出现」≠「定义点」；注释、调用点、
 *     字符串都是「看起来能对上」的噪声锚。）
 *  所以锚落在**声明形状**上：行首两空格起、可选 async、名字后紧跟 `(`。
 *
 * 返回对象而不是字符串：把「取到的是不是定义」这件事**变成可断言的字段**，
 * 否则「提取失败」会继续伪装成「断言失败」。没找到定义时返回 null。 */
function methodBody(src, name) {
  const re = new RegExp('^\\s{2}(?:async\\s+)?' + name + '\\s*\\(', 'm');
  const m = re.exec(src);
  if (!m) return null;
  const j = src.indexOf('\n  }', m.index);
  const body = j < 0 ? src.slice(m.index) : src.slice(m.index, j);
  return {
    body,
    line: src.slice(0, m.index).split('\n').length,
    // 定义体一定含 `{`，且**不该**含「调用自己」的形状（含了就是锚到调用点上去了）
    looksLikeDef: body.includes('{') && !body.includes('this.' + name + '('),
  };
}

/**
 * 变异体写进 %TEMP% ⇒ **它自己带的每一条相对 import 都必须改写成绝对 file:// URL**，
 * 否则 import 会在解析阶段抛 ERR_MODULE_NOT_FOUND，**在打印任何 JSON 之前就死掉**
 * （本仓已踩过两次：photoresistor-probe 漏 2 条、本题最初版本同样）。
 * 这里从源码里**动态枚举**相对 import，而不是写死一张表 —— 写死的表将来会漏。
 */
function absImports(code) {
  return code.replace(/(from\s*)(['"])(\.{1,2}\/[^'"]+)\2/g, (m, pre, q, spec) => {
    const abs = new URL(spec, pathToFileURL(join(ROOT, PALETTE_REL)).href).href;
    return pre + q + abs + q;
  });
}

const MUTANTS = [
  {
    // ⓘ 这一条**实测打不红 W2**，是有意义的发现而不是缺陷：
    //   pan-only 的引擎里 `screen - pan` 与 `screenToWorld(screen)` **代数上完全相同**，
    //   所以数值断言原理上就看不见这个替换。它会红的只有 W0（静态：必须经由
    //   screenToWorld 且不许自己碰 pan）—— 而 W0 正是「引擎加上 zoom 之后仍然对」
    //   这句承诺的唯一守卫。把它记在 breaks 里，就等于承认这一条只有静态断言守得住。
    id: 'M1-raw-pan',
    why: '落点自己减 pan，绕开 engine.screenToWorld（今天算得出同一个数，引擎加上 zoom 后必错）',
    old: 'return eng.screenToWorld(sx, sy);',
    neu: 'return { x: sx - (eng.pan ? eng.pan.x : 0), y: sy - (eng.pan ? eng.pan.y : 0) };',
    breaks: ['W0'],
  },
  {
    // 与 M1 配对：证明 W2 那条**数值**断言不只是摆设 —— 它真的在量 pan 的关系。
    // 刻意不写 `eng.pan`，让 W0 保持绿，这样两条各自只打红自己那一条。
    id: 'M1b-pan-sign',
    why: 'pan 的方向写反（屏幕-世界的关系反了）',
    old: 'return eng.screenToWorld(sx, sy);',
    neu: 'const _p = eng.screenToWorld(0, 0); return { x: sx - _p.x, y: sy - _p.y };',
    breaks: ['W2'],
  },
  {
    id: 'M2-ignore-point',
    why: '拖放不认落点，退回点击落位（freeSpot 自己挑位置）',
    old: '    const ent = this.place(d, x, y);',
    neu: '    const ent = this.place(d);',
    breaks: ['W1', 'W2'],
  },
  {
    // 第一版我写成 `if (false)`，方向搞反了：那等于**彻底不装长按**，
    // 于是滑动列表那条（G1）反而更绿了。真正要证明的是「不等长按就进拖拽」，
    // 所以改成把「滑动列表」的取消动作换成「进入拖拽」。
    id: 'M3-swipe-arms',
    why: '触屏不等长按：手指一划就进入拖拽（滑动列表被误判成拖出）',
    old: 'if (far > SLOP) this.endDrag();',
    neu: 'if (far > SLOP) this.armDrag(st);',
    breaks: ['G1'],
  },
  {
    id: 'M4-ghost-leak',
    why: 'pointercancel 后不收幽灵（屏幕上留一个永远挂着的影子）',
    old: '    if (this.ghost) { this.ghost.remove(); this.ghost = null; }',
    neu: '',
    breaks: ['C2', 'O1'],     // O1 的判据里也含「收干净」，它跟着红是**应该**红的
  },
  {
    id: 'M5-ignore-pref',
    why: '无视设置项，放手一律收起抽屉（默认 B 被改掉）',
    old: '    if (readDropCollapse()) this.collapseDrawer();',
    neu: '    this.collapseDrawer();',
    breaks: ['S1'],
  },
  {
    id: 'M6-no-bounds',
    why: '不判「松手在不在画布上」，拖回器材栏也照样投放',
    old: '    if (sx < 0 || sy < 0 || sx > r.width || sy > r.height) return null;',
    neu: '',
    breaks: ['O1'],
  },
  {
    id: 'M7-double-add',
    why: '拖出后不吃掉那次 click（一次拖动落两件器材）',
    old: '    this.suppressClick = true;',
    neu: '',
    breaks: ['D2'],
  },
  {
    // 拆成两条，因为「挡住浏览器滚动」这件事有两个独立的失败面：
    // 监听器是不是非被动（G2 管），以及非被动时到底有没有 preventDefault（G2b 管）。
    id: 'M8-no-preventdefault',
    why: '非被动监听器留着，但不再 preventDefault（拖到一半被浏览器接管、手势被掐断）',
    old: '      if (this.drag && this.drag.armed && e.preventDefault) e.preventDefault();',
    neu: '',
    breaks: ['G2b'],
  },
  {
    id: 'M8b-passive',
    why: '监听器改成被动的（passive:false 被拿掉 ⇒ preventDefault 静默失效，且不报错）',
    old: '    }, { passive: false });',
    neu: '    }, { passive: true });',
    breaks: ['G2'],
  },
  {
    // 证明「抓住指针」这件事被**行为**钉住了，不只是字符串检查（A2 会跟着红）。
    id: 'M9-no-capture',
    why: '不抓指针（指针离开器材栏后 move/up 会落到 #drawerMask 上，拖出被误判成点遮罩）',
    old: '    try { if (st.row.setPointerCapture) st.row.setPointerCapture(st.id); } catch (e) { /* 无指针 API 的环境 */ }',
    neu: '',
    breaks: ['A2', 'A2b'],
  },
];

/** 把一条变异落到源码上，并**实测自证**它真的落进去了（不许硬编码 true） */
function applyMutant(m) {
  const nOldCode = stripComments(srcRaw).split(m.old).length - 1;
  const nOldRaw = srcRaw.split(m.old).length - 1;
  const mutated = srcRaw.replace(m.old, m.neu);
  const mCode = stripComments(mutated);
  const appliedClean = mutated !== srcRaw && mCode.split(m.neu || '\u0000').length - 1 === 1;
  const landInCode = nOldRaw === 1 && nOldCode === 1 && !mCode.includes(m.old);
  return { mutated, landInCode, appliedClean, nOldRaw, nOldCode };
}

async function loadPalette(code, tag) {
  if (code === srcRaw) return import(pathToFileURL(join(ROOT, PALETTE_REL)).href);
  const file = join(TMP, `xm-palette-mutant-${tag}-${Date.now()}.mjs`);
  writeFileSync(file, absImports(code), 'utf8');
  return import(pathToFileURL(file).href);
}

// ══════════════════════════════════════════════════════════
// 3. 断言小工具
// ══════════════════════════════════════════════════════════

let PASS = 0, FAIL = 0;
let results = new Map();
const ok = (id, cond, msg) => {
  results.set(id, !!cond);
  if (cond) { PASS++; console.log('  \x1b[32m✓\x1b[0m ' + msg); }
  else { FAIL++; console.log('  \x1b[31m✗\x1b[0m ' + msg); }
};
const head = (t) => console.log('\n\x1b[36m' + t + '\x1b[0m');
const info = (t) => console.log('    · ' + t);

// ══════════════════════════════════════════════════════════
// 4. 把一次完整场景搭起来（每个场景都用干净状态，避免互相污染）
// ══════════════════════════════════════════════════════════

function mkScene(PaletteClass, opts = {}) {
  const cv = mkCanvas(opts.cw || 800, opts.ch || 600);
  const world = new World();
  const eng = new Engine(cv, world);
  eng.app = { markDirty() {} };
  if (opts.pan) { eng.pan.x = opts.pan.x; eng.pan.y = opts.pan.y; }

  // 器材栏容器：Palette 的 this.el 就是 .pal-list（见 src/plugins/ui.palette.js）
  const list = DOC.createElement('div');
  list.className = 'pal-list';
  const palHost = DOC.createElement('aside');
  palHost.setAttribute('id', 'palette');
  palHost.appendChild(list);
  DOC.body.appendChild(palHost);

  // 抽屉按钮与遮罩：collapseDrawer 走的就是 #btnPalette 的 click
  const btn = DOC.createElement('button');
  btn.setAttribute('id', 'btnPalette');
  DOC.body.appendChild(btn);
  const mask = DOC.createElement('div');
  mask.setAttribute('id', 'drawerMask');
  DOC.body.appendChild(mask);
  DOC._byId.set('palette', palHost);
  DOC._byId.set('btnPalette', btn);
  DOC._byId.set('drawerMask', mask);

  const calls = { addEntity: [], toast: [] };
  const app = {
    canvas: cv, world, engine: eng,
    addEntity(type, x, y) {
      calls.addEntity.push({ type, x, y });
      const placed = (x === undefined || y === undefined) ? { ...mkEnt(type, 0, 0), x: -1, y: -1, free: true } : { type, x, y, free: false };
      if (x === undefined || y === undefined) return { type, x: 111, y: 222, free: true };
      return placed;
    },
    toast(m) { calls.toast.push(m); },
    select() {}, markDirty() {},
  };
  const pal = new PaletteClass(list, app);
  return { cv, eng, app, pal, calls, list, palHost, btn, mask };
}

/** 合成一次指针事件（只给 Palette 真正读的那几个字段） */
const pev = (type, o) => ({ type, pointerId: o.id === undefined ? 1 : o.id, pointerType: o.pt || 'touch', button: o.button === undefined ? 0 : o.button, clientX: o.x, clientY: o.y });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** 独立复算「屏幕 → 世界」：按 canvas 的 translate 语义（屏幕 = 世界 + pan）反推。
 *  **刻意不照抄 engine.screenToWorld 的写法** —— 两边用同一条式子会让「方向写反」
 *   一起反、测试全绿而功能全错（pan-probe 第一版就是这么错的）。 */
const worldOf = (sx, sy, pan) => ({ x: sx - pan.x, y: sy - pan.y });
const snap = (v) => Math.round(v / 4) * 4;

/** 行上的指针序列。rows 由 Palette 自己建，这里从 list 里取第一行。 */
function firstRow(list) {
  const cat = list.children.find((c) => c.className.includes('pcat'));
  if (!cat) return null;
  return cat.children.find((c) => c.className.includes('pitem')) || null;
}

// ══════════════════════════════════════════════════════════
// 5. 全部断言
// ══════════════════════════════════════════════════════════

/**
 * @param srcText **当前被测那一份** palette.js 的源码。
 *   必须由调用方传进来，绝对不许在这里写 `srcRaw` —— 静态断言若读原始文件，
 *   它在变异体下永远是绿的，也就是**永远不可能红**（本次实测：M1 该红 W0 没红、
 *   M9 该红 A2 没红，两条都是这个原因）。静态断言也是断言，它必须读被测对象。
 */
async function runAll(PaletteClass, api, srcText) {
  PASS = 0; FAIL = 0; results = new Map();
  DOC = mkDocument();
  globalThis.document = DOC;

  // ── ① 静态接线：两条既有路径没被拆掉，新路径的参数与既有定义对齐 ──
  head('① 接线（静态读源码 + 与既有定义对齐）');
  {
    const palSrc = srcText;      // ← 被测那一份（变异体下就是变异后的源码）
    // ⚠ 静态判据一律打在**去注释**的源码上。
    //   实测教训：A2 原来是 `/setPointerCapture/.test(palSrc)`，而 armDrag 的文档注释里
    //   明写着「必须 setPointerCapture」—— 于是**把实现那一行整行删掉，A2 依然是绿的**：
    //   注释替代码把断言满足了。注释是「看起来能对上」的噪声锚（元教训 AV），
    //   拿它当证据等于没有断言。变异体 M9 就是专门来踩这一条的。
    const palCode = stripComments(palSrc);
    ok('A1', /addEventListener\('pointerdown'/.test(palCode) && /addEventListener\('pointercancel'/.test(palCode),
      '器材行装上了 pointerdown / pointercancel（去注释后仍在代码里）');
    ok('A2', /setPointerCapture/.test(palCode),
      '拖拽成立时 setPointerCapture（不抓指针就会被 #drawerMask 抢走 move/up）');
    ok('A3', /addEventListener\('click'/.test(palCode) && /addEventListener\('keydown'/.test(palCode),
      'click 与 keydown 两条既有入口都还在（键盘可达性未退化）');

    // 长按阈值必须与 src/ui/touch.js 一致 —— 同一个产品里两个长度不同的长按会显得坏掉
    const touchSrc = readFileSync(join(ROOT, 'src/ui/touch.js'), 'utf8');
    const tMs = Number((/const LONG_PRESS_MS = (\d+)/.exec(touchSrc) || [])[1]);
    const pMs = Number((/export const LONG_PRESS_MS = (\d+)/.exec(palSrc) || [])[1]);
    ok('A4', pMs === tMs && pMs > 0,
      `长按阈值与 touch.js 同值（palette ${pMs}ms ⟷ touch.js ${tMs}ms）`);
    const tSlop = Number((/const LONG_PRESS_SLOP = (\d+)/.exec(touchSrc) || [])[1]);
    const pSlop = Number((/export const SLOP = (\d+)/.exec(palSrc) || [])[1]);
    ok('A5', pSlop === tSlop && pSlop > 0,
      `长按抖动容忍与 touch.js 同值（palette ${pSlop}px ⟷ touch.js ${tSlop}px）`);

    // 吸附步长必须与 interact.js 的 SNAP 同源
    const interSrc = readFileSync(join(ROOT, 'src/ui/interact.js'), 'utf8');
    const iSnap = Number((/const SNAP = (\d+)/.exec(interSrc) || [])[1]);
    const pSnap = api.SNAP;
    ok('A6', pSnap === iSnap, `落点吸附步长与 interact.js 同源（palette ${pSnap} ⟷ interact.js ${iSnap}）`);

    // 偏好键：palette.js 是唯一真源，设置面板必须引用它而不是另抄一份
    const setSrc = readFileSync(join(ROOT, 'src/plugins/ui.settings.js'), 'utf8');
    ok('A7', setSrc.includes('DROP_COLLAPSE_KEY') && /import\s*\{[^}]*DROP_COLLAPSE_KEY[^}]*\}\s*from\s*'\.\.\/ui\/palette\.js'/.test(setSrc),
      `设置面板从 palette.js 引入 ${api.DROP_COLLAPSE_KEY}（不是另抄一份键名）`);
    ok('A8', setSrc.includes('setRowDropCollapse'),
      '设置面板里有 #setRowDropCollapse 这一行开关');
    ok('A9', /export const DROP_COLLAPSE_KEY = 'xiaomo\.palette\.drop\.v1'/.test(palCode),
      '偏好键字面量就是 xiaomo.palette.drop.v1');

    // ── W0：落点换算**必须**经由 engine.screenToWorld，且不许自己碰 pan ──
    // 为什么非要有这条静态判据：pan-only 的引擎里 `screen - pan` 与
    // `screenToWorld(screen)` 算出来**一模一样**，所以任何数值断言都抓不到这个替换。
    // 而它是**明天就错**的那种写法 —— 引擎一旦有 zoom，世界 =（屏幕 − pan）/ zoom。
    // 数值断言守今天，这条守将来；两者都必要。
    const dw = methodBody(palSrc, 'dropWorld');
    ok('W0a', !!dw && dw.looksLikeDef,
      `能按**声明形状**取到 dropWorld 的定义体（锚在第 ${dw ? dw.line : '?'} 行，不是调用点）`);
    const dbody = stripComments(dw ? dw.body : '');
    const hasCall = dbody.includes('screenToWorld(');
    const hasPan = /\bpan\b/.test(dbody);
    ok('W0', !!dw && dw.looksLikeDef && hasCall && !hasPan,
      `dropWorld 里出现 screenToWorld( 且**不出现** pan（自己减 pan 就是「看得见但点不中」的下一个来源）`);
    info(`dropWorld 定义体在第 ${dw ? dw.line : '?'} 行，去注释后：含 screenToWorld=${hasCall}，含 pan=${hasPan}`);
  }

  // ── ② 拖出落位：世界坐标必须与放手点吻合（pan=0）──
  head('② 拖出落位：落点 = 放手点（pan = 0,0）');
  let w1 = null;
  {
    const s = mkScene(PaletteClass);
    const row = firstRow(s.list);
    const pan = { x: 0, y: 0 };
    const dropX = 400, dropY = 300;
    const exp = worldOf(dropX, dropY, pan);
    row.fire('pointerdown', pev('pointerdown', { x: 100, y: 200, pt: 'mouse' }));
    row.fire('pointermove', pev('pointermove', { x: 110, y: 205, pt: 'mouse' }));   // 过 DRAG_SLOP 才成立
    row.fire('pointerup', pev('pointerup', { x: dropX, y: dropY, pt: 'mouse' }));
    const call = s.calls.addEntity[s.calls.addEntity.length - 1];
    w1 = call;
    ok('W1', !!call && call.x === snap(exp.x) && call.y === snap(exp.y),
      `放手点 (${dropX},${dropY}) ⇒ 世界 (${exp.x},${exp.y}) ⇒ 放下的器材在 (${call && call.x},${call && call.y})（吸附步长 ${api.SNAP}）`);
    info(`实测数字：屏幕 (${dropX},${dropY}) → 落位 (${call && call.x},${call && call.y})；期望 world=(${exp.x},${exp.y}) snap=(${snap(exp.x)},${snap(exp.y)})`);
    // 落点必须真的进了世界，而不是只塞给 addEntity
    ok('W1b', !!call && call.type === row.dataset.type, `落下的就是被拖的那一件（type=${call && call.type}）`);
  }

  // ── ③ pan ≠ 0：仍然吻合 ⇒ 证明走的是 screenToWorld ──
  head('③ pan ≠ 0 时仍然吻合（走的是 screenToWorld，不是自己减 pan）');
  let w2 = null;
  {
    const pan = { x: 40, y: -25 };
    const s = mkScene(PaletteClass, { pan });
    const row = firstRow(s.list);
    const dropX = 400, dropY = 300;
    const exp = worldOf(dropX, dropY, pan);           // 独立复算：360, 325
    const viaEngine = s.eng.screenToWorld(dropX, dropY);   // 交叉验证引擎自己给的
    ok('W2a', viaEngine.x === exp.x && viaEngine.y === exp.y,
      `引擎的 screenToWorld 与独立复算一致（引擎 (${viaEngine.x},${viaEngine.y}) ⟷ 独立 (${exp.x},${exp.y})）`);
    row.fire('pointerdown', pev('pointerdown', { x: 100, y: 200, pt: 'mouse' }));
    row.fire('pointermove', pev('pointermove', { x: 110, y: 205, pt: 'mouse' }));
    row.fire('pointerup', pev('pointerup', { x: dropX, y: dropY, pt: 'mouse' }));
    const call = s.calls.addEntity[s.calls.addEntity.length - 1];
    w2 = call;
    ok('W2', !!call && call.x === snap(exp.x) && call.y === snap(exp.y),
      `pan=(${pan.x},${pan.y}) 时放手点 (${dropX},${dropY}) ⇒ 落位 (${call && call.x},${call && call.y})，与 pan=0 的 (${snap(400)},${snap(300)}) **不同**`);
    info(`实测数字：pan=(${pan.x},${pan.y}) 落位 (${call && call.x},${call && call.y})；pan=0 时同一点落位 (${w1 && w1.x},${w1 && w1.y})`);
  }

  // ── ④ 滑动列表 vs 拖出：触屏上两条都必须还能用 ──
  head('④ 「滑动列表」与「拖出器材」的区分（长按 550ms / 抖动容忍 10px）');
  {
    const s = mkScene(PaletteClass);
    const row = firstRow(s.list);
    // 4-1 长按未成立就划走 ⇒ 判定为滚动，绝不进入拖拽、绝不落位
    row.fire('pointerdown', pev('pointerdown', { x: 100, y: 300, pt: 'touch' }));
    await sleep(30);
    row.fire('pointermove', pev('pointermove', { x: 104, y: 250, pt: 'touch' }));   // 纵向划 50px（滑列表）
    const armedAfterSwipe = !!(s.pal.drag && s.pal.drag.armed);
    row.fire('pointerup', pev('pointerup', { x: 104, y: 250, pt: 'touch' }));
    ok('G1', !armedAfterSwipe && s.calls.addEntity.length === 0,
      `滑动列表：长按未成立就划走 ⇒ 未进入拖拽（armed=${armedAfterSwipe}）且一件都没落（addEntity ${s.calls.addEntity.length} 次）`);

    // 4-2 长按成立后拖到画布 ⇒ 落位
    const s2 = mkScene(PaletteClass);
    const row2 = firstRow(s2.list);
    row2.fire('pointerdown', pev('pointerdown', { x: 100, y: 300, pt: 'touch' }));
    await sleep(api.LONG_PRESS_MS + 60);
    const armedAfterHold = !!(s2.pal.drag && s2.pal.drag.armed);
    row2.fire('pointermove', pev('pointermove', { x: 420, y: 300, pt: 'touch' }));
    row2.fire('pointerup', pev('pointerup', { x: 420, y: 300, pt: 'touch' }));
    ok('G1b', armedAfterHold && s2.calls.addEntity.length === 1,
      `长按 ${api.LONG_PRESS_MS}ms 成立后拖出 ⇒ 进入拖拽（armed=${armedAfterHold}）且落了一件`);

    // A2b：把「抓住指针」从**静态出现**升成**行为观测** —— 拖拽成立时真的调了
    // setPointerCapture，收尾时真的释放。A2 只是字符串检查，这条证明它不空转。
    // ⓘ 但「不抓指针就会被 #drawerMask 抢走 move/up」这句**运行时后果**，
    //   替身事件模型证明不了：那要真浏览器的命中测试。见交付清单。
    ok('A2b', (row2.captureCalls || 0) >= 1 && row2.released === 1,
      `拖拽成立时真的调了 setPointerCapture（${row2.captureCalls || 0} 次），收尾时按其 id 释放（released=${row2.released}）`);

    // 4-3 滚动守卫只在拖拽成立时挡浏览器
    const guard = (s.list._listeners.touchmove || [])[0];
    ok('G2', !!guard && guard.opts && guard.opts.passive === false,
      '列表上装了**非被动** touchmove 守卫（passive:false，否则 preventDefault 无效）');
    let preventedIdle = false, preventedArmed = false;
    s.pal.drag = null;
    guard.fn({ preventDefault: () => { preventedIdle = true; } });
    s.pal.drag = { armed: true };
    guard.fn({ preventDefault: () => { preventedArmed = true; } });
    s.pal.drag = null;
    ok('G2b', preventedArmed && !preventedIdle,
      `守卫只在拖拽成立时 preventDefault（未拖拽 ${preventedIdle ? '挡了 ✗' : '不挡 ✓'}；拖拽中 ${preventedArmed ? '挡 ✓' : '不挡 ✗'}）—— 列表滚动不受影响`);
  }

  // ── ⑤ 收尾：pointercancel / 画布之外放手 ──
  head('⑤ 收尾干净：不留幽灵、不误落位');
  {
    const s = mkScene(PaletteClass);
    const row = firstRow(s.list);
    row.fire('pointerdown', pev('pointerdown', { x: 100, y: 200, pt: 'mouse' }));
    row.fire('pointermove', pev('pointermove', { x: 200, y: 250, pt: 'mouse' }));
    const ghostWhileDragging = !!s.pal.ghost;
    row.fire('pointercancel', pev('pointercancel', { x: 200, y: 250, pt: 'mouse' }));
    ok('C1', s.calls.addEntity.length === 0,
      `pointercancel 不落位（addEntity ${s.calls.addEntity.length} 次）`);
    ok('C2', ghostWhileDragging && !s.pal.ghost && !s.pal.halo && !s.pal.drag,
      `pointercancel 后幽灵/落点环/拖拽态全清（拖拽中 ghost=${ghostWhileDragging} ⇒ 取消后 ghost=${!!s.pal.ghost} halo=${!!s.pal.halo} drag=${!!s.pal.drag}）`);
    const stillDraggingClass = row.className.includes('dragging');
    ok('C2b', !stillDraggingClass, '行上的 dragging 类也摘掉了');

    const s2 = mkScene(PaletteClass);
    const row2 = firstRow(s2.list);
    row2.fire('pointerdown', pev('pointerdown', { x: 100, y: 200, pt: 'mouse' }));
    row2.fire('pointermove', pev('pointermove', { x: 150, y: 220, pt: 'mouse' }));
    row2.fire('pointerup', pev('pointerup', { x: 900, y: 700, pt: 'mouse' }));   // 画布 (800×600) 之外
    ok('O1', s2.calls.addEntity.length === 0 && !s2.pal.drag && !s2.pal.ghost,
      `画布之外放手 = 取消（addEntity ${s2.calls.addEntity.length} 次，ghost=${!!s2.pal.ghost}）`);
  }

  // ── ⑥ 点击与键盘两条既有路径**不回归** ──
  head('⑥ 既有两条路径不回归：点击落位仍走 freeSpot，回车仍能落位');
  {
    const s = mkScene(PaletteClass);
    const row = firstRow(s.list);
    // 纯点击：按下→抬起**不移动** ⇒ 绝不许进入拖拽
    row.fire('pointerdown', pev('pointerdown', { x: 100, y: 200, pt: 'mouse' }));
    row.fire('pointerup', pev('pointerup', { x: 100, y: 200, pt: 'mouse' }));
    const armed = !!s.pal.drag;
    row.fire('click', {});
    const call = s.calls.addEntity[s.calls.addEntity.length - 1];
    ok('K1', !armed && s.calls.addEntity.length === 1 && call.x === undefined && call.y === undefined,
      `单击不进入拖拽（armed=${armed}）且落位走的是「不给坐标」那条（x=${call && call.x} y=${call && call.y} ⇒ freeSpot 避让）`);

    const s2 = mkScene(PaletteClass);
    const row2 = firstRow(s2.list);
    let prevented = false;
    row2.fire('keydown', { key: 'Enter', preventDefault: () => { prevented = true; }, stopPropagation() {} });
    const call2 = s2.calls.addEntity[s2.calls.addEntity.length - 1];
    ok('K2', s2.calls.addEntity.length === 1 && call2.x === undefined && prevented,
      `回车仍能落位，且仍走「不给坐标」那条（preventDefault=${prevented}，x=${call2 && call2.x}）`);
    const s3 = mkScene(PaletteClass);
    const row3 = firstRow(s3.list);
    row3.fire('keydown', { key: ' ', preventDefault: () => {}, stopPropagation() {} });
    ok('K3', s3.calls.addEntity.length === 1, '空格仍能落位（全局快捷键没被抢）');
  }

  // ── ⑦ 拖出后不吃掉 click ⇒ 一次拖动只落一件 ──
  head('⑦ 一次拖动只落一件（拖出后紧随的 click 必须被吃掉）');
  {
    const s = mkScene(PaletteClass);
    const row = firstRow(s.list);
    row.fire('pointerdown', pev('pointerdown', { x: 100, y: 200, pt: 'mouse' }));
    row.fire('pointermove', pev('pointermove', { x: 300, y: 300, pt: 'mouse' }));
    row.fire('pointerup', pev('pointerup', { x: 300, y: 300, pt: 'mouse' }));
    const afterDrag = s.calls.addEntity.length;
    row.fire('click', {});        // 浏览器在 pointerup 之后补发的那一次
    ok('D2', afterDrag === 1 && s.calls.addEntity.length === 1,
      `拖动落 1 件，紧随的 click 被吃掉（拖动后 ${afterDrag} 件 ⇒ 补发 click 之后仍是 ${s.calls.addEntity.length} 件）`);
  }

  // ── ⑧ 设置项：默认 B 不收起；切到 A 才收起 ──
  head('⑧ 设置项「放手后是否收起器材栏」：默认 B（保持打开）');
  {
    const K = api.DROP_COLLAPSE_KEY;
    // 默认：键不存在
    delete globalThis.localStorage._d[K];
    ok('S0', api.readDropCollapse() === false, '键不存在时默认为「不收起」（= 用户要的 B）');
    // 抽屉开着（data-open 在），默认不许点它
    const s = mkScene(PaletteClass);
    const row = firstRow(s.list);
    s.palHost.setAttribute('data-open', '');
    row.fire('pointerdown', pev('pointerdown', { x: 100, y: 200, pt: 'mouse' }));
    row.fire('pointermove', pev('pointermove', { x: 300, y: 300, pt: 'mouse' }));
    row.fire('pointerup', pev('pointerup', { x: 300, y: 300, pt: 'mouse' }));
    ok('S1', (s.btn.clicked || 0) === 0,
      `默认 B：放手**不**收起抽屉（抽屉按钮被点 ${s.btn.clicked || 0} 次）`);
    // 切到 A：必须走 #btnPalette 的既有开合入口
    globalThis.localStorage.setItem(K, '1');
    const s2 = mkScene(PaletteClass);
    const row2 = firstRow(s2.list);
    s2.palHost.setAttribute('data-open', '');
    row2.fire('pointerdown', pev('pointerdown', { x: 100, y: 200, pt: 'mouse' }));
    row2.fire('pointermove', pev('pointermove', { x: 300, y: 300, pt: 'mouse' }));
    row2.fire('pointerup', pev('pointerup', { x: 300, y: 300, pt: 'mouse' }));
    ok('S2', api.readDropCollapse() === true && (s2.btn.clicked || 0) === 1,
      `切到 A：放手收起抽屉，且走的是既有入口 #btnPalette（被点 ${s2.btn.clicked || 0} 次）`);
    // 抽屉本来就关着 ⇒ 不许去点它（避免把「关」点成「开」）
    const s3 = mkScene(PaletteClass);
    const row3 = firstRow(s3.list);
    row3.fire('pointerdown', pev('pointerdown', { x: 100, y: 200, pt: 'mouse' }));
    row3.fire('pointermove', pev('pointermove', { x: 300, y: 300, pt: 'mouse' }));
    row3.fire('pointerup', pev('pointerup', { x: 300, y: 300, pt: 'mouse' }));
    ok('S3', (s3.btn.clicked || 0) === 0,
      `抽屉本来就没开时不去点按钮（点了会把「关」toggle 成「开」）—— 实测被点 ${s3.btn.clicked || 0} 次`);
    delete globalThis.localStorage._d[K];
  }

  return { pass: PASS, fail: FAIL, results: new Map(results) };
}

// ══════════════════════════════════════════════════════════
// 6. 跑：绿档 / 红档
// ══════════════════════════════════════════════════════════

const real = await loadPalette(srcRaw, 'real');
const api = {
  SNAP: real.SNAP, LONG_PRESS_MS: real.LONG_PRESS_MS, SLOP: real.SLOP,
  DROP_COLLAPSE_KEY: real.DROP_COLLAPSE_KEY,
  readDropCollapse: real.readDropCollapse,
};

if (!MUT) {
  const r = await runAll(real.Palette, api, srcRaw);
  console.log('');
  if (r.fail === 0) console.log(`\x1b[1m全部通过：${r.pass} 项\x1b[0m`);
  else console.log(`\x1b[1m合计 ${r.pass + r.fail} 项，失败 ${r.fail} 项\x1b[0m`);
  console.log(`\x1b[1mPALETTE_DND_JSON\x1b[0m ${JSON.stringify({ items: r.pass + r.fail, pass: r.pass, fail: r.fail, mutate: false })}`);
  process.exit(r.fail ? 1 : 0);
}

// ── 红档：逐个变异体，看它只打红「它该打红的那几条」 ──
console.log(`\x1b[36m变异体自证：${MUTANTS.length} 个，源 sha256=${sha256(srcRaw).slice(0, 16)}\x1b[0m`);
const baseline = await runAll(real.Palette, api, srcRaw);
const baseFail = [...baseline.results].filter(([, v]) => !v).map(([k]) => k);
console.log(`\x1b[36m改前基线：${baseline.pass}/${baseline.pass + baseline.fail}，失败 ${baseFail.length} 项${baseFail.length ? '（' + baseFail.join(',') + '）' : ''}\x1b[0m`);

let expectedRed = 0, observedRed = 0, ctrlBad = 0;
const rows = [];
for (const m of MUTANTS) {
  const a = applyMutant(m);
  if (!a.landInCode) { console.log(`\x1b[31m✗ 变异体 ${m.id} 没落到代码行上（旧文本 raw=${a.nOldRaw} code=${a.nOldCode}）\x1b[0m`); }
  // ⚠ 变异体加载**必须**被包住：最常见的死法是相对 import 没改成绝对 URL
  //   ⇒ ERR_MODULE_NOT_FOUND，在 import 阶段抛出。若不接住，整个程序会
  //   **一行 JSON 都不打**地死掉（本仓 photoresistor-probe 曾经就是这样，
  //   --mutate 完全失效且看不出来）。红档的 JSON 必须是**无条件**的：
  //   把加载失败记成一行「没打红任何东西」，然后继续跑完。
  let r = null, loadErr = '';
  try {
    const mod = await loadPalette(a.mutated, m.id);
    r = await runAll(mod.Palette, {
      SNAP: mod.SNAP, LONG_PRESS_MS: mod.LONG_PRESS_MS, SLOP: mod.SLOP,
      DROP_COLLAPSE_KEY: mod.DROP_COLLAPSE_KEY, readDropCollapse: mod.readDropCollapse,
    }, a.mutated);
  } catch (e) {
    loadErr = String((e && e.message) || e);
    r = { pass: 0, fail: 0, results: new Map() };
  }
  const redIds = [...r.results].filter(([, v]) => !v).map(([k]) => k).filter((k) => !baseFail.includes(k));
  const hit = loadErr ? [] : m.breaks.filter((b) => redIds.includes(b));
  const extra = loadErr ? [] : redIds.filter((k) => !m.breaks.includes(k));
  expectedRed += m.breaks.length;
  observedRed += hit.length;
  ctrlBad += extra.length;
  const missed = m.breaks.filter((b) => !redIds.includes(b));
  console.log(`  ${a.landInCode && !loadErr ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${m.id} 落点自证=${a.landInCode}（旧行 code 命中 ${a.nOldCode} 次 → 变异后旧行已消失=${!stripComments(a.mutated).includes(m.old)}）`);
  if (loadErr) info(`\x1b[31m变异体加载失败（JSON 仍然照打）：${loadErr}\x1b[0m`);
  info(`${m.why}`);
  info(`该红 ${m.breaks.join(',')} ⇒ 实红 ${hit.length ? hit.join(',') : '（无）'}${missed.length ? ' ✗ 漏红：' + missed.join(',') : ''}${extra.length ? ' ✗ 误红：' + extra.join(',') : ''}`);
  rows.push({ id: m.id, landInCode: a.landInCode && !loadErr, expect: m.breaks, got: redIds, missed, extra, loadErr });
  console.log(`    · 本轮绿 ${r.pass}/${r.pass + r.fail}`);
}

const allLanded = rows.every((r) => r.landInCode);
const okAll = allLanded && expectedRed === observedRed && ctrlBad === 0 && MUTANTS.length > 0;
console.log('');
console.log(`\x1b[1mPALETTE_DND_MUTATE_JSON\x1b[0m ${JSON.stringify({
  mutants: MUTANTS.length, expectedRed, observedRed, ctrlBad,
  stubLanded: allLanded,
  landInCode: expectedRed === observedRed && ctrlBad === 0,
  baselineRed: baseFail,
  ok: okAll,
})}`);
process.exit(okAll ? 0 : 1);
