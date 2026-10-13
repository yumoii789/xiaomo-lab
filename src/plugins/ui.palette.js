import { Palette } from '../ui/palette.js';

export default {
  id: 'xiaomo.ui.palette',
  name: '器材栏',
  version: '1.0.0',
  kind: 'ui',
  desc: '按物理 / 化学 / 耦合分组浏览全部器材，支持名称与用途搜索',
  author: '小墨实验室',
  builtin: true,
  tags: ['界面', '器材'],
  setup(ctx) {
    ctx.slot('palette', (host) => {
      host.innerHTML = `
        <div class="pal-search">
          <span class="pal-search-ico">⌕</span>
          <input id="paletteSearch" type="search" placeholder="搜索器材…" autocomplete="off" spellcheck="false">
        </div>
        <div class="pal-tabs" id="paletteTabs">
          <button type="button" data-tab="all" class="active">全部</button>
          <button type="button" data-tab="physics">物理</button>
          <button type="button" data-tab="chemistry">化学</button>
          <button type="button" data-tab="bridge">耦合</button>
        </div>
        <div class="pal-list" id="paletteList"></div>
        <div class="pal-foot">点击或拖拽器材，放进实验台</div>`;

      const app = ctx.app;
      const p = new Palette(host.querySelector('#paletteList'), app);
      app.palette = p;

      const search = host.querySelector('#paletteSearch');
      search.addEventListener('input', (e) => p.setQuery(e.target.value));

      const tabs = host.querySelectorAll('#paletteTabs button');
      tabs.forEach(b => b.addEventListener('click', () => {
        tabs.forEach(x => x.classList.toggle('active', x === b));
        p.setDomain(b.dataset.tab);
        p.render();
      }));
    }, { order: 10 });
  },
};
