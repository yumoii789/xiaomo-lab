// ══════════════════════════════════════════════════════════
// 无头验收：「电磁」域标签表（src/ui/inspector.js）—— 键闭环 + 无读数边界
//
//   node tools/inspector-electromagnets-probe.mjs          # 全过 exit 0，有失败 exit 1，跑不起来 exit 2
//   node tools/inspector-electromagnets-probe.mjs --mutate # 红测：删掉表里一项，闭环必须变红
//
// ⚠ 开关只认 `--mutate`：任何别的开关都 **exit=2 明确报错**（不认识的开关 + exit=0 = 空转的绿 ✗）。
// ⚠ 源码判据与变异提取的输入一律先剥注释（`stripComments`，在**读取处统一剥**）：注释里的字样不算
//   「代码里有」—— 否则一条注释就能让锚点计数变成 2（假拦截），或让提取器改到注释上（假生效）。
//
// 为什么要有它：这张表是**共享文件上的一次写入**。若断言只写「面板标签 == 我手写的期望值」，
// 那就是自己证自己（表里写错字也会全绿）。所以判据拆成**两个互不依赖的来源**：
//   来源 A（查表）：键集与单位从**器材自己的声明**推出来 —— def.state 给键、def.fields 给单位；
//                   两个方向都查（器材→表：每个数字键都得有标签；表→器材：表里不许有到不了的键）。
//   来源 B（查渲染）：跑**应用自己的 Inspector.updateLive()**（DOM 替身照
//                   tools/inspector-stats-probe.mjs:41-58/194-204，只借替身，不借它的判据），
//                   断言面板真的贴出了表里的那个标签、值真的拼上了那个单位。
// 表改了而渲染没跟上 → 红；渲染没走这张表（落到通用表或原始键名）→ 也红。
//
// 负向判据：匀强磁场这类「state 里没有数字」的器材必须老实显示「状态 · 无读数」，
// 不得因为加了表就冒出假行；表里也不许出现到不了兜底口径的键（inspector.js:373 只收有限数字，
// 对象/布尔/文案型的 axis、poleN、poleS、dir、force、symbol 等一律到不了 ⇒ 写进表就是死条目）。
//
// 口径出处：D44（只给方向不给大小）—— 检验电荷的标签就是「受力方向」，没有大小项；
// 电磁器材本体与叠加约定见 src/equipment/electromagnets.js 文件头。
// ══════════════════════════════════════════════════════════

import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { World } from '../src/core/world.js';
import { PluginHost } from '../src/core/plugin.js';
import { create, list, bindRegistry, equipmentPlugins } from '../src/equipment/index.js';
import { CouplingBus } from '../src/coupling/bridge.js';

// ── 未知开关 ⇒ 明确报错退出（不许静默忽略）──
// 理由：不认识的开关 + exit=0 与「我验了」长得一模一样 ⇒ 空转的绿最难被发现（形状照 tools/lamp-thermal-probe.mjs:47-52）。
const known = new Set(['--mutate']);
const bad = process.argv.slice(2).filter((a) => !known.has(a));
if (bad.length) { console.log(`✗ 不认识的开关：${bad.join(' ')} —— 本探针只认 ${[...known].join(' / ')}`); process.exit(2); }

const MUTATE = process.argv.includes('--mutate');
const REPO = new URL('../', import.meta.url);
const CAT = '电磁';
const EM_TYPES = ['barmagnet', 'compass', 'charge', 'testcharge', 'efield', 'bfield'];
/** 无量纲的键：带电符号就是 +1 / 0 / −1 本身。除它之外每个键都必须带单位。 */
const DIMENSIONLESS = new Set(['sign']);

