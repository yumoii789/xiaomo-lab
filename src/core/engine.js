// ══════════════════════════════════════════════════════════
// Engine —— 主循环 + 画布渲染
//
// 固定步长积分（1/120 s）+ 累加器，保证化学反应速率与
// 电路求解不受帧率影响；渲染由脏标记决定（暂停且静止时整帧跳过）。
// ══════════════════════════════════════════════════════════

import { C } from './theme.js';
import { bus, EV } from './bus.js';

// ── 跨域耦合流动（B6）的常量 ────────────────────────────────
const FLOW_I_REF = 0.2;        // A —— 电流到 0.2 A（电解典型值）时速度/亮度满格
const FLOW_P_REF = 4;          // W —— 热耦合满格功率
const FLOW_MIN_I = 1e-5;       // A —— 低于此值视为没有能量在流
const FLOW_SPEED_MIN = 26;     // px/s —— 刚刚开始流动
const FLOW_SPEED_MAX = 232;    // px/s —— 满格
const FLOW_DASH = [3, 6];      // 流动高光的虚线（周期 9px，与相位取模一致）
const FLOW_DASH_PERIOD = 9;
const PROBE_DASH = [5, 4];     // 探头连线的基础虚线
const EMPTY_DASH = [];
const FLOW_TINT_MAX = 5;       // 亮度档位数（颜色在主题切换时预生成）

/** '#rrggbb' / '#rgb' → [r,g,b]；认不出来时退回耦合紫 */
function hexRGB(h) {
  const s = String(h || '').trim();
  if (s[0] === '#' && (s.length === 7 || s.length === 4)) {
    const e = s.length === 4 ? '#' + s[1] + s[1] + s[2] + s[2] + s[3] + s[3] : s;
    const n = parseInt(e.slice(1), 16);
    if (!Number.isNaN(n)) return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  return [139, 92, 246];
}

/**
 * 粗指针（手指）判据 —— 与 `src/ui/interact.js` 的 `coarsePointer()` 读**同一条**媒体查询。
 * 引擎不 import UI 层（依赖方向是 ui → core），所以两边各读一次，靠探针钉住两条查询串一致。
 * ⚠ 命中半径的档位在交互层（`Interaction.portTol()`），这里只管**画多大**；
 *   两侧必须同源，否则会出现「画得大、点不中」这种最难查的错位。
 */
const COARSE_MQ = '(pointer: coarse)';
const _mqCache = new Map();
function mqMatches(q) {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  let m = _mqCache.get(q);
  if (!m) { try { m = window.matchMedia(q); } catch (err) { m = null; } _mqCache.set(q, m); }
  return !!(m && m.matches);        // 每次读 .matches：接上外接键鼠后媒体查询会当场变
}
const coarsePointer = () => mqMatches(COARSE_MQ);

/** 端口视觉半径（世界 px）。⚠ 细指针这一组是**既有值**：改动即回归（探针逐位钉 3.4 / 5 / 10） */
const PORT_R_FINE = { wire: 3.4, probe: 3.2, hot: 5, halo: 10, label: 11 };
/** 粗指针整体放大一档：手指要看得见，才谈得上点得准 */
const PORT_R_COARSE = { wire: 4.8, probe: 4.6, hot: 6.6, halo: 15, label: 12 };

/**
 * 全局实验速度档（B1）。
 *
 * ⚠ **档位数值是我方自定的**：NB 的 min/max/step 序列化值在 `data.unity3d` 的 LZ4 块里、
 *   **未取到**（`plans/10` §11.1 明写「B1 不许照抄具体档位」）⇒ 这里只承诺三件事：
 *   **多档 · 档位可读 · 只改时间步进不改物理结果**，不声称与 NB 的档位一一对应 ✗。
 *
 * ⚠ **与物理的关系（B1 的判据）**：`frame()` 永远以 `this.fixed`（1/120 s）调
 *   `world.step()`，`speed` 只决定**每帧往累加器里喂多少模拟时间** ⇒
 *   **同一模拟时刻的状态与档位无关**（探针按档位逐位比对，而不是只看稳态读数）。
 */
export const SPEEDS = [0.1, 0.25, 0.5, 1, 2, 4];

/**
 * 视口缩放的上下限（见 `Engine.zoom`）。取 0.25×–4× 的理由：
 *   · 上限 4×：一根 24px 的世界网格线在屏幕上变成 96px，接线柱的屏幕命中半径
 *     （`HIT_PORT` 是**世界量**）随之放大 4 倍 ⇒ 手指有足够精度去点接线柱；
 *   · 下限 0.25×：一块 840px 宽的画布能看见 3360 世界像素 ≈ 140 格，够放下整场
 *     实验的台面；再小接线柱的屏幕半径只剩 3px 出头、点不中 —— 这是内容缩放的
 *     固有代价，不做补偿（用户要的是「像地图一样缩放」）。
 */
export const ZOOM_MIN = 0.25;
export const ZOOM_MAX = 4;

/**
 * 网格 / 坐标开关的**持久化键**。仓库没有中心化的设置存储，既有做法是「每特性一个键 +
 * 用 try/catch 包住访问」（`src/ui/palette.js` 的折叠态、`src/core/inventory.js` /
 * `src/core/market.js` 都在 `core/` 里这么干）⇒ 沿用同一套，**不自造新存储**。
 * 读不到（无痕模式、嵌入环境、Node 探针里根本没有 localStorage）⇒ 回默认值 **true**（开）。
 */
export const GRID_KEY = 'xiaomo.grid.v1';

function readGridPref() {
  try {
    if (typeof localStorage === 'undefined') return true;   // Node / 无痕 / 嵌入环境
    const v = localStorage.getItem(GRID_KEY);
    return v === null ? true : v !== '0';                   // 没存过 = 默认开
  } catch (e) { return true; }
}

function writeGridPref(on) {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(GRID_KEY, on ? '1' : '0');
  } catch (e) { /* 存不下（配额/无痕）就只在本次会话生效，与 ui.settings.js 同风格 */ }
}

