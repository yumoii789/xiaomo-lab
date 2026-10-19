const DEFS = [];
// ══════════════════════════════════════════════════════════
// 物理域 · 电学增量器材（12 件）
//
// 与既有的 src/equipment/electrical.js（10 件：干电池 / 开关 / 小灯泡 /
// 定值电阻 / 滑动变阻器 / 电流表 / 电压表 / 热敏电阻 / 电热丝 / 电动机）
// 的分工——这 12 件专门补「交流、暂态、半导体、三端器件」四块，**逐件不与上面重叠**：
//
//   resistorcap  电容     —— 暂态 RC（既有 10 件全是纯电阻直流）
//   inductorcoil 电感     —— 暂态 RL + 断电自感尖峰（既有没有储能元件）
//   acsource     交流电源 —— 正弦电动势（既有干电池是恒定 EMF）
//   oscilloscope 示波器   —— 波形显示与测量（既有电流表/电压表只显示标量）
//   transformer  变压器   —— 互感变比（既有没有磁路元件）
//   diode        二极管   —— 单向导电 / 半波整流（既有没有非线性元件）
//   photoresistor 光敏电阻 —— 照度→电阻（**连续**非线性，与二极管的开关型相对；相对照度口径）
//   photodiode   光敏二极管 —— 照度≥阈值 ⇒ 光生载流子导通（开关型光电元件）
//   npn / pnp    三极管   —— 电流放大 I_C = β·I_B + 截止/放大/饱和三区（既有没有三端放大器件）
//   nmos / pmos  MOSFET   —— 电压控流 + 截止/可变电阻/恒流三区、跨导 g_m（既有没有场效应器件）
//
// 三条工程约定写在这里，全文件遵守：
//
//   ① **接进真电路，不另造电路**：凡是带接线柱的器材都实现
//      `circuitBranch()`，由 src/physics/circuit.js 的 MNA 求解器统一解算；
//      非线性器件（二极管）用**分段线性支路**表达：导通 = {V, emf=Vf, r=ron}、
//      截止 = {R, r=roff}，开关量取上一帧的端电压。
//      原打算走求解器既有的 `entity.resistanceAt(U, br)` 电阻挂钩（circuit.js:128），
//      但实测**纯电阻式 ON 态会来回抖**（导通时端电压只有 I·ron < Vf，判据自我否定，
//      量到占空比 0%、压降彻底消失），所以改用 V 支路，ON 态自洽 U = Vf + I·ron ≥ Vf。
//      ⚠ 求解器会把 state.I / state.U / state.P / state.R 写回实体
//      （circuit.js:215），所以本文件的暂态量一律另起名字（iL / Uc / emf…），
//      绝不占用那四个键。
//      ⚠ **连续非线性 ≠ 开关非线性**：光敏电阻的 R 是照度的单值函数、没有开关判决，
//      所以它走 `resistanceAt()` 电阻钩子是稳态自洽的；只有二极管的 ON/OFF 才必须绕开它
//      （判据会自我否定，见上）。两件都是非线性，但**只有一件能走电阻钩子**。
//
//   ② **时间由引擎给**：定步长 1/120 s，只实现 `step(dt, world)`，
//      不起自己的 rAF / setInterval。交流相位取自 `world.time`。
//      ⚠ 因此交流频率上限受**采样定理**约束（120 Hz 采样 → 上限取 20 Hz，
//      留足余量），这不是物理限制而是本引擎的数值限制，已写进字段范围。
//
//   ③ 波形显示是**每一帧重算的解析栅格**（不是引擎采样）。
//      声学/高频信号在 1/120 s 下必然混叠，所以显示用解析函数按细步长光栅化，
//      这一点在 acoustics.js 与报告里都写明了。
//
//   ④ **三端器件用「一条器材多条支路」表达**（三极管 B–E / C–E、MOSFET G–S / D–S），
//      每条支路自带 {a,b} 端口对；控制端（基极 / 栅极）**接了线才分叉**，没接就返回 null
//      回落到 `circuitBranch()` 的单支路 —— 与滑动变阻器当变阻器用同一条口径。
//      ⚠ 求解器只有 R / V / open 三种支路，**没有电流源** ⇒ 「受控电流源」这类模型
//      （三极管放大区的 I_C = β·I_B、MOSFET 的 I_D = k·V_ov²）一律**线性化成上一帧量算出的
//      等值电阻**：本帧 solve 里它是常量 ⇒ 矩阵线性；在不动点上电流关系**精确成立**。
//      这不是文件头 ① 禁掉的 `resistanceAt(U)`（那个每轮迭代都被重问 ⇒ 判据自我否定 ⇒ 抖）。
//      ⚠ 判决量（state.region）只在 `step()` 里算一次、`circuitBranches` 只读 ⇒ 不漂移。
//
// 纯计算部分（RC / RL / 整流 / 变比 / 频率测量…）全部 export，
// Node 里可直接 import 断言，见 tools/equipment-electronics.mjs。
// ══════════════════════════════════════════════════════════

import { Entity, gfx } from '../core/entity.js';
import { define } from './registry.js';
import { bus, EV } from '../core/bus.js';
// 面板读数行用求解器自己的单位口径（electrical.js 早就是这么引的）⇒ 报出来的串与
// 「电流 I / 两端电压 U」那四行**同一个格式器**，不会出现两套精度。
import { fmtA, fmtV } from '../physics/circuit.js';

const PH = 'physics';
const CAT = '电学';
const PANEL = '#242c34', EDGE = '#39434d', TXT = '#e6edf3', DIM = '#8d96a0';
const HOT = '#ffd166', OK = '#4ade80', BAD = '#f87171', WIRE = '#9aa7b4';

const TAU = Math.PI * 2;
const D2R = Math.PI / 180, R2D = 180 / Math.PI;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

// ══════════════════════════════════════════════════════════
// 一、纯计算（可被 Node 直接断言）
// ══════════════════════════════════════════════════════════

/** 正弦电动势：U(t) = Up·sin(2πft + φ) */
export function sineEmf(t, Up, f, phiDeg = 0) { return Up * Math.sin(TAU * f * t + phiDeg * D2R); }

/** 峰值 → 有效值（正弦的均方根定义，Up/√2） */
export function rmsFromPeak(Up) { return Up / Math.SQRT2; }

/** 数值有效值：√(⟨u²⟩) —— 用来**独立地**核对 Up/√2 */
export function rmsOf(values) {
  if (!values.length) return 0;
  let s = 0;
  for (const v of values) s += v * v;
  return Math.sqrt(s / values.length);
}
export function meanOf(values) {
  if (!values.length) return 0;
  let s = 0;
  for (const v of values) s += v;
  return s / values.length;
}
export function meanAbsOf(values) {
  if (!values.length) return 0;
  let s = 0;
  for (const v of values) s += Math.abs(v);
  return s / values.length;
}
export function peakToPeak(values) {
  if (!values.length) return 0;
  let lo = Infinity, hi = -Infinity;
  for (const v of values) { if (v < lo) lo = v; if (v > hi) hi = v; }
  return hi - lo;
}

/** 上升过零测频：f = (过零次数 − 1) / (首末过零时间差) */
export function measuredFreq(times, values) {
  const cross = [];
  for (let i = 1; i < values.length; i++) {
    if (values[i - 1] < 0 && values[i] >= 0) {
      const d = values[i] - values[i - 1];
      const frac = d !== 0 ? -values[i - 1] / d : 0;
      cross.push(times[i - 1] + frac * (times[i] - times[i - 1]));
    }
  }
  if (cross.length < 2) return NaN;
  return (cross.length - 1) / (cross[cross.length - 1] - cross[0]);
}
/** 上升过零时刻表（相位断言用） */
export function upCrossings(times, values) {
  const out = [];
  for (let i = 1; i < values.length; i++) {
    if (values[i - 1] < 0 && values[i] >= 0) {
      const d = values[i] - values[i - 1];
      out.push(times[i - 1] + (d !== 0 ? -values[i - 1] / d : 0) * (times[i] - times[i - 1]));
    }
  }
  return out;
}

/** RC 时间常数：R[kΩ] · C[µF] = 10³·10⁻⁶ s = 1e-3 s */
export function rcTau(Rkohm, Cuf) { return Rkohm * Cuf * 1e-3; }

/** RC 充电解析解 Uc(t) = U₀(1 − e^(−t/τ)) */
export function rcAnalytic(U0, tau, t) { return U0 * (1 - Math.exp(-t / tau)); }
/** RC 放电解析解 Uc(t) = U₀·e^(−t/τ) */
export function rcDecay(U0, tau, t) { return U0 * Math.exp(-t / tau); }

/**
 * RC 充电的前向欧拉积分轨迹（**故意**用欧拉：定步长实时仿真就是这么走的，
 * 于是「实测 63.2% 时刻」与 τ 的偏差里含有真实的离散化误差，
 * 这个断言才有意义；解析解另给 rcAnalytic 作独立对照）。
 * @returns {Array<{t:number, u:number}>}
 */
export function rcEulerTraj(U0, tau, dt, n) {
  const out = [{ t: 0, u: 0 }];
  let u = 0;
  for (let i = 0; i < n; i++) {
    u += ((U0 - u) / tau) * dt;
    out.push({ t: (i + 1) * dt, u });
  }
  return out;
}

/** 轨迹里第一次达到 pct 比例的时刻（线性插值），pct=0.632 就是时间常数 */
export function crossingTime(traj, U0, pct = 0.632) {
  const target = U0 * pct;
  for (let i = 1; i < traj.length; i++) {
    if (traj[i].u >= target) {
      const du = traj[i].u - traj[i - 1].u;
      const f = du !== 0 ? (target - traj[i - 1].u) / du : 0;
      return traj[i - 1].t + f * (traj[i].t - traj[i - 1].t);
    }
  }
  return NaN;
}

/** RL 时间常数：τ = L/R（L 用 mH） */
export function rlTau(LmH, Rohm) { return (LmH / 1000) / Rohm; }
/** RL 通电解析解 i(t) = (U₀/R)(1 − e^(−t/τ)) */
export function rlAnalytic(U0, R, tau, t) { return (U0 / R) * (1 - Math.exp(-t / tau)); }
/** RL 断电解析解 i(t) = I₀·e^(−t/τ') */
export function rlDecay(I0, tau, t) { return I0 * Math.exp(-t / tau); }
/** 前向欧拉 RL 通电轨迹 */
export function rlEulerTraj(U0, R, L_H, dt, n) {
  const out = [{ t: 0, i: 0 }];
  let i = 0;
  for (let k = 0; k < n; k++) {
    i += ((U0 - i * R) / L_H) * dt;
    out.push({ t: (k + 1) * dt, i });
  }
  return out;
}
/** 断电瞬间的自感电动势：U_L = −L·di/dt ≈ I₀·R_弧（理想瞬时断路会发散，用弧阻封顶） */
export function selfInduction(I0, Rarc) { return I0 * Rarc; }

/** 二极管导通起始角 θ₀ = arcsin(Vf/Up)（弧度；Vf≤0 时全程导通，θ₀=0） */
export function conductionAngle(vf, Up) {
  if (!(vf > 0)) return 0;
  const r = vf / Up;
  return r >= 1 ? Math.PI / 2 : Math.asin(r);
}
/**
 * 半波整流后的**平均值**（解析式，用来与数值积分对撞）
 *   Vf = 0 ：⟨u⟩ = Up/π
 *   Vf > 0 ：⟨u⟩ = (1/π)[Up·cosθ₀ − Vf·(π/2 − θ₀)]
 * （对 u = Up·sinθ − Vf 在导通区间 [θ₀, π−θ₀] 上积分再取平均）
 */
export function halfWaveMean(Up, vf = 0) {
  if (!(vf > 0)) return Up / Math.PI;
  const t0 = conductionAngle(vf, Up);
  const v = Up * Math.cos(t0) - vf * (Math.PI / 2 - t0);
  return Math.max(0, v / Math.PI);
}
/** 全波整流（桥式）平均值 = 2Up/π —— 留给对照，不单独出器材 */
export function fullWaveMean(Up) { return (2 * Up) / Math.PI; }

/** 理想变压器：U₁/U₂ = N₁/N₂、I₁/I₂ = N₂/N₁、P₁ = P₂ */
export function transformer(U1, N1, N2, RL) {
  const U2 = U1 * (N2 / N1);
  const I2 = RL > 0 ? U2 / RL : 0;
  const I1 = I2 * (N2 / N1);
  const P1 = U1 * I1, P2 = U2 * I2;
  return { U1, U2, I1, I2, P1, P2, k: U2 !== 0 ? U1 / U2 : NaN, eta: P1 > 0 ? P2 / P1 : 0 };
}

