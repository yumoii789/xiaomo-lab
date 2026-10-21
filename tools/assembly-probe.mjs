#!/usr/bin/env node
// ══════════════════════════════════════════════════════════
// assembly-probe —— 「一键组装」（成套预设，含连线）判据（task-29 / plans/17 项⑤）
//
//   绿档：node tools/assembly-probe.mjs            判据；退出码既不是成功的判据也不是失败的判据，看 JSON。
//   红档：node tools/assembly-probe.mjs --mutate   变异体自证：每个变异体必须
//         ① 真落进代码（`landInCode`：锚点在**归一换行后**恰好命中一次 + 盘上字节确实变了）
//         ② 红集**双向对齐**声明集（`redsAligned`：没有声明之外的红，也没有声明了却不红的）
//         ③ M0 **金丝雀**必须真红 —— 它不红就等于「变异体根本没送到被测代码」（拿到原件/缓存旧实例）
//            ⇒ 整族红档都在空转 ⇒ 判 `infra`，**不许把它的绿当成通过**。
//         ④ 反向也自证：`NULL` 变异体（只动注释一个字节、语义为零）必须 **0 红** ⇒
//            证明红不是天生的（单靠金丝雀会被「恒红」骗过，单靠 null 会被「恒绿」骗过）。
//   两档**无论发生什么**最后都打出机器可读的 `ASSEMBLY_JSON`（红档哑火是本仓最坏的失效）。
//
// ── 红档怎么躲开两类坑（ESM 缓存 / 模块求值期建全局状态）──
// 把整棵 `src/` + 本探针**拷进 `%TEMP%`**，每个变异体只覆写其中一个文件，然后**新起一个 node 进程**
// 跑 `%TEMP%/tools/assembly-probe.mjs` ⇒ 换文件路径 + 换进程，缓存无从生效；
// 仓库零字节副作用（改的永远是副本，跑完删掉）。
//
// ── 诚实命名（硬要求）──
// 本项落地的是「**成套预设（含连线）**」：连线来自预设数据**自带的** `wires`。
// 它**不是**「自动布线 / 智能连线」—— 组装时没有任何算法决定「哪根线接哪里」。
// 依据：NB 两个 umi 包 + 两个编辑器按 `自动连线|自动连接|autoConnect|autoWire|自动接线`
// 检索 **0 命中**（plans/17 项⑤ 台账 T9）⇒ 「NB 有自动布线」无证据。
// 这条不只是散文：`HONEST-NAMING` 判据扫被测模块源码，**未经否定的**这些词出现即红。
//
// ── 真与替身边界（决定结论适用范围，必须诚实）──
// 真：① 被测模块是 `src/presets/assembly.js` **真身**（不是抄进探针的副本）；
//     ② 器材用**真注册表**（真 `PluginHost` 引导 + 真 `equipmentPlugins`）；
//     ③ 世界是**真 `World`**、撤销栈是**真 `UndoStack`**、求解是**真 `solveCircuit`**
//        （`CouplingBus(world).buildBranches()` → `solveCircuit(world, br)`，与 main.js 的
//        `instrumentWorld()` 同一条流水线）；预设数据是**真 `src/presets/experiments.js`**。
// 替身：`app` —— `main.js` 的 `class App` 顶层建 DOM 宿主，无头环境**实例化不了**
//     （`tools/undo-probe.mjs` 自己也记了这条）。替身里的 `loadScene` / `_applyScene` /
//     `_applySave` / `applySaveData` **逐字照抄** main.js 真身（只把 `this.` 换成 `app.`），
//     由 `DRIFT-ANCHORS` 拿**磁盘字节**守漂移：main.js 一改，本探针立刻红，逼人回来同步。
//     本探针能证明的是**模块 + 这条落地流水线**的行为；「浏览器里点一下」见回报的真机清单。
//
// ── 纪律 ──
// · 拿磁盘字节匹配源码文本的地方**先归一换行**（本仓 core.autocrlf=true）。
// · 注释只写符号名，不写行号。
// · 断言不许与所测常量耦合：预设套数、器材件数一律用**数据自身**表达，不写死数字。
// ══════════════════════════════════════════════════════════

