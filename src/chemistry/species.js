// ══════════════════════════════════════════════════════════
// 化学域 · 物质库
//
// 每条物质记录中学化学真正需要的那几个属性：
//   状态 / 颜色 / 摩尔质量 / 离子 / 酸碱性 / 溶解性 / 气体
// 溶液颜色直接驱动渲染，离子强度直接驱动导电性 —— 化学和物理在这里共用一份数据。
// ══════════════════════════════════════════════════════════

/**
 * st: 状态  s=固体 l=液体 aq=溶液 g=气体
 * c:  颜色  [r,g,b] 或 null(无色)
 * M:  摩尔质量 g/mol
 * ions: 溶液中主要离子 —— 决定导电能力
 * acid: 'strong'|'weak'|'base-strong'|'base-weak'
 * sol: 'soluble'|'slight'|'insoluble'
 * gas: 是否常温气体
 * cat: 分类，用于器材栏分组
 */
export const SP = {
  // ── 水与常见溶剂 ──
  H2O:   { n: '水',         f: 'H2O',        st: 'l',  c: null,            M: 18.02, d: 1.00, pH: 7 },
  C2H5OH:{ n: '乙醇',       f: 'C2H5OH',     st: 'l',  c: null,            M: 46.07, d: 0.789 },

  // ── 酸 ──
  HCl:   { n: '稀盐酸',     f: 'HCl',        st: 'aq', c: null,            M: 36.46, d: 1.05, acid: 'strong', ions: [['H+', 1], ['Cl-', 1]] },
  H2SO4: { n: '稀硫酸',     f: 'H2SO4',      st: 'aq', c: null,            M: 98.08, d: 1.10, acid: 'strong', ions: [['H+', 2], ['SO4^2-', 1]] },
  HNO3:  { n: '稀硝酸',     f: 'HNO3',       st: 'aq', c: null,            M: 63.01, d: 1.05, acid: 'strong', ions: [['H+', 1], ['NO3-', 1]] },
  CH3COOH:{ n: '醋酸',      f: 'CH3COOH',    st: 'aq', c: null,            M: 60.05, d: 1.05, acid: 'weak',   ions: [['H+', 0.02], ['CH3COO-', 0.02]] },

  // ── 碱 ──
  NaOH:  { n: '氢氧化钠溶液', f: 'NaOH',     st: 'aq', c: null,            M: 40.00, d: 1.10, acid: 'base-strong', ions: [['Na+', 1], ['OH-', 1]] },
  KOH:   { n: '氢氧化钾溶液', f: 'KOH',      st: 'aq', c: null,            M: 56.11, d: 1.10, acid: 'base-strong', ions: [['K+', 1], ['OH-', 1]] },
  'Ca(OH)2': { n: '石灰水', f: 'Ca(OH)2',    st: 'aq', c: null,            M: 74.09, d: 1.00, acid: 'base-strong', sol: 'slight', ions: [['Ca2+', 1], ['OH-', 2]] },
  NH3H2O:{ n: '氨水',       f: 'NH3·H2O',    st: 'aq', c: null,            M: 35.05, d: 0.96, acid: 'base-weak', ions: [['NH4+', 0.02], ['OH-', 0.02]] },

  // ── 盐溶液（有色者驱动渲染） ──
  CuSO4: { n: '硫酸铜溶液', f: 'CuSO4',      st: 'aq', c: [46, 116, 205],  M: 159.6, d: 1.20, ions: [['Cu2+', 1], ['SO4^2-', 1]] },
  CuCl2: { n: '氯化铜溶液', f: 'CuCl2',      st: 'aq', c: [54, 152, 178],  M: 134.5, d: 1.20, ions: [['Cu2+', 1], ['Cl-', 2]] },
  FeSO4: { n: '硫酸亚铁溶液', f: 'FeSO4',    st: 'aq', c: [138, 190, 160], M: 152.0, d: 1.18, ions: [['Fe2+', 1], ['SO4^2-', 1]] },
  FeCl3: { n: '氯化铁溶液', f: 'FeCl3',      st: 'aq', c: [196, 150, 62],  M: 162.2, d: 1.25, ions: [['Fe3+', 1], ['Cl-', 3]] },
  KMnO4: { n: '高锰酸钾溶液', f: 'KMnO4',    st: 'aq', c: [138, 40, 118],  M: 158.0, d: 1.02, ions: [['K+', 1], ['MnO4-', 1]] },
  NaCl:  { n: '氯化钠溶液', f: 'NaCl',       st: 'aq', c: null,            M: 58.44, d: 1.05, ions: [['Na+', 1], ['Cl-', 1]] },
  CaCl2: { n: '氯化钙溶液', f: 'CaCl2',      st: 'aq', c: null,            M: 111.0, d: 1.10, ions: [['Ca2+', 1], ['Cl-', 2]] },
  FeCl2: { n: '氯化亚铁溶液', f: 'FeCl2',    st: 'aq', c: [140, 190, 165], M: 126.8, d: 1.15, ions: [['Fe2+', 1], ['Cl-', 2]] },
  KCl:   { n: '氯化钾溶液', f: 'KCl',        st: 'aq', c: null,            M: 74.55, d: 1.05, ions: [['K+', 1], ['Cl-', 1]] },
  ZnSO4: { n: '硫酸锌溶液', f: 'ZnSO4',      st: 'aq', c: null,            M: 161.4, d: 1.20, ions: [['Zn2+', 1], ['SO4^2-', 1]] },
  MgSO4: { n: '硫酸镁溶液', f: 'MgSO4',      st: 'aq', c: null,            M: 120.4, d: 1.15, ions: [['Mg2+', 1], ['SO4^2-', 1]] },
  Na2SO4:{ n: '硫酸钠溶液', f: 'Na2SO4',     st: 'aq', c: null,            M: 142.0, d: 1.10, ions: [['Na+', 2], ['SO4^2-', 1]] },
  Na2CO3:{ n: '碳酸钠溶液', f: 'Na2CO3',     st: 'aq', c: null,            M: 106.0, d: 1.10, acid: 'base-strong', ions: [['Na+', 2], ['CO3^2-', 1]] },
  NaHCO3:{ n: '碳酸氢钠溶液', f: 'NaHCO3',   st: 'aq', c: null,            M: 84.01, d: 1.05, acid: 'base-weak', ions: [['Na+', 1], ['HCO3-', 1]] },
  AgNO3: { n: '硝酸银溶液', f: 'AgNO3',      st: 'aq', c: null,            M: 169.9, d: 1.20, ions: [['Ag+', 1], ['NO3-', 1]] },
  BaCl2: { n: '氯化钡溶液', f: 'BaCl2',      st: 'aq', c: null,            M: 208.2, d: 1.20, ions: [['Ba2+', 1], ['Cl-', 2]] },
  H2O2:  { n: '过氧化氢溶液', f: 'H2O2',     st: 'aq', c: null,            M: 34.01, d: 1.10 },

  // ── 金属单质 ──
  Zn:    { n: '锌粒',       f: 'Zn',         st: 's',  c: [186, 192, 198],  M: 65.38, d: 7.14, metal: 'Zn', E0: -0.76 },
  Fe:    { n: '铁钉',       f: 'Fe',         st: 's',  c: [150, 152, 158],  M: 55.85, d: 7.87, metal: 'Fe', E0: -0.44 },
  Mg:    { n: '镁条',       f: 'Mg',         st: 's',  c: [200, 205, 210],  M: 24.31, d: 1.74, metal: 'Mg', E0: -2.37 },
  Al:    { n: '铝片',       f: 'Al',         st: 's',  c: [198, 202, 208],  M: 26.98, d: 2.70, metal: 'Al', E0: -1.66 },
  Cu:    { n: '铜片',       f: 'Cu',         st: 's',  c: [184, 115, 51],   M: 63.55, d: 8.96, metal: 'Cu', E0: 0.34 },
  Ag:    { n: '银片',       f: 'Ag',         st: 's',  c: [226, 226, 228],  M: 107.9, d: 10.49, metal: 'Ag', E0: 0.80 },

  // ── 氧化物与固体药品 ──
  CuO:   { n: '氧化铜',     f: 'CuO',        st: 's',  c: [26, 26, 28],     M: 79.55, d: 6.31, sol: 'insoluble' },
  MnO2:  { n: '二氧化锰',   f: 'MnO2',       st: 's',  c: [38, 38, 40],     M: 86.94, d: 5.03, sol: 'insoluble', catalyst: 'H2O2' },
  CaO:   { n: '生石灰',     f: 'CaO',        st: 's',  c: [238, 236, 230],  M: 56.08, d: 3.34 },
  CaCO3: { n: '碳酸钙',     f: 'CaCO3',      st: 's',  c: [240, 240, 236],  M: 100.1, d: 2.71, sol: 'insoluble', precip: [236, 238, 234] },

  // ── 沉淀 ──
  'Cu(OH)2': { n: '氢氧化铜', f: 'Cu(OH)2',  st: 's',  c: [58, 130, 210],   M: 97.56, sol: 'insoluble', precip: [58, 130, 210] },
  'Fe(OH)3': { n: '氢氧化铁', f: 'Fe(OH)3',  st: 's',  c: [150, 74, 42],    M: 106.9, sol: 'insoluble', precip: [150, 74, 42] },
  BaSO4: { n: '硫酸钡',     f: 'BaSO4',      st: 's',  c: [242, 242, 238],  M: 233.4, sol: 'insoluble', precip: [240, 240, 238] },
  AgCl:  { n: '氯化银',     f: 'AgCl',       st: 's',  c: [246, 246, 242],  M: 143.3, sol: 'insoluble', precip: [244, 244, 240] },

  // ── 气体 ──
  H2:    { n: '氢气',       f: 'H2',         st: 'g',  c: null,            M: 2.016, gas: true, flammable: true },
  O2:    { n: '氧气',       f: 'O2',         st: 'g',  c: null,            M: 32.00, gas: true, supports: true },
  CO2:   { n: '二氧化碳',   f: 'CO2',        st: 'g',  c: null,            M: 44.01, gas: true },
  Cl2:   { n: '氯气',       f: 'Cl2',        st: 'g',  c: [186, 208, 120],  M: 70.90, gas: true, toxic: true },
  SO2:   { n: '二氧化硫',   f: 'SO2',        st: 'g',  c: null,            M: 64.07, gas: true, toxic: true, pungent: true },

  // ── 指示剂 ──
  Phenolphthalein: { n: '酚酞试液', f: '酚酞', st: 'aq', c: null, M: 318.3, indicator: 'phenolphthalein' },
  Litmus:          { n: '石蕊试液', f: '石蕊', st: 'aq', c: [128, 92, 168], M: 300, indicator: 'litmus' },
};

