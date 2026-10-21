#!/usr/bin/env node
// ══════════════════════════════════════════════════════════
// tools/grid-probe.mjs —— task-28「网格 / 坐标开关」的判据夹具
//
// 规格：plans/17-第二批五项-接缝图.md 的 ④ 网格 / 坐标开关（六栏）。
//
// 为什么必须存在（本项最危险的两件事）：
//   1. **pan-probe §②「恒等视口逐位相同」** —— 本探针用 `E1` 在**进程内**把它抄一遍：
//      开/关两态的「变换指令流」（setTransform / clearRect / translate / scale）必须逐位相同。
//      ⚠ 实测那串指令流**只记这四个方法**（pan-probe 的 mkG）⇒ 它守的是**视口变换**，
//        不是「画了什么」⇒ 网格开关与它**没有因果关系**；但仍然逐条取证。
//   2. **「关掉网格」最容易假绿**（空集恒真）⇒ 先断言开态线段数 > 0 且样式/条数正确，
//      再断言关态 === 0。条数期望**用 `engine.gridSize` 自身表达**，不写字面量 24。
//
// 用法：
//   node tools/grid-probe.mjs            # 绿档：全部断言
//   node tools/grid-probe.mjs --smoke    # 只打读数（不给判断），用于人工核对
//   node tools/grid-probe.mjs --mutate   # 红档：变异体自证（父进程编排）
//   node tools/grid-probe.mjs --run      # 子进程模式：只跑断言 + 打机器可读 JSON
//
// ⚠ 红档**每个变异体新起一个 node 子进程**（`GRID_MUT_DIR` 指向 %TEMP% 里的改动副本）：
//   同进程里「就地改写模块文件 → 再 import()」拿到的是**缓存里的旧实例** ⇒ 变异体恒绿。
//   全进程 + 全新 URL（`file:///` 绝对）双重规避；另配 `M0-canary` 阳性对照证明真的换了代码。
// ⚠ 子进程**无论红绿都打 `GRID_JSON`**：模块求值期崩溃有顶层 try/catch 兜，断言组崩溃有
//   `group()` 兜（整组记红、继续跑下一组）⇒ 不会出现「红档没打 JSON」这种不可判读的结局。
// ⚠ 变异体锚点一律**只含代码行、不含注释**，且必须在文件里唯一：判据同时数「原样命中」
//   与「去注释后命中」，任何一条为 0 就算**没落进代码**（这是红档最容易整族空转的地方）。
// ⚠ **不用退出码判成败** —— 成败只看 JSON 里的 failed 集合。
// ══════════════════════════════════════════════════════════

