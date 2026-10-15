// ══════════════════════════════════════════════════════════
// 内核生命周期探针 —— 证明「阶段 / 处置栈 / 四种 slot 派发 / 两级启停」是真的
//
//   node tools/kernel-lifecycle.mjs
//
// 为什么单独留一个：`tools/check.mjs` 用例只装它自己声明的那几个插件，
// 从不针对内核自身的流转做断言；而内核的流转（loading→active/failed、
// 拆干净、重载不翻倍）恰恰是 K2 清单与 K3 界面脚下的地基。
// 这里用合成插件把每条契约钉死，装真实器材插件的那两节用 src/equipment/electrical.js。
// ══════════════════════════════════════════════════════════

import { PluginHost, Registry } from '../src/core/plugin.js';
import { bus } from '../src/core/bus.js';
import { remove as eqRemove, bindRegistry } from '../src/equipment/registry.js';
import electrical from '../src/equipment/electrical.js';

const app = { services: {}, log: { push() {} }, toast() {} };

let pass = 0, fail = 0;
const ok = (cond, msg) => {
  if (cond) { pass++; console.log('  \x1b[32m✓\x1b[0m ' + msg); }
  else { fail++; console.log('  \x1b[31m✗\x1b[0m ' + msg); }
};
const head = (t) => console.log('\n\x1b[36m' + t + '\x1b[0m');

// ─────────────────────────────────────────────────────────
head('a. phase 的两条路径：loading→active 与 loading→failed');
{
  const host = new PluginHost(app, { quiet: true });
  const seen = {};
  const trace = [];
  bus.on('plugin:phase', (p) => trace.push(p));

  host.define({
    id: 't.ok', name: '好插件', kind: 'test',
    setup(ctx) {
      seen.entry = host.get('t.ok').phase;          // setup 执行中读自己
      seen.ownPhase = ctx.plugin.phase;
      ctx.equipment.define({ type: 't-ok-item' }, 't-ok-item');
      ctx.slot('t.a', () => 'ok');
      ctx.onDispose(() => { seen.disposing = host.get('t.ok').phase; });
    },
  });
  host.define({
    id: 't.bad', name: '坏插件', kind: 'test',
    setup(ctx) {
      seen.badEntry = host.get('t.bad').phase;
      ctx.equipment.define({ type: 't-bad-item' }, 't-bad-item');   // 半装：必须被回滚
      ctx.slot('t.b', () => 'bad');
      throw new Error('故意炸一个');
    },
  });

  host.installAll();
  const a = host.get('t.ok'), b = host.get('t.bad');
  const seqOf = (id) => trace.filter(p => p.id === id).map(p => p.phase).join('→');

  ok(seen.entry === 'loading' && seen.ownPhase === 'loading',
    `setup 执行中 phase=loading（record=${seen.entry}, ctx.plugin=${seen.ownPhase}）`);
  ok(a.phase === 'active' && a.installed === true && a.enabled === true && a.error === null,
    `成功路径 → phase=${a.phase} installed=${a.installed} enabled=${a.enabled} error=${a.error}`);
  ok(seqOf('t.ok') === 'loading→active', `事件序列 t.ok = ${seqOf('t.ok')}`);

  ok(seen.badEntry === 'loading', `坏插件 setup 执行中 phase=loading（${seen.badEntry}）`);
  ok(b.phase === 'failed' && b.error === '故意炸一个',
    `失败路径 → phase=${b.phase} error=${JSON.stringify(b.error)}`);
  ok(seqOf('t.bad') === 'loading→failed', `事件序列 t.bad = ${seqOf('t.bad')}`);

  ok(host.registry('equipment').has('t-bad-item') === false,
    `失败插件半装的注册表条目被回滚（has('t-bad-item')=${host.registry('equipment').has('t-bad-item')}）`);
  ok(host.slotItems('t.b').length === 0,
    `失败插件的插槽贡献被回滚（slotItems('t.b').length=${host.slotItems('t.b').length}）`);
  ok(b.contributions === 0, `失败插件贡献计数为 0（contributions=${b.contributions}）`);
  ok(host.stats().failed === 1, `stats().failed=${host.stats().failed}`);

  ok(a.contributions === 1 && host.registry('equipment').has('t-ok-item'),
    `成功插件注册表条目在（贡献=${a.contributions}）`);
  ok(host.slotItems('t.a').length === 1, `成功插件插槽条目在（${host.slotItems('t.a').length}）`);

  // 拆除时 phase 是 unloading，拆完回 pending
  host.uninstall('t.ok');
  ok(seen.disposing === 'unloading', `处置栈执行中 phase=${seen.disposing}`);
  ok(a.phase === 'pending' && a.installed === false && a.enabled === false && a.contributions === 0,
    `拆除后 phase=${a.phase} installed=${a.installed} enabled=${a.enabled} 贡献=${a.contributions}`);
  ok(seqOf('t.ok') === 'loading→active→unloading→pending', `完整序列 t.ok = ${seqOf('t.ok')}`);
  ok(host.slotItems('t.a').length === 0 && host.registry('equipment').has('t-ok-item') === false,
    `拆除后插槽与注册表条目都消失（slot=${host.slotItems('t.a').length}, eq=${host.registry('equipment').has('t-ok-item')}）`);
}

