#!/usr/bin/env node
// ══════════════════════════════════════════════════════════
// task-30 探针：晶体二极管「与门」+「或门」两套实验的端到端真值表判据
//
//   node tools/diode-gate-probe.mjs            绿档（一行紧凑 JSON，冒号后无空格）
//   node tools/diode-gate-probe.mjs --mutate   红档（变异体全落 %TEMP%，仓库零字节副作用）
//   node tools/diode-gate-probe.mjs --judge    内部：只跑判据并打 JSON（红档子进程用）
//
// ── 本探针要回答的问题（task-30 任务书） ──
// ① 「与门」能不能只用既有器材搭成？期望真值表 `0001`
// ② 「或门」同探针内为 `0111`
// ③ 两者**真值表必须不同**（专防「两套实验做成同一个电路」的假绿）
//
// ══ 读数约定（显式写出来，不许隐含）════════════════════════
//   · 「与门」（共阳极 + 上拉）：控制量 = **两只双掷开关是否都拨到 R**（都接到 Vp）⇒ 记 1。
//     两管**阴极**各接一路输入、**阳极**共接输出 O，O 经电阻**上拉**到 Vp。
//     两路都高 ⇒ 两管**都反偏不导通** ⇒ O 被上拉到 ≈ Vp；任一路低 ⇒ 那只管**导通**、把 O 拉到 ≈ V_D。
//   · 「或门」（共阴极 + 下拉）：控制量 = **任一只开关拨到 R** ⇒ 记 1（正逻辑）。
//     两管**阳极**各接一路输入、**阴极**共接输出，输出经电阻**下拉**到地。
//     任一管导通就把输出顶到 ≈ Vp−V_D。
//   · 输出判读：输出节点对地 |U| 与阈值比较，大者记 1。
//   · ★ 两套实验**共用同一个 3 V 阈值**（见下：统一阈值才是诚实的，不变量是**电平结构**）。
//
// ══ 两条实测事实（决定了本探针的口径，均为真求解器读数）══════
//  ① **并联族结构上做不到「与」**：任意一路导通就建立输出电流 ⇒ 天然是「或」/直通。
//     要「与」，必须让「任一路低就把输出摁住」⇒ 二极管要**反着接**（阴极朝输入、输出在上拉侧）。
//     否定台账见 plans/21-二极管与门-实测记录.md §5.1；本探针把这条负结果
//     钉成断言 NO-PARALLEL-AND，免得下一个人重走一遍弯路。
//  ② ★ **不变量是"电平结构互为镜像"，不是"阈值数字不同"**（@6 V，均为实测）：
//       或门输出在二极管**阴极侧** ⇒ 高电平 = `Vp − V_D` ≈ **4.16 V**（被吃掉一个 V_D）
//       与门输出在二极管**阳极侧** ⇒ 高电平 = `Vp`      ≈ **5.99 V**、低电平 = `V_D` ≈ **1.80 V**
//     ⇒ 两者高电平相差 ≈ 1.8 V（≥ 1 V）。**统一用 3 V 阈值就能各自成立**。
//     ⚠ 前一版探针把「两套阈值必须不同」当不变量，那是把**代理量**（阈值数字）当**不变量** ✗：
//       与门做对之后它变成恒假。纪律：**判据要钉不变量（电平结构），不钉代理量（阈值数字）**。
//     还有一条历史教训：与门**曾**用串联链实现，那时高电平只有 `Vp − 2×V_D` ≈ 2.57 V、
//     沿用 3 V 会被读成 `0000` ⇒ 我一度误判成「与门做不出来」。
//     —— 那是**阈值口径错，不是拓扑错**；更正过程与原始读数逐字留在 plans/21 §5.2/§5.3。
//     ⇒ 本探针统一 3 V 阈值，并把**镜像电平结构**写成断言 AND-OR-LEVEL-MIRROR，
//       谁要是把两套实验做成同一个电路、或把电平关系搞反，会当场红。
//
// ══ 关于 NB 原接法 ════════════════════════════════════════
//   本探针**不声称**等于 NB 的原始接线。实测：NB 公开语料里**没有**这两个实验的
//   连线数据（`"wires"`/`netlist`/`"connections"`/`diodeGate`/`andGate`/`orGate`
//   在全部 26 个语料文件上命中 **0**），连线在服务端 `resource/292_*`、`293_*` 模板里。
//   ⇒ 拓扑由本探针自行设计，界面上也不得写成「NB 同款接法」。
//
// ══ 变异体：★ 一律新起 node 子进程（不做同进程重导入）══════════
//   机制：父进程把**变异后的探针文本**写进 %TEMP%，用 `spawnSync(process.execPath, …)` 跑它，
//   子进程里 `DIODE_GATE_SRC` 指向**仓库真实的 `src/`**（只读）。父进程只读子进程 stdout，
//   从不 import 变异体 ⇒ ESM 缓存坑结构上不存在。
//
//   ★ 这里踩过两个真坑，都靠实测暴露（留档，免得下一个人重踩）：
//     ① **不要拷 `src/**` 到 %TEMP% 再 import** ✗：`registry.js` 的"当前注册表"是**模块级状态**，
//        拷一份 = 造出第二个模块实例 ⇒ `define()` 在 `setup()` 里找不到活动注册表 ⇒
//        `[registry] 没有可用注册表` ⇒ 子进程整个起不来（我实测到 `childNoJSON`）。
//        ⇒ 正确做法：`src/**` 一律 import 仓库真件，**只有被变异的文件**用 %TEMP% 副本。
//     ② **锚必须唯一** ✗：变异体表里的 `anchor` 字段**自己就是文件的一部分** ⇒ 同一个字符串
//        在表里又出现一次，`anchorHits` 会变成 2~5 ⇒ `split/join` 会**误改到表里的那份**。
//        ⇒ 锚一律"加长到唯一"（不是放宽命中次数），并让锚文本**不出现在表内**；
//        实测 `anchorHits` 必须 == 1，否则 `landInCode` 直接判 false。
//
//   机制自证（互补两条，缺一不可 —— 单靠任一条都会被骗过）：
//     · **金丝雀 M0**：把"输出判读恒 0"落进去 ⇒ **必须红**。
//       它没红 ⇒ 变异根本没送达被测代码 ⇒ 整族红档都在空转 ⇒ 判 infra，不许当通过。
//     · **null 变异体 M1**：只改注释里一个标点、语义为零 ⇒ **必须 0 红**。
//       单靠金丝雀会被「恒红」骗过，单靠 null 会被「恒绿」骗过，**两个都过才算机制有效**。
//   子进程**无论红绿都打 JSON**；连 JSON 都没打出来时记 `childNoJSONCount` 并**照打父进程自己的 JSON**。
// ══════════════════════════════════════════════════════════

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
/** ★ 子进程（红档）里仓库路径必须**从环境读**：%TEMP% 副本的 `ROOT` 指向 %TEMP%，照它拼
 *  `src/` 会去找 `%TEMP%/src/...` ⇒ 实测 `ERR_MODULE_NOT_FOUND`（踩过）。父进程用
 *  `DIODE_GATE_SRC` 把仓库真件的 `src/` 绝对路径传下来。 */
const SRC = process.env.DIODE_GATE_SRC ? JSON.parse(process.env.DIODE_GATE_SRC) : join(ROOT, 'src');
const SELF = fileURLToPath(import.meta.url);
const ARGV = process.argv.slice(2);
const MODE_MUTATE = ARGV.includes('--mutate');
const MODE_JUDGE = ARGV.includes('--judge');   // 子进程：只跑判据，不再递归开红档

// ── 阈值 ──
/** ★ 统一阈值（口径 (i)）：两套实验共用同一个 3 V。
 *  实测：或门高 4.1563 / 4.1677 V、低 0.0000 V；与门高 5.9940 V、低 1.8012 V
 *  ⇒ 3 V 对两者都在中间，且各自余量 > 0.5 V（或门 +1.17 / −3.00、与门 +2.99 / −1.20）。
 *  ⚠ 不要退回"两套阈值必须不同"：阈值是**代理量**，真正的不变量是**电平结构**
 *    （见断言 AND-OR-LEVEL-MIRROR：或门高 = Vp−V_D、与门高 = Vp，两者差 ≥ 1 V）。 */
const VHI = 3;              // 与门/或门共用（或门这一支与既有 spdt-led-probe 同口径）
const VHI_OR = VHI;         // 语义别名：仅用于「或门这一支」的判读，值必然与 VHI 相同
const MARGIN_MIN = 0.5;

