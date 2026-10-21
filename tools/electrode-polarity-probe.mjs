#!/usr/bin/env node
// ══════════════════════════════════════════════════════════
// tools/electrode-polarity-probe.mjs —— task-32 判据（电极极性契约 vessel.polarityOf）
//
// 依据：plans/20-NB电化学专题 §3.1 逐件对照表 与 §五 缺口清单 P0。
// 接口（已冻结）：vessel.polarityOf(entId) -> 'cathode' | 'anode' | null
//   化学域只说**阴/阳极**（cathode 阴极 / anode 阳极）；正/负极是物理域口径，不在本契约里。
//
// 判据（先立后破）：
//   ① 电解池：两根电极一阴一阳，且与电源正负极的接法对应正确（判据源 = 当帧真实求解结果）
//   ② 原电池：不接电源（两种不同金属同杯）时一阴一阳，且与 coupling/bridge.js 的 emf = ΔE0 结论一致
//   ③ 同一杯、同一对电极：先电解再把电极改成 Cu/Zn 变原电池 ⇒ 此时 currentU 是**陈旧值**，
//      正确实现必须按 ΔE0 给答案；「偷读陈旧 currentU」的实现关系相反 ⇒ ③ 必红（行为型变异体）
//   ④ null 语义：陈旧值存在但条件不满足 ⇒ null；未接入 / 无电流 / 非电极 / id 不存在 ⇒ null 且不抛错
//   ⑤ 零副作用：连续两次调用结果相同、且不改 vessel 状态（幂等）
//
// 用法：node tools/electrode-polarity-probe.mjs [--mutate]
// 绿档打一行紧凑 JSON：ELECTRODE_POLARITY_JSON {"mode":"green","items":N,...}（冒号后无空格）
// ══════════════════════════════════════════════════════════
import { readFileSync, existsSync, mkdirSync, cpSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// ⚠ 沙箱里裸 os.tmpdir() 会给相对路径（undefined\temp）⇒ 一律 path.resolve 钉成绝对路径
const TMP = resolve(process.env.TEMP || process.env.TMP || join(process.cwd(), '_scratch'), 'xm-polarity');
const MUTATE = process.argv.includes('--mutate');
const TOUCHED = ['src/chemistry/vessel.js'];
const DT = 1 / 120;
const EMF = 6, RI = 0.05, R_SERIES = 100;

const norm = (s) => String(s).replace(/\r\n/g, '\n');
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const codeOf = (root, rel) => norm(readFileSync(join(root, rel), 'utf8'));

/** 全部走**绝对 file:/// 动态导入**：变异镜像（%TEMP% 里的另一份 src）才能各自独立加载 */
async function loadTarget(root) {
  const u = (rel) => pathToFileURL(join(root, rel)).href;
  const { World } = await import(u('src/core/world.js'));
  const { PluginHost } = await import(u('src/core/plugin.js'));
  const registry = await import(u('src/equipment/registry.js'));
  const { CouplingBus } = await import(u('src/coupling/bridge.js'));
  const { solveCircuit } = await import(u('src/physics/circuit.js'));
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
  for (const p of plugins) if (p) host.define(p);
  host.installAll();
  registry.bindRegistry(host.registry('equipment'));
  return { root, World, CouplingBus, solveCircuit, create: registry.create };
}

/** 场景装配：造器材 → connect 接线 → 每 tick = 造支路 → 解电路 → 分发耦合量 → 世界步进 */
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

/** ① 电解池：两根**同种**电极（ΔE0=0 ⇒ 一定走 sol: 溶液支路）+ 6 V 电源 + 100 Ω 限流 */
function electrolysisFixture(T, opts) {
  const o = opts || {};
  const sc = { entities: [
    { type: 'battery', x: 100, y: 100, props: { emf: EMF, internalR: RI } },
    { type: 'beaker', x: 400, y: 300, fill: { liquid: [['CuSO4', 50], ['H2O', 50]] } },
    { type: 'electrode', x: 394, y: 300, props: { metal: o.metal || 'Cu' } },
    { type: 'electrode', x: 406, y: 300, props: { metal: o.metal || 'Cu' } },
    { type: 'resistor', x: 250, y: 220, props: { resistance: R_SERIES } },
  ] };
  const sim = mkSim(T, sc);
  const bat = sim.get(0), beaker = sim.get(1), eA = sim.get(2), eB = sim.get(3), rs = sim.get(4);
  if (o.flip) { sim.link(bat, 0, rs, 0); sim.link(rs, 1, eB, 0); sim.link(eA, 0, bat, 1); }
  else { sim.link(bat, 0, rs, 0); sim.link(rs, 1, eA, 0); sim.link(eB, 0, bat, 1); }
  // 独立参照支路：open 不参与盖章，只在 state.U 上给 V(eA) − V(eB)（第二条读数路径）
  const ref = { key: 'pol-ref', a: { e: eA.id, p: 0 }, b: { e: eB.id, p: 0 }, type: 'open', state: {} };
  const c = sim.tick(DT, [ref]);
  return {
    sim, bat, beaker, eA, eB, rs, ref, c, v: beaker.vessel,
    rec: c.branches.get('sol:' + beaker.id), recBat: c.branches.get(bat.id),
    galv: sim.cb.branches.find((b) => b.tag === 'galvanic') || null,
  };
}

/** ② 原电池：不接电源，Cu + Zn 同杯（ΔE0 > 0.05 且 ionConc > 0.05 ⇒ bridge 一定造 cell: 支路） */
function galvanicFixture(T) {
  const sc = { entities: [
    { type: 'beaker', x: 400, y: 300, fill: { liquid: [['CuSO4', 50], ['H2O', 50]] } },
    { type: 'electrode', x: 394, y: 300, props: { metal: 'Cu' } },
    { type: 'electrode', x: 406, y: 300, props: { metal: 'Zn' } },
  ] };
  const sim = mkSim(T, sc);
  const beaker = sim.get(0), eCu = sim.get(1), eZn = sim.get(2);
  const ref = { key: 'pol-ref2', a: { e: eCu.id, p: 0 }, b: { e: eZn.id, p: 0 }, type: 'open', state: {} };
  const c = sim.tick(DT, [ref]);
  const br = sim.cb.branches.find((b) => b.tag === 'galvanic') || null;
  return { sim, beaker, eCu, eZn, ref, c, br, v: beaker.vessel, rec: br ? c.branches.get(br.key) : null };
}

// ══════════════════════════════════════════════════════════
async function runSuite(T, opt) {
  const verbose = !opt || opt.verbose !== false;
  const S = { pass: 0, fail: 0, failed: [], failSec: [], secTotal: {}, notes: [] };
  let cur = '?';
  const ok = (cond, msg) => {
    S.secTotal[cur] = (S.secTotal[cur] || 0) + 1;
    if (cond) { S.pass++; if (verbose) console.log('  \x1b[32m✓\x1b[0m ' + msg); }
    else { S.fail++; S.failed.push('[' + cur + '] ' + msg); S.failSec.push(cur); if (verbose) console.log('  \x1b[31m✗\x1b[0m ' + msg); }
  };
  const head = (t) => { cur = t.trim().charAt(0); if (verbose) console.log('\n\x1b[36m' + t + '\x1b[0m'); };
  const info = (t) => { S.notes.push(t); if (verbose) console.log('    · ' + t); };
  const J = (x) => JSON.stringify(x);

  // ── ① 电解池 ──────────────────────────────────────────────
  head('① 电解池：一阴一阳，且与电源接法对应正确（判据源 = 当帧求解结果）');
  {
    const f = electrolysisFixture(T);
    info('容器 ionConc = ' + f.v.ionConc().toFixed(6) + ' mol/L，溶液电阻 R = ' + f.v.resistance().toFixed(3) + ' Ω');
    ok(f.galv === null, '两根**同种**电极（ΔE0 = 0）⇒ 没有 cell: 支路（原电池不成立）');
    ok(!!f.rec, '溶液支路存在（key = sol:<容器id>）⇒ 本帧走电解池口径');
    ok(!!f.recBat && f.recBat.U > 0,
      '电源 rec.U = ' + (f.recBat && f.recBat.U) + ' V > 0 ⇒ 求解器侧端口 0 是电位更高的一端（正端）');
    ok(!!f.rec && f.rec.U > 0,
      '溶液支路 rec.U = ' + (f.rec && f.rec.U) + ' V > 0 ⇒ 电极[0] 电位高于 电极[1]');
    ok(!!f.rec && f.v.currentU === f.rec.U && f.v.currentSigned === f.rec.I,
      '容器上的带符号量就是本帧支路结果（currentU ← rec.U、currentSigned ← rec.I）');
    ok(!!f.rec && f.ref.state.U === f.rec.U,
      '独立参照支路（open，不参与盖章）实测 V(电极[0]) − V(电极[1]) = ' + f.ref.state.U
      + ' V，与支路记录逐位相同 ⇒ 第二条读数路径');
    const pa = f.v.polarityOf(f.eA.id), pb = f.v.polarityOf(f.eB.id);
    ok(pa === 'anode', '接正端、电位更高的电极[0] ⇒ anode（实测 ' + J(pa) + '）');
    ok(pb === 'cathode', '接电源另一端、电位更低的电极[1] ⇒ cathode（实测 ' + J(pb) + '）');
    ok(pa && pb && pa !== pb, '电解池里两根电极一阴一阳');

    const g = electrolysisFixture(T, { flip: true });
    const ga = g.v.polarityOf(g.eA.id), gb = g.v.polarityOf(g.eB.id);
    ok(g.rec && g.rec.U < 0, '把两根电极的接线**对调**（材料与位置逐字不变）⇒ rec.U = ' + (g.rec && g.rec.U) + ' V < 0');
    ok(ga === 'cathode' && gb === 'anode',
      '同一对电极、只换接法 ⇒ 极性随之翻转（电极[0] 由 anode 变 ' + J(ga) + '）⇒ 判据挂在接法/求解结果上，不是材料名');
  }

  // ── ② 原电池 ──────────────────────────────────────────────
  head('② 原电池：不接电源时一阴一阳，且与 bridge 的 emf = ΔE0 结论一致');
  {
    const f = galvanicFixture(T);
    const dE0 = f.eCu.probe.E0 - f.eZn.probe.E0;
    ok(!!f.br, '两种不同金属同杯 ⇒ coupling/bridge.js 造出 cell: 支路（原电池）');
    ok(!!f.br && Math.abs(f.br.emf - dE0) < 1e-12,
      '支路 emf = ' + (f.br && f.br.emf) + ' V = ΔE0 = E0(Cu) − E0(Zn) = ' + dE0
      + ' V ⇒ 与 bridge 的结论同源（读数，不是写死的表）');
    ok(!!f.br && f.br.metals[0] === 'Cu', 'bridge 自报高电位端 = ' + (f.br && f.br.metals[0]) + '（E0 高的那根）');
    ok(!!f.rec && f.rec.U > 0, '原电池 rec.U = ' + (f.rec && f.rec.U) + ' V > 0 ⇒ 高电位端 = Cu');
    ok(f.v.polarityOf(f.eCu.id) === 'cathode', 'Cu（E0 高 = 正极）⇒ cathode（阴极 = 还原极）');
    ok(f.v.polarityOf(f.eZn.id) === 'anode', 'Zn（E0 低 = 负极）⇒ anode（阳极 = 氧化极）');
    ok(f.v.currentU === 0 && f.v.currentSigned === 0,
      '原电池那一帧 currentU / currentSigned 都没被写入（实测 ' + f.v.currentU + ' / ' + f.v.currentSigned
      + '）⇒ 本契约的答案不是从这里来的');
    ok(!!f.rec && f.ref.state.U === f.rec.U,
      '独立参照支路（open）实测 V(Cu) − V(Zn) = ' + f.ref.state.U + ' V，与支路记录逐位相同');
  }


  // ── ③ 关系相反（同一杯、同一对电极实体；陈旧值陷阱）────────
  head('③ 同一杯同一对电极：先电解、再变原电池 ⇒ 关系相反，且陈旧 currentU 不得被偷读');
  {
    const f = electrolysisFixture(T);
    const v = f.v;
    const uFresh = v.currentU, iFresh = v.currentSigned;
    const e0A = f.eA.probe.E0, e0B = f.eB.probe.E0;   // ① 那一帧的两根电极材料（都是 Cu，E0 相同）
    ok(uFresh > 1e-6 && iFresh > 1e-6,
      '第一帧（两根 Cu 电极 + 6 V 电源）溶液支路给出 currentU = ' + uFresh + ' V、currentSigned = ' + iFresh + ' A');
    const aBefore = v.polarityOf(f.eA.id);
    ok(aBefore === 'anode', '第一帧该电极（电极[0]、接电源正端、电位更高）⇒ anode（实测 ' + J(aBefore) + '）');

    // 同两根电极实体、同一杯：材料改成 Cu / Zn ⇒ bridge 改走 cell: 支路，溶液支路消失
    f.eA.setProp('metal', 'Cu'); f.eB.setProp('metal', 'Zn');
    const c2 = f.sim.tick(DT, [f.ref]);
    const galv2 = f.sim.cb.branches.find((b) => b.tag === 'galvanic') || null;
    const sol2 = c2.branches.get('sol:' + f.beaker.id);
    ok(!!galv2 && !sol2, '改成 Cu/Zn 后：cell: 支路出现、sol: 支路消失（原电池口径接管）');
    ok(v.currentU === uFresh && v.currentSigned === iFresh,
      '此时 currentU/currentSigned 与上一帧**逐位相同**（' + v.currentU + ' / ' + v.currentSigned
      + '）⇒ 货真价实的陈旧值（bridge.distribute() 只清 electricCurrent，不清这两个）');
    ok(v.electricCurrent === 0,
      '同一帧 electricCurrent 已被清零（' + v.electricCurrent + '）⇒「有陈旧带符号量、但本帧没有电解电流」这个状态真实可达');
    const aAfter = v.polarityOf(f.eA.id), bAfter = v.polarityOf(f.eB.id);
    ok(aAfter === 'cathode', '同一根电极实体（Cu，E0 高）此刻 ⇒ cathode（实测 ' + J(aAfter) + '）');
    ok(bAfter === 'anode', '同一杯里的 Zn ⇒ anode（实测 ' + J(bAfter) + '）');
    ok(aBefore !== aAfter,
      '**同一根电极实体、同一杯，两种情形下阴/阳相反**（' + J(aBefore) + ' ⇒ ' + J(aAfter) + '）');

    // 判别性：两条「一条写死规则」各踩空一次（都不是靠人相信，而是当场算出来）
    const ruleA = (potHighIsMe) => (potHighIsMe ? 'anode' : 'cathode');        // 写死：电位高的一端 = 阳极
    const ruleB = (myE0, otherE0) => (myE0 >= otherE0 ? 'cathode' : 'anode');  // 写死：E0 高的一端 = 阴极
    ok(ruleA(true) === aBefore && ruleA(true) !== aAfter,
      '写死规则A「高电位端 = 阳极」：① 给 ' + J(ruleA(true)) + '（对），③ 给 ' + J(ruleA(true))
      + ' 而真实是 ' + J(aAfter) + ' ⇒ 一条规则糊不了两种情形');
    ok(ruleB(e0A, e0B) === 'cathode' && ruleB(e0B, e0A) === 'cathode' && aBefore === 'anode',
      '写死规则B「E0 高的一端 = 阴极」：③ 对，但 ① 两根电极 E0 相同（' + e0A + ' / ' + e0B
      + '）⇒ 它只能给出两根阴极，与 ① 的 ' + J(aBefore) + ' 冲突 ⇒ 同样糊不了两种情形');
  }

  // ── ④ null 语义 ───────────────────────────────────────────
  head('④ null 语义：判据不可用 / 无电流 / 非电极 / id 不存在 / 不足两根 ⇒ null 且不抛错');
  {
    const P = (v, id) => { try { return { v: v.polarityOf(id) }; } catch (e) { return { threw: String((e && e.message) || e) }; } };

    // 1) 陈旧值仍在，但判据条件不满足（把溶液倒空 ⇒ 不导电 ⇒ 没有 sol: 支路）
    const f = electrolysisFixture(T);
    const v = f.v, stale = v.currentU;
    v.empty();
    ok(stale !== 0, '先把当帧 currentU 留在容器上当陈旧值（' + stale + ' V）');
    ok(v.volume === 0 && !isFinite(v.resistance()),
      '再把溶液倒空 ⇒ volume = ' + v.volume + '、resistance() = ' + v.resistance() + '（不导电）');
    const r1 = P(v, f.eA.id);
    ok(r1.v === null && !r1.threw, '陈旧值仍在但条件不满足 ⇒ null（实测 ' + J(r1) + '）—— 绝不去拿陈旧值猜一个');

    // 2) 两根电极插在杯里、溶液导电，但没有电源驱动 ⇒ 无电流/无电压 ⇒ null
    const g = mkSim(T, { entities: [
      { type: 'beaker', x: 400, y: 300, fill: { liquid: [['CuSO4', 50], ['H2O', 50]] } },
      { type: 'electrode', x: 394, y: 300, props: { metal: 'Cu' } },
      { type: 'electrode', x: 406, y: 300, props: { metal: 'Cu' } },
    ] });
    const gv = g.get(0).vessel, gA = g.get(1), gB = g.get(2);
    const gc = g.tick(DT);
    const gRec = gc.branches.get('sol:' + g.get(0).id);
    ok(!!gRec && Math.abs(gRec.I) < 1e-12, '两根同种电极、接好但无电源：sol: 支路存在且 I = ' + (gRec && gRec.I) + ' A');
    const r2 = P(gv, gA.id);
    ok(r2.v === null && !r2.threw, '未接入电源驱动 ⇒ 无电流/无电压 ⇒ null（实测 ' + J(r2) + '）');

    // 3) 非电极 / 不存在的 id / undefined
    const r3 = P(gv, g.get(0).id);
    ok(r3.v === null && !r3.threw, '传容器自己的 id（非电极）⇒ null（实测 ' + J(r3) + '）');
    const r4 = P(gv, 'no-such-entity-id');
    ok(r4.v === null && !r4.threw, '传不存在的 id ⇒ null（实测 ' + J(r4) + '）');
    const r5 = P(gv, undefined);
    ok(r5.v === null && !r5.threw, '传 undefined ⇒ null（实测 ' + J(r5) + '）');

    // 4) 不足两根电极
    const h = mkSim(T, { entities: [
      { type: 'beaker', x: 400, y: 300, fill: { liquid: [['CuSO4', 50], ['H2O', 50]] } },
      { type: 'electrode', x: 394, y: 300, props: { metal: 'Cu' } },
    ] });
    h.tick(DT);
    const hv = h.get(0).vessel;
    const r6 = P(hv, h.get(1).id);
    ok(hv.electrodes.length === 1 && r6.v === null && !r6.threw,
      '只插入一根电极（electrodes.length = ' + hv.electrodes.length + '）⇒ null（实测 ' + J(r6) + '）');

    // 5) 拿不到电极实体（容器没有 world 回指）
    const saved = f.beaker.world;
    f.beaker.world = null;
    const r7 = P(v, f.eA.id);
    f.beaker.world = saved;
    const r8 = P(v, f.eA.id);
    ok(r7.v === null && !r7.threw, '容器没有 world 回指（拿不到电极实体）⇒ null（实测 ' + J(r7) + '）');
    (function () {
      const w2 = mkSim(T, { entities: [
        { type: 'beaker', x: 400, y: 300, fill: { liquid: [['CuSO4', 50], ['H2O', 50]] } },
        { type: 'electrode', x: 394, y: 300, props: { metal: 'Cu' } },
        { type: 'electrode', x: 406, y: 300, props: { metal: 'Cu' } },
      ] });
      w2.tick(DT);
      const wv = w2.get(0).vessel;
      ok(typeof wv.polarityOf === 'function', '对照组：同一实现、世界完好时 polarityOf 可调用（说明上一条的 null 来自世界回指，不是方法缺失）');
    })();
  }

  // ── ⑤ 零副作用 / 幂等 ─────────────────────────────────────
  head('⑤ 零副作用 / 幂等：连续调用结果逐位相同，且不动 vessel 与世界');
  {
    const f = electrolysisFixture(T);
    const v = f.v;
    const snap = () => JSON.stringify([v.electrodes.slice(), v.currentU, v.currentSigned, v.electricCurrent,
      v.volume, v.ionConc(), v.pH(), Object.keys(v).length, v.hasElectrodes()]);
    const before = snap(), entsBefore = f.sim.world.entities.length, tBefore = f.sim.world.time;
    const seq = [];
    for (let i = 0; i < 20; i++) { seq.push(v.polarityOf(f.eA.id)); seq.push(v.polarityOf(f.eB.id)); }
    const after = snap();
    const kinds = [...new Set(seq)];
    ok(seq.length === 40 && kinds.length === 2 && seq[0] === 'anode' && seq[1] === 'cathode',
      '连续 20 轮（40 次）调用结果逐位相同（实测取值集合 ' + J(kinds) + '）');
    ok(before === after, '调用前后 vessel 状态快照逐位相同（' + before + '）');
    ok(f.sim.world.entities.length === entsBefore && f.sim.world.time === tBefore,
      '世界也没被碰（entities ' + entsBefore + ' → ' + f.sim.world.entities.length + '，time ' + tBefore + ' → ' + f.sim.world.time + '）');

    const g = galvanicFixture(T);
    const gBefore = JSON.stringify([g.v.electrodes.slice(), g.v.currentU, g.v.currentSigned]);
    const ga = g.v.polarityOf(g.eCu.id), gb = g.v.polarityOf(g.eCu.id);
    ok(ga === gb && ga === 'cathode', '原电池那一路同样幂等（两次都是 ' + J(ga) + '）');
    ok(JSON.stringify([g.v.electrodes.slice(), g.v.currentU, g.v.currentSigned]) === gBefore,
      '原电池那一路调用前后状态也逐位相同');
  }


  // ── ⑥ task-36：读的时机 / 存读档 / 取序 —— 三条纯状态-顺序性质（无头即可证）──
  head('⑥ 读的时机（distribute 前 = 陈旧值）/ 存读档后旧 id 必须 null / >2 根电极的取序');
  {
    // ══ ① 读的时机：同一杯、同一对电极，把电池接线**真对调** ⇒ 相邻两帧极性相反 ══
    {
      const f = electrolysisFixture(T, {});
      const v = f.v, w = f.sim.world;
      const uFrame1 = v.currentU;
      ok(uFrame1 > 1e-6 && v.polarityOf(f.eA.id) === 'anode',
        '帧1：currentU = ' + uFrame1 + ' V > 0 ⇒ 电极[0] = anode。下面把它真拧成反的 —— '
        + '否则两帧读数同值，这条断言就在空转（这是它的防空转哨兵）');

      for (const x of w.wires.slice()) w.disconnect(x, true);
      f.sim.link(f.bat, 0, f.rs, 0);
      f.sim.link(f.rs, 1, f.eB, 0);
      f.sim.link(f.eA, 0, f.bat, 1);

      const br = f.sim.cb.buildBranches();
      const c = T.solveCircuit(w, br.concat([f.ref]));
      const uStale = v.currentU;
      const rStale = v.polarityOf(f.eA.id);
      f.sim.cb.distribute(DT, c);
      const uFresh = v.currentU;
      const rFresh = v.polarityOf(f.eA.id);

      ok(uStale === uFrame1 && uFresh < -1e-6,
        '两种顺序的读数**并列**：解完电路、distribute **之前** currentU = ' + uStale
        + ' V（= 帧1 的值）；distribute **之后** = ' + uFresh + ' V（帧2 的值）');
      ok(rStale === 'anode' && rFresh === 'cathode',
        '同一根电极实体、同一次调用：**先读** ⇒ ' + J(rStale) + '（陈旧值给的结论）；'
        + '**后读** ⇒ ' + J(rFresh) + '（当帧结论）');
      ok(rStale !== rFresh,
        '★ 所以「读的时机」不是风格问题：先读拿到的是**与当帧相反**的结论 '
        + '⇒ 调用方必须在 distribute() 之后读 polarityOf');
      const bFresh = v.polarityOf(f.eB.id);
      ok(bFresh === 'anode' && rFresh !== bFresh,
        '同一时刻另一根电极的当帧结论 = ' + J(bFresh) + ' ⇒ 与电极[0] 相反（两根一阴一阳）');
    }

    // ══ ② 存读档：**走真身** save() → applySaveData() → _applySave() ══
    //    本仓没有第二个调用者，world.loadJSON 是死路 ⇒ 只能照真身构造。
    //    两条已被 lead 亲自量过、**不必再怀疑**的前提（留出处，免得下一个人再花一轮）：
    //      · 容器状态**有**进存档 —— 出口在 src/main.js:549 `if (e.vessel) o.vessel = e.vessel.toJSON();`
    //        （它**独立于** entity.toJSON()；只看 entity.js:173-180 会得出错误结论）⇒ :599 不是 no-op。
    //      · `v.electrodes` 由 bridge **每帧从世界重建**：src/coupling/bridge.js:78 重写、:132 置空、:142 逐个 push
    //        ⇒ 读档后到重写前为空是**正常中间态** —— 正是本段要钉的那个窗口（读了就必须给 null、不许拿旧 id 猜）。
    {
      const f = electrolysisFixture(T, {});
      const v1 = f.v, oldA = f.eA.id, oldB = f.eB.id;
      const u1 = v1.currentU, i1 = v1.currentSigned;
      ok(Math.abs(u1) > 1e-6 && Math.abs(i1) > 1e-6,
        '存读档前：容器上是**非零**的带符号量（currentU = ' + u1 + ' V、currentSigned = ' + i1
        + ' A）—— 先记下来，待会儿要在同样非零的值上考「id 对不上时会不会拿陈旧值猜一个」');

      // 从磁盘切出**真身方法体**：切不到就当场判死（不许拿我抄的一份当替身）
      const ml = norm(readFileSync(join(ROOT, 'src/main.js'), 'utf8')).split('\n');
      const sliceMethod = (sig, sentinel) => {
        const i = ml.findIndex((l) => l.includes(sig));
        if (i < 0) return null;
        let j = i + 1, depth = 1;
        while (j < ml.length && depth > 0) {
          for (const ch of ml[j]) { if (ch === '{') depth++; else if (ch === '}') depth--; }
          j++;
        }
        if (depth !== 0) return null;
        const body = ml.slice(i + 1, j - 1).join('\n');
        if (!body.includes(sentinel)) return null;
        return { body, at: i + 1, end: j };
      };
      const SAVE = sliceMethod('save() {', 'localStorage.setItem(STORE_KEY');
      const APPLY = sliceMethod('_applySave(data) {', 'ents.push(ent);');
      const mainTxt = norm(readFileSync(join(ROOT, 'src/main.js'), 'utf8'));
      const kAt = mainTxt.indexOf('const STORE_KEY = ');
      const kQ1 = kAt < 0 ? -1 : mainTxt.indexOf(String.fromCharCode(39), kAt);
      const kQ2 = kQ1 < 0 ? -1 : mainTxt.indexOf(String.fromCharCode(39), kQ1 + 1);
      const STORE_KEY_REAL = kQ2 > kQ1 ? mainTxt.slice(kQ1 + 1, kQ2) : null;
      ok(!!SAVE && !!APPLY && !!STORE_KEY_REAL,
        '真身锚点：src/main.js 的 save() [行 ' + (SAVE && SAVE.at) + '-' + (SAVE && SAVE.end)
        + ']、_applySave(data) [行 ' + (APPLY && APPLY.at) + '-' + (APPLY && APPLY.end)
        + ']、STORE_KEY = ' + J(STORE_KEY_REAL)
        + ' ⇒ 下面断言的是**出厂代码**，不是我抄的一份');

      // ── 真身存 ──
      const store = new Map();
      const fakeLS = { setItem: (k, x) => store.set(k, x), getItem: (k) => (store.has(k) ? store.get(k) : null) };
      let saveThrew = null;
      try { new Function('localStorage', 'STORE_KEY', SAVE.body).call({ world: f.sim.world, toast: function () {}, log: { push: function () {} } }, fakeLS, STORE_KEY_REAL); }
      catch (e) { saveThrew = String((e && e.message) || e); }
      const raw = store.get(STORE_KEY_REAL);
      ok(!saveThrew && typeof raw === 'string' && raw.length > 0,
        '真身 save() 跑通 ⇒ 存档 JSON 长度 ' + (raw ? raw.length : 0) + ' 字符'
        + (saveThrew ? '；异常：' + saveThrew : ''));
      const data = JSON.parse(raw);
      const withVessel = (data.entities || []).filter((o) => o && o.vessel).length;
      const vReal = f.sim.world.entities.filter((e) => e.vessel).length;
      ok(data.entities.length === f.sim.world.entities.length && withVessel === vReal && vReal >= 1,
        '存档形状：entities ' + data.entities.length + ' 件（其中 ' + withVessel
        + ' 件带顶层 vessel 键，世界里有容器的件数 = ' + vReal
        + ' ⇒ save() 里那一步真的执行了）、wires ' + data.wires.length
        + ' 根（索引五元组 ' + J(data.wires[0] || null) + '）');

      // ── 真身读 ──
      const w2 = new T.World();
      let loadThrew = null, ents2 = null;
      try { ents2 = new Function('data', 'create', APPLY.body).call({ world: w2 }, data, T.create); }
      catch (e) { loadThrew = String((e && e.message) || e); }
      const beaker2 = w2.entities.find((e) => e.vessel);
      const v2 = beaker2 && beaker2.vessel;
      const elec2 = w2.entities.filter((e) => e.probe && e.probe.kind === 'electrode');
      const newA = elec2[0];
      ok(!loadThrew && Array.isArray(ents2) && !!v2 && elec2.length === 2 && newA.id !== oldA,
        '真身 _applySave(data) 跑通：重建 ' + (ents2 ? ents2.length : 0) + ' 件器材；电极 id **重排** '
        + '旧 [' + oldA + ',' + oldB + '] → 新 [' + newA.id + ',' + elec2[1].id + ']'
        + (loadThrew ? '；异常：' + loadThrew : ''));
      ok(!!beaker2 && beaker2.world === w2 && v2.volume > 0 && v2.mol.size > 0,
        '读档后容器里确实还有溶液（volume = ' + (v2 && v2.volume) + '、mol ' + (v2 && v2.mol.size)
        + ' 种、world 回指 ' + (!!beaker2 && beaker2.world === w2) + '）⇒ 真身那条 '
        + 'ent.vessel.loadJSON(o.vessel) 真的跑了，不是空壳');

      const safe = (vv, id) => { try { return { v: vv.polarityOf(id) }; } catch (e) { return { threw: String((e && e.message) || e) }; } };
      const rReal = safe(v2, newA.id);
      ok(v2.electrodes.length === 0 && v2.currentU === 0 && v2.currentSigned === 0,
        '★ 实测：读档后 v2.electrodes = ' + J(v2.electrodes) + '、currentU/currentSigned = '
        + v2.currentU + '/' + v2.currentSigned + '（vessel.toJSON() 不含这三样）'
        + ' ⇒ 真实路径的 null 走的是「**不足两根**」这条分支 —— 单靠它证不了「旧 id 必须 null」');
      ok(rReal.v === null && !rReal.threw,
        '真实路径：读档后、bridge 重写之前 polarityOf(新 id) = ' + J(rReal) + '（分支②：不足两根）');

      v2.electrodes = [oldA, oldB];
      v2.currentU = u1; v2.currentSigned = i1;
      ok(v2.volume > 0 && isFinite(v2.resistance()) && Math.abs(v2.currentU) > 1e-6,
        '防空转哨兵：判据量**齐备**（volume ' + v2.volume + '、resistance() = ' + v2.resistance()
        + ' Ω 有限、|currentU| = ' + Math.abs(v2.currentU) + ' V > 0）⇒ 此时再返回 null '
        + '就只可能是 id 对不上');
      const rOld = safe(v2, oldA), rNew = safe(v2, newA.id);
      ok(rOld.v === null && !rOld.threw,
        '登记表里还挂着**旧 id**（bridge 重写之前）⇒ polarityOf(旧 id) = ' + J(rOld)
        + '（分支③：解析不到电极实体）⇒ **绝不拿陈旧 currentU 猜一个**');
      ok(rNew.v === null && !rNew.threw,
        'polarityOf(新 id) = ' + J(rNew) + '（分支①：重排后新 id 不在登记表里），同样 null');
      info('② 两条分支都实测到了：真实读档 ⇒ 登记表被清空（不足两根）；显式陈旧登记表 ⇒ 旧 id 解析不到。'
        + '两者都必须 null，没有一条会拿陈旧值猜。');
    }
    // ══ ③ >2 根电极：bridge 与本契约都取**前两根** ⇒ 中间插入第 3 根会改变顺序 ══
    {
      const build3 = (mode) => {
        const sim = mkSim(T, { entities: [
          { type: 'battery', x: 100, y: 100, props: { emf: EMF, internalR: RI } },
          { type: 'beaker', x: 400, y: 300, fill: { liquid: [['CuSO4', 50], ['H2O', 50]] } },
          { type: 'electrode', x: 388, y: 300, props: { metal: 'Cu' } },
          { type: 'electrode', x: 412, y: 300, props: { metal: 'Cu' } },
          { type: 'resistor', x: 250, y: 220, props: { resistance: R_SERIES } },
        ] });
        const bat = sim.get(0), beaker = sim.get(1), eA = sim.get(2), eB = sim.get(3), rs = sim.get(4);
        sim.link(bat, 0, rs, 0); sim.link(rs, 1, eA, 0); sim.link(eB, 0, bat, 1);
        const x3 = T.create('electrode', 400, 300);
        x3.setProp('metal', 'Cu');
        sim.world.add(x3, true);
        sim.link(x3, 0, bat, 1);
        if (mode === 'mid') {
          const i = sim.world.entities.indexOf(x3);
          sim.world.entities.splice(i, 1);
          sim.world.entities.splice(3, 0, x3);
        }
        sim.tick(DT);
        const sol = sim.cb.branches.find((b) => b.tag === 'solution') || null;
        return { sim, eA, eB, x3, sol, v: beaker.vessel };
      };
      const ord = (r) => r.v.electrodes.map((x) => (x === r.eA.id ? 1 : x === r.eB.id ? 2 : 3));

      const A = build3('append');
      ok(A.v.electrodes.length === 3 && A.v.electrodes[0] === A.eA.id
        && A.v.electrodes[1] === A.eB.id && A.v.electrodes[2] === A.x3.id,
        '真实新增路径（world.add ⇒ 落到**末尾**）⇒ v.electrodes 顺序 = ' + J(ord(A)) + '（[1,2,3]）');
      ok(!!A.sol && A.sol.a.e === A.eA.id && A.sol.b.e === A.eB.id,
        '★ 实测：第 3 根加在**末尾**时 bridge 的 sol: 支路仍是（电极1, 电极2）⇒ **取前两根**、'
        + '顺序**没变** ⇒ 第 3 根被完全忽略');
      ok(A.v.polarityOf(A.eA.id) === 'anode' && A.v.polarityOf(A.eB.id) === 'cathode',
        'append 情形：契约与 bridge 同对 —— 电极1 ⇒ ' + J(A.v.polarityOf(A.eA.id))
        + '、电极2 ⇒ ' + J(A.v.polarityOf(A.eB.id)) + '；被忽略的第 3 根 ⇒ '
        + J(A.v.polarityOf(A.x3.id)) + '（它没参与电路，却仍拿到一个答案）');

      const M = build3('mid');
      ok(M.v.electrodes.length === 3 && M.v.electrodes[0] === M.eA.id
        && M.v.electrodes[1] === M.x3.id && M.v.electrodes[2] === M.eB.id,
        '把第 3 根的**下标**挪到前两根之间 ⇒ v.electrodes ∼ ' + J(ord(M)) + '（[1,3,2]）');
      ok(!!M.sol && M.sol.a.e === M.eA.id && M.sol.b.e === M.x3.id,
        '★ 实测：顺序一变，bridge 的 sol: 支路就换成（电极1, **电极3**）'
        + ' ⇒ **取序真的会改变实际参与电路的那一对**');
      ok(M.v.polarityOf(M.eA.id) === 'anode' && M.v.polarityOf(M.x3.id) === 'cathode',
        '契约与前两根同序：电极1 ⇒ ' + J(M.v.polarityOf(M.eA.id)) + '、电极3 ⇒ '
        + J(M.v.polarityOf(M.x3.id)) + ' ⇒ 与 bridge 的 sol: 支路两端**逐根一致**');
      ok(M.v.polarityOf(M.eB.id) === 'cathode',
        '⚠ 如实记录（**本轮只记录、不改**）：被挤出电路的第 2 根电极仍会被回答 '
        + J(M.v.polarityOf(M.eB.id)) + ' —— 它根本不在判据对里，这个 non-null 答案有误导风险；'
        + '改法由 lead 裁定');
      info('⑥ 三条的结论：① 读的时机决定结论（先读落后一帧、且会给出相反答案）'
        + ' ② 存读档后旧 id 与新 id 都必须 null、绝不拿陈旧值猜'
        + ' ③ >2 根电极时 bridge 与本契约同取**前两根**；真实新增（append）不改顺序，'
        + '但下标落在前两根之间时会改');
    }
  }

  S.items = S.pass + S.fail;
  S.reds = [...new Set(S.failSec)];
  return S;
}

// ══════════════════════════════════════════════════════════
if (MUTATE) {
  const RUN = process.pid.toString(36) + '-' + Date.now().toString(36);
  const h0 = codeOf(ROOT, TOUCHED[0]);
  const shaBefore = sha256(readFileSync(join(ROOT, TOUCHED[0])));
  const redsOf = (S) => (S && Array.isArray(S.failSec) ? [...new Set(S.failSec)] : null);
  const stage = (root, rel, from, to) => {
    const p = join(root, rel);
    const src = norm(readFileSync(p, 'utf8'));
    const hits = src.split(from).length - 1;
    const next = (hits === 1 && from !== to) ? src.replace(from, to) : src;
    const changed = next !== src;
    if (hits === 1 && changed) writeFileSync(p, next);
    return { hits, wrote: hits === 1 && changed, changed, delta: next.length - src.length };
  };
  const MK = (id, desc, from, to, expect, predict) => ({ id, desc, from, to, expect, predict });
  const out = { mode: 'red', ok: false, run: RUN, tmpAbs: TMP, rows: [], ctrlItems: 0, ctrlReds: null };
  try {
    // ── 锚点全部从**磁盘文本**里切出来（不靠人转述；命中数 ≠ 1 即判落盘失败）──
    const vlines = h0.split('\n');
    const iBody = vlines.findIndex((l) => l.includes('const ids = Array.isArray(this.electrodes)'));
    const iTail = vlines.findIndex((l) => l.includes("return entId === anode.id ? 'anode' : 'cathode';"));
    const iGalv = vlines.findIndex((l) => l.includes('// ── 原电池：镜像'));
    const iElec = vlines.findIndex((l) => l.includes('// ── 电解池：溶液支路确实成立时才读当帧求解结果'));
    const CORE = vlines.slice(iBody, iTail + 1).join('\n');
    const GALV = vlines.slice(iGalv, iElec).join('\n');
    const DRIVE = vlines.find((l) => l.includes('const anode = drive > 0 ? a : b;'));
    const THRESH = vlines.find((l) => l.includes('Math.abs(drive) <= POLARITY_EPS) return null;'));
    const SIG = vlines.find((l) => l.includes('polarityOf(entId) {'));
    const AB2 = vlines.find((l) => l.includes('const [a, b] = ents;'));
    const ENTS = vlines.find((l) => l.includes('ents.some((e) => !e'));
    const anchorsOk = !!CORE && !!GALV && !!DRIVE && !!THRESH && !!SIG && !!AB2 && !!ENTS && iTail > iBody && iElec > iGalv
      && iBody > 0 && iTail > 0 && iGalv > 0 && iElec > 0;
    out.anchorFrom = 'src/chemistry/vessel.js@' + iBody + '-' + iTail + '/galv@' + iGalv + '-' + (iElec - 1);
    out.anchorsOk = anchorsOk;
    if (!anchorsOk) throw new Error('锚点切片失败：磁盘文本与预期不符（拒绝用转述当锚点）');

    const M1 = MK('M1', '按材料名硬编码：E0 高的一端 = 阴极，忽略「接法/电流」',
      CORE,
      "    const ids = Array.isArray(this.electrodes) ? this.electrodes : [];\n"
      + "    if (ids.length < 2 || !ids.includes(entId)) return null;\n"
      + "    const world = this.ent && this.ent.world;\n"
      + "    const ents = ids.map((id) => (world && typeof world.get === 'function' ? world.get(id) : null));\n"
      + "    if (ents.some((e) => !e || !e.probe || e.probe.kind !== 'electrode')) return null;\n"
      + "    const me = ents.find((e) => e.id === entId);\n"
      + "    const e0 = (e) => (e.probe.E0 === null || e.probe.E0 === undefined ? -99 : e.probe.E0);\n"
      + "    const higher = ents.every((o) => o.id === entId || e0(me) > e0(o));\n"
      + "    return higher ? 'cathode' : 'anode';\n",
      ['①', '④', '⑤', '⑥'], ['①', '④', '⑤', '⑥']);

    const M2 = MK('M2', '行为型：原电池那一路去偷读容器上的陈旧 currentU/currentSigned（把电解池口径套到原电池上）',
      GALV,
      "    // ── 原电池：偷读容器上的带符号量（错实现：把电解池口径套到原电池上）──\n"
      + "    const metals = ents.filter((e) => e.probe.E0 !== null && e.probe.E0 !== undefined);\n"
      + "    if (metals.length >= 2 && this.ionConc() > 0.05) {\n"
      + "      const u = Number(this.currentU);\n"
      + "      const d = (Number.isFinite(u) && Math.abs(u) > POLARITY_EPS) ? u : Number(this.currentSigned);\n"
      + "      if (Number.isFinite(d) && Math.abs(d) > POLARITY_EPS) {\n"
      + "        return ((d > 0) === (entId === a.id)) ? 'anode' : 'cathode';\n"
      + "      }\n"
      + "    }\n",
      ['②', '③', '⑤'], ['②', '③']);

    const M3 = MK('M3', '电解池那一路的符号写反（drive < 0 当阳极）',
      DRIVE, '    const anode = drive < 0 ? a : b;', ['①', '③', '⑤', '⑥'], ['①', '③', '⑤', '⑥']);

    const M4 = MK('M4', '金丝雀：删掉「无电流/无电压」阈值 ⇒ 0 也被当成有效驱动',
      THRESH, '    if (!Number.isFinite(drive)) return null;', ['④'], ['④']);

    // ── task-36 ⑥ 的三条新断言：各自配一个变异体 ──
    const M5 = MK('M5', '读的时机：电解池那一路忽略符号，把**第一根**永远当阳极 ⇒「先读」与「后读」给出同一个答案',
      DRIVE, '    const anode = a;', ['①', '⑥'], ['①', '⑥']);

    const M6 = MK('M6', '存读档：拿不到电极实体时**给猜值**而不是 null ⇒ 旧 id / 无 world 回指都会被猜一个',
      ENTS, ENTS.slice(0, ENTS.indexOf('return null;')) + "return 'cathode';", ['④', '⑥'], ['④', '⑥']);

    const M7 = MK('M7', '取序：改成取**后两根** ⇒ >2 根电极时与本契约/bridge 的取序不再一致',
      AB2, '    const [a, b] = ents.slice(-2);', ['⑥'], ['⑥']);

    const MNOOP = MK('MNOOP', 'null 对造：语义零改动（1e-6 与 0.000001 同值）⇒ 文本变更但必须 0 红',
      'const POLARITY_EPS = 1e-6;', 'const POLARITY_EPS = 0.000001;', [], []);

    const MCRASH = MK('MCRASH', '崩溃自证：在 polarityOf 入口注入 throw（必须落 infra、red 集合为 null）',
      SIG, SIG + "\n    throw new Error('crash-self-proof');", null, null);

    const lastLine = vlines.filter((l) => l.trim().startsWith('export ')).pop() || vlines.filter((l) => l.trim()).pop();
    const MSYNTAX = MK('MSYNTAX', 'null 对造：往文件末尾追加一条语法错误 ⇒ 模块加载失败（必须落 infra、red 集合为 null）',
      lastLine, lastLine + '\nconst = ;', null, null);

    const MUTANTS = [M1, M2, M3, M4, M5, M6, M7, MNOOP, MCRASH, MSYNTAX];

    // ── 对照组：仓库本体（未打补丁）必须**确实跑过**且全绿 ──
    const ctrl = await runSuite(await loadTarget(ROOT), { verbose: false });
    out.ctrlItems = ctrl.items;
    out.ctrlItemsReal = Number.isFinite(ctrl.items) && ctrl.items > 0;
    out.ctrlReds = redsOf(ctrl);
    out.ctrlFail = ctrl.fail;

    for (const m of MUTANTS) {
      const dir = join(TMP, 'mut-' + RUN + '-' + m.id);
      mkdirSync(dir, { recursive: true });
      cpSync(join(ROOT, 'src'), join(dir, 'src'), { recursive: true });
      if (existsSync(join(ROOT, 'package.json'))) cpSync(join(ROOT, 'package.json'), join(dir, 'package.json'));
      const st = stage(dir, TOUCHED[0], m.from, m.to);
      let S = null, err = null;
      if (st.wrote) {
        try { S = await runSuite(await loadTarget(dir), { verbose: false }); }
        catch (e) { err = String((e && e.message) || e); }
      }
      const reds = (err || !st.wrote) ? null : redsOf(S);
      const kind = err ? 'infra' : (!st.wrote ? 'land-fail' : (reds && reds.length ? 'red' : 'green'));
      const alignedExact = (m.expect === null) ? (kind === 'infra' && reds === null) : (reds !== null && JSON.stringify(reds) === JSON.stringify(m.expect));
      const aligned = (m.expect === null) ? (kind === 'infra' && reds === null) : (reds !== null && m.expect.every((s) => reds.includes(s)));
      out.rows.push({
        id: m.id, desc: m.desc, expect: m.expect, predict: m.predict, kind, aligned, alignedExact, landed: st.wrote,
        landInCode: TOUCHED[0] + '@命中' + st.hits + '处/文本' + (st.changed ? '变更' + (st.delta >= 0 ? '+' : '') + st.delta + '字符' : '未变更'),
        reds, err: err ? err.slice(0, 120) : null,
        items: S ? S.items : null,
        itemsMatchCtrl: S ? (Number.isFinite(S.items) && Number.isFinite(ctrl.items) && S.items === ctrl.items) : null,
        fromSameAsDesc: m.from.trim() === m.desc.trim(),
        mirrorInsideRepo: dir.startsWith(ROOT),
      });
    }

    const redRow = out.rows.filter((r) => r.kind === 'red');
    const infraRow = out.rows.filter((r) => r.kind === 'infra');
    out.mutants = out.rows.length;
    out.expectedRed = MUTANTS.filter((m) => m.expect !== null && m.expect.length > 0).length;
    out.observedRed = redRow.length;
    out.expectedGreen = MUTANTS.filter((m) => Array.isArray(m.expect) && m.expect.length === 0).length;
    out.observedGreen = out.rows.filter((r) => r.kind === 'green').length;
    out.allLanded = out.rows.every((r) => r.landed === true);
    out.landFail = out.rows.filter((r) => r.kind === 'land-fail').map((r) => r.id);
    out.expectedRedPairs = MUTANTS.filter((m) => m.expect !== null).reduce((a, m) => a + m.expect.length, 0);
    out.observedRedPairs = redRow.reduce((a, r) => a + r.reds.length, 0);
    out.nullProof = infraRow.map((r) => r.id);
    out.canary = redRow.length >= 1;
    out.infraNullProof = infraRow.length >= 2 && infraRow.every((r) => r.reds === null);
    out.allAligned = out.rows.every((r) => r.aligned);
    out.allExact = out.rows.every((r) => r.alignedExact);
    out.redKills3 = redRow.some((r) => r.reds.includes('③'));
    out.itemsAllMatch = out.rows.filter((r) => r.items !== null).every((r) => r.itemsMatchCtrl);
    out.fromNotDescAll = out.rows.every((r) => r.fromSameAsDesc === false);
    out.mirrorsOutsideRepo = out.rows.every((r) => r.mirrorInsideRepo === false);
    out.repoIntact = sha256(readFileSync(join(ROOT, TOUCHED[0]))) === shaBefore && codeOf(ROOT, TOUCHED[0]) === h0;
    out.ctrlBad = ctrl.fail;
    out.ok = out.allExact && out.allLanded && out.itemsAllMatch && out.canary && out.infraNullProof
      && out.mirrorsOutsideRepo && out.repoIntact && ctrl.items > 0 && ctrl.fail === 0 && out.redKills3
      && out.observedRed === out.expectedRed && out.observedGreen === out.expectedGreen && out.ctrlItemsReal;
  } catch (e) {
    out.err = String((e && e.message) || e);
    out.ok = false;
  }
  console.log('ELECTRODE_POLARITY_MUTATE ' + JSON.stringify(out));
  process.exit(out.ok ? 0 : 1);
}

const T = await loadTarget(ROOT);
const S = await runSuite(T, { verbose: true });
const redIds = [...new Set(S.failSec)];
console.log('\n' + (S.fail === 0 ? '\x1b[32m全部通过' : '\x1b[31m有失败') + '：' + (S.pass + S.fail) + ' 项\x1b[0m'
  + (S.fail ? '，失败 ' + S.fail + ' 项' : ''));
console.log('ELECTRODE_POLARITY_JSON ' + JSON.stringify({
  mode: 'green', items: S.pass + S.fail, pass: S.pass, fail: S.fail,
  sectionsDone: Object.keys(S.secTotal).length, sectionsTotal: 6, redIds,
  tmpAbs: TMP, vesselSha: sha256(readFileSync(join(ROOT, TOUCHED[0]))).slice(0, 12),
}));
if (S.fail) { console.log('失败明细：'); for (const f of S.failed) console.log('  - ' + f); }
process.exit(S.fail ? 1 : 0);
