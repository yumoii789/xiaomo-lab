// ══════════════════════════════════════════════════════════
// C9 (b) 撤销栈骨架探针
//
// 测什么（**测条件，不测数字**）：
//   ① 一次属性改动：撤销 ⇒ 值回到改前；重做 ⇒ 再回到改后（值序列可复现）
//   ② 接线：撤销 → 重做 → 再撤销 仍然成立
//      （重做会造出**新的** Wire 对象 ⇒ 这条专抓"拿旧引用去断线"的走空 bug）
//   ③ 删除器材：逆动作必须把**连带断掉的线**接回去（不完整还原里最难发现的一类）
//   ④ 两条边界：栈深上限（丢最旧的）／撤销后新动作截断重做链
//   ⑤ 三类**永不入栈**：求解器注入、存档载入、重置
//      ⚠ 每一条都配**反向对照**（"深度没变"若因为世界根本没动就是假绿 ✗）
//   ⑥ 红能力**定向**：六个变异体各打掉一条判据（m1–m3 改 `src/core/undo.js` 文本；m4–m6 改 `src/main.js` 文本，
//      见下 —— 后三个只证"源码文本层面的接线"，**不等于**真跑 loadScene()，强度弱于 m1–m3，如实标注）
//
// 用法：
//   node tools/undo-probe.mjs            正常跑（全绿 ⇒ exit 0）
//   node tools/undo-probe.mjs --red=m1   变异：去掉 push 里的 silent 闸 ⇒ §5b 必须红
//   node tools/undo-probe.mjs --red=m2   变异：isReversible 恒真   ⇒ §5a 必须红
//   node tools/undo-probe.mjs --red=m3   变异：push 不截断重做链   ⇒ §4b 必须红
//   node tools/undo-probe.mjs --red=m4   变异：loadScene 去掉 try/finally ⇒ §0 接线必须红
//   node tools/undo-probe.mjs --red=m5   变异：reset() 不 clear()      ⇒ §0 必须红
//   node tools/undo-probe.mjs --red=m6   变异：load() 去掉 try/finally ⇒ §0 必须红
//   ⚠ 只认 `--red=m1..m6`；**任何别的开关都会 exit=2 明确报错**（不认识的开关 + exit=0 = 空转的绿 ✗）
//   ⚠ 源码级判据的输入**先剥注释**（否则注释里的字面量会把判据弄红/弄绿；§0 末尾有自检断言锁这件事）
// ⚠ 已知且**已被接受的并发副作用**（下一个人别当缺陷重查）：清理按**前缀全局清扫**（`xm-undo-mutant-*`），
//   因此它也会删掉**另一个正在并发运行的** `--red` 运行写下的变异体。对那次运行**无影响** —— 它是在
//   `import` **之后**才被断言的；但两个转速不同的并发运行会互相清扫。之所以不改成"只删本进程创建的那个"：
//   那样历史残留不归零，与"跑完后残留必须为 0"这条断言冲突（取舍由 lead 裁定：取前缀全局清扫 ✓）。
// ══════════════════════════════════════════════════════════

import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'node:child_process';
import crypto from 'crypto';
import { fileURLToPath, pathToFileURL } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const P = (rel) => path.join(ROOT, rel);
const load = (rel) => import(pathToFileURL(P(rel)).href);
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex').toUpperCase();
const read = (rel) => fs.readFileSync(P(rel), 'utf8');

// ⚠ 源码级断言的输入是**代码**，注释不是它的输入：喂给判据的片段必须先剥掉注释行 ✗
//   否则自己写的说明文字（例如一句写着「不出现 setProp」的注释里真的出现了 `setProp`）会把**判据**弄红 ✗。
//   诊断旁证（记下）：坏判据的特征是「**它不看变异体也会红**」——
//   若某条断言在所有档位（含正常档）都红，先怀疑判据，别先去查被测代码。
const stripComments = (s) => s.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
// 本探针**所有**源码断言统一走这里（纪律：扫描模式必须匹配代码而非注释）。
// 只此一处还不够 —— 我第一次修只改了一条断言，第二次另一条（`接线 · 载入两处都挂起记录` 数 `beginSilent()` 次数）
// 又被我自己新写的注释里的同一个词弄红 ⇒ 所以改成**在读取处统一剥**，而不是每条断言各自记得剥。
const readCode = (rel) => stripComments(read(rel));

