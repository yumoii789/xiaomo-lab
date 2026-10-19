// ══════════════════════════════════════════════════════════
// UI · 器材栏
// 与 registry 的 groups() 对接：域过滤 + 关键字搜索 + 分类分组
//
// 器材栏只是器材注册表的投影 —— 真值在 registry 里，这里不缓存第二份。
// 投影方式是「按 type 键控协调」，而不是每次重建整列：
//   · 行元素按 type 复用/移动，值真变时才写 DOM，节点身份稳定 ——
//     正在进行的过渡、以及用户焦点都不会被一次同步打断；
//   · 复用的行身上挂着事件与 aria，所以协调时只允许改内容、不允许换节点；
//   · 正因为不重建，「这个类型还在不在」就必须在点下去的那一刻当场再问注册表一次（place）。
//
// 交互有两条同等重要的路，别让任何一条把另一条挤掉：
//   · **点击/回车**：没有落点信息 ⇒ 交给 addEntity 自己找空位（freeSpot 避让）。
//   · **拖出**：落点就是用户指的地方 ⇒ 用那个点，**不避让**（理由见 dropAt）。
// ══════════════════════════════════════════════════════════

import { get, groups } from '../equipment/registry.js';

const DOMAIN_CLASS = { physics: 'phys', chemistry: 'chem', bridge: 'bridge' };

/** 值没变就不写：反复写同样的属性会打断过渡，也会平白制造变更记录 */
const setText = (n, t) => { if (n.textContent !== t) n.textContent = t; };
const setAttr = (n, k, v) => { if (n.getAttribute(k) !== v) n.setAttribute(k, v); };

/** 只在位置真的不对时才移动：insertBefore 会让节点重新入树，能不动就不动 */
function place(parent, node, prev) {
  const want = prev ? prev.nextSibling : parent.firstChild;
  if (node.parentNode !== parent || node !== want) parent.insertBefore(node, want);
}

// ── 拖出落位的四个参数。导出是为了让探针断言**产品里真正的那个值**，
//    而不是在探针里另抄一份常数（抄一份＝将来改产品探针不会红）。 ──

/** 触屏上按住多久算「拖出」而不是「滑动列表」（ms）。
 *  为什么用长按而不是纯位移阈值：行是整栏宽（窄屏 320px）的 role=button，
 *  纯位移阈值会让「想滑列表」的手指在起手 6–8px 的抖动里就误开拖拽；
 *  长按把「按住不动」与「划一下」分到**时间轴**上。
 *
 *  ⚠ **这个数字必须与 src/ui/touch.js 的 LONG_PRESS_MS 一致（550）**，
 *  不许自己另挑一个：同一个产品里两个长度不同的长按会显得坏掉。
 *  取值范围那边已经论证过，直接沿用它的结论 —— 原文：
 *  「短于 500ms 会跟『按住不放的轻点』混淆，长于 700ms 用户会以为没反应」。
 *  （我第一版自作主张写了 180ms，正好落在它明文排除的那一档里。） */
export const LONG_PRESS_MS = 550;
/** 长按判定之前允许的抖动（px）：超过它就认定「用户在滑列表」，把手势还给浏览器。
 *  同样与 src/ui/touch.js 的 LONG_PRESS_SLOP 对齐（10）。 */
export const SLOP = 10;
/** 鼠标/笔的拖拽启动阈值（px）。**必须有这个阈值**：鼠标没有滚动冲突，
 *  但若按下即进入拖拽，一次普通单击会变成「拖到光标处放手」，
 *  点击落位（freeSpot 避让）这条既有语义会当场被改掉。 */
export const DRAG_SLOP = 4;
/** 落点吸附步长：与 src/ui/interact.js 的 SNAP 同源 —— 拖动既有器材松手时
 *  走的也是 round(x/SNAP)*SNAP，两条路落在同一套格子上才不会有两套手感。 */
