const DEFS = [];
// ══════════════════════════════════════════════════════════
// 化学域 · 器皿（坩埚、废液缸）
//
// 两件都继承 glassware.js 的 Glassware —— 于是它们**白拿**既有全部机制：
//   · 可作「倾倒」源与目标（main.js doPour：目标只要 to.vessel）
//   · 可被酒精灯加热、可插温度计/pH 计（耦合总线按 insertZone 识别）
//   · 内容随场景存取（serializeState/deserializeState）
// 本文件只写各自的 innerPath / render，不新增任何契约。
// ══════════════════════════════════════════════════════════

import { Entity, gfx } from '../core/entity.js';
import { define } from './registry.js';
import { Glassware } from './glassware.js';
import { LIQUIDS } from './lab.js';
import { SP } from '../chemistry/species.js';

const CH = 'chemistry';
const CERAMIC = 'rgba(226,222,214,.92)';
const CERAMIC_DK = 'rgba(150,144,132,.95)';

// ─────────────────────────────────────────────────────────
// 坩埚 —— 耐高温的小容器，用来灼烧固体
// ─────────────────────────────────────────────────────────
class Crucible extends Glassware {
  geom() { const w = this.w * 0.78, h = this.h * 0.6; return { x: -w / 2, y: -this.h * 0.06, w, h }; }
  innerPath(g) {
    const { x, y, w, h } = this.geom();
    // 上宽下窄的碗形（局部坐标）
    g.beginPath();
    g.moveTo(x + 2, y);
    g.lineTo(x + w - 2, y);
    g.lineTo(x + w * 0.78, y + h);
    g.quadraticCurveTo(x + w * 0.5, y + h + 4, x + w * 0.22, y + h);
    g.closePath();
  }
  render(g) {
    this.drawContents(g);
    const { x, y, w, h } = this.geom();
    g.save();
    this.innerPath(g);
    g.fillStyle = 'rgba(238,235,228,.5)';
    g.fill();
    g.strokeStyle = CERAMIC;
    g.lineWidth = 3.2;
    g.stroke();
    g.restore();
    // 埚沿
    g.strokeStyle = CERAMIC_DK;
    g.lineWidth = 2.4;
    g.beginPath(); g.moveTo(x + 1, y); g.lineTo(x + w - 1, y); g.stroke();
    this.drawTemp(g);
  }
}
const crucibleDef = {
  type: 'crucible', name: '坩埚', domain: CH, cat: '容器', icon: '🥣',
  desc: '耐高温小容器，灼烧固体用', w: 62, h: 60,
  ports: [{ x: 0, y: -30, kind: 'probe', label: '插入口' }],
  defaults: { capacity: 30 },
  tags: ['坩埚', '容器', '耐高温', '灼烧'],
  fields: [{ k: 'capacity', label: '容积', type: 'range', min: 10, max: 60, step: 5, unit: 'mL' }],
  create: (x, y) => new Crucible(crucibleDef, x, y),
};
DEFS.push(() => define(crucibleDef));

// ─────────────────────────────────────────────────────────
// 废液缸 —— 倒废液的容器（它不需要新交互：倒出/倒入走既有 doPour）
// ─────────────────────────────────────────────────────────
class WasteJar extends Glassware {
  geom() { const w = this.w * 0.82, h = this.h * 0.68; return { x: -w / 2, y: -this.h * 0.04, w, h }; }
  innerPath(g) {
    const { x, y, w, h } = this.geom();
    gfx.rr(g, x, y, w, h, 4);
  }
  render(g) {
    this.drawContents(g);
    const { x, y, w, h } = this.geom();
    g.save();
    this.innerPath(g);
    g.strokeStyle = 'rgba(196,214,224,.6)';
    g.lineWidth = 2.2;
    g.stroke();
    g.restore();
    // 危险标识带
    g.fillStyle = 'rgba(226,178,74,.75)';
    g.fillRect(x + 1, y + h * 0.42, w - 2, 6);
    gfx.text(g, '废液', 0, y + h * 0.42 + 4.6, { color: '#3a2f18', size: 8, weight: '700' });
    this.drawDamage(g);
    this.drawTemp(g);
  }
}
const wasteJarDef = {
  type: 'wastejar', name: '废液缸', domain: CH, cat: '容器', icon: '🪣',
  desc: '收集废液，避免污染环境', w: 74, h: 84,
  ports: [{ x: 0, y: -42, kind: 'probe', label: '插入口' }],
  defaults: { capacity: 500 },
  tags: ['废液缸', '容器', '安全'],
  fields: [{ k: 'capacity', label: '容积', type: 'range', min: 100, max: 2000, step: 100, unit: 'mL' }],
  create: (x, y) => new WasteJar(wasteJarDef, x, y),
};
DEFS.push(() => define(wasteJarDef));

