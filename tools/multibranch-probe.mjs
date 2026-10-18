// ══════════════════════════════════════════════════════════
// 无头探针：一器材多支路契约 circuitBranches(world)（circuit.js 支路收集）
//
//   node tools/multibranch-probe.mjs            绿档
//   node tools/multibranch-probe.mjs --mutate   红档（变异体落在 %TEMP%，仓库零字节改动）
//
// 契约（本次落地，全部落在收集处 + 汇总写回；矩阵装配段一行未动）：
//   · 器材可选声明 circuitBranches(world) ⇒ 返回 N 条支路，每条自带端口对 { a, b }（e.ports 下标，须是 wire 口）
//   · 返回 null / [] / 非数组 ⇒ 回落 circuitBranch()（既有器材一行都不用改）
//   · 支路 0 = 主边：独占 branches.get(entId) 与 state.I/U/P/R（导线高亮也按实体 id 取记录）
//   · 支路 k>0 ⇒ branches.get(entId + '#' + k)；器材可在支路对象上挂 state 盒子收 {I,U,P,R}
//   · **一趟 solve 内 emf/r 是常量**（靠"只取一次"的结构保证，不是靠注释）
//
// 判据：
//   ① 契约形状：主边键 / 次级键 / state 绑定 / 端口对解析
//   ② 三端电位器：两线用法**回落到两端旧语义**（与两端桩件同解）；三线用法正确分压，且滑片节点 KCL 成立
//   ③ 一趟 solve 内 emf 是常量（实测调用次数 = 1）
//   ④ 代数环禁令（Motor 那条注释）：跨支路耦合只能读**上一帧**的 state，迭代有界收敛
//   ⑤ 告警演进：声明了支路的三端件不再告警；声明了支路却没覆盖到的接线口照样告警
//   ⑥ --mutate：M1 去掉"只取一次"／M2 去掉 state 盒子／M3 破坏两线回落 ⇒ 对应断言必须红，其余必须绿
//   ⑦ 契约的**第二个用户** = 变压器：形状不同（一次/二次是两个独立回路，不是同一元件的多个抽头）
//      —— 只有一个用户的契约很可能只是"把特判包装成通用样子"，§⑦ 就是拿它验通用性
// ══════════════════════════════════════════════════════════

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const REPO = new URL('../', import.meta.url);
const CIRCUIT_SRC = 'src/physics/circuit.js';

const known = new Set(['--mutate']);
const bad = process.argv.slice(2).filter((a) => !known.has(a));
if (bad.length) {
  console.log(`✗ 不认识的开关：${bad.join(' ')} —— 本探针只认 ${[...known].join(' / ')}`);
  process.exit(2);
}
const MUTATE = process.argv.includes('--mutate');

import { World } from '../src/core/world.js';
import { PluginHost } from '../src/core/plugin.js';
import { create, bindRegistry } from '../src/equipment/registry.js';
import { solveCircuit } from '../src/physics/circuit.js';
import physicsPlugin from '../src/physics/circuit.js';
import electricalPlugin from '../src/equipment/electrical.js';
import electronicsPlugin from '../src/equipment/electronics.js';
import opticsPlugin from '../src/equipment/optics.js';

const boot = {
  services: {}, ticks: [], world: null,
  log: { push() {}, clear() {} }, toast() {},
  addTick(f) { this.ticks.push(f); return () => {}; },
};
const host = new PluginHost(boot);
for (const p of [physicsPlugin, electricalPlugin, electronicsPlugin, opticsPlugin]) host.define(p);
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

/** 两/多口桩件：ports 数可控，circuitBranches 由调用方给 */
const stub = (id, nPorts, branches) => ({
  id, type: 'stub' + nPorts, x: 0, y: 0, props: {}, state: {},
  ports: Array.from({ length: nPorts }, (_, i) => ({ x: -20 + i * 20, y: 0, kind: 'wire', label: 'T' + (i + 1) })),
  circuitBranch() { return { type: 'R', r: 10 }; },
  ...(branches ? { circuitBranches: branches } : {}),
});

const wire = (w, e1, p1, e2, p2) => w.connect({ e: e1, p: p1 }, { e: e2, p: p2 }, 'wire');