export const SNAP = 4;

/**
 * 「从器材栏拖到画布上放手后，窄屏抽屉要不要自动收起」的用户偏好键。
 * 默认 **不收起**（宽松：用户还能接着连拖第二件器材）。
 *
 * ⚠ 键名同时被 `tools/palette-dnd-probe.mjs` 与 `src/plugins/ui.settings.js` 引用，
 *   **改名要一起改**（与 xiaomo.display.v1 / xiaomo.theme.v1 同族的口径）。
 */
export const DROP_COLLAPSE_KEY = 'xiaomo.palette.drop.v1';

/** 读偏好。存储不可用（无痕模式/配额满）时按默认「不收起」，与 index.html 的兜底口径一致 */
export function readDropCollapse() {
  try { return localStorage.getItem(DROP_COLLAPSE_KEY) === '1'; } catch (e) { return false; }
}
/** 写偏好：存不下就只在本次会话生效，不抛错 */
export function saveDropCollapse(on) {
  try { localStorage.setItem(DROP_COLLAPSE_KEY, on ? '1' : '0'); } catch (e) { /* 同 readDropCollapse */ }
}

export class Palette {
  constructor(listEl, app) {
    this.el = listEl;
    this.app = app;
    this.domain = 'all';
    this.q = '';
    this.rows = new Map();   // type   -> .pitem（摘下去也留在表里：筛选来回切、插件停了又开，都复用同一节点）
    this.cats = new Map();   // 分类名 -> .pcat
    this.empty = null;       // 空态占位：只有它一个节点，没有身份要保
    this.drag = null;        // 进行中的那一次拖出（见 onRowDown）
    this.ghost = null;       // 跟着指针走的「正在拖的是哪件器材」
    this.halo = null;        // 跟着指针走的落点环
    this.suppressClick = false;
    this.guardScroll();
    this.sync();
  }

  setDomain(d) { if (this.domain !== d) { this.domain = d; this.sync(); } }

  setQuery(q) {
    const v = String(q == null ? '' : q);
    if (this.q !== v) { this.q = v; this.sync(); }
  }

  /** 旧名保留：对外其实只有「按注册表重新投影」这一件事 */
  render() { this.sync(); }

  /** 按注册表重新投影。幂等 —— 同一份注册表状态连跑多少次，DOM 与节点身份都不变。 */
  sync() {
    const gs = groups({ domain: this.domain, q: this.q });

    if (!gs.length) {
      if (!this.empty) {
        this.empty = document.createElement('div');
        this.empty.className = 'pal-empty';
      }
      setText(this.empty, this.q ? `没有找到「${this.q}」相关的器材` : '该分类下暂无器材');
      place(this.el, this.empty, null);
      // 分类容器整体摘走，行还在容器里，所以节点身份不丢
      for (const cat of this.cats.values()) cat.remove();
      return;
    }
    if (this.empty) this.empty.remove();

    const live = new Set();
    let prevCat = null;
    for (const g of gs) {
      let cat = this.cats.get(g.cat);
      if (!cat) {
        cat = document.createElement('div');
        cat.className = 'pcat';
        const title = document.createElement('div');
        title.className = 'pcat-title';
        cat.appendChild(title);
        this.cats.set(g.cat, cat);
      }
      setText(cat.firstElementChild, g.cat);

      let prev = cat.firstElementChild;
      for (const d of g.items) {
        live.add(d.type);
        let row = this.rows.get(d.type);
        if (!row) { row = this.makeRow(d); this.rows.set(d.type, row); }
        this.paintRow(row, d);
        place(cat, row, prev);
        prev = row;
      }
      place(this.el, cat, prevCat);
      prevCat = cat;
    }

    // 不在当前投影里的行摘下去；真正从注册表消失的类型也把行留在表里（下次回来还能复用）
    for (const [type, row] of this.rows) if (!live.has(type)) row.remove();
    for (const [name, cat] of this.cats) {
      if (gs.some((g) => g.cat === name)) continue;
      cat.remove();
      this.cats.delete(name);
    }
  }

