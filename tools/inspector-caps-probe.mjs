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
// ⚠ 件数口径：本探针**不写死数字**，一律按注册表实测（当前 117 件；四种装载集合 —— 器材单独装、
//   加主题与规则、加预设、加器材包 —— 实测都是 117，PluginHost.stats.equipment=117）。
//   task-17 任务书写的是 118，差的那 1 件口径见 §⑥ 的 info 行（本探针只报实测，不猜）。
//
// ⚠ 为什么「中央表生效」要靠**注入表**才测得到：今天中央表的内容与兜底特征**逐件等价**
//   （这正是零行为变化的原因），所以中央表被整条忽略时，真实器材的菜单项**一点都不变** ✗。
//   要让那一层能红，唯一的办法是注入一张与兜底故意不同的小表（menuCaps(e, { table })，
//   与 engine 的 __XM_PAN_OFF__ 同一手法：只判据用，生产调用不传第二个参数）。
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
    if (added.length) info('基线之外的新增器材 ' + added.length + ' 件（不在本轮对照范围，按 §⑤ 的新口径判）：' + added.join(' '));
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
      const srcRaw = readFileSync(join(ROOT, c.file), 'utf8');
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
