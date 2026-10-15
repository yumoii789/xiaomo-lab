// ══════════════════════════════════════════════════════════
// 插件宿主 —— 一切皆插件
//
// 参照 DSH 的做法：每一个能力（器材、主题、反应规则、物质、
// 损坏规则、面板）都是一个独立插件，声明元数据后由宿主装入。
// 宿主只提供注册表和作用域，不认识任何具体器材。
//
// 插件形态：
//   {
//     id: 'xiaomo.equipment.electrical',   // 唯一标识（npm 风格）
//     name: '电学器材',
//     version: '1.0.0',
//     kind: 'equipment' | 'theme' | 'chemistry' | 'rules' | 'panel',
//     desc, author, builtin, requires: [id...],
//     setup(ctx) { ctx.equipment.define({...}) }
//   }
//
// 生命周期：record.phase 是唯一真值，取值恰好五个词
//
//   define() ─► pending ─install()─► loading ─┬─► active
//                 ▲                           └─► failed
//                 │                                │
//                 └─── unloading ◄── disable / uninstall / reload
//
// 「装得干净」和「拆得干净」是同一件事的两面：setup 期间产生的每一样
// 东西（插槽注销函数、注册表条目、注册表订阅）都必须进处置栈或带上
// 归属，否则停用插件只能翻标志位，界面和注册表里会留下永久垃圾。
// ══════════════════════════════════════════════════════════

import { bus, EV } from './bus.js';

/**
 * 阶段词表 —— 五个词，不多不少。
 * 清单服务按这张表分桶，宿主多造一个词就会出现「界面认不出的桶」，
 * 所以这里冻结、且与 core/inventory.js 的 PHASES 逐字一致。
 */
export const PHASE = Object.freeze({
  PENDING: 'pending',       // 已声明、尚未生效；也是拆除后的归宿
  LOADING: 'loading',       // setup() 正在执行
  ACTIVE: 'active',         // setup() 成功，贡献已生效
  FAILED: 'failed',         // setup() 抛错（半装的东西已回滚，但阶段如实留在 failed）
  UNLOADING: 'unloading',   // 正在执行处置栈
});

/** 插槽派发方式 */
export const SLOT_KINDS = Object.freeze(['list', 'single', 'keyed', 'chain']);

// ─────────────────────────────────────────────────────────
// 通用注册表
// ─────────────────────────────────────────────────────────
export class Registry {
  /**
   * @param {string} kind      注册表种类（equipment / themes / reactions…）
   * @param {(v:any)=>string} keyOf 从条目里取标识
   */
  constructor(kind, keyOf = (v) => v && (v.id || v.type)) {
    this.kind = kind;
    this.keyOf = keyOf;
    this.items = new Map();
    this._subs = [];
    /**
     * 归属记账：条目 → 写它的插件 id（null 表示无主）。
     * 拆插件时必须能精确摘掉「它自己写进去的那些」，
     * 所以归属得跟条目一起存，不能靠「谁最后装的」这种时间推断。
     */
    this.owners = new Map();
    /** 作用域期间的默认归属，由 withRegistry(reg, fn, owner) 临时设定 */
    this.ownerHint = null;
  }

  define(value, id, owner) {
    const k = id || this.keyOf(value);
    if (!k) throw new Error(`[${this.kind}] 条目缺少标识`);
    if (this.items.has(k)) console.warn(`[${this.kind}] 重复定义 ${k}，已覆盖`);
    this.items.set(k, value);
    this.owners.set(k, owner !== undefined ? owner : (this.ownerHint ?? null));
    this._notify(value, k);
    return value;
  }

