// ══════════════════════════════════════════════════════════
// UI · 逐件就地读数（task-26 项②）+ 锁定开关（task-26 项①）
//
// 规格与判据：`plans/17-第二批五项-接缝图.md` 项①/项② 六栏；判据在
//   `tools/lock-readout-probe.mjs`（§④⑤⑥ 是本模块的断言）。
//
// **为什么读数画在画布上、锁定开关走 DOM**（照接缝图项②第③栏的实测约束）：
//   `engine.overlays` 的回调只收到 `(g, engine)` ⇒ 叠层**画得出、点不着**。
//   · 读数纯展示 ⇒ Canvas：跟着视口天然跟手（叠层跑在 translate(pan)/scale(zoom) **之后**，
//     画的就是世界坐标），不占 DOM 节点，缩放平移不必自己换算坐标；
//   · 锁定是**动作** ⇒ 必须 DOM（真 `<button>`，白拿触屏命中、焦点、无障碍）。
//
// 三条纪律：
//  ① **读数只有一个数据源**：`def.stats`（与右侧属性面板 `inspector.js` 同一处声明、
//     同一处 `fmtBy`）。本模块**不**按 `e.type` 判断「这件器材有什么读数」，也**不**自己
//     写 `toFixed` —— 按 type 硬编码的那一套在 `src/ui/data.js`，再抄一份就是
//     「同一个物理量三个来源」（接缝图项②第⑥栏点名的最大风险）。
//  ② **不制造重绘**：读数每帧都在变（求解器每帧注入），所以本模块**绝不**调 `markDirty`：
//     它只在既有那一帧里画（引擎的脏标记是全仓唯一的重绘闸门，接缝图项②第⑥栏）。
//  ③ **动作实现不自己写**：锁定统一走 `caps.js` 的 `applyCap`（与右侧面板、浮出条同一套原语）。
// ══════════════════════════════════════════════════════════
import { menuCaps, applyCap } from '../equipment/caps.js';
import { fmtBy } from './inspector.js';
import { selectHub } from './equipbar.js';

/** 读数背板与器材之间的间距（世界 px） */
const GAP = 4;
/** 读数背板内边距（屏幕 px：字号不随缩放变，所以内边距也不变） */
const PAD = 3;
/** 读数行高与字号（**屏幕** px：只读叠层要「看得清」，不跟着缩放变粗变细） */
export const LINE_H = 12;
const FONT_PX = 10;
/** 读数避让的上限（**行距**数）：撞到上限就停手 —— 宁可仍重叠，也不许死循环 / 抛错 */
export const MAX_SHIFT = 8;
/** 与 engine.drawPortLabel 同一套字族：屏幕上两处叠层不该是两种字 */
const FONT = 'ui-sans-serif, system-ui, sans-serif';
/** 锁定的虚线框（世界 px：框要贴着器材几何，所以跟着缩放走） */
const LOCK_DASH = [4, 3];

/** 锁定按钮的文案。**只此一处** —— `CAP_KEYS` 里没有 `lock`（为何不能加见 caps.js 的 LOCK_CAP 注释） */
export const LOCK_TEXT = '锁定位置';
export const UNLOCK_TEXT = '解锁';
export const LOCK_ARIA = '锁定位置：锁住后拖不动，再点一次解锁';

/**
 * 逐件就地读数叠层。
 *
 * 与 `EquipBar` 的关系：**同一个选择通知枢纽**（`selectHub`，幂等包装只叠一层），
 * 所以选中一件器材时两处一起跟上；但本模块自己不包 `app.select`（再包一层就是
 * 「一次选中通知两次」—— `equipbar.js` 的纪律③）。
 */
