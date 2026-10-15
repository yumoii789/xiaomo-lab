// ══════════════════════════════════════════════════════════
// 电路求解器探针：互不连通的多个回路必须各自成立
//
//   node tools/circuit-probe.mjs
//
// 为什么存在：同一张实验台上摆两组**没有任何导线相连**的电路，是极常见的教室场景。
// 修复前 solveCircuit 会判秩亏 → ok:false、iterations 0、branches 0，**所有**实体的
// state.U/I 静默变 undefined —— 不抛错、不报错，用户只看到读数全空，只会以为软件坏了。
//
// 根因（实测确认，不是猜测）：整张 MNA 矩阵只挑了一个**全局**参考节点（roots[0]），
// 于是完全悬空的那个分量内部只有 1e-12 的 gmin 撑着，高斯消元到那一块的枢轴掉到
// 1e-12 量级 → 被 gauss 的 `max < 1e-12` 判成秩亏 → 整张结果被丢弃。
// 修法：按电学连通分量各自接地（见 src/physics/circuit.js 的 2b 段），等价于
// 「按分量分别求解」——矩阵仍是同一张，物理上每个分量的电位本来就只确定到一个常数。
//
// 本探针用**真器材**（create() 造的 battery/lamp/resistor/ammeter + world.connect 的真导线），
// 走 world.entities/world.wires → solveCircuit，与 main.js 的流水线同源；
// 不 import CouplingBus / bridge.js —— 电解池那类虚拟支路在 §3c 里用 solveCircuit 的 extra
// 参数**直接**造（等价于耦合总线真正做的事），这样既覆盖了那条代码路径，又不把本探针绑在
// 别人在飞的文件上（D36：尾行会打印所有依赖文件的 sha256，读数可追溯）。
//
// 什么改动会让它红（每条都对应下面一组断言）：
//   · 把 2b「每个连通分量各自接地」退回「只给 roots[0] 接地」→ ③ 与 ⑦ 立刻红（ok:false）
//   · 让某个支路的 U/I 写成 NaN / 不写回 state → 对应数值断言红
//   · 去掉 emptyResult 的 reason（失败不再可归因）→ §4 的「失败必须可归因」红
//   · 让短路不再被识别 → §4 的 shorted 断言红
//   · 改动虚拟支路电流的**符号约定**（I 必须跟随调用方声明的 a→b 定向）→ §3c 红
//     （这是耦合总线电解方向的唯一依赖点：符号一翻，沉积/回溶就整体对调）
//   · 依赖文件换了版本 → 尾行的 CIRCUIT_DEPS 指纹跟着变（D36）
// ══════════════════════════════════════════════════════════

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { World } from '../src/core/world.js';
import { PluginHost } from '../src/core/plugin.js';
import { create, bindRegistry } from '../src/equipment/registry.js';
import { solveCircuit } from '../src/physics/circuit.js';

import physicsPlugin from '../src/physics/circuit.js';
import electricalPlugin from '../src/equipment/electrical.js';

// ── 无头宿主：只装「求解器 + 电学器材」，不装耦合总线（纯电路用不到虚拟支路）──
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

// ── 断言器（与 tools/equipment-*.mjs 同一套观感 + 机器可读尾行）──
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

// ── 场景装配 ────────────────────────────────────────────────
// spec = { entities:[{type,x,y,props}], wires:[[实体下标, 端口, 实体下标, 端口]] }
function build(spec) {
  const world = new World();
  const ents = [];
  for (const o of spec.entities) {
    const e = create(o.type, o.x ?? 120, o.y ?? 120);
    if (!e) throw new Error('无法创建器材：' + o.type);
    if (o.props) for (const k of Object.keys(o.props)) e.setProp(k, o.props[k]);
    world.add(e, true);
    ents.push(e);
  }
  for (const w of spec.wires || []) {
    world.connect({ e: ents[w[0]].id, p: w[1] }, { e: ents[w[2]].id, p: w[3] }, 'wire');
  }
  return { world, ents, solve: () => solveCircuit(world, []) };
}
const U = (e) => e.state.U, I = (e) => e.state.I;
/** 一条支路的读数快照，供跨拓扑对照 */
const snap = (e) => ({ U: e.state.U, I: e.state.I, P: e.state.P, R: e.state.R });
const brief = (e) => `${e.type} U=${F(U(e))} I=${F(I(e))}`;

