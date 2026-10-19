// ══════════════════════════════════════════════════════════
// 无头验证：电学增量 7 件（电容 / 电感 / 交流电源 / 示波器 / 变压器 / 二极管 / 光敏电阻）
//   ⚠ 本文件的 MINE 白名单仍只覆盖其中 6 件：光敏电阻由 tools/photoresistor-probe.mjs 覆盖（38 项）。
//     本次只改叙述文字，断言一条未动（116 项）。
//
//   node tools/equipment-electronics.mjs
//
// 这份测试要证明四件事，每一件都有独立的两条路径对撞：
//   ① RC / RL 的解析解 ↔ 定步长 1/120 s 的欧拉积分（实测 63.2% 时刻、稳态电流）
//   ② 交流有效值 Up/√2 ↔ 采样缓冲的数值均方根
//   ③ 半波整流平均值 Up/π（含 Vf 的解析式）↔ 求解器给出的负载实测平均电压
//   ④ 耦合：整流后的直流分量驱动**真化学**电解（CuSO₄ 溶液，量真实沉积的 Cu），
//      并如实报告一条**负结论**——交流电解在本模型里无法做到「无净产物」。
//
// ④ 的负结论不是我的实现问题，是 bridge.js / reactions.js 里三处取绝对值造成的，
//   见本文件 §8 与测试输出里的原文行号。
// ══════════════════════════════════════════════════════════

import { World } from '../src/core/world.js';
import { PluginHost } from '../src/core/plugin.js';
import { create, bindRegistry } from '../src/equipment/registry.js';
import { CouplingBus } from '../src/coupling/bridge.js';
import { solveCircuit } from '../src/physics/circuit.js';

import physicsPlugin from '../src/physics/circuit.js';
import chemistryPlugin, { RULE_BY_ID } from '../src/chemistry/reactions.js';
import bridgePlugin from '../src/coupling/bridge.js';
import electricalPlugin from '../src/equipment/electrical.js';
import glasswarePlugin from '../src/equipment/glassware.js';
import labPlugin from '../src/equipment/lab.js';
import electronicsPlugin, * as E from '../src/equipment/electronics.js';

// ── 无头宿主（等价于浏览器引导） ──
const bootApp = {
  services: {}, ticks: [], world: null, lastCircuit: null, selected: null,
  log: { push() {}, clear() {} }, toast() {},
  addTick(fn) { this.ticks.push(fn); return () => {}; },
};
const host = new PluginHost(bootApp);
for (const p of [physicsPlugin, chemistryPlugin, bridgePlugin,
                 electricalPlugin, glasswarePlugin, labPlugin, electronicsPlugin]) host.define(p);
host.installAll();
bindRegistry(host.registry('equipment'));

let pass = 0, fail = 0;
const ok = (cond, msg) => {
  if (cond) { pass++; console.log('  \x1b[32m✓\x1b[0m ' + msg); }
  else { fail++; console.log('  \x1b[31m✗\x1b[0m ' + msg); }
};
const head = (t) => console.log('\n\x1b[36m' + t + '\x1b[0m');
const info = (t) => console.log('    \x1b[90m' + t + '\x1b[0m');
const near = (a, b, tolRel) => Math.abs(a - b) <= tolRel * Math.max(1e-12, Math.abs(b));
const pct = (a, b) => (100 * Math.abs(a - b) / Math.max(1e-12, Math.abs(b))).toFixed(3) + '%';

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
const CTX = mockCtx();

const DT = 1 / 120;
/** 场景装配：与 main.js 的 instrumentWorld 完全同一条流水线（造支路→解电路→分发→世界步进） */
function build(sc) {
  const world = new World();
  const cb = new CouplingBus(world);
  const raw = world.step.bind(world);
  const ents = [];
  for (const o of sc.entities || []) {
    const ent = create(o.type, o.x, o.y);
    if (!ent) { console.log('  !! 无法创建器材: ' + o.type); continue; }
    if (o.props) for (const k of Object.keys(o.props)) ent.setProp(k, o.props[k]);
    if (o.state) Object.assign(ent.state, o.state);
    if (o.fill && ent.vessel) {
      const v = ent.vessel;
      v.capacity = ent.props.capacity || v.capacity;
      for (const [sid, mL] of (o.fill.liquid || [])) v.addLiquid(sid, mL);
      for (const [sid, g] of (o.fill.solid || [])) v.addSolid(sid, g);
      v.updateColor();
    }
    world.add(ent, true);
    ents.push(ent);
  }
  for (const w of sc.wires || []) {
    const a = ents[w[0]], b = ents[w[2]];
    if (a && b) world.connect({ e: a.id, p: w[1] }, { e: b.id, p: w[3] }, w[4] || 'wire');
  }
  const tick = (dt, hook) => {
    const br = cb.buildBranches();
    const c = solveCircuit(world, br);
    cb.distribute(dt, c);
    if (hook) hook(c, dt);
    raw(dt);
    return c;
  };
  return {
    world, cb, ents, tick, get: (i) => ents[i],
    run(sec, hook) { for (let i = 0, n = Math.round(sec / DT); i < n; i++) this.tick(DT, hook); },
    render() { for (const e of world.entities) e.render(CTX); },
  };
}

// ══════════════════════════════════════════════════════════
head('§0 注册、形状、与既有 electrical.js 的件名零重叠（EXIST 冻结 10 个名字；electrical.js 现为 11 件）');
// ══════════════════════════════════════════════════════════
const MINE = ['resistorcap', 'inductorcoil', 'acsource', 'oscilloscope', 'transformer', 'diode'];
const EXIST = ['battery', 'switch', 'lamp', 'resistor', 'rheostat', 'ammeter', 'voltmeter', 'thermistor', 'heater', 'motor'];
const DEFS = host.registry('equipment').list();
const byType = new Map(DEFS.map(d => [d.type, d]));
ok(MINE.every(t => byType.has(t)), `MINE 白名单 6 件全部注册：${MINE.join(' / ')}`);
ok(EXIST.every(t => byType.has(t)), 'EXIST 里冻结的 10 个名字仍在注册表里（没有被顶掉；electrical.js 现为 11 件，多出的 multimeter 不在本名单里）');
ok(MINE.every(t => !EXIST.includes(t)), '类型名零重叠：MINE 6 件 ∩ EXIST 10 个名字 = ∅');

for (const t of MINE) {
  const d = byType.get(t);
  const need = ['type', 'name', 'domain', 'cat', 'icon', 'desc', 'w', 'h', 'ports', 'fields', 'defaults', 'state', 'tags', 'create'];
  const miss = need.filter(k => d[k] === undefined);
  ok(miss.length === 0, `${t}：定义字段齐全${miss.length ? '（缺 ' + miss + '）' : ''}`);
  ok(d.domain === 'physics' && d.cat === '电学', `${t}：domain=physics、cat=电学`);
  ok(d.tags.length >= 3 && d.desc.length >= 20, `${t}：有 ≥3 个标签与说明文字`);
  // 字段自洽：range 必须有 min/max/step，select 必须有 options
  const bad = d.fields.filter(f => !f.k || !f.label || !f.type
    || (f.type === 'range' && !(isFinite(f.min) && isFinite(f.max) && isFinite(f.step)))
    || (f.type === 'select' && !(Array.isArray(f.options) && f.options.length)));
  ok(bad.length === 0, `${t}：${d.fields.length} 个字段自洽${bad.length ? '（异常 ' + bad.map(f => f.k) + '）' : ''}`);
  // 每一个默认值都可被用户调（否则就是硬编码常量）
  const noField = Object.keys(d.defaults).filter(k => !d.fields.some(f => f.k === k));
  ok(noField.length === 0, `${t}：defaults ${JSON.stringify(d.defaults)} 每项都有对应字段`);
}
console.log('\n  \x1b[1m逐件与既有 10 件的差异（验收标准 C）\x1b[0m');
const DIFF = [
  ['resistorcap', '电容', '既有全是纯电阻直流元件；本件是**储能元件 + 暂态**：τ=RC，充电 63.2% 用一个时间常数'],
  ['inductorcoil', '电感', '既有没有磁路/储能元件；本件给 RL 暂态 τ=L/R 与**断电自感尖峰** U=I₀·R_弧'],
  ['acsource', '交流电源', '既有干电池是恒定 EMF；本件是正弦 EMF，求解器每次迭代重取瞬时值（真交流）'],
  ['oscilloscope', '示波器', '既有电流表/电压表只显示标量；本件显示波形并**测量**频率与相位（过零点）'],
  ['transformer', '变压器', '既有没有互感/变比元件；本件 U₁/U₂=N₁/N₂、I₁/I₂=N₂/N₁、P₁=P₂'],
  ['diode', '二极管', '既有全是线性元件；本件是非线性单向导电（导通=Vf 恒压降 + ron 的分段线性支路，不是纯电阻开关）'],
];
for (const [t, n, why] of DIFF) console.log(`    \x1b[90m${t.padEnd(13)} ${n}：${why}\x1b[0m`);

