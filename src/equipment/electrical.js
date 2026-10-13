const DEFS = [];
// ══════════════════════════════════════════════════════════
// 物理域 · 电学器材
//
// 每个器材只声明三件事：怎么画、在电路里是什么、参数如何影响阻值。
// 电路求解器完全不知道它们叫什么名字。
// ══════════════════════════════════════════════════════════

import { Entity, gfx, dmg, grad1 } from '../core/entity.js';
import { define } from './registry.js';

const PH = 'physics';
const PANEL = '#242c34', EDGE = '#39434d', LEAD = '#5a6672';
const TXT = '#e6edf3', DIM = '#8d96a0', HOT = '#ffd166', OK = '#4ade80';

/** 从器材两侧画引线到接线柱 */
function leads(g, e) {
  g.strokeStyle = LEAD; g.lineWidth = 2; g.lineCap = 'round';
  for (const p of e.ports) {
    if (p.kind !== 'wire') continue;
    const sx = p.x >= 0 ? e.w / 2 : -e.w / 2;
    g.beginPath(); g.moveTo(sx, 0); g.lineTo(p.x, p.y); g.stroke();
  }
}
function plate(g, e, r = 7) {
  gfx.fillRR(g, -e.w / 2, -e.h / 2, e.w, e.h, r, PANEL);
  gfx.strokeRR(g, -e.w / 2, -e.h / 2, e.w, e.h, r, EDGE, 1.5);
}
/** 通电时器材周围的柔光 */
function glow(g, e, intensity, color = '255,209,102') {
  if (intensity <= 0.02) return;
  const r = Math.max(e.w, e.h) * 0.85;
  // 亮度最终落在 8 位 alpha 上（浏览器解析颜色时就会量化到这个精度），
  // 所以把「已经量化好的 alpha」当作缓存键：外观一模一样，亮度不变就不重建渐变。
  const a = Math.round(Math.min(1, intensity) * 0.32 * 255) / 255;
  const grd = grad1(e, '_gGlow', g, r + '|' + color + '|' + a, () => {
    const gg = g.createRadialGradient(0, 0, 2, 0, 0, r);
    gg.addColorStop(0, `rgba(${color},${a})`);
    gg.addColorStop(1, `rgba(${color},0)`);
    return gg;
  });
  g.fillStyle = grd;
  g.beginPath(); g.arc(0, 0, r, 0, Math.PI * 2); g.fill();
}

// ─────────────────────────────────────────────────────────
// 1. 干电池
// ─────────────────────────────────────────────────────────
class Battery extends Entity {
  circuitBranch() { return { type: 'V', emf: this.props.emf, r: Math.max(0.01, this.props.internalR) }; }
  render(g) {
    const { w, h } = this;
    const broken = dmg.of(this);
    leads(g, this);
    gfx.fillRR(g, -w / 2, -h / 2, w, h, 5, broken ? '#242a30' : '#2b333b');
    gfx.strokeRR(g, -w / 2, -h / 2, w, h, 5, broken ? '#5b4b3f' : '#3d4852', 1.5);
    gfx.fillRR(g, w / 2 - 2, -7, 5, 14, 2, broken ? '#7d858d' : '#b9c4cd');
    gfx.text(g, this.props.emf.toFixed(1) + ' V', 0, -6, { color: broken ? DIM : HOT, size: 12.5, weight: '600' });
    gfx.text(g, '−', -w / 2 + 10, 5, { color: DIM, size: 13 });
    gfx.text(g, '+', w / 2 - 12, 5, { color: broken ? DIM : HOT, size: 13 });

    if (!broken) return;
    // 损坏：内部气体把外壳顶出鼓包，顶盖裂开并留下焦痕
    const next = dmg.rand(this, 1);
    const bx = (next() - 0.5) * w * 0.44;
    const bump = 6 + next() * 4;
    g.beginPath();
    g.moveTo(bx - 15, -h / 2 + 1);
    g.quadraticCurveTo(bx, -h / 2 - bump * 2, bx + 15, -h / 2 + 1);
    g.closePath();
    g.fillStyle = '#242a30';
    g.fill();
    g.strokeStyle = '#5b4b3f'; g.lineWidth = 1.4; g.stroke();
    // 裂纹与焦痕只留在鼓包的外壳上，不飞到半空
    g.save();
    gfx.rr(g, -w / 2 - 2, -h / 2 - bump - 1, w + 4, h + bump + 3, 5);
    g.clip();
    dmg.cracks(g, bx, -h / 2 + 4, 3, h * 0.62, next);
    dmg.soot(g, bx, -h / 2 + 6, 7, dmg.rand(this, 2), 1);
    g.restore();
  }
}
const batteryDef = {
  type: 'battery', name: '干电池', domain: PH, cat: '电源', icon: '🔋',
  desc: '直流电源，电动势与内阻可调', w: 86, h: 42,
  ports: [{ x: -48, y: 0, label: '−', kind: 'wire' }, { x: 48, y: 0, label: '+', kind: 'wire' }],
  defaults: { emf: 1.5, internalR: 0.5 },
  tags: ['电源', '电池'],
  fields: [
    { k: 'emf', label: '电动势', type: 'range', min: 1.5, max: 12, step: 0.5, unit: 'V' },
    { k: 'internalR', label: '内阻', type: 'range', min: 0.05, max: 5, step: 0.05, unit: 'Ω' },
  ],
  create: (x, y) => new Battery(batteryDef, x, y),
};
DEFS.push(() => define(batteryDef));

