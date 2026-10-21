// ══════════════════════════════════════════════════════════
// 画布功能栏 —— 把散落的**画布级**操作收拢成一条栏（task-27）
//
// 为什么在 `#stage` 里、且必须是 DOM：
//   ① `engine.overlays` 的回调只收 `(g, engine)` ⇒ 叠层**画得出、点不着**；而这里每个元素都是按钮。
//   ② 接缝图点名的风险已**实测**：顶栏插槽的渲染回调写的是 `host.innerHTML=`（`ui.toolbar.js` 三处），
//      同槽任一条目重渲染会把**外来节点**一起抹掉；而 `mountSlot` 的热路径本身
//      （剥注释后）**一行 innerHTML 都没有** ⇒ 不是协调器的错，是渲染回调的错。
//      ⇒ 容器挂 `#stage`（插槽之外），从根上避开这场重建风暴（实测读数见 tools/toolbar-probe.mjs）。
//
// 架构约束（照 `ui/touch.js` 踩过的那次全仓级红灯）：
//   本模块**只导出**，模块求值期**不碰任何 DOM** —— 否则 `tools/check.mjs` 与 `tools/guard-plugins`
//   一 import 就抛 `ReferenceError: document is not defined`，两道闸门同时失效。
//   装配全部发生在 `mount()` 调用期 ✓。
//
// 条数真源：本文件的 `BAR_ACTS`。探针直接读它，**不把条数写成字面量**（加一枚按钮不该让断言过期）。
// ══════════════════════════════════════════════════════════

/** 「撤销组装」的可用性判据来自**真源模块**：`src/presets/assembly.js` 的 `hasPreAssemble(app)`。
 *  ⚠ 本仓实测：`src/main.js` **没有**转发它（第 25 行只导入 `assemble`/`undoAssemble`）⇒
 *  `app.hasPreAssemble` 不存在。main.js 本波由别人持有（禁动）⇒ 这里**直连模块导出**，
 *  与 `readout.js` 直连 `caps.js`/`inspector.js` 是同一种接法；他的文件零字节改动。
 *  判据只有一处：不在这里重算「有没有快照」，免得出现第二份真相。 */
import { hasPreAssemble } from '../presets/assembly.js';

/** 一次缩放按钮的倍率。与滚轮同一条式子（`engine.zoomAt`），只是系数由「滚轮 delta」换成固定档。 */
export const ZOOM_STEP = 1.25;

/** 4 枚工具图标逐字沿用 `plugins/ui.toolbar.js` 原来的 `ICO`（搬家，不是重画）。 */
const ICO = {
  select: '<path d="M4 2.5l8.5 7.2-3.6.5 2 4.1-1.7.8-2-4.1-2.6 2.6z"/>',
  wire: '<path d="M3.5 11.5c0-3.9 2.2-7 5-7s5 3.1 5 7" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="3.5" cy="12.4" r="1.7"/><circle cx="13.5" cy="12.4" r="1.7"/>',
  pour: '<path d="M2.5 3h7l-3.5 5v4.2c0 .7.6 1.3 1.3 1.3h1.4c.7 0 1.3-.6 1.3-1.3V8L13.5 3z"/>',
  erase: '<path d="M5.5 2.5h6l1 2h3v1.5h-13V4.5h3zM4 7h9l-.8 6.2c-.1.8-.8 1.3-1.6 1.3H6.4c-.8 0-1.5-.5-1.6-1.3z"/>',
  // 视口三枚是本项新增（原来只存在于手势里，没有 UI 呈现）—— 所以它们没有「原图标」可搬。
  zoomIn: '<circle cx="7.5" cy="7.5" r="4.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M11.2 11.2L14 14M5.5 7.5h4M7.5 5.5v4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
  zoomOut: '<circle cx="7.5" cy="7.5" r="4.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M11.2 11.2L14 14M5.5 7.5h4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
  zoomReset: '<path d="M2.5 6V2.5H6M13.5 10v3.5H10" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M2.5 2.5l4 4M13.5 13.5l-4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
  // 撤销组装：往外拐的回退箭头（本项新增 —— 原来只有一个 API，没有任何可见入口）
  undoAssemble: '<path d="M3.2 6.6h6.4c2.1 0 3.8 1.7 3.8 3.8S11.7 14.2 9.6 14.2H6.2" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M5.6 3.7L2.7 6.6l2.9 2.9" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>',
};
const svg = (d) => `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">${d}</svg>`;

