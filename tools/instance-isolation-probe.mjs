// ══════════════════════════════════════════════════════════
// 实例隔离判据 —— 「def.state 里的数组/对象不得被多个实例共享」
//
//   node tools/instance-isolation-probe.mjs                 判据本体（exit 0 = 绿）
//   node tools/instance-isolation-probe.mjs --self-check    变异自证：把 entity.js
//                                                           改回浅拷贝，断言判据转红
//
// 为什么要有这条判据：
//   src/core/entity.js 里 `this.state = Object.assign({}, def.state)` 是**浅拷贝**，
//   凡在 def.state 里写 `buf: []` 的器材，所有实例共用同一个数组 —— 摆两台示波器，
//   波形会合进同一个缓冲区。修正是全局性的一行，所以判据也必须是全局的：
//   遍历**全部已注册器材**，而不是点名的那几件，否则将来新增器材会重新踩。
//
// 断言：
//   ① 同一类型造 2 个实例，两边 state 可达的数组/纯对象**不得**有同一个引用（任意深度）；
//   ② 实例 state 的引用不得与 def.state 的引用同一 —— 这是根因，单独判一次；
//   ③ 场景级：两台示波器 / 两台交流电源，往 A 推一个哨兵后 B 的缓冲区长度不变；
//   ④ 器材包派生件（registry.derive）同样隔离 —— 源码里它是 `{...base.state}` 展开。
//
// 关于 --self-check：判据只能在 %TEMP% 的变异副本上跑，仓库零字节副作用。
//   副本 = 整棵 src/ 逐字节复制 + 把相对 specifier 重写成绝对 file:///，
//   副本的每个文件都能**反解**回原字节（逐字节相等），所以「红」只可能来自那一处变异。
// ══════════════════════════════════════════════════════════

import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

const PROBE = fileURLToPath(import.meta.url);
const REPO = path.resolve(path.dirname(PROBE), '..');
const argOf = (n) => {
  const a = process.argv.find((x) => x.startsWith('--' + n + '='));
  return a ? a.slice(n.length + 3) : null;
};
const ROOT = path.resolve(argOf('root') || REPO);
const SELF_CHECK = process.argv.includes('--self-check');
const MARK = '__ISOLATION_REPORT__ ';
const U = (p) => pathToFileURL(path.join(ROOT, p)).href;
const sha = (b) => createHash('sha256').update(b).digest('hex');

/** 判据锚点：entity.js 里那一行修正。自证时会把它变异回浅拷贝 */
const ANCHOR = 'this.state = cloneState(def.state);';
const SHALLOW = 'this.state = Object.assign({}, def.state);';
/** Lead 已独立证明中招的 5 件（见 docs/任务清单.md §15.3）；变异副本的红档必须覆盖它们 */
const EXPECTED = ['resistorcap', 'inductorcoil', 'acsource', 'oscilloscope', 'diode'];

// ─────────────────────────────────────────────────────────
// 深度引用图
// ─────────────────────────────────────────────────────────
/**
 * 把 v 可达的**对象**（数组与纯对象递归进；非纯对象只记自身）收进 Map<对象, 路径>。
 * 用 seen 挡环；同一个对象取第一次到达的路径。
 */
function refMap(v, out = new Map(), seen = new Set(), p = '$') {
  if (v === null || typeof v !== 'object') return out;
  if (seen.has(v)) return out;
  seen.add(v);
  out.set(v, p);
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) refMap(v[i], out, seen, `${p}[${i}]`);
    return out;
  }
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) return out;   // 类实例/Date/Map… 只比自身
  for (const k of Object.keys(v)) refMap(v[k], out, seen, `${p}.${k}`);
  return out;
}

/** 按 refMap 产出的路径取值：`$.a.b[0]` → root.a.b[0] */
function getPath(root, p) {
  if (p === '$') return root;
  const keys = [];
  for (const seg of p.slice(2).split('.')) {
    const m = seg.match(/^([A-Za-z_$][\w$]*)((?:\[\d+\])*)$/);
    if (!m) return undefined;
    keys.push(m[1]);
    for (const i of m[2].match(/\d+/g) || []) keys.push(Number(i));
  }
  let v = root;
  for (const k of keys) { if (v == null) return undefined; v = v[k]; }
  return v;
}

