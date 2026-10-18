const DEFS = [];
// ══════════════════════════════════════════════════════════
// 物理域 · 声学器材（4 件）
//
// 与其它器材插件不同，声学有一处**必须说清楚的数值事实**：
// 引擎是 1/120 s 定步长，而声学关注的频率是几十 Hz 到几千 Hz。
// 440 Hz 在 120 Hz 采样下必然混叠 —— 所以本文件**绝不假装**在采样声音：
//
//   ① 物理量走解析式：v=fλ、拍频 |f₁−f₂|、L=nλ/2、L=10lg(I/I₀)…
//      全部先写成纯函数并 export，Node 里可用任意细步长断言（见测试文件）。
//   ② 画布上的波形是**每一帧重算的解析栅格**（等效采样率远高于显示分辨率），
//      它只服务于「看得见」，不参与物理演化。音叉用两个尺度：短窗口看载波，
//      长窗口（跨 ≥2 个包络谷底）用来**量**拍周期。
//   ③ 器材的 step(dt) 只更新解析量与栅格，不做任何时间积分 ——
//      声学没有需要引擎积分的状态，这一点与光学/电学不同，是刻意的。
//
// 另外：本文件不发出任何声音（用户要求绝对静音），声学全部用数值与图形表达。
// 每个器材**自带一个可断言的物理量**，没有「会响的装饰」。
// ══════════════════════════════════════════════════════════

import { Entity, gfx } from '../core/entity.js';
import { define } from './registry.js';

const PH = 'physics';
const CAT = '声学';
const PANEL = '#242c34', EDGE = '#39434d', TXT = '#e6edf3', DIM = '#8d96a0';
const HOT = '#ffd166', OK = '#4ade80', COOL = '#60a5fa', WALL = '#c9d1d9';

const TAU = Math.PI * 2;
const D2R = Math.PI / 180, R2D = 180 / Math.PI;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

// ══════════════════════════════════════════════════════════
// 一、纯计算（Node 可直接断言）
// ══════════════════════════════════════════════════════════

/** 声速随气温：v(T) = 331.3 + 0.606·T （m/s），v(20 ℃) = 343.4 m/s */
export function soundSpeed(T = 20) { return 331.3 + 0.606 * T; }
/** 20 ℃ 的声速，测试里对 340 m/s ±3% 断言用 */
export const SPEED_20 = soundSpeed(20);

/** 拍频 = 两频率之差（绝对差） */
export function beatFrequency(f1, f2) { return Math.abs(f1 - f2); }
/** 拍周期 = 1/|Δf|；Δf=0 时无拍（返回 Infinity） */
export function beatPeriod(f1, f2) {
  const d = beatFrequency(f1, f2);
  return d > 1e-12 ? 1 / d : Infinity;
}

/**
 * 采样：把解析波形在 [t0, t0+window] 上按 n 点光栅化（画布用；测试用细步长）
 * @param {(t:number)=>number} wave
 * @returns {{times:number[], values:number[]}}
 */
export function raster(wave, t0, window, n) {
  const times = [], values = [];
  for (let i = 0; i <= n; i++) {
    const t = t0 + (i / n) * window;
    times.push(t); values.push(wave(t));
  }
  return { times, values };
}

/** 双音叠加（拍）：p(t) = A[sin(2πf₁t) + sin(2πf₂t)] */
export function beatWave(f1, f2, amp = 1) {
  return (t) => amp * (Math.sin(TAU * f1 * t) + Math.sin(TAU * f2 * t));
}
/** 拍的**包络**解析式：|2A·cos(πΔf·t)| */
export function beatEnvelope(t, f1, f2, amp = 1) {
  return Math.abs(2 * amp * Math.cos(Math.PI * beatFrequency(f1, f2) * t));
}
/**
 * 从采样值里**测量**拍包络周期。
 *
 * 直接找 |v| 的局部极小是不行的：包络谷底（宽 ~Δt=1/(2Δf) 秒）里还挤着十几个载波
 * 周期的零点，局部极小会成簇出现，测出来的是载波周期而不是拍周期。
 * 所以先估载波周期（过零测频），对 |v| 做「一个载波周期宽的移动最大值」得到包络，
 * 再把低于阈值的时间段**聚成簇**取簇中心，最后算相邻簇中心的平均间隔。
 */
export function measureEnvelopePeriod(times, values) {
  const n = values.length;
  if (n < 8) return NaN;
  const dt = times[1] - times[0];
  const fc = measuredFreq(times, values);
  const w = isFinite(fc) && fc > 0 ? Math.max(1, Math.round(1 / fc / dt)) : 1;
  const env = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    let m = 0;
    const lo = Math.max(0, i - w), hi = Math.min(n - 1, i + w);
    for (let k = lo; k <= hi; k++) { const a = Math.abs(values[k]); if (a > m) m = a; }
    env[i] = m;
  }
  let amax = 0;
  for (const v of env) if (v > amax) amax = v;
  if (!(amax > 0)) return NaN;
  const thr = 0.35 * amax;
  const centers = [];
  let s = -1;
  for (let i = 0; i < n; i++) {
    const below = env[i] < thr;
    if (below && s < 0) s = i;
    if ((!below || i === n - 1) && s >= 0) { centers.push(times[Math.floor((s + i) / 2)]); s = -1; }
  }
  if (centers.length < 2) return NaN;
  return (centers[centers.length - 1] - centers[0]) / (centers.length - 1);
}

