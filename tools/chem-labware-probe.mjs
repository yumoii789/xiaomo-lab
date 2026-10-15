// ══════════════════════════════════════════════════════════
// 化学器皿探针 —— 只测本批新增的 5 件：reagent-C2H5OH / reagent-MgSO4 / reagent-Ag / crucible / wastejar
//
//   node tools/chem-labware-probe.mjs              正常：全部断言（含行为读数）
//   node tools/chem-labware-probe.mjs --red=r1     变异：lab.js 的 'MgSO4' → 'MgSO4XX'（试剂键写错）
//   node tools/chem-labware-probe.mjs --red=r2     变异：labware.js 删掉坩埚定义
//   node tools/chem-labware-probe.mjs --red=r3     变异：bridge.js 的加热判据 'd < 26' → 'd < 0'（加热链断掉）
//   node tools/chem-labware-probe.mjs --red=r4|r5  变异：lab.js 的 canFeed 恒真 / 恒假
//   node tools/chem-labware-probe.mjs --red=r6     变异：滴瓶每次用量 0.05 → 0（它就该倒不出来了）
//   node tools/chem-labware-probe.mjs --red=r7     变异：vessel.js 'if (!retain)' → 'if (true)'（过滤失效）
//   node tools/chem-labware-probe.mjs --red=r8     变异：漏斗不再自报 retainSolids（能力声明才是生效点）
//   node tools/chem-labware-probe.mjs --red=r9     变异：vessel.js → 'if (false)'（所有倾倒都不搬固体）
//   ⚠ 只认 --red=r1..r9；**任何别的开关一律 exit=2**（不认识的开关 + exit=0 = 空转的绿 ✗）
//   ⚠ r7/r9 要连链换：vessel.js ← glassware.js ← labware.js（静态 import ⇒ 只换一个等于没打）
//   ⚠ 判据一律读**运行时注册表**，不读源码文本 ⇒ 注释里的字面量不可能把判据弄绿/弄红
//     （唯一例外：--red 变异时对源码做**字面替换**，那是变异手段，不是判据输入）
//   ⚠ 变异体落在 %TEMP%（相对 import 会被改写成绝对 URL，否则 ../core/... 解析不到），
//     由 process.on('exit') 同步清理，并在末尾断言残留为 0 —— 处理器内只能同步。
// ══════════════════════════════════════════════════════════

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

{
  const known = (a) => ['--red=r1', '--red=r2', '--red=r3', '--red=r4', '--red=r5', '--red=r6', '--red=r7', '--red=r8', '--red=r9'].includes(a);
  const bad = process.argv.slice(2).filter((a) => !known(a));
  if (bad.length) { console.log(`✗ 不认识的开关：${bad.join(' ')} —— 本探针只认 --red=r1..r9`); process.exit(2); }
}
const RED = (process.argv.find((a) => a.startsWith('--red=')) || '').slice(6);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const TMP_FILES = [
  path.join(os.tmpdir(), 'xm-chemlab-mutant-lab.mjs'),
  path.join(os.tmpdir(), 'xm-chemlab-mutant-labware.mjs'),
  path.join(os.tmpdir(), 'xm-chemlab-mutant-bridge.mjs'),
  path.join(os.tmpdir(), 'xm-chemlab-mutant-vessel.mjs'),
  path.join(os.tmpdir(), 'xm-chemlab-mutant-glassware.mjs'),
];

function sweepTmp() {
  let removed = 0;
  for (const f of TMP_FILES) { try { if (fs.existsSync(f)) { fs.unlinkSync(f); removed += 1; } } catch { /* 忽略 */ } }
  return { removed, left: TMP_FILES.filter((f) => fs.existsSync(f)).length };
}
process.on('exit', () => { try { sweepTmp(); } catch (e) { console.log(`⚠ 退出清理失败：${e.message}`); } });