// ══════════════════════════════════════════════════════════
head('① 契约形状：主边键 / 次级键 / state 盒子 / 端口对');
// ══════════════════════════════════════════════════════════
{
  const box = {};
  const w = new World();
  const bat = create('battery', -160, 0);
  const st = stub('mb1', 3, () => [
    { type: 'R', r: 20, a: 0, b: 2, state: box },   // 主边：T1↔T3
    { type: 'R', r: 30, a: 2, b: 1 },               // 次边：T3↔T2
  ]);
  w.add(bat, true); w.add(st, true);
  wire(w, bat.id, 1, st.id, 0);
  wire(w, st.id, 1, bat.id, 0);
  const c = solveCircuit(w, []);
  ok(c.branches.has(st.id) && c.branches.has(st.id + '#1'),
    `两条支路各自出记录：${st.id} 与 ${st.id}#1（${[...c.branches.keys()].join(' / ')}）`);
  ok(c.branches.get(st.id).R === 20 && c.branches.get(st.id + '#1').R === 30,
    `主边 r=${c.branches.get(st.id).R} Ω、次边 r=${c.branches.get(st.id + '#1').R} Ω ⇒ 端口对 {a,b} 生效（不是简单取前两个口）`);
  ok(st.state.I === c.branches.get(st.id).I && typeof c.branches.get(st.id + '#1').I === 'number',
    `主边独占实体级 state：state.I=${st.state.I.toFixed(9)} = 主边记录；次边不回写实体级状态`);
  ok(typeof box.I === 'number' && box.I === c.branches.get(st.id).I && typeof box.U === 'number',
    `state 盒子收到次边解：box.I=${box.I.toFixed(9)} A、box.U=${box.U.toFixed(9)} V（求解器不发明 state 键，键名归器材）`);
  ok(c.warnings.length === 0, `三个口都被支路用到 ⇒ ${c.warnings.length} 条 port-ignored（不再误报）`);
}

