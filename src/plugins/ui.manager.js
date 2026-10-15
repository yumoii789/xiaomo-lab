// 插件管理器：只读消费 app.inventory 的清单快照，做两级启停（包 / 单项）。
//
// 为什么不问宿主、也不碰 localStorage：
//   读只走清单快照 —— 启停选择归 PluginState 所有，它还负责把旧键
//   `xiaomo.plugins.disabled` 迁进新结构；界面再往旧键写，就是替用户撒一个他没做过的谎。
//   启停只走 host.disable/enable + pluginState.set*：宿主记录是「本次启动的既成事实」，
//   只改 pluginState 不会让清单变，两边必须一起驱动。
//
// 为什么行元素按 id 缓存、只做增量更新：
//   整表重建会让新节点一创建就带着目标 class，开关的过渡永远不播放；
//   重建还会把用户正在操作的那个按钮连焦点一起丢掉。

const KIND_NAME = {
  core: '内核能力', theme: '主题', equipment: '器材',
  rules: '规则', system: '系统', ui: '界面', content: '内容', misc: '其他',
};
const KIND_ORDER = ['core', 'equipment', 'rules', 'system', 'ui', 'content', 'theme', 'misc'];

/** 管理器自己：由外壳承载。关掉「界面」包时必须把它排除，否则用户会把自己锁在门外。 */
const SELF_ID = 'xiaomo.ui.manager';

/** 阶段 → 中文文案。词表归内核（快照 counts 的键就是这五个词），这里只管怎么显示。 */
const PHASE_TEXT = {
  active: '活跃', pending: '待装', loading: '装载中', failed: '失败', unloading: '卸载中',
};
/** 顶部计数的显示顺序：先常态、再过渡态、最后失败（与词表顺序不同，是有意的）。 */
const PHASE_ORDER = ['active', 'pending', 'loading', 'failed', 'unloading'];

