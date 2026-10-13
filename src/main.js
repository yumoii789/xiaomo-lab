// ══════════════════════════════════════════════════════════
// 小墨实验室 · 引导器
//
// 内核只做四件事：建服务、声明插件、安装插件、把插件挂到插槽。
// 器材、主题、反应规则、耦合、安全规则、学分、每一个界面面板
// 都是插件 —— 禁用其中任何一个，其余部分照常工作。
//
// 仿真顺序（每一固定步长）：
//   识别插入 → 生成虚拟支路 → 解电路 → 电流/热量分发到化学域 → 世界演化
// 这个顺序让"通电"和"发热"在同一帧内生效，化学响应不滞后。
// ══════════════════════════════════════════════════════════

import { World } from './core/world.js';
import { Engine } from './core/engine.js';
import { bus, EV } from './core/bus.js';
import { theme } from './core/theme.js';
import { PluginHost } from './core/plugin.js';
import { bindRegistry, create, get } from './equipment/registry.js';
import { CouplingBus } from './coupling/bridge.js';
import { solveCircuit, fmtA } from './physics/circuit.js';

// ── 插件清单 ──────────────────────────────────────────────
import { equipmentPlugins } from './equipment/index.js';
import physicsPlugin from './physics/circuit.js';
import chemistryPlugin from './chemistry/reactions.js';
import bridgePlugin from './coupling/bridge.js';

import mintTheme from './plugins/theme.mint.js';
import graphiteTheme from './plugins/theme.graphite.js';
import damageRules from './plugins/rules.damage.js';
import creditSystem from './plugins/system.credit.js';

import uiPalette from './plugins/ui.palette.js';
import uiInspector from './plugins/ui.inspector.js';
import uiData from './plugins/ui.data.js';
import uiLog from './plugins/ui.log.js';
import uiSidebar from './plugins/ui.sidebar.js';
import uiInteraction from './plugins/ui.interaction.js';
import uiToolbar from './plugins/ui.toolbar.js';
import uiThemeSwitch from './plugins/ui.themeswitch.js';
import uiManager from './plugins/ui.manager.js';
import systemDesktop from './plugins/system.desktop.js';
import systemPack from './plugins/system.pack.js';

import presetsPlugin from './plugins/presets.experiments.js';

/**
 * 全部插件清单 —— 导出给 `tools/check.mjs` 的装载守卫复用。
 * 名单只有这一处，守卫装的必须和真正启动的是同一批插件，否则名单会悄悄漂移。
 */
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
  uiSidebar, uiPalette, uiInspector, uiData, uiLog, uiInteraction, uiToolbar, uiThemeSwitch, uiManager,
  // 桌面版外壳（浏览器里自动静默）
  systemDesktop,
  // 器材包：必须排在器材之后，派生时才能找到原型
  systemPack,
  // 内容
  presetsPlugin,
];

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const TOOL_NAME = { select: '选择', wire: '连线', pour: '倾倒', erase: '删除' };
/** 状态栏里的六个键位提示。工具段会随当前工具高亮，动作段常驻。 */
const KEY_HINTS = [
  { t: 'select', label: 'V 选择' },
  { t: 'wire', label: 'W 连线' },
  { t: 'pour', label: 'P 倾倒' },
  { t: 'erase', label: 'X 删除' },
  { label: '空格 运行' },
  { label: 'Ctrl+S 保存' },
];
const STORE_KEY = 'xiaomo.scene.v1';
/** 提示条换文案前的遮蔽时长：旧文案先被 2px 模糊盖住，再落新文案 */
const TOAST_MASK_MS = 120;
export const VERSION = '2.0.0';

