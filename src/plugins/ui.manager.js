// 插件管理器：查看全部已装载的插件，启用 / 禁用（下次启动生效）

const KIND_NAME = {
  core: '内核能力', theme: '主题', equipment: '器材',
  rules: '规则', system: '系统', ui: '界面', content: '内容', misc: '其他',
};
const KIND_ORDER = ['core', 'equipment', 'rules', 'system', 'ui', 'content', 'theme', 'misc'];
const DISABLED_KEY = 'xiaomo.plugins.disabled';

const loadDisabled = () => {
  try { return new Set(JSON.parse(localStorage.getItem(DISABLED_KEY) || '[]')); }
  catch { return new Set(); }
};
const saveDisabled = (set) => localStorage.setItem(DISABLED_KEY, JSON.stringify([...set]));

export default {
  id: 'xiaomo.ui.manager',
  name: '插件管理器',
  version: '1.0.0',
  kind: 'ui',
  desc: '查看所有插件的版本、用途与贡献数量，并启用 / 禁用它们',
  author: '小墨实验室',
  builtin: true,
  tags: ['界面', '插件'],
  setup(ctx) {
    const app = ctx.app;
    const host = ctx.host;

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
    }, { order: 30 });

    // ── 抽屉 ──
    ctx.slot('overlay', (hostEl) => {
      const mask = document.createElement('div');
      mask.className = 'drawer-mask';
      mask.innerHTML = `
        <aside class="drawer" role="dialog" aria-modal="true" aria-label="插件管理器">
          <header class="drawer-head">
            <div>
              <h2>插件</h2>
              <p class="drawer-sub"></p>
            </div>
            <button type="button" class="drawer-x" title="关闭">✕</button>
          </header>
          <div class="drawer-body"></div>
          <footer class="drawer-foot">
            <span class="drawer-hint">停用某个插件后需要刷新页面才会真正卸载。</span>
            <button type="button" class="mini-btn" id="btnReload">刷新实验室</button>
          </footer>
        </aside>`;
      hostEl.appendChild(mask);

      const body = mask.querySelector('.drawer-body');
      const sub = mask.querySelector('.drawer-sub');
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
      let restoreFocus = null;
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
        render();
        restoreFocus = document.activeElement;
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
        if (!mask.classList.contains('show')) return;
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
          if (restoreFocus && restoreFocus.focus) restoreFocus.focus({ preventScroll: true });
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

      window.addEventListener('xiaomo:plugins', (e) => { e.detail ? open() : close(); });
      mask.querySelector('.drawer-x').addEventListener('click', close);
      mask.addEventListener('click', (e) => { if (e.target === mask) close(); });
      window.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
      mask.querySelector('#btnReload').addEventListener('click', () => location.reload());

      // 行元素按插件 id 缓存：点开关时只改这一行，不重建整表，
      // 否则新节点的 .plug-switch i 一创建就带目标 class，过渡永远不播放。
      const rows = new Map();
      const paintSub = () => {
        const st = host.stats();
        sub.textContent = `${st.installed} / ${st.total} 个插件已装载 · 贡献 ${st.contributions} 项能力`
          + `（${st.equipment} 器材 · ${st.reactions} 反应规则 · ${st.themes} 主题）`;
      };
      const syncRow = (row, off) => {
        row.classList.toggle('off', off);
        const sw = row.querySelector('.plug-switch');
        sw.classList.toggle('on', !off);
        sw.title = off ? '启用' : '停用';
        sw.setAttribute('aria-checked', String(!off));
      };

      function render() {
        const all = host.list();
        paintSub();

        const disabled = loadDisabled();
        const byKind = new Map();
        for (const r of all) {
          if (!byKind.has(r.kind)) byKind.set(r.kind, []);
          byKind.get(r.kind).push(r);
        }

        body.innerHTML = '';
        rows.clear();
        for (const kind of KIND_ORDER) {
          const list = byKind.get(kind);
          if (!list || !list.length) continue;
          const sec = document.createElement('section');
          sec.className = 'plug-sec';
          sec.innerHTML = `<h3>${KIND_NAME[kind] || kind} <em>${list.length}</em></h3>`;
          for (const r of list) {
            const off = disabled.has(r.id);
            const row = document.createElement('div');
            row.className = 'plug-row' + (off ? ' off' : '') + (r.error ? ' bad' : '');
            row.innerHTML = `
              <div class="plug-main">
                <div class="plug-title">
                  <b>${r.name}</b>
                  <span class="plug-id">${r.id}</span>
                  <span class="plug-ver">v${r.version}</span>
                </div>
                <p class="plug-desc">${r.desc || '（无说明）'}</p>
                <div class="plug-meta">
                  <span class="plug-chip">${r.contributions} 项贡献</span>
                  ${r.tags.slice(0, 3).map(t => `<span class="plug-chip soft">${t}</span>`).join('')}
                  ${r.error ? `<span class="plug-chip bad">装载失败：${r.error}</span>` : ''}
                </div>
              </div>
              <button type="button" class="plug-switch ${off ? '' : 'on'}" role="switch"
                      aria-checked="${off ? 'false' : 'true'}" aria-label="${r.name}"
                      title="${off ? '启用' : '停用'}">
                <i></i>
              </button>`;
            rows.set(r.id, row);
            row.querySelector('.plug-switch').addEventListener('click', () => {
              const d = loadDisabled();
              const off = !d.has(r.id);
              if (off) d.add(r.id); else d.delete(r.id);
              saveDisabled(d);
              syncRow(row, off);   // 就地更新，整表不重建
              paintSub();
            });
            sec.appendChild(row);
          }
          body.appendChild(sec);
        }
      }
    }, { order: 20 });
  },
};
