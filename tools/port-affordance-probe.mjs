// ══════════════════════════════════════════════════════════
// tools/port-affordance-probe.mjs —— 接线柱「看得见 + 认得出来 + 好对准」的正式验证工具
//
// 为什么必须存在：触屏上连线最卡的一步是「端口不好看见、不好对准」。这条需求落在三处
//   **互相独立**的性质上，任何一处单独做都看得见症状、却测不出病根：
//   ① 命中半径分档 —— 粗指针放大、**细指针逐位不变**（桌面手感是既有资产，放大即回归）；
//   ② 吸附 —— 半径内吸到**最近**的端口，半径外自由连线；
//   ③ 可见化 —— 接线柱与只读插入口必须一眼分得开，高亮/标签只影响手指那一档。
//
// 零依赖、零浏览器：交互层是纯算术 + 一个 Pointer Events 状态机，渲染层的「画了什么」
//   可以用记录型 ctx 抓成指令流。所以这里不启浏览器（公共场所不起可见窗口），只读仓库。
//
// 用法：
//   node tools/port-affordance-probe.mjs              # 全部断言
//   node tools/port-affordance-probe.mjs --mutate     # 变异体自证：每个变异体必须打红**指定**那几节
// 绿：全部通过：N 项（exit 0）／红：合计 N 项，失败 M 项（exit 1）／基础设施不可用：exit 2
// ══════════════════════════════════════════════════════════

