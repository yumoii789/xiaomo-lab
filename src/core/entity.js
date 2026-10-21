// ══════════════════════════════════════════════════════════
// Entity —— 所有实验器材的统一基类
//
// 设计要点（这是整个实验室的地基）：
//   · 一件器材 = 几何(body) + 接线柱(ports) + 参数(props) + 运行时状态(state)
//   · 物理器材靠 ports 接线成电路；化学器材靠 ports 插导管/电极
//   · 两域共用同一个 Entity，所以「物理器材直接插进化学容器」是天然支持的
//   · step() 每帧演化，render() 只负责画
// ══════════════════════════════════════════════════════════

let _seq = 0;
export const nextId = (p = 'e') => p + (++_seq);
export const resetIdSeq = () => { _seq = 0; };

/**
 * 按值克隆 state 模板 —— 数组与**纯对象**逐层复制，别的一律按引用保留。
 *
 * 为什么必须深：`Object.assign({}, def.state)` 是浅拷贝，凡在 def.state 里写
 * `buf: []` / `raster: { times: [], values: [] }` 的器材，**所有实例共用同一个数组/对象** ——
 * 摆两台示波器，波形会合进同一个缓冲区（判据见 tools/instance-isolation-probe.mjs，
 * 改前实测 10 / 117 件器材中招且串台可观察）。
 *
 * 为什么只认「数组 + 纯对象」：函数、类实例、Date/Map 这类东西若出现在 state 里，
 * 它的语义就是**共享**的（如 world 回指、注册表查表）；把它们也复制一份才是错的。
 * 顶层对象本来就每次新建（原写法也是），所以这里不改变 state 的键集合与形状。
 */
function cloneState(src) {
  if (Array.isArray(src)) return src.map(cloneState);
  if (src === null || typeof src !== 'object') return src;
  const proto = Object.getPrototypeOf(src);
  if (proto !== Object.prototype && proto !== null) return src;
  const out = {};
  for (const k of Object.keys(src)) out[k] = cloneState(src[k]);
  return out;
}

export class Entity {
  /**
   * @param {object} def   器材定义（来自 registry）
   * @param {number} x     实验台坐标（中心）
   * @param {number} y
   */
  constructor(def, x = 0, y = 0) {
    this.id = nextId();
    this.type = def.type;
    this.def = def;

    this.x = x;
    this.y = y;
    this.rot = 0;
    this.w = def.w || 64;
    this.h = def.h || 64;

    /** 可调参数（出现在右侧属性面板） */
    this.props = Object.assign({}, def.defaults);
    /** 运行时状态（不序列化进 props 的那部分）；**每台本体自有**，不与 def.state 共享数组/对象 */
    this.state = cloneState(def.state);

    /** 接线柱：坐标相对实体中心 */
    this.ports = (def.ports || []).map((p, i) => ({
      x: p.x, y: p.y, label: p.label || '', kind: p.kind || 'wire', i,
    }));

    this.selected = false;
    this.hovered = false;
    this.alive = true;
    /**
     * 逐件锁定（task-26 项①）：用户把**这一件**钉在台面上，拖动入口不再接管它的位移。
     * 与 selected / hovered 同类 —— **每台本体自有**的布尔位，不是 def 上的属性。
     * ⚠ 位移规则**不在这里**：判定写在拖动入口（`src/ui/interact.js` 的 `onDown`，
     *   全项目唯一把用户手势变成 `ent` 位移的地方）。写成「拖完再夹回原位」终值一样，
     *   但器材会跟着手指抖、还会多一条 move 撤销记录（`tools/lock-readout-probe.mjs` §① 钉住这个次序）。
     * ⚠ 写入口只此一处 `setLocked()`：能力位动作（`caps.js` 的 `applyCap`）与存档回填都走它。
     */
    this.locked = false;
  }

  /** 锁定 / 解锁的唯一写入口；返回**是否真的变了**（重复设同值不算变化） */
  setLocked(v) {
    const next = v === true;
    if (this.locked === next) return false;
    this.locked = next;
    return true;
  }

  get domain() { return this.def.domain; }
  get name() { return this.def.name; }
  get icon() { return this.def.icon; }
  get cat() { return this.def.cat; }

  // ─── 几何 ────────────────────────────────────────────────
  /** 接线柱的世界坐标（跟随旋转） */
  portWorld(p) {
    const c = Math.cos(this.rot), s = Math.sin(this.rot);
    return { x: this.x + p.x * c - p.y * s, y: this.y + p.x * s + p.y * c };
  }
  portWorldAt(i) {
    const p = this.ports[i];
    return p ? this.portWorld(p) : null;
  }

  /** 点在不在器材上（把点逆旋转回局部坐标判断） */
  hitTest(px, py) {
    const c = Math.cos(-this.rot), s = Math.sin(-this.rot);
    const dx = px - this.x, dy = py - this.y;
    const lx = dx * c - dy * s;
    const ly = dx * s + dy * c;
    return Math.abs(lx) <= this.w / 2 && Math.abs(ly) <= this.h / 2;
  }

