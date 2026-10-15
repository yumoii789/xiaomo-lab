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

export class Engine {
  constructor(canvas, world) {
    this.canvas = canvas;
    this.g = canvas.getContext('2d');
    this.world = world;

    this.w = 0; this.h = 0; this.dpr = 1;
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
    g.clearRect(0, 0, this.w, this.h);

    this.drawBackdrop(g);
    this.drawGrid(g);

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
    const s = this.gridSize;
    g.lineWidth = 1;
    g.strokeStyle = C.grid;
    g.beginPath();
    for (let x = 0; x <= this.w; x += s) { g.moveTo(x + .5, 0); g.lineTo(x + .5, this.h); }
    for (let y = 0; y <= this.h; y += s) { g.moveTo(0, y + .5); g.lineTo(this.w, y + .5); }
    g.stroke();

    // 每 5 格一根稍亮的线
    g.strokeStyle = C.gridStrong;
    g.beginPath();
    for (let x = 0; x <= this.w; x += s * 5) { g.moveTo(x + .5, 0); g.lineTo(x + .5, this.h); }
    for (let y = 0; y <= this.h; y += s * 5) { g.moveTo(0, y + .5); g.lineTo(this.w, y + .5); }
    g.stroke();
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


  drawPorts(g, world) {
    const hot = this.hotPort;
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
        const wpt = e.portWorldAt(i);
        const isHot = hot && hot.ent === e && hot.port === i;
        const used = !!usedEnt && usedEnt.has(i);

        const r = isHot ? 5 : 3.4;
        g.beginPath();
        g.arc(wpt.x, wpt.y, r, 0, Math.PI * 2);
        g.fillStyle = isHot ? C.portHot : (used ? '#5a6672' : C.port);
        g.fill();
        if (isHot) {
          g.strokeStyle = 'rgba(45,212,191,.45)';
          g.lineWidth = 2;
          g.beginPath(); g.arc(wpt.x, wpt.y, 10, 0, Math.PI * 2); g.stroke();
        }
      }
    }
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
