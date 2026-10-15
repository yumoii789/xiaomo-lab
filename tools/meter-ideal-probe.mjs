// ══════════════════════════════════════════════════════════
// 电表 理想/现实 双模式探针（plans/10 §5 C5）
//
//   node tools/meter-ideal-probe.mjs            正常读数
//   node tools/meter-ideal-probe.mjs --red      D43 红能力（仓库零字节改动）
//   node tools/meter-ideal-probe.mjs --red-stale 红能力（只打 §4b 的一致性判据：故意喂一对不一致的读数）
//   ⚠ 只认上面这几档；**任何别的开关一律 exit=2 明确报错**（不认识的开关 + exit=0 = 与"我验了"长得一模一样的空转绿 ✗）
//   ⚠ 源码级**变异提取器**的输入先剥注释（见文件内 stripComments 处的纪律；附近有自检断言锁这件事）
//
// 为什么存在：电表的「现实性」此前是两个**硬编码字面量** ——
//   `electrical.js:379  circuitBranch() { return { type:'R', r: this.props.mode === 'A' ? 0.05 : 1e6 }; }`
// 「理想电表 vs 现实电表」是标准教学对照（NB 字面量 `现实电表`20364 / `理想模式`20366），
// 但我方既不能切档、也不能声明现实内阻。
//
// ⚠ 理想极端**不需要新原语**，也不需要发明 0 Ω 支路：我方的既有惯用法是
//   · 理想导线 = `{ type:'R', r: 0.01 }`（`Switch` 闭合档 :101；`Battery` 内阻下限 max(0.01,·) :50）
//   · 理想断开 = `{ type:'open' }`（`Switch` 断开档）
// ⇒ 理想电流表 = 0.01 Ω 支路；理想电压表 = open 支路。
//
// 本探针的职责：
//   §1 **冻结基线 / 零回归**：现实档（默认）下逐条读数必须与改动前**逐字相同**。
//   §2 **理想/现实存在性与 D37 正控**：现实档必须给出「电压表在分压」的**见证**（≠0 的差），
//      理想档该差必须真的消失 —— 只断言"理想 U 更大"是空断言。
//   §3 **闭式见证（独立于模型）**：现实电压表 = `R_m ∥ R` ⇒ `U_现 = E·(Rm∥R)/(r + Rm∥R)`，
//      理想 `U_理 = E·R/(r+R)` ⇒ 断言**差值等于闭式差值**，且差值随被测 R **单调增大**。
//   §4 理想电流表：`I_理 = E/(r+R)`（闭式）vs 现实 `E/(r+0.05+R)`，且 `I_理 > I_现`。
//   §5 理想电压表支路电流**恰为 0**（open 支路被求解器跳过）；现实电压表**必须抽走电流**（这
//      正是"现实表扰动电路"的物理点：只断言理想为 0 而不给现实非 0 的见证，就是假绿）。
//
// 什么改动会让它红（D43 清单）：
//   · `realistic` 判定失效（理想档退回现实档）⇒ §2/§3/§4 红
//   · 理想电流表用了 0 Ω 而非 0.01 Ω ⇒ §1 逐字对照（若同时动了现实档）或 §4 闭式差红
//   · `realR` 被做了哨兵处理（声明的 0 被解读成"用现值"）⇒ §4 的「声明的数就是声明的数」红
//   · 理想电压表串进回路不再造成断路 ⇒ §5 的串联后果断言红
//   · **R<=0 时盖章路径与上报路径再次分岔**（task-53 修掉的旧缺陷回归）⇒ §4b 的一致性不变量红
//     （`--red-stale` 直接把这条判据喂成一对不一致的读数，证明它不是"只会绿"的断言）
//
// 驱动顺序与 main.js 同源（`main.js:249-258`）：solveCircuit(world, []) → 各实体 step。
// ══════════════════════════════════════════════════════════

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { World } from '../src/core/world.js';
import { PluginHost } from '../src/core/plugin.js';
import { create, bindRegistry } from '../src/equipment/registry.js';
import { solveCircuit } from '../src/physics/circuit.js';