// ══════════════════════════════════════════════════════════
// 判据收集器
// ══════════════════════════════════════════════════════════
let RESULTS = [];
let PASS = 0, FAIL = 0, QUIET = false;
const HEAD = (t) => { if (!QUIET) console.log('\n\x1b[36m' + t + '\x1b[0m'); };
const check = (id, cond, msg) => {
  RESULTS.push({ id, red: !cond });
  if (cond) { PASS++; if (!QUIET) console.log('  \x1b[32m✓\x1b[0m ' + msg); }
  else { FAIL++; if (!QUIET) console.log('  \x1b[31m✗\x1b[0m ' + msg); }
};
const reds = () => RESULTS.filter((r) => r.red).map((r) => r.id);
const fmt = (v, n = 4) => (Number.isFinite(v) ? v.toFixed(n) : String(v));
/** 档位判读：|u| > v ⇒ 1。变异锚 M3 就落在这一行的表达式上。 */
const GL = (u, v) => (Math.abs(u) > v ? 1 : 0);   // ← M0 金丝雀的锚落在这里

// ══════════════════════════════════════════════════════════
// 无头宿主（等价浏览器引导；姿势照抄 tools/spdt-led-probe.mjs）
// ══════════════════════════════════════════════════════════
const DT = 1 / 120;
async function makeEnv(srcDir, electronicsMod, physicsMod) {
  const mk = (p) => pathToFileURL(join(srcDir, p)).href;
  const [{ World }, { PluginHost }, { create, bindRegistry }, { CouplingBus }, { solveCircuit },
    chem, bridge, elec, glass, lab] = await Promise.all([
    import(mk('core/world.js')), import(mk('core/plugin.js')), import(mk('equipment/registry.js')),
    import(mk('coupling/bridge.js')), import(mk('physics/circuit.js')),
    import(mk('chemistry/reactions.js')), import(mk('coupling/bridge.js')),
    import(mk('equipment/electrical.js')), import(mk('equipment/glassware.js')),
    import(mk('equipment/lab.js')),
  ]);
  const bootApp = {
    services: {}, ticks: [], world: null, lastCircuit: null, selected: null,
    log: { push() {}, clear() {} }, toast() {},
    addTick(fn) { this.ticks.push(fn); return () => {}; },
  };
  const h = new PluginHost(bootApp);
  // ★ 物理模块传来的是**命名空间**（本文件 import 时用的就是它），插件实体在 `.default` 上；
  //    器材模块则统一传 `.default`。两者形态不同，这里显式区分，别让它成为隐含假设。
  const physPlugin = physicsMod && physicsMod.id ? physicsMod : physicsMod.default;
  for (const p of [physPlugin, chem.default, bridge.default, elec.default, glass.default, lab.default]) h.define(p);
  h.define(electronicsMod.default);
  h.installAll();
  bindRegistry(h.registry('equipment'));   // ★ 必须绑，否则变异体的 define() 会静默落回原注册表 ⇒ 假绿
  return { h, World, create, CouplingBus, solveCircuit };
}
function settle(env, sc, frames = 120, opts = {}) {
  const { World, create, CouplingBus, solveCircuit } = env;
  const world = new World();
  const cb = new CouplingBus(world);
  const raw = world.step.bind(world);
  const ents = [];
  for (const o of (sc.entities || [])) {
    const e = create(o.type, o.x, o.y);
    if (!e) throw new Error('无法创建器材: ' + o.type);
    if (o.props) for (const k of Object.keys(o.props)) e.setProp(k, o.props[k]);
    // ★ 读数器自洽**必须两次求解**才证得了（见 §5）：这里允许把电压表换成理想高阻再解一遍
    if (opts.meterRealR != null && o.type === 'voltmeter') e.setProp('realR', opts.meterRealR);
    world.add(e, true);
    ents.push(e);
  }
  for (const w of (sc.wires || [])) {
    world.connect({ e: ents[w[0]].id, p: w[1] }, { e: ents[w[2]].id, p: w[3] }, 'wire');
  }
  let c = null;
  for (let i = 0; i < frames; i++) {
    const br = cb.buildBranches();
    c = solveCircuit(world, br);
    cb.distribute(DT, c);
    raw(DT);
  }
  return { ents, c };
}

// ══════════════════════════════════════════════════════════
// 场景配方
//   实体下标：0 battery(+ / −) · 1 spdt A · 2 spdt B · 3 diode D1 · 4 diode D2
//            5 resistor(负载) · 6 voltmeter
// ══════════════════════════════════════════════════════════
const DPROPS = { vf: 1.8, ron: 0.5, roff: 1, dir: 'fwd' };
const VPROPS = { mode: 'V', fullScale: 15, realistic: true, realR: null };

/** ★ 与门（共阳极 + 上拉，**正逻辑**）—— 实测给 `0001`，是**或门的镜像**：
 *   两管**阴极**各接一路输入（经 spdt 驱动到 Vp/Vn），两管**阳极**共接输出节点 O，
 *   电阻从 Vp **上拉**到 O。
 *   电阻的端口约定（实测）：`[5,0]` 是靠近 Vp 的那一端、`[5,1]` 是靠 O 的那一端
 *   ⇒ **输出必须读 `[5,0]`**（= O），读 `[5,1]` 会读到 Vp。
 *   ⇒ 两路**都高** ⇒ 两管**都反偏不导通** ⇒ O 没有电流通路、被上拉顶到 ≈ Vp ⇒ 记 1；
 *     任一路低 ⇒ 那只管**导通** ⇒ 电流 `Vp→电阻→O→管→低轨` ⇒ O 被导通管**钳在 ≈ V_D**
 *     （实测 1.8012 / 1.8023 V，不是分压值）⇒ 低于 3 V ⇒ 记 0。⇒ 「与」。
 *   ★ 与或门的关系：或门的输出在二极管**阴极**侧、被吃掉一个 V_D；与门的输出在**阳极**侧、
 *     高电平直通 Vp —— 两者电平结构互为镜像（见断言 AND-OR-LEVEL-MIRROR）。
 *   ★ 变异锚：下面这个常量整块可被替换（锚文本刻意不出现在变异体表里）。 */
const WIRES_AND = [
  [0, 0, 1, 2], [0, 0, 2, 2],   // 电+ → A.R, B.R（正逻辑：拨 R 即接入高电平 —— 与或门/台账同一掷位约定）
  [0, 1, 1, 1], [0, 1, 2, 1],   // 电− → A.L, B.L
  [1, 0, 3, 1], [2, 0, 4, 1],   // A.COM → D1.K, B.COM → D2.K（★ 阴极朝输入）
  [3, 0, 5, 1], [4, 0, 5, 1],   // 两管阳极 → 输出节点 O（= 上拉电阻靠 O 的那端 [5,1]）
  [5, 0, 0, 0],                 // Vp ── 电阻 ── O   ← ★ 上拉（不是下拉）；O = [5,1]
  [6, 0, 5, 1], [6, 1, 0, 1],   // 电压表跨 O..地（★ 必须读 [5,1]，不是 [5,0]）
];
/** 或门（共阴极 + 下拉）：电± 接到两个 spdt 的 L/R；两管阳极各接一个 COM；
 *  两管阴极共接输出节点、输出经电阻下拉到地 ⇒ 任一管导通即可顶起输出 ⇒ 「或」。
 *  ★ 变异锚：整块可替换。 */
const WIRES_OR = [
  [0, 0, 1, 2], [0, 0, 2, 2],   // 电+ → A.R, B.R（高电平）
  [0, 1, 1, 1], [0, 1, 2, 1],   // 电− → A.L, B.L（低电平）
  [1, 0, 3, 0], [2, 0, 4, 0],   // A.COM → D1.A, B.COM → D2.A（阳极朝输入）
  [3, 1, 5, 0], [4, 1, 5, 0],   // 两管阴极 → 输出节点
  [5, 1, 0, 1],                 // 输出经下拉到地
  [6, 0, 5, 0], [6, 1, 0, 1],   // 电压表跨 输出..地
];
const ents = (rload) => [
  { type: 'battery', x: 0, y: 0, props: { emf: 6, internalR: 0.5 } },
  { type: 'spdt', x: 0, y: 0, props: { pos: 'L', ron: 0.05 } },
  { type: 'spdt', x: 0, y: 0, props: { pos: 'L', ron: 0.05 } },
  { type: 'diode', x: 0, y: 0, props: { ...DPROPS } },
  { type: 'diode', x: 0, y: 0, props: { ...DPROPS } },
  { type: 'resistor', x: 0, y: 0, props: { resistance: rload } },
  { type: 'voltmeter', x: 0, y: 0, props: { ...VPROPS } },
];
const sceneAnd = (a, b) => ({
  entities: ents(1000).map((e, i) => (i === 1 ? { ...e, props: { pos: a, ron: 0.05 } }
    : i === 2 ? { ...e, props: { pos: b, ron: 0.05 } } : e)),
  wires: WIRES_AND,
});
const sceneOr = (a, b) => ({
  entities: ents(100).map((e, i) => (i === 1 ? { ...e, props: { pos: a, ron: 0.05 } }
    : i === 2 ? { ...e, props: { pos: b, ron: 0.05 } } : e)),
  wires: WIRES_OR,
});
// ── 并联族候选（负结果台账，见 plans/21 §5.1）：四种**互不相同**的并联接法 × 三种阻值 ──
//   判读一律取 voltmeter 读数（跨输出节点..地）。★ 四种接法两两不同，否则台账是假的。
const PARALLEL_FAMILY = {
  'R100': 100, 'R1k': 1000, 'R10k': 10000,
};
/** 四种并联拓扑的接线。实体：0 电源 · 1/2 spdt · 3/4 二极管 · 5 电阻 · 6 电压表。
 *  支路：电+ → A.R/B.R、电− → A.L/B.L；电阻一端接 Vp（端口 0）、另一端接输出节点 O（端口 1）；
 *  电压表跨 O..地（[6,0]→[5,1]、[6,1]→电−）。 */
