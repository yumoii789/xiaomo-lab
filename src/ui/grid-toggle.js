// ══════════════════════════════════════════════════════════
// 网格 / 坐标开关的 DOM 入口（task-28 项④）
//
// 为什么必须是 DOM：`engine.overlays` 的回调只收到 `(g, engine)`（engine.js）⇒ 叠层
//   **画得出、点不着**；「点一下」这件事只能在 DOM 里发生。（网格线与坐标数字本身仍走
//   Canvas —— 它们必须参与同一套 `setTransform → translate → scale` 视口变换，
//   DOM 做不到与之逐位一致。）
//
// ⚠ 本文件**不进** `src/plugins/index.js` 的 `ALL_PLUGINS`（UI 插件数必须仍是 32）：
//   它是「画布功能栏」（项③）上的一颗按钮，挂载权在功能栏那一项手上 ⇒ 这里只导出
//   `mountGridToggle(container, engine)` 由功能栏调用；找不到容器就返回 null，
//   **不抛、不自己往 body 上塞按钮**（否则会在正式页面里凭空多出一颗浮空按钮）。
// ⚠ 状态只有一份真源：`engine.showGrid`。按钮只是它的把柄 —— 不另存状态、不写
//   localStorage/自造存储（`plans/17` ④ 要求「走既有设置机制，不自造存储」）。
// ⚠ 一根开关管两件事（网格 + 坐标读数），照 NB 的 `SHOW_COORDINATE`：命令名是
//   「显示坐标」、显示名是「网格」⇒ 按钮写「网格」，实际效果含坐标读数。
// ══════════════════════════════════════════════════════════

/**
 * 把开关按钮挂进 `container`，驱动 `engine.setShowGrid()`（置脏在引擎侧）。
 *
 * @param {HTMLElement} container 功能栏容器（项③）
 * @param {object} engine Engine 实例
 * @returns {HTMLElement|null} 生成的按钮；环境不具备 DOM 时返回 null
 *   （Node 里的探针可以安全 import 本文件，不会因为缺 document 就崩）
 */
export function mountGridToggle(container, engine) {
  if (!container || !engine || typeof document === 'undefined') return null;
  if (typeof container.appendChild !== 'function') return null;

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'grid-toggle';
  btn.dataset.action = 'grid';          // 功能栏按 data-action 派发的既有约定（项③ 接入时可改）
  btn.setAttribute('aria-pressed', 'false');

  const sync = () => {
    const on = !!engine.showGrid;
    btn.setAttribute('aria-pressed', String(on));
    btn.classList.toggle('is-on', on);
    btn.textContent = '网格';
    btn.title = on ? '网格 / 坐标读数：开（点击关闭）' : '网格 / 坐标读数：关（点击打开）';
  };
  sync();

  btn.addEventListener('click', () => {
    engine.setShowGrid(!engine.showGrid);   // 只改引擎那一份状态；按键态由 sync() 从真源重读
    sync();
  });

  container.appendChild(btn);
  return btn;
}