/**
 * 串台可观察性：往 A 的共享引用里写一个哨兵，看 B 是否**跟着变**；随后还原。
 * 数组用 push（比长度），纯对象用临时键（比 hasOwnProperty）——
 * 两类都要能自证：共享的对象哪怕只是被就地改一个字段，也已经串台了。
 */
function observability(stateA, stateB, shared) {
  for (const s of shared) {
    const va = getPath(stateA, s.a), vb = getPath(stateB, s.b);
    if (!va || !vb || typeof va !== 'object') continue;
    if (Array.isArray(va) && Array.isArray(vb)) {
      const n0 = vb.length;
      va.push('SENTINEL');
      const grew = vb.length > n0;
      if (grew) vb.pop(); else va.pop();
      if (grew) return { path: s.a, how: 'array.push' };
    } else if (!Array.isArray(va) && Object.getPrototypeOf(va) === Object.prototype) {
      va.__iso__ = 'SENTINEL';
      const seen = Object.prototype.hasOwnProperty.call(vb, '__iso__');
      if (seen) delete vb.__iso__; else delete va.__iso__;
      if (seen) return { path: s.a, how: 'object.key' };
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────
// 无头宿主：与 tools/check.mjs 同一套引导（不含界面插件，Node 里也安全）
// ─────────────────────────────────────────────────────────
async function boot() {
  const { World } = await import(U('src/core/world.js'));
  const { PluginHost } = await import(U('src/core/plugin.js'));
  const { create, bindRegistry, derive } = await import(U('src/equipment/registry.js'));
  const { equipmentPlugins } = await import(U('src/equipment/index.js'));
  const pick = async (p) => (await import(U(p))).default;
  const app = {
    services: {}, ticks: [], world: null, lastCircuit: null, selected: null,
    log: { push() {}, clear() {} }, toast() {},
    addTick(fn) { this.ticks.push(fn); return () => {}; },
  };
  const host = new PluginHost(app);
  for (const p of [
    await pick('src/physics/circuit.js'),
    await pick('src/chemistry/reactions.js'),
    await pick('src/coupling/bridge.js'),
    await pick('src/plugins/theme.mint.js'),
    await pick('src/plugins/theme.graphite.js'),
    ...equipmentPlugins,
    await pick('src/plugins/rules.damage.js'),
    await pick('src/plugins/system.credit.js'),
  ]) host.define(p);
  host.installAll();
  bindRegistry(host.registry('equipment'));
  return { World, create, derive, reg: host.registry('equipment') };
}

// ─────────────────────────────────────────────────────────
// 判据本体
// ─────────────────────────────────────────────────────────
async function judge() {
  const { World, create, derive, reg } = await boot();
  const defs = reg.list();
  const types = defs.map((d) => d.type);

  // ① + ② 逐件：两实例的 state 引用图不得相交，且不得与 def.state 相交
  const pairwise = [];
  let checked = 0;
  for (const t of types) {
    let a, b;
    try { a = create(t, 0, 0); b = create(t, 400, 0); } catch { continue; }
    if (!a || !b) continue;
    checked++;
    const ra = refMap(a.state), rb = refMap(b.state);
    const def = reg.get(t);
    const rd = refMap(def && def.state);
    const shared = [];
    for (const [o, pa] of ra) if (rb.has(o)) shared.push({ a: pa, b: rb.get(o) });
    const sharesDef = [];
    for (const [o, pa] of ra) if (rd.has(o)) sharesDef.push(pa);
    if (!shared.length && !sharesDef.length) continue;
    // 串台可观察性：往 A 的共享引用里写哨兵，看 B 是否跟着变
    const observable = observability(a.state, b.state, shared);
    pairwise.push({ type: t, shared, sharesDef, observable });
  }

  // ③ 场景级：两台示波器（用户可见后果原样复现）
  const scenarios = [];
  {
    const world = new World();
    const src = create('acsource', 0, 0);
    const A = create('oscilloscope', 60, 0);
    const B = create('oscilloscope', 90, 0);
    for (const e of [src, A, B]) world.add(e, true);
    for (let i = 0; i < 240; i++) world.step(1 / 120);
    const identityShared = Object.is(A.state.buf, B.state.buf);
    const aBefore = A.state.buf.length, bBefore = B.state.buf.length;
    A.state.buf.push('SENTINEL');
    const bAfter = B.state.buf.length, aAfter = A.state.buf.length;
    scenarios.push({
      name: '两台示波器 + 一台交流电源', identityShared,
      aBefore, bBefore, aAfter, bAfter,
      ok: !identityShared && bAfter === bBefore && aAfter === aBefore + 1,
    });
  }
  {
    const world = new World();
    const A = create('acsource', 0, 0), B = create('acsource', 200, 0);
    for (const e of [A, B]) world.add(e, true);
    for (let i = 0; i < 120; i++) world.step(1 / 120);
    const keys = ['buf', 'bufT', 'ibuf', 'ibufT'];
    const sharedKeys = keys.filter((k) => Object.is(A.state[k], B.state[k]));
    const aBefore = A.state.buf.length, bBefore = B.state.buf.length;
    A.state.buf.push('SENTINEL');
    const bAfter = B.state.buf.length;
    scenarios.push({
      name: '两台交流电源', identityShared: sharedKeys.length > 0, sharedKeys,
      aBefore, aAfter: aBefore + 1, bBefore, bAfter,
      ok: sharedKeys.length === 0 && bAfter === bBefore,
    });
  }

  // ④ 器材包派生件：derive() 里是 `state: {...base.state, ...}`，同样是浅展开
  let derived = null;
  {
    const PACK = { id: '__iso_probe_pack__', name: '隔离判据探针' };
    const made = [];
    for (const [proto, type] of [['oscilloscope', '__iso_derived_scope'], ['resistorcap', '__iso_derived_cap']]) {
      if (!reg.get(proto) || reg.get(type)) continue;
      try { derive({ proto, type, name: '派生的' + proto }, PACK); made.push({ proto, type }); } catch { /* 原型不在就算了 */ }
    }
    const bad = [];
    for (const { proto, type } of made) {
      const a = create(type, 0, 0), b = create(type, 300, 0);
      if (!a || !b) continue;
      const ra = refMap(a.state), rb = refMap(b.state);
      const shared = [];
      for (const [o, pa] of ra) if (rb.has(o)) shared.push(pa);
      if (shared.length) bad.push({ proto, type, shared });
    }
    derived = { made: made.map((m) => m.type), bad, ok: bad.length === 0 };
  }

  const ok = pairwise.length === 0 && scenarios.every((s) => s.ok) && (!derived || derived.ok);
  return {
    mode: 'judge', root: ROOT,
    equipmentCount: types.length, checkedCount: checked,
    sharedTypes: pairwise.map((p) => p.type),
    pairwise, scenarios, derived, ok,
  };
}

// ─────────────────────────────────────────────────────────
// --self-check：在 %TEMP% 里把 entity.js 变异回浅拷贝，判据必须转红
// ─────────────────────────────────────────────────────────
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
const countOf = (s, sub) => s.split(sub).length - 1;
const lineOf = (s, sub) => s.split('\n').findIndex((l) => l.includes(sub)) + 1;

/**
 * 相对 specifier → 绝对 file:///，**相对目标文件所在目录解析**（不是源目录！）。
 * 解析成源目录会让副本反过来 import 仓库里的模块（双份模块图），
 * 变异副本就不再是「只有 entity.js 不同」的副本了 —— 见 copy.specifiersInsideCopy 断言。
 */
function rewriteSpecifiers(text, baseDir) {
  const edits = [];
  const out = text.replace(/(\bfrom\s*|\bimport\s*)(['"])(\.{1,2}\/[^'"\n]+)\2/g, (m, kw, q, spec) => {
    const url = pathToFileURL(path.resolve(baseDir, spec)).href;
    edits.push({ spec, url });
    return kw + q + url + q;
  });
  return { out, edits };
}
const unrewrite = (text, edits) => edits.reduce((t, e) => t.split(e.url).join(e.spec), text);

function walkJs(dir, rel = '', out = []) {
  for (const name of readdirSync(path.join(dir, rel))) {
    const r = rel ? rel + '/' + name : name;
    const st = statSync(path.join(dir, r));
    if (st.isDirectory()) walkJs(dir, r, out);
    else if (name.endsWith('.js')) out.push(r);
  }
  return out;
}
const hashTree = (dir) => sha(Buffer.concat(walkJs(dir).sort().map((r) => readFileSync(path.join(dir, r)))));

async function selfCheck() {
  const srcRepo = path.join(REPO, 'src');
  const before = hashTree(srcRepo);
  const files = walkJs(srcRepo).sort();
  const tmp = path.join(os.tmpdir(), 'xiaomo-iso-' + process.pid + '-' + Date.now());
  const srcTmp = path.join(tmp, 'src');
  const report = { mode: 'self-check', root: ROOT, anchor: ANCHOR, expectedSuperset: EXPECTED };

  try {
    // ── 落副本：逐字节复制，只把相对 specifier 换成绝对 file:/// ──
    const editsByFile = new Map();
    let rewrites = 0;
    for (const r of files) {
      const abs = path.join(srcRepo, r), dst = path.join(srcTmp, r);
      mkdirSync(path.dirname(dst), { recursive: true });
      const orig = readFileSync(abs);
      const { out, edits } = rewriteSpecifiers(orig.toString('utf8'), path.dirname(dst));
      editsByFile.set(r, edits);
      rewrites += edits.length;
      writeFileSync(dst, edits.length ? Buffer.from(out, 'utf8') : orig);
    }
    report.copy = { files: files.length, specifierRewrites: rewrites };

    // 副本自证 A：重写后的绝对 URL 必须落在副本内 —— 落在仓库里会形成双份模块图
    const inside = pathToFileURL(srcTmp).href;
    const outside = [...editsByFile.values()].flat().filter((e) => !e.url.startsWith(inside));
    report.copy.specifiersInsideCopy = outside.length === 0;
    report.copy.specifiersOutsideCopy = outside.slice(0, 5);

    // 副本自证：每个文件反解 specifier 后必须与原字节**逐字节**相等
    const drifted = [];
    for (const r of files) {
      const rt = unrewrite(readFileSync(path.join(srcTmp, r)).toString('utf8'), editsByFile.get(r));
      if (Buffer.compare(Buffer.from(rt, 'utf8'), readFileSync(path.join(srcRepo, r))) !== 0) drifted.push(r);
    }
    report.copy.byteIdenticalModuloSpecifierRewrite = drifted.length === 0;
    report.copy.drifted = drifted;

    // ── 变异：锚点必须唯一（原文与剥注释后都只 1 次），且落在同一行 ──
    const entRel = 'core/entity.js';
    const entRepoPath = path.join(srcRepo, entRel), entTmpPath = path.join(srcTmp, entRel);
    const entText = readFileSync(entRepoPath).toString('utf8');
    report.anchor = {
      raw: countOf(entText, ANCHOR),
      stripped: countOf(stripComments(entText), ANCHOR),
      line: lineOf(entText, ANCHOR),
    };
    const bytesBefore = readFileSync(entTmpPath);
    const t0 = readFileSync(entTmpPath).toString('utf8');
    const t1 = t0.split(ANCHOR).join(SHALLOW);
    writeFileSync(entTmpPath, Buffer.from(t1, 'utf8'));
    const bytesAfter = readFileSync(entTmpPath);
    report.mutant = {
      sha256Before: sha(bytesBefore), sha256After: sha(bytesAfter),
      bytesBefore: bytesBefore.length, bytesAfter: bytesAfter.length,
      changed: Buffer.compare(bytesBefore, bytesAfter) !== 0,
      shallowLine: lineOf(t1, SHALLOW),
      landedOnAnchorLine: lineOf(t1, SHALLOW) === report.anchor.line,
      /** 反解 specifier 后必须正好等于「原文 + 这一处替换」 */
      exactlyOneSubstitution: unrewrite(t1, editsByFile.get(entRel)) === entText.split(ANCHOR).join(SHALLOW),
    };

    // ── 在变异副本上跑判据：必须红，且红档必须覆盖那 5 件 ──
    let out = '', code = 0;
    try {
      out = execFileSync(process.execPath, [PROBE, '--root=' + tmp], { encoding: 'utf8' });
    } catch (e) {
      out = (e.stdout || '') + (e.stderr || '');
      code = typeof e.status === 'number' ? e.status : -1;
    }
    const line = out.split(/\r?\n/).find((l) => l.startsWith(MARK));
    const sub = line ? JSON.parse(line.slice(MARK.length)) : null;
    report.mutantExit = code;
    report.mutantOutput = out.length > 3000 ? '…' + out.slice(-3000) : out;
    report.mutantSharedTypes = sub ? sub.sharedTypes : null;
    report.mutantPairwise = sub ? sub.pairwise : null;
    report.mutantScenarios = sub ? sub.scenarios : null;
    const found = new Set(sub ? sub.sharedTypes : []);
    report.missingExpected = EXPECTED.filter((t) => !found.has(t));
    report.mutantRed = code !== 0 && !!sub && sub.ok === false && report.missingExpected.length === 0;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  const after = hashTree(srcRepo);
  report.repoHashBefore = before;
  report.repoHashAfter = after;
  report.repoSideEffectFree = before === after;
  report.landed = report.anchor.raw === 1 && report.anchor.stripped === 1
    && report.mutant.changed && report.mutant.landedOnAnchorLine && report.mutant.exactlyOneSubstitution
    && report.copy.byteIdenticalModuloSpecifierRewrite && report.copy.specifiersInsideCopy;
  report.ok = report.landed && report.mutantRed && report.repoSideEffectFree;
  return report;
}

// ─────────────────────────────────────────────────────────
const report = SELF_CHECK ? await selfCheck() : await judge();
const show = (r) => {
  if (r.mode === 'judge') {
    console.log(`\n\x1b[36m实例隔离判据\x1b[0m  root=${r.root}  已注册器材 ${r.equipmentCount} 件（逐件检查 ${r.checkedCount}）\n`);
    if (r.pairwise.length) {
      for (const p of r.pairwise) {
        console.log(`  \x1b[31m✗\x1b[0m ${String(p.type).padEnd(16)} 共享 ${JSON.stringify(p.shared.map((s) => s.a))}` +
          `  与 def.state 同一 ${JSON.stringify(p.sharesDef)}${p.observable ? '  ← 串台可观察' : ''}`);
      }
    } else {
      console.log('  \x1b[32m✓\x1b[0m 全部器材：两实例的 state 引用图互不相交，且与 def.state 无同一引用');
    }
    for (const s of r.scenarios) {
      console.log(`  ${s.ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${s.name}  Object.is(A,B)=${s.identityShared}` +
        `  A ${s.aBefore}→${s.aAfter}  B ${s.bBefore}→${s.bAfter}${s.sharedKeys ? '  共享键 ' + JSON.stringify(s.sharedKeys) : ''}`);
    }
    if (r.derived) console.log(`  ${r.derived.ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} 器材包派生件 ${JSON.stringify(r.derived.made)}${r.derived.bad.length ? ' 共享 ' + JSON.stringify(r.derived.bad) : ' 隔离'}`);
    console.log(`\n${r.ok ? '\x1b[32m绿：全部实例隔离\x1b[0m' : '\x1b[31m红：存在跨实例共享\x1b[0m'}\n`);
  } else {
    console.log(`\n\x1b[36m变异自证\x1b[0m  锚点原文 ${r.anchor.raw} 次 / 剥注释 ${r.anchor.stripped} 次，行 ${r.anchor.line}`);
    console.log(`  副本 ${r.copy.files} 文件，重写 specifier ${r.copy.specifierRewrites} 处，反解逐字节相等=${r.copy.byteIdenticalModuloSpecifierRewrite}`);
    console.log(`  变异 entity.js ${r.mutant.bytesBefore}→${r.mutant.bytesAfter} B，落点同行=${r.mutant.landedOnAnchorLine}，仅此一处替换=${r.mutant.exactlyOneSubstitution}`);
    console.log(`  变异副本 exit=${r.mutantExit}，红档共享器材 ${JSON.stringify(r.mutantSharedTypes)}`);
    console.log(`  缺 Expected ${JSON.stringify(r.missingExpected)}；仓库零副作用=${r.repoSideEffectFree}`);
    if (!r.ok) console.log(`\x1b[31m变异副本原始输出（尾 3000 字符）\x1b[0m\n${r.mutantOutput}`);
    console.log(`\n${r.ok ? '\x1b[32m自证通过：判据可被变异打红，且落点唯一\x1b[0m' : '\x1b[31m自证失败\x1b[0m'}\n`);
  }
};
show(report);
console.log(MARK + JSON.stringify(report));
process.exitCode = report.ok ? 0 : 1;