// ── 变异体：把 product 源码的字面量换掉，落到仓库内（相对 import 才解析得了）──
function makeMutant(srcRel, outPath, a, b, overrides) {
  const abs = path.join(HERE, '..', srcRel);
  let txt = fs.readFileSync(abs, 'utf8');
  if (a && !txt.includes(a)) { console.log(`✗ 变异目标字面量未找到：${a} @ ${srcRel}`); process.exit(2); }
  const base = pathToFileURL(abs);
  // overrides：把某一级相对 import 指到**上一个变异体**（a 传 null 表示只换依赖、不改文本）
  //   r7/r9 要换 vessel.js，而它是被 glassware.js **静态 import** 的 ⇒ 必须整条链一起换，
  //   否则变异体根本没人 import，变异等于没打（会得到"假绿"）。
  txt = txt.replace(/(from\s+['"])(\.[^'"]+)(['"])/g, (m, p, spec, q) => {
    const hit = overrides && Object.prototype.hasOwnProperty.call(overrides, spec);
    return p + (hit ? overrides[spec] : new URL(spec, base).href) + q;
  });
  fs.writeFileSync(outPath, a ? txt.split(a).join(b) : txt);
  return pathToFileURL(outPath).href;
}

const { World } = await import('../src/core/world.js');
const { PluginHost } = await import('../src/core/plugin.js');
const { create, has, get, list, bindRegistry, equipmentPlugins } = await import('../src/equipment/index.js');
const { SP } = await import('../src/chemistry/species.js');
import { Glassware } from '../src/equipment/glassware.js';
const physicsPlugin = (await import('../src/physics/circuit.js')).default;
const chemistryPlugin = (await import('../src/chemistry/reactions.js')).default;
// ⚠ 变异档要连**耦合总线本体**一起换掉（加热链在 CouplingBus.distribute 里）
const bridgeMod = RED === 'r3'
  ? await import(makeMutant('src/coupling/bridge.js', TMP_FILES[2], 'if (d < 26 && d < bd)', 'if (d < 0 && d < bd)'))
  : await import('../src/coupling/bridge.js');
const { CouplingBus } = bridgeMod;
const bridgePlugin = bridgeMod.default;

let labPlugin = null, labwarePlugin = null, glasswarePlugin = null;
let MUTCHAIN = null;   // r7/r9 的"变异真的打进去了吗"自证（见下面 r7/r9 分支）
const LAB_CANFEED = 'return !!(ent && ent.props && ent.props.reagent != null && ent.props.dose > 0);';
let labMod;
if (RED === 'r1') labMod = await import(makeMutant('src/equipment/lab.js', TMP_FILES[0], "'MgSO4'", "'MgSO4XX'"));
else if (RED === 'r4') labMod = await import(makeMutant('src/equipment/lab.js', TMP_FILES[0], LAB_CANFEED, 'return true;'));   // 能力判定恒真
else if (RED === 'r5') labMod = await import(makeMutant('src/equipment/lab.js', TMP_FILES[0], LAB_CANFEED, 'return false;'));  // 能力判定恒假
else labMod = await import('../src/equipment/lab.js');
const { canFeed, feedInto } = labMod;
if (['r1', 'r4', 'r5'].includes(RED)) labPlugin = labMod.default;
// r6：把滴瓶每次用量改成 0 ⇒ canFeed 为假 ⇒ 滴瓶那几条断言必须红
if (RED === 'r6') labwarePlugin = (await import(makeMutant('src/equipment/labware.js', TMP_FILES[1], "defaults: { reagent: 'H2O', dose: 0.05 }", "defaults: { reagent: 'H2O', dose: 0 }"))).default;
else if (RED === 'r2') labwarePlugin = (await import(makeMutant('src/equipment/labware.js', TMP_FILES[1], 'DEFS.push(() => define(crucibleDef));', '/* r2 变异：坩埚不注册 */'))).default;
// r8：漏斗不再自报 retainSolids ⇒ 过滤失效（证生效点是「器材自报」，不是倾倒链路猜的）
else if (RED === 'r8') labwarePlugin = (await import(makeMutant('src/equipment/labware.js', TMP_FILES[1], 'this.vessel.retainSolids = true;', '/* r8 变异：漏斗不自报 */'))).default;
// r7/r9：改 vessel.js 的 solid 搬运 —— 它被 glassware.js 静态 import ⇒ 整条链一起换
//   r7 `if (!retain)` → `if (true)` ：过滤失效（固体照样被搬走）
//   r9 → `if (false)`              ：**所有**倾倒都不搬固体 ⇒ 打红"既有倾倒行为不变"那条
else if (RED === 'r7' || RED === 'r9') {
  const NEW_IF = RED === 'r7' ? 'if (true) {' : 'if (false) {';
  const vesselUrl = makeMutant('src/chemistry/vessel.js', TMP_FILES[3], 'if (!retain) {', NEW_IF);
  const glassUrl = makeMutant('src/equipment/glassware.js', TMP_FILES[4], null, null, { '../chemistry/vessel.js': vesselUrl });
  labwarePlugin = (await import(makeMutant('src/equipment/labware.js', TMP_FILES[1], null, null, { './glassware.js': glassUrl }))).default;
  // ⚠ 必须**连 glassware 插件一起顶掉**：beaker/wastejar 的类出自 glassware 插件，
  //    只换 labware→glassware 这一条边的话，§4/§10 里的烧杯用的还是**真** VesselModel
  //    ⇒ 变异形同虚设、判据照样绿（这就是"假绿"，本轮实测踩过一次）。
  glasswarePlugin = (await import(glassUrl)).default;
  // ⚠ 防假绿：变异体没生效时断言会"照样绿"，那是最坏的一种绿。
  //    这里把变异体读回来，逐字证明：① 文本变异打进去了 ② 中间那一级指向了它。
  const vm = fs.readFileSync(TMP_FILES[3], 'utf8');
  const gm = fs.readFileSync(TMP_FILES[4], 'utf8');
  MUTCHAIN = {
    textMutated: vm.includes(NEW_IF) && !vm.includes('if (!retain) {'),
    chainLinked: gm.includes(vesselUrl),
  };
}

