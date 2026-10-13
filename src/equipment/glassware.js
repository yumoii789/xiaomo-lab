const DEFS = [];
// ══════════════════════════════════════════════════════════
// 化学域 · 玻璃器皿（容器）
//
// 所有容器共用一套「内部轮廓 + 液体裁剪」渲染：
//   innerPath()  定义玻璃内壁的形状
//   液体、沉淀、气泡都在这条路径里裁剪后绘制
// 于是加一种容器只需要写一个 innerPath。
// ══════════════════════════════════════════════════════════

import { Entity, gfx, dmg, grad1 } from '../core/entity.js';
import { define } from './registry.js';
import { VesselModel } from '../chemistry/vessel.js';
import { SP } from '../chemistry/species.js';

const CH = 'chemistry';
const GLASS = 'rgba(200,224,240,.55)';
const GLASS_HI = 'rgba(235,248,255,.55)';

class Glassware extends Entity {
  constructor(def, x, y) {
    super(def, x, y);
    this.vessel = new VesselModel(this, this.props.capacity || 250);
    this._bubbles = [];
  }

  /** 液体区域（局部坐标） */
  geom() { const w = this.w * 0.8, h = this.h * 0.76; return { x: -w / 2, y: -this.h * 0.06, w, h }; }

  /** 玻璃内壁路径（局部坐标） */
  innerPath(g) {
    const { x, y, w, h } = this.geom();
    gfx.rr(g, x, y, w, h, 6);
  }

  insertZone() {
    const gm = this.geom();
    return { x: this.x + gm.x, y: this.y + gm.y, w: gm.w, h: gm.h };
  }

  // 容器内容随场景一起存取
  serializeState() { return this.vessel.toJSON(); }
  deserializeState(s) { this.vessel.loadJSON(s); }

  step(dt, world) {
    this.worldTime = world.time;
    this.vessel.step(dt, world);
    // 气泡粒子
    if (this.vessel._gasRate > 0 && this.vessel.volume > 0) {
      const n = Math.min(3, Math.ceil(this.vessel._gasRate * 4000));
      for (let i = 0; i < n; i++) {
        const gm = this.geom();
        this._bubbles.push({
          x: gm.x + 6 + Math.random() * (gm.w - 12),
          y: gm.y + gm.h - 4,
          r: 1.2 + Math.random() * 2.2,
          v: 14 + Math.random() * 22,
          life: 1,
        });
      }
    }
    for (let i = this._bubbles.length - 1; i >= 0; i--) {
      const b = this._bubbles[i];
      b.y -= b.v * dt;
      b.life -= dt * 0.55;
      const gm = this.geom();
      if (b.life <= 0 || b.y < gm.y) this._bubbles.splice(i, 1);
    }
    if (this._bubbles.length > 220) this._bubbles.splice(0, this._bubbles.length - 220);
  }

