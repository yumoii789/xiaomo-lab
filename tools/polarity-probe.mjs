#!/usr/bin/env node
// ══════════════════════════════════════════════════════════
// tools/polarity-probe.mjs —— 干电池「印出来的极性」↔「求解器极性」
//
//   node tools/polarity-probe.mjs
//
// 为什么需要它：干电池印的 '+'/'−' 与求解器极性**恒反**。用户按印的 '+' 端推电流方向会
//   正好相反（电流自印 '−' 的那一端流出）。推导全部落在 solveCircuit() 里，按**符号**钉住
//   （不引行号：行号会漂，而"看起来精确的假引用"比没有引用更坏）：
//     · 先取 wire 口：`if (e.ports[i].kind === 'wire') wp.push(i);` ⇒ wp = [0,1]
//     · 无显式 a/b 的支路取端口对：`if (k === 0) { ia = wp[0]; ib = wp[1]; }` ⇒ **ka = ports[0]**
//     · 源行盖章：`z[k] = s.br.emf;` 与 `if (ri > 0) A[k][k] -= ri;` ⇒ V(ka) − V(kb) − ri·I_k = emf
//     · 上报口径：`const U = (ia >= 0 ? x[ia] : 0) - (ib >= 0 ? x[ib] : 0)` 与
//       `I = si ? -x[n + si.idx] : 0;`   ⇒   **U = emf − ri·I**
//   而 emf 的取值域只正（fields.emf min 1.5 / max 12）⇒ ports[0] 恒为求解器意义上的正端。
//
// 判据本体（§2）：端口 0 印的记号必须等于 sign(U(端口0) − U(端口1)) ——
//   '+' 是电位更高的那一端，'−' 是另一头。
//
// §6 是「判据能红」的自证：同一组 U01 下，正确印法必须判绿、旧印法必须判红，
//   并把**文件里现装的**标签换进内存再判一次 —— 不会红的断言比没有更坏，所以
//   「能红」这件事本身也被断言，而不是靠人相信。
//
// ⚠ 本探针只读不写：仓库零字节副作用。§6 的变异只发生在进程内存的 def.ports 上；
//   落盘变异就成了「用改坏源码换绿」，正是本探针要防的修法。
// ══════════════════════════════════════════════════════════

import { World } from '../src/core/world.js';
import { PluginHost } from '../src/core/plugin.js';
import { create, bindRegistry } from '../src/equipment/registry.js';
import { solveCircuit } from '../src/physics/circuit.js';
import physicsPlugin from '../src/physics/circuit.js';
import electricalPlugin from '../src/equipment/electrical.js';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0, fail = 0;
const R = [];
const ok = (cond, msg, reading) => {
  if (cond) { pass++; console.log('  \x1b[32m✓\x1b[0m ' + msg); }
  else { fail++; console.log('  \x1b[31m✗\x1b[0m ' + msg); }
  R.push({ ok: !!cond, msg, reading: reading === undefined ? null : reading });
};
const head = (t) => console.log('\n\x1b[36m' + t + '\x1b[0m');
const info = (t) => console.log('    \x1b[90m' + t + '\x1b[0m');
const near = (a, b, tolRel) => Math.abs(a - b) <= tolRel * Math.max(1e-12, Math.abs(b));

// ── 无头宿主（与 equipment-electronics.mjs 同一条引导路径） ──
const bootApp = {
  services: {}, ticks: [], world: null, lastCircuit: null, selected: null,
  log: { push() {}, clear() {} }, toast() {},
  addTick(fn) { this.ticks.push(fn); return () => {}; },
};
const host = new PluginHost(bootApp);
for (const p of [physicsPlugin, electricalPlugin]) host.define(p);
host.installAll();
bindRegistry(host.registry('equipment'));

const byType = new Map(host.registry('equipment').list().map((d) => [d.type, d]));
const batteryDef = byType.get('battery');
if (!batteryDef) { console.log('  ✗ 注册表里没有 battery'); process.exit(1); }

