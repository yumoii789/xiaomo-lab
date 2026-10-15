// ══════════════════════════════════════════════════════════
// 无头验证：电子/信号器材的读数上屏（逐键闭环）+ 声学整域补标签表
//
//   node tools/inspector-stats-probe.mjs
//
// 为什么把改造前的 updateLive() **逐字冻结**在 oldRows() 里：本任务的两条主判据都需要一个
// 「改前」参照物 ——
//   ① 逐键闭环：某个键「改前不在面板上、改后必须在」，只有拿改造前的行算法当基准才说得清；
//   ② 红能力（D43/D47）：同一条断言对「去掉新增分支」的那版算法必须变红，否则断言是空的。
// 冻结副本不随源码演进而变，所以这两条判据在未来的每次提交里都还能重演。
//
// 绿：全部通过：N 项（exit 0）／红：合计 N 项，失败 M 项（exit 1）
// ══════════════════════════════════════════════════════════

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { World } from '../src/core/world.js';
import { PluginHost } from '../src/core/plugin.js';
import { create, list, bindRegistry, equipmentPlugins } from '../src/equipment/index.js';
import { CouplingBus } from '../src/coupling/bridge.js';
import { solveCircuit, fmtA, fmtV, fmtW, fmtR } from '../src/physics/circuit.js';
import { SP } from '../src/chemistry/species.js';
import { Inspector, LIVE_FALLBACK_MAX, STATE_LABELS, SIGNED_NA, BURNT_NA } from '../src/ui/inspector.js';

import physicsPlugin from '../src/physics/circuit.js';
import chemistryPlugin from '../src/chemistry/reactions.js';
import bridgePlugin from '../src/coupling/bridge.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => {
  if (cond) { pass++; console.log('  \x1b[32m✓\x1b[0m ' + msg); }
  else { fail++; console.log('  \x1b[31m✗\x1b[0m ' + msg); }
};
const head = (t) => console.log('\n\x1b[36m' + t + '\x1b[0m');
const info = (t) => console.log('    · ' + t);
const dump = (rows) => rows.map(([k, v]) => k + ' ' + v).join(' / ');

const mkEl = (tag) => ({
  tagName: tag, className: '', textContent: '', children: [], isFragment: false,
  appendChild(n) { this.children.push(n); return n; },
  addEventListener() {},
  replaceChildren(...ns) {
    const flat = [];
    for (const n of ns) {
      if (Array.isArray(n)) flat.push(...n);
      else if (n && n.isFragment) flat.push(...n.children);
      else if (n) flat.push(n);
    }
    this.children = flat;
  },
});
globalThis.document = {
  createElement: mkEl,
  createDocumentFragment: () => Object.assign(mkEl('#fragment'), { isFragment: true }),
};

const bootApp = {
  services: {}, ticks: [], world: null, lastCircuit: null, selected: null,
  log: { push() {}, clear() {} }, toast() {}, addTick(fn) { this.ticks.push(fn); return () => {}; },
};
const host = new PluginHost(bootApp);
for (const p of [physicsPlugin, chemistryPlugin, bridgePlugin, ...equipmentPlugins]) host.define(p);
host.installAll();
bindRegistry(host.registry('equipment'));
const ALL = list();
const appStub = { world: { get: () => null }, markDirty() {}, duplicate() {}, removeEntity() {} };

// ══════════════════════════════════════════════════════════
// 冻结基线：改造前 updateLive() 的逐字副本（含改造前的 STATE_LABELS —— **没有「声学」这张表**）
// ══════════════════════════════════════════════════════════
const OLD_LABELS = {
  力学: {
    t: ['时间', 's'], v: ['速度', 'm/s'], s: ['位移', 'm'], a: ['加速度', 'm/s²'], x: ['位置', 'm'],
    h: ['高度', 'm'], T: ['周期', 's'], E: ['机械能', 'J'], E0: ['初始机械能', 'J'], drift: ['能量漂移', '%'],
    p: ['动量', 'kg·m/s'], th: ['摆角', 'rad'], theta: ['转角', 'rad'], w: ['角速度', 'rad/s'],
    alpha: ['角加速度', 'rad/s²'], tau1: ['左力矩', 'N·m'], tau2: ['右力矩', 'N·m'], net: ['合力矩', 'N·m'],
    I: ['转动惯量', 'kg·m²'], N: ['正压力', 'N'], f: ['摩擦力', 'N'], fsMax: ['最大静摩擦', 'N'],
    weight: ['重量', 'N'], W: ['重物重量', 'N'], rope: ['放出绳长', 'm'], maxv: ['最大速度', 'm/s'],
    n: ['承重绳段数', ''], need: ['所需拉力', 'N'], eta: ['效率', ''], MA: ['机械利益', ''],
    collided: ['碰撞次数', ''], lifts: ['提升次数', ''],
  },
  热学: {
    t: ['加热时长', 's'], Q: ['吸放热', 'J'], surf: ['表面温度', '℃'], heatOut: ['散热功率', 'W'],
    Tf: ['末温', '℃'], T1: ['高温源', '℃'], T2: ['低温源', '℃'], flux: ['热流', 'W'],
    fluxBar: ['棒内热流', 'W'], mid: ['中点温度', '℃'], mIce: ['冰质量', 'g'], melted: ['已熔化', 'g'],
    Qlatent: ['熔化潜热', 'J'], waterT: ['水温', '℃'], steam: ['已汽化', 'g'], bp: ['沸点', '℃'],
    d: ['球径', 'mm'], dL: ['伸长量', 'mm'], Tc: ['当前温度', '℃'],
  },
  光学: {
    lambda: ['波长', 'nm'], thetaI: ['入射角', '°'], thetaR: ['反射角', '°'], thetaT: ['折射角', '°'],
    spread: ['谱宽', '°'],
  },
  通用: { temp: ['温度', '℃'], mass: ['质量', 'g'], pH: ['pH', ''] },
};
const OLD_HIDDEN = { 力学: ['tPrev'] };

function fmtLive(v) {
  const a = Math.abs(v);
  if (a >= 100) return v.toFixed(1);
  if (a >= 1) return v.toFixed(2);
  if (a > 0 && a < 1e-4) return v.toExponential(2);
  return v.toFixed(4);
}

