// ══════════════════════════════════════════════════════════
// 动效无头复核探针（正式产物，机器可读）
//
// 存在的理由：更早那批「界面与动效」结论是用截图/肉眼得出的，其中
// 「抽屉第二次打开的入场动画」始终没有机械验证；用户对动效是硬指标
// （真实动画 / 原生过渡 / 放大要回弹 + 拖尾 / 只准比 nb 更好）。
// 肉眼看到「没跳」不等于过渡真的在播，只有采到中间值才算数。
//
// 还替 task-7 补最后一块：增量协调用「相对顺序本来就对时不动 DOM」来
// 避免打断过渡 —— 那是推理，这里实测：在过渡中途触发条目变化，采样两点，
// 看轨迹有没有被重置。
//
// 做法：Node 内置 WebSocket 直接说 CDP，起一个**无头** Edge（无窗口、
// --mute-audio 静音、临时 profile 用完即删、仓库内零中间产物）。
//
// 时序（这段是踩过坑的，别改回去）：启动参数**只给 about:blank**，真页面用
// Page.navigate 显式导航，之后轮询「location.search 正好是本段标记 &&
// readyState === 'complete'」才注入断言。把 http URL 直接写进启动参数的话，
// 浏览器会先建 about:blank 再跨进程导航，初始执行上下文随即销毁，求值会报
// -32000 Execution context is destroyed。
//
// 断言分两类，别混：
//   kind:'check'       探针自身的判定（失败了多半是探针写错）
//   kind:'requirement' 用户/任务书点名要的能力（失败了是**产品缺陷**）
// 退出码只反映"有没有 ok:false"，读的人靠 kind 区分该查探针还是查产品。
//
// 复跑：node tools/motion-probe.mjs        （需要 node server.mjs 在 7373）
//      XM_CDP_PORT=9366 node tools/motion-probe.mjs   （换端口）
// 无法无头证明的项列在文件末尾的 NOTE 清单里，不假装验过。
// ══════════════════════════════════════════════════════════

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ORIGIN = process.env.XM_ORIGIN || 'http://127.0.0.1:7373';
const PORT = Number(process.env.XM_CDP_PORT || 9355);   // 不占 settings-probe 的 9344
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

// ══════════════════════════════════════════════════════════
// 静态检查（⑥⑦）：不依赖浏览器，Node 里读文件就够。
// 必须先剥注释再匹配 —— main.css 的头部注释里就写着「不用 scale(0)，
// 不用 transition: all」，不剥注释会把文档当违规，红灯就没人信了。
// ══════════════════════════════════════════════════════════
function walkFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walkFiles(p, out);
    else out.push(p);
  }
  return out;
}
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, ' ')      // CSS/JS 块注释
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')  // JS 行注释（避开 http:// 这类 URL）
  .replace(/<!--[\s\S]*?-->/g, ' ');      // HTML 注释

function staticChecks(root) {
  const R = [];
  const files = [
    ...walkFiles(join(root, 'styles')),
    ...walkFiles(join(root, 'src')),
    join(root, 'index.html'),
  ].filter((p) => /\.(css|js|mjs|html)$/.test(p));

  const bad = { all: [], zero: [], raw: [] };
  const tokensSeen = new Set();
  const TOKENS = new Set(['--t-press', '--t-fast', '--t-base', '--t-slow']);

  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    const code = stripComments(src);
    const rel = f.slice(root.length + 1).replace(/\\/g, '/');
    // ⑥ transition: all（整条过渡无从预期，动效会波及没打算动的属性）
    for (const m of code.matchAll(/(^|[;{\s])transition\s*:\s*all\b/g)) {
      bad.all.push(`${rel}:${src.slice(0, m.index).split('\n').length}`);
    }
    // ⑥ scale(0)（从 0 放大既看不见起始帧、也让 GPU 走不上合成路径）
    for (const m of code.matchAll(/scale\(\s*0\s*\)/g)) {
      bad.zero.push(`${rel}:${src.slice(0, m.index).split('\n').length}`);
    }
    // ⑦ 裸毫秒：CSS 里的时长必须走 --t-* token
    if (/\.css$/.test(rel)) {
      for (const m of code.matchAll(/(?:transition|animation)(?:-duration)?\s*:[^;{}]*?(\d+(?:\.\d+)?m?s)\b/g)) {
        bad.raw.push(`${rel} → ${m[1]}`);
      }
      for (const m of code.matchAll(/var\((--t-[a-z-]+)\)/g)) tokensSeen.add(m[1]);
    }
  }
  const badToken = [...tokensSeen].filter((t) => !TOKENS.has(t));

  R.push({ ok: bad.all.length === 0, kind: 'check', label: '⑥ transition:all 全项目 0 命中（已剥注释）',
    extra: { hits: bad.all, note: '未剥注释时会命中 main.css 头部注释 1 处，那是文档不是违规' } });
  R.push({ ok: bad.zero.length === 0, kind: 'check', label: '⑥ scale(0) 全项目 0 命中（已剥注释）', extra: { hits: bad.zero } });
  R.push({ ok: badToken.length === 0, kind: 'check', label: '⑦ 时长 token 只用 --t-* 四档',
    extra: { used: [...tokensSeen].sort(), unknown: badToken } });
  R.push({ ok: true, kind: 'check', label: '⑦ 裸毫秒声明清单（供人工核对，不判失败）',
    extra: { count: bad.raw.length, sample: bad.raw.slice(0, 12) } });
  return R;
}

