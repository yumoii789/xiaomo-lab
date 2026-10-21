// ══════════════════════════════════════════════════════════
// UI · 交互
//   选择：拖动器材、点接线柱
//   连线：点两个接线柱
//   倾倒：点源容器 → 点目标容器（试剂瓶等「自带一份物质」的器材也能倒 —— 判据是能力，不是命名）
//   删除：点器材
//   **视口**：平移 = 拖动空白处（**鼠标类指针**）/ 中键拖动 / **两指拖动**；
//     缩放 = **两指捏合** + **鼠标滚轮（围绕光标位置）**，上下限 0.25×–4×（engine.ZOOM_MIN/MAX）。
//     一律是画布**内容**缩放（像地图：器材/连线/网格一起变，三个侧栏不动），不是整页缩放。
//     双击空白处复位**整个视图**（pan + zoom，用户当面裁决；见 armPan）。**空格不参与**——它是运行/暂停。
//     ⚠ **单指永远不平移、永远不缩放**：手指按在器材上就是移动器材、按在空白处就是
//       取消选中（用户当面拍板，一个字都不许变）。两指见 beginGesture。
//
// ⚠ **坐标纪律（视口功能的地基）**：`pos(ev)` 给的是**屏幕坐标**（相对画布左上角），
//   而命中检测 / 接线柱 / 吸附 / 叠层绘制全都吃**世界坐标**。这两者之间差一整个视口
//   （`engine.pan` 与 `engine.zoom`：**世界 = (屏幕 − pan) / zoom**），所以每次要拿
//   世界坐标都必须走 `engine.screenToWorld(x, y)`。
//   一个地方自己写 `(p.x - pan.x) / zoom` 就等于多一次「看得见但点不中」的机会。
//   已经过账的「把指针坐标当世界坐标用」的落点（tools/pan-probe.mjs §③ 钉住）：
//     `onDown` 里 `select` / `wire` / `pour` / `erase` 四条工具分支的 `pickPort` 与 `pick`；
//     `onMove` 里的接线柱高亮与器材悬停；叠层 `drawOverlay` 的鼠标端。
//   ⚠ **这里只写符号名、不写行号**：行号是「会过期的坐标」——写下 158 的那一刻它对，
//   下一次插二十行就全漂了；符号名是不会过期的地址。
//   `d.sx/sy`（拖动起步阈值）、`this.mouse`（pointermove 悬停）、doubleTap 的位移判定
//   一律留在屏幕空间：它们比的是「手指在屏幕上走了多远」，减掉 pan 反而错。
//   涟漪/拖尾（src/plugins/ui.interaction.js）**不需要任何改动**：它们把坐标写进
//   `.stage-fx` 子元素的 left/top，那是舞台盒坐标 = 指针所在的 DOM 坐标系，与画布内容
//   是否平移无关（实测 pan=0 与 pan=(100,60) 下涟漪中心都精确落在指针 client 点上）。
//
// 输入一律走 Pointer Events（pointerdown/move/up/cancel），不再混用
// mousedown/mousemove：触屏上鼠标事件是浏览器在 tap 之后补发的合成事件，
// 位置与时机都滞后一帧以上，拖动会「粘手」而且先滚页面。指针事件把鼠标、
// 手指、触控笔收敛成同一条通路，还能用 setPointerCapture 保证拖动中
// 指针移出画布也不丢事件（老实现靠 window 上的 mouseup 兜底，触屏下不可靠）。
// ══════════════════════════════════════════════════════════

import { C } from '../core/theme.js';
import { canFeed } from '../equipment/lab.js';
import { installReadout } from './readout.js';

const HIT_PORT = 13;
/**
 * 触屏（粗指针）的接线柱命中半径。用户原话：「端口不好看见、不好对准」—— 手指接触面
 * 约 8~10 mm，`HIT_PORT` 那 13 个世界 px 在真机上就是「看得见、点不中」。
 *
 * ⚠ 细指针那 13 px **一个字都不许动**：桌面鼠标的手感与今天逐位相同
 *   （`tools/port-affordance-probe.mjs` 直接钉住「d=13 命中、d=13.0001 不命中」）。
 * 取 26（2×）而不是随便一个大数：26 仍小于常见两个接线柱的间距，不会互相抢；
 *   再放大就变成「点一个中了旁边那个」，那是把「不准」换成另一种「不准」。
 * ⚠ 它与 `PORT_SNAP_COARSE` 是**两个不同的半径**，故意分开写死，分工见那边的注释。
 */
const HIT_PORT_COARSE = 26;
/**
 * 触屏的**吸附**半径（世界 px）：手指落在接线柱附近就吸到它。
 *
 * 为什么光放大命中半径不够：命中半径只回答「这一下算不算点到端口」，而用户抱怨的是
 * 「不好对准」—— 差几个 px 落空时，连线会画到器材旁边的空气里，手指还得再来一次。
 * 吸附把「差不多对准了」变成「就是它」，这才是触屏上真正省事的那一步。
 *
 * 边界（与 `HIT_PORT_COARSE` 一起定死，探针两侧对照）：`d ≤ PORT_SNAP_COARSE` 吸附；
 * `d > PORT_SNAP_COARSE` 就是自由连线（不吸、不猜）。30 > 26 是**有意的**：
 * 先按 26 问「算不算点到」，没答上才按 30 问「手指想落哪一个」，次序见 `wirePortAt`。
 * 只在粗指针启用 —— 鼠标档位下 `snapPortAt()` 直接返回 null，桌面行为与今天逐位相同。
 */
const PORT_SNAP_COARSE = 30;
/** 鼠标的拖动起步阈值（px）：位移不超过它就仍算单击，不写回坐标（B4） */
const DRAG_SLOP = 3;
/** 手指/触控笔的起步阈值：手指按下的抖动远大于鼠标，3px 会把轻点误判成拖拽 */
const DRAG_SLOP_TOUCH = 10;
/**
 * 「按下—抬起」净位移不超过它就**仍算单击**（屏幕 px）。
 *
 * ⚠ 为什么光有 `DRAG_SLOP` 不够（2026-10-17，用户反馈"交互太生硬"；两个独立勘察都指向这里）：
 * `onMove` 一旦越过 `DRAG_SLOP` 就把 `d.moved = true` **永久置真**，松手时不再派发
 * `onEntityClicked`。于是「**想点开关、手却抖了 4px**」的结果是：
 * **开关没切换，而物品被吸附着动了一下** —— 用户看到"它动了，但没反应"。
 * 鼠标阈值只有 3px，这在真实操作里太容易发生。
 *
 * ⇒ 松手时用**净位移**再判一次：净位移 ≤ 本值时，把器材**放回按下时的位置**
 * （等价于"真的没动过"，也不留 4px 漂移）**并派发单击**。
 * 这比"调大 DRAG_SLOP"好：调大会让**真正想拖动**时起步发木，而净位移判据只影响
 * "几乎没动"的那一档，两边都不牺牲。
 *
 * 取 6px：大于鼠标 DRAG_SLOP(3) 以容纳越过阈值后的小幅回手，又远小于任何有意的位移。
 */
