// ══════════════════════════════════════════════════════════
// 选中器材「就地控制条」的判据（被测：src/ui/equipbar.js）
//
// 裸跑      → 判据（绿档）；退出码既不是成功的判据，也不是失败的判据，看 JSON。
// --mutate  → 变异体自证：每个变异体必须①真的落进代码 ②红的是「点名的那几条」
//             （redsAligned）③其余断言一条都不许红（ctrlBad 0）。
// --root=<dir>  指定仓库根（默认本文件上一级）。
// --judge-json=<file>  内部用：把判定结果写进文件（给 --mutate 的子进程读，
//                      避免依赖 stdio 管道）。
//
// ── 真与替身边界（这段必须诚实，它决定结论的适用范围）──
// 真：① 坐标契约用**真 `Engine`** 实例（`src/core/engine.js`），不是重写公式；
//     ② 器材用**真注册表**（真 `PluginHost` 引导 + 真 `equipmentPlugins`），
//        `switch` 的 `toggle()`、容器的 `vessel.empty()` 都是真实现；
//     ③ 能力位用**真 `menuCaps`**（`src/equipment/caps.js`）。
// 替身：`app`（`main.js` 的 `class App` 不导出，`export default` 的实例要整棵
//     DOM 才建得起来）。替身里的 `select` / `duplicate` / `removeEntity` / `markDirty`
//     **逐字照抄** main.js 的真身，并由 `drift.standInMatchesMain` 守漂移 ——
//     真身一改，本探针立刻红，逼人回来同步（这才是「替身」能用的前提）。
//     真机部分见回报里的「必须真机/人眼验证清单」。
//
// ── 纪律 ──
// · 任何「拿磁盘字节匹配源码文本」的地方**先归一换行**：本仓 core.autocrlf=true、
//   .gitattributes 只钉 market/*，全新 Windows 检出里 src/ 与 tools/ 都是 CRLF，
//   不归一的多行锚点会命中 0 次、永久假红。
// · 注释只写符号名，不写行号（行号会被人加三行注释就冲掉）。
// ══════════════════════════════════════════════════════════
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const args = process.argv.slice(2);
const argOf = (name, d) => {
  const hit = args.find((a) => a.startsWith('--' + name + '='));
  return hit ? hit.slice(name.length + 3) : d;
};
const ROOT = path.resolve(argOf('root', path.join(path.dirname(fileURLToPath(import.meta.url)), '..')));
const SELF = fileURLToPath(import.meta.url);
const U = (rel) => pathToFileURL(path.join(ROOT, rel)).href;
const TARGET = 'src/ui/equipbar.js';
const TARGET_ABS = path.join(ROOT, TARGET);
const MAIN_ABS = path.join(ROOT, 'src/main.js');

/** 归一换行 —— 凡是要拿源码文本做匹配的，先过这里 */
const norm = (s) => String(s).replace(/\r\n/g, '\n');
/** 结构断言要测**代码**，不测散文：注释里写「不许出现 .zoom」不该算违规。
 *  （本探针第一版就是直接拿全文匹配，结果被我自己注释里那句举例子串到红 —— 那是
 *   「永远不会绿」的假红，和「永远不会红」一样坏。） */
const stripComments = (s) => String(s)
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
/** 与 src/ui/equipbar.js 里那个枢纽标记同一个 —— 判据要能看出「这是不是一层包装」 */
const HUB_SYM = Symbol.for('xiaomo.equipbar.selectHub');
/** 「点某个位」引起的调用次数（格式 `key:type:dup:rem:dirty:sync` 空格分隔）。
 *  **先量后钉**：值由本探针自己打印的实测给出，不许手算。 */
const SWAP_BASE = 'toggle:switch:0:0:1:1 ignite:alcohollamp:0:0:1:1 empty:beaker:0:0:1:1 duplicate:switch:1:0:1:2 remove:switch:0:1:1:2';

/** 真页面实测尺寸：Lead 用无头 Edge（1279×800 视口）量到控制条 `getBoundingClientRect()`
 *  = 116×38，两个按钮各 50×28。纯 Node 里 `offsetWidth/Height` 恒为 0 ⇒ 只能走兜底
 *  168×34 —— 所以兜底那一档证明的只是**算法自洽**，不是真实落位。两档都要跑。 */
const REAL_SIZE = { w: 116, h: 38 };
/** 尺寸表：每一式（默认右侧 / 放不下翻转 / 两侧都放不下夹取 / 顶边夹取）都在两档下成立 */
const SIZE_TABLE = [
  { name: 'fallback', w: 168, h: 34 },
  { name: 'real', w: REAL_SIZE.w, h: REAL_SIZE.h },
];
/** 「探针自钉」判据：真值写在**探针自己**里，不是被测模块里。
 *  指向探针自身的变异体（`file` 指自己）期望红节必须落在这一集里 —— 否则就是拿
 *  被测代码的红节去凑对齐，用错位的期望伪装成自证。由 `mutate.selfFileExpect` 守。 */
const SELF_PINS = ['anchor.realSize'];
const readNorm = (p) => norm(readFileSync(p, 'utf8'));
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

// ══════════════════════════════════════════════════════════
// 最小 DOM —— 只实现被测模块与引导路径真正用到的那部分
// ══════════════════════════════════════════════════════════
function makeStyle() {
  const o = { _p: {} };
  o.setProperty = (k, v) => { o._p[k] = String(v); };
  o.removeProperty = (k) => { delete o._p[k]; };
  o.getPropertyValue = (k) => (k in o._p ? o._p[k] : '');
  return o;
}

function makeEl(tag) {
  const el = {
    tagName: String(tag || '').toUpperCase(),
    children: [], parentNode: null, attributes: {}, dataset: {},
    style: makeStyle(), className: '', textContent: '', hidden: false, type: '',
    listeners: {}, offsetWidth: 0, offsetHeight: 0, clientWidth: 0, clientHeight: 0,
    innerHTML: '', value: '', checked: false, disabled: false, id: '',
  };
  const setOf = () => new Set(String(el.className).split(/\s+/).filter(Boolean));
  el.classList = {
    add(...cs) { const s = setOf(); cs.forEach((c) => s.add(c)); el.className = [...s].join(' '); },
    remove(...cs) { const s = setOf(); cs.forEach((c) => s.delete(c)); el.className = [...s].join(' '); },
    contains: (c) => setOf().has(c),
    toggle(c, on) { const has = setOf().has(c); const want = on === undefined ? !has : !!on; if (want) el.classList.add(c); else el.classList.remove(c); return want; },
  };
  el.appendChild = (c) => { c.parentNode = el; el.children.push(c); return c; };
  el.insertBefore = (c) => { c.parentNode = el; el.children.unshift(c); return c; };
  el.replaceChildren = (...cs) => { el.children = []; for (const c of cs) el.appendChild(c); };
  el.removeChild = (c) => { const i = el.children.indexOf(c); if (i >= 0) el.children.splice(i, 1); c.parentNode = null; return c; };
  el.remove = () => { if (el.parentNode) el.parentNode.removeChild(el); };
  el.setAttribute = (k, v) => { el.attributes[k] = String(v); };
  el.getAttribute = (k) => (k in el.attributes ? el.attributes[k] : null);
  el.removeAttribute = (k) => { delete el.attributes[k]; };
  el.hasAttribute = (k) => k in el.attributes;
  el.addEventListener = (t, fn) => { (el.listeners[t] = el.listeners[t] || []).push(fn); };
  el.removeEventListener = (t, fn) => { const a = el.listeners[t] || []; const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); };
  el.dispatch = (t, ev) => {
    const e = ev || { type: t, target: el, preventDefault() {}, stopPropagation() {}, clientX: 0, clientY: 0 };
    for (const fn of (el.listeners[t] || []).slice()) fn(e);
    return e;
  };
  el.querySelector = () => null;
  el.querySelectorAll = () => [];
  el.closest = () => null;
  el.getBoundingClientRect = () => ({ left: 0, top: 0, width: el.clientWidth, height: el.clientHeight, right: el.clientWidth, bottom: el.clientHeight, x: 0, y: 0 });
  el.getContext = null;
  return el;
}