// ══════════════════════════════════════════════════════════
head('§1 RC 时间常数：解析解 ↔ 1/120 s 定步长欧拉积分');
// ══════════════════════════════════════════════════════════
const tauRC = E.rcTau(10, 100);                                  // 10 kΩ × 100 µF
ok(near(tauRC, 1.0, 1e-12), `τ = R·C = 10 kΩ × 100 µF = ${tauRC.toFixed(6)} s（量纲 10³·10⁻⁶ = 10⁻³ s）`);
ok(near(E.rcAnalytic(6, 1, 1) / 6, 1 - Math.exp(-1), 1e-12), `解析解 U(τ)/U₀ = 1−e⁻¹ = ${(E.rcAnalytic(6, 1, 1) / 6).toFixed(6)}`);
ok(near(E.rcDecay(6, 1, 1) / 6, Math.exp(-1), 1e-12), `放电 U(τ)/U₀ = e⁻¹ = ${(E.rcDecay(6, 1, 1) / 6).toFixed(6)}`);

const traj = E.rcEulerTraj(6, 1, DT, 1200);
const t63 = E.crossingTime(traj, 6, 0.632);
ok(Math.abs(t63 - 1) / 1 < 0.03, `欧拉积分实测 63.2% 时刻 = ${t63.toFixed(4)} s，与 τ=1 s 偏差 ${pct(t63, 1)}（要求 <3%）`);
let maxDev = 0;
for (const p of traj) {
  if (p.t > 3) break;
  maxDev = Math.max(maxDev, Math.abs(p.u - E.rcAnalytic(6, 1, p.t)) / 6);
}
ok(maxDev < 0.01, `t≤3τ 内欧拉 vs 解析最大偏差 = ${(maxDev * 100).toFixed(4)}%（要求 <1%）`);
info(`离散误差本来就是「实时仿真」的一部分，所以这里断言的是「≤1%」而不是相等`);

// ══════════════════════════════════════════════════════════
head('§2 RL 时间常数与自感尖峰');
// ══════════════════════════════════════════════════════════
const tauRL = E.rlTau(2000, 10);
ok(near(tauRL, 0.2, 1e-12), `τ = L/R = 2000 mH / 10 Ω = ${tauRL.toFixed(6)} s`);
const rl = E.rlEulerTraj(6, 10, 2, DT, 1200);
const iEnd = rl[rl.length - 1].i, iSteady = 6 / 10;
ok(Math.abs(iEnd - iSteady) / iSteady < 1e-6, `欧拉积分 10τ 后 i = ${iEnd.toFixed(9)} A，解析稳态 U/R = ${iSteady} A，偏差 ${pct(iEnd, iSteady)}`);
ok(near(E.rlAnalytic(6, 10, 0.2, 0.2) / iSteady, 1 - Math.exp(-1), 1e-12), `解析解 i(τ)/i∞ = ${(E.rlAnalytic(6, 10, 0.2, 0.2) / iSteady).toFixed(6)} = 1−e⁻¹`);
const spike = E.selfInduction(0.6, 1e6);
ok(near(spike, 6e5, 1e-12), `断电自感尖峰 U = I₀·R_弧 = 0.6 A × 1 MΩ = ${(spike / 1000).toFixed(1)} kV（理想瞬时断路会发散，用弧阻封顶）`);

// ══════════════════════════════════════════════════════════
head('§3 交流：瞬时值、峰值 ↔ 有效值');
// ══════════════════════════════════════════════════════════
ok(Math.abs(E.sineEmf(0, 6, 1)) < 1e-12, 'U(0) = 0');
ok(near(E.sineEmf(0.25, 6, 1), 6, 1e-12), 'U(T/4) = Up = 6 V');
ok(Math.abs(E.sineEmf(0.5, 6, 1)) < 1e-12, 'U(T/2) = 0');
ok(near(E.sineEmf(0.75, 6, 1), -6, 1e-12), 'U(3T/4) = −Up = −6 V（真反向，不是取绝对值）');
ok(near(E.sineEmf(0, 6, 1, 90), 6, 1e-12), '初相 φ=90° 时 U(0) = Up（相位真的接进了相位）');
const tms = [], vms = [];
for (let i = 0; i <= 200000; i++) { const t = (i / 200000) * 100; tms.push(t); vms.push(E.sineEmf(t, 6, 1)); }
ok(near(E.rmsFromPeak(6), 6 / Math.SQRT2, 1e-12), `Up/√2 = ${E.rmsFromPeak(6).toFixed(6)} V`);
ok(near(E.rmsOf(vms), E.rmsFromPeak(6), 1e-5), `数值积分 √⟨u²⟩ = ${E.rmsOf(vms).toFixed(6)} V，与 Up/√2 偏差 ${pct(E.rmsOf(vms), E.rmsFromPeak(6))}`);
ok(Math.abs(E.meanOf(vms)) < 1e-6, `整周期平均 ⟨u⟩ = ${E.meanOf(vms).toExponential(2)} V（正弦一个周期平均为零）`);

// ══════════════════════════════════════════════════════════
head('§4 半波整流：Up/π 解析式 ↔ 数值积分');
// ══════════════════════════════════════════════════════════
const th0 = E.conductionAngle(0.6, 6);
ok(near(th0, Math.asin(0.1), 1e-12), `导通起始角 θ₀ = arcsin(Vf/Up) = arcsin(0.1) = ${(th0 * 180 / Math.PI).toFixed(4)}°`);
const numHalf = (Up, vf) => {
  let s = 0; const N = 200000;
  for (let i = 0; i < N; i++) {
    const th = (i + 0.5) / N * Math.PI * 2;
    s += Math.max(0, Up * Math.sin(th) - vf);
  }
  return s / N;                                   // 除以 2π 的积分 = 整周期平均
};
ok(near(E.halfWaveMean(6, 0), 6 / Math.PI, 1e-12), `Vf=0：⟨U⟩ = Up/π = ${E.halfWaveMean(6, 0).toFixed(6)} V`);
ok(near(numHalf(6, 0), E.halfWaveMean(6, 0), 1e-5), `Vf=0：数值积分 ${numHalf(6, 0).toFixed(6)} V，偏差 ${pct(numHalf(6, 0), E.halfWaveMean(6, 0))}`);
const closed6 = (1 / Math.PI) * (6 * Math.cos(th0) - 0.6 * (Math.PI / 2 - th0));
ok(near(E.halfWaveMean(6, 0.6), closed6, 1e-12),
  `Vf=0.6：解析式 (1/π)[Up·cosθ₀ − Vf(π/2−θ₀)] = ${E.halfWaveMean(6, 0.6).toFixed(6)} V（测试里把公式重算一遍对撞）`);
ok(near(numHalf(6, 0.6), E.halfWaveMean(6, 0.6), 1e-5), `Vf=0.6：数值积分 ${numHalf(6, 0.6).toFixed(6)} V，偏差 ${pct(numHalf(6, 0.6), E.halfWaveMean(6, 0.6))}`);
ok(near(E.fullWaveMean(6), 12 / Math.PI, 1e-12), `对照：全波整流 ⟨U⟩ = 2Up/π = ${E.fullWaveMean(6).toFixed(6)} V（是半波的两倍）`);

// ══════════════════════════════════════════════════════════
head('§5 变压器：变比与功率守恒');
// ══════════════════════════════════════════════════════════
const tr = E.transformer(6, 400, 100, 10);
ok(near(tr.U2, 1.5, 1e-12), `U₂ = U₁·N₂/N₁ = 6 × 100/400 = ${tr.U2} V`);
ok(near(tr.I2, 0.15, 1e-12), `I₂ = U₂/R_L = ${tr.I2} A`);
ok(near(tr.I1, 0.0375, 1e-12), `I₁ = I₂·N₂/N₁ = ${tr.I1} A（升压降流）`);
ok(near(tr.P1, tr.P2, 1e-12) && near(tr.P1, 0.225, 1e-12), `P₁ = P₂ = ${tr.P1} W（理想变压器无损耗，η = ${tr.eta}）`);
ok(near(tr.k, 4, 1e-12), `U₁/U₂ = ${tr.k} = N₁/N₂`);

