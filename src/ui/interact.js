// ══════════════════════════════════════════════════════════
// UI · 交互
//   选择：拖动器材、点接线柱
//   连线：点两个接线柱
//   倾倒：点源容器 → 点目标容器（试剂瓶等「自带一份物质」的器材也能倒 —— 判据是能力，不是命名）
//   删除：点器材
//
// 输入一律走 Pointer Events（pointerdown/move/up/cancel），不再混用
// mousedown/mousemove：触屏上鼠标事件是浏览器在 tap 之后补发的合成事件，
// 位置与时机都滞后一帧以上，拖动会「粘手」而且先滚页面。指针事件把鼠标、
// 手指、触控笔收敛成同一条通路，还能用 setPointerCapture 保证拖动中
// 指针移出画布也不丢事件（老实现靠 window 上的 mouseup 兜底，触屏下不可靠）。
// ══════════════════════════════════════════════════════════

import { C } from '../core/theme.js';
import { canFeed } from '../equipment/lab.js';

const HIT_PORT = 13;
/** 鼠标的拖动起步阈值（px）：位移不超过它就仍算单击，不写回坐标（B4） */
const DRAG_SLOP = 3;
/** 手指/触控笔的起步阈值：手指按下的抖动远大于鼠标，3px 会把轻点误判成拖拽 */
const DRAG_SLOP_TOUCH = 10;
/** 释放时的网格吸附（px） */
const SNAP = 4;

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
    this.wireFrom = null;    // { ent, port }
    this.pourFrom = null;    // 器材
    this.mouse = { x: 0, y: 0 };
    this.down = null;

    /** 正在被追踪的指针 id —— 只认第一根按下的手指 */
    this.pid = null;
    /** 多指同时按下：本轮手势整体作废（不做捏合缩放，但不能让画布被路人手指拖着走） */
    this.multi = false;

    // 引擎比本交互层先创建，但引擎要读 app._dirty（B1 的脏检查约定）与
    // app.coupling（B6 的耦合流动线索），这里把 app 引用补给它。
    if (app.engine) app.engine.app = app;

    // 画布是拖拽面：浏览器不许在这个元素上滚页面或做双指缩放，否则拖动器材时
    // 页面会跟着跑。所有权声明在真正拥有手势的模块里（这里），而不是散在样式表里。
    // 无条件设 none，不按指针能力分支：touch-action 只约束**触摸**输入，
    // 对鼠标和滚轮完全惰性 —— 桌面用户既不会因此失去什么，触屏笔记本
    // （主指针是触控板、pointer:fine 为真）也不会漏掉这条。
    this.canvas.style.touchAction = 'none';

    this.bind();
  }

  /** 画面需要重绘。
   *  app.markDirty 由 §2-C2 在 main.js 里定义；它还没落地时用引擎自己的
   *  脏标记兜底，两者都没有就静默跳过 —— 绝不再抛 TypeError（B5）。 */
  markDirty() {
    if (this.app.markDirty) this.app.markDirty();
    const eng = this.app.engine;
    if (eng && eng.markDirty) eng.markDirty();
  }

  /** 把器材中心限制在画布可见区域内（B4：拖到边缘不再静默丢失跟随） */
  clampXY(x, y, ent) {
    const eng = this.app.engine;
    const W = (eng && eng.w) || 0, H = (eng && eng.h) || 0;
    if (!W || !H) return { x, y };
    const hw = Math.min(ent.w / 2, W / 2);
    const hh = Math.min(ent.h / 2, H / 2);
    return {
      x: Math.max(hw, Math.min(W - hw, x)),
      y: Math.max(hh, Math.min(H - hh, y)),
    };
  }


  pos(ev) {
    const r = this.canvas.getBoundingClientRect();
    return { x: ev.clientX - r.left, y: ev.clientY - r.top };
  }

  bind() {
    const cv = this.canvas;
    cv.addEventListener('pointerdown', (e) => this.onDown(e));
    cv.addEventListener('pointermove', (e) => this.onMove(e));
    cv.addEventListener('pointerup', (e) => this.onUp(e));
    // 指针被系统夺走（通知栏下拉、来电、浏览器接管手势）时必须走和 pointerup
    // 一样的收尾，否则 drag/wireFrom 会永远挂在那里，下一次点按变成「接着上一次拖」。
    cv.addEventListener('pointercancel', (e) => this.onCancel(e));
    // 触屏没有右键，contextmenu 只可能是长按菜单（或者鼠标右键）—— 一律挡掉。
    cv.addEventListener('contextmenu', (e) => { e.preventDefault(); this.cancel(); });
  }

  setTool(t) {
    this.cancel();
    this.tool = t;
    this.canvas.style.cursor = t === 'select' ? 'default' : 'crosshair';
    this.app.setStatusTool(t);
  }

  cancel() {
    const had = !!(this.wireFrom || this.pourFrom || this.drag ||
      this.app.engine.hotPort || this.app.highlight);
    this.wireFrom = null;
    this.pourFrom = null;
    this.drag = null;
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
    // 非主键一律不参与：鼠标右键、中键、以及 macOS 上按下 Ctrl 的左键点击
    // （click 是左键、但按键语义是右键）都被这一句挡在外面。
    if (ev.button !== 0) return;

    // 第二根手指落下：不做捏合缩放（本阶段 YAGNI），但必须让整个手势失效，
    // 否则另一根手指会被当成「同一个拖拽」把器材甩到别处。
    if (this.pid !== null && ev.pointerId !== this.pid) {
      this.multi = true;
      this.releaseCapture(ev);
      this.cancel();
      return;
    }
    this.pid = ev.pointerId;

    // 指针捕获：拖动中指针离开画布（拖到侧栏上方）也照样收到 move/up。
    if (this.canvas.setPointerCapture) {
      try { this.canvas.setPointerCapture(ev.pointerId); } catch { /* 指针已失效，退回逐元素派发 */ }
    }

    const p = this.pos(ev);
    this.mouse = p;
    const world = this.app.world;

    if (this.tool === 'select') {
      // 1) 先看接线柱（方便接线/拖动）
      const port = world.pickPort(p.x, p.y, HIT_PORT);
      if (port && ev.shiftKey) { this.startWire(port); return; }

      // 2) 选中器材并开始拖动
      const ent = world.pick(p.x, p.y);
      if (ent) {
        this.app.select(ent);
        // sx/sy 是本次拖拽的起点，用来算起步阈值（B4）
        this.drag = {
          ent, dx: ent.x - p.x, dy: ent.y - p.y, sx: p.x, sy: p.y,
          slop: ev.pointerType === 'mouse' ? DRAG_SLOP : DRAG_SLOP_TOUCH,
          moved: false,
        };
      } else {
        this.app.select(null);
      }
      this.markDirty();       // 选中框变了
      return;
    }

    if (this.tool === 'wire') {
      const port = world.pickPort(p.x, p.y, HIT_PORT);
      if (!port) { this.app.toast('请点击器材上的接线柱（小圆点）', 'warn'); return; }
      this.startWire(port);
      return;
    }

    if (this.tool === 'pour') {
      const ent = world.pick(p.x, p.y);
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
      const ent = world.pick(p.x, p.y);
      if (ent) this.app.removeEntity(ent);
      return;
    }
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
    // 没有按下时只认鼠标：e.pointerType 为空说明这是代码合成的裸事件（探针），
    // 也照鼠标处理。手指不按就不会有 move，无需过滤。
    const hovering = this.pid === null && ev.pointerType !== 'touch';
    // 多指作废期间，画面不跟着任一手指走
    if (this.multi) return;
    // 只在追踪的指针上处理；鼠标未按下时也要处理（悬停高亮）
    if (this.pid !== null && ev.pointerId !== this.pid) return;

    const p = this.pos(ev);
    this.mouse = p;
    const world = this.app.world;

    // 端口高亮（只在真的换了目标时置脏，暂停时别被无意义的鼠标移动拖着重绘）
    const port = world.pickPort(p.x, p.y, HIT_PORT);
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
      const q = this.clampXY(p.x + d.dx, p.y + d.dy, d.ent);
      d.ent.x = Math.round(q.x);
      d.ent.y = Math.round(q.y);
      this.markDirty();
      return;
    }

    // 悬停高亮。触屏没有悬停：手指一直按着时 hovered 没有意义，抬手后它还会
    // 粘在最后一个器材上（「粘滞 hover」），所以触摸设备干脆不维护这个状态。
    if (hovering && !coarsePointer()) {
      const ent = world.pick(p.x, p.y);
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
    if (this.pid !== null && ev && ev.pointerId !== this.pid) return;
    if (this.multi) {
      // 多指作废：第一根手指抬起时解除封锁，本轮手势不再产生任何效果
      this.multi = false;
      if (ev) this.releaseCapture(ev);
      this.drag = null;
      return;
    }
    this.finishDrag();
    if (ev) this.releaseCapture(ev);
  }

  onCancel(ev) {
    this.releaseCapture(ev);
    this.multi = false;
    this.drag = null;          // 取消的拖拽不写回坐标，也不触发单击语义
    this.markDirty();
  }

  finishDrag() {
    if (this.drag) {
      const { ent, moved } = this.drag;
      if (moved) {
        // 4px 网格吸附；吸附后可能探出边界，再 clamp 一次（B4）
        const q = this.clampXY(
          Math.round(ent.x / SNAP) * SNAP,
          Math.round(ent.y / SNAP) * SNAP, ent);
        ent.x = q.x;
        ent.y = q.y;
        this.app.onEntityMoved?.(ent);
      } else if (ent && this.tool === 'select') {
        // 单击：开关切换等快捷操作
        this.app.onEntityClicked?.(ent);
      }
      this.markDirty();       // 吸附与单击都可能改变画面
    }
    this.drag = null;
  }

  // ══════════ 渲染叠加层 ══════════
  drawOverlay(g, engine) {
    // 连线预览
    if (this.wireFrom) {
      const p1 = this.wireFrom.ent.portWorldAt(this.wireFrom.port);
      if (p1) {
        g.save();
        g.strokeStyle = C.accent;
        g.lineWidth = 2;
        g.setLineDash([6, 5]);
        g.beginPath();
        g.moveTo(p1.x, p1.y);
        g.lineTo(this.mouse.x, this.mouse.y);
        g.stroke();
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