import { readFileSync, writeFileSync, mkdirSync, cpSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MUT_ROOT = process.env.GRID_MUT_DIR || '';       // 子进程模式：临时副本的仓库根
const SRC_ROOT = MUT_ROOT || ROOT;
/** ⚠ Windows 上裸路径会被当成协议（`E:` ⇒ ERR_UNSUPPORTED_ESM_URL_SCHEME）⇒ 一律 file:/// */
const asURL = (rel) => pathToFileURL(join(SRC_ROOT, rel)).href;

const MODE_SMOKE = process.argv.includes('--smoke');
const MODE_MUT = process.argv.includes('--mutate');

// ── 记账（按 id 覆盖写：整组抛错时用「整组记红」盖掉组内已打过的 ✓）──
const items = [];
const ok = (id, cond, msg) => {
  const rec = { id, ok: !!cond, msg };
  const i = items.findIndex((x) => x.id === id);
  if (i >= 0) items[i] = rec; else items.push(rec);
};
const failedIds = () => items.filter((i) => !i.ok).map((i) => i.id);
const emit = (extra) => {
  const f = failedIds();
  console.log('GRID_JSON ' + JSON.stringify(Object.assign({
    probe: 'grid', mutate: MODE_MUT, items: items.length,
    pass: items.length - f.length, fail: f.length, failed: f,
  }, extra || {})));
  return f.length;
};
const emitCrash = (where, e) => {
  console.log('GRID_JSON ' + JSON.stringify({
    probe: 'grid', mutate: MODE_MUT, crash: where, error: String((e && e.message) || e),
    items: 0, pass: 0, fail: 0, failed: [],
  }));
};
/** 断言组隔离：组内抛错 ⇒ 该组全部 id 记红并继续下一组（否则一处崩溃会把整个红档变成「没 JSON」） */
const group = async (ids, fn) => {
  try { await fn(); } catch (e) { for (const id of ids) ok(id, false, `[整组抛错] ${String((e && e.message) || e)}`); }
};

// ══════════════════════════════════════════════════════════
// 环境替身：记录型 2D 上下文
// ══════════════════════════════════════════════════════════

/**
 * ⚠ `moveTo` 计数器带**上限护栏**：`gridSize` 为 0 / 负数 / Infinity 时
 *   `for (…; x += s)` 会**死循环**（页面卡死级别的 bug）⇒ 栏到上限就抛，
 *   让边界断言能在**有限时间内**给出红，而不是把探针一起挂死。
 */
const RUNAWAY = 200000;

function mkPaintTrace() {
  const rec = { strokes: [], texts: [], transforms: [], fills: 0, moveToCount: 0, runaway: false };
  let pathSegs = 0;
  const ctx = {
    canvas: null, _ss: '', _fs: '', _lw: 1, _font: '',
    setTransform() { rec.transforms.push('setTransform'); },
    translate(x, y) { rec.transforms.push(`translate(${x},${y})`); },
    scale(x, y) { rec.transforms.push(`scale(${x},${y})`); },
    clearRect() { rec.transforms.push('clearRect'); },
    save() {}, restore() {}, clip() {}, rotate() {}, setLineDash() {},
    beginPath() { pathSegs = 0; },
    moveTo() {
      pathSegs++; rec.moveToCount++;
      if (rec.moveToCount > RUNAWAY) { rec.runaway = true; throw new Error('runaway MoveTo'); }
    },
    lineTo() {}, arc() {}, arcTo() {}, closePath() {}, quadraticCurveTo() {},
    bezierCurveTo() {}, rect() {}, ellipse() {}, roundRect() {},
    stroke() { rec.strokes.push({ style: this._ss, segs: pathSegs }); },
    fill() { rec.fills++; }, fillRect() { rec.fills++; },
    fillText(t, x, y) { rec.texts.push({ text: String(t), x, y, font: this._font }); },
    measureText() { return { width: 0 }; },
    createLinearGradient() { return { addColorStop() {} }; },
    get strokeStyle() { return this._ss; }, set strokeStyle(v) { this._ss = v; },
    get fillStyle() { return this._fs; }, set fillStyle(v) { this._fs = v; },
    get lineWidth() { return this._lw; }, set lineWidth(v) { this._lw = v; },
    get font() { return this._font; }, set font(v) { this._font = v; },
  };
  return { ctx, rec };
}

function mkCanvas(w = 800, h = 600) {
  const { ctx, rec } = mkPaintTrace();
  const cv = {
    width: 0, height: 0, style: {}, _listeners: {},
    getContext: () => ctx,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: w, height: h }),
    addEventListener(t, fn) { (cv._listeners[t] ||= []).push(fn); },
    removeEventListener() {}, hasPointerCapture: () => false,
    releasePointerCapture() {}, setPointerCapture() {}, focus() {},
  };
  ctx.canvas = cv;
  return { cv, rec };
}

/** 循环步数（照 `drawGrid` 的可见区规则独立复算；step 必须 > 0） */
function countSteps(lo, hi, step) { let n = 0; for (let x = lo; x <= hi; x += step) n++; return n; }

/** 去注释（够用即可：只认 // 与块注释，不求完美词法） */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ').replace(/([^:'"`])\/\/.*$/gm, '$1');
}
/**
 * 取**方法定义**的方法体（花括号配平）。
 * ⚠ 不能用 `indexOf(name + '(')`：那会撞上**调用点**（`this.coordText(...)`），
 *   结果 C3 检查的是别人的函数体 ⇒ 变异体恒绿。必须锚「行首缩进 + 名字 + 参数表 + {」。
 */
function methodDef(src, name) {
  const re = new RegExp('(?:^|\\n)[ \\t]{0,4}' + name + '[ \\t]*\\([^)]*\\)[ \\t]*\\{');
  const m = re.exec(src);
  if (!m) return '';
  const open = src.indexOf('{', m.index);
  let d = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') d++;
    else if (src[i] === '}') { d--; if (d === 0) return src.slice(open + 1, i); }
  }
  return '';
}

// ══════════════════════════════════════════════════════════
// 导入被测（模块求值期崩溃也要打 JSON）
// ══════════════════════════════════════════════════════════
let Engine = null, C = null, World = null, GRID_KEY = 'xiaomo.grid.v1';
try {
  const engMod = await import(asURL('src/core/engine.js'));
  Engine = engMod.Engine;
  GRID_KEY = engMod.GRID_KEY || GRID_KEY;
  C = (await import(asURL('src/core/theme.js'))).C;
  World = (await import(asURL('src/core/world.js'))).World;
} catch (e) {
  emitCrash('import', e);
  process.exit(1);
}

function mkEngine(opts = {}) {
  const w = opts.w || 800, h = opts.h || 600;
  const { cv, rec } = mkCanvas(w, h);
  const eng = new Engine(cv, new World());
  eng.w = w; eng.h = h;      // 与 Engine.resize() 落下的两个字段同义（探针不启 DOM 尺寸）
  return { eng, rec, cv };
}
const reset = (rec) => {
  rec.strokes.length = 0; rec.texts.length = 0; rec.transforms.length = 0;
  rec.fills = 0; rec.moveToCount = 0; rec.runaway = false;
};

