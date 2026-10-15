// ══════════════════════════════════════════════════════════
// 小灯泡热状态探针：灯丝温度 → 实时电阻（plans/10 §5 C6）
//
//   node tools/lamp-thermal-probe.mjs            正常读数
//   node tools/lamp-thermal-probe.mjs --red      D43 红能力（仓库零字节改动）
//   ⚠ 只认上面这两档；**任何别的开关一律 exit=2 明确报错**（不认识的开关 + exit=0 = 空转的绿 ✗）
//   ⚠ 源码级**变异提取器**的输入先剥注释（见文件内 stripComments 处的纪律；附近有自检断言锁这件事）
//
// 为什么存在：`Lamp` 此前只有**纯代数拟合** `resistanceAt(U)`（`R_cold = R_hot/10`、
// `R_now = clamp(u²/P + R_cold)`、`k = (R_now/R_hot)^0.45`）—— 「灯丝温度」被隐式写成
// **电压**的函数，没有热状态这个物理对象。C6 要的是真热状态：温度是状态量，电阻由它给。
//
// 本探针的职责（照 task-48 的范式，四条对应四段）：
//   §1 **冻结基线 / 零回归**：`warmUpTime = 0`（默认）时逐条读数必须与改动前**逐字相同**。
//      改动前后各跑一次本文件，两次 LAMP_JSON 的 `base` 段应完全一致。
//   §2 **热状态存在性与 D37 正控**：`warmUpTime = 0` ⇒ 无热状态；`> 0` ⇒ 温度是真状态量
//      且 ≠ 环境温度（给出见证，避免「≈0」式空断言）。
//   §3 **升温到平衡 + 两个独立见证**：
//      ① 由既有 10 倍冷热比 + 线性 α 反解的额定温度 `T = 20 + 9/α`；
//      ② 辐射四次方定标律 `(T₂⁴−T_env⁴)/(T₁⁴−T_env⁴) = P₂/P₁`（**等效面积 A 会约掉**，
//         所以它与"由额定点反解 A"这个构造无关 —— 这是真独立见证，不是自己比自己）。
//   §4 **功率平衡守卫（测条件，不是对答案）**：稳态断言 `P_电 = P_辐射 + P_对流`
//      （损耗在探针里独立算；照 task-48 §5「测条件」的范式）。
//   §5 **断电降温**：切电后温度与实时电阻都回落（热惯性这一侧不能只有升温）。
//
// 什么改动会让它红（D43 清单）：
//   · `resistanceNow` 去掉 α 项（阻值不随温度变）⇒ §3 的「电阻随温度升」红
//   · 去掉 σ/ε（不辐射）⇒ §4 的功率平衡红、§3 的平衡温度红
//   · `warmUpTime = 0` 时不再走改动前那条 `resistanceAt(0)` ⇒ §1 逐字对照红
//   · 不加 `step` 积分（温度永远等于环境）⇒ §3 的升温红
//
// 驱动顺序与 main.js 同源（`main.js:249-258`）：
//   coupling.buildBranches → solveCircuit → coupling.distribute → world.step（各实体 step）
// 本探针无耦合总线，等价顺序为：`solveCircuit(world, [])` → `lamp.step(dt)`。
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

// ── 未知开关 ⇒ 明确报错退出（不许静默忽略）──
// 理由：不认识的开关 + exit=0 与「我验了」长得一模一样（本探针曾被 `--red=m1` 静默忽略过 ⇒ 空转 ✗）。
{
  const known = new Set(['--red']);
  const bad = process.argv.slice(2).filter((a) => !known.has(a));
  if (bad.length) { console.log(`✗ 不认识的开关：${bad.join(' ')} —— 本探针只认 ${[...known].join(' / ')}`); process.exit(2); }
}

// 纪律（本仓既有）：源码级提取器的输入是**代码**，注释不是它的输入 ⇒ 先剥注释再匹配。
// 反例：提取器"命中"注释里的字面量 ⇒ 变异体变空操作 ⇒ 红档失去牙齿 ✗。
const stripComments = (s) => s.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

// 探针自带的物理常数：**故意不读模型参数**，否则"独立见证"就变成自己比自己。
const SIGMA_SI = 5.670374419e-8;   // W·m⁻²·K⁻⁴ —— SI/CODATA 定义值（由 k、h、c 定出，精确）
const c2k = (c) => c + 273.15;

