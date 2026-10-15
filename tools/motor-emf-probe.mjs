// ══════════════════════════════════════════════════════════
// 电动机电气量探针：反电动势（C3 / task-48）
//
//   node tools/motor-emf-probe.mjs            正常读数
//   node tools/motor-emf-probe.mjs --red      D43 红能力（仓库零字节改动）
//
// 为什么存在：电动机此前在电路里是**纯电阻支路**（`circuitBranch()` 返回
// `{type:'R'}`），`ω` 只是电流的代数映射 `min(30, 40·I)` —— 没有反电动势这个
// 物理对象，于是 NB 口径的「反电动势 / 反电动势系数 / 输出功率」在我方**无真源**。
// task-48 的 (B′) 裁定：新增可声明参数 `ke`（默认 0）⇒ 反电动势有真源。
//
// 本探针的四条职责：
//   §1 **零回归对照**（(B′) 的正当性来源）：`ke` 保持默认时，逐条支路读数
//      必须与改动前**逐字相同**（`JSON.stringify` 全等）。改动前后各跑一次，
//      两次的 MOTOR_JSON `base` 段应完全一致 —— 「改前 → 改后」表就是这两次输出。
//   §2 **反电动势存在性 + D37 正控**：断言「`ke = 0` ⇒ 反电动势 ≈ 0」的同时，
//      必须给出 `ke > 0 ⇒ 反电动势 ≠ 0` 的见证，以及随 `ke` 单调的读数表。
//   §3 **方向正确性（本探针发现的真问题）**：本模型的 `ω = 40·|I|` **恒 ≥0、不带
//      方向** ⇒ 固定符号的 `emf` 会随用户接线不同而有时顶着电流、有时帮忙推电流
//      （"电机越转越快"）。所以判据不能是"带符号 I 下降"（那是假绿 ✗），必须是
//      **|I| 与 ω 严格下降**，且**把电机反接后同样下降**（方向由上一 tick 的支路
//      电流符号给出）。§3 就是这两条。
//
// 什么改动会让它红（D43 的清单）：
//   · 去掉 `emf` 里的 `ke` 项 / 置零 ⇒ §2 的 `emf ≠ 0` 红
//   · `emf` 符号写死（不取 `sign(I_prev)`）⇒ §3 的「反接后 |I| 仍下降」红
//   · `ke = 0` 时不再返回改动前那条 `{type:'R'}` 支路 ⇒ §1 逐字对照红
//   · `ω_prev` 未落盘（改用本 tick 的 ω）⇒ §2 的「首 tick emf = 0」红
//   · 依赖文件换版本 ⇒ 尾行依赖指纹跟着变（D36）
//
// 驱动顺序与 main.js 同源：`main.js:249-258` 是
//   coupling.buildBranches → solveCircuit → coupling.distribute → world.step（各实体 step）
// 本探针无耦合总线，故等价顺序为：`solveCircuit(world, [])` → `motor.step(dt)`。
// ══════════════════════════════════════════════════════════

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { World } from '../src/core/world.js';
import { PluginHost } from '../src/core/plugin.js';
import { create, bindRegistry } from '../src/equipment/registry.js';
import { solveCircuit } from '../src/physics/circuit.js';

import physicsPlugin from '../src/physics/circuit.js';

const RED = process.argv.includes('--red');
const ELECTRICAL = new URL('../src/equipment/electrical.js', import.meta.url);

// ── D36：依赖指纹（每次运行都打，读数才可追溯）──────────────
function fingerprint(url) {
  const buf = readFileSync(url);
  return { file: url.pathname.split('/').slice(-2).join('/'), sha256: createHash('sha256').update(buf).digest('hex').toUpperCase(), bytes: buf.length };
}
const DEPS = [fingerprint(ELECTRICAL), fingerprint(new URL('../src/physics/circuit.js', import.meta.url))];