// ══════════════════════════════════════════════════════════
// 读数（--smoke）
// ══════════════════════════════════════════════════════════
if (MODE_SMOKE) {
  const S = mkEngine();
  console.log('[smoke] gridSize=' + S.eng.gridSize + ' showGrid=' + S.eng.showGrid +
    ' C.grid=' + JSON.stringify(C.grid) + ' C.gridStrong=' + JSON.stringify(C.gridStrong));
  S.eng.render();
  console.log('[smoke] ON  strokes=' + JSON.stringify(S.rec.strokes) +
    ' texts=' + S.rec.texts.length + ' fills=' + S.rec.fills + ' tf=' + JSON.stringify(S.rec.transforms));
  reset(S.rec); S.eng.setShowGrid(false); S.eng.render();
  console.log('[smoke] OFF strokes=' + JSON.stringify(S.rec.strokes) + ' texts=' + S.rec.texts.length +
    ' fills=' + S.rec.fills + ' tf=' + JSON.stringify(S.rec.transforms));
  reset(S.rec); S.eng.setShowGrid(true); S.eng.pan = { x: 40, y: -25 }; S.eng.zoom = 2;
  S.eng.setPointerScreen(100, 100); S.eng.render();
  console.log('[smoke] ON@pan(40,-25)zoom2 texts=' + JSON.stringify(S.rec.texts) +
    ' 手算=(' + (100 - 40) / 2 + ',' + (100 + 25) / 2 + ') screenToWorld=' + JSON.stringify(S.eng.screenToWorld(100, 100)));
  process.exit(0);
}