  /** 画液体 / 沉淀 / 气泡 */
  drawContents(g, { rounded = false } = {}) {
    const v = this.vessel;
    const gm = this.geom();
    if (v.volume > 0 || v.precip.size > 0 || v.solid.size > 0) {
      const frac = Math.min(1, v.volume / v.capacity);
      const lh = Math.max(0, gm.h * frac);
      const top = gm.y + gm.h - lh;

      g.save();
      this.innerPath(g);
      g.clip();

      // 液体
      if (v.volume > 0) {
        const col = v.color
          ? `rgb(${v.color[0]},${v.color[1]},${v.color[2]})`
          : 'rgba(120,190,215,.45)';
        const grd = grad1(this, '_gLiquid', g, `${top}|${gm.y + gm.h}|${col}`, () => {
          const gg = g.createLinearGradient(0, top, 0, gm.y + gm.h);
          gg.addColorStop(0, col);
          gg.addColorStop(1, shade(col, 0.78));
          return gg;
        });
        g.fillStyle = grd;
        g.fillRect(gm.x, top, gm.w, lh);

        // 液面高光
        g.fillStyle = 'rgba(255,255,255,.22)';
        g.fillRect(gm.x, top, gm.w, 1.6);
      }

      // 沉淀 / 未溶固体（沉底）
      let pMass = 0;
      for (const [, gg] of v.precip) pMass += gg;
      for (const [, gg] of v.solid) pMass += gg;
      if (pMass > 1e-6) {
        const ph = Math.min(gm.h * 0.42, 3 + pMass * 1.6);
        let col = [180, 180, 180];
        for (const [id] of v.precip) { col = (SP[id] && SP[id].precip) || col; break; }
        g.fillStyle = `rgba(${col[0]},${col[1]},${col[2]},.9)`;
        g.beginPath();
        g.moveTo(gm.x, gm.y + gm.h);
        g.lineTo(gm.x, gm.y + gm.h - ph * 0.45);
        for (let i = 0; i <= 8; i++) {
          const x = gm.x + gm.w * i / 8;
          const y = gm.y + gm.h - ph * (0.55 + 0.45 * Math.sin(i * 1.7));
          g.lineTo(x, y);
        }
        g.lineTo(gm.x + gm.w, gm.y + gm.h - ph * 0.45);
        g.lineTo(gm.x + gm.w, gm.y + gm.h);
        g.closePath();
        g.fill();
      }

      // 气泡
      for (const b of this._bubbles) {
        g.beginPath();
        g.arc(b.x, b.y, b.r, 0, Math.PI * 2);
        g.fillStyle = `rgba(230,248,255,${0.5 * b.life})`;
        g.fill();
      }
      g.restore();
    }
  }

  drawGlass(g, label) {
    const gm = this.geom();
    g.save();
    this.innerPath(g);
    g.fillStyle = 'rgba(150,190,215,.06)';
    g.fill();
    g.strokeStyle = GLASS;
    g.lineWidth = 1.6;
    g.stroke();
    g.restore();
    // 左侧高光
    g.strokeStyle = GLASS_HI;
    g.lineWidth = 1.2;
    g.beginPath();
    g.moveTo(gm.x + 3, gm.y + 6);
    g.lineTo(gm.x + 3, gm.y + gm.h - 8);
    g.stroke();
    if (label) gfx.text(g, label, 0, this.h / 2 - 4, { color: '#5c6672', size: 9 });
  }

  /** 温度标签（超过 40 度才显示，避免画面嘈杂） */
  drawTemp(g) {
    const t = this.vessel.temp;
    if (t < 32) return;
    const gm = this.geom();
    const col = t > 80 ? '#ff8a5c' : t > 55 ? '#ffb45c' : '#7fe8d8';
    gfx.text(g, t.toFixed(0) + '°C', 0, gm.y - 6, { color: col, size: 10.5, weight: '600' });
  }

  /**
   * 炸裂后的玻璃：发白失透 + 放射状裂纹 + 破口。
   * 形状全部由器材 id 派生的确定性随机数生成 —— 每帧完全一致，不会抖动。
   */
  drawDamage(g) {
    if (!dmg.of(this)) return;
    const gm = this.geom();
    g.save();
    this.innerPath(g);
    g.clip();
    // 玻璃发白（失透）
    g.fillStyle = 'rgba(232,242,248,.12)';
    g.fillRect(gm.x - 4, gm.y - 4, gm.w + 8, gm.h + 8);
    const next = dmg.rand(this, 1);
    const len = Math.max(gm.w, gm.h);
    const c1x = gm.x + gm.w * (0.25 + next() * 0.5);
    const c1y = gm.y + gm.h * (0.25 + next() * 0.5);
    dmg.cracks(g, c1x, c1y, 4, len * 0.62, next);
    const c2x = gm.x + gm.w * (0.2 + next() * 0.6);
    const c2y = gm.y + gm.h * (0.2 + next() * 0.6);
    dmg.cracks(g, c2x, c2y, 3, len * 0.44, next);
    dmg.chip(g, c2x, c2y, Math.min(gm.w, gm.h) * 0.16 + 3, next);
    g.restore();
  }
}