// ── D36：依赖指纹（每次运行都打，读数才可追溯）──────────────
function fingerprint(url) {
  const buf = readFileSync(url);
  return { file: url.pathname.split('/').slice(-2).join('/'), sha256: createHash('sha256').update(buf).digest('hex').toUpperCase(), bytes: buf.length };
}
const DEPS = [fingerprint(ELECTRICAL), fingerprint(new URL('../src/physics/circuit.js', import.meta.url))];

// ── D43/D47 变异体：源码文本进内存改一处 → 写 %TEMP% → import ──
//   变异：`r20 * (1 + this.props.alpha * (T - 20))` → `r20`
//   ⇒ 实时电阻不再随灯丝温度变化。相对 import 说明符必须改写成绝对 file:// ——
//   %TEMP% 里解析不到仓库相对路径。
let mutantNote = null;
async function loadElectrical() {
  if (!RED) return (await import(ELECTRICAL)).default;
  const rawSrc = readFileSync(ELECTRICAL, 'utf8');
  let src = stripComments(rawSrc);      // ← 提取器的输入必须先剥注释（见文件头那条纪律）
  const before = src;
  src = src.replace(/r20\s*\*\s*\(1\s*\+\s*this\.props\.alpha\s*\*\s*\(T\s*-\s*20\)\)/, 'r20');
  if (src === before) throw new Error('变异未命中：electrical.js 里的实时电阻式没匹配上（先怀疑提取器，D49）');
  const specs = [...src.matchAll(/from\s+'(\.[^']+)'/g)];
  for (const m of specs) src = src.split(`'${m[1]}'`).join(`'${new URL(m[1], ELECTRICAL).href}'`);
  const out = new URL(`file:///${process.env.TEMP.replace(/\\/g, '/')}/xm-lamp-thermal-mutant-${Date.now()}.mjs`);
  writeFileSync(out, src, 'utf8');
  mutantNote = out.href;
  return (await import(out.href)).default;
}
const electricalPlugin = await loadElectrical();

// ── 无头宿主（只装求解器 + 电学器材；与 tools/motor-emf-probe.mjs 同一写法）──
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

// ── 断言器（与 tools/equipment-*.mjs 同一观感）──
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

// ── 物理默认值（与 def.fields 的默认一致；改动前文件没有这些参数，故一律 ?? 兜底）──
const P_DEF = { alpha: 4.5e-3, epsilon: 0.35, sigma: SIGMA_SI, ambientTemp: 20, convCoef: 0, warmUpTime: 0 };
const propsOf = (lamp, key) => (lamp.props[key] !== undefined ? lamp.props[key] : P_DEF[key]);

// ── 独立性见证用的闭式解（只用 α / σ / 温度，不用模型的面积与积分）──
/** ① 由既有「热态阻值 = 10 × 冷态」+ 线性 α 反解的额定灯丝温度（℃，只用 α） */
const ratedTempC = (alpha, ambient) => ambient + 9 / alpha;
/** ② 辐射主导下的四次方定标律：给定 (P1, T1) 与 P2，求 T2（A 已约掉） */
const scaleTempC = (P2, P1, T1C, TenvC) =>
  Math.pow((P2 / P1) * (Math.pow(c2k(T1C), 4) - Math.pow(c2k(TenvC), 4)) + Math.pow(c2k(TenvC), 4), 0.25) - 273.15;
/** 由额定点反解的等效辐射面积（探针自己算一遍；与模型同前提，报告中如实标注） */
const areaM2 = (p) => {
  const Tr = ratedTempC(p.alpha, p.ambientTemp);
  const loss = p.epsilon * SIGMA_SI * (Math.pow(c2k(Tr), 4) - Math.pow(c2k(p.ambientTemp), 4)) + p.convCoef * (Tr - p.ambientTemp);
  return loss > 0 ? (p.ratedP / loss) : 0;
};
/** 独立算一遍损耗（W）：辐射 + 对流 */
const lossW = (T, p, A) =>
  p.epsilon * SIGMA_SI * A * (Math.pow(c2k(T), 4) - Math.pow(c2k(p.ambientTemp), 4)) + p.convCoef * (T - p.ambientTemp);