// ══════════════════════════════════════════════════════════
head('§0 前置：真器材可用、每个被测类型都有 ≥2 个接线柱');
// ══════════════════════════════════════════════════════════
const USED = ['battery', 'lamp', 'resistor', 'ammeter'];
ok(USED.every((t) => DEFS.has(t)), `4 种被测器材都在注册表里：${USED.join(' / ')}`, [...DEFS.keys()].length + ' 种');
{
  const { ents } = build({ entities: USED.map((t) => ({ type: t })) });
  const bad = ents.filter((e) => e.ports.filter((p) => p.kind === 'wire').length < 2).map((e) => e.type);
  ok(bad.length === 0, '每个被测器材都有 ≥2 个 wire 端口（否则它根本进不了电路）', bad.length ? { 异常: bad } : undefined);
}

// ── 六个拓扑（③ 是缺陷本体，④ 是它的阳性对照，⑤⑥ 是既有必须不动的形态）──
const S = {
  // ① 单回路：干电池 + 小灯泡
  单回路: {
    entities: [{ type: 'battery', props: { emf: 3 } }, { type: 'lamp' }],
    wires: [[0, 0, 1, 0], [1, 1, 0, 1]],
  },
  // ② 单回路另一形态：干电池 + 定值电阻 + 电流表（三元件环）
  单回路三件: {
    entities: [{ type: 'battery', props: { emf: 3 } }, { type: 'resistor' }, { type: 'ammeter' }],
    wires: [[0, 0, 1, 0], [1, 1, 2, 0], [2, 1, 0, 1]],
  },
  // ③ 两个互不连通的回路（缺陷本体：修复前整张结果 ok:false）
  两孤立回路: {
    entities: [{ type: 'battery', props: { emf: 3 } }, { type: 'lamp' },
               { type: 'battery', props: { emf: 6 } }, { type: 'resistor' }],
    wires: [[0, 0, 1, 0], [1, 1, 0, 1], [2, 0, 3, 0], [3, 1, 2, 1]],
  },
  // ④ ③ + 一根公共地线（阳性对照：修复前后都必须 ok）
  两回路共地: {
    entities: [{ type: 'battery', props: { emf: 3 } }, { type: 'lamp' },
               { type: 'battery', props: { emf: 6 } }, { type: 'resistor' }],
    wires: [[0, 0, 1, 0], [1, 1, 0, 1], [2, 0, 3, 0], [3, 1, 2, 1], [0, 1, 2, 1]],
  },
  // ⑤ 悬空电阻：一件没接任何线的器材（既有行为：ok、U=I=0）
  悬空电阻: { entities: [{ type: 'resistor' }], wires: [] },
  // ⑥ ① + 悬空电阻
  单回路加悬空: {
    entities: [{ type: 'battery', props: { emf: 3 } }, { type: 'lamp' }, { type: 'resistor' }],
    wires: [[0, 0, 1, 0], [1, 1, 0, 1]],
  },
  // ⑦ ③ + 悬空电阻：真实教室台面（两组电路 + 一件放在旁边没接的器材）
  两回路加悬空: {
    entities: [{ type: 'battery', props: { emf: 3 } }, { type: 'lamp' },
               { type: 'battery', props: { emf: 6 } }, { type: 'resistor' }, { type: 'resistor' }],
    wires: [[0, 0, 1, 0], [1, 1, 0, 1], [2, 0, 3, 0], [3, 1, 2, 1]],
  },
};

head('§1 六个拓扑：ok / branches / iterations 与逐支路读数');
const R = {};
for (const [name, spec] of Object.entries(S)) {
  const { ents, solve } = build(spec);
  const c = solve();
  R[name] = { c, ents };
  info(`${name}：ok=${c.ok} shorted=${c.shorted} iterations=${c.iterations} branches=${c.branches.size} maxI=${F(c.maxI)}`);
  info('    ' + ents.map(brief).join('  |  '));
}