// ─────────────────────────────────────────────────────────
// 2. 开关
// ─────────────────────────────────────────────────────────
class Switch extends Entity {
  circuitBranch() { return this.props.closed ? { type: 'R', r: 0.01 } : { type: 'open' }; }
  toggle() { this.props.closed = !this.props.closed; }
  render(g) {
    const { w, h } = this;
    leads(g, this);
    gfx.fillRR(g, -w / 2, -h / 2, w, h, 6, '#232b33');
    gfx.strokeRR(g, -w / 2, -h / 2, w, h, 6, EDGE, 1.5);
    const ax = -w / 2 + 15, bx = w / 2 - 15;
    gfx.fillRR(g, ax - 3, -5, 6, 10, 1.5, '#b9c4cd');
    gfx.fillRR(g, bx - 3, -5, 6, 10, 1.5, '#b9c4cd');
    g.strokeStyle = this.props.closed ? OK : '#7d8b99';
    g.lineWidth = 3; g.lineCap = 'round';
    g.beginPath();
    if (this.props.closed) { g.moveTo(ax, 0); g.lineTo(bx, 0); }
    else { g.moveTo(ax, 0); g.lineTo(bx - 7, -14); }
    g.stroke();
    gfx.text(g, this.props.closed ? '闭合' : '断开', 0, h / 2 - 9,
      { color: this.props.closed ? OK : DIM, size: 10 });
  }
}
const switchDef = {
  type: 'switch', name: '开关', domain: PH, cat: '电路控制', icon: '⏻',
  desc: '点击切换通断', w: 76, h: 38,
  ports: [{ x: -44, y: 0, kind: 'wire' }, { x: 44, y: 0, kind: 'wire' }],
  defaults: { closed: false },
  tags: ['开关', '通断'],
  fields: [{ k: 'closed', label: '状态', type: 'checkbox', text: '闭合' }],
  create: (x, y) => new Switch(switchDef, x, y),
};
DEFS.push(() => define(switchDef));

