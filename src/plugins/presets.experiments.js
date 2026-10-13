import { PRESETS } from '../presets/experiments.js';

export default {
  id: 'xiaomo.presets.experiments',
  name: '预置实验',
  version: '1.0.0',
  kind: 'content',
  desc: `一键搭好 ${PRESETS.length} 个实验场景：电解水、原电池、反应放热、置换反应、电流热效应、酸碱中和`,
  author: '小墨实验室',
  builtin: true,
  tags: ['内容', '实验'],
  setup(ctx) {
    ctx.app.services.presets = PRESETS;
  },
};
