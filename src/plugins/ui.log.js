import { LogPanel } from '../ui/log.js';

export default {
  id: 'xiaomo.ui.log',
  name: '实验日志',
  version: '1.0.0',
  kind: 'ui',
  desc: '按物理 / 化学 / 耦合分类记录实验过程中发生的一切',
  author: '小墨实验室',
  builtin: true,
  tags: ['界面', '日志'],
  setup(ctx) {
    ctx.slot('sidebar.pane.log', (host) => {
      const app = ctx.app;
      const panel = new LogPanel(host, app);
      app.log = panel;

      const bar = document.createElement('div');
      bar.className = 'log-bar';
      bar.innerHTML = `
        <label class="mini-check"><input id="chkChemLog" type="checkbox" checked><span>记录化学反应</span></label>
        <label class="mini-check"><input id="chkBridgeLog" type="checkbox" checked><span>记录跨域耦合</span></label>
        <button id="btnClearLog" class="mini-btn" type="button">清空</button>`;
      host.appendChild(bar);

      bar.querySelector('#btnClearLog').addEventListener('click', () => panel.clear());
    }, { order: 10 });
  },
};