class App {
  constructor() {
    this.version = VERSION;
    this.canvas = $('#canvas');
    this.world = new World();
    this.engine = new Engine(this.canvas, this.world);
    this.circuit = null;
    this.selected = null;

    /** 插件往里放服务 */
    this.services = {};
    /** 每帧回调（真实时间，暂停时为 0） */
    this.ticks = [];
    /** 兜底日志，等 ui.log 插件装上后会被替换 */
    this.log = { push() {}, clear() {} };
    this._lastFx = 0;
    /** 重绘脏标记：由 markDirty() 置位，引擎渲染后清位 */
    this._dirty = false;

    // ① 插件宿主
    this.host = new PluginHost(this);
    bindRegistry(this.host.registry('equipment'));
    theme.watchSystem();

    // ② 声明并安装全部插件
    for (const p of ALL_PLUGINS) {
      try { this.host.define(p); } catch (e) { console.error('[boot] 插件声明失败', p && p.id, e); }
    }
    let disabled = new Set();
    try { disabled = new Set(JSON.parse(localStorage.getItem('xiaomo.plugins.disabled') || '[]')); }
    catch { /* 坏数据就当作没停用 */ }
    const st = this.host.installAll(disabled);
    this.bootStats = st;

    // ③ 装完之后才有耦合总线
    this.coupling = new CouplingBus(this.world);

    this.instrumentWorld();
    this.bindBus();
    this.bindGlobalKeys();

    this.mountSlots();
    this.afterSlots();

    // ④ 界面与外设
    this.engine.onFps = (f) => { const el = $('#fps'); if (el) el.textContent = f + ' fps'; };
    this.engine.start();

    this._lastUI = 0;
    this._tickUI();
    this._tickFx();
    window.addEventListener('resize', () => this.engine.resize());

    this.log.push('sys',
      `小墨实验室 v${VERSION} 已就绪 · ${st.installed}/${st.total} 个插件 · ${st.equipment} 种器材 · ${st.reactions} 条反应规则`, 0);
  }

  // ══════════ 插件插槽 ══════════
  mountSlots() {
    for (const name of this.host.slotNames()) {
      const el = document.querySelector(`[data-slot="${name}"]`);
      if (!el) continue;
      el.innerHTML = '';
      for (const item of this.host.slotItems(name)) {
        try { item.render(el, name); }
        catch (e) { console.error(`[slot] ${name} / ${item.pluginId} 渲染失败`, e); }
      }
    }
    bus.on('slot:changed', ({ name }) => this.mountSlot(name));
  }

  mountSlot(name) {
    const el = document.querySelector(`[data-slot="${name}"]`);
    if (!el) return;
    el.innerHTML = '';
    for (const item of this.host.slotItems(name)) {
      try { item.render(el, name); } catch (e) { console.error(`[slot] ${name}`, e); }
    }
  }

  /** 插槽挂完之后的收尾（预设下拉、默认场景） */
  afterSlots() {
    this.populatePresets();
    this.applyThemeFromStore();
    const last = localStorage.getItem('xiaomo.preset.v1') || 'electrolysis';
    this.loadPreset(last);
    if (this.inspector) this.inspector.empty();
  }

  applyThemeFromStore() {
    const id = localStorage.getItem('xiaomo.theme.v1') || 'mint';
    const mode = localStorage.getItem('xiaomo.mode.v1') || 'dark';
    theme.use(id, mode);
    theme.onChange((t, eff) => {
      localStorage.setItem('xiaomo.theme.v1', t.id);
      localStorage.setItem('xiaomo.mode.v1', eff);
    });
  }

  // ══════════ 服务：供插件调用 ══════════
  addTick(fn) { this.ticks.push(fn); return () => { const i = this.ticks.indexOf(fn); if (i >= 0) this.ticks.splice(i, 1); }; }

  /**
   * 声明「画面需要重绘」。
   * 与引擎脏检查的契约：只置位 this._dirty，由渲染循环读取并在画完一帧后清位。
   * 暂停且场景静止时，只有走过这里的交互（拖拽、悬停高亮、改参数、连线）才会触发重绘。
   */
  markDirty() { this._dirty = true; }

  /** 仿真时序：电路与化学的接缝 */
  instrumentWorld() {
    const raw = this.world.step.bind(this.world);
    this.world.step = (dt) => {
      const branches = this.coupling.buildBranches();     // 1) 空间识别 + 虚拟支路
      const c = solveCircuit(this.world, branches);        // 2) 解电路
      this.circuit = c;
      this.lastCircuit = c;
      this.coupling.distribute(dt, c);                     // 3) 电流 / 热量 / 温度分发
      raw(dt);                                             // 4) 世界演化
    };
  }

