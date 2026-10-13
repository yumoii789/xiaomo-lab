// ══════════════════════════════════════════════════════════
// 预置实验
//
// 每个预置都刻意跨了学科边界 —— 这正是「小墨实验室」存在的理由：
//   物理 → 化学：电流驱动电解
//   化学 → 物理：反应生电、反应放热改变电阻
// 这些在单一学科的软件里做不出来。
// ══════════════════════════════════════════════════════════

export const PRESETS = [
  // ─────────────────────────────────────────────
  {
    id: 'electrolysis',
    name: '电解水（电 → 化学）',
    desc: '接通电路，观察两极冒出氢气和氧气',
    hint: '打开开关，杯子里的水会被电流分解。加入少量氢氧化钠是为了让水导电。',
    build() {
      return {
        entities: [
          { type: 'battery', x: 180, y: 520, props: { emf: 6, internalR: 0.5 } },
          { type: 'switch', x: 340, y: 520, props: { closed: true } },
          { type: 'beaker', x: 620, y: 470, props: { capacity: 250 },
            fill: { liquid: [['H2O', 180], ['NaOH', 30]] } },
          { type: 'electrode', x: 580, y: 460, props: { metal: 'graphite' } },
          { type: 'electrode', x: 660, y: 460, props: { metal: 'graphite' } },
          { type: 'ammeter', x: 340, y: 400, props: { fullScale: 3 } },
        ],
        wires: [
          [0, 1, 1, 0, 'wire'],   // 电池 + → 开关
          [1, 1, 5, 0, 'wire'],   // 开关 → 电流表
          [5, 1, 3, 0, 'wire'],   // 电流表 → 电极A
          [0, 0, 4, 0, 'wire'],   // 电池 − → 电极B
        ],
      };
    },
  },

  // ─────────────────────────────────────────────
  {
    id: 'galvanic',
    name: '原电池（化学 → 电）',
    desc: '锌片与铜片插入硫酸铜溶液，化学能变成电能',
    hint: '不需要任何电源。两种不同的金属插在同一杯电解液里，本身就成了一只电池。',
    build() {
      return {
        entities: [
          { type: 'beaker', x: 600, y: 470, props: { capacity: 250 },
            fill: { liquid: [['H2O', 120], ['CuSO4', 80]] } },
          { type: 'electrode', x: 550, y: 460, props: { metal: 'Zn' } },
          { type: 'electrode', x: 650, y: 460, props: { metal: 'Cu' } },
          { type: 'ammeter', x: 380, y: 420, props: { fullScale: 0.6 } },
          { type: 'voltmeter', x: 380, y: 540, props: { fullScale: 3 } },
          { type: 'lamp', x: 200, y: 480, props: { ratedV: 1.5, ratedP: 0.3 } },
        ],
        wires: [
          [1, 0, 3, 0, 'wire'],   // 锌 → 电流表
          [3, 1, 5, 0, 'wire'],   // 电流表 → 灯泡
          [5, 1, 2, 0, 'wire'],   // 灯泡 → 铜
          [1, 0, 4, 0, 'wire'],   // 电压表并在锌上
          [4, 1, 2, 0, 'wire'],   // 电压表并在铜上
        ],
      };
    },
  },

  // ─────────────────────────────────────────────
  {
    id: 'thermo-circuit',
    name: '反应放热 → 电流变化（热 → 电）',
    desc: '点燃酒精灯，看热敏电阻如何改变电路电流',
    hint: '热敏电阻是负温度系数：液体越热，它阻值越小，电流越大。这是化学温度反馈到物理电路的闭环。',
    build() {
      return {
        entities: [
          { type: 'battery', x: 160, y: 460, props: { emf: 4.5, internalR: 0.5 } },
          { type: 'ammeter', x: 300, y: 460, props: { fullScale: 0.1 } },
          { type: 'thermistor', x: 560, y: 470, props: { r25: 100, B: 3500 } },
          { type: 'beaker', x: 420, y: 500, props: { capacity: 250 },
            fill: { liquid: [['H2O', 150]] } },
          { type: 'alcohollamp', x: 420, y: 620, props: { lit: false, power: 260 } },
          { type: 'thermometer', x: 470, y: 470 },
          { type: 'voltmeter', x: 300, y: 580, props: { fullScale: 15 } },
        ],
        wires: [
          [0, 1, 1, 0, 'wire'],
          [1, 1, 2, 0, 'wire'],
          [2, 1, 0, 0, 'wire'],
          [0, 1, 6, 0, 'wire'],
          [6, 1, 0, 0, 'wire'],
        ],
      };
    },
  },

  // ─────────────────────────────────────────────
  {
    id: 'displacement',
    name: '铁与硫酸铜（置换反应）',
    desc: '把铁放进蓝色硫酸铜溶液，看颜色变浅绿',
    hint: '用「倾倒」工具：先点铁钉试剂瓶，再点试管。铁把铜置换出来，蓝色逐渐变成浅绿色。',
    build() {
      return {
        entities: [
          { type: 'testtube', x: 420, y: 430, props: { capacity: 30 },
            fill: { liquid: [['CuSO4', 18]] } },
          { type: 'reagent-Fe', x: 620, y: 480, props: { dose: 6 } },
          { type: 'thermometer', x: 445, y: 430 },
          { type: 'balance', x: 200, y: 520 },
        ],
      };
    },
  },

  // ─────────────────────────────────────────────
  {
    id: 'joule-heat',
    name: '电流的热效应加热液体（电 → 热）',
    desc: '电热丝浸在液体里通电，把水加热',
    hint: '电热丝既是电路元件，也是热源。它把功率 P=UI 全部交给了液体。',
    build() {
      return {
        entities: [
          { type: 'battery', x: 150, y: 560, props: { emf: 12, internalR: 0.3 } },
          { type: 'ammeter', x: 300, y: 560, props: { fullScale: 3 } },
          { type: 'rheostat', x: 460, y: 560, props: { rMax: 20, pos: 0.1 } },
          { type: 'beaker', x: 680, y: 480, props: { capacity: 250 },
            fill: { liquid: [['H2O', 100]] } },
          { type: 'heater', x: 680, y: 500, props: { resistance: 4, maxP: 30 } },
          { type: 'thermometer', x: 730, y: 460 },
        ],
        wires: [
          [0, 1, 1, 0, 'wire'],
          [1, 1, 2, 0, 'wire'],
          [2, 1, 4, 0, 'wire'],
          [4, 1, 0, 0, 'wire'],
        ],
      };
    },
  },

  // ─────────────────────────────────────────────
  {
    id: 'neutralize',
    name: '酸碱中和（放热 + pH 变化）',
    desc: '向盐酸中滴加氢氧化钠，观察 pH 与温度',
    hint: '用「倾倒」工具把氢氧化钠倒进烧杯。中和反应放热，温度会明显上升，pH 也随之升高。',
    build() {
      return {
        entities: [
          { type: 'beaker', x: 420, y: 470, props: { capacity: 250 },
            fill: { liquid: [['H2O', 100], ['HCl', 60], ['Phenolphthalein', 4]] } },
          { type: 'reagent-NaOH', x: 640, y: 500, props: { dose: 40 } },
          { type: 'phmeter', x: 475, y: 465 },
          { type: 'thermometer', x: 365, y: 455 },
        ],
      };
    },
  },
];

export const PRESET_BY_ID = new Map(PRESETS.map(p => [p.id, p]));
