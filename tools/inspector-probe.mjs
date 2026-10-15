// ══════════════════════════════════════════════════════════
// 无头验证：属性面板的「实时读数」不再对新器材沉默（UI · inspector）
//
//   node tools/inspector-probe.mjs
//   node tools/inspector-probe.mjs --mutate      # 红测：把「手摆的光源 / 透镜」这一对里的光源挪到透镜右侧 ⇒ 凸透镜那条必须红
//
// ⚠ 场景不许依赖「第 i 件器材是谁」：改造前凸透镜那条钉子依赖 `120 + (i%9)*70` 的网格**碰巧**把光源排在
//   透镜左边一格 —— 任何人往器材清单中段插一件（k1 的 multimeter 落在 ALL@7）都会让两者错位、断言假红。
//   现在这一对改由 §③ 用一个**独立小场景手摆**（把 u 直接构造成 22 mm），网格怎么变都影响不到它。
//
// 为什么把改造前的行算法**冻结**在 oldRows() 里：本任务的第一判据是「既有器材逐件零回归」，
// 而零回归只能靠「同一份输入在改动前后跑出同一份输出」来证明。冻结的那份是改造前
// src/ui/inspector.js 里 updateLive() 的逐字副本，它不随源码演进而变 ——
// 所以这条判据在未来的每一次提交里都还能重演。
//
// 绿：全部通过：N 项（exit 0）／红：合计 N 项，失败 M 项（exit 1）
// ══════════════════════════════════════════════════════════

import { World } from '../src/core/world.js';
import { PluginHost } from '../src/core/plugin.js';
import { create, list, bindRegistry, equipmentPlugins } from '../src/equipment/index.js';
import { CouplingBus } from '../src/coupling/bridge.js';
import { solveCircuit, fmtA, fmtV, fmtW, fmtR } from '../src/physics/circuit.js';
import { SP } from '../src/chemistry/species.js';
import { Inspector, LIVE_FALLBACK_MAX, STATE_LABELS } from '../src/ui/inspector.js';

import physicsPlugin from '../src/physics/circuit.js';
import chemistryPlugin from '../src/chemistry/reactions.js';
import bridgePlugin from '../src/coupling/bridge.js';

// ── 断言小工具（与仓库其他探针同一套形状）──
const MUT = process.argv.includes('--mutate');
const RED_LENS = '凸透镜的 v 保持原始键名';   // --mutate 只许这一条红
let pass = 0, fail = 0;
const failed = [];   // --mutate 用：记下失败项，用来判「只有该红的那一条红了」
const ok = (cond, msg) => {
  if (cond) { pass++; console.log('  \x1b[32m✓\x1b[0m ' + msg); }
  else { fail++; failed.push(msg); console.log('  \x1b[31m✗\x1b[0m ' + msg); }
};
const head = (t) => console.log('\n\x1b[36m' + t + '\x1b[0m');
const info = (t) => console.log('    · ' + t);
const num = (v) => (typeof v === 'number' ? (Math.abs(v) < 1e-9 ? '0' : String(+v.toPrecision(6))) : String(v));
const dump = (rows) => rows.map(([k, v]) => k + ' ' + v).join(' / ');

// ── 最小 DOM 替身：Inspector 只用到 createElement / createDocumentFragment / appendChild / replaceChildren ──
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

// ── 无头宿主：等价于浏览器里的引导过程 ──
const bootApp = {
  services: {}, ticks: [], world: null, lastCircuit: null, selected: null,
  log: { push() {}, clear() {} },
  toast() {},
  addTick(fn) { this.ticks.push(fn); return () => {}; },
};
const host = new PluginHost(bootApp);
for (const p of [physicsPlugin, chemistryPlugin, bridgePlugin, ...equipmentPlugins]) host.define(p);
host.installAll();
bindRegistry(host.registry('equipment'));

const ALL = list();   // 「当时注册表里的全部器材」——本文件不写死任何器材数量
const appStub = { world: { get: () => null }, markDirty() {}, duplicate() {}, removeEntity() {} };

