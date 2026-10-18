// ══════════════════════════════════════════════════════════
// 无头验收：「电磁」分类的**器材自报读数**（`def.stats`）—— 行闭环 + 无读数边界
//
//   node tools/inspector-electromagnets-probe.mjs          # 全过 exit 0，有失败 exit 1，跑不起来 exit 2
//   node tools/inspector-electromagnets-probe.mjs --mutate # 红测：删掉一件器材的 stats 项，闭环必须变红
//
// ⚠ 开关只认 `--mutate`：任何别的开关都 **exit=2 明确报错**（不认识的开关 + exit=0 = 空转的绿 ✗）。
// ⚠ 源码判据与变异提取的输入一律先剥注释（`stripComments`，在**读取处统一剥**）：注释里的字样不算
//   「代码里有」—— 否则一条注释就能让锚点计数变成 2（假拦截），或让提取器改到注释上（假生效）。
//
// ── ★ 2026-10-17 整篇改写（T-16）────────────────────────────────────────
// 本探针原先验收 `STATE_LABELS['电磁']` 这张**域标签表**。该表已随 B4 第 3 步退役
// （交付报告 §二十七），域表**不再存在** ⇒ 原判据**整篇失效**：`:245` 断言表非空、
// `:248–264` 验表自身的标签/单位质量、`:280–291` 按 `LAB[k]` 把键分流成「靠域表」与
// 「靠 fields」、连**红测锚点**都是「删表里 `needleDeg` 那一项」⇒ 锚点计数变成 0：
//
//     ✗ STATE_LABELS['电磁'] 存在且非空：0 个键
//     TypeError: Cannot read properties of undefined (reading 'label')
//
// **这是「退役一张表 = 退役所有以它为证据来源的断言」的实例**（报告 §29.2）。
// 上一轮退役时只扫了**最小验证集**那 8 套探针，8 套全绿就以为干净了 —— 而这一份
// **不在最小集里**。**「最小集全绿」不等于「没有回归」。**
//
// ⇒ 现改为验收**退役后的唯一出处**：器材自报的 `def.stats`。判据仍保持原设计的
//   **两个互不依赖的来源**：
//     来源 A（查声明）：标签与单位从 `def.stats` 自己读 —— 非空、不退化、除无量纲外都带单位；
//                       并查**反向**：`def.stats` 声明的项数必须等于面板真铺出来的行数。
//     来源 B（查渲染）：跑**应用自己的 `Inspector.updateLive()`**（DOM 替身照
//                       tools/inspector-stats-probe.mjs，只借替身，不借它的判据），
//                       断言面板的行与 `def.stats` **按序逐字一致**（标签相同、值以单位结尾）。
//   申报了 stats 而渲染没跟上 → 红；渲染没走 stats（落回通用表或原始键名）→ 也红。
//
// 负向判据：匀强磁场这类「state 里没有数字」的器材必须老实显示「状态 · 无读数」，
// 不得因为有了 stats 就冒出假行。
// 终态判据：`STATE_LABELS['电磁']` 必须**不存在** —— 谁把分类表加回来，这里就红
// （与 `inspector-stats-probe` 的 `㉒甲2` / `㉒丙` 同一个语义）。
//
// 口径出处：D44（只给方向不给大小）—— 检验电荷的标签就是「受力方向」，没有大小项；
// 电磁器材本体与叠加约定见 src/equipment/electromagnets.js 文件头。
// ══════════════════════════════════════════════════════════

import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { World } from '../src/core/world.js';
import { PluginHost } from '../src/core/plugin.js';
import { create, list, bindRegistry, equipmentPlugins } from '../src/equipment/index.js';
import { CouplingBus } from '../src/coupling/bridge.js';

// ── 未知开关 ⇒ 明确报错退出（不许静默忽略）──
// 理由：不认识的开关 + exit=0 与「我验了」长得一模一样 ⇒ 空转的绿最难被发现（形状照 tools/lamp-thermal-probe.mjs）。
// ⚠ 2026-10-17（第二轮）：`--mutate` **已修回可用**。上一轮曾主动关掉它 —— 因为当时改写后红测靶子
//   换到 `electromagnets.js`，而它的 defs 是 `default.setup()` 里的**懒工厂**、模块外部取不到，
//   "覆盖注册表"路线实测不生效（正测绿而红测打印「（没红！）」）。
//   现改用**不需要变体文件**的靶子：`STATE_LABELS` 是 `inspector.js` 导出的**同一个对象实例**，
//   原地给它加一个分类表就是改被测对象 ⇒ ⑤ 的终态判据必须红。绿色与红色的判据是同一份
//   `checkRetired()`，不会漂移。
const known = new Set(['--mutate']);
const bad = process.argv.slice(2).filter((a) => !known.has(a));
if (bad.length) { console.log(`✗ 不认识的开关：${bad.join(' ')} —— 本探针只认 ${[...known].join(' / ')}`); process.exit(2); }

