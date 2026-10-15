// ══════════════════════════════════════════════════════════
// 无头验证：证明「物理 ↔ 化学」双向耦合是真的在算，而不是画上去的
//
//   node tools/check.mjs
// ══════════════════════════════════════════════════════════

import { World } from '../src/core/world.js';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PluginHost } from '../src/core/plugin.js';
import { PluginState, PHASES, LEGACY_DISABLED_KEY } from '../src/core/inventory.js';
import { create, list, bindRegistry, equipmentPlugins } from '../src/equipment/index.js';
import { CouplingBus } from '../src/coupling/bridge.js';
import { solveCircuit, fmtA } from '../src/physics/circuit.js';
import { PRESETS } from '../src/presets/experiments.js';
import { SP } from '../src/chemistry/species.js';

import physicsPlugin from '../src/physics/circuit.js';
import chemistryPlugin from '../src/chemistry/reactions.js';
import bridgePlugin from '../src/coupling/bridge.js';
import mintTheme from '../src/plugins/theme.mint.js';
import graphiteTheme from '../src/plugins/theme.graphite.js';
import damageRules from '../src/plugins/rules.damage.js';
import creditSystem from '../src/plugins/system.credit.js';

// ── 用无头宿主把插件装起来，等价于浏览器里的引导过程 ──
const bootApp = {
  services: {}, ticks: [], world: null, lastCircuit: null, selected: null,
  log: { push() {}, clear() {} },
  toast() {},
  addTick(fn) { this.ticks.push(fn); return () => {}; },
  world_dummy: null,
};
export const host = new PluginHost(bootApp);
for (const p of [physicsPlugin, chemistryPlugin, bridgePlugin, mintTheme, graphiteTheme,
                 ...equipmentPlugins, damageRules, creditSystem]) {
  host.define(p);
}
export const bootStats = host.installAll();
bindRegistry(host.registry('equipment'));

let pass = 0, fail = 0;
const ok = (cond, msg) => {
  if (cond) { pass++; console.log('  \x1b[32m✓\x1b[0m ' + msg); }
  else { fail++; console.log('  \x1b[31m✗\x1b[0m ' + msg); }
};
const head = (t) => console.log('\n\x1b[36m' + t + '\x1b[0m');
const f2 = (v) => (typeof v === 'number' ? v.toFixed(2) : String(v));

/** Canvas 2D 的替身：记录不到东西，只保证调用不报错，用来跑通所有渲染分支 */
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

// ── 场景装配（与 main.js 的 loadScene 等价，但不依赖 DOM） ──
function build(sc) {
  const world = new World();
  const cb = new CouplingBus(world);
  const raw = world.step.bind(world);
  let circuit = null;
  world.step = (dt) => {
    const br = cb.buildBranches();
    circuit = solveCircuit(world, br);
    cb.distribute(dt, circuit);
    raw(dt);
  };
  const ents = [];
  for (const o of sc.entities || []) {
    const ent = create(o.type, o.x, o.y);
    if (!ent) { console.log('  !! 无法创建器材: ' + o.type); continue; }
    if (o.props) for (const k of Object.keys(o.props)) ent.setProp(k, o.props[k]);
    if (o.state) Object.assign(ent.state, o.state);
    if (o.fill && ent.vessel) {
      const v = ent.vessel;
      v.capacity = ent.props.capacity || v.capacity;
      for (const [sid, mL] of (o.fill.liquid || [])) v.addLiquid(sid, mL);
      for (const [sid, g] of (o.fill.solid || [])) v.addSolid(sid, g);
      v.updateColor();
    }
    world.add(ent, true);
    ents.push(ent);
  }
  for (const w of sc.wires || []) {
    const a = ents[w[0]], b = ents[w[2]];
    if (a && b) world.connect({ e: a.id, p: w[1] }, { e: b.id, p: w[3] }, w[4]);
  }
  return { world, cb, ents, circuit: () => circuit };
}
const run = (sim, sec, dt = 1 / 120) => {
  for (let i = 0, n = Math.round(sec / dt); i < n; i++) sim.world.step(dt);
};
const byType = (sim, t) => sim.ents.filter(e => e.type === t);

// ══════════════════════════════════════════════════════════
head('① 器材注册表');
{
  const all = list();
  const phys = all.filter(d => d.domain === 'physics').length;
  const chem = all.filter(d => d.domain === 'chemistry').length;
  console.log(`  共 ${all.length} 种器材（物理 ${phys} · 化学 ${chem}）`);
  ok(all.length >= 40, `器材总数 ${all.length} ≥ 40`);
  ok(phys >= 10, `物理器材 ${phys} 种`);
  ok(chem >= 30, `化学器材 ${chem} 种（含试剂瓶自动生成）`);

  const bad = all.filter(d => !d.create || typeof d.create !== 'function');
  ok(bad.length === 0, bad.length ? '缺少 create: ' + bad.map(d => d.type).join(',') : '所有器材都有工厂函数');

  // 每个器材都能实例化
  let errs = [];
  for (const d of all) {
    try {
      const e = create(d.type, 100, 100);
      if (!e) errs.push(d.type + '(null)');
      else if (e.type !== d.type) errs.push(d.type + '(type 不符)');
    } catch (err) { errs.push(d.type + '(' + err.message + ')'); }
  }
  ok(errs.length === 0, errs.length ? '实例化失败: ' + errs.join(', ') : '全部器材可实例化');
}