// ══════════════════════════════════════════════════════════
// 断言
// ══════════════════════════════════════════════════════════
if (!MODE_MUT) {
  // ── §A 默认态 + 开态指令流 ──
  await group(['A1', 'A2', 'A3', 'A4'], () => {
    const A = mkEngine();
    ok('A1', A.eng.showGrid === true, `默认态 showGrid 为 true（裁定：不改用户看到的画布；实测 ${A.eng.showGrid}）`);
    A.eng.render();
    const s = A.eng.gridSize;
    const expFine = countSteps(0, A.eng.w + s, s) + countSteps(0, A.eng.h + s, s);
    const expStrong = countSteps(0, A.eng.w + s, s * 5) + countSteps(0, A.eng.h + s, s * 5);
    const st0 = A.rec.strokes[0] || {}, st1 = A.rec.strokes[1] || {};
    ok('A2', A.rec.strokes.length >= 1 && st0.style === C.grid && st0.segs === expFine,
      `开态第一条 stroke = C.grid 且线段数 === 用 gridSize 自身算出的期望（实测 style=${JSON.stringify(st0.style)} segs=${st0.segs}；期望 ${JSON.stringify(C.grid)} / ${expFine}）`);
    ok('A3', st1.style === C.gridStrong && st1.segs === expStrong,
      `开态第二条 stroke = C.gridStrong 且线段数 === 期望（实测 style=${JSON.stringify(st1.style)} segs=${st1.segs}；期望 ${JSON.stringify(C.gridStrong)} / ${expStrong}）`);
    ok('A4', A.rec.strokes.length === 2, `开态绘制段恰好两条 stroke，不多不少（实测 ${A.rec.strokes.length}）`);
  });

  // ── §B 关态：一条网格指令都不发 ──
  await group(['B1', 'B2', 'B3'], () => {
    const B = mkEngine();
    const onStrokes = (B.eng.render(), B.rec.strokes.length), onFills = B.rec.fills, onTf = B.rec.transforms.length;
    reset(B.rec);
    B.eng.setShowGrid(false);
    B.eng.setPointerScreen(100, 100);          // 有指针也不该画读数
    B.eng.render();
    ok('B1', onStrokes > 0 && B.rec.strokes.length === 0,
      `关态网格 stroke 数 === 0（先证开态有 ${onStrokes} 条 ⇒ 不是空集恒真；实测关态 ${B.rec.strokes.length}）`);
    ok('B2', B.rec.texts.length === 0, `关态坐标读数也一条不画（实测 fillText ${B.rec.texts.length} 条）`);
    ok('B3', B.rec.fills === onFills && B.rec.transforms.length === onTf,
      `开/关两态的差异**恰好**是网格指令：非网格绘制与变换一条不差（fills ${onFills}→${B.rec.fills}、变换 ${onTf}→${B.rec.transforms.length}）`);
  });

  // ── §C 坐标读数：唯一出口 + 手算对照 ──
  await group(['C1', 'C2', 'C3', 'C4'], () => {
    const Cd = mkEngine();
    Cd.eng.pan = { x: 40, y: -25 }; Cd.eng.zoom = 2;
    Cd.eng.setPointerScreen(100, 100);
    const rawS2W = Cd.eng.screenToWorld.bind(Cd.eng);
    let s2wCalls = 0;
    Cd.eng.screenToWorld = (x, y) => { s2wCalls++; return rawS2W(x, y); };
    Cd.eng.render();
    const handX = (100 - 40) / 2, handY = (100 - (-25)) / 2;   // 手算（独立于实现与 screenToWorld）
    const handText = `(${Math.round(handX)}, ${Math.round(handY)})`;
    const gotText = Cd.rec.texts[0] ? Cd.rec.texts[0].text : '无';
    ok('C1', Cd.rec.texts.length === 1 && gotText === handText,
      `坐标读数 === 手算值（pan=(40,-25) zoom=2 指针(100,100) ⇒ 世界 ${handX},${handY} ⇒ 文本 ${handText}；实测 ${gotText}）`);
    ok('C2', s2wCalls === 2,
      `渲染一帧的换算次数**恰好 2**（左下角点 + 读数各一次，都走 screenToWorld；实测 ${s2wCalls} 次）⇒ 谁少走一次出口就红`);
    const engSrc = stripComments(readFileSync(join(SRC_ROOT, 'src/core/engine.js'), 'utf8'));
    const coordBody = methodDef(engSrc, 'coordText');
    const bypass = /this\.pan|\bpan\.(x|y)|this\.zoom/.test(coordBody);
    ok('C3', coordBody.length > 0 && !bypass,
      `结构：coordText **定义体**里没有第二条 pan/zoom 式子（去注释后匹配到旁路 = ${bypass}；⚠ drawCoords 的字号 ÷zoom 是排字不是换算，故只查 coordText）`);
    const Cnp = mkEngine();
    let npThrew = null;
    try { Cnp.eng.render(); } catch (e) { npThrew = e.message; }
    ok('C4', npThrew === null && Cnp.rec.texts.length === 0 && Cnp.rec.strokes.length === 2,
      `还没收到指针时：不画读数、网格照画、不抛（实测 texts=${Cnp.rec.texts.length} strokes=${Cnp.rec.strokes.length} 抛=${npThrew}）`);
  });

  // ── §D 开关语义 ──
  await group(['D1', 'D2', 'D3', 'D4'], () => {
    const D = mkEngine();
    D.eng._needsRender = false;
    const r1 = D.eng.setShowGrid(false);
    ok('D1', D.eng._needsRender === true && r1 === false,
      `切换**置脏**且返回新值（实测 _needsRender=${D.eng._needsRender} 返回=${r1}）`);
    D.eng._needsRender = false;
    const r2 = D.eng.setShowGrid(false);
    ok('D2', D.eng._needsRender === false && r2 === false,
      `同值调用不惊动一帧（实测 _needsRender=${D.eng._needsRender} 返回=${r2}）`);
    const gsOff = D.eng.gridSize;              // ⚠ 关态也要读：把关闭实现成 gridSize=0 的写法只有这里能杀
    D.eng.setShowGrid(true);
    const gsOn = D.eng.gridSize;
    ok('D3', gsOff === 24 && gsOn === 24,
      `常量真源 gridSize 恒为 24、开关两态都不许动它（关态 ${gsOff} / 开态 ${gsOn}）`);
    const store = new Map();
    globalThis.localStorage = {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => { store.set(k, String(v)); },
      removeItem: (k) => { store.delete(k); },
    };
    const P = mkEngine();
    P.eng.setShowGrid(false);
    const fresh = mkEngine();
    ok('D4', store.get(GRID_KEY) === '0' && fresh.eng.showGrid === false,
      `持久化读—写闭环（键 ${GRID_KEY}）：关一次写 '0'（实测 ${JSON.stringify(store.get(GRID_KEY))}），新建 Engine 读到 false（实测 ${fresh.eng.showGrid}）`);
    delete globalThis.localStorage;
  });

  // ── §E 恒等视口：开关与 pan-probe §② 判据无关（进程内抄一遍那条判据）──
  await group(['E1'], () => {
    const Eon = mkEngine(); Eon.eng.render();
    const Eoff = mkEngine(); Eoff.eng.setShowGrid(false); Eoff.eng.render();
    const tfOn = JSON.stringify(Eon.rec.transforms), tfOff = JSON.stringify(Eoff.rec.transforms);
    ok('E1', tfOn === tfOff && tfOn.includes('setTransform') && tfOn.includes('clearRect'),
      `恒等视口下开/关两态的**变换指令流逐位相同**（= pan-probe §② 守的那串；实测 ${tfOn} vs ${tfOff}）`);
  });

  // ── §F 边界 ──
  await group(['F1', 'F2', 'F3', 'F4'], () => {
    const F0 = mkEngine(); F0.eng.gridSize = 0;
    let f0Threw = null;
    try { F0.eng.render(); } catch (e) { f0Threw = e.message; }
    ok('F1', f0Threw === null && !F0.rec.runaway && F0.rec.strokes.length === 0,
      `gridSize = 0 时**在有限步内返回**（替身 moveTo 上限 ${RUNAWAY}；实测 抛=${f0Threw} 失控=${F0.rec.runaway} stroke=${F0.rec.strokes.length}）`);
    const f2 = [];
    for (const v of [-1, NaN, Infinity]) {
      const Fx = mkEngine(); Fx.eng.gridSize = v;
      try { Fx.eng.render(); f2.push(String(v) + '=ok'); } catch (e) { f2.push(String(v) + '=抛:' + e.message); }
    }
    ok('F2', f2.every((t) => t.endsWith('=ok')), `极端 gridSize（-1 / NaN / Infinity）不抛、不死循环（实测 ${f2.join(' ')}）`);
    const Fz = mkEngine(); Fz.eng.pan = { x: 10, y: 20 };
    const zbad = [];
    for (const z of [4, 0.25]) {
      Fz.eng.zoom = z; Fz.eng.setPointerScreen(200, 150); reset(Fz.rec);
      try { Fz.eng.render(); } catch (e) { zbad.push(`zoom=${z} 抛 ${e.message}`); continue; }
      const exp = `(${Math.round((200 - 10) / z)}, ${Math.round((150 - 20) / z)})`;
      const got = Fz.rec.texts[0] ? Fz.rec.texts[0].text : '无';
      if (got !== exp) zbad.push(`zoom=${z} 得 ${got} 期望 ${exp}`);
    }
    ok('F3', zbad.length === 0, `极端 zoom（4 / 0.25）下读数仍随 zoom 正确换算（实测 ${zbad.length ? zbad.join('；') : '两档都与手算一致'}）`);
    const Fp = mkEngine();
    Fp.eng.setPointerScreen(50, 60);
    Fp.eng._needsRender = false;
    Fp.eng.setPointerScreen(NaN, 5); Fp.eng.setPointerScreen('x', 5); Fp.eng.setPointerScreen(Infinity, 1);
    ok('F4', Fp.eng.pointerScreen.x === 50 && Fp.eng.pointerScreen.y === 60 && Fp.eng._needsRender === false,
      `非法指针值被忽略：不崩、不改读数、不置脏（实测 pointerScreen=${JSON.stringify(Fp.eng.pointerScreen)} _needsRender=${Fp.eng._needsRender}）`);
  });

  // ── §G DOM 开关 + 结构（插件数）──
  await group(['G1', 'G2', 'G3', 'G4'], async () => {
    const fakeEl = (tag) => {
      const el = {
        tag, style: {}, dataset: {}, attrs: {}, classes: new Set(), children: [], ev: {},
        textContent: '', title: '', type: '',
        setAttribute(k, v) { el.attrs[k] = String(v); },
        getAttribute(k) { return el.attrs[k]; },
        addEventListener(t, fn) { el.ev[t] = fn; },
        appendChild(c) { el.children.push(c); return c; },
      };
      el.classList = {
        toggle(c, on) {
          if (on === undefined) { if (el.classes.has(c)) el.classes.delete(c); else el.classes.add(c); }
          else if (on) el.classes.add(c); else el.classes.delete(c);
        },
      };
      return el;
    };
    const container = fakeEl('div');
    globalThis.document = { createElement: (t) => fakeEl(t) };
    let mountGridToggle = null;
    try { mountGridToggle = (await import(asURL('src/ui/grid-toggle.js'))).mountGridToggle; } catch (e) { mountGridToggle = null; }
    const Gd = mkEngine();
    const btn = mountGridToggle ? mountGridToggle(container, Gd.eng) : null;
    ok('G1', !!btn && container.children.length === 1 && btn.attrs['aria-pressed'] === 'true',
      `挂载：返回按钮、进了容器、初始 aria-pressed='true'（实测 btn=${!!btn} children=${container.children.length} pressed=${btn && btn.attrs['aria-pressed']}）`);
    if (btn && btn.ev.click) btn.ev.click();
    ok('G2', Gd.eng.showGrid === false && btn && btn.attrs['aria-pressed'] === 'false',
      `点一次真的关掉，且按键态从真源重读（实测 showGrid=${Gd.eng.showGrid} pressed=${btn && btn.attrs['aria-pressed']}）`);
    delete globalThis.document;
    let g3 = 'throw';
    try { g3 = mountGridToggle ? mountGridToggle(container, Gd.eng) : null; } catch (e) { g3 = 'throw:' + e.message; }
    ok('G3', g3 === null, `无 DOM 环境（document 未定义）⇒ 返回 null、不抛（实测 ${g3}）`);
    const regSrc = readFileSync(join(SRC_ROOT, 'src/plugins/index.js'), 'utf8');
    const leak = regSrc.includes('grid-toggle');
    let pluginCount = 'no-export';
    try {
      const pm = await import(asURL('src/plugins/index.js'));
      const list = pm.ALL_PLUGINS || pm.plugins || pm.default;
      pluginCount = Array.isArray(list) ? list.length : 'no-export:' + Object.keys(pm).join(',');
    } catch (e) { pluginCount = 'import失败:' + e.message; }
    ok('G4', !leak && pluginCount === 32,
      `结构：grid-toggle 未进 ALL_PLUGINS 且 UI 插件数仍是 32（实测 注册表提及=${leak} 计数=${pluginCount}）`);
  });

  for (const i of items) console.log(`${i.ok ? '  \x1b[32m✓\x1b[0m' : '  \x1b[31m✗\x1b[0m'} [${i.id}] ${i.msg}`);
  const failedN = emit();
  console.log(`\n合计 ${items.length} 项，失败 ${failedN} 项`);
  process.exit(failedN ? 1 : 0);
}

