#!/usr/bin/env node
// ══════════════════════════════════════════════════════════
// 无头探针：新增器材「单刀双掷开关 spdt」+「发光二极管 led」
//
//   node tools/spdt-led-probe.mjs            绿档（exit 0 = 全部通过）
//   node tools/spdt-led-probe.mjs --mutate   红档（变异体落在 %TEMP%，仓库零字节副作用）
//
// ── 为什么这两件器材的**全部风险都在电路求解器的支路规则上** ──
// 逐字引自 src/physics/circuit.js（不是推断）：
//   · :104-109  多支路契约 `circuitBranches(world)`：返回非空数组即整体接管，`defs[0]` 为假值则整件跳过
//   · :130      `used.add(ia); used.add(ib);`  —— `used` 只记「端口对合法」，**与 br.type 无关**
//   · :138      `const orphan = wp.filter((i) => wired(i) && !used.has(i));`
//               ⇒ 接线柱「接了线却不在任何合法支路里」才告警 ⇒ spdt 未选中那一路必须**出现在支路里**
//   · :185/:250 open 不参与连通性合并、不盖章；:310 `else if (br.type === 'open') { I = 0; R = Infinity; }`
//               ⇒ `open` 是一等公民，不是"缺失" ⇒ 它就是 spdt 未选中路的正解
//   · :327/:329 `const primary = !b.bi;` / `if (primary) Object.assign(b.ent.state, { I, U, P, R });`
//               ⇒ 实体级 state.U/I/P/R 由 **bi === 0** 那条独占 ⇒ 选中路必须放第 0 条
//   · :308      `I = si ? -x[n + si.idx] : 0;`  —— V 支路上报的 I **带负号**，与 R 支路取向相反
//               ⇒ led 的亮度一律取 Math.abs(state.I)；通断判决用 U（与既有 diode 同型）
//
// ── 每条判据都有稳定 id，红档按 id 对比「声明红集 ≡ 实测红集」 ──
// 本仓红线：不会红的断言比没有断言更坏。所以 §9 的每个变异体都必须
//   ① `landInCode`（锚在该文件里**恰好命中一次**、盘上的变异体字节 == 预期拼接结果）
//   ② 声明红集**逐 id 等于**实测红集；控制组（id 以 CTRL- 开头）在任何变异体下都不得变红。
// ══════════════════════════════════════════════════════════

import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

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

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const SRC_REL = 'src/equipment/electronics.js';
const SRC_ABS = join(ROOT, SRC_REL);
const DT = 1 / 120;
const MUTATE = process.argv.includes('--mutate');

// ── 判据收集器 ────────────────────────────────────────────
let RESULTS = [];
let PASS = 0, FAIL = 0, QUIET = false;
const HEAD = (t) => { if (!QUIET) console.log('\n\x1b[36m' + t + '\x1b[0m'); };
const INFO = (t) => { if (!QUIET) console.log('    \x1b[90m' + t + '\x1b[0m'); };
const check = (id, cond, msg) => {
  RESULTS.push({ id, red: !cond });
  if (cond) { PASS++; if (!QUIET) console.log('  \x1b[32m✓\x1b[0m ' + msg); }
  else { FAIL++; if (!QUIET) console.log('  \x1b[31m✗\x1b[0m ' + msg); }
};
const reds = () => RESULTS.filter((r) => r.red).map((r) => r.id);
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const fmt = (v, n = 6) => (Number.isFinite(v) ? v.toFixed(n) : String(v));

// ── 无头宿主（等价于浏览器引导；★ 变异体必须绑到**自己的**注册表） ──
function hostOf(electronicsMod) {
  const bootApp = {
    services: {}, ticks: [], world: null, lastCircuit: null, selected: null,
    log: { push() {}, clear() {} }, toast() {},
    addTick(fn) { this.ticks.push(fn); return () => {}; },
  };
  const h = new PluginHost(bootApp);
  for (const p of [physicsPlugin, chemistryPlugin, bridgePlugin,
    electricalPlugin, glasswarePlugin, labPlugin]) h.define(p);
  h.define(electronicsMod.default);
  h.installAll();
  // ★ registry.js 的 target() 每次都读 currentRegistry() || DEFAULT；define()/create() 都走它。
  //   不绑的话，变异体里的 define() 会抛「没有可用注册表」，或者更坏：静默用回**原版**注册表，
  //   于是变异体"跑过了"却什么都没变（假绿）。
  bindRegistry(h.registry('equipment'));
  return h;
}

/** 场景装配：与 main.js 的 instrumentWorld 同一条流水线（造支路→解电路→分发→世界步进） */
function build(sc) {
  const world = new World();
  const cb = new CouplingBus(world);
  const raw = world.step.bind(world);
  const ents = [];
  for (const o of sc.entities || []) {
    const ent = create(o.type, o.x, o.y);
    if (!ent) { INFO('!! 无法创建器材: ' + o.type); continue; }
    if (o.props) for (const k of Object.keys(o.props)) ent.setProp(k, o.props[k]);
    if (o.state) Object.assign(ent.state, o.state);
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
    run(sec, hook) { for (let i = 0, n = Math.round(sec / DT); i < n; i++) this.tick(DT, hook); return this.last; },
    last: null,
    render() { for (const e of world.entities) e.render(MOCK); },
  };
}
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
const MOCK = mockCtx();

/** 跑 n 帧并在末帧取解 */
function settle(sc, frames = 40) {
  const S = build(sc);
  let c = null;
  for (let i = 0; i < frames; i++) { S.render(); c = S.tick(DT); }
  return { S, c };
}
const recOf = (c, ent) => (c && c.branches ? c.branches.get(ent.id) : undefined);
const recNth = (c, ent, k) => (c && c.branches ? c.branches.get(ent.id + '#' + k) : undefined);
const warnOf = (c, ent) => ((c && c.warnings) || []).filter((w) => w.entId === ent.id);

// ══════════════════════════════════════════════════════════
// 场景配方（全部在这里，判据只读实测）
// ══════════════════════════════════════════════════════════

/** 换向场景：电源 → COM；L 掷 → rL(10 Ω)；R 掷 → rR(100 Ω)，两侧各自回到电源负端 */
const SW_SCENE = (pos) => ({
  entities: [
    { type: 'battery', x: 0, y: 0, props: { emf: 6, internalR: 0.5 } },   // 0
    { type: 'spdt', x: 0, y: 0, props: { pos, ron: 0.05 } },              // 1
    { type: 'resistor', x: 0, y: 0, props: { resistance: 10 } },          // 2  rL
    { type: 'resistor', x: 0, y: 0, props: { resistance: 100 } },         // 3  rR
  ],
  wires: [
    [0, 0, 1, 0],   // 电池+ → COM
    [1, 1, 2, 0],   // L 掷 → rL
    [2, 1, 0, 1],   // rL → 电池−
    [1, 2, 3, 0],   // R 掷 → rR
    [3, 1, 0, 1],   // rR → 电池−
  ],
});

