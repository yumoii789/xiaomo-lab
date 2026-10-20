// ══════════════════════════════════════════════════════════
// 选中器材的「就地控制条」—— 把最常用的操作放到手指够得到的地方
//
// 对照来源：plans/16-NB物品交互方式对照.md（NB 的 `equRightPop`：**单击**浮层、
// `placement:"right"`、菜单项由器材自己的能力位决定）。本模块只借它的**做法**，
// 外观全部落在我方 token（复用 styles/main.css 的 `.btn` / `.btn.acc` / `.btn.dgr`）。
//
// 为什么是 DOM 而不是 canvas 叠层：`engine.overlays` 是**只画不判**（`engine.js` 里
// 那个循环只传 `(g, engine)`），命中测试在 `Interaction.onDown` 里另走 `world.pickAll`。
// 走 canvas 就得把命中判据写进 `src/ui/interact.js` —— 那是另一个写者的文件。
// 真 `<button>` 顺带白拿触屏命中、焦点、无障碍。
//
// 三条纪律：
//  ① **定位走引擎的坐标契约**：`screenToWorld()` 是唯一换算出口，它的反向由**采样它自己**
//     得到，不重写 `w*zoom+pan`（重写 = 第二个真相源，`zoom` 一改就当场错位）。
//  ② **按钮作用在「打开浮层时那件器材」上**：闭包捕获身份，点击时用
//     `app.selected === target` 做守卫 —— 选中被移走就关掉浮层，绝不对着一件
//     已经不相关的器材动手（本仓刚修过共享状态串台）。
//  ③ **`app.select` 的包装幂等且可还原**：插件会被 reload / teardown，第二次 setup
//     再包一层就会「一次选中通知两次」，卸载后还会残留一层指向已销毁的浮层。
//  ④ **动作实现不自己写**：五个位统一调 `caps.js` 的 `applyCap`（与右侧面板同一套原语）。
//     换接口只准改实现、不准改行为 ⇒ 用探针 `swap.behaviourEqual` 钉住调用次数逐位不变。
// ══════════════════════════════════════════════════════════
import { menuCaps, CAP_KEYS, applyCap } from '../equipment/caps.js';

/** 器材外框与控制条之间的间距（舞台局部 px） */
const GAP = 10;
/** 与舞台边缘的安全距离 */
const EDGE = 6;
/** 控制条的兜底尺寸：量不到 layout 时用它算锚点（探针里也走这条路） */
const FALLBACK_W = 168;
const FALLBACK_H = 34;

/** 动作顺序与 `src/ui/inspector.js` 的渲染顺序**逐位一致**（同一套能力位，两处呈现） */
const CAP_ORDER = ['toggle', 'ignite', 'empty', 'duplicate', 'remove'];

const HUB = Symbol.for('xiaomo.equipbar.selectHub');

/**
 * `app.select` 的通知枢纽：包装**只做一次**，订阅者按引用计数进出。
 *
 * 幂等的实现要点：枢纽标记挂在**包装函数自己**身上（`wrapped[HUB]`），不是只挂在 `app` 上。
 * 这样即使 `app.select` 因为别的原因被换掉又换回来、或 `app[HUB]` 因故丢了，下一次
 * `selectHub()` 仍然认得出「这已经是我的包装」并复用同一份订阅表，不会叠第二层。
 */
export function selectHub(app) {
  const cur = app && app.select;
  if (cur && cur[HUB]) return cur[HUB];         // 已包过 ⇒ 复用，绝不叠第二层
  const subs = new Set();
  const orig = typeof cur === 'function' ? cur : function () {};
  const wrapped = function (ent) {
    const out = orig.call(this, ent);
    // 快照遍历：订阅者在回调里退订不应影响本轮其余订阅者
    for (const fn of Array.from(subs)) {
      try { fn(ent, this); } catch (e) { /* 一个订阅者抛错不影响其余订阅者，也不影响 select 本身 */ }
    }
    return out;
  };
  const hub = {
    subs,
    orig,
    get wrapCount() { return 1; },
    add(fn) { subs.add(fn); return () => hub.drop(fn); },
    drop(fn) {
      subs.delete(fn);
      // 最后一个订阅者走了才还原 —— 还原成原函数，卸载后不再有回调打到已销毁的浮层
      if (subs.size === 0 && app.select === wrapped) app.select = orig;
    },
    /** 只给探针用：当前生效的订阅者数 */
    get live() { return subs.size; },
  };
  wrapped[HUB] = hub;
  app.select = wrapped;
  return hub;
}

