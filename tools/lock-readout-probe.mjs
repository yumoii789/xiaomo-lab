#!/usr/bin/env node
// ══════════════════════════════════════════════════════════
// tools/lock-readout-probe.mjs —— task-26 判据（逐件锁定/固定 + 逐件就地读数）
//
// 依据：plans/17-第二批五项-接缝图.md 的 项①（逐件锁定）与 项②（逐件显示读数）六栏。
//
// 判据（先立后改；每节都要有「会假绿」的对照）：
//   ① 锁定后**整段拖动序列**不改变该件位置（逐位），而**未锁定的对照件**位置照旧改变
//      ⇒ 证明判据不是「本来就拖不动」才绿；外加「锁定态不产生 onEntityMoved」（撤销栈不增）。
//   ② 解锁后同一段序列恢复可拖（走的是 DOM 那条路：readout.toggleLock ⇒ applyCap）。
//   ③ 锁定状态**逐件独立**：两件同类器材，锁一件不动另一件；虚线框只画在锁定件上。
//   ④ 读数取的是**该件自己的** `def.stats`：两件同类读数不同，且每行文本**逐字**出现在
//      真实 `Inspector.render()` 的输出里（两处口径不许漂）；结构上不许自己写格式化。
//   ⑤ 读数在移动 / 缩放（zoom 已上线）后仍锚在器材下沿，且字号不随缩放变。
//   ⑥ 边界：没有 `def.stats` 的器材不抛错、不显示空框。
//   ⑦ 存档持久性（**甲案：扩白名单**）+ 拖动入口的**次序**结构断言 + 能力位接线。
//   ⑧ 相邻读数的**避让**：交叠场景两套外框（与行矩形）不相交 · 单件逐位不变（真的指令序列）·
//      20 件挤在同一点时撞上限**不死循环/不抛错**。反面照妖镜是 `{ avoid: false }`：
//      同一个场景关掉避让**确实交叠** ⇒ 「不重叠」不是本来就成立的假绿。
//
// 用法：
//   node tools/lock-readout-probe.mjs              # 绿档
//   node tools/lock-readout-probe.mjs --mutate     # 红档：每个变异体必须打红**指定**那几节
// 绿：全部通过：N 项（exit 0）／红：合计 N 项，失败 M 项（exit 1）／基础设施不可用：exit 2
// ══════════════════════════════════════════════════════════
import { readFileSync, existsSync, mkdirSync, cpSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// ⚠ 不用裸 `os.tmpdir()`：本沙箱里它可能返回**相对**路径（镜像/字节副本会落到工作目录之外）。
//   `resolve` 把相对值、undefined 一并钉成绝对（承接 lead 的全队广播）。
const TMP = resolve(process.env.TEMP || process.env.TMP || join(process.cwd(), '_scratch'), 'xm-lock-readout');
const MUTATE = process.argv.includes('--mutate');
const VERBOSE = process.argv.includes('--verbose') || !MUTATE;

/** 判据要盯的文件（变异前后逐字节比对，证明只动了镜像、没动仓库） */
const TOUCHED = ['src/core/entity.js', 'src/equipment/caps.js', 'src/ui/interact.js', 'src/ui/readout.js'];
/** 拖动序列的采样点数（≥2 才能证明「整段序列」而不是一次赋值） */
const DRAG_STEPS = 4;
/** 读数层的锚点间距：与 src/ui/readout.js 的 GAP 同步（判据不猜，改一处就该红） */
const GAP = 4;
/** 交叠场景里让两套读数重起来的像素数（≥1 才有真冲突；位置由**实测**外框宽度推出） */
const OV = 8;

// ── 小工具 ────────────────────────────────────────────────
const norm = (s) => String(s).replace(/\r\n/g, '\n');
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const codeOf = (root, rel) => norm(readFileSync(join(root, rel), 'utf8'));
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}
const countIn = (src, needle) => stripComments(src).split(needle).length - 1;
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ── 环境替身 ──────────────────────────────────────────────
let RAFQ = [];
let NOW = 0;
const COARSE = { matches: false, addEventListener() {}, addListener() {}, removeEventListener() {} };
const NMQ = { matches: false, addEventListener() {}, addListener() {}, removeEventListener() {} };
const WIN = {
  innerWidth: 1280, innerHeight: 800, devicePixelRatio: 1,
  matchMedia: (q) => (q === '(pointer: coarse)' ? COARSE : NMQ),
  _ev: {}, addEventListener(t, fn) { (WIN._ev[t] ||= []).push(fn); }, removeEventListener() {},
};
globalThis.window = WIN;
globalThis.performance = { now: () => NOW };
/** rAF 可冲刷：settleTo 的落定与 onEntityMoved 的时机都要能被确定性推进（不靠真时钟） */
globalThis.requestAnimationFrame = (fn) => { RAFQ.push(fn); return RAFQ.length; };
globalThis.cancelAnimationFrame = (id) => { if (id > 0) RAFQ[id - 1] = null; };
function flushRaf(total = 400, steps = 8) {
  for (let i = 0; i < steps; i++) {
    NOW += total / steps;
    const q = RAFQ; RAFQ = [];
    for (const f of q) if (typeof f === 'function') f();
  }
}

/** 最小 DOM 替身：够 Readout 与 Inspector 用（记录监听器，便于模拟点击与走查行文本） */
function mkEl(tag) {
  return {
    tagName: tag, className: '', textContent: '', children: [], hidden: false, type: '', style: {},
    dataset: {}, attrs: {}, _lis: {},
    appendChild(n) { n.parentNode = this; this.children.push(n); return n; },
    removeChild(n) { const i = this.children.indexOf(n); if (i >= 0) this.children.splice(i, 1); return n; },
    replaceChildren(...ns) { this.children = []; for (const n of ns) if (n) this.appendChild(n); },
    setAttribute(k, v) { this.attrs[k] = v; },
    getAttribute(k) { return this.attrs[k] === undefined ? null : this.attrs[k]; },
    addEventListener(t, fn) { (this._lis[t] ||= []).push(fn); },
    removeEventListener() {},
    /** 探针专用：模拟一次点击 */
    fire(t) { for (const fn of this._lis[t] || []) fn({ type: t, preventDefault() {}, stopPropagation() {} }); },
    querySelector: () => null,
  };
}
globalThis.document = { createElement: mkEl, createDocumentFragment: () => mkEl('#fragment'), querySelector: () => null };

/**
 * 记录型 2D 上下文：跟着 translate/scale/save/restore 走。
 * `fillText` 额外记第 5 项 = **当时的累计缩放** ⇒ 「屏幕字号不随缩放变」才可判（1 就是没变）。
 */