  // ══════════ 事件总线 ══════════
  bindBus() {
    bus.on(EV.REACTION, ({ rule, temp }) => {
      const chk = $('#chkChemLog');
      if (chk && !chk.checked) return;
      this.log.push('chem', `${rule.eq}   ${temp.toFixed(1)} ℃`, this.world.time);
    });
    bus.on(EV.COUPLING, ({ msg, domain }) => this.log.push(domain || 'bridge', msg, this.world.time));
    bus.on(EV.LOG, ({ domain, msg }) => this.log.push(domain || 'sys', msg, this.world.time));
    bus.on(EV.TOAST, ({ msg, kind }) => this.toast(msg, kind));
  }

  bindGlobalKeys() {
    window.addEventListener('keydown', (ev) => {
      const tag = (ev.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'select' || tag === 'textarea') return;
      const k = ev.key.toLowerCase();
      if (ev.ctrlKey && k === 's') { ev.preventDefault(); this.save(); return; }
      if (ev.ctrlKey && k === 'o') { ev.preventDefault(); this.load(); return; }
      if (k === 'v') this.setTool('select');
      else if (k === 'w') this.setTool('wire');
      else if (k === 'p') this.setTool('pour');
      else if (k === 'x') this.setTool('erase');
      else if (k === ' ') { ev.preventDefault(); this.toggleRun(); }
      else if (k === 'delete' || k === 'backspace') { if (this.selected) this.removeEntity(this.selected); }
      else if (k === 'escape') this.interaction && this.interaction.cancel();
    });
  }

  populatePresets() {
    const sel = $('#selPreset');
    if (!sel) return;
    sel.innerHTML = '<option value="">预置实验…</option>';
    for (const p of (this.services.presets || [])) {
      const o = document.createElement('option');
      o.value = p.id;
      o.textContent = p.name;
      sel.appendChild(o);
    }
  }

  // ══════════ 器材操作 ══════════
  addEntity(type, x, y) {
    const def = get(type);
    if (!def) return null;
    if (x === undefined || y === undefined) {
      const p = this.freeSpot();
      x = p.x; y = p.y;
    }
    const ent = create(type, x, y);
    if (!ent) return null;
    this.world.add(ent);
    this.select(ent);
    this.hideHint();
    this.toast(`已添加 ${def.name}`);
    return ent;
  }

  freeSpot() {
    const W = this.engine.w, H = this.engine.h;
    const cx = W * 0.46, cy = H * 0.48;
    for (let r = 0; r < 620; r += 36) {
      for (let a = 0; a < Math.PI * 2 - 1e-6; a += Math.PI / 7) {
        const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
        if (x < 90 || y < 80 || x > W - 90 || y > H - 60) continue;
        const clash = this.world.entities.some(e =>
          Math.abs(e.x - x) < (e.w + 70) / 2 && Math.abs(e.y - y) < (e.h + 70) / 2);
        if (!clash) return { x: Math.round(x), y: Math.round(y) };
      }
    }
    return { x: Math.round(cx), y: Math.round(cy) };
  }

  removeEntity(ent) {
    const name = ent.def.name;
    this.world.remove(ent);
    if (this.selected === ent) this.select(null);
    this.toast(`已删除 ${name}`);
  }

  duplicate(ent) {
    const e2 = create(ent.type, ent.x + 46, ent.y + 46);
    if (!e2) return;
    Object.assign(e2.props, ent.props);
    this.world.add(e2);
    this.select(e2);
  }

  select(ent) {
    if (this.selected) this.selected.selected = false;
    this.selected = ent;
    if (ent) ent.selected = true;
    if (this.inspector) this.inspector.show(ent);
  }

  clearWires() {
    this.world.wires.length = 0;
    for (const e of this.world.entities) {
      e.state.I = 0; e.state.U = 0; e.state.P = 0;
    }
    this.markDirty();     // 导线与电表读数都变了，别等兜底观测量
  }