/**
 * 功能栏的**声明表**：栏里有什么、点了做什么，只有这一处。
 * `kind: 'tool'` 走 `app.setTool()`（与键盘 `v/w/p/x` 同一个出口）；
 * `kind: 'view'` 走 `engine.zoomAt / engine.resetView`（与滚轮 / 双击复位同一个出口）。
 * `cls` 复用既有的按钮样式（`.tool-btn` / `.tb-btn`）⇒ **不另造配色**，尺寸也只在那一处声明。
 */
const BTNS = [
  { act: 'select', kind: 'tool', cls: 'tool-btn', label: '选择', key: 'V', ico: ICO.select },
  { act: 'wire', kind: 'tool', cls: 'tool-btn', label: '连线', key: 'W', ico: ICO.wire },
  { act: 'pour', kind: 'tool', cls: 'tool-btn', label: '倾倒', key: 'P', ico: ICO.pour },
  { act: 'erase', kind: 'tool', cls: 'tool-btn', label: '删除', key: 'X', ico: ICO.erase },
  { act: 'zoomIn', kind: 'view', cls: 'tb-btn', label: '放大', ico: ICO.zoomIn },
  { act: 'zoomOut', kind: 'view', cls: 'tb-btn', label: '缩小', ico: ICO.zoomOut },
  { act: 'zoomReset', kind: 'view', cls: 'tb-btn', label: '复位视角', ico: ICO.zoomReset },
  // `kind: 'undo'` 是第三类：它**不碰引擎**（所以 `act()` 里必须排在 engine 分支之前，
  // 否则在没有引擎的替身里会被 `if (!eng) return false` 挡掉）。
  { act: 'undoAssemble', kind: 'undo', cls: 'tb-btn', label: '撤销组装', ico: ICO.undoAssemble },
];

/** 给探针读的**唯一**条数真源（断言不写字面量） */
export const BAR_ACTS = BTNS.map((b) => b.act);

/** 挂载标记打在 `app` 上：重复 mount 不许叠出第二条栏（照 equipbar 那枚 Symbol 的做法）。 */
const MOUNTED = Symbol.for('xiaomo.canvasbar.mounted');

const CSS = `
.xm-canvasbar{
  position:absolute; left:50%; transform:translateX(-50%); bottom:58px; z-index:3;
  display:flex; flex-wrap:wrap; justify-content:center; align-items:center; gap:6px;
  max-width:calc(100% - 16px); padding:6px; border-radius:var(--radius-sm);
  background:var(--surface-3); border:1px solid var(--border); box-shadow:var(--shadow);
  pointer-events:none;
}
.xm-canvasbar .tool-btn,.xm-canvasbar .tb-btn{pointer-events:auto; touch-action:manipulation}
.xm-canvasbar .xm-cbar-slot{display:flex; align-items:center; gap:6px; pointer-events:auto}
/* 外来开关还没挂上时（task-28 未就绪），空位自我收起，不留一段空白 */
.xm-canvasbar .xm-cbar-slot:empty{display:none}
/* 看得见的尺寸改动走 pointer:coarse（D25）；命中盒那类隐形改动才用 any-pointer:coarse。
   本条是这些按钮**唯一**的粗指针尺寸声明（D32：一个控件的尺寸只许在一个样式表里声明）。 */
@media (pointer: coarse){
  .xm-canvasbar .tool-btn,.xm-canvasbar .tb-btn{min-height:44px; min-width:44px}
}
`;