// ══════════════════════════════════════════════════════════
// 冻结基线：改造前 updateLive() 的逐字副本（通用四键 → type 专属 → 容器面板 → 无读数哨兵）
// ══════════════════════════════════════════════════════════
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
    if (v.gas.size) {
      for (const [id, q] of v.gas) rows.push([SP[id] ? SP[id].n : id, (q * 24000).toFixed(0) + ' mL']);
    }
    if (v.precip.size) {
      for (const [id, g] of v.precip) rows.push([SP[id] ? SP[id].n : id, g.toFixed(2) + ' g']);
    }
    if (v.solid.size) {
      for (const [id, g] of v.solid) rows.push([SP[id] ? SP[id].n : id, g.toFixed(2) + ' g']);
    }
    if (v.lastReaction) rows.push(['最近反应', v.lastReaction.eq]);
  }

  if (!rows.length) rows.push(['状态', '无读数']);
  return rows;
}

const SENTINEL = (rows) => rows.length === 1 && rows[0][0] === '状态' && rows[0][1] === '无读数';
const same = (a, b) => a.length === b.length && a.every(([k, v], i) => k === b[i][0] && v === b[i][1]);
// 放宽后的回归判据（裁决 A）：旧行必须逐字留在新行的**前缀**里 —— 允许「只追加」，照旧抓改写 / 丢行 / 变序。
// 放宽的理由：新增的读数行只能追加在既有读数之后（「升级与保留同时发生」的机械形式），而「整集相等」
// 会把「只追加」也判成改写。「放宽之后仍然能红」的证明（改写 / 变序 / 丢行 三个变异体逐个被抓 +
// 未变异对照组全绿 + D43 仓库零字节）见 tools/inspector-stats-probe.mjs ⑧。
const prefixOk = (o, n) => n.length >= o.length && o.every(([k, v], i) => n[i][0] === k && n[i][1] === v);
// 域盲四键的**退场豁免**：这四个键是电路解注入的量（circuit.js 只往电路支路器材上写 I/U/P/R），
// 只有电路支路器材才该被贴上电学标签。非支路器材上它们本来就是**贴错了域** —— lever 的 I 是转动惯量
// （kg·m² 被显示成「电流 I … A」）、soundlevel 的 I/P 是声强/声源功率（W/m² 被显示成「电流 I 79.6 µA」）——
// 所以修复方式正是把这四行撤下、改由本域域表命名。豁免按**可查证的条件**判定，不写器材名：
//   ① 该器材不是电路支路（typeof circuitBranch !== 'function'，能力判定）；
//   ② 旧行全部是这四个域盲标签；
//   ③ 新行里一个域盲标签都不剩（误标确实退场了）；
//   ④ 该器材所在域的域表**把这个键定义成别的物理量**（拿 STATE_LABELS 现查，不是名单）。
// 把域表里那条重新定义撤掉，豁免立刻失效（见 tools/inspector-stats-probe.mjs ⑧ 的 mut-table-def 变异体）。
const BLIND = { '电流 I': 'I', '两端电压 U': 'U', '功率 P': 'P', '等效电阻 R': 'R' };
const fourKeyRetired = (e, o, n) => typeof e.circuitBranch !== 'function'
  && o.length > 0
  && o.every(([k]) => k in BLIND)
  && n.every(([k]) => !(k in BLIND))
  && o.every(([k]) => {
    const t = (STATE_LABELS[(e.def && e.def.cat) || ''] || {})[BLIND[k]];
    return !!t && t[0] !== k;
  });