function makeDoc() {
  const byId = new Map();
  const doc = {
    head: makeEl('head'), body: makeEl('body'), documentElement: makeEl('html'),
    createElement: (t) => makeEl(t),
    createElementNS: (_ns, t) => makeEl(t),
    createTextNode: (t) => { const e = makeEl('#text'); e.textContent = t; return e; },
    getElementById: (id) => byId.get(id) || null,
    querySelector: () => null, querySelectorAll: () => () => [],
    addEventListener: () => {}, removeEventListener: () => {},
  };
  doc.querySelectorAll = () => [];
  doc.addStage = (w, h) => {
    const s = makeEl('div'); s.id = 'stage'; s.clientWidth = w; s.clientHeight = h;
    byId.set('stage', s); doc.body.appendChild(s); return s;
  };
  return doc;
}

// ══════════════════════════════════════════════════════════
// 引导：真注册表 + 真 Engine
// ══════════════════════════════════════════════════════════
async function boot() {
  const { World } = await import(U('src/core/world.js'));
  const { PluginHost } = await import(U('src/core/plugin.js'));
  const { create, bindRegistry } = await import(U('src/equipment/registry.js'));
  const { equipmentPlugins } = await import(U('src/equipment/index.js'));
  const { Engine } = await import(U('src/core/engine.js'));
  const { menuCaps, CAP_KEYS, applyCap } = await import(U('src/equipment/caps.js'));
  const pick = async (p) => (await import(U(p))).default;

  const hostApp = {
    services: {}, ticks: [], world: null, selected: null,
    log: { push() {}, clear() {} }, toast() {}, addTick() { return () => {}; },
  };
  const host = new PluginHost(hostApp);
  for (const p of [
    await pick('src/physics/circuit.js'),
    await pick('src/chemistry/reactions.js'),
    await pick('src/coupling/bridge.js'),
    await pick('src/plugins/theme.mint.js'),
    await pick('src/plugins/theme.graphite.js'),
    ...equipmentPlugins,
    await pick('src/plugins/rules.damage.js'),
    await pick('src/plugins/system.credit.js'),
  ]) host.define(p);
  host.installAll();
  bindRegistry(host.registry('equipment'));
  return { World, Engine, create, reg: host.registry('equipment'), menuCaps, CAP_KEYS, applyCap };
}

/**
 * app 替身。四条方法与 main.js 的真身**逐字**一致（符号名见注释），
 * 由 drift.standInMatchesMain 守漂移。
 */
function makeApp(world, engine, create) {
  const app = {
    world, engine, selected: null, inspector: null, _dirty: false,
    toast() {},
    markDirty() { this._dirty = true; },                                   // main.js: markDirty
    select(ent) {                                                          // main.js: select
      if (this.selected) this.selected.selected = false;
      this.selected = ent;
      if (ent) ent.selected = true;
      if (this.inspector) this.inspector.show(ent);
    },
    duplicate(ent) {                                                       // main.js: duplicate
      const e2 = create(ent.type, ent.x + 46, ent.y + 46);
      if (!e2) return;
      Object.assign(e2.props, ent.props);
      this.world.add(e2);
      this.select(e2);
    },
    removeEntity(ent) {                                                    // main.js: removeEntity
      const name = ent && ent.def ? ent.def.name : '';
      this.world.remove(ent);
      if (this.selected === ent) this.select(null);
      this.toast('已删除 ' + name);
    },
  };
  return app;
}

/** 一个自足的场景：doc + 舞台 + 真 world + 真 engine + 替身 app + 已挂载的控制条 */
async function scenario(booted, opts = {}) {
  const { World, Engine, create, menuCaps } = booted;
  const doc = makeDoc();
  const stage = doc.addStage(opts.stageW || 900, opts.stageH || 600);
  const world = new World();
  const canvas = makeEl('canvas');
  canvas.getContext = () => makeStubCtx();
  const engine = new Engine(canvas, world);
  engine.w = opts.stageW || 900;
  engine.h = opts.stageH || 600;
  engine.zoom = opts.zoom === undefined ? 1 : opts.zoom;
  engine.pan.x = opts.panX || 0;
  engine.pan.y = opts.panY || 0;
  const app = makeApp(world, engine, create);
  const { EquipBar } = await import(U(TARGET));
  const bar = new EquipBar(app, { document: doc, size: opts.size || null });
  // 记下**包装之前**的 select：幂等/还原判据要拿它当基准（mount 之后 app.select 已经是包装）
  const rawSelect = app.select;
  bar.mount(stage);
  const mk = (type, x, y) => { const e = create(type, x, y); e.x = x; e.y = y; world.add(e); return e; };
  return { doc, stage, world, engine, app, bar, mk, menuCaps, create, EquipBar, rawSelect };
}

function makeStubCtx() {
  const noop = () => {};
  return {
    save: noop, restore: noop, translate: noop, scale: noop, rotate: noop, setTransform: noop,
    beginPath: noop, closePath: noop, moveTo: noop, lineTo: noop, arc: noop, rect: noop,
    roundRect: noop, fill: noop, stroke: noop, fillRect: noop, strokeRect: noop, clearRect: noop,
    fillText: noop, strokeText: noop, setLineDash: noop, clip: noop, drawImage: noop,
    measureText: () => ({ width: 0 }), createLinearGradient: () => ({ addColorStop: noop }),
    createRadialGradient: () => ({ addColorStop: noop }), getImageData: () => ({ data: [] }),
    putImageData: noop, createPattern: () => null,
  };
}

/** 点某个能力位的按钮（按**当前**已建好的那批按钮找，不缓存元素） */
function clickCap(bar, key) {
  const btn = bar.root.children.find((c) => c.dataset && c.dataset.cap === key);
  if (!btn) return false;
  btn.dispatch('click');
  return true;
}
const capKeysOf = (bar) => bar.root.children.map((c) => (c.dataset || {}).cap);

/**
 * 数一遍「点某个位」引起的调用次数。换用 caps.js 的 `applyCap` 之前**先量**，
 * 换完再拿同一把尺子量 —— 换接口的唯一目的是行为等价，不是顺手改行为。
 * 量四件事：`app.duplicate` / `app.removeEntity` / `app.markDirty` / `bar.sync`。
 * ⚠ `select` 与 `duplicate` 内部的 `select` 都会打一次 sync 通知，所以要先选中、
 *   再把计数归零，只数**点击这一下**引起的。
 */
async function countCaps(booted) {
  const CASES = [['toggle', 'switch'], ['ignite', 'alcohollamp'], ['empty', 'beaker'],
    ['duplicate', 'switch'], ['remove', 'switch']];
  const rows = [];
  for (const [key, type] of CASES) {
    const s = await scenario(booted);
    const c = { dup: 0, rem: 0, dirty: 0, sync: 0 };
    const dup0 = s.app.duplicate.bind(s.app);
    const rem0 = s.app.removeEntity.bind(s.app);
    s.app.duplicate = (e) => { c.dup++; return dup0(e); };
    s.app.removeEntity = (e) => { c.rem++; return rem0(e); };
    s.app.markDirty = () => { c.dirty++; };
    const sync0 = s.bar.sync.bind(s.bar);
    s.bar.sync = (...a) => { c.sync++; return sync0(...a); };
    const ent = s.mk(type, 400, 300);
    s.app.select(ent);                       // 建按钮会 sync 一次：不计入
    c.dup = 0; c.rem = 0; c.dirty = 0; c.sync = 0;
    clickCap(s.bar, key);
    rows.push([key, type, c.dup, c.rem, c.dirty, c.sync]);
    s.bar.dispose();
  }
  return rows;
}
const approx = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;

