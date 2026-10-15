// ══════════════════════════════════════════════════════════
// 无头验收：设置面板 + 学分开关（task-4 的正式证据，可反复复跑）
//
//   node server.mjs                 # 另开一个终端（静态服务，默认 7373；已在跑就别重复起）
//   node tools/settings-probe.mjs   # 全过 exit 0，有失败 exit 1，跑不起来 exit 2
//
// 做法：用 Node 内置 WebSocket 直接说 CDP，起一个**无头** Edge（无窗口、--mute-audio 静音、
// 临时 profile 用完即删、带 cache-buster 冷加载），断言跑在页面自己的 realm 里——
// 校验的是真实页面、真实 rAF、真实事件，而不是替身桩。
// 不用 puppeteer/playwright：零新依赖是本项目的硬约束。
//
// 时序（这段是踩过坑的，别改回去）：启动参数**只给 about:blank**，真页面用 Page.navigate
// 显式导航，之后轮询「location.search 正好是本段标记 && readyState === 'complete'」才注入断言。
// 把 http URL 直接写进启动参数的话，浏览器会先建 about:blank 再跨进程导航，初始执行上下文
// 被销毁——抢在那时求值就是 -32000 Execution context was destroyed。
// 关键认识：**/json/list 里出现目标 ≠ 导航完成**。
//
// 覆盖：
//   ① 插件全量装载、failed 0、清单与 host.stats() 自洽、⚙ 紧跟 🧩
//      （**不写死插件数**：数量由页面真值推导 —— 写死的 24 在 W3b 接线 2 个插件后变成 6 条假红 ✗）
//   ② ⚙ 开抽屉 / 背景 inert 锁 / Esc 关闭 / 焦点回归 ⚙ / 徽章右键入口 / 转插件管理器
//   ③a 学分开着：真实短路事故（12V 干电池 + 闭合开关直接短接）烧坏电池并扣 8 学分
//   ③  关掉学分：徽章消失、app.credit 不再是可用对象、failed 不增加、
//      同一事故损坏照旧且 reason 逐字一致（证「只是不扣分」而非「损坏也失效」）
//   ④  重新打开：徽章回来、学分回满 100
//   ⑤  换 URL 冷启动：关掉的选择被记住（localStorage 持久化 + 开机跳过）
//
// 尾行固定打印两条「环境自述」（D36 + 争用）—— 固定打印，不是「有问题才打」：
//   · 环境合规：并发无头实例=N（>1 时本次读数降级为「参考」）
//       启动前与结束后各数一次、取较大值，且**含本进程这一次**。数不到就报「未知」并按
//       「参考」对待 —— 机器不可读 ≠ 环境干净 ✗。数的是「无头主进程」（命令行含
//       --headless 且不带 --type=）：只数 msedge.exe 会把用户自己开的浏览器算成争用 ✗。
//   · 依赖版本：src/ui/touch.js=<sha256>/<字节>  styles/display.css=<sha256>/<字节>
//       运行**首尾各取一次**；两次不一致就明确标「跨了两个版本、作废」✗ —— 跨层读数必须与
//       被依赖文件的 sha 成对记录（这条是本项目实测出来的：同一处结论会随被依赖版本翻转）。
//
// 重试策略：**只有 exit 2（中断/零断言/预检失败）才重试一次**，两次都 2 才报 2 ✓。
// 红(1)与绿(0)都是结论，绝不重跑 —— 红是结论，重跑红就变成挑读数 ✗。
// 每次尝试用独立 CDP 端口（PORT_BASE + 尝试序号），上一次的浏览器没死透也不会连到尸体上 ✓。
// 环境变量：XM_ORIGIN（静态服务地址）/ XM_CDP_PORT（端口基址）/ EDGE_BIN（浏览器路径）。
// ══════════════════════════════════════════════════════════

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ORIGIN = process.env.XM_ORIGIN || 'http://127.0.0.1:7373';
/** 端口基址；每次尝试用 PORT_BASE + 尝试序号 —— 上一次的浏览器还没死透时不会撞到它自己的端口 */
const PORT_BASE = Number(process.env.XM_CDP_PORT || 9344);
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
const HELPERS = `
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const R = [];
const chk = (ok, label, extra) => R.push({ ok: !!ok, label, extra: extra === undefined ? null : extra });
/** 等一个状态出现，比睡固定毫秒稳：动效与判定的耗时都会随机器变 */
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
    if (window.xiaomo && window.xiaomo.inventory && document.querySelector('#btnSettings')) {
      await sleep(500);
      return window.xiaomo;
    }
    await sleep(100);
  }
  throw new Error('引导未完成：等不到 #btnSettings');
}
const drawerMask = () => { const dr = document.querySelector('.drawer[aria-label="设置"]'); return dr ? dr.closest('.drawer-mask') : null; };
const isOpen = () => { const m = drawerMask(); return !!(m && m.classList.contains('show') && m.classList.contains('in')); };
async function waitClosed(timeout = 4000) {
  return waitFor(() => { const m = drawerMask(); return !m || !m.classList.contains('show'); }, timeout);
}
const badgeCount = () => document.querySelectorAll('#topbar .credit-badge').length;
const openDrawer = async () => { const b = document.querySelector('#btnSettings'); b.focus(); b.click(); await waitFor(isOpen, 3000); };
/** 真实事故：12V 干电池 + 闭合开关，用两根导线把电源短在开关上（world.connect 禁止同器材自连） */
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
`;