import { readFileSync, existsSync, mkdirSync, cpSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TMP = join(process.env.TEMP || '/tmp', 'xm-port-aff');
const MUTATE = process.argv.includes('--mutate');

// ── 判据常量（读的是**产品源码里的值**，不是这里抄一份）────────────────────
const PORT_TOL_MIN_COARSE = 20;      // 「触屏命中半径至少要多大」的下限（需求侧阈值）
const FINE_TOL_EXPECT = 13;          // 细指针档：改前实测值（d=13 命中 / d=13.0001 不命中）
const SNAP_EXPECT = 30;              // 触屏吸附半径（改前不存在，本轮引入）
const GAP = 4;                      // 近邻场景里两个接线柱的间距（px）

/**
 * ⚠ 细指针端口的**改动前实测指令流**（2026-10-20，改动前字节上量出来的）。
 *   [操作, 世界 x, 世界 y, 半径]（`fill`/`stroke` 带的是当时的颜色，另断言）。
 *   这是「桌面鼠标看到的一个像素都不许变」的钉死值 —— 不是从当前源码反推的期望。
 */
const PRE_FINE_WIRE_ONLY = [['arc', 255, 300, 3.4], ['arc', 345, 300, 3.4]];
const PRE_FINE_HOT = [['arc', 255, 300, 5], ['arc', 255, 300, 10], ['arc', 345, 300, 3.4]];

/** 去掉 `//` 与 `/* *\/` 注释：源码扫描必须先剥注释，否则注释里提到的符号会被数进来 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}
const countIn = (src, needle) => stripComments(src).split(needle).length - 1;
const codeOf = (root, rel) => readFileSync(join(root, rel), 'utf8');

// ══════════════════════════════════════════════════════════
// 环境替身：interact / engine 要的那一小撮 DOM 与 canvas API
// ══════════════════════════════════════════════════════════
/** 媒体查询替身：**同一个对象**（engine 会缓存 MediaQueryList 对象、每次读 .matches） */
const COARSE = { matches: false, addEventListener() {}, addListener() {}, removeEventListener() {} };
const NMQ = { matches: false, addEventListener() {}, addListener() {}, removeEventListener() {} };
const WIN = {
  innerWidth: 1280, innerHeight: 800, devicePixelRatio: 1,
  matchMedia: (q) => (q === '(pointer: coarse)' ? COARSE : NMQ),
  _ev: {},
  addEventListener(t, fn) { (WIN._ev[t] ||= []).push(fn); },
  removeEventListener() {},
};
globalThis.window = WIN;
globalThis.performance = globalThis.performance || { now: () => 0 };
globalThis.requestAnimationFrame = globalThis.requestAnimationFrame || (() => 0);
globalThis.cancelAnimationFrame = globalThis.cancelAnimationFrame || (() => {});

/**
 * 记录型 2D 上下文。记的是端口渲染的**载荷**：arc / rect / fillText / fillRect 的实参，
 * 以及 fill()/stroke() 当时用的颜色 ⇒ 「半径与颜色逐位比较」才有依据。
 * ⚠ `measureText` 故意做成**会抛**：标签宽度若靠实测字宽，这里当场炸 —— 见 drawPortLabel 的注释。
 */
/**
 * 记录型 2D 上下文。记的是端口渲染的**载荷**：arc / rect / fillText / fillRect 的实参，
 * 以及 fill()/stroke() 当时用的颜色 ⇒ 「半径与颜色逐位比较」才有依据。
 *
 * ⚠ 坐标一律换算到**世界坐标**（跟着 translate/scale/save/restore 走）：器材是在自己的
 *   局部坐标系里画的（`world.render` 先 translate 到中心），不换算就拿到 `[0,4]` 这种局部值，
 *   跟端口世界坐标永远对不上。引擎在 pan=0/zoom=1 时**不发**任何变换指令（见 engine.render），
 *   所以端口渲染那几节的读数与换算前逐位相同。
 * ⚠ `measureText` 故意做成**会抛**：标签宽度若靠实测字宽，这里当场炸 —— 见 drawPortLabel 的注释。
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
    setLineDash() {}, rotate() {}, clip() {}, beginPath() {}, closePath() {},
    moveTo() {}, lineTo() {}, arcTo() {}, quadraticCurveTo() {}, bezierCurveTo() {},
    ellipse() {}, roundRect() {}, strokeRect() {}, clearRect() {}, strokeText() {},
    fillRect: (x, y, w, h) => trace.push(['fillRect', x * M.s + M.x, y * M.s + M.y, w * M.s, h * M.s]),
    createLinearGradient: () => ({ addColorStop() {} }),
    createRadialGradient: () => ({ addColorStop() {} }),
    getImageData: () => ({ data: [] }), putImageData() {}, drawImage() {},
    arc: (x, y, r) => trace.push(['arc', x * M.s + M.x, y * M.s + M.y, r * M.s]),
    rect: (x, y, w, h) => trace.push(['rect', x * M.s + M.x, y * M.s + M.y, w * M.s, h * M.s]),
    fillText: (t, x, y) => trace.push(['fillText', t, x * M.s + M.x, y * M.s + M.y]),
    fill: () => trace.push(['fill', ctx.fillStyle]),
    stroke: () => trace.push(['stroke', ctx.strokeStyle]),
    measureText: () => { throw new Error('measureText is not allowed here (probe ctx has no font metrics)'); },
    fillStyle: '', strokeStyle: '', lineWidth: 1, lineCap: '', lineJoin: '', font: '',
    textAlign: '', textBaseline: '', globalAlpha: 1, lineDashOffset: 0,
    shadowBlur: 0, shadowColor: '', globalCompositeOperation: '',
  };
  return ctx;
}
function mkCanvas() {
  const cv = {
    width: 800, height: 600, style: {},
    getContext: () => mkG([]),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
    addEventListener() {}, removeEventListener() {},
    hasPointerCapture: () => false, releasePointerCapture() {}, setPointerCapture() {}, focus() {},
  };
  return cv;
}

async function loadTarget(root, tag) {
  const u = (rel) => pathToFileURL(join(root, rel)).href;
  const { Engine } = await import(u('src/core/engine.js'));
  const { World } = await import(u('src/core/world.js'));
  const { Interaction } = await import(u('src/ui/interact.js'));
  const { create, bindRegistry, equipmentPlugins } = await import(u('src/equipment/index.js'));
  const { PluginHost } = await import(u('src/core/plugin.js'));
  const { C } = await import(u('src/core/theme.js'));
  const bootApp = {
    services: {}, ticks: [], world: null, lastCircuit: null, selected: null,
    log: { push() {}, clear() {} }, toast() {},
    addTick(fn) { this.ticks.push(fn); return () => {}; },
  };
  const host = new PluginHost(bootApp);
  for (const p of equipmentPlugins) host.define(p);
  host.installAll();
  bindRegistry(host.registry('equipment'));
  return { tag, root, Engine, World, Interaction, create, C, reg: host.registry('equipment') };
}

/** 一个能跑交互层与渲染层的最小台面 */
function mkRig(T) {
  const world = new T.World();
  const cv = mkCanvas();
  const eng = new T.Engine(cv, world);
  eng.app = { markDirty() {} };
  const app = {
    canvas: cv, world, engine: eng, selected: null,
    select(e) { app.selected = e; }, markDirty() {}, setStatusTool() {}, toast() {},
    doPour() {}, removeEntity() {}, onEntityClicked() {}, onEntityMoved() {},
  };
  const inter = new T.Interaction(app);
  return { world, app, eng, inter };
}
const nameOf = (p) => (p ? `${p.ent.type}#${p.port}` : 'null');
const samePort = (a, b) => (!!a === !!b) && (!a || (a.ent === b.ent && a.port === b.port));
const traceOf = (fn) => { const tr = []; fn(mkG(tr)); return tr; };
const project = (tr) => tr.filter((o) => o[0] === 'arc' || o[0] === 'rect' || o[0] === 'fillText');
const eqTrace = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ══════════════════════════════════════════════════════════
// 断言套件（可重复跑：绿档一次，每个变异体各一次）
// ══════════════════════════════════════════════════════════
async function runSuite(T, opt = {}) {
  const verbose = opt.verbose !== false;
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
  const srcEngine = codeOf(T.root, 'src/core/engine.js');

  // ── ① 命中半径分档：粗指针放大、细指针逐位不变 ────────────────────────
  head('① 命中半径分档（细指针 = 改前实测 13，逐位不变）');
  {
    const { world, inter } = mkRig(T);
    const r = T.create('resistor', 300, 300);
    world.add(r);
    const pw = r.portWorldAt(0);
    info(`单端口场景：${nameOf({ ent: r, port: 0 })} 世界坐标 (${pw.x},${pw.y})`);

    COARSE.matches = false;
    const tolFine = inter.portTol();
    ok(tolFine === FINE_TOL_EXPECT, `细指针命中半径 = ${tolFine}（改前实测 ${FINE_TOL_EXPECT}，逐位不变）`);
    ok(!!inter.pickPortAt({ x: pw.x + 13, y: pw.y }), '细指针 d=13 命中（改前边界，含）');
    ok(inter.pickPortAt({ x: pw.x + 13.0001, y: pw.y }) === null, '细指针 d=13.0001 不命中（改前边界，外）');
    ok(inter.pickPortAt({ x: pw.x + 12.9, y: pw.y }) !== null, '细指针 d=12.9 命中');

    COARSE.matches = true;
    const tolCoarse = inter.portTol();
    ok(tolCoarse === 26 && tolCoarse >= PORT_TOL_MIN_COARSE,
      `粗指针命中半径 = ${tolCoarse} ≥ 阈值 ${PORT_TOL_MIN_COARSE}`);
    ok(tolCoarse > tolFine, `粗指针半径(${tolCoarse}) 严格大于细指针(${tolFine})`);
    ok(!!inter.pickPortAt({ x: pw.x + 26, y: pw.y }), '粗指针 d=26 命中（边界含）');
    ok(inter.pickPortAt({ x: pw.x + 26.1, y: pw.y }) === null, '粗指针 d=26.1 不命中');
    COARSE.matches = false;
    ok(countIn(srcInteract, 'const HIT_PORT = 13;') === 1, '源码里 `const HIT_PORT = 13;` 出现 1 次（细指针档没被改）');
  }

  // ── ② 吸附半径：内侧吸附 / 外侧自由连线 ──────────────────────────────
  head('② 吸附半径两侧对照（内侧吸附 / 外侧不吸附）');
  {
    const { world, inter } = mkRig(T);
    const r = T.create('resistor', 300, 300);
    world.add(r);
    const pw = r.portWorldAt(0);
    ok(countIn(srcInteract, 'const PORT_SNAP_COARSE = 30;') === 1,
      `源码里 \`const PORT_SNAP_COARSE = ${SNAP_EXPECT};\` 出现 1 次`);
    COARSE.matches = true;
    const inside = [29.9, 30];
    const outside = [30.1, 31];
    for (const d of inside) {
      const got = inter.snapPortAt({ x: pw.x + d, y: pw.y });
      ok(samePort(got, { ent: r, port: 0 }), `粗指针 d=${d}（半径内）吸附到 ${nameOf({ ent: r, port: 0 })}，实测 ${nameOf(got)}`);
    }
    for (const d of outside) {
      const got = inter.snapPortAt({ x: pw.x + d, y: pw.y });
      ok(got === null, `粗指针 d=${d}（半径外）不吸附 ⇒ 自由连线，实测 ${nameOf(got)}`);
    }
    COARSE.matches = false;
    for (const d of [0, 12, 29.9, 30, 30.1, 31]) {
      ok(inter.snapPortAt({ x: pw.x + d, y: pw.y }) === null, `细指针 d=${d} 不吸附（鼠标档位与改动前逐位相同）`);
    }
    ok(inter.wirePortAt({ x: pw.x + 12.9, y: pw.y }) !== null,
      '细指针 d=12.9 的 wirePortAt 仍命中（命中半径内）');
    const farFine = inter.wirePortAt({ x: pw.x + 29.9, y: pw.y });
    ok(farFine === null,
      `细指针 d=29.9（在吸附半径内、已超命中半径）⇒ wirePortAt = ${nameOf(farFine)}（鼠标不吸）`);
  }

  // ── ③ 两个端口近邻时取**最近**的那个（不受叠放次序影响）───────────────
  head('③ 近邻取舍：吸附取几何最近（与点选的顶层优先是两回事）');
  {
    const { world, inter } = mkRig(T);
    const L = T.create('resistor', 390, 304); world.add(L);   // 下层：左端口落在 (345,304)
    const U = T.create('resistor', 300, 300); world.add(U);   // 上层（后添加）
    const pu = U.portWorldAt(1);                              // (345,300)
    const pl = L.portWorldAt(0);                              // (345,304)
    const gap = Math.hypot(pu.x - pl.x, pu.y - pl.y);
    ok(Math.abs(gap - GAP) < 0.01, `构造出相距 ${gap.toFixed(2)}px 的一对端口（U 在上层 (${pu.x},${pu.y})，L 在下层 (${pl.x},${pl.y})）`);
    COARSE.matches = true;
    {
      const w = { x: 349, y: 303 };                            // 距 L 4.12、距 U 5.00
      const got = inter.snapPortAt(w);
      ok(got && got.ent === L, `指针 (349,303) 距 L=${Math.hypot(pl.x - 349, pl.y - 303).toFixed(2)} 距 U=${Math.hypot(pu.x - 349, pu.y - 303).toFixed(2)} ⇒ 吸附到**更近的 L**，实测 ${nameOf(got)}`);
      const pick = inter.pickPortAt(w);
      ok(pick && pick.ent === U, `同一点的点选仍走顶层优先 ⇒ **U**（两条口径的分工是有意的），实测 ${nameOf(pick)}`);
    }
    {
      const w = { x: 345, y: 305.5 };                          // 距 L 1.50、距 U 5.50
      const got = inter.snapPortAt(w);
      ok(got && got.ent === L, `指针 (345,305.5) ⇒ 吸附到更近的 L，实测 ${nameOf(got)}`);
    }
    {
      const w = { x: 345, y: 297 };                            // 距 U 3.00、距 L 7.00
      const got = inter.snapPortAt(w);
      ok(got && got.ent === U, `指针 (345,297) ⇒ 吸附到更近的 U（不是恒偏某一层），实测 ${nameOf(got)}`);
    }
  }

  // ── ④ 唯一判据 + 重叠次序（只能有一个答案）──────────────────────────
  head('④ 判据唯一：三处调用共用 pickPortAt；重叠时命中优先');
  {
    ok(countIn(srcInteract, 'world.pickPort(') === 1,
      `interact.js 里 \`world.pickPort(\` 只出现 1 次（在 pickPortAt 内），实测 ${countIn(srcInteract, 'world.pickPort(')}`);
    ok(countIn(srcInteract, 'this.pickPortAt(') === 3,
      `\`this.pickPortAt(\` 出现 3 次（点选 / wire 工具 / onMove 高亮），实测 ${countIn(srcInteract, 'this.pickPortAt(')}`);
    ok(countIn(srcInteract, 'this.snapPortAt(') === 1,
      `\`this.snapPortAt(\` 只出现 1 次（只在 wirePortAt 内），实测 ${countIn(srcInteract, 'this.snapPortAt(')}`);
    ok(countIn(srcInteract, 'wirePortAt(') === 4,
      `\`wirePortAt(\` 出现 4 次（定义 + wire 工具 + onMove 高亮 + 连线预览落点），实测 ${countIn(srcInteract, 'wirePortAt(')}`);
    ok(/wirePortAt\(w\)\s*\{\s*return this\.pickPortAt\(w\)\s*\|\|\s*this\.snapPortAt\(w\);\s*\}/.test(stripComments(srcInteract)),
      'wirePortAt = pickPortAt || snapPortAt（**命中优先**，次序写死在这一处）');

    const { world, inter } = mkRig(T);
    const L = T.create('resistor', 390, 304); world.add(L);
    const U = T.create('resistor', 300, 300); world.add(U);
    COARSE.matches = true;
    {
      const w = { x: 349, y: 303 };                            // 两者都在命中半径 26 内，L 更近
      const win = inter.wirePortAt(w);
      ok(samePort(win, { ent: U, port: 1 }),
        `重叠时命中优先：指针 (349,303) 两者都在 26 内 ⇒ wirePortAt 取顶层命中 U#1（更近的 L#0 只在吸附层胜出），实测 ${nameOf(win)}`);
    }
    // 细指针档：wirePortAt 必须与 pickPortAt 完全等价（桌面只有一条判据）
    COARSE.matches = false;
    let same = 0, total = 0;
    for (let dx = -40; dx <= 40; dx += 8) {
      for (let dy = -40; dy <= 40; dy += 8) {
        const w = { x: 345 + dx, y: 300 + dy };
        total++;
        if (samePort(inter.wirePortAt(w), inter.pickPortAt(w))) same++;
      }
    }
    ok(same === total, `细指针 wirePortAt === pickPortAt 在 ${total} 个采样点上全部一致（实测一致 ${same}）`);
  }

  // ── ⑤ 只读 `probe` 类端口不参与电路吸附 ─────────────────────────────
  head('⑤ 只读插入口（kind=probe）不参与电路吸附');
  {
    const def = T.reg.list().find((d) => (d.ports || []).some((p) => p.kind === 'probe'));
    if (!def) { ok(false, '找不到任何带 probe 类端口的器材（插件表变了？）'); }
    else {
      const { world, inter } = mkRig(T);
      const e = T.create(def.type, 400, 400);
      world.add(e);
      const idx = e.ports.findIndex((p) => p.kind === 'probe');
      const pw = e.portWorldAt(idx);
      info(`只读端口样例：${def.type} #${idx} kind=${e.ports[idx].kind} label=${e.ports[idx].label} @ (${pw.x},${pw.y})`);
      COARSE.matches = true;
      for (const d of [0, 5, 29.9]) {
        const got = inter.snapPortAt({ x: pw.x + d, y: pw.y });
        ok(got === null, `粗指针 d=${d}：probe 端口不吸附（实测 ${nameOf(got)}）`);
      }
      ok(inter.pickPortAt({ x: pw.x, y: pw.y }) !== null,
        'probe 端口仍然可被命中（「不吸」不等于「看不见」—— 它本来就可点）');
      ok(countIn(srcInteract, "if (e.ports[i].kind !== 'wire') continue;") === 1,
        '源码里吸附循环显式跳过 `kind !== \'wire\'`（1 处）');
    }
  }

  // ── ⑥ 渲染：接线柱与只读插入口一眼分得开 ─────────────────────────────
  head('⑥ 渲染分型：wire = 实心圆 / probe = 空心方');
  {
    const { world, eng } = mkRig(T);
    const r = T.create('resistor', 300, 300); world.add(r);
    const def = T.reg.list().find((d) => (d.ports || []).some((p) => p.kind === 'probe'));
    const b = def ? T.create(def.type, 600, 300) : null;
    if (b) world.add(b);
    COARSE.matches = false;
    const tr = traceOf((g) => eng.drawPorts(g, world));
    const pw = r.portWorldAt(0);
    ok(tr.some((o) => o[0] === 'arc' && o[1] === pw.x && o[2] === pw.y && o[3] === 3.4),
      `接线柱画成实心圆：arc(${pw.x},${pw.y},3.4)（细指针既有值）`);
    if (b) {
      const idx = b.ports.findIndex((p) => p.kind === 'probe');
      const q = b.portWorldAt(idx);
      ok(tr.some((o) => o[0] === 'rect'), '只读插入口画成**方**（rect）—— 与电路接线柱区分开');
      ok(!tr.some((o) => o[0] === 'arc' && Math.abs(o[1] - q.x) < 0.01 && Math.abs(o[2] - q.y) < 0.01),
        `插入口位置上**没有**画圆（arc at (${q.x},${q.y}) 不存在）`);
      ok(!tr.some((o) => o[0] === 'rect' && Math.abs(o[1] + o[3] / 2 - pw.x) < 0.01), '接线柱位置上**没有**画方');
    }
    ok(countIn(srcEngine, "const isWire = (port.kind || 'wire') === 'wire';") === 1,
      '源码里 `kind` 分型判据出现 1 次（分型只有一处）');
  }

  // ── ⑦ 档位渲染：细指针逐位不变 + 粗指针放大 ───────────────────────────
  head('⑦ 细指针渲染逐位不变 / 粗指针放大（对照断言）');
  {
    const { world, eng } = mkRig(T);
    const r = T.create('resistor', 300, 300); world.add(r);
    const wireOnly = (coarse, hot) => {
      COARSE.matches = coarse;
      // ⚠ 用 `null` 表示「没有高亮」，不许用 falsy 判断：端口 #0 是**合法**的 hotPort
      eng.hotPort = hot === null ? null : { ent: r, port: hot };
      return traceOf((g) => eng.drawPorts(g, world));
    };
    const finePlain = project(wireOnly(false, null));
    ok(eqTrace(finePlain, PRE_FINE_WIRE_ONLY),
      `细指针·无高亮 的指令流 == 改动前实测 ${JSON.stringify(PRE_FINE_WIRE_ONLY)}，实测 ${JSON.stringify(finePlain)}`);
    const fineHot = project(wireOnly(false, 0));
    ok(eqTrace(fineHot, PRE_FINE_HOT),
      `细指针·高亮 的指令流 == 改动前实测 ${JSON.stringify(PRE_FINE_HOT)}，实测 ${JSON.stringify(fineHot)}`);

    COARSE.matches = false;
    const c1 = wireOnly(false, null);
    const fineFill = c1.filter((o) => o[0] === 'fill').map((o) => o[1]);
    ok(eqTrace(fineFill, [T.C.port, T.C.port]),
      `细指针·无高亮 的填充色 == 主题既有值 C.port（${T.C.port}），实测 ${JSON.stringify(fineFill)}`);
    const hotFill = wireOnly(false, 0).filter((o) => o[0] === 'fill').map((o) => o[1]);
    ok(hotFill[0] === T.C.portHot, `细指针·高亮 的填充色 == C.portHot（${T.C.portHot}），实测 ${hotFill[0]}`);
    const coarsePlain = project(wireOnly(true, null));
    const coarseFill = wireOnly(true, null).filter((o) => o[0] === 'fill').map((o) => o[1]);
    ok(eqTrace(fineFill, coarseFill), `粗/细两档的填充色逐位相同（放大不换颜色）：${JSON.stringify(fineFill)}`);
    ok(coarsePlain.every((o, i) => o[0] === finePlain[i][0] && o[1] === finePlain[i][1] && o[2] === finePlain[i][2]),
      '粗/细两档的操作序列与**位置**逐位相同（只有半径不同）');
    ok(coarsePlain.every((o, i) => o[3] > finePlain[i][3]),
      `粗指针半径整体放大：细 ${finePlain.map((o) => o[3]).join('/')} ⇒ 粗 ${coarsePlain.map((o) => o[3]).join('/')}`);

    // 桌面鼠标不该看到标签：选中一件器材（有标签端口）在细指针下仍无 fillText
    const wdef = T.reg.list().find((d) => (d.ports || []).some((p) => p.kind === 'wire' && p.label));
    if (wdef) {
      const w2 = new T.World();
      const e2 = T.create(wdef.type, 300, 300);
      w2.add(e2);
      e2.selected = true;
      const tr = (coarse) => { COARSE.matches = coarse; return traceOf((g) => eng.drawPorts(g, w2)).filter((o) => o[0] === 'fillText'); };
      ok(tr(false).length === 0, `细指针 + 选中器材(${wdef.type}) ⇒ 不画任何端口标签（桌面外观不变）`);
      ok(tr(true).length > 0, `粗指针 + 选中器材(${wdef.type}) ⇒ 端口标签亮出来（实测 ${tr(true).length} 条 fillText）`);
    }
  }

  // ── ⑧ 标签：高亮的那个一定画，且不依赖 measureText ────────────────────
  head('⑧ 高亮端口一定带标签（且不依赖实测字宽）');
  {
    const wdef = T.reg.list().find((d) => (d.ports || []).some((p) => p.kind === 'wire' && p.label));
    if (!wdef) ok(false, '找不到带标签的接线柱（插件表变了？）');
    else {
      const { world, eng } = mkRig(T);
      const e = T.create(wdef.type, 300, 300);
      world.add(e);
      const idx = e.ports.findIndex((p) => p.kind === 'wire' && p.label);
      const label = e.ports[idx].label;
      for (const coarse of [false, true]) {
        COARSE.matches = coarse;
        eng.hotPort = { ent: e, port: idx };
        const texts = traceOf((g) => eng.drawPorts(g, world)).filter((o) => o[0] === 'fillText');
        ok(texts.length === 1 && texts[0][1] === label,
          `${coarse ? '粗' : '细'}指针·高亮 #${idx} ⇒ 恰好 1 条标签 "「${label}」"，实测 ${JSON.stringify(texts)}`);
      }
      ok(countIn(srcEngine, 'measureText') === 0, '源码里没有 `measureText`（标签宽度按定值估，探针的假 ctx 会抛）');
    }
  }

  // ── ⑨ 插件的 dot() 只是美工端子、不是交互标记 ────────────────────────
  head('⑨ 美工端子(2.6px) 与交互标记是两笔不同的绘制');
  {
    const { world, eng } = mkRig(T);
    // 现场挑一个**真的画了美工端子**（`dot()`，2.6px）的器材 —— 不写死类型名：
    //   · `resistor` 那类器材的美工只有引线（没有圆点）⇒ 拿它做这条断言会得到**空指令流**式的假绿；
    //   · 只认「2.6px 弧」又会误收**别的小圆弧**（电流表把指针轴心画成 2.6px）⇒ 必须再要求
    //     这个弧落在**该器材自己的某个接线柱**上（4px 内）。判据松一格就是一次假绿。
    let r = null;
    for (const d of T.reg.list()) {
      const e = T.create(d.type, 300, 300);
      eng.hotPort = null;
      let tr = [];
      try { tr = traceOf((g) => e.render(g)); } catch (err) { continue; }
      // 器材是在局部坐标系里画的（rot=0，世界坐标减中心即局部坐标）
      const lp = e.ports.map((_, i) => { const p = e.portWorldAt(i); return [p.x - e.x, p.y - e.y]; });
      if (tr.some((o) => o[0] === 'arc' && o[3] === 2.6 && lp.some(([x, y]) => Math.hypot(o[1] - x, o[2] - y) < 4))) { r = e; break; }
    }
    ok(!!r, `找到一个「美工端子和自己的接线柱画在一起」的器材（2.6px 弧落在某端口 4px 内）：${r ? r.type : '（一个都没有 ⇒ 插件表变了？）'}`);
    if (r) {
      world.add(r);
      // ⚠ 断言走**真实渲染管线**（`engine.render()`），不是手动调 `entity.render()`：
      //   只有走管线，才能抓住「器材自身绘制偷偷读了交互态」这种耦合（见变异体 M13）——
      //   手动调 entity.render 的那版拿它没辙（那正是本探针自己造出来的盲区）。
      const frame = (hot) => {
        eng.hotPort = hot === null ? null : { ent: r, port: hot };
        const tr = [];
        eng.g = mkG(tr);
        eng.render();
        return tr;
      };
      const artOf = (tr) => tr.filter((o) => o[0] === 'arc' && o[3] === 2.6).map((o) => [o[1], o[2]]);
      const arcRs = (tr) => tr.filter((o) => o[0] === 'arc').map((o) => o[3]);
      COARSE.matches = false;
      const t0 = frame(null), t1 = frame(0);
      const a0 = artOf(t0), a1 = artOf(t1);
      ok(a0.length > 0, `真实渲染管线里能看到美工端子：2.6px 的 arc 共 ${a0.length} 个（${JSON.stringify(a0)}）`);
      ok(eqTrace(a0, a1), `器材自身的 2.6px 端子在 hotPort 有无时**逐位相同**（数量与位置）：${JSON.stringify(a0)}`);
      const m0 = arcRs(t0), m1 = arcRs(t1);
      ok(m0.includes(3.4), `交互标记半径来自 engine.drawPorts（细指针 3.4），实测整帧 arc 半径集 ${JSON.stringify([...new Set(m0)])}`);
      ok(!eqTrace(m0, m1), `交互标记**会**随 hotPort 变（美工端子不会）—— 两笔不同源：${JSON.stringify(m0)} ⇒ ${JSON.stringify(m1)}`);
      const allPorts = r.ports.map((_, i) => { const p = r.portWorldAt(i); return [p.x, p.y]; });
      ok(a0.some(([x, y]) => allPorts.some(([px, py]) => Math.hypot(x - px, y - py) < 4)),
        `美工端子画在**某个接线柱上**（端子 ${JSON.stringify(a0[0])}，该器材端口 ${JSON.stringify(allPorts)}）—— 同一位置的**两笔**绘制`);

      // 「除了端口标记之外的整帧」在 hotPort 有无时必须逐位相同 ——
      // 这一条才是「美工没有偷读交互态」的**完整**判据：只盯 2.6px 那个弧会漏掉
      // 「高亮时多画一笔美工」这种耦合（变异体 M13 就是这么漏过去的）。
      const noMarkers = (hot) => {
        eng.hotPort = hot === null ? null : { ent: r, port: hot };
        const orig = eng.drawPorts;
        eng.drawPorts = () => {};                 // 只摘掉端口标记，其余绘制全留着
        try { const tr = []; eng.g = mkG(tr); eng.render(); return tr; }
        finally { eng.drawPorts = orig; }
      };
      const w0 = noMarkers(null), w1 = noMarkers(0);
      ok(eqTrace(w0, w1),
        `**除端口标记外**的整帧绘制在 hotPort 有无时逐位相同（${w0.length} 条指令）—— 器材美工确实没读交互态`);
      eng.hotPort = null;
    }
  }

  return S;
}

// ══════════════════════════════════════════════════════════
// 变异体：把 src 摊进临时镜像，按**唯一锚点**改一行后重跑同一套断言
// ══════════════════════════════════════════════════════════
/**
 * 每个变异体 = 一组「唯一锚点 → 改写」+ **它必须打红的小节**。
 * ⚠ 变异只发生在 %TEMP% 镜像里；仓库文件一个字节都不动（跑完由 sha256 自证）。
 * ⚠ `expect` 里的小节号必须来自「这条性质归谁钉」：一个改动破坏两条独立性质就写两节，别为了好看少写。
 */
const MUTANTS = [
  { id: 'M1-coarse-tol-not-raised', patches: [{ rel: 'src/ui/interact.js', from: 'const HIT_PORT_COARSE = 26;', to: 'const HIT_PORT_COARSE = 13;' }], expect: '①' },
  // 细指针也吸附 ⇒ ②的两侧对照红；同时 ④的「细指针 wirePortAt === pickPortAt」（81 点采样）也红
  { id: 'M2-fine-also-snaps', patches: [{ rel: 'src/ui/interact.js', from: 'if (!coarsePointer()) return null;', to: 'if (false) return null;' }], expect: '②④' },
  { id: 'M3-snap-ignores-radius', patches: [{ rel: 'src/ui/interact.js', from: 'if (d <= r2 && d < bd)', to: 'if (d < 1e9 && d < bd)' }], expect: '②' },
  { id: 'M4-first-wins-not-nearest', patches: [{ rel: 'src/ui/interact.js', from: 'if (d <= r2 && d < bd)', to: 'if (d <= r2 && best === null)' }], expect: '③' },
  { id: 'M5-order-flipped', patches: [{ rel: 'src/ui/interact.js', from: 'wirePortAt(w) { return this.pickPortAt(w) || this.snapPortAt(w); }', to: 'wirePortAt(w) { return this.snapPortAt(w) || this.pickPortAt(w); }' }], expect: '④' },
  { id: 'M6-probe-ports-snap-too', patches: [{ rel: 'src/ui/interact.js', from: "if (e.ports[i].kind !== 'wire') continue;", to: 'if (false) continue;' }], expect: '⑤' },
  { id: 'M7-probe-drawn-as-wire', patches: [{ rel: 'src/core/engine.js', from: "const isWire = (port.kind || 'wire') === 'wire';", to: 'const isWire = true;' }], expect: '⑥' },
  { id: 'M8-coarse-visual-not-raised', patches: [{ rel: 'src/core/engine.js', from: 'const PORT_R_COARSE = { wire: 4.8, probe: 4.6, hot: 6.6, halo: 15, label: 12 };', to: 'const PORT_R_COARSE = { wire: 3.4, probe: 3.2, hot: 5, halo: 10, label: 11 };' }], expect: '⑦' },
  { id: 'M9-fine-tol-drifts', patches: [{ rel: 'src/ui/interact.js', from: 'const HIT_PORT = 13;', to: 'const HIT_PORT = 20;' }], expect: '①' },
  { id: 'M10-second-criterion', patches: [{ rel: 'src/ui/interact.js', from: 'const port = this.wirePortAt(w);', to: 'const port = world.pickPort(w.x, w.y, HIT_PORT);' }], expect: '④' },
  // 「细档也被放大」：⑦ 的**改动前实测字面量**会红，⑨ 的「交互标记 3.4」也会红
  { id: 'M11-fine-visual-also-raised', patches: [{ rel: 'src/core/engine.js', from: 'const PORT_R_FINE = { wire: 3.4, probe: 3.2, hot: 5, halo: 10, label: 11 };', to: 'const PORT_R_FINE = { wire: 4.8, probe: 4.6, hot: 6.6, halo: 15, label: 12 };' }], expect: '⑥⑦⑨' },
  // 「hotPort 被忽略」：高亮的半径/光环、标签、以及「标记随 hotPort 变」三条一起红
  { id: 'M12-hot-ignored', patches: [{ rel: 'src/core/engine.js', from: 'const isHot = hot && hot.ent === e && hot.port === i;', to: 'const isHot = false;' }], expect: '⑦⑧⑨' },
  // 「美工端子拿到 hotPort」：让器材自身的绘制随高亮变 ⇒ ⑨ 的「两笔不同源」当场红
  //（只改 %TEMP% 镜像里的 electronics.js，仓库那份不碰）
  {
    id: 'M13-artwork-gets-hot',
    patches: [
      { rel: 'src/core/engine.js', from: 'world.render(g);', to: 'g.__hotProbe = !!this.hotPort; world.render(g);' },
      { rel: 'src/equipment/electronics.js', from: 'function dot(g, x, y, color = WIRE) {', to: "function dot(g, x, y, color = WIRE) { if (g.__hotProbe) { g.fillStyle = '#2dd4bf'; g.beginPath(); g.arc(x, y, 5, 0, TAU); g.fill(); }" },
    ],
    expect: '⑨',
  },
  { id: 'M14-snap-radius-26', patches: [{ rel: 'src/ui/interact.js', from: 'const PORT_SNAP_COARSE = 30;', to: 'const PORT_SNAP_COARSE = 26;' }], expect: '②' },
];

/** 摊一份 %TEMP% 镜像并按锚点改写；锚点必须**恰好命中 1 次**（0 次＝改不到、>1 次＝改错地方，都不算落地） */
function stage(name, patches) {
  const dir = join(TMP, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  cpSync(join(ROOT, 'src'), join(dir, 'src'), { recursive: true });
  if (!patches || !patches.length) return { dir, landed: true, detail: [] };
  const detail = [];
  for (const p of patches) {
    const file = join(dir, p.rel);
    const src = readFileSync(file, 'utf8');
    const hits = stripComments(src).split(p.from).length - 1;
    detail.push({ rel: p.rel, hits });
    if (hits !== 1) return { dir, landed: false, hits, detail };
    writeFileSync(file, src.replace(p.from, p.to));
  }
  return { dir, landed: true, hits: 1, detail };
}

// ══════════════════════════════════════════════════════════
// 主流程
// ══════════════════════════════════════════════════════════
if (!existsSync(join(ROOT, 'src/core/engine.js'))) {
  console.log('基础设施不可用：找不到 src/core/engine.js');
  process.exit(2);
}

if (!MUTATE) {
  const T = await loadTarget(ROOT, 'live');
  const S = await runSuite(T);
  const redIds = [...new Set(S.failSec)];
  console.log(`\n${S.fail === 0 ? '\x1b[32m全部通过' : '\x1b[31m有失败'}：${S.pass + S.fail} 项\x1b[0m${S.fail ? `，失败 ${S.fail} 项` : ''}`);
  console.log('PORT_AFFORDANCE_JSON ' + JSON.stringify({
    items: S.pass + S.fail, pass: S.pass, fail: S.fail,
    sections: Object.keys(S.secTotal).length, redIds,
  }));
  if (S.fail) { console.log('失败明细：'); for (const f of S.failed) console.log('  - ' + f); }
  process.exit(S.fail ? 1 : 0);
}

// ── --mutate：对照 + 每个变异体 ────────────────────────────────────────
// ⚠ 变异只发生在 %TEMP% 镜像里：仓库文件一个字节都不许动。跑前跑后各量一次 sha256 自证。
const TOUCHED = ['src/ui/interact.js', 'src/core/engine.js', 'src/equipment/electronics.js'];
const sha = (rel) => createHash('sha256').update(readFileSync(join(ROOT, rel))).digest('hex');
const before = Object.fromEntries(TOUCHED.map((r) => [r, sha(r)]));

/** 一条变异体把探针自己搞崩（例如打断了 import）也算**基础设施**，不能算「红节对齐」 */
const safeSuite = async (T) => {
  try { return await runSuite(T, { verbose: false }); }
  catch (err) { return { infra: true, err: String((err && err.message) || err) }; }
};

const ctrl = stage('ctrl', null);
const ctrlS = await safeSuite(await loadTarget(ctrl.dir, 'ctrl'));
const ctrlReds = ctrlS.infra ? ['INFRA'] : [...new Set(ctrlS.failSec)];
console.log(`\n对照（未变异镜像）：${ctrlS.infra ? '基础设施失败 ' + ctrlS.err : `失败 ${ctrlS.fail} 项，红节 ${JSON.stringify(ctrlReds)}`}`);
let expectedRed = 0, observedRed = 0, ctrlBad = ctrlReds.length ? 1 : 0, landed = 0, redsAligned = 0, infra = 0;
const rows = [];
for (const m of MUTANTS) {
  expectedRed += m.expect.length;
  const st = stage('mut-' + m.id, m.patches);
  if (!st.landed) {
    infra++;
    rows.push({ id: m.id, landed: false, detail: st.detail, red: [], want: m.expect, aligned: false });
    console.log(`  \x1b[31m✗\x1b[0m ${m.id}: 锚点没落地 ${JSON.stringify(st.detail)}（每个锚点必须恰好命中 1 次）`);
    continue;
  }
  landed++;
  const S = await safeSuite(await loadTarget(st.dir, m.id));
  if (S.infra) {
    infra++;
    rows.push({ id: m.id, landed: true, detail: st.detail, red: ['INFRA'], want: m.expect, aligned: false, err: S.err });
    console.log(`  \x1b[31m✗\x1b[0m ${m.id}: 基础设施失败 —— ${S.err}`);
    continue;
  }
  const red = [...new Set(S.failSec)];
  observedRed += red.length;
  const aligned = red.length === m.expect.length && m.expect.split('').every((c) => red.includes(c));
  if (aligned) redsAligned++;
  rows.push({ id: m.id, landed: true, detail: st.detail, red, want: m.expect, aligned });
  console.log(`  ${aligned ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${m.id}: 期望红 ${m.expect}，实测红 ${JSON.stringify(red)}${aligned ? '' : ' ← 不一致'}`);
}
const after = Object.fromEntries(TOUCHED.map((r) => [r, sha(r)]));
const repoIntact = TOUCHED.every((r) => before[r] === after[r]);
const ok = ctrlBad === 0 && infra === 0 && redsAligned === MUTANTS.length && repoIntact;
console.log(`\n变异体 ${MUTANTS.length} 个：落地 ${landed}、红节对齐 ${redsAligned}、期望红 ${expectedRed}、实测红 ${observedRed}、对照误红 ${ctrlBad}、仓库未被动过 ${repoIntact}`);
if (!repoIntact) for (const r of TOUCHED) if (before[r] !== after[r]) console.log(`  \x1b[31m仓库被动过\x1b[0m ${r}: ${before[r]} ⇒ ${after[r]}`);
console.log('PORT_AFFORDANCE_MUTATE ' + JSON.stringify({
  expectedRed, observedRed, ctrlBad, mutants: MUTANTS.length, landed, redsAligned, infra, repoIntact, repo: after, ok,
}));
console.log(JSON.stringify({ rows }));
process.exit(ok ? 0 : 1);