export class Engine {
  constructor(canvas, world) {
    this.canvas = canvas;
    this.g = canvas.getContext('2d');
    this.world = world;

    this.w = 0; this.h = 0; this.dpr = 1;
    /**
     * 画布视口偏移（世界坐标 = 屏幕坐标 − pan）—— 「拖动实验室整体界面」的真源。
     * ⚠ 它不是场景数据：**不进 world、不进存档、不参与撤销**，只是本实例的视角状态，
     *   所以存盘/回放/账目都不该看见它（谓词见 tools/pan-probe.mjs §②）。
     */
    this.pan = { x: 0, y: 0 };
    /**
     * 画布视口缩放：**屏幕坐标 = 世界坐标 × zoom + pan** —— 「缩放实验室」的真源。
     * ⚠ 与 pan 同族：只是视角状态，**不进 world、不进存档、不参与撤销**。
     * 恒等值 1：zoom===1 且 pan 为零时**一条变换指令都不发**，绘制指令流与
     * 「没有视口」时逐位相同（tools/pan-probe.mjs §② 拿改动前的 engine.js 对跑）。
     * ⚠ 唯一换算出口仍是 `screenToWorld()`：交互层自己写 `(p.x - pan.x) / zoom`
     *   等于多一个「看得见但点不中」的机会。
     * ⚠ 合法值恒落在 [ZOOM_MIN, ZOOM_MAX]（`clampZoom`）。
     */
    this.zoom = 1;
    /** 当前速度档（B1 的真源）；合法值**恒为** this.speeds 的元素（setSpeed 会吸附） */
    this.speed = 1;
    /** 档位表（B1）：UI 从这里取档，不再把 0.25/1 硬编码在工具栏里 */
    this.speeds = SPEEDS.slice();
    this.fixed = 1 / 120;
    this.acc = 0;
    this.maxSteps = 10;

    this.fps = 0;
    this._fpsAcc = 0; this._fpsN = 0;

    this.gridSize = 24;
    /**
     * 网格与坐标读数的**总开关**（项④）。
     * **默认 true**：改动前 `drawGrid()` 是**无条件**画的（`render()` 里没有任何判断），
     * 默认开才能兑现「开关开着时绘制指令流与改动前逐位相同」这条硬指标
     * （`tools/pan-probe.mjs` §②。实测该探针只记 setTransform / clearRect / translate /
     * scale 四个方法，网格的 stroke 从来不在它的指令流里 ⇒ 这个开关在默认态
     * **不可能**打破那条判据 —— 但仍然照跑一遍取证）。
     * ⚠ NB 物理侧的对应设置是 `{"name":"网格","checked":false}`（默认**没有**底纹网格），
     *   可那是**某个 lab（labId 5）的设置**，我们这里是全局底纹 ⇒ 默认值属**产品决策**
     *   （`plans/17` ⑥ 原文：「需要用户拍板」）。这里取 true = 不改现状；翻成 false
     *   只改这一行，且与上面的判据无关。
     * ⚠ 一根开关管两件事（画网格 + 画坐标读数），照 NB 的 `SHOW_COORDINATE`：
     *   命令名是「显示坐标」、显示名是「网格」⇒ 一个开关，两个效果。
     * ⚠ 只改「画不画」：**不动 `gridSize`、不动吸附**（吸附格是 `interact.js` 的 SNAP = 4，
     *   与这张 24px 的网格从来不是同一张格 —— 顺手对齐会改掉器材拖动落点）。
     */
    this.showGrid = readGridPref();
    /** 坐标读数用的指针位置（**屏幕坐标**，相对画布左上角）；null = 还没收到指针 ⇒ 不画读数 */
    this.pointerScreen = null;
    // 坐标读数的指针从 DOM 事件来（读数本身不需要被点中 ⇒ 可以画在 Canvas 上）。
    // ⚠ 替身画布（Node 里的探针）可能没有 addEventListener ⇒ 全程可选，一律不抛。
    if (this.canvas && typeof this.canvas.addEventListener === 'function') {
      this.canvas.addEventListener('pointermove', (ev) => this._onPointerMove(ev), { passive: true });
    }
    /** UI 层可以在这些钩子里画拖拽预览、连线预览等 */
    this.overlays = [];
    this.onFps = null;

    // ── B1 脏检查 ──
    /** 画面需要重绘；true 时本帧必须渲染 */
    this._needsRender = true;
    /** 由 UI 层注入（见 interact.js）：用来读 app._dirty 与 app.coupling */
    this.app = null;

    // ── B2 台面渐变缓存 ──
    this._benchGrd = null;
    this._grdW = -1; this._grdH = -1;

    // ── B6 跨域耦合流动 ──
    /** 耦合总线（晚于引擎创建，由 UI 层注入的 app 里取） */
    this.coupling = null;
    /** wireId → { phase, level, dir, speed, moving, tick } */
    this._flow = new Map();
    /** 与活跃耦合电连通的器材 id */
    this._flowReach = new Set();
    this._flowSig = -1;
    this._flowTick = 0;
    this._lastTime = 0;
    this._sceneStamp = -1;
    this._tints = null;
    this._rebuildFlowTints();

    this.reducedMotion = false;
    if (typeof window !== 'undefined' && window.matchMedia) {
      const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
      this.reducedMotion = !!mq.matches;
      const onCalm = (e) => { this.reducedMotion = !!e.matches; this._needsRender = true; };
      if (mq.addEventListener) mq.addEventListener('change', onCalm);
      else if (mq.addListener) mq.addListener(onCalm);
    }

    // 场景结构变化 / 换主题都要重画
    bus.on(EV.SCENE_DIRTY, () => { this._needsRender = true; });
    bus.on('theme:changed', () => {
      this._benchGrd = null;
      this._rebuildFlowTints();
      this._needsRender = true;
    });

    this.resize();
  }

  /** B1/B5：把「画面需要重绘」交给引擎（UI 层改动场景或选中态时调用） */
  markDirty() { this._needsRender = true; }

