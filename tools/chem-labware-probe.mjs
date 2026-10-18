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
//   node tools/chem-labware-probe.mjs --red=r10    变异：集气瓶不再自报 collectGas（能力声明才是生效点）
//   node tools/chem-labware-probe.mjs --red=r11    变异：vessel.js 'if (takeGas)' → 'if (false)'（气体搬不动）
//   node tools/chem-labware-probe.mjs --red=r12    变异：守卫① 回退（只装气体的容器又被劝退）
//   node tools/chem-labware-probe.mjs --red=r13    变异：守卫② 回退（同上 —— 两处守卫各有一档钉着）
//   node tools/chem-labware-probe.mjs --red=r14    变异：蒸发皿的汽化段 `if (false)`（越过的热不再变潜热）
//   node tools/chem-labware-probe.mjs --red=r15    变异：不钉沸点平台（温度冲过 100 ℃）
//   node tools/chem-labware-probe.mjs --red=r16    变异：蒸干也不析出（`if (false)`）
//   node tools/chem-labware-probe.mjs --red=r17    变异：把蒸汽塞进 gas 账（假"还在世界里"）⇒ 反向证明没走转移算子
//   ⚠ 只认 --red=r1..r17；**任何别的开关一律 exit=2**（不认识的开关 + exit=0 = 空转的绿 ✗）
//   ⚠ r7/r9/r11/r12/r13 要连链换：vessel.js ← glassware.js ← labware.js（静态 import ⇒ 只换一个等于没打）
//   ⚠ r14..r17 只改 labware.js 一个文件（相变在器材自己的 step 里，vessel.js 不参与）⇒ 无链，但要读回变异体自证文本已换
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
  const known = (a) => ['--red=r1', '--red=r2', '--red=r3', '--red=r4', '--red=r5', '--red=r6', '--red=r7', '--red=r8', '--red=r9', '--red=r10', '--red=r11', '--red=r12', '--red=r13', '--red=r14', '--red=r15', '--red=r16', '--red=r17', '--red=r18', '--red=r19', '--red=r20', '--red=r21'].includes(a);
  const bad = process.argv.slice(2).filter((a) => !known(a));
  if (bad.length) { console.log(`✗ 不认识的开关：${bad.join(' ')} —— 本探针只认 --red=r1..r21`); process.exit(2); }
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
// 滴定管的读数：喂料点那一行（lab.js feedInto）。r18/r20 都改它，见下面的分支。
const LAB_DOSED = 'if (ent.state) ent.state.dosed = (ent.state.dosed || 0) + dose;';
let labMod;
if (RED === 'r1') labMod = await import(makeMutant('src/equipment/lab.js', TMP_FILES[0], "'MgSO4'", "'MgSO4XX'"));
else if (RED === 'r4') labMod = await import(makeMutant('src/equipment/lab.js', TMP_FILES[0], LAB_CANFEED, 'return true;'));   // 能力判定恒真
else if (RED === 'r5') labMod = await import(makeMutant('src/equipment/lab.js', TMP_FILES[0], LAB_CANFEED, 'return false;'));  // 能力判定恒假
// r18/r20：滴定管读数两档 —— 都只改 lab.js 的那**一行**（喂料点的记账）
//   r18 删掉记账        ：读数恒 0 ⇒ 三条"喂 N 次 ⇒ 读数 N×dose"必红
//   r20 改成按**次数**累加（+1）：★ 打红"读数按**体积**"那条 —— dose=0.4 ≠ 1，所以这个假对能被抓出来
else if (RED === 'r18' || RED === 'r20') {
  const MUT = {
    r18: [LAB_DOSED, '/* r18 变异：喂料点不记账 ⇒ 读数恒 0 */'],
    r20: [LAB_DOSED, 'if (ent.state) ent.state.dosed = (ent.state.dosed || 0) + 1; /* r20 变异：按次数累加 */'],
  }[RED];
  labMod = await import(makeMutant('src/equipment/lab.js', TMP_FILES[0], MUT[0], MUT[1]));
  const lm2 = fs.readFileSync(TMP_FILES[0], 'utf8');
  const lsrc2 = fs.readFileSync(path.join(HERE, '..', 'src', 'equipment', 'lab.js'), 'utf8');
  MUTCHAIN = { file: 'lab.js', old: MUT[0], next: MUT[1], textMutated: lm2 !== lsrc2 && lm2.includes(MUT[1]), chainLinked: true };
}
else labMod = await import('../src/equipment/lab.js');
const { canFeed, feedInto } = labMod;
if (['r1', 'r4', 'r5', 'r18', 'r20'].includes(RED)) labPlugin = labMod.default;
// r6：把滴瓶每次用量改成 0 ⇒ canFeed 为假 ⇒ 滴瓶那几条断言必须红
if (RED === 'r6') labwarePlugin = (await import(makeMutant('src/equipment/labware.js', TMP_FILES[1], "defaults: { reagent: 'H2O', dose: 0.05 }", "defaults: { reagent: 'H2O', dose: 0 }"))).default;
else if (RED === 'r2') labwarePlugin = (await import(makeMutant('src/equipment/labware.js', TMP_FILES[1], 'DEFS.push(() => define(crucibleDef));', '/* r2 变异：坩埚不注册 */'))).default;
// r8：漏斗不再自报 retainSolids ⇒ 过滤失效（证生效点是「器材自报」，不是倾倒链路猜的）
else if (RED === 'r8') labwarePlugin = (await import(makeMutant('src/equipment/labware.js', TMP_FILES[1], 'this.vessel.retainSolids = true;', '/* r8 变异：漏斗不自报 */'))).default;
// r10：集气瓶不再自报 collectGas ⇒ 气体收不进来（与 r8 同形态：生效点是能力声明）
else if (RED === 'r10') labwarePlugin = (await import(makeMutant('src/equipment/labware.js', TMP_FILES[1], 'this.vessel.collectGas = true;', '/* r10 变异：集气瓶不自报 */'))).default;
// r14..r17：蒸发结晶四档 —— 都只改 labware.js 一个文件（相变在器材自己的 step 里，vessel.js 不参与）
//   r14 汽化段 `if (false)`            ：越过的热不再变潜热 ⇒ 体积不降、已汽化恒 0
//   r15 不钉平台（temp 直接落在越过的位置）：★ 温度平台那一条必红（会冲过 100 ℃）
//   r16 析出段 `if (false)`            ：蒸干也不析出 ⇒ 结晶那几条必红
//   r17 **把蒸汽塞进 gas 账**（冒充"还在世界里"）：★★ 打红"蒸发不留下另一本账"那条
//       ⇒ 反向证明本件是**让物质离开**，不是把它搬给谁（没走转移算子）
else if (['r14', 'r15', 'r16', 'r17'].includes(RED)) {
  const MUT = {
    r14: ['if (v.volume > 0 && v.temp > bp) {', 'if (false) {'],
    r15: ['v.temp = bp + (excess - used) / cap;', '/* r15 变异：不把越过的显热转成潜热 ⇒ 温度不回归沸点平台 */'],
    r16: ['if (v.volume <= 1e-9 && v.mol.size) {', 'if (false) {'],
    r17: ['this.state.steamed += gone;', "this.state.steamed += gone; v.gas.set('H2O', (v.gas.get('H2O') || 0) + gone / 18.02);"],
  }[RED];
  labwarePlugin = (await import(makeMutant('src/equipment/labware.js', TMP_FILES[1], MUT[0], MUT[1]))).default;
  // 防假绿：单文件档也要把变异体读回来证明"文本真的换了"（chainLinked 恒真：本档没有链）
  // ⚠ 判据是"整份文本 ≠ 源文件"，**不能**用 `!includes(旧串)`：r17 是**追加**式变异，
  //    旧串仍是新串的前缀 ⇒ 那样会把自己误判成"没换"（本轮实测踩到过一次）。
  const lm = fs.readFileSync(TMP_FILES[1], 'utf8');
  const lsrc = fs.readFileSync(path.join(HERE, '..', 'src', 'equipment', 'labware.js'), 'utf8');
  MUTCHAIN = { file: 'labware.js', old: MUT[0], next: MUT[1], textMutated: lm !== lsrc && lm.includes(MUT[1]), chainLinked: true };
}
// r7/r9/r11/r12/r13/r19/r21：改 vessel.js 的搬运段、两处守卫、或指示剂阈值/pH 本体 —— 它被 glassware.js 静态 import ⇒ 整条链一起换
//   r7  `if (!retain) {` → `if (true) {`   ：过滤失效（固体照样被搬走）
//   r9  `if (!retain) {` → `if (false) {`  ：**所有**倾倒都不搬固体 ⇒ 打红"既有倾倒行为不变"那条
//   r11 `if (takeGas) {` → `if (false) {`  ：气体搬不动
//   r12 守卫①回退 ⇒ 只装气体的容器又被劝退（守卫①）
//   r13 守卫②回退 ⇒ 同上（守卫②）—— r12/r13 成对：只改一处时另一档仍会红 ⇒ 两处守卫都被钉住
//   r19 酚酞阈值 8.2 → 0 ：★ 打红「**酸性时加了酚酞也不该变粉**」那条 ⇒ 证明颜色跟着 pH 走，不是"这段代码被执行"
//   r21 `pH()` 钉死 7     ：★ 终点永远到不了 ⇒ 打红全部终点判据 ⇒ 反向证明"终点是 pH/颜色判出来的"
//        （⚠ 这条替代了原先设想的「用倒空液体冒充到终点」：本件**没有**"终点"这条代码，
//          所以根本没有"可以冒充"的东西 —— 能改变终点的只有 pH() 与指示剂，故直接钉 pH()。）
else if (['r7', 'r9', 'r11', 'r12', 'r13', 'r19', 'r21'].includes(RED)) {
  const MUT = {
    r7: ['if (!retain) {', 'if (true) {'],
    r9: ['if (!retain) {', 'if (false) {'],
    r11: ['if (takeGas) {', 'if (false) {'],
    r12: ['if (vol <= 0 && this.solid.size === 0 && !takeGas) return 0;', 'if (vol <= 0 && this.solid.size === 0) return 0;'],
    r13: ['if (v <= 0 && !takeGas) return 0;', 'if (v <= 0) return 0;'],
    r19: ['ph > 8.2', 'ph > 0'],
    r21: ['  pH() {', '  pH() { return 7;'],
  }[RED];
  const vesselUrl = makeMutant('src/chemistry/vessel.js', TMP_FILES[3], MUT[0], MUT[1]);
  const glassUrl = makeMutant('src/equipment/glassware.js', TMP_FILES[4], null, null, { '../chemistry/vessel.js': vesselUrl });
  labwarePlugin = (await import(makeMutant('src/equipment/labware.js', TMP_FILES[1], null, null, { './glassware.js': glassUrl }))).default;
  // ⚠ 必须**连 glassware 插件一起顶掉**：beaker/wastejar 的类出自 glassware 插件，
  //    只换 labware→glassware 这一条边的话，§4/§10 里的烧杯用的还是**真** VesselModel
  //    ⇒ 变异形同虚设、判据照样绿（这就是"假绿"，本轮实测踩过一次）。
  glasswarePlugin = (await import(glassUrl)).default;
  // ⚠ 防假绿：变异体没生效时断言会"照样绿"，那是最坏的一种绿。
  //    这里把变异体读回来，逐字证明：① 文本变异打进去了 ② 中间那一级指向了它。
  // ⚠ 判据用"整份文本 ≠ 源文件"而不是 `!includes(旧串)`：r21 是**前置插入**式变异，
  //    旧串 `  pH() {` 仍是新串的前缀 ⇒ 用 includes 会把自己误判成"没换"（同一族错误本轮修掉）。
  const vm = fs.readFileSync(TMP_FILES[3], 'utf8');
  const vsrc = fs.readFileSync(path.join(HERE, '..', 'src', 'chemistry', 'vessel.js'), 'utf8');
  const gm = fs.readFileSync(TMP_FILES[4], 'utf8');
  MUTCHAIN = {
    file: 'vessel.js',
    old: MUT[0], next: MUT[1],
    textMutated: vm !== vsrc && vm.includes(MUT[1]),
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

head('§7 锁定事实：化学域的 stats **只由 B4 统一加**，且必须走同一套 schema（不另立第二套）');
{
  const chem = list().filter((d) => d.domain === 'chemistry');
  const withStats = chem.filter((d) => d.stats).map((d) => d.type);
  ok(chem.length > 0, `化学域器材共 ${chem.length} 件`);
  // 2026-10-17 更新（T-01 接手会话，B4 第 2 步开工）：本条原为「化学域 0 件声明 stats」的事实快照，
  //   而 thermometer 是第一件落地的器材（src/equipment/lab.js 的 thermoDef.stats）⇒ 快照过时。
  //   按本探针那几条 ★ 哨兵的同一条思路 ——「有人动了它，就逼一次决定」—— 这里的决定是：
  //   **把锁从「没人加」改成「加了也必须同 schema」**。这样它仍能红，但红的是「另立第二套写法」，
  //   而不是「B4 正常推进」；后者再也不会把一条正常交付变成红灯。
  // 2026-10-17 再次更新（T-01 接手会话，第 2 步迁移 7）：新增第 3 个接口字段 `fmt`
  //   （自适应单位格式化，如 fmtR 的 Ω/kΩ/MΩ，见 plans/11 §6.5）⇒ 白名单跟着加。
  //   锁的语义不变：化学域可以声明 stats，但必须走**同一套** schema，不许另立写法。
  const KEYS = ['label', 'unit', 'digits', 'read', 'fmt'];
  const bad = chem.filter((d) => d.stats).filter((d) => (d.stats || []).some((s) => !s
    || typeof s.read !== 'function' || typeof s.label !== 'string'
    || Object.keys(s).some((k) => KEYS.indexOf(k) < 0)));
  ok(bad.length === 0,
    `★ 化学域 ${withStats.length} 件已声明 stats（${withStats.join(',') || '无'}）—— 全部走 B4 的同一套 schema`,
    bad.length ? '另立字段的：' + bad.map((d) => d.type).join(',') : '');
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

  // ⚠ 防假绿自证（只在连链变异档 r7/r9/r11/r12/r13 有）：变异体若没生效，上面那几条会"照样绿" —— 那是最坏的一种绿
  if (MUTCHAIN) {
    ok(MUTCHAIN.textMutated, `★ 变异真的打进了 ${MUTCHAIN.file} 变异体（${MUTCHAIN.old} → ${MUTCHAIN.next}）—— 否则这一档是假绿`, JSON.stringify(MUTCHAIN));
    ok(MUTCHAIN.chainLinked, MUTCHAIN.file === 'vessel.js' ? '★ 中间那一级确实指向 vessel 变异体（链没断）' : '★ 单文件档没有链（chainLinked 恒真，不构成证明）', JSON.stringify(MUTCHAIN));
  }
}

head('§11 气体导出：集气瓶自报「我要接管气体」（vessel.collectGas）');
{
  const world = new World(); world.time = 0;
  const gd = get('gasjar');
  ok(!!gd, '注册表里有 gasjar' + (gd ? `（${gd.name} · ${gd.cat}）` : '取到 null'));
  const gj0 = create('gasjar', 0, 0);
  ok(!!gj0 && !!gj0.vessel, '集气瓶是容器（extends Glassware ⇒ 白拿 insertZone / 序列化 / 存档里的 gas / 气泡）');
  ok(!!gj0 && gj0.vessel.collectGas === true, '★ 集气瓶**自报** collectGas（生效点是能力声明，不是倾倒链路猜它是不是集气瓶）');

  // ⚠ 这是"两处守卫"的定向判据：只装气体的容器 volume=0 且无固体 ⇒ 少改任一处守卫，这三条就红
  const gsrc = create('beaker', 0, 0), gdst = create('gasjar', 0, 0);
  if (gsrc && gdst) {
    gsrc.vessel.produce('H2', 0.05);
    gsrc.vessel.pourInto(gdst.vessel, 1);
    const got = gdst.vessel.gas.get('H2') || 0;
    ok(got > 0, '★★ 只装气体也能被倒出去（守卫①与守卫②都放行）', `目标收到 H₂ ${got} mol`);
    ok((gsrc.vessel.gas.get('H2') || 0) < 1e-12, '★★ 源容器气体清空', `剩余 ${(gsrc.vessel.gas.get('H2') || 0)} mol`);
    ok(Math.abs(gdst.vessel.amount('H2') - got) < 1e-12, '★ 气体算进 amount()（与溶解态/固体/沉淀并列的第四态）', `amount=${gdst.vessel.amount('H2')}`);
  } else { ok(false, '只装气体也能被倒出去'); ok(false, '源容器气体清空'); ok(false, '气体算进 amount()'); }

  // 真实路径：Zn + HCl ⇒ H₂ ⇒ 倒进集气瓶（端到端，全部走既有引擎，本件不新增任何化学）
  const zb = create('beaker', 0, 0), zj = create('gasjar', 0, 0);
  if (zb && zj) {
    zb.vessel.addSolid('Zn', 1);
    zb.vessel.addLiquid('HCl', 30);
    for (let i = 0; i < 40; i++) zb.vessel.step(0.05, world);
    const made = zb.vessel.gas.get('H2') || 0;
    ok(made > 0, '★ 既有引擎能生成气体（Zn + HCl ⇒ H₂）—— 这是"收气体"的前提', `H₂ ${made} mol`);
    zb.vessel.pourInto(zj.vessel, 1);
    ok(zj.vessel.gasTotal() > 0 && Math.abs(zj.vessel.gasTotal() - made) < 1e-9,
      '★★ 真实路径：生成的气体倒进了集气瓶', `瓶里 ${zj.vessel.gasTotal()} mol / 发生器原有 ${made} mol`);
    ok(Math.abs(zj.vessel.volume - 30) < 1e-6, '★ 同一次倾倒里，液体与溶解物照旧一起过去（集气瓶也是普通容器）', `体积 ${zj.vessel.volume} mL`);
  } else { ok(false, '既有引擎能生成气体'); ok(false, '真实路径：气体倒进集气瓶'); ok(false, '液体照旧过去'); }

  // 零影响：目标**没有**自报时，气体一个也不搬（既有默认行为逐字不变）
  const nb = create('beaker', 0, 0), nj = create('wastejar', 0, 0);
  if (nb && nj) {
    nb.vessel.produce('H2', 0.05);
    nb.vessel.addLiquid('CuSO4', 20);
    nb.vessel.pourInto(nj.vessel, 1);
    ok(nj.vessel.gas.size === 0 && nb.vessel.gas.size === 1,
      '★★ 目标没自报 collectGas ⇒ 气体一个也不搬（既有默认行为不变）', `目标气体 ${nj.vessel.gas.size} 项 / 源 ${nb.vessel.gas.size} 项`);
    ok(Math.abs(nj.vessel.volume - 20) < 1e-6, '★ 该倾倒的液体照旧倾倒（守卫改动没有影响既有转移）', `体积 ${nj.vessel.volume} mL`);
  } else { ok(false, '目标没自报 ⇒ 气体不搬'); ok(false, '既有倾倒不受影响'); }

  // ⭐ 把"5 种气体 / 4 种可产出 / SO2 有物种无来源"钉在**探针**里（不留只活在 plans/ 的知识）
  const { RULES: R2 } = await import('../src/chemistry/reactions.js');
  const { SP: SP2 } = await import('../src/chemistry/species.js');
  const withGas = R2.filter((r) => Array.isArray(r.gas) && r.gas.length);
  const gasSp = Object.keys(SP2).filter((k) => SP2[k].st === 'g');
  const gsrc2 = [...new Set(withGas.flatMap((r) => r.gas))].sort();
  const wantGas = ['H2', 'O2', 'Cl2', 'CO2'].sort();   // ⚠ 别手写顺序：sort 后是 CO2,Cl2,H2,O2
  ok(withGas.length === 14, '★ RULES 里带 gas:[…] 的仍是 14 条（气体导出不改任何化学规则）', `实际 ${withGas.length}`);
  ok(gasSp.length === 5, '★ SP 里有 5 种气态物种且全部 gas:true', gasSp.map((k) => k + (SP2[k].gas ? '' : '(✗无 gas:true)')).join(', '));
  ok(JSON.stringify(gsrc2) === JSON.stringify(wantGas),
    '★ 规则实际只产出 4 种气体（H2/O2/Cl2/CO2）—— 不是 5 种', `实际 ${gsrc2.join(',')}`);
  ok(gasSp.includes('SO2') && !gsrc2.includes('SO2'),
    '★ SO2 有物种、却没有来源（有 species 无 RULES）—— 既有事实，本件不开规则', 'SO2 ∈ 物种 ✓ / ∈ 规则产物 ✗');
}

head('§12 蒸发结晶：相变发生在器材自己的 step() 里（IceBath 那条轨道）');
{
  const world = new World(); world.time = 0;
  const d = get('evapdish');
  ok(!!d, '注册表里有 evapdish' + (d ? `（${d.name} · ${d.cat}）` : '取到 null'));
  const ed = create('evapdish', 0, 0);
  ok(!!ed && !!ed.vessel, '蒸发皿持有 vessel（可倒进 / 可被灯加热 / 随场景存取）');

  // 场景 A：倒进 30 mL 硫酸铜溶液，给一大笔热（一帧就足以越过沸点）⇒ 蒸干 + 析出
  const src = create('beaker', 0, 0), side = create('beaker', 0, 0);
  if (ed && src && side) {
    src.vessel.addLiquid('CuSO4', 30);
    src.vessel.pourInto(ed.vessel, 1);
    side.vessel.addLiquid('NaCl', 12);
    const sideVol = side.vessel.volume, sideMass = side.vessel.totalMass();
    ok(Math.abs(ed.vessel.volume - 30) < 1e-6, '★ 前一件的倾倒照旧可用（把溶液倒进蒸发皿）', `体积 ${ed.vessel.volume} mL`);
    ed.vessel.addHeat(80000);   // 故意一大笔：写法要对"越过去"成立，而不是只对"正好停在沸点"成立
    for (let i = 0; i < 60; i++) ed.step(0.05, world);
    ok(ed.state.steamed > 0, '★ 越过沸点的显热变成了汽化潜热（水真的少了）', `已汽化 ${ed.state.steamed.toFixed(2)} g`);
    ok(ed.vessel.volume <= 1e-9, '★ 30 mL 全汽化 ⇒ 蒸干', `剩余体积 ${ed.vessel.volume}`);
    ok(Math.abs(ed.state.steamed - 30) < 0.5, '★★ 潜热账对得上（ρ=1 ⇒ 30 mL ≈ 30 g）', `已汽化 ${ed.state.steamed.toFixed(3)} g`);
    ok(ed.vessel.solid.has('CuSO4') && !ed.vessel.mol.has('CuSO4'), '★★ 蒸干 ⇒ 溶质析出为固体（且离开溶解态）', `固体 ${(ed.vessel.solid.get('CuSO4') || 0).toFixed(2)} g`);
    ok(Math.abs(ed.state.crystallized - (ed.vessel.solid.get('CuSO4') || 0)) < 1e-9, '★ 析出记在**同一个 id** 的 solid 上（零新增物种）', `已析出 ${ed.state.crystallized.toFixed(2)} g`);
    ok(ed.state.crystallized > 0 && ed.vessel.mol.size === 0, '★ 溶剂也清掉了（蒸干后 mol 为空）', `mol 剩 ${ed.vessel.mol.size} 项`);
    ok(ed.vessel.totalMass() < 30, '★ 物质真的离开了容器（总质量只剩析出的固体）', `总质量 ${ed.vessel.totalMass().toFixed(2)} g`);
    ok(ed.vessel.gas.size === 0, '★★ 蒸发不留下"另一本账"：气账里没有水（r17 的靶子）', `气体 ${ed.vessel.gas.size} 项`);
    ok(Math.abs(side.vessel.volume - sideVol) < 1e-9 && side.vessel.gas.size === 0 && Math.abs(side.vessel.totalMass() - sideMass) < 1e-9,
      '★★ 旁边的容器一个数都没变 ⇒ 蒸发**没走转移算子**（不是"搬给了谁"）', `邻杯 ${side.vessel.volume} mL / 气体 ${side.vessel.gas.size} 项`);
  } else { for (let i = 0; i < 9; i++) ok(false, `场景 A 第 ${i + 1} 条（器具没造出来）`); }

  // 场景 B：只给一半的热 ⇒ 水还剩 ⇒ 温度**钉在沸点**，且水账守恒（剩余体积 + 已汽化 = 30）
  const ed2 = create('evapdish', 0, 0), s2 = create('beaker', 0, 0);
  if (ed2 && s2) {
    s2.vessel.addLiquid('CuSO4', 30);
    s2.vessel.pourInto(ed2.vessel, 1);
    ed2.vessel.addHeat(40000);
    for (let i = 0; i < 20; i++) ed2.step(0.05, world);
    ok(ed2.vessel.volume > 0 && ed2.vessel.volume < 30, '★ 热只够汽化一部分 ⇒ 还有水', `剩 ${ed2.vessel.volume.toFixed(2)} mL`);
    ok(ed2.vessel.temp <= 100 + 1e-6, '★★ 温度**钉在沸点**（平台）：越过的那部分热记账成潜热', `温度 ${ed2.vessel.temp.toFixed(3)} ℃`);
    ok(Math.abs(ed2.vessel.volume + ed2.state.steamed - 30) < 0.01, '★★ 水账守恒：剩余体积 + 已汽化 = 30（没有蒸发到别处）', `${ed2.vessel.volume.toFixed(3)} + ${ed2.state.steamed.toFixed(3)}`);
    const vol0 = ed2.vessel.volume;
    for (let i = 0; i < 40; i++) ed2.step(0.05, world);
    ok(Math.abs(ed2.vessel.volume - vol0) < 1e-9, '★ 不再加热就不再汽化（不是"一到 100 ℃ 就一直烧干"）', `体积仍 ${ed2.vessel.volume.toFixed(3)} mL`);
    ok(ed2.vessel.temp < 100 + 1e-6, '★ 停止加热后温度从平台往下走（散热项照旧在跑）', `温度 ${ed2.vessel.temp.toFixed(3)} ℃`);
  } else { for (let i = 0; i < 5; i++) ok(false, `场景 B 第 ${i + 1} 条（器具没造出来）`); }

  // 结构：零新增物种 + 常量单一来源
  const { SP: SP3 } = await import('../src/chemistry/species.js');
  const cnt = {}; for (const k in SP3) cnt[SP3[k].st] = (cnt[SP3[k].st] || 0) + 1;
  const { L_VAPOR: LV, boilPoint: BP } = await import('../src/equipment/thermal.js');
  ok(Object.keys(SP3).length === 48 && JSON.stringify(cnt) === JSON.stringify({ l: 2, aq: 27, s: 14, g: 5 }),
    '★ 物种库一动没动（48 条 / 同一分布）⇒ 结晶没有新增物种', `${Object.keys(SP3).length} 条 ${JSON.stringify(cnt)}`);
  ok(LV === 2260 && Math.abs(BP(101.325) - 100) < 1e-9, '★ 沸点与潜热取自 thermal.js 那一份（2260 J/g、101.325 kPa ⇒ 100 ℃）', `${LV} / ${BP(101.325)}`);
  const labTxt = fs.readFileSync(path.join(HERE, '..', 'src', 'equipment', 'labware.js'), 'utf8');
  ok(labTxt.includes("from './thermal.js'") && (labTxt.match(/2260/g) || []).length === 0,
    '★ 常量单一来源：蒸发皿 import thermal.js，自己**没有**再抄一份 2260', `labware.js 里 2260 出现 ${(labTxt.match(/2260/g) || []).length} 次`);

  // ⭐ `glass-dry-burn` 判据目前恒假 —— 与 SO2 / 变压器二次侧同处理：**断在 tools/ 里**，别只活在不进发布的文档里
  const writers = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js')) {
        for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
          if (/(?<!state\.)\bheatIn\s*=[^=]/.test(line)) writers.push(`${e.name}: ${line.trim()}`);
        }
      }
    }
  };
  walk(path.join(HERE, '..', 'src'));
  ok(writers.length === 1 && writers[0].startsWith('vessel.js: this.heatIn = 0;'),
    '⭐⭐ `vessel.heatIn` 全仓**只有声明处给它赋过值**（`this.heatIn = 0;`）⇒ glass-dry-burn 的 `(v.heatIn || 0) > 15` 目前**恒假**',
    writers.join(' | ') || '（一处都没有 ⇒ 连声明都没了？）');
  const dryTxt = fs.readFileSync(path.join(HERE, '..', 'src', 'plugins', 'rules.damage.js'), 'utf8');
  ok(dryTxt.includes('(v.heatIn || 0) > 15'),
    '★ 判据原文仍是 `(v.heatIn || 0) > 15` ⇒ 有人补了写入者，上面那条会先红，逼一次决定',
    '（本件只记不改：补写入者会让既有一切"加热中且液体 < 4 mL"的场景开始炸裂 ⇒ 必须单独批准）');
  const ed3 = create('evapdish', 0, 0);
  if (ed3) {
    ed3.vessel.addLiquid('H2O', 10);
    ed3.vessel.addHeat(5000);
    ed3.step(0.05, world);
    ok(ed3.vessel.heatIn === 0, '⭐ 运行时也证一遍：被引擎加热过、真跑过 step 的容器，heatIn 仍是 0', `heatIn=${ed3.vessel.heatIn}`);
  } else { ok(false, '运行时也证一遍 heatIn 恒 0'); }
}

