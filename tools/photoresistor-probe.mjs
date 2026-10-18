// ══════════════════════════════════════════════════════════
// 无头探针：光敏电阻（照度 → 电阻）
//
//   node tools/photoresistor-probe.mjs            绿档
//   node tools/photoresistor-probe.mjs --mutate   红档（变异体落在 %TEMP%，仓库零字节改动）
//
// 证明四件事，每件都用**两条互不依赖的路径**对撞：
//   ① 相对照度口径：1/r² 的手工算值 ↔ 器材自报的 state.relE（是**相对值**，不是 lx）
//   ② 电阻幂律：边界值 + 严格单调 ↔ resistanceNow()
//   ③ 端到端：解析 I = emf/(R+rint) ↔ MNA 求解器写回的 state.I（暗态与亮态各一次）
//   ④ 发光体判据：**热源也有 props.power**（单位 W）⇒ 必须按 wavelength 认发光体，
//      否则酒精灯会被当灯照。这条是探针里**唯一**防的"静默物理错误"。
//
// 三条纪律（与本仓其它探针同）：
//   · 源码判据的输入**先在读取处统一剥注释**（否则注释里复制一份锚点 ⇒ 假拦截 + 假生效）
//   · 不认识的开关一律 exit=2（静默忽略 = "我验了"和"我什么也没验"长得一模一样）
//   · 变异体验证"桩确实落在代码行上"，而不是"脚本没报错"
// ══════════════════════════════════════════════════════════

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const REPO = new URL('../', import.meta.url);

// ── 不认识的开关 ⇒ 明确拒绝（此前是静默忽略 ⇒ 空转的绿） ──
const known = new Set(['--mutate']);
const bad = process.argv.slice(2).filter((a) => !known.has(a));
if (bad.length) {
  console.log(`✗ 不认识的开关：${bad.join(' ')} —— 本探针只认 ${[...known].join(' / ')}`);
  process.exit(2);
}
const MUTATE = process.argv.includes('--mutate');

// ── 源码判据的输入：读取处统一剥注释 ──
const stripComments = (s) => s.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
const readRaw = (rel) => readFileSync(new URL(rel, REPO), 'utf8');
const readCode = (rel) => stripComments(readRaw(rel));

import { World } from '../src/core/world.js';
import { PluginHost } from '../src/core/plugin.js';
import { create, bindRegistry } from '../src/equipment/registry.js';
import { solveCircuit } from '../src/physics/circuit.js';
import { CouplingBus } from '../src/coupling/bridge.js';

import physicsPlugin from '../src/physics/circuit.js';
import bridgePlugin from '../src/coupling/bridge.js';
import electricalPlugin from '../src/equipment/electrical.js';
import opticsPlugin from '../src/equipment/optics.js';
import thermalPlugin from '../src/equipment/thermal.js';
import heatingPlugin from '../src/equipment/heating.js';
import electronicsPlugin, * as E from '../src/equipment/electronics.js';

const ELECTRONICS_SRC = 'src/equipment/electronics.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => {
  if (cond) { pass++; console.log('  \x1b[32m✓\x1b[0m ' + msg); }
  else { fail++; console.log('  \x1b[31m✗\x1b[0m ' + msg); }
};
const head = (t) => console.log('\n\x1b[36m' + t + '\x1b[0m');
const info = (t) => console.log('    \x1b[90m' + t + '\x1b[0m');
const near = (a, b, tolRel) => Math.abs(a - b) <= tolRel * Math.max(1e-12, Math.abs(b));
const pct = (a, b) => (100 * Math.abs(a - b) / Math.max(1e-12, Math.abs(b))).toFixed(4) + '%';

function mockCtx() {
  const grad = { addColorStop() {} };
  return new Proxy({}, {
    get(_t, k) {
      if (k === 'createLinearGradient' || k === 'createRadialGradient') return () => grad;
      if (k === 'canvas') return { width: 800, height: 600 };
      if (k === 'measureText') return () => ({ width: 10 });
      if (k === 'getImageData') return () => ({ data: new Uint8ClampedArray(4) });
      return () => {};
    },
    set() { return true; },
  });
}
const CTX = mockCtx();
const DT = 1 / 120;