// ══════════════════════════════════════════════════════════
// 红档：变异体自证（父进程）
// ══════════════════════════════════════════════════════════
const ENG = 'src/core/engine.js', GT = 'src/ui/grid-toggle.js';

/**
 * 每个变异体：`edits` 逐条 {file, from, to}；`expected` = **声明**它会翻红的断言 id。
 * ⚠ 锚点纪律：只含代码行（含注释 ⇒ 去注释后命中 0 ⇒ 判为没落进代码）、且唯一。
 * ⚠ `from` 不许与自己的描述文本逐字相同（`why` 写人话，`from` 是代码原文）。
 */
const MUTANTS = [
  {
    id: 'M0-canary-阳性对照', expected: ['A2'],
    why: '阳性对照：把细网格描边色换成粗网格色 ⇒ 这条都不红就说明变异体根本没送进子进程',
    edits: [{ file: ENG, from: '    g.strokeStyle = C.grid;', to: '    g.strokeStyle = C.gridStrong;' }],
  },
  {
    id: 'M1-删掉关态守卫', expected: ['B1'],
    why: '删掉 drawGrid 入口的开关判断 ⇒ 关态仍会画网格',
    edits: [{ file: ENG, from: '  drawGrid(g) {\n    if (!this.showGrid) return;', to: '  drawGrid(g) {' }],
  },
  {
    id: 'M2-守卫挪到两条-stroke-中间', expected: ['B1'],
    why: '把守卫从入口挪到两条 stroke 之间（数值路径盲区：主线画了、每 5 格那条跳过）',
    edits: [
      { file: ENG, from: '  drawGrid(g) {\n    if (!this.showGrid) return;', to: '  drawGrid(g) {' },
      { file: ENG, from: '    g.strokeStyle = C.gridStrong;', to: '    if (!this.showGrid) return;\n    g.strokeStyle = C.gridStrong;' },
    ],
  },
  {
    id: 'M3-开关实现成把-gridSize-置-0', expected: ['D3'],
    why: '用 gridSize = 0 表达「关」：网格确实会消失、只看「有没有 stroke」的判据全绿，只有「常量真源两态都不动」这条结构判据能杀',
    edits: [{ file: ENG, from: '    writeGridPref(v);', to: '    this.gridSize = v ? 24 : 0;\n    writeGridPref(v);' }],
  },
  {
    id: 'M4-切换不置脏', expected: ['D1'],
    why: '切换开关不 markDirty ⇒ 状态变了、画面不变',
    edits: [{ file: ENG, from: '    writeGridPref(v);\n    this.markDirty();', to: '    writeGridPref(v);' }],
  },
  {
    id: 'M5-坐标换算开旁路', expected: ['C2', 'C3'],
    why: 'coordText 自己写 pan/zoom 式子（与 screenToWorld 数值逐位相同 ⇒ 只有「次数 + 结构」能杀）',
    edits: [{ file: ENG, from: '  coordText(sx, sy) {\n    const w = this.screenToWorld(sx, sy);', to: '  coordText(sx, sy) {\n    const w = { x: (sx - this.pan.x) / this.zoom, y: (sy - this.pan.y) / this.zoom };' }],
  },
  {
    id: 'M6-读数无视总开关', expected: ['B2'],
    why: 'drawCoords 不看 showGrid ⇒ 关掉网格但坐标读数还在',
    edits: [{ file: ENG, from: '    if (!this.showGrid || !this.pointerScreen) return;', to: '    if (!this.pointerScreen) return;' }],
  },
  {
    id: 'M7-删掉格距守卫', expected: ['F1', 'F2'],
    why: '删掉「步长必须有限且为正」的守卫 ⇒ 0 / -1 步进失控、Infinity 令循环条件恒真，三种都是死循环（页面卡死）',
    edits: [{ file: ENG, from: '    if (!Number.isFinite(s) || !(s > 0)) return;', to: '' }],
  },
  {
    id: 'M8-网格里多发一条变换', expected: ['B3', 'E1'],
    why: '在网格绘制里多发一条 translate ⇒ 开/关两态变换指令流不再相同（正是 pan-probe §② 守的东西）',
    edits: [{ file: ENG, from: '    g.lineWidth = 1;\n    g.strokeStyle = C.grid;', to: '    g.translate(0, 0);\n    g.lineWidth = 1;\n    g.strokeStyle = C.grid;' }],
  },
  {
    id: 'M9-按钮点了不调用引擎', expected: ['G2'],
    why: 'DOM 按钮点了不驱动引擎，只刷新自己的外观',
    edits: [{ file: GT, from: '    engine.setShowGrid(!engine.showGrid);', to: '    void 0;' }],
  },
  {
    id: 'M10-同值也置脏', expected: ['D2'],
    why: '去掉「没变就返回」⇒ 同值调用也惊动一帧',
    edits: [{ file: ENG, from: '    if (v === this.showGrid) return this.showGrid;', to: '' }],
  },
  {
    id: 'M11-读数不取整', expected: ['C1', 'F3'],
    why: '读数直接印小数 ⇒ 文本与手算的取整值不符',
    edits: [{ file: ENG, from: '    return `(${Math.round(w.x)}, ${Math.round(w.y)})`;', to: '    return `(${w.x}, ${w.y})`;' }],
  },
  {
    id: 'M12-不落持久化', expected: ['D4'],
    why: '切换不写存储 ⇒ 读—写闭环断在写这一半',
    edits: [{ file: ENG, from: '    writeGridPref(v);', to: '' }],
  },
  {
    id: 'M13-默认值翻成关', expected: ['A1', 'A2', 'A3', 'A4', 'B1', 'C1', 'C2', 'C4', 'D1', 'D4', 'F3', 'G1', 'G2'],
    why: '把默认值翻成 false（不改 readGridPref，只改构造处）⇒ 默认画布上没有网格，凡是以「默认开着」为前提的判据全红；这条也是「默认值是产品决策」的量化代价',
    edits: [{ file: ENG, from: '    this.showGrid = readGridPref();', to: '    this.showGrid = false;' }],
  },
  {
    id: 'M14-网格里多发一条-stroke', expected: ['A3', 'A4', 'C4'],
    why: '细网格后多补一次 stroke（同一 path 再描一遍）⇒ 开态 stroke 条数与第 2 条的身份都错',
    edits: [{ file: ENG, from: '    for (let y = y0; y <= y1; y += s) { g.moveTo(x0, y + .5); g.lineTo(x1, y + .5); }\n    g.stroke();', to: '    for (let y = y0; y <= y1; y += s) { g.moveTo(x0, y + .5); g.lineTo(x1, y + .5); }\n    g.stroke();\n    g.stroke();' }],
  },
  {
    id: 'M15-读数不判指针为空', expected: ['A1', 'A2', 'A3', 'A4', 'B1', 'B2', 'B3', 'C4', 'E1', 'F1', 'F2'],
    why: 'drawCoords 只判总开关、不判指针存在 ⇒ 没指针时读 null.x 抛错；凡是「无指针渲一帧」的判据全红，且组内一处抛错 ⇒ 整组记红（含崩溃前已通过的 A1 —— group() 刻意的从严语义）',
    edits: [{ file: ENG, from: '    if (!this.showGrid || !this.pointerScreen) return;', to: '    if (!this.showGrid) return;' }],
  },
  {
    id: 'M16-非法指针照收', expected: ['F4'],
    why: '删掉有限性判断 ⇒ NaN / Infinity 也会被收进读数',
    edits: [{ file: ENG, from: '    if (!Number.isFinite(px) || !Number.isFinite(py)) return;', to: '' }],
  },
  {
    id: 'M18-无-document-也硬做', expected: ['G3'],
    why: '去掉 document 存在性判断 ⇒ 无 DOM 环境直接抛',
    edits: [{ file: GT, from: "  if (!container || !engine || typeof document === 'undefined') return null;", to: '  if (!container || !engine) return null;' }],
  },
  {
    id: 'M19-按钮不入容器', expected: ['G1'],
    why: '按钮不 appendChild ⇒ 生成了却挂不上去',
    edits: [{ file: GT, from: '  container.appendChild(btn);', to: '' }],
  },
  {
    id: 'M20-null-等价改写', expected: [],
    why: 'null 变异体（照妖镜）：`!!on` 换成 `Boolean(on)` 语义完全相同 ⇒ **必须一条都不红**。若「子进程崩死 / 没打 JSON」被读成 0 红，这条会**因为错误的原因变绿** ⇒ 它专门照这一条。⚠ 缺 JSON 落成 `childNoJSON`（非空哨兵）而不是 `[]`，所以等价对照照样能被戳穿',
    edits: [{ file: ENG, from: '    const v = !!on;', to: '    const v = Boolean(on);' }],
  },
];

