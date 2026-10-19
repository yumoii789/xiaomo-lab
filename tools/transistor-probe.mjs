// ══════════════════════════════════════════════════════════
// 无头验证：BJT / MOSFET 三端非线性契约（task-1）
//
//   node tools/transistor-probe.mjs            # 全部断言
//   node tools/transistor-probe.mjs --mutate   # 每条断言配一个变异体，证明它能红
//   node tools/transistor-probe.mjs --self-check  # §9 的敏感度自证（差分法，见下）
//
// 这份探针要证明八件事（编号对应任务书的验收门 A）：
//   ① 截止区：U_BE 不到阈值 ⇒ I_C ≈ 0（且给出「≈0」的定量口径，不是"看着小"）
//   ② 放大区：实测 I_C ↔ 手推 I_C = β·I_B（含电源内阻/rbe 这些真存在的串联项），给出残差与残差来源
//   ③ 饱和区：U_CE ≥ U_CE(sat)，且饱和判据在两帧之间自我肯定（不存在 ON/OFF 抖动）
//   ④ NPN / PNP 极性相反：同一条镜像电路给出符号相反、幅值一致的解
//   ⑤ MOSFET：阈值 + 跨导**分段**（可变电阻区 k·U_DS ⟷ 恒流区 k·U_ov²，接缝处两式相等）
//   ⑥ 三端当两端用：逐位（Object.is）等于单支路回落，且无假 port-ignored
//   ⑦ 未接线端子不产生假 port-ignored 告警（基极/栅极接线后仍 0 条）
//   ⑧ 每条新断言配一个变异体，--mutate 打印 {expectedRed, observedRed, ctrlBad, ok}
//
// 另外两件不出现在验收门里、但必须证明的事：
//   · §9 与**冻结基准提交**（BASE_COMMIT，task-1 之前那次提交）的逐位回归：把基准版 electronics.js
//     装进镜像树，逐件 Object.is 对比 I/U/P/R 与支路数 ⇒ 「新增器材没有动到任何既有解」。
//     ⚠ 参照物写死成 sha，绝不相对"当前 HEAD"——相对 HEAD 的护栏会随提交把自己变成参照物（恒假），
//       也会被队友的合法提交打红；相对基准则对并发合法编辑免疫（镜像只换 electronics.js）而敏感度不变。
//   · 面板读数：def.stats 的行名必须是「元件名+端子字母」（电压BE/电压CE/电压BC/电压GS…）
//
// ⚠ §9 与 --mutate 的分工：§9 比的是"被测树 vs 冻结基准"，与"被替换的那一行"无关 ⇒ 变异模式里它按设计
//   跳过（否则它的红只反映工作区动没动既有器材，会污染对照组 ctrlBad、毁掉每行变异的归因）。
//   它的敏感度用 --self-check 做**差分自证**：同一棵树只把一件既有器材的支路改成常数 ⇒ §9.bit 必须翻转。
//
// ⚠ 本文件内的所有"手推"都是**独立推导**，不是把实现抄一遍：
//   元件级定律用教科书式子（β·I_B、平方律），电路级解用结点法/回路法，
//   串联项（电源内阻 r内 = 0.01 Ω、发射结串联电阻 rbe = 100 Ω）都如实算进去，
//   算不动的（可变电阻区负载线）就解一元二次方程，并把残差打印出来。
// ⚠ 残差的量级来源（不是拟合出来的，是求解器的既定行为）：定点迭代以 maxDelta < 1e-5 收，
//   所以由**结点电压差**推出来的电流，相对残差在 1e-5 量级以内是正常的；
//   被 V 支路钉住的量、以及支路自身的定律自洽（U = emf + r·I）能到 1e-9 ~ 1e-15。
//   探针里对这两类分别给界（退出条件写死在断言里），不给"万能宽容差"。
// ══════════════════════════════════════════════════════════