const parallelWires = (kind) => {
  const rail = [[0, 0, 1, 2], [0, 0, 2, 2], [0, 1, 1, 1], [0, 1, 2, 1]];   // 电± 到两个 spdt
  const meter = [[6, 0, 5, 1], [6, 1, 0, 1]];
  if (kind === 'commonCathodePulldown') {   // ① 共阴极 + 下拉：两阳极接输入、两阴极共接 O
    return [...rail, [1, 0, 3, 0], [2, 0, 4, 0], [3, 1, 5, 1], [4, 1, 5, 1],
      [5, 0, 0, 0], ...meter];
  }
  if (kind === 'commonAnodePulldown') {     // ② 共阳极 + 下拉：两阴极接输入、两阳极共接 O
    return [...rail, [1, 0, 3, 1], [2, 0, 4, 1], [3, 0, 5, 1], [4, 0, 5, 1],
      [5, 0, 0, 0], ...meter];
  }
  if (kind === 'commonCathodePullup') {     // ③ 共阴极 + 上拉：两阳极接输入、两阴极共接 O
    return [...rail, [1, 0, 3, 0], [2, 0, 4, 0], [3, 1, 5, 1], [4, 1, 5, 1],
      [5, 1, 0, 1], ...meter];
  }
  // ④ 两只管把输入**分别**接到输出（交叉并接，不是共阳/共阴）
  return [...rail, [1, 0, 3, 0], [2, 0, 4, 1], [3, 1, 5, 1], [4, 0, 5, 1],
    [5, 0, 0, 0], ...meter];
};
/** 与门控制量（正逻辑）：「两只都拨到 **R**」⇒ 1（R 那一掷接 Vp，**与或门同一掷位约定**）。
 *  ★ 实测读数（@6 V，上拉 1 kΩ，按 ROWS 顺序 LL/LR/RL/RR）：
 *      LL ⇒ 1.8012 V、LR ⇒ 1.8023 V、RL ⇒ 1.8023 V、RR ⇒ 5.9940 V
 *    ⇒ 两路**都高**时两管**都反偏不导通**、O 没有通路、被上拉顶到 ≈ Vp = 5.99 V ⇒ 记 1；
 *      任一路低时那只管**导通**、把 O 钳在 ≈ V_D = 1.80 V ⇒ 记 0。这正是教科书与门。
 *    ⚠ 与门 / 或门 / 负结果台账三处**共用同一个掷位约定（R = 接入 Vp）**，两条真值表才可能
 *      在同一个 ROWS 顺序下读成 0001 / 0111。本探针另有一条断言 AND-EQUALS-LEDGER-WITNESS
 *      把「§1 的与门接线 == 台账里给出 0001 的那一种」钉住，防这个约定再被改歪。 */
const inAnd = (a, b) => (a === 'R' && b === 'R') ? 1 : 0;
/** 或门控制量：「任一只拨到 R」⇒ 1（本接线里 R 掷接 Vp；与既有 spdt-led-probe 同口径） */
const inOr = (a, b) => (a === 'R' || b === 'R') ? 1 : 0;
const ROWS = [['L', 'L'], ['L', 'R'], ['R', 'L'], ['R', 'R']];