/** 改造前 updateLive() 的读数行算法（逐字副本；此处没有电子类显式分支，也没有声学标签表） */
function oldRows(e) {
  const rows = [];
  const st = e.state || {};
  if (typeof st.I === 'number') rows.push(['电流 I', fmtA(st.I)]);
  if (typeof st.U === 'number') rows.push(['两端电压 U', fmtV(st.U)]);
  if (typeof st.P === 'number' && st.P > 1e-9) rows.push(['功率 P', fmtW(st.P)]);
  if (typeof st.R === 'number') rows.push(['等效电阻 R', fmtR(st.R)]);

  if (e.type === 'thermistor') {
    rows.push(['感知温度', (st.temp ?? 25).toFixed(1) + ' ℃']);
    rows.push(['温度来源', st.source || '室温']);
    const R = e.resistanceNow ? e.resistanceNow() : st.R;
    rows.push(['当前阻值', fmtR(R)]);
  }
  if (e.type === 'motor') {
    rows.push(['运转状态', st.on ? '转动中' : '停止']);
    rows.push(['转速', Math.round(st.omega || 0) + ' rad/s']);
  }
  if (e.type === 'balance') {
    rows.push(['秤上质量', (st.mass || 0).toFixed(2) + ' g']);
    if (st.onPlate) rows.push(['称量对象', st.onPlate]);
  }
  if (e.type === 'phmeter') rows.push(['测得 pH', (st.pH ?? 7).toFixed(2)]);
  if (e.type === 'phpaper') rows.push(['测得 pH', st.pH === undefined ? '未浸取' : st.pH.toFixed(1)]);
  if (e.type === 'thermometer') rows.push(['测得温度', (st.temp ?? 25).toFixed(2) + ' ℃']);
  if (e.type === 'alcohollamp') {
    rows.push(['状态', e.props.lit ? '燃烧中' : '未点燃']);
    if (st.target) rows.push(['加热对象', appStub.world.get(st.target)?.def.name || '-']);
  }
  if (e.type === 'electrode') {
    const m = e.props.metal;
    rows.push(['电极材料', m === 'graphite' ? '石墨（惰性）' : m]);
    rows.push(['标准电极电势', e.probe && e.probe.E0 !== null && e.probe.E0 !== undefined
      ? (e.probe.E0 > 0 ? '+' : '') + e.probe.E0.toFixed(2) + ' V' : '不参与原电池']);
  }

  if (e.vessel) {
    const v = e.vessel;
    rows.push(['液体体积', v.volume.toFixed(1) + ' / ' + v.capacity + ' mL']);
    rows.push(['温度', v.temp.toFixed(2) + ' ℃']);
    rows.push(['pH', v.pH().toFixed(2)]);
    if (v.ionConc() > 1e-6) {
      rows.push(['离子浓度', v.ionConc().toFixed(4) + ' mol/L']);
      rows.push(['电导率', v.conductivity().toFixed(3) + ' S/m']);
      const R = v.resistance();
      rows.push(['溶液电阻', isFinite(R) ? fmtR(R) : '∞（不导电）']);
    }
    if (v.hasElectrodes()) {
      rows.push(['插入电极', v.electrodes.length + ' 根']);
      rows.push(['通过电流', fmtA(v.electricCurrent || 0)]);
    }
    if (v.stir > 0.02) rows.push(['搅拌强度', v.stir.toFixed(2)]);
    if (v.gas.size) { for (const [id, q] of v.gas) rows.push([SP[id] ? SP[id].n : id, (q * 24000).toFixed(0) + ' mL']); }
    if (v.precip.size) { for (const [id, g] of v.precip) rows.push([SP[id] ? SP[id].n : id, g.toFixed(2) + ' g']); }
    if (v.solid.size) { for (const [id, g] of v.solid) rows.push([SP[id] ? SP[id].n : id, g.toFixed(2) + ' g']); }
    if (v.lastReaction) rows.push(['最近反应', v.lastReaction.eq]);
  }

  if (!rows.length) {
    const fields = (e.def && e.def.fields) || [];
    const cat = (e.def && e.def.cat) || '';
    const hidden = OLD_HIDDEN[cat] || [];
    const known = [], rest = [];
    for (const [k, v] of Object.entries(st)) {
      if (k.charCodeAt(0) === 95) continue;
      if (typeof v !== 'number' || !Number.isFinite(v)) continue;
      const fd = fields.find((x) => x.k === k);
      if (!fd && hidden.indexOf(k) >= 0) continue;
      const lb = (OLD_LABELS[cat] && OLD_LABELS[cat][k]) || OLD_LABELS.通用[k];
      const lab = fd ? [fd.label, fd.unit || ''] : lb;
      (lab ? known : rest).push([lab ? lab[0] : k, fmtLive(v), lab ? lab[1] || '' : '']);
    }
    const all = known.concat(rest);
    for (const [k, val, unit] of all) {
      if (rows.length >= LIVE_FALLBACK_MAX) {
        rows.push(['…', '还有 ' + (all.length - rows.length) + ' 项读数']);
        break;
      }
      rows.push([k, unit ? val + ' ' + unit : val]);
    }
  }
  if (!rows.length) rows.push(['状态', '无读数']);
  return rows;
}

function liveRows(e) {
  const ins = new Inspector(mkEl('div'), appStub);
  ins.ent = e; ins._live = mkEl('div');
  ins.updateLive();
  return readRows(ins._live);
}
function readRows(el) {
  const rows = [];
  for (let i = 0; i + 1 < el.children.length; i += 2) rows.push([el.children[i].textContent, el.children[i + 1].textContent]);
  return rows;
}
const SENTINEL = (rows) => rows.length === 1 && rows[0][0] === '状态' && rows[0][1] === '无读数';
const RAW_LABEL = /^[A-Za-z_][A-Za-z0-9_]*$/;
const has = (rows, label) => rows.some(([k]) => k === label);

console.log('\x1b[1m小墨实验室 · 读数上屏（电子逐键 + 声学标签表）无头验证\x1b[0m');

// ══════════════════════════════════════════════════════════
head('① 装配');
ok(ALL.length > 0, `注册表就绪：器材 ${ALL.length} 件`);
const phases = {};
for (const rec of host.list()) phases[rec.phase] = (phases[rec.phase] || 0) + 1;
ok((phases.failed || 0) === 0, `装载零失败：${JSON.stringify(phases)}`);

const world = new World();
const cb = new CouplingBus(world);
const rawStep = world.step.bind(world);
world.step = (dt) => { const br = cb.buildBranches(); cb.distribute(dt, solveCircuit(world, br)); rawStep(dt); };
const ents = [];
let createFail = 0;
ALL.forEach((d, i) => {
  let e = null;
  try { e = create(d.type, 120 + (i % 9) * 70, 120 + Math.floor(i / 9) * 70); } catch (err) { e = null; }
  if (!e) { createFail++; return; }
  world.add(e, true); ents.push(e);
});
for (let i = 0; i < 24; i++) world.step(1 / 120);
ok(createFail === 0 && ents.length === ALL.length, `场景装配：${ents.length} 件器材全部 create 成功并步进 0.2 s`);
const byType = (t) => ents.find((e) => e.type === t);