// ─────────────────────────────────────────────────────────
// 3. 小灯泡（钨丝非线性电阻）
// ─────────────────────────────────────────────────────────
class Lamp extends Entity {
  circuitBranch() { return { type: 'R', r: this.resistanceAt(0) }; }
  resistanceAt(U) {
    const ratedV = this.props.ratedV, ratedP = this.props.ratedP;
    const R_hot = (ratedV * ratedV) / ratedP;
    const R_cold = R_hot / 10;
    const u = Math.abs(U);
    const R_now = Math.max(R_cold, Math.min(R_hot * 3, u * u / ratedP + R_cold));
    const k = Math.min(1, Math.pow(R_now / R_hot, 0.45));
    return R_cold + (R_hot - R_cold) * k;
  }
  render(g) {
    const r = this.h / 2 - 3;
    const broken = dmg.of(this);
    leads(g, this);
    // 螺口
    gfx.fillRR(g, -8, r - 6, 16, 12, 2, broken ? '#5f666d' : '#8d96a0');
    const P = Math.abs(this.state.P || 0);
    const bright = broken ? 0 : Math.min(1, P / this.props.ratedP);
    glow(g, this, bright * 0.9, '255,220,140');
    // 玻璃泡
    g.beginPath(); g.arc(0, -3, r, 0, Math.PI * 2);
    g.fillStyle = broken ? 'rgba(58,62,68,.55)'
      : bright > 0.05 ? `rgba(255,225,150,${0.16 + bright * 0.55})` : 'rgba(190,215,235,.09)';
    g.fill();
    g.strokeStyle = broken ? 'rgba(122,132,142,.75)'
      : bright > 0.05 ? `rgba(255,220,140,${0.5 + bright * 0.5})` : EDGE;
    g.lineWidth = 1.5; g.stroke();
    if (broken) {
      // 熏黑的玻璃 + 断口焦痕（全部由 id 决定，帧间完全一致）
      g.save();
      g.beginPath(); g.arc(0, -3, r - 0.8, 0, Math.PI * 2); g.clip();
      dmg.soot(g, 0, -5, r * 0.7, dmg.rand(this, 1), 1);
      const next = dmg.rand(this, 2);
      dmg.cracks(g, (next() - 0.5) * r * 0.4, -3 + (next() - 0.5) * r * 0.4, 3, r * 0.95, next);
      g.restore();
    }
    // 灯丝：烧断后从中段断开、垂落，钨丝发黑（画在裂纹之上，断口才看得见）
    g.strokeStyle = broken ? '#4c545c' : bright > 0.05 ? '#fff0c0' : '#6b7885';
    g.lineWidth = 1.4; g.lineCap = 'round';
    g.beginPath();
    if (broken) {
      g.moveTo(-6, 2); g.lineTo(-3, -6); g.lineTo(-0.9, -0.3);
      g.moveTo(6, 2); g.lineTo(3, -6); g.lineTo(1.5, 1.3);
    } else {
      g.moveTo(-6, 2); g.lineTo(-3, -6); g.lineTo(0, 2); g.lineTo(3, -6); g.lineTo(6, 2);
    }
    g.stroke();
    gfx.text(g, this.props.ratedV + 'V ' + this.props.ratedP + 'W', 0, r + 12,
      { color: broken ? '#6b7885' : DIM, size: 9.5 });
  }
}
const lampDef = {
  type: 'lamp', name: '小灯泡', domain: PH, cat: '用电器', icon: '💡',
  desc: '钨丝灯泡，电阻随温度变化', w: 46, h: 52,
  ports: [{ x: -32, y: 8, kind: 'wire' }, { x: 32, y: 8, kind: 'wire' }],
  defaults: { ratedV: 3.8, ratedP: 0.75 },
  tags: ['灯泡', '用电器', '发光'],
  fields: [
    { k: 'ratedV', label: '额定电压', type: 'range', min: 1.5, max: 12, step: 0.1, unit: 'V' },
    { k: 'ratedP', label: '额定功率', type: 'range', min: 0.1, max: 5, step: 0.05, unit: 'W' },
  ],
  create: (x, y) => new Lamp(lampDef, x, y),
};
DEFS.push(() => define(lampDef));

// ─────────────────────────────────────────────────────────
// 4. 定值电阻
// ─────────────────────────────────────────────────────────
class Resistor extends Entity {
  circuitBranch() { return { type: 'R', r: Math.max(0.01, this.props.resistance) }; }
  render(g) {
    const { w, h } = this;
    leads(g, this);
    const bw = w * 0.62;
    gfx.fillRR(g, -bw / 2, -h / 2 + 3, bw, h - 6, 4, '#2f3742');
    gfx.strokeRR(g, -bw / 2, -h / 2 + 3, bw, h - 6, 4, EDGE, 1.4);
    gfx.text(g, this.props.resistance + ' Ω', 0, 0, { color: TXT, size: 11.5 });
  }
}
const resistorDef = {
  type: 'resistor', name: '定值电阻', domain: PH, cat: '电阻', icon: '▭',
  desc: '阻值可调的标准电阻', w: 80, h: 32,
  ports: [{ x: -45, y: 0, kind: 'wire' }, { x: 45, y: 0, kind: 'wire' }],
  defaults: { resistance: 10 },
  tags: ['电阻'],
  fields: [{ k: 'resistance', label: '阻值', type: 'range', min: 1, max: 200, step: 1, unit: 'Ω' }],
  create: (x, y) => new Resistor(resistorDef, x, y),
};
DEFS.push(() => define(resistorDef));

