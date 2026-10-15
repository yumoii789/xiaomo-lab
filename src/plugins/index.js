// ══════════════════════════════════════════════════════════
// 插件清单 —— 唯一的一份名单
//
// 放在这里而不是 main.js 里，是为了让「启动」与「守卫」共用同一处声明：
// main.js 把它 re-export 出去，tools/check.mjs 的装载守卫也读它。
// 守卫必须装的正好是真正启动时的那一批，否则名单会悄悄漂移，
// 于是「某个插件 setup 抛错」这种缺陷又能躲过 45 项全绿的检查。
//
// 本文件刻意不碰 DOM：任何环境都能安全 import。
// ══════════════════════════════════════════════════════════

// ── 内核能力 ──────────────────────────────────────────────
import physicsPlugin from '../physics/circuit.js';
import chemistryPlugin from '../chemistry/reactions.js';
import bridgePlugin from '../coupling/bridge.js';

// ── 主题 ──────────────────────────────────────────────────
import mintTheme from './theme.mint.js';
import graphiteTheme from './theme.graphite.js';

// ── 器材 ──────────────────────────────────────────────────
import { equipmentPlugins } from '../equipment/index.js';

// ── 规则与系统 ────────────────────────────────────────────
import damageRules from './rules.damage.js';
import creditSystem from './system.credit.js';

// ── 界面 ──────────────────────────────────────────────────
import uiPalette from './ui.palette.js';
import uiInspector from './ui.inspector.js';
import uiData from './ui.data.js';
import uiLog from './ui.log.js';
import uiSidebar from './ui.sidebar.js';
import uiInteraction from './ui.interaction.js';
import uiToolbar from './ui.toolbar.js';
import uiThemeSwitch from './ui.themeswitch.js';
import uiManager from './ui.manager.js';
import uiSettings from './ui.settings.js';
import uiMarket from './ui.market.js';

// ── 桌面版外壳（浏览器里自动静默） ────────────────────────
import systemDesktop from './system.desktop.js';

// ── 器材包：必须排在器材之后，派生时才能找到原型 ──────────
import systemPack from './system.pack.js';

// ── 内容 ──────────────────────────────────────────────────
import presetsPlugin from './presets.experiments.js';

export const ALL_PLUGINS = [
  // 内核能力
  physicsPlugin, chemistryPlugin, bridgePlugin,
  // 主题
  mintTheme, graphiteTheme,
  // 器材
  ...equipmentPlugins,
  // 规则与系统
  damageRules, creditSystem,
  // 界面
  uiSidebar, uiPalette, uiInspector, uiData, uiLog, uiInteraction, uiToolbar, uiThemeSwitch, uiManager, uiSettings, uiMarket,
  // 桌面版外壳（浏览器里自动静默）
  systemDesktop,
  // 器材包：必须排在器材之后，派生时才能找到原型
  systemPack,
  // 内容
  presetsPlugin,
];

export default ALL_PLUGINS;
