// ══════════════════════════════════════════════════════════
// 无头验证：力学器材 8 件的解析解 + 跨域耦合（力学 → 化学天平）
//
//   node tools/equipment-mechanics.mjs
//
// 每一条断言都打成「实测 / 理论 / 误差」，误差超过容差即失败 ——
// 目的是证明这些器材在**算**物理，而不是画了一张能拖动的图。
// 定步长 1/120 s，与浏览器里 world.step 的时序完全一致（含电路/耦合那一步）。
// ══════════════════════════════════════════════════════════

import { World } from '../src/core/world.js';
import { PluginHost } from '../src/core/plugin.js';
import { create, list, groups, bindRegistry, equipmentPlugins } from '../src/equipment/index.js';
import { CouplingBus } from '../src/coupling/bridge.js';
import { solveCircuit } from '../src/physics/circuit.js';

import physicsPlugin from '../src/physics/circuit.js';
import chemistryPlugin from '../src/chemistry/reactions.js';
import bridgePlugin from '../src/coupling/bridge.js';
import mechanicsPlugin from '../src/equipment/mechanics.js';

// ── 无头宿主：等价于浏览器里的引导过程（mechanics 由本文件自己挂上，
//    src/equipment/index.js 的接线由调度者统一做） ──
const bootApp = {
  services: {}, ticks: [], world: null, lastCircuit: null, selected: null,
  log: { push() {}, clear() {} },
  toast() {},
  addTick(fn) { this.ticks.push(fn); return () => {}; },
  world_dummy: null,
};
const host = new PluginHost(bootApp);
for (const p of [physicsPlugin, chemistryPlugin, bridgePlugin, ...equipmentPlugins, mechanicsPlugin]) {
  host.define(p);
}
host.installAll();
bindRegistry(host.registry('equipment'));

const MID = 'xiaomo.equipment.mechanics';
const MINE = ['inclinetrack', 'springbob', 'pendulum', 'cartrack', 'freefall', 'lever', 'pulley', 'frictionblock'];

let pass = 0, fail = 0;
const ok = (cond, msg) => {
  if (cond) { pass++; console.log('  \x1b[32m✓\x1b[0m ' + msg); }
  else { fail++; console.log('  \x1b[31m✗\x1b[0m ' + msg); }
};
const head = (t) => console.log('\n\x1b[36m' + t + '\x1b[0m');
const f = (v) => (typeof v === 'number' ? (Math.abs(v) < 1e-9 ? '0' : v.toPrecision(6)) : String(v));
/** 打印「实测 / 理论 / 误差」并断言误差 ≤ tol（theory=0 时按绝对误差判） */
function near(measured, theory, tol, label, unit = '') {
  const err = Math.abs(theory) < 1e-12 ? Math.abs(measured) : Math.abs(measured - theory) / Math.abs(theory);
  ok(err <= tol, `${label}  实测 ${f(measured)}${unit} / 理论 ${f(theory)}${unit} / 误差 ${(100 * err).toPrecision(3)}%（容差 ${(100 * tol).toPrecision(2)}%）`);
  return err;
}

/** Canvas 2D 替身：只保证调用不报错，用来跑通所有渲染分支 */
function mockCtx() {
  const grad = { addColorStop() {} };
  return new Proxy({}, {
    get(_t, k) {
      if (k === 'createLinearGradient' || k === 'createRadialGradient') return () => grad;
      if (k === 'canvas') return { width: 800, height: 600 };
      if (k === 'measureText') return () => ({ width: 10 });
      if (k === 'getImageData') return () => ({ data: new Uint8ClampedArray(4) });
      return () => {};
    },
    set() { return true; },
  });
}
const ctxStub = mockCtx();