import { readFileSync, writeFileSync, mkdirSync, rmSync, cpSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const SELF = fileURLToPath(import.meta.url);
const U = (rel) => pathToFileURL(join(ROOT, rel)).href;
const MUTATE = process.argv.includes('--mutate');
const argOf = (n, d) => {
  const hit = process.argv.slice(2).find((a) => a.startsWith('--' + n + '='));
  return hit ? hit.slice(n.length + 3) : d;
};
const JUDGE_JSON = argOf('judge-json', null);
const QUIET = !!JUDGE_JSON;

const MODULE_REL = 'src/presets/assembly.js';
const PROBE_REL = 'tools/assembly-probe.mjs';
const norm = (s) => String(s).replace(/\r\n/g, '\n');
const sha = (s) => createHash('sha256').update(s).digest('hex');
// 与 `tools/undo-probe.mjs` **同一条**注释规则（整行以 // 或 * 或 /* 开头即整行丢弃）：
// 数「beginSilent 后跟空括号」这类源码文本计数时，必须用它——否则本探针会比真判据更严，
// 从而把"真判据其实是绿的"报成红（本探针自己踩过一次：main.js 里本来就有 1 处注释提到它）。
const stripLineComments = (s) => s.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

// ── 判据收集器 ────────────────────────────────────────────
const RESULTS = [];
let PASS = 0, FAIL = 0;
const HEAD = (t) => { if (!QUIET) console.log('\n\x1b[36m' + t + '\x1b[0m'); };
const INFO = (t) => { if (!QUIET) console.log('    \x1b[90m' + t + '\x1b[0m'); };
const check = (id, cond, msg) => {
  RESULTS.push({ id, red: !cond });
  if (cond) { PASS++; if (!QUIET) console.log('  \x1b[32m✓\x1b[0m ' + msg); }
  else { FAIL++; if (!QUIET) console.log('  \x1b[31m✗\x1b[0m ' + msg); }
};
const reds = () => RESULTS.filter((r) => r.red).map((r) => r.id);
const READINGS = {};

// ══════════════════════════════════════════════════════════
// 真 · 引导（真 PluginHost + 真 equipmentPlugins ⇒ 真注册表）
// ══════════════════════════════════════════════════════════
async function boot() {
  const { World } = await import(U('src/core/world.js'));
  const { UndoStack } = await import(U('src/core/undo.js'));
  const { PluginHost } = await import(U('src/core/plugin.js'));
  const { create, bindRegistry } = await import(U('src/equipment/registry.js'));
  const { equipmentPlugins } = await import(U('src/equipment/index.js'));
  const { CouplingBus } = await import(U('src/coupling/bridge.js'));
  const { solveCircuit } = await import(U('src/physics/circuit.js'));
  const { PRESETS } = await import(U('src/presets/experiments.js'));
  const pick = async (p) => (await import(U(p))).default;

  const bootApp = {
    services: {}, ticks: [], world: null, lastCircuit: null, selected: null,
    log: { push() {}, clear() {} }, toast() {},
    addTick(fn) { this.ticks.push(fn); return () => {}; },
  };
  const host = new PluginHost(bootApp);
  // 与 `tools/equipbar-probe.mjs` 同一份引导清单：求解器 + 化学 + 耦合 + 全部器材插件。
  // ★ `bindRegistry` 必须绑**这一份**：`registry.js` 的 `create()/get()` 每次读 `currentRegistry()`，
  //   不绑就等于静默用回原版注册表（变异体"跑过了"却什么都没变 = 假绿）。
  for (const p of [
    await pick('src/physics/circuit.js'),
    await pick('src/chemistry/reactions.js'),
    await pick('src/coupling/bridge.js'),
    ...equipmentPlugins,
  ]) host.define(p);
  host.installAll();
  bindRegistry(host.registry('equipment'));
  return { World, UndoStack, create, CouplingBus, solveCircuit, PRESETS, reg: host.registry('equipment') };
}

/** 组装前「用户手搭的」那份场景：2 件器材 + 1 根线，其中一件是**装了液体的烧杯**。
 *  两处用途：① §B 每一套都先在**有东西的台面**上组装（否则「组装没清台面」这类缺陷看不见）；
 *  ② §G 撤销回退的化学状态要用它做**独立于快照函数**的交叉核（见 UNDO-BACK-CHEM）。 */
const PRE_SCENE = {
  entities: [
    { type: 'battery', x: 300, y: 300, props: { emf: 3, internalR: 1 } },
    { type: 'beaker', x: 700, y: 420, props: { capacity: 250 }, fill: { liquid: [['H2O', 90]] } },
  ],
  wires: [[0, 1, 1, 0, 'wire']],
};

function makeStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    _map: m,
  };
}

/** `app` 替身。四个落地方法**逐字**照抄 main.js（只把 `this.` 换成 `app.`），由 DRIFT-ANCHORS 守漂移。 */
function makeApp(fac, presets, opts = {}) {
  const world = new fac.World();
  const undo = new fac.UndoStack({ limit: 100 });
  world.undo = undo;
  const app = {
    world, undo, services: { presets }, storage: opts.storage || makeStorage(),
    data: { clear() { app._dataCleared++; } },
    coupling: { links: [], branches: [] },
    selected: null, _shortWarned: false,
    _selectCalls: 0, _dataCleared: 0, _loads: 0,
    toast() {}, log: { push() {} },
    /** main.js: select —— 可见效果：换选中态 */
    select(ent) { app._selectCalls++; app.selected = ent; },
    /** main.js: loadScene —— 逐字（`this.` → `app.`） */
    loadScene(sc) {
      app._loads++;
      app.world.clear();
      app.select(null);
      if (app.data) app.data.clear();
      app.coupling.links = [];
      app.coupling.branches = [];
      app._shortWarned = false;
      app.undo.beginSilent();
      try { app._applyScene(sc); } finally { app.undo.endSilent(); }
      // main.js 这句之后还有 bus.emit(EV.SCENE_DIRTY)：无头环境没有引擎监听者，
      // 而 `world.clear()/connect()` 自己已发同名事件（engine.js 只拿它置重绘位）⇒ 语义等价。
      return app.world.entities.length;
    },
    /** main.js: _applyScene —— 逐字 */
    _applyScene(sc) {
      const ents = [];
      for (const o of sc.entities || []) {
        const ent = fac.create(o.type, o.x, o.y);
        if (!ent) continue;
        if (o.props) for (const k of Object.keys(o.props)) ent.setProp(k, o.props[k]);
        if (o.state) Object.assign(ent.state, o.state);
        if (o.fill && ent.vessel) {
          const v = ent.vessel;
          v.capacity = ent.props.capacity || v.capacity;
          for (const [sid, mL] of (o.fill.liquid || [])) v.addLiquid(sid, mL);
          for (const [sid, g] of (o.fill.solid || [])) v.addSolid(sid, g);
          v.updateColor();
        }
        app.world.add(ent, true);
        ents.push(ent);
      }
      for (const w of sc.wires || []) {
        const a = ents[w[0]], b = ents[w[2]];
        if (!a || !b) continue;
        app.world.connect({ e: a.id, p: w[1] }, { e: b.id, p: w[3] }, w[4]);
      }
      app.world.time = 0;
      return ents;
    },
    /** main.js: _applySave —— 逐字 */
    _applySave(data) {
      const ents = [];
      for (const o of data.entities || []) {
        const ent = fac.create(o.type, o.x, o.y);
        if (!ent) continue;
        ent.loadJSON(o);
        if (o.vessel && ent.vessel) ent.vessel.loadJSON(o.vessel);
        app.world.add(ent, true);
        ents.push(ent);
      }
      for (const w of data.wires || []) {
        const a = ents[w[0]], b = ents[w[2]];
        if (!a || !b) continue;
        app.world.connect({ e: a.id, p: w[1] }, { e: b.id, p: w[3] }, w[4]);
      }
      return ents;
    },
    /** main.js: applySaveData —— 逐字（注意是 runSilent，不是 beginSilent） */
    applySaveData(data) {
      app.world.clear();
      app.select(null);
      if (app.data) app.data.clear();
      app._shortWarned = false;
      app.undo.runSilent(() => app._applySave(data));
      return app.world.entities.length;
    },
  };
  return app;
}

/** 真求解：与 main.js `instrumentWorld()` 同一条流水线（造支路 → 解电路） */
function solveNow(fac, app) {
  const cb = new fac.CouplingBus(app.world);
  const br = cb.buildBranches();
  const c = fac.solveCircuit(app.world, br);
  let maxU = 0, maxI = 0, nonZero = 0;
  for (const e of app.world.entities) {
    const U = Math.abs(Number(e.state && e.state.U) || 0);
    const I = Math.abs(Number(e.state && e.state.I) || 0);
    if (U > maxU) maxU = U;
    if (I > maxI) maxI = I;
    if (U > 1e-9 || I > 1e-9) nonZero++;
  }
  return { maxU, maxI, nonZero, branches: br.length, nodeCount: (c && c.n) || null };
}