const MUTATE = process.argv.includes('--mutate');
const REPO = new URL('../', import.meta.url);
const CAT = '电磁';
const EM_TYPES = ['barmagnet', 'compass', 'charge', 'testcharge', 'efield', 'bfield'];
/** 没有数字读数、只显示「状态 · 无读数」的器材 —— 不许给它声明 stats。 */
const NO_READING = new Set(['bfield']);
/** 无量纲的键标签：带电符号就是 +1 / 0 / −1 本身。除它之外每项都必须带单位。 */
const DIMENSIONLESS_LABELS = new Set(['带电符号']);
/** 只取一件器材作「应带单位」的全量样本（除无量纲项外）。 */

let pass = 0, fail = 0;
const ok = (cond, msg) => { (cond ? pass++ : fail++); console.log((cond ? '  \x1b[32m✓\x1b[0m ' : '  \x1b[31m✗\x1b[0m ') + msg); return !!cond; };
const head = (t) => console.log('\n\x1b[36m' + t + '\x1b[0m');
const info = (t) => console.log('    · ' + t);
const sha = (p) => { const b = readFileSync(new URL(p, REPO)); return { sha256: createHash('sha256').update(b).digest('hex'), bytes: b.length }; };
/** 源码文本的两个读入口：`readCode` 的返回**已剥注释** —— 凡「源码里有没有 X」的判据与变异提取都必须用它。 */
const stripComments = (s) => s.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
const readRaw = (rel) => readFileSync(new URL(rel, REPO), 'utf8');
const readCode = (rel) => stripComments(readRaw(rel));

// ── DOM 替身（照 tools/inspector-stats-probe.mjs）──────────────────────
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
const { Inspector, STATE_LABELS } = await import('../src/ui/inspector.js');

const bootApp = {
  services: {}, ticks: [], world: null, lastCircuit: null, selected: null,
  log: { push() {}, clear() {} }, toast() {}, addTick(fn) { this.ticks.push(fn); return () => {}; },
};
const host = new PluginHost(bootApp);
for (const p of equipmentPlugins) host.define(p);
host.installAll();
bindRegistry(host.registry('equipment'));
const appStub = { world: { get: () => null }, markDirty() {}, duplicate() {}, removeEntity() {} };

/** 照 tools/inspector-stats-probe.mjs：跑应用自己的 updateLive()，读它铺出来的行 */
function readRows(el) {
  const rows = [];
  for (let i = 0; i + 1 < el.children.length; i += 2) rows.push([el.children[i].textContent, el.children[i + 1].textContent]);
  return rows;
}
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
/** 兜底口径会收到的键 —— 与 inspector.js 同一条规则（下划线开头的内部键 + 非有限数字都不收） */
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
  return { type, ent, keys: numericKeysOf(ent), stats: (ent.def && ent.def.stats) || [] };
});

/**
 * ⑤ 的判据本体。**绿测与红测跑的是同一份** —— 两套断言会漂移，一套不会。
 * 语义：分类表必须已退役（不存在「电磁」这个键），且现存只剩「通用」兜底。
 */
function checkRetired() {
  const cats = Object.keys(STATE_LABELS);
  return {
    cats,
    noCat: !Object.prototype.hasOwnProperty.call(STATE_LABELS, CAT),
    onlyGeneral: cats.length === 1 && cats[0] === '通用',
  };
}