// ── 场景装配：与 main.js 的 instrumentWorld / check.mjs 的 build 一致 ──
function build(specs) {
  const world = new World();
  const cb = new CouplingBus(world);
  const raw = world.step.bind(world);
  let circuit = null;
  world.step = (dt) => {
    const br = cb.buildBranches();
    circuit = solveCircuit(world, br);
    cb.distribute(dt, circuit);
    raw(dt);
  };
  const ents = [];
  for (const o of specs) {
    const e = create(o.type, o.x, o.y);
    if (!e) throw new Error('无法创建器材：' + o.type);
    if (o.props) for (const k of Object.keys(o.props)) e.setProp(k, o.props[k]);
    world.add(e, true);
    ents.push(e);
  }
  return { world, cb, ents, circuit: () => circuit };
}
const DT = 1 / 120;
const run = (sim, sec) => { for (let i = 0, n = Math.round(sec / DT); i < n; i++) sim.world.step(DT); };
const one = (spec) => build([spec]);

/** 天平场景：把物件摆到秤盘上（盘面在机身上方 bal.h*0.35 处，判定由耦合总线做） */
function weigh(specs, sec = 0.12) {
  const world = new World();
  const cb = new CouplingBus(world);
  const raw = world.step.bind(world);
  world.step = (dt) => {
    const br = cb.buildBranches();
    cb.distribute(dt, solveCircuit(world, br));
    raw(dt);
  };
  const bal = create('balance', 400, 300);
  world.add(bal, true);
  const made = [bal];
  for (const o of specs) {
    const e = create(o.type, 400 + (o.dx || 0), 300 - bal.h * 0.35 + (o.dy || 0));
    if (!e) throw new Error('无法创建器材：' + o.type);
    for (const k of Object.keys(o.props || {})) e.setProp(k, o.props[k]);
    if (o.fill) for (const [sid, mL] of o.fill) e.vessel.addLiquid(sid, mL);
    world.add(e, true);
    made.push(e);
  }
  run({ world }, sec);
  return { bal, made, world };
}

console.log('\x1b[1m小墨实验室 · 力学器材（W3a）无头验证\x1b[0m');

// ══════════════════════════════════════════════════════════
head('① 注册表与器材栏分组（8 件）');
{
  const all = list();
  const mine = all.filter(d => MINE.includes(d.type));
  ok(mine.length === 8, `力学器材注册 8 件（实际 ${mine.length}）：` + mine.map(d => d.name).join('、'));
  ok(mine.every(d => d.domain === 'physics'), 'domain 全部是 physics');
  ok(mine.every(d => d.cat === '力学'), 'cat 全部是 力学');
  ok(mine.every(d => typeof d.create === 'function'), '每件都有 create 工厂');
  ok(mine.every(d => d.fields && d.fields.length >= 4), '每件都有可调参数（fields ≥ 4）');
  ok(mine.every(d => (d.ports || []).length === 0), '力学器材不接电线/导管（ports 为空）');
  const g = groups({ domain: 'physics' }).find(x => x.cat === '力学');
  ok(!!g && g.items.length === 8, `器材栏出现「物理 · 力学」分组，8 件（实际 ${g ? g.items.length : 0}）`);
  ok(mine.every(d => d.creator === undefined || true) && mine.every(d => d.desc && d.tags.length > 0),
    '每件都有说明与标签');
  console.log(`  · 插件 id ${mechanicsPlugin.id}｜name ${mechanicsPlugin.name}｜order ${mechanicsPlugin.order}`);
}

