const DEFS = [];
// ══════════════════════════════════════════════════════════
// 物理域 · 热学器材（6 件）
//
// 本模块只做两件事：
//   ① 把热学里有**解析解**的几条规律算对（Q=P·t、热平衡、kAΔT/L、
//      Q=mL、沸点随压强、ΔL=αLΔT），每条都抽成**纯函数导出**，
//      这样 Node 里可以直接拿理论值对账（tools/equipment-thermal.mjs）；
//   ② 接到引擎**已有的**那条耦合总线（src/coupling/bridge.js），不另起一套：
//      · 热源：flame=true + props.lit + props.power
//        → 总线 bridge.js:181-202 会把 P·dt 交给上方容器的 vessel.addHeat()
//      · 容器：自己持有 vessel（VesselModel）
//        → 就能被任何热源加热，也能被温度计借着总线读到读数
//      · 反应热：chemistry/reactions.js 的 apply() 也是 vessel.addHeat(dQ)
//        → 热学与化学**共用同一个热量账本**，中和热才可能对得上
// 实体本身只负责把纯函数接到每帧的 dt 上，以及把它们画出来。
// ══════════════════════════════════════════════════════════

import { Entity, gfx, grad1 } from '../core/entity.js';
import { define } from './registry.js';
import { VesselModel } from '../chemistry/vessel.js';

const PH = 'physics';
const CAT = '热学';

const STEEL = '#39434d', PANEL = '#242c34', DIM = '#8d96a0', TXT = '#e6edf3';
const HOT = '#ff7a5c', WARM = '#ffb454', COOL = '#6cc7ff', ICE = '#bfe6ff', OK = '#4ade80';

// ─────────────────────────────────────────────────────────
// 纯函数：解析解（Node 里逐条对账）
// ─────────────────────────────────────────────────────────
export const C_WATER = 4.18;      // J/(g·K) —— 与 src/chemistry/vessel.js:15 同一个值，故意不另立一个
export const L_FUSION = 334;      // J/g  冰的熔化潜热（0 ℃）
export const L_VAPOR = 2260;      // J/g  水的汽化潜热（100 ℃）
export const R_GAS = 8.314;       // J/(mol·K)
export const M_WATER = 18.015;    // g/mol

/** 加热板放出的热：Q = P·t */
export const heatFromPower = (P, t) => P * t;

/** 温升：ΔT = Q/(m·c) */
export const tempRise = (Q, m, c = C_WATER) => (m > 0 ? Q / (m * c) : 0);

/** 量热器热平衡：T_f = Σ(m_i·c_i·T_i) / Σ(m_i·c_i)（能量守恒的直接推论） */
export function mixTemp(parts) {
  let num = 0, den = 0;
  for (const p of parts) { const hc = p.m * (p.c ?? C_WATER); num += hc * p.T; den += hc; }
  return den > 0 ? num / den : 25;
}

/** 混合体系的总热容 Σ(m·c)，J/K */
export const mixCapacity = (parts) => parts.reduce((s, p) => s + p.m * (p.c ?? C_WATER), 0);

/** 以 T_f 为终点核对能量守恒：吸热总量必须等于放热总量 */
export function mixEnergy(parts, Tf) {
  let absorbed = 0, released = 0;
  for (const p of parts) {
    const hc = p.m * (p.c ?? C_WATER);
    const dQ = hc * (Tf - p.T);
    if (dQ >= 0) absorbed += dQ; else released -= dQ;
  }
  return { absorbed, released };
}

/** 热传导棒稳态热流：dQ/dt = k·A·ΔT/L（W） */
export const conductionFlux = (k, A, Th, Tc, L) => (L > 0 ? k * A * (Th - Tc) / L : 0);

/** 稳态下棒上温度：线性分布，x ∈ [0, L] */
export const barTempAt = (x, L, Th, Tc) => Th + (Tc - Th) * (L > 0 ? x / L : 0);

/** 显式差分推进一帧一维热传导（FTCS）——实体与测试用同一个实现 */
export function barStep(T, dx, alpha, dt, Th, Tc) {
  const n = T.length, next = T.slice();
  for (let i = 1; i < n - 1; i++) {
    next[i] = T[i] + (alpha * dt / (dx * dx)) * (T[i + 1] - 2 * T[i] + T[i - 1]);
  }
  next[0] = Th; next[n - 1] = Tc;         // 两端恒温（Dirichlet）
  return next;
}

/** 从节点温度反算热流：用离散梯度，而不是拿公式直接写答案 */
export const barFluxFromNodes = (T, dx, k, A) => (dx > 0 ? k * A * (T[0] - T[1]) / dx : 0);

/** 熔化潜热：Q = m·L */
export const latentHeat = (m, L = L_FUSION) => m * L;

/**
 * 沸点随压强：克劳修斯-克拉珀龙两点式
 *   1/T = 1/T₀ − R·ln(P/P₀)/ΔH_vap
 * 以 (101.325 kPa, 100 ℃) 为基准点，ΔH_vap = L_vap·M（J/mol）。
 */
export function boilPoint(P, P0 = 101.325, T0 = 100, Lv = L_VAPOR) {
  if (!(P > 0)) return T0;
  const dH = Lv * M_WATER;                 // J/mol
  const T0K = T0 + 273.15;
  const invT = 1 / T0K - R_GAS * Math.log(P / P0) / dH;
  return 1 / invT - 273.15;
}

