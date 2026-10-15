// ══════════════════════════════════════════════════════════
// 无头验证：逐行「添加到曲线」入口（task-41 · NB 差集第 1 条）
//
//   node tools/inspector-pick-probe.mjs                     # 断言
//   node tools/inspector-pick-probe.mjs --mutate-snapshot   # 红测：把取值闭包换成点击那一刻的快照（模拟"传数值"错法）
//
// 这一条要证明的四件事，缺一条就会放过一类错法：
//   ① **不变量**：行上加了入口之后，`readRows()` 的结果与**没加入口时逐字相同**
//      （同一次运行内前后对照，不是"探针没红"这种间接证据）；
//   ② **正确性**：点某一行 ⇒ 对应曲线出现**且数据在增长**（两个采样点）——
//      没有这条，把取值写成常量、画一条死线也能过；
//   ③ **红色能力**：把取值闭包换成点击那一刻的**快照** ⇒ ②的断言必须红；
//   ④ **满卡路径**：第 9 路接入时行为可读且不崩。
// ══════════════════════════════════════════════════════════

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { World } from '../src/core/world.js';
import { PluginHost } from '../src/core/plugin.js';
import { create, bindRegistry, equipmentPlugins } from '../src/equipment/index.js';
import { CouplingBus } from '../src/coupling/bridge.js';
import { solveCircuit } from '../src/physics/circuit.js';
import { Inspector } from '../src/ui/inspector.js';
import { DataPanel } from '../src/ui/data.js';

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
const sha = (rel) => createHash('sha256').update(readFileSync(fileURLToPath(new URL(rel, import.meta.url)))).digest('hex');
const bytes = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url))).length;

// ── DOM 替身：比 tools/inspector-probe.mjs 那份多三样（事件记录 / style / canvas 2D 替身）──
//    多这三样是为了能在纯 Node 里**真的把曲线画一遍**（drawSpark 走真代码），而不是只数通道数。
const ctxStub = () => {
  const c = {
    calls: { stroke: 0, lineTo: 0, fill: 0 },
    fillStyle: '', strokeStyle: '', lineWidth: 1, lineJoin: '',
    setTransform() {}, clearRect() {}, beginPath() {}, moveTo() {}, closePath() {},
    lineTo() { c.calls.lineTo++; }, stroke() { c.calls.stroke++; }, fill() { c.calls.fill++; },
    createLinearGradient: () => ({ addColorStop() {} }),
  };
  return c;
};
const mkEl = (tag) => ({
  tagName: tag, className: '', textContent: '', innerHTML: '', title: '',
  children: [], isFragment: false, style: {}, width: 0, height: 0, listeners: {},
  appendChild(n) { this.children.push(n); return n; },
  addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); },
  remove() {
    for (const p of walkAll()) { const i = p.children.indexOf(this); if (i >= 0) { p.children.splice(i, 1); return; } }
  },
  getBoundingClientRect: () => ({ width: 120, height: 30, left: 0, top: 0 }),
  getContext() { return (this._ctx = this._ctx || ctxStub()); },
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
const roots = [];
function walkAll() {
  const out = [];
  const go = (n) => { out.push(n); for (const c of n.children || []) go(c); };
  for (const r of roots) go(r);
  return out;
}
globalThis.document = {
  createElement: (t) => mkEl(t),
  createDocumentFragment: () => Object.assign(mkEl('#fragment'), { isFragment: true }),
};
globalThis.window = { devicePixelRatio: 1 };
globalThis.requestAnimationFrame = (fn) => { fn(); return 0; };

const clickOn = (container, target) => {
  const hs = (container.listeners && container.listeners.click) || [];
  for (const h of hs) h({ target });
  return hs.length;
};
const rowsOf = (el) => {
  const out = [];
  for (let i = 0; i + 1 < el.children.length; i += 2) out.push([el.children[i].textContent, el.children[i + 1].textContent]);
  return out;
};
const valEl = (el, re) => {
  for (let i = 0; i + 1 < el.children.length; i += 2) if (re.test(el.children[i].textContent)) return el.children[i + 1];
  return null;
};

