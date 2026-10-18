// ══════════════════════════════════════════════════════════
// 无头探针：第三端口被静默丢弃（circuit.js 支路收集）
//
//   node tools/third-port-probe.mjs            绿档
//   node tools/third-port-probe.mjs --mutate   红档（变异体落在 %TEMP%，仓库零字节改动）
//
// 这条要证明的是**一件"能接线但不工作"的最坏形态**：
//   求解器一个器材只取一条支路，用前两个 `kind:'wire'` 端口（circuit.js:76-83）。
//   第三端口及以后**无处可接**，而用户看不出任何异常 —— 以为三端器件已经接好。
//
// 本次只做**明确记账 + 一次性告警**（c=port-ignored 记录进解算结果），
// **不做**「一器材多支路」（circuitBranches()）契约 —— 那是下一步。
//
// 四条判据：
//   ① 三端桩件 ⇒ 恰好 1 条 port-ignored，点名是哪个接线柱；两端器材 ⇒ 0 条（不误报）
//   ② 第三端口确实没进任何支路：接上/拆掉第三根线，解**逐位相同**；
//      且实测电流与「支路只在 T1–T2 上」的解析解一致，与「支路在 T1–T3 上」的解析解**不同**
//   ③ 一次性：连解 3 帧 ⇒ 记录 3 条（每帧一条），console.warn 只喊 1 次（逐帧喊=噪音=没有告警）
//   ④ 存量体检：今天全仓没有任何器材声明 >2 个 wire 口 ⇒ 新告警在现有场景零噪音
//      + **历史**：变压器原先"根本没有二次侧端子"（U₂/I₂ 是解析量，不是求解器给的）
//        —— 现已有「二次+ / 二次−」真接线柱与二次支路；那条事实只在"二次侧没接线"时成立
// ══════════════════════════════════════════════════════════

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const REPO = new URL('../', import.meta.url);

const known = new Set(['--mutate']);
const bad = process.argv.slice(2).filter((a) => !known.has(a));
if (bad.length) {
  console.log(`✗ 不认识的开关：${bad.join(' ')} —— 本探针只认 ${[...known].join(' / ')}`);
  process.exit(2);
}
const MUTATE = process.argv.includes('--mutate');

const stripComments = (s) => s.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
const readRaw = (rel) => readFileSync(new URL(rel, REPO), 'utf8');
const readCode = (rel) => stripComments(readRaw(rel));
const CIRCUIT_SRC = 'src/physics/circuit.js';

import { World } from '../src/core/world.js';
import { PluginHost } from '../src/core/plugin.js';
import { create, bindRegistry } from '../src/equipment/registry.js';
import { solveCircuit } from '../src/physics/circuit.js';

import physicsPlugin from '../src/physics/circuit.js';
import electricalPlugin from '../src/equipment/electrical.js';
import electronicsPlugin from '../src/equipment/electronics.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => {
  if (cond) { pass++; console.log('  \x1b[32m✓\x1b[0m ' + msg); }
  else { fail++; console.log('  \x1b[31m✗\x1b[0m ' + msg); }
};
const head = (t) => console.log('\n\x1b[36m' + t + '\x1b[0m');
const info = (t) => console.log('    \x1b[90m' + t + '\x1b[0m');
const near = (a, b, tolRel) => Math.abs(a - b) <= tolRel * Math.max(1e-12, Math.abs(b));

const bootApp = {
  services: {}, ticks: [], world: null, lastCircuit: null, selected: null,
  log: { push() {}, clear() {} }, toast() {},
  addTick(fn) { this.ticks.push(fn); return () => {}; },
};
const host = new PluginHost(bootApp);
for (const p of [physicsPlugin, electricalPlugin, electronicsPlugin]) host.define(p);
host.installAll();
bindRegistry(host.registry('equipment'));

