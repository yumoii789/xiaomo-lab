// ══════════════════════════════════════════════════════════
// UI · 器材栏
// 与 registry 的 groups() 对接：域过滤 + 关键字搜索 + 分类分组
//
// 器材栏只是器材注册表的投影 —— 真值在 registry 里，这里不缓存第二份。
// 投影方式是「按 type 键控协调」，而不是每次重建整列：
//   · 行元素按 type 复用/移动，值真变时才写 DOM，节点身份稳定 ——
//     正在进行的过渡、以及用户焦点都不会被一次同步打断；
//   · 复用的行身上挂着事件与 aria，所以协调时只允许改内容、不允许换节点；
//   · 正因为不重建，「这个类型还在不在」就必须在点下去的那一刻当场再问注册表一次（place）。
// ══════════════════════════════════════════════════════════

import { get, groups } from '../equipment/registry.js';

const DOMAIN_CLASS = { physics: 'phys', chemistry: 'chem', bridge: 'bridge' };

/** 值没变就不写：反复写同样的属性会打断过渡，也会平白制造变更记录 */
const setText = (n, t) => { if (n.textContent !== t) n.textContent = t; };
const setAttr = (n, k, v) => { if (n.getAttribute(k) !== v) n.setAttribute(k, v); };

/** 只在位置真的不对时才移动：insertBefore 会让节点重新入树，能不动就不动 */
function place(parent, node, prev) {
  const want = prev ? prev.nextSibling : parent.firstChild;
  if (node.parentNode !== parent || node !== want) parent.insertBefore(node, want);
}

export class Palette {
  constructor(listEl, app) {
    this.el = listEl;
    this.app = app;
    this.domain = 'all';
    this.q = '';
    this.rows = new Map();   // type   -> .pitem（摘下去也留在表里：筛选来回切、插件停了又开，都复用同一节点）
    this.cats = new Map();   // 分类名 -> .pcat
    this.empty = null;       // 空态占位：只有它一个节点，没有身份要保
    this.sync();
  }

  setDomain(d) { if (this.domain !== d) { this.domain = d; this.sync(); } }

  setQuery(q) {
    const v = String(q == null ? '' : q);
    if (this.q !== v) { this.q = v; this.sync(); }
  }

  /** 旧名保留：对外其实只有「按注册表重新投影」这一件事 */
  render() { this.sync(); }

  /** 按注册表重新投影。幂等 —— 同一份注册表状态连跑多少次，DOM 与节点身份都不变。 */
  sync() {
    const gs = groups({ domain: this.domain, q: this.q });

    if (!gs.length) {
      if (!this.empty) {
        this.empty = document.createElement('div');
        this.empty.className = 'pal-empty';
      }
      setText(this.empty, this.q ? `没有找到「${this.q}」相关的器材` : '该分类下暂无器材');
      place(this.el, this.empty, null);
      // 分类容器整体摘走，行还在容器里，所以节点身份不丢
      for (const cat of this.cats.values()) cat.remove();
      return;
    }
    if (this.empty) this.empty.remove();

    const live = new Set();
    let prevCat = null;
    for (const g of gs) {
      let cat = this.cats.get(g.cat);
      if (!cat) {
        cat = document.createElement('div');
        cat.className = 'pcat';
        const title = document.createElement('div');
        title.className = 'pcat-title';
        cat.appendChild(title);
        this.cats.set(g.cat, cat);
      }
      setText(cat.firstElementChild, g.cat);

      let prev = cat.firstElementChild;
      for (const d of g.items) {
        live.add(d.type);
        let row = this.rows.get(d.type);
        if (!row) { row = this.makeRow(d); this.rows.set(d.type, row); }
        this.paintRow(row, d);
        place(cat, row, prev);
        prev = row;
      }
      place(this.el, cat, prevCat);
      prevCat = cat;
    }

    // 不在当前投影里的行摘下去；真正从注册表消失的类型也把行留在表里（下次回来还能复用）
    for (const [type, row] of this.rows) if (!live.has(type)) row.remove();
    for (const [name, cat] of this.cats) {
      if (gs.some((g) => g.cat === name)) continue;
      cat.remove();
      this.cats.delete(name);
    }
  }

  /**
   * 真的落一件器材。类型必须当场问注册表 ——
   * 注册表的 remove() 目前不通知任何人（tools/palette-probe.html 里有实测），
   * 所以点下去的那一刻这个类型可能已经不存在：那就既不能抛错，也不能默默毫无反应。
   */
  place(d) {
    if (!get(d.type)) {
      if (this.app.toast) this.app.toast(`「${d.name}」所在的器材包已被卸载，无法添加`, 'warn');
      this.sync();                        // 顺手把这条陈旧投影摘掉
      return null;
    }
    return this.app.addEntity(d.type);
  }

  /** 键盘可达：侧栏里的器材条目等同于按钮（画布内可豁免，侧栏不可） */
  makeRow(d) {
    const row = document.createElement('div');
    row.className = 'pitem';
    row.dataset.type = d.type;            // 键控协调、探针与人工排查都靠它定位这一行
    row.tabIndex = 0;
    row.setAttribute('role', 'button');

    const ico = document.createElement('span');
    ico.className = 'pi-ico';
    const txt = document.createElement('span');
    txt.className = 'pi-txt';
    txt.appendChild(document.createElement('b'));
    txt.appendChild(document.createElement('small'));
    row.append(ico, txt);

    row.addEventListener('click', () => this.place(d));
    row.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Enter' && ev.key !== ' ') return;
      // 全局快捷键挂在 window 上：焦点在条目上时 Space 必须属于条目，
      // 否则会同时切换「运行 / 暂停」；preventDefault 顺带挡住页面滚动。
      ev.preventDefault();
      ev.stopPropagation();
      this.place(d);
    });
    return row;
  }

  /** 复用行只改内容：图标、名称、说明、域类名、包标记、aria 与提示全都跟着数据走 */
  paintRow(row, d) {
    const cls = 'pitem ' + (DOMAIN_CLASS[d.domain] || '');
    if (row.className !== cls) row.className = cls;
    if (d.pack) setAttr(row, 'data-pack', '1');
    else if (row.hasAttribute('data-pack')) row.removeAttribute('data-pack');
    setAttr(row, 'aria-label', `添加器材：${d.name}`);
    setAttr(row, 'title', (d.desc || d.name)
      + (d.pack ? `\n来自器材包：${d.packName || d.pack}` : '')
      + (d.tags ? '\n标签：' + d.tags.join(' / ') : ''));
    setText(row.firstElementChild, d.icon);
    const txt = row.lastElementChild;
    setText(txt.firstElementChild, d.name);
    setText(txt.lastElementChild, d.desc || '');
  }
}