/** 无头宿主：与 main.js 的 instrumentWorld 同一条流水线（造支路→解电路→分发→世界步进） */
function boot(electronics = electronicsPlugin) {
  const bootApp = {
    services: {}, ticks: [], world: null, lastCircuit: null, selected: null,
    log: { push() {}, clear() {} }, toast() {},
    addTick(fn) { this.ticks.push(fn); return () => {}; },
  };
  const host = new PluginHost(bootApp);
  for (const p of [physicsPlugin, bridgePlugin, electricalPlugin, opticsPlugin, thermalPlugin, heatingPlugin, electronics]) host.define(p);
  host.installAll();
  bindRegistry(host.registry('equipment'));
  return host;
}
function build(sc) {
  const world = new World();
  const cb = new CouplingBus(world);
  const raw = world.step.bind(world);
  const ents = [];
  for (const o of sc.entities || []) {
    const ent = create(o.type, o.x, o.y);
    if (!ent) { console.log('  !! 无法创建器材: ' + o.type); continue; }
    if (o.props) for (const k of Object.keys(o.props)) ent.setProp(k, o.props[k]);
    if (o.state) Object.assign(ent.state, o.state);
    world.add(ent, true);
    ents.push(ent);
  }
  for (const w of sc.wires || []) {
    const a = ents[w[0]], b = ents[w[2]];
    if (a && b) world.connect({ e: a.id, p: w[1] }, { e: b.id, p: w[3] }, 'wire');
  }
  const tick = () => {
    const c = solveCircuit(world, cb.buildBranches());
    cb.distribute(DT, c);
    raw(DT);
    return c;
  };
  return {
    world, ents, tick, get: (i) => ents[i],
    run(sec) { for (let i = 0, n = Math.round(sec / DT); i < n; i++) this.tick(); },
  };
}

/** 光敏电阻 + 可选发光体；返回该件的 state 快照 */
function photoScene(lightX, lightProps) {
  const ents = [{ type: 'photoresistor', x: 1000, y: 0 }];
  if (lightX != null) ents.push({ type: 'lightsource', x: lightX, y: 0, props: lightProps });
  const s = build({ entities: ents, wires: [] });
  s.run(0.1);
  return { s, photo: s.get(0) };
}

// ══════════════════════════════════════════════════════════
head('① 装配 + 键面：两端口、走电阻钩子、不占用求解器四键');
// ══════════════════════════════════════════════════════════
const host = boot();
const names = host.registry('equipment').list().map((d) => d.type);
ok(names.includes('photoresistor'), `注册表里有 photoresistor（当前共 ${names.length} 件）`);
{
  const p = create('photoresistor', 0, 0);
  const wp = p.ports.filter((x) => x.kind === 'wire');
  ok(wp.length === 2, `两端口都是 wire（${wp.length} 个）—— 够 MNA 取一条支路`);
  ok(typeof p.resistanceAt === 'function' && typeof p.resistanceNow === 'function',
    '实现了 resistanceAt() / resistanceNow() —— 求解器电阻钩子（circuit.js:150-151 实体优先）');
  const br = p.circuitBranch();
  ok(br && br.type === 'R' && br.r > 0, `支路形态 = {type:'${br && br.type}', r:${br && br.r}}（**R** 支路，不是 V）`);
  ok(br.r === p.props.rDark, `初始（未步进、无照度）支路电阻 = 暗电阻 ${p.props.rDark} Ω`);
  // 源码判据：def 的 state 字面量不许占用 I/U/P/R（求解器会写回那四个键）
  const code = readCode(ELECTRONICS_SRC);
  const raw = readRaw(ELECTRONICS_SRC);
  const i0 = code.indexOf("type: 'photoresistor'");
  const block = i0 < 0 ? '' : code.slice(i0, code.indexOf('\n};', i0));
  const clash = /\b(I|U|P|R):/.test(block.replace(/rNow:|rDark:|rLight:/g, ''));
  ok(i0 >= 0 && block.length > 0, '源码里定位到 photoresistor 的 def 块（剥注释后）');
  ok(!clash, 'def 的 state 不占用 I/U/P/R 四键（求解器写回键，器材不许抢）');
  // 有牙：锚点不在注释里 —— 原始文本与剥注释后计数必须一致
  const hitsRaw = raw.split("type: 'photoresistor'").length - 1;
  const hitsCode = code.split("type: 'photoresistor'").length - 1;
  ok(hitsRaw === hitsCode && hitsCode === 1,
    `锚点不在注释里：原始文本 ${hitsRaw} 次 ⟷ 剥注释后 ${hitsCode} 次`);
}