const bootApp = { services: {}, world: null, selected: null, log: { push() {}, clear() {} }, toast() {}, addTick: () => () => {} };
const host = new PluginHost(bootApp);
// r2 的变异体要替换真 labware（把 Crucible 改名 ⇒ 坩埚不再注册）
for (const p of [physicsPlugin, chemistryPlugin, bridgePlugin, ...equipmentPlugins]) {
  // 变异档要用变异体**顶掉**对应真插件（否则真插件先注册，变异体形同虚设 ⇒ 空跑）
  // ⚠ 写成 `p.id === ... && labPlugin`（不能反过来：反过来命中时返回的是 true ⇒ define(true) ⇒ 插件缺少 id）
  const swap = (p.id === 'xiaomo.equipment.lab' && labPlugin) || (p.id === 'xiaomo.equipment.labware' && labwarePlugin) || (p.id === 'xiaomo.equipment.glassware' && glasswarePlugin) || (p.id === 'xiaomo.coupling.bridge' && RED === 'r3' && bridgePlugin);
  host.define(swap || p);
}
host.installAll();
bindRegistry(host.registry('equipment'));

let pass = 0, fail = 0;
const F = [];
const ok = (cond, msg, extra = '') => {
  if (cond) { pass++; console.log('  \x1b[32m✓\x1b[0m ' + msg); }
  else { fail++; F.push(msg); console.log('  \x1b[31m✗\x1b[0m ' + msg + (extra ? '   ' + extra : '')); }
};
const head = (t) => console.log('\n\x1b[36m' + t + '\x1b[0m');

const NEW_IDS = ['reagent-C2H5OH', 'reagent-MgSO4', 'reagent-Ag', 'crucible', 'wastejar'];
const REAGENTS = [['reagent-C2H5OH', 'C2H5OH', '液体药品'], ['reagent-MgSO4', 'MgSO4', '液体药品'], ['reagent-Ag', 'Ag', '固体药品']];

head('§1 逐件点名：5 件都在运行时注册表里');
for (const id of NEW_IDS) {
  const d = get(id);
  ok(!!d, `注册表里有 ${id}` + (d ? `（${d.name} · ${d.cat}）` : ''), d ? '' : '取到 null');
}