  /**
   * 切换网格 / 坐标读数（项④）。返回切换后的值。
   *
   * ⚠ **必须置脏**：状态变了、画面不变，是这条开关最容易漏的一环
   *   （`plans/17` ④「会假绿的四类」第 4 类「数值路径盲区」明确点名）。
   * ⚠ 关闭时**不把 `gridSize` 置 0** —— 那样网格确实会消失、只看「有没有 stroke」的
   *   判据也全绿，但会悄悄污染任何「用 gridSize 反推」的推断（`src/ui/interact.js`
   *   里就留着这样一条注释）⇒ **常量真源恒为 24，开关另设字段**。
   */
  setShowGrid(on) {
    const v = !!on;
    if (v === this.showGrid) return this.showGrid;     // 没变就不惊动一帧（与 resetPan 同风格）
    this.showGrid = v;
    // 持久化走既有做法（读不到就回默认，见 readGridPref）；存不下也不影响本次会话
    writeGridPref(v);
    this.markDirty();
    return this.showGrid;
  }

  /**
   * 坐标读数的指针位置入口（**屏幕坐标**，相对画布左上角）。UI 层从 DOM 事件里取。
   * ⚠ 只在**读数文本真的会变**时才置脏：坐标取整后 1px 以内的抖动不改变画面，
   *   否则画布会退化成「鼠标一动就整帧重绘」。
   * ⚠ 非法数值（NaN / 非数）直接忽略：不崩、不抛（边界判据）。
   */
  setPointerScreen(x, y) {
    const px = Number(x), py = Number(y);
    if (!Number.isFinite(px) || !Number.isFinite(py)) return;
    const prev = this.pointerScreen;
    this.pointerScreen = { x: px, y: py };
    if (!this.showGrid) return;                        // 关着时读数不画，也就没必要重绘
    if (prev && this.coordText(prev.x, prev.y) === this.coordText(px, py)) return;
    this.markDirty();
  }

  /** 指针移动 ⇒ 更新读数（减掉画布在页面里的位置，得到**画布内**坐标）。 */
  _onPointerMove(ev) {
    if (!ev) return;
    const c = this.canvas;
    const r = c && typeof c.getBoundingClientRect === 'function' ? c.getBoundingClientRect() : null;
    this.setPointerScreen(ev.clientX - (r ? r.left : 0), ev.clientY - (r ? r.top : 0));
  }

  /**
   * 读数文本（**唯一真源**）：屏幕点 → 世界坐标**只走 `screenToWorld()`**。
   * ⚠ 这里手写 `(sx - pan.x) / zoom` 与它**数值逐位相同** ⇒ 只有「结构上不许有第二条
   *   式子」才防得住（`plans/17` ④.4 的数值路径盲区）。
   */
  coordText(sx, sy) {
    const w = this.screenToWorld(sx, sy);
    return `(${Math.round(w.x)}, ${Math.round(w.y)})`;
  }

  /**
   * 屏幕坐标（相对画布左上角）→ 世界坐标。**唯一的换算出口**。
   *
   * 为什么只留一个出口：命中检测、接线柱、放置、吸附全都吃世界坐标，任何一处
   * 自己写 `p.x - pan.x` 就等于多一个「看得见但点不中」的机会。交互层只许从
   * 这里取世界坐标（tools/pan-probe.mjs §③ 用一个只统计调用次数的探针把这条钉住）。
   *
   * ⚠ `window.__XM_PAN_OFF__` 与 `window.__XM_ZOOM_OFF__` 是**变异体回退开关**，
   *   只为「判据能红」而存在：前者返回原始屏幕坐标（退回「视口偏移不存在」），
   *   后者把 zoom 当 1（退回「画布没有缩放」）。正常运行时两个键都不存在，
   *   两个分支恒不成立。
   */
  screenToWorld(x, y) {
    if (typeof window !== 'undefined' && window.__XM_PAN_OFF__) return { x, y };
    const z = this._effZoom();
    return { x: (x - this.pan.x) / z, y: (y - this.pan.y) / z };
  }

  /** 生效的缩放（变异体开关置起时恒为 1）。
   *  ⚠ **绘制不走这里** —— 绘制用的是真实的 `this.zoom`，否则「换算与绘制不一致」
   *    这件事在绘制指令流里根本看不出来，红档就白做了（tools/gesture-probe.mjs §④）。 */
  _effZoom() {
    if (typeof window !== 'undefined' && window.__XM_ZOOM_OFF__) return 1;
    return this.zoom;
  }

  /**
   * 复位视口（回到原点）。返回是否真的动过 —— 调用方靠它决定要不要补一帧，
   * 不真动时连一次重绘都不惊动（平移量为 0 时零影响）。
   */
  resetPan() {
    if (this.pan.x === 0 && this.pan.y === 0) return false;
    this.pan.x = 0; this.pan.y = 0;
    this.markDirty();
    return true;
  }

  /**
   * 复位整个视口（pan + zoom 一起回原点）。**与 `resetPan()` 分开**：后者的语义是
   * 「只复位平移」，被双击空白处与既有探针消费，一个字节都不许改；需要整体复位
   * 的调用方用这个。返回是否真的动过（没动过就不惊动一帧）。
   */
  resetView() {
    if (this.pan.x === 0 && this.pan.y === 0 && this.zoom === 1) return false;
    this.pan.x = 0; this.pan.y = 0; this.zoom = 1;
    this.markDirty();
    return true;
  }

  /** 把 zoom 夹到 [ZOOM_MIN, ZOOM_MAX]。非有限值/非正值一律当 1（宁可不动，不许 NaN 进视口） */
  clampZoom(z) {
    if (!isFinite(z) || z <= 0) return 1;
    return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
  }

  /**
   * 以**屏幕点 (sx,sy) 为不动点**设缩放：该屏幕点下的世界点保持不动。
   * 「地图式缩放」的全部数学就是 `pan = s − zoom·w(s)` —— 缩放因此天然围绕手势中点，
   * 而不是画布左上角。返回是否真的变过。
   */
  zoomAt(z, sx, sy) {
    const z2 = this.clampZoom(z);
    if (z2 === this.zoom) return false;
    const w = this.screenToWorld(sx, sy);
    this.setViewAt(z2, w.x, w.y, sx, sy);
    this.markDirty();
    return true;
  }