/** 二极管或门：电源 6 V；两只 spdt 当 0/1 输入开关（L=低、R=高）；两只单向元件做"或"；下拉 100 Ω 读输出 */
const OR_SCENE = (aPos, bPos, elemType, elemProps) => ({
  entities: [
    { type: 'battery', x: 0, y: 0, props: { emf: 6, internalR: 0.5 } },   // 0
    { type: 'spdt', x: 0, y: 0, props: { pos: aPos, ron: 0.05 } },        // 1  A 输入
    { type: 'spdt', x: 0, y: 0, props: { pos: bPos, ron: 0.05 } },        // 2  B 输入
    { type: elemType, x: 0, y: 0, props: elemProps },                     // 3  A 支路单向元件
    { type: elemType, x: 0, y: 0, props: elemProps },                     // 4  B 支路单向元件
    { type: 'resistor', x: 0, y: 0, props: { resistance: 100 } },         // 5  下拉 / 读数
  ],
  wires: [
    [0, 0, 1, 2],   // 电池+ → A.R（高电平）
    [0, 0, 2, 2],   // 电池+ → B.R
    [0, 1, 1, 1],   // 电池− → A.L（低电平）
    [0, 1, 2, 1],   // 电池− → B.L
    [0, 1, 5, 1],   // 电池− → 下拉下端（地）
    [1, 0, 3, 0],   // A.COM → 元件A 阳极
    [2, 0, 4, 0],   // B.COM → 元件B 阳极
    [3, 1, 5, 0],   // 元件A 阴极 → 输出节点
    [4, 1, 5, 0],   // 元件B 阴极 → 输出节点
  ],
});

/** LED 亮度阶梯：电源 2.0 V 固定，串不同阻值 ⇒ 四档正向电流 */
const LED_SCENE = (R, extra = {}) => ({
  entities: [
    { type: 'battery', x: 0, y: 0, props: { emf: 2, internalR: 0.5 } },   // 0
    { type: 'led', x: 0, y: 0, props: { color: 'red', ron: 0.5, roff: 1, ...extra } },  // 1
    { type: 'resistor', x: 0, y: 0, props: { resistance: R } },           // 2
  ],
  wires: [[0, 0, 1, 0], [1, 1, 2, 0], [2, 1, 0, 1]],
});
/** 同一场景、led 两端对调 ⇒ 真正反接（不靠负 emf） */
const LED_REV_SCENE = (R) => ({
  entities: [
    { type: 'battery', x: 0, y: 0, props: { emf: 2, internalR: 0.5 } },
    { type: 'led', x: 0, y: 0, props: { color: 'red', ron: 0.5, roff: 1 } },
    { type: 'resistor', x: 0, y: 0, props: { resistance: R } },
  ],
  wires: [[0, 0, 1, 1], [1, 0, 2, 0], [2, 1, 0, 1]],
});
/**
 * 电气等价、但**支路取向相反**的接法：两端对调 + dir=rev（面板上就是把"接法"选成反接）。
 * 同一只 led 正向导通、同样大小的正向电流，但支路上报的 I 符号相反 ⇒ 专门用来钉死
 * 「亮度只能由 |I| 决定」这条（忘记取绝对值必在其中一个接法上塌成"灭"）。
 */
const LED_SWAPPED_SCENE = (R) => ({
  entities: [
    { type: 'battery', x: 0, y: 0, props: { emf: 2, internalR: 0.5 } },
    { type: 'led', x: 0, y: 0, props: { color: 'red', ron: 0.5, roff: 1, dir: 'rev' } },
    { type: 'resistor', x: 0, y: 0, props: { resistance: R } },
  ],
  wires: [[0, 0, 1, 1], [1, 0, 2, 0], [2, 1, 0, 1]],
});

const LED_DRIVES = [
  { R: 100, want: 1, label: '微亮' },
  { R: 20, want: 2, label: '暗' },
  { R: 5, want: 3, label: '亮' },
  { R: 2, want: 4, label: '刺眼' },
];