// ══════════════════════════════════════════════════════════
head('② 纯物理电路：电池 + 开关 + 灯泡（欧姆定律自检）');
{
  const sim = build(PRESETS[0].build());      // 借用场景，先看电路本身
  const { world } = sim;
  const bat = byType(sim, 'battery')[0];
  const sw = byType(sim, 'switch')[0];
  const e1 = byType(sim, 'electrode')[0];

  // 串联一支已知电阻替代溶液，验证 MNA
  const r = create('resistor', 700, 600);
  r.setProp('resistance', 10);
  world.add(r, true);
  // 重接：把电极支路换成电阻，测纯电阻电路
  world.wires.length = 0;
  world.connect({ e: bat.id, p: 1 }, { e: sw.id, p: 0 });
  world.connect({ e: sw.id, p: 1 }, { e: r.id, p: 0 });
  world.connect({ e: r.id, p: 1 }, { e: bat.id, p: 0 });
  sw.setProp('closed', true);
  run(sim, 0.05);

  const c = sim.circuit();
  const I = c.branches.get(r.id).I;
  // 6 V / (10 + 0.5 内阻 + 0.01 开关) ≈ 0.5700 A
  const expect = 6 / (10 + 0.5 + 0.01);
  console.log(`  电流 I = ${fmtA(I)}（理论 ${fmtA(expect)}）`);
  ok(Math.abs(Math.abs(I) - expect) / expect < 0.02, '欧姆定律误差 < 2%');

  sw.setProp('closed', false);
  run(sim, 0.05);
  const I2 = sim.circuit().branches.get(r.id).I;
  ok(Math.abs(I2) < 1e-6, '开关断开后电流为 0');
}

// ══════════════════════════════════════════════════════════
head('③ 物理 → 化学：电流电解水，真的产生氢气和氧气');
{
  const sim = build(PRESETS[0].build());
  const beaker = byType(sim, 'beaker')[0];
  const v = beaker.vessel;

  console.log(`  溶液：${v.volume.toFixed(0)} mL，离子浓度 ${f2(v.ionConc())} mol/L，电阻 ${f2(v.resistance())} Ω`);

  run(sim, 0.5);
  const c = sim.circuit();
  console.log(`  电路：${c.ok ? '已解算' : '失败'}，支路数 ${c.branches.size}，虚拟支路 ${sim.cb.branches.length}`);
  ok(sim.cb.branches.some(b => b.tag === 'solution'), '溶液被识别为电路中的一条支路');
  ok(v.hasElectrodes(), `识别到 ${v.electrodes.length} 根电极插入`);

  const I = v.electricCurrent;
  console.log(`  通过溶液的电流 ${fmtA(I)}`);
  ok(I > 0.01, '溶液中有电流通过');

  run(sim, 20);
  const nH2 = v.gas.get('H2') || 0;
  const nO2 = v.gas.get('O2') || 0;
  console.log(`  20 秒后：H₂ ${(nH2 * 1000).toFixed(3)} mmol（${(nH2 * 24000).toFixed(0)} mL），`
    + `O₂ ${(nO2 * 1000).toFixed(3)} mmol（${(nO2 * 24000).toFixed(0)} mL）`);
  ok(nH2 > 1e-5, '产生了氢气');
  ok(nO2 > 1e-5, '产生了氧气');
  if (nH2 > 1e-6 && nO2 > 1e-6) {
    ok(Math.abs(nH2 / nO2 - 2) < 0.05, `H₂:O₂ 体积比 = ${f2(nH2 / nO2)} : 1（理论 2:1）`);
  }
  ok(v.volume > 0, '水体积未异常');

  // 断开开关 → 电解必须停止
  const sw = byType(sim, 'switch')[0];
  sw.setProp('closed', false);
  run(sim, 0.5);
  const gasBefore = v.gas.get('H2') || 0;
  run(sim, 5);
  const gasAfter = v.gas.get('H2') || 0;
  console.log(`  断开开关后再跑 5 秒：H₂ ${(gasBefore * 1000).toFixed(3)} → ${(gasAfter * 1000).toFixed(3)} mmol`);
  ok(Math.abs(gasAfter - gasBefore) < 1e-6, '断电后电解立即停止（电流是唯一的驱动力）');
}