// ══════════════════════════════════════════════════════════
head('② 电子/信号 6 件器材：改造前「四键先凑满 ⇒ 兜底不执行」的处境（改前的原始行）');
const ELEC = ['resistorcap', 'inductorcoil', 'acsource', 'oscilloscope', 'transformer', 'diode'];
for (const t of ELEC) {
  const e = byType(t);
  if (!e) { ok(false, `${t} 不在注册表里`); continue; }
  const o = oldRows(e);
  info(`${t}（${e.name}） 改造前 [${dump(o)}]`);
}
{
  // D47：先证明「改前」这一侧真的是改造前的算法 —— 它对 6 件器材给出的行里，规范标签一个都没有。
  const prescribed = [];
  for (const t of ELEC) { const e = byType(t); if (e) for (const r of oldRows(e)) prescribed.push(t + '|' + r[0]); }
  const o = ELEC.map((t) => byType(t)).filter(Boolean).flatMap((e) => oldRows(e));
  ok(!o.some(([k]) => k === '有效电压 U_rms=Up/√2' || k === '电感电流 i_L' || k === '匝数比 N₁/N₂'),
    `D47 拦截生效：冻结副本对 6 件器材产出的 ${o.length} 行里，0 行带新增的规范标签（这版算法确实「改前」）`);
}

// ══════════════════════════════════════════════════════════
head('③ 逐键闭环：改造前不可见的键，改造后逐个必须有一行中文标签');
// [归属 type, state 键, 改造后应有的行标签]
const KEYS = [
  ['resistorcap', 'Uc', '电容电压 U_C'], ['resistorcap', 'i', '充电电流 i'],
  ['resistorcap', 'tau', '时间常数 τ=RC'], ['resistorcap', 'pct', '充电进度'],
  ['resistorcap', 't63', '实测 63.2% 用时'], ['resistorcap', 't', '计时 t'],
  ['resistorcap', 'tEnd', '积分窗长 3τ'], ['resistorcap', 'traj', '曲线采样点'],
  ['inductorcoil', 'iL', '电感电流 i_L'], ['inductorcoil', 'iSteady', '稳态电流 I=U/R'],
  ['inductorcoil', 'uL', '自感电压 u_L'], ['inductorcoil', 'spike', '断电自感尖峰'],
  ['inductorcoil', 'i0break', '断电瞬时电流 I₀'], ['inductorcoil', 'tauOpen', '断路时间常数'],
  ['inductorcoil', 'tau', '时间常数 τ=L/R'], ['inductorcoil', 'fromCircuit', '电压来源'],
  ['inductorcoil', 'breaking', '泄放状态'], ['inductorcoil', 't', '计时 t'],
  ['inductorcoil', 'traj', '曲线采样点'],
  ['acsource', 'Urms', '有效电压 U_rms=Up/√2'], ['acsource', 'rmsMeas', '实测有效值'],
  ['acsource', 'emf', '瞬时电动势 e(t)'], ['acsource', 'pp', '峰峰值'],
  ['acsource', 'T', '周期 T=1/f'], ['acsource', 't', '仿真时刻'],
  ['acsource', 'tLast', '上次采样时刻'], ['acsource', 'buf', '周期缓冲点数'],
  ['acsource', 'bufT', '缓冲时间轴点数'],
  ['oscilloscope', 'fMeas', '实测频率'], ['oscilloscope', 'fSrc', '源频率'],
  ['oscilloscope', 'UpSrc', '源峰值电压'], ['oscilloscope', 'pp', '峰峰值'],
  ['oscilloscope', 'rmsMeas', '实测有效值'], ['oscilloscope', 'T', '周期 T=1/f'],
  ['oscilloscope', 'n', '采样点数'], ['oscilloscope', 'df', '测频相对误差'],
  ['oscilloscope', 'firstCross', '首次上升过零'], ['oscilloscope', 'predCross', '解析预测过零'],
  ['oscilloscope', 'dPhase', '相位偏差'], ['oscilloscope', 'srcId', '信号源'],
  ['oscilloscope', 'srcName', '信号源名称'], ['oscilloscope', 'buf', '采样缓冲点数'],
  ['oscilloscope', 'bt', '采样时间轴点数'],
  ['transformer', 'U1', '一次电压 U₁'], ['transformer', 'U2', '二次电压 U₂'],
  ['transformer', 'I1', '一次电流 I₁'], ['transformer', 'I2', '二次电流 I₂'],
  ['transformer', 'P1', '一次功率 P₁'], ['transformer', 'P2', '二次功率 P₂'],
  ['transformer', 'eta', '效率 η'], ['transformer', 'ratio', '电压比 U₁/U₂'],
  ['transformer', 'nRatio', '匝数比 N₁/N₂'], ['transformer', 'srcId', '信号源'],
  ['diode', 'on', '导通状态'], ['diode', 'theta0', '导通角 θ₀'],
  ['diode', 'duty', '导通占空比（实测）'], ['diode', 'dutyTheory', '导通占空比（理论）'],
  ['diode', 'meanTheory', '可整流平均值'], ['diode', 'Up', '源峰值电压'],
  ['diode', 'vfEffect', '正向压降 Vf'], ['diode', 'buf', '导通采样点数'],
  ['diode', 'srcId', '信号源'],
];
const uniqKeys = [...new Set(KEYS.map((k) => k[1]))];
ok(uniqKeys.length === 51, `逐键清单覆盖 ${uniqKeys.length} 个不同的 state 键（目标 51）`);
ok(KEYS.length === 62, `${KEYS.length} 个「器材 × 键」位置（同名键在多件器材上各算一次）`);

// 键的归属用**源码里的写入点**判定（机械提取），而不是「此刻 state 里有没有」：
// i0break（开断瞬间才写） / predCross（出现过零点才写）这类键的写入被条件包着，探针场景里
// 还没物化 —— 但它们确实是这件器材的键，面板也照常给它们一行（0 或占位）。两件事分开报。
const equipDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'equipment');
const srcText = ['electronics.js', 'acoustics.js']
  .map((f) => readFileSync(join(equipDir, f), 'utf8')).join('\n');
const declared = new Set([
  ...[...srcText.matchAll(/state\.([A-Za-z_][A-Za-z0-9_]*)\s*=/g)].map((m) => m[1]),
  ...[...srcText.matchAll(/state:\s*\{([^}]*)\}/g)]
    .flatMap((m) => [...m[1].matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*:/g)].map((x) => x[1])),
]);
const missingKey = [], notBefore = [], notAfter = [], lazy = [];
for (const [t, k, label] of KEYS) {
  const e = byType(t);
  if (!e) { missingKey.push(`${t}.${k}`); continue; }
  if (!declared.has(k)) missingKey.push(`${t}.${k}（源码里找不到 state.${k} 的写入点）`);
  else if (!(k in (e.state || {}))) lazy.push(`${t}.${k}`);
  const o = oldRows(e), n = liveRows(e);
  if (has(o, label)) notBefore.push(`${t}.${k}→${label}：改前就已经有这行，闭环说不清是谁做的`);
  if (!has(n, label)) notAfter.push(`${t}.${k}→${label}`);
}
ok(missingKey.length === 0, `键归属核对：${KEYS.length} 个位置在源码里都有对应器材的写入点（对不上 ${missingKey.length} 个）`);
for (const s of missingKey.slice(0, 8)) info('对不上：' + s);
info(`惰性写入（写入点被条件包着，探针场景未触发，仍照常出行）：${lazy.length} 个 —— ${lazy.join(' / ') || '无'}`);
ok(notBefore.length === 0, `改前侧干净：${KEYS.length} 个位置里 0 个「改前已有该行」（有 1 个就说明闭环是假的）`);
for (const s of notBefore.slice(0, 5)) info(s);
ok(notAfter.length === 0, `改后侧闭合：${KEYS.length} 个位置全部上屏（缺失 ${notAfter.length} 个）`);
for (const s of notAfter.slice(0, 10)) console.log('    \x1b[31m✗ 改后仍不上屏：' + s + '\x1b[0m');
// 逐键点名：62 个「器材 × 键」位置（同名键在多件器材上各算一次）
for (const t of ELEC) {
  info(`${t}：` + KEYS.filter((x) => x[0] === t).map((x) => `${x[1]}→${x[2]}`).join('，'));
}