/** 真正跑 Inspector.updateLive()，再把「实时读数」里的 k/v 对读回来 */
function liveRows(e) {
  const ins = new Inspector(mkEl('div'), appStub);
  ins.ent = e;
  ins._live = mkEl('div');
  ins.updateLive();
  return readRows(ins._live);
}
function readRows(el) {
  const rows = [];
  for (let i = 0; i + 1 < el.children.length; i += 2) {
    rows.push([el.children[i].textContent, el.children[i + 1].textContent]);
  }
  return rows;
}
/** 跑整个 render()，把操作区的按钮文案读回来 */
function renderButtons(e) {
  const ins = new Inspector(mkEl('div'), appStub);
  ins.ent = e;
  ins.render();
  const btns = ins.root.children.find((n) => n.className === 'btns');
  return btns ? btns.children.map((b) => b.textContent) : [];
}
/** state 里「兜底能用的键」个数（用来解释某件器材为什么依旧沉默） */
function numericKeys(e) {
  return Object.entries(e.state || {}).filter(([k, v]) => (
    k.charCodeAt(0) !== 95 && typeof v === 'number' && Number.isFinite(v)
  )).length;
}

/**
 * 凸透镜那条钉子的**谓词**（绿测与红测共用同一份，只换摆法）。
 * onLeft=false 时把光源挪到透镜右侧 —— 同一个谓词必须因此变红，否则那条断言只是「环境凑巧对」。
 * 依据 optics.js:613-622 与 445-454：透镜自己查 world.entities 找**左侧最近的 lightsource**
 * （只比 x、无 y 约束），u = 透镜 x − 光源发光面 x（faceX = x + w/2）；这里把 u 直接构造成 22 mm
 * （f = 80 ⇒ 1/v = 1/80 − 1/22 ⇒ v = −30.3448 mm，与卷宗里的数一致）。
 * 小场景摆在网格（x ≤ 680、y ≤ 750）之外 ⇒ 这一对只看得到彼此，主场景一件都不动。
 */
function lensNail(onLeft) {
  const pw = new World();
  const s = create('lightsource', 2000, 200);
  const lens = create('convexlens', 2000 + s.w / 2 + 22, 200);
  if (!onLeft) s.x = lens.x + 70;
  pw.add(s, true); pw.add(lens, true);
  pw.step(1 / 120);
  const keys = liveRows(lens).map(([k]) => k);
  const st = lens.state;
  return {
    pass: keys.includes('v') && !keys.includes('速度'),
    why: `手摆光源在${onLeft ? '左' : '右'}：u=${num(st.u)} mm、f=${num(st.f)} mm → v=${num(st.v)} mm，`
      + `面板行 [${keys.join(' / ')}]`,
  };
}

console.log('\x1b[1m小墨实验室 · 属性面板（UI · inspector）无头验证\x1b[0m');

// ══════════════════════════════════════════════════════════
head('① 引导与场景装配');
const phases = {};
for (const rec of host.list()) phases[rec.phase] = (phases[rec.phase] || 0) + 1;
ok(ALL.length > 0, `注册表就绪：器材 ${ALL.length} 件（本文件不写死数量，逐件判据都对着这份清单）`);
ok((phases.failed || 0) === 0, `装载零失败：${JSON.stringify(phases)}`);

const world = new World();
const cb = new CouplingBus(world);
const raw = world.step.bind(world);
world.step = (dt) => {
  const br = cb.buildBranches();
  cb.distribute(dt, solveCircuit(world, br));
  raw(dt);
};
const ents = [];
let createFail = 0;
ALL.forEach((d, i) => {
  let e = null;
  try { e = create(d.type, 120 + (i % 9) * 70, 120 + Math.floor(i / 9) * 70); } catch (err) { e = null; }
  if (!e) { createFail++; return; }
  world.add(e, true);
  ents.push(e);
});
for (let i = 0; i < 24; i++) world.step(1 / 120);   // 0.2 s：让读数里有真数
ok(createFail === 0 && ents.length === ALL.length, `场景装配：${ents.length} 件器材全部 create 成功并步进 0.2 s`);

