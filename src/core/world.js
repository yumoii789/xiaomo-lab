// ══════════════════════════════════════════════════════════
// World —— 实验台世界：器材集合 + 连线拓扑
//
// 这是物理域和化学域共享的唯一场景。两种器材混在同一个 entities 数组里，
// 连线也共用同一套 wires（电线与导管只是 kind 不同），
// 因此「把一个电极插进烧杯」在数据结构层面和「把一根导线接到电阻」没有区别。
// ══════════════════════════════════════════════════════════

import { bus, EV } from './bus.js';
import { nextId } from './entity.js';
import { C } from './theme.js';

export class Wire {
  constructor(a, b, kind = 'wire') {
    this.id = nextId('w');
    this.a = a;            // { e: entityId, p: portIndex }
    this.b = b;
    this.kind = kind;      // 'wire' 电线 | 'tube' 导管 | 'probe' 探头
    this.state = {};       // 运行时：电流、通断
  }
  /** 获得另一端 */
  other(ref, world) {
    if (ref.e === this.a.e && ref.p === this.a.p) return this.b;
    if (ref.e === this.b.e && ref.p === this.b.p) return this.a;
    return null;
  }
  has(ref) { return (ref.e === this.a.e && ref.p === this.a.p) || (ref.e === this.b.e && ref.p === this.b.p); }
}

export class World {
  constructor() {
    this.entities = [];
    this.wires = [];
    this.byId = new Map();
    this.time = 0;          // 仿真时间（秒）
    this.running = true;
    this.frame = 0;
    /** 撤销/重做栈（C9 骨架）：由 main.js 建好后挂上来；为 null ⇒ 全部挂钩自然失效 */
    this.undo = null;
  }

  // ─── 器材 ─────────────────────────────────────────────
  add(ent, silent = false) {
    ent.world = this;          // 器材回指世界：撤销挂钩靠它找到栈（entity.setProp）
    this.entities.push(ent);
    this.byId.set(ent.id, ent);
    ent.onAdd?.(this);
    if (!silent) bus.emit(EV.ENTITY_ADD, ent);
    bus.emit(EV.SCENE_DIRTY);
    // 撤销栈（C9）：`silent` 的内部调用（存档载入 / 预设 / 逆动作）不记账
    const u = this.undo;
    if (u && !silent) {
      u.push({
        kind: 'add', label: `放置 ${ent.def ? ent.def.name : ent.type}`, ent,
        undo: () => this.remove(ent),
        redo: () => this.add(ent),
      });
    }
    return ent;
  }

  remove(ent) {
    // 连带移除挂在它上面的所有连线（复用 wiresOf：不再各写一份过滤）
    const dead = this.wiresOf(ent);
    for (const w of dead) this.disconnect(w, true);
    const i = this.entities.indexOf(ent);
    if (i >= 0) this.entities.splice(i, 1);
    this.byId.delete(ent.id);
    ent.onRemove?.(this);
    bus.emit(EV.ENTITY_REMOVE, ent);
    bus.emit(EV.SCENE_DIRTY);
    // 撤销栈（C9）：逆动作必须**把连带断掉的线接回去** ✗
    // 否则"删除 → 撤销"之后器材回来了、线却少了几根（最难发现的那类不完整还原）
    const u = this.undo;
    if (u) {
      const refs = dead.map((w) => [{ ...w.a }, { ...w.b }, w.kind]);
      u.push({
        kind: 'remove', label: `删除 ${ent.def ? ent.def.name : ent.type}`, ent,
        undo: () => { this.add(ent); for (const [a, b, k] of refs) this.connect(a, b, k); },
        redo: () => this.remove(ent),
      });
    }
    return dead.length;
  }

  get(id) { return this.byId.get(id) || null; }
  all() { return this.entities; }
  count() { return this.entities.length; }

  ofDomain(d) { return this.entities.filter(e => e.domain === d); }
  ofType(t) { return this.entities.filter(e => e.type === t); }

  clear() {
    this.wires.length = 0;
    this.entities.length = 0;
    this.byId.clear();
    this.time = 0;
    bus.emit(EV.SCENE_DIRTY);
  }

  // ─── 空间查询 ─────────────────────────────────────────
  /** 最上层的器材（后添加的在上） */
  pick(x, y) {
    for (let i = this.entities.length - 1; i >= 0; i--) {
      if (this.entities[i].hitTest(x, y)) return this.entities[i];
    }
    return null;
  }

  /** 找出点中的接线柱 */
  pickPort(x, y, tol = 12) {
    for (let i = this.entities.length - 1; i >= 0; i--) {
      const e = this.entities[i];
      const p = e.hitPort(x, y, tol);
      if (p >= 0) return { ent: e, port: p, ...e.portWorldAt(p) };
    }
    return null;
  }

  /** 找出所有包含该点的器材（容器扣在别的器材上时会用到） */
  pickAll(x, y) {
    return this.entities.filter(e => e.hitTest(x, y));
  }

