// ══════════════════════════════════════════════════════════
// 求解器 R ≤ 0 / 非有限 的「双路径一致性」探针（task-53）
//
//   node tools/circuit-rle0-probe.mjs            正常读数
//   node tools/circuit-rle0-probe.mjs --red      D43 红能力（仓库零字节改动）
//   ⚠ 只认上面这两档；**任何别的开关一律 exit=2 明确报错**（不认识的开关 + exit=0 = 空转的绿 ✗）
//   ⚠ 判据与变异提取器的输入**先剥注释**（见文件内 stripComments 处的纪律；§1 前有自检断言锁这件事）
//
// 现象（我在 C5 里查出来的，`tools/meter-ideal-probe.mjs` §4b 是它的第一次出现）：
//   求解器对同一条 R 支路有**两条**算 R 的路径，且对 `R <= 0` / 非有限给出**不同**答案：
//     · 盖章路径 `src/physics/circuit.js:169-170`
//         if (!(R > 0) || !isFinite(R)) R = 1e9;            ← 显式守卫：非正/非有限 ⇒ 当作断路
//         R = Math.max(1e-4, Math.min(R, 1e9));
//     · 上报路径 `:231`
//         R = Math.max(1e-4, resOf(b, U));                   ← 无守卫 ⇒ 0 变成 1e-4（近短路）
//   ⇒ 解出来的物理量按「近断路」（真实回路电流 ≈ E/(r+1e9+R)），而 `state.I` 按「近短路」报，
//     实测相差 9.99e12 倍。**这两条路径对同一件事必须给同一个答案**，就是本探针的判据。
//
// 判据不是"某个数字对不对"，而是**跨路径一致性** + 与同回路其它支路（R 正常、两路径必然一致）
// 的实测一致。只测"自报值"会假绿（自报值自己跟自己对得上）。
//
// 边界（D37 正控，§3）：**正的**小值（如 5e-9）两条路径本来就一致（都夹到 1e-4）⇒ 修法
// 不得把这一档也改掉。所以 §3 是"锁边界"，不是"锁差异"：它修前修后都必须绿。
//
// 什么改动会让它红（D43 清单）：
//   · 上报路径缺守卫（当前状态）⇒ §1/§2 红 —— 这正是缺陷本身
//   · 修好后又把守卫删掉 ⇒ §1/§2 红；`--red` 用变异体证明这件事
//   · 把关卡改成"两边都夹到 1e-4"（把盖章侧也改成近短路）⇒ §1 的见证行会变红（真实回路电流
//     不再符合 1e9 闭式），因为那会**同时**改掉物理
// ══════════════════════════════════════════════════════════

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { World } from '../src/core/world.js';
import { PluginHost } from '../src/core/plugin.js';
import { create, bindRegistry } from '../src/equipment/registry.js';
import { solveCircuit } from '../src/physics/circuit.js';

import physicsPlugin from '../src/physics/circuit.js';
import electricalPlugin from '../src/equipment/electrical.js';

const RED = process.argv.includes('--red');
const CIRCUIT = new URL('../src/physics/circuit.js', import.meta.url);

// ── 未知开关 ⇒ 明确报错退出（不许静默忽略）──
// 理由：不认识的开关 + exit=0 与「我验了」长得一模一样（本探针曾被 `--red=m1` 静默忽略过 ⇒ 空转 ✗）。
{
  const known = new Set(['--red']);
  const bad = process.argv.slice(2).filter((a) => !known.has(a));
  if (bad.length) { console.log(`✗ 不认识的开关：${bad.join(' ')} —— 本探针只认 ${[...known].join(' / ')}`); process.exit(2); }
}

// 纪律（本仓既有）：判据与变异提取器的输入是**代码**，注释不是它的输入 ⇒ 先剥注释再匹配。
// 反例：`fixPresent` 一旦被注释里的守卫字面量"顶上"，就会在**缺陷仍在**时假绿 ✗。
const stripComments = (s) => s.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

/** 上报路径是否已有与盖章路径同一条守卫（= 缺陷是否已被修） */
const REPORT_GUARD = /R = Math\.max\(1e-4, resOf\(b, U\)\)/;
const GUARD_LINE = `      if (!(R > 0) || !isFinite(R)) R = 1e9;\n`;
const srcNowRaw = readFileSync(CIRCUIT, 'utf8');
const srcNow = stripComments(srcNowRaw);   // ← 判据与提取器都用它（注释不是它们的输入）
// 上报分支里有没有那条守卫：取 `resOf(b, U)` 所在分支往后一行看
const repIdx = srcNow.indexOf('resOf(b, U)');
const fixPresent = repIdx >= 0 && /if \(!\(R > 0\) \|\| !isFinite\(R\)\) R = 1e9;/.test(srcNow.slice(repIdx, repIdx + 400));