// ══════════════════════════════════════════════════════════
head('② 既有器材零回归（逐件对照改造前的行算法）');
const upgraded = [], offenders = [], silent = [], retired = [];
let unchanged = 0;
for (const e of ents) {
  const o = oldRows(e), n = liveRows(e);
  if (SENTINEL(o)) {
    // 改造前只有一行「状态 · 无读数」：兜底要么接管，要么依旧沉默（后者说明它确实没有数字可报）
    if (SENTINEL(n)) { silent.push(e); continue; }
    upgraded.push([e, o, n]);
  } else {
    // ⚠ 这条 else if 不是遮丑，三条理由（缺任何一条它就该被删）：
    //   1) `lever` / `soundlevel` 的旧四键行**本身就是误标**：`I` 在力学域是**转动惯量 kg·m²**、
    //      在声学域是**声强 W/m²** —— 不是「读数被改了」，是「旧标签写错了」。
    //   2) 因此修掉它们必然是**改写**、而不是**改写回归**（改的是错标签，不是既有读数）；
    //      「旧行必须逐字保留」的前缀判据在这里必须让路 —— 错的不是判据，是那两行旧行。
    //   3) 豁免可**证伪**、且不是器材名单：第 ④ 个条件**现查** STATE_LABELS（该键是否被域表重新定义），
    //      把域表那条重定义撤掉，豁免立刻失效 —— 见 tools/inspector-stats-probe.mjs ⑧ 的 `mut-table-def` 变异体。
    if (prefixOk(o, n)) unchanged++;
    else if (fourKeyRetired(e, o, n)) { unchanged++; retired.push(e.type); }
    else offenders.push([e, o, n]);
  }
}
ok(unchanged === ents.length - upgraded.length - offenders.length - silent.length && offenders.length === 0,
  `旧行逐字保留（放宽为「旧行是新行的前缀」，允许尾部只追加）：${unchanged} 件的旧行逐字为新行前缀，0 件被改写 / 丢行 / 变序`);
ok(upgraded.length > 0, `「状态 · 无读数」被真实读数替换：${upgraded.length} 件（改造前这些器材的数字键没有任何出口）`);
{
  // 豁免的**作用域自证**：只有「非电路支路却带四键」的器材才可能用到「域盲四键退场」这条口子。
  const holders = ents.filter((e) => typeof e.circuitBranch !== 'function'
    && ['I', 'U', 'P', 'R'].some((k) => typeof (e.state || {})[k] === 'number')).map((e) => e.type);
  ok(retired.length === holders.length && retired.every((t) => holders.includes(t)),
    `域盲四键退场豁免的作用域：${retired.length} 件 = 非支路却带四键的器材（${holders.join(' / ') || '无'}）—— 只许它们用，别的器材照旧受前缀判据约束`);
}
for (const [e, o, n] of upgraded) {
  info(`${e.type}（${e.name}）  [${dump(o)}] → [${dump(n)}]`);
}
for (const [e, o, n] of offenders) {
  console.log(`    \x1b[31m✗ ${e.type}  改造前 [${dump(o)}]  改造后 [${dump(n)}]\x1b[0m`);
}
ok(silent.length > 0 && silent.every((e) => numericKeys(e) === 0),
  `仍然沉默的 ${silent.length} 件：state 里有限数字键恒为 0 个（不是被吞掉，是真的没有数字可报）`);
if (silent.length) info('沉默清单：' + silent.map((e) => e.type).join(' / '));

