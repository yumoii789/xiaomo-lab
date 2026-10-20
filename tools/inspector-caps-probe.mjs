// ══════════════════════════════════════════════════════════
// 无头验证：器材能力位 —— 菜单项由器材声明（def.caps → 中央表 → 兜底），行为逐位不变
//
//   node tools/inspector-caps-probe.mjs
//   node tools/inspector-caps-probe.mjs --mutate     # 每个变异体只许让它那一层所在的节变红
//
// 第一判据是「注册表里每一件器材的菜单项一个都不许变」：
//   BEFORE_RAW 是**改动前**的真实 src/ui/inspector.js 跑出来的逐件转储（同一台无头 DOM 替身，
//   每件器材两种点火状态各跑一次），§① 拿**改后**的真实 render() 输出与它逐件对照。
//   它冻结的是**读数**而不是算法，所以另有一条独立的链：§① 同时用 oldMenu()（改前那三个 if 的
//   逐字副本）与 BEFORE_RAW 再对拍一次 —— 读数与算法互相钉住，任一条链被手抄改动都会红。
//   ⚠ 基线不许「跑一遍新代码重新生成」：要更新它，先得证明菜单项**本来就该变**。
//
// ⚠ 件数口径：本探针**不写死数字**，一律按注册表实测。task-17 当时四种装载集合（器材单独装、加主题
//   与规则、加预设、加器材包）都是 117；此后树里其他写者的在途改动又加过器材 ⇒ 同一份探针今天实测
//   119 件（§① 对新增件**白名单显式点名**：名单外多一件就红；§⑦ 直接按当次的实测件数铺开）。任务书写的是 118，
//   那 1 件的口径见 §⑥ 的 info 行（本探针只报实测，不猜）。
//
// ⚠ 为什么「中央表生效」要靠**注入表**才测得到：今天中央表的内容与兜底特征**逐件等价**
//   （这正是零行为变化的原因），所以中央表被整条忽略时，真实器材的菜单项**一点都不变** ✗。
//   要让那一层能红，唯一的办法是注入一张与兜底故意不同的小表（menuCaps(e, { table })，
//   与 engine 的 __XM_PAN_OFF__ 同一手法：只判据用，生产调用不传第二个参数）。
//
// task-21 追加：§⑦ applyCap ≡ 改动前五个内联闭包（逐件逐位：动作/顺序/次数/状态）+ 非空转对照，
//   §⑧ 五个位各一条（位为真时调用的就是它自己的原语），§⑨ 边界（位为假 / 已删除 / 二次调用）。
//   ⚠ 条目数会因此上升：零回归清单里这一条的 expect 需要同步（清单是 Lead 的写域，本探针不改它）。
//
// 绿：全部通过：N 项（exit 0）／红：合计 N 项，失败 M 项（exit 1）
// ══════════════════════════════════════════════════════════

import { cpSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TMP = process.env.TEMP || '/tmp';
const MUTATE = process.argv.includes('--mutate');

// ── 最小 DOM 替身（与 tools/inspector-probe.mjs 同款：Inspector 只用到这四个方法）──
const mkEl = (tag) => ({
  tagName: tag, className: '', textContent: '', children: [], isFragment: false,
  appendChild(n) { this.children.push(n); return n; },
  addEventListener() {},
  replaceChildren(...ns) {
    const flat = [];
    for (const n of ns) {
      if (Array.isArray(n)) flat.push(...n);
      else if (n && n.isFragment) flat.push(...n.children);
      else if (n) flat.push(n);
    }
    this.children = flat;
  },
});
globalThis.document = {
  createElement: mkEl,
  createDocumentFragment: () => Object.assign(mkEl('#fragment'), { isFragment: true }),
};

/** 把 src/ 整份摊进临时目录再覆盖若干文件（变体树自包含，相对 import 照常解析） */
function stageTree(name) {
  const dir = join(TMP, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  cpSync(join(ROOT, 'src'), join(dir, 'src'), { recursive: true });
  return dir;
}

async function loadTarget(root, tag) {
  const u = (rel) => pathToFileURL(join(root, rel)).href;
  const { PluginHost } = await import(u('src/core/plugin.js'));
  const { Entity } = await import(u('src/core/entity.js'));
  const reg = await import(u('src/equipment/registry.js'));
  const { equipmentPlugins } = await import(u('src/equipment/index.js'));
  const caps = await import(u('src/equipment/caps.js'));
  const { Inspector } = await import(u('src/ui/inspector.js'));
  const physicsPlugin = (await import(u('src/physics/circuit.js'))).default;
  const chemistryPlugin = (await import(u('src/chemistry/reactions.js'))).default;
  const bridgePlugin = (await import(u('src/coupling/bridge.js'))).default;
  const bootApp = {
    services: {}, ticks: [], world: null, lastCircuit: null, selected: null,
    log: { push() {}, clear() {} }, toast() {},
    addTick(fn) { this.ticks.push(fn); return () => {}; },
  };
  const host = new PluginHost(bootApp);
  for (const p of [physicsPlugin, chemistryPlugin, bridgePlugin, ...equipmentPlugins]) host.define(p);
  host.installAll();
  reg.bindRegistry(host.registry('equipment'));
  return { tag, root, Entity, caps, Inspector, create: reg.create, list: reg.list, define: reg.define };
}

/** 操作区按钮文案（跑**真实** render()，读法与 tools/inspector-probe.mjs 一致） */
const appStub = { world: { get: () => null }, markDirty() {}, duplicate() {}, removeEntity() {} };
function buttons(T, e) {
  const ins = new T.Inspector(mkEl('div'), appStub);
  ins.ent = e;
  ins.render();
  const btns = ins.root.children.find((n) => n.className === 'btns');
  return btns ? btns.children.map((b) => b.textContent) : [];
}

/**
 * 改动前的逐件读数（冻结基线）。格式：type \t name \t 特征标记(S/F/V) \t lit=false \t lit=true
 * 产生方式：改动前用同一台 DOM 替身跑真实 render()。**不是手抄的**。
 */
const BEFORE_RAW = `battery	干电池	---	复制,删除	复制,删除
switch	开关	S--	切换通断,复制,删除	切换通断,复制,删除
lamp	小灯泡	---	复制,删除	复制,删除
resistor	定值电阻	---	复制,删除	复制,删除
rheostat	滑动变阻器	---	复制,删除	复制,删除
ammeter	电流表	---	复制,删除	复制,删除
voltmeter	电压表	---	复制,删除	复制,删除
multimeter	多用电表	---	复制,删除	复制,删除
thermistor	热敏电阻	---	复制,删除	复制,删除
heater	电热丝	---	复制,删除	复制,删除
motor	电动机	---	复制,删除	复制,删除
beaker	烧杯	--V	倒空容器,复制,删除	倒空容器,复制,删除
testtube	试管	--V	倒空容器,复制,删除	倒空容器,复制,删除
flask	锥形瓶	--V	倒空容器,复制,删除	倒空容器,复制,删除
cylinder	量筒	--V	倒空容器,复制,删除	倒空容器,复制,删除
alcohollamp	酒精灯	-F-	点燃酒精灯,复制,删除	熄灭酒精灯,复制,删除
ironstand	铁架台	---	复制,删除	复制,删除
electrode	电极	---	复制,删除	复制,删除
thermometer	温度计	---	复制,删除	复制,删除
phmeter	pH 计	---	复制,删除	复制,删除
glassrod	玻璃棒	---	复制,删除	复制,删除
balance	电子天平	---	复制,删除	复制,删除
phpaper	pH 试纸	---	复制,删除	复制,删除
reagent-H2O	水	---	复制,删除	复制,删除
reagent-C2H5OH	乙醇	---	复制,删除	复制,删除
reagent-HCl	稀盐酸	---	复制,删除	复制,删除
reagent-H2SO4	稀硫酸	---	复制,删除	复制,删除
reagent-HNO3	稀硝酸	---	复制,删除	复制,删除
reagent-CH3COOH	醋酸	---	复制,删除	复制,删除
reagent-NaOH	氢氧化钠溶液	---	复制,删除	复制,删除
reagent-KOH	氢氧化钾溶液	---	复制,删除	复制,删除
reagent-Ca(OH)2	石灰水	---	复制,删除	复制,删除
reagent-NH3H2O	氨水	---	复制,删除	复制,删除
reagent-CuSO4	硫酸铜溶液	---	复制,删除	复制,删除
reagent-CuCl2	氯化铜溶液	---	复制,删除	复制,删除
reagent-FeSO4	硫酸亚铁溶液	---	复制,删除	复制,删除
reagent-FeCl3	氯化铁溶液	---	复制,删除	复制,删除
reagent-KMnO4	高锰酸钾溶液	---	复制,删除	复制,删除
reagent-NaCl	氯化钠溶液	---	复制,删除	复制,删除
reagent-KCl	氯化钾溶液	---	复制,删除	复制,删除
reagent-ZnSO4	硫酸锌溶液	---	复制,删除	复制,删除
reagent-MgSO4	硫酸镁溶液	---	复制,删除	复制,删除
reagent-Na2SO4	硫酸钠溶液	---	复制,删除	复制,删除
reagent-Na2CO3	碳酸钠溶液	---	复制,删除	复制,删除
reagent-NaHCO3	碳酸氢钠溶液	---	复制,删除	复制,删除
reagent-AgNO3	硝酸银溶液	---	复制,删除	复制,删除
reagent-BaCl2	氯化钡溶液	---	复制,删除	复制,删除
reagent-H2O2	过氧化氢溶液	---	复制,删除	复制,删除
reagent-Zn	锌粒	---	复制,删除	复制,删除
reagent-Fe	铁钉	---	复制,删除	复制,删除
reagent-Mg	镁条	---	复制,删除	复制,删除
reagent-Al	铝片	---	复制,删除	复制,删除
reagent-Cu	铜片	---	复制,删除	复制,删除
reagent-Ag	银片	---	复制,删除	复制,删除
reagent-CuO	氧化铜	---	复制,删除	复制,删除
reagent-MnO2	二氧化锰	---	复制,删除	复制,删除
reagent-CaO	生石灰	---	复制,删除	复制,删除
reagent-CaCO3	碳酸钙	---	复制,删除	复制,删除
reagent-Phenolphthalein	酚酞试液	---	复制,删除	复制,删除
reagent-Litmus	石蕊试液	---	复制,删除	复制,删除
crucible	坩埚	--V	倒空容器,复制,删除	倒空容器,复制,删除
wastejar	废液缸	--V	倒空容器,复制,删除	倒空容器,复制,删除
testtuberack	试管架	---	复制,删除	复制,删除
tripod	三脚架	---	复制,删除	复制,删除
ironring	铁圈	---	复制,删除	复制,删除
asbestosnet	石棉网	---	复制,删除	复制,删除
spatula	药匙	---	复制,删除	复制,删除
crucibletong	坩埚钳	---	复制,删除	复制,删除
dropper	滴瓶	---	复制,删除	复制,删除
washbottle	洗瓶	---	复制,删除	复制,删除
funnel	漏斗	--V	倒空容器,复制,删除	倒空容器,复制,删除
gasjar	集气瓶	--V	倒空容器,复制,删除	倒空容器,复制,删除
evapdish	蒸发皿	--V	倒空容器,复制,删除	倒空容器,复制,删除
titrant	滴定管	---	复制,删除	复制,删除
inclinetrack	斜面	---	复制,删除	复制,删除
springbob	弹簧振子	---	复制,删除	复制,删除
pendulum	单摆	---	复制,删除	复制,删除
cartrack	小车	---	复制,删除	复制,删除
freefall	自由落体管	---	复制,删除	复制,删除
lever	杠杆	---	复制,删除	复制,删除
pulley	滑轮组	---	复制,删除	复制,删除
frictionblock	摩擦块	---	复制,删除	复制,删除
accelerometer	三轴加速度计	---	复制,删除	复制,删除
hotplate	加热板	-F-	开启加热板,复制,删除	关闭加热板,复制,删除
calorimeter	量热器	--V	倒空容器,复制,删除	倒空容器,复制,删除
conductionbar	热传导棒	---	复制,删除	复制,删除
icebath	冰水浴	--V	倒空容器,复制,删除	倒空容器,复制,删除
boiler	沸腾装置	-F-	开启沸腾装置,复制,删除	关闭沸腾装置,复制,删除
expansionball	热膨胀球环	---	复制,删除	复制,删除
lightsource	平行光源/激光	---	复制,删除	复制,删除
convexlens	凸透镜	---	复制,删除	复制,删除
screen	光屏	---	复制,删除	复制,删除
planemirror	平面镜	---	复制,删除	复制,删除
watertank	水槽（折射）	---	复制,删除	复制,删除
prism	三棱镜	---	复制,删除	复制,删除
resistorcap	电容（RC 电路）	---	复制,删除	复制,删除
inductorcoil	电感线圈（RL 电路）	---	复制,删除	复制,删除
acsource	交流电源	---	复制,删除	复制,删除
oscilloscope	示波器	---	复制,删除	复制,删除
transformer	变压器	---	复制,删除	复制,删除
diode	二极管	---	复制,删除	复制,删除
photoresistor	光敏电阻	---	复制,删除	复制,删除
photodiode	光敏二极管	---	复制,删除	复制,删除
npn	NPN 三极管	---	复制,删除	复制,删除
pnp	PNP 三极管	---	复制,删除	复制,删除
nmos	N 沟道 MOSFET	---	复制,删除	复制,删除
pmos	P 沟道 MOSFET	---	复制,删除	复制,删除
tuningfork	音叉	---	复制,删除	复制,删除
resonancetube	共鸣管	---	复制,删除	复制,删除
soundlevel	分贝计	---	复制,删除	复制,删除
waveform	波形显示	---	复制,删除	复制,删除
barmagnet	条形磁铁	---	复制,删除	复制,删除
compass	指南针	---	复制,删除	复制,删除
charge	正负电荷	---	复制,删除	复制,删除
testcharge	检验电荷	---	复制,删除	复制,删除
efield	匀强电场	---	复制,删除	复制,删除
bfield	匀强磁场	---	复制,删除	复制,删除`;

const BEFORE = new Map(BEFORE_RAW.split('\n').filter(Boolean).map((l) => {
  const p = l.split('\t');
  return [p[0], { name: p[1], flags: p[2], off: p[3], on: p[4] }];
}));

/** 改前 inspector.js「操作」区那三个 if 的逐字副本（含文案推导）—— 只在这个探针里出现 */
function oldMenu(e) {
  const out = [];
  if (e.type === 'switch') out.push('切换通断');
  if (e.flame) {
    const noun = e.name || '加热器';
    const verb = /灯/.test(noun) ? (e.props.lit ? '熄灭' : '点燃') : (e.props.lit ? '关闭' : '开启');
    out.push(verb + noun);
  }
  if (e.vessel) out.push('倒空容器');
  out.push('复制');
  out.push('删除');
  return out;
}

/** 一件替身器材（注册进**当前树**的注册表）。extra 给特征，capsDecl 给器材自己的声明。 */
function standIn(T, type, opts) {
  const o = opts || {};
  const def = { type: type, name: o.name || ('替身' + type), cat: '其他', domain: 'physics', w: 40, h: 40 };
  if (o.caps) def.caps = o.caps;
  const mk = () => Object.assign(new T.Entity(def, 0, 0), o.extra || {});
  T.define(Object.assign({}, def, { create: mk }));
  return T.create(type, 0, 0);
}

/** 整段注释行剥离（与仓库其他探针同款：只剥**整行**注释） */
/**
 * 冻结：改动前 src/ui/inspector.js 里五个内联闭包的**逐字副本**（只把 `this.render()` 抽成
 * refresh 参数，其余一字不改）—— §⑦ 拿它与 caps.applyCap 逐件逐位对拍。读数与算法互钉：
 * 一边是今天的真实现，一边是这段冻结的历史，任一边被改动都会红。
 */
const OLD_ACTIONS = {
  toggle: (app, e, refresh) => { e.toggle(); refresh(); app.markDirty(); },
  ignite: (app, e, refresh) => { e.props.lit = !e.props.lit; refresh(); app.markDirty(); },
  empty: (app, e, refresh) => { e.vessel.empty(); refresh(); app.markDirty(); },
  duplicate: (app, e) => app.duplicate(e),
  remove: (app, e) => app.removeEntity(e),
};

/**
 * 记录型宿主：谁被调用、调了几次、作用在谁身上全记下来。world 用真查找表
 * （applyCap 用 `world.get(ent.id)` 判断「这件器材还在不在台面上」）。
 */
function recApp(ents) {
  const log = [];
  const list = ents || [];
  return {
    log,
    world: { entities: list, get: (id) => list.find((x) => x.id === id) || null },
    markDirty() { log.push('app.markDirty'); },
    duplicate(e) { log.push('app.duplicate:' + e.type); },
    removeEntity(e) { log.push('app.removeEntity:' + e.type); },
  };
}

/**
 * state 里**天生不确定**的键：同型两件新器材的初值就不一样的那些（如酒精灯/加热板的 flick 随机数）。
 * 不写死键名 —— 判据自己测量：动作对它们的**数值**没有可比较的语义，只有「被改没被改」才有。
 */
const VOLATILE = new Map();
function volatileKeys(T, type) {
  if (!VOLATILE.has(type)) {
    const a = T.create(type, 0, 0), b = T.create(type, 0, 0);
    const ks = [...new Set([...Object.keys(a.state), ...Object.keys(b.state)])];
    VOLATILE.set(type, ks.filter((k) => JSON.stringify(a.state[k]) !== JSON.stringify(b.state[k])));
  }
  return VOLATILE.get(type);
}

/** 可观察状态：props 逐字节 + state（天生不确定的键只留结构，不留数值；id 这类每次新建都不同的字段本就不在快照里） */
function snapE(T, e) {
  const vol = volatileKeys(T, e.type);
  const state = {};
  for (const k of Object.keys(e.state).sort()) state[k] = vol.indexOf(k) >= 0 ? '<volatile>' : e.state[k];
  return JSON.stringify({ props: e.props, state });
}

/**
 * 跑一次「位 → 动作」，返回可观察结果：原语调用轨迹 + props/state 快照。
 *   opts.useNew=true  用 caps.applyCap；false 用上面那段冻结的旧闭包
 *   opts.act          直接指定动作者（§⑦ 的非空转对照用：故意接错的那一个）
 *   opts.lit          设 props.lit 初值；opts.times 连按几次（§⑨ 的不叠副作用）
 */
function traceAction(T, type, key, opts) {
  const o = opts || {};
  const e = T.create(type, 0, 0);
  const app = recApp([e]);
  const log = app.log;
  if (o.lit !== undefined) e.props.lit = o.lit;
  if (typeof e.toggle === 'function') { const f = e.toggle; e.toggle = () => { log.push('ent.toggle'); return f.call(e); }; }
  // this 必须绑到 vessel 本身（VesselModel 的方法），绑到实体上会读不到内容物
  if (e.vessel && typeof e.vessel.empty === 'function') {
    const f = e.vessel.empty;
    e.vessel.empty = () => { log.push('ent.vessel.empty'); return f.call(e.vessel); };
  }
  const refresh = () => log.push('view.render');
  const act = o.act || (o.useNew
    ? ((a, x, r) => T.caps.applyCap(a, x, key, r))
    : OLD_ACTIONS[key]);
  const before = snapE(T, e);
  let ret;
  for (let i = 0; i < (o.times || 1); i++) ret = act(app, e, refresh);
  return { log: log.join(' | '), before, after: snapE(T, e), ret };
}

const stripComments = (s) => s.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

// ══════════════════════════════════════════════════════════
// 断言套件（可重复跑：绿档一次，每个变异体各一次）
// ══════════════════════════════════════════════════════════
async function runSuite(T, opt) {
  const o = opt || {};
  const verbose = o.verbose !== false;
  const S = { pass: 0, fail: 0, failed: [], failSec: [], secTotal: {}, notes: [] };
  let curSec = '?';
  const ok = (cond, msg) => {
    S.secTotal[curSec] = (S.secTotal[curSec] || 0) + 1;
    if (cond) { S.pass++; if (verbose) console.log('  \x1b[32m✓\x1b[0m ' + msg); }
    else { S.fail++; S.failed.push(msg); S.failSec.push(curSec); console.log('  \x1b[31m✗\x1b[0m ' + msg); }
  };
  const head = (t) => { curSec = t.trim().charAt(0); if (verbose) console.log('\n\x1b[36m' + t + '\x1b[0m'); };
  const info = (t) => { S.notes.push(t); if (verbose) console.log('    · ' + t); };
  const KEY3 = ['toggle', 'ignite', 'empty'];

  const ALL = T.list();                            // 注册表实测（不写死件数）；必须在注册替身**之前**取
  const CAP_KEYS = Object.keys(T.caps.CAP_KEYS);

  // ⚠ 整段断言区包在 try 里：变异体可能把前置假设破坏到「直接抛错」（例如撤掉空引用守卫后
  //   menuCaps(null) 会抛）。抛错也要落成**当前那一节的一条红**，否则整份套件中止、没有对齐判据。
  try {

  // ── ① 全量逐件对照 ──────────────────────────────────────────
  head('① 全量逐件对照：改后真实 render() ≡ 改动前冻结读数（菜单项一个都不许变）');
  {
    const badRender = [], badFrozen = [], added = [];
    let rows = 0;
    for (const d of ALL) {
      const base = BEFORE.get(d.type);
      if (!base) { added.push(d.type); continue; }
      const e = T.create(d.type, 0, 0);
      e.props.lit = false;
      const off = buttons(T, e).join(',');
      const oldOff = oldMenu(e).join(',');
      e.props.lit = true;
      const on = buttons(T, e).join(',');
      const oldOn = oldMenu(e).join(',');
      rows += 2;
      if (off !== base.off) badRender.push(d.type + ' lit=false 实测 ' + off + ' vs 基线 ' + base.off);
      if (on !== base.on) badRender.push(d.type + ' lit=true 实测 ' + on + ' vs 基线 ' + base.on);
      if (oldOff !== base.off) badFrozen.push(d.type + ' lit=false 逐字副本 ' + oldOff + ' vs 基线 ' + base.off);
      if (oldOn !== base.on) badFrozen.push(d.type + ' lit=true 逐字副本 ' + oldOn + ' vs 基线 ' + base.on);
    }
    ok(badRender.length === 0,
      '逐件对照：' + (rows / 2) + ' 件 × 2 态 = ' + rows + ' 次，菜单项全部与改动前相同'
      + (badRender.length ? '；不同 ' + badRender.length + ' 处，第一处：' + badRender[0] : ''));
    ok(badFrozen.length === 0,
      '读数与算法互相钉住：oldMenu() 逐字副本 ≡ 冻结基线同样 ' + rows + ' 次'
      + (badFrozen.length ? '；不符 ' + badFrozen.length + ' 处，第一处：' + badFrozen[0] : ''));
    const missing = [...BEFORE.keys()].filter((t) => !ALL.some((d) => d.type === t));
    ok(missing.length === 0,
      '基线的 ' + BEFORE.size + ' 件器材今天都还在注册表里'
      + (missing.length ? '；缺 ' + missing.length + ' 件：' + missing.slice(0, 6).join(' ') : ''));
    // 新增件必须**显式点名**：既不许「静默跳过」，也不许「默默多出来」。
    // 名单外多一件就红 —— 谁加器材谁在这里登记一次，「老器材一件没被顺手改坏」与「新增是故意的」各得一条判据。
    const NEW_OK = ['spdt', 'led'];   // task-21 期间另一位写者落的两件：单刀双掷开关 / 发光二极管
    const unexpected = added.filter((t) => NEW_OK.indexOf(t) < 0);
    const notYet = NEW_OK.filter((t) => !ALL.some((d) => d.type === t));
    ok(unexpected.length === 0 && notYet.length === 0,
      '新增件只在白名单里：注册表比冻结基线多的 ' + added.length + ' 件 = 名单 ' + NEW_OK.join(' ')
      + (unexpected.length ? '；✗ 名单外的：' + unexpected.slice(0, 6).join(' ') : '')
      + (notYet.length ? '；✗ 名单里还没注册的：' + notYet.join(' ') : ''));
    ok(added.length === NEW_OK.length,
      '除白名单 ' + NEW_OK.length + ' 件外，其余 ' + BEFORE.size + ' 件逐件都有冻结基线（' + rows + ' 次对照不是「跳过新件」换来的）'
      + (added.length !== NEW_OK.length ? '；实测新增 ' + added.length + ' 件：' + added.join(' ') : ''));
    info('白名单新增件的菜单项（本阶段不纳入冻结基线，按 §⑤/§⑥ 口径判）：'
      + added.map((t) => t + ' → ' + buttons(T, T.create(t, 0, 0)).join(',')).join(' '));
    // 非空转对照：比较器真的会判「不同」吗 —— 当场把基线改一个按钮，同一比较必须不成立
    const d0 = ALL.find((d) => BEFORE.has(d.type));
    const e0 = T.create(d0.type, 0, 0);
    e0.props.lit = false;
    const b0 = BEFORE.get(d0.type);
    ok(buttons(T, e0).join(',') !== b0.off + ',多余按钮',
      '对拍有鉴别力（非空转对照）：基线人为多一个按钮时同一比较判为不同（' + d0.type + ' 实测 ' + buttons(T, e0).join(',') + '）');
  }

  // ── ② 器材自己的声明覆盖中央表 ──────────────────────────────
  head('② def.caps 覆盖中央表（声明权在器材手里）');
  {
    const t = 'capsprobe-declares';
    const own = standIn(T, t, { name: '替身声明件', caps: { toggle: false } });
    const inj = {}; inj[t] = { toggle: true, ignite: true };
    const b = T.caps.menuCaps(own, { table: inj });
    ok(inj[t].toggle === true && b.toggle === false,
      '同一张表声明 toggle=true，器材自己声明 false ⇒ 位为假（器材说了算）');
    ok(b.ignite === true, '没被器材覆盖的位仍来自中央表（ignite=true）');
    const t4 = 'capsprobe-nodupe';
    const nodupe = standIn(T, t4, { caps: { duplicate: false } });
    ok(buttons(T, nodupe).join(',') === '删除',
      '显式 false 关掉默认位：菜单里没有「复制」（实测 ' + buttons(T, nodupe).join(',') + '）');
    const t5 = 'capsprobe-lit';
    const lit = standIn(T, t5, { name: '替身热源', caps: { ignite: true } });
    const m5 = buttons(T, lit);
    ok(m5[0] === '开启替身热源',
      '缝真的通到 UI：替身**没有** flame 特征，只凭 def.caps 就拿到热源按钮（实测 ' + m5.join(',') + '）');
  }

  // ── ③ 中央表覆盖兜底 ────────────────────────────────────────
  head('③ 中央表覆盖兜底（按位合并，不丢默认位）');
  {
    const t = 'capsprobe-flat';
    const flat = standIn(T, t, { name: '替身平件' });
    const L = T.caps.legacyCaps(flat);
    ok(L.toggle === false && L.ignite === false && L.empty === false,
      '阴性对照：替身没有任何特征 ⇒ 兜底给的三个位都是 false（「覆盖」才有意义）');
    const inj = {}; inj[t] = { toggle: true };
    const a = T.caps.menuCaps(flat, { table: inj });
    ok(a.toggle === true, '注入表声明 toggle ⇒ 位为真（兜底本来是 false，说明表真的被读到了）');
    ok(a.duplicate === true && a.remove === true,
      '按位合并不丢默认位：表里只写了 toggle，复制/删除仍在（' + JSON.stringify(T.caps.DEFAULT_CAPS) + '）');
  }

  // ── ④ 都没有 ⇒ 兜底（缺失声明不退化）────────────────────────
  head('④ 都没有 ⇒ 兜底：没有 caps 声明的器材行为与改动前完全相同');
  {
    const p = standIn(T, 'capsprobe-plain', { name: '替身平件C' });
    ok(buttons(T, p).join(',') === '复制,删除', '平件（无特征、无声明）⇒ 复制,删除（与改前逐字相同）');
    const f = standIn(T, 'capsprobe-hot', { name: '替身热源B', extra: { flame: true } });
    ok(buttons(T, f).join(',') === '开启替身热源B,复制,删除',
      '带 flame 特征但**没有**声明 ⇒ 仍然拿到热源按钮（兜底在兜）');
    ok(T.caps.menuCaps({ type: 'capsprobe-vessel', vessel: {} }).empty === true,
      '兜底层的容器位仍然看 vessel 特征（menuCaps({vessel:{}}) ⇒ empty=true）');
    ok(T.caps.legacyCaps({ type: 'switch' }).toggle === true,
      '兜底层的开关位仍然看 type === "switch"');
    const none = standIn(T, 'capsprobe-none');
    const c = T.caps.menuCaps(none);
    const want = { toggle: false, ignite: false, empty: false, duplicate: true, remove: true };
    ok(CAP_KEYS.every((k) => c[k] === want[k]),
      '都没有 ⇒ 兜底：' + CAP_KEYS.length + ' 个键等于显式期望（默认位真、三个特征位假）；实测 '
      + CAP_KEYS.map((k) => k + '=' + c[k]).join(' '));
  }

  // ── ⑤ 中央表 ≡ 实测特征（表漂移 = 静默行为变化）──────────────
  head('⑤ 中央表与实测特征逐件对齐（表不许漂移）');
  {
    const drift = [];
    for (const d of ALL) {
      const e = T.create(d.type, 0, 0);
      const want = { toggle: e.type === 'switch', ignite: !!e.flame, empty: !!e.vessel };
      const got = T.caps.menuCaps(e);
      for (const k of KEY3) if (want[k] !== !!got[k]) drift.push(d.type + '.' + k + ' 特征 ' + want[k] + ' vs 解析 ' + !!got[k]);
    }
    ok(drift.length === 0,
      ALL.length + ' 件 × ' + KEY3.length + ' 个位：中央表（+兜底）与实测特征完全一致'
      + (drift.length ? '；漂移 ' + drift.length + ' 处，第一处：' + drift[0] : ''));
    ok(CAP_KEYS.length === 5 && CAP_KEYS.every((k) => k in T.caps.DEFAULT_CAPS || KEY3.includes(k)),
      '能力位名单自洽：' + CAP_KEYS.length + ' 个键 = ' + KEY3.join('/') + ' + ' + Object.keys(T.caps.DEFAULT_CAPS).join('/'));
  }

  // ── ⑥ 下一波输入：谁还该自己声明 ─────────────────────────────
  head('⑥ 下一波输入：还在走中央表 / 兜底的器材');
  {
    const inTable = ALL.filter((d) => T.caps.CAPS_BY_TYPE[d.type]).map((d) => d.type);
    const viaFallback = ALL.filter((d) => !T.caps.CAPS_BY_TYPE[d.type]).map((d) => d.type);
    ok(inTable.length + viaFallback.length === ALL.length,
      '分区穷尽：中央表 ' + inTable.length + ' 件 + 兜底 ' + viaFallback.length + ' 件 = 注册表 ' + ALL.length + ' 件');
    ok(viaFallback.length > 0,
      '兜底真的有承载面：' + viaFallback.length + ' 件今天靠兜底承载（只承载默认位 复制/删除）');
    info('中央表（' + inTable.length + ' 件，下一波搬进各自器材文件的 def.caps）：' + inTable.join(' '));
    info('兜底（' + viaFallback.length + ' 件：菜单项 = 默认位 + 三个特征位，全靠 legacyCaps 兜着）');
  }

  // ── ⑦ 位 → 动作：applyCap ≡ 改动前五个内联闭包 ──────────────
  head('⑦ applyCap ≡ 改动前五个内联闭包（逐件逐位：动作 / 顺序 / 次数 / 状态变化）');
  {
    const KEYS = Object.keys(T.caps.CAP_KEYS);
    const mism = [];
    let rows = 0;
    for (const d of ALL) {
      const bits = T.caps.menuCaps(T.create(d.type, 0, 0));
      for (const key of KEYS) {
        if (!bits[key]) continue;
        for (const lit of (key === 'ignite' ? [false, true] : [undefined])) {
          const a = traceAction(T, d.type, key, { lit, useNew: false });
          const b = traceAction(T, d.type, key, { lit, useNew: true });
          rows++;
          if (a.log !== b.log || a.before !== b.before || a.after !== b.after) {
            // 报「哪一项不同 + 从第几个字符开始不同」，否则 3KB 的状态串没法读
            const at = (x, y) => { const m = Math.min(x.length, y.length); for (let i = 0; i < m; i++) if (x[i] !== y[i]) return i; return m; };
            const which = a.log !== b.log ? 'log' : (a.before !== b.before ? 'before' : 'after');
            const x = which === 'log' ? a.log : (which === 'before' ? a.before : a.after);
            const y = which === 'log' ? b.log : (which === 'before' ? b.before : b.after);
            const k = at(x, y);
            mism.push(d.type + '.' + key + (lit === undefined ? '' : ' lit=' + lit) + ' 差在 ' + which + '@' + k
              + ' 旧…' + x.slice(Math.max(0, k - 40), k + 60) + ' 新…' + y.slice(Math.max(0, k - 40), k + 60));
          }
        }
      }
    }
    ok(mism.length === 0,
      '逐位对照：' + rows + ' 次（' + ALL.length + ' 件器材 × 它真有的位 × 点火两态）—— 调用顺序、刷新/markDirty 次数、props+state 变化全部与改动前的内联闭包相同'
      + (mism.length ? '；不符 ' + mism.length + ' 处，第一处：' + mism[0].slice(0, 220) : ''));
    const volTypes = ALL.filter((d) => volatileKeys(T, d.type).length > 0);
    info('state 天生不确定的器材 ' + volTypes.length + ' 件（同型两件新器材就不同的键，只比对「结构」不比对数值）：'
      + volTypes.map((d) => d.type + ':' + volatileKeys(T, d.type).join('+')).join(' '));
    const d0 = ALL.find((d) => T.caps.menuCaps(T.create(d.type, 0, 0)).toggle);
    const w = traceAction(T, d0.type, 'toggle', { act: (app, e) => { app.duplicate(e); } });
    const n0 = traceAction(T, d0.type, 'toggle', { useNew: true });
    ok(w.log !== n0.log || w.after !== n0.after,
      '对拍有鉴别力（非空转对照）：把「切换」接到复制上，同一比较立刻判为不同（' + d0.type + '：错 ' + w.log + ' vs 对 ' + n0.log + '）');
  }

  // ── ⑧ 五个位各一条：位为真 ⇒ 调用的就是它自己的原语 ──────────
  head('⑧ 五个能力位各一条：位为真时调用的**就是它自己的原语**');
  {
    const t1 = traceAction(T, 'switch', 'toggle', { useNew: true });
    ok(t1.log.indexOf('ent.toggle') === 0 && t1.before !== t1.after && t1.ret === true,
      'toggle ⇒ ent.toggle()（状态真的变了）实测 ' + t1.log);
    const t2 = traceAction(T, 'alcohollamp', 'ignite', { lit: false, useNew: true });
    const t2b = traceAction(T, 'alcohollamp', 'ignite', { lit: true, useNew: true });
    const b2 = JSON.parse(t2.before).props.lit;
    const a2 = JSON.parse(t2.after).props.lit;
    const a2b = JSON.parse(t2b.after).props.lit;
    // 两个方向都要断言：只写「false → true」的话，把点燃实现成「只置真」的缺陷**看不见**
    ok(a2 === !b2 && a2b === false && t2.before !== t2.after,
      'ignite ⇒ props.lit 取反，两个方向都成立（' + b2 + ' → ' + a2 + '；true → ' + a2b + '）');
    const t3 = traceAction(T, 'beaker', 'empty', { useNew: true });
    ok(t3.log.indexOf('ent.vessel.empty') === 0 && t3.ret === true,
      'empty ⇒ ent.vessel.empty() 实测 ' + t3.log);
    const t4 = traceAction(T, 'battery', 'duplicate', { useNew: true });
    ok(t4.log === 'app.duplicate:battery',
      'duplicate ⇒ app.duplicate(ent)，**不**刷新、**不** markDirty（与改前逐字相同）实测 ' + t4.log);
    const t5 = traceAction(T, 'battery', 'remove', { useNew: true });
    ok(t5.log === 'app.removeEntity:battery',
      'remove ⇒ app.removeEntity(ent)，同样不刷新 / 不 markDirty 实测 ' + t5.log);
  }

  // ── ⑨ 边界：位为假 / 已删除 / 二次调用 ───────────────────────
  head('⑨ 边界：位为假无动作、已删除不抛错、二次调用不叠副作用');
  {
    const cnt = (x, pat) => x.split(pat).length - 1;
    const q = traceAction(T, 'battery', 'toggle', { useNew: true });
    ok(q.ret === false && q.log === '' && q.before === q.after,
      '位为假 ⇒ 无动作、无刷新、无 markDirty、状态不变，返回 false（干电池 × toggle）');
    const live = traceAction(T, 'beaker', 'ignite', { useNew: true });
    ok(live.ret === false && live.log === '' && live.before === live.after,
      '位为假但器材身上那套原语是活的（烧杯 × ignite）⇒ 依然一个动作都不做：位是唯一的开关');
    ok(T.caps.applyCap(recApp([]), null, 'toggle') === false, '空引用 ⇒ 返回 false（不抛错）');
    const app = recApp([]);
    const goneE = T.create('battery', 0, 0);
    const gb = snapE(T, goneE);
    let rets = null, threw = null, refreshed = 0;
    try { rets = ['toggle', 'ignite', 'empty', 'duplicate', 'remove'].map((k) => T.caps.applyCap(app, goneE, k, () => { refreshed++; })); }
    catch (err) { threw = String(err && err.message); }
    ok(threw === null && rets.every((r) => r === false) && app.log.length === 0 && refreshed === 0 && snapE(T, goneE) === gb,
      '已删除（不在台面上）⇒ 五个位全部返回 false、不抛错、宿主与刷新一次都没被调用'
      + (threw ? '；抛错：' + threw : '；返回 ' + JSON.stringify(rets)));
    const once = traceAction(T, 'switch', 'toggle', { useNew: true });
    const twice = traceAction(T, 'switch', 'toggle', { useNew: true, times: 2 });
    ok(twice.after === once.before && cnt(twice.log, 'ent.toggle') === 2
      && cnt(twice.log, 'view.render') === 2 && cnt(twice.log, 'app.markDirty') === 2,
      'toggle 连按两次：每次调用恰好 1 次原语 + 1 次刷新 + 1 次 markDirty，两次后回到初始状态（' + twice.log + '）');
    const dup2 = traceAction(T, 'battery', 'duplicate', { useNew: true, times: 2 });
    ok(cnt(dup2.log, 'app.duplicate:battery') === 2 && cnt(dup2.log, 'view.render') === 0
      && cnt(dup2.log, 'app.markDirty') === 0,
      'duplicate 连按两次：恰好两次 app.duplicate，一次多余的刷新 / markDirty 都没有（' + dup2.log + '）');
  }
  } catch (err) {
    ok(false, '套件在 ' + curSec + ' 节被抛错中断：' + String(err && err.message) + '（这一节算红）');
  }
  return S;
}

// ══════════════════════════════════════════════════════════
// 红测：每个变异体只许让**它那一层所在的节**变红（声明红节 ≡ 实测红节）
// ══════════════════════════════════════════════════════════
function mutateCases() {
  return [
    {
      tag: 'caps-def-caps-ignored',
      file: 'src/equipment/caps.js',
      old: '  const own = (def && def.caps) || null;',
      new: '  const own = null;   // MUTANT：器材自己的声明被丢掉',
      red: ['②'],
      note: '把第一层（器材自己声明）丢掉 ⇒ 只有 §② 该红：真实器材里今天还没有 def.caps，所以全量对照与中央表那两节不受影响',
    },
    {
      tag: 'caps-central-ignored',
      file: 'src/equipment/caps.js',
      old: '  const central = table[(def && def.type) || (e && e.type)] || null;',
      new: '  const central = null;   // MUTANT：中央表被整条忽略',
      red: ['②', '③'],
      note: '把第二层（中央表）丢掉 ⇒ §③ 红，§② 也红一条（「没被器材覆盖的位仍来自中央表」本来就消费这一层）—— 真实耦合，不是夹具缺陷。⚠ 全量对照**不会**红：中央表今天与兜底逐件等价（这正是零行为变化），所以这一层只能靠注入表抓到',
    },
    {
      tag: 'caps-legacy-ignite-off',
      file: 'src/equipment/caps.js',
      old: '    ignite: !!e.flame,',
      new: '    ignite: false,   // MUTANT：兜底层不再看 flame 特征',
      red: ['④'],
      note: '把第三层（兜底）的热源位焊死为假 ⇒ 只有 §④ 该红：带 flame 特征、没有声明的器材拿不到热源按钮',
    },
    {
      tag: 'caps-table-extra-bit',
      file: 'src/equipment/caps.js',
      old: '  switch: { toggle: true },',
      new: '  switch: { toggle: true, remove: false },   // MUTANT：中央表给开关多写一个不该有的位',
      red: ['①'],
      note: '中央表里给开关多写一位 remove:false ⇒ 只有 §① 该红（开关的菜单里少一个「删除」）。这条用来证明全量对照**有鉴别力**：它不是对着一份自己生成的基线空转',
    },
    {
      tag: 'caps-apply-toggle-miswire',
      file: 'src/equipment/caps.js',
      old: '      ent.toggle(); after(); return true;',
      new: '      app.duplicate(ent); return true;   // MUTANT：切换接成了复制',
      red: ['⑦', '⑧', '⑨'],
      note: '把「切换通断」接到 app.duplicate 上 ⇒ §⑦ 的逐位对照、§⑧ 的 toggle 那条、以及 §⑨ 的「连按两次」（它消费的也是切换这个动作）都该红 —— 后一条是真实耦合，不是夹具缺陷',
    },
    {
      tag: 'caps-apply-ignite-set',
      file: 'src/equipment/caps.js',
      old: '      ent.props.lit = !ent.props.lit; after(); return true;',
      new: '      ent.props.lit = true; after(); return true;   // MUTANT：点燃只能开不能关',
      red: ['⑦', '⑧'],
      note: '热源位改成「只置真」⇒ §⑦（ignite 的 lit=true 那一态）与 §⑧ 的 ignite 那条都该红',
    },
    {
      tag: 'caps-apply-bit-guard-off',
      file: 'src/equipment/caps.js',
      old: '  if (!menuCaps(ent)[key]) return false;',
      new: '  if (false && !menuCaps(ent)[key]) return false;   // MUTANT：位为假也照做',
      red: ['⑨'],
      note: '撤掉「位为假不做」的守卫 ⇒ 只有 §⑨ 该红（§⑦ 只跑真位，碰不到这条；烧杯 × ignite 那条就是为它准备的：位为假而原语活着）',
    },
    {
      tag: 'caps-apply-gone-guard-off',
      file: 'src/equipment/caps.js',
      old: '  if (gone(app, ent)) return false;',
      new: '  if (false && gone(app, ent)) return false;   // MUTANT：已删除的实体也照做',
      red: ['⑨'],
      note: '撤掉「不在台面上不做」的守卫 ⇒ 只有 §⑨ 该红（干电池的复制/删除两个位是真的，于是宿主会被调用）',
    },
  ];
}

const out = { probe: 'inspector-caps', mutate: MUTATE, items: 0, pass: 0, fail: 0, failed: [] };
try {
  if (!MUTATE) {
    const T = await loadTarget(ROOT, 'repo');
    const S = await runSuite(T);
    out.items = S.pass + S.fail; out.pass = S.pass; out.fail = S.fail; out.failed = S.failed;
  } else {
    const cases = mutateCases();
    const results = [];
    let allOk = true;
    for (const c of cases) {
      // ⚠ 匹配前先归一换行：本仓 core.autocrlf=true ⇒ 全新 Windows 检出拿到的是 CRLF，
      //   多行锚点会 0 命中（假红）。判据按 LF 语义写，就先把磁盘字节归一成 LF。
      const srcRaw = readFileSync(join(ROOT, c.file), 'utf8').replace(/\r\n/g, '\n');
      const hits = srcRaw.split(c.old).length - 1;
      const hitsCode = stripComments(srcRaw).split(c.old).length - 1;
      const mutated = srcRaw.replace(c.old, c.new);
      const landInCode = hitsCode === 1 && !stripComments(mutated).includes(c.old);
      const tree = stageTree('inspector-caps-mut-' + c.tag);
      writeFileSync(join(tree, c.file), mutated, 'utf8');
      const T = await loadTarget(tree, c.tag);
      const S = await runSuite(T, { verbose: false });
      const declared = c.red.slice().sort();
      const observedSecs = [...new Set(S.failSec)].sort();
      const extraRed = S.failed.map((m, i) => ({ m: m, s: S.failSec[i] || '?' })).filter((r) => !declared.includes(r.s));
      const missingRed = declared.filter((k) => !observedSecs.includes(k));
      const redsAligned = missingRed.length === 0 && extraRed.length === 0;
      const okThis = landInCode && redsAligned && hits === 1;
      results.push({
        tag: c.tag, file: c.file, landInCode: landInCode, redsAligned: redsAligned,
        oldHits: hits, oldHitsCode: hitsCode, note: c.note || null, granularity: 'section',
        expectedRed: declared.join(''), observedRed: observedSecs.join(''),
        observedRedCount: S.failed.length, ctrlBad: extraRed.length, ok: okThis,
        missingRed: missingRed, firstRed: (S.failed[0] || '').slice(0, 160),
        redTexts: S.failed.slice(0, 6).map((m) => m.slice(0, 200)),
        extraRed: extraRed.map((r) => (r.s + ' ' + r.m).slice(0, 140)),
      });
      rmSync(tree, { recursive: true, force: true });
      allOk = allOk && okThis;
    }
    out.mutants = results;
    out.landInCode = results.every((r) => r.landInCode);
    out.redsAligned = results.every((r) => r.redsAligned);
    out.ok = allOk;
  }
} catch (err) {
  out.error = String(err && err.stack ? err.stack.split('\n').slice(0, 3).join(' | ') : err);
  out.ok = false;
}

console.log('\n' + '─'.repeat(56));
if (MUTATE) {
  console.log('INSPECTOR_CAPS_MUTATE_JSON ' + JSON.stringify(out));
} else {
  console.log('INSPECTOR_CAPS_JSON ' + JSON.stringify(out));
  if (out.fail === 0) console.log('\x1b[32m全部通过：' + out.items + ' 项\x1b[0m');
  else console.log('\x1b[31m合计 ' + out.items + ' 项，失败 ' + out.fail + ' 项\x1b[0m');
}
process.exit(out.fail === 0 && (out.ok !== false) ? 0 : 1);