// ══════════════════════════════════════════════════════════
// 判据本体
// ══════════════════════════════════════════════════════════
async function judge() {
  const booted = await boot();
  const { Engine, menuCaps } = booted;
  const R = [];
  const ok = (id, pass, detail) => R.push({ id, pass: !!pass, detail: detail === undefined ? '' : String(detail) });

  // ───────── A. 坐标契约（真 Engine）─────────
  {
    const s = await scenario(booted, { zoom: 2, panX: -50, panY: 30 });
    const pts = [{ x: 140, y: -60 }, { x: 0, y: 0 }, { x: -333, y: 812 }];
    let worst = 0, worstFormula = 0;
    for (const p of pts) {
      const sc = s.bar.worldToScreen(p.x, p.y);
      const back = s.engine.screenToWorld(sc.x, sc.y);
      worst = Math.max(worst, Math.abs(back.x - p.x), Math.abs(back.y - p.y));
      // 与闭式解对照（闭式只在探针里算，模块里不许有）
      const fx = p.x * s.engine.zoom + s.engine.pan.x;
      const fy = p.y * s.engine.zoom + s.engine.pan.y;
      worstFormula = Math.max(worstFormula, Math.abs(sc.x - fx), Math.abs(sc.y - fy));
    }
    ok('coord.roundtrip', worst < 1e-9, 'worst_err=' + worst);
    ok('coord.matchesFormula', worstFormula < 1e-9, 'worst=' + worstFormula);
    s.bar.dispose();
  }
  {
    // 退化视口：换算返回非有限值时不许把 NaN 写进样式
    const bad = { engine: { screenToWorld: () => ({ x: NaN, y: NaN }) }, selected: null, world: { entities: [] } };
    const bar = new (booted.EquipBar || (await import(U(TARGET))).EquipBar)(bad, { document: null });
    const r = bar.worldToScreen(5, 6);
    ok('coord.degenerate', isFinite(r.x) && isFinite(r.y) && r.x === 5 && r.y === 6, JSON.stringify(r));
  }
  {
    // 结构性：模块必须**采样** screenToWorld，不许自己减 pan / 乘 zoom（第二真相源）。
    // 只测**代码**（剥掉注释），否则注释里举的这个例子本身就把它判红。
    const code = stripComments(readNorm(TARGET_ABS));
    const samples = code.includes('screenToWorld(1, 0)') && code.includes('screenToWorld(0, 1)');
    const noFormula = !/\.zoom\b/.test(code) && !/\.pan\b/.test(code);
    ok('coord.oneExit', samples && noFormula, 'samples=' + samples + ' noFormula=' + noFormula);
  }

  // ───────── B. 可见性 ─────────
  {
    const s = await scenario(booted);
    const sw = s.mk('switch', 400, 300);
    ok('vis.startsHidden', s.bar.root.hidden === true, 'hidden=' + s.bar.root.hidden);
    s.app.select(sw);
    ok('vis.showsOnSelect', s.bar.root.hidden === false && s.bar.root.children.length > 0,
      'hidden=' + s.bar.root.hidden + ' btns=' + s.bar.root.children.length);
    s.app.select(null);
    ok('vis.hidesOnDeselect', s.bar.root.hidden === true, 'hidden=' + s.bar.root.hidden);
    s.app.select(sw);
    s.app.removeEntity(sw);
    ok('vis.hidesOnDelete', s.bar.root.hidden === true && s.app.selected === null, 'hidden=' + s.bar.root.hidden);
    // 选中一件**不在世界里**的器材（等价于已被删除）
    const ghost = s.create('switch', 100, 100);
    s.app.selected = ghost;
    let threw = null;
    try { s.bar.sync(); } catch (e) { threw = String(e && e.message); }
    ok('vis.hidesOnForeign', s.bar.root.hidden === true && threw === null, 'hidden=' + s.bar.root.hidden + ' threw=' + threw);
    s.bar.dispose();
  }
  {
    // 换选中就重锚：同一个 bar 对象、两件不同位置的同类器材
    const s = await scenario(booted);
    const a = s.mk('switch', 200, 150);
    const b = s.mk('switch', 700, 480);
    s.app.select(a);
    const pa = { left: s.bar.root.style.left, top: s.bar.root.style.top, ent: s.bar.ent === a };
    s.app.select(b);
    const pb = { left: s.bar.root.style.left, top: s.bar.root.style.top, ent: s.bar.ent === b };
    ok('vis.reanchors', pa.ent && pb.ent && (pa.left !== pb.left || pa.top !== pb.top),
      JSON.stringify({ pa, pb }));
    ok('vis.reanchorMatchesTarget', pb.left === s.bar.place(s.bar.rectOf(b), s.bar.size).left + 'px',
      'left=' + pb.left);
    s.bar.dispose();
  }

  // ───────── C. 锚点规则（**每一式都在两个尺寸下成立**）─────────
  //
  // 尺寸从哪来：模块读自己的 offsetWidth/Height，纯 Node 里恒为 0 ⇒ 走兜底 168×34。
  // 兜底尺寸下算出来的锚点只能证明「算法自洽」，**不能**证明真实落位 —— 所以
  // SIZE_TABLE 的第二档 `real` 是真页面实测值，两档跑**同一批**不变式，并额外钉住
  // 「换尺寸锚点确实变了」（否则尺寸注入就是空转，等于把同一组数算了两遍）。
  //
  // 夹取那一支的**可达窗口**很窄（第一版判据就错在这）：
  // 「右侧放不下」要求 rect.right + GAP + 条宽 > 舞台宽 - EDGE，
  // 「左侧也放不下」要求 rect.left - GAP - 条宽 < EDGE。
  //  · 舞台 900 宽时要器材本身宽过 532px ⇒ 真器材永远够不着；
  //  · 舞台 320（手机宽）时两支都够得着，但器材**必须放中段** —— 贴右边缘时左侧
  //    反而有位置，那时的正确行为是**翻转**，不是夹取。
  //  ⇒ 位置由**实测外框反推**（下面 lo/hi），不写死坐标：写死了，换尺寸就会悄悄
  //    掉出窗口，而这一支要证明的恰恰是「两侧都放不下」这个状态。
  {
    const GAP = 10, EDGE = 6, STAGE_W = 320, STAGE_H = 600;
    const got = [];
    for (const sz of SIZE_TABLE) {
      const s = await scenario(booted, { stageW: 900, stageH: 600, size: sz });
      const row = { name: sz.name, w: sz.w, h: sz.h };
      const mid = s.mk('switch', 400, 300);
      s.app.select(mid);
      row.measW = s.bar.size.w;
      let rect = s.bar.rectOf(mid);
      row.rightDefault = s.bar.side === 'right'
        && s.bar.root.style.left === Math.round(rect.right + GAP) + 'px';

      const right = s.mk('switch', 875, 300);
      s.app.select(right);
      rect = s.bar.rectOf(right);
      row.flipLeft = Math.round(rect.left - GAP - s.bar.size.w);
      row.flip = s.bar.side === 'left' && s.bar.root.style.left === row.flipLeft + 'px';

      const top = s.mk('switch', 200, 5);
      s.app.select(top);
      const t = parseFloat(s.bar.root.style.top);
      row.vclamp = t >= EDGE && t <= STAGE_H - s.bar.size.h - EDGE;
      row.vtop = s.bar.root.style.top === EDGE + 'px';
      s.bar.dispose();

      const n = await scenario(booted, { stageW: STAGE_W, stageH: STAGE_H, size: sz });
      const wide = n.mk('switch', 0, 300);
      n.app.select(wide);
      const r0 = n.bar.rectOf(wide);
      const w0 = r0.right - r0.left;                       // 器材自身宽度：实测，不写死
      const lo = STAGE_W - 2 * EDGE - GAP - sz.w - w0 / 2; // 右侧放不下的下界
      const hi = 2 * EDGE + GAP + sz.w + w0 / 2;           // 左侧也放不下的上界
      wide.x = Math.round((lo + hi) / 2);
      wide.y = 300;
      n.app.select(wide); n.bar.sync();
      const l = parseFloat(n.bar.root.style.left);
      row.window = Math.round(lo) + '..' + Math.round(hi);
      row.clampLeft = n.bar.root.style.left;
      row.clamp = n.bar.side === 'clamp' && l >= EDGE && l <= STAGE_W - n.bar.size.w - EDGE;
      n.bar.dispose();
      got.push(row);
    }
    const brief = got.map((r) => r.name + '(' + r.w + '×' + r.h + '→实测' + r.measW + ')').join(' ');
    ok('anchor.rightDefault', got.every((r) => r.rightDefault), brief);
    ok('anchor.flipWhenNoRoom', got.every((r) => r.flip),
      brief + ' flipLeft=' + got.map((r) => r.flipLeft).join(','));
    ok('anchor.verticalClamp', got.every((r) => r.vclamp), brief);
    ok('anchor.verticalClampTopEdge', got.every((r) => r.vtop), brief);
    ok('anchor.clampWhenNoRoomEitherSide', got.every((r) => r.clamp),
      brief + ' 夹取窗口=' + got.map((r) => r.name + ':' + r.window).join(',')
      + ' clampLeft=' + got.map((r) => r.clampLeft).join(','));
    // 尺寸注入**不是空转**：换尺寸后锚点必须真的变（默认右侧那一式与条宽无关，
    // 所以钉「翻转侧」与「夹取值」——它们才依赖条宽）。
    const fb = got[0], re = got[1];
    ok('anchor.sizeAffects', re.measW !== fb.measW && re.flipLeft !== fb.flipLeft,
      '条宽 ' + fb.measW + '→' + re.measW + '  flipLeft ' + fb.flipLeft + '→' + re.flipLeft);
    // 真尺寸是**实测钉住**的（Lead 无头 Edge 1279×800）：谁改了它，先看这条为什么红
    ok('anchor.realSize', REAL_SIZE.w === 116 && REAL_SIZE.h === 38,
      'REAL_SIZE=' + REAL_SIZE.w + '×' + REAL_SIZE.h);
  }
  {
    // 缩放/平移之后锚点必须跟着器材的**屏幕**位置走（手算 pan 会当场错位）
    const s1 = await scenario(booted, { zoom: 1 });
    const e = s1.mk('switch', 400, 300);
    s1.app.select(e);
    const base = s1.bar.rectOf(e);
    s1.engine.zoom = 3; s1.engine.pan.x = -120; s1.engine.pan.y = 44;
    s1.bar.sync();
    const zoomed = s1.bar.rectOf(e);
    const cxOk = approx(zoomed.cx, e.x * 3 - 120, 1e-6);
    const cyOk = approx(zoomed.cy, e.y * 3 + 44, 1e-6);
    const grew = Math.abs(zoomed.w - base.w * 3) < 1e-6;
    ok('anchor.zoomFollows', cxOk && cyOk && grew,
      JSON.stringify({ cx: zoomed.cx, wantX: e.x * 3 - 120, w: zoomed.w, baseW: base.w }));
    s1.bar.dispose();
  }

  // ───────── D. 按钮作用对象 + 反串台 ─────────
  {
    const s = await scenario(booted);
    const sw = s.mk('switch', 400, 300);
    s.app.select(sw);
    const got = capKeysOf(s.bar);
    const want = ['toggle', 'duplicate', 'remove'];
    ok('caps.order', got.join(',') === want.join(','), 'got=' + got.join(','));
    const caps = menuCaps(sw);
    ok('caps.fromMenuCaps', caps.toggle === true && caps.duplicate === true && caps.remove === true,
      JSON.stringify(caps));
    // 容器：empty 位；热源：ignite 位
    const bk = s.mk('beaker', 100, 100);
    s.app.select(bk);
    // 能力位必须**逐位**对上，不能用 includes 判 —— includes 在「按钮多建了」时照样为真，
    // 那就是一条永远不会红的断言（本探针第一版正是这么写的，被 caps-ignore-hidden 变异体逮到）
    ok('caps.vesselHasEmpty', capKeysOf(s.bar).join(',') === 'empty,duplicate,remove', capKeysOf(s.bar).join(','));
    const lamp = s.mk('alcohollamp', 200, 100);
    s.app.select(lamp);
    ok('caps.flameHasIgnite', capKeysOf(s.bar).join(',') === 'ignite,duplicate,remove', capKeysOf(s.bar).join(','));
    const rs = s.mk('resistor', 300, 100);
    s.app.select(rs);
    ok('caps.plainHasOnlyDefaults', capKeysOf(s.bar).join(',') === 'duplicate,remove', capKeysOf(s.bar).join(','));
    s.bar.dispose();
  }
  {
    // ★ 反串台：两件同类器材各自选中时，动作与浮层对象都不许串
    const s = await scenario(booted);
    const A = s.mk('switch', 300, 200); A.props.closed = true;
    const B = s.mk('switch', 300, 420); B.props.closed = true;
    s.app.select(A);
    const entA = s.bar.ent === A;
    clickCap(s.bar, 'toggle');
    const afterA = { a: A.props.closed, b: B.props.closed };
    s.app.select(B);
    const entB = s.bar.ent === B;
    const btnRefChanged = s.bar.root.children.length > 0;
    clickCap(s.bar, 'toggle');
    const afterB = { a: A.props.closed, b: B.props.closed };
    ok('cross.twoSameType',
      entA && entB && btnRefChanged
      && afterA.a === false && afterA.b === true      // 第一次只动了 A
      && afterB.a === false && afterB.b === false,    // 第二次只动了 B
      JSON.stringify({ entA, entB, afterA, afterB }));
    ok('cross.distinctTargets', A !== B && s.bar.ent === B, 'bar.ent===B:' + (s.bar.ent === B));
    s.bar.dispose();
  }
  {
    // ★ 动作对象是「打开浮层时那件器材」，不是点击瞬间的 app.selected
    const s = await scenario(booted);
    const A = s.mk('switch', 300, 200); A.props.closed = true;
    const B = s.mk('switch', 300, 420); B.props.closed = true;
    s.app.select(A);
    s.app.selected = B;                 // 绕过 select：程序侧把选中改成另一件
    clickCap(s.bar, 'toggle');
    ok('cross.actsOnCaptured', B.props.closed === true, 'B.closed=' + B.props.closed);
    ok('cross.staleRefused', A.props.closed === true, 'A.closed=' + A.props.closed);
    s.bar.dispose();
  }
  {
    // ★ 选中被置空 / 目标被删除 ⇒ 不动手、不抛错
    const s = await scenario(booted);
    const A = s.mk('switch', 300, 200); A.props.closed = true;
    s.app.select(A);
    s.app.selected = null;
    let threw = null;
    try { clickCap(s.bar, 'toggle'); } catch (e) { threw = String(e && e.message); }
    ok('cross.nullSelected', A.props.closed === true && threw === null && s.bar.root.hidden === true,
      'A.closed=' + A.props.closed + ' threw=' + threw + ' hidden=' + s.bar.root.hidden);

    const s2 = await scenario(booted);
    const C = s2.mk('switch', 300, 200); C.props.closed = true;
    s2.app.select(C);
    s2.world.remove(C);                 // 绕过 removeEntity：世界里删了但选中还指着它
    threw = null;
    try { clickCap(s2.bar, 'toggle'); } catch (e) { threw = String(e && e.message); }
    ok('cross.deletedTarget', C.props.closed === true && threw === null && s2.bar.root.hidden === true,
      'C.closed=' + C.props.closed + ' threw=' + threw + ' hidden=' + s2.bar.root.hidden);
    s.bar.dispose(); s2.bar.dispose();
  }
  {
    // 复制：main.js 的 duplicate 会把选中改到副本上 ⇒ 浮层必须重锚到副本
    const s = await scenario(booted);
    const A = s.mk('switch', 300, 200); A.props.closed = false;
    s.app.select(A);
    const n = s.world.entities.length;
    clickCap(s.bar, 'duplicate');
    const copy = s.app.selected;
    ok('dup.reselectsCopy',
      s.world.entities.length === n + 1 && copy !== A && copy.type === 'switch'
      && s.bar.ent === copy && s.bar.root.hidden === false,
      'n=' + s.world.entities.length + ' barEntIsCopy=' + (s.bar.ent === copy));
    ok('dup.copiesProps', copy.props.closed === false, JSON.stringify(copy.props));
    s.bar.dispose();
  }

  // ───────── E. 幂等 / 拆除 ─────────
  {
    const s = await scenario(booted);
    const origSelect = s.rawSelect;      // 包装之前的那个 select（见 scenario）
    const created = { wrapCountAfterSecond: null, sameHub: null };

    const b1 = s.bar;
    const root1 = b1.root;
    const A = s.mk('switch', 300, 200);
    s.app.select(A);
    const n1 = b1.notices;                                  // 期望 1

    b1.dispose();
    const restored = s.app.select === origSelect;
    const leftover = s.stage.children.indexOf(root1) >= 0;

    const A2 = s.mk('switch', 500, 200);
    s.app.select(A2);                                       // 卸载后：不该再有通知打到 b1
    const n1b = b1.notices;                                 // 期望仍是 1

    const b2 = new s.EquipBar(s.app, { document: s.doc });
    b2.mount(s.stage);
    const B = s.mk('switch', 300, 420);
    s.app.select(B);
    const n2 = b2.notices;                                  // 期望 1（不是 2）

    const { selectHub } = await import(U(TARGET));
    const selHub = selectHub(s.app);
    created.sameHub = selHub === selectHub(s.app);
    // 单层：枢纽的「原函数」必须还是**包装之前**那个 ⇒ 证明 select 上没有叠第二层
    ok('hub.singleLayer', selHub.orig === s.rawSelect && !selHub.orig[HUB_SYM],
      'origIsRaw=' + (selHub.orig === s.rawSelect));

    ok('hub.idempotent', n1 === 1 && n1b === 1 && n2 === 1, JSON.stringify({ n1, n1b, n2 }));
    ok('hub.restored', restored === true, 'restored=' + restored);
    ok('hub.noLeftoverDom', leftover === false, 'leftover=' + leftover);
    ok('hub.noLeakAfterDispose', b1.root === null && b1._unsub === null && b1._overlay === null,
      JSON.stringify({ root: b1.root === null, unsub: b1._unsub === null, ov: b1._overlay === null }));
    ok('hub.sameHub', created.sameHub === true, 'sameHub=' + created.sameHub);

    // 两枚浮层同时活着：一次选中各自恰好 1 次通知
    const n2a = b2.notices;
    s.app.select(A2);
    ok('hub.oneNotifyPerSubscriber', b2.notices - n2a === 1, 'delta=' + (b2.notices - n2a));

    let threw = null;
    try { b2.dispose(); b2.dispose(); } catch (e) { threw = String(e && e.message); }
    ok('hub.disposeIdempotent', threw === null, 'threw=' + threw);
    ok('hub.restoredAfterAll', s.app.select === origSelect, 'restored=' + (s.app.select === origSelect));
  }
  {
    // 渲染钩子：进了 engine.overlays 且在 dispose 时摘掉（否则拖动时会打到已销毁的浮层）
    const s = await scenario(booted);
    ok('hook.registered', s.engine.overlays.length === 1, 'n=' + s.engine.overlays.length);
    const e = s.mk('switch', 400, 300);
    s.app.select(e);
    s.engine.pan.x = 33;                                    // 模拟视口变化
    let threw = null;
    try { for (const fn of s.engine.overlays.slice()) fn(makeStubCtx(), s.engine); } catch (err) { threw = String(err && err.message); }
    ok('hook.safeToCall', threw === null, 'threw=' + threw);
    s.bar.dispose();
    ok('hook.unregistered', s.engine.overlays.length === 0, 'n=' + s.engine.overlays.length);
  }

  // ───────── F. 边界态不抛错 ─────────
  {
    const s = await scenario(booted);
    // ⚠ 必须**先让它真的浮出来**再改脏：否则 hidden 恒为 true，这两条就是「永远不会红」的假断言
    //   （本探针第一版正是这么写的，被 vis-no-hide-on-empty 变异体逮到 —— 它当时没红）
    const real = s.mk('switch', 400, 300);
    s.app.select(real);
    const shown = s.bar.root.hidden === false;

    let threw = null;
    try { s.app.selected = { nonsense: true }; s.bar.sync(); } catch (e) { threw = String(e && e.message); }
    ok('edge.nonEntitySelected', shown && threw === null && s.bar.root.hidden === true,
      'shown=' + shown + ' threw=' + threw + ' hidden=' + s.bar.root.hidden);

    s.app.select(real);
    const shown2 = s.bar.root.hidden === false;
    threw = null;
    try { s.app.selected = []; s.bar.sync(); } catch (e) { threw = String(e && e.message); }
    ok('edge.arraySelected', shown2 && threw === null && s.bar.root.hidden === true,
      'shown2=' + shown2 + ' threw=' + threw + ' hidden=' + s.bar.root.hidden);
    s.bar.dispose();
  }
  {
    // 没有 #stage / 没有 document：不抛错、不半挂
    const { EquipBar } = await import(U(TARGET));
    const doc2 = makeDoc();
    const world = new booted.World();
    const app2 = makeApp(world, { screenToWorld: (x, y) => ({ x, y }), overlays: [] }, booted.create);
    let threw = null;
    let bar = null;
    try { bar = new EquipBar(app2, { document: doc2 }); bar.mount(); } catch (e) { threw = String(e && e.message); }
    ok('edge.noStage', threw === null && bar.root === null, 'threw=' + threw);
    threw = null;
    try { bar.sync(); bar.dispose(); } catch (e) { threw = String(e && e.message); }
    ok('edge.noStageSyncSafe', threw === null, 'threw=' + threw);
    threw = null;
    try { const b = new EquipBar(app2, {}); b.mount(); b.sync(); b.dispose(); } catch (e) { threw = String(e && e.message); }
    ok('edge.noDocument', threw === null, 'threw=' + threw);
  }

  // ───────── G. 可辨识文本 / 无障碍 / D32 ─────────
  {
    const s = await scenario(booted);
    const sw = s.mk('switch', 400, 300);
    s.app.select(sw);
    const btns = s.bar.root.children;
    const allText = btns.every((b) => String(b.textContent || '').trim().length > 0);
    const allAria = btns.every((b) => String(b.getAttribute('aria-label') || '').trim().length > 0);
    const fromCapKeys = btns.every((b) => {
      const k = (b.dataset || {}).cap;
      return b.getAttribute('aria-label') === booted.CAP_KEYS[k];
    });
    ok('a11y.label', allText && allAria && fromCapKeys,
      JSON.stringify({ allText, allAria, fromCapKeys, labels: btns.map((b) => b.textContent) }));
    ok('a11y.realButtons', btns.every((b) => b.tagName === 'BUTTON' && b.type === 'button'),
      btns.map((b) => b.tagName).join(','));
    ok('a11y.toolbar', s.bar.root.getAttribute('role') === 'toolbar'
      && String(s.bar.root.getAttribute('aria-label') || '').length > 0,
      s.bar.root.getAttribute('role') + '/' + s.bar.root.getAttribute('aria-label'));
    s.bar.dispose();
  }
  {
    // D32：本控件的最小尺寸只在这里声明一次，且看得见的尺寸改动挂 pointer: coarse
    const s = await scenario(booted);
    const css = norm(s.bar._styleEl ? s.bar._styleEl.textContent : '');
    const minHits = (css.match(/min-height/g) || []).length;
    const coarseBlock = css.match(/@media \(pointer: coarse\)\{([^}]*)\}/);
    const baseRule = css.slice(0, css.indexOf('@media'));
    ok('style.minTapOnce',
      minHits === 1 && !!coarseBlock && /min-height/.test(coarseBlock[1]) && !/min-height/.test(baseRule),
      'minHits=' + minHits + ' inCoarse=' + (!!coarseBlock && /min-height/.test(coarseBlock[1])));
    ok('style.reusesTokens',
      /var\(--radius/.test(css) && /var\(--border\)/.test(css) && /var\(--shadow\)/.test(css),
      'tokens_ok');
    ok('style.zIndexBelowDrawer',
      /z-index:12/.test(css) && Number((css.match(/z-index:(\d+)/) || [])[1]) < 25,
      (css.match(/z-index:(\d+)/) || [])[0]);
    // 结构断言：容器**放行**指针事件、按钮**收回**。
    // 为什么只能这么守：容器吃不吃指针事件，不影响任何坐标或计数读数 ——
    // 它属「数值路径上看不见」的退化（同类先例见 coord.oneExit 与 hub.singleLayer），
    // 只有读样式文本看得出来。不加这条，将来谁把 pointer-events 删掉都不会红。
    const containerPass = /\.xm-equipbar\{[^}]*pointer-events:none/.test(css);
    const btnCatches = /\.xm-equipbar \.btn\{[^}]*pointer-events:auto/.test(css);
    ok('style.gapsPassThrough', containerPass && btnCatches,
      'containerNone=' + containerPass + ' btnAuto=' + btnCatches);
    s.bar.dispose();
  }

  // ───────── H. 替身漂移守卫（拿磁盘字节匹配源码文本 ⇒ 先归一换行）─────────
  {
    const main = readNorm(MAIN_ABS);
    const anchors = [
      'if (this.selected) this.selected.selected = false;',
      'this.selected = ent;',
      'if (ent) ent.selected = true;',
      'markDirty() { this._dirty = true; }',
      'const e2 = create(ent.type, ent.x + 46, ent.y + 46);',
      'Object.assign(e2.props, ent.props);',
      'this.world.remove(ent);',
      'if (this.selected === ent) this.select(null);',
    ];
    const missing = anchors.filter((a) => !main.includes(a));
    ok('drift.standInMatchesMain', missing.length === 0, 'missing=' + JSON.stringify(missing));
  }

  // ───────── J. 「位为真、原语却不在」：先证可达性，再钉契约 ─────────
  //
  // 换 `applyCap` 之前，旧代码对**所有**位都无条件 markDirty；新代码只在 acted 时补那一笔。
  // 唯一能看出差别的状态是「位为真、原语却不在」—— 旧代码照样动手（或直接抛），
  // 新代码返回 false 且什么都不做。这是**推理**出来的差异 —— 推理不是实测，所以分两步：
  //  ① 全量扫注册表：每个器材的每个**为真的位**，都必须在该实例上找得到对应原语。
  //     全过 ⇒ 那个状态在真器材上**不可达** ⇒ 差异只是契约边界，不是行为回归。
  //     扫出反例 ⇒ 停手报 Lead：那是能力位表的洞，是真缺陷，不是等价性问题。
  //  ② 用替身把不可达状态**显式造出来**，把新旧差异钉成期望（返回 false + 一个 markDirty 都不发）。
  // 注意①必须测**实例**而不是注册表里的定义：位可以来自中央表，定义本身没有 `vessel`，
  // 拿定义去测会造出一片假反例。
  {
    const raw = (booted.reg && booted.reg.list) ? booted.reg.list() : null;
    const defs = Array.isArray(raw) ? raw
      : (raw && typeof raw[Symbol.iterator] === 'function' ? [...raw] : []);
    const holes = [];
    let checked = 0, noId = 0, noInstance = [];
    for (const d of defs) {
      const id = d && (d.type || d.id || d.slug || d.name);
      if (!id) { noId++; continue; }
      let e = null;
      try { e = booted.create(id, 0, 0); } catch { e = null; }
      if (!e) { noInstance.push(id); continue; }
      checked++;
      const caps = booted.menuCaps(e);
      const missing = [];
      if (caps.toggle && typeof e.toggle !== 'function') missing.push('toggle');
      if (caps.ignite && !e.props) missing.push('ignite');
      if (caps.empty && !(e.vessel && typeof e.vessel.empty === 'function')) missing.push('empty');
      if (missing.length) holes.push(id + '→' + missing.join('+'));
    }
    ok('reach.bitImpliesPrimitive', checked > 0 && holes.length === 0,
      '扫了 ' + checked + '/' + defs.length + ' 件实例（无 id ' + noId
      + '，建不出实例 ' + noInstance.length + '） 反例=' + JSON.stringify(holes));
  }
  {
    const s = await scenario(booted);
    let dirty = 0;
    s.app.markDirty = () => { dirty++; };
    // 三个位各造一个替身：位仍为真（位子来自中央表/legacy，不读原语），原语已被拿掉
    const cases = [
      ['switch', 'toggle', (e) => { e.toggle = null; }],
      ['alcohollamp', 'ignite', (e) => { e.props = null; }],
      ['beaker', 'empty', (e) => { e.vessel = null; }],
    ];
    const lines = [];
    let premise = true, direct = true, quiet = true;
    for (const [type, key, breakIt] of cases) {
      const e = s.mk(type, 400, 300);
      breakIt(e);
      if (!s.menuCaps(e)[key]) {   // 前提：位**仍然为真**，否则这条测的是别的东西
        premise = false; lines.push(type + ':' + key + ' 位不为真(前提破)'); continue;
      }
      const before = dirty;
      const ret = booted.applyCap(s.app, e, key);   // ① 直接调：必须返回 false
      const d1 = dirty - before;
      s.app.select(e);                              // ② 走调用点：选中它、按它的按钮
      let acted = null, threw = null;
      try { acted = s.bar.onCapClick(e, key); } catch (err) { threw = String(err && err.message); }
      const d2 = dirty - before - d1;
      if (ret !== false || acted !== false) direct = false;
      if (d1 !== 0 || d2 !== 0 || threw) quiet = false;
      lines.push(type + ':' + key + ' 位=1 返回=' + ret + ' 调用点返回=' + acted
        + ' 直调dirty=' + d1 + ' 调用点dirty=' + d2 + (threw ? ' 抛=' + threw : ''));
      s.app.select(null);
    }
    s.bar.dispose();
    ok('edge.bitWithoutPrimitive', premise && direct && quiet,
      lines.join(' | ') + ' ‖ 旧实现此处会抛(toggle/ignite)或多发 1 次 markDirty(empty)，'
      + '该差异已由等价性变异体 swap-old-inline-body 实测钉住；'
      + '该状态被 reach.bitImpliesPrimitive 全量排除');
  }

  // ───────── 变异体表的静态自检（元判据）─────────
  {
    // 允许的「探针自钉」期望：SELF_PINS（真值在探针里）+ 元判据本身（`mutate.*`）。
    // 后者是必需的：守这条规则的那个变异体（`self-expect-misplaced`）也只能指向探针自己，
    // 它的期望就是元判据 —— 不把元判据放行，规则会把自己的守卫判红。
    const allowed = (e) => SELF_PINS.includes(e) || e.startsWith('mutate.');
    const offenders = MUTANTS
      .filter((m) => m.file && !(m.expect || []).some(allowed))
      .map((m) => m.id);
    ok('mutate.selfFileExpect', offenders.length === 0, 'offenders=' + JSON.stringify(offenders));
  }

  // ───────── I. 换接口前后行为等价（先量后钉）─────────
  {
    const rows = await countCaps(booted);
    const shape = rows.map((r) => r.join(':')).join(' ');
    ok('swap.behaviourEqual', SWAP_BASE !== null && shape === SWAP_BASE,
      'measured=' + shape + (SWAP_BASE === null ? '  <-- 钉它' : ''));
  }

  const fails = R.filter((r) => !r.pass);
  return {
    ok: fails.length === 0,
    total: R.length,
    pass: R.length - fails.length,
    fail: fails.length,
    fails: fails.map((r) => r.id),
    results: R,
  };
}