/** 找最近的「会发出信号」的器材（交流电源 / 任何实现了 signalAt 的器材） */
export function nearestSignal(world, self, maxDist = 1e9) {
  let best = null, bd = maxDist;
  for (const e of world.entities) {
    if (e === self || typeof e.signalAt !== 'function') continue;
    const d = Math.hypot(e.x - self.x, e.y - self.y);
    if (d < bd) { bd = d; best = e; }
  }
  return best;
}

/**
 * 三极管工作区判据（纯函数，tools/transistor-probe.mjs 直接 import 断言）。
 * 入参一律是**同一朝向的幅值口径**（UBE=|U_BE|、UCE=|U_CE|、IB=|I_B|、IC=|I_C|），
 * NPN / PNP 共用同一套式子（极性由支路 emf 的符号 s 承担，不进这里）。
 *
 *   截止 cutoff：UBE ≤ Vbe(on)  —— 发射结没正偏
 *   饱和 sat   ：β·IB > IC（外部回路把集电极电流压在 β·IB 以下）或 UCE < Vce(sat)（集电结也正偏了）
 *   放大 active：其余
 *
 * ⚠ 为什么以**电流比**为主判据、而不是「UCE < Vce(sat)」一条：见 Bjt 类头的抖动分析
 *   （两个模型会互相否定 ⇒ 2 帧周期的 ON/OFF 抖动，与二极管第一版同一种病）。
 */
export function bjtRegion({ UBE, UCE, IB, IC, beta, vbeOn, vceSat }) {
  if (!(UBE > vbeOn)) return 'cutoff';
  if (beta * IB > IC || UCE < vceSat) return 'sat';
  return 'active';
}

/**
 * MOSFET 输出特性（纯函数，探针直接 import 断言）。入参是同一朝向的幅值口径
 * （N 沟道用 UGS / VDS，P 沟道用 |VGS| / |VDS|），N / P 沟道共用同一套式子。
 * k 单位 A/V²，Vov = UGS − Vth 是过驱电压。
 *
 *   截止       cutoff：UGS ≤ Vth ⇒ ID = 0
 *   可变电阻区 triode：VDS <  Vov ⇒ ID = k·(2·Vov·VDS − VDS²)
 *   恒流区     sat   ：VDS ≥ Vov ⇒ ID = k·Vov²
 *
 * ⚠ 两段在 VDS = Vov 处**取值相同**（都是 k·Vov²），给出的等值电阻 UDS/ID 也相同
 *   ⇒ 接缝连续，判决在两段之间翻转不产生抖动（这正是它与二极管/三极管必须改用
 *   电流判据的区别：那两个的 ON 态端电压会自我否定，这个不会）。
 * ⚠ 跨导分段：可变电阻区 gm = k·VDS（随 VDS 线性长），恒流区 gm = 2·k·Vov。
 */
export function mosLaw(UGS, UDS, vth, k) {
  const vov = UGS - vth;
  if (!(vov > 0)) return { region: 'cutoff', vov: 0, id: 0, gm: 0 };
  if (UDS < vov) {
    const id = k * (2 * vov * UDS - UDS * UDS);
    return { region: 'triode', vov, id: Math.max(0, id), gm: k * UDS };
  }
  return { region: 'sat', vov, id: k * vov * vov, gm: 2 * k * vov };
}

/** 画一段波形折线（局部坐标） */
function poly(g, pts, color, lw = 1.4) {
  if (pts.length < 2) return;
  g.strokeStyle = color; g.lineWidth = lw;
  g.beginPath();
  g.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]);
  g.stroke();
}
/** 器材外壳 */
function shell(g, w, h, title) {
  gfx.fillRR(g, -w / 2, -h / 2, w, h, 6, PANEL);
  gfx.strokeRR(g, -w / 2, -h / 2, w, h, 6, EDGE, 1.2);
  return title;
}
/** 接线柱小圆 */
function dot(g, x, y, color = WIRE) {
  g.fillStyle = color; g.beginPath(); g.arc(x, y, 2.6, 0, TAU); g.fill();
}

// ══════════════════════════════════════════════════════════
// 二、器材 1：电容（RC 暂态）
// ══════════════════════════════════════════════════════════
class ResistorCap extends Entity {
  /** 漏电阻：让它能真的并进电路（真电容也有漏电，取 1 GΩ 量级，对电路影响 <1e-9 S） */
  circuitBranch() { return { type: 'R', r: 1e9 }; }

  onProp(k) { if (k === 'mode' || k === 'C' || k === 'R' || k === 'U0') this.reset(); }

  reset() {
    this.state.t = 0; this.state.t63 = NaN; this.state.Uc = 0;
    this.state.i = 0; this.state.traj = [];
    this.resetDone = true;
  }

  step(dt) {
    const R = Math.max(0.1, this.props.R) * 1e3;          // kΩ → Ω
    const C = Math.max(1, this.props.C) * 1e-6;           // µF → F
    const tau = R * C;
    const U0 = this.props.U0;
    if (!this.resetDone) this.reset();

    if (this.props.mode === 'discharge') {
      // 放电：从当前 Uc 起按 e^(−t/τ) 走（欧拉）
      this.state.Uc += (-this.state.Uc / tau) * dt;
      this.state.i = this.state.Uc / R;
      this.state.pct = U0 > 0 ? this.state.Uc / U0 : 0;
    } else {
      this.state.Uc += ((U0 - this.state.Uc) / tau) * dt;
      this.state.i = (U0 - this.state.Uc) / R;
      this.state.pct = U0 !== 0 ? this.state.Uc / U0 : 0;
    }
    this.state.t += dt;
    if (this.props.mode !== 'discharge' && !(this.state.t63 >= 0) && this.state.Uc >= 0.632 * U0) {
      this.state.t63 = this.state.t;          // 与 t 同刻度，避免差一步的偏置
    }
    this.state.tau = tau;
    this.state.tEnd = 3 * tau;
    // 轨迹：只留最近 3τ 的一段（画图用），按时间抽稀
    const tr = this.state.traj;
    tr.push([this.state.t, this.state.Uc]);
    while (tr.length > 2 && tr[tr.length - 1][0] - tr[0][0] > 3.05 * tau) tr.shift();
  }

  render(g) {
    const { w, h } = this;
    shell(g, w, h, 'C');
    const bx = -w / 2 + 12, by = -h / 2 + 6, bw = w - 24, bh = 26;
    // 电容符号：两块极板
    g.strokeStyle = TXT; g.lineWidth = 2;
    g.beginPath(); g.moveTo(-8, by + 6); g.lineTo(-8, by + bh - 6); g.stroke();
    g.beginPath(); g.moveTo(8, by + 6); g.lineTo(8, by + bh - 6); g.stroke();
    g.strokeStyle = WIRE; g.lineWidth = 1.6;
    g.beginPath(); g.moveTo(bx, by + bh / 2); g.lineTo(-8, by + bh / 2); g.stroke();
    g.beginPath(); g.moveTo(8, by + bh / 2); g.lineTo(bx + bw, by + bh / 2); g.stroke();
    dot(g, -w / 2 + 3, 0); dot(g, w / 2 - 3, 0);

    // Uc(t) 曲线：横轴 0…3τ，纵轴 0…U0
    const gx = -w / 2 + 10, gy = 2, gw = w - 20, gh = h / 2 - 12;
    g.strokeStyle = EDGE; g.lineWidth = 1;
    g.strokeRect(gx, gy, gw, gh);
    const tEnd = Math.max(1e-6, this.state.tEnd || 1);
    const U0 = Math.max(1e-6, Math.abs(this.props.U0));
    const pts = [];
    for (const [t, u] of this.state.traj) {
      pts.push([gx + clamp(t / tEnd, 0, 1) * gw, gy + gh - clamp(u / U0, 0, 1) * gh]);
    }
    // 63.2% 参考线
    g.strokeStyle = HOT; g.globalAlpha = 0.5; g.setLineDash([3, 3]); g.lineWidth = 1;
    g.beginPath(); g.moveTo(gx, gy + gh * (1 - 0.632)); g.lineTo(gx + gw, gy + gh * (1 - 0.632)); g.stroke();
    g.setLineDash([]); g.globalAlpha = 1;
    poly(g, pts, OK, 1.6);

    gfx.text(g, `τ=${(this.state.tau || 0).toFixed(3)}s  Uc=${(this.state.Uc || 0).toFixed(3)}V`,
      0, gy + gh + 10, { color: TXT, size: 9.5 });
    gfx.text(g, (this.state.t63 >= 0
      ? `实测 63.2%：${this.state.t63.toFixed(3)}s（${(100 * this.state.t63 / (this.state.tau || 1)).toFixed(1)}%τ）`
      : `充电中 ${(100 * (this.state.pct || 0)).toFixed(1)}%`),
      0, gy + gh + 20, { color: this.state.t63 >= 0 ? OK : DIM, size: 9 });
  }
}
const capDef = {
  type: 'resistorcap', name: '电容（RC 电路）', domain: PH, cat: CAT, icon: '∥',
  desc: 'RC 充电/放电：τ = RC，充电到 63.2% 用掉一个时间常数（欧拉积分实时演化）',
  w: 92, h: 84,
  ports: [{ x: -46, y: 0, kind: 'wire', label: 'A' }, { x: 46, y: 0, kind: 'wire', label: 'B' }],
  defaults: { C: 100, R: 10, U0: 6, mode: 'charge' },
  state: { tau: 0, Uc: 0, t: 0, t63: NaN, i: 0, pct: 0, traj: [] },
  tags: ['电容', 'RC', '时间常数', '暂态', '储能'],
  fields: [
    { k: 'C', label: '电容 C', type: 'range', min: 1, max: 1000, step: 1, unit: 'µF' },
    { k: 'R', label: '串联电阻 R', type: 'range', min: 0.5, max: 200, step: 0.5, unit: 'kΩ' },
    { k: 'U0', label: '电源电压', type: 'range', min: 1, max: 24, step: 0.5, unit: 'V' },
    { k: 'mode', label: '状态', type: 'select', options: [['charge', '充电'], ['discharge', '放电']] },
  ],
  create: (x, y) => new ResistorCap(capDef, x, y),
};
DEFS.push(() => define(capDef));

// ══════════════════════════════════════════════════════════
// 三、器材 2：电感（RL 暂态 + 断电自感）
// ══════════════════════════════════════════════════════════
class InductorCoil extends Entity {
  /**
   * 直流稳态下线圈就是它自己的绕组电阻，所以电路求解器拿到的是 R
   * （于是 state.I 的稳态解 = U/R，物理正确）；暂态 iL 由本器材自己积分。
   * 两者在 t ≫ τ 时应当一致 —— 这正是「两条独立路径对撞」的断言。
   */
  circuitBranch() {
    return { type: 'R', r: this.props.closed ? Math.max(0.1, this.props.R) : 1e6 };
  }

  onProp(k, v, old) {
    if (k === 'closed') {
      if (!v) {
        // 断电：这一瞬间的电流就是自感尖峰的源头
        this.state.i0break = this.state.iL || 0;
        this.state.spike = selfInduction(this.state.i0break, 1e6);
        this.state.tauOpen = rlTau(this.props.L, 1e6);
        this.state.breaking = true;
      } else {
        this.state.breaking = false; this.state.spike = 0; this.state.t = 0;
      }
    }
    if (k === 'L' || k === 'R' || k === 'U0') { this.state.t = 0; this.state.spike = 0; this.state.breaking = !this.props.closed; }
  }

  step(dt) {
    const L = Math.max(1, this.props.L) / 1000;      // mH → H
    const R = Math.max(0.1, this.props.R);
    // 接进真电路时用**求解器给出的真实端电压**（含电源内阻/其它元件的压降），
    // 没接线时退回自己的 U0 —— 于是稳态 iL 应当与求解器的 I 一致，可对撞。
    const wired = Math.abs(this.state.U || 0) > 1e-6;
    const U0 = wired ? Math.abs(this.state.U) : this.props.U0;
    this.state.fromCircuit = wired;
    this.state.tau = L / R;
    this.state.tauOpen = L / 1e6;
    if (this.props.closed) {
      this.state.iL = (this.state.iL || 0) + ((U0 - (this.state.iL || 0) * R) / L) * dt;
      this.state.breaking = false;
    } else if (this.state.breaking) {
      this.state.iL = (this.state.iL || 0) * Math.exp(-dt / (L / 1e6));
      if (this.state.iL < 1e-6) { this.state.iL = 0; this.state.breaking = false; }
    } else {
      this.state.iL = 0;
    }
    this.state.t += dt;
    this.state.uL = -L * (((this.state.iL || 0) - 0) / Math.max(dt, 1e-9));   // 仅显示用
    this.state.iSteady = U0 / R;
    // 轨迹
    const tr = this.state.traj || (this.state.traj = []);
    tr.push([this.state.t, this.state.iL || 0]);
    while (tr.length > 400) tr.shift();
  }