// ── 启动 ──
const bootApp = {
  services: {}, ticks: [], world: null, lastCircuit: null, selected: null,
  log: { push() {}, clear() {} }, toast() {},
  addTick(fn) { this.ticks.push(fn); return () => {}; },
};
const host = new PluginHost(bootApp);
for (const p of [physicsPlugin, chemistryPlugin, bridgePlugin, ...equipmentPlugins]) host.define(p);
host.installAll();
bindRegistry(host.registry('equipment'));

const DT = 1 / 120;
const world = new World();
const cb = new CouplingBus(world);
const raw = world.step.bind(world);
world.step = (dt) => {
  const br = cb.buildBranches();
  const sol = solveCircuit(world, br);
  cb.distribute(dt, sol);
  raw(dt);
};
const mk = (type, x, y, props) => {
  const e = create(type, x, y);
  if (props) for (const k of Object.keys(props)) e.setProp(k, props[k]);
  world.add(e, true);
  return e;
};
const src = mk('acsource', 100, 100, { Up: 6, f: 1, r: 0.05 });
const beaker = mk('beaker', 400, 300, { capacity: 250 });
const eA = mk('electrode', 394, 300, { metal: 'graphite' });
const eB = mk('electrode', 406, 300, { metal: 'graphite' });
const RS = mk('resistor', 250, 220, { resistance: 100 });
const v = beaker.vessel;
v.capacity = 250;
v.addLiquid('CuSO4', 50); v.addLiquid('H2O', 50); v.updateColor();
const link = (a, ap, b, bp) => world.connect({ e: a.id, p: ap }, { e: b.id, p: bp }, 'wire');
link(src, 0, RS, 0); link(RS, 1, eA, 0); link(eB, 0, src, 1);

// ── D36：依赖文件的 sha（**运行首尾各取一次**）──
const DEPS = ['../src/ui/data.js', '../src/plugins/ui.data.js', '../src/ui/inspector.js', '../src/coupling/bridge.js'];
const stamp = () => DEPS.map((d) => d.replace('../', '') + ' ' + bytes(d) + 'B ' + sha(d).slice(0, 16)).join('  |  ');
console.log('\x1b[1m小墨实验室 · 逐行「添加到曲线」入口 无头验证（task-41）\x1b[0m');
console.log('  D36 起点：' + stamp());

const app = { world, markDirty() {}, get: (id) => world.get(id), duplicate() {}, removeEntity() {} };
for (let i = 0; i < 12; i++) world.step(DT);

// 红测模式：**不碰仓库任何字节**（不改文件、不用 CDP），只把 DataPanel.pick 的取值闭包换成
// 点击那一刻的快照 —— 这正是「传数值而不是传取值函数」那种错法，看断言抓不抓得住。
const MUTATE = process.argv.includes('--mutate-snapshot');
if (MUTATE) {
  const realPick = DataPanel.prototype.pick;
  DataPanel.prototype.pick = function (d) {
    const frozen = typeof d.read === 'function' ? d.read() : NaN;
    return realPick.call(this, { ...d, read: () => frozen });
  };
  console.log('\x1b[33m⚠ 红测模式（--mutate-snapshot）：取值闭包已换成点击那一刻的快照，仓库文件一个字节没动\x1b[0m');
}

const dpEl = mkEl('div'); roots.push(dpEl);
const dp = new DataPanel(dpEl, app);
app.data = dp;

// ── ① 前提 ──
head('① 前提：面板就位、容器有电极、行集非空');
ok(typeof dp.pick === 'function' && typeof dp.visibleKeys === 'function', 'DataPanel 上确有 pick() / visibleKeys() 两个入口（不是我在探针里另造的假接口）');
ok(beaker.vessel.hasElectrodes() && beaker.vessel.electrodes.length === 2, `烧杯里 2 根电极（hasElectrodes=${beaker.vessel.hasElectrodes()}）`);