// ══════════════════════════════════════════════════════════
// 支架与配套 —— **纯视觉件**：它们没有 vessel、没有 flame、没有交互，
// 只是把实验台摆成"真实验台"的样子。
//
// ⚠ 实测的几何约束（bridge.js:188-200 原文）：
//   酒精灯找的是「火焰点 lamp.y−0.9h 到容器 insertZone 最近距离 < 26 px」的容器，
//   规则里**没有任何遮挡测试** ⇒ 摆件挡不住加热 ✓；但摆件会**抬高容器** ✗ ⇒
//   一件摆太高，站在它上面的容器就会超出 26 px、加热静默停止。
//   所以这里一律做**薄/低**（石棉网 8 px、铁圈 16 px、三脚架 42 px 且中心留空）。
// ══════════════════════════════════════════════════════════

class LabProp extends Entity {
  render(g) { this.drawProp(g); }
  drawProp() {}
}

// 试管架
class TestTubeRack extends LabProp {
  drawProp(g) {
    const { w, h } = this;
    gfx.fillRR(g, -w / 2, -h / 2 + 6, w, h - 6, 4, 'rgba(150,112,74,.85)');
    gfx.strokeRR(g, -w / 2, -h / 2 + 6, w, h - 6, 4, 'rgba(196,160,120,.6)', 1.4);
    for (let i = 0; i < 4; i++) {
      const x = -w * 0.3 + i * (w * 0.2);
      g.fillStyle = 'rgba(28,32,38,.85)';
      g.beginPath(); g.ellipse(x, 10, 5, 2.6, 0, 0, Math.PI * 2); g.fill();
      g.strokeStyle = 'rgba(220,228,236,.35)'; g.lineWidth = 1; g.stroke();
    }
    gfx.text(g, '试管架', 0, -h / 2 + 3, { color: '#a89078', size: 8.5 });
  }
}
const testTubeRackDef = {
  type: 'testtuberack', name: '试管架', domain: CH, cat: '支架', icon: '🧰',
  desc: '插放试管，可放 4 支', w: 96, h: 34,
  tags: ['试管架', '支架', '摆放'],
  create: (x, y) => new TestTubeRack(testTubeRackDef, x, y),
};
DEFS.push(() => define(testTubeRackDef));

// 三脚架
class Tripod extends LabProp {
  drawProp(g) {
    const { w, h } = this;
    g.strokeStyle = 'rgba(150,158,168,.95)';
    g.lineWidth = 3;
    for (const dx of [-0.36, 0, 0.36]) {
      g.beginPath();
      g.moveTo(dx * w * 0.5, -h / 2 + 6);
      g.lineTo(dx * w * 0.78, h / 2);
      g.stroke();
    }
    g.strokeStyle = 'rgba(178,186,196,.95)';
    g.lineWidth = 3.4;
    g.beginPath(); g.ellipse(0, -h / 2 + 6, w * 0.36, 5, 0, 0, Math.PI * 2); g.stroke();
    gfx.text(g, '三脚架', 0, h / 2 + 9, { color: '#8d96a0', size: 8.5 });
  }
}
const tripodDef = {
  type: 'tripod', name: '三脚架', domain: CH, cat: '支架', icon: '🔺',
  desc: '架住加热容器，中心留空给火焰', w: 68, h: 42,
  tags: ['三脚架', '支架', '加热'],
  create: (x, y) => new Tripod(tripodDef, x, y),
};
DEFS.push(() => define(tripodDef));