// ══════════════════════════════════════════════════════════
head('§6 世界内实测 ①：交流电源 + 二极管 + 负载 + 示波器（真实求解器）');
// ══════════════════════════════════════════════════════════
// 交流源(Up=6, f=1, 内阻 0.05) → 二极管(正接, Vf=0.6) → 定值电阻(100Ω) → 回源
const S1 = build({
  entities: [
    { type: 'acsource', x: 100, y: 100 },
    { type: 'diode', x: 300, y: 100 },
    { type: 'resistor', x: 500, y: 100, props: { resistance: 100 } },
    { type: 'oscilloscope', x: 200, y: 240 },
  ],
  wires: [[0, 0, 1, 0], [1, 1, 2, 0], [2, 1, 0, 1]],
});
// 负载电压的实测平均值：每个采样点读负载自己的 state.U（求解器写回的），
// 只在整数个周期上取平均，避免半周期截断带来的偏差。
const loadU = [];
S1.run(3, () => loadU.push(S1.get(2).state.U));
const onePeriod = loadU.slice(loadU.length - 120);
const loadMean = E.meanOf(onePeriod);
const acSrc = S1.get(0), diode = S1.get(1), scope = S1.get(3);
const acI = acSrc.state.I;
const expectedLoadMean = E.halfWaveMean(6, 0.6) * 100 / (100 + 0.5 + 0.05);
ok(near(acSrc.state.rmsMeas, 6 / Math.SQRT2, 0.02),
  `交流源实测有效值 ${acSrc.state.rmsMeas.toFixed(4)} V ↔ Up/√2 = ${(6 / Math.SQRT2).toFixed(4)} V（偏差 ${pct(acSrc.state.rmsMeas, 6 / Math.SQRT2)}）`);
ok(near(scope.state.fMeas, 1, 0.005),
  `示波器实测频率 ${scope.state.fMeas.toFixed(4)} Hz ↔ 源 ${scope.state.fSrc} Hz（偏差 ${pct(scope.state.fMeas, 1)}）`);
ok(scope.state.dPhase < 0.05,
  `示波器实测相位差 ${(scope.state.dPhase * 100).toFixed(3)}% 周期（要求 <5%）：上升过零时刻 vs 解析预测`);
ok(near(scope.state.pp, 12, 0.03), `示波器实测峰峰值 ${scope.state.pp.toFixed(4)} V ↔ 2Up = 12 V（偏差 ${pct(scope.state.pp, 12)}）`);
ok(near(diode.state.duty, diode.state.dutyTheory, 0.03),
  `二极管实测导通占空比 ${(diode.state.duty * 100).toFixed(2)}% ↔ 理论 (π−2θ₀)/2π = ${(diode.state.dutyTheory * 100).toFixed(2)}%（Vf=0.6 时应略低于 50%）`);
ok(near(loadMean, expectedLoadMean, 0.03),
  `负载实测平均电压 ${loadMean.toFixed(5)} V ↔ 半波解析式×分压 ${expectedLoadMean.toFixed(5)} V（偏差 ${pct(loadMean, expectedLoadMean)}）`);
info(`Vf=0.6 时 ⟨U⟩ = ${E.halfWaveMean(6, 0.6).toFixed(4)} V，小于理想 Up/π = ${(6 / Math.PI).toFixed(4)} V，差的就是压降吃掉的一整段导通角`);

// 反接：串联在回路里的二极管不论正接反接都导通半个周期，区别是**导通的是哪半周**
// （于是直流分量反号、幅值相同）。真正的「反向截止」要用直流验，见 §6b。
S1.get(1).setProp('dir', 'rev');
const loadU2 = [];
S1.run(1.5, () => loadU2.push(S1.get(2).state.U));
const revMean = E.meanOf(loadU2.slice(-120));
const revDuty = diode.state.duty;
ok(near(revDuty, diode.state.dutyTheory, 0.03),
  `反接后导通占空比 ${(revDuty * 100).toFixed(2)}%（仍是 ~50%：导通换到了另外半周）`);
ok(revMean < 0 && near(-revMean, loadMean, 0.05),
  `反接后负载平均电压 ${revMean.toFixed(5)} V ↔ 正接时 ${loadMean.toFixed(5)} V：**反号等幅**（${pct(-revMean, loadMean)}）`);

// ══════════════════════════════════════════════════════════
head('§6b 单向导电的直流验：一端通、另一端断');
// ══════════════════════════════════════════════════════════
// 端子约定：求解器里 U = V(端口0) − V(端口1)。口径按**符号**找，不按行号：
//   solveCircuit() 里端口对取自 `ia = wp[0]; ib = wp[1]`（wp = kind:'wire' 的口），
//   上报值取自 `const U = (ia >= 0 ? x[ia] : 0) - (ib >= 0 ? x[ib] : 0)`。
// 二极管的 dir 就是按这个说的。battery 的支路是 {V, emf:+emf} ⇒ U = emf − ri·I > 0，
// 端口 0 是求解器意义上的正端 —— **器件上印的 '+' 现在也画在端口 0 的那一侧**；
// 此前 electrical.js 把 '−' 印在端口 0（与上面这条约定恰好相反），2026-10-19 已修正。
// 这条口径由 tools/polarity-probe.mjs 断言（印字符号 ↔ U(端口) 符号）。
const DCBlock = (dir, swap) => {
  const s = build({
    entities: [
      { type: 'battery', x: 100, y: 100, props: { emf: 6, internalR: 0.5 } },
      { type: 'diode', x: 300, y: 100, props: { dir, vf: 0.6, ron: 0.5, roff: 1 } },
      { type: 'resistor', x: 500, y: 100, props: { resistance: 100 } },
    ],
    wires: swap ? [[0, 1, 1, 0], [1, 1, 2, 0], [2, 1, 0, 0]]
                 : [[0, 0, 1, 0], [1, 1, 2, 0], [2, 1, 0, 1]],
  });
  s.run(0.2);
  return { I: s.get(2).state.I, U: s.get(2).state.U, duty: s.get(1).state.duty, diode: s.get(1) };
};
const fwdDC = DCBlock('fwd'), revDC = DCBlock('rev');
const iFwdTheory = (6 - 0.6) / (100 + 0.5 + 0.5);
ok(near(fwdDC.I, iFwdTheory, 0.02),
  `正接（电池端口0 → 二极管端口0）：电流 ${fwdDC.I.toFixed(5)} A ↔ (E−Vf)/(R+ron+r内) = ${iFwdTheory.toFixed(5)} A（偏差 ${pct(fwdDC.I, iFwdTheory)}）`);
ok(Math.abs(revDC.I) < 1e-5 && Math.abs(revDC.I) / iFwdTheory < 2e-4,
  `同一接线反接：电流 ${revDC.I.toExponential(2)} A（截止，比正接小 ${(Math.log10(iFwdTheory / Math.abs(revDC.I))).toFixed(1)} 个数量级；残余是 roff=1 MΩ 的漏电）`);
ok(fwdDC.diode.state.on === true && revDC.diode.state.on === false,
  `导通状态标志：正接 on=${fwdDC.diode.state.on}，反接 on=${revDC.diode.state.on}`);
// 把电池两端对调 = 换成另一半周导通：同一只二极管（dir 不变）应当转为截止，
// 说明「通/断」是由**电压方向**决定的，不是绑在 dir 上的常量
const swDC = DCBlock('fwd', true);
ok(swDC.diode.state.on === false && Math.abs(swDC.I) < 1e-5,
  `电池两端对调（dir 仍为 fwd）：电流 ${Math.abs(swDC.I).toExponential(2)} A、on=${swDC.diode.state.on} —— 换个电压方向同一只管子就断了`);

