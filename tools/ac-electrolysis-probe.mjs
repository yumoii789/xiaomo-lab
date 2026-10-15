// ══════════════════════════════════════════════════════════
// 无头验证：交流电通入电解池 —— 净产物应当 ≈ 0（电荷按符号累积、半周互抵）
//
//   node tools/ac-electrolysis-probe.mjs
//
// 这份测试盯一条**物理红线**：对称交流的净电荷为零，净产物也必须 ≈ 0；
// 而电荷单向的直流/整流电，产量照旧 ∝ 通过的电荷量。三条对照面都在这里：
//   ① 直流 6 V：Cu 单调沉积，定标出本模型的法拉第系数 mol/(A·s)
//   ② 对称交流 Up=6 V：∫I dt ≈ 0 ⇒ 净产物 ≈ 0（过去这里是 2/π 倍直流，是错的）
//   ③ 整流（经二极管 Vf=0 / Vf=0.6）：平均值决定产量（1/π 与解析 ⟨U⟩/Up）
//
// 与 tools/equipment-electronics.mjs §8/§9 的关系：那份量到的是**改之前**的负结论
// （负值样本 0 个、Cu 单调递增），本文件是同一套场景在**改之后**的解析解断言。
// ══════════════════════════════════════════════════════════

import { World } from '../src/core/world.js';
import { PluginHost } from '../src/core/plugin.js';
import { create, bindRegistry } from '../src/equipment/registry.js';
import { CouplingBus } from '../src/coupling/bridge.js';
import { solveCircuit } from '../src/physics/circuit.js';

import physicsPlugin from '../src/physics/circuit.js';
import chemistryPlugin from '../src/chemistry/reactions.js';
import bridgePlugin from '../src/coupling/bridge.js';
import electricalPlugin from '../src/equipment/electrical.js';
import glasswarePlugin from '../src/equipment/glassware.js';
import labPlugin from '../src/equipment/lab.js';
import electronicsPlugin, * as E from '../src/equipment/electronics.js';

// ── 无头宿主（与 equipment-electronics.mjs 同一条引导路径） ──
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

const DT = 1 / 120;

/** 场景装配：造支路 → 解电路 → 分发耦合量 → 世界步进 */
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
  };
}

// ══════════════════════════════════════════════════════════
head('§0 场景：石墨电极 + 100 Ω 限流电阻 + 50 mL 1 mol/L CuSO₄（与 electronics §8 同一套）');
// ══════════════════════════════════════════════════════════
const R_SERIES = 100;
const makeCell = (srcType, srcProps, withDiode, diodeProps) => {
  const sc = {
    entities: [
      { type: srcType, x: 100, y: 100, props: srcProps },
      { type: 'beaker', x: 400, y: 300, props: { capacity: 250 }, fill: { liquid: [['CuSO4', 50], ['H2O', 50]] } },
      { type: 'electrode', x: 394, y: 300, props: { metal: 'graphite' } },
      { type: 'electrode', x: 406, y: 300, props: { metal: 'graphite' } },
      { type: 'resistor', x: 250, y: 220, props: { resistance: R_SERIES } },
    ],
    wires: [],
  };
  if (withDiode) sc.entities.push({ type: 'diode', x: 250, y: 100, props: diodeProps });
  const sim = build(sc);
  const src = sim.get(0), eA = sim.get(2), eB = sim.get(3), RS = sim.get(4);
  const link = (a, ap, b, bp) => sim.world.connect({ e: a.id, p: ap }, { e: b.id, p: bp }, 'wire');
  if (withDiode) {
    const d = sim.get(5);
    link(src, 0, d, 0); link(d, 1, RS, 0);
  } else {
    link(src, 0, RS, 0);
  }
  link(RS, 1, eA, 0);
  link(eB, 0, src, 1);
  return sim;
};
const vOf = (sim) => sim.get(1).vessel;

/**
 * 跑一段，累积三个量：
 *   iAbs = ∫|I|dt（单向电荷量，直流量产出的标尺）
 *   iNet = ∫I dt （净电荷量，对称交流应当 ≈ 0 —— 这就是「半周互抵」的判据）
 *   dCu  = Cu 的净变化（真实化学产量）
 */
