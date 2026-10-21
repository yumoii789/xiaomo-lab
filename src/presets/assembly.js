// ══════════════════════════════════════════════════════════
// 一键组装 · 成套预设（含连线）
//
// ⚠ 诚实命名（硬要求，不要改这个措辞）：本模块落地的是「**成套预设（含连线）**」——
//   连线来自预设数据**自带的** `wires`。它**不是**「自动布线 / 智能连线」：
//   组装过程里没有任何算法去决定「哪根线接哪里」。
//   依据：NB 两个 umi 包 + 两个编辑器按 `自动连线|自动连接|autoConnect|autoWire|自动接线`
//   检索 **0 命中**（plans/17 项⑤ 台账 T9）⇒ 「NB 有自动布线」无证据，
//   唯一能说的是「连线随快照数据一起还原」。**代码注释与 UI 文案都不许写成自动布线。**
//
// ── 撤销方案：选 **(甲)** 组装前自动把当前场景存一份，「撤销组装」= 载回那一份 ──
// 为什么不选 (乙)（把组装改成可撤销，新增 `OP_KINDS` 条目 + 逆动作 = 恢复旧场景快照）：
//   `undo.js` 的 `OP_KINDS.load` 明确写着 `reversible: false`，理由是「一次载入 = 整个世界
//   换掉，撤销它没有唯一的目标状态」；而且载入本来就被 `beginSilent()` 包住，刻意不产生
//   上百条历史条目。把它改成可逆会在撤销栈里塞进「整场景」级别的条目，去挤 `limit = 100`
//   —— 那是**改产品语义**，不是修产品缺陷。
// 为什么不选 (丙)（组装前强制确认，照 NB 的 `是否组装` + `将清空当前场景中的所有操作`）：
//   成本最低，但**仍然回不去**，只是把责任推给用户；它解决不了「组装前手搭的丢了」。
// (甲) 同时解决「组装错了」与「组装前手搭的丢了」，且**不动撤销栈语义** ⇒ 本模块实现它。
//
// ── 分层（为什么这个文件不依赖 DOM）──
// 所有协作方由 `app` 注入：`world` / `undo` / `select` / `data` / `loadScene` / `applySaveData`
// / `storage`。于是探针能在纯 Node 里跑**真模块**（而不是把逻辑抄进探针再自称测过）。
// `src/main.js` 的 `class App` 顶层建 DOM 宿主，无头环境里根本实例化不了（`tools/undo-probe.mjs`
// 已记过这条），这也是「逻辑放模块、main.js 只留薄委托」的另一个理由。
//
// 注释只写符号名，不写行号（行号会被人加三行注释就冲掉）。
// ══════════════════════════════════════════════════════════

import { get } from '../equipment/registry.js';

/** 组装前那份快照的存档槽。与用户自己的存档（`xiaomo.scene.v1`）**分开** ——
 *  一键组装绝不能覆盖用户主动保存的场景。 */
export const PREASSEMBLE_KEY = 'xiaomo.preassemble.v1';

/** app → 快照。内存优先（快、且不受隐私模式 localStorage 抛错影响）；
 *  localStorage 只为「刷新后还能撤回来」活着。用 WeakMap 而不是往 app 上挂字段。 */
const MEM = new WeakMap();

export const DOMAIN_LABEL = Object.freeze({
  physics: '物理', chemistry: '化学', bridge: '跨域', unknown: '未知',
});

/** 器材 type → 学科。取自**注册表**（`entity.domain` 也是这么来的：`get domain() { return this.def.domain }`），
 *  不再维护第二份名单 —— 两份名单迟早漂移。 */
export function domainOfType(type) {
  const d = get(type);
  return (d && d.domain) || 'unknown';
}

/** 一套预设里各学科的器材**件数**（按预设自己声明的 entities 算，不按名单猜） */
export function presetDomains(p) {
  const sc = (p && typeof p.build === 'function') ? p.build() : null;
  const tally = {};
  for (const o of (sc && sc.entities) || []) {
    const d = domainOfType(o.type);
    tally[d] = (tally[d] || 0) + 1;
  }
  return tally;
}

/** 一套预设的归属：单一学科；理化都有 ⇒ `cross`（本项目刻意做的跨学科装置）。 */
export function presetClass(p) {
  const t = presetDomains(p);
  const has = (d) => (t[d] || 0) > 0;
  if (has('physics') && has('chemistry')) return 'cross';
  if (has('physics')) return 'physics';
  if (has('chemistry')) return 'chemistry';
  return 'unknown';
}

/** 按归属分组（未来入口 UI 分组用；探针用它断言「物理/化学各至少一套」）。 */
export function groupPresets(list) {
  const g = { physics: [], chemistry: [], cross: [], unknown: [] };
  for (const p of list || []) g[presetClass(p)].push(p);
  return g;
}