const SCRIPT_A = `(async () => { ${HELPERS}
  const app = await ready();
  const d = document;

  // ① 装完没装坏
  // 基线**从现实推导，不写死**：写死 24 在 W3b 接线 2 个插件后（现实 30）变成假红；
  // 写死 30 会在下次接线后再假红一次 ✗。所以取页面自己的真值 BASE，并要求几个真值来源互相自洽。
  const st = app.host.stats();
  const snap = app.inventory.snapshot();
  const BASE = st.total;
  const activeInItems = snap.items.filter((i) => i.phase === 'active').length;
  chk(BASE > 0 && st.installed === BASE && st.failed === 0
      && snap.counts.active === BASE && snap.counts.pending === 0 && snap.counts.failed === 0
      && activeInItems === BASE,
    '① 真实页面自洽：' + st.installed + '/' + BASE + ' 装载（总数由页面推导）、清单 '
      + snap.counts.active + ' active、逐条数 ' + activeInItems + '、failed 0',
    { total: st.total, installed: st.installed, failed: st.failed, hostActive: st.active, counts: snap.counts, activeInItems });
  const kids = [...d.querySelector('[data-slot="topbar.right"]').children].map(e => e.id || e.className);
  chk(kids.includes('btnSettings') && kids.indexOf('btnSettings') === kids.indexOf('btnPlugins') + 1,
    '① ⚙ 在顶栏右侧且紧跟 🧩', kids);
  chk(badgeCount() === 1 && !!app.credit && app.credit.value === 100,
    '① 学分徽章在、app.credit 满值 100', { badge: badgeCount(), value: app.credit && app.credit.value });

  // ② ⚙ 开抽屉 / 背景锁 / Esc 关闭 + 焦点回归
  const btn = d.querySelector('#btnSettings');
  btn.focus();                       // 真实鼠标点击会把按钮设成焦点，合成 .click() 不会
  await openDrawer();
  chk(isOpen(), '② 点 ⚙ 抽屉打开（show + in）', drawerMask() && drawerMask().className);
  const shell = d.getElementById('app');
  chk(shell.inert === true || shell.getAttribute('aria-hidden') === 'true',
    '② 打开时背景被锁（inert 或 aria-hidden）', { inert: shell.inert, aria: shell.getAttribute('aria-hidden') });
  const dr = d.querySelector('.drawer[aria-label="设置"]');
  chk(dr.contains(d.activeElement), '② 打开后焦点进了抽屉', String(d.activeElement && (d.activeElement.className || d.activeElement.tagName)));
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  chk(await waitClosed(), '② Esc 关掉抽屉');
  await sleep(150);
  chk(d.activeElement === btn, '② 关闭后焦点回到 ⚙', String(d.activeElement && (d.activeElement.id || d.activeElement.className)));
  chk(shell.inert !== true, '② 关闭后背景解锁', { inert: shell.inert });

  // ②b 徽章右键直达设置；设置里的按钮能进插件管理器
  d.querySelector('#topbar .credit-badge').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  chk(await waitFor(isOpen, 3000), '② 学分徽章右键也能打开设置');
  d.querySelector('.drawer[aria-label="设置"] #btnOpenPlugins').click();
  await sleep(900);
  const mgr = d.querySelector('.drawer[aria-label="插件管理器"]');
  chk(!!mgr && mgr.closest('.drawer-mask').classList.contains('show'), '② 「打开插件管理器」把管理器抽屉打开了');
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  await sleep(600);

  // ③a 对照：学分开着时，真实短路 → 真扣分
  const b0 = { v: app.credit.value, lost: app.credit.lost };
  const c1 = shortCircuit(app);
  const broke1 = await waitFor(() => c1.bat.state.broken === true, 6000);
  const r1 = { broken: c1.bat.state.broken, reason: c1.bat.state.brokenReason, I: c1.bat.state.I, wires: [c1.w1, c1.w2] };
  chk(broke1, '③a 学分开着：干电池被真实事故烧坏', r1);
  await waitFor(() => app.credit.lost - b0.lost >= 8, 2000);
  chk(app.credit.lost - b0.lost === 8, '③a 烧坏扣了 8 学分', { lostBefore: b0.lost, lostAfter: app.credit.lost, valueNow: app.credit.value });
  app.world.clear(); app.clearWires(); await sleep(150);

  // ③b 关掉学分
  await openDrawer();
  d.querySelector('.drawer[aria-label="设置"] .plug-switch').click();
  chk(await waitFor(() => badgeCount() === 0, 3000), '③ 关掉后徽章从顶栏消失', { badge: badgeCount() });
  chk(!app.credit, '③ 关掉后 app.credit 不再是可用对象', app.credit === null ? null : String(app.credit));
  const st2 = app.host.stats();
  const snap2 = app.inventory.snapshot();
  chk(st2.failed === 0 && snap2.counts.failed === 0, '③ 关掉没弄坏别的插件：failed 仍为 0',
    { hostFailed: st2.failed, counts: snap2.counts });
  chk(snap2.counts.pending === 1 && snap2.counts.active === BASE - 1,
    '③ 关掉一项后清单变成 ' + (BASE - 1) + ' active / 1 pending（相对 ① 的基线推导，未写死）',
    { counts: snap2.counts, base: BASE });
  const rec = app.host.get('xiaomo.system.credit');
  chk(!!rec && rec.phase === 'pending' && rec.offBy === 'item' && rec.enabled === false,
    '③ 宿主记录 phase=pending、offBy=item', rec ? { phase: rec.phase, offBy: rec.offBy, enabled: rec.enabled } : null);
  const it = snap2.items.find(i => i.id === 'xiaomo.system.credit');
  chk(!!it && it.phase === 'pending' && it.offBy === 'item', '③ 清单条目 phase=pending、offBy=item',
    it ? { phase: it.phase, offBy: it.offBy } : null);
  const m2 = drawerMask();
  chk(!!m2 && m2.classList.contains('show') && m2.classList.contains('in'),
    '③ 切换引发 overlay 槽重渲染后，抽屉仍然开着（节点已换新）', m2 ? m2.className : null);

  // ③c 学分关着：同样的真实事故，损坏照旧、只是不扣分
  const c2 = shortCircuit(app);
  const broke2 = await waitFor(() => c2.bat.state.broken === true, 6000);
  const r2 = { broken: c2.bat.state.broken, reason: c2.bat.state.brokenReason, I: c2.bat.state.I, wires: [c2.w1, c2.w2] };
  chk(broke2, '③ 学分关着：损坏规则照常触发（电池仍被烧坏）', r2);
  chk(r2.reason === r1.reason, '③ 损坏原因与开学分时逐字一致 → 只是不扣分',
    { on: r1.reason, off: r2.reason, same: r2.reason === r1.reason });
  chk(!app.credit, '③ 学分关着：没有学分对象可扣', app.credit === null ? null : String(app.credit));
  app.world.clear(); app.clearWires(); await sleep(150);

  // ④ 重新打开
  d.querySelector('.drawer[aria-label="设置"] .plug-switch').click();
  chk(await waitFor(() => badgeCount() === 1, 3000), '④ 重新打开后徽章回来', { badge: badgeCount() });
  chk(!!app.credit && app.credit.value === 100, '④ 重新打开后学分回满 100',
    app.credit ? { value: app.credit.value, max: app.credit.max } : null);
  const snap4 = app.inventory.snapshot();
  chk(snap4.counts.active === BASE && snap4.counts.pending === 0 && snap4.counts.failed === 0,
    '④ 清单回到全量 ' + BASE + ' active（相对 ① 的基线推导，未写死）', { counts: snap4.counts, base: BASE });

  // ⑤ 前置：再关一次，留下「关」的选择给下一次冷启动
  d.querySelector('.drawer[aria-label="设置"] .plug-switch').click();
  await waitFor(() => badgeCount() === 0, 3000);
  const raw = localStorage.getItem('xiaomo.plugins.state.v1');
  let items = null; try { items = JSON.parse(raw).items; } catch (e) { items = String(raw); }
  chk(badgeCount() === 0 && !!items && items['xiaomo.system.credit'] === false,
    '⑤ 前置：已关掉并写进 localStorage', items);
  return R;
})()`;