export class CanvasBar {
  constructor(app, opts = {}) {
    this.app = app;
    this.opts = opts;
    /** 允许注入 document（探针在 Node 里跑真模块用）；不注入就取全局 */
    this.doc = opts.document ?? (typeof document !== 'undefined' ? document : null);
    this.root = null;
    this.stage = null;
    this.styleEl = null;
    this.offTick = null;
    this.toolBtns = new Map();
    this.gridBox = null;
    this.undoBtn = null;
    this.lastTool = undefined;
    this.lastUndoCan = undefined;
  }

  /** 注入一次样式（同文档只注入一份；dispose 时摘掉）。 */
  _injectStyle() {
    const doc = this.doc;
    if (!doc || this.styleEl) return;
    if (doc.querySelector && doc.querySelector('style[data-xm-canvasbar]')) return;
    const s = doc.createElement('style');
    s.setAttribute('data-xm-canvasbar', '');
    s.textContent = CSS;
    const head = doc.head || doc.documentElement;
    if (head && head.appendChild) head.appendChild(s);
    this.styleEl = s;
  }

  /**
   * 装到 `host`（默认 `#stage`）。**幂等**：装过就返回原来那条，不叠第二条。
   * 无画布 / 无 document ⇒ 安静返回 null，不抛（触控层与探针都会在无 DOM 环境调到这里）。
   */
  mount(host) {
    if (this.root) return this.root;
    const doc = this.doc;
    if (!doc || typeof doc.createElement !== 'function') return null;
    const app = this.app;
    if (app && app[MOUNTED]) return app[MOUNTED];        // 别人已挂过：共用那一条
    const stage = host || (doc.querySelector ? doc.querySelector('#stage') : null);
    if (!stage || typeof stage.appendChild !== 'function') return null;
    this.stage = stage;
    this._injectStyle();

    const bar = doc.createElement('div');
    bar.className = 'xm-canvasbar';
    bar.setAttribute('role', 'toolbar');
    bar.setAttribute('aria-label', '画布功能栏');
    for (const b of BTNS) {
      const el = doc.createElement('button');
      el.type = 'button';
      el.className = b.cls;
      // `data-action` 与 task-28 的网格开关（`src/ui/grid-toggle.js` 里 `btn.dataset.action = 'grid'`）
      // 用**同一个**约定名，免得栏里两种约定并存；本栏不做事件委托（每枚按钮自带监听器），
      // 所以它只是**契约名**，不是派发键。
      el.dataset.action = b.act;
      if (b.kind === 'tool') el.dataset.tool = b.act;    // 保住「全文档 [data-tool] 恒为工具数」这条契约
      el.title = b.key ? `${b.label} (${b.key})` : b.label;
      el.setAttribute('aria-label', el.title);
      el.innerHTML = svg(b.ico);
      el.addEventListener('click', () => this.act(b.act));
      if (b.kind === 'tool') this.toolBtns.set(b.act, el);
      if (b.kind === 'undo') this.undoBtn = el;
      bar.appendChild(el);
    }
    // ── 外来开关的**空位**（网格 / 坐标开关，来自 task-28）──
    // ⚠ 它**不**进 `BTNS`：那个开关的真源在 task-28 那边（`src/ui/grid-toggle.js`），
    //   并进本表就会变成两个真源，迟早不一致。本模块只留位 + 调用，**不自己实现**。
    const box = doc.createElement('div');
    box.className = 'xm-cbar-slot';
    box.setAttribute('data-xm-slot', 'grid');
    bar.appendChild(box);
    this.gridBox = box;

    stage.appendChild(bar);
    this.root = bar;
    if (app) app[MOUNTED] = bar;
    this._hookGrid();
    // 工具态**只能靠节拍轮询**：`setTool` 不发任何事件（`interact.js` 里只写 this.tool + 状态栏）。
    // 轮询体只做一次字符串比较，且**只在真的变了才写 DOM** —— 与 ui.toolbar.js 同步撤销/重做同一口径。
    // 节拍里连两态一起同步：用户可能在**别的面板**里组装（或撤走）⇒ 这枚按钮要自己跟上，
    // 不能只在挂载时算一次（否则组装完了按钮还是灰的）。轮询体只做一次布尔比较。
    this.offTick = (app && typeof app.addTick === 'function') ? app.addTick(() => { this.sync(); this.syncUndo(); }) : null;
    this.sync();
    this.syncUndo();
    return bar;
  }