let pass = 0, fail = 0;
const ok = (cond, msg) => { (cond ? pass++ : fail++); console.log((cond ? '  \x1b[32m✓\x1b[0m ' : '  \x1b[31m✗\x1b[0m ') + msg); return !!cond; };
const head = (t) => console.log('\n\x1b[36m' + t + '\x1b[0m');
const info = (t) => console.log('    · ' + t);
const sha = (p) => { const b = readFileSync(new URL(p, REPO)); return { sha256: createHash('sha256').update(b).digest('hex'), bytes: b.length }; };
/** 源码文本的两个读入口：`readCode` 的返回**已剥注释** —— 凡「源码里有没有 X」的判据与变异提取都必须用它。 */
const stripComments = (s) => s.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
const readRaw = (rel) => readFileSync(new URL(rel, REPO), 'utf8');
const readCode = (rel) => stripComments(readRaw(rel));

// ── DOM 替身（照 tools/inspector-stats-probe.mjs:41-58）────────────────
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

// 替身装好之后再 import（动态 import：不依赖「模块顶层不碰 DOM」这个假设）
const { Inspector, STATE_LABELS, LIVE_FALLBACK_MAX } = await import('../src/ui/inspector.js');

const bootApp = {
  services: {}, ticks: [], world: null, lastCircuit: null, selected: null,
  log: { push() {}, clear() {} }, toast() {}, addTick(fn) { this.ticks.push(fn); return () => {}; },
};
const host = new PluginHost(bootApp);
for (const p of equipmentPlugins) host.define(p);
host.installAll();
bindRegistry(host.registry('equipment'));
const appStub = { world: { get: () => null }, markDirty() {}, duplicate() {}, removeEntity() {} };
const LAB = STATE_LABELS[CAT] || {};

/** 照 tools/inspector-stats-probe.mjs:200-204 */
function readRows(el) {
  const rows = [];
  for (let i = 0; i + 1 < el.children.length; i += 2) rows.push([el.children[i].textContent, el.children[i + 1].textContent]);
  return rows;
}
/** 照 tools/inspector-stats-probe.mjs:194-199：跑应用自己的 updateLive()，读它铺出来的行 */
function renderRows(Cls, e) {
  const ins = new Cls(mkEl('div'), appStub);
  ins.ent = e; ins._live = mkEl('div');
  ins.updateLive();
  return readRows(ins._live);
}
function scene(objs, steps = 2) {
  const world = new World();
  new CouplingBus(world);
  const ents = [];
  for (const o of objs) {
    const e = create(o.type, o.x, o.y);
    if (o.props) for (const k of Object.keys(o.props)) e.setProp(k, o.props[k]);
    world.add(e, true);
    ents.push(e);
  }
  for (let i = 0; i < steps; i++) world.step(1 / 120);
  return { ents, byType: (t) => ents.find((x) => x.type === t) };
}
/** 兜底口径会收到的键 —— 与 inspector.js:372-373 同一条规则（下划线开头的内部键 + 非有限数字都不收） */
const numericKeysOf = (e) => Object.entries(e.state)
  .filter(([k, v]) => k.charCodeAt(0) !== 95 && typeof v === 'number' && Number.isFinite(v))
  .map(([k]) => k);

// 每件器材一个真实场景（compass / testcharge 需要世界里真的有场源才会出数）
const SCENES = [
  { type: 'barmagnet', objs: [{ type: 'barmagnet', x: 0, y: 0 }] },
  { type: 'compass', objs: [{ type: 'barmagnet', x: 0, y: 0 }, { type: 'compass', x: 300, y: 300 }] },
  { type: 'charge', objs: [{ type: 'charge', x: 0, y: 0, props: { q: 3 } }] },
  { type: 'testcharge', objs: [{ type: 'charge', x: 0, y: 0, props: { q: 3 } }, { type: 'testcharge', x: 200, y: 0, props: { q: 1 } }] },
  { type: 'efield', objs: [{ type: 'efield', x: 0, y: 0, props: { angle: 30 } }] },
  { type: 'bfield', objs: [{ type: 'bfield', x: 0, y: 0, props: { dir: 'out' } }] },
];
const CASES = SCENES.map(({ type, objs }) => {
  const S = scene(objs);
  const ent = S.byType(type);
  return { type, ent, keys: numericKeysOf(ent), fieldKeys: ((ent.def && ent.def.fields) || []).map((f) => f.k) };
});

