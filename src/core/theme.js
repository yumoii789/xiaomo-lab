// ══════════════════════════════════════════════════════════
// 主题管理器 —— 内核服务（不认识任何具体配色）
//
// 主题本身就是插件：插件往 ctx.themes 里塞一份 token 表，
// 管理器负责把它刷成 CSS 变量并同步画布配色。
// ══════════════════════════════════════════════════════════

import { bus } from './bus.js';
import { currentRegistry } from './plugin.js';

/** 画布配色（会被主题覆盖），保持旧字段名以免改动渲染层 */
export const DEFAULT_C = {
  bg: '#0e1216',
  bench: '#12171c',
  benchEdge: '#1a2128',
  grid: '#151b21',
  gridStrong: '#1c242c',

  text: '#e6edf3',
  text2: '#8d96a0',
  text3: '#5c6672',

  accent: '#2dd4bf',
  accentDim: 'rgba(45,212,191,.30)',
  chem: '#f0a020',
  chemDim: 'rgba(240,160,32,.30)',
  bridge: '#8b5cf6',
  bridgeDim: 'rgba(139,92,246,.30)',

  danger: '#f04747',
  ok: '#3fb950',
  warn: '#f0a020',

  wire: '#6b7885',
  wireHot: '#ffd166',
  port: '#4a5560',
  portHot: '#2dd4bf',

  select: '#2dd4bf',
  ghost: 'rgba(45,212,191,.16)',
};

export const C = { ...DEFAULT_C };

/** 会被刷到 :root 上的 CSS 变量名 */
export const CSS_TOKENS = [
  'bg', 'surface', 'surface-2', 'surface-3', 'surface-4',
  'border', 'border-2', 'border-3',
  'text', 'text-2', 'text-3',
  'accent', 'accent-2', 'accent-soft', 'accent-line',
  'chem', 'chem-soft', 'bridge', 'bridge-soft',
  'danger', 'danger-soft', 'ok', 'warn',
  'glass', 'glass-2', 'shadow', 'radius', 'radius-sm',
];

export class ThemeManager {
  constructor() {
    this.themes = new Map();
    this.id = null;
    this.mode = 'system';        // dark | light | system
    this.systemLight = false;
    this._subs = [];
    this._mq = null;
  }

  define(t) {
    if (!t || !t.id) throw new Error('主题缺少 id');
    this.themes.set(t.id, t);
    if (!this.id) this.id = t.id;
    // 顺手登记进「当前插件作用域」的注册表：主题的真身在管理器这个单例里，
    // 但插件管理器统计贡献时要能从注册表看到它，否则数字会永远是 0。
    try {
      const reg = currentRegistry();
      if (reg && !reg.has(t.id)) reg.define(t, t.id);
    } catch { /* 注册表不可用不影响主题生效 */ }
    return t;
  }

  list() { return [...this.themes.values()]; }
  get current() { return this.themes.get(this.id) || null; }

  /** 实际生效的深浅色 */
  get effective() {
    if (this.mode === 'system') return this.systemLight ? 'light' : 'dark';
    return this.mode;
  }

  use(id, mode) {
    if (id && this.themes.has(id)) this.id = id;
    if (mode) this.mode = mode;
    this.apply();
    return this;
  }

  toggle() {
    this.mode = this.effective === 'dark' ? 'light' : 'dark';
    this.apply();
    return this.effective;
  }

  setMode(m) { this.mode = m; this.apply(); }

  onChange(fn) { this._subs.push(fn); return () => { const i = this._subs.indexOf(fn); if (i >= 0) this._subs.splice(i, 1); }; }

  /** 跟随系统深浅色 */
  watchSystem() {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    this._mq = window.matchMedia('(prefers-color-scheme: light)');
    this.systemLight = this._mq.matches;
    const on = (e) => {
      this.systemLight = e.matches;
      if (this.mode === 'system') this.apply();
    };
    if (this._mq.addEventListener) this._mq.addEventListener('change', on);
    else if (this._mq.addListener) this._mq.addListener(on);
  }

  apply() {
    const t = this.current;
    if (!t) return;
    const eff = this.effective;
    const tokens = (t.tokens && (t.tokens[eff] || t.tokens.dark)) || {};

    if (typeof document !== 'undefined') {
      const root = document.documentElement;
      for (const k of CSS_TOKENS) {
        if (tokens[k] != null) root.style.setProperty('--' + k, tokens[k]);
      }
      root.dataset.theme = t.id;
      root.dataset.mode = eff;
      root.style.colorScheme = eff;
      // 手机状态栏 / 浏览器 chrome 的颜色要跟着「生效的主题」走 —— 本应用可以手动
      // 切深浅色，写两条按 prefers-color-scheme 的 meta 只跟 OS，手动切换时颜色就错了。
      // 配色真值只有一份：--bg 刚刚在上面被刷成当前主题的值，这里只把它转写到 meta 上。
      const meta = document.querySelector('meta[name="theme-color"]');
      if (meta) {
        const bg = tokens.bg || getComputedStyle(root).getPropertyValue('--bg').trim();
        if (bg) meta.setAttribute('content', bg);
      }
    }

    Object.assign(C, DEFAULT_C, (t.canvas && t.canvas[eff]) || {});

    for (const fn of this._subs.slice()) {
      try { fn(t, eff); } catch (e) { console.error('[theme] 订阅回调异常', e); }
    }
    bus.emit('theme:changed', { id: t.id, mode: eff });
  }
}

export const theme = new ThemeManager();

export function domainColor(d) {
  return d === 'physics' ? C.accent : d === 'chemistry' ? C.chem : C.bridge;
}
export function domainDim(d) {
  return d === 'physics' ? C.accentDim : d === 'chemistry' ? C.chemDim : C.bridgeDim;
}

/** 温度 → 颜色（用于液体、加热可视化） */
export function tempColor(t) {
  const stops = [
    [0, [70, 130, 200]],
    [15, [90, 170, 210]],
    [25, [120, 200, 200]],
    [50, [235, 170, 90]],
    [80, [235, 110, 70]],
    [100, [220, 60, 60]],
  ];
  let a = stops[0], b = stops[stops.length - 1];
  for (let i = 0; i < stops.length - 1; i++) {
    if (t >= stops[i][0] && t <= stops[i + 1][0]) { a = stops[i]; b = stops[i + 1]; break; }
  }
  const k = b[0] === a[0] ? 0 : (t - a[0]) / (b[0] - a[0]);
  const mix = (i) => Math.round(a[1][i] + (b[1][i] - a[1][i]) * k);
  return `rgb(${mix(0)},${mix(1)},${mix(2)})`;
}