  /**
   * 通知订阅者：`value` 是条目当前的值，`key` 是它的标识。
   * 移除路径统一传 `value = null`（这条已经不在了）、`key = 被移除的 key`；
   * 批量移除（removeByOwner / clear）时 `key` 也为 null，订阅者应当整体重投影，
   * 而不是按条增删 —— 批量移除时逐条推会在中途把界面推进不一致的中间态。
   *
   * 为什么**移除也必须通知**：订阅者是投影型界面（器材栏就是器材注册表的投影），
   * 它们的唯一信号源就是这里。移除路径不推，界面就只能停在旧状态 ——
   * 实测后果：运行时卸载器材包之后，注册表 56 条而器材栏仍是 57 行，
   * 那行已经不存在的器材会一直挂在栏里，直到用户去点它。
   *
   * 迭代 `_subs.slice()` 而不是 `_subs`：订阅者可能在回调里退订或再订阅，
   * 直接遍历活数组会漏掉新加入的、或让刚退订的又被调到（重入）。
   */
  _notify(value, key) {
    for (const fn of this._subs.slice()) {
      try { fn(value, key); } catch (e) { console.error(`[${this.kind}] 订阅回调异常`, e); }
    }
  }

  get(k) { return this.items.get(k) || null; }
  has(k) { return this.items.has(k); }
  list() { return [...this.items.values()]; }
  keys() { return [...this.items.keys()]; }
  /** 条目的归属插件 id（无主则 null） */
  ownerOf(k) { return this.owners.has(k) ? this.owners.get(k) : null; }

  /**
   * 摘掉某个插件写进来的全部条目，返回摘掉的条数。
   * owner 为空时一条都不删：器材包、预置等运行时装进来的条目是无主的，
   * 它们不归插件宿主管，误删等于把用户自己装的东西清空。
   */
  removeByOwner(owner) {
    if (!owner) return 0;
    let n = 0;
    for (const [k, o] of [...this.owners]) {
      if (o !== owner) continue;
      this.items.delete(k);
      this.owners.delete(k);
      n++;
    }
    if (n) this._notify(null, null);   // 真摘到了才推；一条都没摘＝注册表没变
    return n;
  }

  /** 摘掉一条。没有这条就不推通知（订阅者是投影，多余通知＝无谓重算）。 */
  remove(k) {
    this.owners.delete(k);
    const existed = this.items.delete(k);
    if (existed) this._notify(null, k);
    return existed;
  }

  /** 清空。本来就空时一条通知都不发（同上）。 */
  clear() {
    const n = this.items.size;
    this.items.clear();
    this.owners.clear();
    if (n) this._notify(null, null);
  }
  onChange(fn) { this._subs.push(fn); return () => { const i = this._subs.indexOf(fn); if (i >= 0) this._subs.splice(i, 1); }; }
  get size() { return this.items.size; }
}

// ─────────────────────────────────────────────────────────
// 作用域：让模块顶层的 define() 写进"当前正在安装的插件"
// 这样器材模块可以保持原有写法，只把它们包进 setup() 即可。
// owner 一并带上，于是顶层 define() 写出来的条目也知道自己属于谁。
// ─────────────────────────────────────────────────────────
let CURRENT = null;

export function withRegistry(reg, fn, owner) {
  const prev = CURRENT;
  CURRENT = reg;
  const hint = reg ? reg.ownerHint : null;
  if (reg) reg.ownerHint = owner === undefined ? hint : owner;
  try { return fn(); } finally {
    CURRENT = prev;
    // 必须还原：不还原就会把「上一个插件的归属」烙给之后所有无主条目
    if (reg) reg.ownerHint = hint;
  }
}
export function currentRegistry() { return CURRENT; }

// ─────────────────────────────────────────────────────────
// 插件宿主
// ─────────────────────────────────────────────────────────
export class PluginHost {
  /**
   * @param {object} app 宿主所属的 App
   * @param {{quiet?: boolean}} [opts] quiet=true 时不重复打印装载失败
   *   （装机错误已经逐条记进 record.error 与 this.errors，调用方自己决定怎么报）
   */
  constructor(app, opts = {}) {
    this.app = app;
    this.quiet = !!opts.quiet;
    this.records = new Map();     // id -> record
    this.order = [];
    this.registries = new Map();
    this.active = null;           // 当前安装中的插件记录
    this.installedAt = 0;
    this.errors = [];

    /** UI 插槽：插件把界面挂到命名位置，宿主不认识任何具体界面 */
    this.slots = new Map();
    /** 插槽插入序号：同 order 时按插入先后排，替代「依赖稳定排序」的隐式行为 */
    this._seq = 0;

    // 预建注册表
    for (const k of ['equipment', 'themes', 'reactions', 'species', 'damage', 'panels', 'commands']) {
      this.registries.set(k, new Registry(k));
    }
  }