  render(g) {
    const { w, h } = this;
    shell(g, w, h, 'L');
    // 线圈符号
    const cy = -h / 2 + 18;
    g.strokeStyle = TXT; g.lineWidth = 1.8;
    g.beginPath();
    for (let i = 0; i <= 24; i++) {
      const x = -w / 2 + 14 + (i / 24) * (w - 28);
      const y = cy + Math.sin((i / 24) * TAU * 3) * 5;
      i ? g.lineTo(x, y) : g.moveTo(x, y);
    }
    g.stroke();
    dot(g, -w / 2 + 3, 0); dot(g, w / 2 - 3, 0);

    // i(t) 曲线
    const gx = -w / 2 + 10, gy = 8, gw = w - 20, gh = h / 2 - 16;
    g.strokeStyle = EDGE; g.lineWidth = 1; g.strokeRect(gx, gy, gw, gh);
    const iMax = Math.max(1e-9, this.state.iSteady || 1);
    const tr = this.state.traj || [];
    const tMax = Math.max(1e-6, tr.length ? tr[tr.length - 1][0] : 1, 3 * (this.state.tau || 1));
    poly(g, tr.map(([t, i]) => [gx + clamp(t / tMax, 0, 1) * gw, gy + gh - clamp(i / iMax, 0, 1) * gh]), OK, 1.6);

    gfx.text(g, `τ=L/R=${(this.state.tau || 0).toFixed(3)}s  i=${(this.state.iL || 0).toFixed(3)}A`,
      0, gy + gh + 10, { color: TXT, size: 9.5 });
    gfx.text(g, this.state.spike > 0
      ? `断电自感尖峰 ${(this.state.spike / 1000).toFixed(1)} kV`
      : `稳态 i=U/R=${(this.state.iSteady || 0).toFixed(3)}A`,
      0, gy + gh + 20, { color: this.state.spike > 0 ? HOT : DIM, size: 9 });
  }
}
const coilDef = {
  type: 'inductorcoil', name: '电感线圈（RL 电路）', domain: PH, cat: CAT, icon: '〰',
  desc: 'RL 暂态：τ = L/R；断开开关瞬间电流被强迫归零，自感电动势 U = I₀·R_弧 形成尖峰',
  w: 92, h: 78,
  ports: [{ x: -46, y: 0, kind: 'wire', label: 'A' }, { x: 46, y: 0, kind: 'wire', label: 'B' }],
  defaults: { L: 2000, R: 10, U0: 6, closed: true },
  state: { tau: 0, iL: 0, iSteady: 0, t: 0, spike: 0, breaking: false, uL: 0, traj: [] },
  tags: ['电感', 'RL', '时间常数', '自感', '暂态'],
  fields: [
    { k: 'L', label: '电感 L', type: 'range', min: 100, max: 5000, step: 100, unit: 'mH' },
    { k: 'R', label: '绕组电阻 R', type: 'range', min: 1, max: 100, step: 1, unit: 'Ω' },
    { k: 'U0', label: '电源电压', type: 'range', min: 1, max: 24, step: 0.5, unit: 'V' },
    { k: 'closed', label: '开关闭合', type: 'checkbox' },
  ],
  create: (x, y) => new InductorCoil(coilDef, x, y),
};
DEFS.push(() => define(coilDef));

// ══════════════════════════════════════════════════════════
// 四、器材 3：交流电源
// ══════════════════════════════════════════════════════════
class AcSource extends Entity {
  /** 瞬时电动势：求解器每次调用都会重新取（circuit.js:81 的 getBr 是闭包） */
  signalAt(t) { return sineEmf(t, this.props.Up, this.props.f, this.props.phi); }
  emfNow() { return this.signalAt(this.state.t || 0); }

  circuitBranch() { return { type: 'V', emf: this.emfNow(), r: Math.max(0.001, this.props.r) }; }

  onProp() { this.state.t = 0; this.state.buf = []; this.state.bufT = []; this.state.ibuf = []; this.state.ibufT = []; }

  step(dt, world) {
    this.state.t = world.time;
    this.state.emf = this.emfNow();
    this.state.Urms = rmsFromPeak(this.props.Up);
    this.state.T = 1 / Math.max(1e-6, this.props.f);
    // 实测有效值：滚动一个周期的缓冲，用来独立核对 Up/√2
    const buf = this.state.buf || (this.state.buf = []);
    const bt = this.state.bufT || (this.state.bufT = []);
    buf.push(this.state.emf); bt.push(this.state.t);
    const n = Math.ceil(this.state.T / dt) + 1;
    while (buf.length > n) { buf.shift(); bt.shift(); }
    this.state.rmsMeas = rmsOf(buf);
    this.state.pp = peakToPeak(buf);
    // 电流半边：与上面**逐字同构**的逐拍缓冲（同一窗口长度 n、同样的推移方式、同一个 rmsOf 口径）。
    //   ⚠ 为什么允许同构：rmsOf 取的是 √⟨i²⟩，**对符号免疫** —— 交流换向、
    //     以及 V 支路与器材端口朝向不一致带来的整体符号翻转，都不会污染有效值，
    //     所以不需要为电流另定一套口径（这正是本件不必"停下来报"的理由）。
    //   ⚠ 为什么推的是 state.I：它是求解器在**同一次 solve 里**注入的
    //     （与 state.emf 同拍、无半拍偏移），所以这里记的就是"这一拍的电流"。
    //   ⚠ 未接线时求解器不注入 I ⇒ 读到 undefined ⇒ 记 0（与"没有电流"一致，不是缺失值）。
    const cbuf = this.state.ibuf || (this.state.ibuf = []);
    const cbt = this.state.ibufT || (this.state.ibufT = []);
    cbuf.push(this.state.I || 0); cbt.push(this.state.t);
    while (cbuf.length > n) { cbuf.shift(); cbt.shift(); }
    this.state.rmsI = rmsOf(cbuf);
    this.state.tLast = this.state.t;
  }

  render(g) {
    const { w, h } = this;
    shell(g, w, h, '~');
    const cy = -h / 2 + 22;
    g.strokeStyle = EDGE; g.lineWidth = 1;
    g.beginPath(); g.moveTo(-w / 2 + 8, cy); g.lineTo(w / 2 - 8, cy); g.stroke();
    // 一个周期的正弦
    const pts = [];
    for (let i = 0; i <= 60; i++) {
      const ph = (i / 60) * TAU;
      pts.push([-w / 2 + 8 + (i / 60) * (w - 16), cy - Math.sin(ph) * 14]);
    }
    poly(g, pts, HOT, 1.6);
    const yRms = cy - 14 / Math.SQRT2;
    g.strokeStyle = OK; g.globalAlpha = 0.7; g.setLineDash([3, 3]); g.lineWidth = 1;
    g.beginPath(); g.moveTo(-w / 2 + 8, yRms); g.lineTo(w / 2 - 8, yRms); g.stroke();
    g.setLineDash([]); g.globalAlpha = 1;
    dot(g, -w / 2 + 3, 0); dot(g, w / 2 - 3, 0);
    gfx.text(g, `${this.props.f}Hz  Up=${this.props.Up}V`, 0, cy + 24, { color: TXT, size: 9.5 });
    gfx.text(g, `Urms=Up/√2=${(this.state.Urms || 0).toFixed(3)}V 实测 ${(this.state.rmsMeas || 0).toFixed(3)}V`,
      0, cy + 34, { color: DIM, size: 9 });
  }
}
const acDef = {
  type: 'acsource', name: '交流电源', domain: PH, cat: CAT, icon: '∿',
  desc: '正弦交流：U(t)=Up·sin(2πft+φ)，有效值 Urms=Up/√2（实测值滚动核对）',
  w: 84, h: 84,
  ports: [{ x: -42, y: 0, kind: 'wire', label: 'L' }, { x: 42, y: 0, kind: 'wire', label: 'N' }],
  defaults: { Up: 6, f: 1, phi: 0, r: 0.05 },
  state: { t: 0, emf: 0, Urms: 0, rmsMeas: 0, pp: 0, T: 1, buf: [], bufT: [], rmsI: 0, ibuf: [], ibufT: [] },
  tags: ['交流', '正弦', '有效值', '电源'],
  fields: [
    { k: 'Up', label: '峰值电压 Up', type: 'range', min: 1, max: 24, step: 0.5, unit: 'V' },
    // 上限 20 Hz：引擎定步长 1/120 s，超过 60 Hz 必然混叠，这里留 3 倍余量
    { k: 'f', label: '频率 f', type: 'range', min: 0.2, max: 20, step: 0.1, unit: 'Hz' },
    { k: 'phi', label: '初相 φ', type: 'range', min: 0, max: 360, step: 5, unit: '°' },
    { k: 'r', label: '内阻', type: 'range', min: 0.01, max: 10, step: 0.01, unit: 'Ω' },
  ],
  create: (x, y) => new AcSource(acDef, x, y),
};
DEFS.push(() => define(acDef));

// ══════════════════════════════════════════════════════════
// 五、器材 4：示波器
// ══════════════════════════════════════════════════════════
const SCOPE_N = 480;
class Oscilloscope extends Entity {
  step(dt, world) {
    const src = nearestSignal(world, this);
    this.state.srcId = src ? src.id : null;
    if (!src) { this.state.fMeas = NaN; return; }
    const f = src.props.f || 0;
    this.state.srcName = src.name;
    this.state.fSrc = f;
    this.state.UpSrc = src.props.Up || 0;
    this.state.T = f > 0 ? 1 / f : Infinity;
    // 采样：缓冲区正好放满 4 个周期（至少 2 个），保证过零测频有两个以上的点
    const buf = this.state.buf || (this.state.buf = []);
    const bt = this.state.bt || (this.state.bt = []);
    buf.push(src.signalAt(world.time)); bt.push(world.time);
    const want = f > 0 ? Math.min(SCOPE_N, Math.ceil((4 / f) / dt) + 1) : SCOPE_N;
    while (buf.length > want) { buf.shift(); bt.shift(); }
    this.state.n = buf.length;
    this.state.pp = peakToPeak(buf);
    this.state.rmsMeas = rmsOf(buf);
    this.state.fMeas = measuredFreq(bt, buf);
    this.state.df = f > 0 && isFinite(this.state.fMeas) ? Math.abs(this.state.fMeas - f) / f : NaN;
    // 相位：实测第一次上升过零 vs 解析预测
    const cr = upCrossings(bt, buf);
    if (cr.length && f > 0) {
      this.state.firstCross = cr[0];
      const phi = (src.props.phi || 0) * D2R;
      // 解析上升过零：t_k = (2πk − φ)/(2πf)
      const k = Math.ceil((TAU * f * cr[0] + phi) / TAU);
      const pred = (TAU * k - phi) / (TAU * f);
      this.state.predCross = pred;
      this.state.dPhase = Math.abs(cr[0] - pred) / (1 / f);   // 以周期为单位
    } else { this.state.firstCross = NaN; this.state.dPhase = NaN; }
  }