// ─────────────────────────────────────────────────────────
head('b. disable 真的把注册表条目拆下来，enable 真的装回来');
{
  const host = new PluginHost(app, { quiet: true });
  host.define(electrical);
  const id = electrical.id;
  const size = () => host.registry('equipment').size;

  ok(size() === 0, `声明未装时 registry('equipment').size=${size()}`);
  host.installAll();
  const afterInstall = size();
  ok(afterInstall > 0, `装载后 size=${afterInstall}`);

  host.disable(id);
  const afterDisable = size();
  ok(afterDisable === 0 && afterDisable < afterInstall,
    `disable('${id}') 后 size ${afterInstall} → ${afterDisable}（真的下降）`);
  const offRec = host.get(id);
  ok(offRec.phase === 'pending' && offRec.offBy === 'item' && offRec.installed === false,
    `记录：phase=${offRec.phase} offBy=${offRec.offBy} installed=${offRec.installed}`);

  host.enable(id);
  const afterEnable = size();
  ok(afterEnable === afterInstall,
    `enable('${id}') 后 size 回到原值 ${afterEnable} === ${afterInstall}`);
  const onRec = host.get(id);
  ok(onRec.phase === 'active' && onRec.offBy === null,
    `记录：phase=${onRec.phase} offBy=${onRec.offBy}`);

  // 停用层级：bundle 与 item 都要落在记录上
  host.disable(id, 'bundle');
  ok(host.get(id).offBy === 'bundle' && size() === 0,
    `disable(level='bundle') → offBy=${host.get(id).offBy} size=${size()}`);
  host.enable(id);
  ok(host.get(id).offBy === null && size() === afterInstall, `enable 清掉 offBy 并装回 size=${size()}`);

  // 重载：贡献计数与注册表条目不得重复累积
  const beforeReload = host.stats();
  host.reload(id);
  const afterReload = host.stats();
  ok(afterReload.equipment === beforeReload.equipment && afterReload.contributions === beforeReload.contributions,
    `reload 后 equipment ${beforeReload.equipment}→${afterReload.equipment}，contributions ${beforeReload.contributions}→${afterReload.contributions}（不翻倍）`);
  ok(host.get(id).phase === 'active' && host.get(id).contributions === beforeReload.contributions,
    `reload 后 phase=${host.get(id).phase} 单插件贡献=${host.get(id).contributions}`);

  // 无主条目（器材包那类运行时装进来的东西）不该被插件拆除误删
  host.registry('equipment').define({ type: 'no-owner' }, 'no-owner');
  host.uninstall(id);
  ok(host.registry('equipment').has('no-owner') && size() === 1,
    `无主条目在插件拆除后仍在（has('no-owner')=${host.registry('equipment').has('no-owner')}, size=${size()}）`);
  // 这里原先只写了一行 eqRemove('no-owner') —— 它是个**静默空操作**：
  // src/equipment/registry.js 的 target() = currentRegistry() || DEFAULT，探针里两者都是 null
  // （DEFAULT 要靠 main.js 的 bindRegistry 设置，探针从不调它），于是那次「摘掉」什么都没做，
  // 也从没有断言盯过它。现在改成直连宿主注册表，并把「真的摘掉了」补成断言。
  ok(host.registry('equipment').remove('no-owner') === true && size() === 0,
    `无主条目用直连注册表摘得掉（size=${size()}；原先那行 eqRemove 因未 bindRegistry 是空操作）`);
}

