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
import { VesselModel } from '../chemistry/vessel.js';
import { boilPoint, L_VAPOR, C_WATER } from './thermal.js';   // 沸点/汽化潜热/比热：thermal.js 已导出，不另立一份

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

// ══════════════════════════════════════════════════════════
// 集气瓶 —— 「气体导出」的全部机制 = `vessel.collectGas` 这一个**器材自报**的能力
//
//   · 机制在 vessel.js 的 pourInto 里：**两处守卫**为它放行 + 一段按 f 的搬运；
//   · ⚠ 气体**没有体积、也没有压强**（VesselModel 里 gas 只有 mol；面板的 `gasTotal() × 24000`
//     只是标准状况下的**显示口径**，不是模型里的量）⇒ 集气瓶**故意没有"装满了"这个上限** ✓
//     这不是漏了：要造上限就得凭空发明一条没有出处的口径。
//   · 先例：thermal.js:225 的 coolK / 上一件漏斗的 retainSolids。
// ══════════════════════════════════════════════════════════
class GasJar extends Glassware {
  constructor(def, x, y) {
    super(def, x, y);
    this.vessel.collectGas = true;   // ← 能力声明（r10 档的变异锚点）
  }
  geom() { const w = this.w * 0.78, h = this.h * 0.64; return { x: -w / 2, y: -this.h * 0.04, w, h }; }
  innerPath(g) { const { x, y, w, h } = this.geom(); gfx.rr(g, x, y, w, h, 3); }
  render(g) {
    this.drawContents(g);
    const { x, y, w, h } = this.geom();
    // 气体的可见化：沿用面板那套口径（mol × 24000 = mL），多少有一点雾
    const mL = this.vessel.gasTotal() * 24000;
    g.save();
    this.innerPath(g);
    if (mL > 0) { g.fillStyle = `rgba(198,206,238,${Math.min(0.4, mL / 500)})`; g.fill(); }
    g.strokeStyle = 'rgba(200,224,240,.6)';
    g.lineWidth = 2.4;
    g.stroke();
    g.restore();
    if (mL > 0) gfx.text(g, `${Math.round(mL)} mL 气体`, 0, y + h + 11, { color: '#8d96a0', size: 8.5 });
    this.drawTemp(g);
  }
}
const gasJarDef = {
  type: 'gasjar', name: '集气瓶', domain: CH, cat: '容器', icon: '🫙',
  desc: '收集气体：用「倾倒」把发生器里的气体倒进来（同一次倾倒里的液体和固体也照旧会过来）', w: 60, h: 72,
  defaults: { capacity: 250 },
  tags: ['集气瓶', '气体', '收集', '容器'],
  fields: [{ k: 'capacity', label: '容积', type: 'range', min: 100, max: 500, step: 50, unit: 'mL' }],
  create: (x, y) => new GasJar(gasJarDef, x, y),
};
DEFS.push(() => define(gasJarDef));

