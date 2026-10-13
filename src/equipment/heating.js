const DEFS = [];
// ══════════════════════════════════════════════════════════
// 化学域 · 加热与支架
//
// 酒精灯是「热源」：它没有接线柱，靠空间位置把热功率交给
// 正上方的容器（由耦合总线检索）。这是化学 → 物理链路的起点，
// 因为溶液温度最终会改变热敏电阻的阻值。
// ══════════════════════════════════════════════════════════

import { Entity, gfx, grad1 } from '../core/entity.js';
import { define } from './registry.js';

const CH = 'chemistry';

// ─────────────────────────────────────────────────────────
// 酒精灯
// ─────────────────────────────────────────────────────────
class AlcoholLamp extends Entity {
  flame = true;                    // 标记：这是一个热源

  constructor(def, x, y) {
    super(def, x, y);
    this.state.flick = Math.random() * 10;
  }

  step(dt) {
    if (this.props.lit) this.state.flick += dt * 9;
  }

  render(g) {
    const { w, h } = this;
    const lit = this.props.lit;
    const f = this.state.flick || 0;

    // 灯身（梯形玻璃瓶）
    g.beginPath();
    g.moveTo(-w * 0.34, h * 0.5);
    g.lineTo(-w * 0.22, -h * 0.08);
    g.lineTo(w * 0.22, -h * 0.08);
    g.lineTo(w * 0.34, h * 0.5);
    g.closePath();
    g.fillStyle = 'rgba(120,170,200,.28)';
    g.fill();
    g.strokeStyle = 'rgba(196,220,236,.45)';
    g.lineWidth = 1.5; g.stroke();

    // 酒精液面
    g.save();
    g.beginPath();
    g.moveTo(-w * 0.34, h * 0.5);
    g.lineTo(-w * 0.22, -h * 0.08);
    g.lineTo(w * 0.22, -h * 0.08);
    g.lineTo(w * 0.34, h * 0.5);
    g.closePath(); g.clip();
    g.fillStyle = 'rgba(150,205,235,.35)';
    g.fillRect(-w / 2, h * 0.16, w, h * 0.5);
    g.restore();

    // 灯颈与灯芯
    gfx.fillRR(g, -w * 0.15, -h * 0.2, w * 0.3, h * 0.15, 3, '#2f3742');
    gfx.strokeRR(g, -w * 0.15, -h * 0.2, w * 0.3, h * 0.15, 3, 'rgba(196,220,236,.4)', 1.2);
    gfx.fillRR(g, -3, -h * 0.34, 6, h * 0.16, 2, lit ? '#e8d9b0' : '#8d96a0');

    // 火焰
    if (lit) {
      const sway = Math.sin(f) * 1.6;
      const fh = h * 0.52 + Math.sin(f * 1.7) * 3;
      const fw = w * 0.2;

      // 外焰整条画在归一化坐标里（y: 0 → −1），纵向尺寸交给变换，
      // 于是「火苗高度每帧抖动」不再意味着重建渐变 —— 填充结果逐像素不变。
      const grd = grad1(this, '_gFlame', g, 'flame', () => {
        const gg = g.createLinearGradient(0, 0, 0, -1);
        gg.addColorStop(0, 'rgba(255,180,70,.85)');
        gg.addColorStop(0.55, 'rgba(255,140,50,.55)');
        gg.addColorStop(1, 'rgba(255,90,40,0)');
        return gg;
      });
      g.save();
      g.translate(0, -h * 0.32);
      g.scale(1, fh);

      // 外焰
      g.beginPath();
      g.moveTo(-fw, 0);
      g.quadraticCurveTo(-fw * 1.5 + sway, -0.55, sway, -1);
      g.quadraticCurveTo(fw * 1.5 + sway, -0.55, fw, 0);
      g.closePath();
      g.fillStyle = grd; g.fill();

      // 内焰
      g.beginPath();
      g.moveTo(-fw * 0.45, 0);
      g.quadraticCurveTo(-fw * 0.7, -0.4, sway * 0.6, -0.62);
      g.quadraticCurveTo(fw * 0.7, -0.4, fw * 0.45, 0);
      g.closePath();
      g.fillStyle = 'rgba(180,220,255,.55)';
      g.fill();
      g.restore();

      // 光晕
      const rad = Math.max(w, h) * 0.9;
      const gg = grad1(this, '_gFlameGlow', g, rad + '|' + h, () => {
        const r2 = g.createRadialGradient(0, -h * 0.4, 2, 0, -h * 0.4, rad);
        r2.addColorStop(0, 'rgba(255,170,80,.22)');
        r2.addColorStop(1, 'rgba(255,170,80,0)');
        return r2;
      });
      g.fillStyle = gg;
      g.beginPath(); g.arc(0, -h * 0.4, rad, 0, Math.PI * 2); g.fill();
    }

    gfx.text(g, lit ? '加热中' : '未点燃', 0, h * 0.5 + 12,
      { color: lit ? '#ffb45c' : '#5c6672', size: 9.5 });
  }
}
const alcoholDef = {
  type: 'alcohollamp', name: '酒精灯', domain: CH, cat: '加热', icon: '🔥',
  desc: '点燃后加热正上方的容器', w: 58, h: 72,
  ports: [],
  defaults: { lit: false, power: 200 },
  tags: ['酒精灯', '加热', '热源'],
  fields: [
    { k: 'lit', label: '点燃', type: 'checkbox', text: '正在燃烧' },
    { k: 'power', label: '热功率', type: 'range', min: 40, max: 600, step: 10, unit: 'W' },
  ],
  create: (x, y) => new AlcoholLamp(alcoholDef, x, y),
};
DEFS.push(() => define(alcoholDef));