/** 三端桩件：一条 **R** 支路（R 支路的语义被 meter/motor 探针钉死，不靠猜） */
function stub3(id, type = 'stub3', R = 50) {
  return {
    id, type, x: 0, y: 0, props: {}, state: {},
    ports: [
      { x: -20, y: -8, kind: 'wire', label: 'T1' },
      { x: 20, y: -8, kind: 'wire', label: 'T2' },
      { x: 0, y: 14, kind: 'wire', label: 'T3' },
    ],
    circuitBranch() { return { type: 'R', r: R }; },
  };
}
/** 桩件必须在端口上：造一个「电池 + 三端桩件」的回路，第三根线可选 */
function scene(withThirdWire, type = 'stub3', R = 50) {
  const w = new World();
  const bat = create('battery', -120, 0);
  const st = stub3('stub3-' + (withThirdWire ? 'on' : 'off'), type, R);
  w.add(bat, true); w.add(st, true);
  w.connect({ e: bat.id, p: 1 }, { e: st.id, p: 0 }, 'wire');
  w.connect({ e: st.id, p: 1 }, { e: bat.id, p: 0 }, 'wire');
  if (withThirdWire) w.connect({ e: st.id, p: 2 }, { e: bat.id, p: 1 }, 'wire');  // T3 并到 T1 那个节点
  const c = solveCircuit(w, []);
  return { w, bat, st, c, I: c.branches.get(st.id).I };
}

// ══════════════════════════════════════════════════════════
head('① 三端桩件 ⇒ 恰好 1 条 port-ignored；两端器材 ⇒ 0 条（不误报）');
// ══════════════════════════════════════════════════════════
const A = scene(true);
const B = scene(false);
ok(Array.isArray(A.c.warnings), `解算结果带 warnings 字段（${JSON.stringify(A.c.warnings.length)} 条）`);
const wA = A.c.warnings.filter((x) => x.code === 'port-ignored');
ok(wA.length === 1, `接了三根线 ⇒ port-ignored ${wA.length} 条（恰好 1 条，不是 0 也不是 3）`);
ok(wA.length === 1 && wA[0].type === 'stub3' && wA[0].ports.length === 1 && wA[0].ports[0] === 2,
  wA.length === 1 ? `点名到位：type=${wA[0].type}，被忽略的是第 ${wA[0].ports[0] + 1} 号端口（T3）` : '点名断言：拿不到记录');
ok(wA.length === 1 && /T3/.test(wA[0].msg), wA.length === 1 ? `文案含接线柱名：${wA[0].msg}` : '文案断言：拿不到记录');
ok(B.c.warnings.length === 0, `只接两根线 ⇒ warnings ${B.c.warnings.length} 条（不误报）`);
{
  const line = scene(true);   // 电池只有两根线，但同场景里再放一只两端的电阻
  const r = create('resistor', 0, 120);
  line.w.add(r, true);
  const c2 = solveCircuit(line.w, []);
  const wp = c2.warnings.filter((x) => x.code === 'port-ignored' && x.type === 'resistor');
  ok(wp.length === 0, `两端器材（resistor）在同场景里不受影响：${wp.length} 条记录`);
}

// ══════════════════════════════════════════════════════════
head('② 第三端口确实没进任何支路：接上/拆掉第三根线，解逐位相同');
// ══════════════════════════════════════════════════════════
ok(A.I === B.I, `电流逐位相同：接上 T3 = ${A.I}，拆掉 = ${B.I}（差 ${Math.abs(A.I - B.I)}）`);
{
  // 两条独立路径对撞（R 支路语义：I = emf/(rint+R)，与 meter/motor 探针同一口径）：
  //   真值（支路在 T1–T2 上）—— 1.5 V / (rint + 50 Ω)，小电流
  //   假设（支路在 T1–T3 上）—— T3 与 T1 是同一节点 ⇒ 支路被短接 ⇒ I = 1.5/rint，大 100 倍以上
  const emf = A.bat.props.emf, rint = Math.max(0.01, A.bat.props.internalR);
  const wantT1T2 = emf / (rint + 50);
  const wantShorted = emf / rint;
  ok(near(Math.abs(A.I), wantT1T2, 1e-3),
    `实测 ${Math.abs(A.I).toExponential(4)} A ⟷ 解析「支路在 T1–T2」${wantT1T2.toExponential(4)} A（emf=${emf} V, rint=${rint} Ω, R=50 Ω）`);
  ok(Math.abs(A.I) < wantShorted / 100,
    `且**不是**「支路在 T1–T3」的解析解 ${wantShorted.toExponential(3)} A（支路被短接）⇒ 端口对确实取自前两个 wire 口，这条断言有 100 倍的分辨力`);
}

