// ══════════════════════════════════════════════════════════
// 无头验证：属性面板新增的「瞬间读数（带符号）」（task-38 · NB 差集第 3 条）
//
//   node tools/inspector-signed-probe.mjs          # 断言
//   node tools/inspector-signed-probe.mjs --snap    # 只打印既有「实时读数」行集（用来冻结改动前的逐字基线）
//
// 为什么要单开一份：本任务的硬边界是「**新增一路**、既有幅度口径一行都不许动」，而
// tools/inspector-probe.mjs §② 的判据是「既有行集逐字零回归」—— 那份判据正好是我的护栏：
// 新口径若塞进 _live 就会被它判红。所以这里额外证明两件事：
//   ① 既有行集（含「通过电流」那一行）**逐字不变**（对着改动前冻结下来的字面量比）；
//   ② 新增的带符号读数在**独立区块**里，与支路真电流/真电压**逐帧同号**（NB 的「同参考方向」）。
// ══════════════════════════════════════════════════════════

import { World } from '../src/core/world.js';
import { PluginHost } from '../src/core/plugin.js';
import { create, bindRegistry, equipmentPlugins } from '../src/equipment/index.js';
import { CouplingBus } from '../src/coupling/bridge.js';
import { solveCircuit, fmtA, fmtV } from '../src/physics/circuit.js';
import { Inspector, SIGNED_NA } from '../src/ui/inspector.js';

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

// ── 最小 DOM 替身（与 tools/inspector-probe.mjs 同一套形状）──
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
  log: { push() {}, clear() {} }, toast() {},
  addTick(fn) { this.ticks.push(fn); return () => {}; },
};
const host = new PluginHost(bootApp);
for (const p of [physicsPlugin, chemistryPlugin, bridgePlugin, ...equipmentPlugins]) host.define(p);
host.installAll();
bindRegistry(host.registry('equipment'));
const appStub = { world: { get: () => null }, markDirty() {}, duplicate() {}, removeEntity() {} };

const DT = 1 / 120;
const world = new World();
const cb = new CouplingBus(world);
const raw = world.step.bind(world);
let lastCircuit = null;
world.step = (dt) => {
  const br = cb.buildBranches();
  lastCircuit = solveCircuit(world, br);
  cb.distribute(dt, lastCircuit);
  raw(dt);
};

// ── 场景：AC 6 V / 1 Hz + CuSO₄ 烧杯 + 两根石墨电极 + 100 Ω 限流（§8 同款电路）──
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

const key = 'sol:' + beaker.id;
const rec = () => lastCircuit && lastCircuit.branches.get(key);

// ── 读数读取 ──
function readRows(el) {
  const rows = [];
  if (!el) return rows;
  for (let i = 0; i + 1 < el.children.length; i += 2) {
    rows.push([el.children[i].textContent, el.children[i + 1].textContent]);
  }
  return rows;
}
const ins = new Inspector(mkEl('div'), appStub);

/** 文本读数 → 符号（-1 / 0 / +1），认不出来返回 null（如「—（未接线）」） */
function signOf(text) {
  if (typeof text !== 'string') return null;
  if (text.indexOf('—') >= 0) return null;
  const num = parseFloat(text);
  if (!isFinite(num)) return null;
  return Math.sign(num);
}

// ══════════════════════════════════════════════════════════
if (process.argv[2] === '--snap') {
  ins.show(beaker);
  for (let i = 0; i < 12; i++) { world.step(DT); ins.updateLive(); }
  console.log('既有「实时读数」行集（12 帧 = 0.1 s 后）：');
  console.log(dump(readRows(ins._live)));
  console.log('hasElectrodes =', v.hasElectrodes(), ' 电极数 =', v.electrodes.length);
  console.log('v.electricCurrent =', v.electricCurrent, ' currentSigned =', v.currentSigned, ' currentU =', v.currentU);
  process.exit(0);
}

// ══════════════════════════════════════════════════════════
console.log('\x1b[1m小墨实验室 · 属性面板「瞬间读数（带符号）」无头验证（task-38）\x1b[0m');

head('① 场景与前提：真实电路把带符号量写进容器');
ins.show(beaker);
for (let i = 0; i < 12; i++) { world.step(DT); ins.updateLive(); }
ok(v.hasElectrodes() && v.electrodes.length === 2,
  `烧杯里确有 2 根电极（hasElectrodes=${v.hasElectrodes()}）—— 没有电极就不会有电流读数，后面全是空判据`);
ok(typeof v.currentSigned === 'number' && typeof v.currentU === 'number',
  `耦合层两路带符号量都在：currentSigned=${v.currentSigned.toExponential(3)} A、currentU=${v.currentU.toExponential(3)} V`
  + '（bridge.js:172-173 每帧写入）');