// ══════════════════════════════════════════════════════════
// 变异体
// ══════════════════════════════════════════════════════════
const MUTANTS = [
  {
    id: 'anchor-no-flip',
    why: '右侧放不下时不翻到左侧',
    from: "      const flipped = rect.left - GAP - w;\n      if (flipped >= EDGE) { left = flipped; side = 'left'; }\n      else { left = Math.max(EDGE, Math.min(left, stageW - w - EDGE)); side = 'clamp'; }",
    to: "      left = Math.max(EDGE, Math.min(left, stageW - w - EDGE)); side = 'clamp';",
    expect: ['anchor.flipWhenNoRoom'],
  },
  {
    id: 'anchor-no-clamp',
    why: '两侧都放不下时不夹取',
    from: "      else { left = Math.max(EDGE, Math.min(left, stageW - w - EDGE)); side = 'clamp'; }",
    to: "      else { side = 'clamp'; }",
    expect: ['anchor.clampWhenNoRoomEitherSide'],
  },
  {
    id: 'anchor-no-vclamp',
    why: '竖直方向不夹取',
    from: '    if (stageH) top = Math.max(EDGE, Math.min(top, stageH - h - EDGE));',
    to: '    if (stageH) top = top;',
    expect: ['anchor.verticalClamp', 'anchor.verticalClampTopEdge'],
  },
  {
    id: 'guard-off',
    why: '拿掉身份守卫（选中被移走也照点）',
    from: '    if (app.selected !== target) { this.hide(); return false; }',
    to: '    if (false) { this.hide(); return false; }',
    // 实测：守卫没了以后，「选中为 null 时点击」也会照着旧目标动手 ⇒ 那条也一起红
    expect: ['cross.staleRefused', 'cross.nullSelected'],
  },
  {
    id: 'act-on-live-selected',
    why: '改动作对象为「点击瞬间的 app.selected」（正是要防的串台）',
    from: '    if (app.selected !== target) { this.hide(); return false; }',
    to: '    target = app.selected || target;',
    expect: ['cross.actsOnCaptured', 'cross.nullSelected'],
  },
  {
    id: 'hub-double-wrap',
    why: '取消「已包过就复用」⇒ 第二次 setup 叠第二层',
    from: '  if (cur && cur[HUB]) return cur[HUB];         // 已包过 ⇒ 复用，绝不叠第二层',
    to: '  if (false) return cur[HUB];',
    // 实测：叠层不改变「一次选中一次通知」的计数（第一枚浮层拆干净了才挂第二枚），
    // 它改变的是**层的结构** —— 枢纽不再唯一、原函数也不再是包装前那个。
    expect: ['hub.sameHub', 'hub.restoredAfterAll', 'hub.singleLayer'],
  },
  {
    id: 'hub-no-restore',
    why: '最后一个订阅者走了也不还原 app.select',
    from: '      if (subs.size === 0 && app.select === wrapped) app.select = orig;',
    to: '      if (false) app.select = orig;',
    expect: ['hub.restored', 'hub.restoredAfterAll'],
  },
  {
    id: 'coord-degenerate-guard',
    why: '退化视口不兜底 ⇒ NaN 进样式',
    from: '    if (!isFinite(dx) || !isFinite(dy) || dx === 0 || dy === 0) return { x: wx, y: wy };',
    to: '    if (false) return { x: wx, y: wy };',
    expect: ['coord.degenerate'],
  },
  {
    id: 'coord-copy-formula',
    why: '重写 w*zoom+pan —— 今天算出来的数一样，只有结构性断言杀得死它',
    from: '    const o = eng.screenToWorld(0, 0);',
    to: '    return { x: wx * eng.zoom + (eng.pan || {}).x, y: wy * eng.zoom + (eng.pan || {}).y };\n    const o = eng.screenToWorld(0, 0);',
    // 实测：真引擎上 roundtrip / matchesFormula **照样绿**（数值逐位相同）——
    // 杀死它的是结构性断言 coord.oneExit，以及退化视口那条（没有 pan/zoom 时出 NaN）。
    expect: ['coord.oneExit', 'coord.degenerate'],
  },
  {
    id: 'vis-no-hide-on-empty',
    why: '未选中 / 目标不在世界里时不收起',
    from: '    if (!ent || !alive) { this.hide(); return this; }',
    to: '    if (!ent || !alive) { return this; }',
    expect: ['vis.hidesOnDeselect', 'vis.hidesOnDelete', 'vis.hidesOnForeign',
      'edge.nonEntitySelected', 'edge.arraySelected'],
  },
  {
    id: 'hub-notify-twice',
    why: '一次选中发两次通知（订阅表被重复加入）',
    from: '    this._unsub = hub.add(() => { this.notices++; this.sync(); });',
    to: '    hub.add(() => { this.notices++; });\n    this._unsub = hub.add(() => { this.notices++; this.sync(); });',
    // 实测：多出来的那个订阅者不仅让计数翻倍，还把拆干净时的「还原」一起弄坏了
    // （dispose 只退掉一个订阅 ⇒ 订阅表非空 ⇒ 不还原），这两条必须一起红
    expect: ['hub.idempotent', 'hub.oneNotifyPerSubscriber', 'hub.restored', 'hub.restoredAfterAll'],
  },
  {
    id: 'vis-no-sync-on-select',
    why: '选中变更不再同步浮层（主路径断开 ⇒ 大面积红是预期的）',
    from: '    this._unsub = hub.add(() => { this.notices++; this.sync(); });',
    to: '    this._unsub = hub.add(() => { this.notices++; });',
    // 实测钉住：这一支断的是主路径，红面大是它的性质，不是判据松
    expect: ['vis.showsOnSelect', 'vis.reanchors', 'vis.reanchorMatchesTarget',
      'anchor.rightDefault', 'anchor.flipWhenNoRoom', 'anchor.verticalClamp',
      'anchor.verticalClampTopEdge',
      // 实测修正：块 C 改成「位置由实测外框反推 + 显式 sync」之后，这一支不再连带
      // 把夹取那一式打红 ⇒ 按实测删掉（expect 必须是**测出来的**红集）
      'caps.order', 'caps.vesselHasEmpty', 'caps.flameHasIgnite', 'caps.plainHasOnlyDefaults',
      'cross.twoSameType', 'cross.distinctTargets', 'dup.reselectsCopy',
      // swap.behaviourEqual 也数 bar.sync 的次数；这一支断了「选中即同步」，
      // 计数当然就变了 ⇒ 按实测补进来（expect 必须是**测出来的**红集，不是想出来的）
      'swap.behaviourEqual',
      'edge.nonEntitySelected', 'edge.arraySelected'],
  },
  {
    id: 'style-eats-pointer',
    why: '容器吃指针事件（它盖住/挨着的接线柱就点不中了）',
    from: "      '.xm-equipbar{position:absolute; z-index:12; pointer-events:none; display:flex; gap:6px; align-items:center;',",
    to: "      '.xm-equipbar{position:absolute; z-index:12; display:flex; gap:6px; align-items:center;',",
    expect: ['style.gapsPassThrough'],
  },
  {
    id: 'style-buttons-dead',
    why: '按钮自己也放行指针事件 ⇒ 整条控制条点不动（另一半）',
    from: "      '.xm-equipbar .btn{pointer-events:auto; touch-action:manipulation}',",
    to: "      '.xm-equipbar .btn{pointer-events:none; touch-action:manipulation}',",
    expect: ['style.gapsPassThrough'],
  },
  {
    id: 'swap-old-inline-body',
    why: '★ 等价性变异体：把换掉的那几行**原样放回来** ⇒ 必须一条断言都不红（红就说明换接口改了行为）',
    from: '    const acted = applyCap(app, target, key);\n    if (acted) this.afterCap(key);',
    to: '    const acted = (function () {\n'
      + '      switch (key) {\n'
      + "        case 'toggle': target.toggle(); break;\n"
      + "        case 'ignite': target.props.lit = !target.props.lit; break;\n"
      + "        case 'empty': if (target.vessel && target.vessel.empty) target.vessel.empty(); break;\n"
      + "        case 'duplicate': app.duplicate(target); break;\n"
      + "        case 'remove': app.removeEntity(target); break;\n"
      + '        default: return false;\n'
      + '      }\n'
      + '      if (app.markDirty) app.markDirty();\n'
      + '      return true;\n'
      + '    })();',
    // ★ 期望红集**只有一条**：`edge.bitWithoutPrimitive`（实测，不是推理 —— 见下方 block J）。
    // 那条断言显式造出「位为真、原语却不在」的状态：旧实现此时会**抛**（toggle/ignite，
    // `target.toggle()` / `target.props.lit=` 撞上 null）或**多发一次 markDirty**（empty 那支
    // 有 `vessel &&` 守卫，不抛，但末尾那句无条件 markDirty 照样发）。
    // 新实现返回 false 且什么都不做 ⇒ 这是新旧**唯一**可见的差异。
    // 该状态被能力位表排除（`reach.bitImpliesPrimitive` 全量扫过 ⇒ 真器材不可达），
    // 所以不是行为回归。除这一条外，其余断言一条都不许红。
    expect: ['edge.bitWithoutPrimitive'],
  },
  {
    id: 'swap-drop-callsite-dirty',
    why: '换接口时丢掉调用点补的那一笔 markDirty（= task-21 报的那处漂移）',
    from: '    if (key === \'duplicate\' || key === \'remove\') this.app.markDirty();',
    to: '    if (false) this.app.markDirty();',
    expect: ['swap.behaviourEqual'],
  },
  {
    id: 'swap-pass-refresh',
    why: '把第 4 个参数接成 sync ⇒ 一次点击重绘两遍（计数变了）',
    from: '    const acted = applyCap(app, target, key);',
    to: '    const acted = applyCap(app, target, key, () => this.sync());',
    expect: ['swap.behaviourEqual'],
  },
  {
    id: 'size-inject-nop',
    why: '尺寸注入变成空操作 ⇒ 真尺寸那一档白跑（两档其实算同一组数）',
    from: '    if (this.forced && this.forced.w > 0 && this.forced.h > 0) return this.size;',
    to: '    if (false) return this.size;',
    expect: ['anchor.sizeAffects'],
  },
  {
    id: 'size-real-drift',
    why: '真页面实测尺寸被改动（116×38 是量出来的，不许凭印象改）',
    file: 'tools/equipbar-probe.mjs',
    // `from` 拆成两段拼接：若与自身描述文本逐字相同，会**自己匹配到自己**（hits=2 ⇒ land=false）。
    from: 'const REAL_SIZE = ' + '{ w: 116, h: 38 };',
    to: 'const REAL_SIZE = { w: 120, h: 38 };',
    expect: ['anchor.realSize'],
  },
  {
    id: 'cap-no-primitive-dirty',
    why: '原语缺失时也照发 markDirty（= 旧代码那句无条件 markDirty 在这个不可达状态上的差异）',
    from: '    if (acted) this.afterCap(key);',
    to: '    this.afterCap(key); if (!acted) app.markDirty();',
    expect: ['edge.bitWithoutPrimitive'],
  },
  {
    id: 'self-expect-misplaced',
    why: '把指向探针自身的变异体的期望换成被测代码的红节（用错位的期望凑对齐）',
    file: 'tools/equipbar-probe.mjs',
    // 同样要拆开：否则这个 `from` 自己就含着一份，`hits=2`
    from: '    expect: ' + "['anchor.realSize'],",
    to: "    expect: ['style.gapsPassThrough'],",
    expect: ['mutate.selfFileExpect'],
  },
  {
    id: 'caps-ignore-hidden',
    why: '不看能力位，所有按钮都建（菜单项不再由器材声明）',
    from: '      if (!caps[key]) continue;',
    to: '      if (false) continue;',
    expect: ['caps.order', 'caps.vesselHasEmpty', 'caps.flameHasIgnite', 'caps.plainHasOnlyDefaults'],
  },
];

