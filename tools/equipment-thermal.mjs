// ══════════════════════════════════════════════════════════
// 热学器材的无头验证：每件器材的解析解都拿理论值对账
//
//   node tools/equipment-thermal.mjs
//
// 与 tools/check.mjs 同一套写法：无头宿主 + 耦合总线 + 无 Canvas 替身，
// 不依赖浏览器，也不需要 Electron。全部通过才 exit 0。
// ══════════════════════════════════════════════════════════

import { World } from '../src/core/world.js';
import { PluginHost } from '../src/core/plugin.js';
import { create, list, groups, bindRegistry, equipmentPlugins } from '../src/equipment/index.js';
import { CouplingBus } from '../src/coupling/bridge.js';
import { solveCircuit } from '../src/physics/circuit.js';

import chemistryPlugin from '../src/chemistry/reactions.js';
import bridgePlugin from '../src/coupling/bridge.js';
import thermalPlugin, {
  C_WATER, L_FUSION,
  heatFromPower, tempRise, mixTemp, mixCapacity, mixEnergy,
  conductionFlux, barTempAt, barStep, barFluxFromNodes,
  latentHeat, boilPoint, expandLen, passTemp, reactionHeat,
} from '../src/equipment/thermal.js';

// ── 无头宿主：等价于浏览器里的引导过程 ──
const bootApp = {
  services: {}, ticks: [], world: null, lastCircuit: null, selected: null,
  log: { push() {}, clear() {} },
  toast() {},
  addTick(fn) { this.ticks.push(fn); return () => {}; },
};
const host = new PluginHost(bootApp);
for (const p of [chemistryPlugin, bridgePlugin, ...equipmentPlugins, thermalPlugin]) host.define(p);
host.installAll();
bindRegistry(host.registry('equipment'));

let pass = 0, fail = 0;
const ok = (cond, msg) => {
  if (cond) { pass++; console.log('  \x1b[32m✓\x1b[0m ' + msg); }
  else { fail++; console.log('  \x1b[31m✗\x1b[0m ' + msg); }
};
const head = (t) => console.log('\n\x1b[36m' + t + '\x1b[0m');
const f = (v, n = 3) => (typeof v === 'number' ? v.toFixed(n) : String(v));
const rel = (a, b) => Math.abs(a - b) / Math.max(1e-12, Math.abs(b));
const near = (a, b, tol) => Math.abs(a - b) <= tol;

