// ══════════════════════════════════════════════════════════
// 插件市场界面：发现 / 已安装 / 来源
//
// 三条分工，和其他界面插件保持同一口径：
//   目录与安装的**真值**归 src/core/market.js（本文件不自己发明状态）；
//   已安装的**真值**归 app.inventory.snapshot()（清单服务，不另建一套）；
//   本文件只负责把这两份只读数据画出来，以及把用户的点击翻译成服务调用。
//
// 安全口径（不许含糊）：
//   · 只收 HTTPS（唯一的例外是回环地址上的开发来源，界面上会打「本地开发」）；
//   · 安装前必须过一次确认框，确认框里显示名称/发布者/来源/字节数/哈希校验结果；
//   · 哈希不符一律拒绝安装，错误原文照显示；
//   · 行上如实标出「第三方代码」—— 非内置来源的代码没有经过本仓库 PR 审核；
//   · 页脚那句人话必须一直在：同源脚本能读本地数据，浏览器隔离不了它，
//     sha256 只防传输/镜像篡改，防不了索引维护者。
//
// 样式：只复用已有的 .drawer-* / .tb-* / .plug-* / .mini-btn，不往 styles/main.css 里加东西
// （那条文件正被别的改动占用）。缺的样式见 plans/05-插件市场设计.md 的「待合并样式」一节。
// ══════════════════════════════════════════════════════════

import { MarketClient, defaultManifestUrl } from '../core/market.js';

const SELF_ID = 'xiaomo.ui.market';

/** 目录里远程字符串一律当不可信纯文本：只用 textContent 写，绝不拼 HTML */
const txt = (el, s) => { el.textContent = s == null ? '' : String(s); return el; };
const el = (tag, cls, s) => { const n = document.createElement(tag); if (cls) n.className = cls; if (s != null) txt(n, s); return n; };

const KIND_TEXT = {
  ui: '界面', system: '系统', equipment: '器材', theme: '主题',
  rules: '规则', chemistry: '化学', content: '内容', misc: '其他',
};