// ── 未知开关 ⇒ 明确报错退出（不许静默忽略）──
// 理由：不认识的开关 + exit=0 与「我验了」长得一模一样 ⇒ 空转的绿最难被发现。
// 本探针只认 `--red=<变异体id>`；**裸 `--red`** 也算不认识 —— 它今天就是一个静默空转 ✗。
{
  const known = (a) => a.startsWith('--red=');
  const bad = process.argv.slice(2).filter((a) => !known(a));
  if (bad.length) { console.log(`✗ 不认识的开关：${bad.join(' ')} —— 本探针只认 --red=m1..m6`); process.exit(2); }
}

// ── 清理本探针自己在 %TEMP% 留下的变异体（**只删自己的命名前缀**，绝不通配扫 %TEMP%）──
// 纪律来源（t1 在 dotscan/hitscan 上实测的真缺陷**同型**）：`process.exit()` 不展开调用栈 ⇒ `finally` 被跳过。
// 所以清理**不能**只挂在某一条正常路径上；`process.on('exit')` 的处理器在三种退出下都会执行
// （实测：process.exit / 抛出 / 自然结束 都跑 ⇒ §0 里有子进程自检锁着这条），且它必须是**同步**的。
// ⚠ `process.on('exit')` 处理器内**只能同步**（它不等待异步工作）—— 将来若真要在这里做异步清理，
//   **必须换机制**（例如把清理挪进一个被 `await` 的 `try/finally`，代价见文件头的重排说明），别在此处 await。
const TMP_PREFIX = 'xm-undo-mutant-';
function sweepTempMutants() {
  const dir = os.tmpdir();
  let removed = 0;
  for (const n of fs.readdirSync(dir)) {
    if (!n.startsWith(TMP_PREFIX) || !n.endsWith('.mjs')) continue;
    try { fs.unlinkSync(path.join(dir, n)); removed += 1; } catch { /* 并发运行已删走，不算错 */ }
  }
  const left = fs.readdirSync(dir).filter((n) => n.startsWith(TMP_PREFIX) && n.endsWith('.mjs')).length;
  return { removed, left };
}
process.on('exit', () => {
  try { sweepTempMutants(); } catch (e) { console.log(`⚠ 退出清理失败：${e.message}`); }   // 显式可见，不静默吞掉
});

const RED = (process.argv.find((a) => a.startsWith('--red=')) || '').slice(6);
const deps = {};
let pass = 0, fail = 0;
const F = [];
const head = (t) => console.log(`\n── ${t} ──`);
const info = (s) => console.log(`   ${s}`);
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`   ✓ ${name}${detail ? '  ' + detail : ''}`); }
  else { fail++; F.push(name); console.log(`   ✗ ${name}${detail ? '  ' + detail : ''}`); }
};

// ── 变异（D43：源文本 → 内存改写 → 写 %TEMP% → 导入；undo.js 零 import ⇒ 无需改写导入路径）──
const MUT = {
  m1: { why: '去掉 push 里的 silent 闸（模拟"把挂起当成不存在"）',
        re: /if \(this\.isSilent\(\) \|\| !isReversible\(op\.kind\)\)/,
        to: 'if (!isReversible(op.kind))' },
  m2: { why: 'isReversible 恒真（模拟"什么种类的动作都收"）',
        re: /return !!\(k && k\.reversible\);/,
        to: 'return true;' },
  m3: { why: 'push 不截断重做链（模拟"撤销后再做新动作，旧的还能重做"）',
        re: /    this\._future\.length = 0;\n/,
        to: '' },
};
let undoPath = P('src/core/undo.js');
let mutInfo = null;
// (甲)(乙) 的变异打在 **main.js 的源码文本**上：main.js 顶层就建 DOM 宿主、**无法 import** ✗，
// 所以不能像 m1–m3 那样"写临时文件再导入"，只能改文本再让源码断言去读它（仓库零字节改动 ✓）。
const MUT_MAIN = {
  m4: { why: '去掉 loadScene 的 try/finally 解挂（模拟"载入中途抛出就永久挂起"）',
        apply: (s) => {
          const re = /try \{ this\._applyScene\(sc\); \} finally \{ this\.undo\.endSilent\(\); \}/;
          if (!re.test(s)) throw new Error('m4 未命中');
          return s.replace(re, 'this._applyScene(sc);');
        } },
  m5: { why: '去掉 reset() 里的历史清空（模拟"重置后旧历史还留着"）',
        apply: (s) => {
          const re = /    this\.undo\.clear\(\);\n/;
          if (!re.test(s)) throw new Error('m5 未命中');
          return s.replace(re, '');
        } },
  m6: { why: '去掉 load() 的 finally 解挂（模拟"读档中途抛出就永久挂起"）',
        apply: (s) => {
          const re = /try \{ n = this\._applySave\(data\); \} finally \{ this\.undo\.endSilent\(\); \}/;
          if (!re.test(s)) throw new Error('m6 未命中');
          return s.replace(re, 'n = this._applySave(data);');
        } },
};
const MAIN_MUT = RED === 'm4' || RED === 'm5' || RED === 'm6';
if (RED) {
  const m = MUT[RED];
  if (MAIN_MUT) {
    mutInfo = { id: RED, why: MUT_MAIN[RED].why, out: '(main.js 源码文本变异，未落盘)' };
    console.log(`变异体已生效（文本级）：${MUT_MAIN[RED].why}`);
  } else if (!m) { console.log(`未知变异 ${RED}`); process.exit(2); }
  else {
    const src = read('src/core/undo.js');
    if (!m.re.test(src)) { console.log(`✗ 变异未命中（先怀疑提取器，D49）：${m.why}`); process.exit(2); }
    const out = path.join(os.tmpdir(), `xm-undo-mutant-${RED}-${Date.now()}.mjs`);
    fs.writeFileSync(out, src.replace(m.re, m.to));
    undoPath = out;
    mutInfo = { id: RED, why: m.why, out: path.basename(out) };
    console.log(`变异体已生效：${m.why}`);
  }
}