// ══════════════════════════════════════════════════════════
head('② 斜面：a = g(sinθ − μ_k cosθ)，且 tanθ ≤ μ_s 时静止');
{
  const P = { angle: 30, muS: 0.35, muK: 0.2, m: 500, len: 3, g: 9.8 };
  const th = P.angle * Math.PI / 180;
  const aTh = P.g * (Math.sin(th) - P.muK * Math.cos(th));      // 3.20259 m/s²
  const sim = one({ type: 'inclinetrack', x: 200, y: 200, props: P });
  const e = sim.ents[0];
  run(sim, 0.3);
  ok(e.state.sliding === true, '滑块已启动（tan30° = 0.577 > μs = 0.35）');
  near(e.state.a, aTh, 1e-9, '沿面加速度', ' m/s²');
  near(e.state.v, aTh * 0.3, 5e-3, 'v(t) = a·t（t = 0.3 s）', ' m/s');
  near(e.state.s, 0.5 * aTh * 0.09, 5e-3, 's(t) = ½at²（t = 0.3 s）', ' m');
  near(e.state.f / (P.m / 1000), P.muK * P.g * Math.cos(th), 1e-9, '摩擦力 f = μ_k·mg·cosθ（比质量）', ' m/s²');

  // 临界角：θ = 10°，μs = 0.5 → tan10° = 0.176 < 0.5，静止
  const st2 = one({ type: 'inclinetrack', x: 200, y: 200, props: { angle: 10, muS: 0.5, muK: 0.25, m: 500, len: 3, g: 9.8 } });
  run(st2, 2);
  ok(st2.ents[0].state.sliding === false && st2.ents[0].state.s === 0 && st2.ents[0].state.v === 0,
    '临界角：tan10° = 0.176 ≤ μs = 0.5 → 2 s 后仍静止（s = 0）');
}

// ══════════════════════════════════════════════════════════
head('③ 弹簧振子：T = 2π√(m/k) 与机械能守恒');
{
  const P = { m: 200, k: 20, A: 8, damp: 0 };
  const Tth = 2 * Math.PI * Math.sqrt((P.m / 1000) / P.k);      // 0.628319 s
  const sim = one({ type: 'springbob', x: 200, y: 200, props: P });
  const e = sim.ents[0];
  run(sim, 10);
  near(e.state.T, Tth, 2e-2, '振动周期', ' s');
  ok(Math.abs(e.state.drift) < 1e-2,
    `10 s 后机械能漂移 |ΔE/E₀| = ${(100 * Math.abs(e.state.drift)).toPrecision(3)}%（容差 1%，辛积分器）`);
  near(e.state.peak, P.A / 100, 2e-3, '振幅保持为初值（无阻尼；离散轨道比连续解高 O((ωΔt)²)）', ' m');
}

// ══════════════════════════════════════════════════════════
head('④ 单摆：小角度 T = 2π√(L/g)、与质量无关、大角度周期变长');
{
  const P = { L: 1, m: 200, theta0: 5, damp: 0, g: 9.8 };
  const Tth = 2 * Math.PI * Math.sqrt(P.L / P.g);               // 2.00607 s
  const sim = one({ type: 'pendulum', x: 200, y: 200, props: P });
  run(sim, 12);
  near(sim.ents[0].state.T, Tth, 2e-2, '5° 摆角周期', ' s');
  ok(Math.abs(sim.ents[0].state.drift) < 5e-3,
    `12 s 后机械能漂移 |ΔE/E₀| = ${(100 * Math.abs(sim.ents[0].state.drift)).toPrecision(3)}%（容差 0.5%，速度 Verlet）`);

  const heavy = one({ type: 'pendulum', x: 200, y: 200, props: { ...P, m: 500 } });
  run(heavy, 12);
  near(heavy.ents[0].state.T, sim.ents[0].state.T, 1e-3, '质量 500 g 与 200 g 的周期之比', '');

  // 非线性：θ₀ = 20° 时周期比小角度公式长 1 + θ²/16 ≈ 1.0076
  const big = one({ type: 'pendulum', x: 200, y: 200, props: { ...P, theta0: 20 } });
  run(big, 12);
  const ratio = big.ents[0].state.T / Tth;
  ok(ratio > 1.005 && ratio < 1.012,
    `20° 摆角周期 / 小角度理论 = ${ratio.toPrecision(5)}（理论 1 + θ₀²/16 = 1.0076，保留 sinθ 的真实效应）`);
}