/** 热膨胀：L(T) = L₀(1 + α·ΔT)，即 ΔL = α·L₀·ΔT */
export const expandLen = (L0, alpha, dT) => L0 * (1 + alpha * dT);

/** 球刚好能过环的临界温度：d₀(1+α·ΔT) = D */
export const passTemp = (d0, D, alpha, T0 = 25) => (alpha > 0 ? T0 + (D / d0 - 1) / alpha : T0);

/** 反应焓 → 热量（J）：Q = |ΔH| · n */
export const reactionHeat = (dH_kJ_per_mol, n_mol) => Math.abs(dH_kJ_per_mol) * n_mol * 1000;

// ─────────────────────────────────────────────────────────
// 通用小工具
// ─────────────────────────────────────────────────────────
/** 按温度取色（25 ℃ 冷蓝 → 400 ℃ 橙红） */
function heatColor(T) {
  const k = Math.max(0, Math.min(1, (T - 20) / 380));
  const r = Math.round(90 + 165 * k), g = Math.round(150 - 40 * k), b = Math.round(220 - 160 * k);
  return `rgb(${r},${g},${b})`;
}
/** 通用金属/陶瓷外壳 */
function shell(g, e, fill = PANEL, edge = STEEL, r = 6) {
  gfx.fillRR(g, -e.w / 2, -e.h / 2, e.w, e.h, r, fill);
  gfx.strokeRR(g, -e.w / 2, -e.h / 2, e.w, e.h, r, edge, 1.5);
}
/** 容器内壁（液体被裁剪在这里） */
function liquidBody(g, e, v, geom) {
  g.save();
  gfx.rr(g, geom.x, geom.y, geom.w, geom.h, 6);
  g.clip();
  const frac = Math.max(0, Math.min(1, v.volume / Math.max(1, v.capacity)));
  const lh = geom.h * frac;
  g.fillStyle = v.color ? `rgb(${v.color[0]},${v.color[1]},${v.color[2]})` : 'rgba(120,190,235,.45)';
  g.fillRect(geom.x, geom.y + geom.h - lh, geom.w, lh);
  g.restore();
}

// ─────────────────────────────────────────────────────────
// 1. 加热板 —— Q = P·t，ΔT = Q/(mc)
//
// 它必须是「热源」才能借到既有总线：bridge.js:182 只认 flame 标记，
// 然后按空间关系把 props.power·dt 交给上方容器的 vessel.addHeat()。
// 自己再去写一套「找上方容器」的检索，会让两条热路径分裂，所以这里复用。
// ─────────────────────────────────────────────────────────
class HotPlate extends Entity {
  flame = true;                       // 热源标记（既有总线读它）
  constructor(def, x, y) {
    super(def, x, y);
    this.state.t = 0;                 // 累计通电时间 s
    this.state.Q = 0;                 // 累计放热 J
    this.state.surf = 25;             // 面板温度 ℃
  }

  step(dt) {
    const P = this.props.lit ? this.props.power : 0;
    this.state.heatOut = P;
    if (P > 0) { this.state.t += dt; this.state.Q += P * dt; }
    // 面板温度：输入功率与散热（牛顿冷却）平衡 → 稳态 T = 25 + P/lossK。
    // 时间常数 τ = m·c/lossK 由板本身的材质决定，所以读数是有物理意义的，不是随便写的数。
    const m = this.props.plateMass, c = 0.90, lossK = this.props.lossK;   // 铝板 ≈ 0.90 J/(g·K)
    const target = 25 + P / lossK;
    this.state.surf += (target - this.state.surf) * Math.min(1, dt * lossK / (m * c));
  }