// ══════════════════════════════════════════════════════════
head('④ 化学 → 物理：锌铜原电池驱动灯泡');
{
  const sim = build(PRESETS[1].build());
  run(sim, 0.3);

  const cell = sim.cb.branches.find(b => b.tag === 'galvanic');
  ok(!!cell, '识别出原电池支路');
  if (cell) {
    console.log(`  ${cell.metals[0]}｜${cell.metals[1]}  电动势 ${f2(cell.emf)} V（理论 1.10 V）`);
    ok(Math.abs(cell.emf - 1.10) < 0.02, 'Zn/Cu 电动势 = 1.10 V');
  }

  const c = sim.circuit();
  const lamp = byType(sim, 'lamp')[0];
  const am = byType(sim, 'ammeter')[0];
  const I = c.branches.get(am.id).I;
  console.log(`  回路电流 ${fmtA(I)}，灯泡功率 ${f2(c.branches.get(lamp.id).P)} W`);
  ok(Math.abs(I) > 0.01, '化学能产生了可测量的电流');
  ok(c.branches.get(lamp.id).P > 1e-4, '灯泡获得功率（真的在发光）');

  // 换成同种金属 → 不应再有原电池
  const cu2 = byType(sim, 'electrode')[0];
  cu2.setProp('metal', 'Cu');
  run(sim, 0.2);
  const cell2 = sim.cb.branches.find(b => b.tag === 'galvanic');
  ok(!cell2, '两根都是铜时不再产生电动势（对照组）');
}

// ══════════════════════════════════════════════════════════
head('⑤ 化学 → 物理：反应放热改变热敏电阻，电流随之变化（闭环）');
{
  const sim = build(PRESETS[2].build());
  const th = byType(sim, 'thermistor')[0];
  const am = byType(sim, 'ammeter')[0];
  const beaker = byType(sim, 'beaker')[0];
  const lamp = byType(sim, 'alcohollamp')[0];

  run(sim, 0.3);
  const I0 = sim.circuit().branches.get(am.id).I;
  const R0 = th.resistanceNow();
  const T0 = beaker.vessel.temp;
  console.log(`  初始：液温 ${f2(T0)} ℃，热敏阻值 ${f2(R0)} Ω，电流 ${fmtA(I0)}`);
  ok(Math.abs(T0 - 25) < 0.5, '初始液温 25 ℃');
  ok(Math.abs(R0 - 100) < 1, '热敏电阻在 25 ℃ 时阻值为标称 100 Ω');

  ok(lamp.props.lit === false, '酒精灯初始未点燃');
  lamp.props.lit = true;
  run(sim, 40);

  const I1 = sim.circuit().branches.get(am.id).I;
  const R1 = th.resistanceNow();
  const T1 = beaker.vessel.temp;
  console.log(`  加热 40 s 后：液温 ${f2(T1)} ℃，热敏阻值 ${f2(R1)} Ω，电流 ${fmtA(I1)}`);
  ok(T1 > T0 + 5, `酒精灯把液体加热了 ${f2(T1 - T0)} ℃`);
  ok(R1 < R0, 'NTC 热敏电阻随温度升高而阻值下降');
  ok(Math.abs(I1) > Math.abs(I0) * 1.15, `电流随温度上升而增大（${fmtA(I0)} → ${fmtA(I1)}）`);
  ok(th.state.source && th.state.source !== '室温', '热敏电阻从容器读取到温度，而不是环境温度');

  lamp.props.lit = false;
  const T2 = beaker.vessel.temp;
  run(sim, 60);
  console.log(`  熄灭 60 s 后：液温 ${f2(beaker.vessel.temp)} ℃`);
  ok(beaker.vessel.temp < T2, '停止加热后液体开始散热降温');
}

// ══════════════════════════════════════════════════════════
head('⑥ 物理 → 热：电热丝浸在液体里，焦耳热把水烧热');
{
  const sim = build(PRESETS[4].build());
  const beaker = byType(sim, 'beaker')[0];
  const heater = byType(sim, 'heater')[0];
  const am = byType(sim, 'ammeter')[0];

  run(sim, 0.3);
  const v = beaker.vessel;
  const I = sim.circuit().branches.get(am.id).I;
  const P = Math.abs(sim.circuit().branches.get(heater.id).P);
  const T0 = v.temp;
  console.log(`  电流 ${fmtA(I)}，电热丝功率 ${f2(P)} W，初始水温 ${f2(T0)} ℃`);
  ok(heater.state.heatOut > 0.1, '电热丝把功率交给了液体（heatOut > 0）');

  run(sim, 60);
  const T1 = v.temp;
  const dQ = (T1 - T0) * v.totalMass() * 4.18;
  const expect = P * 60;
  console.log(`  60 秒后水温 ${f2(T1)} ℃，吸收热量 ${f2(dQ)} J（电功 ${f2(expect)} J）`);
  ok(T1 > T0 + 1.5, `液体被加热 ${f2(T1 - T0)} ℃`);
  ok(dQ > expect * 0.5, '焦耳热有相当一部分进入了液体（其余散失到环境）');
}