// ══════════════════════════════════════════════════════════
// 页面内断言（注入 realm 执行）
// ══════════════════════════════════════════════════════════
const SCRIPT_A = `(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const R = [];
  const chk = (ok, label, extra, kind) => R.push({ ok: !!ok, kind: kind || 'check', label, extra: extra === undefined ? null : extra });
  async function waitFor(fn, timeout = 6000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) { try { if (fn()) return true; } catch (e) {} await sleep(30); }
    return false;
  }
  const cs = (el) => getComputedStyle(el);
  const numv = (s) => parseFloat(s) || 0;
  /** matrix(...) 的第 5 项就是 translateX；none 视为 0 */
  const txOf = (tr) => { if (!tr || tr === 'none') return 0;
    const m = tr.match(/matrix\\(([^)]+)\\)/); if (!m) return 0;
    const p = m[1].split(',').map(Number); return p.length >= 6 ? p[4] : 0; };
  const scaleOf = (tr) => { if (!tr || tr === 'none') return 1;
    const m = tr.match(/matrix\\(([^)]+)\\)/); if (!m) return 1;
    const p = m[1].split(',').map(Number); return p.length >= 1 ? p[0] : 1; };
  /** rAF 采样器：一次注入、整段采样，避免逐帧跨进程往返把时间轴拉歪 */
  function sampler(read) {
    const t0 = performance.now(); const out = []; let stop = false;
    const tick = () => { if (stop) return; out.push(read(Math.round(performance.now() - t0))); requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    return { stop: () => { stop = true; return out; } };
  }
  const mid = (v, a, b, tol) => v > Math.min(a, b) + tol && v < Math.max(a, b) - tol;
  const hex2rgb = (h) => { const s = h.trim().replace('#', '');
    const f = s.length === 3 ? s.split('').map(c => c + c).join('') : s;
    return [0, 2, 4].map(i => parseInt(f.slice(i, i + 2), 16)); };
  const rgbOf = (s) => (s.match(/[\\d.]+/g) || []).slice(0, 3).map(Number);

  // 等应用真的起来
  const app = window.xiaomo;
  const ok0 = await waitFor(() => app && app.host && app.host.stats && app.host.stats().active >= 20, 25000);
  chk(ok0, '应用就绪（插件 active ≥ 20）', { active: app && app.host ? app.host.stats().active : null });
  if (!ok0) return R;

  const maskOf = () => { const r = document.getElementById('setRowCredit'); return r ? r.closest('.drawer-mask') : null; };
  const open = () => window.dispatchEvent(new CustomEvent('xiaomo:settings', { detail: true }));
  const close = () => window.dispatchEvent(new CustomEvent('xiaomo:settings', { detail: false }));

  // ══ ① 抽屉入场真的在播（重点：第二次打开）══════════════
  async function captureOpen(tag) {
    await waitFor(() => maskOf() && !cs(maskOf()).display.includes('none') === false, 3000);
    const m = maskOf(); if (!m) return null;
    const d = m.querySelector('.drawer');
    const s = sampler((t) => ({ t, o: +numv(cs(m).opacity).toFixed(3), x: +txOf(cs(d).transform).toFixed(1) }));
    open();
    await sleep(900);
    const samples = s.stop();
    const x0 = samples.length ? samples[0].x : 0;
    const oSeq = samples.map((p) => p.o), xSeq = samples.map((p) => p.x);
    const oMid = samples.filter((p) => mid(p.o, 0, 1, 0.02)).length;
    const xMid = samples.filter((p) => x0 > 1 && mid(p.x, 0, x0, 1)).length;
    chk(oMid >= 2 && xMid >= 2, '① ' + tag + ' 抽屉在播（采到中间值）',
      { 采样点数: samples.length, 不透明度中间帧: oMid, 位移中间帧: xMid,
        不透明度序列: oSeq.slice(0, 10), 位移序列: xSeq.slice(0, 10),
        终值: { opacity: +numv(cs(m).opacity), tx: txOf(cs(d).transform) } }, 'requirement');
    return { m, d, samples, x0 };
  }
  const first = await captureOpen('第一次');
  await close();
  await waitFor(() => !maskOf() || !maskOf().classList.contains('show'), 3000);
  await sleep(400);
  const second = await captureOpen('第二次');
  chk(!!first && !!second && first.samples.length > 3 && second.samples.length > 3,
    '① 两次打开都采到帧', { 第一次帧数: first ? first.samples.length : 0, 第二次帧数: second ? second.samples.length : 0 });

  // ══ ② 增量协调不打断过渡（task-7 的实测补刀）════════════
  await close();
  await waitFor(() => !maskOf() || !maskOf().classList.contains('show'), 3000);
  await sleep(400);
  const m2 = maskOf(), d2 = m2.querySelector('.drawer');
  const s2 = sampler((t) => ({ t, o: +numv(cs(m2).opacity).toFixed(3), x: +txOf(cs(d2).transform).toFixed(1) }));
  open();
  await waitFor(() => numv(cs(m2).opacity) > 0.05 && numv(cs(m2).opacity) < 0.95, 3000);   // 等它真的在过渡中
  const pre = { t: Math.round(performance.now()), o: numv(cs(m2).opacity), x: txOf(cs(d2).transform) };
  // 中途动手：关学分 → overlay 槽条目增减 → 正是「抽屉自关」的原始触发路径
  const CREDIT = 'xiaomo.system.credit';
  if (app.pluginState && app.pluginState.setItem) app.pluginState.setItem(CREDIT, false);
  app.host.disable(CREDIT, 'item');
  await sleep(20);
  const post = { o: numv(cs(m2).opacity), x: txOf(cs(d2).transform), sameNode: maskOf() === m2 };
  await sleep(900);
  const out2 = s2.stop();
  const after = out2.filter((p) => p.o !== undefined).slice(-24);
  const lowestAfter = Math.min(...after.map((p) => p.o));
  const resetToZero = out2.some((p, i) => i > 0 && out2[i - 1].o > 0.15 && p.o <= 0.02);
  const xAfter = after.map((p) => p.x);
  const xBackJump = xAfter.some((v, i) => i > 0 && v - xAfter[i - 1] > 5);   // 位移倒着走 = 从头重播
  chk(post.sameNode && maskOf() === m2, '② 过渡中途的条目变化没有换掉抽屉节点',
    { 触发后同一节点: post.sameNode, 稳定后仍是同一节点: maskOf() === m2 }, 'requirement');
  chk(!resetToZero && !xBackJump && Math.abs(numv(cs(m2).opacity) - 1) < 0.01,
    '② 过渡轨迹继续推进、未被重置',
    { 触发时不透明度: +pre.o.toFixed(3), 触发后: +post.o.toFixed(3),
      尾段最小不透明度: +lowestAfter.toFixed(3), 是否回落到0: resetToZero, 位移是否倒退: xBackJump,
      尾段位移: xAfter.slice(0, 8), 终值不透明度: +numv(cs(m2).opacity).toFixed(3) }, 'requirement');
  if (app.pluginState && app.pluginState.setItem) app.pluginState.setItem(CREDIT, true);
  app.host.enable(CREDIT);
  await sleep(120);

  // ══ ①c 退场也要是真过渡（历史事故区：C1「抽屉关闭闪一下没了」）══
  // 此刻抽屉是开的（② 打开后没关），正好采一整个关闭过程，并分清
  // transitionend 与兜底定时器谁是实际信号（ui.settings.js:203 声称以 transitionend 为主）。
  {
    const m3 = maskOf(), d3 = m3.querySelector('.drawer');
    const xOff = d3.offsetWidth;                          // translateX(100%) = 面板自身宽度
    const evts = []; const t3 = performance.now();
    const onEnd3 = (e) => evts.push({ ev: e.type, p: e.propertyName, src: e.target === m3 ? 'mask' : 'child',
      t: Math.round(performance.now() - t3) });
    // transitioncancel 也要收：被中断的过渡不发 transitionend，只发 cancel ——
    // 只监听 transitionend 的话，被中断时看到的是「什么都没发生」，无从判断。
    const EV3 = ['transitionrun', 'transitionstart', 'transitionend', 'transitioncancel'];
    for (const ev of EV3) m3.addEventListener(ev, onEnd3, true);   // 捕获阶段：子元素的事件也收得到
    let removedAt = null;
    const obs3 = new MutationObserver(() => {
      if (removedAt === null && !m3.classList.contains('show')) removedAt = Math.round(performance.now() - t3);
    });
    obs3.observe(m3, { attributes: true, attributeFilter: ['class'] });
    const f3 = []; let stop3 = false;
    const tick3 = () => { if (stop3) return;
      f3.push({ t: Math.round(performance.now() - t3), o: +numv(cs(m3).opacity).toFixed(3),
        x: +txOf(cs(d3).transform).toFixed(1), vis: cs(m3).display !== 'none' });
      requestAnimationFrame(tick3); };
    requestAnimationFrame(tick3);
    close();
    await sleep(650);
    stop3 = true; obs3.disconnect();
    for (const ev of EV3) m3.removeEventListener(ev, onEnd3, true);
    const vis3 = f3.filter((f) => f.vis);
    const last3 = vis3[vis3.length - 1] || null;
    const oMid3 = f3.filter((f) => mid(f.o, 0, 1, 0.02)).length;
    const xMid3 = f3.filter((f) => mid(f.x, 0, xOff, 1)).length;
    // 「谁驱动」只作记录（见下面的观察项）：无头环境里主线程被阻塞时过渡可能只发
    // transitioncancel、transitionend 整个不来 —— 那是环境特性，不是产品缺陷。
    // 真正可判、且能抓住 C1「关闭闪一下没了」的是：撤 show 不得早于动画视觉结束。
    const driver = removedAt === null ? null
      : (evts.find((e) => e.ev === 'transitionend' && Math.abs(e.t - removedAt) <= 25) || null);
    const lastMoving = [...f3].reverse().find((f) => f.vis && (f.o > 0.01 || f.x < xOff - 5)) || null;
    chk(oMid3 >= 2 && xMid3 >= 2, '①c 退场是过渡不是瞬间消失（采到不透明度与位移中间帧）',
      { 不透明度中间帧: oMid3, 位移中间帧: xMid3, 帧数: f3.length, 满行程: xOff,
        不透明度序列: f3.map((f) => f.o).slice(0, 12), 位移序列: f3.map((f) => f.x).slice(0, 12) },
      'requirement');
    chk(!!last3 && last3.o < 0.05, '①c 退场：节点隐藏前不透明度已降到 ~0（不闪）',
      { 最后可见帧: last3, 已滑出: last3 ? +(last3.x / (xOff || 1) * 100).toFixed(0) + '%' : null,
        隐藏后剩余位移: last3 ? +(xOff - last3.x).toFixed(1) : null,
        说明: '遮罩淡到 0 时面板已滑出大半，且整层已不可见，此刻撤掉 show 是看不见的；'
          + 'C1 那类「闪一下没了」只会在最后可见帧仍接近不透明时出现' }, 'requirement');
    chk(!!lastMoving && removedAt !== null && removedAt >= lastMoving.t,
      '①c 退场没有被兜底定时器截断（撤 show 不早于动画视觉结束）',
      { 撤show时刻: removedAt, 动画视觉结束帧: lastMoving,
        余量: lastMoving && removedAt !== null ? removedAt - lastMoving.t : null,
        满行程: xOff, 兜底超时: 'exitMs = 最长过渡 + 80ms' }, 'requirement');
    chk(true, '①c 记录（不判失败）：退场的实际信号是 transitionend 还是兜底定时器',
      { 实际信号: driver ? 'transitionend' : (evts.some((e) => e.ev === 'transitioncancel') ? 'transitioncancel → 兜底定时器' : '兜底定时器'),
        事件序列: evts.slice(0, 8), show被撤时刻: removedAt,
        说明: '主线程被阻塞时过渡可能只发 transitioncancel、不发 transitionend，兜底定时器接管在设计之内；'
          + '只要撤 show 不早于动画视觉结束就没有可见缺陷' });
  }

  // ══ ③ 主题切换是真的在过渡 ═════════════════════════════
  const orb = document.querySelector('.fx-orb');
  const mode0 = document.documentElement.dataset.mode;
  const bg0 = cs(document.body).backgroundColor;
  const s3 = sampler((t) => ({ t, bg: cs(document.body).backgroundColor }));
  if (orb) orb.click(); else if (app.theme && app.theme.toggle) app.theme.toggle();
  await sleep(700);
  const out3 = s3.stop();
  const mode1 = document.documentElement.dataset.mode;
  const bg1 = cs(document.body).backgroundColor;
  const a0 = rgbOf(bg0), a1 = rgbOf(bg1);
  const distinct = [...new Set(out3.map((p) => p.bg))];
  const interpolated = distinct.filter((c) => { const x = rgbOf(c);
    return x.some((v, i) => mid(v, a0[i], a1[i], 1)); });
  const token = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
  const tok = token.startsWith('#') ? hex2rgb(token) : rgbOf(token);
  const finalRgb = rgbOf(bg1);
  chk(!!orb, '③ 找到主题切换入口 .fx-orb', { found: !!orb });
  chk(mode0 !== mode1, '③ 切换后 documentElement.dataset.mode 变了', { before: mode0, after: mode1 }, 'requirement');
  chk(interpolated.length >= 2, '③ 背景色采到插值中间值（不是瞬变）',
    { 起: bg0, 终: bg1, 不同颜色数: distinct.length, 中间色样本: interpolated.slice(0, 5),
      序列: out3.map((p) => p.bg).slice(0, 8) }, 'requirement');
  chk(finalRgb.every((v, i) => Math.abs(v - tok[i]) <= 2),
    '③ 终态背景与 --bg token 一致', { 实际: bg1, token, tokenRgb: tok }, 'requirement');
  const meta = document.querySelector('meta[name="theme-color"]');
  chk(!!meta, '③ theme-color meta 存在并跟随', { content: meta ? meta.content : null });
  if (orb) orb.click();                                   // 还原

  // ══ ④ 拖尾（真实存在、可采样）══════════════════════════
  const stage = document.getElementById('stage');
  const fire = (type, x, y, buttons) => stage.dispatchEvent(new PointerEvent(type,
    { clientX: x, clientY: y, buttons, button: type === 'pointerdown' ? 0 : -1, bubbles: true, pointerId: 1, isPrimary: true }));
  const r0 = stage.getBoundingClientRect();
  const ox = Math.round(r0.left + 60), oy = Math.round(r0.top + 60);
  fire('pointerdown', ox, oy, 1);
  const trails = [];
  for (let i = 1; i <= 4; i++) {                          // 向右拖：拖尾应落在左后方
    fire('pointermove', ox + i * 30, oy, 1);
    await sleep(70);
    // 取**最新**那枚：querySelector 会给最老的那枚，而旧的还没到期，
    // 采样会一直读到第一枚（它当时还没有历史位移），看着像"方向没生效"。
    const all = [...stage.querySelectorAll('.fx-trail')];
    const el = all[all.length - 1];
    if (el) trails.push({ 第几个: i, 指针位移: '+30,0', left: el.style.left, top: el.style.top,
      tx: el.style.getPropertyValue('--tx'), ty: el.style.getPropertyValue('--ty'),
      动画时长: cs(el).animationDuration });
  }
  const trailCount = stage.querySelectorAll('.fx-trail').length;
  fire('pointerup', ox + 120, oy, 0);
  chk(trailCount >= 1 && trails.length >= 1, '④ 拖动产生独立拖尾节点 .fx-trail',
    { 节点数: trailCount, 样本: trails.slice(0, 3) }, 'requirement');
  // 历史 bug 是 keyframes 里写死 translateY(8px)，横向拖动也会往下沉。
  // 判据：向右拖 → --tx 为负（落在手势后方）、--ty 为 0（不写死向下）。
  const dirOk = trails.filter((t) => parseFloat(t.tx) < -0.5);
  chk(dirOk.length >= 2 && dirOk.every((t) => Math.abs(parseFloat(t.ty)) < 0.5),
    '④ 拖尾方向跟随手势（向右拖 → --tx 为负、--ty 为 0，不是写死向下）',
    { 样本: trails,
      说明: '第 1 枚的 --tx 为 0 属预期：dirX/dirY 来自「最近一次位移」，首次移动时还没有历史位移' }, 'requirement');
  await sleep(500);
  chk(stage.querySelectorAll('.fx-trail').length === 0, '④ 拖尾自行清理，不越积越多',
    { '500ms后残留': stage.querySelectorAll('.fx-trail').length });

  // ══ ④b 放大回弹：先静态排查有没有越界缓动，再实测器材项点击 ══
  const bez = []; const kfScale = [];
  for (const sheet of document.styleSheets) {
    let rules; try { rules = sheet.cssRules; } catch (e) { continue; }
    // kfName 必须一路带下去：旧写法遇到「带子规则的 @keyframes」就 continue，只递归到关键帧停靠点，
    // 而停靠点的 cssText（"15% { transform: scale(2.91); }"）里并没有 "keyframes" 字样 —— 于是
    // kfScale 恒为空、下面那条断言永远为真（「一条永远为真的断言会训练所有人忽略红灯」的又一例）。
    const walk = (rs, kfName) => { for (const r of rs) {
      if (r.cssRules && r.cssRules.length) { walk(r.cssRules, r.name || kfName); continue; }
      if (!r.cssText) continue;
      for (const one of (r.cssText.match(/cubic-bezier\\(([^)]+)\\)/g) || [])) bez.push(one);
      if (kfName) for (const one of (r.cssText.match(/scale\\([^)]*\\)/g) || [])) kfScale.push({ 动画: kfName, 值: one });
    } };
    walk(rules, null);
  }
  const overshootBez = [...new Set(bez)].filter((b) => {
    const p = b.match(/([\\d.+-]+)/g).map(Number); return p.length === 4 && (p[1] > 1 || p[3] > 1); });
  const kfOvershoot = kfScale.filter((k) => parseFloat(k.值.match(/([\\d.]+)/)[1]) > 1.15);   // 关键帧里明显越界
  const kfNames = [...new Set(kfOvershoot.map((k) => k.动画))];
  chk(overshootBez.length === 0 && kfNames.length <= 1 && kfNames.every((n) => n === 'fx-ripple'),
    '④b 静态排查：越界（overshoot）只允许出现在 fx-ripple 的关键帧里，缓动曲线 0 处越界',
    { 缓动样本: [...new Set(bez)].slice(0, 6), 越界缓动: overshootBez, 越界关键帧: kfOvershoot,
      越界所在动画: kfNames,
      口径: '用户点名的「点击放大」＝涟漪，所以越界只允许有 fx-ripple 这一处；缓动曲线一律不许越界（规格禁 back-out）' });

  const pitem = document.querySelector('.pitem');
  let pitemSeq = null;
  if (pitem) {
    const s4 = sampler((t) => ({ t, sc: +scaleOf(cs(pitem).transform).toFixed(4), bg: cs(pitem).backgroundColor }));
    pitem.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, isPrimary: true, button: 0, buttons: 1 }));
    await sleep(500);
    pitem.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1, isPrimary: true, button: 0, buttons: 0 }));
    await sleep(200);
    pitemSeq = s4.stop();
  }
  const scSeq = pitemSeq ? [...new Set(pitemSeq.map((p) => p.sc))] : [];
  // ⚠ 这条观察项有两条历史修正，都记在这里：
  // 1) 它原先断言的是「器材项 .pitem 的缩放要越界」——对象下错了（task-9 探针缺陷）：用户点名的
  //    「点击放大」按规格指的是涟漪（plans/01 §0 L19 保护涟漪/拖尾），器材项从来没有这个要求。
  // 2) 更关键：合成 PointerEvent 在 Chromium 里**不会**触发 :active，所以哪怕 .pitem:active
  //    本来就有缩放，这里也只会读到 1 —— 它测不到「按下反馈」这件事本身。
  //    真实的按下读数由 Node 侧 ⑧ 那条硬断言用真鼠标输入测（同一元素、同一规则，两条路对照）。
  chk(true, '④b 记录（不判失败）：合成 pointerdown 测不到 :active，这里只能观察到 background-color 过渡',
    { 缩放序列去重: scSeq, 采样帧数: pitemSeq ? pitemSeq.length : 0,
      背景色种类数: pitemSeq ? [...new Set(pitemSeq.map((p) => p.bg))].length : 0,
      口径: '规格未点名器材项放大，本条只作观察上报；器材项**真实**按下反馈（0.97）由 ⑧ 用真鼠标输入实测' });

  // 项目里唯一的「点击放大」是涟漪：base transform:scale(.9) → @keyframes to scale(2.6)。
  // 采它的缩放序列，看有没有越过终值再回落 —— 「点击放大的弹跳动画」该落地的地方就是它。
  fire('pointerdown', ox, oy, 1);
  const rip = stage.querySelector('.fx-ripple');
  let ripSeq = [];
  if (rip) {
    const s5 = sampler(() => +scaleOf(cs(rip).transform).toFixed(4));
    await sleep(280);
    ripSeq = s5.stop();
  }
  const ripMax = ripSeq.length ? Math.max(...ripSeq) : null;
  const ripOvershoot = ripMax !== null && ripMax > 2.6 + 0.01;
  chk(ripSeq.length >= 3, '④b 采到「点击放大」的缩放序列（涟漪 scale .9 → 2.6）',
    { 帧数: ripSeq.length, 序列去重: [...new Set(ripSeq)] });
  chk(ripOvershoot, '④b 「点击放大」有弹跳（缩放越过终值 2.6 再回落）—— 用户点名要求',
    { 缩放峰值: ripMax, 终值: 2.6, 是否越界: ripOvershoot, 序列去重: [...new Set(ripSeq)].slice(0, 14),
      项目现有缓动: ['--ease-out cubic-bezier(.23,1,.32,1)', '--ease-in-out cubic-bezier(.77,0,.175,1)', '--ease-drawer cubic-bezier(.32,.72,0,1)'],
      实现方式: '关键帧里给一个越过终值的中间帧：@keyframes fx-ripple 的 15%{transform:scale(2.91)} → to{transform:scale(2.6)}；'
        + '不新增 easing 曲线（规格明令禁 back-out 类越界曲线）、不新增时长档；峰值那一帧只给 transform、不给 opacity，所以淡出时序逐字未动。'
        + 'plans/01-界面与动效打磨.md:15 记录用户手写要求「点击放大的弹跳动画 + 拖尾效果」，而全文只有这一处提到弹跳',
      影响面: 'styles/main.css 的 @keyframes fx-ripple（.fx-ripple 涟漪；用户点名的「点击放大」就是它）。'
        + '.fx-trail 是拖尾，与弹跳无关 —— 旧的文本把它一起写进来了，属陈旧表述' }, 'requirement');

  // ④b#1（收窄后的对象＝涟漪）判据：峰值**严格**大于终值 2.6，**且其后回落到终值**。
  // 比上面那条多验「再回落」那一半 —— 只越过终值不回落就不是弹跳而是失控。
  // 回落帧还要求 isConnected：元素被回收后 getComputedStyle 返回空串、scaleOf 退化成 1，
  // 那个 1 会伪装成「已回落到终值」，不加这个条件就是一条永远为真的断言。
  fire('pointerdown', ox, oy, 1);
  const r2All = [...stage.querySelectorAll('.fx-ripple')];
  const r2El = r2All[r2All.length - 1];
  let r2Frames = [];
  if (r2El) {
    const rt0 = performance.now();
    r2Frames = await new Promise((res) => {
      const out = [];
      const tick = () => {
        out.push({ t: Math.round(performance.now() - rt0),
          s: +scaleOf(cs(r2El).transform).toFixed(4),
          o: +numv(cs(r2El).opacity).toFixed(3),
          live: r2El.isConnected });
        if (performance.now() - rt0 < 320) requestAnimationFrame(tick); else res(out);
      };
      requestAnimationFrame(tick);
    });
  }
  const r2Peak = r2Frames.length ? Math.max(...r2Frames.map((p) => p.s)) : null;
  const r2PeakFrame = r2Frames.find((p) => p.s === r2Peak) || null;
  const r2Back = r2PeakFrame ? r2Frames.slice(r2Frames.indexOf(r2PeakFrame)).find((p) => p.live && p.s <= 2.61) : null;
  chk(r2Peak !== null && r2Peak > 2.6 && !!r2Back,
    '④b 涟漪放大：峰值严格大于终值 2.6，且其后回落到终值（越界 + 回落）—— 用户点名要求',
    { 峰值: r2Peak, 终值: 2.6, 越界幅度: r2Peak === null ? null : +((r2Peak / 2.6 - 1) * 100).toFixed(1) + '%',
      峰值帧: r2PeakFrame, 回落帧: r2Back, 帧数: r2Frames.length,
      序列: r2Frames.map((p) => p.s) }, 'requirement');
  // 可见性下限的**代理指标**（不是感知结论）：越界那一刻涟漪还剩多少不透明度，决定这个「弹跳」
  // 在屏幕上到底有没有发生。加这条是因为 task-11 把越界做成了机械成立，但峰值帧不透明度只有
  // 0.008 —— 探针全绿、用户看不见：一个看不见的需求等于没满足。0.15 是可见性代理，真机观感仍需人工确认。
  chk(!!r2PeakFrame && r2PeakFrame.o >= 0.15,
    '④b 越界峰值帧的不透明度 ≥ 0.15（可见性下限的代理指标：防止「越界在数学上成立、在屏幕上不存在」）',
    { 阈值: 0.15, 峰值帧: r2PeakFrame, 是否达标: !!r2PeakFrame && r2PeakFrame.o >= 0.15,
      不透明度随帧: r2Frames.map((p) => [p.t, p.o]),
      口径: '代理指标，不是感知结论；0.15 只保证越界那一刻还有足够不透明度被看到，最终观感需真机确认；'
        + '涟漪在 200ms 内从 opacity .5 淡到 0（--ease-out 前重后轻），所以峰值位置越晚越看不见，'
        + '本阈值与 15% 的峰值位置是配套的（另见 styles/main.css 里 @keyframes fx-ripple 的注释）' },
    'requirement');

  // ══ ⑦ 实测时长约束 ════════════════════════════════════
  const dur = (el, prop) => { const v = cs(el)[prop]; return numv(String(v).split(',')[0]) * (String(v).includes('ms') ? 1 : 1000); };
  const probeEls = [
    ['抽屉遮罩', maskOf(), 'transitionDuration'], ['抽屉面板', maskOf() && maskOf().querySelector('.drawer'), 'transitionDuration'],
    ['顶栏按钮', document.querySelector('.tb-btn'), 'transitionDuration'], ['器材项', pitem, 'transitionDuration'],
    ['涟漪', null, 'animationDuration'],
  ];
  const durs = probeEls.map(([name, el, prop]) => ({ name, v: el ? +dur(el, prop).toFixed(1) : null }));
  const rippleEl = document.createElement('span'); rippleEl.className = 'fx-ripple';
  stage.querySelector('.stage-fx').appendChild(rippleEl);
  durs[4].v = +dur(rippleEl, 'animationDuration').toFixed(2);
  rippleEl.remove();
  const tooLong = durs.filter((d) => d.v !== null && d.v > 300);
  chk(tooLong.length === 0, '⑦ 实测 UI 动效时长均 < 300ms',
    { 实测: durs, 超限: tooLong, token承诺: '--t-press 120 / --t-fast 160 / --t-base 200 / --t-slow 260' }, 'requirement');

  window.__motionReady = true;
  return R;
})()`;