  render(g) {
    const { w, h } = this;
    shell(g, w, h, '示波器');
    const gx = -w / 2 + 12, gy = -h / 2 + 14, gw = w - 24, gh = h - 46;
    g.fillStyle = '#101820'; gfx.fillRR(g, gx, gy, gw, gh, 4, '#101820');
    g.strokeStyle = '#22303c'; g.lineWidth = 1;
    for (let i = 1; i < 10; i++) {
      const x = gx + (i / 10) * gw, y = gy + (i / 10) * gh;
      g.beginPath(); g.moveTo(x, gy); g.lineTo(x, gy + gh); g.stroke();
      g.beginPath(); g.moveTo(gx, y); g.lineTo(gx + gw, y); g.stroke();
    }
    const buf = this.state.buf || [], bt = this.state.bt || [];
    if (buf.length > 1) {
      const vd = Math.max(0.5, this.props.voltDiv) * 2;        // 全屏 = 2 格半高 × 2
      const t0 = bt[0], t1 = bt[bt.length - 1];
      const pts = buf.map((v, i) => [
        gx + ((bt[i] - t0) / Math.max(1e-9, t1 - t0)) * gw,
        gy + gh / 2 - clamp(v / vd, -1.2, 1.2) * (gh / 2 * 0.8),
      ]);
      poly(g, pts, OK, 1.6);
    } else {
      gfx.text(g, '未找到信号源', 0, 0, { color: DIM, size: 10 });
    }
    const f = this.state.fMeas;
    gfx.text(g, this.state.srcId
      ? `${this.state.srcName}：f 实测 ${isFinite(f) ? f.toFixed(3) : '—'} / 源 ${(this.state.fSrc || 0).toFixed(3)} Hz`
      : '示波器（把交流电源放在附近）',
      0, h / 2 - 20, { color: TXT, size: 9.5 });
    gfx.text(g, `峰峰 ${(this.state.pp || 0).toFixed(3)}V  ${isFinite(this.state.dPhase) ? `相位差 ${(this.state.dPhase * 100).toFixed(2)}%T` : ''}`,
      0, h / 2 - 9, { color: DIM, size: 9 });
  }
}
const scopeDef = {
  type: 'oscilloscope', name: '示波器', domain: PH, cat: CAT, icon: '📊',
  desc: '显示附近交流信号的波形，并**测量**频率与相位：实测值来自采样缓冲的上升过零点',
  w: 170, h: 118,
  ports: [],
  defaults: { timeDiv: 200, voltDiv: 4 },
  state: { buf: [], bt: [], fMeas: NaN, pp: 0 },
  tags: ['示波器', '波形', '频率', '相位', '测量'],
  fields: [
    { k: 'timeDiv', label: '时基', type: 'range', min: 50, max: 1000, step: 50, unit: 'ms/格' },
    { k: 'voltDiv', label: '电压灵敏度', type: 'range', min: 0.5, max: 12, step: 0.5, unit: 'V/格' },
  ],
  create: (x, y) => new Oscilloscope(scopeDef, x, y),
};
DEFS.push(() => define(scopeDef));

// ══════════════════════════════════════════════════════════
// 六、器材 5：变压器
// ══════════════════════════════════════════════════════════
class Transformer extends Entity {
  /** 一次侧就是一只电阻（理想变压器的一次侧铜损），求解器给出真实 U₁ */
  circuitBranch() { return { type: 'R', r: Math.max(1, this.props.R1) }; }

  /** 二次侧端子（wire 口的后两个）是否接了线 —— circuitBranches 与 step 共用同一判据，避免两处漂移 */
  secPorts() {
    const wp = [];
    for (let i = 0; i < this.ports.length; i++) if (this.ports[i].kind === 'wire') wp.push(i);
    return wp.length < 4 ? null : wp;
  }
  secWired(world) {
    const wp = this.secPorts();
    if (!wp || !world) return false;
    return [wp[2], wp[3]].some((i) => world.wires.some((w) => w.kind === 'wire'
      && ((w.a.e === this.id && w.a.p === i) || (w.b.e === this.id && w.b.p === i))));
  }

  /**
   * 一器材多支路（circuit.js 契约）：一次侧 = 主边、二次侧 = 次边（真端子，真进矩阵）。
   *
   * ⚠ 二次侧整边**没接线** ⇒ 返回 null ⇒ 回落到 circuitBranch()（= 改动前那条 r=R1）
   *   ⇒ 两线用法与改动前**同一条支路**，零回归（判据见 tools/multibranch-probe.mjs §⑦）。
   * ⚠ 不许造迭代内代数环（electrical.js:688 Motor 那条禁令）：两条支路的耦合量**全部取自
   *   上一帧的 state**（二次 emf 用上一帧 U₁；一次侧折算负载用上一帧实测二次电流），
   *   在本帧的 solve 里都是常量 —— 定点迭代不会去追一个不存在的解 ✓。
   * ⚠ 只读 world 的接线；`state.sec` 是**本体自有**的缓存盒子（求解器往里写 {I,U,P,R}），
   *   不是全局量。
   */
  circuitBranches(world) {
    const wp = this.secPorts();
    if (!wp) return null;
    const [pa, pb, sa, sb] = wp;
    if (!this.secWired(world)) return null;                 // 二次侧整边没接 ⇒ 旧路径
    const n = this.props.N1 / Math.max(1, this.props.N2);
    // ⚠ 二次 emf 不是 U₁/n，而是**一次铜阻背后**的电动势 E₁ = U₁ − I₁·R₁（上一帧量）✗↔✓
    //   用 U₁/n 的错法实测 I₁/I₂ 差 18.5%（I₁=−0.027776 ⟷ I₂/n=−0.034089 ✗）；
    //   改成 E₁ 后 I₂ = n·I₁、一次总阻 = R₁ + n²·(R₂+R_L) 都是教科书关系 ✓。
    const R1 = Math.max(1, this.props.R1);
    const E1 = (this.state.U || 0) - (this.state.I || 0) * R1;   // 上一帧 ⇒ 本帧常量
    const U2 = E1 / n;
    const sec = this.state.sec || (this.state.sec = {});    // 每台本体自有（不在 def.state 里共享 ✗）
    const i2 = Math.abs(sec.I || 0);
    // 二次回路总阻 (R₂+R_L) 实测 = |E₂/I₂| ⇒ 折算到一次 ×n²；还没有二次电流时用声明负载 RL 兜底
    const refl = i2 > 1e-9 && Math.abs(U2) > 0
      ? (n * n * Math.abs(U2)) / i2
      : n * n * Math.max(0.01, this.props.RL);
    return [
      { type: 'R', r: R1 + refl, a: pa, b: pb },                                        // 主边：一次铜阻 + 折算负载
      { type: 'V', emf: U2, r: Math.max(0.1, this.props.R2), a: sa, b: sb, state: sec }, // 次边：真端子
    ];
  }

  step(dt, world) {
    const src = nearestSignal(world, this);
    const U1 = Math.abs(this.state.U || 0) > 1e-6
      ? this.state.U                                   // 已经接进电路：用求解器的真实电压
      : (src ? src.signalAt(world.time) : this.props.U1); // 没接线：跟随附近的交流源
    this.state.U1 = U1;
    this.state.srcId = src ? src.id : null;
    const t = transformer(U1, this.props.N1, this.props.N2, this.props.RL);
    // ⚠ 二次侧真接了线 ⇒ U₂/I₂/P 改报**求解器给的**值（解析值另存 theory 键备对照，不冒充实测）
    const sec = this.state.sec || {};
    const live = this.secWired(world) && typeof sec.U === 'number';
    this.state.U2theory = t.U2; this.state.I2theory = t.I2;
    this.state.U2src = live ? 'solver' : 'analytic';
    this.state.U2 = live ? sec.U : t.U2;
    this.state.I2 = live ? sec.I : t.I2;
    this.state.I1 = live ? Math.abs(this.state.I || 0) : t.I1;
    this.state.P1 = live ? Math.abs(U1 * this.state.I1) : t.P1;
    this.state.P2 = live ? Math.abs(this.state.U2 * this.state.I2) : t.P2;
    this.state.eta = this.state.P1 > 0 ? this.state.P2 / this.state.P1 : 0;
    this.state.ratio = t.k;
    this.state.nRatio = this.props.N1 / this.props.N2;
  }

  render(g) {
    const { w, h } = this;
    shell(g, w, h, '变压器');
    const cy = -h / 2 + 26;
    // 铁芯
    g.fillStyle = '#5b6672';
    gfx.fillRR(g, -5, cy - 18, 10, 36, 2, '#5b6672');
    // 一次 / 二次线圈
    const coil = (x0, turns, side) => {
      g.strokeStyle = side > 0 ? HOT : OK; g.lineWidth = 1.8;
      g.beginPath();
      const R = 8;
      for (let i = 0; i <= turns; i++) {
        const a = Math.PI * (i / turns);
        const x = x0 + side * (Math.sin(a) * R);
        const y = cy - 16 + (i / turns) * 32;
        i ? g.lineTo(x, y) : g.moveTo(x, y);
      }
      g.stroke();
    };
    coil(-8, 10, -1);
    coil(8, 6, 1);
    dot(g, -w / 2 + 3, 0); dot(g, w / 2 - 3, 0);
    // 二次侧端子（真接线柱）：画出来，否则用户看不见那两个口在哪儿
    dot(g, -w / 2 + 3, 36); dot(g, w / 2 - 3, 36);
    gfx.text(g, '二次', 0, 44, { color: OK, size: 8.5 });
    gfx.text(g, `N₁=${this.props.N1} : N₂=${this.props.N2}`, 0, h / 2 - 32, { color: TXT, size: 9.5 });
    gfx.text(g, `U₁=${(this.state.U1 || 0).toFixed(3)}V → U₂=${(this.state.U2 || 0).toFixed(3)}V`,
      0, h / 2 - 22, { color: HOT, size: 9 });
    gfx.text(g, `U₁/U₂=${(this.state.ratio || 0).toFixed(3)} = N₁/N₂=${(this.state.nRatio || 0).toFixed(3)}`,
      0, h / 2 - 12, { color: DIM, size: 9 });
  }
}
const xfmrDef = {
  type: 'transformer', name: '变压器', domain: PH, cat: CAT, icon: '🔄',
  desc: '理想变压器：U₁/U₂ = N₁/N₂、I₁/I₂ = N₂/N₁、P₁ = P₂（一次侧接进真电路读真实 U₁；二次侧端子接线后 U₂/I₂ 也由求解器给）',
  w: 140, h: 104,
  ports: [{ x: -70, y: 0, kind: 'wire', label: '一次+' }, { x: 70, y: 0, kind: 'wire', label: '一次−' },
    { x: -70, y: 36, kind: 'wire', label: '二次+' }, { x: 70, y: 36, kind: 'wire', label: '二次−' }],
  defaults: { N1: 400, N2: 100, RL: 10, R1: 40, R2: 1, U1: 6 },
  // ⚠ `sec` 只能是**原始值**：entity.js:35 是 Object.assign({}, def.state) 浅拷贝，
  //   在 def.state 里放对象会被多台变压器**共享同一个盒子** ✗ ⇒ 盒子在 circuitBranches 里惰性建。
  state: { U1: 0, U2: 0, I1: 0, I2: 0, P1: 0, P2: 0, eta: 0, ratio: 0, nRatio: 4,
    sec: null, U2theory: 0, I2theory: 0, U2src: 'analytic' },
  tags: ['变压器', '互感', '变比', '交流'],
  fields: [
    { k: 'N1', label: '一次匝数 N₁', type: 'range', min: 50, max: 2000, step: 50, unit: '匝' },
    { k: 'N2', label: '二次匝数 N₂', type: 'range', min: 20, max: 1000, step: 10, unit: '匝' },
    { k: 'RL', label: '负载电阻', type: 'range', min: 1, max: 200, step: 1, unit: 'Ω' },
    { k: 'R1', label: '一次铜阻', type: 'range', min: 1, max: 200, step: 1, unit: 'Ω' },
    { k: 'R2', label: '二次铜阻', type: 'range', min: 0.1, max: 20, step: 0.1, unit: 'Ω' },
    { k: 'U1', label: '一次电压（未接线时）', type: 'range', min: 1, max: 36, step: 0.5, unit: 'V' },
  ],
  create: (x, y) => new Transformer(xfmrDef, x, y),
};
DEFS.push(() => define(xfmrDef));

// ══════════════════════════════════════════════════════════
// 七、器材 6：二极管（单向导电 / 半波整流）
// ══════════════════════════════════════════════════════════
class Diode extends Entity {
  /** 方向：+1 正接（A→B 导通），−1 反接 */
  sgn() { return this.props.dir === 'rev' ? -1 : 1; }

