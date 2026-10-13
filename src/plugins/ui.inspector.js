import { Inspector } from '../ui/inspector.js';

export default {
  id: 'xiaomo.ui.inspector',
  name: '属性面板',
  version: '1.0.0',
  kind: 'ui',
  desc: '选中器材后编辑参数，并实时显示电流、电压、功率、温度、pH 等读数',
  author: '小墨实验室',
  builtin: true,
  tags: ['界面', '属性'],
  setup(ctx) {
    ctx.slot('sidebar.pane.inspector', (host) => {
      ctx.app.inspector = new Inspector(host, ctx.app);
      if (ctx.app.selected) ctx.app.inspector.show(ctx.app.selected);
    }, { order: 10 });
  },
};
