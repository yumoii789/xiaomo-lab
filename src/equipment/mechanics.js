const DEFS = [];
// ══════════════════════════════════════════════════════════
// 物理域 · 力学器材（8 件）
//
// 斜面 / 弹簧振子 / 单摆 / 小车 / 自由落体管 / 杠杆 / 滑轮组 / 摩擦块
//
// 这一组器材和电学、化学共用同一套 Entity 与同一个 World：
//   · step(dt, world) 里做真计算，render() 只画
//   · 定步长 1/120 s 由 world.step 给出，**不自己起 rAF / setInterval**
//   · 每件器材都能调参（fields），改参数即重新开始一次测量
//
// 三条刻意的设计约定：
//
// ① 尺度：画布用像素，物理用国际单位。本文件约定 **100 px = 1 m**（PXM）。
//    凡是「距离/长度」类参数都用米（含画布尺寸与物理长度解耦的 len / H 两个字段），
//    这样滑块上写 1.2 m 就是 1.2 m，不会随器材在图上的大小而变。
//
// ② 积分器：step1() 用 Heun（预估—校正）+ 梯形位置。
//    常加速度下它**精确**复现 h = ½at²、v = at（半隐式欧拉会偏 dt/t，
//    在 0.5 s 处就有 1.7% 误差，那是积分器误差不是物理误差）。
//    加速度依赖速度时（空气阻力、动摩擦）保持二阶精度。
//    弹簧与单摆用速度 Verlet（同样是辛积分器，但真实能量只在 O((ωΔt)²) 的窄带里
//    起伏、不单向漂走；半隐式欧拉的起伏是 O(ωΔt)，在 1/120 s 下会到 4%）。
//
// ③ 跨域耦合（力学 → 化学）：摩擦块压在「电子天平」秤盘上时，天平会读出它的质量。
//    **称量归耦合总线单一所有**：判定「谁在盘上、有多重」是
//    src/coupling/bridge.js 的秤盘扫描的职责，本文件只如实报数 ——
//    摩擦块把质量暴露成 props.mass（单位 g，与 vessel.totalMass() 同单位，
//    这才是物理量 N 的换算前提：重量 = m·g 里的 m 必须是 kg）。
//    这里**不再复写秤盘几何**：收归之前力学侧有一份 balanceScan() 自己算盘面位置，
//    两处几何迟早漂移（task-20 已删）；现在只读总线公布的称量对象来点亮「已上秤」。
//    非容器实体只认 props.mass + props.tare，且只有 m > 0 才会被点名、才计入示数。
//    为什么不能给器材伪造一个 vessel：ui/data.js:53 会调 e.vessel.pH()、
//    system.credit.js:30/32/37 会读 e.vessel.gas.values()/volume/pH()、
//    ui/inspector.js:188 会渲染整块容器面板 —— 它们只判 `e.vessel` 是否存在，
//    不看它是不是真容器，伪造的容器进去就会抛异常。
//
// 每件器材的解析解（Node 无头验证见 tools/equipment-mechanics.mjs）：
//   斜面      a = g(sinθ − μ_k cosθ)；tanθ ≤ μ_s 时静止
//   弹簧振子  T = 2π√(m/k)；机械能守恒
//   单摆      T = 2π√(L/g)（小角度）；周期与质量无关
//   小车      v = v₀ + at、s = v₀t + ½at²；两车弹性碰撞动量守恒
//   自由落体  h = ½gt²（真空）；终速 √(2mg/(ρCA))
//   杠杆      力矩平衡 F₁L₁ = F₂L₂（I θ'' = τ₂ − τ₁）
//   滑轮组    机械利益 = 承重绳段数 n；效率 W/(W+c) < 1 且随载荷上升
//   摩擦块    静摩擦上限 μ_sN、动摩擦 a = (F − μ_kN)/m；重量 = m·g
// ══════════════════════════════════════════════════════════

import { Entity, gfx } from '../core/entity.js';
import { define } from './registry.js';

const PH = 'physics';
const CAT = '力学';           // 器材栏分组名（新页签）
const PXM = 100;              // 100 px = 1 m
const G0 = 9.8;               // 默认重力加速度 N/kg（月球 1.62，每件器材都能单独调）
const RHO_AIR = 1.2;          // 空气密度 kg/m³（自由落体管用）

const PANEL = '#242c34', EDGE = '#39434d', TXT = '#e6edf3', DIM = '#8d96a0';
const HOT = '#ffd166', OK = '#4ade80', COOL = '#7fe8d8', WARN = '#ff7a5c', RAIL = '#5a6672';

/** 底板（与电学器材同一套观感） */
function plate(g, e, r = 8) {
  gfx.fillRR(g, -e.w / 2, -e.h / 2, e.w, e.h, r, PANEL);
  gfx.strokeRR(g, -e.w / 2, -e.h / 2, e.w, e.h, r, EDGE, 1.4);
}
/** 不显示 -0.00 */
const n2 = (v) => (Math.abs(v) < 5e-3 ? 0 : v).toFixed(2);

// ── 定步长积分（零分配：结果写进模块级暂存） ────────────────
const _s = { a: 0, v: 0, x: 0 };
/**
 * Heun + 梯形位置一步。
 * @param {number} x 位置   @param {number} v 速度
 * @param {number} dt 步长  @param {(v:number)=>number} acc 由速度求加速度
 * 常加速度下 _s.a === a、_s.v === v + a·dt、_s.x === x + v·dt + ½a·dt²（精确）。
 */
function step1(x, v, dt, acc) {
  const a1 = acc(v);
  const a2 = acc(v + a1 * dt);
  _s.a = 0.5 * (a1 + a2);
  _s.v = v + _s.a * dt;
  _s.x = x + 0.5 * (v + _s.v) * dt;
  return _s;
}