/** 上升过零测频（本文件自带一份：插件文件之间不互相 import，各自独立） */
export function measuredFreq(times, values) {
  const cross = [];
  for (let i = 1; i < values.length; i++) {
    if (values[i - 1] < 0 && values[i] >= 0) {
      const d = values[i] - values[i - 1];
      cross.push(times[i - 1] + (d !== 0 ? -values[i - 1] / d : 0) * (times[i] - times[i - 1]));
    }
  }
  if (cross.length < 2) return NaN;
  return (cross.length - 1) / (cross[cross.length - 1] - cross[0]);
}

/** 自相关测基频：对含谐波的复合波形比过零法稳健 */
export function autocorrFreq(times, values) {
  const n = values.length;
  if (n < 16) return NaN;
  const dt = times[1] - times[0];
  let mean = 0; for (const v of values) mean += v;
  mean /= n;
  const y = values.map(v => v - mean);
  const minLag = Math.max(2, Math.floor(0.002 / dt));       // 忽略 2 ms 以内
  const maxLag = Math.floor(n / 2);
  if (maxLag <= minLag + 1) return NaN;
  const r = new Array(maxLag + 2).fill(0);
  let rmax = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let s = 0;
    for (let i = 0; i + lag < n; i++) s += y[i] * y[i + lag];
    r[lag] = s / (n - lag);
    if (r[lag] > rmax) rmax = r[lag];
  }
  if (!(rmax > 0)) return NaN;
  // 取**第一个像样的局部极大**，而不是全局最大：周期信号的自相关在 2T、3T… 处一样高，
  // 全局最大会随机跳到某个长滞后上（实测纯 440 Hz 被量成 40 Hz）。峰位再用抛物线插值细化。
  const thr = 0.5 * rmax;
  for (let lag = minLag + 1; lag < maxLag; lag++) {
    if (r[lag] >= thr && r[lag] >= r[lag - 1] && r[lag] > r[lag + 1]) {
      const den = r[lag - 1] - 2 * r[lag] + r[lag + 1];
      const d = den !== 0 ? (r[lag - 1] - r[lag + 1]) / (2 * den) : 0;
      const lagF = lag + Math.max(-1, Math.min(1, d));
      return 1 / (lagF * dt);
    }
  }
  return NaN;
}

/** 闭管/开管的波长：闭管 L = nλ/4（n 奇）、开管 L = nλ/2 */
export function lambdaOf(mode, n, L) {
  const k = mode === 'closed' ? 4 : 2;
  return (k * L) / n;
}
/** 闭合/开口管的共振长度（cm 计，返回同单位） */
export function resonanceLength(mode, n, lambda) {
  const k = mode === 'closed' ? 4 : 2;
  return (n * lambda) / k;
}
/** 共振频率 f = v/λ */
export function resonantFreq(mode, n, L, v = SPEED_20) { return v / lambdaOf(mode, n, L); }
/** 闭管只有奇数谐振（n = 1,3,5…）；开管全都有 */
export function isAllowedMode(mode, n) { return mode === 'closed' ? n % 2 === 1 : true; }
/** 由共振长度反推声速：v = f·λ */
export function speedFromResonance(f, lambda) { return f * lambda; }
/** 共振响应（洛伦兹型）：A(f)/A₀ = 1/√(1 + (2Q(f−f₀)/f₀)²) */
export function resonanceResponse(f, f0, Q = 40) {
  const x = (2 * Q * (f - f0)) / f0;
  return 1 / Math.sqrt(1 + x * x);
}
/** 扫描找响应峰值位置（与解析 f₀ 对照） */
export function findResonancePeak(f0, Q, lo, hi, steps = 2000) {
  let bf = lo, bv = -Infinity;
  for (let i = 0; i <= steps; i++) {
    const f = lo + (i / steps) * (hi - lo);
    const v = resonanceResponse(f, f0, Q);
    if (v > bv) { bv = v; bf = f; }
  }
  return { f: bf, amp: bv };
}

/** 声强（点声源、球面自由场）：I = P/(4πr²) */
export function soundIntensity(P, r) { return r > 0 ? P / (4 * Math.PI * r * r) : Infinity; }
/** 声强级：L = 10·lg(I/I₀)，I₀ = 1e-12 W/m² */
export const I0 = 1e-12;
export function soundLevelDb(I) { return I > 0 ? 10 * Math.log10(I / I0) : -Infinity; }
/** 距离加倍 → 声强级下降 6.0206 dB（球面衰减的解析结论） */
export function dbPerDoubling() { return 10 * Math.log10(4); }
/** 声强级降到 0 dB（听阈）的距离 */
export function thresholdDistance(P) { return Math.sqrt(P / (4 * Math.PI * I0)); }
/** 声功率级 Lw[dB] → 声功率 P[W]（Lw = 10lg(P/P₀)，P₀ = 1e-12 W） */
export function powerFromLevel(Lw) { return I0 * Math.pow(10, Lw / 10); }
/**
 * 由声功率级直接算某距离处的声强级（球面自由场的解析式）：
 *   L(r) = Lw − 10·lg(4πr²) = Lw − 10lg(4π) − 20lg(r)
 * 这是分贝计的**解析解**，与 I=P/(4πr²) 再取 10lg 的数值路径互为独立对照。
 */