/** 一条连线的身份：忽略顺序与方向（两端互换算同一条），带 kind */
function wireKey(types, a, pa, b, pb, kind) {
  const s = (t, p) => (t || '?') + '#' + p;
  const [x, y] = [s(types[a], pa), s(types[b], pb)].sort();
  return x + '--' + y + ':' + kind;
}
const worldWireKeys = (world) => {
  const types = world.entities.map((e) => e.type);
  const idx = new Map(world.entities.map((e, i) => [e.id, i]));
  return world.wires.map((w) => wireKey(types, idx.get(w.a.e), w.a.p, idx.get(w.b.e), w.b.p, w.kind));
};
const declaredWireKeys = (sc) => {
  const types = sc.entities.map((o) => o.type);
  return (sc.wires || []).map((w) => wireKey(types, w[0], w[1], w[2], w[3], w[4]));
};

/** 用**独立的一条路**（`VesselModel` 自己的读数）给化学状态拍指纹，不经过快照函数 */
function vesselFingerprint(app) {
  const out = [];
  for (const e of app.world.entities) {
    if (!e.vessel) continue;
    const v = e.vessel;
    out.push({
      type: e.type,
      volume: Math.round(v.volume * 1e6) / 1e6,
      temp: Math.round(v.temp * 1e6) / 1e6,
      h2o: Math.round(v.amount('H2O') * 1e9) / 1e9,
      cap: v.capacity,
    });
  }
  return out;
}

