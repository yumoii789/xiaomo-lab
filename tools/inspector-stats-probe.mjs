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
import { create, list, bindRegistry, equipmentPlugins, derive, remove } from '../src/equipment/index.js';
import { CouplingBus } from '../src/coupling/bridge.js';
import { solveCircuit, fmtA, fmtV, fmtW, fmtR } from '../src/physics/circuit.js';
import { SP } from '../src/chemistry/species.js';
// ⚠ fmtLive 以 fmtLiveSrc 之名导入：本文件下方另有一份**同名**历史副本（配合 oldRows() 的改造前算法 A/B），
//   两者逐字相同但用途不同 —— 新断言必须引用**当前真源**，不能引用那份历史副本。
import { Inspector, LIVE_FALLBACK_MAX, STATE_LABELS, SIGNED_NA, BURNT_NA, fmtLive as fmtLiveSrc } from '../src/ui/inspector.js';

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
  // 标签表本身：退役前，声学表那 43 个键都要有中文标签（键名 → 标签，不查表就不知道）。
  // ★ **已退役**（B4 第 3 步首例，2026-10-17）：声学 4 件的标签改由 `def.stats` 承载，
  //   故本组在「表整张不在」时不再适用。但保留一条**半迁移哨兵**：本表要么**整张不在**（0 键 =
  //   已退役），要么**完整**（≥40 键）。**中间态才红** —— 防止有人迁到一半把表删剩几个键，
  //   那种状态下兜底会对**部分**键失去中文名，是最难发现的一种残缺。
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'ui', 'inspector.js'), 'utf8');
  const at = src.indexOf('  声学: {');
  const end = src.indexOf('\n  // 通用只留');
  const block = at >= 0 && end > at ? src.slice(at, end) : '';
  const keys = [...block.matchAll(/(?:^|[\s{])([A-Za-z_][A-Za-z0-9_]*):\s*\['/g)].map((m) => m[1]);
  ok(keys.length === 0 || keys.length >= 40,
    keys.length === 0
      ? '㊿ 声学标签表**已退役**（0 键）—— 本组不再适用；声学 4 件的标签改由 `def.stats` 承载（见 §㉓ / §⑥）'
      : `声学标签表登记 ${keys.length} 个键（每个键都给了中文名与单位）`);
  ok(keys.length === new Set(keys).size, `声学标签表无重复键：${keys.length} 个键 / ${new Set(keys).size} 个唯一键`);
  if (keys.length) info('声学表键：' + keys.join(' '));
}

// 域盲四键：这四个键是电路解注入的量，只有电路支路器材才该被贴上电学标签。**非**支路器材上它们是贴错域的
// （lever 的 I = 转动惯量、soundlevel 的 I/P = 声强/声源功率）⇒ 修复正是把这几行撤下、改由本域域表命名。
// 下面这个常量与 m1 ② 里同名同文本的常量逐字一致（⑧ 的耦合自检会核对两处，任一处漂移立刻红）。
const BLIND = { '电流 I': 'I', '两端电压 U': 'U', '功率 P': 'P', '等效电阻 R': 'R' };
/** 「被贴错域的四键行」退场：判定条件与 m1 ② 的 fourKeyRetired 完全一致（能力判定 + 域表现查 / 器材自报，无器材名单） */
const blindRetired = (e, o, n) => typeof e.circuitBranch !== 'function'
  && o.length > 0
  && o.every(([k]) => k in BLIND)
  && n.every(([k]) => !(k in BLIND))
  && o.every(([k]) => {
    const t = (STATE_LABELS[(e.def && e.def.cat) || ''] || {})[BLIND[k]];
    // 条件④：该键在本域被定义成**别的物理量**。两条**等价**证据任取其一 ——
    //   a) 域表里有这个键、且标签不是域盲标签（**退役前**的情形）；
    //   b) 该器材**已声明 `stats`**（**退役后**该分类域表可能整张撤掉，如声学）——
    //      此时「这些键在这件器材上不是电学量」由器材自己的声明承载，而判据③
    //      （新行里一个域盲标签都不剩）继续钉住「误标确实退场了」这件事。
    // ⚠ 不可只留 b)：`lever`（力学）**没有** stats，它的豁免只能靠 a) —— §⑧ 的
    //    `mut-table-def` 变异体正是撤掉力学表的 `I` 定义使 a) 失效，那条路必须保持能动。
    return (!!t && t[0] !== k)
      || (Array.isArray(e.def && e.def.stats) && e.def.stats.length > 0);
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
    // ⚠ 旧行里末尾的 `… 还有 N 项读数` 是兜底**截断**留下的占位行（`LIVE_FALLBACK_MAX = 8`），
    //    不是读数。B4 的 `stats` 路径**不受该上限约束** ⇒ 被截断的器材在迁移后会让**真实行取代占位行**
    //    （行数变多、信息更全，是有意的）。判据里必须先剔除占位行，否则会把这种**改进**误判成「改写」。
    const o = oldRows(e).filter(([k]) => k !== '…'), n = readRows(ins._live);
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
  // ── 匹配/替换专用视图（归一换行）────────────────────────────────────────────
  // 本仓 core.autocrlf=true 且 .gitattributes 只钉 market/* ⇒ **全新 Windows 检出时** src/**、tools/**
  // 都是 CRLF，而下面几条多行锚点（from 里含 \n）在 CRLF 文本上命中 0 次 ⇒ 两条断言**永久假红**
  // （「永远不可能绿的断言比没有更坏」：它会长期产生噪声并掩盖真正的回归）。
  // ⚠ 只归一「匹配与替换」这一路：sha256 必须继续读**原始字节**（shaBefore 与 D43 的逐字节比对）。
  const SRCm = SRC.replace(/\r\n/g, '\n');
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
  // 而声学/信号那几件器材的旧行正是原始键名行，本任务把它们**同位置改名**成中文标签行，
  // 前缀判据在这些件上正确地红。于是对照组改成：红的面**恰好**等于独立算出的「应当红」集合 ——
  // 既证明判据不是「永远红」，也证明它没有连坐到别的器材（变异体一上，红面立刻跳到 19~21 件）。
  //
  // ⚠ 「应当红」有**两类**，缺一类就会误判（`pulley` 就是这么红的）：
  //   a) **改名**：旧行含原始键名、新行全换成中文标签（本任务的声学目标）；
  //   b) **放开截断**：旧行被 `LIVE_FALLBACK_MAX` 截断（末尾有 `…` 占位行），而 `stats` 路径
  //      **不受该上限约束** ⇒ 新行更长、占位行消失。前缀判据对它同样正确地红，
  //      但这是**有意的**行为变化（被截掉的是真读数），不是回归（见报告 §19.3）。
  //   两类都要求 `o` **先剔除占位行**再比，否则占位行会把「逐字相同」判成改写。
  const control = failsUnder((e) => liveRows(e));
  const renameByRule = ents.filter((e) => {
    const raw = oldRows(e);
    const o = raw.filter(([k]) => k !== '…');          // 剔除截断占位行，与 §⑥ 同口径
    const n = liveRows(e);
    if (SENTINEL(o)) return false;
    const renamed = raw.some(([k]) => RAW_LABEL.test(k)) && n.every(([k]) => !RAW_LABEL.test(k));
    const untruncated = raw.some(([k]) => k === '…') && n.length > o.length && !n.some(([k]) => k === '…');
    return renamed || untruncated;
  }).map((e) => e.type);
  ok(control.length > 0 && control.length === renameByRule.length && control.every((t) => renameByRule.includes(t)),
    `对照组（未变异）：前缀判据只红 ${control.length} 件，恰好等于独立算出的「应当红」集（${renameByRule.join(' / ') || '无'}）—— 两类：改名（旧行原始键名→中文标签）与放开截断（旧行被 8 项上限截断、新行全出）—— 不是「永远红」，也没连坐别的器材`);
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
      // ⚠ 力学 8/8 后 `STATE_LABELS.力学` **整张退役**，本变异体的**原靶点随之消失**：
      //    它原本把表里 `I: ['转动惯量','kg·m²']` 改成 `['电流 I','A']`，靠「lever 的 I 行退回
      //    成语义相同的域盲标签」来让豁免条件③失效。表撤了就没有可改的文本，`hits` 会变 0。
      //    同时豁免的**分支 a**（域表现查键义）对力学分类也**永久消失** ⇒ `lever` 只剩分支 b
      //    （「该器材已声明 stats」）⇒ **打 b 才是现在唯一能证伪它的路**。
      //    b 的证据在**器材侧**（`lever` 的 `stats`），而本探针的变异机制只改 `src/ui/inspector.js`，
      //    故改打**消费端**：把 stats 循环的取值改成空数组，等价于「所有器材都不再自报」。
      //    ⇒ 此时 `lever` 没有兜底可用（表已退役），它的行会**整批消失** —— 这正是要抓的回归。
      tag: 'mut-stats-off', name: '掐掉 stats 消费（`e.def.stats` 读到空 ⇒ 器材退回兜底；力学表已退役故 lever 无路可退）',
      from: 'for (const s of (e.def && e.def.stats) || []) {', to: 'for (const s of []) {',
      wType: 'lever',
      wPred: (rows) => !rows.some(([k]) => k === '转动惯量'),
      why: 'lever 的行里不再有「转动惯量」（stats 被掐、力学表已退役 ⇒ 这一行无处可生）',
    },
  ];
  for (const m of MUTS) {
    const hits = SRCm.split(m.from).length - 1;
    ok(hits === 1, `${m.name}：靶点文本在源码里唯一命中（命中 ${hits} 次，必须恰好 1 次）`);
    if (hits !== 1) continue;
    const rowsOf = await mutantRows(SRCm.replace(m.from, m.to), m.tag);
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
  // 同 SRCm：只归一匹配/替换这一路；sha0 必须来自原始字节（:1357 的 D43 会重新读盘逐字节比）。
  const SRC0m = SRC0.replace(/\r\n/g, '\n');
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
  // ⚠ 让它**真的被求解一次**：孤立 V 支路照样会被 MNA 装配 ⇒ 解出的是**浮点残差级**电流（不是精确 0）。
  //   这正是电流半边特有的陷阱（T-03a 在器材侧登记过同一条事实）。
  solveCircuit(w2); acFree.step(1 / 120, w2);
  const app2 = { world: w2, markDirty() {} };
  const r2 = await rowsWith(app2, ac);
  ok(get(r2, '瞬时电压 u(t)') !== null && get(r2, '有效电压 U_rms=Up/√2') !== null,
    `B2 并列：同一块交流源上「瞬时电压 u(t)=${get(r2, '瞬时电压 u(t)')}」与「有效电压 U_rms=Up/√2=${get(r2, '有效电压 U_rms=Up/√2')}」同时在场（两行、不合并）`);
  ok(get(r2, '瞬时电压 u(t)') === fmtV(ac.state.U), `B2 瞬时电压取逐拍 rec.U（${fmtV(ac.state.U)}），与求解器同源`);
  ok(get(await rowsWith(app2, acFree), '瞬时电压 u(t)') === SIGNED_NA && get(await rowsWith(app2, acLone), '瞬时电压 u(t)') !== SIGNED_NA, 'B2 未接线不给幻影零、已接线照给（acFree 零导线 vs acLone 两根线，同一块器材类型对照）');
  // ── B2 的**电流**半边（T-03）：真源由 T-03a 补在 AcSource 侧（逐拍电流缓冲 + state.rmsI）
  info('B2 电流半边：' + dump(r2));
  ok(get(r2, '瞬时电流 i(t)') !== null && get(r2, '有效电流 I_rms') !== null,
    `B2 电流并列：同一块交流源上「瞬时电流 i(t)=${get(r2, '瞬时电流 i(t)')}」与「有效电流 I_rms=${get(r2, '有效电流 I_rms')}」同时在场（两行、不合并）`);
  ok(get(r2, '瞬时电流 i(t)') === fmtA(ac.state.I), `B2 瞬时电流取逐拍 rec.I（${fmtA(ac.state.I)}），与求解器同源`);
  ok(get(r2, '有效电流 I_rms') === fmtA(ac.state.rmsI), `B2 有效电流走器材自报 state.rmsI（${fmtA(ac.state.rmsI)}），面板没有另算一份`);
  // ⚠ 判据源是**接线真源**（`wiredPortsOf(...).size >= 2`，见 src/ui/inspector.js 的 `wired`），
  //   **不是数值**。本断言原先钉在「未接线时 rmsI 是 MNA 浮点残差（~1e-12）」上 —— 那是求解器的
  //   **附带产物**，会随实现变化（现测已是**精确 0**）⇒ 钉它等于**钉代理量**：它自己会腐，而且
  //   它并不能证明"判据源是接线"。⇒ 改成两条，且**只有第二条是鉴别性的**：
  //     甲）未接线 ⇒ 占位。**无条件**成立（与 rmsI 取值无关）；rmsI 只作为**实况记录**打出来。
  //     乙）**已接线但电流合法为 0** ⇒ 必须给读数（`0 A`），**不许**给占位
  //         —— 这一条才能证明判据源是接线：若谁把 `wired` 偷换成 `rmsI !== 0`，乙必红（下面配了变异体）。
  ok(get(await rowsWith(app2, acFree), '有效电流 I_rms') === SIGNED_NA,
    `B2 电流未接线：判据走**接线真源**（wiredPortsOf ≥ 2）⇒ 占位 [${SIGNED_NA}]`
    + `（器材侧 rmsI=${acFree.state.rmsI} —— 本值仅**如实记录**，**不是**判据）`);
  // 「已接线但电流为 0」的构造：**两个端口各挂一根导线、另一端都悬空** ⇒ wiredPortsOf={0,1} 满足
  // `wired`，但没有闭合回路 ⇒ 求解器给出 0 电流。这正是"接线 ≠ 有电流"的最小反例。
  const acStub = create('acsource', 900, 900); w2.add(acStub, true);
  const stubA = create('lamp', 1000, 900); w2.add(stubA, true);
  const stubB = create('lamp', 1100, 900); w2.add(stubB, true);
  w2.connect({ e: acStub.id, p: 0 }, { e: stubA.id, p: 0 }, 'wire');
  w2.connect({ e: acStub.id, p: 1 }, { e: stubB.id, p: 1 }, 'wire');
  solveCircuit(w2); acStub.step(1 / 120, w2);
  const iStub = get(await rowsWith(app2, acStub), '有效电流 I_rms');
  // 就地重算 `wiredPortsOf`（它在 src/ui/inspector.js 里是**模块内**函数、未导出 ⇒ 只能按同一口径重算：
  // 该器材有多少个**不同端口**上挂了 kind==='wire' 的导线）。口径必须一致，否则这条断言会自欺。
  const nStubPorts = new Set(w2.wires
    .filter((w) => w && w.kind === 'wire')
    .flatMap((w) => [w.a, w.b])
    .filter((p) => p && p.e === acStub.id)
    .map((p) => p.p)).size;
  ok(iStub !== SIGNED_NA && iStub === fmtA(acStub.state.rmsI),
    `B2 电流**鉴别性**对照：已接线（${nStubPorts} 个端口挂了导线，须 ≥2）`
    + `但电流合法为 0 时，必须给读数而不是占位（实测 [${iStub}]，器材自报 rmsI=${acStub.state.rmsI}）`
    + ` ⇒ 证明判据源是**接线**而不是数值`);
  // 能红证明：把判据源从「接线真源」偷换成「数值」⇒ 上面那条**鉴别性**断言必红
  const mWire = "wired && typeof st.rmsI === 'number'";
  const hitsW = SRC0m.split(mWire).length - 1;
  ok(hitsW === 1, `B2电流判据源 变异靶点在源码里唯一命中（命中 ${hitsW} 次，必须恰好 1 次）`);
  const gotW = get(await rowsWith(app2, acStub, SRC0m.replace(mWire, "st.rmsI !== 0 && typeof st.rmsI === 'number'")), '有效电流 I_rms');
  ok(gotW === SIGNED_NA,
    `B2电流判据源 能红：把 wired 偷换成 rmsI!==0 ⇒ **已接线但电流为 0** 被误判成"未接线"`
    + `（变异体实得 [${gotW}] = 占位 ⇒ 鉴别性断言必红；未变异时应为 [${iStub}]）`);
  // ── 能红证明：每条一套，逐个报
  const mutations = [
    { item: 'B3', from: "rows.push(['额定电阻 V²/P'", to: "rows.push(['额定电阻X'", key: '额定电阻 V²/P' },
    { item: 'B5', from: "rows.push(['实时电阻 R(T)'", to: "rows.push(['实时电阻X'", key: '实时电阻 R(T)' },
    { item: 'B2', from: "rows.push(['瞬时电压 u(t)'", to: "rows.push(['瞬时电压X'", key: '瞬时电压 u(t)' },
    { item: 'B2电流', from: "rows.push(['瞬时电流 i(t)'", to: "rows.push(['瞬时电流X'", key: '瞬时电流 i(t)' },
  ];
  for (const m of mutations) {
    const hits = SRC0m.split(m.from).length - 1;
    ok(hits === 1, `${m.item} 变异靶点在源码里唯一命中（命中 ${hits} 次，必须恰好 1 次）`);
    const mm = SRC0m.replace(m.from, m.to);
    const target = m.item === 'B3' ? lamp0 : m.item === 'B5' ? lamp5 : ac;
    const app = m.item.startsWith('B2') ? app2 : stubWorld;
    const got = get(await rowsWith(app, target, mm), m.key);
    ok(got === null, `${m.item} 能红：把标签改一个字符 ⇒ 该行消失、对应断言必红（变异体实得 [${got}]）`);
  }
  // ── B4 第 1 步「共存」（plans/11 §6.3 第 1 步）────────────────────────────
  //    第 1 步的定义是「机制在位 + 零回归」：仓库里**没有任何器材声明 stats**（零命中），
  //    所以这里**临时**挂一份、测完立刻还原 —— 既验证机制，又不给仓库引入任何声明 ✓
  head('⑪ B4 第 1 步「共存」：def.stats 按**位置契约**插入（plans/11 §6.3；位置 2026-10-17 修订）');
  const acS = create('acsource', 400, 400);
  const appS = { world: { get: () => null, wires: [] }, markDirty() {} };
  const rowS0 = await rowsWith(appS, acS);
  const statsBak = acS.def.stats;
  acS.state.probeA = 3.5; acS.state.probeB = -0.03125; acS.state.probeC = 12;
  const statList = [
    { label: '自报甲', unit: 'V', read: (e) => e.state.probeA },
    { label: '自报乙', unit: 'A', read: (e) => e.state.probeB },
    { label: '自报丙', read: (e) => e.state.probeC },
  ];
  try {
    acS.def.stats = statList;
    const rowS1 = await rowsWith(appS, acS);
    const iA = rowS1.findIndex((r) => r[0] === '自报甲');
    // 四键只在**通电的支路**上出现（求解器写 I/U/P/R）。这里用空 world ⇒ 通常为 0 行，
    // 所以判据写成「stats 行索引 == 四键行数」而**不是**写死的行号：接线与否都成立。
    const nKeys = rowS1.filter((r) => ['电流 I', '两端电压 U', '功率 P', '等效电阻 R'].includes(r[0])).length;
    ok(rowS1.filter((r) => ['自报甲', '自报乙', '自报丙'].includes(r[0])).length === 3
      && iA >= 0 && rowS1.slice(iA, iA + 3).map((r) => r[0]).join('/') === '自报甲/自报乙/自报丙'
      && iA === nKeys,
      `⑪甲 位置契约（2026-10-17 修订）：三行**连续**、顺序即声明顺序，且紧随通用四键之后、`
      + `在任何 type 专属分支**之前**（自报甲 第 ${iA} 行 == 四键 ${nKeys} 行；既有 ${rowS0.length} 行）`);
    const s0k = new Set(rowS0.map(([k, v]) => k + '\u0000' + v));
    const s1k = rowS1.map(([k, v]) => k + '\u0000' + v);
    const missK = [...s0k].filter((x) => !s1k.includes(x));
    ok(missK.length === 0,
      `⑪乙 零回归：既有 ${rowS0.length} 行的文本**一条不少**（缺：${missK.length ? missK.join(' / ') : '无'}）`
      + ' —— 顺序允许 stats 插在其中，见 §6.3 的位置修订');
    const gA = get(rowS1, '自报甲'), gB = get(rowS1, '自报乙'), gC = get(rowS1, '自报丙');
    ok(gA === fmtLiveSrc(3.5) + ' V' && gB === fmtLiveSrc(-0.03125) + ' A' && gC === fmtLiveSrc(12),
      `⑪丙 格式与单位：走**当前真源的 fmtLive 口径**（${fmtLiveSrc(3.5)} / ${fmtLiveSrc(-0.03125)} / ${fmtLiveSrc(12)}）—— 带单位补单位、不带单位不补、负号不被抹（[${gA}] [${gB}] [${gC}]）`);
    acS.state.probeA = 99;
    const moved = get(await rowsWith(appS, acS), '自报甲');
    ok(moved === fmtLiveSrc(99) + ' V',
      `⑪丁 read() **现取**不存快照：改 state 后同一行文本跟着变（[${gA}] → [${moved}]，期望 ${fmtLiveSrc(99)} V）`);
    acS.state.probeA = 3.5;
    acS.def.stats = [{ label: '自报NaN', unit: 'V', read: () => NaN }];
    ok(get(await rowsWith(appS, acS), '自报NaN') === null,
      '⑪戊 取不到（NaN）⇒ **整行不出现**（不占位、不造幻影值）');
    // 能红：掐掉追加逻辑 ⇒ 该行消失
    const mHall = "for (const s of (e.def && e.def.stats) || []) {";
    const hitsH = SRC0m.split(mHall).length - 1;
    ok(hitsH === 1, `⑪己 变异靶点唯一命中（命中 ${hitsH} 次，必须恰好 1 次）`);
    acS.def.stats = statList;
    const gotH = get(await rowsWith(appS, acS, SRC0m.replace(mHall, 'for (const s of []) {')), '自报甲');
    ok(gotH === null, `⑪庚 能红：掐掉追加逻辑 ⇒ 该行消失、对应断言必红（变异体实得 [${gotH}]）`);
  } finally {
    if (statsBak === undefined) delete acS.def.stats; else acS.def.stats = statsBak;
    acS.state.probeA = 3.5;
  }
  const rowS2 = await rowsWith(appS, acS);
  ok(JSON.stringify(rowS2) === JSON.stringify(rowS0),
    `⑪辛 还原彻底：摘掉 stats 后 ${rowS2.length} 行与挂载前**逐字节相同**（探针零副作用）`);

  // ── 第 2 步能成立的**前提**：stats 行必须挡在兜底之前 ───────────────────────
  //    实验设计：alcohollamp 不是电路支路（没有求解器四键），迁移前靠**类型分支**撑住 rows ⇒ 兜底不执行。
  //    用一个变异体把它的类型分支关掉，模拟第 2 步「分支搬走」后的状态，再看兜底会不会抢先。
  //    ⚠ 靶点已经换过**三次**（motor → electrode → alcohollamp，每迁一处就失效一次）。
  //      2026-10-17 八处分支全部迁完后做了**永久修复**：靶点改为 **stats 循环那一行本身** ——
  //      它不再依赖「还有哪个 type 分支没迁」，从此与本任务的迁移进度**彻底解耦**，不会再过期。
  //      实验语义不变：仍然是「把一截机制掐掉，看 stats 行是否还顶得住、兜底会不会抢先」。
  head('⑬ 第 2 步的前提：stats 行挡在兜底之前（否则搬走分支后兜底会抢先灌原始键名）');
  {
    const al = create('alcohollamp', 420, 420);
    const appM = { world: { get: () => null, wires: [] }, markDirty() {} };
    // 靶点 = stats 循环那一行（与 ⑪己 同一个接口点；两组测的是不同的事，共用可接受）
    const kill = { from: 'for (const s of (e.def && e.def.stats) || []) {', to: 'for (const s of [] || []) {' };
    ok(SRC0m.split(kill.from).length - 1 === 1, '⑬甲 stats 循环的变异靶点唯一命中（恰好 1 次）');
    const srcNoStats = SRC0m.replace(kill.from, kill.to);
    const bakM = al.def.stats;
    try {
      al.def.stats = [{ label: '测试行', read: () => '测试' }];
      const rStats = await rowsWith(appM, al, SRC0);
      ok(get(rStats, '测试行') !== null && rStats.length === 1,
        `⑬乙 stats 行在位、且**兜底不执行**（实得 ${rStats.length} 行：[${get(rStats, '测试行')}]）`);
      // 给兜底备一个数值键，否则它无键可收、下一行会退化成与 ⑬乙 同一条路径而失去意义
      al.state.probeA2 = 7;
      const rKilled = await rowsWith(appM, al, srcNoStats);
      ok(get(rKilled, '测试行') === null,
        '⑬丙 ★ 掐掉 stats 循环后「测试行」消失 —— 这条断言**真能红**，不是永真');
      ok(rKilled.some(([k]) => k === 'probeA2'),
        `⑬丁 掐掉后由**兜底**接手（实得 ${rKilled.length} 行：[${rKilled.map(([k]) => k).join('/')}]）`
        + ' ⇒ 正常源码里 stats 行确实抢在兜底前面');
      al.def.stats = [];
      const rFall = await rowsWith(appM, al, SRC0);
      ok(rFall.some(([k]) => k === 'probeA2'),
        `⑬戊 反证：不声明 stats 时兜底照旧执行（实得 ${rFall.length} 行：[${rFall.map(([k]) => k).join('/')}]）`);
    } finally {
      al.def.stats = bakM;
    }
  }

  // ── 第 2 步 迁移样板：thermometer 的「测得温度」已由器材自报 ─────────────────
  //    这一步验证迁移的**核心判据**：迁移后同一器材的行文本与顺序必须与迁移前逐字相同。
  //    期望值不写死字符串，而是用**迁移前那段算术**现算 —— 否则断言会在精度口径变化时失去分辨力。
  head('⑭ 第 2 步迁移样板：thermometer 的「测得温度」走 def.stats');
  {
    const th = create('thermometer', 430, 430);
    const appTh = { world: { get: () => null, wires: [] }, markDirty() {} };
    const rTh = await rowsWith(appTh, th);
    const want = (th.state.temp ?? 25).toFixed(2) + ' ℃';
    ok(get(rTh, '测得温度') === want,
      `⑭甲 迁移后文本与迁移前**逐字相同**：[${get(rTh, '测得温度')}] == [${want}]`);
    ok(rTh.length === 1,
      `⑭乙 只有这一行（stats 顶住 rows ⇒ 兜底不执行；实得 ${rTh.length} 行：${rTh.map(([k]) => k).join('/')}）`);
    th.state.temp = 31.4;
    ok(get(await rowsWith(appTh, th), '测得温度') === (31.4).toFixed(2) + ' ℃',
      '⑭丙 读数现取、跟着 state 走（不是建行那一刻的快照）');
    th.state.temp = undefined;
    ok(get(await rowsWith(appTh, th), '测得温度') === (25).toFixed(2) + ' ℃',
      '⑭丁 `?? 25` 的缺省语义保留（undefined ⇒ 25 ℃）');
    ok(!SRC0.includes("if (e.type === 'thermometer')"),
      '⑭戊 面板里的 thermometer 分支确已删除（把它加回去 ⇒ 本条必红）');
    const dth = create('thermometer', 0, 0).def;
    ok(Array.isArray(dth.stats) && dth.stats.length === 1 && dth.stats[0].label === '测得温度',
      `⑭己 器材侧 stats 声明到位（${(dth.stats || []).map((s) => s.label).join('/') || '无'}）`);
  }

  // ── 第 2 步 迁移 2~4：phmeter / phpaper / balance ──────────────────────────
  //    这三处专门用来钉「同名不同义」：pH 计与试纸在面板上**同叫「测得 pH」**，
  //    但一个是 `?? 7`（数值缺省）、一个是 `'未浸取'`（条件文案）—— 迁移时必须分开写。
  head('⑮ 第 2 步迁移：phmeter / phpaper / balance（数值缺省 vs 条件文案）');
  {
    const appC = { world: { get: () => null, wires: [] }, markDirty() {} };

    // ── pH 计：`?? 7` 是**数值缺省** ──
    const pm = create('phmeter', 440, 440);
    let v = get(await rowsWith(appC, pm), '测得 pH');
    ok(v === (7).toFixed(2), `⑮甲 phmeter 初值逐字相同：[${v}] == [7.00]`);
    pm.state.pH = 3.14159;
    v = get(await rowsWith(appC, pm), '测得 pH');
    ok(v === (3.14159).toFixed(2), `⑮乙 phmeter 现取：[${v}]（迁移前算式给 [${(3.14159).toFixed(2)}]）`);
    pm.state.pH = undefined;
    v = get(await rowsWith(appC, pm), '测得 pH');
    ok(v === (7).toFixed(2), `⑮丙 phmeter 的数值缺省保留（[${v}]）`);

    // ── pH 试纸：`'未浸取'` 是**条件文案** —— 同名，不同义 ──
    const pp = create('phpaper', 440, 440);
    v = get(await rowsWith(appC, pp), '测得 pH');
    ok(v === '未浸取', `⑮丁 phpaper 未浸取时给的是**文案**：[${v}]`);
    pp.state.pH = 5.67;
    v = get(await rowsWith(appC, pp), '测得 pH');
    ok(v === (5.67).toFixed(1), `⑮戊 phpaper 已浸取走 digits:1：[${v}]（迁移前算式给 [${(5.67).toFixed(1)}]）`);
    pp.state.pH = undefined;
    v = get(await rowsWith(appC, pp), '测得 pH');
    ok(v === '未浸取', `⑮己 phpaper 能回到未浸取（现取，[${v}]）`);

    // ── 天平：数值行 + **条件文本行** ──
    const bl = create('balance', 440, 440);
    const rB0 = await rowsWith(appC, bl);
    ok(get(rB0, '秤上质量') === (0).toFixed(2) + ' g', `⑮庚 balance 初值逐字相同：[${get(rB0, '秤上质量')}]`);
    ok(get(rB0, '称量对象') === null, '⑮辛 balance 空盘时**没有**「称量对象」行（条件行语义保留）');
    bl.state.mass = 12.345;
    bl.state.onPlate = '烧杯';
    const rB1 = await rowsWith(appC, bl);
    ok(get(rB1, '秤上质量') === (12.345).toFixed(2) + ' g', `⑮壬 balance 现取：[${get(rB1, '秤上质量')}]`);
    ok(get(rB1, '称量对象') === '烧杯', `⑮癸 balance 有对象时才出现：[${get(rB1, '称量对象')}]`);
    bl.state.onPlate = '';
    ok(get(await rowsWith(appC, bl), '称量对象') === null,
      '⑮子 空字符串也**不出现**（`|| undefined` 保住了「falsy ⇒ 不出现」，否则会多一个空文本行）');

    // ── 源码防线 + 器材侧 ──
    const gone = ["if (e.type === 'balance')", "if (e.type === 'phmeter')", "if (e.type === 'phpaper')"];
    const left = gone.filter((s) => SRC0.includes(s));
    ok(left.length === 0, `⑮丑 面板里三条分支确已删除（残留：${left.join('/') || '无'}）`);
    const schema = [['phmeter', '测得 pH'], ['phpaper', '测得 pH'], ['balance', '秤上质量']];
    const miss = schema.filter(([t, l]) => {
      const d = create(t, 0, 0).def;
      return !(Array.isArray(d.stats) && d.stats.some((s) => s.label === l && typeof s.read === 'function'));
    });
    ok(miss.length === 0, `⑮寅 三件器材的 stats 声明到位（缺：${miss.map(([t]) => t).join('/') || '无'}）`);
  }

  // ── 第 2 步 迁移 5：motor（文本状态 + digits:0 取整）──────────────────────
  head('⑯ 第 2 步迁移：motor（文本状态 + digits:0 取整，含负 .5 边界）');
  {
    const appM2 = { world: { get: () => null, wires: [] }, markDirty() {} };
    const mt = create('motor', 450, 450);
    let r = await rowsWith(appM2, mt);
    ok(get(r, '运转状态') === '停止' && get(r, '转速') === Math.round(0) + ' rad/s',
      `⑯甲 motor 初值逐字相同：状态 [${get(r, '运转状态')}] / 转速 [${get(r, '转速')}]`);
    mt.state.on = true; mt.state.omega = 123.456;
    r = await rowsWith(appM2, mt);
    ok(get(r, '运转状态') === '转动中', `⑯乙 状态现取：[${get(r, '运转状态')}]`);
    ok(get(r, '转速') === Math.round(123.456) + ' rad/s',
      `⑯丙 转速走取整：[${get(r, '转速')}] == [${Math.round(123.456)} rad/s]`);
    // ★ 负 .5 边界：这一条专门证明 digits:0 用的是 Math.round 而不是 toFixed(0)
    mt.state.omega = -0.5;
    r = await rowsWith(appM2, mt);
    const wantNeg = Math.round(-0.5) + ' rad/s', alt = (-0.5).toFixed(0) + ' rad/s';
    ok(get(r, '转速') === wantNeg,
      `⑯丁 ★ 负 .5 边界：[${get(r, '转速')}] == [${wantNeg}]（改用 toFixed(0) 会得 [${alt}] ⇒ 这条就是区分器）`);
    const iI = r.findIndex(([k]) => k === '电流 I');
    const iN = r.findIndex(([k]) => k === '转速');
    ok(iN >= 0 && (iI < 0 || iI < iN),
      `⑯戊 顺序：四键若出现必在 stats 行之前（未通电时四键不出，故允许缺席；转速在第 ${iN} 行）`);
    ok(!SRC0.includes("if (e.type === 'motor')"), '⑯己 面板里的 motor 分支确已删除');
    const dm = create('motor', 0, 0).def;
    ok(Array.isArray(dm.stats) && dm.stats.length === 2,
      `⑯庚 器材侧两条声明到位（${(dm.stats || []).map((s) => s.label).join('/')}）`);
  }

  // ── 第 2 步 **未迁** 的一处：thermistor 卡在「自适应单位」这个接口缺口 ──────────
  head('⑰ 接口缺口三的历史回执：thermistor 的自适应单位已由 `fmt` 字段接住（原为「未迁登记」）');
  {
    // 本组原本登记「thermistor 未迁，因为它用 fmtR 而 digits 表达不了」。
    // 第 2 步迁移 7 补齐了接口（`fmt` 字段，plans/11 §6.5），该缺口已关闭 ⇒ 这组**转型为回执**，
    // 仍锁住两件事：(a) 面板分支确实搬走了；(b) 器材声明里带的确实是 `fmt: fmtR` 这个函数本身，
    // 而不是把 fmtR 的逻辑抄进 `read`（后者会让 §6.5 的「可声明性」落空）。
    ok(!SRC0.includes("if (e.type === 'thermistor')"),
      '⑰甲 thermistor 的面板分支已删除（缺口关闭）');
    const dt = create('thermistor', 0, 0).def;
    const sR = (dt.stats || []).find((s) => s.label === '当前阻值');
    ok(sR && sR.fmt === fmtR,
      '⑰乙 自适应单位由 `fmt: fmtR` 承载（不是把 fmtR 的逻辑抄进 read）');
    ok(SRC0.includes('if (s.fmt) {'),
      '⑰丙 渲染端确实按 `fmt` 优先（源码级防线，防回退；也防有人把 fmt 挪到有限性检查之后）');
  }

  // ── 第 2 步 迁移 7：thermistor（三态之外的第三支：fmt 自适应单位）──────────────
  head('⑲ 第 2 步迁移 7：thermistor（`fmt` 自适应单位：Ω / kΩ / MΩ）');
  {
    const appT = { world: { get: () => null, wires: [] }, markDirty() {} };
    const th = create('thermistor', 470, 470);
    const dth = th.def;
    const sRes = (dth.stats || []).find((s) => s.label === '当前阻值');
    // ① fmt 在**定义上**就是 fmtR —— 这条断言正是 plans/11 §6.5 说的「可声明」的用处
    ok(sRes && sRes.fmt === fmtR,
      `⑲甲 「当前阻值」声明的就是 \`fmt: fmtR\` 本身（${sRes && sRes.fmt === fmtR ? '同一函数引用' : '缺失或不同'}）`);
    ok(sRes && sRes.digits === undefined && sRes.unit === undefined,
      '⑲乙 声明 fmt 的那行不再填 digits/unit（避免两套格式口径并存）');

    // ② 三行逐字相同（期望值一律用**迁移前的算式**现算，不写死字符串）
    let r = await rowsWith(appT, th);
    const R0 = th.resistanceNow ? th.resistanceNow() : th.state.R;
    ok(get(r, '感知温度') === (th.state.temp ?? 25).toFixed(1) + ' ℃',
      `⑲丙 感知温度逐字相同：[${get(r, '感知温度')}] == [${(th.state.temp ?? 25).toFixed(1)} ℃]`);
    ok(get(r, '温度来源') === (th.state.source || '室温'), `⑲丁 温度来源是文案：[${get(r, '温度来源')}]`);
    ok(get(r, '当前阻值') === fmtR(R0),
      `⑲戊 ★ 当前阻值走 fmtR：[${get(r, '当前阻值')}] == [${fmtR(R0)}]`);

    // ③ 三个量级各来一次 —— 证明「自适应」真的在换单位（这就是 fmt 存在的理由）
    const lv = [[820, 'Ω'], [4.7e3, 'kΩ'], [2.2e6, 'MΩ']];
    const got = [];
    for (const [Rv] of lv) {
      th.resistanceNow = () => Rv;
      got.push(get(await rowsWith(appT, th), '当前阻值'));
    }
    const bad = lv.filter(([, u], i) => !String(got[i]).includes(u));
    ok(bad.length === 0,
      `⑲己 三个量级各换一次单位：${got.join(' / ')}（不符：${bad.map(([Rv, u]) => Rv + 'Ω 缺 ' + u).join('；') || '无'}）`);

    // ④ 取不到阻值时 fmtR 给 '∞' —— 它返回的是**字符串**，所以三态的第一支直接放行，不会整行消失
    th.resistanceNow = () => NaN;
    r = await rowsWith(appT, th);
    ok(get(r, '当前阻值') === '∞',
      `⑲庚 阻值取不到时给 '∞'（fmt 返回字符串 ⇒ 直接上屏）：[${get(r, '当前阻值')}]`);

    // ⑤ 器材侧
    ok(Array.isArray(dth.stats) && dth.stats.length === 3,
      `⑲辛 器材侧三条声明到位（${(dth.stats || []).map((s) => s.label).join('/')}）`);
  }

  // ── ⑳ **顺序盲区**补测（2026-10-17，由 inspector-probe 的外部判据暴露后补上）────────
  //    本探针原先只按**标签取值**（get(rows, label)），**不看顺序** ⇒ 整批迁移「绿着」通过了，
  //    而实际上 stats 行被放在了文件后段，跑到了 B5「实时/瞬时」等分支**之后**。
  //    抓住它的是 `tools/inspector-probe.mjs` 的「旧行必须是新行的前缀（只许尾部追加）」判据。
  //    ⇒ 这里补上顺序维度：不再只问「值对不对」，还要问「排在第几行」。
  head('⑳ 顺序盲区补测：stats 行必须排在 type 专属分支行**之前**（行序列逐位相同）');
  {
    const appO = { world: { get: () => null, wires: [] }, markDirty() {} };
    // thermistor 是**唯一**「既有 stats 行、又会被后段分支追加行」的器材：
    // B5 的 `resistanceAt` + `resistanceNow` 双条件它也满足 ⇒ 两行都会给它出。
    const thO = create('thermistor', 480, 480);
    const rO = await rowsWith(appO, thO);
    const iStats = rO.findIndex(([k]) => k === '感知温度');
    const iB5 = rO.findIndex(([k]) => k === '实时电阻 R(T)');
    const iB5b = rO.findIndex(([k]) => k === '瞬时电阻 R(u)');
    ok(iStats >= 0, `⑳甲 thermistor 的 stats 行在位（第 ${iStats} 行）`);
    ok(iB5 >= 0 && iB5b >= 0,
      `⑳乙 后段的 B5 两行仍在（第 ${iB5} / ${iB5b} 行）—— 先确认它们存在，下面的比较才有意义`);
    ok(iStats < iB5 && iStats < iB5b,
      `⑳丙 ★ 顺序：stats 三行（自第 ${iStats} 行起）必须排在 B5「实时/瞬时」两行**之前**`
      + `（实得 ${iStats} vs ${iB5}/${iB5b}）—— 迁移前 thermistor 的分支就在这个位置`);
    // 全序快照：把已迁器材的实际行序列钉住，任何位置漂移都会红（含未来新增分支插队）。
    // ⚠ 这里用**空 world**（没有电路）⇒ 求解器四键（I/U/P/R）不会出现，所以快照只钉
    //    「type 专属分支之间的相对顺序」。四键的顺序由 `tools/inspector-probe.mjs` 的
    //    「旧行必须是新行前缀」判据在**有电路**的 world 上覆盖（本组补的是它管不到的顺序维度）。
    const seq = {
      thermistor: ['感知温度', '温度来源', '当前阻值', '实时电阻 R(T)', '瞬时电阻 R(u)'],
      motor: ['运转状态', '转速'],
    };
    for (const [type, want] of Object.entries(seq)) {
      const rr = await rowsWith(appO, create(type, 480, 480));
      const gotSeq = rr.map(([k]) => k).filter((k) => k !== '功率 P');  // 功率 P 只在 P>1e-9 时出现
      const bad = want.filter((k, i) => gotSeq[i] !== k);
      ok(bad.length === 0,
        `⑳丁 ${type} 的**行序列逐位相同**：期望 [${want.join(' → ')}]，实得 [${gotSeq.join(' → ')}]`
        + `（首位不符：${bad[0] || '无'}）`);
    }
  }

  // ── 第 2 步 迁移 8（**最后一处**）：alcohollamp ＋ `read` 的第二参数 ctx ─────────
  head('㉑ 第 2 步迁移 8（末处）：alcohollamp ＋ `read(e, ctx)` 视野（plans/11 §6.6）');
  {
    const appL = { world: new World(), markDirty() {} };
    const beaker = create('beaker', 500, 500);
    appL.world.add(beaker);
    const al = create('alcohollamp', 480, 480);
    appL.world.add(al);

    let r = await rowsWith(appL, al);
    ok(get(r, '状态') === '未点燃', `㉑甲 状态逐字相同：[${get(r, '状态')}]`);
    ok(get(r, '加热对象') === null, '㉑乙 没有加热对象时**整行不出现**（保住原 `if (st.target)` 语义）');

    al.state.target = beaker.id;
    r = await rowsWith(appL, al);
    ok(get(r, '加热对象') === beaker.def.name,
      `㉑丙 ★ 有对象时取**它自己的名字**：[${get(r, '加热对象')}] == [${beaker.def.name}]（这就是 ctx 的用途）`);

    al.state.target = 'no-such-id';
    r = await rowsWith(appL, al);
    ok(get(r, '加热对象') === '-', `㉑丁 对象不存在时给 '-'（原式 \`?.def.name || '-'\`）：[${get(r, '加热对象')}]`);

    // 接口契约：新声明用两参、旧声明仍是一参 ⇒ 加参数没有破坏任何既有声明
    const da = (al.def.stats || []).find((s) => s.label === '加热对象');
    ok(da && da.read.length === 2,
      `㉑戊 「加热对象」的 read 声明了第二个参数（arity=${da && da.read.length}）`);
    const dt = create('thermometer', 0, 0).def.stats[0];
    ok(dt.read.length === 1,
      `㉑己 旧声明仍是单参（arity=${dt.read.length}）⇒ 向后兼容成立，不必改已有声明`);

    // ctx 缺失时也不许炸（§6.6 约束 3）
    ok(da && (() => { try { da.read({ state: { target: 'x' }, props: {} }, undefined); return true; } catch (err) { return false; } })(),
      '㉑庚 ★ `ctx` 为空时 read 不抛错（探针 / 离线渲染可能没有 app）');

    // 源码防线
    ok(!SRC0.includes("if (e.type === 'alcohollamp')"),
      '㉑辛 面板里的 alcohollamp 分支确已删除 —— **八处类型分支全部迁完**');
    ok(SRC0.includes('s.read(e, ctx)'), '㉑壬 渲染端确实把 ctx 传下去了');
  }

  // ── ㉒ 第 3 步「替换」的**前提核实**：哪个分类的全部器材都声明了 stats？──────────────
  //    第 2 步是「逐条把类型分支改写成声明」，第 3 步是「当某域**全部**器材都有 stats 时，
  //    该域的 STATE_LABELS 表可退役」。所以第 3 步能不能做取决于覆盖率，而不是取决于意愿。
  //
  //    ⚠ 本组实测纠正了一个**很容易搞错的读法**：`STATE_LABELS[cat]` 里的 `cat` 是
  //      **`e.def.cat`（中文分类）**，不是 `e.def.domain`（域，全仓只有 chemistry / physics 两个值）。
  //      物理器材的分类名恰好与 STATE_LABELS 的键同名（力学/热学/光学/电磁/声学）⇒
  //      那张表**看起来像「按域」、实际是「按分类」**。覆盖率必须按 cat 统计才有意义。
  //    本组写成**可红断言**：一旦某个分类补满 100%，㉒丙 会红 —— 那个红是**有意的提醒**
  //    （「可以去执行第 3 步了」），不是缺陷。
  head('㉒ 第 3 步「替换」的前提核实：STATE_LABELS 按 **def.cat**（中文分类）查表；覆盖率**只统计真正读域表的件**');
  {
    const defs = list();
    const hasStats = (d) => Array.isArray(d.stats) && d.stats.length > 0;
    const keys = Object.keys(STATE_LABELS).filter((k) => k !== '通用');
    const catsInDefs = new Set(defs.map((d) => d.cat).filter(Boolean));
    ok(keys.every((k) => catsInDefs.has(k)),
      `㉒甲 STATE_LABELS 的 ${keys.length} 个分类键（${keys.join('/')}）在 def.cat 里**都存在**`
      + ' —— 据此确认这套查表是按 cat 生效的（不是按 domain）');
    // ★★ 第 3 步**收官**：`def.cat` 的**全部**分类表都已退役，`STATE_LABELS` 只剩「通用」兜底。
    //    退役一律**分两步** —— 先把「域盲四键退场」豁免的证据从域表迁到 `stats` 侧（`blindRetired` 条件④的 b)），再撤表。
    //    ⚠ 每分类都不是「分类里每件都自报」：热学 4/6（`calorimeter`/`icebath` 走器皿面板）、
    //      光学 4/6（`convexlens`/`screen` 早有 stats）、电磁 5/6（`bfield` 无数字可读）——
    //      充分条件始终是「**用域表的件都自报了**」（见报告 §二十三）。
    ok(keys.length === 0,
      '㉒甲2 ★★ 第 3 步**收官**：`STATE_LABELS` 的**分类表已全部退役**（现存只剩「通用」兜底）'
      + ' —— 五分类共 **25 件**由 `def.stats` 自报（声学 4 · 力学 8 · 热学 4 · 光学 4 · 电磁 5）；'
      + '§⑥ 在运行时真值上逐件证明未丢量/未改写/未变序');
    const statDefs = defs.filter(hasStats);
    // ⚠ 用**分组统计 + 下界**，不硬编码总数：硬编码的总数每加一批迁移就红一次，
    //    那是**噪音**而不是信号。真正该红的是「某分类已满却未退役」（见 `㉒丙`），
    //    以及「stats 声明**变少**了」（这里是 `>= 12` 下界，删任何一处都会红）。
    const byCat = {};
    for (const d of statDefs) { const c = d.cat || '?'; (byCat[c] = byCat[c] || []).push(d.type); }
    ok(statDefs.length >= 12,
      `㉒乙 全仓 ${statDefs.length} 件声明 stats（按分类：`
      + Object.entries(byCat).map(([c, a]) => `${c} ${a.length} 件`).join(' · ')
      + `）｜${statDefs.map((d) => d.type).sort().join(', ')}`);
    // ══ ⚠ 口径修正（热学勘查，2026-10-17）══════════════════════════════════════════
    // 旧口径按 `def.cat` 给**整个分类**数「几件声明了 stats」，再与 `all.length` 比。那是**错的**：
    // 走显式分支的器材（器皿面板 `:350`、三表 `:429`、电学分支 `:274~:411`）在兜底之前就已
    // `rows.push` ⇒ `if (!rows.length)` 永不成立 ⇒ **从不读 `STATE_LABELS`**。
    // 实测反例：`calorimeter` 的 state 只有 {Tf,T1,T2}，面板却出「液体体积/温度/pH」。
    // 对这类器材**不该**写 stats —— 写了反而**有害**：stats 行在 `:211`、器皿行在 `:350`，
    // 面板会变成「stats 在前、器皿在后」，与现在相反（见报告 §23.2）。
    // ⇒ 判据改为**实测**：临时清空 `STATE_LABELS`，看这件的行**是否变化**。
    //    变了 ⇒ 真的依赖域表 ⇒ 必须声明 stats 之后才能退役该表；
    //    没变 ⇒ 与域表无关 ⇒ 不纳入覆盖率（`calorimeter`/`icebath` 就是这样）。
    // 这样「达标」的含义才**对上**「退役」的充分条件：**用域表的都自报了**，
    // 而不是「分类里每一件都自报了」—— 后者只在「分类里每件都走兜底」时才等价，
    // 力学 8/8 与声学 4/4 恰好满足这个巧合，所以前两例**侥幸没暴露**这个偏差。
    const savedAll = { ...STATE_LABELS };
    const probeDefs = defs.filter((d) => savedAll[d.cat]);
    // ⚠⚠ 必须**绕过 `stats`** 再测，否则判据与 `hasStats` 耦合、永不红：
    //    `stats` 一旦存在，兜底（`if (!rows.length)`）就不执行 ⇒ 摘掉域表也不会让行变化
    //    ⇒ `usesTable` 对**所有已自报的件**恒为 false ⇒ `dep` 里只剩尚未自报的件
    //    ⇒ `n` 恒为 0 ⇒ `ready` 恒空 ⇒ `㉒丙` **永远不会红**（一个永不红的断言是废的）。
    //    正确问法是：「**假如它没有自报**，它会不会用域表？」⇒ 临时摘掉 `def.stats`，
    //    再比较「有域表」与「无域表」两种情形 —— 差异只能来自域表。
    const usesTable = (d) => {
      const e = ents.find((x) => x.type === d.type);
      const cat = d.cat;
      if (!e || !STATE_LABELS[cat]) return false;
      const savedStats = e.def.stats;
      const savedCat = STATE_LABELS[cat];
      try {
        delete e.def.stats;
        delete STATE_LABELS[cat];
        const noTable = JSON.stringify(liveRows(e));
        STATE_LABELS[cat] = savedCat;
        const withTab = JSON.stringify(liveRows(e));
        return noTable !== withTab;
      } finally {
        // ⚠ 只摘本分类那一项，必须保留「通用」：`inspector.js:460` 硬读 `STATE_LABELS.通用[k]`，
        //   连它一起删会让兜底抛 TypeError ⇒ 测出的「行变了」只是崩溃的假象。
        if (savedStats === undefined) delete e.def.stats; else e.def.stats = savedStats;
        STATE_LABELS[cat] = savedCat;
      }
    };
    const cov = keys.map((k) => {
      const dep = probeDefs.filter((d) => d.cat === k && usesTable(d));   // 该分类里**真的读域表**的件
      const off = dep.filter((d) => !hasStats(d));                        // 其中尚未自报的
      return { k, n: dep.length - off.length, t: dep.length, off: off.map((d) => d.type) };
    });
    // ⚠ 收官后本项**不再有可检对象**（`keys` 为空 ⇒ `cov` 为空 ⇒ `ready` 恒空）。若照原样留着，
    //   它会退化成**同义反复** —— 这是本探针第三次遇到「永不红的断言」形态
    //   （第一次：`usesTable` 删了「通用」而崩；第二次：判据与 `hasStats` 耦合；第三次：收官后靶子消失）。
    //   ⇒ 改为**终态断言**：分类表必须全退役、且覆盖率口径必须仍然"空"。它现在**能红** ——
    //     只要有人往 `STATE_LABELS` 里加回任何一个分类表，`keys` 不再为空，本项立刻红。
    ok(keys.length === 0,
      '㉒丙 第 3 步**已收官**：`STATE_LABELS` 已无可迁的分类表，故不再有「已达标但尚未退役」的对象'
      + '（`剩余分类键 `' + (keys.join('/') || '无') + '`）'
      + '。⚠ 本项现在守的是「不许把分类表加回来」—— 覆盖率判据 `usesTable`（先摘 `def.stats`、'
      + '再比「有表/无表」两种输出）已随本步完成而卸任，其结论见 `㉒甲2`');
    info('㉒丙 口径自检：走显式分支、与域表无关的件**不计入**覆盖率 —— '
      + keys.map((k) => {
        const all = defs.filter((d) => d.cat === k).length;
        const c = cov.find((x) => x.k === k) || { t: 0, n: 0 };
        return `${k} ${c.t}/${all}`;
      }).join(' · ')
      + '（分子/分母：真正读域表的件 / 该分类全部件）');
    ok(defs.filter((d) => d.cat === '通用').length === 0,
      '㉒丁 「通用」是兜底表、不是 def.cat 的取值 —— 第 3 步退役时**必须保留**它'
      + '（各分类认不出的键都落到这里）');
  }

  // ── ㉓ 第 3 步**首个试点**（声学，最小分类 4 件）──────────────────────────────
  //    第 3 步＝「某分类全部器材都有 stats ⇒ 退役该分类的 STATE_LABELS 行」。
  //    ⚠ **逐字相同这条硬判据由 §⑥ 承担**，不是本组 —— 因为只有 §⑥ 用的是**跑过 step 的实体**
  //      （运行时真值），而本组的 `create()` 只有 `def.state` 的初值。这个区别是**踩过坑的**：
  //      最初本组拿初值当基线，四件全部「逐字相同」却掩盖了运行时的**丢行**（`resonancetube`
  //      初值 5 键、运行时 8 键）—— 基线选错场合，断言再绿也没有意义。
  //    本组只锁**准入条件**：声学 4 件都声明了 stats，且都没写 digits。
  head('㉓ 第 3 步首个试点（声学 4 件）：统计口径正确 —— 逐字相同由 §⑥（跑过 step）承担');
  {
    const ac = list().filter((d) => d.cat === '声学');
    ok(ac.length === 4, `㉓甲 声学恰好 4 件：${ac.map((d) => d.type).sort().join(', ')} —— 第 3 步的首个试点`);
    ok(ac.every((d) => Array.isArray(d.stats) && d.stats.length > 0),
      `㉓乙 声学 4 件全部声明了 stats（行数 ${ac.map((d) => d.type + ':' + d.stats.length).sort().join(' ')}）`
      + ' —— 第 3 步退役 STATE_LABELS.声学 的**准入条件**成立');
    ok(ac.every((d) => d.stats.every((s) => !('digits' in s))),
      '㉓丙 四件都用缺省 digits（落回 fmtLive）—— 与兜底同一条数字口径，退役后格式不会变');
  }

  // ── 第 2 步 迁移 6：electrode（符号前缀 + 条件文案）────────────────────────
  head('⑱ 第 2 步迁移 6：electrode（含 + 符号前缀与条件文案）');
  {
    const appE = { world: { get: () => null, wires: [] }, markDirty() {} };
    const el = create('electrode', 460, 460);
    let r = await rowsWith(appE, el);
    ok(get(r, '电极材料') === '石墨（惰性）', `⑱甲 electrode 材料默认值逐字相同：[${get(r, '电极材料')}]`);
    ok(get(r, '标准电极电势') === '不参与原电池', `⑱乙 无 E0 时给**文案**：[${get(r, '标准电极电势')}]`);
    el.props.metal = 'Cu';
    el.probe = { kind: 'electrode', E0: 0.34 };
    r = await rowsWith(appE, el);
    ok(get(r, '电极材料') === 'Cu', `⑱丙 材料现取：[${get(r, '电极材料')}]`);
    ok(get(r, '标准电极电势') === '+0.34 V',
      `⑱丁 ★ 正 E0 带 **+** 前缀：[${get(r, '标准电极电势')}]（digits/unit 组合只会给 [0.34 V] ⇒ 这行必须走字符串）`);
    el.probe = { kind: 'electrode', E0: -0.76 };
    r = await rowsWith(appE, el);
    ok(get(r, '标准电极电势') === '-0.76 V', `⑱戊 负 E0 不加 + ：[${get(r, '标准电极电势')}]`);
    el.probe = { kind: 'electrode', E0: 0 };
    r = await rowsWith(appE, el);
    ok(get(r, '标准电极电势') === '0.00 V', `⑱己 E0=0 既不加 + 也不算"不参与"：[${get(r, '标准电极电势')}]`);
    el.probe = { kind: 'electrode', E0: null };
    r = await rowsWith(appE, el);
    ok(get(r, '标准电极电势') === '不参与原电池', `⑱庚 E0=null 回到文案：[${get(r, '标准电极电势')}]`);
    ok(!SRC0.includes("if (e.type === 'electrode')"), '⑱辛 面板里的 electrode 分支确已删除');
    const de = create('electrode', 0, 0).def;
    ok(Array.isArray(de.stats) && de.stats.length === 2,
      `⑱壬 器材侧两条声明到位（${(de.stats || []).map((s) => s.label).join('/')}）`);
  }

  // ── 第 2 步的**前置接口**：digits 定精度 + read() 返回文本 ──────────────────
  //    为什么需要（实测，见 plans/11 §6.3 的落地发现）：八处类型分支里多数是**文本行**
  //    （状态 / 来源 / 对象 / 材料 / 条件占位），另有 toFixed(1)/toFixed(2)/Math.round 的定精度行 ——
  //    三字段接口承载不了，直迁必然改变文本，违反第 2 步「与迁移前逐字相同」的判据。
  head('⑫ 第 2 步的前置接口：digits 定精度 + read() 返回文本');
  {
    const acT = create('acsource', 410, 410);
    const appT = { world: { get: () => null, wires: [] }, markDirty() {} };
    acT.state.probeN = 0.03125; acT.state.probeM = 123.456;
    const bakT = acT.def.stats;
    try {
      acT.def.stats = [
        { label: '定点2', unit: 'V', digits: 2, read: (e) => e.state.probeN },
        { label: '定点0', unit: 'rad/s', digits: 0, read: (e) => e.state.probeM },
        { label: '缺省', read: (e) => e.state.probeN },
        { label: '文本行', read: (e) => (e.state.flag ? '燃烧中' : '未点燃') },
        { label: '取不到', read: () => undefined },
      ];
      acT.state.flag = true;
      const r1 = await rowsWith(appT, acT);
      ok(get(r1, '定点2') === '0.03 V',
        `⑫甲 digits 定精度：0.03125 → [${get(r1, '定点2')}]（缺省口径本会给 ${fmtLiveSrc(0.03125)} V，所以这条能分辨）`);
      ok(get(r1, '定点0') === '123 rad/s', `⑫乙 digits:0 取整：[${get(r1, '定点0')}]`);
      ok(get(r1, '缺省') === fmtLiveSrc(0.03125),
        `⑫丙 digits 缺省 ⇒ 落回 fmtLive，第 1 步的既有口径不变（[${get(r1, '缺省')}]）`);
      ok(get(r1, '文本行') === '燃烧中', `⑫丁 read() 返回字符串 ⇒ 原样上屏（[${get(r1, '文本行')}]）`);
      acT.state.flag = false;
      ok(get(await rowsWith(appT, acT), '文本行') === '未点燃',
        '⑫戊 文本行也随 state 变（现取，不是存快照）');
      ok(get(r1, '取不到') === null, '⑫己 read() 给 undefined ⇒ 整行不出现');
      // 靶点锚在「digits 真正生效」那一句上（fmtBy 现在是多行实现，锚点跟着更新）
      const mDigits = 'return digits === 0 ? String(Math.round(v)) : v.toFixed(digits);';
      const hitsD2 = SRC0m.split(mDigits).length - 1;
      ok(hitsD2 === 1, `⑫庚 变异靶点唯一命中（命中 ${hitsD2} 次，必须恰好 1 次）`);
      acT.def.stats = [{ label: '定点2', unit: 'V', digits: 2, read: (e) => e.state.probeN }];
      const gotD = get(await rowsWith(appT, acT, SRC0m.replace(mDigits, 'return fmtLive(v);')), '定点2');
      ok(gotD === fmtLiveSrc(0.03125) + ' V',
        `⑫辛 能红：掐掉 digits ⇒ 精度回落到 fmtLive、⑫甲 必红（变异体实得 [${gotD}]）`);
      const mText = "if (typeof v === 'string') { rows.push([s.label, v]); continue; }";
      const hitsT = SRC0m.split(mText).length - 1;
      ok(hitsT === 1, `⑫壬 文本分支变异靶点唯一命中（命中 ${hitsT} 次）`);
    } finally {
      if (bakT === undefined) delete acT.def.stats; else acT.def.stats = bakT;
    }
  }

  // ── derive 白名单（plans/11 §6.4）：器材包**必须**能声明 stats，否则接口不完整 ──
  //    行为断言：真调一次 derive，看包声明的统计量是否进了派生定义（测完 remove 掉，不留痕）。
  {
    const dd = derive({ proto: 'acsource', type: 'probe-stats-derived', name: '自报测试源',
      stats: [{ label: '包自报', unit: 'V', read: (e) => e.state.probeD }] }, { id: 'probe-pack', name: '探针包' });
    ok(Array.isArray(dd.stats) && dd.stats.length === 1 && dd.stats[0].label === '包自报',
      `⑪壬 derive 采纳 stats：器材包声明的统计量进了派生定义（${(dd.stats || []).map((s) => s.label).join('/') || '无'}）`);
    ok(dd.derived === true && dd.pack === 'probe-pack',
      `⑪癸 派生定义其余字段不受影响（derived=${dd.derived} / pack=${dd.pack}）`);
    remove('probe-stats-derived');
    ok(!list().some((d) => d.type === 'probe-stats-derived'), '⑪子 探针零残留：测完的派生器材已从注册表卸下');
  }
  // 源码防线：白名单那一行被删掉 ⇒ 上面 ⑪壬 必红，同时这一条也必红（双保险）
  {
    const R0 = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'equipment', 'registry.js'), 'utf8');
    ok(/stats:\s*entry\.stats\s*\|\|\s*base\.stats/.test(R0),
      '⑪丑 源码防线：derive 的字段白名单里确有 stats（删掉它 ⇒ ⑪壬 与本条同时必红）');
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