  /**
   * 真的落一件器材。类型必须当场问注册表 ——
   * 注册表的 remove() 目前不通知任何人（tools/palette-probe.html 里有实测），
   * 所以点下去的那一刻这个类型可能已经不存在：那就既不能抛错，也不能默默毫无反应。
   *
   * x/y 可选：**给了就直接用**（拖出落位），没给就交给 addEntity 去 freeSpot（点击落位）。
   * 两种入口共用这一处「类型还在不在」的当场校验，免得只给其中一条路加校验。
   */
  place(d, x, y) {
    if (!get(d.type)) {
      if (this.app.toast) this.app.toast(`「${d.name}」所在的器材包已被卸载，无法添加`, 'warn');
      this.sync();                        // 顺手把这条陈旧投影摘掉
      return null;
    }
    return this.app.addEntity(d.type, x, y);
  }

  // ══════════ 拖出：器材栏 → 画布 ══════════

  /**
   * 只在**拖拽已经成立**时挡掉浏览器的列表滚动。
   *
   * 为什么不是一条无条件的 `touch-action:none`：那会让器材栏在触屏上**再也滑不动**
   * （列表本身要能上下滑）。所以这里分成两层：
   *   · 样式层给 `.pal-list` 只让出纵向滚动（touch-action:pan-y，见 styles/touch.css），
   *     未进入拖拽时纵向手势**完全归浏览器**，滑动列表的手感与改动前逐位一致；
   *   · 进入拖拽后，用一条非被动 touchmove + preventDefault 接管本次手势 ——
   *     否则浏览器会在纵向拖动时开始滚动，并给我一个 pointercancel 把拖拽掐断。
   * 两层缺一不可：只有样式层，纵向拖出会被掐断；只有这一层，滑动列表会变卡。
   */
  guardScroll() {
    this.el.addEventListener('touchmove', (e) => {
      if (this.drag && this.drag.armed && e.preventDefault) e.preventDefault();
    }, { passive: false });
  }