// ─────────────────────────────────────────────────────────
// 1. 斜面
// ─────────────────────────────────────────────────────────
class Incline extends Entity {
  /** 斜面物理长度（m）：与画布尺寸解耦，画布只做等比映射 */
  get len() { return Math.max(0.2, this.props.len); }
  reset() {
    const st = this.state;
    st.t = 0; st.v = 0; st.s = 0; st.a = 0; st.f = 0;
    st.sliding = false; st.done = false;
  }
  onAdd() { this.reset(); }
  onProp() { this.reset(); }
  /**
   * 沿斜面：下滑分量 mg·sinθ，正压力 N = mg·cosθ。
   * tanθ ≤ μ_s 时静摩擦足够，滑块纹丝不动（临界角）；
   * 滑动后 a = g(sinθ − μ_k cosθ)。
   */
  step(dt) {
    const st = this.state, p = this.props;
    const th = p.angle * Math.PI / 180;
    const m = p.m / 1000;
    const N = m * p.g * Math.cos(th);
    const drive = m * p.g * Math.sin(th);

    if (!st.sliding) {
      if (drive <= p.muS * N + 1e-12) {      // 静摩擦兜得住
        st.a = 0; st.v = 0; st.f = drive; st.t = 0;
        return;
      }
      st.sliding = true;
    }
    const fk = p.muK * N;
    const a = (drive - fk) / m;
    if (a <= 0) {                            // 动摩擦也够（μ_k ≥ tanθ）：停下后回到静摩擦判定
      st.a = 0; st.v = 0; st.f = fk; st.sliding = false;
      return;
    }
    const r = step1(st.s, st.v, dt, () => a);
    st.a = r.a; st.v = r.v; st.s = r.x; st.f = fk; st.t += dt;
    if (st.s >= this.len) { st.s = this.len; st.v = 0; st.a = 0; st.done = true; }
  }
  render(g) {
    const p = this.props, st = this.state;
    const th = p.angle * Math.PI / 180;
    const x0 = -this.w / 2 + 8, y0 = -this.h / 2 + 12;
    const Lp = this.w - 20;                                  // 画布上的斜面长
    plate(g, this, 8);
    g.beginPath();
    g.moveTo(x0, y0);
    g.lineTo(x0 + Math.cos(th) * Lp, y0 + Math.sin(th) * Lp);
    g.lineTo(x0, y0 + Math.sin(th) * Lp);
    g.closePath();
    g.fillStyle = 'rgba(90,102,114,.3)'; g.fill();
    g.strokeStyle = RAIL; g.lineWidth = 1.6; g.stroke();
    // 滑块位置：按 s/len 等比映射到画布斜面
    const f = Math.min(1, st.s / this.len);
    g.save();
    g.translate(x0 + Math.cos(th) * Lp * f, y0 + Math.sin(th) * Lp * f);
    g.rotate(th);
    gfx.fillRR(g, -11, -13, 22, 15, 3, st.sliding ? HOT : COOL);
    g.restore();
    gfx.text(g, 'θ ' + p.angle + '°  μs ' + p.muS, 0, -this.h / 2 + 9, { color: DIM, size: 10 });
    gfx.text(g, st.sliding ? 'a ' + n2(st.a) + ' m/s²   v ' + n2(st.v) + ' m/s' : '静止：tanθ ≤ μs',
      0, this.h / 2 - 10, { color: st.sliding ? HOT : OK, size: 10 });
  }
}
const inclinetrackDef = {
  type: 'inclinetrack', name: '斜面', domain: PH, cat: CAT, icon: '📐',
  desc: '可调倾角与摩擦的斜面，滑块按 a = g(sinθ − μcosθ) 下滑；tanθ ≤ μs 时静止',
  w: 196, h: 116,
  ports: [],
  defaults: { angle: 30, muS: 0.35, muK: 0.25, m: 500, len: 1.2, g: G0 },
  state: { t: 0, v: 0, s: 0, a: 0, f: 0, sliding: false, done: false },
  tags: ['力学', '斜面', '摩擦', '牛顿第二定律'],
  fields: [
    { k: 'angle', label: '倾角', type: 'range', min: 5, max: 60, step: 1, unit: '°' },
    { k: 'muS', label: '静摩擦系数', type: 'range', min: 0, max: 1, step: 0.01 },
    { k: 'muK', label: '动摩擦系数', type: 'range', min: 0, max: 1, step: 0.01 },
    { k: 'm', label: '滑块质量', type: 'range', min: 50, max: 2000, step: 10, unit: 'g' },
    { k: 'len', label: '斜面长度', type: 'range', min: 0.4, max: 3, step: 0.1, unit: 'm' },
    { k: 'g', label: '重力加速度', type: 'range', min: 1.6, max: 20, step: 0.1, unit: 'N/kg' },
  ],
  create: (x, y) => new Incline(inclinetrackDef, x, y),
};
DEFS.push(() => define(inclinetrackDef));