export class Readout {
  constructor(app, opts) {
    const o = opts || {};
    this.app = app;
    // `document: null` 是**显式**「没有 DOM」：判据要能证明「纯 Node 下读数层照旧工作」，
    // 所以不能把显式的 null 当成「没传」而回落到全局 document
    this.doc = ('document' in o) ? o.document
      : (typeof document !== 'undefined' ? document : null);
    /** 当前选中件：DOM 锁定条跟着它（绘制不依赖它 —— 读数对**每件**器材都画） */
    this.ent = null;
    this.host = null;
    this.root = null;
    this.btn = null;
    /** 上一次绘制里「真的画出了读数」的器材数（探针读它，证明不是空转） */
    this.count = 0;
    /** 上一次绘制的世界锚点表：id → { x, y }（探针读它证明锚在器材自己的位置上） */
    this.anchors = [];
    /**
     * 上一次绘制的标签外框表（**屏幕** px，避让后的落点）：id / x / y / w / h / dy /
     * shifted / stillOverlap。探针拿它与**真的绘制指令**对拍（自报的表必须等于画出来的）。
     */
    this.rects = [];
    /**
     * 避让开关。`{ avoid: false }` 是**显式关掉**避让，只给判据用：证明「不避让真的会叠」
     * —— 只断言「避让后不重叠」是缺对照的，那个场景可能本来就不重叠。
     */
    this.avoid = o.avoid !== false;
    this._unsub = null;
    this._overlay = null;

    this.mount(o.host || this.pickHost());
    this._overlay = (g, engine) => this.draw(g, engine);
    const eng = app && app.engine;
    if (eng && Array.isArray(eng.overlays) && eng.overlays.indexOf(this._overlay) < 0) {
      eng.overlays.push(this._overlay);
    }
    this._unsub = selectHub(app).add((ent) => this.follow(ent));
    this.follow(app && app.selected);
  }

  /** 舞台元素（`position:relative` 的 #stage）：拿不到就只做无宿主逻辑（纯 Node 判据走这条） */
  pickHost() {
    const d = this.doc;
    return (d && typeof d.querySelector === 'function' && d.querySelector('#stage')) || null;
  }

  // ─── 读数：唯一数据源 `def.stats` ──────────────────────────
  /** 这件器材自报的统计量（没有就是空数组 —— 本模块**不猜**、不按 type 补） */
  stats(e) {
    return (e && e.def && e.def.stats) || [];
  }

  /**
   * 渲染成 `[{ label, text }]`，规则与 `src/ui/inspector.js` 的 stats 循环**逐条相同**
   * （字符串原样 / `fmt` 优先于有限性检查 / 非有限跳过 / 其余 `fmtBy(digits)` + 单位）。
   * ⚠ 那一段源码是 `tools/inspector-stats-probe.mjs` 的变异靶点 ⇒ **不许改**，
   *   所以这里不是「共用同一个函数」而是「同一套规则 + 一条差分断言」
   *   （`tools/lock-readout-probe.mjs` §④ 拿真实 `Inspector.render()` 的输出逐字对拍）。
   */
  lines(e) {
    const ctx = { app: this.app, world: this.app && this.app.world };
    const out = [];
    for (const s of this.stats(e)) {
      const v = s.read(e, ctx);
      if (typeof v === 'string') { out.push({ label: s.label, text: v }); continue; }
      if (s.fmt) { out.push({ label: s.label, text: s.fmt(v) }); continue; }
      if (!Number.isFinite(v)) continue;
      out.push({ label: s.label, text: fmtBy(s.digits, v) + (s.unit ? ' ' + s.unit : '') });
    }
    return out;
  }

  /** 一行的完整文本（背板宽度按它估 —— 与 engine.drawPortLabel 同一手法，不调 measureText） */
  static lineText(l) {
    return l.label ? l.label + ' ' + l.text : l.text;
  }

  /**
   * 标签背板的**屏幕**尺寸（宽度按字数估 —— 同上，不调 measureText）。
   * 避让与绘制**共用这一处算式**：各写一份就会「按一份算避让、按另一份画」。
   */
  static boxPx(ls) {
    let wMax = 0;
    for (const l of ls) wMax = Math.max(wMax, Readout.lineText(l).length);
    return { w: wMax * FONT_PX * 0.62 + PAD * 2, h: ls.length * LINE_H + PAD * 2 };
  }

  /** 两框是否**真的**交叠（边贴边不算 —— 否则紧挨着的两件会被判成冲突、白移一格） */
  static hit(a, b) {
    return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  }