// ── D43/D47 变异体：源码文本进内存改一处 → 写 %TEMP% → import ──
//   变异：把 `emf: s * ke * (this.state.omegaPrev || 0)` 换成 `emf: 0`
//   ⇒ 反电动势恒 0。相对 import 说明符必须改写成绝对 file:// —— %TEMP% 里解析不到仓库相对路径。
let mutantNote = null;
async function loadElectrical() {
  if (!RED) return (await import(ELECTRICAL)).default;
  let src = readFileSync(ELECTRICAL, 'utf8');
  const before = src;
  src = src.replace(/emf:\s*-?\s*s\s*\*\s*ke\s*\*\s*\(this\.state\.omegaPrev \|\| 0\)/, 'emf: 0');
  if (src === before) throw new Error('变异未命中：electrical.js 里的 emf 计算式没匹配上（先怀疑提取器，D49）');
  const specs = [...src.matchAll(/from\s+'(\.[^']+)'/g)];
  for (const m of specs) src = src.split(`'${m[1]}'`).join(`'${new URL(m[1], ELECTRICAL).href}'`);
  const out = new URL(`file:///${process.env.TEMP.replace(/\\/g, '/')}/xm-motor-emf-mutant-${Date.now()}.mjs`);
  writeFileSync(out, src, 'utf8');
  mutantNote = out.href;
  return (await import(out.href)).default;
}
const electricalPlugin = await loadElectrical();

// ── 无头宿主（只装求解器 + 电学器材；与 tools/circuit-probe.mjs 同一写法）──
const bootApp = {
  services: {}, world: null, lastCircuit: null, selected: null,
  log: { push() {}, clear() {} }, toast() {},
  addTick() { return () => {}; },
};
const host = new PluginHost(bootApp);
host.define(physicsPlugin);
host.define(electricalPlugin);
host.installAll();
bindRegistry(host.registry('equipment'));
const DEFS = new Map(host.registry('equipment').list().map((d) => [d.type, d]));

// ── 断言器（与 tools/equipment-*.mjs / circuit-probe 同一观感）──
let pass = 0, fail = 0;
const ok = (cond, msg, extra) => {
  if (cond) { pass++; console.log('  \x1b[32m✓\x1b[0m ' + msg); }
  else { fail++; console.log('  \x1b[31m✗\x1b[0m ' + msg); }
  if (extra !== undefined) console.log('      \x1b[90m' + JSON.stringify(extra) + '\x1b[0m');
  return !!cond;
};
const head = (t) => console.log('\n\x1b[36m' + t + '\x1b[0m');
const info = (t) => console.log('    \x1b[90m' + t + '\x1b[0m');
const F = (v, d = 6) => (typeof v === 'number' && isFinite(v) ? v.toFixed(d) : String(v));
const near = (a, b, tol = 1e-9) => typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));

// ── 场景：一节干电池 + 一只电动机，串成单回路 ────────────────
//   mirror = true 时把电池两端对调 ⇒ 电动机支路里的电流方向反转
//   （支路定向由接线决定，见 circuit-probe §3c），用来验证反电动势**不依赖接线方向**。
function rig(motorProps, mirror) {
  const world = new World();
  const bat = create('battery', 100, 100);
  const mot = create('motor', 220, 100);
  for (const k of Object.keys(motorProps)) mot.setProp(k, motorProps[k]);
  world.add(bat, true); world.add(mot, true);
  if (mirror) {
    world.connect({ e: bat.id, p: 1 }, { e: mot.id, p: 0 }, 'wire');
    world.connect({ e: mot.id, p: 1 }, { e: bat.id, p: 0 }, 'wire');
  } else {
    world.connect({ e: bat.id, p: 0 }, { e: mot.id, p: 0 }, 'wire');
    world.connect({ e: mot.id, p: 1 }, { e: bat.id, p: 1 }, 'wire');
  }
  return { world, bat, mot };
}
/** 跑 n 个 tick（solve → step，与 main.js 同源），返回末 tick 读数 + 首 tick 支路反电动势 */
function run(motorProps, opts = {}) {
  const { mirror = false, n = 60, dt = 1 / 60 } = opts;
  const { world, bat, mot } = rig(motorProps, mirror);
  let firstBranchEmf = null, firstI = null;
  for (let t = 0; t < n; t++) {
    if (t === 0) { firstBranchEmf = mot.circuitBranch().emf; firstI = mot.state.I; }
    solveCircuit(world, []);
    mot.step(dt);
  }
  return {
    mirror,
    bat: { emf: bat.props.emf, r: bat.props.internalR },
    motor: { resistance: mot.props.resistance, ke: mot.props.ke },
    I: mot.state.I, U: mot.state.U, P: mot.state.P, R: mot.state.R,
    omega: mot.state.omega, omegaPrev: mot.state.omegaPrev, on: mot.state.on, emf: mot.state.emf,
    firstBranchEmf, firstI,
  };
}