// ══════════════════════════════════════════════════════════
head('⑦ 纯化学：金属与酸、复分解、沉淀、指示剂');
{
  const world = new World();
  const cb = new CouplingBus(world);
  const beaker = create('beaker', 300, 300);
  world.add(beaker, true);
  const v = beaker.vessel;

  // Zn + 2HCl → ZnCl₂ + H₂↑
  v.addLiquid('H2O', 60);
  v.addLiquid('HCl', 60);
  v.addSolid('Zn', 3);
  const T0 = v.temp;
  for (let i = 0; i < 1200; i++) { beaker.step(1 / 120, world); world.time += 1 / 120; }
  const nH2 = v.gas.get('H2') || 0;
  console.log(`  Zn+2HCl：10 秒产生 H₂ ${(nH2 * 24000).toFixed(0)} mL，温度 ${f2(T0)} → ${f2(v.temp)} ℃`);
  ok(nH2 > 1e-4, '锌与盐酸反应产生氢气');
  ok(v.temp > T0, '置换反应放热，温度上升');

  // 中和放热
  const b2 = create('beaker', 400, 300);
  world.add(b2, true);
  const v2 = b2.vessel;
  v2.addLiquid('H2O', 50);
  v2.addLiquid('NaOH', 50);
  v2.addLiquid('Phenolphthalein', 2);
  const phBase = v2.pH();
  const colBase = v2.color;
  v2.addLiquid('HCl', 50);
  for (let i = 0; i < 600; i++) { b2.step(1 / 120, world); world.time += 1 / 120; }
  console.log(`  NaOH+酚酞：pH ${f2(phBase)}（颜色 ${colBase ? colBase.join(',') : '无色'}）→ 加盐酸后 pH ${f2(v2.pH())}`);
  ok(phBase > 9, '氢氧化钠溶液呈强碱性');
  ok(!!colBase, '酚酞在碱性溶液中显色（渲染层拿到颜色）');
  ok(v2.pH() < phBase, '加入盐酸后 pH 下降');
  ok(v2.temp > 25, '中和反应放热');

  // 沉淀
  const b3 = create('beaker', 500, 300);
  world.add(b3, true);
  const v3 = b3.vessel;
  v3.addLiquid('CuSO4', 40);
  const c0 = v3.color;
  v3.addLiquid('NaOH', 40);
  for (let i = 0; i < 600; i++) { b3.step(1 / 120, world); world.time += 1 / 120; }
  console.log(`  CuSO₄+NaOH：沉淀 ${[...v3.precip.keys()].join(',') || '无'}，浊度 ${f2(v3.turbidity)}`);
  ok(v3.precip.has('Cu(OH)2'), '生成蓝色 Cu(OH)₂ 沉淀');
  ok(c0 && c0[2] > c0[0], '硫酸铜溶液本身是蓝色（蓝通道最强）');
}

// ══════════════════════════════════════════════════════════
head('⑧ 温控反应：加热才分解');
{
  const world = new World();
  const b = create('beaker', 300, 300);
  world.add(b, true);
  const v = b.vessel;
  v.addLiquid('H2O2', 50);
  for (let i = 0; i < 600; i++) { b.step(1 / 120, world); world.time += 1 / 120; }
  const noCat = v.gas.get('O2') || 0;
  ok(noCat < 1e-6, '没有催化剂时过氧化氢几乎不分解');

  v.addSolid('MnO2', 0.5);
  for (let i = 0; i < 600; i++) { b.step(1 / 120, world); world.time += 1 / 120; }
  const withCat = v.gas.get('O2') || 0;
  console.log(`  MnO₂ 催化：5 秒产生 O₂ ${(withCat * 24000).toFixed(0)} mL`);
  ok(withCat > 1e-5, '加入二氧化锰后迅速放出氧气');
}

// ══════════════════════════════════════════════════════════
head('⑨ 序列化往返（保存 / 载入不丢状态）');
{
  const sim = build(PRESETS[0].build());
  run(sim, 3);
  const beaker = byType(sim, 'beaker')[0];
  const before = beaker.vessel.summary();
  const snap = beaker.vessel.toJSON();

  const sim2 = build(PRESETS[0].build());
  const beaker2 = byType(sim2, 'beaker')[0];
  beaker2.vessel.loadJSON(snap);
  const after = beaker2.vessel.summary();

  console.log(`  存档前：${before}`);
  console.log(`  载入后：${after}`);
  ok(before === after, '容器状态逐字还原');
  ok(beaker.vessel.toJSON().mol.length > 1, '溶质被一起序列化');
}

