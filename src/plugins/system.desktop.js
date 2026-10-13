// ══════════════════════════════════════════════════════════
// 桌面版外壳（仅在 Electron 里生效）
//
// 浏览器里 window.xiaomoDesktop 不存在，这个插件直接什么都不做，
// 所以同一份前端代码两头都能跑。
// ══════════════════════════════════════════════════════════

import { theme } from '../core/theme.js';

const MODE_KEY = 'xiaomo.mode.v1';

const SVG = {
  min: '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M0 5h10" stroke="currentColor" stroke-width="1"/></svg>',
  max: '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><rect x=".5" y=".5" width="9" height="9" fill="none" stroke="currentColor" stroke-width="1"/></svg>',
  restore: '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><rect x=".5" y="3.5" width="6" height="6" fill="none" stroke="currentColor" stroke-width="1"/><path d="M2.5 2.5v-2h7v7h-2" fill="none" stroke="currentColor" stroke-width="1"/></svg>',
  close: '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M.5.5l9 9M9.5.5l-9 9" stroke="currentColor" stroke-width="1"/></svg>',
};

export default {
  id: 'xiaomo.system.desktop',
  name: '桌面版外壳',
  version: '1.0.0',
  kind: 'system',
  desc: '窗口按钮、原生文件对话框、应用菜单与系统主题同步；浏览器里自动静默',
  author: '小墨实验室',
  builtin: true,
  tags: ['桌面'],
  setup(ctx) {
    const D = window.xiaomoDesktop;
    if (!D || !D.isDesktop) return;          // 不是桌面版，什么都不做

    const app = ctx.app;
    document.documentElement.dataset.desktop = '1';

    // ── 窗口按钮 ──────────────────────────────────────────
    ctx.slot('topbar.wincontrols', (host) => {
      const mk = (cls, title, html, fn) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'wc-btn ' + cls;
        b.title = title;
        b.innerHTML = html;
        b.addEventListener('click', fn);
        host.appendChild(b);
        return b;
      };

      mk('wc-min', '最小化', SVG.min, () => D.minimize());

      const maxBtn = mk('wc-max', '最大化', SVG.max, async () => {
        const m = await D.toggleMaximize();
        maxBtn.innerHTML = m ? SVG.restore : SVG.max;
        maxBtn.title = m ? '向下还原' : '最大化';
      });

      mk('wc-close', '关闭', SVG.close, () => D.close());

      D.onWindowState?.((s) => {
        maxBtn.innerHTML = s.maximized ? SVG.restore : SVG.max;
        maxBtn.title = s.maximized ? '向下还原' : '最大化';
      });
    }, { order: 100 });

    // ── 系统主题：用户没手动选过就跟随系统 ────────────────
    const followSystem = () => !localStorage.getItem(MODE_KEY);
    D.getSystemTheme?.().then((m) => { if (followSystem()) theme.setMode(m); });
    D.onSystemTheme?.((m) => { if (followSystem()) theme.setMode(m); });

    // ── 原生文件对话框 ────────────────────────────────────
    const saveScene = async () => {
      const json = JSON.stringify(app.serialize?.() ?? app.save?.() ?? {}, null, 2);
      const r = await D.saveScene(json, '小墨实验.xiaomo');
      if (r.ok) app.toast('已保存到 ' + r.name);
      else if (!r.canceled) app.toast('保存失败：' + (r.error || '未知错误'), 'danger');
      return r;
    };

    const openScene = async () => {
      const r = await D.openScene();
      if (!r.ok) {
        if (!r.canceled) app.toast('打开失败：' + (r.error || '未知错误'), 'danger');
        return r;
      }
      try {
        app.loadScene(JSON.parse(r.json));
        app.toast('已打开 ' + r.name);
      } catch (e) {
        app.toast('文件格式不对，读不出来', 'danger');
      }
      return r;
    };

    const newScene = () => {
      try { app.loadScene({ version: 2, entities: [], wires: [] }); }
      catch { app.reset(); }
      app.toast('新的实验台');
    };

    const exportPng = async () => {
      const cv = document.getElementById('canvas');
      if (!cv) return;
      const r = await D.exportPng(cv.toDataURL('image/png'), '小墨实验台.png');
      if (r.ok) app.toast('图片已导出到 ' + r.name);
      else if (!r.canceled) app.toast('导出失败：' + (r.error || '未知错误'), 'danger');
    };

    // ── 菜单指令 ──────────────────────────────────────────
    D.onMenu?.((cmd) => {
      switch (cmd) {
        case 'scene:new': newScene(); break;
        case 'scene:open': openScene(); break;
        case 'scene:save': saveScene(); break;
        case 'scene:png': exportPng(); break;
        case 'pack:import':
          window.dispatchEvent(new CustomEvent('xiaomo:pack-import'));
          break;
        case 'ui:plugins':
          window.dispatchEvent(new CustomEvent('xiaomo:plugins', { detail: true }));
          break;
        case 'theme:toggle': theme.toggle(); break;
        case 'theme:next': {
          const list = theme.list();
          const i = list.findIndex(t => t.id === theme.id);
          const next = list[(i + 1) % list.length];
          if (next) { theme.use(next.id); app.toast('主题：' + next.name); }
          break;
        }
        case 'sim:toggle': app.toggleRun(); break;
        case 'sim:reset': app.reset(); app.toast('实验已重置'); break;
        case 'sim:clear': newScene(); break;
        case 'tool:select': app.setTool('select'); break;
        case 'tool:wire': app.setTool('wire'); break;
        case 'tool:pour': app.setTool('pour'); break;
        case 'tool:erase': app.setTool('erase'); break;
        case 'ui:hint': app.showHint?.('桌面版快捷键', 'Ctrl+S 保存实验 · Ctrl+O 打开 · Ctrl+D 切换浅色深色 · F5 运行暂停 · Ctrl+Shift+E 导出图片'); break;
        case 'ui:about':
          window.dispatchEvent(new CustomEvent('xiaomo:about', { detail: true }));
          break;
        default: break;
      }
    });

    // ── 关于窗口 ──────────────────────────────────────────
    ctx.slot('overlay', (host) => {
      const mask = document.createElement('div');
      mask.className = 'about-mask';
      mask.innerHTML = `
        <div class="about-card" role="dialog" aria-modal="true" aria-label="关于小墨实验室">
          <div class="about-mark">墨</div>
          <h2>小墨实验室</h2>
          <p class="about-ver">桌面版 ${app.VERSION || '2.0.0'}</p>
          <p class="about-line">物理与化学器材共处同一张实验台，<br>两种器材可以相互交互。</p>
          <div class="about-tech">
            <span>Electron ${D.versions?.electron || '?'}</span>
            <span>Chromium ${(D.versions?.chrome || '?').split('.')[0]}</span>
            <span>Node ${(D.versions?.node || '?').split('.')[0]}</span>
          </div>
          <button type="button" class="about-ok">知道了</button>
        </div>`;
      host.appendChild(mask);

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
        restoreFocus = document.activeElement;
        const wasHidden = !mask.classList.contains('show');
        if (wasHidden) mask.classList.remove('in');
        mask.classList.add('show');
        void mask.offsetWidth;          // 立刻结算起点，入场缩放/淡入才有过渡
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

      window.addEventListener('xiaomo:about', (e) => { e.detail ? open() : close(); });
      mask.querySelector('.about-ok').addEventListener('click', close);
      mask.addEventListener('click', (e) => { if (e.target === mask) close(); });
      window.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
    }, { order: 30 });
  },
};