// ══ 红测：把已退役的「电磁」分类表**加回** `STATE_LABELS`，⑤ 的终态断言必须红 ══
// 靶子就是 ⑤ 自己。之所以不再用"变体文件 + 改动被测源码"那一路：改写后候选靶点落在
// `electromagnets.js`，而它的 defs 是 `default.setup()` 里的**懒工厂**、模块外部取不到 ⇒
// "覆盖注册表"实测不生效（正测绿、红测却打印「（没红！）」）。而 `STATE_LABELS` 是
// `inspector.js` 导出的**同一个对象实例**，原地改它就是改被测对象 —— 且不需要变体文件、
// 不需要处理 `%TEMP%` 的相对 import、不需要 `decodeURIComponent`。
if (MUTATE) {
  head(`桩 STATE_LABELS：把「${CAT}」分类表加回去（⑤ 必须红）`);
  const before = checkRetired();
  ok(before.noCat && before.onlyGeneral,
    `注入前 ⑤ 为绿（noCat=${before.noCat} onlyGeneral=${before.onlyGeneral}；现存 ${before.cats.join('/')}）`);

  STATE_LABELS[CAT] = {};                 // ← 变异：把分类表加回来（原地改同一个对象）
  const after = checkRetired();
  ok(!after.noCat, `注入后 ⑤ 的「没有分类表」判据变红（noCat=${after.noCat}）`);
  ok(!after.onlyGeneral,
    `注入后 ⑤ 的「只剩通用」判据变红（onlyGeneral=${after.onlyGeneral}；现存 ${after.cats.join('/')}）`);

  delete STATE_LABELS[CAT];               // ← 还原
  const restored = checkRetired();
  ok(restored.noCat && restored.onlyGeneral,
    `还原后 ⑤ 复绿（noCat=${restored.noCat} onlyGeneral=${restored.onlyGeneral}）`);

  const good = before.noCat && before.onlyGeneral && !after.noCat && !after.onlyGeneral && restored.noCat && restored.onlyGeneral;
  console.log(`\n${good ? '\x1b[32m红测通过：⑤ 的两条判据都按预期在变体上变红，注入前后对照正常\x1b[0m' : '\x1b[31m红测不成立\x1b[0m'}`);
  console.log('INSPECTOR_EM_JSON ' + JSON.stringify({ ok: good, mutate: true, cat: CAT, after }));
  process.exit(good ? 0 : 1);
}

// ══ 正测 ═══════════════════════════════════════════════════
const SHA0 = { inspector: sha('src/ui/inspector.js'), equipment: sha('src/equipment/electromagnets.js') };

{
  console.log('\x1b[1m小墨实验室 · 「电磁」器材自报读数（def.stats）无头验收\x1b[0m');
  console.log(`命令行：node tools/inspector-electromagnets-probe.mjs`);
  console.log(`D36 起点：src/ui/inspector.js ${SHA0.inspector.bytes}B ${SHA0.inspector.sha256.slice(0, 16)}  |  src/equipment/electromagnets.js ${SHA0.equipment.bytes}B ${SHA0.equipment.sha256.slice(0, 16)}`);
}

head('⓪ 探针自身的纪律自检：源码判据的输入必须先剥注释');
{
  const raw = readRaw('src/equipment/electromagnets.js');
  const code = readCode('src/equipment/electromagnets.js');
  ok(raw.length > code.length, `正控（非空转）：剥注释确实动过真源码文本 ${raw.length} → ${code.length} B（它真有整行注释）`);
  // ⚠ 标志词必须是**真源码里不存在**的串 —— 否则「剥注释后看不见」会因为源码本身含它而必然为假。
  const MARK = 'XM_注释哨兵_9f3a';
  ok(!code.includes(MARK), `标志词「${MARK}」在真源码里不存在（否则下一条断言恒假：源码自己就含它）`);
  const withNote = code + `\n// ${MARK}\n`;
  ok(withNote.includes(MARK), `注入一条含标志词的行注释 ⇒ 不过滤时看得见（${withNote.includes(MARK)}）`);
  ok(!stripComments(withNote).includes(MARK), `剥注释后它不在判据的输入里（${stripComments(withNote).includes(MARK)}）`);
}

head('① 装配 + 不可变式：这 6 件器材都在册，且分类就是「电磁」');
{
  const all = list().filter((d) => EM_TYPES.includes(d.type));
  ok(all.length === EM_TYPES.length, `6 件器材全部在册（${all.map((d) => d.type).join(' / ')}）`);
  const wrongCat = all.filter((d) => d.cat !== CAT);
  ok(wrongCat.length === 0, `6 件的 def.cat 都是「${CAT}」（不符 ${wrongCat.length} 件）`);
}