/**
 * 单键闭环谓词。**绿测与红测跑的是同一份** —— 两套断言会漂移，一套谓词不会。
 * 判据：面板里必须有一行，其标签恰好等于表里的标签，且值把表里的单位拼上了。
 */
function checkKey(Cls, cs, k) {
  const entry = LAB[k];
  if (!entry) return { ok: false, why: `表里没有「${k}」这一项（本该有）` };
  const [label, unit] = entry;
  const rows = renderRows(Cls, cs.ent);
  const row = rows.find(([kk]) => kk === label) || rows.find(([kk]) => kk === k);
  if (!row) return { ok: false, why: `面板里既没有「${label}」也没有「${k}」这一行（实有：${rows.map((r) => r[0]).join(' / ')}）` };
  if (row[0] !== label) return { ok: false, why: `面板贴的是「${row[0]}」，而表里是「${label}」⇒ 渲染没走这张表` };
  if (!row[1]) return { ok: false, why: `「${label}」这一行的值是空的` };
  if (unit && !row[1].endsWith(unit)) return { ok: false, why: `「${label}」的值「${row[1]}」没拼上单位「${unit}」` };
  return { ok: true, why: `${label} = ${row[1]}` };
}

// ── 红测：删掉表里 needleDeg 那一项，闭环必须红（其余键作对照）────
if (MUTATE) {
  const MUT = {
    what: '删掉表里 needleDeg 那一项（指南针磁针指向）',
    find: "    needleDeg: ['磁针指向', '°'], srcCount: ['场源数', '个'],",
    replace: "    srcCount: ['场源数', '个'],",
  };
  const srcRaw = readRaw('src/ui/inspector.js');   // 变异基质：要写进 %TEMP% 的真代码
  const srcCode = stripComments(srcRaw);           // 提取器的输入：注释不是它的输入
  head(`桩 ${'needleDeg'}：${MUT.what}`);
  const hitsRaw = srcRaw.split(MUT.find).length - 1;
  const hits = srcCode.split(MUT.find).length - 1;
  console.log(`  锚点在正本里出现 ${hits} 次（剥注释后；原始文本 ${hitsRaw} 次）—— 必须 = 1，否则先怀疑提取器：D49`);
  ok(hitsRaw === hits,
    `锚点不在注释里：原始文本 ${hitsRaw} 次 ⟷ 剥注释后 ${hits} 次（注释里若也写了一份，这里就会不等 ⇒ 提取器可能改到注释上）`);
  if (hits !== 1) { console.log(`\n\x1b[31m红测无法进行：锚点出现 ${hits} 次（原始文本 ${hitsRaw} 次）\x1b[0m`); console.log('INSPECTOR_EM_JSON ' + JSON.stringify({ ok: false, why: 'anchor', hits, hitsRaw })); process.exit(1); }

  const dir = mkdtempSync(join(tmpdir(), 'xm-inspector-mut-'));
  const mutPath = join(dir, 'inspector.mut.mjs');
  const U = (p) => pathToFileURL(join(REPO.pathname.replace(/^\//, '').replace(/%20/g, ' '), p)).href;
  const mutSrc = srcRaw.replace(MUT.find, MUT.replace)
    .replace("'../physics/circuit.js'", JSON.stringify(U('src/physics/circuit.js')))
    .replace("'../chemistry/species.js'", JSON.stringify(U('src/chemistry/species.js')));
  const codeAfter = stripComments(mutSrc);
  ok(codeAfter.split(MUT.find).length - 1 === 0 && codeAfter.includes(MUT.replace),
    `桩落在**代码行**上：变体剥注释后旧行 0 处、新行在（不是把注释里的字样换掉了）`);
  writeFileSync(mutPath, mutSrc, 'utf8');
  console.log(`  变体文件：${mutPath}`);
  console.log('  被改的行（正本 → 变体）：');
  console.log('    - ' + MUT.find.trim());
  console.log('    + ' + MUT.replace.trim());
  console.log('  变体文件里该行的实际内容：');
  console.log('    | ' + mutSrc.split('\n').find((l) => l.includes("srcCount: ['场源数'"))?.trim());
  console.log(`  变体 import 改写：circuit.js / species.js 各 1 处（%TEMP% 里相对路径会解析错，必须改绝对 file://）`);

  const { Inspector: MutIns } = await import(pathToFileURL(mutPath).href);
  const red = [], ctrlBad = [];
  for (const cs of CASES) {
    for (const k of cs.keys) {
      if (!LAB[k]) continue;
      const r = checkKey(MutIns, cs, k);
      if (!r.ok) { (k === 'needleDeg' ? red : ctrlBad).push(`${cs.type}.${k}: ${r.why}`); }
    }
  }
  console.log(`  变体读数（未改动处对照）：barmagnet 的两行照常 → ${ctrlBad.length === 0 ? '其余全部键与正本一致 ✓' : '有 ' + ctrlBad.length + ' 键异常 ✗'}`);
  console.log(`  变体读数（被改处）：${red.length ? red[0] : '（没红！）'}`);
  const good = red.length === 1 && red[0].startsWith('compass.needleDeg') && ctrlBad.length === 0;
  ok(red.length === 1, `被删掉表项的那个键（needleDeg）恰好 1 条断言变红 ⇒ ${red.length === 1 ? '红' : '观测到 ' + red.length + ' 条'}`);
  ok(ctrlBad.length === 0, `对照：其余 12 个键在变体上全部照常 ⇒ 异常 ${ctrlBad.length} 条`);
  console.log(`\n${good ? '\x1b[32m红测通过：1/1 条断言按预期在变体上变红，对照异常 0 条\x1b[0m' : '\x1b[31m红测不成立\x1b[0m'}`);
  console.log('MUTATE_JSON ' + JSON.stringify({ expectedRed: 1, observedRed: red.length, ctrlBad: ctrlBad.length, ok: good }));
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows 偶尔占着 */ }
  process.exit(good ? 0 : 1);
}

// ══════════════════════════════════════════════════════════
console.log('\x1b[1m小墨实验室 · 「电磁」域标签表无头验证\x1b[0m');
console.log(`命令行：node tools/inspector-electromagnets-probe.mjs`);
const SHA0 = { inspector: sha('src/ui/inspector.js'), em: sha('src/equipment/electromagnets.js') };
console.log(`D36 起点：src/ui/inspector.js ${SHA0.inspector.bytes}B ${SHA0.inspector.sha256.slice(0, 16)}  |  src/equipment/electromagnets.js ${SHA0.em.bytes}B ${SHA0.em.sha256.slice(0, 16)}`);

head('⓪ 探针自身的纪律自检：源码判据的输入必须先剥注释');
{
  const RAW = readRaw('src/ui/inspector.js');                 // ← 红测真正读的那一份
  const CODE = readCode('src/ui/inspector.js');
  const MARK = 'XIAOMO_STRIP_SELFCHECK';
  const injected = `      // ${MARK}\n` + RAW;                 // 注释注进**真被读的文本**里，不是另造一个字符串
  ok(CODE !== RAW && CODE.length < RAW.length,
    `正控（非空转）：剥注释确实动过真源码文本 ${Buffer.byteLength(RAW)} → ${Buffer.byteLength(CODE)} B（它真有整行注释）`);
  ok(injected.includes(MARK) && !stripComments(injected).includes(MARK),
    `注入一条含标志词的注释 ⇒ 不过滤时看得见（${injected.includes(MARK)}），剥注释后它不在判据的输入里（${!stripComments(injected).includes(MARK)}）`);
}

head('① 装配 + 不可变式：这张表只可能影响这 6 件器材');
{
  const all = list();
  ok(all.length >= EM_TYPES.length, `注册表就绪：器材 ${all.length} 件（非空正控）`);
  const mine = all.filter((d) => d.cat === CAT).map((d) => d.type).sort();
  ok(mine.length === EM_TYPES.length && mine.join(',') === [...EM_TYPES].sort().join(','),
    `cat='${CAT}' 的器材恰好是这 6 件：${mine.join(', ')}（⇒ 表的作用面被钉死，既有器材的逐字行不可能被影响）`);
  ok(CASES.every((c) => c.ent), `6 件器材都能在场景里建出来（${CASES.filter((c) => c.ent).length}/6）`);
  const phases = {}; for (const r of host.list()) phases[r.phase] = (phases[r.phase] || 0) + 1;
  ok((phases.failed || 0) === 0, `装载零失败：${JSON.stringify(phases)}`);
}

head('② 来源 A（查表）：键集与单位从器材自己的声明推出来，两个方向都查');
{
  ok(Object.keys(LAB).length > 0, `STATE_LABELS['${CAT}'] 存在且非空：${Object.keys(LAB).length} 个键`);
  const numericAll = [...new Set(CASES.flatMap((c) => c.keys))];
  const fieldAll = [...new Set(CASES.flatMap((c) => c.keys.filter((k) => c.fieldKeys.includes(k))))];
  const tableKeys = Object.keys(LAB);
  const missTable = numericAll.filter((k) => !LAB[k]);
  ok(missTable.length === fieldAll.length && missTable.every((k) => fieldAll.includes(k)),
    `器材 → 表：${numericAll.length} 个数字键里没有标签的只有 ${missAll(missTable, fieldAll)}`
    + `（它们由器材自己的 fields 供标签，:377 优先于本表 —— 不是漏标签）`);
  const dead = tableKeys.filter((k) => !numericAll.includes(k));
  ok(dead.length === 0, `表 → 器材：${tableKeys.length} 个表项全部是某件器材真会产出的数字键（死条目 ${dead.length} 个${dead.length ? '：' + dead.join(',') : ''}）`);
  const badLabel = tableKeys.filter((k) => typeof LAB[k][0] !== 'string' || !LAB[k][0] || LAB[k][0] === k);
  ok(badLabel.length === 0, `13 个标签都非空且不等于原始键名（退化成键名的条目：${badLabel.length} 个${badLabel.length ? '：' + badLabel.join(',') : ''}）`);
  const badUnit = tableKeys.filter((k) => (DIMENSIONLESS.has(k) ? LAB[k][1] !== '' : !LAB[k][1]));
  ok(badUnit.length === 0, `单位：除 ${[...DIMENSIONLESS].join('/')}（无量纲）外每键都带单位（不合格 ${badUnit.length} 个）`);
  // 独立来源：|q| 的单位必须与器材自己给 q 声明的单位一致（不写死）
  const qf = CASES.find((c) => c.type === 'charge').ent.def.fields.find((f) => f.k === 'q');
  ok(LAB.qAbs && LAB.qAbs[1] === qf.unit, `|q| 的单位取自器材自己的 fields 声明：${LAB.qAbs && LAB.qAbs[1]} ⟷ ${qf.unit}（不写死）`);
  // 死条目边界：非数字键一个都不许进表
  const NONNUM = ['axis', 'poleN', 'poleS', 'dir', 'force', 'ambient', 'srcId', 'fieldDefined', 'inField', 'reason', 'symbol', 'outOfPage'];
  const polluted = NONNUM.filter((k) => LAB[k]);
  ok(polluted.length === 0, `非数字 state 键一个都没进表（${NONNUM.length} 个候选，污染 ${polluted.length} 个${polluted.length ? '：' + polluted.join(',') : ''}）—— 它们到不了 :373，进表就是死条目`);
}
function missAll(miss, fields) {
  return miss.length ? miss.map((k) => k + (fields.includes(k) ? '(fields 供标签)' : '(无出处!)')).join(', ') : '0 个';
}

head('③ 来源 B（查渲染）：跑应用自己的 updateLive()，逐键闭环「标签 + 单位 + 值」');
{
  for (const cs of CASES) {
    const rows = renderRows(Inspector, cs.ent);
    if (!cs.keys.length) {
      ok(rows.length === 1 && rows[0][0] === '状态' && rows[0][1] === '无读数',
        `${cs.type}：state 里没有数字 ⇒ 老实显示「状态 · 无读数」（实际 ${rows.length} 行：${rows.map((r) => r[0]).join('/')}）`);
      continue;
    }
    const covered = cs.keys.filter((k) => LAB[k]);
    const viaFields = cs.keys.filter((k) => !LAB[k]);
    const msgs = covered.map((k) => checkKey(Inspector, cs, k));
    ok(msgs.every((m) => m.ok), `${cs.type}：${covered.length} 个键闭环 —— ${msgs.map((m) => m.ok ? m.why : '✗' + m.why).join('；')}`);
    if (viaFields.length) {
      const fd = viaFields.map((k) => cs.ent.def.fields.find((f) => f.k === k));
      const good = viaFields.every((k, i) => {
        const row = rows.find(([kk]) => kk === fd[i].label);
        return row && (!fd[i].unit || row[1].endsWith(fd[i].unit));
      });
      ok(good, `${cs.type}：${viaFields.join(',')} 走器材自己的 fields（${fd.map((f) => f.label + ' /' + f.unit).join('、')}），本表不重复供标签`);
    }
  }
}

head('④ 负向：加了表不许冒出假行，也不许漏行');
{
  let fake = 0, drop = 0, lines = [];
  for (const cs of CASES) {
    const rows = renderRows(Inspector, cs.ent);
    const sentinel = rows.length === 1 && rows[0][0] === '状态' && rows[0][1] === '无读数';
    const want = Math.min(cs.keys.length, LIVE_FALLBACK_MAX) + (cs.keys.length > LIVE_FALLBACK_MAX ? 1 : 0);
    if (cs.keys.length === 0 ? !sentinel : sentinel) fake++;
    if (!sentinel && rows.length !== want) drop++;
    lines.push(`${cs.type} 键${cs.keys.length}/行${rows.length}`);
  }
  ok(fake === 0, `无读数哨兵只在「state 里确实没有数字」时出现（用错 ${fake} 件）`);
  ok(drop === 0, `每件器材的面板行数 == 它能产出的数字键数（多一行或少一行：${drop} 件）—— 逐件 ${lines.join('，')}`);
  const bf = CASES.find((c) => c.type === 'bfield');
  const bfRows = renderRows(Inspector, bf.ent);
  const bfKeys = Object.keys(bf.ent.state);
  ok(!bfRows.some(([k]) => bfKeys.includes(k)) && bfKeys.every((k) => !LAB[k]),
    `匀强磁场：两个 state 键（${bfKeys.join('、')}）既不在面板上、也不在表里（假的「有读数」和死条目都没发生）`);
}

const SHA1 = { inspector: sha('src/ui/inspector.js'), em: sha('src/equipment/electromagnets.js') };
head('⑤ 冻结口径（首尾各一次）');
ok(SHA0.inspector.sha256 === SHA1.inspector.sha256 && SHA0.em.sha256 === SHA1.em.sha256,
  `跑完前后源文件逐字节未变：inspector.js ${SHA1.inspector.bytes}B ${SHA1.inspector.sha256.slice(0, 16)}  |  electromagnets.js ${SHA1.em.bytes}B ${SHA1.em.sha256.slice(0, 16)}`);

console.log('\n' + '─'.repeat(56));
console.log(`\x1b[1m全部通过：${pass} 项\x1b[0m` + (fail ? `  \x1b[31m失败 ${fail} 项\x1b[0m` : ''));
console.log(`INSPECTOR_EM_JSON ${JSON.stringify({ ok: fail === 0, pass, fail, cat: CAT, tableKeys: Object.keys(LAB), files: [{ file: 'src/ui/inspector.js', ...SHA1.inspector }] })}`);
console.log(`D36 终点：src/ui/inspector.js ${SHA1.inspector.bytes}B ${SHA1.inspector.sha256.slice(0, 16)}  |  src/equipment/electromagnets.js ${SHA1.em.bytes}B ${SHA1.em.sha256.slice(0, 16)}`);
console.log(`D40 命令行：node tools/inspector-electromagnets-probe.mjs`);
process.exit(fail ? 1 : 0);