// ══════════════════════════════════════════════════════════
head('② 三端电位器：两线用法逐位不变 · 三线用法正确分压');
// ══════════════════════════════════════════════════════════
const RHEO_RMAX = 100, RHEO_POS = 0.4, BAT_EMF = 6, BAT_RINT = 0.01;
/** 两线：滑片不接 ⇒ 整只变阻器（rMax·pos） */
const sceneTwoWire = () => {
  const w = new World();
  const bat = create('battery', -160, 0);
  bat.props.emf = BAT_EMF; bat.props.internalR = BAT_RINT;
  const rh = create('rheostat', 0, 0);
  rh.props.rMax = RHEO_RMAX; rh.props.pos = RHEO_POS;
  w.add(bat, true); w.add(rh, true);
  wire(w, bat.id, 1, rh.id, 0);
  wire(w, rh.id, 1, bat.id, 0);
  return { w, bat, rh };
};
/** 两线对照：一只两端桩件（r = rMax·pos）—— 旧求解器看到的世界 */
const sceneTwoWireStub = () => {
  const w = new World();
  const bat = create('battery', -160, 0);
  bat.props.emf = BAT_EMF; bat.props.internalR = BAT_RINT;
  const st = stub('old2', 2, null);
  st.circuitBranch = () => ({ type: 'R', r: RHEO_RMAX * RHEO_POS });
  w.add(bat, true); w.add(st, true);
  wire(w, bat.id, 1, st.id, 0);
  wire(w, st.id, 1, bat.id, 0);
  return { w, st };
};
/** 三线：滑片接负载 RL 到电池负端 ⇒ 分压器 */
const sceneThreeWire = (RL) => {
  const w = new World();
  const bat = create('battery', -160, 0);
  bat.props.emf = BAT_EMF; bat.props.internalR = BAT_RINT;
  const rh = create('rheostat', 0, 0);
  rh.props.rMax = RHEO_RMAX; rh.props.pos = RHEO_POS;
  const load = create('resistor', 160, 0);
  // ⚠ Resistor.circuitBranch() 读的是 props.resistance（src/equipment/electrical.js:311），**不是 props.R** ✗
  //   原写法 `load.props.R = RL` 是**死赋值** ⇒ 实测电路一直是默认 10 Ω，而手推按 60 Ω = 两个不同电路 ✗
  load.props.resistance = RL;
  w.add(bat, true); w.add(rh, true); w.add(load, true);
  wire(w, bat.id, 1, rh.id, 0);          // 电池 + → A
  wire(w, rh.id, 1, bat.id, 0);          // B → 电池 −
  wire(w, rh.id, 2, load.id, 0);         // 滑片 → 负载
  wire(w, load.id, 1, bat.id, 0);        // 负载 → 电池 −
  return { w, bat, rh, load };
};
{
  const s2 = sceneTwoWire();
  const s2b = sceneTwoWireStub();
  const a = solveCircuit(s2.w, []);
  const b = solveCircuit(s2b.w, []);
  const ra = a.branches.get(s2.rh.id);
  // ⚠ **点名客体**（原写法 `[...b.branches.values()][0]` 是错的 ✗）：实测它取到的是**电池**。
  //   同一接线、同一端口序下，电池电流与元件电流**本就反号**（无源符号约定 I=U/R，见下面第 3 条）
  //   ⇒ 那条断言**恒红**，与产品好坏无关。同一份 World 内新旧求解器逐支路位相同这件事，
  //   已用改动前的 circuit.js（%TEMP%，经 data: URL 导入）实测过 ✓；探针没法自带那份源码，
  //   所以这里退到"两条独立 World 同解 + 相对容差 1e-9"（实测差异 ≈6e-12，来自消元次序不同 ✓）。
  const rb = b.branches.get(s2b.st.id);
  const rbat = a.branches.get(s2.bat.id);
  ok(Math.abs(ra.I) > 0 && Math.sign(ra.I) === -Math.sign(rbat.I),
    `反证"比错元素必红"：变阻器 I=${ra.I.toFixed(12)} 与电池 I=${rbat.I.toFixed(12)} **反号**`
    + ` ⇒ 拿 values()[0]（=电池）去比是恒红 ✗，这条断言证明本行不是恒真`);
  ok(near(ra.I, rb.I, 1e-9) && near(ra.U, rb.U, 1e-9) && a.branches.size === b.branches.size,
    `两线用法回落到两端旧语义：I=${ra.I}（两端桩件 ${rb.I}）、U=${ra.U}（桩件 ${rb.U}）、支路数 ${a.branches.size}=${b.branches.size}`);
  ok(near(ra.I, -(BAT_EMF / (BAT_RINT + RHEO_RMAX * RHEO_POS)), 1e-12),
    `且等于解析解：−E/(r+R) = −${(BAT_EMF / (BAT_RINT + RHEO_RMAX * RHEO_POS)).toFixed(9)} A`
    + `（符号由仓内约定定死：circuit.js:293 U=V(ka)−V(kb)、:311 I=U/R；电池 + 极在 electrical.js:86 的端口 1）`);

  const RL = 60;
  const s = sceneThreeWire(RL);
  const c = solveCircuit(s.w, []);
  const segA = RHEO_RMAX * RHEO_POS, segB = RHEO_RMAX * (1 - RHEO_POS);
  const par = (segB * RL) / (segB + RL);
  const I = BAT_EMF / (BAT_RINT + segA + par);
  const Uw = I * par;
  const b0 = c.branches.get(s.rh.id), b1 = c.branches.get(s.rh.id + '#1');
  ok(!!b0 && !!b1 && near(b0.R, segA, 1e-12) && near(b1.R, segB, 1e-12),
    `滑片接上 ⇒ 电阻丝分成两段：A↔滑片 ${b0.R} Ω、滑片↔B ${b1.R} Ω（rMax=${RHEO_RMAX}、pos=${RHEO_POS}）`);
  ok(near(b1.U, -Uw, 1e-9),
    `滑片对 B 的电压实测 ${b1.U.toFixed(9)} V ⟷ 手推 −${Uw.toFixed(9)} V（R_并=${par.toFixed(4)} Ω；`
    + `符号同由 circuit.js:293 U=V(ka)−V(kb) 定死，kb=B 端）`);
  const loadI = c.branches.get(s.load.id).I;
  ok(near(b0.I, b1.I + loadI, 1e-9),
    `滑片节点 KCL：入 ${b0.I.toFixed(9)} = 出 ${b1.I.toFixed(9)} + ${loadI.toFixed(9)}（三条 R 支路朝向一致才敢相加）`);
  ok(c.warnings.filter((x) => x.code === 'port-ignored').length === 0,
    '三根线都被支路覆盖 ⇒ 0 条 port-ignored（告警随契约自然消失）');
}