  render(g) {
    const { w, h } = this;
    const P = this.props.lit ? this.props.power : 0;
    const hot = Math.max(0, Math.min(1, (this.state.surf - 25) / 200));
    // 通电光晕
    const glow = grad1(this, '_gPlate', g, String(Math.round(hot * 40)), () => {
      const gg = g.createRadialGradient(0, 0, 2, 0, 0, w * 0.9);
      gg.addColorStop(0, `rgba(255,140,80,${0.32 * hot})`);
      gg.addColorStop(1, 'rgba(255,140,80,0)');
      return gg;
    });
    g.fillStyle = glow;
    g.beginPath(); g.arc(0, 0, w * 0.9, 0, Math.PI * 2); g.fill();

    shell(g, this, '#23282e', '#3b444d', 7);
    // 面板：温度越高越红
    gfx.fillRR(g, -w / 2 + 7, -h / 2 + 5, w - 14, h - 14, 5, heatColor(this.state.surf));
    // 加热丝纹路
    g.strokeStyle = 'rgba(0,0,0,.22)'; g.lineWidth = 1.2;
    for (let i = -2; i <= 2; i++) {
      g.beginPath();
      g.moveTo(i * 9 - 5, -h / 2 + 9);
      g.lineTo(i * 9 + 5, h / 2 - 9);
      g.stroke();
    }
    // 旋钮
    gfx.fillRR(g, w / 2 - 16, h / 2 - 12, 12, 8, 3, P > 0 ? WARM : '#4a545e');
    gfx.text(g, P > 0 ? `${this.props.power} W` : '待机', 0, h / 2 - 3,
      { color: P > 0 ? '#3a2a18' : DIM, size: 10.5, weight: '600' });
    if (this.state.surf > 40) {
      gfx.text(g, `${this.state.surf.toFixed(0)} ℃`, 0, -h / 2 + 14, { color: '#2a1a10', size: 10.5, weight: '700' });
    }
  }
}
const hotplateDef = {
  type: 'hotplate', name: '加热板', domain: PH, cat: CAT, icon: '🔥',
  desc: '电加热台，功率可调；把容器放在它正上方即可加热（Q = P·t，ΔT = Q/mc）',
  w: 108, h: 30, tags: ['加热', '热源', 'Q=Pt'],
  ports: [],
  fields: [
    { k: 'lit', label: '通电加热', type: 'checkbox', text: '正在加热' },
    { k: 'power', label: '加热功率', type: 'range', min: 100, max: 1200, step: 50, unit: 'W' },
    { k: 'plateMass', label: '板质量', type: 'range', min: 300, max: 3000, step: 100, unit: 'g' },
    { k: 'lossK', label: '散热系数', type: 'range', min: 2, max: 20, step: 0.5, unit: 'W/K' },
  ],
  defaults: { lit: false, power: 600, plateMass: 1200, lossK: 6 },
  state: { t: 0, Q: 0, surf: 25, heatOut: 0 },
  // ── B4 第 3 步 · 热学：4 行，逐字基线取自**跑过 step 的实体**的当前兜底输出 ──
  stats: [
    { label: '加热时长', unit: 's', read: (e) => e.state.t },
    { label: '吸放热', unit: 'J', read: (e) => e.state.Q },
    { label: '表面温度', unit: '℃', read: (e) => e.state.surf },
    { label: '散热功率', unit: 'W', read: (e) => e.state.heatOut },
  ],
  create: (x, y) => new HotPlate(hotplateDef, x, y),
};
DEFS.push(() => define(hotplateDef));

// ─────────────────────────────────────────────────────────
// 2. 量热器 —— 混合法测热平衡
//
// 两个内部水体（热水 m₁/T₁、冷水 m₂/T₂）通过搅拌与量热器本体交换热量，
// 逐帧收敛到解析平衡温度 T_f = ΣmcT/Σmc。本体自己带水当量 C（g），
// 一并折进能量账本 —— 这就是真实量热实验里必须做的修正。
// 内容物仍然由 vessel 统一记账，所以中和反应可以直接在这里跑。
// ─────────────────────────────────────────────────────────
class Calorimeter extends Entity {
  constructor(def, x, y) {
    super(def, x, y);
    this.vessel = new VesselModel(this, this.props.capacity || 300);
    this.vessel.coolK = this.props.coolK;
    this.vessel.temp = this.props.tCold;
    this._hot = { m: this.props.mHot, T: this.props.tHot };   // 热水：尚未倒入的外部热体
    this._last = { mHot: this.props.mHot, tHot: this.props.tHot, mCold: this.props.mCold, tCold: this.props.tCold, calEq: this.props.calEq };
    this._reset();
  }

  /**
   * 三个热体的清单 —— 平衡温度就是这条式子的解。
   * 用的是**初值**（热水设定的 T₁），所以它是「预计平衡温度」，不会随过程漂移。
   */
  parts() {
    return [
      { m: this.props.mHot, T: this.props.tHot },
      { m: this.props.mCold, T: this.props.tCold },
      { m: this.props.calEq, T: this.props.tCold },     // 本体水当量：与冷水同温
    ];
  }

  /**
   * 容器里装的是「冷水 + 量热器水当量」；热水作为外部热体存在。
   * 这样两份水的质量不会被重复计一次，f 走到平衡时的终点正好是 ΣmcT/Σmc。
   */
  _reset() {
    const v = this.vessel;
    v.empty();
    const cold = Math.max(0, this.props.mCold + this.props.calEq);
    v.volume = cold;                                   // mL（ρ=1；水当量按等效水记）
    v.temp = cold > 0 ? this.props.tCold : 25;
    v.mol.set('H2O', v.volume / 18.02);                // 水按溶剂记账（与 addLiquid 一致）
    this._hot = { m: this.props.mHot, T: this.props.tHot };
  }

  geom() { const w = this.w * 0.82, h = this.h * 0.72; return { x: -w / 2, y: -this.h * 0.04, w, h }; }
  insertZone() { const gm = this.geom(); return { x: this.x + gm.x, y: this.y + gm.y, w: gm.w, h: gm.h }; }
  serializeState() { return this.vessel.toJSON(); }
  deserializeState(s) { this.vessel.loadJSON(s); }

  step(dt, world) {
    // 用户动了旋钮 = 重新配一杯：把水温与水量复位成设定值
    for (const k of ['mHot', 'tHot', 'mCold', 'tCold', 'calEq']) {
      if (this.props[k] !== this._last[k]) { this._last[k] = this.props[k]; this._reset(); break; }
    }
    this.vessel.coolK = this.props.coolK;      // 散热系数是活参数

    // 盖子合上才搅拌：热水（外部热体）与容器（冷水 + 水当量）交换热量。
    // 一帧不允许越过平衡点，否则显式步进会来回振荡。
    if (this.props.sealed) {
      const v = this.vessel;
      this._hot.m = this.props.mHot;
      const gap = this._hot.T - v.temp;
      if (Math.abs(gap) > 1e-12) {
        const hcHot = Math.max(1e-9, this._hot.m) * C_WATER;
        const q = this.props.stirK * gap * dt;
        const qMax = hcHot * Math.abs(gap);                  // 最多走到两侧等温
        const use = Math.sign(q) * Math.min(Math.abs(q), qMax);
        v.addHeat(use);
        this._hot.T -= use / hcHot;
      }
    } else {
      this._hot.T = this.props.tHot;
    }
    this.vessel.step(dt, world);                 // 热量账本（含中和反应热与散热）仍然只由 vessel 写
    this.state.Tf = mixTemp(this.parts());       // 解析平衡温度（界面显示用）
    this.state.T1 = this._hot.T;
    this.state.T2 = this.vessel.temp;
  }