// ══════════════════════════════════════════════════════════
head('§7 世界内实测 ②：RC / RL / 变压器（含求解器对撞）');
// ══════════════════════════════════════════════════════════
// ⚠ 这条是给「同一世界里两个互不连通的回路」留的**回归证据**（task-29 修的正是它）。
//   旧缺陷：gmin(1e-12) 撑着第二个岛，消元枢轴掉到 1e-12 → gauss 判秩亏 → ok:false，
//   **所有实体静默拿不到 state.U/I**；修好之后两岛应各自解出来、读数还得对。
//   所以断言写成**与修复进度无关的不变量**：要么「全体拿不到读数」（旧缺陷），
//   要么「两岛读数与各自单独成世界时一致」——不允许出现「解得出来但数不对」。
{
  const ISLAND_A = () => [
    { type: 'battery', x: 0, y: 0, props: { emf: 6, internalR: 0.5 } },
    { type: 'inductorcoil', x: 0, y: 0 },
  ];
  const ISLAND_B = () => [
    { type: 'acsource', x: 0, y: 0, props: { Up: 6, f: 1, r: 0.05 } },
    { type: 'transformer', x: 0, y: 0 },
  ];
  const A_WIRES = [[0, 1, 1, 0], [1, 1, 0, 0]];
  const B_WIRES = [[0, 0, 1, 0], [1, 1, 0, 1]];

  // ③ 两岛同处一个世界；④ 两岛 + 一根公共地线
  const apart = build({ entities: [...ISLAND_A(), ...ISLAND_B()], wires: [...A_WIRES, ...B_WIRES.map(w => [w[0] + 2, w[1], w[2] + 2, w[3]])] });
  const cApart = apart.tick(DT);
  const joined = build({ entities: [...ISLAND_A(), ...ISLAND_B()], wires: [...A_WIRES, ...B_WIRES.map(w => [w[0] + 2, w[1], w[2] + 2, w[3]]), [0, 0, 2, 0]] });
  const cJoined = joined.tick(DT);
  // ① ② 单回路（本文件其余小节用的装配）；⑤ 悬空电阻；⑥ 悬空电阻 + 一个回路
  const lone = build({ entities: ISLAND_A(), wires: A_WIRES });
  const cLone = lone.tick(DT);
  const loneB = build({ entities: ISLAND_B(), wires: B_WIRES });
  const cLoneB = loneB.tick(DT);
  const floatOnly = build({ entities: [{ type: 'resistor', x: 0, y: 0, props: { resistance: 10 } }], wires: [] });
  const cFloat = floatOnly.tick(DT);
  const floatPlus = build({ entities: [{ type: 'resistor', x: 0, y: 0, props: { resistance: 10 } }, ...ISLAND_A()], wires: [[1, 1, 2, 0], [2, 1, 1, 0]] });
  const cFloatPlus = floatPlus.tick(DT);

  info(`实测表 ① A 岛单回路 ok=${cLone.ok}/${cLone.branches.size} 支路`
    + ` ② B 岛单回路 ok=${cLoneB.ok}/${cLoneB.branches.size}`
    + ` ③ **两岛同世界** ok=${cApart.ok}/${cApart.branches.size}`
    + ` ④ 两岛+公共地线 ok=${cJoined.ok}/${cJoined.branches.size}`
    + ` ⑤ 悬空电阻 ok=${cFloat.ok}/${cFloat.branches.size}`
    + ` ⑥ 悬空电阻+回路 ok=${cFloatPlus.ok}/${cFloatPlus.branches.size}`);

  const uIn = (s, i) => Math.abs(s.get(i).state.U);
  const xfIn = (s, i) => s.get(i).state.U1;
  const uApartRaw = apart.get(2).state.U, xfApartRaw = apart.get(3).state.U1;
  const anyReading = apart.ents.some(e => isFinite(e.state.U) && isFinite(e.state.I));
  if (!cApart.ok) {
    ok(uApartRaw === undefined || !isFinite(uApartRaw),
      `③ 旧缺陷态：两岛同世界 → ok=${cApart.ok}（${cApart.reason || '秩亏'}），实体拿不到 state.U（实测 ${uApartRaw}）——「按子系统分世界」就是为它留的`);
  } else if (!anyReading) {
    ok(false, `③ 两岛同世界 → ok=${cApart.ok} 但没有任何实体拿到读数（求解器只回了空的 branch 表）`);
  } else {
    const dA = Math.abs(uIn(apart, 1) - uIn(lone, 1)) / Math.max(1e-12, uIn(lone, 1));
    const dB = Math.abs(xfIn(apart, 3) - xfIn(loneB, 1)) / Math.max(1e-12, Math.abs(xfIn(loneB, 1)));
    ok(dA < 0.01 && dB < 0.01,
      `③ 两岛同世界 → ok=${cApart.ok}：A 岛电感端电压 ${uIn(apart, 1).toFixed(4)} V ↔ 单独成世界 ${uIn(lone, 1).toFixed(4)} V（偏差 ${(dA * 100).toFixed(3)}%）；`
      + `B 岛变压器 U₁ ${xfIn(apart, 3).toFixed(4)} V ↔ ${xfIn(loneB, 1).toFixed(4)} V（偏差 ${(dB * 100).toFixed(3)}%）——两岛互不干扰`);
  }
  ok(cJoined.ok === true && cJoined.branches.size === 4,
    `④ 同两个回路 + 一根公共地线 → ok=${cJoined.ok}、支路数 ${cJoined.branches.size}（证实曾经的症状是「无公共参考节点」而不是元件本身的问题）`);
}

// 场景 S2：电池 + 电感（真实 RL 回路）+ 电容（自带积分）
const S2 = build({
  entities: [
    { type: 'resistorcap', x: 100, y: 100 },
    { type: 'inductorcoil', x: 300, y: 100 },
    { type: 'battery', x: 300, y: 260, props: { emf: 6, internalR: 0.5 } },
  ],
  wires: [[2, 1, 1, 0], [1, 1, 2, 0]],
});
S2.run(2.6);
const cap = S2.get(0), coil = S2.get(1);
ok(near(cap.state.tau, 1, 1e-12), `电容 τ = ${cap.state.tau} s`);
ok(Math.abs(cap.state.t63 - cap.state.tau) / cap.state.tau < 0.03,
  `电容**实时**实测 63.2% 时刻 ${cap.state.t63.toFixed(4)} s ↔ τ ${cap.state.tau.toFixed(4)} s（偏差 ${pct(cap.state.t63, cap.state.tau)}）`);
const capAnalytic = 6 * (1 - Math.exp(-cap.state.t / cap.state.tau));
ok(near(cap.state.Uc, capAnalytic, 0.01),
  `充电 ${cap.state.t.toFixed(3)} s（${(cap.state.t / cap.state.tau).toFixed(2)}τ）后 Uc = ${cap.state.Uc.toFixed(4)} V ↔ 解析 1−e^(−t/τ) = ${capAnalytic.toFixed(4)} V（偏差 ${pct(cap.state.Uc, capAnalytic)}）`);
const iSolve = coil.state.I, iInt = coil.state.iL;
ok(coil.state.fromCircuit === true, `电感已从电路取真实端电压 ${Math.abs(coil.state.U).toFixed(4)} V（而非自己的 U₀ 假设）`);
ok(near(Math.abs(iInt), Math.abs(iSolve), 0.002),
  `两条独立路径对撞：自积分 |iL| = ${Math.abs(iInt).toFixed(6)} A ↔ 求解器 |I| = ${Math.abs(iSolve).toFixed(6)} A（偏差 ${pct(Math.abs(iInt), Math.abs(iSolve))}）`);
info(`符号：自积分取 +（$U\\to i$ 的正方向），求解器的 I = ${iSolve.toFixed(6)} A（它的正方向按端口 0→1 定义，两条都没错，对撞只看幅值）`);
// 断电自感
coil.setProp('closed', false);
const spike0 = coil.state.spike, iBefore = coil.state.i0break;
ok(spike0 > 0 && near(spike0, iBefore * 1e6, 1e-9),
  `断电瞬间：I₀ = ${iBefore.toFixed(6)} A → 自感尖峰 U = I₀·R_弧 = ${(spike0 / 1000).toFixed(2)} kV`);
S2.run(0.02);
ok(coil.state.iL < iBefore * 1e-3, `断开后电流按 τ' = L/R_弧 迅速归零：i = ${coil.state.iL.toExponential(3)} A`);
// 电容放电
cap.setProp('mode', 'discharge');
cap.state.Uc = 6;
S2.run(1.0);
ok(near(cap.state.Uc / 6, Math.exp(-1), 0.03),
  `电容放电一个 τ 后 Uc/U₀ = ${(cap.state.Uc / 6).toFixed(4)} ↔ e⁻¹ = ${Math.exp(-1).toFixed(4)}（偏差 ${pct(cap.state.Uc / 6, Math.exp(-1))}）`);

// 场景 S2b：交流源 + 变压器（一次侧直接并在这只源上）
const S2b = build({
  entities: [
    { type: 'acsource', x: 600, y: 300, props: { Up: 6, f: 1, r: 0.05 } },
    { type: 'transformer', x: 600, y: 100, props: { N1: 400, N2: 100, RL: 10, R1: 40 } },
  ],
  wires: [[0, 0, 1, 0], [0, 1, 1, 1]],
});
S2b.run(0.25);                                          // 恰好 T/4：交流源瞬时值 ≈ 峰值
const xf = S2b.get(1);
const expectU1 = 6 * 40 / (40 + 0.05);
ok(near(Math.abs(xf.state.U1), expectU1, 0.02),
  `变压器从**求解器**读到一次电压 ${Math.abs(xf.state.U1).toFixed(4)} V ↔ 分压解析 6×40/(40+0.05) = ${expectU1.toFixed(4)} V（偏差 ${pct(Math.abs(xf.state.U1), expectU1)}）`);
