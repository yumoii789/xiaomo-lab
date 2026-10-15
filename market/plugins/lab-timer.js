// ══════════════════════════════════════════════════════════
// 社区示例插件 · 实验计时器
//
// 这是一个**单文件零依赖**的 ESM：整个文件就是插件本体。
// 为什么必须零依赖：它不是被 <script> 引入的，而是「拉字节 → 校验 sha256 →
// Blob URL → 动态 import()」装进来的，blob URL 里**解析不了任何相对 import**。
// 所以社区插件能用的全部能力，只有宿主在 setup(ctx) 时交出来的那些：
//   ctx.app / ctx.slot / ctx.log / ctx.toast / ctx.onDispose / 各注册表
// 这个插件刻意只碰这四样（slot / toast / log / onDispose），当面证明「够用」。
//
// 行为：往顶栏右侧加一个 ⏱ 按钮，点开是一块跟随主题的计时卡片，
// 支持开始 / 暂停 / 归零，时间走的是真实时钟（不看帧率，掉帧也不会走偏）。
// ══════════════════════════════════════════════════════════

const fmt = (ms) => {
  const t = Math.max(0, Math.floor(ms));
  const m = Math.floor(t / 60000);
  const s = Math.floor((t % 60000) / 1000);
  const d = Math.floor((t % 1000) / 100);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${d}`;
};

export default {
  id: 'xiaomo.community.lab-timer',
  name: '实验计时器',
  version: '1.0.0',
  kind: 'ui',
  desc: '顶栏加一个秒表：开始 / 暂停 / 归零，读数是真实时间',
  author: '社区示例',
  builtin: false,
  tags: ['社区', '计时', '工具'],
  setup(ctx) {
    // ── 状态 ──────────────────────────────────────────────
    let acc = 0;          // 已累计的毫秒
    let t0 = 0;           // 本段开始的时刻（未走时为 0）
    let raf = 0;
    let panel = null;
    let readout = null;

    const elapsed = () => acc + (t0 ? Date.now() - t0 : 0);
    const running = () => t0 !== 0;

    const paint = () => { if (readout) readout.textContent = fmt(elapsed()); };

    const loop = () => {
      paint();
      if (running()) raf = requestAnimationFrame(loop);
    };

    const start = () => {
      if (running()) return;
      t0 = Date.now();
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(loop);
      ctx.toast('计时开始');
    };

    const pause = () => {
      if (!running()) return;
      acc = elapsed();
      t0 = 0;
      cancelAnimationFrame(raf);
      paint();
      ctx.log(`计时暂停：${fmt(acc)}`);
    };

    const reset = () => {
      acc = 0; t0 = 0;
      cancelAnimationFrame(raf);
      paint();
      ctx.toast('计时归零');
    };

    // ── 面板 ──────────────────────────────────────────────
    // 没有走任何插槽：面板是浮在画布上的，宿主没有「浮层卡片」这种插槽，
    // 所以插件自己建 DOM 并自己负责拆（ctx.onDispose）。这是社区插件该有的姿态：
    // 用宿主给的能力，自己那部分自己收拾干净。
    const build = () => {
      if (panel) return;
      panel = document.createElement('aside');
      panel.className = 'mk-timer';
      panel.setAttribute('aria-label', '实验计时器');
      // 只用宿主已有的按钮类（.mini-btn / .tb-btn）保证跟随主题；
      // 定位是插件自己的事，所以只在这里写内联样式，不往主样式表里加东西。
      panel.style.cssText = 'position:fixed;right:18px;bottom:52px;z-index:60;display:none;'
        + 'padding:10px 12px;border-radius:10px;background:var(--surface-2,#1b1f24);'
        + 'border:1px solid var(--border,#333);color:var(--text,#e6edf3);'
        + 'box-shadow:0 8px 24px rgba(0,0,0,.35);font:12.5px/1.5 system-ui,sans-serif;min-width:186px';
      panel.innerHTML = `
        <div style="display:flex;align-items:center;justify-content:space-between;gap:8px">
          <b style="font-size:12px">实验计时器</b>
          <button type="button" class="mini-btn" data-act="close" title="收起" style="margin-left:0">✕</button>
        </div>
        <div data-readout style="font:600 26px/1.4 ui-monospace,Consolas,monospace;
             font-variant-numeric:tabular-nums;letter-spacing:.5px">00:00.0</div>
        <div style="display:flex;gap:6px">
          <button type="button" class="mini-btn" data-act="start" style="margin-left:0">开始</button>
          <button type="button" class="mini-btn" data-act="pause" style="margin-left:0">暂停</button>
          <button type="button" class="mini-btn" data-act="reset" style="margin-left:0">归零</button>
        </div>`;
      panel.querySelector('[data-act=close]').addEventListener('click', () => { panel.style.display = 'none'; });
      panel.querySelector('[data-act=start]').addEventListener('click', start);
      panel.querySelector('[data-act=pause]').addEventListener('click', pause);
      panel.querySelector('[data-act=reset]').addEventListener('click', reset);
      document.body.appendChild(panel);
      readout = panel.querySelector('[data-readout]');
      paint();
    };

    const toggle = () => {
      build();
      const hidden = panel.style.display === 'none';
      panel.style.display = hidden ? 'block' : 'none';
      if (hidden) paint();
    };

    ctx.slot('topbar.right', (host) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'tb-btn';
      b.id = 'btnLabTimer';
      b.title = '实验计时器';
      b.textContent = '⏱';
      b.addEventListener('click', toggle);
      host.appendChild(b);
    }, { order: 70 });

    // ── 拆除：自己建的、自己攒的，一样都不能留 ────────────
    ctx.onDispose(() => {
      cancelAnimationFrame(raf);
      if (panel && panel.parentNode) panel.parentNode.removeChild(panel);
      panel = null;
      readout = null;
    });
  },
};
