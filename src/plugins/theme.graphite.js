// ══════════════════════════════════════════════════════════
// 主题插件：Graphite（石墨）
//
// 第二个主题，用来证明主题确实是一个可插拔的插件：
// 它不碰内核一行代码，只是往 ctx.themes 里塞了另一份 token 表。
// 观感是冷灰中性色，强调色用低饱和的天青。
// ══════════════════════════════════════════════════════════

import { theme } from '../core/theme.js';

const dark = {
  'bg': '#0c0d0f',
  'surface': '#121417',
  'surface-2': '#17191d',
  'surface-3': '#1d2025',
  'surface-4': '#24282e',
  'border': '#24272d',
  'border-2': '#2f333a',
  'border-3': '#3c4149',
  'text': '#e8eaee',
  'text-2': '#9aa1ab',
  'text-3': '#6d737c',
  'accent': '#5eb0d8',
  'accent-2': '#3f96c0',
  'accent-soft': 'rgba(94,176,216,.13)',
  'accent-line': 'rgba(94,176,216,.40)',
  'chem': '#e0a04a',
  'chem-soft': 'rgba(224,160,74,.14)',
  'bridge': '#b79cf5',
  'bridge-soft': 'rgba(183,156,245,.14)',
  'danger': '#e96a6a',
  'danger-soft': 'rgba(233,106,106,.14)',
  'ok': '#54c98a',
  'warn': '#e0b04a',
  'glass': 'rgba(18,20,23,.72)',
  'glass-2': 'rgba(23,25,29,.55)',
  'shadow': '0 10px 30px rgba(0,0,0,.46)',
  'radius': '12px',
  'radius-sm': '8px',
};

const light = {
  'bg': '#f5f6f8',
  'surface': '#ffffff',
  'surface-2': '#fafbfc',
  'surface-3': '#eff1f4',
  'surface-4': '#e5e8ed',
  'border': '#e0e3e8',
  'border-2': '#ccd1d9',
  'border-3': '#b4bac4',
  'text': '#171a1f',
  'text-2': '#565c66',
  'text-3': '#808790',
  'accent': '#2b7fa8',
  'accent-2': '#1f6688',
  'accent-soft': 'rgba(43,127,168,.11)',
  'accent-line': 'rgba(43,127,168,.36)',
  'chem': '#b8791f',
  'chem-soft': 'rgba(184,121,31,.12)',
  'bridge': '#6d4fd0',
  'bridge-soft': 'rgba(109,79,208,.11)',
  'danger': '#cf4b4b',
  'danger-soft': 'rgba(207,75,75,.11)',
  'ok': '#149257',
  'warn': '#b8791f',
  'glass': 'rgba(255,255,255,.76)',
  'glass-2': 'rgba(255,255,255,.58)',
  'shadow': '0 10px 26px rgba(20,28,40,.10)',
  'radius': '12px',
  'radius-sm': '8px',
};

const canvasDark = {
  bg: '#0c0d0f', bench: '#111316', benchEdge: '#1b1e22',
  grid: '#15171a', gridStrong: '#1c1f23',
  text: '#e8eaee', text2: '#9aa1ab', text3: '#6d737c',
  accent: '#5eb0d8', accentDim: 'rgba(94,176,216,.30)',
  chem: '#e0a04a', chemDim: 'rgba(224,160,74,.30)',
  bridge: '#b79cf5', bridgeDim: 'rgba(183,156,245,.30)',
  wire: '#6b727b', wireHot: '#8fd3f0', port: '#4a5058', portHot: '#5eb0d8',
  select: '#5eb0d8', ghost: 'rgba(94,176,216,.16)',
};

const canvasLight = {
  bg: '#f5f6f8', bench: '#ffffff', benchEdge: '#e0e3e8',
  grid: '#eceef1', gridStrong: '#dfe3e8',
  text: '#171a1f', text2: '#565c66', text3: '#808790',
  accent: '#2b7fa8', accentDim: 'rgba(43,127,168,.26)',
  chem: '#b8791f', chemDim: 'rgba(184,121,31,.26)',
  bridge: '#6d4fd0', bridgeDim: 'rgba(109,79,208,.26)',
  wire: '#8f959d', wireHot: '#1f6688', port: '#b4bac4', portHot: '#2b7fa8',
  select: '#2b7fa8', ghost: 'rgba(43,127,168,.14)',
};

export default {
  id: 'xiaomo.theme.graphite',
  name: 'Graphite 石墨',
  version: '1.0.0',
  kind: 'theme',
  desc: '冷灰中性色主题，低饱和天青强调 —— 用来演示主题的可插拔',
  author: '小墨实验室',
  builtin: true,
  tags: ['主题', '石墨', '中性'],
  order: 10,
  setup(ctx) {
    theme.define({
      id: 'graphite',
      name: 'Graphite 石墨',
      desc: '冷灰中性色',
      accent: '#5eb0d8',
      tokens: { dark, light },
      canvas: { dark: canvasDark, light: canvasLight },
    });
  },
};
