const DEFS = [];
// ══════════════════════════════════════════════════════════
// 化学域 · 电极、传感器、天平与试剂瓶
//
// 电极是理化两域最直接的接口：它一端有接线柱（插进电路），
// 另一端浸在溶液里（插进容器）。耦合总线把这两端接起来，
// 于是「杯子里的液体」就成了电路中的一条支路。
// ══════════════════════════════════════════════════════════

import { Entity, gfx, grad1 } from '../core/entity.js';
import { define } from './registry.js';
import { SP } from '../chemistry/species.js';

const CH = 'chemistry';

/** 把颜色整体调暗/调亮，用于给棒状器材做立体渐变 */
function shade(c, k) {
  const hex = /^#([0-9a-f]{6})$/i.exec(c);
  if (hex) {
    const n = parseInt(hex[1], 16);
    const f = (v) => Math.max(0, Math.min(255, Math.round(v * k)));
    return `rgb(${f((n >> 16) & 255)},${f((n >> 8) & 255)},${f(n & 255)})`;
  }
  const rgb = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(c);
  if (rgb) return `rgb(${Math.round(+rgb[1] * k)},${Math.round(+rgb[2] * k)},${Math.round(+rgb[3] * k)})`;
  return c;
}

const METAL_COLOR = {
  graphite: '#454b52', Zn: '#b8c0c6', Cu: '#b87333', Fe: '#8e9296',
  Mg: '#c4c9ce', Al: '#c0c5ca', Ag: '#e2e2e4',
};
const METAL_NAME = {
  graphite: '石墨', Zn: '锌', Cu: '铜', Fe: '铁', Mg: '镁', Al: '铝', Ag: '银',
};

// ─────────────────────────────────────────────────────────
// 电极
// ─────────────────────────────────────────────────────────
class Electrode extends Entity {
  constructor(def, x, y) {
    super(def, x, y);
    this.syncProbe();
  }
  syncProbe() {
    const m = this.props.metal;
    const e0 = (m === 'graphite') ? null : (SP[m] ? SP[m].E0 : null);
    this.probe = { kind: 'electrode', metal: m, E0: e0 };
  }
  onProp(k, v) { if (k === 'metal') this.syncProbe(); }

  render(g) {
    const { w, h } = this;
    const m = this.props.metal;
    const col = METAL_COLOR[m] || '#9aa4ad';

    // 电极棒（渐变只由金属颜色决定，按颜色缓存）
    const grd = grad1(this, '_gRod', g, col, () => {
      const gg = g.createLinearGradient(-5, 0, 5, 0);
      gg.addColorStop(0, shade(col, 0.7));
      gg.addColorStop(0.45, col);
      gg.addColorStop(1, shade(col, 0.6));
      return gg;
    });
    gfx.fillRR(g, -5, -h / 2 + 12, 10, h - 20, 3, grd);
    gfx.strokeRR(g, -5, -h / 2 + 12, 10, h - 20, 3, 'rgba(235,248,255,.34)', 1.1);

    // 顶端接线帽
    gfx.fillRR(g, -8, -h / 2, 16, 12, 3, '#8d96a0');
    gfx.strokeRR(g, -8, -h / 2, 16, 12, 3, '#aab4bd', 1.2);

    gfx.text(g, METAL_NAME[m] || m, 0, h / 2 - 6, { color: '#8d96a0', size: 9.5 });
  }
}
const electrodeDef = {
  type: 'electrode', name: '电极', domain: CH, cat: '电化学', icon: '⚡',
  desc: '插入溶液导电；不同金属可组成原电池', w: 40, h: 108,
  ports: [{ x: 0, y: -54, kind: 'wire', label: '接线柱' }],
  defaults: { metal: 'graphite' },
  tags: ['电极', '电解', '原电池', '耦合'],
  fields: [{
    k: 'metal', label: '电极材料', type: 'select',
    options: [
      ['graphite', '石墨（惰性）'], ['Zn', '锌片'], ['Cu', '铜片'],
      ['Fe', '铁片'], ['Mg', '镁条'], ['Al', '铝片'], ['Ag', '银片'],
    ],
  }],
  create: (x, y) => new Electrode(electrodeDef, x, y),
};
DEFS.push(() => define(electrodeDef));