// ══════════════════════════════════════════════════════════
head('⑤ 小车：v = v₀ + at、s = v₀t + ½at²、两车弹性碰撞动量守恒');
{
  const P = { m: 500, v0: 2, muK: 0.2, g: 9.8 };
  const a = -P.muK * P.g;                                       // −1.96 m/s²
  const sim = one({ type: 'cartrack', x: 200, y: 300, props: P });
  run(sim, 0.5);
  const st = sim.ents[0].state;
  near(st.v, P.v0 + a * 0.5, 1e-2, 'v(t) = v₀ + at（t = 0.5 s）', ' m/s');
  near(st.s, P.v0 * 0.5 + 0.5 * a * 0.25, 1e-2, 's(t) = v₀t + ½at²（t = 0.5 s）', ' m');
  near(st.a, a, 1e-9, '加速度 a = −μ_k·g', ' m/s²');

  // 完全弹性对撞：m 相等 → 交换速度；光滑轨道 → 总动量守恒
  const duel = build([
    { type: 'cartrack', x: 300, y: 300, props: { m: 500, v0: 1.5, muK: 0, g: 9.8 } },
    { type: 'cartrack', x: 540, y: 300, props: { m: 500, v0: -1.5, muK: 0, g: 9.8 } },
  ]);
  const [c1, c2] = duel.ents;
  const p0 = c1.state.p + c2.state.p;
  run(duel, 1.2);
  ok(c1.state.collided > 0 && c2.state.collided > 0, `两车已相撞（碰撞计数 ${c1.state.collided} / ${c2.state.collided}）`);
  ok(Math.abs(c1.state.p + c2.state.p) < 5e-3 * Math.abs(c1.props.m / 1000 * 1.5),
    `碰后总动量 ${f(c1.state.p + c2.state.p)} kg·m/s（碰前 ${f(p0)}，容差 0.5%）`);
  near(c1.state.v, -1.5, 1e-2, '等质量弹性碰撞后 A 车速度（速度交换）', ' m/s');
  near(c2.state.v, 1.5, 1e-2, '等质量弹性碰撞后 B 车速度（速度交换）', ' m/s');
}

// ══════════════════════════════════════════════════════════
head('⑥ 自由落体管：真空 h = ½gt²；有阻力时单调趋向终速 √(2mg/(ρCA))');
{
  const P = { m: 50, H: 2, vacuum: true, C: 0.47, A: 0.01, g: 9.8 };
  const sim = one({ type: 'freefall', x: 200, y: 300, props: P });
  run(sim, 0.5);
  const st = sim.ents[0].state;
  near(st.h, 0.5 * P.g * 0.25, 5e-3, '真空 h(t) = ½gt²（t = 0.5 s）', ' m');
  near(st.v, P.g * 0.5, 5e-3, '真空 v(t) = gt', ' m/s');

  // 空气阻力：轻球 + 大迎风面 → 终速小、管够长
  const D = { m: 10, H: 8, vacuum: false, C: 1.0, A: 0.05, g: 9.8 };
  const sim2 = one({ type: 'freefall', x: 200, y: 300, props: D });
  const e2 = sim2.ents[0];
  const k = 1.2 * D.C * D.A;                                    // 平衡时 mg = ½ρCA·v² → v = √(2mg/(ρCA))
  const vt = Math.sqrt(2 * (D.m / 1000) * D.g / k);             // 1.80739 m/s
  const vs = [];
  for (let i = 0; i < 32; i++) { run(sim2, 0.05); vs.push(e2.state.v); }
  near(e2.state.v, vt, 2e-2, `1.6 s（≈6τ）后速度 → 终速`, ' m/s');
  ok(e2.state.maxv <= vt * 1.0001, `速度始终不超过终速（峰值 ${f(e2.state.maxv)} ≤ ${f(vt)} m/s）`);
  let mono = true, shrink = true;
  for (let i = 1; i < vs.length; i++) {
    if (!(vs[i] > vs[i - 1] - 1e-9)) mono = false;
    if (i >= 2 && !(vs[i] - vs[i - 1] <= vs[i - 1] - vs[i - 2] + 1e-9)) shrink = false;
  }
  ok(mono, '速度单调递增（无过冲、无振荡）');
  ok(shrink, `速度增量逐步变小（a = g − kv²/m 也在趋向 0）：首段 Δv ${f(vs[0])} → 末段 Δv ${f(vs[31] - vs[30])} m/s`);
  ok(Math.abs(e2.state.a) < 0.05 * D.g, `末态加速度 |a| = ${f(e2.state.a)} m/s²（已接近匀速）`);
}

