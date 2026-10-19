// ══════════════════════════════════════════════════════════
// tools/gesture-probe.mjs —— 两指视口手势（平移 + 捏合缩放）的正式验证工具
//
// 为什么必须存在：`pan-probe.mjs` 钉住的是**视口偏移**（pan），它有一条铁律 ——
//   「pan = 0 时绘制指令流与改动前逐位相同」。这一轮在它旁边**新增**了两指手势，
//   于是多了两件没有判据的事：
//     · 捏合时「起手时中点下的那个世界点，全程不许离开中点」—— 这是「像地图一样
//       缩放」唯一站得住的判据（缩放围绕中点，不是围绕画布左上角）；
//     · 单指路径**一个字节都不许变**（用户当面拍板：单指 = 点选 / 拖器材）。
//   第一条靠独立公式复算，第二条靠**改动前的字节副本**做镜像对照（照 pan-probe §⑨ 的做法）。
//
// 零依赖、零浏览器：手势是纯算术 + 一个 Pointer Events 状态机，Node 里就能断言。
//   因此这里不启 Edge（公共场所不起可见窗口），也不写仓库任何中间产物 —— 只有读。
//   真机/浏览器层那一半（合成真实触摸事件、`visualViewport` 有没有跟着动）不在本文件里，
//   见交付说明里的「必须浏览器/真机验证」清单。
//
// 用法：
//   node tools/gesture-probe.mjs            # 全部断言（绿：全部通过：N 项，exit 0）
//   node tools/gesture-probe.mjs --mutate   # 变异体自证：每个变异体必须让**指定的**判据转红，
//                                           # 且对照组一条都不许红（打印 GESTURE_MUTATE_JSON）
//
// ⚠ 单指镜像对照需要**改动前的字节副本**：`%TEMP%\t12-pre\{interact.js,engine.js}`。
//   副本不在时本探针会**如实报一条红**（而不是静默跳过）—— 一条会自己消失的判据比没有更坏。
//   补副本的办法（在仓库根执行，不写仓库）：
//     node -e "const fs=require('fs');fs.mkdirSync(process.env.TEMP+'/t12-pre',{recursive:true});
//       for(const f of ['src/ui/interact.js','src/core/engine.js'])
//         fs.copyFileSync(f,process.env.TEMP+'/t12-pre/'+f.split('/').pop())"
//   ⚠ 更稳的办法是把基线落进仓库（`internal/baselines/`），别押在「没人清临时目录」上 ——
//     这一条 pan-probe 已经吃过一次亏（副本没了 ⇒ 整段对照消失）。
// ══════════════════════════════════════════════════════════

import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, cpSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TMP = process.env.TEMP || '/tmp';
const MUTATE = process.argv.includes('--mutate');
const PRE_DIR = join(TMP, 't12-pre');

const near = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;
/**
 * 屏幕坐标的**独立复算**：canvas 的变换是 `translate(pan)` 然后 `scale(zoom)`，
 * 所以画在世界点 W 的东西出现在屏幕 `W×zoom + pan`。
 * ⚠ 这条式子**不许照抄 engine.screenToWorld 的写法**（它写的是除法）。探针一旦用自己的
 *   公式反推屏幕点，「实现算错」与「断言跟着错」就会互相掩护 —— pan-probe 第一版正是
 *   这么把方向写反还全绿的。§④ 另外用**真实指令流**交叉验证这条式子。
 */
const screenOf = (wx, wy, pan, zoom) => ({ x: wx * zoom + pan.x, y: wy * zoom + pan.y });

// ── 环境替身：engine / interact 要的那一小撮 DOM ──────────────────────────
const WIN = {
  innerWidth: 1280, innerHeight: 800, devicePixelRatio: 1,
  matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
  _ev: {},
  addEventListener(t, fn) { (WIN._ev[t] ||= []).push(fn); },
  removeEventListener() {},
};
globalThis.window = WIN;
// 时钟与 rAF 都做成**可控**的：双击判定读 performance.now()、吸附过渡靠 requestAnimationFrame
// 驱动。用真时钟会让「跑得快慢」变成判据的一部分（pan-probe §⑥ 就是被这个坑过一次）。
let NOW = 5000;
globalThis.performance = { now: () => NOW };
const rafQ = [];
globalThis.requestAnimationFrame = (f) => { rafQ.push(f); return rafQ.length; };
globalThis.cancelAnimationFrame = () => {};
/** 手动泵帧：每泵一帧把时钟推进 step 毫秒（确定性，不依赖真实时间） */
const pump = (n = 60, step = 20) => {
  for (let i = 0; i < n; i++) { const q = rafQ.splice(0); NOW += step; for (const f of q) f(NOW); }
};

/** 记录型 2D 上下文：变换指令必须记全（translate 与 scale 都是坐标契约的载体） */
function mkG(trace) {
  const ctx = {
    canvas: null,
    setTransform: (a, b, c, d, e, f) => { trace.push(['setTransform', a, b, c, d, e, f]); },
    translate: (x, y) => { trace.push(['translate', x, y]); },
    scale: (x, y) => { trace.push(['scale', x, y]); },
    clearRect: (x, y, w, h) => { trace.push(['clearRect', x, y, w, h]); },
    save: () => {}, restore: () => {},
    createLinearGradient: () => ({ addColorStop() {} }),
  };
  const NOOP = ['beginPath', 'moveTo', 'lineTo', 'arc', 'arcTo', 'stroke', 'fill', 'closePath',
    'quadraticCurveTo', 'rotate', 'fillRect', 'setLineDash', 'measureText', 'fillText',
    'clip', 'rect', 'ellipse', 'bezierCurveTo', 'roundRect'];
  for (const k of NOOP) ctx[k] = () => {};
  return ctx;
}

function mkCanvas(trace, w = 800, h = 600) {
  const g = mkG(trace);
  const cv = {
    width: 0, height: 0, style: {}, _listeners: {},
    getContext: () => g,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: w, height: h }),
    // ⚠ 记下第三参：`{ passive: false }` 是不是真的传了，是滚轮缩放**唯一**的静默失效点
    addEventListener(t, fn, opt) { (cv._listeners[t] ||= []).push({ fn, opt }); },
    removeEventListener() {},
    hasPointerCapture: () => false,
    releasePointerCapture() {},
    setPointerCapture() {},
    focus() {},
  };
  g.canvas = cv;
  return cv;
}

function mkEngine(T, world, trace) {
  const cv = mkCanvas(trace);
  const eng = new T.Engine(cv, world);
  eng.app = { markDirty() {} };
  return eng;
}

function mkApp(world, eng, canvas) {
  const calls = { select: 0, markDirty: 0, clicked: 0, moved: 0 };
  const app = {
    canvas, world, engine: eng,
    selected: null,
    select(e) { calls.select++; app.selected = e; },
    markDirty() { calls.markDirty++; },
    _calls: calls,
    setStatusTool() {}, toast() {}, doPour() {}, removeEntity() {},
    onEntityClicked() { calls.clicked++; },
    onEntityMoved() { calls.moved++; },
  };
  return app;
}