const RLOAD = 100, EMF = 6, RI = 1;

/**
 * 单回路：干电池 → 电阻 100 Ω（端口 0 接电阻 0、电阻 1 接端口 1）。
 * mkExtra(bat) 可返回挂在同一世界上的额外支路（用于独立路径读电位差）。
 */
function loop(emf = EMF, ri = RI, mkExtra = null) {
  const w = new World();
  const bat = create('battery', 0, 0);
  const res = create('resistor', 200, 0);
  bat.setProp('emf', emf); bat.setProp('internalR', ri);
  res.setProp('resistance', RLOAD);
  w.add(bat, true); w.add(res, true);
  w.connect({ e: bat.id, p: 0 }, { e: res.id, p: 0 }, 'wire');
  w.connect({ e: res.id, p: 1 }, { e: bat.id, p: 1 }, 'wire');
  const extra = mkExtra ? mkExtra(bat) : [];
  const c = solveCircuit(w, extra);
  return { w, bat, res, c, extra, rec: c.branches.get(bat.id) };
}

/** circuit.js:88 的口径：wire 口下标，顺序 = ports 里出现的顺序 */
const wirePorts = (e) => {
  const wp = [];
  for (let i = 0; i < e.ports.length; i++) if (e.ports[i].kind === 'wire') wp.push(i);
  return wp;
};

/** 印的记号 → 符号。认得 U+2212 '−' 与 ASCII '−'。 */
function labelSign(label) {
  const s = String(label == null ? '' : label).trim();
  if (s === '+' || s === '＋') return +1;
  if (s === '−' || s === '-' || s === '–' || s === '—' || s === '－') return -1;
  return 0;
}

/**
 * 判据本体。U01 = U(端口0) − U(端口1)：U01 > 0 ⇒ 端口 0 是正端 ⇒ 它必须印 '+'。
 * 返回 {ok, why}；记号为 0 或两端同号或 U01≈0 时**如实**报不可判，不冒充通过。
 */
function polarityVerdict(labels, U01) {
  const s0 = labelSign(labels[0]), s1 = labelSign(labels[1]);
  if (s0 === 0 || s1 === 0) return { ok: false, why: `端口印的记号不是极性记号（'${labels[0]}'/'${labels[1]}'）—— 判据无从谈起` };
  if (s0 === s1) return { ok: false, why: `两端印了同一个记号（'${labels[0]}'/'${labels[1]}'）` };
  if (Math.abs(U01) < 1e-9) return { ok: false, why: `U(端口0) − U(端口1) = ${U01} V，电位差为 0 ⇒ 定不了正负端` };
  const want0 = U01 > 0 ? +1 : -1;
  if (s0 !== want0) {
    return { ok: false, why: `端口 0 印 '${labels[0]}'，但实测 U(端口0) − U(端口1) = ${U01.toFixed(6)} V ⇒ 端口 0 是${want0 > 0 ? '正' : '负'}端 ⇒ 印字与求解器**反向**` };
  }
  return { ok: true, why: `端口 0 印 '${labels[0]}'，实测 U(端口0) − U(端口1) = ${U01.toFixed(6)} V ⇒ 同向` };
}