function mkG(trace) {
  const M = { x: 0, y: 0, s: 1 };
  const stack = [];
  const ctx = {
    canvas: null,
    save() { stack.push({ ...M }); },
    restore() { const m = stack.pop(); if (m) { M.x = m.x; M.y = m.y; M.s = m.s; } },
    setTransform(a) { M.x = 0; M.y = 0; M.s = a || 1; },
    translate(dx, dy) { M.x += dx * M.s; M.y += dy * M.s; },
    scale(sx) { M.s *= sx; },
    rotate() {}, clip() {}, beginPath() {}, closePath() {}, moveTo() {}, lineTo() {},
    arc() {}, arcTo() {}, ellipse() {}, roundRect() {}, clearRect() {}, strokeText() {},
    quadraticCurveTo() {}, bezierCurveTo() {},
    fillRect: (x, y, w, h) => trace.push(['fillRect', x * M.s + M.x, y * M.s + M.y, w * M.s, h * M.s]),
    strokeRect: (x, y, w, h) => trace.push(['strokeRect', x * M.s + M.x, y * M.s + M.y, w * M.s, h * M.s]),
    rect: (x, y, w, h) => trace.push(['rect', x * M.s + M.x, y * M.s + M.y, w * M.s, h * M.s]),
    fillText: (t, x, y) => trace.push(['fillText', t, x * M.s + M.x, y * M.s + M.y, M.s]),
    setLineDash: (d) => trace.push(['setLineDash', (d || []).join('/')]),
    fill: () => trace.push(['fill', ctx.fillStyle]),
    stroke: () => trace.push(['stroke', ctx.strokeStyle]),
    createLinearGradient: () => ({ addColorStop() {} }),
    createRadialGradient: () => ({ addColorStop() {} }),
    getImageData: () => ({ data: [] }), putImageData() {}, drawImage() {},
    measureText: () => { throw new Error('measureText 不允许：只读叠层的宽度必须按字数估'); },
    fillStyle: '', strokeStyle: '', lineWidth: 1, lineCap: '', lineJoin: '', font: '',
    textAlign: '', textBaseline: '', globalAlpha: 1, lineDashOffset: 0,
    shadowBlur: 0, shadowColor: '', globalCompositeOperation: '',
  };
  return ctx;
}

/** 画布替身：**记录**监听器（拖动序列要真的从 pointerdown 走一遍） */
function mkCanvas() {
  const lis = {};
  return {
    width: 800, height: 600, style: {},
    getContext: () => mkG([]),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
    addEventListener(t, fn) { (lis[t] ||= []).push(fn); },
    removeEventListener() {},
    fire(t, ev) { for (const fn of lis[t] || []) fn(ev); },
    hasPointerCapture: () => false, releasePointerCapture() {}, setPointerCapture() {}, focus() {},
  };
}

async function loadTarget(root, tag) {
  const u = (rel) => pathToFileURL(join(root, rel)).href;
  const { Engine } = await import(u('src/core/engine.js'));
  const { World } = await import(u('src/core/world.js'));
  const { Interaction } = await import(u('src/ui/interact.js'));
  const { Inspector } = await import(u('src/ui/inspector.js'));
  const { Readout, installReadout, LINE_H, MAX_SHIFT } = await import(u('src/ui/readout.js'));
  const caps = await import(u('src/equipment/caps.js'));
  const REG = await import(u('src/equipment/registry.js'));
  const { create, equipmentPlugins } = await import(u('src/equipment/index.js'));
  const { PluginHost } = await import(u('src/core/plugin.js'));
  const bootApp = {
    services: {}, ticks: [], world: null, lastCircuit: null, selected: null,
    log: { push() {}, clear() {} }, toast() {},
    addTick(fn) { this.ticks.push(fn); return () => {}; },
  };
  const host = new PluginHost(bootApp);
  for (const p of equipmentPlugins) host.define(p);
  host.installAll();
  REG.bindRegistry(host.registry('equipment'));
  const list = () => REG.list();
  return { tag, root, Engine, World, Interaction, Inspector, Readout, installReadout, caps, create, list, get: REG.get, LINE_H, MAX_SHIFT };
}

/** 一个能跑交互层 / 渲染层 / 读数层的最小台面 */
function mkRig(T) {
  const world = new T.World();
  const cv = mkCanvas();
  const eng = new T.Engine(cv, world);
  eng.app = { markDirty() {} };
  const moved = [];
  const app = {
    canvas: cv, world, engine: eng, selected: null,
    select(e) { app.selected = e; }, markDirty() {}, setStatusTool() {}, toast() {},
    doPour() {}, removeEntity() {}, onEntityClicked() {},
    onEntityMoved(ent, from, to) { moved.push({ id: ent.id, from, to }); },
  };
  const inter = new T.Interaction(app);
  const readout = inter.readout || T.installReadout(app);
  return { world, app, eng, inter, readout, cv, moved };
}

/** 走一遍**真的** pointerdown → pointermove… → pointerup（不是直接赋值 ent.x） */
function drag(cv, from, to, ptrType = 'mouse') {
  const base = { pointerId: 1, isPrimary: true, pointerType: ptrType, button: 0, buttons: 1, preventDefault() {}, stopPropagation() {} };
  const ev = (x, y) => Object.assign({ clientX: x, clientY: y }, base);
  cv.fire('pointerdown', ev(from.x, from.y));
  for (let i = 1; i <= DRAG_STEPS; i++) {
    cv.fire('pointermove', ev(from.x + (to.x - from.x) * i / DRAG_STEPS, from.y + (to.y - from.y) * i / DRAG_STEPS));
  }
  cv.fire('pointerup', ev(to.x, to.y));
  flushRaf();
}

/** 按引擎的叠层契约画一遍：先 pan/zoom 的变换（与 engine.render 同序），再走 overlays 回调 */
function traceOfDraw(eng, readout) {
  const tr = [];
  const g = mkG(tr);
  if (eng.pan.x || eng.pan.y) g.translate(eng.pan.x, eng.pan.y);
  if (eng.zoom !== 1) g.scale(eng.zoom, eng.zoom);
  try { readout.draw(g, eng); } catch (e) { tr.push(['THREW', String((e && e.message) || e)]); }
  return tr;
}
const textsAt = (tr, x, y) => tr.filter((o) => o[0] === 'fillText' && Math.abs(o[2] - x) < 1e-6 && Math.abs(o[3] - y) < 1e-6);
/** Inspector 输出的**全部**文本（递归收集）—— 给「两处口径逐字相同」当对照面 */
function flatText(el) {
  if (!el) return '';
  if (el.children && el.children.length) return el.children.map(flatText).join('\u0001');
  return typeof el.textContent === 'string' ? el.textContent : '';
}

