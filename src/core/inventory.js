// ══════════════════════════════════════════════════════════
// 插件清单服务 + 两级启停状态
//
// 参照 DSH 的插件管理：界面**只读一份独立的清单视图**，不直接读内核。
// 这样内核怎么改自己的内部字段都不会把界面带崩，界面也改不动内核 ——
// 它拿到的每一层都是冻结的拷贝，不是宿主的记录对象。
//
// 三者的分工（谁是真值，谁是投影）：
//   PluginHost      真值①：某个插件此刻处在哪个阶段（phase）、被谁关掉（offBy）
//   PluginState     真值②：用户的启停选择，两级（包级 bundles / 单项级 items）并持久化
//   PluginInventory 投影：把上面两者合成一份只读快照，自己一个字段都不存
//
// 启停选择为什么要单独成类：决定「要不要装」是在**装之前**就要回答的问题，
// 那时宿主连记录都还没有，问不了它。装完之后的显示才轮到宿主说话。
// ══════════════════════════════════════════════════════════

import { bus } from './bus.js';

/**
 * 插件阶段的固定词汇表。
 * 清单的分桶计数键与单项 phase 共用这一份 —— 界面按词表分桶，不认识的词会被当成漏桶，
 * 所以这里既不接受宿主多造词，也不允许调用方改词。
 */
export const PHASES = Object.freeze(['pending', 'loading', 'active', 'failed', 'unloading']);

const PHASE_SET = new Set(PHASES);

/**
 * 宿主发出的两个「插件有变化」事件名。
 * `plugin:changed` 是每次装卸/启停结算时发的；`plugin:phase` 是每次阶段迁移都发的，
 * 少了它订阅者永远看不到 loading / unloading —— 那两个桶只在迁移途中存在，
 * 结算时早就落回 active 或 pending 了，五阶段里就有两个白写了。
 */
const HOST_CHANGED = 'plugin:changed';
const HOST_PHASE = 'plugin:phase';

/** 新结构：两级启停选择 */
export const STATE_KEY = 'xiaomo.plugins.state.v1';
/**
 * 旧结构：`xiaomo.plugins.disabled`，一个 id 数组，ui.manager.js 至今在写。
 * 这个键仍归旧界面所有，本类只读它、只删自己已接管的条目，绝不往里新增 ——
 * 往里写就会让旧界面对用户撒一个他没做过的谎。
 */
export const LEGACY_DISABLED_KEY = 'xiaomo.plugins.disabled';

/** 取默认存储。无痕 / 嵌入环境下访问 localStorage 本身就会抛，所以连读都得包起来。 */
function defaultStorage() {
  try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch { return null; }
}

function parseJson(raw) {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch { return null; }
}

/** 只保留值为布尔的两级开关，坏数据一律丢弃（坏数据不该让启动失败） */
function booleanMap(v) {
  const out = {};
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    for (const k of Object.keys(v)) if (typeof v[k] === 'boolean') out[k] = v[k];
  }
  return out;
}

function parseIdSet(raw) {
  try {
    const arr = JSON.parse(raw || '[]');
    return new Set(Array.isArray(arr) ? arr.filter((x) => typeof x === 'string' && x) : []);
  } catch { return new Set(); }
}

// ══════════════════════════════════════════════════════════
// 两级启停状态（持久化）
//
// 存在两级的理由：「整包关掉」和「只关包里的一个」是两种意图，界面上要能分开显示，
// 关包时也不该把包内每个插件的单项选择抹掉 —— 重新开包时那些选择要原样回来。
// offBy 的优先级因此是固定的：包级关 → 'bundle'；否则单项关 → 'item'；否则 null。
// ══════════════════════════════════════════════════════════
export class PluginState {
  /**
   * @param {Storage|null} [storage] 省略则用 localStorage；显式传 null 表示只在内存里活（测试用）
   */
  constructor(storage) {
    this.storage = storage === undefined ? defaultStorage() : storage;
    this._bundles = {};
    this._items = {};
    /**
     * 「选择还寄存在旧键里」的 id 集合。
     * 旧键是「停用即存在」的集合，没有 true/false，所以只能靠这份名单把它和新键区分开：
     * 名单里的 id 以旧键为准（旧键里消失＝用户在旧界面里重新启用了它），
     * 名单外的 id 以新键为准。没有它就无法区分「用户启用了」和「从没表过态」。
     */
    this._adopted = new Set();
    this._load();
  }

  // ── 查询：只读 ────────────────────────────────────────────
  isBundleOff(bundle) { return !!bundle && this._bundles[bundle] === false; }
  isItemOff(id) { return !!id && this._items[id] === false; }

  /** 某个插件被谁关掉：'bundle' | 'item' | null。bundle 由调用方按宿主记录给出。 */
  offByOf(id, bundle) {
    if (this.isBundleOff(bundle)) return 'bundle';
    if (this.isItemOff(id)) return 'item';
    return null;
  }