// ─────────────────────────────────────────────────────────
// 5. 滑动变阻器
// ─────────────────────────────────────────────────────────
class Rheostat extends Entity {
  circuitBranch() {
    const r = Math.max(0.05, this.props.rMax * Math.min(1, Math.max(0, this.props.pos)));
    return { type: 'R', r };
  }
  render(g) {
    const { w, h } = this;
    leads(g, this);
    const bw = w * 0.72;
    gfx.fillRR(g, -bw / 2, -6, bw, 24, 4, '#2f3742');
    gfx.strokeRR(g, -bw / 2, -6, bw, 24, 4, EDGE, 1.4);
    // 线圈
    g.strokeStyle = '#6b7885'; g.lineWidth = 1.4;
    for (let i = 0; i < 14; i++) {
      const x = -bw / 2 + 6 + i * ((bw - 12) / 13);
      g.beginPath(); g.moveTo(x, -6); g.lineTo(x, 18); g.stroke();
    }
    // 滑片
    const sx = -bw / 2 + 6 + (bw - 12) * this.props.pos;
    gfx.fillRR(g, sx - 5, -18, 10, 13, 2, '#b9c4cd');
    g.strokeStyle = '#b9c4cd'; g.lineWidth = 2.5;
    g.beginPath(); g.moveTo(sx, -18); g.lineTo(sx, -h / 2 + 2); g.stroke();
    gfx.text(g, Math.round(this.props.rMax * this.props.pos) + ' / ' + this.props.rMax + ' Ω',
      0, h / 2 - 1, { color: DIM, size: 9.5 });
  }
}
const rheostatDef = {
  type: 'rheostat', name: '滑动变阻器', domain: PH, cat: '电阻', icon: '🎚',
  desc: '连续改变接入电路的阻值', w: 106, h: 50,
  ports: [{ x: -58, y: 0, kind: 'wire' }, { x: 58, y: 0, kind: 'wire' }],
  defaults: { rMax: 50, pos: 0.5 },
  tags: ['变阻器', '电阻'],
  fields: [
    { k: 'rMax', label: '最大阻值', type: 'range', min: 5, max: 200, step: 5, unit: 'Ω' },
    { k: 'pos', label: '滑片位置', type: 'range', min: 0, max: 1, step: 0.01 },
  ],
  create: (x, y) => new Rheostat(rheostatDef, x, y),
};
DEFS.push(() => define(rheostatDef));