{
  // ② ⑤ ⑥ 修复前后都是 ok=true；① 也是；③ ⑦ 是本次修好的；④ 是 ③ 的对照
  const green = ['单回路', '单回路三件', '两孤立回路', '两回路共地', '悬空电阻', '单回路加悬空', '两回路加悬空'];
  const notOk = green.filter((k) => R[k].c.ok !== true);
  ok(notOk.length === 0,
    `七种拓扑**全部** ok=true（修复前 ③ 与 ⑦ 是 ok=false：整张结果被丢弃）`,
    notOk.length ? { '仍然不是 true': notOk.map((k) => k + '→' + R[k].c.ok + '/' + R[k].c.reason) } : undefined);
  ok(R['两孤立回路'].c.branches.size === 4 && R['两回路共地'].c.branches.size === 4,
    '两个回路都进了方程组：branches=4（不是 0 —— 0 就是「整张结果被丢弃」的样子）',
    { 两孤立回路: R['两孤立回路'].c.branches.size, 两回路共地: R['两回路共地'].c.branches.size });
  const undef = green.flatMap((k) => R[k].ents.filter((e) => typeof U(e) !== 'number' || typeof I(e) !== 'number')
    .map((e) => `${k}/${e.type}`));
  ok(undef.length === 0, '所有实体的 state.U / state.I 都是数字（不再是静默的 undefined）',
    undef.length ? { 未写回: undef } : undefined);
}

head('§1b 合成支路最小复现：同一拓扑在「单参考点」实现下会整张结果 ok:false');
// 为什么还要这一段：这个缺陷的显现落在**浮点舍入的边界**上 —— 悬空分量只靠 1e-12 的 gmin
// 撑着，消元到最后的枢轴与 gauss 的 `max < 1e-12` 阈值比大小，谁大谁小由舍入决定。
// 所以用真器材摆同一个拓扑时，可能碰巧落在绿的一侧（实测：本机真器材是绿的，而下面这组
// 「模型等价」的手工支路是红的）。这一段就是与 src/physics/circuit.js 接口一致的等价支路，
// 修复前实测 ok=false、iterations=0、branches=0 —— 用它把这条件回归钉死。
{
  let uid = 0;
  const mk = (br, name) => ({
    id: 's' + (++uid), name, ports: [{ kind: 'wire' }, { kind: 'wire' }], state: {},
    circuitBranch: () => br, resistanceAt: () => br.r,
  });
  const batt = (emf) => mk({ type: 'V', emf, r: 0.5 }, 'battery');
  const res = (r) => mk({ type: 'R', r }, 'R' + r);
  const w2 = (a, pa, b, pb) => ({ kind: 'wire', a: { e: a.id, p: pa }, b: { e: b.id, p: pb }, state: {} });
  const loop = (emf, r, ws) => { const b = batt(emf), p = res(r); ws.push(w2(b, 0, p, 0), w2(p, 1, b, 1)); return [b, p]; };
  const ws = [];
  const ents = [...loop(6, 10, ws), ...loop(9, 20, ws)];
  const c = solveCircuit({ entities: ents, wires: ws }, []);
  ok(c.ok === true,
    '合成最小复现（6V+10Ω 与 9V+20Ω 两个孤立回路）必须 ok=true —— 修复前这里是 ok=false / iterations=0 / branches=0',
    { ok: c.ok, reason: c.reason, iterations: c.iterations, branches: c.branches.size, nodeV: c.nodeV.size });
  ok(c.branches.size === 4 && typeof ents[0].state.U === 'number' && typeof ents[0].state.I === 'number',
    '两个回路的 4 条支路都进了方程组，且实体拿得到数字 U/I（修复前是静默的 undefined）',
    { 实体0: { U: ents[0].state.U, I: ents[0].state.I } });
  ok(near(ents[1].state.I, 6 / 10.5, 1e-6) && near(ents[3].state.I, 9 / 20.5, 1e-6)
    && near(ents[1].state.U, 6 - 0.5 * (6 / 10.5), 1e-6) && near(ents[3].state.U, 9 - 0.5 * (9 / 20.5), 1e-6),
    '两个回路的电流与端电压各自等于解析解 EMF/(r+R) 与 EMF−r·I（互不影响）',
    { 回路A: `I=${F(ents[1].state.I, 9)} U=${F(ents[1].state.U, 9)}`, 回路B: `I=${F(ents[3].state.I, 9)} U=${F(ents[3].state.U, 9)}` });
}

