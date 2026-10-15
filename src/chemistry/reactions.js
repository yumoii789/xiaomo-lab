// ══════════════════════════════════════════════════════════
// 化学域 · 反应引擎
//
// 一条规则 = 反应物 + 条件 + 生成物 + 焓变 + 速率。
// 引擎不关心器材长什么样，只问容器：
//   里面有什么、多少、多热、通没通电、有没有催化剂。
//
// 「通电」这个条件正是物理域交进来的那一根线 —— 耦合就发生在这里。
// ══════════════════════════════════════════════════════════

import { SP } from './species.js';

/**
 * in/out: { 物质: 化学计量数 }
 * gas:    逸出气体的物质
 * precip: 生成沉淀的物质
 * cond:   { electric, heat:最低温度, catalyst:'物质', light }
 * dH:     kJ/mol，负为放热
 * k:      速率常数
 */
export const RULES = [
  // ═══════ 电解（电能 → 化学能，物理驱动化学） ═══════
  {
    id: 'ely-water', eq: '2H₂O --通电--> 2H₂↑ + O₂↑',
    in: { H2O: 2 }, out: { H2: 2, O2: 1 }, gas: ['H2', 'O2'],
    cond: { electric: true, needIon: true }, dH: 571.6, k: 7e-4,
    note: '水的电解：负极出氢气，正极出氧气',
  },
  {
    id: 'ely-cucl2', eq: 'CuCl₂ --通电--> Cu + Cl₂↑',
    in: { CuCl2: 1 }, out: { Cu: 1, Cl2: 1 }, gas: ['Cl2'], deposit: ['Cu'],
    cond: { electric: true }, dH: 220, k: 6e-4,
    note: '电解氯化铜溶液，阴极析出红色铜',
  },
  {
    id: 'ely-cuso4', eq: '2CuSO₄ + 2H₂O --通电--> 2Cu + O₂↑ + 2H₂SO₄',
    in: { CuSO4: 2, H2O: 2 }, out: { Cu: 2, O2: 1, H2SO4: 2 }, gas: ['O2'], deposit: ['Cu'],
    cond: { electric: true }, dH: 470, k: 5e-4,
    note: '电解硫酸铜：阴极析铜，阳极出氧气，溶液变酸',
  },
  {
    id: 'ely-nacl', eq: '2NaCl + 2H₂O --通电--> 2NaOH + H₂↑ + Cl₂↑',
    in: { NaCl: 2, H2O: 2 }, out: { NaOH: 2, H2: 1, Cl2: 1 }, gas: ['H2', 'Cl2'],
    cond: { electric: true }, dH: 420, k: 5e-4,
    note: '电解饱和食盐水（氯碱工业）',
  },

  // ═══════ 金属 + 酸（放热，产气） ═══════
  {
    id: 'zn-hcl', eq: 'Zn + 2HCl → ZnCl₂ + H₂↑',
    in: { Zn: 1, HCl: 2 }, out: { ZnCl2: 1, H2: 1 }, gas: ['H2'],
    dH: -153, k: 0.012, note: '实验室制取氢气',
  },
  {
    id: 'fe-hcl', eq: 'Fe + 2HCl → FeCl₂ + H₂↑',
    in: { Fe: 1, HCl: 2 }, out: { FeCl2: 1, H2: 1 }, gas: ['H2'],
    dH: -87, k: 0.006, note: '铁与稀盐酸，溶液变浅绿',
  },
  {
    id: 'mg-hcl', eq: 'Mg + 2HCl → MgCl₂ + H₂↑',
    in: { Mg: 1, HCl: 2 }, out: { MgCl2: 1, H2: 1 }, gas: ['H2'],
    dH: -462, k: 0.09, note: '镁与盐酸反应剧烈',
  },
  {
    id: 'zn-h2so4', eq: 'Zn + H₂SO₄ → ZnSO₄ + H₂↑',
    in: { Zn: 1, H2SO4: 1 }, out: { ZnSO4: 1, H2: 1 }, gas: ['H2'],
    dH: -154, k: 0.010, note: '锌与稀硫酸制氢气',
  },

  // ═══════ 碳酸盐 + 酸（产气） ═══════
  {
    id: 'caco3-hcl', eq: 'CaCO₃ + 2HCl → CaCl₂ + H₂O + CO₂↑',
    in: { CaCO3: 1, HCl: 2 }, out: { CaCl2: 1, H2O: 1, CO2: 1 }, gas: ['CO2'],
    dH: -15, k: 0.014, note: '大理石与稀盐酸制二氧化碳',
  },
  {
    id: 'na2co3-hcl', eq: 'Na₂CO₃ + 2HCl → 2NaCl + H₂O + CO₂↑',
    in: { Na2CO3: 1, HCl: 2 }, out: { NaCl: 2, H2O: 1, CO2: 1 }, gas: ['CO2'],
    dH: -25, k: 0.05, note: '碳酸钠与盐酸，迅速产生气泡',
  },
  {
    id: 'nahco3-hcl', eq: 'NaHCO₃ + HCl → NaCl + H₂O + CO₂↑',
    in: { NaHCO3: 1, HCl: 1 }, out: { NaCl: 1, H2O: 1, CO2: 1 }, gas: ['CO2'],
    dH: -30, k: 0.06, note: '小苏打与盐酸',
  },

  // ═══════ 中和（放热） ═══════
  {
    id: 'naoh-hcl', eq: 'NaOH + HCl → NaCl + H₂O',
    in: { NaOH: 1, HCl: 1 }, out: { NaCl: 1, H2O: 1 },
    dH: -57.3, k: 0.30, note: '中和反应，放热明显',
  },
  {
    id: 'naoh-h2so4', eq: '2NaOH + H₂SO₄ → Na₂SO₄ + 2H₂O',
    in: { NaOH: 2, H2SO4: 1 }, out: { Na2SO4: 1, H2O: 2 },
    dH: -114, k: 0.30, note: '中和反应',
  },
  {
    id: 'caoh2-hcl', eq: 'Ca(OH)₂ + 2HCl → CaCl₂ + 2H₂O',
    in: { 'Ca(OH)2': 1, HCl: 2 }, out: { CaCl2: 1, H2O: 2 },
    dH: -110, k: 0.25, note: '石灰水与盐酸',
  },

  // ═══════ 沉淀反应 ═══════
  {
    id: 'cuso4-naoh', eq: 'CuSO₄ + 2NaOH → Cu(OH)₂↓ + Na₂SO₄',
    in: { CuSO4: 1, NaOH: 2 }, out: { 'Cu(OH)2': 1, Na2SO4: 1 }, precip: ['Cu(OH)2'],
    dH: -60, k: 0.35, note: '生成蓝色絮状沉淀',
  },
  {
    id: 'fecl3-naoh', eq: 'FeCl₃ + 3NaOH → Fe(OH)₃↓ + 3NaCl',
    in: { FeCl3: 1, NaOH: 3 }, out: { 'Fe(OH)3': 1, NaCl: 3 }, precip: ['Fe(OH)3'],
    dH: -70, k: 0.35, note: '生成红褐色沉淀',
  },
  {
    id: 'agno3-nacl', eq: 'AgNO₃ + NaCl → AgCl↓ + NaNO₃',
    in: { AgNO3: 1, NaCl: 1 }, out: { AgCl: 1 }, precip: ['AgCl'],
    dH: -65, k: 0.40, note: '生成白色沉淀，检验氯离子',
  },
  {
    id: 'bacl2-na2so4', eq: 'BaCl₂ + Na₂SO₄ → BaSO₄↓ + 2NaCl',
    in: { BaCl2: 1, Na2SO4: 1 }, out: { BaSO4: 1, NaCl: 2 }, precip: ['BaSO4'],
    dH: -60, k: 0.40, note: '生成不溶于稀硝酸的白色沉淀',
  },
  {
    id: 'caoh2-co2', eq: 'Ca(OH)₂ + CO₂ → CaCO₃↓ + H₂O',
    in: { 'Ca(OH)2': 1, CO2: 1 }, out: { CaCO3: 1, H2O: 1 }, precip: ['CaCO3'],
    dH: -113, k: 0.25, note: '检验二氧化碳，石灰水变浑浊',
  },

  // ═══════ 置换（溶液颜色变化） ═══════
  {
    id: 'fe-cuso4', eq: 'Fe + CuSO₄ → FeSO₄ + Cu',
    in: { Fe: 1, CuSO4: 1 }, out: { FeSO4: 1, Cu: 1 }, deposit: ['Cu'],
    dH: -140, k: 0.010, note: '铁钉表面析出红色铜，蓝色变浅绿',
  },
  {
    id: 'zn-cuso4', eq: 'Zn + CuSO₄ → ZnSO₄ + Cu',
    in: { Zn: 1, CuSO4: 1 }, out: { ZnSO4: 1, Cu: 1 }, deposit: ['Cu'],
    dH: -217, k: 0.012, note: '置换反应',
  },

  // ═══════ 分解（需要加热，温度由物理域提供） ═══════
  {
    id: 'h2o2-mno2', eq: '2H₂O₂ --MnO₂--> 2H₂O + O₂↑',
    in: { H2O2: 2 }, out: { H2O: 2, O2: 1 }, gas: ['O2'],
    cond: { catalyst: 'MnO2' }, dH: -98, k: 0.02, catBoost: 60,
    note: '二氧化锰催化过氧化氢分解',
  },
  {
    id: 'cuoh2-heat', eq: 'Cu(OH)₂ --Δ--> CuO + H₂O',
    in: { 'Cu(OH)2': 1 }, out: { CuO: 1, H2O: 1 },
    cond: { heat: 80 }, dH: 62, k: 0.02, note: '蓝色沉淀受热变黑',
  },
  {
    id: 'caco3-heat', eq: 'CaCO₃ --高温--> CaO + CO₂↑',
    in: { CaCO3: 1 }, out: { CaO: 1, CO2: 1 }, gas: ['CO2'],
    cond: { heat: 400 }, dH: 178, k: 0.01, note: '高温煅烧石灰石',
  },
  {
    id: 'nahco3-heat', eq: '2NaHCO₃ --Δ--> Na₂CO₃ + H₂O + CO₂↑',
    in: { NaHCO3: 2 }, out: { Na2CO3: 1, H2O: 1, CO2: 1 }, gas: ['CO2'],
    cond: { heat: 120 }, dH: 129, k: 0.02, note: '小苏打受热分解',
  },

  // ═══════ 化合（剧烈放热） ═══════
  {
    id: 'cao-h2o', eq: 'CaO + H₂O → Ca(OH)₂',
    in: { CaO: 1, H2O: 1 }, out: { 'Ca(OH)2': 1 },
    dH: -64, k: 0.10, note: '生石灰遇水放出大量热',
  },
];