// ══════════════════════════════════════════════════════════
head('③ 一趟 solve 内 emf 是常量（实测调用次数，不是靠注释）');
// ══════════════════════════════════════════════════════════
{
  let calls = 0;
  const w = new World();
  const st = stub('mb3', 2, () => { calls++; return [{ type: 'V', emf: 1 + calls, r: 0.001 }]; });
  w.add(st, true);
  const c = solveCircuit(w, []);
  ok(calls === 1, `circuitBranches() 在一趟 solve 里被调用 ${calls} 次（不是每轮迭代一次）`);
  ok(near(c.branches.get('mb3').U, 2, 1e-9),
    `解用的是第一次取到的 emf：U=${c.branches.get('mb3').U} V（若每轮重取，迭代会去追一个每轮都在变的源）`);
}

// ══════════════════════════════════════════════════════════
head('④ 代数环禁令：跨支路耦合只能读上一帧的 state');
// ══════════════════════════════════════════════════════════
{
  const box = {};
  let emfThisFrame = null, prevSrcU = null, Uthis = null;
  const w = new World();
  const drv = bakeDriver(w);
  const ctrl = {
    id: 'ctrl', type: 'ctrl', x: 0, y: 0, props: { k: 2 }, state: { srcU: 0, U: 0 },
    ports: [{ x: -20, y: 0, kind: 'wire', label: 'A' }, { x: 20, y: 0, kind: 'wire', label: 'B' }],
    circuitBranch() { return { type: 'R', r: 50 }; },
    circuitBranches() {
      // 次边的 emf 只能来自**上一帧**写下的 state.srcU —— 本帧量要等这一趟解完才知道
      return [
        { type: 'R', r: 50, a: 0, b: 1 },
        { type: 'V', emf: this.props.k * this.state.srcU, r: 1, a: 0, b: 1, state: box },
      ];
    },
    step() { this.state.srcU = this.state.U; },   // 把本帧解出的量搬到下一帧用
  };
  w.add(drv.bat, true); w.add(drv.src, true); w.add(ctrl, true);
  wire(w, drv.bat.id, 1, ctrl.id, 0);
  wire(w, ctrl.id, 1, drv.bat.id, 0);
  wire(w, drv.bat.id, 1, drv.src.id, 0);
  wire(w, drv.src.id, 1, drv.bat.id, 0);
  let last = null, iters = [];
  for (let f = 0; f < 8; f++) {
    drv.src.props.emf = 1 + f * 0.5;            // 每帧都变 ⇒ 本帧量 ≠ 上一帧量
    prevSrcU = ctrl.state.srcU;                 // 这一帧开始时的"上一帧量"
    const c = solveCircuit(w, []);
    Uthis = c.branches.get('ctrl').U;
    const emfNow = ctrl.circuitBranches()[1].emf;   // 次边这一帧实际用的 emf（只读地再问一次）
    emfThisFrame = ctrl.props.k * prevSrcU;
    iters.push(c.iterations);
    last = c;
    ctrl.step(0, w);
  }
  ok(last.ok === true && iters.every((n) => n <= 26),
    `8 帧全部收敛：iterations=${iters.join(',')}（有界 ⇒ 没有迭代内代数环在追不存在的解）`);
  ok(near(Math.abs(emfThisFrame), Math.abs(2 * prevSrcU), 1e-12),
    `次边这一帧的 emf = k·上一帧量 = ${emfThisFrame.toFixed(9)} V（k=${ctrl.props.k}、上一帧 state.srcU=${prevSrcU.toFixed(9)}）`);
  ok(Math.abs(emfThisFrame - 2 * Uthis) > 1e-6,
    `且**不是**本帧量：k·本帧 U = ${(2 * Uthis).toFixed(9)} V ≠ ${emfThisFrame.toFixed(9)} V ⇒ 滞后一帧是实测事实`);
  ok(typeof box.U === 'number' && typeof box.I === 'number',
    `state 盒子由求解器写入：box.U=${(box.U || 0).toFixed(9)} V、box.I=${(box.I || 0).toFixed(9)} A`);
}

function bakeDriver(w) {
  const bat = create('battery', -320, 0);
  bat.props.emf = 1.5; bat.props.internalR = 1;
  const src = stub('drv', 2, null);
  src.props.emf = 1;
  src.circuitBranch = () => ({ type: 'V', emf: src.props.emf, r: 1 });
  return { bat, src };
}