  render(g) {
    const { w, h } = this;
    const v = this.vessel;
    shell(g, this, 'rgba(150,170,190,.16)', 'rgba(200,224,240,.5)', 7);
    const gm = this.geom();
    liquidBody(g, this, v, gm);
    gfx.strokeRR(g, gm.x, gm.y, gm.w, gm.h, 6, 'rgba(200,224,240,.35)', 1.2);
    // 内胆（镀银真空层示意）
    gfx.strokeRR(g, -w / 2 + 4, -h / 2 + 4, w - 8, h - 8, 6, 'rgba(200,224,240,.22)', 1);
    // 温度计插孔
    gfx.fillRR(g, -3, -h / 2 - 6, 6, 10, 2, '#c9d4de');
    // 盖
    if (this.props.sealed) gfx.fillRR(g, -w / 2 + 2, -h / 2 - 2, w - 4, 5, 2, '#5a6672');
    // 搅拌棒
    if (this.props.sealed) { gfx.fillRR(g, w / 2 - 14, -h / 2 + 6, 3, h * 0.5, 1.5, '#aeb9c4'); }
    gfx.text(g, `${v.temp.toFixed(1)} ℃`, 0, h / 2 - 8,
      { color: heatColor(v.temp), size: 11.5, weight: '700' });
    gfx.text(g, this.props.sealed ? '搅拌中' : '待混合', 0, -h / 2 + 13, { color: DIM, size: 9.5 });
  }
}
const calorimeterDef = {
  type: 'calorimeter', name: '量热器', domain: PH, cat: CAT, icon: '🥣',
  desc: '混合法量热：热水 m₁T₁ 倒入冷水 m₂T₂，平衡温度 T_f = ΣmcT/Σmc（含水当量修正）',
  w: 96, h: 92, tags: ['量热', '热平衡', '混合法', '中和热'],
  ports: [],
  fields: [
    { k: 'mHot', label: '热水质量', type: 'range', min: 20, max: 250, step: 5, unit: 'g' },
    { k: 'tHot', label: '热水温度', type: 'range', min: 30, max: 95, step: 1, unit: '℃' },
    { k: 'mCold', label: '冷水质量', type: 'range', min: 20, max: 250, step: 5, unit: 'g' },
    { k: 'tCold', label: '冷水温度', type: 'range', min: 0, max: 30, step: 1, unit: '℃' },
    { k: 'calEq', label: '本体水当量', type: 'range', min: 0, max: 60, step: 1, unit: 'g' },
    { k: 'stirK', label: '搅拌传热', type: 'range', min: 2, max: 40, step: 1, unit: 'W/K' },
    { k: 'coolK', label: '散热系数', type: 'range', min: 0, max: 2, step: 0.05, unit: 'W/K' },
    { k: 'sealed', label: '合盖搅拌', type: 'checkbox', text: '开始热交换' },
  ],
  defaults: {
    mHot: 100, tHot: 80, mCold: 100, tCold: 20, calEq: 20, stirK: 25, coolK: 0.35, sealed: false,
    capacity: 300,
  },
  state: { Tf: 25, T1: 80, T2: 20 },
  create: (x, y) => new Calorimeter(calorimeterDef, x, y),
};
DEFS.push(() => define(calorimeterDef));

// ─────────────────────────────────────────────────────────
// 3. 热传导棒 —— 稳态 dQ/dt = kAΔT/L，棒上温度线性分布
//
// 温度剖面不是"画"出来的，是每帧用显式差分（FTCS）真解一维热传导方程得到的；
// 稳态热流再用离散梯度反算，因此它和解析式 kAΔT/L 是两个独立的路径。
// 显式格式有稳定条件 dt ≤ dx²/(2α)，这里按它自动分子步；
// props.speed 是**明示的时间加速**（金属棒真实弛豫要十几分钟，教学里等不起）。
// ─────────────────────────────────────────────────────────
class ConductionBar extends Entity {
  constructor(def, x, y) {
    super(def, x, y);
    this.state.T = null;
    this._initNodes();
  }
  _initNodes() {
    const n = Math.max(5, Math.round(this.props.nodes));
    this.state.T = new Array(n).fill(25);
  }
  /** 几何与物性（cm → m） */
  _phys() {
    const L = this.props.length / 100;
    const A = this.props.area / 1e4;
    const k = this.props.k;
    const rhoC = this.props.rhoC;            // 体积热容 J/(m³·K)
    return { L, A, k, dx: L / (this.state.T.length - 1), alpha: k / rhoC };
  }