/** 检查条件是否满足 */
function condOK(r, v) {
  const c = r.cond || {};
  if (c.electric) {
    if (!v.hasElectrodes()) return false;
    // 闸门取幅度：电流不够大就什么都不发生，与方向无关（正负半周都该过闸）
    if (Math.abs(v.electricCurrent || 0) < 0.004) return false;
    if (c.needIon && v.ionConc() < 0.02) return false;   // 纯水几乎不导电
  }
  if (c.heat !== undefined && v.temp < c.heat) return false;
  if (c.catalyst && !v.has(c.catalyst)) return false;
  if (c.light && !v.light) return false;
  return true;
}

/** 反应物是否都够（返回最多能推进的摩尔数，0 表示不能反应） */
function available(r, v, dir = 1) {
  // dir = −1 是反向推进（交流负半周把产物溶回去）：这时限制来自「产物还剩多少」，
  // 而不是反应物 —— 拿反应物去算会出现「产物早溶光了还在继续溶」。
  const src = dir < 0 ? r.out : r.in;
  let lim = Infinity;
  for (const [id, coef] of Object.entries(src)) {
    if (!(coef > 0)) continue;
    const have = v.amount(id);
    if (have <= 1e-9) return 0;
    lim = Math.min(lim, have / coef);
  }
  return lim === Infinity ? 0 : lim;
}

