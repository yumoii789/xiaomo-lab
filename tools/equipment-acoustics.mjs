// ══════════════════════════════════════════════════════════
// 无头验证：声学 4 件（音叉 / 共鸣管 / 分贝计 / 波形显示）
//
//   node tools/equipment-acoustics.mjs
//
// 四件器材都不出声、也不进电路：声波是**解析波形**在画布上的光栅（栅格步长远细于
// 引擎的 1/120 s 定步长，所以不采样、不混叠）。本文件证明：
//   ① v = fλ、拍频 |f₂−f₁|、L = nλ/2（开管）/ nλ/4（闭管）三条关系都**量得出来**
//   ② 每个读数都有两条独立路径（解析式 ↔ 从栅格测量）
//   ③ 源码里没有任何音频 API、也没有自起的 rAF/定时器（静态扫描，见 §0）
// ══════════════════════════════════════════════════════════

import { readFileSync } from 'node:fs';
import { World } from '../src/core/world.js';
import { PluginHost } from '../src/core/plugin.js';
import { create, bindRegistry } from '../src/equipment/registry.js';
import acousticsPlugin, * as A from '../src/equipment/acoustics.js';
import electricalPlugin from '../src/equipment/electrical.js';

const bootApp = {
  services: {}, ticks: [], world: null, lastCircuit: null, selected: null,
  log: { push() {}, clear() {} }, toast() {},
  addTick(fn) { this.ticks.push(fn); return () => {}; },
};
const host = new PluginHost(bootApp);
host.define(electricalPlugin);
host.define(acousticsPlugin);
host.installAll();
bindRegistry(host.registry('equipment'));

let pass = 0, fail = 0;
const ok = (cond, msg) => {
  if (cond) { pass++; console.log('  \x1b[32m✓\x1b[0m ' + msg); }
  else { fail++; console.log('  \x1b[31m✗\x1b[0m ' + msg); }
};
const head = (t) => console.log('\n\x1b[36m' + t + '\x1b[0m');
const info = (t) => console.log('    \x1b[90m' + t + '\x1b[0m');
const near = (a, b, tolRel) => Math.abs(a - b) <= tolRel * Math.max(1e-12, Math.abs(b));
const pct = (a, b) => (100 * Math.abs(a - b) / Math.max(1e-12, Math.abs(b))).toFixed(3) + '%';

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
const CTX = mockCtx();
const DT = 1 / 120;

function build(list) {
  const world = new World();
  const raw = world.step.bind(world);
  const ents = [];
  for (const o of list) {
    const e = create(o.type, o.x, o.y);
    if (!e) { console.log('  !! 无法创建器材: ' + o.type); continue; }
    if (o.props) for (const k of Object.keys(o.props)) e.setProp(k, o.props[k]);
    world.add(e, true);
    ents.push(e);
  }
  return {
    world, ents, get: (i) => ents[i],
    run(sec) { for (let i = 0, n = Math.round(sec / DT); i < n; i++) raw(evDT); },
  };
}
const evDT = DT;

// ══════════════════════════════════════════════════════════
head('§0 注册、形状，以及「不出声 / 不采样 / 不进电路」的静态证据');
// ══════════════════════════════════════════════════════════
const MINE = ['tuningfork', 'resonancetube', 'soundlevel', 'waveform'];
const DEFS = host.registry('equipment').list();
const byType = new Map(DEFS.map(d => [d.type, d]));
ok(MINE.every(t => byType.has(t)), `4 件全部注册：${MINE.join(' / ')}`);
for (const t of MINE) {
  const d = byType.get(t);
  const need = ['type', 'name', 'domain', 'cat', 'icon', 'desc', 'w', 'h', 'ports', 'fields', 'defaults', 'state', 'tags', 'create'];
  const miss = need.filter(k => d[k] === undefined);
  ok(miss.length === 0, `${t}：定义字段齐全${miss.length ? '（缺 ' + miss + '）' : ''}`);
  ok(d.domain === 'physics' && d.cat === '声学', `${t}：domain=physics、cat=声学`);
  ok(d.ports.length === 0, `${t}：0 个接线端口 —— 声学不进电路`);
  const bad = d.fields.filter(f => !f.k || !f.label || !f.type
    || (f.type === 'range' && !(isFinite(f.min) && isFinite(f.max)))
    || (f.type === 'select' && !(Array.isArray(f.options) && f.options.length)));
  ok(bad.length === 0, `${t}：${d.fields.length} 个字段自洽（range 有 min/max，select 有 options）`);
}
// 修 1：源码静态扫描 —— 没有任何发声/采样/自起定时器的能力
const SRC = readFileSync(new URL('../src/equipment/acoustics.js', import.meta.url), 'utf8');
const BANNED = ['AudioContext', 'new Audio', 'webkitAudioContext', 'AudioBuffer',
  'requestAnimationFrame', 'setInterval', 'setTimeout', 'createOscillator',
  '.play(', 'oscillator'];
