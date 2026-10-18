const DEFS = [];
// ══════════════════════════════════════════════════════════
// 物理域 · 电学器材
//
// 每个器材只声明三件事：怎么画、在电路里是什么、参数如何影响阻值。
// 电路求解器完全不知道它们叫什么名字。
// ══════════════════════════════════════════════════════════

import { Entity, gfx, dmg, grad1 } from '../core/entity.js';
import { define } from './registry.js';
// 只为 thermistor 自报「当前阻值」用：那是**自适应单位**格式（Ω/kΩ/MΩ），见 plans/11 §6.5。
// 依赖方向是「器材包 → 核心」，与既有准则一致；circuit.js 自己不 import 任何东西，无环。
import { fmtR } from '../physics/circuit.js';

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
  /**
   * 灯丝热状态（C6）。改动前 `resistanceAt(U)` 是**纯代数拟合** —— 「灯丝温度」被隐式写成
   * **电压**的函数，不是状态量。现在温度是真状态量、电阻由它给出（照 `Thermistor` 的既有
   * 范式 `circuitBranch() { return { type:'R', r: this.resistanceNow() } }`）。
   *
   * 物理：C·dT/dt = P_电 − [εσA(T⁴−T_env⁴) + k_conv(T−T_env)]，R(T) = R20·(1 + α(T−20))
   * 常数出处（没有出处的数就是编的）：
   *   σ = 5.670374419e-8 W·m⁻²·K⁻⁴ —— SI/CODATA 定义值（由 k、h、c 定出，精确到给定位数）；
   *   α = 4.5e-3 /K —— 钨在**室温附近**的电阻温度系数，教科书量级。⚠ 真实钨的 α 随温度下降
   *       （2400 K 时等效 α ≈ 1.2e-3 /K）⇒ 这里的常数 α 是**线性近似**：线性外推到 ~2000 ℃
   *       恰好复现既有曲线的 `R_hot/R_cold = 10`，所以它只在中低温区间准确，别当精确模型用；
   *   ε = 0.35 —— 钨丝（卷绕/氧化后）发射率的教科书量级，不是测量值。
   * 等效辐射面积 A **不由人取**，而是由额定点反解（见 `areaM2()`）⇒ 模型在额定点与既有曲线重合。
   *
   * ⚠ 零回归是**结构性**的：`warmUpTime = 0`（默认）时 `circuitBranch()` 返回**改动前那条**
   * `{type:'R', r: this.resistanceAt(0)}`，且 `step()` 立刻 return（不写任何 state）⇒ 逐字相同。
   */
  circuitBranch() {
    const warm = this.props.warmUpTime || 0;
    if (!(warm > 0)) return { type: 'R', r: this.resistanceAt(0) };
    return { type: 'R', r: this.resistanceNow() };
  }
  /** 瞬时（代数）阻值：小灯泡原有的冷/热两段拟合，`warmUpTime = 0` 时的唯一路径（逐字未改） */
  resistanceAt(U) {
    const ratedV = this.props.ratedV, ratedP = this.props.ratedP;
    const R_hot = (ratedV * ratedV) / ratedP;
    const R_cold = R_hot / 10;
    const u = Math.abs(U);
    const R_now = Math.max(R_cold, Math.min(R_hot * 3, u * u / ratedP + R_cold));
    const k = Math.min(1, Math.pow(R_now / R_hot, 0.45));
    return R_cold + (R_hot - R_cold) * k;
  }
  /** 额定（热态）阻值 Ω */
  rHot() { return (this.props.ratedV * this.props.ratedV) / this.props.ratedP; }
  /** 20 ℃ 参考阻值 Ω：默认沿用既有曲线的冷热比 1/10（可声明 ⇒ 换灯丝材料不必改代码） */
  r20() { const p = this.props; return p.r20 > 0 ? p.r20 : this.rHot() / 10; }
  /** 额定灯丝温度 ℃：由「热态/冷态阻值比」+ 线性 α 反解 —— 与 T⁴ 辐射平衡是两条独立来源 */
  ratedTempC() { return this.props.ambientTemp + (this.rHot() / this.r20() - 1) / this.props.alpha; }
  /** 等效辐射面积 m²：由额定点反解（额定驱动下模型与既有曲线重合，不是凭空取面积） */
  areaM2() {
    const Tr = this.ratedTempC(), Te = this.props.ambientTemp;
    const loss = this.props.epsilon * this.props.sigma * (Math.pow(Tr + 273.15, 4) - Math.pow(Te + 273.15, 4))
      + this.props.convCoef * (Tr - Te);
    return loss > 0 ? this.props.ratedP / loss : 0;
  }
  /** 热损耗 W：辐射（白炽灯主导）+ 对流 */
  heatLossAt(T) {
    const Te = this.props.ambientTemp;
    return this.props.epsilon * this.props.sigma * this.areaM2() * (Math.pow(T + 273.15, 4) - Math.pow(Te + 273.15, 4))
      + this.props.convCoef * (T - Te);
  }
  /** 损耗对温度的导数 W/K（热容由它定出：τ = C / dP/dT） */
  dLossDT(T) {
    const p = this.props;
    return 4 * p.epsilon * p.sigma * this.areaM2() * Math.pow(T + 273.15, 3) + p.convCoef;
  }
  /** 平衡温度 ℃：解 P = 损耗（损耗对 T 单调 ⇒ 先括区间再二分；有对流时无闭式解） */
  balanceTempC(P) {
    const Te = this.props.ambientTemp, MAX = 3422;   // 钨熔点 ℃：温度上限是物理量，不是数值兜底
    if (!(P > 0)) return Te;
    let hi = Te + 1;
    while (hi < MAX && this.heatLossAt(hi) < P) hi = Math.min(MAX, Te + (hi - Te) * 2);
    if (this.heatLossAt(hi) < P) return MAX;
    let lo = Te;
    for (let i = 0; i < 50; i++) { const mid = (lo + hi) / 2; if (this.heatLossAt(mid) < P) lo = mid; else hi = mid; }
    return (lo + hi) / 2;
  }
  /** 实时阻值 Ω：由灯丝温度给出 —— 与「瞬时电阻」并存的第二个量（plans/11 §2 的口径） */
  resistanceNow() {
    const T = this.state.filamentTemp;
    if (!isFinite(T)) return this.resistanceAt(0);
    const r20 = this.r20();
    return Math.max(1, r20 * (1 + this.props.alpha * (T - 20)));
  }
  step(dt) {
    const warm = this.props.warmUpTime || 0;
    if (!(warm > 0)) return;               // 零回归：默认不做任何热积分，也不写任何 state
    const p = this.props;
    const Pin = Math.abs(this.state.P || 0);
    const T_eq = this.balanceTempC(Pin);
    // 热容 C 由「额定点热时间常数 = warmUpTime」定出：τ = C / (dP_loss/dT)
    const C = Math.max(1e-12, warm * this.dLossDT(T_eq));
    let T = isFinite(this.state.filamentTemp) ? this.state.filamentTemp : p.ambientTemp;
    // 显式积分 + 子步（τ 可能远小于 dt；子步上限 200，防病态参数卡死）
    const n = Math.min(200, Math.max(1, Math.ceil(dt / Math.max(1e-6, warm / 8))));
    const h = dt / n;
    // 一阶线性化 + 精确指数步（C 以 C/dP/dT 的形式出现）。为什么不用显式 Euler：
    // T→环境温度附近损耗对 T 的导数趋于 0 ⇒ τ_local = C/(dP/dT) → 0，显式步会变硬并
    // 在平衡点上下**振荡**（实测：降温时越过环境温度再回升，单调性被破坏）。
    // 指数步对线性化系统是精确的，且**数学上不可能越过平衡点** ⇒ 升温、降温都单调。
    for (let i = 0; i < n; i++) {
      const dPdT = this.dLossDT(T);
      const tauLocal = dPdT > 0 ? C / dPdT : Infinity;
      T = isFinite(tauLocal) ? T_eq + (T - T_eq) * Math.exp(-h / tauLocal) : T_eq;
      T = Math.min(3422, Math.max(-273.14, T));
    }
    this.state.filamentTemp = T;
    this.state.filamentR = this.resistanceNow();
    this.state.balanceTemp = T_eq;
    this.state.heatIn = Pin;
    this.state.heatOut = this.heatLossAt(T);
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
  defaults: {
    ratedV: 3.8, ratedP: 0.75,
    // ── 灯丝热状态（C6）。warmUpTime = 0（默认）⇒ 不启用热积分，读数与改动前逐字相同 ──
    warmUpTime: 0,          // s  额定点的热时间常数；真实小灯泡约 0.1–0.3 s
    alpha: 4.5e-3,          // 1/K 钨在室温附近的电阻温度系数（教科书量级，线性近似，见类注释）
    epsilon: 0.35,          // -   钨丝发射率（教科书量级，非测量值）
    sigma: 5.670374419e-8,  // W·m⁻²·K⁻⁴ SI/CODATA 定义值（只作参数存在，不上 UI：改它等于改物理常数）
    ambientTemp: 20,        // ℃  环境温度
    convCoef: 0,            // W/K 对流+导热系数；白炽灯以辐射为主，默认 0
    r20: 0,                 // Ω  20℃ 参考阻值；0 = 自动取 R_hot/10（既有曲线的冷热比）
  },
  tags: ['灯泡', '用电器', '发光'],
  fields: [
    { k: 'ratedV', label: '额定电压', type: 'range', min: 1.5, max: 12, step: 0.1, unit: 'V' },
    { k: 'ratedP', label: '额定功率', type: 'range', min: 0.1, max: 5, step: 0.05, unit: 'W' },
    { k: 'warmUpTime', label: '热时间常数', type: 'range', min: 0, max: 2, step: 0.05, unit: 's' },
    { k: 'alpha', label: '电阻温度系数', type: 'range', min: 0, max: 0.01, step: 0.0005, unit: '1/K' },
    { k: 'epsilon', label: '发射率', type: 'range', min: 0, max: 1, step: 0.05, unit: '' },
    { k: 'ambientTemp', label: '环境温度', type: 'range', min: -20, max: 60, step: 1, unit: '℃' },
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
  /**
   * 三端电位器：**滑片口真的接了线**才分成两段（A↔滑片、滑片↔B）；没接就还是整只变阻器。
   * ⚠ 判据是"滑片接了线"，不是"声明了三个口" —— 两线用法（当变阻器）是最常见的合法接法，
   *   按声明报三端会把它变成假警报，而假警报多了人就把告警全关掉。
   * ⚠ 返回 null 表示回落到 circuitBranch()：两线时解与旧版本**逐位相同**。
   * ⚠ 只读 world 的接线，不写任何状态、不发明全局量。
   */
  circuitBranches(world) {
    const iw = this.ports.findIndex((p) => p.kind === 'wire' && p.label === '滑片');
    if (iw < 0) return null;
    const attached = world && world.wires.some((w) => w.kind === 'wire'
      && ((w.a.e === this.id && w.a.p === iw) || (w.b.e === this.id && w.b.p === iw)));
    if (!attached) return null;
    const pos = Math.min(1, Math.max(0, this.props.pos));
    const rMax = this.props.rMax;
    const ends = [];
    for (let i = 0; i < this.ports.length; i++) if (this.ports[i].kind === 'wire' && i !== iw) ends.push(i);
    if (ends.length < 2) return null;
    // 滑片把电阻丝分成两段：A↔滑片 = rMax·pos，滑片↔B = rMax·(1−pos)（与两端用法同一个下限 0.05 Ω）
    return [
      { type: 'R', r: Math.max(0.05, rMax * pos), a: ends[0], b: iw },
      { type: 'R', r: Math.max(0.05, rMax * (1 - pos)), a: iw, b: ends[1] },
    ];
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
  ports: [{ x: -58, y: 0, kind: 'wire' }, { x: 58, y: 0, kind: 'wire' },
    { x: 0, y: -30, kind: 'wire', label: '滑片' }],
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
  /**
   * 理想 / 现实 双模式（C5）。改动前只有一行硬编码字面量：
   *   `circuitBranch() { return { type:'R', r: this.props.mode === 'A' ? 0.05 : 1e6 }; }`
   * ⇒ 「现实内阻」既不可声明，也没有理想档。
   *
   * 理想极端**不需要新原语**，用本项目既有的两个惯用法即可：
   *   · 理想导线 = `{ type:'R', r: 0.01 }` —— 与 `Switch` 闭合档、`Battery` 内阻下限
   *     `max(0.01, internalR)` 同款 ⇒ **理想电流表**；
   *   · 理想断开 = `{ type:'open' }` —— 与 `Switch` 断开档同款 ⇒ **理想电压表**（真·无穷大内阻）。
   * ⚠ 本项目**没有** 0 Ω 的 `V` 支路惯用法，所以不要自造一个。
   *
   * ⚠⚠ 后果：理想电压表是 `open` 支路 ⇒ **只能并联**。把它**串进**回路，电路就是断的
   * （支路电流恰为 0，其余元件全部失电）。这是物理上正确的结果、不是缺陷 —— 但不知道
   * 这件事的人会把它当 bug 查，所以探针 §5 专门把这条后果**断言**出来。
   *
   * ⚠⚠ 声明 `realR = 0` 会踩到求解器的**既有不一致**（只读实测，`circuit.js` 未改）：
   *   · 盖章路径 `:169-170` 把 `R <= 0` 当 **1e9 Ω**（近断路）；
   *   · 上报路径 `:231` 却是 `Math.max(1e-4, resOf(...))`（近短路）；
   * ⇒ 同一支路：解出来的真实电流 ≈ `1.5e-9 A`，报出来的 `state.I` 是 **`15000 A`**（相差 13 个
   * 数量级；见探针 §4b 的三方对照）。**想表达理想导线请写 `0.01`，不要写 `0`。**
   * 本方法**不**替用户改写声明值（不对 `0` 做哨兵）：声明的数就是声明的数，
   * 代价由上面这条注释与探针 §4b 负责说清。
   */
  /**
   * 表头当前「档位 / 量程」的唯一取值口（C1）。
   * 电流表 / 电压表**不覆写** ⇒ 逐字返回自身声明 ⇒ `render()` 与 `circuitBranch()`
   * 的行为与改动前完全一致（结构性零回归 ✓）；多用电表覆写这两个取值器 ⇒ 拨盘一动，
   * **名义量程与支路内阻（现实档 0.05 Ω / 1e6 Ω）一起跟着走** ✓。
   */
  get meterMode() { return this.props.mode; }
  get meterFull() { return this.props.fullScale; }
  get meterUnit() { return this.meterMode === 'A' ? 'A' : 'V'; }
  /**
   * 当前**示数的真源量**（带符号 ✓）：A 档读 I、V 档读 U ✓。
   * 指针（`render()`）与 `state.reading`（`step()`）都**只从这里取** ⇒ 两处永远是同一个数 ✓，
   * 不存在「指针一个值、读数另一个值」的第二条路径 ✗。
   */
  meterValue() {
    return this.meterMode === 'A' ? (this.state.I || 0) : (this.state.U || 0);
  }
  circuitBranch() {
    const real = this.meterMode === 'A' ? 0.05 : 1e6;
    // 现实档（默认）：返回**改动前那条字面表达式** ⇒ 逐字零回归，是结构性的。
    if (this.props.realistic !== false) {
      const r0 = this.props.realR == null ? real : this.props.realR;
      return { type: 'R', r: r0 };
    }
    return this.meterMode === 'A' ? { type: 'R', r: 0.01 } : { type: 'open' };
  }
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
    const isA = this.meterMode === 'A';
    const val = this.meterValue();
    const full = this.meterFull;
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

  /**
   * 把**显示所需的四个量**变成可读的 state 键（C1 器材侧）：
   *   · 名义量程 ← `meterFull`（A/V 档 = 声明量程 ✓；多用电表 = 拨盘档位 ✓）
   *   · 示数     ← `meterValue()`（求解器注入的 `state.I`/`state.U`，带符号 ✓）
   *                —— **与指针同一个真源** ✓
   *   · 单位     ← `meterUnit`（A / V，随档位变 ✓）
   *   · 比例元数据 ← 示数 ÷ 名义量程 = 指针占满量程的比例 ✓（换档而电路不变时，
   *                示数不变、这个比例按新档重算 ✓ —— 这正是「多量程表」的定义 ✓）
   * ⚠ 四个键全部是**既有真源的投影** ✓：不动任何既有键、不做单位换算、不参与求解 ✗。
   * ⚠ 为什么写在 `step` 里：面板取的是 `ent.state` 的**当前帧**读数 ✓ ⇒
   *   拨档与换电路都当帧可见 ✓。
   */
  step() {
    this.state.fullScale = this.meterFull;
    this.state.reading = this.meterValue();
    this.state.unit = this.meterUnit;
    this.state.ratio = this.meterFull > 0 ? this.state.reading / this.meterFull : 0;
  }
}
const ammeterDef = {
  type: 'ammeter', name: '电流表', domain: PH, cat: '测量仪表', icon: '🅐',
  desc: '串联接入，测支路电流', w: 62, h: 62,
  ports: [{ x: -40, y: 0, kind: 'wire' }, { x: 40, y: 0, kind: 'wire' }],
  defaults: { mode: 'A', fullScale: 0.6, realistic: true, realR: null },
  tags: ['电流表', '电表', '测量'],
  fields: [{ k: 'fullScale', label: '量程', type: 'range', min: 0.1, max: 3, step: 0.1, unit: 'A' }],
  create: (x, y) => new Meter(ammeterDef, x, y),
};
DEFS.push(() => define(ammeterDef));

const voltmeterDef = {
  type: 'voltmeter', name: '电压表', domain: PH, cat: '测量仪表', icon: '🅥',
  desc: '并联接入，测两点电压', w: 62, h: 62,
  ports: [{ x: -40, y: 0, kind: 'wire' }, { x: 40, y: 0, kind: 'wire' }],
  defaults: { mode: 'V', fullScale: 15, realistic: true, realR: null },
  tags: ['电压表', '电表', '测量'],
  fields: [{ k: 'fullScale', label: '量程', type: 'range', min: 1, max: 30, step: 1, unit: 'V' }],
  create: (x, y) => new Meter(voltmeterDef, x, y),
};
DEFS.push(() => define(voltmeterDef));

// ─────────────────────────────────────────────────────────
// 7. 多用电表（C1：**一个器材 + 多档拨盘**，不是再造第二第三个表 ✗）
//
// 档位用既有的 `type:'select'` + `options` 字段机制表达 ✓（与 acoustics 的「管口」、
// electronics 的「接法」同款 ⇒ 没有新原语 ✓）。拨盘一动，`meterMode`/`meterFull`/`meterUnit`
// 跟着变 ⇒ **名义量程与单位变** ✓、`circuitBranch()` 的现实内阻按电流档（0.05 Ω）/
// 电压档（1e6 Ω）取 ✓；而**示数**来自电路本身 ⇒ **电路不变时示数不因换档而变** ✓
// —— 这正是「拨盘」与「两个独立表」的分界 ✓。
//
// ⚠ 现实内阻沿用电流表的 0.05 Ω（两档同一值）：本项目没有「多量程分流电阻」这个原语，
//    自造一个就是新物理 ✗ ⇒ 这里只做**档位 → 量程**的映射，不动内阻模型 ✓。
// ⚠ **本器材只做电流档与电压档，不含欧姆档** ✗（D44）：
//    欧姆档的物理是「表内电源 + 串接被测件 + 由电流反推 R」——**「表内电源」这个器材语义
//    本项目没有** ✗，加它就是把器材语义往外扩 ✓；而学生已经能在面板上读到「等效电阻 R」✓。
//    ⇒ 别把它当缺陷查 ✗；将来若真要欧姆档，充要条件是**先立「表内电源」这个原语** ✓。
// ─────────────────────────────────────────────────────────
const DIALS = {
  A06: { mode: 'A', fullScale: 0.6, unit: 'A', label: '直流电流 0.6 A' },
  A3: { mode: 'A', fullScale: 3, unit: 'A', label: '直流电流 3 A' },
  V3: { mode: 'V', fullScale: 3, unit: 'V', label: '直流电压 3 V' },
  V15: { mode: 'V', fullScale: 15, unit: 'V', label: '直流电压 15 V' },
};
class Multimeter extends Meter {
  get dial() { return DIALS[this.props.dial] || DIALS.A06; }
  get meterMode() { return this.dial.mode; }
  get meterFull() { return this.dial.fullScale; }
  get meterUnit() { return this.dial.unit; }
}
const multimeterDef = {
  type: 'multimeter', name: '多用电表', domain: PH, cat: '测量仪表', icon: '🅜',
  desc: '一个表多档：含直流电流档与直流电压档，不含欧姆档；电阻读数见面板「等效电阻 R」', w: 62, h: 62,
  ports: [{ x: -40, y: 0, kind: 'wire' }, { x: 40, y: 0, kind: 'wire' }],
  defaults: { dial: 'A06', realistic: true, realR: null },
  tags: ['多用电表', '万用表', '电表', '测量'],
  fields: [{
    k: 'dial', label: '档位', type: 'select',
    options: [
      ['A06', DIALS.A06.label],
      ['A3', DIALS.A3.label],
      ['V3', DIALS.V3.label],
      ['V15', DIALS.V15.label],
    ],
  }],
  create: (x, y) => new Multimeter(multimeterDef, x, y),
};
DEFS.push(() => define(multimeterDef));

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
  // ── B4 第 2 步：面板那处 `if (e.type === 'thermistor')` 已搬到这里（plans/11 §6.3）──
  //    逐字等价：
  //      `(st.temp ?? 25).toFixed(1) + ' ℃'` ⇒ digits:1 + unit:'℃'；
  //      `st.source || '室温'`                 ⇒ 字符串三态（无条件、无映射）；
  //      `fmtR(R)`                             ⇒ **自适应单位**（Ω/kΩ/MΩ），digits/unit 表达不了
  //        ⇒ 用第 3 个接口字段 `fmt`（plans/11 §6.5），把既有函数原样接上。
  //    另注：`R` 的取法原样保留 —— 优先 `resistanceNow()`（NTC 按 B 值算出的实时阻值），
  //    取不到才落回 `state.R`。两者都不在时 fmtR 会给出 '∞'，与迁移前一致。
  stats: [
    { label: '感知温度', unit: '℃', digits: 1, read: (e) => e.state.temp ?? 25 },
    { label: '温度来源', read: (e) => e.state.source || '室温' },
    { label: '当前阻值', fmt: fmtR, read: (e) => (e.resistanceNow ? e.resistanceNow() : e.state.R) },
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
  // ke = 0 时**逐字**返回改动前那条纯电阻支路 —— 不是"数值上等价"：
  // 走 MNA 电压源支路要多吃一个源电流未知量，末位可能与电导装配不同，
  // 而 (B′) 的正当性来源正是「ke=0 下改前改后逐字相同」⇒ 这里用结构性等价。
  circuitBranch() {
    const R = Math.max(1, this.props.resistance);
    const ke = this.props.ke || 0;
    if (!(ke > 0)) return { type: 'R', r: R };
    // 反电动势必须**顶着电流方向**：电机不能被自己的反电动势推着加速。
    // 方向取上一 tick 正解的支路电流 I（与 ω_prev 同一 tick），并且**取反** ——
    // 本求解器的 V 支路报告的电流与被动约定反号（受控实测见 tools/motor-emf-probe.mjs §4：
    // 钉住 I_prev=−0.1、ω_prev=2、ke=0.5 ⇒ emf=+1.0V ⇒ 解得 I=−0.0099 A，
    // 正好是 (1.5−1.0)/50.5；钉住其反号则变成 (1.5+1.0)/50.5=0.0495，即顺电动势助力）。
    // 不取反的话，τ 每 tick 翻一次符号，稳态会跑进"越转越快"那一支。
    // ⚠ 本式依赖求解器的一条**约定**：V 支路报告的电流与被动约定反号（探针 §4 受控实测、§5 常驻守卫）。
    //   若哪天求解器把这条约定改正常，**这里的符号必须同步取反** —— 否则反电动势会静默变成助力
    //   （电机越转越快），而界面读数看起来只是"电流大了一点"。改求解器前先看探针 §5。
    const s = Math.sign(this.state.I || 0);
    return { type: 'V', emf: -s * ke * (this.state.omegaPrev || 0), r: R };
  }
  step(dt) {
    const I = Math.abs(this.state.I || 0);
    const on = I > 0.02;
    this.state.on = on;
    const w = on ? Math.min(30, I * 40) : 0;
    this.state.omega = w;
    // 反电动势用**上一 tick** 的 ω：同一次 solve 里 emf 必须是常量，否则源电压与
    // 源电流互为因果，定点迭代会去追一个不存在的解。emf 本身是电机的真源读数（ke·ω）。
    this.state.emf = -Math.sign(this.state.I || 0) * (this.props.ke || 0) * w;
    this.state.omegaPrev = w;
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
  defaults: { resistance: 8, ratedI: 0.6, ke: 0 },
  tags: ['电动机', '搅拌', '耦合'],
  fields: [
    { k: 'resistance', label: '线圈电阻', type: 'range', min: 1, max: 50, step: 1, unit: 'Ω' },
    { k: 'ratedI', label: '额定电流', type: 'range', min: 0.05, max: 3, step: 0.05, unit: 'A' },
    // 反电动势系数 ke：E = ke·ω（ω 单位 rad/s ⇒ ke 单位 V·s/rad）。默认 0 ⇒ 纯电阻。
    // 只给可声明参数、不内置「按额定点反推」—— 那是产品选择，不是物理量。
    // ⚠ 已知边界：机械侧是退化映射（ω = 40·I，无惯量无负载），所以回路里 ke·40
    //   接近总电阻时 tick 间反馈会振荡；那是机械侧缺真源的性质，不是电气侧新增缺陷。
    { k: 'ke', label: '反电动势系数', type: 'range', min: 0, max: 1, step: 0.05, unit: 'V·s/rad' },
  ],
  // ── B4 第 2 步：面板那处 `if (e.type === 'motor')` 已搬到这里（plans/11 §6.3）──
  //    逐字等价：`st.on ? '转动中' : '停止'` ⇒ 字符串三态原样上屏；
  //             `Math.round(st.omega || 0) + ' rad/s'` ⇒ digits:0 + unit:'rad/s'，
  //             而 fmtBy 的 digits:0 走的正是 `Math.round`（见 inspector.js 里的说明）⇒ 逐字相同。
  stats: [
    { label: '运转状态', read: (e) => (e.state.on ? '转动中' : '停止') },
    { label: '转速', unit: 'rad/s', digits: 0, read: (e) => e.state.omega || 0 },
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