// ══════════════════════════════════════════════════════════
// 断言套件（绿档跑一次，每个变异体各跑一次）
// ══════════════════════════════════════════════════════════
async function runSuite(T, opt) {
  const o = opt || {};
  const verbose = o.verbose !== false;
  const S = { pass: 0, fail: 0, failed: [], failSec: [], secTotal: {}, notes: [] };
  let cur = '?';
  const ok = (cond, msg) => {
    S.secTotal[cur] = (S.secTotal[cur] || 0) + 1;
    if (cond) { S.pass++; if (verbose) console.log('  \x1b[32m✓\x1b[0m ' + msg); }
    else { S.fail++; S.failed.push(`[${cur}] ${msg}`); S.failSec.push(cur); console.log('  \x1b[31m✗\x1b[0m ' + msg); }
  };
  const head = (t) => { cur = t.trim().charAt(0); if (verbose) console.log('\n\x1b[36m' + t + '\x1b[0m'); };
  const info = (t) => { S.notes.push(t); if (verbose) console.log('    · ' + t); };

  const srcInteract = codeOf(T.root, 'src/ui/interact.js');
  const codeInteract = stripComments(srcInteract);
  const srcEntity = codeOf(T.root, 'src/core/entity.js');
  const srcReadout = codeOf(T.root, 'src/ui/readout.js');
  const srcCaps = codeOf(T.root, 'src/equipment/caps.js');

  const ALL = T.list();
  if (!ALL.length) throw new Error('器材注册表为空（基础设施）');
  const withStats = ALL.filter((d) => d.stats && d.stats.length).map((d) => d.type);
  const plainTypes = ALL.filter((d) => !(d.stats && d.stats.length)).map((d) => d.type);
  info(`注册表实测：${ALL.length} 件器材，其中 ${withStats.length} 件声明了 def.stats，${plainTypes.length} 件没有`);

  // ── ① 锁定后拖不动；未锁定的对照件照旧能拖 ──────────────────────────
  head('① 锁定后整段拖动序列不改变位置（未锁定的对照件照旧改变）');
  {
    const { world, inter, cv, moved } = mkRig(T);
    const a = T.create(withStats[0], 300, 300);      // 被锁定的那一件
    const b = T.create(withStats[0], 460, 300);      // **同类**对照件（未锁定）
    world.add(a); world.add(b);
    ok(a.locked === false && b.locked === false, '新器材默认未锁定（locked === false）');
    ok(typeof a.setLocked === 'function' && a.setLocked(true) === true && a.locked === true,
      'setLocked(true) 是唯一写入口，返回「真的变了」');
    const a0 = { x: a.x, y: a.y }, b0 = { x: b.x, y: b.y };
    drag(cv, { x: a.x, y: a.y }, { x: a.x + 64, y: a.y + 32 });
    drag(cv, { x: b.x, y: b.y }, { x: b.x + 64, y: b.y + 32 });
    ok(Object.is(a.x, a0.x) && Object.is(a.y, a0.y),
      `锁定件位置逐位不变（${a0.x},${a0.y} → ${a.x},${a.y}）`);
    ok(b.x !== b0.x || b.y !== b0.y,
      `对照件（同类、未锁定）位置照旧改变（${b0.x},${b0.y} → ${b.x},${b.y}）⇒ 判据不是「本来就拖不动」`);
    ok(moved.filter((m) => m.id === a.id).length === 0,
      '锁定件的拖动**不产生 onEntityMoved**（撤销栈不会多一条 move）');
    ok(moved.filter((m) => m.id === b.id).length === 1,
      `对照件落定时恰好回调 1 次 onEntityMoved（实测 ${moved.filter((m) => m.id === b.id).length} 次）`);
    ok(inter.drag === null, '整段序列结束后没留下进行中的拖动（inter.drag === null）');
    const c = T.create(withStats[0], 600, 300);
    world.add(c); c.setLocked(true);
    const c0 = { x: c.x, y: c.y };
    drag(cv, { x: c.x, y: c.y }, { x: c.x + 60, y: c.y }, 'touch');
    ok(Object.is(c.x, c0.x) && Object.is(c.y, c0.y), '触屏指针（pointerType=touch）下锁定件同样不动');
  }

  // ── ② 解锁后恢复可拖（走 DOM 那条路：readout.toggleLock ⇒ applyCap）──
  head('② 解锁后恢复可拖（经 applyCap 的唯一动作定义）');
  {
    const { world, readout, cv, moved } = mkRig(T);
    const a = T.create(withStats[0], 300, 300);
    world.add(a);
    readout.follow(a);
    ok(!!(readout.root && readout.btn), 'DOM 锁定条已挂在读数层实例上（root/btn 都在）');
    ok(readout.root.hidden === false, '有 lock 能力位的器材：选中后锁定条可见');
    ok(readout.btn.textContent === '锁定位置', `未锁定时按钮文案 = 锁定位置（实测「${readout.btn.textContent}」）`);
    readout.btn.fire('click');                       // 真的点一下 DOM 按钮
    ok(a.locked === true, '点一下按钮 ⇒ 器材被锁定（动作来自 caps.applyCap）');
    ok(readout.btn.textContent === '解锁', `锁定后文案翻成「解锁」（实测「${readout.btn.textContent}」）`);
    const a1 = { x: a.x, y: a.y };
    drag(cv, { x: a.x, y: a.y }, { x: a.x + 64, y: a.y });
    ok(Object.is(a.x, a1.x) && Object.is(a.y, a1.y), '锁定态下拖不动');
    readout.btn.fire('click');                       // 再点一次 = 解锁
    ok(a.locked === false, '再点一下 ⇒ 解锁');
    const a2 = { x: a.x, y: a.y };
    drag(cv, { x: a.x, y: a.y }, { x: a.x + 64, y: a.y });
    ok(a.x !== a2.x || a.y !== a2.y, `解锁后同一段序列恢复可拖（${a2.x},${a2.y} → ${a.x},${a.y}）`);
    ok(moved.length === 1, `解锁那次拖动恰好 1 次 onEntityMoved（实测 ${moved.length}）`);
  }

  // ── ③ 逐件独立 + 锁定标记只画在锁定件上 ─────────────────────────────
  head('③ 锁定状态逐件独立（两件同类互不影响）');
  {
    const { world, readout, cv, eng } = mkRig(T);
    const a = T.create(withStats[0], 300, 300);
    const b = T.create(withStats[0], 460, 300);
    world.add(a); world.add(b);
    ok(readout.toggleLock(a) === true && a.locked === true, '通过 readout.toggleLock(a) 锁定第一件');
    ok(b.locked === false, '第二件（同类）不受影响 —— locked 是**每台本体自有**的位');
    const b0 = { x: b.x, y: b.y };
    drag(cv, { x: b.x, y: b.y }, { x: b.x + 48, y: b.y });
    ok(b.x !== b0.x || b.y !== b0.y, '第一件锁定后，第二件照旧能拖（逐件独立）');
    ok(readout.toggleLock(b) === true && a.locked === true && b.locked === true, '两件可以各自锁上，互不覆盖');
    readout.toggleLock(a);                            // 只解第一件
    ok(a.locked === false && b.locked === true, '解第一件不影响第二件');
    const tr = traceOfDraw(eng, readout);
    const dash = tr.filter((x) => x[0] === 'setLineDash' && x[1] !== '');
    const rects = tr.filter((x) => x[0] === 'strokeRect');
    ok(dash.length >= 1 && rects.length === 1,
      `锁定件画了虚线框（setLineDash ${dash.length} 次、strokeRect ${rects.length} 个）`);
    ok(rects.length === 1 && Math.abs(rects[0][1] - (b.x - (b.w || 64) / 2)) < 1e-6,
      '虚线框贴的是**锁定那一件**的外框（不是另一件）');
    ok(dash.every((x) => x[1].split('/').length >= 2), '虚线样式是真虚线（≥2 段 dash）');
  }

  // ── ④ 读数取该件自己的 def.stats（两处口径逐字一致）────────────────
  head('④ 逐件读数 = 该件自己的 def.stats（与 Inspector 输出逐字一致）');
  {
    const { world, readout, app } = mkRig(T);
    const a = T.create(withStats[0], 300, 300);
    const b = T.create(withStats[0], 300, 460);
    world.add(a); world.add(b);
    const la = readout.lines(a);
    ok(la.length > 0 && la.length === (a.def.stats || []).length,
      `条数 = 本件器材自己的 def.stats.length（${la.length} = ${(a.def.stats || []).length}，不写死全局块数）`);
    // 「同类两件读数不同」：先在注册表里**实测**找出见证器材（读数真的随本件状态走的那种）
    const bump = (e) => {
      for (const k of Object.keys(e.props || {})) if (typeof e.props[k] === 'number') e.props[k] += 7;
      for (const k of Object.keys(e.state || {})) if (typeof e.state[k] === 'number') e.state[k] += 7;
    };
    let witness = null, l1 = null, l2 = null;
    for (const t of withStats) {
      const e1 = T.create(t, 0, 0), e2 = T.create(t, 0, 0);
      const s1 = readout.lines(e1).map((l) => l.text).join('|');
      bump(e2);
      const s2 = readout.lines(e2).map((l) => l.text).join('|');
      if (s1 !== s2) { witness = t; l1 = s1; l2 = s2; break; }
    }
    ok(!!witness, `实测找到「同类两件、读数各自取自己的值」的见证器材：${witness || '（没有）'}`);
    if (witness) info(`见证：${witness} 未调「${l1}」／调过「${l2}」`);
    const lb = readout.lines(b);
    ok(la.length === lb.length, '两件同类器材读数**条数**相同（同一份 def.stats）');
    ok(!!witness && l1 !== l2, '两件**同类**器材的读数各自取自己的值（至少一行不同）');
    // 与真实 Inspector 的输出逐字对拍（不许出现第三套格式化口径）
    const insp = new T.Inspector(mkEl('div'), app);
    insp.show(a);
    const flat = flatText(insp.root);
    const missing = la.filter((l) => flat.indexOf(l.text) < 0);
    ok(missing.length === 0,
      `就地读数 ${la.length} 行全部**逐字**出现在真实 Inspector.render() 输出里`
      + (missing.length ? `；缺：${missing.map((m) => m.label + '=' + m.text).join(' ')}` : ''));
    const th = ALL.find((d) => (d.stats || []).some((s) => s.fmt));
    if (th) {
      const e2 = T.create(th.type, 0, 0);
      const rows = readout.lines(e2);
      ok(rows.length > 0 && rows.some((r) => /[∞kM]?Ω|℃|A|V/.test(r.text)),
        `带 fmt 的器材（${th.type}）读数走 fmt 分支（实测 ${rows.map((r) => r.label + '=' + r.text).join(',')}）`);
      const insp2 = new T.Inspector(mkEl('div'), app);
      insp2.show(e2);
      const flat2 = flatText(insp2.root);
      ok(rows.every((r) => flat2.indexOf(r.text) >= 0), 'fmt 分支的文本与 Inspector 逐字一致（不是自己 toFixed）');
    } else { ok(false, '基础设施：注册表里没有带 fmt 的 def.stats 行（该判据无从谈起）'); }
    ok(countIn(srcReadout, 'toFixed(') === 0, 'readout.js 里没有 toFixed（格式化只有一处：inspector.js 的 fmtBy）');
    ok(countIn(srcReadout, 'fmtBy') >= 2 && srcReadout.includes("from './inspector.js'"),
      'readout.js 从 inspector.js 引入 fmtBy（digits 格式化同一处定义）');
    ok(countIn(srcReadout, 'e.type') === 0,
      'readout.js 完全不按 e.type 判断（那一套按 type 硬编码的读数在 src/ui/data.js）');
  }

  // ── ⑤ 移动 / 缩放后仍锚在器材上，字号不随缩放变 ─────────────────────
  head('⑤ 读数锚点跟着器材走，字号不随缩放变');
  {
    const { world, readout, eng } = mkRig(T);
    const a = T.create(withStats[0], 300, 300);
    world.add(a);
    const anchorOf = () => ({ x: a.x, y: a.y + (a.h || 64) / 2 + GAP });
    const drawAt = (zoom) => { const keep = eng.zoom; eng.zoom = zoom; const tr = traceOfDraw(eng, readout); eng.zoom = keep; return tr; };
    const n = readout.lines(a).length;
    /** 一个锚点的**整列**读数（各行共用同一个 x：文本居中画在锚点上） */
    const colAt = (tr, x) => tr.filter((x2) => x2[0] === 'fillText' && Math.abs(x2[2] - x) < 1e-6);
    const an1 = anchorOf();
    const c1 = colAt(drawAt(1), an1.x);
    ok(c1.length === n, `zoom=1：读数 ${c1.length} 行(=def.stats 条数)画在器材下沿的世界锚点上 (${an1.x},${an1.y})`);
    ok(c1.some((x) => Math.abs(x[3] - (an1.y + 3)) < 1e-6), '第一行落在锚点 + 内边距那一行（不是画在别处）');
    ok(c1.every((x) => Math.abs(x[4] - 1) < 1e-9), 'zoom=1：文本累计缩放 = 1（屏幕字号 = 声明字号）');
    a.x += 120; a.y += 80;
    const an2 = anchorOf();
    const tr2 = drawAt(1);
    ok(colAt(tr2, an2.x).length === n && colAt(tr2, an1.x).length === 0,
      `移动器材后锚点跟着走到 (${an2.x},${an2.y})，旧锚点上**不再**画（不是画了两处）`);
    const c4 = colAt(drawAt(2), an2.x * 2);
    ok(c4.length === n, 'zoom=2：读数落在同一个世界锚点的屏幕位置（世界锚点 × zoom）');
    ok(c4.every((x) => Math.abs(x[4] - 1) < 1e-9),
      `zoom=2：文本累计缩放仍 = 1（实测 ${c4.map((x) => x[4]).join(',')}）⇒ 屏幕字号不随缩放变`);
    const cH = colAt(drawAt(0.5), an2.x * 0.5);
    ok(cH.length === n && cH.every((x) => Math.abs(x[4] - 1) < 1e-9), 'zoom=0.5 同样成立（三档一致）');
    ok(countIn(srcReadout, '1 / zoom') >= 1, '反向缩放写在源码里（1 / zoom，不是复制一份 w*zoom+pan）');
  }

  // ── ⑥ 边界：没有 def.stats 的器材不抛错、不显示空框 ─────────────────
  head('⑥ 没有 def.stats 的器材：不抛错、不画空框');
  {
    const { world, readout, eng } = mkRig(T);
    ok(plainTypes.length > 0, `注册表里确有 ${plainTypes.length} 件没声明 def.stats 的器材（判据非空转）`);
    const p = T.create(plainTypes[0], 200, 200);
    const q = T.create(withStats[0], 400, 200);
    world.add(p); world.add(q);
    ok(readout.lines(p).length === 0, `无 def.stats 的器材（${plainTypes[0]}）读数为 0 行`);
    const tr = traceOfDraw(eng, readout);
    ok(!tr.some((x) => x[0] === 'THREW'), '绘制无 def.stats 的器材不抛错');
    const an = { x: p.x, y: p.y + (p.h || 64) / 2 + GAP };
    ok(textsAt(tr, an.x, an.y + 3).length === 0, '它的锚点上没有文本');
    ok(!tr.some((x) => x[0] === 'fillRect' && Math.abs(x[1] + x[3] / 2 - an.x) < 1 && Math.abs(x[2] - an.y) < 1),
      '也没有画出空背板（无读数的器材在画布上零痕迹）');
    ok(readout.count === 1, `count = 只数真的画了读数的那 1 件（实测 ${readout.count}）`);
    ok(readout.anchors.length === 1 && readout.anchors[0].id === q.id, '锚点表里只有有读数的那一件');
  }

  // ── ⑦ 存档持久性（甲案）+ 次序结构断言 + 能力位接线 ────────────────
  head('⑦ 存档持久性（甲案：扩白名单）+ 拖动入口次序 + 能力位接线');
  {
    const { world, app } = mkRig(T);
    const a = T.create(withStats[0], 120, 240);
    const b = T.create(withStats[0], 360, 240);
    world.add(a); world.add(b);
    const jsonA = a.toJSON();
    ok(!('locked' in jsonA), '未锁定的器材：toJSON() 里**没有** locked 键（旧存档逐字不变）');
    ok(eq(jsonA, a.toJSON()), 'toJSON() 幂等（同一状态两次序列化逐字相同）');
    a.setLocked(true);
    const jsonA2 = a.toJSON();
    ok(jsonA2.locked === true, '锁定后 toJSON() 带 locked: true');
    ok(eq(Object.keys(jsonA2).sort(), Object.keys(jsonA).concat('locked').sort()),
      `锁定只多出 locked 一个键（${Object.keys(jsonA).sort().join(',')} → ${Object.keys(jsonA2).sort().join(',')}）`);
    ok(eq(Object.keys(jsonA2).filter((k) => k !== 'locked').sort(), Object.keys(jsonA).sort()),
      '锁定不改变其余任何键（纯加法）');
    const snap = world.toJSON();
    const w2 = new T.World();
    w2.loadJSON(snap, (type) => T.get(type));
    ok(w2.entities.length === 2, `读档后两件器材都在（实测 ${w2.entities.length} 件）`);
    const ra = w2.entities[0], rb = w2.entities[1];
    ok(ra && ra.locked === true && rb && rb.locked === false,
      `读档后：锁过的那件仍是锁定态、没锁的那件仍是未锁定（${ra && ra.locked} / ${rb && rb.locked}）`);
    ok(ra.setLocked(false) === true && ra.locked === false, '读档回来的器材仍可解锁（setLocked 可用）');
    const old = (() => { const x = a.toJSON(); delete x.locked; return x; })();
    const e3 = T.create(withStats[0], 0, 0);
    e3.loadJSON(old);
    ok(e3.locked === false, '旧存档缺 locked 键 ⇒ 读档后是未锁定（缺省即不覆盖）');
    const e4 = T.create(withStats[0], 0, 0);
    e4.setLocked(true); e4.loadJSON(old);
    ok(e4.locked === true, '「缺省即不覆盖」逐字成立：旧存档不会把已锁定的解掉');
    ok(countIn(srcEntity, '...(this.locked ? { locked: true } : {})') === 1, 'entity.js 里 locked 只在为真时写出（一处）');
    ok(countIn(srcEntity, 'if (o.locked === true) this.setLocked(true);') === 1, 'entity.js 读档只认 === true（一处）');
    // 结构断言：判定必须在 `this.drag = {` **之前**（事后夹回终值一样、手感全错）
    const atGuard = codeInteract.indexOf('ent.locked');
    const atDrag = codeInteract.indexOf('this.drag = {');
    ok(atGuard > 0 && atDrag > 0 && atGuard < atDrag,
      `interact.js 里锁定判定位于 this.drag = { 之前（${atGuard} < ${atDrag}）`);
    ok(countIn(srcInteract, 'ent.locked') === 1, '拖动入口只有**一处**锁定判定（不是散在多处）');
    ok(countIn(srcInteract, 'if (ent.locked) { this.markDirty(); return; }') === 1,
      '判定形式是「就地拦下并 markDirty 后返回」');
    const ci = codeInteract.indexOf('settleTo(ent, tx, ty, onDone)');
    const settleBody = ci > 0 ? codeInteract.slice(ci, ci + 1200) : '';
    ok(settleBody.length > 0 && !settleBody.includes('locked'),
      'settleTo() 里**没有**锁定位（不是「拖完再夹回原位」）');
    // 能力位接线（唯一动作定义处）
    const EVERY = ALL.map((d) => ({ type: d.type, lock: T.caps.menuCaps(T.create(d.type, 0, 0)).lock }));
    const lack = EVERY.filter((x) => x.lock !== true);
    ok(lack.length === 0, `${EVERY.length} 件器材默认都有 lock 位（缺：${lack.map((x) => x.type).join(',') || '无'}）`);
    const optOut = { type: 'lockprobe-x', locked: false, def: { caps: { lock: false } } };
    ok(T.caps.menuCaps(optOut).lock === false && T.caps.menuCaps(optOut).duplicate === true,
      '器材自己声明 lock:false 可以单件关掉（按位合并不丢默认位）');
    // ⚠ applyCap 的入口守卫是 gone()：器材不在台面上（或 alive=false）**一律不动**。
    //   替身没有 id、也不在台上 ⇒ 那两条走「没有 world 就不拦」的分支（判据只按能证明的来）。
    const noWorld = Object.assign({}, app, { world: null });
    ok(T.caps.applyCap(noWorld, optOut, 'lock', null) === false && optOut.locked === false,
      '位为假 ⇒ applyCap 什么都不做并返回 false');
    const e5 = T.create(withStats[0], 0, 0);
    world.add(e5);                                   // 位为真的那条要在台面上（否则被 gone 拦下）
    ok(T.caps.applyCap(app, e5, 'lock', null) === true && e5.locked === true, '位为真 ⇒ applyCap 翻位并返回 true');
    ok(T.caps.applyCap(app, e5, 'lock', null) === true && e5.locked === false, '再调一次 ⇒ 翻回来（同一个动作定义处）');
    ok(countIn(srcCaps, "case 'lock':") === 1, "caps.js 里 case 'lock' 只有一处（唯一「位 → 动作」定义处）");
    ok(countIn(srcCaps, 'LOCK_CAP') >= 2, 'LOCK_CAP 默认位在 caps.js 里有定义、且真的参与 menuCaps 合并');
    const gone = T.create(withStats[0], 0, 0);
    gone.alive = false;
    ok(T.caps.applyCap(app, gone, 'lock', null) === false && gone.locked === false,
      '已删除（alive=false）的器材：不动、不抛错');
    // 读数层与 DOM 解耦：没有 body 时照旧工作（纯 Node 判据走这条）
    const r2 = new T.Readout(app, { document: null });
    ok(r2.root === null && r2.draw(mkG([]), null) >= 0, '没有 DOM 时读数层照旧工作（读数是画布的事）');
  }

  // ── ⑧ 相邻读数标签的避让（交叠场景不相交 · 无冲突逐位不变 · 20 件上限不死循环）──
  head('⑧ 相邻读数避让：交叠场景两框/行不相交、无冲突逐位不变、上限不死循环');
  {
    /**
     * 同一场景画两遍，**只有 avoid 不同** ⇒ 拿它当反面对照。
     * 只断言「避让后不重叠」是缺对照的：那个场景可能本来就不重叠（假绿）。
     */
    const scene = (avoid, xs, zoom) => {
      const rig = mkRig(T);
      const ro = new T.Readout(rig.app, { document: null, avoid });
      const ents = xs.map((x) => { const e = T.create(withStats[0], x, 300); rig.world.add(e); return e; });
      const keep = rig.eng.zoom;
      if (zoom) rig.eng.zoom = zoom;
      const tr = traceOfDraw(rig.eng, ro);
      rig.eng.zoom = keep;
      return {
        rig, ro, tr, ents,
        boxes: tr.filter((o) => o[0] === 'fillRect').map((o) => ({ x: o[1], y: o[2], w: o[3], h: o[4] })),
      };
    };
    /** 两两配对：交叠要逐对看首尾会漏 */
    const pairsOf = (bs) => {
      const out = [];
      for (let i = 0; i < bs.length; i++) for (let j = i + 1; j < bs.length; j++) out.push([bs[i], bs[j]]);
      return out;
    };
    const hitsOf = (bs) => pairsOf(bs).filter(([a, b]) => T.Readout.hit(a, b));
    const textsOf = (s) => s.tr.filter((o) => o[0] === 'fillText').map((o) => o[1]);
    const rowsAt = (s, b) => s.tr.filter((o) => o[0] === 'fillText' && Math.abs(o[2] - (b.x + b.w / 2)) < 1e-6).map((o) => o[3]);

    const one = scene(true, [300]);
    ok(one.boxes.length === 1 && one.ro.count === 1 && one.ro.rects.length === 1,
      '单件场景：真的画出 1 个标签外框（实测 ' + one.boxes.length + ' 个、count=' + one.ro.count + '）');
    const bw = one.boxes[0].w;                        // **实测**宽度：邻居位置由它推出，不写字面量
    const xs = [300, 300 + bw - OV];                  // 第二套与第一套横向重 OV px
    const on = scene(true, xs);
    const off = scene(false, xs);
    ok(on.boxes.length === 2 && off.boxes.length === 2,
      '交叠场景：两件器材各画出 1 个外框（实测 ' + on.boxes.length + ' / ' + off.boxes.length + '）');
    const offHit = hitsOf(off.boxes);
    ok(offHit.length === 1,
      '反面照妖镜（同一场景 avoid:false）：两套标签**确实交叠**（实测交叠 ' + offHit.length + ' 对）⇒ 场景是真冲突、判据不是空转');
    info('改前（不避让）实测外框：A=' + JSON.stringify(off.boxes[0]) + ' B=' + JSON.stringify(off.boxes[1]));
    const onHit = hitsOf(on.boxes);
    ok(onHit.length === 0, '开了避让（默认）：两套标签外框**不相交**（实测交叠 ' + onHit.length + ' 对）');
    info('改后（避让后）实测外框：A=' + JSON.stringify(on.boxes[0]) + ' B=' + JSON.stringify(on.boxes[1]));
    ok(eq(on.boxes[0], off.boxes[0]) && on.ro.rects[0].dy === 0,
      '先画的那一套逐位不动（它没有冲突 ⇒ 一个像素都没挪）');
    ok(on.ro.rects[1].dy > 0 && on.ro.rects[1].shifted === true && on.ro.rects[1].stillOverlap === false,
      '后画的那一套被整体下移、移完**不再交叠**（实测 dy=' + on.ro.rects[1].dy + '）');
    ok(eq(on.ro.rects.map((r) => ({ x: r.x, y: r.y, w: r.w, h: r.h })), on.boxes),
      '模块自报的外框表 == **真的画出来**的外框（自报的表不是另一套账）');
    const kstep = (on.boxes[1].y - off.boxes[1].y) / T.LINE_H;
    ok(Number.isInteger(kstep) && kstep >= 1 && Object.is(on.boxes[1].x, off.boxes[1].x),
      '位移是**行距整数倍**且只上下移（实测 k=' + kstep + ' 行、x 逐位不变）');
    ok(eq(textsOf(on), textsOf(off)),
      '避让**不动内容与格式**：两遍画出来的文本序列逐字相同（' + textsOf(on).length + ' 行）');
    const ra = rowsAt(on, on.boxes[0]), rb = rowsAt(on, on.boxes[1]);
    ok(ra.length > 0 && ra.length === rb.length && Math.max(...ra) + T.LINE_H <= Math.min(...rb),
      '两套标签的**行矩形不相交**：A 的 ' + ra.length + ' 行整体在 B 的 ' + rb.length + ' 行之上（A 末行 '
      + Math.max(...ra) + ' + 行高 ≤ B 首行 ' + Math.min(...rb) + '）');
    const rev = scene(true, [xs[1], xs[0]]);
    ok(rev.boxes.length === 2 && hitsOf(rev.boxes).length === 0,
      '交换绘制顺序后同样不相交（不是「只移某一边」的凑巧）');
    ok(eq(rev.boxes[0], off.boxes[1]) && rev.boxes[1].y > off.boxes[0].y && rev.ro.rects[0].dy === 0,
      '交换顺序后：**先画**的那件落点逐位不变，被移的换成了另一件（移的永远是后画的）');
    const xs2 = [300, 300 + bw / 2 - OV / 2];         // zoom=2 时同样的**屏幕**交叠量
    const z2off = scene(false, xs2, 2);
    const z2on = scene(true, xs2, 2);
    ok(hitsOf(z2off.boxes).length === 1, 'zoom=2：反面对照同样真的交叠（判据在缩放态也非空转）');
    ok(hitsOf(z2on.boxes).length === 0, 'zoom=2：避让后两套标签不相交');
    const d2 = z2on.boxes[1].y - z2off.boxes[1].y;
    ok(Number.isInteger(d2 / T.LINE_H) && d2 >= T.LINE_H && Math.abs(z2on.ro.rects[1].dy * 2 - d2) < 1e-9,
      'zoom=2：屏幕位移 ' + d2 + 'px 仍是行距整数倍，且 == dy×zoom（世界位移换算正确，dy=' + z2on.ro.rects[1].dy + '）');
    const far = scene(true, [300, 4300]);
    ok(eq(far.tr.slice(0, one.tr.length), one.tr),
      '旁边有一件**远处**器材时：前一件的整段绘制指令逐位相同（无冲突 ⇒ 一点像素都不动）');
    ok(far.ro.rects[0].dy === 0 && far.ro.rects[1].dy === 0, '无冲突时两件的 dy 都是 0（避让没有偷偷加偏移）');
    const many = (() => {
      const rig = mkRig(T);
      const ro = new T.Readout(rig.app, { document: null });
      for (let i = 0; i < 20; i++) rig.world.add(T.create(withStats[0], 300, 300));
      const tr = traceOfDraw(rig.eng, ro);
      return { ro, tr };
    })();
    ok(!many.tr.some((o) => o[0] === 'THREW'), '20 件挤在同一点：绘制不抛错（避让不许把渲染搞崩）');
    ok(many.ro.count === 20 && many.ro.rects.length === 20 && many.ro.rects[0].dy === 0,
      '20 件都被画出（count=' + many.ro.count + '、外框 ' + many.ro.rects.length + ' 个、第一件 dy=0）');
    ok(many.ro.rects.every((r) => Number.isFinite(r.x) && Number.isFinite(r.y) && Number.isFinite(r.dy)),
      '位移全是有限数（不会用 NaN 把标签甩出画布）');
    const maxDy = Math.max(...many.ro.rects.map((r) => r.dy));
    ok(Math.abs(maxDy - T.MAX_SHIFT * T.LINE_H) < 1e-9,
      '位移**被上限封顶**：实测最大 dy=' + maxDy + ' == MAX_SHIFT×LINE_H=' + (T.MAX_SHIFT * T.LINE_H)
      + '（有界 ⇒ 不可能死循环，也不靠运气）');
    ok(many.ro.rects.filter((r) => r.shifted).length <= 19, '移过的件数 ≤ 19（第一件永不移 ⇒ 不是「每件都动」）');
    info('20 件同点：撞上限后仍有 ' + many.ro.rects.filter((r) => r.stillOverlap).length
      + ' 件互相重叠（**如实标注**：上限到了宁可仍重叠，不死循环、不抛错）');
    ok(countIn(srcReadout, 'step < MAX_SHIFT') === 1, '避让循环的上限只有一处、且条件是 step < MAX_SHIFT（有界）');
    ok(countIn(srcReadout, 'while (true)') === 0, '源码里没有 while (true)（停手靠上限，不靠运气）');
    ok(countIn(srcReadout, 'boxPx') === 3,
      '外框算式**只有一处**（声明 + 避让 + 绘制；两处各写一份就是「按一份算避让、按另一份画」）');
    ok(countIn(srcReadout, 'static hit(') === 1 && countIn(srcReadout, 'a.x < b.x + b.w') === 1
      && countIn(srcReadout, 'o.avoid !== false') === 1,
      '交叠判定的**公式只写一遍**（判定与开关各只有一处 —— 散在多处就是「数值一样、结构退化」的假绿）');
  }

  return S;
}