// ─────────────────────────────────────────────────────────
// 2. 弹簧振子
// ─────────────────────────────────────────────────────────
class SpringBob extends Entity {
  get m() { return Math.max(0.001, this.props.m / 1000); }
  /** 理论周期 2π√(m/k) */
  get Tth() { return 2 * Math.PI * Math.sqrt(this.m / Math.max(0.01, this.props.k)); }
  reset() {
    const st = this.state, p = this.props;
    st.t = 0; st.x = p.A / 100; st.v = 0;
    st.T = null; st.tPrev = null; st.peak = st.x;
    st.E0 = 0.5 * p.k * st.x * st.x; st.drift = 0; st.E = st.E0;
  }
  onAdd() { this.reset(); }
  onProp() { this.reset(); }
  /**
   * m x'' = −k x − c x'。
   * 用半隐式欧拉（辛积分器）：能量在一个窄带内来回，不会单向漂走。
   * 周期用「正 → 负」同向过零点测量，避免半周期混进来。
   */
  step(dt) {
    const st = this.state, p = this.props;
    const prev = st.x;
    const m = this.m;
    const a1 = (-p.k * st.x - p.damp * st.v) / m;
    const xNew = st.x + st.v * dt + 0.5 * a1 * dt * dt;      // 速度 Verlet：先漂移
    const a2 = (-p.k * xNew - p.damp * st.v) / m;            // 阻尼项取旧速度（标准写法）
    st.a = 0.5 * (a1 + a2);
    st.v += st.a * dt;
    st.x = xNew;
    st.t += dt;
    const E = 0.5 * this.m * st.v * st.v + 0.5 * p.k * st.x * st.x;
    st.E = E;
    if (st.E0 > 1e-12) st.drift = (E - st.E0) / st.E0;
    if (prev > 0 && st.x <= 0) {
      if (st.tPrev !== null) st.T = st.t - st.tPrev;
      st.tPrev = st.t;
    }
    st.peak = Math.max(st.peak, Math.abs(st.x));
  }
  render(g) {
    const p = this.props, st = this.state;
    plate(g, this, 8);
    const top = -this.h / 2 + 12;
    const rest = this.h * 0.3;
    const ext = Math.max(-rest * 0.9, Math.min(rest * 1.5, (st.x || 0) * PXM));
    const bobY = top + rest + ext;
    g.strokeStyle = '#8d96a0'; g.lineWidth = 2;
    g.beginPath();
    const turns = 9;
    for (let i = 0; i <= turns * 2; i++) {
      const y = top + (bobY - top - 10) * i / (turns * 2);
      const x = i % 2 ? 9 : -9;
      i ? g.lineTo(x, y) : g.moveTo(x, y);
    }
    g.stroke();
    gfx.fillRR(g, -14, bobY, 28, 20, 4, HOT);
    gfx.text(g, 'k ' + p.k + ' N/m  m ' + p.m + ' g', 0, -this.h / 2 + 9, { color: DIM, size: 10 });
    gfx.text(g, 'T 实测 ' + (st.T ? st.T.toFixed(3) : '—') + ' s', 0, this.h / 2 - 24, { color: OK, size: 10.5 });
    gfx.text(g, 'T 理论 ' + this.Tth.toFixed(3) + ' s  E 漂移 ' + (100 * (st.drift || 0)).toFixed(2) + '%',
      0, this.h / 2 - 11, { color: DIM, size: 9.5 });
  }
}
const springbobDef = {
  type: 'springbob', name: '弹簧振子', domain: PH, cat: CAT, icon: '〰',
  desc: '竖直弹簧振子，T = 2π√(m/k)，无阻尼时机械能守恒（面板上直接显示周期与能量漂移）',
  w: 96, h: 168,
  ports: [],
  defaults: { m: 200, k: 20, A: 8, damp: 0 },
  state: { t: 0, x: 0.08, v: 0, a: 0, T: null, tPrev: null, E: 0, E0: 0, drift: 0, peak: 0 },
  tags: ['力学', '振动', '简谐运动', '能量守恒'],
  fields: [
    { k: 'm', label: '振子质量', type: 'range', min: 20, max: 1000, step: 10, unit: 'g' },
    { k: 'k', label: '劲度系数', type: 'range', min: 5, max: 200, step: 1, unit: 'N/m' },
    { k: 'A', label: '初始振幅', type: 'range', min: 1, max: 20, step: 0.5, unit: 'cm' },
    { k: 'damp', label: '阻尼', type: 'range', min: 0, max: 0.5, step: 0.01, unit: 'N·s/m' },
  ],
  create: (x, y) => new SpringBob(springbobDef, x, y),
};
DEFS.push(() => define(springbobDef));

// ─────────────────────────────────────────────────────────
// 3. 单摆
// ─────────────────────────────────────────────────────────
class Pendulum extends Entity {
  get L() { return Math.max(0.05, this.props.L); }
  get m() { return Math.max(0.001, this.props.m / 1000); }
  /** 小角度理论周期 2π√(L/g) */
  get Tth() { return 2 * Math.PI * Math.sqrt(this.L / Math.max(0.01, this.props.g)); }
  /** 机械能（以最低点为零势能） */
  energy() {
    const st = this.state, p = this.props, m = this.m;
    return 0.5 * m * this.L * this.L * st.w * st.w + m * p.g * this.L * (1 - Math.cos(st.th));
  }
  reset() {
    const st = this.state, p = this.props;
    st.t = 0; st.th = p.theta0 * Math.PI / 180; st.w = 0;
    st.T = null; st.tPrev = null; st.drift = 0; st.E0 = this.energy();
  }
  onAdd() { this.reset(); }
  onProp() { this.reset(); }
  /**
   * 非线性单摆 θ'' = −(g/L)·sinθ − b·θ'。
   * 保留 sinθ（而不是线性化成 θ）：大角度下周期变长是真实效应，
   * 小角度（≤5°）才收敛到 2π√(L/g)。质量不出现在方程里，所以周期与质量无关。
   */
  step(dt) {
    const st = this.state, p = this.props;
    const prev = st.th;
    const a1 = -(p.g / this.L) * Math.sin(st.th) - p.damp * st.w;
    const thNew = st.th + st.w * dt + 0.5 * a1 * dt * dt;    // 速度 Verlet：辛积分器
    const a2 = -(p.g / this.L) * Math.sin(thNew) - p.damp * st.w;
    st.a = 0.5 * (a1 + a2);
    st.w += st.a * dt;
    st.th = thNew;
    st.t += dt;
    if (st.E0 > 1e-12) st.drift = (this.energy() - st.E0) / st.E0;
    if (prev > 0 && st.th <= 0) {
      if (st.tPrev !== null) st.T = st.t - st.tPrev;
      st.tPrev = st.t;
    }
  }
  render(g) {
    const p = this.props, st = this.state;
    plate(g, this, 8);
    const px = 0, py = -this.h / 2 + 14;
    const rod = this.h * 0.62;
    const bx = px + Math.sin(st.th) * rod, by = py + Math.cos(st.th) * rod;
    gfx.fillRR(g, px - 16, py - 4, 32, 8, 3, RAIL);
    g.strokeStyle = '#b9c4cd'; g.lineWidth = 2;
    g.beginPath(); g.moveTo(px, py); g.lineTo(bx, by); g.stroke();
    g.beginPath(); g.arc(bx, by, 11, 0, Math.PI * 2);
    g.fillStyle = HOT; g.fill();
    // 摆动角弧线
    g.strokeStyle = 'rgba(127,232,216,.5)'; g.lineWidth = 1.2;
    g.beginPath(); g.arc(px, py, rod * 0.34, Math.PI / 2 - 0.001, Math.PI / 2 - st.th, st.th > 0);
    g.stroke();
    gfx.text(g, 'L ' + p.L + ' m  θ₀ ' + p.theta0 + '°', 0, -this.h / 2 + 9, { color: DIM, size: 10 });
    gfx.text(g, 'T 实测 ' + (st.T ? st.T.toFixed(3) : '—') + ' s', 0, this.h / 2 - 24, { color: OK, size: 10.5 });
    gfx.text(g, 'T 理论 ' + this.Tth.toFixed(3) + ' s  θ ' + (st.th * 180 / Math.PI).toFixed(1) + '°',
      0, this.h / 2 - 11, { color: DIM, size: 9.5 });
  }
}
const pendulumDef = {
  type: 'pendulum', name: '单摆', domain: PH, cat: CAT, icon: '🕰',
  desc: '小角度 T = 2π√(L/g) 且与摆球质量无关；大角度保留 sinθ，周期会变长',
  w: 156, h: 186,
  ports: [],
  defaults: { L: 1, m: 200, theta0: 15, damp: 0, g: G0 },
  state: { t: 0, th: 0.26, w: 0, a: 0, T: null, tPrev: null, E0: 0, drift: 0 },
  tags: ['力学', '摆动', '简谐运动', '重力加速度'],
  fields: [
    { k: 'L', label: '摆长', type: 'range', min: 0.2, max: 2, step: 0.05, unit: 'm' },
    { k: 'm', label: '摆球质量', type: 'range', min: 20, max: 1000, step: 10, unit: 'g' },
    { k: 'theta0', label: '初始摆角', type: 'range', min: 1, max: 20, step: 1, unit: '°' },
    { k: 'damp', label: '阻尼', type: 'range', min: 0, max: 0.5, step: 0.01 },
    { k: 'g', label: '重力加速度', type: 'range', min: 1.6, max: 20, step: 0.1, unit: 'N/kg' },
  ],
  create: (x, y) => new Pendulum(pendulumDef, x, y),
};
DEFS.push(() => define(pendulumDef));

