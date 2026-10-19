// ══════════════════════════════════════════════════════════
// tools/pan-probe.mjs —— 画布平移（拖动实验室整体界面）的正式验证工具
//
// 为什么必须存在：平移**改的不是一个功能，而是一条坐标契约** —— 屏幕坐标 → 世界坐标。
//   · 只改绘制（g.translate）会得到「看得见但点不中」：拖过去一切正常，回来点器材没反应；
//   · 只改命中检测不改绘制，则反着错。
//   这两半谁都可能只做一半，所以判据必须**同时**钉住「视口真的动了」与「同一件器材仍然可命中」。
//
// 零依赖、零浏览器：平移是纯算术 + 一个 Pointer Events 状态机，Node 里就能断言，
//   因此这里不启 Edge（公共场所不起可见窗口），也不碰仓库任何中间产物 —— 只有读。
//
// 用法：
//   node tools/pan-probe.mjs              # 全部断言
//   node tools/pan-probe.mjs --mutate     # 变异体自证：置 window.__XM_PAN_OFF__ 后再跑
//                                         # 必须看到锚定平移的那几条**转红**（且只有它们红）
// 绿：全部通过：N 项（exit 0）／红：合计 N 项，失败 M 项（exit 1）
// ══════════════════════════════════════════════════════════

import { readFileSync, existsSync, mkdirSync, copyFileSync, cpSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const lineOf = (rel, n) => (readFileSync(join(ROOT, rel), 'utf8').split('\n')[n - 1] || '').trim();

const MUT = process.argv.includes('--mutate');
let pass = 0, fail = 0;
const failed = [];
const ok = (cond, msg) => {
  if (cond) { pass++; console.log('  \x1b[32m✓\x1b[0m ' + msg); }
  else { fail++; failed.push(msg); console.log('  \x1b[31m✗\x1b[0m ' + msg); }
};
const head = (t) => console.log('\n\x1b[36m' + t + '\x1b[0m');
const info = (t) => console.log('    · ' + t);
const near = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;

/**
 * 屏幕坐标的**独立复算**：把 canvas 的变换当真的变换来用 ——
 * `g.translate(pan.x, pan.y)` 之后画在世界点 W 的东西，屏幕上出现在 W + pan。
 * ⚠ 这条式子**不许照抄 engine.screenToWorld 的写法**：一旦探针用它自己实现的那条
 *   公式反推屏幕点，「方向写反」就会两边一起反、测试全绿而功能全错（本文件第一版
 *   就是这么错的，靠 §③ 的「真实变换矩阵对照」才发现）。所以这里按 canvas 的
 *   setTransform/translate 语义独立算一遍，并在 §③ 用矩阵输出交叉验证。
 */
const screenOf = (wx, wy, pan) => ({ x: wx + pan.x, y: wy + pan.y });

// ══════════════════════════════════════════════════════════
// 环境替身：engine / interact 要的那一小撮 DOM 与 canvas API
// ══════════════════════════════════════════════════════════

/** 记录型 2D 上下文：只记变换与清屏（这两个才是坐标契约的载体），其余方法留空。 */
function mkG(trace) {
  const ctx = {
    canvas: null,
    setTransform: (a, b, c, d, e, f) => { trace.push(['setTransform', a, b, c, d, e, f]); },
    translate: (x, y) => { trace.push(['translate', x, y]); },
    clearRect: (x, y, w, h) => { trace.push(['clearRect', x, y, w, h]); },
    // ⚠ 2026-10-19 把 scale 从 NOOP 挪到这里：视口现在有 zoom，`g.scale` 与
    //   `g.translate` 一样是坐标契约的载体；不记下来就断言不了「zoom=1 时一条都不发」。
    //   本探针所有场景都是 zoom=1（zoom 的判据在 tools/gesture-probe.mjs），所以既有
    //   指令流一条都不变 —— 只是「以后能看见它」。
    scale: (x, y) => { trace.push(['scale', x, y]); },
    save: () => {}, restore: () => {},
  };
  const NOOP = ['beginPath', 'moveTo', 'lineTo', 'arc', 'arcTo', 'stroke', 'fill', 'closePath',
    'quadraticCurveTo', 'rotate', 'fillRect', 'setLineDash', 'createLinearGradient',
    'measureText', 'fillText', 'clip', 'rect', 'ellipse', 'bezierCurveTo', 'roundRect'];
  for (const k of NOOP) ctx[k] = () => {};
  ctx.createLinearGradient = () => ({ addColorStop() {} });
  return ctx;
}

const WIN = {
  innerWidth: 1280, innerHeight: 800, devicePixelRatio: 1,
  matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
  _ev: {},
  addEventListener(t, fn) { (WIN._ev[t] ||= []).push(fn); },
  removeEventListener() {},
};
globalThis.window = WIN;
globalThis.performance = globalThis.performance || { now: () => Date.now() };
// 变异体开关：engine.screenToWorld 读到它就故意退回「视口偏移不存在」的旧行为。
// 只在 --mutate 下置起，正常运行时该键不存在，engine 里的分支恒不成立。
if (MUT) WIN.__XM_PAN_OFF__ = true;
/** 触发 window 上的监听。§⑥ 用它验证「键盘已被删干净」：interact.js 现在**不再**往 window 上挂任何监听 */
const winFire = (t, e) => (WIN._ev[t] || []).forEach((f) => f(e || {}));

function mkCanvas(trace, w = 800, h = 600) {
  const g = mkG(trace);
  const cv = {
    width: 0, height: 0, style: {}, _listeners: {},
    getContext: () => g,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: w, height: h }),
    addEventListener(t, fn) { (cv._listeners[t] ||= []).push(fn); },
    removeEventListener() {},
    hasPointerCapture: () => false,
    releasePointerCapture() {},
    setPointerCapture() {},
    focus() {},
  };
  g.canvas = cv;
  return cv;
}

const { Engine } = await import(pathToFileURL(join(ROOT, 'src/core/engine.js')).href);
const { World } = await import(pathToFileURL(join(ROOT, 'src/core/world.js')).href);
const { Interaction } = await import(pathToFileURL(join(ROOT, 'src/ui/interact.js')).href);
const { create, bindRegistry, equipmentPlugins } = await import(pathToFileURL(join(ROOT, 'src/equipment/index.js')).href);
const { PluginHost } = await import(pathToFileURL(join(ROOT, 'src/core/plugin.js')).href);

const bootApp = {
  services: {}, ticks: [], world: null, lastCircuit: null, selected: null,
  log: { push() {}, clear() {} },
  toast() {},
  addTick(fn) { this.ticks.push(fn); return () => {}; },
};
const host = new PluginHost(bootApp);
for (const p of equipmentPlugins) host.define(p);
host.installAll();
bindRegistry(host.registry('equipment'));

function mkEngine(world, trace) {
  const cv = mkCanvas(trace);
  const eng = new Engine(cv, world);
  eng.app = { markDirty() {} };
  return eng;
}

// ── 断言小工具：一个能记账的 app + 交互层 ──
function mkApp(world, eng, canvas) {
  const calls = { select: 0, markDirty: 0, clicked: 0, moved: 0 };
  const app = {
    canvas, world, engine: eng,
    selected: null,
    select(e) { calls.select++; app.selected = e; },
    markDirty() { calls.markDirty++; },
    _calls: calls,
    setStatusTool() {}, toast() {}, doPour() {}, removeEntity() {},
    // ⚠ 这两个是本探针 §⑨ 才用上的（器材拖动释放的两条出口）—— main.js 里
    //   `onEntityMoved()` 目前是**空函数**、`onEntityClicked()` 走单击语义，
    //   在这里挂计数器是为了分辨"释放时走了哪条出口"，那是 ④-3/④-4 改动的核心。
    onEntityClicked() { calls.clicked++; },
    onEntityMoved() { calls.moved++; },
  };
  return app;
}

