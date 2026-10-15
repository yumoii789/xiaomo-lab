import { Palette } from '../ui/palette.js';
import { onChange as onEquipmentChange } from '../equipment/registry.js';

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
          <input id="paletteSearch" type="search" placeholder="搜索器材…" autocomplete="off" spellcheck="false"
                 inputmode="search" enterkeyhint="search" autocapitalize="none" autocorrect="off">
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

      /**
       * 器材栏是器材注册表的投影，所以「注册表变了」的两条信号都要接：
       *   · 注册表 onChange —— 只在 define() 时触发（装器材包、插件装载时贡献条目走这条）；
       *   · 清单 onChange   —— 插件每次启停都会推快照，覆盖「停用会摘条目」这条注册表不通知的路。
       * 两条都只做同一件事：按注册表重新投影。sync 幂等，重复触发没有副作用。
       * 时序也站得住：摘条目发生在处置栈里，阶段变更与快照推送都在其后 ——
       * 收到推送时注册表已经定了；这一点由 tools/palette-probe.html 的断言钉住，不靠默认。
       */
      const resync = () => p.sync();
      ctx.onDispose(onEquipmentChange(resync));
      if (app.inventory) ctx.onDispose(app.inventory.onChange(resync));

      const search = host.querySelector('#paletteSearch');
      search.addEventListener('input', (e) => p.setQuery(e.target.value));

      const tabs = host.querySelectorAll('#paletteTabs button');
      tabs.forEach(b => b.addEventListener('click', () => {
        tabs.forEach(x => x.classList.toggle('active', x === b));
        p.setDomain(b.dataset.tab);      // 投影自己会跟着换，不用再手动 render 一次
      }));
    }, { order: 10 });
  },
};