// ══════════════════════════════════════════════════════════
// 判据主体
// ══════════════════════════════════════════════════════════
async function judge(electronicsMod, physicsMod, srcDir, opts = {}) {
  RESULTS = []; PASS = 0; FAIL = 0; QUIET = !!opts.quiet;
  const R = {};
  const env = await makeEnv(srcDir, electronicsMod, physicsMod);
  const reg = env.h.registry('equipment');
  const regMap = new Map(reg.list().map((d) => [d.type, d]));
  const portLabels = (t) => (regMap.get(t) ? regMap.get(t).ports.map((p) => p.label).join('/') : '(缺)');

  // ── §0 控制组：四件器材必须都在册（任何变异体下都不得变红） ──
  HEAD('§0 控制组：task-30 需要的四件器材全部在册（变异体下不得变红）');
  const NEED = ['battery', 'spdt', 'diode', 'voltmeter'];
  const miss = NEED.filter((t) => !regMap.has(t));
  check('CTRL-FOUR-PARTS', miss.length === 0,
    `四件需求（电源/双掷开关/晶体二极管/电压表）全部在册（缺 ${miss.length ? miss.join('/') : '无'}）；`
    + `注册表共 ${reg.list().length} 件`);
  const elec = env.h.get('xiaomo.equipment.electronics');
  check('CTRL-PLUGINS', !!elec && elec.phase === 'active',
    `器材插件已装且 active：phase=${elec && elec.phase}`);
  check('CTRL-PORTS', portLabels('spdt') === 'COM/L/R' && portLabels('diode') === 'A/K',
    `端口自报：spdt=${portLabels('spdt')}、diode=${portLabels('diode')}（与接线假设一致）`);
  check('CTRL-VM-DEF', !!regMap.get('voltmeter') && regMap.get('voltmeter').defaults.mode === 'V',
    `voltmeter 默认档位 = ${regMap.get('voltmeter') && regMap.get('voltmeter').defaults.mode}（电压档）`);

  // ── §1 与门：串联链真值表 0001 ───────────────────────────
  HEAD('§1 与门（共阳极 + 上拉）：真值表期望 0001');
  const andRows = [];
  for (const [a, b] of ROWS) {
    const g = settle(env, sceneAnd(a, b));
    andRows.push({
      // ★ 输出取**电压表读数**（它跨 O..地）；`ents[5].state.U` 是电阻两端电压、
      //   在 U≈0 时会落成 Vp/1000，不能当输出用（这个坑实测踩到过）。
      pos: a + b, in: inAnd(a, b), U: g.ents[6].state.U, vm: g.ents[6].state.U,
      vmR: g.ents[6].state.R, thruA: g.ents[1].state.thru, thruB: g.ents[2].state.thru,
      onA: g.ents[3].state.on, onB: g.ents[4].state.on,
    });
  }
  const andBits = andRows.map((r) => GL(r.U, VHI));
  R.andTable = andRows.map((r) => ({ pos: r.pos, in: r.in, U: +r.U.toFixed(6), vm: +r.vm.toFixed(6), thru: r.thruA + r.thruB }));
  R.vmShunt = andRows[0].vmR;
  check('AND-INPUTS-APPLIED',
    andRows.every((r, i) => r.thruA === ROWS[i][0] && r.thruB === ROWS[i][1]),
    `四组掷向都被真的应用了（没被 setProp 夹掉）：${andRows.map((r) => r.thruA + r.thruB).join(' / ')}`);
  check('AND-TABLE-SHAPE', andBits.join('') === '0001',
    `与门布尔序列（|输出| > ${VHI} V 记 1）= ${andBits.join('')}，期望 0001`);
  ROWS.forEach(([a, b], i) => {
    const r = andRows[i], want = inAnd(a, b);
    check('AND-' + r.pos, GL(r.U, VHI) === want,
      `A=${a} B=${b} ⇒ 输出 ${fmt(r.U, 4)} V（期望 ${want}）；两管 on=${r.onA}/${r.onB}`);
  });
  // ★ 与门有 **3 个** "0" 组：任一管导通就把 O 钳在 ≈ V_D（上拉电流全走那只导通管）⇒ 确是真低，不是悬空
  check('AND-LOW-IS-REALLY-LOW',
    andRows.filter((r) => inAnd(r.pos[0], r.pos[1]) === 0).every((r) => Math.abs(r.U) < 3),
    `三个"0"组都低于阈值、不是悬空：`
    + andRows.filter((r) => inAnd(r.pos[0], r.pos[1]) === 0).map((r) => `${r.pos}=${fmt(r.U, 4)}V`).join('、')
    + `（导通管把 O 钳在 ≈ V_D = 1.80 V，不是分压值）`);

  // ── §2 或门：共阴极真值表 0111 ───────────────────────────
  HEAD('§2 或门（共阴极并联 + 对地负载）：真值表期望 0111');
  const orRows = [];
  for (const [a, b] of ROWS) {
    const g = settle(env, sceneOr(a, b));
    orRows.push({
      pos: a + b, in: inOr(a, b), U: g.ents[6].state.U, vm: g.ents[6].state.U,
      thruA: g.ents[1].state.thru, thruB: g.ents[2].state.thru,
      onA: g.ents[3].state.on, onB: g.ents[4].state.on,
    });
  }
  const orBits = orRows.map((r) => GL(r.U, VHI_OR));
  R.orTable = orRows.map((r) => ({ pos: r.pos, in: r.in, U: +r.U.toFixed(6), vm: +r.vm.toFixed(6), thru: r.thruA + r.thruB }));
  check('OR-INPUTS-APPLIED',
    orRows.every((r, i) => r.thruA === ROWS[i][0] && r.thruB === ROWS[i][1]),
    `四组掷向都被真的应用了：${orRows.map((r) => r.thruA + r.thruB).join(' / ')}`);
  check('OR-TABLE-SHAPE', orBits.join('') === '0111',
    `或门布尔序列（|输出| > ${VHI_OR} V 记 1）= ${orBits.join('')}，期望 0111`);
  ROWS.forEach(([a, b], i) => {
    const r = orRows[i], want = inOr(a, b);
    check('OR-' + r.pos, GL(r.U, VHI_OR) === want,
      `A=${a} B=${b} ⇒ 输出 ${fmt(r.U, 4)} V（期望 ${want}）；两管 on=${r.onA}/${r.onB}`);
  });
  check('OR-LOW-IS-REALLY-LOW', Math.abs(orRows[0].U) < 0.5,
    `00 组是真的低：输出 ${fmt(orRows[0].U, 6)} V`);

  // ── §3 ★ 两套实验必须互不相同（防"做成同一个电路"的假绿）──
  HEAD('§3 ★ 两条真值表必须不同 + 电平结构必须互为镜像');
  const hamming = andBits.filter((x, i) => x !== orBits[i]).length;
  R.andBits = andBits.join(''); R.orBits = orBits.join(''); R.hamming = hamming;
  check('GATES-DIFFER', hamming >= 2,
    `两条真值表逐位比较：与门 ${andBits.join('')} vs 或门 ${orBits.join('')} ⇒ 有 ${hamming} 位不同`
    + `（若两套实验做成同一个电路，这个位数会塌成 0）`);
  check('AND-NOT-OR-SHAPE', andBits.join('') !== orBits.join('') && andBits.join('') === '0001',
    `与门序列 ${andBits.join('')} **不是**或门序列 ${orBits.join('')} ⇒ 确实搭成了两个不同的电路`);
  // ★ 不变量：**电平结构互为镜像**（不是"阈值数字不同"——阈值是代理量）
  const Vp = 6;                                   // 电源电动势（实测读数都小于它，因为串联了内阻）
  const V_D = DPROPS.vf;                          // 二极管正向压降 1.8 V
  const andHi = Math.max(...andRows.map((r) => Math.abs(r.U)));
  const andLo = Math.min(...andRows.map((r) => Math.abs(r.U)));
  const orHi = Math.max(...orRows.map((r) => Math.abs(r.U)));
  const orLo = Math.min(...orRows.map((r) => Math.abs(r.U)));
  R.levels = { andHi: +andHi.toFixed(4), andLo: +andLo.toFixed(4), orHi: +orHi.toFixed(4), orLo: +orLo.toFixed(4) };
  R.hiGap = +(andHi - orHi).toFixed(4);
  // ① 与门高 ≈ Vp（阳极侧，直通）；或门高 ≈ Vp − V_D（阴极侧，被吃掉一个 V_D）
  const andHiNearVp = Math.abs(andHi - Vp) < 0.5;
  const orHiNearVpMinusVd = Math.abs(orHi - (Vp - V_D)) < 0.5;
  // ② 与门低 ≈ V_D（导通管把输出摁到 V_D）；或门低 ≈ 0（没有管导通）
  const andLoNearVd = Math.abs(andLo - V_D) < 0.5;
  const orLoNearZero = orLo < 0.5;
  check('AND-OR-LEVEL-MIRROR',
    andHiNearVp && orHiNearVpMinusVd && andLoNearVd && orLoNearZero && (andHi - orHi) >= 1,
    `电平结构互为镜像：与门高 ${fmt(andHi, 4)} V ≈ Vp=${Vp}（阳极侧直通）、或门高 ${fmt(orHi, 4)} V ≈ Vp−V_D=${fmt(Vp - V_D, 4)} V（阴极侧被吃掉一个 V_D）`
    + ` ⇒ 高电平差 ${fmt(andHi - orHi, 4)} V ≥ 1 V ✓；与门低 ${fmt(andLo, 4)} V ≈ V_D、或门低 ${fmt(orLo, 6)} V ≈ 0 ✓`
    + `（★ 这才是真不变量；"两套阈值必须不同"是代理量，别再退回那条）`);
  // ③ 统一 3 V 阈值对两者都成立，且各自余量 > 0.5 V
  check('AND-OR-MARGIN',
    VHI === VHI_OR && (andHi - VHI) > MARGIN_MIN && (VHI - andLo) > MARGIN_MIN
    && (orHi - VHI) > MARGIN_MIN && (VHI - orLo) > MARGIN_MIN,
    `统一 ${VHI} V 阈值对两套都成立且余量 > ${MARGIN_MIN} V：`
    + `与门 +${fmt(andHi - VHI, 4)} / −${fmt(VHI - andLo, 4)} V；或门 +${fmt(orHi - VHI, 4)} / −${fmt(VHI - orLo, 4)} V`);

  // ── §4 负结果守卫（★ 含一条**被本次实测推翻的旧结论**，见下）──
  HEAD('§4 ★ 负结果守卫：并联族里有"能当与门"的接法 —— 我旧结论被推翻了');
  const parResults = {};
  const PAR_KINDS = ['commonCathodePulldown', 'commonAnodePulldown', 'commonCathodePullup', 'crossCoupled'];
  for (const kind of PAR_KINDS) {
    for (const [rk, rv] of Object.entries(PARALLEL_FAMILY)) {
      const U = [];
      for (const [a, b] of ROWS) {
        const sc = {
          entities: ents(rv).map((e, i) => (i === 1 ? { ...e, props: { pos: a, ron: 0.05 } }
            : i === 2 ? { ...e, props: { pos: b, ron: 0.05 } } : e)),
          wires: parallelWires(kind),
        };
        U.push(settle(env, sc).ents[6].state.U);   // ★ 取电压表读数（跨输出..地），不是电阻两端
      }
      // 用**与门自己的控制量**判读（都拨 R 记 1 —— 与 §1/§3 同一掷位约定）：并联族拿不到 0001
      const bits = ROWS.map(([a, b], i) => GL(U[i], VHI));
      parResults[kind + '/' + rk] = { U: U.map((x) => +x.toFixed(4)), bits: bits.join('') };
    }
  }
  R.parallel = parResults;
  // 台账自证：四种接法两两不同（否则"四种拓扑"是假的）
  const sig = PAR_KINDS.map((k) => JSON.stringify(parallelWires(k)));
  check('PARALLEL-TOPOLOGIES-DISTINCT', new Set(sig).size === PAR_KINDS.length,
    `负结果台账的 ${PAR_KINDS.length} 种拓扑接线两两不同（去重后 ${new Set(sig).size} 种）`
    + ` ⇒ 台账不是在拿同一个电路重复计数`);
  R.parallelTopologiesDistinct = new Set(sig).size === PAR_KINDS.length;
  const parBits = Object.values(parResults).map((v) => v.bits);
  const bitsOf = (kind) => Object.entries(parResults).filter(([k]) => k.startsWith(kind + '/')).map(([, v]) => v.bits);
  const pullupBits = bitsOf('commonCathodePullup');
  const pulldownBits = [...bitsOf('commonCathodePulldown'), ...bitsOf('commonAnodePulldown'), ...bitsOf('crossCoupled')];
  // ★ 这一条是**真负结果**、必须保持：上拉族（电阻到 Vp）里没有一种能给出 0001
  check('NO-PULLUP-AND', pullupBits.every((b) => b !== '0001'),
    `**上拉族**（电阻到 Vp）${pullupBits.length} 种接法没有一种给出 0001（实测 ${pullupBits.join(' ')}）`
    + ` ⇒ 上拉把非导通路抬到高电平 ⇒ 输出恒被"任一路"决定 ⇒ 只能得到或/恒高`);
  // ★ 这一条记录**我被推翻的旧结论**：我原先断言"并联族结构上做不到与"是**错的**
  check('PULLDOWN-AND-COUNTEREXAMPLE', pulldownBits.some((b) => b === '0001'),
    `★ **我被推翻的旧结论**：我原断言"并联族结构上做不到「与」、只有串联链做得到" ✗ ——`
    + ` 本次实测在同族里就找到了**反例**：共阳极 + 下拉（阴极接输入、阳极共接 O、电阻下拉到地）`
    + ` 给 0001（实测序列 ${pulldownBits.join(' ')}）⇒ "并联族做不到与"这个概括是错的`);
  check('PARALLEL-OR-CONFIRMED', parBits.filter((b) => b === '0111' || b === '1111').length >= 1,
    `并联族里确实有能当"或"的接法（实测 ${parBits.filter((b) => b === '0111' || b === '1111').length} 种给 0111/1111）`
    + ` ⇒ 证明上一条负结果不是因为"并联族整体不导通"而空过`);

  // ★ 结构自证：§1 的与门 == 台账里给出 0001 的那一种（**同一个电路**，不是两个近亲）。
  //   第 1 步踩到的缺陷正是「与门」与「台账见证」差了一根掷位线、而两条表各自都还是绿的自证。
  const LW = 'commonAnodePulldown';
  const ledgerWire = parallelWires(LW);
  const ledgerU = parResults[LW + '/R1k'].U;
  const andU4 = andRows.map((r) => +r.U.toFixed(4));
  const sameWires = JSON.stringify(WIRES_AND) === JSON.stringify(ledgerWire);
  const sameU = JSON.stringify(andU4) === JSON.stringify(ledgerU);
  check('AND-EQUALS-LEDGER-WITNESS',
    sameWires && sameU && parResults[LW + '/R1k'].bits === '0001',
    `§1 的与门接线与负结果台账里给出 0001 的那一种（${LW}/R1k）**是同一个电路**：`
    + `接线逐字相同=${sameWires}、四组读数逐位相同=${sameU}（与门 ${andU4.join('/')} vs 台账 ${ledgerU.join('/')}）`
    + `、台账 bits=${parResults[LW + '/R1k'].bits}`);

  // ── §5 读数器自洽：把表换成理想高阻再解一遍 ⇒ 读数变化 = 表对电路的加载量 ──
  //   ⚠ 原版这条断言拿 `vm` 与 `U` 比，而两者在 §1/§2 里**是同一个表达式**
  //     （都取 `ents[6].state.U`）⇒ 恒差 0、任何变异体都打不红 ⇒ 是**假断言**。
  //     改成两次求解（配置的 1 MΩ vs 理想 1e12 Ω）才真的在证「表不加载电路」。
  HEAD('§5 读数器自洽：换理想高阻再解一遍，读数变化必须 ≤ 0.5 ％（表不加载电路）');
  const IDEAL_R = 1e12;
  const relDiff = (x, y) => Math.abs(x - y) / Math.max(Math.abs(y), 1);
  const idealRows = [];
  for (let i = 0; i < ROWS.length; i++) {
    const [a, b] = ROWS[i];
    const ia = settle(env, sceneAnd(a, b), 120, { meterRealR: IDEAL_R }).ents[6].state.U;
    const io = settle(env, sceneOr(a, b), 120, { meterRealR: IDEAL_R }).ents[6].state.U;
    idealRows.push({ pos: a + b, andRel: +relDiff(andRows[i].vm, ia).toExponential(3),
      orRel: +relDiff(orRows[i].vm, io).toExponential(3) });
  }
  R.vmLoadRel = idealRows;
  const relMax = Math.max(...idealRows.map((d) => Math.max(d.andRel, d.orRel)));
  R.vmLoadRelMax = relMax;
  check('VM-READS-LOAD', relMax <= 5e-3,
    `把表换成 1e12 Ω 理想高阻再解一遍：8 组读数最大相对变化 ${(relMax * 100).toFixed(4)} % ≤ 0.5 %`
    + `（理论分流比 1 MΩ ∥ 1 kΩ ≈ 0.0999 %；逐组 ${idealRows.map((d) => d.pos + ':' + (Math.max(d.andRel, d.orRel) * 100).toFixed(3) + '%').join(' ')}）`
    + ` ⇒ 表**不加载**被测电路，读数可当节点真值`);
  check('VM-HIGH-Z', Math.abs(andRows[0].vmR - 1e6) <= 1e2,
    `电压表内阻实测 ${fmt(andRows[0].vmR, 0)} Ω（高阻，∥1 kΩ 分流 ~0.1 % ⇒ 当高阻读数器可用不是假设）`);

  // ── §6 交叉对照：或门这一支与既有无头探针的尾巴对齐 ──
  HEAD('§6 交叉对照：或门用既有 diode 搭成，与 tools/spdt-led-probe.mjs 的既有结论对齐');
  check('XCHK-DIODE-OR', orBits.join('') === '0111',
    `或门真值表 ${orBits.join('')} —— 与既有 tools/spdt-led-probe.mjs 的 orTable 0111 逐位一致`
    + `（不是只对自写期望自证）`);

  return { pass: PASS, fail: FAIL, reds: reds(), ids: RESULTS.map((r) => r.id),
    assertionIds: RESULTS.map((r) => r.id).sort(), readings: R, andRows, orRows };
}