// ─────────────────────────────────────────────────────────
// 温度计
// ─────────────────────────────────────────────────────────
class Thermometer extends Entity {
  probe = { kind: 'thermometer' };
  render(g) {
    const { w, h } = this;
    const t = this.state.temp ?? 25;
    const frac = Math.max(0, Math.min(1, (t - 0) / 110));
    const colH = (h - 34) * frac;

    // 玻璃管
    gfx.fillRR(g, -safew(w, 5), -h / 2, safew(w, 10), h - 16, 5, 'rgba(196,220,236,.18)');
    gfx.strokeRR(g, -safew(w, 5), -h / 2, safew(w, 10), h - 16, 5, 'rgba(196,220,236,.45)', 1.2);

    // 液柱
    const c = t > 80 ? '#ff6b5c' : t > 50 ? '#ff9a4a' : '#e8574a';
    gfx.fillRR(g, -2.5, h / 2 - 12 - colH, 5, colH, 2.5, c);

    // 球泡
    g.beginPath(); g.arc(0, h / 2 - 9, 7, 0, Math.PI * 2);
    g.fillStyle = c; g.fill();

    // 刻度
    g.strokeStyle = 'rgba(196,220,236,.28)'; g.lineWidth = 1;
    for (let i = 1; i <= 5; i++) {
      const y = -h / 2 + 6 + (h - 34) * (1 - i / 6);
      g.beginPath(); g.moveTo(6, y); g.lineTo(11, y); g.stroke();
    }

    gfx.text(g, t.toFixed(1) + '℃', 0, -h / 2 - 9, { color: c, size: 11, weight: '600' });
  }
}
function safew(w, v) { return Math.min(v, w / 2); }
const thermoDef = {
  type: 'thermometer', name: '温度计', domain: CH, cat: '测量', icon: '🌡',
  desc: '插入液体读温度（也会影响热敏电阻）', w: 26, h: 130,
  ports: [],
  defaults: {},
  state: { temp: 25 },
  tags: ['温度计', '测量', '耦合'],
  fields: [],
  create: (x, y) => new Thermometer(thermoDef, x, y),
};
DEFS.push(() => define(thermoDef));

// ─────────────────────────────────────────────────────────
// pH 计
// ─────────────────────────────────────────────────────────
class PHMeter extends Entity {
  probe = { kind: 'ph' };
  render(g) {
    const { w, h } = this;
    const ph = this.state.pH ?? 7;
    gfx.fillRR(g, -w / 2, -h / 2, w, h * 0.62, 6, '#1b232b');
    gfx.strokeRR(g, -w / 2, -h / 2, w, h * 0.62, 6, '#39434d', 1.4);

    // 屏幕
    const col = ph < 6 ? '#ff7a6b' : ph > 8 ? '#6ba8ff' : '#7fe8d8';
    gfx.fillRR(g, -w / 2 + 6, -h / 2 + 6, w - 12, h * 0.3, 4, '#0a0f14');
    gfx.text(g, 'pH ' + ph.toFixed(2), 0, -h / 2 + 6 + h * 0.15, { color: col, size: 13, weight: '600' });

    // 探棒
    gfx.fillRR(g, -4, h * 0.1, 8, h * 0.42, 3, 'rgba(196,220,236,.3)');
    gfx.strokeRR(g, -4, h * 0.1, 8, h * 0.42, 3, 'rgba(196,220,236,.5)', 1.1);
    gfx.text(g, 'pH计', 0, h / 2 - 5, { color: '#5c6672', size: 9 });
  }
}
const phDef = {
  type: 'phmeter', name: 'pH 计', domain: CH, cat: '测量', icon: '🧫',
  desc: '插入溶液实时测 pH', w: 60, h: 104,
  ports: [],
  defaults: {},
  state: { pH: 7 },
  tags: ['pH', '测量', '酸碱'],
  fields: [],
  create: (x, y) => new PHMeter(phDef, x, y),
};
DEFS.push(() => define(phDef));