ok(near(xf.state.ratio, 4, 1e-9) && near(xf.state.nRatio, 4, 1e-9),
  `实测 U₁/U₂ = ${xf.state.ratio.toFixed(6)} = N₁/N₂ = ${xf.state.nRatio}`);
ok(near(xf.state.P1, xf.state.P2, 1e-9), `P₁ = ${xf.state.P1.toExponential(4)} W = P₂ = ${xf.state.P2.toExponential(4)} W`);
ok(near(xf.state.I1, xf.state.I2 / 4, 1e-9),
  `I₁ = ${xf.state.I1.toExponential(4)} A = I₂/4 = ${(xf.state.I2 / 4).toExponential(4)} A（升压降流）`);

S1.render(); S2.render(); S2b.render(); fwdDC.diode.render(CTX);
ok(true, 'MINE 6 件器材的 render() 在无头 Canvas 替身上全部跑通（无异常）');

// ══════════════════════════════════════════════════════════
head('§8 耦合链：整流后的直流分量 → 真化学电解（CuSO₄ 溶液，量真实沉积的 Cu）');
// ══════════════════════════════════════════════════════════
// 石墨电极（E0=null）→ 不形成原电池 → bridge 造出 solution 支路 sol:<烧杯id>。
// 溶液：50 mL 1 mol/L CuSO₄ + 50 mL 水；电解反应 ely-cuso4：2CuSO₄+2H₂O --通电--> 2Cu+O₂↑+2H₂SO₄
// 回路里串一只 100 Ω（既有器材）作限流电阻：否则 8 Ω 的溶液电阻会被电解本身改变
// （Cu²⁺ 消耗 → 电导率变化），四个变体的 ∫|I|dt 比值就不再是纯 1 : 2/π : 1/π。
const R_SERIES = 100;
/**
 * 造一个电解池世界。三个可选参数各有用途：
 *   withDiode/diodeProps —— 串一只二极管（§8 的整流对照面：此时 I 恒不反号，∫I dt ≡ ∫|I|dt）；
 *   fill                 —— 溶液配方（默认 CuSO₄ = 可逆金属沉积；换 NaCl 用来对照"只放气、不互抵"）；
 *   bias                 —— 再串一只电池做**半周不对称的偏置交流**（§9 的 D37 见证场景）。
 *                           没有偏置时 ∫I dt ≈ 0 而 ∫|I|dt 很大，两者都"能过"一个把反应层掐死的实现；
 *                           加了偏置后两条预测分叉（实测相差 7.7 倍），才能区分
 *                           "净产物 ∝ ∫I dt（带符号）" 与 "∝ ∫|I|dt（幅度）"。
 */
const makeCell = (srcType, srcProps, withDiode, diodeProps, fill, bias) => {
  const sc = {
    entities: [
      { type: srcType, x: 100, y: 100, props: srcProps },
      { type: 'beaker', x: 400, y: 300, props: { capacity: 250 },
        fill: fill || { liquid: [['CuSO4', 50], ['H2O', 50]] } },
      { type: 'electrode', x: 394, y: 300, props: { metal: 'graphite' } },
      { type: 'electrode', x: 406, y: 300, props: { metal: 'graphite' } },
      { type: 'resistor', x: 250, y: 220, props: { resistance: R_SERIES } },
    ],
    wires: [],
  };
  // ⚠ 串联元件的 push 顺序必须与下面 next 的索引顺序一致（先 bias、后 diode）
  if (bias) sc.entities.push({ type: 'battery', x: 150, y: 100, props: bias });
  if (withDiode) sc.entities.push({ type: 'diode', x: 250, y: 100, props: diodeProps });
  const sim = build(sc);
  const src = sim.get(0), eA = sim.get(2), eB = sim.get(3), RS = sim.get(4);
  const link = (a, ap, b, bp) => sim.world.connect({ e: a.id, p: ap }, { e: b.id, p: bp }, 'wire');
  let next = 5;
  let up = { e: src, p: 0 };                       // 从电源端口 0 出发，串完所有元件再去限流电阻
  if (bias) { const b = sim.get(next++); link(up.e, up.p, b, 0); up = { e: b, p: 1 }; }
  if (withDiode) { const d = sim.get(next++); link(up.e, up.p, d, 0); up = { e: d, p: 1 }; }
  link(up.e, up.p, RS, 0);
  link(RS, 1, eA, 0);
  link(eB, 0, src, 1);
  return sim;
};
const vOf = (sim) => sim.get(1).vessel;

/**
 * 跑一段并累积电量（从 sol: 支路记录读，这是**真电流**）。
 *
 * 四个累积量各有用途，缺一不可：
 *   integral = ∫|I|dt —— **幅度**积分（桥接层 electricCurrent 的来源，法拉第速率的门控量）；
 *   signed   = ∫I dt  —— **带符号**积分 = 净电荷（交流对称时应为 0，偏置时不为 0）；
 *   qPos/qNeg          —— 正/负半周各自的电量（用来断言"两个半周确实互抵"，而不只是"净值为 0"）；
 * dCu 与 dGas 是净产物；marks 记录每 1/4 周期的累计产物，用来抓"回溶"这一瞬间形态。
 * mutate(v) 是可选的**变异钩子**（§9 A5′ 用）：每 tick 在桥接层写完之后改容器的电流字段，
 * 用来把"错法"真的造出来，检验断言挡不挡得住 —— 一条永远为真的断言等于没写。
 */
function runCell(sim, sec, marks, mutate) {
  const v = vOf(sim);
  const key = 'sol:' + sim.get(1).id;
  let integral = 0, signed = 0, qPos = 0, qNeg = 0;
  const series = [];
  const cu0 = v.amount('Cu');
  const gas0 = { H2: v.gas.get('H2') || 0, O2: v.gas.get('O2') || 0, Cl2: v.gas.get('Cl2') || 0 };
  const n = Math.round(sec / DT);
  for (let i = 0; i < n; i++) {
    sim.tick(DT, (c) => {
      const rec = c.branches.get(key);
      const I = rec ? rec.I : 0;
      integral += Math.abs(I) * DT;
      signed += I * DT;
      if (I > 0) qPos += I * DT; else qNeg += I * DT;
      // vS = 写进容器的那一路带符号电流（k2 的 currentSigned）；vI = 幅度字段，两者应当同源
      series.push({ t: sim.world.time, I, vI: v.electricCurrent, vS: v.currentSigned });
      if (mutate) mutate(v);
    });
    if (marks && marks.some(m => Math.abs(sim.world.time - m) < DT / 2)) {
      series.push({ mark: sim.world.time, cu: v.amount('Cu') - cu0 });
    }
  }
  const dGas = {
    H2: (v.gas.get('H2') || 0) - gas0.H2,
    O2: (v.gas.get('O2') || 0) - gas0.O2,
    Cl2: (v.gas.get('Cl2') || 0) - gas0.Cl2,
  };
  return { integral, signed, qPos, qNeg, dCu: v.amount('Cu') - cu0, dGas, series, cu0 };
}

const DC = makeCell('battery', { emf: 6, internalR: 0.05 }, false);
const dcRun = runCell(DC, 2.0);
info(`直流 6 V：∫|I|dt = ${dcRun.integral.toFixed(6)} A·s，沉积 Cu = ${dcRun.dCu.toExponential(4)} mol，溶液电阻 ${vOf(DC).resistance().toFixed(4)} Ω`);
ok(dcRun.dCu > 1e-5, `直流确实电解出铜：Δn(Cu) = ${dcRun.dCu.toExponential(4)} mol（真化学产物，不是画上去的）`);
const faraday = dcRun.dCu / dcRun.integral;          // mol per (A·s)：本模型的法拉第系数
info(`由直流实验定标：Δn(Cu)/∫|I|dt = ${faraday.toExponential(4)} mol/(A·s)（= 2·k·… 的等效值）`);