// ══════════════════════════════════════════════════════════
head('② 无照度 vs 有照度（正控非空转）');
// ══════════════════════════════════════════════════════════
{
  const { photo } = photoScene(null);
  ok(photo.state.srcId === null && photo.state.relE === 0,
    `无发光体：srcId=null、相对照度 ${photo.state.relE}%`);
  ok(photo.state.rNow === photo.props.rDark, `无照度 ⇒ R = 暗电阻 ${photo.state.rNow} Ω`);
  ok(Number.isNaN(photo.state.srcDist), `距离报 NaN 而不是 0（0 = "贴在一起"，NaN = "没有源"）`);
}
{
  const { photo } = photoScene(900);   // 距离 100 px
  ok(photo.state.relE > 0 && photo.state.srcDist === 100,
    `正控（非空转）：装上发光体 ⇒ 相对照度 ${photo.state.relE}%、距离 ${photo.state.srcDist} px`);
}

// ══════════════════════════════════════════════════════════
head('③ 相对照度口径：1/r² 手工值与器材自报对撞');
// ══════════════════════════════════════════════════════════
{
  const at = (d, power) => photoScene(1000 - d, power == null ? undefined : { power }).photo.state.relE;
  // 手工：E = 100·(P/5)·(100/d)²（P 默认 5 mW）
  const cases = [[100, 100], [200, 25], [400, 6.25], [50, 100]];
  for (const [d, want] of cases) {
    const got = at(d);
    ok(near(got, want, 1e-9), `d=${d} px ⇒ 相对照度 ${got.toFixed(4)}%（手工式给 ${want}%，差 ${pct(got, want)}）`);
  }
  const e1 = at(100), e2 = at(200);
  ok(near(e1 / e2, 4, 1e-9), `距离加倍 ⇒ 照度变 1/4（实测比 ${(e1 / e2).toFixed(4)}）—— 平方律`);
  const eP = at(200, 10);
  ok(eP > at(200), `功率加倍（5→10 mW）⇒ 照度升高（在**未封顶**的 d=200 处：${at(200).toFixed(2)}% → ${eP.toFixed(2)}%）`);
  ok(at(10) <= 100.0001, `近场封顶不越界：d=10 px ⇒ ${at(10).toFixed(2)}%（≤100）`);
}

// ══════════════════════════════════════════════════════════
head('④ 电阻幂律：边界值 + 严格单调（不看公式细节，抗实现变动）');
// ══════════════════════════════════════════════════════════
{
  const { photo } = photoScene(900);   // E = 100
  ok(photo.state.rNow === photo.props.rLight, `相对照度 100% ⇒ R = 亮电阻 ${photo.state.rNow} Ω`);
  const rs = [];
  for (const d of [400, 200, 150, 120, 100]) {
    const { photo: p2 } = photoScene(1000 - d);
    rs.push({ d, E: p2.state.relE, R: p2.state.rNow });
  }
  let mono = true, inBand = true;
  for (let i = 1; i < rs.length; i++) if (!(rs[i].R < rs[i - 1].R)) mono = false;
  for (const r of rs) if (!(r.R > 0 && r.R >= 500 - 1e-9 && r.R <= 100000 + 1e-9)) inBand = false;
  info(rs.map((r) => `d=${r.d}:E=${r.E.toFixed(2)}%,R=${r.R.toFixed(0)}Ω`).join('  '));
  ok(mono, '照度升高 ⇒ 电阻**严格**下降（5 个照度点两两比较）');
  ok(inBand, '所有电阻都落在 [亮电阻, 暗电阻] 带内（幂律不许外溢）');
}