import { readFileSync, writeFileSync, mkdirSync, rmSync, cpSync, readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

const known = new Set(['--mutate', '--self-check']);
const unknown = process.argv.slice(2).filter((a) => !known.has(a));
if (unknown.length) {
  console.log(`✗ 不认识的开关：${unknown.join(' ')} —— 本探针只认 ${[...known].join(' / ')}`);
  process.exit(2);
}
const MUTATE = process.argv.includes('--mutate');
const SELFCHECK = process.argv.includes('--self-check');
const SRC_DIR = fileURLToPath(new URL('../src/', import.meta.url));
const ROOT_DIR = fileURLToPath(new URL('../', import.meta.url));
/**
 * §9 的参照物：**冻结的基准提交**，永不随 HEAD 前进。
 *   为什么写死 sha，而不是用 HEAD / HEAD~1：
 *    · 上一版把参照物设成"当前 HEAD"，task-1 一被提交，参照物就变成了它自己 ⇒ 那条断言恒假
 *      （永远不可能绿 = 比没有更坏：它会持续掩盖 §9 里真正的回归）；
 *    · HEAD 会随任何新提交前进、HEAD~1 会随历史重写漂移 —— 参照物跟着动，护栏就不是护栏了。
 *   来历：BASE_COMMIT 是 TASK1_COMMIT 的父提交（见 S9.base.commit 的祖先断言 + S9.hist.scope 的改动名单）。
 */
const BASE_COMMIT = 'ebb9d52';   // task-1（三端器件波次）之前的那次提交：v2.1.0 交互改进 + 光敏二极管 + 发布闸门
const TASK1_COMMIT = '112386c';  // task-1 自己的提交，只用于 S9.hist.scope 那条历史记录
/** 基准版镜像树（"改动前的真身"）与它的失败原因，在 main 里填 */
let BASE = null, BASE_ERR = '';

const stripComments = (s) => s.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
const readRaw = (rel) => readFileSync(path.join(SRC_DIR, rel), 'utf8');
/** 求解器对 V 支路串的内阻下限（electrical.js 的 Math.max(0.01, internalR)）—— 手推必须算进去 */
const RINT = 0.01;

let VERBOSE = true;
const RESULTS = [];
let section = '';
let pass = 0, fail = 0;
const head = (t) => { section = t; if (VERBOSE) console.log('\n\x1b[36m' + t + '\x1b[0m'); };
const info = (t) => { if (VERBOSE) console.log('    \x1b[90m' + t + '\x1b[0m'); };
/** 断言：id 必须显式给（消息里带实测值 ⇒ 不能拿消息当 id，否则变异前后对不上） */
function ok(id, cond, msg) {
  RESULTS.push({ id, ok: !!cond, msg });
  if (VERBOSE) { if (cond) { pass++; console.log('  \x1b[32m✓\x1b[0m ' + msg); } else { fail++; console.log('  \x1b[31m✗\x1b[0m ' + msg); } }
}
/** 一节 = 一个 try：变异体把某节跑炸了也算这一节红，而不是把整个探针掀掉 */
function sectionRun(title, fn) {
  head(title);
  try { fn(); } catch (err) { ok(section + '.threw', false, `本节抛异常：${err && err.message}`); }
}
const near = (a, b, tolRel) => Math.abs(a - b) <= tolRel * Math.max(1e-12, Math.abs(b));
/** 绝对值 + 相对值双口径：手推恰好是 0 的量（截止区 I_B 之类）只能用绝对界 */
const near2 = (a, b, tolRel, tolAbs) => Math.abs(a - b) <= Math.max(tolAbs, tolRel * Math.abs(b));
const rel = (a, b) => Math.abs(a - b) / Math.max(1e-300, Math.abs(b));

/** 把一棵 src 树整个装进来。工作区 / 基准镜像 / 变异体镜像走同一个函数 ⇒ 同一套断言可重跑 */
async function loadTree(srcDir, tag) {
  const b = pathToFileURL(srcDir.replace(/[\\/]+$/, '')).href + '/';
  const { World } = await import(b + 'core/world.js');
  const { PluginHost } = await import(b + 'core/plugin.js');
  const { create, bindRegistry } = await import(b + 'equipment/registry.js');
  const { CouplingBus } = await import(b + 'coupling/bridge.js');
  const C = await import(b + 'physics/circuit.js');
  const { solveCircuit } = C;
  const physics = (await import(b + 'physics/circuit.js')).default;
  const electrical = (await import(b + 'equipment/electrical.js')).default;
  const electronics = (await import(b + 'equipment/electronics.js')).default;
  const E = await import(b + 'equipment/electronics.js');
  const bootApp = {
    services: {}, ticks: [], world: null, lastCircuit: null, selected: null,
    log: { push() {}, clear() {} }, toast() {},
    addTick(fn) { this.ticks.push(fn); return () => {}; },
  };
  // 逐插件装，记下每件插件各自报了几件器材 + 分别贡献了哪些类型
  // （验收门 B 要求新器材必须长在既有 electronics 插件里：用"安装增量"判定，不用总数判定）
  const counts = {}, sets = {};
  const host = new PluginHost(bootApp);
  let prev = 0, prevTypes = [];
  for (const p of [physics, electrical, electronics]) {
    host.define(p);
    host.installAll();
    const nowTypes = host.registry('equipment').list().map((d) => d.type);
    counts[p.id] = nowTypes.length - prev;
    sets[p.id] = nowTypes.filter((t) => !prevTypes.includes(t));
    prev = nowTypes.length;
    prevTypes = nowTypes;
  }
  bindRegistry(host.registry('equipment'));
  const reg = host.registry('equipment');
  return { tag, b, srcDir, World, PluginHost, create, bindRegistry, CouplingBus, solveCircuit, C, E,
    host, reg, counts, sets, byType: new Map(reg.list().map((d) => [d.type, d])) };
}

const DT = 1 / 120;
/** 造世界 + 跑帧：与 main.js 的 instrumentWorld 同一条流水线（造支路 → 解电路 → 分发 → 世界步进） */
function scene(T, sc) {
  const world = new T.World();
  const cb = new T.CouplingBus(world);
  const raw = world.step.bind(world);
  const ents = [];
  for (const o of sc.entities || []) {
    const e = T.create(o.type, o.x || 0, o.y || 0);
    if (!e) throw new Error('无法创建器材 ' + o.type);
    if (o.props) for (const k of Object.keys(o.props)) e.setProp(k, o.props[k]);
    world.add(e, true);
    ents.push(e);
  }
  for (const w of sc.wires || []) {
    if (!ents[w[0]] || !ents[w[2]]) throw new Error('场景引用了不存在的器材 ' + JSON.stringify(w));
    world.connect({ e: ents[w[0]].id, p: w[1] }, { e: ents[w[2]].id, p: w[3] }, w[4] || 'wire');
  }
  let last = null;
  const tick = () => { const br = cb.buildBranches(); const c = T.solveCircuit(world, br); last = c; cb.distribute(DT, c); raw(DT); return c; };
  return {
    world, ents, cb, tick, last: () => last, get: (i) => ents[i],
    run(n) { for (let i = 0; i < n; i++) this.tick(); return last; },
    /** 求解器写在实体级 state 上的四个键（主边独占） */
    snap() { return ents.map((e) => ({ type: e.type, I: e.state.I, U: e.state.U, P: e.state.P, R: e.state.R })); },
  };
}
const warns = (b) => ((b.last() && b.last().warnings) || []).map((w) => w.code);
const nWarn = (b, code) => warns(b).filter((c) => c === code).length;

// ── 场景（端口序号：BJT B/C/E = 0/1/2；MOSFET G/D/S = 0/1/2；battery 口 0 = 电学正极，见 §9 的口径自检）──
const PLUS = 0, MINUS = 1;
/** NPN/PNP 放大·饱和通用：Vcc=12 → R_C=1k → C；Vbb=2.7 → R_B → B；E 为地 */
const scBjt = (type, rb) => ({ entities: [
  { type: 'battery', x: 0, y: 0, props: { emf: 12, internalR: RINT } },
  { type: 'battery', x: 0, y: 100, props: { emf: 2.7, internalR: RINT } },
  { type: 'resistor', x: 100, y: 100, props: { resistance: rb } },
  { type: 'resistor', x: 100, y: 0, props: { resistance: 1000 } },
  { type, x: 200, y: 50 },
], wires: type === 'pnp' ? [
  [0, PLUS, 4, 2], [0, MINUS, 3, 1], [3, 0, 4, 1],
  [1, PLUS, 4, 2], [1, MINUS, 2, 0], [2, 1, 4, 0],
] : [
  [0, MINUS, 4, 2], [0, PLUS, 3, 0], [3, 1, 4, 1],
  [1, PLUS, 2, 0], [2, 1, 4, 0], [1, MINUS, 4, 2],
] });
/** NPN 截止：基极经 R_B 直接接 E ⇒ U_BE = 0 */
const scBjtCut = () => ({ entities: [
  { type: 'battery', x: 0, y: 0, props: { emf: 12, internalR: RINT } },
  { type: 'resistor', x: 100, y: 100, props: { resistance: 10000 } },
  { type: 'resistor', x: 100, y: 0, props: { resistance: 1000 } },
  { type: 'npn', x: 200, y: 50 },
], wires: [
  [0, MINUS, 3, 2], [0, PLUS, 2, 0], [2, 1, 3, 1], [1, 1, 3, 0], [1, 0, 3, 2],
] });
/** MOSFET：两个电源分别钉住 U_GS 与 U_DS（P 沟道接线镜像） */
const scMosPin = (type, vgs, vds) => ({ entities: [
  { type: 'battery', x: 0, y: 0, props: { emf: vgs, internalR: RINT } },
  { type: 'battery', x: 0, y: 100, props: { emf: vds, internalR: RINT } },
  { type, x: 200, y: 50 },
], wires: type === 'pmos'
  ? [[0, PLUS, 2, 2], [0, MINUS, 2, 0], [1, PLUS, 2, 2], [1, MINUS, 2, 1]]
  : [[0, PLUS, 2, 0], [0, MINUS, 2, 2], [1, PLUS, 2, 1], [1, MINUS, 2, 2]] });
/** MOSFET 负载线：Vdd=12 → R_D → D；S 为地；栅极由电源钉住 */
const scMosLoad = (type, rd, vgs) => ({ entities: [
  { type: 'battery', x: 0, y: 0, props: { emf: 12, internalR: RINT } },
  { type: 'battery', x: 0, y: 100, props: { emf: vgs, internalR: RINT } },
  { type: 'resistor', x: 100, y: 0, props: { resistance: rd } },
  { type, x: 200, y: 50 },
], wires: type === 'pmos'
  ? [[0, PLUS, 3, 2], [0, MINUS, 2, 0], [2, 1, 3, 1], [1, PLUS, 3, 2], [1, MINUS, 3, 0]]
  : [[0, MINUS, 3, 2], [0, PLUS, 2, 0], [2, 1, 3, 1], [1, PLUS, 3, 0], [1, MINUS, 3, 2]] });
/** 两线用法：只有 C–E（或 D–S）接进电路，控制端空着 */
const scTwoWire = (type) => ({ entities: [
  { type: 'battery', x: 0, y: 0, props: { emf: 12, internalR: RINT } },
  { type: 'resistor', x: 100, y: 0, props: { resistance: 1000 } },
  { type, x: 200, y: 50 },
], wires: [[0, MINUS, 2, 2], [0, PLUS, 1, 0], [1, 1, 2, 1]] });

// ══════════════════════════════════════════════════════════
async function runSuite(T) {
  const NEW_TYPES = ['npn', 'pnp', 'nmos', 'pmos'];

  sectionRun('§0 注册、定义形状、端口字母、读数命名（⑤ 面板口径 / 器材长在既有 electronics 插件里）', () => {
    ok('S0.reg', NEW_TYPES.every((t) => T.byType.has(t)),
      `四个新类型都注册：${NEW_TYPES.filter((t) => T.byType.has(t)).join(' / ')}`);
    ok('S0.batch', NEW_TYPES.every((t) => !['battery', 'diode', 'transformer', 'rheostat'].includes(t)),
      '类型名与既有器材零重叠（不顶掉任何旧名字）');
    // 插件归属：不做"器材数正好 = 12"这种断言（别人以后往同一插件加器材是合法改动，会把恒绿变恒红），
    // 改成两条不会过期的：①数量 ≥ 改前 8 + 新 4；②四个新类型**由这个插件贡献**（按插件安装增量算，不看总数）
    const elId = 'xiaomo.equipment.electronics';
    const elCount = T.counts[elId];
    const elTypes = (T.sets && T.sets[elId]) || [];
    const mineInPlugin = NEW_TYPES.filter((t) => elTypes.includes(t));
    ok('S0.elcount', elCount >= 12 && mineInPlugin.length === NEW_TYPES.length,
      `electronics 插件自报器材数 = ${elCount}（≥ 改前 8 件 + 新的 4 件 = 12 ⇒ 本插件变大了，但插件 id 未变 ⇒ 插件总数 32 不变）；四个新类型全部由这个插件贡献：${mineInPlugin.join('/')}（按安装增量算，不看总数 ⇒ 别人再往同一插件加器材不会打红本条）`);
    for (const t of NEW_TYPES) {
      const d = T.byType.get(t);
      const need = ['type', 'name', 'domain', 'cat', 'icon', 'desc', 'w', 'h', 'ports', 'fields', 'defaults', 'state', 'tags', 'create', 'stats'];
      const miss = need.filter((k) => d[k] === undefined);
      ok('S0.shape.' + t, miss.length === 0, `${t}：定义字段齐全${miss.length ? '（缺 ' + miss + '）' : ''}（含 stats ⇒ 面板能自报端子读数）`);
      const wp = d.ports.filter((p) => p.kind === 'wire');
      const want = t.startsWith('n') || t.startsWith('p') ? ['G', 'D', 'S'] : ['B', 'C', 'E'];
      const labels = wp.map((p) => p.label);
      const right = t === 'npn' || t === 'pnp' ? labels.join('') === 'BCE' : labels.join('') === 'GDS';
      ok('S0.ports.' + t, wp.length === 3 && right,
        `${t}：三个 wire 口、字母 ${labels.join('/')}（顺序 = ${want.join('/')}，控制端排第一 ⇒ 支路取号稳定）`);
      const noField = Object.keys(d.defaults).filter((k) => !d.fields.some((f) => f.k === k));
      const badField = d.fields.filter((f) => !f.k || !f.label || !f.type
        || (f.type === 'range' && !(isFinite(f.min) && isFinite(f.max) && isFinite(f.step))));
      ok('S0.fields.' + t, noField.length === 0 && badField.length === 0,
        `${t}：${d.fields.length} 个字段自洽、defaults ${JSON.stringify(d.defaults)} 每项都能被用户调`);
      ok('S0.icon.' + t, typeof d.icon === 'string' && d.icon.trim().length === 1,
        `${t}：图标 ${JSON.stringify(d.icon)}（palette/inspector 走 setText ⇒ 单字符）`);
      const inst = T.create(t, 0, 0);
      ok('S0.cb.' + t, !!inst && typeof inst.circuitBranch === 'function' && typeof inst.circuitBranches === 'function',
        `${t}：同时有 circuitBranch()（单支路回落）与 circuitBranches(world)（多支路）⇒ inspector 的四键与多支路契约都在`);
    }
    // ⑤ 读数命名：凡是量名里出现「电压 / 电流」的行，都必须点名端子，不许出现含糊的裸「电压」
    //    例外只有两个设备内部量：U_ov（过驱电压，是 U_GS 与阈值的差）与 g_m（跨导），它们本来就不属于某个端子
    const badLabel = [];
    for (const t of NEW_TYPES) {
      for (const s of T.byType.get(t).stats) {
        if (!/电压|电流/.test(s.label)) continue;
        if (/U_ov|g_m/.test(s.label)) continue;
        if (!/[A-Z]{2}/.test(s.label) && !/[A-Z]_[A-Z]/.test(s.label)) badLabel.push(t + ':' + s.label);
      }
    }
    ok('S0.naming', badLabel.length === 0, `每个端子读数行都点名了端子（无裸「电压/电流」行）${badLabel.length ? '例外：' + badLabel.join(',') : ''}`);
    // ⑤ 的约定写法（比上一条更严）：电压行 = 「电压 + 紧邻端子字母」（电压BE / 电压GS…）、
    //    电流行 = 「中文端极名 + 电流」（基极电流 / 集电极电流 / 漏极电流…）。
    //    只把端子塞进 U_BE 这类下标符号里**不算**：学生扫一眼要能看出这是哪两个端子之间的量。
    //    例外：过驱电压 U_ov 与跨导 g_m 是器件内部量，本来就不属于某两个端子。
    const TERM = /基极|集电极|发射极|栅极|漏极|源极/;
    const offConv = [];
    for (const t of NEW_TYPES) {
      for (const s of T.byType.get(t).stats) {
        if (/^电压/.test(s.label) && !/^电压(BE|CE|BC|GS|DS|GD)\s/.test(s.label)) offConv.push(t + ':' + s.label);
        else if (/电流($|\s)/.test(s.label) && !TERM.test(s.label)) offConv.push(t + ':' + s.label);
      }
    }
    ok('S0.convention', offConv.length === 0,
      `读数行用的是约定写法（电压BE / 电压GS / 基极电流 I_B / 漏极电流 I_D…）${offConv.length ? '；不符：' + offConv.join('、') : ''}`);
    const want = [['npn', ['电压BE', '电压CE', '电压BC', '基极电流 I_B', '集电极电流 I_C', '发射极电流 I_E']],
      ['nmos', ['电压GS', '电压DS', '电压GD', '漏极电流 I_D', '跨导 g_m']]];
    for (const [t, keys] of want) {
      const labels = T.byType.get(t).stats.map((s) => s.label);
      const miss = keys.filter((k) => !labels.some((l) => l.includes(k)));
      ok('S0.stats.' + t, miss.length === 0, `${t}：读数行含 ${keys.join('、')}${miss.length ? '（缺 ' + miss + '）' : ''}`);
    }
    const inst = T.create('npn', 0, 0);
    const inst2 = T.create('npn', 0, 0);
    inst.state.be = { U: 1 }; inst.state.ce = { U: 2 };
    ok('S0.shallow', inst2.state.be === null && inst2.state.ce === null,
      'def.state 里只有基本值：be/ce 盒子在支路里惰性建 ⇒ 两台实例不共享盒子（entity.js 的浅拷贝陷阱）');
  });

  sectionRun('§1 bjtRegion 纯函数：三区判据与「自我肯定」（不抖的根据）', () => {
    const BR = T.E.bjtRegion;
    const P = (o) => Object.assign({ UBE: 0.75, UCE: 5, IB: 1e-4, IC: 1e-2, beta: 100, vbeOn: 0.7, vceSat: 0.2 }, o);
    ok('S1.cutoff', BR(P({ UBE: 0.69 })) === 'cutoff', 'U_BE = 0.69 V < 0.7 V ⇒ 截止');
    ok('S1.boundary', BR(P({ UBE: 0.7 })) === 'cutoff', 'U_BE 恰好 = 阈值 ⇒ 仍算截止（严格大于才算正偏 ⇒ 边界不抖）');
    ok('S1.active', BR(P({ UBE: 0.75, IB: 1e-5, IC: 1e-3 })) === 'active', 'U_BE > 阈值、β·I_B = 1e-3 = I_C 且 U_CE > 饱和压降 ⇒ 放大');
    ok('S1.sat.cur', BR(P({ UBE: 0.8, IB: 1e-3, IC: 1e-2, UCE: 5 })) === 'sat',
      'β·I_B = 0.1 A > I_C = 0.01 A ⇒ 饱和（**只看电流比**，U_CE = 5 V 远高于饱和压降也不翻案）');
    ok('S1.sat.volt', BR(P({ UBE: 0.8, IB: 1e-5, IC: 1e-3, UCE: 0.1 })) === 'sat',
      'U_CE = 0.1 V < 饱和压降 ⇒ 也判饱和（电压判据只保留为「进入」饱和的那一支触发）');
    // 自我肯定：把**实测到的不动点**喂回去，区域必须自己认自己 ⇒ 不存在 2 帧周期抖动
    const act = { UBE: 0.7049875310549751, UCE: 7.012419074700087, IB: 4.987531054976569e-5, IC: 4.987531054976569e-3, beta: 100, vbeOn: 0.7, vceSat: 0.2 };
    const sat = { UBE: 0.7198019607881769, UCE: 0.4313702805, IB: 1.9801961708958992e-4, IC: 1.15685140455e-2, beta: 100, vbeOn: 0.7, vceSat: 0.2 };
    ok('S1.selfactive', BR(act) === 'active', `把放大区不动点（I_C = ${act.IC.toExponential(6)} = β·I_B 精确成立）喂回去 ⇒ 仍是放大`);
    ok('S1.selfsat', BR(sat) === 'sat', `把饱和区不动点（β·I_B = ${(100 * sat.IB).toExponential(4)} > I_C = ${sat.IC.toExponential(4)}）喂回去 ⇒ 仍是饱和`);
  });

  sectionRun('§2 mosLaw 纯函数：阈值、两段平方律、接缝连续、跨导分段', () => {
    const M = T.E.mosLaw;
    const VTH = 2, K = 1e-3;
    const c = M(1.9, 5, VTH, K);
    ok('S2.cutoff', c.region === 'cutoff' && c.id === 0 && c.gm === 0, `U_GS = 1.9 V < 阈值 2 V ⇒ 截止（I_D = ${c.id}）`);
    const t = M(2, 5, VTH, K);
    ok('S2.boundary', t.region === 'cutoff' && t.vov === 0, 'U_GS 恰好 = 阈值 ⇒ U_ov = 0、仍算截止');
    const sat = M(5, 5, VTH, K);
    ok('S2.sat', sat.region === 'sat' && sat.id === K * 9 && sat.gm === 2 * K * 3,
      `恒流区：U_ov = 3 V ⇒ I_D = k·U_ov² = ${sat.id} A、g_m = 2k·U_ov = ${sat.gm} S`);
    const tri = M(5, 1, VTH, K);
    ok('S2.triode', tri.region === 'triode' && tri.id === K * 5 && tri.gm === K * 1,
      `可变电阻区：U_DS = 1 V ⇒ I_D = k(2U_ov·U_DS − U_DS²) = ${tri.id} A、g_m = k·U_DS = ${tri.gm} S`);
    const seam = M(5, 3, VTH, K);
    const seamGL = K * (2 * 3 * 3 - 9);
    ok('S2.seam', seam.region === 'sat' && seam.id === seamGL,
      `接缝 U_DS = U_ov = 3 V 处两式同值：平方律 ${seamGL} A ⟷ 恒流式 ${seam.id} A（判据翻转不会自我否定）`);
    ok('S2.gmstep', tri.gm !== sat.gm && tri.gm === K * 1 && sat.gm === 2 * K * 3,
      `跨导确实分段：可变电阻区 ${tri.gm} S（∝U_DS）⟷ 恒流区 ${sat.gm} S（∝U_ov）`);
    const zero = M(5, 0, VTH, K);
    ok('S2.zero', zero.region === 'triode' && zero.id === 0, `U_DS = 0 ⇒ I_D = ${zero.id}（不出现负电流）`);
  });

  // ── 元件级常量：与器材默认值一致（用户可调，探针用默认值推） ──
  const BETA = 100, VON = 0.7, RBE = 100, VSAT = 0.2, RCESAT = 20;
  const VCC = 12, VBB = 2.7, RC = 1000, RB_A = 40000, RB_B = 10000;

  sectionRun('§3 NPN 三区：独立手推 ⟷ 实测（残差 + 自洽 + 帧间稳定）', () => {
    // ── 放大区手推（结点法，把真存在的串联项都算上）──
    //   基极回路：Vbb = I_B·(r内 + R_B) + U_BE，且 U_BE = U_BE(on) + rbe·I_B
    //     ⇒ I_B = (Vbb − U_BE(on)) / (R_B + rbe + r内)
    //   电流控制：I_C = β·I_B
    //   集电极回路：Vcc = I_C·(r内 + R_C) + U_CE ⇒ U_CE = Vcc − I_C·(R_C + r内)
    const iBHand = (VBB - VON) / (RB_A + RBE + RINT);
    const iCHand = BETA * iBHand;
    const uCEHand = VCC - iCHand * (RC + RINT);
    const a = scene(T, scBjt('npn', RB_A));
    a.run(120);
    const da = a.get(4);
    ok('S3.act.region', da.state.region === 'active',
      `放大区判区 = ${da.state.region}（手推：I_C = β·I_B 精确成立且 U_CE = ${uCEHand.toFixed(6)} V ≫ 饱和压降）`);
    ok('S3.act.ib', near(da.state.Ib, iBHand, 1e-5),
      `I_B 实测 ${da.state.Ib} ⟷ 手推 (2.7−0.7)/(40000+100+0.01) = ${iBHand}  A（相对残差 ${rel(da.state.Ib, iBHand).toExponential(2)}）`);
    ok('S3.act.ic', near(da.state.Ic, iCHand, 1e-5),
      `I_C 实测 ${da.state.Ic} ⟷ 手推 β·I_B = ${iCHand} A（相对残差 ${rel(da.state.Ic, iCHand).toExponential(2)}）`);
    ok('S3.act.uce', near(da.state.Uce, uCEHand, 1e-5),
      `U_CE 实测 ${da.state.Uce} ⟷ 手推 Vcc − I_C(R_C+r内) = ${uCEHand} V（相对残差 ${rel(da.state.Uce, uCEHand).toExponential(2)}）`);
    // ② 的核心：电流控制律在不动点上**逐位**成立（不是"接近"）
    ok('S3.act.law', Object.is(BETA * da.state.Ib - da.state.Ic, 0),
      `电流控制律逐位成立：Object.is(${BETA}·I_B − I_C, 0) = ${Object.is(BETA * da.state.Ib - da.state.Ic, 0)}（I_C = ${da.state.Ic}）`);
    ok('S3.act.ube', near(da.state.Ube, VON + RBE * da.state.Ib, 1e-6),
      `发射结自洽：U_BE 实测 ${da.state.Ube} ⟷ U_BE(on)+rbe·I_B = ${VON + RBE * da.state.Ib} V（残差 ${(da.state.Ube - (VON + RBE * da.state.Ib)).toExponential(2)}）`);
    // 解自洽性（与手推无关，只查解自己满不满足电路方程）
    const kvlA = VBB - (da.state.Ib * (RB_A + RINT) + da.state.Ube);
    ok('S3.act.kvl', Math.abs(kvlA) < 5e-6,
      `解自洽：Vbb − I_B(R_B+r内) − U_BE = ${kvlA.toExponential(2)} V（求解器以 maxDelta<1e-5 收，结点法残差就该在这个量级）`);
    const icRes = Math.abs(a.get(3).state.I);
    ok('S3.act.kcl', Math.abs(icRes - da.state.Ic) <= 1e-12 + 1e-9 * Math.abs(icRes),
      `集电极回路 KCL：R_C 支路电流 ${icRes.toExponential(12)} A ⟷ 器件 I_C ${da.state.Ic.toExponential(12)} A（两个独立算出来的数必须相等）`);
    const b2 = scene(T, scBjt('npn', RB_A));
    const regs = [];
    for (let i = 0; i < 40; i++) { b2.tick(); regs.push(b2.get(4).state.region); }
    ok('S3.act.stable', regs.slice(5).every((r) => r === 'active'),
      `40 帧逐帧工作区 ${[...new Set(regs)].join('/')}，第 6 帧起恒为放大 ⇒ 没有 ON/OFF 两帧抖动`);

    // ── 饱和区手推 ──
    //   基极回路同放大区（发射结照样正偏）：I_B = (Vbb − U_BE(on))/(R_B + rbe + r内)
    //   集电极侧是 V 支路：U_CE = U_CE(sat) + rceSat·I_C
    //   集电极回路：Vcc = I_C·(r内 + R_C) + U_CE ⇒ I_C = (Vcc − U_CE(sat)) / (R_C + r内 + rceSat)
    const iBsat = (VBB - VON) / (RB_B + RBE + RINT);
    const iCsat = (VCC - VSAT) / (RC + RINT + RCESAT);
    const uCEsat = VSAT + RCESAT * iCsat;
    const b = scene(T, scBjt('npn', RB_B));
    b.run(120);
    const db = b.get(4);
    ok('S3.sat.region', db.state.region === 'sat', `饱和区判区 = ${db.state.region}（I_B 抬到使 β·I_B > I_C）`);
    ok('S3.sat.ib', near(db.state.Ib, iBsat, 1e-5),
      `I_B 实测 ${db.state.Ib} ⟷ 手推 2/(10000+100+0.01) = ${iBsat} A（相对残差 ${rel(db.state.Ib, iBsat).toExponential(2)}）`);
    ok('S3.sat.ic', near(db.state.Ic, iCsat, 1e-5),
      `I_C 实测 ${db.state.Ic} ⟷ 手推 (12−0.2)/(1000+0.01+20) = ${iCsat} A（相对残差 ${rel(db.state.Ic, iCsat).toExponential(2)}）`);
    ok('S3.sat.uce', near(db.state.Uce, uCEsat, 1e-5),
      `U_CE 实测 ${db.state.Uce} ⟷ 手推 U_CE(sat)+rceSat·I_C = ${uCEsat} V（相对残差 ${rel(db.state.Uce, uCEsat).toExponential(2)}）`);
    ok('S3.sat.voltg', db.state.Uce >= VSAT - 1e-9,
      `③ 饱和压降是下界：U_CE = ${db.state.Uce} V ≥ U_CE(sat) = ${VSAT} V ⇒ 饱和区自己把自己钉在阈值之上（判据不会自我否定）`);
    ok('S3.sat.betaprod', BETA * db.state.Ib > db.state.Ic,
      `饱和的直接证据：β·I_B = ${(BETA * db.state.Ib).toExponential(6)} A > I_C = ${db.state.Ic.toExponential(6)} A`);
    ok('S3.sat.betaeff', db.state.betaEff < BETA && near(db.state.betaEff, db.state.Ic / db.state.Ib, 1e-12),
      `面板实测 β = I_C/I_B = ${db.state.betaEff.toFixed(4)} < 设定 ${BETA}（学生一眼能看出"没放大那么多"）`);
    const regs2 = [];
    for (let i = 0; i < 40; i++) { b.tick(); regs2.push(b.get(4).state.region); }
    ok('S3.sat.stable', regs2.slice(5).every((r) => r === 'sat'),
      `40 帧逐帧工作区 ${[...new Set(regs2)].join('/')} ⇒ 饱和区同样不抖`);

    // ── 截止区手推 ──
    //   基极经 R_B 直接连 E ⇒ U_BE ≡ 0 < 阈值 ⇒ I_B ≡ 0；集电极侧是 1 MΩ 大电阻（roff·1e6）
    //   I_C = Vcc / (r内 + R_C + 1e6)（漏电流，不是"零"，所以截止区要给出量级而非绝对值 0）
    const roffOhm = 1 * 1e6;
    const iCcut = VCC / (RINT + RC + roffOhm);
    const c = scene(T, scBjtCut());
    c.run(120);
    const dc = c.get(3);
    ok('S3.cut.region', dc.state.region === 'cutoff', `截止区判区 = ${dc.state.region}（U_BE = ${dc.state.Ube} V < 阈值 ${VON} V）`);
    ok('S3.cut.ib', near2(dc.state.Ib, 0, 1e-5, 1e-9),
      `I_B 实测 ${dc.state.Ib.toExponential(3)} A ⟷ 手推 0 A（绝对残差 ${dc.state.Ib.toExponential(2)} A ⇒ 用绝对界 1e-9，不能用相对界）`);
    ok('S3.cut.ic', near(dc.state.Ic, iCcut, 1e-5),
      `① 截止区 I_C 实测 ${dc.state.Ic} A ⟷ 手推「经 1 MΩ 漏电阻的电流」12/(1000.01+1e6) = ${iCcut} A（相对残差 ${rel(dc.state.Ic, iCcut).toExponential(2)}）`);
    ok('S3.cut.beta', dc.state.betaEff === 0, `面板实测 β = ${dc.state.betaEff}（I_B 小于 1e-9 门槛 ⇒ 报 0，不报 NaN/Infinity）`);
    ok('S3.cut.ratio', dc.state.Ic * 400 < da.state.Ic,
      `① 的定量口径：截止区 I_C 比放大区小 ${(da.state.Ic / dc.state.Ic).toFixed(0)} 倍（> 400 倍 ⇒ "≈0" 是有锚的，不是形容词）`);
  });

  sectionRun('§4 NPN / PNP 极性：同一条镜像电路，符号相反、幅值一致', () => {
    const iBHand = (VBB - VON) / (RB_A + RBE + RINT);
    const iCHand = BETA * iBHand;
    const uCEHand = VCC - iCHand * (RC + RINT);
    const n = scene(T, scBjt('npn', RB_A)); n.run(120);
    const p = scene(T, scBjt('pnp', RB_A)); p.run(120);
    const dn = n.get(4), dp = p.get(4);
    ok('S4.p.region', dp.state.region === 'active', `PNP 镜像电路判区 = ${dp.state.region}`);
    ok('S4.p.ic', near(dp.state.Ic, iCHand, 1e-5),
      `PNP I_C 实测 ${dp.state.Ic} ⟷ 手推 β·I_B = ${iCHand} A（相对残差 ${rel(dp.state.Ic, iCHand).toExponential(2)}）`);
    ok('S4.p.law', Object.is(BETA * dp.state.Ib - dp.state.Ic, 0), 'PNP 电流控制律同样逐位成立');
    ok('S4.sign.ube', dp.state.Ube < 0 && dn.state.Ube > 0,
      `电压极性相反：U_BE(NPN) = ${dn.state.Ube.toFixed(9)} V > 0 ⟷ U_BE(PNP) = ${dp.state.Ube.toFixed(9)} V < 0`);
    ok('S4.sign.uce', dp.state.Uce < 0 && dn.state.Uce > 0,
      `电压极性相反：U_CE(NPN) = ${dn.state.Uce.toFixed(9)} V > 0 ⟷ U_CE(PNP) = ${dp.state.Uce.toFixed(9)} V < 0`);
    ok('S4.sign.bc', Math.sign(dn.state.Ubc) === -Math.sign(dp.state.Ubc) && dn.state.Ubc < 0,
      `U_BC 也反号：NPN ${dn.state.Ubc.toFixed(6)} V（反偏）⟷ PNP ${dp.state.Ubc.toFixed(6)} V`);
    ok('S4.mag.uce', near(Math.abs(dp.state.Uce), uCEHand, 1e-5),
      `幅值一致：|U_CE(PNP)| = ${Math.abs(dp.state.Uce)} ⟷ NPN 手推 ${uCEHand} V（相对残差 ${rel(Math.abs(dp.state.Uce), uCEHand).toExponential(2)}）`);
    ok('S4.mag.diff', near(Math.abs(dp.state.Uce), Math.abs(dn.state.Uce), 1e-5),
      `NPN/PNP 逐点镜像：|U_CE| 相差 ${Math.abs(Math.abs(dp.state.Uce) - Math.abs(dn.state.Uce)).toExponential(2)} V（相对 ${rel(Math.abs(dp.state.Uce), Math.abs(dn.state.Uce)).toExponential(2)}；不苛求逐位 —— 两个电路各自独立迭代收敛，只保证同量级）`);
  });

  sectionRun('§5 MOSFET 三区、接缝与跨导分段：手推 ⟷ 实测', () => {
    const VTH = 2, K = 1e-3, VDD = 12, RD = 500, VGS = 5;
    const vov = VGS - VTH;
    // ── 恒流区负载线手推 ──
    //   栅极电隔离 ⇒ I_G ≡ 0、U_GS 由栅极电源直接钉住 = VGS
    //   I_D = k·U_ov²，U_DS = Vdd − I_D·(R_D + r内)
    const idSat = K * vov * vov;
    const udsSatHand = VDD - idSat * (RD + RINT);
    const gmSatHand = 2 * K * vov;
    const e = scene(T, scMosLoad('nmos', RD, VGS));
    e.run(120);
    const de = e.get(3);
    ok('S5.sat.region', de.state.region === 'sat', `恒流区判区 = ${de.state.region}（U_DS = ${de.state.Uds.toFixed(6)} > U_ov = ${vov}）`);
    ok('S5.sat.ugs', near(de.state.Ugs, VGS, 1e-9),
      `U_GS 实测 ${de.state.Ugs} V ⟷ 栅极电源设定 ${VGS} V（栅极不取电流 ⇒ 没有被源内阻吃掉电压）`);
    ok('S5.sat.id', near(de.state.Id, idSat, 1e-5),
      `I_D 实测 ${de.state.Id} A ⟷ 手推 k·U_ov² = 1e-3×3² = ${idSat} A（相对残差 ${rel(de.state.Id, idSat).toExponential(2)}）`);
    ok('S5.sat.uds', near(de.state.Uds, udsSatHand, 1e-5),
      `U_DS 实测 ${de.state.Uds} V ⟷ 手推 Vdd − I_D(R_D+r内) = ${udsSatHand} V（相对残差 ${rel(de.state.Uds, udsSatHand).toExponential(2)}）`);
    ok('S5.sat.gm', near(de.state.gm, gmSatHand, 1e-9),
      `跨导恒流段：g_m 实测 ${de.state.gm} S ⟷ 手推 2k·U_ov = ${gmSatHand} S（相对残差 ${rel(de.state.gm, gmSatHand).toExponential(2)}）`);
    const ig = Math.abs(e.last().branches.get(e.get(1).id).I);
    ok('S5.sat.ig', ig <= 1e-9,
      `栅极支路电流实测 ${ig.toExponential(3)} A ≤ 1e-9 A ⇒ 栅极电隔离（剩下的那点是求解器每结点 1e-12 S 的 gmin 泄放：5 V×1e-12 S = 5e-12 A 量级，不是真实栅流）`);

    // ── 可变电阻区（钉住 U_DS）手推：解一元二次方程，不是抄实现 ──
    //   回路：U_DS = Vds − r内·I_D；管子：I_D = k(2·U_ov·U_DS − U_DS²)
    //   代入得 A·U² − (1 + 2A·U_ov)·U + Vds = 0，其中 A = r内·k
    const A = RINT * K, VDS = 1;
    const bq = 1 + 2 * A * vov, cq = VDS;
    const udsTriHand = (2 * cq) / (bq + Math.sqrt(bq * bq - 4 * A * cq));   // 取靠近 Vds 的那个稳定根
    const idTriHand = K * (2 * vov * udsTriHand - udsTriHand * udsTriHand);
    const gmTriHand = K * udsTriHand;
    const f = scene(T, scMosPin('nmos', VGS, VDS));
    f.run(120);
    const df = f.get(2);
    ok('S5.tri.region', df.state.region === 'triode', `可变电阻区判区 = ${df.state.region}（U_DS = ${df.state.Uds.toFixed(6)} < U_ov = ${vov}）`);
    ok('S5.tri.uds', near(df.state.Uds, udsTriHand, 1e-9),
      `U_DS 实测 ${df.state.Uds} ⟷ 手推二次方程根 A·U²−(1+2A·U_ov)U+Vds=0（A=r内·k=1e-5）⇒ ${udsTriHand} V（相对残差 ${rel(df.state.Uds, udsTriHand).toExponential(2)}）`);
    ok('S5.tri.id', near(df.state.Id, idTriHand, 1e-9),
      `I_D 实测 ${df.state.Id} A ⟷ 手推 k(2U_ov·U_DS − U_DS²) = ${idTriHand} A（相对残差 ${rel(df.state.Id, idTriHand).toExponential(2)}）`);
    ok('S5.tri.gm', near(df.state.gm, gmTriHand, 1e-9),
      `跨导可变电阻段：g_m 实测 ${df.state.gm} S ⟷ 手推 k·U_DS = ${gmTriHand} S`);
    ok('S5.tri.step', df.state.gm / de.state.gm < 0.2,
      `⑤ 跨导确实分段：同一管子可变电阻区 g_m = ${df.state.gm.toExponential(4)} S ⟷ 恒流区 ${de.state.gm.toExponential(4)} S（比值 ${(df.state.gm / de.state.gm).toFixed(3)}）`);
    ok('S5.tri.seam', near(de.state.Uds - vov, VDD - vov - idSat * (RD + RINT), 1e-9) && idSat === K * vov * vov,
      `接缝两侧给同一个电流：U_DS = U_ov 处两段公式都等于 ${idSat} A ⇒ 判据翻转不产生电流跳变`);

    // ── 截止区手推 ──
    const VGS_CUT = 1, roffOhm = 1 * 1e6;
    const idCutHand = 5 / (roffOhm + RINT);          // 漏源之间只剩 1 MΩ 大电阻，串在 5 V 电源上
    const g = scene(T, scMosPin('nmos', VGS_CUT, 5));
    g.run(120);
    const dg = g.get(2);
    ok('S5.cut.region', dg.state.region === 'cutoff' && dg.state.gm === 0,
      `截止区判区 = ${dg.state.region}（U_GS = ${dg.state.Ugs} V < 阈值 ${VTH} V ⇒ U_ov = ${dg.state.vov}、g_m = ${dg.state.gm}）`);
    ok('S5.cut.id', near(dg.state.Id, idCutHand, 1e-6),
      `截止区 I_D 实测 ${dg.state.Id} A ⟷ 手推 5/(1e6+0.01) = ${idCutHand} A（相对残差 ${rel(dg.state.Id, idCutHand).toExponential(2)}）`);

    // ── P 沟道镜像 ──
    const h1 = scene(T, scMosLoad('pmos', RD, VGS)); h1.run(120);
    const h2 = scene(T, scMosPin('pmos', VGS, VDS)); h2.run(120);
    const h3 = scene(T, scMosPin('pmos', VGS_CUT, 5)); h3.run(120);
    const d1 = h1.get(3), d2 = h2.get(2), d3 = h3.get(2);
    ok('S5.p.region', d1.state.region === 'sat' && d2.state.region === 'triode' && d3.state.region === 'cutoff',
      `PMOS 三区镜像都成立：${d1.state.region} / ${d2.state.region} / ${d3.state.region}`);
    ok('S5.p.sign', d1.state.Ugs < 0 && d1.state.Uds < 0 && d1.state.Id > 0,
      `PMOS 恒流区端子电压取负：U_GS = ${d1.state.Ugs.toFixed(6)} V、U_DS = ${d1.state.Uds.toFixed(6)} V、I_D = ${d1.state.Id.toExponential(9)} A（幅值仍为正）`);
    ok('S5.p.mag', near(d1.state.Id, de.state.Id, 1e-9) && near(d2.state.Id, df.state.Id, 1e-9) && near(d3.state.Id, dg.state.Id, 1e-9),
      `PMOS ⟷ NMOS 逐区幅值一致：ΔI_D = ${(d1.state.Id - de.state.Id).toExponential(2)} / ${(d2.state.Id - df.state.Id).toExponential(2)} / ${(d3.state.Id - dg.state.Id).toExponential(2)} A`);
    ok('S5.p.gm', near(d1.state.gm, gmSatHand, 1e-9) && near(d2.state.gm, gmTriHand, 1e-9),
      `PMOS 跨导同样分段且与原手推同值：${d1.state.gm.toExponential(6)} S（∝U_ov）/ ${d2.state.gm.toExponential(6)} S（∝U_DS）`);
    // 沟道对称性 —— 记录一个**刻意保留**的模型边界（不是没想到）：
    // 把 P 沟道的漏源反过来接（漏在高电位），模型的 |I_D| 与工作区不变。物理上这是对的：
    // MOSFET 沟道本身对称，「哪个端子叫源极」是由电流方向**定义**的，反接时高电位那端自动当源极；
    // 真实器件比这里多出来的只有体二极管，而本工程没有二极管支路（约束②只允许 R/V/open）。
    // 代价与收益：面板如实报端子电压符号（反接时 U_DS > 0）⇒ 朝向接错了学生能一眼看出来，不会被悄悄吞掉。
    const flip = scene(T, { entities: [
      { type: 'battery', x: 0, y: 0, props: { emf: VDD, internalR: RINT } },
      { type: 'battery', x: 0, y: 100, props: { emf: VGS, internalR: RINT } },
      { type: 'resistor', x: 100, y: 0, props: { resistance: RD } },
      { type: 'pmos', x: 200, y: 50 },
    ], wires: [[0, MINUS, 3, 2], [0, PLUS, 2, 0], [2, 1, 3, 1], [1, PLUS, 3, 2], [1, MINUS, 3, 0]] });
    flip.run(120);
    const dfl = flip.get(3);
    ok('S5.sym', dfl.state.region === 'sat' && near(dfl.state.Id, idSat, 1e-5) && dfl.state.Uds > 0,
      `沟道对称（刻意边界）：P 沟道按「漏在高电位」反接 ⇒ |I_D| 仍是 ${dfl.state.Id.toExponential(9)} A、区仍是 ${dfl.state.region}，而面板如实报 U_DS = +${dfl.state.Uds.toFixed(6)} V（朝向接反看得出来）`);
  });

  sectionRun('§6 三端当两端用（约束④）：回落契约 + 逐位不变', () => {
    for (const t of ['npn', 'pnp', 'nmos', 'pmos']) {
      const b = scene(T, scTwoWire(t));
      b.run(60);
      const d = b.get(2);
      const two = d.circuitBranches(b.world);
      const one = d.circuitBranch();
      ok('S6.' + t + '.null', two === null,
        `${t}：控制端未接线 ⇒ circuitBranches() 返回 ${JSON.stringify(two)} ⇒ 求解器回落到 circuitBranch()（既有器件走的就是这一条）`);
      ok('S6.' + t + '.count', b.last().branches.size === 3,
        `${t}：整个电路 ${b.last().branches.size} 条支路 = 电源 + 电阻 + 器件自己**一条**（多支路契约在两端用法里不生效）`);
      ok('S6.' + t + '.shape', !!(one && one.type === 'R' && isFinite(one.r) && one.r >= 1 && one.r <= 1e9),
        `${t}：回落支路 type=${one && one.type}、r=${one && one.r} Ω（R 支路且落在 clamp 区间内）`);
      ok('S6.' + t + '.warn', nWarn(b, 'port-ignored') === 0, `${t}：两端用法 0 条 port-ignored 告警`);
    }
    // 加固版：把控制端**强行**当成"接了线"走多支路，看到底会不会改变解 —— 这决定"必须返回 null"是形式还是实质
    for (const t of ['npn', 'nmos']) {
      const f = scene(T, scTwoWire(t));
      f.run(60);
      const proto = Object.getPrototypeOf(f.get(2));
      const bak = proto.circuitBranches;
      proto.circuitBranches = function () {
        const wp = this.def.ports.map((q, i) => (q.kind === 'wire' ? i : -1)).filter((i) => i >= 0);
        return t === 'npn'
          ? [this.ceDef(wp[1], wp[2], false), this.beDef(wp[0], wp[2], false)]
          : [this.dsDef(wp[1], wp[2], false), this.gsDef(wp[0], wp[2])];
      };
      const g = scene(T, scTwoWire(t));
      g.run(60);
      proto.circuitBranches = bak;
      const ratio = Math.abs(g.get(2).state.I) / Math.max(1e-300, Math.abs(f.get(2).state.I));
      if (t === 'npn') {
        ok('S6.npn.forced', g.last().branches.size === 4 && Math.abs(ratio - 1) < 1e-9,
          `NPN：强行走多支路（次边 open、基极悬空）⇒ 支路数 3 → 4，主边电流比值 ${ratio.toFixed(15)}（多出一个孤立结点只动末位，量级不变）`);
      } else {
        const fake = g.get(2).state.gs && g.get(2).state.gs.U;
        ok('S6.nmos.forced', g.last().branches.size === 4 && ratio > 100,
          `MOSFET：同样的强行走法 ⇒ 悬空的栅结点被求解器别名到电源正端、gs 备忘盒读出假栅压 U_GS = ${fake} V ⇒ 沟道被凭空打开，主边电流 ${f.get(2).state.I.toExponential(3)} → ${g.get(2).state.I.toExponential(3)} A（放大 ${ratio.toFixed(1)} 倍）⇒ 契约「控制端没接线就返回 null」是**正确性**要求，不是形式要求`);
      }
    }
  });

  sectionRun('§7 未接线端子不产生假告警（⑦）+ 悬空端子的诚实读数', () => {
    const a = scene(T, scBjt('npn', RB_A));
    a.run(60);
    ok('S7.npn.warn', nWarn(a, 'port-ignored') === 0,
      `基极接线后 port-ignored = ${nWarn(a, 'port-ignored')} 条（基极口被次边 B–E 支路占了 ⇒ 不会被算成"接了线却没用上"）`);
    ok('S7.npn.count', a.last().branches.size === 6,
      `支路数 ${a.last().branches.size} = 2 电源 + 2 电阻 + 器件 2 条（主边 C–E + 次边 B–E）`);
    ok('S7.npn.warnall', warns(a).length === 0, `整条电路 0 条告警（实测 ${JSON.stringify(warns(a))}）`);
    const m = scene(T, scMosLoad('nmos', 500, 5));
    m.run(60);
    ok('S7.mos.warn', nWarn(m, 'port-ignored') === 0, '栅极接线后 port-ignored = 0 条');
    ok('S7.mos.count', m.last().branches.size === 5,
      `支路数 ${m.last().branches.size} = 2 电源 + 1 电阻 + 器件 2 条（主边 D–S + 次边 G–S）`);
    ok('S7.mos.warnall', warns(m).length === 0, `整条电路 0 条告警（实测 ${JSON.stringify(warns(m))}）`);
    // 交付口径要求逐件报「支路数」：四件在**控制端接线**时都必须各出 2 条（主边 + 次边），
    // 与 N/P 极性无关（极性只改支路里 emf 的符号与区域判据，不改支路条数）
    for (const [t, mk, want, why] of [
      ['npn', () => scBjt('npn', RB_A), 6, '2 电源 + 2 电阻 + 器件 2 条（主边 C–E + 次边 B–E）'],
      ['pnp', () => scBjt('pnp', RB_A), 6, '2 电源 + 2 电阻 + 器件 2 条（主边 C–E + 次边 B–E，emf 符号相反）'],
      ['nmos', () => scMosLoad('nmos', 500, 5), 5, '2 电源 + 1 电阻 + 器件 2 条（主边 D–S + 次边 G–S）'],
      ['pmos', () => scMosLoad('pmos', 500, 5), 5, '2 电源 + 1 电阻 + 器件 2 条（主边 D–S + 次边 G–S，emf 符号相反）'],
    ]) {
      const b = scene(T, mk());
      b.run(60);
      const dev = b.get(b.ents.length - 1);
      const mine = [...b.last().branches.keys()]
        .filter((k) => String(k) === String(dev.id) || String(k).startsWith(String(dev.id) + '#')).length;
      ok('S7.count.' + t, b.last().branches.size === want && mine === 2,
        `${t}：${why} ⇒ 全电路 ${b.last().branches.size} 条、器件名下 ${mine} 条（回落成两端用法时器件名下 1 条，见 S6.${t}.count）`);
    }
    for (const t of ['npn', 'nmos']) {
      const b = scene(T, { entities: [{ type: t, x: 0, y: 0 }] });
      b.run(5);
      ok('S7.empty.' + t, warns(b).length === 0 && b.get(0).state.region === 'cutoff' && b.get(0).state.I === 0,
        `${t}：三个端子全空 ⇒ 0 条告警、电流 0、工作区 ${b.get(0).state.region}（未接线的口本来就进不了告警判据，天然不会假报）`);
    }
    // 只悬空一端：必须报「未接入」，且不许留幻影电流
    const fc = scene(T, { entities: [
      { type: 'battery', x: 0, y: 0, props: { emf: 2.7, internalR: RINT } },
      { type: 'resistor', x: 100, y: 0, props: { resistance: 10000 } },
      { type: 'npn', x: 200, y: 50 },
    ], wires: [[0, PLUS, 1, 0], [1, 1, 2, 0], [0, MINUS, 2, 2]] });
    fc.run(60);
    const dfc = fc.get(2);
    ok('S7.float.npn.region', dfc.state.region === 'dead', `集电极悬空 ⇒ 工作区 = ${dfc.state.region}（不报「饱和」这种看着像真的区）`);
    ok('S7.float.npn.ic', dfc.state.Ic === 0,
      `集电极悬空 ⇒ I_C 恒等于 0（实测 ${dfc.state.Ic}）—— 主边是 open 而不是"很小的电阻"，所以没有幻影电流`);
    ok('S7.float.npn.ib', near(dfc.state.Ib, (2.7 - VON) / (10000 + RBE + RINT), 1e-5),
      `物理上对：集电极断开不影响基极回路 ⇒ I_B 实测 ${dfc.state.Ib} ⟷ 手推 2/(10000+100+0.01) = ${((2.7 - VON) / (10000 + RBE + RINT)).toExponential(9)} A`);
    ok('S7.float.npn.warn', nWarn(fc, 'port-ignored') === 0, '悬空的集电极（压根没接线）不会产生 port-ignored');
    ok('S7.float.panel', T.byType.get('npn').stats[0].read(dfc) === '未接入',
      `面板「工作区」= ${JSON.stringify(T.byType.get('npn').stats[0].read(dfc))}（悬空端子的电位被求解器别名到别的结点上、没有物理意义 —— 实测确认，只能如实说未接入）`);
    const fm = scene(T, { entities: [
      { type: 'battery', x: 0, y: 0, props: { emf: 5, internalR: RINT } },
      { type: 'nmos', x: 200, y: 50 },
    ], wires: [[0, PLUS, 1, 0], [0, MINUS, 1, 2]] });
    fm.run(60);
    const dfm = fm.get(1);
    ok('S7.float.mos', dfm.state.region === 'dead' && dfm.state.Id === 0 && dfm.state.gm === 0 && dfm.state.rds === Infinity,
      `漏极悬空 ⇒ ${dfm.state.region} / I_D = ${dfm.state.Id} / g_m = ${dfm.state.gm} / r_ds = ${dfm.state.rds}（四个读数一起说"没接通"，不报半真半假的跨导）`);
    ok('S7.open.bookkeeping', dfc.state.R === Infinity && dfc.state.I === 0 && dfc.state.P === 0,
      `open 支路的记账口径：R === Infinity、I = P = 0（JSON.stringify(Infinity) 会渲染成 null ⇒ dead 判据只能用 === Infinity，不能用 === null）`);
    // 拔线：先把控制端接上线跑 60 帧（器件真的导通），再把那条导线从世界里撤掉，与"从一开始就没接"逐位对比
    for (const spec of [['npn', () => scBjt('npn', RB_A), 4], ['nmos', () => scMosLoad('nmos', 500, 5), 3]]) {
      const [t, mk, idx] = spec;
      const ctrlWire = (b) => {
        const e = b.get(idx);
        return b.world.wiresOf(e).find((x) => x.has({ e: e.id, p: 0 }));
      };
      const p1 = scene(T, mk());
      p1.run(60);
      const on = p1.get(idx).state.region;
      p1.world.disconnect(ctrlWire(p1));
      p1.run(60);
      const p0 = scene(T, mk());
      p0.world.disconnect(ctrlWire(p0));
      p0.run(60);
      const a1 = p1.get(idx), a0 = p0.get(idx);
      const bit = ['I', 'U', 'P', 'R'].every((k) => Object.is(a1.state[k], a0.state[k]));
      const ctrl = t === 'npn' ? a1.state.Ube : a1.state.Ugs;
      ok('S7.unplug.' + t, bit && p1.last().branches.size === p0.last().branches.size,
        `${t}：接上控制端（工作区 ${on}）跑 60 帧后**拔掉**那条导线，再跑 60 帧 ⇒ 与"从未接过控制端"的同一电路 Object.is 逐位同解（I/U/P/R 四项 + 支路数 ${p1.last().branches.size}）＝ 备忘盒没留陈旧控制电压`);
      ok('S7.unplug.' + t + '.ctrl', ctrl === 0 && warns(p1).length === 0 && nWarn(p1, 'port-ignored') === 0,
        `${t}：拔线后控制端读数归零（${t === 'npn' ? 'U_BE' : 'U_GS'} = ${ctrl}）且 0 条告警；工作区 ${a1.state.region} ⇒ 不会"拔了线还在放大/导通"`);
    }
  });

  sectionRun('§8 面板读数 def.stats：行数、行名、格式化器、数值口径', () => {
    const a = scene(T, scBjt('npn', RB_A));
    a.run(120);
    const d = a.get(4);
    const rows = d.def.stats;
    const vals = rows.map((r) => r.read(d));
    const show = (v) => (typeof v === 'number' ? v.toPrecision(7) : JSON.stringify(v));
    ok('S8.count.npn', rows.length === 8, `NPN 读数 ${rows.length} 行：${rows.map((r) => r.label).join(' | ')}`);
    ok('S8.numeric', vals.slice(1).every((v) => typeof v === 'number' && isFinite(v)) && typeof vals[0] === 'string',
      `第一行给中文区名 ${JSON.stringify(vals[0])}，其余 ${vals.length - 1} 行都是有限数值：${vals.slice(1).map(show).join(' / ')}`);
    ok('S8.fmt', rows.every((r) => !r.fmt || (typeof r.fmt(r.read(d)) === 'string' && r.fmt(r.read(d)).length > 0)),
      `带 fmt 的行都能渲染成非空字符串（例：${rows.filter((r) => r.fmt).slice(0, 3).map((r) => r.label + ' → ' + r.fmt(r.read(d))).join('，')}）`);
    ok('S8.region', rows[0].read(d) === '放大', `第一行「工作区」直接给中文区名 ${JSON.stringify(rows[0].read(d))}（与 state.region=active 对应）`);
    ok('S8.fmtapi', typeof T.C.fmtA === 'function' && typeof T.C.fmtV === 'function',
      `读数共用物理层的格式器：fmtA(4.9875e-3) = ${T.C.fmtA(4.987531054976569e-3)}、fmtV(7.0124) = ${T.C.fmtV(7.012419074700087)}（与既有器材同一套口径）`);
    const mm = scene(T, scMosPin('nmos', 5, 5));
    mm.run(60);
    const mrows = mm.get(2).def.stats;
    ok('S8.count.nmos', mrows.length === 7, `MOSFET 读数 ${mrows.length} 行：${mrows.map((r) => r.label).join(' | ')}`);
    ok('S8.mos.rows', mrows.slice(1).every((r) => typeof r.read(mm.get(2)) === 'number' && isFinite(r.read(mm.get(2)))),
      `MOSFET 第一行 ${JSON.stringify(mrows[0].read(mm.get(2)))}，其余每行都给有限数值：${mrows.slice(1).map((r) => r.label + '=' + r.read(mm.get(2)).toPrecision(6)).join(' / ')}`);
  });

  sectionRun(`§9 与**冻结基准提交** ${BASE_COMMIT} 的逐位回归：既有器材一件都不许变（参照物不随 HEAD 前进）`, () => {
    // --mutate 模式**按设计不参与**：§9 比的是"被测树 vs 冻结基准"，与被替换的那一行代码无关；
    // 变异模式只问"某条断言会不会因这次替换而变红"，若让 §9 在这里跑，它的红只反映"工作区相对基准
    // 动没动既有器材"（并发合法编辑也会让它红），与变异无关 ⇒ 污染对照组（ctrlBad）、毁掉每行变异的归因。
    // 它的敏感度由 --self-check 用**差分法**单独自证：同一棵树只改一行 ⇒ §9.bit 必须翻转。
    if (MUTATE) { info('§9 在 --mutate 模式按设计跳过（镜像对照在变异模式没有归因意义；敏感度见 --self-check）'); return; }
    if (!BASE) {
      ok('S9.base.mirror', false, `取不到基准提交 ${BASE_COMMIT} 的镜像：${BASE_ERR}`);
      return;
    }
    // ① 参照物本身还有效吗：基准提交必须是 HEAD 的祖先
    //    （历史被改写 ⇒ 写死的 sha 不再指向"改动前"，镜像内容也就不可信 ⇒ 该红）
    let anc = null, ancErr = '';
    try { execFileSync('git', ['merge-base', '--is-ancestor', BASE_COMMIT, 'HEAD'], { cwd: ROOT_DIR }); anc = true; }
    catch (err) { anc = false; ancErr = String((err && err.message) || err).split('\n')[0]; }
    ok('S9.base.commit', anc === true,
      `基准提交 ${BASE_COMMIT} 仍是 HEAD 的祖先 ⇒ 冻结参照物指向的确实是"task-1 之前"${anc ? '' : `；实测失败：${ancErr}`}`);
    // ② 历史记录式断言（口径 a）：冻结两个 sha，问"task-1 那次提交碰了哪些文件"
    //    只读**提交内容**、不读工作区、不看 HEAD ⇒ 恒真、且对并发合法编辑免疫（上一版的病根就在"看 HEAD"）
    let changed = null, histErr = '';
    try {
      changed = gitOut(['diff', '--name-only', `${BASE_COMMIT}..${TASK1_COMMIT}`]).split('\n').map((s) => s.trim()).filter(Boolean);
    } catch (err) { histErr = String((err && err.message) || err).split('\n')[0]; }
    const GUARDED = ['src/physics/circuit.js', 'src/ui/inspector.js', 'src/equipment/electrical.js', 'src/core/entity.js'];
    const touched = changed ? GUARDED.filter((rel) => changed.includes(rel)) : [];
    ok('S9.hist.scope', changed !== null && touched.length === 0,
      changed === null
        ? `读不到 ${BASE_COMMIT}..${TASK1_COMMIT} 的改动名单（${histErr}）⇒ 这条历史记录失效（它护的东西已由 S9.bit 与 S9.live.owner 接手）`
        : `冻结区间 ${BASE_COMMIT}→${TASK1_COMMIT} 的改动名单 = [${changed.join(', ')}]，其中不含 ${GUARDED.length} 个受保护源文件（${GUARDED.map((s) => s.split('/').pop()).join(' / ')}）⇒ "task-1 的改动只落在 electronics.js + 探针"作为历史记录成立（zero-regression.mjs 是当时工作区里已被别人改好、被同一次提交顺带收进去的，与 task-1 无关）`);
    // ③ 活口径（接管 S9.untouched.* 的本意）：四个新器材的类型名只许出现在 electronics.js 一个文件里
    //    只读**被测树**的当前内容（剥注释），不比对 git 字节 ⇒ 对并发合法编辑与任何新提交都免疫
    const NEW4 = ['npn', 'pnp', 'nmos', 'pmos'];
    const scanHits = [];
    const walkSrc = (d) => readdirSync(d, { withFileTypes: true })
      .flatMap((e) => (e.isDirectory() ? walkSrc(path.join(d, e.name)) : [path.join(d, e.name)]));
    let scanned = 0;
    for (const f of walkSrc(T.srcDir)) {
      if (!/\.(js|mjs)$/.test(f)) continue;
      scanned++;
      const rel = path.relative(T.srcDir, f).split(path.sep).join('/');
      const body = stripComments(readFileSync(f, 'utf8'));
      const n = NEW4.reduce((a, t) => a + (body.split(`'${t}'`).length - 1), 0);
      if (n) scanHits.push(`${rel}×${n}`);
    }
    ok('S9.live.owner', scanHits.length === 1 && scanHits[0].startsWith('equipment/electronics.js'),
      `扫了 ${scanned} 个 src 文件（剥注释后）：四个新类型名只出现在 ${scanHits.join('、') || '（一处都没有！）'} ⇒ 新器材没溜到别的文件/别的插件里去（这条是 S9.untouched.* 的活口径接管者：守的还是"task-1 的改动只落在 electronics.js 一个文件里"，但只读当前内容 ⇒ 别人合法改别的文件不会打红它）`);
    // ④ 镜像身份（恒真的不变量，不做"正好差 4 件"这种会被别人新器材打红的断言）
    const workTypes = T.reg.list().map((q) => q.type);
    const baseTypes = BASE.reg.list().map((q) => q.type);
    const missingNew = NEW4.filter((t) => !workTypes.includes(t));
    const leaked = NEW4.filter((t) => baseTypes.includes(t));
    const lost = baseTypes.filter((q) => !workTypes.includes(q));
    const added = workTypes.filter((q) => !baseTypes.includes(q)).sort();
    ok('S9.types.new', missingNew.length === 0,
      `被测树注册了全部四个新类型${missingNew.length ? '（缺 ' + missingNew.join('/') + '）' : ''}：${NEW4.join(' / ')}`);
    ok('S9.types.base', leaked.length === 0,
      `基准提交 ${BASE_COMMIT} 的镜像**不含**任何新类型${leaked.length ? '（竟含 ' + leaked.join('/') + '）' : ''} ⇒ 镜像确实是"改动前的真身"，不是"另一份实现"`);
    ok('S9.types.subset', lost.length === 0,
      `基准树的 ${baseTypes.length} 个类型全部仍在被测树里${lost.length ? '（丢了 ' + lost.join('/') + '）' : ''}；两树差集 = [${added.join(', ') || '（空）'}]（只作记录，不断言"正好差 4 件"—— 别人以后加器材是与本探针无关的合法改动，不该打红它）`);
    // ⑤ 行为级逐位对比：§9 的全部价值所在（判据与 task-1 交付时一致，只换了参照物）
    //    镜像 = 工作区 src + 只把 electronics.js 换成基准提交的字节 ⇒ 两侧共享受测树的其它文件，
    //    差异只能来自 electronics.js ⇒ 既对并发合法编辑免疫，又保住"既有器材解变了就红"的敏感度
    let pairs = 0, bothThrew = 0;
    const mism = [], skipped = [], detail = [];
    for (const q of baseTypes) {
      if (q === 'battery') continue;
      for (const extraR of [0, 1000]) {
        const sc = scGeneric(T, q, extraR);
        if (!sc) { if (!skipped.includes(q)) skipped.push(q); continue; }
        pairs++;
        const runc = (tree) => {
          try {
            const b = scene(tree, sc);
            b.run(30);
            return { ok: true, snap: b.snap(), n: b.last().branches.size };
          } catch (err) { return { ok: false, err: err.message }; }
        };
        const w = runc(T), h = runc(BASE);
        if (!w.ok && !h.ok) { bothThrew++; continue; }
        if (w.ok !== h.ok) { mism.push(`${q}${extraR ? '+R' : ''}(抛异常不一致)`); continue; }
        let bad = w.n !== h.n || w.snap.length !== h.snap.length;
        for (let i = 0; !bad && i < w.snap.length; i++) {
          for (const k of ['I', 'U', 'P', 'R']) if (!Object.is(w.snap[i][k], h.snap[i][k])) bad = true;
        }
        if (bad) {
          mism.push(q + (extraR ? '+R' : ''));
          // 诊断用：把不一致的电路摊开 —— 让人一眼看出是"真回归"还是"有意的器件行为改动"
          if (detail.length < 2) {
            const rows = [];
            for (let i = 0; i < Math.min(w.snap.length, h.snap.length); i++) {
              for (const k of ['I', 'U', 'P', 'R']) {
                if (!Object.is(w.snap[i][k], h.snap[i][k])) rows.push(`${i}:${w.snap[i].type}.${k} 被测=${w.snap[i][k]} 基准=${h.snap[i][k]}`);
              }
            }
            detail.push(`[${q}${extraR ? '+1kΩ' : ''} 支路数 ${w.n}vs${h.n}] ${rows.slice(0, 6).join(' ｜ ')}`);
          }
        }
      }
    }
    ok('S9.bit', mism.length === 0,
      `既有器材 ${baseTypes.length - 1} 件、每件 2 种接线（裸接 / 串 1 kΩ）⇒ 实际建成 ${pairs} 个电路${skipped.length ? `（${skipped.join('/')} 的 wire 口不足 2 个 ⇒ 跳过，未计入）` : ''}，逐件 Object.is 对比 I/U/P/R 与支路数：${mism.length ? '不一致 → ' + mism.join(' ') : '全部逐位相同'}${bothThrew ? `（另有 ${bothThrew} 个电路两棵树都抛异常、判为等价）` : ''}`);
    for (const d of detail) info('S9.bit 不一致明细：' + d);
    info(`既有器材清单（基准 ${BASE_COMMIT}）：${baseTypes.filter((q) => q !== 'battery').join(' ')}`);
  });
}

// ── §9 用的通用接线：电源 + 待测件（可选再串一个电阻），端口取该件前两个 wire 口 ──
function scGeneric(T, type, extraR) {
  const d = T.byType.get(type);
  if (!d) return null;
  const wp = d.ports.map((p, i) => (p.kind === 'wire' ? i : -1)).filter((i) => i >= 0);
  if (wp.length < 2) return null;
  const entities = [
    { type: 'battery', x: 0, y: 0, props: { emf: 6, internalR: RINT } },
    { type, x: 100, y: 0 },
  ];
  const wires = [[0, PLUS, 1, wp[0]]];
  if (extraR) {
    entities.push({ type: 'resistor', x: 200, y: 0, props: { resistance: extraR } });
    wires.push([1, wp[1], 2, 0], [2, 1, 0, MINUS]);
  } else wires.push([1, wp[1], 0, MINUS]);
  return { entities, wires };
}

// ══════════════════════════════════════════════════════════
// 镜像 / 变异体基础设施
//   · 每棵镜像 = %TEMP% 里 src 的一份完整拷贝（相对 import 照样成立），仓库**零字节副作用**
//   · 基准镜像：把 electronics.js 换成 `git show <冻结基准>:` 的字节 ⇒ "改动前的真身"
//     （只换这一个文件是刻意的：两侧于是共享被测树的其余文件 ⇒ 差异只能来自 electronics.js，
//      对并发合法编辑免疫，同时保住"既有器材的解变了就红"的敏感度）
//   · 变异体镜像：把锚点行替换掉，其余照旧 ⇒ 同一套断言重跑一遍，看它是否变红
// ══════════════════════════════════════════════════════════
const TMP_ROOT = path.join(os.tmpdir(), 'xm-transistor-probe');
function gitShow(rel, rev = BASE_COMMIT) {
  return execFileSync('git', ['show', rev + ':' + rel], { cwd: ROOT_DIR, maxBuffer: 1 << 26 });
}
/** git 只读查询（返回 utf8 文本；失败抛异常 ⇒ 调用方负责降级） */
function gitOut(args) {
  return execFileSync('git', args, { cwd: ROOT_DIR, maxBuffer: 1 << 26 }).toString('utf8');
}
function mirrorSrc(name, patches) {
  const dir = path.join(TMP_ROOT, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  cpSync(SRC_DIR, path.join(dir, 'src'), { recursive: true });
  for (const [rel, body] of Object.entries(patches || {})) writeFileSync(path.join(dir, 'src', rel), body);
  return path.join(dir, 'src');
}
/** 静默跑一遍整套断言，返回变红的 id 列表（§9 在 MUTATE 模式自己跳过 ⇒ 对照组只统计与变异有关的断言） */
async function runSilent(T) {
  RESULTS.length = 0;
  const keep = VERBOSE;
  VERBOSE = false;
  pass = 0; fail = 0;
  await runSuite(T);
  VERBOSE = keep;
  return RESULTS.filter((r) => !r.ok).map((r) => r.id);
}

// ══════════════════════════════════════════════════════════
// 变异体清单：每条新断言至少被一个变异体照到
//   锚点 = 一行代码（剥注释后必须仍然唯一命中 ⇒ 证明它不在注释里）
//   expect = 这个变异体**必须**让它变红的断言 id（子集即可，多红不算错但要列出来）
// ══════════════════════════════════════════════════════════
const MUTANTS = [
  { name: 'cutoff-判据变成 U_BE<0', old: `  if (!(UBE > vbeOn)) return 'cutoff';`,
    new: `  if (UBE < 0) return 'cutoff';   // MUTANT`, expect: ['S1.cutoff', 'S3.cut.region'] },
  { name: '饱和判据只剩电压项', old: `  if (beta * IB > IC || UCE < vceSat) return 'sat';`,
    new: `  if (UCE < vceSat) return 'sat';   // MUTANT`, expect: ['S1.sat.cur', 'S3.sat.stable'] },
  { name: 'MOSFET 区判据 U_DS<U_ov → U_DS<0', old: `  if (UDS < vov) {`,
    new: `  if (UDS < 0) {   // MUTANT`, expect: ['S2.triode', 'S5.tri.region'] },
  { name: '恒流区电流 k·U_ov² → k·U_ov', old: `  return { region: 'sat', vov, id: k * vov * vov, gm: 2 * k * vov };`,
    new: `  return { region: 'sat', vov, id: k * vov, gm: 2 * k * vov };   // MUTANT`, expect: ['S2.sat', 'S5.sat.id'] },
  { name: '恒流段跨导 2k·U_ov → k·U_ov', old: `  return { region: 'sat', vov, id: k * vov * vov, gm: 2 * k * vov };`,
    new: `  return { region: 'sat', vov, id: k * vov * vov, gm: k * vov };   // MUTANT`, expect: ['S2.sat', 'S5.sat.gm'] },
  { name: '可变电阻段跨导 k·U_DS → 2k·U_DS', old: `    return { region: 'triode', vov, id: Math.max(0, id), gm: k * UDS };`,
    new: `    return { region: 'triode', vov, id: Math.max(0, id), gm: 2 * k * UDS };   // MUTANT`, expect: ['S2.triode', 'S5.tri.gm'] },
  { name: '发射结恒压降归零', old: `emf: s * Math.max(0, this.props.vbeOn),`,
    new: `emf: 0,   // MUTANT`, expect: ['S3.act.region', 'S3.act.ube'] },
  { name: '放大区等效电阻取倒数', old: `    return clamp(uce / ic, 1e-3, 1e9);`,
    new: `    return clamp(ic / uce, 1e-3, 1e9);   // MUTANT`, expect: ['S3.act.ic', 'S3.act.uce'] },
  { name: 'NPN/PNP 极性退化', old: `  sgn() { return this.type === 'pnp' ? -1 : 1; }`,
    new: `  sgn() { return 1; }   // MUTANT`, expect: ['S4.p.region'] },
  { name: 'P/N 沟道极性退化', old: `  sgn() { return this.type === 'pmos' ? -1 : 1; }`,
    new: `  sgn() { return 1; }   // MUTANT`, expect: ['S5.p.region'] },
  { name: 'MOSFET 沟道电阻取倒数', old: `    return clamp(uds / m.id, 1e-3, 1e9);`,
    new: `    return clamp(m.id / uds, 1e-3, 1e9);   // MUTANT`, expect: ['S5.sat.uds', 'S5.sat.id'] },
  { name: 'BJT 多支路退化成单支路', old: `    return [this.ceDef(p[1], p[2], deadCe), this.beDef(p[0], p[2], deadBe)];`,
    new: `    return [this.ceDef(p[1], p[2], deadCe)];   // MUTANT`, expect: ['S7.npn.count', 'S7.npn.warn'] },
  { name: 'MOSFET 多支路退化成单支路', old: `    return [this.dsDef(p[1], p[2], dead), this.gsDef(p[0], p[2])];`,
    new: `    return [this.dsDef(p[1], p[2], dead)];   // MUTANT`, expect: ['S7.mos.count', 'S7.mos.warn'] },
  { name: '控制端空着也照走多支路', old: `    if (!portWired(this, world, p[0])) return null;\n    const deadBe`,
    new: `    if (false) return null;   // MUTANT\n    const deadBe`, expect: ['S6.npn.count', 'S6.npn.null'] },
  { name: '悬空端子不报 dead', old: `    this.state.region = open ? 'dead' : bjtRegion({ UBE: ube, UCE: uce, IB: ib, IC: ic,`,
    new: `    this.state.region = bjtRegion({ UBE: ube, UCE: uce, IB: ib, IC: ic,`, expect: ['S7.float.npn.region', 'S7.float.panel'] },
  { name: '悬空主边仍给电阻（幻影电流）', old: `    const st = this.state.ce || (this.state.ce = {});\n    if (dead) return { type: 'open', a, b, state: st };`,
    new: `    const st = this.state.ce || (this.state.ce = {});\n    if (dead && false) return { type: 'open', a, b, state: st };   // MUTANT`, expect: ['S7.float.npn.ic'] },
  { name: '悬空漏源仍算跨导', old: `    this.state.gm = open ? 0 : m.gm;`,
    new: `    this.state.gm = m.gm;   // MUTANT`, expect: ['S7.float.mos'] },
  { name: '面板 U_BC 符号写反', old: `    this.state.Ubc = this.state.Ube - this.state.Uce;`,
    new: `    this.state.Ubc = this.state.Ube + this.state.Uce;   // MUTANT`, expect: ['S4.sign.bc'] },
  { name: '读数行名去掉端子字母（⑤）', old: `{ label: '电压BE U_BE', read: (e) => e.state.Ube || 0, fmt: fmtV },`,
    new: `{ label: '电压 U_BE', read: (e) => e.state.Ube || 0, fmt: fmtV },   // MUTANT`,
    expect: ['S0.stats.npn', 'S0.convention'] },
  { name: '截止区大电阻量级写错（1e6 → 1e3）', old: `const offR = (mohm) => clamp(mohm * 1e6, 1, 1e9);`,
    new: `const offR = (mohm) => clamp(mohm * 1e3, 1, 1e9);   // MUTANT`, expect: ['S3.cut.ic'] },
  { name: '拔线后不丢陈旧基极备忘盒', old: `    delete this.state.be;`, new: `    // MUTANT：不丢`, expect: ['S7.unplug.npn'] },
  { name: '拔线后不丢陈旧栅压备忘盒', old: `    delete this.state.gs;`, new: `    // MUTANT：不丢`, expect: ['S7.unplug.nmos'] },
];

// ══════════════════════════════════════════════════════════
// main
// ══════════════════════════════════════════════════════════
try {
  BASE = await loadTree(mirrorSrc('base', { 'equipment/electronics.js': gitShow('src/equipment/electronics.js') }), 'BASE');
} catch (err) { BASE_ERR = (err && err.message) || String(err); }

if (SELFCHECK) {
  head(`§11 --self-check：§9 的敏感度自证（差分法：同一棵树只做一处破坏 ⇒ 对应断言必须翻转）`);
  // ① 干净镜像（工作区一字不改）：§9 应当全绿 —— 若非绿，说明"工作区相对基准真的动过既有解"，如实报告
  const clean = await loadTree(mirrorSrc('sc-clean', null), 'sc-clean');
  const cleanRed = await runSilent(clean);
  const cleanS9 = cleanRed.filter((id) => id.startsWith('S9.'));
  // ② 破坏 A：把一件**既有器材**的支路换成常数电阻。刻意用运行时替换工厂、不依赖任何源码行
  //    （electronics.js 正在被队友并发编辑，写死的源码锚点会被他们的编辑漂移掉 —— 本次实测就撞到了）
  const target = ['resistorcap', 'inductorcoil', 'photoresistor', 'diode', 'acsource'].find((t) => clean.byType.has(t));
  const bad = await loadTree(mirrorSrc('sc-bad', null), 'sc-bad');
  const def = bad.byType.get(target);
  const origCreate = def.create;
  def.create = (x, y) => {
    const e = origCreate(x, y);
    e.circuitBranch = () => ({ type: 'R', r: 137 });
    if (typeof e.circuitBranches === 'function') e.circuitBranches = undefined;  // 保证走回落支路
    return e;
  };
  const scOne = scGeneric(clean, target, 0);
  const runOne = (T) => {
    const b = scene(T, scOne);
    b.run(30);
    const e = b.ents.find((q) => q.type === target);
    return { n: b.last().branches.size, I: e.state.I, U: e.state.U, P: e.state.P, R: e.state.R };
  };
  const c1 = runOne(clean), c2 = runOne(bad);
  const moved = !Object.is(c1.I, c2.I) || !Object.is(c1.U, c2.U) || !Object.is(c1.R, c2.R);
  ok('S11.sabotage', moved,
    `破坏真的改了行为（既有器材 ${target} 的支路被换成 137 Ω）：I ${c1.I} → ${c2.I}；U ${c1.U} → ${c2.U}；R ${c1.R} → ${c2.R}（支路数 ${c1.n} → ${c2.n}）`);
  const badRed = await runSilent(bad);
  const badS9 = badRed.filter((id) => id.startsWith('S9.'));
  const bitFlipped = !cleanRed.includes('S9.bit') && badRed.includes('S9.bit');
  ok('S11.bitFlip', bitFlipped,
    `差分：干净镜像 §9 红 ${cleanS9.length ? cleanS9.join(' ') : '0 条'}；只把那件既有器材的支路换成 137 Ω 后 §9 红 ${badS9.length ? badS9.join(' ') : '0 条'}（S9.bit ${badRed.includes('S9.bit') ? '红' : '没红'}）⇒ ${bitFlipped ? '这个翻转可归因于"既有器材的解变了" ⇒ §9.bit 真的能红' : '无法做差分自证：干净树自己就把 S9.bit 打红了 ⇒ 工作区相对基准已经动过既有解，这是真红，得先查是谁动的'}`);
  // ③ 破坏 B：把一个新器材的类型名塞进**另一个** src 文件（新写一个文件，不碰任何现有文件）⇒ S9.live.owner 必须红
  const dup = await loadTree(mirrorSrc('sc-dup', { 'equipment/zzz-selfcheck-dup.js': `export const NAME = 'npn';\n` }), 'sc-dup');
  const dupRed = await runSilent(dup);
  const dupS9 = dupRed.filter((id) => id.startsWith('S9.'));
  const ownerCaught = !cleanRed.includes('S9.live.owner') && dupRed.includes('S9.live.owner');
  ok('S11.owner', ownerCaught,
    `差分：多出一个"别处也声明 'npn' 的文件"后 §9 红 ${dupS9.length ? dupS9.join(' ') : '0 条'}（S9.live.owner ${dupRed.includes('S9.live.owner') ? '红' : '没红'}）⇒ 活口径真的能抓到"新器材溜到别的文件里去"（这条接管的正是 S9.untouched.* 的本意）`);
  const okAll = moved && bitFlipped && ownerCaught;
  console.log('\n\x1b[1mTRANSISTOR_SELFCHECK_JSON\x1b[0m ' + JSON.stringify({
    target, cleanS9Red: cleanS9, sabotageS9Red: badS9, dupS9Red: dupS9,
    behaviorChanged: moved, bitFlipped, ownerCaught, ok: okAll,
  }));
  if (!okAll) process.exit(1);
} else if (!MUTATE) {
  const T0 = await loadTree(SRC_DIR, 'work');
  await runSuite(T0);
  const reds = RESULTS.filter((r) => !r.ok).map((r) => r.id);
  console.log('\n\x1b[1mTRANSISTOR_JSON\x1b[0m ' + JSON.stringify({
    items: pass + fail, pass, fail, mutate: false, baseCommit: BASE_COMMIT, baseMirror: !!BASE, redIds: reds,
  }));
  if (fail) process.exit(1);
} else {
  head('§10 --mutate：每条新断言配一个变异体（变异体只写进 %TEMP% 的 src 镜像，仓库零字节副作用）');
  const ctrlRed = await runSilent(await loadTree(mirrorSrc('ctrl', null), 'ctrl'));
  ok('S10.ctrl', ctrlRed.length === 0,
    `对照组（镜像但一字不改）红 ${ctrlRed.length} 条${ctrlRed.length ? '：' + ctrlRed.join(' ') : ''} ⇒ 断言本身不存在"见谁都红"的假阳性`);
  let expectedRed = 0, observedRed = 0, landed = 0;
  const rows = [];
  for (const mu of MUTANTS) {
    const rel = mu.file || 'equipment/electronics.js';
    const raw = readRaw(rel);
    const code = stripComments(raw);
    const nRaw = raw.split(mu.old).length - 1;
    const nCode = code.split(mu.old).length - 1;
    const landedOk = nRaw === 1 && nCode === 1;
    let red = ['（锚点没落上，未执行）'];
    if (landedOk) {
      const mutated = raw.replace(mu.old, mu.new);
      const appliedClean = mutated.includes(mu.new) && mutated.split(mu.old).length - 1 === 0;
      if (!appliedClean) red = ['（替换没生效）'];
      else {
        landed++;
        const t = await loadTree(mirrorSrc('m-' + landed, { [rel]: mutated }), 'mut');
        red = await runSilent(t);
      }
    }
    const caught = mu.expect.filter((id) => red.includes(id));
    const extra = red.filter((id) => !mu.expect.includes(id));
    expectedRed += mu.expect.length;
    observedRed += caught.length;
    const rowOk = landedOk && caught.length === mu.expect.length;
    rows.push({ name: mu.name, expectedRed: mu.expect.length, observedRed: caught.length,
      ok: rowOk, landInCode: nCode === 1, hits: nRaw, missing: mu.expect.filter((id) => !red.includes(id)),
      extraReds: extra.length });
    ok('S10.' + mu.name, rowOk,
      `${rowOk ? '已红' : '未红'}｜${mu.name}｜锚点命中 ${nRaw} 次（剥注释后 ${nCode} 次）｜期望红 ${mu.expect.length} 条、实红 ${caught.length} 条${rowOk ? '' : '｜漏红：' + JSON.stringify(mu.expect.filter((id) => !red.includes(id)))}｜连带红 ${extra.length} 条`);
  }
  console.log('');
  for (const r of rows) {
    console.log(`    ${r.ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${r.name.padEnd(30)} 期望 ${r.expectedRed} / 实红 ${r.observedRed}${r.landInCode ? '' : ' ⚠锚点不在代码行'}${r.extraReds ? ` （连带红 ${r.extraReds} 条：变异体不孤立，正常）` : ''}`);
  }
  const okAll = observedRed === expectedRed && ctrlRed.length === 0 && landed === MUTANTS.length;
  ok('S10.summary', okAll,
    `期望变红 ${expectedRed} 条，实测变红 ${observedRed} 条；变异体落点 ${landed}/${MUTANTS.length}；对照组误红 ${ctrlRed.length} 条`);
  console.log('\n\x1b[1mTRANSISTOR_MUTATE_JSON\x1b[0m ' + JSON.stringify({
    expectedRed, observedRed, ctrlBad: ctrlRed.length, mutants: MUTANTS.length, landed, ok: okAll,
  }));
  console.log('\x1b[1mTRANSISTOR_JSON\x1b[0m ' + JSON.stringify({
    items: pass + fail, pass, fail, mutate: true, ctrlBad: ctrlRed.length,
    lastMutantReds: RESULTS.filter((r) => !r.ok).map((r) => r.id),
  }));
  if (!okAll) process.exit(1);
}