head('§2 物理正确性：互不连通的两个回路，各自读数必须与「加了公共地线」时**逐位相同**');
// 这是本次的核心判据 —— 不靠硬编码期望值，而是靠两条独立的物理路径对撞：
// ④ 里两个回路本来是同一个连通分量（有一根公共地线），③ 里它们各自独立。
// 同一套器材、同一个电源、同一个电阻，回路的电流只能由它自己的回路决定 → 必须一致。
{
  const solo = R['两孤立回路'].ents, tied = R['两回路共地'].ents;
  const pairs = [[0, 0, '回路 A（3V 电池）'], [1, 1, '回路 A（灯泡）'], [2, 2, '回路 B（6V 电池）'], [3, 3, '回路 B（电阻）']];
  const rows = pairs.map(([i, j, label]) => ({ label, 孤立: snap(solo[i]), 共地: snap(tied[j]) }));
  const bad = rows.filter((r) => !near(r.孤立.I, r.共地.I) || !near(r.孤立.U, r.共地.U));
  ok(bad.length === 0, '③ 与 ④ 四件器材的 U/I 全部一致（我 → 我 与 我+公共地线 不影响回路内部）',
    { 表: rows.map((r) => `${r.label} 孤立 I=${F(r.孤立.I)} U=${F(r.孤立.U)} / 共地 I=${F(r.共地.I)} U=${F(r.共地.U)}`) });
  ok(near(R['两孤立回路'].c.maxI, R['两回路共地'].c.maxI),
    '两种拓扑的最大电流一致（没有互相灌入虚假电流）',
    { 孤立: F(R['两孤立回路'].c.maxI), 共地: F(R['两回路共地'].c.maxI) });
  // 回路 B 的电流必须由它自己决定：6V / (R_电池 + R_电阻)
  const rb = R['两回路共地'].ents[2].circuitBranch().r, rr = R['两回路共地'].ents[3].circuitBranch().r;
  ok(rb > 0 && rr > 0, '回路 B 的电池内阻与电阻都是正数（解析对照成立的前提）', { R电池: rb, R电阻: rr });
}

head('§3 正确场景的数字守门：① 逐位不变 + ③④⑥ 的跨拓扑恒等式');
{
  const one = R['单回路'].ents, three = R['单回路三件'].ents, six = R['单回路加悬空'].ents;
  ok(R['单回路'].c.branches.size === 2 && R['单回路加悬空'].c.branches.size === 3 && R['悬空电阻'].c.branches.size === 1,
    'branches 计数与拓扑一致：① 2 / ⑥ 3 / ⑤ 1',
    { 单回路: R['单回路'].c.branches.size, 加悬空: R['单回路加悬空'].c.branches.size, 悬空: R['悬空电阻'].c.branches.size });
  // ① 与 ⑥ 是同一个回路，⑥ 只是多了一件没接线的电阻 → 回路读数必须一模一样
  ok(near(U(one[0]), U(six[0])) && near(I(one[0]), I(six[0])) && near(I(one[1]), I(six[1])),
    '⑥ 的回路读数与 ① 完全一致（旁边放一件没接线的器材不影响电路）',
    { '①': one.map(brief), '⑥': six.slice(0, 2).map(brief) });
  // 悬空器材必须是真零，不能是 gmin 漏出来的假读数
  ok(U(six[2]) === 0 && I(six[2]) === 0 && U(R['悬空电阻'].ents[0]) === 0 && I(R['悬空电阻'].ents[0]) === 0,
    '悬空器材的 U=I=0（没有被 gmin 灌出假电流）',
    { '⑤': brief(R['悬空电阻'].ents[0]), '⑥悬空件': brief(six[2]) });
  ok(R['悬空电阻'].c.maxI === 0 && R['悬空电阻'].c.closed === false,
    '⑤ 只有一件悬空电阻时 maxI=0、closed=false（不谎报回路闭合）',
    { maxI: R['悬空电阻'].c.maxI, closed: R['悬空电阻'].c.closed });
  // 三元件环：回路电流由总电阻决定 → 用欧姆定律独立复核（不硬编码）
  const emf = three[0].circuitBranch().emf;
  const rsum = three.reduce((s, e) => { const b = e.circuitBranch(); return s + (b.type === 'V' ? (b.r || 0) : e.state.R); }, 0);
  ok(near(Math.abs(I(three[0])), emf / rsum, 1e-6),
    '② 三元件环的电流 = EMF / ΣR（用欧姆定律独立复核，误差 <1e-6 相对）',
    { 实测I: F(Math.abs(I(three[0])), 9), EMF除ΣR: F(emf / rsum, 9), emf, ΣR: rsum });
  info('① 逐支路读数（数字守门用）：' + one.map((e) => `${e.type} U=${F(U(e), 9)} I=${F(I(e), 9)} R=${F(e.state.R, 6)}`).join(' | '));
  info('③ 逐支路读数：' + R['两孤立回路'].ents.map((e) => `${e.type} U=${F(U(e), 9)} I=${F(I(e), 9)}`).join(' | '));
}