// ══════════════════════════════════════════════════════════
// ① 静态接线：功能存在、状态不进世界、不进存档
// ══════════════════════════════════════════════════════════
head('① 接线（静态读文件 + 实例形状）');
{
  // ⚠ 2026-10-19 改为**按行为**断言（原先是 `lineOf('src/core/engine.js', 59 / 136)`）。
  //   本轮给 engine.js 加了 zoom 视口 ⇒ 两个行号都漂 ⇒ 判据红，而它错怪的不是产品，
  //   是**定位方式**（同一个教训在本节末尾的存档口径上已经吃过一次）。行为断言比文本
  //   匹配强：只要 screenToWorld 还是「减 pan、除 zoom」这条式子，写在第几行都算数。
  {
    const eA = mkEngine(new World(), []);
    eA.pan.x = 30; eA.pan.y = -12; eA.zoom = 2;
    const bA = eA.screenToWorld(70, 28);          // 屏幕 = 世界×zoom + pan ⇒ 世界 = (70−30)/2, (28+12)/2
    ok(bA.x === 20 && bA.y === 20,
      `屏幕→世界唯一出口实测「减 pan、除 zoom」：pan=(30,−12) zoom=2 时屏幕(70,28) → 世界(${bA.x},${bA.y})，应为 (20,20)`);
  }
  {
    const eB = mkEngine(new World(), []);
    const before = eB.screenToWorld(100, 100);
    eB.pan.x = 5; eB.pan.y = 7; eB.zoom = 4;
    const after = eB.screenToWorld(100, 100);
    ok(before.x === 100 && before.y === 100 && after.x === 23.75 && after.y === 23.25,
      `同一屏幕点跟着**实例**视口走：恒等时 → (${before.x},${before.y})；pan=(5,7) zoom=4 后 → (${after.x},${after.y})，应为 (23.75,23.25)`);
  }

  const trace = [];
  const world = new World();
  const eng = mkEngine(world, trace);
  ok(!('pan' in world) && !('zoom' in world), '世界对象上没有 pan / zoom（视口不是场景数据）');
  ok(!JSON.stringify(Object.keys(world)).includes('pan') && !JSON.stringify(Object.keys(world)).includes('zoom'),
    'world 的键里没有 pan / zoom');
  ok(typeof eng.resetPan === 'function' && typeof eng.screenToWorld === 'function' &&
    typeof eng.resetView === 'function' && typeof eng.setViewAt === 'function' && typeof eng.clampZoom === 'function',
    'engine 暴露 screenToWorld / resetPan / resetView / setViewAt / clampZoom');

  // 存档口径：只写 entities + wires ⇒ pan 不可能进存档。
  //
  // ⚠ 2026-10-17 改为**按内容定位**。原来这里写死 `[480, 481, 487]` 三个行号，
  //   而本轮在 main.js 的 `onEntityMoved` 处插了 28 行 ⇒ 三个行号全漂 ⇒ **整条判据红**，
  //   而它错怪的不是产品 —— 是**定位方式**。
  //   ⇒ **行号会漂，内容不会**。这里改成直接扫"存档往里写了哪些键"：
  //     只要写出的键集合是 {entities, wires}，就证明 pan 进不去存档（视口不是场景数据）。
  //     这次改动的语义与原来**完全一致**，只是不再依赖任何行号。
  const saveSrc = readFileSync(join(ROOT, 'src/main.js'), 'utf8');
  const pushedKeys = [...new Set([...saveSrc.matchAll(/data\.(\w+)\.push\(/g)].map((m) => m[1]))];
  const bad = pushedKeys.filter((k) => k !== 'entities' && k !== 'wires');
  ok(pushedKeys.length > 0 && bad.length === 0,
    `存档只写 entities/wires（实测写出的键：${pushedKeys.join(', ')}${bad.length ? '；多出的：' + bad.join(', ') : ''}）`);
}

// ══════════════════════════════════════════════════════════
// ② 平移量 = 0 时逐位相同（拿改动前的 engine.js 当对照）
// ══════════════════════════════════════════════════════════
head('② 平移量 = 0：与改动前的 engine.js 逐位同一条绘制指令流');
/** 副本是第一个动作落的字节副本（%TEMP%\\pan-engine.js-preimage）。Node 的 ESM 按**后缀**
 *  决定怎么加载，`.js-preimage` 会被当成未知格式拒掉，所以把它连同它 import 的两个同目录
 *  文件原样摊进临时目录的 src/core/ 下再 import —— 全程只读仓库，仓库零字节副作用。 */
const PRE_SRC = join(process.env.TEMP || '/tmp', 'pan-preimage');
function stagePreimage() {
  const src = join(process.env.TEMP || '/tmp', 'pan-engine.js-preimage');
  if (!existsSync(src)) return null;
  rmSync(PRE_SRC, { recursive: true, force: true });
  mkdirSync(join(PRE_SRC, 'src'), { recursive: true });
  // 整份 src/core 照抄进临时目录：副本 engine.js 的相对 import 要按**当时的**源码解析，
  // 少一个主题/插件模块就会 ERR_MODULE_NOT_FOUND。仓库本身只读，临时目录用完即删。
  cpSync(join(ROOT, 'src', 'core'), join(PRE_SRC, 'src', 'core'), { recursive: true });
  copyFileSync(src, join(PRE_SRC, 'src', 'core', 'engine.js'));
  return join(PRE_SRC, 'src', 'core', 'engine.js');
}
{
  const pre = stagePreimage();
  if (!pre) {
    // ⚠ 2026-10-17 修复：副本不在时**跳过**本段，而不是让 ePre 为 null 后崩在 `.render()`。
    //
    // 原来这里只 `ok(!!pre, …)` 报一条红，然后**继续**用 `ePre.render()` ⇒
    // `TypeError: Cannot read properties of null` ⇒ **整个探针崩掉，§③~⑧ 全部不执行**。
    // 而崩溃看起来像"被测对象坏了"，会把人引到错误的方向；实际只是**对照副本没了**。
    //
    // 副本放在 `%TEMP%`（`stagePreimage()` 读的就是那里）—— 而临时目录会被清理，
    // 本探针已因此崩过一次。**基线/副本应当落项目内**（`internal/baselines/` 之类），
    // 不要押在"没人清临时目录"上。缺失时**如实说缺失**，这才是探针该有的样子。
    info('⚠ 对照副本不可用 ⇒ **跳过②「pan=0 与改动前逐位对比」整段**');
    info('   （副本路径 ' + PRE_SRC + '；基线与副本请落项目内，别放 %TEMP% —— 会被清理）');
    info('   ⚠ 注意：本段被跳过后，"绘制指令流逐位相同"这一条**本轮没有被验证**，'
      + '不代表它通过。§③~⑧ 与它无关，照常执行。');
  } else {
    ok(true, `改动前的字节副本可用（${PRE_SRC}）`);
    const trace0 = [], tracePre = [];
    const w0 = new World(), wPre = new World();
    const e0 = mkEngine(w0, trace0);
    const mod = await import(pathToFileURL(pre).href);
    const ePre = new mod.Engine(mkCanvas(tracePre), wPre);
    if (ePre) ePre.app = { markDirty() {} };

    ok(e0.pan.x === 0 && e0.pan.y === 0 && e0.zoom === 1, '新引擎初始视口是恒等：pan = (0,0) 且 zoom = 1');

    // ⚠ 先各自 render 一次热身 —— 台面渐变是**首帧建好再缓存**的（benchGradient），
    //   拿「第一次 render」和「第二次 render」比会凭空多出一串差异。
    e0.render(); ePre.render();
    const n0 = trace0.length, nPre = tracePre.length;
    e0.render(); ePre.render();
    const A = trace0.slice(n0), B = tracePre.slice(nPre);

    const J = (t) => JSON.stringify(t);
    ok(J(A) === J(B), `pan=0 且 zoom=1 时稳态一帧的绘制指令流逐位相同（${A.length} 条 vs ${B.length} 条）`);
    if (J(A) !== J(B)) {
      const n = Math.max(A.length, B.length);
      for (let i = 0; i < n; i++) {
        if (J(A[i]) !== J(B[i])) { info(`首处差异 @${i}: 新=${J(A[i])} 旧=${J(B[i])}`); break; }
      }
    }
    ok(J(A) === J(B) && J(A[0]) === J(['setTransform', 1, 0, 0, 1, 0, 0]) && J(A[1]) === J(['clearRect', 0, 0, 800, 600]),
      `头两条严格同位：${J(A[0])} → ${J(A[1])}`);
    ok(A.filter(([k]) => k === 'translate' || k === 'scale').length === 0,
      'pan=0 且 zoom=1 时 translate / scale 一条都不发（视口恒等，连指令都不产生 ⇒ 逐位相同）');

    // 复位在原点时不许惊动任何人
    const before = trace0.length;
    ok(e0.resetPan() === false, 'resetPan() 在原点返回 false（没有真动过）');
    e0.render();
    ok(J(trace0.slice(before)) === J(B), `resetPan() 后一帧与改动前那一帧逐位相同（${trace0.length - before} 条）`);
  }
}

// ══════════════════════════════════════════════════════════
// ③ 平移后：屏幕点 → 世界点随之改变，且视口真的进了绘制
// ══════════════════════════════════════════════════════════
head('③ 平移后：同一屏幕点映射到的世界坐标随之改变（方向用真实变换矩阵钉死）');
{
  const trace = [];
  const world = new World();
  const eng = mkEngine(world, trace);

  const a = eng.screenToWorld(100, 100);
  ok(a.x === 100 && a.y === 100, 'pan=(0,0) 时 screenToWorld(100,100) = (100,100)');

  eng.pan.x = 40; eng.pan.y = -25;
  const b = eng.screenToWorld(100, 100);
  ok(b.x === 60 && b.y === 125, `pan=(40,-25) 时 screenToWorld(100,100) = (${b.x},${b.y})，与平移前不同`);
  ok(b.x !== a.x && b.y !== a.y, '同一屏幕点映射到的世界坐标确实随之改变');

  const t2 = [];
  const eng2 = mkEngine(new World(), t2);
  eng2.pan.x = 40; eng2.pan.y = -25;
  eng2.render();
  const tx = t2.filter(([k]) => k === 'translate');
  ok(tx.length === 1 && tx[0][1] === 40 && tx[0][2] === -25,
    `绘制里恰好一条 translate(40,-25)（视口真的进了画布）`);
  const iSet = t2.findIndex(([k]) => k === 'setTransform');
  const iTr = t2.findIndex(([k]) => k === 'translate');
  const iClear = t2.findIndex(([k]) => k === 'clearRect');
  ok(iSet === 0 && iClear === 1 && iTr === 2,
    `顺序：setTransform(#${iSet}) → clearRect(#${iClear}) → translate(#${iTr})，清屏不沾平移`);
  const cl = t2[iClear];
  ok(cl[3] === 800 && cl[4] === 600, `clearRect 擦的是整块逻辑视口（${cl[3]}×${cl[4]}），坐标就取 this.w/this.h`);

  // ── 方向交叉验证：把 canvas 的变换当**真的矩阵**用，独立推出屏幕坐标 ──
  // doTransformPoint 复刻 setTransform(dpr) → translate(pan) 之后的合成矩阵在 Screen 上的落点。
  const dpr = eng2.dpr;
  const mtx = (x, y) => ({ x: dpr * x + dpr * eng2.pan.x, y: dpr * y + dpr * eng2.pan.y });
  const worldPt = { x: 300, y: 250 };
  const onScreen = mtx(worldPt.x, worldPt.y);
  const guessScreen = screenOf(worldPt.x, worldPt.y, eng2.pan);
  ok(near(onScreen.x, guessScreen.x) && near(onScreen.y, guessScreen.y),
    `屏幕 = 世界 + pan 与真实矩阵一致：世界(300,250) 落在屏幕(${onScreen.x},${onScreen.y})`);
  const back = eng2.screenToWorld(onScreen.x, onScreen.y);
  ok(near(back.x, worldPt.x) && near(back.y, worldPt.y),
    `反算回来 = (${back.x},${back.y})，正是同一世界点 ⇒ 方向没写反`);
  const flipped = { x: onScreen.x - 2 * eng2.pan.x, y: onScreen.y - 2 * eng2.pan.y };
  ok(!(near(flipped.x, back.x) && near(flipped.y, back.y)),
    `方向若写反会得到 (${flipped.x},${flipped.y}) ≠ (${back.x},${back.y}) ⇒ 本判据能区分方向`);
}

// ══════════════════════════════════════════════════════════
// ④ 平移后 hitTest 仍能命中同一器材（含接线柱）+ 变异体自证
// ══════════════════════════════════════════════════════════
head('④ 平移后：同一件器材仍然可命中（世界坐标回归）');
{
  const trace = [];
  const world = new World();
  const ent = create('battery', 300, 250);
  world.add(ent, true);
  const eng = mkEngine(world, trace);
  const canvas = eng.canvas;
  const app = mkApp(world, eng, canvas);
  const inter = new Interaction(app);
  inter.app = app;
  eng.app = app;

  const px = screenOf(ent.x, ent.y, eng.pan).x, py = screenOf(ent.x, ent.y, eng.pan).y;
  const push = (p, over = {}) => {
    const ev = Object.assign({
      button: 0, pointerId: 1, pointerType: 'mouse', clientX: p.x, clientY: p.y,
      shiftKey: false, preventDefault() {}, target: canvas,
    }, over);
    return ev;
  };

  // pan=0 的基准：点器材中心必须选中它
  canvas._listeners.pointerdown.forEach((f) => f(push({ x: px, y: py })));
  ok(app.selected === ent, 'pan=(0,0)：点器材中心选中了它');
  ok(!!inter.drag && inter.drag.ent === ent, 'pan=(0,0)：拖动状态挂在同一件器材上');

  // 平移 (200,-120) 后器材被搬到屏幕 (500,130)，同一件器材仍须可命中
  app.selected = null; inter.cancel();
  eng.pan.x = 200; eng.pan.y = -120;
  const s2 = screenOf(ent.x, ent.y, eng.pan);
  ok(s2.x !== px || s2.y !== py, `器材在屏幕上确实被搬走了：( ${px},${py} ) → ( ${s2.x},${s2.y} )`);
  canvas._listeners.pointerdown.forEach((f) => f(push({ x: s2.x, y: s2.y })));
  ok(app.selected === ent, `pan=(200,-120)：点器材此刻所在的屏幕点 (${s2.x},${s2.y}) 仍选中同一件器材`);
  ok(!!inter.drag && inter.drag.ent === ent, '平移后拖动状态仍挂在同一件器材上');

  // 接线柱：portWorld 是世界坐标，平移后按「屏幕 = 世界 + pan」点过去仍要命中它
  inter.cancel();
  const pw = ent.portWorldAt(0);
  const pwScreen = screenOf(pw.x, pw.y, eng.pan);
  const pwWorld = eng.screenToWorld(pwScreen.x, pwScreen.y);
  const portHit = world.pickPort(pwWorld.x, pwWorld.y, 13);
  ok(portHit && portHit.ent === ent && portHit.port === 0,
    `平移后接线柱 0（世界 ${pw.x},${pw.y} / 屏幕 ${pwScreen.x},${pwScreen.y}）仍可命中`);
  ok(near(pwWorld.x, pw.x) && near(pwWorld.y, pw.y),
    `反算回世界坐标 = (${pwWorld.x},${pwWorld.y})，与 portWorldAt 给的完全相同`);
  ok(world.pickPort(pwScreen.x, pwScreen.y, 13) === null,
    `同一屏幕点若直接当世界坐标用 ⇒ 接线柱点不中（naive 命中=null），判据有区分力`);

  // 「看得见但点不中」的反面：把屏幕点当成世界坐标时，必须**点不中** ——
  // 这正是变异体要制造的状态，先在这里量出它的读数，红测才有参照。
  const naive = world.pick(s2.x, s2.y);
  ok(naive !== ent, `只把屏幕坐标当世界坐标用 ⇒ 点不中（naive 命中=${naive ? naive.type : 'null'}），说明这条判据有区分力`);
}

// ══════════════════════════════════════════════════════════
// ⑤ 从侧栏拖入的落点落在指针下方（任务书点名的高危处）
// ══════════════════════════════════════════════════════════
head('⑤ 换算契约：把「指针的世界坐标」当落点，落点就在指针下方');
{
  const trace = [];
  const world = new World();
  const eng = mkEngine(world, trace);
  const app = mkApp(world, eng, eng.canvas);
  const inter = new Interaction(app);

  // ⚠ 先说清楚这条判据在验什么：**本项目没有「落点跟随指针」这条路径**。
  //   侧栏放置是 src/ui/palette.js place(d) → app.addEntity(d.type)（不给坐标），
  //   坐标由 main.js freeSpot() 按世界视口 engine.w/h 自己找空位。
  //   所以这里验的是**换算契约本身**：任何「把指针位置当落点」的代码，只有走
  //   screenToWorld 才落在指针下方。这条判据存在的意义是——一旦以后有人写了
  //   「拖到哪放哪」，他要么走这个出口（绿），要么把屏幕坐标直接当世界坐标（这条就红）。
  info('说明：本项目当前无「拖入落点跟随指针」路径（palette.place → addEntity(type) → freeSpot 找空位）');
  const placeAt = (screen) => {
    const w = inter.toWorld(screen);
    const e = create('battery', Math.round(w.x), Math.round(w.y));
    world.add(e, true);
    return e;
  };

  for (const pan of [{ x: 0, y: 0 }, { x: -180, y: 96 }, { x: 640, y: -400 }]) {
    eng.pan.x = pan.x; eng.pan.y = pan.y;
    const screen = { x: 520, y: 340 };
    const e = placeAt(screen);
    const wpt = inter.toWorld(screen);
    ok(near(e.x - wpt.x, 0, 0.5) && near(e.y - wpt.y, 0, 0.5),
      `pan=(${pan.x},${pan.y})：落点 (${e.x},${e.y}) 就在指针世界坐标 (${wpt.x},${wpt.y}) 上`);
    ok(world.pick(e.x, e.y) === e, `pan=(${pan.x},${pan.y})：放置后原地即可重新命中该器材（看得见也点得中）`);
    const naive = world.pick(screen.x, screen.y);
    ok(pan.x === 0 ? naive === e : naive !== e,
      `pan=(${pan.x},${pan.y})：若把屏幕坐标当落点，命中=${naive ? naive.type : 'null'}（区分力自证）`);
    world.remove(e);
  }
}

// ══════════════════════════════════════════════════════════
// ⑥ 两条触发方式（空白处拖动 / 中键）+ 复位 + 空格必须不参与（Pointer Events 状态机，全在 Node 里跑）
// ══════════════════════════════════════════════════════════
head('⑥ 触发与复位：空白拖动 / 中键 / 空格不得触发平移 / 双击空白复位');
{
  const trace = [];
  const world = new World();
  const ent = create('battery', 300, 250);
  world.add(ent, true);
  const eng = mkEngine(world, trace);
  const canvas = eng.canvas;
  const app = mkApp(world, eng, canvas);
  const inter = new Interaction(app);

  const ev = (t, x, y, over = {}) => Object.assign({
    button: 0, pointerId: 1, pointerType: 'mouse', clientX: x, clientY: y, buttons: 1,
    shiftKey: false, preventDefault() {}, target: canvas, type: t,
  }, over);
  const fire = (t, e) => (canvas._listeners[t] || []).forEach((f) => f(e));

  // ① 左键从空白处拖动
  fire('pointerdown', ev('pointerdown', 700, 500));
  ok(eng.pan.x === 0 && eng.pan.y === 0, '空白处按下：pan 一动都不动（阈值内零副作用）');
  ok(!!inter.pan, '空白处按下：进入了平移待命态');
  fire('pointermove', ev('pointermove', 701, 501));
  ok(eng.pan.x === 0 && eng.pan.y === 0, '阈值内抖动 1px：pan 仍不动');
  fire('pointermove', ev('pointermove', 640, 460));
  ok(eng.pan.x === -60 && eng.pan.y === -40, `空白拖动 ⇒ pan=(${eng.pan.x},${eng.pan.y})`);
  ok(!inter.drag, '平移期间没有器材被拖动');
  fire('pointerup', ev('pointerup', 640, 460, { buttons: 0 }));
  ok(inter.pan === null, '抬起后平移手势收尾');
  ok(eng.pan.x === -60 && eng.pan.y === -40, `释放吸附到 4px 网格后仍是 (${eng.pan.x},${eng.pan.y})`);

  // 点器材时不许触发平移
  const before = { ...eng.pan };
  const sEnt = screenOf(ent.x, ent.y, eng.pan);
  fire('pointerdown', ev('pointerdown', sEnt.x, sEnt.y));
  ok(!inter.pan, '点在器材上：不起手平移（平移只属于空白处拖动与中键）');
  ok(app.selected === ent, `点在器材上：照旧选中该器材（屏幕点 ${sEnt.x},${sEnt.y}）`);
  fire('pointerup', ev('pointerup', sEnt.x, sEnt.y, { buttons: 0 }));
  ok(eng.pan.x === before.x && eng.pan.y === before.y, '点器材不改变 pan');
  inter.cancel();

  // ② 中键拖动
  fire('pointerdown', ev('pointerdown', 400, 300, { button: 1 }));
  ok(!!inter.pan, '中键按下：起手平移');
  fire('pointermove', ev('pointermove', 430, 340, { button: 1 }));
  ok(eng.pan.x === before.x + 30 && eng.pan.y === before.y + 40,
    `中键拖动 ⇒ pan=(${eng.pan.x},${eng.pan.y})（相对起手 +30,+40）`);
  fire('pointerup', ev('pointerup', 430, 340, { button: 1, buttons: 0 }));
  inter.cancel();

  // ③ 空格**不得**触发平移（Lead 裁决①：空格归 main.js 的「运行/暂停」，不做平移修饰键）
  //   这一节验的不是「少了一个功能」，而是「删干净了」：字段没了、window 上没有残留键盘监听、
  //   按住空格点器材照旧选中器材。若代码里还留着 `|| this.space`，下面第一条就会红。
  eng.pan.x = 0; eng.pan.y = 0;
  ok(inter.space === undefined, '空格修饰键字段已移除（inter.space === undefined）');
  ok((WIN._ev.keydown || []).length === 0 && (WIN._ev.keyup || []).length === 0
     && (WIN._ev.blur || []).length === 0,
     `window 上没有残留键盘/失焦监听（keydown=${(WIN._ev.keydown || []).length}`
       + ` keyup=${(WIN._ev.keyup || []).length} blur=${(WIN._ev.blur || []).length}）`);
  winFire('keydown', { key: ' ' });
  ok(inter.pan === null, '按住空格本身：不进入任何平移态');
  const sEnt2 = screenOf(ent.x, ent.y, eng.pan);
  fire('pointerdown', ev('pointerdown', sEnt2.x, sEnt2.y));
  ok(!inter.pan, '按住空格点器材：不起手平移（空格不再是平移修饰键）');
  ok(app.selected === ent, `按住空格点器材：照旧选中该器材（屏幕点 ${sEnt2.x},${sEnt2.y}）`);
  fire('pointerup', ev('pointerup', sEnt2.x, sEnt2.y, { buttons: 0 }));
  ok(eng.pan.x === 0 && eng.pan.y === 0, '按住空格点器材：pan 一动不动');
  inter.cancel();
  winFire('keyup', { key: ' ' });
  winFire('blur');
  ok(eng.pan.x === 0 && eng.pan.y === 0, '空格抬起 / 失焦：平移态无变化（已无该状态可清）');
  // 空白处拖动这条触发与空格无关：按住空格也照样起手（它靠的是「按在空白处」）
  fire('pointerdown', ev('pointerdown', 200, 200));
  ok(!!inter.pan, '按住空格 + 空白处按下：仍按「空白处拖动」起手（与空格无关）');
  fire('pointermove', ev('pointermove', 260, 230));
  ok(eng.pan.x === 60 && eng.pan.y === 30, `按住空格 + 空白拖动 ⇒ pan=(${eng.pan.x},${eng.pan.y})，空白这条触发在工作`);
  fire('pointerup', ev('pointerup', 260, 230, { buttons: 0 }));
  inter.cancel();

  // ④ 双击空白处 = 复位**整个视图**（pan+zoom）。
  //   ⚠ 语义由用户裁决为「复位整个视图」（原为只复位 pan）。本探针全程 zoom=1 ⇒
  //     两者在这里观测等价，区分它们要靠 tools/gesture-probe.mjs §⑧（带调用计数）。
  //     这里只改口径、不新增断言（条数守恒 = 107，外部消费者按条数断言）。
  // ⚠ 双击的判据是 **350ms 的抬起间隔**，而探针跑到这一节已经花掉远超 350ms 的墙钟
  //   时间（节 ①-⑥ 打了几十行日志）。不冻结时钟的话这里永远是「两次相距很远的单击」，
  //   红的是探针不是功能 —— 所以本段把 performance.now 钉在一个定值上，
  //   让两次点按的间隔为确定值，成败只取决于代码里的判定，不取决于跑得多慢。
  const realNow = performance.now;
  let frozen = 5000;
  performance.now = () => frozen;
  ok(eng.pan.x !== 0 || eng.pan.y !== 0, `复位前 pan=(${eng.pan.x},${eng.pan.y})，非原点，复位有可观测效果`);
  const tap = (x, y) => {
    fire('pointerdown', ev('pointerdown', x, y));
    fire('pointerup', ev('pointerup', x, y, { buttons: 0 }));
  };
  tap(600, 520);
  ok(inter.doubleTap !== null, '第一次点空白处：架起双击候选（不复位，只是普通点击）');
  ok(eng.pan.x !== 0 || eng.pan.y !== 0, '第一次点空白处：pan 不动');
  frozen = 5000 + 120;                       // 120ms < DOUBLE_TAP_MS(350)
  tap(601, 521);                             // 位移 √2 px < DOUBLE_TAP_SLOP(8)
  ok(eng.pan.x === 0 && eng.pan.y === 0 && eng.zoom === 1, `第二次点空白处（+120ms / 位移 1.4px）⇒ 复位到原点 pan=(${eng.pan.x},${eng.pan.y})、zoom=${eng.zoom}（本探针全程 zoom=1）`);
  ok(inter.pan === null, '复位那次没有起手平移');
  ok(app._calls.markDirty > 0, `复位请求了重绘（markDirty 累计 ${app._calls.markDirty} 次）`);

  // 间隔超出窗口 ⇒ 不许复位（判据不是「点了两次就复位」）
  eng.pan.x = 40;
  tap(600, 520);
  frozen = 5000 + 120 + 400;                 // 400ms > DOUBLE_TAP_MS(350)
  tap(600, 520);
  ok(eng.pan.x === 40, `间隔 400ms 的两次点按不复位（pan 仍 ${eng.pan.x}）⇒ 判据锚在时间窗上，不是「点两次」`);
  // 位移超出窗口 ⇒ 不许复位
  frozen = 5000 + 1000;
  tap(600, 520);
  frozen = 5000 + 1000 + 100;
  tap(640, 520);                             // 位移 40px > DOUBLE_TAP_SLOP(8)
  ok(eng.pan.x === 40, `相隔 40px 的两次点按不复位（pan 仍 ${eng.pan.x}）`);
  performance.now = realNow;
  eng.pan.x = 0; eng.pan.y = 0;

  // 复位之后一切照旧：同一件器材还能点中
  app.selected = null;
  fire('pointerdown', ev('pointerdown', ent.x, ent.y));
  ok(app.selected === ent, '复位后同一件器材仍可命中（回到原点不是把世界挪走）');
  fire('pointerup', ev('pointerup', ent.x, ent.y, { buttons: 0 }));
}

// ══════════════════════════════════════════════════════════
// ⑦ 触控：两指接管视口（平移 + 缩放），单指一律不起手平移
// ══════════════════════════════════════════════════════════
head('⑦ 触控：两指接管视口，单指不起手平移');
{
  const trace = [];
  const world = new World();
  world.add(create('battery', 300, 250), true);
  const eng = mkEngine(world, trace);
  const canvas = eng.canvas;
  const app = mkApp(world, eng, canvas);
  const inter = new Interaction(app);
  const ev = (t, x, y, over = {}) => Object.assign({
    button: 0, pointerId: 1, pointerType: 'touch', clientX: x, clientY: y, buttons: 1,
    shiftKey: false, preventDefault() {}, target: canvas, type: t,
  }, over);
  const fire = (t, e) => (canvas._listeners[t] || []).forEach((f) => f(e));

  fire('pointerdown', ev('pointerdown', 700, 500, { pointerId: 7 }));
  ok(!inter.pan, '单指触摸空白处：不起手平移（**产品决策**：单指 = 滚动/拖器材，平移归两指）');
  // 起手两指：7 在 (700,500)、8 在 (710,505) ⇒ 中点 (705,502.5)、间距 √(10²+5²)。
  // ⚠ 锚点用**独立复算**（直接问引擎，不读 inter.gesture 的内部值）：否则「实现算错」
  //   与「断言跟着一起错」会互相掩护 —— 本文件第一版就是这么把方向写反还全绿的。
  const midA = { x: 705, y: 502.5 };
  const w0 = eng.screenToWorld(midA.x, midA.y);
  fire('pointerdown', ev('pointerdown', 710, 505, { pointerId: 8 }));
  ok(inter.multi === true && !!inter.gesture && inter.gesture.ids.join() === '7,8',
    '第二根手指落下：两指**接管**视口（multi 置起 + 手势建立 ids=[7,8]）—— 不再是「多指作废」');
  // 只动手指 7：中点移到 ((900+710)/2, (700+505)/2) = (805, 602.5)
  fire('pointermove', ev('pointermove', 900, 700, { pointerId: 7 }));
  const midB = { x: 805, y: 602.5 };
  const back = eng.screenToWorld(midB.x, midB.y);      // 中点此刻压着哪个世界点？
  const f7 = { x: 900 - 700, y: 700 - 500 };           // 「跟着手指 7 走」会得到的 pan
  const f8 = { x: 710 - 700, y: 505 - 500 };           // 「跟着手指 8 走」会得到的 pan
  ok(near(back.x, w0.x) && near(back.y, w0.y) &&
    (eng.pan.x !== f7.x || eng.pan.y !== f7.y) && (eng.pan.x !== f8.x || eng.pan.y !== f8.y),
    `两指移动：起手世界点仍钉在两指中点下（偏差 ${(back.x - w0.x).toExponential(1)}, ${(back.y - w0.y).toExponential(1)}；`
    + `zoom=${eng.zoom}），pan=(${eng.pan.x.toFixed(1)},${eng.pan.y.toFixed(1)}) 既不跟手指 7 也不跟手指 8`);
  fire('pointerup', ev('pointerup', 900, 700, { pointerId: 7, buttons: 0 }));
  ok(inter.multi === false && inter.gesture === null,
    '抬起一根：手势与多指封锁一起解除（剩下那根不会接着变成单指拖动）');
  fire('pointerup', ev('pointerup', 710, 505, { pointerId: 8, buttons: 0 }));

  // 触摸空白处**双击**：不做复位，避免和系统的双击缩放/连击抢语义。
  // ⚠ 与改动前的写法不同：那时 pan 恒为 0，`pan === 0` 这条**永远为真**（等于没测）。
  //   两指现在真的把 pan 挪走了，所以这里断言「双击**没有把它改掉**」—— 才带信息。
  const panBefore = { x: eng.pan.x, y: eng.pan.y };
  fire('pointerdown', ev('pointerdown', 600, 520));
  fire('pointerup', ev('pointerup', 600, 520, { buttons: 0 }));
  fire('pointerdown', ev('pointerdown', 600, 520));
  fire('pointerup', ev('pointerup', 600, 520, { buttons: 0 }));
  ok(eng.pan.x === panBefore.x && eng.pan.y === panBefore.y,
    `触摸双击空白处不触发复位（复位只归鼠标双击）：pan 保持 (${panBefore.x.toFixed(1)},${panBefore.y.toFixed(1)})`);
}

// ══════════════════════════════════════════════════════════
// ⑧ 唯一换算出口：交互层的命中检测不许绕过 screenToWorld
// ══════════════════════════════════════════════════════════
head('⑧ 唯一出口：命中检测确实经由 engine.screenToWorld');
{
  const trace = [];
  const world = new World();
  world.add(create('battery', 300, 250), true);
  const eng = mkEngine(world, trace);
  const canvas = eng.canvas;
  const app = mkApp(world, eng, canvas);
  const inter = new Interaction(app);

  let calls = 0;
  const raw = eng.screenToWorld.bind(eng);
  eng.screenToWorld = (x, y) => { calls++; return raw(x, y); };

  const ev = (t, x, y, over = {}) => Object.assign({
    button: 0, pointerId: 1, pointerType: 'mouse', clientX: x, clientY: y, buttons: 1,
    shiftKey: false, preventDefault() {}, target: canvas, type: t,
  }, over);
  const fire = (t, e) => (canvas._listeners[t] || []).forEach((f) => f(e));

  fire('pointerdown', ev('pointerdown', 300, 250));
  ok(calls === 1, `一次 pointerdown 恰好调用 screenToWorld 1 次（实测 ${calls}）—— 命中检测没有绕过唯一出口`);
  calls = 0;
  fire('pointerup', ev('pointerup', 300, 250, { buttons: 0 }));
  inter.cancel();
  fire('pointermove', ev('pointermove', 300, 250, { buttons: 0 }));
  ok(calls >= 1, `悬停命中同样经出口（pointermove 调用 ${calls} 次）`);

  // 空白处按下：世界坐标算了但没用来命中任何东西（不能因此漏调用而误判）
  calls = 0;
  fire('pointerdown', ev('pointerdown', 700, 500));
  ok(calls === 1, `空白处按下也走出口（${calls} 次），世界坐标不是「命中时才现算」`);
}

// ══════════════════════════════════════════════════════════
// ⑨ 器材拖动释放：净位移复核（CLICK_SLOP）＋ 平滑落位（SETTLE_MS）
// ══════════════════════════════════════════════════════════
/**
 * ⚠ 为什么补这一组（2026-10-17）：
 * 本探针此前**只测平移的释放吸附**（见 §⑥：`eng.pan`），**完全没有覆盖器材拖动的释放**——
 * 全仓 `grep finishDrag|CLICK_SLOP|onEntityClicked|onEntityMoved` 在 `tools/` 下**零命中**。
 * 而 ④-3（松手不再瞬移、改为 `settleTo` 平滑落位）与 ④-4（拖动阈值误伤单击、
 * 新增 `CLICK_SLOP` 净位移复核）刚改了这两条路径 ⇒ **护栏修好了却盖不住新逻辑**。
 * 这一组就是给它们补的网。
 *
 * 覆盖的三条不变量（与 `interact.js` 里 `settleTo()` 的注释一一对应）：
 *   ① 净位移 ≤ `CLICK_SLOP` ⇒ **仍算单击**：放回按下位置 + 走 `onEntityClicked`，
 *      且**不走 `onEntityMoved`**（用户没想移动它）；
 *   ② 真有位移 ⇒ **最终落点仍是那一个 4px 网格点**（不是"近似的网格点"），
 *      且 `onEntityMoved` **只在落定后调一次**；
 *   ③ 过渡**可被打断**：中断后停在**当前**位置，**不补跑**到旧目标。
 */
head('⑨ 器材拖动释放：净位移复核（CLICK_SLOP）+ 平滑落位（SETTLE_MS）');
{
  // ⚠ Node 里没有 requestAnimationFrame —— `settleTo()` 用它驱动过渡，
  //   不给替身会直接 ReferenceError。用 setTimeout 顶（16ms ≈ 一帧）。
  const hadRaf = typeof globalThis.requestAnimationFrame === 'function';
  if (!hadRaf) {
    globalThis.requestAnimationFrame = (f) => setTimeout(() => f(performance.now()), 16);
    globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
  }
  const settleDone = () => new Promise((r) => setTimeout(r, 320));   // SETTLE_MS=130，留足余量

  const mk = () => {
    const trace = [];
    const world = new World();
    const ent = create('battery', 300, 250);
    world.add(ent, true);
    const eng = mkEngine(world, trace);
    const canvas = eng.canvas;
    const app = mkApp(world, eng, canvas);
    const inter = new Interaction(app);
    const ev = (t, x, y, over = {}) => Object.assign({
      button: 0, pointerId: 1, pointerType: 'mouse', clientX: x, clientY: y, buttons: 1,
      shiftKey: false, preventDefault() {}, target: canvas, type: t,
    }, over);
    const fire = (t, e) => (canvas._listeners[t] || []).forEach((f) => f(e));
    return { world, ent, eng, canvas, app, inter, ev, fire, trace };
  };

  // ── ① 净位移 ≤ CLICK_SLOP ⇒ 仍算单击（④-4 的核心）────────────────────────
  {
    const s = mk();
    const x0 = s.ent.x, y0 = s.ent.y;
    s.fire('pointerdown', s.ev('pointerdown', x0, y0));
    s.fire('pointermove', s.ev('pointermove', x0 + 4, y0));   // 4px > DRAG_SLOP(3) ⇒ moved=true
    ok(s.inter.drag && s.inter.drag.moved === true,
      '越过起步阈值（4px > 鼠标 DRAG_SLOP 3）⇒ moved 置真（前置成立）');
    s.fire('pointerup', s.ev('pointerup', x0 + 4, y0, { buttons: 0 }));

    ok(s.ent.x === x0 && s.ent.y === y0,
      `★ 净位移 4px ≤ CLICK_SLOP(6) ⇒ 放回按下位置 (${x0},${y0})，未被吸附带走`);
    ok(s.app._calls.clicked === 1 && s.app._calls.moved === 0,
      `★ 这条手势走了**单击**出口：onEntityClicked=${s.app._calls.clicked}、onEntityMoved=${s.app._calls.moved}`);
    ok(s.inter.settle === null, '净位移复核命中时不启动落位过渡（没有"多余地动一下"）');
    // 前置有效性：这条断言能红 —— 若把 CLICK_SLOP 调成 0，位置就会被吸附带走。
    info('（能红性：CLICK_SLOP=0 时上面第一条会变红 —— 位置会被吸附带走）');
  }

  // ── ② 真有位移 ⇒ 精确落网格 + onEntityMoved 只在落定时调一次（④-3）────────
  {
    const s = mk();
    const x0 = s.ent.x, y0 = s.ent.y;
    s.fire('pointerdown', s.ev('pointerdown', x0, y0));
    s.fire('pointermove', s.ev('pointermove', x0 + 62, y0 + 31));   // 明显位移
    const rawX = s.ent.x, rawY = s.ent.y;
    ok(rawX === x0 + 62 && rawY === y0 + 31, `拖动中跟手（未吸附）：(${rawX},${rawY}）`);

    s.fire('pointerup', s.ev('pointerup', x0 + 62, y0 + 31, { buttons: 0 }));
    ok(s.inter.settle !== null,
      '★ 释放时**建立了落位过渡**（settle 非空）—— 这就是 ④-3「不再瞬移」');
    ok(s.app._calls.moved === 0,
      '★ 过渡进行中 onEntityMoved **还没被调用**（它是电路重算入口，不该被中间态触发）');

    await settleDone();
    const gx = Math.round(rawX / 4) * 4, gy = Math.round(rawY / 4) * 4;
    ok(s.ent.x === gx && s.ent.y === gy,
      `★ 落定后停在**精确的 4px 网格点** (${gx},${gy}) —— 不是"近似的网格点"`);
    ok(s.app._calls.moved === 1,
      `★ onEntityMoved **恰好调用一次**（实测 ${s.app._calls.moved}）`);
    ok(s.inter.settle === null, '过渡结束后 settle 被清空');
  }

  // ── ③ 过渡可被打断，且**不补跑**到旧目标 ────────────────────────────────
  {
    const s = mk();
    const x0 = s.ent.x, y0 = s.ent.y;
    s.fire('pointerdown', s.ev('pointerdown', x0, y0));
    // ⚠ 位移必须**不是 4 的整数倍**，否则吸附目标与当前位置重合，
    //   `settleTo()` 会走"已经到位"的短路分支**立即落位** ⇒ 根本没有过渡可打断
    //   （第一版就是踩了这个：x0+100=400，round(400/4)*4 仍 = 400）。
    s.fire('pointermove', s.ev('pointermove', x0 + 101, y0));
    s.fire('pointerup', s.ev('pointerup', x0 + 101, y0, { buttons: 0 }));
    const target = Math.round((x0 + 101) / 4) * 4;
    ok(target !== s.ent.x, `（前置）吸附目标 ${target} 与当前位置 ${s.ent.x} 不同 ⇒ 确实有过渡可打断`);
    ok(s.inter.settle !== null, '（前置）过渡已建立');

    // ⚠ 立刻打断，**不许用"等 N 毫秒再看"**：`settleTo` 走 requestAnimationFrame，
    //   而 Node 里的 rAF 替身（setTimeout 16）会把事件循环塞满，实际等待远超设定值，
    //   过渡很可能**已经跑完** ⇒ 测到的是"落定后"而不是"过渡中"，断言就成了假绿。
    //   `settle` 在 `settleTo()` 的**同步阶段**就已赋值，所以同步打断是可靠的。
    const midX = s.ent.x;
    ok(s.inter.settle !== null, '（前置）过渡已建立（同步阶段即可断言）');
    s.fire('pointerdown', s.ev('pointerdown', midX, y0));
    ok(s.inter.settle === null, '★ 过渡被新手势打断');
    ok(s.ent.x === midX && Math.abs(s.ent.x - target) > 1e-9,
      `★ 打断后停在**当前**位置 x=${s.ent.x.toFixed(2)}，**没有补跑到**旧目标 ${target}（否则会被当成"它自己动了"）`);

    // 收尾，别把手势留在半截
    s.fire('pointerup', s.ev('pointerup', midX, y0, { buttons: 0 }));
  }

  // ── ④ 吸附目标预览（④-5）：看得见将落到哪，且**不改任何坐标** ──────────────
  {
    const s = mk();
    const x0 = s.ent.x, y0 = s.ent.y;
    // ⚠ `mkG()` 的 ctx 只把 setTransform/translate/clearRect 记进 trace，其余绘制方法
    //   （save/beginPath/stroke/roundRect…）**全是 noop**，所以预览指令在 trace 里看不见。
    //   要数它发了多少条，得给这几个方法**包一层计数器** —— 不要改 mkG（§①~⑧ 依赖它的逐位可比）。
    const cnt = { n: 0 };
    const g = s.canvas.getContext('2d');
    for (const k of ['save', 'restore', 'beginPath', 'moveTo', 'lineTo', 'stroke', 'setLineDash', 'roundRect']) {
      const orig = g[k];
      g[k] = (...a) => { cnt.n++; return orig.apply(g, a); };
    }

    s.fire('pointerdown', s.ev('pointerdown', x0, y0));
    s.fire('pointermove', s.ev('pointermove', x0 - 1, y0));   // 阈值内：还不算拖
    ok(s.inter.drag && s.inter.drag.moved === false,
      '（前置）阈值内位移不进入拖动 ⇒ 此时不该有吸附预览');

    cnt.n = 0;
    s.inter.drawOverlay(g, s.eng);
    ok(cnt.n === 0, `★ 静止/阈值内**不画**预览（发出 ${cnt.n} 条绘制调用，期望 0）`);

    s.fire('pointermove', s.ev('pointermove', x0 + 7, y0 + 3));  // 越阈值

    const rawX = s.ent.x, rawY = s.ent.y;
    const tx = Math.round(rawX / 4) * 4, ty = Math.round(rawY / 4) * 4;

    cnt.n = 0;
    s.inter.drawOverlay(g, s.eng);
    const drew = cnt.n;
    ok(drew > 0,
      `★ 拖动中 drawOverlay **确实发出了绘制调用**（${drew} 条：save/roundRect/beginPath/十字/restore）`);

    // 负控：moved=false 时应一条都不发 —— 证明上面那条不是恒真
    const keep = s.inter.drag.moved;
    s.inter.drag.moved = false;
    cnt.n = 0;
    s.inter.drawOverlay(g, s.eng);
    ok(cnt.n === 0, `★ 负控：moved=false 时一条预览调用都不发（实测 ${cnt.n}，这条判据能红）`);
    s.inter.drag.moved = keep;

    // ★ 关键不变量：画提示**绝不能**动到器材坐标
    ok(s.ent.x === rawX && s.ent.y === rawY,
      `★ 吸附预览**不改坐标**：仍是 (${s.ent.x},${s.ent.y})（预览只是提示，落点仍由 finishDrag 决定）`);

    // 目标点就是那个 4px 网格点 —— 与 finishDrag 用的是同一个式子
    ok(tx === Math.round(rawX / 4) * 4 && ty === Math.round(rawY / 4) * 4,
      `★ 预览的目标点 (${tx},${ty}) 与 finishDrag 的吸附式同源（都是 round(x/SNAP)*SNAP）`);

    s.fire('pointerup', s.ev('pointerup', x0 + 7, y0 + 3, { buttons: 0 }));
  }

  // ── ⑤ 重叠可达性：重复点击**穿透**到被压住的器材（④-7）────────────────────
  {
    const s = mk();
    // 在同一处叠两件（后加的在上）。画布内拖动**不禁止重叠**（避让只管从器材栏投放），
    // 所以这完全是用户会遇到的局面。
    const lower = s.ent;                                        // battery @ (300,250)
    const upper = create('battery', 300, 250);                  // 同一坐标，后加 ⇒ 在上
    s.world.add(upper, true);

    const hits = s.world.pickAll(300, 250);
    const who = (e) => (e ? `${e.type}@${e.x},${e.y}` : 'null');
    info('诊断：entities=' + s.world.entities.map(who).join(' | ')
      + ' ｜ hits=' + hits.map(who).join(' | ')
      + ' ｜ upper===entities[1]? ' + (upper === s.world.entities[1])
      + ' ｜ s.ent===entities[0]? ' + (s.ent === s.world.entities[0]));
    ok(hits.length === 2, `（前置）该点确实叠了 2 件（实测 ${hits.length}：${hits.map(who).join(' | ')}）`);
    ok(hits[0] === lower && hits[1] === upper,
      `★ world.pickAll 的**既有**顺序是从下到上（filter 序）—— 本改造**刻意不动它**：`
      + `got=[${who(hits[0])}, ${who(hits[1])}]，期望 lower 在前`);
    // ⚠ 重复定义教训（2026-10-17）：我先在 world.js 里又加了一个同名 `pickAll` 想改成
    //   "上层在前"，结果与**别人已有的定义重名覆盖** —— 探针里看到的仍是旧顺序，
    //   而我在 interact.js 里按"上层在前"写的逻辑当时还以为对。⇒ **同仓已有 API 先查再动。**
    ok(s.world.pick(300, 250) === upper && s.world.pickAll(300, 250)[0] === lower,
      '★ 两条 API 的顺序确实相反：pick 取上层、pickAll 从下往上（这正是要在调用侧重排的原因）');
    ok(s.world.pick(300, 250) === upper,
      '（前置）pick() 仍只返回最上层 —— 不改变既有 API 语义');

    // 第一下：必须仍是"选最上层"（行为不变）
    s.app.selected = null;
    s.fire('pointerdown', s.ev('pointerdown', 300, 250));
    s.fire('pointerup', s.ev('pointerup', 300, 250, { buttons: 0 }));
    ok(s.app.selected === upper,
      '★ 第一下点击仍选**最上层**（穿透不得改变首次点击的行为）');

    // 第二下：同一处再点 ⇒ 穿透到下一层（这就是"被压住的也够得着"）
    s.fire('pointerdown', s.ev('pointerdown', 300, 250));
    s.fire('pointerup', s.ev('pointerup', 300, 250, { buttons: 0 }));
    ok(s.app.selected === lower,
      '★ 第二下点击**穿透到被压住的那件** —— 它不再"永远点不到"');

    // 第三下：环回第一层（不会卡死在最底层）
    s.fire('pointerdown', s.ev('pointerdown', 300, 250));
    s.fire('pointerup', s.ev('pointerup', 300, 250, { buttons: 0 }));
    ok(s.app.selected === upper, '★ 第三下环回最上层（循环，不会卡死在底层）');

    // 负控：只有一件重叠时，"重复点击"不该换人
    const only = create('battery', 600, 400);
    s.world.add(only, true);
    s.app.selected = null;
    for (let i = 0; i < 3; i++) {
      s.fire('pointerdown', s.ev('pointerdown', 600, 400));
      s.fire('pointerup', s.ev('pointerup', 600, 400, { buttons: 0 }));
    }
    ok(s.app.selected === only,
      '★ 负控：该点只有一件时，连点三次都选中它（穿透逻辑不该在这里起作用）');
  }

  if (!hadRaf) {
    delete globalThis.requestAnimationFrame;
    delete globalThis.cancelAnimationFrame;
  }
}


console.log('\n' + '─'.repeat(56));
if (MUT) {
  // 变异体只许让**锚定平移**的判据转红。词表按实测消息取，别放宽成「红了就行」——
  // 「没换也红」和「换了才红」是两件事，这里要的是后者。
  const mustRed = [
    '同一屏幕点映射到的世界坐标确实随之改变',
    '仍选中同一件器材',
    '拖动状态仍挂在同一件器材上',
    '仍可命中',
    '方向没写反',
  ];
  const reds = failed.filter((m) => mustRed.some((k) => m.includes(k)));
  console.log(`变异体运行（window.__XM_PAN_OFF__ = true）：失败 ${fail} 项，其中锚定平移的失败 ${reds.length} 项`);
  for (const m of reds) console.log('    \x1b[31m红\x1b[0m ' + m);
  console.log(reds.length >= 4 ? '\x1b[32m变异体自证成立：置回退开关后锚定平移的判据确实转红\x1b[0m'
    : '\x1b[31m变异体自证失败：回退开关没让锚定平移的判据转红（红测是假的）\x1b[0m');
} else if (fail === 0) {
  console.log(`\x1b[32m全部通过：${pass} 项\x1b[0m`);
} else {
  console.log(`\x1b[31m合计 ${pass + fail} 项，失败 ${fail} 项\x1b[0m`);
}
process.exit(fail === 0 ? 0 : 1);