  /**
   * 分段线性二极管，用**求解器已有的支路能力**表达，而不是纯电阻近似：
   *   导通 → { type:'V', emf: sgn·Vf, r: ron }   —— Vf 恒压降 + ron 斜率
   *   截止 → { type:'R', r: roff·MΩ }
   *
   * 为什么不用 resistanceAt(U) 的纯电阻式（第一版就是这么写的，实测失败）：
   * 导通时二极管的**端电压只有 I·ron**（几十 mV），比 Vf 小，于是「U>Vf 才导通」
   * 这条判据把定点迭代推成 ON/OFF 抖动 —— 实测得到「导通占空比 0%、压降完全消失、
   * 负载平均值恰好等于 Up/π（Vf=0 的理想值）」。改成 V 支路后 ON 态自洽：
   * U = Vf + I·ron ≥ Vf，固定点稳定。
   * 开关判决用上一帧的端电压 → 8.3 ms（1/120 s 一步）的开关滞后，这是定步长实时的固有限制。
   */
  circuitBranch() {
    const s = this.sgn();
    return this.state.on
      ? { type: 'V', emf: s * this.props.vf, r: Math.max(1e-4, this.props.ron) }
      : { type: 'R', r: Math.max(1, this.props.roff * 1e6) };
  }

  step(dt, world) {
    const src = nearestSignal(world, this);
    this.state.srcId = src ? src.id : null;
    const Up = src ? (src.props.Up || 0) : 0;
    this.state.Up = Up;
    this.state.on = (this.state.U || 0) * this.sgn() > this.props.vf;
    this.state.vfEffect = this.props.vf;
    this.state.theta0 = conductionAngle(this.props.vf, Up) * R2D;
    // ① 可整流平均值（解析）：半波整流后**负载上能拿到**的平均电压
    //    （Up/π，含压降时为解析式）。二极管看不见负载在哪儿，所以这是解析量、不冒充实测。
    this.state.meanTheory = halfWaveMean(Up, this.props.vf);
    // ② 导通占空比（**实测**，二极管自己就能量）：理论值 (π−2θ₀)/2π，Vf=0 时恰为 50%
    if (src && src.props.f > 0) {
      const buf = this.state.buf || (this.state.buf = []);
      buf.push(this.state.on ? 1 : 0);
      const n = Math.ceil((1 / src.props.f) / dt) + 1;
      while (buf.length > n) buf.shift();
      this.state.duty = meanOf(buf);
      const t0 = conductionAngle(this.props.vf, Up);
      this.state.dutyTheory = (Math.PI - 2 * t0) / (2 * Math.PI);
    } else { this.state.duty = 0; this.state.dutyTheory = 0; }
    // 耦合播报：整流后的直流分量才是电解的驱动量（走既有总线，不碰 bridge.js）
    if (src && Up > 0) {
      const key = 'rect:' + this.id;
      const last = this.state._lastFire || -99;
      if (world.time - last > 2.5) {
        this.state._lastFire = world.time;
        bus.emit(EV.COUPLING, {
          key, domain: 'bridge',
          msg: `半波整流：Up=${Up.toFixed(1)}V 导通占空比实测 ${(this.state.duty * 100).toFixed(1)}%`
            + `（理论 ${(this.state.dutyTheory * 100).toFixed(1)}%），可整流平均值 ${this.state.meanTheory.toFixed(3)} V`
            + `（${this.props.vf > 0 ? '含 Vf 解析式' : 'Up/π'}）`,
        });
      }
    }
  }

  render(g) {
    const { w, h } = this;
    shell(g, w, h, '二极管');
    const cy = -h / 2 + 20;
    // 三角形 + 竖线 = 二极管符号
    g.fillStyle = this.state.on ? OK : DIM;
    g.beginPath(); g.moveTo(-8, cy - 8); g.lineTo(-8, cy + 8); g.lineTo(6, cy); g.closePath(); g.fill();
    g.strokeStyle = this.state.on ? OK : DIM; g.lineWidth = 2.2;
    g.beginPath(); g.moveTo(6, cy - 9); g.lineTo(6, cy + 9); g.stroke();
    g.strokeStyle = WIRE; g.lineWidth = 1.6;
    g.beginPath(); g.moveTo(-w / 2 + 4, cy); g.lineTo(-8, cy); g.stroke();
    g.beginPath(); g.moveTo(6, cy); g.lineTo(w / 2 - 4, cy); g.stroke();
    dot(g, -w / 2 + 3, 0); dot(g, w / 2 - 3, 0);
    gfx.text(g, this.state.on ? '导通' : '截止', 0, 6, { color: this.state.on ? OK : BAD, size: 9.5 });
    gfx.text(g, `U=${(this.state.U || 0).toFixed(3)}V  I=${((this.state.I || 0) * 1000).toFixed(1)}mA`,
      0, 17, { color: DIM, size: 9 });
    if (this.state.meanTheory > 0) {
      gfx.text(g, `占空比实测 ${((this.state.duty || 0) * 100).toFixed(1)}% / 理论 ${((this.state.dutyTheory || 0) * 100).toFixed(1)}%`,
        0, 28, { color: OK, size: 8.5 });
      gfx.text(g, `可整流平均值 ${this.state.meanTheory.toFixed(3)}V（Up/π 族）`,
        0, 37, { color: HOT, size: 8.5 });
    }
  }
}
const diodeDef = {
  type: 'diode', name: '二极管', domain: PH, cat: CAT, icon: '△',
  desc: '单向导电：U>Vf 导通、反接截止；半波整流后平均值 = Up/π（含压降时为解析式）',
  w: 76, h: 56,
  ports: [{ x: -38, y: 0, kind: 'wire', label: 'A' }, { x: 38, y: 0, kind: 'wire', label: 'K' }],
  defaults: { vf: 0.6, ron: 0.5, roff: 1, dir: 'fwd' },
  state: { on: false, theta0: 0, duty: 0, dutyTheory: 0, meanTheory: 0, buf: [] },
  tags: ['二极管', '整流', '单向导电', '非线性', '半导体'],
  fields: [
    { k: 'vf', label: '正向压降 Vf', type: 'range', min: 0, max: 2, step: 0.05, unit: 'V' },
    { k: 'ron', label: '导通电阻', type: 'range', min: 0.1, max: 50, step: 0.1, unit: 'Ω' },
    { k: 'roff', label: '反向电阻', type: 'range', min: 0.1, max: 50, step: 0.1, unit: 'MΩ' },
    { k: 'dir', label: '接法', type: 'select', options: [['fwd', '正接'], ['rev', '反接']] },
  ],
  create: (x, y) => new Diode(diodeDef, x, y),
};
DEFS.push(() => define(diodeDef));

// ══════════════════════════════════════════════════════════
// 八、器材 7：光敏电阻（照度 → 电阻）
// ══════════════════════════════════════════════════════════
/**
 * 找最近的「发光体」——**结构判据，不是类型白名单**：认 `props.wavelength > 0`。
 * ⚠ 为什么不能按 `props.power > 0` 找：**热源也有 `power`** —— thermal.js 的酒精灯
 *   `{lit:false, power:600}`、heating.js 的加热器 `{power:200}`（单位 **W**），而发光体
 *   optics.js 的光源 `{power:5}` 是 **mW**。按 power 找会把酒精灯当灯照，且量纲也串了。
 *   `wavelength` 是发光体独有、且**本来就存在**的字段（D44：不新造字段）。
 */
export function nearestLuminous(world, self, maxDist = 1e9) {
  let best = null, bd = maxDist;
  for (const e of world.entities) {
    if (e === self) continue;
    if (!(e.props && e.props.wavelength > 0)) continue;
    const d = Math.hypot(e.x - self.x, e.y - self.y);
    if (d < bd) { bd = d; best = e; }
  }
  return best;
}

/**
 * 相对照度 0–100（**不是 lx**）：点光源按 1/r² 衰减，标称 5 mW @ 100 px 记 100。
 * ⚠ 本仓**没有照度真源**（`src/**` 里 `照度|illuminance|lux` 零命中，亲测），
 *   按 plans/11 §7 / D44「无真源不造字段」⇒ 只报**相对值**与**距离**，
 *   标签与单位一律不写 lx/lm，避免把相对量冒充计量量。
 */
export function relIlluminance(powerMW, distPx, refPowerMW = 5, refDistPx = 100) {
  const d = Math.max(10, distPx);                 // 近场不除到无穷：10 px 内取解析上限
  return clamp(100 * (powerMW / refPowerMW) * Math.pow(refDistPx / d, 2), 0, 100);
}

class PhotoResistor extends Entity {
  /**
   * R = rDark · (rLight/rDark)^(t^γ)，t = 相对照度/100 —— 照度的**单值连续**函数。
   *
   * ⚠ 它与二极管的区别（照抄错就废）：二极管是**开关**型 —— ON 态端电压只有 I·ron < Vf，
   *   「U>Vf 才导通」这条纯电阻式判据**自我否定**，定点迭代抖成 ON/OFF（实测占空比 0%、
   *   压降消失，见本文件文件头 ①）。光敏电阻没有开关判决：给定照度只有一个 R，
   *   且 `circuitBranch()` 返回的 r 在迭代里是常量 ⇒ **电阻钩子在这里稳态自洽** ✓。
   *   同一个求解器钩子，一件能用、一件不能用，分野就在这里。
   */
  resistanceNow() {
    const t = clamp((this.state.relE || 0) / 100, 0, 1);
    const g = Math.pow(t, Math.max(0.05, this.props.gamma || 0.8));
    const r = this.props.rDark * Math.pow(this.props.rLight / this.props.rDark, g);
    return clamp(r, Math.min(this.props.rLight, this.props.rDark), Math.max(this.props.rLight, this.props.rDark));
  }
  /** 求解器电阻钩子（circuit.js:150-151：实体优先）—— 照度的函数，不看电压 */
  resistanceAt() { return this.resistanceNow(); }
  circuitBranch() { return { type: 'R', r: Math.max(0.05, this.resistanceNow()) }; }

  step(dt, world) {
    const s = nearestLuminous(world, this);
    this.state.srcId = s ? s.id : null;
    this.state.srcDist = s ? Math.hypot(s.x - this.x, s.y - this.y) : NaN;
    this.state.relE = s ? relIlluminance(s.props.power, this.state.srcDist) : 0;
    this.state.rNow = this.resistanceNow();       // 自报缓存，面板可消费（不占 I/U/P/R）
  }

  render(g) {
    const { w } = this;
    shell(g, w, 56, '光敏电阻');
    // 入射光：两条斜箭头（只在有照度时点亮）
    const lit = (this.state.relE || 0) > 0;
    g.strokeStyle = lit ? HOT : DIM; g.lineWidth = 1.4;
    for (const dx of [-5, 5]) {
      g.beginPath(); g.moveTo(dx - 8, -22); g.lineTo(dx + 1, -13); g.stroke();
      g.beginPath(); g.moveTo(dx + 1, -13); g.lineTo(dx - 3, -14); g.stroke();
    }
    gfx.fillRR(g, -13, -7, 26, 14, 2, '#2b3440');
    gfx.strokeRR(g, -13, -7, 26, 14, 2, EDGE, 1.2);
    g.strokeStyle = WIRE; g.lineWidth = 1.6;
    g.beginPath(); g.moveTo(-w / 2 + 4, 0); g.lineTo(-13, 0); g.stroke();
    g.beginPath(); g.moveTo(13, 0); g.lineTo(w / 2 - 4, 0); g.stroke();
    dot(g, -w / 2 + 3, 0); dot(g, w / 2 - 3, 0);
    const R = this.state.rNow || 0;
    gfx.text(g, `相对照度 ${(this.state.relE || 0).toFixed(0)}%`, 0, 15, { color: lit ? HOT : DIM, size: 9 });
    gfx.text(g, `R=${R >= 1000 ? (R / 1000).toFixed(1) + ' kΩ' : R.toFixed(0) + ' Ω'}`,
      0, 25, { color: DIM, size: 9 });
  }
}
const photoDef = {
  type: 'photoresistor', name: '光敏电阻', domain: PH, cat: CAT, icon: '🔆',
  desc: '光照↑⇒电阻↓（幂律）：照度取自最近的发光体，R 走求解器电阻钩子接进真电路',
  w: 84, h: 56,
  ports: [{ x: -42, y: 0, kind: 'wire', label: 'A' }, { x: 42, y: 0, kind: 'wire', label: 'B' }],
  defaults: { rDark: 100000, rLight: 500, gamma: 0.8 },
  state: { srcId: null, srcDist: NaN, relE: 0, rNow: 100000 },
  tags: ['光敏电阻', '光敏', '照度', '半导体', '非线性', '耦合'],
  fields: [
    { k: 'rDark', label: '暗电阻', type: 'range', min: 1000, max: 1000000, step: 1000, unit: 'Ω' },
    { k: 'rLight', label: '亮电阻', type: 'range', min: 50, max: 20000, step: 50, unit: 'Ω' },
    { k: 'gamma', label: '幂指数 γ', type: 'range', min: 0.2, max: 2, step: 0.05, unit: '' },
  ],
  create: (x, y) => new PhotoResistor(photoDef, x, y),
};
DEFS.push(() => define(photoDef));