// ─────────────────────────────────────────────────────────
// 4. 小车（可在同一排轨道上对撞）
// ─────────────────────────────────────────────────────────
class Cart extends Entity {
  get m() { return Math.max(0.001, this.props.m / 1000); }
  reset() {
    const st = this.state;
    st.t = 0; st.v = this.props.v0; st.s = 0; st.a = 0;
    st.collided = 0; st.cool = 0; st.p = this.m * this.props.v0;
    if (this.x0 !== undefined) this.x = this.x0;
  }
  onAdd() { this.x0 = this.x; this.reset(); }
  onProp() { this.x0 = this.x; this.reset(); }
  /**
   * 匀减速（轨道摩擦）：a = −μ_k·g·sgn(v)，v = v₀ + at、s = v₀t + ½at²。
   * 与另一辆小车相遇时按一维完全弹性碰撞交换动量（动量守恒）。
   */
  step(dt, world) {
    const st = this.state, p = this.props;
    if (st.cool > 0) st.cool = Math.max(0, st.cool - dt);
    const sgn = Math.sign(st.v);
    const a = sgn === 0 ? 0 : -p.muK * p.g * sgn;
    if (sgn !== 0 && Math.abs(st.v) <= Math.abs(a) * dt) { st.v = 0; st.a = 0; }
    else {
      const r = step1(st.s, st.v, dt, (v) => (v === 0 ? 0 : -p.muK * p.g * Math.sign(v)));
      st.s = r.x; st.v = r.v; st.a = r.a;
    }
    st.t += dt;
    st.p = this.m * st.v;
    if (this.x0 !== undefined) this.x = this.x0 + st.s * PXM;
    this.collide(world);
  }
  /** 同排（|Δy| < 34 px）两车相遇 → 弹性碰撞。每对只处理一次（按 entities 次序取前者） */
  collide(world) {
    const st = this.state;
    if (st.cool > 0 || !world || !world.entities) return;
    const i = world.entities.indexOf(this);
    for (let j = i + 1; j < world.entities.length; j++) {
      const o = world.entities[j];
      if (o.type !== 'cartrack' || !o.state || o.state.cool > 0) continue;
      if (Math.abs(o.y - this.y) > 34) continue;
      const gap = (o.x - this.x);                       // 沿轨道的一维间距（px）
      const reach = (this.w + o.w) * 0.46;              // 车头相碰的判定距离
      if (Math.abs(gap) > reach) continue;
      const dir = Math.sign(gap || 1);                  // >0：对方在右
      const m1 = this.m, m2 = o.m;
      if ((o.state.v - st.v) * dir >= 0) continue;      // 正在相互远离
      const v1 = st.v, v2 = o.state.v;
      const nv1 = ((m1 - m2) * v1 + 2 * m2 * v2) / (m1 + m2);
      const nv2 = ((m2 - m1) * v2 + 2 * m1 * v1) / (m1 + m2);
      st.v = nv1; o.state.v = nv2;
      st.p = m1 * nv1; o.state.p = m2 * nv2;
      // 碰后推开一点，避免下一帧仍然重叠（按质量反比分配）
      const back = 3 / PXM;
      st.s -= dir * back * (m2 / (m1 + m2));
      o.state.s += dir * back * (m1 / (m1 + m2));
      st.cool = o.state.cool = 0.25;
      st.collided++; o.state.collided++;
    }
  }
  render(g) {
    const p = this.props, st = this.state;
    plate(g, this, 8);
    gfx.fillRR(g, -this.w / 2 + 6, this.h / 2 - 16, this.w - 12, 4, 2, RAIL);
    gfx.fillRR(g, -this.w * 0.32, -12, this.w * 0.64, 22, 4, p.muK > 0 ? COOL : HOT);
    for (const dx of [-this.w * 0.2, this.w * 0.2]) {
      g.beginPath(); g.arc(dx, 11, 5.5, 0, Math.PI * 2);
      g.fillStyle = '#b9c4cd'; g.fill();
    }
    gfx.text(g, 'm ' + p.m + ' g  μk ' + p.muK, 0, -this.h / 2 + 9, { color: DIM, size: 10 });
    gfx.text(g, 'v ' + n2(st.v) + ' m/s   a ' + n2(st.a) + ' m/s²', 0, this.h / 2 - 2,
      { color: Math.abs(st.v) > 0.01 ? HOT : DIM, size: 10 });
    gfx.text(g, 's ' + n2(st.s) + ' m   p ' + n2(st.p) + ' kg·m/s', 0, this.h / 2 + 12, { color: DIM, size: 9.5 });
  }
}
const cartrackDef = {
  type: 'cartrack', name: '小车', domain: PH, cat: CAT, icon: '🛒',
  desc: '轨道小车：v = v₀ + at、s = v₀t + ½at²；同一排放两辆相撞可验证动量守恒',
  w: 118, h: 68,
  ports: [],
  defaults: { m: 500, v0: 1.5, muK: 0.2, g: G0 },
  state: { t: 0, v: 0, s: 0, a: 0, p: 0, collided: 0, cool: 0 },
  tags: ['力学', '运动学', '碰撞', '动量守恒'],
  fields: [
    { k: 'm', label: '小车质量', type: 'range', min: 50, max: 2000, step: 10, unit: 'g' },
    { k: 'v0', label: '初速度', type: 'range', min: -3, max: 3, step: 0.1, unit: 'm/s' },
    { k: 'muK', label: '轨道摩擦', type: 'range', min: 0, max: 0.5, step: 0.01 },
    { k: 'g', label: '重力加速度', type: 'range', min: 1.6, max: 20, step: 0.1, unit: 'N/kg' },
  ],
  create: (x, y) => new Cart(cartrackDef, x, y),
};
DEFS.push(() => define(cartrackDef));