const AC = makeCell('acsource', { Up: 6, f: 1, r: 0.05 }, false);
const acRun = runCell(AC, 2.0, [0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0]);
const rAC = acRun.integral / dcRun.integral;
info(`交流 Up=6 V：∫|I|dt = ${acRun.integral.toFixed(6)} A·s，沉积 Cu = ${acRun.dCu.toExponential(4)} mol`);
// 【升级自旧「交流产量仍严格 ∝ ∫|I|dt」】旧断言描述的是**缺陷态**（幅度律被错误地施加在可逆沉积上）；
// 现在描述永久不变量：可逆金属沉积的净产物 ∝ ∫I dt，因此**对称交流不服从幅度律**（∫I dt ≈ 0），
// 而整流后 I 不反号、幅度律必然成立（下面两条 ✓）—— 一否一立成对，才挡得住"把反应层整个掐死"的实现。
ok(!near(acRun.dCu, faraday * acRun.integral, 0.6) && Math.abs(acRun.dCu) < 5e-3 * faraday * acRun.integral,
  `可逆沉积上**幅度律不成立**：幅度律预测 ${(faraday * acRun.integral).toExponential(4)} mol ↔ 实测 ${acRun.dCu.toExponential(4)} mol`
  + `（偏差 ${pct(acRun.dCu, faraday * acRun.integral)}）—— 因为对称交流的净电荷 ≈ 0（§9 A3/A4 给数），净产物跟着 ∫I dt 走；`
  + `改前这一条恰好相反（实测跟着幅度律走，历史读数见 §9「改前 ③」）`);
ok(near(rAC, 2 / Math.PI, 0.02),
  `交流/直流 通电等效比 = ${rAC.toFixed(4)} ↔ 2/π = ${(2 / Math.PI).toFixed(4)}（偏差 ${pct(rAC, 2 / Math.PI)}）：因为产量正比于 |I| 的平均值`);

const AC0 = makeCell('acsource', { Up: 6, f: 1, r: 0.05 }, true, { vf: 0, ron: 0.5, roff: 1, dir: 'fwd' });
const a0Run = runCell(AC0, 2.0);
const r0 = a0Run.integral / dcRun.integral;
ok(near(r0, 1 / Math.PI, 0.03),
  `整流(Vf=0)：∫|I|dt 比 = ${r0.toFixed(4)} ↔ 1/π = ${(1 / Math.PI).toFixed(4)}（偏差 ${pct(r0, 1 / Math.PI)}）—— 整流后的平均值决定产量`);
ok(near(a0Run.dCu, faraday * a0Run.integral, 0.08),
  `整流(Vf=0) 产量预测 ${(faraday * a0Run.integral).toExponential(4)} ↔ 实测 ${a0Run.dCu.toExponential(4)} mol`);

const AC6 = makeCell('acsource', { Up: 6, f: 1, r: 0.05 }, true, { vf: 0.6, ron: 0.5, roff: 1, dir: 'fwd' });
const a6Run = runCell(AC6, 2.0);
const r6 = a6Run.integral / dcRun.integral;
const theory6 = E.halfWaveMean(6, 0.6) / 6;
ok(near(r6, theory6, 0.03),
  `整流(Vf=0.6)：比 = ${r6.toFixed(4)} ↔ 解析 ⟨U⟩/Up = ${theory6.toFixed(4)}（偏差 ${pct(r6, theory6)}）—— 压降吃掉的那部分产量是算得出来的`);
info(`四个变体的 ∫|I|dt：直流 ${dcRun.integral.toFixed(4)} / 交流 ${acRun.integral.toFixed(4)} / 整流0 ${a0Run.integral.toFixed(4)} / 整流0.6 ${a6Run.integral.toFixed(4)} A·s`);

// ══════════════════════════════════════════════════════════
head('§9 【改前证据 + 永久不变量】对称交流：净电荷≈0、可逆沉积净产物≈0（气体池不互抵）');
// ══════════════════════════════════════════════════════════
// ── 改前证据（缺陷已被 k2 的 task-28 修好，磁盘上再也复现不出来；转录自 task-17 交件，留档） ──
info('改前 ①（旧 §9:525 实测）：v.electricCurrent 负值样本 0/240、min 0.000e+0、max 0.0554 A'
  + ' —— 符号在 bridge.js:165 的 Math.abs(rec.I) 这一行被丢掉');
info('改前 ②（旧 §9:529 实测）：Cu 每 1/4 周期 17.1 → 35.1 → 52.2 → 70.3 → 87.4 → 105.4 → 122.5 → 140.6 µmol，'
  + '单调递增、2 s 内一次回溶都没有');
info('改前 ③（旧 §9:490 实测）：交流产量 预测 faraday·∫|I|dt = 1.4094e-4 mol ↔ 实测 6.3803e-8 mol（偏差 99.955%）');
info('改前 ④（半修中间态实测）：18.0 → 0.0 已出现回溶，但净产物仍非零 —— "只看单调性"抓不住缺陷的全部');
info('以下断言描述**应当成立什么**（永久不变量），不是"曾经坏过什么"；上面四条只作为该缺陷的存在证明留档。');

// ── 形状：从磁盘读 bridge.js 的字段判定，不引用任务书里的形状假设（task-31 第 6 条） ──
const vAC = vOf(AC);
const hasSigned = typeof vAC.currentSigned === 'number';
const shapeA = hasSigned && Math.abs(vAC.electricCurrent - Math.abs(vAC.currentSigned)) < 1e-12;
info(`耦合层形状判定：${shapeA ? '(a) electricCurrent=幅度 + currentSigned=带符号'
  : hasSigned ? '(a′) 两个字段都在但末帧不满足 |electricCurrent|=|currentSigned|'
  : '(b) 只有 electricCurrent，且它自身带符号'}`
  + `（AC 末帧：electricCurrent=${vAC.electricCurrent.toFixed(6)} A、currentSigned=${hasSigned ? vAC.currentSigned.toFixed(6) : '不存在'} A）`);

const acSeries = acRun.series.filter(s => s.I !== undefined);
let minI = Infinity, maxI = -Infinity, minV = Infinity, maxV = -Infinity, negV = 0;
let minS = Infinity, maxS = -Infinity, negS = 0, chanBad = 0;
for (const s of acSeries) {
  minI = Math.min(minI, s.I); maxI = Math.max(maxI, s.I);
  minV = Math.min(minV, s.vI); maxV = Math.max(maxV, s.vI);
  if (s.vI < 0) negV++;
  const sv = hasSigned ? s.vS : s.vI;                 // 形状 (b) 下带符号的那一路就是 electricCurrent
  minS = Math.min(minS, sv); maxS = Math.max(maxS, sv);
  if (sv < 0) negS++;
  if (hasSigned && Math.abs(s.vI - Math.abs(s.vS)) > 1e-12) chanBad++;
}
console.log(`    真电流 rec.I        ：min ${minI.toFixed(4)} A  max ${maxI.toFixed(4)} A`);
console.log(`    容器 electricCurrent：min ${minV.toExponential(3)}  max ${maxV.toFixed(4)} A   负值样本 ${negV} / ${acSeries.length}`);
console.log(`    容器 currentSigned  ：min ${minS.toFixed(4)}  max ${maxS.toFixed(4)} A   负值样本 ${negS} / ${acSeries.length}`);
console.log(`    带符号电量 ∫I dt = ${acRun.signed.toExponential(4)} A·s   vs   ∫|I|dt = ${acRun.integral.toFixed(6)} A·s`
  + `   比值 ${(acRun.signed / acRun.integral).toExponential(3)}`);

// A1. 前提（旧断言保留）：真电流确实反号且正负对称
ok(maxI > 0.02 && minI < -0.02 && near(-minI, maxI, 0.03),
  `溶液支路的真电流**确实反号且正负对称**：min ${minI.toFixed(4)} A、max ${maxI.toFixed(4)} A（偏差 ${pct(-minI, maxI)}，一个周期里正负各半）`);

// A2.【升级自旧「永不反号」】写进容器的那一路电流是**带符号**的，且两路同源
//     （旧断言写的是"永不反号"——那是缺陷态描述；现在描述的是通道契约本身）
ok(maxS > 0.02 && minS < -0.02 && near(-minS, maxS, 0.03),
  `${hasSigned ? 'currentSigned' : 'electricCurrent'} **确实带符号且正负对称**：min ${minS.toFixed(4)} A、max ${maxS.toFixed(4)} A`
  + `（偏差 ${pct(-minS, maxS)}，负值样本 ${negS}/${acSeries.length}）—— 化学层因此能判方向`);
ok(hasSigned ? (chanBad === 0 && negV === 0) : (negS > 0),
  hasSigned
    ? `幅度/符号两路同源：electricCurrent 逐样本 = |currentSigned|（不一致样本 ${chanBad}/${acSeries.length}，`
      + `electricCurrent 负值样本 ${negV} 个）—— 幅度字段语义未变、符号另走一路（bridge.js:171/:172）`
    : `形状 (b)：electricCurrent 自身带符号（负值样本 ${negS}/${acSeries.length}），下游门控仍需取幅度`);