// ─────────────────────────────────────────────────────────
head('c. slot 四种派发：list / single / keyed / chain');
{
  const host = new PluginHost(app, { quiet: true });
  const kept = {};
  const mk = (id, body) => ({ id, name: id, kind: 'panel', setup: body });

  host.define(mk('p.list', (ctx) => {
    ctx.slot('t.list', () => 'L1', { order: 20 });
    ctx.slot('t.list', () => 'L2', { order: 10 });      // order 小的排前面
  }));
  host.define(mk('p.single', (ctx) => { ctx.slot('t.single', () => 'S1', { kind: 'single' }); }));
  host.define(mk('p.single2', (ctx) => { ctx.slot('t.single', () => 'S2', { kind: 'single' }); }));
  host.define(mk('p.keyed', (ctx) => {
    kept.keyed = ctx;
    ctx.slot('t.keyed', () => 'K1', { kind: 'keyed', key: 'k1' });
  }));
  host.define(mk('p.keyed2', (ctx) => {
    kept.keyed2 = ctx;
    ctx.slot('t.keyed', () => 'K1-of-p2', { kind: 'keyed', key: 'k1' });   // 同名 key，另一个插件
  }));
  host.define(mk('p.chain', (ctx) => {
    ctx.slot('t.chain', (v) => v + 1, { kind: 'chain', order: 10 });
    ctx.slot('t.chain', (v) => v * 2, { kind: 'chain', order: 20 });
    ctx.slot('t.chain', (v) => v - 3, { kind: 'chain', order: 30 });
  }));
  host.installAll();

  // list：既有行为逐位不变
  const listItems = host.slotItems('t.list');
  ok(listItems.length === 2 && listItems.map(e => e.render()).join(',') === 'L2,L1',
    `list 保留全部并按 order 排：${listItems.map(e => e.render()).join(',')}（${listItems.length} 条）`);
  ok(listItems.every(e => e.kind === 'list' && e.pluginId === 'p.list'),
    `list 条目标记 kind=${listItems[0].kind} pluginId=${listItems[0].pluginId}`);

  // single：同名只留最后一个
  const singleItems = host.slotItems('t.single');
  ok(singleItems.length === 1 && singleItems[0].render() === 'S2' && singleItems[0].pluginId === 'p.single2',
    `single 只留最后一个：length=${singleItems.length} 值=${singleItems[0].render()} 主人=${singleItems[0].pluginId}`);

  // keyed：同 key 原位替换，长度不增长
  // 这里故意在 setup 之外调用 ctx.slot —— 插件按数据变化重挂自己那个组件就是这条路径，
  // 归属必须仍然认得出是 p.keyed，否则替换失效、条目会一次一条地泄漏。
  const keyedBefore = host.slotItems('t.keyed').length;
  const seqBefore = host.slotItems('t.keyed').map(e => e.seq).join(',');
  kept.keyed.slot('t.keyed', () => 'K1-new', { kind: 'keyed', key: 'k1' });
  const keyedAfter = host.slotItems('t.keyed');
  ok(keyedAfter.length === keyedBefore && keyedBefore === 2,
    `keyed 同 key 替换后 length 不增长：${keyedBefore} → ${keyedAfter.length}`);
  ok(keyedAfter.map(e => e.seq).join(',') === seqBefore, `keyed 原位替换（seq 保持 ${seqBefore}）`);
  ok(keyedAfter[0].pluginId === 'p.keyed' && keyedAfter[0].render() === 'K1-new',
    `setup 之外调用 ctx.slot 仍归属自己：pluginId=${keyedAfter[0].pluginId} 值=${keyedAfter[0].render()}`);

  // chain：返回值确实串起来 ((5+1)*2)-3 = 9
  ok(host.runSlot('t.chain', 5) === 9, `chain 串联：runSlot('t.chain', 5) = ${host.runSlot('t.chain', 5)}（期望 9）`);
  ok(host.runSlot('t.list', 5) === 5, `渲染型插槽不参与串联：runSlot('t.list', 5) = ${host.runSlot('t.list', 5)}`);

  // d. 两个插件用同名 key 互不干扰
  const owners = host.slotItems('t.keyed').map(e => e.pluginId).sort();
  ok(host.slotItems('t.keyed').length === 2 && owners.join(',') === 'p.keyed,p.keyed2',
    `两个插件同名 key 互不干扰：${owners.join(' , ')}`);

  // d. 拆除后它的 slot 条目从 slotItems() 消失
  host.uninstall('p.keyed');
  const afterTear = host.slotItems('t.keyed');
  ok(afterTear.length === 1 && afterTear[0].pluginId === 'p.keyed2',
    `p.keyed 拆除后 slotItems('t.keyed')=${afterTear.length} 条，剩下 ${afterTear[0] && afterTear[0].pluginId}`);
  host.uninstall('p.single2');
  ok(host.slotItems('t.single').length === 0, `p.single2 拆除后 slotItems('t.single').length=${host.slotItems('t.single').length}`);
  host.uninstall('p.chain');
  ok(host.slotItems('t.chain').length === 0 && host.runSlot('t.chain', 5) === 5,
    `p.chain 拆除后 chain 条目清空且 runSlot 变成恒等（=${host.runSlot('t.chain', 5)}）`);
  ok(host.slotNames().filter(n => n === 't.list').length === 1, `list 插槽仍在：${host.slotNames().join(' ')}`);

  // 重载同样不得让插槽条目翻倍：拆干净 → 重新 setup 应回到同一长度
  const before = host.slotItems('t.list').length;
  host.reload('p.list');
  ok(host.slotItems('t.list').length === before && before === 2,
    `reload 后 slotItems('t.list') 长度 ${before} → ${host.slotItems('t.list').length}（不翻倍）`);
}