// ─────────────────────────────────────────────────────────
// 5. 自由落体管
// ─────────────────────────────────────────────────────────
class FreeFall extends Entity {
  get m() { return Math.max(0.0005, this.props.m / 1000); }
  /** 终速：mg = ½ρCAv² → v_t = √(2mg/(ρCA)) */
  get vt() {
    const p = this.props;
    const k = RHO_AIR * p.C * p.A;                 // 阻力 ½ρCAv²，平衡时 mg = ½ρCA·v²
    return k > 1e-9 ? Math.sqrt(2 * this.m * p.g / k) : Infinity;
  }
  reset() {
    const st = this.state;
    st.t = 0; st.h = 0; st.v = 0; st.a = this.props.g; st.maxv = 0;
    st.done = false; st.hold = 0;
  }
  onAdd() { this.reset(); }
  onProp() { this.reset(); }
  /**
   * 真空：a = g，h = ½gt²（step1 对常加速度是精确的）。
   * 有空气：a = g − ½ρCAv²/m，速度单调趋向终速 v_t，且永远不超过它。
   * 落到底后停 1 s 自动复位，方便反复演示。
   */
  step(dt) {
    const st = this.state, p = this.props;
    if (st.done) {
      st.hold += dt;
      if (st.hold > 1) this.reset();
      return;
    }
    const acc = (v) => {
      if (p.vacuum) return p.g;
      return p.g - (0.5 * RHO_AIR * p.C * p.A * v * v) / this.m;
    };
    const r = step1(st.h, st.v, dt, acc);
    st.a = r.a;
    st.v = Math.max(0, r.v);
    st.h = r.x;
    st.t += dt;
    st.maxv = Math.max(st.maxv, st.v);
    if (st.h >= p.H) { st.h = p.H; st.v = 0; st.a = 0; st.done = true; }
  }
  render(g) {
    const p = this.props, st = this.state;
    plate(g, this, 10);
    const top = -this.h / 2 + 16, bot = this.h / 2 - 16;
    gfx.strokeRR(g, -13, top - 4, 26, bot - top + 8, 6, p.vacuum ? COOL : WARN, 1.6);
    const f = p.H > 0 ? Math.min(1, st.h / p.H) : 0;
    const by = top + (bot - top) * f;
    g.beginPath(); g.arc(0, by, 7.5, 0, Math.PI * 2);
    g.fillStyle = st.done ? DIM : HOT; g.fill();
    for (let i = 1; i < 4; i++) {                       // 刻度
      const y = top + (bot - top) * i / 4;
      gfx.fillRR(g, 14, y - 1, 8, 2, 1, RAIL);
    }
    gfx.text(g, p.vacuum ? '真空' : '有空气', 0, -this.h / 2 + 9, { color: p.vacuum ? COOL : WARN, size: 10 });
    gfx.text(g, 'v ' + n2(st.v) + ' m/s', 0, this.h / 2 - 22, { color: HOT, size: 10.5 });
    gfx.text(g, 'h ' + n2(st.h) + ' / ' + p.H + ' m   t ' + n2(st.t) + ' s', 0, this.h / 2 - 9,
      { color: DIM, size: 9.5 });
    gfx.text(g, 'v_t ' + (this.vt === Infinity ? '—' : n2(this.vt)) + ' m/s', 0, this.h / 2 + 5, { color: DIM, size: 9.5 });
  }
}
const freefallDef = {
  type: 'freefall', name: '自由落体管', domain: PH, cat: CAT, icon: '🪶',
  desc: '真空管内 h = ½gt²；打开空气阻力后速度趋向终速 √(2mg/(ρCA))',
  w: 84, h: 186,
  ports: [],
  defaults: { m: 50, H: 2, vacuum: true, C: 0.47, A: 0.01, g: G0 },
  state: { t: 0, h: 0, v: 0, a: 0, maxv: 0, done: false, hold: 0 },
  tags: ['力学', '自由落体', '空气阻力', '终速'],
  fields: [
    { k: 'm', label: '落体质量', type: 'range', min: 1, max: 500, step: 1, unit: 'g' },
    { k: 'H', label: '管长（落高）', type: 'range', min: 0.5, max: 8, step: 0.5, unit: 'm' },
    { k: 'vacuum', label: '真空', type: 'checkbox', text: '抽成真空' },
    { k: 'C', label: '阻力系数 C', type: 'range', min: 0.1, max: 1.5, step: 0.01 },
    { k: 'A', label: '迎风面积', type: 'range', min: 0.005, max: 0.1, step: 0.005, unit: 'm²' },
    { k: 'g', label: '重力加速度', type: 'range', min: 1.6, max: 20, step: 0.1, unit: 'N/kg' },
  ],
  create: (x, y) => new FreeFall(freefallDef, x, y),
};
DEFS.push(() => define(freefallDef));