// ══════════════════════════════════════════════════════════
// 蒸发皿 —— 「蒸发结晶」的全部机制 = 器材**自己的 step() 里的相变**
//
//   ⚠ 本件**不新增引擎算子**：走的是 thermal.js:430 的 IceBath（冰浴）已经开出来的那条轨道 ——
//     相变发生在**器材自己的 step() 里**：把 vessel 的显热账改写成潜热账、温度停在平台，
//     并且**真的改 vessel 的物质量**（冰浴是 `v.volume += melted`，本件是 `v.volume -= gone`）。
//     ⇒ 镜像件：冰浴「吸热·熔化·加质量·平台 0 ℃」↔ 蒸发皿「吸热·汽化·减质量·平台沸点」。
//   ⚠ 汽化掉的水**离开 vessel、不再参与任何计算**（不进"空气"、不新增蒸汽物种）。
//     这不是偷懒，是仓库既有口径：totalMass() 本来就不算 gas；empty() 直接 clear()；
//     Boiler 的 state.steam 也只作为一个数存在、没有人守恒它。全仓 grep「守恒」只有力学/热学三处
//     ⇒ **化学域没有任何守恒断言**，删掉液体不会撞上既有断言；能量侧本来也允许离开（vessel.js 的散热项）。
//     ⇒ 代价与好处都记账：物质不进任何容器，但**账在面板上看**（state.steamed）。
//   ⚠ 蒸干后溶质**析出为 solid**，用**与溶解态同一个 id**（solid 只存「物质→g」）⇒ **零新增物种**。
//     已知不对称：conc() 对非 st:'s' 只读 mol ⇒ 析出的晶体不再参与浓度与反应速率（物理上也对）。
//   ⚠ 沸点用 thermal.js 已导出的 boilPoint(101.325) ⇒ 100 ℃：VesselModel 里**没有压强这个概念**，
//     不引入 vessel.pressure（那会是一条没有出处的口径）。
// ══════════════════════════════════════════════════════════
class EvapDish extends Entity {
  constructor(def, x, y) {
    super(def, x, y);
    this.vessel = new VesselModel(this, this.props.capacity || 120);
    this.state.steamed = 0;
    this.state.crystallized = 0;
  }
  geom() { const w = this.w * 0.82, h = this.h * 0.32; return { x: -w / 2, y: -this.h * 0.04, w, h }; }
  insertZone() { const gm = this.geom(); return { x: this.x + gm.x, y: this.y + gm.y, w: gm.w, h: gm.h }; }
  serializeState() { return this.vessel.toJSON(); }
  deserializeState(s) { this.vessel.loadJSON(s); }

  step(dt, world) {
    const v = this.vessel;
    v.coolK = this.props.coolK;              // 散热系数是活参数（与 glassware 里 capacity 同一用法）
    // 热结算仍然交给 vessel 自己（本件不重写热学，一行热学公式都不复制）
    this.vessel.step(dt, world);
    // 相变：**越过沸点的那部分显热改记账到汽化潜热** —— 与 Boiler 的「平台 + 潜热」逐字同一口径。
    // 写法上不判"当前是否已经在沸点"，而是判"这一步有没有越过去"：一大笔热一帧打进来也照样对。
    const bp = boilPoint(101.325);
    if (v.volume > 0 && v.temp > bp) {
      const cap = Math.max(1, v.totalMass()) * C_WATER;
      const excess = (v.temp - bp) * cap;                  // 越过沸点的那部分热 J
      const need = v.volume * L_VAPOR;                     // 把剩下的水全汽化所需 J
      const used = Math.min(excess, need);
      const gone = used / L_VAPOR;                         // mL（ρ=1）
      v.volume = Math.max(0, v.volume - gone);
      v.mol.set('H2O', Math.max(0, (v.mol.get('H2O') || 0) - gone / 18.02));
      this.state.steamed += gone;
      // 还有水时 used === excess（下面的 min 取不到 need）⇒ 温度正好落在沸点：这就是"平台"。
      // 水干了 ⇒ used = need < excess，剩下的热按显热继续升温（干烧升温交给 vessel 自己的热容）。
      v.temp = bp + (excess - used) / cap;
    }
    // 蒸干 ⇒ 溶质析出（数据无关：同一个 id 写 solid ⇒ 不新增物种）
    if (v.volume <= 1e-9 && v.mol.size) {
      let changed = false;
      for (const [id, q] of [...v.mol]) {
        if (id === 'H2O' || !(q > 0)) continue;
        v.solid.set(id, (v.solid.get(id) || 0) + q * ((SP[id] || {}).M || 100));
        this.state.crystallized += q * ((SP[id] || {}).M || 100);
        v.mol.delete(id);
        changed = true;
      }
      if (v.mol.delete('H2O')) changed = true;
      if (changed) v.updateColor();
    }
  }