  onEntityClicked(ent) {
    if (ent.state && ent.state.broken) {
      this.toast(`${ent.def.name} 已经损坏：${ent.state.brokenReason || ''}`, 'warn');
      return;
    }
    if (ent.type === 'switch') {
      ent.toggle();
      if (this.inspector) this.inspector.render();
      this.toast(ent.props.closed ? '开关已闭合' : '开关已断开');
    } else if (ent.flame) {
      ent.props.lit = !ent.props.lit;
      if (this.inspector) this.inspector.render();
      this.toast(ent.props.lit ? '酒精灯已点燃' : '酒精灯已熄灭');
    } else if (ent.type === 'glassrod') {
      ent.props.stirring = !ent.props.stirring;
      if (this.inspector) this.inspector.render();
    }
  }

  onEntityMoved() { /* 位置变化由耦合总线在下一帧自动重新识别插入关系 */ }

  // ══════════ 倾倒 ══════════
  doPour(from, to) {
    if (!to.vessel) { this.toast('目标必须是一个容器', 'warn'); return; }
    const tv = to.vessel;

    if (from.vessel) {
      const moved = from.vessel.pourInto(tv, 1);
      if (moved > 0) {
        this.toast(`倒出 ${moved.toFixed(0)} mL 到 ${to.def.name}`);
        this.log.push('chem', `倾倒：${from.def.name} → ${to.def.name}，${moved.toFixed(0)} mL`, this.world.time);
      } else {
        this.toast(`${from.def.name} 里没有液体`, 'warn');
      }
      return;
    }

    if (from.type.startsWith('reagent-')) {
      const id = from.props.reagent;
      const s = get('reagent-' + id);
      if (s && s.cat === '固体药品') {
        tv.addSolid(id, from.props.dose);
        this.toast(`加入 ${from.props.dose} g ${s.name}`);
      } else {
        tv.addLiquid(id, from.props.dose);
        this.toast(`加入 ${from.props.dose} mL ${s ? s.name : id}`);
      }
      this.log.push('chem', `加入试剂：${s ? s.name : id} → ${to.def.name}`, this.world.time);
    }
  }

  // ══════════ 预置场景 ══════════
  loadPreset(id) {
    const p = (this.services.presets || []).find(x => x.id === id);
    if (!p) return;
    this.loadScene(p.build());
    this.showHint(p.name, p.hint);
    this.log.push('sys', `载入预置实验：${p.name}`, 0);
    localStorage.setItem('xiaomo.preset.v1', id);
  }

  loadScene(sc) {
    this.world.clear();
    this.select(null);
    if (this.data) this.data.clear();
    this.coupling.links = [];
    this.coupling.branches = [];
    this._shortWarned = false;

    const ents = [];
    for (const o of sc.entities || []) {
      const ent = create(o.type, o.x, o.y);
      if (!ent) continue;
      if (o.props) for (const k of Object.keys(o.props)) ent.setProp(k, o.props[k]);
      if (o.state) Object.assign(ent.state, o.state);
      if (o.fill && ent.vessel) {
        const v = ent.vessel;
        v.capacity = ent.props.capacity || v.capacity;
        for (const [sid, mL] of (o.fill.liquid || [])) v.addLiquid(sid, mL);
        for (const [sid, g] of (o.fill.solid || [])) v.addSolid(sid, g);
        v.updateColor();
      }
      this.world.add(ent, true);
      ents.push(ent);
    }
    for (const w of sc.wires || []) {
      const a = ents[w[0]], b = ents[w[2]];
      if (!a || !b) continue;
      this.world.connect({ e: a.id, p: w[1] }, { e: b.id, p: w[3] }, w[4]);
    }
    this.world.time = 0;
    bus.emit(EV.SCENE_DIRTY);
  }