  // ─── 画布叠层（世界坐标）──────────────────────────────────
  /**
   * 每帧被引擎调用一次（`engine.overlays` 的回调签名固定是 `(g, engine)`，只画不判）。
   * **不调 markDirty**：本方法只发生在已经决定要画的那一帧里。
   */
  draw(g, engine) {
    if (!g) return 0;
    const world = this.app && this.app.world;
    const ents = (world && world.entities) || [];
    const zoom = (engine && engine.zoom) || 1;
    let n = 0;
    const anchors = [];
    const rects = [];
    /** 本帧**已经占位**的标签外框（屏幕 px）：交叠判定与 pan 无关，所以不必知道 pan */
    const placed = [];
    for (const e of ents) {
      if (!e || e.alive === false) continue;
      if (e.locked === true) this.drawLockMark(g, e);
      const ls = this.lines(e);
      if (!ls.length) continue;            // ⚠ 没有 def.stats ⇒ 一行都不画（不画空框）
      // ── 避让：与**本帧已经占位**的标签交叠时，把后画的这一套整体下移一个行距，
      //    直到不交叠、或撞上 MAX_SHIFT（撞上限就停手：宁可仍重叠，绝不死循环）。
      const box = Readout.boxPx(ls);
      const rect = { x: e.x * zoom - box.w / 2, y: (e.y + (e.h || 64) / 2 + GAP) * zoom, w: box.w, h: box.h };
      let dy = 0, step = 0;
      if (this.avoid) {
        while (step < MAX_SHIFT && placed.some((b) => Readout.hit(b, rect))) {
          rect.y += LINE_H;               // 屏幕 px：行距恒定，缩放时读数不会越挤越密
          dy += LINE_H / zoom;            // 绘制吃的是世界坐标 ⇒ 换算回世界 px
          step++;
        }
      }
      const taken = placed.some((b) => Readout.hit(b, rect));
      placed.push(rect);
      this.drawLines(g, e, ls, zoom, dy);
      rects.push({ id: e.id, x: rect.x, y: rect.y, w: rect.w, h: rect.h, dy, shifted: dy !== 0, stillOverlap: taken });
      anchors.push({ id: e.id, x: e.x, y: e.y + (e.h || 64) / 2 + GAP });
      n++;
    }
    this.count = n;
    this.anchors = anchors;
    this.rects = rects;
    return n;
  }

  /** 锁定标记：贴着器材外框的一条虚线框（**世界 px**：框要跟着几何缩放） */
  drawLockMark(g, e) {
    const w = e.w || 64, h = e.h || 64;
    const x = e.x - w / 2, y = e.y - h / 2;
    if (g.save) g.save();
    if (g.setLineDash) g.setLineDash(LOCK_DASH);
    g.lineWidth = 1;
    g.strokeStyle = this.color('warn') || '#c8a24a';
    if (g.strokeRect) g.strokeRect(x, y, w, h);
    else if (g.rect) { g.beginPath(); g.rect(x, y, w, h); g.stroke(); }
    if (g.setLineDash) g.setLineDash([]);
    if (g.restore) g.restore();
  }

  /**
   * 一件器材的读数：背板 + 若干行，锚在器材**下沿外侧**。
   * ⚠ 反向缩放 `1/zoom`：字号与内边距是**屏幕** px（只读叠层要看得清），
   *   而锚点仍是世界坐标 ⇒ 移动 / 缩放后都贴在器材上（判据 §⑤）。
   * `dy` 是避让位移（**世界** px，来自 `draw()`）：0 就是没冲突、逐位等于改前的落点。
   */
  drawLines(g, e, ls, zoom, dy) {
    const x = e.x;
    const y = e.y + (e.h || 64) / 2 + GAP;
    // ⚠ 写 `dy ? y + dy : y` 而不是 `y + dy`：没冲突时 `oy` **就是**改前那个值，
    //   「无冲突 ⇒ 一点像素都不动」由这一行保证（不是浮点上的巧合）
    const oy = dy ? y + dy : y;
    const box = Readout.boxPx(ls);
    const bw = box.w;
    const bh = box.h;
    if (g.save) g.save();
    if (g.translate) g.translate(x, oy);
    if (g.scale) g.scale(1 / zoom, 1 / zoom);
    g.fillStyle = this.color('panel') || 'rgba(20,22,26,0.82)';
    if (g.fillRect) g.fillRect(-bw / 2, 0, bw, bh);
    g.font = FONT_PX + 'px ' + FONT;
    g.textAlign = 'center';
    g.textBaseline = 'top';
    g.fillStyle = this.color('fg') || '#e8eaed';
    for (let i = 0; i < ls.length; i++) {
      if (g.fillText) g.fillText(Readout.lineText(ls[i]), 0, PAD + i * LINE_H);
    }
    if (g.restore) g.restore();
  }