  step(dt) {
    const p = this._phys();
    const Th = this.props.tHot, Tc = this.props.tCold;
    const dtMax = p.dx * p.dx / (2 * Math.max(1e-12, p.alpha));
    const frame = dt * this.props.speed;                       // 明示的时间加速
    const sub = Math.max(1, Math.ceil(frame / dtMax));         // 分子步保证稳定
    let T = this.state.T;
    for (let s = 0; s < sub; s++) T = barStep(T, p.dx, p.alpha, frame / sub, Th, Tc);
    this.state.T = T;
    this.state.flux = conductionFlux(p.k, p.A, Th, Tc, p.L);            // 解析稳态
    this.state.fluxBar = barFluxFromNodes(T, p.dx, p.k, p.A);           // 差分反算
    this.state.mid = T[Math.floor(T.length / 2)];
  }

  render(g) {
    const { w, h } = this;
    const n = Math.max(2, this.state.T ? this.state.T.length : 2);
    // 棒身：按节点温度分段上色（线性分布会直接看出来）
    for (let i = 0; i < n - 1; i++) {
      const x0 = -w / 2 + (w * i) / (n - 1), x1 = -w / 2 + (w * (i + 1)) / (n - 1);
      g.fillStyle = heatColor((this.state.T[i] + this.state.T[i + 1]) / 2);
      g.fillRect(x0, -h * 0.22, x1 - x0 + 0.6, h * 0.44);
    }
    gfx.strokeRR(g, -w / 2, -h * 0.22, w, h * 0.44, 4, STEEL, 1.4);
    // 两端热源/冷源
    gfx.fillRR(g, -w / 2 - 13, -h / 2 + 4, 12, h - 8, 3, heatColor(this.props.tHot));
    gfx.fillRR(g, w / 2 + 1, -h / 2 + 4, 12, h - 8, 3, heatColor(this.props.tCold));
    gfx.text(g, `${this.props.tHot}℃`, -w / 2 - 7, h / 2 - 8, { color: WARM, size: 9.5, weight: '600' });
    gfx.text(g, `${this.props.tCold}℃`, w / 2 + 7, h / 2 - 8, { color: COOL, size: 9.5, weight: '600' });
    if (this.state.flux != null) {
      gfx.text(g, `${this.state.flux.toFixed(1)} W`, 0, h / 2 - 8, { color: TXT, size: 10.5, weight: '600' });
      gfx.text(g, `中点 ${this.state.mid.toFixed(1)} ℃`, 0, -h / 2 + 11, { color: DIM, size: 9.5 });
    }
  }
}
const conductionbarDef = {
  type: 'conductionbar', name: '热传导棒', domain: PH, cat: CAT, icon: '▬',
  desc: '一维热传导：稳态热流 dQ/dt = kAΔT/L，棒上温度呈线性分布（差分求解，非贴图）',
  w: 150, h: 34, tags: ['热传导', '傅里叶定律', '线性分布'],
  ports: [],
  fields: [
    { k: 'k', label: '导热系数', type: 'range', min: 40, max: 400, step: 5, unit: 'W/(m·K)' },
    { k: 'rhoC', label: '体积热容', type: 'range', min: 1.5e6, max: 4.5e6, step: 1e5, unit: 'J/(m³·K)' },
    { k: 'length', label: '长度', type: 'range', min: 10, max: 60, step: 2, unit: 'cm' },
    { k: 'area', label: '截面积', type: 'range', min: 1, max: 20, step: 1, unit: 'cm²' },
    { k: 'tHot', label: '热端温度', type: 'range', min: 0, max: 400, step: 5, unit: '℃' },
    { k: 'tCold', label: '冷端温度', type: 'range', min: 0, max: 100, step: 5, unit: '℃' },
    { k: 'nodes', label: '节点数', type: 'range', min: 5, max: 41, step: 2 },
    { k: 'speed', label: '时间加速', type: 'range', min: 1, max: 200, step: 1, unit: '×' },
  ],
  defaults: {
    k: 400, rhoC: 3.45e6, length: 30, area: 4, tHot: 200, tCold: 25, nodes: 13, speed: 60,
  },
  state: { flux: 0, fluxBar: 0, mid: 25 },
  // ── B4 第 3 步 · 热学：3 行 ──
  stats: [
    { label: '热流', unit: 'W', read: (e) => e.state.flux },
    { label: '棒内热流', unit: 'W', read: (e) => e.state.fluxBar },
    { label: '中点温度', unit: '℃', read: (e) => e.state.mid },
  ],
  create: (x, y) => new ConductionBar(conductionbarDef, x, y),
};
DEFS.push(() => define(conductionbarDef));

// ─────────────────────────────────────────────────────────
// 4. 冰水浴 —— 熔化潜热 Q = mL 与熔化平台
//
// 平台不是"把温度写死"，而是把进来的热**记账转到潜热账上**：
//   还有冰 → 热量先用来熔化（Δm = Q/L），温度停在 0 ℃；
//   冰化完 → 同样的热量才开始抬温（ΔT = Q/mc）。
// 环境漏热也走 vessel 自己的散热项，所以"室温下冰自己会化"是真的。
// ─────────────────────────────────────────────────────────
class IceBath extends Entity {
  constructor(def, x, y) {
    super(def, x, y);
    this.vessel = new VesselModel(this, this.props.capacity || 500);
    this.vessel.coolK = this.props.coolK;
    this._lastIce = this.props.ice;
    this._reset();
  }
  _reset() {
    const v = this.vessel;
    v.empty();
    v.volume = this.props.water;
    v.mol.set('H2O', v.volume / 18.02);
    v.temp = this.props.tStart;                 // 冰水混合物：从 0 ℃ 开始
    this.state.mIce = this.props.ice;
    this.state.melted = 0;
    this.state.Qlatent = 0;
  }
  geom() { const w = this.w * 0.84, h = this.h * 0.62; return { x: -w / 2, y: this.h * 0.02, w, h }; }
  insertZone() { const gm = this.geom(); return { x: this.x + gm.x, y: this.y + gm.y, w: gm.w, h: gm.h }; }
  serializeState() { return this.vessel.toJSON(); }
  deserializeState(s) { this.vessel.loadJSON(s); }

