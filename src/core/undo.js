// ══════════════════════════════════════════════════════════
// UndoStack —— 撤销 / 重做 **骨架**（C9 (b)）
//
// ⚠ 先拆一个头号陷阱：`app.markDirty()` **不是**操作栈 ✗。
//   它只是重绘脏标记（`main.js:246`、`engine.js:99`），名字像"操作脏了"而已。
//   「历史」与「重绘」是两件事，本文件只管前者。
//
// 口径（本骨架的核心决定，逐条都有理由）：
//   · 栈里存「**用户动作**」= 一对 `{ undo, redo }`，**不是状态快照** ✗。
//     `Meter.state.reading` / `Lamp.filamentTemp` 这类量是**算出来的**
//     （求解器每帧注入 / 热积分每步演化）⇒ 快照它们既冗余、又会被下一帧覆盖。
//   · 只有登记为**可逆**的动作种类能入栈（`OP_KINDS`，**这张表是承重的** ✗：
//     `push()` 会拒收未登记与标记不可逆的种类）。
//   · 撤销 / 重做**自身**执行时挂起记录 ✗ —— 否则逆动作会再记一条 ⇒ 栈自噬。
//
// 与 UI 的关系（**有意分层**）：本骨架可被程序化调用、可被探针证明；
//   面板上的撤销按钮归 `ui/**` 的写者（下一轮）✗，本轮不提供任何 DOM 入口。
// ══════════════════════════════════════════════════════════

/**
 * 动作种类登记表。`reversible: true` 的才会进栈。
 * ⚠ 三类**永不入栈**的理由各不相同，不要混为一谈：
 *   `load`  —— 不是"用户单步动作"，撤销它没有唯一的目标状态（一次载入 = 整个世界换掉）；
 *   `reset` —— 历史基线被整体换掉（`App.reset()` 里显式 `clear()`）；
 *   `solver`—— 求解器注入与派生量（每帧都在变，见文件头）。
 */
export const OP_KINDS = Object.freeze({
  prop: { reversible: true, why: '用户改参数 —— 全项目唯一口子 `entity.setProp()`' },
  add: { reversible: true, why: '放置器材 `world.add()`' },
  remove: { reversible: true, why: '删除器材（会连带断线 ⇒ 逆动作必须把线接回去）' },
  wire: { reversible: true, why: '接线 `world.connect()`' },
  unwire: { reversible: true, why: '断线 `world.disconnect()`' },
  load: { reversible: false, why: '存档载入 / 预设：不是用户单步动作' },
  reset: { reversible: false, why: '重置全部状态：历史基线被整体换掉' },
  solver: { reversible: false, why: '求解器注入的 I/U/P/R 与派生量：每帧都在变' },
});

/** 某个动作种类是否可入栈（未登记 ⇒ 不可逆 ⇒ 不入栈） */
export function isReversible(kind) {
  const k = OP_KINDS[kind];
  return !!(k && k.reversible);
}

export class UndoStack {
  /**
   * @param {{limit?: number}} [opts] `limit` = 栈深上限（默认 100，超出丢最旧的）
   */
  constructor({ limit = 100 } = {}) {
    this.limit = Math.max(1, limit | 0);
    this._past = [];    // 已发生的用户动作（栈顶 = 最近）
    this._future = [];  // 已撤销、可重做的动作
    this._silent = 0;   // > 0 ⇒ 挂起记录（存档载入 / 撤销执行自身）
    this.rejected = 0;  // 被拒收的次数（诊断用：种类未登记 / 不可逆 / 挂起）
  }

  get depth() { return this._past.length; }
  get redoDepth() { return this._future.length; }
  canUndo() { return this._past.length > 0; }
  canRedo() { return this._future.length > 0; }

  /** 挂起记录（可嵌套；`endSilent` 幂等，不会把计数压到负数） */
  isSilent() { return this._silent > 0; }
  beginSilent() { this._silent++; return this._silent; }
  endSilent() { if (this._silent > 0) this._silent--; return this._silent; }
  /** 在挂起状态下跑一段代码（存档载入、撤销/重做的执行体都走这里） */
  runSilent(fn) {
    this.beginSilent();
    try { return fn(); } finally { this.endSilent(); }
  }

  /**
   * 入栈一条**用户动作**。`op = { kind, label, ent?, undo(), redo() }`。
   * @returns 收下的条目，或被拒时 `null`（拒收会累加 `rejected`）
   */
  push(op) {
    if (!op || typeof op.undo !== 'function' || typeof op.redo !== 'function') {
      this.rejected++; return null;
    }
    if (this.isSilent() || !isReversible(op.kind)) { this.rejected++; return null; }
    this._past.push(op);
    // 栈深上限：丢最旧的（不是丢最新的 —— 丢最新的会让"刚做的事撤不回"）
    if (this._past.length > this.limit) this._past.shift();
    // 新动作 ⇒ 重做链截断（骨架边界条件之一，不是后续优化）
    this._future.length = 0;
    return op;
  }

  /** 撤销一步；执行体在挂起状态下跑 ⇒ 逆动作不会再入栈 */
  undo() {
    const op = this._past.pop();
    if (!op) return null;
    this.runSilent(() => op.undo());
    this._future.push(op);
    return op;
  }

  /** 重做一步 */
  redo() {
    const op = this._future.pop();
    if (!op) return null;
    this.runSilent(() => op.redo());
    this._past.push(op);
    return op;
  }

  /** 清空历史（重置基线时用；不改变世界本身） */
  clear() { this._past.length = 0; this._future.length = 0; }

  /** 栈内标签（从旧到新）—— 给面板与探针读，不参与逻辑 */
  labels() { return this._past.map((o) => o.label || o.kind); }
}