// ══════════════════════════════════════════════════════════
// 九、器材 8：光敏二极管（照度 → 开关；与光敏电阻的**连续**非线性相对）
// ══════════════════════════════════════════════════════════
/**
 * 光敏二极管 —— C4「光电元件」的另一半。
 *
 * ⚠ **它与光敏电阻不是同一件东西，照抄会废**：
 * - 光敏电阻是**连续**非线性：给定照度只有一个 R，无开关判决 ⇒ 走 `resistanceAt()` 电阻钩子，
 *   在定点迭代里自洽（见上面 `PhotoResistor` 的注释）。
 * - 光敏二极管是**开关**型：它要么导通要么截止 —— 与 `Diode` 同类，**必须**走
 *   `circuitBranch()` 的 **V 支路**，否则「U>Vf 才导通」在 ON 态自我否定（端电压只有 I·ron），
 *   定点迭代会抖成 ON/OFF，实测表现为「占空比 0%、压降完全消失」。
 *
 * **判据设计（两个路径取或，这是它的物理）**：
 * 1. **光控**：相对照度 ≥ `eth` ⇒ 光生载流子把器件导通 —— 这是"光控开关"的教学含义，
 *    也是它与 `Diode`（只认电压、不认光）的**唯一区别**；
 * 2. **正偏压**：`U·sgn() > vf` ⇒ 与普通二极管相同的正偏导通。
 *
 * 两个路径都汇到同一个 `state.on`，所以"没光时它仍是一只普通二极管"这件事是**自然成立**的，
 * 不是特例分支。反接（`dir:'rev'`）时 `sgn()` 为负，光控仍能导通（光电二极管本就常工作在反偏），
 * 但正偏路径会失效 —— 与真实器件的方向性一致。
 */
class PhotoDiode extends Entity {
  sgn() { return this.props.dir === 'rev' ? -1 : 1; }
  reset() { this.state.on = false; this.state.srcId = null; this.state.srcDist = NaN; this.state.relE = 0; }

  /** 开关型支路（与 Diode 同构）：导通 = Vf 恒压降 + ron 斜率；截止 = roff·MΩ */
  circuitBranch() {
    const s = this.sgn();
    return this.state.on
      ? { type: 'V', emf: s * this.props.vf, r: Math.max(1e-4, this.props.ron) }
      : { type: 'R', r: Math.max(1, this.props.roff * 1e6) };
  }

  step(dt, world) {
    const src = nearestLuminous(world, this);
    this.state.srcId = src ? src.id : null;
    this.state.srcDist = src ? Math.hypot(src.x - this.x, src.y - this.y) : NaN;
    this.state.relE = src ? relIlluminance(src.props.power, this.state.srcDist) : 0;
    // 两个导通路径取或（见上）。开关判决用**上一帧**端电压 ⇒ 定步长实时的固有限制，
    // 与 Diode 同（8.3 ms 一步）。
    const lit = (this.state.relE || 0) >= (this.props.eth || 0);
    const forward = (this.state.U || 0) * this.sgn() > this.props.vf;
    this.state.on = lit || forward;
    this.state.litOnly = lit && !forward;     // 自报：这一帧是"光导通"还是"电压导通"
  }

  render(g) {
    const { w, h } = this;
    shell(g, w, h, '光敏二极管');
    const cy = -h / 2 + 20;
    const lit = (this.state.relE || 0) > 0;
    // 入射光箭头（有照度才点亮）—— 与光敏电阻同一种记号，便于并排辨认
    g.strokeStyle = lit ? HOT : DIM; g.lineWidth = 1.4;
    for (const dx of [-5, 5]) {
      g.beginPath(); g.moveTo(dx - 8, cy - 22); g.lineTo(dx + 1, cy - 13); g.stroke();
      g.beginPath(); g.moveTo(dx + 1, cy - 13); g.lineTo(dx - 3, cy - 14); g.stroke();
    }
    // 二极管符号（与 Diode 同形）
    g.fillStyle = this.state.on ? OK : DIM;
    g.beginPath(); g.moveTo(-8, cy - 8); g.lineTo(-8, cy + 8); g.lineTo(6, cy); g.closePath(); g.fill();
    g.strokeStyle = this.state.on ? OK : DIM; g.lineWidth = 2.2;
    g.beginPath(); g.moveTo(6, cy - 9); g.lineTo(6, cy + 9); g.stroke();
    g.strokeStyle = WIRE; g.lineWidth = 1.6;
    g.beginPath(); g.moveTo(-w / 2 + 4, cy); g.lineTo(-8, cy); g.stroke();
    g.beginPath(); g.moveTo(6, cy); g.lineTo(w / 2 - 4, cy); g.stroke();
    dot(g, -w / 2 + 3, 0); dot(g, w / 2 - 3, 0);
    gfx.text(g, this.state.on ? '导通' : '截止', 0, 6, { color: this.state.on ? OK : BAD, size: 9.5 });
    gfx.text(g, `相对照度 ${(this.state.relE || 0).toFixed(0)}%`, 0, 17, { color: lit ? HOT : DIM, size: 9 });
    gfx.text(g, `U=${(this.state.U || 0).toFixed(3)}V  I=${((this.state.I || 0) * 1000).toFixed(2)}mA`,
      0, 28, { color: DIM, size: 9 });
  }
}
const photoDiodeDef = {
  type: 'photodiode', name: '光敏二极管', domain: PH, cat: CAT, icon: '🔅',
  desc: '开关型光电元件：照度≥阈值 ⇒ 光生载流子导通（光控开关）；无光时仍是一只普通二极管（U>Vf 正偏导通）',
  w: 76, h: 56,
  ports: [{ x: -38, y: 0, kind: 'wire', label: 'A' }, { x: 38, y: 0, kind: 'wire', label: 'K' }],
  defaults: { vf: 0.6, ron: 0.5, roff: 1, dir: 'fwd', eth: 20 },
  state: { on: false, srcId: null, srcDist: NaN, relE: 0, litOnly: false },
  tags: ['光敏二极管', '光电', '照度', '开关', '半导体', '非线性', '耦合'],
  fields: [
    { k: 'eth', label: '导通照度阈', type: 'range', min: 0, max: 100, step: 1, unit: '%' },
    { k: 'vf', label: '正向压降 Vf', type: 'range', min: 0, max: 2, step: 0.05, unit: 'V' },
    { k: 'ron', label: '导通电阻', type: 'range', min: 0.1, max: 50, step: 0.1, unit: 'Ω' },
    { k: 'roff', label: '反向电阻', type: 'range', min: 0.1, max: 50, step: 0.1, unit: 'MΩ' },
    { k: 'dir', label: '接法', type: 'select', options: [['fwd', '正接'], ['rev', '反接']] },
  ],
  create: (x, y) => new PhotoDiode(photoDiodeDef, x, y),
};
DEFS.push(() => define(photoDiodeDef));

// ══════════════════════════════════════════════════════════
// 十、器材 9/10：三极管 NPN / PNP（三端非线性）
// ══════════════════════════════════════════════════════════

/** 取前 n 个 wire 口的下标；不足 n 个返回 null（顺序 = ports 里出现的顺序） */
function wirePorts(e, n) {
  const wp = [];
  for (let i = 0; i < e.ports.length; i++) if (e.ports[i].kind === 'wire') wp.push(i);
  return wp.length < n ? null : wp.slice(0, n);
}
/** 某个 wire 口是否接了线（world 缺省 / 没有 wires 一律当没接 —— 与滑动变阻器同一条口径） */
function portWired(e, world, p) {
  if (!world || !Array.isArray(world.wires)) return false;
  return world.wires.some((w) => w.kind === 'wire'
    && ((w.a.e === e.id && w.a.p === p) || (w.b.e === e.id && w.b.p === p)));
}
/** 截止口径的等效电阻：roff 一律以 MΩ 记（与 Diode 的 roff 同口径） */
const offR = (mohm) => clamp(mohm * 1e6, 1, 1e9);
/** 工作区中文名 / 配色（三极管与 MOSFET 共用一张表）
 *  `dead` 不是电学工作区，而是「三个端子不全接线」——求解器对 open 支路报 R=Infinity，
 *  此时端子电位没有物理意义（实测悬空口的节点号会别名到别的节点上，见 tools/transistor-probe.mjs §7），
 *  所以工作区一栏必须如实说「未接入」，不能报一个看着像真的区（假绿比缺失危险）。 */
const REGION_CN = { cutoff: '截止', active: '放大', sat: '饱和', triode: '可变电阻区', dead: '未接入' };
const REGION_COL = { cutoff: BAD, active: OK, sat: HOT, triode: HOT, dead: DIM };

/**
 * 三极管的两条支路（一条器材多条支路）：
 *
 *   主边 bi=0  **C–E** —— 主边独占实体级 state.I/U/P/R ⇒ `state.U` 恒为 V(C)−V(E)
 *   次边 bi=1  **B–E** —— 真端子、真进矩阵；解写进 `state.be` 盒子（每台本体自有，惰性建）
 *
 * 三区的分段线性表达（只用求解器**已有**的 R / V 两种支路，不新造元件类型）：
 *
 *   区    发射结 B–E                      集电通路 C–E
 *   截止  {R, r=offR(roff)}               {R, r=offR(roff)}
 *   放大  {V, emf=s·U_BE(on), r=rbe}       {R, r=Uce(上一帧)/(β·Ib(上一帧))}
 *   饱和  {V, emf=s·U_BE(on), r=rbe}       {V, emf=s·U_CE(sat), r=rce_sat}
 *
 *   s = +1（NPN）/ −1（PNP）；两条支路的端子朝向**不分极性**（恒为 a=C,b=E 与 a=B,b=E），
 *   极性只体现在 emf 的符号上 —— 与 Diode.sgn() 同一种做法 ⇒ 面板读数不随极性换口径。
 *
 * ⚠ **放大区为什么是「等值电阻」而不是「受控电流源」**：矩阵装配只认 R 与 V 两类章，
 *   求解器里**没有电流源**。于是把 I_C = β·I_B 线性化成**本帧常量电阻**
 *   r = Uce(上一帧)/(β·Ib(上一帧))：在不动点上 r 恰好 = Uce/Ic ⇒ **Ic = β·Ib 精确成立**
 *   （不是近似，残差读数见 tools/transistor-probe.mjs）。
 *   ⚠ 这与文件头 ① 禁掉的 `resistanceAt(U)` 不同：那个钩子**每一轮定点迭代都被重新问一次**
 *   （判据追着自己跑 ⇒ 抖）；这里取的是上一帧的量，本帧 solve 里是常量 ⇒ 矩阵线性、
 *   一轮到达本帧解，跨帧是几何收敛（比值 Rc/(Rce+Rc) < 1）。
 *   ⚠ 也**不是**纯电阻建模：发射结与饱和态都是 V 支路（固定偏移），
 *   电阻只承担「把已知电流源折成等值电阻」这一步，且每帧只算一次。
 *
 * ⚠ 跨支路耦合只读**上一帧**写下的 state（be.U / be.I / U / I），在本帧 solve 里全是常量
 *   ⇒ 不存在迭代内代数环。区域判决只在 `step()` 里算一次并写进 `state.region`，
 *   `circuitBranches` **只读不算** ⇒ 两个调用点不会各自漂移。
 * ⚠ 判决为什么以**电流比**为主而不是「Uce < U_CE(sat)」一条：后者两个模型互相否定 ——
 *   饱和态的 V 支路给出 Uce = U_CE(sat)+rce·Ic > U_CE(sat) ⇒ 下一帧被判成不饱和；
 *   而放大态把 Ic 钉死在 β·Ib，电路真过驱动时 Uce 又掉到 U_CE(sat) 以下 ⇒ 再翻回饱和，
 *   实测就是 2 帧周期的 ON/OFF 抖动（与二极管第一版同一种病）。电流判据在两个模型下都
 *   **自我肯定**：饱和时外部回路把 Ic 压在 β·Ib 以下 ⇒ 继续饱和；放大态 Ic = β·Ib
 *   ⇒ 不满足「严格大于」⇒ 继续放大。电压判据只保留为**进入**饱和的那一支触发。
 */