export default {
  id: SELF_ID,
  name: '插件管理器',
  version: '1.1.0',
  kind: 'ui',
  desc: '查看每个插件的阶段与贡献，按「包 / 单项」两级启停，开关当场生效',
  author: '小墨实验室',
  builtin: true,
  tags: ['界面', '插件'],
  setup(ctx) {
    const app = ctx.app;
    const host = app.host;           // 只用来驱动启停，不用来读数据
    const inv = app.inventory;       // 唯一数据源（冻结的只读快照）
    const pstate = app.pluginState;  // 启停选择（两级 + 持久化）

    // ── 界面状态：跨「顶栏」「浮层」两个插槽回调共享，所以放在 setup 作用域 ──
    let built = false;               // 抽屉 DOM 建过没有
    let body = null;                 // 抽屉正文容器
    let bucketsEl = null;            // 顶部分桶计数容器
    let totalEl = null;              // 顶部「共 N 个 · 贡献 M 项」
    const parts = new Map();         // id   -> 行元素引用
    const secs = new Map();          // kind -> 分组（含包级开关）
    const cnts = new Map();          // phase -> 计数里的数字节点
    // overlay 槽会被宿主整槽重渲染（别处一增删 overlay 项，main.js 收到 slot:changed 就把
    // 这一槽清空重建），所以「抽屉该开着」和「关掉后焦点回到哪」这两个意图必须活在 setup
    // 作用域：只放在渲染闭包里，用户拨一下包级开关抽屉就会自己关掉、焦点也回不到 🧩。
    let wantOpen = false;
    let restoreFocus = null;
    let trigger = null;              // 当前这一枚 🧩 按钮（顶栏也会被整槽重渲染换掉）
    let drawer = null;               // 当前这一份抽屉的 open / close

    // 就地改 DOM 时先比一下值：值没变就不写。不写不是抠性能 ——
    // 反复写同样的 attribute / textContent 会平白制造大量变更记录与一次样式结算，
    // 而「快照变了就只改动的那几处」正是这一版要证明的事。
    const setText = (el, text) => { if (el.textContent !== text) el.textContent = text; };
    const setAttr = (el, name, value) => { if (el.getAttribute(name) !== value) el.setAttribute(name, value); };

    const kindRank = (kind) => {
      const i = KIND_ORDER.indexOf(kind);
      return i < 0 ? KIND_ORDER.length : i;   // 不认识的种类排最后，不吞
    };

    // ── 顶部：分桶计数 + 总贡献 ──────────────────────────────
    const ensureCounter = (phase) => {
      let num = cnts.get(phase);
      if (!num) {
        // 清单里出现了词表之外的阶段也照样报数：漏一个桶比多一个桶糟得多
        const wrap = document.createElement('span');
        wrap.className = 'plug-cnt';
        wrap.dataset.phase = phase;
        num = document.createElement('b');
        num.textContent = '0';
        wrap.append(num, document.createTextNode(' ' + (PHASE_TEXT[phase] || phase)));
        bucketsEl.appendChild(wrap);
        cnts.set(phase, num);
      }
      return num;
    };

    const paintHead = (snap) => {
      for (const [phase, n] of Object.entries(snap.counts)) setText(ensureCounter(phase), String(n));
      let contributions = 0;
      for (const it of snap.items) contributions += it.contributions;
      setText(totalEl, `共 ${snap.total} 个插件 · 贡献 ${contributions} 项能力`);
    };

    // ── 分组：一个 kind 一段，段头带包级开关 ────────────────
    const ensureSection = (kind) => {
      let s = secs.get(kind);
      if (s) return s;
      const el = document.createElement('section');
      el.className = 'plug-sec';
      el.dataset.kind = kind;
      el.innerHTML = `
        <div class="plug-sec-head">
          <h3><span class="plug-sec-name"></span><em>0</em></h3>
          <button type="button" class="plug-switch sm pkg-switch" role="switch"><i></i></button>
        </div>
        <div class="plug-sec-list"></div>`;
      const name = KIND_NAME[kind] || kind;
      el.querySelector('.plug-sec-name').textContent = name;
      const sw = el.querySelector('.pkg-switch');
      // 包级开关：内核不认识「包」，所以「包 → 成员」的展开在这里做
      sw.addEventListener('click', () => toggleBundle(kind));
      s = {
        kind, name, el, sw,
        count: el.querySelector('.plug-sec-head em'),
        list: el.querySelector('.plug-sec-list'),
      };
      // 插到 KIND_ORDER 的正确位置，既有的分组顺序不因为增量建行而变化
      const later = [...secs.values()].find((o) => kindRank(o.kind) > kindRank(kind));
      if (later) body.insertBefore(el, later.el); else body.appendChild(el);
      secs.set(kind, s);
      return s;
    };

    // ── 行：第一次见到这个 id 才建，之后只 syncRow ──────────
    const buildRow = (it) => {
      const sec = ensureSection(it.kind);
      const row = document.createElement('div');
      row.className = 'plug-row';
      row.dataset.id = it.id;        // 探针与人工排查都靠它定位这一行
      row.innerHTML = `
        <div class="plug-main">
          <div class="plug-title">
            <b></b><span class="plug-id"></span><span class="plug-ver"></span><span class="plug-phase"></span>
          </div>
          <p class="plug-desc"></p>
          <div class="plug-meta">
            <span class="plug-chip soft plug-count"></span>
            <span class="plug-chip bad plug-err"></span>
            <span class="plug-note"></span>
          </div>
        </div>
        <button type="button" class="plug-switch" role="switch"><i></i></button>`;
      const q = (sel) => row.querySelector(sel);
      // 元数据是静态的：建行时用 textContent 写一次（不拼 HTML，免得名字里有尖括号就变结构）
      q('.plug-title b').textContent = it.name;
      q('.plug-id').textContent = it.id;
      q('.plug-ver').textContent = 'v' + it.version;
      q('.plug-desc').textContent = it.desc || '（无说明）';
      const meta = q('.plug-meta');
      const err = q('.plug-err');
      for (const t of it.tags.slice(0, 3)) {
        const chip = document.createElement('span');
        chip.className = 'plug-chip soft';
        chip.textContent = t;
        meta.insertBefore(chip, err);
      }
      q('.plug-switch').addEventListener('click', () => toggleItem(it.id));
      sec.list.appendChild(row);
      const p = {
        row, sw: q('.plug-switch'), badge: q('.plug-phase'),
        count: q('.plug-count'), err, note: q('.plug-note'),
      };
      parts.set(it.id, p);
      return p;
    };

    /** 就地刷新一行：只改会变的那几项，行元素本身不换 */
    const syncRow = (p, it) => {
      const selfLocked = it.id === SELF_ID;
      const off = !!it.offBy;
      // 三档行状态：off-bundle（被整包连坐）/ off-item（自己关的）/ bad（装载失败）
      const cls = 'plug-row'
        + (off ? ' off' : '')
        + (it.offBy ? ' off-' + it.offBy : '')
        + (it.phase === 'failed' ? ' bad' : '');
      if (p.row.className !== cls) p.row.className = cls;

      if (p.badge.dataset.phase !== it.phase) p.badge.dataset.phase = it.phase;
      setText(p.badge, PHASE_TEXT[it.phase] || it.phase);
      setAttr(p.badge, 'title', '阶段：' + it.phase);

      setText(p.count, `${it.contributions} 项贡献`);
      p.err.hidden = !it.error;
      if (it.error) setText(p.err, `装载失败：${it.error}`);

      // 这一行为什么不能开：自己由外壳承载 > 上级包被停用 > 单项自己关的
      const note = selfLocked ? '管理器由外壳承载，不能停用自己'
        : it.offBy === 'bundle' ? `所属包已停用（${KIND_NAME[it.kind] || it.kind}）`
          : off ? '已单项停用' : '';
      p.note.hidden = !note;
      setText(p.note, note);
      if (note) setAttr(p.note, 'data-by', selfLocked ? 'self' : (it.offBy || ''));

      // 被上级关掉时单项开关真的 disabled（不是让人点了没反应），视觉同时变灰
      const locked = selfLocked || pstate.isBundleOff(it.kind);
      const on = !off;
      p.sw.classList.toggle('on', on);
      p.sw.disabled = locked;
      setAttr(p.sw, 'aria-disabled', String(locked));
      setAttr(p.sw, 'aria-checked', String(on));
      setAttr(p.sw, 'aria-label', `${it.name}：${on ? '已启用' : '已停用'}${locked ? '，不可切换' : ''}`);
      setAttr(p.sw, 'title', locked
        ? (selfLocked ? '管理器由外壳承载，不能停用自己' : `所属包「${KIND_NAME[it.kind] || it.kind}」已停用，先启用整个包`)
        : (on ? '停用（当场生效）' : '启用（当场装载）'));
    };

    /**
     * 包级开关。「包」= kind：成员在这里从快照里按 kind 算出来，
     * 逐个驱动宿主取即时效果，选择再交给 pluginState 取持久化。
     */
    const toggleBundle = (kind) => {
      const nextOn = pstate.isBundleOff(kind);   // 现在关着 → 这次要开
      // 这个参数是「是否启用」（isBundleOff 判定的是 === false），照字面当「关闭」传会写反
      pstate.setBundle(kind, nextOn);
      for (const it of inv.snapshot().items) {
        if (it.kind !== kind || it.id === SELF_ID) continue;   // 管理器由外壳承载，不拆
        if (!nextOn) host.disable(it.id, 'bundle');
        // 重新开包：包内成员各自的单项选择要原样回来，包级操作不该抹掉它
        else if (pstate.isItemOff(it.id)) host.disable(it.id, 'item');
        else host.enable(it.id);
      }
    };

    const toggleItem = (id) => {
      const it = inv.snapshot().items.find((x) => x.id === id);
      if (!it || id === SELF_ID) return;         // 管理器不给自己的开关
      const nextOn = !!it.offBy;                 // 现在关着 → 这次要开
      pstate.setItem(id, nextOn);
      if (nextOn) host.enable(id); else host.disable(id, 'item');
    };

    /** 重新装载：按当前开关状态重装已启用的插件。停用中的不复活（内核的重载语义就是只拆不装）。 */
    const reloadAll = () => {
      for (const it of inv.snapshot().items) {
        // 管理器自己不重载：它由外壳承载，重载只会把正在用的这份界面变成孤儿
        if (it.id === SELF_ID || it.offBy) continue;
        host.reload(it.id);
      }
    };

    /** 快照 → 界面。增量：复用已有行元素，只补新行、只改变化的字段 */
    const apply = (snap) => {
      if (!built) return;            // 抽屉还没建过 DOM：开抽屉时再一次性画
      paintHead(snap);
      const live = new Set();
      for (const it of snap.items) {
        live.add(it.id);
        syncRow(parts.get(it.id) || buildRow(it), it);
      }
      for (const [id, p] of parts) {  // 宿主记录不会消失，真消失了也不留孤儿
        if (live.has(id)) continue;
        p.row.remove();
        parts.delete(id);
      }
      for (const [kind, s] of secs) {
        const members = snap.items.filter((it) => it.kind === kind).length;
        s.count.textContent = String(members);
        if (!members) { s.el.remove(); secs.delete(kind); continue; }
        const off = pstate.isBundleOff(kind);
        s.sw.classList.toggle('on', !off);
        s.sw.setAttribute('aria-checked', String(!off));
        s.sw.setAttribute('aria-label', `${s.name}包：${off ? '已停用' : '已启用'}`);
        s.sw.title = off ? `启用「${s.name}」包` : `停用「${s.name}」包（成员当场拆掉）`;
      }
    };

    // ── 顶栏入口 ──
    ctx.slot('topbar.right', (hostEl) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'tb-btn';
      b.id = 'btnPlugins';
      b.title = '插件管理器';
      b.textContent = '🧩';
      b.addEventListener('click', () => window.dispatchEvent(new CustomEvent('xiaomo:plugins', { detail: true })));
      hostEl.appendChild(b);
      // 顶栏同样会被整槽重渲染（ui.* 停用时会摘掉自己的顶栏项）：记住当前这一枚，
      // 关抽屉时若原触发节点已被换掉，焦点还有地方可回。
      trigger = b;
    }, { order: 30 });

    // ── 抽屉 ──
    ctx.slot('overlay', (hostEl) => {
      // 这一槽随时可能被整槽重渲染：每次进来都从零建，上一份的行/段/计数引用全部作废
      // （它们指向已被摘掉的节点，留着只会让新抽屉把内容画到空气里）
      parts.clear(); secs.clear(); cnts.clear();
      built = false;
      const mask = document.createElement('div');
      mask.className = 'drawer-mask';
      mask.id = 'pluginsDrawer';      // 同槽还有别的抽屉（器材包 / 设置），给自己一个可定位的名字
      mask.innerHTML = `
        <aside class="drawer" role="dialog" aria-modal="true" aria-label="插件管理器">
          <header class="drawer-head">
            <div>
              <h2>插件</h2>
              <p class="drawer-sub">
                <span class="plug-buckets"></span>
                <span class="plug-total"></span>
              </p>
            </div>
            <button type="button" class="drawer-x" title="关闭">✕</button>
          </header>
          <div class="drawer-body"></div>
          <footer class="drawer-foot">
            <span class="drawer-hint">开关立即生效：停用会当场执行该插件的处置栈并摘掉它的注册表与插槽条目，启用会当场重新装载 —— 不需要刷新页面。</span>
            <button type="button" class="mini-btn" id="btnReload"
                    title="按当前开关状态重装所有已启用的插件（管理器自身除外）">重新装载</button>
          </footer>
        </aside>`;
      hostEl.appendChild(mask);

      body = mask.querySelector('.drawer-body');
      bucketsEl = mask.querySelector('.plug-buckets');
      totalEl = mask.querySelector('.plug-total');
      for (const phase of PHASE_ORDER) ensureCounter(phase);   // 五桶先按固定顺序摆好
      built = true;
      apply(inv.snapshot());

      // ── 浮层时序与焦点（§2-C1 C1 / C8）──────────────────
      // 退场时长不写死：读遮罩与面板的计算过渡时长，并以 transitionend 为主信号。
      // §2-A12 把退场收到 --t-base 之后，这里自动跟随，不需要改任何毫秒数。
      const EXIT_SLACK = 80;    // 兜底余量（约一帧多），不是过渡时长
      const toMs = (v) => {
        const n = parseFloat(v) || 0;
        return /ms\s*$/.test(String(v).trim()) ? n : n * 1000;
      };
      const exitMs = (root) => {
        let max = 0;
        for (const el of [root, root.firstElementChild]) {
          if (!el) continue;
          for (const d of getComputedStyle(el).transitionDuration.split(',')) max = Math.max(max, toMs(d));
        }
        return max + EXIT_SLACK;
      };

      const shell = document.getElementById('app');
      const canInert = typeof HTMLElement !== 'undefined' && 'inert' in HTMLElement.prototype;
      let closing = 0;
      const cancelClose = () => { if (closing) { clearTimeout(closing); closing = 0; } };
      const lockBg = () => {
        if (!shell) return;
        if (canInert) shell.inert = true; else shell.setAttribute('aria-hidden', 'true');
      };
      const unlockBg = () => {
        if (!shell) return;
        if (document.querySelector('.drawer-mask.show,.expel-mask.show,.about-mask.show')) return;
        if (canInert) shell.inert = false; else shell.removeAttribute('aria-hidden');
      };

      const open = () => {
        cancelClose();
        if (!wantOpen) restoreFocus = document.activeElement;   // 只有「从关到开」才重记焦点来源
        wantOpen = true;
        apply(inv.snapshot());          // 关上时若有变化，这里按快照刷新（仍是增量）
        const wasHidden = !mask.classList.contains('show');
        if (wasHidden) mask.classList.remove('in');
        mask.classList.add('show');
        void mask.offsetWidth;          // 立刻结算起点，抽屉滑入才有过渡
        mask.classList.add('in');
        lockBg();
        const t = mask.querySelector('button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])');
        if (t && t.focus) t.focus({ preventScroll: true });
      };

      const close = () => {
        if (!mask.classList.contains('show')) { wantOpen = false; return; }
        wantOpen = false;
        mask.classList.remove('in');
        const wait = exitMs(mask);
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          mask.removeEventListener('transitionend', onEnd);
          clearTimeout(closing);
          closing = 0;
          if (!mask.classList.contains('in')) mask.classList.remove('show');
          unlockBg();
          // 焦点回给「谁把我打开的」。那个节点可能已经被整槽重渲染换掉（顶栏也受
          // slot:changed 影响），掉了链就退回当前这一枚 🧩 按钮 —— 是同一个东西，
          // 用户不该因为中间换过一次 DOM 就丢掉键盘焦点。
          const back = restoreFocus && restoreFocus.isConnected ? restoreFocus : trigger;
          if (back && back.focus) back.focus({ preventScroll: true });
          restoreFocus = null;
        };
        const onEnd = (e) => {
          if (e.target !== mask && !mask.contains(e.target)) return;
          if (e.propertyName !== 'transform' && e.propertyName !== 'opacity') return;
          finish();
        };
        mask.addEventListener('transitionend', onEnd);
        closing = setTimeout(finish, wait);
      };

      mask.querySelector('.drawer-x').addEventListener('click', close);
      mask.addEventListener('click', (e) => { if (e.target === mask) close(); });
      mask.querySelector('#btnReload').addEventListener('click', reloadAll);
      drawer = { open, close };
      // 重渲染后回到「开着」的样子：不播入场动画，背景仍旧锁着（它本来就是开着的）
      if (wantOpen) { mask.classList.add('show', 'in'); lockBg(); }
    }, { order: 20 });

    // 窗口级监听只注册一次，操作的是「当前这一份」抽屉：整槽重渲染换掉 DOM 也不会失效，
    // 更不会一份一份地堆积；跟着插件一起拆，管理器被拆掉后不该还有回调在跑。
    const onPlugins = (e) => { if (drawer) { e.detail ? drawer.open() : drawer.close(); } };
    const onKey = (e) => { if (e.key === 'Escape' && drawer) drawer.close(); };
    window.addEventListener('xiaomo:plugins', onPlugins);
    window.addEventListener('keydown', onKey);
    ctx.onDispose(() => window.removeEventListener('xiaomo:plugins', onPlugins));
    ctx.onDispose(() => window.removeEventListener('keydown', onKey));

    // 清单是唯一数据源：宿主每次装卸/启停都发事件，界面因此不用轮询，
    // 开关里也不手动重画 —— 手动重画会把「订阅到底通没通」这件事藏起来。
    ctx.onDispose(inv.onChange((snap) => apply(snap)));
  },
};
