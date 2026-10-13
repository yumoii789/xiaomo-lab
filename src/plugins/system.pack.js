// ══════════════════════════════════════════════════════════
// 器材包 —— 让用户自己往实验室里加器材
//
// 器材包是**纯 JSON 数据**：不 eval、不 import、不解压脚本，
// 所以导入陌生人做的包永远是安全的。包里的每件器材都要
// 声明它派生自哪个已有原型（proto），行为全部继承，
// 只覆盖你写明的名称、尺寸、端口、默认参数和可调字段。
//
// 存储：localStorage['xiaomo.packs.v1']
// ══════════════════════════════════════════════════════════

import { derive, get, remove } from '../equipment/registry.js';

const KEY = 'xiaomo.packs.v1';
const FORMAT = 'xiaomo.equipment.pack';

// ─────────────────────────────────────────────────────────
// 校验
// ─────────────────────────────────────────────────────────

/**
 * 检查一个器材包能不能装。
 * 只做结构检查 + 原型存在性检查，任何一条不过就直接拒绝，
 * 避免装到一半留下半套器材。
 */
export function validatePack(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: '不是一个 JSON 对象' };
  }
  if (raw.format !== FORMAT) {
    return { ok: false, error: `不是小墨器材包（format 应为 "${FORMAT}"）` };
  }
  if (!raw.id || typeof raw.id !== 'string') {
    return { ok: false, error: '缺少包标识 id' };
  }
  if (!Array.isArray(raw.equipment) || raw.equipment.length === 0) {
    return { ok: false, error: '包里没有任何器材' };
  }

  const seen = new Set();
  for (let i = 0; i < raw.equipment.length; i++) {
    const e = raw.equipment[i];
    const tag = `第 ${i + 1} 件器材`;

    if (!e || typeof e !== 'object' || Array.isArray(e)) {
      return { ok: false, error: `${tag}不是对象` };
    }
    if (!e.type || typeof e.type !== 'string') {
      return { ok: false, error: `${tag}缺少 type` };
    }
    if (seen.has(e.type)) {
      return { ok: false, error: `器材标识「${e.type}」在包里重复出现` };
    }
    seen.add(e.type);

    if (!e.proto || typeof e.proto !== 'string') {
      return { ok: false, error: `器材「${e.name || e.type}」缺少 proto（它派生自哪件器材）` };
    }
    if (!get(e.proto)) {
      return { ok: false, error: `器材「${e.name || e.type}」引用了不存在的原型「${e.proto}」` };
    }
    if (get(e.type)) {
      return { ok: false, error: `器材标识「${e.type}」已被占用，换个 type 再试` };
    }
  }

  return { ok: true, pack: raw };
}

// ─────────────────────────────────────────────────────────
// 已安装列表（只存原始 JSON，启动时重放）
// ─────────────────────────────────────────────────────────