// ── 场景：一节干电池 + 一只小灯泡，串成单回路 ────────────────
function rig(lampProps, batProps = {}) {
  const world = new World();
  const bat = create('battery', 100, 100);
  const lamp = create('lamp', 220, 100);
  for (const k of Object.keys(lampProps)) lamp.setProp(k, lampProps[k]);
  for (const k of Object.keys(batProps)) bat.setProp(k, batProps[k]);
  world.add(bat, true); world.add(lamp, true);
  world.connect({ e: bat.id, p: 0 }, { e: lamp.id, p: 0 }, 'wire');
  world.connect({ e: lamp.id, p: 1 }, { e: bat.id, p: 1 }, 'wire');
  return { world, bat, lamp };
}
/** 跑 n 个 tick（solve → step，与 main.js 同源），返回末 tick 读数与温度轨迹 */
function run(lampProps, opts = {}) {
  const { drive = null, n = 60, dt = 1 / 60, batProps = { internalR: 0.001 } } = opts;
  const { world, bat, lamp } = rig(lampProps, drive === null ? batProps : { ...batProps, emf: drive });
  const traj = [];
  for (let t = 0; t < n; t++) {
    solveCircuit(world, []);
    lamp.step(dt);
    // 升温发生在 ~τ 量级（τ = warmUpTime），故前 24 个 tick 逐 tick 采样，否则会跳过整段上升。
    if (t < 24 || t === n - 1) {
      traj.push({ t, P: Math.abs(lamp.state.P || 0), T: lamp.state.filamentTemp, R: lamp.state.filamentR });
    }
  }
  return {
    drive: bat.props.emf, n, dt, traj,
    I: lamp.state.I, U: lamp.state.U, P: lamp.state.P, R: lamp.state.R,
    temp: lamp.state.filamentTemp, filamentR: lamp.state.filamentR,
    balanceTemp: lamp.state.balanceTemp, heatIn: lamp.state.heatIn, heatOut: lamp.state.heatOut,
    instantR: lamp.resistanceAt(Math.abs(lamp.state.U || 0)),
    ratedV: lamp.props.ratedV, ratedP: lamp.props.ratedP,
    props: {
      alpha: propsOf(lamp, 'alpha'), epsilon: propsOf(lamp, 'epsilon'), sigma: propsOf(lamp, 'sigma'),
      ambientTemp: propsOf(lamp, 'ambientTemp'), convCoef: propsOf(lamp, 'convCoef'), warmUpTime: propsOf(lamp, 'warmUpTime'),
    },
    lamp,
  };
}
/** 同一次运行里：先跑到稳态，再切断电源继续跑（§5 降温） */
function runWithCut(lampProps, opts = {}) {
  const { drive, n = 900, nAfter = 120, dt = 1 / 60, batProps = { internalR: 0.001 } } = opts;
  const { world, bat, lamp } = rig(lampProps, { ...batProps, emf: drive });
  for (let t = 0; t < n; t++) { solveCircuit(world, []); lamp.step(dt); }
  const hot = { temp: lamp.state.filamentTemp, filamentR: lamp.state.filamentR };
  bat.setProp('emf', 0);
  let prev = hot.temp, monotone = true, after = null;
  for (let t = 0; t < nAfter; t++) {
    solveCircuit(world, []); lamp.step(dt);
    const T = lamp.state.filamentTemp;
    if (!(T <= prev + 1e-9)) monotone = false;   // 降到环境温度后浮点停在同一值上 ⇒ 按"非增 + 容差"判
    prev = T; after = { temp: T, filamentR: lamp.state.filamentR };
  }
  return { hot, after, monotone, lamp };
}

const warmUpSupported = !!(DEFS.get('lamp') && Object.prototype.hasOwnProperty.call(DEFS.get('lamp').defaults, 'warmUpTime'));
const KEYS = (t) => Object.keys(DEFS.get(t) ? DEFS.get(t).defaults : {});

console.log('小灯泡热状态探针（C6）  ' + (RED ? '\x1b[35m[变异体]\x1b[0m' : '[正常]'));
console.log('    \x1b[90m命令行：' + process.argv.join(' ') + '\x1b[0m');
console.log('    \x1b[90m平台：' + process.platform + ' node ' + process.version + '\x1b[0m');
for (const d of DEPS) console.log('    \x1b[90m依赖：' + d.file + '  ' + d.sha256 + '  ' + d.bytes + ' B\x1b[0m');
if (mutantNote) console.log('    \x1b[90m变异体（D47 待证生效）：' + mutantNote + '\x1b[0m');

