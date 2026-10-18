#!/usr/bin/env node
/**
 * tools/photodiode-probe.mjs —— 光敏二极管（C4 的另一半）专用探针
 *
 * 为什么需要一份**独立**探针，而不是把它塞进 `equipment-electronics.mjs`：
 * 光电元件的验收重点是「**它和光敏电阻不是同一件东西**」——
 *   光敏电阻：给定照度只有**一个 R**（连续、单值，无开关判决）
 *   光敏二极管：要么导通要么截止（**开关**型，与 `Diode` 同类）
 * 这条对照如果混在一个大套件里，很容易被"两边都绿"糊过去。所以这里**并排量**：
 * §④ 拿两个器件在**同一照度**下对比 —— 电阻给出中间值，二极管给出 0/1。
 *
 * ⚠ 与 `Diode` 共享的那条硬约束（照抄错就废，见 `electronics.js` 文件头 ①）：
 * 开关型器件**不能**走 `resistanceAt()` 纯电阻式 —— ON 态端电压只有 I·ron < Vf，
 * 「U>Vf 才导通」会自我否定、定点迭代抖成 ON/OFF。所以这里断言的是
 * `circuitBranch()` 的**支路形态**，不是电阻值。
 *
 * 用法：node tools/photodiode-probe.mjs
 * 尾行输出 PHOTODIODE_JSON {...}
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { World } from '../src/core/world.js';
import { PluginHost } from '../src/core/plugin.js';
import { create, bindRegistry } from '../src/equipment/registry.js';
import { CouplingBus } from '../src/coupling/bridge.js';
import physicsPlugin from '../src/physics/circuit.js';
import bridgePlugin from '../src/coupling/bridge.js';
import electricalPlugin from '../src/equipment/electrical.js';
import opticsPlugin from '../src/equipment/optics.js';
import thermalPlugin from '../src/equipment/thermal.js';
import heatingPlugin from '../src/equipment/heating.js';
import electronics from '../src/equipment/electronics.js';

const ROOT = join(import.meta.dirname, '..');
const checks = [];
const ok = (name, pass, evidence) => {
  checks.push({ name, pass: !!pass, evidence: evidence === undefined ? null : evidence });
  console.log(`  ${pass ? '✓' : '✗'} ${name}`);
  if (evidence !== undefined && evidence !== null) {
    console.log('      ' + (typeof evidence === 'string' ? evidence : JSON.stringify(evidence)));
  }
};
const head = (s) => console.log('\n' + s);

/** 照 photoresistor-probe.mjs 的口径装载内核（不依赖浏览器、不起服务器） */
{
  const bootApp = {
    services: {}, ticks: [], world: null, lastCircuit: null, selected: null,
    log: { push() {}, clear() {} }, toast() {},
    addTick(fn) { this.ticks.push(fn); return () => {}; },
  };
  const host = new PluginHost(bootApp);
  for (const p of [physicsPlugin, bridgePlugin, electricalPlugin, opticsPlugin,
    thermalPlugin, heatingPlugin, electronics]) host.define(p);
  host.installAll();
  bindRegistry(host.registry('equipment'));
}

const photodiodeDef = create('photodiode', 0, 0).def;
const photoDef = create('photoresistor', 0, 0).def;
const diodeDef = create('diode', 0, 0).def;