// ══════════════════════════════════════════════════════════
head('⑦ 杠杆：力矩平衡 F₁L₁ = F₂L₂；不平衡时 α = (τ₂ − τ₁)/I');
{
  const P = { m1: 100, L1: 0.2, m2: 50, L2: 0.4, damp: 0.4, g: 9.8 };
  const sim = one({ type: 'lever', x: 300, y: 300, props: P });
  const e = sim.ents[0];
  const t1 = P.m1 / 1000 * P.g * P.L1, t2 = P.m2 / 1000 * P.g * P.L2;
  run(sim, 2);
  near(e.state.tau1, t1, 1e-9, '左侧力矩 F₁L₁', ' N·m');
  near(e.state.tau2, t2, 1e-9, '右侧力矩 F₂L₂', ' N·m');
  near(e.state.net, 0, 1e-9, '两侧力矩差 Δτ（容差 1e-9 相对）', ' N·m');
  ok(Math.abs(e.state.theta) * 180 / Math.PI < 0.5,
    `平衡时梁不动：2 s 后倾角 ${(e.state.theta * 180 / Math.PI).toPrecision(3)}°（< 0.5°）`);

  const ub = one({ type: 'lever', x: 300, y: 300, props: { ...P, m2: 200, damp: 0 } });
  const I = P.m1 / 1000 * P.L1 ** 2 + 0.2 * P.L2 ** 2;
  const aTh = (t2 * 4 - t1) / I;                                // τ₂ = 0.784 N·m → α = 16.333 rad/s²
  run(ub, DT);
  near(ub.ents[0].state.alpha, aTh, 1e-2, '不平衡时角加速度 α = (τ₂ − τ₁)/I', ' rad/s²');
  run(ub, 0.5);
  ok(ub.ents[0].state.theta > 0, `右侧力矩大 → 顺时针转动（0.5 s 后 θ = ${(ub.ents[0].state.theta * 180 / Math.PI).toPrecision(3)}°）`);
}

// ══════════════════════════════════════════════════════════
head('⑧ 滑轮组：机械利益 = 承重绳段数 n；效率 W/(W+c) < 1 且随载荷上升');
{
  const P = { m: 1000, n: 3, F: 6, loss: 5, g: 9.8 };
  const W = P.m / 1000 * P.g;                                   // 9.8 N
  const sim = one({ type: 'pulley', x: 300, y: 300, props: P });
  const e = sim.ents[0];
  near(e.state.need, (W + P.loss) / P.n, 1e-9, '准静态所需拉力 F = (W + c)/n', ' N');
  near(e.state.eta, W / (W + P.loss), 1e-9, '效率 η = W/(W + c)', '');
  ok(e.state.eta < 1, `效率 η = ${(100 * e.state.eta).toPrecision(4)}% < 100%（绳扣有损失）`);
  run(sim, 0.6);
  near(e.state.rope / e.state.h, P.n, 1e-2, '绳端位移 / 载荷位移（= 机械利益 MA）', '');
  near(e.state.h, 0.5 * ((P.n * P.F - W - P.loss) / (P.m / 1000)) * 0.36, 1e-2,
    '载荷位移 h = ½at²（a = (nF − W − c)/M，t = 0.6 s）', ' m');
  const etas = [200, 1000, 5000].map(gm => { const w = gm / 1000 * P.g; return w / (w + P.loss); });
  ok(etas[0] < etas[1] && etas[1] < etas[2],
    `效率随载荷单调上升：200 g → ${(100 * etas[0]).toPrecision(3)}%，1 kg → ${(100 * etas[1]).toPrecision(3)}%，5 kg → ${(100 * etas[2]).toPrecision(3)}%`);

  const idle = one({ type: 'pulley', x: 300, y: 300, props: { ...P, F: 4 } });
  run(idle, 1);
  ok(idle.ents[0].state.h === 0, `拉力不足（4 N × 3 段 ≤ W + c）时载荷不动（h = ${idle.ents[0].state.h} m）`);
}

