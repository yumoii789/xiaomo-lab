// ══════════════════════════════════════════════════════════
// 化学域 · 容器模型（VesselModel）
//
// 一个容器 = 体积 + 温度 + 溶质 + 固体 + 沉淀 + 气体。
// 它对外提供两组接口：
//   化学用：amount / conc / consume / produce / pH
//   物理用：ionConc / resistance / addHeat   ← 耦合总线就是靠这几个函数
//           把「电流」和「温度」在理化之间搬运的
// ══════════════════════════════════════════════════════════

import { SP, mixColor } from './species.js';
import { stepVessel } from './reactions.js';
import { bus, EV } from '../core/bus.js';

const C_WATER = 4.18;        // J/(g·K)
const RHO_WATER = 1.0;       // g/mL
// 电极极性契约的「无电流」阈值：溶液支路 U / I 的绝对值低于它就当没通电（含求解器浮点残差）
const POLARITY_EPS = 1e-6;

// ══════════════════════════════════════════════════════════
// P1 电化学：离子迁移 / 电流—离子通量口径 / 电导率分解
//
// 口径（谁按什么算）写在这里、代码按它实现、探针按它断言：
//   · 驱动量：**电流幅度** `electricCurrent`（bridge.distribute 每帧先清后写 ⇒ 必是当帧值）；
//     方向**不读** currentSigned / currentU —— 那两只在 cell: 支路上是上一帧的陈旧值（见 polarityOf 的注释）。
//   · 方向：阴极在哪一侧直接问 `polarityOf()`（task-37 冻结的契约）⇒ 迁移与极性同源，不另造判据。
//   · 迁移数：按**迁移率加权** t_i = c_i·u_i / Σ c_j·u_j，u = |z|·Λ⁰ ⇒ t⁺ + t⁻ = 1（恒等式）。
//   · 搬运量：n_i = Q·t_i / (|z_i|·F)，Q = I·dt（法拉第量级）；源半区不够就夹紧（记 clamped）。
//   · 守恒：迁移只搬不造 ⇒ 逐离子总量守恒、两半区电荷变化互补（Δq_a + Δq_b = 0）。
// ══════════════════════════════════════════════════════════
const F_FARADAY = 96485.33212;   // C/mol
const K_MOLAR = 9.0;             // 既有电导率式子的整体系数 —— 分解时**不改**它
const K_TEMP = 0.02;             // 电导率温度系数 1/K（室温附近 ≈2%/K）
const T_REF = 25;                // ℃，模型读数的参考温度

/**
 * 离子表：电荷 z 与**当量摩尔电导率** Λ⁰（S·cm²/mol，25 ℃，按 1 当量电荷计）。
 *
 * ⚠ 为什么不从名字推 z：本库写法里数字既可能是下标也可能是电荷（`MnO4-` 的 4 是下标、
 *   `Ca2+` 的 2 是电荷），语法上分不开 ⇒ **显式表才是真值**；表外只兜底解析并标 assumed。
 */
const ION = {
  'H+': [1, 350], 'OH-': [-1, 198], 'Na+': [1, 50.1], 'K+': [1, 73.5], 'NH4+': [1, 73.4],
  'Ag+': [1, 61.9], 'Ca2+': [2, 59.5], 'Mg2+': [2, 53.1], 'Cu2+': [2, 53.6], 'Fe2+': [2, 54.0],
  'Fe3+': [3, 68.0], 'Zn2+': [2, 52.8], 'Ba2+': [2, 63.6], 'MnO4-': [-1, 61.3],
  'Cl-': [-1, 76.3], 'NO3-': [-1, 71.4], 'HCO3-': [-1, 44.5], 'CH3COO-': [-1, 40.9],
  'SO4^2-': [-2, 80.0], 'CO3^2-': [-2, 69.3],
};

/** 查表；表外按名字兜底（电荷解析不出 ⇒ null；Λ 用中位数 60 并标 assumed） */
function ionInfo(name) {
  const row = ION[name];
  if (row) return { z: row[0], lambda: row[1], u: Math.abs(row[0]) * row[1], assumed: false };
  const m = /(?:\^(\d+))?(\d*)([+-])$/.exec(String(name));
  if (!m) return null;
  const mag = Number(m[1] || m[2] || 1);
  return { z: m[3] === '+' ? mag : -mag, lambda: 60, u: mag * 60, assumed: true };
}

