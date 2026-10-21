#!/usr/bin/env node
// ══════════════════════════════════════════════════════════
// tools/inert-electrode-probe.mjs —— task-43 判据（惰性电极：铂）
//
// 被测面（三处出口，同一条口径）都在唯一被测文件 src/equipment/lab.js：
//   ① 器件定义 electrode.fields.options   ② 判据量 electrode.probe.E0   ③ 面板读数 electrode.stats
//
// 「惰性」在本仓的**全部含义**就是 E0 = null：src/chemistry/vessel.js 的 polarityOf 用它把
// 电极分成「带 E0 的金属」与「不带 E0 的惰性端」，coupling/bridge.js 造 cell: 支路的三个条件
// 同样以它为输入。所以本探针不断言「铂应该是什么电位」，只断言两条可证的事：
//   A. 铂的读数与石墨**逐字相同**（同类）；B. 与活性金属 Cu/Zn **不相同**（读数活着，不是恒等）。
//
// 判据：① 接口 ② 同类 ③ 电解池产物 ④ 不参与反应 ⑤ 既有材料读数回归
// 红档：变异体必须真落进代码（landInCode）+ 红集双向对齐 + 金丝雀必红 + NULL 对造必 0 红
//       + 连跑两次逐字节相同（measured 映射比对，无时间戳字段）。
//
// 用法：node tools/inert-electrode-probe.mjs [--mutate]
// 绿档一行紧凑 JSON：INERT_ELECTRODE_JSON {"mode":"green",...}（冒号后无空格）
// 退出码既不是成功的判据也不是失败的判据 —— 看 JSON。
// ══════════════════════════════════════════════════════════
import { readFileSync, writeFileSync, mkdirSync, cpSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const HERE = dirname(SELF);
const ROOT = resolve(HERE, '..');
const MUTATE = process.argv.includes('--mutate');
const RUN_ONE = (process.argv.find((a) => a.startsWith('--run-one=')) || '').slice(10);
const ROOT_ARG = (process.argv.find((a) => a.startsWith('--root=')) || '').slice(7);
const TMP = resolve(process.env.TEMP || process.env.TMP || join(process.cwd(), '_scratch'), 'xm-inert');
const TOUCHED = 'src/equipment/lab.js';
const DT = 1 / 120;
const EMF = 6, RI = 0.05, R_SERIES = 100;

const norm = (s) => String(s).replace(/\r\n/g, '\n');
const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const codeOf = (root, rel) => norm(readFileSync(join(root, rel), 'utf8'));

async function loadTarget(root) {
  const u = (rel) => pathToFileURL(join(root, rel)).href;
  const { World } = await import(u('src/core/world.js'));
  const { PluginHost } = await import(u('src/core/plugin.js'));
  const registry = await import(u('src/equipment/registry.js'));
  const { CouplingBus } = await import(u('src/coupling/bridge.js'));
  const { solveCircuit } = await import(u('src/physics/circuit.js'));
  const { SP } = await import(u('src/chemistry/species.js'));
  const plugins = [
    (await import(u('src/physics/circuit.js'))).default,
    (await import(u('src/chemistry/reactions.js'))).default,
    (await import(u('src/coupling/bridge.js'))).default,
    (await import(u('src/equipment/electrical.js'))).default,
    (await import(u('src/equipment/glassware.js'))).default,
    (await import(u('src/equipment/lab.js'))).default,
  ];
  const bootApp = {
    services: {}, ticks: [], world: null, lastCircuit: null, selected: null,
    log: { push() {}, clear() {} }, toast() {},
    addTick(fn) { this.ticks.push(fn); return () => {}; },
  };
  const host = new PluginHost(bootApp);
  for (const p of plugins) host.define(p);
  host.installAll();
  registry.bindRegistry(host.registry('equipment'));
  return { World, CouplingBus, solveCircuit, SP, create: registry.create, reg: host.registry('equipment') };
}

function mkSim(T, sc) {
  const world = new T.World();
  const cb = new T.CouplingBus(world);
  const raw = world.step.bind(world);
  const ents = [];
  for (const o of sc.entities || []) {
    const ent = T.create(o.type, o.x, o.y);
    if (!ent) throw new Error('无法创建器材: ' + o.type);
    if (o.props) for (const k of Object.keys(o.props)) ent.setProp(k, o.props[k]);
    if (o.fill && ent.vessel) {
      const v = ent.vessel;
      for (const pair of (o.fill.liquid || [])) v.addLiquid(pair[0], pair[1]);
      for (const pair of (o.fill.solid || [])) v.addSolid(pair[0], pair[1]);
      v.updateColor();
    }
    world.add(ent, true);
    ents.push(ent);
  }
  const tick = (dt, extra) => {
    const br = cb.buildBranches();
    const c = T.solveCircuit(world, extra ? br.concat(extra) : br);
    cb.distribute(dt, c);
    raw(dt);
    return c;
  };
  const link = (a, ap, b, bp) => world.connect({ e: a.id, p: ap }, { e: b.id, p: bp }, 'wire');
  return { world, cb, ents, tick, link, get: (i) => ents[i] };
}

/** 电解池：两根同种电极（ΔE0 = 0 ⇒ 必走 sol: 溶液支路）+ 6 V 电源 + 100 Ω 限流 */
function elyFixture(T, metal, liquid) {
  const sc = { entities: [
    { type: 'battery', x: 100, y: 100, props: { emf: EMF, internalR: RI } },
    { type: 'beaker', x: 400, y: 300, fill: { liquid: liquid } },
    { type: 'electrode', x: 394, y: 300, props: { metal: metal } },
    { type: 'electrode', x: 406, y: 300, props: { metal: metal } },
    { type: 'resistor', x: 250, y: 220, props: { resistance: R_SERIES } },
  ] };
  const sim = mkSim(T, sc);
  const bat = sim.get(0), beaker = sim.get(1), eA = sim.get(2), eB = sim.get(3), rs = sim.get(4);
  sim.link(bat, 0, rs, 0); sim.link(rs, 1, eA, 0); sim.link(eB, 0, bat, 1);
  const ref = { key: 'inert-ref', a: { e: eA.id, p: 0 }, b: { e: eB.id, p: 0 }, type: 'open', state: {} };
  const c = sim.tick(DT, [ref]);
  return { sim, bat, beaker, eA, eB, v: beaker.vessel, c };
}

/** 原电池位（不接电源）：两根电极 + 可选的第三根（量「被挤出电路」那一档） */
function galvFixture(T, m1, m2, m3) {
  const ents = [
    { type: 'beaker', x: 400, y: 300, fill: { liquid: [['CuSO4', 50], ['H2O', 50]] } },
    { type: 'electrode', x: 392, y: 300, props: { metal: m1 } },
    { type: 'electrode', x: 400, y: 300, props: { metal: m2 } },
  ];
  if (m3) ents.push({ type: 'electrode', x: 408, y: 300, props: { metal: m3 } });
  const sim = mkSim(T, { entities: ents });
  const beaker = sim.get(0), e1 = sim.get(1), e2 = sim.get(2), e3 = m3 ? sim.get(3) : null;
  const ref = { key: 'inert-ref2', a: { e: e1.id, p: 0 }, b: { e: e2.id, p: 0 }, type: 'open', state: {} };
  sim.tick(DT, [ref]);
  return { sim, beaker, e1, e2, e3, v: beaker.vessel };
}

/** 产物快照：按**物种表**逐条查 amount（不靠字符串猜），> 0 才记，键排序 ⇒ 逐字节可比 */
function snap(T, v) {
  const out = {};
  for (const id of Object.keys(T.SP).sort()) {
    let a = null;
    try { a = v.amount(id); } catch (e) { a = null; }
    if (typeof a === 'number' && a > 1e-9) out[id] = Number(a.toFixed(6));
  }
  return out;
}

function runSuite(T) {
  const rows = [];
  const add = (sec, id, cond, got, kind) => rows.push({ sec, id, kind: kind || '断言', met: !!cond, red: (kind || '断言') === '断言' && !cond, got });
  const INERT = { 材料: '铂（惰性）', 电势: '不参与原电池' };
  const GRAPHITE = { 材料: '石墨（惰性）', 电势: '不参与原电池' };
  const rowOf = (m) => { const e = T.create('electrode', 0, 0); e.setProp('metal', m); return { E0: e.probe.E0, 形状: JSON.stringify({ ...e.probe, metal: 'X' }), 材料: T.reg.get('electrode').stats[0].read(e), 电势: T.reg.get('electrode').stats[1].read(e) }; };
  const vals = T.reg.get('electrode').fields[0].options.map((o) => o[0]);
  const pt = rowOf('Pt'), gr = rowOf('graphite');

  // ① 接口
  add('①接口', 'pt-在选项里', vals.includes('Pt'), { 选项: vals });
  add('①接口', 'pt-E0-为-null', pt.E0 === null, { E0: pt.E0 });
  add('①接口', 'pt-两行读数字面量', pt.材料 === INERT.材料 && pt.电势 === INERT.电势, pt);

  // ② 同类：铂 ≡ 石墨，且与活性金属不同
  add('②同类', 'pt-与石墨-probe-形状逐字同', pt.形状 === gr.形状, { pt: pt.形状, gr: gr.形状 });
  add('②同类', 'pt-与石墨-电势行逐字同', pt.电势 === gr.电势, { pt: pt.电势, gr: gr.电势 });
  const ely = (m) => { const f = elyFixture(T, m, [['CuCl2', 50], ['H2O', 50]]); return { f, pol: JSON.stringify([f.v.polarityOf(f.eA.id), f.v.polarityOf(f.eB.id)]) }; };
  const elyPt = ely('Pt'), elyGr = ely('graphite');
  add('②同类', 'pt-与石墨-电解池极性读数逐字同', elyPt.pol === elyGr.pol, { pt: elyPt.pol, gr: elyGr.pol });
  const galv = (m3) => { const f = galvFixture(T, 'Cu', 'Zn', m3); return { f, pol: JSON.stringify([f.v.polarityOf(f.e1.id), f.v.polarityOf(f.e2.id), f.e3 ? f.v.polarityOf(f.e3.id) : 'n/a']) }; };
  const gPt = galv('Pt'), gGr = galv('graphite'), gNo = galv(null);
  add('②同类', 'pt-与石墨-三电极挤出档读数逐字同', gPt.pol === gGr.pol, { pt: gPt.pol, gr: gGr.pol });
  add('②同类', '三电极的第三根确实被挤出（与两电极读数不同）', gNo.pol !== gPt.pol, { 两电极: gNo.pol, 三根: gPt.pol });
  const cu = rowOf('Cu');
  add('②同类', '反证-活性金属-Cu-读数与惰性不同', cu.E0 === 0.34 && cu.电势 !== pt.电势, cu);

  // ③ 电解池产物
  const drive = (f) => { for (let i = 0; i < 240; i++) f.sim.tick(DT); };
  drive(elyPt.f); drive(elyGr.f);
  const sPt = snap(T, elyPt.f.v), sGr = snap(T, elyGr.f.v);
  add('③电解', '[刻划]pt-与石墨-同溶液产物快照逐字同', JSON.stringify(sPt) === JSON.stringify(sGr), { pt: sPt, gr: sGr }, '刻划');
  add('③电解', '电流真的流过（|I| > 阈值）', Math.abs(Number(elyPt.f.v.electricCurrent) || 0) > 0.004, { I: elyPt.f.v.electricCurrent });
  const other = elyFixture(T, 'Pt', [['Na2SO4', 50], ['H2O', 50]]); drive(other);
  const sOther = snap(T, other.v);
  add('③电解', '[刻划]产物真的在变（换溶液 ⇒ 快照必须不同）', JSON.stringify(sOther) !== JSON.stringify(sPt), { CuCl2: sPt, Na2SO4: sOther }, '刻划');
  add('③电解', 'CuCl2 真被电解（铜析出且氯气出现）', (sPt.Cu || 0) > 0 && (sPt.Cl2 || 0) > 0, sPt);

  // ④ 不参与反应
  add('④不参与反应', '跑完电极材料未变（铂没被消耗）', elyPt.f.eA.props.metal === 'Pt' && elyPt.f.eB.props.metal === 'Pt', { eA: elyPt.f.eA.props.metal, eB: elyPt.f.eB.props.metal });
  add('④不参与反应', '容器里不出现铂物种', !Object.keys(sPt).some((k) => k.indexOf('Pt') === 0), { 物种: Object.keys(sPt) });

  // ⑤ 回归：既有材料读数逐字未改
  const LEGACY = { graphite: GRAPHITE, Cu: { 材料: 'Cu', 电势: '+0.34 V' }, Zn: { 材料: 'Zn', 电势: '-0.76 V' }, Fe: { 材料: 'Fe', 电势: '-0.44 V' }, Al: { 材料: 'Al', 电势: '-1.66 V' }, Mg: { 材料: 'Mg', 电势: '-2.37 V' }, Ag: { 材料: 'Ag', 电势: '+0.80 V' } };
  for (const m of Object.keys(LEGACY)) {
    const r = rowOf(m);
    add('⑤回归', '既有材料读数未改-' + m, r.材料 === LEGACY[m].材料 && r.电势 === LEGACY[m].电势, { 实测: r, 期望: LEGACY[m] });
  }
  const missing = Object.keys(LEGACY).filter((m) => !vals.includes(m));
  add('⑤回归', '既有材料一个都没丢', missing.length === 0, { 缺失: missing });
  return rows;
}

// ══════════════════════════════════════════════════════════
// 变异体（全部落在唯一被测文件 src/equipment/lab.js）
// ══════════════════════════════════════════════════════════
const MUTANTS = [
  { id: 'M0-canary-铂未加入选项', canary: true,
    find: "['graphite', INERT_LABEL.graphite], ['Pt', INERT_LABEL.Pt], ['Zn', '锌片'],",
    to: "['graphite', INERT_LABEL.graphite], ['Zn', '锌片']," },
  { id: 'M1-铂被当成活性电极(E0=1.18)',
    find: 'const e0 = INERT_METALS.has(m) ? null : (SP[m] ? SP[m].E0 : null);',
    to: "const e0 = (m === 'graphite') ? null : ((m === 'Pt') ? 1.18 : (SP[m] ? SP[m].E0 : null));" },
  { id: 'M2-面板对铂显示原文',
    find: "{ label: '电极材料', read: (e) => INERT_LABEL[e.props.metal] || e.props.metal },",
    to: "{ label: '电极材料', read: (e) => (e.props.metal === 'graphite' ? INERT_LABEL.graphite : e.props.metal) }," },
  { id: 'M3-石墨材料字面量漂移',
    find: "const INERT_LABEL = { graphite: '石墨（惰性）', Pt: '铂（惰性）' };",
    to: "const INERT_LABEL = { graphite: '石墨（惰性）x', Pt: '铂（惰性）' };" },
  { id: 'M4-电势读数精度漂移',
    find: "return (p.E0 > 0 ? '+' : '') + p.E0.toFixed(2) + ' V';",
    to: "return (p.E0 > 0 ? '+' : '') + p.E0.toFixed(1) + ' V';" },
  { id: 'M5-电极不再自报为电极(probe.kind 漂移)',
    find: "    this.probe = { kind: 'electrode', metal: m, E0: e0 };",
    to: "    this.probe = { kind: 'rod', metal: m, E0: e0 };" },
  { id: 'NULL-语义零改动(键序)', null: true,
    find: "  graphite: '#454b52', Zn: '#b8c0c6', Cu: '#b87333', Fe: '#8e9296',",
    to: "  graphite: '#454b52', Cu: '#b87333', Zn: '#b8c0c6', Fe: '#8e9296'," },
];

// 期望红集：与实测**双向对齐**（多一个红、少一个红都判 redsAligned=false）。改动判定面后必须回来同步。
const EXPECT = {
  "M0-canary-铂未加入选项": [
    "pt-在选项里"
  ],
  "M1-铂被当成活性电极(E0=1.18)": [
    "pt-E0-为-null",
    "pt-两行读数字面量",
    "pt-与石墨-probe-形状逐字同",
    "pt-与石墨-电势行逐字同",
    "pt-与石墨-三电极挤出档读数逐字同"
  ],
  "M2-面板对铂显示原文": [
    "pt-两行读数字面量"
  ],
  "M3-石墨材料字面量漂移": [
    "既有材料读数未改-graphite"
  ],
  "M4-电势读数精度漂移": [
    "既有材料读数未改-Cu",
    "既有材料读数未改-Zn",
    "既有材料读数未改-Fe",
    "既有材料读数未改-Al",
    "既有材料读数未改-Mg",
    "既有材料读数未改-Ag"
  ],
  "NULL-语义零改动(键序)": [],
  "M5-电极不再自报为电极(probe.kind 漂移)": [
    "电流真的流过（|I| > 阈值）",
    "CuCl2 真被电解（铜析出且氯气出现）"
  ]
};

function landInCode(root, mu) {
  const before = codeOf(root, TOUCHED);
  const hits = before.split(mu.find).length - 1;
  const dir = join(TMP, 'm-' + sha256(mu.id).slice(0, 8));
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  cpSync(join(root, 'src'), join(dir, 'src'), { recursive: true });
  cpSync(join(root, 'package.json'), join(dir, 'package.json'));
  writeFileSync(join(dir, TOUCHED), before.split(mu.find).join(mu.to), 'utf8');
  const after = codeOf(dir, TOUCHED);
  return { hits, dir, landed: hits === 1 && after !== before, bytes: after.length - before.length };
}

if (RUN_ONE) {
  let payload;
  try {
    payload = { mode: 'one', runOne: RUN_ONE, rows: runSuite(await loadTarget(ROOT_ARG)) };
  } catch (e) {
    payload = { mode: 'one', runOne: RUN_ONE, threw: String((e && e.message) || e), rows: [] };
  }
  const redIds = payload.rows.filter((r) => r.red).map((r) => r.id);
  const charNotMet = payload.rows.filter((r) => r.kind === '刻划' && !r.met).map((r) => r.id);
  process.stdout.write('INERT_ELECTRODE_JSON ' + JSON.stringify({ mode: 'one', runOne: RUN_ONE, threw: payload.threw || null, redCount: redIds.length, redIds: redIds, charNotMet: charNotMet }) + '\n');
} else if (MUTATE) {
  const out = { mode: 'mutate', mutants: [], redsAligned: true, canaryRed: false, nullRed: null, infra: null, deterministic: null };
  const measured = {};
  for (const mu of MUTANTS) {
    const L = landInCode(ROOT, mu);
    if (!L.landed) { out.infra = '变异体未落进代码: ' + mu.id + ' hits=' + L.hits; break; }
    let txt = '';
    try { txt = execFileSync(process.execPath, [SELF, '--run-one=' + mu.id, '--root=' + L.dir], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); }
    catch (e) { txt = String((e && e.stdout) || ''); }
    const line = txt.split('\n').find((l) => l.indexOf('INERT_ELECTRODE_JSON ') === 0);
    if (!line) { out.infra = '子进程无 JSON: ' + mu.id; break; }
    const j = JSON.parse(line.slice(20));
    const reds = j.threw ? ['threw:' + j.threw] : j.redIds;
    measured[mu.id] = reds;
    const want = EXPECT[mu.id] || [];
    const aligned = want.length === reds.length && want.every((x) => reds.indexOf(x) >= 0);
    out.mutants.push({ id: mu.id, hits: L.hits, bytes: L.bytes, redCount: reds.length, aligned: aligned, redIds: reds, declared: want });
    if (!aligned) out.redsAligned = false;
    if (mu.canary) out.canaryRed = reds.length > 0;
    if (mu.null) out.nullRed = reds.length;
  }
  if (out.nullRed !== 0) out.redsAligned = false;
  if (!out.canaryRed) out.redsAligned = false;
  mkdirSync(TMP, { recursive: true });
  const prevPath = join(TMP, 'measured.json');
  let prev = null;
  try { prev = readFileSync(prevPath, 'utf8').toString(); } catch (e) { prev = null; }
  out.deterministic = (prev === null) ? null : (prev === JSON.stringify(measured));
  writeFileSync(prevPath, JSON.stringify(measured), 'utf8');
  console.log('INERT_ELECTRODE_JSON ' + JSON.stringify(out));
} else {
  const rows = runSuite(await loadTarget(ROOT));
  const asrt = rows.filter((r) => r.kind === '断言');
  const char = rows.filter((r) => r.kind === '刻划');
  const red = asrt.filter((r) => r.red);
  const secAll = [...new Set(rows.map((r) => r.sec))];
  console.log('INERT_ELECTRODE_JSON ' + JSON.stringify({ mode: 'green', assertions: asrt.length, pass: asrt.length - red.length, fail: red.length, characterization: char.map((r) => r.id), charCount: char.length, charNotMet: char.filter((r) => !r.met).map((r) => r.id), items: rows.length, sectionsDone: secAll.length, sections: secAll, redIds: red.map((r) => r.id), reds: red.map((r) => ({ id: r.id, got: r.got })), labSha: sha256(readFileSync(join(ROOT, TOUCHED))).slice(0, 12) }));
}