// ─────────────────────────────────────────────────────────
// 6/7. 电流表 · 电压表
// ─────────────────────────────────────────────────────────
class Meter extends Entity {
  circuitBranch() { return { type: 'R', r: this.props.mode === 'A' ? 0.05 : 1e6 }; }
  render(g) {
    const { w, h } = this;
    const r = Math.min(w, h) / 2 - 6;
    const broken = dmg.of(this);
    leads(g, this);
    g.beginPath(); g.arc(0, 0, r + 4, 0, Math.PI * 2);
    gfx.fillRR(g, -w / 2, -h / 2, w, h, 8, PANEL);
    gfx.strokeRR(g, -w / 2, -h / 2, w, h, 8, broken ? '#5b4b3f' : EDGE, 1.5);
    // 表盘弧
    g.beginPath(); g.arc(0, 4, r - 5, Math.PI * 1.15, Math.PI * 1.85);
    g.strokeStyle = broken ? '#3a3f45' : '#4a5560'; g.lineWidth = 1.4; g.stroke();
    // 指针：烧毁的表头指针打到满量程卡死，不再随电流摆动
    const isA = this.props.mode === 'A';
    const val = isA ? (this.state.I || 0) : (this.state.U || 0);
    const full = this.props.fullScale;
    const frac = broken ? 1 : Math.max(-1, Math.min(1, val / full));
    const ang = -Math.PI / 2 + frac * Math.PI * 0.62;
    g.save();
    g.translate(0, 4); g.rotate(ang);
    g.strokeStyle = broken ? '#aab4bd' : frac === 0 ? '#8d96a0' : HOT;
    g.lineWidth = 1.8; g.lineCap = 'round';
    g.beginPath(); g.moveTo(0, 2); g.lineTo(0, -(r - 7)); g.stroke();
    g.restore();
    g.beginPath(); g.arc(0, 4, 2.6, 0, Math.PI * 2); g.fillStyle = '#b9c4cd'; g.fill();
    // 字母
    gfx.text(g, isA ? 'A' : 'V', 0, -r + 2,
      { color: broken ? '#6b7885' : isA ? '#7fe8d8' : '#c3aaff', size: 12, weight: '700' });
    if (!broken) return;
    // 损坏：表头烧黑 + 面板玻璃炸裂
    dmg.soot(g, 0, 4, r * 0.95, dmg.rand(this, 1), 1.15);
    g.save();
    gfx.rr(g, -w / 2, -h / 2, w, h, 8); g.clip();
    const next = dmg.rand(this, 2);
    dmg.cracks(g, (next() - 0.5) * w * 0.3, 4 + (next() - 0.5) * h * 0.3, 4, Math.min(w, h) * 0.7, next);
    g.restore();
  }
}
const ammeterDef = {
  type: 'ammeter', name: '电流表', domain: PH, cat: '测量仪表', icon: '🅐',
  desc: '串联接入，测支路电流', w: 62, h: 62,
  ports: [{ x: -40, y: 0, kind: 'wire' }, { x: 40, y: 0, kind: 'wire' }],
  defaults: { mode: 'A', fullScale: 0.6 },
  tags: ['电流表', '电表', '测量'],
  fields: [{ k: 'fullScale', label: '量程', type: 'range', min: 0.1, max: 3, step: 0.1, unit: 'A' }],
  create: (x, y) => new Meter(ammeterDef, x, y),
};
DEFS.push(() => define(ammeterDef));

const voltmeterDef = {
  type: 'voltmeter', name: '电压表', domain: PH, cat: '测量仪表', icon: '🅥',
  desc: '并联接入，测两点电压', w: 62, h: 62,
  ports: [{ x: -40, y: 0, kind: 'wire' }, { x: 40, y: 0, kind: 'wire' }],
  defaults: { mode: 'V', fullScale: 15 },
  tags: ['电压表', '电表', '测量'],
  fields: [{ k: 'fullScale', label: '量程', type: 'range', min: 1, max: 30, step: 1, unit: 'V' }],
  create: (x, y) => new Meter(voltmeterDef, x, y),
};
DEFS.push(() => define(voltmeterDef));

// ─────────────────────────────────────────────────────────
// 8. 热敏电阻（← 化学域温度驱动）
// ─────────────────────────────────────────────────────────
class Thermistor extends Entity {
  /** 阻值由自身温度决定（温度由耦合总线写入 state.temp），这就是闭环的落点 */
  circuitBranch() { return { type: 'R', r: this.resistanceNow() }; }
  resistanceAt() { return this.resistanceNow(); }
  resistanceNow() {
    const T = (this.state.temp ?? 25) + 273.15;
    const T0 = 298.15;
    const R = this.props.r25 * Math.exp(this.props.B * (1 / T - 1 / T0));
    return Math.max(1, Math.min(1e6, R));
  }
  render(g) {
    const { w, h } = this;
    leads(g, this);
    plate(g, this, 5);
    const T = this.state.temp ?? 25;
    const hot = Math.max(0, Math.min(1, (T - 20) / 80));
    const col = `rgb(${Math.round(90 + hot * 165)},${Math.round(180 - hot * 90)},${Math.round(200 - hot * 130)})`;
    gfx.fillRR(g, -w / 2 + 8, -4, w - 16, 8, 3, 'rgba(0,0,0,.35)');
    gfx.fillRR(g, -w / 2 + 8, -4, (w - 16) * hot, 8, 3, col);
    gfx.text(g, Math.round(T) + '°C', 0, -h / 2 + 10, { color: col, size: 10.5 });
    gfx.text(g, Math.round(this.resistanceNow()) + ' Ω', 0, h / 2 - 9, { color: DIM, size: 10 });
  }
}
const thermistorDef = {
  type: 'thermistor', name: '热敏电阻', domain: PH, cat: '电阻', icon: '🌡',
  desc: 'NTC：温度升高，阻值下降', w: 76, h: 44,
  ports: [{ x: -46, y: 0, kind: 'wire' }, { x: 46, y: 0, kind: 'wire' }],
  defaults: { r25: 100, B: 3500 },
  state: { temp: 25 },
  tags: ['热敏', '温度', '传感器', '耦合'],
  fields: [
    { k: 'r25', label: '25°C 阻值', type: 'range', min: 10, max: 1000, step: 10, unit: 'Ω' },
    { k: 'B', label: 'B 值', type: 'range', min: 1000, max: 5000, step: 100, unit: 'K' },
  ],
  create: (x, y) => new Thermistor(thermistorDef, x, y),
};
DEFS.push(() => define(thermistorDef));