// ══════════════════════════════════════════════════════════
head('⑤ 端到端真电路：解析 I = emf/(R+rint) ↔ MNA 写回的 state.I');
// ══════════════════════════════════════════════════════════
// 电池(1.5 V, 内阻 1 Ω) 串 光敏电阻；发光体放在光敏电阻左侧 100 px（不接线，只是照亮）
function circuitScene(lightOn) {
  const ents = [
    { type: 'battery', x: 0, y: 0 },
    { type: 'photoresistor', x: 100, y: 0 },
  ];
  if (lightOn) ents.push({ type: 'lightsource', x: 0, y: 0 });
  const s = build({ entities: ents, wires: [[0, 1, 1, 0], [1, 1, 0, 0]] });
  s.run(0.2);
  return { s, bat: s.get(0), photo: s.get(1) };
}
{
  const { s, bat, photo } = circuitScene(false);
  ok(s.world.wires.length === 2, `回路接通：${s.world.wires.length} 条导线（电池+ 与光敏 A、光敏 B 与电池−）`);
  const emf = bat.props.emf, rint = bat.props.internalR, R = photo.state.rNow;
  const want = emf / (R + rint);
  // ⚠ 只对**幅度**断言：本求解器的 V 支路电流与被动约定反号（electrical.js:672-676 记过、
  //   tools/motor-emf-probe.mjs §4 实测过），D6/W 与 B 的接线次序都反不了它 —— 见下面那条显式约定断言。
  ok(near(Math.abs(photo.state.I), want, 1e-3),
    `暗态电流幅度：MNA ${Math.abs(photo.state.I).toExponential(4)} A ⟷ 解析 ${want.toExponential(4)} A（差 ${pct(Math.abs(photo.state.I), want)}）`);
  ok(photo.state.I < 0,
    `符号符合既有约定：本回路上 R 支路读到 I=${photo.state.I.toExponential(3)} A（负值）⇒ 本探针一律对幅度断言`);
  ok(photo.state.R > 0 && near(photo.state.R, R, 1e-6),
    `求解器写回的 state.R=${photo.state.R.toFixed(1)} Ω 与器材自报 R 一致（同一件器材，两条路径）`);
  ok(typeof photo.state.U === 'number' && typeof photo.state.P === 'number',
    `四键齐全：I/U/P/R 都被求解器写回（U=${photo.state.U.toFixed(4)} V, P=${photo.state.P.toExponential(3)} W）`);
}
{
  const { bat, photo } = circuitScene(true);
  const want = bat.props.emf / (photo.state.rNow + bat.props.internalR);
  ok(near(Math.abs(photo.state.I), want, 1e-3),
    `亮态电流幅度：MNA ${Math.abs(photo.state.I).toExponential(4)} A ⟷ 解析 ${want.toExponential(4)} A（差 ${pct(Math.abs(photo.state.I), want)}）`);
  ok(photo.state.relE === 100 && photo.state.rNow === photo.props.rLight,
    `亮态自报：相对照度 ${photo.state.relE}%、R=${photo.state.rNow} Ω（亮电阻）`);
  const ratio = Math.abs(photo.state.I) / (bat.props.emf / (photo.props.rDark + bat.props.internalR));
  ok(ratio > 100, `亮/暗电流幅度比 = ${ratio.toFixed(0)}× —— 照度确实**在电路里**起效（不只是 state 里好看）`);
}
{
  // 动态：先暗后亮，再掐掉光源 ⇒ 电流跟着回落（证明逐拍取源，不是只算一次）
  const ents = [
    { type: 'battery', x: 0, y: 0 },
    { type: 'photoresistor', x: 100, y: 0 },
    { type: 'lightsource', x: 0, y: 0 },
  ];
  const s = build({ entities: ents, wires: [[0, 1, 1, 0], [1, 1, 0, 0]] });
  s.run(0.1);
  const lit = s.get(1).state.I;
  s.world.remove(s.get(2));
  s.run(0.1);
  const dark = s.get(1).state.I;
  ok(Math.abs(dark) < Math.abs(lit) / 100,
    `掐掉光源后电流幅度立刻回落：${Math.abs(lit).toExponential(3)} A → ${Math.abs(dark).toExponential(3)} A（逐拍取源）`);
}

