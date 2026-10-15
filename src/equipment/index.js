// ══════════════════════════════════════════════════════════
// 器材插件集 —— 每一组器材都是独立插件，可单独启用/禁用
// ══════════════════════════════════════════════════════════

import electrical from './electrical.js';   // 物理：电源 / 开关 / 灯泡 / 电阻 / 变阻器 / 电表 / 热敏 / 电热丝 / 电动机
import glassware from './glassware.js';     // 化学：烧杯 / 试管 / 锥形瓶 / 量筒
import heating from './heating.js';         // 化学：酒精灯 / 铁架台
import lab from './lab.js';                 // 化学：电极 / 温度计 / pH计 / 玻璃棒 / 天平 / 试剂瓶
import labware from './labware.js';         // 化学：坩埚 / 废液缸
import mechanics from './mechanics.js';     // 物理：斜面 / 弹簧振子 / 单摆 / 小车 / 自由落体 / 杠杆 / 滑轮组 / 摩擦块
import thermal from './thermal.js';         // 物理：加热板 / 量热器 / 导热棒 / 冰浴 / 沸腾装置 / 膨胀球环
import optics from './optics.js';           // 物理：平行光源 / 凸透镜 / 光屏 / 平面镜 / 水槽 / 三棱镜
import electronics from './electronics.js'; // 物理：电容 / 电感 / 交流电源 / 示波器 / 变压器 / 二极管
import acoustics from './acoustics.js';     // 物理：音叉 / 共鸣管 / 分贝计 / 波形显示
import electromagnets from './electromagnets.js'; // 物理：条形磁铁 / 指南针 / 正负电荷 / 检验电荷 / 匀强电场 / 匀强磁场

export * from './registry.js';

/** 按依赖顺序排列的器材插件（实测：内核不读插件级 order，生效顺序就是这里的数组顺序） */
export const equipmentPlugins = [electrical, glassware, heating, lab, labware, mechanics, thermal, optics, electronics, acoustics, electromagnets];

export default equipmentPlugins;
