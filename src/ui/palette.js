// ══════════════════════════════════════════════════════════
// UI · 器材栏
// 与 registry 的 groups() 对接：域过滤 + 关键字搜索 + 分类分组
// ══════════════════════════════════════════════════════════

import { groups } from '../equipment/registry.js';

const DOMAIN_CLASS = { physics: 'phys', chemistry: 'chem', bridge: 'bridge' };

export class Palette {
  constructor(listEl, app) {
    this.el = listEl;
    this.app = app;
    this.domain = 'all';
    this.q = '';
    this.render();
  }

  setDomain(d) { this.domain = d; this.render(); }
  setQuery(q) { this.q = q; this.render(); }

  render() {
    const gs = groups({ domain: this.domain, q: this.q });

    if (!gs.length) {
      this.el.replaceChildren(el('div', 'pal-empty',
        this.q ? `没有找到「${this.q}」相关的器材` : '该分类下暂无器材'));
      return;
    }

    const frag = document.createDocumentFragment();
    for (const g of gs) {
      const wrap = el('div', 'pcat');
      wrap.appendChild(el('div', 'pcat-title', g.cat));
      for (const d of g.items) {
        const it = el('div', 'pitem ' + (DOMAIN_CLASS[d.domain] || ''));
        if (d.pack) it.dataset.pack = '1';
        // 键盘可达：侧栏里的器材条目等同于按钮（画布内可豁免，侧栏不可）
        it.tabIndex = 0;
        it.setAttribute('role', 'button');
        it.setAttribute('aria-label', `添加器材：${d.name}`);
        it.title = (d.desc || d.name)
          + (d.pack ? `\n来自器材包：${d.packName || d.pack}` : '')
          + (d.tags ? '\n标签：' + d.tags.join(' / ') : '');
        it.appendChild(el('span', 'pi-ico', d.icon));
        const txt = el('span', 'pi-txt');
        txt.appendChild(el('b', '', d.name));
        txt.appendChild(el('small', '', d.desc || ''));
        it.appendChild(txt);
        it.addEventListener('click', () => this.app.addEntity(d.type));
        it.addEventListener('keydown', (ev) => {
          if (ev.key !== 'Enter' && ev.key !== ' ') return;
          // 全局快捷键挂在 window 上：焦点在条目上时 Space 必须属于条目，
          // 否则会同时切换「运行 / 暂停」；preventDefault 顺带挡住页面滚动。
          ev.preventDefault();
          ev.stopPropagation();
          this.app.addEntity(d.type);
        });
        frag.appendChild(it);
      }
      frag.appendChild(wrap);
    }
    this.el.replaceChildren(frag);
  }
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}