// ─────────────────────────────────────────────────────────
// 铁架台（支架 / 装饰，用于把器材摆出真实实验的样子）
// ─────────────────────────────────────────────────────────
class IronStand extends Entity {
  render(g) {
    const { w, h } = this;
    // 底座
    gfx.fillRR(g, -w / 2, h / 2 - 12, w, 12, 3, '#39434d');
    gfx.strokeRR(g, -w / 2, h / 2 - 12, w, 12, 3, '#4a5560', 1.2);
    // 立杆
    gfx.fillRR(g, -w / 2 + 14, -h / 2 + 4, 6, h - 16, 2, '#5a6672');
    // 铁圈
    g.strokeStyle = '#5a6672'; g.lineWidth = 3;
    g.beginPath(); g.arc(w * 0.16, -h * 0.16, 17, 0, Math.PI * 2); g.stroke();
    g.strokeStyle = '#4a5560'; g.lineWidth = 2;
    g.beginPath(); g.moveTo(-w / 2 + 20, -h * 0.16); g.lineTo(w * 0.16 - 17, -h * 0.16); g.stroke();
  }
}
const ironDef = {
  type: 'ironstand', name: '铁架台', domain: CH, cat: '支架', icon: '🗼',
  desc: '固定仪器、摆放容器', w: 110, h: 150,
  ports: [],
  defaults: {},
  tags: ['铁架台', '支架'],
  fields: [],
  create: (x, y) => new IronStand(ironDef, x, y),
};
DEFS.push(() => define(ironDef));

export { AlcoholLamp, IronStand };

// ── 插件 ──────────────────────────────────────────────────
export default {
  id: 'xiaomo.equipment.heating',
  name: '加热器材',
  version: '1.0.0',
  kind: 'equipment',
  domain: 'chemistry',
  desc: '酒精灯、铁架台',
  author: '小墨实验室',
  builtin: true,
  tags: ['化学', '加热'],
  setup(ctx) { ctx.scope('equipment', () => DEFS.forEach(f => f())); },
};