// ─────────────────────────────────────────────────────────
// 玻璃棒（搅拌）
// ─────────────────────────────────────────────────────────
class GlassRod extends Entity {
  probe = { kind: 'stirrer' };
  step(dt) {
    if (!this.props.stirring) { this.state.on = false; return; }
    this.state.on = true;
    this.state.phase = (this.state.phase || 0) + dt * 14;
  }
  render(g) {
    const { w, h } = this;
    const ang = this.props.stirring ? Math.sin(this.state.phase || 0) * 0.12 : 0;
    g.save();
    g.rotate(ang);
    gfx.fillRR(g, -3.5, -h / 2, 7, h - 6, 3.5, 'rgba(210,235,248,.42)');
    gfx.strokeRR(g, -3.5, -h / 2, 7, h - 6, 3.5, 'rgba(235,248,255,.6)', 1.2);
    g.restore();
    gfx.text(g, this.props.stirring ? '搅拌中' : '玻璃棒', 0, h / 2 - 2,
      { color: this.props.stirring ? '#7fe8d8' : '#5c6672', size: 9 });
  }
}
const rodDef = {
  type: 'glassrod', name: '玻璃棒', domain: CH, cat: '工具', icon: '🥢',
  desc: '搅拌可加快溶解与反应', w: 20, h: 120,
  ports: [],
  defaults: { stirring: false },
  state: { on: false },
  tags: ['玻璃棒', '搅拌', '工具'],
  fields: [{ k: 'stirring', label: '搅拌', type: 'checkbox', text: '持续搅拌' }],
  create: (x, y) => new GlassRod(rodDef, x, y),
};
DEFS.push(() => define(rodDef));

// ─────────────────────────────────────────────────────────
// 天平
// ─────────────────────────────────────────────────────────
class Balance extends Entity {
  render(g) {
    const { w, h } = this;
    gfx.fillRR(g, -w / 2, -h * 0.1, w, h * 0.6, 6, '#242c34');
    gfx.strokeRR(g, -w / 2, -h * 0.1, w, h * 0.6, 6, '#39434d', 1.4);
    // 秤盘
    gfx.fillRR(g, -w * 0.36, -h * 0.22, w * 0.72, 10, 3, '#8d96a0');
    gfx.fillRR(g, -w * 0.3, -h * 0.16, w * 0.6, 5, 2, '#6b7885');
    // 读数
    gfx.fillRR(g, -w * 0.3, h * 0.14, w * 0.6, h * 0.22, 4, '#0a0f14');
    const m = this.state.mass || 0;
    gfx.text(g, m.toFixed(2) + ' g', 0, h * 0.14 + h * 0.11,
      { color: m > 0 ? '#7fe8d8' : '#5c6672', size: 13, weight: '600' });
    gfx.text(g, '电子天平', 0, h * 0.5 + 6, { color: '#5c6672', size: 9 });
    if (this.state.onPlate) {
      gfx.text(g, this.state.onPlate, 0, -h * 0.42, { color: '#8d96a0', size: 9.5 });
    }
  }
}
const balanceDef = {
  type: 'balance', name: '电子天平', domain: CH, cat: '测量', icon: '⚖',
  desc: '把容器放到秤盘上称质量', w: 116, h: 78,
  ports: [],
  defaults: {},
  state: { mass: 0 },
  tags: ['天平', '质量', '测量', '守恒'],
  fields: [],
  create: (x, y) => new Balance(balanceDef, x, y),
};
DEFS.push(() => define(balanceDef));

// ─────────────────────────────────────────────────────────
// pH 试纸
// ─────────────────────────────────────────────────────────
class PHPaper extends Entity {
  render(g) {
    const { w, h } = this;
    const ph = this.state.pH;
    gfx.fillRR(g, -w / 2, -h / 2, w, h, 3, '#e8e4d8');
    gfx.strokeRR(g, -w / 2, -h / 2, w, h, 3, '#b8b2a2', 1);
    if (ph !== undefined) {
      const c = ph < 3 ? '#e04a3a' : ph < 5 ? '#e8804a' : ph < 6 ? '#e8c44a'
        : ph < 8 ? '#8ac46a' : ph < 10 ? '#5a9ad8' : '#4a5ac8';
      gfx.fillRR(g, -w / 2 + 3, -h / 2 + 3, w * 0.34, h - 6, 2, c);
      gfx.text(g, 'pH ' + ph.toFixed(1), w * 0.1, 0, { color: '#3a3a38', size: 10, weight: '600' });
    } else {
      gfx.text(g, '未使用', 0, 0, { color: '#8a8478', size: 9.5 });
    }
  }
}
const paperDef = {
  type: 'phpaper', name: 'pH 试纸', domain: CH, cat: '测量', icon: '📄',
  desc: '拖到容器上浸取液体测酸碱度', w: 76, h: 34,
  ports: [],
  defaults: {},
  state: {},
  tags: ['pH试纸', '酸碱', '测量'],
  fields: [],
  create: (x, y) => new PHPaper(paperDef, x, y),
};
DEFS.push(() => define(paperDef));