function runCell(sim, sec, marks) {
  const v = vOf(sim);
  const key = 'sol:' + sim.get(1).id;
  let iAbs = 0, iNet = 0, signSeen = 0;
  const series = [];
  const cu0 = v.amount('Cu');
  for (let i = 0, n = Math.round(sec / DT); i < n; i++) {
    sim.tick(DT, (c) => {
      const rec = c.branches.get(key);
      if (rec) { iAbs += Math.abs(rec.I) * DT; iNet += rec.I * DT; }
      if (rec && rec.I < -0.004) signSeen++;
      series.push({ t: sim.world.time, I: rec ? rec.I : 0, vI: v.electricCurrent });
    });
    if (marks && marks.some(m => Math.abs(sim.world.time - m) < DT / 2)) {
      series.push({ mark: sim.world.time, cu: v.amount('Cu') - cu0 });
    }
  }
  return { iAbs, iNet, signSeen, dCu: v.amount('Cu') - cu0, series };
}

const DC = makeCell('battery', { emf: 6, internalR: 0.05 }, false);
const dc = runCell(DC, 2.0);
info(`直流 6 V：∫|I|dt = ${dc.iAbs.toFixed(6)} A·s，∫I dt = ${dc.iNet.toFixed(6)} A·s，`
  + `沉积 Cu = ${dc.dCu.toExponential(4)} mol`);
ok(dc.dCu > 1e-5, `直流确实电解出铜：Δn(Cu) = ${dc.dCu.toExponential(4)} mol`);
const faraday = dc.dCu / dc.iAbs;      // mol per (A·s)：本模型的法拉第系数
ok(near(dc.iNet, dc.iAbs, 0.01), `直流是单向电荷：∫I dt = ${dc.iNet.toFixed(6)} ↔ ∫|I|dt = ${dc.iAbs.toFixed(6)} A·s`);
// 对表点（与 k1 的求解器契约）：本接线下 battery 驱动 sol: 支路的电流为**正**。
// 谁改了求解器对 sol: 支路电流的符号约定，这一条会与「净产物 ≈ 0」「Cu 不再单调」同时红。
ok(dc.iNet > 0, `符号约定钉住：battery 驱动 sol: 支路电流为正（∫I dt = +${dc.iNet.toFixed(6)} A·s）`);
info(`定标：Δn(Cu)/∫|I|dt = ${faraday.toExponential(4)} mol/(A·s)`);

const AC = makeCell('acsource', { Up: 6, f: 1, r: 0.05 }, false);
const ac = runCell(AC, 2.0, [0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0]);
const acMarks = ac.series.filter(s => s.mark !== undefined).map(m => m.cu);
let minI = Infinity, maxI = -Infinity, minV = Infinity, maxV = -Infinity, negV = 0;
for (const s of ac.series) {
  if (s.I === undefined) continue;
  minI = Math.min(minI, s.I); maxI = Math.max(maxI, s.I);
  minV = Math.min(minV, s.vI); maxV = Math.max(maxV, s.vI);
  if (s.vI < 0) negV++;
}
info(`真电流 rec.I：min ${minI.toFixed(4)} / max ${maxI.toFixed(4)} A，负向样本 ${ac.signSeen} 帧`);
info(`容器 electricCurrent：min ${minV.toFixed(4)} / max ${maxV.toFixed(4)} A，负值样本 ${negV} / ${ac.series.length}`);
info(`交流 ∫|I|dt = ${ac.iAbs.toFixed(6)} A·s，∫I dt = ${ac.iNet.toExponential(3)} A·s，净沉积 Cu = ${ac.dCu.toExponential(4)} mol`);
info(`Cu 轨迹（每 1/4 周期）：${acMarks.map(m => (m * 1e6).toFixed(1)).join(' → ')} µmol`);

// ── ① 驱动本身必须是对称的：净电荷 ≈ 0 ──
ok(maxI > 0.02 && minI < -0.02 && near(-minI, maxI, 0.03),
  `溶液支路真电流正负对称：min ${minI.toFixed(4)} / max ${maxI.toFixed(4)} A（偏差 ${pct(-minI, maxI)}）`);