// ══════════════════════════════════════════════════════════
head('④ 上屏后的行必须由真源驱动（不是写死的标签）');
{
  const acs = byType('acsource');
  if (acs) {
    acs.state.rmsMeas = 0.123456;
    ok(liveRows(acs).some(([k, v]) => k === '实测有效值' && v.indexOf('0.123') === 0),
      '真源驱动：把 state.rmsMeas 改成 0.123456 ⇒ 「实测有效值」行随之变成 0.123 V');
    acs.state.rmsMeas = 0;
  }
  const scope = byType('oscilloscope');
  if (scope) {
    scope.state.fMeas = Infinity;
    const rows = liveRows(scope);
    ok(rows.some(([k, v]) => k === '实测频率' && v === '—（无信号源）'),
      '占位而非 NaN：state.fMeas 置为 ±∞ ⇒ 「实测频率」行显示占位文案，且整行不含 Infinity');
    scope.state.fMeas = 0;
  }
  const cap = byType('resistorcap');
  if (cap) {
    const before = liveRows(cap).length;
    cap.state.t63 = 0.0021;
    ok(liveRows(cap).some(([k, v]) => k === '实测 63.2% 用时' && v === '0.002 s'),
      '同一键的两种表达：t63 从 NaN（占位「—（充电中）」）变成实测值后，该行改为读数');
    ok(liveRows(cap).length === before, '该行是「占位 ↔ 读数」的切换，不新增行（行数恒定）');
  }
}