  // ── 阶段 ────────────────────────────────────────────────
  /**
   * 唯一的阶段写入口：改记录 + 发瞬时事件。
   * loading / unloading 是过程态，装完就没人停在上面，
   * 所以必须边转边广播，否则外部只能看到两头，看不见「正在发生」。
   */
  _setPhase(rec, phase, action) {
    rec.phase = phase;
    bus.emit('plugin:phase', { id: rec.id, phase, action });
  }

  // ── UI 插槽 ─────────────────────────────────────────────
  /**
   * 往命名插槽贡献一个界面（或被串联的一段逻辑）。
   *
   * kind 决定同名插槽的派发方式：
   *   'list'   默认，全部保留、按 order 排（既有 10 个调用点都是这种）
   *   'single' 同名只留最后一个（同名处只允许一个主人）
   *   'keyed'  以 opts.key 唯一标识，同 key 原位替换，不新增条目
   *   'chain'  按 order 串联，前一个的返回值是后一个的入参（见 runSlot）
   *
   * 条目上带 kind，DOM 挂载方只该渲染前三种；chain 要跑 runSlot()。
   * @returns {() => void} 注销函数（ctx.slot 会自动把它收进处置栈）
   */
  slot(name, render, opts = {}) {
    const kind = opts.kind || 'list';
    if (!SLOT_KINDS.includes(kind)) throw new Error(`[slot] 未知 kind: ${kind}`);
    if (typeof render !== 'function') throw new Error(`[slot] ${name} 缺少 render`);
    if (kind === 'keyed' && opts.key == null) throw new Error(`[slot] keyed 必须给 opts.key`);

    if (!this.slots.has(name)) this.slots.set(name, []);
    const arr = this.slots.get(name);
    // 归属优先取调用方显式给的插件 id：插件可以在 setup 之外重挂界面
    // （比如监听到数据变化后换掉自己那个 keyed 组件），那时 this.active 早已归零，
    // 只看 active 会把条目记成 'unknown'，同 key 替换就失效、条目开始泄漏。
    const pluginId = opts.pluginId || (this.active ? this.active.id : 'unknown');
    const entry = {
      pluginId,
      render,
      order: opts.order ?? 50,
      kind,
      // key 只在「同一插件」内唯一：两个插件用同一个 key 是两件事，必须互不干扰
      key: opts.key ?? null,
      seq: this._seq++,
      className: opts.className || '',
      title: opts.title || '',
    };

    if (kind === 'single') {
      // 单例：清空后只留自己。旧条目的注销函数随即变成空操作（它已经不在表里了）
      arr.length = 0;
      arr.push(entry);
    } else if (kind === 'keyed') {
      const i = arr.findIndex(e => e.kind === 'keyed' && e.key === entry.key && e.pluginId === pluginId);
      if (i >= 0) {
        entry.seq = arr[i].seq;      // 继承原位置，替换不能让界面跳位
        arr[i] = entry;
      } else {
        arr.push(entry);
      }
    } else {
      arr.push(entry);
    }

    this._sortSlot(name);
    bus.emit('slot:changed', { name });
    return () => this._dropEntry(name, entry);
  }

  _dropEntry(name, entry) {
    const arr = this.slots.get(name);
    if (!arr) return false;
    const i = arr.indexOf(entry);
    if (i < 0) return false;      // 已被同 key 替换或被单例顶掉：注销是空操作
    arr.splice(i, 1);
    bus.emit('slot:changed', { name });
    return true;
  }

  /** 稳定排序：order 为主，插入先后为次（不靠 sort 的稳定性） */
  _sortSlot(name) {
    const arr = this.slots.get(name);
    if (!arr) return;
    arr.sort((a, b) => (a.order - b.order) || (a.seq - b.seq));
  }