// 铁圈
class IronRing extends LabProp {
  drawProp(g) {
    const { w, h } = this;
    g.strokeStyle = 'rgba(150,158,168,.95)';
    g.lineWidth = 3;
    g.beginPath(); g.ellipse(0, 0, w * 0.32, h * 0.42, 0, 0, Math.PI * 2); g.stroke();
    g.beginPath(); g.moveTo(w * 0.32, 0); g.lineTo(w / 2, 0); g.stroke();
    gfx.text(g, '铁圈', -w * 0.1, h * 0.42 + 8, { color: '#8d96a0', size: 8.5 });
  }
}
const ironRingDef = {
  type: 'ironring', name: '铁圈', domain: CH, cat: '支架', icon: '⭕',
  desc: '装在铁架台上，托住石棉网或漏斗', w: 56, h: 16,
  tags: ['铁圈', '支架'],
  create: (x, y) => new IronRing(ironRingDef, x, y),
};
DEFS.push(() => define(ironRingDef));

// 石棉网（做得很薄：抬高容器会顶掉 26 px 的加热判定）
class AsbestosNet extends LabProp {
  drawProp(g) {
    const { w, h } = this;
    g.fillStyle = 'rgba(176,178,180,.9)';
    g.fillRect(-w / 2, -h / 2, w, h);
    g.strokeStyle = 'rgba(120,124,128,.9)';
    g.lineWidth = 1;
    for (let i = 1; i < 8; i++) {
      const x = -w / 2 + (w * i) / 8;
      g.beginPath(); g.moveTo(x, -h / 2); g.lineTo(x, h / 2); g.stroke();
    }
    g.fillStyle = 'rgba(228,226,220,.95)';
    g.beginPath(); g.ellipse(0, 0, w * 0.26, h * 0.34, 0, 0, Math.PI * 2); g.fill();
  }
}
const asbestosNetDef = {
  type: 'asbestosnet', name: '石棉网', domain: CH, cat: '加热', icon: '🕸',
  desc: '让容器受热均匀，垫在火焰与容器之间', w: 64, h: 8,
  tags: ['石棉网', '加热', '配套'],
  create: (x, y) => new AsbestosNet(asbestosNetDef, x, y),
};
DEFS.push(() => define(asbestosNetDef));

// 药匙
class Spatula extends LabProp {
  drawProp(g) {
    const { w, h } = this;
    gfx.fillRR(g, -w / 2, -2, w * 0.62, 4, 2, 'rgba(200,206,214,.95)');
    g.fillStyle = 'rgba(198,204,212,.95)';
    g.beginPath(); g.ellipse(w * 0.3, 0, w * 0.16, h * 0.34, 0, 0, Math.PI * 2); g.fill();
    g.strokeStyle = 'rgba(140,148,158,.9)'; g.lineWidth = 1; g.stroke();
  }
}
const spatulaDef = {
  type: 'spatula', name: '药匙', domain: CH, cat: '工具', icon: '🥄',
  desc: '取用固体药品', w: 40, h: 12,
  tags: ['药匙', '工具', '取用'],
  create: (x, y) => new Spatula(spatulaDef, x, y),
};
DEFS.push(() => define(spatulaDef));

// 坩埚钳
class CrucibleTong extends LabProp {
  drawProp(g) {
    const { w, h } = this;
    g.strokeStyle = 'rgba(160,168,178,.95)';
    g.lineWidth = 3;
    g.beginPath(); g.moveTo(-w / 2, h / 2); g.lineTo(w * 0.28, -h / 2 + 3); g.stroke();
    g.beginPath(); g.moveTo(-w / 2, h / 2 - 8); g.lineTo(w * 0.28, -h / 2 + 3); g.stroke();
    g.strokeStyle = 'rgba(178,186,196,.95)';
    g.beginPath(); g.arc(w * 0.3, -h / 2 + 4, 6, -0.6, 0.6); g.stroke();
  }
}
const crucibleTongDef = {
  type: 'crucibletong', name: '坩埚钳', domain: CH, cat: '工具', icon: '🗜',
  desc: '夹取灼热的坩埚', w: 46, h: 26,
  tags: ['坩埚钳', '工具', '夹取'],
  create: (x, y) => new CrucibleTong(crucibleTongDef, x, y),
};
DEFS.push(() => define(crucibleTongDef));