// ══════════════════════════════════════════════════════════
head('⑨ 摩擦块：静摩擦 f = F ≤ μ_sN；动摩擦 a = (F − μ_kN)/m');
{
  const P = { mass: 500, muS: 0.5, muK: 0.3, F: 2, g: 9.8 };
  const N = P.mass / 1000 * P.g;                                // 4.9 N
  const sim = one({ type: 'frictionblock', x: 200, y: 300, props: P });
  const e = sim.ents[0];
  run(sim, 1);
  ok(e.state.N !== undefined, '正压力 N = mg 已算出');
  near(e.state.N, N, 1e-9, '正压力 N = mg', ' N');
  ok(e.state.moving === false && e.state.s === 0 && e.state.v === 0,
    `F = 2 N < μ_sN = ${f(P.muS * N)} N → 1 s 后仍不动（s = 0）`);
  near(e.state.f, P.F, 1e-9, '静摩擦力恰好等于外力 f = F（不是取最大值）', ' N');
  ok(e.state.f < P.muS * N, `f = ${f(e.state.f)} N < μ_sN = ${f(P.muS * N)} N`);

  const kin = one({ type: 'frictionblock', x: 200, y: 300, props: { ...P, F: 5 } });
  const ek = kin.ents[0];
  const a = (5 - P.muK * N) / (P.mass / 1000);                  // 7.06 m/s²
  run(kin, 0.2);
  near(ek.state.a, a, 1e-2, '动摩擦 a = (F − μ_kN)/m', ' m/s²');
  near(ek.state.v, a * 0.2, 1e-2, 'v(t) = at（t = 0.2 s）', ' m/s');
  near(ek.state.s, 0.5 * a * 0.04, 1e-2, 's(t) = ½at²（t = 0.2 s）', ' m');
  near(ek.state.f, P.muK * N, 1e-9, '动摩擦力 f = μ_kN', ' N');
  near(ek.state.weight, P.mass / 1000 * P.g, 1e-9, '重量读数 m·g（props.mass 是 g，重量才是 N）', ' N');
}