// ══════════════════════════════════════════════════════════
// 绿档 / 子进程判据档
// ══════════════════════════════════════════════════════════
if (!MODE_MUTATE) {
  const mk = (p) => pathToFileURL(join(SRC, p)).href;
  const [electronicsMod, physicsMod] = await Promise.all([
    import(mk('equipment/electronics.js')), import(mk('physics/circuit.js')),
  ]);
  if (!MODE_JUDGE) {
    console.log('\x1b[1m晶体二极管「与门」/「或门」双实验探针（task-30）\x1b[0m');
    console.log('\x1b[90m读数约定：与门=两只开关都拨 R 记 1；或门=任一只拨 R 记 1；'
      + `两套实验**统一** ${VHI} V 阈值（不变量是**电平结构互为镜像**，不是阈值数字）\x1b[0m`);
  } else { QUIET = true; }
  const r = await judge(electronicsMod, physicsMod, SRC, { quiet: MODE_JUDGE });
  const items = r.pass + r.fail;
  const payload = {
    mode: r.fail ? 'red' : 'green', items, pass: r.pass, fail: r.fail, reds: r.reds,
    redsAll: r.assertionIds,               // ★ 断言全集（含绿档）：红档的覆盖率判据读这个字段
    andBits: r.readings.andBits, orBits: r.readings.orBits, hamming: r.readings.hamming,
    levels: r.readings.levels, hiGap: r.readings.hiGap, vhi: VHI,
    and: r.andRows.map((x) => ({ pos: x.pos, U: +x.U.toFixed(6) })),
    or: r.orRows.map((x) => ({ pos: x.pos, U: +x.U.toFixed(6) })),
    parallel: r.readings.parallel,
    vmLoadRelMax: r.readings.vmLoadRelMax, vmLoadRel: r.readings.vmLoadRel,
  };
  console.log('\n\x1b[1mDIODE_GATE_JSON\x1b[0m ' + JSON.stringify(payload));
  process.exitCode = r.fail ? 1 : 0;
}