// ══════════════════════════════════════════════════════════
// 滴瓶 / 洗瓶 —— E2 之后的「加料件」（能主动把东西加进容器）
//
// ⚠ 两件都**故意没有 vessel**：它们不是容器，所以
//   · 不进 ui/data.js、system.credit、ui/inspector 的容器面板
//     （理由与 mechanics.js:33-35 那段注释完全同款：那些地方只判 `e.vessel` 是否存在）
//   · 不会被倾倒、不会被加热（耦合总线的候选要求 `c.vessel`）
//   它们的"内容"就是 props.reagent + props.dose —— 正是 lab.js 的 canFeed/feedInto 认的那个能力。
// ⇒ 于是倾倒链路**一行都不用改**：interact.js 放行（canFeed 为真）、main.js 走 feedInto。
// ⚠ dose 为 0 时 canFeed 为假 ⇒ 这件器材自动"倒不出来"，不需要任何特判。
// ══════════════════════════════════════════════════════════
class Dropper extends LabProp {
  drawProp(g) {
    const { w, h } = this;
    // 胶头
    g.fillStyle = 'rgba(198,90,82,.9)';
    g.beginPath(); g.ellipse(0, -h * 0.42, w * 0.17, h * 0.13, 0, 0, Math.PI * 2); g.fill();
    // 颈
    g.fillStyle = 'rgba(214,228,236,.85)';
    g.fillRect(-w * 0.07, -h * 0.31, w * 0.14, h * 0.14);
    // 瓶身
    g.fillStyle = 'rgba(206,232,240,.85)';
    g.fillRect(-w * 0.34, -h * 0.17, w * 0.68, h * 0.5);
    g.strokeStyle = 'rgba(150,190,205,.95)'; g.lineWidth = 1.2;
    g.strokeRect(-w * 0.34, -h * 0.17, w * 0.68, h * 0.5);
    // 细口与滴尖
    g.fillStyle = 'rgba(214,228,236,.9)';
    g.beginPath();
    g.moveTo(-w * 0.08, h * 0.33); g.lineTo(w * 0.08, h * 0.33);
    g.lineTo(0, h * 0.5); g.closePath(); g.fill();
    gfx.text(g, '滴瓶', 0, -h * 0.5 + 3, { color: '#8d96a0', size: 8.5 });
  }
}
const dropperDef = {
  type: 'dropper', name: '滴瓶', domain: CH, cat: '取用', icon: '💧',
  desc: '一滴一滴地往容器里加液体', w: 40, h: 56,
  // ⚠ 只列「液体药品」：滴瓶本来就只滴液体 ⇒ 固/液仍按器材自己的 cat 分，既有 37 瓶行为不受影响
  defaults: { reagent: 'H2O', dose: 0.05 },
  fields: [
    { k: 'reagent', label: '吸取的试剂', type: 'select', options: LIQUIDS.map((id) => [id, (SP[id] && SP[id].n) || id]) },
    { k: 'dose', label: '每次用量', type: 'range', min: 0.02, max: 1, step: 0.01, unit: 'mL' },
  ],
  tags: ['滴瓶', '加料', '取用'],
  create: (x, y) => new Dropper(dropperDef, x, y),
};
DEFS.push(() => define(dropperDef));

class WashBottle extends LabProp {
  drawProp(g) {
    const { w, h } = this;
    // 瓶身
    g.fillStyle = 'rgba(206,232,240,.8)';
    g.fillRect(-w * 0.32, -h * 0.2, w * 0.64, h * 0.6);
    g.strokeStyle = 'rgba(150,190,205,.95)'; g.lineWidth = 1.2;
    g.strokeRect(-w * 0.32, -h * 0.2, w * 0.64, h * 0.6);
    // 瓶里的水
    g.fillStyle = 'rgba(120,190,230,.45)';
    g.fillRect(-w * 0.3, h * 0.06, w * 0.6, h * 0.32);
    // 弯管（洗瓶的标志）
    g.strokeStyle = 'rgba(214,228,236,.95)'; g.lineWidth = 2.6;
    g.beginPath();
    g.moveTo(0, -h * 0.2);
    g.lineTo(0, -h * 0.36);
    g.lineTo(w * 0.32, -h * 0.36);
    g.lineTo(w * 0.36, -h * 0.5);
    g.stroke();
    // 瓶盖
    g.fillStyle = 'rgba(160,170,180,.95)';
    g.fillRect(-w * 0.13, -h * 0.26, w * 0.26, h * 0.08);
    gfx.text(g, '洗瓶', 0, h * 0.5 + 9, { color: '#8d96a0', size: 8.5 });
  }
}
const washBottleDef = {
  type: 'washbottle', name: '洗瓶', domain: CH, cat: '取用', icon: '🚿',
  desc: '挤一股蒸馏水冲洗容器或稀释', w: 52, h: 68,
  defaults: { reagent: 'H2O', dose: 20 },
  fields: [{ k: 'dose', label: '每次用量', type: 'range', min: 5, max: 100, step: 5, unit: 'mL' }],
  tags: ['洗瓶', '加料', '蒸馏水'],
  create: (x, y) => new WashBottle(washBottleDef, x, y),
};
DEFS.push(() => define(washBottleDef));