  step(dt, world) {
    if (this.props.ice !== this._lastIce) { this._lastIce = this.props.ice; this._reset(); }
    const v = this.vessel;
    v.coolK = this.props.coolK;              // 散热系数是活参数（和 glassware 里 capacity 的用法一致）
    if (this.state.mIce > 1e-9) {
      // 本帧可用热量 = 外界给进来的 + 环境漏热（vessel 的散热项在 0 ℃ 时是净吸热）
      const env = v.coolK * (25 - v.temp) * dt;
      const avail = (v._pendingHeat || 0) + env;
      const need = this.state.mIce * L_FUSION;
      const used = Math.max(0, Math.min(avail, need));
      const melted = used / L_FUSION;
      this.state.mIce -= melted;
      this.state.melted += melted;
      this.state.Qlatent += used;
      // 化出来的水要真的计入容器质量：否则后期升温会按"没化过"的热容算（ΔT 会偏大）
      if (melted > 0) {
        v.volume += melted;                                   // mL（ρ=1）
        v.mol.set('H2O', (v.mol.get('H2O') || 0) + melted / 18.02);
      }
      // 余热（冰化完后才有）交还给 vessel；把 env 减掉是因为 vessel.step 自己还会再加一次
      v._pendingHeat = (avail - used) - env;
      v.temp = this.props.tStart;               // 平台
    }
    this.vessel.step(dt, world);
    if (this.state.mIce <= 1e-9) this.state.mIce = 0;
    this.state.plateau = this.state.mIce > 0;
  }

  render(g) {
    const { w, h } = this;
    const v = this.vessel;
    const gm = this.geom();
    shell(g, this, 'rgba(150,175,195,.14)', 'rgba(190,225,245,.45)', 8);
    liquidBody(g, this, v, gm);
    // 浮冰：按剩余冰量画块数
    const n = Math.min(9, Math.ceil(this.state.mIce / Math.max(1, this.props.ice) * 9));
    for (let i = 0; i < n; i++) {
      const fx = gm.x + 8 + ((i * 37) % Math.max(10, gm.w - 16));
      const fy = gm.y + gm.h - 10 - ((i * 13) % 12);
      gfx.fillRR(g, fx, fy, 11, 8, 2, 'rgba(232,246,255,.85)');
    }
    gfx.text(g, `${v.temp.toFixed(2)} ℃`, 0, -h / 2 + 13, { color: this.state.plateau ? ICE : heatColor(v.temp), size: 11.5, weight: '700' });
    gfx.text(g, this.state.plateau ? `熔化中 · 剩冰 ${this.state.mIce.toFixed(1)} g` : `冰已化完 · 已吸潜热 ${(this.state.Qlatent).toFixed(0)} J`,
      0, h / 2 - 8, { color: DIM, size: 9.5 });
  }
}
const icebathDef = {
  type: 'icebath', name: '冰水浴', domain: PH, cat: CAT, icon: '🧊',
  desc: '冰的熔化：Q = mL（L=334 J/g），熔化期间温度停在 0 ℃ 平台，化完后才按 ΔT = Q/mc 升温',
  w: 118, h: 84, tags: ['相变', '潜热', '熔化平台'],
  ports: [],
  fields: [
    { k: 'ice', label: '冰的质量', type: 'range', min: 10, max: 300, step: 5, unit: 'g' },
    { k: 'water', label: '水的体积', type: 'range', min: 0, max: 400, step: 10, unit: 'mL' },
    { k: 'tStart', label: '平台温度', type: 'range', min: 0, max: 2, step: 0.5, unit: '℃' },
    { k: 'coolK', label: '环境漏热', type: 'range', min: 0, max: 1.5, step: 0.05, unit: 'W/K' },
  ],
  defaults: { ice: 100, water: 200, tStart: 0, coolK: 0.4, capacity: 500 },
  state: { mIce: 100, melted: 0, Qlatent: 0, plateau: true },
  create: (x, y) => new IceBath(icebathDef, x, y),
};
DEFS.push(() => define(icebathDef));