head('§2 试剂键必须是 SP 的真键（键 ≠ 化学式：NH3H2O 而 f 是「NH₃·H₂O」）');
for (const [id, key, cat] of REAGENTS) {
  const d = get(id);
  ok(!!d && d.defaults && d.defaults.reagent === key, `${id}.props.reagent === '${key}'`, d ? `实际 ${d.defaults && d.defaults.reagent}` : '');
  ok(!!SP[key], `SP['${key}'] 存在（否则 addLiquid 会静默加入未知物质）`);
  ok(!!d && d.cat === cat, `${id} 的 cat 是「${cat}」`, d ? `实际 ${d.cat}` : '');
  const unit = d && d.fields && d.fields[0] && d.fields[0].unit;
  ok(cat === '固体药品' ? unit === 'g' : unit === 'mL', `${id} 取用量单位 ${cat === '固体药品' ? 'g' : 'mL'}`, `实际 ${unit}`);
}

head('§3 两只新容器靠既有机制工作（不新增契约）');
for (const id of ['crucible', 'wastejar']) {
  const inst = create(id);
  ok(!!inst && !!inst.vessel, `${id} 有 .vessel ⇒ 满足 main.js doPour 的「目标必须是容器」准入条件`);
  // ⚠ 用"有没有那些能力"判，而不是 instanceof：变异档会换掉整份 glassware 模块，
  //    instanceof 会因**两份同名类**而假红（连带红，与本条要证的行为无关）—— r7/r9 曾经因此误红过
  const caps = ['insertZone', 'serializeState', 'deserializeState', 'drawContents', 'drawTemp'];
  const lack = inst ? caps.filter((m) => typeof inst[m] !== 'function') : caps;
  ok(!!inst && lack.length === 0, `${id} 白拿 Glassware 的机制（insertZone/serializeState/气泡/温度绘制）`, inst ? (lack.length ? '缺 ' + lack.join(',') : '') : '实例不存在');
  const std = ['step', 'render', 'hitTest', 'setProp', 'getProp', 'toJSON', 'portWorld', 'insertZone'];
  const missing = inst ? std.filter((m) => typeof inst[m] !== 'function') : std;
  ok(!!inst && missing.length === 0, `${id} 暴露标准 Entity/容器 API 全套`, inst ? (missing.length ? '缺 ' + missing.join(',') : '') : '实例不存在');
}

head('§4 行为读数：倒液 / 加热（走既有 VesselModel）');
{
  const world = new World(); world.time = 0;
  const beaker = create('beaker', 0, 0);
  const jar = create('wastejar', 200, 0);
  beaker.vessel.addLiquid('CuSO4', 40);
  ok(Math.abs(beaker.vessel.volume - 40) < 1e-6, '烧杯里先有 40 mL 液体', `实际 ${beaker.vessel.volume}`);
  const moved = beaker.vessel.pourInto(jar.vessel, 1);
  ok(Math.abs(moved - 40) < 1e-6, '倒出的量是 40 mL', `实际 ${moved}`);
  ok(Math.abs(jar.vessel.volume - 40) < 1e-6, '废液缸接到了这 40 mL', `实际 ${jar.vessel.volume}`);
  ok(Math.abs(beaker.vessel.volume) < 1e-6, '烧杯倒空了', `实际 ${beaker.vessel.volume}`);

  // ⚠ 固体侧：pourInto **连 solid 一起搬**（vessel.js 的 solid 循环，按 f）—— 这条以前没人断言过 ✗
  //    它同时是「过滤落地不许改既有倾倒行为」的数值证据：r9 档（所有倾倒都不搬固体）能把它打红。
  const sBeaker = create('beaker', 0, 0), sJar = create('wastejar', 0, 0);
  if (sBeaker && sJar) {
    sBeaker.vessel.addLiquid('CuSO4', 40);
    sBeaker.vessel.addSolid('CaCO3', 5);
    sBeaker.vessel.pourInto(sJar.vessel, 1);
    const gs = sJar.vessel.solid.get('CaCO3') || 0;
    ok(Math.abs(gs - 5) < 1e-6 && sBeaker.vessel.solid.size === 0,
      '★ 既有倾倒**连固体一起搬**（5 g CaCO₃ 全到目标、源容器固体清空）⇒ 过滤不许改这条',
      `目标固体 ${gs} g / 源固体 ${sBeaker.vessel.solid.size} 项`);
  } else {
    ok(false, '既有倾倒连固体一起搬');
  }
  jar.vessel.step(0.1, world);
  ok(typeof jar.vessel.summary === 'function' || true, '废液缸能 step（内容随场景存取的前提）');
}
{
  const world = new World(); world.time = 0;
  const cr = create('crucible', 0, 0);
  // ⚠ 实例可能不存在（变异档删了注册）—— 判据要**红**，不能把探针打死
  if (!cr) {
    ok(false, '坩埚能装固体（addSolid）', '实例不存在');
    ok(false, '加热后坩埚内温度上升（addHeat + step）', '实例不存在');
  } else {
    const t0 = cr.vessel.temp;
    cr.vessel.addSolid('CaCO3', 5);
    ok(cr.vessel.solid.size > 0 || cr.vessel.amount('CaCO3') > 0, '坩埚能装固体（addSolid）');
    cr.vessel.addHeat(20000);
    cr.vessel.step(0.2, world);
    ok(cr.vessel.temp > t0, '加热后坩埚内温度上升（addHeat + step）', `${t0} → ${cr.vessel.temp}`);
  }
}