function mkSender(canvas) {
  const ev = (t, x, y, over = {}) => Object.assign({
    button: 0, pointerId: 1, pointerType: 'mouse', clientX: x, clientY: y, buttons: 1,
    shiftKey: false, preventDefault() {}, target: canvas, type: t,
  }, over);
  const fire = (t, e) => (canvas._listeners[t] || []).forEach((r) => r.fn(e));
  return {
    fire,
    down: (id, x, y, over = {}) => fire('pointerdown', ev('pointerdown', x, y, { pointerId: id, ...over })),
    move: (id, x, y, over = {}) => fire('pointermove', ev('pointermove', x, y, { pointerId: id, ...over })),
    up: (id, x, y, over = {}) => fire('pointerup', ev('pointerup', x, y, { pointerId: id, buttons: 0, ...over })),
    cancel: (id, x, y, over = {}) => fire('pointercancel', ev('pointercancel', x, y, { pointerId: id, buttons: 0, ...over })),
    lost: (id, x, y, over = {}) => fire('lostpointercapture', ev('lostpointercapture', x, y, { pointerId: id, buttons: 0, ...over })),
  };
}
const TOUCH = { pointerType: 'touch' };

/** 把 `src/` 整份摊进临时目录再覆盖若干文件 —— 变体树自包含，相对 import 全部照常解析。 */
function stageTree(name, overlays = {}) {
  const dir = join(TMP, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  cpSync(join(ROOT, 'src'), join(dir, 'src'), { recursive: true });
  for (const [rel, srcFile] of Object.entries(overlays)) copyFileSync(srcFile, join(dir, rel));
  return dir;
}

async function loadTarget(root, tag) {
  const u = (rel) => pathToFileURL(join(root, rel)).href;
  const { Engine } = await import(u('src/core/engine.js'));
  const { World } = await import(u('src/core/world.js'));
  const { Interaction } = await import(u('src/ui/interact.js'));
  const { create, bindRegistry, equipmentPlugins } = await import(u('src/equipment/index.js'));
  const { PluginHost } = await import(u('src/core/plugin.js'));
  const bootApp = {
    services: {}, ticks: [], world: null, lastCircuit: null, selected: null,
    log: { push() {}, clear() {} }, toast() {},
    addTick(fn) { this.ticks.push(fn); return () => {}; },
  };
  const host = new PluginHost(bootApp);
  for (const p of equipmentPlugins) host.define(p);
  host.installAll();
  bindRegistry(host.registry('equipment'));
  return { tag, root, Engine, World, Interaction, create };
}

// ══════════════════════════════════════════════════════════
// 断言套件（可重复跑：绿档跑一次，每个变异体各跑一次）
// ══════════════════════════════════════════════════════════
async function runSuite(T, opt = {}) {
  const verbose = opt.verbose !== false;
  const S = { pass: 0, fail: 0, failed: [], failSec: [], secTotal: {}, notes: [] };
  let curSec = '?';                 // 当前节（①…⑩）—— 变异体的预期按**节**声明，见文件尾
  const ok = (cond, msg) => {
    S.secTotal[curSec] = (S.secTotal[curSec] || 0) + 1;
    if (cond) { S.pass++; if (verbose) console.log('  \x1b[32m✓\x1b[0m ' + msg); }
    else { S.fail++; S.failed.push(msg); S.failSec.push(curSec); console.log('  \x1b[31m✗\x1b[0m ' + msg); }
  };
  const head = (t) => { curSec = t.trim().charAt(0); if (verbose) console.log('\n\x1b[36m' + t + '\x1b[0m'); };
  const info = (t) => { S.notes.push(t); if (verbose) console.log('    · ' + t); };

  // ── ① 坐标契约：世界 = (屏幕 − pan) / zoom ──────────────────────────────
  head('① 坐标契约：世界 = (屏幕 − pan) / zoom（唯一出口）');
  {
    const eng = mkEngine(T, new T.World(), []);
    const cases = [
      { pan: { x: 0, y: 0 }, zoom: 1, s: { x: 100, y: 60 }, w: { x: 100, y: 60 } },
      { pan: { x: 30, y: -12 }, zoom: 2, s: { x: 70, y: 28 }, w: { x: 20, y: 20 } },
      { pan: { x: -640, y: 96 }, zoom: 0.25, s: { x: 160, y: 96 }, w: { x: 3200, y: 0 } },
      { pan: { x: -400, y: -350 }, zoom: 3, s: { x: 500, y: 400 }, w: { x: 300, y: 250 } },
    ];
    for (const c of cases) {
      eng.pan.x = c.pan.x; eng.pan.y = c.pan.y; eng.zoom = c.zoom;
      const got = eng.screenToWorld(c.s.x, c.s.y);
      ok(near(got.x, c.w.x) && near(got.y, c.w.y),
        `pan=(${c.pan.x},${c.pan.y}) zoom=${c.zoom}：屏幕(${c.s.x},${c.s.y}) → 世界(${got.x},${got.y})，期望 (${c.w.x},${c.w.y})`);
      const back = screenOf(got.x, got.y, eng.pan, eng.zoom);      // 独立公式反向
      ok(near(back.x, c.s.x) && near(back.y, c.s.y),
        `往返恒等（独立公式复算）：世界(${got.x},${got.y}) → 屏幕(${back.x},${back.y})`);
    }
    const table = [[1, 1], [2, 2], [0.25, 0.25], [4, 4], [0.249, 0.25], [4.001, 4],
      [0.001, 0.25], [100, 4], [0, 1], [-2, 1], [NaN, 1], [Infinity, 1], [undefined, 1]];
    const bad = table.filter(([inp, want]) => eng.clampZoom(inp) !== want);
    ok(bad.length === 0,
      `clampZoom 边界 ${table.length} 组全符合（0.001→0.25、100→4、0/负/NaN/∞/undefined→1）${bad.length ? ' ✗不符 ' + JSON.stringify(bad) : ''}`);
  }

  // ── ② 捏合：起手世界点恒在中点下（不动点判据）──────────────────────────
  head('② 捏合 + 两指平移：起手世界点恒在中点下（本轮唯一口径）');
  {
    const world = new T.World();
    const trace = [];
    const eng = mkEngine(T, world, trace);
    const canvas = eng.canvas;
    const app = mkApp(world, eng, canvas);
    const inter = new T.Interaction(app);
    const Sf = mkSender(canvas);

    Sf.down(1, 400, 300, TOUCH);
    Sf.down(2, 500, 300, TOUCH);
    const mid0 = { x: 450, y: 300 };
    const w0 = eng.screenToWorld(mid0.x, mid0.y);        // 独立性：锚点由探针自己算
    ok(!!inter.gesture && inter.gesture.ids.join() === '1,2' && inter.multi === true,
      `两指落下 ⇒ 手势接管（ids=[${inter.gesture ? inter.gesture.ids.join(',') : '无'}]、multi=${inter.multi}）`);

    // 纯捏合：两指对称张开 400→350、500→550 ⇒ 中点不动、间距 100→200
    Sf.move(1, 350, 300, TOUCH);
    Sf.move(2, 550, 300, TOUCH);
    const midA = { x: 450, y: 300 };
    const wA = eng.screenToWorld(midA.x, midA.y);
    ok(near(wA.x, w0.x) && near(wA.y, w0.y),
      `纯捏合（间距 100→200、中点不动）：起手世界点仍在中点下（偏差 ${(wA.x - w0.x).toExponential(1)}, ${(wA.y - w0.y).toExponential(1)}）`);
    ok(near(eng.zoom, 2, 1e-12), `纯捏合：zoom 1 → ${eng.zoom}（间距比 2，且 pan=(${eng.pan.x.toFixed(1)},${eng.pan.y.toFixed(1)}) 随中点重算）`);

    // 手指没动的那些帧不该惊动重绘（engine.setViewAt 的注释把这条写成了承诺）
    const md0 = app._calls.markDirty;
    Sf.move(2, 550, 300, TOUCH);                       // 与上一帧完全同位 ⇒ 中点与间距都没变
    ok(app._calls.markDirty === md0, `手指没动的那些帧不置脏（markDirty 计数保持 ${md0}）`);

    // 纯平移：两指同向 +40/−20（间距不变 ⇒ zoom 必须一动不动）
    const panB0 = { x: eng.pan.x, y: eng.pan.y };
    Sf.move(1, 390, 280, TOUCH);
    Sf.move(2, 590, 280, TOUCH);
    const midB = { x: 490, y: 280 };
    const wB = eng.screenToWorld(midB.x, midB.y);
    ok(near(wB.x, w0.x) && near(wB.y, w0.y) && eng.zoom === 2,
      `纯平移（中点 +(40,−20)、间距不变）：世界点仍在中点下（偏差 ${(wB.x - w0.x).toExponential(1)}），zoom 保持 ${eng.zoom}`);
    ok(near(eng.pan.x - panB0.x, 40) && near(eng.pan.y - panB0.y, -20),
      `纯平移：pan 位移 = 中点位移（实测 Δ=(${(eng.pan.x - panB0.x).toFixed(3)},${(eng.pan.y - panB0.y).toFixed(3)})）`);

    // 混合：中点与间距同时变（590→790 ⇒ 间距 200→400，中点 (490,280)→(590,280)）
    Sf.move(2, 790, 280, TOUCH);
    const midC = { x: 590, y: 280 };
    const wC = eng.screenToWorld(midC.x, midC.y);
    ok(near(wC.x, w0.x) && near(wC.y, w0.y),
      `捏合 + 平移同时发生：世界点仍在中点下（偏差 ${(wC.x - w0.x).toExponential(1)}, ${(wC.y - w0.y).toExponential(1)}）`);
    ok(near(eng.zoom, 4, 1e-12), `混合手势：zoom = 2 × (400/200) = ${eng.zoom}`);
    info(`② 实测：zoom=${eng.zoom}、pan=(${eng.pan.x.toFixed(1)},${eng.pan.y.toFixed(1)})、锚点偏差 0 —— 中点就是不动点`);
  }

  // ── ③ 上下限：夹住之后**中点仍然不跑偏** ────────────────────────────────
  head('③ 缩放上下限 0.25×–4×：夹住的是倍率，不是不动点');
  {
    const world = new T.World();
    const eng = mkEngine(T, world, []);
    const canvas = eng.canvas;
    const app = mkApp(world, eng, canvas);
    const inter = new T.Interaction(app);
    const Sf = mkSender(canvas);
    Sf.down(1, 300, 300, TOUCH);
    Sf.down(2, 400, 300, TOUCH);
    const w0 = eng.screenToWorld(350, 300);
    Sf.move(2, 301, 300, TOUCH);                       // 间距 100 → 1（倍率 0.01）
    const wLo = eng.screenToWorld(300.5, 300);   // 只动手指 2 ⇒ 中点 (300.5,300)
    ok(eng.zoom === 0.25 && near(wLo.x, w0.x) && near(wLo.y, w0.y),
      `极端捏合（间距 100→1，倍率 0.01）：zoom 被夹到 ${eng.zoom}，中点下的世界点仍不动（偏差 ${(wLo.x - w0.x).toExponential(1)}）`);
    Sf.move(2, 100300, 300, TOUCH);                    // 间距 1 → 100000（倍率 1000×）
    const wHi = eng.screenToWorld(50300, 300);
    ok(eng.zoom === 4 && near(wHi.x, w0.x) && near(wHi.y, w0.y),
      `极端张开（间距 1→100000，倍率 1000）：zoom 被夹到 ${eng.zoom}，中点下的世界点仍不动（偏差 ${(wHi.x - w0.x).toExponential(1)}）`);
    eng.resetView();                                   // 先回恒等 —— 否则「已经在上限」会让 zoomAt 无事可做
    const dZoom = eng.zoomAt(9, 400, 300);
    ok(eng.zoom === 4 && dZoom === true, `zoomAt(9) 夹到 ${eng.zoom}（上限）；zoomAt 返回值=${dZoom}`);
    const dZoom2 = eng.zoomAt(9, 400, 300);
    ok(eng.zoom === 4 && dZoom2 === false,
      `已经在上限时 zoomAt 返回 ${dZoom2}（没变就不惊动一帧 —— 滚轮要**靠这个返回值**决定要不要 preventDefault）`);
  }

  // ── ④ 绘制契约：先平移再缩放，两个恒等值都不发指令 ──────────────────────
  head('④ 绘制契约：translate(pan) → scale(zoom)，恒等值一条指令都不发');
  {
    const t1 = [];
    const e1 = mkEngine(T, new T.World(), t1);
    e1.pan.x = 10; e1.pan.y = 20; e1.zoom = 2;
    e1.render(); t1.length = 0; e1.render();                 // 热身一帧（台面渐变首帧建缓存）
    const k1 = t1.map((t) => t[0]);
    const tr1 = t1.filter((t) => t[0] === 'translate');
    const sc1 = t1.filter((t) => t[0] === 'scale');
    ok(k1[0] === 'setTransform' && k1[1] === 'clearRect' && k1[2] === 'translate' && k1[3] === 'scale',
      `指令顺序 setTransform → clearRect → translate → scale（实测 ${k1.slice(0, 4).join(' → ')}）`);
    ok(tr1.length === 1 && sc1.length === 1 && tr1[0][1] === 10 && tr1[0][2] === 20 && sc1[0][1] === 2 && sc1[0][2] === 2,
      `恰好各一条且参数正确：translate(${tr1[0] && tr1[0][1]},${tr1[0] && tr1[0][2]})、scale(${sc1[0] && sc1[0][1]},${sc1[0] && sc1[0][2]})`);

    const t2 = [];
    const e2 = mkEngine(T, new T.World(), t2);
    e2.render(); t2.length = 0; e2.render();
    ok(t2.filter((t) => t[0] === 'translate' || t[0] === 'scale').length === 0,
      'pan=(0,0) 且 zoom=1：translate / scale 一条都不发（与 pan-probe §② 独立复核）');

    const t3 = [];
    const e3 = mkEngine(T, new T.World(), t3);
    e3.pan.x = 7;
    e3.render(); t3.length = 0; e3.render();
    const k3 = t3.filter((t) => t[0] === 'translate' || t[0] === 'scale').map((t) => t[0]);
    ok(k3.length === 1 && k3[0] === 'translate', `pan=(7,0) 且 zoom=1：只发 translate、不发 scale（实测 [${k3.join(',')}]）`);

    // 网格必须覆盖整个可见区 —— 平移方向写反时两端会露出没有网格的带子（本轮修掉的既有缺陷）
    // 网格必须铺满可见区 —— 平移方向写反时左侧会留出一条没有网格的空白带（本轮修掉的既有缺陷）。
    // ⚠ 只统计**竖线**（moveTo.x === lineTo.x）：横线的 moveTo 起点也在同一批 x 上，混在一起量不出覆盖。
    const t4 = [];
    const e4 = mkEngine(T, new T.World(), t4);
    const g4 = e4.canvas.getContext('2d');
    const seg = [];
    g4.moveTo = (x, y) => seg.push([x, y, NaN, NaN]);
    g4.lineTo = (x, y) => { const s = seg[seg.length - 1]; s[2] = x; s[3] = y; };
    e4.pan.x = 100; e4.pan.y = 0;
    e4.render();
    const vx = seg.filter((s) => s[2] === s[0]).map((s) => s[0] + e4.pan.x);
    const s0 = e4.gridSize;
    const minV = Math.min(...vx), maxV = Math.max(...vx);
    ok(vx.length >= Math.floor(e4.w / s0) && minV <= 0 && minV > -s0 && maxV >= e4.w - s0,
      `pan=(100,0) 时网格铺满整屏：${vx.length} 条竖线、屏幕 x∈[${minV},${maxV}]、格距 ${s0}、画布宽 ${e4.w}`
      + `（方向写反的旧式子在左侧留 96px 空白 ⇒ minV 会是 +96 而不是 ${minV}）`);
  }

  // ── ⑤ 收尾：抬一根 / pointercancel / lostpointercapture / 三指 ─────────
  head('⑤ 收尾：任一根抬起即结束手势，且**不回退视口**');
  {
    const world = new T.World();
    const ent = T.create('battery', 450, 300);
    world.add(ent, true);
    const trace = [];
    const eng = mkEngine(T, world, trace);
    const canvas = eng.canvas;
    const app = mkApp(world, eng, canvas);
    const inter = new T.Interaction(app);
    const Sf = mkSender(canvas);

    // (a) 抬一根
    Sf.down(1, 400, 300, TOUCH);
    Sf.down(2, 500, 300, TOUCH);
    Sf.move(1, 350, 300, TOUCH); Sf.move(2, 550, 300, TOUCH);
    const zA = eng.zoom, pA = { x: eng.pan.x, y: eng.pan.y };
    Sf.up(1, 350, 300, TOUCH);
    ok(inter.gesture === null && inter.multi === false,
      `抬起一根 ⇒ 手势结束、多指封锁解除（gesture=${inter.gesture}、multi=${inter.multi}）`);
    ok(eng.zoom === zA && eng.pan.x === pA.x && eng.pan.y === pA.y,
      `收尾**不回退视口**：zoom 仍 ${eng.zoom}、pan 仍 (${eng.pan.x.toFixed(1)},${eng.pan.y.toFixed(1)})`);
    // 剩下那根手指不许接着变成单指拖动
    const entBefore = { x: ent.x, y: ent.y };
    const sp = screenOf(ent.x, ent.y, eng.pan, eng.zoom);
    Sf.move(2, sp.x, sp.y, TOUCH);
    Sf.move(2, sp.x + 60, sp.y + 40, TOUCH);
    Sf.up(2, sp.x + 60, sp.y + 40, TOUCH);
    ok(ent.x === entBefore.x && ent.y === entBefore.y && app._calls.clicked === 0 && app._calls.moved === 0,
      `抬起后剩下的那根手指不做任何事（器材没动、没有单击/移动出口：clicked=${app._calls.clicked}、moved=${app._calls.moved}）`);

    // (b) pointercancel：手势结束但视口保留
    Sf.down(1, 400, 300, TOUCH);
    Sf.down(2, 500, 300, TOUCH);
    Sf.move(2, 700, 300, TOUCH);
    const zB = eng.zoom, pB = { x: eng.pan.x, y: eng.pan.y };
    Sf.cancel(2, 700, 300, TOUCH);
    ok(inter.gesture === null && eng.zoom === zB && eng.pan.x === pB.x && eng.pan.y === pB.y,
      `pointercancel：手势结束（gesture=${inter.gesture}）但视口保留（zoom=${eng.zoom}）`);
    Sf.cancel(1, 400, 300, TOUCH);

    // (c) lostpointercapture：同样收尾且不回退
    Sf.down(1, 400, 300, TOUCH);
    Sf.down(2, 500, 300, TOUCH);
    Sf.move(2, 700, 300, TOUCH);
    const zC = eng.zoom, pC = { x: eng.pan.x, y: eng.pan.y };
    Sf.lost(1, 400, 300, TOUCH);
    ok(inter.gesture === null && eng.zoom === zC && eng.pan.x === pC.x && eng.pan.y === pC.y,
      `lostpointercapture：手势结束但视口保留（zoom=${eng.zoom}）`);
    Sf.up(2, 700, 300, TOUCH);

    // (d) 第三根手指落下：重建锚点，但**视口不许跳**
    Sf.down(1, 300, 300, TOUCH);
    Sf.down(2, 400, 300, TOUCH);
    Sf.move(1, 280, 300, TOUCH); Sf.move(2, 440, 300, TOUCH);       // 先做一个真捏合
    const zD = eng.zoom, pD = { x: eng.pan.x, y: eng.pan.y };
    Sf.down(3, 500, 300, TOUCH);
    ok(inter.gesture !== null && inter.gesture.ids.join() === '2,3' && eng.zoom === zD
      && near(eng.pan.x, pD.x, 1e-9) && near(eng.pan.y, pD.y, 1e-9),
      `第三根手指落下：手势改用最近两根（ids=[${inter.gesture && inter.gesture.ids.join(',')}]）且视口不跳（zoom 仍 ${eng.zoom}）`);
    Sf.up(3, 500, 300, TOUCH); Sf.up(2, 440, 300, TOUCH); Sf.up(1, 280, 300, TOUCH);
    ok(inter.ptrs ? inter.ptrs.size === 0 : true, `全部抬起后指针表清空（size=${inter.ptrs ? inter.ptrs.size : 'n/a'}）`);
  }

  // ── ⑥ 单指镜像对照：与改动前**逐位相同**（本轮的护栏）──────────────────
  head('⑥ 单指镜像对照：同一串单指事件，与改动前的字节副本逐位相同');
  const preInter = join(PRE_DIR, 'interact.js');
  const preEngine = join(PRE_DIR, 'engine.js');
  if (!existsSync(preInter) || !existsSync(preEngine)) {
    ok(false, `⚠ 改动前的字节副本不可用（${PRE_DIR}）⇒ **单指逐位对照未被验证**（补副本见本文件头部注释）`);
  } else {
    const preTree = stageTree('gesture-pre', {
      'src/ui/interact.js': preInter, 'src/core/engine.js': preEngine,
    });
    const Tpre = await loadTarget(preTree, 'pre');
    const pack = (mod, create2) => {
      const world = new mod.World();
      const ent = create2('battery', 300, 250);
      world.add(ent, true);
      const trace = [];
      const eng = mkEngine(mod, world, trace);
      const canvas = eng.canvas;
      const app = mkApp(world, eng, canvas);
      const inter = new mod.Interaction(app);
      return { world, ent, trace, eng, canvas, app, inter, S: mkSender(canvas) };
    };
    const digest = (p) => JSON.stringify({
      pid: p.inter.pid,
      multi: p.inter.multi,
      gesture: p.inter.gesture ? { ids: p.inter.gesture.ids, z0: p.inter.gesture.zoom0 } : null,
      // 老 interact 没有 ptrs 表 —— 归一到「空」再比，否则会把「新字段存在」当成行为差异
      ptrs: p.inter.ptrs ? p.inter.ptrs.size : 0,
      drag: p.inter.drag ? { id: p.inter.drag.ent.id, x: p.inter.drag.ent.x, y: p.inter.drag.ent.y, moved: p.inter.drag.moved } : null,
      panState: p.inter.pan ? { sx: p.inter.pan.sx, sy: p.inter.pan.sy } : null,
      eng: { pan: [p.eng.pan.x, p.eng.pan.y], zoom: p.eng.zoom === undefined ? 1 : p.eng.zoom },
      ents: p.world.entities.map((e) => `${e.type}@${e.x},${e.y}`),
      hot: p.eng.hotPort ? `${p.eng.hotPort.ent.type}:${p.eng.hotPort.port && p.eng.hotPort.port.label}` : null,
      wireFrom: p.inter.wireFrom ? `${p.inter.wireFrom.ent.type}:${p.inter.wireFrom.port && p.inter.wireFrom.port.label}` : null,
      selected: p.app.selected ? `${p.app.selected.type}@${p.app.selected.x},${p.app.selected.y}` : null,
      calls: p.app._calls,
      trace: p.trace,
    });

    /**
     * 一串**只含单指**的事件：覆盖拖器材 / 点空白 / 鼠标拖动平移 / 双击复位 / 点接线柱。
     * ⚠ 本脚本全程 zoom=1（单指不改变视口）⇒ 双击复位在「改动前的副本」与当前树上**观测等价**
     *   （两者都只是把 pan 归零）。所以「双击 = 复位整个视图」这条语义**不在**这里判，
     *   它在 §⑧（带 resetView/resetPan 调用计数）—— 这也是 §⑧ 存在的理由。
     */
    const script = (p) => {
      NOW = 5000;
      const { S, eng, ent, canvas } = p;
      // ⚠ 屏幕点必须用**归一化后的视口**算：改前的 engine 上 `zoom` 是 undefined，
      //   直接相乘会得到 NaN，整串事件的坐标就全变 NaN（探针把自己毒死，而报出来的差异
      //   会指向引擎 —— 本文件第一版正是这么误报的）。恒等视口 ⇒ 当 1。
      const zFor = eng.zoom === undefined ? 1 : eng.zoom;
      const sp = (wx, wy) => screenOf(wx, wy, eng.pan, zFor);
      // S1 触摸按住器材 → 抖 4px → 拖 40px → 抬起（吸附落位）
      let q = sp(ent.x, ent.y);
      S.down(1, q.x, q.y, TOUCH);
      S.move(1, q.x + 4, q.y + 3, TOUCH);
      S.move(1, q.x + 40, q.y + 30, TOUCH);
      S.up(1, q.x + 40, q.y + 30, TOUCH);
      pump();
      // S2 触摸点空白（取消选中）
      S.down(1, 700, 500, TOUCH); S.up(1, 700, 500, TOUCH);
      pump();
      // S2b 触摸在空白处拖 120px：既不平移、也不缩放（用户拍板的那条语义，镜像也必须一致）
      S.down(1, 700, 560, TOUCH);
      S.move(1, 660, 520, TOUCH);
      S.move(1, 600, 460, TOUCH);
      S.up(1, 600, 460, TOUCH);
      pump();
      // S3 鼠标空白处拖动 = 平移（armPan 路径）
      S.down(1, 700, 500);
      S.move(1, 660, 470);
      S.move(1, 640, 460);
      S.up(1, 640, 460);
      pump();
      // S4 鼠标双击空白 = 复位（间隔 120ms < DOUBLE_TAP_MS=350）
      S.down(1, 600, 520); S.up(1, 600, 520);
      NOW += 120;
      S.down(1, 600, 520); S.up(1, 600, 520);
      pump();
      // S5 鼠标按住接线柱 → 移动（起线路径）
      const e2 = p.world.entities[0];
      const port = e2 && e2.ports && e2.ports[0];
      if (port) {
        const pp = sp(e2.x + port.x, e2.y + port.y);      // 端口偏移是 {x,y}（实测形状 {x,y,label,kind,i}）
        S.down(1, pp.x, pp.y);
        S.move(1, pp.x + 60, pp.y + 40);
        S.up(1, pp.x + 60, pp.y + 40);
        pump();
      }
      // S6 触摸长按器材后抬手（单击出口）
      q = sp(e2 ? e2.x : 300, e2 ? e2.y : 250);
      NOW += 1000;
      S.down(1, q.x, q.y, TOUCH); S.up(1, q.x, q.y, TOUCH);
      pump();
      return digest(p);
    };

    const pNow = pack(T, T.create);
    const dNow = script(pNow);
    const pPre = pack(Tpre, Tpre.create);
    const dPre = script(pPre);
    ok(pPre.eng.zoom === undefined,
      '改前的 engine 上**根本没有 zoom 字段**（用户看到的「缩不了」在 Node 层的对应事实）');
    ok(dNow === dPre, `同一串单指事件：状态摘要 + 绘制指令流逐位相同（${dNow.length} 字符）`);
    if (dNow !== dPre) {
      const a = JSON.parse(dNow), b = JSON.parse(dPre);
      for (const k of Object.keys(a)) {
        if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) {
          info(`首处差异字段 ${k}：新=${JSON.stringify(a[k]).slice(0, 200)} 旧=${JSON.stringify(b[k]).slice(0, 200)}`);
          break;
        }
      }
    }
    rmSync(preTree, { recursive: true, force: true });
  }

  // ── ⑦ 单指触摸：只做点选/拖器材，**不许**平移或缩放 ────────────────────
  head('⑦ 单指触摸：拖器材仍然有效，且 pan / zoom 全程不动');
  {
    const world = new T.World();
    const ent = T.create('battery', 300, 250);
    world.add(ent, true);
    const trace = [];
    const eng = mkEngine(T, world, trace);
    const canvas = eng.canvas;
    const app = mkApp(world, eng, canvas);
    const inter = new T.Interaction(app);
    const Sf = mkSender(canvas);

    // (a) 拖器材：位置必须真的变（既有语义没被手势抢走）
    Sf.down(1, 300, 250, TOUCH);
    Sf.move(1, 340, 280, TOUCH);
    Sf.up(1, 340, 280, TOUCH);
    pump();
    ok(eng.pan.x === 0 && eng.pan.y === 0 && eng.zoom === 1,
      `单指拖器材：pan=(${eng.pan.x},${eng.pan.y}) zoom=${eng.zoom} 全程恒等（没有偷偷平移/缩放）`);
    ok(ent.x !== 300 || ent.y !== 250, `单指拖器材：器材确实被移动（(300,250) → (${ent.x},${ent.y})）`);

    // (b) 空白处单指拖动 120px：**不许**平移（产品决策，不是「没做」）
    const p0 = { x: eng.pan.x, y: eng.pan.y, z: eng.zoom };
    Sf.down(1, 700, 520, TOUCH);
    Sf.move(1, 640, 460, TOUCH);
    Sf.move(1, 580, 400, TOUCH);
    Sf.up(1, 580, 400, TOUCH);
    pump();
    ok(eng.pan.x === p0.x && eng.pan.y === p0.y && eng.zoom === p0.z,
      `单指在空白处拖 120px：pan/zoom 一动都不动（pan=(${eng.pan.x},${eng.pan.y})、zoom=${eng.zoom}）`);
  }

  // ── ⑧ resetPan 语义未变；resetView 才是整体复位；双击只复位平移 ────────
  head('⑧ 复位语义：resetPan 只复位平移；resetView 才是 pan+zoom；双击 = resetPan');
  {
    const world = new T.World();
    const eng = mkEngine(T, new T.World(), []);
    const canvas = eng.canvas;
    const app = mkApp(world, eng, canvas);
    const inter = new T.Interaction(app);
    const Sf = mkSender(canvas);

    eng.pan.x = 33; eng.pan.y = -21; eng.zoom = 2.5;
    const d1 = eng.resetPan();
    ok(d1 === true && eng.pan.x === 0 && eng.pan.y === 0 && eng.zoom === 2.5,
      `resetPan() 只复位平移：返回 ${d1}、pan=(${eng.pan.x},${eng.pan.y})、zoom 保持 ${eng.zoom}`);
    const d2 = eng.resetPan();
    ok(d2 === false, `resetPan() 在原点仍返回 false（既有语义未变：没动过就不惊动一帧）`);
    const d3 = eng.resetView();
    ok(d3 === true && eng.zoom === 1 && eng.pan.x === 0 && eng.pan.y === 0,
      `resetView() 整体复位：返回 ${d3}、zoom=${eng.zoom}`);
    const d4 = eng.resetView();
    ok(d4 === false, `resetView() 在恒等视口返回 false（幂等）`);

    // 双击空白处（armPan 路径）只复位平移，**不动** zoom
    eng.pan.x = -60; eng.pan.y = -40; eng.zoom = 3;
    NOW = 5000;
    Sf.down(1, 700, 500); Sf.up(1, 700, 500);
    NOW += 120;
    Sf.down(1, 700, 500); Sf.up(1, 700, 500);
    ok(eng.pan.x === 0 && eng.pan.y === 0 && eng.zoom === 3,
      `鼠标双击空白 = 只复位平移：pan=(${eng.pan.x},${eng.pan.y})、zoom 仍 ${eng.zoom}（**不**同时复位 zoom，见交付说明）`);
  }

  // ── ⑨ zoom≠1 时的命中：看得见也要点得中 ────────────────────────────────
  head('⑨ zoom≠1 时的命中：屏幕点 → 世界点仍能点中同一件器材');
  {
    const world = new T.World();
    const ent = T.create('battery', 300, 250);
    world.add(ent, true);
    const trace = [];
    const eng = mkEngine(T, world, trace);
    const canvas = eng.canvas;
    const app = mkApp(world, eng, canvas);
    const inter = new T.Interaction(app);

    for (const view of [{ pan: { x: 0, y: 0 }, zoom: 1 }, { pan: { x: -400, y: -350 }, zoom: 3 },
      { pan: { x: 120, y: 40 }, zoom: 0.5 }]) {
      eng.pan.x = view.pan.x; eng.pan.y = view.pan.y; eng.zoom = view.zoom;
      const sp = screenOf(ent.x, ent.y, eng.pan, eng.zoom);       // 独立公式算屏幕点
      const wpt = eng.screenToWorld(sp.x, sp.y);
      ok(near(wpt.x, ent.x) && near(wpt.y, ent.y) && world.pick(wpt.x, wpt.y) === ent,
        `zoom=${view.zoom}：屏幕点 (${sp.x},${sp.y}) 反查世界 (${wpt.x},${wpt.y}) ⇒ 命中 ${ent.type}`);
      ok(view.zoom === 1 ? world.pick(sp.x, sp.y) === ent : world.pick(sp.x, sp.y) !== ent,
        `zoom=${view.zoom}：区分力自证 —— 把屏幕点当世界点命中 ${world.pick(sp.x, sp.y) ? world.pick(sp.x, sp.y).type : 'null'}`);
      const viaInter = inter.toWorld(sp);
      ok(near(viaInter.x, ent.x) && near(viaInter.y, ent.y),
        `zoom=${view.zoom}：交互层的 toWorld 也是同一出口（(${viaInter.x},${viaInter.y})）`);
    }
  }

  // ── ⑩ 桌面端滚轮缩放：围绕光标、沿用上下限、到限就还手 ──────────────────
  head('⑩ 滚轮缩放：围绕光标位置、上下限 0.25×–4×、到限时把滚轮还给页面');
  {
    const world = new T.World();
    const eng = mkEngine(T, world, []);
    const canvas = eng.canvas;
    const app = mkApp(world, eng, canvas);
    const inter = new T.Interaction(app);
    const Sf = mkSender(canvas);
    const wheel = (x, y, deltaY, over = {}) => {
      const ev = Object.assign({
        clientX: x, clientY: y, deltaY, deltaMode: 0, ctrlKey: false,
        preventDefault() { ev._pd = (ev._pd || 0) + 1; }, target: canvas, type: 'wheel',
      }, over);
      Sf.fire('wheel', ev);
      return ev;
    };

    // (a) 注册参数：`{ passive: false }` 是滚轮缩放**唯一**的静默失效点（不带它 preventDefault 会被忽略）
    const regs = canvas._listeners['wheel'] || [];
    ok(regs.length === 1 && regs[0].opt && regs[0].opt.passive === false,
      `wheel 监听注册 1 次且第三参 passive:false（实测 ${regs.length} 次、opt=${JSON.stringify(regs[0] && regs[0].opt)}）`);

    // (b) 围绕光标：光标下的世界点不动（与捏合同一条不动点判据）
    eng.pan.x = -400; eng.pan.y = -350; eng.zoom = 1.5;
    const cur = { x: 500, y: 400 };
    const w0 = eng.screenToWorld(cur.x, cur.y);
    const z0 = eng.zoom;
    const evIn = wheel(cur.x, cur.y, -120);                    // 向前滚 = 放大
    const w1 = eng.screenToWorld(cur.x, cur.y);
    ok(eng.zoom > z0, `向前滚一格（deltaY=−120）⇒ 放大：${z0} → ${eng.zoom.toFixed(4)}`);
    ok(near(w1.x, w0.x) && near(w1.y, w0.y),
      `光标下的世界点不动：(${w0.x},${w0.y}) → (${w1.x.toFixed(9)},${w1.y.toFixed(9)})（偏差 ${(w1.x - w0.x).toExponential(1)}）`);
    ok(evIn._pd === 1, `真的缩放了 ⇒ preventDefault 被调用（${evIn._pd || 0} 次）`);
    const expPan = { x: cur.x - w0.x * eng.zoom, y: cur.y - w0.y * eng.zoom };
    ok(near(eng.pan.x, expPan.x) && near(eng.pan.y, expPan.y),
      `独立公式复算 pan = 光标 − 世界点×zoom：(${eng.pan.x.toFixed(4)},${eng.pan.y.toFixed(4)})，期望 (${expPan.x.toFixed(4)},${expPan.y.toFixed(4)})`);
    const zBack = eng.zoom;
    wheel(cur.x, cur.y, +120);                                 // 向后滚 = 缩小
    ok(eng.zoom < zBack && near(eng.screenToWorld(cur.x, cur.y).x, w0.x),
      `向后滚一格 ⇒ 缩小到 ${eng.zoom.toFixed(4)}，且仍然围绕光标（世界点不动）`);

    // (c) 上下限：滚到头就停，并且**把滚轮还给页面**
    for (let i = 0; i < 60; i++) wheel(cur.x, cur.y, -120);
    ok(eng.zoom === 4, `连续放大 60 格 ⇒ 夹在上限 ${eng.zoom}`);
    const evTop = wheel(cur.x, cur.y, -120);
    ok(eng.zoom === 4 && !evTop._pd, `已在上限：滚轮什么都不做，且**不** preventDefault（页面滚动还给用户）`);
    for (let i = 0; i < 120; i++) wheel(cur.x, cur.y, +120);
    ok(eng.zoom === 0.25, `连续缩小 120 格 ⇒ 夹在下限 ${eng.zoom}`);
    const evBot = wheel(cur.x, cur.y, +120);
    ok(eng.zoom === 0.25 && !evBot._pd, `已在下限：滚轮不 preventDefault（同上）`);
    const evZero = wheel(cur.x, cur.y, 0);
    ok(!evZero._pd, `deltaY=0 的滚轮事件什么都不做（也不 preventDefault）`);

    // (d) deltaMode 归一化：行/页模式的 deltaY 不是像素，不归一化会「滚一格跳一大截」
    eng.resetView();
    wheel(cur.x, cur.y, -100, { deltaMode: 0 });
    const zPixel = eng.zoom;
    eng.resetView();
    wheel(cur.x, cur.y, -100 / 16, { deltaMode: 1 });
    ok(near(eng.zoom, zPixel, 1e-12),
      `deltaMode 归一化：像素模式 ${zPixel.toFixed(6)} vs 行模式 ${eng.zoom.toFixed(6)}（同一物理滚动量必须同结果）`);

    // (e) ctrl+wheel = 触控板的捏合：必须一直拦住，否则浏览器会去缩**整页**
    eng.resetView();
    const evCtrl = wheel(cur.x, cur.y, -50, { ctrlKey: true });
    ok(evCtrl._pd === 1 && eng.zoom > 1,
      `ctrl+wheel（触控板捏合）：照样缩放画布（zoom=${eng.zoom.toFixed(4)}）且 preventDefault（${evCtrl._pd} 次）—— 不让浏览器去做整页缩放`);
    for (let i = 0; i < 200; i++) wheel(cur.x, cur.y, -50, { ctrlKey: true });
    const evCtrlTop = wheel(cur.x, cur.y, -50, { ctrlKey: true });
    ok(eng.zoom === 4 && evCtrlTop._pd === 1,
      `ctrl+wheel 到上限后仍然 preventDefault（拦的是**浏览器缩放**，不是页面滚动）：zoom=${eng.zoom}、pd=${evCtrlTop._pd}`);

    // (f) 滚轮不得动摇单指/两指状态机
    eng.resetView();
    Sf.down(1, 400, 300, TOUCH);
    Sf.down(2, 500, 300, TOUCH);
    const idsBefore = inter.gesture ? inter.gesture.ids.join() : '无';
    wheel(450, 300, -120);
    ok(inter.gesture && inter.gesture.ids.join() === idsBefore && inter.multi === true,
      `两指手势进行中滚轮不打断手势（ids 仍 [${inter.gesture && inter.gesture.ids.join(',')}]、multi=${inter.multi}）`);
    Sf.up(1, 400, 300, TOUCH); Sf.up(2, 500, 300, TOUCH);
    const dg = inter.drag, wf = inter.wireFrom, gp = inter.gesture;
    wheel(600, 500, -120);
    ok(!dg && !wf && !gp && inter.pid === null,
      `滚轮不产生任何拖动/连线/手势状态（drag=${!!inter.drag}、wireFrom=${!!inter.wireFrom}、gesture=${!!inter.gesture}）`);
  }

  return S;
}