import physicsPlugin from '../src/physics/circuit.js';

const RED = process.argv.includes('--red');
/** 只打 §4b 一致性判据的红模式：把"自报 vs 实测"两侧换成**故意不一致**的一对读数 */
const RED_STALE = process.argv.includes('--red-stale');
const ELECTRICAL = new URL('../src/equipment/electrical.js', import.meta.url);

// ── 未知开关 ⇒ 明确报错退出（不许静默忽略）──
// 理由：不认识的开关 + exit=0 与「我验了」长得一模一样 —— 本会话已证明这类假绿最难被发现。
//      （本探针就曾被 `--red=m1` 静默忽略过：那份"六档全绿"其实是空转 ✗。）
{
  const known = new Set(['--red', '--red-stale']);
  const bad = process.argv.slice(2).filter((a) => !known.has(a));
  if (bad.length) { console.log(`✗ 不认识的开关：${bad.join(' ')} —— 本探针只认 ${[...known].join(' / ')}`); process.exit(2); }
}

// 纪律（本仓既有）：源码级提取器的输入是**代码**，注释不是它的输入 ⇒ 先剥注释再匹配。
// 反例（比"冗余"严重得多）：提取器一旦"命中"注释里的字面量，变异体会变成**空操作**，红档就失去牙齿 ✗。
const stripComments = (s) => s.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

// ── D36：依赖指纹 ────────────────────────────────────────
function fingerprint(url) {
  const buf = readFileSync(url);
  return { file: url.pathname.split('/').slice(-2).join('/'), sha256: createHash('sha256').update(buf).digest('hex').toUpperCase(), bytes: buf.length };
}
const DEPS = [fingerprint(ELECTRICAL), fingerprint(new URL('../src/physics/circuit.js', import.meta.url))];

// ── D43/D47 变异体：把「理想档判定」废掉（恒走现实档）──
let mutantNote = null;
async function loadElectrical() {
  if (!RED) return (await import(ELECTRICAL)).default;
  const rawSrc = readFileSync(ELECTRICAL, 'utf8');
  let src = stripComments(rawSrc);      // ← 提取器的输入必须先剥注释（见文件头那条纪律）
  const before = src;
  src = src.replace(/this\.props\.realistic\s*!==\s*false/, 'true');
  if (src === before) throw new Error('变异未命中：electrical.js 里的 realistic 判定没匹配上（先怀疑提取器，D49）');
  const specs = [...src.matchAll(/from\s+'(\.[^']+)'/g)];
  for (const m of specs) src = src.split(`'${m[1]}'`).join(`'${new URL(m[1], ELECTRICAL).href}'`);
  const out = new URL(`file:///${process.env.TEMP.replace(/\\/g, '/')}/xm-meter-ideal-mutant-${Date.now()}.mjs`);
  writeFileSync(out, src, 'utf8');
  mutantNote = out.href;
  return (await import(out.href)).default;
}
const electricalPlugin = await loadElectrical();

// ── 无头宿主（与 tools/motor-emf-probe.mjs 同一写法）──
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

// ── 断言器 ──
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

// 项目既有的两个「理想极端」（照抄既有惯用法，不是我发明的）
const IDEAL_LEAD_R = 0.01;      // = Switch 闭合档
const REAL_A_R = 0.05, REAL_V_R = 1e6;