const SCRIPT_B = `(async () => { ${HELPERS}
  const app = await ready();
  const d = document;

  chk(app.pluginState.isItemOff('xiaomo.system.credit') === true,
    '⑤ 换 URL 冷启动后，状态里学分还是关的', 'isItemOff=true');
  chk(badgeCount() === 0, '⑤ 冷启动后徽章不存在（插件真的没装）', { badge: badgeCount() });
  chk(!app.credit, '⑤ 冷启动后 app.credit 是空的', app.credit === null ? null : String(app.credit));
  const rec = app.host.get('xiaomo.system.credit');
  chk(!!rec && rec.enabled === false && rec.phase === 'pending', '⑤ 冷启动时学分插件被跳过',
    rec ? { phase: rec.phase, enabled: rec.enabled, offBy: rec.offBy } : null);
  const snap = app.inventory.snapshot();
  const st = app.host.stats();
  // 同样是推导，不写死：本段**只关掉了一项**（下面那个开关是唯一动作），所以 pending 必须是 1；
  // active 必须等于「逐条数出来的 active 条数」。三处互相印证，且不含任何版本相关数字。
  const activeInItems = snap.items.filter((i) => i.phase === 'active').length;
  chk(snap.counts.pending === 1 && snap.counts.failed === 0 && st.failed === 0
      && snap.counts.active === activeInItems,
    '⑤ 冷启动清单：' + snap.counts.active + ' active / ' + snap.counts.pending + ' pending（逐条数 '
      + activeInItems + '、宿主总数 ' + st.total + '）、failed 0',
    { counts: snap.counts, activeInItems, hostTotal: st.total, hostFailed: st.failed });

  await openDrawer();
  const sw = d.querySelector('.drawer[aria-label="设置"] .plug-switch');
  chk(sw.getAttribute('aria-checked') === 'false' && !sw.classList.contains('on'),
    '⑤ 抽屉里的开关显示为「关」，与实际一致', { aria: sw.getAttribute('aria-checked'), cls: sw.className });
  sw.click();
  await waitFor(() => badgeCount() === 1 && !!app.credit, 4000);
  chk(badgeCount() === 1 && !!app.credit && app.credit.value === 100,
    '⑤ 在冷启动的实例里重新打开：徽章回来、学分满值',
    { badge: badgeCount(), value: app.credit && app.credit.value });
  const snap2 = app.inventory.snapshot();
  const activeInItems2 = snap2.items.filter((i) => i.phase === 'active').length;
  const st2 = app.host.stats();
  chk(snap2.counts.active === activeInItems2 && snap2.counts.pending === 0 && snap2.counts.failed === 0
      && st2.failed === 0 && st2.installed === st2.total && snap2.counts.active === st2.total,
    '⑤ 重新打开后清单回到全量 ' + snap2.counts.active + ' active（逐条数 ' + activeInItems2
      + '、宿主 ' + st2.installed + '/' + st2.total + '）、pending 0',
    { counts: snap2.counts, activeInItems2, host: { total: st2.total, installed: st2.installed, failed: st2.failed } });
  const raw = localStorage.getItem('xiaomo.plugins.state.v1');
  chk(!!raw && raw.indexOf('"xiaomo.system.credit":true') >= 0, '⑤ 选择已写回 true', raw);
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

async function cdpAlive(port) {
  try { return (await fetch(`http://127.0.0.1:${port}/json/version`)).ok; } catch { return false; }
}