/** Canvas 2D 替身：只保证调用不报错，用来跑通所有渲染分支 */
function mockCtx() {
  const grad = { addColorStop() {} };
  return new Proxy({}, {
    get(_t, k) {
      if (k === 'createLinearGradient' || k === 'createRadialGradient') return () => grad;
      if (k === 'canvas') return { width: 800, height: 600 };
      if (k === 'measureText') return () => ({ width: 10 });
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
    world.add(ent, true);
    ents.push(ent);
  }
  return { world, cb, ents, circuit: () => circuit };
}
const run = (sim, sec, dt = 1 / 120) => { for (let i = 0, n = Math.round(sec / dt); i < n; i++) sim.world.step(dt); };
const byType = (sim, t) => sim.ents.filter(e => e.type === t);

/** 把一个容器摆到热源的正上方 —— 耦合总线就是按这个几何关系找容器的 */
function above(sim, srcType, srcProps = {}) {
  const src = create(srcType, 400, 420);
  for (const k of Object.keys(srcProps)) src.setProp(k, srcProps[k]);
  sim.world.add(src, true); sim.ents.push(src);
  const hp = { x: src.x, y: src.y - src.h * 0.9 };
  return { src, hp };
}

// ══════════════════════════════════════════════════════════
head('① 注册与分组（可单独启停）');
{
  const mine = list().filter(d => d.cat === '热学');
  ok(mine.length === 6, `热学器材注册 6 件：${mine.map(d => d.type).join(' / ')}`);
  ok(mine.every(d => d.domain === 'physics'),
    '六件 domain 全是 physics（registry.js:100 的 DOMAIN_RANK 只认 physics|chemistry|bridge）');
  const sec = groups({ domain: 'physics' }).find(g => g.cat === '热学');
  ok(!!sec && sec.items.length === 6,
    `groups({domain:'physics'}) 里出现 physics/热学 分组，共 ${sec ? sec.items.length : 0} 件` +
    `（器材栏就是按 groups() 渲染的）`);

  const before = host.registry('equipment').size;
  host.disable(thermalPlugin.id, 'item');
  const after = host.registry('equipment').size;
  ok(after === before - 6, `禁用插件：器材注册表 ${before} → ${after}（正好少 6 件）`);
  ok(list().filter(d => d.cat === '热学').length === 0, '禁用后热学分类从器材栏数据源里消失');
  ok(!groups({ domain: 'physics' }).some(g => g.cat === '热学'), '禁用后 groups() 里不再有 热学 分组');
  host.enable(thermalPlugin.id);
  ok(host.registry('equipment').size === before, `重新启用后回到 ${before} 件`);
  ok(list().filter(d => d.cat === '热学').length === 6, '重新启用后 6 件热学器材全部回来');
}

// ══════════════════════════════════════════════════════════
head('② 加热板：Q = P·t，ΔT = Q/(m·c)，并经耦合总线加热上方容器');
{
  const Q = heatFromPower(600, 10);
  ok(near(Q, 6000, 1e-9), `解析：Q = P·t = 600 W × 10 s = ${Q} J`);
  const dT = tempRise(Q, 200);
  ok(rel(dT, 6000 / (200 * C_WATER)) < 1e-12, `解析：ΔT = Q/(mc) = ${f(dT, 4)} ℃（理论 ${f(6000 / (200 * C_WATER), 4)} ℃）`);

  const sim = build({ entities: [] });
  const { src: plate, hp } = above(sim, 'hotplate', { lit: true, power: 600 });
  const beaker = create('beaker', hp.x, hp.y);
  beaker.vessel.capacity = 250;
  beaker.vessel.coolK = 0;                    // 孤立检验：关掉环境散热
  beaker.vessel.addLiquid('H2O', 200);
  sim.world.add(beaker, true); sim.ents.push(beaker);
  run(sim, 10);
  const dTe = beaker.vessel.temp - 25;
  ok(rel(dTe, dT) < 0.01,
    `引擎实测：总线把热交给上方烧杯，200 g 水 10 s 升温 ${f(dTe, 4)} ℃ vs 理论 ${f(dT, 4)} ℃` +
    `（相对误差 ${f(rel(dTe, dT) * 100, 3)}%）`);
  ok(rel(plate.state.Q, 6000) < 1e-9, `加热板自己累计放热 ${f(plate.state.Q, 1)} J == P·t`);
  const target = 25 + 600 / plate.props.lossK;
  const tau = plate.props.plateMass * 0.90 / plate.props.lossK;      // 铝板 τ = mc/lossK
  const expect = 25 + (target - 25) * (1 - Math.exp(-10 / tau));
  ok(rel(plate.state.surf, expect) < 0.01,
    `面板温度按牛顿冷却暂态解爬升：10 s 后 ${f(plate.state.surf, 2)} ℃ vs 解析 ` +
    `25+(T∞−25)(1−e^{−t/τ}) = ${f(expect, 2)} ℃（τ = ${f(tau, 1)} s，稳态 ${f(target, 1)} ℃，` +
    `相对误差 ${f(rel(plate.state.surf, expect) * 100, 3)}%）`);
}

// ══════════════════════════════════════════════════════════
head('③ 量热器：混合法热平衡 T_f = ΣmcT/Σmc（误差 < 1%）与能量守恒');
{
  ok(near(mixTemp([{ m: 100, T: 80 }, { m: 100, T: 20 }]), 50, 1e-12),
    '解析：等质量 80 ℃ / 20 ℃ 混合 → 50 ℃（对称性）');
  const parts = [{ m: 100, T: 80 }, { m: 100, T: 20 }, { m: 20, T: 20 }];
  const Tf = mixTemp(parts);
  ok(rel(Tf, 10400 / 220) < 1e-12,
    `解析：含本体水当量 20 g → T_f = ${f(Tf, 4)} ℃（理论 (100·80+100·20+20·20)/220 = ${f(10400 / 220, 4)} ℃）`);
  const bal = mixEnergy(parts, Tf);
  ok(rel(bal.absorbed, bal.released) < 1e-12,
    `解析：能量守恒 吸热 ${f(bal.absorbed, 1)} J == 放热 ${f(bal.released, 1)} J`);
  ok(rel(mixCapacity(parts), 220 * C_WATER) < 1e-12,
    `解析：总热容 Σmc = ${f(mixCapacity(parts), 1)} J/K == 220 g × 4.18`);

  const sim = build({ entities: [{ type: 'calorimeter', x: 400, y: 300, props: { sealed: true, coolK: 0 } }] });
  const cal = byType(sim, 'calorimeter')[0];
  run(sim, 100);
  const got = cal.vessel.temp;
  ok(rel(got, Tf) < 0.01,
    `引擎收敛（逐帧搅拌热交换）：${f(got, 4)} ℃ vs 解析 ${f(Tf, 4)} ℃（相对误差 ${f(rel(got, Tf) * 100, 4)}%）`);
  ok(rel(cal.state.Tf, Tf) < 1e-12, `界面上显示的 state.Tf = ${f(cal.state.Tf, 4)} ℃ 是同一式子的解`);
  ok(Math.abs(cal.state.T1 - cal.state.T2) < 0.05,
    `两个热体温差收敛到 ${f(cal.state.T1 - cal.state.T2, 5)} ℃（平衡判据）`);

  const sim2 = build({ entities: [{ type: 'calorimeter', x: 400, y: 300, props: { sealed: true } }] });
  const cal2 = byType(sim2, 'calorimeter')[0];
  run(sim2, 100);
  ok(cal2.vessel.temp < Tf,
    `对照：开着默认散热系数 0.35 W/K 做同一实验 → ${f(cal2.vessel.temp, 4)} ℃，比理想值低 ` +
    `${f(Tf - cal2.vessel.temp, 4)} ℃（散热损失，方向正确）`);
}

// ══════════════════════════════════════════════════════════
head('④ 热传导棒：稳态 kAΔT/L 与线性温度分布');
{
  const k = 400, A = 4e-4, L = 0.3, Th = 200, Tc = 25;
  const flux = conductionFlux(k, A, Th, Tc, L);
  ok(rel(flux, 400 * 4e-4 * 175 / 0.3) < 1e-12, `解析：dQ/dt = kAΔT/L = ${f(flux, 4)} W`);
  ok(near(barTempAt(L / 2, L, Th, Tc), (Th + Tc) / 2, 1e-12),
    `解析：稳态棒中点温度 == 两端平均 ${(Th + Tc) / 2} ℃`);

  const bar = create('conductionbar', 0, 0);
  bar.setProp('speed', 200);                  // 明示的时间加速（真实弛豫要几分钟）
  for (let i = 0; i < Math.round(12 * 120); i++) bar.step(1 / 120);
  const T = bar.state.T;
  ok(rel(bar.state.fluxBar, flux) < 0.01,
    `引擎实测：差分反算热流 ${f(bar.state.fluxBar, 3)} W vs 解析 ${f(flux, 3)} W` +
    `（相对误差 ${f(rel(bar.state.fluxBar, flux) * 100, 3)}%）`);
  let dev = 0;
  for (let i = 0; i < T.length; i++) {
    const x = (L * i) / (T.length - 1);
    dev = Math.max(dev, Math.abs(T[i] - barTempAt(x, L, Th, Tc)));
  }
  ok(dev / (Th - Tc) < 0.01,
    `线性分布：${T.length} 个节点最大偏差 ${f(dev, 4)} ℃ = 两端温差的 ${f(dev / (Th - Tc) * 100, 3)}%（< 1%）`);
  ok(near(bar.state.mid, (Th + Tc) / 2, 0.01 * (Th - Tc)),
    `中点温度 ${f(bar.state.mid, 3)} ℃ ≈ ${(Th + Tc) / 2} ℃`);
  const s = barStep([200, 100, 25], 1, 0.5, 0.1, 200, 25);
  const hand = 100 + (0.5 * 0.1 / 1) * (25 - 2 * 100 + 200);
  ok(near(s[1], hand, 1e-12), `barStep 中间节点 ${s[1]} == 手算 FTCS 步进 ${hand}`);
  ok(s[0] === 200 && s[2] === 25, 'barStep 两端保持恒温（Dirichlet 边界）');
  ok(near(barFluxFromNodes([200, 100, 25], 1, 400, 4e-4), 400 * 4e-4 * 100, 1e-9),
    'barFluxFromNodes 用的是离散梯度 kA(T₀−T₁)/dx（与解析式是两个独立路径）');
}

// ══════════════════════════════════════════════════════════
head('⑤ 冰水浴：熔化潜热 Q = mL 与 0 ℃ 平台');
{
  const Q = latentHeat(100);
  ok(near(Q, 33400, 1e-9), `解析：Q = mL = 100 g × ${L_FUSION} J/g = ${Q} J`);

  const sim = build({ entities: [] });
  const { src, hp } = above(sim, 'hotplate', { lit: true, power: 600 });
  void src;
  const bath = create('icebath', hp.x, hp.y);
  bath.setProp('coolK', 0);
  sim.world.add(bath, true); sim.ents.push(bath);

  const dt = 1 / 120, N = Math.round(60 / dt);
  const temps = [];
  for (let i = 0; i < N; i++) { sim.world.step(dt); temps.push(bath.vessel.temp); }
  const tMelt = Q / 600;
  const plateau = temps.slice(0, Math.max(1, Math.round(tMelt / dt) - 3));
  const maxDev = Math.max(...plateau.map(t => Math.abs(t - 0)));
  const variance = plateau.reduce((s, t) => s + t * t, 0) / plateau.length;
  ok(maxDev === 0 && variance === 0,
    `平台期（前 ${f(tMelt, 2)} s，${plateau.length} 帧）温度最大偏差 ${maxDev}、方差 ${variance}（严格为 0）`);
  ok(rel(bath.state.Qlatent, Q) < 0.01,
    `熔化吸收的潜热 ${f(bath.state.Qlatent, 1)} J vs 理论 ${Q} J（相对误差 ${f(rel(bath.state.Qlatent, Q) * 100, 3)}%）`);
  ok(bath.state.mIce < 1e-9, `60 s 后剩余冰 ${bath.state.mIce} g（理论 ${f(tMelt, 2)} s 化完）`);
  ok(rel(bath.state.melted, 100) < 0.01, `累计熔化 ${f(bath.state.melted, 2)} g（理论 100 g）`);
  const Qextra = 600 * (60 - tMelt);
  const m = bath.vessel.totalMass();
  ok(rel(bath.vessel.temp, tempRise(Qextra, m)) < 0.01,
    `化完后升温 ${f(bath.vessel.temp, 4)} ℃ vs 理论 Q余/(mc) = ${f(tempRise(Qextra, m), 4)} ℃` +
    `（m = ${f(m, 1)} g，已把化出来的水计进容器质量）`);
}

// ══════════════════════════════════════════════════════════
head('⑥ 沸腾装置：沸点随压强（克劳修斯-克拉珀龙）与水浴加热化学容器');
{
  ok(near(boilPoint(101.325), 100, 1e-9), `解析：101.325 kPa → ${f(boilPoint(101.325), 4)} ℃`);
  ok(near(boilPoint(47.4), 79.5, 0.6), `解析：47.4 kPa → ${f(boilPoint(47.4), 3)} ℃（文献约 80 ℃）`);
  ok(near(boilPoint(20), 58.9, 1.0), `解析：20 kPa → ${f(boilPoint(20), 3)} ℃（文献约 60 ℃）`);
  let mono = true, prev = -Infinity;
  for (let P = 20; P <= 200.001; P += 5) { const b = boilPoint(P); if (b <= prev) mono = false; prev = b; }
  ok(mono, '解析：压强 20 → 200 kPa 扫描，沸点严格单调上升');

  const boiler = create('boiler', 0, 0);
  boiler.setProp('lit', true);
  boiler.setProp('power', 800);
  const dt = 1 / 120;
  let frames = 0;
  while (boiler.state.waterT < boiler.state.bp - 1e-6 && frames < 120 * 600) { boiler.step(dt); frames++; }
  ok(frames < 120 * 600 && near(boiler.state.waterT, boiler.state.bp, 1e-6),
    `引擎：水浴被加热到沸点 ${f(boiler.state.bp, 3)} ℃ 后停住（用时 ${f(frames * dt, 1)} s）`);
  const steamAt = boiler.state.steam;
  for (let i = 0; i < 120 * 20; i++) boiler.step(dt);
  ok(near(boiler.state.waterT, boiler.state.bp, 1e-6) && boiler.state.steam > steamAt,
    `继续加热 20 s：温度仍是 ${f(boiler.state.waterT, 4)} ℃（沸腾平台），` +
    `多余热量全部转为汽化 ${f(boiler.state.steam - steamAt, 1)} g`);
  boiler.setProp('pressure', 47.4);
  boiler.step(dt);
  ok(near(boiler.state.waterT, boiler.state.bp, 1e-6) && boiler.state.boiling,
    `降压到 47.4 kPa：沸点降到 ${f(boiler.state.bp, 2)} ℃，水温一个步长内闪蒸到 ${f(boiler.state.waterT, 2)} ℃ 并沸腾`);

  const sim = build({ entities: [] });
  const { hp } = above(sim, 'boiler', { lit: true, power: 800, pressure: 101.325 });
  const beaker = create('beaker', hp.x, hp.y);
  beaker.vessel.coolK = 0;
  beaker.vessel.addLiquid('H2O', 200);
  sim.world.add(beaker, true); sim.ents.push(beaker);
  run(sim, 10);
  const dTe = beaker.vessel.temp - 25;
  ok(rel(dTe, tempRise(8000, 200)) < 0.01,
    `水浴经总线加热上方化学烧杯：10 s 升温 ${f(dTe, 4)} ℃ vs 理论 Q/(mc) = ${f(tempRise(8000, 200), 4)} ℃` +
    `（相对误差 ${f(rel(dTe, tempRise(8000, 200)) * 100, 3)}%）`);
}

// ══════════════════════════════════════════════════════════
head('⑦ 中和热：热学 ↔ 化学 的完整数字链');
{
  const Qth = reactionHeat(-57.3, 0.05);
  ok(near(Qth, 2865, 1e-9), `理论放热 Q = |ΔH|·n = 57.3 kJ/mol × 0.05 mol = ${Qth} J（dH 取自 reactions.js:91）`);

  const sim = build({ entities: [
    { type: 'calorimeter', x: 400, y: 300, props: { mHot: 0, mCold: 0, calEq: 0, coolK: 0, sealed: false } },
    { type: 'thermometer', x: 400, y: 300 },
  ] });
  const cal = byType(sim, 'calorimeter')[0];
  const th = byType(sim, 'thermometer')[0];
  run(sim, 0.5);
  ok(cal.vessel.volume === 0, `先把量热器倒空（volume = ${cal.vessel.volume} mL）`);

  cal.vessel.addLiquid('HCl', 50);
  cal.vessel.addLiquid('NaOH', 50);
  const m0 = cal.vessel.totalMass();
  ok(near(cal.vessel.amount('HCl'), 0.05, 1e-9) && near(cal.vessel.amount('NaOH'), 0.05, 1e-9),
    `倒入 50 + 50 mL 1 mol/L → 各 ${f(cal.vessel.amount('HCl'), 4)} mol（= 理论 n）`);
  ok(near(cal.vessel.temp, 25, 1e-9), `反应前温度 ${f(cal.vessel.temp, 2)} ℃`);

  const run2 = (sec) => { for (let i = 0, n = Math.round(sec * 120); i < n; i++) sim.world.step(dt0); };
  const dt0 = 1 / 120;
  run2(30);
  const dT = cal.vessel.temp - 25;
  const Qmeas = m0 * C_WATER * dT;
  ok(cal.vessel.amount('NaOH') < 1e-3,
    `反应基本完成：剩余 NaOH ${cal.vessel.amount('NaOH').toExponential(2)} mol、HCl ${cal.vessel.amount('HCl').toExponential(2)} mol` +
    `（速率对浓度是一级，只能渐近到 0）`);
  ok(cal.vessel.amount('NaCl') > 0.049, `生成 NaCl ${f(cal.vessel.amount('NaCl'), 4)} mol（≥ 98% 转化）`);
  ok(rel(Qmeas, Qth) < 0.01,
    `数字链：ΔT = ${f(dT, 4)} ℃ → Q_测 = m₀·c·ΔT = ${f(m0, 2)} g × ${C_WATER} × ${f(dT, 4)} = ${f(Qmeas, 1)} J ` +
    `vs 理论 ${Qth} J（相对误差 ${f(rel(Qmeas, Qth) * 100, 3)}%）`);
  ok(near(th.state.temp, cal.vessel.temp, 0.05),
    `温度计读数 ${f(th.state.temp, 4)} ℃ ≈ 量热器内容物温度 ${f(cal.vessel.temp, 4)} ℃` +
    `（差 ${f(Math.abs(th.state.temp - cal.vessel.temp), 4)} ℃ = 一帧写入时序，总线把两端接起来，没有新写一条链路）`);
  ok(rel(cal.vessel.totalMass(), m0) < 0.01,
    `质量账本：反应后 totalMass = ${f(cal.vessel.totalMass(), 2)} g vs 反应前 ${f(m0, 2)} g` +
    `（引擎不把中和生成的水计入质量，漂移 ${f(rel(cal.vessel.totalMass(), m0) * 100, 2)}%，容差由此而来）`);

  // 对照：带默认散热系数时，做「散热修正」后仍然对得上
  const sim2 = build({ entities: [{ type: 'calorimeter', x: 400, y: 300, props: { mHot: 0, mCold: 0, calEq: 0, sealed: false } }] });
  const cal2 = byType(sim2, 'calorimeter')[0];
  run(sim2, 0.5);
  cal2.vessel.addLiquid('HCl', 50);
  cal2.vessel.addLiquid('NaOH', 50);
  const m2 = cal2.vessel.totalMass();
  let loss = 0;
  for (let i = 0; i < 30 * 120; i++) {
    loss += cal2.vessel.coolK * (cal2.vessel.temp - 25) * dt0;      // ∫散热 dt
    sim2.world.step(dt0);
  }
  const raw = m2 * C_WATER * (cal2.vessel.temp - 25);
  const corrected = raw + loss;
  ok(rel(corrected, Qth) < 0.015,
    `带散热对照：未修正 m·c·ΔT = ${f(raw, 1)} J（偏低 ${f((1 - raw / Qth) * 100, 2)}%）；` +
    `加上 ∫散热 ${f(loss, 1)} J 修正后 ${f(corrected, 1)} J vs 理论 ${Qth} J（误差 ${f(rel(corrected, Qth) * 100, 3)}%）`);
}

// ══════════════════════════════════════════════════════════
head('⑧ 化学容器被加热后反应速率跟着变（reactions.js 的温度依赖）');
{
  const extentAt = (T) => {
    const sim = build({ entities: [{ type: 'beaker', x: 400, y: 300 }] });
    const b = byType(sim, 'beaker')[0];
    b.vessel.capacity = 500;
    b.vessel.addLiquid('NaHCO3', 200);
    b.vessel.addLiquid('HCl', 100);
    b.vessel.coolK = 0;
    for (let i = 0; i < 6; i++) {           // 0.05 s（反应量 < 1%，浓度几乎没变）
      b.vessel.temp = T;                    // 钉住温度，单独看速率对温度的依赖
      sim.world.step(1 / 120);
    }
    return 0.1 - b.vessel.amount('HCl');
  };
  const e25 = extentAt(25), e45 = extentAt(45);
  const ratio = e45 / e25;
  ok(e25 > 0 && near(ratio, 4, 0.25),
    `同一反应 25 ℃ / 45 ℃ 的 0.05 s 反应量比 e₄₅/e₂₅ = ${f(ratio, 3)}` +
    `（reactions.js:216 的温度因子 2^((T−25)/10) 给出 4）`);
}

// ══════════════════════════════════════════════════════════
head('⑨ 热膨胀球环：ΔL = αLΔT 与临界温度');
{
  const a = 16.5e-6, d0 = 49.6, D = 50;
  ok(near(expandLen(d0, a, 100), d0 * (1 + a * 100), 1e-12),
    `解析：25 → 125 ℃ 直径 ${f(expandLen(d0, a, 100), 5)} mm（+${f(expandLen(d0, a, 100) - d0, 5)} mm）`);
  const Tc = passTemp(d0, D, a, 25);
  ok(near(Tc, 25 + (D / d0 - 1) / a, 1e-12), `解析：临界温度 T_c = 25 + (D/d₀−1)/α = ${f(Tc, 2)} ℃`);

  let Ln = d0;
  const N = 5000, step = (Tc - 25) / N;
  for (let i = 0; i < N; i++) Ln += a * Ln * step;             // 数值积分 dL = αL dT
  ok(rel(Ln, expandLen(d0, a, Tc - 25)) < 1e-3,
    `数值积分 ${f(Ln, 5)} mm vs 解析 ${f(expandLen(d0, a, Tc - 25), 5)} mm` +
    `（偏差 ${f(rel(Ln, expandLen(d0, a, Tc - 25)) * 100, 4)}%）`);

  const ball = create('expansionball', 0, 0);
  ball.step();
  ok(ball.state.pass === true,
    `25 ℃ 时球径 ${f(ball.state.d, 4)} mm ≤ 环 ${D} mm → 过得去（室温下本来就刚好能过）`);
  ball.setProp('T', Tc - 5); ball.step();
  ok(ball.state.pass === true,
    `T = ${f(Tc - 5, 1)} ℃（临界 −5）→ 仍过得去：球径 ${f(ball.state.d, 5)} mm`);
  ball.setProp('T', Tc); ball.step();
  ok(ball.state.pass === true,
    `T = ${f(Tc, 1)} ℃（正好临界）→ 刚好还能过：球径 ${f(ball.state.d, 6)} mm == 环 ${D} mm`);
  ball.setProp('T', Tc + 5); ball.step();
  ok(ball.state.pass === false,
    `T = ${f(Tc + 5, 1)} ℃（临界 +5）→ 卡住：球径 ${f(ball.state.d, 5)} mm > 环 ${D} mm`);
  ball.setProp('T', 600); ball.step();
  ok(ball.state.pass === false && near(ball.state.Tc, Tc, 1e-9),
    `T = 600 ℃ → 卡住（球径 ${f(ball.state.d, 4)} mm），临界温度读数 ${f(ball.state.Tc, 2)} ℃`);
}

// ══════════════════════════════════════════════════════════
head('⑩ 查重：酒精灯 / 温度计 / 烧杯 是「用」不是「重造」');
{
  const mine = list().filter(d => d.cat === '热学').map(d => d.type);
  const existing = ['alcohollamp', 'thermometer', 'beaker', 'ironstand', 'testtube'];
  const dup = existing.filter(t => mine.includes(t));
  ok(dup.length === 0, `热学 6 件与既有器材零重名（既有：${existing.join(' / ')}）`);
  ok(list().filter(d => d.type === 'alcohollamp').length === 1
    && list().filter(d => d.type === 'thermometer').length === 1
    && list().filter(d => d.type === 'beaker').length === 1,
    '酒精灯 / 温度计 / 烧杯 各只有 1 个定义（来自 heating.js / lab.js / glassware.js）');

  // 同一杯水、同一个位置：酒精灯 300 W vs 加热板 600 W → 温升应当正好差一倍
  const heatWith = (type, power) => {
    const sim = build({ entities: [] });
    const props = { lit: true, power };
    const { hp } = above(sim, type, props);
    const beaker = create('beaker', hp.x, hp.y);
    beaker.vessel.capacity = 250;
    beaker.vessel.coolK = 0;
    beaker.vessel.addLiquid('H2O', 200);
    sim.world.add(beaker, true); sim.ents.push(beaker);
    run(sim, 10);
    return beaker.vessel.temp - 25;
  };
  const dLamp = heatWith('alcohollamp', 300);
  const dPlate = heatWith('hotplate', 600);
  ok(near(dPlate / dLamp, 2, 0.05),
    `既有酒精灯 300 W 升温 ${f(dLamp, 3)} ℃，本任务加热板 600 W 升温 ${f(dPlate, 3)} ℃：` +
    `比值 ${f(dPlate / dLamp, 4)}（同一条总线，功率线性）`);
}

// ══════════════════════════════════════════════════════════
head('⑪ 渲染冒烟：6 件器材在待机/工作两种状态下各画一帧');
{
  const g = mockCtx();
  for (const d of list().filter(x => x.cat === '热学')) {
    try {
      const e = create(d.type, 100, 100);
      e.render(g);                              // 先 render：与 check.mjs §⑩ 的顺序一致
      e.step(1 / 120, { time: 0 });
      e.render(g);
      for (const fd of (d.fields || [])) if (fd.type === 'checkbox') e.setProp(fd.k, true);
      if (d.defaults && 'power' in d.defaults) e.setProp('power', d.defaults.power);
      e.step(1 / 120, { time: 0 });
      e.render(g);
      ok(true, `${d.type}（${d.name}）两帧渲染无异常`);
    } catch (err) {
      ok(false, `${d.type} 渲染抛错：${err && err.message}`);
    }
  }
  const bar = create('conductionbar', 0, 0);
  bar.step(1 / 120, { time: 0 });
  ok(Array.isArray(bar.state.T) && bar.state.T.length === bar.props.nodes,
    `热传导棒节点数组独立于 def.state（避免器材之间共享同一个数组）：${bar.state.T.length} 个节点`);
}

// ══════════════════════════════════════════════════════════
head('⑫ 空世界 + 构造后立刻 render（复刻 tools/check.mjs §⑩ 的调用顺序）');
{
  // check.mjs:387-402 的顺序是「create(空世界、无热源、无参数) → render → step」，
  // 而 ⑪ 走的是「step → render」。两条路径不一致，于是 expansionball 在第一次 step
  // 之前 state.T 还是 undefined、render 里 .toFixed() 直接抛 —— ⑪ 是假绿灯。
  // 下面这条断言复刻真实顺序：任何「render 依赖 step 跑过」的改动都会让它变红。
  const world = new World();
  const ctx = mockCtx();
  for (const d of list().filter(x => x.cat === '热学')) {
    const e = create(d.type, 200, 200);
    let err = null;
    if (!e) err = 'create 返回空';
    else {
      world.add(e, true);
      try { e.render(ctx, world); } catch (ex) { err = 'render: ' + ex.message; }
      if (!err) { try { e.step(1 / 120, world); } catch (ex) { err = 'step: ' + ex.message; } }
    }
    ok(!err, `${d.type}：空世界 + 先 render 后 step 不抛异常${err ? '（' + err + '）' : ''}`);
  }

  // 派生字段必须在构造期就可用，render 不得依赖 step 是否跑过
  const fresh = create('expansionball', 200, 200);
  const miss = ['T', 'd', 'Tc'].filter(k => typeof fresh.state[k] !== 'number');
  ok(miss.length === 0,
    `expansionball 构造后 state.T / d / Tc 立即可用（缺失：${miss.join(',') || '无'}）`);

  // render 必须可重入，且不得反过来改状态（否则同一帧画两次会漂移）
  const before = JSON.stringify(fresh.state);
  let threw = null;
  try { fresh.render(ctx, world); fresh.render(ctx, world); fresh.render(ctx, world); } catch (ex) { threw = ex.message; }
  ok(!threw && JSON.stringify(fresh.state) === before,
    `连续 render 3 次：不抛异常、state 不被改写（${threw || 'ok'}，state ${JSON.stringify(fresh.state) === before ? '未变' : '被改了'}）`);
}

// ══════════════════════════════════════════════════════════
console.log(`\n${'─'.repeat(56)}`);
if (fail === 0) console.log(`\x1b[32m全部通过：${pass} 项\x1b[0m`);
else console.log(`\x1b[31m通过 ${pass} 项，失败 ${fail} 项\x1b[0m`);
process.exit(fail === 0 ? 0 : 1);