const hitBanned = BANNED.filter(s => SRC.includes(s));
ok(hitBanned.length === 0, `源码零音频/零自起定时器 API：命中 [${hitBanned.join(', ') || '无'}]`);
ok(!/circuitBranch|resistanceAt|world\.connect/.test(SRC),
  '源码不碰电路：无 circuitBranch / resistanceAt / world.connect');
const evals = (SRC.match(/raster\(/g) || []).length;
ok(/function raster/.test(SRC) && evals >= 3,
  `声波一律走解析光栅 raster()（源码里 raster( 出现 ${evals} 次），不占用引擎步长`);

// ══════════════════════════════════════════════════════════
head('§1 v = fλ：声速、波长、共鸣长度互为逆运算');
// ══════════════════════════════════════════════════════════
ok(near(A.soundSpeed(0), 331.3, 1e-12) && near(A.soundSpeed(20), 343.42, 1e-9) && near(A.soundSpeed(25), 346.45, 1e-9),
  `v(T) = 331.3 + 0.606T：v(0)=${A.soundSpeed(0)}、v(20)=${A.soundSpeed(20).toFixed(2)}、v(25)=${A.soundSpeed(25).toFixed(2)} m/s`);
ok(A.soundSpeed(30) > A.soundSpeed(20), '温度升高声速变大（单调增）');
const lam = A.lambdaOf('open', 1, 0.4), lamC = A.lambdaOf('closed', 1, 0.4);
ok(near(lam, 0.8, 1e-12) && near(lamC, 1.6, 1e-12),
  `开管 L=nλ/2 → λ=${lam} m；闭管 L=nλ/4 → λ=${lamC} m（同一根 40 cm 管，闭管波长大一倍）`);
ok(near(A.resonanceLength('open', 1, lam), 0.4, 1e-12) && near(A.resonanceLength('closed', 1, lamC), 0.4, 1e-12),
  '共振长度 = 波长的逆运算：λ→L 回得来（0.400 m）');
const f0open = A.resonantFreq('open', 1, 0.4);
ok(near(A.speedFromResonance(f0open, lam), A.SPEED_20, 1e-9),
  `v = f·λ 闭环：f₀=${f0open.toFixed(2)} Hz × λ=${lam} m = ${A.speedFromResonance(f0open, lam).toFixed(2)} m/s = v(20℃)`);
ok(A.isAllowedMode('closed', 1) && A.isAllowedMode('closed', 3) && !A.isAllowedMode('closed', 2)
  && A.isAllowedMode('open', 2),
  '闭管只有奇数谐振（1、3 允许，2 不允许）；开管全允许');

// ══════════════════════════════════════════════════════════
head('§2 拍：Δf = |f₂−f₁|，包络周期 = 1/Δf（解析 ↔ 从栅格测量）');
// ══════════════════════════════════════════════════════════
ok(near(A.beatFrequency(440, 444), 4, 1e-12) && near(A.beatPeriod(440, 444), 0.25, 1e-12),
  'Δf = 4 Hz → T拍 = 0.25 s');
ok(!isFinite(A.beatPeriod(440, 440)), 'Δf = 0 时无拍（T拍 = ∞，不是 0）');
ok(near(A.beatEnvelope(0, 440, 444), 2, 1e-12) && Math.abs(A.beatEnvelope(0.125, 440, 444)) < 1e-9,
  `包络解析式 |2A·cos(πΔf·t)|：t=0 时 ${A.beatEnvelope(0, 440, 444).toFixed(6)}（同相叠加），t=0.125 时 ${A.beatEnvelope(0.125, 440, 444).toExponential(2)}（反相抵消）`);
const r4 = A.raster(A.beatWave(440, 444, 1), 0, 1.0, 20000);
const envT = A.measureEnvelopePeriod(r4.times, r4.values);
ok(near(envT, 0.25, 0.01),
  `从 20000 点栅格**测量**包络周期 = ${envT.toFixed(5)} s ↔ 解析 1/Δf = 0.25 s（偏差 ${pct(envT, 0.25)}）`);
// 说明为什么不能直接找 |v| 的局部极小：谷底里挤着载波零点
let naive = 0;
for (let i = 2; i < r4.values.length - 2; i++) if (Math.abs(r4.values[i]) < Math.abs(r4.values[i - 1]) && Math.abs(r4.values[i]) <= Math.abs(r4.values[i + 1])) naive++;
info(`若直接数 |v| 的局部极小会得到 ${naive} 个（谷底里全是载波零点），故实现改为「移动最大值取包络 + 阈值聚簇」`);
const r10 = A.raster(A.beatWave(1000, 1010, 1), 0, 1.0, 20000);
ok(near(A.measureEnvelopePeriod(r10.times, r10.values), 0.1, 0.01),
  `换一组 Δf=10 Hz：测量 ${A.measureEnvelopePeriod(r10.times, r10.values).toFixed(5)} s ↔ 0.1 s（偏差 ${pct(A.measureEnvelopePeriod(r10.times, r10.values), 0.1)}）`);

// ══════════════════════════════════════════════════════════
head('§3 共鸣管：共振长度、共振频率、洛伦兹响应峰值');
// ══════════════════════════════════════════════════════════
const Q = 40, f0 = 258.6;
ok(near(A.resonanceResponse(f0, f0, Q), 1, 1e-12), '响应在 f=f₀ 处为 1');
const half = f0 * (1 + 1 / (2 * Q));
ok(near(A.resonanceResponse(half, f0, Q), Math.SQRT1_2, 1e-9),
  `半功率点 f₀(1+1/2Q) = ${half.toFixed(2)} Hz 处响应 = ${A.resonanceResponse(half, f0, Q).toFixed(6)} = 1/√2`);
const pk = A.findResonancePeak(f0, Q, f0 * 0.6, f0 * 1.4);
ok(Math.abs(pk.f - f0) / f0 < 0.001,
  `扫描找峰：峰值落在 ${pk.f.toFixed(3)} Hz ↔ 解析 f₀ = ${f0} Hz（偏差 ${pct(pk.f, f0)}，扫描步长决定了这个量级）`);

// ══════════════════════════════════════════════════════════
head('§4 分贝计：I = P/(4πr²) ↔ L = Lw − 10lg(4πr²) 两条独立路径');
// ══════════════════════════════════════════════════════════
const P = A.powerFromLevel(90);
ok(near(P, 1e-3, 1e-12), `Lw=90 dB → P = I₀·10^(Lw/10) = ${P} W`);
const I1 = A.soundIntensity(P, 1);
ok(near(A.soundLevelDb(I1), A.levelAtRadius(90, 1), 1e-12),
  `数值路径 10lg(I/I₀) = ${A.soundLevelDb(I1).toFixed(6)} dB ↔ 解析路径 Lw−10lg(4π) = ${A.levelAtRadius(90, 1).toFixed(6)} dB`);
ok(near(A.levelAtRadius(90, 2), A.levelAtRadius(90, 1) - A.dbPerDoubling(), 1e-12),
  `距离加倍：${A.levelAtRadius(90, 1).toFixed(4)} → ${A.levelAtRadius(90, 2).toFixed(4)} dB，差 ${A.dbPerDoubling().toFixed(4)} dB = 10lg4`);
const rd = A.thresholdDistance(P);
ok(near(A.soundLevelDb(A.soundIntensity(P, rd)), 0, 1e-6),
  `听阈距离 ${rd.toFixed(1)} m 处声强级 = ${A.soundLevelDb(A.soundIntensity(P, rd)).toExponential(2)} dB ≈ 0`);
info(`I₀ = ${A.I0} W/m²（听阈）；Lw 与 L 都以它为基准，所以两条路径必须严丝合缝`);

// ══════════════════════════════════════════════════════════
head('§5 多普勒：靠近时频率升高，声源与观察者靠近的量值不同');
// ══════════════════════════════════════════════════════════
const v = 343;
const fSrc = A.doppler(440, v, 0, 30), fObs = A.doppler(440, v, 30, 0);
ok(fSrc > 440 && fObs > 440, `声源靠近 ${fSrc.toFixed(2)} Hz、观察者靠近 ${fObs.toFixed(2)} Hz，都高于 440 Hz`);
ok(near(fSrc, 440 * v / (v - 30), 1e-12) && near(fObs, 440 * (v + 30) / v, 1e-12),
  `两个方向量值不同（${fSrc.toFixed(2)} vs ${fObs.toFixed(2)} Hz）—— 声源靠近的分母 (v−v_s) 更强`);

// ══════════════════════════════════════════════════════════
head('§6 世界里实测：4 件器材的读数（都是从栅格/解析现算的）');
// ══════════════════════════════════════════════════════════
const S = build([
  { type: 'tuningfork', x: 100, y: 100, props: { f: 440 } },
  { type: 'tuningfork', x: 260, y: 100, props: { f: 444 } },
  { type: 'resonancetube', x: 500, y: 100 },
  { type: 'soundlevel', x: 700, y: 100 },
  { type: 'waveform', x: 900, y: 100 },
]);
S.run(1.0);
const fork = S.get(0), tube = S.get(2), db = S.get(3), wf = S.get(4);
ok(fork.state.fbeat === 4 && near(fork.state.Tbeat, 0.25, 1e-12),
  `音叉 A 找到 160 px 外的音叉 B（${fork.state.f1} Hz / ${fork.state.f2} Hz）→ 拍频 ${fork.state.fbeat} Hz、T拍 ${fork.state.Tbeat} s`);
ok(near(fork.state.envPeriodMeas, 0.25, 0.03),
  `音叉实测包络周期 = ${fork.state.envPeriodMeas.toFixed(5)} s ↔ 1/Δf = 0.25 s（偏差 ${pct(fork.state.envPeriodMeas, 0.25)}）—— 用窗口 ${fork.state.windowS.toFixed(3)} s 的栅格量出来的`);
S.get(1).setProp('f', 450);
S.run(0.2);
ok(fork.state.fbeat === 10 && near(fork.state.envPeriodMeas, 0.1, 0.03),
  `把 B 调到 450 Hz：Δf = ${fork.state.fbeat} Hz，实测包络周期 ${fork.state.envPeriodMeas.toFixed(5)} s ↔ 0.1 s`);
S.get(1).setProp('f', 440);
S.run(0.2);
ok(fork.state.fbeat === 0 && !isFinite(fork.state.envPeriodMeas),
  'B 调回 440 Hz：Δf = 0，包络周期为 ∞（不是 0，也不是 NaN）');

ok(near(tube.state.lambda, 1.328, 1e-9) && near(tube.state.f0, 258.6, 0.002),
  `共鸣管（闭管 n=1、L=33.2 cm）：λ = 4L/n = ${tube.state.lambda.toFixed(3)} m、f₀ = v/λ = ${tube.state.f0.toFixed(1)} Hz`);
ok(near(tube.state.vBack, A.SPEED_20, 1e-9),
  `反推声速 v = f₀·λ = ${tube.state.vBack.toFixed(2)} m/s ↔ v(20℃) = ${A.SPEED_20.toFixed(2)} m/s`);
ok(tube.state.dPeak < 0.005,
  `扫描出的共振峰与解析 f₀ 相对偏差 ${(tube.state.dPeak * 100).toFixed(4)}%（要求 <0.5%）`);
tube.setProp('n', 2);
S.run(0.1);
ok(A.isAllowedMode('closed', tube.state.nUsed),
  `闭管把 n=2 修正成 n=${tube.state.nUsed}（闭管只允许奇数谐振）`);

ok(near(db.state.L, db.state.LAnalytic, 1e-12),
  `分贝计两条路径一致：数值 ${db.state.L.toFixed(4)} dB = 解析 ${db.state.LAnalytic.toFixed(4)} dB（Lw=${db.props.Lw} dB、r=${db.props.r} m）`);
db.setProp('r', 2);
S.run(0.1);
ok(near(db.state.drop, 6.0206, 1e-3),
  `r 从 1 m 到 2 m：实测下降 ${db.state.drop.toFixed(4)} dB ↔ 10lg4 = 6.0206 dB`);

// 波形显示：三条路各验一次
wf.setProp('f1', 440); wf.setProp('a1', 1); wf.setProp('f2', 0); wf.setProp('a2', 0); wf.setProp('mode', 'sum');
S.run(0.2);
ok(near(wf.state.fMeas, 440, 0.01) && near(wf.state.fAuto, 440, 0.01),
  `单音 440 Hz：过零实测 ${wf.state.fMeas.toFixed(2)} Hz、自相关 ${wf.state.fAuto.toFixed(2)} Hz（偏差 ${pct(wf.state.fMeas, 440)} / ${pct(wf.state.fAuto, 440)}）`);
wf.setProp('f2', 1320); wf.setProp('a2', 0.5);
S.run(0.2);
ok(near(wf.state.fAuto, 440, 0.01) && near(wf.state.fMeas, 440, 0.02),
  `440 + 1320(三次谐波, A₂=0.5)：自相关 ${wf.state.fAuto.toFixed(2)} Hz、过零 ${wf.state.fMeas.toFixed(2)} Hz —— 自相关对含谐波的复合波形更稳`);
wf.setProp('f2', 444); wf.setProp('a2', 1); wf.setProp('mode', 'beat');
S.run(0.2);
ok(near(wf.state.fMeas, 442, 0.01) && wf.state.fAutoUsable === false,
  `拍模式（440+444）：过零测到的是**载波** f̄=(f₁+f₂)/2 = ${wf.state.fMeas.toFixed(2)} Hz；自相关标记为不可用（窗口 ${(wf.state.windowS * 1000).toFixed(0)} ms < 拍周期 ${wf.state.Tbeat} s）`);
ok(near(wf.state.fCarrier, 442, 1e-12) && wf.state.beat === 4,
  `载波解析值 f̄ = ${wf.state.fCarrier} Hz、拍频 ${wf.state.beat} Hz`);
wf.setProp('mode', 'standing');
S.run(0.2);
ok(wf.state.lambda > 0 && wf.state.envX && wf.state.envX.values.length > 10,
  `驻波模式：λ = ${wf.state.lambda.toFixed(4)} m，包络栅格 ${wf.state.envX.values.length} 点`);
ok(near(A.standingEnvelope(wf.state.lambda / 4, wf.state.lambda, 1), 2, 1e-9),
  `驻波包络 |2A·sin(kx)|：在 x=λ/4 处为 ${A.standingEnvelope(wf.state.lambda / 4, wf.state.lambda, 1).toFixed(4)}（腹点），x=0 处为 ${A.standingEnvelope(0, wf.state.lambda, 1)}（节点）`);

for (const e of S.ents) e.render(CTX);
ok(true, '4 件器材的 render() 在无头 Canvas 替身上全部跑通（无异常）');

// ══════════════════════════════════════════════════════════
head('§7 可单独启停：关掉本插件 → 4 件从注册表归零，再打开 → 4 件回来');
// ══════════════════════════════════════════════════════════
const mineCount = () => host.registry('equipment').list().filter(d => MINE.includes(d.type)).length;
ok(mineCount() === 4, `初始：注册表里本插件 ${mineCount()} 件`);
ok(host.disable('xiaomo.equipment.acoustics') === true, "disable('xiaomo.equipment.acoustics') 返回 true");
ok(mineCount() === 0, `停用后：本插件器材 ${mineCount()} 件（器材栏里会一起消失）`);
ok(host.registry('equipment').list().length === 10 && host.registry('equipment').has('battery') && host.registry('equipment').has('rheostat'),
  `停用**只影响本插件**：同装的 electrical.js 10 件仍在注册表里（当前 ${host.registry('equipment').list().length} 件）`);
ok(host.enable('xiaomo.equipment.acoustics') === true && mineCount() === 4,
  `重新启用后：本插件器材回到 ${mineCount()} 件（不翻倍、不残留）`);
const after = host.registry('equipment').list();
ok(new Set(after.map(d => d.type)).size === after.length, '启用后注册表里没有重复 type（拆除干净，不是叠加）');

// ══════════════════════════════════════════════════════════
console.log(`\n\x1b[1m全部通过：${pass} 项\x1b[0m` + (fail ? `  \x1b[31m失败 ${fail} 项\x1b[0m` : ''));
process.exit(fail ? 1 : 0);