export function levelAtRadius(Lw, r) { return Lw - 10 * Math.log10(4 * Math.PI * r * r); }
/** 球面自由场在 r=1 m 处的固定衰减量 10lg(4π) ≈ 10.99 dB */
export function levelDropAt1m() { return 10 * Math.log10(4 * Math.PI); }
/** 多普勒：f' = f·(v ± v₀)/(v ∓ v_s)（观察者靠近取 +v₀，声源靠近取 −v_s） */
export function doppler(f, v, vObs = 0, vSrc = 0) { return f * ((v + vObs) / (v - vSrc)); }

/** 复合波形：三路正弦叠加（合成/拍/驻波都用它） */
export function harmonics(comps) {
  return (t) => comps.reduce((s, c) => s + (c.a || 0) * Math.sin(TAU * (c.f || 0) * t + (c.phi || 0) * D2R), 0);
}
/** 驻波包络：A(x) = |2A·sin(kx)|，k=2π/λ */
export function standingEnvelope(x, lambda, amp = 1) {
  return Math.abs(2 * amp * Math.sin((TAU * x) / lambda));
}

const a_ok = (v) => typeof v === 'number' && isFinite(v) && v > 0;

function shell(g, w, h) {
  gfx.fillRR(g, -w / 2, -h / 2, w, h, 6, PANEL);
  gfx.strokeRR(g, -w / 2, -h / 2, w, h, 6, EDGE, 1.2);
}
function poly(g, pts, color, lw = 1.4) {
  if (pts.length < 2) return;
  g.strokeStyle = color; g.lineWidth = lw;
  g.beginPath(); g.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]);
  g.stroke();
}

// ══════════════════════════════════════════════════════════
// 二、器材 1：音叉（拍频）
// ══════════════════════════════════════════════════════════
class TuningFork extends Entity {
  step(dt, world) {
    const f1 = this.props.f, a1 = this.props.amp;
    // 就近找第二只音叉 → 形成拍
    let mate = null, bd = 260;
    for (const e of world.entities) {
      if (e === this || e.type !== 'tuningfork') continue;
      const d = Math.hypot(e.x - this.x, e.y - this.y);
      if (d < bd) { bd = d; mate = e; }
    }
    this.state.mateId = mate ? mate.id : null;
    this.state.dist = mate ? Math.hypot(mate.x - this.x, mate.y - this.y) : 0;
    const f2 = mate ? mate.props.f : null;
    if (mate) {
      this.state.f1 = f1; this.state.f2 = f2;
      this.state.fbeat = beatFrequency(f1, f2);
      this.state.Tbeat = beatPeriod(f1, f2);
      this.state.df = Math.abs(f1 - f2) / Math.max(f1, f2);
    } else {
      this.state.fbeat = 0; this.state.Tbeat = Infinity; this.state.df = 0;
    }
    // 解析栅格。两个尺度：画图用短窗口（看得见载波），量拍周期用长窗口
    // （至少要跨 2 个包络谷底，否则「相邻谷底间隔」根本不存在）。
    const Tw = this.state.fbeat > 0 && isFinite(this.state.Tbeat) ? this.state.Tbeat : 0;
    const wave = Tw > 0 ? beatWave(f1, f2, a1) : (t) => a1 * Math.sin(TAU * f1 * t);
    const windowS = Tw > 0 ? Math.max(0.05, Math.min(1.2, Tw * 2.5)) : 0.05;
    const N = Tw > 0 ? 900 : 360;
    this.state.raster = raster(wave, 0, windowS, N);
    this.state.windowS = windowS;
    this.state.envPeriodMeas = Tw > 0
      ? measureEnvelopePeriod(this.state.raster.times, this.state.raster.values) : Infinity;
  }