class Bjt extends Entity {
  /** +1 = NPN，−1 = PNP（只改两条支路 emf 的符号） */
  sgn() { return this.type === 'pnp' ? -1 : 1; }

  /**
   * 两线用法（约束④）：**基极（控制端）没接线** ⇒ 返回 null ⇒ 求解器回落到
   * `circuitBranch()` 的单支路 ⇒ 该用法下与"改动前那条支路"逐位同解，且不产生假告警。
   * 判据是「接线了没有」而不是「声明了几个口」—— 与滑动变阻器当变阻器用同一条口径。
   */
  circuitBranches(world) {
    const p = wirePorts(this, 3);
    if (!p) return null;
    if (!portWired(this, world, p[0])) return null;
    const deadBe = !portWired(this, world, p[2]);                 // 发射极没接 ⇒ 两条都不通
    const deadCe = deadBe || !portWired(this, world, p[1]);
    return [this.ceDef(p[1], p[2], deadCe), this.beDef(p[0], p[2], deadBe)];
  }

  /** 单支路回落：只有 C–E 一条。走到这里就意味着**基极没接线**（circuitBranches 仅此时返回 null）
   *  ⇒ 丢掉 be 备忘盒。上一帧的 U_BE/I_B 是"当时基极接着线"的读数，留在盒子里会让 step() 拿陈旧基极
   *  驱动把区域判成放大/饱和 —— 而集电极侧一旦判成饱和就变成 V 支路，拔掉基极线之后反而凭空生出电流。
   *  丢掉之后本帧 U_BE = I_B = 0 ⇒ 区域判成截止 ⇒ C–E 给 offR：与"从未接过基极"逐位同解。 */
  circuitBranch() {
    const p = wirePorts(this, 3);
    delete this.state.be;
    return p ? this.ceDef(p[1], p[2], false) : { type: 'R', r: 1e9 };
  }

  /**
   * 主边 C–E。
   * ⚠ 任一端子没接线时给 `open`（零电流）而不是给 R=offR：集电极悬空时 C 节点只靠 gmin
   *   与这条支路分压，端电压会落到 V_E/2 量级，再被 Uce/(β·Ib) 折成一个有限等值电阻
   *   ⇒ 悬空集电极上凭空出现 mA 级电流（幻影电流）。open 与物理一致：没接就是不通。
   *   `dead` 只在 `circuitBranches` 那条路上可能为真（它拿得到 world）；
   *   回落路径 `circuitBranch()` 拿不到 world，与既有器材一样按区域给电阻。
   */
  ceDef(a, b, dead) {
    const s = this.sgn();
    const st = this.state.ce || (this.state.ce = {});
    if (dead) return { type: 'open', a, b, state: st };
    if (this.state.region === 'sat') {
      return { type: 'V', emf: s * Math.max(0, this.props.vceSat),
        r: clamp(this.props.rceSat, 1e-3, 1e9), a, b, state: st };
    }
    return { type: 'R', r: this.state.region === 'active' ? this.ceR() : offR(this.props.roff), a, b, state: st };
  }

  /** 次边 B–E：正偏 = V 支路（恒压降 + rbe，端电压自洽 U = U_BE(on) + rbe·I_B ≥ U_BE(on)）；未正偏 = 大电阻
   *  ⚠ 「未接入」（集电极悬空）也走 V 支路 —— 那是**对的**：集电极断开时发射结照样正偏、基极电流照样流，
   *    实测 I_B = 198 µA、U_BE = 0.7198 V（见 probe §7）。截止才是唯一该给大电阻的区。 */
  beDef(a, b, dead) {
    const s = this.sgn();
    const st = this.state.be || (this.state.be = {});
    if (dead) return { type: 'open', a, b, state: st };
    return this.state.region === 'cutoff'
      ? { type: 'R', r: offR(this.props.roff), a, b, state: st }
      : { type: 'V', emf: s * Math.max(0, this.props.vbeOn),
        r: clamp(this.props.rbe, 1e-3, 1e9), a, b, state: st };
  }

  /**
   * 放大区的等值电阻 = Uce(上一帧) / (β·Ib(上一帧))（本帧常量）。
   * 还没有集电极电压（冷启动 / 集电极悬空）时回落成截止电阻，避免 0/0 造出幻影电流。
   */
  ceR() {
    const ib = Math.abs((this.state.be && this.state.be.I) || 0);
    const ic = this.props.beta * ib;
    const uce = Math.abs(this.state.U || 0);
    if (!(ic > 1e-12) || !(uce > 1e-9)) return offR(this.props.roff);
    return clamp(uce / ic, 1e-3, 1e9);
  }

  step() {
    const s = this.sgn();
    const be = this.state.be || {};
    // 上一帧的量（求解器在本帧 solve 里刚写下；区域判决存起来给**下一帧**的 circuitBranches 用）
    const ube = (be.U || 0) * s;                 // 折成「正偏为正」的口径
    const uce = (this.state.U || 0) * s;
    const ib = Math.abs(be.I || 0);
    const ic = Math.abs(this.state.I || 0);
    // 求解器对 open 支路报 R=Infinity（JSON.stringify 会把它渲染成 null，所以判据只能用 === Infinity）
    const open = this.state.R === Infinity;
    this.state.region = open ? 'dead' : bjtRegion({ UBE: ube, UCE: uce, IB: ib, IC: ic,
      beta: this.props.beta, vbeOn: this.props.vbeOn, vceSat: this.props.vceSat });
    // 面板口径：端子带符号电压（与求解器的 U 同一朝向 = V(C)−V(E) / V(B)−V(E)），
    // 电流一律报**幅值** —— R 支路与 V 支路的电流正负号约定不同（二极管先例），
    // 报符号会把「放大区」与「饱和区」的 I_C 一个正一个负，学生没法比。
    this.state.Ube = be.U || 0;
    this.state.Uce = this.state.U || 0;
    this.state.Ubc = this.state.Ube - this.state.Uce;
    this.state.Ib = ib;
    this.state.Ic = ic;
    this.state.Ie = ib + ic;
    this.state.betaEff = ib > 1e-9 ? ic / ib : 0;   // 实测 β；饱和区实测 < 设定值 = 饱和的直接证据
    this.state.sat = this.state.region === 'sat';
  }

  render(g) {
    const { w, h } = this;
    shell(g, w, h, this.type === 'pnp' ? 'PNP 三极管' : 'NPN 三极管');
    const reg = this.state.region || 'cutoff';
    const col = REGION_COL[reg] || DIM;
    const cx = -20, r = 20;
    // 管壳
    g.strokeStyle = EDGE; g.lineWidth = 1.5;
    g.beginPath(); g.arc(cx, 0, r, 0, TAU); g.stroke();
    // 基极竖杠 + 三根引线
    g.strokeStyle = WIRE; g.lineWidth = 1.6;
    g.beginPath(); g.moveTo(-59, 0); g.lineTo(-32, 0); g.stroke();
    g.beginPath(); g.moveTo(-32, -13); g.lineTo(-32, 13); g.stroke();
    g.lineWidth = 2;
    g.beginPath(); g.moveTo(-32, -9); g.lineTo(24, -30); g.lineTo(59, -30); g.stroke();
    g.beginPath(); g.moveTo(-32, 9); g.lineTo(24, 30); g.lineTo(59, 30); g.stroke();
    // 发射极箭头：NPN 朝外（背离基极）、PNP 朝内
    const arrow = (x, y, dx, dy) => {
      const n = Math.hypot(dx, dy) || 1, ux = dx / n, uy = dy / n, px = -uy, py = ux;
      g.fillStyle = col; g.beginPath();
      g.moveTo(x + ux * 8, y + uy * 8);
      g.lineTo(x + px * 3.4, y + py * 3.4);
      g.lineTo(x - px * 3.4, y - py * 3.4);
      g.closePath(); g.fill();
    };
    if (this.type === 'pnp') arrow(17, 20, -1, -1); else arrow(24, 30, 1, 1);
    dot(g, -59, 0); dot(g, 59, -30); dot(g, 59, 30);
    gfx.text(g, `${this.type === 'pnp' ? 'PNP' : 'NPN'} · ${REGION_CN[reg] || '—'}  β=${this.props.beta}`,
      -59, 38, { color: col, size: 9.5, align: 'left' });
    gfx.text(g, `U_BE ${fmtV(this.state.Ube || 0)}   U_CE ${fmtV(this.state.Uce || 0)}`,
      -59, 48, { color: TXT, size: 9, align: 'left' });
    gfx.text(g, `I_B ${fmtA(this.state.Ib || 0)}   I_C ${fmtA(this.state.Ic || 0)}`,
      -59, 58, { color: HOT, size: 9, align: 'left' });
  }
}

/** NPN / PNP 两个定义只有一个字段不同（type / name / icon / desc）；极性由 Bjt.sgn() 从 type 读 */
function bjtDefOf(type, name, icon, desc) {
  const def = {
    type, name, domain: PH, cat: CAT, icon, desc,
    w: 124, h: 124,
    ports: [
      { x: -59, y: 0, kind: 'wire', label: 'B' },
      { x: 59, y: -30, kind: 'wire', label: 'C' },
      { x: 59, y: 30, kind: 'wire', label: 'E' },
    ],
    defaults: { beta: 100, vbeOn: 0.7, rbe: 100, vceSat: 0.2, rceSat: 20, roff: 1 },
    // ⚠ `be` / `ce` 只能是 null：entity.js 的 `Object.assign({}, def.state)` 是浅拷贝，
    //   在 def.state 里放对象会被**多台三极管共享同一个盒子** ⇒ 盒子在 ceDef/beDef 里惰性建。
    state: { region: 'cutoff', Ube: 0, Uce: 0, Ubc: 0, Ib: 0, Ic: 0, Ie: 0,
      betaEff: 0, sat: false, be: null, ce: null },
    // 面板读数：一律「元件名 + 端子字母」（U_BE / U_CE / U_BC、I_B / I_C），不用含糊的「电压」。
    // 走器材自报（def.stats）⇒ 不需要改 inspector.js，单位与精度与四键同一个格式器。
    stats: [
      { label: '工作区', read: (e) => REGION_CN[e.state.region] || '—' },
      { label: '电压BE U_BE', read: (e) => e.state.Ube || 0, fmt: fmtV },
      { label: '电压CE U_CE', read: (e) => e.state.Uce || 0, fmt: fmtV },
      { label: '电压BC U_BC', read: (e) => e.state.Ubc || 0, fmt: fmtV },
      { label: '基极电流 I_B', read: (e) => e.state.Ib || 0, fmt: fmtA },
      { label: '集电极电流 I_C', read: (e) => e.state.Ic || 0, fmt: fmtA },
      { label: '发射极电流 I_E', read: (e) => e.state.Ie || 0, fmt: fmtA },
      { label: '实测 β=I_C/I_B', read: (e) => e.state.betaEff || 0, digits: 1 },
    ],
    tags: ['三极管', type === 'pnp' ? 'PNP' : 'NPN', '电流放大', '半导体', '非线性', '三端'],
    fields: [
      { k: 'beta', label: '电流放大系数 β', type: 'range', min: 10, max: 500, step: 10 },
      { k: 'vbeOn', label: '发射结导通压降 U_BE(on)', type: 'range', min: 0, max: 1.5, step: 0.05, unit: 'V' },
      { k: 'rbe', label: '发射结导通电阻', type: 'range', min: 1, max: 2000, step: 1, unit: 'Ω' },
      { k: 'vceSat', label: '饱和压降 U_CE(sat)', type: 'range', min: 0, max: 1.5, step: 0.05, unit: 'V' },
      { k: 'rceSat', label: '饱和区电阻', type: 'range', min: 1, max: 200, step: 1, unit: 'Ω' },
      { k: 'roff', label: '截止电阻', type: 'range', min: 0.1, max: 50, step: 0.1, unit: 'MΩ' },
    ],
    create: (x, y) => new Bjt(def, x, y),
  };
  return def;   // def 先建、create 后挂 ⇒ 注册表里的 def 与 e.def 是同一个对象
}
const npnDef = bjtDefOf('npn', 'NPN 三极管', '▲',
  '电流放大：I_C = β·I_B（放大区，发射结正偏、集电结反偏）、U_BE≈0.7V 钳位；饱和区 U_CE ≥ U_CE(sat)；截止区 I_C≈0');
const pnpDef = bjtDefOf('pnp', 'PNP 三极管', '▼',
  '与 NPN 极性相反：发射极电位最高，电流由 E 流入、从 B/C 流出（面板电压为端子带符号值 ⇒ 导通时 U_BE/U_CE 为负）');