const stage = join(tmpdir(), 'e-anchor-t28-mut');
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
cpSync(join(ROOT, 'src'), join(stage, 'src'), { recursive: true });
const pristine = new Map();                 // 每个变异体前恢复原件，避免互相叠加
for (const f of [ENG, GT]) pristine.set(f, readFileSync(join(ROOT, f), 'utf8'));

function runChild() {
  let out = '';
  try {
    out = execFileSync(process.execPath, [join(ROOT, 'tools/grid-probe.mjs'), '--run'],
      { env: Object.assign({}, process.env, { GRID_MUT_DIR: stage }), encoding: 'utf8', timeout: 180000 });
  } catch (e) { out = String(e.stdout || '') + String(e.stderr || ''); }   // ⚠ 不看退出码
  const line = out.split(/\r?\n/).find((l) => l.includes('GRID_JSON '));
  if (!line) return { json: null, tail: out.slice(-300) };
  try { return { json: JSON.parse(line.slice(line.indexOf('GRID_JSON ') + 10)) }; }
  catch (e) { return { json: null, tail: line.slice(0, 300) }; }
}
const countIn = (text, needle) => (needle ? text.split(needle).length - 1 : 0);

const base = runChild();                     // 基线：什么都不改
const baselineRed = base.json ? base.json.failed : ['childNoJSON'];
let pass = 0, fail = 0;
const failed = [];
const okM = (cond, msg) => {
  if (cond) { pass++; console.log('  \x1b[32m✓\x1b[0m ' + msg); }
  else { fail++; failed.push(msg); console.log('  \x1b[31m✗\x1b[0m ' + msg); }
};

