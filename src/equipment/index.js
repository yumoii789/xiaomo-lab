// ══════════════════════════════════════════════════════════
// 器材插件集 —— 每一组器材都是独立插件，可单独启用/禁用
// ══════════════════════════════════════════════════════════

import electrical from './electrical.js';   // 物理：电源 / 开关 / 灯泡 / 电阻 / 变阻器 / 电表 / 热敏 / 电热丝 / 电动机
import glassware from './glassware.js';     // 化学：烧杯 / 试管 / 锥形瓶 / 量筒
import heating from './heating.js';         // 化学：酒精灯 / 铁架台
import lab from './lab.js';                 // 化学：电极 / 温度计 / pH计 / 玻璃棒 / 天平 / 试剂瓶

export * from './registry.js';

/** 按依赖顺序排列的器材插件 */
export const equipmentPlugins = [electrical, glassware, heating, lab];

export default equipmentPlugins;