// ─────────────────────────────────────────────────────────
head('d*. 两级启停表：Map 是标准形态，旧 Set 仍然能收');
{
  const host = new PluginHost(app, { quiet: true });
  host.define(electrical);
  host.define({ id: 't.other', name: '另一个', kind: 'panel', setup() {} });

  host.installAll(new Map([[electrical.id, 'bundle']]));
  const r1 = host.get(electrical.id);
  ok(r1.offBy === 'bundle' && r1.phase === 'pending' && r1.installed === false,
    `Map 停用表：offBy=${r1.offBy} phase=${r1.phase} installed=${r1.installed}`);
  ok(host.registry('equipment').size === 0, `被停用的包没往注册表写东西（size=${host.registry('equipment').size}）`);
  ok(host.get('t.other').phase === 'active', `未列进表的插件照装：t.other phase=${host.get('t.other').phase}`);
  ok(host.stats().disabled === 1 && host.stats().skipped === 1,
    `stats(): disabled=${host.stats().disabled} skipped=${host.stats().skipped} installed=${host.stats().installed}/${host.stats().total}`);

  const h2 = new PluginHost(app, { quiet: true });
  h2.define(electrical);
  h2.installAll(new Set([electrical.id]));      // 旧签名
  ok(h2.get(electrical.id).offBy === 'item' && h2.get(electrical.id).phase === 'pending',
    `旧 Set 签名当单项停用：offBy=${h2.get(electrical.id).offBy} phase=${h2.get(electrical.id).phase}`);
  ok(h2.stats().equipment === 0, `停用后 equipment=${h2.stats().equipment}`);

  // 冻结契约：每条记录都带这两个字段（K2 用 'offBy' in rec 判定契约是否落地）
  const rec = h2.get(electrical.id);
  ok('phase' in rec && 'offBy' in rec, `记录上有 phase/offBy 自有字段：phase=${rec.phase} offBy=${rec.offBy}`);
}

