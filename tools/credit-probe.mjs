// ══════════════════════════════════════════════════════════
// 无头验收：学分系统（娱乐）—— 给用户手写的四条需求补「能红」的独立证据
//
//   node server.mjs                  # 另开一个终端（静态服务，默认 7373；已在跑就别重复起）
//   node tools/credit-probe.mjs      # 全过 exit 0，有失败 exit 1，跑不起来 exit 2
//
// 为什么要有它：用户手写的学分需求有四条，其中三条**实现都在、一条证据都没有**。
//   ① 正确做实验就加学分（且同一成就只加一次）  system.credit.js:17-44 成就表 / :66 this.earned += n
//   ② 学分归零 →「你被管理员踢出了实验室」      :75-79 penalty→expel / :294-306 管理员弹窗
//   ③ 重启之后一切复原（不落盘、不追责）        :96-109 reset(hard) / 冷启动后学分回满
//   ④ 设置里关掉后不再计分（加与扣都不再发生）  ui.settings.js:115-131 的学分开关
// 源码里有一行不算数：用户手写的需求必须有能复跑、且**能红**的证据。
//
// 红测（证明这些断言真的挂在实现上 —— 而且**一个文件都不改**）：
//   XM_CREDIT_SABOTAGE=award  node tools/credit-probe.mjs   # 运行时把 award 旁路成空操作
//   XM_CREDIT_SABOTAGE=expel  node tools/credit-probe.mjs   # 运行时把 expel 旁路掉
//   XM_CREDIT_SABOTAGE=reset  node tools/credit-probe.mjs   # 运行时把 reset 旁路掉
// 手法是在页面 realm 里改**运行中对象的原型方法**，跑完即弃。源文件一个字节都不动，
// 所以不存在「改完忘了还原」的风险 —— 这是本轮与 pack-probe 红测（临时改文件再还原）的关键差异。
//
// 文案差异（只报不改，见回报）：实现 :301 是「你被**实验室**管理员踢出了实验室」，
// 用户原话是「你被管理员踢出了实验室」。本探针**逐字断言实现现状**并把差异写进 extra，
// 将来文案若变了这条会红，差异不会被悄悄吞掉。
//
// 做法：Node 内置 WebSocket 直接说 CDP，起无头 Edge（无窗口、--mute-audio 静音、临时 profile
// 用完即删、cache-buster 冷加载），断言跑在页面自己的 realm 里 —— 校验真实页面、真实 tick、
// 真实事件。不用 puppeteer/playwright：零新依赖是本项目的硬约束。
//
// 时序（同 settings-probe，踩过坑别改回去）：启动参数只给 about:blank，真页面一律
// Page.navigate 显式导航，之后轮询「location.search 正好是本段标记 && readyState === complete」
// 才注入断言。把 http URL 直接写进启动参数会被跨进程导航销毁执行上下文（-32000）。
//
// 起点的铺垫（都是应用自己的公开方法）：每次断言前用 world.clear()+clearWires()+credit.reset(false)
// 把实验台与成就表清成空场景，之后每一次加分/扣分都走**真实操作路径**（放器材、连线、短路烧毁）。
// ══════════════════════════════════════════════════════════

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ORIGIN = process.env.XM_ORIGIN || 'http://127.0.0.1:7373';
const PORT = Number(process.env.XM_CDP_PORT || 9356);
const SABOTAGE = process.env.XM_CREDIT_SABOTAGE || '';
const CANDIDATES = [
  process.env.EDGE_BIN,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/microsoft-edge',
  '/usr/bin/google-chrome',
].filter(Boolean);
const EDGE = CANDIDATES.find((p) => existsSync(p));
const TS = Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 注入页面 realm 执行的工具与断言 ───────────────────────
// ⚠ 这段是外层模板字符串的内容：里面不许出现反引号与 ${，否则会提前截断。
const HELPERS = `
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const R = [];
const chk = (ok, label, extra) => R.push({ ok: !!ok, label, extra: extra === undefined ? null : extra });
/** 等一个状态出现，比睡固定毫秒稳：动效、电路求解、成就 tick 的耗时都随机器变 */
async function waitFor(fn, timeout = 5000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { if (fn()) return true; } catch (e) { /* 状态还没到 */ }
    await sleep(40);
  }
  return false;
}
async function ready(timeout = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (window.xiaomo && window.xiaomo.host && window.xiaomo.world && document.querySelector('#btnSettings')) {
      await sleep(600);                    // 让开机那几拍 tick 先跑完（成就是在 tick 里发的）
      return window.xiaomo;
    }
    await sleep(100);
  }
  throw new Error('引导未完成：等不到 window.xiaomo.host / #btnSettings');
}
const d = document;
const badge = () => d.querySelector('#topbar .credit-badge');
const badgeText = () => { const b = badge(); return b ? b.querySelector('.credit-num').textContent : null; };
const achCards = () => [...d.querySelectorAll('.ach-fx-name')].map(n => n.textContent);
const expelMask = () => d.querySelector('.expel-mask');
const expelShown = () => { const m = expelMask(); return !!(m && m.classList.contains('show')); };
const drawerOpen = () => { const dr = d.querySelector('.drawer[aria-label="设置"]'); return !!(dr && dr.closest('.drawer-mask').classList.contains('show')); };
async function openDrawer() {
  const b = d.querySelector('#btnSettings');
  b.focus();                               // 真实鼠标点击会把按钮设成焦点，合成 .click() 不会
  b.click();
  await waitFor(drawerOpen, 3000);
}
/** 学分开关：按 id 精确定位（抽屉里还有一个「大屏可读模式」开关，别点错） */
const creditSwitch = () => d.querySelector('#setRowCredit .plug-switch');
/** 把实验台与成就表清成空场景 —— 只作**起点铺垫**，都是应用自己的公开方法 */
function cleanSlate(app) {
  app.world.clear();
  if (app.clearWires) app.clearWires();
  if (app.data && app.data.clear) app.data.clear();
  app.credit.reset(false);                 // 只清学分，不动场景（场景刚被清空）
}
/** 真实加分路径之一：放两件器材 + 用界面建线的同一个入口连一根线 */
function firstWireDrive(app) {
  const b = app.addEntity('battery', 320, 200);
  const l = app.addEntity('lamp', 540, 200);
  if (!b || !l) return { err: 'addEntity 返回空' };
  return { battery: b.type, lamp: l.type, wire: !!app.world.connect({ e: b.id, p: 1 }, { e: l.id, p: 0 }, 'wire') };
}
/** 真实加分路径之二：让物理器材与化学器材同时出现在实验台上 */
function twoDomainDrive(app, chemType) {
  const p = app.addEntity('battery', 320, 200);
  const c = chemType ? app.addEntity(chemType, 560, 200) : null;
  return { physics: p && p.type, chemistry: c && c.type, chemType: chemType };
}
/** 真实事故：12V 干电池 + 闭合开关直接短接（world.connect 是界面建线的同一个入口） */
function shortCircuit(app) {
  const bat = app.addEntity('battery', 400, 200);
  const sw = app.addEntity('switch', 620, 200);
  if (!bat || !sw) return { err: 'addEntity 返回空' };
  bat.setProp('emf', 12);
  const w1 = !!app.world.connect({ e: bat.id, p: 1 }, { e: sw.id, p: 0 }, 'wire');
  const w2 = !!app.world.connect({ e: sw.id, p: 1 }, { e: bat.id, p: 0 }, 'wire');
  sw.toggle();
  if (!app.world.running) app.toggleRun();
  return { bat, sw, w1, w2 };
}
/** 学分/损坏事件记录器：能收到事件才说明拿到的是应用同一份 bus 模块实例（自检） */
async function busRec() {
  const mod = await import('/src/core/bus.js');
  const log = [];
  const offs = [
    mod.bus.on('credit:changed', (e) => log.push({ t: 'changed', value: e.value, delta: e.delta, why: e.why })),
    mod.bus.on('credit:expelled', (e) => log.push({ t: 'expelled', lost: e.lost, reason: e.reason })),
    mod.bus.on('equipment:broken', (e) => log.push({ t: 'broken', reason: e && e.reason, cost: e && e.cost })),
  ];
  return { log, off: () => offs.forEach(f => { try { f(); } catch (e) { /* 已解绑 */ } }) };
}
/** 红测：运行时旁路（只改内存里的原型方法，不碰任何文件） */
function sabotage(app, kind) {
  const P = Object.getPrototypeOf(app.credit);
  if (kind === 'award') { P.award = function () { /* 旁路：不加分 */ }; return 'award'; }
  if (kind === 'expel') { P.expel = function () { /* 旁路：不踢人 */ }; return 'expel'; }
  if (kind === 'reset') { P.reset = function () { /* 旁路：不复原 */ }; return 'reset'; }
  return null;
}
`;