const keSupported = DEFS.get('motor') && Object.prototype.hasOwnProperty.call(DEFS.get('motor').defaults, 'ke');
const keField = keSupported ? (DEFS.get('motor').fields || []).find((f) => f.k === 'ke') : undefined;

console.log('\x1b[35m电动机电气量探针（C3 / task-48）\x1b[0m   ' + (RED ? '\x1b[31m[--red 变异模式]\x1b[0m' : '[正常]'));
info('命令行：' + process.argv.join(' '));
info('平台：' + process.platform + ' node ' + process.version);
for (const d of DEPS) info('依赖：' + d.file + '  ' + d.sha256 + '  ' + d.bytes + ' B');
if (RED) info('变异体（D47 待证生效）：' + mutantNote);

// ══════════════════════════════════════════════════════════
head('§0 前置：电动机可用、可接线、参数可声明');
// ══════════════════════════════════════════════════════════
ok(!!DEFS.get('motor'), '电动机在注册表里');
{
  const m = create('motor', 100, 100);
  ok(m && m.ports.filter((p) => p.kind === 'wire').length >= 2, '电动机有 ≥2 个 wire 端口（否它进不了电路）', m && m.ports.length);
  ok(typeof m.step === 'function' && typeof m.circuitBranch === 'function', '电动机有 step() 与 circuitBranch()');
}
info('ke 是否已支持：' + keSupported + (keField ? `（可声明字段 label=${keField.label} unit=${keField.unit} min=${keField.min} max=${keField.max} step=${keField.step}）` : ''));
if (RED) {
  // D47：用**可观测行为**证明变异体真的生效（electrical.js 不导出 Motor 类，
  // 所以不能反射调用；改用"钉住 I_prev/ω_prev 后看支路 emf"这一可观测事实）。
  const { mot: m47 } = rig({ resistance: 50, ke: 0.5 }, false);
  m47.state.I = -0.1; m47.state.omegaPrev = 2;
  const emf47 = m47.circuitBranch().emf;
  ok(emf47 === 0, 'D47：变异体已生效 —— 钉住 I_prev=−0.1、ω_prev=2、ke=0.5 支路 emf=' + emf47 + '（仓库版此处为 +1.0 V，变异版恒 0）', { emf: emf47 });
}

// ══════════════════════════════════════════════════════════
head('§1 零回归对照：ke 保持默认时，逐条支路读数（(B′) 的正当性来源）');
// ══════════════════════════════════════════════════════════
const rows = {};
for (const [name, props] of [['默认线圈 8Ω', { resistance: 8 }], ['高阻线圈 50Ω', { resistance: 50 }]]) {
  const r = run(props);
  rows[name] = r;
  info(`${name}：I=${F(r.I)} A  U=${F(r.U)} V  P=${F(r.P)} W  R=${F(r.R)} Ω  ω=${F(r.omega)}  on=${r.on}  ke=${r.motor.ke}`);
}
ok(near(rows['默认线圈 8Ω'].I, 1.5 / 8.5, 1e-6), '默认 8Ω：电流 ≈ 1.5/8.5 = 0.17647 A（纯电阻回路的解析解）', { I: rows['默认线圈 8Ω'].I, 解析: 1.5 / 8.5 });
ok(near(rows['高阻线圈 50Ω'].I, 1.5 / 50.5, 1e-6), '高阻 50Ω：电流 ≈ 1.5/50.5 = 0.029703 A', { I: rows['高阻线圈 50Ω'].I, 解析: 1.5 / 50.5 });
ok(near(rows['默认线圈 8Ω'].omega, Math.min(30, rows['默认线圈 8Ω'].I * 40), 1e-9), 'ω 仍是 I 的代数映射 min(30,40I)（本任务不动机械侧）', rows['默认线圈 8Ω'].omega);