// ══════════════════════════════════════════════════════════
head('⑤ 声学整域：改造前全是原始键名 → 改造后一个都不许剩');
const ACOU = ents.filter((e) => (e.def.cat || '') === '声学');
ok(ACOU.length > 0, `声学器材在场：${ACOU.length} 件（${ACOU.map((e) => e.type).join(' / ')}）`);
{
  let rawOld = 0, rawNew = 0;
  const oldList = [], newList = [];
  for (const e of ACOU) {
    for (const [k] of oldRows(e)) if (RAW_LABEL.test(k)) { rawOld++; oldList.push(e.type + '.' + k); }
    for (const [k] of liveRows(e)) if (RAW_LABEL.test(k)) { rawNew++; newList.push(e.type + '.' + k); }
  }
  ok(rawOld > 0, `改造前：声学器材面板上的原始键名共 ${rawOld} 个（红能力：这条判据改前必须不为 0）`);
  info('改前原始键名（前 12）：' + oldList.slice(0, 12).join(' / '));
  ok(rawNew === 0, `改造后：声学器材面板上的原始键名 ${rawNew} 个（Select-String 计数 = 0 的等价判据）`);
  for (const s of newList.slice(0, 10)) console.log('    \x1b[31m✗ 仍是原始键名：' + s + '\x1b[0m');
}
{
  // 逐件看：哪几件真的走到了兜底（有标签表生效），哪几件被求解器四键挡住 —— 老实报出来
  for (const e of ACOU) {
    const o = oldRows(e), n = liveRows(e);
    const tag = SENTINEL(o) ? '改前=哨兵行（兜底生效）' : '改前=已有行（兜底被挡）';
    info(`${e.type}（${e.name}） ${tag}  改后 [${dump(n)}]`);
  }
}
{
  // 标签表本身：声学 43 个键都要有中文标签（键名 → 标签，不查表就不知道）
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'ui', 'inspector.js'), 'utf8');
  const block = src.slice(src.indexOf('  声学: {'), src.indexOf('\n  // 通用只留'));
  const keys = [...block.matchAll(/(?:^|[\s{])([A-Za-z_][A-Za-z0-9_]*):\s*\['/g)].map((m) => m[1]);
  ok(keys.length >= 40, `声学标签表登记 ${keys.length} 个键（每个键都给了中文名与单位）`);
  ok(keys.length === new Set(keys).size, `声学标签表无重复键：${keys.length} 个键 / ${new Set(keys).size} 个唯一键`);
  info('声学表键：' + keys.join(' '));
}

// 域盲四键：这四个键是电路解注入的量，只有电路支路器材才该被贴上电学标签。**非**支路器材上它们是贴错域的
// （lever 的 I = 转动惯量、soundlevel 的 I/P = 声强/声源功率）⇒ 修复正是把这几行撤下、改由本域域表命名。
// 下面这个常量与 m1 ② 里同名同文本的常量逐字一致（⑧ 的耦合自检会核对两处，任一处漂移立刻红）。
const BLIND = { '电流 I': 'I', '两端电压 U': 'U', '功率 P': 'P', '等效电阻 R': 'R' };
/** 「被贴错域的四键行」退场：判定条件与 m1 ② 的 fourKeyRetired 完全一致（能力 + 域表现查，无器材名单） */
const blindRetired = (e, o, n) => typeof e.circuitBranch !== 'function'
  && o.length > 0
  && o.every(([k]) => k in BLIND)
  && n.every(([k]) => !(k in BLIND))
  && o.every(([k]) => {
    const t = (STATE_LABELS[(e.def && e.def.cat) || ''] || {})[BLIND[k]];
    return !!t && t[0] !== k;
  });

// ══════════════════════════════════════════════════════════
head('⑥ 行集结构：成对的 div.k / div.v（没插第三个子节点）+ 旧行逐字保留在前');
{
  let odd = [], scanned = 0, grown = 0, kept = 0, broken = [], renamed = [], rebuilt = [], retired4 = [], dropped = [];
  for (const e of ents) {
    const ins = new Inspector(mkEl('div'), appStub);
    ins.ent = e; ins._live = mkEl('div');
    ins.updateLive();
    scanned++;
    const cls = ins._live.children.map((c) => c.className);
    if (cls.length % 2 !== 0) odd.push(e.type + ' 子节点数 ' + cls.length + ' 为奇数');
    else if (cls.some((c, i) => c !== (i % 2 === 0 ? 'k' : 'v'))) {
      odd.push(e.type + ' 次序异常 [' + cls.slice(0, 8).join(',') + ']');
    }
    // 「升级与保留同时发生」：改造前就已经有行的器材，旧行必须**逐字留在同一位置**；
    // 唯一允许的例外是「旧的原始键名行被中文标签行点名替换」（本任务的声学目标，
    // 同一位置、值在前、单位追加在后）。除此之外不许改写 / 丢行 / 变序。
    const o = oldRows(e), n = readRows(ins._live);
    if (n.length < o.length) dropped.push(e.type);
    if (!SENTINEL(o)) {
      grown++;
      const verbatim = o.every(([k, v], i) => n[i] && n[i][0] === k && n[i][1] === v);
      // 「这个量还在」用三档判：值互相为前缀（新行常把单位接在值后）、或数值相等
      // （同一数量换了表示法：旧的 fmtLive(24)='24.00'、新的计数行写 '24'）。
      const covered = o.every(([k, v], i) =>
        (n[i] && n[i][0] === k && n[i][1] === v)
        || n.some(([k2, v2]) => !RAW_LABEL.test(k2)
          && (v2.indexOf(v) === 0 || v.indexOf(v2) === 0
            || (isFinite(parseFloat(v)) && parseFloat(v) === parseFloat(v2)))));
      const rawNew = n.filter(([k]) => RAW_LABEL.test(k)).length;
      const inPlace = o.every(([k, v], i) => n[i] && !RAW_LABEL.test(n[i][0]));
      if (verbatim) kept++;
      else if (blindRetired(e, o, n)) retired4.push(e.type);
      else if (covered && rawNew === 0) (inPlace ? renamed : rebuilt).push(e.type);
      else broken.push(e.type);
    }
  }
  ok(odd.length === 0, `扫描 ${scanned} 件器材的实时读数容器：子节点数全为偶数且严格 k/v 交替，0 件异常`);
  for (const s of odd.slice(0, 5)) info(s);
  ok(dropped.length === 0, `没丢行：${scanned} 件器材里 0 件的行数比改造前少`);
  ok(broken.length === 0, `旧行全部有下落：${kept} 件逐字保留、${renamed.length} 件同位置改名、${rebuilt.length} 件由显式分支重建、${retired4.length} 件域盲四键退场（量都在），0 件被改写 / 变序 / 丢量`);
  info(`逐字保留：${kept} 件；同位置改名（原始键名→中文标签）：${renamed.join(' / ') || '无'}；显式分支重建行序：${rebuilt.join(' / ') || '无'}；域盲四键退场（改由本域域表命名）：${retired4.join(' / ') || '无'}`);
  if (broken.length) info('异常：' + broken.join(' / '));
}

// ══════════════════════════════════════════════════════════
head('⑦ 格式卫生：新增的行同样不许出现 NaN / Infinity / undefined / 长尾巴');
{
  let scanned = 0, dirty = [], longTail = [];
  const NEW = KEYS.map((k) => k[2]);
  for (const t of ELEC.concat(ACOU.map((e) => e.type))) {
    const e = byType(t);
    if (!e) continue;
    for (const [k, v] of liveRows(e)) {
      if (NEW.indexOf(k) < 0 && (e.def.cat || '') !== '声学') continue;
      scanned++;
      const s = k + '=' + v;
      if (/NaN|Infinity|undefined/.test(s)) dirty.push(e.type + ' ' + s);
      if (/\.\d{7,}/.test(v)) longTail.push(e.type + ' ' + s);
    }
  }
  ok(dirty.length === 0, `扫描 ${scanned} 条本次新增/改名的读数：0 条含 NaN / Infinity / undefined`);
  ok(longTail.length === 0, `扫描 ${scanned} 条：0 条出现 7 位以上小数`);
  for (const s of dirty.concat(longTail).slice(0, 5)) info(s);
}

// ══════════════════════════════════════════════════════════
head('⑧ 变异证明：放宽成「旧行逐字为新行前缀」之后，判据必须仍然能红');
// 放宽判据最大的风险是「让红消失」而不是「让判据更准」。所以造三个变异体（改写 / 变序 / 丢行），
// 逐个证明前缀式判据在它们上面**仍然红**；再拿未变异的模块当对照组，证明同一条判据在它上面是绿的
// （否则这条判据就是「永远红」的假红线）。
// D43：仓库零字节改动 —— 变异只发生在内存字符串上，副本落 %TEMP%；副本里的相对 import 改写成
//      绝对 file URL（不然 %TEMP% 里解析不到依赖）。
// D47：先证明桩真的生效（变异体在读数上产生**预期的那一处**差异），再取判据的读数。
{
  const RELAXED = 'const prefixOk = (o, n) => n.length >= o.length && o.every(([k, v], i) => n[i][0] === k && n[i][1] === v);';
  const inspectorPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'ui', 'inspector.js');
  const sha256 = (s) => createHash('sha256').update(s).digest('hex');
  const SRC = readFileSync(inspectorPath, 'utf8');
  const shaBefore = sha256(SRC);
  const MUT_DIR = 'C:\\Users\\Admin\\AppData\\Local\\Temp\\nb-re\\mutants';
  mkdirSync(MUT_DIR, { recursive: true });
  const uiDir = dirname(inspectorPath);
  // 相对 import → 绝对 file URL（只改 import 说明符，不动被测逻辑）
  const absolutize = (src) => src.replace(/from\s+'(\.[^']+)'/g,
    (m0, spec) => "from '" + pathToFileURL(resolve(uiDir, spec)).href + "'");
  const mutantRows = async (src, tag) => {
    const f = join(MUT_DIR, tag + '.mjs');
    writeFileSync(f, absolutize(src), 'utf8');
    const M = await import(pathToFileURL(f).href);
    return (e) => {
      const ins = new M.Inspector(mkEl('div'), appStub);
      ins.ent = e; ins._live = mkEl('div');
      ins.updateLive();
      return readRows(ins._live);
    };
  };
  // 放宽后的判据本体（与 m1 ② 里那一行逐字一致）
  const prefixOk = (o, n) => n.length >= o.length && o.every(([k, v], i) => n[i][0] === k && n[i][1] === v);
  // 判据 = 前缀式 + 域盲四键退场豁免（与 m1 ② 现在实际用的那一套完全一致）
  const failsUnder = (rowsOf) => ents
    .filter((e) => {
      const o = oldRows(e), n = rowsOf(e);
      return !SENTINEL(o) && !prefixOk(o, n) && !blindRetired(e, o, n);
    })
    .map((e) => e.type);
  {
    const probeTxt = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'inspector-probe.mjs'), 'utf8');
    ok(probeTxt.includes(RELAXED),
      '耦合自检：m1 探针里的放宽判据与本文件这份**逐字一致**（它一改，这条就红）');
    ok(probeTxt.includes("const BLIND = { '电流 I': 'I', '两端电压 U': 'U', '功率 P': 'P', '等效电阻 R': 'R' };")
      && probeTxt.includes("typeof e.circuitBranch !== 'function'") && probeTxt.includes('t[0] !== k'),
      '耦合自检：域盲四键的退场豁免在 m1 探针里用的是同一条判断（能力判定 + 域表现查），不是两份各自解释');
  }
  // 对照组：未变异的模块。这里**不能**要求「全绿」——本文件这份基线带了兜底的「原始键名出口」，
  // 而有 4 件声学/信号器材的旧行正是原始键名行，本任务把它们**同位置改名**成中文标签行（声学那半条目标），
  // 前缀判据在这 4 件上正确地红。于是对照组改成：红的面**恰好**等于独立算出的「原始键名行 → 中文标签行」
  // 改名集 —— 既证明判据不是「永远红」，也证明它没有连坐到别的器材（变异体一上，红面立刻跳到 19~21 件）。
  const control = failsUnder((e) => liveRows(e));
  const renameByRule = ents.filter((e) => {
    const o = oldRows(e), n = liveRows(e);
    return !SENTINEL(o) && o.some(([k]) => RAW_LABEL.test(k)) && n.every(([k]) => !RAW_LABEL.test(k));
  }).map((e) => e.type);
  ok(control.length > 0 && control.length === renameByRule.length && control.every((t) => renameByRule.includes(t)),
    `对照组（未变异）：前缀判据只红 ${control.length} 件，恰好等于独立算出的改名集（${renameByRule.join(' / ') || '无'}）—— 不是「永远红」，也没连坐别的器材`);
  info(`这 ${control.length} 件在**本文件基线**（含兜底原始键名出口）下是「改前有原始键名行、改后同位置改名」；在 m1 那份基线（不含兜底）下它们算「改前无行 ⇒ upgraded 桶」，所以 m1 ② 的前缀判据不约束它们 —— 两份基线各管各的口径，差异在此点名，不做平均。`);

  const MUTS = [
    {
      tag: 'mut-rewrite', name: '改写（1 个字符：电流 I → 电流 i）',
      from: "['电流 I', fmtA(st.I)]", to: "['电流 i', fmtA(st.I)]",
      wType: 'resistorcap',
      wPred: (rows) => rows.some(([k]) => k === '电流 i') && !rows.some(([k]) => k === '电流 I'),
      why: 'resistorcap 的首行从「电流 I」变成「电流 i」',
    },
    {
      tag: 'mut-reorder', name: '变序（交换 电流 I 与 两端电压 U 两行）',
      from: "    if (isBranch && typeof st.I === 'number') rows.push(['电流 I', fmtA(st.I)]);\n    if (isBranch && typeof st.U === 'number') rows.push(['两端电压 U', fmtV(st.U)]);",
      to: "    if (isBranch && typeof st.U === 'number') rows.push(['两端电压 U', fmtV(st.U)]);\n    if (isBranch && typeof st.I === 'number') rows.push(['电流 I', fmtA(st.I)]);",
      wType: 'resistorcap',
      wPred: (rows) => !!rows[0] && rows[0][0] === '两端电压 U',
      why: 'resistorcap 的第 1/2 行互换（首行变成「两端电压 U」）',
    },
    {
      tag: 'mut-drop', name: '丢行（删掉 等效电阻 R 一行）',
      from: "    if (isBranch && typeof st.R === 'number') rows.push(['等效电阻 R', fmtR(st.R)]);\n", to: '',
      wType: 'resistorcap',
      wPred: (rows) => !rows.some(([k]) => k === '等效电阻 R'),
      why: 'resistorcap 的「等效电阻 R」一整行消失',
    },
    {
      tag: 'mut-table-def', name: '撤掉域表的重新定义（力学表 I：转动惯量 → 电流 I）',
      from: "    I: ['转动惯量', 'kg·m²'],", to: "    I: ['电流 I', 'A'],",
      wType: 'lever',
      wPred: (rows) => rows.some(([k]) => k === '电流 I'),
      why: 'lever 的 I 行退回成语义相同的「电流 I」—— 等价于「本域不再重新定义这个键」，豁免应当立刻失效',
    },
  ];
  for (const m of MUTS) {
    const hits = SRC.split(m.from).length - 1;
    ok(hits === 1, `${m.name}：靶点文本在源码里唯一命中（命中 ${hits} 次，必须恰好 1 次）`);
    if (hits !== 1) continue;
    const rowsOf = await mutantRows(SRC.replace(m.from, m.to), m.tag);
    const w = byType(m.wType);
    ok(!!w && m.wPred(rowsOf(w)), `D47 桩生效：${m.why}（先证这一处，再看判据）`);
    const bad = failsUnder(rowsOf);
    ok(bad.length > 0,
      `${m.name} ⇒ 前缀判据**红**：${bad.length} 件被抓（${bad.slice(0, 6).join(' / ')}${bad.length > 6 ? ' …' : ''}）`);
  }
  ok(shaBefore === sha256(readFileSync(inspectorPath, 'utf8')),
    `D43 仓库零字节改动：src/ui/inspector.js 全程 sha256 不变（${shaBefore.slice(0, 16)}），变异体只落 %TEMP%\\nb-re\\mutants`);
}