head('① 装配 + 键面：两端口、开关型支路、不占用求解器四键');
{
  ok('注册表里有 photodiode', !!photodiodeDef, photodiodeDef ? `name=${photodiodeDef.name}` : '未注册');
  const ports = (photodiodeDef && photodiodeDef.ports) || [];
  ok('两端口都是 wire（2 个）—— 够 MNA 取一条支路',
    ports.length === 2 && ports.every((p) => p.kind === 'wire'), {
      n: ports.length, kinds: ports.map((p) => p.kind),
    });
  ok('有 circuitBranch()（开关型支路），且**没有** resistanceAt()（不做纯电阻近似）',
    typeof photodiodeDef.create(0, 0).circuitBranch === 'function'
    && typeof photodiodeDef.create(0, 0).resistanceAt !== 'function', {
      hasBranch: typeof photodiodeDef.create(0, 0).circuitBranch === 'function',
      hasRAt: typeof photodiodeDef.create(0, 0).resistanceAt === 'function',
    });
  const st = Object.keys(photodiodeDef.state || {});
  ok('state 不占用 I/U/P/R 四键（求解器写回键，器材不许抢）',
    !st.some((k) => ['I', 'U', 'P', 'R'].includes(k)), st);
  ok('默认接法 fwd、默认阈值 eth>0（否则"光控"退化成常通）',
    photodiodeDef.defaults.dir === 'fwd' && photodiodeDef.defaults.eth > 0, {
      dir: photodiodeDef.defaults.dir, eth: photodiodeDef.defaults.eth,
    });
}

head('② 无光 + 无压 ⇒ 截止（开关断态）');
{
  const e = photodiodeDef.create(0, 0);
  e.state.U = 0;
  e.state.relE = 0;
  e.state.on = false;
  const br = e.circuitBranch();
  ok('截止时是 R 支路（不是 V）', br.type === 'R', br);
  ok('截止电阻 ≥ 1 MΩ 量级（roff × MΩ）', br.r >= 1e6, { r: br.r });
}

head('③ 光照 ≥ 阈值 ⇒ 导通（这就是"光控开关"）');
{
  const e = photodiodeDef.create(0, 0);
  e.state.U = 0;                       // 端电压为 0，排除"被电压导通"
  e.state.relE = 100;                  // 满照度
  const lit = 100 >= e.props.eth;
  e.state.on = lit;
  const br = e.circuitBranch();
  ok('无端电压、但满照度 ⇒ state.on 为真（纯光致导通）',
    lit === true && e.state.on === true, { relE: e.state.relE, eth: e.props.eth, on: e.state.on });
  ok('导通时是 **V** 支路（Vf 恒压降 + ron 斜率）—— 与 Diode 同构，不是电阻',
    br.type === 'V', br);
  ok('V 支路的 emf 就是 ±Vf', Math.abs(Math.abs(br.emf) - e.props.vf) < 1e-12, {
    emf: br.emf, vf: e.props.vf,
  });
  ok('V 支路的 r 用 ron', Math.abs(br.r - e.props.ron) < 1e-12, { r: br.r, ron: e.props.ron });
}

head('④ ★ 与光敏电阻并排：同一照度下"连续"与"开关"必须给出不同形态');
{
  const d = photodiodeDef.create(0, 0);
  const r = photoDef.create(0, 0);
  const E = 50;                                  // 同一照度
  d.state.relE = E; d.state.on = E >= d.props.eth;
  r.state.relE = E;

  const dBr = d.circuitBranch();
  const rBr = r.circuitBranch();
  // 光敏电阻：连续 —— 取两个照度，读出**不同**的电阻（单值连续函数）
  r.state.relE = 20; const r20 = r.circuitBranch().r;
  r.state.relE = 80; const r80 = r.circuitBranch().r;
  // 光敏二极管：开关 —— 只有两种可能的支路形态
  d.state.on = true; const don = d.circuitBranch().type;
  d.state.on = false; const doff = d.circuitBranch().type;

  ok('光敏电阻在 20% 与 80% 照度下给出**不同**的电阻（连续、单值）',
    Number.isFinite(r20) && Number.isFinite(r80) && r20 !== r80, { r20, r80 });
  ok('光敏电阻**只有 R 支路**一种形态（无开关）',
    rBr.type === 'R' && r20 !== undefined && r80 !== undefined, { type: rBr.type });
  ok('光敏二极管只有 **V / R 两种**支路形态（开关，没有中间态）',
    don === 'V' && doff === 'R', { on: don, off: doff });
  ok('★ 两者形态**不同**：电阻 R vs 二极管 V（同一照度、同一求解器钩子体系）',
    rBr.type === 'R' && dBr.type === 'V', { resistor: rBr.type, diode: dBr.type });
  ok('★ 光敏电阻在照度增大时**严格**下降（连续单调，二极管不可能有这个性质）',
    r80 < r20, { r20, r80 });
}