export class VesselModel {
  constructor(ent, capacity = 250) {
    this.ent = ent;
    this.capacity = capacity;      // mL

    this.volume = 0;               // 液体体积 mL
    this.temp = 25;                // ℃
    this.mol = new Map();          // 溶解态：物质 -> mol
    this.solid = new Map();        // 未溶固体：物质 -> g
    this.gas = new Map();          // 逸出/收集气体：物质 -> mol
    this.precip = new Map();       // 沉淀：物质 -> g

    this.stir = 0;                 // 搅拌强度
    this.light = false;

    // 由耦合总线每帧写入
    this.electricCurrent = 0;      // 通过溶液的电流 A
    this.currentSigned = 0;        // 带符号电流（+ 正向 / − 反向），只给化学层定电解方向 A
    this.currentU = 0;             // 带符号电压（与 currentSigned 同参考方向），供面板出「瞬间电压」V
    this.electrodes = [];          // 插入的电极（**实体 id 列表**，由 coupling/bridge.js 每帧用 `electrodes.map(e => e.id)` 重写）
    // ── P1 电化学 ──
    // 两半区离子账本（**只记离子**的摩尔数）；null == 均匀/整杯混匀（不是「没有数据」）。
    // 两半区按世界顺序：a 区 = electrodes[0] 那一侧，b 区 = electrodes[1] 那一侧。
    this.half = null;
    // 迁移驱动的显式覆盖（null ⇒ 用当帧 electricCurrent）。
    // 为什么留这个口子：原电池容器上 electricCurrent 恒为 0（bridge 只在 sol: 支路写它）
    // ⇒ 纯原电池上迁移不会启动；要补需要耦合层写一行，而 bridge 不在本任务写域。
    this.ionicOverride = null;
    this.lastMigration = null;
    this.heatIn = 0;               // 本帧接收的热功率 W（瞬时）

    this.color = null;
    this.turbidity = 0;
    this.coolK = 0.55;             // 散热系数 W/K
    this._logGate = null;
    this._gasRate = 0;
  }

  // ══════════ 物质操作 ══════════
  amount(id) {
    const inMol = this.mol.get(id) || 0;
    const s = SP[id];
    const inSolid = (this.solid.get(id) || 0) / ((s && s.M) || 100);
    const inPrecip = (this.precip.get(id) || 0) / ((s && s.M) || 100);
    const inGas = this.gas.get(id) || 0;
    return inMol + inSolid + inPrecip + inGas;
  }

  /** 浓度 mol/L（固体按饱和浓度 5 mol/L 折算，便于速率计算） */
  conc(id) {
    const s = SP[id];
    if (s && s.st === 's') return this.solid.has(id) ? 5 : 0;
    if (this.volume <= 0) return 0;
    return (this.mol.get(id) || 0) / (this.volume / 1000);
  }

  has(id) {
    return (this.mol.get(id) || 0) > 1e-9
      || (this.solid.get(id) || 0) > 1e-9
      || (this.precip.get(id) || 0) > 1e-9
      || (this.gas.get(id) || 0) > 1e-9;
  }

  /** 扣掉 mol 数：先扣溶解态，不够再扣固体 */
  consume(id, qty) {
    let left = qty;
    const dis = this.mol.get(id) || 0;
    const useDis = Math.min(dis, left);
    if (useDis > 0) {
      this.mol.set(id, dis - useDis);
      if (this.mol.get(id) < 1e-12) this.mol.delete(id);
      left -= useDis;
    }
    if (left > 1e-12) {
      const s = SP[id];
      const gHave = this.solid.get(id) || 0;
      const gNeed = left * ((s && s.M) || 100);
      const useG = Math.min(gHave, gNeed);
      if (useG > 0) {
        this.solid.set(id, gHave - useG);
        if (this.solid.get(id) < 1e-9) this.solid.delete(id);
      }
    }
  }

  /** 生成 mol 数：按物质状态归入对应集合 */
  produce(id, qty) {
    const s = SP[id] || {};
    if (s.st === 'g') {
      this.gas.set(id, (this.gas.get(id) || 0) + qty);
      this._gasRate += qty;
      return;
    }
    if (s.precip || (s.st === 's' && s.sol === 'insoluble')) {
      this.precip.set(id, (this.precip.get(id) || 0) + qty * (s.M || 100));
      return;
    }
    if (s.st === 's') {
      this.solid.set(id, (this.solid.get(id) || 0) + qty * (s.M || 100));
      return;
    }
    this.mol.set(id, (this.mol.get(id) || 0) + qty);
  }

