// ══════════════════════════════════════════════════════════
// 器材能力位 —— 「这件器材的操作菜单里该出现哪些动作」的声明处
//
// 为什么要有这一层：菜单项此前是 UI **替器材猜**的（改前 src/ui/inspector.js 里
// `e.type === 'switch'` / `e.flame` / `e.vessel` 三个 if 直接决定按钮）。那三个特征今天
// 恰好对应三个动作，但它们不是同一件事：特征说的是「器材是什么」，能力位说的是「菜单里出现什么」。
// 同一特征在别的器材上未必意味着同一个动作，器材想改菜单就得回头改 UI ✗。
//
// 三层优先，**按位**合并（先声明的赢）：
//   ① `def.caps` —— 器材自己声明（器材包派生出的器材也能写，见 registry.derive）
//   ② `CAPS_BY_TYPE[type]` —— 本文件的中央表（本波按**实测的既有行为**逐件落表）
//   ③ `legacyCaps(e)` —— 兜底：**改前 UI 那三个特征判断逐字搬过来**，保证零行为变化
// 按位合并 ≠ 整体替换：只想关掉一位就显式写 `false`（探针 §② 有断言），没写的位继续往下找 ——
// 免得一件只声明了半边的器材把默认位（复制/删除）一起弄丢。
//
// ⚠ 键名是**我方语义**，不是 NB 的位表。NB 的 needSeparate / needRepair / needReversal /
//   needReset / needLeveling / needShowNei / canCopy / confArr / needRotate / canDelete 是它自己的
//   功能划分（出处 plans/16-NB物品交互方式对照.md）；照抄键名只会得到一个同形不同义的影子。
// ⚠ 键名不许撒谎：「有能力位」= 菜单里**出现**这个动作，不等于这个动作一定有效果。例：`ignite`
//   在酒精灯上是「点燃」、在加热板上是「开启」—— 文案由器材自己给（inspector.render）。
// ══════════════════════════════════════════════════════════

/** 能力位键名 → 语义。探针按这份名单校验：键名拼错要当场发现，不能静默失效。 */
export const CAP_KEYS = Object.freeze({
  toggle: '切换通断：开关类器材的导通 / 断开',
  ignite: '点燃 / 开启热源：热源器材的加热开关（文案由器材名与 props.lit 决定）',
  empty: '倒空容器：容器类器材把内容物倒掉',
  duplicate: '复制：复制一份这件器材',
  remove: '删除：把这件器材从实验台上移走',
});

/** 每一件器材都有的默认位（菜单里恒有「复制」与「删除」） */
export const DEFAULT_CAPS = Object.freeze({ duplicate: true, remove: true });

/**
 * 中央表：type → 能力位。只写与「默认位 + 兜底」不同的位。
 * 落表依据：`node tools/inspector-caps-probe.mjs` 每次运行都会把注册表**实测转储**
 * （哪件器材带 switch / flame / vessel 标记）与本表逐件对照，缺一件就红。
 */
export const CAPS_BY_TYPE = Object.freeze({
  // ── 开关（实测 type === 'switch'）──
  switch: { toggle: true },        // 开关
  // ── 热源：带 flame 标记（3 件）──
  alcohollamp: { ignite: true },   // 酒精灯
  hotplate: { ignite: true },      // 加热板
  boiler: { ignite: true },        // 沸腾装置
  // ── 容器：带 vessel 标记（11 件）──
  beaker: { empty: true },        // 烧杯
  testtube: { empty: true },      // 试管
  flask: { empty: true },         // 锥形瓶
  cylinder: { empty: true },      // 量筒
  crucible: { empty: true },      // 坩埚
  wastejar: { empty: true },      // 废液缸
  funnel: { empty: true },        // 漏斗
  gasjar: { empty: true },        // 集气瓶
  evapdish: { empty: true },      // 蒸发皿
  calorimeter: { empty: true },   // 量热器
  icebath: { empty: true },       // 冰水浴
});

/**
 * 兜底层：**改前 inspector.js 的逐字条件**（`e.type === 'switch'` / `e.flame` / `e.vessel`），
 * 只把「判断」挪到这里，语义一个字节没改 —— 只给三个**特征位**：改前「复制 / 删除」
 * 是无条件追加的，所以它们在 DEFAULT_CAPS 里，不是条件。
 * 它的意义是：任何没有声明能力位的器材（含用户器材包派生出来的那类 —— 注册表里没有
 * 它们的 type，中央表必然查不到）行为与改动前**完全相同**。
 */
export function legacyCaps(e) {
  return {
    toggle: e.type === 'switch',
    ignite: !!e.flame,
    empty: !!e.vessel,
  };
}