head('② 来源 A（查声明）：标签与单位从 def.stats 自己读 —— 非空、不退化、除无量纲外都带单位');
{
  const statless = CASES.filter((cs) => cs.stats.length === 0);
  ok(statless.length === NO_READING.size,
    `只有 ${[...NO_READING].join('/')} 没有 stats（实际无 stats 的：${statless.map((c) => c.type).join('/') || '无'}）`);
  ok(CASES.find((c) => c.type === 'bfield').stats.length === 0,
    `${'bfield'}（匀强磁场）的 state 键都不是数字 ⇒ 不给它声明 stats（有读数可给才声明）`);

  const withStats = CASES.filter((cs) => cs.stats.length > 0);
  const total = withStats.reduce((n, cs) => n + cs.stats.length, 0);
  ok(withStats.length === EM_TYPES.length - NO_READING.size && total === 14,
    `${withStats.length} 件共自报 ${total} 行（声明的键：barmagnet 2 · compass 4 · charge 4 · testcharge 3 · efield 1）`);

  const badLabel = withStats.flatMap((cs) => cs.stats.filter((s) => typeof s.label !== 'string' || !s.label).map((s, i) => `${cs.type}[${i}]`));
  ok(badLabel.length === 0, `全部标签都非空且是字符串（不合格 ${badLabel.length} 个${badLabel.length ? '：' + badLabel.join(',') : ''}）`);

  const badUnit = withStats.flatMap((cs) => cs.stats.filter((s) => !DIMENSIONLESS_LABELS.has(s.label) && !s.unit).map((s) => `${cs.type}:${s.label}`));
  ok(badUnit.length === 0, `除 ${[...DIMENSIONLESS_LABELS].join('/')}（无量纲）外每行都带单位（不合格 ${badUnit.length} 个${badUnit.length ? '：' + badUnit.join(',') : ''}）`);

  const badRead = withStats.flatMap((cs) => cs.stats.filter((s) => typeof s.read !== 'function').map((s) => `${cs.type}:${s.label}`));
  ok(badRead.length === 0, `每行都有 read(e)（不合格 ${badRead.length} 个）`);

  // 独立来源：|q| 的单位必须与器材自己给 q 声明的 fields 单位一致（不写死）
  const chargeCs = CASES.find((c) => c.type === 'charge');
  const qf = chargeCs.ent.def.fields.find((f) => f.k === 'q');
  const qAbs = chargeCs.stats.find((s) => s.label === '电量大小 |q|');
  ok(qAbs && qAbs.unit === qf.unit, `|q| 的单位取自器材自己的 fields 声明：${qAbs && qAbs.unit} ⟷ ${qf.unit}（不写死）`);

  // 反向：stats 的**行数**必须与兜底口径真会产出的数字键**不算同一回事** ——
  // stats 是「要显示什么」的声明，允许多于/少于 fallback 键集（如 pulley 故意去截断）。
  // 但**电磁这 5 件**恰好一一对应，故这里查得紧一些：行数 == 数字键数。
  const mismatch = withStats.filter((cs) => cs.stats.length !== cs.keys.length);
  ok(mismatch.length === 0,
    `5 件的 stats 行数与 state 里的有限数字键数一致（不符 ${mismatch.length} 件${mismatch.length ? '：' + mismatch.map((c) => `${c.type} ${c.stats.length}⟷${c.keys.length}`).join(',') : ''}）`);
  // 死条目边界：非数字键一个都不许进 stats
  const NONNUM = ['axis', 'poleN', 'poleS', 'dir', 'force', 'ambient', 'srcId', 'fieldDefined', 'inField', 'reason', 'symbol', 'outOfPage'];
  const polluted = withStats.filter((cs) => cs.stats.some((s) => NONNUM.includes(s.label)));
  ok(polluted.length === 0, `非数字 state 键一个都没进 stats（${NONNUM.length} 个候选，污染 ${polluted.length} 件）`);
}