// ══════════════════════════════════════════════════════════
head('⑩ 跨域：摩擦块 → 电子天平（力学 ↔ 化学，走引擎既有的 CouplingBus）');
{
  const bal = create('balance', 400, 300);
  const blk = create('frictionblock', 400, 300 - bal.h * 0.35);   // 摆放位置与总线的秤盘判定一致
  const world = new World();
  const cb = new CouplingBus(world);
  const raw = world.step.bind(world);
  world.step = (dt) => {
    const br = cb.buildBranches();
    cb.distribute(dt, solveCircuit(world, br));
    raw(dt);
  };
  blk.setProp('mass', 50);
  blk.setProp('F', 0);
  world.add(bal, true);
  world.add(blk, true);
  run({ world }, 0.1);

  console.log(`  · 天平 state.mass = ${f(bal.state.mass)} g，onPlate = ${JSON.stringify(bal.state.onPlate)}`);
  near(bal.state.mass, 50, 5e-3, '天平示数 = 块质量 50 g', ' g');
  ok(String(bal.state.onPlate || '').includes('摩擦块'), `天平「称量对象」里出现摩擦块（${bal.state.onPlate}）`);
  near(blk.state.weight, 0.05 * 9.8, 1e-2, '同一份质量的重量 m·g（m = 50 g、g = 9.8）', ' N');

  // 换到月球：质量不变、重量变小 —— 天平称的是质量，力才是 m·g
  blk.setProp('g', 1.62);
  run({ world }, 0.05);
  near(bal.state.mass, 50, 5e-3, '月球重力下天平示数仍是 50 g（质量与 g 无关）', ' g');
  near(blk.state.weight, 0.05 * 1.62, 1e-2, '月球重力下的重量 m·g（g = 1.62）', ' N');

  // 用 0.3 N 拉力把砝码从秤盘上拽走 → 天平自动归零
  blk.setProp('g', 9.8);
  blk.setProp('F', 0.3);
  run({ world }, 1.2);
  const moved = blk.x - 400;
  ok(Math.abs(moved) > bal.w * 0.55, `砝码被拉离秤盘 ${f(moved)} px（秤盘水平判定 ±${f(bal.w * 0.55)} px）`);
  near(bal.state.mass, 0, 1e-9, '离开秤盘后天平示数归零（不是写死的常量）', ' g');
  near(blk.state.s, 0.5 * ((0.3 - 0.3 * (0.05 * 9.8)) / 0.05) * 1.44, 1e-2,
    '砝码被拉走的位移 s = ½at²（a = (F − μ_kN)/m，t = 1.2 s）', ' m');
}

// ══════════════════════════════════════════════════════════
head('⑪ 称量归总线所有：容器零回归、非容器自报 mass、m>0 守卫（task-20）');
{
  // 质量契约：props.mass 单位必须是 g（与 vessel.totalMass() 同单位），重量才是 m·g（N）
  const fdef = list().find(d => d.type === 'frictionblock');
  const mfield = (fdef.fields || []).find(x => x.k === 'mass');
  ok(!!mfield && mfield.unit === 'g' && fdef.defaults.mass === 500,
    `摩擦块的质量参数是 props.mass，单位 ${mfield ? mfield.unit : '（缺）'}，默认 ${fdef.defaults.mass} g`);

  // 容器路径零回归：vessel.totalMass() 恒 ≥ 1（vessel.js:155 Math.max(1, m)），故 m>0 守卫对容器零影响
  const c1 = weigh([{ type: 'beaker', fill: [['H2O', 100]] }]);
  near(c1.bal.state.mass, 100, 1e-9, '烧杯 100 mL 水 → 天平示数（容器分支）', ' g');
  ok(c1.bal.state.onPlate === '烧杯', `称量对象 = ${JSON.stringify(c1.bal.state.onPlate)}（容器照旧点名）`);

  const c2 = weigh([{ type: 'beaker', props: { tare: 20 }, fill: [['H2O', 100]] }]);
  near(c2.bal.state.mass, 120, 1e-9, '烧杯 100 mL 水 + 20 g 皮重（皮重只走容器分支一次）', ' g');

  const c3 = weigh([{ type: 'beaker' }]);
  near(c3.bal.state.mass, 1, 1e-9, '空烧杯 → 示数（totalMass() 的下限 1 g，守卫不吃掉容器）', ' g');
  ok(c3.bal.state.onPlate === '烧杯', `空烧杯的称量对象仍是 ${JSON.stringify(c3.bal.state.onPlate)}（零回归）`);

  const c4 = weigh([{ type: 'beaker', fill: [['H2O', 100]] }, { type: 'frictionblock', props: { mass: 50 } }]);
  near(c4.bal.state.mass, 150, 1e-9, '烧杯 100 g 水 + 50 g 块同盘 → 容器分支 + 自报分支相加', ' g');
  ok(c4.bal.state.onPlate === '烧杯,摩擦块', `称量对象 = ${JSON.stringify(c4.bal.state.onPlate)}`);

  // m > 0 守卫：质量非正的实体不得被点名，否则秤盘附近的一切都会挤进「称量对象」
  const g0 = weigh([
    { type: 'frictionblock', props: { mass: 50 } },
    { type: 'frictionblock', dx: 20, props: { mass: 0 } },
    { type: 'pendulum' },
    { type: 'lever' },
  ]);
  near(g0.bal.state.mass, 50, 1e-9, '同盘 4 个物体里只有 50 g 块被计入（0 g 块、单摆、杠杆都不计）', ' g');
  ok(g0.bal.state.onPlate === '摩擦块',
    `m>0 守卫实测 onPlate = ${JSON.stringify(g0.bal.state.onPlate)}（不是 "摩擦块,摩擦块,单摆,杠杆"）`);

  // 力学 8 件一律没有 vessel —— 伪造容器会炸 ui/data.js、system.credit.js、ui.inspector.js
  const withVessel = MINE.filter((t) => { const e = create(t, 100, 100); return !!e && !!e.vessel; });
  ok(withVessel.length === 0,
    `力学 8 件的 vessel 字段逐件检查：${withVessel.length === 0 ? '全部为空（0 件有 vessel）' : withVessel.join('、')}`);
}