/** CDP 报错说人话：哪一步、原始错误、常见成因，一次说全，别让下一个人以为环境坏了 */
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

// ── 环境自述（D36 + 争用）：读数必须自带「当时机器什么样」和「测的是哪个版本」──
// 固定打印，不是「有争用时才打」：读者要能区分「干净」与「根本没检查」✗。
const DEPS = ['src/ui/touch.js', 'styles/display.css'];

function depLine() {
  return DEPS.map((f) => {
    try {
      const b = readFileSync(f);
      return `${f}=${createHash('sha256').update(b).digest('hex')}/${b.length}B`;
    } catch (e) { return `${f}=读不到(${(e && e.code) || 'unknown'})`; }
  }).join('  ');
}

/** 数「别人的无头浏览器主进程」。tasklist 拿不到命令行，而只数 msedge.exe 会把用户自己开的
 *  浏览器算成争用 ✗，所以走 WMI。探不到返回 null —— **机器不可读 ≠ 环境干净** ✓。 */
function othersHeadless() {
  if (process.platform !== 'win32') return null;
  const ps = 'Get-CimInstance Win32_Process -Filter "Name=\'msedge.exe\'"'
    + ' | Where-Object { $_.CommandLine -match \'--headless\' -and $_.CommandLine -notmatch \'--type=\' }'
    + ' | Measure-Object | Select-Object -ExpandProperty Count';
  try {
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps],
      { encoding: 'utf8', timeout: 15000, windowsHide: true });
    const n = Number(String(r.stdout || '').trim());
    return Number.isFinite(n) ? n : null;
  } catch { return null; }
}

