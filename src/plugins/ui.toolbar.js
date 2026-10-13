// 顶栏：工具选择、运行控制、存档导出、预置实验

const ICO = {
  select: '<path d="M4 2.5l8.5 7.2-3.6.5 2 4.1-1.7.8-2-4.1-2.6 2.6z"/>',
  wire: '<path d="M3.5 11.5c0-3.9 2.2-7 5-7s5 3.1 5 7" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="3.5" cy="12.4" r="1.7"/><circle cx="13.5" cy="12.4" r="1.7"/>',
  pour: '<path d="M2.5 3h7l-3.5 5v4.2c0 .7.6 1.3 1.3 1.3h1.4c.7 0 1.3-.6 1.3-1.3V8L13.5 3z"/>',
  erase: '<path d="M5.5 2.5h6l1 2h3v1.5h-13V4.5h3zM4 7h9l-.8 6.2c-.1.8-.8 1.3-1.6 1.3H6.4c-.8 0-1.5-.5-1.6-1.3z"/>',
};
const svg = (d) => `<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">${d}</svg>`;

export default {
  id: 'xiaomo.ui.toolbar',
  name: '工具栏',
  version: '1.0.0',
  kind: 'ui',
  desc: '工具选择、运行 / 重置 / 保存 / 载入 / 截图，以及预置实验与慢动作',
  author: '小墨实验室',
  builtin: true,
  tags: ['界面', '工具栏'],
  requires: ['xiaomo.ui.interaction'],
  setup(ctx) {
    const app = ctx.app;
    const $ = (s, r = document) => r.querySelector(s);
    const $$ = (s, r = document) => [...r.querySelectorAll(s)];

    // ── 工具选择 ──
    ctx.slot('topbar.tools', (host) => {
      host.innerHTML = `
        <button type="button" class="tool-btn active" data-tool="select" title="选择 (V)">${svg(ICO.select)}</button>
        <button type="button" class="tool-btn" data-tool="wire" title="连线 (W)">${svg(ICO.wire)}</button>
        <button type="button" class="tool-btn" data-tool="pour" title="倾倒 (P)">${svg(ICO.pour)}</button>
        <button type="button" class="tool-btn" data-tool="erase" title="删除 (X)">${svg(ICO.erase)}</button>`;
      $$('[data-tool]', host).forEach(b =>
        b.addEventListener('click', () => app.setTool(b.dataset.tool)));
    }, { order: 10 });

    // ── 运行与存档 ──
    ctx.slot('topbar.actions', (host) => {
      host.innerHTML = `
        <button type="button" id="btnRun" class="tb-btn primary active" title="运行 / 暂停 (空格)">
          <span class="tb-run-dot"></span><span id="runLabel">运行中</span>
        </button>
        <button type="button" id="btnReset" class="tb-btn" title="重置状态">⟲</button>
        <span class="tb-sep"></span>
        <button type="button" id="btnSave" class="tb-btn" title="保存场景 (Ctrl+S)">💾</button>
        <button type="button" id="btnLoad" class="tb-btn" title="载入场景 (Ctrl+O)">📂</button>
        <button type="button" id="btnPng" class="tb-btn" title="导出实验台截图">📷</button>`;
      $('#btnRun', host).addEventListener('click', () => app.toggleRun());
      $('#btnReset', host).addEventListener('click', () => app.reset());
      $('#btnSave', host).addEventListener('click', () => app.save());
      $('#btnLoad', host).addEventListener('click', () => app.load());
      $('#btnPng', host).addEventListener('click', () => app.exportPng());
    }, { order: 10 });

    // ── 预置实验 + 慢动作 ──
    ctx.slot('topbar.right', (host) => {
      host.innerHTML = `
        <select id="selPreset" class="tb-select" title="载入一个搭好的实验场景">
          <option value="">预置实验…</option>
        </select>
        <label class="tb-check" title="把时间放慢到 1/4，方便观察">
          <input id="chkSlow" type="checkbox"><span>慢动作</span>
        </label>`;
      $('#selPreset', host).addEventListener('change', (e) => {
        if (e.target.value) { app.loadPreset(e.target.value); e.target.value = ''; }
      });
      $('#chkSlow', host).addEventListener('change', (e) => {
        app.engine.speed = e.target.checked ? 0.25 : 1;
        app.toast(e.target.checked ? '慢动作 0.25×' : '恢复正常速度');
      });
      app.populatePresets();
    }, { order: 5 });
  },
};