// ══════════════════════════════════════════════════════════
head('§1 落点自证：求解器的 ka/kb 就是 ports[0]/ports[1]，U 的符号按 ka→kb 定义');
// ══════════════════════════════════════════════════════════
{
  const { bat, rec } = loop();
  const wp = wirePorts(bat);
  ok(wp.length === 2 && wp[0] === 0 && wp[1] === 1,
    `battery 的 wire 口 = [${wp.join(',')}] ⇒ 无显式 a/b 的支路取 ia=wp[0]=${wp[0]}、ib=wp[1]=${wp[1]}（solveCircuit() 里 "if (k === 0) { ia = wp[0]; ib = wp[1]; }"）`,
    { wp });
  ok(near(rec.U, EMF - RI * rec.I, 1e-9),
    `支路上报 U=${rec.U.toFixed(12)} V ↔ emf − ri·I = ${(EMF - RI * rec.I).toFixed(12)} V（偏差 ${Math.abs(rec.U - (EMF - RI * rec.I)).toExponential(2)}）⇒ U 的口径就是 V(ka) − V(kb)，不是它的反`,
    { U: rec.U, I: rec.I, emf: EMF, ri: RI, theory: EMF - RI * rec.I });
  ok(rec.U > 0,
    `放电时 U = emf − ri·I = ${rec.U.toFixed(6)} V > 0 ⇒ **ports[0] 电位高于 ports[1]**`,
    { U: rec.U, I: rec.I });

  // 硬约束护栏：不许用「把 emf 取反」或「调换端口坐标/顺序」来凑判据
  const br = bat.circuitBranch();
  ok(br.type === 'V' && br.emf === bat.props.emf && br.emf > 0,
    `circuitBranch() = {type:${br.type}, emf:${br.emf}}，emf 仍是**正的** props.emf（求解器侧未被改动）`,
    { branch: { type: br.type, emf: br.emf, r: br.r } });
  const X = batteryDef.ports.map((p) => p.x);
  ok(X[0] === -48 && X[1] === 48,
    `ports[].x 仍为 [${X.join(', ')}]（端口 0 在左）—— 靠调换端口顺序/坐标改极性是错误修法`,
    { x: X });
}

// ══════════════════════════════════════════════════════════
head('§2 判据：端口印的记号 ↔ U(端口) 的符号（改前必红）');
// ══════════════════════════════════════════════════════════
{
  // 独立路径：一条**开路虚拟支路**夹在端口 0 与端口 1 之间。open 不参与盖章
  // （`if (!br || br.type === 'V' || br.type === 'open') continue;`），故解不变；
  // 它的 U 由 `const U = (ia >= 0 ? x[ia] : 0) - (ib >= 0 ? x[ib] : 0)` 从节点解直接算，
  // 与器材级 state.U 不是同一条记录。
  let vref = null;
  const { bat, c, rec } = loop(EMF, RI, (b) => {
    // ⚠ state 必须由调用方给出：virtual 支路装配成 `state: x.state || {}`，
    //   不给就换成了另一个盒子，读 vref.state 会 undefined
    vref = { key: 'polarity-ref', a: { e: b.id, p: 0 }, b: { e: b.id, p: 1 }, type: 'open', state: {} };
    return [vref];
  });
  const U01 = rec.U;
  const labels = [batteryDef.ports[0].label, batteryDef.ports[1].label];
  const entLabels = [bat.ports[0].label, bat.ports[1].label];
  ok(entLabels[0] === labels[0] && entLabels[1] === labels[1],
    `entity 端口标签与 def 一致（Entity 构造函数透传 "label: p.label || ''"）：['${entLabels.join("','")}']`,
    { def: labels, ent: entLabels });

  const v = polarityVerdict(labels, U01);
  ok(v.ok,
    `干电池印字极性 ↔ 求解器极性**同向**：ports[0].label='${labels[0]}'、ports[1].label='${labels[1]}'、U(ports[0])−U(ports[1])=${U01.toFixed(6)} V ⇒ ${v.why}`,
    { U01, labels, verdict: v });

  ok(vref && Math.abs(vref.state.U - U01) < 1e-9 && vref.state.U > 0,
    `独立路径（开路虚拟支路，另一条记录）读 U(端口0) − U(端口1) = ${vref ? vref.state.U.toFixed(9) : 'n/a'} V，与器材级 ${U01.toFixed(9)} V 一致`,
    { virtual: vref ? vref.state.U : null, entity: U01, ok: c.ok, iterations: c.iterations });
}