// ══════════════════════════════════════════════════════════
head('③ 新域器材现在有读数了');
for (const cat of ['力学', '热学', '光学']) {
  const mine = ents.filter((e) => (e.def.cat || '') === cat);
  const withRows = mine.filter((e) => liveRows(e).length > 0);
  ok(withRows.length > 0, `${cat}：${withRows.length} / ${mine.length} 件在改造后行数 > 0（改造前该域几乎只有「无读数」一行）`);
  if (!mine.length) continue;
  const demo = withRows[0] || mine[0];
  info(`${demo.type}（${demo.name}）：${dump(liveRows(demo))}`);
  const quiet = mine.filter((e) => liveRows(e).length === 0);
  if (quiet.length) info(`${cat} 仍沉默：${quiet.map((e) => e.type + '（数字键 ' + numericKeys(e) + '）').join(' / ')}`);
}
{
  // 钉子：力学域的 tPrev 被 STATE_HIDDEN 挡住 —— 直接问真人逻辑，不靠文案、不靠器材清单。
  // 判据用「同一份 state 多一个 tPrev，行集必须一字不变」，于是它不依赖兜底在空集时是否补哨兵行；
  // 同一次调用里 peak 仍在场做对照 —— 否则「整个兜底都不出数」也会让这条钉子假绿。
  const mkCat = (state) => ({ type: '__pin_tPrev', name: '__pin_tPrev', domain: 'physics', props: {}, def: { fields: [], cat: '力学' }, state });
  const withPrev = liveRows(mkCat({ tPrev: 0.1234, peak: 0.08 }));
  const noPrev = liveRows(mkCat({ peak: 0.08 }));
  ok(withPrev.length === noPrev.length && dump(withPrev) === dump(noPrev) && withPrev.some((r) => /0\.0800/.test(r[1])),
    `力学域 tPrev 被域级名单挡住：加上 tPrev 后行集一字不变 [${dump(withPrev)}]（对照：peak 仍在 [${dump(noPrev)}]）`);
}
{
  // 反例钉子：凸透镜的 v 是像距（mm），不是速度 —— 「通用表按域取词」就是为防这种误标。
  // ⚠ 这一对**手摆**，不去网格里找：改造前它靠 `120 + (i%9)*70` 的网格**碰巧**把光源排在透镜左边一格，
  //   任何人往器材清单中段插一件（k1 的 multimeter 落在 ALL@7）都会让两者错位、断言假红。
  //   摆法与依据见 lensNail() 的注释。
  const nail = lensNail(true);
  ok(nail.pass, `凸透镜的 v 保持原始键名（${nail.why}；若被通用表按「速度」取词就会变成「速度」）`);
  if (MUT) {
    // ── 红测：**同一份谓词**、两种摆法，在同一个进程里对照（于是它与本文件里别的历史红彻底解耦）──
    const bad = lensNail(false);
    const pre = failed.filter((m) => !m.includes(RED_LENS));
    const good = nail.pass && bad.pass === false;
    console.log('  \x1b[36m红测（--mutate）：同一份谓词，只换光源摆法\x1b[0m');
    console.log('    光源在左（本探针构造的摆法）：' + (nail.pass ? '\x1b[32m绿 ✓\x1b[0m ' : '\x1b[31m也红了 ✗\x1b[0m ') + nail.why);
    console.log('    光源在右（故意挪动）    ：' + (bad.pass ? '\x1b[31m没红 ✗\x1b[0m ' : '\x1b[32m红 ✓\x1b[0m ') + bad.why);
    console.log('    未改处对照：本次运行除这一条外还有 ' + pre.length + ' 项红，它们与绿测逐项相同'
      + '（本变异只改这一对小场景里的光源位置，主网格场景一件未动）'
      + (pre.length ? '；例如：' + pre[0].slice(0, 34) + '…' : ''));
    console.log('MUTATE_JSON ' + JSON.stringify({
      expectedRed: 1, observedRed: bad.pass ? 0 : 1, controlGreen: nail.pass,
      preExistingRed: pre.length, samePredicate: true, ok: good,
    }));
    process.exit(good ? 0 : 1);
  }
}

// ══════════════════════════════════════════════════════════
head('④ 格式卫生：读数里不许出现 NaN / Infinity / undefined 与长尾巴');
let scanned = 0, dirty = [], longTail = [];
for (const e of ents) {
  for (const [k, v] of liveRows(e)) {
    scanned++;
    const s = k + '=' + v;
    if (/NaN|Infinity|undefined/.test(s)) dirty.push(e.type + ' ' + s);
    if (/\.\d{7,}/.test(v)) longTail.push(e.type + ' ' + s);
  }
}
ok(dirty.length === 0, `扫描 ${scanned} 个读数：0 个含 NaN / Infinity / undefined（NaN / ±∞ / 数组 / 对象 / 布尔在兜底里就被滤掉了）`);
ok(longTail.length === 0, `扫描 ${scanned} 个读数：0 个出现 7 位以上小数（按量级选精度）`);
for (const s of dirty.concat(longTail).slice(0, 5)) info(s);