// ══════════════════════════════════════════════════════════
head('§2 反电动势存在性与 D37 正控');
// ══════════════════════════════════════════════════════════
if (!keSupported) {
  info('★ 本版本还没有 ke 参数 ⇒ §2/§3 不适用（这正是「改前」的读数：反电动势无真源）');
} else {
  const r0 = run({ resistance: 50, ke: 0 });
  ok(near(r0.emf, 0, 1e-12) && near(r0.firstBranchEmf ?? 0, 0, 1e-12), 'ke = 0 ⇒ 反电动势 = 0（ke=0 走的是纯电阻支路，本就没有 emf 字段 ⇒ undefined 也算 0）', { 支路: r0.firstBranchEmf ?? null, state: r0.emf });
  ok(near(r0.I, rows['高阻线圈 50Ω'].I, 1e-12), 'ke = 0 与「不设 ke」读数逐字一致', { 设ke0: r0.I, 不设: rows['高阻线圈 50Ω'].I });

  const KES = [0, 0.1, 0.2, 0.5, 1];
  const trend = KES.map((ke) => {
    const r = run({ resistance: 50, ke });
    return { ke, I: r.I, absI: Math.abs(r.I), omega: r.omega, emf: r.emf, omegaPrev: r.omegaPrev, P: r.P, firstBranchEmf: r.firstBranchEmf };
  });
  for (const t of trend) info(`ke=${t.ke}：emf=${F(t.emf)} V  I=${F(t.I)} A  |I|=${F(t.absI)} A  ω=${F(t.omega)}  P=${F(t.P)} W  首tick支路emf=${F(t.firstBranchEmf)}`);
  const kv = trend.filter((t) => t.ke > 0);
  const kOn = kv.filter((t) => t.absI > 0.02);        // |I| 跌破 on 阈值(0.02A)后模型按既有规则停机
  const kOff = kv.filter((t) => t.absI <= 0.02);
  ok(kOn.length > 0 && kOn.every((t) => t.emf !== 0), 'D37 正控：ke > 0 且电机仍在转（|I|>0.02A）时反电动势 ≠ 0（见证「ke=0 ⇒ ≈0」不是空断言）', { 见证: kOn.map((t) => t.ke), emf: kOn.map((t) => t.emf) });
  ok(kOff.length === 0 || kOff.every((t) => t.emf === 0 && t.omega === 0), '反电动势把电流压到 on 阈值以下 ⇒ 电机按既有规则停机、emf 归 0（是阈值规则生效，不是反电动势失效）', { 停机的ke: kOff.map((t) => t.ke), I: kOff.map((t) => t.absI) });
  ok(trend.every((t) => near(t.firstBranchEmf ?? 0, 0, 1e-12)), '第 1 个 tick 反电动势必为 0（ω_prev 未定义 ⇒ 静止电机没有反电动势；R 支路无 emf 字段也算 0）', trend.map((t) => t.firstBranchEmf ?? null));
  ok(kv.every((t, i) => t.absI < trend[i].absI && t.omega <= trend[i].omega), '物理方向：反电动势使 |I| 严格下降、ω 单调不增（判据是幅值，不是带符号 I —— 后者会假绿；ω 在跌破阈值后归 0）', trend.map((t) => [+t.absI.toFixed(6), +t.omega.toFixed(6)]));
  ok(kv.every((t) => near(t.emf, -Math.sign(t.I) * t.ke * t.omegaPrev, 1e-9)), 'emf = −sign(I)·ke·ω_prev 逐条成立（换算式，不是"看起来像"；取反是因为 V 支路报告电流与被动约定反号）', kv.map((t) => ({ ke: t.ke, emf: t.emf, 期望: -Math.sign(t.I) * t.ke * t.omegaPrev })));

  // ══════════════════════════════════════════════════════════
  head('§3 方向正确性：把电机反接，反电动势必须照样顶着电流（否则就成了"顺电动势助力"）');
  // ══════════════════════════════════════════════════════════
  const norm = run({ resistance: 50, ke: 0.2 });
  const mirr = run({ resistance: 50, ke: 0.2 }, { mirror: true });
  const norm0 = run({ resistance: 50, ke: 0 });
  const mirr0 = run({ resistance: 50, ke: 0 }, { mirror: true });
  info(`正接：ke=0 |I|=${F(Math.abs(norm0.I))} → ke=0.2 |I|=${F(Math.abs(norm.I))}，emf=${F(norm.emf)}（I=${F(norm.I)}）`);
  info(`反接：ke=0 |I|=${F(Math.abs(mirr0.I))} → ke=0.2 |I|=${F(Math.abs(mirr.I))}，emf=${F(mirr.emf)}（I=${F(mirr.I)}）`);
  ok(near(Math.abs(norm0.I), Math.abs(mirr0.I), 1e-12) && norm0.I * mirr0.I < 0, 'ke=0 时反接只是把支路电流定向翻过来（|I| 不变、符号相反）', { 正接: norm0.I, 反接: mirr0.I });
  ok(Math.abs(norm.I) < Math.abs(norm0.I) && Math.abs(mirr.I) < Math.abs(mirr0.I), '两个接线下 |I| 都因反电动势下降（方向不依赖用户怎么接线）', { 正接: [+Math.abs(norm0.I).toFixed(6), +Math.abs(norm.I).toFixed(6)], 反接: [+Math.abs(mirr0.I).toFixed(6), +Math.abs(mirr.I).toFixed(6)] });
  ok(norm.emf * mirr.emf < 0, '两个接线下反电动势的符号相反（它跟随支路电流定向，不是写死的）', { 正接emf: norm.emf, 反接emf: mirr.emf });
  ok(norm.emf * norm.I < 0 && mirr.emf * mirr.I < 0, '两个接线下 emf 都与支路电流反号 ⇒ 反电动势恒顶着电流（电机不可能被自己的反电动势推着加速）', { 正接: { emf: norm.emf, I: norm.I }, 反接: { emf: mirr.emf, I: mirr.I } });

  // ══════════════════════════════════════════════════════════
  head('§4 受控符号判定：钉住上一 tick 的 I 与 ω 各解一次（不靠反馈收敛 —— 带反馈时两种符号都能"自洽"，代数推不出真符号）');
  // ══════════════════════════════════════════════════════════
  const base0 = run({ resistance: 50, ke: 0 });
  const oneSolve = (pinI, pinW, ke) => {
    const { world, mot } = rig({ resistance: 50, ke }, false);
    mot.state.I = pinI; mot.state.omegaPrev = pinW;
    const br = mot.circuitBranch();
    solveCircuit(world, []);
    return { emf: br.emf, I: mot.state.I, absI: Math.abs(mot.state.I) };
  };
  const sP = oneSolve(0.1, 2, 0.5), sN = oneSolve(-0.1, 2, 0.5);
  const baseAbs = Math.abs(base0.I);
  info(`ke=0 基线 |I|=${F(baseAbs)} A`);
  info(`钉住 I_prev=+0.1、ω_prev=2 ⇒ 支路 emf=${F(sP.emf)} V，解得 I=${F(sP.I)} A（|I|=${F(sP.absI)}）`);
  info(`钉住 I_prev=-0.1、ω_prev=2 ⇒ 支路 emf=${F(sN.emf)} V，解得 I=${F(sN.I)} A（|I|=${F(sN.absI)}）`);
  ok(near(Math.abs(sN.emf), 1, 1e-12) && sN.absI < baseAbs, '钉住 I_prev<0 ⇒ emf=+1.0V ⇒ |I| 降到 0.0099=(1.5−1.0)/50.5 ⇒ 真·反电动势（顶着电流）', { emf: sN.emf, absI: sN.absI, 基线: baseAbs });
  ok(near(Math.abs(sP.emf), 1, 1e-12) && sP.absI > baseAbs, '钉住反号 ⇒ emf=−1.0V ⇒ |I| 升到 0.0495=(1.5+1.0)/50.5 ⇒ 发电机态（倒着驱动时电动势顺着推），物理正确', { emf: sP.emf, absI: sP.absI, 基线: baseAbs });
  ok(sN.emf * -0.1 < 0 && sP.emf * 0.1 < 0, 'emf 与钉住的 I_prev 反号（实现按此定向；方向取自 V 支路报告电流的约定，不是写死的符号）', { 负钉: [sN.emf, -0.1], 正钉: [sP.emf, 0.1] });

  // ══════════════════════════════════════════════════════════
  head('§5 求解器电流符号约定守卫（本实现的反电动势符号依赖它；求解器一旦把符号改正常，反电动势会静默反向 ⇒ 电机越转越快）');
  // ══════════════════════════════════════════════════════════
  // 做法：同一个物理回路，同一只电动机、同一个 50Ω，分别以 R 支路与 V 支路(emf≡0) 呈现，
  // 比较求解器报告的电流符号。V 支路里把 ω_prev 钉成 0 ⇒ emf≡0 ⇒ 它是"0V 源 + 串联 50Ω"，
  // 与 R 支路戴维南等价 ⇒ 物理电流完全相同，剩下的差别**只是符号约定**。
  const convI_R = (() => { const { world, mot } = rig({ resistance: 50 }, false); solveCircuit(world, []); return mot.state.I; })();
  const convI_V = (() => {
    const { world, mot } = rig({ resistance: 50, ke: 0.5 }, false);
    mot.state.omegaPrev = 0; mot.state.I = 0;
    const br = mot.circuitBranch();
    solveCircuit(world, []);
    return { I: mot.state.I, emf: br.emf, type: br.type };
  })();
  info(`同一回路：R 支路报告 I=${F(convI_R)} A；V 支路(${convI_V.type}, emf=${F(convI_V.emf)}) 报告 I=${F(convI_V.I)} A`);
  ok(convI_V.type === 'V' && convI_V.emf === 0, 'V 支路侧确实是"0V 源 + 串联电阻"（emf≡0，否则这条守卫比的就不是约定了）', { type: convI_V.type, emf: convI_V.emf });
  ok(near(Math.abs(convI_R), Math.abs(convI_V.I), 1e-9), '两条支路给出的电流**幅值相同**（同一物理电流）', { R: convI_R, V: convI_V.I });
  ok(convI_R * convI_V.I < 0, '★ 约定守卫：同一物理电流下，V 支路报告的电流与 R 支路**反号** —— 本实现的反电动势符号就依赖这条；此处变红 ⇒ emf 的符号必须同步取反（src/equipment/electrical.js 的 circuitBranch）', { R: convI_R, V: convI_V.I });
}