// ══════════════════════════════════════════════════════════
// 红档：变异体 = %TEMP% 副本 + ★ 新起 node 子进程
// ══════════════════════════════════════════════════════════
if (MODE_MUTATE) {
  const out = {
    mode: 'mutate', aligned: null, ctrlBad: 0, mutants: [],
    canaryRed: null, nullMutantClean: null, infra: false, childNoJSONCount: 0,
    repoUntouched: null, baseline: null, mutDir: null,
  };
  try {
    const TREE = ['src/core/world.js', 'src/core/plugin.js', 'src/equipment/registry.js',
      'src/coupling/bridge.js', 'src/physics/circuit.js', 'src/chemistry/reactions.js',
      'src/equipment/electrical.js', 'src/equipment/glassware.js', 'src/equipment/lab.js',
      'src/equipment/electronics.js'];
    const shaOf = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
    const shaBefore = Object.fromEntries(TREE.map((p) => [p, shaOf(join(ROOT, p))]));
    const probeShaBefore = shaOf(SELF);

    const dir = join(tmpdir(), 'diode-gate-mut-' + Date.now());
    out.mutDir = dir;
    mkdirSync(dir, { recursive: true });
    const probeRaw = readFileSync(SELF, 'utf8').split('\r\n').join('\n');
    // 把探针里指向 `../src/...` 的相对 import 改写成仓库真件的绝对 URL。
    // ★ 这里**只**改探针自己那一份文本：`src/**` 一律用仓库真件 —— 拷一份到 %TEMP% 会造出
    //   第二个 `registry.js` 模块实例，`define()` 在 `setup()` 里就找不到活动注册表了（实测踩过）。
    const realSrcRewritten = probeRaw.replace(
      /(\bfrom\s*|\bimport\s*)(['"])\.\.\/src\/([^'"\n]+)\2/g,
      (m, kw, q, rest) => kw + q + pathToFileURL(join(SRC, rest)).href + q);

    /** 判定通道 = **子进程 stdout**（不是复用文件）⇒ 天然没有「读到上一个变异体的红集」这个坑。
     *  退出码**不参与判据**；只看有没有那一行 JSON，且 `fail`/`reds` 形态合法。
     *  ★「缺失 ≠ 空」：`reds` 不是数组一律判 `infra`，**绝不当成 0 红**。 */
    const runInChild = (text, tag) => {
      const pp = join(dir, 'probe-' + tag + '.mjs');
      writeFileSync(pp, text, 'utf8');
      const rr = spawnSync(process.execPath, [pp], {
        encoding: 'utf8', timeout: 300000, cwd: ROOT,
        env: { ...process.env, DIODE_GATE_SRC: JSON.stringify(SRC) },   // ★ 子进程读仓库真件
      });
      const line = String(rr.stdout || '').split('\n').find((l) => l.includes('DIODE_GATE_JSON'));
      if (!line) {
        out.childNoJSONCount++;
        return { ok: false, why: 'childNoJSON', status: rr.status,
          stderr: String(rr.stderr || '').slice(0, 600) };
      }
      try {
        const j = JSON.parse(line.slice(line.indexOf('{')));
        const validReds = Array.isArray(j.reds) && typeof j.fail === 'number';
        if (!validReds) out.childNoJSONCount++;
        return { ok: true, json: j, validReds, status: rr.status };
      } catch (e) {
        out.childNoJSONCount++;
        return { ok: false, why: 'childBadJSON: ' + e.message, raw: line.slice(0, 300) };
      }
    };

    // ★ 基线：**在子进程里**先给一次数字，证明子进程读到的确实是当前代码（不是旧内容）
    const base = runInChild(realSrcRewritten, 'baseline');
    out.baseline = (base.ok && base.validReds)
      ? { items: base.json.items, pass: base.json.pass, fail: base.json.fail, reds: base.json.reds,
        andBits: base.json.andBits, orBits: base.json.orBits, hamming: base.json.hamming }
      : { error: base };
    out.baselineInChildOk = !!(base.ok && base.validReds && base.json.fail === 0);
    out.baselineSane = !!(base.ok && base.validReds && base.json.andBits === '0001');

    // ── 变异体定义 ──
    //  ★ 锚一律"加长到唯一"（实测 anchorHits 必须 == 1）；锚文本**不得出现在本表里**，
    //    否则 split/join 会误改到表里的那一份（这个坑已踩过）。
    //  ★ `why` 与 `repl` 不逐字相同（反模式：from 与自己描述逐字相同）。
    //  expect：声明的应红集合，必须与实测集合逐字一致。
    const MUTANTS = [
      {
        id: 'M0-CANARY', kind: 'canary',
        why: '金丝雀：把"输出判读恒 0"落进去，两条真值表应同时塌掉 —— 必须红，否则整族红档在空转',
        anchor: 'const GL = (u, v) => (Math.abs(u) > v ? 1 : 0);   // ←',
        repl: 'const GL = (u, v) => 0;   // ←',
        expect: ['AND-EQUALS-LEDGER-WITNESS', 'AND-NOT-OR-SHAPE', 'AND-RR', 'AND-TABLE-SHAPE', 'GATES-DIFFER', 'OR-LR', 'OR-RL', 'OR-RR', 'OR-TABLE-SHAPE', 'PARALLEL-OR-CONFIRMED', 'PULLDOWN-AND-COUNTEREXAMPLE', 'XCHK-DIODE-OR'],
      },
      {
        id: 'M1-NULL', kind: 'null',
        why: 'null 变异体：只把注释里一个全角冒号换成半角、语义为零 —— 必须 0 红（补金丝雀骗不过的"恒红"）',
        anchor: '/** 档位判读：|u| > v ⇒ 1。变异锚 M3 就落在这一行的表达式上。 */',
        repl: '/** 档位判读: |u| > v ⇒ 1。变异锚 M3 就落在这一行的表达式上。 */',
        expect: [],
      },
      {
        id: 'M2', kind: 'semantic',
        why: '与门把"输出上拉到 Vp"那根线拆掉 ⇒ 高电平失去来源，与门整族塌掉',
        anchor: '  [5, 0, 0, 0],                 // Vp ── 电阻 ── O   ← ★ 上拉（不是下拉）',
        repl: '  // [5, 0, 0, 0] 已拆（上拉缺失）',
        expect: ['AND-EQUALS-LEDGER-WITNESS', 'AND-OR-LEVEL-MIRROR', 'VM-READS-LOAD'],
      },
      {
        id: 'M3', kind: 'semantic',
        why: '把与门的两极管朝向翻面（阳极朝输入）⇒ 变成并联直通，两套实验做成同一个电路',
        anchor: '  [1, 0, 3, 1], [2, 0, 4, 1],   // A.COM → D1.K, B.COM → D2.K（★ 阴极朝输入）',
        repl: '  [1, 0, 3, 0], [2, 0, 4, 0],   // 翻面：阳极朝输入',
        expect: ['AND-EQUALS-LEDGER-WITNESS', 'AND-OR-LEVEL-MIRROR'],
      },
      {
        id: 'M4', kind: 'semantic',
        why: '把或门两支路的二极管朝上改掉 ⇒ 或门失去"任一导通即顶高"的能力',
        anchor: '[1, 0, 3, 0], [2, 0, 4, 0],   // A.COM → D1.A, B.COM → D2.A（阳极朝输入）',
        repl: '[1, 0, 3, 1], [2, 0, 4, 1],   // 二极管反放',
        expect: ['AND-NOT-OR-SHAPE', 'AND-OR-LEVEL-MIRROR', 'GATES-DIFFER', 'OR-LR', 'OR-RL', 'OR-TABLE-SHAPE', 'XCHK-DIODE-OR'],
      },
      {
        id: 'M5', kind: 'semantic',
        why: '把统一阈值抬到 6.5 V（高过任何实测电平）⇒ 两套实验同时塌成 0000，统一阈值的边界暴露',
        anchor: 'const VHI = 3;              // 与门/或门共用（或门这一支与既有 spdt-led-probe 同口径）',
        repl: 'const VHI = 6.5;            // 抬到高过所有实测电平',
        expect: ['AND-EQUALS-LEDGER-WITNESS', 'AND-NOT-OR-SHAPE', 'AND-OR-MARGIN', 'AND-RR', 'AND-TABLE-SHAPE', 'GATES-DIFFER', 'OR-LR', 'OR-RL', 'OR-RR', 'OR-TABLE-SHAPE', 'PARALLEL-OR-CONFIRMED', 'PULLDOWN-AND-COUNTEREXAMPLE', 'XCHK-DIODE-OR'],
      },
      {
        id: 'M6', kind: 'semantic',
        why: '把或门那一支的负载从 100 Ω 改成 1 Ω ⇒ 或门真实变了（导通输出被压到阈值下）⇒ 两条表的差别判定必须察觉',
        anchor: 'entities: ents(100).map((e, i) => (i === 1 ? { ...e, props: { pos: a, ron: 0.05 } }',
        repl: 'entities: ents(1).map((e, i) => (i === 1 ? { ...e, props: { pos: a, ron: 0.05 } }',
        expect: ['AND-OR-LEVEL-MIRROR', 'AND-OR-MARGIN', 'GATES-DIFFER', 'OR-LR', 'OR-RL', 'OR-RR', 'OR-TABLE-SHAPE', 'XCHK-DIODE-OR'],
      },
      {
        id: 'M7', kind: 'semantic',
        why: '把与门那一支的上拉从 1 kΩ 改成 1 Ω ⇒ 导通时不再被钳在 V_D、低电平被抬高 ⇒ 电平断言必须察觉',
        anchor: 'entities: ents(1000).map((e, i) => (i === 1 ? { ...e, props: { pos: a, ron: 0.05 } }',
        repl: 'entities: ents(1).map((e, i) => (i === 1 ? { ...e, props: { pos: a, ron: 0.05 } }',
        expect: ['AND-EQUALS-LEDGER-WITNESS', 'AND-OR-LEVEL-MIRROR'],
      },
      {
        id: 'M8', kind: 'semantic',
        why: '把两只二极管删成一只（与门少一只管）⇒ 不再是"与"而是直通',
        anchor: '  { type: \'diode\', x: 0, y: 0, props: { ...DPROPS } },\n  { type: \'diode\', x: 0, y: 0, props: { ...DPROPS } },',
        repl: '  { type: \'diode\', x: 0, y: 0, props: { ...DPROPS } },\n  { type: \'resistor\', x: 0, y: 0, props: { resistance: 1 } },',
        expect: ['AND-OR-LEVEL-MIRROR', 'GATES-DIFFER', 'OR-RL', 'OR-TABLE-SHAPE', 'PARALLEL-OR-CONFIRMED', 'XCHK-DIODE-OR'],
      },
      {
        id: 'M9', kind: 'semantic',
        why: '把负结果台账那四种接法的掷位反接 ⇒ 台账不再与 §1 的与门同一个电路 ⇒ 结构自证必须察觉',
        anchor: '  const rail = [[0, 0, 1, 2], [0, 0, 2, 2], [0, 1, 1, 1], [0, 1, 2, 1]];   // 电± 到两个 spdt',
        repl: '  const rail = [[0, 0, 1, 1], [0, 0, 2, 1], [0, 1, 1, 2], [0, 1, 2, 2]];   // 掷位反接（仅台账）',
        expect: ['AND-EQUALS-LEDGER-WITNESS', 'PULLDOWN-AND-COUNTEREXAMPLE'],
      },
      {
        id: 'M10', kind: 'semantic',
        why: '与门一侧不再把 B 开关的掷向落进实体 ⇒ "掷向真的被应用"这条断言必须察觉',
        anchor: '    : i === 2 ? { ...e, props: { pos: b, ron: 0.05 } } : e)),\n  wires: WIRES_AND,',
        repl: '    : i === 9 ? { ...e, props: { pos: b, ron: 0.05 } } : e)),\n  wires: WIRES_AND,',
        expect: ['AND-EQUALS-LEDGER-WITNESS', 'AND-INPUTS-APPLIED', 'AND-NOT-OR-SHAPE', 'AND-OR-LEVEL-MIRROR', 'AND-OR-MARGIN', 'AND-RR', 'AND-TABLE-SHAPE'],
      },
      {
        id: 'M11', kind: 'semantic',
        why: '或门一侧不再把 B 开关的掷向落进实体 ⇒ 或门那一支的同类断言必须察觉',
        anchor: '    : i === 2 ? { ...e, props: { pos: b, ron: 0.05 } } : e)),\n  wires: WIRES_OR,',
        repl: '    : i === 9 ? { ...e, props: { pos: b, ron: 0.05 } } : e)),\n  wires: WIRES_OR,',
        expect: ['GATES-DIFFER', 'OR-INPUTS-APPLIED', 'OR-LR', 'OR-TABLE-SHAPE', 'XCHK-DIODE-OR'],
      },
      {
        id: 'M12', kind: 'semantic',
        why: '把电压表内阻从高阻（1 MΩ）改成 100 Ω ⇒ 读数器开始加载被测电路 ⇒ 高阻与读数自洽两条必须察觉',
        anchor: "const VPROPS = { mode: 'V', fullScale: 15, realistic: true, realR: null };",
        repl: "const VPROPS = { mode: 'V', fullScale: 15, realistic: true, realR: 100 };",
        expect: ['AND-EQUALS-LEDGER-WITNESS', 'AND-NOT-OR-SHAPE', 'AND-OR-LEVEL-MIRROR', 'AND-OR-MARGIN', 'AND-RR', 'AND-TABLE-SHAPE', 'VM-HIGH-Z', 'VM-READS-LOAD'],
      },
      {
        id: 'M13', kind: 'semantic',
        why: '把台账里"交叉并接"那种写成与"共阳极+下拉"逐字相同的电路 ⇒ 四种拓扑两两不同这条必须察觉',
        anchor: '  return [...rail, [1, 0, 3, 0], [2, 0, 4, 1], [3, 1, 5, 1], [4, 0, 5, 1],\n    [5, 0, 0, 0], ...meter];',
        repl: '  return [...rail, [1, 0, 3, 1], [2, 0, 4, 1], [3, 0, 5, 1], [4, 0, 5, 1],\n    [5, 0, 0, 0], ...meter];',
        expect: ['PARALLEL-TOPOLOGIES-DISTINCT'],
      },
      {
        id: 'M14', kind: 'semantic',
        why: '把二极管正向压降从 1.8 V 抬到 4 V ⇒ "0" 组不再低于 3 V 阈值 ⇒ 三个 0 行与"低是真的低"必须察觉',
        anchor: "const DPROPS = { vf: 1.8, ron: 0.5, roff: 1, dir: 'fwd' };",
        repl: "const DPROPS = { vf: 4, ron: 0.5, roff: 1, dir: 'fwd' };",
        expect: ['AND-EQUALS-LEDGER-WITNESS', 'AND-LL', 'AND-LOW-IS-REALLY-LOW', 'AND-LR', 'AND-NOT-OR-SHAPE', 'AND-OR-MARGIN', 'AND-RL', 'AND-TABLE-SHAPE', 'OR-LR', 'OR-RL', 'OR-RR', 'OR-TABLE-SHAPE', 'PULLDOWN-AND-COUNTEREXAMPLE', 'XCHK-DIODE-OR'],
      },
      {
        id: 'M15', kind: 'semantic',
        why: '把或门那支的输出下拉改成上拉 ⇒ 或门失去"两路都低时输出 0" ⇒ 那两个 0 判据必须察觉',
        anchor: '  [5, 1, 0, 1],                 // 输出经下拉到地',
        repl: '  [5, 1, 0, 0],                 // 改成上拉到 Vp（或门失去低电平）',
        expect: ['AND-OR-LEVEL-MIRROR', 'AND-OR-MARGIN', 'OR-LL', 'OR-LOW-IS-REALLY-LOW', 'OR-TABLE-SHAPE', 'XCHK-DIODE-OR'],
      },
      {
        id: 'M16', kind: 'semantic',
        why: '把台账"共阴极+上拉"那一种的二极管翻面 ⇒ 上拉族里出现能给 0001 的接法 ⇒ 负结果必须察觉',
        anchor: '    return [...rail, [1, 0, 3, 0], [2, 0, 4, 0], [3, 1, 5, 1], [4, 1, 5, 1],\n      [5, 1, 0, 1], ...meter];',
        repl: '    return [...rail, [1, 0, 3, 1], [2, 0, 4, 1], [3, 0, 5, 1], [4, 0, 5, 1],\n      [5, 0, 0, 0], ...meter];',
        expect: ['NO-PULLUP-AND', 'PARALLEL-TOPOLOGIES-DISTINCT'],
      },
    ];

    //  ★ `expect` **不参与判据** —— 它只是"我以为会红什么"的留档，用来暴露
    //    「我以为的」和「实际红的」之间的差距。判据走**并集覆盖**（见块尾）：
    //    不靠人手工声明，避免"声明按实测改"的循环论证。
    //  ★ `why` 与 `repl` 不逐字相同（反模式：from 与自己描述逐字相同）。
    // ★ 锚的**计数与替换只在「代码区」里做**（= 文件文本去掉 MUTANTS 表本身）：
    //   表里的 `anchor:` 字段逐字就是锚文本 ⇒ 全文件计数恒为 2（实测 9 只里 6 只 hits===2），
    //   作者留的"锚加长到唯一"在表自身计入时**结构上做不到** ⇒ 内部记一次基础设施。
    //   表区原样保留、代码区单独替换 ⇒ 子进程收到的仍是"只改了落点那一处"的文本。
    const TBL0 = realSrcRewritten.indexOf('\n    const MUTANTS = [');
    const TBL1 = realSrcRewritten.indexOf('\n    ];\n', TBL0) + '\n    ];\n'.length;
    const PRE = realSrcRewritten.slice(0, TBL0);
    const TABLE = realSrcRewritten.slice(TBL0, TBL1);
    const SUF = realSrcRewritten.slice(TBL1);
    const CODE = PRE + SUF;
    // ⚠ 自检用的两个字面量**必须拼接写**：它们一旦以完整形态出现在这一行里，就会落进 CODE
    //   ⇒ 自检恒假、整个红档在第一只变异体前就抛（实测踩到过一次：TBL0=27832 时守卫自己命中）。
    const CANARY_ID = 'M0' + '-CANARY';
    const KIND_CANARY = 'kind:' + " 'canary'";
    if (!(TBL0 > 0 && TBL1 > TBL0 && TABLE.includes(CANARY_ID) && !CODE.includes(KIND_CANARY))) {
      throw new Error('切不出变异体表区域（TBL0=' + TBL0 + ' TBL1=' + TBL1 + '）⇒ 基础设施');
    }
    for (const m of MUTANTS) {
      const hits = CODE.split(m.anchor).length - 1;
      const atPre = PRE.indexOf(m.anchor), atSuf = SUF.indexOf(m.anchor);
      const line = atPre >= 0 ? realSrcRewritten.slice(0, atPre).split('\n').length
        : atSuf >= 0 ? realSrcRewritten.slice(0, TBL1 + atSuf).split('\n').length : -1;
      const preM = (hits === 1) ? PRE.split(m.anchor).join(m.repl) : PRE;
      const sufM = (hits === 1) ? SUF.split(m.anchor).join(m.repl) : SUF;
      const mutated = preM + TABLE + sufM;
      const r = runInChild(mutated, m.id);
      // ★「缺失 ≠ 空」：只有 JSON 齐备**且** reds 是数组，才承认它是"红集体"
      const usable = !!(r.ok && r.validReds);
      const observed = usable ? r.json.reds.slice().sort() : ['__CHILD_FAILED__'];
      const selfOnDisk = readFileSync(SELF, 'utf8').split('\r\n').join('\n');
      const selfIntact = selfOnDisk.includes(m.anchor);
      const declared = m.expect.slice().sort();
      const ctrlRed = usable ? observed.filter((id) => id.startsWith('CTRL-')) : [];
      // ★ landInCode：实测推导（不写字面量）——三条同时成立才算「真的落进代码」：
      //   ① 锚在源里**恰好命中一次**（锚必须唯一；命中 3 次要加长到唯一，不是放宽）
      //   ② 实际交给子进程的文本**逐字等于**「锚换成 repl」的拼接
      //   ③ 盘上那份副本里**锚原文已不在**，且 repl 确实出现
      // ★ landInCode 的②③两条也**只在代码区**上判（表区那份锚文本是留档，不参与判定）；
      //   ② 用**出现次数**独立推导（不拿同一个 split/join 算式自证）：锚归零 + repl 恰好多一次
      //   ③ 盘上那份副本的**代码区**里锚已消失、repl 同样恰好多一次（读回来验，不是信自己）
      const codeSent = preM + sufM;
      const codeReplBefore = CODE.split(m.repl).length - 1;
      // ★ 文本增量**实测**：必须等于「repl 长度 − anchor 长度」这个独立算出来的期望值
      const textDelta = codeSent.length - CODE.length;
      const deltaExpected = m.repl.length - m.anchor.length;
      const sentExactly = (hits === 1)
        && codeSent.split(m.anchor).length - 1 === 0
        && codeSent.split(m.repl).length - 1 === codeReplBefore + 1
        && textDelta === deltaExpected;
      const childOnDisk = readFileSync(join(dir, 'probe-' + m.id + '.mjs'), 'utf8');
      const cd0 = childOnDisk.indexOf('\n    const MUTANTS = [');
      const cd1 = childOnDisk.indexOf('\n    ];\n', cd0) + '\n    ];\n'.length;
      const childCode = (cd0 > 0 && cd1 > cd0)
        ? childOnDisk.slice(0, cd0) + childOnDisk.slice(cd1) : childOnDisk;
      const anchorGoneInCode = !childCode.includes(m.anchor);
      const replAddedInCode = childCode.split(m.repl).length - 1 === codeReplBefore + 1;
      const landInCode = (hits === 1) && sentExactly && anchorGoneInCode && replAddedInCode;
      // ⚠ 这里原来是 `declared.forEach((id) => wantRed.add(id));` —— `wantRed` 是旧设计的残留
      //   （改成「并集覆盖」后已无声明集）⇒ 实测 `ReferenceError: wantRed is not defined`，
      //   整个红档在第一只变异体上就抛出去、`mutants` 恒为空。声明只作留档，见 declaredReds。
      out.mutants.push({
        id: m.id, kind: m.kind, why: m.why, anchorHits: hits, anchorLine: line,
        textDelta, deltaExpected, sentExactly,
        landInCode, selfFileIntact: selfIntact, redsUsable: usable,
        declaredReds: declared, observedReds: observed,
        redsAligned: usable && declared.join(',') === observed.join(','),
        ctrlRed, childOk: !!r.ok, childErr: usable ? undefined : r,
        pass: usable ? r.json.pass : null, fail: usable ? r.json.fail : null,
        childAndBits: usable ? r.json.andBits : null, childOrBits: usable ? r.json.orBits : null,
      });
      out.ctrlBad += ctrlRed.length;
    }
    // ── 判据：**不由声明驱动**（不靠人手工写 expect，避免"声明按实测改"的循环论证）──
    //   ① 每个**语义**变异体至少产生 1 红（没产出 ⇒ 它压根没改到东西）
    //   ② 所有语义变异体的红集**并集** == 绿档断言全集（少一条 ⇒ 那条断言没有任何变异体能打红它）
    //   ③ 金丝雀必须红（机制自证 A）；null 必须 0 红（机制自证 B）
    const canary = out.mutants.find((m) => m.kind === 'canary');
    const nullMut = out.mutants.find((m) => m.kind === 'null');
    const semantic = out.mutants.filter((m) => m.kind === 'semantic');
    out.canaryRed = !!(canary && canary.redsUsable && canary.observedReds.length > 0 && canary.landInCode);
    out.nullMutantClean = !!(nullMut && nullMut.redsUsable && nullMut.observedReds.length === 0 && nullMut.landInCode);
    // ★ 覆盖并集**不吃控制组**：§0 的 CTRL-* 语义恰恰是"任何变异体下都不得变红"
    //   （红一条就要记 ctrlBad ⇒ 与"必须被某只变异体打红"结构上互斥 —— 作者原设计把
    //   CTRL-* 也算进并集 ⇒ `coverageComplete` 与 `ctrlBad === 0` 永不可能同时成立）。
    const allBaseIds = (base.ok && base.validReds) ? base.json.redsAll.slice().sort() : [];
    const CTRL_GROUP = allBaseIds.filter((id) => id.startsWith('CTRL-'));
    const baseIds = allBaseIds.filter((id) => !id.startsWith('CTRL-'));
    out.baselineAssertionCount = allBaseIds.length;
    out.coverageScope = { total: allBaseIds.length, controlGroupCount: CTRL_GROUP.length, counted: baseIds.length };
    out.semanticWithNoRed = semantic.filter((m) => m.redsUsable && m.observedReds.filter((x) => x !== '__CHILD_FAILED__').length === 0).map((m) => m.id);
    const union = [...new Set(semantic.flatMap((m) => (m.redsUsable ? m.observedReds : [])))].filter((x) => x !== '__CHILD_FAILED__').sort();
    out.unionReds = union;
    out.uncoveredAssertions = baseIds.filter((id) => !union.includes(id));
    out.coverageComplete = out.uncoveredAssertions.length === 0 && out.semanticWithNoRed.length === 0;
    out.aligned = out.coverageComplete && out.canaryRed && out.nullMutantClean
      && out.mutants.every((m) => m.landInCode && m.redsUsable);
    out.infra = !out.canaryRed || !out.nullMutantClean
      || out.mutants.some((m) => !m.redsUsable || !m.landInCode);
    out.landInCodeAll = out.mutants.every((m) => m.landInCode);
    out.textDeltaAll = out.mutants.every((m) => m.textDelta === m.deltaExpected);
    out.redsUsableAll = out.mutants.every((m) => m.redsUsable);
    out.selfFileUntouched = out.mutants.every((m) => m.selfFileIntact);
    out.repoUntouched = TREE.every((p) => shaOf(join(ROOT, p)) === shaBefore[p]) && shaOf(SELF) === probeShaBefore;
    // ★ 声明 ≡ 实测（lead 的硬要求）：期望红数必须等于实测红数。声明仍**不参与**判定
    //   （判定走并集覆盖），这里只把"声明 vs 实测"的差如实打出来。
    out.expectedRed = out.mutants.reduce((s2, m) => s2 + (m.declaredReds ? m.declaredReds.length : 0), 0);
    out.observedRed = out.mutants.reduce((s2, m) => s2
      + (m.observedReds ? m.observedReds.filter((x) => x !== '__CHILD_FAILED__').length : 0), 0);
    out.expectsAligned = out.mutants.every((m) => m.redsAligned);
    out.misdeclared = out.mutants.filter((m) => !m.redsAligned)
      .map((m) => ({ id: m.id, declared: m.declaredReds, observed: m.observedReds }));
    out.ok = out.aligned === true && out.ctrlBad === 0 && out.repoUntouched === true
      && out.baselineInChildOk === true && out.baselineSane === true && out.nullMutantClean === true
      && out.childNoJSONCount === 0 && out.infra === false && out.expectsAligned === true;
    out.verdictChannel = 'child-stdout（非复用判定文件）；退出码不参与判据；reds 非数组 ⇒ infra（缺失≠空）';
  } catch (err) {
    out.error = String((err && err.stack) || err);
    out.infra = true;
  }
  console.log('\x1b[1mDIODE_GATE_JSON\x1b[0m ' + JSON.stringify(out));
  // 退出码**不进判据**（看 out.ok 字段）；这里只为 shell 顺手给一个一致的值
  process.exitCode = out.ok ? 0 : 1;
}
