// ══════════════════════════════════════════════════════════
// 无头验证：薄透镜两处口径必须**逐格同判**（task-47）
//
//   node tools/optics-lens-sign-probe.mjs              # 常态，EXIT=0
//   node tools/optics-lens-sign-probe.mjs --mutate     # 红测（拦截源码、仓库零字节改动）
//
// 被钉住的不变量：`thinLens()`（代数面）与 `screenReading()`（光屏面）在
// 全部 u 上 `real` / `inverted` 必须一致，重点是三档「不成像」：
//   · u ≤ 0（发光面越过透镜）· u = 0（物贴镜面）· u = f（出射平行光）
// 以及画布文案：`u ≤ 0` 时**不许**印「实像」/「虚像」，必须与光屏面同一句话。
//
// --mutate 的做法（D43：响应体拦截、仓库零字节改动）：把 optics.js 的**源码文本**
// 读进内存、只抹掉那两处守卫，写成 %TEMP% 下的临时模块再 import ⇒ 断言必须红。
// D47：先打印被改动的那两行、并证明变体确实回到了旧取值，再取读数。
// ══════════════════════════════════════════════════════════

import { World } from '../src/core/world.js';
import { PluginHost } from '../src/core/plugin.js';
import { create, bindRegistry, equipmentPlugins } from '../src/equipment/index.js';
import optics, { thinLens, screenReading, solveLens } from '../src/equipment/optics.js';
import physicsPlugin from '../src/physics/circuit.js';
import chemistryPlugin from '../src/chemistry/reactions.js';
import bridgePlugin from '../src/coupling/bridge.js';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const OPTICS = join(REPO, 'src', 'equipment', 'optics.js');
const MUTATE = process.argv.includes('--mutate');
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const bytes = (p) => readFileSync(p).length;

let pass = 0, fail = 0;
const ok = (cond, msg) => {
  if (cond) { pass++; console.log('  \x1b[32m✓\x1b[0m ' + msg); }
  else { fail++; console.log('  \x1b[31m✗\x1b[0m ' + msg); }
};
const head = (t) => console.log('\n\x1b[36m' + t + '\x1b[0m');
const f3 = (v) => (typeof v === 'number' && !Number.isFinite(v) ? String(v) : Number(v).toFixed(3));

/** 场次里被断言的那 10 个 u（预勘那张表的口径） */
const U_LIST = [-20, -10, -1, 0, 0.001, 4.999, 5, 5.001, 10, 20];
const F = 5, D = 100, YO = 6;

/** 同一 u 上的两个面：代数面（thinLens）与光屏面（screenReading 吃 solveLens 的解） */
function faces(lensFn, screenFn, u, f = F) {
  const a = lensFn(f, u);
  const s = solveLens({ f }, u, YO);
  const sc = screenFn({ solved: true, u: s.u, v: s.v, m: s.m, real: s.real, atFocus: s.atFocus, yO: YO }, D);
  return { a, s, sc };
}

// ══════════════════════════════════════════════════════════
head('① 起点戳（D36）：src/equipment/optics.js');
// ══════════════════════════════════════════════════════════
const START_SHA = sha(OPTICS), START_BYTES = bytes(OPTICS);
console.log(`  ${START_BYTES} B  ${START_SHA}`);