// ── ② 不变量：加入口前后 readRows() 逐字相同（同一次运行内前后对照）──
head('② 不变量：行上加了入口之后，readRows() 与「没加入口时」逐字相同');
const insNoSink = new Inspector(mkEl('div'), { world, markDirty() {} });   // 没有 app.data ⇒ 不标 pickable（task-41 之前的行为）
insNoSink.show(beaker);
const R0 = rowsOf(insNoSink._live);
const ins = new Inspector(mkEl('div'), app);                             // 有 app.data ⇒ 标 pickable
ins.show(beaker);
const R1 = rowsOf(ins._live);
ok(R1.length === R0.length && R1.every((r, i) => r[0] === R0[i][0] && r[1] === R0[i][1]),
  `加入口后行集逐字相同：${R1.length} 行（键与值都逐字）→ [${dump(R1)}]`);
ok(ins._live.children.length % 2 === 0 && ins._live.children.length === R0.length * 2,
  `子节点数仍是偶数且与未加入口时一致：${ins._live.children.length} 个（每行 k/v 两个，入口**没有**插第三个子节点）`);
const marked = ins._live.children.filter((n, i) => i % 2 === 0 && n.className !== 'k');
ok(marked.length === 0 && ins._live.children.every((n, i) => (i % 2 ? /^v( pickable)?$/.test(n.className) : n.className === 'k')),
  `每行的类名仍是 k / v（入口只加后缀 pickable，没有别的花样）⇒ 既有 .ro > .v 样式选择器不受影响；可点行 ${ins._live.children.filter((n) => /pickable/.test(n.className)).length} 个`);

// ── ③ 入口真的挂上了，且不该有的地方没有 ──
head('③ 逐行入口：数值行可点，纯文本行不摆入口；两套口径各有一个**独立**入口');
const elSignedI = valEl(ins._sig, /瞬间电流（带符号）/);
const elAmpI = valEl(ins._live, /通过电流/);
const elText = valEl(ins._live, /最近反应/);
ok(!!elSignedI && /pickable/.test(elSignedI.className) && /添加到曲线/.test(elSignedI.title || ''),
  `带符号那一行带入口：class="${elSignedI && elSignedI.className}" title="${elSignedI && elSignedI.title}"`);
ok(!!elAmpI && /pickable/.test(elAmpI.className),
  `幅度口径那一行**也**带自己的入口（并列可见、谁也不替谁）：class="${elAmpI && elAmpI.className}"`);
ok(!!elText && !/pickable/.test(elText.className),
  `纯文本行「最近反应」**没有**入口：class="${elText && elText.className}"（不摆点了没反应的按钮）`);
const nBefore = dp.channels.size;
ok(clickOn(ins._live, elText) === 1 && dp.channels.size === nBefore,
  `点纯文本行：监听器在（委托挂上了），但通道数没变（${nBefore} → ${dp.channels.size}）`);

// ── ④ 正确性：点 ⇒ 曲线出现**且数据在增长** ──
head('④ 正确性：点「瞬间电流（带符号）」⇒ 对应曲线出现，且两次采样值不同');
clickOn(ins._sig, elSignedI);
clickOn(ins._live, elAmpI);
const pkey = [...dp.picked.keys()][0];
const akey = [...dp.picked.keys()][1];
ok(dp.picked.size === 2 && /^pick:/.test(pkey || '') && pkey !== akey,
  `两套口径各接一路、key 互不相同：signed=${pkey} / 幅度=${akey}（通道要等下一次采样才建，见下）`);
ok(dp.visibleKeys()[0] === pkey && dp.visibleKeys()[1] === akey,
  `点行接入的通道排在**前两张卡**（压过自动发现的通道）：${dp.visibleKeys().slice(0, 2).join(' , ')}`);

// 采样间隔用 17 帧（≈0.142 s）而不是 12 帧：1 Hz 的正弦 + 0.1 s 采样正好**每点同相**（采样被锁相），
// 那样三次采样永远是同一个相位，既看不出"数据在增长"也永远碰不到负半周。
const snapshots = [];
for (let i = 0; i < 5; i++) {
  for (let k = 0; k < 17; k++) world.step(DT);
  dp.step(17 * DT);
  const ch = dp.channels.get(pkey);
  snapshots.push(ch.data[ch.data.length - 1]);
}
const chPick = dp.channels.get(pkey);
const card = dp.cards.get(pkey);
const ctx = card && card.cv.getContext('2d');
const grows = (s) => s.length >= 3 && s[s.length - 3] !== s[s.length - 2] && s[s.length - 2] !== s[s.length - 1];
ok(dp.channels.has(pkey) && dp.channels.has(akey) && chPick.data.length >= 3,
  `两路通道都已建且在采样：signed ${chPick.data.length} 点 / 幅度 ${dp.channels.get(akey).data.length} 点`);