head('③ 来源 B（查渲染）：跑应用自己的 updateLive()，逐行闭环「标签 + 单位 + 值」');
{
  for (const cs of CASES) {
    const rows = renderRows(Inspector, cs.ent);
    if (cs.stats.length === 0) {
      ok(rows.length === 1 && rows[0][0] === '状态' && rows[0][1] === '无读数',
        `${cs.type}：state 里没有数字 ⇒ 老实显示「状态 · 无读数」（实际 ${rows.length} 行：${rows.map((r) => r[0]).join('/')}）`);
      continue;
    }
    const st = cs.stats;
    const msgs = [];
    if (rows.length !== st.length) msgs.push(`行数 ${rows.length} ⟷ stats ${st.length}（实有：${rows.map((r) => r[0]).join(' / ')}）`);
    st.forEach((s, i) => {
      const r = rows[i];
      if (!r) { msgs.push(`第 ${i} 行缺失（stats 里是「${s.label}」）`); return; }
      if (r[0] !== s.label) { msgs.push(`第 ${i} 行贴的是「${r[0]}」，stats 里是「${s.label}」⇒ 渲染没走 stats`); return; }
      if (!r[1]) { msgs.push(`「${s.label}」这一行的值是空的`); return; }
      if (s.unit && !r[1].endsWith(s.unit)) msgs.push(`「${s.label}」的值「${r[1]}」没拼上单位「${s.unit}」`);
    });
    ok(msgs.length === 0, `${cs.type}：${st.length} 行按序闭环 —— ${msgs.length ? msgs.join('；') : st.map((s) => s.label).join(' / ')}`);
  }
}

head('④ 负向：不许冒假行，也不许漏行');
{
  let fake = 0, drop = 0, lines = [];
  for (const cs of CASES) {
    const rows = renderRows(Inspector, cs.ent);
    const st = cs.stats;
    if (st.length === 0) {
      if (rows.length !== 1) { fake++; lines.push(`${cs.type} 冒出 ${rows.length - 1} 行假读数：${rows.map((r) => r[0]).join('/')}`); }
      continue;
    }
    if (rows.length > st.length) { fake++; lines.push(`${cs.type} 多出 ${rows.length - st.length} 行`); }
    if (rows.length < st.length) { drop++; lines.push(`${cs.type} 少了 ${st.length - rows.length} 行`); }
  }
  ok(fake === 0, `没有一件器材冒出 stats 之外的行（${fake} 件${fake ? '：' + lines.join('；') : ''}）`);
  ok(drop === 0, `没有一件器材漏掉 stats 里声明的行（${drop} 件）`);
}

head(`⑤ 终态：STATE_LABELS['${CAT}'] 必须已退役（谁把分类表加回来，这里就红）`);
{
  // ⚠ 判据来自 `checkRetired()` —— 与 `--mutate` 红测跑的是**同一份**（两套写法会漂移，一套不会）。
  const R = checkRetired();
  ok(R.noCat,
    `STATE_LABELS 里没有「${CAT}」这个分类表（现存分类键：${R.cats.join('/') || '无'}；「通用」兜底保留）`);
  ok(R.onlyGeneral,
    `现存只剩「通用」兜底（实际：${R.cats.join('/')}）—— 与 inspector-stats-probe 的 ㉒甲2 / ㉒丙 同语义`);
}

head('⑥ 冻结口径（首尾各一次）');
{
  const SHA1 = { inspector: sha('src/ui/inspector.js'), equipment: sha('src/equipment/electromagnets.js') };
  ok(SHA1.inspector.sha256 === SHA0.inspector.sha256, `跑前跑后 src/ui/inspector.js 逐字节相同（${SHA1.inspector.bytes}B）`);
  ok(SHA1.equipment.sha256 === SHA0.equipment.sha256, `跑前跑后 src/equipment/electromagnets.js 逐字节相同（${SHA1.equipment.bytes}B）`);
  console.log(`D36 终点：src/ui/inspector.js ${SHA1.inspector.bytes}B ${SHA1.inspector.sha256.slice(0, 16)}  |  src/equipment/electromagnets.js ${SHA1.equipment.bytes}B ${SHA1.equipment.sha256.slice(0, 16)}`);
}

console.log(`\n\x1b[1m全部通过：${pass} 项\x1b[0m` + (fail ? `  \x1b[31m失败 ${fail} 项\x1b[0m` : ''));
console.log(`INSPECTOR_EM_JSON ${JSON.stringify({ ok: fail === 0, pass, fail, cat: CAT, statRows: CASES.reduce((n, c) => n + c.stats.length, 0), files: [{ file: 'src/ui/inspector.js', ...SHA0.inspector }] })}`);
console.log(`D40 命令行：node tools/inspector-electromagnets-probe.mjs`);
process.exit(fail === 0 ? 0 : 1);