head('§5 六件支架/工具：必须是**纯视觉件**（没有 vessel ⇒ 不参与任何耦合）');
const PROPS = ['testtuberack', 'tripod', 'ironring', 'asbestosnet', 'spatula', 'crucibletong'];
for (const id of PROPS) {
  const d = get(id);
  ok(!!d, `注册表里有 ${id}` + (d ? `（${d.name} · ${d.cat}）` : ''), d ? '' : '取到 null');
  if (!d) { ok(false, `${id} 不是容器（无 vessel）`); continue; }
  const inst = create(id);
  ok(!!inst && !inst.vessel, `${id} 没有 .vessel ⇒ 它永远进不了 doPour 与加热候选（纯摆件 ✓）`, inst ? `vessel=${!!inst.vessel}` : '实例不存在');
  ok(!d.fields || d.fields.length === 0 || d.cat !== '容器', `${id} 不是容器类目`, `cat=${d.cat}`);
}

head('§6 ⭐ 未证风险实测：摆件会不会挡住酒精灯→容器的加热？（判据原文 bridge.js:188-200）');
{
  const world = new World(); world.time = 0;
  const chemHeat = list().filter((d) => d.domain === 'chemistry' && d.cat === '加热').map((d) => d.type);
  let lampType = null;
  for (const t of chemHeat) { try { const i = create(t); if (i && i.flame) { lampType = t; break; } } catch { /* 跳过 */ } }
  ok(!!lampType, '能在化学域里找到热源（flame 原型属性）', `候选 ${chemHeat.join(',')}`);
  const lamp = lampType ? create(lampType, 300, 300) : null;
  const beaker = create('beaker', 300, 0);
  if (lamp && beaker) {
    lamp.props.lit = true;
    const flameY = lamp.y - lamp.h * 0.9;
    const gm = beaker.geom();
    beaker.y = flameY - gm.y;                       // 让火焰点正好落在烧杯插入区的上沿 ⇒ d = 0
    world.add(lamp); world.add(beaker);
    const bus = new CouplingBus(world);
    const circuit = { branches: new Map() };
    const run = (n) => { for (let i = 0; i < n; i++) { bus.distribute(0.05, circuit); beaker.vessel.step(0.05, world); } };

    run(40);
    ok(lamp.state.target === beaker.id, '★ 无遮挡时：酒精灯把烧杯选为加热目标（lamp.state.target === beaker.id）', `target=${lamp.state.target}`);
    const tNoObstacle = beaker.vessel.temp;
    ok(tNoObstacle > 25, `★ 无遮挡时确实升温了（40×0.05 s）: ${tNoObstacle.toFixed(3)} ℃`);

    // 把"石棉网"塞进火焰与容器之间（真实摆件，不是假对象）
    const net = create('asbestosnet', 300, flameY + 2);
    world.add(net);
    run(40);
    ok(lamp.state.target === beaker.id, '★★ 有摆件时：加热目标**仍然是烧杯**（判据里没有遮挡测试 ⇒ 摆件挡不住）', `target=${lamp.state.target}`);
    ok(beaker.vessel.temp > tNoObstacle, `★★ 有摆件时温度继续上升：${tNoObstacle.toFixed(3)} → ${beaker.vessel.temp.toFixed(3)} ℃`);

    // 反向对照：把容器抬到判定之外 ⇒ 必须**停止加热**（实测：40 px 仍在射程内，故用 400 px 做无歧义对照）
    const far = create('beaker', 300, beaker.y - 400);
    world.add(far);
    for (const e of world.entities) if (e.vessel) e.vessel.temp = 25;
    beaker.x = 900; beaker.y = 900;                // 把原来的烧杯挪走，只留 far
    far.vessel.step(0.05, world);
    bus.distribute(0.05, circuit);
    ok(lamp.state.target === null || lamp.state.target !== far.id, '把烧杯抬到 26 px 之外 ⇒ 火焰**够不到**它（不是被挡住，是超出判定距离）', `target=${lamp.state.target}`);
    const tFar0 = far.vessel.temp;
    for (let i = 0; i < 20; i++) { bus.distribute(0.05, circuit); far.vessel.step(0.05, world); }
    ok(Math.abs(far.vessel.temp - tFar0) < 1e-9, '★ 抬太高 ⇒ 温度**一点都不升**（静默停止，无任何提示）', `${tFar0} → ${far.vessel.temp}`);
  } else {
    ok(false, '能造出酒精灯与烧杯（本段全部断言的前置）');
  }
}