ok(Math.abs(ac.iNet) <= 0.02 * ac.iAbs,
  `一个周期里净电荷 ≈ 0：∫I dt = ${ac.iNet.toExponential(3)} A·s ↔ ∫|I|dt = ${ac.iAbs.toFixed(6)} A·s`
  + `（比值 ${(ac.iNet / ac.iAbs).toExponential(2)}，判据 |∫I| ≤ 2% ∫|I|）`);

// ── ② 物理红线：净产物 ≈ 0（判据：≤ 直流的 2%） ──
const TOL = 0.02;
ok(Math.abs(ac.dCu) <= TOL * dc.dCu,
  `对称交流净产物 ≈ 0：Δn(Cu) = ${(ac.dCu * 1e6).toFixed(2)} µmol`
  + ` ↔ 直流 ${(dc.dCu * 1e6).toFixed(2)} µmol（判据 |Δn| ≤ ${TOL * 100}% 直流，实测 ${pct(ac.dCu, dc.dCu)}）`);
// 反面对照：过去这里等于 faraday·∫|I|dt（把交流当直流按 2/π 折算），这条必须**不成立**
ok(!near(ac.dCu, faraday * ac.iAbs, 0.06),
  `且不再等于「按 ∫|I|dt 折算的产量」：折算值 ${(faraday * ac.iAbs * 1e6).toFixed(2)} µmol`
  + `（旧模型就是 2/π 那一条，偏差 ${pct(ac.dCu, faraday * ac.iAbs)}）`);

// ── ③ 半周互抵：Cu 不应单调 ──
let mono = true;
for (let i = 1; i < acMarks.length; i++) if (!(acMarks[i] > acMarks[i - 1])) mono = false;
ok(!mono && acMarks.length >= 8,
  `Cu 不再单调沉积（${acMarks.map(m => (m * 1e6).toFixed(1)).join(' → ')} µmol）→ 反向半周确实把产物溶回去了`);

// ── ④ 整流后：单向电荷，产量仍 ∝ ∫|I|dt（本修复的对照面，必须不变） ──
const AC0 = makeCell('acsource', { Up: 6, f: 1, r: 0.05 }, true, { vf: 0, ron: 0.5, roff: 1, dir: 'fwd' });
const a0 = runCell(AC0, 2.0);
ok(near(a0.iAbs / dc.iAbs, 1 / Math.PI, 0.03),
  `整流(Vf=0)：∫|I|dt 比 = ${(a0.iAbs / dc.iAbs).toFixed(4)} ↔ 1/π = ${(1 / Math.PI).toFixed(4)}（偏差 ${pct(a0.iAbs / dc.iAbs, 1 / Math.PI)}）`);
ok(near(a0.dCu, faraday * a0.iAbs, 0.08),
  `整流(Vf=0) 产量仍 ∝ 通过的电荷量：预测 ${(faraday * a0.iAbs * 1e6).toFixed(2)} ↔ 实测 ${(a0.dCu * 1e6).toFixed(2)} µmol`
  + `（偏差 ${pct(a0.dCu, faraday * a0.iAbs)}）`);
ok(a0.dCu > 0 && a0.dCu > Math.abs(ac.dCu) * 100,
  `D37 见证（同池同电解质，电荷单向时净产物确实 ≠ 0）：整流 ${(a0.dCu * 1e6).toFixed(2)} µmol`
  + ` 是交流净产物 ${(Math.abs(ac.dCu) * 1e6).toFixed(2)} µmol 的 ${(a0.dCu / Math.abs(ac.dCu)).toFixed(0)} 倍`
  + ` → 「≈ 0」不是「量不出」`);

const AC6 = makeCell('acsource', { Up: 6, f: 1, r: 0.05 }, true, { vf: 0.6, ron: 0.5, roff: 1, dir: 'fwd' });
const a6 = runCell(AC6, 2.0);
const theory6 = E.halfWaveMean(6, 0.6) / 6;
ok(near(a6.iAbs / dc.iAbs, theory6, 0.03),
  `整流(Vf=0.6)：∫|I|dt 比 = ${(a6.iAbs / dc.iAbs).toFixed(4)} ↔ 解析 ⟨U⟩/Up = ${theory6.toFixed(4)}（偏差 ${pct(a6.iAbs / dc.iAbs, theory6)}）`);
