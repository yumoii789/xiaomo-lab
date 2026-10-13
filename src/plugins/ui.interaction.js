import { Interaction } from '../ui/interact.js';

export default {
  id: 'xiaomo.ui.interaction',
  name: '实验台交互',
  version: '1.1.0',
  kind: 'ui',
  desc: '选择 / 连线 / 倾倒 / 删除，接线柱吸附、导线预览，以及点击涟漪与拖动拖尾',
  author: '小墨实验室',
  builtin: true,
  tags: ['界面', '交互'],
  setup(ctx) {
    const app = ctx.app;
    const it = new Interaction(app);
    app.interaction = it;
    app.engine.overlays.push((g, eng) => it.drawOverlay(g, eng));
    app.setTool('select');

    // ── 点击涟漪 + 拖动拖尾 ──────────────────────────────
    // 反馈类动效，只动 transform / opacity；减少动态效果时整体关闭。
    const stage = document.getElementById('stage');
    const layer = stage && stage.querySelector('.stage-fx');

    // C5：不是实验台本体的操作不发实验台反馈（主题圆钮、主题圆点、提示条、日常 toast）
    const NO_FX = '.fx-orb,.theme-dots,#hint,#toast';
    // C6：拖尾漂移方向 = 最近一次指针位移的反方向，粒子落在手势后方
    const TRAIL_LAG = 8;      // px，与 main.css 中 --ty 的默认幅度一致

    if (stage && layer) {
      // C9：减少动态效果实时生效——系统设置中途改变也要跟上，与 CSS 媒体查询行为一致
      const mq = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
      let calm = !!(mq && mq.matches);

      const spawn = (cls, x, y) => {
        const el = document.createElement('span');
        el.className = cls;
        el.style.left = x + 'px';
        el.style.top = y + 'px';
        layer.appendChild(el);
        el.addEventListener('animationend', () => el.remove(), { once: true });
        // 兜底移除：寿命从该元素的计算动画时长推出，不写死毫秒数
        // （减少动态效果时 CSS 把动画压到 .01ms，这里也跟着变短）
        let life = 0;
        for (const d of getComputedStyle(el).animationDuration.split(',')) {
          const n = parseFloat(d) || 0;
          life = Math.max(life, /ms\s*$/.test(String(d).trim()) ? n : n * 1000);
        }
        setTimeout(() => el.remove(), life + 80);
        return el;
      };

      const clearFx = () => { while (layer.firstChild) layer.firstChild.remove(); };
      const onCalmChange = (e) => {
        calm = e.matches;
        if (calm) clearFx();
      };
      if (mq) {
        if (mq.addEventListener) mq.addEventListener('change', onCalmChange);
        else if (mq.addListener) mq.addListener(onCalmChange);   // 旧内核兜底
      }

      let lastTrail = 0;
      let lastPt = null;
      let dirX = 0, dirY = 0;      // 最近一次指针位移的单位方向
      let muted = false;           // 本次手势起手在浮层控件上 → 涟漪与拖尾都不发

      stage.addEventListener('pointerdown', (e) => {
        muted = !!(e.target.closest && e.target.closest(NO_FX));
        if (e.button !== 0 || muted || calm) return;
        const r = stage.getBoundingClientRect();
        spawn('fx-ripple', e.clientX - r.left, e.clientY - r.top);
      });

      stage.addEventListener('pointermove', (e) => {
        const prev = lastPt;
        lastPt = { x: e.clientX, y: e.clientY };
        if (!e.buttons || muted || calm) return;   // 只在按住时留痕
        if (prev) {
          const dx = lastPt.x - prev.x, dy = lastPt.y - prev.y;
          const len = Math.hypot(dx, dy);
          if (len > 0.5) { dirX = dx / len; dirY = dy / len; }
        }
        const now = performance.now();
        if (now - lastTrail < 46) return;
        lastTrail = now;
        const r = stage.getBoundingClientRect();
        const el = spawn('fx-trail', e.clientX - r.left, e.clientY - r.top);
        // 方向交给 CSS 变量（main.css 的 fx-trail keyframes 读 --tx/--ty），随手势转向
        el.style.setProperty('--tx', (-dirX * TRAIL_LAG).toFixed(1) + 'px');
        el.style.setProperty('--ty', (-dirY * TRAIL_LAG).toFixed(1) + 'px');
      });
    }
  },
};