// ══════════════════════════════════════════════════════════
head('§0 前置：小灯泡可用、可接线、参数可声明');
// ══════════════════════════════════════════════════════════
// ── 自检：证明上面那条纪律不是装饰 ──
{
  const RAW = readFileSync(ELECTRICAL, 'utf8');
  const GUARD = 'r20 * (1 + this.props.alpha * (T - 20))';
  const pred = (s) => /r20\s*\*\s*\(1\s*\+\s*this\.props\.alpha\s*\*\s*\(T\s*-\s*20\)\)/.test(s);
  ok('自检：剥注释后，注释里的标志字面量**不**算"代码里有"', pred(stripComments('  // ' + GUARD + '\n')) === false);
  ok('自检：同一条**不**剥注释就会命中（假绿机制真实存在）', pred('  // ' + GUARD + '\n') === true);
  ok('自检：剥注释确实改动过真源码文本（否则本自检是空转）', stripComments(RAW) !== RAW && stripComments(RAW).length < RAW.length);
}
ok(!!DEFS.get('lamp'), '小灯泡在注册表里');
ok((DEFS.get('lamp').ports || []).length >= 2, '小灯泡有 ≥2 个 wire 端口（否它进不了电路）', (DEFS.get('lamp').ports || []).length);
{
  const { lamp } = rig({ ratedV: 3.8, ratedP: 0.75 });
  ok(typeof lamp.circuitBranch === 'function' && typeof lamp.resistanceAt === 'function', '小灯泡有 circuitBranch() 与 resistanceAt()');
  info('warmUpTime 是否已支持：' + warmUpSupported + '（可声明键：' + KEYS('lamp').join(' ') + '）');
}

// ══════════════════════════════════════════════════════════
head('§1 冻结基线 / 零回归：warmUpTime = 0（默认）时逐条读数（改动前后必须逐字相同）');
// ══════════════════════════════════════════════════════════
const RATED = [{ ratedV: 3.8, ratedP: 0.75 }, { ratedV: 6, ratedP: 3 }, { ratedV: 12, ratedP: 6 }];
const base = {};
for (const r of RATED) {
  const { lamp } = rig(r);
  const name = `${r.ratedV}V ${r.ratedP}W`;
  base[name] = { R_at: {} };
  for (const u of [0, 1.5, 3.8, 6, 12]) base[name].R_at['U=' + u] = lamp.resistanceAt(u);
  const dc = run(r, { drive: 1.5, n: 60 });
  base[name].dc15 = { I: dc.I, U: dc.U, P: dc.P, R: dc.R, instantR: dc.instantR };
  const dr = run(r, { drive: r.ratedV, n: 60 });
  base[name].dcRated = { I: dr.I, U: dr.U, P: dr.P, R: dr.R };
  info(`${name}：resistanceAt(0)=${F(lamp.resistanceAt(0), 9)}  resistanceAt(${r.ratedV})=${F(lamp.resistanceAt(r.ratedV), 9)}`);
  info(`${name} 驱动 1.5V：I=${F(dc.I, 9)} U=${F(dc.U, 9)} P=${F(dc.P, 9)} R=${F(dc.R, 9)}`);
  info(`${name} 驱动 ${r.ratedV}V：I=${F(dr.I, 9)} U=${F(dr.U, 9)} P=${F(dr.P, 9)} R=${F(dr.R, 9)}`);
}
{
  const R_hot = 3.8 * 3.8 / 0.75, R_cold = R_hot / 10;
  // 既有曲线的冷端闭式：R(0) = R_cold + (R_hot − R_cold)·(R_cold/R_hot)^0.45
  // ⚠ 冷端**不是** R_cold：k 变换把 U→0 抬到 ≈0.42·R_hot（下面是实测复核）
  const coldClamp = R_cold + (R_hot - R_cold) * Math.pow(R_cold / R_hot, 0.45);
  ok(near(base['3.8V 0.75W'].R_at['U=0'], coldClamp, 1e-12), 'U→0 的阻值 = 既有曲线冷端闭式 R_cold+(R_hot−R_cold)(R_cold/R_hot)^0.45（≈0.42·R_hot，不是 R_cold）', { 实测: base['3.8V 0.75W'].R_at['U=0'], 闭式: coldClamp, R_cold, 与R_hot之比: base['3.8V 0.75W'].R_at['U=0'] / R_hot });
  const P = base['3.8V 0.75W'].dcRated.P;
  ok(P > 0.7 && P < 0.8, '额定驱动下功率落在额定值附近（0.7–0.8 W，串联内阻 0.001Ω）', { P });
}