// ══════════════════════════════════════════════════════════
// 变异体：唯一锚点改写（0 次 / >1 次命中都算没落地）
// `from` 与 `to` 都是**仓库里逐字节的实际文本**，不是从描述反推的期望。
// ══════════════════════════════════════════════════════════
const MUTANTS = [
  {
    id: 'M1-拖动入口的锁定判定被删除',
    desc: '把就地拦下那行删掉 ⇒ 锁定件会跟着手指走',
    patches: [{ rel: 'src/ui/interact.js', from: '        if (ent.locked) { this.markDirty(); return; }\n', to: '' }],
    expect: ['①', '②', '⑦'],
  },
  {
    id: 'M2-判定挪到 this.drag 赋值之后',
    desc: '拖动对象照建、建完立刻丢弃 ⇒ 终值看似相同，手感与次序全错',
    patches: [
      { rel: 'src/ui/interact.js', from: '        if (ent.locked) { this.markDirty(); return; }\n', to: '' },
      {
        rel: 'src/ui/interact.js',
        from: '          ox: ent.x, oy: ent.y,\n        };\n      } else {',
        to: '          ox: ent.x, oy: ent.y,\n        };\n        if (ent.locked) { this.drag = null; this.markDirty(); return; }\n      } else {',
      },
    ],
    expect: ['⑦'],
  },
  {
    id: 'M3-lock 动作变成空操作',
    desc: 'applyCap 的 lock 分支只叫 after()，不翻位',
    patches: [{
      rel: 'src/equipment/caps.js',
      from: "      if (typeof ent.setLocked === 'function') ent.setLocked(!ent.locked);\n      else ent.locked = !ent.locked;\n",
      to: '',
    }],
    expect: ['②', '③', '⑦'],
  },
  {
    id: 'M4-读数自己拼 toFixed',
    desc: '绕过 fmt/digits 自己格式化 ⇒ 与属性面板的文本对不上',
    patches: [{
      rel: 'src/ui/readout.js',
      from: "      if (s.fmt) { out.push({ label: s.label, text: s.fmt(v) }); continue; }\n      if (!Number.isFinite(v)) continue;\n      out.push({ label: s.label, text: fmtBy(s.digits, v) + (s.unit ? ' ' + s.unit : '') });",
      to: "      if (!Number.isFinite(v)) continue;\n      out.push({ label: s.label, text: v.toFixed(1) + (s.unit ? ' ' + s.unit : '') });",
    }],
    expect: ['④'],
  },
  {
    id: 'M5-字符串读数那一支被跳过',
    desc: '字符串型读数不再原样上屏 ⇒ 该行凭空消失',
    patches: [{
      rel: 'src/ui/readout.js',
      from: "      if (typeof v === 'string') { out.push({ label: s.label, text: v }); continue; }",
      to: '      if (v === undefined) { out.push({ label: s.label, text: v }); continue; }',
    }],
    expect: ['④'],
  },
  {
    id: 'M6-存档不再写出 locked',
    desc: 'toJSON 丢掉锁定态 ⇒ 存完再读就解锁了',
    patches: [{ rel: 'src/core/entity.js', from: '      ...(this.locked ? { locked: true } : {}),\n', to: '' }],
    expect: ['⑦'],
  },
  {
    id: 'M7-读档不再认 locked',
    desc: 'loadJSON 不接受锁定态（只认一个不可能的值）',
    patches: [{
      rel: 'src/core/entity.js',
      from: '    if (o.locked === true) this.setLocked(true);',
      to: '    if (o.locked === 1) this.setLocked(true);',
    }],
    expect: ['⑦'],
  },
  {
    id: 'M8-读数不再反向缩放',
    desc: '去掉 1/zoom ⇒ 字号随缩放变粗变细',
    patches: [{
      rel: 'src/ui/readout.js',
      from: '    if (g.scale) g.scale(1 / zoom, 1 / zoom);',
      to: '    if (g.scale) g.scale(1, 1);',
    }],
    // ⚠ ⑧ 是**新增**的一节：它拿「真画出来的外框」与 zoom=2 的屏幕位移对拍，
    //   去掉反向缩放会把这两条一起打红（实测如此，如实记进期望集；不是把 ⑧ 放水）
    expect: ['⑤', '⑧'],
  },
  {
    id: 'M9-读数锚点挪到器材中心',
    desc: '读数的锚点从下沿改成器材中心',
    patches: [{
      rel: 'src/ui/readout.js',
      from: '    const y = e.y + (e.h || 64) / 2 + GAP;',
      to: '    const y = e.y;',
    }],
    // ⚠ 挪锚点会让「模块自报的外框」与「真的画出来的外框」对不上 ⇒ ⑧ 的对拍那条也要红（如实记录）
    expect: ['⑤', '⑧'],
  },
  {
    id: 'M10-没有读数的器材也画空背板',
    desc: '去掉「一行都不画」的短路 ⇒ 空框出现在没有读数的器材旁',
    patches: [{
      rel: 'src/ui/readout.js',
      from: '      if (!ls.length) continue;            // ⚠ 没有 def.stats ⇒ 一行都不画（不画空框）',
      to: '      if (!ls.length) { void 0; }',
    }],
    expect: ['⑥'],
  },
  {
    id: 'M11-默认位不再含 lock',
    desc: 'menuCaps 的合并里抽掉 LOCK_CAP ⇒ 全库器材都失去锁定能力位',
    patches: [{
      rel: 'src/equipment/caps.js',
      from: '  return { ...DEFAULT_CAPS, ...LOCK_CAP, ...legacyCaps(e), ...(central || {}), ...(own || {}) };',
      to: '  return { ...DEFAULT_CAPS, ...legacyCaps(e), ...(central || {}), ...(own || {}) };',
    }],
    expect: ['②', '③', '⑦'],
  },
  {
    id: 'M12-锁定标记不再绘制',
    desc: '锁定件不再画虚线框（状态还在、看得见的反馈没了）',
    patches: [{
      rel: 'src/ui/readout.js',
      from: '      if (e.locked === true) this.drawLockMark(g, e);',
      to: '      if (e.locked === "no") this.drawLockMark(g, e);',
    }],
    expect: ['③'],
  },
  {
    id: 'M13-读数避让被删掉',
    desc: '冲突时不再整体下移 ⇒ 相邻器材的读数标签又叠在一起（缺陷复现）',
    patches: [{
      rel: 'src/ui/readout.js',
      from: '        while (step < MAX_SHIFT && placed.some((b) => Readout.hit(b, rect))) {\n',
      to: '        while (false && placed.some((b) => Readout.hit(b, rect))) {\n',
    }],
    expect: ['⑧'],
  },
  {
    id: 'M14-避让开关被忽略',
    desc: '永远避让 ⇒ 反面对照（avoid:false）也变成不重叠，照妖镜失效',
    patches: [{ rel: 'src/ui/readout.js', from: '    this.avoid = o.avoid !== false;\n', to: '    this.avoid = true;\n' }],
    expect: ['⑧'],
  },
  {
    id: 'M15-null-避让判定写成等价形式',
    desc: '语义零改动：.some(...) 与 .some(...) === true 等价 ⇒ 必须 0 红（null 变异体）',
    patches: [{
      rel: 'src/ui/readout.js',
      from: 'while (step < MAX_SHIFT && placed.some((b) => Readout.hit(b, rect))) {',
      to: 'while (step < MAX_SHIFT && placed.some((b) => Readout.hit(b, rect)) === true) {',
    }],
    expect: [],
  },
];

