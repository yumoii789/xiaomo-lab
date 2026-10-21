// ══════════════════════════════════════════════════════════
// 画布功能栏整合（task-27）的判据
//   被测：新增 `src/ui/canvasbar.js` + `src/plugins/ui.toolbar.js`（搬家）+ `styles/*`（加规则）
//
// 裸跑      → 判据（绿档）；退出码既不是成功的判据，也不是失败的判据，看末尾那行 JSON。
// --mutate  → 变异体自证：每个变异体必须 ①真的落进代码（landInCode 由实测推导）
//             ②红的是点名的那几条（expectedRed ⊆ observedRed）
//             ③其余断言一条都不许红（ctrlBad 空）。
// --root=<dir>         指定仓库根（默认本文件上一级）
// --judge-json=<file>  内部用：把判定写进文件（给 --mutate 的子进程读，不依赖 stdio 管道）
//
// ── 真与替身边界（这段决定结论的适用范围，必须诚实）──
// 真：① 全部**文本结构断言**读的是磁盘真源码（`readNorm` 先归一换行）。
//     ② 落点/插槽名/元素 id 全部来自实读，不来自转述。
// 替身：本探针**不起 DOM 浏览器**（本任务禁止起窗口）⇒ 凡是需要真 DOM 的行为，
//     一律走三条替代路径之一，并且**在断言 id 里标明是哪一条**：
//       · `doc.*`  = 用探针里的最小 DOM 替身（`miniDoc()`/`miniEl()`）跑真模块，测「挂载/重建/点击」逻辑
//       · `src.*`  = 读磁盘源码做结构断言（唯一能杀「复制一整套入口」的那类）
//       · `drift.*`= 替身与真源的漂移守卫（真源一改就红，逼人回来同步）
//     真机/浏览器才能验的另列清单，见回报。
//
// ── 纪律 ──
// · 任何「拿磁盘字节匹配源码文本」的地方**先归一换行**（本仓 core.autocrlf=true，
//   .gitattributes 只钉 market/*，全新 Windows 检出里 src/ 与 tools/ 都是 CRLF）。
// · 结构断言**先剥注释**：注释里写个 `.zoom` 就能把裸子串判据打成永久假红。
// · 注释只写符号名，不写行号（行号会被人加三行注释就冲掉）。
// · 变异体**原地改写 + 无条件还原**（不写 %TEMP%），因此不存在「临时副本里相对 import
//   要改写成 file:///」的问题 —— 这是刻意选的，少一类自己制造的假红。
// ══════════════════════════════════════════════════════════
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const SELF = fileURLToPath(import.meta.url);
const args = process.argv.slice(2);
const argOf = (k, d) => {
  const hit = args.find((a) => a.startsWith('--' + k + '='));
  return hit ? hit.slice(k.length + 3) : d;
};
const ROOT = path.resolve(argOf('root', path.join(path.dirname(SELF), '..')));
const U = (p) => path.join(ROOT, p);
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
/** 归一到 LF：磁盘字节 vs 源码文本的一切比对都必须先过这里 */
const norm = (s) => s.replace(/\r\n/g, '\n');
const readNorm = (p) => norm(readFileSync(p, 'utf8'));
/** 剥注释：结构断言只许测**代码**，不许被注释里的同名字符串打成假红 */
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

/**
 * 从源码文本里切出一个方法的**方法体**：`header` 必须含方法名与那个 `{`，
 * 之后按花括号配平取到匹配的 `}`。用来把 `main.js` 里的**真算法**取出来直接跑 ——
 * 不抄一份，所以「探针里的算法」与「磁盘上的算法」不可能漂移（抄一份就会漂）。 */
const braceBody = (src, header) => {
  const i = src.indexOf(header);
  if (i < 0) return null;
  let d = 0;
  for (let j = i + header.length - 1; j < src.length; j++) {
    if (src[j] === '{') d++;
    else if (src[j] === '}') { d--; if (d === 0) return src.slice(i + header.length, j); }
  }
  return null;
};

/**
 * 极简 DOM 元素替身：只实现 `mountSlot` 与插槽渲染回调用到的那几件事。
 * `innerHTML` 的 setter **清空 children** —— 这正是本项要测的那把刀（渲染回调写 `host.innerHTML=`
 * 会连外来节点一起抹掉），替身必须如实模拟；不然测出来的是替身的脾气，不是 DOM 的。
 */
function miniEl(tag = 'div') {
  const cls = new Set();
  return {
    tagName: String(tag).toUpperCase(), children: [], parentNode: null,
    id: '', dataset: {}, __ls: [], attrs: {},
    get className() { return [...cls].join(' '); },
    set className(v) { cls.clear(); String(v).split(/\s+/).filter(Boolean).forEach((c) => cls.add(c)); },
    classList: {
      add: (c) => cls.add(c), remove: (c) => cls.delete(c), contains: (c) => cls.has(c),
      toggle(c, on) { const want = on === undefined ? !cls.has(c) : !!on; if (want) cls.add(c); else cls.delete(c); return want; },
    },
    style: { setProperty() {}, removeProperty() {} },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
    removeAttribute(k) { delete this.attrs[k]; },
    // 监听器**连函数一起**记下来：只记类型就只能证明「注册过」，没法把点击真的驱动一遍 ✗
    addEventListener(t, fn) { this.__ls.push({ type: t, fn }); },
    // 画布中心要用到它（`_centre()` 走 getBoundingClientRect）
    getBoundingClientRect() { return { left: 0, top: 0, width: 800, height: 600 }; },
    appendChild(n) { if (n.parentNode) n.parentNode.removeChild(n); n.parentNode = this; this.children.push(n); return n; },
    prepend(n) { if (n.parentNode) n.parentNode.removeChild(n); n.parentNode = this; this.children.unshift(n); return n; },
    insertBefore(n, a) {
      if (n.parentNode) n.parentNode.removeChild(n);
      const k = a ? this.children.indexOf(a) : -1;
      if (k < 0) this.children.push(n); else this.children.splice(k, 0, n);
      n.parentNode = this; return n;
    },
    removeChild(n) { const k = this.children.indexOf(n); if (k >= 0) this.children.splice(k, 1); n.parentNode = null; return n; },
    contains(n) { let p = n; while (p) { if (p === this) return true; p = p.parentNode; } return false; },
    get nextSibling() {
      if (!this.parentNode) return null;
      const k = this.parentNode.children.indexOf(this);
      return this.parentNode.children[k + 1] || null;
    },
    get innerHTML() { return ''; },
    set innerHTML(_v) { for (const c of this.children) c.parentNode = null; this.children.length = 0; },
  };
}

/** 极简 document 替身：只够 `CanvasBar.mount()` 与外来开关走一遍（不是 DOM 实现）。 */
function miniDoc() {
  const stage = miniEl('div');
  return {
    __stage: stage,
    head: miniEl('head'), documentElement: miniEl('html'), body: miniEl('body'),
    createElement: (t) => miniEl(t),
    querySelector: (s) => (s === '#stage' ? stage : null),
    querySelectorAll: () => [],
  };
}

// ── 被测文件的唯一真源（探针不重写这些路径）──
const T = {
  bar: 'src/ui/canvasbar.js',              // 新增：功能栏容器与按钮
  toolbar: 'src/plugins/ui.toolbar.js',    // 既有插件：顶栏三插槽的主人，也是功能栏的挂载点
  themeswitch: 'src/plugins/ui.themeswitch.js',
  touch: 'src/ui/touch.js',
};

/**
 * 收拢前「画布级 / 准画布级」入口清单 —— 判据①（功能守恒）的真源。
 * `at`   实读落点（`文件·符号`，不写行号）
 * `kind` `canvas` = 画布级（该收进功能栏）/ `scene` = 景象级 / `doc` = 文档级 / `view` = 纯外观
 * `disp` 去向：`move`（收进功能栏，原处移除）/ `keep`（保留原位）/ `remove`（删除，必须给 why）
 * 每一个都必须有去向；`pending` 是**故意会红**的占位，不许留在终稿里。
 */
const ENTRIES = [
  { n: 1, at: 'plugins/ui.toolbar.js·topbar.tools', kind: 'canvas', what: '工具选择 select/wire/pour/erase（4 个 .tool-btn）', disp: 'move', why: '画布级；规格⑥明写「不许出现第二套工具入口」⇒ 顶栏那组必须移除（搬家，不是复制）' },
  { n: 2, at: 'plugins/ui.toolbar.js·topbar.actions', kind: 'scene', what: '运行/复位/撤销/重做/存档/读档/截图（btnRun…btnPng）', disp: 'keep', why: '景象级 + 文档级（仿真运行 / 存档 / 导出），任务明写「景象级操作不要动」' },
  { n: 3, at: 'plugins/ui.toolbar.js·topbar.right', kind: 'scene', what: '预置实验 selPreset + 速度档 selSpeed', disp: 'keep', why: '景象级；档位真源在 engine.speeds，搬到画布上不增加可达性' },
  { n: 4, at: 'plugins/ui.themeswitch.js·stage.overlay', kind: 'view', what: '主题圆钮 + 主题圆点', disp: 'keep', why: '纯外观，且已在左上角浮层；功能栏走底部居中，位置本就不重叠。动它要连带改 touch.js 的长按识别器（它按 .fx-orb 找圆钮），收益小于风险' },
  { n: 5, at: 'ui/touch.js·顶栏补装', kind: 'canvas', what: '触控层往 topbar.tools 追加 btnPalette、往 topbar.right 前插 btnSidebar', disp: 'keep', why: '服务窄屏抽屉开合，不是画布操作；且它的补装逻辑正对着「插槽被重建」那条风险，动它风险最大' },
  { n: 6, at: 'ui/interact.js·手势独占', kind: 'canvas', what: '滚轮缩放 / 两指缩放 / 空白拖动平移 / 双击复位视口', disp: 'move', why: '手势**保留**，另在功能栏补等价按钮（放大 / 缩小 / 复位视角）—— 走同一个 engine.zoomAt / engine.resetView，脏标记增量与原路径逐位相同' },
  { n: 7, at: 'main.js·键位', kind: 'canvas', what: '快捷键 v/w/p/x 选工具、空格运行、Delete 删除、Esc 取消、Ctrl+Z/Y', disp: 'keep', why: '功能栏是**新增入口**；规格④明写不许把键盘路径顺手删掉 ⇒ 保留并钉成断言' },
  { n: 8, at: 'index.html·状态条', kind: 'scene', what: '状态显示 stTool/stCount/stCircuit/stCoupling + fps + hint + toast', disp: 'keep', why: 'index.html 只读；且状态显示不是操作' },
];