  /**
   * 视口设置的**低层原语**：把世界点 (wx,wy) 钉在屏幕点 (sx,sy) 上，并设 zoom=z。
   * 这一条式子同时承担**捏合缩放**与**两指平移**：
   *   · 两指间距不变 ⇒ z 不变 ⇒ 退化成纯平移；
   *   · 两指中点不动 ⇒ 只剩缩放，且围绕中点。
   * ⚠ 本函数**不** `markDirty()`：它被手势的每一帧调用，要不要重绘由调用方判断
   *   （tools/gesture-probe.mjs §⑤ 会钉住「没变化的那一帧不置脏」）。
   */
  setViewAt(z, wx, wy, sx, sy) {
    const z2 = this.clampZoom(z);
    this.zoom = z2;
    this.pan.x = sx - wx * z2;
    this.pan.y = sy - wy * z2;
  }

  resize() {
    const r = this.canvas.getBoundingClientRect();
    this.dpr = typeof window === 'undefined' ? 1 : Math.min(window.devicePixelRatio || 1, 2);
    this.w = Math.max(1, r.width);
    this.h = Math.max(1, r.height);
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
    this._needsRender = true;      // 尺寸变了，台面渐变缓存按 (w,h) 失效
  }

  start() {
    this._last = performance.now();
    const tick = (now) => {
      this._raf = requestAnimationFrame(tick);
      this.frame(now);
    };
    this._raf = requestAnimationFrame(tick);
  }

  stop() { if (this._raf) cancelAnimationFrame(this._raf); this._raf = null; }

  /**
   * 设置速度档（B1）。传入任意正数都**吸附到最近的档** ⇒ `speed` 永远是合法档位
   * ⇒ 「当前档位可读」这条恒成立，不会出现 0.3× 这种不在档位表里、UI 也显示不出来的值。
   * 非正数/非有限值一律**保持原档**（返回原值），不静默改成 0（停了不动不是速度档）。
   */
  setSpeed(v) {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return this.speed;
    let best = this.speeds[0];
    for (const s of this.speeds) if (Math.abs(s - n) < Math.abs(best - n)) best = s;
    this.speed = best;
    return this.speed;
  }

  /** 档位文案（B1 的「档位可读」）：`1×` / `0.25×` —— 徽标与 toast 共用同一个来源 */
  speedLabel(v = this.speed) {
    const x = Number(v);
    if (!Number.isFinite(x)) return '—';
    return (Math.round(x * 100) / 100) + '×';
  }

  /**
   * 一帧：固定步长推进 + 脏检查后决定是否渲染（B1）
   * 暂停（world.running 为 false）且画面静止、又没有耦合流动时，整帧跳过重绘。
   */
  frame(now) {
    const raw = Math.min((now - this._last) / 1000, 0.12);
    this._last = now;

    // 固定步长推进
    this.acc += raw * this.speed;
    let n = 0;
    while (this.acc >= this.fixed && n < this.maxSteps) {
      this.world.step(this.fixed);
      this.acc -= this.fixed;
      n++;
    }
    if (n >= this.maxSteps) this.acc = 0;   // 防止追帧雪崩

    // app 通常由 UI 层注入（见 interact.js）。若交互插件被停用导致没人注入，
    // 就用 main.js 暴露的全局兜底 —— 否则 app._dirty（C10 的 markDirty 契约）
    // 没人读，暂停后改参数就不会重绘。
    if (!this.app && typeof window !== 'undefined') this.app = window.xiaomo || null;

    // 兜底：main.js 的 reset() / clearWires() 直接改世界而不发 SCENE_DIRTY，
    // 用两个 O(1) 的观测量发现"时间被归零 / 器材或导线数变了"，补一帧。
    const stamp = this.world.entities.length * 4096 + this.world.wires.length;
    if (this.world.time < this._lastTime || stamp !== this._sceneStamp) this._needsRender = true;
    this._lastTime = this.world.time;
    this._sceneStamp = stamp;

    // 有能量在跨域流动时，画面不是"静止"的 —— 本帧必须重绘
    const flowing = this.syncCoupling(raw);

    if (this.world.running || this._needsRender || flowing ||
        (this.app && this.app._dirty)) {
      this.render();
      this._needsRender = false;
      if (this.app) this.app._dirty = false;
    }

    // FPS 统计
    this._fpsAcc += raw; this._fpsN++;
    if (this._fpsAcc >= 0.5) {
      this.fps = Math.round(this._fpsN / this._fpsAcc);
      this._fpsAcc = 0; this._fpsN = 0;
      this.onFps?.(this.fps);
    }
  }


  // ══════════════════ 渲染 ══════════════════
  render() {
    const g = this.g;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    // ⚠ 清屏必须**紧贴 setTransform、早于平移**：clearRect 擦的是设备像素矩形，
    //   带着平移去擦只会擦掉一块错位区域、屏幕其余部分留下上一帧残影。
    //   顺序固定为 setTransform → clearRect → translate 还有一个好处：
    //   平移量为 0 时这条指令流与「没有平移功能」时逐位相同（tools/pan-probe.mjs §②）。
    g.clearRect(0, 0, this.w, this.h);
    // 视口：**先平移、再缩放** ⇒ 此后画在世界点 W 的东西落在屏幕 W×zoom + pan 上，
    // 与 `screenToWorld()` 严格互逆。画的一切（网格、导线、器材、端口、选中框、叠层）
    // 自动共用同一个视口。
    // ⚠ 顺序不能反：反过来是「平移量被缩放放大」，同一串世界坐标会落错屏幕位置。
    // ⚠ 两个恒等值都**不发指令**：pan 为零不发 translate、zoom 为 1 不发 scale。
    //   矩阵上它们是恒等，但记进绘制指令流就是一条真实差异 ——「pan=0 且 zoom=1 时
    //   逐位相同」是硬指标，靠这两句保住（tools/pan-probe.mjs §② 直接拿改动前的
    //   engine.js 对跑同一串指令）。
    if (this.pan.x || this.pan.y) g.translate(this.pan.x, this.pan.y);
    if (this.zoom !== 1) g.scale(this.zoom, this.zoom);

    this.drawBackdrop(g);
    // 网格与坐标读数：**同一个开关**（项④），所以两个调用点都不带条件 —— 判断在各自方法**入口**。
    // ⚠ 这样默认（开）时这条指令流与改动前逐字相同，关掉时也只是「两个方法直接 return」。
    this.drawGrid(g);
    this.drawCoords(g);

    const world = this.world;
    this.drawWires(g, world);
    world.render(g);
    this.drawPorts(g, world);
    this.drawSelection(g, world);

    for (const fn of this.overlays) {
      try { fn(g, this); } catch (e) { console.error('[overlay]', e); }
    }
  }