// ─────────────────────────────────────────────────────────
head('e. 真实的全套 23 个插件：在 DOM 替身下 0 失败（阶段证据见 a 的等价关系）');
{
  // 真实插件里有 5 个要 DOM（ui.* / system.desktop / rules.damage / system.credit），
  // 所以这里必须借 guard-plugins.mjs 的 DOM 替身跑独立进程 —— 也正是 check.mjs §⑪ 的做法。
  // 借来的不只是「装得上」：a 节已证 setup 成功 ⟺ phase=active，两条合起来即
  // 「真实 23 个插件全部停在 active」。
  const { execFileSync } = await import('node:child_process');
  let out = '';
  try {
    out = execFileSync(process.execPath, ['tools/guard-plugins.mjs', '--quiet'], {
      cwd: new URL('..', import.meta.url), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) { out = String(err.stdout || '') + String(err.stderr || ''); }
  const m = out.match(/GUARD_JSON (\{.*\})/);
  const g = m ? JSON.parse(m[1]) : null;
  ok(!!g, g ? '守卫在独立进程里回报了结果' : '守卫没有产出 GUARD_JSON');
  if (g) {
    ok(g.failed === 0 && (g.failures || []).length === 0 && g.installed === g.total,
      `${g.installed}/${g.total} 个真实插件装载成功，失败 ${g.failed} 个（贡献 ${g.stats && g.stats.contributions} 条）`);
    ok(g.total >= 23 && g.pluginCount === g.total, `插件总数 ${g.total}，与 main.js 导出名单一致=${g.pluginCount}`);
    ok(g.interaction && g.interaction.enabled === true && !g.interaction.error,
      `xiaomo.ui.interaction enabled=${g.interaction && g.interaction.enabled} error=${g.interaction && g.interaction.error}`);
  }
}

// ─────────────────────────────────────────────────────────
head('f. 注册表的移除路径也发通知（投影型界面的唯一信号源）');
{
  // 实测背景：运行时卸载器材包 → 注册表 56 条而器材栏 57 行，残留 1 行陈旧器材。
  // 链路是 Registry.remove() 不跑 _subs；而器材栏这类「注册表投影」只有这一个信号源
  // （卸器材包不卸载 system.pack 本身，清单 onChange 也不推），所以移除路径必须发通知，
  // 且只在真的变了的时候发（多余推送＝投影无谓重算）。
  const reg = new Registry('test', (v) => v && v.id);
  const seen = [];
  const off = reg.onChange((v, k) => seen.push({ v: v === null ? null : (v && v.id), k, size: reg.size }));

  reg.define({ id: 'a' });
  ok(seen.length === 1 && seen[0].v === 'a' && seen[0].k === 'a',
    `define 仍只推一次、且带 (value, id)：${JSON.stringify(seen[0])}`);
  ok(seen[0].size === 1, `define 的回调里读到的是写入之后的状态：size=${seen[0].size}`);

  reg.define({ id: 'b' }, 'b', 'owner-1');
  reg.define({ id: 'c' }, 'c', 'owner-1');
  reg.define({ id: 'd' }, 'd', 'owner-1');
  seen.length = 0;

  ok(reg.remove('a') === true && seen.length === 1,
    `remove('a') 推一次通知（通知 ${seen.length} 次）`);
  ok(seen.length === 1 && seen[0].v === null && seen[0].k === 'a' && seen[0].size === 3,
    `移除通知带 (null, 'a')，回调里读到的是移除之后的状态：${JSON.stringify(seen[0])}`);

  seen.length = 0;
  ok(reg.remove('nope') === false && seen.length === 0,
    `remove 一个不存在的 key 不推通知（通知 ${seen.length} 次）—— 投影不该被无谓重算`);

  seen.length = 0;
  const n2 = reg.removeByOwner('owner-1');
  ok(n2 === 3 && seen.length === 1,
    `removeByOwner 批量摘 ${n2} 条只推一次通知（通知 ${seen.length} 次）—— 逐条推会把界面推进中间态`);
  ok(seen.length === 1 && seen[0].k === null && seen[0].size === 0,
    `批量移除通知带 (null, null)，回调里读到的是摘干净之后的状态：${JSON.stringify(seen[0])}`);

  seen.length = 0;
  ok(reg.removeByOwner(null) === 0 && seen.length === 0,
    `removeByOwner(null) 一条都不摘、也不推通知（通知 ${seen.length} 次）`);

  reg.define({ id: 'x' });
  reg.define({ id: 'y' });
  seen.length = 0;
  reg.clear();
  ok(seen.length === 1 && seen[0].size === 0,
    `clear() 推一次通知，回调里读到的是已清空的状态：${JSON.stringify(seen[0])}`);

  seen.length = 0;
  reg.clear();
  ok(seen.length === 0, `clear() 一个空注册表不推通知（通知 ${seen.length} 次）`);

  // 重入：订阅者在自己的回调里退订，本轮其余订阅者不该被漏掉（_subs.slice() 的意义）
  const order = [];
  const offA = reg.onChange(() => { order.push('A'); offA(); });
  const offB = reg.onChange(() => order.push('B'));
  reg.define({ id: 'z' });
  ok(order.join(',') === 'A,B', `订阅者在回调里退订不影响本轮其余订阅者：本轮顺序 ${order.join(',')}`);
  offB(); off();

  // 真实接缝：卸器材包走的就是 src/equipment/registry.js 的 remove()，
  // 而它需要 main.js 那样的 bindRegistry() 才是活的（否则 target() 为 null，静默空操作）
  const host2 = new PluginHost(app, { quiet: true });
  host2.define({ id: 't.eq', name: '器材包', kind: 'test',
    setup(ctx) { ctx.equipment.define({ type: 't-eq-item' }, 't-eq-item'); } });
  host2.installAll();
  const eqReg = host2.registry('equipment');
  bindRegistry(eqReg);
  let hits = 0, sizeInCb = -1;
  eqReg.onChange(() => { hits++; sizeInCb = eqReg.size; });
  const beforeSize = eqReg.size;
  const gone = eqRemove('t-eq-item');
  ok(gone === true && hits === 1 && sizeInCb === beforeSize - 1,
    `src/equipment/registry.js 的 remove() 能把信号送到订阅者：hits=${hits}，回调里 size ${beforeSize}→${sizeInCb}`);
}

console.log(`\n${'─'.repeat(56)}`);
if (fail === 0) console.log(`\x1b[32m内核生命周期探针全部通过：${pass} 项\x1b[0m`);
else console.log(`\x1b[31m通过 ${pass} 项，失败 ${fail} 项\x1b[0m`);
process.exit(fail === 0 ? 0 : 1);