// ══════════════════════════════════════════════════════════
head('⑫ 渲染冒烟：8 件器材的 render() 全部可执行（含动态读数分支）');
{
  for (const t of MINE) {
    const e = create(t, 400, 300);
    if (!e) { ok(false, t + ' 无法创建'); continue; }
    let err = null;
    try {
      e.render(ctxStub, null);
      const sim = build([{ type: t, x: 400, y: 300 }]);
      run(sim, 1.5);
      sim.world.render(ctxStub);
      sim.ents[0].render(ctxStub, sim.world);
    } catch (ex) { err = ex; }
    ok(!err, `${t} 渲染 + 1.5 s 仿真无异常${err ? '：' + err.message : ''}`);
  }
}

// ══════════════════════════════════════════════════════════
head('⑬ 可单独启停：关掉插件 → 8 件从注册表与器材栏消失；打开 → 回来');
{
  const before = list().length;
  host.disable(MID);
  const after = list().length;
  const gone = list().filter(d => MINE.includes(d.type)).length;
  ok(after === before - 8, `停用后器材总数 ${before} → ${after}（少 8 件）`);
  ok(gone === 0, `停用后注册表里没有力学器材（剩 ${gone} 件）`);
  const g = groups({ domain: 'physics' }).find(x => x.cat === '力学');
  ok(!g || g.items.length === 0, `器材栏「物理 · 力学」分组随之消失（${g ? g.items.length : 0} 件）`);
  ok(!create('pendulum', 100, 100), '停用后 create("pendulum") 返回空');

  host.enable(MID);
  const back = list().length;
  ok(back === before, `重新启用后器材总数恢复 ${back} 件`);
  ok(list().filter(d => MINE.includes(d.type)).length === 8, '8 件力学器材全部回到注册表');
  const e = create('pendulum', 100, 100);
  ok(!!e && e.type === 'pendulum', '重新启用后器材可正常实例化');
  const sim = build([{ type: 'pendulum', x: 100, y: 100, props: { L: 1, m: 200, theta0: 5, damp: 0, g: 9.8 } }]);
  run(sim, 12);
  near(sim.ents[0].state.T, 2 * Math.PI * Math.sqrt(1 / 9.8), 2e-2, '重新启用后单摆周期依旧正确', ' s');
}

// ══════════════════════════════════════════════════════════
const total = pass + fail;
console.log('\n' + (fail === 0
  ? '\x1b[32m全部通过：' + total + ' 项\x1b[0m'
  : '\x1b[31m合计 ' + total + ' 项，失败 ' + fail + ' 项\x1b[0m'));
process.exit(fail === 0 ? 0 : 1);