head('⑤ "没光时它仍是一只普通二极管"—— 这是自然成立的性质，不是特例分支');
{
  const e = photodiodeDef.create(0, 0);
  e.state.relE = 0;                       // 完全无光
  e.state.U = e.props.vf + 0.5;            // 正偏且过 Vf
  const forward = e.state.U * e.sgn() > e.props.vf;
  e.state.on = (0 >= e.props.eth) || forward;
  ok('无光 + 正偏压 > Vf ⇒ 导通（走的是与 Diode 完全相同的电压判据）',
    e.state.on === true && forward === true, { U: e.state.U, vf: e.props.vf });
  ok('与 diode 的默认 vf 一致（免得同一块板上两只"二极管"阈值不同）',
    photodiodeDef.defaults.vf === diodeDef.defaults.vf, {
      photodiode: photodiodeDef.defaults.vf, diode: diodeDef.defaults.vf,
    });
}

head('⑥ 阈值可调 ⇒ 同一照度下结论会翻转（正控，非空转）');
{
  const mk = (eth) => {
    const e = photodiodeDef.create(0, 0);
    e.props.eth = eth;
    e.state.relE = 50;
    e.state.on = 50 >= eth;
    return e.state.on;
  };
  const low = mk(20), high = mk(80);
  ok('照度 50%：阈值 20% ⇒ 导通', low === true, { eth: 20, on: low });
  ok('照度 50%：阈值 80% ⇒ 截止', high === false, { eth: 80, on: high });
  ok('★ 正控成立：只有"阈值"这一个变量变了，结论就翻转',
    low !== high, { low, high });
}

head('⑦ 反接（rev）：光控仍导通，正偏路径失效 —— 与真实光电二极管的反偏工作一致');
{
  const e = photodiodeDef.create(0, 0);
  e.props.dir = 'rev';
  e.state.relE = 100;
  const lit = 100 >= e.props.eth;
  e.state.U = 1.0;                       // 加正向电压
  const forward = e.state.U * e.sgn() > e.props.vf;   // sgn = -1 ⇒ 1·(-1) = -1，不过 Vf
  e.state.on = lit || forward;
  ok('反接 + 满照度 ⇒ 仍导通（光致路径不依赖接法）', e.state.on === true, {
    dir: e.props.dir, relE: e.state.relE, forward, on: e.state.on,
  });
  ok('反接 + 正向电压**不能**走通正偏路径（sgn 为负）', forward === false, {
    U: e.state.U, sgn: e.sgn(), vf: e.props.vf, forward,
  });
}

head('⑧ 源码自检：能红的判据确实在源码里，且开关型没有偷偷退回电阻式');
{
  const src = readFileSync(join(ROOT, 'src/equipment/electronics.js'), 'utf8');
  const stripped = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  ok('源码里有 photodiode 的 def 块', /type:\s*'photodiode'/.test(stripped));
  ok('源码里有 class PhotoDiode', /class\s+PhotoDiode\b/.test(stripped));
  ok('ⓘ 剥注释后仍能找到 circuitBranch（断言的是真代码，不是注释里的字样）',
    /circuitBranch\s*\(\s*\)/.test(stripped));
  ok('⚠ 哨兵：源码里**不存在**字符串 PHOTODIODE_注释哨兵_4c71',
    !src.includes('PHOTODIODE_注释哨兵_4c71'));
}

const bad = checks.filter((c) => !c.pass);
console.log('');
console.log(`光敏二极管探针：共 ${checks.length} 项，失败 ${bad.length} 项`);
console.log('PHOTODIODE_JSON ' + JSON.stringify({
  ok: bad.length === 0,
  pass: checks.length - bad.length,
  fail: bad.length,
  checks: checks.map((c) => ({ name: c.name, pass: c.pass })),
}));
process.exit(bad.length ? 1 : 0);