  render(g) {
    const { w, h } = this;
    shell(g, w, h);
    const cy = -h / 2 + 20;
    // 音叉：U 形
    g.strokeStyle = TXT; g.lineWidth = 2.2;
    g.beginPath();
    g.moveTo(-9, cy + 12); g.lineTo(-9, cy - 8);
    g.moveTo(9, cy + 12); g.lineTo(9, cy - 8);
    g.moveTo(-9, cy + 12); g.lineTo(9, cy + 12);
    g.moveTo(0, cy + 12); g.lineTo(0, cy + 20);
    g.stroke();
    // 振动弧线
    g.strokeStyle = HOT; g.globalAlpha = 0.7; g.lineWidth = 1;
    for (let i = 1; i <= 2; i++) {
      g.beginPath(); g.arc(0, cy + 14, 11 + i * 3, -2.4, -0.7); g.stroke();
      g.beginPath(); g.arc(0, cy + 14, 11 + i * 3, 0.7, 2.4); g.stroke();
    }
    g.globalAlpha = 1;

    // 波形 + 包络
    const gx = -w / 2 + 8, gy = 6, gw = w - 16, gh = h / 2 - 14;
    g.strokeStyle = EDGE; g.lineWidth = 1; g.strokeRect(gx, gy, gw, gh);
    const r = this.state.raster || { times: [], values: [] };
    const t0 = r.times.length ? r.times[0] : 0;
    const win = Math.max(1e-9, this.state.windowS || 1);
    const aMax = Math.max(0.001, this.props.amp * 2);
    poly(g, r.values.map((v, i) => [
      gx + ((r.times[i] - t0) / win) * gw,
      gy + gh / 2 - clamp(v / aMax, -1, 1) * (gh / 2 * 0.85),
    ]), COOL, 1.1);
    if (this.state.fbeat > 0) {
      const env = r.times.map(t => beatEnvelope(t, this.state.f1, this.state.f2, this.props.amp));
      poly(g, env.map((v, i) => [gx + ((r.times[i] - t0) / win) * gw, gy + gh / 2 - (v / aMax) * (gh / 2 * 0.85)]), HOT, 1);
    }

    gfx.text(g, `f=${this.props.f} Hz`, 0, h / 2 - 30, { color: TXT, size: 9.5 });
    gfx.text(g, this.state.mateId
      ? `拍频 |f₁−f₂|=${this.state.fbeat.toFixed(2)} Hz（T=${this.state.Tbeat.toFixed(3)}s）`
      : '附近再放一只音叉即产生拍',
      0, h / 2 - 20, { color: this.state.mateId ? HOT : DIM, size: 9 });
    if (this.state.mateId) {
      gfx.text(g, `实测包络周期 ${isFinite(this.state.envPeriodMeas) ? this.state.envPeriodMeas.toFixed(3) : '—'} s`,
        0, h / 2 - 10, { color: OK, size: 9 });
    }
  }
}
const forkDef = {
  type: 'tuningfork', name: '音叉', domain: PH, cat: CAT, icon: '🎵',
  desc: '频率可调；两只音叉同场时叠加成拍：f_beat = |f₁−f₂|，包络周期 1/|Δf|',
  w: 104, h: 96,
  ports: [],
  defaults: { f: 440, amp: 1 },
  state: { fbeat: 0, Tbeat: Infinity, raster: { times: [], values: [] }, windowS: 0.05 },
  tags: ['音叉', '拍频', '声波', '频率'],
  fields: [
    { k: 'f', label: '频率', type: 'range', min: 200, max: 1000, step: 1, unit: 'Hz' },
    { k: 'amp', label: '振幅', type: 'range', min: 0.2, max: 2, step: 0.1, unit: 'a.u.' },
  ],
  // ── B4 第 3 步「替换」· 声学首个试点（plans/11 §6.3 第 3 步）──
  //    ⚠ 声明必须按**跑过 step 之后的运行时 state 键**来写，**不是** `def.state` 的初值：
  //      初值只有 `fbeat/Tbeat/raster/windowS`，而运行时还有 `dist`（与配对音叉距离）与
  //      `df`（频率相对差）—— 这两把尺子**只在 step 里生成**。照初值写会**丢两行**，
  //      而丢行在面板上就是「量没了」，属最严重的一类回归（本探针 §⑥ 的 `dropped` 就是专门抓它的）。
  //    标签/单位一律照抄 `STATE_LABELS.声学`；**不写 digits** ⇒ 落回 fmtLive，与兜底同一条口径。
  //    （`Tbeat` 运行时为 Infinity、`raster` 是对象 ⇒ 兜底本来就不收这两键，此处同样不声明。）
  stats: [
    { label: '拍频', unit: 'Hz', read: (e) => e.state.fbeat },
    { label: '观测窗长', unit: 's', read: (e) => e.state.windowS },
    { label: '与配对音叉距离', unit: 'm', read: (e) => e.state.dist },
    { label: '频率相对差（比值）', read: (e) => e.state.df },
  ],
  create: (x, y) => new TuningFork(forkDef, x, y),
};
DEFS.push(() => define(forkDef));

// ══════════════════════════════════════════════════════════
// 三、器材 2：共鸣管（管长 ↔ 波长，反推声速）
// ══════════════════════════════════════════════════════════
class ResonanceTube extends Entity {
  step(dt, world) {
    const mode = this.props.mode;
    const nRaw = Math.round(this.props.n);
    const n = mode === 'closed' ? (nRaw % 2 === 0 ? nRaw + 1 : nRaw) : nRaw;   // 闭管只有奇次
    this.state.nUsed = n;
    this.state.rejected = n !== nRaw;
    const L = this.props.L / 100;                       // cm → m
    const v = soundSpeed(this.props.temp);
    const lambda = lambdaOf(mode, n, L);
    const f0 = v / lambda;
    this.state.v = v;
    this.state.lambda = lambda;
    this.state.f0 = f0;
    this.state.T = 1 / f0;
    // 由「共振长度」反推声速（与上面同一条式子反向走，用于断言闭环）
    this.state.vBack = speedFromResonance(f0, lambda);
    // 响应曲线：扫描驱动频率
    const amp = resonanceResponse(this.props.f, f0, this.props.Q);
    this.state.amp = amp;
    // 峰值位置扫描（与解析 f0 对照）
    if (!this.state.peak || this.state.peak.f0 !== f0) {
      this.state.peak = { f0, ...findResonancePeak(f0, this.props.Q, f0 * 0.7, f0 * 1.3, 4000) };
    }
    this.state.dPeak = this.state.peak ? Math.abs(this.state.peak.f - f0) / f0 : NaN;
    this.state.atResonance = Math.abs(this.props.f - f0) / f0 < 0.01;
    // 管口波节/波腹示意用光栅
    this.state.raster = raster((t) => amp * Math.sin(TAU * this.props.f * t), 0, 3 / f0, 200);
  }

