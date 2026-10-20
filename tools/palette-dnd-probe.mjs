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
  getBoundingClientRect() { return this._rect || { left: 0, top: 0, width: 320, height: 500 }; }
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
    old: 'return eng.screenToWorld(cxp - r.left, cyp - r.top);',
    neu: 'return { x: (cxp - r.left) - (eng.pan ? eng.pan.x : 0), y: (cyp - r.top) - (eng.pan ? eng.pan.y : 0) };',
    breaks: ['W0'],
  },
  {
    // 与 M1 配对：证明 W2 那条**数值**断言不只是摆设 —— 它真的在量 pan 的关系。
    // 刻意不写 `eng.pan`，让 W0 保持绿，这样两条各自只打红自己那一条。
    id: 'M1b-pan-sign',
    why: 'pan 的方向写反（屏幕-世界的关系反了）',
    old: 'return eng.screenToWorld(cxp - r.left, cyp - r.top);',
    neu: 'const _p = eng.screenToWorld(0, 0); return { x: (cxp - r.left) - _p.x, y: (cyp - r.top) - _p.y };',
    breaks: ['W2'],
  },
  {
    id: 'M2-ignore-point',
    why: '拖放不认落点，退回点击落位（freeSpot 自己挑位置）',
    old: '    const ent = this.place(d, x, y);',
    neu: '    const ent = this.place(d);',
    // O2b（宽屏落位）与 O4（窄屏可见条落位）都在数「落在了算出来的那个点上」，跟着红是**应该**红的
    // G7/G8/G14 也断言「落点与松手点逐位相同」⇒ 坐标被毁时它们**必须**一起红（task-16 补声明）。
    breaks: ['W1', 'W2', 'O2b', 'O4', 'G7', 'G8', 'G14'],
  },
  {
    // 第一版我写成 `if (false)`，方向搞反了：那等于**彻底不装长按**，
    // 于是滑动列表那条（G1）反而更绿了。真正要证明的是「不等长按就进拖拽」，
    // 所以改成把「滑动列表」的取消动作换成「进入拖拽」。
    id: 'M3-swipe-arms',
    why: '触屏纵向滑动也进拖拽（滑列表被误判成拖出 —— 这个闸门存在的全部理由）',
    // ⓘ task-16 重锚：纵向分支被改写成带位移条件的 `} else if (ady > adx && far > SLOP) {`
    //   （旧锚 `else if (ady > adx) this.endDrag();` 已不存在）。语义没变：仍然只改「取消」这一个动作。
    old: '        } else if (ady > adx && far > SLOP) {\n          this.endDrag();',
    neu: '        } else if (ady > adx && far > SLOP) {\n          this.armDrag(st);',
    breaks: ['G1', 'G4', 'G9', 'G10'],
  },
  {
    id: 'M4-ghost-leak',
    why: 'pointercancel 后不收幽灵（屏幕上留一个永远挂着的影子）',
    old: '    if (this.ghost) { this.ghost.remove(); this.ghost = null; }',
    neu: '',
    // task-16 补声明：G11/G12 的判据里也含「无残留」（ghost/halo/drag 全清）⇒ 必须一起红。
    breaks: ['C2', 'O1', 'O3b', 'G11', 'G12'],   // O1 与 O3b 的判据里都含「收干净」，它们跟着红是**应该**红的
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
    old: '    if (!(cx >= r.left && cy >= r.top && cx <= r.left + r.width && cy <= r.top + r.height)) return false;',
    neu: '',
    // task-16 补声明：去掉画布矩形这道界之后，「甩出画布」也成了合法落点 ⇒ O6 的③ 没有 toast 了，必须红。
    breaks: ['O1', 'O6'],
  },
  {
    // 与 M6 分开：M6 只拆「画布边界」这一半，这条只拆「被器材栏盖住」那一半。
    // 两条各自只打红自己那一组，才能证明两个判据是**相互独立**在起作用的
    // —— 合成一条的话，任何一半坏掉都会让两组一起红，分不清坏的是哪一半。
    id: 'M6b-no-palette-guard',
    why: '不判「松手是不是落在器材栏自己身上」（取消判据消失 ⇒ 器材落到抽屉背后，什么都不发生的样子）',
    old: '    return !this.overPalette(cx, cy);',
    neu: '    return true;',
    // O5 也跟着红是**应该**的：环与投放共用判据，判据被拆掉后环也不再区分抽屉/画布
    // task-16 补声明：器材栏那一半判据没了 ⇒ ②（拖回器材栏）不再取消、也不再说话 ⇒ O6 必须红。
    breaks: ['O2', 'O3', 'O5', 'O6'],
  },
  {
    id: 'M7-double-add',
    why: '拖出后不吃掉那次 click（一次拖动落两件器材）',
    old: '    this.suppressClick = true;',
    neu: '',
    // task-16 补声明：suppressClick 失效 ⇒ 松手后浏览器补发的那次 click 会**多放一件**，
    // 而 G11/G12/G13 现在都会模拟那次 click 并断言「恰好 1 件」⇒ 它们必须一起红。
    //（这正是把「补发 click」补进测例换来的收益：以前这几条只断言「有落件」，多放一件照样绿。）
    breaks: ['D2', 'G11', 'G12', 'G13'],
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
  {
    // 「取消要说出来」也是可失效的一环：把提示删掉，行为（取消）仍然对，
    // 但用户看到的是「什么都没发生」—— 只有 O3 会红。这正是把「反馈」
    // 单独断言、而不是混进 O2 的原因。
    id: 'M11-no-cancel-toast',
    why: '取消时不说话了（取消本身仍然生效，但用户看到的是「拖了半天什么都没发生」）',
    // ⓘ task-16 重锚：取消分支重写成三分语义后，松手点先算进 upX/upY，调用变成一行
    //   `this.cancelToast(upX, upY);`（旧的三行锚已不存在）。
    //   O6 也跟着红是**应该**的：②③ 两条文案都靠这个调用发出去，删掉它等于「取消又变回静默」。
    old: '    this.cancelToast(upX, upY);',
    neu: '',
    breaks: ['O3', 'O6'],
  },
  {
    // 真机症状的直接回归点：横向即时入口被删掉 ⇒ 退回「长按唯一入口」，
    // 而真手指在 3840×2160@3x 一体机上做不到「按住 550ms 且抖动 <10px」。
    // ⓘ 这里必须保留 if/else 的骨架（neu 不能置空，否则后面的 else if 会变成语法错误），
    //   所以用 `if (false)` 而不是删除整行。
    id: 'M12-no-horizontal-entry',
    why: '横向意图不再即时成立（退回长按唯一入口）—— 真机上用户看到的就是「仍然无法拖出」',
    // ⓘ task-16 重锚：横向分支的条件变成了 `adx > ady && far > AXIS_SLOP`（旧锚已不存在）。
    //   `neu` 仍写成 `if (false) {` 以保住 if/else 骨架（置空会让后面的 `else if` 变成语法错误）。
    old: '        if (adx > ady && far > AXIS_SLOP) {',
    neu: '        if (false) {',
    breaks: ['G3', 'G3b', 'G7', 'G7b', 'G8'],
  },
  {
    id: 'M13-axis-applies-to-mouse',
    why: '把轴向锁定也加到鼠标/笔上（桌面**纵向**拖出被关掉，而画布就在列表右下）',
    old: '      } else if (far > DRAG_SLOP) {\n        this.armDrag(st);\n      }',
    neu: '      } else if (far > DRAG_SLOP && Math.abs(dx) > Math.abs(dy)) {\n        this.armDrag(st);\n      }',
    // G13 也跟着红是**应该**的：它就是为「鼠标分支有没有被套上轴向规则」立的**对照**断言
    //（触屏纵向 5px 不成立、鼠标纵向 5px 必须成立）⇒ 轴向规则一旦扩到鼠标，它必须红。
    breaks: ['G5', 'G13'],
  },
  {
    id: 'M14-open-drawer-cancels-all',
    why: '抽屉开着就一律判成「落在器材栏上」（窄屏那条 70px 可见画布条被吃掉 ⇒ 功能等于关掉）',
    old: '    return !this.overPalette(cx, cy);',
    neu: '    const _p = typeof document !== "undefined" && document.querySelector ? document.querySelector("#palette") : null; return !(_p && _p.hasAttribute && _p.hasAttribute("data-open"));',
    // O5 也跟着红是**应该**的：环与投放共用判据，投放被关掉时环也不会再亮。
    // S2 也跟着红同样是**应该**的，而且是个独立佐证：S2 那条（抽屉开着、鼠标拖到
    // x=360 的可见条上）本来就是「抽屉模式可见条要能落位」的测例 —— 它先于今天这条判据存在，
    // 说明这条性质**早就是承重的**，不是我今天新加的口径。
    // task-16 补声明：抽屉开着就一律判成「落在器材栏上」⇒ ②不再说话、③文案也跟着错 ⇒ O6 必须红。
    breaks: ['O4', 'O5', 'S2', 'O6'],
  },
  {
    id: 'M15-halo-canvas-only',
    why: '落点环退回只看画布矩形（环在抽屉上是实的、落下去却什么都没有 —— 正是「共用一条判据」要防的漂移）',
    old: '    if (h && h.classList) h.classList.toggle(\'on\', this.dropTargetOK(x, y));',
    neu: '    if (h && h.classList) h.classList.toggle(\'on\', this.dropTargetOK(x, y) || this.overPalette(x, y));',
    breaks: ['O5'],
  },
  {
    id: 'M16-no-longpress',
    why: '长按 550ms 这条入口被删掉（「按住再慢慢拖」的人拖不出来）',
    old: '        if (this.drag === st && !st.armed) this.armDrag(st);',
    neu: '        if (false && this.drag === st && !st.armed) this.armDrag(st);',
    // task-16 补声明：G14 断言「45° 只有长按这一条路」⇒ 长按入口被删它必须红。
    breaks: ['G1b', 'G6', 'G14'],
  },
  {
    id: 'M17-axis-slop-back-to-10',
    why: '横向成立阈值放宽回 SLOP(10)：抢不到浏览器认领纵向滚动之前，斜向起手在真机上又会丢',
    old: 'export const AXIS_SLOP = 4;',
    neu: 'export const AXIS_SLOP = 10;',
    // G7/G8/G9/G10/G13/G14 用的都是**单次大位移**，阈值改成 10 照样成立 ⇒ 它们**量不出阈值本身**；
    // 只有 G3b（两侧夹取）与 G7b（逐 1px 步进量出第几 px）能把 4 与 10 分开。这正是那两条存在的理由。
    breaks: ['G3b', 'G7b'],
  },
  {
    id: 'M19-vertical-threshold-shrunk',
    why: '纵向取消阈值压到 AXIS_SLOP(4)：按住长按时那 5~8px 的自然漂移会被当成「在滑列表」，长按入口被掐死',
    old: '        } else if (ady > adx && far > SLOP) {',
    neu: '        } else if (ady > adx && far > AXIS_SLOP) {',
    breaks: ['G10'],
  },
  {
    id: 'M20-no-retreat-for-in-place-release',
    why: '原地抖动松手不给退路（点一下变成「什么都没发生 + 一条误报 toast」—— task-16 修掉的那个真回归）',
    // ⓘ task-16：锚只能取**第一行** —— 那条 if 与 `this.place(st.d);` 之间隔着解释性注释，
    //   三行连续文本在 raw 里根本不存在（夹具按 raw 计数 ⇒ raw=0 判「没落到代码行上」）。
    old: '    if (this.overPalette(upX, upY) && !st.leftPalette) {',
    neu: '    if (false) {',
    // 它该点名的是「**从没离开过**器材栏」那一类：G11/G12（抖动点击）与 O6 的①。
    // 而 O2/O3 那条「离开又回来」**不该**红 —— 它们的 leftPalette 早已是 true，根本不走这个分支。
    // task-16 补声明：G13 那条鼠标对照也走这条退路（鼠标 5px 成立拖拽、松手仍在器材栏内）⇒ 退路没了它也红。
    breaks: ['G11', 'G12', 'O6', 'G13'],
  },
  {
    id: 'M23-retreat-ungated',
    why: '退路不设条件（任何没落下去的松手都静默落一件）⇒「拖出去又拖回来」不再取消、也不再说出来',
    old: '    if (this.overPalette(upX, upY) && !st.leftPalette) {',
    neu: '    if (true) {',
    // 与 M20 正好是**这道闸门的两侧**：M20 关掉退路（原地抖动那类红），M23 让退路失效条件（取消语义那类红）。
    breaks: ['O1', 'O2', 'O3', 'O6'],
  },
  {
    id: 'M21-conflate-the-two-empty-causes',
    why: '把 `w` 为空的两种原因合并（只看 leftPalette 闩锁）⇒「甩出画布」被当成点击、反而落一件',
    old: '    if (this.overPalette(upX, upY) && !st.leftPalette) {',
    neu: '    if (!st.leftPalette) {',
    // O1 是唯一一条「全程没离开器材栏、但松手在画布外」的测例 ⇒ 它必须红；O6 的③同理（那条 toast 消失了）。
    breaks: ['O1', 'O6'],
  },
  {
    id: 'M22-swap-cancel-toast-wording',
    why: '两条取消文案互换（「甩出画布」说成「落在器材栏上」）—— 有 toast 但说错了是哪一条，只数条数的测例看不出来',
    old: '    this.app.toast(this.overPalette(cx, cy)',
    neu: '    this.app.toast(true',
    breaks: ['O6'],
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
  // 画布矩形的左边界可调：宽屏档要模拟「器材栏在画布左侧、两者不重叠」，
  // 此时同一个 client 落点仍然落在画布上（窄屏抽屉档则是「器材栏盖在画布上」）。
  if (opts.canvasLeft !== undefined) {
    cv.getBoundingClientRect = () => ({ left: opts.canvasLeft, top: 0, width: opts.cw || 800, height: opts.ch || 600 });
  }
  const world = new World();
  const eng = new Engine(cv, world);
  eng.app = { markDirty() {} };
  if (opts.pan) { eng.pan.x = opts.pan.x; eng.pan.y = opts.pan.y; }

  // 器材栏容器：Palette 的 this.el 就是 .pal-list（见 src/plugins/ui.palette.js）
  const list = DOC.createElement('div');
  list.className = 'pal-list';
  const palHost = DOC.createElement('aside');
  palHost.setAttribute('id', 'palette');
  // 器材栏矩形可调：默认 320×500 与画布（0,0 起）左下角重叠，近似窄屏抽屉；
  // 要模拟宽屏「器材栏在画布左侧、不重叠」时传 paletteRect 把左边界收窄。
  if (opts.paletteRect) palHost._rect = opts.paletteRect;
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

    // 4-4 轴向意图（即时入口）：横向位移 ⇒ **不等长按**立刻成立。
    // 这是真机症状「仍然无法拖出」的直接回归点：3840×2160@3x 一体机上，
    // 真手指做不到「按住 550ms 且抖动 <10px」。
    const s3 = mkScene(PaletteClass);
    const row3 = firstRow(s3.list);
    const waited = 30;                                  // 远小于 LONG_PRESS_MS
    row3.fire('pointerdown', pev('pointerdown', { x: 100, y: 300, pt: 'touch' }));
    await sleep(waited);
    row3.fire('pointermove', pev('pointermove', { x: 420, y: 306, pt: 'touch' }));   // 横 320 / 纵 6
    const armedFast = !!(s3.pal.drag && s3.pal.drag.armed);
    row3.fire('pointerup', pev('pointerup', { x: 420, y: 306, pt: 'touch' }));
    ok('G3', armedFast && s3.calls.addEntity.length === 1 && waited < api.LONG_PRESS_MS,
      `横向划走 ⇒ **不等长按**（只等了 ${waited}ms，长按阈值 ${api.LONG_PRESS_MS}ms）就进入拖拽并落位（armed=${armedFast}，addEntity ${s3.calls.addEntity.length} 次）`);

    // 4-5 横向成立阈值 = AXIS_SLOP(4)，两侧夹取：3px 不成立、5px 成立（既不许放宽，也不许收紧）
    // ⚠ 这条断言**本轮被改写过**，理由是它钉的正是本任务要改的那个数：
    //   旧版写「横移 9px 不成立 / 12px 成立」，钉的是 SLOP(10)；task-16 把横向成立阈值压到
    //   AXIS_SLOP(4)（理由：必须抢在浏览器认领纵向滚动、发 pointercancel 之前下判断），
    //   于是 9px 已经成立、旧版必红。改它是让它继续钉住**当前**那个数，
    //   不是为了让红的变绿 —— 它现在两侧夹住 4，照样不许任何人放宽或收紧。
    const s4 = mkScene(PaletteClass);
    const row4 = firstRow(s4.list);
    row4.fire('pointerdown', pev('pointerdown', { x: 100, y: 300, pt: 'touch' }));
    row4.fire('pointermove', pev('pointermove', { x: 103, y: 300, pt: 'touch' }));   // 3px < AXIS_SLOP
    const armed3 = !!(s4.pal.drag && s4.pal.drag.armed);
    row4.fire('pointermove', pev('pointermove', { x: 105, y: 300, pt: 'touch' }));   // 5px > AXIS_SLOP
    const armed5 = !!(s4.pal.drag && s4.pal.drag.armed);
    row4.fire('pointercancel', pev('pointercancel', { x: 105, y: 300, pt: 'touch' }));
    ok('G3b', !armed3 && armed5,
      `横向成立阈值 = AXIS_SLOP(${api.AXIS_SLOP}px)：横移 3px 不成立（armed=${armed3}）、5px 成立（armed=${armed5}）`);

    // 4-6 纵向滑动 ⇒ 待定被**取消**（不只是「没成立」）：手势整条还给列表。
    // 这是这个闸门存在的全部理由，变异体 M3 把它钉死。
    const s5 = mkScene(PaletteClass);
    const row5 = firstRow(s5.list);
    row5.fire('pointerdown', pev('pointerdown', { x: 100, y: 300, pt: 'touch' }));
    row5.fire('pointermove', pev('pointermove', { x: 104, y: 250, pt: 'touch' }));   // 横 4 / 纵 50
    const armedV = !!(s5.pal.drag && s5.pal.drag.armed);
    const cleared = s5.pal.drag === null;
    row5.fire('pointerup', pev('pointerup', { x: 104, y: 250, pt: 'touch' }));
    ok('G4', !armedV && cleared && s5.calls.addEntity.length === 0,
      `纵向划走 ⇒ 未进入拖拽（armed=${armedV}）**且待定被取消**（drag ${cleared ? '= null ✓' : '还在 ✗'}），一件都没落（addEntity ${s5.calls.addEntity.length} 次）`);

    // 4-7 轴向锁定**只给触屏**：鼠标纵向拖动必须照旧成立（桌面档不回归）
    const s6 = mkScene(PaletteClass);
    const row6 = firstRow(s6.list);
    row6.fire('pointerdown', pev('pointerdown', { x: 420, y: 100, pt: 'mouse' }));
    row6.fire('pointermove', pev('pointermove', { x: 452, y: 180, pt: 'mouse' }));   // 横 32 / 纵 80（纵向占优）
    const armedMouseV = !!(s6.pal.drag && s6.pal.drag.armed);
    row6.fire('pointerup', pev('pointerup', { x: 452, y: 180, pt: 'mouse' }));
    ok('G5', armedMouseV && s6.calls.addEntity.length === 1,
      `鼠标**纵向**拖动照旧进入拖拽并落位（armed=${armedMouseV}，addEntity ${s6.calls.addEntity.length} 次）—— 轴向锁定只作用于触屏`);

    // 4-8 长按这条入口保留，而且成立之后**不再看轴向**：
    // 住后纵向拖也要能落位，否则长按就只在横向上有用，而纵向落位是最常见的用法。
    const s7 = mkScene(PaletteClass);
    const row7 = firstRow(s7.list);
    row7.fire('pointerdown', pev('pointerdown', { x: 100, y: 300, pt: 'touch' }));
    await sleep(api.LONG_PRESS_MS + 60);
    const armedHold7 = !!(s7.pal.drag && s7.pal.drag.armed);
    row7.fire('pointermove', pev('pointermove', { x: 200, y: 560, pt: 'touch' }));   // 横 100 / 纵 260（纵向占优）
    row7.fire('pointerup', pev('pointerup', { x: 200, y: 560, pt: 'touch' }));
    ok('G6', armedHold7 && s7.calls.addEntity.length === 1,
      `长按 ${api.LONG_PRESS_MS}ms 成立后再**纵向**拖（横 100/纵 260）⇒ 仍然落位（armed=${armedHold7}，addEntity ${s7.calls.addEntity.length} 次）—— 长按入口没被轴向规则吃掉`);

    // ──────────────────────────────────────────────────────────────
    // 4-9 ⚠ task-16 的核心：**斜向起手不能被浏览器抢走手势**。
    //   浏览器只要认领了纵向滚动就会对页面发 pointercancel，之后一个 pointermove 都收不到；
    //   它认领的**时机**由它自己的手势 slop 决定（那个数值我**没有实测**，也不好在真机上量）。
    //   所以判据层必须**抢在它之前**下判断 —— 这就是 AXIS_SLOP(4) 比 SLOP(10) 小的唯一理由：
    //   SLOP 大是为了**长按**（手指按住 550ms 难免漂 5~8px，收紧它就把长按入口掐死了），
    //   轴向起手要抢在浏览器之前，就必须小。两个数赛的是两个不同的东西，不是同一个数的手松手紧。
    //   G7 用**时间口径**、G7b 用**距离口径**，各自把「先手」钉住一遍。

    // 4-9a 用户那条路线：30° 斜向（adx:ady = 1.73:1）单次位移、只等 30ms ⇒ 成立并落位。
    //   30ms 远小于长按 ${api.LONG_PRESS_MS}ms ⇒ 这一件**只可能**是轴向判据落下的，不可能是长按。
    const s8 = mkScene(PaletteClass);
    const row8 = firstRow(s8.list);
    row8.fire('pointerdown', pev('pointerdown', { x: 100, y: 200, pt: 'touch' }));
    await sleep(30);
    row8.fire('pointermove', pev('pointermove', { x: 340, y: 339, pt: 'touch' }));   // 横 240 / 纵 139 = 1.73:1
    const armedDiag = !!(s8.pal.drag && s8.pal.drag.armed);
    row8.fire('pointerup', pev('pointerup', { x: 340, y: 339, pt: 'touch' }));
    const c8 = s8.calls.addEntity[s8.calls.addEntity.length - 1];
    ok('G7', armedDiag && s8.calls.addEntity.length === 1 && !!c8 && c8.x === snap(340) && c8.y === snap(339),
      `斜向 30°（横 240/纵 139 = 1.73:1）起手，只等 30ms（长按要 ${api.LONG_PRESS_MS}ms）⇒ 成立（armed=${armedDiag}）并落位到 (${c8 && c8.x},${c8 && c8.y})`);

    // 4-9b **距离口径**：沿同一条 30° 射线按总位移 1px 一级步进，量「成立发生在第几 px」。
    //   真实手指的事件流本来就是 1~3px 一级（60~120Hz），所以这比「一次大跳」更贴近真机。
    //   ⚠ 上限写**字面 6**，绝不写成 AXIS_SLOP+2：那样就成了用被测常量推导自己的判据，
    //   阈值被改成 10 时上限跟着变成 12，断言反而全绿、量不出任何东西。
    //   这个数就是「先手余量」：它必须明显小于浏览器的手势 slop（约 8px 量级）才抢得到。
    const s9 = mkScene(PaletteClass);
    const row9 = firstRow(s9.list);
    row9.fire('pointerdown', pev('pointerdown', { x: 100, y: 200, pt: 'touch' }));
    let armAt = 0;
    for (let t = 1; t <= 24 && !armAt; t++) {
      const px = 100 + t * Math.cos(Math.PI / 6);
      const py = 200 + t * Math.sin(Math.PI / 6);
      row9.fire('pointermove', pev('pointermove', { x: px, y: py, pt: 'touch' }));
      if (s9.pal.drag && s9.pal.drag.armed) armAt = t;      // 步长就是总位移（cos²+sin²=1）
    }
    row9.fire('pointercancel', pev('pointercancel', { x: 100, y: 200, pt: 'touch' }));
    ok('G7b', armAt > 0 && armAt <= 6,
      `30° 射线逐 1px 步进 ⇒ 成立发生在第 **${armAt}px**（阈值 AXIS_SLOP=${api.AXIS_SLOP}，上限取字面 6）—— 这就是抢在浏览器认领之前的余量`);

    // 4-9c 三组角度对照：分界在 1:1 那条线上，横向侧全部成立并落位。
    //   1.05:1 离分界线最近（43.6°）、1.73:1 是用户那条 30°、5:1 几乎纯横向（78.7°）。
    const ANG = [[250, 238, '1.05:1'], [240, 139, '1.73:1'], [300, 60, '5:1']];
    const angRead = [];
    let angAll = true;
    for (const [ddx, ddy, tag] of ANG) {
      const sa = mkScene(PaletteClass);
      const ra = firstRow(sa.list);
      ra.fire('pointerdown', pev('pointerdown', { x: 100, y: 200, pt: 'touch' }));
      ra.fire('pointermove', pev('pointermove', { x: 100 + ddx, y: 200 + ddy, pt: 'touch' }));
      const armA = !!(sa.pal.drag && sa.pal.drag.armed);
      ra.fire('pointerup', pev('pointerup', { x: 100 + ddx, y: 200 + ddy, pt: 'touch' }));
      const ca = sa.calls.addEntity[sa.calls.addEntity.length - 1];
      const goodA = armA && sa.calls.addEntity.length === 1 && !!ca
        && ca.x === snap(100 + ddx) && ca.y === snap(200 + ddy);
      angAll = angAll && goodA;
      angRead.push(`${tag}⇒${armA ? '成立' : '未成立'}/落${sa.calls.addEntity.length}件(${ca && ca.x},${ca && ca.y})`);
    }
    ok('G8', angAll, `三组角度对照（横向侧）全部成立并落位：${angRead.join('  ')}`);

    // 4-9d 分界的**另一侧**：纵向 1:1.73（横 100/纵 173）⇒ 不成立、待定被取消、一件都不落。
    //   与 4-9c 合起来才是「分界在哪一侧」的完整证明（只证一侧等于没证）。
    const s10 = mkScene(PaletteClass);
    const row10 = firstRow(s10.list);
    row10.fire('pointerdown', pev('pointerdown', { x: 100, y: 200, pt: 'touch' }));
    row10.fire('pointermove', pev('pointermove', { x: 200, y: 373, pt: 'touch' }));   // 横 100 / 纵 173
    const armedV2 = !!(s10.pal.drag && s10.pal.drag.armed);
    const clearedV2 = s10.pal.drag === null;
    row10.fire('pointerup', pev('pointerup', { x: 200, y: 373, pt: 'touch' }));
    ok('G9', !armedV2 && clearedV2 && s10.calls.addEntity.length === 0,
      `纵向 1:1.73（横 100/纵 173）⇒ 未成立（armed=${armedV2}）、待定被取消（drag ${clearedV2 ? '= null ✓' : '还在 ✗'}）、一件都没落（${s10.calls.addEntity.length} 件）—— 分界在 1:1 那条线上`);

    // 4-9e 纵向漂移必须**宽容**：`AXIS_SLOP < far ≤ SLOP` 之间**不取消**待定。
    //   否则按住 550ms 那条入口会被一起掐死（手指按住难免漂 5~8px）。
    //   7px 落在 (4,10] 里 ⇒ 待定还在；12px > SLOP ⇒ 才取消。变异体把纵向阈值改成 AXIS_SLOP 会让这条红。
    const s11 = mkScene(PaletteClass);
    const row11 = firstRow(s11.list);
    row11.fire('pointerdown', pev('pointerdown', { x: 100, y: 200, pt: 'touch' }));
    row11.fire('pointermove', pev('pointermove', { x: 100, y: 207, pt: 'touch' }));   // 纵 7px：> AXIS_SLOP，≤ SLOP
    const pending7 = s11.pal.drag !== null && !(s11.pal.drag && s11.pal.drag.armed);
    row11.fire('pointermove', pev('pointermove', { x: 100, y: 212, pt: 'touch' }));   // 纵 12px：> SLOP
    const cleared12 = s11.pal.drag === null;
    row11.fire('pointercancel', pev('pointercancel', { x: 100, y: 212, pt: 'touch' }));
    ok('G10', pending7 && cleared12,
      `纵向漂移 7px（AXIS_SLOP=${api.AXIS_SLOP} < 7 ≤ SLOP=${api.SLOP}）时待定**还在**（pending=${pending7}）；漂到 12px（> SLOP）才取消（drag ${cleared12 ? '= null ✓' : '还在 ✗'}）`);

    // 4-9f **鼠标分支的对照断言**（不许靠「我没动它」这句话）：轴向锁定只作用于触屏，
    //   桌面用户本来就会**纵向**把器材拖到画布（画布在器材栏的右下方），所以鼠标必须照旧。
    //   这里用**最小的对照位移 5px** 去问两条方向：都成立，才说明鼠标走的是它自己那条
    //   DRAG_SLOP(4) 判据、没被套上触屏的轴向规则（触屏下纵向 5px 是**不成立**的 —— 见 G10）。
    const mouseRead = [];
    let mouseAll = true;
    for (const [mdx, mdy] of [[5, 0], [0, 5]]) {
      const sm = mkScene(PaletteClass);
      const rm = firstRow(sm.list);
      rm.fire('pointerdown', pev('pointerdown', { x: 100, y: 200, pt: 'mouse' }));
      rm.fire('pointermove', pev('pointermove', { x: 100 + mdx, y: 200 + mdy, pt: 'mouse' }));
      const armM = !!(sm.pal.drag && sm.pal.drag.armed);
      rm.fire('pointerup', pev('pointerup', { x: 100 + mdx, y: 200 + mdy, pt: 'mouse' }));
      rm.fire('click', {});
      const nm = sm.calls.addEntity.length;
      mouseAll = mouseAll && armM && nm === 1;
      mouseRead.push(`横${mdx}/纵${mdy}⇒armed=${armM}/${nm}件`);
    }
    ok('G13', mouseAll,
      `鼠标对照：5px 小位移**两个方向都成立**（${mouseRead.join('，')}）⇒ 鼠标仍走自己的 DRAG_SLOP 判据、没被套上触屏轴向规则；且各自恰好落 1 件`);

    // 4-9g 恰好 45°（adx == ady）**两条分支都不进** ⇒ 不猜方向、待定；长按 550ms 是它唯一的路。
    //   这条同时钉住三件事：45° 不成立轴向拖拽、待定不被误取消、长按入口逐字未变（成立后照旧落位）。
    const s12 = mkScene(PaletteClass);
    const row12 = firstRow(s12.list);
    row12.fire('pointerdown', pev('pointerdown', { x: 100, y: 200, pt: 'touch' }));
    row12.fire('pointermove', pev('pointermove', { x: 106, y: 206, pt: 'touch' }));   // 恰好 45°，总位移 8.49px
    const armed45 = !!(s12.pal.drag && s12.pal.drag.armed);
    const pending45 = s12.pal.drag !== null;
    await sleep(api.LONG_PRESS_MS + 60);
    const armedHold45 = !!(s12.pal.drag && s12.pal.drag.armed);
    row12.fire('pointermove', pev('pointermove', { x: 400, y: 300, pt: 'touch' }));  // 成立后拖到画布上
    row12.fire('pointerup', pev('pointerup', { x: 400, y: 300, pt: 'touch' }));
    const c12 = s12.calls.addEntity[s12.calls.addEntity.length - 1];
    ok('G14', !armed45 && pending45 && armedHold45 && s12.calls.addEntity.length === 1
        && !!c12 && c12.x === snap(400) && c12.y === snap(300),
      `恰好 45°（6/6）⇒ 轴向判据不猜方向（armed=${armed45}）、待定仍在（pending=${pending45}）；按住 ${api.LONG_PRESS_MS}ms ⇒ 成立（armed=${armedHold45}）并落位到 (${c12 && c12.x},${c12 && c12.y})`);
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
    // 松手点在 (900,700) = **画布之外**，注意它**不是**「落在器材栏上」那一种：
    // 全程都没离开过器材栏（150,220 落在默认 320×500 矩形内）⇒ 只看 leftPalette 闩锁
    // 会把它误判成点击、反而落一件。所以判据必须是**松手时刻那个点**：
    // overPalette(up) 为假 ⇒ 走「画布之外」那条文案、照旧取消。这条测例就是为这个洞存在的。
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
    // 用**真实窄屏几何**（390 宽、器材栏占 0–320）⇒ 落点必须落在可见画布那一块
    // （x>320），否则会被 dropTargetOK 判成「落在器材栏上」而取消 —— 那是对的行为，
    // 但这个用例要测的是「一次拖动只落一件」，得先让它真的落下。
    const s = mkScene(PaletteClass, { cw: 390, ch: 600 });
    const row = firstRow(s.list);
    row.fire('pointerdown', pev('pointerdown', { x: 100, y: 200, pt: 'mouse' }));
    row.fire('pointermove', pev('pointermove', { x: 360, y: 260, pt: 'mouse' }));
    row.fire('pointerup', pev('pointerup', { x: 360, y: 260, pt: 'mouse' }));
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
    const s = mkScene(PaletteClass, { cw: 390, ch: 600 });
    const row = firstRow(s.list);
    s.palHost.setAttribute('data-open', '');
    row.fire('pointerdown', pev('pointerdown', { x: 100, y: 200, pt: 'mouse' }));
    row.fire('pointermove', pev('pointermove', { x: 360, y: 260, pt: 'mouse' }));
    row.fire('pointerup', pev('pointerup', { x: 360, y: 260, pt: 'mouse' }));
    ok('S1', (s.btn.clicked || 0) === 0,
      `默认 B：放手**不**收起抽屉（抽屉按钮被点 ${s.btn.clicked || 0} 次）`);
    // 切到 A：必须走 #btnPalette 的既有开合入口
    globalThis.localStorage.setItem(K, '1');
    const s2 = mkScene(PaletteClass, { cw: 390, ch: 600 });
    const row2 = firstRow(s2.list);
    s2.palHost.setAttribute('data-open', '');
    row2.fire('pointerdown', pev('pointerdown', { x: 100, y: 200, pt: 'mouse' }));
    row2.fire('pointermove', pev('pointermove', { x: 360, y: 260, pt: 'mouse' }));
    row2.fire('pointerup', pev('pointerup', { x: 360, y: 260, pt: 'mouse' }));
    ok('S2', api.readDropCollapse() === true && (s2.btn.clicked || 0) === 1,
      `切到 A：放手收起抽屉，且走的是既有入口 #btnPalette（被点 ${s2.btn.clicked || 0} 次）`);
    // 抽屉本来就关着 ⇒ 不许去点它（避免把「关」点成「开」）
    const s3 = mkScene(PaletteClass, { cw: 390, ch: 600 });
    const row3 = firstRow(s3.list);
    row3.fire('pointerdown', pev('pointerdown', { x: 100, y: 200, pt: 'mouse' }));
    row3.fire('pointermove', pev('pointermove', { x: 360, y: 260, pt: 'mouse' }));
    row3.fire('pointerup', pev('pointerup', { x: 360, y: 260, pt: 'mouse' }));
    ok('S3', (s3.btn.clicked || 0) === 0,
      `抽屉本来就没开时不去点按钮（点了会把「关」toggle 成「开」）—— 实测被点 ${s3.btn.clicked || 0} 次`);
    delete globalThis.localStorage._d[K];
  }

  // ── ⑨ 松手落在器材栏自己身上 ⇒ 取消并说明；宽屏同一落点必须照常成功 ──
  head('⑨ 落在器材栏上 = 取消（并说明）；宽屏同一点仍成功（防误杀）');
  {
    const PX = 300, PY = 200;      // **同一个** client 落点，只换布局
    // 9-1 窄屏抽屉：器材栏盖在画布上（390 宽、器材栏占 0–320）⇒ 取消 + 一句 toast。
    //     这条规则是新的且看不见，所以「说出来」是要断言的一部分，不是装饰。
    const narrow = mkScene(PaletteClass, {
      cw: 390, ch: 600, paletteRect: { left: 0, top: 0, width: 320, height: 600 },
    });
    narrow.palHost.setAttribute('data-open', '');   // 抽屉模式 = 抽屉是开着的
    const rn = firstRow(narrow.list);
    rn.fire('pointerdown', pev('pointerdown', { x: 100, y: 300, pt: 'mouse' }));
    // ⚠ 本轮把判据改成「这趟手势有没有**离开过**器材栏」（而不是走了多远）：
    //   从没离开过 ⇒ 那是点击（落 1 件、不弹 toast，与抖动多大无关）；
    //   离开过又回来 ⇒ 才是 cancelToast 该管的场景。所以这个测例必须先**离开**抽屉再拖回来，
    //   否则它描述的本来就是一次点击。松手点与期望值（0 件 + 1 条 toast）一个字没改。
    rn.fire('pointermove', pev('pointermove', { x: 350, y: 300, pt: 'mouse' }));   // 离开抽屉（落在右侧可见条上）
    rn.fire('pointermove', pev('pointermove', { x: PX, y: PY, pt: 'mouse' }));     // 再拖回来
    rn.fire('pointerup', pev('pointerup', { x: PX, y: PY, pt: 'mouse' }));
    ok('O2', narrow.calls.addEntity.length === 0,
      `松手在器材栏矩形内（(${PX},${PY}) 落在 320 宽的抽屉上）⇒ 取消，一件都没落（addEntity ${narrow.calls.addEntity.length} 次）`);
    const tt = narrow.calls.toast.join(' | ');
    ok('O3', narrow.calls.toast.length === 1 && /器材栏/.test(tt),
      `取消时**说出来**了（toast ${narrow.calls.toast.length} 条：${tt || '（无）'}）`);
    ok('O3b', !narrow.pal.ghost && !narrow.pal.halo && !narrow.pal.drag,
      `取消后幽灵/环/拖拽态全清（ghost=${!!narrow.pal.ghost} halo=${!!narrow.pal.halo} drag=${!!narrow.pal.drag}）`);

    // 9-1c ⚠ 本轮回归的守卫：**点一下时手指横向抖 5~20px 必须仍然恰好落 1 件、0 条 toast**。
    //   把横向成立阈值从 SLOP(10) 压到 AXIS_SLOP(4) 之后，这些抖动会**走进拖拽路径**
    //   （旧阈值下它们压根不成立），而松手点仍在器材栏内 ⇒ 若 onRowUp 里没有那条退路，
    //   表现就是「点了一下、什么都没发生、还弹一条 warn」——
    //   这正是这条判据要防的病，也是本轮唯一一个**真回归**。
    //   断言只看**最终结果**（几件、几条 toast、有无残留），不看走了哪条路径：
    //   用户不关心路径，而且「判据换舞台」恰好是这条要防的病 ⇒ armed 只作读数印在消息里。
    const DRIFT = [5, 9, 14, 20];            // 两侧都覆盖：5/9 在旧阈值 10 以下、14/20 在它以上
    const driftRead = [];
    let driftAll = true;
    for (const j of DRIFT) {
      const sj = mkScene(PaletteClass);
      const rj = firstRow(sj.list);
      rj.fire('pointerdown', pev('pointerdown', { x: 100, y: 200, pt: 'touch' }));
      rj.fire('pointermove', pev('pointermove', { x: 100 + j, y: 200, pt: 'touch' }));   // 纯横向抖动
      const armedJ = !!(sj.pal.drag && sj.pal.drag.armed);
      rj.fire('pointerup', pev('pointerup', { x: 100 + j, y: 200, pt: 'touch' }));
      // 松手后浏览器会补发一次 click（真实行为）：成立过拖拽的那条路由 suppressClick 吃掉它，
      // 没成立拖拽的那条路则靠它落件。补上这一下，断言才同时守住「少落一件」与「多落一件」。
      rj.fire('click', {});
      const nj = sj.calls.addEntity.length, tj = sj.calls.toast.length;
      const cleanJ = !sj.pal.ghost && !sj.pal.halo && !sj.pal.drag;
      driftAll = driftAll && nj === 1 && tj === 0 && cleanJ;
      driftRead.push(`${j}px⇒${nj}件/${tj}toast/${armedJ ? '走过拖拽' : '未成立拖拽'}`);
    }
    ok('G11', driftAll, `横向抖动点击只准落 1 件、0 条 toast、无残留（${driftRead.join('，')}）`);

    // 9-1d 对角抖动（adx≈ady）：三种分类各一组 —— 恰好相等(两条分支都不进)、略横向(走拖拽)、
    //   略纵向(取消待定)。三组的**结果必须完全一样**：恰好 1 件、0 条 toast。
    //   这是「无论走哪条路径都只准落 1 件」的正面证明，也钉住「恰好 45° 不猜方向」没被顺手改掉。
    const DIAG = [[6, 6], [7, 6], [6, 7], [12, 12]];
    const diagRead = [];
    let diagAll = true;
    for (const [jx, jy] of DIAG) {
      const sd = mkScene(PaletteClass);
      const rd = firstRow(sd.list);
      rd.fire('pointerdown', pev('pointerdown', { x: 100, y: 200, pt: 'touch' }));
      rd.fire('pointermove', pev('pointermove', { x: 100 + jx, y: 200 + jy, pt: 'touch' }));
      const armD = !!(sd.pal.drag && sd.pal.drag.armed);
      rd.fire('pointerup', pev('pointerup', { x: 100 + jx, y: 200 + jy, pt: 'touch' }));
      rd.fire('click', {});     // 同 9-1c：浏览器补发的 click 也要模拟，否则「从没成立拖拽」那几组等于没测
      const nd = sd.calls.addEntity.length, td = sd.calls.toast.length;
      diagAll = diagAll && nd === 1 && td === 0 && !sd.pal.ghost && !sd.pal.drag;
      diagRead.push(`${jx}:${jy}⇒${nd}件/${td}toast/${armD ? '走拖拽' : '未成立'}`);
    }
    ok('G12', diagAll, `对角抖动点击（adx≈ady）同样只准落 1 件、0 条 toast（${diagRead.join('，')}）`);

    // 9-1e 三种情况的 toast **文案各不相同**，必须逐条钉住。
    //   只断言「有 toast」是不够的：②（拖回器材栏）与③（甩出画布）的文案可以互换而全绿 ——
    //   那正是「判据选错舞台」。注意②的文案里**也有「画布」二字**，所以只能按前缀区分。
    //   变异体「把③的文案换成器材栏那条」会让这条红，而 O1/O3 照样绿 —— 正是它存在的理由。
    const t1 = (() => {                     // ① 在栏上松手 + 从没离开过 ⇒ 一次点击，不该有 toast
      const s = mkScene(PaletteClass);
      const r = firstRow(s.list);
      r.fire('pointerdown', pev('pointerdown', { x: 100, y: 200, pt: 'touch' }));
      r.fire('pointermove', pev('pointermove', { x: 116, y: 200, pt: 'touch' }));
      r.fire('pointerup', pev('pointerup', { x: 116, y: 200, pt: 'touch' }));
      return s.calls.toast.slice();
    })();
    const t2 = (() => {                     // ② 出去再回来、在器材栏上松手 ⇒ 「落在器材栏上」
      const s = mkScene(PaletteClass, { paletteRect: { left: 0, top: 0, width: 320, height: 600 } });
      const r = firstRow(s.list);
      r.fire('pointerdown', pev('pointerdown', { x: 100, y: 300, pt: 'mouse' }));
      r.fire('pointermove', pev('pointermove', { x: 350, y: 300, pt: 'mouse' }));
      r.fire('pointermove', pev('pointermove', { x: 300, y: 250, pt: 'mouse' }));
      r.fire('pointerup', pev('pointerup', { x: 300, y: 250, pt: 'mouse' }));
      return s.calls.toast.slice();
    })();
    const t3 = (() => {                     // ③ 甩出画布（不在栏上、也不在画布上）⇒ 「画布之外」
      const s = mkScene(PaletteClass);
      const r = firstRow(s.list);
      r.fire('pointerdown', pev('pointerdown', { x: 100, y: 200, pt: 'mouse' }));
      r.fire('pointermove', pev('pointermove', { x: 150, y: 220, pt: 'mouse' }));
      r.fire('pointerup', pev('pointerup', { x: 900, y: 700, pt: 'mouse' }));
      return s.calls.toast.slice();
    })();
    const w2 = t2[0] || '（无）', w3 = t3[0] || '（无）';
    ok('O6', t1.length === 0 && t2.length === 1 && t3.length === 1
        && w2.startsWith('落在器材栏上') && w3.startsWith('松手点不在画布上'),
      `三种情况各弹哪条 toast：①原地抖动⇒${t1.length} 条${t1[0] ? `「${t1[0]}」` : '（无）'}；②拖回器材栏⇒「${w2}」；③甩出画布⇒「${w3}」`);

    // 9-1b 窄屏抽屉模式下，右侧那条**可见画布条**必须仍然能落位。
    //      几何取自真机：视口 390 宽、抽屉占 0–320 ⇒ 可见条只剩 70px（x ∈ (320,390]）。
    //      这条防的是「取消规则把窄屏功能整个关掉」。注意判据本来就只有一句话：
    //      「落在抽屉上 ⇒ 取消」⟺「落在可见条上 ⇒ 成功」，是同一条判据的两面，
    //      所以不需要新规则 —— 需要的是**证明那条 70px 真的通**。
    //      顺带把「环」也测了：环与投放共用判据，可见条上必须实、抽屉上必须虚。
    //
    //      ⚠ 这里**故意用鼠标**，不用触屏：本场景要测的是**几何判据**（可见条算不算有效落点），
    //      而几何与指针类型无关。用触屏的话就得先过「长按/轴向」那道入口闸门，
    //      于是 M12（横向即时入口被删）会连带把 O4/O5 打红 —— 那是**测例耦合**，
    //      会让变异体的红数说不清到底坏在哪一层。鼠标走的是「位移 > DRAG_SLOP 即成」这条
    //      与入口闸门无关的老路，正好把几何单独隔离出来。
    const strip = mkScene(PaletteClass, {
      cw: 390, ch: 600, paletteRect: { left: 0, top: 0, width: 320, height: 600 },
    });
    strip.palHost.setAttribute('data-open', '');
    const rs = firstRow(strip.list);
    rs.fire('pointerdown', pev('pointerdown', { x: 60, y: 300, pt: 'mouse' }));
    rs.fire('pointermove', pev('pointermove', { x: 350, y: 300, pt: 'mouse' }));   // 横 290 / 纵 0 ⇒ 可见条上
    const haloStrip = !!(strip.pal.halo && strip.pal.halo.classList.contains('on'));
    rs.fire('pointermove', pev('pointermove', { x: 300, y: 250, pt: 'mouse' }));   // 回到抽屉上方
    const haloDrawer = !!(strip.pal.halo && strip.pal.halo.classList.contains('on'));
    rs.fire('pointermove', pev('pointermove', { x: 350, y: 300, pt: 'mouse' }));   // 再回可见条
    rs.fire('pointerup', pev('pointerup', { x: 350, y: 300, pt: 'mouse' }));
    const sc = strip.calls.addEntity[strip.calls.addEntity.length - 1];
    ok('O4', strip.calls.addEntity.length === 1 && !!sc && sc.x === snap(350) && sc.y === snap(300),
      `抽屉模式（390 宽、抽屉 0–320、抽屉开着）松手在右侧可见条 x=350 ⇒ **照常落位** (${sc && sc.x},${sc && sc.y})，addEntity ${strip.calls.addEntity.length} 次 —— 窄屏功能没被取消规则关掉`);
    ok('O5', haloStrip && !haloDrawer,
      `落点环与投放**共用同一条判据**：可见条上实（.on=${haloStrip}）、抽屉上虚（.on=${haloDrawer}）—— 不会出现「环是实的、落下去却什么都没有」`);

    // 9-2 宽屏：器材栏与画布**并排不重叠** ⇒ 同一个落点必须照常落下。
    //     这条专门防「新判据把正常拖出误杀」，也是「宽屏行为与改前一致」的证据。
    const wide = mkScene(PaletteClass, {
      cw: 800, ch: 600, canvasLeft: 240, paletteRect: { left: 0, top: 0, width: 240, height: 600 },
    });
    const rw = firstRow(wide.list);
    rw.fire('pointerdown', pev('pointerdown', { x: 100, y: 300, pt: 'mouse' }));
    rw.fire('pointermove', pev('pointermove', { x: PX, y: PY, pt: 'mouse' }));
    rw.fire('pointerup', pev('pointerup', { x: PX, y: PY, pt: 'mouse' }));
    const wc = wide.calls.addEntity[wide.calls.addEntity.length - 1];
    ok('O2b', wide.calls.addEntity.length === 1 && !!wc && wc.x === snap(PX - 240) && wc.y === snap(PY),
      `宽屏（器材栏 0–240、画布从 x=240 起，不重叠）⇒ 同一点 (${PX},${PY}) 照常落下 (${wc && wc.x},${wc && wc.y})，没被新判据误杀`);
    ok('O2c', wide.calls.toast.length === 0,
      `成功落位时不弹取消提示（toast ${wide.calls.toast.length} 条）`);
  }

  return { pass: PASS, fail: FAIL, results: new Map(results) };
}

