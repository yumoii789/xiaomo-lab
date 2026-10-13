// ══════════════════════════════════════════════════════════
// UI · 交互
//   选择：拖动器材、点接线柱
//   连线：点两个接线柱
//   倾倒：点源容器 → 点目标容器（试剂瓶也能倒）
//   删除：点器材
// ══════════════════════════════════════════════════════════

import { C } from '../core/theme.js';

const HIT_PORT = 13;
/** 拖动起步阈值（px）：位移不超过它就仍算单击，不写回坐标（B4） */
const DRAG_SLOP = 3;
/** 释放时的网格吸附（px） */
const SNAP = 4;

export class Interaction {
  constructor(app) {
    this.app = app;
    this.canvas = app.canvas;
    this.tool = 'select';

    this.drag = null;        // { ent, dx, dy, sx, sy, moved }
    this.wireFrom = null;    // { ent, port }
    this.pourFrom = null;    // 器材
    this.mouse = { x: 0, y: 0 };
    this.down = null;

    // 引擎比本交互层先创建，但引擎要读 app._dirty（B1 的脏检查约定）与
    // app.coupling（B6 的耦合流动线索），这里把 app 引用补给它。
    if (app.engine) app.engine.app = app;

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
    cv.addEventListener('mousedown', (e) => this.onDown(e));
    cv.addEventListener('mousemove', (e) => this.onMove(e));
    window.addEventListener('mouseup', (e) => this.onUp(e));
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


  // ══════════ 按下 ══════════
  onDown(ev) {
    if (ev.button !== 0) return;
    const p = this.pos(ev);
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
        this.drag = { ent, dx: ent.x - p.x, dy: ent.y - p.y, sx: p.x, sy: p.y, moved: false };
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
        if (!ent.vessel && !ent.type.startsWith('reagent-')) {
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
        // 起步阈值：阈值内的抖动仍按单击处理，不写回坐标（B4）
        if (Math.hypot(p.x - d.sx, p.y - d.sy) <= DRAG_SLOP) {
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

    // 悬停高亮
    const ent = world.pick(p.x, p.y);
    let hoverChanged = false;
    for (const e of world.entities) {
      const h = (e === ent);
      if (e.hovered !== h) { e.hovered = h; hoverChanged = true; }
    }
    if (hotChanged || hoverChanged) this.markDirty();
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
  onUp() {
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