// ─────────────────────────────────────────────────────────
// 6. 杠杆
// ─────────────────────────────────────────────────────────
class Lever extends Entity {
  /** 两侧力矩与转动惯量 I = Σ m L² */
  calc() {
    const p = this.props;
    const t1 = p.m1 / 1000 * p.g * p.L1;
    const t2 = p.m2 / 1000 * p.g * p.L2;
    const I = p.m1 / 1000 * p.L1 * p.L1 + p.m2 / 1000 * p.L2 * p.L2;
    return { t1, t2, I: Math.max(1e-6, I), net: t2 - t1 };
  }
  reset() {
    const st = this.state;
    st.t = 0; st.theta = 0; st.w = 0; st.alpha = 0; st.stopped = false;
    const c = this.calc();
    st.tau1 = c.t1; st.tau2 = c.t2; st.net = c.net; st.I = c.I;
  }
  onAdd() { this.reset(); }
  onProp() { this.reset(); }
  /**
   * 刚体转动：I·θ'' = (τ₂ − τ₁) − c·θ'。
   * 两侧力矩相等 → α = 0，梁保持水平（这才是「力矩平衡」的可观测量）。
   * 不平衡时按真实角加速度转动，撞到限位就停住。
   */
  step(dt) {
    const st = this.state, p = this.props;
    const c = this.calc();
    st.tau1 = c.t1; st.tau2 = c.t2; st.net = c.net; st.I = c.I;
    if (st.stopped) { st.alpha = 0; st.w = 0; st.t += dt; return; }
    st.alpha = (c.net - p.damp * st.w) / c.I;
    st.w += st.alpha * dt;
    st.theta += st.w * dt;
    const lim = 0.42;
    if (Math.abs(st.theta) > lim) { st.theta = Math.sign(st.theta) * lim; st.w = 0; st.stopped = true; }
    st.t += dt;
  }
  render(g) {
    const p = this.props, st = this.state;
    plate(g, this, 8);
    const armPx = (L) => Math.min(this.w * 0.44, L / 0.5 * this.w * 0.30);
    const y0 = 0, pivot = { x: 0, y: y0 };
    g.save();
    g.translate(pivot.x, pivot.y);
    g.rotate(st.theta);
    gfx.fillRR(g, -armPx(p.L1) - 8, -4, armPx(p.L1) + armPx(p.L2) + 16, 8, 3, '#8d96a0');
    // 两侧载荷
    gfx.fillRR(g, -armPx(p.L1) - 10, 2, 20, 16 + Math.min(14, p.m1 / 40), 3, COOL);
    gfx.fillRR(g, armPx(p.L2) - 10, 2, 20, 16 + Math.min(14, p.m2 / 40), 3, HOT);
    g.restore();
    g.beginPath();                                        // 支点
    g.moveTo(0, -6); g.lineTo(-9, 14); g.lineTo(9, 14); g.closePath();
    g.fillStyle = RAIL; g.fill();
    gfx.text(g, 'τ₁ ' + n2(st.tau1) + ' N·m', -this.w * 0.26, -this.h / 2 + 10, { color: COOL, size: 10 });
    gfx.text(g, 'τ₂ ' + n2(st.tau2) + ' N·m', this.w * 0.26, -this.h / 2 + 10, { color: HOT, size: 10 });
    gfx.text(g, Math.abs(st.net) < 1e-9 ? '力矩平衡' : (st.net > 0 ? '右侧下沉' : '左侧下沉'),
      0, this.h / 2 - 22, { color: Math.abs(st.net) < 1e-6 ? OK : WARN, size: 10.5 });
    gfx.text(g, 'Δτ ' + n2(st.net) + ' N·m   α ' + n2(st.alpha) + ' rad/s²', 0, this.h / 2 - 9,
      { color: DIM, size: 9.5 });
  }
}
const leverDef = {
  type: 'lever', name: '杠杆', domain: PH, cat: CAT, icon: '🅛',
  desc: '两侧力矩 F₁L₁ 与 F₂L₂ 相等则梁不动（面板给出两侧力矩与角加速度）',
  w: 216, h: 132,
  ports: [],
  defaults: { m1: 100, L1: 0.2, m2: 50, L2: 0.4, damp: 0.4, g: G0 },
  state: { t: 0, theta: 0, w: 0, alpha: 0, tau1: 0, tau2: 0, net: 0, I: 0, stopped: false },
  tags: ['力学', '杠杆', '力矩', '转动'],
  fields: [
    { k: 'm1', label: '左盘质量', type: 'range', min: 10, max: 1000, step: 10, unit: 'g' },
    { k: 'L1', label: '左臂长', type: 'range', min: 0.05, max: 0.5, step: 0.01, unit: 'm' },
    { k: 'm2', label: '右盘质量', type: 'range', min: 10, max: 1000, step: 10, unit: 'g' },
    { k: 'L2', label: '右臂长', type: 'range', min: 0.05, max: 0.5, step: 0.01, unit: 'm' },
    { k: 'damp', label: '轴承阻尼', type: 'range', min: 0, max: 2, step: 0.05 },
    { k: 'g', label: '重力加速度', type: 'range', min: 1.6, max: 20, step: 0.1, unit: 'N/kg' },
  ],
  create: (x, y) => new Lever(leverDef, x, y),
};
DEFS.push(() => define(leverDef));