ok(near(a6.dCu, faraday * a6.iAbs, 0.08),
  `整流(Vf=0.6) 产量仍 ∝ 通过的电荷量：预测 ${(faraday * a6.iAbs * 1e6).toFixed(2)} ↔ 实测 ${(a6.dCu * 1e6).toFixed(2)} µmol`);

// ══════════════════════════════════════════════════════════
head('§1 符号只由电荷定，与器材种类无关：把交流换成直流，产量立刻回来');
// ══════════════════════════════════════════════════════════
{
  // 同一只烧杯、同一套电极，只换电源：电量方向变了，化学就该跟着变
  const DC2 = makeCell('battery', { emf: 6, internalR: 0.05 }, false);
  const v = vOf(DC2);
  const cu0 = v.amount('Cu');
  DC2.run(2.0);
  const d2 = v.amount('Cu') - cu0;
  ok(near(d2, dc.dCu, 0.02), `两只独立的直流池沉积量一致：${(d2 * 1e6).toFixed(1)} ↔ ${(dc.dCu * 1e6).toFixed(1)} µmol`);
  const o2 = v.gas.get('O2') || 0, h2so4 = v.amount('H2SO4');
  ok(o2 > 1e-6 && h2so4 > 1e-6, `阳极出氧气 ${(o2 * 24000).toFixed(2)} mL、溶液变酸（H₂SO₄ ${(h2so4 * 1e3).toFixed(3)} mmol）`);
}

// ══════════════════════════════════════════════════════════
head('§2 契约字段 currentSigned：新容器有声明 / 总线逐帧写 / 旧容器退回旧行为');
// ══════════════════════════════════════════════════════════
{
  const fresh = create('beaker', 10, 10);
  const fv = fresh && fresh.vessel;
  ok(!!fv && 'currentSigned' in fv && fv.currentSigned === 0,
    `新容器有声明（与 electricCurrent 对称）：'currentSigned' in vessel = ${!!fv && ('currentSigned' in fv)}，初值 ${fv ? fv.currentSigned : 'n/a'}`);

  const C = makeCell('acsource', { Up: 6, f: 1, r: 0.05 }, false);
  const cv = vOf(C);
  const ckey = 'sol:' + C.get(1).id;
  let maxDiff = 0, sawNeg = 0, frames = 0;
  C.run(0.6, (c) => {
    const rec = c.branches.get(ckey);
    if (!rec || typeof cv.currentSigned !== 'number') return;
    frames++;
    maxDiff = Math.max(maxDiff, Math.abs(cv.currentSigned - rec.I));
    if (cv.currentSigned < 0) sawNeg++;
  });
  ok(frames > 0 && maxDiff < 1e-12 && sawNeg > 0,
    `耦合层逐帧写且带符号：${frames} 帧里 currentSigned 与支路真电流最大差 ${maxDiff.toExponential(2)} A，负向 ${sawNeg} 帧`);

  // 旧容器 = 只有幅度字段（没有 currentSigned）：必须逐位退回**改动前**的行为（恒正向 → 净产物 = 2/π 折算）
  const OLD = makeCell('acsource', { Up: 6, f: 1, r: 0.05 }, false);
  const ov = vOf(OLD);
  const oc0 = ov.amount('Cu');
  OLD.run(2.0, () => { delete ov.currentSigned; });
  const oldCu = ov.amount('Cu') - oc0;
  ok(near(oldCu, faraday * ac.iAbs, 0.06) && Math.abs(oldCu) > 100 * Math.abs(ac.dCu),
    `旧容器退回旧行为（两向证明）：删掉字段后同一交流池净沉积 ${(oldCu * 1e6).toFixed(2)} µmol`
    + ` ↔ 2/π 折算 ${(faraday * ac.iAbs * 1e6).toFixed(2)} µmol，是新行为的 ${(Math.abs(oldCu / ac.dCu)).toFixed(0)} 倍`);
}

console.log(`\n${fail === 0 ? '\x1b[32m' : '\x1b[31m'}全部通过：${pass} 项${fail ? `，失败 ${fail} 项` : ''}\x1b[0m`);
process.exit(fail === 0 ? 0 : 1);