// ══════════════════════════════════════════════════════════
head('§3 全域：emf 取值域只正 ⇒ ports[0] 恒为正端（不是某一点的巧合）');
// ══════════════════════════════════════════════════════════
{
  const f = batteryDef.fields.find((x) => x.k === 'emf');
  ok(f && f.min > 0 && f.max > 0,
    `fields.emf 取值域 [${f.min}, ${f.max}] step ${f.step} —— **只正**：电路里不存在反接的干电池 ⇒ 端口 0 恒为正端`,
    { min: f.min, max: f.max, step: f.step });

  const rows = [];
  for (let e = f.min; e <= f.max + 1e-9; e += f.step) {
    const { rec } = loop(e, RI);
    rows.push([+e.toFixed(3), +rec.U.toFixed(9), +rec.I.toFixed(9)]);
  }
  const bad = rows.filter((r) => !(r[1] > 0));
  ok(bad.length === 0,
    `全域 ${rows.length} 个 emf 取值实测 U(端口0)−U(端口1) 全部 > 0（emf=${rows[0][0]} 时 ${rows[0][1]} V … emf=${rows[rows.length - 1][0]} 时 ${rows[rows.length - 1][1]} V）⇒ 印字**恒**需与端口 0 同号`,
    { n: rows.length, min: rows[0], max: rows[rows.length - 1], bad });
}

// ══════════════════════════════════════════════════════════
head("§4 图形落点：'+'、'−'、正极凸点三者的左右必须一致");
// ══════════════════════════════════════════════════════════
function recorder() {
  const texts = [], fills = [];
  let pts = [];
  const t = {};
  const ctx = new Proxy(t, {
    get(o, k) {
      if (k in o) return o[k];
      switch (k) {
        case 'beginPath': return () => { pts = []; };
        case 'moveTo': case 'lineTo': case 'arcTo': return (x, y) => { pts.push([x, y]); };
        case 'fill': return () => { fills.push({ style: o.fillStyle, pts: pts.slice() }); };
        case 'fillText': return (s, x, y) => { texts.push({ s, x, y, style: o.fillStyle }); };
        case 'createLinearGradient': case 'createRadialGradient': return () => ({ addColorStop() {} });
        case 'canvas': return { width: 800, height: 600 };
        case 'measureText': return () => ({ width: 10 });
        default: return () => {};
      }
    },
    set(o, k, val) { o[k] = val; return true; },
  });
  return { ctx, texts, fills };
}
const bbox = (pts) => {
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  return { x0, x1, y0, y1, w: x1 - x0, h: y1 - y0 };
};
const HOT = '#ffd166', DIM = '#8d96a0';
{
  const bat = create('battery', 0, 0);
  bat.setProp('emf', 6);
  const { ctx, texts, fills } = recorder();
  bat.render(ctx);
  const half = bat.w / 2;

  const plus = texts.find((t) => String(t.s) === '+');
  const minus = texts.find((t) => String(t.s) === '−' || String(t.s) === '-');
  ok(!!plus && !!minus,
    `两种极性记号都画了：'+' @ x=${plus ? plus.x : 'n/a'}、'−' @ x=${minus ? minus.x : 'n/a'}`,
    { texts: texts.map((t) => ({ s: t.s, x: t.x, y: t.y, style: t.style })) });
  ok(!!plus && plus.x < 0 && !!minus && minus.x > 0,
    `'+' 必须画在**左侧**、'−' 必须画在**右侧**（与端口 0 = 左端 = 正端一致）：实测 '+' @ x=${plus ? plus.x : 'n/a'}、'−' @ x=${minus ? minus.x : 'n/a'}`,
    { plusX: plus ? plus.x : null, minusX: minus ? minus.x : null, half });
  ok(!!plus && plus.style === HOT && !!minus && minus.style === DIM,
    `记号搬家的同时配色也搬：'+' 用高亮 ${HOT}、'−' 用暗色 ${DIM}`,
    { plusStyle: plus ? plus.style : null, minusStyle: minus ? minus.style : null });
  ok(!!plus && !!minus && Math.abs(plus.x) <= half && Math.abs(minus.x) <= half,
    `两个记号仍落在壳体宽度内（|x| ≤ ${half}）—— 没有搬到壳体外面`,
    null);

  // 正极凸点：全场唯一一个 5×14 的实心圆角矩形
  const nubs = fills.map((f) => ({ ...bbox(f.pts), style: f.style })).filter((b) => b.w === 5 && b.h === 14);
  ok(nubs.length === 1,
    `正极凸点唯一可辨（${nubs.length} 个 5×14 实心矩形：${nubs.map((n) => `x ${n.x0.toFixed(1)}…${n.x1.toFixed(1)}`).join(' / ') || '无'}）`,
    { nubs });
  if (nubs.length === 1) {
    const cx = (nubs[0].x0 + nubs[0].x1) / 2;
    ok(cx < 0,
      `凸点必须画在**左侧**（与印的 '+' 同侧）：实测中心 x=${cx.toFixed(2)}`,
      { nubCenterX: cx, nub: nubs[0] });
    ok(!!plus && Math.sign(cx) === Math.sign(plus.x),
      `凸点与 '+' 记号同侧（凸点 x=${cx.toFixed(2)}、'+' x=${plus ? plus.x : 'n/a'}）—— 图形自洽`,
      { nubCenterX: cx, plusX: plus ? plus.x : null });
  }
  ok(fills.some((f) => { const b = bbox(f.pts); return b.w === bat.w && b.h === bat.h; }),
    `壳体面板照旧画出（${bat.w}×${bat.h} 实心矩形仍在）`,
    null);
  ok(texts.some((t) => String(t.s) === '6.0 V'),
    `电动势读数照旧画出：${texts.map((t) => JSON.stringify(t.s)).join(' ')}`,
    { texts: texts.map((t) => t.s) });
}