  drawBackdrop(g) {
    g.fillStyle = C.bg;
    g.fillRect(0, 0, this.w, this.h);

    // 台面：底部一层极淡的横向渐变，暗示"实验台"
    // B2：渐变按 (w,h) 缓存，不再每帧重建
    g.fillStyle = this.benchGradient();
    g.fillRect(0, 0, this.w, this.h);
  }

  /** 台面渐变：尺寸不变时复用同一个对象 */
  benchGradient() {
    if (this._benchGrd && this._grdW === this.w && this._grdH === this.h) return this._benchGrd;
    const grd = this.g.createLinearGradient(0, this.h * 0.55, 0, this.h);
    grd.addColorStop(0, 'rgba(255,255,255,0)');
    grd.addColorStop(1, 'rgba(255,255,255,.018)');
    this._benchGrd = grd;
    this._grdW = this.w; this._grdH = this.h;
    return grd;
  }


  drawGrid(g) {
    if (!this.showGrid) return;        // 项④：关掉时**一条网格指令都不发**，不是「画成透明」
    const s = this.gridSize;
    // 格距 ≤ 0 / NaN：直接不画。⚠ 不是「画得难看」那么轻 —— `for (…; x += s)` 在 s === 0 时
    // **死循环**（页面直接卡死），所以这条守卫必须挡在循环之前。
    if (!Number.isFinite(s) || !(s > 0)) return;
    // 世界坐标下的可见区 = (屏幕区 − pan) / zoom。这样网格线仍钉在世界格点上，
    // 拖动画布/缩放时是「视角在动」而不是「网格跟着屏幕滑」。
    // ⚠ 起手四舍五入到整格：省掉看不见的屏外线，也让端点落回世界格点。
    // ⚠ 2026-10-19 修正**平移方向**：原式 `Math.floor(this.pan.x / s) * s` 把可见区
    //   算成了 `[+pan, +pan+w]`，而真实可见区是 `[−pan, −pan+w]` ⇒ 平移量一偏离 0，
    //   屏幕两端就露出一条**没有网格**的带子，宽约 2·|pan|。实测（800×600 画布）：
    //   pan=(100,0) 网格只覆盖屏幕 x∈[196,1020]（左边 196px 全空）、
    //   pan=(−100,40) 覆盖 x∈[−220,604] 与 y∈[64,688]（右边与下边各空一截）。
    //   这条从来没有判据覆盖（pan-probe §② 只比 pan=0 的指令流）⇒ 现在按真实可见区算。
    //   「pan=0 且 zoom=1 时线段坐标与改动前逐位相同」仍然保住：此时 x0=0、x1=w+s。
    // ⚠ 末尾的 `|| 0` 只为消掉 `-0`：pan=0 时 `Math.floor(-0)` 给 -0，而 -0 会污染
    //   「逐位相同」的对照读数（数值相等、JSON 也相同，但字符串化后不是同一个字符）。
    const vw = this.w / this.zoom, vh = this.h / this.zoom;
    const x0 = (Math.floor(-this.pan.x / this.zoom / s) * s) || 0, x1 = x0 + vw + s;
    const y0 = (Math.floor(-this.pan.y / this.zoom / s) * s) || 0, y1 = y0 + vh + s;
    g.lineWidth = 1;
    g.strokeStyle = C.grid;
    g.beginPath();
    for (let x = x0; x <= x1; x += s) { g.moveTo(x + .5, y0); g.lineTo(x + .5, y1); }
    for (let y = y0; y <= y1; y += s) { g.moveTo(x0, y + .5); g.lineTo(x1, y + .5); }
    g.stroke();

    // 每 5 格一根稍亮的线
    g.strokeStyle = C.gridStrong;
    g.beginPath();
    for (let x = x0; x <= x1; x += s * 5) { g.moveTo(x + .5, y0); g.lineTo(x + .5, y1); }
    for (let y = y0; y <= y1; y += s * 5) { g.moveTo(x0, y + .5); g.lineTo(x1, y + .5); }
    g.stroke();
  }

  /**
   * 坐标读数（项④的第二半 —— 与网格**同一个开关**）。照 NB 的 `SHOW_COORDINATE`：
   * 命令名是「显示坐标」而显示名是「网格」⇒ 一根开关，两个效果。
   *
   * ⚠ 换算**只走 `screenToWorld()`**（经 `coordText()`），这里不许出现第二条 `pan`/`zoom` 式子。
   * ⚠ 画在**左下角**、字号除以 zoom ⇒ 屏幕上恒为 11px，缩放时不会跟着变大变小。
   * ⚠ 角点位置也用 `screenToWorld()` 求（屏幕原点附近那一点的世界坐标）⇒ 读数整块跟着
   *   同一个视口变换走，**不需要**再写一条反向式子（反向式子正是 `plans/17` ④.4 点名的盲区）。
   */
  drawCoords(g) {
    if (!this.showGrid || !this.pointerScreen) return;
    const at = this.screenToWorld(10, this.h - 10);
    g.font = `${11 / this.zoom}px ui-monospace, SFMono-Regular, Menlo, monospace`;
    g.fillStyle = C.gridStrong;
    g.fillText(this.coordText(this.pointerScreen.x, this.pointerScreen.y), at.x, at.y);
  }