  render(g) {
    const { w, h } = this;
    shell(g, w, h);
    const cy = -h / 2 + 18;
    const x0 = -w / 2 + 12, x1 = w / 2 - 12;
    // 管身
    g.fillStyle = '#1b2229';
    gfx.fillRR(g, x0, cy - 9, x1 - x0, 18, 3, '#1b2229');
    g.strokeStyle = EDGE; g.lineWidth = 1.2;
    gfx.strokeRR(g, x0, cy - 9, x1 - x0, 18, 3, EDGE, 1.2);
    // 管内驻波
    const closed = this.props.mode === 'closed';
    // 管内驻波形状（解析）：闭管 y=sin(nπx/2L) —— 闭端是波节、开口是波腹；
    // 开管 y=sin(nπx/L) —— 两端都是波节。n 与器材当前谐次一致。
    const pts = [];
    for (let i = 0; i <= 120; i++) {
      const s = i / 120;
      const y = Math.sin((closed ? 0.5 : 1) * this.state.nUsed * Math.PI * s);
      pts.push([x0 + s * (x1 - x0), cy - y * 7 * (this.state.amp || 0)]);
    }
    poly(g, pts, HOT, 1.3);
    // 端点标记：闭管一端封闭（实心）
    if (closed) { g.fillStyle = WALL; g.fillRect(x0 - 2, cy - 10, 4, 20); }
    const mL = (this.props.L / 100).toFixed(3);
    gfx.text(g, `${closed ? '闭管' : '开管'} L=${this.props.L}cm（${mL}m） n=${this.state.nUsed}`,
      0, h / 2 - 34, { color: TXT, size: 9.5 });
    gfx.text(g, `λ=${(this.state.lambda || 0).toFixed(3)}m  f₀=v/λ=${(this.state.f0 || 0).toFixed(1)}Hz`,
      0, h / 2 - 24, { color: HOT, size: 9 });
    gfx.text(g, `v(T=${this.props.temp}℃)=${(this.state.v || 0).toFixed(1)}m/s`, 0, h / 2 - 14, { color: DIM, size: 9 });
    gfx.text(g, this.state.atResonance
      ? `共振！增益 ${(this.state.amp || 0).toFixed(2)}`
      : `驱动 ${this.props.f}Hz 增益 ${(this.state.amp || 0).toFixed(2)}`,
      0, 2, { color: this.state.atResonance ? OK : DIM, size: 9 });
  }
}
const tubeDef = {
  type: 'resonancetube', name: '共鸣管', domain: PH, cat: CAT, icon: '🎶',
  desc: '闭管 L=nλ/4（n 奇）、开管 L=nλ/2；由共振长度反推声速 v=fλ，响应峰值在 f₀',
  w: 168, h: 84,
  ports: [],
  defaults: { L: 33.2, mode: 'closed', n: 1, f: 258, Q: 40, temp: 20 },
  state: { lambda: 0, f0: 0, v: 0, amp: 1, nUsed: 1 },
  tags: ['共鸣管', '驻波', '波长', '声速', '共振'],
  fields: [
    { k: 'L', label: '管长 L', type: 'range', min: 5, max: 120, step: 0.1, unit: 'cm' },
    { k: 'mode', label: '管口', type: 'select', options: [['closed', '一端闭（闭管）'], ['open', '两端开（开管）']] },
    { k: 'n', label: '谐次 n', type: 'range', min: 1, max: 7, step: 1, unit: '' },
    { k: 'f', label: '驱动频率', type: 'range', min: 50, max: 2000, step: 1, unit: 'Hz' },
    { k: 'Q', label: '品质因数 Q', type: 'range', min: 5, max: 200, step: 5, unit: '' },
    { k: 'temp', label: '气温', type: 'range', min: 0, max: 40, step: 1, unit: '℃' },
  ],
  // ── B4 第 3 步 · 声学试点（**8 行**，按运行时 state 序；初值只有前 5 个键）──
  //    逐字取自 `STATE_LABELS.声学`。⚠ 声学表**恰好 8 项** ⇒ 与兜底 `LIVE_FALLBACK_MAX = 8` 边界重合，
  //    所以这一件新旧行数相同、也是本分类里**唯一**能真正做到「逐字相同」的一件之一。
  //    ⚠ fields 里另有 `n:谐次 n`，但那一行的真源是 `state.nUsed`（「参与谐次 n」来自域表）⇒ 不冲突。
  stats: [
    { label: '波长', unit: 'm', read: (e) => e.state.lambda },
    { label: '基频', unit: 'Hz', read: (e) => e.state.f0 },
    { label: '声速', unit: 'm/s', read: (e) => e.state.v },
    { label: '响应幅度', read: (e) => e.state.amp },
    { label: '参与谐次 n', read: (e) => e.state.nUsed },
    { label: '周期', unit: 's', read: (e) => e.state.T },
    { label: '反推声速', unit: 'm/s', read: (e) => e.state.vBack },
    { label: '峰位相对偏差（比值）', read: (e) => e.state.dPeak },
  ],
  create: (x, y) => new ResonanceTube(tubeDef, x, y),
};
DEFS.push(() => define(tubeDef));