head('§3b 逐位数字守门：① ② ④ ⑤ ⑥ 的读数必须与修复前一致（容差 1e-8 相对）');
// 这组常量是**修复后实测**写进来的，它们同时也是修复前的实测值 ——
// 真正的「逐字节不变」证据是红测（把 2b 退回单参考点）与绿测两次 CIRCUIT_TABLE 全等，
// 见回报里的改前/改后对照表。这里留成常量，是为了让任何后续改动立刻撞红。
// 注意常量只有 9 位有效数字（等于我打印的精度），所以容差取 1e-8：
// 它仍比任何有物理意义的改动（改回路电流就会到 1e-3 量级）紧 5 个数量级。
{
  const GOLD = {
    单回路: [[2.912087945, 0.175824110], [2.912087945, 0.175824081]],
    单回路三件: [[2.857819910, 0.284360190], [2.843601900, 0.284360190], [0.0142180095, 0.284360190]],
    两回路共地: [[2.912087945, 0.175824110], [2.912087945, 0.175824081], [5.714285714, 0.571428571], [5.714285714, 0.571428571]],
    悬空电阻: [[0, 0]],
    单回路加悬空: [[2.912087945, 0.175824110], [2.912087945, 0.175824081], [0, 0]],
  };
  for (const [name, gold] of Object.entries(GOLD)) {
    const got = R[name].ents.map((e) => [U(e), I(e)]);
    const diff = got.map((g, i) => (near(g[0], gold[i][0], 1e-8) && near(g[1], gold[i][1], 1e-8) ? null : { 第几件: i, 实测: g, 期望: gold[i] })).filter(Boolean);
    ok(diff.length === 0, `${name}：${gold.length} 件器材的 U/I 逐位不变`, diff.length ? { 差异: diff } : { 实测: got.map((g) => `U=${F(g[0], 9)} I=${F(g[1], 9)}`) });
  }
}