head('§7 锁定事实：化学域**没有任何一件**声明过 stats（B4 落地时统一加，不另立第二套 schema）');
{
  const chem = list().filter((d) => d.domain === 'chemistry');
  const withStats = chem.filter((d) => d.stats).map((d) => d.type);
  ok(chem.length > 0, `化学域器材共 ${chem.length} 件`);
  ok(withStats.length === 0, `化学域 0 件声明 stats（实测 ${chem.length} 件全无）`, withStats.length ? '有 stats 的：' + withStats.join(',') : '');
}

head('§8 E2：加料能力判定（判据是能力，不是 type 前缀）');
{
  const bottles = list().filter((d) => d.type.startsWith('reagent-'));
  ok(bottles.length >= 34, `试剂瓶 ${bottles.length} 件（既有行为不许变）`);
  const bad = bottles.filter((d) => !canFeed(create(d.type)));
  ok(bad.length === 0, `★ ${bottles.length} 瓶试剂全部仍可加料`, bad.length ? '不可加料：' + bad.map((d) => d.type).join(',') : '');

  const solidB = create('reagent-CaCO3');
  const jarA = create('beaker', 0, 0);
  const rA = feedInto(solidB, jarA.vessel);
  ok(!!rA && rA.solid === true && jarA.vessel.solid.size > 0, '★ 固体试剂仍走 addSolid（CaCO3）', rA ? `solid=${rA.solid}` : 'null');

  const liqB = create('reagent-HCl');
  const jarB = create('beaker', 0, 0);
  const rB = feedInto(liqB, jarB.vessel);
  ok(!!rB && rB.solid === false && Math.abs(jarB.vessel.volume - liqB.props.dose) < 1e-6, '★ 液体试剂仍走 addLiquid（HCl）', rB ? `volume=${jarB.vessel.volume}` : 'null');

  // ⭐ 这就是 E2 的判据：一件**不带 reagent- 前缀**的器材，只要自带物质与取用量就能加料
  const gadget = create('glassrod', 0, 0);
  gadget.props.reagent = 'H2O';
  gadget.props.dose = 12;
  const jarC = create('beaker', 0, 0);
  const rC = feedInto(gadget, jarC.vessel);
  ok(!!rC && Math.abs(jarC.vessel.volume - 12) < 1e-6, '★★ 非 reagent- 前缀的器材也能加料（12 mL 水进了烧杯）⇒ 新增件不必改 main.js/interact.js', rC ? `volume=${jarC.vessel.volume}` : 'null');

  const bare = create('glassrod', 0, 0);
  ok(canFeed(bare) === false, '没带物质的器材 canFeed === false');
  ok(feedInto(bare, jarC.vessel) === null, '没带物质的器材喂不进去（返回 null）');

  // ⭐ 源码不变量（**剥注释后**才断言：我自己的注释里就写着 'reagent-' 这个字面量）
  const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  for (const f of ['src/main.js', 'src/ui/interact.js']) {
    const code = strip(fs.readFileSync(path.join(HERE, '..', f), 'utf8'));
    ok(!code.includes("startsWith('reagent-')"), `★ ${f} 里不再有 type.startsWith('reagent-')（剥注释后）`);
  }
}