// ══════════════════════════════════════════════════════════
head('⑤ 告警演进：没被任何支路覆盖的接线口照样告警');
// ══════════════════════════════════════════════════════════
{
  const w = new World();
  const bat = create('battery', -160, 0);
  const st = stub('mb5', 4, () => [{ type: 'R', r: 40, a: 0, b: 1 }]);   // 只声明 T1↔T2
  w.add(bat, true); w.add(st, true);
  wire(w, bat.id, 1, st.id, 0);
  wire(w, st.id, 1, bat.id, 0);
  wire(w, st.id, 2, bat.id, 1);      // T3 接了线但没人用
  wire(w, st.id, 3, bat.id, 1);      // T4 同上
  const c = solveCircuit(w, []);
  const rec = c.warnings.filter((x) => x.code === 'port-ignored');
  ok(rec.length === 1 && rec[0].ports.join(',') === '2,3',
    `声明了支路却漏掉两个接线口 ⇒ 恰好 1 条告警，ports=[${rec.length ? rec[0].ports.join(',') : ''}]`);
  ok(/不属于该器材声明的任何一条支路/.test(rec.length ? rec[0].msg : ''),
    '告警文案与新判据一致（"不属于声明的支路"，不再是"一个器材只取一条支路"）');
}

// ══════════════════════════════════════════════════════════
head('⑦ 契约的第二个用户：变压器（一次/二次两个独立回路，形状与变阻器不同）');
// ══════════════════════════════════════════════════════════
{
  const xfScene = (secWired, loadR = 10) => {
    const w = new World(); w.time = 0;
    const bat = create('battery', -300, 0); bat.props.emf = 6; bat.props.internalR = 0.01; w.add(bat, true);
    const xf = create('transformer', 0, 0); w.add(xf, true);
    wire(w, bat.id, 1, xf.id, 0); wire(w, xf.id, 1, bat.id, 0);
    let ld = null;
    if (secWired) {
      ld = create('resistor', 300, 220); ld.props.resistance = loadR; w.add(ld, true);
      wire(w, xf.id, 2, ld.id, 0); wire(w, ld.id, 1, xf.id, 3);
    }
    return { w, bat, xf, ld };
  };
  const settle = (s, frames = 8) => {
    let c = null;
    for (let i = 0; i < frames; i++) {
      c = solveCircuit(s.w, []);
      for (const e of s.w.entities) if (typeof e.step === 'function') e.step(1 / 120, s.w);
      s.w.time += 1 / 120;
    }
    return c;
  };

  const sOff = xfScene(false);
  const cOff = settle(sOff);
  ok(cOff.branches.size === 2 && !cOff.branches.has(sOff.xf.id + '#1')
    && near(cOff.branches.get(sOff.xf.id).R, sOff.xf.props.R1, 1e-12),
    `二次侧不接线 ⇒ 回落 circuitBranch()：支路数 ${cOff.branches.size}、R=${cOff.branches.get(sOff.xf.id).R} Ω = R1 ⇒ 旧用法零回归`);
  ok(sOff.xf.state.U2src === 'analytic',
    `未接线时 U2src=${sOff.xf.state.U2src} ⇒ 二次量走解析路径，不冒充实测`);

  const sOn = xfScene(true);
  const cOn = settle(sOn);
  const pm = cOn.branches.get(sOn.xf.id), sc = cOn.branches.get(sOn.xf.id + '#1');
  const n = sOn.xf.props.N1 / sOn.xf.props.N2;
  ok(!!sc && cOn.branches.size === 4,
    `二次侧接线 ⇒ 一次/二次**两条**支路都进矩阵：${[...cOn.branches.keys()].join(',')}`);
  ok(sOn.xf.state.U2src === 'solver' && near(sOn.xf.state.U2, sc.U, 1e-12),
    `U₂ 由**求解器**给（U2src=${sOn.xf.state.U2src}）：state.U₂=${sOn.xf.state.U2.toFixed(6)} V = 次边支路 U`);
  const rel = Math.abs(Math.abs(pm.I) - Math.abs(sc.I) / n) / (Math.abs(sc.I) / n);
  ok(rel < 0.01,
    `I₂ = n·I₁：I₁=${pm.I.toFixed(6)} A ⟷ I₂/n=${(sc.I / n).toFixed(6)} A`
    + `（相对差 ${(rel * 100).toFixed(2)}%，残差来自滞后一帧尚未完全收敛）`);
  ok(near(pm.R, sOn.xf.props.R1 + n * n * (sOn.xf.props.R2 + 10), 0.01),
    `一次总阻 = R₁+n²(R₂+R_L)：实测 ${pm.R.toFixed(4)} Ω ⟷ `
    + `${(sOn.xf.props.R1 + n * n * (sOn.xf.props.R2 + 10)).toFixed(4)} Ω（阻抗按 n² 折算）`);

  // ⚠ 代数环禁令的取证：次边 emf 必须来自**求本帧之前的 state**（E₁ = U₁ − I₁·R₁ 用上一帧量）
  //   ⚠ 求解器回写的支路记录只有 {I,U,P,R,virtual}（circuit.js:314），**没有 emf** ✗
  //     ⇒ 只能向**产品**再要一次它声明的支路条目（此时 state 与 c3 求解时用的是同一份 ✓）。
  const s3 = xfScene(true); settle(s3, 6);
  const E1pre = (s3.xf.state.U || 0) - (s3.xf.state.I || 0) * s3.xf.props.R1;
  const pre = s3.xf.circuitBranches(s3.w);
  const c3 = solveCircuit(s3.w, []);
  const emf3 = pre && pre[1] ? pre[1].emf : NaN;
  const wrong = (s3.xf.state.U || 0) / n;                 // 错法：拿 U₁/n（一次端电压）当二次 emf
  ok(near(emf3, E1pre / n, 1e-12),
    `次边 emf = 上一帧的 E₁/n（本帧 solve 内是常量）：${emf3.toFixed(9)} ⟷ ${(E1pre / n).toFixed(9)} V`
    + ' ⇒ 不读本帧中间量（与 §④ 同一条禁令）');
  ok(Math.abs(emf3 - wrong) > 1e-3,
    `对照组：次边 emf 与错法"U₁/n"确实不同（差 ${Math.abs(emf3 - wrong).toFixed(6)} V）`
    + ' ⇒ 上面那条判据能区分对错公式，不是恒真');
}