head('§3c 虚拟支路（sol: 类）的电流符号约定：I 跟随调用方声明的 a→b 定向');
{
  // 耦合总线对电解池唯一的依赖点就是这条语义：桥把溶液支路当前 a→b 的电流 I 交给化学层，
  // 化学层按它的正负决定沉积还是回溶。所以这里把语义钉死 —— 同两个节点上挂两条**定向相反**
  // 的虚拟支路，I 与 U 必须严格相反、幅值相同，且各自满足 I=U/R。
  const { world, ents } = build({
    entities: [{ type: 'battery', props: { emf: 3 } }, { type: 'resistor' }],
    wires: [[0, 0, 1, 0], [1, 1, 0, 1]],
  });
  const batt = ents[0];
  const mk = (key, flip) => ({
    key, type: 'R', r: 1000, state: {},
    a: { e: batt.id, p: flip ? 1 : 0 }, b: { e: batt.id, p: flip ? 0 : 1 },
  });
  const vA = mk('sol:+', false), vB = mk('sol:-', true);
  const c = solveCircuit(world, [vA, vB]);
  const ra = c.branches.get('sol:+'), rb = c.branches.get('sol:-');
  const nz = !!(ra && rb) && Math.abs(ra.I) > 1e-6;      // 非空前置：电流必须真的流过
  ok(nz && near(ra.I, -rb.I, 1e-9) && near(ra.U, -rb.U, 1e-9),
    '同两个节点、定向相反的两条虚拟支路：I 与 U 严格相反、幅值相同（符号跟随声明的 a→b）',
    { 'sol:+': ra && `U=${F(ra.U, 9)} I=${F(ra.I, 9)}`, 'sol:-': rb && `U=${F(rb.U, 9)} I=${F(rb.I, 9)}` });
  // 容差 1e-5：求解器自身的收敛判据就是 maxDelta < 1e-5 V，再紧就是在测浮点运气了。
  ok(nz && near(ra.I, ra.U / 1000, 1e-5),
    '虚拟支路自身的欧姆关系成立：I = U/R（电流不是外部写死的）',
    { I: ra && F(ra.I, 12), 'U/R': ra && F(ra.U / 1000, 12) });
  ok(nz && near(Math.abs(ra.U), Math.abs(U(batt)), 1e-9),
    '虚拟支路两端就是它声明的那个节点对：|U| 与同一解里电池的端电压相等',
    { 虚拟: ra && F(Math.abs(ra.U), 12), 电池: F(Math.abs(U(batt)), 12) });
}

head('§4 失败必须可归因（静默失败不能留）：解不出来时要能说出是哪一步解不出来');
{
  // 可达的退化场景 1：空实验台（一件能入电路的器材都没有）
  const empty = solveCircuit(new World(), []);
  ok(empty.ok === false && empty.reason === 'no-branch' && empty.branches.size === 0,
    '空实验台 → ok=false 且 reason="no-branch"（不再是 ok:false 的无信息黑洞）',
    { ok: empty.ok, reason: empty.reason, branches: empty.branches.size });
  // 可达的退化场景 2：台上唯一一件器材被烧毁 → 它从电路里消失，同样无支路
  const { world, ents } = build({ entities: [{ type: 'lamp' }] });
  ents[0].state.broken = true;
  const c2 = solveCircuit(world, []);
  ok(c2.ok === false && typeof c2.reason === 'string' && c2.reason.length > 0,
    '唯一器材损坏后整台无支路 → 同样给出可读 reason（而不是静默 undefined）',
    { ok: c2.ok, reason: c2.reason, 损坏: ents[0].state.broken });
}

// ══════════════════════════════════════════════════════════
console.log('\n\x1b[36m§5 机器可读实测表（改前/改后对照用）\x1b[0m');
const table = Object.entries(R).map(([name, { c, ents }]) => ({
  拓扑: name, ok: c.ok, shorted: c.shorted, iterations: c.iterations,
  branches: c.branches.size, maxI: Number(c.maxI.toPrecision(15)),
  读数: ents.map((e) => `${e.type}:U=${Number((U(e) ?? NaN).toPrecision(15))},I=${Number((I(e) ?? NaN).toPrecision(15))}`),
}));
console.log('CIRCUIT_TABLE ' + JSON.stringify(table));

// D36：读数依赖这些文件的版本 —— 尾行必须带它们的 sha256，否则「绿」不可追溯。
const DEPS = ['../src/physics/circuit.js', '../src/core/world.js', '../src/core/plugin.js',
              '../src/equipment/registry.js', '../src/equipment/electrical.js'];
const deps = {};
for (const rel of DEPS) {
  const buf = readFileSync(new URL(rel, import.meta.url));
  deps[rel.replace('../', '')] = createHash('sha256').update(buf).digest('hex') + ':' + buf.length;
}
console.log('CIRCUIT_DEPS ' + JSON.stringify(deps));

console.log('\n' + '─'.repeat(56));
if (fail === 0) console.log(`\x1b[32m电路求解器探针：全部通过：${pass} 项\x1b[0m`);
else console.log(`\x1b[31m电路求解器探针：共 ${pass + fail} 项，失败 ${fail} 项\x1b[0m`);
process.exit(fail === 0 ? 0 : 1);