/** 取物质（带兜底，避免拼错化学式就崩） */
export function sp(id) {
  return SP[id] || { n: id, f: id, st: 'aq', c: null, M: 100, _unknown: true };
}

/** 把化学式里的数字变成下标，用于显示：H2O → H₂O */
const SUB = { '0': '₀', '1': '₁', '2': '₂', '3': '₃', '4': '₄', '5': '₅', '6': '₆', '7': '₇', '8': '₈', '9': '₉' };
export function pretty(f) {
  return String(f).replace(/(?<=[A-Za-z\)\]])(\d+)/g, (m) => [...m].map(d => SUB[d] || d).join(''));
}

/** 溶液颜色：把多种溶质按浓度加权混合 */
export function mixColor(list) {
  // list: [{ c:[r,g,b]|null, w:number }]
  let r = 0, g = 0, b = 0, wsum = 0;
  for (const it of list) {
    if (!it.c) continue;
    const w = Math.max(0, it.w);
    r += it.c[0] * w; g += it.c[1] * w; b += it.c[2] * w; wsum += w;
  }
  if (wsum <= 1e-6) return null;
  return [Math.round(r / wsum), Math.round(g / wsum), Math.round(b / wsum)];
}

/** 该物质是否提供自由移动离子（决定溶液导电） */
export function ionStrength(id, conc) {
  const s = SP[id];
  if (!s || !s.ions) return 0;
  let n = 0;
  for (const [, k] of s.ions) n += k;
  return n * Math.min(conc, 5);
}
