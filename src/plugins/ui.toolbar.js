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
  desc: '工具选择、运行 / 重置 / 撤销 / 重做 / 保存 / 载入 / 截图，以及预置实验与实验速度档',
  author: '小墨实验室',
  builtin: true,
  tags: ['界面', '工具栏'],
  requires: ['xiaomo.ui.interaction'],
  setup(ctx) {
    const app = ctx.app;
    const $ = (s, r = document) => r.querySelector(s);
    const $$ = (s, r = document) => [...r.querySelectorAll(s)];

    // ── C9：撤销 / 重做的入口与状态同步 ──
    // 骨架在 `src/core/undo.js`（不归我改 ✗）。它的公开可读状态够用：`canUndo()` / `canRedo()`
    // ⇒ 不需要为 UI 给它加接口 ✓。
    // ⚠ 而它**不发任何事件**（`push` / `undo` / `redo` 全程静默）⇒ 「随栈状态实时更新」只能靠节拍
    //   轮询 ✗。轮询体只做两次布尔比较，且**只在值真的变了才写 DOM** ⇒ 每帧代价可忽略 ✓。
    let btnUndo = null, btnRedo = null, lastU = null, lastR = null;
    const syncHistory = () => {
      btnUndo = btnUndo || $('#btnUndo');
      btnRedo = btnRedo || $('#btnRedo');
      const st = app.undo;
      if (!st) return;
      const u = st.canUndo(), r = st.canRedo();
      if (u !== lastU) { if (btnUndo) btnUndo.disabled = !u; lastU = u; }
      if (r !== lastR) { if (btnRedo) btnRedo.disabled = !r; lastR = r; }
    };
    // ⚠「真禁用」是**两条**，缺一条就是假禁用 ✗：
    //   ① `disabled` —— 浏览器根本不会对禁用按钮派发 click；
    //   ② 处理体内**再判一次** —— 探针会绕过浏览器直接调处理体，
    //      只靠 ① 的那种"画成灰的还能点"在直接调用下会漏 ✗。
    const doUndo = () => { const st = app.undo; if (!st || !st.canUndo()) return false; st.undo(); syncHistory(); return true; };
    const doRedo = () => { const st = app.undo; if (!st || !st.canRedo()) return false; st.redo(); syncHistory(); return true; };

    // 光标在输入类元素里时**不许抢**快捷键。形状同 `main.js:282`，
    // 另补一条它没有的：`contenteditable` 的 `tagName` 是 `div` ⇒ 只按 tag 判会漏 ✗。
    const typing = (t) => {
      if (!t) return false;
      const tag = String(t.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'select' || tag === 'textarea') return true;
      if (t.isContentEditable === true) return true;
      return !!(t.closest && t.closest('[contenteditable=""],[contenteditable="true"]'));
    };
    const onKey = (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      if (typing(e.target)) return;
      const k = String(e.key || '').toLowerCase();
      // ⚠ 只在**真的撤销/重做了**才 preventDefault：栈空时不吞掉浏览器原生的 Ctrl+Z ✓。
      if (k === 'z' && !e.shiftKey) { if (doUndo()) e.preventDefault(); return; }
      if (k === 'y' || (k === 'z' && e.shiftKey)) { if (doRedo()) e.preventDefault(); return; }
    };
    window.addEventListener('keydown', onKey);
    const offTick = app.addTick?.(syncHistory);
    ctx.onDispose(() => { window.removeEventListener('keydown', onKey); if (offTick) offTick(); });

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
        <button type="button" id="btnUndo" class="tb-btn" title="撤销 (Ctrl+Z)" disabled>↶</button>
        <button type="button" id="btnRedo" class="tb-btn" title="重做 (Ctrl+Y)" disabled>↷</button>
        <span class="tb-sep"></span>
        <button type="button" id="btnSave" class="tb-btn" title="保存场景 (Ctrl+S)">💾</button>
        <button type="button" id="btnLoad" class="tb-btn" title="载入场景 (Ctrl+O)">📂</button>
        <button type="button" id="btnPng" class="tb-btn" title="导出实验台截图">📷</button>`;
      $('#btnRun', host).addEventListener('click', () => app.toggleRun());
      $('#btnReset', host).addEventListener('click', () => app.reset());
      // C9：两个入口按钮挂上后立刻同步一次禁用态（初始 markup 里是 disabled，
      // 引擎/世界已有历史时这一句要把它翻回来 ✓）。
      $('#btnUndo', host).addEventListener('click', () => doUndo());
      $('#btnRedo', host).addEventListener('click', () => doRedo());
      syncHistory();
      $('#btnSave', host).addEventListener('click', () => app.save());
      $('#btnLoad', host).addEventListener('click', () => app.load());
      $('#btnPng', host).addEventListener('click', () => app.exportPng());
    }, { order: 10 });

    // ── 预置实验 + 实验速度（B1）──
    ctx.slot('topbar.right', (host) => {
      host.innerHTML = `
        <select id="selPreset" class="tb-select" title="载入一个搭好的实验场景">
          <option value="">预置实验…</option>
        </select>
        <select id="selSpeed" class="tb-select" title="实验速度"></select>`;
      $('#selPreset', host).addEventListener('change', (e) => {
        if (e.target.value) { app.loadPreset(e.target.value); e.target.value = ''; }
      });
      // B1：档位表与档位文案都由 Engine 提供 ⇒ 工具栏里不再出现 0.25 / 1 这类硬编码档位，
      //     也因此「档位」只有一处真源：`engine.speeds` + `engine.speed`。
      const sel = $('#selSpeed', host);
      const sync = () => {
        sel.innerHTML = app.engine.speeds
          .map((s) => `<option value="${s}">${app.engine.speedLabel(s)}</option>`).join('');
        sel.value = String(app.engine.speed);
        sel.title = `实验速度 ${app.engine.speedLabel()}（只改时间步进，不改物理结果）`;
      };
      sel.addEventListener('change', (e) => {
        app.engine.setSpeed(e.target.value);
        sync();
        app.toast(`实验速度 ${app.engine.speedLabel()}`);
      });
      sync();
      app.populatePresets();
    }, { order: 5 });
  },
};