  /** 倒入液体（mL） */
  addLiquid(id, mL) {
    const s = SP[id] || { M: 100, d: 1 };
    const room = Math.max(0, this.capacity - this.volume);
    const v = Math.min(mL, room);
    if (v <= 0) return this;
    this.volume += v;

    if (id === 'H2O') {
      // 水是溶剂：按 18 g/mol 记摩尔数（电解水、CaO+H2O 都要用到）
      this.mol.set('H2O', (this.mol.get('H2O') || 0) + v / 18.02);
      this.water = (this.water || 0) + v;
    } else {
      // 溶液试剂按标称浓度折算溶质（默认 1 mol/L），而不是按密度
      const conc = s.conc ?? 1;
      this.mol.set(id, (this.mol.get(id) || 0) + (v / 1000) * conc);
      // 随液带入的溶剂水
      this.mol.set('H2O', (this.mol.get('H2O') || 0) + v * 0.94 / 18.02);
    }
    this.updateColor();
    return this;
  }

  /** 加入固体（g） */
  addSolid(id, g) {
    this.solid.set(id, (this.solid.get(id) || 0) + g);
    this.updateColor();
    return this;
  }

  addHeat(joules) {
    this._pendingHeat = (this._pendingHeat || 0) + joules;
  }

  // ══════════ 物理量（供耦合总线读取） ══════════
  /** 内容物总质量 g */
  totalMass() {
    let m = this.volume * RHO_WATER;
    for (const [id, q] of this.mol) {
      if (id === 'H2O') continue;            // 水的质量已经由体积计入，避免算两遍
      m += q * ((SP[id] || {}).M || 100);
    }
    for (const [, g] of this.solid) m += g;
    for (const [, g] of this.precip) m += g;
    return Math.max(1, m);
  }

  /** 自由离子总浓度 mol/L —— 决定导电能力 */
  ionConc() {
    if (this.volume <= 0) return 0;
    let n = 0;
    for (const [id, q] of this.mol) {
      const s = SP[id];
      if (!s || !s.ions) continue;
      const c = q / (this.volume / 1000);
      for (const [, k] of s.ions) n += c * k;
    }
    // 溶解的盐类固体也算（如氯化钠晶体溶解）
    for (const [id, g] of this.solid) {
      const s = SP[id];
      if (!s || !s.ions) continue;
      n += (g / (s.M || 100)) / (this.volume / 1000) * 0.3;
    }
    return n;
  }

  /** 溶液电导率 S/m */
  conductivity() {
    return 9.0 * this.ionConc();
  }

  /** 溶液等效电阻 Ω（电极面积 4 cm²、间距 3 cm） */
  resistance() {
    const k = this.conductivity();
    if (k < 1e-4) return Infinity;
    return (0.03) / (k * 4e-4);
  }
  // ══════════ P1 电化学：离子账本 / 迁移 / 电导率分解 ══════════

  /** 离子账：离子 → 摩尔数（与 ionConc 同源：按 species.ions 的系数折算溶解态） */
  ionMoles() {
    const out = new Map();
    for (const [id, q] of this.mol) {
      const s = SP[id];
      if (!s || !s.ions) continue;
      for (const [ion, k] of s.ions) out.set(ion, (out.get(ion) || 0) + q * k);
    }
    return out;
  }

  /** 溶解态贡献的离子总浓度 mol/L（ionConc 里未溶固体那 30% 的口径单列，好做分解） */
  ionConcDissolved() {
    if (!(this.volume > 0)) return 0;
    let n = 0;
    for (const [, q] of this.ionMoles()) n += q;
    return n / (this.volume / 1000);
  }

  /** 迁移率加权份额（＝迁移数）：t_i = c_i·u_i / Σ c_j·u_j，u = |z|·Λ⁰；Σ t_i = 1 */
  ionShares() {
    const w = new Map();
    let sum = 0;
    for (const [ion, n] of this.ionMoles()) {
      const it = ionInfo(ion);
      const u = it ? it.u : 0;
      const x = u > 0 ? n * u : 0;
      w.set(ion, x);
      sum += x;
    }
    const out = new Map();
    for (const [ion, x] of w) out.set(ion, sum > 0 ? x / sum : 0);
    return out;
  }

  /** 迁移数（按符号归并）：t⁺ + t⁻ = 1（恒等式） */
  transportNumbers() {
    const shares = this.ionShares();
    let tPlus = 0, tMinus = 0;
    const byIon = [];
    for (const [ion, t] of shares) {
      const it = ionInfo(ion);
      if (it && it.z > 0) tPlus += t;
      else if (it && it.z < 0) tMinus += t;
      byIon.push({ ion, z: it ? it.z : null, t });
    }
    return { tPlus, tMinus, byIon };
  }