// ══════════════════════════════════════════════════════════
head('③ 一次性：连解 3 帧 ⇒ 记录 3 条、console.warn 只喊 1 次');
// ══════════════════════════════════════════════════════════
{
  // ⚠ 用一个**新的 type**：warnOnce 按 type 去重，前面 ① 已经用 'stub3' 喊过了。
  // ⚠⚠ 补丁必须装在 `scene()` **之前**：scene 内部自己会解一次电路（那一帧就是"第一次"）——
  //    装晚了会漏掉首帧，量到 0 次，然后误判成"去重坏了"。
  const old = console.warn;
  let calls = 0;
  console.warn = () => { calls++; };
  const s = scene(true, 'stub3-warnonce');
  const firstFrame = calls;
  let records = 0;
  for (let i = 0; i < 3; i++) records += solveCircuit(s.w, []).warnings.filter((x) => x.code === 'port-ignored').length;
  console.warn = old;
  ok(firstFrame === 1, `首帧（scene 内部那次 solve）喊了 ${firstFrame} 次`);
  ok(records === 3, `再连解 3 帧，每帧各记 1 条（共 ${records} 条）`);
  ok(calls === 1, `整个过程总计只喊 ${calls} 次（1/120 s 逐帧喊 = 噪音 = 等于没有告警）`);
}
{
  // 去重是按 type 的：同型器材再解一次也不再喊（但记录照样每帧一条）
  const s = scene(true, 'stub3-warnonce');
  const old = console.warn;
  let calls = 0;
  console.warn = () => { calls++; };
  const c = solveCircuit(s.w, []);
  console.warn = old;
  ok(calls === 0 && c.warnings.filter((x) => x.code === 'port-ignored').length === 1,
    `同型器材第二次：console.warn ${calls} 次、记录仍有 1 条（去重的是告警，不是记账）`);
}