// ══════════════════════════════════════════════════════════
// 主流程
// ══════════════════════════════════════════════════════════
function mutateCases() {
  return [
    {
      tag: 'zoom-off-screenToWorld',
      file: 'src/core/engine.js',
      old: '    const z = this._effZoom();\n    return { x: (x - this.pan.x) / z, y: (y - this.pan.y) / z };',
      new: '    const z = 1;   // MUTANT：换算忘掉 zoom（绘制照旧缩放）\n    return { x: (x - this.pan.x) / z, y: (y - this.pan.y) / z };',
      red: ['①', '②', '③', '⑨', '⑩'],          // 换算出口被改 ⇒ 所有依赖它的节
      note: '换算忘掉 zoom：绘制照旧缩放 ⇒ 看得见、点不中（§①③ 的数值与 §②⑩ 的不动点全红）',
    },
    {
      tag: 'setViewAt-forgets-zoom',
      file: 'src/core/engine.js',
      old: '    this.pan.x = sx - wx * z2;\n    this.pan.y = sy - wy * z2;',
      new: '    this.pan.x = sx - wx;   // MUTANT：忘了乘 zoom ⇒ 缩放围绕左上角\n    this.pan.y = sy - wy;',
      red: ['②', '③', '⑩'],                    // 围绕点缩放的 pan 式子被改 ⇒ 不动点全红；换算出口没动 ⇒ §① 仍绿
      note: 'setViewAt 忘了乘 zoom：缩放变成围绕左上角（§① 的换算口是对的，所以只有不动点相关的节红）',
    },
    {
      tag: 'single-finger-pan',
      file: 'src/ui/interact.js',
      old: "        if (ev.pointerType !== 'touch') this.armPan(p);",
      new: '        this.armPan(p);   // MUTANT：单指触屏也起手平移（用户明令不许）',
      red: ['⑥', '⑦'],                          // 旧文件没有这条语法 ⇒ 镜像红；当前文件多了这条行为 ⇒ §⑦ 红
      note: '单指触屏也起手平移：改动前的副本不会 ⇒ §⑥ 逐位对照红（这条是本轮最值钱的护栏）',
    },
    {
      tag: 'wheel-no-preventDefault',
      file: 'src/ui/interact.js',
      old: '    if (changed || ev.ctrlKey) ev.preventDefault();',
      new: '    // MUTANT：不拦页面滚动（画布缩放了，页面也跟着滚）',
      red: ['⑩'],
      note: '滚轮缩放不再拦页面滚动：画布缩了、页面也跟着滚（真机表现见清单第 6 条）',
      note: 'Node 层能看见「没调 preventDefault」；它在真机上表现为缩画布的同时页面也滚 ⇒ 清单第 6 条',
    },
    {
      tag: 'wheel-passive-true',
      file: 'src/ui/interact.js',
      old: "cv.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });",
      new: "cv.addEventListener('wheel', (e) => this.onWheel(e), { passive: true });   // MUTANT",
      red: ['⑩'],
      note: 'passive:true：Node 只能验注册参数是否被动过；preventDefault 被静默忽略的后果只有浏览器能看见（清单第 6 条）',
      note: 'Node 只能验注册参数；passive:true 的真实后果（preventDefault 被静默忽略、页面跟着滚）只有浏览器能看见 ⇒ 清单第 6 条',
    },
    {
      tag: 'double-tap-resets-pan-only',
      file: 'src/ui/interact.js',
      old: '      if (this.app.engine.resetView()) this.markDirty();',
      new: '      if (this.app.engine.resetPan()) this.markDirty();   // MUTANT：退回用户裁决前的语义',
      red: ['⑧'],
      note: '用户裁决「双击空白 = 复位整个视图」被退回成只复位平移：zoom=3.2 双击后 zoom 仍 3.2。§⑥ 的镜像在 zoom=1 上看不出来 ⇒ 只有 §⑧ 会红（这正是 §⑧ 存在的理由）',
    },
  ];
}