  /**
   * 串联执行 chain 贡献：value 依次喂给每个 chain 项，前一个的返回值就是后一个的入参。
   * list / single / keyed 是「渲染型」贡献，不参与串联，直接跳过。
   * 单项抛错不中断整条链 —— 与 slot 渲染的容错口径保持一致。
   */
  runSlot(name, value, ...rest) {
    let acc = value;
    for (const e of this.slotItems(name)) {
      if (e.kind !== 'chain') continue;
      try { acc = e.render(acc, ...rest); }
      catch (err) { console.error(`[slot] chain ${name} / ${e.pluginId} 执行失败`, err); }
    }
    return acc;
  }

  slotItems(name) { return this.slots.get(name) || []; }
  slotNames() { return [...this.slots.keys()]; }

  registry(kind) {
    if (!this.registries.has(kind)) this.registries.set(kind, new Registry(kind));
    return this.registries.get(kind);
  }

  /** 声明一个插件（此时还不生效） */
  define(plugin) {
    if (!plugin || !plugin.id) throw new Error('插件缺少 id');
    if (this.records.has(plugin.id)) {
      console.warn('[plugin] 重复声明: ' + plugin.id);
      return this.records.get(plugin.id);
    }
    const rec = {
      id: plugin.id,
      name: plugin.name || plugin.id,
      version: plugin.version || '1.0.0',
      kind: plugin.kind || 'misc',
      desc: plugin.desc || '',
      author: plugin.author || '小墨实验室',
      builtin: plugin.builtin !== false,
      requires: plugin.requires || [],
      tags: plugin.tags || [],
      setup: plugin.setup || (() => {}),
      installed: false,
      enabled: false,
      error: null,
      contributions: 0,
      // ── 冻结契约（K2 的清单服务直接读这两项）──
      phase: PHASE.PENDING,      // 声明后是 pending，装完/拆完各归各位
      offBy: null,               // 'bundle' | 'item' | null
      // 处置栈：setup 期间攒下的一切拆除动作，逆序执行
      disposers: [],
      _plugin: plugin,
    };
    this.records.set(rec.id, rec);
    this.order.push(rec.id);
    return rec;
  }

  /**
   * 按依赖顺序安装全部插件。
   * @param {Map<string,'bundle'|'item'>|Set<string>|string[]|object|null} [off]
   *   停用表。Map 是标准形态（K2 的清单服务给的就是它）；Set / 数组是旧签名，
   *   一律当作单项停用，好让改造期间的调用方不被卡住。
   */
  installAll(off = null) {
    const table = this._offTable(off);
    const done = new Set();
    const skipOne = (id) => {
      const rec = this.records.get(id);
      rec.offBy = table.get(id) || 'item';
      rec.skipped = true;
      rec.installed = false;
      rec.enabled = false;
      rec.contributions = 0;
      this._setPhase(rec, PHASE.PENDING, 'skip');
      done.add(id);
    };
    let guard = 0;
    while (done.size < this.order.length && guard++ < 200) {
      let progress = false;
      for (const id of this.order) {
        if (done.has(id)) continue;
        if (table.has(id)) { skipOne(id); progress = true; continue; }
        const rec = this.records.get(id);
        const ok = rec.requires.every(r => done.has(r) || !this.records.has(r));
        if (!ok) continue;
        this.install(id);
        done.add(id);
        progress = true;
      }
      if (!progress) {
        // 有循环依赖或缺失依赖，剩下的直接装
        for (const id of this.order) {
          if (done.has(id)) continue;
          if (table.has(id)) skipOne(id);
          else { this.install(id); done.add(id); }
        }
      }
    }
    return this.stats();
  }

  /** 把四种可能的停用表都归一成 Map<id,'bundle'|'item'> */
  _offTable(off) {
    const m = new Map();
    if (!off) return m;
    if (off instanceof Map) {
      for (const [k, v] of off) if (k) m.set(k, v === 'bundle' ? 'bundle' : 'item');
      return m;
    }
    if (off instanceof Set || Array.isArray(off)) {
      for (const k of off) if (k) m.set(k, 'item');
      return m;
    }
    if (typeof off === 'object') {
      for (const [k, v] of Object.entries(off)) if (k && v) m.set(k, v === 'bundle' ? 'bundle' : 'item');
    }
    return m;
  }

  install(id) {
    const rec = this.records.get(id);
    if (!rec) return false;
    if (rec.installed) return true;      // 已生效：幂等，绝不重复跑 setup
    return this._setup(rec);
  }