  /** 离子强度 mol/L（Σ c·z²/2）—— 「这杯溶液有多导电」的可读分解项之一 */
  ionicStrength() {
    if (!(this.volume > 0)) return 0;
    let s = 0;
    for (const [ion, n] of this.ionMoles()) {
      const it = ionInfo(ion);
      if (!it) continue;
      s += n * it.z * it.z;
    }
    return s / 2 / (this.volume / 1000);
  }

  /** 电导率的温度因子（1 + 0.02·(T−25)）；模型读数仍按 25 ℃ 参考值，**不因此改变** */
  tempFactor(tempC) {
    const T = Number.isFinite(tempC) ? tempC : this.temp;
    return 1 + K_TEMP * (T - T_REF);
  }

  /** 温度修正后的电导率 S/m（新 API；模型自己的 conductivity() 一字未改） */
  conductivityAt(tempC) {
    return this.conductivity() * this.tempFactor(tempC);
  }

  /**
   * 电导率分解：把**模型当前读数**按迁移率份额摊到每种离子上 ⇒ 每项可读数。
   * 恒等式：Σ terms.kappa === conductivity()（同一份读数只做分摊，不另算一套）。
   * 未溶固体那 30% 的口径不是可迁移离子 ⇒ 单列一项 fixed，不参与迁移数。
   */
  conductivityTerms() {
    const total = this.conductivity();
    const kDissolved = K_MOLAR * this.ionConcDissolved();
    const kSolid = total - kDissolved;
    const shares = this.ionShares();
    const terms = [];
    for (const [ion, sh] of shares) {
      const it = ionInfo(ion);
      terms.push({
        ion, z: it ? it.z : null, assumed: !!(it && it.assumed),
        mobility: it ? it.u : null, share: sh, kappa: kDissolved * sh,
      });
    }
    if (kSolid > 1e-15) terms.push({ ion: '(未溶固体)', z: 0, mobility: null, share: 0, kappa: kSolid, fixed: true });
    let sum = 0;
    for (const t of terms) sum += t.kappa;
    return { terms, sum, total, kDissolved, kSolid, tempFactor: this.tempFactor(), basis: 'K_MOLAR 归一，按迁移率份额' };
  }

  /** 量纲式电导率 S/m：κ = Σ c·|z|·Λ(T)/10 —— 只做**对照**，不改模型读数 */
  conductivityModel(tempC) {
    if (!(this.volume > 0)) return 0;
    const f = this.tempFactor(tempC);
    let k = 0;
    for (const [ion, n] of this.ionMoles()) {
      const it = ionInfo(ion);
      if (!it) continue;
      k += (n / (this.volume / 1000)) * Math.abs(it.z) * it.lambda * f / 10;
    }
    return k;
  }

  /** 迁移驱动电流 A（当帧 electricCurrent；可被 ionicOverride 显式覆盖） */
  migrationDrive() {
    const raw = (this.ionicOverride === null || this.ionicOverride === undefined) ? this.electricCurrent : this.ionicOverride;
    const I = Math.abs(Number(raw));
    return Number.isFinite(I) ? I : 0;
  }

  /** 给耦合层留的一行口子：显式指定迁移驱动电流（原电池容器上 electricCurrent 恒为 0） */
  setIonicCurrent(I) { this.ionicOverride = (I === null || I === undefined) ? null : Number(I); return this; }

  /** 阴极在哪一侧：直接问极性契约（task-37），不另造判据；给不出 ⇒ null（**宁可不迁移**） */
  polaritySides() {
    const ids = Array.isArray(this.electrodes) ? this.electrodes : [];
    if (ids.length < 2) return null;
    const ra = this.polarityOf(ids[0]), rb = this.polarityOf(ids[1]);
    if (ra === 'cathode' && rb === 'anode') return { cathode: 'a', anode: 'b', contract: 'ok' };
    if (ra === 'anode' && rb === 'cathode') return { cathode: 'b', anode: 'a', contract: 'ok' };
    return null;
  }

  /** 剖面复位：两半区回到「整杯混匀」 */
  resetSplit() { this.half = null; }