  drawWires(g, world) {
    for (const w of world.wires) {
      const ea = world.get(w.a.e), eb = world.get(w.b.e);
      if (!ea || !eb) continue;
      const p1 = ea.portWorldAt(w.a.p), p2 = eb.portWorldAt(w.b.p);
      if (!p1 || !p2) continue;

      const live = w.state?.live;
      const cur = w.state?.current || 0;
      const kind = w.kind;

      // 导管画成双线，电线画成单线
      if (kind === 'tube') {
        this.drawTube(g, p1, p2, w);
        continue;
      }
      if (kind === 'probe') {
        this.drawProbe(g, p1, p2, w);
        continue;
      }

      const sag = Math.min(34, Math.hypot(p2.x - p1.x, p2.y - p1.y) * 0.20);
      const mx = (p1.x + p2.x) / 2, my = (p1.y + p2.y) / 2 + sag;

      // 外发光（通电时）
      if (live && Math.abs(cur) > 1e-4) {
        const a = Math.min(0.55, 0.18 + Math.abs(cur) * 6);
        g.strokeStyle = `rgba(255,209,102,${a})`;
        g.lineWidth = 5.5;
        g.lineCap = 'round';
        g.beginPath();
        g.moveTo(p1.x, p1.y);
        g.quadraticCurveTo(mx, my, p2.x, p2.y);
        g.stroke();
      }

      g.strokeStyle = live && Math.abs(cur) > 1e-4 ? C.wireHot : C.wire;
      g.lineWidth = 2.2;
      g.lineCap = 'round';
      g.setLineDash(EMPTY_DASH);
      g.lineDashOffset = 0;
      g.beginPath();
      g.moveTo(p1.x, p1.y);
      g.quadraticCurveTo(mx, my, p2.x, p2.y);
      g.stroke();

      // B6：跨域耦合的流动线索（复用上面这条已建好的路径，不新建渐变/字符串）
      const flow = this._flow.get(w.id);
      if (flow) this.strokeFlow(g, flow, 3.4);

      // 电流方向小箭头
      if (live && Math.abs(cur) > 1e-3) {
        const t = 0.5;
        const qx = (1 - t) ** 2 * p1.x + 2 * (1 - t) * t * mx + t * t * p2.x;
        const qy = (1 - t) ** 2 * p1.y + 2 * (1 - t) * t * my + t * t * p2.y;
        const dx = 2 * (1 - t) * (mx - p1.x) + 2 * t * (p2.x - mx);
        const dy = 2 * (1 - t) * (my - p1.y) + 2 * t * (p2.y - my);
        const ang = Math.atan2(dy, dx) + (cur < 0 ? Math.PI : 0);
        g.save();
        g.translate(qx, qy); g.rotate(ang);
        g.fillStyle = C.wireHot;
        g.beginPath();
        g.moveTo(4, 0); g.lineTo(-3, -3.2); g.lineTo(-3, 3.2);
        g.closePath(); g.fill();
        g.restore();
      }
    }
  }

  drawTube(g, p1, p2, w) {
    const sag = Math.min(26, Math.hypot(p2.x - p1.x, p2.y - p1.y) * 0.16);
    const mx = (p1.x + p2.x) / 2, my = (p1.y + p2.y) / 2 + sag;
    g.lineCap = 'round';
    g.strokeStyle = 'rgba(180,200,215,.30)';
    g.lineWidth = 5;
    g.beginPath(); g.moveTo(p1.x, p1.y); g.quadraticCurveTo(mx, my, p2.x, p2.y); g.stroke();
    g.strokeStyle = 'rgba(220,235,245,.55)';
    g.lineWidth = 2;
    g.beginPath(); g.moveTo(p1.x, p1.y); g.quadraticCurveTo(mx, my, p2.x, p2.y); g.stroke();
  }

  drawProbe(g, p1, p2, w) {
    g.strokeStyle = 'rgba(167,139,250,.75)';
    g.lineWidth = 1.8;
    g.setLineDash(PROBE_DASH);
    g.beginPath(); g.moveTo(p1.x, p1.y); g.lineTo(p2.x, p2.y); g.stroke();
    g.setLineDash(EMPTY_DASH);

    // B6：探头连线 =「探头插进容器」这条跨域链路，方向跟随能量方向
    const flow = this._flow.get(w.id);
    if (flow) {
      g.beginPath(); g.moveTo(p1.x, p1.y); g.lineTo(p2.x, p2.y);
      this.strokeFlow(g, flow, 2.6);
    }
  }

  /**
   * 沿当前路径再画一次「能量在流动」的高光虚线。
   * 相位由 syncCoupling 用真实 dt 累加；颜色档位在主题切换时预生成，
   * 因此绘制循环里既不拼字符串也不建渐变；减少动态效果时退化为静态高亮。
   */
  strokeFlow(g, f, width) {
    g.strokeStyle = this._tints[Math.min(FLOW_TINT_MAX, (f.level * FLOW_TINT_MAX + 0.5) | 0)];
    g.lineWidth = width;
    g.setLineDash(FLOW_DASH);
    g.lineDashOffset = f.moving ? -f.phase : 0;
    g.stroke();
    g.setLineDash(EMPTY_DASH);
    g.lineDashOffset = 0;
  }