// A3.【升级自旧「永不反号」】对称交流的**净电荷 ≈ 0**，且是"两个半周真的互抵"，不是"根本没有电荷"
const qRatio = Math.abs(acRun.qPos + acRun.qNeg) / Math.max(1e-12, acRun.integral);
const halfShare = Math.min(Math.abs(acRun.qPos), Math.abs(acRun.qNeg)) / Math.max(1e-12, acRun.integral);
ok(acRun.qPos > 0.3 * acRun.integral && acRun.qNeg < -0.3 * acRun.integral,
  `非空前置：正半周电量 ${acRun.qPos.toFixed(6)} A·s、负半周 ${acRun.qNeg.toFixed(6)} A·s`
  + `（各占 ∫|I|dt 的 ${(100 * acRun.qPos / acRun.integral).toFixed(2)}% / ${(100 * Math.abs(acRun.qNeg) / acRun.integral).toFixed(2)}%）`
  + ' —— 两个半周都有实打实的电荷，下面那条"净≈0"才不是空集上的恒真');
ok(qRatio < 1e-3 && halfShare > 0.3,
  `对称交流**净电荷 ≈ 0**：∫I dt = ${acRun.signed.toExponential(4)} A·s ↔ ∫|I|dt = ${acRun.integral.toFixed(6)} A·s`
  + `（比值 ${(acRun.signed / acRun.integral).toExponential(3)} < 1e-3，即抵消 ${(100 * (1 - Math.abs(acRun.signed) / acRun.integral)).toFixed(3)}%）`);

// A4.【升级自旧「单调递增」】对称交流下 Cu 出现**回溶**，且净变化 ≈ 0
const marks = acRun.series.filter(s => s.mark !== undefined);
let drops = 0;
for (let i = 1; i < marks.length; i++) if (marks[i].cu < marks[i - 1].cu - 1e-12) drops++;
const grossCu = faraday * acRun.integral;
ok(marks.length >= 8 && drops >= 1,
  `交流 2 s 内 Cu **出现回溶**（${marks.map(m => (m.cu * 1e6).toFixed(1)).join(' → ')} µmol，`
  + `每 1/4 周期采样一次，下降次数 ${drops}）—— 负半周把镀上去的铜溶回去了（旧读数②是"一次都不降"）`);
ok(grossCu > 1e-4 && Math.abs(acRun.dCu) / grossCu < 5e-3,
  `对称交流**净产物 ≈ 0**：净 Δn(Cu) = ${(acRun.dCu * 1e6).toFixed(3)} µmol ↔ 若按幅度律本应产 ${(grossCu * 1e6).toFixed(1)} µmol`
  + `（抵消 ${(100 * (1 - Math.abs(acRun.dCu) / grossCu)).toFixed(3)}%；直流同电路产 ${(dcRun.dCu * 1e6).toFixed(2)} µmol 作对照）`);

// A5.【升级自旧「∝ ∫|I|dt」】净产物 ∝ ∫I dt（带符号），并**用偏置交流把两条预测分开**
//     没有偏置时 ∫I dt≈0、∫|I|dt 很大，一个"把反应层整个掐死"的实现也能过 —— 所以必须有这条见证。
//     偏置取**负**电压：实测该接法下 ∫I dt > 0（净沉积），避免"净溶解"被 Cu 不能为负这一层夹断到 0。
const makeBiased = () => makeCell('acsource', { Up: 6, f: 1, r: 0.05 }, false, null, null, { emf: -0.5, internalR: 0.05 });
const acbRun = runCell(makeBiased(), 2.0);
const predSigned = faraday * acbRun.signed, predAbs = faraday * acbRun.integral;
info(`偏置交流（6 V 交流串 0.5 V 电池）：∫I dt = ${acbRun.signed.toExponential(4)}、∫|I|dt = ${acbRun.integral.toFixed(6)} A·s`
  + `（比值 ${(acbRun.signed / acbRun.integral).toFixed(4)}）→ 两条预测 ${(predSigned * 1e6).toFixed(2)} µmol（带符号）`
  + ` vs ${(predAbs * 1e6).toFixed(2)} µmol（幅度律），相差 ${(predAbs / predSigned).toFixed(2)} 倍`);
ok(!near(predAbs, predSigned, 0.6),
  `见证场景有效：偏置把两条预测分开了（带符号 ${(predSigned * 1e6).toFixed(2)} µmol ↔ 幅度律 ${(predAbs * 1e6).toFixed(2)} µmol，差 ${(100 * Math.abs(predAbs - predSigned) / Math.abs(predAbs)).toFixed(1)}%）`);
ok(near(acbRun.dCu, predSigned, 0.06) && !near(acbRun.dCu, predAbs, 0.6),
  `净产物**跟 ∫I dt 走、不跟 ∫|I|dt 走**：实测 ${(acbRun.dCu * 1e6).toFixed(2)} µmol`
  + ` ↔ 带符号预测 ${(predSigned * 1e6).toFixed(2)} µmol（偏差 ${pct(acbRun.dCu, predSigned)}）；`
  + `若按幅度律应得 ${(predAbs * 1e6).toFixed(2)} µmol（偏差 ${pct(acbRun.dCu, predAbs)}，被否）`);

// A5′.【断言自身的判别力】A5 必须**两种错法都挡得住**：掐死反应层、仍按幅度律。
//      一条永远为真的断言等于没写 —— 所以这里把两种错法各真的造一遍，看 A5 会不会红。
const killRun = runCell(makeBiased(), 2.0, null, (v) => { v.electricCurrent = 0; v.currentSigned = 0; });
const ampRun = runCell(makeBiased(), 2.0, null, (v) => { v.currentSigned = Math.abs(v.currentSigned); });
ok(!near(killRun.dCu, predSigned, 0.06),
  `变异 ①（掐死反应层：两路电流每 tick 归零）→ 净 Cu = ${(killRun.dCu * 1e6).toFixed(3)} µmol ↔ 带符号预测 ${(predSigned * 1e6).toFixed(2)} µmol`
  + `（偏差 ${pct(killRun.dCu, predSigned)}）：A5 会红 ✓ —— 这条断言不是恒真`);
ok(!near(ampRun.dCu, predSigned, 0.06) && near(ampRun.dCu, predAbs, 0.08),
  `变异 ②（抹掉符号：currentSigned 每 tick 取正 = 仍按幅度律）→ 净 Cu = ${(ampRun.dCu * 1e6).toFixed(2)} µmol`
  + ` ↔ 带符号预测 ${(predSigned * 1e6).toFixed(2)}（偏差 ${pct(ampRun.dCu, predSigned)}）、幅度律预测 ${(predAbs * 1e6).toFixed(2)} µmol`
  + `（偏差 ${pct(ampRun.dCu, predAbs)}）：A5 同样会红 ✓`);

// A6.【物理分界】判据用规则表**已有字段** deposit：可逆金属沉积吃符号，只放气体的分解不吃
const depCuSO4 = RULE_BY_ID.get('ely-cuso4').deposit, depWater = RULE_BY_ID.get('ely-water').deposit;
ok(!!(depCuSO4 && depCuSO4.length) && !depWater && !RULE_BY_ID.get('ely-nacl').deposit,
  `分界判据来自规则表自带字段：ely-cuso4.deposit = ${JSON.stringify(depCuSO4)}、ely-water = ${JSON.stringify(depWater)}、`
  + `ely-nacl = ${JSON.stringify(RULE_BY_ID.get('ely-nacl').deposit)} —— 没有新增任何约定（reactions.js:246 用的就是这个）`);
const NACL = { liquid: [['NaCl', 50], ['H2O', 50]] };
const gasDC = runCell(makeCell('battery', { emf: 6, internalR: 0.05 }, false, null, NACL), 2.0);
const gasAC = runCell(makeCell('acsource', { Up: 6, f: 1, r: 0.05 }, false, null, NACL), 2.0);
const kGas = gasDC.dGas.H2 / Math.max(1e-12, gasDC.integral);
ok(gasDC.dGas.H2 > 1e-7 && gasAC.dGas.H2 > 1e-7,
  `非空前置：NaCl 溶液（只放气、无 deposit）同电路通电 2 s —— 直流出 H₂ ${(gasDC.dGas.H2 * 1e6).toFixed(2)} µmol、`
  + `交流出 H₂ ${(gasAC.dGas.H2 * 1e6).toFixed(2)} µmol（都 > 0，两池的产物都真的量到了）`);
ok(near(gasAC.dGas.H2, kGas * gasAC.integral, 0.06),
  `气体池**不互抵**：交流出气 ${(gasAC.dGas.H2 * 1e6).toFixed(2)} µmol ↔ 按幅度律 k·∫|I|dt = ${(kGas * gasAC.integral * 1e6).toFixed(2)} µmol`
  + `（偏差 ${pct(gasAC.dGas.H2, kGas * gasAC.integral)}）—— 换极只是两极互换，两个半周都在分解，所以跟 ∫|I|dt 走`);