// ══════════════════════════════════════════════════════════
head('§2 热状态存在性与 D37 正控（warmUpTime = 0 必须无热状态；> 0 必须真升温）');
// ══════════════════════════════════════════════════════════
if (!warmUpSupported) {
  info('不适用：改动前的 electrical.js 没有 warmUpTime 参数 ⇒ 灯泡无热状态（这正是 C6 要补的差距）');
  ok(base['3.8V 0.75W'].dcRated.I !== 0, 'D37 正控：基线读数非零（见证"无热状态"不是空断言）', { I: base['3.8V 0.75W'].dcRated.I });
} else {
  const cold = run({ ratedV: 3.8, ratedP: 0.75, warmUpTime: 0 }, { drive: 3.8, n: 300 });
  const hot = run({ ratedV: 3.8, ratedP: 0.75, warmUpTime: 0.05 }, { drive: 3.8, n: 900 });
  info(`warmUpTime=0（默认）：filamentTemp=${F(cold.temp)} ℃（未定义 = 未启用热状态）`);
  info(`warmUpTime=0.05：稳态 filamentTemp=${F(hot.temp, 3)} ℃  filamentR=${F(hot.filamentR, 6)} Ω  balanceTemp=${F(hot.balanceTemp, 3)} ℃`);
  ok(!isFinite(cold.temp), 'warmUpTime = 0 ⇒ 不写 filamentTemp（零回归：默认不产生热状态）', { filamentTemp: cold.temp ?? null });
  ok(isFinite(hot.temp) && hot.temp > hot.props.ambientTemp + 100, 'D37 正控：warmUpTime > 0 ⇒ 灯丝温度是真状态量且远高于环境（给出见证，不是"≈0"）', { T: hot.temp, 环境: hot.props.ambientTemp });
  ok(isFinite(hot.filamentR) && hot.filamentR > base['3.8V 0.75W'].R_at['U=0'] * 2, '实时电阻确实由温度给出（远大于冷态值）', { 实时: hot.filamentR, 冷态: base['3.8V 0.75W'].R_at['U=0'] });
  {
    // ⚠ 已知差异，如实断言（不掩盖）：热模型的 20℃ 参考阻值是 R_hot/10，而既有代数曲线
    //   在 U→0 时因 k 变换给出 ≈0.42·R_hot ⇒ 两种模式的**冷端**不一致；**额定点重合**。
    const { lamp: lc } = rig({ ratedV: 3.8, ratedP: 0.75, warmUpTime: 0.05 });
    lc.state.filamentTemp = lc.props.ambientTemp;
    const rColdThermal = lc.resistanceNow();
    ok(rColdThermal * 2 < base['3.8V 0.75W'].R_at['U=0'], '⚠ 已知差异（本文如实断言）：热模型 20℃ 给 0.10·R_hot，既有曲线 U→0 给 0.42·R_hot ⇒ 冷端相差 ' + F(base['3.8V 0.75W'].R_at['U=0'] / rColdThermal, 2) + '×；额定点两者重合（见上一节）', { 热模型20度: rColdThermal, 代数U到0: base['3.8V 0.75W'].R_at['U=0'], 冷端比值: base['3.8V 0.75W'].R_at['U=0'] / rColdThermal });
  }

  // ── §3 升温到平衡 + 两个独立见证 ──
  head('§3 升温到平衡：单调升温 + 两个独立见证（①额定温度闭式解 ②四次方定标律，A 会约掉）');
  const temps = hot.traj.map((x) => x.T).filter((x) => isFinite(x));
  ok(temps.length >= 3 && temps.every((T, i) => i === 0 || T >= temps[i - 1]) && temps[temps.length - 1] > temps[0] * 1.5, '温度逐点非降且确实大幅上升（热惯性：不是瞬间跳到平衡；前 24 tick 逐 tick 采样）', temps.map((x) => +x.toFixed(1)));
  const Tr_witness = ratedTempC(hot.props.alpha, hot.props.ambientTemp);
  info(`独立见证①：由「热态 = 10×冷态」+ α=${hot.props.alpha} 闭式反解额定温度 = ${F(Tr_witness, 2)} ℃`);
  ok(near(hot.balanceTemp, Tr_witness, 2e-2), '额定驱动下平衡温度 ≈ 闭式解 20 + 9/α（两个来源独立：一个是 T⁴ 辐射平衡，一个是电阻比 10）', { 模型平衡: hot.balanceTemp, 闭式: Tr_witness });
  ok(Math.abs(hot.balanceTemp - hot.temp) <= 0.02 * Math.abs(hot.balanceTemp), '稳态温度与平衡温度读数自洽（探针真的跑到了稳态）', { 稳态: hot.temp, 平衡: hot.balanceTemp });

  const half = run({ ratedV: 3.8, ratedP: 0.75, warmUpTime: 0.05 }, { drive: 2.2, n: 900 });
  const T1 = hot.temp, P1 = Math.abs(hot.P), T2 = half.temp, P2 = Math.abs(half.P);
  const T2_witness = scaleTempC(P2, P1, T1, hot.props.ambientTemp);
  info(`独立见证②：P₁=${F(P1, 6)} W @ T₁=${F(T1, 2)} ℃ ⇒ 按 T⁴ 律 P₂=${F(P2, 6)} W 应给出 T₂=${F(T2_witness, 2)} ℃（A 已约掉）`);
  ok(near(T2, T2_witness, 3e-2), '第二个驱动点的稳态温度符合四次方定标律（A 在该式里约掉 ⇒ 与"由额定点反解 A"的构造无关）', { 模型: T2, 闭式: T2_witness, P1, P2 });

  // ── §4 功率平衡守卫（测条件）──
  head('§4 功率平衡守卫（测条件，不是对答案）：稳态 P_电 = P_辐射 + P_对流');
  for (const r of [hot, half]) {
    const p = r.props;
    const A = areaM2({ ...p, ratedP: r.ratedP });
    const Pin = Math.abs(r.U * r.I);
    const Pout = lossW(r.temp, p, A);
    info(`驱动 ${r.drive}V：P_电=${F(Pin, 6)} W  独立算的损耗=${F(Pout, 6)} W（A=${F(A, 9)} m²，由额定点反解）`);
    ok(near(Pin, Pout, 2e-3), '稳态功率平衡：电功率 = 辐射 + 对流损耗（探针独立算损耗；这条在任何驱动点都必须成立）', { 电: Pin, 损耗: Pout, 相对误差: Math.abs(Pin - Pout) / Math.max(1e-12, Pin) });
  }

  // ── §5 断电降温 ──
  head('§5 断电降温：切断电源后温度与实时电阻都回落（热惯性不能只有升温一侧）');
  const cut = runWithCut({ ratedV: 3.8, ratedP: 0.75, warmUpTime: 0.05 }, { drive: 3.8, n: 900, nAfter: 300 });
  info(`切电前 T=${F(cut.hot.temp, 2)} ℃ R=${F(cut.hot.filamentR, 6)} Ω ⇒ 切电后 T=${F(cut.after.temp, 2)} ℃ R=${F(cut.after.filamentR, 6)} Ω`);
  ok(cut.monotone && cut.after.temp < cut.hot.temp, '切电后温度单调不增（降到环境温度后停在同一值，容差 1e-9）', { 前: cut.hot.temp, 后: cut.after.temp });
  ok(cut.after.filamentR < cut.hot.filamentR, '切电后实时电阻随之下降（电阻跟随温度，而不是跟随电压）', { 前: cut.hot.filamentR, 后: cut.after.filamentR });

  // ── D47：先证变异体真的生效（可观测行为，不用反射）──
  if (RED) {
    const { lamp: m47 } = rig({ ratedV: 3.8, ratedP: 0.75, warmUpTime: 0.05 });
    m47.state.filamentTemp = 2000;
    const R47 = m47.resistanceNow();
    const R20 = m47.props.ratedV * m47.props.ratedV / m47.props.ratedP / 10;
    ok(near(R47, R20, 1e-9), 'D47：变异体已生效 —— 钉住 filamentTemp=2000 ℃ 时 resistanceNow()=' + F(R47, 6) + ' Ω（仓库版此处为 ' + F(R20 * (1 + 0.0045 * 1980), 6) + ' Ω）', { 变异版: R47, 仓库版: R20 * (1 + 0.0045 * 1980) });
  }
}

const summary = `${pass}/${pass + fail}`;
console.log('\n小灯泡热状态探针：' + (fail === 0 ? '全部通过：' + pass + ' 项' : '有失败：' + (pass + fail) + ' 项（失败 ' + fail + '）'));
console.log('LAMP_JSON ' + JSON.stringify({
  mode: RED ? 'red' : 'normal', summary, passed: pass, failed: fail,
  warmUpSupported, mutant: mutantNote, base,
  deps: DEPS.map((d) => d.file + '@' + d.sha256.slice(0, 16) + '/' + d.bytes + 'B').join('  '),
}));
process.exit(fail === 0 ? 0 : 1);