head('② 既有「实时读数」逐字未变（对着改动前冻结的字面量比）');
// 逐字基线：**改动前**（`git` 之外无历史，所以这里冻结的是本次改造前用 `--snap` 当场打印出来的那一行）
//   node tools/inspector-signed-probe.mjs --snap
const FROZEN_VESSEL_ROWS = [
  ['液体体积', '100.0 / 250 mL'],
  ['温度', '25.00 ℃'],
  ['pH', '4.21'],
  ['离子浓度', '1.0000 mol/L'],
  ['电导率', '9.000 S/m'],
  ['溶液电阻', '8.3 Ω'],
  ['插入电极', '2 根'],
  ['通过电流', '30.2 mA'],
  ['氢气', '0 mL'],
  ['氧气', '0 mL'],
  ['铜片', '0.00 g'],
  ['最近反应', '2CuSO₄ + 2H₂O --通电--> 2Cu + O₂↑ + 2H₂SO₄'],
];
/** 两路都缺失时的占位文案（必须与「0」可区分）——直接引源码导出的那一份，不另抄字面量 */
const BADGE = SIGNED_NA;
const live = readRows(ins._live);
const same = (a, b) => a.length === b.length && a.every(([k, val], i) => k === b[i][0] && val === b[i][1]);
ok(same(live, FROZEN_VESSEL_ROWS),
  `既有行集逐字一致：${live.length} 行 = 冻结基线 ${FROZEN_VESSEL_ROWS.length} 行 → [${dump(live)}]`);
ok(!live.some(([k]) => /瞬间|带符号/.test(k)),
  `新读数**没有**混进既有行集（既有行标签里 0 处出现「瞬间/带符号」）—— 幅度口径那一行原样在场：`
  + `「${live.find(([k]) => k === '通过电流')[0]} ${live.find(([k]) => k === '通过电流')[1]}」`);
ok(live.every(([k, val]) => k !== '通过电流' || val === fmtA(v.electricCurrent || 0)),
  `「通过电流」仍是**幅度**口径：面板 ${live.find(([k]) => k === '通过电流')[1]} = fmtA(electricCurrent)=${fmtA(v.electricCurrent || 0)}`
  + `（= fmtA(|currentSigned|) 亦为 ${fmtA(Math.abs(v.currentSigned))}）`);

head('③ 带符号读数：独立区块、两行并列、与支路真值同号');
const sigRows = readRows(ins._sig);
ok(sigRows.length === 2,
  `独立区块存在且并列两路：${JSON.stringify(sigRows.map((r) => r[0]))}`);
const sigI = sigRows.find(([k]) => /瞬间电流/.test(k)) || [];
const sigU = sigRows.find(([k]) => /瞬间电压/.test(k)) || [];
ok(/瞬间电流/.test(sigI[0] || '') && /瞬间电压/.test(sigU[0] || '') && sigI[0] !== '通过电流' && sigU[0] !== '通过电流',
  `两行文案能把口径区分开：「${sigI[0]} ${sigI[1]}」/「${sigU[0]} ${sigU[1]}」（都与「通过电流」不同名）`);
ok(sigI[1] === fmtA(v.currentSigned) && sigU[1] === fmtV(v.currentU),
  `读的就是带符号那两路：电流 ${sigI[1]} = fmtA(currentSigned) ${fmtA(v.currentSigned)}；`
  + `电压 ${sigU[1]} = fmtV(currentU) ${fmtV(v.currentU)}（fmtA/fmtV 保留符号，未新造格式化）`);

// 帧级同号：跑满 2 s（2 个周期），逐帧比对渲染出来的符号与支路 rec.I / rec.U。
// 分档判据（不搞"一刀切比符号"）：显示层有取整下限 —— |I| < 1e-9 显示成「0 A」、|U| < 1e-9 显示成「0 V」，
// 而 1e-9 附近的值会被 fmtA/fmtV 四舍五入成 0（甚至「-0.000」），此时"符号"在读数里本就不可辨。
// 所以：**能显示**的档（|I| ≥ 1e-6 A / |U| ≥ 1e-3 V）必须逐帧同号；**低于显示下限**的档必须恰好显示 0；
// 中间的四舍五入带不作断言。
let frames = 0, negI = 0, negU = 0, badI = 0, badU = 0, zeroI = 0, zeroU = 0;
const samples = [];
for (let i = 0; i < Math.round(2.0 / DT); i++) {
  world.step(DT);
  ins.updateLive();
  const r = rec();
  if (!r) continue;
  frames++;
  const rows = readRows(ins._sig);
  const tI = (rows.find(([k]) => /瞬间电流/.test(k)) || [])[1];
  const tU = (rows.find(([k]) => /瞬间电压/.test(k)) || [])[1];
  if (signOf(tI) === -1) negI++;
  if (signOf(tU) === -1) negU++;
  if (Math.abs(r.I) >= 1e-6) {
    if (signOf(tI) !== Math.sign(r.I)) { badI++; if (samples.length < 3) samples.push(`I 面板 ${tI} ↔ 支路 ${r.I.toExponential(3)}`); }
  } else if (Math.abs(r.I) < 1e-9) {
    if (tI !== '0 A') { badI++; if (samples.length < 3) samples.push(`I 面板 ${tI} ↔ 支路 ${r.I.toExponential(3)}（该显示 0 A）`); }
    else zeroI++;
  }
  if (Math.abs(r.U) >= 1e-3) {
    if (signOf(tU) !== Math.sign(r.U)) { badU++; if (samples.length < 3) samples.push(`U 面板 ${tU} ↔ 支路 ${r.U.toExponential(3)}`); }
  } else if (Math.abs(r.U) < 1e-9) {
    if (tU !== '0 V') { badU++; if (samples.length < 3) samples.push(`U 面板 ${tU} ↔ 支路 ${r.U.toExponential(3)}（该显示 0 V）`); }
    else zeroU++;
  }
}
ok(frames > 200 && negI > 50 && negU > 50,
  `2 s（${frames} 帧）里确实出现反向读数：负号帧数 电流 ${negI} / 电压 ${negU}`
  + '（非空前置：全正的话「同号」就是空判据）');