/**
 * 把**当前世界**存成一份存档数据。形状与 `App.save()` 逐字同源
 * （`{v,entities,wires}`，连线用**下标**引用器材）—— 漂移由探针的 `drift.*` 锚点守。
 *
 * ⚠ 为什么快照必须是「存档」而不是「场景（type/x/y/props/fill）」：
 * 化学容器的状态远不止液面 —— `VesselModel` 还有 `mol/solid/gas/precip/temp/stir/color`
 * （`vessel.js` 的字段清单），而 `_applyScene()` 只认 `fill.liquid` / `fill.solid`。
 * 用场景形状做快照会**静默丢掉**溶解态、气体、沉淀与温度 ⇒ 「撤销组装」回来的是一杯
 * 看着一样、化学上已经不是原来那杯的水。只有 `toJSON()/loadJSON()` 这条路是完整的。
 *
 * 容器为什么**不用**再单独抄一份：带容器的器材自己就实现了 `serializeState()`
 * （`glassware.js` / `labware.js` / `thermal.js` 各一处，返回 `vessel.toJSON()`），
 * 而 `entity.toJSON()` 会把它放进 `state`、`loadJSON()` 再经 `deserializeState()` 灌回容器
 * ⇒ `state` 已经把容器带全了。
 * 这条是**实测**出来的、不是推断：原先快照里额外抄了一份容器，把那一行删掉时探针**一条都不红**
 * （`tools/assembly-probe.mjs` 的 M8）⇒ 那行是死代码，删掉才对。
 */
export function snapshotWorld(world) {
  if (!world) return null;
  const idx = new Map();
  const data = { v: 2, entities: [], wires: [] };
  (world.entities || []).forEach((e, i) => {
    idx.set(e.id, i);
    data.entities.push(e.toJSON());
  });
  for (const w of (world.wires || [])) {
    const a = idx.get(w.a.e);
    const b = idx.get(w.b.e);
    if (a === undefined || b === undefined) continue;
    data.wires.push([a, w.a.p, b, w.b.p, w.kind]);
  }
  return data;
}

/** 取注入的存储：`app.storage` 优先（探针用它注入假存储），否则全局 `localStorage`。
 *  没有存储（纯 Node 且没注入）不算错误 —— 内存那一份照样能撤回本次组装。 */
export function storageOf(app) {
  const s = app && app.storage;
  if (s) return s;
  try { return (typeof localStorage !== 'undefined') ? localStorage : null; } catch (_) { return null; }
}

export function preAssembleOf(app) {
  const mem = MEM.get(app);
  if (mem) return mem;
  const st = storageOf(app);
  if (!st) return null;
  try {
    const raw = st.getItem(PREASSEMBLE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (_) { return null; }
}

export function hasPreAssemble(app) { return !!preAssembleOf(app); }

/**
 * 一键组装：①把当前场景存一份 ②换成该套预设（含连线）。
 * @returns {{ok:boolean, reason?:string, id?:string, name?:string, hint?:string, klass?:string,
 *            declared?:{entities:number,wires:number}, after?:{entities:number,wires:number},
 *            saved?:{entities:number,wires:number}, stored?:boolean, presets?:string[]}}
 * 失败一律**返回**明确原因，不抛错（当前面板里没有 try/catch 的调用点）。
 */
export function assemble(app, id) {
  if (!app || !app.world) return { ok: false, reason: 'no-app' };
  const list = (app.services && app.services.presets) || [];
  if (!list.length) return { ok: false, reason: 'no-presets' };
  const p = list.find((x) => x && x.id === id);
  if (!p) return { ok: false, reason: 'preset-not-found', id, presets: list.map((x) => x.id) };
  if (typeof p.build !== 'function') return { ok: false, reason: 'preset-has-no-build', id };
  if (typeof app.loadScene !== 'function') return { ok: false, reason: 'no-load-scene' };

  const before = snapshotWorld(app.world);
  const sc = p.build();
  app.loadScene(sc);
  MEM.set(app, before);

  let stored = false;
  const st = storageOf(app);
  if (st && before) {
    try { st.setItem(PREASSEMBLE_KEY, JSON.stringify(before)); stored = true; } catch (_) { stored = false; }
  }

  return {
    ok: true,
    id: p.id,
    name: p.name,
    hint: p.hint,
    klass: presetClass(p),
    declared: { entities: (sc.entities || []).length, wires: (sc.wires || []).length },
    after: { entities: (app.world.entities || []).length, wires: (app.world.wires || []).length },
    saved: { entities: (before && before.entities || []).length, wires: (before && before.wires || []).length },
    stored,
  };
}

/**
 * 「撤销组装」：把组装前那份快照载回世界。
 * 走 `app.applySaveData()` —— 与 `App.load()` 同一落地形状（存档形状必须用 `loadJSON` 恢复，
 * 见 `snapshotWorld` 的理由），因此**不动** `loadScene` 那条场景路径。
 */
export function undoAssemble(app) {
  if (!app || !app.world) return { ok: false, reason: 'no-app' };
  const data = preAssembleOf(app);
  if (!data) return { ok: false, reason: 'no-preassemble' };
  if (typeof app.applySaveData !== 'function') return { ok: false, reason: 'no-apply-save' };
  app.applySaveData(data);
  MEM.delete(app);
  try { const st = storageOf(app); if (st) st.removeItem(PREASSEMBLE_KEY); } catch (_) { /* 存储不可用不算失败 */ }
  return {
    ok: true,
    restored: { entities: (data.entities || []).length, wires: (data.wires || []).length },
    after: { entities: (app.world.entities || []).length, wires: (app.world.wires || []).length },
  };
}