export class EquipBar {
  constructor(app, opts) {
    this.app = app;
    this.doc = (opts && opts.document) || (typeof document !== 'undefined' ? document : null);
    this.host = null;          // 舞台元素（position:relative 的 #stage）
    this.root = null;          // 控制条根节点
    this.ent = null;           // **打开浮层时那件器材**（反串台的身份真源）
    this.size = { w: FALLBACK_W, h: FALLBACK_H };
    // 尺寸**可注入**：真浏览器里量得到 offsetWidth/Height，纯 Node 里恒为 0。
    // 注入让判据能拿**真页面实测的尺寸**（Lead 无头 Edge：116×38）跑同一批锚点不变式，
    // 而不是只证明「兜底尺寸下的算法自洽」。
    this.forced = (opts && opts.size) || null;
    if (this.forced && this.forced.w > 0 && this.forced.h > 0) {
      this.size = { w: this.forced.w, h: this.forced.h };
    }
    this.notices = 0;          // 选中通知次数（探针读它证明「每次选中恰好 1 次」）
    this.side = 'right';       // 最近一次的落位侧（探针读它证明越界会翻转）
    this._unsub = null;
    this._overlay = null;
    this._styleEl = null;
    this._refs = [];
  }

  // ────────────────────────────────────────────────────────
  // 挂载 / 拆除
  // ────────────────────────────────────────────────────────

  /**
   * 挂到舞台上。`#stage` 是 `position:relative`（styles/main.css），
   * 控制条绝对定位在它内部；`overflow:hidden` 顺带保证控制条**跑不出舞台**，
   * 所以锚点必须在舞台内夹取（见 `place`）。
   */
  mount(hostArg) {
    if (this.root) return this;                       // 幂等：重复 mount 不叠节点
    const doc = this.doc;
    if (!doc || !doc.createElement) return this;      // 没有 DOM（纯 Node）⇒ 静默不挂
    this.host = hostArg || (doc.getElementById ? doc.getElementById('stage') : null);
    if (!this.host) return this;                      // 宿主不在 ⇒ 不挂，不抛

    this._injectStyle();

    const root = doc.createElement('div');
    root.className = 'xm-equipbar';
    root.hidden = true;
    // 无障碍：控制条是一组按钮，给它一个可读名
    if (root.setAttribute) {
      root.setAttribute('role', 'toolbar');
      root.setAttribute('aria-label', '器材快捷操作');
    }
    this.host.appendChild(root);
    this.root = root;
    this._refs.push(root);

    // 通知：选中变了就同步（幂等包装，见 selectHub）
    const hub = selectHub(this.app);
    this._unsub = hub.add(() => { this.notices++; this.sync(); });

    // 跟随：拖动器材 / 平移缩放视口都要重锚。复用渲染钩子 ——
    // `engine.overlays` 的回调**只画不判**，我们忽略画布参数、只做 DOM 定位，
    // 因此仍然完全不碰 interact.js。⚠ sync() 里绝不 markDirty，否则自激。
    const eng = this.app && this.app.engine;
    if (eng && Array.isArray(eng.overlays)) {
      const fn = () => { this.sync(); };
      eng.overlays.push(fn);
      this._overlay = fn;
    }

    this.sync();
    return this;
  }

  /** 拆除：DOM、样式、通知订阅、渲染钩子全部还原，可重复调用 */
  dispose() {
    if (this._unsub) { this._unsub(); this._unsub = null; }
    const eng = this.app && this.app.engine;
    if (this._overlay && eng && Array.isArray(eng.overlays)) {
      const i = eng.overlays.indexOf(this._overlay);
      if (i >= 0) eng.overlays.splice(i, 1);
    }
    this._overlay = null;
    for (const el of this._refs) { if (el && el.remove) el.remove(); }
    this._refs.length = 0;
    if (this._styleEl && this._styleEl.remove) this._styleEl.remove();
    this._styleEl = null;
    this.root = null;
    this.ent = null;
    this.host = null;
    return this;
  }