// ══════════════════════════════════════════════════════════
head('④ 存量体检：多 wire 口器材必须自己声明 circuitBranches（否则第 3 口起还是被忽略）');
// ══════════════════════════════════════════════════════════
{
  const all = host.registry('equipment').list();
  const multi = [], naked = [];
  for (const d of all) {
    const n = (d.ports || []).filter((p) => p.kind === 'wire').length;
    if (n <= 2) continue;
    multi.push(`${d.type}(${n})`);
    // 契约要求：多口器材必须自己声明支路 —— 只声明端口、不声明支路的，第 3 口起依旧无处可接
    let inst = null;
    try { inst = create(d.type, 0, 0); } catch (err) { inst = null; }
    if (!inst || typeof inst.circuitBranches !== 'function') naked.push(d.type);
  }
  ok(multi.length > 0 && naked.length === 0,
    `多 wire 口器材 ${multi.length} 件（${multi.join(', ') || '无'}）：全部声明了 circuitBranches()，`
    + `${naked.length} 件"只声明端口"的存量器材（这类才是静默丢弃的隐患）`);
  ok(all.length > 0, `体检面非空：${all.length} 件（不是空转的"全部合格"）`);
  // 契约生效的实测：三端电位器三根线全接 ⇒ 0 条告警（告警随契约自然消失）
  {
    const w = new World();
    const bat = create('battery', -160, 0);
    const rh = create('rheostat', 0, 0);
    w.add(bat, true); w.add(rh, true);
    w.connect({ e: bat.id, p: 1 }, { e: rh.id, p: 0 }, 'wire');
    w.connect({ e: rh.id, p: 1 }, { e: bat.id, p: 0 }, 'wire');
    w.connect({ e: rh.id, p: 2 }, { e: bat.id, p: 1 }, 'wire');   // 滑片也接上
    const c = solveCircuit(w, []);
    const ignored = c.warnings.filter((x) => x.code === 'port-ignored').length;
    ok(ignored === 0 && c.branches.has(rh.id + '#1'),
      `三端电位器三根线全接：${ignored} 条 port-ignored，且求解器为它建了 2 条支路（${rh.id} / ${rh.id}#1）`
      + ' —— 上一版这条告警会响，现在随契约自然消失');
  }
}
{
  // ⚠ 本条已从「事实」变成「历史」（task-62 Step B）：改动前变压器**根本没有二次侧端子**、
  //   U₂/I₂ 只是解析量。现在 xfmrDef.ports 里有「二次+ / 二次−」两个真接线柱，
  //   Transformer.circuitBranches(world) 也实现了：
  //     · 二次侧**整边没接线** ⇒ 返回 null ⇒ 回落 circuitBranch()（r=R1）——旧用法逐字不变 ✓
  //     · 二次侧**接了线**   ⇒ 一次/二次两条支路都进矩阵，U₂/I₂/P 由**求解器**给（state.U2src='solver'）
  //   所以下面第一条判据改成"现在的端口事实"，第二条保留**未接线切片**上的旧事实，
  //   第三条把原来的"没有端子"升级成"接线后二次侧真在矩阵里、且 I₂ = n·I₁ 收敛"。
  //   ⚠ 仍然成立的那条禁令：耦合量只读**上一帧** state（E₁ = U₁ − I₁·R₁ 也用上一帧量）
  //     ⇒ 本帧 solve 内是常量，不造迭代内代数环（与 Motor 那条注释不冲突）。
  const w = new World();
  const bat = create('battery', -200, 0);
  const tf = create('transformer', 0, 0);
  w.add(bat, true); w.add(tf, true);
  w.connect({ e: bat.id, p: 1 }, { e: tf.id, p: 0 }, 'wire');
  w.connect({ e: tf.id, p: 1 }, { e: bat.id, p: 0 }, 'wire');
  const c = solveCircuit(w, []);
  const rec = c.branches.get(tf.id);
  const wirePorts = tf.ports.filter((p) => p.kind === 'wire');
  ok(wirePorts.length === 4 && wirePorts.filter((p) => p.label.startsWith('二次')).length === 2
    && c.warnings.length === 0,
    `变压器有 ${wirePorts.length} 个 wire 口（${wirePorts.map((p) => p.label).join('/')}）⇒ 0 条告警`
    + '（**历史**：改动前是 2 口 /「根本没有二次侧端子」—— 那条现在是历史，不再是事实）');
  ok(c.branches.size === 2 && !c.branches.has(tf.id + '#1') && near(rec.R, tf.props.R1, 1e-9),
    `二次侧没接线时仍只有**一条**支路、r=${rec.R} Ω = 一次铜阻 R1 ⇒ 旧用法逐字不变（回落路径 ✓）`);
  ok(tf.state.U2src === 'analytic' && !(rec.R === tf.props.RL) && typeof tf.state.U2 === 'number',
    `未接线时二次量仍走解析路径：state.U₂=${tf.state.U2.toFixed(4)} V（U2src=${tf.state.U2src}）`
    + '由 U₁·N₂/N₁ 算出 ⇒ 解析量不冒充实测');

  // ⭐ 新事实：二次侧接真负载 ⇒ 两条支路都进矩阵
  const w2 = new World(); w2.time = 0;
  const bat2 = create('battery', -300, 0); bat2.props.emf = 6; bat2.props.internalR = 0.01; w2.add(bat2, true);
  const tf2 = create('transformer', 0, 0); w2.add(tf2, true);
  const ld = create('resistor', 300, 220); ld.props.resistance = 10; w2.add(ld, true);
  w2.connect({ e: bat2.id, p: 1 }, { e: tf2.id, p: 0 }, 'wire');
  w2.connect({ e: tf2.id, p: 1 }, { e: bat2.id, p: 0 }, 'wire');
  w2.connect({ e: tf2.id, p: 2 }, { e: ld.id, p: 0 }, 'wire');
  w2.connect({ e: ld.id, p: 1 }, { e: tf2.id, p: 3 }, 'wire');
  let c2 = null;
  for (let i = 0; i < 8; i++) {
    c2 = solveCircuit(w2, []);
    for (const e of w2.entities) if (typeof e.step === 'function') e.step(1 / 120, w2);
    w2.time += 1 / 120;
  }
  const p2 = c2.branches.get(tf2.id), s2 = c2.branches.get(tf2.id + '#1');
  const n2 = tf2.props.N1 / tf2.props.N2;
  ok(!!p2 && !!s2 && c2.branches.size === 4,
    `二次侧接线后支路数 ${c2.branches.size}（电池 + 负载 + 主边 + **次边 ${tf2.id}#1**）⇒ 二次侧真进了矩阵`);
  ok(tf2.state.U2src === 'solver' && near(tf2.state.U2, s2.U, 1e-12),
    `U₂ 改由求解器给：state.U₂=${tf2.state.U2.toFixed(6)} V = 次边支路 U（U2src=${tf2.state.U2src}）⇒ 不再是解析量`);
  ok(near(Math.abs(p2.I), Math.abs(s2.I) / n2, 0.01),
    `I₂ = n·I₁（残差 = 滞后一帧未完全收敛）：I₁=${p2.I.toFixed(6)} A ⟷ I₂/n=${(s2.I / n2).toFixed(6)} A`
    + `（相对差 ${(Math.abs(Math.abs(p2.I) - Math.abs(s2.I) / n2) / (Math.abs(s2.I) / n2) * 100).toFixed(2)}%）`);
}