  _setup(rec) {
    const id = rec.id;
    const before = this.snapshotCounts();
    const ctx = this.makeContext(rec);
    this.active = rec;
    rec.error = null;
    // 必须在 setup 之前落阶段：插件在 setup 里读自己的 phase 就该看到 loading
    this._setPhase(rec, PHASE.LOADING, 'install');
    try {
      withRegistry(null, () => {});       // 复位
      rec.setup(ctx);
      rec.installed = true;
      rec.enabled = true;
      rec.skipped = false;
      this._setPhase(rec, PHASE.ACTIVE, 'install');
    } catch (err) {
      rec.error = err && err.message ? err.message : String(err);
      rec.installed = false;
      rec.enabled = false;
      this.errors.push({ id, error: rec.error });
      if (!this.quiet) console.error(`[plugin] 安装失败 ${id}`, err);
      // 半装的东西不能留：失败的插件若把器材留在注册表里，界面与统计都会失真
      this._runDispose(rec);
      this._setPhase(rec, PHASE.FAILED, 'install');
      return false;
    } finally {
      this.active = null;
      const after = this.snapshotCounts();
      // 贡献口径不变：只数这次 setup 净新增了什么（失败路径回滚后自然是 0）
      rec.contributions = Object.keys(after)
        .reduce((n, k) => n + (after[k] - before[k]), 0);
      this.installedAt = Date.now();
      bus.emit('plugin:changed', { id, action: 'install', phase: rec.phase, offBy: rec.offBy });
    }
    return true;
  }

  /**
   * 只做拆除：跑处置栈 + 按归属摘注册表条目。阶段由调用方设定，
   * 因为「为什么拆」（停用 / 卸载 / 重载 / 装载失败回滚）决定它拆完停在哪个阶段。
   */
  _runDispose(rec) {
    // 逆序：后建的先拆，与建栈顺序对称；一个回调抛错不该拦住其余回调
    const stack = rec.disposers.splice(0).reverse();
    for (const fn of stack) {
      try { fn(); } catch (e) { console.error(`[plugin] 处置失败 ${rec.id}`, e); }
    }
    for (const reg of this.registries.values()) reg.removeByOwner(rec.id);
    return stack.length;
  }

  /** 拆除并把插件送回 pending（disable / uninstall / reload 的公共后半段） */
  _teardown(rec) {
    this._setPhase(rec, PHASE.UNLOADING, 'teardown');
    this._runDispose(rec);
    rec.installed = false;
    rec.enabled = false;
    rec.skipped = true;
    rec.contributions = 0;
    this._setPhase(rec, PHASE.PENDING, 'teardown');
  }

  /** 卸载：拆干净并回到 pending。卸载本来就是一种停用，所以 offBy 落 'item' 而不是 null */
  uninstall(id) {
    const rec = this.records.get(id);
    if (!rec) return false;
    if (!rec.offBy) rec.offBy = 'item';
    this._teardown(rec);
    bus.emit('plugin:changed', { id, action: 'uninstall', phase: rec.phase, offBy: rec.offBy });
    return true;
  }

  /**
   * 启用（可选指定层级）：清掉停用标记并重新 setup。
   * 之前失败的插件也在这里被重新试装 —— 否则「启用」会把一个 failed 的记录
   * 伪装成 enabled，那是比不启用更坏的状态。
   */
  enable(id) {
    const rec = this.records.get(id);
    if (!rec) return false;
    rec.offBy = null;
    if (rec.phase !== PHASE.ACTIVE) this.install(id);
    bus.emit('plugin:changed', { id, action: 'enable', phase: rec.phase, offBy: rec.offBy });
    return rec.phase === PHASE.ACTIVE;
  }

  /**
   * 停用（可选指定层级）。
   * level='bundle' 表示关掉的是整个包、'item' 表示只关这一项；
   * 两者都真的执行处置栈。包 → 成员的展开是清单服务的事，内核不认识「包」。
   */
  disable(id, level = 'item') {
    const rec = this.records.get(id);
    if (!rec) return false;
    rec.offBy = level === 'bundle' ? 'bundle' : 'item';
    this._teardown(rec);
    bus.emit('plugin:changed', { id, action: 'disable', phase: rec.phase, offBy: rec.offBy });
    return true;
  }