async function runOnce(attempt) {
  // 每次尝试用独立端口：上一次的浏览器若还没死透，固定端口会让我们连到上一具尸体上 ✗
  const PORT = PORT_BASE + attempt;
  const concStart = othersHeadless();
  const shaStart = depLine();
  const results = [];
  let step = '预检';
  let child = null;
  let profile = null;
  let ws = null;
  let fatal = null;

  // 任何出口都要有环境自述（含预检失败那几种）：先定义，返回前统一调用 ✓
  const envReport = () => {
    const seen = [concStart, othersHeadless()].filter((v) => v !== null);
    const others = seen.length ? Math.max.apply(null, seen) : null;
    const n = others === null ? null : others + 1;        // 含本进程这一次
    console.log('环境合规：并发无头实例=' + (n === null ? '未知' : n) + '（>1 时本次读数降级为「参考」）'
      + (n === null ? '  ← 并发数没数到：本次按「参考」对待，绝不悄悄当干净 ✗'
        : n > 1 ? '  ← 本次读数是在争用下取得的，按「参考」对待' : ''));
    const shaEnd = depLine();
    console.log('依赖版本：' + shaEnd
      + (shaEnd === shaStart ? '（运行首尾一致 ✓）' : ' ✗ 运行期间被改动：本次读数跨了两个版本，作废'));
  };

  try {
    if (!EDGE) throw new Error('找不到 Edge/Chrome，可用 EDGE_BIN 环境变量指定路径');
    if (await cdpAlive(PORT)) {
      throw new Error(`CDP 端口 ${PORT} 上已经有别的浏览器在应答：先关掉它，或设 XM_CDP_PORT 换端口（否则断言会跑在别人身上）`);
    }

    step = '启动无头 Edge';
    profile = mkdtempSync(join(tmpdir(), 'xm-settings-probe-'));
    const A_URL = `${ORIGIN}/index.html?probe=${TS}a`;
    const B_URL = `${ORIGIN}/index.html?probe=${TS}b`;
    child = spawn(EDGE, [
      '--headless=new', '--disable-gpu', '--mute-audio', '--no-first-run', '--no-default-browser-check',
      '--disable-extensions', '--remote-allow-origins=*', '--window-size=1280,820',
      `--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`,
      'about:blank',                       // 见文件头：真页面一律走 Page.navigate，导航完成才等得到
    ], { stdio: 'ignore', windowsHide: true });

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
    /** 请求干脆没回应也当失败：否则一次卡死会把探针挂到天荒地老 */
    const noAnswer = (ms) => new Promise((_res, rej) => {
      setTimeout(() => rej(new Error(`CDP 请求 ${ms}ms 无应答（页面很可能正在被替换）`)), ms);
    });
    const evaluate = async (expr, waitMs = 5000) => {
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
    /** 等到「就是本段要的那个文档、且已加载完」为止。求值表达式无副作用，
     *  所以上下文被替换时抛的错直接重试是安全的 —— 慢机器也因此能容忍。 */
    const waitEvaluable = async (marker, timeout = 30000) => {
      const t0 = Date.now();
      let lastErr = null;
      while (Date.now() - t0 < timeout) {
        try {
          if ((await evaluate(`location.search === ${JSON.stringify(marker)} && document.readyState === 'complete'`)) === true) return;
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
    results.push(...(await evaluate(SCRIPT_A, 180000)));

    // 换一个带 cache-buster 的 URL 真冷启动；同一 profile → localStorage 仍在
    step = 'B 段换 URL 冷启动';
    await send('Page.navigate', { url: B_URL });
    await waitEvaluable(`?probe=${TS}b`);
    step = 'B 段断言';
    results.push(...(await evaluate(SCRIPT_B, 90000)));
  } catch (e) {
    fatal = e;
  } finally {
    try { if (ws) ws.close(); } catch { /* 已经断了 */ }
    if (child) {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      await sleep(600);
    }
    if (profile) {
      try { rmSync(profile, { recursive: true, force: true }); } catch { /* Windows 偶尔还占着 */ }
    }
  }

  envReport();                      // 先自述环境，再下结论：结论必须能对上当时的环境
  const bad = results.filter((r) => !r.ok);
  if (fatal) {
    // 没跑完的运行绝不能伪装成「跑完了但有失败」：先报中断，再报已拿到的项
    console.error(explain(step, fatal));
    for (const r of results) console.log(`${r.ok ? '  PASS' : '  FAIL'}  ${r.label}${r.extra === null ? '' : '  ' + JSON.stringify(r.extra)}`);
    console.error(`\n设置面板探针：跑到第 ${results.length} 项后中断，结论不可用（exit 2）`);
    return 2;
  }
  for (const r of results) {
    console.log(`${r.ok ? '  PASS' : '  FAIL'}  ${r.label}${r.extra === null ? '' : '  ' + JSON.stringify(r.extra)}`);
  }
  // 守卫（D35 同类）：**零断言不是「全过」**。跑到了页面却一条都没收集到，说明本套件
  // 已经失去红绿能力，必须是 exit 2（跑不起来），绝不能静默报绿。
  if (results.length === 0) {
    console.error('设置面板探针：一段断言都没收集到（0 项）—— 这不是「全过」，是失去红绿能力（exit 2）');
    return 2;
  }
  console.log(`\n设置面板探针：共 ${results.length} 项，失败 ${bad.length} 项`);
  return bad.length ? 1 : 0;
}

// ── 重试策略：**只有「跑不起来」（exit 2）才重试一次** ─────────────────────
// 红(1)与绿(0)都是结论，绝不重跑 —— **红是结论，重跑红就变成挑读数** ✗。
// exit 2 是「本次没拿到结论」（中断/零断言/预检失败），重试不会把结论伪装出来 ✓。
// 两次都 2 才报 2；若第二次拿到结论就采信第二次，并把两次结果都如实留在上面 ✓。
async function main() {
  const first = await runOnce(0);
  if (first !== 2) return first;

  console.error('\n设置面板探针：第 1 次跑不起来（exit 2）→ 按策略重试一次（只重试 2，红与绿都不重跑）');
  const second = await runOnce(1);
  if (second === 2) {
    console.error('设置面板探针：两次都是 exit 2（跑不起来）→ 本次结论作废，等环境安静后重跑');
    return 2;
  }
  console.log(`设置面板探针：第 1 次 exit 2、第 2 次 exit ${second} —— 采信第 2 次，两次结果都留在上面`);
  return second;
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((e) => { console.error('探针跑不起来：' + (e && e.message ? e.message : e)); process.exitCode = 2; });