// ─────────────────────────────────────────────────────────
// 9. 电热丝（→ 加热化学容器）
// ─────────────────────────────────────────────────────────
class Heater extends Entity {
  probe = { kind: 'heater' };
  circuitBranch() { return { type: 'R', r: Math.max(0.5, this.props.resistance) }; }
  render(g) {
    const { w, h } = this;
    const broken = dmg.of(this);
    leads(g, this);
    const P = Math.abs(this.state.P || 0);
    const hot = broken ? 0 : Math.min(1, P / Math.max(0.2, this.props.maxP));
    glow(g, this, hot, '255,120,80');
    // 陶瓷座
    gfx.fillRR(g, -w / 2, -h / 2, w * 0.3, h, 4, broken ? '#2f3339' : '#39434d');
    gfx.fillRR(g, w / 2 - w * 0.3, -h / 2, w * 0.3, h, 4, broken ? '#2f3339' : '#39434d');
    // 波浪电阻丝
    const x0 = -w * 0.2, x1 = w * 0.2, n = 6;
    g.lineWidth = 2.4; g.lineCap = 'round';
    if (broken) {
      // 熔断：丝从中间断开、两端垂落，金属氧化发黑，不再发红
      g.strokeStyle = '#6b7079';
      const half = (a, b) => {
        g.beginPath();
        for (let i = a; i <= b; i++) {
          const x = x0 + (x1 - x0) * i / n;
          const y = (i % 2 === 0) ? -6 : 6;
          i === a ? g.moveTo(x, y) : g.lineTo(x, y);
        }
        g.stroke();
        const xe = x0 + (x1 - x0) * b / n;
        g.beginPath();
        g.moveTo(xe, (b % 2 === 0) ? -6 : 6);
        g.lineTo(xe + 3, 3); g.stroke();
      };
      half(0, 2);
      half(4, 6);
      dmg.soot(g, x0 + (x1 - x0) * 0.5, 0, 9, dmg.rand(this, 1), 1);
    } else {
      g.strokeStyle = hot > 0.05 ? `rgba(255,${Math.round(190 - hot * 130)},90,1)` : '#8d96a0';
      g.beginPath();
      for (let i = 0; i <= n; i++) {
        const x = x0 + (x1 - x0) * i / n;
        const y = (i % 2 === 0) ? -6 : 6;
        i === 0 ? g.moveTo(x, y) : g.lineTo(x, y);
      }
      g.stroke();
    }
    gfx.text(g, P.toFixed(2) + ' W', 0, h / 2 + 12, { color: hot > 0.05 ? '#ffb07a' : DIM, size: 10 });
  }
}
const heaterDef = {
  type: 'heater', name: '电热丝', domain: PH, cat: '用电器', icon: '♨',
  desc: '通电发热，可浸入液体加热', w: 90, h: 36,
  ports: [{ x: -52, y: 0, kind: 'wire' }, { x: 52, y: 0, kind: 'wire' }],
  defaults: { resistance: 10, maxP: 20 },
  tags: ['电热', '加热', '耦合'],
  fields: [
    { k: 'resistance', label: '阻值', type: 'range', min: 1, max: 100, step: 1, unit: 'Ω' },
    { k: 'maxP', label: '额定功率', type: 'range', min: 1, max: 100, step: 1, unit: 'W' },
  ],
  create: (x, y) => new Heater(heaterDef, x, y),
};
DEFS.push(() => define(heaterDef));