// ══════════════════════════════════════════════════════════
head('② 红测（D43/D47）：拦截源码、抹掉两处守卫，证明断言真的会红');
// ══════════════════════════════════════════════════════════
if (MUTATE) {
  const src0 = readFileSync(OPTICS, 'utf8');
  const GUARD_REAL = 'real: u > 0 && v > 0 && isFinite(v),';
  const GUARD_INV = 'inverted: isFinite(m) && m < 0,';
  const OLD_REAL = 'real: v > 0 && isFinite(v),';
  const OLD_INV = 'inverted: m < 0,';
  ok(src0.includes(GUARD_REAL) && src0.includes(GUARD_INV),
    `拦截目标存在：源码里两处守卫各 1 处（real 的 u > 0 守卫、inverted 的 isFinite(m) 守卫）`);
  let src1 = src0.split(GUARD_REAL).join(OLD_REAL).split(GUARD_INV).join(OLD_INV);
  ok(src1 !== src0 && !src1.includes(GUARD_REAL) && !src1.includes(GUARD_INV),
    `D47 拦截生效证据：源码长度 ${src0.length} → ${src1.length}，两处守卫已不在变体里`);
  // 相对 import 改绝对（临时文件不在仓库里，相对路径解析不到）
  src1 = src1.replace(/from '(\.[^']+)'/g, (_m, rel) => `from '${pathToFileURL(join(REPO, 'src', 'equipment', rel)).href}'`);
  const tmp = join(process.env.TEMP || process.env.TMP || '.', `optics-mutant-${process.pid}.mjs`);
  writeFileSync(tmp, src1, 'utf8');
  const M = await import(pathToFileURL(tmp).href);
  console.log('  ── 变体里的那两行（拦截后）──');
  for (const ln of src1.split('\n')) if (ln.includes(OLD_REAL) || ln.includes(OLD_INV)) console.log('    ' + ln.trim());
  const mNeg = M.thinLens(F, -10), mAtF = M.thinLens(F, F);
  ok(mNeg.real === true && mNeg.inverted === false && mAtF.inverted === true,
    `D47 变体确实回到旧取值：thinLens(5,−10).real=${mNeg.real}、thinLens(5,5).inverted=${mAtF.inverted}（修好前就是这个值）`);
  console.log('  ── 变体下重跑对表：**同一条常态断言**，此时必须 ✗ ──');
  const bad = [];
  for (const u of U_LIST) {
    const { a, sc } = faces(M.thinLens, M.screenReading, u);
    const same = a.real === sc.real && a.inverted === sc.inverted;
    if (!same) bad.push(`u=${u}`);
    console.log(`    u=${String(u).padEnd(7)} 代数 real=${String(a.real).padEnd(5)} inverted=${String(a.inverted).padEnd(5)}`
      + ` 屏 real=${String(sc.real).padEnd(5)} inverted=${String(sc.inverted).padEnd(5)}  一致性 ${same ? '✓' : '\x1b[31m✗\x1b[0m'}`);
  }
  // 与常态**逐字同一条**断言（绿形），守卫被抹掉后它必须红 ⇒ 这就是红色能力
  ok(bad.length === 0, `10 个 u 上 real / inverted 全格一致${bad.length ? '（不一致：' + bad.join('、') + '）' : ''}`);
  try { unlinkSync(tmp); } catch { /* 临时文件清理失败不影响结论 */ }
  console.log(`  仓库零字节改动：optics.js ${bytes(OPTICS)} B ${sha(OPTICS)}`);
  console.log('\n' + (fail ? `\x1b[31m合计 ${pass + fail} 项，失败 ${fail} 项（红测：以上 ✗ 是预期）\x1b[0m` : `合计 ${pass + fail} 项，全部通过`));
  process.exit(fail ? 1 : 0);
}