const out = { probe: 'gesture', mutate: MUTATE, items: 0, pass: 0, fail: 0, failed: [] };
try {
  if (!MUTATE) {
    const T = await loadTarget(ROOT, 'repo');
    const S = await runSuite(T);
    out.items = S.pass + S.fail; out.pass = S.pass; out.fail = S.fail; out.failed = S.failed;
  } else {
    const cases = mutateCases();
    const results = [];
    let allOk = true;
    for (const c of cases) {
      const srcRaw = readFileSync(join(ROOT, c.file), 'utf8');
      const hits = srcRaw.split(c.old).length - 1;
      const mutated = srcRaw.replace(c.old, c.new);
      const landInCode = hits === 1 && mutated !== srcRaw;     // 实测推导，不是写死
      const tree = stageTree('gesture-mut-' + c.tag);
      writeFileSync(join(tree, c.file), mutated, 'utf8');
      const T = await loadTarget(tree, c.tag);
      const S = await runSuite(T, { verbose: false });
      // 预期按**节**声明：一次坐标公式变异必然让所有依赖它的判据一起红 —— 逐条点名等于
      // 把整套判据手抄一遍，抄错一条就得到一条假的「期望」。所以这里比的是**节的集合**：
      // 声明的每一节都必须真的有判据转红（missingRed 为空），且声明之外一条都不许红（extraRed 为空）。
      const declared = c.red.slice().sort();
      const observedSecs = [...new Set(S.failSec)].sort();
      const extraRed = S.failed.map((m, i) => ({ m, s: S.failSec[i] || '?' })).filter((r) => !declared.includes(r.s));
      const missingRed = declared.filter((k) => !observedSecs.includes(k));
      const okThis = landInCode && missingRed.length === 0 && extraRed.length === 0;
      const inDeclared = declared.reduce((n2, k) => n2 + (S.secTotal[k] || 0), 0);
      results.push({
        tag: c.tag, file: c.file, landInCode, oldHits: hits, note: c.note || null,
        granularity: 'section',
        expectedRed: declared.join(''), observedRed: observedSecs.join(''),
        redSectionsDeclared: declared, redSectionsObserved: observedSecs,
        observedRedCount: S.failed.length, ctrlBad: extraRed.length, ok: okThis,
        declaredSectionAssertions: inDeclared,
        missingRed,
        firstRed: (S.failed[0] || '').slice(0, 140),
        extraRed: extraRed.map((r) => (r.s + ' ' + r.m).slice(0, 120)),
      });
      rmSync(tree, { recursive: true, force: true });
      allOk = allOk && okThis;
    }
    out.mutants = results;
    out.ok = allOk;
  }
} catch (err) {
  out.error = String(err && err.stack ? err.stack.split('\n').slice(0, 3).join(' | ') : err);
  out.ok = false;
}

console.log('\n' + '─'.repeat(56));
if (MUTATE) {
  console.log('GESTURE_MUTATE_JSON ' + JSON.stringify(out));
} else {
  console.log('GESTURE_JSON ' + JSON.stringify(out));
  if (out.fail === 0) console.log(`\x1b[32m全部通过：${out.items} 项\x1b[0m`);
  else console.log(`\x1b[31m合计 ${out.items} 项，失败 ${out.fail} 项\x1b[0m`);
}
process.exit(MUTATE ? (out.ok ? 0 : 1) : (out.fail === 0 ? 0 : 1));
