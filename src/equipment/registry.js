// ══════════════════════════════════════════════════════════
// 器材注册表 —— 插件宿主注册表的转发层
//
// 器材模块保持原有写法（顶层调用 define(def)），
// 只要把它们包进插件的 setup() 里，define 就会自动写进
// 当前插件作用域的注册表。这是「一切皆插件」的接缝。
// ══════════════════════════════════════════════════════════

import { currentRegistry } from '../core/plugin.js';

/** 宿主启动时把它自己的 equipment 注册表设进来，作为无作用域时的兜底 */
let DEFAULT = null;
export function bindRegistry(reg) { DEFAULT = reg; }
function target() { return currentRegistry() || DEFAULT; }

export function define(def) {
  const reg = target();
  if (!reg) throw new Error('[registry] 没有可用注册表：define() 必须在插件 setup() 内调用');
  if (!def.type) throw new Error('器材定义缺少 type');
  def.w = def.w || 64;
  def.h = def.h || 64;
  def.ports = def.ports || [];
  def.defaults = def.defaults || {};
  def.state = def.state || {};
  def.fields = def.fields || [];
  def.cat = def.cat || '其他';
  def.icon = def.icon || '□';
  return reg.define(def);
}

export const get = (t) => { const r = target(); return r ? r.get(t) : null; };
export const has = (t) => { const r = target(); return r ? r.has(t) : false; };
export const list = () => { const r = target(); return r ? r.list() : []; };
export const count = () => { const r = target(); return r ? r.size : 0; };
export const onChange = (fn) => { const r = target(); return r ? r.onChange(fn) : () => {}; };

export function create(type, x = 0, y = 0) {
  const d = get(type);
  if (!d) { console.warn('[registry] 未知器材: ' + type); return null; }
  return d.create ? d.create(x, y) : null;
}

/** 卸下某件器材（卸载器材包时用） */
export function remove(type) {
  const reg = target();
  if (!reg || typeof reg.remove !== 'function') return false;
  return reg.remove(type);
}

/**
 * 从原型派生出一件新器材 —— 器材包就靠它落地。
 *
 * 派生定义继承原型的全部行为（step / render / circuitBranch / 物理化学耦合…），
 * 只覆盖名称、几何、端口、默认参数与字段。
 * 因为所有器材的 create 都是 `new Xxx(def, x, y)`，把 def 换掉即可，
 * 所以器材包是**纯数据**：不解压脚本、不 eval、不 import，天然安全。
 */
export function derive(entry, pack) {
  const base = get(entry.proto);
  if (!base) throw new Error(`器材「${entry.name || entry.type}」引用了不存在的原型「${entry.proto}」`);
  if (get(entry.type)) throw new Error(`器材标识「${entry.type}」已被占用`);

  const def = {
    ...base,
    type: entry.type,
    name: entry.name || base.name,
    icon: entry.icon || base.icon,
    domain: entry.domain || base.domain,
    cat: entry.cat || base.cat,
    desc: entry.desc || base.desc,
    tags: [...(base.tags || []), ...(entry.tags || [])],
    w: entry.w ?? base.w,
    h: entry.h ?? base.h,
    ports: entry.ports ? entry.ports.map(p => ({ ...p })) : (base.ports || []).map(p => ({ ...p })),
    fields: entry.fields || base.fields,
    // 自报统计量（B4 / plans/11 §6.4）：**必须**在这份白名单里，否则器材包既无法声明统计量、
    // 也无法改它的标签与单位 —— 它是接口的一部分，不是可选优化。
    stats: entry.stats || base.stats,
    defaults: { ...base.defaults, ...(entry.defaults || {}) },
    state: { ...base.state, ...(entry.state || {}) },
    pack: pack ? pack.id : entry.pack,
    packName: pack ? pack.name : undefined,
    derived: true,
  };

  const make = base.create;
  def.create = (x, y) => {
    const inst = make(x, y);
    if (!inst) return inst;
    inst.def = def;
    if (inst.props) Object.assign(inst.props, def.defaults);
    if (inst.vessel && def.defaults.capacity != null) inst.vessel.capacity = def.defaults.capacity;
    return inst;
  };

  return define(def);
}

/**
 * 按域/关键字过滤，返回 [{domain, cat, items:[def]}]
 * 域顺序由插件声明的 domainOrder 决定，未知域排在最后。
 */
const DOMAIN_RANK = { physics: 0, chemistry: 1, bridge: 2 };

export function groups({ domain = 'all', q = '' } = {}) {
  const kw = q.trim().toLowerCase();
  const hit = list().filter(d => {
    if (domain !== 'all' && d.domain !== domain) return false;
    if (!kw) return true;
    return (d.name + d.type + d.cat + (d.desc || '') + (d.tags || []).join(''))
      .toLowerCase().includes(kw);
  });

  const order = [];
  const map = new Map();
  for (const d of hit) {
    const k = d.domain + '/' + d.cat;
    if (!map.has(k)) { map.set(k, []); order.push(k); }
    map.get(k).push(d);
  }
  order.sort((a, b) => {
    const [da] = a.split('/'), [db] = b.split('/');
    return (DOMAIN_RANK[da] ?? 9) - (DOMAIN_RANK[db] ?? 9);
  });
  return order.map(k => ({
    domain: k.split('/')[0],
    cat: k.split('/')[1],
    items: map.get(k),
  }));
}