// ══════════════════════════════════════════════════════════
head('③ 对表：代数面 ⟷ 光屏面 逐格一致（含「一致性」列）');
// ══════════════════════════════════════════════════════════
{
  console.log('        u       代数 real  代数 inverted   屏 real  屏 inverted   一致性');
  let mismatch = [];
  for (const u of U_LIST) {
    const { a, sc } = faces(thinLens, screenReading, u);
    const same = a.real === sc.real && a.inverted === sc.inverted;
    if (!same) mismatch.push(`u=${u}`);
    console.log(`    ${String(u).padEnd(7)} ${String(a.real).padEnd(10)} ${String(a.inverted).padEnd(14)}`
      + ` ${String(sc.real).padEnd(8)} ${String(sc.inverted).padEnd(11)} ${same ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'}`);
  }
  ok(mismatch.length === 0, `10 个 u 上 real / inverted 全格一致${mismatch.length ? '（不一致：' + mismatch.join('、') + '）' : ''}`);
  // 三档逐条钉住（不是「恰好都对」，是语义正确）
  const neg = thinLens(F, -10), zero = thinLens(F, 0), atF = thinLens(F, F);
  ok(neg.real === false && neg.inverted === false && neg.v > 0,
    `u < 0：v=${f3(neg.v)} > 0 但 real=false（发光面越过透镜 ⇒ 不成像，不是「正立实像」）`);
  ok(zero.v === 0 && zero.real === false && zero.inverted === false && Number.isNaN(zero.m),
    `u = 0：v=${f3(zero.v)}、m=NaN ⇒ real=false 且 inverted 不再靠 NaN 兜出「正立」`);
  ok(!Number.isFinite(atF.v) && atF.real === false && atF.inverted === false,
    `u = f：v=${String(atF.v)}、m=${String(atF.m)} ⇒ inverted=false（isFinite 守卫，不再给「倒立」）`);
  // 正控（D37）：不是「永远 false」——两档成像档必须各自为真
  const real1 = thinLens(F, 10), virt = thinLens(F, 2);
  ok(real1.real === true && real1.inverted === true,
    `正控·实像档 u=10 > f：real=${real1.real}、inverted=${real1.inverted}（v=${f3(real1.v)}、m=${f3(real1.m)}）`);
  ok(virt.real === false && virt.inverted === false && virt.v < 0 && virt.m > 0,
    `正控·虚像档 u=2 < f：real=${virt.real}、inverted=${virt.inverted}（v=${f3(virt.v)} < 0、m=${f3(virt.m)} > 0，与物同侧）`);
}

// ══════════════════════════════════════════════════════════
head('④ 画布文案实测：真场景 → 真 render() → 抓 gfx.text');
// ══════════════════════════════════════════════════════════
const bootApp = {
  services: {}, ticks: [], world: null, selected: null,
  log: { push() {}, clear() {} }, toast() {},
  addTick(fn) { this.ticks.push(fn); return () => {}; },
};
const host = new PluginHost(bootApp);
for (const p of [physicsPlugin, chemistryPlugin, bridgePlugin, ...equipmentPlugins, optics]) host.define(p);
host.installAll();
bindRegistry(host.registry('equipment'));