  /** 取主题色（拿不到就由调用处用兜底色 —— 叠层不该因为主题没装就不画） */
  color(key) {
    const c = this.app && this.app.theme && this.app.theme.color;
    if (c && typeof c === 'function') { const v = c(key); if (typeof v === 'string') return v; }
    return null;
  }

  // ─── DOM 锁定条 ────────────────────────────────────────────
  mount(host) {
    const d = this.doc;
    if (!d || typeof d.createElement !== 'function') return this;
    this.host = host || null;
    const root = d.createElement('div');
    root.className = 'xm-lockrow';
    const b = d.createElement('button');
    b.type = 'button';
    b.className = 'btn';
    b.textContent = LOCK_TEXT;
    if (b.setAttribute) { b.setAttribute('aria-label', LOCK_ARIA); b.setAttribute('title', LOCK_ARIA); }
    if (b.addEventListener) b.addEventListener('click', () => this.toggleLock());
    if (root.appendChild) root.appendChild(b);
    if (root.hidden !== undefined) root.hidden = true;
    this.root = root;
    this.btn = b;
    if (this.host && this.host.appendChild) this.host.appendChild(root);
    return this;
  }

  /** 选中件变化：DOM 条跟着它（读数绘制不依赖它，每件器材都画） */
  follow(ent) {
    this.ent = ent || null;
    const caps = this.ent ? menuCaps(this.ent) : null;
    const can = !!(caps && caps.lock);
    if (this.root && this.root.hidden !== undefined) this.root.hidden = !can;
    if (this.btn) {
      const locked = !!(this.ent && this.ent.locked);
      this.btn.textContent = locked ? UNLOCK_TEXT : LOCK_TEXT;
      if (this.btn.className !== undefined) this.btn.className = 'btn' + (locked ? ' acc' : '');
    }
    return this;
  }

  /**
   * 锁定 / 解锁（DOM 按钮与探针都走这里 ⇒ 只有一条路）。
   * 动作实现是 `caps.js` 的 `applyCap`（唯一「位 → 动作」定义处），本方法只管视图跟进。
   */
  toggleLock(ent) {
    const e = ent || this.ent;
    if (!e) return false;
    const acted = applyCap(this.app, e, 'lock', () => this.follow(e));
    this.follow(e);
    return acted;
  }

  dispose() {
    if (this._unsub) { this._unsub(); this._unsub = null; }
    const eng = this.app && this.app.engine;
    if (eng && Array.isArray(eng.overlays) && this._overlay) {
      const i = eng.overlays.indexOf(this._overlay);
      if (i >= 0) eng.overlays.splice(i, 1);
    }
    if (this.root && this.root.parentNode && this.root.parentNode.removeChild) {
      this.root.parentNode.removeChild(this.root);
    }
    this.root = null; this.btn = null; this.ent = null;
    return this;
  }
}

/**
 * 装一层就地读数（幂等：同一 app 重复调用返回同一个实例）。
 * ⚠ **不推入 `ALL_PLUGINS`**：UI 插件数被 `tools/guard-plugins.mjs` 冻结在 32，
 *   而本模块是纯视图叠层、没有插件生命周期（挂载与卸载由 `src/ui/interact.js` 负责）。
 */
const INSTALLED = new WeakMap();
export function installReadout(app, opts) {
  if (!app) return null;
  const hit = INSTALLED.get(app);
  if (hit && hit.root !== null) return hit;
  const r = new Readout(app, opts);
  INSTALLED.set(app, r);
  return r;
}