  /** 两半区账本与整杯总量对齐（缺项按均匀补、总量变了按比例缩放）—— 守恒由此保证 */
  syncSplit() {
    if (!(this.volume > 0)) { this.half = null; return null; }
    const tot = this.ionMoles();
    if (tot.size === 0) { this.half = null; return null; }
    if (!this.half) {
      const a = new Map(), b = new Map();
      for (const [ion, n] of tot) { a.set(ion, n / 2); b.set(ion, n / 2); }
      this.half = { a, b };
      return this.half;
    }
    for (const side of ['a', 'b']) {
      const m = this.half[side];
      for (const [ion] of [...m]) if (!tot.has(ion)) m.delete(ion);
      for (const [ion, n] of tot) if (!m.has(ion)) m.set(ion, n / 2);
    }
    for (const [ion, n] of tot) {
      const sa = this.half.a.get(ion) || 0, sb = this.half.b.get(ion) || 0;
      const sum = sa + sb;
      if (sum <= 1e-18) { this.half.a.set(ion, n / 2); this.half.b.set(ion, n / 2); continue; }
      const f = n / sum;
      this.half.a.set(ion, sa * f);
      this.half.b.set(ion, sb * f);
    }
    return this.half;
  }

  /**
   * 一次迁移步（法拉第量级）。返回值就是读数：I / Q / 每种离子搬了多少 / 是否夹紧 / 为什么没搬。
   * 「无电流就不迁移」不是额外判断：Q = I·dt = 0 ⇒ 搬运量 0。
   */
  migrate(dt) {
    const info = { I: this.migrationDrive(), Q: 0, transported: 0, chargeMoved: 0, moved: [], clamped: false, sides: null, reason: 'ok', dt: 0 };
    if (!(this.volume > 0)) { info.reason = 'no-liquid'; this.lastMigration = info; return info; }
    if (!(info.I > POLARITY_EPS)) { info.reason = 'no-current'; this.lastMigration = info; return info; }
    const sides = this.polaritySides();
    if (!sides) { info.reason = 'no-polarity'; this.lastMigration = info; return info; }
    info.sides = sides;
    const half = this.syncSplit();
    if (!half) { info.reason = 'no-ions'; this.lastMigration = info; return info; }
    const d = Math.max(0, Number(dt) || 0);
    info.dt = d;
    info.Q = info.I * d;
    const Q = info.Q;
    const shares = this.ionShares();
    for (const [ion, t] of shares) {
      const it = ionInfo(ion);
      if (!it || !it.z || !(t > 0)) continue;
      const want = Q * t / (Math.abs(it.z) * F_FARADAY);       // mol
      if (!(want > 0)) continue;
      const from = it.z > 0 ? sides.anode : sides.cathode;      // 阳离子自阳极区 → 阴极区
      const to = it.z > 0 ? sides.cathode : sides.anode;
      const have = half[from].get(ion) || 0;
      const moved = Math.min(want, have);
      if (!(moved > 0)) { info.clamped = true; continue; }
      if (moved < want - 1e-18) info.clamped = true;
      half[from].set(ion, have - moved);
      half[to].set(ion, (half[to].get(ion) || 0) + moved);
      info.transported += moved;
      info.chargeMoved += Math.abs(it.z) * moved;               // mol 当量电荷
      info.moved.push({ ion, z: it.z, t, want, moved, from, to });
    }
    this.lastMigration = info;
    return info;
  }

  /** 可读的两半区读数（面板 / 台账 / 探针都用它）：离子、z、总量、两半区摩尔数与浓度 */
  ionProfile() {
    const tot = this.ionMoles();
    const half = this.half ? this.syncSplit() : null;
    const sides = this.polaritySides();
    const Vh = Math.max(0, this.volume) / 2;
    const rows = [];
    for (const [ion, n] of tot) {
      const it = ionInfo(ion);
      const a = half ? (half.a.get(ion) || 0) : n / 2;
      const b = half ? (half.b.get(ion) || 0) : n / 2;
      rows.push({
        ion, z: it ? it.z : null, assumed: !!(it && it.assumed), n, nA: a, nB: b,
        cA: Vh > 0 ? a / (Vh / 1000) : 0, cB: Vh > 0 ? b / (Vh / 1000) : 0,
      });
    }
    return { rows, split: !!this.half, uniform: this.half === null, halfVolume: Vh, cathodeSide: sides ? sides.cathode : null };
  }

  hasElectrodes() { return this.electrodes.length >= 2; }