// ══════════════════════════════════════════════════════════
head('§5 读口排查：src/ 里还有谁把**端口标签**当逻辑读？');
// ══════════════════════════════════════════════════════════
{
  // 检索式：/label\s*[=!]==\s*(['"])…\1/g（剥行注释与块注释行）—— 只看**相等比较**，
  // 那才是「用标签做判断」。`label:` 是声明、`.label` 是取值，都不构成判据风险。
  const files = [];
  (function walk(d) {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (n.endsWith('.js')) files.push(p);
    }
  })(join(ROOT, 'src'));

  const hits = [];
  const RE = /label\s*[=!]==\s*(['"])([^'"]*)\1/g;
  for (const p of files) {
    let inBlock = false;
    readFileSync(p, 'utf8').split('\n').forEach((line, i) => {
      let s = line;
      if (inBlock) { const e = s.indexOf('*/'); if (e < 0) return; s = s.slice(e + 2); inBlock = false; }
      if (/^\s*\/\*/.test(s) && s.indexOf('*/', s.indexOf('/*') + 2) < 0) { inBlock = true; return; }
      const c = s.indexOf('//');
      if (c >= 0) s = s.slice(0, c);
      if (/^\s*\*/.test(s)) return;
      RE.lastIndex = 0;
      for (const m of s.matchAll(RE)) hits.push({ file: p.slice(ROOT.length + 1).replace(/\\/g, '/'), line: i + 1, lit: m[2] });
    });
  }
  const lits = [...new Set(hits.map((h) => h.lit))];
  info(`检索式 /label\\s*[=!]==\\s*(['"])…\\1/g ⇒ 命中 ${hits.length} 处、去重字面量 ${lits.length} 个：${lits.map((l) => `'${l}'`).join(' / ') || '（无）'}`);
  for (const h of hits) info(`  ${h.file}:${h.line}   label === '${h.lit}'`);

  const POLARITY = new Set(['+', '-', '−', '＋', '－']);
  const polar = hits.filter((h) => POLARITY.has(h.lit));
  ok(polar.length === 0,
    `没有一处把**极性记号**当逻辑读（命中 ${polar.length} 处）⇒ 干电池的 '−'/'+' 只是显示`,
    { polar });
  ok(lits.includes('滑片'),
    `扫描器有正向对照：电位器第三端 '滑片' 那条真读口**在**（Rheostat 里的 "p.label === '滑片'"）⇒ 上面的「0 处」不是扫了个空集`,
    { lits, hits: hits.filter((h) => h.lit === '滑片') });
}

// ══════════════════════════════════════════════════════════
head('§6 判据自证：同一 U01 下旧印法必须判红（判据不是恒绿断言）');
// ══════════════════════════════════════════════════════════
{
  const { bat, rec } = loop();
  const U01 = rec.U;
  const installed = [batteryDef.ports[0].label, batteryDef.ports[1].label];
  // 由**物理**（而不是「现装 vs 对调」）定出正确/错误两种印法 ⇒ 本节的断言与改没改无关。
  const want0 = U01 > 0 ? '+' : '−';
  const RIGHT = [want0, want0 === '+' ? '−' : '+'];
  const WRONG = [RIGHT[1], RIGHT[0]];

  const vRight = polarityVerdict(RIGHT, U01);
  const vWrong = polarityVerdict(WRONG, U01);
  ok(vRight.ok && !vWrong.ok,
    `同一 U01=${U01.toFixed(6)} V 下：与求解器同向的 ['${RIGHT.join("','")}'] 判绿、反向的 ['${WRONG.join("','")}'] 判红（反向那条：${vWrong.why}）⇒ 判据不是恒绿断言`,
    { verdictRight: vRight, verdictWrong: vWrong });
  ok(labelSign('+') === 1 && labelSign('−') === -1 && labelSign('-') === -1 && labelSign('A') === 0,
    `记号解析器认得 U+2212 '−' 与 ASCII '-'，对非极性记号（'A'）返回 0 ⇒ 不会把别的器材误判成极性件`,
    { plus: labelSign('+'), minusU2212: labelSign('−'), minusAscii: labelSign('-'), A: labelSign('A') });

  // 把「与求解器反向」的印法写进**内存里的** def.ports/ent.ports，判据必须报红并引用实际标签
  batteryDef.ports[0].label = WRONG[0]; batteryDef.ports[1].label = WRONG[1];
  bat.ports[0].label = WRONG[0]; bat.ports[1].label = WRONG[1];
  const vForced = polarityVerdict([batteryDef.ports[0].label, batteryDef.ports[1].label], U01);
  // 恢复：内存变异不许留在进程里
  batteryDef.ports[0].label = installed[0]; batteryDef.ports[1].label = installed[1];
  bat.ports[0].label = installed[0]; bat.ports[1].label = installed[1];

  ok(!vForced.ok,
    `把反向印法 ['${WRONG.join("','")}'] 写进内存后，**同一判据**报红并引用实际标签：${vForced.why}`,
    { installed, forced: WRONG, verdictForced: vForced });
  ok(batteryDef.ports[0].label === installed[0] && batteryDef.ports[1].label === installed[1],
    `内存变异已恢复（def.ports 标签 = ['${[batteryDef.ports[0].label, batteryDef.ports[1].label].join("','")}']）—— 探针对仓库零字节副作用`,
    { installedLabels: installed, verdictInstalled: polarityVerdict(installed, U01) });
}

// ══════════════════════════════════════════════════════════
const json = {
  probe: 'polarity',
  items: pass + fail, pass, fail,
  installedLabels: [batteryDef.ports[0].label, batteryDef.ports[1].label],
  checks: R.map((r) => ({ ok: r.ok, msg: r.msg, reading: r.reading })),
};
console.log('\n' + '─'.repeat(28));
console.log('JSON ' + JSON.stringify(json));
console.log(fail === 0
  ? `\x1b[32m极性判据全部通过：${pass} 项\x1b[0m`
  : `\x1b[31m极性判据未通过：${pass + fail} 项，失败 ${fail} 项\x1b[0m`);
process.exit(fail === 0 ? 0 : 1);