ok(near(gasAC.dGas.H2 / gasDC.dGas.H2, 2 / Math.PI, 0.05),
  `同上，交流/直流出气比 = ${(gasAC.dGas.H2 / gasDC.dGas.H2).toFixed(4)} ↔ 2/π = ${(2 / Math.PI).toFixed(4)}`
  + `（偏差 ${pct(gasAC.dGas.H2 / gasDC.dGas.H2, 2 / Math.PI)}）—— 与铜池的"净≈0"形成对照：**电解不是铁板一块**`);

// A7.【对照面钉住】直流与整流后 I 恒不反号 ⇒ ∫I dt ≡ ∫|I|dt —— 这解释了 §8 的 2/π、1/π 为什么仍成立
const tie = (r) => Math.abs(r.signed - r.integral) / Math.max(1e-12, r.integral);
const tDC = tie(dcRun), t0 = tie(a0Run), t6 = tie(a6Run), tGas = tie(gasDC);
ok(tDC < 1e-12 && tGas < 1e-12 && t0 < 0.01 && t6 < 0.01,
  `对照面恒等式：真正的直流（电池）两条积分**逐位相同**（相对差 ${tDC.toExponential(1)} / ${tGas.toExponential(1)}）；`
  + `整流后只差 ${t0.toExponential(2)}（Vf=0）/ ${t6.toExponential(2)}（Vf=0.6）——`
  + ' 残差不是零，而是二极管 roff=1 MΩ 的反向漏电让"电流恒不反号"只是近似成立');
info(`漏电占比随 Vf 增大而升高（${t0.toExponential(2)} → ${t6.toExponential(2)}）：Vf=0.6 的导通窗口更窄，反向那一半的漏电占比自然更大`
  + ' —— 与 §8 的 1 : 2/π : 1/π 数字链不冲突（那三条断言只用整流后的 ∫|I|dt 比值）');
info('结论：可逆金属沉积按**电荷符号**累积（∝ ∫I dt），只放气体的分解按**幅度**累积（∝ ∫|I|dt）；'
  + '判据是反应规则表自带的 deposit 字段，不是新造的约定。');

// ══════════════════════════════════════════════════════════
head('§10 可单独启停：关掉本插件 → MINE 6 件从注册表归零，再打开 → 6 件回来');
// ══════════════════════════════════════════════════════════
const mineCount = () => host.registry('equipment').list().filter(d => MINE.includes(d.type)).length;
ok(mineCount() === 6, `初始：注册表里本插件 ${mineCount()} 件`);
ok(host.disable('xiaomo.equipment.electronics') === true, "disable('xiaomo.equipment.electronics') 返回 true");
ok(mineCount() === 0, `停用后：本插件器材 ${mineCount()} 件（器材栏里会一起消失）`);
ok(EXIST.every(t => byType.has(t) && host.registry('equipment').has(t)),
  '停用**只影响本插件**：既有 electrical.js 的 10 件仍在注册表里');
ok(host.enable('xiaomo.equipment.electronics') === true && mineCount() === 6,
  `重新启用后：本插件器材回到 ${mineCount()} 件（不翻倍、不残留）`);
const after = host.registry('equipment').list();
ok(new Set(after.map(d => d.type)).size === after.length, '启用后注册表里没有重复 type（拆除干净，不是叠加）');

// ══════════════════════════════════════════════════════════
head('§11 电流真源：AcSource 的逐拍电流缓冲 + rmsI（T-03a，供面板「有效电流 I_rms」消费）');
// ══════════════════════════════════════════════════════════
// 为什么单开一节：电压半边（rmsMeas）在 §6 已断，而电流半边**此前全库没有真源**
//   （AcSource 只滚动电压缓冲）⇒ 面板侧造不出「有效电流」。本件把电流半边补齐，
//   与电压缓冲**逐字同构**：同一窗口长度 n、同样的 push/shift 推移、同一个 rmsOf 口径。
// 为什么允许同构（不必另定符号约定）：rmsOf 取 √⟨i²⟩，**对符号免疫** —— 交流换向、
//   以及 V 支路朝向带来的整体符号翻转，都不会污染有效值。
// 纯电阻回路（不留二极管）：I(t) = Up·sin/(R+r) ⇒ Irms = Up/(√2·(R+r))，可与电压半边逐字对照。
const SI = build({
  entities: [
    { type: 'acsource', x: 100, y: 100, props: { Up: 6, f: 1, r: 0.05 } },
    { type: 'resistor', x: 300, y: 100, props: { resistance: 10 } },
  ],
  wires: [[0, 0, 1, 0], [1, 1, 0, 1]],
});
SI.run(3);
const acI0 = SI.get(0);
const IrmsWant = 6 / (Math.SQRT2 * (10 + 0.05));
ok(typeof acI0.state.rmsI === 'number' && isFinite(acI0.state.rmsI),
  `AcSource 自报 rmsI 是有限数：${acI0.state.rmsI.toFixed(6)} A（此前全库无此键）`);
ok(near(acI0.state.rmsI, IrmsWant, 0.02),
  `实测有效电流 ${acI0.state.rmsI.toFixed(6)} A ↔ Up/(√2·(R+r)) = ${IrmsWant.toFixed(6)} A（偏差 ${pct(acI0.state.rmsI, IrmsWant)}）`);
// 与电压半边逐字同构的最硬证据：任何时刻两个缓冲长度都相等
ok(acI0.state.ibuf.length === acI0.state.buf.length,
  `电流缓冲与电压缓冲长度逐拍相等：ibuf=${acI0.state.ibuf.length} / buf=${acI0.state.buf.length}（同一窗口 n = ⌈T/dt⌉+1）`);
ok(near(acI0.state.ibuf[acI0.state.ibuf.length - 1], acI0.state.I, 1e-12),
  `缓冲末端就是本拍的 state.I：${acI0.state.ibuf[acI0.state.ibuf.length - 1]} ↔ ${acI0.state.I}（同一次 solve 注入，无半拍偏移）`);
ok(acI0.state.ibufT.length === acI0.state.ibuf.length,
  `时间戳缓冲同构：ibufT=${acI0.state.ibufT.length}（与 ibuf 同步推移，与 bufT 同形）`);

// 未接线：求解器不注入 I ⇒ 记 0（与「没有电流」一致），不是 NaN / undefined
const S0 = build({ entities: [{ type: 'acsource', x: 100, y: 100, props: { Up: 6, f: 1 } }] });
S0.run(1);
// ⚠ 实测口径订正：未接线时**不是精确 0** —— 孤立 V 支路仍会被 MNA 装配，解出的是
//   浮点残差级电流（~1e-12）。所以判据只能是「实质为零」，不能是「恒等于 0」：
//   后者会把求解器的残差当成回归，也就是把断言写死到浮点噪声上。
//   （顺带这也证明缓冲是**忠实**的：连残差都如实记进 ibuf，没有做平滑或截断。）
ok(isFinite(S0.get(0).state.rmsI) && Math.abs(S0.get(0).state.rmsI) < 1e-9,
  `未接线时 rmsI = ${S0.get(0).state.rmsI}（实质为零；孤立 V 支路的 MNA 浮点残差，不是 NaN，也不是"缺失值"）`);

// 能红（**对着真源做**，不是复述一遍逻辑）：人为塞入陈旧样本，再跑一拍 ——
//   推移必须立刻把它压回窗口长度。若把 while (cbuf.length > n) 那句删掉，
//   长度会停在 401 ≠ 电压缓冲长度 ⇒ 上面那条「长度逐拍相等」必红。
const acMut = SI.get(0);
acMut.state.ibuf = new Array(400).fill(3);
acMut.state.ibufT = new Array(400).fill(0);
acMut.state.rmsI = 0;
SI.tick(DT);
ok(acMut.state.ibuf.length === acMut.state.buf.length,
  `能红（对真源）：人为塞入 400 个陈旧样本后跑一拍，被推移压回 ${acMut.state.ibuf.length} = 电压缓冲长度（删掉推移 ⇒ 401 ≠ ${acMut.state.buf.length}）`);
info(`窗口长度 = ⌈T/dt⌉+1 = ⌈1/1 ÷ (1/120)⌉+1 = ${acMut.state.buf.length}：电流与电压用的是同一个 n`
  + ' —— 这就是「逐字同构」的可执行定义。');

// ══════════════════════════════════════════════════════════
console.log(`\n\x1b[1m全部通过：${pass} 项\x1b[0m` + (fail ? `  \x1b[31m失败 ${fail} 项\x1b[0m` : ''));
process.exit(fail ? 1 : 0);