  render(g) {
    const { x, y, w, h } = this.geom();
    const v = this.vessel;
    g.save();
    gfx.rr(g, x, y, w, h, 6);
    g.fillStyle = 'rgba(232,230,224,.94)';
    g.fill();
    g.strokeStyle = 'rgba(150,144,132,.95)';
    g.lineWidth = 2;
    g.stroke();
    if (v.volume > 0) {
      const hh = Math.max(2, (h - 5) * Math.min(1, v.volume / Math.max(1, v.capacity)));
      const c = v.color;
      g.fillStyle = Array.isArray(c) ? `rgb(${c[0]},${c[1]},${c[2]})` : 'rgba(150,200,230,.5)';
      gfx.rr(g, x + 2.5, y + h - hh - 2.5, w - 5, hh, 3);
      g.fill();
    } else if (v.solid.size) {
      g.fillStyle = 'rgba(178,174,164,.95)';
      gfx.rr(g, x + 5, y + h * 0.5, w - 10, Math.max(2, h * 0.34), 3);
      g.fill();
    }
    g.restore();
    gfx.text(g, '蒸发皿', 0, y + h + 11, { color: '#8d96a0', size: 8.5 });
    if (this.state.steamed > 0.01) gfx.text(g, `已汽化 ${this.state.steamed.toFixed(1)} g`, 0, y + h + 20, { color: '#8d96a0', size: 8 });
    if (this.state.crystallized > 0.01) gfx.text(g, `已析出 ${this.state.crystallized.toFixed(1)} g`, 0, y + h + 29, { color: '#8d96a0', size: 8 });
  }
}
const evapDishDef = {
  type: 'evapdish', name: '蒸发皿', domain: CH, cat: '容器', icon: '🥣',
  desc: '把溶液倒进来再加热：水汽化走掉（面板上显示已汽化多少），蒸干后溶质析出为固体', w: 60, h: 34,
  defaults: { capacity: 120, coolK: 0.06 },
  state: { steamed: 0, crystallized: 0 },
  tags: ['蒸发皿', '蒸发', '结晶', '加热', '容器'],
  fields: [
    { k: 'capacity', label: '容积', type: 'range', min: 60, max: 300, step: 20, unit: 'mL' },
    { k: 'coolK', label: '散热', type: 'range', min: 0, max: 0.2, step: 0.01 },
  ],
  create: (x, y) => new EvapDish(evapDishDef, x, y),
};
DEFS.push(() => define(evapDishDef));