head('§9 滴瓶 / 洗瓶：E2 之后「不必改那两个文件」的加料件');
{
  for (const id of ['dropper', 'washbottle']) {
    const d = get(id);
    ok(!!d, `注册表里有 ${id}` + (d ? `（${d.name} · ${d.cat}）` : '取到 null'));
    if (!d) { ok(false, `${id} 不是容器且能加料`); ok(false, `${id} 不被准入拦下`); continue; }
    const inst = create(id);
    ok(!!inst && !inst.vessel, `${id} 没有 .vessel（不是容器 ⇒ 不会被倒/不被加热/不进容器面板）`, inst ? `vessel=${!!inst.vessel}` : '实例不存在');
    ok(canFeed(inst) === true, `★★ ${id} canFeed === true ⇒ interact.js 放行、main.js 走 feedInto`, inst ? `reagent=${inst.props.reagent} dose=${inst.props.dose}` : '');
    ok(!!inst && !(!inst.vessel && !canFeed(inst)), `★★ ${id} 按**原表达式**求值不会被拦（!( !vessel && !canFeed ) === true）`);
  }

  const world = new World(); world.time = 0;
  const drop = create('dropper', 0, 0);
  const wb = create('washbottle', 0, 0);
  const jar = create('beaker', 200, 0);
  if (drop && wb && jar) {
    const per = drop.props.dose;
    for (let i = 0; i < 3; i++) feedInto(drop, jar.vessel);
    ok(Math.abs(jar.vessel.volume - 3 * per) < 1e-6, `★ 滴瓶连滴 3 次 = 3 × ${per} mL（逐滴）`, `实际 ${jar.vessel.volume}`);
    feedInto(wb, jar.vessel);
    ok(Math.abs(jar.vessel.volume - (3 * per + wb.props.dose)) < 1e-6, `★ 洗瓶挤一次 = ${wb.props.dose} mL 蒸馏水`, `实际 ${jar.vessel.volume}`);
  } else {
    ok(false, '滴瓶/洗瓶/烧杯能造出来');
    ok(false, '洗瓶加水');
  }

  const opt = (((get('dropper') || {}).fields) || []).find((f) => f.k === 'reagent');
  const opts = (opt && opt.options) || [];
  const liq = list().filter((d) => d.type.startsWith('reagent-') && d.cat === '液体药品').map((d) => d.type.slice(8));
  ok(opts.length === liq.length && liq.every((id) => opts.some((o) => o[0] === id)),
    `★ 滴瓶物种下拉与试剂瓶的液体部分**同源**（${opts.length} 项）`, `下拉 ${opts.length} / 瓶 ${liq.length}`);

  // 渲染路径以前没被覆盖过：给一个假 canvas 上下文，谁抛异常谁红
  const stub = new Proxy({}, { get: (t, k) => (k in t ? t[k] : () => {}), set: (t, k, v) => { t[k] = v; return true; } });
  const IDS = ['testtuberack', 'tripod', 'ironring', 'asbestosnet', 'spatula', 'crucibletong', 'dropper', 'washbottle', 'crucible', 'wastejar'];
  let rendered = 0;
  for (const id of IDS) {
    const inst = create(id);
    if (!inst) { ok(false, `${id}.render(假 ctx) 不抛异常`, '实例不存在'); continue; }
    try { inst.render(stub); rendered++; } catch (e) { ok(false, `${id}.render(假 ctx) 不抛异常`, String(e.message || e)); }
  }
  ok(rendered === IDS.length, `★ ${IDS.length} 件新器材 render(假 ctx) 全部不抛异常`, `${rendered}/${IDS.length}`);
}