  // ────────────────────────────────────────────────────────
  // 坐标：世界 → 舞台局部屏幕 px
  // ────────────────────────────────────────────────────────

  /**
   * 世界 → 屏幕。**由采样 `engine.screenToWorld` 反解**，不重写 `w*zoom + pan`。
   *
   * 依据：`screenToWorld(x,y) = (x - pan)/zoom` 是仿射的，采样原点和两个单位点就能
   * 唯一确定它的逆：`o = screenToWorld(0,0)`、`ex = screenToWorld(1,0)`，
   * 则 `screen.x = (wx - o.x) / (ex.x - o.x)`。**引擎改了换算，这里自动跟着改** ——
   * 这正是「不重写公式」换来的东西。
   */
  worldToScreen(wx, wy) {
    const eng = this.app && this.app.engine;
    if (!eng || typeof eng.screenToWorld !== 'function') return { x: wx, y: wy };
    const o = eng.screenToWorld(0, 0);
    const ex = eng.screenToWorld(1, 0);
    const ey = eng.screenToWorld(0, 1);
    const dx = ex.x - o.x;
    const dy = ey.y - o.y;
    // 退化视口（非有限 / 零缩放）⇒ 退成恒等，宁可不动也不许 NaN 进样式
    if (!isFinite(dx) || !isFinite(dy) || dx === 0 || dy === 0) return { x: wx, y: wy };
    return { x: (wx - o.x) / dx, y: (wy - o.y) / dy };
  }

  /** 器材在世界里的外框（`bounds()` 与画布上那个落位轮廓用的是同一个），换算到舞台局部 */
  rectOf(ent) {
    const b = (ent.bounds && ent.bounds()) || { w: ent.w || 0, h: ent.h || 0 };
    const tl = this.worldToScreen(ent.x - b.w / 2, ent.y - b.h / 2);
    const br = this.worldToScreen(ent.x + b.w / 2, ent.y + b.h / 2);
    return {
      left: tl.x, top: tl.y, right: br.x, bottom: br.y,
      w: br.x - tl.x, h: br.y - tl.y,
      cx: (tl.x + br.x) / 2, cy: (tl.y + br.y) / 2,
    };
  }

  /**
   * 锚点规则（**这是本模块唯一一处「浮层该摆哪」的判据**）：
   *  1. 默认放器材**右侧**、竖直居中 —— 与 NB 的 `placement:"right"` 同侧；
   *  2. 右侧放不下（超舞台右边界）⇒ **翻到左侧**；
   *  3. 左侧也放不下 ⇒ **夹取**到 `[EDGE, 舞台宽 - 条宽 - EDGE]`；
   *  4. 竖直方向同理夹取。
   * 舞台 `overflow:hidden`，所以夹取是必须的，不是可选的美化。
   */
  place(rect, size) {
    const stageW = (this.host && this.host.clientWidth) || 0;
    const stageH = (this.host && this.host.clientHeight) || 0;
    const w = size.w, h = size.h;
    let side = 'right';
    let left = rect.right + GAP;
    if (stageW && left + w > stageW - EDGE) {
      const flipped = rect.left - GAP - w;
      if (flipped >= EDGE) { left = flipped; side = 'left'; }
      else { left = Math.max(EDGE, Math.min(left, stageW - w - EDGE)); side = 'clamp'; }
    }
    let top = rect.cy - h / 2;
    if (stageH) top = Math.max(EDGE, Math.min(top, stageH - h - EDGE));
    return { left: Math.round(left), top: Math.round(top), side };
  }

  // ────────────────────────────────────────────────────────
  // 同步 / 显隐
  // ────────────────────────────────────────────────────────

  /**
   * 单一更新路径：**显示/隐藏、重建按钮、重锚**都只走这里。
   * 什么都不返回；**绝不 markDirty**（它自己会被渲染钩子调用）。
   */
  sync() {
    if (!this.root) return this;
    const app = this.app;
    const ent = app && app.selected;
    // 未选中 / 选中的东西已经不在世界里（被删除）⇒ 收起
    const alive = ent && app.world && Array.isArray(app.world.entities)
      ? app.world.entities.indexOf(ent) >= 0
      : false;
    if (!ent || !alive) { this.hide(); return this; }

    if (ent !== this.ent) { this.build(ent); }
    const pos = this.place(this.rectOf(ent), this.size);
    this.side = pos.side;
    const st = this.root.style;
    if (st) {
      st.left = pos.left + 'px';
      st.top = pos.top + 'px';
      if (st.setProperty) st.setProperty('--xm-side', pos.side);
    }
    this.show();
    return this;
  }