const SCRIPT_A = `(async () => { ${HELPERS}
  const SABOTAGE = ${JSON.stringify(SABOTAGE)};
  const app = await ready();
  const sab = sabotage(app, SABOTAGE);

  // ── ① 起点：把开机状态原样记录下来（成就是 tick 里发的，开机可能已经解锁过几项）──
  const boot = {
    value: app.credit.value, max: app.credit.max, earned: app.credit.earned, lost: app.credit.lost,
    unlocked: [...app.credit.unlocked.keys()], badge: badgeText(),
    entities: app.world.entities.length, wires: app.world.wires.length, sabotage: sab || '无',
  };
  chk(app.credit.value === 100 && app.credit.expelled === false && badgeText() === '100',
    '① 起点：学分满值 100、徽章在位、未被踢出', boot);
  const chemDef = app.host.registry('equipment').list().find(x => x.domain === 'chemistry');
  chk(!!chemDef, '① 找到一个化学域器材用作「理化同台」的驱动件（找不到这条链就断了）',
    { 化学域器材: chemDef ? chemDef.type : null });

  // ── ② 正确做实验就加分（真实路径：放器材 + 连线）──
  cleanSlate(app);
  await sleep(1500);   // 先让「清空后仍然成立的条件」跑完（如 lastCircuit 的残留），起点取稳定值
  const base = { earned: app.credit.earned, unlocked: [...app.credit.unlocked.keys()], value: app.credit.value };
  const rec = await busRec();
  const drove = firstWireDrive(app);
  const got = await waitFor(() => app.credit.earned > base.earned, 5000);
  const after = {
    earned: app.credit.earned, delta: app.credit.earned - base.earned, value: app.credit.value,
    unlocked: [...app.credit.unlocked.keys()], history: app.credit.history.length,
    why: app.credit.history[0] && app.credit.history[0].why, 驱动: drove,
  };
  chk(got && after.delta === 3 && after.unlocked.indexOf('first-wire') >= 0,
    '② 正确做实验就加分：放电池+灯泡并连一根线 → 解锁「第一次连线」+3（累计获得 ' + base.earned + '→' + after.earned + '）',
    { 起点: base, 实测: after });
  chk(after.why === '达成「第一次连线」', '② 加分原因字符串逐字可读', { why: after.why });
  chk(await waitFor(() => achCards().indexOf('第一次连线') >= 0, 3000),
    '② 用户看得见：成就浮层出现，卡片上写着「第一次连线」与「+3 学分」',
    { 卡片: achCards(), 徽章: badgeText() });
  chk(badgeText() === '100',
    '② 徽章仍是 100：加分在满值处封顶 —— 加分只在「累计获得」与成就浮层里可见（如实记录，见回报）',
    { 徽章: badgeText(), value: app.credit.value, max: app.credit.max, earned: app.credit.earned });
  chk(!!rec.log.find(e => e.t === 'changed' && e.delta === 3),
    '② 加分真的走了 bus：credit:changed 带 delta=+3（同时自检：收不到事件就说明探针拿到的不是同一份模块）',
    { 事件: rec.log.filter(e => e.t === 'changed') });

  // ── ③ 同一个成就只加一次（条件仍成立，再跑 3 拍 tick）──
  const stillTrue = app.world.wires.length >= 1;
  await sleep(1300);
  const dupe = {
    earned: app.credit.earned, unlocked: app.credit.unlocked.size, history: app.credit.history.length,
    条件仍成立: stillTrue, 原因流水: app.credit.history.map(h => h.why).slice(0, 4),
  };
  chk(stillTrue && dupe.earned === after.earned && dupe.unlocked === after.unlocked.length && dupe.history === after.history,
    '③ 同一个成就只加一次：条件仍成立（不是条件失效造成的假通过），再跑 3 拍 tick 后累计获得/解锁数/流水条数都不变',
    { 第一次: { earned: after.earned, unlocked: after.unlocked.length, history: after.history }, 再等三拍: dupe });

  // ── ④ 归零 → 踢出（真实扣分路径：短路烧毁干电池，扣分由 rules.damage 抛事件）──
  const drain = { from: app.credit.value, lostFrom: app.credit.lost, rounds: 0, seq: [] };
  let prev = app.credit.value;
  while (app.credit.value > 0 && drain.rounds < 20) {
    drain.rounds++;
    const c = shortCircuit(app);
    await waitFor(() => c.bat && c.bat.state.broken === true, 6000);
    await waitFor(() => app.credit.value < prev, 3000);
    prev = app.credit.value;
    drain.seq.push(prev);
    app.world.clear(); app.clearWires();
    await sleep(120);
  }
  drain.to = app.credit.value; drain.lost = app.credit.lost; drain.expelled = app.credit.expelled;
  chk(drain.to === 0 && drain.expelled === true,
    '④ 真实扣分能把学分扣到 0：短路 ' + drain.rounds + ' 次，value ' + drain.from + '→0、累计扣除 ' + drain.lost + '、expelled=true',
    { 每轮剩余: drain.seq, 累计扣除: drain.lost });

  const shown = expelShown() || await waitFor(expelShown, 3000);
  chk(shown, '④ 学分归零即被踢出：管理员弹窗出现（.expel-mask.show）',
    { 弹窗: !!expelMask(), 类名: expelMask() && expelMask().className });
  const h2 = expelMask() ? expelMask().querySelector('h2').textContent.trim() : null;
  chk(h2 === '你被实验室管理员踢出了实验室', '④ 弹窗标题逐字：' + h2,
    { 实测: h2, 用户原话: '你被管理员踢出了实验室', 差异: '实现多了「实验室」三个字（只报不改，见回报）' });
  const sub = expelMask() ? expelMask().querySelector('.expel-sub').textContent.trim() : null;
  chk(sub === '学分已经扣完。重启实验室后，学分与实验进度会全部复原。',
    '④ 副标题逐字（它同时是「重启复原」对用户的承诺）', { 实测: sub });
  const statsTxt = expelMask() ? expelMask().querySelector('.expel-stats').textContent.replace(/\\s+/g, ' ').trim() : null;
  chk(!!statsTxt && statsTxt.indexOf('+' + app.credit.earned) >= 0 && statsTxt.indexOf('-' + app.credit.lost) >= 0,
    '④ 统计行给出真实数字：累计获得 +' + app.credit.earned + ' / 累计扣除 -' + app.credit.lost + ' / 解锁成就 ' + app.credit.unlocked.size,
    { 统计行: statsTxt });
  const btnTxt = expelMask() ? expelMask().querySelector('.expel-btn').textContent.trim() : null;
  chk(btnTxt === '重新进入实验室', '④ 按钮写着「重新进入实验室」', { 实测: btnTxt });

  // ── ④b 被踢出去之后不再计分（这一条要求一个新的、还没达成的成就条件）──
  const outDrive = { name: '理化同台', credit: 6, drive: () => twoDomainDrive(app, chemDef && chemDef.type) };
  const outReady = app.world.ofDomain('physics').length > 0 === false || app.world.ofDomain('chemistry').length === 0;
  const out0 = { earned: app.credit.earned, unlocked: app.credit.unlocked.size, lost: app.credit.lost };
  const outDrove = outDrive.drive();
  await sleep(1300);
  const out1 = { earned: app.credit.earned, unlocked: app.credit.unlocked.size, lost: app.credit.lost };
  chk(!!chemDef && outReady && out1.earned === out0.earned && out1.unlocked === out0.unlocked,
    '④ 踢出后不再加分：此时达成「' + outDrive.name + '」的条件，累计获得与解锁数不变（阳性对照见 ⑤b）',
    { 前: out0, 后: out1, 驱动: outDrove });
  const c2 = shortCircuit(app);
  await waitFor(() => c2.bat && c2.bat.state.broken === true, 6000);
  await sleep(400);
  chk(app.credit.lost === out0.lost && app.credit.value === 0,
    '④ 踢出后不再扣分：又烧坏一件器材，累计扣除仍是 ' + app.credit.lost + '、学分仍是 0',
    { 损坏: c2.bat && c2.bat.state.broken, lost: app.credit.lost, value: app.credit.value });

  // ── ⑤ 点「重新进入实验室」= 应用内复原（reset(true)），逐项给前后数值 ──
  const before = {
    value: app.credit.value, earned: app.credit.earned, lost: app.credit.lost, expelled: app.credit.expelled,
    unlocked: app.credit.unlocked.size, entities: app.world.entities.length, wires: app.world.wires.length,
    broken: app.world.entities.filter(e => e.state && e.state.broken).length,
  };
  expelMask().querySelector('.expel-btn').click();
  await waitFor(() => !expelShown(), 4000);
  const restored = {
    value: app.credit.value, earned: app.credit.earned, lost: app.credit.lost, expelled: app.credit.expelled,
    unlocked: app.credit.unlocked.size, entities: app.world.entities.length, wires: app.world.wires.length,
    broken: app.world.entities.filter(e => e.state && e.state.broken).length, mask: expelShown(),
  };
  chk(restored.value === 100 && restored.earned === 0 && restored.lost === 0 && restored.expelled === false && restored.unlocked === 0,
    '⑤ 应用内复原：学分 ' + before.value + '→100、累计获得 ' + before.earned + '→0、累计扣除 ' + before.lost
      + '→0、成就 ' + before.unlocked + '→0、expelled true→false',
    { 前: before, 后: restored });
  chk(restored.entities === 0 && restored.wires === 0 && restored.broken === 0 && restored.mask === false,
    '⑤ 场景清空、损坏器材归零（' + before.broken + ' 件损坏 → 0 件）、弹窗已关闭',
    { 前: { 器材: before.entities, 导线: before.wires, 损坏: before.broken },
      后: { 器材: restored.entities, 导线: restored.wires, 损坏: restored.broken, 弹窗: restored.mask } });
  const earned1 = app.credit.earned;
  const backDrove = outDrive.drive();
  const gotBack = await waitFor(() => app.credit.earned > earned1, 5000);
  chk(gotBack && app.credit.earned - earned1 === outDrive.credit,
    '⑤ 反向对照（让 ④b 不是空断言）：复原后同一个「' + outDrive.name + '」条件立刻加分 ' + earned1 + '→' + app.credit.earned,
    { 驱动: backDrove, delta: app.credit.earned - earned1, 原因: app.credit.history[0] && app.credit.history[0].why });

  // ── ⑥ 设置里关掉后不再计分（加分侧；扣分侧的等价证据在 settings-probe ③c）──
  cleanSlate(app);                          // 空实验台 + 空成就表：等下同一个条件要能一键对照
  await sleep(1500);
  await openDrawer();
  const sw0 = creditSwitch();
  chk(!!sw0 && sw0.getAttribute('aria-checked') === 'true', '⑥ 设置抽屉里学分开关在「开」位（按 #setRowCredit 精确定位，不是旁边那个大屏开关）',
    { aria: sw0 && sw0.getAttribute('aria-checked'), 行: !!d.querySelector('#setRowCredit') });
  const changedOff0 = rec.log.filter(e => e.t === 'changed').length;
  const cardsOff0 = achCards().length;
  creditSwitch().click();
  const off = await waitFor(() => badgeText() === null && !app.credit, 4000);
  chk(off, '⑥ 关掉后：徽章消失、app.credit 不再是可用对象',
    { 徽章: badgeText(), credit: app.credit === null ? 'null' : String(app.credit) });
  const offDrove = firstWireDrive(app);     // 达成「第一次连线」的条件（此刻整条计分链路已被拆掉）
  await sleep(1500);
  const changedOff1 = rec.log.filter(e => e.t === 'changed').length;
  // 判据按**成就名**比，不按浮层数量比：浮层 3.6s 后自己消失，数量会在等待期间变，那是探针的坑不是产品的问题
  chk(app.credit === null && achCards().indexOf('第一次连线') < 0 && changedOff1 === changedOff0,
    '⑥ 关掉后**不加分**：达成「第一次连线」的条件也不弹成就浮层、没有 credit:changed 事件',
    { credit: app.credit === null ? 'null' : String(app.credit), 浮层: achCards(), 关前浮层数: cardsOff0,
      事件数: changedOff0 + '→' + changedOff1, 驱动: offDrove });
  const broke0 = rec.log.filter(e => e.t === 'broken').length;
  const c3 = shortCircuit(app);
  await waitFor(() => c3.bat && c3.bat.state.broken === true, 6000);
  await sleep(300);
  const broke1 = rec.log.filter(e => e.t === 'broken').length;
  chk(c3.bat && c3.bat.state.broken === true && broke1 > broke0 && !app.credit,
    '⑥ 关掉的是「计分」不是「损坏」：电池照样被烧坏（bus 收到 equipment:broken），只是没有学分对象可扣',
    { 损坏: c3.bat && c3.bat.state.broken, broken事件: broke0 + '→' + broke1, credit: app.credit === null ? 'null' : String(app.credit) });
  creditSwitch().click();                   // 拨回来（开关一拨会重渲染 overlay，节点已换新 → 重新查）
  const onAgain = await waitFor(() => badgeText() !== null && !!app.credit && app.credit.value === 100, 5000);
  const earned2 = app.credit ? app.credit.earned : -1;
  const awarded = await waitFor(() => app.credit && app.credit.earned > earned2, 5000);
  chk(onAgain && awarded && app.credit.earned >= 3,
    '⑥ 反向对照：一拨回来，**同一个**「第一次连线」条件立刻加分（' + earned2 + '→' + app.credit.earned + '）'
      + ' —— 证明 ⑥ 的沉默是开关造成的，不是条件失效',
    { 徽章: badgeText(), value: app.credit.value, earned: app.credit.earned, 原因: app.credit.history[0] && app.credit.history[0].why,
      aria: creditSwitch() && creditSwitch().getAttribute('aria-checked') });

  // ── ⑦ 给冷启动留个现场：再烧坏器材、让学分掉下来、留下已解锁成就 ──
  if (drawerOpen()) { const x = d.querySelector('.drawer[aria-label="设置"] .drawer-x'); if (x) x.click(); await sleep(400); }
  const c4 = shortCircuit(app);
  await waitFor(() => c4.bat && c4.bat.state.broken === true, 6000);
  await sleep(400);
  const pre = {
    value: app.credit.value, earned: app.credit.earned, lost: app.credit.lost, expelled: app.credit.expelled,
    unlocked: app.credit.unlocked.size, entities: app.world.entities.length,
    broken: app.world.entities.filter(e => e.state && e.state.broken).length,
    plugStateCreditOn: (localStorage.getItem('xiaomo.plugins.state.v1') || '').indexOf('"xiaomo.system.credit":true') >= 0,
    pre: true,                       // 给 Node 端认领：B 段要拿这些数当「重启前」的对照
  };
  chk(pre.broken >= 1 && pre.value < 100 && pre.unlocked >= 1,
    '⑦ 冷启动前故意留现场：学分 ' + pre.value + '/100、损坏器材 ' + pre.broken + ' 件、已解锁成就 ' + pre.unlocked + ' 项',
    pre);
  rec.off();
  return R;
})()`;