// ══════════════════════════════════════════════════════════
// 四、器材 3：分贝计
// ══════════════════════════════════════════════════════════
class SoundLevel extends Entity {
  step() {
    const Lw = this.props.Lw;
    const P = powerFromLevel(Lw);
    const r = this.props.r;
    const I = soundIntensity(P, r);
    this.state.Lw = Lw;
    this.state.P = P;
    this.state.I = I;
    this.state.L = soundLevelDb(I);                              // 路径 A：I → 10lg(I/I₀)
    this.state.LAnalytic = levelAtRadius(Lw, r);                 // 路径 B：解析式 Lw−10lg(4πr²)
    this.state.dL = Math.abs(this.state.L - this.state.LAnalytic);
    this.state.L2 = soundLevelDb(soundIntensity(P, r * 2));
    this.state.drop = this.state.L - this.state.L2;              // 应当 = 10lg4 = 6.02
    this.state.theory = dbPerDoubling();
    this.state.rThresh = thresholdDistance(P);
    // 指针位置：0…120 dB 映射
    this.state.needle = clamp(this.state.L / 120, 0, 1);
  }

  render(g) {
    const { w, h } = this;
    shell(g, w, h);
    const cx = 0, cy = h / 2 - 34, R = 30;
    // 刻度盘
    g.strokeStyle = EDGE; g.lineWidth = 1.4;
    g.beginPath(); g.arc(cx, cy, R, Math.PI, TAU); g.stroke();
    for (let i = 0; i <= 6; i++) {
      const a = Math.PI + (i / 6) * Math.PI;
      const x1 = cx + Math.cos(a) * R, y1 = cy + Math.sin(a) * R;
      const x2 = cx + Math.cos(a) * (R - 6), y2 = cy + Math.sin(a) * (R - 6);
      g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke();
      gfx.text(g, String(i * 20), cx + Math.cos(a) * (R - 14), cy + Math.sin(a) * (R - 14) + 3,
        { color: DIM, size: 7.5 });
    }
    // 指针
    const a = Math.PI + this.state.needle * Math.PI;
    g.strokeStyle = this.state.L > 85 ? '#f87171' : OK; g.lineWidth = 2;
    g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx + Math.cos(a) * (R - 4), cy + Math.sin(a) * (R - 4)); g.stroke();
    g.fillStyle = TXT; g.beginPath(); g.arc(cx, cy, 2.4, 0, TAU); g.fill();
    // 声源与球面波
    const sx = -w / 2 + 14, sy = -h / 2 + 16;
    g.fillStyle = HOT; g.beginPath(); g.arc(sx, sy, 4, 0, TAU); g.fill();
    g.strokeStyle = COOL; g.globalAlpha = 0.6; g.lineWidth = 1;
    for (let i = 1; i <= 3; i++) { g.beginPath(); g.arc(sx, sy, i * 7, 0, TAU); g.stroke(); }
    g.globalAlpha = 1;
    gfx.text(g, `${this.state.L.toFixed(2)} dB`, 0, 6, { color: TXT, size: 11 });
    gfx.text(g, `Lw=${this.props.Lw}dB → I=${(this.state.I || 0).toExponential(2)} W/m²  r=${this.props.r}m`,
      0, h / 2 - 22, { color: DIM, size: 9 });
    gfx.text(g, `距离加倍 −${this.state.drop.toFixed(3)} dB（理论 ${this.state.theory.toFixed(3)}）`,
      0, h / 2 - 12, { color: HOT, size: 8.5 });
  }
}
const dbDef = {
  type: 'soundlevel', name: '分贝计', domain: PH, cat: CAT, icon: '📢',
  desc: '声功率级 Lw 决定声功率 P，球面自由场 I = P/(4πr²)、L = 10·lg(I/I₀)；距离加倍衰减 10lg4 = 6.02 dB',
  w: 132, h: 104,
  ports: [],
  defaults: { Lw: 90, r: 1 },
  state: { I: 0, L: 0, LAnalytic: 0, Lw: 90, P: 1e-3, needle: 0, drop: 0, theory: 6.0206 },
  tags: ['分贝', '声强级', '声功率级', '球面衰减'],
  fields: [
    { k: 'Lw', label: '声源声功率级 Lw', type: 'range', min: 40, max: 130, step: 1, unit: 'dB' },
    { k: 'r', label: '测量距离', type: 'range', min: 0.1, max: 50, step: 0.1, unit: 'm' },
  ],
  // ── B4 第 3 步 · 声学试点（**11 行**，运行时 state 序）──
  //    ⚠ 这一件是本分类里**唯一会改变行数**的：运行时 11 个数值键 > `LIVE_FALLBACK_MAX = 8`，
  //      旧路径（兜底）只出 8 行 + 一行 `… 还有 N 项读数` 占位；而 stats 路径**不受该上限约束**
  //      （`inspector.js:466` 的截断在兜底分支内），于是 11 行全部上屏 ——
  //      **信息更完整**，是有意的行为变化，已在 `plans/11 §6.3` 与探针 §㉓/§⑥ 登记。
  //    ⚠ 「声源声功率级 Lw」的标签带后缀、单位 dB 来自**器材自己的 fields**（`inspector.js:461` 处
  //      fields 优先于域表），不是 `STATE_LABELS.声学.Lw` 的 `['声源声功率级','dB']` ⇒ 照 fields 写。
  stats: [
    { label: '声强', unit: 'W/m²', read: (e) => e.state.I },
    { label: '声压级', unit: 'dB', read: (e) => e.state.L },
    { label: '解析声压级', unit: 'dB', read: (e) => e.state.LAnalytic },
    { label: '声源声功率级 Lw', unit: 'dB', read: (e) => e.state.Lw },
    { label: '声源功率', unit: 'W', read: (e) => e.state.P },
    { label: '表针位置（0–1）', read: (e) => e.state.needle },
    { label: '距离加倍衰减', unit: 'dB', read: (e) => e.state.drop },
    { label: '理论衰减', unit: 'dB', read: (e) => e.state.theory },
    { label: '两路声压级差', unit: 'dB', read: (e) => e.state.dL },
    { label: '两倍距离处声压级', unit: 'dB', read: (e) => e.state.L2 },
    { label: '阈值距离', unit: 'm', read: (e) => e.state.rThresh },
  ],
  create: (x, y) => new SoundLevel(dbDef, x, y),
};
DEFS.push(() => define(dbDef));