// ══════════════════════════════════════════════════════════
const deps = DEPS.map((d) => d.file + '@' + d.sha256.slice(0, 16) + '/' + d.bytes + 'B').join(' ');
console.log('\n' + (fail === 0 ? '\x1b[32m' : '\x1b[31m') + `电动机电气量探针：${fail === 0 ? '全部通过' : '有失败'}：${pass} 项` + (fail ? `（失败 ${fail}）` : '') + '\x1b[0m');
console.log('MOTOR_JSON ' + JSON.stringify({
  mode: RED ? 'red' : 'normal', summary: `${pass}/${pass + fail}`, passed: pass, failed: fail,
  keSupported: !!keSupported,
  base: {
    '8Ω': { I: rows['默认线圈 8Ω'].I, U: rows['默认线圈 8Ω'].U, P: rows['默认线圈 8Ω'].P, R: rows['默认线圈 8Ω'].R, omega: rows['默认线圈 8Ω'].omega, on: rows['默认线圈 8Ω'].on },
    '50Ω': { I: rows['高阻线圈 50Ω'].I, U: rows['高阻线圈 50Ω'].U, P: rows['高阻线圈 50Ω'].P, R: rows['高阻线圈 50Ω'].R, omega: rows['高阻线圈 50Ω'].omega, on: rows['高阻线圈 50Ω'].on },
  },
  deps,
}));
process.exit(fail === 0 ? 0 : 1);
