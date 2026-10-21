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
   * `null` 的语义（四类，均不抛错）：
   *   ① 不是本容器的电极（含不存在的 id、非电极实体）；② 容器里不足两根电极；
   *   ③ 拿不到电极实体（容器没有 world 回指，例如未入世界）；④ 判据量不可用：
   *      非原电池时 |currentU| 与 |currentSigned| 都低于 POLARITY_EPS，或溶液电阻无穷大（不导电）。
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
        return entId === high.id ? 'cathode' : 'anode';                         // 高电位端 = 阴极（还原）
      }
    }

    // ── 电解池：溶液支路确实成立时才读当帧求解结果 ──
    if (!(this.volume > 0) || !isFinite(this.resistance())) return null;        // ④ 不导电 ⇒ 没有 sol: 支路
    const U = Number(this.currentU), I = Number(this.currentSigned);
    const drive = (Number.isFinite(U) && Math.abs(U) > POLARITY_EPS) ? U : I;
    if (!Number.isFinite(drive) || Math.abs(drive) <= POLARITY_EPS) return null; // ④ 无电流 / 无电压
    const anode = drive > 0 ? a : b;                                            // 高电位端 = 阳极（氧化）
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
  }

  // ══════════ 存档 ══════════
  toJSON() {
    return {
      volume: this.volume, temp: this.temp, capacity: this.capacity,
      water: this.water || 0, stir: this.stir,
      mol: [...this.mol], solid: [...this.solid],
      gas: [...this.gas], precip: [...this.precip],
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