// ── 场景 A：电池 + 电流表 + 定值电阻 串成单回路（测电流表）──
function rigAmp(E, r, R, meterProps) {
  const world = new World();
  const bat = create('battery', 60, 60);
  const amp = create('ammeter', 160, 60);
  const res = create('resistor', 260, 60);
  bat.setProp('emf', E); bat.setProp('internalR', r);
  res.setProp('resistance', R);
  for (const k of Object.keys(meterProps)) amp.setProp(k, meterProps[k]);
  world.add(bat, true); world.add(amp, true); world.add(res, true);
  world.connect({ e: bat.id, p: 0 }, { e: amp.id, p: 0 }, 'wire');
  world.connect({ e: amp.id, p: 1 }, { e: res.id, p: 0 }, 'wire');
  world.connect({ e: res.id, p: 1 }, { e: bat.id, p: 1 }, 'wire');
  return { world, bat, amp, res };
}
// ── 场景 B：电池 + 定值电阻，电压表并接在电阻两端（测电压表）──
function rigVolt(E, r, R, meterProps) {
  const world = new World();
  const bat = create('battery', 60, 60);
  const res = create('resistor', 160, 60);
  const vol = create('voltmeter', 260, 60);
  bat.setProp('emf', E); bat.setProp('internalR', r);
  res.setProp('resistance', R);
  for (const k of Object.keys(meterProps)) vol.setProp(k, meterProps[k]);
  world.add(bat, true); world.add(res, true); world.add(vol, true);
  world.connect({ e: bat.id, p: 0 }, { e: res.id, p: 0 }, 'wire');
  world.connect({ e: res.id, p: 1 }, { e: bat.id, p: 1 }, 'wire');
  world.connect({ e: vol.id, p: 0 }, { e: res.id, p: 0 }, 'wire');
  world.connect({ e: vol.id, p: 1 }, { e: res.id, p: 1 }, 'wire');
  return { world, bat, res, vol };
}
/** 跑 n 个 tick；返回末 tick 读数（含两支路电流/电压） */
function runAmp({ E, r, R, props = {} }) {
  const { world, bat, amp, res } = rigAmp(E, r, R, props);
  for (let t = 0; t < 20; t++) { solveCircuit(world, []); world.step(1 / 60); }
  const br = amp.circuitBranch();
  return { branchType: br.type, branchR: br.r, E, r, R, ampR: amp.props.realR, realistic: amp.props.realistic, I_amp: amp.state.I, U_amp: amp.state.U, I_res: res.state.I, U_res: res.state.U, world };
}
function runVolt({ E, r, R, props = {} }) {
  const { world, bat, res, vol } = rigVolt(E, r, R, props);
  for (let t = 0; t < 20; t++) { solveCircuit(world, []); world.step(1 / 60); }
  const br = vol.circuitBranch();
  return { branchType: br.type, branchR: br.r, E, r, R, voltR: vol.props.realR, realistic: vol.props.realistic, U_volt: vol.state.U, I_volt: vol.state.I, I_res: res.state.I, U_res: res.state.U, world };
}

// ── 场景 C：电池 + 电压表 **串进**回路 + 定值电阻（证明「理想电压表串进回路 = 断路」的后果）──
function rigVoltSeries(E, r, R, meterProps) {
  const world = new World();
  const bat = create('battery', 60, 60);
  const vol = create('voltmeter', 160, 60);
  const res = create('resistor', 260, 60);
  bat.setProp('emf', E); bat.setProp('internalR', r);
  res.setProp('resistance', R);
  for (const k of Object.keys(meterProps)) vol.setProp(k, meterProps[k]);
  world.add(bat, true); world.add(vol, true); world.add(res, true);
  world.connect({ e: bat.id, p: 0 }, { e: vol.id, p: 0 }, 'wire');
  world.connect({ e: vol.id, p: 1 }, { e: res.id, p: 0 }, 'wire');
  world.connect({ e: res.id, p: 1 }, { e: bat.id, p: 1 }, 'wire');
  return { world, bat, vol, res };
}
function runVoltSeries({ E, r, R, props = {} }) {
  const { world, bat, vol, res } = rigVoltSeries(E, r, R, props);
  for (let t = 0; t < 20; t++) { solveCircuit(world, []); world.step(1 / 60); }
  const br = vol.circuitBranch();
  return { branchType: br.type, branchR: br.r, I_volt: vol.state.I, I_res: res.state.I, U_volt: vol.state.U };
}