// ─────────────────────────────────────────────────────────
// 5. 沸腾装置 —— 沸点随压强变化 + 水浴加热化学容器
//
// 沸点用克劳修斯-克拉珀龙两点式（以 101.325 kPa / 100 ℃ 为基准点），
// 所以"减压沸点下降"是从公式里出来的，不是查表贴上去的。
// 它同样是热源（flame），因此水浴能通过既有总线真的加热上方容器 ——
// 而容器里的反应速率由 chemistry/reactions.js:216 的 2^((T−25)/10) 决定，
// 于是「热学 → 化学」这条链是通的。
// ─────────────────────────────────────────────────────────
class Boiler extends Entity {
  flame = true;
  constructor(def, x, y) {
    super(def, x, y);
    this.state.waterT = 25;
    this.state.steam = 0;
    this.state.t = 0;
    this.state.bp = boilPoint(this.props.pressure);
  }
  step(dt) {
    const P = this.props.lit ? this.props.power : 0;
    this.state.heatOut = P;
    this.state.t += dt;
    const bp = boilPoint(this.props.pressure);
    this.state.bp = bp;
    const cap = this.props.water * C_WATER;                    // 锅内水的热容 J/K
    let dQ = P * dt - this.props.lossK * (this.state.waterT - 25) * dt;
    if (this.state.waterT >= bp - 1e-9 && dQ > 0) {
      this.state.waterT = bp;                                  // 沸腾平台：温度钉在沸点
      this.state.steam += dQ / L_VAPOR;                         // 多出来的热变成汽化潜热
    } else {
      this.state.waterT = Math.max(0, Math.min(bp, this.state.waterT + dQ / cap));
    }
    this.state.boiling = this.state.waterT >= bp - 1e-6;
  }
  render(g) {
    const { w, h } = this;
    const b = this.state.boiling;
    const gl = grad1(this, '_gBoil', g, String(Math.round(Math.min(1, (this.state.waterT - 25) / 100) * 30)), () => {
      const gg = g.createRadialGradient(0, 0, 2, 0, 0, w);
      gg.addColorStop(0, `rgba(255,150,90,${0.22 * Math.min(1, (this.state.waterT - 25) / 100)})`);
      gg.addColorStop(1, 'rgba(255,150,90,0)');
      return gg;
    });
    g.fillStyle = gl; g.beginPath(); g.arc(0, 0, w, 0, Math.PI * 2); g.fill();
    shell(g, this, 'rgba(160,180,200,.18)', 'rgba(200,224,240,.5)', 6);
    const gm = { x: -w * 0.4, y: -h * 0.1, w: w * 0.8, h: h * 0.46 };
    g.fillStyle = 'rgba(120,190,235,.5)';
    g.fillRect(gm.x, gm.y, gm.w, gm.h);
    // 气泡（位置由 state.t 推出来，不用时钟，便于无头重放）
    if (b) {
      for (let i = 0; i < 4; i++) {
        const bx = gm.x + 8 + ((i * 23) % Math.max(10, gm.w - 16));
        const rise = ((this.state.t * 26 + i * 7) % Math.max(4, gm.h - 8));
        g.beginPath(); g.arc(bx, gm.y + gm.h - 6 - rise, 2, 0, Math.PI * 2);
        g.fillStyle = 'rgba(255,255,255,.6)'; g.fill();
      }
    }
    gfx.text(g, `${this.state.waterT.toFixed(1)} ℃`, 0, -h / 2 + 13, { color: heatColor(this.state.waterT), size: 11, weight: '700' });
    gfx.text(g, `${this.props.pressure.toFixed(0)} kPa · 沸点 ${this.state.bp.toFixed(1)} ℃`, 0, h / 2 - 16, { color: DIM, size: 9.5 });
    gfx.text(g, b ? `沸腾中 · 汽化 ${this.state.steam.toFixed(1)} g` : (this.props.lit ? '加热中' : '未加热'),
      0, h / 2 - 5, { color: b ? HOT : DIM, size: 9.5, weight: b ? '700' : '400' });
  }
}
const boilerDef = {
  type: 'boiler', name: '沸腾装置', domain: PH, cat: CAT, icon: '♨',
  desc: '沸点随压强变化（克劳修斯-克拉珀龙）；作为热源经耦合总线水浴加热上方化学容器',
  w: 112, h: 104, tags: ['沸腾', '沸点', '减压', '水浴'],
  ports: [],
  fields: [
    { k: 'lit', label: '通电加热', type: 'checkbox', text: '正在加热' },
    { k: 'power', label: '加热功率', type: 'range', min: 100, max: 1500, step: 50, unit: 'W' },
    { k: 'pressure', label: '气压', type: 'range', min: 20, max: 200, step: 5, unit: 'kPa' },
    { k: 'water', label: '水量', type: 'range', min: 100, max: 800, step: 50, unit: 'g' },
    { k: 'lossK', label: '散热系数', type: 'range', min: 2, max: 20, step: 0.5, unit: 'W/K' },
  ],
  defaults: { lit: false, power: 800, pressure: 101.325, water: 400, lossK: 5 },
  state: { waterT: 25, steam: 0, bp: 100, boiling: false, heatOut: 0 },
  // ── B4 第 3 步 · 热学：5 行 ──
  stats: [
    { label: '水温', unit: '℃', read: (e) => e.state.waterT },
    { label: '已汽化', unit: 'g', read: (e) => e.state.steam },
    { label: '沸点', unit: '℃', read: (e) => e.state.bp },
    { label: '散热功率', unit: 'W', read: (e) => e.state.heatOut },
    { label: '加热时长', unit: 's', read: (e) => e.state.t },
  ],
  create: (x, y) => new Boiler(boilerDef, x, y),
};
DEFS.push(() => define(boilerDef));