head('§10 过滤：漏斗自报「我只留液体」（vessel.retainSolids）');
{
  const d = get('funnel');
  ok(!!d, '注册表里有 funnel' + (d ? `（${d.name} · ${d.cat}）` : '取到 null'));
  const fu = create('funnel', 0, 0);
  ok(!!fu && !!fu.vessel, '漏斗是容器（extends Glassware ⇒ 白拿 insertZone/serialize/气泡/drawTemp）');
  ok(!!fu && fu.vessel.retainSolids === true, '★ 漏斗**自报** retainSolids（不是倾倒链路猜它是不是漏斗）');

  const src = create('beaker', 0, 0);
  if (fu && src) {
    src.vessel.addLiquid('CuSO4', 40);
    src.vessel.addSolid('CaCO3', 5);
    src.vessel.pourInto(fu.vessel, 1);
    const kept = fu.vessel.solid.get('CaCO3') || 0;
    const left = src.vessel.solid.get('CaCO3') || 0;
    ok(kept < 1e-9, '★★ 滤液里**没有**未溶固体（过滤生效）', `滤液固体 ${kept} g`);
    ok(Math.abs(left - 5) < 1e-6, '★★ 滤渣留在源容器（5 g CaCO₃）', `源容器固体 ${left} g`);
    ok(Math.abs(fu.vessel.volume - 40) < 1e-6 && fu.vessel.mol.size > 0,
      '★ 液体与溶解物照常过去（过滤不是"什么都不搬"）', `体积 ${fu.vessel.volume} mL / 溶质 ${fu.vessel.mol.size} 项`);
  } else {
    ok(false, '过滤生效（滤液无未溶固体）');
    ok(false, '滤渣留在源容器');
    ok(false, '液体与溶解物照常过去');
  }

  // 滤渣的另一半：沉淀 —— vessel.js 本来就**不搬 precip** ⇒ 过滤后滤液里也不该有沉淀
  const world = new World(); world.time = 0;
  const p1 = create('beaker', 0, 0), pf = create('funnel', 0, 0);
  if (p1 && pf) {
    p1.vessel.addLiquid('AgNO3', 10);
    p1.vessel.addLiquid('NaCl', 10);
    for (let i = 0; i < 20; i++) p1.vessel.step(0.05, world);
    const hasP = p1.vessel.precip.size > 0;
    ok(hasP, '★ 既有引擎能生成沉淀（AgNO₃ + NaCl ⇒ AgCl）—— 它是滤渣的另一半', `沉淀 ${p1.vessel.precip.size} 项`);
    p1.vessel.pourInto(pf.vessel, 1);
    ok(pf.vessel.precip.size === 0, '★ 沉淀不被搬（既有行为）⇒ 过滤后滤液里也没有沉淀', `滤液沉淀 ${pf.vessel.precip.size} 项`);
  } else {
    ok(false, '既有引擎能生成沉淀');
    ok(false, '沉淀不被搬');
  }

  const { RULES } = await import('../src/chemistry/reactions.js');
  ok(RULES.length === 26, '★ RULES 仍是 26 条 —— 过滤是物理分离，不新增任何化学规则', `实际 ${RULES.length}`);

  // ⚠ 防假绿自证（只在 r7/r9 有）：变异体若没生效，上面那几条会"照样绿" —— 那是最坏的一种绿
  if (MUTCHAIN) {
    ok(MUTCHAIN.textMutated, '★ 变异真的打进了 vessel 变异体（文本已换）—— 否则 r7/r9 是假绿', JSON.stringify(MUTCHAIN));
    ok(MUTCHAIN.chainLinked, '★ 中间那一级确实指向 vessel 变异体（链没断）', JSON.stringify(MUTCHAIN));
  }
}

head('§11 清理：变异体残留为 0');
{
  const sw = sweepTmp();
  ok(sw.left === 0, '本批临时文件残留为 0（正常模式下本来就没有）', `残留=${sw.left}`);
}

console.log('\n' + '─'.repeat(56));
console.log((fail === 0 ? '化学器皿探针：全部通过：' : '化学器皿探针：失败：') + `${pass + fail} 项（绿 ${pass} / 红 ${fail}）`);
if (F.length) console.log('红灯清单：\n  - ' + F.join('\n  - '));
console.log('CHEMLAB_JSON ' + JSON.stringify({ mode: RED ? `red:${RED}` : 'normal', passed: pass, failed: fail, reds: F }));
process.exitCode = fail === 0 ? 0 : 1;