const CLICK_SLOP = 6;
/** 释放时的网格吸附（px） */
const SNAP = 4;
/**
 * 松手吸附的过渡时长（ms）。为什么需要它（2026-10-17，用户反馈"交互太生硬"）：
 *
 * 原来松手是**直接赋值** `ent.x = Math.round(ent.x/SNAP)*SNAP` —— 物品在松手那一帧
 * **瞬移 0~2.8px**。位移本身很小，但发生在"刚放下、眼睛正盯着它"的那一刻，
 * **跳变比位移更显眼**：手感上是"啪"地弹一下，而不是"轻轻落进格子"。
 *
 * ⇒ 改成一段**短促的 ease-out 过渡**（不改变最终落点，只改变到达方式）。
 *   网格相位、`onEntityMoved` 的时机（只在落定时调一次）都与原来一致，见 `settleTo()`。
 *   `0` = 关掉过渡、回到旧的瞬时吸附。
 */
const SETTLE_MS = 130;
/** 双击复位视口的判定：两次点按的**抬起**间隔上限（ms）与最大位移（px）。
 *  位移按屏幕像素算，和平移量无关 —— 说的是「手指几乎没动」。 */
const DOUBLE_TAP_MS = 350;
const DOUBLE_TAP_SLOP = 8;

/** 指针精度能力查询。只用来决定「起步阈值」和「要不要维护 hover」，不用于功能开关。 */
function coarsePointer() {
  return typeof window !== 'undefined' && !!window.matchMedia
    && window.matchMedia('(pointer: coarse)').matches;
}

export class Interaction {
  constructor(app) {
    this.app = app;
    this.canvas = app.canvas;
    this.tool = 'select';

    this.drag = null;        // { ent, dx, dy, sx, sy, slop, moved }
    this.settle = null;      // 吸附落位过渡（见 settleTo）；null = 没有进行中的过渡
    this._settleRaf = 0;
    this.wireFrom = null;    // { ent, port }
    this.pourFrom = null;    // 器材
    this.mouse = { x: 0, y: 0 };
    this.down = null;
    /** 画布平移进行中：{ sx, sy, px, py } —— 起点与起手时的 pan 都是**屏幕像素** */
    this.pan = null;
    /** 上一次「单击空白处」的抬起：{ at, x, y }；双击空白处 = 视口复位 */
    this.doubleTap = null;

    /** 正在被追踪的指针 id —— **单指路径**只认第一根按下的手指 */
    this.pid = null;
    /**
     * 多指同时按下（恒等于 `ptrs.size >= 2`）。它的语义分两种：
     *   · **没有** `this.gesture` 时 = 本轮单指手势作废的封锁（第二根手指落下时打的）；
     *   · **有** `this.gesture` 时 = 视口由两指接管（中点 → 平移、间距 → 缩放）。
     */
    this.multi = false;
    /**
     * 活着的指针位置表：pointerId → { x, y }（**屏幕坐标**）。
     * 单指路径不读它；两指手势靠它取「两根手指各自当前在哪」——
     * `this.mouse` 只记被追踪的那一根，第二根手指落下时不够用。
     * 每根指针在 down/move/up/cancel 上各自进出；手势收尾时**不清空**（手指还按着）。
     */
    this.ptrs = new Map();
    /**
     * 两指手势：`{ ids:[a,b], mid, dist, w0, zoom0 }`，null = 没有手势。
     * `w0` 是起手时**两指中点下的世界点** —— 手势全过程把它钉在当前中点下方，
     * 这一条式子同时给出捏合缩放与两指平移（见 updateGesture）。
     */
    this.gesture = null;

    // 引擎比本交互层先创建，但引擎要读 app._dirty（B1 的脏检查约定）与
    // app.coupling（B6 的耦合流动线索），这里把 app 引用补给它。
    if (app.engine) app.engine.app = app;

    // 画布是拖拽面：浏览器不许在这个元素上滚页面或做双指缩放，否则拖动器材时
    // 页面会跟着跑。所有权声明在真正拥有手势的模块里（这里），而不是散在样式表里。
    // 无条件设 none，不按指针能力分支：touch-action 只约束**触摸**输入，
    // 对鼠标和滚轮完全惰性 —— 桌面用户既不会因此失去什么，触屏笔记本
    // （主指针是触控板、pointer:fine 为真）也不会漏掉这条。
    this.canvas.style.touchAction = 'none';

    // 逐件就地读数（task-26 项②）+ 锁定开关（项①）的就地层。挂在这里而不是 `src/main.js`：
    // 主入口是别的写者的文件（一键组装正在改它），而本层与交互层同生共死。
    // ⚠ 它**不进 `ALL_PLUGINS`**：UI 插件数被 tools/guard-plugins.mjs 冻结在 32，
    //   这一层是纯视图叠层、没有插件生命周期。
    /** @type {import('./readout.js').Readout|null} */
    this.readout = installReadout(app);

    this.bind();
  }

  /** 画面需要重绘。
   *  app.markDirty 由 §2-C2 在 main.js 里定义；它还没落地时用引擎自己的
   *  脏标记兜底，两者都没有就静默跳过 —— 绝不再抛 TypeError（B5）。
   *  ⚠ 不单独惊动引擎的 markDirty：engine.frame() 已经会读 app._dirty，
   *    两个都调只是把同一帧标脏两次，且会让「平移量为 0 时零影响」的
   *    调用序列断言多出一堆噪声（world.xiaomo 未定义时更是纯噪声）。 */
  markDirty() {
    if (this.app.markDirty) this.app.markDirty();
  }

  /**
   * 把器材中心限制在**可见区**内（B4：拖到边缘不再静默丢失跟随）。
   *
   * ⚠ 可见区必须按**世界**坐标算 —— `engine.w/h` 是**屏幕**尺寸，拿它当世界边界是
   *   「屏幕量 vs 世界量」这条病灶的**第二处**（第一处是拖动的 `p.x + d.dx`，见文件上方
   *   `onMove` 里的注释与 tools/gesture-probe.mjs §⑪）。恒等视口下两种写法数值相同，
   *   所以它一直没被测出来；一旦动过视口：
   *     · zoom=0.25 ⇒ 可见世界宽是屏幕宽的 4 倍，上界却钉在屏幕宽 ⇒ **屏幕右侧 76% 拖不进去**
   *       （用户真机「放不到想放的位置」的另一条路径）；
   *     · zoom=4   ⇒ 可见世界宽只有屏幕宽的 1/4，上界仍是屏幕宽 ⇒ **能拖到屏幕外 2.8 个屏宽**；
   *     · pan≠0   ⇒ 旧式的框钉死在原点，不跟着视口走。
   *
   * 恒等视口（pan=0、zoom=1）下 `screenToWorld(0,0)=(0,0)`、`screenToWorld(w,h)=(w,h)`，
   * 与旧式**逐位相同** —— 这一条由 §⑫ 用 `Object.is` 对拍钉住，不是嘴上说说。
   */
  clampXY(x, y, ent) {
    const eng = this.app.engine;
    if (!eng || !eng.screenToWorld) return { x, y };
    // 可见区在**世界**坐标里的矩形（唯一换算出口，不自己写 (0−pan)/zoom）
    const v0 = eng.screenToWorld(0, 0);
    const v1 = eng.screenToWorld(eng.w, eng.h);
    const W = v1.x - v0.x, H = v1.y - v0.y;
    if (!W || !H) return { x, y };
    const hw = Math.min(ent.w / 2, W / 2);
    const hh = Math.min(ent.h / 2, H / 2);
    return {
      x: Math.max(v0.x + hw, Math.min(v1.x - hw, x)),
      y: Math.max(v0.y + hh, Math.min(v1.y - hh, y)),
    };
  }