// ══════════════════════════════════════════════════════════
head('⑤ 源码口径：记账写在支路收集处，且锚点不在注释里');
// ══════════════════════════════════════════════════════════
{
  const raw = readRaw(CIRCUIT_SRC), code = readCode(CIRCUIT_SRC);
  const anchor = "code: 'port-ignored'";
  ok(code.includes(anchor), `记账写在代码行上（剥注释后命中 ${anchor}）`);
  ok(raw.split(anchor).length - 1 === code.split(anchor).length - 1,
    `锚点不在注释里：原始 ${raw.split(anchor).length - 1} 次 ⟷ 剥注释 ${code.split(anchor).length - 1} 次`);
  ok(code.includes('warnings.push(') && code.includes('warnOnce('),
    'warnings.push 与 warnOnce 都在代码行上（记账 + 告警两件事都真的发生）');
}

// ══════════════════════════════════════════════════════════
head('⑥ 并联 V 支路：解是唯一的，但 KCL 必须按**支路朝向**算');
// ══════════════════════════════════════════════════════════
// 这段的来历：本探针第一版把「电池 V 支路 ∥ 桩件 V 支路」手推成 (2−1.5)/(1+1) = 0.25 A，实测 2.3333 A，
// 看起来差 9 倍、很像求解器出错。查清后是**我的手推错了两次**，求解器两次都对：
//   ① 拓扑错 —— 两个源是**并联**，我写的是串联回路的式子；
//   ② 朝向错 —— 我把电池的极性相对桩件接反了（电池 ka=负极所在口、kb=正极所在口）。
// 实测规律（三处场景一致）：U = emf − I·r，其中 U = V(ka) − V(kb)、ka/kb 由前两个 wire 口的先后定序，
//   I 是 ka→kb 方向的电流 ⇒ 两条支路**朝向相反**时，它们的电流不能直接相加（相加得到的 4.667 A 没有物理意义）。
// 所以：把正确解写成断言，而不是让一个"看着像 bug"的读数留在世界上。
{
  const mk = (reverseBattery) => {
    const w = new World();
    const bat = create('battery', -120, 0);
    const st = {
      id: 'pst', type: 'pst', x: 0, y: 0, props: {}, state: {},
      ports: [{ x: -20, y: 0, kind: 'wire', label: 'A' }, { x: 20, y: 0, kind: 'wire', label: 'B' }],
      circuitBranch: () => ({ type: 'V', emf: 2, r: 1 }),
    };
    w.add(bat, true); w.add(st, true);
    // reverseBattery=true：电池 + 端接桩件 A（两支路朝向**相反**）；false：两端同向
    w.connect({ e: bat.id, p: reverseBattery ? 1 : 0 }, { e: 'pst', p: 0 }, 'wire');
    w.connect({ e: 'pst', p: 1 }, { e: bat.id, p: reverseBattery ? 0 : 1 }, 'wire');
    const c = solveCircuit(w, []);
    return { st: c.branches.get('pst'), bat: c.branches.get(bat.id) };
  };
  // 朝向相反：1.5 V 与 2 V 反向并联，环流 7/3 A，桩件端电压 −1/3 V
  const rev = mk(true);
  ok(near(rev.st.U, -1 / 3, 1e-9),
    `朝向相反：桩件端电压 U = ${rev.st.U.toFixed(12)} V ⟷ 手推 −1/3 V（两个源互相顶 ⇒ 谁也没赢）`);
  ok(near(Math.abs(rev.st.I), 7 / 3, 1e-9),
    `且环流 |I| = ${Math.abs(rev.st.I).toFixed(12)} A ⟷ 手推 7/3 A（= (2−(−1.5))/(1+0.5) 在反向并联下的正确形式）`);
  ok(near(rev.st.U, 2 - rev.st.I * 1, 1e-9),
    '本构方程回代成立：U = emf − I·r（残差 ~1e-12 ⇒ 这是"合法解"，不是求解器乱给数）');
  ok(near(rev.st.I, rev.bat.I, 1e-9),
    `KCL 按朝向算：两条支路朝向相反 ⇒ 电流应**相等**（桩件 ${rev.st.I.toFixed(6)} ⟷ 电池 ${rev.bat.I.toFixed(6)}），`
    + `直接相加得到的 ${(rev.st.I + rev.bat.I).toFixed(6)} A 没有物理意义`);
  // 同向对照：这才是"并联电压源"的通常直觉（U=5/3 V、|I|=1/3 A、朝向一致时相加为 0）
  const same = mk(false);
  ok(near(same.st.U, 5 / 3, 1e-9) && near(Math.abs(same.st.I), 1 / 3, 1e-9),
    `同向对照：U = ${same.st.U.toFixed(12)} V、|I| = ${Math.abs(same.st.I).toFixed(12)} A ⟷ 手推 5/3 V、1/3 A（朝向一致时两支路电流相加 = ${(same.st.I + same.bat.I).toExponential(2)} ⇒ 才为 0）`);
}