// ══════════════════════════════════════════════════════════
// 五、器材 4：波形显示（合成 / 拍 / 驻波）
// ══════════════════════════════════════════════════════════
class Waveform extends Entity {
  comps() {
    return [
      { f: this.props.f1, a: this.props.a1 },
      { f: this.props.f2, a: this.props.a2 },
      { f: this.props.f3, a: this.props.a3 },
    ].filter(c => c.f > 0 && a_ok(c.a));
  }

  step(dt, world) {
    const comps = this.comps();
    const win = Math.max(0.005, this.props.windowMs / 1000);
    const wave = harmonics(comps);
    const r = raster(wave, 0, win, 480);
    this.state.raster = r;
    this.state.windowS = win;
    this.state.n = comps.length;
    // 从栅格**测量**基频（过零 + 自相关两条路，与输入对照）
    this.state.fMeas = measuredFreq(r.times, r.values);
    this.state.fAuto = autocorrFreq(r.times, r.values);
    // 拍模式下：零差点测到的是**载波** f̄=(f₁+f₂)/2（这是解析结论），
    // 而自相关需要「窗口 ≫ 拍周期」才认得出基频，本器材窗口默认 100 ms
    // < 拍周期 1/|Δf|，所以拍模式下自相关读数**不可用**，如实标出来。
    const f1 = this.props.f1, f2 = this.props.f2;
    const isBeat = this.props.mode === 'beat' && a_ok(f2) && Math.abs(f1 - f2) > 1e-9;
    this.state.fCarrier = isBeat ? (f1 + f2) / 2 : f1;
    this.state.beat = isBeat ? Math.abs(f1 - f2) : 0;
    this.state.Tbeat = isBeat ? 1 / Math.abs(f1 - f2) : Infinity;
    this.state.fAutoUsable = !isBeat;
    this.state.fIn = this.props.f1;
    this.state.dZc = Math.abs(this.state.fMeas - this.state.fCarrier) / this.state.fCarrier;
    this.state.dAc = this.state.fAutoUsable
      ? Math.abs(this.state.fAuto - this.props.f1) / this.props.f1 : NaN;
    this.state.pp = Math.max(...r.values) - Math.min(...r.values);
    // 驻波：沿 x 的包络（λ 由 f1 与 343 m/s 给出）
    if (this.props.mode === 'standing') {
      const lambda = SPEED_20 / this.props.f1;
      this.state.lambda = lambda;
      this.state.envX = raster((x) => standingEnvelope(x, lambda, this.props.a1), 0, lambda * 2, 200);
    }
  }