  /** 指针位置，**屏幕坐标**（相对画布左上角）。世界坐标一律走 toWorld()。 */
  pos(ev) {
    const r = this.canvas.getBoundingClientRect();
    return { x: ev.clientX - r.left, y: ev.clientY - r.top };
  }

  /** 屏幕坐标 → 世界坐标。**只经由 engine.screenToWorld**（唯一换算出口）。 */
  toWorld(p) {
    const eng = this.app.engine;
    if (eng && eng.screenToWorld) return eng.screenToWorld(p.x, p.y);
    return { x: p.x, y: p.y };   // 引擎还没挂上时的兜底：视口偏移视为 0
  }

  /** 世界坐标下的指针位置 —— 叠层（连线预览）画在世界空间，必须减 pan */
  worldMouse() { return this.toWorld(this.mouse); }

  /**
   * 指针档位 → 接线柱命中半径。**唯一的档位出口**（`engine.drawPorts` 的视觉档位
   * 读同一条媒体查询，见那边的 `COARSE_MQ`）。
   */
  portTol() { return coarsePointer() ? HIT_PORT_COARSE : HIT_PORT; }

  /**
   * 命中接线柱的**唯一判据**：`onDown` 的两条分支（点选 / 起线）与 `onMove` 的高亮
   * 全走这里。口径仍是 `world.pickPort` 的**顶层优先** —— 点选必须尊重叠放次序，
   * 否则上层器材的端口会被压在下面的器材抢走。
   *
   * ⚠ 不许在别处再写一份 `world.pickPort(...)`：两份判据必然漂移。
   *   `tools/port-affordance-probe.mjs` 直接数本文件里 `world.pickPort(` 的出现次数 == 1。
   */
  pickPortAt(w) { return this.app.world.pickPort(w.x, w.y, this.portTol()); }

  /**
   * 吸附：粗指针下把手指落点吸到**半径内最近**的那个接线柱；超出半径返回 null（自由连线）。
   *
   * ⚠ 与 `pickPortAt` 的分工与**重叠次序**（只允许一个答案，由 `wirePortAt` 一处实现）：
   *   1) 先按命中半径问 `pickPortAt`（顶层优先）—— 它答了就用它，与桌面是同一条判据；
   *   2) 它没答，才按吸附半径取**几何最近**的那个 —— 这一步才是「不好对准」的正解。
   * ⚠ `kind !== 'wire'` 的端口（各容器的「插入口」，只读）不参与电路吸附：语义不同，
   *   把只读口吸成导线端点，用户会以为插上了一个电插头。
   */
  snapPortAt(w) {
    if (!coarsePointer()) return null;          // 鼠标档位：不吸附，桌面行为逐位不变
    const world = this.app.world;
    const r2 = PORT_SNAP_COARSE * PORT_SNAP_COARSE;
    let best = null, bd = Infinity;
    for (let ei = world.entities.length - 1; ei >= 0; ei--) {
      const e = world.entities[ei];
      for (let i = 0; i < e.ports.length; i++) {
        if (e.ports[i].kind !== 'wire') continue;
        const at = e.portWorldAt(i);
        const d = (at.x - w.x) ** 2 + (at.y - w.y) ** 2;
        // `d < bd`（严格更近才换人）：完全平局时留在先遍历到的那个 ⇒ 与 pickPort 同向（上层优先）
        if (d <= r2 && d < bd) { bd = d; best = { ent: e, port: i, x: at.x, y: at.y }; }
      }
    }
    return best;
  }

  /** 连线落点：**先精确命中、再吸附**。次序只有这一处，别处不许再写一份 */
  wirePortAt(w) { return this.pickPortAt(w) || this.snapPortAt(w); }