// ══════════════════════════════════════════════════════════
// 判据
// ══════════════════════════════════════════════════════════
async function main() {
  const fac = await boot();
  const mod = await import(U(MODULE_REL));
  const mainSrc = norm(readFileSync(join(ROOT, 'src/main.js'), 'utf8'));
  const modSrc = norm(readFileSync(join(ROOT, MODULE_REL), 'utf8'));
  const selfSrc = norm(readFileSync(SELF, 'utf8'));

  HEAD('A. 预设清单与归属（口径一律来自数据自身，不写死套数）');
  const presets = fac.PRESETS || [];
  check('PRESET-LIST', presets.length > 0 && presets.every((p) => typeof p.build === 'function'),
    `服务里注册了 ${presets.length} 套预设（空集会让后面所有 every() 恒真 ⇒ 先钉非空）`);
  const declared = new Map();
  const noWires = [];
  for (const p of presets) {
    const sc = p.build();
    declared.set(p.id, { ents: (sc.entities || []).length, wires: (sc.wires || []).length });
    if (!(sc.wires || []).length) noWires.push(p.id);
  }
  const withWires = presets.length - noWires.length;
  check('PRESET-WIRES-PRESENT', declared.size === presets.length && withWires >= 1,
    `至少一套预设自带连线（「含连线」能成立的前提）：带连线 ${withWires} 套；本来就不接线的成套 = ${JSON.stringify(noWires)}`);

  const groups = mod.groupPresets(presets);
  const cover = {
    physics: presets.filter((p) => (mod.presetDomains(p).physics || 0) > 0).map((p) => p.id),
    chemistry: presets.filter((p) => (mod.presetDomains(p).chemistry || 0) > 0).map((p) => p.id),
  };
  READINGS.groups = {
    klass: Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, v.map((p) => p.id)])),
    cover,
  };
  check('DOMAIN-COVERAGE', cover.physics.length >= 1 && cover.chemistry.length >= 1,
    `含物理器材的成套 ${cover.physics.length} 套 / 含化学器材的成套 ${cover.chemistry.length} 套（跨学科的成套两侧都计入）`);
  // ★ 这条守的是「跨学科」这个**项目招牌**：把跨学科成套归成纯物理不会让上面那条红
  //   （它按器材学科算覆盖，照样成立）⇒ 必须有单独一条盯着归属分类本身。
  const classified = groups.physics.length + groups.chemistry.length + groups.cross.length;
  check('CLASS-GROUPS', groups.cross.length >= 1 && classified === presets.length,
    `跨学科成套 ${groups.cross.length} 套（${groups.cross.map((p) => p.id).join('、')}），且每套都有归属：${classified}/${presets.length}`);

  // ★ task-34 新增：一条专门盯「纯物理」这一档是否**名存实亡**的判据。
  //   为什么必须单独一条：上面那条只钉「跨学科 ≥1」+「每套都有归属」——
  //   把纯物理成套归成 cross 它**照样绿**（DOMAIN-COVERAGE 按器材学科算覆盖，也绿）
  //   ⇒ 「groups.physics 是空数组」这个状态此前**没有任何判据能看见**。
  //   判据用 >= 1 而不是写死套数：套数是数据自身的属性（与文件头的纪律同款）。
  check('CLASS-PHYSICS-PRESENT', groups.physics.length >= 1,
    `纯物理成套 ${groups.physics.length} 套（${groups.physics.map((p) => p.id).join('、') || '无'}）—— 空数组 = 「只想做物理」这一档名存实亡`);

  HEAD('B. 组装：清台面后件数守恒 + 连线逐条对应（★ 只看器材数会在「连线全丢」时全绿）');
  const covered = [];
  const perPreset = {};
  for (const p of presets) {
    const d = declared.get(p.id);
    const app = makeApp(fac, presets);
    app.loadScene(PRE_SCENE);            // ★ 在**有东西的台面**上组装：否则「没清台面」看不见
    const r = mod.assemble(app, p.id);
    if (!r.ok) { check('ASSEMBLE-OK-' + p.id, false, `${p.id}: ${r.reason}`); continue; }
    covered.push(p.id);
    const sc = p.build();
    const ents = app.world.entities.length;
    const wires = app.world.wires.length;
    const typesMatch = JSON.stringify(sc.entities.map((o) => o.type))
      === JSON.stringify(app.world.entities.map((e) => e.type));
    perPreset[p.id] = {
      klass: r.klass, declared: d, after: { ents, wires }, typesMatch,
      solver: solveNow(fac, app), wireKeys: worldWireKeys(app.world),
      selectCalls: app._selectCalls, dataCleared: app._dataCleared,
    };
    check('ENTITY-COUNT-' + p.id, ents === d.ents, `${p.id}: 器材 ${ents} == 声明 ${d.ents}`);
    check('WIRE-COUNT-' + p.id, wires === d.wires, `${p.id}: 连线 ${wires} == 声明 ${d.wires}`);
    check('WIRE-ENDPOINTS-' + p.id,
      JSON.stringify(worldWireKeys(app.world).sort()) === JSON.stringify(declaredWireKeys(sc).sort()),
      `${p.id}: 每条连线的两端 type+port+kind 逐条对应`);
    check('ENTITY-TYPES-' + p.id, typesMatch, `${p.id}: 器材**类型序列**与声明一致（换成别的器材也会红）`);
    check('NO-STRAY-SELECT-' + p.id, app._selectCalls >= 1 && app.selected === null,
      `${p.id}: 组装后无残留选中态（select 调用 ${app._selectCalls} 次，末次 selected=null）`);
  }
  check('PRESET-COVERAGE', covered.length === presets.length && presets.length > 0,
    `每套预设都被跑过：${covered.length}/${presets.length}（将来追加的预设自动进入本循环）`);
  READINGS.presets = perPreset;

  HEAD('C. 幂等：连按两次 == 按一次（不叠加残留）');
  {
    const p = presets[0];
    const app = makeApp(fac, presets);
    mod.assemble(app, p.id);
    const once = { ents: app.world.entities.length, wires: app.world.wires.length, keys: worldWireKeys(app.world).sort() };
    mod.assemble(app, p.id);
    const twice = { ents: app.world.entities.length, wires: app.world.wires.length, keys: worldWireKeys(app.world).sort() };
    READINGS.idempotent = { preset: p.id, once: { ents: once.ents, wires: once.wires }, twice: { ents: twice.ents, wires: twice.wires } };
    check('IDEMPOTENT', once.ents === twice.ents && once.wires === twice.wires
      && JSON.stringify(once.keys) === JSON.stringify(twice.keys),
      `${p.id}: 组装两次仍是 ${twice.ents} 件 / ${twice.wires} 连线（没有变成两倍）`);
  }

  HEAD('D. 位置：每件器材都真的被摆下（不是全叠在同一点）');
  {
    const bad = [];
    for (const p of presets) {
      const app = makeApp(fac, presets);
      mod.assemble(app, p.id);
      const keys = app.world.entities.map((e) => `${e.x},${e.y}`);
      const dup = keys.length - new Set(keys).size;
      const out = app.world.entities.filter((e) => !(e.x > 0 && e.y > 0)).length;
      if (dup > 0 || out > 0) bad.push({ id: p.id, dup, out });
    }
    READINGS.placement = { bad };
    check('IN-VIEW', bad.length === 0, `无重合坐标、无原点/负坐标：异常 = ${JSON.stringify(bad)}`);
  }

  HEAD('E. 真求解器：组装出的电路真跑得动');
  {
    const withBattery = presets.filter((p) => p.build().entities.some((o) => o.type === 'battery'));
    const rows = withBattery.map((p) => ({ id: p.id, ...(perPreset[p.id] || {}).solver }));
    READINGS.solver = rows;
    const dead = rows.filter((r) => !r.nonZero);
    check('SOLVER-NONZERO', withBattery.length > 0 && dead.length === 0,
      `含电源的成套 ${withBattery.length} 套全部有非零读数；死电路 = ${JSON.stringify(dead.map((r) => r.id))}`);
  }

  HEAD('F. 化学侧：容器里真有东西（「数值路径盲区」的补刀）');
  {
    const chem = presets.filter((p) => mod.presetClass(p) !== 'physics');
    const bad = [];
    for (const p of chem) {
      const app = makeApp(fac, presets);
      mod.assemble(app, p.id);
      const vols = app.world.entities.filter((e) => e.vessel).map((e) => e.vessel.volume);
      if (!vols.length || Math.max(...vols) <= 0) bad.push(p.id);
    }
    READINGS.chemVolume = { checked: chem.map((p) => p.id), bad };
    check('CHEM-STATE', chem.length > 0 && bad.length === 0,
      `化学/跨域成套 ${chem.length} 套的容器都装了液体；空烧杯 = ${JSON.stringify(bad)}`);
  }

  HEAD('G. 撤销方案甲：组装前自动存一份，「撤销组装」逐位回到组装前');
  {
    const p = presets.find((x) => declared.get(x.id).wires > 0) || presets[0];
    const app = makeApp(fac, presets);
    app.loadScene(PRE_SCENE);
    // 先来一次**真·用户动作**入栈，证明「组装不入栈」测的是真栈而不是空栈
    app.world.add(fac.create('switch', 120, 120));
    const depthAfterUser = app.undo.depth;
    // ★ 基准必须是「组装前**那一刻**」的样子（含刚刚那件器材）—— 撤回的语义就是它。
    const before = mod.snapshotWorld(app.world);
    const beforeVessel = vesselFingerprint(app);
    const beforeKeys = worldWireKeys(app.world);   // 独立见证①：直接从**活动世界**读连线
    const h0 = sha(JSON.stringify(before));

    const r = mod.assemble(app, p.id);
    const changed = sha(JSON.stringify(mod.snapshotWorld(app.world))) !== h0;
    const depthAfterAssemble = app.undo.depth;
    const u = mod.undoAssemble(app);
    const afterHash = sha(JSON.stringify(mod.snapshotWorld(app.world)));
    const afterVessel = vesselFingerprint(app);
    const afterKeys = worldWireKeys(app.world);    // 独立见证①的对照：撤销后从活动世界再读一次

    READINGS.undo = {
      preset: p.id, assembleOk: r.ok, undoOk: u.ok,
      depthAfterUser, depthAfterAssemble, depthAfterUndo: app.undo.depth,
      changedByAssemble: changed, hashBefore: h0.slice(0, 16), hashAfterUndo: afterHash.slice(0, 16),
      vesselBefore: beforeVessel, vesselAfterUndo: afterVessel,
      wireKeysBefore: beforeKeys, wireKeysAfterUndo: afterKeys,
      preEntities: before.entities.length, preWires: before.wires.length,
      restored: u.restored,
    };
    check('UNDO-BACK', r.ok && u.ok && changed && afterHash === h0,
      `组装确实换掉了场景（changed=${changed}），撤销后快照哈希逐位回到组装前（${afterHash === h0}）`);
    // ★ 独立交叉核：快照哈希两边是**同一个函数**算的，一致只说明自洽、不说明保真。
    //   容器状态必须走**另一条路**读（`VesselModel` 自己的 volume/temp/amount）才算独立。
    check('UNDO-BACK-CHEM', JSON.stringify(beforeVessel) === JSON.stringify(afterVessel) && beforeVessel.length > 0,
      `容器化学状态独立复核（${beforeVessel.length} 个容器）：${JSON.stringify(afterVessel)}`);
    // ★ 第二条独立见证：**连线**也必须回来。哈希那条看不见这里 ——
    //   快照函数若自己漏抄连线，前后两次哈希用的是**同一个漏抄的函数** ⇒ 自洽仍然绿
    //   （M2 实测 0 红，正是这个坑）。所以要直接从**活动世界**读连线逐条比对。
    check('UNDO-BACK-WIRES', beforeKeys.length > 0
      && JSON.stringify(beforeKeys.slice().sort()) === JSON.stringify(afterKeys.slice().sort()),
      `撤销后连线逐条回来（组装前 ${beforeKeys.length} 根）：${JSON.stringify(afterKeys)}`);
    check('UNDO-STACK-DEPTH', depthAfterUser > 0 && depthAfterAssemble === depthAfterUser
      && app.undo.depth === depthAfterUser,
      `组装与撤销组装都不入撤销栈（用户动作后 ${depthAfterUser} → 组装后 ${depthAfterAssemble} → 撤销后 ${app.undo.depth}）`);
  }

  HEAD('H. 边界：空白台面 / 未知 id / 没预置 / 没组装就撤销 —— 一律不抛错、给明确返回');
  {
    const app = makeApp(fac, presets);
    const empty = mod.assemble(app, presets[0].id);      // 空白台面上组装
    const emptyAfter = app.world.entities.length;
    const emptyUndo = mod.undoAssemble(app);             // 撤回空白
    const backToEmpty = app.world.entities.length;
    const unknown = mod.assemble(app, 'no-such-preset');
    const noUndo = mod.undoAssemble(app);                // 快照已被上一步消费掉
    const noPresets = mod.assemble(makeApp(fac, []), presets[0].id);
    READINGS.edges = {
      emptyOk: empty.ok, emptyAfter, emptyUndoOk: emptyUndo.ok, backToEmpty,
      unknown: unknown.reason, unknownHasList: Array.isArray(unknown.presets) && unknown.presets.length > 0,
      noUndo: noUndo.reason, noPresets: noPresets.reason,
    };
    check('EDGE-CASES',
      empty.ok === true && emptyAfter === declared.get(presets[0].id).ents
      && emptyUndo.ok === true && backToEmpty === 0
      && unknown.ok === false && unknown.reason === 'preset-not-found'
      && Array.isArray(unknown.presets) && unknown.presets.length > 0
      && noUndo.ok === false && noUndo.reason === 'no-preassemble'
      && noPresets.ok === false && noPresets.reason === 'no-presets',
      `空白台面组装 ${emptyAfter} 件 → 撤回 ${backToEmpty} 件；未知 id=${unknown.reason}；重复撤销=${noUndo.reason}；无预置=${noPresets.reason}`);
  }

  HEAD('I. 替身不漂 + 入口真接上 + 诚实命名（数值上看不见的那几类）');
  {
    const drifted = DRIFT_ANCHORS.concat(MAIN_ONLY_ANCHORS).filter((a) => !mainSrc.includes(a));
    check('DRIFT-ANCHORS', drifted.length === 0,
      `main.js 的 ${DRIFT_ANCHORS.length + MAIN_ONLY_ANCHORS.length} 条锚点原文全部还在（缺 = ${JSON.stringify(drifted)}）`);
    // 替身那侧也要有人守：`DRIFT_ANCHORS` 每条都必须以替身写法出现在**本探针源码**里
    // （替身里把 `this.` 写成 `app.`、把 `create(` 写成 `fac.create(` ⇒ 同一个变换后再比对）。
    const mirror = (a) => a.replace(/\bthis\./g, 'app.').replace(/\bcreate\(/g, 'fac.create(');
    const notMirrored = DRIFT_ANCHORS.map(mirror).filter((a) => !selfSrc.includes(a));
    check('DRIFT-STANDIN', notMirrored.length === 0,
      `替身逐字照抄（本探针源码里缺 = ${JSON.stringify(notMirrored)}）`);
    check('MAIN-COMPAT',
      /this\.assemble\(id\)/.test(mainSrc)
      && /assemble\(id\) \{ return assembleScene\(this, id\); \}/.test(mainSrc)
      && /undoAssemble\(\) \{ return undoAssembleScene\(this\); \}/.test(mainSrc)
      && /applySaveData\(data\) \{/.test(mainSrc)
      && (stripLineComments(mainSrc).match(/beginSilent\(\)/g) || []).length === 2,
      'main.js 入口确实改走 assemble；且「`beginSilent`+空括号」在 main.js 源码里仍恰好 2 次（tools/undo-probe.mjs 钉着这条）');
  }
  {
    // ★ 策略判据最容易写成"永远不会红"：词汇表之外还要求**否定语境**，
    //   否则被测文件里那句「它不是自动布线」会把自己弄红（拿注释举例串到自己 —— equipbar 踩过同款）。
    const bad = namingViolations(modSrc);
    check('HONEST-NAMING', bad.length === 0,
      `被测模块没有把「成套预设（含连线）」说成自动布线：违规 = ${JSON.stringify(bad)}`);
    // 同一条规矩必须也盖住**用户看得见的那一面**：入口的文案与 main.js 里的注释。
    // （入口 `<select>` 本体在 `src/plugins/ui.toolbar.js`，本项不许改它，但**读它**是应该的。）
    const uiBad = [];
    for (const rel of ['src/main.js', 'src/plugins/ui.toolbar.js']) {
      const src = norm(readFileSync(join(ROOT, rel), 'utf8'));
      for (const v of namingViolations(src)) uiBad.push(rel + ':' + v);
    }
    READINGS.naming = { module: bad, ui: uiBad };
    check('HONEST-NAMING-UI', uiBad.length === 0,
      `入口文案/main.js 也没这么写：违规 = ${JSON.stringify(uiBad)}`);
  }
}

/**
 * 诚实命名的机器守卫：挑出**未经否定**的「自动布线」类说法。
 * ★ 这条最容易写成"永远不会红"：词汇表之外还必须要求否定语境，
 *   否则文件里那句「它不是自动布线」会把它自己弄红（拿注释举例串到自己 —— equipbar 踩过同款）。
 * 红档证据：变异体 `M7-naming-claim` 把一句真话改成「本模块会…自动布线」⇒ 这条必须红
 * （实测 1 红、且只有它红）⇒ 它不是一个恒绿断言。
 */
function namingViolations(src) {
  const bad = [];
  const lines = String(src).split('\n');
  for (const term of ['自动布线', '自动连线', '自动连接', '自动接线', '智能连线', 'autoConnect', 'autoWire']) {
    lines.forEach((ln, i) => {
      if (!ln.includes(term)) return;
      const ctx = lines.slice(Math.max(0, i - 2), i + 1).join(' ');
      if (!/不是|不许|并非|无证据|0 命中|✗|不能|没有/.test(ctx)) bad.push(term + '@' + (i + 1));
    });
  }
  return bad;
}

// ── 替身漂移锚点：main.js 的原文（归一换行后必须逐条命中）──
// 注释只写符号名，不写行号。改动 main.js 里任何一条 ⇒ DRIFT-ANCHORS 红 ⇒ 回来同步替身
// （这才是"替身"能用的前提；否则替身绿什么都证明不了）。
const DRIFT_ANCHORS = [
  'this.world.clear();',
  'this.select(null);',
  'if (this.data) this.data.clear();',
  'this.coupling.links = [];',
  'this.coupling.branches = [];',
  'this._shortWarned = false;',
  'this.undo.beginSilent();',
  'try { this._applyScene(sc); } finally { this.undo.endSilent(); }',
  'const ent = create(o.type, o.x, o.y);',
  'if (o.props) for (const k of Object.keys(o.props)) ent.setProp(k, o.props[k]);',
  'if (o.state) Object.assign(ent.state, o.state);',
  'for (const [sid, mL] of (o.fill.liquid || [])) v.addLiquid(sid, mL);',
  'for (const [sid, g] of (o.fill.solid || [])) v.addSolid(sid, g);',
  'this.world.add(ent, true);',
  'this.world.connect({ e: a.id, p: w[1] }, { e: b.id, p: w[3] }, w[4]);',
  'ent.loadJSON(o);',
  'if (o.vessel && ent.vessel) ent.vessel.loadJSON(o.vessel);',
  'this.undo.runSilent(() => this._applySave(data));',
];

/** 只在 main.js 里成立、替身里没有对应物（替身不复制 `loadPreset`）—— 由 `MAIN-COMPAT` 守。 */
const MAIN_ONLY_ANCHORS = [
  'const r = this.assemble(id);',
  "localStorage.setItem('xiaomo.preset.v1', id);",
];

// ══════════════════════════════════════════════════════════
// 红档：变异体
// ══════════════════════════════════════════════════════════
/**
 * `file`：在**临时树**里被覆写的那一个文件（其余文件保持原样）。
 * `anchor` 必须在该文件里**恰好命中一次**；命中数 != 1 一律 `landInCode:false`（**不放松**这条）。
 * `expectRed`：**先由推理写死**的期望红集，元素可以是 `*` 通配；双向对齐（多了少了都算失败）。
 * 金丝雀（`canary:true`）必须真红 —— 它是「变异体到底有没有送到被测代码」的唯一硬证据。
 */
const MUTANTS = [
  {
    id: 'M0-canary',
    file: MODULE_REL,
    why: '金丝雀：删掉组装真正落地的那一步（app.loadScene(sc)）⇒ 必须真红。它不红 = 变异体根本没送到被测代码',
    anchor: '  app.loadScene(sc);\n',
    to: '  // app.loadScene(sc);  <- canary\n',
    canary: true,
    expectRed: ['ENTITY-COUNT-*', 'WIRE-COUNT-*', 'ENTITY-TYPES-*', 'CHEM-STATE', 'UNDO-BACK', 'EDGE-CASES'],
  },
  {
    id: 'M1-drop-wires',
    file: MODULE_REL,
    why: '「只摆器材、不接线」（plans/17 项⑤ 点名的头号假绿）⇒ 只杀得掉连线两条；**器材数仍必须绿**（证明两条都要有）',
    anchor: '  app.loadScene(sc);\n',
    to: '  app.loadScene({ entities: sc.entities, wires: [] });\n',
    expectRed: ['WIRE-COUNT-*', 'WIRE-ENDPOINTS-*'],
  },
  {
    id: 'M2-snapshot-drops-wires',
    file: MODULE_REL,
    why: '组装前的快照漏掉连线 ⇒ 撤销回来后线没了（只有哈希那条能杀：容器交叉核看不见线）',
    anchor: '    data.wires.push([a, w.a.p, b, w.b.p, w.kind]);\n',
    to: '    void a; void b;\n',
    expectRed: ['UNDO-BACK-WIRES'],
  },
  {
    id: 'M3-snapshot-after-load',
    file: MODULE_REL,
    why: '「组装前自动存一份」写成组装**之后**存 ⇒ 撤销等于什么都没撤（方案甲失效最隐蔽的形态）',
    anchor: '  MEM.set(app, before);\n',
    to: '  MEM.set(app, snapshotWorld(app.world));\n',
    // 连带红 EDGE-CASES / UNDO-BACK-WIRES 都是**实测**出来的、也都说得通：
    // 撤销回到的是"组装后"那份 ⇒ ① 「撤回空白台面」也回不去（它测的正是撤回真的回到组装前）；
    // ② 撤销后世界里的连线自然也不是组装前那些（这正是独立见证该看见的）。
    expectRed: ['UNDO-BACK', 'UNDO-BACK-CHEM', 'EDGE-CASES', 'UNDO-BACK-WIRES'],
  },
  {
    id: 'M4-no-snapshot',
    file: MODULE_REL,
    why: '方案甲整个没落地（内存与存档槽**两份**都不写）⇒ 撤销无从谈起。只删内存那一份是**测不出**的（存档槽会兜住），所以锚点必须同时盖住两处',
    anchor: '  MEM.set(app, before);\n\n  let stored = false;\n  const st = storageOf(app);\n  if (st && before) {\n    try { st.setItem(PREASSEMBLE_KEY, JSON.stringify(before)); stored = true; } catch (_) { stored = false; }\n  }\n',
    to: '  const stored = false;\n',
    // 同上：什么都没存 ⇒ 撤销是空操作 ⇒ 场景**原封不动**停在组装后那份上，
    // 于是「回到组装前」的三条见证（哈希 / 容器 / 连线）与「撤回空白」都会红。
    expectRed: ['UNDO-BACK', 'UNDO-BACK-CHEM', 'UNDO-BACK-WIRES', 'EDGE-CASES'],
  },
  {
    id: 'M5-append-not-replace',
    file: PROBE_REL,
    why: '「组装」退化成在当前场景上**追加**（plans/17 项⑤ 点名的真实缺陷：组装两次得两倍器材）—— 落地点是替身里的 loadScene',
    anchor: '      app._loads++;\n      app.world.clear();\n      app.select(null);\n',
    to: '      app._loads++;\n      app.select(null);\n',
    expectRed: ['ENTITY-COUNT-*', 'ENTITY-TYPES-*', 'WIRE-COUNT-*', 'WIRE-ENDPOINTS-*', 'IDEMPOTENT'],
  },
  {
    id: 'M6-classify-cross-as-physics',
    file: MODULE_REL,
    why: '归属分类退化成「理化同台的成套算纯物理」⇒ 项目最独特的那个标识被抹掉（按器材学科算的覆盖率照样成立 ⇒ 只有归属分类那条能杀）',
    anchor: "  if (has('physics') && has('chemistry')) return 'cross';\n",
    to: "  if (has('physics')) return 'physics';\n",
    expectRed: ['CLASS-GROUPS'],
  },
  {
    id: 'M7-naming-claim',
    file: MODULE_REL,
    why: '把「连线随预设数据一起落地」写成「本模块自动布线」⇒ 诚实命名判据必须红（否则那条判据永远不会红）',
    anchor: '//   连线来自预设数据**自带的** `wires`。它**不是**「自动布线 / 智能连线」：\n',
    to: '//   本模块在组装时会自动布线，把器材智能连线成一套装置。\n',
    expectRed: ['HONEST-NAMING'],
  },
  {
    id: 'M8-snapshot-drops-state',
    file: MODULE_REL,
    why: '快照不带走 `state` ⇒ 撤销回来的是一杯「看着一样、化学上已不是原来那杯」的水（容器靠 `serializeState` 才带得走）。★ 快照哈希两边用的是**同一个**快照函数 ⇒ 它自洽仍然绿，只有独立交叉核能杀',
    anchor: '    data.entities.push(e.toJSON());\n',
    to: '    const o = e.toJSON(); delete o.state; data.entities.push(o);\n',
    expectRed: ['UNDO-BACK-CHEM'],
  },
  {
    id: 'M9-physics-bucket-empty',
    file: MODULE_REL,
    why: '把「纯物理」这一档并进 cross ⇒ groups.physics 变空数组。'
      + '⚠ 它会**连带**弄红 CHEM-STATE，而且这是对的：纯物理成套一旦被归成 cross，'
      + '那条判据就会把它们当化学成套、要求容器里装液体 —— 顺带证明「归属分类」真的驱动着化学侧的交叉核。'
      + '⚠ CLASS-GROUPS 必须**保持绿**（cross≥1、classified 仍等于套数）——'
      + '那正是「上面那条判据看不见这个缺口」的实证，也就是本变异体存在的理由。',
    anchor: "  if (has('physics')) return 'physics';\n",
    to: "  if (has('physics')) return 'cross';\n",
    expectRed: ['CLASS-PHYSICS-PRESENT', 'CHEM-STATE'],
  },
];

function applyMutant(text, m) {
  const hits = text.split(m.anchor).length - 1;
  const out = hits === 1 ? text.replace(m.anchor, m.to) : text;
  return { out, hits, altered: hits === 1 && out !== text };
}

const TREE_FILES = ['src', PROBE_REL];

function seedTree(dir) {
  for (const rel of TREE_FILES) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    cpSync(join(ROOT, rel), join(dir, rel), { recursive: true });
  }
}