/** 功能栏自己的声明表长度就是「条数」的唯一真源（不许把 7 / 11 这类字面量写进断言）。
 *  刻意**不含**主题圆钮：条目 4 判为「保留原位」（理由见 ENTRIES），功能栏不重复提供它。 */
const BAR_BUTTONS = [
  { act: 'select', kind: 'tool' }, { act: 'wire', kind: 'tool' },
  { act: 'pour', kind: 'tool' }, { act: 'erase', kind: 'tool' },
  { act: 'zoomIn', kind: 'view' }, { act: 'zoomOut', kind: 'view' }, { act: 'zoomReset', kind: 'view' },
  // task-33：「撤销组装」的**可见入口**（原来只有一个够不着的 API）。第三类 kind —— 它不碰引擎。
  { act: 'undoAssemble', kind: 'undo' },
];

/**
 * 原 8 处**之外**的外来新增项：不属于接缝图那 8 条，但必须**显式记账** ——
 * 否则下一个人看到功能栏里多一个开关，会以为是我漏记的那一条（判据① 的口径是「不许悄悄出现 / 消失」）。
 * 它**不**进 `BAR_BUTTONS`：那个开关的真源在 task-28（`src/ui/grid-toggle.js`），并进来就成两个真源。
 */
const FOREIGN = [
  {
    src: 'e-anchor/task-28', at: 'src/ui/grid-toggle.js', kind: 'canvas', disp: 'add',
    what: '网格 / 坐标开关（由对方冻结的 mountGridToggle(container, engine) 挂进功能栏空位 data-xm-slot="grid"）',
    why: '本项只留位 + 调用，不自己实现（两个开关一份真源 = 迟早不一致）；入口未就绪时留空位，不放替身',
  },
];

/** 给 `import()` 用的路径：`U()` 给的是 Windows 盘符绝对路径（`E:\…`），
 *  `import()` 会把它当成 `e:` 协议 ⇒ `ERR_UNSUPPORTED_ESM_URL_SCHEME` ✗。必须是 `file:///`。 */
const modUrl = (rel) => new URL('file:///' + String(U(rel)).replace(/\\/g, '/')).href;

/**
 * ⚠ 每次带上一个递增查询串，**打破 module 缓存**。
 * 不然后面 `--mutate` 就地改写 `canvasbar.js` 再 `import()`，拿到的还是缓存里的旧实例
 * ⇒ 变异体**恒绿**（这类假绿只有打破缓存才看得见）。
 * `canvasbar.js` 模块求值期不碰 DOM，所以重复求值是安全的 —— 那条架构约束在这里第二次救了命。
 */
let IMPN = 0;
const MOD = (rel) => modUrl(rel) + '?t=' + (++IMPN);

const results = [];
/** 每条断言一条记录；detail 必须给**读数**，不给「通过了」 */
const ok = (id, pass, detail) => { results.push({ id, ok: !!pass, detail: String(detail) }); };