let mutantNote = null;
let solve = solveCircuit;
if (RED) {
  let src = srcNow;
  if (!fixPresent) {
    console.log('    \x1b[33m--red：上报路径还没有那条守卫，无变异目标（这正是缺陷本身）\x1b[0m');
  } else {
    const before = src;
    // 变异 = **只摘掉上报路径那条守卫**（保留夹取）⇒ 退化成修前的行为：0 ⇒ max(1e-4, 0) = 1e-4
    src = src.replace(/(R = resOf\(b, U\);\n)(?:      \/\/[^\n]*\n)*      if \(!\(R > 0\) \|\| !isFinite\(R\)\) R = 1e9;\n/, '$1');
    if (src === before) throw new Error('变异未命中：上报路径的守卫没匹配上（先怀疑提取器，D49）');
    const specs = [...src.matchAll(/from\s+'(\.[^']+)'/g)];
    for (const m of specs) src = src.split(`'${m[1]}'`).join(`'${new URL(m[1], CIRCUIT).href}'`);
    const out = new URL(`file:///${process.env.TEMP.replace(/\\/g, '/')}/xm-rle0-mutant-${Date.now()}.mjs`);
    writeFileSync(out, src, 'utf8');
    mutantNote = out.href;
    solve = (await import(out.href)).solveCircuit;
  }
}

const fp = (url) => {
  const buf = readFileSync(url);
  return { file: url.pathname.split('/').slice(-2).join('/'), sha256: createHash('sha256').update(buf).digest('hex').toUpperCase(), bytes: buf.length };
};
const DEPS = [fp(CIRCUIT), fp(new URL('../src/equipment/electrical.js', import.meta.url))];

// ── 无头宿主 ──
const bootApp = { services: {}, world: null, lastCircuit: null, selected: null, log: { push() {}, clear() {} }, toast() {}, addTick() { return () => {}; } };
const host = new PluginHost(bootApp);
host.define(physicsPlugin); host.define(electricalPlugin); host.installAll();
bindRegistry(host.registry('equipment'));

// ── 断言器 ──
let pass = 0, fail = 0;
const ok = (cond, msg, extra) => {
  if (cond) { pass++; console.log('  \x1b[32m✓\x1b[0m ' + msg); }
  else { fail++; console.log('  \x1b[31m✗\x1b[0m ' + msg); }
  if (extra !== undefined) console.log('      \x1b[90m' + JSON.stringify(extra) + '\x1b[0m');
  return !!cond;
};
const head = (t) => console.log('\n\x1b[36m' + t + '\x1b[0m');
const info = (t) => console.log('    \x1b[90m' + t + '\x1b[0m');
const F = (v, d = 12) => (typeof v === 'number' ? (isFinite(v) ? v.toFixed(d) : String(v)) : String(v));
const rel = (a, b) => Math.abs(a - b) / Math.max(Math.abs(b), 1e-300);

const E = 1.5, R_INT = 0.5, R_LOOP = 10;
const STAMP_FALLBACK = 1e9, REPORT_FLOOR = 1e-4;

/** 电池 + 被测支路（电流表，可用 realR 指定内阻）+ 10Ω 定值电阻，串成单回路 */
function rig(branchR) {
  const world = new World();
  const bat = create('battery', 60, 60);
  const meter = create('ammeter', 160, 60);
  const res = create('resistor', 260, 60);
  bat.setProp('emf', E); bat.setProp('internalR', R_INT);
  res.setProp('resistance', R_LOOP);
  if (branchR === Infinity) {
    // 没有器材会声明 Infinity，用实例级覆盖表达这一档（探针自带，不改仓库）
    meter.circuitBranch = () => ({ type: 'R', r: Infinity });
  } else {
    meter.setProp('realR', branchR);
  }
  world.add(bat, true); world.add(meter, true); world.add(res, true);
  world.connect({ e: bat.id, p: 0 }, { e: meter.id, p: 0 }, 'wire');
  world.connect({ e: meter.id, p: 1 }, { e: res.id, p: 0 }, 'wire');
  world.connect({ e: res.id, p: 1 }, { e: bat.id, p: 1 }, 'wire');
  for (let t = 0; t < 20; t++) { solve(world, []); world.step(1 / 60); }
  return { br: meter.circuitBranch(), I_self: meter.state.I, U_self: meter.state.U, R_self: meter.state.R, I_res: res.state.I, R_res: res.state.R };
}