  bind() {
    const cv = this.canvas;
    cv.addEventListener('pointerdown', (e) => this.onDown(e));
    cv.addEventListener('pointermove', (e) => this.onMove(e));
    cv.addEventListener('pointerup', (e) => this.onUp(e));
    // 指针被系统夺走（通知栏下拉、来电、浏览器接管手势）时必须走和 pointerup
    // 一样的收尾，否则 drag/wireFrom 会永远挂在那里，下一次点按变成「接着上一次拖」。
    cv.addEventListener('pointercancel', (e) => this.onCancel(e));
    // 指针捕获被夺走（系统手势、元素被移走、抽屉抢指针）⇒ 也该收尾。
    // ⚠ 监听挂在**画布**上而不是 window 上：本模块不往 window 挂任何监听，
    //   tools/pan-probe.mjs §⑥ 把这条钉住了（keydown/keyup/blur 计数必须为 0），
    //   别为了「窗口失焦」把它破掉 —— pointercancel/lostpointercapture 已覆盖那条路。
    cv.addEventListener('lostpointercapture', (e) => this.onLostCapture(e));
    // 触屏没有右键，contextmenu 只可能是长按菜单（或者鼠标右键）—— 一律挡掉。
    cv.addEventListener('contextmenu', (e) => { e.preventDefault(); this.cancel(); });
    // 桌面端缩放（鼠标滚轮 / 触控板捏合）。⚠ `{ passive: false }` **不能省** —— 不带它，
    //   `preventDefault()` 会被浏览器静默忽略：画布缩了、页面也跟着滚，而代码上完全看不出来。
    //   tools/gesture-probe.mjs §⑩ 把第三参也钉住了（这是本仓第二次遇到同类静默失效）。
    cv.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });

    // ⚠ 这里**故意不接管空格键**。空格在本产品里是「运行/暂停」（main.js 的全局快捷键），
    //   那是做实验时的高频操作；再让它兼任平移修饰键，就等于把「按住空格再拖」变成一个
    //   需要教学的手势，而且每拖一次都会顺带切一次运行态。平移只保留空白处拖动与中键拖动。
  }

  /**
   * 桌面端缩放：滚轮 = **围绕光标位置**缩放（放大/缩小都围绕指针下的那个世界点）。
   * 一行复用 `engine.zoomAt()` —— 它就是「地图式缩放」那条式子（`pan = s − zoom·w(s)`）。
   * ⚠ **不许在这里另写一份围绕点缩放的数学**：那正是「换算与绘制不一致」的入口，
   *   也是本轮把两指手势整段交给 engine 的原因。上下限与夹取同样不在这里重复一份数字。
   *
   * 决策记录（Lead 裁定，2026-xx）：裸 wheel 落在**画布**上就是缩放，不改 Figma 式（裸滚轮滚页面、
   * 只有 ctrl+wheel 缩放）。理由不是「像地图」，而是**这个应用没有页面滚动可让**：固定布局、
   * #app 撑满视口，裸滚轮落在画布上唯一合理的响应就是缩放；而调色板/属性栏/日志栏各有自己的
   * 滚动，且本监听只挂在 canvas 上 ⇒ 那些列表的滚动一点不受影响（gesture-probe §⑩ 有断言：
   * 滚轮不产生任何拖动/连线/手势状态）。
   *
   * 三件都不能省：
   *   1. `{ passive: false }`（见 bind）：不带它 `preventDefault()` 会被静默忽略；
   *   2. **只有真的缩放成功才** `preventDefault()`：到 0.25×/4× 之后要把滚轮还给页面，
   *      否则用户会以为页面卡死（`engine.zoomAt` 的返回值就是为这件事准备的）；
   *   3. `ctrlKey` 例外：触控板捏合会被浏览器报成 ctrl+wheel，而浏览器会拿它去缩**整页**，
   *      所以 ctrl+wheel 一律拦下来（哪怕已经到限），这个手势由画布自己消化。
   *
   * `deltaMode` 1=行 / 2=页，单位不是像素；不归一化就会「滚一格跳一大截」。
   */
  onWheel(ev) {
    const eng = this.app && this.app.engine;
    if (!eng || typeof eng.zoomAt !== 'function') return;      // 引擎没挂上 ⇒ 不抢滚轮
    const unit = ev.deltaMode === 1 ? 16 : ev.deltaMode === 2 ? 100 : 1;
    const d = (ev.deltaY || 0) * unit;
    if (!d) return;
    // 触控板捏合（ctrl+wheel）的 delta 比滚轮小一个量级，所以用更大的系数
    const k = ev.ctrlKey ? 0.005 : 0.0015;
    const f = Math.exp(-d * k);
    if (!isFinite(f) || f <= 0 || f === 1) return;
    const p = this.pos(ev);
    // ⚠ `zoomAt(z, sx, sy)` 收的是**目标 zoom**（绝对倍率），不是增量倍率 —— 它内部
    //   负责夹取并围绕 (sx,sy) 重算 pan。第一版把 f 当目标传进去，结果「向前滚 = 缩小」。
    //   zoomAt 自己会 markDirty（`engine.setViewAt` 是纯设置、由调用方判断要不要置脏）
    const changed = eng.zoomAt(eng.zoom * f, p.x, p.y);
    if (changed || ev.ctrlKey) ev.preventDefault();
  }

  setTool(t) {
    this.cancel();
    this.tool = t;
    this.canvas.style.cursor = t === 'select' ? 'default' : 'crosshair';
    this.app.setStatusTool(t);
  }

  cancel() {
    const had = !!(this.wireFrom || this.pourFrom || this.drag || this.pan || this.gesture ||
      this.app.engine.hotPort || this.app.highlight);
    // ⚠ 落位过渡也必须取消，而且必须 `land:false` —— **停在当前位置，不补跑到旧目标**。
    //   漏了这一句的后果（2026-10-17 由 tools/pan-probe.mjs §⑨ 抓到）：过渡会**不受打断地
    //   继续跑完**，于是"放下后马上又按下去"会被它带着滑到旧目标 —— 用户看到的是
    //   「**它自己动了**」。这正是 `settleTo()` 不变量 3 要防的那件事。
    this.cancelSettle({ land: false });
    this.wireFrom = null;
    this.pourFrom = null;
    this.drag = null;
    this.pan = null;             // 平移手势也必须收尾，否则下一次按下会接着上一次拖
    this.gesture = null;         // 两指手势同理（换工具 / 右键 / 点空白一律作废）
    // ⚠ `cancel()` **不动 `this.ptrs`**（手指还按在屏幕上，位置表要继续维护），
    //   也**不动 `engine.pan/zoom`**：作废的是「这一轮手势」，不是用户已经调好的视口。
    //   两指手势自己也会调 `cancel()`（清理单指那半截），必须遵守同一条（见 beginGesture）。
    this.app.engine.hotPort = null;
    this.app.highlight = null;
    if (had) this.markDirty();
  }

  /** 本轮手势的收尾：清追踪状态（多指作废标记留到最后一根手指抬起） */
  releaseCapture(ev) {
    const cv = this.canvas;
    if (cv.hasPointerCapture && cv.hasPointerCapture(ev.pointerId)) {
      try { cv.releasePointerCapture(ev.pointerId); } catch { /* 指针已经消失，忽略 */ }
    }
    if (ev.pointerId === this.pid) this.pid = null;
  }


  // ══════════ 按下 ══════════
  onDown(ev) {
    // 主键以外只放行**中键**：右键、以及 macOS 上按下 Ctrl 的左键点击
    // （click 是左键、但按键语义是右键）仍被挡在外面。
    // 中键在本画布上原本没有任何语义（只有浏览器自带的「中键自动滚屏」），
    // 把它收编成平移不会顶掉谁；顺带 preventDefault 掉那次自动滚屏。
    if (ev.button === 1) ev.preventDefault();
    else if (ev.button !== 0) return;

    const p = this.pos(ev);
    this.ptrs.set(ev.pointerId, p);

    // ① 已经有别的指针按着 ⇒ 这一根把它变成**两指手势**。
    //    判据不是「`this.pid` 已经存在」而是「`ptrs` 里还有别的指针」：上一轮手势
    //    收尾后剩下的那根手指仍留在 `ptrs` 里（见 endGesture），它再遇上一根新手指
    //    也必须进手势，而不是被当成一次新的单指拖动。
    const others = [...this.ptrs.keys()].filter((id) => id !== ev.pointerId);
    if (others.length > 0) { this.beginGesture(ev, others[others.length - 1]); return; }
    this.pid = ev.pointerId;
    // ⚠ 任何一次新的按下都必须先**停住正在进行的落位过渡**，且停在当前位置（`land:false`）。
    //   不能只在 `cancel()` 里做 —— `cancel()` 只覆盖「点空白处 / 换工具 / 右键」这几条路，
    //   而**按在器材上**走的是下面的"选中 + 开始拖动"分支，那条路**不会**调 `cancel()`。
    //   漏了这里（2026-10-17 由 tools/pan-probe.mjs §⑨ 抓到）：放下后马上又按住同一件器材，
    //   过渡会**不受打断地继续跑完**，把它从手指底下滑到旧网格点 —— 用户看到「**它自己动了**」。
    this.cancelSettle({ land: false });

    // 指针捕获：拖动中指针离开画布（拖到侧栏上方）也照样收到 move/up。
    if (this.canvas.setPointerCapture) {
      try { this.canvas.setPointerCapture(ev.pointerId); } catch { /* 指针已失效，退回逐元素派发 */ }
    }

    this.mouse = p;
    const world = this.app.world;
    const w = this.toWorld(p);          // 命中检测一律吃世界坐标

    // ② 中键拖动 —— 与工具、与指针下有什么都无关，优先放行。
    //    ⚠ 这里**没有**空格：空格归 main.js 的「运行/暂停」，不做平移修饰键。
    if (ev.button === 1) { this.startPan(p); return; }

    if (this.tool === 'select') {
      // 1) 先看接线柱（方便接线/拖动）
      const port = this.pickPortAt(w);
      if (port && ev.shiftKey) { this.startWire(port); return; }

      // 2) 选中器材并开始拖动
      //
      // ⚠ ④-7（2026-10-17）**重复点击穿透**：`world.pick()` 只返回最上层一件，
      //   两件叠在一起时被压住的那件**再也点不到**（除非先把上层拖走）。
      //   而画布内拖动没有任何"禁止重叠"的规定 —— `freeSpot()` 的避让只管
      //   **从器材栏投放**那条路。用户常常想（也需要）把东西放近一些。
      //
      //   ⇒ 解法不是禁止重叠，而是**让被压住的够得着**：
      //     取该点的**全部**命中，按 `pick()` 的口径**重排成"后添加的在前"**，
      //     若**已选中的那件也在列表里**，说明用户是在同一处重复点击 ⇒ 选**下一层**
      //     （到末尾就回第一层）。**第一下的行为完全不变**
      //     （`selected` 不在列表里 ⇒ 仍选最上层）。
      //
      //   ⚠ `world.pickAll()` 是**别人已有的 API**（`entities.filter(hitTest)`，
      //     注释写"容器扣在别的器材上时会用到"），它的顺序是**从下到上**、与 `pick()`
      //     相反，而且已被别处消费 ⇒ **不能改它的顺序**，只能在这里自己重排。
      //     （2026-10-17 踩过：我先在 world.js 里加了个同名方法想改顺序，
      //       结果与既有定义**重名覆盖**，`pickAll` 实际返回的仍是旧顺序。）
      const all = world.pickAll(w.x, w.y);
      const hits = all.slice().sort((a, b) => world.entities.indexOf(b) - world.entities.indexOf(a));
      let ent = hits[0] || null;
      if (hits.length > 1 && this.app.selected) {
        const at = hits.indexOf(this.app.selected);
        if (at >= 0) ent = hits[(at + 1) % hits.length];
      }
      if (ent) {
        this.app.select(ent);
        // ⚠ **锁定的器材：能选中、不能拖**（task-26 项①）。判定写在这里、`this.drag = {` 之前 ——
        //   这是全项目唯一把用户手势变成 `ent` 位移的地方，在这里拦下才叫「拖不动」；
        //   写成「拖完再夹回原位」终值逐位一样，但器材会跟着手指抖一下、撤销栈还会多一条 move
        //   （`tools/lock-readout-probe.mjs` §① 同时钉数值与这个**次序**，M2 变异体专杀事后夹回）。
        //   `markDirty()` 不能省：选中框变了，与下面空白处分支同一处副作用（少它＝选中框不重绘）。
        if (ent.locked) { this.markDirty(); return; }
        // ⚠ dx/dy 用世界坐标算（ent.x 是世界坐标），sx/sy 用屏幕坐标算（起步阈值比的是
        //    手指在屏幕上走了多远）—— 两者在这一处**必然**取不同的点，不是笔误。
        this.drag = {
          ent, dx: ent.x - w.x, dy: ent.y - w.y, sx: p.x, sy: p.y,
          slop: ev.pointerType === 'mouse' ? DRAG_SLOP : DRAG_SLOP_TOUCH,
          moved: false,
          // 按下时的**整数**位置：净位移判为"几乎没动"时要放回这里（见 CLICK_SLOP）。
          ox: ent.x, oy: ent.y,
        };
      } else {
        this.app.select(null);
        // ② 空白处按住左键拖动 = 平移。真正的平移在 onMove 越过阈值后才发生，
        //    所以「点空白处取消选中」这条既有语义原封不动（见 armPan）。
        //    ⚠ 触屏走不到这里**不是 YAGNI 残留，是产品决策**：单指在触屏上等于
        //      滚动 / 拖器材，平移归两指（见 beginGesture 与 armPan 的注释）。
        if (ev.pointerType !== 'touch') this.armPan(p);
      }
      this.markDirty();       // 选中框变了
      return;
    }

    if (this.tool === 'wire') {
      const port = this.wirePortAt(w);
      if (!port) { this.app.toast('请点击器材上的接线柱（小圆点）', 'warn'); return; }
      this.startWire(port);
      return;
    }

    if (this.tool === 'pour') {
      const ent = world.pick(w.x, w.y);
      if (!ent) { this.app.toast('请点击要倒出的容器或试剂瓶', 'warn'); return; }
      if (!this.pourFrom) {
        if (!ent.vessel && !canFeed(ent)) {
          this.app.toast('这个器材里没有东西可以倒', 'warn'); return;
        }
        this.pourFrom = ent;
        this.app.highlight = ent;
        this.app.toast('再点击目标容器');
        this.markDirty();     // 倾倒源高亮框
      } else {
        this.app.doPour(this.pourFrom, ent);
        this.cancel();
      }
      return;
    }

    if (this.tool === 'erase') {
      const ent = world.pick(w.x, w.y);
      if (ent) this.app.removeEntity(ent);
      return;
    }
  }

  /** 记下平移起手点。此时**不改 pan** —— 越过阈值前不该有任何画面变化。 */
  startPan(p) {
    this.pan = { sx: p.x, sy: p.y, px: this.app.engine.pan.x, py: this.app.engine.pan.y };
    this.doubleTap = null;
    this.canvas.style.cursor = 'grabbing';
  }

  /**
   * 空白处左键「预备平移」。判据是**未命中任何器材/接线柱**（由调用方保证），
   * 并且是**鼠标类指针**（调用处拦掉 touch）。
   * ⚠ 触屏不平移**不是「本轮没做」，是产品决策**：单指在触屏上等于滚动/拖器材，
   *   平移与缩放都归两指。删掉调用处那个 pointerType 判据会改掉「单指点空白处 =
   *   取消选中」这条既有语义 —— 用户明令不许动的一条。
   * 这里同时吃掉“双击复位”的第一次点按 —— 第二次才会复位（**复位整个视图**：pan + zoom，
   * 用户当面裁决；`resetPan()` 作为 API 保留、语义不变，只是双击不再走它）。
   */
  armPan(p) {
    if (this.doubleTap && performance.now() - this.doubleTap.at <= DOUBLE_TAP_MS
        && Math.hypot(p.x - this.doubleTap.x, p.y - this.doubleTap.y) <= DOUBLE_TAP_SLOP) {
      this.doubleTap = null;
      // 双击 = 复位**整个视图**（pan + zoom）。恒等视口上 resetView() 返回 false ⇒
      // 不惊动一帧（tools/gesture-probe.mjs §⑧ 的负控按 markDirty 增量钉住这一条）。
      if (this.app.engine.resetView()) this.markDirty();
      return;                     // 双击 = 复位，不再起手平移
    }
    // ⚠ 顺序要紧：startPan() 会把上一次的 doubleTap 清掉（起手平移即作废双击候选），
    //   所以必须先 startPan 再记本次候选。写反了双击复位永远不成立 —— 记下的候选
    //   当场被自己清掉，表现为「点两次没反应」（pan-probe §⑥ 就是钉这一条的）。
    this.startPan(p);
    this.doubleTap = { at: performance.now(), x: p.x, y: p.y };
  }

  // ══════════ 两指手势：平移 + 捏合缩放 ══════════

  /**
   * 第二根手指落下 ⇒ 把两指接管成**视口手势**。
   *
   * 为什么锚点存**世界点**而不是「起手 pan/zoom + 屏幕位移」：捏合与平移必须能同时
   * 发生。把「起手那一刻两指中点下的世界点」(w0) 钉在**当前**中点下方，一句式子
   * 同时给出两件事（见 updateGesture），而且「中点下的世界点不动」这条唯一判据
   * 是**构造出来**的，不用分别调试缩放与平移。
   *
   * 单指那半截手势按既有口径整体作废（`cancel()`）：否则第二根手指落下后第一根
   * 手指还会继续把器材拖走（旧行为，保留）。
   */
  beginGesture(ev, otherId) {
    const a = this.ptrs.get(otherId), b = this.ptrs.get(ev.pointerId);
    this.multi = true;
    this.releaseCapture(ev);
    this.cancel();                       // ⚠ 必须在锚点之前：cancel() 不动 engine.pan/zoom
    if (!a || !b) { this.gesture = null; return; }   // 位置表对不上 ⇒ 不起手势
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const eng = this.app.engine;
    this.gesture = {
      ids: [otherId, ev.pointerId],
      mid,                                     // 起手中点（屏幕坐标）
      dist: Math.hypot(b.x - a.x, b.y - a.y),  // 起手两指间距（屏幕像素）
      w0: this.toWorld(mid),                   // 起手中点下的**世界点**：唯一锚点
      zoom0: eng && eng.zoom ? eng.zoom : 1,
    };
    this.doubleTap = null;   // 两指手势不该留下「双击空白处」的候选
    this.markDirty();
  }

  /**
   * 两指手势的每一帧：`z = zoom0 × (当前间距 / 起手间距)`，再把起手世界点 w0 钉在
   * 当前两指中点下方（`engine.setViewAt`）。于是：
   *   · 间距不变 ⇒ z 不变 ⇒ **纯平移**，位移就是中点位移；
   *   · 中点不动 ⇒ **纯缩放**，而且围绕中点（不是画布左上角）。
   * 上下限由 `engine.clampZoom` 兜住：夹住之后 w0 仍钉在中点下（不跑偏），
   * 只是「间距比 = 缩放比」在边界处不再成立 —— 这是有意的，比让视口飙到 NaN 好。
   */
  updateGesture() {
    const g = this.gesture, eng = this.app.engine;
    const a = this.ptrs.get(g.ids[0]), b = this.ptrs.get(g.ids[1]);
    if (!a || !b || !eng || !eng.setViewAt) { this.gesture = null; return; }  // 指头对不上 ⇒ 作废
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const dist = Math.hypot(b.x - a.x, b.y - a.y);
    const z = g.dist > 0 ? g.zoom0 * (dist / g.dist) : g.zoom0;   // 起手间距为 0 ⇒ 纯平移
    const zBefore = eng.zoom, pxBefore = eng.pan.x, pyBefore = eng.pan.y;
    eng.setViewAt(z, g.w0.x, g.w0.y, mid.x, mid.y);
    // 真的变了才置脏：手势期间手指没动的那些帧不该惊动重绘
    if (eng.zoom !== zBefore || eng.pan.x !== pxBefore || eng.pan.y !== pyBefore) this.markDirty();
  }

  /**
   * 两指手势收尾：**任一根抬起**都走这里（pointercancel / lostpointercapture 同样）。
   * ⚠ 剩下那根手指不许接着变成单指拖动 —— 否则用户松开一根手指的瞬间器材就被拖走。
   *   办法是**主动放弃追踪**（`this.pid = null`）：单指拖动只可能由一次新的
   *   pointerdown 起手（见 onDown）。这不影响「单指行为一个字都不许变」：
   *   单指序列里根本没有语法能走到这里。
   * ⚠ 不回退视口：用户已经调好的 pan/zoom 是他要的结果，作废的只是「这一轮手势」。
   */
  endGesture(ev) {
    this.gesture = null;
    this.multi = this.ptrs.size >= 2;
    this.drag = null;
    this.pan = null;
    this.pid = null;
    if (ev) this.releaseCapture(ev);
    this.canvas.style.cursor = this.tool === 'select' ? 'default' : 'crosshair';
    this.markDirty();
  }

  /**
   * 指针捕获被夺走：只收尾**它参与的那点状态**，不碰无关的拖动。
   * ⚠ 这里不用 `onCancel` 那套整体清理：浏览器会在我们**主动**
   *   `releasePointerCapture()` 之后补一条 `lostpointercapture`（异步派发），
   *   若它顺手清掉 drag/pan，就会误伤这之后刚开始的一次拖动。
   */
  onLostCapture(ev) {
    if (!ev || !ev.pointerId) return;
    this.ptrs.delete(ev.pointerId);
    if (this.gesture && this.gesture.ids.includes(ev.pointerId)) this.endGesture(ev);
    if (ev.pointerId === this.pid) this.pid = null;
    this.multi = this.ptrs.size >= 2;
  }

  startWire(port) {
    if (!this.wireFrom) {
      this.wireFrom = { ent: port.ent, port: port.port };
      this.app.engine.hotPort = { ent: port.ent, port: port.port };
      this.app.toast(`已选择 ${port.ent.def.name} 的接线柱，再点另一个接线柱`);
      this.markDirty();       // 接线柱高亮 + 连线预览
      return;
    }
    const a = { e: this.wireFrom.ent.id, p: this.wireFrom.port };
    const b = { e: port.ent.id, p: port.port };
    const w = this.app.world.connect(a, b);
    if (w) {
      this.markDirty();
      this.app.toast('已连接');
    } else {
      this.app.toast('这两个接线柱不能连接（同一器材，或已重复连接）', 'warn');
    }
    this.wireFrom = null;
    this.app.engine.hotPort = null;
    this.markDirty();         // 预览线消失
  }

  // ══════════ 移动 ══════════
  onMove(ev) {
    // ⓪ 两指手势：**必须最先处理**，而且只驱动视口 —— 多指期间不做任何命中/悬停/
    //    拖动（否则另一根手指会把器材甩到别处）。放在 `if (this.multi)` 之前：
    //    多指封锁现在是「没有手势时的兜底」。
    if (this.gesture) {
      if (ev && this.ptrs.has(ev.pointerId)) this.ptrs.set(ev.pointerId, this.pos(ev));
      this.updateGesture();
      return;
    }
    // 没有按下时只认鼠标：e.pointerType 为空说明这是代码合成的裸事件（探针），
    // 也照鼠标处理。手指不按就不会有 move，无需过滤。
    const hovering = this.pid === null && ev.pointerType !== 'touch';
    // 多指作废期间，画面不跟着任一手指走
    if (this.multi) return;
    // 只在追踪的指针上处理；鼠标未按下时也要处理（悬停高亮）
    if (this.pid !== null && ev.pointerId !== this.pid) return;

    const p = this.pos(ev);
    this.mouse = p;
    // 位置表**每次 move 都刷新**：第二根手指可能随时落下，而起手锚点用的是
    // 「那一刻两根手指的真实位置」（第一根手指用的是它最后一次 move，见 beginGesture）。
    if (this.ptrs.has(ev.pointerId)) this.ptrs.set(ev.pointerId, p);
    const world = this.app.world;
    const w = this.toWorld(p);

    // ① 画布平移：起手后先越过阈值（与拖动器材同一个 DRAG_SLOP），再做真正的平移。
    //    阈值之内的一动都不动，屏幕零抖动。
    if (this.pan) {
      const d = this.pan;
      if (Math.hypot(p.x - d.sx, p.y - d.sy) <= DRAG_SLOP) return;
      this.app.engine.pan.x = d.px + (p.x - d.sx);
      this.app.engine.pan.y = d.py + (p.y - d.sy);
      this.markDirty();
      return;
    }

    // 端口高亮（只在真的换了目标时置脏，暂停时别被无意义的鼠标移动拖着重绘）
    // 正在连线时走 `wirePortAt`：高亮要跟着**吸附**走，否则用户看不见"会连到哪一个"
    const port = this.wireFrom ? this.wirePortAt(w) : this.pickPortAt(w);
    const hot = port ? { ent: port.ent, port: port.port } : null;
    const prevHot = this.app.engine.hotPort;
    const hotChanged = !!prevHot !== !!hot ||
      (!!hot && (prevHot.ent !== hot.ent || prevHot.port !== hot.port));
    this.app.engine.hotPort = hot;

    // 连线预览要跟着指针走，所以有预览就必须重绘
    if (this.wireFrom) this.markDirty();

    if (this.drag) {
      const d = this.drag;
      if (!d.moved) {
        // 起步阈值：阈值内的抖动仍按单击处理，不写回坐标（B4）。
        // 阈值按指针类型分档：手指按下的抖动远大于鼠标，3px 会把轻点误判成拖拽。
        if (Math.hypot(p.x - d.sx, p.y - d.sy) <= d.slop) {
          if (hotChanged) this.markDirty();
          return;
        }
        d.moved = true;
      }
      // ⚠⚠ 这里必须是**世界**指针（`w`），不是屏幕指针（`p`）：`d.dx/dy` 的定义是
      //   「按下时器材位置 − 按下时的**世界**指针」⇒ 它只能和世界指针相加。
      //   写成 `p.x + d.dx` 就是「屏幕量 + 世界量」，误差恰好等于 pan：
      //     误差 = p − (p − pan)/zoom，zoom=1 时 = pan
      //   真机缺陷（用户原话）：「拖动仪器时，仪器位置会飞到触控摸位置 10.5 个格子上面的
      //   位置」—— 10.5 × gridSize(24) = 252 ⇒ 当时 pan.y ≈ −252，逐字吻合。
      //   恒等视口（pan=0 且 zoom=1）下两种写法数值相同，所以旧判据全体漏过（gesture-probe §⑪）。
      const q = this.clampXY(w.x + d.dx, w.y + d.dy, d.ent);
      d.ent.x = Math.round(q.x);
      d.ent.y = Math.round(q.y);
      this.markDirty();
      return;
    }

    // 悬停高亮。触屏没有悬停：手指一直按着时 hovered 没有意义，抬手后它还会
    // 粘在最后一个器材上（「粘滞 hover」），所以触摸设备干脆不维护这个状态。
    if (hovering && !coarsePointer()) {
      const ent = world.pick(w.x, w.y);
      let hoverChanged = false;
      for (const e of world.entities) {
        const h = (e === ent);
        if (e.hovered !== h) { e.hovered = h; hoverChanged = true; }
      }
      if (hotChanged || hoverChanged) this.markDirty();
      this.paintCursor(port, ent);
    } else if (hotChanged) {
      this.markDirty();
    }
  }

  /** 光标形状只对能显示光标的输入设备有意义（手指没有光标，改了也不显示） */
  paintCursor(port, ent) {
    if (this.tool === 'erase') {
      this.canvas.style.cursor = ent ? 'not-allowed' : 'crosshair';
    } else if (port) {
      this.canvas.style.cursor = 'pointer';
    } else if (ent && this.tool === 'select') {
      this.canvas.style.cursor = 'move';
    } else {
      this.canvas.style.cursor = this.tool === 'select' ? 'default' : 'crosshair';
    }
  }

  // ══════════ 抬起 ══════════
  onUp(ev) {
    if (ev) this.ptrs.delete(ev.pointerId);
    // 两指手势：**任一根抬起都结束整段手势**（剩下那根不许接着变成单指拖动，
    // 否则松开一根手指的瞬间器材就被拖走 —— 见 endGesture）。
    if (this.gesture && ev && this.gesture.ids.includes(ev.pointerId)) {
      this.endGesture(ev);
      return;
    }
    if (this.pid !== null && ev && ev.pointerId !== this.pid) return;
    if (this.multi) {
      // 多指作废（没有手势时的兜底）：第一根手指抬起时解除封锁，本轮手势不再产生任何效果
      this.multi = this.ptrs.size >= 2;
      if (ev) this.releaseCapture(ev);
      this.drag = null;
      this.pan = null;
      return;
    }
    this.finishDrag(ev);       // ⚠ 必须传 ev：finishDrag 要用它算净位移（见 CLICK_SLOP）
    this.finishPan();
    if (ev) this.releaseCapture(ev);
  }

  onCancel(ev) {
    if (ev) this.ptrs.delete(ev.pointerId);
    // 参与手势的指针被系统夺走（通知栏下拉、来电、浏览器接管手势）⇒ 整段手势收尾。
    // ⚠ 收尾**不回退视口**：用户已经调好的 pan/zoom 是他要的结果，与 cancel() 同口径。
    if (ev && this.gesture && this.gesture.ids.includes(ev.pointerId)) this.gesture = null;
    this.releaseCapture(ev);
    this.multi = this.ptrs.size >= 2;
    this.drag = null;          // 取消的拖拽不写回坐标，也不触发单击语义
    this.pan = null;
    this.canvas.style.cursor = this.tool === 'select' ? 'default' : 'crosshair';
    this.markDirty();
  }

  finishDrag(ev) {
    if (this.drag) {
      const { ent, moved, ox, oy } = this.drag;
      // ★ 净位移复核（见 CLICK_SLOP 注释）：越过起步阈值、但整段手势其实"几乎没动" ⇒
      //   仍按单击处理，并把器材放回按下位置。没有这一步，点开关时手抖 4px 就会
      //   「开关不切换、物品却动了一下」，是"交互生硬"里最刺眼的一种。
      const net = ev ? Math.hypot(...(() => {
        const p = this.pos(ev);
        return [p.x - this.drag.sx, p.y - this.drag.sy];
      })()) : Infinity;
      const stillAClick = moved && net <= CLICK_SLOP;
      if (moved) {
        if (stillAClick) {
          // 放回按下时的位置（不吸附，也不走 settleTo —— 用户根本没想移动它）
          this.cancelSettle({ land: false });
          ent.x = ox; ent.y = oy;
          this.app.onEntityClicked?.(ent);
        } else {
          // 4px 网格吸附；吸附后可能探出边界，再 clamp 一次（B4）
          const q = this.clampXY(
            Math.round(ent.x / SNAP) * SNAP,
            Math.round(ent.y / SNAP) * SNAP, ent);
          // ⚠ 不直接赋值：`onEntityMoved` 要等**落定**后再调（它是电路重算的入口，
          //   过渡中每帧调一次会很重，而且中间态本来就不该被记进历史/求解器）。
          // ⚠ 把**起止坐标**一起交出去（④-6）：交互层是唯一知道"按下时在哪"的一方，
          //   `ox/oy` 就是按下时的整数位置。少了这两个参数，拖动就没法进撤销栈 ——
          //   `onEntityMoved()` 原来是个空函数，正是因为它拿不到 from/to 就什么也记不了。
          this.settleTo(ent, q.x, q.y, () => this.app.onEntityMoved?.(ent, { x: ox, y: oy }, { x: q.x, y: q.y }));
        }
      } else if (ent && this.tool === 'select') {
        // 单击：开关切换等快捷操作
        this.app.onEntityClicked?.(ent);
      }
      this.markDirty();       // 吸附与单击都可能改变画面
    }
    this.drag = null;
  }

  /**
   * 把器材从当前位置**平滑**送到 (tx,tx) —— 吸附落位的过渡，不是动画特效。
   *
   * 为什么要它：见文件上方 `SETTLE_MS` 的注释（松手瞬移是"手感生硬"的头号来源）。
   * 三条不变量，改这里时不许破：
   *   1. **最终落点与旧实现逐字相同** —— 仍是那一个网格点，不是"近似的网格点"；
   *   2. **`onDone` 只在落定后调一次** —— 它是 `onEntityMoved` 的入口，负责电路重算；
   *   3. **可被打断**：过渡中一旦又按下（`onDown` → `cancelSettle`），立刻停在**当前**位置，
   *      绝不"补跑"到旧目标 —— 否则用户会觉得"它自己动了"。
   */
  settleTo(ent, tx, ty, onDone) {
    this.cancelSettle({ land: false });
    const sx = ent.x, sy = ent.y;
    if (SETTLE_MS <= 0 || (Math.abs(sx - tx) < 1e-9 && Math.abs(sy - ty) < 1e-9)) {
      ent.x = tx; ent.y = ty; this.markDirty();
      if (onDone) onDone();
      return;
    }
    const s = { ent, sx, sy, tx, ty, t0: performance.now(), onDone };
    this.settle = s;
    const tick = () => {
      if (this.settle !== s) return;            // 已被取消或替换
      const k = Math.min(1, (performance.now() - s.t0) / SETTLE_MS);
      const e = 1 - Math.pow(1 - k, 3);         // ease-out cubic：起步快、收尾轻
      s.ent.x = s.sx + (s.tx - s.sx) * e;
      s.ent.y = s.sy + (s.ty - s.sy) * e;
      this.markDirty();
      if (k >= 1) {
        s.ent.x = s.tx; s.ent.y = s.ty;         // 落在**精确**的网格点上，不做近似
        this.settle = null;
        if (s.onDone) s.onDone();
        this.markDirty();
        return;
      }
      this._settleRaf = requestAnimationFrame(tick);
    };
    this._settleRaf = requestAnimationFrame(tick);
  }

  /**
   * 取消正在进行的吸附过渡。
   * `land:true`（默认）= 直接落到位（用于"收尾/关掉"这类确实要它到位的场合）；
   * `land:false` = 停在**当前**位置（用于被新手势打断 —— 见 `settleTo` 不变量 3）。
   */
  cancelSettle({ land = true } = {}) {
    if (this._settleRaf) { cancelAnimationFrame(this._settleRaf); this._settleRaf = 0; }
    const s = this.settle;
    if (!s) return;
    this.settle = null;
    if (land) { s.ent.x = s.tx; s.ent.y = s.ty; if (s.onDone) s.onDone(); }
    this.markDirty();
  }

  /**
   * 平移收尾。真动过（越过阈值）才吸附到 4px 网格 —— 与器材拖动的释放吸附同一档，
   * 视口落在整格上，网格线与屏幕像素的相位稳定，不会留下半像素毛边。
   * 没真动过（阈值内抖动）时 pan 原封不动地留在起手值上，即「点空白处」零副作用。
   */
  finishPan() {
    if (!this.pan) return;
    const moved = this.app.engine.pan.x !== this.pan.px || this.app.engine.pan.y !== this.pan.py;
    if (moved) {
      const pan = this.app.engine.pan;
      pan.x = Math.round(pan.x / SNAP) * SNAP;
      pan.y = Math.round(pan.y / SNAP) * SNAP;
      this.markDirty();
    }
    this.pan = null;
    this.canvas.style.cursor = this.tool === 'select' ? 'default' : 'crosshair';
  }

  // ══════════ 渲染叠加层 ══════════
  drawOverlay(g, engine) {
    // 拖动中的**吸附目标预览**（2026-10-17，交互改造 ④-5）
    //
    // 为什么要它：`SNAP = 4` 的网格吸附在松手瞬间把器材归位，但**那个目标点用户看不见** ——
    // 而画面上的网格是 `gridSize = 24`（engine.js），**和吸附用的不是同一张格**
    // （`tools/grep` 显示 `gridSize` 只用于画网格）。于是"松手后必微跳一下"在用户眼里
    // 完全无法预测：**既看不到将落到哪，也没法提前对齐**。
    //
    // ⇒ 拖动中就把它**画出来**：一个小方框 + 十字，落在将吸附到的那个 4px 点上；
    //   **越接近就越亮**（`k`），让"快要吸上了"变成可感知的反馈。
    //   ⚠ 只画提示，**不改任何坐标** —— 吸附值仍是 4px，落点仍由 `finishDrag` 决定。
    if (this.drag && this.drag.moved && this.tool === 'select') {
      const ent = this.drag.ent;
      const tx = Math.round(ent.x / SNAP) * SNAP;
      const ty = Math.round(ent.y / SNAP) * SNAP;
      const dist = Math.hypot(tx - ent.x, ty - ent.y);
      // 0（已对齐）→ 1（最远）。4px 格最远差约 2.83px，取 SNAP 作分母。
      const k = 1 - Math.min(1, dist / SNAP);
      const b = ent.bounds ? ent.bounds() : null;
      g.save();
      g.globalAlpha = 0.35 + 0.55 * k;          // 越近越实
      g.strokeStyle = C.accent;
      g.lineWidth = 1.4;
      g.setLineDash([]);
      if (b) {
        // 器材外框的**落位轮廓**（比单纯的十字更能看出"将落在哪一格"）
        engine.roundRect(g, tx - b.w / 2, ty - b.h / 2, b.w, b.h, 6);
        g.stroke();
      }
      // 目标点十字
      g.beginPath();
      g.moveTo(tx - 5, ty); g.lineTo(tx + 5, ty);
      g.moveTo(tx, ty - 5); g.lineTo(tx, ty + 5);
      g.stroke();
      g.restore();
    }
    // 连线预览
    if (this.wireFrom) {
      const p1 = this.wireFrom.ent.portWorldAt(this.wireFrom.port);
      if (p1) {
        g.save();
        g.strokeStyle = C.accent;
        g.lineWidth = 2;
        g.setLineDash([6, 5]);
        g.beginPath();
        const m = this.worldMouse();
        // 吸附生效时预览线直接画到「会连上的那个」接线柱上，并套一圈高亮 ——
        // 手指要**看见**"就是它"，否则"吸到了"和"没吸到"在画面上没有区别。
        // ⚠ 只在粗指针算：鼠标档位下 `win` 恒为 null ⇒ 预览线与今天逐位相同。
        const win = coarsePointer() ? this.wirePortAt(m) : null;
        const tip = win ? { x: win.x, y: win.y } : m;
        g.moveTo(p1.x, p1.y);
        g.lineTo(tip.x, tip.y);
        g.stroke();
        if (win) {
          g.setLineDash([]);
          g.strokeStyle = C.portHot;
          g.beginPath(); g.arc(win.x, win.y, 11, 0, Math.PI * 2); g.stroke();
        }
        g.restore();
      }
    }
    // 倾倒源高亮
    if (this.pourFrom) {
      const b = this.pourFrom.bounds();
      g.save();
      g.strokeStyle = C.chem;
      g.lineWidth = 2;
      g.setLineDash([5, 4]);
      engine.roundRect(g, b.x - 6, b.y - 6, b.w + 12, b.h + 12, 9);
      g.stroke();
      g.restore();
    }
  }
}