  /**
   * 重载：先真的拆干净，再重新 setup。
   * 因为拆除已经把贡献与插槽条目都摘掉了，重装只会在同一基线上累加，
   * 所以 equipment 等计数回到同一个数字，不会翻倍。
   * 停用中的插件只拆不装 —— 重载不是「复活」。
   */
  reload(id) {
    const rec = this.records.get(id);
    if (!rec) return false;
    const off = rec.offBy;
    this._teardown(rec);
    if (off) {
      rec.offBy = off;
      bus.emit('plugin:changed', { id, action: 'reload', phase: rec.phase, offBy: rec.offBy });
      return false;
    }
    const ok = this.install(id);
    bus.emit('plugin:changed', { id, action: 'reload', phase: rec.phase, offBy: rec.offBy });
    return ok;
  }

  /** 插件运行上下文 —— 这是插件与内核之间唯一的接口 */
  makeContext(rec) {
    const host = this;
    const own = rec.id;
    /** 攒进处置栈：上下文里产生的每一样可拆的东西都必须经过这里 */
    const keep = (fn) => { if (typeof fn === 'function') rec.disposers.push(fn); return fn; };
    const reg = (kind) => ({
      // 显式带上归属：拆除时才能精确摘掉本插件写进去的条目
      define: (v, id) => host.registry(kind).define(v, id, own),
      get: (k) => host.registry(kind).get(k),
      list: () => host.registry(kind).list(),
      has: (k) => host.registry(kind).has(k),
      // 订阅也要可拆：否则插件拆了之后回调还在往死插件里写
      onChange: (fn) => keep(host.registry(kind).onChange(fn)),
      get size() { return host.registry(kind).size; },
    });
    return {
      id: rec.id,
      plugin: rec,
      host,
      app: host.app,
      bus,
      EV,
      equipment: reg('equipment'),
      themes: reg('themes'),
      reactions: reg('reactions'),
      species: reg('species'),
      damage: reg('damage'),
      panels: reg('panels'),
      commands: reg('commands'),
      /** 在某个注册表作用域内执行，模块顶层的 define() 会写进去并带上归属 */
      scope: (kind, fn) => withRegistry(host.registry(kind), fn, own),
      /** 往 UI 插槽挂界面：注销函数自动进处置栈，停用插件时界面跟着消失 */
      slot: (name, render, opts) => keep(host.slot(name, render, { ...opts, pluginId: own })),
      /** 插件自己的拆除动作，逆序执行、单项抛错不影响其余项 */
      onDispose: keep,
      config: host.app && host.app.config
        ? host.app.config.scope(rec.id)
        : { get: (_k, d) => d, set: () => {}, all: () => ({}) },
      log: (msg) => host.app && host.app.log && host.app.log.push('sys', msg),
      toast: (msg, kind) => host.app && host.app.toast && host.app.toast(msg, kind),
    };
  }

  snapshotCounts() {
    const o = {};
    for (const [k, r] of this.registries) o[k] = r.size;
    return o;
  }

  list() { return this.order.map(id => this.records.get(id)); }
  get(id) { return this.records.get(id) || null; }
  byKind(kind) { return this.list().filter(r => r.kind === kind); }
  stats() {
    const all = this.list();
    return {
      total: all.length,
      installed: all.filter(r => r.installed && r.enabled).length,
      failed: all.filter(r => r.error).length,
      contributions: all.reduce((n, r) => n + r.contributions, 0),
      equipment: this.registry('equipment').size,
      themes: this.registry('themes').size,
      reactions: this.registry('reactions').size,
      // ── 新增（不改上面任何字段的口径）──
      pending: all.filter(r => r.phase === PHASE.PENDING).length,
      active: all.filter(r => r.phase === PHASE.ACTIVE).length,
      loading: all.filter(r => r.phase === PHASE.LOADING).length,
      unloading: all.filter(r => r.phase === PHASE.UNLOADING).length,
      disabled: all.filter(r => !!r.offBy).length,
      skipped: all.filter(r => !!r.skipped).length,
    };
  }
}