console.log('求解器 R≤0 / 非有限 双路径一致性探针（task-53）  ' + (RED ? '\x1b[35m[变异体]\x1b[0m' : '[正常]'));
console.log('    \x1b[90m命令行：' + process.argv.join(' ') + '\x1b[0m');
for (const d of DEPS) console.log('    \x1b[90m依赖：' + d.file + '  ' + d.sha256 + '  ' + d.bytes + ' B\x1b[0m');
console.log('    \x1b[90m上报路径是否已有与盖章路径同一条守卫（= 缺陷是否已修）：' + fixPresent + '\x1b[0m');
if (mutantNote) console.log('    \x1b[90m变异体（D47 待证生效）：' + mutantNote + '\x1b[0m');

// ⚠ 为什么不是「自报 I 与同回路实测 I 相对差 < 1e-6」：这两支路串联，但每个节点对地都有
//   gmin=1e-12 S（`circuit.js:194`）⇒ 1e9 Ω 档的支路电流（1e-9 A 量级）与 1e-12 量级的分流是
//   同一量级，实测残差 1.000e-3，**物理上到不了 1e-6**。所以判据分三条：① 自报值自身一致
//   （I = U/R，防"报出垃圾"）；② 自报 R = **用同回路其它支路实测电流反推**的等效 R（独立见证，
//   不用自报的 I）；③ 两路同量级（比 < 1e6 ⇒ 缺陷那正是 9.99e12，差 6 个数量级，不是随便定的）。
const ratio = (a, b) => Math.max(Math.abs(a), Math.abs(b)) / Math.max(1e-300, Math.min(Math.abs(a), Math.abs(b)));

// ── 自检：证明上面那条纪律不是装饰（含"注入到断言窗口**内**"这一更强形态）──
// ⚠ 必须放在 `const ok`（本文件 L113 附近）**之后** —— 我第一次把它放在 `let mutantNote` 前，
//   正常档直接 ReferenceError（TDZ）⇒ 探针 exit=1。教训：自检块也是代码，位置要满足它自己的前置条件。
{
  const GUARD = GUARD_LINE.trim();
  const pred = (s) => /if \(!\(R > 0\) \|\| !isFinite\(R\)\) R = 1e9;/.test(s);
  ok('自检：剥注释后，注释里的守卫字面量**不**算"守卫已在代码里"', pred(stripComments('      // ' + GUARD + '\n')) === false);
  ok('自检：同一条**不**剥注释就会假绿（缺陷仍在也会报"已修"）', pred('      // ' + GUARD + '\n') === true);
  ok('自检：剥注释确实改动过真源码文本（否则本自检是空转）', srcNow !== srcNowRaw && srcNow.length < srcNowRaw.length);
  // 更强的一层：把注释注入到 `fixPresent` 真正读的那个 400 字窗口**内**，再重算锚点 ⇒ 结论必须不变
  const at = repIdx >= 0 ? srcNowRaw.indexOf('{', repIdx) + 1 : 0;
  const injected = at > 0 ? srcNowRaw.slice(0, at) + '\n      // ' + GUARD + '\n' + srcNowRaw.slice(at) : srcNowRaw;
  const j = stripComments(injected).indexOf('resOf(b, U)');
  const after = j >= 0 && pred(stripComments(injected).slice(j, j + 400));
  ok('自检：把守卫字面量作为注释注入到断言窗口**内** ⇒ `fixPresent` 结论不变',
    at > 0 && j >= 0 && after === fixPresent, `注入后=${after} 原=${fixPresent}`);
}
head('§1 「R = 0」：两条路径对同一支路必须给同一个答案');
const c0 = rig(0);
const closedOpen = E / (R_INT + STAMP_FALLBACK + R_LOOP);     // 盖章侧语义：近断路
const closedShort = E / (R_INT + REPORT_FLOOR + R_LOOP);      // 上报侧语义：近短路
const rFromSibling0 = Math.abs(c0.U_self / c0.I_res);
info(`支路 br = ${JSON.stringify(c0.br)}`);
info(`自报 I=${F(c0.I_self)} U=${F(c0.U_self)} R=${F(c0.R_self, 6)}｜同回路 10Ω 支路实测 I=${F(c0.I_res)} R=${F(c0.R_res, 6)}`);
info(`闭式(近断路 1e9Ω)=${F(closedOpen)}｜闭式(近短路 1e-4Ω)=${F(closedShort)}｜由同回路实测反推的等效 R=${F(rFromSibling0, 6)}`);
ok(rel(c0.I_self, c0.U_self / c0.R_self) < 1e-12, '① 自报值自身一致：I = U/R（防"报出垃圾"这条，修前修后都该绿）', { I: c0.I_self, U: c0.U_self, R: c0.R_self });
ok(rel(c0.R_self, rFromSibling0) < 1e-2, '② 自报 R 与**同回路其它支路实测电流反推**的等效 R 一致（独立见证：没用自报的 I）⇒ 非正就该报 1e9，不是 1e-4', { 自报R: c0.R_self, 反推R: rFromSibling0, 相对差: rel(c0.R_self, rFromSibling0) });
ok(ratio(c0.I_self, c0.I_res) < 1e6, '③ 自报 I 与同回路实测**同量级**（比 < 1e6；实测残差 ' + rel(c0.I_self, c0.I_res).toExponential(3) + ' 来自 gmin 分流，已可解释）', { 自报: c0.I_self, 同回路: c0.I_res, 比: ratio(c0.I_self, c0.I_res) });
ok(rel(c0.I_res, closedOpen) < 1e-2, '⚠ 见证：同回路实测电流符合**近断路**闭式 ⇒ 解出来的物理量是"断路"，不是"短路"（不是两边都错）', { 实测: c0.I_res, 闭式近断路: closedOpen, 相对偏高: rel(c0.I_res, closedOpen) });