  /** 把「当前工具」映到栏上的高亮。真的变了才写 DOM。 */
  sync() {
    if (!this.root) return;
    const app = this.app;
    const t = app && app.interaction ? app.interaction.tool : undefined;
    if (t === this.lastTool) return;
    this.lastTool = t;
    for (const [act, el] of this.toolBtns) {
      const on = act === t;
      el.classList.toggle('active', on);
      el.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
  }

  /**
   * 「撤销组装」的两态。**不可用时可见但禁用**，不是消失 —— 消失会让用户以为功能不存在；
   * 真变了才写 DOM（与 `sync()` 同一口径）。
   */
  syncUndo() {
    const el = this.undoBtn;
    if (!el) return;
    const can = this._canUndo();
    if (can === this.lastUndoCan) return;
    this.lastUndoCan = can;
    el.disabled = !can;
    el.setAttribute('aria-disabled', can ? 'false' : 'true');
  }

  /** 可用性：判据只有一处 —— 真源模块的 `hasPreAssemble(app)`。 */
  _canUndo() {
    const app = this.app;
    if (!app) return false;
    try { return !!hasPreAssemble(app); } catch (_) { return false; }
  }

  /** 反馈一律走**既有** `app.toast(msg, kind)`，不新造提示系统。提示失败不许影响功能。 */
  _say(msg, kind) {
    const app = this.app;
    if (!app || typeof app.toast !== 'function') return;
    try { if (kind) app.toast(msg, kind); else app.toast(msg); } catch (_) { /* 提示失败不算失败 */ }
  }

  /**
   * 结果码 → 一句话。**四种**码实测自 `src/presets/assembly.js` 的 `undoAssemble`：
   * 成功 / `no-preassemble` / `no-apply-save` / `no-app`（未知码带原码兜底，防以后加码漏分支）。
   * ⚠ `preset-not-found` 是 `assemble()` 的码，撤销这条路**不可能**返回它。
   */
  _undoMsg(r) {
    if (r && r.ok) {
      const n = (r.after && r.after.entities) || 0;
      return n ? `已撤销组装（回到组装前那 ${n} 件器材）` : '已撤销组装（回到组装前）';
    }
    switch (r && r.reason) {
      case 'no-preassemble': return '没有可撤销的组装';
      case 'no-apply-save': return '撤销失败：这个世界没有载回存档的入口';
      case 'no-app': return '撤销组装在当前环境里不可用';
      default: return '撤销组装没有成功' + (r && r.reason ? `（${r.reason}）` : '');
    }
  }

  /**
   * 把 task-28 的网格 / 坐标开关挂进那个空位。入口是对方**冻结**的
   * `mountGridToggle(container, engine)` —— 它不 import 本模块、也不改本文件。
   *
   * ⚠ **必须**是动态 `import()`，不能写成静态 import：
   *   静态 import 一个「可能还没落盘」的模块会让**整个引导**抛
   *   `Cannot find module …`（本仓当天刚真实发生过一次：`src/experiments/assembly.js`
   *   缺失 ⇒ 装载守卫 0/32、检查套件 84/7，两道闸门一起红）。
   *   这里落盘时对方模块可能还没就绪 ⇒ 未就绪就**留空位**，既不抛错也**不放假替身**。
   */
  _hookGrid() {
    const box = this.gridBox;
    if (!box) return;
    const eng = this.app && this.app.engine;
    Promise.resolve()
      .then(() => import('./grid-toggle.js'))          // 依赖 task-28 的挂载入口
      .then((m) => {
        if (!this.root || !this.gridBox) return;       // 期间被 dispose ⇒ 不往孤儿节点上挂
        if (m && typeof m.mountGridToggle === 'function') m.mountGridToggle(this.gridBox, eng);
      })
      .catch(() => { /* 入口尚未就绪：留一个空位就好，什么都不做 */ });
  }

  /** 画布中心（**画布相对**坐标 —— `interact.js` 的 `pos()` 就是相对 canvas 算的，`zoomAt` 要的也是这个）。 */
  _centre() {
    const app = this.app;
    const cv = (app && app.engine && app.engine.canvas) || this.stage;
    const r = cv && typeof cv.getBoundingClientRect === 'function' ? cv.getBoundingClientRect() : null;
    if (r && r.width > 0 && r.height > 0) return { x: r.width / 2, y: r.height / 2 };
    return { x: 0, y: 0 };
  }

  /**
   * 执行一枚按钮。返回**是否真的走到了该动作**（探针据它区分「点了没反应」与「点了但值没变」）。
   * 每个分支都走既有出口，不自己发明第二条路径：
   *   tool      → `app.setTool()`（同键盘）
   *   zoomIn/Out→ `engine.zoomAt(eng.zoom * f, cx, cy)`（同滚轮；`zoomAt` 自己会置脏）
   *   zoomReset → `engine.resetView()`，**返回 true 才**补一次 `markDirty()`（同双击复位，逐字同口径）
   */
  act(name) {
    const app = this.app;
    if (!app) return false;
    const b = BTNS.find((x) => x.act === name);
    if (!b) return false;
    if (b.kind === 'tool') { app.setTool(name); this.sync(); return true; }
    if (b.kind === 'undo') {
      // 处理体**自己再判一次**：探针、程序化调用、键盘都绕过浏览器，只靠 `disabled` 的
      // 「画成灰的还能点」会漏（与 `plugins/ui.toolbar.js` 的 undo/redo 同一条口径）。
      if (!this._canUndo()) { this.syncUndo(); return false; }
      const fn = app.undoAssemble;
      if (typeof fn !== 'function') {
        this._say('撤销组装在当前环境里不可用', 'warn');
        this.syncUndo();
        return false;
      }
      let r = null;
      // 契约是「失败**返回**不抛」，这里仍然兜一层：入口一旦抛，也不许把栏带崩。
      try { r = fn.call(app); } catch (e) {
        this._say('撤销组装失败：' + ((e && e.message) || e), 'warn');
        this.syncUndo();
        return false;
      }
      this._say(this._undoMsg(r), r && r.ok ? null : 'warn');
      this.syncUndo();
      return true;
    }
    const eng = app.engine;
    if (!eng) return false;
    if (name === 'zoomReset') {
      if (typeof eng.resetView !== 'function') return false;
      if (eng.resetView()) app.markDirty();
      return true;
    }
    if (typeof eng.zoomAt !== 'function') return false;
    if (!(eng.zoom > 0)) return false;
    const f = name === 'zoomIn' ? ZOOM_STEP : name === 'zoomOut' ? 1 / ZOOM_STEP : 1;
    const c = this._centre();
    eng.zoomAt(eng.zoom * f, c.x, c.y);
    return true;
  }

  /** 拆除：栏、样式、轮询、挂载标记一并收回（探针会 mount→dispose→mount 验往返幂等）。 */
  dispose() {
    if (this.root && this.root.parentNode) this.root.parentNode.removeChild(this.root);
    this.root = null;
    this.toolBtns.clear();
    this.gridBox = null;
    this.undoBtn = null;
    this.lastTool = undefined;
    this.lastUndoCan = undefined;
    if (this.offTick) { this.offTick(); this.offTick = null; }
    if (this.styleEl && this.styleEl.parentNode) this.styleEl.parentNode.removeChild(this.styleEl);
    this.styleEl = null;
    const app = this.app;
    if (app && app[MOUNTED]) delete app[MOUNTED];
  }
}

/** 便捷入口：建一条并挂上（幂等由 CanvasBar.mount 自己保证）。 */
export function mountCanvasBar(app, opts) {
  const bar = new CanvasBar(app, opts);
  const el = bar.mount(opts && opts.host);
  return el ? bar : null;
}