// ─────────────────────────────────────────────────────────
// 10. 电动机（→ 驱动搅拌）
// ─────────────────────────────────────────────────────────
class Motor extends Entity {
  circuitBranch() { return { type: 'R', r: Math.max(1, this.props.resistance) }; }
  step(dt) {
    const I = Math.abs(this.state.I || 0);
    const on = I > 0.02;
    this.state.on = on;
    const w = on ? Math.min(30, I * 40) : 0;
    this.state.omega = w;
    this.state.angle = (this.state.angle || 0) + w * dt;
  }
  render(g) {
    const { w } = this;
    const r = w / 2 - 6;
    const broken = dmg.of(this);
    leads(g, this);
    plate(g, this, 8);
    const on = !broken && this.state.on;
    g.save();
    g.translate(0, 0); g.rotate(this.state.angle || 0);
    g.strokeStyle = broken ? '#5f666d' : on ? '#7fe8d8' : '#5a6672';
    g.lineWidth = 2.4; g.lineCap = 'round';
    for (let i = 0; i < 3; i++) {
      g.save(); g.rotate(i * Math.PI * 2 / 3);
      g.beginPath(); g.moveTo(0, 0); g.lineTo(0, -(r - 4)); g.stroke();
      g.restore();
    }
    g.restore();
    g.beginPath(); g.arc(0, 0, 3, 0, Math.PI * 2);
    g.fillStyle = broken ? '#5f666d' : on ? '#7fe8d8' : '#5a6672'; g.fill();
    if (broken) {
      // 烧毁：转子卡死在当前角度（仿真已把电流归零），线圈周围留下焦痕与喷痕
      const next = dmg.rand(this, 1);
      dmg.soot(g, 0, 0, r * 0.55, dmg.rand(this, 2), 1);
      g.strokeStyle = 'rgba(26,20,16,.5)';
      g.lineWidth = 2.2; g.lineCap = 'round';
      for (let i = 0; i < 4; i++) {
        const a = next() * Math.PI * 2;
        const l = r * (0.55 + next() * 0.55);
        g.beginPath();
        g.moveTo(Math.cos(a) * r * 0.34, Math.sin(a) * r * 0.34);
        g.lineTo(Math.cos(a + 0.22) * l, Math.sin(a + 0.22) * l);
        g.stroke();
      }
    }
    gfx.text(g, 'M', 0, h0(this), { color: broken ? '#6b7885' : DIM, size: 10 });
  }
}
function h0(e) { return e.h / 2 - 8; }
const motorDef = {
  type: 'motor', name: '电动机', domain: PH, cat: '用电器', icon: '⚙',
  desc: '通电转动，可带动搅拌器', w: 64, h: 64,
  ports: [{ x: -42, y: 0, kind: 'wire' }, { x: 42, y: 0, kind: 'wire' }],
  defaults: { resistance: 8, ratedI: 0.6 },
  tags: ['电动机', '搅拌', '耦合'],
  fields: [
    { k: 'resistance', label: '线圈电阻', type: 'range', min: 1, max: 50, step: 1, unit: 'Ω' },
    { k: 'ratedI', label: '额定电流', type: 'range', min: 0.05, max: 3, step: 0.05, unit: 'A' },
  ],
  create: (x, y) => new Motor(motorDef, x, y),
};
DEFS.push(() => define(motorDef));

export { Battery, Switch, Lamp, Resistor, Rheostat, Meter, Thermistor, Heater, Motor };

// ── 插件 ──────────────────────────────────────────────────
export default {
  id: 'xiaomo.equipment.electrical',
  name: '电学器材',
  version: '1.0.0',
  kind: 'equipment',
  domain: 'physics',
  desc: '电源、开关、灯泡、定值电阻、滑动变阻器、电流表、电压表、热敏电阻、电热丝、电动机',
  author: '小墨实验室',
  builtin: true,
  tags: ['物理', '电学', '电路'],
  setup(ctx) { ctx.scope('equipment', () => DEFS.forEach(f => f())); },
};