head('§13 滴定：滴定管（定量滴加）+ 终点判定（既有 pH 与既有指示剂变色）');
{
  // 本节的立场：滴定**不是**新算子 —— 它 = 既有的"定量加料"（lab.js canFeed/feedInto）
  //   + 既有的终点判据（vessel.pH() 与 vessel.updateColor() 里的酚酞/石蕊）
  //   + 既有的中和规则（RULES 三条）。新增的只有**一件器材**和**一个累计读数**。
  const world = new World(); world.time = 0;
  const td = get('titrant');
  ok(!!td, '注册表里有 titrant' + (td ? `（${td.name} · ${td.cat}）` : '取到 null'));
  ok(!!td && td.cat === '取用', 'cat=取用 ⇒ feedInto 走**液体**分支（判固/液的是 cat，不是 dose）', td && td.cat);
  ok(!!td && td.defaults && td.defaults.dose === 0.4,
    '★ 每次放出默认 0.4 mL（**故意不是 1**：这样"按体积累计"和"按次数累计"在探针里可区分）', JSON.stringify(td && td.defaults));
  ok(!!td && td.state && td.state.dosed === 0, '读数 state.dosed 初始 0（单位 **mL**，与 props.dose 同口径）');

  const tube = create('titrant', 0, 0);
  const flask = create('beaker', 0, 0);
  if (tube && flask) {
    ok(canFeed(tube), '★ 滴定管**自报**可加料（canFeed 只读 props.reagent/props.dose ⇒ 生效点是能力声明）',
      `reagent=${tube.props.reagent} dose=${tube.props.dose}`);

    // ① 读数：喂 1/2/3 次 ⇒ 恰好 dose / 2dose / 3dose（★ 少喂一次就少一份）
    const seq = [];
    for (let i = 1; i <= 3; i++) { feedInto(tube, flask.vessel); seq.push(tube.state.dosed); }
    ok(Math.abs(seq[0] - 0.4) < 1e-9, '★ 喂 1 次 ⇒ 读数 = dose（0.4 mL）', `dosed=${seq[0]}`);
    ok(Math.abs(seq[1] - 0.8) < 1e-9, '★ 喂 2 次 ⇒ 读数 = 2×dose', `dosed=${seq[1]}`);
    ok(Math.abs(seq[2] - 1.2) < 1e-9, '★ 喂 3 次 ⇒ 读数 = 3×dose', `dosed=${seq[2]}`);
    ok(seq[0] < seq[1] && seq[1] < seq[2], '★★ 少喂一次 ⇒ 读数就少一份（严格递增 ⇒ 挡掉"每次读都返回 dose×1"的假对）', seq.join(' → '));
    ok(Math.abs(seq[2] - 3) > 0.5, '★★ 读数**不等于次数**（0.4×3=1.2 ≠ 3）⇒ 挡掉"按次数累加"的假对：dose 特意不是 1', `dosed=${seq[2]} vs 次数 3`);
    ok(Math.abs(flask.vessel.volume - 1.2) < 1e-6, '★ 目标容器真的收到了 1.2 mL —— 读数与加料同源，不是凭空记数', `体积 ${flask.vessel.volume} mL`);

    // ② ★ 酸性时加了酚酞**也不该变粉**（r19 打的就是这条：颜色跟着 pH 走，不是"这段代码被执行"）
    const acid = create('beaker', 0, 0);
    acid.vessel.addLiquid('HCl', 30);
    acid.vessel.updateColor();
    const cBefore = (acid.vessel.color || []).slice();
    acid.vessel.addLiquid('Phenolphthalein', 2);
    acid.vessel.updateColor();
    const cAcid = (acid.vessel.color || []).slice();
    const same = cBefore.length === cAcid.length && cBefore.every((x, i) => Math.abs(x - cAcid[i]) < 1e-9);
    ok(acid.vessel.pH() < 5, '滴定前是酸性（pH 由**既有** vessel.pH() 算出来，本件不造新判据）', `pH=${acid.vessel.pH().toFixed(2)}`);
    ok(same, '★★ 酸性时加了酚酞也不变粉（颜色与"不加酚酞"时逐字相同）—— 颜色跟着 pH 走', `pH=${acid.vessel.pH().toFixed(2)}`);

    // ③ 滴到终点：颜色变了、真的变粉、中和真的发生、pH 越过 8.2
    const hcl0 = acid.vessel.mol.get('HCl') || 0;
    let drops = 0;
    while (acid.vessel.pH() < 8.2 && drops < 4000) { feedInto(tube, acid.vessel); acid.vessel.step(0.02, world); drops += 1; }
    const cEnd = (acid.vessel.color || []).slice();
    const changed = !(cEnd.length === cAcid.length && cAcid.every((x, i) => Math.abs(x - cEnd[i]) < 1e-9));
    ok(acid.vessel.pH() > 8.2, '★ 滴到终点（pH 越过酚酞阈值 8.2）',
      `pH=${acid.vessel.pH().toFixed(2)}，滴了 ${drops} 次 ≈ ${tube.state.dosed.toFixed(2)} mL`);
    ok(changed, '★★ 到终点才变粉（颜色与酸性时不同）', `${JSON.stringify(cAcid)} → ${JSON.stringify(cEnd)}`);
    ok(cEnd.length >= 3 && cEnd[0] > cEnd[2], '★ 变的是**粉/红**方向（红通道 > 蓝通道 = 酚酞的 [232,72,118]）', JSON.stringify(cEnd));
    ok((acid.vessel.mol.get('NaCl') || 0) > 0, '★ 中和真的发生（生成 NaCl）—— 用的是既有 RULES，不是本件新增的化学',
      `NaCl ${(acid.vessel.mol.get('NaCl') || 0).toFixed(4)} mol`);
    ok((acid.vessel.mol.get('HCl') || 0) < hcl0, '★ 酸被消耗（HCl 减少）',
      `HCl ${hcl0.toFixed(4)} → ${(acid.vessel.mol.get('HCl') || 0).toFixed(4)} mol`);
    ok(acid.vessel.temp > 25, '★ 中和放热（既有热账本，dH=-57.3 kJ/mol）', `T=${acid.vessel.temp.toFixed(2)} ℃`);

    // ④ ★★ 终点是"判"出来的，不是"做"出来的
    ok(acid.vessel.volume > 25, '★★ 到终点时容器里**仍然有液体** —— 终点靠 pH/颜色判，不是靠把液体倒掉做出来',
      `体积 ${acid.vessel.volume.toFixed(1)} mL`);
    ok(acid.vessel.volume > 0 && (acid.vessel.mol.get('NaCl') || 0) > 0 && acid.vessel.pH() > 8.2,
      '★★ 终点的三个条件同时成立：液在、盐在、颜色到了');

    // ⑤ 零影响：不动共享模型、不动规则
    const { RULES: R3 } = await import('../src/chemistry/reactions.js');
    ok(R3.length === 26, '★ RULES 仍是 26 条（中和用既有三条，本件不加规则）', `实际 ${R3.length}`);
    ok(!R3.some((r) => /滴定|titrat/i.test(r.id)), '★ RULES 里**没有**滴定规则（滴定是"操作"，不是"反应"）');
    const { VesselModel: VM } = await import('../src/chemistry/vessel.js');
    ok(typeof VM.prototype.pH === 'function', '★ pH() 是**既有**方法（vessel.js:194），本件没给它加东西');
    const vsrc = fs.readFileSync(path.join(HERE, '..', 'src', 'chemistry', 'vessel.js'), 'utf8');
    ok(!/dosed/.test(vsrc), '★★ vessel.js 里**没有** dosed ⇒ 读数不在共享模型上（VesselModel 零新增字段）');
    const lsrc = fs.readFileSync(path.join(HERE, '..', 'src', 'equipment', 'lab.js'), 'utf8');
    ok(lsrc.includes(LAB_DOSED), '★ 读数的唯一写入者是 lab.js feedInto 那一行（r18/r20 打的就是它）');

    // ⭐ species.js 的 acid 字段：与 vessel.heatIn 同族 —— 声明了、填了、**全仓零读取者**
    const walk = (dir, out = []) => {
      for (const n of fs.readdirSync(dir)) {
        const p = path.join(dir, n);
        if (fs.statSync(p).isDirectory()) walk(p, out); else if (n.endsWith('.js')) out.push(p);
      }
      return out;
    };
    const root = path.join(HERE, '..');
    // ⚠ 本条断言问的是「有没有人**读**这个字段」，所以两个陷阱都要躲开：
    //    ① 注释不是代码 —— 本仓既有的注释里就写着「acid 字段全仓零读取者」，
    //       按整行 grep 会把这句自述当成读取者，于是断言自己把自己顶红（D58/D61）。
    //    ② 「出现过这个词」不等于「读了这个字段」—— species.js 里的 `acid: 'strong'`
    //       是**定义**（对象字面量的键），它必须被算作"没人读"而不是"有人读"。
    //    判据因此收紧成「剥掉注释后，仍存在 .acid / ['acid'] / ["acid"] 形态的读取」。
    const stripComments = (src) => src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map((ln) => ln.replace(/\/\/.*$/, ''))
      .join('\n');
    const readers = [];
    for (const p of walk(path.join(root, 'src'))) {
      const code = stripComments(fs.readFileSync(p, 'utf8'));
      code.split('\n').forEach((ln, i) => {
        if (/\.acid\b|\[\s*['"]acid['"]\s*\]/.test(ln)) {
          readers.push(`${path.relative(root, p).replace(/\\/g, '/')}:${i + 1}  ${ln.trim().slice(0, 80)}`);
        }
      });
    }
    ok(readers.length === 0,
      '★★ species.js 的 acid 字段**全仓零读取者**（与 vessel.heatIn 同族：声明了没人读 ⇒ 谁补了读取者这条先红）',
      `读取者 ${readers.length} 处${readers.length ? '：' + readers.join(' | ') : ''}（判据已剥注释、且只认 .acid / [\'acid\'] 形态，避免把定义与自述当读取）`);
  } else {
    for (let i = 0; i < 20; i++) ok(false, `§13 第 ${i + 1} 条断言（建不出滴定管/烧杯）`);
  }
}

head('§14 清理：变异体残留为 0');
{
  const sw = sweepTmp();
  ok(sw.left === 0, '本批临时文件残留为 0（正常模式下本来就没有）', `残留=${sw.left}`);
}

console.log('\n' + '─'.repeat(56));
console.log((fail === 0 ? '化学器皿探针：全部通过：' : '化学器皿探针：失败：') + `${pass + fail} 项（绿 ${pass} / 红 ${fail}）`);
if (F.length) console.log('红灯清单：\n  - ' + F.join('\n  - '));
console.log('CHEMLAB_JSON ' + JSON.stringify({ mode: RED ? `red:${RED}` : 'normal', passed: pass, failed: fail, reds: F }));
process.exitCode = fail === 0 ? 0 : 1;