ok(badI === 0 && badU === 0,
  `逐帧同号（NB「同参考方向」）：${frames} 帧里渲染符号与支路 rec.I / rec.U 不一致的帧数 ${badI} / ${badU}`
  + `（其中过零点显示为 0 的档：电流 ${zeroI} 帧、电压 ${zeroU} 帧，逐帧核对为「0 A / 0 V」）`);
for (const s of samples) info(s);

head('④ 首帧守卫：undefined 不许渲染成 NaN / 空；0 不许显示成「有电流」');
{
  const saveI = v.currentSigned, saveU = v.currentU;
  delete v.currentSigned; delete v.currentU;          // 旧存档 / 单测替身里这两路不存在
  ins.updateLive();
  const rows = readRows(ins._sig);
  const text = rows.map((r) => r.join(' ')).join('|');
  ok(rows.length === 2 && !/NaN|undefined|Infinity|\|\s*$/.test(text) && rows.every(([, val]) => val.length > 0),
    `两路都缺失时渲染 [${dump(rows)}]：0 处 NaN / undefined / 空值（先判 typeof 再显示）`);
  ok(rows.every(([, val]) => val === BADGE), `缺失态用与 0 不同的文案「${BADGE}」标出，不与「没有电流」混淆`);
  v.currentSigned = 0; v.currentU = 0;
  ins.updateLive();
  const zero = readRows(ins._sig);
  ok(zero.every(([, val]) => val !== BADGE) && /^0 /.test(zero[0][1]) && /^0 /.test(zero[1][1]),
    `真 0 时渲染 [${dump(zero)}]：显示为 0（不是「${BADGE}」）—— 0 与「未接线」两种状态可区分`);
  v.currentSigned = saveI; v.currentU = saveU;
  ins.updateLive();
}

head('④′ 还没插电极：给占位文案，不显示 0 A / 0 V（"没接" ≠ "接了没电流"）');
{
  const bare = mk('beaker', 700, 300, { capacity: 250 });
  bare.vessel.addLiquid('H2O', 60); bare.vessel.updateColor();
  ins.show(bare);
  ins.updateLive();
  const rows = readRows(ins._sig);
  ok(rows.length === 1 && rows[0][0] === '瞬间读数' && rows[0][1] === '插入电极后出现',
    `未插电极的空烧杯渲染 [${dump(rows)}] —— 没有回路时不摆出两行假读数`);
  ins.show(beaker);
  ins.updateLive();
  ok(readRows(ins._sig).length === 2, `换回带电极的烧杯：区块立刻恢复两路读数（同一帧内跟上，不必重新选中）`);
}

head('⑤ 格式卫生：带符号区块里不许出现 NaN / Infinity / undefined / 长尾巴');
{
  const dirty = [];
  for (let i = 0; i < 60; i++) {
    world.step(DT); ins.updateLive();
    for (const [k, val] of readRows(ins._sig)) {
      const s = k + '=' + val;
      if (/NaN|Infinity|undefined/.test(s)) dirty.push(s);
      if (/\.\d{7,}/.test(val)) dirty.push('长尾巴 ' + s);
    }
  }
  ok(dirty.length === 0, `扫描 60 帧 × 2 行的带符号读数：0 处 NaN / Infinity / undefined / 7 位以上小数`);
  for (const s of dirty.slice(0, 3)) info(s);
}

console.log('');
if (fail === 0) console.log('\x1b[32m全部通过：' + pass + ' 项\x1b[0m');
else console.log('\x1b[31m合计 ' + (pass + fail) + ' 项，失败 ' + fail + ' 项\x1b[0m');
process.exit(fail === 0 ? 0 : 1);