/** B 段：换 URL 真冷启动（同一 profile → localStorage 还在），逐项核对「重启一切复原」 */
const scriptB = (pre) => `(async () => { ${HELPERS}
  const app = await ready();
  const boot = {
    value: app.credit.value, max: app.credit.max, earned: app.credit.earned, lost: app.credit.lost,
    expelled: app.credit.expelled, unlocked: app.credit.unlocked.size, badge: badgeText(),
    entities: app.world.entities.length, broken: app.world.entities.filter(e => e.state && e.state.broken).length,
    mask: expelShown(),
    lsAlive: !!localStorage.getItem('xiaomo.plugins.state.v1'),
    lsCreditOn: (localStorage.getItem('xiaomo.plugins.state.v1') || '').indexOf('"xiaomo.system.credit":true') >= 0,
    说明: 'earned/unlocked 非 0 是开机 tick 按预设场景重新发的分（新累积）；「不落盘」的判据是 lost=0 与 0 件损坏器材',
  };
  chk(boot.value === 100 && boot.lost === 0 && boot.expelled === false && boot.badge === '100',
    '⑦ 冷启动后学分是全新的：value 100（重启前 ${pre.value}）、累计扣除 0（重启前 ${pre.lost}）、未被踢出、徽章 100',
    boot);
  chk(boot.broken === 0 && boot.mask === false,
    '⑦ 冷启动后没有任何损坏器材（重启前 ${pre.broken} 件）、没有踢出弹窗',
    { 损坏: boot.broken, 弹窗: boot.mask, 器材: boot.entities });
  chk(boot.lsAlive && boot.lsCreditOn,
    '⑦ 对照（让上面两条不是空断言）：同一 profile 下 localStorage 确实活着、学分开关仍是「开」'
      + ' —— 所以「学分归零」不是刷新把存储丢了，而是学分真的不落盘',
    { 插件状态键还在: boot.lsAlive, 学分仍为开: boot.lsCreditOn });
  return R;
})()`;