const supported = !!(DEFS.get('ammeter') && Object.prototype.hasOwnProperty.call(DEFS.get('ammeter').defaults, 'realistic'));
const KEYS = (t) => Object.keys(DEFS.get(t) ? DEFS.get(t).defaults : {});

console.log('电表 理想/现实 双模式探针（C5）  ' + (RED ? '\x1b[35m[变异体]\x1b[0m' : '[正常]'));
console.log('    \x1b[90m命令行：' + process.argv.join(' ') + '\x1b[0m');
console.log('    \x1b[90m平台：' + process.platform + ' node ' + process.version + '\x1b[0m');
for (const d of DEPS) console.log('    \x1b[90m依赖：' + d.file + '  ' + d.sha256 + '  ' + d.bytes + ' B\x1b[0m');
if (mutantNote) console.log('    \x1b[90m变异体（D47 待证生效）：' + mutantNote + '\x1b[0m');

head('§0 前置：电流表/电压表可用、可接线、参数可声明');
// ── 自检：证明上面那条纪律不是装饰（注释不得成为提取器/判据的输入）──
// ⚠ 这两条一旦红，先去查判据/提取器，别去查被测代码（坏判据的特征是：它不看变异体也会红）。
{
  const RAW = readFileSync(ELECTRICAL, 'utf8');
  const GUARD = 'this.props.realistic !== false';
  const pred = (s) => /this\.props\.realistic\s*!==\s*false/.test(s);
  ok('自检：剥注释后，注释里的标志字面量**不**算"代码里有"', pred(stripComments('  // ' + GUARD + '\n')) === false);
  ok('自检：同一条**不**剥注释就会命中（假绿机制真实存在，纪律不是装饰）', pred('  // ' + GUARD + '\n') === true);
  ok('自检：剥注释确实改动过真源码文本（否则本自检是空转）', stripComments(RAW) !== RAW && stripComments(RAW).length < RAW.length);
}
ok(!!DEFS.get('ammeter') && !!DEFS.get('voltmeter'), '电流表与电压表都在注册表里');
ok((DEFS.get('ammeter').ports || []).length >= 2 && (DEFS.get('voltmeter').ports || []).length >= 2, '两者都有 ≥2 个 wire 端口');
info('realistic 是否已支持：' + supported + '（电流表可声明键：' + KEYS('ammeter').join(' ') + '）');

head('§1 冻结基线 / 零回归：现实档（默认）逐条读数（改动前后必须逐字相同）');
const base = { branches: {}, amp: {}, volt: {} };
{
  const a = runAmp({ E: 1.5, r: 0.5, R: 10, props: {} });
  const v = runVolt({ E: 1.5, r: 0.5, R: 10, props: {} });
  base.branches.amp = { type: a.branchType, r: a.branchR };
  base.branches.volt = { type: v.branchType, r: v.branchR };
  base.amp = { E: a.E, r: a.r, R: a.R, I: a.I_amp, U: a.U_amp, I_res: a.I_res, U_res: a.U_res };
  base.volt = { E: v.E, r: v.r, R: v.R, U: v.U_volt, I_volt: v.I_volt, I_res: v.I_res, U_res: v.U_res };
  info(`电流表支路：{type:'${a.branchType}', r:${F(a.branchR, 9)}}（改动前是 mode==='A' ? 0.05 : 1e6 的字面量）`);
  info(`电压表支路：{type:'${v.branchType}', r:${F(v.branchR, 9)}}`);
  info(`电流表回路 1.5V/0.5Ω/10Ω：I_表=${F(a.I_amp, 9)} U_表=${F(a.U_amp, 9)} I_R=${F(a.I_res, 9)} U_R=${F(a.U_res, 9)}`);
  info(`电压表并接 1.5V/0.5Ω/10Ω：U_表=${F(v.U_volt, 9)} I_表=${F(v.I_volt, 9)} I_R=${F(v.I_res, 9)} U_R=${F(v.U_res, 9)}`);
  ok(near(a.branchR, REAL_A_R, 1e-12) && a.branchType === 'R', '电流表支路 = 0.05 Ω 的 R 支路（现实档默认值）', { r: a.branchR });
  ok(near(v.branchR, REAL_V_R, 1e-12) && v.branchType === 'R', '电压表支路 = 1e6 Ω 的 R 支路（现实档默认值）', { r: v.branchR });
  // D37 正控：现实电压表**真的在分压**（读数非零且小于理想极限 E）
  ok(v.U_volt > 0 && v.U_volt < 1.5, 'D37 正控：现实电压表读数非零且小于电源电动势（见证"它在分压"不是空断言）', { U_表: v.U_volt, E: 1.5 });
}