async function runJudgeToFile(outFile) {
  const r = await judge();
  writeFileSync(outFile, JSON.stringify(r), 'utf8');
  return r;
}

function mutate() {
  const original = readFileSync(TARGET_ABS);
  const originalSha = sha(TARGET_ABS);
  // 变异体可以指向**探针自身**（`file`）⇒ 探针自己也要有同一套「跑完逐位还原」的保证，
  // 否则「改探针自己的常量」会变成一条悄悄改夹具的通道。
  const selfAbs = path.resolve(SELF);
  const selfSha0 = sha(selfAbs);
  const rows = [];
  // 临时文件放**仓库外**：变异体跑的时候会写判定 JSON，放进仓库会让 git status 多出未跟踪项
  const tmpDir = path.join(os.tmpdir(), 'equipbar-probe');
  try { mkdirSync(tmpDir, { recursive: true }); } catch { /* 已存在 */ }
  const outFile = path.join(tmpDir, 'judge.json');
  try {
    for (const m of MUTANTS) {
      // 变异体默认打在被测模块上；`file` 可指向别的文件 —— 例如**探针自己**里钉住的
      // 实测常数（真页面量到的 116×38）。没有这一条，「钉在探针里的真值」就没人守：
      // 谁把它改成凭印象的数字，判据会跟着一起漂、却不会红。
      const fileAbs = m.file ? path.join(ROOT, m.file) : TARGET_ABS;
      const base = readFileSync(fileAbs);
      const baseSha = sha(fileAbs);
      const src = norm(base.toString('utf8'));
      const hits = src.split(m.from).length - 1;
      const landInCode = hits === 1;
      let reds = null, judgeOk = null, err = null;
      if (landInCode) {
        writeFileSync(fileAbs, src.replace(m.from, m.to), 'utf8');
        try {
          execFileSync(process.execPath, [SELF, '--root=' + ROOT, '--judge-json=' + outFile],
            { stdio: 'ignore', cwd: ROOT });
          const j = JSON.parse(readFileSync(outFile, 'utf8'));
          reds = j.fails;
          judgeOk = j.ok;
        } catch (e) { err = String(e && e.message).slice(0, 200); }
        finally {
          // 无条件还原：失败路径也必须把文件放回去
          writeFileSync(fileAbs, base);
        }
      }
      const restoredOk = sha(fileAbs) === baseSha;
      const redsArr = reds || [];
      const ctrlBad = redsArr.filter((r) => !m.expect.includes(r));
      const redsAligned = Array.isArray(reds) && m.expect.every((e) => redsArr.includes(e)) && ctrlBad.length === 0;
      rows.push({
        id: m.id, why: m.why, file: m.file || TARGET, landInCode, hits, err,
        expect: m.expect, reds: redsArr, redsAligned, ctrlBad, judgeOk, restoredOk,
        ok: landInCode && restoredOk && !err && redsAligned,
      });
    }
  } finally {
    if (sha(TARGET_ABS) !== originalSha) writeFileSync(TARGET_ABS, original);
  }
  const bad = rows.filter((r) => !r.ok);
  return {
    ok: bad.length === 0,
    mode: 'mutate',
    target: TARGET,
    targetSha: originalSha,
    restored: sha(TARGET_ABS) === originalSha,
    selfSha: sha(selfAbs),
    selfRestored: sha(selfAbs) === selfSha0,
    total: rows.length,
    green: rows.length - bad.length,
    red: bad.length,
    bad: bad.map((r) => r.id),
    mutants: rows,
  };
}

// ─────────────────────────────────────────────────────────
/** 本仓惯例：末尾印一行紧凑、无空格的机器可读 JSON（跨行 pretty JSON 钉不了多字段子串）。
 *  绿档红档都印 —— 红档没有机器可读输出，总网就只能靠退出码猜。 */
const emit = (o) => console.log('EQUIPBAR_JSON ' + JSON.stringify(o));

const judgeJson = argOf('judge-json', null);
if (judgeJson) {
  const r = await runJudgeToFile(judgeJson);
  emit({ total: r.total, pass: r.pass, fail: r.fail, mutate: false });
} else if (args.includes('--mutate')) {
  const r = mutate();
  console.log(JSON.stringify(r, null, 2));
  emit({ total: r.total, pass: r.green, fail: r.red, mutate: true });
  if (!r.ok) process.exitCode = 1;
} else {
  const r = await judge();
  console.log(JSON.stringify({ target: TARGET, targetSha: sha(TARGET_ABS), ...r }, null, 2));
  emit({ total: r.total, pass: r.pass, fail: r.fail, mutate: false });
  if (!r.ok) process.exitCode = 1;
}