// ══════════════════════════════════════════════════════════
// 滴定管 —— 化学域「定量滴加 + 终点判定」
//
// 本件不新增任何契约：
//   · 加料能力走 lab.js 的 canFeed（自带 props.reagent + props.dose 即可，见该处注释）。
//     第一个吃这条口子的是**滴瓶**；滴定管是**第一个要读累计量**的消费者 —— 那才是新需求。
//   · 终点判据走既有的 vessel.pH()（vessel.js:194：从 SP[id].ions 累加 H+/OH- + 水自电离）
//     与既有的指示剂变色（vessel.js:231-234：酚酞 ph>8.2 变粉、石蕊 <5 红 / >8 蓝）。
//     ⚠ 这不是本件新造的判据：system.credit.js:33 那个「中和到近中性」成就早就在用 pH 判终点。
//   · 中和走既有的 RULES 三条（naoh-hcl / naoh-h2so4 / caoh2-hcl），本件**不动 RULES**。
//
// 读数 state.dosed（单位 **mL**）由**喂料点**写：lab.js feedInto 里那一行累加。
//   为什么不在这里算：feedInto 只往目标加，main.js:412 拿返回值只 toast/log
//   ⇒ 器材收不到「我被用了一次」的通知；而"读目标里我的试剂还剩多少"也不成立 ——
//   中和会把它当场消耗掉 ⇒ 读数恒 0。于是这一行只能写在喂料点（谁喂的谁记），
//   ⇒ VesselModel **零新增字段**（本件落地前后 vessel.js sha 不变）。
//
// ⚠ 已知边界（别拿它当定量工具）：
//   ① 弱酸弱碱在 species.js 里是**固定解离度**（醋酸 ions H+ 0.02、氨水 0.02）
//      ⇒ pH 不是真解离平衡 ⇒ 本件只做**定性判据**（到没到终点），**不做滴定曲线、不做定量计算**；
//   ② species.js 的 acid 字段（strong/weak/base-strong/base-weak）**全仓零读取者**，
//      本件也不读它 —— 补读取者会改既有 pH/行为，属另一件，需单独批；
//   ③ 无 DOM 指针端到端证明（公共场所不起可视窗口）⇒ 只到谓词/行为层；外观不证好看。
// ══════════════════════════════════════════════════════════
class Titrant extends LabProp {
  serializeState() { return { dosed: this.state.dosed }; }
  deserializeState(o) { this.state.dosed = (o && o.dosed) || 0; }
  drawProp(g) {
    const { w, h } = this;
    const top = -h * 0.34, bot = h * 0.28;
    // 管身
    g.fillStyle = 'rgba(206,232,240,.85)';
    g.fillRect(-w * 0.22, top, w * 0.44, bot - top);
    g.strokeStyle = 'rgba(150,190,205,.95)'; g.lineWidth = 1.2;
    g.strokeRect(-w * 0.22, top, w * 0.44, bot - top);
    // 刻度
    g.strokeStyle = 'rgba(120,165,180,.9)'; g.lineWidth = 1;
    for (let i = 1; i < 10; i++) {
      const y = top + (bot - top) * (i / 10);
      const long = i % 5 === 0;
      g.beginPath(); g.moveTo(-w * 0.22, y); g.lineTo(-w * 0.22 + (long ? w * 0.17 : w * 0.09), y); g.stroke();
    }
    // 活塞 + 旋钮
    g.fillStyle = 'rgba(120,190,215,.95)';
    g.beginPath(); g.ellipse(0, bot + 2, w * 0.17, h * 0.04, 0, 0, Math.PI * 2); g.fill();
    g.fillStyle = 'rgba(160,170,180,.95)';
    g.fillRect(-w * 0.45, bot - 1, w * 0.24, h * 0.026);
    // 尖嘴
    g.fillStyle = 'rgba(214,228,236,.9)';
    g.beginPath();
    g.moveTo(-w * 0.07, bot + h * 0.05); g.lineTo(w * 0.07, bot + h * 0.05);
    g.lineTo(0, bot + h * 0.14); g.closePath(); g.fill();
    const s = SP[this.props.reagent];
    gfx.text(g, '滴定管', 0, -h * 0.5 + 3, { color: '#8d96a0', size: 8.5 });
    gfx.text(g, (s && s.f) || this.props.reagent || '', 0, top - 7, { color: '#5b7f92', size: 8.5 });
    if (this.state.dosed > 0.001) gfx.text(g, `已滴加 ${this.state.dosed.toFixed(2)} mL`, 0, h * 0.5 + 9, { color: '#8d96a0', size: 8 });
  }
}
const titrantDef = {
  type: 'titrant', name: '滴定管', domain: CH, cat: '取用', icon: '🧪',
  desc: '滴定用：每次放出设定体积的试剂，读数显示累计已滴加多少；终点看指示剂变色（酚酞 pH>8.2 变粉）与面板 pH',
  w: 34, h: 96,
  // ⚠ dose 默认 0.4（**不是 1**）：让探针能区分"按体积累计"与"按次数累计"这两种假对
  defaults: { reagent: 'NaOH', dose: 0.4 },
  state: { dosed: 0 },
  tags: ['滴定管', '滴定', '加料', '定量', '取用'],
  fields: [
    { k: 'reagent', label: '管内试剂', type: 'select', options: LIQUIDS.map((id) => [id, (SP[id] && SP[id].n) || id]) },
    { k: 'dose', label: '每次放出', type: 'range', min: 0.05, max: 5, step: 0.05, unit: 'mL' },
  ],
  create: (x, y) => new Titrant(titrantDef, x, y),
};
DEFS.push(() => define(titrantDef));

export { Crucible, WasteJar, TestTubeRack, Tripod, IronRing, AsbestosNet, Spatula, CrucibleTong, Dropper, WashBottle, Funnel, GasJar, EvapDish, Titrant };

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