/** 速率 mol/s */
function rateOf(r, v) {
  let rate = r.k;
  const c = r.cond || {};

  if (c.electric) {
    // 法拉第幅度律：速率正比于电流的**大小**。方向不在这里定 —— 由 stepVessel 按电荷符号
    // 决定正向沉积还是反向回溶（取绝对值在这里是对的，漏的是符号那一半）。
    rate = r.k * Math.abs(v.electricCurrent || 0);
  } else {
    // 浓度项（固体按"存在"计 1）
    for (const [id, coef] of Object.entries(r.in)) {
      const s = SP[id];
      if (s && s.st === 's') continue;
      const conc = Math.max(0, v.conc(id));
      rate *= Math.min(4, Math.pow(conc, coef > 1 ? 0.75 : 1));
    }
    // 温度项：每升高 10 ℃ 约快一倍
    rate *= Math.pow(2, (v.temp - 25) / 10);
    // 搅拌项
    rate *= (1 + Math.min(2, (v.stir || 0) * 0.6));
    if (rate < 1e-9) rate = r.k * Math.pow(2, (v.temp - 25) / 10) * 0.02;
  }

  if (c.catalyst && v.has(c.catalyst)) rate *= (r.catBoost || 20);
  return Math.max(0, rate);
}

/**
 * 这次推进的方向：+1 正向、−1 反向。
 *
 * 只有**可逆的金属沉积**类电解才吃电荷符号：正半周镀上去、负半周溶回来，对称交流因此净产物 ≈ 0。
 * 规则表里用 deposit 字段分辨（ely-cucl2 / ely-cuso4 有，ely-water / ely-nacl 只有气体产物没有）。
 * 只放气体的分解两个半周都在发生（水电解换个极也不过是两极互换），不互抵 —— 恒为正向，
 * 于是直流不管哪一极接过来的电流都照旧电解，不会被反向掉。
 *
 * 电流从哪来：耦合层同时写 electricCurrent（幅度）与 currentSigned（符号）。
 * 没有 currentSigned 时退回到 electricCurrent 的符号（存档/单测里的容器只有幅度字段，
 * 那时行为与改动前一致：恒正向）。
 */
