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
// ══════════════════════════════════════════════════════════

import { bus, EV } from './bus.js';

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
  }

  define(value, id) {
    const k = id || this.keyOf(value);
    if (!k) throw new Error(`[${this.kind}] 条目缺少标识`);
    if (this.items.has(k)) console.warn(`[${this.kind}] 重复定义 ${k}，已覆盖`);
    this.items.set(k, value);
    for (const fn of this._subs.slice()) {
      try { fn(value, k); } catch (e) { console.error(`[${this.kind}] 订阅回调异常`, e); }
    }
    return value;
  }

  get(k) { return this.items.get(k) || null; }
  has(k) { return this.items.has(k); }
  list() { return [...this.items.values()]; }
  keys() { return [...this.items.keys()]; }
  remove(k) { return this.items.delete(k); }
  clear() { this.items.clear(); }
  onChange(fn) { this._subs.push(fn); return () => { const i = this._subs.indexOf(fn); if (i >= 0) this._subs.splice(i, 1); }; }
  get size() { return this.items.size; }
}

// ─────────────────────────────────────────────────────────
// 作用域：让模块顶层的 define() 写进"当前正在安装的插件"
// 这样器材模块可以保持原有写法，只把它们包进 setup() 即可。
// ─────────────────────────────────────────────────────────
let CURRENT = null;

export function withRegistry(reg, fn) {
  const prev = CURRENT;
  CURRENT = reg;
  try { return fn(); } finally { CURRENT = prev; }
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

    // 预建注册表
    for (const k of ['equipment', 'themes', 'reactions', 'species', 'damage', 'panels', 'commands']) {
      this.registries.set(k, new Registry(k));
    }
  }

  // ── UI 插槽 ─────────────────────────────────────────────
  slot(name, render, opts = {}) {
    if (!this.slots.has(name)) this.slots.set(name, []);
    const entry = {
      pluginId: this.active ? this.active.id : 'unknown',
      render,
      order: opts.order ?? 50,
      className: opts.className || '',
      title: opts.title || '',
    };
    this.slots.get(name).push(entry);
    this.slots.get(name).sort((a, b) => a.order - b.order);
    bus.emit('slot:changed', { name });
    return () => {
      const arr = this.slots.get(name);
      const i = arr.indexOf(entry);
      if (i >= 0) arr.splice(i, 1);
      bus.emit('slot:changed', { name });
    };
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
      _plugin: plugin,
    };
    this.records.set(rec.id, rec);
    this.order.push(rec.id);
    return rec;
  }

  /** 按依赖顺序安装全部插件；skip 中的插件被用户停用，直接跳过 */
  installAll(skip = null) {
    const done = new Set();
    const skipOne = (id) => {
      const rec = this.records.get(id);
      rec.installed = true; rec.enabled = false; rec.skipped = true;
      done.add(id);
    };
    let guard = 0;
    while (done.size < this.order.length && guard++ < 200) {
      let progress = false;
      for (const id of this.order) {
        if (done.has(id)) continue;
        if (skip && skip.has(id)) { skipOne(id); progress = true; continue; }
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
          if (skip && skip.has(id)) skipOne(id);
          else { this.install(id); done.add(id); }
        }
      }
    }
    return this.stats();
  }

  install(id) {
    const rec = this.records.get(id);
    if (!rec) return false;
    if (rec.installed) return true;

    const before = this.snapshotCounts();
    const ctx = this.makeContext(rec);
    this.active = rec;
    try {
      withRegistry(null, () => {});       // 复位
      rec.setup(ctx);
      rec.installed = true;
      rec.enabled = true;
      rec.error = null;
    } catch (err) {
      rec.error = err && err.message ? err.message : String(err);
      rec.installed = true;
      rec.enabled = false;
      this.errors.push({ id, error: rec.error });
      if (!this.quiet) console.error(`[plugin] 安装失败 ${id}`, err);
    } finally {
      this.active = null;
    }
    const after = this.snapshotCounts();
    rec.contributions = Object.keys(after)
      .reduce((n, k) => n + (after[k] - before[k]), 0);
    this.installedAt = Date.now();
    bus.emit('plugin:changed', { id, action: 'install' });
    return true;
  }

  uninstall(id) {
    const rec = this.records.get(id);
    if (!rec) return false;
    // 简单实现：清空该插件贡献的条目（通过重装全部插件重建）
    rec.installed = false;
    rec.enabled = false;
    bus.emit('plugin:changed', { id, action: 'uninstall' });
    return true;
  }

  enable(id) {
    const rec = this.records.get(id);
    if (!rec) return false;
    if (!rec.installed) this.install(id);
    rec.enabled = true;
    bus.emit('plugin:changed', { id, action: 'enable' });
    return true;
  }

  disable(id) {
    const rec = this.records.get(id);
    if (!rec) return false;
    rec.enabled = false;
    bus.emit('plugin:changed', { id, action: 'disable' });
    return true;
  }

  /** 插件运行上下文 —— 这是插件与内核之间唯一的接口 */
  makeContext(rec) {
    const host = this;
    const reg = (kind) => ({
      define: (v, id) => host.registry(kind).define(v, id),
      get: (k) => host.registry(kind).get(k),
      list: () => host.registry(kind).list(),
      has: (k) => host.registry(kind).has(k),
      onChange: (fn) => host.registry(kind).onChange(fn),
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
      /** 在某个注册表作用域内执行，模块顶层的 define() 会写进去 */
      scope: (kind, fn) => withRegistry(host.registry(kind), fn),
      /** 往 UI 插槽挂界面 */
      slot: (name, render, opts) => host.slot(name, render, opts),
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
    };
  }
}