// ─────────────────────────────────────────────────────────
// 7. 滑轮组
// ─────────────────────────────────────────────────────────
class Pulley extends Entity {
  /** W = mg；理想情况 n 段绳承担载荷；绳扣/轴承的干摩擦记作与载荷无关的常量 c */
  calc() {
    const p = this.props;
    const W = p.m / 1000 * p.g;
    const n = Math.max(1, Math.round(p.n));
    return { W, n, loss: p.loss, need: (W + p.loss) / n, eta: W / (W + p.loss) };
  }
  reset() {
    const st = this.state;
    st.t = 0; st.h = 0; st.v = 0; st.a = 0; st.rope = 0; st.lifts = 0;
    const c = this.calc();
    st.W = c.W; st.n = c.n; st.need = c.need; st.eta = c.eta; st.MA = c.n;
  }
  onAdd() { this.reset(); }
  onProp() { this.reset(); }
  /**
   * 力平衡：n·F − W − c = M·a；机械利益 MA = 承重绳段数 n
   * （等效地：载荷升高 h，绳端要被拉走 n·h —— 面板上的 rope/h 就是这个比值）。
   * 准静态提拉所需 F = (W + c)/n，于是 η = W·h/(F·n·h) = W/(W + c) < 1，且随载荷上升。
   */
  step(dt) {
    const st = this.state, p = this.props;
    const c = this.calc();
    st.W = c.W; st.n = c.n; st.need = c.need; st.eta = c.eta; st.MA = c.n;
    const M = Math.max(0.001, p.m / 1000);
    if (Math.abs(st.v) < 1e-6 && c.n * p.F <= c.W + c.loss) { st.a = 0; st.v = 0; return; }
    const loss = st.v >= 0 ? c.loss : -c.loss;             // 干摩擦永远反抗运动
    const r = step1(st.h, st.v, dt, () => (c.n * p.F - c.W - loss) / M);
    const dh = r.x - st.h;
    st.a = r.a; st.v = r.v; st.h = Math.max(0, r.x);
    st.rope += Math.abs(dh) * c.n;                         // 绳端位移 = n × 载荷位移
    st.t += dt;
    if (st.h > 0.001 && Math.abs(dh) > 1e-9) st.lifts++;
  }
  render(g) {
    const p = this.props, st = this.state;
    plate(g, this, 8);
    const n = Math.max(1, Math.round(p.n));
    const topY = -this.h / 2 + 34;
    const loadY = topY + 26 + Math.min(this.h * 0.34, (st.h || 0) * PXM);
    // 定滑轮 + 承载绳段
    g.beginPath(); g.arc(0, topY, 12, 0, Math.PI * 2);
    g.strokeStyle = '#b9c4cd'; g.lineWidth = 2.4; g.stroke();
    g.strokeStyle = '#8d96a0'; g.lineWidth = 1.2;
    for (let i = 0; i < n; i++) {
      const x = -8 + i * (16 / Math.max(1, n - 1 || 1));
      g.beginPath(); g.moveTo(n === 1 ? 0 : x, topY - 12); g.lineTo(n === 1 ? 0 : x, loadY - 12); g.stroke();
    }
    gfx.fillRR(g, -18, loadY - 12, 36, 22, 4, HOT);
    g.strokeStyle = COOL; g.lineWidth = 2.4;                 // 拉力箭头
    g.beginPath(); g.moveTo(0, topY + 16); g.lineTo(0, topY + 16 + Math.min(16, p.F * 3)); g.stroke();
    gfx.text(g, 'n ' + n + ' 段绳   F 需 ' + n2(st.need) + ' N', 0, -this.h / 2 + 9, { color: DIM, size: 10 });
    gfx.text(g, 'MA ' + st.MA + '   η ' + (st.eta * 100).toFixed(1) + '%', 0, this.h / 2 - 22,
      { color: st.eta < 1 ? OK : DIM, size: 10.5 });
    gfx.text(g, '绳 ' + n2(st.rope) + ' m  载荷 ' + n2(st.h) + ' m  (比值 ' +
      (st.h > 0.001 ? (st.rope / st.h).toFixed(2) : '—') + ')', 0, this.h / 2 - 9, { color: DIM, size: 9.5 });
  }
}
const pulleyDef = {
  type: 'pulley', name: '滑轮组', domain: PH, cat: CAT, icon: '⛓',
  desc: 'n 段承重绳 → 机械利益 n；绳扣损失让效率 η = W/(W+c) < 1，且随载荷上升',
  w: 170, h: 190,
  ports: [],
  defaults: { m: 1000, n: 3, F: 6, loss: 5, g: G0 },
  state: { t: 0, h: 0, v: 0, a: 0, rope: 0, W: 0, n: 3, need: 0, eta: 1, MA: 3, lifts: 0 },
  tags: ['力学', '滑轮', '机械利益', '效率'],
  fields: [
    { k: 'm', label: '载荷质量', type: 'range', min: 100, max: 5000, step: 50, unit: 'g' },
    { k: 'n', label: '承重绳段数', type: 'range', min: 1, max: 4, step: 1, unit: '段' },
    { k: 'F', label: '拉力', type: 'range', min: 0, max: 100, step: 0.1, unit: 'N' },
    { k: 'loss', label: '绳扣损失', type: 'range', min: 0, max: 30, step: 0.5, unit: 'N' },
    { k: 'g', label: '重力加速度', type: 'range', min: 1.6, max: 20, step: 0.1, unit: 'N/kg' },
  ],
  create: (x, y) => new Pulley(pulleyDef, x, y),
};
DEFS.push(() => define(pulleyDef));