// ══════════════════════════════════════════════════════════
// 6. 跑：绿档 / 红档
// ══════════════════════════════════════════════════════════

const real = await loadPalette(srcRaw, 'real');
const api = {
  SNAP: real.SNAP, LONG_PRESS_MS: real.LONG_PRESS_MS, SLOP: real.SLOP, AXIS_SLOP: real.AXIS_SLOP,
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
      SNAP: mod.SNAP, LONG_PRESS_MS: mod.LONG_PRESS_MS, SLOP: mod.SLOP, AXIS_SLOP: mod.AXIS_SLOP,
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
const redsAligned = expectedRed === observedRed && ctrlBad === 0;
const okAll = allLanded && redsAligned && MUTANTS.length > 0;
console.log('');
console.log(`\x1b[1mPALETTE_DND_MUTATE_JSON\x1b[0m ${JSON.stringify({
  mutants: MUTANTS.length, expectedRed, observedRed, ctrlBad,
  // 两个独立的事实，分开报：①「变异体有没有真的落到代码行上」②「红数对不对齐」。
  // ⓘ 这里原本只有一个键叫 landInCode，但它算的其实是 ②（名字与含义相反）——
  //   名字撒谎的自证字段正是这轮在清的病灶，所以：landInCode 现在字面为真（=全部落到
  //   代码行上，与 stubLanded 同义，保留是为了不打断既有的读法），② 交给 redsAligned。
  stubLanded: allLanded,
  landInCode: allLanded,
  redsAligned,
  baselineRed: baseFail,
  ok: okAll,
})}`);
process.exit(okAll ? 0 : 1);