/** 把 rgb 字符串调暗 */
function shade(c, k) {
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(c);
  if (!m) return c;
  return `rgb(${Math.round(+m[1] * k)},${Math.round(+m[2] * k)},${Math.round(+m[3] * k)})`;
}

// ─────────────────────────────────────────────────────────
class Beaker extends Glassware {
  geom() { const w = this.w * 0.78, h = this.h * 0.78; return { x: -w / 2, y: -h / 2, w, h }; }
  innerPath(g) {
    const { x, y, w, h } = this.geom();
    const r = 7;
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x, y + h - r);
    g.quadraticCurveTo(x, y + h, x + r, y + h);
    g.lineTo(x + w - r, y + h);
    g.quadraticCurveTo(x + w, y + h, x + w, y + h - r);
    g.lineTo(x + w, y);
  }
  render(g) {
    this.drawContents(g);
    this.drawGlass(g, this.props.capacity + ' mL');
    // 刻度
    const gm = this.geom();
    g.strokeStyle = 'rgba(196,220,236,.35)';
    g.lineWidth = 1;
    for (let i = 1; i <= 4; i++) {
      const y = gm.y + gm.h * (1 - i / 5);
      const len = i % 2 === 0 ? 12 : 7;
      g.beginPath(); g.moveTo(gm.x + gm.w - 2, y); g.lineTo(gm.x + gm.w - 2 - len, y); g.stroke();
    }
    // 杯口
    g.strokeStyle = GLASS; g.lineWidth = 1.8;
    g.beginPath(); g.moveTo(gm.x - 2, gm.y); g.lineTo(gm.x + gm.w + 2, gm.y); g.stroke();
    this.drawDamage(g);
    this.drawTemp(g);
  }
}
const beakerDef = {
  type: 'beaker', name: '烧杯', domain: CH, cat: '容器', icon: '🥛',
  desc: '反应容器，可插电极、加热', w: 86, h: 92,
  ports: [{ x: 0, y: -46, kind: 'probe', label: '插入口' }],
  defaults: { capacity: 250 },
  tags: ['烧杯', '容器', '反应'],
  fields: [{ k: 'capacity', label: '容积', type: 'range', min: 50, max: 1000, step: 50, unit: 'mL' }],
  create: (x, y) => new Beaker(beakerDef, x, y),
};
DEFS.push(() => define(beakerDef));

// ─────────────────────────────────────────────────────────
class TestTube extends Glassware {
  geom() { const w = this.w * 0.54, h = this.h * 0.84; return { x: -w / 2, y: -this.h * 0.42, w, h }; }
  innerPath(g) {
    const { x, y, w, h } = this.geom();
    const r = w / 2;
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x, y + h - r);
    g.arc(x + r, y + h - r, r, Math.PI, 0, true);
    g.lineTo(x + w, y);
  }
  render(g) {
    this.drawContents(g);
    this.drawGlass(g, '');
    const gm = this.geom();
    g.strokeStyle = GLASS; g.lineWidth = 1.8;
    g.beginPath(); g.moveTo(gm.x - 3, gm.y); g.lineTo(gm.x + gm.w + 3, gm.y); g.stroke();
    this.drawDamage(g);
    this.drawTemp(g);
  }
}
const testTubeDef = {
  type: 'testtube', name: '试管', domain: CH, cat: '容器', icon: '🧪',
  desc: '少量试液反应，可直接加热', w: 44, h: 118,
  ports: [{ x: 0, y: -58, kind: 'probe', label: '管口' }],
  defaults: { capacity: 30 },
  tags: ['试管', '容器', '反应'],
  fields: [{ k: 'capacity', label: '容积', type: 'range', min: 10, max: 60, step: 5, unit: 'mL' }],
  create: (x, y) => new TestTube(testTubeDef, x, y),
};
DEFS.push(() => define(testTubeDef));