  /**
   * 接线柱的**唯一**语义渲染处（`tools/port-affordance-probe.mjs` 的渲染类断言都打在这里）。
   *
   * 谁画、谁不画：插件的 `dot()`（`src/equipment/electronics.js` 的美工端子）画的是**器材外观**
   *   —— 固定半径 2.6、没有热态、也不知道 `kind`；交互标记（半径随档位、热态光环、标签、
   *   `kind` 区分）**只由这里画**。两者的关系由探针钉住：同一器材渲染一次，
   *   美工端子那笔（2.6）与交互标记那笔（`PORT_R_FINE.wire`/`hot`）是**两笔不同的绘制**，
   *   而且 `hotPort` 只影响后者（前者逐位不变）。
   *
   * `kind` 分两种语义：`wire` 能接线；其余（各容器的「插入口」）是**只读**的。画成同一种圆点，
   *   用户会以为插入口也是电接线柱 ⇒ 这里用**实心圆 / 空心方**把两类分开。
   */
  drawPorts(g, world) {
    const hot = this.hotPort;
    // ⚠ 视觉档位与交互层的**命中**档位读同一条媒体查询（`COARSE_MQ`）。取 `(pointer: coarse)`
    //   而不是 `(any-pointer: coarse)`：这里改的是**看得见的外观**（半径/光环/标签）——
    //   `styles/touch.css` 与 `plans/07-触控适配.md` 立的分类是「不可见改动挂 any-pointer、
    //   看得见改动挂 pointer」；细指针那一档与改动前逐位相同（放大的只有手指那一档）。
    const R = coarsePointer() ? PORT_R_COARSE : PORT_R_FINE;
    // B3：渲染前一次性收集"已被占用的端口"，循环内只查表
    //（原来是每个端口都扫一遍全部导线，O(器材 × 端口 × 导线)）
    const usedBy = new Map();
    for (const wr of world.wires) {
      let sa = usedBy.get(wr.a.e);
      if (!sa) usedBy.set(wr.a.e, sa = new Set());
      sa.add(wr.a.p);
      let sb = usedBy.get(wr.b.e);
      if (!sb) usedBy.set(wr.b.e, sb = new Set());
      sb.add(wr.b.p);
    }
    for (const e of world.entities) {
      const usedEnt = usedBy.get(e.id);
      for (let i = 0; i < e.ports.length; i++) {
        const port = e.ports[i];
        const wpt = e.portWorldAt(i);
        const isHot = hot && hot.ent === e && hot.port === i;
        const used = !!usedEnt && usedEnt.has(i);
        const isWire = (port.kind || 'wire') === 'wire';
        const r = isHot ? R.hot : (isWire ? R.wire : R.probe);

        if (isWire) {
          g.beginPath();
          g.arc(wpt.x, wpt.y, r, 0, Math.PI * 2);
          g.fillStyle = isHot ? C.portHot : (used ? '#5a6672' : C.port);
          g.fill();
        } else {
          // 只读端口（插入口 / 管口 / 瓶口）：空心方，一眼与电路接线柱区分
          g.beginPath();
          g.rect(wpt.x - r, wpt.y - r, r * 2, r * 2);
          g.strokeStyle = isHot ? C.portHot : '#8d96a0';
          g.lineWidth = 1.4;
          g.stroke();
        }
        if (isHot) {
          g.strokeStyle = isWire ? 'rgba(45,212,191,.45)' : 'rgba(255,209,102,.5)';
          g.lineWidth = 2;
          g.beginPath(); g.arc(wpt.x, wpt.y, R.halo, 0, Math.PI * 2); g.stroke();
        }
        // 标签：高亮的那一个一定画（用户正在选它）；粗指针下"选中的器材"把接线柱标签全亮出来
        // —— 手指看不见标签就只能靠试，这是「不好对准」的另一半。
        if (port.label && (isHot || (R === PORT_R_COARSE && isWire && e.selected))) {
          this.drawPortLabel(g, wpt, port.label, isHot, R.label);
        }
      }
    }
  }

  /**
   * 端口标签（高亮 / 粗指针可见化用）。
   * ⚠ **不许用 `measureText`**：探针的假 ctx 把它做成空实现（返回 undefined），
   *   取 `.width` 会当场抛异常 —— 一个"只是画个标签"的改动会让整套探针崩在渲染里。
   *   所以宽度按定值估：汉字约 1em、拉丁约 0.6em，这里取偏宽的一档。
   */
  drawPortLabel(g, at, text, isHot, size) {
    const w = text.length * size * 0.78 + 6;
    const h = size + 4;
    const top = at.y - size * 1.6 - h;
    g.fillStyle = 'rgba(13,17,23,.78)';
    g.fillRect(at.x - w / 2, top, w, h);
    g.fillStyle = isHot ? C.portHot : '#c9d4de';
    g.font = size + 'px ui-sans-serif, system-ui, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(text, at.x, top + h / 2);
  }

  drawSelection(g, world) {
    for (const e of world.entities) {
      if (!e.selected && !e.hovered) continue;
      const b = e.bounds();
      const pad = 5;
      g.strokeStyle = e.selected ? C.select : 'rgba(255,255,255,.22)';
      g.lineWidth = e.selected ? 1.6 : 1;
      if (!e.selected) g.setLineDash([4, 3]);
      this.roundRect(g, b.x - pad, b.y - pad, b.w + pad * 2, b.h + pad * 2, 8);
      g.stroke();
      g.setLineDash([]);
    }
  }

  roundRect(g, x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    g.beginPath();
    g.moveTo(x + rr, y);
    g.arcTo(x + w, y, x + w, y + h, rr);
    g.arcTo(x + w, y + h, x, y + h, rr);
    g.arcTo(x, y + h, x, y, rr);
    g.arcTo(x, y, x + w, y, rr);
    g.closePath();
  }