// stub 自证：锚一个必然不存在的串 ⇒ 落点判定必须能失败（否则它就是恒真）
const stubFrom = 'THIS-ANCHOR-CANNOT-EXIST-IN-THIS-FILE';
const stubLanded = countIn(stripComments(pristine.get(ENG)), stubFrom) > 0;

let expectedRed = 0, observedRed = 0, ctrlBad = 0, landInCode = true;
const perMutant = [];
for (const m of MUTANTS) {
  // 1) 落点自证（实测推导，不写字面量）
  let landed = true, rawHit = 0, codeHit = 0;
  for (const ed of m.edits) {
    const text = pristine.get(ed.file);
    const raw = countIn(text, ed.from), code = countIn(stripComments(text), ed.from);
    rawHit += raw; codeHit += code;
    if (raw < 1 || code < 1) landed = false;
  }
  landInCode = landInCode && landed;
  // 2) 应用（先恢复原件）
  for (const f of [ENG, GT]) writeFileSync(join(stage, f), pristine.get(f));
  for (const ed of m.edits) {
    const p = join(stage, ed.file);
    writeFileSync(p, readFileSync(p, 'utf8').split(ed.from).join(ed.to));
  }
  // 3) 全新进程里跑
  const child = runChild();
  const observed = child.json ? child.json.failed : ['childNoJSON'];
  const declared = m.expected;
  const same = observed.length === declared.length && declared.every((id) => observed.includes(id));
  if (!same) ctrlBad++;
  expectedRed += declared.length; observedRed += observed.length;
  perMutant.push({ id: m.id, why: m.why, declared, observed, aligned: same, landed, rawHit, codeHit, childTail: child.tail });
  okM(landed, `[${m.id}] 落点自证：锚在代码里命中 raw=${rawHit} / 去注释=${codeHit}（≥1 才算落进代码行）`);
  okM(same, `[${m.id}] 声明红 ≡ 实测红：声明 ${JSON.stringify(declared)} / 实测 ${JSON.stringify(observed)}`);
}
okM(stubLanded === false, `stub 自证：不存在的锚点必须**落空**（实测落空=${!stubLanded}）⇒ 落点判定不是恒真`);
okM(baselineRed.length === 0, `基线（不动任何文件）红集为空（实测 ${JSON.stringify(baselineRed)}）`);
for (const f of [ENG, GT]) writeFileSync(join(stage, f), pristine.get(f));
rmSync(stage, { recursive: true, force: true });

const redsAligned = ctrlBad === 0;
const okAll = redsAligned && landInCode && !stubLanded && baselineRed.length === 0 && failed.length === 0;
console.log('GRID_JSON ' + JSON.stringify({
  probe: 'grid', mutate: true, mutants: MUTANTS.length,
  expectedRed, observedRed, ctrlBad, stubLanded, landInCode, redsAligned,
  baselineRed, perMutant, ok: okAll,
}));
process.exit(okAll ? 0 : 1);
