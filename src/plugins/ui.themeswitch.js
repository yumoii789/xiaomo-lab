import { theme } from '../core/theme.js';

export default {
  id: 'xiaomo.ui.themeswitch',
  name: '主题切换',
  version: '1.0.0',
  kind: 'ui',
  desc: '实验台左上角的浮动圆钮：单击切换深浅色，右键或圆点换主题',
  author: '小墨实验室',
  builtin: true,
  tags: ['界面', '主题'],
  setup(ctx) {
    const app = ctx.app;

    ctx.slot('stage.overlay', (host) => {
      // ── 浮动圆钮 ──
      const orb = document.createElement('button');
      orb.type = 'button';
      orb.className = 'fx-orb';
      orb.title = '单击切换浅色 / 深色，右键切换主题，下方圆点可回到跟随系统';
      orb.innerHTML = '<span class="orb-sun">☀</span><span class="orb-moon">☾</span>';

      const paint = () => { orb.dataset.mode = theme.effective; };
      orb.addEventListener('click', () => {
        theme.toggle();
        app.toast(theme.effective === 'light' ? '☀ 浅色模式' : '☾ 深色模式');
      });
      orb.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        const list = theme.list();
        if (list.length < 2) return;
        const i = list.findIndex(t => t.id === theme.id);
        const next = list[(i + 1) % list.length];
        theme.use(next.id);
        app.toast('主题：' + next.name);
      });
      theme.onChange(paint);
      paint();
      host.appendChild(orb);

      // ── 主题圆点 ──
      // 只在「主题列表本身变了」时重建节点；换主题只切 .active，
      // 否则新圆点一创建就带 active，scale(1.12)/opacity 的过渡永远不播放。
      const dots = document.createElement('div');
      dots.className = 'theme-dots';

      // 「自动」圆点。单击圆钮会把模式钉成显式的 dark / light，没有它就没有任何路径能回到
      // 跟随系统 —— 那是个单向门。它固定排在第一位，与主题圆点同一列。
      const autoDot = document.createElement('button');
      autoDot.type = 'button';
      autoDot.className = 'theme-dot auto';
      autoDot.title = '跟随系统深浅色';
      autoDot.setAttribute('aria-label', '跟随系统深浅色');
      autoDot.addEventListener('click', () => { theme.setMode('system'); app.toast('跟随系统深浅色'); });

      let dotMap = new Map();     // 主题 id -> 圆点
      let dotSig = '';            // 列表指纹（id + 圆点色）
      const paintDots = () => {
        for (const [id, d] of dotMap) d.classList.toggle('active', id === theme.id);
        autoDot.classList.toggle('active', theme.mode === 'system');
      };
      const buildDots = () => {
        const list = theme.list();
        dots.innerHTML = '';
        dots.appendChild(autoDot);    // innerHTML 清空会把它一起清掉，每次都要补回来
        dotMap = new Map();
        for (const t of list) {
          const d = document.createElement('button');
          d.type = 'button';
          d.className = 'theme-dot' + (t.id === theme.id ? ' active' : '');
          d.title = t.name + (t.desc ? ' · ' + t.desc : '');
          d.style.setProperty('--dot', t.accent || '#888');
          d.addEventListener('click', () => { theme.use(t.id); app.toast('主题：' + t.name); });
          dots.appendChild(d);
          dotMap.set(t.id, d);
        }
        dotSig = list.map(t => t.id + ':' + (t.accent || '')).join('|');
        paintDots();              // 重建后补一次选中态，「自动」圆点也在这里跟上
      };
      const syncDots = () => {
        const sig = theme.list().map(t => t.id + ':' + (t.accent || '')).join('|');
        if (sig !== dotSig) buildDots(); else paintDots();
      };
      theme.onChange(syncDots);
      buildDots();
      host.appendChild(dots);
    }, { order: 10 });
  },
};