  /** 冻结的两级视图，供界面直接渲染 */
  snapshot() {
    return Object.freeze({
      bundles: Object.freeze(Object.assign({}, this._bundles)),
      items: Object.freeze(Object.assign({}, this._items)),
    });
  }

  /**
   * 交给宿主 installAll 的停用表：Map<id, 'bundle'|'item'>。
   * 必须给出插件目录（每项至少含 id，可含 bundle / kind）：包级关掉时，
   * 只有目录才能把「哪个包」展开成「包里的哪些插件」。
   * 目录项可以只给 id 字符串（此时认不出包级）。
   */
  toOffMap(catalog = []) {
    const out = new Map();
    for (const p of catalog || []) {
      const id = typeof p === 'string' ? p : (p && p.id);
      if (!id) continue;
      const bundle = typeof p === 'string' ? '' : (p.bundle || p.kind || '');
      const off = this.offByOf(id, bundle);
      if (off) out.set(id, off);
    }
    return out;
  }

  // ── 改：写盘 ─────────────────────────────────────────────
  // 下面两个 setter 的第二参数都是**是否启用**：false = 停用，true = 启用
  // （判定口径见 isBundleOff / isItemOff 里的 `=== false`）。
  // 参数名曾经叫 off 而与语义相反，害人写错过调用点，故显式点名。
  setBundle(bundle, on) {
    if (!bundle) return false;
    this._bundles[bundle] = !!on;
    this._save();
    return true;
  }

  /** 第二参数是**是否启用**：`false` = 停用，`true` = 启用。 */
  setItem(id, on) {
    if (!id) return false;
    this._items[id] = !!on;
    if (this._adopted.delete(id)) this._evictLegacy(id);   // 新键已接管，旧键不该再提这个 id
    this._save();
    return true;
  }

  // ── 读盘与迁移 ───────────────────────────────────────────
  _load() {
    const parsed = parseJson(this._read(STATE_KEY));
    const bundles = booleanMap(parsed && parsed.bundles);
    const items = booleanMap(parsed && parsed.items);
    const adopted = new Set(
      Array.isArray(parsed && parsed.adopted) ? parsed.adopted.filter((x) => typeof x === 'string' && x) : [],
    );
    let dirty = !parsed;   // 新键还不存在 → 这次读盘就要把它落下去

    const legacy = parseIdSet(this._read(LEGACY_DISABLED_KEY));

    // 旧键仍是名单内 id 的家：它在旧键里存在＝停用，消失＝被旧界面重新启用。
    // items 存的是「停用」标志（false 才是停用），所以旧键里有就要写成 false。
    for (const id of adopted) {
      const off = !legacy.has(id);
      if (items[id] !== off) { items[id] = off; dirty = true; }
    }

    // 旧键里没见过的 id：并入新结构并登记为「寄存在旧键」，用户已有的选择因此不丢
    for (const id of legacy) {
      if (adopted.has(id)) continue;
      adopted.add(id);
      items[id] = false;
      dirty = true;
    }

    this._bundles = bundles;
    this._items = items;
    this._adopted = adopted;
    if (dirty) this._save();
  }

  _save() {
    const s = this.storage;
    if (!s || typeof s.setItem !== 'function') return;   // 无存储（Node / 无痕）时状态只活在内存里
    try {
      s.setItem(STATE_KEY, JSON.stringify({
        v: 1,
        bundles: this._bundles,
        items: this._items,
        adopted: [...this._adopted],
      }));
    } catch { /* 配额满 / 被禁用：功能照常，只是这次选择留不到下次 */ }
  }

  _read(key) {
    const s = this.storage;
    if (!s || typeof s.getItem !== 'function') return null;
    try { return s.getItem(key); } catch { return null; }
  }

  _evictLegacy(id) {
    const s = this.storage;
    if (!s || typeof s.setItem !== 'function') return;
    const legacy = parseIdSet(this._read(LEGACY_DISABLED_KEY));
    if (!legacy.has(id)) return;
    legacy.delete(id);
    try { s.setItem(LEGACY_DISABLED_KEY, JSON.stringify([...legacy])); } catch { /* 同上 */ }
  }
}