// ─────────────────────────────────────────────────────────
// 试剂瓶 —— 由物质库自动生成
// ─────────────────────────────────────────────────────────
class Reagent extends Entity {
  render(g) {
    const { w, h } = this;
    const id = this.props.reagent;
    const s = SP[id] || {};
    const liquid = s.st === 'aq' || s.st === 'l';

    // 瓶身
    gfx.fillRR(g, -w / 2 + 4, -h / 2 + 14, w - 8, h - 20, 5, 'rgba(180,210,230,.16)');
    gfx.strokeRR(g, -w / 2 + 4, -h / 2 + 14, w - 8, h - 20, 5, 'rgba(196,220,236,.45)', 1.3);

    // 内容物
    const c = s.c ? `rgb(${s.c[0]},${s.c[1]},${s.c[2]})`
      : liquid ? 'rgba(120,190,215,.4)' : 'rgba(150,150,150,.55)';
    g.save();
    gfx.rr(g, -w / 2 + 5, -h / 2 + 15, w - 10, h - 22, 4);
    g.clip();
    g.fillStyle = c;
    if (liquid) g.fillRect(-w / 2, -h / 2 + h * 0.42, w, h);
    else g.fillRect(-w / 2, -h / 2 + h * 0.6, w, h * 0.4);
    g.restore();

    // 瓶盖
    gfx.fillRR(g, -w * 0.2, -h / 2 + 2, w * 0.4, 14, 3, '#5a6672');
    // 标签
    gfx.fillRR(g, -w / 2 + 8, -h * 0.02, w - 16, h * 0.28, 3, 'rgba(240,240,235,.88)');
    gfx.text(g, s.f || id, 0, h * 0.12, { color: '#2a2f35', size: 9.5, weight: '600' });
    gfx.text(g, s.n || id, 0, h / 2 - 4, { color: '#8d96a0', size: 8.5 });
  }
}

const LIQUIDS = [
  'HCl', 'H2SO4', 'HNO3', 'CH3COOH', 'NaOH', 'KOH', 'Ca(OH)2', 'NH3H2O',
  'CuSO4', 'CuCl2', 'FeSO4', 'FeCl3', 'KMnO4', 'NaCl', 'KCl', 'ZnSO4',
  'Na2SO4', 'Na2CO3', 'NaHCO3', 'AgNO3', 'BaCl2', 'H2O2', 'H2O',
];
const SOLIDS = ['Zn', 'Fe', 'Mg', 'Al', 'Cu', 'CuO', 'MnO2', 'CaO', 'CaCO3'];
const INDICATORS = ['Phenolphthalein', 'Litmus'];

function makeReagent(id, cat, icon) {
  const s = SP[id] || { n: id, f: id };
  const def = {
    type: 'reagent-' + id, name: s.n, domain: CH, cat, icon,
    desc: (cat === '液体药品' ? '液体试剂' : cat === '固体药品' ? '固体试剂' : '酸碱指示剂')
      + '：' + (s.f || id),
    w: 54, h: 78,
    ports: [],
    defaults: { reagent: id, dose: cat === '固体药品' ? 5 : 50 },
    tags: [s.f || id, cat, '试剂'],
    fields: [{
      k: 'dose', label: cat === '固体药品' ? '每次取用' : '每次取用',
      type: 'range', min: cat === '固体药品' ? 0.5 : 10,
      max: cat === '固体药品' ? 50 : 200,
      step: cat === '固体药品' ? 0.5 : 10,
      unit: cat === '固体药品' ? 'g' : 'mL',
    }],
    create: (x, y) => new Reagent(def, x, y),
  };
  DEFS.push(() => define(def));
}

for (const id of LIQUIDS) makeReagent(id, '液体药品', '🧴');
for (const id of SOLIDS) makeReagent(id, '固体药品', '🧱');
for (const id of INDICATORS) makeReagent(id, '酸碱指示剂', '🎨');

export { Electrode, Thermometer, PHMeter, GlassRod, Balance, PHPaper, Reagent };

// ── 插件 ──────────────────────────────────────────────────
export default {
  id: 'xiaomo.equipment.lab',
  name: '实验仪器与试剂',
  version: '1.0.0',
  kind: 'equipment',
  domain: 'chemistry',
  desc: '电极、温度计、pH 计、玻璃棒、天平、pH 试纸，以及由物质库自动生成的试剂瓶',
  author: '小墨实验室',
  builtin: true,
  tags: ['化学', '仪器', '试剂', '跨域'],
  setup(ctx) { ctx.scope('equipment', () => DEFS.forEach(f => f())); },
};