// ══════════════════════════════════════════════════════════
head('⑩ 全部器材渲染 / 步进不抛异常（Canvas 用替身）');
{
  const ctx = mockCtx();
  const world = new World();
  const bad = [];
  for (const d of list()) {
    const e = create(d.type, 200, 200);
    if (!e) continue;
    world.add(e, true);
    try { e.render(ctx, world); } catch (err) { bad.push(`${d.type} render: ${err.message}`); }
    try { e.step(1 / 120, world); } catch (err) { bad.push(`${d.type} step: ${err.message}`); }
  }
  ok(bad.length === 0,
    bad.length ? '渲染/步进异常：\n     ' + bad.join('\n     ')
      : `${list().length} 种器材全部渲染并步进，无异常`);

  // 全场景渲染（含连线绘制路径）
  const a = world.entities[0], b = world.entities.find(e => e.ports.length > 1);
  if (a && b) {
    try { world.connect({ e: a.id, p: 0 }, { e: b.id, p: 0 }); } catch { /* 端口不匹配就跳过 */ }
  }
  let worldErr = null;
  try { world.render(ctx); } catch (err) { worldErr = err.message; }
  ok(!worldErr, worldErr ? 'world.render 抛错: ' + worldErr : 'world.render 全场景渲染通过');
}

// ══════════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════════
// 守卫的输出要跨 §⑪ 与 §⑫ 两节使用，所以在块外声明
let guardOut = null;
let guardErr = '';