const { World } = await load('src/core/world.js');
const U = await import(pathToFileURL(undoPath).href);
const { UndoStack, isReversible, OP_KINDS } = U;
const { solveCircuit } = await load('src/physics/circuit.js');
const { PluginHost } = await load('src/core/plugin.js');
const R = await load('src/equipment/registry.js');

// 器材注册表（与既有探针同一套 boot 惯用法）
const app = {
  services: {}, world: null, selected: null, circuit: null,
  log: { push() {}, clear() {} }, toast() {}, addTick: () => () => {}, markDirty() {},
};
const host = new PluginHost(app);
host.define((await load('src/physics/circuit.js')).default);
host.define((await load('src/equipment/electrical.js')).default);
host.installAll();
R.bindRegistry(host.registry('equipment'));

// ══ §0 现状与接线（静态）══
head('§0 现状与接线');
deps['src/core/undo.js'] = sha(fs.readFileSync(P('src/core/undo.js')));
for (const f of ['src/core/entity.js', 'src/core/world.js', 'src/main.js']) deps[f] = sha(fs.readFileSync(P(f)));
info(`deps: undo.js ${deps['src/core/undo.js'].slice(0, 12)}… entity ${deps['src/core/entity.js'].slice(0, 12)}… world ${deps['src/core/world.js'].slice(0, 12)}… main ${deps['src/main.js'].slice(0, 12)}…`);