// ══════════════════════════════════════════════════════════
async function judge() {
  // ───────── ① 功能守恒：8 处入口逐个有去向 ─────────
  {
    const noDisp = ENTRIES.filter((e) => !e.disp || e.disp === 'pending').map((e) => e.n);
    const badRemove = ENTRIES.filter((e) => e.disp === 'remove' && !e.why).map((e) => e.n);
    ok('inv.eightEntriesAccounted', ENTRIES.length === 8 && noDisp.length === 0,
      '条数=' + ENTRIES.length + ' 未定去向=' + JSON.stringify(noDisp) + ' 删除缺理由=' + JSON.stringify(badRemove));
    const moves = ENTRIES.filter((e) => e.disp === 'move').map((e) => e.n);
    ok('inv.movesAreCanvasLevel', moves.every((n) => ENTRIES.find((e) => e.n === n).kind === 'canvas'),
      '收进功能栏的=' + JSON.stringify(moves) + '（只许 canvas 级）');
  }
  // ───────── ② 行为等价：收进的操作与原入口逐位相同 ─────────
  // 判据落在**调用序列**与**脏标记计数**上（不是目测外观）：工具走 `app.setTool`（与键盘 v/w/p/x
  // 同一出口，且**恰好一次** ⇒ 挡双派发）；视口走 `engine.zoomAt` / `engine.resetView`（与滚轮 /
  // 双击复位同一出口）。
  {
    const { CanvasBar, ZOOM_STEP, BAR_ACTS } = await import(MOD(T.bar));
    // 条数真源在**模块**那一侧（`canvasbar.js` 的 `BTNS`）；探针只留一份**记录**用来对账。
    // 两边不一致就红 —— 否则「加了枚按钮但断言仍数旧的」这类漂移永远看不见。
    ok('drift.probeTableMatchesModule', BAR_ACTS.join(',') === BAR_BUTTONS.map((b) => b.act).join(','),
      '模块 BTNS=' + BAR_ACTS.join(',') + ' | 探针记录=' + BAR_BUTTONS.map((b) => b.act).join(','));
    // 造一条栏 + 一个只记账的 app 替身。工具态的**真身**是 `app.interaction.tool` ——
    // `main.js` 的 `setTool(t)` 只是转手给 `interaction.setTool(t)`，后者写 `this.tool` + 状态栏；
    // 全仓**没有** `app.tool`（接缝图 §④ 探针策略里写的 `app.tool === 'wire'` 是错的）。
    const mkBar = (engine) => {
      const calls = [];
      const doc = miniDoc();
      const app = {
        interaction: { tool: 'select' },
        setTool(t) { calls.push(['setTool', t]); app.interaction.tool = t; },
        markDirty() { calls.push(['markDirty']); },
        addTick() { return () => {}; },
        engine,
      };
      const bar = new CanvasBar(app, { document: doc });
      bar.mount();
      // ⚠ 判定器**不许**因为「栏整条没挂出来」而崩：崩了就没有判定文件、没有 JSON，
      //   而**崩溃不是红**（金丝雀变异体第一版就是在这里把判定器带崩的）。给个空替身，
      //   断言照常读「一枚按钮都没有」⇒ 正常报红。
      if (!bar.root) bar.root = doc.createElement('div');
      const btn = (a) => bar.root.children.find((c) => c.dataset.action === a);
      // 点不存在的按钮 ⇒ 返回 false（照常报红），**不是**抛异常：崩溃不是红 ✓（金丝雀实测踩到过）
      const click = (a) => { const el = btn(a); const l = el && el.__ls.find((x) => x.type === 'click'); if (!l) return false; l.fn({}); return true; };
      return { app, doc, bar, calls, btn, click };
    };

    const e1 = {
      zoom: 2, zoomCalls: [], resetView: () => true,
      zoomAt(z, x, y) { e1.zoomCalls.push([z, x, y]); return true; },
    };
    const B = mkBar(e1);
    // ① 工具：点「连线」⇒ 恰好一次 setTool('wire')，且真身状态跟着变
    B.calls.length = 0; B.click('wire');
    const tc = B.calls.filter((c) => c[0] === 'setTool');
    ok('eq.toolClickSetsTool',
      tc.length === 1 && tc[0][1] === 'wire' && B.app.interaction.tool === 'wire',
      '点「连线」⇒ setTool 调用 ' + tc.length + ' 次（参数 ' + (tc[0] || [])[1] + '），interaction.tool='
      + B.app.interaction.tool + '（真身在 interaction.tool；1 次 ⇒ 没有双派发）');
    // ② 高亮跟着工具走，且**同时只有一个**工具高亮
    const on = B.bar.root.children
      .filter((c) => c.dataset.tool && String(c.className).includes('active')).map((c) => c.dataset.action);
    ok('eq.barSyncsActiveTool', on.join(',') === 'wire',
      '栏上高亮=[' + on.join(',') + ']（恰好一个；键盘 v/w/p/x 改了工具由节拍轮询映过来）');

    // ③ 视口：走同一个 zoomAt；**不额外置脏**（zoomAt 自己会置脏 ⇒ 多置一次就是行为不等价）
    B.calls.length = 0; e1.zoomCalls.length = 0; B.click('zoomIn');
    const zc = e1.zoomCalls;
    const wantX = B.doc.__stage.getBoundingClientRect().width / 2;
    const extraDirty = B.calls.filter((c) => c[0] === 'markDirty').length;
    ok('eq.zoomClickMarksDirty',
      zc.length === 1 && Math.abs(zc[0][0] - 2 * ZOOM_STEP) < 1e-9 && zc[0][1] === wantX && extraDirty === 0,
      '放大 ⇒ zoomAt 调用 ' + zc.length + ' 次，目标 zoom=' + (zc[0] ? zc[0][0] : '—') + '（应为 zoom×' + ZOOM_STEP + '='
      + 2 * ZOOM_STEP + '），锚点 x=' + (zc[0] ? zc[0][1] : '—') + '（画布中心=' + wantX + '），额外 markDirty='
      + extraDirty + ' 次（应为 0：脏由 zoomAt 自己置）');
    // ④ 复位视角：`resetView()` 返回 true **才**补一次 markDirty —— 与双击复位那处逐字同口径
    B.calls.length = 0; B.click('zoomReset');
    const dirtyTrue = B.calls.filter((c) => c[0] === 'markDirty').length;
    e1.resetView = () => false;                        // 恒等视口：resetView 返回 false
    B.calls.length = 0; B.click('zoomReset');
    const dirtyFalse = B.calls.filter((c) => c[0] === 'markDirty').length;
    ok('eq.zoomResetDirtyOnlyWhenChanged', dirtyTrue === 1 && dirtyFalse === 0,
      'resetView()=true ⇒ markDirty ' + dirtyTrue + ' 次；=false ⇒ ' + dirtyFalse
      + ' 次（照 interact.js 双击复位：恒等视口上不置脏）');
  }
  // ───────── ③ 不挡交互 ─────────
  // `elementFromPoint` 只有真浏览器有 ⇒ 无头这一侧钉的是**它的成因**：栏壳不吃指针、按钮才吃。
  // 真机两态（触屏 / 窄屏）的 elementFromPoint 实测列入真机清单，这里如实标注为不可无头覆盖。
  {
    const cb = stripComments(readNorm(U(T.bar)));
    const shellNone = /\.xm-canvasbar\s*\{[^}]*pointer-events:\s*none/.test(cb);
    const btnAuto = /\.xm-canvasbar\s+\.tool-btn[^{]*\{[^}]*pointer-events:\s*auto/.test(cb);
    ok('hit.noSwallowCanvas', shellNone && btnAuto,
      '栏壳 pointer-events:none=' + (shellNone ? '有' : '无') + '，按钮 pointer-events:auto=' + (btnAuto ? '有' : '无')
      + ' ⇒ 两枚按钮**之间**的空白不拦画布（真机 elementFromPoint 两态实测在真机清单里）');
  }
  // ───────── 外来开关的空位（task-28 的网格 / 坐标开关）─────────
  {
    const f = FOREIGN.filter((x) => x.disp === 'add');
    ok('inv.foreignSlotRecorded', f.length === 1 && /网格/.test(f[0] ? f[0].what : ''),
      '外来新增项记账 ' + f.length + ' 条 ⇒ ' + (f[0] ? f[0].what.slice(0, 18) + '…' : '（缺：会像漏记）'));
    const cb = stripComments(readNorm(U(T.bar)));
    const box = cb.includes("setAttribute('data-xm-slot', 'grid')");
    ok('grid.slotBoxExists', box, '功能栏给外来开关留的空位：' + (box ? '有（data-xm-slot="grid"）' : '没有'));
    // ⚠ 静态 import 一个「可能还没落盘」的模块 = 整个引导抛 Cannot find module
    //   （本仓当天真实发生过一次，装载守卫 0/32 + 检查套件一起红）⇒ 这一处只许动态 import + catch。
    const staticImp = /import\s+[^;]*from\s+['"]\.\/grid-toggle\.js['"]/.test(cb);
    const dynImp = cb.includes("import('./grid-toggle.js')");
    ok('grid.hookIsDynamicOnly', !staticImp && dynImp,
      '引入方式：静态 import=' + (staticImp ? '有（危险）' : '无')
      + ' 动态 import=' + (dynImp ? '有' : '无') + ' ⇒ 对「模块尚未落盘」免疫');
  }
  // ───────── 风险 1（接缝图点名）：「别的插件会重建顶栏插槽」—— 先量后改 ─────────
  // 结论要报成「复现 / 推翻」，所以这里把机制拆成四条可测的事实，而不是转述那句注释。
  {
    // ⚠ 必须先**剥注释**再切方法体：`mountSlot` 自己的注释里就出现了 `innerHTML` 这个词，
    //   拿未剥注释的文本去数 = 在数散文 ⇒ 打出永远不可能绿的假红（本仓已知家族，我踩过一次）。
    //   剥注释还顺带让花括号配平更稳：注释里的 `}` 不再可能让提取提前收尾。
    const mainSrc = stripComments(readNorm(U('src/main.js')));
    const body = braceBody(mainSrc, '  mountSlot(name) {');
    const cold = braceBody(mainSrc, '  mountSlots() {');
    const hotClears = body ? (body.match(/innerHTML/g) || []).length : -1;
    const coldClears = cold ? (cold.match(/innerHTML\s*=\s*''/g) || []).length : -1;
    ok('risk1.hotPathNeverClearsHost', !!body && hotClears === 0,
      '剥注释后 mountSlot 体内 innerHTML 出现 ' + hotClears + ' 次（热路径不许整体清空 ⇒ 0 才安全） 体长=' + (body || '').length);
    ok('risk1.coldStartClearsOnce', !!cold && coldClears === 1,
      "mountSlots 体内 innerHTML='' 出现 " + coldClears + ' 次（冷启动清一次，只此一处）');
    const untracked = !!body && body.includes('if (alive.has(id)) continue;');
    ok('risk1.untrackedNodesSpared', untracked,
      '卸载循环只摘「被跟踪过、这次不在」的节点：' + (untracked ? '成立（未跟踪节点不被误删）' : '不成立 ⇒ 自挂容器会被顺手删掉'));
    const tbSrc = stripComments(readNorm(U(T.toolbar)));
    const wipes = (tbSrc.match(/host\.innerHTML\s*=/g) || []).length;
    ok('risk1.siblingRenderWipesSlot', wipes >= 1,
      'plugins/ui.toolbar.js 渲染回调里 host.innerHTML= 出现 ' + wipes
      + ' 次 ⇒ 同槽任一条目重渲染 = 整槽被抹，外来节点（touch.js 两个入口、任何自挂容器）一起消失');
    const emits = (readNorm(U('src/core/plugin.js')).match(/emit\('slot:changed'/g) || []).length;
    const themeHasSlot = readNorm(U('src/core/theme.js')).includes('slot:changed');
    ok('risk1.themeSwitchEmitsNoSlotChange', emits === 2 && !themeHasSlot,
      "core/plugin.js 发 slot:changed 共 " + emits + " 处（装 / 卸各一）；core/theme.js 里 'slot:changed' "
      + (themeHasSlot ? '有' : '0 次') + ' ⇒ 换主题这条路径**不**触发插槽重渲染');
  }
  // ── 行为：把**真算法**（从 main.js 文本当场切出来的 mountSlot）跑起来，看它怎么对待外来节点 ──
  {
    const mainSrc = stripComments(readNorm(U('src/main.js')));
    const body = braceBody(mainSrc, '  mountSlot(name) {');
    const host = miniEl('div');
    const items = [];
    const app = { _slotCache: new Map(), host: { slotItems: () => items } };
    let mk = null, threw = null;
    let survivesHot = null, diesOnRender = null, detail = '';
    try {
      mk = new Function('return function mountSlot(name){' + body + '}')();
    } catch (e) { threw = String(e && e.message); }
    if (mk) {
      // 渲染回调照**真插件的形状**写：先 innerHTML= 再挂按钮（ui.toolbar.js 三处都是这个形状）
      items.push({
        pluginId: 'p.a', seq: 1, key: null, kind: 'render',
        render: (el) => { el.innerHTML = ''; el.appendChild(miniEl('button')); },
      });
      const foreign = miniEl('button');
      const prevDoc = globalThis.document;
      globalThis.document = { querySelector: (s) => (s === '[data-slot="probe.slot"]' ? host : null) };
      try {
        mk.call(app, 'probe.slot');                  // 冷挂载一条目
        host.appendChild(foreign);                   // 外来节点（模拟 touch.js 的按钮 / 功能栏容器）
        mk.call(app, 'probe.slot');                  // 热路径：条目可复用
        survivesHot = host.children.includes(foreign);
        const cached = [...app._slotCache.get('probe.slot').values()][0];
        for (const n of cached.nodes) host.removeChild(n);   // 让它不再 reusable ⇒ 逼它重渲染
        mk.call(app, 'probe.slot');
        diesOnRender = !host.children.includes(foreign);
        detail = '槽内子节点=' + host.children.length + ' 外来节点: 热路径后' + (survivesHot ? '在' : '没了')
          + ' / 同槽重渲染后' + (diesOnRender ? '被抹' : '还在');
      } catch (e) { threw = String(e && e.message); }
      finally { if (prevDoc === undefined) delete globalThis.document; else globalThis.document = prevDoc; }
    }
    ok('risk1.foreignNodeSurvivesHotPath', survivesHot === true, detail || ('没拿到答案：' + threw));
    ok('risk1.foreignNodeDiesOnSiblingRender', diesOnRender === true, detail || ('没拿到答案：' + threw));
  }
  // ───────── ④ 插槽重建后不消失 ─────────
  // 无头这一侧真能跑的三条：**幂等挂载** + **槽级重建风暴**（真渲染回调的写法就是整槽 innerHTML=）
  // + **dispose → 再 mount 往返**。读数落在「栏还在 && 按钮还带监听器」。
  // 换主题与尺寸两态不构成重建路径：主题只改已有节点（`plugin.js` 发 slot:changed 仅 2 处、
  // `theme.js` 里 0 处 —— 已实测）；尺寸变化栏**根本没监听**（下一条结构断言钉住）。
  {
    const { CanvasBar, BAR_ACTS } = await import(MOD(T.bar));
    const doc = miniDoc();
    const app = {
      interaction: { tool: 'select' }, setTool() {}, markDirty() {}, addTick: () => () => {},
      engine: { zoom: 1, zoomAt: () => true, resetView: () => true },
    };
    const bar = new CanvasBar(app, { document: doc });
    bar.mount();
    if (!bar.root) bar.root = doc.createElement('div');   // 判定器不许因栏没挂出来而崩（崩溃不是红 ✓）
    const before = doc.__stage.children.length;
    bar.mount();                                       // 幂等：不许叠出第二条
    const after = doc.__stage.children.length;
    const slotLike = miniEl('div');                    // 假装是 topbar.tools 那种槽
    doc.__stage.appendChild(slotLike);
    slotLike.innerHTML = '';                           // 整槽被抹（冷启动 / 兄弟条目重渲染）
    const alive = doc.__stage.children.includes(bar.root);
    const wired = bar.root.children.filter((c) => c.__ls.some((x) => x.type === 'click')).length;
    ok('rebuild.survivesThemeSwitch', before === 1 && after === 1 && alive && wired === BAR_ACTS.length,
      '挂载 ' + before + ' 条 → 再挂 ' + after + ' 条（幂等）；同层槽被整槽 innerHTML= 抹掉后栏仍在=' + alive
      + '，带 click 监听器的按钮 ' + wired + '/' + BAR_ACTS.length + ' 枚');
    const cb0 = stripComments(readNorm(U(T.bar)));
    const listens = (cb0.match(/window\.addEventListener|matchMedia/g) || []).length;
    ok('rebuild.noResizeListener', listens === 0,
      '栏里 window.addEventListener / matchMedia 出现 ' + listens + ' 次（0 ⇒ 窄屏/宽屏切换不可能触发重挂）');
    bar.dispose();
    const gone = !doc.__stage.children.includes(bar.root) && doc.__stage.children.length === 1;
    bar.mount();
    const back = doc.__stage.children.length === 2
      && !!doc.__stage.children.find((c) => String(c.className).includes('xm-canvasbar'));
    ok('rebuild.disposeMountRoundTrip', gone && back,
      'dispose 后只剩那个假槽=' + gone + '；再 mount 后恰好一条栏=' + back + '（往返不叠、不丢）');
  }
  // ── 同一 app 上**再来一条新实例**（插件被重装 / 另一个模块也来挂）──
  // 这条是被变异体逼出来的：同一实例重复 mount 由 `this.root` 挡着，`app[MOUNTED]` 那枚复用标记
  // **只有新实例才碰得到** —— 不测它，那个守卫就是一段谁也杀不死的代码（变异体落地却一条不红 ✗）。
  {
    const { CanvasBar } = await import(MOD(T.bar));   // 本块自成作用域（上面那个块的 CanvasBar 在这里不可见）
    const d2 = miniDoc();
    const a2 = {
      interaction: { tool: 'select' }, setTool() {}, markDirty() {}, addTick: () => () => {}, engine: null,
    };
    const b1 = new CanvasBar(a2, { document: d2 });
    b1.mount();
    const b2 = new CanvasBar(a2, { document: d2 });
    const got = b2.mount();
    const cnt = d2.__stage.children.filter((c) => String(c.className).includes('xm-canvasbar')).length;
    ok('rebuild.secondInstanceReusesFirst', got === b1.root && cnt === 1,
      '第二个实例 mount ⇒ 返回第一条=' + (got === b1.root) + '，舞台上栏数=' + cnt + '（应为 1：共用而非叠一条）');
    b1.dispose();
  }
  // ───────── 外来开关：**真整合**（e-anchor 的 mountGridToggle 真的挂进我的空位）─────────
  // ⚠ 它的环境判定看的是**全局** `document`（`grid-toggle.js` 里 `typeof document === 'undefined'` ⇒ 直接
  //   返回 null）⇒ 替身必须临时挂到 `globalThis.document`，否则测到的是它的早退，不是我的空位 ✗。
  {
    const { CanvasBar } = await import(MOD(T.bar));
    const doc = miniDoc();
    const prev = globalThis.document;
    globalThis.document = doc;
    const eng = { showGrid: false, calls: [], setShowGrid(v) { this.showGrid = v; this.calls.push(v); } };
    const app = {
      interaction: { tool: 'select' }, setTool() {}, markDirty() {}, addTick: () => () => {}, engine: eng,
    };
    const bar = new CanvasBar(app, { document: doc });
    bar.mount();
    const box = bar.gridBox;
    await new Promise((r) => setTimeout(r, 30));       // 让动态 import + then 走完
    const has = box ? box.children.length : -1;
    const btn = box && box.children[0];
    let flipped = null, err = null;
    try {
      if (btn) { btn.__ls.find((x) => x.type === 'click').fn({}); flipped = eng.showGrid; }
    } catch (e) { err = String(e && e.message); }
    if (prev === undefined) delete globalThis.document; else globalThis.document = prev;
    bar.dispose();
    ok('grid.toggleActuallyMounted', has === 1 && flipped === true,
      '空位里真的挂上了 ' + has + ' 枚按钮（class=' + (btn ? btn.className : '—') + '），点它 ⇒ engine.showGrid='
      + String(flipped) + '（走它的 setShowGrid；本项不实现这个开关）' + (err ? ' 抛错=' + err : ''));
  }
  // ───────── ⑤ 边界：未装载 / 无画布不抛错 ─────────
  {
    const { CanvasBar } = await import(MOD(T.bar));
    const bare = { createElement: (t) => miniEl(t), querySelector: () => null };
    let e1 = null, r1 = 'n/a';
    try { r1 = new CanvasBar({ engine: null }, { document: bare }).mount(); }
    catch (e) { e1 = String(e && e.message); }
    ok('edge.noStage', e1 === null && r1 === null,
      '有 document 但找不到 #stage ⇒ 返回 ' + String(r1) + '，抛错=' + (e1 || '无'));
    let e2 = null, r2 = 'n/a';
    try { r2 = new CanvasBar({ engine: null }, { document: null }).mount(); }
    catch (e) { e2 = String(e && e.message); }
    ok('edge.noDocument', e2 === null && r2 === null,
      '没有 document ⇒ 返回 ' + String(r2) + '，抛错=' + (e2 || '无'));
  }
  // ───────── 结构：不许出现第二套入口（唯一能杀「复制一整套」的一类）─────────
  {
    const src = stripComments(readNorm(U(T.toolbar)));
    const toolBtns = (src.match(/data-tool=/g) || []).length;
    ok('src.singleToolEntry', toolBtns === 0,
      'plugins/ui.toolbar.js 里 data-tool= 出现 ' + toolBtns + ' 次（搬家后应为 0：工具入口只许功能栏有）');
  }

  // ══════════ 「撤销组装」可见入口（task-33）══════════
  // 真与替身边界（决定结论适用范围）：真 `World` / 真注册表（`PluginHost` 引导）/ 真
  // `src/presets/assembly.js`（含 `snapshotWorld` 指纹）。替身只有 `app` —— `class App` 顶层建
  // DOM 宿主，无头环境实例化不了；且替身**只保留世界那一步**：main.js 里其余的协调
  // （coupling / data / select / bus.emit）不是本项被测对象，不搬进来 —— 少一份镜像就少一处漂移面。
  {
    // 内核与注册表**绝不能**破缓存（MOD()）—— 实测代价：
    //   src/equipment/*.js 用**普通**相对路径 import registry.js，而 bindRegistry 绑的是
    //   **当前这个模块实例**的 currentRegistry。两边不是同一实例时，器材插件注册进普通那份、
    //   绑定却落在破除那份 ⇒ create() 恒返回 null、世界恒为空 ⇒ 哈希「没变」、连线键「回来」，
    //   **看起来像被测代码坏了**（真实读数：注册表项数=0，安装报「没有可用注册表：define() 必须在
    //   插件 setup() 内调用」）。所以只有**被测目标**（T.bar）允许破缓存，其余一律普通导入；
    //   assembly.js 也走普通 —— 这样栏与探针用的是**同一个** hasPreAssemble，见证更硬。
    const { CanvasBar: CB2, BAR_ACTS: ACTS2 } = await import(MOD(T.bar));
    const { pathToFileURL: p2u } = await import('node:url');
    // ⚠ 本文件的 U(p) 是**文件路径**（readNorm/sha 都按路径用它）⇒ import 前必须转成 file:// URL，
    //   否则 Node 报「Received protocol 'e:'」（Windows 盘符被当成 URL 协议）。
    const PU = (p) => p2u(U(p)).href;
    const A = await import(PU('src/presets/assembly.js'));
    const { World } = await import(PU('src/core/world.js'));
    const { UndoStack } = await import(PU('src/core/undo.js'));
    const { PluginHost } = await import(PU('src/core/plugin.js'));
    const { create, bindRegistry } = await import(PU('src/equipment/registry.js'));
    const { equipmentPlugins } = await import(PU('src/equipment/index.js'));
    const { PRESETS } = await import(PU('src/presets/experiments.js'));
    const pick = async (p) => (await import(PU(p))).default;

    const bootApp = { services: {}, world: null, log: { push() {}, clear() {} }, toast() {}, addTick() { return () => {}; } };
    const host2 = new PluginHost(bootApp);
    // `bindRegistry` 必须绑**这一份**：`registry.create()/get()` 每次读 `currentRegistry()`，
    // 不绑就等于静默用回原版注册表（"跑过了"却什么都没变 = 假绿）。
    for (const p of [await pick('src/physics/circuit.js'), await pick('src/chemistry/reactions.js'),
      await pick('src/coupling/bridge.js'), ...equipmentPlugins]) host2.define(p);
    host2.installAll();
    bindRegistry(host2.registry('equipment'));

    const mkStorage = () => {
      const m = new Map();
      return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); } };
    };
    // 组装前「用户手搭的」台面：两件器材 + 一根线，其中一件是**装了液体的烧杯** ——
    // 台面上原本得有东西，「撤销回来的还是不是原来那一份」才有内容可看。
    const PRE = { entities: [{ type: 'battery', x: 300, y: 300, props: { emf: 3, internalR: 1 } },
      { type: 'beaker', x: 700, y: 420, props: { capacity: 250 }, fill: { liquid: [['H2O', 90]] } }], wires: [[0, 1, 1, 0, 'wire']] };

    const makeApp = (storage) => {
      const world = new World();
      const undo = new UndoStack({ limit: 100 });
      world.undo = undo;
      const app = {
        world, undo, storage, services: { presets: PRESETS }, coupling: { links: [], branches: [] },
        data: { clear() {} }, selected: null, toastMsgs: [], _undoCalls: 0,
        toast(msg, kind) { app.toastMsgs.push([String(msg), kind || null]); },
        select(e) { app.selected = e; },
        loadScene(sc) { world.clear(); undo.runSilent(() => app._scene(sc)); return world.entities.length; },
        _scene(sc) {
          const ents = [];
          for (const o of sc.entities || []) {
            const ent = create(o.type, o.x, o.y); if (!ent) continue;
            if (o.props) for (const k of Object.keys(o.props)) ent.setProp(k, o.props[k]);
            if (o.fill && ent.vessel) {
              const v = ent.vessel;
              v.capacity = ent.props.capacity || v.capacity;
              for (const [sid, mL] of (o.fill.liquid || [])) v.addLiquid(sid, mL);
              v.updateColor();
            }
            world.add(ent, true); ents.push(ent);
          }
          for (const w of sc.wires || []) { const a = ents[w[0]], b = ents[w[2]]; if (a && b) world.connect({ e: a.id, p: w[1] }, { e: b.id, p: w[3] }, w[4]); }
          return ents;
        },
        applySaveData(d) { world.clear(); undo.runSilent(() => app._save(d)); return world.entities.length; },
        _save(d) {
          const ents = [];
          for (const o of d.entities || []) { const ent = create(o.type, o.x, o.y); if (!ent) continue; ent.loadJSON(o); world.add(ent, true); ents.push(ent); }
          for (const w of d.wires || []) { const a = ents[w[0]], b = ents[w[2]]; if (a && b) world.connect({ e: a.id, p: w[1] }, { e: b.id, p: w[3] }, w[4]); }
          return ents;
        },
      };
      // `main.js: undoAssemble() { return undoAssembleScene(this); }` 那一行的薄委托
      app.undoAssemble = () => { app._undoCalls += 1; return A.undoAssemble(app); };
      return app;
    };

    // ⚠ 本文件的 `sha(p)` 是**读文件**算内容哈希（走 `readFileSync`）⇒ 字符串要用 hashStr：
    //   把 JSON 字符串喂给 `sha`，等于让它去打开一个名叫 {…} 的文件 ⇒ ENOENT（踩过一次）。
    const hashStr = (s) => createHash('sha256').update(String(s)).digest('hex');
    const worldKey = (w) => hashStr(JSON.stringify(A.snapshotWorld(w)));
    const wireKeys = (w) => {
      const t = new Map(w.entities.map((e) => [e.id, e.type]));
      return (w.wires || []).map((x) => [t.get(x.a.e), x.a.p, t.get(x.b.e), x.b.p, x.kind].join('|')).sort().join(' ; ');
    };
    // ⚠ `UndoStack` 没有公开深度字段（实测 size/stack/__stack 都读不出来 ⇒ null）⇒ 深度那条
    //   会退化成恒真。改用**它自己公开的** `canUndo()`（`plugins/ui.toolbar.js` 也用它）：
    //   台面→组装→撤销全程都必须还是 false —— 一旦有人把组装塞进撤销栈，它立刻翻 true。
    const depthOf = (u) => (typeof u.canUndo === 'function' ? u.canUndo() : null);
    const mountBar = (app) => {
      const doc = miniDoc();
      const bar = new CB2(app, { document: doc });
      bar.mount();
      if (!bar.root) bar.root = doc.createElement('div');   // 同上：栏没挂出来也不许崩
      const btn = (a) => bar.root.children.find((c) => c.dataset.action === a);
      // 点不存在的按钮 ⇒ 返回 false（照常报红），**不是**抛异常：崩溃不是红 ✓（金丝雀实测踩到过）
      const click = (a) => { const el = btn(a); const l = el && el.__ls.find((x) => x.type === 'click'); if (!l) return false; l.fn({}); return true; };
      return { app, doc, bar, btn, click, undoBtn: () => btn('undoAssemble') };
    };
    const snap = JSON.stringify({ v: 2, entities: [], wires: [] });

    // ① 按钮存在 · 与栏内既有按钮**同族**（在 BAR_ACTS 里）· 带可访问性属性
    const B1 = mountBar(makeApp(mkStorage()));
    const u1 = B1.undoBtn();
    const mech = u1 ? [('disabled' in u1 ? 'disabled' : null), (u1.attrs['aria-disabled'] !== undefined ? 'aria-disabled' : null)].filter(Boolean).join('+') : '—';
    const name1 = u1 ? String(u1.attrs['aria-label'] || u1.attrs.title || '') : '';
    ok('undo.btnExists', !!u1 && ACTS2.includes('undoAssemble') && mech.length > 0 && name1.length > 0,
      '[data-action=undoAssemble] 存在=' + !!u1 + '；同族（在 BAR_ACTS 里）=' + ACTS2.includes('undoAssemble')
      + '；可访问性机制=' + mech + '；名字=' + JSON.stringify(name1));

    // ② 无快照 ⇒ **可见但禁用**（不是消失：消失会让用户以为功能不存在）
    const stillThere = !!u1 && B1.bar.root.children.includes(u1);
    ok('undo.disabledWhenNoSnapshot', stillThere && !!u1 && u1.disabled === true && u1.attrs['aria-disabled'] === 'true',
      '无快照时：按钮仍在栏里=' + stillThere + '（可见，未被摘掉）；disabled=' + (u1 ? u1.disabled : '—')
      + '；aria-disabled=' + (u1 ? JSON.stringify(u1.attrs['aria-disabled']) : '—'));

    // ③ 禁用态被**直接驱动**（探针绕过浏览器）⇒ 一次都不许调 API。只靠 `disabled` 不判第二次的
    //    "画成灰的还能点"，在直接调用下会漏 —— 与 `plugins/ui.toolbar.js` 里 undo/redo 同一条口径。
    let threw3 = null;
    try { B1.click('undoAssemble'); } catch (e) { threw3 = String((e && e.message) || e); }
    ok('undo.clickWhenDisabledCallsZero', B1.app._undoCalls === 0 && threw3 === null,
      '禁用态直接驱动按钮 ⇒ 实际调用 API ' + B1.app._undoCalls + ' 次（应为 0）；抛错=' + JSON.stringify(threw3));

    // ④ 有快照 ⇒ 可用
    const st4 = mkStorage();
    st4.setItem(A.PREASSEMBLE_KEY, snap);
    const B4 = mountBar(makeApp(st4));
    const u4 = B4.undoBtn();
    ok('undo.enabledWhenSnapshot', !!u4 && u4.disabled === false && u4.attrs['aria-disabled'] === 'false',
      '有快照时（hasPreAssemble=' + A.hasPreAssemble(B4.app) + '）：disabled=' + (u4 ? u4.disabled : '—')
      + '；aria-disabled=' + (u4 ? JSON.stringify(u4.attrs['aria-disabled']) : '—'));

    // ⑤ 点击 ⇒ `undoAssemble` 恰好 1 次 + **世界真的回去了**：两条**互相独立**的见证
    //    （快照哈希逐位 + 连线端点键），不是"函数被调过"。（哈希口径与 task-29 的探针同源：都走
    //    `snapshotWorld`。）
    const W = makeApp(mkStorage());
    W.loadScene(PRE);
    const n0 = W.world.entities.length, w0 = (W.world.wires || []).length;   // 台面读数：harness 自己坏了必须露出来
    const h0 = worldKey(W.world), k0 = wireKeys(W.world), d0 = depthOf(W.undo);
    const asm = A.assemble(W, PRESETS[0].id);
    const h1 = worldKey(W.world), d1 = depthOf(W.undo);
    const BW = mountBar(W);
    const uW = BW.undoBtn();
    const uPre = uW ? uW.disabled : '—';   // ⚠ 必须先取值：点击后同一个对象已翻成 true（引用是活的）
    let threw5 = null;
    try { BW.click('undoAssemble'); } catch (e) { threw5 = String((e && e.message) || e); }
    const h2 = worldKey(W.world), k2 = wireKeys(W.world), d2 = depthOf(W.undo);
    const uW2 = BW.undoBtn();
    ok('undo.clickCallsOnceAndRestores',
      n0 === 2 && w0 === 1 && asm.ok === true && h1 !== h0 && W._undoCalls === 1 && h2 === h0 && k2 === k0 && threw5 === null
      && uPre === false && !!uW2 && uW2.disabled === true,
      '台面装载=' + n0 + ' 件/' + w0 + ' 线（应为 2/1：为 0 就是 harness 坏了，不是被测代码坏了）；哈希：台面 ' + h0.slice(0, 12) + ' → 组装后 ' + h1.slice(0, 12) + '（确实变了=' + (h1 !== h0) + '）→ 点按钮后 '
      + h2.slice(0, 12) + '（与台面逐位相同=' + (h2 === h0) + '）；连线端点键回来=' + (k2 === k0) + '（' + k2
      + '）；app.undoAssemble 调用=' + W._undoCalls + ' 次；按钮点前 disabled=' + uPre
      + ' → 点后=' + (uW2 ? uW2.disabled : '—') + '（快照被消费 ⇒ 自动回到禁用）；抛错=' + JSON.stringify(threw5));

    // ⑥ 不许新造第二套撤销机制：栏不许碰撤销栈（组装与撤销都不入栈 —— `OP_KINDS.load` 的
    //    `reversible:false` 是产品语义，task-29 已论证）
    const barSrc2 = stripComments(readNorm(U(T.bar)));
    const stackTouches = (barSrc2.match(/undo\s*\.\s*(push|record|beginSilent|add)\s*\(|OP_KINDS/g) || []).length;
    ok('undo.noSecondUndoMechanism', stackTouches === 0 && d0 === d1 && d1 === d2,
      '栏源码里碰撤销栈的写法（undo.push/record/beginSilent/add、OP_KINDS）出现 ' + stackTouches + ' 次（应为 0）；'
      + '撤销栈 canUndo() 台面=' + d0 + ' 组装后=' + d1 + ' 撤销后=' + d2 + '（三处都必须 false：组装与撤销'
      + '都不产生历史条目）');

    // ⑦ 四种**真**返回码 + 未知码：各一句反馈，且都不抛。
    //    实测自 `src/presets/assembly.js` 的 `undoAssemble`：成功 / no-preassemble / no-apply-save / no-app。
    //    ⚠ `preset-not-found` 是 `assemble()` 的码，撤销这条路**不可能**返回它 —— 不照抄任务书。
    const CODES = [[{ ok: true, restored: { entities: 0, wires: 0 } }, '成功'],
      [{ ok: false, reason: 'no-preassemble' }, 'no-preassemble'],
      [{ ok: false, reason: 'no-apply-save' }, 'no-apply-save'],
      [{ ok: false, reason: 'no-app' }, 'no-app'],
      [{ ok: false, reason: 'future-code' }, '未知码']];
    const said = [];
    let threw7 = null, calls7 = 0;
    for (const [ret] of CODES) {
      const s = mkStorage();
      s.setItem(A.PREASSEMBLE_KEY, snap);
      const app = makeApp(s);
      app.undoAssemble = () => { app._undoCalls += 1; return ret; };
      const B = mountBar(app);
      try { B.click('undoAssemble'); } catch (e) { threw7 = String((e && e.message) || e); }
      calls7 += app._undoCalls;
      said.push(app.toastMsgs.map((m) => m[0]).join(' / '));
    }
    const allSaid = said.every((s) => s.length > 0);
    const distinct = new Set(said).size === said.length;
    ok('undo.feedbackForEachCode', allSaid && distinct && threw7 === null && calls7 === CODES.length,
      CODES.map(([, n], i) => n + '→「' + said[i] + '」').join(' ｜ ') + '；五句互不相同=' + distinct
      + '；抛错=' + JSON.stringify(threw7) + '；总调用=' + calls7 + ' 次（应 ' + CODES.length + '）');

    // ⑧ 边界：app 根本没有这个方法 ⇒ 按钮在、点了不炸（`no-app` 那条的配套边界）
    const s8 = mkStorage();
    s8.setItem(A.PREASSEMBLE_KEY, snap);
    const app8 = makeApp(s8);
    delete app8.undoAssemble;
    const B8 = mountBar(app8);
    let threw8 = null, c8 = 'not-called';
    try { c8 = B8.bar.act('undoAssemble'); } catch (e) { threw8 = String((e && e.message) || e); }
    // 第二子例：入口**会抛**（契约说失败只返回不抛，但栏不许被带崩）
    const s9 = mkStorage();
    s9.setItem(A.PREASSEMBLE_KEY, snap);
    const app9 = makeApp(s9);
    app9.undoAssemble = () => { throw new Error('boom-33'); };
    const B9 = mountBar(app9);
    let threw9 = null, c9 = 'not-called';
    try { c9 = B9.bar.act('undoAssemble'); } catch (e) { threw9 = String((e && e.message) || e); }
    ok('undo.missingApiSafe',
      threw8 === null && c8 === false && app8.toastMsgs.length >= 1
      && threw9 === null && c9 === false && app9.toastMsgs.length >= 1,
      'app 没有 undoAssemble 时：act() 返回 ' + JSON.stringify(c8) + '、抛错=' + JSON.stringify(threw8)
      + '、反馈=' + JSON.stringify(app8.toastMsgs.map((m) => m[0]))
      + ' ｜ 入口会抛时：act() 返回 ' + JSON.stringify(c9) + '、抛错=' + JSON.stringify(threw9)
      + '、反馈=' + JSON.stringify(app9.toastMsgs.map((m) => m[0])));

    // ⑨ 无 app：栏照样建得出来（按钮在、禁用），act() 直接返回 false 且不抛
    let mountThrew9 = null, u9 = null, r9 = 'not-called', threw9b = null;
    try {
      const bar9 = new CB2(null, { document: miniDoc() });
      bar9.mount();
      if (!bar9.root) bar9.root = miniDoc().createElement('div');
      u9 = bar9.root.children.find((c) => c.dataset.action === 'undoAssemble');
      r9 = bar9.act('undoAssemble');
    } catch (e) { mountThrew9 = String((e && e.message) || e); }
    ok('undo.noAppSafe', mountThrew9 === null && threw9b === null && !!u9 && u9.disabled === true && r9 === false,
      'app=null 时：挂载/点击抛错=' + JSON.stringify(mountThrew9 || threw9b) + '；按钮仍在=' + !!u9
      + '、disabled=' + (u9 ? u9.disabled : '—') + '；act() 返回 ' + JSON.stringify(r9));

    // ⑩ 反馈出口缺失（app 没有 toast）：照常执行、不许抛（本项只要求不炸；静默是可接受的降级）
    const s10 = mkStorage();
    s10.setItem(A.PREASSEMBLE_KEY, snap);
    const app10 = makeApp(s10);
    delete app10.toast;
    let threw10 = null, r10 = 'not-called';
    try { r10 = mountBar(app10).bar.act('undoAssemble'); } catch (e) { threw10 = String((e && e.message) || e); }
    ok('undo.noToastSafe', threw10 === null && r10 === true && app10._undoCalls === 1,
      'app 没有 toast 时：act() 返回 ' + JSON.stringify(r10) + '、入口调用=' + app10._undoCalls + ' 次、抛错=' + JSON.stringify(threw10));

    // ⑪ 可用性判据**自己**抛错（storage.getItem 抛）：按钮落到禁用、挂载与点击都不炸
    const app11 = makeApp({ getItem() { throw new Error('storage-boom'); }, setItem() {}, removeItem() {} });
    let mountThrew11 = null, B11 = null, u11 = null, r11 = 'not-called', threw11 = null, hasPre11 = 'not-called';
    try { hasPre11 = String(A.hasPreAssemble(app11)); } catch (e) { hasPre11 = 'threw:' + ((e && e.message) || e); }
    try { B11 = mountBar(app11); } catch (e) { mountThrew11 = String((e && e.message) || e); }
    if (B11) u11 = B11.undoBtn();
    try { r11 = B11 ? B11.bar.act('undoAssemble') : 'no-bar'; } catch (e) { threw11 = String((e && e.message) || e); }
    ok('undo.canUndoThrowsSafe', mountThrew11 === null && threw11 === null && r11 === false && !!u11 && u11.disabled === true,
      'storage.getItem 抛错时：hasPreAssemble 实测=' + JSON.stringify(hasPre11) + '；挂载抛错=' + JSON.stringify(mountThrew11)
      + '；按钮 disabled=' + (u11 ? u11.disabled : '—') + '；act() 返回 ' + JSON.stringify(r11) + '、抛错=' + JSON.stringify(threw11));
  }

  const fails = results.filter((r) => !r.ok);
  return { total: results.length, pass: results.length - fails.length, fail: fails.length, fails: fails.map((r) => r.id), results };
}

// ══════════════════════════════════════════════════════════
/**
 * 变异体表：`from` 只许出现在被测文件里恰好一次；不许与自己的描述文本逐字相同。
 *   - `expect` 必须**恰好等于**实测红集：多一条算误伤（`ctrlBad`），少一条算没抓住（`aligned=false`）。
 *   - `expect: []` = 等价对照：改了但**一条都不该红**（防「断言过拟合到实现细节」）。
 *   - 探针**自指**的变异体（`file` 指向本探针）里，`from` 一律拆成两段字面量拼接：
 *     整字面量会与本表里那条记录**自我命中** ⇒ `hits=2` ⇒ `landInCode=false`，变异体直接失效 ✗。
 */
const MUTANTS = [
  // ── 被测模块：src/ui/canvasbar.js ──
  {
    id: 'bar-button-double-dispatch',
    why: '监听器是共享的那一行 ⇒ 双派发打在**每枚**按钮上：工具那条 + 两条视口等价，外加 task-33 的反馈条数（同一枚按钮点一次走两遍 ⇒ 5 类码变成 10 次调用）一起红 —— 比只红一条更真',
    from: "      el.addEventListener('click', () => this.act(b.act));",
    to: "      el.addEventListener('click', () => { this.act(b.act); this.act(b.act); });",
    expect: ['eq.toolClickSetsTool', 'eq.zoomClickMarksDirty', 'eq.zoomResetDirtyOnlyWhenChanged', 'undo.feedbackForEachCode'],
  },
  {
    id: 'bar-tool-writes-state-itself',
    why: '绕开 app.setTool 自己写 interaction.tool（等于发明了第二条出口）⇒ 同一条该红',
    from: "    if (b.kind === 'tool') { app.setTool(name); this.sync(); return true; }",
    to: "    if (b.kind === 'tool') { if (app.interaction) app.interaction.tool = name; this.sync(); return true; }",
    expect: ['eq.toolClickSetsTool'],
  },
  {
    id: 'bar-zoom-bypasses-zoomAt',
    why: '把 eng.zoomAt(eng.zoom*f, …) 换成 eng.zoom *= f —— 数值逐位相同却**不置脏**（画面不动）⇒ 只有「走没走 zoomAt」能杀得住',
    from: '    eng.zoomAt(eng.zoom * f, c.x, c.y);',
    to: '    eng.zoom *= f;',
    expect: ['eq.zoomClickMarksDirty'],
  },
  {
    id: 'bar-reset-dirties-always',
    why: '恒等视口（resetView 返回 false）时也置脏 ⇒ 与双击复位那处口径不再逐字相同',
    from: '      if (eng.resetView()) app.markDirty();',
    to: '      eng.resetView(); app.markDirty();',
    expect: ['eq.zoomResetDirtyOnlyWhenChanged'],
  },
  {
    id: 'bar-active-never-cleared',
    why: '高亮只加不减（切工具后两枚同时 active）⇒ 只该红「恰好一个高亮」那条',
    from: "      el.classList.toggle('active', on);",
    to: "      if (on) el.classList.add('active');",
    expect: ['eq.barSyncsActiveTool'],
  },
  {
    id: 'bar-shell-eats-pointer',
    why: '栏壳 pointer-events 从 none 改成 auto（整条栏开始拦画布）⇒ 只该红不挡交互那条',
    from: '  pointer-events:none;',
    to: '  pointer-events:auto;',
    expect: ['hit.noSwallowCanvas'],
  },
  {
    id: 'bar-second-instance-not-shared',
    why: '拆掉 app[MOUNTED] 复用判断 —— 同一实例重复 mount 由 this.root 挡着，只有**新实例**来挂才暴露它 ⇒ 只该红「第二实例共用第一条」那条',
    from: '    if (app && app[MOUNTED]) return app[MOUNTED];        // 别人已挂过：共用那一条\n',
    to: '',
    expect: ['rebuild.secondInstanceReusesFirst'],
  },
  {
    id: 'bar-both-idempotence-guards-removed',
    why: '两处幂等守卫一起拆（单拆任一处都被另一处兜住）⇒ 判据④那三条一起红',
    from: '    if (this.root) return this.root;\n    const doc = this.doc;\n'
      + "    if (!doc || typeof doc.createElement !== 'function') return null;\n"
      + '    const app = this.app;\n'
      + '    if (app && app[MOUNTED]) return app[MOUNTED];        // 别人已挂过：共用那一条\n',
    to: '    const doc = this.doc;\n'
      + "    if (!doc || typeof doc.createElement !== 'function') return null;\n"
      + '    const app = this.app;\n',
    expect: ['rebuild.survivesThemeSwitch', 'rebuild.disposeMountRoundTrip', 'rebuild.secondInstanceReusesFirst'],
  },
  {
    id: 'bar-edge-throws-without-stage',
    why: '找不到 #stage 时改成抛错（而不是安静返回 null）⇒ 只该红无画布那条',
    from: "    if (!stage || typeof stage.appendChild !== 'function') return null;",
    to: "    if (!stage || typeof stage.appendChild !== 'function') throw new Error('no stage');",
    expect: ['edge.noStage'],
  },
  {
    id: 'bar-edge-throws-without-document',
    why: '没有 document 时改成抛错 ⇒ 只该红无 document 那条',
    from: "    if (!doc || typeof doc.createElement !== 'function') return null;",
    to: "    if (!doc || typeof doc.createElement !== 'function') throw new Error('no document');",
    expect: ['edge.noDocument'],
  },
  {
    id: 'bar-resize-listener-added',
    why: '给栏挂上 window resize 监听（尺寸一变就开始重算）⇒ 只该红「不监听尺寸」那条',
    from: '    this.sync();\n    this.syncUndo();\n    return bar;',
    to: "    this.sync();\n    this.syncUndo();\n    if (typeof window !== 'undefined') window.addEventListener('resize', () => this.sync());\n    return bar;",
    expect: ['rebuild.noResizeListener'],
  },
  // ── 与 task-28 的接缝 ──
  {
    id: 'grid-static-import',
    why: '把动态 import() 换成模块顶部静态 import（对方模块没落盘时整个引导抛错）⇒ 只该红引入方式那条',
    from: "const MOUNTED = Symbol.for('xiaomo.canvasbar.mounted');",
    to: "import { mountGridToggle } from './grid-toggle.js';   // 变异体：静态引入（只为验证断言认得出）\nconst MOUNTED = Symbol.for('xiaomo.canvasbar.mounted');",
    expect: ['grid.hookIsDynamicOnly'],
  },
  {
    id: 'grid-hook-not-called',
    why: '不再调用外来入口（空位永远空着）⇒ 只该红「真整合跑通」那条',
    from: '    this._hookGrid();',
    to: '    // this._hookGrid();',
    expect: ['grid.toggleActuallyMounted'],
  },
  {
    id: 'grid-slot-attr-renamed',
    why: '空位的 data-xm-slot 值改掉（对方按名字找容器就找不着）⇒ 只该红空位存在那条',
    from: "    box.setAttribute('data-xm-slot', 'grid');",
    to: "    box.setAttribute('data-xm-slot', 'grid-x');",
    expect: ['grid.slotBoxExists'],
  },
  {
    id: 'bar-extra-button-added',
    why: '给 BTNS 加第 8 枚按钮而探针的记录表没动 ⇒ 只该红「探针表 == 模块表」那条（条数真源在模块侧，不写字面量）',
    from: "  { act: 'zoomReset', kind: 'view', cls: 'tb-btn', label: '复位视角', ico: ICO.zoomReset },",
    to: "  { act: 'zoomReset', kind: 'view', cls: 'tb-btn', label: '复位视角', ico: ICO.zoomReset },\n  { act: 'zoomFit', kind: 'view', cls: 'tb-btn', label: '适应', ico: ICO.zoomReset },",
    expect: ['drift.probeTableMatchesModule'],
  },
  {
    id: 'bar-bottom-nudged',
    why: '等价对照：只把 bottom 从 58px 挪到 60px（视觉微调，不在任何断言里）⇒ 必须一条都不红',
    from: 'bottom:58px',
    to: 'bottom:60px',
    expect: [],
  },
  // ── 探针自指（file 指向本探针）：from 必须拆字面量 ──
  // ── 被测插件：src/plugins/ui.toolbar.js ──
  {
    id: 'tool-entry-copied-back-to-topbar',
    why: '把工具入口又抄回顶栏（= 复制一整套入口，规格⑥明令禁止的第二套工具入口）⇒ 只该红「全文档 [data-tool] 恒为工具数」那条',
    file: 'src/plugins/ui.toolbar.js',
    from: '      host.innerHTML = `\n        <button type="button" id="btnRun"',
    to: '      host.innerHTML = `\n        <button type="button" data-tool="wire" class="tb-btn">W</button>\n        <button type="button" id="btnRun"',
    expect: ['src.singleToolEntry'],
  },
  {
    id: 'self-foreign-row-downgraded',
    why: '把外来新增项的去向从 add 降级成 keep（等于没记账）⇒ 只该红外来记账那条',
    file: 'tools/toolbar-probe.mjs',
    from: "kind: 'canvas', disp: " + "'add',",
    to: "kind: 'canvas', disp: " + "'keep',",
    expect: ['inv.foreignSlotRecorded'],
  },
  {
    id: 'self-comment-stripping-lost',
    why: '结构断言改回「不剥注释」（等于拿散文当代码）⇒ 只该红「热路径不清空」那条 —— 这条变异体同时把之前踩过的那个假红钉住',
    file: 'tools/toolbar-probe.mjs',
    from: '    const mainSrc = ' + "stripComments(readNorm(U('src/main.js')));\n"
      + "    const body = braceBody(mainSrc, '  mountSlot(name) {');\n"
      + "    const cold = braceBody(mainSrc, '  mountSlots() {');",
    to: '    const mainSrc = ' + "readNorm(U('src/main.js'));\n"
      + "    const body = braceBody(mainSrc, '  mountSlot(name) {');\n"
      + "    const cold = braceBody(mainSrc, '  mountSlots() {');",
    expect: ['risk1.hotPathNeverClearsHost'],
  },
  {
    id: 'self-wipe-threshold-stale',
    why: '把「同槽重渲染会抹掉外来节点」的门槛从 ≥1 改成 ≥3（实测是 2）⇒ 只该红那条，证明它对着实测计数真比较',
    file: 'tools/toolbar-probe.mjs',
    from: "ok('risk1.siblingRenderWipesSlot', wipes >= " + '1,',
    to: "ok('risk1.siblingRenderWipesSlot', wipes >= " + '3,',
    expect: ['risk1.siblingRenderWipesSlot'],
  },
  {
    id: 'self-untracked-guard-string-shifted',
    why: '把卸载循环那句判据搜成一个源码里并不存在的近似串 ⇒ 只该红「未跟踪节点不被误删」那条',
    file: 'tools/toolbar-probe.mjs',
    from: "body.includes('if (alive.has(id)) " + "continue;')",
    to: "body.includes('if (alive.has(id)) " + "continue ;')",
    expect: ['risk1.untrackedNodesSpared'],
  },
  {
    id: 'self-slotchange-count-stale',
    why: '把 slot:changed 的期望处数从 2 改成 3 ⇒ 只该红「换主题不发 slot:changed」那条，证明它是真计数',
    file: 'tools/toolbar-probe.mjs',
    from: "ok('risk1.themeSwitchEmitsNoSlotChange', emits === " + '2 && !themeHasSlot,',
    to: "ok('risk1.themeSwitchEmitsNoSlotChange', emits === " + '3 && !themeHasSlot,',
    expect: ['risk1.themeSwitchEmitsNoSlotChange'],
  },
  // ── task-33：「撤销组装」可见入口 ──
  {
    id: 'canary-bar-never-mounts',
    canary: true,
    why: '金丝雀（机制自证）：让 mount() 一进门就返回 null ⇒ 栏根本不存在。只要求真的红了（不断言具体哪几条）—— 红 0 条就说明变异体没落到代码里、或者判定根本不会红。',
    from: "    if (this.root) return this.root;",
    to: "    if (this.root) return this.root;\n    return null;",
    expect: [],
  },
  {
    id: 'null-css-decl-order',
    why: '空等价对照：同一条 CSS 规则里两个**互不相干**的声明换位（left 与 bottom）⇒ 语义为零，一条都不该红。',
    from: '  position:absolute; left:50%; transform:translateX(-50%); bottom:58px; z-index:3;',
    to: '  position:absolute; bottom:58px; left:50%; transform:translateX(-50%); z-index:3;',
    expect: [],
  },
  {
    id: 'undo-button-removed',
    why: '把声明表里那一行抽掉 ⇒ 入口整体消失：存在性 / 两态 / 点击 / 反馈全链断，且条数记录与模块对不上。',
    from: "  { act: 'undoAssemble', kind: 'undo', cls: 'tb-btn', label: '撤销组装', ico: ICO.undoAssemble },\n",
    to: '',
    // 这里**不**含 undo.clickWhenDisabledCallsZero：按钮整条不存在时，「禁用态点一下 ⇒ 0 次调用」仍然成立
    //（那条判据管的是「处理体自己再判一次」，由 undo-guard-removed 覆盖）。实测红集就这 7 条。
    expect: ['drift.probeTableMatchesModule', 'undo.btnExists', 'undo.disabledWhenNoSnapshot',
      'undo.enabledWhenSnapshot', 'undo.clickCallsOnceAndRestores',
      'undo.feedbackForEachCode', 'undo.missingApiSafe',
      // 入口整条不存在 ⇒ 三条边界判据的前提（按钮在）也不成立，实测一起红
      'undo.noAppSafe', 'undo.noToastSafe', 'undo.canUndoThrowsSafe'],
  },
  {
    id: 'undo-always-enabled',
    why: '两态同步里把可用性写死成 true ⇒ 没有快照时按钮看着能点（用户点了才知道没得撤）。',
    from: '    const can = this._canUndo();',
    to: '    const can = true;',
    expect: ['undo.disabledWhenNoSnapshot', 'undo.clickCallsOnceAndRestores', 'undo.noAppSafe', 'undo.canUndoThrowsSafe'],
  },
  {
    id: 'undo-guard-removed',
    why: '删掉处理体里那次「自己再判一次」⇒ 把禁用按钮当能点的用（探针直接驱动 + 程序化调用都会漏）。',
    from: '      if (!this._canUndo()) { this.syncUndo(); return false; }\n',
    to: '',
    expect: ['undo.clickWhenDisabledCallsZero', 'undo.canUndoThrowsSafe'],
  },
  {
    id: 'undo-error-feedback-dropped',
    why: '只留成功提示、失败那四类码一律不出声 ⇒ 用户点了没反应，不知道是没得撤还是坏了。',
    from: "      this._say(this._undoMsg(r), r && r.ok ? null : 'warn');",
    to: "      if (r && r.ok) this._say(this._undoMsg(r));",
    expect: ['undo.feedbackForEachCode'],
  },
  {
    id: 'undo-no-feedback-at-all',
    why: '连成功提示一起拿掉（只算文案、不发声）⇒ 五类码全都没话说。',
    from: "      this._say(this._undoMsg(r), r && r.ok ? null : 'warn');",
    to: '      void this._undoMsg(r);',
    expect: ['undo.feedbackForEachCode'],
  },
  {
    id: 'undo-two-codes-same-sentence',
    why: 'switch 里两个分支复制粘贴成同一句话（no-apply-save 说成 no-preassemble）⇒ 用户分不清是「没得撤」还是「撤不动」。',
    from: "      case 'no-apply-save': return '撤销失败：这个世界没有载回存档的入口';",
    to: "      case 'no-apply-save': return '没有可撤销的组装';",
    expect: ['undo.feedbackForEachCode'],
  },
  {
    id: 'undo-api-throw-unguarded',
    why: '把入口调用那层 try/catch 拆掉（契约说失败只返回不抛 —— 但一旦抛了，栏不许跟着崩）。',
    from: ["      try { r = fn.call(app); } catch (e) {",
      "        this._say('撤销组装失败：' + ((e && e.message) || e), 'warn');",
      '        this.syncUndo();',
      '        return false;',
      '      }'].join('\n'),
    to: '      r = fn.call(app);',
    expect: ['undo.missingApiSafe'],
  },
  {
    id: 'undo-second-undo-mechanism',
    why: '在撤销出口旁边顺手碰一下撤销栈（beginSilent）⇒ 等于给组装/撤销另开一套历史机制。',
    from: "      this._say(this._undoMsg(r), r && r.ok ? null : 'warn');",
    to: "      app.undo.beginSilent();\n      this._say(this._undoMsg(r), r && r.ok ? null : 'warn');",
    expect: ['undo.noSecondUndoMechanism'],
  },
  {
    id: 'undo-toast-guards-removed',
    why: '把反馈出口的两层保护（typeof 守卫 + 内层 try/catch）一起拆掉 ⇒ app 没有 toast 时，异常会从 act() 逃出去。',
    from: ["    if (!app || typeof app.toast !== 'function') return;",
      '    try { if (kind) app.toast(msg, kind); else app.toast(msg); } catch (_) { /* 提示失败不算失败 */ }'].join('\n'),
    to: '    if (kind) app.toast(msg, kind); else app.toast(msg);',
    expect: ['undo.noToastSafe'],
  },
  {
    id: 'undo-canundo-try-removed',
    why: '把可用性判据外那层 try/catch 拆掉 —— 实测**一条都不红**：上游 assembly.js 自己已经把 storage 的抛错吞掉（hasPreAssemble 不抛），这层 try/catch 是纵深防御、当前不可达 ⇒ 如实记为第二条**空等价对照**（expect: []），不当成抓住缺陷。',
    from: '    try { return !!hasPreAssemble(app); } catch (_) { return false; }',
    to: '    return !!hasPreAssemble(app);',
    expect: [],
  },
];

function mutate() {
  const original = readFileSync(U(T.bar));
  const originalSha = sha(U(T.bar));
  const rows = [];
  // ⚠ `os.tmpdir()` 在本沙箱可能返回**相对路径**（实测 `undefined\temp`）⇒ 裸用它会把留证写到
  //   工作目录之外。用 `path.resolve` 把 `TEMP`/`TMP`/`TMPDIR` 里任一存在的值钉成绝对路径；
  //   一个都没有时退到**仓外**的 `_scratch`（不用 `process.cwd()`：从仓根跑就把临时目录建进仓里了）。
  const tmpRoot = path.resolve(process.env.TEMP || process.env.TMP || process.env.TMPDIR || path.resolve(ROOT, '..', '_scratch'));
  const tmpDir = path.join(tmpRoot, 'toolbar-probe');
  try { mkdirSync(tmpDir, { recursive: true }); } catch { /* 已存在 */ }
  const outFile = path.join(tmpDir, 'judge.json');
  const selfAbs = path.resolve(SELF);
  const selfSha0 = sha(selfAbs);
  try {
    for (const m of MUTANTS) {
      const fileAbs = m.file ? U(m.file) : U(T.bar);
      const base = readFileSync(fileAbs);
      const baseSha = sha(fileAbs);
      const src = norm(base.toString('utf8'));
      const hits = src.split(m.from).length - 1;
      const landInCode = hits === 1;
      let reds = null, err = null, judgeOut = null;
      if (landInCode) {
        const mutated = src.replace(m.from, m.to);
        writeFileSync(fileAbs, mutated, 'utf8');
        // 落一份"当时确实长这样"的证据：红集与预期不符时，唯一能复核的就是这份文本
        try { writeFileSync(path.join(tmpDir, 'mutant-' + m.id + '.js'), mutated, 'utf8'); } catch { /* 留证失败不影响判定 */ }
        // ⚠ 先把上一次的判定文件**清空**：子进程若崩在写文件之前，残留的旧判定会被当成这次的
        //   读数（我踩过：读到的是上一个变异体的红集，还看着特别合理）。
        try { writeFileSync(outFile, ''); } catch { /* 清不掉也无妨：下面会因空文件判成"无判定" */ }
        try {
          execFileSync(process.execPath, [SELF, '--root=' + ROOT, '--judge-json=' + outFile],
            { stdio: 'ignore', cwd: ROOT });
        } catch (e) { err = String(e && e.message).slice(0, 200); }
        // ⚠ 退出码**不参与判断**（本仓口径：它既不是成功的判据，也不是失败的判据）：
        //   子进程红了会自己置 1，崩了也置 1 —— 一律照样去读那份判定文件。
        try {
          judgeOut = JSON.parse(readFileSync(outFile, 'utf8'));
          // 崩过的判定**没有** fails 字段 ⇒ 必须落成 null（"没有证据"），绝不能写成 []（"零红"）：
          // 否则等价对照（expect: []）会把一次崩溃读成"全绿" ×。
          reds = Array.isArray(judgeOut.fails) ? judgeOut.fails : null;
        } catch { /* 判定文件没写出来（崩在 judge 之前）⇒ 这一条没有证据，判不通过 */ }
        finally { writeFileSync(fileAbs, base); }
      }
      const restoredOk = sha(fileAbs) === baseSha;
      const observed = reds || [];
      // 金丝雀（`canary: true`）：只要求**真的红了**（≥1 条）。它的用途是证明「变异确实落到了代码里、
      // 判定确实会红」—— 机制自证，不断言具体哪几条业务判据。红 0 条 ⇒ 机制坏了 ⇒ 不通过。
      const ctrlBad = m.canary ? [] : observed.filter((r) => !m.expect.includes(r));
      const aligned = Array.isArray(reds) && (m.canary
        ? observed.length > 0
        : (m.expect.every((e) => observed.includes(e)) && ctrlBad.length === 0));
      rows.push({
        id: m.id, why: m.why, file: m.file || T.bar, landInCode, hits, err,
        crashed: judgeOut ? (judgeOut.crashed || null) : 'no-judge-output',
        expectedRed: m.expect, observedRed: observed, ctrlBad, aligned, restoredOk,
        ok: landInCode && restoredOk && aligned && judgeOut !== null,
      });
    }
  } finally {
    if (sha(U(T.bar)) !== originalSha) writeFileSync(U(T.bar), original);
  }
  const bad = rows.filter((r) => !r.ok);
  return {
    ok: bad.length === 0 && rows.length > 0, mode: 'mutate',
    target: T.bar, targetSha: originalSha, restored: sha(U(T.bar)) === originalSha,
    selfSha: sha(selfAbs), selfRestored: sha(selfAbs) === selfSha0,
    total: rows.length, green: rows.length - bad.length, red: bad.length,
    bad: bad.map((r) => r.id), mutants: rows,
  };
}

// ─────────────────────────────────────────────────────────
/** 本仓惯例：末尾印一行紧凑、无空格的机器可读 JSON；**红档也印** —— 没有它，总网只能靠退出码猜 */
const emit = (o) => console.log('TOOLBAR_JSON ' + JSON.stringify(o));

const judgeJson = argOf('judge-json', null);
try {
if (judgeJson) {
  const r = await judge();
  writeFileSync(judgeJson, JSON.stringify(r), 'utf8');
  emit({ total: r.total, pass: r.pass, fail: r.fail, mutate: false });
} else if (args.includes('--mutate')) {
  const r = mutate();
  console.log(JSON.stringify(r, null, 2));
  emit({ total: r.total, pass: r.green, fail: r.red, mutate: true });
  if (!r.ok) process.exitCode = 1;
} else {
  const r = await judge();
  console.log(JSON.stringify(r, null, 2));
  emit({ total: r.total, pass: r.pass, fail: r.fail, mutate: false });
  if (r.fail) process.exitCode = 1;
}
} catch (e) {
  // 崩了也**必须**打出机器可读 JSON：否则总网只能靠「没有 JSON」去猜是红还是崩，
  // 而这两件事的处置完全不同（红 = 去看哪条判据，崩 = 去看栈）。fail:-1 是「没跑完」的哨兵值。
  const info = {
    total: results.length, pass: results.filter((r) => r.ok).length, fail: -1,
    mutate: args.includes('--mutate'), crashed: String((e && e.message) || e).slice(0, 200),
  };
  emit(info);
  // 也要写进判定文件：不然 --mutate 只能看到"没有判定"，看不到**为什么**崩
  if (judgeJson) { try { writeFileSync(judgeJson, JSON.stringify(info), 'utf8'); } catch { /* 留证失败 */ } }
  process.exitCode = 1;
}