  /** 距离某点最近的器材中心 */
  nearest(x, y, filter) {
    let best = null, bd = Infinity;
    for (const e of this.entities) {
      if (filter && !filter(e)) continue;
      const d = (e.x - x) ** 2 + (e.y - y) ** 2;
      if (d < bd) { bd = d; best = e; }
    }
    return best;
  }

  /** 在某点附近、属于某域的器材 */
  nearDomain(x, y, domain, r = 90) {
    return this.entities.filter(e =>
      e.domain === domain && Math.hypot(e.x - x, e.y - y) <= r);
  }

  // ─── 连线 ─────────────────────────────────────────────
  /**
   * 同一个接线柱上允许拧多根线 —— 真实实验台就是这样，
   * 并联、节点扩展、一根线分两路都依赖它。
   * 只禁止自连与完全重复的那一对端口。
   */
  canConnect(refA, refB) {
    if (!refA || !refB) return false;
    if (refA.e === refB.e) return false;
    const same = (x, y) => x.e === y.e && x.p === y.p;
    return !this.wires.some(w =>
      (same(w.a, refA) && same(w.b, refB)) ||
      (same(w.a, refB) && same(w.b, refA)));
  }

  connect(refA, refB, kind) {
    if (!this.canConnect(refA, refB)) return null;
    const ea = this.get(refA.e), eb = this.get(refB.e);
    if (!ea || !eb) return null;
    const pa = ea.ports[refA.p], pb = eb.ports[refB.p];
    const k = kind || (pa.kind === 'tube' || pb.kind === 'tube' ? 'tube'
      : pa.kind === 'probe' || pb.kind === 'probe' ? 'probe' : 'wire');
    const w = new Wire({ ...refA }, { ...refB }, k);
    this.wires.push(w);
    bus.emit(EV.WIRE_ADD, w);
    bus.emit(EV.SCENE_DIRTY);
    // 撤销栈（C9）：重做会造出**新的** Wire 对象 ⇒ 必须刷新被捕获的引用 ✗
    // 否则「接线 → 撤销 → 重做 → 再撤销」会拿一条已经不在世界里的旧线去断（引用走空）
    const u = this.undo;
    if (u) {
      let cur = w;
      u.push({
        kind: 'wire', label: '接线',
        undo: () => this.disconnect(cur),
        redo: () => { cur = this.connect({ ...refA }, { ...refB }, kind); },
      });
    }
    return w;
  }

  disconnect(w, silent = false) {
    const i = this.wires.indexOf(w);
    if (i >= 0) this.wires.splice(i, 1);
    if (!silent) { bus.emit(EV.WIRE_REMOVE, w); bus.emit(EV.SCENE_DIRTY); }
    // 撤销栈（C9）：内部连带断线（remove 传 silent=true）不记账；
    // `i >= 0` ⇒ 空断线（本来就没这根线）不该产生历史条目
    const u = this.undo;
    if (u && !silent && i >= 0) {
      const a = { ...w.a }, b = { ...w.b }, k = w.kind;
      u.push({
        kind: 'unwire', label: '断线',
        undo: () => { this.connect(a, b, k); },
        redo: () => { this.disconnect(w); },
      });
    }
    return w;
  }

  wiresOf(ent) {
    return this.wires.filter(w => w.a.e === ent.id || w.b.e === ent.id);
  }

  /** 与某个端口直接相连的其它端口 */
  neighborsOf(ref) {
    const out = [];
    for (const w of this.wires) {
      const o = w.other(ref, this);
      if (o) out.push({ ref: o, wire: w });
    }
    return out;
  }

  // ─── 仿真步进 ─────────────────────────────────────────
  step(dt) {
    if (!this.running) return;
    this.time += dt;
    this.frame++;
    for (const e of this.entities) {
      try { e.step?.(dt, this); }
      catch (err) { console.error(`[step] ${e.type}#${e.id}`, err); }
    }
  }

  render(g) {
    for (const e of this.entities) {
      g.save();
      g.translate(e.x, e.y);
      if (e.rot) g.rotate(e.rot);
      try { e.render?.(g, this); }
      catch (err) { console.error(`[render] ${e.type}#${e.id}`, err); }
      g.restore();
    }
  }

  // ─── 序列化 ───────────────────────────────────────────
  toJSON() {
    return {
      v: 1,
      entities: this.entities.map(e => e.toJSON()),
      wires: this.wires.map(w => ({ a: w.a, b: w.b, kind: w.kind })),
    };
  }

  /**
   * @param {object} data
   * @param {(type:string)=>object} factory 由器材注册表提供
   */
  loadJSON(data, factory) {
    this.clear();
    const map = new Map();
    for (const o of data.entities || []) {
      const def = factory(o.type);
      if (!def) continue;
      const ent = def.create(o.x, o.y);
      ent.loadJSON?.(o);
      this.add(ent, true);
      map.set(ent.id, ent);
    }
    return map; // 连线由调用方按索引恢复
  }
}