// ── CDP 客户端（Node 内置 WebSocket，零依赖）──────────────
function connect(url) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(url);
    ws.addEventListener('open', () => res(ws), { once: true });
    ws.addEventListener('error', () => rej(new Error('WebSocket 连接失败')), { once: true });
  });
}

async function cdpAlive() {
  try { return (await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok; } catch { return false; }
}
/** fail-fast（task-42）：静态服务不在就立刻说清 —— 否则要白等 30 s 导航超时，提示还会指向 CDP 端口 */
async function originAlive() {
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 2000);
    await fetch(`${ORIGIN}/index.html`, { signal: ac.signal });   // 任何 HTTP 响应都算「服务在」（不管 404）
    clearTimeout(t);
    return true;
  } catch { return false; }
}

/** CDP 报错说人话：哪一步、原始错误、常见成因，一次说全 */
function explain(step, err) {
  const raw = err && err.message ? err.message : String(err);
  const lines = [`探针在「${step}」这一步失败：${raw}`];
  if (/-32000|Execution context was destroyed|Cannot find context|No frame|navigated/.test(raw)) {
    lines.push('成因提示：这类错误基本都是**导航竞态**——页面或它的执行上下文正在被换掉时求值。'
      + '本探针已用「about:blank 启动 → 显式 Page.navigate → 轮询 location.search + readyState → 可重试求值」消除它；'
      + '若仍出现，先确认这个 CDP 端口没连到别的浏览器实例（可设 XM_CDP_PORT 换端口）。');
  } else if (/连不上 CDP|WebSocket|10s 无应答|仍不可求值/.test(raw)) {
    lines.push('成因提示：确认静态服务在跑（另开一个终端 node server.mjs），'
      + '以及 EDGE_BIN 指向的浏览器能无头启动、机器没被别的无头浏览器拖满。');
  }
  return lines.join('\n');
}