ok(grows(snapshots),
  `数据在增长**且是活的**：${chPick.data.length} 个采样点，末三点 ${snapshots.slice(-3).map((x) => x.toFixed(6)).join(' / ')} A`);
ok(chPick.data.some((x) => x < 0) && chPick.data.some((x) => x > 0),
  `带符号：采样里同时出现负值与正值（负 ${chPick.data.filter((x) => x < 0).length} 个 / 正 ${chPick.data.filter((x) => x > 0).length} 个）`);
ok(!!card && /^-?\d/.test(card.num.textContent) && card.num.textContent.indexOf('NaN') < 0,
  `卡片在面板里且数字可读：num="${card && card.num.textContent}"`);
ok(!!ctx && ctx.calls.stroke >= 2 && ctx.calls.lineTo >= 2,
  `曲线真被画过（走的是 data.js 里既有的 drawSpark）：stroke=${ctx && ctx.calls.stroke} 次、lineTo=${ctx && ctx.calls.lineTo} 次`);

// 再点同一行：幂等，不重复接
clickOn(ins._sig, elSignedI);
clickOn(ins._live, elAmpI);
ok(dp.picked.size === 2 && dp.visibleKeys().filter((k) => k === pkey).length === 1,
  `重复点同一行是幂等的：picked 仍 ${dp.picked.size} 路、signed 那一份卡位只有一张`);
ins.updateLive();
const reI = valEl(ins._sig, /瞬间电流（带符号）/);
const reT = valEl(ins._live, /最近反应/);
ok(/picked/.test(reI.className) && /已在曲线上/.test(reI.title || '') && !/picked/.test(reT.className),
  `已接入态可见：「瞬间电流（带符号）」class="${reI.className}" title="${reI.title}"；纯文本行仍是 "${reT.className}"`);

// ── ⑤ 红测：把取值闭包换成点击那一刻的快照 ⇒ ④的「数据在增长」断言必须红 ──
head('⑤ 红测：取值换成点击那一刻的快照（就是"传数值"这种错法）⇒ 「数据在增长」必须判红');
if (MUTATE) {
  ok(grows(snapshots) === false,
    `同一判据 grows() 在快照版下的判定：${grows(snapshots) ? '✓ 绿（放过了！）' : '✗ 红'} —— 末三点 ${snapshots.slice(-3).map((x) => x.toFixed(6)).join(' / ')} A 全等 ⇒ 「数据在增长」这条断言真的抓得住"传数值"`);
} else {
  const realPick = DataPanel.prototype.pick;
  DataPanel.prototype.pick = function (d) {
    const frozen = typeof d.read === 'function' ? d.read() : NaN;   // 只取一次 → 以后每次都返回这个常量
    return realPick.call(this, { ...d, read: () => frozen });
  };
  const dp2El = mkEl('div'); roots.push(dp2El);
  const dp2 = new DataPanel(dp2El, app);
  const app2 = { world, markDirty() {}, data: dp2 };
  const ins2 = new Inspector(mkEl('div'), app2);
  ins2.show(beaker);
  clickOn(ins2._sig, valEl(ins2._sig, /瞬间电流（带符号）/));
  const k2 = [...dp2.picked.keys()][0];
  const s = [];
  for (let i = 0; i < 5; i++) {
    for (let n = 0; n < 17; n++) world.step(DT);
    dp2.step(17 * DT);
    const c = dp2.channels.get(k2);
    s.push(c.data[c.data.length - 1]);
  }
  const verdict = grows(s);
  ok(verdict === false,
    `同一判据 grows() 在快照版下的判定：${verdict ? '✓ 绿（放过了！）' : '✗ 红'} —— 三点 ${s.slice(-3).map((x) => x.toFixed(6)).join(' / ')} A 全等 ⇒ 「数据在增长」这条断言真的抓得住"传数值"`);
  DataPanel.prototype.pick = realPick;
  const s2 = [];
  for (let i = 0; i < 3; i++) {
    for (let n = 0; n < 17; n++) world.step(DT);
    dp.step(17 * DT);
    const c = dp.channels.get(pkey);
    s2.push(c.data[c.data.length - 1]);
  }
  ok(grows(s2), `还原成闭包版：同一判据立刻又是绿的 ${s2.slice(-3).map((x) => x.toFixed(6)).join(' / ')} A`);
}