  /**
   * 电极极性契约（plans/20 §五 P0）：给定电极实体 id ⇒ 'cathode' | 'anode' | null。
   *
   * 化学域只说**阴/阳极**（'cathode' = 阴极 = 还原极，'anode' = 阳极 = 氧化极）；
   * 正/负极是**物理域**的口径，不在本契约里出现 —— 两者关系在两种情形下相反：
   *   · 原电池（coupling/bridge.js 造出 `cell:` 支路）：**高电位端 = 阴极**（E0 高的那根金属）；
   *   · 电解池（`sol:` 支路）：**高电位端 = 阳极**（接电源正端那一侧，电流自电解液流向它）。
   * 于是「谁电位高」这**同一条判据量**在两种情形下给出**相反**的阴/阳结论 —— 本契约的全部内容。
   *
   * 判据源一律是**真实求解结果**，不按材料名或摆放位置硬编码：
   *   · 原电池：先镜像 bridge 造 `cell:` 支路的三个条件（≥2 根带 E0 的金属 / ionConc()>0.05 /
   *     ΔE0>0.05），成立才按 ΔE0 比较 —— 与 bridge 的 `emf = ΔE0` 结论同源；
   *   · 电解池：读 `currentU`（= V(电极[0]) − V(电极[1])，由 coupling/bridge.js 从 `rec.U` 写入）。
   *
   * ⚠ 为什么必须先排除原电池再读 currentSigned / currentU：bridge.distribute() 每帧只清
   *   `electrodes` 与 `electricCurrent`，**不清**这两个带符号量 ⇒ `cell:` 支路那一帧它们是
   *   **上一帧的陈旧值**。本方法只在「bridge 必定造出 `sol:` 支路」的那些条件（非原电池 +
   *   volume>0 + resistance() 有限）下才读它们，因此读到的必是当帧结果，不会是陈旧值。
   *
   * `null` 的语义（五类，均不抛错）：
   *   ① 不是本容器的电极（含不存在的 id、非电极实体）；② 容器里不足两根电极；
   *   ③ 拿不到电极实体（容器没有 world 回指，例如未入世界）；④ 判据量不可用：
   *      非原电池时 |currentU| 与 |currentSigned| 都低于 POLARITY_EPS，或溶液电阻无穷大（不导电）；
   *   ⑤ **不在当帧判据对里**（task-37）：判据对 = bridge 当帧真正造出的那条支路的两端 ——
   *      原电池 = `cell:` 的 (high, low)，电解池 = `sol:` 的 (a, b)（都是**世界顺序的前两根**）。
   *      容器里可以插 3 根以上电极，而被挤出电路的那根**不携带电流 ⇒ 没有极性可言**；
   *      过去它 `entId !== anode.id` 就落到阴极分支 ⇒ **non-null 误导**（比 null 更坏）。
   */
  polarityOf(entId) {
    const ids = Array.isArray(this.electrodes) ? this.electrodes : [];
    if (ids.length < 2 || !ids.includes(entId)) return null;                    // ② ①
    const world = this.ent && this.ent.world;
    const ents = ids.map((id) => (world && typeof world.get === 'function' ? world.get(id) : null));
    if (ents.some((e) => !e || !e.probe || e.probe.kind !== 'electrode')) return null;   // ③
    const [a, b] = ents;                    // 与 bridge 的 sol: 支路同序（都是 world 顺序）

    // ── 原电池：镜像 coupling/bridge.js 造 cell: 支路的三个条件 ──
    const metals = ents.filter((e) => e.probe.E0 !== null && e.probe.E0 !== undefined);
    if (metals.length >= 2 && this.ionConc() > 0.05) {
      let low = metals[0], high = metals[0];
      for (const m of metals) {
        if (m.probe.E0 < low.probe.E0) low = m;
        if (m.probe.E0 > high.probe.E0) high = m;
      }
      if (high.probe.E0 - low.probe.E0 > 0.05) {
        // task-37：判据对 = bridge 的 cell: 支路两端 (high, low)；不在这一对里的电极不回答
        if (entId !== high.id && entId !== low.id) return null;                 // ⑤ 被挤出电路
        return entId === high.id ? 'cathode' : 'anode';                         // 高电位端 = 阴极（还原）
      }
    }

    // ── 电解池：溶液支路确实成立时才读当帧求解结果 ──
    if (!(this.volume > 0) || !isFinite(this.resistance())) return null;        // ④ 不导电 ⇒ 没有 sol: 支路
    const U = Number(this.currentU), I = Number(this.currentSigned);
    const drive = (Number.isFinite(U) && Math.abs(U) > POLARITY_EPS) ? U : I;
    if (!Number.isFinite(drive) || Math.abs(drive) <= POLARITY_EPS) return null; // ④ 无电流 / 无电压
    const anode = drive > 0 ? a : b;                                            // 高电位端 = 阳极（氧化）
    // task-37：判据对 = bridge 的 sol: 支路两端 (a, b)；不在这一对里的电极不回答
    if (entId !== a.id && entId !== b.id) return null;                          // ⑤ 被挤出电路
    return entId === anode.id ? 'anode' : 'cathode';
  }