/** 记录型 2D 上下文替身：只抓 draw 调用，不画 */
function recCtx() {
  const log = { texts: [], strokes: [] };
  const ctx = new Proxy({}, {
    get(_t, k) {
      if (k === 'fillText' || k === 'strokeText') return (s) => log.texts.push(String(s));
      if (k === 'createLinearGradient' || k === 'createRadialGradient') return () => ({ addColorStop() {} });
      if (k === 'canvas') return { width: 800, height: 600 };
      if (k === 'measureText') return () => ({ width: 10 });
      return () => {};
    },
    set() { return true; },
  });
  return { ctx, log };
}
/** 光源(物高 6mm) + 凸透镜 + 光屏：摆放与 equipment-optics.mjs 的 scene() 同口径 */
function scene(u, f) {
  const world = new World();
  const src = create('lightsource', 40, 300);
  src.setProp('size', 6);
  const lens = create('convexlens', 40 + u + 48, 300);   // +48 = 光源发光面到透镜圆心
  lens.setProp('f', f);
  const scr = create('screen', 0, 300);
  world.add(src, true); world.add(lens, true); world.add(scr, true);
  world.step(1 / 120);
  scr.x = lens.x + 60;
  world.step(1 / 120);
  return { world, src, lens, scr, uReal: lens.state.u };
}
{
  const CASES = [
    { name: 'u > f（实像）', u: 200, f: 50, wantU: 200, want: '实像', ban: ['不成像', '虚像'] },
    { name: '0 < u < f（虚像）', u: 20, f: 50, wantU: 20, want: '虚像', ban: ['不成像', '实像'] },
    { name: 'u = f（出射平行光）', u: 50, f: 50, wantU: 50, want: 'u=f', ban: ['实像', '虚像'], noImage: true },
    { name: 'u < 0（发光面越过透镜）', negU: true, f: 50, wantU: -28, want: '越过', ban: ['实像', '虚像', '贴在镜面上'], noImage: true, sameText: true },
    { name: 'u = 0（物贴在透镜面上）', zeroU: true, f: 50, wantU: 0, want: '贴在透镜面上', ban: ['实像', '虚像', '越过'], noImage: true, sameText: true },
  ];
  for (const c of CASES) {
    const S = scene(c.negU ? 100 : c.u, c.f);
    if (c.negU) S.lens.x = S.src.x + 20;      // 光源中心仍在左，但发光面已越过透镜 ⇒ u = 20 − 48 = −28
    if (c.zeroU) S.lens.x = S.src.x + 48;     // 发光面恰在透镜上 ⇒ u = 0
    S.scr.x = S.lens.x + 60;
    S.world.step(1 / 120);
    const L = S.lens.state, P = S.scr.state;
    const R = recCtx();
    S.lens.render(R.ctx);
    const text = R.log.texts.join(' ｜ ');
    const has = (s) => R.log.texts.some(t => t.includes(s));
    console.log(`  · ${c.name}：u=${S.lens.state.u.toFixed(1)}mm  画布「${text}」`);
    console.log(`      光屏：onScreen=${P.onScreen}、real=${P.real}、reason=「${P.reason}」`);
    ok(Math.abs(L.u - c.wantU) < 1e-9,
      `    ${c.name}：场景就位（实测 u=${L.u.toFixed(1)}mm，目标 ${c.wantU}）`);
    ok(has(c.want), `    ${c.name}：画布给出「${c.want}」⇒「${R.log.texts.find(t => t.includes(c.want)) || '（没有）'}」`);
    ok(c.ban.every(b => !has(b)), `    ${c.name}：画布**不出现**「${c.ban.join('」「')}」`);
    // 同一帧两侧同判（两条都只断言**同一件事**，避免把「虚像」也算成「不成像」）
    const canvasReal = has('实像');
    ok(canvasReal === (P.real === true),
      `    同帧同判：画布说实像=${canvasReal} ⟷ 光屏 real=${P.real}`);
    ok(has('不成像') === !!c.noImage,
      `    同帧同判：画布说「不成像」=${has('不成像')} ⟷ 本档不成像=${!!c.noImage}（u ≤ 0 与 u = f 才成立；u < f 是虚像，不是「不成像」）`);
    // 逐字同一句：u ≤ 0 两档的画布文案与光屏 reason **必须一模一样**（防两处漂移的闸）
    if (c.sameText) {
      ok(R.log.texts.includes(P.reason),
        `    逐字同一句：画布文案里有「${P.reason}」= ${R.log.texts.includes(P.reason)}（与光屏 reason 完全同字）`);
    }
  }
}

// ══════════════════════════════════════════════════════════
head('⑤ 尾戳（D36）+ 命令（D40）');
// ══════════════════════════════════════════════════════════
const END_SHA = sha(OPTICS), END_BYTES = bytes(OPTICS);
console.log(`  src/equipment/optics.js  ${START_BYTES} B ${START_SHA}`);
console.log(`  src/equipment/optics.js  ${END_BYTES} B ${END_SHA}`);
ok(START_SHA === END_SHA && START_BYTES === END_BYTES,
  `探针自身零写入：首尾同 sha（${END_SHA.slice(0, 8)}）`);
console.log('  命令：node tools/optics-lens-sign-probe.mjs');
console.log('  命令：node tools/optics-lens-sign-probe.mjs --mutate');
console.log('  命令：node tools/equipment-optics.mjs');

console.log('\n' + (fail ? `\x1b[31m合计 ${pass + fail} 项，失败 ${fail} 项\x1b[0m` : `合计 ${pass + fail} 项，全部通过`));
process.exit(fail ? 1 : 0);