  // ══════════════════ 跨域耦合的流动线索（B6） ══════════════════
  /**
   * 每帧用真实 dt 算出「哪几条线正在搬运能量」：
   *   · 是否活跃与能量方向来自耦合总线 —— 溶液支路 = 电→化学、
   *     原电池 = 化学→电、电热丝/电动机 = 电→热 / 电→机械
   *   · 流动速度与亮度只由真实物理量决定（该支路电流 |I|、功率 P），
   *     所以「电流大 = 流得快、亮得明显」本身就是可读的信息
   *   · 相位是随 dt 累加的标量（每条线一份），不新建计时器
   * 返回 true 表示本帧存在可见流动 —— 有流动就必须继续重绘。
   */
  syncCoupling(dt) {
    // 耦合总线在 main.js 里晚于引擎创建，从注入的 app 上补拿一次
    if (!this.coupling && this.app) this.coupling = this.app.coupling || null;

    const seeds = this._couplingSeeds();
    const reach = this._reachFrom(seeds);
    const flow = this._flow;
    const moving = !this.reducedMotion;
    const tick = this._flowTick + 1;
    this._flowTick = tick;
    let sig = seeds.size * 7919 + reach.size;
    let live = 0;

    for (const w of this.world.wires) {
      let level = 0, dir = 1, seed = null, seedIsA = false;

      if (w.kind === 'wire') {
        const cur = (w.state && w.state.current) || 0;
        // 只有落在活跃耦合回路上的电线才参与，独立电路不抢戏
        if (cur !== 0 && (reach.has(w.a.e) || reach.has(w.b.e))) {
          level = this._levelFromI(Math.abs(cur));
          dir = cur < 0 ? -1 : 1;      // 与既有的电流方向箭头同一套符号
        }
      } else if (w.kind === 'probe') {
        const sa = seeds.get(w.a.e), sb = seeds.get(w.b.e);
        if (sa && (!sb || sa.level >= sb.level)) { seed = sa; seedIsA = true; }
        else if (sb) { seed = sb; seedIsA = false; }
        if (seed) {
          level = seed.level;
          // seed.dir = +1 表示能量从电路侧送进容器（电→化学/热）；
          // 沿 a→b 画线时方向随端别翻转，因此与能量方向一致
          dir = ((seed.dir > 0) === seedIsA) ? 1 : -1;
        }
      }
      if (level <= 0) continue;

      let f = flow.get(w.id);
      if (!f) { f = { phase: 0, level: 0, dir: 1, speed: 0, moving, tick: 0 }; flow.set(w.id, f); }
      f.level = level;
      f.dir = dir;
      f.moving = moving;
      f.speed = FLOW_SPEED_MIN + (FLOW_SPEED_MAX - FLOW_SPEED_MIN) * level;
      f.tick = tick;
      if (moving) {
        f.phase += dt * f.speed * dir;
        // 取模，避免长时间累加丢精度
        if (f.phase > FLOW_DASH_PERIOD) f.phase -= FLOW_DASH_PERIOD;
        else if (f.phase < -FLOW_DASH_PERIOD) f.phase += FLOW_DASH_PERIOD;
      } else {
        f.phase = 0;                   // 减少动态效果：只留静态高亮
      }
      sig += (dir + 2) * 977 + ((level * 99) | 0);
      live++;
    }

    // 已经不再流动的线立刻退出（耦合一停就没有残余动画）
    if (flow.size) flow.forEach((f, id) => { if (f.tick !== tick) flow.delete(id); });

    // 流动集合变化时补一帧：暂停、或减少动态效果下的静态高亮都靠它
    if (sig !== this._flowSig) { this._flowSig = sig; this._needsRender = true; }

    return moving && live > 0;
  }

  /** 活跃耦合的"种子"器材：能量从这些器材出发或汇入 */
  _couplingSeeds() {
    const m = new Map();
    const br = this.coupling && this.coupling.branches;
    if (br) {
      for (const b of br) {
        const st = b.state || {};
        const level = this._levelFromI(Math.abs(st.I || 0));
        if (level <= 0) continue;
        const dir = b.tag === 'galvanic' ? -1 : 1;   // 原电池是化学→电，方向相反
        this._seed(m, b.a && b.a.e, level, dir);
        this._seed(m, b.b && b.b.e, level, dir);
      }
    }
    // 电热丝 / 电动机：功率落在器材自己的 state 上（电→热、电→机械）
    for (const e of this.world.entities) {
      if (e.probe && e.probe.kind === 'heater') {
        this._seed(m, e.id, this._levelFromP(e.state.heatOut || 0), 1);
      } else if (e.type === 'motor' && e.state.on && e.state.stirTarget) {
        this._seed(m, e.id, this._levelFromI(Math.abs(e.state.I || 0)), 1);
      }
    }
    return m;
  }

  _seed(m, id, level, dir) {
    if (!id || !(level > 0)) return;
    const old = m.get(id);
    if (!old || level > old.level) m.set(id, { level, dir });
  }

  /** BFS：沿电线找出与活跃耦合器材电连通的所有器材 */
  _reachFrom(seeds) {
    const reach = this._flowReach;
    reach.clear();
    if (!seeds.size) return reach;
    const adj = new Map();
    for (const w of this.world.wires) {
      if (w.kind !== 'wire') continue;
      let l = adj.get(w.a.e);
      if (!l) adj.set(w.a.e, l = []);
      l.push(w.b.e);
      l = adj.get(w.b.e);
      if (!l) adj.set(w.b.e, l = []);
      l.push(w.a.e);
    }
    const queue = [];
    seeds.forEach((_s, id) => { reach.add(id); queue.push(id); });
    while (queue.length) {
      const nb = adj.get(queue.pop());
      if (!nb) continue;
      for (const id of nb) if (!reach.has(id)) { reach.add(id); queue.push(id); }
    }
    return reach;
  }

  /** |I| → 0..1（开方压缩：mA 级电流也看得见，0.2 A 满格） */
  _levelFromI(I) {
    return I > FLOW_MIN_I ? Math.min(1, Math.sqrt(I / FLOW_I_REF)) : 0;
  }

  /** P → 0..1（4 W 满格） */
  _levelFromP(P) {
    return P > 0 ? Math.min(1, Math.sqrt(P / FLOW_P_REF)) : 0;
  }

  /** 流动高光的亮度档位：在主题切换时预生成，绘制循环里不再拼颜色字符串 */
  _rebuildFlowTints() {
    const rgb = hexRGB(C.bridge);
    const out = [];
    for (let i = 0; i <= FLOW_TINT_MAX; i++) {
      const a = (0.30 + 0.62 * (i / FLOW_TINT_MAX)).toFixed(2);
      out.push(`rgba(${rgb[0]},${rgb[1]},${rgb[2]},${a})`);
    }
    this._tints = out;
  }
}