  /** 命中最近的接线柱，返回端口索引或 -1 */
  hitPort(px, py, tol = 11) {
    let best = -1, bd = tol * tol;
    for (let i = 0; i < this.ports.length; i++) {
      const w = this.portWorldAt(i);
      const d = (w.x - px) ** 2 + (w.y - py) ** 2;
      if (d <= bd) { bd = d; best = i; }
    }
    return best;
  }

  /** 世界坐标包围盒（旋转后的外接矩形） */
  bounds() {
    const c = Math.abs(Math.cos(this.rot)), s = Math.abs(Math.sin(this.rot));
    const hw = (this.w * c + this.h * s) / 2;
    const hh = (this.w * s + this.h * c) / 2;
    return { x: this.x - hw, y: this.y - hh, w: hw * 2, h: hh * 2 };
  }

  /** 内容区域中心（用于把别的器材放进来时判断） */
  center() { return { x: this.x, y: this.y }; }

  // ─── 参数 ────────────────────────────────────────────────
  setProp(k, v) {
    const old = this.props[k];
    this.props[k] = v;
    this.onProp?.(k, v, old);
    // 撤销栈（C9）：只在「有栈 + 未挂起 + 值真的变了」时记一条**用户动作**
    // —— 记的是"把 k 从 old 改成 v"这件事，**不是** `this.props` 的快照 ✗
    // （快照会把求解器注入的 state 也卷进来，且会被下一帧覆盖）。
    const u = this.world && this.world.undo;
    // ⚠ 这里**不**自己判 `isSilent()`：闸门只该有一处（`UndoStack.push`）——
    // 两处判断会让"被拒收"的计数失真，也会让静默语义出现两个真源。
    if (u && old !== v) {
      u.push({
        kind: 'prop', label: `改参数 ${k}`, ent: this,
        undo: () => this.setProp(k, old),
        redo: () => this.setProp(k, v),
      });
    }
  }
  getProp(k) { return this.props[k]; }

  // ─── 生命周期钩子（子类按需实现） ────────────────────────
  onAdd(world) {}
  onRemove(world) {}
  onProp(k, v, old) {}
  /** 每帧演化；world 提供跨器材查询能力 */
  step(dt, world) {}
  /** 绘制；坐标系已 translate 到中心并 rotate，原点在器材中心 */
  render(g, world) {}

  // ─── 序列化 ──────────────────────────────────────────────
  /**
   * ⚠ task-26 存档决策（**甲：扩白名单**，而不是「锁定不持久」）：
   *   锁定是**用户显式意图**（用户当面锁过它）—— 存档 → 读档之后凭空解锁，比存档多一个
   *   可选字段的兼容成本更糟（`plans/17` 项① 第⑥栏的推荐同判）。
   *   写法上只做**加法且缺省即不写**：`locked` 为假时**根本不出现这个键** ⇒
   *   旧存档逐字不变、本文件 `loadJSON` 的「缺省即不覆盖」语义也原封不动 ⇒ 向后兼容零成本。
   *   判据：`tools/lock-readout-probe.mjs` §⑦（未锁定的器材 toJSON 键集合与改动前逐字相同、
   *   锁定的多出且只有 `locked:true` 一个键、读回后仍是锁定态）。
   */
  toJSON() {
    return {
      type: this.type, x: this.x, y: this.y, rot: this.rot,
      props: { ...this.props },
      state: this.serializeState ? this.serializeState() : undefined,
      ...(this.locked ? { locked: true } : {}),
    };
  }
  loadJSON(o) {
    this.x = o.x; this.y = o.y; this.rot = o.rot || 0;
    Object.assign(this.props, o.props || {});
    if (o.state) this.deserializeState?.(o.state);
    // 只认 `=== true`：旧存档没有这个键 ⇒ **不覆盖**（与上面「缺省即不覆盖」同一条纪律）
    if (o.locked === true) this.setLocked(true);
  }
}

// ─── 绘制热路径的缓存（C15，纯性能：不改变任何绘制结果） ──
/** 每个画布上下文当前已生效的字体串，避免重复赋值 */
const FONT_OF = new WeakMap();

/**
 * 单槽渐变缓存：key 不变就复用上一帧的 CanvasGradient 对象。
 * key 里必须含「几何尺寸 + 用到的颜色」，并且绑定创建它的上下文
 * —— 画布尺寸变化会重建上下文，此时旧渐变必须作废。
 */
export function grad1(owner, slot, g, key, make) {
  let c = owner[slot];
  if (!c || c.key !== key || c.ctx !== g) {
    c = { key, ctx: g, g: make() };
    owner[slot] = c;
  }
  return c.g;
}

// ══════════════════════════════════════════════════════════
// 损坏装饰（C16）
//
// 器材坏掉之后本体上要看得见。这里只提供「画法」，判定与驱动
// 一律由渲染处读取 state.broken 完成，不碰任何仿真语义。
//
// 所有装饰的形状都由器材 id 派生的确定性随机数生成：同一件器材
// 每帧画出的裂纹/焦痕逐像素一致，不会抖动（列车时刻表式稳定）。
// ══════════════════════════════════════════════════════════