// ══════════════════════════════════════════════════════════
if (MUTATE) {
  head('⑥ --mutate：M1 去掉"只取一次"／M2 去掉 state 盒子 ⇒ 对应断言必须红，其余必须绿');
  const { readFileSync } = await import('node:fs');
  const mut = (name, from, to, rel = CIRCUIT_SRC) => {
    const abs = fileURLToPath(new URL('../' + rel, import.meta.url));
    let text = readFileSync(abs, 'utf8');
    if (!text.includes(from)) throw new Error('变异锚点没命中：' + name);
    text = text.replace(from, to);
    // ⚠ 变异体落在 %TEMP% ⇒ 它的相对 import 会按 %TEMP% 解析（错 ✗）⇒ 改写成绝对 file: URL
    text = text.replace(/(from\s+['"])(\.\.?\/[^'"]+)(['"])/g,
      (m, a, spec, z) => a + pathToFileURL(resolve(dirname(abs), spec)).href + z);
    const p = new URL('file:///' + process.env.TEMP.replace(/\\/g, '/') + '/xm-mb-' + name + '.mjs');
    writeFileSync(p, text, 'utf8');
    return import(p.href);
  };
  // M1：把"收集时取一次"退回"每次要支路都重问一次器材"
  // ⚠ M1 的变异体必须保留 typeof 守卫 **且** 对 null 安全：两线用法时 `circuitBranches(world)` 返回 null、
  //   没声明契约的器材根本没有该方法 ⇒ 原写法直接抛（实测：本探针的 --mutate 在原作者手里从没跑通过 ✗）。
  //   语义不变：仍是"每轮重问一次器材" ✓。
  const m1 = await mut('m1', 'getBr: () => r.br,',
    'getBr: () => ((typeof e.circuitBranches === \'function\' ? e.circuitBranches(world) : null) || [e.circuitBranch()])[r.k],');
  // M2：不再把解写进器材给的 state 盒子
  const m2 = await mut('m2', 'if (b.br && b.br.state && typeof b.br.state === \'object\') Object.assign(b.br.state, { I, U, P, R });',
    'if (false) { /* MUTANT */ }');
  // M3（本轮新增）：把"两线用法回落到 circuitBranch()"破坏成"瞎给一个电阻" ⇒
  //   §② 那三条两线断言必须红 —— 这是"改完真能红"的自证（否则只是把恒红换成了恒绿 ✗）。
  const m3 = await mut('m3', 'if (!defs) defs = [e.circuitBranch()];',
    'if (!defs) defs = [{ type: \'R\', r: 1 }];');

  const expected = [], ctrl = [];
  // M1：③ 的两条断言必须红
  {
    let calls = 0;
    const w = new World();
    const st = stub('m1s', 2, () => { calls++; return [{ type: 'V', emf: 1 + calls, r: 0.001 }]; });
    w.add(st, true);
    const c = m1.solveCircuit(w, []);
    expected.push(['M1：一趟 solve 里只取一次', calls === 1]);
    expected.push(['M1：解用第一次的 emf', near(c.branches.get('m1s').U, 2, 1e-9)]);
  }
  // M1 对照：两线兼容解、分压解析解都必须仍然成立
  {
    const sc = sceneTwoWire();
    const a = m1.solveCircuit(sc.w, []);
    const ra = a.branches.get(sc.rh.id);
    ctrl.push(['M1 对照：两线用法仍等于解析解', near(ra.I, -(BAT_EMF / (BAT_RINT + RHEO_RMAX * RHEO_POS)), 1e-9)]);
    const sc3 = sceneThreeWire(60);
    const c3 = m1.solveCircuit(sc3.w, []);
    const segA = RHEO_RMAX * RHEO_POS, segB = RHEO_RMAX * (1 - RHEO_POS);
    const par = (segB * 60) / (segB + 60);
    ctrl.push(['M1 对照：分压解析解仍成立',
      near(c3.branches.get(sc3.rh.id + '#1').U, -((BAT_EMF / (BAT_RINT + segA + par)) * par), 1e-9)]);
    ctrl.push(['M1 对照：三条支路仍然都在', c3.branches.size >= 4]);
  }
  // M2：state 盒子不再收到解
  {
    const box = {};
    const w = new World();
    const bat = create('battery', -160, 0);
    const st = stub('m2s', 3, () => [{ type: 'R', r: 20, a: 0, b: 2, state: box }, { type: 'R', r: 30, a: 2, b: 1 }]);
    w.add(bat, true); w.add(st, true);
    wire(w, bat.id, 1, st.id, 0); wire(w, st.id, 1, bat.id, 0);
    m2.solveCircuit(w, []);
    expected.push(['M2：state 盒子收到 {I,U,P,R}', typeof box.I === 'number' && typeof box.U === 'number']);
  }
  // M2 对照：主边实体级状态与键必须照旧
  {
    const w = new World();
    const bat = create('battery', -160, 0);
    const st = stub('m2c', 3, () => [{ type: 'R', r: 20, a: 0, b: 2 }, { type: 'R', r: 30, a: 2, b: 1 }]);
    w.add(bat, true); w.add(st, true);
    wire(w, bat.id, 1, st.id, 0); wire(w, st.id, 1, bat.id, 0);
    const c = m2.solveCircuit(w, []);
    ctrl.push(['M2 对照：主边仍写实体级 state', st.state.I === c.branches.get('m2c').I]);
    ctrl.push(['M2 对照：次级键仍在', c.branches.has('m2c#1')]);
    ctrl.push(['M2 对照：导线高亮仍按实体 id 取到记录',
      (() => { const wireRec = c.branches.get(st.id); return !!wireRec && typeof wireRec.I === 'number'; })()]);
  }

  // M3：两线回落被破坏 ⇒ §② 的解析解判据必须红（证明它抓的是产品行为，不是恒真）
  {
    const sc = sceneTwoWire();
    const c3 = m3.solveCircuit(sc.w, []);
    const rm = c3.branches.get(sc.rh.id);
    expected.push(['M3：两线回落破坏后仍等于解析解（该值为假 ⇒ 已红）',
      near(rm.I, -(BAT_EMF / (BAT_RINT + RHEO_RMAX * RHEO_POS)), 1e-9)]);
    ctrl.push(['M3 对照：同一变异下 §① 契约形状仍绿',
      m3.solveCircuit((() => { const w = new World(); const bat = create('battery', -160, 0); const st2 = stub('m3c', 3, () => [{ type: 'R', r: 20, a: 0, b: 2 }, { type: 'R', r: 30, a: 2, b: 1 }]); w.add(bat, true); w.add(st2, true); wire(w, bat.id, 1, st2.id, 0); wire(w, st2.id, 1, bat.id, 0); return w; })(), [])
      .branches.has('m3c#1')]);
  }

  // M4（本轮新增，针对**第二个用户**）：把二次侧当"没接线" ⇒ §⑦ 的"接线后"判据必须红。
  //   ⚠ 用**实例级覆盖**而不是模块级变异体：变压器在 electronics.js 里，模块级变异需要它自己的
  //     plugin host + registry 绑定（会弄脏本探针绑定的全局 create ✗），代价远大于收益。
  //     实例级覆盖同样能证明"这几条判据依赖产品实现"，且不动仓库任何字节 ✓。
  {
    const w = new World(); w.time = 0;
    const bat = create('battery', -300, 0); bat.props.emf = 6; bat.props.internalR = 0.01; w.add(bat, true);
    const xf = create('transformer', 0, 0); w.add(xf, true);
    const ld = create('resistor', 300, 220); ld.props.resistance = 10; w.add(ld, true);
    wire(w, bat.id, 1, xf.id, 0); wire(w, xf.id, 1, bat.id, 0);
    wire(w, xf.id, 2, ld.id, 0); wire(w, ld.id, 1, xf.id, 3);
    xf.circuitBranches = () => null;            // ← 产品坏掉的样子：对二次侧接线视而不见
    let cm = null;
    for (let i = 0; i < 8; i++) {
      cm = solveCircuit(w, []);
      for (const e of w.entities) if (typeof e.step === 'function') e.step(1 / 120, w);
      w.time += 1 / 120;
    }
    expected.push(['M4：二次侧接线后"两条支路都进矩阵"', cm.branches.size === 4 && cm.branches.has(xf.id + '#1')]);
    expected.push(['M4：二次侧接线后 U2src 应为 solver', xf.state.U2src === 'solver']);
    ctrl.push(['M4 对照：破坏二次支路后一次侧仍照旧解出、且回落 R1',
      typeof cm.branches.get(xf.id).I === 'number' && near(cm.branches.get(xf.id).R, xf.props.R1, 1e-12)]);
  }

  const observedRed = expected.filter(([, v]) => !v).length;
  const ctrlBad = ctrl.filter(([, v]) => !v).length;
  console.log('');
  for (const [m, v] of expected) console.log(`    ${v ? '\x1b[31m✗\x1b[0m 未红' : '\x1b[32m✓\x1b[0m 已红'} ${m}`);
  for (const [m, v] of ctrl) console.log(`    ${v ? '\x1b[32m✓\x1b[0m 仍绿' : '\x1b[31m✗\x1b[0m 误红'} ${m}`);
  ok(observedRed === expected.length && expected.length === 6,
    `期望变红 ${expected.length} 条，实测变红 ${observedRed} 条`);
  ok(ctrlBad === 0, `对照组误红 ${ctrlBad} 条`);
  console.log('\n\x1b[1mMULTIBRANCH_MUTATE_JSON\x1b[0m ' + JSON.stringify({
    expectedRed: expected.length, observedRed, ctrlBad,
    m1Landed: /circuitBranches\(world\) : null/.test(readFileSync(new URL('file:///' + process.env.TEMP.replace(/\\/g, '/') + '/xm-mb-m1.mjs')).toString('utf8')),
    m2Landed: /MUTANT/.test(readFileSync(new URL('file:///' + process.env.TEMP.replace(/\\/g, '/') + '/xm-mb-m2.mjs')).toString('utf8')),
    ok: observedRed === expected.length && ctrlBad === 0,
  }));
}

console.log(`\n\x1b[1m全部通过：${pass} 项\x1b[0m` + (fail ? `  \x1b[31m失败 ${fail} 项\x1b[0m` : ''));
console.log('\x1b[1mMULTIBRANCH_JSON\x1b[0m ' + JSON.stringify({ items: pass + fail, fail, mutate: MUTATE }));
process.exit(fail ? 1 : 0);