  /** pH 估算 */
  pH() {
    if (this.volume <= 0) return 7;
    let h = 0, oh = 0;
    for (const [id, q] of this.mol) {
      const s = SP[id];
      if (!s || !s.ions) continue;
      const c = q / (this.volume / 1000);
      for (const [ion, k] of s.ions) {
        if (ion === 'H+') h += c * k;
        if (ion === 'OH-') oh += c * k;
      }
    }
    // 水的自电离
    h += 1e-7; oh += 1e-7;
    if (h >= oh) return Math.max(0, -Math.log10(h));
    return Math.min(14, 14 + Math.log10(oh));
  }

  /** 气体总量 mol */
  gasTotal() {
    let n = 0;
    for (const [, q] of this.gas) n += q;
    return n;
  }

  // ══════════ 颜色 ══════════
  updateColor() {
    const list = [];
    const V = Math.max(1, this.volume);
    for (const [id, q] of this.mol) {
      const s = SP[id];
      if (!s || !s.c) continue;
      const c = q / (V / 1000);
      list.push({ c: s.c, w: Math.min(3, c) * 0.5 });
    }
    const ph = this.pH();
    // 指示剂
    if (this.mol.has('Phenolphthalein') && ph > 8.2) list.push({ c: [232, 72, 118], w: 1.6 });
    if (this.mol.has('Litmus')) {
      if (ph < 5) list.push({ c: [214, 74, 74], w: 1.1 });
      else if (ph > 8) list.push({ c: [78, 116, 214], w: 1.1 });
    }
    this.color = mixColor(list);

    this.turbidity = 0;
    for (const [, g] of this.precip) this.turbidity += g;
  }

  // ══════════ 每帧演化 ══════════
  step(dt, world) {
    // 1) 热量结算：外界输入的热 + 反应热 − 向环境散失
    const m = this.totalMass();
    const cap = m * C_WATER;                       // J/K
    let dQ = (this._pendingHeat || 0);
    this._pendingHeat = 0;
    dQ -= this.coolK * (this.temp - 25) * dt;      // 散热
    this.temp += dQ / cap;
    this.temp = Math.max(0, Math.min(2000, this.temp));

    // 2) 反应
    if (this.volume > 0 || this.solid.size > 0) {
      this._gasRate = 0;
      stepVessel(this, dt);
    }

    // 2.5) 离子迁移（P1）：驱动量取**当帧** electricCurrent（main.js 先 distribute 再 world.step）
    this.lastMigration = this.migrate(dt);

    // 3) 颜色
    this.updateColor();
  }

  noteReaction(rule, extent, res) {
    const t = this.ent.worldTime || 0;
    const g = this._logGate;
    if (g && g.id === rule.id && t - g.t < 0.8) return;
    this._logGate = { id: rule.id, t };
    this.lastReaction = rule;
    bus.emit(EV.REACTION, { vessel: this, rule, extent, res, temp: this.temp });
  }