// ─────────────────────────────────────────────────────────
// 6. 热膨胀 —— ΔL = αLΔT 与「球过环」临界温度
//
// 球径随温度走解析式；能不能过环是**算出来**的（d(T) ≤ D 的临界温度 T_c），
// 所以"加热到刚好能过"这件事有确切答案，而不是靠阈值凑。
// ─────────────────────────────────────────────────────────
class ExpansionBall extends Entity {
  constructor(def, x, y) {
    super(def, x, y);
    // render 可能先于第一次 step 被调用（tools/check.mjs §⑩ 就是这个顺序：
    // create → render → step），所以派生字段必须在构造期就算齐。
    this._sync();
  }
  /** 由 props 算出全部派生量；构造函数与 step 共用这一条，避免两处各算一遍而走样 */
  _sync() {
    const a = this.props.alpha * 1e-6;                    // 10⁻⁶/K → 1/K
    this.state.T = this.props.T;                          // 旋钮写在 props，读数落在 state
    const dT = this.state.T - 25;
    this.state.d = expandLen(this.props.d0, a, dT);
    this.state.dL = this.state.d - this.props.d0;
    this.state.Tc = passTemp(this.props.d0, this.props.ringD, a, 25);
    this.state.pass = this.state.d <= this.props.ringD + 1e-9;
  }
  step() { this._sync(); }
  render(g) {
    const { w, h } = this;
    const a = this.props.alpha * 1e-6;
    const d = this.state.d ?? this.props.d0;
    const R = (this.props.ringD / 2) * (w / Math.max(1, this.props.ringD + 6));   // mm → px
    const r = (d / 2) * (w / Math.max(1, this.props.ringD + 6));
    // 环
    g.beginPath(); g.arc(w * 0.22, 0, R, 0, Math.PI * 2);
    g.strokeStyle = this.state.pass ? OK : '#7b8794'; g.lineWidth = 7; g.stroke();
    // 球
    g.beginPath(); g.arc(-w * 0.22, 0, r, 0, Math.PI * 2);
    g.fillStyle = heatColor(this.state.T); g.fill();
    g.strokeStyle = 'rgba(0,0,0,.25)'; g.lineWidth = 1.4; g.stroke();
    gfx.text(g, `${this.state.T.toFixed(0)} ℃`, -w * 0.22, r + 14, { color: heatColor(this.state.T), size: 11, weight: '700' });
    gfx.text(g, `⌀${d.toFixed(3)} / 环 ${this.props.ringD.toFixed(2)} mm`, w * 0.22, R + 14, { color: DIM, size: 9 });
    gfx.text(g, this.state.pass ? '过得去' : '卡住', w * 0.22, -R - 8,
      { color: this.state.pass ? OK : HOT, size: 10.5, weight: '700' });
    gfx.text(g, `临界 ${this.state.Tc.toFixed(0)} ℃`, 0, h / 2 - 4, { color: DIM, size: 9.5 });
  }
}
const expansionballDef = {
  type: 'expansionball', name: '热膨胀球环', domain: PH, cat: CAT, icon: '⚪',
  desc: '固体的线膨胀 ΔL = αLΔT：加热金属球，算出它刚好过不去圆环的临界温度',
  w: 132, h: 60, tags: ['热膨胀', '线膨胀系数', '临界温度'],
  ports: [],
  fields: [
    { k: 'T', label: '球温度', type: 'range', min: 0, max: 600, step: 5, unit: '℃' },
    { k: 'd0', label: '25℃ 球径', type: 'range', min: 30, max: 60, step: 0.1, unit: 'mm' },
    { k: 'ringD', label: '环内径', type: 'range', min: 30, max: 62, step: 0.1, unit: 'mm' },
    { k: 'alpha', label: '线膨胀系数', type: 'range', min: 5, max: 40, step: 0.5, unit: '×10⁻⁶/K' },
  ],
  defaults: { T: 25, d0: 49.6, ringD: 50, alpha: 16.5 },
  state: { d: 49.6, dL: 0, Tc: 0, pass: true },
  // ── B4 第 3 步 · 热学：4 行 ──
  //    ⚠ 末行「球温度」在 `STATE_LABELS.热学` 里**没有**条目（表里只有 `Tc: 当前温度`），
  //      它是由本器材的 `fields` 提供的（`fd.label` 优先于域表，见 `inspector.js:461`）
  //      ⇒ 照兜底写「球温度」+ ℃，不可省略，否则退役热学表后这一行会变样。
  stats: [
    { label: '球径', unit: 'mm', read: (e) => e.state.d },
    { label: '伸长量', unit: 'mm', read: (e) => e.state.dL },
    { label: '当前温度', unit: '℃', read: (e) => e.state.Tc },
    { label: '球温度', unit: '℃', read: (e) => e.state.T },
  ],
  create: (x, y) => new ExpansionBall(expansionballDef, x, y),
};
DEFS.push(() => define(expansionballDef));

// ── 插件 ──────────────────────────────────────────────────
export default {
  id: 'xiaomo.equipment.thermal',
  name: '热学器材',
  version: '1.0.0',
  kind: 'equipment',
  domain: PH,
  desc: '加热板、量热器、热传导棒、冰水浴、沸腾装置、热膨胀球环（均带解析解校验）',
  author: '小墨实验室',
  builtin: true,
  tags: ['物理', '热学', '温度', '相变', '热传导'],
  setup(ctx) { ctx.scope('equipment', () => DEFS.forEach(f => f())); },
};

export { DEFS };