// reduced-motion 段：CDP 先把媒体特征改成 reduce，再注这段
const SCRIPT_B = `(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const R = [];
  const chk = (ok, label, extra, kind) => R.push({ ok: !!ok, kind: kind || 'check', label, extra: extra === undefined ? null : extra });
  const cs = (el) => getComputedStyle(el);
  const numv = (s) => parseFloat(s) || 0;
  const txOf = (tr) => { if (!tr || tr === 'none') return 0;
    const m = tr.match(/matrix\\(([^)]+)\\)/); if (!m) return 0; const p = m[1].split(',').map(Number); return p.length >= 6 ? p[4] : 0; };
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  chk(reduce, '⑤ CDP 模拟生效：matchMedia(reduce) 为真', { matches: reduce });
  if (!reduce) return R;

  const app = window.xiaomo;
  const maskOf = () => { const r = document.getElementById('setRowCredit'); return r ? r.closest('.drawer-mask') : null; };
  const open = () => window.dispatchEvent(new CustomEvent('xiaomo:settings', { detail: true }));
  const close = () => window.dispatchEvent(new CustomEvent('xiaomo:settings', { detail: false }));
  await close(); await sleep(400);

  const m = maskOf(), d = m.querySelector('.drawer');
  const dur = (el, p) => { const v = cs(el)[p]; return numv(String(v).split(',')[0]) * (String(v).includes('ms') ? 1 : 1000); };
  const maskDur = +dur(m, 'transitionDuration').toFixed(1);
  const animDur = +dur(m, 'animationDuration').toFixed(2);
  const drawerTf = cs(d).transform;
  chk(animDur <= 0.05, '⑤ reduce 下动画时长被压到 ~0（animation-duration）', { animDuration: animDur });
  chk(drawerTf === 'none', '⑤ reduce 下抽屉位移被移除（去掉位移）', { transform: drawerTf });
  chk(true, '⑤ 记录：reduce 下残留的过渡时长（刻意保留淡入淡出，非缺陷）',
    { maskTransitionDuration: maskDur,
      项目策略: 'styles/main.css:12/761 明说「保留淡入淡出，去掉位移与缩放」——淡入淡出不属于 WCAG 2.3.3 要限制的运动，这是有意选择，不是漏做',
      建议: '口径二选一由调度者裁决：(a) 保留淡入淡出，把本条改成断言「位移/缩放被移除且 animation 压到 ~0」；(b) 严格压到 0，则在 main.css 的 reduce 块里加 .drawer-mask{transition:none} 等' });

  // ⚠ 正确的判据是「位移与缩放不产生中间值」，不是「所有 transition-duration 都约等于 0」。
  // 「*{animation-duration:.01ms}」这条并不覆盖 transition-duration；位移是靠「把目标值设成 none」
  // 消除的。按「时长必须为 0」判会得到一个假问题，然后去"修"一个正确的实现。
  const els = [['抽屉遮罩', m], ['抽屉面板', d], ['顶栏按钮', document.querySelector('.tb-btn')],
    ['器材项', document.querySelector('.pitem')], ['toast', document.getElementById('toast')]]
    .filter(([, e]) => !!e);
  const residual = els.map(([name, e]) => ({
    name, prop: cs(e).transitionProperty, tf: cs(e).transform, dur: +dur(e, 'transitionDuration').toFixed(1),
  }));
  const motionStillMoves = residual.filter((r) => /transform|scale|translate/.test(r.prop) && r.tf !== 'none');
  chk(motionStillMoves.length === 0, '⑤ reduce 下「位移/缩放」不产生中间值（正确判据）',
    { 仍声明位移过渡的元素: residual.filter((r) => /transform|scale|translate/.test(r.prop)),
      '其中变换值非 none 的': motionStillMoves });
  chk(maskDur > 50, '⑤ reduce 下刻意保留的淡入淡出仍在（未被顺手改成 0）',
    { 遮罩过渡时长: maskDur, 残留过渡: residual, 出处: 'styles/main.css:761-777「保留淡入淡出，去掉位移与缩放」' });

  // 实测：reduce 下开抽屉不应出现位移中间帧（允许不透明度淡入）
  const samples = []; let stop = false;
  const tick = () => { if (stop) return; samples.push({ o: +numv(cs(m).opacity).toFixed(3), x: +txOf(cs(d).transform).toFixed(1) }); requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  open();
  await sleep(700);
  stop = true;
  const xs = [...new Set(samples.map((p) => p.x))];
  const os = [...new Set(samples.map((p) => p.o))];
  chk(xs.length === 1 && xs[0] === 0, '⑤ reduce 下实测：无位移中间帧（transform 全程为 0）', { 位移序列去重: xs });
  chk(os.length >= 1, '⑤ reduce 下实测：淡入淡出仍保留（不透明度序列）', { 不透明度序列去重: os.slice(0, 6) });

  // 加了越界峰值之后要确认这条仍然成立：reduce 下涟漪整条被移除，不可能产生缩放中间值
  const probeRip = document.createElement('span');
  probeRip.className = 'fx-ripple';
  document.getElementById('stage').querySelector('.stage-fx').appendChild(probeRip);
  const ripDisplay = cs(probeRip).display;
  const ripAnimDur = cs(probeRip).animationDuration;
  probeRip.remove();
  chk(ripDisplay === 'none', '⑤ reduce 下涟漪被整条移除（display:none），不会产生缩放中间值',
    { display: ripDisplay, animationDuration: ripAnimDur });
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

async function main() {
  const root = process.cwd();
  const results = staticChecks(root);
  if (!EDGE) throw new Error('找不到 Edge/Chrome，可用 EDGE_BIN 环境变量指定路径');
  if (await cdpAlive()) {
    throw new Error(`CDP 端口 ${PORT} 上已经有别的浏览器在应答：先关掉它，或设 XM_CDP_PORT 换端口（否则断言会跑在别人身上）`);
  }

  const profile = mkdtempSync(join(tmpdir(), 'xm-motion-probe-'));
  const URL = `${ORIGIN}/index.html?motion=${TS}`;
  const child = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--mute-audio', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--remote-allow-origins=*', '--window-size=1280,820',
    `--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`,
    'about:blank',                       // 见文件头：真页面一律走 Page.navigate
  ], { stdio: 'ignore', windowsHide: true });

  let step = '启动无头 Edge';
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

    /** 关掉所有浮层：抽屉遮罩是 inset:0 的全屏层，开着的时候它才是 elementFromPoint 的结果，
     *  按压会打在遮罩上而不是按钮上 —— 按压反馈就永远测不到（这是探针的坑，不是产品的）。 */
    const closeOverlays = () => evaluate(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      window.dispatchEvent(new CustomEvent('xiaomo:settings', { detail: false }));
      window.dispatchEvent(new CustomEvent('xiaomo:plugins', { detail: false }));
      for (let i = 0; i < 40; i++) {
        if (!document.querySelector('.drawer-mask.show,.expel-mask.show,.about-mask.show')) break;
        await sleep(50);
      }
      return document.querySelectorAll('.drawer-mask.show,.expel-mask.show,.about-mask.show').length;
    })()`);

    /** 真实鼠标按压：`:active` 只能用真输入触发，合成事件不生效。
     *  松手点故意挪开 → 不生成 click，免得顺手把别人的抽屉点开。
     *  命中点也回传：失败时一眼能看出是「按到了别的东西」还是「:active 没生效」。 */
    const pressTransform = async (sel) => {
      const pt = await evaluate(`(() => { const b = document.querySelector(${JSON.stringify(sel)});`
        + ` if (!b) return null; const r = b.getBoundingClientRect();`
        + ` return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
      if (!pt) return null;
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y, buttons: 0 });
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', buttons: 1, clickCount: 1 });
      await sleep(160);
      const info = await evaluate(`(() => { const b = document.querySelector(${JSON.stringify(sel)});`
        + ` const hit = document.elementFromPoint(${pt.x}, ${pt.y});`
        + ` return { tf: getComputedStyle(b).transform,`
        + ` activeMatched: !!document.querySelector(${JSON.stringify(sel)} + ':active'),`
        + ` hit: hit ? (hit.id || hit.className || hit.tagName) : null }; })()`);
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x + 400, y: pt.y + 200, button: 'left', buttons: 0, clickCount: 1 });
      // 松手后再读一次：按下反馈是「按下缩小、松手回 1」两半，只读按下那一刻会漏掉后半句。
      // 等 240ms 让回弹过渡走完（--t-press 120ms），否则读到的是过渡途中的中间值。
      await sleep(240);
      const tfAfter = await evaluate(`(() => { const b = document.querySelector(${JSON.stringify(sel)});`
        + ` return b ? getComputedStyle(b).transform : null; })()`);
      return { ...info, tfAfter };
    };

    // 基线：明确关掉 reduced-motion，别让宿主系统设置污染 ①–④ 的采样
    await send('Emulation.setEmulatedMedia', { media: '', features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
    step = '导航到应用';
    await send('Page.navigate', { url: URL });
    await waitEvaluable(`?motion=${TS}`);
    step = '①–④⑦ 断言';
    results.push(...(await evaluate(SCRIPT_A, 180000)));

    step = '按压反馈（真实输入，no-preference）';
    await closeOverlays();
    const pressA = await pressTransform('.tb-btn');
    results.push({ ok: !!pressA && /matrix/.test(String(pressA.tf)), kind: 'requirement',
      label: '⑦ 按下反馈真实存在（:active 缩放，真实按压下 transform 非 none）',
      extra: { transform: pressA && pressA.tf, activeMatched: pressA && pressA.activeMatched, hit: pressA && pressA.hit } });

    // ⑧ 器材项按下反馈：与 .tb-btn/.tool-btn/.theme-dot 同类（0.97 档）。
    //    这条曾经缺失 —— .pitem:active 只有背景色、没有缩放，是这批可点元素里唯一没有按下反馈的，
    //    属于全局一致性的破口。必须用真鼠标输入：合成 PointerEvent 不触发 :active（见 ④b 观察项）。
    await closeOverlays();
    const scOf = (tf) => { const m = /matrix\(([^)]+)\)/.exec(String(tf)); return m ? Number(m[1].split(',')[0]) : null; };
    const pressC = await pressTransform('.pitem');
    // 「松手后回到 1」的实测形态是 transform:none —— .pitem 基态根本没声明 transform，
    // 所以过渡结束后计算值就是 none（等价于恒等变换），不是 matrix(1,0,0,1,0,0)。
    const backTo1 = (tf) => tf === 'none' || (scOf(tf) !== null && scOf(tf) >= 0.999);
    results.push({ ok: !!pressC && scOf(pressC.tf) !== null && Math.abs(scOf(pressC.tf) - 0.97) <= 0.006
        && backTo1(pressC.tfAfter),
      kind: 'requirement',
      label: '⑧ 器材项按下反馈：真实按压下 transform ≈ scale(.97)，松手后回到恒等（none/1）',
      extra: { 按下: pressC && pressC.tf, 按下缩放: pressC && scOf(pressC.tf),
        松手后: pressC && pressC.tfAfter, 松手后判定: pressC && backTo1(pressC.tfAfter),
        activeMatched: pressC && pressC.activeMatched, hit: pressC && pressC.hit } });

    step = '⑤ reduced-motion 段';
    await send('Emulation.setEmulatedMedia', { media: '', features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await sleep(300);
    results.push(...(await evaluate(SCRIPT_B, 60000)));

    step = '按压反馈（真实输入，reduce）';
    await closeOverlays();
    const pressB = await pressTransform('.tb-btn');
    results.push({ ok: !!pressB && pressB.tf === 'none', kind: 'requirement',
      label: '⑤ reduce 下按压态缩放被移除（transform 恒为 none）——正确判据',
      extra: { noPreference: pressA && pressA.tf, reduce: pressB && pressB.tf,
        activeMatched: pressB && pressB.activeMatched, hit: pressB && pressB.hit } });

    // ⑧ reduce 下的器材项：判据与 .tb-btn 一致 —— 新加的 :active 缩放必须被 reduce 块吃掉。
    //    main.css 末尾 @media (prefers-reduced-motion: reduce) 的 :active 选择器列表里已含 .pitem:active。
    await closeOverlays();
    const pressD = await pressTransform('.pitem');
    results.push({ ok: !!pressD && pressD.tf === 'none' && pressD.tfAfter === 'none', kind: 'requirement',
      label: '⑧ reduce 下器材项按下缩放被移除（transform 恒为 none）——硬要求',
      extra: { noPreference: pressC && pressC.tf, reduce: pressD && pressD.tf,
        reduce松手后: pressD && pressD.tfAfter,
        activeMatched: pressD && pressD.activeMatched, hit: pressD && pressD.hit } });
  } catch (e) {
    fatal = e;
  } finally {
    try { if (ws) ws.close(); } catch { /* 已经断了 */ }
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    await sleep(600);
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* Windows 偶尔还占着 */ }
  }

  const bad = results.filter((r) => !r.ok);
  const findings = bad.filter((r) => r.kind === 'requirement');
  const bugs = bad.filter((r) => r.kind !== 'requirement');

  if (fatal) {
    // 没跑完的运行绝不能伪装成「跑完了但有失败」
    console.error(`探针在「${step}」这一步失败：${fatal && fatal.message ? fatal.message : fatal}`);
    console.error('成因提示：导航竞态（-32000 / Execution context destroyed）已由「about:blank 启动 → Page.navigate → 轮询 marker+readyState」消除；'
      + '若仍出现，确认这个 CDP 端口没连到别的浏览器实例（设 XM_CDP_PORT 换端口），以及 7373 静态服务在跑。');
    for (const r of results) console.log(`${r.ok ? '  PASS' : '  FAIL'}  ${r.label}`);
    console.error(`\n动作探针：跑到第 ${results.length} 项后中断，结论不可用（exit 2）`);
    return 2;
  }

  for (const r of results) {
    console.log(`${r.ok ? '  PASS' : '  FAIL'}  ${r.label}`);
    if (!r.ok && r.extra !== null) console.log(`        ↳ ${JSON.stringify(r.extra)}`);
  }
  console.log('\nMOTION_JSON ' + JSON.stringify({
    ok: bad.length === 0, pass: results.length - bad.length, fail: bad.length,
    findings: findings.map((r) => r.label), probeBugs: bugs.map((r) => r.label),
    checks: results.map((r) => ({ ok: r.ok, kind: r.kind, label: r.label, extra: r.extra })),
    note: '无头证明不了：真机 120Hz 跟手性、GPU 合成路径的实际帧率、HDR/色彩管理下的观感',
  }));
  console.log(`动作探针：共 ${results.length} 项，失败 ${bad.length} 项`
    + `（未满足的需求 ${findings.length} 项 / 探针自身问题 ${bugs.length} 项）`);
  return bad.length ? 1 : 0;
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((e) => { console.error('探针跑不起来：' + (e && e.message ? e.message : e)); process.exitCode = 2; });