  // ══════════ 倾倒 / 混合 ══════════
  /** 把本容器内容倒一部分到另一个容器 */
  pourInto(other, fraction = 0.6) {
    const f = Math.max(0, Math.min(1, fraction));
    const vol = this.volume * f;
    // ⚠ 目标容器自报「我要接管气体」（collectGas）—— 集气瓶就是这一条能力。
    //    只装气体的容器 volume=0 且无固体 ⇒ 下面**两处**守卫都要为它放行：
    //    守卫①会因 volume=0 且无固体而劝退，即便放过去守卫②也会被 v=0 再拦一次。
    const takeGas = !!other.collectGas && this.gas.size > 0;
    if (vol <= 0 && this.solid.size === 0 && !takeGas) return 0;

    // ⚠ 目标容器可以自报「我只留液体」（retainSolids）—— 过滤就是这一条能力。
    //    · 缺省 undefined ⇒ false ⇒ 既有行为逐字不变；
    //    · 先例：thermal.js:225 也是器材往自己的 vessel 上挂活参数（this.vessel.coolK = …）；
    //    · 沉淀 precip 与气体 gas **本来就不被搬** ⇒ 过滤只需额外处理 solid 这一项。
    const retain = !!other.retainSolids;
    const room = other.capacity - other.volume;
    const v = Math.min(vol, room);
    if (v <= 0 && !takeGas) return 0;   // 守卫②：只装气体时 v 必为 0，也必须放行
    const ratio = vol > 0 ? v / vol : 0;

    other.volume += v;
    this.volume -= v;
    if (this.volume < 1e-6) this.volume = 0;

    for (const [id, q] of [...this.mol]) {
      const move = q * ratio * f;
      if (move <= 0) continue;
      this.mol.set(id, q - move);
      if (this.mol.get(id) < 1e-12) this.mol.delete(id);
      other.mol.set(id, (other.mol.get(id) || 0) + move);
    }
    if (!retain) {
      for (const [id, g] of [...this.solid]) {
        const move = g * f;
        this.solid.set(id, g - move);
        if (this.solid.get(id) < 1e-9) this.solid.delete(id);
        other.solid.set(id, (other.solid.get(id) || 0) + move);
      }
    }
    if (takeGas) {
      // 气体按 f 走：与 solid 同口径 —— 气体不计入 volume，没有容量夹紧问题，不用液体的 ratio·f。
      // 于是仓库里"转移比例"的口径仍然只有两条（液体 ratio·f / 固体·气体 f），本件不扩大那条约定的怪癖。
      for (const [id, q] of [...this.gas]) {
        const move = q * f;
        if (move <= 0) continue;
        this.gas.set(id, q - move);
        if (this.gas.get(id) < 1e-12) this.gas.delete(id);
        other.gas.set(id, (other.gas.get(id) || 0) + move);
      }
    }
    // 混合温度
    const m1 = this.totalMass(), m2 = other.totalMass();
    other.temp = (other.temp * m2 + this.temp * m1 * f) / Math.max(1, m2 + m1 * f);

    this.updateColor(); other.updateColor();
    return v;
  }

  empty() {
    this.volume = 0;
    this.mol.clear();
    this.solid.clear();
    this.gas.clear();
    this.precip.clear();
    this.color = null;
    this.turbidity = 0;
    this.temp = 25;
    // P1：倒空 ⇒ 剖面复位 + 带符号的瞬间量归零（不留陈旧值）
    this.resetSplit();
    this.currentSigned = 0;
    this.currentU = 0;
    this.lastMigration = null;
  }

  // ══════════ 存档 ══════════
  toJSON() {
    return {
      volume: this.volume, temp: this.temp, capacity: this.capacity,
      water: this.water || 0, stir: this.stir,
      mol: [...this.mol], solid: [...this.solid],
      gas: [...this.gas], precip: [...this.precip],
      // P1：两半区剖面随存档走（null = 均匀）
      half: this.half ? { a: [...this.half.a], b: [...this.half.b] } : null,
    };
  }

  loadJSON(o) {
    if (!o) return;
    this.volume = o.volume || 0;
    this.temp = o.temp ?? 25;
    this.capacity = o.capacity || this.capacity;
    this.water = o.water || 0;
    this.stir = o.stir || 0;
    this.mol = new Map(o.mol || []);
    this.solid = new Map(o.solid || []);
    this.gas = new Map(o.gas || []);
    this.precip = new Map(o.precip || []);
    // P1：剖面随存档恢复；带符号的瞬间量**不进存档** ⇒ 读档后归零（不留陈旧值）
    this.half = o.half ? { a: new Map(o.half.a || []), b: new Map(o.half.b || []) } : null;
    this.currentSigned = 0;
    this.currentU = 0;
    this.lastMigration = null;
    this.updateColor();
  }

  /** 给 UI 的摘要 */
  summary() {    const parts = [];
    if (this.volume > 0) parts.push(`液体 ${this.volume.toFixed(0)} mL`);
    let solute = 0;
    for (const [, q] of this.mol) solute += q;
    if (solute > 1e-9) parts.push(`溶质 ${solute.toFixed(3)} mol`);
    if (this.solid.size) {
      let g = 0; for (const [, v] of this.solid) g += v;
      parts.push(`固体 ${g.toFixed(2)} g`);
    }
    if (this.precip.size) {
      let g = 0; for (const [, v] of this.precip) g += v;
      parts.push(`沉淀 ${g.toFixed(2)} g`);
    }
    if (this.gas.size) {
      let n = 0; for (const [, v] of this.gas) n += v;
      parts.push(`气体 ${(n * 24000).toFixed(0)} mL`);
    }
    parts.push(`${this.temp.toFixed(1)} ℃`);
    parts.push(`pH ${this.pH().toFixed(1)}`);
    return parts.join(' · ');
  }
}
