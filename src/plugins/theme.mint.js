// ══════════════════════════════════════════════════════════
// 主题插件：Mint（青柠）
//
// 设计取向：青柠绿作为唯一的强调色，底色带一点点绿的中性灰，
// 圆角与毛玻璃对齐 Win11 的观感，但不去堆发光和渐变。
// 深浅两套 token 完全等价，切换时结构不发生任何位移。
// ══════════════════════════════════════════════════════════

import { theme } from '../core/theme.js';

const dark = {
  'bg': '#0b0f0d',
  'surface': '#111613',
  'surface-2': '#161d19',
  'surface-3': '#1c241f',
  'surface-4': '#222b25',
  'border': '#232c26',
  'border-2': '#2d3831',
  'border-3': '#3a473f',
  'text': '#e7efe9',
  'text-2': '#98a69d',
  'text-3': '#6b7770',
  'accent': '#a3e635',
  'accent-2': '#84cc16',
  'accent-soft': 'rgba(163,230,53,.13)',
  'accent-line': 'rgba(163,230,53,.42)',
  'chem': '#f0a020',
  'chem-soft': 'rgba(240,160,32,.14)',
  'bridge': '#a78bfa',
  'bridge-soft': 'rgba(167,139,250,.14)',
  'danger': '#f26d6d',
  'danger-soft': 'rgba(242,109,109,.14)',
  'ok': '#4ade80',
  'warn': '#fbbf24',
  'glass': 'rgba(17,22,19,.72)',
  'glass-2': 'rgba(22,29,25,.55)',
  'shadow': '0 10px 30px rgba(0,0,0,.45)',
  'radius': '12px',
  'radius-sm': '8px',
};

const light = {
  'bg': '#f4f8f1',
  'surface': '#ffffff',
  'surface-2': '#f8fbf6',
  'surface-3': '#eef4e9',
  'surface-4': '#e4ecdd',
  'border': '#dfe7d8',
  'border-2': '#ccd8c4',
  'border-3': '#b6c5ad',
  'text': '#151f18',
  'text-2': '#55635a',
  'text-3': '#7f8c83',
  'accent': '#5f9c0c',
  'accent-2': '#4d7c0f',
  'accent-soft': 'rgba(95,156,12,.11)',
  'accent-line': 'rgba(95,156,12,.38)',
  'chem': '#c2710a',
  'chem-soft': 'rgba(194,113,10,.12)',
  'bridge': '#7c3aed',
  'bridge-soft': 'rgba(124,58,237,.11)',
  'danger': '#d64545',
  'danger-soft': 'rgba(214,69,69,.11)',
  'ok': '#15a34a',
  'warn': '#c2710a',
  'glass': 'rgba(255,255,255,.74)',
  'glass-2': 'rgba(255,255,255,.55)',
  'shadow': '0 10px 26px rgba(24,44,20,.10)',
  'radius': '12px',
  'radius-sm': '8px',
};

const canvasDark = {
  bg: '#0b0f0d',
  bench: '#0f1512',
  benchEdge: '#1a231d',
  grid: '#141b16',
  gridStrong: '#1b241d',
  text: '#e7efe9',
  text2: '#98a69d',
  text3: '#6b7770',
  accent: '#a3e635',
  accentDim: 'rgba(163,230,53,.30)',
  chem: '#f0a020',
  chemDim: 'rgba(240,160,32,.30)',
  bridge: '#a78bfa',
  bridgeDim: 'rgba(167,139,250,.30)',
  wire: '#66736a',
  wireHot: '#d9f99d',
  port: '#46524a',
  portHot: '#a3e635',
  select: '#a3e635',
  ghost: 'rgba(163,230,53,.16)',
};

const canvasLight = {
  bg: '#f4f8f1',
  bench: '#ffffff',
  benchEdge: '#dfe7d8',
  grid: '#e8efe2',
  gridStrong: '#d8e2d0',
  text: '#151f18',
  text2: '#55635a',
  text3: '#7f8c83',
  accent: '#5f9c0c',
  accentDim: 'rgba(95,156,12,.26)',
  chem: '#c2710a',
  chemDim: 'rgba(194,113,10,.26)',
  bridge: '#7c3aed',
  bridgeDim: 'rgba(124,58,237,.26)',
  wire: '#8c9890',
  wireHot: '#4d7c0f',
  port: '#b6c5ad',
  portHot: '#5f9c0c',
  select: '#5f9c0c',
  ghost: 'rgba(95,156,12,.14)',
};

export default {
  id: 'xiaomo.theme.mint',
  name: 'Mint 青柠',
  version: '1.0.0',
  kind: 'theme',
  desc: '青柠绿强调色 + 中性绿灰底色，深浅双模，圆角毛玻璃对齐 Win11 观感',
  author: '小墨实验室',
  builtin: true,
  tags: ['主题', '青柠', '默认'],
  order: 0,
  setup(ctx) {
    theme.define({
      id: 'mint',
      name: 'Mint 青柠',
      desc: '默认主题：青柠绿，深浅双模',
      accent: '#a3e635',
      tokens: { dark, light },
      canvas: { dark: canvasDark, light: canvasLight },
    });
  },
};