DEFS.push(() => define(npnDef));
DEFS.push(() => define(pnpDef));

// ══════════════════════════════════════════════════════════
// 十一、器材 11/12：MOSFET N 沟道 / P 沟道（三端非线性）
// ══════════════════════════════════════════════════════════
/**
 * MOSFET 的两条支路：
 *
 *   主边 bi=0  **D–S** 沟道 —— 三区都是 R 支路（`state.U` 恒为 V(D)−V(S)）
 *   次边 bi=1  **G–S**      —— `open`：栅极绝缘 ⇒ I_G ≡ 0，但**必须声明**这条支路，
 *                             否则栅极一接线就被判成「接了线却被忽略」= 假告警；
 *                             它同时把 state.gs.U 带回 V(G)−V(S)。
 *
 * 三区（纯函数 mosLaw()）：
 *   截止       U_GS ≤ Vth        ⇒ r = offR(roff)
 *   可变电阻区 U_DS <  U_ov       ⇒ I_D = k(2·U_ov·U_DS − U_DS²)   ⇒ r = U_DS(上一帧)/I_D(上一帧)
 *   恒流区     U_DS ≥  U_ov       ⇒ I_D = k·U_ov²                   ⇒ 同上
 *
 * ⚠ 与三极管/二极管的关键差别：**两段在 U_DS = U_ov 处取值相同**（都是 k·U_ov²），
 *   给出的等值电阻也相同 ⇒ 接缝连续，判决在两段间翻转**不会**自我否定 ⇒ 这里用电压判据
 *   是安全的。而栅极是绝缘的（I_G ≡ 0）⇒ 沟道电流不会反过来改变 U_GS ⇒ 截止判决也不可能
 *   自我否定。两件器件为什么一个必须用电流判据、一个可以用电压判据，差别就在这两句。
 * ⚠ 等值电阻同样只取**上一帧**的量（本帧 solve 里是常量）⇒ 与三极管同一条口径，
 *   不动点上 I_D 精确等于 mosLaw() 给的式子。
 */
class Mosfet extends Entity {
  /** +1 = N 沟道，−1 = P 沟道（只改各量的符号，式子一律走幅值口径） */
  sgn() { return this.type === 'pmos' ? -1 : 1; }
  /** 导电因子 k：面板按 mA/V² 记（学生口径），进模型换算成 A/V² */
  kSI() { return Math.max(1e-9, this.props.k) * 1e-3; }

  /** 两线用法（约束④）：**栅极（控制端）没接线** ⇒ null ⇒ 回落 circuitBranch() 的单支路 */
  circuitBranches(world) {
    const p = wirePorts(this, 3);
    if (!p) return null;
    if (!portWired(this, world, p[0])) return null;
    const dead = !portWired(this, world, p[1]) || !portWired(this, world, p[2]);
    return [this.dsDef(p[1], p[2], dead), this.gsDef(p[0], p[2])];
  }
  /** 单支路回落：只有 D–S 一条。走到这里就意味着**栅极没接线** ⇒ 丢掉 gs 备忘盒。
   *  栅极悬空时没有可用的 U_GS：实测悬空栅结点会被求解器别名到别的结点上（能读出 12 V 的假栅压），
   *  留着旧盒子则会让"拔掉栅极导线"这件事看起来没发生、沟道照旧导通。丢掉之后 U_GS = 0 ⇒ 截止。
   *  刻意简化：真器件的悬空栅极会保持栅电荷，本模型不建栅电容 ⇒ 统一按「无栅压即无沟道」读。 */
  circuitBranch() {
    const p = wirePorts(this, 3);
    delete this.state.gs;
    return p ? this.dsDef(p[1], p[2], false) : { type: 'R', r: 1e9 };
  }

  /** 主边 D–S：三区都是电阻支路（值由上一帧的 U_GS / U_DS 定）；任一端子没接 ⇒ open */
  dsDef(a, b, dead) {
    const st = this.state.ds || (this.state.ds = {});
    if (dead) return { type: 'open', a, b, state: st };
    return { type: 'R', r: this.chR(), a, b, state: st };
  }
  /** 次边 G–S：栅极绝缘 ⇒ 恒为 open（I_G ≡ 0），只为让栅极口"属于某条支路"+ 回报 V(G)−V(S) */
  gsDef(a, b) {
    return { type: 'open', a, b, state: this.state.gs || (this.state.gs = {}) };
  }

  /** 沟道等值电阻（本帧常量）。U_DS→0 时 U_DS/I_D 是 0/0 ⇒ 改取解析极限 1/(2k·U_ov)（深可变电阻区 = 压控电阻） */
  chR() {
    const s = this.sgn();
    const ugs = s * ((this.state.gs && this.state.gs.U) || 0);
    const uds = Math.abs(this.state.U || 0);
    const m = mosLaw(ugs, uds, this.props.vth, this.kSI());
    if (m.region === 'cutoff') return offR(this.props.roff);
    if (!(m.id > 1e-12)) return clamp(1 / Math.max(1e-12, 2 * this.kSI() * m.vov), 1e-3, 1e9);
    return clamp(uds / m.id, 1e-3, 1e9);
  }

  step() {
    const s = this.sgn();
    const gs = this.state.gs || {};
    const ugs = s * (gs.U || 0);                 // 折成「增强为正」的口径
    const uds = Math.abs(this.state.U || 0);
    const m = mosLaw(ugs, uds, this.props.vth, this.kSI());
    const open = this.state.R === Infinity;      // 漏/源有一端悬空 ⇒ 端子电压无意义（同三极管）
    this.state.region = open ? 'dead' : m.region;
    this.state.on = !open && m.region !== 'cutoff';
    // 面板口径：端子带符号电压（V(G)−V(S) / V(D)−V(S)），P 沟道导通时为负 —— 与教科书一致
    this.state.Ugs = gs.U || 0;
    this.state.Uds = this.state.U || 0;
    this.state.Ugd = this.state.Ugs - this.state.Uds;
    this.state.vov = open ? 0 : m.vov;           // 过驱电压（幅值）
    this.state.Id = Math.abs(this.state.I || 0);
    this.state.gm = open ? 0 : m.gm;             // 跨导（分段：k·U_DS / 2k·U_ov）
    this.state.rds = open ? Infinity : this.chR();
  }

  render(g) {
    const { w, h } = this;
    shell(g, w, h, this.type === 'pmos' ? 'P 沟道 MOSFET' : 'N 沟道 MOSFET');
    const reg = this.state.region || 'cutoff';
    const col = REGION_COL[reg] || DIM;
    // 栅极板 + 沟道板（三段）
    g.strokeStyle = WIRE; g.lineWidth = 1.6;
    g.beginPath(); g.moveTo(-59, 0); g.lineTo(-44, 0); g.stroke();
    g.beginPath(); g.moveTo(-44, -16); g.lineTo(-44, 16); g.stroke();
    g.strokeStyle = col; g.lineWidth = 2.6;
    for (const [y0, y1] of [[-17, -7], [-5, 5], [7, 17]]) {
      g.beginPath(); g.moveTo(-34, y0); g.lineTo(-34, y1); g.stroke();
    }
    // 衬底引线 + 箭头（N 沟道指向沟道、P 沟道背离沟道）
    g.strokeStyle = WIRE; g.lineWidth = 1.6;
    g.beginPath(); g.moveTo(-34, 0); g.lineTo(-14, 0); g.stroke();
    const ax = this.type === 'pmos' ? -30 : -18;
    g.fillStyle = col; g.beginPath();
    if (this.type === 'pmos') { g.moveTo(ax - 8, 0); g.lineTo(ax, -4); g.lineTo(ax, 4); }
    else { g.moveTo(ax + 8, 0); g.lineTo(ax, -4); g.lineTo(ax, 4); }
    g.closePath(); g.fill();
    // 漏 / 源引线
    g.lineWidth = 2;
    g.beginPath(); g.moveTo(-34, -12); g.lineTo(24, -30); g.lineTo(59, -30); g.stroke();
    g.beginPath(); g.moveTo(-34, 12); g.lineTo(24, 30); g.lineTo(59, 30); g.stroke();
    dot(g, -59, 0); dot(g, 59, -30); dot(g, 59, 30);
    gfx.text(g, `${this.type === 'pmos' ? 'P' : 'N'} 沟道 · ${REGION_CN[reg] || '—'}  Vth=${this.props.vth}V`,
      -59, 38, { color: col, size: 9.5, align: 'left' });
    gfx.text(g, `U_GS ${fmtV(this.state.Ugs || 0)}   U_DS ${fmtV(this.state.Uds || 0)}`,
      -59, 48, { color: TXT, size: 9, align: 'left' });
    gfx.text(g, `I_D ${fmtA(this.state.Id || 0)}   g_m ${((this.state.gm || 0) * 1000).toFixed(2)} mS`,
      -59, 58, { color: HOT, size: 9, align: 'left' });
  }
}

function mosDefOf(type, name, icon, desc) {
  const def = {
    type, name, domain: PH, cat: CAT, icon, desc,
    w: 124, h: 124,
    ports: [
      { x: -59, y: 0, kind: 'wire', label: 'G' },
      { x: 59, y: -30, kind: 'wire', label: 'D' },
      { x: 59, y: 30, kind: 'wire', label: 'S' },
    ],
    defaults: { vth: 2, k: 1, roff: 1 },
    state: { region: 'cutoff', on: false, Ugs: 0, Uds: 0, Ugd: 0, vov: 0, Id: 0,
      gm: 0, rds: 0, gs: null, ds: null },
    stats: [
      { label: '工作区', read: (e) => REGION_CN[e.state.region] || '—' },
      { label: '电压GS U_GS', read: (e) => e.state.Ugs || 0, fmt: fmtV },
      { label: '电压DS U_DS', read: (e) => e.state.Uds || 0, fmt: fmtV },
      { label: '电压GD U_GD', read: (e) => e.state.Ugd || 0, fmt: fmtV },
      { label: '漏极电流 I_D', read: (e) => e.state.Id || 0, fmt: fmtA },
      { label: '过驱电压 U_ov', read: (e) => e.state.vov || 0, fmt: fmtV },
      { label: '跨导 g_m', read: (e) => (e.state.gm || 0) * 1000, digits: 2, unit: 'mS' },
    ],
    tags: ['MOSFET', type === 'pmos' ? 'P 沟道' : 'N 沟道', '场效应', '电压控流', '跨导', '三端', '非线性'],
    fields: [
      { k: 'vth', label: '阈值电压 U_GS(th)（幅值）', type: 'range', min: 0, max: 6, step: 0.1, unit: 'V' },
      { k: 'k', label: '导电因子 k', type: 'range', min: 0.1, max: 20, step: 0.1, unit: 'mA/V²' },
      { k: 'roff', label: '截止电阻', type: 'range', min: 0.1, max: 50, step: 0.1, unit: 'MΩ' },
    ],
    create: (x, y) => new Mosfet(def, x, y),
  };
  return def;
}
const nmosDef = mosDefOf('nmos', 'N 沟道 MOSFET', '⊓',
  '电压控流：U_GS>U_GS(th) 导通，恒流区 I_D = k·(U_GS−U_GS(th))²、可变电阻区 I_D = k(2U_ov·U_DS − U_DS²)；栅极绝缘 I_G=0');
const pmosDef = mosDefOf('pmos', 'P 沟道 MOSFET', '⊔',
  '与 N 沟道极性相反：U_GS 低于 −U_GS(th) 才导通（面板 U_GS/U_DS 为端子带符号值 ⇒ 导通时为负）');
DEFS.push(() => define(nmosDef));
DEFS.push(() => define(pmosDef));

// ══════════════════════════════════════════════════════════
// 插件
// ══════════════════════════════════════════════════════════
export default {
  id: 'xiaomo.equipment.electronics',
  name: '电学增量器材',
  version: '1.0.0',
  kind: 'equipment',
  domain: PH,
  order: 32,
  desc: '交流 / 暂态 / 半导体 / 三端器件：电容、电感、交流电源、示波器、变压器、二极管、光敏电阻、光敏二极管、NPN/PNP 三极管、N 沟道/P 沟道 MOSFET（12 件，接进真电路）',
  author: '小墨实验室',
  builtin: true,
  tags: ['电学', '交流', '暂态', '器材'],
  setup(ctx) { ctx.scope('equipment', () => DEFS.forEach(f => f())); },
};