head('⑪ 插件装载守卫：真实的 ALL_PLUGINS 全部装得上（本次 bug 的漏检根因）');
{
  // 上面那些用例只 import 了自己声明的少数插件，从不用真实的 ALL_PLUGINS，
  // 于是「某个插件 setup 抛错」永远不会被发现：ui.interaction 在
  // `this.app.setStatusTool is not a function` 上中断，涟漪与拖尾监听器从未注册，
  // 45 项却依然全绿。这里改为装载**真正启动用的那一批插件**（唯一名单）。
  // 守卫跑在独立进程里（tools/guard-plugins.mjs），它的 DOM 替身与 rAF 循环
  // 不会污染本套件其余用例。
  guardOut = null;
  guardErr = '';
  try {
    guardErr = execFileSync(process.execPath, ['tools/guard-plugins.mjs', '--quiet'], {
      cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    guardErr = String(err.stdout || '') + String(err.stderr || '') + (err.message || '');
  }
  const m = String(guardErr).match(/GUARD_JSON (\{.*\})/);
  if (m) { try { guardOut = JSON.parse(m[1]); } catch { /* 解析失败按无输出处理 */ } }

  ok(!!guardOut, guardOut ? '装载守卫在独立进程里跑完并回报了结果'
    : '装载守卫没有产出结果：' + String(guardErr).split('\n').slice(0, 3).join(' | '));
  if (guardOut) {
    console.log(`  ${guardOut.installed}/${guardOut.total} 个插件装载成功，失败 ${guardOut.failed} 个`
      + `（贡献 ${guardOut.stats ? guardOut.stats.contributions : '?'} 条）`);
    const why = []
      .concat(guardOut.bootThrew ? ['引导异常: ' + guardOut.bootThrew] : [])
      .concat((guardOut.failures || []).map(f => `${f.id} — ${f.error}`));
    ok(guardOut.failed === 0 && (guardOut.failures || []).length === 0,
      why.length
        ? '装载失败的插件（真实缺陷）：\n     ' + why.join('\n     ')
        : `真实的全部 ${guardOut.total} 个插件装入无异常`);
    ok(guardOut.installed === guardOut.total && guardOut.total > 0,
      `installed === total（${guardOut.installed} === ${guardOut.total}）`);
    const it = guardOut.interaction || {};
    ok(it.id === 'xiaomo.ui.interaction' && it.enabled === true && !it.error,
      `xiaomo.ui.interaction enabled=${it.enabled} error=${it.error === null ? 'null' : it.error}`);
    ok(guardOut.interactionLive === true, '涟漪/拖尾所属的 Interaction 实例真的建起来了（app.interaction.setTool 可用）');
    ok(guardOut.pluginCount === guardOut.total && guardOut.listMismatch === false,
      `守卫装的名单与 main.js 导出的 ALL_PLUGINS 一致（${guardOut.pluginCount} 个）`);
    // 退化保护：名单被截断时上面几条会"全绿"，这一条挡住
    ok(guardOut.total >= 23, `插件总数 ${guardOut.total} ≥ 23（名单没被截断）`);

    // ── 渲染路径的**覆盖证据**（task-43）────────────────────────────────
    // 「没抛」不等于「走到了」✗：插槽的渲染函数可能半途 return、也可能尾部代码在空集合上
    // 一次都没执行（替身 querySelectorAll 曾恒返回 [] ✗）。这类缺口此前只有裸跑闸门的人看得见 ✗。
    ok(guardOut.renderOk === true,
      `每个插槽的渲染函数都走到了最后一行（槽 ${(guardOut.slotNames || []).length} 个`
      + `，无痕迹 ${(guardOut.tailMissing || []).length} 个`
      + `${(guardOut.tailMissing || []).length ? '：' + guardOut.tailMissing.join('、') : ''}`
      + `，痕迹不成立 ${(guardOut.tailBad || []).length} 个`
      + `${(guardOut.tailBad || []).length ? '：' + guardOut.tailBad.join('、') : ''}）`);
    // 收集型断言的**非空前置**（D35：空集合上 every() 恒真 ✗）＋ 每条痕迹必须能追溯到
    // 具体某一行代码（what 里带 文件:行 ✓）—— 没有出处的"痕迹"事后无法复核 ✗。
    const slots = guardOut.slotNames || [];
    const anchored = slots.filter((n) => guardOut.slotTail && guardOut.slotTail[n]
      && /\.js:\d/.test(String(guardOut.slotTail[n].what || '')));
    ok(slots.length >= 9 && anchored.length === slots.length
      && slots.every((n) => guardOut.renderTrace && guardOut.renderTrace[n]),
      `逐槽痕迹都有代码出处（${anchored.length}/${slots.length}）且每槽都有 renderTrace 读数`);
  }
}

// ══════════════════════════════════════════════════════════
head('⑫ T1 插件管理：两级启停状态与只读清单的契约');
{
  // 这一节是为了取代某个一次性验证脚本：脚本删掉之后证据就不可复现了，
  // 而契约必须每次都被机械检查。谁破坏了它，这里立刻变红。

  // ① 阶段词表：恰好这五个词，多一个少一个都算破坏契约
  ok(Array.isArray(PHASES) && PHASES.join(',') === 'pending,loading,active,failed,unloading',
    `清单阶段词表恰好是五词：${Array.isArray(PHASES) ? PHASES.join(' / ') : '(不是数组)'}`);

  const memStore = () => {
    const m = new Map();
    return {
      getItem: (k) => (m.has(k) ? m.get(k) : null),
      setItem: (k, v) => { m.set(k, String(v)); },
      removeItem: (k) => { m.delete(k); },
    };
  };

  // ② 旧键平滑迁移：老用户在旧界面里的停用选择不能丢
  {
    const st = memStore();
    st.setItem(LEGACY_DISABLED_KEY, JSON.stringify(['xiaomo.ui.log']));
    const ps = new PluginState(st);
    ok(ps.isItemOff('xiaomo.ui.log') === true && ps.isItemOff('xiaomo.ui.data') === false,
      '旧键 xiaomo.plugins.disabled 里的停用选择被迁进新结构（ui.log 停用，ui.data 未表态）');
    ok(new PluginState(st).isItemOff('xiaomo.ui.log') === true,
      '同一份存储重开一次，迁移结果仍在（这才是持久化的全部意义）');
    st.setItem(LEGACY_DISABLED_KEY, JSON.stringify([]));
    ok(new PluginState(st).isItemOff('xiaomo.ui.log') === false,
      '旧界面里重新启用后新结构也跟着启用（两套界面不会各说各话）');
  }

  // ③ 两级优先级与交给宿主的停用表
  {
    const ps = new PluginState(memStore());
    ps.setBundle('ui', false);
    ps.setItem('xiaomo.ui.log', true);          // 单项想开，但包级关着
    ok(ps.offByOf('xiaomo.ui.log', 'ui') === 'bundle',
      `包级关优先于单项开：offBy = ${ps.offByOf('xiaomo.ui.log', 'ui')}`);
    ps.setBundle('ui', true);
    ps.setItem('xiaomo.ui.log', false);
    ok(ps.offByOf('xiaomo.ui.log', 'ui') === 'item',
      `包级开时单项关生效：offBy = ${ps.offByOf('xiaomo.ui.log', 'ui')}`);
    ok(ps.offByOf('xiaomo.ui.log', 'equipment') === 'item',
      '换一个包名判定的仍是这条单项选择（包名不参与单项判定）');
    ok(ps.offByOf('xiaomo.never.touched', 'equipment') === null,
      '没表过态的插件 offBy 为 null（不会被误判成被关掉）');
    const ps2 = new PluginState(memStore());
    ps2.setBundle('core', false);
    const map = ps2.toOffMap([{ id: 'a', kind: 'core' }, { id: 'b', kind: 'core' }, { id: 'c', kind: 'ui' }]);
    ok(map instanceof Map && map.get('a') === 'bundle' && map.get('b') === 'bundle' && !map.has('c'),
      `包级关展开成逐 id 的停用表：${[...map].map(([k, v]) => k + '=' + v).join(' ')}`);
  }

  // ④ 只读清单的真宿主证据（守卫那一行 JSON 就是证据，这里只做断言）
  if (guardOut && guardOut.inventory && !guardOut.inventory.error) {
    const iv = guardOut.inventory;
    ok(iv.total === guardOut.total && iv.itemCount === guardOut.total,
      `真实 ${guardOut.total} 个插件全部进了清单（items = ${iv.itemCount}）`);
    ok(iv.countsKeys.join(',') === 'pending,loading,active,failed,unloading',
      `分桶键恰好是那五个词：${iv.countsKeys.join(' / ')}`);
    ok(iv.counts.active === guardOut.installed && iv.counts.failed === guardOut.failed
      && iv.counts.loading === 0 && iv.counts.unloading === 0,
      `分桶数与装载结果一致：active=${iv.counts.active} failed=${iv.counts.failed}`
      + ` loading=${iv.counts.loading} unloading=${iv.counts.unloading}`);
    ok(iv.allActive && iv.unknownPhase.length === 0,
      iv.unknownPhase.length
        ? '有插件落在五词之外：' + iv.unknownPhase.join(', ')
        : `${iv.itemCount} 条全部且仅落在五词之内`);
    ok(iv.allOffByNull, '默认启动时没有任何插件被标记为「被谁关掉」（offBy 全 null）');
    ok(iv.isCopy === true, '清单条目是拷贝而不是宿主记录本身（只读的技术保证）');
    ok(iv.frozenCounts === 'frozen' && iv.frozenItems === 'frozen',
      `快照真的冻结：改 counts → ${iv.frozenCounts}，改 items → ${iv.frozenItems}`);
    ok(iv.subscriberPushed > 0,
      `启停一次后订阅者被叫醒 ${iv.subscriberPushed} 次（界面不需要轮询）`);
    ok(iv.phasesSeen.indexOf('unloading') >= 0 && iv.phasesSeen.indexOf('pending') >= 0
      && iv.phasesSeen.indexOf('loading') >= 0,
      `五个桶里的瞬时态真的报得出来，本次观察到：${iv.phasesSeen.join(' / ')}`);
    ok(iv.roundTripPhase === 'active' && iv.roundTripEnabled === true,
      `停用再启用一圈后回到 active/enabled：${iv.roundTripPhase} / ${iv.roundTripEnabled}`);
  } else {
    ok(false, '守卫没有回报名单信息：'
      + ((guardOut && guardOut.inventory && guardOut.inventory.error) || '无 inventory 字段'));
  }
}


// ══════════════════════════════════════════════════════════
// ⑬ 插件市场契约（DSH catalog-provider 兼容）
//
// 市场承载着一个对外承诺：「同一份目录源 DSH 也能读」。承诺必须机器可查，
// 所以这里钉三件事：① 自带目录过关且能力如实声明；② 坏数据被明确拒绝；
// ③ 声明的 sha256 == 磁盘上的真实字节。
//
// ③ 是最容易悄悄失效的一条：有人改了示例插件却忘了改哈希，用户安装时
// 会被我们自己的校验拒掉——而开发机上一切「看起来正常」。它同时也是
// .gitattributes 里 eol=lf 的理由（CRLF 会让字节与哈希不符）。
// 哈希用 Node 自带 crypto 独立算，不依赖 market.js 的实现，避免自证。
// ══════════════════════════════════════════════════════════
{
  try {
    const { readFileSync, existsSync } = await import('node:fs');
    const { createHash } = await import('node:crypto');
    const M = await import('../src/core/market.js');
    const at = (rel) => fileURLToPath(new URL(rel, import.meta.url));
    const readJson = (rel) => JSON.parse(readFileSync(at(rel), 'utf8'));
    const codeOf = (fn) => {
      try { fn(); return '(没有抛错)'; } catch (e) { return (e && e.code) || '(无 code)'; }
    };

    ok(typeof M.parseSource === 'function' && typeof M.parsePage === 'function'
      && typeof M.parseExtensions === 'function' && typeof M.sha256Hex === 'function'
      && typeof M.MarketClient === 'function',
      '市场内核导出了契约要求的校验器与客户端');

    // ① 自带来源 manifest：过关，且不许声称自己没有的能力
    const src = readJson('../market/catalog-source.json');
    const parsed = M.parseSource(src);
    ok(parsed.transport.kind === 'https-json' && parsed.transport.method === 'GET',
      `自带目录源是 https-json + GET`);
    ok(parsed.transport.endpoint.startsWith('https://')
      && /\/v1\/plugins$/.test(parsed.transport.endpoint),
      `端点必须是 HTTPS 且路径以 /v1/plugins 结尾（契约 pattern）：${parsed.transport.endpoint}`);
    ok(parsed.query.supported.length === 0 && parsed.query.sorts.length === 0,
      '服务端筛选能力如实声明为空（静态托管上没有服务端筛选，不做本地也实现不了的承诺）');
    ok(parsed.query.defaultLimit <= parsed.query.maxLimit && parsed.query.maxLimit <= 200,
      `分页上限自洽且不超契约上限：${parsed.query.defaultLimit} ≤ ${parsed.query.maxLimit} ≤ 200`);
    ok(parsed.extensionsUrl
      === new URL('xiaomo-extensions.json', parsed.transport.endpoint).href,
      '旁挂安装信息地址由端点推导，来源作者不需要额外配置');

    // ② 坏 manifest 的拒绝路径：每条都要抛带 code 的 MarketError
    const badSrc = (mut) => {
      const j = JSON.parse(JSON.stringify(src)); mut(j); return codeOf(() => M.parseSource(j));
    };
    ok(badSrc((j) => { j.transport.endpoint = 'http://example.com/market/v1/plugins'; }) === 'insecure-url',
      '明文 http 端点被拒（只收 HTTPS，回环除外）');
    ok(badSrc((j) => { j.transport.method = 'POST'; }) === 'bad-transport',
      '非 GET 传输被拒（契约只允许 GET）');
    ok(badSrc((j) => { j.transport.kind = 'command'; }) === 'bad-transport',
      '非 https-json 的传输被拒（绝不允许目录携带可执行指令）');
    ok(badSrc((j) => { j.transport.endpoint = 'https://example.com/market/plugins.json'; }) === 'bad-endpoint',
      '端点路径不合 pattern 被拒');
    ok(badSrc((j) => { j.query.defaultLimit = 200; j.query.maxLimit = 50; }) === 'bad-value',
      'defaultLimit > maxLimit 被拒（schema 管不了这种字段间关系，得自己查）');
    ok(badSrc((j) => { j.query.supported = ['sql']; }) === 'bad-value',
      '契约未定义的能力被拒（不许自称支持不存在的东西）');
    ok(badSrc((j) => { j.manifestVersion = '9.9.9'; }) === 'bad-version',
      '不支持的 manifestVersion 被拒');
    ok(codeOf(() => M.parseSource({ manifestVersion: '1.0.0' })) !== '(没有抛错)',
      '缺必填字段被拒');

    // ③ 自带目录页：过关，且内联代码被整页拒绝
    const page = readJson('../market/v1/plugins');
    const pp = M.parsePage(page);
    ok(pp.items.length === page.items.length && pp.items.length >= 1,
      `自带目录页校验通过：${pp.items.length} 条条目`);
    {
      const j = JSON.parse(JSON.stringify(page));
      j.items = j.items.map((it, i) => (i === 0 ? { ...it, xiaomo: { code: 'alert(1)' } } : it));
      ok(codeOf(() => M.parsePage(j)) === 'code-not-allowed',
        '目录里内联代码被整页拒绝（契约硬规则：不许携带 JS/命令/凭据）');
    }

    // ④ 旁挂扩展文档 + 哈希一致性
    const ext = M.parseExtensions(readJson('../market/v1/xiaomo-extensions.json'));
    const ids = Object.keys(ext.items || {});
    ok(ids.length >= 2, `旁挂文档声明了 ${ids.length} 个可安装条目`);
    for (const id of ids) {
      const e = ext.items[id];
      const file = at('../market/v1/' + e.entry);
      if (!existsSync(file)) { ok(false, `${id} 的 entry 指向不存在的文件：${e.entry}`); continue; }
      ok(true, `${id} 的 entry 指向真实文件：${e.entry}`);
      const bytes = readFileSync(file);
      const digest = createHash('sha256').update(bytes).digest('hex');
      ok(digest === e.sha256,
        `${id} 声明的 sha256 == 磁盘字节（${digest.slice(0, 12)}…）`);
      ok(bytes.length === e.bytes, `${id} 声明的字节数 == 实际 ${bytes.length} B`);
      const text = bytes.toString('utf8');
      ok(!/^[ \t]*import[ \t]/m.test(text) && !/\brequire[ \t]*\(/.test(text),
        `${id} 是单文件零依赖 ESM（blob URL 里解析不了相对 import，这是硬边界）`);
      ok(!/\r/.test(text), `${id} 是 LF 换行（CRLF 会让声明哈希与实际字节不符）`);
    }
  } catch (e) {
    ok(false, '市场契约检查自身抛错：' + (e && e.message));
  }
}


// ══════════════════════════════════════════════════════════
console.log(`\n${'─'.repeat(56)}`);
if (fail === 0) console.log(`\x1b[32m全部通过：${pass} 项\x1b[0m`);
else console.log(`\x1b[31m通过 ${pass} 项，失败 ${fail} 项\x1b[0m`);
process.exit(fail === 0 ? 0 : 1);