  render(g) {
    const { w, h } = this;
    shell(g, w, h);
    const gx = -w / 2 + 10, gy = -h / 2 + 12, gw = w - 20, gh = h / 2 + 2;
    g.fillStyle = '#101820'; gfx.fillRR(g, gx, gy, gw, gh, 4, '#101820');
    g.strokeStyle = '#22303c'; g.lineWidth = 1;
    for (let i = 1; i < 8; i++) {
      const x = gx + (i / 8) * gw;
      g.beginPath(); g.moveTo(x, gy); g.lineTo(x, gy + gh); g.stroke();
    }
    g.beginPath(); g.moveTo(gx, gy + gh / 2); g.lineTo(gx + gw, gy + gh / 2); g.stroke();
    const r = this.state.raster || { times: [], values: [] };
    const win = Math.max(1e-9, this.state.windowS || 1);
    const aMax = Math.max(1e-9, this.state.pp / 2);
    if (this.props.mode === 'standing' && this.state.envX) {
      const e = this.state.envX;
      poly(g, e.values.map((v, i) => [
        gx + (e.times[i] / (e.times[e.times.length - 1] || 1)) * gw,
        gy + gh / 2 - clamp(v / (2 * Math.max(0.001, this.props.a1)), 0, 1) * (gh / 2 * 0.85),
      ]), HOT, 1.2);
    }
    poly(g, r.values.map((v, i) => [
      gx + (r.times[i] / win) * gw,
      gy + gh / 2 - clamp(v / (aMax * 1.05), -1, 1) * (gh / 2 * 0.9),
    ]), OK, 1.3);

    gfx.text(g, `${this.state.n} 路正弦 · ${this.props.mode === 'beat' ? '拍' : this.props.mode === 'standing' ? '驻波' : '合成'}`,
      0, h / 2 - 30, { color: TXT, size: 9.5 });
    gfx.text(g, `${this.state.beat > 0 ? `载波 f̄=${this.state.fCarrier.toFixed(1)}Hz · 拍频 ${this.state.beat.toFixed(1)}Hz · ` : ''}`
      + `栅格过零实测 ${isFinite(this.state.fMeas) ? this.state.fMeas.toFixed(2) : '—'}Hz`
      + `（偏差 ${isFinite(this.state.dZc) ? (this.state.dZc * 100).toFixed(2) : '—'}%）`,
      0, h / 2 - 20, { color: OK, size: 9 });
    gfx.text(g, this.state.fAutoUsable
      ? `自相关 ${isFinite(this.state.fAuto) ? this.state.fAuto.toFixed(2) : '—'}Hz（偏差 ${isFinite(this.state.dAc) ? (this.state.dAc * 100).toFixed(2) : '—'}%）  峰峰 ${(this.state.pp || 0).toFixed(2)}`
      : `自相关不可用：拍周期 ${isFinite(this.state.Tbeat) ? this.state.Tbeat.toFixed(2) : '—'}s 长于窗口 ${(this.state.windowS * 1000).toFixed(0)}ms`,
      0, h / 2 - 10, { color: this.state.fAutoUsable ? DIM : HOT, size: 9 });
  }
}
const waveDef = {
  type: 'waveform', name: '波形显示', domain: PH, cat: CAT, icon: '🌊',
  desc: '三路正弦叠加 / 拍 / 驻波包络；栅格重建基频与输入一致（过零 + 自相关两条路互校）',
  w: 196, h: 124,
  ports: [],
  defaults: { f1: 440, a1: 1, f2: 444, a2: 1, f3: 0, a3: 0, mode: 'beat', windowMs: 100 },
  state: { raster: { times: [], values: [] }, fMeas: NaN, fAuto: NaN, fIn: 440, pp: 0 },
  tags: ['波形', '合成', '拍', '驻波', '谐波'],
  fields: [
    { k: 'f1', label: '频率 f₁', type: 'range', min: 20, max: 2000, step: 1, unit: 'Hz' },
    { k: 'a1', label: '振幅 A₁', type: 'range', min: 0, max: 2, step: 0.1, unit: 'a.u.' },
    { k: 'f2', label: '频率 f₂', type: 'range', min: 0, max: 2000, step: 1, unit: 'Hz' },
    { k: 'a2', label: '振幅 A₂', type: 'range', min: 0, max: 2, step: 0.1, unit: 'a.u.' },
    { k: 'f3', label: '频率 f₃', type: 'range', min: 0, max: 2000, step: 1, unit: 'Hz' },
    { k: 'a3', label: '振幅 A₃', type: 'range', min: 0, max: 2, step: 0.1, unit: 'a.u.' },
    { k: 'mode', label: '显示', type: 'select', options: [['sum', '合成'], ['beat', '拍'], ['standing', '驻波']] },
    { k: 'windowMs', label: '窗口', type: 'range', min: 5, max: 500, step: 5, unit: 'ms' },
  ],
  // ── B4 第 3 步 · 声学试点（**10 行**，运行时 state 序；初值只有 `raster/fMeas/fAuto/fIn/pp`）──
  //    ⚠ 与 `soundlevel` 同类：运行时 10 个数值键 > `LIVE_FALLBACK_MAX = 8`，旧路径只出 8 行 + 占位行；
  //      stats 路径不受上限约束 ⇒ 10 行全出（有意放开截断，见 `plans/11 §6.3`）。
  //    ⚠ `windowS` 在这里与 `tuningfork` 同名同义（声学表的「观测窗长」）—— 两件器材共用同一张域表。
  stats: [
    { label: '实测频率', unit: 'Hz', read: (e) => e.state.fMeas },
    { label: '自相关频率', unit: 'Hz', read: (e) => e.state.fAuto },
    { label: '输入频率', unit: 'Hz', read: (e) => e.state.fIn },
    { label: '峰峰值', read: (e) => e.state.pp },
    { label: '观测窗长', unit: 's', read: (e) => e.state.windowS },
    { label: '分量数', read: (e) => e.state.n },
    { label: '载波频率', unit: 'Hz', read: (e) => e.state.fCarrier },
    { label: '分量差（拍频）', unit: 'Hz', read: (e) => e.state.beat },
    { label: '拍周期', unit: 's', read: (e) => e.state.Tbeat },
    { label: '过零测频偏差（比值）', read: (e) => e.state.dZc },
  ],
  create: (x, y) => new Waveform(waveDef, x, y),
};
DEFS.push(() => define(waveDef));

// ══════════════════════════════════════════════════════════
// 插件
// ══════════════════════════════════════════════════════════
export default {
  id: 'xiaomo.equipment.acoustics',
  name: '声学器材',
  version: '1.0.0',
  kind: 'equipment',
  domain: PH,
  order: 34,
  desc: '声学 4 件：音叉（拍频）、共鸣管（管长↔波长、反推声速）、分贝计（声强级）、波形显示（合成/拍/驻波）',
  author: '小墨实验室',
  builtin: true,
  tags: ['声学', '声波', '器材'],
  setup(ctx) { ctx.scope('equipment', () => DEFS.forEach(f => f())); },
};