function stage(name, patches) {
  const dir = join(TMP, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  cpSync(join(ROOT, 'src'), join(dir, 'src'), { recursive: true });
  const detail = [];
  for (const p of patches || []) {
    const file = join(dir, p.rel);
    const src = norm(readFileSync(file, 'utf8'));
    const hits = src.split(p.from).length - 1;
    detail.push({ rel: p.rel, hits });
    if (hits !== 1) return { dir, landed: false, detail };
    writeFileSync(file, src.replace(p.from, p.to));
  }
  return { dir, landed: true, detail };
}

async function safeSuite(dir, tag) {
  try {
    const T = await loadTarget(dir, tag);
    return await runSuite(T, { verbose: false });
  } catch (e) {
    // ⚠ `failSec: null`（**不是 `[]`**）：崩溃必须与「跑了、0 红」在数据上就分得开
    return { infra: String((e && e.stack) || e), pass: 0, fail: 0, failed: [], failSec: null, secTotal: {} };
  }
}

// ══════════════════════════════════════════════════════════
// 主流程
// ══════════════════════════════════════════════════════════
if (!existsSync(join(ROOT, 'src/ui/readout.js'))) {
  console.log('基础设施不可用：找不到 src/ui/readout.js（task-26 的读数层）');
  process.exit(2);
}

if (!MUTATE) {
  const T = await loadTarget(ROOT, 'repo');
  const S = await runSuite(T, { verbose: VERBOSE });
  const redIds = [...new Set(S.failSec)];
  console.log(`\n${S.fail === 0 ? '\x1b[32m全部通过' : '\x1b[31m有失败'}：${S.pass + S.fail} 项\x1b[0m${S.fail ? `，失败 ${S.fail} 项` : ''}`);
  console.log('LOCK_READOUT_JSON ' + JSON.stringify({
    items: S.pass + S.fail, pass: S.pass, fail: S.fail,
    sections: Object.keys(S.secTotal).length, redIds,
  }));
  if (S.fail) { console.log('失败明细：'); for (const f of S.failed) console.log('  - ' + f); }
  process.exit(S.fail ? 1 : 0);
}

// ── 红档 ──────────────────────────────────────────────────
// ⚠ 缺失 ≠ 空（承接 lead 的全队广播）：判定集读不出来时一律算**基础设施**，绝不当成「0 红」。
//   本探针**不用判定文件**：镜像目录是在本进程里直接 import 的，判定就是 runSuite 的返回值
//   ⇒ 不存在「上一轮留下的判定文件被复用」这条路（`verdictFile: null` 已写进 JSON）。
//   崩溃也不会被读成 0 红：runSuite 抛错由 safeSuite 接住并置 infra，下面先判 infra/缺失，
//   再读红节；且每个变异体的断言条数必须与对照**逐项相同**（防「跑到一半崩溃、红集恰好对得上」）。
const redsOf = (S) => (S && Array.isArray(S.failSec) ? [...new Set(S.failSec)] : null);
/** 本次运行的一次性后缀：镜像目录每跑一次都是**全新路径** ⇒ 目录与 ESM 缓存都不可能被复用 */
const RUN = process.pid.toString(36) + '-' + Date.now().toString(36);

const before = Object.fromEntries(TOUCHED.map((r) => [r, sha256(readFileSync(join(ROOT, r)))]));
const ctrl = await safeSuite(ROOT, 'ctrl');
const ctrlRed = redsOf(ctrl);
const ctrlItems = ctrl.pass + ctrl.fail;
let expectedRed = 0, observedRed = 0, ctrlBad = 0, landed = 0, redsAligned = 0, infra = 0, canaryRed = 0;
const rows = [];
const bad = (msg) => { infra++; console.log('✗ ' + msg); };
if (ctrl.infra) bad('对照（未改动仓库）就崩了：' + ctrl.infra.split('\n')[0]);
else if (ctrlRed === null) bad('对照的判定集读不出来（failSec 不是数组）⇒ 按基础设施处理，不当 0 红');
else if (ctrlItems < 1) bad('对照一项断言都没跑（通过+失败 = 0）⇒ 它的「0 红」不可信');
else if (ctrlRed.length !== 0) { ctrlBad = ctrlRed.length; console.log(`✗ 对照（未改动仓库）不该红，实测红节：${ctrlRed.join(',')}`); }
else console.log(`· 对照（未改动仓库，等价于 null 变异体）：0 红，且真的跑完判定 —— ${ctrlItems} 项断言（${ctrl.pass} 通过）`);

// ⚠ **崩溃自证**（承接 lead 广播第 2 条）：故意让读数层一被调用就抛 —— 判定必须是
//   「infra 且红集读不出来（null）」，**绝不许**落成「0 红 ⇒ 与等价对照同样绿」。
const crashSt = stage('crash-' + RUN, [{
  rel: 'src/ui/readout.js',
  from: '  draw(g, engine) {\n',
  to: '  draw(g, engine) {\n    throw new Error("自证：故意让读数层崩");\n',
}]);
const crashS = crashSt.landed ? await safeSuite(crashSt.dir, 'crash') : { infra: '未落地', failSec: null };
const crashOk = crashSt.landed && !!crashS.infra && redsOf(crashS) === null;
if (!crashSt.landed) bad('崩溃自证没落地（锚点命中次数不为 1）');
else if (!crashOk) bad(`崩溃自证失败：故意抛错的镜像没有被判成「infra + 红集读不出来」（红集=${JSON.stringify(redsOf(crashS))}）`);
else console.log('· 崩溃自证：故意让 draw() 抛错 ⇒ 判为 infra，红集 = null（不会被读成 0 红）');

for (const m of MUTANTS) {
  const st = stage('mut-' + m.id.split('-')[0] + '-' + RUN, m.patches);
  if (!st.landed) {
    bad(`${m.id}：锚点命中次数不为 1 ⇒ 未落地 ${JSON.stringify(st.detail)}`);
    rows.push({ id: m.id, desc: m.desc, landed: false, detail: st.detail, redIds: [] });
    continue;
  }
  landed++;
  const S = await safeSuite(st.dir, m.id);
  const red = redsOf(S);
  if (S.infra) {
    bad(`${m.id}：跑崩了（基础设施，绝不当 0 红） ${S.infra.split('\n')[0]}`);
    rows.push({ id: m.id, desc: m.desc, landed: true, infra: S.infra.split('\n')[0], redIds: [] });
    continue;
  }
  if (red === null) {
    bad(`${m.id}：判定集读不出来（failSec 不是数组）⇒ 按基础设施处理`);
    rows.push({ id: m.id, desc: m.desc, landed: true, infra: 'failSec 不是数组', redIds: [] });
    continue;
  }
  if (S.pass + S.fail !== ctrlItems) {
    bad(`${m.id}：断言条数 ${S.pass + S.fail} ≠ 对照 ${ctrlItems}（跑到一半就停了？红集不可信）`);
    rows.push({ id: m.id, desc: m.desc, landed: true, infra: `断言条数 ${S.pass + S.fail} ≠ ${ctrlItems}`, redIds: red });
    continue;
  }
  if (red.length > 0) canaryRed++;
  const exp = m.expect.slice().sort();
  const aligned = eq(red.slice().sort(), exp);
  if (aligned) redsAligned++;
  expectedRed += m.expect.length;
  observedRed += red.length;
  rows.push({
    id: m.id, desc: m.desc, landed: true,
    landInCode: st.detail.map((d) => d.rel + '@命中' + d.hits + '处').join(' '),
    items: S.pass + S.fail, expect: exp, redIds: red, aligned,
  });
  console.log(`${aligned ? '\x1b[32m✓' : '\x1b[31m✗'}\x1b[0m ${m.id} → 期望 [${exp.join('')}] 实测 [${red.join('')}]`
    + (aligned ? '' : `；失败明细 ${S.failed.slice(0, 2).join(' ／ ')}`));
}
const after = Object.fromEntries(TOUCHED.map((r) => [r, sha256(readFileSync(join(ROOT, r)))]));
const repoIntact = eq(before, after);
const okAll = ctrlBad === 0 && infra === 0 && redsAligned === MUTANTS.length && expectedRed === observedRed
  && repoIntact && canaryRed > 0 && ctrlItems > 0 && crashOk;
console.log('\nLOCK_READOUT_MUTATE ' + JSON.stringify({
  expectedRed, observedRed, ctrlBad, mutants: MUTANTS.length, landed, redsAligned, infra, repoIntact,
  ctrlItems, canaryRed, crashSelfProof: crashOk, verdictFile: null, run: RUN,
  aligned: okAll && redsAligned === MUTANTS.length, ok: okAll,
}));
console.log(JSON.stringify({ rows, repo: before }, null, 1));
process.exit(okAll ? 0 : 1);