/**
 * 三层优先解析（按位合并）。第二个参数**只为判据注入**，生产调用一律不传 ——
 * 与 `engine` 的 `__XM_PAN_OFF__` 同一手法：要把「三层顺序」单独钉住时，
 * 不必往真表里塞测试件（真表必须始终等于实测行为）。
 */
export function menuCaps(e, opts) {
  const table = (opts && opts.table) || CAPS_BY_TYPE;
  const def = (e && e.def) || null;
  const central = table[(def && def.type) || (e && e.type)] || null;
  const own = (def && def.caps) || null;
  // 兜底层是**底**，必须真的在合并里：漏掉它的写法（只合并 默认位 + 中央表 + 声明）会让
  // 「注册表里没有 type 的器材」当场掉按钮 —— 用户器材包派生的器材正属此类
  // （中央表按 type 查，派生出的新 type 查不到）。这条是被探针 §④ 的红测逼出来的，不是推测。
  return { ...DEFAULT_CAPS, ...legacyCaps(e), ...(central || {}), ...(own || {}) };
}

/**
 * 「这件器材还在台面上吗」—— 删除后的残留引用（面板还挂着刚被删掉的那一件）不该再动它。
 * `world.remove()` 只是把它从 entities / byId 里摘掉（**不置标志位**），所以判据只能是
 * 「台面上现在这一件还是不是它」。没有 world / 没有查找接口时**不拦**：判据只按能证明的来。
 */
function gone(app, ent) {
  if (!ent) return true;
  if (ent.alive === false) return true;
  const w = app && app.world;
  if (w && typeof w.get === 'function' && w.get(ent.id) !== ent) return true;
  return false;
}

/**
 * 能力位 → 动作的**唯一定义处**。
 *
 * 为什么要有它：这五个动作原本是 `src/ui/inspector.js` 里的五个内联闭包（一个都没导出），
 * 于是「就地浮出控制条」（src/ui/equipbar.js）只能把同一套原语再抄一遍 —— 两个 UI 面各有一份
 * 「位 → 动作」的定义，同一个按钮在两处迟早做不同的事（第一份实测差异：浮出条对复制/删除
 * 额外 markDirty，而面板侧改前不 markDirty —— 抄一份就漂一格）。
 *
 * 语义与改前那五个内联闭包**逐位相同**（全量逐件、逐位对照见
 * tools/inspector-caps-probe.mjs §⑦），差别只有一处：视图重绘由调用方经第四个参数传进来
 * （旧闭包里的 `this.render()`），动作本身不带视图依赖 —— 面板与浮出条各有各的刷新方式。
 *
 *   · 先看位：`menuCaps(ent)[key]` 为假 ⇒ 什么都不做，返回 false（这件器材没有这个动作）
 *   · 位为真 ⇒ 调**同一个原语**，刷新与 markDirty 的**次数与顺序**都与改前一致：
 *     切换 / 点燃 / 倒空 = 原语 → refresh() → app.markDirty()
 *     复制 / 删除 = 只调 app（**不**刷新、**不** markDirty：世界的 add/remove 自己 emit SCENE_DIRTY）
 *   · 已删除的实体：不动、不抛错，返回 false
 *
 * @param {object} app    宿主（用到 app.duplicate / app.removeEntity / app.markDirty / app.world）
 * @param {object} ent    器材实体
 * @param {string} key    能力位键名（见 CAP_KEYS）
 * @param {Function} [refresh] 视图重绘回调（面板传 () => this.render()）
 * @returns {boolean} 是否真的执行了动作
 */
export function applyCap(app, ent, key, refresh) {
  if (gone(app, ent)) return false;
  if (!menuCaps(ent)[key]) return false;
  const view = typeof refresh === 'function' ? refresh : null;
  const after = () => { if (view) view(); if (app && typeof app.markDirty === 'function') app.markDirty(); };
  switch (key) {
    case 'toggle':
      if (typeof ent.toggle !== 'function') return false;
      ent.toggle(); after(); return true;
    case 'ignite':
      if (!ent.props) return false;
      ent.props.lit = !ent.props.lit; after(); return true;
    case 'empty':
      if (!ent.vessel || typeof ent.vessel.empty !== 'function') return false;
      ent.vessel.empty(); after(); return true;
    case 'duplicate':
      if (!app || typeof app.duplicate !== 'function') return false;
      app.duplicate(ent); return true;
    case 'remove':
      if (!app || typeof app.removeEntity !== 'function') return false;
      app.removeEntity(ent); return true;
    default:
      return false;
  }
}