  // ══════════ 存档 ══════════
  save() {
    try {
      const idx = new Map();
      const data = { v: 2, entities: [], wires: [] };
      this.world.entities.forEach((e, i) => {
        idx.set(e.id, i);
        const o = e.toJSON();
        if (e.vessel) o.vessel = e.vessel.toJSON();
        data.entities.push(o);
      });
      for (const w of this.world.wires) {
        const a = idx.get(w.a.e), b = idx.get(w.b.e);
        if (a === undefined || b === undefined) continue;
        data.wires.push([a, w.a.p, b, w.b.p, w.kind]);
      }
      localStorage.setItem(STORE_KEY, JSON.stringify(data));
      this.toast('场景已保存到浏览器');
      this.log.push('sys', '场景已保存', this.world.time);
    } catch (err) {
      this.toast('保存失败：' + err.message, 'warn');
    }
  }

  load() {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) { this.toast('还没有保存过场景', 'warn'); return; }
    try {
      const data = JSON.parse(raw);
      this.world.clear();
      this.select(null);
      if (this.data) this.data.clear();
      const ents = [];
      for (const o of data.entities || []) {
        const ent = create(o.type, o.x, o.y);
        if (!ent) continue;
        ent.loadJSON(o);
        if (o.vessel && ent.vessel) ent.vessel.loadJSON(o.vessel);
        this.world.add(ent, true);
        ents.push(ent);
      }
      for (const w of data.wires || []) {
        const a = ents[w[0]], b = ents[w[2]];
        if (!a || !b) continue;
        this.world.connect({ e: a.id, p: w[1] }, { e: b.id, p: w[3] }, w[4]);
      }
      this.toast(`已载入 ${ents.length} 件器材`);
      this.log.push('sys', '场景已载入', this.world.time);
    } catch (err) {
      this.toast('载入失败：' + err.message, 'warn');
    }
  }

  exportPng() {
    try {
      const url = this.canvas.toDataURL('image/png');
      const a = document.createElement('a');
      a.href = url;
      a.download = `小墨实验室_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.png`;
      a.click();
      this.toast('截图已导出');
    } catch (err) {
      this.toast('导出失败：' + err.message, 'warn');
    }
  }

  // ══════════ 运行控制 ══════════
  setTool(t) {
    if (this.interaction) this.interaction.setTool(t);
    $$('#toolbar [data-tool]').forEach(b => b.classList.toggle('active', b.dataset.tool === t));
    const el = $('#stTool');
    if (el) el.textContent = TOOL_NAME[t] || t;
  }

  /**
   * 状态栏的键位提示（`ui.interaction` 的 setup 会在设完默认工具后立刻调用它）。
   *
   * 契约：六段提示**常在**（V 选择 / W 连线 / P 倾倒 / X 删除 / 空格 运行 / Ctrl+S 保存），
   * 当前工具那一段用 `<b>` 包住以示强调；未知工具值不抛错（只按现状显示常驻动作段）。
   * 这里复用静态标记里的 `#stTool`，不新增 class 也不需要新 CSS。
   */
  setStatusTool(t) {
    const el = $('#stTool');
    if (!el) return;
    el.innerHTML = '';
    for (const h of KEY_HINTS) {
      if (el.childNodes.length) el.appendChild(document.createTextNode(' · '));
      const seg = h.t && h.t === t ? document.createElement('b') : document.createElement('span');
      seg.textContent = h.label;
      el.appendChild(seg);
    }
  }

  toggleRun() {
    this.world.running = !this.world.running;
    const b = $('#btnRun');
    if (b) b.classList.toggle('active', this.world.running);
    const l = $('#runLabel');
    if (l) l.textContent = this.world.running ? '运行中' : '已暂停';
  }

  reset() {
    for (const e of this.world.entities) {
      e.state = Object.assign({}, e.def.state);
      e._lastTemp = undefined;
      if (e.vessel) e.vessel.empty();
      if (e.type === 'switch') e.props.closed = false;
      if (e.flame) e.props.lit = false;
    }
    this.world.time = 0;
    this._shortWarned = false;
    if (this.data) this.data.clear();
    this.markDirty();     // 全部状态被重置，等兜底观测量会白画一帧
    this.toast('已重置全部状态');
    this.log.push('sys', '实验台已重置', 0);
  }

  // ══════════ 提示 ══════════
  /**
   * 底部提示条。
   * 旧文案还在屏上时，先用 2px 模糊把它盖住，120ms 后再一次性落新文案 ——
   * 旧文案被遮罩挡住、新文案是原子替换，两者不会同时清晰可见（消除双重曝光）。
   */
  toast(msg, kind) {
    const el = $('#toast');
    if (!el) return;
    const cls = 'toast show' + (kind ? ' ' + kind : '');
    clearTimeout(this._toastT);
    clearTimeout(this._toastMask);

    if (!el.classList.contains('show') || (el.textContent === msg && el.className === cls)) {
      // 首次出现，或同一句提示续期：直接写入，无需遮罩
      el.textContent = msg;
      el.className = cls;
    } else {
      // 模糊只做一次离散写入（不在过渡里改模糊半径）
      el.style.filter = 'blur(2px)';
      this._toastMask = setTimeout(() => {
        el.style.filter = '';
        el.textContent = msg;
        el.className = cls;
      }, TOAST_MASK_MS);
    }

    this._toastT = setTimeout(() => { el.className = 'toast'; el.style.filter = ''; }, 2400);
  }

  showHint(title, sub) {
    const el = $('#hint');
    if (!el) return;
    const t = el.querySelector('.hint-title'), s = el.querySelector('.hint-sub');
    if (t) t.textContent = title;
    if (s) s.innerHTML = sub || '';
    el.style.opacity = '1';
    el.style.transform = 'translateY(0)';   // CSS 初值是 translateY(-10px)，落位才有入场位移
    el.style.pointerEvents = 'auto';
    this._hintShown = performance.now();
  }

  hideHint() {
    const el = $('#hint');
    if (!el) return;
    el.style.opacity = '0';
    el.style.transform = 'translateY(-10px)';
    el.style.pointerEvents = 'none';
  }

  // ══════════ 循环 ══════════
  _tickFx() {
    requestAnimationFrame(() => this._tickFx());
    const now = performance.now();
    let dt = (now - (this._lastFx || now)) / 1000;
    this._lastFx = now;
    if (!this.world.running) dt = 0;
    dt = Math.min(dt, 0.1);
    for (const fn of this.ticks) {
      try { fn(dt, this); } catch (e) { console.error('[tick]', e); }
    }
  }

  _tickUI() {
    requestAnimationFrame(() => this._tickUI());
    const now = performance.now();
    if (now - this._lastUI < 110) return;
    const dt = (now - this._lastUI) / 1000;
    this._lastUI = now;

    if (this.inspector) this.inspector.updateLive();
    if (this.data) this.data.step(dt || 0.11);
    this.updateStatus();
    if (this._hintShown && now - this._hintShown > 25000) this.hideHint();
  }

  updateStatus() {
    const c1 = $('#stCount');
    if (c1) c1.textContent = `${this.world.count()} 件器材 · ${this.world.wires.length} 条连线`;

    const c = this.circuit;
    const el = $('#stCircuit');
    if (el) {
      if (c && c.ok && c.shorted) { el.textContent = '电路短路'; el.className = 'warn'; }
      else if (c && c.ok && c.closed) { el.textContent = `电路接通 · ${fmtA(c.maxI)}`; el.className = 'on'; }
      else { el.textContent = '电路断开'; el.className = 'off'; }
    }

    const n = this.coupling.activeCount;
    const br = this.coupling.branches.length;
    const el2 = $('#stCoupling');
    if (el2) el2.textContent = br > 0 ? `耦合 ${n} 处 · 跨域支路 ${br}` : `耦合 ${n} 处`;
  }
}

// ── 启动 ──────────────────────────────────────────────────
window.addEventListener('error', (e) => console.error('[xiaomo]', e.error || e.message));
window.addEventListener('unhandledrejection', (e) => console.error('[xiaomo] 未处理的 Promise', e.reason));

const app = typeof document !== 'undefined' ? new App() : null;
if (app) window.xiaomo = app;
export default app;