/**
 * 新进程跑一次判定。**退出码彻底不参与判据**：子进程可能因任何原因非零退出，
 * 它到底写没写、写了什么才算数。
 *
 * ⚠ 两条会让读数失真的坑（全队广播，`e-state` 实测发现），这里都堵死：
 *   ① **每个变异体一个全新判定文件**：复用同一个路径时，子进程若崩在写文件之前，
 *      父进程会读到**上一个变异体**留下的红集 —— 那是一个"特别合理"的假读数。
 *   ② **「缺失 ≠ 空」**：判定文件没写出来 / 不是 JSON / `reds` 不是数组 ⇒ 一律 `reds = null`，
 *      由调用方判 `infra`，**绝不许落成 `[]`**；否则期望 0 红的等价对照会把一次崩溃判成"全绿"。
 * 另外加了一层**回执**：父进程生成 nonce 传下去，子进程原样写回；对不上就说明这个文件
 * 不是本次子进程写的（残留/串台/伪造），同样判 infra。判定文件的相对路径与内容哈希逐行记下，
 * 好让"链路真的通了"这件事有物证。
 */
function runChild(dir, label) {
  const nonce = 'n' + Date.now().toString(36) + '-' + String(label).replace(/[^A-Za-z0-9_-]/g, '_');
  const jf = join(dir, '.judge.' + nonce + '.json');   // ★ 唯一路径，绝不复用
  try { rmSync(jf, { force: true }); } catch (_) { /* 本来就不存在 */ }
  let stderrTail = '';
  try {
    execFileSync(process.execPath, [join(dir, PROBE_REL), '--judge-json=' + jf, '--nonce=' + nonce], {
      cwd: dir, maxBuffer: 1 << 26, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    stderrTail = String((err && err.stderr) || (err && err.message) || '').split('\n').slice(-3).join(' | ').slice(0, 400);
  }
  const judgeFile = jf.slice(dir.length + 1);
  if (!existsSync(jf)) return { reds: null, judgeFile, judgeSha: null, missingReason: '子进程没写出判定文件（崩在写之前？）', stderrTail };
  const raw = readFileSync(jf, 'utf8');
  const judgeSha = sha(raw);
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch (e) {
    return { reds: null, judgeFile, judgeSha, missingReason: '判定文件不是 JSON：' + e.message, stderrTail };
  }
  if (parsed.nonce !== nonce) {
    return { reds: null, judgeFile, judgeSha, child: parsed, missingReason: '判定文件非本次子进程所写（nonce 不符）', stderrTail };
  }
  if (!Array.isArray(parsed.reds)) {
    return { reds: null, judgeFile, judgeSha, child: parsed, missingReason: '判定文件里 reds 不是数组（缺失 ≠ 空）', stderrTail };
  }
  return { reds: parsed.reds, child: parsed, judgeFile, judgeSha, stderrTail };
}

const globRe = (g) => new RegExp('^' + g.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');

async function mutateMode() {
  const green = await runJudge();
  const dir = resolve(process.env.TEMP || process.env.TMP || join(process.cwd(), '_scratch'), 'xm-assembly') + '-' + Date.now().toString(36);
  seedTree(dir);
  const pristine = {};
  for (const rel of [MODULE_REL, PROBE_REL]) pristine[rel] = norm(readFileSync(join(dir, rel), 'utf8'));

  const rows = [];
  for (const m of MUTANTS) {
    const { out, hits, altered } = applyMutant(pristine[m.file], m);
    const abs = join(dir, m.file);
    writeFileSync(abs, out);
    const changedOnDisk = sha(norm(readFileSync(abs, 'utf8'))) !== sha(pristine[m.file]);
    const landInCode = hits === 1 && altered && changedOnDisk;
    const run = runChild(dir, m.id);
    writeFileSync(abs, pristine[m.file]);   // 复原，供下一个变异体用

    const actual = run.reds;                       // ★ 缺失 = null，绝不落成 []
    const ok0 = actual !== null;
    const want = m.expectRed || [];
    const hit = (g) => ok0 && actual.some((id) => globRe(g).test(id));
    const missing = want.filter((g) => !hit(g));
    // 金丝雀只要求「声明的这些必须红」——它会连带红一片，那是正常的传染，不是缺陷。
    // 其余变异体要求**双向**对齐：既不许漏，也不许多（多出来的红 = 声明没想清楚）。
    const strayUncovered = (ok0 && !m.canary)
      ? actual.filter((id) => !want.some((g) => globRe(g).test(id))) : [];
    const redsAligned = ok0 && missing.length === 0 && (m.canary || strayUncovered.length === 0);
    rows.push({
      id: m.id, file: m.file, anchorHits: hits, landInCode, canary: !!m.canary,
      expectRed: want, actualReds: actual, actualRedCount: ok0 ? actual.length : null,
      redsAligned, strayUncovered, missing,
      judgeFile: run.judgeFile, judgeSha: run.judgeSha,
      childNoJSON: !ok0, childMissingReason: run.missingReason || undefined,
      childStderrTail: run.stderrTail || undefined,
      why: m.why,
    });
    INFO(`${m.id}: hits=${hits} land=${landInCode} reds=${ok0 ? actual.length : 'no-json'} aligned=${redsAligned}`);
  }

  // 反向自证：只动注释、语义为零 ⇒ 必须 0 红（否则"红"是天生自带的，整族对齐都没意义）
  const nullFrom = 'export const PREASSEMBLE_KEY';
  const nullText = pristine[MODULE_REL].replace(nullFrom, '// [null-mutant: 语义为零]\n' + nullFrom);
  writeFileSync(join(dir, MODULE_REL), nullText);
  const nullHits = pristine[MODULE_REL].split(nullFrom).length - 1;
  const nullRun = runChild(dir, 'null-noop');
  writeFileSync(join(dir, MODULE_REL), pristine[MODULE_REL]);
  const nullActual = nullRun.reds;                       // ★ 同上：缺失 = null ≠ []
  const nullOk = nullActual !== null;
  const nullMutant = {
    id: 'NULL-noop-comment', file: MODULE_REL, anchorHits: nullHits,
    landInCode: nullHits === 1 && nullOk, canary: false, expectRed: [],
    actualReds: nullActual, actualRedCount: nullOk ? nullActual.length : null,
    // 反向自证：必须**真读到 0 红**才算数 —— 崩溃/没写出文件一律不算（那是最隐蔽的钻空子）
    redsAligned: nullOk && nullActual.length === 0,
    strayUncovered: nullOk ? nullActual : [], missing: [],
    judgeFile: nullRun.judgeFile, judgeSha: nullRun.judgeSha,
    childNoJSON: !nullOk, childMissingReason: nullRun.missingReason || undefined,
    childStderrTail: nullRun.stderrTail || undefined,
    why: '反向自证：语义为零的改动必须一条都不红',
  };

  try { rmSync(dir, { recursive: true, force: true }); } catch (_) { /* 临时树残留不算失败 */ }

  const canary = rows.find((r) => r.canary);
  const infra = !canary || !canary.landInCode || !canary.redsAligned;
  const bad = rows.filter((r) => !r.landInCode || !r.redsAligned).map((r) => r.id);
  return {
    mode: 'mutate', items: RESULTS.length, pass: PASS, fail: FAIL, reds: reds(),
    greenBaseline: { items: green.items, pass: green.pass, fail: green.fail, reds: green.reds },
    mutants: rows, nullMutant, infra,
    infraWhy: infra ? '金丝雀没红（或没落码）⇒ 变异体没送到被测代码 ⇒ 整族红档空转，不许当通过' : null,
    badMutants: bad,
    aligned: !infra && bad.length === 0 && nullMutant.redsAligned,
    readings: READINGS,
  };
}

async function runJudge() {
  try {
    await main();
  } catch (err) {
    check('HARNESS-EXCEPTION', false, '判据执行体抛错：' + ((err && err.stack) || err));
  }
  return { mode: 'judge', items: RESULTS.length, pass: PASS, fail: FAIL, reds: reds(), readings: READINGS };
}

function emit(res) {
  // 回执：子进程把父进程给的 nonce 原样写回 ⇒ 父进程据此确认「这个文件是本次子进程写的」。
  if (res && typeof res === 'object') res.nonce = argOf('nonce', null);
  console.log('ASSEMBLY_JSON ' + JSON.stringify(res));
  if (JUDGE_JSON) { try { writeFileSync(JUDGE_JSON, JSON.stringify(res)); } catch (_) { /* 父进程会记 childNoJSON */ } }
}

if (MUTATE) {
  mutateMode().then(emit).catch((err) => emit({
    mode: 'mutate', infra: true, infraWhy: 'mutateMode 抛错: ' + (err && err.message),
    aligned: false, reds: reds(), mutationsRun: RESULTS.length,
  }));
} else {
  runJudge().then(emit).catch((err) => emit({
    mode: 'judge', items: RESULTS.length, pass: PASS, fail: FAIL, reds: reds(),
    harnessError: String(err && err.message),
  }));
}