// ══════════════════════════════════════════════════════════
// 判据主体
// ══════════════════════════════════════════════════════════
function judge(electronicsMod, opts = {}) {
  RESULTS = []; PASS = 0; FAIL = 0; QUIET = !!opts.quiet;
  const R = {};                       // 实测读数（进 JSON）
  const host = hostOf(electronicsMod);
  const reg = host.registry('equipment');
  const LE = electronicsMod;                 // ★ 纯函数检查也走**变异体自己的**导出（否则变异 ledTier 抓不到）
  const regMap = new Map(reg.list().map((d) => [d.type, d]));

  // ── §0 控制组：宿主与既有件不许被这次改动伤到 ────────────
  HEAD('§0 控制组：插件宿主 + 既有电学器材（任何变异体下都不得变红）');
  const elec = host.get('xiaomo.equipment.electronics');
  check('CTRL-PLUGINS', !!elec && elec.phase === 'active',
    `器材插件已装且 active：phase=${elec && elec.phase}`);
  const MINE14 = ['resistorcap', 'inductorcoil', 'acsource', 'oscilloscope', 'transformer', 'diode',
    'photoresistor', 'photodiode', 'npn', 'pnp', 'nmos', 'pmos', 'spdt', 'led'];
  const missMine = MINE14.filter((t) => !regMap.has(t));
  check('CTRL-EQUIP-14', missMine.length === 0,
    `electronics.js 的 14 件全部在注册表里（缺 ${missMine.length ? missMine.join('/') : '无'}）`
    + ` —— 与 electrical.js 的 10 件合计 ${reg.list().length} 件`);
  const EXIST = ['battery', 'switch', 'lamp', 'resistor', 'rheostat', 'ammeter', 'voltmeter',
    'thermistor', 'heater', 'motor'];
  const miss = EXIST.filter((t) => !regMap.has(t));
  check('CTRL-EXISTING-REG', miss.length === 0,
    `既有 electrical.js 的 10 件仍在注册表里（缺 ${miss.length ? miss.join('/') : '无'}）`);
  {
    // 对照件：既有 diode 在同一拓扑里必须仍然单向导电（正向通、反向断）
    const fwd = settle(LED_SCENE(10, { color: 'red' }), 40);   // 借用同一拓扑
    const d = settle({
      entities: [
        { type: 'battery', x: 0, y: 0, props: { emf: 2, internalR: 0.5 } },
        { type: 'diode', x: 0, y: 0, props: { vf: 1.8, ron: 0.5, roff: 1, dir: 'fwd' } },
        { type: 'resistor', x: 0, y: 0, props: { resistance: 10 } },
      ],
      wires: [[0, 0, 1, 0], [1, 1, 2, 0], [2, 1, 0, 1]],
    }, 40);
    const dd = d.S.get(1);
    const dRev = settle({
      entities: [
        { type: 'battery', x: 0, y: 0, props: { emf: 2, internalR: 0.5 } },
        { type: 'diode', x: 0, y: 0, props: { vf: 1.8, ron: 0.5, roff: 1, dir: 'fwd' } },
        { type: 'resistor', x: 0, y: 0, props: { resistance: 10 } },
      ],
      wires: [[0, 0, 1, 1], [1, 0, 2, 0], [2, 1, 0, 1]],
    }, 40);
    check('CTRL-DIODE-INTACT',
      dd.state.on === true && Math.abs(dd.state.I) > 1e-3
      && dRev.S.get(1).state.on === false && Math.abs(dRev.S.get(1).state.I) < 1e-5,
      `既有 diode 未被这次改动伤到：正向 on=${dd.state.on}、I=${fmt(dd.state.I)} A；`
      + `反向 on=${dRev.S.get(1).state.on}、I=${fmt(dRev.S.get(1).state.I)} A`);
    R.ctrlLedCurrent = fwd.S.get(1).state.ifwd;
  }

  // ── §1 形状：两件器材的定义自洽 ─────────────────────────
  HEAD('§1 定义形状：端口自报、字段自洽、defaults 每项可调');
  const spdtDef = regMap.get('spdt'), ledDef = regMap.get('led');
  check('SPDT-SHAPE-PORTS',
    !!spdtDef && spdtDef.ports.length === 3
    && spdtDef.ports.every((p) => p.kind === 'wire')
    && spdtDef.ports[0].label === 'COM' && spdtDef.ports[1].label === 'L' && spdtDef.ports[2].label === 'R',
    `spdt 三个 wire 端口自报：${spdtDef && spdtDef.ports.map((p) => p.label).join(' / ')}（0 公共 / 1 左 / 2 右）`);
  check('LED-SHAPE-PORTS',
    !!ledDef && ledDef.ports.length === 2 && ledDef.ports.every((p) => p.kind === 'wire')
    && ledDef.ports[0].label === 'A' && ledDef.ports[1].label === 'K',
    `led 两个 wire 端口自报 A/K：${ledDef && ledDef.ports.map((p) => p.label).join(' / ')}`);
  const shapesOk = (d) => !!d
    && d.fields.every((f) => f.k && f.label && f.type
      && (f.type !== 'range' || (isFinite(f.min) && isFinite(f.max) && isFinite(f.step)))
      && (f.type !== 'select' || (Array.isArray(f.options) && f.options.length >= 2)))
    && Object.keys(d.defaults).every((k) => d.fields.some((f) => f.k === k));
  check('SPDT-SHAPE-FIELDS', shapesOk(spdtDef),
    `spdt ${spdtDef && spdtDef.fields.length} 个字段自洽、defaults ${JSON.stringify(spdtDef && spdtDef.defaults)} 每项都有字段`);
  check('LED-SHAPE-FIELDS', shapesOk(ledDef),
    `led ${ledDef && ledDef.fields.length} 个字段自洽、defaults ${JSON.stringify(ledDef && ledDef.defaults)} 每项都有字段`);
  check('LED-SHAPE-TIERS', LE.LED_LEVELS.length >= 3 && LE.LED_COLORS.length >= 2,
    `led 亮度档 ${LE.LED_LEVELS.length} 档（≥3）、发光色 ${LE.LED_COLORS.length} 种`);

  // ── §2 spdt 支路契约 ────────────────────────────────────
  HEAD('§2 spdt 每帧两条支路：选中路放第 0 条、未选中路是 {type:open}（真开路且不告警）');
  const swarm = settle(SW_SCENE('L'), 40);
  const sw = swarm.S.get(1);
  const brs = sw.circuitBranches();
  const b0 = brs && brs[0], b1 = brs && brs[1];
  check('SPDT-2BRANCH',
    Array.isArray(brs) && brs.length === 2
    && !!b0 && !!b1 && b0.b === 1 && b1.b === 2 && b1.type === 'open',
    `circuitBranches() 返回 ${Array.isArray(brs) ? brs.length : '非数组'} 条：#0 ${b0 ? 'COM↔' + (b0.b === 1 ? 'L' : b0.b === 2 ? 'R' : b0.b) + '(' + b0.type + ')' : '缺失'}、`
    + `#1 ${b1 ? 'COM↔' + (b1.b === 1 ? 'L' : b1.b === 2 ? 'R' : b1.b) + '(' + b1.type + ')' : '缺失'}`);
  const w = warnOf(swarm.c, sw);
  R.swWarn = w.map((x) => x.code + (x.ports ? ':' + x.ports.join('/') : '') + '|' + String(x.msg || '').slice(0, 60));
  // ★ 把「本探针对 circuit.js:111-147 的模型」与「求解器实际行为」摆在一起：
  //   used 只该由**合法支路的端口对**填出来（:130），orphan 判据是 wired && !used（:138）。
  //   这两行如果被谁改了，orEmpty 与真实告警会**当场分叉** —— 这正是本仓说的"读数与算法互钉"。
  const usedPred = new Set();
  for (const b of (brs || [])) {
    if (Number.isInteger(b && b.a)) usedPred.add(b.a);
    if (Number.isInteger(b && b.b)) usedPred.add(b.b);
  }
  const wiredPorts = [0, 1, 2].filter((i) => swarm.S.world.wires.some((x) => x.kind === 'wire'
    && ((x.a.e === sw.id && x.a.p === i) || (x.b.e === sw.id && x.b.p === i))));
  const orphanPred = wiredPorts.filter((i) => !usedPred.has(i));
  R.swDiag = {
    brs: (brs || []).map((b) => [b && b.type, b && b.a, b && b.b]),
    branchKeys: [...((swarm.c && swarm.c.branches) || new Map()).keys()],
    wiredPorts, usedPred: [...usedPred], orphanPred, warnedCodes: w.map((x) => x.code),
  };
  check('SPDT-NOWARN', w.length === 0 && orphanPred.length === 0,
    `三个接线柱全接线时**零**告警（port-ignored 命中 ${w.length} 条${w.length ? '：' + w[0].msg : ''}）`
    + ' —— 未选中路以 {a:0,b:N} 出现在支路里，就进了 circuit.js:130 的 used');
  const r1 = recNth(swarm.c, sw, 1);
  check('SPDT-OPENREC',
    !!r1 && r1.I === 0 && r1.R === Infinity && r1.P === 0,
    `未选中路的记录：I=${r1 && r1.I}、R=${r1 && (r1.R === Infinity ? 'Infinity' : r1.R)}、P=${r1 && r1.P}`
    + '（circuit.js:310-311 原文口径）');
  R.openBranch = r1 ? { I: r1.I, R: r1.R === Infinity ? 'Infinity' : r1.R, U: r1.U } : null;

  // ── §3 两侧都读到 + 等效电路不同 + 主边就是选中路 ────────
  HEAD('§3 换向：L / R 两个位置给出不同等效电路，且两侧都读到读数');
  const readSide = (pos) => {
    const g = settle(SW_SCENE(pos), 40);
    const [, s1, rL, rR] = g.S.ents;
    return { pos, c: g.c, sw: s1, rL, rR, IL: rL.state.I, IR: rR.state.I, Isw: s1.state.I, thru: s1.state.thru };
  };
  const L = readSide('L'), Rr = readSide('R');
  R.lr = { L: { rL: L.IL, rR: L.IR, sw: L.Isw, thru: L.thru }, R: { rL: Rr.IL, rR: Rr.IR, sw: Rr.Isw, thru: Rr.thru } };
  check('SPDT-THRU-REPORTED', L.thru === 'L' && Rr.thru === 'R',
    `步进后自报掷向：pos=L ⇒ thru=${L.thru}、pos=R ⇒ thru=${Rr.thru}（面板文字不会与电路不一致）`);
  check('SPDT-LR-BOTHREAD',
    Math.abs(L.IL) > 0.1 && Math.abs(L.IR) < 1e-7 && Math.abs(Rr.IR) > 0.05 && Math.abs(Rr.IL) < 1e-7,
    `两侧都读到且互不串扰：pos=L ⇒ |I(10Ω)|=${fmt(Math.abs(L.IL))} A、|I(100Ω)|=${fmt(Math.abs(L.IR))} A；`
    + `pos=R ⇒ |I(100Ω)|=${fmt(Math.abs(Rr.IR))} A、|I(10Ω)|=${fmt(Math.abs(Rr.IL))} A`);
  check('SPDT-LR-DIFFER',
    Math.abs(Math.abs(L.IL) - Math.abs(Rr.IR)) > 0.1,
    `两个位置的等效电路**不同**：同一只开关换向把回路总阻从 10 Ω 换成 100 Ω ⇒ `
    + `电流 ${fmt(Math.abs(L.IL))} A ↔ ${fmt(Math.abs(Rr.IR))} A`);
  const swRecL = recOf(L.c, L.sw);
  // ⚠ 用 near 不用 ===：两条支路各自是 MNA 的**独立未知量**，KCL 只在迭代残差内成立。
  //   容差口径来自求解器的收敛判据本身：circuit.js:286/:289 判的是**节点电压**
  //   `maxDelta = max|u − prevU| < 1e-5`，不是支路电流 ⇒ 电流残差 ≈ 1e-5 × 支路电导量级。
  //   实测同回路上「开关支路 I」与「负载支路 I」相差 ~3e-14 A（相对 5e-14）。
  //   按 `===` 比会把一个物理上完全正确的解判红 —— 这是"断言要比被测对象松一档"，
  //   不是把实现放宽，1e-9 相对实测残差仍有 5 个数量级富余。
  R.branch0 = {
    swI: swRecL && swRecL.I, loadI: L.IL, absDiff: Math.abs(((swRecL && swRecL.I) || 0) - L.IL),
    swR: swRecL && swRecL.R, tol: 1e-9,
  };
  check('SPDT-BRANCH0',
    !!swRecL && near(swRecL.I, L.IL, 1e-9) && swRecL.R < 1 && recOf(Rr.c, Rr.sw).R < 1,
    `实体级 state/branches 取自**第 0 条（选中路）**：pos=L 时记录 I=${fmt(swRecL && swRecL.I)} A `
    + `== rL 的 I=${fmt(L.IL)} A（实测差 ${R.branch0.absDiff.toExponential(2)} A，容差 1e-9）`
    + `、R=${fmt(swRecL && swRecL.R, 3)} Ω（若把 open 放第 0 条，这里会是 0）`);
  check('SPDT-STATE-IS-SELECTED',
    near(L.sw.state.I, L.IL, 1e-9) && near(Rr.sw.state.I, Rr.IR, 1e-9),
    `实体级 state.I 逐位等于选中负载的电流：pos=L ${fmt(L.sw.state.I)} == ${fmt(L.IL)}；`
    + `pos=R ${fmt(Rr.sw.state.I)} == ${fmt(Rr.IR)}`);

  // ── §4 led 单向导电 + 亮度分档 ──────────────────────────
  HEAD('§4 led 亮度分档：纯函数单调性 + 端到端四档（正向电流越大越亮）');
  {
    const scan = [];
    for (const c of [0, -1, NaN, Infinity, 1e-9, 4e-4, 5e-4, 4.9e-3, 5e-3, 1.9e-2, 2e-2, 4.9e-2, 5e-2, 1e3]) {
      scan.push({ c: Number.isFinite(c) ? c : String(c), t: LE.ledTier(c) });
    }
    let mono = true, prev = -1;
    for (const c of [0, 4e-4, 5e-4, 4.9e-3, 5e-3, 1.9e-2, 2e-2, 4.9e-2, 5e-2, 1, 1e6]) {
      const t = LE.ledTier(c);
      if (t < prev) mono = false;
      prev = t;
    }
    const bounds = LE.ledTier(5e-4) === 1 && LE.ledTier(5e-3) === 2 && LE.ledTier(2e-2) === 3 && LE.ledTier(5e-2) === 4;
    const edges = LE.ledTier(4.999e-4) === 0 && LE.ledTier(0) === 0 && LE.ledTier(-1) === 0
      && LE.ledTier(NaN) === 0 && LE.ledTier(Infinity) === 0;
    R.tierScan = scan;
    check('LED-TIER-PURE', mono && bounds && edges,
      `ledTier() 沿电流轴单调不减 ${mono}、四个阈值边界精确 ${bounds}、`
      + `0/负/NaN/Infinity 全判"灭" ${edges}（非有限值不许让面板出现 NaN）`);
  }
  {
    const rows = [];
    for (const d of LED_DRIVES) {
      const g = settle(LED_SCENE(d.R), 60);
      const led = g.S.get(1), res = g.S.get(2);
      rows.push({ R: d.R, want: d.want, label: d.label, on: led.state.on, tier: led.state.tier,
        level: led.state.level, ifwd: led.state.ifwd, iRaw: led.state.I, iRes: res.state.I,
        U: led.state.U, vf: led.state.vf });
    }
    R.ledDrives = rows.map((r) => ({ R: r.R, on: r.on, tier: r.tier, level: r.level, ifwd: r.ifwd, iRaw: r.iRaw, iRes: r.iRes }));
    const strictlyUp = rows.every((r, i) => i === 0 || r.ifwd > rows[i - 1].ifwd);
    const tiersMatch = rows.every((r) => r.tier === r.want && r.level === r.label);
    // ⚠ 相对容差 1e-4，不是绝对 1e-12：容差口径来自求解器自己的收敛判据 ——
    //   circuit.js:286/:289 收敛判的是**节点电压** `maxDelta < 1e-5`（不是支路电流）。
    //   led 反向档的截止电阻是 1 MΩ ⇒ 节点电压残留 1e-5 V 经 1 MΩ 放大成 ~1e-11 A 的支路
    //   电流误差；落在 2 µA 那个小电流档上就是 ~5e-6 相对量级 —— 与实测 ~1e-6 同量级。
    //   也就是说 `1e-12 绝对` 在这条场景里**物理上不可能达到**：那是断言口径错，不是模型错。
    //   1e-4 相对实测残差仍有 ~100 倍富余，仍然能抓住"两处电流差一个量级"的真错。
    const relOf = (r) => Math.abs(Math.abs(r.iRes) - r.ifwd) / Math.max(1e-12, r.ifwd);
    const maxRel = Math.max(...rows.map(relOf));
    const crossCheck = maxRel <= 1e-4;
    check('LED-FWD-ON', rows.every((r) => r.on === true && r.tier >= 1),
      `正向驱动四档全部导通发光：on=${rows.map((r) => r.on).join('/')}、`
      + `亮度档=${rows.map((r) => r.tier).join('/')}`);
    check('LED-TIER-MONO', strictlyUp && tiersMatch,
      `正向电流严格递增（${rows.map((r) => (r.ifwd * 1000).toFixed(2) + 'mA').join(' < ')}）`
      + ` ⇒ 亮度档 ${rows.map((r) => r.tier).join('→')} 命中预期 ${rows.map((r) => r.want).join('→')}`
      + `（${rows.map((r) => r.level).join('/')}）`);
    check('LED-IFWD-CROSSCHECK', crossCheck,
      `led 自报正向电流与**串联电阻上的电流**逐档一致（|I_f| ↔ |I_R|，最大相对差 ${maxRel.toExponential(2)} ≤ 1e-4）：`
      + rows.map((r) => (r.ifwd * 1000).toFixed(3) + '↔' + (Math.abs(r.iRes) * 1000).toFixed(3) + 'mA').join('、'));
  }
  {
    const g = settle(LED_REV_SCENE(10), 40);
    const led = g.S.get(1), res = g.S.get(2);
    R.ledReverse = { on: led.state.on, I: led.state.I, ifwd: led.state.ifwd, tier: led.state.tier, U: led.state.U, iRes: res.state.I };
    check('LED-REV-BLOCK',
      led.state.on === false && Math.abs(led.state.ifwd) < 1e-5 && led.state.tier === 0
      && led.state.level === '灭' && led.state.on !== true,
      `两端对调（真反接，不靠负 emf）：on=${led.state.on}、|I_f|=${fmt(Math.abs(led.state.ifwd))} A `
      + `（< 1e-5，走 roff=1 MΩ 档）、亮度档=${led.state.tier}（灭）⇒ 反向阻断且不发光`);
  }
  {
    const g = settle(LED_SCENE(5), 60);
    const led = g.S.get(1), res = g.S.get(2);
    const before = { has: !!recOf(g.c, led), I: res.state.I, tier: led.state.tier };
    led.state.broken = true;                       // 「可停用」：走既有损坏/停用通道
    let c2 = null;
    for (let i = 0; i < 6; i++) c2 = g.S.tick(DT);
    const has2 = !!recOf(c2, led);
    const maxI = Number.isFinite(c2.maxI) ? c2.maxI : 0;
    R.ledBroken = { beforeHas: before.has, beforeI: before.I, beforeTier: before.tier, afterHas: has2, afterMaxI: maxI, ok: c2.ok };
    check('LED-BROKEN-OPEN',
      before.has === true && has2 === false && maxI < 1e-9,
      `可停用：停用前有支路记录（I=${fmt(before.I)} A）⇒ state.broken=true 后**整件从电路里消失**`
      + `（circuit.js:86 `+'`if (e.state && e.state.broken) continue;`'+`）⇒ 支路记录 ${has2}、回路 maxI=${fmt(maxI)} A`);
  }
  {
    // 取向无关：两种**电气等价、支路取向相反**的接法必须给出同一亮度档。
    // 这条自带非空前提（两种接法的 I 符号必须真的相反），否则它是一句空话。
    const f1 = settle(LED_SCENE(5), 60).S.get(1);
    const f2 = settle(LED_SWAPPED_SCENE(5), 60).S.get(1);
    const sameTier = f1.state.tier === f2.state.tier && f1.state.tier === 3;
    const opposite = f1.state.I * f2.state.I < 0;
    const sameMag = near(Math.abs(f1.state.I), Math.abs(f2.state.I), 1e-12);
    R.orient = {
      fwd: { I: f1.state.I, tier: f1.state.tier, on: f1.state.on },
      swapped: { I: f2.state.I, tier: f2.state.tier, on: f2.state.on },
      oppositeSign: opposite, sameMagnitude: sameMag,
    };
    check('LED-ORIENT-INVARIANT', sameTier && opposite && sameMag,
      `亮度与支路取向无关：接法 A 的 I=${fmt(f1.state.I)}（${f1.state.tier} 档）↔ 接法 B 的 `
      + `I=${fmt(f2.state.I)}（${f2.state.tier} 档），两者符号相反=${opposite}、幅值相同=${sameMag}`
      + ` ⇒ 亮度只能由 |I| 决定（非空前提：符号真的翻了）`);
  }

  // ── §5 二极管或门真值表 00/01/10/11 ─────────────────────
  HEAD('§5 端到端：用 spdt 造 0/1 输入 + 新 led 搭出「二极管或门」，四组真值表');
  const ROWS = [['L', 'L'], ['L', 'R'], ['R', 'L'], ['R', 'R']];
  const table = [];
  for (const [a, b] of ROWS) {
    const g = settle(OR_SCENE(a, b, 'led', { color: 'red', ron: 0.5, roff: 1, dir: 'fwd' }), 80);
    const [, sA, sB, dA, dB, rpd] = g.S.ents;
    table.push({
      in: [a === 'R' ? 1 : 0, b === 'R' ? 1 : 0], pos: [a, b],
      out: rpd.state.U, iOut: rpd.state.I,
      thru: [sA.state.thru, sB.state.thru],
      dA: { on: dA.state.on, I: dA.state.I }, dB: { on: dB.state.on, I: dB.state.I },
    });
  }
  R.orTable = table.map((r) => ({ in: r.in, out: r.out, thru: r.thru, dAon: r.dA.on, dBon: r.dB.on }));
  check('OR-INPUTS-APPLIED',
    table.every((r, i) => r.thru[0] === ROWS[i][0] && r.thru[1] === ROWS[i][1]),
    `四组输入的开关掷向都被真的应用了（没有被 setProp 悄悄夹掉）：${table.map((r) => r.thru.join('')).join(' / ')}`);
  const bits = table.map((r) => (r.out > 3 ? 1 : 0));
  check('OR-TABLE-SHAPE', bits.join('') === '0111',
    `或门布尔序列（输出 > 3 V 记 1）= ${bits.join('')}，期望 0111`);
  ROWS.forEach(([a, b], i) => {
    const r = table[i];
    const want = (a === 'R' || b === 'R') ? 1 : 0;
    check('OR-' + r.in.join(''), (r.out > 3 ? 1 : 0) === want,
      `输入 A=${r.in[0]} B=${r.in[1]} ⇒ 输出 ${fmt(r.out, 4)} V（${r.out > 3 ? '高' : '低'}，期望 ${want}）`
      + `；两只单向元件 on=${r.dA.on}/${r.dB.on}`);
  });
  check('OR-LOW-IS-REALLY-LOW', table[0].out < 0.5 && Math.abs(table[0].iOut) < 1e-6,
    `00 组是**真的低**、不是悬空：输出 ${fmt(table[0].out, 6)} V、下拉电流 ${fmt(table[0].iOut)} A`);

  // ── §6 与既有 diode 对照（不许只对自写期望自证） ────────
  HEAD('§6 对照既有器材：同一拓扑换用既有 diode，① 同 Vf 等价 ② 真值表逐组一致');
  const ledEq = settle(OR_SCENE('R', 'L', 'led', { color: 'red', vfTrim: 0, ron: 0.5, roff: 1, dir: 'fwd' }), 80);
  const dioEq = settle(OR_SCENE('R', 'L', 'diode', { vf: 1.8, ron: 0.5, roff: 1, dir: 'fwd' }), 80);
  const uLed = ledEq.S.get(5).state.U, uDio = dioEq.S.get(5).state.U;
  R.diodeEquivalence = { ledVf: ledEq.S.get(3).state.vf, dioVfProp: dioEq.S.get(3).props.vf, uLed, uDio };
  check('XCHK-DIODE-SAME-VF', near(uLed, uDio, 1e-9),
    `把 led 的 Vf 调到与既有 diode 相同（都 1.8 V、ron 都 0.5、roff 都 1 MΩ）⇒ 同一电路输出逐位相同：`
    + `led ${fmt(uLed, 12)} V ↔ diode ${fmt(uDio, 12)} V（差 ${fmt(Math.abs(uLed - uDio), 3)} V）`
    + ' —— 同源模型、不同件（并存不合并）');
  const dioTable = [];
  for (const [a, b] of ROWS) {
    const g = settle(OR_SCENE(a, b, 'diode', { vf: 1.8, ron: 0.5, roff: 1, dir: 'fwd' }), 80);
    dioTable.push(g.S.get(5).state.U > 3 ? 1 : 0);
  }
  R.diodeTable = dioTable;
  check('XCHK-DIODE-TRUTH', dioTable.join('') === bits.join('') && dioTable.join('') === '0111',
    `同一或门用既有 diode 再搭一遍：布尔序列 ${dioTable.join('')} == 新 led 的 ${bits.join('')}`
    + ' ⇒ 两套实现给同一条真值表（不是只对着自写期望自证）');

  return { pass: PASS, fail: FAIL, reds: reds(), ids: RESULTS.map((r) => r.id), readings: R, table };
}