/** FNV-1a：把器材 id 散列成 32 位种子 */
function hash32(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/** mulberry32：同一 seed 永远给出同一串 [0,1) */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SOOT = '26,20,16';

export const dmg = {
  /** 这件器材坏了吗（唯一的判定入口，只读 state） */
  of(e) { return !!(e && e.state && e.state.broken); },

  /** 确定性随机源；salt 给同一件器材的不同装饰分支分流 */
  rand(e, salt = 0) { return rng(hash32(String(e.id)) ^ Math.imul(salt + 1, 0x9e3779b1)); },

  /** 焦痕：几层不规则黑斑（r 为半径，k 调浓淡） */
  soot(g, x, y, r, next, k = 1) {
    g.save();
    for (let i = 0; i < 3; i++) {
      const rr = r * (1 - i * 0.26) * (0.72 + next() * 0.5);
      g.beginPath();
      g.arc(x + (next() - 0.5) * r * 0.9, y + (next() - 0.5) * r * 0.9, rr, 0, Math.PI * 2);
      g.fillStyle = `rgba(${SOOT},${(0.3 - i * 0.08) * k})`;
      g.fill();
    }
    g.restore();
  },

  /** 裂纹：从 (x,y) 放射出 n 条折线，折向由 next 决定 */
  cracks(g, x, y, n, len, next) {
    const lines = [];
    for (let i = 0; i < n; i++) {
      let a = (i / n) * Math.PI * 2 + next() * 1.1;
      let px = x, py = y;
      const line = [[px, py]];
      const segs = 2 + Math.floor(next() * 3);
      const l = len * (0.5 + next() * 0.8);
      for (let s = 0; s < segs; s++) {
        a += (next() - 0.5) * 1.05;
        px += Math.cos(a) * l / segs;
        py += Math.sin(a) * l / segs;
        line.push([px, py]);
      }
      lines.push(line);
    }
    g.save();
    g.lineCap = 'round';
    // 先深后浅：深色描边给裂纹一点厚度，浅色才是玻璃断口
    for (const [color, lw, off] of [['rgba(10,18,26,.5)', 2.6, 0], ['rgba(238,248,255,.85)', 1.2, 0.6]]) {
      g.strokeStyle = color; g.lineWidth = lw;
      g.translate(off, off);
      for (const line of lines) {
        g.beginPath();
        for (let i = 0; i < line.length; i++) {
          i ? g.lineTo(line[i][0], line[i][1]) : g.moveTo(line[i][0], line[i][1]);
        }
        g.stroke();
      }
    }
    g.restore();
  },

  /** 破口：一块不规则暗色缺口 */
  chip(g, x, y, r, next) {
    g.beginPath();
    g.moveTo(x - r, y);
    g.lineTo(x - r * 0.3, y + r * 0.25);
    g.lineTo(x + r * 0.2, y - r * (0.35 + next() * 0.45));
    g.lineTo(x + r, y + r * 0.12);
    g.closePath();
    g.fillStyle = 'rgba(10,18,26,.55)';
    g.fill();
  },
};

// ══════════════════════════════════════════════════════════
// 绘制小工具（Canvas 2D 没有内建圆角、文字对齐等）
// ══════════════════════════════════════════════════════════
export const gfx = {
  rr(g, x, y, w, h, r) {
    const rr = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
    g.beginPath();
    g.moveTo(x + rr, y);
    g.arcTo(x + w, y, x + w, y + h, rr);
    g.arcTo(x + w, y + h, x, y + h, rr);
    g.arcTo(x, y + h, x, y, rr);
    g.arcTo(x, y, x + w, y, rr);
    g.closePath();
  },
  fillRR(g, x, y, w, h, r, fill) { gfx.rr(g, x, y, w, h, r); g.fillStyle = fill; g.fill(); },
  strokeRR(g, x, y, w, h, r, stroke, lw = 1) {
    gfx.rr(g, x, y, w, h, r); g.strokeStyle = stroke; g.lineWidth = lw; g.stroke();
  },
  text(g, s, x, y, { color = '#e6edf3', size = 11, align = 'center', base = 'middle', weight = '' } = {}) {
    // 字体字符串在整帧里高度重复，先比后设（Canvas 每次赋值 font 都要重新解析字体）
    const font = `${weight ? weight + ' ' : ''}${size}px -apple-system,'Segoe UI','Microsoft YaHei',sans-serif`;
    if (FONT_OF.get(g) !== font) { g.font = font; FONT_OF.set(g, font); }
    g.fillStyle = color;
    g.textAlign = align;
    g.textBaseline = base;
    g.fillText(s, x, y);
  },
  /** 圆角矩形裁剪出「液体」区域 */
  clipRR(g, x, y, w, h, r) { gfx.rr(g, x, y, w, h, r); g.clip(); },
};