  /** 键盘可达：侧栏里的器材条目等同于按钮（画布内可豁免，侧栏不可） */
  makeRow(d) {
    const row = document.createElement('div');
    row.className = 'pitem';
    row.dataset.type = d.type;            // 键控协调、探针与人工排查都靠它定位这一行
    row.tabIndex = 0;
    row.setAttribute('role', 'button');

    const ico = document.createElement('span');
    ico.className = 'pi-ico';
    const txt = document.createElement('span');
    txt.className = 'pi-txt';
    txt.appendChild(document.createElement('b'));
    txt.appendChild(document.createElement('small'));
    row.append(ico, txt);

    row.addEventListener('pointerdown', (ev) => this.onRowDown(ev, d, row));
    row.addEventListener('pointermove', (ev) => this.onRowMove(ev));
    row.addEventListener('pointerup', (ev) => this.onRowUp(ev));
    // 指针被系统夺走（通知栏下拉、来电、浏览器接管手势）时必须收干净，
    // 与 src/ui/interact.js 的 pointercancel 同一条纪律：否则幽灵会永远挂在那里。
    row.addEventListener('pointercancel', (ev) => this.onRowCancel(ev));
    row.addEventListener('click', () => {
      // 一次拖出已经落过位了，别再让紧随其后的 click 重复放一件
      if (this.suppressClick) { this.suppressClick = false; return; }
      this.place(d);
    });
    row.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Enter' && ev.key !== ' ') return;
      // 全局快捷键挂在 window 上：焦点在条目上时 Space 必须属于条目，
      // 否则会同时切换「运行 / 暂停」；preventDefault 顺带挡住页面滚动。
      ev.preventDefault();
      ev.stopPropagation();
      this.place(d);
    });
    return row;
  }

  onRowDown(ev, d, row) {
    if (ev.button !== undefined && ev.button !== 0) return;      // 只认主键（右键不拖器材）
    this.endDrag();
    const st = {
      d, row, id: ev.pointerId, touch: ev.pointerType === 'touch',
      x0: ev.clientX, y0: ev.clientY, x: ev.clientX, y: ev.clientY,
      armed: false, timer: 0,
    };
    this.drag = st;
    // 触屏：按住不动 LONG_PRESS_MS 才进入拖拽（时间轴区分「滑动列表」）
    // 鼠标/笔：交给位移阈值（见 DRAG_SLOP），按下不进入 —— 否则单击会变成拖放
    if (st.touch) {
      st.timer = setTimeout(() => {
        st.timer = 0;
        if (this.drag === st && !st.armed) this.armDrag(st);
      }, LONG_PRESS_MS);
    }
  }

  onRowMove(ev) {
    const st = this.drag;
    if (!st || ev.pointerId !== st.id) return;
    st.x = ev.clientX; st.y = ev.clientY;
    const dx = ev.clientX - st.x0, dy = ev.clientY - st.y0;
    const far = Math.hypot(dx, dy);
    if (!st.armed) {
      if (st.touch) {
        // 触屏有**两条**入口，都在回答同一个问题：「这一下是要滚列表，还是要拖器材？」
        //
        // 1) **轴向意图（即时）**：位移超过 SLOP 且 |dx| > |dy| ⇒ 立刻成立，不用等。
        //    依据：器材栏是**纵向**滚动列表，横向位移**不可能**是滚列表 ——
        //    这就是浏览器/移动端标准的轴向锁定。用户要的「像 nb 那样直接把物品拖出来」
        //    靠它拿掉等待。真机代价是量出来的：3840×2160@3x 的一体机上，
        //    真手指按住 550ms 而抖动不超过 10px 很难做到，症状就是「仍然无法拖出」。
        // 2) **长按 550ms**（保留）：与 src/ui/touch.js 的 LONG_PRESS_MS/SLOP 同源。
        //    「按住再慢慢拖」的人走这条 —— 时间轴上的停顿本身就是意图声明。
        //    它成立之后**不再看轴向**（见函数末的 moveGhost 分支），否则按住后只能横着
        //    拖，长按这条入口就废了 —— 而纵向落位恰恰是桌面/竖屏最常见的用法。
        //
        // ⚠ 轴向锁定**只给触屏**。鼠标/笔没有「滚列表 vs 拖器材」这个歧义，
        //    给它加轴向锁定只会**弄坏**已经能用的桌面档：桌面用户会**纵向**把器材拖到
        //    画布上（画布就在列表右侧偏下），要求横向占优会当场把那条路关掉。
        if (far > SLOP) {
          const adx = Math.abs(dx), ady = Math.abs(dy);
          if (adx > ady) this.armDrag(st);        // 横向 ⇒ 只可能是拖器材
          else if (ady > adx) this.endDrag();     // 纵向 ⇒ 只可能是滚列表，整条还给浏览器
          // 恰好 45° 谁也不占：方向真的模糊，不猜（猜哪边都有一半是错的），
          // 保持待定 —— 上面那条长按入口仍然可以成立。
        }
      } else if (far > DRAG_SLOP) {
        this.armDrag(st);
      }
      return;
    }
    this.moveGhost(ev);
  }

  /** 拖拽成立：抓住指针。**必须 setPointerCapture** —— 指针离开器材栏之后会落到
   *  `#drawerMask`（z-index 25，盖在画布上）身上，不抓的话 move/up 全被遮罩吃掉，
   *  于是「拖出」会被误判成「点遮罩收起抽屉」，器材一件也落不了。 */
  armDrag(st) {
    st.armed = true;
    if (st.timer) { clearTimeout(st.timer); st.timer = 0; }
    if (st.row.classList) st.row.classList.add('dragging');
    try { if (st.row.setPointerCapture) st.row.setPointerCapture(st.id); } catch (e) { /* 无指针 API 的环境 */ }
    this.makeGhost(st);
  }

  onRowUp(ev) {
    const st = this.drag;
    if (!st || ev.pointerId !== st.id) return;
    const armed = st.armed;
    const w = armed ? this.dropWorld(st, ev) : null;
    this.endDrag();
    if (!armed) return;              // 没进入拖拽 ⇒ 什么都不做，click 照常发生（点击语义不变）
    // 进入过拖拽就一定吃掉这次 click：落位已经在放手里做完了
    this.suppressClick = true;
    setTimeout(() => { this.suppressClick = false; }, 0);
    if (w) { this.dropAt(st.d, w.x, w.y); return; }
    // 取消也要**说出来**。这条规则是新的、而且看不见：桌面档「拖回器材栏 = 取消」
    // 是用户已经学会的手势，窄屏档「拖到器材栏上也算取消」却是没学过的新规则，
    // 不解释的话表现就是「拖了半天什么都没发生」= 看起来拖放坏了。
    // 用户眼里「什么都没发生」是最坏的反馈 —— 与「静默挪位」同一条原则。
    this.cancelToast(
      ev && ev.clientX !== undefined ? ev.clientX : st.x,
      ev && ev.clientY !== undefined ? ev.clientY : st.y,
    );
  }

  /** 取消时给一句人能读的理由；两种原因分开说，不混成一句含糊的话 */
  cancelToast(cx, cy) {
    if (!this.app || !this.app.toast) return;
    this.app.toast(this.overPalette(cx, cy)
      ? '落在器材栏上不算放下 —— 拖到画布上再松手'
      : '松手点不在画布上，没有放下', 'warn');
  }

  onRowCancel(ev) {
    const st = this.drag;
    if (st && ev.pointerId === st.id) this.endDrag();   // 干净收尾：不留幽灵、不落位
  }

  /**
   * 放手点 → 世界坐标。**只经由 engine.screenToWorld**（唯一换算出口）。
   *
   * 自己写 `p.x - pan.x` 等于多一个「看得见但点不中」的机会 —— 而且当引擎有了
   * 缩放（zoom）之后，那条式子会**当场错**：世界 = (屏幕 − pan) / zoom 才是对的。
   * 所以这里一个 `pan` 都不碰，只把 client 坐标先转成「相对画布左上角」，
   * 与 src/ui/interact.js 的 pos(ev) 同一口径，然后整段交给 screenToWorld。
   *
   * 落点无效一律返回 null（画布之外、拖到顶栏、拖出窗口，以及**落在器材栏自己身上**
   * —— 那条判据的来由见 dropTargetOK 的注释）都算取消。
   */
  dropWorld(st, ev) {
    const eng = this.app.engine, cv = this.app.canvas;
    if (!eng || !cv || !eng.screenToWorld) return null;
    const r = cv.getBoundingClientRect ? cv.getBoundingClientRect() : null;
    if (!r) return null;
    const cxp = ev && ev.clientX !== undefined ? ev.clientX : st.x;
    const cyp = ev && ev.clientY !== undefined ? ev.clientY : st.y;
    if (!this.dropTargetOK(cxp, cyp)) return null;   // 画布之外 / 被器材栏盖住 = 取消
    return eng.screenToWorld(cxp - r.left, cyp - r.top);
  }

  /**
   * 放手落位。两处与「点击落位」**刻意不同**，都是裁定过的：
   *
   * 1) **不跑 freeSpot()**。freeSpot 的语义是「用户没说放哪，我替他挑一个不重叠的点」——
   *    点击投放没有落点信息，所以该避让；而拖放的落点**就是用户指的那一个点**。
   *    再拿 freeSpot 把它挪走，等于把「拖到想要的位置」偷偷换成「拖到附近的位置」。
   *    重叠是**看得见、可撤销**的（随后拖开、或撤销一步），静默挪位是**看不见的违背意图**。
   *    ⇒ 允许重叠，绝不替用户改落点。
   * 2) **吸附到 SNAP 网格**，与「拖动既有器材松手」同源（src/ui/interact.js 的
   *    round(x/SNAP)*SNAP）：两条路的落点落在同一套格子上，才不会有两套手感。
   */
  dropAt(d, wx, wy) {
    const x = Math.round(wx / SNAP) * SNAP;
    const y = Math.round(wy / SNAP) * SNAP;
    const ent = this.place(d, x, y);
    if (ent) this.afterDrop();
    return ent;
  }

  /** 放手之后：按用户偏好决定要不要收起窄屏抽屉（默认 B = 不收起） */
  afterDrop() {
    if (readDropCollapse()) this.collapseDrawer();
  }

  /**
   * 收起器材栏抽屉（窄屏浮层）。**不直接摘 `data-open`**：
   * 抽屉的开合状态活在 src/ui/touch.js 的 installDrawers() 闭包里（`let open`），
   * 从外面摘属性会让它的 `open` 与 DOM 脱节 —— 下一次按抽屉按钮会先「关一次
   * 已经关掉的抽屉」，用户看到的是**按钮点一下没反应**（正是本仓最忌讳的
   * 「看得见但点不中」的同类）。所以只走它自己的开合入口（#btnPalette 的 click），
   * 且**只在确实开着时**点，这样它内部的 toggle 必然落在 close 分支上。
   */
  collapseDrawer() {
    if (typeof document === 'undefined') return false;
    const pal = document.querySelector ? document.querySelector('#palette') : null;
    const btn = document.getElementById ? document.getElementById('btnPalette') : null;
    if (!pal || !btn || !btn.click) return false;
    if (!pal.hasAttribute || !pal.hasAttribute('data-open')) return false;   // 本来就没开
    btn.click();
    return true;
  }

  // ── 拖动过程中的视觉反馈 ──────────────────────────────
  // 「正在拖的是哪件器材」由 ghost 表示（图标 + 名称，复用 .pitem 的既有观感）；
  // 「会落到哪里」由 halo 表示（跟着指针的落点环，落到画布上时变实）。
  //
  // ⚠ 这里**刻意不画世界空间的落点标记**：world → screen 的换算需要引擎提供
  //   反向出口，而引擎现在只有 screenToWorld（src/core/engine.js）。自己写一条
  //   `world * zoom + pan` 就又多了一个「看得见但点不中」的机会 —— 而 task-12
  //   正在给引擎加 zoom，那条式子明天就会错。指针就在用户手指底下，
  //   屏幕空间的反馈已经是真话；等引擎有了反向出口再补精确标记。

  makeGhost(st) {
    if (typeof document === 'undefined') return;
    const g = document.createElement('div');
    g.className = 'pal-ghost';
    const ico = document.createElement('span');
    ico.className = 'pi-ico';
    ico.textContent = st.d.icon || '';
    const txt = document.createElement('span');
    txt.className = 'pi-txt';
    txt.textContent = st.d.name || '';
    g.appendChild(ico); g.appendChild(txt);

    const h = document.createElement('div');
    h.className = 'pal-halo';

    (document.body || this.el).appendChild(g);
    (document.body || this.el).appendChild(h);
    this.ghost = g; this.halo = h;
    this.moveGhost({ clientX: st.x, clientY: st.y });
  }

  moveGhost(ev) {
    const g = this.ghost, h = this.halo;
    if (!g) return;
    const x = ev.clientX, y = ev.clientY;
    if (g.style) { g.style.left = x + 'px'; g.style.top = y + 'px'; }
    if (h && h.style) { h.style.left = x + 'px'; h.style.top = y + 'px'; }
    if (h && h.classList) h.classList.toggle('on', this.dropTargetOK(x, y));
  }

  /**
   * 松手点是不是一个**有效落点**：在画布上、且**不被器材栏自己盖住**。
   * 落点环的实/虚（moveGhost）与真正投放（dropWorld）**共用这一条判据** ——
   * 两处各写一份必然漂移，而漂移的表现就是「环是实的，落下去却什么都没有」。
   * 纯屏幕矩形判定，不涉及世界坐标。
   *
   * ⚠ 为什么要单独判「有没有被器材栏盖住」：画布矩形**包含**被器材栏覆盖的那一块。
   *   窄屏抽屉模式下器材栏是 `position:fixed; width:320`，390px 的机器上盖掉约八成宽；
   *   从器材行上长按后**不往右拖就松手**，松手点仍在抽屉矩形内，而画布矩形判定会通过
   *   ⇒ 器材落到抽屉背后，用户什么都看不见（默认 B 又不收抽屉，等于彻底没反应）。
   *   静默落到看不见的地方与「静默挪位」是同一族问题：**看不见的落点等于没有落点**。
   *   ⇒ 视同取消，与桌面档「拖回器材栏 = 取消」同一个语义，全屏与窄屏也一致。
   * 桌面档（宽屏）器材栏与画布**并排**、不重叠 ⇒ 这条在宽屏上恒不触发，行为与改前一致。
   */
  dropTargetOK(cx, cy) {
    const cv = this.app.canvas;
    if (!cv || !cv.getBoundingClientRect) return false;
    const r = cv.getBoundingClientRect();
    if (!(cx >= r.left && cy >= r.top && cx <= r.left + r.width && cy <= r.top + r.height)) return false;
    return !this.overPalette(cx, cy);
  }

  /** 松手点是否落在器材栏自己的矩形里（拿不到矩形就返回 false —— 退化成改前的行为） */
  overPalette(cx, cy) {
    if (typeof document === 'undefined' || !document.querySelector) return false;
    const pal = document.querySelector('#palette');
    if (!pal || !pal.getBoundingClientRect) return false;
    const r = pal.getBoundingClientRect();
    if (!r || !r.width || !r.height) return false;
    return cx >= r.left && cy >= r.top && cx <= r.left + r.width && cy <= r.top + r.height;
  }

  /** 收干净：清计时器、释放指针、摘掉幽灵与环、去掉行上的拖拽类。幂等。 */
  endDrag() {
    const st = this.drag;
    this.drag = null;
    if (!st) return;
    if (st.timer) { clearTimeout(st.timer); st.timer = 0; }
    if (st.row.classList) st.row.classList.remove('dragging');
    try { if (st.row.releasePointerCapture && st.armed) st.row.releasePointerCapture(st.id); } catch (e) { /* 同上 */ }
    if (this.ghost) { this.ghost.remove(); this.ghost = null; }
    if (this.halo) { this.halo.remove(); this.halo = null; }
  }

  /** 复用行只改内容：图标、名称、说明、域类名、包标记、aria 与提示全都跟着数据走 */
  paintRow(row, d) {
    const cls = 'pitem ' + (DOMAIN_CLASS[d.domain] || '');
    if (row.className !== cls) row.className = cls;
    if (d.pack) setAttr(row, 'data-pack', '1');
    else if (row.hasAttribute('data-pack')) row.removeAttribute('data-pack');
    setAttr(row, 'aria-label', `添加器材：${d.name}`);
    setAttr(row, 'title', (d.desc || d.name)
      + (d.pack ? `\n来自器材包：${d.packName || d.pack}` : '')
      + (d.tags ? '\n标签：' + d.tags.join(' / ') : ''));
    setText(row.firstElementChild, d.icon);
    const txt = row.lastElementChild;
    setText(txt.firstElementChild, d.name);
    setText(txt.lastElementChild, d.desc || '');
  }
}