// ══════════════════════════════════════════════════════════
// 绿档
// ══════════════════════════════════════════════════════════
if (!MUTATE) {
  console.log('\x1b[1m新增器材探针：单刀双掷开关 spdt + 发光二极管 led\x1b[0m');
  const r = judge(E);
  const items = r.pass + r.fail;
  console.log('\n\x1b[1mSPDT_LED_JSON\x1b[0m '
    + JSON.stringify({ mode: 'green', items, pass: r.pass, fail: r.fail, reds: r.reds,
      table: r.table.map((t) => ({ in: t.in, out: +t.out.toFixed(6), thru: t.thru, dAon: t.dA.on, dBon: t.dB.on })),
      readings: r.readings }));
  process.exitCode = r.fail ? 1 : 0;
}

// ══════════════════════════════════════════════════════════
// 红档：变异体落在 %TEMP%，仓库零字节副作用
// ══════════════════════════════════════════════════════════
if (MUTATE) {
  const out = { mode: 'mutate', repoUntouched: null, baseline: null, mutants: [], ctrlBad: 0 };
  try {
    const srcRaw = readFileSync(SRC_ABS);
    const shaBefore = createHash('sha256').update(srcRaw).digest('hex');
    const SRC = srcRaw.toString('utf8').split('\r\n').join('\n');   // 归一成 LF 再匹配锚

    const OPEN_LINE = "      { type: 'open', a: 0, b: this.other() },";
    const SEL_LINE = "      { type: 'R', r: Math.max(1e-4, this.props.ron), a: 0, b: this.sel() },";
    const IB_LINE = "const Ib = Math.abs(this.state.I || 0);";
    const THRU_LINE = "    this.state.thru = this.props.pos === 'R' ? 'R' : 'L';";
    const TIER_LINE = "  for (let i = 0; i < LED_LEVELS.length; i++) if (absI >= LED_LEVELS[i].min) t = i + 1;";
    const ROFF_LINE = "      : { type: 'R', r: Math.max(1, this.props.roff * 1e6) };";
    const VF_LINE = "  vf() { return Math.max(0, ledColor(this.props.color).vf + (this.props.vfTrim || 0)); }";
    // ⚠ `: { type: 'R', r: Math.max(1, this.props.roff * 1e6) };` 这一行在整份文件里出现 **3 次**
    //   （别的器材也这么写截止态）—— 实测 anchorHits=3 ⇒ 框架拒绝落地（landInCode=false）。
    //   这正是"锚必须逐字唯一"的规矩：宁可让变异体落不下去（响），也不许改错地方（静默）。
    //   修法不是放宽 hits 检查，而是把锚加长到**唯一**：从前一行的 `emf: s * this.vf()`
    //   （led 独有的 vf() 方法调用）一路切到截止行尾。
    const vfMark = SRC.indexOf('emf: s * this.vf()');
    const offAt = vfMark < 0 ? -1 : SRC.indexOf(ROFF_LINE, vfMark);
    const ROFF_ANCHOR = (vfMark < 0 || offAt < 0) ? null : SRC.slice(vfMark, offAt + ROFF_LINE.length);
    const ROFF_REPL = ROFF_ANCHOR ? ROFF_ANCHOR.replace('this.props.roff * 1e6', 'this.props.roff') : null;

    // M2 要**交换两条支路的顺序**（把 open 挪到第 0 条）⇒ 锚必须跨两行。
    // 两行之间的对齐空格是排版细节、不该由我手抄 ⇒ 从源文件**切片**取锚，天然逐字节一致。
    const aStart = SRC.indexOf("    return [\n      { type: 'R', r: Math.max(1e-4");
    const aEnd = aStart < 0 ? -1 : SRC.indexOf('\n    ];', aStart);
    const SWAP_ANCHOR = (aStart >= 0 && aEnd > aStart) ? SRC.slice(aStart, aEnd + '\n    ];'.length) : null;
    const swapLn = SWAP_ANCHOR ? SWAP_ANCHOR.split('\n') : [];
    const SWAP_REPL = swapLn.length === 4
      ? [swapLn[0], swapLn[2], swapLn[1], swapLn[3]].join('\n')      // 交换选中路与 open 路
      : null;

    const MUTANTS = [
      {
        id: 'M1', why: '未选中那一路返回 R（1 MΩ）而不是 open —— 注释里点名禁掉的「假开路」',
        anchor: OPEN_LINE, repl: "      { type: 'R', r: 1e6, a: 0, b: this.other() },",
        expect: ['SPDT-2BRANCH', 'SPDT-OPENREC', 'SPDT-LR-BOTHREAD'],
      },
      {
        id: 'M2', why: '选中那一路**没放第 0 条**（把 open 挪到 bi===0，实体级 state 就被 open 独占）',
        anchor: SWAP_ANCHOR, repl: SWAP_REPL,
        expect: ['SPDT-2BRANCH', 'SPDT-OPENREC', 'SPDT-BRANCH0', 'SPDT-STATE-IS-SELECTED'],
      },
      {
        id: 'M3', why: 'led 亮度吃带符号的 I（忘记取绝对值）—— 取向一变就塌成"灭"',
        anchor: IB_LINE, repl: 'const Ib = (this.state.I || 0);',
        // 实测：真接法下 V 支路报的 I 是**负的**（-0.00198 A…），反取向接法报正的 ⇒
        // 忘记 abs 会连锁红四条：导通判定、四档单调、自报电流、取向无关。
        expect: ['LED-FWD-ON', 'LED-TIER-MONO', 'LED-IFWD-CROSSCHECK', 'LED-ORIENT-INVARIANT'],
      },
      {
        id: 'M4', why: '刀接到**错的那个掷**（第 0 条接通的是未选中路，选中的那条反成 open）',
        anchor: SEL_LINE, repl: SEL_LINE.split('this.sel()').join('this.other()'),
        // 实测 brs=[["R",0,2],["open",0,2]] —— 第 1 条本来写的就是 this.other()，
        // 于是两条支路**同时**指向 2 号口、1 号口(L)被孤立（circuit.js:138 判 wired && !used）。
        // 后果分两簇：①换向语义整体反相（OR 门的 00 组读成高、11 组读成低 ⇒ 真值表 0111→1110，
        //   连带 XCHK-DIODE-TRUTH 与 OR-LOW-IS-REALLY-LOW）；②主记录落在错掷上 + L 口被忽略告警。
        expect: ['SPDT-2BRANCH', 'SPDT-NOWARN', 'SPDT-LR-BOTHREAD', 'SPDT-LR-DIFFER',
          'SPDT-BRANCH0', 'SPDT-STATE-IS-SELECTED',
          'OR-00', 'OR-11', 'OR-TABLE-SHAPE', 'OR-LOW-IS-REALLY-LOW', 'XCHK-DIODE-TRUTH'],
      },
      {
        id: 'M5', why: '**省掉**未选中那一路（只返回选中支路）—— 与 M1 的区别是：M1 假开路（不漏告警），M5 真缺失（必告警）',
        anchor: OPEN_LINE, repl: '      /* (M5) 未选中那一路被省掉了 */',
        expect: ['SPDT-2BRANCH', 'SPDT-OPENREC', 'SPDT-NOWARN'],
      },
      {
        id: 'M6', why: '自报的 `thru` 与真的通的那一路**脱钩**（面板写"通 L"、电路其实通 R）',
        anchor: THRU_LINE, repl: THRU_LINE.split("=== 'R' ? 'R' : 'L'").join("=== 'R' ? 'L' : 'R'"),
        expect: ['SPDT-THRU-REPORTED', 'OR-INPUTS-APPLIED'],
      },
      {
        id: 'M7', why: 'ledTier 阈值写反（电流越大档越低）—— 注释里点名的"分档函数最经典的错法"',
        anchor: TIER_LINE, repl: '  for (let i = 0; i < LED_LEVELS.length; i++) if (absI >= LED_LEVELS[i].min) t = LED_LEVELS.length - i;',
        expect: ['LED-TIER-PURE', 'LED-TIER-MONO', 'LED-ORIENT-INVARIANT'],
      },
      {
        id: 'M8', why: 'led 截止态漏掉 ×1e6（roff 直接当欧姆用）⇒ 反接也照样导通',
        anchor: ROFF_ANCHOR, repl: ROFF_REPL,
        // 实测红一大片（9 条），原因是个真物理耦合，不是探针噪声：
        // roff 在这条 2 V/100 Ω 的支路上**同时**是「反接时的阻断阻抗」和「正接时的起飞条件」——
        // 判据是 `U·sgn > Vf`(1.8 V)，若 off 态只有 1 Ω，管子两端永远到不了 1.8 V ⇒ **永远起不来**，
        // 于是 LED-FWD-ON/TIER/ORIENT 全红、OR 门全 0、与 diode 的交叉对照也跟着分叉。
        expect: ['LED-FWD-ON', 'LED-TIER-MONO', 'LED-ORIENT-INVARIANT', 'LED-REV-BLOCK',
          'OR-01', 'OR-10', 'OR-TABLE-SHAPE', 'XCHK-DIODE-SAME-VF', 'XCHK-DIODE-TRUTH'],
      },
      {
        id: 'M9', why: 'led 的 Vf 没接色档（抄成二极管那种 0.7 V）—— 专门用来证明**交叉对照本身能红**',
        anchor: VF_LINE, repl: '  vf() { return 0.7; }',
        // 交叉对照如果永远不可能红，它就是装饰品。这条让 uLed≠uDio，并连锁把亮度档推高。
        expect: ['XCHK-DIODE-SAME-VF', 'LED-TIER-MONO', 'LED-ORIENT-INVARIANT'],
      },
    ];

    const dir = join(tmpdir(), 'spdt-led-mut-' + Date.now());
    mkdirSync(dir, { recursive: true });
    const baseDir = dirname(SRC_ABS);
    const rewrite = (text) => text.replace(/(\bfrom\s*|\bimport\s*)(['"])(\.{1,2}\/[^'"\n]+)\2/g,
      (m, kw, q, spec) => kw + q + pathToFileURL(resolve(baseDir, spec)).href + q);

    const base = judge(E, { quiet: true });
    out.baseline = { items: base.pass + base.fail, pass: base.pass, fail: base.fail, reds: base.reds };

    const wantRed = new Set();
    for (const m of MUTANTS) {
      const hits = m.anchor ? SRC.split(m.anchor).length - 1 : 0;
      const at = m.anchor ? SRC.indexOf(m.anchor) : -1;
      const line = at < 0 ? -1 : SRC.slice(0, at).split('\n').length;
      const mutated = (hits === 1 && m.repl) ? SRC.split(m.anchor).join(m.repl) : SRC;
      const file = join(dir, m.id + '-electronics.js');
      writeFileSync(file, rewrite(mutated), 'utf8');
      const onDisk = readFileSync(file, 'utf8');
      // landInCode（文本侧）：锚在源里恰好命中一次；盘上的变异体 == 预期拼接结果；
      // 且锚的原文在该处**已经不在**（防止"写了个一样的文件"这种假落地）
      const landInCode = hits === 1
        && onDisk === rewrite(mutated)
        && (onDisk.split(m.repl).length - 1) >= 1
        && (m.repl === m.anchor ? true : !onDisk.includes(m.anchor));
      const mod = await import(pathToFileURL(file).href);
      const got = judge(mod, { quiet: true });
      const observed = got.reds.slice().sort();
      const declared = m.expect.slice().sort();
      const ctrlRed = observed.filter((id) => id.startsWith('CTRL-'));
      declared.forEach((id) => wantRed.add(id));
      out.mutants.push({
        id: m.id, why: m.why, anchorLine: line, anchorHits: hits, landInCode,
        declaredReds: declared, observedReds: observed,
        redsAligned: declared.join(',') === observed.join(','),
        ctrlRed, pass: got.pass, fail: got.fail,
        swWarn: got.readings.swWarn,                     // 变异体下 spdt 的告警原文（红档要能说清差在哪）
        swDiag: got.readings.swDiag,                     // 变异体下「模型预测 vs 实际」的分叉证据
      });
      out.ctrlBad += ctrlRed.length;
    }
    const actual = [...new Set(out.mutants.flatMap((m) => m.observedReds))].sort();
    const want = [...wantRed].sort();
    out.wantRed = want;
    out.actualReds = actual;
    out.aligned = want.join(',') === actual.join(',');
    // 诚实台账：哪些判据**没有任何变异体**能让它变红（= 它们的"能红"没有被证明过）。
    // 不判红 —— 但必须打印出来，免得下一个人以为整份探针都被红档覆盖了。
    out.allIds = base.ids || [];
    out.uncovered = out.allIds.filter((id) => !want.includes(id));
    // 归属写清楚，比硬凑一条红更对：这几类**本来就不该由本探针的变异体负责**。
    // ★ 把台账变成**被强制执行的契约**：白名单之外只要冒出一个 uncovered，就是"我漏造了变异体"，
    //   红档直接判红（strayUncovered 非空 ⇒ exit 1）。台账会随代码漂移，契约不会。
    const UNCOVERABLE = new Set([
      'CTRL-PLUGINS', 'CTRL-EQUIP-14', 'CTRL-EXISTING-REG', 'CTRL-DIODE-INTACT',
      'SPDT-SHAPE-PORTS', 'LED-SHAPE-PORTS', 'SPDT-SHAPE-FIELDS', 'LED-SHAPE-FIELDS', 'LED-SHAPE-TIERS',
      'LED-BROKEN-OPEN',
    ]);
    out.strayUncovered = out.uncovered.filter((id) => !UNCOVERABLE.has(id));
    out.uncoveredNote =
      '(a) 控制组/形状组 CTRL-* · *-SHAPE-*（9 条）：钉的是"宿主与注册表没被这次改动伤到"，'
      + '属于**不变量**；红线由 guard-plugins / instance-isolation-probe / equipment-electronics 负责。'
      + '(b) LED-BROKEN-OPEN（1 条）：跨文件契约（circuit.js:86 损坏器材整件跳过）——'
      + '变异它必须动 circuit.js，不在本任务写域；红线由 multibranch-probe / third-port-probe 负责。'
      + '(c) 白名单之外的任何 id 出现在 uncovered 里 = 我漏造了变异体 ⇒ strayUncovered 非空 ⇒ 红档判红。';
    out.repoUntouched = createHash('sha256').update(readFileSync(SRC_ABS)).digest('hex') === shaBefore;
    out.mutDir = dir;
  } catch (err) {
    out.error = String((err && err.stack) || err);
  }
  console.log('\x1b[1mSPDT_LED_JSON\x1b[0m ' + JSON.stringify(out));
  process.exitCode = (out.error || !out.aligned || out.ctrlBad > 0
    || !out.repoUntouched || out.baseline.fail > 0
    || (out.strayUncovered && out.strayUncovered.length > 0)) ? 1 : 0;
}