// ══════════════════════════════════════════════════════════
// 只读清单：PluginHost 之上的投影
//
// 不缓存、不持有真值：每次 snapshot() 都重新读宿主记录。缓存就得自己判断什么时候失效，
// 而那正是「视图和内核不同步」这类 bug 的来源 —— 投影算得起（23 条），不值得换缓存。
// ══════════════════════════════════════════════════════════
export class PluginInventory {
  /**
   * @param {object} host  插件宿主（提供 list()，或退一步读 records）
   * @param {{state?: PluginState, bus?: object}} [opts] state 用来补 offBy 的投影
   */
  constructor(host, opts = {}) {
    this.host = host;
    this.state = opts.state || null;
    this._subs = [];
    this._bus = opts.bus === undefined ? bus : opts.bus;
    this._offs = [];
    if (this._bus && typeof this._bus.on === 'function') {
      // 订阅宿主的「有变化」，于是界面的重绘不再需要自己去问内核
      const push = () => this.notify();
      this._offs.push(this._bus.on(HOST_CHANGED, push), this._bus.on(HOST_PHASE, push));
    }
  }

  /** 解绑宿主事件（用完即弃的宿主，比如检查脚本里的临时实例） */
  dispose() {
    for (const off of this._offs) { try { off(); } catch { /* 已解绑 */ } }
    this._offs.length = 0;
    this._subs.length = 0;
  }

  /**
   * 订阅变化。回调收到的是和 snapshot() 同一份冻结快照。
   * 订阅不会立刻推一次：先 snapshot() 拿到当前状态、再 onChange() 订阅，
   * 这样中间若正好发生一次变化，那次推送不会被吞掉。需要主动推一次就调 notify()。
   * @returns {() => void} 退订
   */
  onChange(fn) {
    if (typeof fn !== 'function') throw new TypeError('[inventory] onChange 需要一个函数');
    this._subs.push(fn);
    return () => { const i = this._subs.indexOf(fn); if (i >= 0) this._subs.splice(i, 1); };
  }

  /** 主动构造一次快照推给订阅者（宿主没发事件时的兜底） */
  notify() {
    const snap = this.snapshot();
    for (const fn of this._subs.slice()) {
      try { fn(snap); } catch (e) { console.error('[inventory] 订阅回调异常', e); }
    }
    return snap;
  }

  /**
   * 当前清单快照。整棵结构都冻结：调用方拿到的是拷贝，改不动也不指向宿主记录。
   * @returns {{total:number, counts:Record<string,number>, items:ReadonlyArray<object>}}
   */
  snapshot() {
    const counts = { pending: 0, loading: 0, active: 0, failed: 0, unloading: 0 };
    const items = [];
    for (const rec of this._records()) {
      const item = this._item(rec);
      counts[item.phase] += 1;
      items.push(item);
    }
    return Object.freeze({
      total: items.length,
      counts: Object.freeze(counts),
      items: Object.freeze(items),
    });
  }

  // ── 内部 ────────────────────────────────────────────────
  _records() {
    const h = this.host;
    if (h && typeof h.list === 'function') {
      const l = h.list();
      if (Array.isArray(l)) return l.filter(Boolean);
    }
    const m = h && h.records;
    if (m instanceof Map) return [...m.values()].filter(Boolean);
    if (m && typeof m === 'object') return Object.values(m).filter(Boolean);
    return [];
  }

  _item(rec) {
    const bundle = rec.bundle || rec.kind || '';
    return Object.freeze({
      id: String(rec.id == null ? '' : rec.id),
      name: String(rec.name == null ? rec.id : rec.name),
      version: String(rec.version == null ? '' : rec.version),
      kind: String(rec.kind == null ? 'misc' : rec.kind),
      desc: String(rec.desc == null ? '' : rec.desc),
      author: String(rec.author == null ? '' : rec.author),
      builtin: rec.builtin !== false,
      tags: Object.freeze(Array.isArray(rec.tags) ? rec.tags.slice() : []),
      phase: this._phase(rec),
      offBy: this._offBy(rec, bundle),
      error: rec.error == null ? null : String(rec.error),
      contributions: Number(rec.contributions) || 0,
      requires: Object.freeze(Array.isArray(rec.requires) ? rec.requires.slice() : []),
    });
  }

  /**
   * 阶段。契约落地后 record.phase 就是真值，直接透传；
   * 契约尚未落地时按宿主现有字段降级推导，好让清单在改造期间的任何一刻都能报数
   * （推导不出 loading/unloading：那是安装过程中的瞬时态，装完就不该有人停在上面）。
   */
  _phase(rec) {
    if (typeof rec.phase === 'string' && PHASE_SET.has(rec.phase)) return rec.phase;
    if (rec.error) return 'failed';
    if (!rec.installed) return 'pending';
    return rec.enabled ? 'active' : 'pending';   // 已装但没启用：被跳过或被用户停用
  }

  /**
   * 被谁关掉。契约落地后以宿主的 offBy 为准（那是装这一刻的既成事实）；
   * 未落地时退回状态存储的实时判定，于是包级/单项两级的优先级在清单上照样看得见。
   */
  _offBy(rec, bundle) {
    if ('offBy' in rec) return rec.offBy == null ? null : String(rec.offBy);
    return this.state ? this.state.offByOf(rec.id, bundle) : null;
  }
}

export default PluginInventory;
