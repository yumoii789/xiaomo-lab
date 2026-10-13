// ══════════════════════════════════════════════════════════
// 无头验证：证明「物理 ↔ 化学」双向耦合是真的在算，而不是画上去的
//
//   node tools/check.mjs
// ══════════════════════════════════════════════════════════

import { World } from '../src/core/world.js';
import { PluginHost } from '../src/core/plugin.js';
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
head('⑪ 插件装载守卫：真实的 ALL_PLUGINS 全部装得上（对照 main.js 的唯一名单）');
{
  // 这一项就是本 bug 的漏检根因：上面那些用例只 import 了自己声明的少数插件，
  // 从不用真实的 ALL_PLUGINS，于是「某个插件 setup 抛错」永远不会被发现。
  //
  // 插件在 setup 里会访问 document / matchMedia / getComputedStyle。Node 里没有这些，
  // 所以下面造一个**能力刚好够**的替身（不是 DOM 实现）：只保证
  //   createElement / getElementById / querySelector → 元素替身，
  //   element.style / classList / appendChild / addEventListener / closest → 空操作，
  //   getComputedStyle → 返回能解析出 duration 的假样式。
  // 替身能力不足会表现为「题外错误」（例如 xxx is not a function on null），
  // 与真实缺陷（app.setStatusTool is not a function）在报错串上是分得开的。
  const makeEl = (tag = 'div') => {
    const el = {
      tagName: String(tag).toUpperCase(),
      id: '', className: '', textContent: '', innerHTML: '',
      style: { setProperty() {}, removeProperty() {}, getPropertyValue: () => '' },
      dataset: {},
      children: [], childNodes: [], parentNode: null,
      offsetWidth: 120, offsetLeft: 0, offsetTop: 0, offsetHeight: 24,
      value: '', checked: false, disabled: false, href: '', download: '',
      classList: {
        add() {}, remove() {}, toggle() {}, contains: () => false,
      },
      setAttribute() {}, getAttribute: () => null, removeAttribute() {},
      appendChild(c) { this.children.push(c); this.childNodes.push(c); return c; },
      insertBefore(c) { this.children.push(c); this.childNodes.push(c); return c; },
      removeChild() {}, replaceChildren() {}, remove() {},
      addEventListener() {}, removeEventListener() {}, dispatchEvent: () => true,
      querySelector: () => null, querySelectorAll: () => [],
      closest: () => null, contains: () => false,
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
      focus() {}, blur() {}, click() {}, select() {}, getContext: () => null,
      toDataURL: () => 'data:,',
    };
    return el;
  };
  const norm = (s) => String(s).replace(/[#.][\w-]+|\s+/g, ' ').trim().toLowerCase();
  const byId = {};
  const el = (tag, id, cls) => {
    const e = makeEl(tag);
    e.id = id || ''; e.className = cls || '';
    if (id) byId[id] = e;
    return e;
  };
  // index.html 里被插件在 setup 阶段访问到的那几个节点
  const stageEl = el('section', 'stage');
  const layerEl = el('div', '', 'stage-fx');
  stageEl.appendChild(layerEl);
  const canvasEl = el('canvas', 'canvas');
  canvasEl.getContext = () => mockCtx();
  const sideTabs = el('nav', 'sideTabs');
  const sideInk = el('span', 'sideInk', 'side-ink');
  const panes = ['inspector', 'data', 'log'].map((p) => el('div', 'pane-' + p, 'pane'));
  const tabBtns = ['inspector', 'data', 'log'].map((p, i) => {
    const b = el('button', '', i === 0 ? 'active' : '');
    b.dataset.pane = p;
    sideTabs.appendChild(b);
    return b;
  });
  el('div', 'hint', 'hint');
  el('div', 'toast', 'toast');
  // 选择器只支持守卫用得上的那几种形状；匹配不到就返回 null（与浏览器一致）
  const queryOne = (sel, root) => {
    const normSel = norm(sel);
    if (sel === '#sideInk') return sideInk;
    for (const e of Object.values(byId)) {
      if (e.className && String(sel).includes('.' + e.className)) return e;
      if (e.textContent && String(sel).includes(e.textContent)) return e;
    }
    return null;
  };
  const queryAll = (sel, root) => {
    if (sel === 'button' && root === sideTabs) return tabBtns;
    if (sel === '#sidebar .pane' || sel === '.pane') return panes;
    return [];
  };
  for (const e of Object.values(byId)) {
    e.querySelector = (s) => queryOne(s, e);
    e.querySelectorAll = (s) => queryAll(s, e);
  }
  const doc = {
    body: makeEl('body'),
    documentElement: makeEl('html'),
    // 没映射到的 id 也给一个空元素替身：否则 main.js 的引导会到处碰到 null，
    // 与守卫要抓的「插件 setup 抛错」混在一起，噪声大于信息。
    getElementById: (id) => byId[id] || (byId[id] = el('div', id)),
    querySelector: (s) => { const r = queryOne(s); if (!r) console.log('  [guard-debug] querySelector 未命中: ' + s); return r; },
    querySelectorAll: (s) => queryAll(s),
    createElement: (tag) => makeEl(tag),
    createElementNS: (_ns, tag) => makeEl(tag),
    createTextNode: (t) => ({ nodeType: 3, textContent: t }),
    createDocumentFragment: () => makeEl('fragment'),
    addEventListener() {}, removeEventListener() {},
    hidden: false, visibilityState: 'visible',
  };
  // 元素替身也要能当事件目标用（closest 已在 makeEl 里给空实现）
  for (const e of Object.values(byId)) e.ownerDocument = doc;
  globalThis.document = doc;
  globalThis.window = {
    document: doc,
    addEventListener() {}, removeEventListener() {},
    matchMedia: (q) => ({
      media: q, matches: false, onchange: null,
      addEventListener() {}, removeEventListener() {},
      addListener() {}, removeListener() {},
    }),
    getComputedStyle: () => ({ getPropertyValue: () => '', animationDuration: '200ms' }),
    devicePixelRatio: 1, innerWidth: 1280, innerHeight: 820,
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    cancelAnimationFrame: (id) => clearTimeout(id),
    requestIdleCallback: (fn) => setTimeout(() => fn({ didTimeout: false, timeRemaining: () => 0 }), 0),
    localStorage: { getItem: () => null, setItem() {}, removeItem() {}, key: () => null, length: 0 },
    location: { href: 'http://127.0.0.1/', search: '', hash: '', reload() {} },
    navigator: { userAgent: 'node', platform: 'node', clipboard: { writeText: async () => {} } },
    performance: globalThis.performance,
    setTimeout, clearTimeout, setInterval, clearInterval,
  };
  globalThis.getComputedStyle = globalThis.window.getComputedStyle;
  globalThis.matchMedia = globalThis.window.matchMedia;
  globalThis.localStorage = globalThis.window.localStorage;
  globalThis.requestAnimationFrame = globalThis.window.requestAnimationFrame;
  globalThis.cancelAnimationFrame = globalThis.window.cancelAnimationFrame;
  globalThis.CustomEvent = class CustomEvent { constructor(t, o) { this.type = t; this.detail = o && o.detail; } };
  globalThis.Blob = class Blob { constructor(p) { this.parts = p; } };
  globalThis.URL.createObjectURL = () => 'blob:stub';
  globalThis.URL.revokeObjectURL = () => {};

  console.log('  [guard-debug] globalThis.document === doc: ' + (globalThis.document === doc)
    + ' · getElementById(canvas) = ' + String(globalThis.document && globalThis.document.getElementById('canvas'))
    + ' · ids = ' + Object.keys(byId).join(','));
  // 动态 import：上面的替身必须先生效，main.js 在模块顶层就要碰 document
  let mod = null;
  try { mod = await import('../src/main.js'); }
  catch (err) {
    console.log('  main.js 在替身环境里导入失败：' + (err && err.message));
    console.log('     ' + String(err && err.stack).split('\n').slice(1, 4).join('\n     ').trim());
  }
  ok(!!mod, 'main.js 能在 DOM 替身下导入（引导过程不崩）');
  const REAL_PLUGINS = mod && mod.ALL_PLUGINS;
  ok(Array.isArray(REAL_PLUGINS) && REAL_PLUGINS.length > 0,
    `从 main.js 拿到真实的 ALL_PLUGINS（${REAL_PLUGINS && REAL_PLUGINS.length} 个插件）`);

  const guardApp = {
    services: {}, ticks: [], world: null, lastCircuit: null, selected: null,
    _dirty: false,
    log: { push() {}, clear() {} },
    toast() {},
    addTick(fn) { this.ticks.push(fn); return () => {}; },
    markDirty() { this._dirty = true; },
  };
  const guardHost = new PluginHost(guardApp, { quiet: true });
  const declared = [];
  for (const p of REAL_PLUGINS) {
    try { guardHost.define(p); declared.push(p.id); }
    catch (err) { declared.push(`定义失败 ${p && p.id}: ${err.message}`); }
  }
  const gstats = guardHost.installAll();
  console.log(`  ${gstats.installed}/${gstats.total} 个插件装载成功，失败 ${gstats.failed} 个`
    + `（贡献 ${gstats.contributions} 条）`);

  const bad = guardHost.list().filter(r => r.error);
  ok(bad.length === 0,
    bad.length
      ? '装载失败的插件（真实缺陷）：\n     ' + bad.map(r => `${r.id} — ${r.error}`).join('\n     ')
      : `真实的全部 ${gstats.total} 个插件装入无异常`);
  ok(gstats.failed === 0, `stats().failed === 0（实际 ${gstats.failed}）`);
  ok(gstats.installed === gstats.total, `installed === total（${gstats.installed} === ${gstats.total}）`);

  // 退化保护：名单被截断时上面几条会"全绿"，这里挡住
  ok(gstats.total >= 23, `插件总数 ${gstats.total} ≥ 23（名单没被截断）`);
}

// ══════════════════════════════════════════════════════════
console.log(`\n${'─'.repeat(56)}`);
if (fail === 0) console.log(`\x1b[32m全部通过：${pass} 项\x1b[0m`);
else console.log(`\x1b[31m通过 ${pass} 项，失败 ${fail} 项\x1b[0m`);
process.exit(fail === 0 ? 0 : 1);