  show() { if (this.root) this.root.hidden = false; return this; }
  hide() { if (this.root) this.root.hidden = true; this.ent = null; return this; }

  /** 按能力位重建按钮。文案与 `aria-label` 都**不新造词**（aria 直接用 CAP_KEYS 的语义） */
  build(ent) {
    const doc = this.doc;
    const caps = menuCaps(ent);
    const kids = [];
    for (const key of CAP_ORDER) {
      if (!caps[key]) continue;
      const b = doc.createElement('button');
      b.type = 'button';
      b.className = 'btn' + (key === 'toggle' ? ' acc' : key === 'remove' ? ' dgr' : '');
      b.textContent = capLabel(ent, key);
      const aria = CAP_KEYS[key];
      if (b.setAttribute && aria) b.setAttribute('aria-label', aria);
      b.dataset.cap = key;
      b.addEventListener('click', () => this.onCapClick(ent, key));
      kids.push(b);
      this._refs.push(b);
    }
    if (this.root.replaceChildren) this.root.replaceChildren(...kids);
    else { for (const k of kids) this.root.appendChild(k); }
    this.ent = ent;
    this.measure();
    return this;
  }

  /**
   * 读一次自己的实际尺寸。量不到（纯 Node / 探针）就用兜底常量 ——
   * 锚点仍然可算、可断言，只是不是像素级真实。
   */
  measure() {
    // 注入优先：判据要能用真尺寸跑（见 `tools/equipbar-probe.mjs` 的 `SIZE_TABLE`）。
    // 这一行被变异体 `size-inject-nop` 盯着 —— 它改成空操作，锚点就会变成「两个尺寸算同一组数」。
    if (this.forced && this.forced.w > 0 && this.forced.h > 0) return this.size;
    const w = this.root && this.root.offsetWidth;
    const h = this.root && this.root.offsetHeight;
    this.size = {
      w: isFinite(w) && w > 0 ? w : FALLBACK_W,
      h: isFinite(h) && h > 0 ? h : FALLBACK_H,
    };
    return this.size;
  }

  /**
   * **反串台的守卫**：作用对象是闭包捕获的 `target`（= 打开浮层时那件器材），
   * 但动手前必须先确认它**仍然是当前选中**。否则（选中被程序改成别的 / 变成 null /
   * 那件已被删除）一律不动手，收起浮层。
   * ⚠ 注意口径：作用对象**不是**「点击瞬间的 app.selected」（那是另一件器材），
   * 而是 `target`；`app.selected` 只用来做**身份校验**。
   */
  onCapClick(target, key) {
    const app = this.app;
    if (app.selected !== target) { this.hide(); return false; }
    if (!app.world || !Array.isArray(app.world.entities)
      || app.world.entities.indexOf(target) < 0) { this.hide(); return false; }
    // 动作实现统一走 caps.js 的 applyCap（与右侧面板同一套原语），本模块不再自己重复一遍。
    // 第 4 个参数（视图重绘）**故意不传**：本方法末尾本来就无条件 sync 一次，再把它接成
    // refresh 会让一次点击重绘两遍 —— 幂等，但没必要，且会让「一次点击几次 sync」这个
    // 计数变化。换接口只准改实现、不准改行为，所以那个计数也要守住。
    const acted = applyCap(app, target, key);
    if (acted) this.afterCap(key);
    this.sync();     // 复制会把选中改到副本上 ⇒ 立刻重锚到新器材
    return acted;
  }