// ══════════════════════════════════════════════════════════
head('⑥ 发光体判据：热源也有 props.power（单位 W）⇒ 不许按 power 认发光体');
// ══════════════════════════════════════════════════════════
{
  const heater = { id: 'stub-heater', x: 1010, y: 0, props: { lit: true, power: 600 } };  // 单位 W
  ok(E.nearestLuminous({ entities: [heater] }, { x: 1000, y: 0 }) === null,
    '酒精灯/加热器（power=600，无 wavelength）**不算**发光体 ⇒ 不会被当灯照（量纲陷阱）');
  const lamp = { id: 'stub-lamp', x: 1010, y: 0, props: { wavelength: 650, power: 5 } };   // 单位 mW
  ok(E.nearestLuminous({ entities: [lamp] }, { x: 1000, y: 0 }) === lamp,
    '有 wavelength 的发光体才算（结构判据，非类型白名单）');
  const far = { id: 'f1', x: 0, y: 0, props: { wavelength: 650, power: 5 } };
  const near2 = { id: 'f2', x: 1050, y: 0, props: { wavelength: 650, power: 5 } };
  ok(E.nearestLuminous({ entities: [far, near2] }, { x: 1000, y: 0 }) === near2,
    '有多个发光体时取**最近**的那个');
}
{
  // 真器材层面再确认一次：把真热源摆在旁边，光敏电阻照样报"无照度"
  const probe = create('alcohollamp', 1010, 0);
  ok(!!probe, `真酒精灯可创建（type='alcohollamp'）⇒ 下面这条不是空转`);
  const s = build({ entities: [{ type: 'photoresistor', x: 1000, y: 0 }, { type: 'alcohollamp', x: 1010, y: 0, props: { lit: true } }], wires: [] });
  s.run(0.1);
  const p = s.get(0);
  ok(s.world.entities.length === 2 && p.state.relE === 0,
    `旁边是真酒精灯（props.power=${probe ? probe.props.power : '?'}，单位 W）⇒ 相对照度仍是 ${p.state.relE}%（不是被点亮的读数）`);
}

// ══════════════════════════════════════════════════════════
head('⑦ 渲染冒烟：无头 Canvas 替身上画一帧');
// ══════════════════════════════════════════════════════════
{
  const { s } = photoScene(900);
  let errs = [];
  let drawn = 0;
  for (const e of s.world.entities) {
    try { e.render(CTX); drawn++; } catch (err) { errs.push(e.type + ': ' + err.message); }
  }
  ok(errs.length === 0 && drawn >= 2, errs.length ? '渲染抛错：' + errs.join('; ') : `${drawn} 次 render()（光敏电阻 + 发光体）跑通`);
  ok(drawn === s.world.entities.length, `渲染次数 ${drawn} = 场上器材数 ${s.world.entities.length}（不是空循环）`);
}