function electricDir(r, v) {
  if (!(r.cond && r.cond.electric)) return 1;
  if (!(r.deposit && r.deposit.length)) return 1;
  const signed = (typeof v.currentSigned === 'number') ? v.currentSigned : (v.electricCurrent || 0);
  return Math.sign(signed);
}

/**
 * 扣掉某物质 mol 数。
 * dir > 0 走 vessel.consume()（先溶解态、再固体）。
 * dir < 0 要扣的是**生成物**，其中气态产物落在 v.gas 里，而 vessel.consume() 只认
 * 溶解态与固体（vessel.js:70-90），所以气体这一支在这里补 —— 反向推进只有电解这一处调用方。
 */
function take(v, id, mol, dir) {
  if (dir > 0 || (SP[id] || {}).st !== 'g') { v.consume(id, mol); return; }
  const have = v.gas.get(id) || 0;
  const use = Math.min(have, mol);
  if (use <= 0) return;
  v.gas.set(id, have - use);
  if (v.gas.get(id) < 1e-12) v.gas.delete(id);
}

/**
 * 推进一次反应。
 * dir = −1 是**反向推进**（电解的负半周）：消耗侧与生成侧对调、焓变跟着反号；
 * 报出的气体/沉淀增量带符号（负 = 被吸收），调用方与 UI 看到的就是净变化。
 */
function apply(r, v, extent, dir = 1) {
  const ins = dir < 0 ? r.out : r.in;
  const outs = dir < 0 ? r.in : r.out;
  for (const [id, coef] of Object.entries(ins)) {
    if (coef > 0) take(v, id, coef * extent, dir);
  }
  const madeGas = [], madePrecip = [];
  for (const [id, coef] of Object.entries(outs)) {
    if (!(coef > 0)) continue;
    v.produce(id, coef * extent);
    if ((SP[id] || {}).st === 'g') madeGas.push([id, dir * coef * extent]);
    if ((SP[id] || {}).precip) madePrecip.push([id, dir * coef * extent]);
  }
  // 焓变：dH<0 放热 → 温度上升；反向推进时焓变反号
  const dQ = -(r.dH || 0) * extent * 1000 * dir;   // J
  v.addHeat(dQ);
  return { gas: madeGas, precip: madePrecip };
}

/**
 * 推进一个容器里的所有反应
 * @returns {number} 本次实际发生的反应数
 */
export function stepVessel(v, dt) {
  let fired = 0;
  for (let pass = 0; pass < 2; pass++) {
    for (const r of RULES) {
      const dir = electricDir(r, v);
      if (dir === 0) continue;

      const lim = available(r, v, dir);
      if (lim <= 1e-9) continue;
      if (!condOK(r, v)) continue;

      const rate = rateOf(r, v);
      if (rate <= 1e-12) continue;

      // 单帧最多消耗可用量的 1/3，避免数值爆炸
      const extent = Math.min(rate * dt, lim * 0.34);
      if (extent <= 1e-12) continue;

      const res = apply(r, v, extent, dir);
      fired++;
      v.noteReaction(r, dir * extent, res);   // 带符号：负值就是「这一次是回溶」
    }
  }
  return fired;
}

export const RULE_BY_ID = new Map(RULES.map(r => [r.id, r]));

// ── 插件 ──────────────────────────────────────────────────
export default {
  id: 'xiaomo.core.chemistry',
  name: '化学反应引擎',
  version: '1.0.0',
  kind: 'core',
  desc: `按浓度、温度、通电与催化剂判据推进反应进度，共 ${RULES.length} 条规则`,
  author: '小墨实验室',
  builtin: true,
  tags: ['化学', '反应', '内核'],
  setup(ctx) {
    ctx.scope('reactions', () => { for (const r of RULES) ctx.reactions.define(r, r.id); });
    ctx.app.services.reactions = { RULES, RULE_BY_ID, stepVessel };
  },
};