// ─────────────────────────────────────────────────────────
// 8. 摩擦块（同时是「力学 ↔ 化学」的砝码）
// ─────────────────────────────────────────────────────────
class FrictionBlock extends Entity {
  /** kg：内部动力学一律 SI；props.mass 是 g（与 vessel.totalMass() 同单位，这是称量契约） */
  get kg() { return Math.max(0.001, this.props.mass / 1000); }
  get N() { return this.kg * this.props.g; }
  /** 重量（N）= m·g —— 与「质量」是两回事，月球上它会变小 */
  get weight() { return this.kg * this.props.g; }
  reset() {
    const st = this.state;
    st.t = 0; st.v = 0; st.s = 0; st.a = 0; st.f = 0; st.moving = false; st.onBalance = false;
    if (this.x0 !== undefined) this.x = this.x0;
  }
  onAdd() { this.x0 = this.x; this.reset(); }
  onProp() { this.x0 = this.x; this.reset(); }
  /**
   * 静摩擦：F ≤ μ_s·N 时不动，此时摩擦力恰好等于 F（不是最大值）；
   * 动摩擦：a = (F − μ_k·N)/m。
   */
  step(dt, world) {
    const st = this.state, p = this.props;
    const N = this.N;
    st.N = N; st.fsMax = p.muS * N; st.weight = this.weight;
    if (!st.moving && p.F > p.muS * N + 1e-12) st.moving = true;
    if (!st.moving) {
      st.a = 0; st.v = 0; st.f = p.F; st.t = 0;
    } else {
      // 摩擦方向：反抗速度；静止起步时反抗「将要运动」的方向（F 指向哪边），
      // 否则 v=0 处 sign(v) 取 −1 会把动摩擦算反，起步第一步就偏掉 3%
      const dirOf = (v) => (v > 1e-9 ? 1 : v < -1e-9 ? -1 : (p.F >= 0 ? 1 : -1));
      const r = step1(st.s, st.v, dt, (v) => (p.F - p.muK * N * dirOf(v)) / this.kg);
      st.a = r.a; st.v = r.v; st.s = r.x; st.f = p.muK * N; st.t += dt;
      if (st.v <= 0) { st.v = 0; st.a = 0; st.moving = false; }
    }
    if (this.x0 !== undefined) this.x = this.x0 + st.s * PXM;
    // 秤盘几何归总线所有：这里只读总线公布出来的「称量对象」，不再自己算盘面
    st.onBalance = !!(world && world.entities) && world.entities.some(
      (b) => b.type === 'balance' && String((b.state || {}).onPlate || '').includes(this.def.name),
    );
  }
  render(g) {
    const p = this.props, st = this.state;
    plate(g, this, 8);
    const floor = this.h / 2 - 14;
    gfx.fillRR(g, -this.w / 2 + 6, floor, this.w - 12, 4, 2, RAIL);
    for (let i = 0; i < 8; i++) {                            // 摩擦纹
      const x = -this.w / 2 + 10 + i * ((this.w - 20) / 7);
      g.beginPath(); g.moveTo(x, floor + 4); g.lineTo(x + 5, floor + 9);
      g.strokeStyle = 'rgba(90,102,114,.6)'; g.lineWidth = 1.4; g.stroke();
    }
    gfx.fillRR(g, -22, -12, 44, 26, 4, st.moving ? HOT : COOL);
    // 拉力与摩擦力箭头
    if (p.F > 0) {
      g.strokeStyle = HOT; g.lineWidth = 2.4;
      g.beginPath(); g.moveTo(24, 0); g.lineTo(24 + Math.min(26, p.F * 3), 0); g.stroke();
    }
    g.strokeStyle = COOL; g.lineWidth = 2.4;
    g.beginPath(); g.moveTo(-24, 0); g.lineTo(-24 - Math.min(24, st.f * 3), 0); g.stroke();
    gfx.text(g, '质量 ' + p.mass + ' g   μs ' + p.muS + '  μk ' + p.muK, 0, -this.h / 2 + 9, { color: DIM, size: 10 });
    gfx.text(g, 'N ' + n2(st.N) + ' N   f ' + n2(st.f) + ' N   a ' + n2(st.a) + ' m/s²',
      0, this.h / 2 - 30, { color: st.moving ? HOT : OK, size: 10 });
    gfx.text(g, '重量 m·g ' + n2(this.weight) + ' N' + (st.onBalance ? '  ⚖ 已上秤' : ''),
      0, this.h / 2 - 17, { color: st.onBalance ? COOL : DIM, size: 9.5 });
  }
}
const frictionblockDef = {
  type: 'frictionblock', name: '摩擦块', domain: PH, cat: CAT, icon: '🧱',
  desc: '静摩擦上限 μsN、动摩擦 a = (F − μkN)/m；重量 m·g。放到电子天平秤盘上，天平会读出它的质量（质量 = props.mass，由耦合总线统一称量）',
  w: 128, h: 76,
  ports: [],
  defaults: { mass: 500, muS: 0.5, muK: 0.3, F: 0, g: G0 },
  state: { t: 0, v: 0, s: 0, a: 0, f: 0, N: 0, fsMax: 0, weight: 0, moving: false, onBalance: false },
  tags: ['力学', '摩擦', '牛顿第二定律', '跨域', '质量'],
  fields: [
    { k: 'mass', label: '质量', type: 'range', min: 20, max: 2000, step: 10, unit: 'g' },
    { k: 'muS', label: '静摩擦系数', type: 'range', min: 0, max: 1, step: 0.01 },
    { k: 'muK', label: '动摩擦系数', type: 'range', min: 0, max: 1, step: 0.01 },
    { k: 'F', label: '水平拉力', type: 'range', min: 0, max: 50, step: 0.1, unit: 'N' },
    { k: 'g', label: '重力加速度', type: 'range', min: 1.6, max: 20, step: 0.1, unit: 'N/kg' },
  ],
  create: (x, y) => new FrictionBlock(frictionblockDef, x, y),
};
DEFS.push(() => define(frictionblockDef));

export { Incline, SpringBob, Pendulum, Cart, FreeFall, Lever, Pulley, FrictionBlock };

// ── 插件 ──────────────────────────────────────────────────
export default {
  id: 'xiaomo.equipment.mechanics',
  name: '力学器材',
  version: '1.0.0',
  kind: 'equipment',
  domain: 'physics',
  desc: '斜面、弹簧振子、单摆、小车、自由落体管、杠杆、滑轮组、摩擦块',
  author: '小墨实验室',
  builtin: true,
  order: 60,                 // 声明用：现有四个器材插件都没写 order，且全仓库没有代码读插件级 order
  tags: ['物理', '力学'],
  setup(ctx) { ctx.scope('equipment', () => DEFS.forEach(f => f())); },
};