// ══════════════════════════════════════════════════════════
if (MUTATE) {
  head('⑦ --mutate：把记账掐掉（回到静默丢弃）⇒ 告警断言必须红，两条对照必须仍绿');
  const srcRaw = readRaw(CIRCUIT_SRC);
  const srcCode = stripComments(srcRaw);
  const OLD = 'if (wp.length > 2) {';
  const NEW = 'if (false) { // MUTANT：回到静默丢弃第三端口';
  const nOld = srcCode.split(OLD).length - 1;
  ok(nOld === 1, `变异锚点在代码行上且唯一（剥注释后 ${nOld} 次）`);
  ok(srcRaw.split(OLD).length - 1 === nOld, `锚点不在注释里：原始 ${srcRaw.split(OLD).length - 1} 次 ⟷ 剥注释 ${nOld} 次`);
  const mutated = srcRaw.replace(OLD, NEW);
  const mCode = stripComments(mutated);
  ok(!mCode.includes(OLD) && mCode.split(NEW).length - 1 === 1,
    `桩落在代码行上：变异体剥注释后旧行 0 处、新行 1 处`);
  const variantPath = fileURLToPath(new URL('xm-circuit-mutant.mjs', `file:///${process.env.TEMP.replace(/\\/g, '/')}/`));
  writeFileSync(variantPath, mutated, 'utf8');
  info('变异体 → ' + variantPath);
  const mod = await import(new URL('file:///' + variantPath.replace(/\\/g, '/')).href);

  const expected = [], ctrl = [];
  {
    const w = new World();
    const bat = create('battery', -120, 0);
    const st = stub3('mut-stub');
    w.add(bat, true); w.add(st, true);
    w.connect({ e: bat.id, p: 1 }, { e: st.id, p: 0 }, 'wire');
    w.connect({ e: st.id, p: 1 }, { e: bat.id, p: 0 }, 'wire');
    w.connect({ e: st.id, p: 2 }, { e: bat.id, p: 1 }, 'wire');
    const c = mod.solveCircuit(w, []);
    const mw = (c.warnings || []).filter((x) => x.code === 'port-ignored');
    // 两侧行为对比：同一场景，真身 1 条 ⟷ 变异体 0 条 —— 这才是"桩已生效"的证据
    // （不能用"变异体文本里没有 port-ignored"来判断：变异只改了守卫条件，那行记录文本还在、只是不可达）
    const realW = scene(true).c.warnings.filter((x) => x.code === 'port-ignored').length;
    ok(realW === 1 && mw.length === 0,
      `桩已生效：同一场景真身 ${realW} 条 ⟷ 变异体 ${mw.length} 条（记录已不可达 = 回到静默丢弃）`);
    expected.push(['三端件产生 1 条 port-ignored', mw.length === 1]);
    expected.push(['记录里点名 T3', mw.length === 1 && mw[0].ports[0] === 2]);
    const b2 = scene(false);
    ctrl.push(['两端场景 0 条告警', (mod.solveCircuit(b2.w, []).warnings || []).length === 0]);
    ctrl.push(['解与真身逐位相同（静默丢弃本来就是旧行为）',
      mod.solveCircuit(w, []).branches.get(st.id).I === b2.I]);
  }
  {
    const all = host.registry('equipment').list();
    ctrl.push(['存量体检仍绿（多口器材全都声明了支路）',
      all.every((d) => {
        if ((d.ports || []).filter((p) => p.kind === 'wire').length <= 2) return true;
        let i = null; try { i = create(d.type, 0, 0); } catch (err) { return false; }
        return !!i && typeof i.circuitBranches === 'function';
      })]);
  }
  const observedRed = expected.filter(([, v]) => !v).length;
  const ctrlBad = ctrl.filter(([, v]) => !v).length;
  console.log('');
  for (const [m, v] of expected) console.log(`    ${v ? '\x1b[31m✗\x1b[0m 未红' : '\x1b[32m✓\x1b[0m 已红'} ${m}`);
  for (const [m, v] of ctrl) console.log(`    ${v ? '\x1b[32m✓\x1b[0m 仍绿' : '\x1b[31m✗\x1b[0m 误红'} ${m}`);
  ok(observedRed === expected.length && expected.length > 0,
    `期望变红 ${expected.length} 条，实测变红 ${observedRed} 条`);
  ok(ctrlBad === 0, `对照组误红 ${ctrlBad} 条`);
  console.log('\n\x1b[1mTHIRDPORT_MUTATE_JSON\x1b[0m ' + JSON.stringify({
    expectedRed: expected.length, observedRed, ctrlBad, stubLanded: true, landInCode: true,
    ok: observedRed === expected.length && expected.length > 0 && ctrlBad === 0,
  }));
}

console.log(`\n\x1b[1m全部通过：${pass} 项\x1b[0m` + (fail ? `  \x1b[31m失败 ${fail} 项\x1b[0m` : ''));
console.log('THIRDPORT_JSON ' + JSON.stringify({ items: pass, fail, mutate: MUTATE }));
process.exit(fail ? 1 : 0);