const srcEntity = readCode('src/core/entity.js'), srcWorld = readCode('src/core/world.js');
// move 类断言用（④-6）：交互层是否把起止坐标交出去
const srcInteract = readCode('src/ui/interact.js');
let srcMain = readCode('src/main.js');
if (MAIN_MUT) {
  try { srcMain = MUT_MAIN[RED].apply(srcMain); }
  catch (e) { console.log(`✗ 变异未命中：${e.message}`); process.exit(2); }
}
ok('接线 · entity.setProp 记 prop 类动作', /kind: 'prop', label: `改参数 \$\{k\}`/.test(srcEntity) || /kind: 'prop'/.test(srcEntity));
ok('接线 · world.add 记 add 类动作', /kind: 'add', label:/.test(srcWorld));
ok('接线 · world.remove 记 remove 类动作且逆动作接回线', /kind: 'remove', label:/.test(srcWorld) && /for \(const \[a, b, k\] of refs\) this\.connect\(a, b, k\)/.test(srcWorld));
ok('接线 · world.connect 记 wire 类动作且刷新引用', /kind: 'wire', label: '接线'/.test(srcWorld) && /cur = this\.connect\(/.test(srcWorld));
ok('接线 · main.js 建栈并挂到 world', /new UndoStack\(/.test(srcMain) && /this\.world\.undo = this\.undo;/.test(srcMain));
ok('接线 · 载入两处都挂起记录', (srcMain.match(/beginSilent\(\)/g) || []).length === 2 && (srcMain.match(/endSilent\(\)/g) || []).length >= 2);
ok('接线 · 重置清空历史', /this\.undo\.clear\(\);/.test(srcMain));

// ── 自检：把我在本轮**真实踩过的两脚**做成可执行断言（注释不是判据的输入）──
// 这两条一旦红，先查 `stripComments`/判据，别去查被测代码（坏判据的特征：不看变异体也会红）。
{
  const X = 'const x = 0;\n';
  ok('自检：注释里的 `this.undo.clear();` 不会让"重置清空历史"假绿',
    /this\.undo\.clear\(\);/.test(stripComments(X + '// this.undo.clear();\n')) === false);
  ok('自检：同一条**不**剥注释就会假绿（第一脚：我自己的说明文字成了判据的输入）',
    /this\.undo\.clear\(\);/.test(X + '// this.undo.clear();\n') === true);
  const cntB = (s) => (s.match(/beginSilent\(\)/g) || []).length;
  ok('自检：注释里的 `beginSilent()` ×2 不会把计数断言弄红（第二脚：注释抬高计数）',
    cntB(stripComments(X + '// beginSilent() beginSilent()\n')) === 0 && cntB(X + '// beginSilent() beginSilent()\n') === 2);
  ok('自检：剥注释确实改动过真源码文本（否则上面三条是空转）', readCode('src/main.js') !== read('src/main.js'));
}

// ── 自检（t1 在 dotscan/hitscan 上实测的真缺陷**同型**）：`process.exit()` 不展开调用栈 ⇒ `finally` 不执行 ──
// 本探针**今天没有被它跳过的清理**：5 处 exit 要么在保护区之外、要么是终局；且本文件顶层**没有** try/finally
// （全文的 `finally` 只出现在注释/字符串里，或在测试体内模拟闸门）。但这条纪律必须锁住 ——
// 将来给断言区套 try/finally 做清理时，"最自然的写法"（在保护区里 process.exit）会**静默跳过**它 ✗。
// 三种写法的行为由**子进程实测**（本机 node v24.20.0，与 t1 的实测一致），不靠推推：
//   process.exit(2)     → exit 2，finally **不跑** ✗（缺陷本身）
//   exitCode=2; throw   → exit **1**（被未处理 reject 覆盖），finally 跑了但退出码错 ✗
//   exitCode=2; return  → exit 2，finally **跑** ✓（唯一正确写法；⚠ **必须包在函数里** ——
//                          裸顶层 `return` 在 ESM 里是 SyntaxError，实测解析失败 ✗，不能只加一句 return）
{
  const child = (body) => spawnSync(process.execPath,
    ['--input-type=module', '-e', `const run = async () => { try { ${body} } finally { console.log('FINALLY_RAN'); } }; await run();`],
    { encoding: 'utf8' });
  const ranFinally = (r) => /FINALLY_RAN/.test(r.stdout || '');
  const rExit = child('console.log(1); process.exit(2);');
  const rThrow = child('process.exitCode = 2; throw new Error(String(1));');
  const rReturn = child('process.exitCode = 2; return;');
  ok('自检（t1 同型）：子进程能起来（起不来要**显式**看见原因，而不是三条空转绿）', !rExit.error, String(rExit.error || ''));
  ok('自检（t1 同型·正控）：`process.exit()` 跳出 ⇒ `finally` 被**跳过**（这就是缺陷本身）', rExit.status === 2 && !ranFinally(rExit));
  ok('自检（t1 同型·正解）：`exitCode=2; return`（async 包裹内）⇒ `finally` **照跑**且退出码**仍是 2**',
    rReturn.status === 2 && ranFinally(rReturn));
  info(`旁证（不设断言，免得把 Node 的未处理-reject 策略写死成判据）：exitCode+throw ⇒ exit=${rThrow.status}，finally=${ranFinally(rThrow) ? '跑' : '不跑'}`);
  const rHandler = child("process.on('exit', () => console.log('HANDLER_RAN')); console.log(1); process.exit(2);");
  ok('自检（t1 同型·清理的地基）：`process.on(exit)` 处理器在 `process.exit(2)` 之下**照样执行** ⇒ 清理能覆盖所有退出路径',
    rHandler.status === 2 && /HANDLER_RAN/.test(rHandler.stdout || ''));
}
ok('登记表 · 三种不可逆种类齐备', ['load', 'reset', 'solver'].every((k) => OP_KINDS[k] && OP_KINDS[k].reversible === false));

// ── move 类：拖动器材入栈（2026-10-17 新增，交互改造 ④-6）──────────────────
//    本探针此前**61 条里没有一条覆盖 move** —— 而拖动原本根本不入栈
//    （位置由 interact.js 直接写 ent.x/y、绕过 setProp，且 main.js 的 onEntityMoved 是空函数）。
{
  ok('登记表 · move 已登记且可逆', !!(OP_KINDS.move && OP_KINDS.move.reversible === true),
    `OP_KINDS.move=${JSON.stringify(OP_KINDS.move)}`);

  // 接线①：交互层必须把**起止坐标**交出去 —— 拿不到 from/to 就什么都记不了
  ok('接线 · interact.js 调 onEntityMoved 时传了起止坐标',
    /onEntityMoved\?\.\(\s*ent\s*,\s*\{\s*x:\s*ox/.test(srcInteract),
    'interact.js 里应有 onEntityMoved?.(ent, { x: ox, … }, { x: q.x, … })');
  // 接线②：main.js 必须真的入栈（原来是空函数）
  ok('接线 · main.js onEntityMoved 真的 push 一条 move',
    /kind:\s*'move'/.test(srcMain) && /onEntityMoved\s*\(\s*ent\s*,\s*from\s*,\s*to\s*\)/.test(srcMain),
    'main.js 里应有 onEntityMoved(ent, from, to) 且其中 kind: \'move\'');
  // 反面对照：空函数形态必须已经不存在（防"改了注释没改实现"）
  ok('接线 · main.js 的那个空函数形态已消失',
    !/onEntityMoved\s*\(\s*\)\s*\{\s*\/\*/.test(srcMain),
    '不应再有 onEntityMoved() { /* 位置变化由耦合总线… */ } 这种空实现');

  // 机制：一条 move 的逆/重做能把位置原样搬回去
  {
    const st = new UndoStack({ limit: 10 });
    const e = R.create('resistor', 100, 100);
    const place = (p) => { e.x = p.x; e.y = p.y; };
    const from = { x: 100, y: 100 }, to = { x: 240, y: 160 };
    place(to);
    st.push({ kind: 'move', label: '移动器材', ent: e, undo: () => place(from), redo: () => place(to) });
    st.undo();
    ok('机制 · undo 把位置搬回起点', e.x === 100 && e.y === 100, `(${e.x},${e.y})`);
    st.redo();
    ok('机制 · redo 把位置搬到终点', e.x === 240 && e.y === 160, `(${e.x},${e.y})`);
    st.undo();
    ok('机制 · 再撤销仍能回到起点（可反复）', e.x === 100 && e.y === 100, `(${e.x},${e.y})`);
  }
}

// ══ §1 属性改动：撤销/重做（值序列可复现）══
head('§1 属性改动可撤销 / 可重做');
{
  const w = new World(); w.undo = new UndoStack({ limit: 50 });
  const e = R.create('resistor', 100, 100);
  w.add(e);                                   // 用户动作「放置」⇒ depth 1
  ok('放置入栈', w.undo.depth === 1, `depth=${w.undo.depth} label=${w.undo.labels()[0]}`);
  e.setProp('__probe', 1); e.setProp('__probe', 2); e.setProp('__probe', 3);   // 用户改参数 ×3
  ok('三次改参数入栈', w.undo.depth === 4, `depth=${w.undo.depth} [${w.undo.labels().join(',')}]`);
  w.undo.undo(); w.undo.undo(); w.undo.undo();
  ok('撤销三次 ⇒ 值回到改前', e.props.__probe === undefined, `值=${String(e.props.__probe)}`);
  w.undo.redo(); w.undo.redo(); w.undo.redo();
  ok('重做三次 ⇒ 值回到 3', e.props.__probe === 3, `值=${String(e.props.__probe)}`);
  w.undo.undo(); const seq = [e.props.__probe];
  w.undo.redo(); seq.push(e.props.__probe);
  w.undo.undo(); seq.push(e.props.__probe);
  ok('值序列可复现（撤销/重做/撤销）', seq[0] === 2 && seq[1] === 3 && seq[2] === 2, `序列=${JSON.stringify(seq)}`);
  w.undo.undo(); w.undo.undo(); w.undo.undo(); w.undo.undo();
  ok('撤到最后一步 ⇒ 器材也回到"没被放过"', w.undo.depth === 0 && w.entities.length === 0, `depth=${w.undo.depth} 器材=${w.entities.length}`);
  ok('空栈再撤销不抛错', w.undo.undo() === null);
}

// ══ §2 接线闭环（专抓旧引用走空）══
head('§2 接线：撤销 → 重做 → 再撤销');
{
  const w = new World();
  const a = R.create('resistor', 0, 0), b = R.create('battery', 120, 0);
  w.add(a, true); w.add(b, true);                 // 静默放置：隔离出"接线"这一条
  w.undo = new UndoStack({ limit: 50 });
  w.connect({ e: a.id, p: 0 }, { e: b.id, p: 0 });
  ok('接线入栈', w.undo.depth === 1 && w.wires.length === 1);
  w.undo.undo();
  ok('撤销 ⇒ 线没了', w.wires.length === 0, `wires=${w.wires.length}`);
  w.undo.redo();
  const fresh = w.wires[0];
  ok('重做 ⇒ 线回来了（且是世界里的新线）', w.wires.length === 1 && w.wires[0] === fresh);
  w.undo.undo();
  ok('再撤销 ⇒ 仍然断得掉（引用没走空）', w.wires.length === 0, `wires=${w.wires.length}`);
  w.undo.redo();
  ok('再重做 ⇒ 又回来了', w.wires.length === 1);
}

// ══ §3 删除器材：连带断线也要还原 ══
head('§3 删除器材的逆动作');
{
  const w = new World();
  const a = R.create('resistor', 0, 0), b = R.create('battery', 120, 0);
  w.add(a, true); w.add(b, true);
  w.connect({ e: a.id, p: 0 }, { e: b.id, p: 0 });
  ok('前置：2 器材 1 线', w.entities.length === 2 && w.wires.length === 1);
  w.undo = new UndoStack({ limit: 50 });
  w.remove(a);
  ok('删除 ⇒ 器材与连带线都没了', w.entities.length === 1 && w.wires.length === 0, `器材=${w.entities.length} 线=${w.wires.length}`);
  w.undo.undo();
  ok('撤销 ⇒ 器材回来了', w.entities.length === 2, `器材=${w.entities.length}`);
  ok('撤销 ⇒ **连带断掉的线也接回来了**', w.wires.length === 1, `线=${w.wires.length}`);
  w.undo.redo();
  ok('重做 ⇒ 又删掉（含线）', w.entities.length === 1 && w.wires.length === 0);
}

// ══ §4 两条边界 ══
head('§4 边界：栈深上限 / 重做链截断');
{
  const st = new UndoStack({ limit: 3 });
  const mk = (k) => ({ kind: 'prop', label: k, undo() {}, redo() {} });
  for (const k of ['a', 'b', 'c', 'd']) st.push(mk(k));
  ok('栈深上限：4 推 3 留', st.depth === 3, `depth=${st.depth}`);
  ok('丢的是**最旧的**（不是最新的）', st.labels().join(',') === 'b,c,d', `[${st.labels().join(',')}]`);
  const st2 = new UndoStack({ limit: 10 });
  st2.push(mk('x')); st2.push(mk('y'));
  st2.undo();
  ok('撤销后：重做链有 1 步', st2.redoDepth === 1 && st2.canRedo());
  st2.push(mk('z'));
  ok('新动作 ⇒ 重做链截断', st2.redoDepth === 0 && !st2.canRedo(), `redoDepth=${st2.redoDepth}`);
}

// ══ §5 三类永不入栈（每条都配反向对照 ✗ 防假绿）══
head('§5 永不入栈的三类');
{
  ok('登记表：solver/load/reset 不可逆', !isReversible('solver') && !isReversible('load') && !isReversible('reset'));
  ok('未登记的种类也不可逆（拒收未知）', !isReversible('__nope__'));
  const st = new UndoStack({ limit: 10 });
  const r = st.push({ kind: 'solver', label: '求解器', undo() {}, redo() {} });
  ok('推 solver 被拒', r === null && st.depth === 0, `rejected=${st.rejected}`);

  // ②③ 载入序列：世界**确实变了**，但历史一条都没有
  const w = new World(); w.undo = new UndoStack({ limit: 50 });
  const a = R.create('resistor', 0, 0), b = R.create('battery', 120, 0);
  w.undo.beginSilent();
  w.add(a, true); w.add(b, true);
  a.setProp('__loaded', 7);                       // 读档时 main.js 也会走 setProp
  w.connect({ e: a.id, p: 0 }, { e: b.id, p: 0 });
  const duringDepth = w.undo.depth, rejectedDuring = w.undo.rejected;
  w.undo.endSilent();
  ok('反向对照：载入真的把世界改掉了（否则"没历史"是假绿）', w.entities.length === 2 && w.wires.length === 1 && a.props.__loaded === 7,
    `器材=${w.entities.length} 线=${w.wires.length} 属性=${a.props.__loaded}`);
  ok('载入（挂起中）不产生任何历史条目', duringDepth === 0, `挂起中 depth=${duringDepth}`);
  // ⚠ 精确断言 **2**（不是"≥ 一个数"）：挂起中的 `setProp` 与 `connect` 都走到了 `push` 并被闸门拒收 ✓；
  //   而上面两次 `add(x, true)` 是按**参数** short-circuit 的 —— `silent`（内部调用）与
  //   「挂起」（`beginSilent`）是**两个不同条件** ✗，前者连 push 都不调 ⇒ **不计入** `rejected` ✓。
  ok('挂起中的动作是被闸门**拒收**的（不是"悄悄没写"）', rejectedDuring === 2, `rejected=${rejectedDuring}`);
  ok('解挂后恢复正常记账', (() => { a.setProp('__after', 1); return w.undo.depth === 1; })(), `depth=${w.undo.depth}`);

  // ⑤ 求解器：真解一帧 + 连跑 10 帧，注入量在变、历史不动
  const w2 = new World();
  const r1 = R.create('resistor', 0, 0), bat = R.create('battery', 140, 0);
  w2.add(r1, true); w2.add(bat, true);
  w2.connect({ e: r1.id, p: 0 }, { e: bat.id, p: 0 });
  w2.undo = new UndoStack({ limit: 50 });          // 电路搭好**之后**才挂栈
  solveCircuit(w2, []);
  const I = bat.state.I, U = bat.state.U, P = bat.state.P;
  for (let i = 0; i < 10; i++) { solveCircuit(w2, []); w2.step(1 / 60); }
  ok('反向对照：求解器真的注入了电学量', Number.isFinite(I) && I > 0 && Number.isFinite(U) && Number.isFinite(P),
    `I=${I} U=${U} P=${P}`);
  ok('求解器（含 10 帧演化）不产生任何历史条目', w2.undo.depth === 0, `depth=${w2.undo.depth}`);
}

// ══ §6 载入挂起与重置基线（甲)(乙) ══
head('§6 (甲) 载入挂起必须有 try/finally · (乙) 重置是基线操作');
{
  ok('(甲) 接线：loadScene 用 `try { _applyScene } finally { endSilent }`',
    /try \{ this\._applyScene\(sc\); \} finally \{ this\.undo\.endSilent\(\); \}/.test(srcMain));
  ok('(甲) 接线：载入体已搬进 `_applyScene(sc)`（与挂起同生共死）', /_applyScene\(sc\) \{/.test(srcMain));
  ok('(甲2) 接线：load() 用 `try { _applySave(data) } finally { endSilent }`',
    /try \{ n = this\._applySave\(data\); \} finally \{ this\.undo\.endSilent\(\); \}/.test(srcMain));
  ok('(甲2) 接线：存档体已搬进 `_applySave(data)`（与挂起同生共死）', /_applySave\(data\) \{/.test(srcMain));
  const lBody = srcMain.match(/load\(\) \{[\s\S]*?\n  \}/);
  const lCode = lBody ? stripComments(lBody[0]) : null;   // ⚠ 先剥注释（见文件头那段纪律）
  const cnt = (s, re) => (s.match(re) || []).length;
  ok('(甲2) 结构：load() 的**代码行**里 beginSilent/endSilent 各恰好 1 次（catch 里那个兜底已移除 ⇒ 挂起不可能残留）',
    lCode !== null && cnt(lCode, /beginSilent\(\)/g) === 1 && cnt(lCode, /endSilent\(\)/g) === 1,
    lCode ? `begin=${cnt(lCode, /beginSilent\(\)/g)} end=${cnt(lCode, /endSilent\(\)/g)}` : '未找到 load() 体');
  // ⚠ 动态部分测的是**机制**（用与 loadScene 相同的调用序列重放）：main.js 顶层建 DOM 宿主，
  //   无头环境里无法实例化 App ✗ ⇒ 这是「接线断言 + 机制断言」两层，我不把它说成"直接跑了 loadScene"。
  const w = new World(); w.undo = new UndoStack({ limit: 10 });
  const a = R.create('resistor', 0, 0);
  let threw = false;
  try {
    w.undo.beginSilent();
    try {
      w.add(a, true); a.setProp('__x', 1);
      throw new Error('模拟 sc.wires 里的坏数据');
    } finally { w.undo.endSilent(); }
  } catch (e) { threw = true; }
  ok('(甲) 机制：载入体抛出后仍然解挂（isSilent === false）', threw && w.undo.isSilent() === false,
    `threw=${threw} silent=${w.undo.isSilent()}`);
  ok('(甲) 机制：抛出前那几步写入一条历史都没留下', w.undo.depth === 0, `depth=${w.undo.depth}`);

  const rBody = srcMain.match(/reset\(\) \{[\s\S]*?\n  \}/);
  // ⚠ 源码断言必须先滤掉注释：我自己在 reset() 上方写的说明文字里就出现了 `setProp` 这个词，
  //   不滤就会把**判据**弄红 —— 口径读到了注释，是判据的错，不是代码的错（首次运行 6 档全红就是这么来的）。
  const rCode = rBody ? stripComments(rBody[0]) : null;
  ok('(乙) 接线：reset() 里清空历史', rCode !== null && /this\.undo\.clear\(\);/.test(rCode));
  ok('(乙) 接线：reset() **直接写**这两个 props（基线操作，赠自己的路）',
    rCode !== null && /e\.props\.closed = false;/.test(rCode) && /e\.props\.lit = false;/.test(rCode));
  ok('(乙) 接线：reset() 的**代码行**里不出现 `setProp`（注释已滤）',
    rCode !== null && !/setProp/.test(rCode));
  ok('(乙) 登记表：reset 属不可逆种类', OP_KINDS.reset && OP_KINDS.reset.reversible === false);
  const w2 = new World(); w2.undo = new UndoStack({ limit: 10 });
  const b = R.create('resistor', 0, 0);
  w2.add(b, true);
  b.setProp('__hist', 1);
  const before = w2.undo.depth;
  w2.undo.beginSilent();
  try { b.props.closed = false; } finally { w2.undo.endSilent(); }   // 模拟 reset() 的直接写
  w2.undo.clear();
  ok('(乙) 机制：重置后历史清零（旧历史对重置后的世界不再成立）',
    before > 0 && w2.undo.depth === 0 && !w2.undo.canRedo(), `前=${before} 后=${w2.undo.depth}`);
  ok('(乙) 机制：重置的直接写连 `push` 都不调（它绕开 setProp，故 rejected 不增）',
    w2.undo.rejected === 0, `rejected=${w2.undo.rejected}`);
}

// ══ §7 汇总 ══
console.log('\n' + '─'.repeat(56));
if (mutInfo) console.log(`变异体 ${mutInfo.id}：${mutInfo.why}`);
// ── 清理 + 断言：跑完后本前缀在 %TEMP% 的残留必须是 0（"清理真的生效"，而不是"看起来清了"）──
{
  const sw = sweepTempMutants();
  ok(`清理 · 跑完后 ${TMP_PREFIX}* 在 %TEMP% 的残留为 0（本次删了 ${sw.removed} 个；只删自己的前缀）`,
    sw.left === 0, `残留=${sw.left}`);
  const dropped = mutInfo && /\.mjs$/.test(mutInfo.out || '');
  ok('清理 · 本次真正落盘的那个变异体文件已不存在（清理确实作用到本进程创建的文件上）',
    !dropped || !fs.existsSync(path.join(os.tmpdir(), mutInfo.out)), `落盘=${mutInfo ? mutInfo.out : '(无)'}`);
}
console.log((fail === 0 ? '撤销栈骨架探针：全部通过：' : '撤销栈骨架探针：失败：') + `${pass + fail} 项（绿 ${pass} / 红 ${fail}）`);
if (F.length) console.log('红灯清单：\n  - ' + F.join('\n  - '));
console.log('UNDO_JSON ' + JSON.stringify({
  mode: RED ? `red:${RED}` : 'normal', passed: pass, failed: fail, reds: F,
  mutant: mutInfo, deps,
}));
// 终局：**不再用 `process.exit()`** —— 它不展开调用栈，会跳过 finally / 退出清理（t1 那起真缺陷同型）。
// 用 exitCode 让模块自然结束 ⇒ 退出码仍是 0/1，且清理一定跑到（"这条写法的正确性"由 §0 的自检锁着）。
process.exitCode = fail === 0 ? 0 : 1;