head('§2 「R = Infinity」：同上');
const cInf = rig(Infinity);
const rFromSiblingInf = Math.abs(cInf.U_self / cInf.I_res);
info(`支路 br = ${JSON.stringify(cInf.br)}｜自报 I=${F(cInf.I_self)} U=${F(cInf.U_self)} R=${F(cInf.R_self, 6)}｜同回路实测 I=${F(cInf.I_res)}｜反推 R=${F(rFromSiblingInf, 6)}`);
ok(rel(cInf.I_self, cInf.U_self / cInf.R_self) < 1e-12, '① 自报值自身一致（I = U/R）', { I: cInf.I_self, U: cInf.U_self, R: cInf.R_self });
ok(rel(cInf.R_self, rFromSiblingInf) < 1e-2 && isFinite(cInf.R_self), '② 自报 R 有限且与反推值一致（非有限 ⇒ 1e9，而不是把 Infinity 原样报出去）', { 自报R: cInf.R_self, 反推R: rFromSiblingInf });
ok(ratio(cInf.I_self, cInf.I_res) < 1e6, '③ 自报 I 与同回路实测同量级', { 自报: cInf.I_self, 同回路: cInf.I_res, 比: ratio(cInf.I_self, cInf.I_res) });

head('§3 D37 正控 / 锁边界：**正的**小值（5e-9）两条路径本来就一致 ⇒ 修前修后都必须绿');
const cSmall = rig(5e-9);
info(`支路 br = ${JSON.stringify(cSmall.br)}｜自报 I=${F(cSmall.I_self)} R=${F(cSmall.R_self, 8)}｜同回路实测 I=${F(cSmall.I_res)}`);
ok(rel(cSmall.I_self, cSmall.I_res) < 1e-6, '正的小值仍然两路一致（都夹到 1e-4）⇒ 修法不得改动这一档', { 自报: cSmall.I_self, 同回路: cSmall.I_res, 自报R: cSmall.R_self, 期望R: REPORT_FLOOR });

if (RED) {
  head('§4 D47：先证变异体真的生效（可观测行为）');
  if (!fixPresent) {
    info('未做变异：上报路径还没有那条守卫（当前状态就是"缺守卫"）⇒ §1/§2 本身即红');
  } else {
    const cm = rig(0);
    ok(cm.R_self === REPORT_FLOOR || rel(cm.I_self, cm.I_res) > 1e6, 'D47：变异体已生效 —— 去掉上报路径的守卫后，自报 R=' + F(cm.R_self, 6) + '、自报 I 与同回路实测相差 ' + rel(cm.I_self, cm.I_res).toExponential(2) + ' 倍（仓库版应一致）', { 变异版R: cm.R_self, 变异版相对差: rel(cm.I_self, cm.I_res) });
  }
}

console.log('\n双路径一致性探针：' + (fail === 0 ? '全部通过：' + pass + ' 项' : '有失败：' + (pass + fail) + ' 项（失败 ' + fail + '）'));
console.log('RLE0_JSON ' + JSON.stringify({
  mode: RED ? 'red' : 'normal', summary: `${pass}/${pass + fail}`, passed: pass, failed: fail,
  fixPresent, mutant: mutantNote,
  r0: { I_self: c0.I_self, I_res: c0.I_res, R_self: c0.R_self, closedOpen, closedShort },
  rInf: { I_self: cInf.I_self, I_res: cInf.I_res, R_self: cInf.R_self },
  deps: DEPS.map((d) => d.file + '@' + d.sha256.slice(0, 16) + '/' + d.bytes + 'B').join('  '),
}));
process.exit(fail === 0 ? 0 : 1);