// ─────────────────────────────────────────────────────────
class Flask extends Glassware {
  geom() { const w = this.w * 0.74, h = this.h * 0.8; return { x: -w / 2, y: -this.h * 0.34, w, h }; }
  innerPath(g) {
    const { x, y, w, h } = this.geom();
    g.beginPath();
    g.moveTo(x + w * 0.36, -this.h * 0.3);
    g.lineTo(x + w * 0.36, y + 4);
    g.lineTo(x + 3, y + h - 5);
    g.quadraticCurveTo(x, y + h, x + 7, y + h);
    g.lineTo(x + w - 7, y + h);
    g.quadraticCurveTo(x + w, y + h, x + w - 3, y + h - 5);
    g.lineTo(x + w * 0.64, y + 4);
    g.lineTo(x + w * 0.64, -this.h * 0.3);
  }
  render(g) {
    this.drawContents(g);
    this.drawGlass(g, '');
    this.drawDamage(g);
    this.drawTemp(g);
  }
}
const flaskDef = {
  type: 'flask', name: '锥形瓶', domain: CH, cat: '容器', icon: '⚗',
  desc: '振荡方便，常用于滴定与产气', w: 88, h: 104,
  ports: [{ x: 0, y: -54, kind: 'probe', label: '瓶口' }],
  defaults: { capacity: 150 },
  tags: ['锥形瓶', '容器'],
  fields: [{ k: 'capacity', label: '容积', type: 'range', min: 50, max: 500, step: 50, unit: 'mL' }],
  create: (x, y) => new Flask(flaskDef, x, y),
};
DEFS.push(() => define(flaskDef));

// ─────────────────────────────────────────────────────────
class Cylinder extends Glassware {
  geom() { const w = this.w * 0.46, h = this.h * 0.86; return { x: -w / 2, y: -this.h * 0.43, w, h }; }
  innerPath(g) { const gm = this.geom(); gfx.rr(g, gm.x, gm.y, gm.w, gm.h, 4); }
  render(g) {
    this.drawContents(g);
    this.drawGlass(g, '');
    const gm = this.geom();
    g.strokeStyle = 'rgba(196,220,236,.4)'; g.lineWidth = 1;
    for (let i = 1; i < 10; i++) {
      const y = gm.y + gm.h * (1 - i / 10);
      const len = i % 5 === 0 ? 11 : 6;
      g.beginPath(); g.moveTo(gm.x + gm.w - 1, y); g.lineTo(gm.x + gm.w - 1 - len, y); g.stroke();
    }
    gfx.text(g, '量筒', 0, this.h / 2 - 4, { color: '#5c6672', size: 9 });
    this.drawDamage(g);
    this.drawTemp(g);
  }
}
const cylinderDef = {
  type: 'cylinder', name: '量筒', domain: CH, cat: '容器', icon: '📏',
  desc: '量取液体体积', w: 42, h: 110,
  ports: [{ x: 0, y: -58, kind: 'probe', label: '口' }],
  defaults: { capacity: 100 },
  tags: ['量筒', '容器', '测量'],
  fields: [{ k: 'capacity', label: '量程', type: 'range', min: 10, max: 500, step: 10, unit: 'mL' }],
  create: (x, y) => new Cylinder(cylinderDef, x, y),
};
DEFS.push(() => define(cylinderDef));

export { Glassware, Beaker, TestTube, Flask, Cylinder };

// ── 插件 ──────────────────────────────────────────────────
export default {
  id: 'xiaomo.equipment.glassware',
  name: '玻璃器皿',
  version: '1.0.0',
  kind: 'equipment',
  domain: 'chemistry',
  desc: '烧杯、试管、锥形瓶、量筒 —— 所有化学反应的容器',
  author: '小墨实验室',
  builtin: true,
  tags: ['化学', '容器'],
  setup(ctx) { ctx.scope('equipment', () => DEFS.forEach(f => f())); },
};