export default {
  id: SELF_ID,
  name: '插件市场',
  version: '1.0.0',
  kind: 'ui',
  desc: '浏览社区目录（DSH 兼容的 catalog-provider 契约）、校验 sha256 后安装第三方插件、管理目录来源',
  author: '小墨实验室',
  builtin: true,
  tags: ['界面', '市场', '插件'],
  setup(ctx) {
    const app = ctx.app;
    const inv = app.inventory;              // 已安装的唯一真值（只读快照）

    const market = new MarketClient({ app });
    // 共享给别的插件与控制台：探针就是从这里拿客户端的，界面自己没有第二条数据路径
    app.services.market = market;
    market.seedDefaultSource(defaultManifestUrl());

    // ── 界面状态（跨「顶栏」「浮层」两个插槽回调共享，所以放在 setup 作用域）──
    let tab = 'discover';
    let built = false;
    let mask = null;
    let subEl = null;
    const panes = {};
    const tabs = {};
    let selectedSource = null;              // 当前选中的来源 id
    let catalog = null;                     // 当前来源已拉到的目录
    let busy = false;                       // 有网络操作在跑（按钮禁用 + 状态行显示）
    let status = '';                        // 状态行文字（成功/失败都照实写）
    let confirmDeal = null;                 // 正在等用户确认的条目
    let preview = null;                     // 该条目的安装预览（字节数/哈希对比）
    let query = '';                         // 本地搜索词（静态托管没有服务端筛选）
    const autoTried = new Set();            // 已自动拉取过的来源：避免失败后无限重试

    // ── 公共小件 ───────────────────────────────────────────
    const badge = (text, cls = 'plug-chip soft') => el('span', cls, text);

    const setStatus = (s) => { status = s || ''; paintStatus(); };

    function paintStatus() {
      const box = panes[tab] && panes[tab].querySelector('[data-status]');
      if (!box) return;
      txt(box, status);
      box.hidden = !status;
    }

    const run = async (label, fn) => {
      if (busy) return null;
      busy = true;
      setStatus(label + '…');
      try {
        const r = await fn();
        return r;
      } catch (e) {
        setStatus((e && e.message) || String(e));
        return null;
      } finally {
        busy = false;
        paint();
      }
    };

    // ── 已安装数据：真值来自清单快照 ────────────────────────
    const installedView = () => {
      const snap = inv.snapshot();
      const byId = new Map(snap.items.map((it) => [it.id, it]));
      return market.installedList().map((rec) => ({ rec, item: byId.get(rec.id) || null }));
    };

    // ══════════════════════════════════════════════════════
    // 发现
    // ══════════════════════════════════════════════════════
    function paintDiscover() {
      const box = panes.discover;
      box.textContent = '';

      const bar = el('div', 'tb-group');
      const sel = el('select', 'tb-select');
      sel.setAttribute('aria-label', '选择目录来源');
      for (const s of market.listSources()) {
        const o = el('option', null, `${s.name}${s.dev ? '（本地开发）' : ''}`);
        o.value = s.id;
        sel.appendChild(o);
      }
      sel.value = selectedSource || (market.listSources()[0] ? market.listSources()[0].id : '');
      sel.addEventListener('change', () => {
        selectedSource = sel.value;
        catalog = market.cachedCatalog(selectedSource);
        setStatus('');
        paint();
        ensureCatalog();
      });
      bar.appendChild(sel);

      const search = el('input', 'tb-select');
      search.type = 'search';
      search.placeholder = '本地筛选标题 / 关键词…';
      search.value = query;
      search.setAttribute('aria-label', '筛选目录条目');
      search.addEventListener('input', () => { query = search.value; paintDiscover(); });
      bar.appendChild(search);

      const refresh = el('button', 'mini-btn', '刷新目录');
      refresh.dataset.act = 'refresh';
      refresh.disabled = busy;
      refresh.addEventListener('click', () => run('正在拉取目录', () => loadCatalog(true)));
      bar.appendChild(refresh);
      box.appendChild(bar);

      if (!market.listSources().length) {
        const p = el('p', 'drawer-hint', '还没有任何来源。到「来源」页登记一个目录 manifest，或恢复内置来源。');
        box.appendChild(p);
      }

      const st = el('p', 'drawer-hint');
      st.dataset.status = '1';
      st.hidden = !status;
      txt(st, status);
      box.appendChild(st);

      if (!catalog) {
        const sid = selectedSource || (market.listSources()[0] && market.listSources()[0].id);
        if (market.listSources().length) {
          if (autoTried.has(sid) && !busy) {
            // 自动拉取只做一次：失败后不能每次重画都再打一轮请求（那会变成请求风暴），
            // 要不要重试是用户的事 —— 上面就有「刷新目录」按钮。
            box.appendChild(el('p', 'drawer-hint', '这个来源的目录没拉到（原因见上面的提示），点「刷新目录」可以重试。'));
          } else {
            box.appendChild(el('p', 'drawer-hint', '这个来源的目录还没拉到，正在拉…'));
            ensureCatalog();
          }
        }
        return;
      }

      // 本地筛选：静态托管给不出服务端查询，所以 manifest 的 query.supported 如实写成 []
      const kw = query.trim().toLowerCase();
      const items = catalog.items.filter((it) => {
        if (!kw) return true;
        const hay = [it.displayName, it.name, it.id, it.summary, (it.categories || []).join(' '), (it.keywords || []).join(' ')].join(' ').toLowerCase();
        return hay.includes(kw);
      });
      const head = el('p', 'drawer-hint',
        `来源「${catalog.source.name}」共 ${catalog.items.length} 条，显示 ${items.length} 条`
        + (catalog.extensions.found ? '' : '；该来源没有提供小墨安装信息（缺 xiaomo-extensions.json），条目只能浏览不能安装'));
      box.appendChild(head);

      for (const it of items) box.appendChild(renderItem(it));
    }

    function renderItem(it) {
      const row = el('div', 'plug-row mk-item');
      row.dataset.id = it.id;

      const main = el('div', 'plug-main');
      const title = el('div', 'plug-title');
      title.appendChild(el('b', null, it.displayName));
      title.appendChild(el('span', 'plug-id', it.name));
      if (it.latestVersion) title.appendChild(el('span', 'plug-ver', 'v' + it.latestVersion));
      const entry = it.entry || {};
      if (entry.available) {
        const ph = el('span', 'plug-phase', KIND_TEXT[entry.kind] || entry.kind || '插件');
        ph.dataset.phase = 'active';
        title.appendChild(ph);
      } else {
        const ph = el('span', 'plug-phase', '不可安装');
        ph.dataset.phase = 'failed';
        title.appendChild(ph);
      }
      main.appendChild(title);
      main.appendChild(el('p', 'plug-desc', it.summary));

      const meta = el('div', 'plug-meta');
      const inst = market.getInstalled(entry.pluginId || '');
      if (inst) meta.appendChild(badge('已安装 v' + inst.version));
      for (const c of (it.categories || []).slice(0, 3)) meta.appendChild(badge(c));
      // 「第三方代码」徽标：非内置来源 = 没经过本仓库审核，行上必须看得出来
      if (it.thirdParty) meta.appendChild(badge('第三方代码', 'plug-chip bad'));
      if (it.devSource) meta.appendChild(badge('本地开发来源'));
      if (it.publisher && it.publisher.name) meta.appendChild(badge(it.publisher.name));
      main.appendChild(meta);

      if (!entry.available) main.appendChild(el('p', 'plug-note', entry.issue || '不可安装'));
      else if (entry.notes) main.appendChild(el('p', 'plug-note', entry.notes));
      row.appendChild(main);

      const btn = el('button', 'mini-btn', inst ? '重新安装' : '安装');
      btn.dataset.act = 'install';
      btn.disabled = !entry.available || busy;
      btn.addEventListener('click', () => askConfirm(it));
      row.appendChild(btn);
      return row;
    }

    /** 安装前的确认：先把代码拉下来算哈希，把「你将要装什么」摆在人眼前 */
    async function askConfirm(deal) {
      confirmDeal = deal;
      preview = null;
      await run('正在拉取并校验', async () => {
        preview = await market.installCheck(deal);
        setStatus('');
      });
      paint();
    }

    function paintConfirm() {
      const box = panes.discover;
      box.textContent = '';
      const deal = confirmDeal;
      const p = preview;

      const card = el('section', 'plug-sec');
      card.appendChild(el('h3', null, `确认安装：${deal.displayName}`));

      const rows = [
        ['插件 id', (p && p.pluginId) || (deal.entry && deal.entry.pluginId) || '（未声明）'],
        ['版本', (p && p.version) || '（未声明）'],
        ['发布者', (p && p.publisher) || '（未声明）'],
        ['来源', (p && p.sourceName) || ''],
        ['manifest', (p && p.sourceUrl) || ''],
        ['代码地址', (p && p.entryUrl) || ''],
        ['文件大小', p ? `${p.bytes} 字节` + (p.declaredBytes ? `（目录声明 ${p.declaredBytes}）` : '') : '未知'],
        ['sha256 校验', p ? (p.hashOk ? '通过：实际字节的哈希与目录声明一致' : '不通过：实际字节与目录声明不一致') : '未知'],
        ['目录声明', p ? p.declaredSha : ''],
        ['实际算出', p ? p.actualSha : ''],
      ];
      if (p && p.notes) rows.push(['作者说明', p.notes]);

      const list = el('div');
      for (const [k, v] of rows) {
        const line = el('p', 'drawer-sub');
        line.appendChild(el('span', null, k + '：'));
        line.appendChild(el('code', null, v));
        list.appendChild(line);
      }
      card.appendChild(list);

      const warn = el('p', 'plug-note',
        '这段代码会作为本页面的同源脚本运行：它能读到你存在本地的数据（实验台状态、插件设置等），'
        + '浏览器无法把它和本页面隔离开。sha256 只能证明「你拿到的字节和目录里声明的一致」，'
        + '防不了传输/镜像之外的篡改，也防不了索引维护者本身。');
      card.appendChild(warn);

      const actions = el('div', 'tb-group');
      const ok = el('button', 'mini-btn', '确认安装');
      ok.dataset.act = 'confirm';
      ok.disabled = !(p && p.hashOk) || busy;
      ok.addEventListener('click', () => doInstall(deal));
      const no = el('button', 'mini-btn', '取消');
      no.dataset.act = 'cancel';
      no.addEventListener('click', () => { confirmDeal = null; preview = null; paint(); });
      actions.appendChild(ok);
      actions.appendChild(no);
      if (p && !p.hashOk) {
        actions.appendChild(el('span', 'plug-chip bad', '哈希不符，安装已被禁用'));
      }
      card.appendChild(actions);

      box.appendChild(card);
    }

    async function doInstall(deal) {
      const r = await run(`正在安装 ${deal.displayName}`, () => market.install(deal));
      if (r && r.ok) {
        confirmDeal = null; preview = null;
        tab = 'installed';
        setStatus(`已安装 ${deal.displayName}（v${r.version}）。卸载时它的贡献与界面会当场被拆掉；`
          + '代码字节仍会留在内存里直到刷新页面 —— ESM 没有卸载 API，这一点不骗你。');
        app.toast(`已安装插件：${deal.displayName}`);
      }
      paint();
    }

    async function loadCatalog(force = false) {
      const id = selectedSource || (market.listSources()[0] && market.listSources()[0].id);
      if (!id) { setStatus('还没有登记任何来源。'); return null; }
      selectedSource = id;
      if (force) catalog = null;
      catalog = await market.fetchCatalog(id);
      if (catalog.extensions.error) {
        setStatus(`目录已拉到，但旁挂安装信息有问题：${catalog.extensions.error}`);
      } else {
        setStatus('');
      }
      return catalog;
    }

    // 打开抽屉时按需拉一次：不在插件装载期间联网（装载必须在无网环境里也能过）。
    // autoTried 保证「自动拉取」每个来源只发生一次，失败不会变成请求风暴。
    function ensureCatalog() {
      const id = selectedSource || (market.listSources()[0] && market.listSources()[0].id);
      if (!id || catalog || busy || autoTried.has(id)) return;
      if (typeof fetch !== 'function') { setStatus('当前环境没有 fetch，拉不到目录。'); return; }
      autoTried.add(id);
      run('正在拉取目录', () => loadCatalog(false));
    }

    // ══════════════════════════════════════════════════════
    // 已安装
    // ══════════════════════════════════════════════════════
    function paintInstalled() {
      const box = panes.installed;
      box.textContent = '';
      const rows = installedView();

      const bar = el('div', 'tb-group');
      const check = el('button', 'mini-btn', '检查更新');
      check.dataset.act = 'check-updates';
      check.disabled = busy || !market.listSources().length;
      check.addEventListener('click', () => run('正在检查更新', async () => {
        const src = selectedSource || market.listSources()[0].id;
        const ups = await market.checkUpdates(src);
        setStatus(ups.length
          ? `发现 ${ups.length} 个更新：` + ups.map((u) => `${u.id} ${u.from}→${u.to}`).join('、')
          : '已装插件都是目录里的最新版本。');
        return ups;
      }));
      bar.appendChild(check);
      box.appendChild(bar);

      const st = el('p', 'drawer-hint');
      st.dataset.status = '1';
      st.hidden = !status;
      txt(st, status);
      box.appendChild(st);

      if (!rows.length) {
        box.appendChild(el('p', 'drawer-hint', '还没有从市场装过插件。「发现」页里挑一个装上试试。'));
        return;
      }

      const head = el('p', 'drawer-hint',
        `来自市场的插件 ${rows.length} 个（阶段读的是清单服务的快照，本页不另存一份状态）`);
      box.appendChild(head);

      for (const { rec, item } of rows) {
        const row = el('div', 'plug-row mk-item');
        row.dataset.id = rec.id;
        const main = el('div', 'plug-main');
        const title = el('div', 'plug-title');
        title.appendChild(el('b', null, rec.name));
        title.appendChild(el('span', 'plug-id', rec.id));
        title.appendChild(el('span', 'plug-ver', 'v' + rec.version));
        const ph = el('span', 'plug-phase', item ? ({ active: '活跃', pending: '待装', loading: '装载中', failed: '失败', unloading: '卸载中' }[item.phase] || item.phase) : '不在清单里');
        ph.dataset.phase = item ? item.phase : 'failed';
        title.appendChild(ph);
        main.appendChild(title);
        main.appendChild(el('p', 'plug-desc', `来源：${rec.sourceName || rec.sourceId || '（已移除的来源）'} · 装于 ${rec.installedAt || '未知时间'}`));
        const meta = el('div', 'plug-meta');
        meta.appendChild(badge(KIND_TEXT[rec.kind] || rec.kind || '插件'));
        if (item && item.contributions) meta.appendChild(badge(`${item.contributions} 项贡献`));
        if (item && item.error) meta.appendChild(badge('装载失败：' + item.error, 'plug-chip bad'));
        if (!item) meta.appendChild(badge('已不在宿主清单里', 'plug-chip bad'));
        main.appendChild(meta);
        row.appendChild(main);

        const un = el('button', 'mini-btn', '卸载');
        un.dataset.act = 'uninstall';
        un.disabled = busy;
        un.addEventListener('click', () => {
          market.uninstall(rec.id);
          setStatus(`已卸载 ${rec.name}：宿主贡献与界面已拆干净，本地记录已删除。`
            + '注意代码字节仍留在内存里直到刷新页面（ESM 没有卸载 API）。');
          app.toast(`已卸载插件：${rec.name}`);
          paint();
        });
        row.appendChild(un);
        box.appendChild(row);
      }
    }

    // ══════════════════════════════════════════════════════
    // 来源
    // ══════════════════════════════════════════════════════
    function paintSources() {
      const box = panes.sources;
      box.textContent = '';

      const form = el('div', 'tb-group');
      const input = el('input', 'tb-select');
      input.type = 'url';
      input.placeholder = 'https://…/catalog-source.json';
      input.setAttribute('aria-label', '来源 manifest 地址');
      form.appendChild(input);
      const add = el('button', 'mini-btn', '登记来源');
      add.dataset.act = 'add-source';
      add.disabled = busy;
      const doAdd = async () => {
        const url = input.value.trim();
        if (!url) return;
        const r = await run('正在校验这个来源', () => market.addSource(url));
        if (r) { input.value = ''; setStatus(`来源已登记：${r.name}`); }
        paint();
      };
      add.addEventListener('click', doAdd);
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') doAdd(); });
      form.appendChild(add);
      box.appendChild(form);

      const st = el('p', 'drawer-hint');
      st.dataset.status = '1';
      st.hidden = !status;
      txt(st, status);
      box.appendChild(st);

      for (const s of market.listSources()) {
        const row = el('div', 'plug-row mk-source-row');
        row.dataset.id = s.id;
        const main = el('div', 'plug-main');
        const title = el('div', 'plug-title');
        title.appendChild(el('b', null, s.name));
        if (s.bundled) title.appendChild(badge('内置（经 PR 审核）'));
        if (!s.bundled) title.appendChild(badge('第三方来源', 'plug-chip bad'));
        if (s.dev) title.appendChild(badge('本地开发'));
        main.appendChild(title);
        main.appendChild(el('p', 'plug-desc', s.url));
        const meta = el('div', 'plug-meta');
        meta.appendChild(badge(s.providerId || '未声明 providerId'));
        meta.appendChild(badge(s.endpoint || '（endpoint 未知）'));
        main.appendChild(meta);
        row.appendChild(main);

        const rm = el('button', 'mini-btn', '移除');
        rm.dataset.act = 'remove-source';
        rm.addEventListener('click', () => {
          market.removeSource(s.id);
          if (selectedSource === s.id) { selectedSource = null; catalog = null; }
          // 「移除来源」不等于「卸载从它装的插件」，这句必须写出来
          setStatus(`已移除来源「${s.name}」。从它装上的插件不会被自动卸载 —— 那是对已装插件的独立决定，去「已安装」页处理。`);
          paint();
        });
        row.appendChild(rm);
        box.appendChild(row);
      }

      const howto = el('section', 'plug-sec');
      howto.appendChild(el('h3', null, '怎么把自己的目录接进来'));
      howto.appendChild(el('p', 'plug-desc',
        '目录格式沿用 DSH 的 catalog-provider 契约：manifest 声明一个 GET 端点，'
        + '端点是一页 JSON（schemaVersion / items / page）；浏览器要的单文件 ESM 入口、sha256、kind '
        + '写在同一个 origin 的 xiaomo-extensions.json 里。字段名与 DSH 一致，所以同一份目录 DSH 也能读。'));
      howto.appendChild(el('p', 'plug-desc',
        '只有 HTTPS 会被接受（本机回环地址上的 http 仅作为开发例外）。'
        + '如果网页读不到你的来源，多半是它没给 CORS 头 —— 那样提示会如实写成「这个来源不允许跨站读取」，'
        + '不会伪装成空目录。'));
      box.appendChild(howto);
    }

    // ══════════════════════════════════════════════════════
    // 骨架
    // ══════════════════════════════════════════════════════
    function paint() {
      if (!built) return;
      for (const k of Object.keys(panes)) {
        const on = k === tab;
        panes[k].hidden = !on;
        if (tabs[k]) {
          tabs[k].classList.toggle('primary', on);
          tabs[k].classList.toggle('active', on);
          tabs[k].setAttribute('aria-selected', String(on));
        }
      }
      if (tab === 'discover') { if (confirmDeal) paintConfirm(); else paintDiscover(); }
      else if (tab === 'installed') paintInstalled();
      else paintSources();

      const n = market.listSources().length;
      const inst = market.installedList().length;
      txt(subEl, `${n} 个来源 · 已从市场安装 ${inst} 个插件`
        + (busy ? ' · 正在忙' : ''));
    }

    // ══════════════════════════════════════════════════════
    // 浮层开关 + 过渡时序（与插件管理器同一套：读计算出来的过渡时长，不写死毫秒）
    //
    // 为什么这些必须待在插槽回调**外面**：宿主每次重渲染 overlay 槽都会再调一次回调，
    // 在回调里 addEventListener(window) 会一次比一次多，而回收只发生在插件卸载时。
    // 放在 setup 作用域里注册一次，抽屉的 DOM 被铲掉重建也不影响开关逻辑。
    // ══════════════════════════════════════════════════════
    const EXIT_SLACK = 80;
    const toMs = (v) => { const n = parseFloat(v) || 0; return /ms\s*$/.test(String(v).trim()) ? n : n * 1000; };
    const exitMs = (root) => {
      let max = 0;
      for (const e of [root, root.firstElementChild]) {
        if (!e) continue;
        for (const d of getComputedStyle(e).transitionDuration.split(',')) max = Math.max(max, toMs(d));
      }
      return max + EXIT_SLACK;
    };
    const canInert = typeof HTMLElement !== 'undefined' && 'inert' in HTMLElement.prototype;
    let isOpen = false;        // 抽屉该不该开着：意图存在插件作用域，不依赖 DOM 节点存活
    let closing = 0;
    let restoreFocus = null;
    const cancelClose = () => { if (closing) { clearTimeout(closing); closing = 0; } };
    const shellOf = () => document.getElementById('app');
    const lockBg = () => { const s = shellOf(); if (!s) return; if (canInert) s.inert = true; else s.setAttribute('aria-hidden', 'true'); };
    const unlockBg = () => {
      const s = shellOf();
      if (!s) return;
      // 别的浮层还开着就别解锁，否则会把它们背后的内容也一起解锁
      if (document.querySelector('.drawer-mask.show,.expel-mask.show,.about-mask.show')) return;
      if (canInert) s.inert = false; else s.removeAttribute('aria-hidden');
    };
    const firstFocusable = () => (mask ? mask.querySelector('button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])') : null);

    function open() {
      if (!mask) return;
      cancelClose();
      restoreFocus = document.activeElement;
      isOpen = true;
      if (!mask.classList.contains('show')) mask.classList.remove('in');
      mask.classList.add('show');
      void mask.offsetWidth;
      mask.classList.add('in');
      lockBg();
      paint();
      ensureCatalog();
      const t = firstFocusable();
      if (t && t.focus) t.focus({ preventScroll: true });
    }

    function close() {
      const m = mask;
      if (!m || !m.classList.contains('show')) { isOpen = false; unlockBg(); return; }
      isOpen = false;
      m.classList.remove('in');
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        m.removeEventListener('transitionend', onEnd);
        clearTimeout(closing);
        closing = 0;
        // 只有当 mask 还是当前这棵（没被宿主重渲染换掉）时才需要收尾
        if (m === mask && !m.classList.contains('in')) m.classList.remove('show');
        unlockBg();
        if (restoreFocus && restoreFocus.focus) restoreFocus.focus({ preventScroll: true });
        restoreFocus = null;
      };
      const onEnd = (e) => {
        if (e.target !== m && !m.contains(e.target)) return;
        if (e.propertyName !== 'transform' && e.propertyName !== 'opacity') return;
        finish();
      };
      m.addEventListener('transitionend', onEnd);
      closing = setTimeout(finish, exitMs(m));
    }

    const onMarket = (e) => { if (e.detail) open(); else close(); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    window.addEventListener('xiaomo:market', onMarket);
    window.addEventListener('keydown', onKey);
    ctx.onDispose(() => window.removeEventListener('xiaomo:market', onMarket));
    ctx.onDispose(() => window.removeEventListener('keydown', onKey));

    ctx.slot('topbar.right', (host) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'tb-btn';
      b.id = 'btnMarket';
      b.title = '插件市场';
      b.textContent = '🛒';
      b.addEventListener('click', () => window.dispatchEvent(new CustomEvent('xiaomo:market', { detail: true })));
      host.appendChild(b);
    }, { order: 50 });

    ctx.slot('overlay', (hostEl) => {
      cancelClose();                       // 旧节点马上被换掉，它那次退场动画作废
      // 宿主重渲染时不保证先把这一槽清空（内核正在改这块，见 task-7），
      // 所以自己收尾：上一棵树还挂在文档里就先摘掉，免得留下几层看不见的空浮层。
      if (mask && mask.parentNode) mask.parentNode.removeChild(mask);
      mask = document.createElement('div');
      mask.className = 'drawer-mask';
      mask.innerHTML = `
        <aside class="drawer" role="dialog" aria-modal="true" aria-label="插件市场">
          <header class="drawer-head">
            <div>
              <h2>插件市场</h2>
              <p class="drawer-sub"><span data-sub></span></p>
            </div>
            <button type="button" class="drawer-x" title="关闭">✕</button>
          </header>
          <div class="drawer-body"></div>
          <footer class="drawer-foot">
            <span class="drawer-hint">第三方插件会作为本站同源脚本运行，能读到你存在本地的数据，浏览器无法隔离它。
              sha256 只证明「拿到的字节与目录声明一致」，防不了索引维护者本身。
              内置目录的条目经本仓库 PR 审核；自加来源的条目会标出「第三方代码」。</span>
          </footer>
        </aside>`;
      hostEl.appendChild(mask);

      const body = mask.querySelector('.drawer-body');
      subEl = mask.querySelector('[data-sub]');

      const tabBar = el('div', 'tb-group');
      for (const [key, label] of [['discover', '发现'], ['installed', '已安装'], ['sources', '来源']]) {
        const b = el('button', 'tb-btn mk-tab', label);
        b.type = 'button';
        b.dataset.tab = key;
        b.addEventListener('click', () => { tab = key; confirmDeal = null; preview = null; setStatus(''); paint(); });
        tabs[key] = b;
        tabBar.appendChild(b);
      }
      body.appendChild(tabBar);

      for (const key of ['discover', 'installed', 'sources']) {
        const p = el('div', 'mk-pane');
        p.dataset.pane = key;
        panes[key] = p;
        body.appendChild(p);
      }
      // 这两个监听器绑在**当前这棵** DOM 上：节点被换掉就跟着没了，不会累积
      mask.querySelector('.drawer-x').addEventListener('click', close);
      mask.addEventListener('click', (e) => { if (e.target === mask) close(); });

      built = true;
      // 宿主重渲染 overlay 槽时会先 innerHTML='' 再调本回调（内核正在修这个根因，见 task-7）。
      // 「抽屉本来是开着的」这个意图存在插件作用域里，所以在这里补回来 ——
      // 否则用户正看着安装结果，抽屉会自己消失。修复落地后本行自然变成 no-op。
      if (isOpen) { mask.classList.add('in'); mask.classList.add('show'); lockBg(); }
      paint();
      const first = firstFocusable();
      if (isOpen && first && first.focus) first.focus({ preventScroll: true });
    }, { order: 40 });

    // 两份只读数据谁变了都重画一次：界面不需要轮询，也不自己缓存
    ctx.onDispose(market.onChange(() => paint()));
    ctx.onDispose(inv.onChange(() => paint()));
  },
};