function loadAll() {
  try {
    const arr = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function saveAll(arr) {
  try { localStorage.setItem(KEY, JSON.stringify(arr)); } catch { /* 配额满了就算了 */ }
}

/** 把包里的器材真正注册进去，返回装上的 type 列表 */
function applyPack(pack) {
  const made = [];
  for (const e of pack.equipment) {
    derive(e, pack);
    made.push(e.type);
  }
  return made;
}

/** 卸掉包里的器材 */
function unapplyPack(pack) {
  for (const e of pack.equipment) remove(e.type);
}

// ─────────────────────────────────────────────────────────
// 插件
// ─────────────────────────────────────────────────────────

export default {
  id: 'xiaomo.system.pack',
  name: '器材包',
  version: '1.0.0',
  kind: 'system',
  desc: '导入 / 导出 / 卸载器材包：纯数据扩展，不改一行代码就能加新器材',
  author: '小墨实验室',
  builtin: true,
  requires: ['xiaomo.equipment.electrical'],
  tags: ['器材', '扩展'],
  setup(ctx) {
    const app = ctx.app;

    // ── 启动时重放已安装的包 ──
    const packs = loadAll();
    let restored = 0;
    const broken = [];
    for (const p of packs) {
      const v = validatePack(p);
      if (!v.ok) { broken.push({ pack: p, error: v.error }); continue; }
      try { applyPack(p); restored++; }
      catch (e) { broken.push({ pack: p, error: e.message }); }
    }
    if (restored) app.toast(`已装载 ${restored} 个器材包`);
    for (const b of broken) {
      console.warn('[器材包] 装载失败：' + (b.pack && b.pack.name) + ' —— ' + b.error);
    }

    /** 装一个包 */
    const install = (raw, { silent = false } = {}) => {
      const v = validatePack(raw);
      if (!v.ok) {
        if (!silent) app.toast('器材包有问题：' + v.error, 'danger');
        return v;
      }
      const all = loadAll();
      if (all.some(p => p.id === raw.id)) {
        // 同 id 先卸旧的再装新的，方便改包后重装
        const old = all.find(p => p.id === raw.id);
        unapplyPack(old);
        saveAll(all.filter(p => p.id !== raw.id));
      }
      try {
        const made = applyPack(raw);
        saveAll([...loadAll(), raw]);
        if (!silent) app.toast(`器材包「${raw.name || raw.id}」已装载，新增 ${made.length} 件器材`);
        return { ok: true, pack: raw, made };
      } catch (e) {
        // 装到一半失败：把已经注册的撤掉，保持干净
        try { unapplyPack(raw); } catch { /* 尽力而为 */ }
        if (!silent) app.toast('装载失败：' + e.message, 'danger');
        return { ok: false, error: e.message };
      }
    };

    /** 卸一个包 */
    const uninstall = (id) => {
      const all = loadAll();
      const p = all.find(x => x.id === id);
      if (!p) return { ok: false, error: '没有这个包' };
      unapplyPack(p);
      saveAll(all.filter(x => x.id !== id));
      app.toast(`已卸载器材包「${p.name || p.id}」`);
      return { ok: true };
    };

    const listPacks = () => loadAll();

    // 暴露给别的插件 / 控制台
    ctx.app.services.packs = { install, uninstall, list: listPacks, validate: validatePack };

    // ─────────────────────────────────────────────────────
    // 界面：入口按钮
    // ─────────────────────────────────────────────────────
    ctx.slot('topbar.right', (host) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'tb-btn';
      b.id = 'btnPacks';
      b.title = '器材包';
      b.textContent = '📦';
      b.addEventListener('click', () => openDrawer());
      host.appendChild(b);
    }, { order: 40 });

    // ─────────────────────────────────────────────────────
    // 界面：抽屉
    // ─────────────────────────────────────────────────────
    let renderBody = () => {};
    let openDrawer = () => {};   // 在下面的 slot 回调里被真正赋值

    ctx.slot('overlay', (host) => {
      const mask = document.createElement('div');
      mask.className = 'drawer-mask';
      mask.innerHTML = `
        <div class="drawer" role="dialog" aria-modal="true" aria-label="器材包">
          <div class="drawer-head">
            <b>器材包</b>
            <span class="pack-sub">纯数据扩展，安全可卸载</span>
            <button type="button" class="drawer-x" title="关闭">✕</button>
          </div>
          <div class="drawer-body pack-body"></div>
          <div class="drawer-foot">
            <button type="button" class="btn acc" data-act="import">导入器材包…</button>
            <button type="button" class="btn" data-act="export">导出示例</button>
            <button type="button" class="btn" data-act="doc">格式说明</button>
          </div>
        </div>`;
      host.appendChild(mask);

      const body = mask.querySelector('.pack-body');

      // ── 浮层时序与焦点（§2-C1 C1 / C2 / C8）──────────────
      // 退场时长不写死：读遮罩与面板的计算过渡时长，并以 transitionend 为主信号。
      // §2-A12 把退场收到 --t-base 之后，这里自动跟随，不需要改任何毫秒数。
      const EXIT_SLACK = 80;    // 兜底余量（约一帧多），不是过渡时长
      const toMs = (v) => {
        const n = parseFloat(v) || 0;
        return /ms\s*$/.test(String(v).trim()) ? n : n * 1000;
      };
      const exitMs = (root) => {
        let max = 0;
        for (const el of [root, root.firstElementChild]) {
          if (!el) continue;
          for (const d of getComputedStyle(el).transitionDuration.split(',')) max = Math.max(max, toMs(d));
        }
        return max + EXIT_SLACK;
      };

      const shell = document.getElementById('app');
      const canInert = typeof HTMLElement !== 'undefined' && 'inert' in HTMLElement.prototype;
      let restoreFocus = null;
      const lockBg = () => {
        if (!shell) return;
        if (canInert) shell.inert = true; else shell.setAttribute('aria-hidden', 'true');
      };
      const unlockBg = () => {
        if (!shell) return;
        // 还有别的浮层开着就别解除（所有浮层共用同一层被遮背景）
        if (document.querySelector('.drawer-mask.show,.expel-mask.show,.about-mask.show')) return;
        if (canInert) shell.inert = false; else shell.removeAttribute('aria-hidden');
      };
      const focusPanel = () => {
        const t = mask.querySelector('button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])');
        if (t && t.focus) t.focus({ preventScroll: true });
      };
      const giveBackFocus = () => {
        if (restoreFocus && restoreFocus.focus) restoreFocus.focus({ preventScroll: true });
        restoreFocus = null;
      };

      let closing = 0;
      const cancelClose = () => { if (closing) { clearTimeout(closing); closing = 0; } };

      const close = () => {
        if (!mask.classList.contains('show')) return;
        mask.classList.remove('in');        // 必须和 show 一起移除：残留的 in 会让下次打开首帧就位
        const wait = exitMs(mask);
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          mask.removeEventListener('transitionend', onEnd);
          clearTimeout(closing);
          closing = 0;
          if (!mask.classList.contains('in')) mask.classList.remove('show');
          unlockBg();
          giveBackFocus();
        };
        const onEnd = (e) => {
          if (e.target !== mask && !mask.contains(e.target)) return;
          if (e.propertyName !== 'transform' && e.propertyName !== 'opacity') return;
          finish();
        };
        mask.addEventListener('transitionend', onEnd);
        closing = setTimeout(finish, wait);
      };

      openDrawer = () => {
        cancelClose();
        renderBody();
        restoreFocus = document.activeElement;
        const wasHidden = !mask.classList.contains('show');
        if (wasHidden) mask.classList.remove('in');   // 关闭态重开：先回到起点，滑入才会真的播放
        mask.classList.add('show');
        void mask.offsetWidth;                        // 立刻结算起点（display:none → flex 后位移才有过渡）
        mask.classList.add('in');
        lockBg();
        focusPanel();
      };

      mask.addEventListener('click', (e) => { if (e.target === mask) close(); });
      mask.querySelector('.drawer-x').addEventListener('click', close);
      window.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });

      // ── 主进程菜单 / 桌面事件也能唤起 ──
      window.addEventListener('xiaomo:pack-import', () => { openDrawer(); doImport(); });

      // ── 抽屉内容 ──
      renderBody = () => {
        const packs = listPacks();
        if (!packs.length) {
          body.innerHTML = `
            <div class="blank">
              <div class="blank-t">还没有装过器材包</div>
              <div class="blank-s">器材包是一个 JSON 文件，<br>里面可以用已有器材派生出新器材。</div>
            </div>`;
          return;
        }
        body.innerHTML = '';
        for (const p of packs) {
          const n = (p.equipment || []).length;
          const row = document.createElement('div');
          row.className = 'pack-card';
          row.innerHTML = `
            <div class="pack-head">
              <b>${esc(p.name || p.id)}</b>
              <span class="pack-count">${n} 件</span>
            </div>
            <div class="pack-desc">${esc(p.desc || p.author || '')}</div>
            <div class="pack-items">${(p.equipment || []).map(e => `<span>${esc(e.name || e.type)}</span>`).join('')}</div>
            <div class="pack-acts">
              <button type="button" class="btn dgr" data-del="${esc(p.id)}">卸载</button>
            </div>`;
          body.appendChild(row);
        }
        body.querySelectorAll('[data-del]').forEach((btn) => {
          btn.addEventListener('click', () => { uninstall(btn.dataset.del); renderBody(); });
        });
      };

      // ── 导入：桌面版走原生对话框，网页版走 <input type=file> ──
      const ingest = (texts) => {
        let okCount = 0;
        for (const { name, text } of texts) {
          let raw;
          try { raw = JSON.parse(text); }
          catch (e) { app.toast(`${name} 不是合法 JSON`, 'danger'); continue; }
          const r = install(raw);
          if (r.ok) okCount++;
        }
        renderBody();
        if (okCount > 1) app.toast(`共装载 ${okCount} 个器材包`);
      };

      const doImport = async () => {
        const D = window.xiaomoDesktop;
        if (D && D.isDesktop && D.importPack) {
          const r = await D.importPack();
          if (!r.ok) { if (!r.canceled) app.toast('导入失败：' + (r.error || ''), 'danger'); return; }
          ingest(r.packs);
          return;
        }
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json,.xiaomo-pack,application/json';
        input.multiple = true;
        input.addEventListener('change', async () => {
          const files = [...(input.files || [])];
          const texts = [];
          for (const f of files) texts.push({ name: f.name, text: await f.text() });
          ingest(texts);
        });
        input.click();
      };

      // ── 导出示例 ──
      const SAMPLE = {
        format: FORMAT,
        version: 1,
        id: 'xiaomo.sample.pack',
        name: '示例器材包',
        author: '小墨实验室',
        desc: '演示怎么用已有器材派生出新器材',
        equipment: [
          {
            type: 'sample-big-battery',
            proto: 'battery',
            name: '大号干电池',
            desc: '电动势更高的干电池，内阻也更大',
            icon: '🔋',
            defaults: { emf: 9, internalR: 1.2 },
          },
          {
            type: 'sample-wide-beaker',
            proto: 'beaker',
            name: '宽口烧杯',
            desc: '容量更大的烧杯',
            w: 92,
            h: 84,
            defaults: { capacity: 500 },
          },
        ],
      };

      const doExport = async () => {
        const json = JSON.stringify(SAMPLE, null, 2);
        const D = window.xiaomoDesktop;
        if (D && D.isDesktop && D.exportPack) {
          const r = await D.exportPack(json, '示例器材包.xiaomo-pack');
          if (r.ok) app.toast('已导出到 ' + r.name);
          else if (!r.canceled) app.toast('导出失败：' + (r.error || ''), 'danger');
          return;
        }
        const blob = new Blob([json], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = '示例器材包.xiaomo-pack';
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 2000);
        app.toast('示例器材包已下载');
      };

      const doDoc = () => {
        window.dispatchEvent(new CustomEvent('xiaomo:about', { detail: true }));
        app.toast('格式说明见仓库 docs/器材包格式.md');
      };

      mask.querySelector('[data-act=import]').addEventListener('click', doImport);
      mask.querySelector('[data-act=export]').addEventListener('click', doExport);
      mask.querySelector('[data-act=doc]').addEventListener('click', doDoc);
    }, { order: 21 });

    // 供顶部按钮调用
  },
};

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