// ══════════════════════════════════════════════════════════
// 红档：变异体落在 %TEMP%，仓库零字节改动
// ══════════════════════════════════════════════════════════
if (MUTATE) {
  head('⑧ --mutate：把「照度→电阻」掐掉 ⇒ 亮态断言必须红，暗态必须仍绿');
  const srcRaw = readRaw(ELECTRONICS_SRC);
  const srcCode = stripComments(srcRaw);
  const OLD = 'const t = clamp((this.state.relE || 0) / 100, 0, 1);';
  const NEW = 'const t = 0; // MUTANT：忽略照度（等价于永远暗态）';
  ok(srcCode.includes(OLD), '变异锚点在**代码行**上（剥注释后命中）');
  ok(srcRaw.split(OLD).length - 1 === srcCode.split(OLD).length - 1,
    `锚点不在注释里：原始 ${srcRaw.split(OLD).length - 1} 次 ⟷ 剥注释 ${srcCode.split(OLD).length - 1} 次`);
  const mutated = srcRaw.replace(OLD, NEW);
  ok(mutated !== srcRaw && stripComments(mutated).includes(NEW), '替换确实落到了文本上');
  const mCode = stripComments(mutated);
  ok(!mCode.includes(OLD) && mCode.split(NEW).length - 1 === 1,
    '桩落在**代码行**上：变异体剥注释后旧行 0 处、新行 1 处');
  // 变异体的相对 import 改写成绝对 file:// —— 否则 %TEMP% 里 import 不到仓库
  const abs = (p) => new URL(p, REPO).href;
  const fixed = mutated
    .replace("'../core/entity.js'", `'${abs('src/core/entity.js')}'`)
    .replace("'./registry.js'", `'${abs('src/equipment/registry.js')}'`)
    .replace("'../core/bus.js'", `'${abs('src/core/bus.js')}'`);
  const variantPath = fileURLToPath(new URL('xm-photo-mutant.mjs', `file:///${process.env.TEMP.replace(/\\/g, '/')}/`));
  writeFileSync(variantPath, fixed, 'utf8');
  info('变异体 → ' + variantPath);
  const mod = await import(new URL('file:///' + variantPath.replace(/\\/g, '/')).href);
  boot(mod.default);

  const expected = [];   // 期望变红的断言
  const ctrl = [];       // 期望仍然绿的对照断言
  {
    const { photo } = photoScene(900);   // E=100 但变异体忽略照度
    ok(photo.state.relE === 100, `[桩已生效] 照度仍在报 ${photo.state.relE}%`);
    ok(photo.state.rNow === photo.props.rDark,
      `[桩已生效] R 变成暗电阻 ${photo.state.rNow} Ω（真身此时应为亮电阻 ${photo.props.rLight} Ω）`);
    expected.push(['亮态 R = 亮电阻', photo.state.rNow === photo.props.rLight]);
    ctrl.push(['无照度 R = 暗电阻', photoScene(null).photo.state.rNow === photo.props.rDark]);
  }
  {
    const { bat, photo } = circuitScene(true);
    const want = bat.props.emf / (photo.state.rNow + bat.props.internalR);
    expected.push(['亮态电流幅度 = 解析值', near(Math.abs(photo.state.I), want, 1e-3) && Math.abs(photo.state.I) > 1e-3]);
    ctrl.push(['暗态电流幅度 = 解析值', (() => {
      const d = circuitScene(false).photo;
      return near(Math.abs(d.state.I), bat.props.emf / (d.state.rNow + bat.props.internalR), 1e-3);
    })()]);
  }
  const observedRed = expected.filter(([, v]) => !v).length;
  const ctrlBad = ctrl.filter(([, v]) => !v).length;
  console.log('');
  for (const [m, v] of expected) console.log(`    ${v ? '\x1b[31m✗\x1b[0m 未红' : '\x1b[32m✓\x1b[0m 已红'} ${m}`);
  for (const [m, v] of ctrl) console.log(`    ${v ? '\x1b[32m✓\x1b[0m 仍绿' : '\x1b[31m✗\x1b[0m 误红'} ${m}`);
  ok(observedRed === expected.length && expected.length > 0,
    `期望变红 ${expected.length} 条，实测变红 ${observedRed} 条`);
  ok(ctrlBad === 0, `对照组（不改的那一侧）误红 ${ctrlBad} 条`);
  console.log('\n\x1b[1mPHOTORESISTOR_MUTATE_JSON\x1b[0m ' + JSON.stringify({
    expectedRed: expected.length, observedRed, ctrlBad,
    stubLanded: true, landInCode: true,
    ok: observedRed === expected.length && expected.length > 0 && ctrlBad === 0,
  }));
}

console.log(`\n\x1b[1m全部通过：${pass} 项\x1b[0m` + (fail ? `  \x1b[31m失败 ${fail} 项\x1b[0m` : ''));
console.log('PHOTORESISTOR_JSON ' + JSON.stringify({ items: pass, fail, mutate: MUTATE }));
process.exit(fail ? 1 : 0);