// ── ⑥ 满卡路径 ──
head('⑥ 满卡路径：第 9 路接入时替换最早那一路 + 可读提示（不静默丢、不崩）');
{
  const dp3El = mkEl('div'); roots.push(dp3El);
  const dp3 = new DataPanel(dp3El, app);
  let threw = null, last = null;
  try {
    for (let i = 0; i < 9; i++) {
      let t = i * 0.01;
      last = dp3.pick({ key: 'c' + i, label: '探针通道 ' + i, unit: 'V', read: () => (t += 1) });
      dp3.sample();
      dp3.draw();
    }
  } catch (e) { threw = e; }
  ok(!threw, `连开 9 路不抛异常${threw ? '：' + threw.message : ''}`);
  ok(dp3.picked.size === 8 && last && last.evicted === 'c0' && !dp3.channels.has('c0'),
    `第 9 路挤掉最早的 1 路：picked=${dp3.picked.size} 张（CARD_LIMIT 仍是 8，没被提高），被替换的是 ${last && last.evicted}`);
  const note = dp3El.children.map((c) => c.textContent || '').filter((t) => /已替换/.test(t))[0] || '';
  ok(/已替换最早接入的 1 路/.test(note) && /最多同时看 8 路/.test(note),
    `面板底部给出可读提示：「${note}」`);
  ok(dp3.visibleKeys().length <= 8 && dp3.visibleKeys()[0] === 'c1',
    `可见卡位始终 ≤ 8（${dp3.visibleKeys().length} 张），最早那路确实从显示里退出去了：首卡=${dp3.visibleKeys()[0]}`);
}

// ── ⑦ 空值守卫 ──
head('⑦ 空值：read() 返回 NaN / undefined 时不许渲染成 NaN / undefined');
{
  dp.pick({ key: 'probe:nan', label: '空值通道 NaN', unit: 'V', read: () => NaN });
  dp.pick({ key: 'probe:undef', label: '空值通道 undefined', unit: 'V', read: () => undefined });
  for (let i = 0; i < 3; i++) { for (let n = 0; n < 12; n++) world.step(DT); dp.step(0.1); }
  const bad = [];
  for (const k of ['probe:nan', 'probe:undef']) {
    const c = dp.cards.get(k);
    if (!c) { bad.push(k + '(无卡片)'); continue; }
    if (/NaN|undefined|Infinity/.test(c.num.textContent)) bad.push(k + '="' + c.num.textContent + '"');
  }
  ok(bad.length === 0, `两路空值的卡片数字都干净（走 push() 既有的 !isFinite → 0 守卫）：0 处 NaN/undefined`);
}

// ── ⑧ clear() 之后不复活 ──
head('⑧ clear()：逐行接入的通道一起放掉，不许被 read() 复活');
{
  dp.clear();
  const afterClear = { picked: dp.picked.size, channels: dp.channels.size };
  dp.sample();
  const revived = [...dp.picked.keys()].filter((k) => dp.channels.has(k));
  ok(afterClear.picked === 0 && dp.visibleKeys().every((k) => !/^pick:/.test(k)) && revived.length === 0,
    `clear() 放掉逐行接入的通道：picked=${afterClear.picked}，下一次采样后可见卡 ${dp.visibleKeys().length} 张里 0 张来自点行（自动发现的通道照常重建 ${dp.channels.size} 张）`);
}

// ── 尾行：D36 终点 + D40 命令行 ──
console.log('\n' + (fail ? `\x1b[31m合计 ${pass + fail} 项，失败 ${fail} 项\x1b[0m` : `\x1b[1m全部通过：${pass} 项\x1b[0m`));
console.log('  D36 终点：' + stamp());
console.log('  D40 命令行：node tools/inspector-pick-probe.mjs');
process.exit(fail ? 1 : 0);