  /**
   * 调用点补的那一笔：caps.js 对「世界的增删」（复制/删除）**不** markDirty
   * （面板侧本来如此，增删自己会 emit SCENE_DIRTY），而本模块换接口**之前**是对所有位
   * 都 markDirty 的。等价要补齐在这里、不塞回动作定义 —— 精确次数由探针钉住：
   * `swap.behaviourEqual` 钉实测调用次数，`swap-old-inline-body` 把换掉的那几行原样放回来
   * 并要求**一条断言都不许红**（等价性以测量为准，不以推理为准）。
   */
  afterCap(key) {
    if (key === 'duplicate' || key === 'remove') this.app.markDirty();
  }

  // ────────────────────────────────────────────────────────
  // 样式
  // ────────────────────────────────────────────────────────

  /**
   * 样式由模块自己注入（写域不含 `styles/**`）。
   * 全部复用 main.css 的 token 与 `.btn` 系列，**不新造配色**。
   * D32 两条纪律：跨层只抬 z-index；本控件的最小尺寸**只在这里声明一次**。
   * `z-index:12` 是**实测过**的（Lead 无头 Edge 真页面读到 12）：它该盖住
   * `#toast`(6) 与 `.stage-fx`(5)（一条控制条被提示条切掉才正常），
   * 也该被抽屉帘 `#drawerMask`(25) 盖住 —— 抽屉拉开时这条本来就该跟着失效。
   * 那是**有意**的层级关系，不是漏配。
   *
   * pointer-events 这一对**只能靠结构断言守**（探针里 `style.gapsPassThrough` +
   * 变异体 `style-eats-pointer`）。理由是同一类：它属那种「数值路径上看不见」的退化 ——
   * 容器吃不吃指针事件，不影响任何坐标或计数读数，只有读源码的样式文本才看得出来。
   * 本模块里已经有两条同性质的先例：`coord-copy-formula`（手写 `w*zoom+pan` 与采样反解
   * 逐位同值 ⇒ 数值断言杀不死，只有「源码不许出现 .zoom/.pan」杀得死）、`hub-double-wrap`
   * （叠两层不影响「一次选中一次通知」的计数 ⇒ 只有 `hub.singleLayer` 那种结构断言看得见）。
   * ⇒ 凡「不许制造第二真相源 / 不许叠层 / 不许挡住别人的命中目标」这类纪律，
   *   落到断言上就是**读文本或读结构**，不是读数值。
   */
  _injectStyle() {
    const doc = this.doc;
    if (!doc || !doc.createElement || !doc.head) return;
    if (this._styleEl) return;
    const el = doc.createElement('style');
    el.textContent = [
      // pointer-events：容器**放行**、按钮**收回**。
      // 为什么必须有：控制条是真 DOM、压在画布之上；若整块都吃指针事件，它盖住或
      // 挨着的接线柱就点不中了 —— 而接线是这张台子上最要紧的操作。
      // 放行容器之后，只有按钮本身是命中目标，缝与圆角都不挡手。
      '.xm-equipbar{position:absolute; z-index:12; pointer-events:none; display:flex; gap:6px; align-items:center;',
      ' padding:4px; border-radius:var(--radius-sm);',
      ' background:var(--surface-3); border:1px solid var(--border); box-shadow:var(--shadow);}',
      '.xm-equipbar .btn{pointer-events:auto; touch-action:manipulation}',
      '.xm-equipbar[hidden]{display:none}',
      // 看得见的尺寸改动挂 pointer: coarse（本仓判据：看得见的改动用 pointer: coarse，
      // 看不清的命中盒用 any-pointer: coarse）
      '@media (pointer: coarse){ .xm-equipbar .btn{ min-height:44px; padding:0 14px; font-size:13px } }',
    ].join('');
    doc.head.appendChild(el);
    this._styleEl = el;
  }
}

/** 按钮文案：短的给按钮，长的给 `aria-label`（`aria-label` 走 CAP_KEYS，不新造词） */
function capLabel(ent, key) {
  switch (key) {
    case 'toggle': return ent.props && ent.props.closed ? '断开' : '闭合';
    case 'ignite': {
      const noun = ent.name || '加热器';
      if (/灯/.test(noun)) return ent.props && ent.props.lit ? '熄灭' : '点燃';
      return ent.props && ent.props.lit ? '关闭' : '开启';
    }
    case 'empty': return '倒空';
    case 'duplicate': return '复制';
    case 'remove': return '删除';
    default: return CAP_KEYS[key] || key;
  }
}