async function main() {
  if (!EDGE) throw new Error('找不到 Edge/Chrome，可用 EDGE_BIN 环境变量指定路径');
  // ── fail-fast（task-42）：静态服务不在 ⇒ 1 行报错 + exit 2，绝不白等 30 s，也绝不先起浏览器 ──
  if (!(await originAlive())) {
    throw new Error(`静态服务连不上（${ORIGIN}）—— 另开一个终端跑 node server.mjs 再复跑本探针`);
  }
  if (await cdpAlive()) {
    throw new Error(`CDP 端口 ${PORT} 上已经有别的浏览器在应答：先关掉它，或设 XM_CDP_PORT 换端口（否则断言会跑在别人身上）`);
  }
  if (SABOTAGE) {
    console.error(`⚠ 红测模式：XM_CREDIT_SABOTAGE=${SABOTAGE}（在页面 realm 里旁路运行中的原型方法；源文件不改）\n`);
  }

  const profile = mkdtempSync(join(tmpdir(), 'xm-credit-probe-'));
  const A_URL = `${ORIGIN}/index.html?probe=${TS}a`;
  const B_URL = `${ORIGIN}/index.html?probe=${TS}b`;
  const child = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--mute-audio', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--remote-allow-origins=*', '--window-size=1280,820',
    `--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`,
    'about:blank',                       // 见文件头：真页面一律走 Page.navigate
  ], { stdio: 'ignore', windowsHide: true });

  let step = '启动无头 Edge';
  const results = [];
  let ws = null;
  let fatal = null;
  try {
    let page = null;
    for (let i = 0; i < 80 && !page; i++) {
      await sleep(300);
      try {
        const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
        page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl) || null;
      } catch { /* 浏览器还没起来 */ }
    }
    step = '连接 CDP';
    if (!page) throw new Error(`连不上 CDP:${PORT}（${ORIGIN} 的静态服务起了吗：node server.mjs）`);
    ws = await connect(page.webSocketDebuggerUrl);

    let id = 0;
    const pending = new Map();
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
    });
    const send = (method, params = {}) => new Promise((res, rej) => {
      const i = ++id;
      pending.set(i, { res, rej });
      ws.send(JSON.stringify({ id: i, method, params }));
    });
    const noAnswer = (ms) => new Promise((_res, rej) => {
      setTimeout(() => rej(new Error(`CDP 请求 ${ms}ms 无应答（页面很可能正在被替换）`)), ms);
    });
    const evaluate = async (expr, waitMs = 60000) => {
      const r = await Promise.race([
        send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }),
        noAnswer(waitMs),
      ]);
      if (r.exceptionDetails) {
        const ex = r.exceptionDetails;
        throw new Error('页面内异常：' + ((ex.exception && (ex.exception.description || ex.exception.value)) || ex.text));
      }
      return r.result.value;
    };
    const waitEvaluable = async (marker, timeout = 30000) => {
      const t0 = Date.now();
      let lastErr = null;
      while (Date.now() - t0 < timeout) {
        try {
          if ((await evaluate(`location.search === ${JSON.stringify(marker)} && document.readyState === 'complete'`, 8000)) === true) return;
        } catch (e) { lastErr = e; }
        await sleep(150);
      }
      throw new Error(`等了 ${timeout}ms 页面仍不可求值（marker=${marker}）`
        + (lastErr ? `；最后一次 CDP 错误：${lastErr.message}` : ''));
    };

    step = 'A 段导航';
    await send('Page.navigate', { url: A_URL });
    await waitEvaluable(`?probe=${TS}a`);
    step = 'A 段断言';
    const ra = await evaluate(SCRIPT_A, 180000);
    results.push(...ra);

    const preItem = ra.find((r) => r.extra && r.extra.pre === true);
    const pre = preItem ? preItem.extra
      : { value: '?', lost: '?', earned: '?', unlocked: '?', broken: '?', entities: '?' };

    step = 'B 段换 URL 冷启动';
    await send('Page.navigate', { url: B_URL });
    await waitEvaluable(`?probe=${TS}b`);
    step = 'B 段断言';
    results.push(...(await evaluate(scriptB(pre), 90000)));
  } catch (e) {
    fatal = e;
  } finally {
    try { if (ws) ws.close(); } catch { /* 已经断了 */ }
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    await sleep(600);
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* Windows 偶尔还占着 */ }
  }

  const bad = results.filter((r) => !r.ok);
  if (fatal) {
    // 没跑完的运行绝不能伪装成「跑完了但有失败」：先报中断，再报已拿到的项
    console.error(explain(step, fatal));
    for (const r of results) console.log(`${r.ok ? '  PASS' : '  FAIL'}  ${r.label}${r.extra === null ? '' : '  ' + JSON.stringify(r.extra)}`);
    console.error(`\n学分系统探针：跑到第 ${results.length} 项后中断，结论不可用（exit 2）`);
    return 2;
  }
  for (const r of results) {
    console.log(`${r.ok ? '  PASS' : '  FAIL'}  ${r.label}${r.extra === null ? '' : '  ' + JSON.stringify(r.extra)}`);
  }
  if (!bad.length) {
    console.log(`\n学分系统探针：全部通过：${results.length} 项${SABOTAGE ? `（⚠ 这是红测模式 ${SABOTAGE}，全过说明旁路没生效 = 断言是空断言）` : ''}`);
    return SABOTAGE ? 1 : 0;      // 红测模式下「全过」恰恰是坏消息：必须是红的
  }
  console.log(`\n学分系统探针：共 ${results.length} 项，失败 ${bad.length} 项${SABOTAGE ? `（红测模式 ${SABOTAGE}：以上 FAIL 就是「什么改动会让它红」的原始输出）` : ''}`);
  return 1;
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((e) => { console.error('探针跑不起来：' + (e && e.message ? e.message : e)); process.exitCode = 2; });