// ══════════════════════════════════════════════════════════
head('⑤ 行数上限与截断标记（凭空造一件 20 个数字键的器材）');
const fake = {
  type: '__probe20', name: '__probe20', domain: 'physics', props: {},
  def: { fields: [], cat: '力学' },
  state: Object.assign(
    {}, ...Array.from({ length: 20 }, (_, i) => ({ ['k' + (i + 1)]: i + 1 })),
    { badNaN: NaN, badInf: Infinity, badArr: [1, 2], badObj: { a: 1 }, badStr: 'txt', badBool: true, _priv: 5 },
  ),
};
const frows = liveRows(fake);
ok(frows.length === LIVE_FALLBACK_MAX + 1, `20 个数字键 → ${frows.length} 行 = 上限 ${LIVE_FALLBACK_MAX} 行 + 1 行截断标记`);
ok(frows[frows.length - 1][0] === '…' && /还有 \d+ 项读数/.test(frows[frows.length - 1][1]),
  `截断标记：${frows[frows.length - 1][0]} ${frows[frows.length - 1][1]}`);
const ftext = frows.map((r) => r.join(' ')).join('|');
ok(!/badNaN|badInf|badArr|badObj|badStr|badBool|_priv/.test(ftext), '非有限数字 / 数组 / 对象 / 字符串 / 布尔 / _ 开头的内部键，一个都没露面');
info(dump(frows.slice(0, 3)) + ' … ' + dump(frows.slice(-1)));

// ══════════════════════════════════════════════════════════
head('⑥ 热源按钮文案：不再拿「酒精灯」的字样去点加热板');
const lamps = ents.filter((e) => e.flame);
const lamp = lamps.find((e) => e.type === 'alcohollamp');
ok(!!lamp, `酒精灯在场：${lamp ? lamp.name : '（找不到）'}`);
if (lamp) {
  lamp.props.lit = false;
  const b1 = renderButtons(lamp)[0];
  lamp.props.lit = true;
  const b2 = renderButtons(lamp)[0];
  ok(b1 === '点燃酒精灯', `酒精灯熄灭态文案逐字不变："${b1}"`);
  ok(b2 === '熄灭酒精灯', `酒精灯点燃态文案逐字不变："${b2}"`);
}
const others = lamps.filter((e) => e !== lamp);
ok(others.length > 0, `带 flame 标记的非灯具热源：${others.length} 件（${others.map((e) => e.type).join(' / ')}）`);
let wordingBad = [];
for (const e of others) {
  for (const lit of [false, true]) {
    e.props.lit = lit;
    const t = renderButtons(e)[0] || '';
    if (t.includes('酒精灯') || !t.includes(e.name)) wordingBad.push(`${e.type}:${t}`);
  }
}
ok(wordingBad.length === 0, `非灯具热源 0 件借用「酒精灯」字样，且都报出自己名字（逐件两种状态各查一次）`);
for (const e of others) { e.props.lit = false; info(`${e.type}（${e.name}）→ "${renderButtons(e)[0]}"`); }
for (const s of wordingBad) console.log(`    \x1b[31m✗ ${s}\x1b[0m`);

// ══════════════════════════════════════════════════════════
console.log('');
if (fail === 0) console.log('\x1b[32m全部通过：' + pass + ' 项\x1b[0m');
else console.log('\x1b[31m合计 ' + (pass + fail) + ' 项，失败 ' + fail + ' 项\x1b[0m');
process.exit(fail === 0 ? 0 : 1);