// ══════════════════════════════════════════════════════════
// 漏斗 —— 「过滤」的全部机制 = `vessel.retainSolids` 这一个**器材自报**的能力
//
//   · 没有新动作、没有新规则：机制在 vessel.js 的 pourInto 里只有一行 `if (!retain)`；
//   · 缺省 undefined ⇒ 既有倾倒行为逐字不变（r9 档就是打这条的）；
//   · 滤纸不单独成件（props.paper）—— 两件器材之间没有通用的"谁放在谁上面"，
//     拆开会让"过滤是否生效"变成跨件耦合；
//   · 先例：thermal.js:225 也是器材往自己的 vessel 上挂活参数。
// ══════════════════════════════════════════════════════════
class Funnel extends Glassware {
  constructor(def, x, y) {
    super(def, x, y);
    this.vessel.retainSolids = true;   // ← 能力声明（r8 档的变异锚点）
  }
  geom() { const w = this.w * 0.7, h = this.h * 0.26; return { x: -w / 2, y: -this.h * 0.3, w, h }; }
  innerPath(g) {
    const { x, y, w, h } = this.geom();
    // 上宽下窄的锥体 + 下面的细管（内容物就显示在锥体里）
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x + w, y);
    g.lineTo(x + w * 0.62, y + h);
    g.lineTo(x + w * 0.56, y + h + this.h * 0.42);
    g.lineTo(x + w * 0.44, y + h + this.h * 0.42);
    g.lineTo(x + w * 0.38, y + h);
    g.closePath();
  }
  render(g) {
    this.drawContents(g);
    const { x, y, w, h } = this.geom();
    g.save();
    this.innerPath(g);
    g.fillStyle = 'rgba(228,240,246,.35)';
    g.fill();
    g.strokeStyle = 'rgba(196,220,232,.85)';
    g.lineWidth = 2.4;
    g.stroke();
    g.restore();
    // 滤纸（垫在锥体里的一圈白边）
    if (this.props.paper !== false) {
      g.strokeStyle = 'rgba(246,246,242,.95)';
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(x + 2.5, y + 1.5);
      g.lineTo(x + w - 2.5, y + 1.5);
      g.lineTo(x + w * 0.62, y + h - 1.5);
      g.closePath();
      g.stroke();
    }
    gfx.text(g, '漏斗', 0, y + h + this.h * 0.42 + 9, { color: '#8d96a0', size: 8.5 });
    this.drawTemp(g);
  }
}
const funnelDef = {
  type: 'funnel', name: '漏斗', domain: CH, cat: '容器', icon: '🧽',
  desc: '垫上滤纸过滤：液体与溶解物过去，未溶固体和沉淀留下', w: 48, h: 64,
  defaults: { capacity: 60, paper: true },
  tags: ['漏斗', '过滤', '滤纸', '分离'],
  fields: [
    { k: 'paper', label: '滤纸', type: 'checkbox', text: '垫了滤纸' },
    { k: 'capacity', label: '容积', type: 'range', min: 20, max: 200, step: 10, unit: 'mL' },
  ],
  create: (x, y) => new Funnel(funnelDef, x, y),
};
DEFS.push(() => define(funnelDef));

export { Crucible, WasteJar, TestTubeRack, Tripod, IronRing, AsbestosNet, Spatula, CrucibleTong, Dropper, WashBottle, Funnel };

// ── 插件 ──────────────────────────────────────────────────
export default {
  id: 'xiaomo.equipment.labware',
  name: '化学器皿',
  version: '1.0.0',
  kind: 'equipment',
  domain: 'chemistry',
  desc: '坩埚、废液缸，以及试管架/三脚架/铁圈/石棉网/药匙/坩埚钳（后六件是纯视觉摆件）',
  author: '小墨实验室',
  builtin: true,
  tags: ['化学', '容器', '支架', '安全'],
  setup(ctx) { ctx.scope('equipment', () => DEFS.forEach(f => f())); },
};