if (!supported) {
  head('§2–§5 不适用');
  info('改动前的 electrical.js 没有 realistic/realR 参数 ⇒ 电表不能切理想档、现实内阻也不可声明（这正是 C5 要补的差距）');
} else {
  head('§2 理想/现实存在性与 D37 正控（现实档必须给出分压见证；理想档该差必须真的消失）');
  const E = 1.5, r = 0.5;
  const R = 100;                       // 被测电阻取大 ⇒ 1e6 与它并联的分压效应才明显可见
  const vReal = runVolt({ E, r, R, props: {} });
  const vIdeal = runVolt({ E, r, R, props: { realistic: false } });
  const dup = (a, b) => a !== b && isFinite(a) && isFinite(b);
  info(`现实档 U=${F(vReal.U_volt, 9)}  理想档 U=${F(vIdeal.U_volt, 9)}  差=${F(vIdeal.U_volt - vReal.U_volt, 9)}`);
  ok(dup(vReal.U_volt, vIdeal.U_volt) && vIdeal.U_volt > vReal.U_volt, 'D37 正控：理想电压表读数 > 现实档（给出非零差的见证，不是"更大"的空断言）', { 现实: vReal.U_volt, 理想: vIdeal.U_volt, 差: vIdeal.U_volt - vReal.U_volt });

  head('§3 闭式见证（独立于模型）：现实表 = R_m ∥ R，理想表 = 不并联');
  const par = (a, b) => (a * b) / (a + b);
  const U_real_closed = (E, r, R, Rm) => E * par(R, Rm) / (r + par(R, Rm));
  const U_ideal_closed = (E, r, R) => E * R / (r + R);
  const chk = [[10, 1e6], [100, 1e6], [1000, 1e6]];
  const diffs = [];
  for (const [Ri, Rm] of chk) {
    const rl = runVolt({ E, r, R: Ri, props: {} });
    const id = runVolt({ E, r, R: Ri, props: { realistic: false } });
    const cr = U_real_closed(E, r, Ri, Rm), ci = U_ideal_closed(E, r, Ri);
    diffs.push(ci - cr);
    info(`R=${Ri}：现实模型=${F(rl.U_volt, 9)} 闭式=${F(cr, 9)} ｜ 理想模型=${F(id.U_volt, 9)} 闭式=${F(ci, 9)}`);
    ok(near(rl.U_volt, cr, 1e-9), `R=${Ri}：现实档读数 = 闭式 E·(Rm∥R)/(r+Rm∥R)`, { 模型: rl.U_volt, 闭式: cr });
    ok(near(id.U_volt, ci, 1e-9), `R=${Ri}：理想档读数 = 闭式 E·R/(r+R)`, { 模型: id.U_volt, 闭式: ci });
  }
  ok(diffs[0] < diffs[1] && diffs[1] < diffs[2], '理想与现实的差随被测电阻单调增大（分压效应：差 = ' + diffs.map((x) => x.toExponential(3)).join(' < ') + '）', diffs);

  head('§4 理想电流表：I_理 = E/(r+R) 闭式；现实表内阻串进回路 ⇒ I_现 更小');
  const aReal = runAmp({ E, r, R: 10, props: {} });
  const aIdeal = runAmp({ E, r, R: 10, props: { realistic: false } });
  const I_ideal_closed = E / (r + IDEAL_LEAD_R + 10), I_real_closed = E / (r + REAL_A_R + 10);
  info(`现实档 I=${F(aReal.I_amp, 9)}（闭式 ${F(I_real_closed, 9)}）｜理想档 I=${F(aIdeal.I_amp, 9)}（闭式 ${F(I_ideal_closed, 9)}）`);
  ok(near(aIdeal.I_amp, I_ideal_closed, 1e-9), '理想电流表读数 = 闭式 E/(r+0.01+R) —— 注意「理想」在**本项目**的定义是 0.01 Ω 的导线，不是 0 Ω', { 模型: aIdeal.I_amp, 闭式: I_ideal_closed, 支路: aIdeal.branchR });
  ok(near(aReal.I_amp, I_real_closed, 1e-9) && aIdeal.I_amp > aReal.I_amp, '现实档读数 = 闭式 E/(r+0.05+R) 且恒小于理想档（给出两侧见证）', { 现实: aReal.I_amp, 理想: aIdeal.I_amp, 闭式现实: I_real_closed });
  ok(near(aIdeal.branchR, IDEAL_LEAD_R, 1e-12), '理想电流表用本项目既有的「理想导线」惯用法 0.01 Ω（不是自造的 0 Ω 支路）', { 支路: aIdeal.branchR, 闭合开关: IDEAL_LEAD_R });

  head('§4b realR：声明的数就是声明的数（没有魔法值），以及声明 0 的真实后果');
  const aAs = runAmp({ E, r, R: 10, props: { realR: 0.02 } });
  const cAs = E / (r + 0.02 + 10);
  info(`realR=0.02 ⇒ 支路 r=${F(aAs.branchR, 9)} Ω，I=${F(aAs.I_amp, 12)}（闭式 E/(r+0.02+R)=${F(cAs, 12)}）`);
  ok(aAs.branchR === 0.02 && Math.abs(aAs.I_amp - cAs) / cAs < 1e-9, '声明 realR=0.02 ⇒ 支路就用 0.02 Ω（不被哨兵改写）', { 声明: 0.02, 支路: aAs.branchR });
  const aZero = runAmp({ E, r, R: 10, props: { realR: 0 } });
  const cTrue = E / (r + 1e9 + 10);       // 盖章路径把 R<=0 当 1e9 Ω ⇒ 真实回路电流
  const cWire = E / (r + IDEAL_LEAD_R + 10);
  info(`realR=0 ⇒ 支路 r=${F(aZero.branchR, 9)} Ω（**按声明值**）`);
  info(`      表自报 I=${F(aZero.I_amp, 6)} A ｜ 同回路电阻支路实测 I=${F(aZero.I_res, 15)} A ｜ 闭式(盖章按 1e9Ω) ${F(cTrue, 15)} A ｜ 闭式(理想导线) ${F(cWire, 9)} A`);
  ok(aZero.branchR === 0, '声明 realR=0 ⇒ 支路 r 就是 0（**不做哨兵改写**；0 是合法电阻值）', { 支路: aZero.branchR });
  // ⚠ 容差不是 1e-6 而是 1e-2：1e9 Ω 的泄漏与 gmin(1e-12 S，`circuit.js:194`) 是**并联**关系，
  //   1e-9 S vs 1e-12 S ⇒ 实测比闭式高约 0.1%（1e-3），这是纯数值兜底、不是物理差异。
  const gminRel = Math.abs(aZero.I_res - cTrue) / cTrue;
  ok(gminRel < 1e-2, '⚠ 真实回路电流（同回路 10Ω 支路实测）符合「盖章按 1e9 Ω」的量级 ⇒ 物理上确实是**近断路**（比闭式高 ' + gminRel.toExponential(3) + '，来源是 gmin 与 1e9 Ω 泄漏并联，非物理差异）', { 实测: aZero.I_res, 闭式1e9: cTrue, 相对偏高: gminRel });
  // ⚠ **哨兵升级**（本会话立的纪律）：这条断言原先描述的是**缺陷态** ——
  //   旧文案要求 `aZero.I_amp > 1`，即"自报值比真实回路电流大 1e13 倍"。
  //   task-53 修好 `circuit.js:231-239` 之后它**必然变红** ✗ —— 那不是新缺陷，是**陈旧断言**。
  //   缺陷态的描述没有保留价值 ⇒ 升级成永久不变量（比"缺陷还在"有价值得多）：
  //   「R<=0 时，盖章路径（`:169-170` 按 1e9 Ω）与上报路径（`:231` 走 resOf(b,U)）必须给**同一个答案**」。
  //   D37 式正控：两侧都必须非退化（都 ≠ 0），否则"两边都是 0"也能骗过相对差。
  //   量级对照：旧缺陷期 自报 1.5e4 A vs 实测 1.5e-9 A（比值 ≈1e13）；修复后 比值 ≈1.0。
  const selfA = Math.abs(aZero.I_amp);
  const selfRef = Math.abs(aZero.I_res);
  const stalePair = RED_STALE ? [Math.abs(aIdeal.I_amp), selfRef] : [selfA, selfRef];  // 红模式：故意喂不一致的一对
  const selfRel = Math.abs(stalePair[0] - stalePair[1]) / stalePair[1];
  info(`      一致性判据两侧：表自报 ${F(stalePair[0], 12)} A ｜ 同回路实测 ${F(stalePair[1], 12)} A ｜ 相对差 ${selfRel.toExponential(3)}`);
  ok(stalePair[0] > 0 && stalePair[1] > 0 && selfRel < 1e-2,
    '⚠ **不变量**：R<=0 时表自报的 state.I 与同回路电阻支路实测电流必须一致（相对差 ' + selfRel.toExponential(3) +
    ' < 1e-2）—— 盖章路径与上报路径对同一个 R<=0 不许给两个答案' + (RED_STALE ? '【红模式：两侧已被喂成故意不一致】' : ''),
    { 自报: stalePair[0], 实测: stalePair[1], 相对差: selfRel, 闭式1e9: cTrue, 红模式: RED_STALE });
  ok(selfA > 0 && selfA < 1e-6,
    '⚠ 旧缺陷的定向回归哨兵：自报值必须在**物理近断路**量级（≈1.5e-9 A），不许回到 1.5e4 A —— 当前自报 ' + F(aZero.I_amp, 3) + ' A，旧缺陷期这里是 1.5e4 A（1e13 倍）',
    { 自报: selfA, 量级上限: 1e-6 });
  ok(cWire / Math.abs(aZero.I_res) > 1e7, '⚠ 同上：真实回路电流与「理想导线」相差 ' + (cWire / Math.abs(aZero.I_res)).toExponential(2) + ' 倍 ⇒ 想表达理想导线请写 0.01，不要写 0', { 比: cWire / Math.abs(aZero.I_res) });

  head('§5 理想电压表支路电流恰为 0（open）；现实电压表必须抽走电流');
  const vR2 = runVolt({ E, r, R: 100, props: {} });
  const vI2 = runVolt({ E, r, R: 100, props: { realistic: false } });
  info(`现实档：U=${F(vR2.U_volt, 9)} I_表=${F(vR2.I_volt, 9)}｜理想档：U=${F(vI2.U_volt, 9)} I_表=${String(vI2.I_volt)}（type='${vI2.branchType}'）`);
  ok(vI2.branchType === 'open' && !(Math.abs(vI2.I_volt || 0) > 0), '理想电压表是 open 支路、支路电流恰为 0（求解器跳过 open 支路）', { type: vI2.branchType, I: vI2.I_volt ?? null });
  ok(Math.abs(vR2.I_volt) > 0, '现实电压表**确实抽走电流**（这才是"现实表扰动电路"的物理点：只断言理想为 0 而不给现实非 0 的见证就是假绿）', { I_表: vR2.I_volt });

  head('§5b 后果断言（补充 b）：理想电压表**串进**回路 ⇒ 断路；现实表串联只是巨大电阻');
  const sIdeal = runVoltSeries({ E, r, R: 10, props: { realistic: false } });
  const sReal = runVoltSeries({ E, r, R: 10, props: {} });
  const cSeriesReal = E / (r + 1e6 + 10);
  info(`串联 理想档：type='${sIdeal.branchType}' I_表=${String(sIdeal.I_volt)} I_R=${String(sIdeal.I_res)}｜串联 现实档：I_表=${F(sReal.I_volt, 15)}（闭式 ${F(cSeriesReal, 15)}）`);
  // ⚠ 不是"恰 0"：求解器给每个节点对地加了 gmin=1e-12（`circuit.js:194`）⇒ 孤立分量里仍有
  //   1e-12 量级的兜底电流。物理上是断路，数值上不是 0 —— 判据必须容得下它（D37 同族）。
  ok(sIdeal.branchType === 'open' && Math.abs(sIdeal.I_volt || 0) === 0 && Math.abs(sIdeal.I_res || 0) <= 1e-9,
    '⚠ 后果：理想电压表串进回路 ⇒ 其余元件失电，只剩 gmin 量级兜底电流 ' + (sIdeal.I_res || 0).toExponential(3) + ' A（`circuit.js:194` 的 1e-12 电导；比现实档小 ' + (Math.abs(sReal.I_res) / Math.max(1e-30, Math.abs(sIdeal.I_res || 1e-30))).toExponential(2) + ' 倍 ⇒ 物理上是断路，不是缺陷）',
    { type: sIdeal.branchType, I_表: sIdeal.I_volt ?? null, I_R: sIdeal.I_res ?? null, 现实档I_R: sReal.I_res });
  ok(Math.abs(sReal.I_volt - cSeriesReal) / cSeriesReal < 1e-9 && sReal.I_volt > 0, '现实电压表串联 = 一个 1e6 Ω 的巨大电阻（回路仍通极小电流，与闭式一致）⇒ 两档后果的**区别**有见证', { 模型: sReal.I_volt, 闭式: cSeriesReal });

  if (RED) {
    head('§6 D47：先证变异体真的生效（可观测行为）');
    const { world: w6, bat: b6, amp: m6, res: r6 } = rigAmp(1.5, 0.5, 10, { realistic: false });
    solveCircuit(w6, []);
    const br6 = m6.circuitBranch();
    ok(br6.r !== IDEAL_LEAD_R && near(br6.r, REAL_A_R, 1e-12), 'D47：变异体已生效 —— realistic:false 时支路 r=' + F(br6.r, 6) + ' Ω（仓库版此处为 ' + IDEAL_LEAD_R + ' Ω）', { 变异版: br6.r, 仓库版: IDEAL_LEAD_R, type: br6.type });
  }
}

console.log('\n电表 理想/现实 探针：' + (fail === 0 ? '全部通过：' + pass + ' 项' : '有失败：' + (pass + fail) + ' 项（失败 ' + fail + '）'));
console.log('METER_JSON ' + JSON.stringify({
  mode: RED_STALE ? 'red-stale' : (RED ? 'red' : 'normal'), summary: `${pass}/${pass + fail}`, passed: pass, failed: fail,
  supported, mutant: mutantNote, base,
  deps: DEPS.map((d) => d.file + '@' + d.sha256.slice(0, 16) + '/' + d.bytes + 'B').join('  '),
}));
process.exit(fail === 0 ? 0 : 1);
