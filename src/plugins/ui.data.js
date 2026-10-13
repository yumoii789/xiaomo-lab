import { DataPanel } from '../ui/data.js';

export default {
  id: 'xiaomo.ui.data',
  name: '数据面板',
  version: '1.0.0',
  kind: 'ui',
  desc: '自动发现所有可测通道，10 Hz 采样并绘制实时曲线',
  author: '小墨实验室',
  builtin: true,
  tags: ['界面', '数据', '曲线'],
  setup(ctx) {
    ctx.slot('sidebar.pane.data', (host) => {
      ctx.app.data = new DataPanel(host, ctx.app);
    }, { order: 10 });
  },
};