// ══════════════════════════════════════════════════════════
head('⑨ 域盲四键只该出现在电路支路器材上：非支路器材的同名键由它自己那一域的域表命名');
{
  const FOUR = ['I', 'U', 'P', 'R'];
  const holders = [], strayRows = [];
  for (const e of ents) {
    const st = e.state || {};
    const got = FOUR.filter((k) => typeof st[k] === 'number' && Number.isFinite(st[k]));
    if (!got.length) continue;
    const cat = (e.def && e.def.cat) || '';
    const branch = typeof e.circuitBranch === 'function';
    holders.push(`${e.type}(cat=${cat || '空'},${branch ? '支路' : '非支路'},${got.join('')})`);
    if (branch) continue;
    // 判据落在**被贴出来的标签**上，不是「state 里有没有这个键」—— 非支路器材的 I/P 本来就该存在，
    // 只是不该叫「电流 I / 功率 P」（D34：探针要量目标状态，别量一个永远为真的中间量）。
    const rows = liveRows(e);
    const bad = rows.filter(([k]) => k in BLIND).map(([k]) => k);
    if (bad.length) strayRows.push(`${e.type} 仍被贴电学标签 ${bad.join('/')} ← [${dump(rows)}]`);
    else info(`${e.type}（${e.name}）非支路：四键改由本域域表命名 ⇒ [${dump(rows)}]`);
  }
  ok(strayRows.length === 0,
    `${holders.length} 件带数字 I/U/P/R 的器材（其中非支路 ${holders.filter((h) => h.includes(',非支路,')).length} 件）里，0 件非支路器材被贴电学四标签`);
  for (const s of strayRows) info('越界：' + s);
  info('持键器材：' + holders.join(' / '));
}
// ══════════════════════════════════════════════════════════
head('⑨ 异常态口径：烧毁与未接线都不许报幻影零（⑧甲 / ⑧乙）');
// 判据为什么必须走真电路：未接线的表**照样**会被求解器写 I/U/P/R = 0
//（circuit.js 收集支路只要求「有两个 wire 端口」，不要求接线）⇒
//「state 里的 0」与「面板上的 0 A」不是同一件事，本组就是要量这个差。
{
  const w = new World();
  const lone = create('multimeter', 300, 300); w.add(lone, true);
  const bat0 = create('battery', 100, 100); bat0.props.emf = 0; w.add(bat0, true);
  const wired = create('multimeter', 420, 100); w.add(wired, true);
  w.connect({ e: bat0.id, p: 0 }, { e: wired.id, p: 0 }, 'wire');
  w.connect({ e: wired.id, p: 1 }, { e: bat0.id, p: 1 }, 'wire');
  solveCircuit(w);
  for (const m of [lone, wired]) m.step(1 / 120, w);
  const app = { world: w, markDirty() {} };
  const rowsWith = (e) => {
    const ins = new Inspector(mkEl('div'), app);
    ins.ent = e; ins._live = mkEl('div'); ins._signed = mkEl('div'); ins._position = mkEl('div');
    ins.updateLive();
    const o = [];
    for (let i = 0; i + 1 < ins._live.children.length; i += 2) o.push([ins._live.children[i].textContent, ins._live.children[i + 1].textContent]);
    return o;
  };
  const get = (rs, k) => { const r = rs.find(([a]) => a === k); return r ? r[1] : null; };
  ok(lone.state.I === 0 && lone.state.U === 0, `D47 前置：未接线的表照样被求解器写 0（幻影零确实存在）I=${lone.state.I} U=${lone.state.U}`);
  ok(wired.state.I === 0, `对照：已接线、电池 emf=0 ⇒ 电流真为 0  I=${wired.state.I}`);
  const rl = rowsWith(lone), rw = rowsWith(wired);
  ok(lone.state.I === wired.state.I, '两块表的 state 数值完全相同（都是 0）—— 面板必须仍能区分它们');
  ok(get(rl, '示数') === SIGNED_NA, `未接线 ⇒ 示数 = ${SIGNED_NA}（不是 0 A）实得 [${get(rl, '示数')}]`);
  ok(get(rw, '示数') === '0 A', `已接线真 0 ⇒ 示数 = 0 A 实得 [${get(rw, '示数')}]`);
  ok(get(rl, '电流 I') === '0 A' && get(rl, '示数') === SIGNED_NA, '边界：四键行是被探针逐字冻结的源码行 ⇒ 仍报 0 A；未接线的区分只由「示数」行承担（领队 ⑧乙 的字面范围）');
  ok(get(rw, '电流 I') === '0 A' && get(rw, '示数') === '0 A', '已接线真 0：四键与示数都是 0 A（与上一条同值不同接线事实 ⇒ 成对）');
  const bm = create('multimeter', 520, 520); w.add(bm, true);
  bm.props.dial = 'A06';
  bm.state.broken = true; bm.state.brokenReason = '过流'; bm.state.I = 0; bm.state.U = 0; bm.state.P = 0;
  bm.step(1 / 120, w);
  const rb = rowsWith(bm);
  ok(get(rb, '状态') === '已烧毁', `烧毁 ⇒ 状态 已烧毁 实得 [${get(rb, '状态')}]`);
  ok(get(rb, '烧毁原因') === '过流', `烧毁原因取自 state.brokenReason 实得 [${get(rb, '烧毁原因')}]`);
  ok(!rb.some(([k]) => k === '电流 I'), '⑧甲：烧毁 ⇒ 四键整组退场（不再与「已烧毁」同屏报 0 A）');
  ok(get(rb, '示数') === BURNT_NA, `示数与状态同一口径（BURNT_NA = ${BURNT_NA}）实得 [${get(rb, '示数')}]`);
  info('未接线：[\x1b[0m' + dump(rl) + ']');
  info('已接线真 0：[\x1b[0m' + dump(rw) + ']');
  info('烧毁：[\x1b[0m' + dump(rb) + ']');
}
// ══════════════════════════════════════════════════════════
head('⑩ plans/10 §4 的 B2 / B3 / B5：新增行 + 每条的能红证明');
{
  const sha256 = (s) => createHash('sha256').update(s).digest('hex');
  const ip = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'ui', 'inspector.js');
  const SRC0 = readFileSync(ip, 'utf8'), sha0 = sha256(SRC0);
  const MDIR = 'C:\\Users\\Admin\\AppData\\Local\\Temp\\nb-re\\mutants';
  mkdirSync(MDIR, { recursive: true });
  const ud = dirname(ip);
  const abs0 = (s) => s.replace(/from\s+'(\.[^']+)'/g, (m0, sp) => "from '" + pathToFileURL(resolve(ud, sp)).href + "'");
  const rowsWith = async (app, e, src) => {
    const M = src ? await import(pathToFileURL((() => { const f = join(MDIR, 'b-' + Math.random().toString(36).slice(2) + '.mjs'); writeFileSync(f, abs0(src), 'utf8'); return f; })()).href) : await import(pathToFileURL(ip).href);
    const ins = new M.Inspector(mkEl('div'), app);
    ins.ent = e; ins._live = mkEl('div'); ins._signed = mkEl('div'); ins._position = mkEl('div');
    ins.updateLive();
    const o = [];
    for (let i = 0; i + 1 < ins._live.children.length; i += 2) o.push([ins._live.children[i].textContent, ins._live.children[i + 1].textContent]);
    return o;
  };
  const get = (rs, k) => { const r = rs.find(([a]) => a === k); return r ? r[1] : null; };
  // ── B3 铭牌：真值由 props 现算，不写死数字
  const stubWorld = { world: { get: () => null, wires: [] }, markDirty() {} };
  const lamp0 = create('lamp', 200, 200);
  const r3 = await rowsWith(stubWorld, lamp0);
  const wantR = fmtR((lamp0.props.ratedV * lamp0.props.ratedV) / lamp0.props.ratedP);
  const wantI = fmtA(lamp0.props.ratedP / lamp0.props.ratedV);
  ok(get(r3, '额定电阻 V²/P') === wantR && get(r3, '额定电流 P/V') === wantI,
    `B3 铭牌两行：额定电阻 ${wantR}、额定电流 ${wantI}（prop 现算核对，实得 [${get(r3, '额定电阻 V²/P')}] / [${get(r3, '额定电流 P/V')}]）`);
  const noRated = create('lamp', 900, 900); noRated.props.ratedP = 0;
  ok(get(await rowsWith(stubWorld, noRated), '额定电阻 V²/P') === null, 'B3 门控：没有额定量（ratedP=0）时不出这两行（不是无条件贴）');
  // ── B5 实时 / 瞬时：加热后必须分叉
  const lamp5 = create('lamp', 220, 220); lamp5.props.warmUpTime = 0.2;
  const rHotWant = lamp5.rHot();
  const row5cold = await rowsWith(stubWorld, lamp5);
  const RiCold = get(row5cold, '瞬时电阻 R(u)'), RlCold = get(row5cold, '实时电阻 R(T)');
  lamp5.state.P = lamp5.props.ratedP;
  for (let i = 0; i < 4000; i++) lamp5.step(0.05);      // 200 s ≫ τ = warmUpTime = 0.2 s ⇒ 到额定点附近
  const r5 = await rowsWith(stubWorld, lamp5);
  const RiHot = get(r5, '瞬时电阻 R(u)'), RlHot = get(r5, '实时电阻 R(T)');
  info('B5 冷态（T=环境）：' + dump(row5cold));
  info('B5 热态（P=额定，已积到平衡）：' + dump(r5));
  ok(RiCold !== null && RlCold === RiCold,
    `B5 尚未积分时两行相等 —— 这是**器材的零回归回退**（resistanceNow() 在 filamentTemp 非有限时返回 resistanceAt(0)，electrical.js:206）⇒ 面板如实反映，不是面板把两个量混成一个（实得 ${RlCold}）`);
  // ⚠ lamp5 此刻已经是热态（上面 4000 步）⇒ 这一步必须用**独立实体**，否则测的是热态而不是「热状态刚存在」
  const lamp5b = create('lamp', 230, 230); lamp5b.props.warmUpTime = 0.2;   // P 保持 0
  lamp5b.step(0.05);
  const row5one = await rowsWith(stubWorld, lamp5b);
  const RlOne = get(row5one, '实时电阻 R(T)'), RiOne = get(row5one, '瞬时电阻 R(u)');
  info('B5 热状态刚存在（独立灯泡，P=0 ⇒ T=环境 20℃）：' + dump(row5one));
  ok(RlOne === fmtR(lamp5b.r20()) && RlOne !== RiOne,
    `B5 热状态一存在两行立刻分叉、且实时回到 r20：实时 ${RlOne}（= r20 = ${fmtR(lamp5b.r20())}）≠ 瞬时 ${RiOne}（代数拟合在 U=0 的极限是 4.19×r20）⇒ 两个量、两条真源、两行`);
  ok(Math.abs(lamp5.state.filamentR - rHotWant) / rHotWant < 0.15 && Number.parseFloat(RlHot) > Number.parseFloat(RiHot),
    `B5 加热到额定点后：实时 ${RlHot}（器材 rHot() = ${fmtR(rHotWant)}，误差 ${(100 * Math.abs(lamp5.state.filamentR - rHotWant) / rHotWant).toFixed(1)}%）> 瞬时 ${RiHot}（U=0 时的代数值）`);
  ok(RlHot === fmtR(lamp5.state.filamentR), `B5 实时阻值走器材自报 state.filamentR（${fmtR(lamp5.state.filamentR)}），面板没有另算一份`);
  const bothM = (e) => typeof e.resistanceAt === 'function' && typeof e.resistanceNow === 'function';
  const gate = [];
  for (const t of ['lamp', 'battery', 'thermistor', 'resistor', 'rheostat']) {
    const e = create(t, 950, 950);
    gate.push([t, bothM(e), get(await rowsWith(stubWorld, e), '实时电阻 R(T)') !== null]);
  }
  ok(gate.every(([, has, shown]) => has === shown) && gate.some(([, has]) => has),
    'B5 门控与能力判定逐型一致（有 resistanceAt+resistanceNow 才出这两行）：' + gate.map(([t, h, s]) => `${t}:${h ? '两法齐' : '缺法'}=${s ? '出行' : '不出'}`).join(' '));
  // ── B2 瞬时 / 有效 并列（电压）
  const w2 = new World();
  const ac = create('acsource', 300, 300); w2.add(ac, true);
  const acLone = create('acsource', 500, 500); w2.add(acLone, true);
  w2.connect({ e: ac.id, p: 0 }, { e: acLone.id, p: 0 }, 'wire');
  w2.connect({ e: ac.id, p: 1 }, { e: acLone.id, p: 1 }, 'wire');
  solveCircuit(w2); ac.step(1 / 120, w2); acLone.step(1 / 120, w2);
  const acFree = create('acsource', 700, 700); w2.add(acFree, true);   // 一根导线都没接
  const app2 = { world: w2, markDirty() {} };
  const r2 = await rowsWith(app2, ac);
  ok(get(r2, '瞬时电压 u(t)') !== null && get(r2, '有效电压 U_rms=Up/√2') !== null,
    `B2 并列：同一块交流源上「瞬时电压 u(t)=${get(r2, '瞬时电压 u(t)')}」与「有效电压 U_rms=Up/√2=${get(r2, '有效电压 U_rms=Up/√2')}」同时在场（两行、不合并）`);
  ok(get(r2, '瞬时电压 u(t)') === fmtV(ac.state.U), `B2 瞬时电压取逐拍 rec.U（${fmtV(ac.state.U)}），与求解器同源`);
  ok(get(await rowsWith(app2, acFree), '瞬时电压 u(t)') === SIGNED_NA && get(await rowsWith(app2, acLone), '瞬时电压 u(t)') !== SIGNED_NA, 'B2 未接线不给幻影零、已接线照给（acFree 零导线 vs acLone 两根线，同一块器材类型对照）');
  // ── 能红证明：每条一套，逐个报
  const mutations = [
    { item: 'B3', from: "rows.push(['额定电阻 V²/P'", to: "rows.push(['额定电阻X'", key: '额定电阻 V²/P' },
    { item: 'B5', from: "rows.push(['实时电阻 R(T)'", to: "rows.push(['实时电阻X'", key: '实时电阻 R(T)' },
    { item: 'B2', from: "rows.push(['瞬时电压 u(t)'", to: "rows.push(['瞬时电压X'", key: '瞬时电压 u(t)' },
  ];
  for (const m of mutations) {
    const hits = SRC0.split(m.from).length - 1;
    ok(hits === 1, `${m.item} 变异靶点在源码里唯一命中（命中 ${hits} 次，必须恰好 1 次）`);
    const mm = SRC0.replace(m.from, m.to);
    const target = m.item === 'B3' ? lamp0 : m.item === 'B5' ? lamp5 : ac;
    const app = m.item === 'B2' ? app2 : stubWorld;
    const got = get(await rowsWith(app, target, mm), m.key);
    ok(got === null, `${m.item} 能红：把标签改一个字符 ⇒ 该行消失、对应断言必红（变异体实得 [${got}]）`);
  }
  ok(sha256(readFileSync(ip, 'utf8')) === sha0, `D43 仓库零字节改动：inspector.js 全程 sha256 不变（${sha0.slice(0, 16)}）`);
}
if (fail === 0) console.log('\x1b[32m全部通过：' + pass + ' 项\x1b[0m');
else console.log('\x1b[31m合计 ' + (pass + fail) + ' 项，失败 ' + fail + ' 项\x1b[0m');
{
  const f = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'ui', 'inspector.js');
  const b = readFileSync(f);
  const h = createHash('sha256').update(b).digest('hex');
  console.log(`  D36 终点：src/ui/inspector.js ${b.length}B ${h.slice(0, 16)}`);
  console.log('  D40 命令行：node tools/inspector-stats-probe.mjs');
}
process.exit(fail === 0 ? 0 : 1);
