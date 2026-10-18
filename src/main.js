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
import { PluginInventory, PluginState } from './core/inventory.js';
import { bindRegistry, create, get } from './equipment/registry.js';
import { feedInto } from './equipment/lab.js';
import { CouplingBus } from './coupling/bridge.js';
import { UndoStack } from './core/undo.js';
import { solveCircuit, fmtA } from './physics/circuit.js';
import { bootTouch } from './ui/touch.js';

// ── 插件清单 ──────────────────────────────────────────────
// 名单在 src/plugins/index.js 里（唯一一份），这里只是转手：
// 启动要用它，tools/check.mjs 的装载守卫也 re-export 同一份，避免两处维护而漂移。
import { ALL_PLUGINS } from './plugins/index.js';
export { ALL_PLUGINS };

/**
 * 全部插件清单 —— 由 src/plugins/index.js 定义，这里原样转出，
 * 供 `tools/check.mjs` 的装载守卫复用（守卫装的必须和真正启动的是同一批插件）。
 */

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
/** 工具标识 → 状态栏 `#stTool` 显示的名字。六段键位提示由 `.hintline` 常驻，不在这里重复。 */
const TOOL_NAME = { select: '选择', wire: '连线', pour: '倾倒', erase: '删除' };
const STORE_KEY = 'xiaomo.scene.v1';
/** 提示条换文案前的遮蔽时长：旧文案先被 2px 模糊盖住，再落新文案 */
const TOAST_MASK_MS = 120;
export const VERSION = '2.0.0';

class App {
  constructor() {
    this.version = VERSION;
    this.canvas = $('#canvas');
    this.world = new World();
    /**
     * 撤销/重做栈（C9 骨架）：世界侧的增删改与接线都会记到这里。
     * ⚠ 它**不是** `markDirty()` —— 那个只是重绘脏标记，历史与重绘是两件事。
     */
    this.undo = new UndoStack({ limit: 100 });
    this.world.undo = this.undo;
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
    /** 插槽协调缓存：slotName → Map<条目身份, {render, nodes, ok}>。见 mountSlot()。 */
    this._slotCache = new Map();

    // ① 插件宿主
    this.host = new PluginHost(this);
    bindRegistry(this.host.registry('equipment'));
    theme.watchSystem();

    // ② 声明并安装全部插件
    for (const p of ALL_PLUGINS) {
      try { this.host.define(p); } catch (e) { console.error('[boot] 插件声明失败', p && p.id, e); }
    }
    // 启停选择归 PluginState 所有 —— 它顺带把旧键 `xiaomo.plugins.disabled`
    // （ui.manager 一直在写的那一个）迁进新结构，用户已有的停用选择不会丢。
    // 装之前就要有它，因为「要不要装」在装之前就得回答，那时宿主还没有记录可读。
    this.pluginState = new PluginState();
    // 清单是宿主之上的只读投影，界面看它、不看宿主；装之前就建好，装载过程的变化也有人接住。
    this.inventory = new PluginInventory(this.host, { state: this.pluginState });
    // toOffMap 给出 Map<id,'bundle'|'item'>：宿主据此既知道跳过谁，也知道是谁关的
    const st = this.host.installAll(this.pluginState.toOffMap(this.host.list()));
    this.bootStats = st;

    // ③ 装完之后才有耦合总线
    this.coupling = new CouplingBus(this.world);

    this.instrumentWorld();
    this.bindBus();
    this.bindGlobalKeys();

    this.mountSlots();
    this.afterSlots();

    // 触控行为层：装配必须在**插槽渲染过一轮之后** —— 主题圆钮由 ui.themeswitch 创建、
    // 顶栏两个开合入口由插件渲染进插槽，早于这一步它们都还不存在（实测就是这么漏的 ✗）。
    // 内部自带「缺件重试」（MutationObserver + 上限），插槽被重建时按钮与圆钮找得回来 ✓。
    bootTouch();

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
  /**
   * 冷启动挂载：每个插槽清空一次，再交给增量协调器。
   *
   * 这里必须清空 —— 此刻还没有任何条目被跟踪，缓存认不出「残留节点是谁的」，
   * 不清就会在全量渲染之后叠出一份重复界面。热路径（mountSlot）从此不再整体清空。
   */
  mountSlots() {
    this._slotCache = new Map();
    for (const name of this.host.slotNames()) {
      const el = document.querySelector(`[data-slot="${name}"]`);
      if (!el) continue;
      el.innerHTML = '';
      this.mountSlot(name);        // 与热路径共用一套协调逻辑，避免两份实现各自漂移
    }
    bus.on('slot:changed', ({ name }) => this.mountSlot(name));
  }

  /**
   * 按条目增量协调一个插槽：只重渲染「身份变了或节点已不在树上」的条目，其余原地复用。
   *
   * 为什么不能继续 innerHTML='' + 全量重建：任何一个条目的增减都会把同插槽里**其他**
   * 条目的 DOM 整批换掉。渲染闭包里的状态（抽屉开着没有、焦点在哪）随之消失，渲染函数里
   * 注册的 window 监听器还会每重建一次多一份 —— 而它们只进 ctx.onDispose，只有插件卸载
   * 时才会跑。拨一下设置里的学分开关（overlay 槽条目增减）能同时看到这两件事。
   */
  mountSlot(name) {
    const el = document.querySelector(`[data-slot="${name}"]`);
    if (!el) return;
    if (!this._slotCache) this._slotCache = new Map();
    let cache = this._slotCache.get(name);
    if (!cache) { cache = new Map(); this._slotCache.set(name, cache); }

    const alive = new Set();
    /** 本次「该就位的已跟踪节点」，按 slotItems() 的顺序收 */
    const ordered = [];

    for (const item of this.host.slotItems(name)) {
      // chain 是给「包裹式改造」用的串联插槽，它没有可挂载的 DOM，跑法是 host.runSlot()。
      // 把它当渲染器调用等于把它的第一个函数当绘制函数执行，所以这里必须跳过。
      if (item.kind === 'chain') continue;

      // 身份 = 插件 + 插入序号 + key，而且必须**再比对渲染函数本身**：
      // keyed 替换时新条目会「继承原条目的 seq」（core/plugin.js 为保持位置而写死的行为），
      // 只认 (pluginId, seq) 的话，替换后的新渲染函数会被判成老条目而永远不再执行 ——
      // 那比全量重建更糟：界面从此停在旧内容上。render 换了就必须重渲染。
      const id = `${item.pluginId}\u0000${item.seq}\u0000${item.key ?? ''}`;
      alive.add(id);
      const prev = cache.get(id);
      const reusable = !!prev && prev.ok && prev.render === item.render
        && prev.nodes.length > 0
        && prev.nodes.every((n) => el.contains(n));

      if (reusable) {
        for (const n of prev.nodes) if (n.parentNode === el) ordered.push(n);
        continue;
      }

      // 要重渲染：先摘掉这个条目上一次贡献的节点，否则同一份界面会叠成两份
      if (prev) for (const n of prev.nodes) if (n.parentNode === el) el.removeChild(n);

      const before = new Set(el.children);
      let ok = true;
      try { item.render(el, name); }
      catch (e) { ok = false; console.error(`[slot] ${name} / ${item.pluginId} 渲染失败`, e); }

      // 用「渲染前后的直接子节点差集」认领这次新增的节点：一个 render 里可能 append
      // 好几个节点（也常见 innerHTML 一次塞一坨），差集都能收齐，不必要求插件上报。
      const nodes = [...el.children].filter((n) => !before.has(n));
      if (nodes.length) {
        cache.set(id, { render: item.render, nodes, ok });
        for (const n of nodes) ordered.push(n);
      } else {
        // 产出 0 个节点时**绝不能**写缓存：「这次条件不满足所以什么都没渲染」一旦被缓存住，
        // 这个条目就永久钉死在空状态，之后条件满足了也不会再渲染。
        cache.delete(id);
      }
    }

    // 条目消失了（被停用 / 卸载 / 被单例顶掉）：只摘「被本协调器跟踪过、这次不在」的节点。
    // 绝不碰未跟踪的节点 —— 有插件不经过 render 直接往宿主里塞浮层，误删是灾难性回归。
    for (const [id, prev] of [...cache]) {
      if (alive.has(id)) continue;
      for (const n of prev.nodes) if (n.parentNode === el) el.removeChild(n);
      cache.delete(id);
    }

    // 末端让已跟踪节点回到 slotItems() 的顺序。appendChild / insertBefore 对已在树上的节点
    // 是「移动」而非重渲染，但移动会打断进行中的 CSS 过渡，所以相对顺序本来就对时一根手指都不碰。
    // 比较只看已跟踪节点之间的次序：未跟踪节点插在中间不算乱序，也就不会被顺手挪走。
    const want = new Set(ordered);
    const current = [...el.children].filter((n) => want.has(n));
    if (!(current.length === ordered.length && current.every((n, i) => n === ordered[i]))) {
      let anchor = null;             // 逆序回填：锚点恒为「本节点后面该接的那一个」
      for (let i = ordered.length - 1; i >= 0; i--) {
        const n = ordered[i];
        if (n.parentNode !== el || n.nextSibling !== anchor) el.insertBefore(n, anchor);
        anchor = n;
      }
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
    // 首次访问（没有任何记录）落在 'system'，也就是跟随系统 —— 用户拍板的默认策略。
    // index.html 头部有一段同步内联脚本按同一口径算首屏配色，改这里要同步改那里。
    const mode = localStorage.getItem('xiaomo.mode.v1') || 'system';
    theme.use(id, mode);
    theme.onChange((t) => {
      localStorage.setItem('xiaomo.theme.v1', t.id);
      // 存「意图」（system / dark / light），不存当时生效的值。
      // 早先这里存的是 eff，而 apply() 结尾就会发 theme:changed —— 于是开机第一次就把
      // 'system' 洗成了 'dark'/'light'，桌面壳据此认定用户手动选过，从此不再跟随系统。
      localStorage.setItem('xiaomo.mode.v1', theme.mode);
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

  /**
   * 器材拖动落定后的收尾。
   *
   * ⚠ 2026-10-17（交互改造 ④-6）：这里原先是**空函数**（只有一句"位置变化由耦合总线
   * 在下一帧自动重新识别"）。那句话本身没错，但它掩盖了一个缺口 ——
   * **拖动完全不入撤销栈**：位置是由 `interact.js` 直接写的 `ent.x/y`，绕过了
   * `setProp()`（唯一会自动入栈的口子），于是「栈在跑、用户够不着」，
   * 拖错了只能手动拖回去。
   *
   * ⇒ 现在由交互层把**起止坐标**传进来（`from`/`to`），在这里记一条 `move` 操作。
   *   耦合总线那件事照旧 —— 撤销/重做回放位置后，下一帧它同样会重新识别插入关系。
   */
  onEntityMoved(ent, from, to) {
    // 没真动过（起止同一格）⇒ 不产生历史条目，否则拖一下原地不动也会堆一条空的
    if (!ent || !from || !to) return;
    if (from.x === to.x && from.y === to.y) return;
    const place = (p) => { ent.x = p.x; ent.y = p.y; this.markDirty(); };
    this.undo.push({
      kind: 'move',
      label: `移动「${ent.def ? ent.def.name : ent.type}」`,
      ent,
      undo: () => place(from),
      redo: () => place(to),
    });
  }

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

    // 加料能力判定：判据是「器材自带一份物质与取用量」，**不是 type 前缀**。
    // 原来这里写 get('reagent-' + id) 反查，等于把命名当契约 ——
    // 新增加料器材（滴瓶、洗瓶……）就必须回来改这一行。
    const fed = feedInto(from, tv);
    if (fed) {
      this.toast(fed.solid
        ? `加入 ${fed.dose} g ${fed.name}`
        : `加入 ${fed.dose} mL ${fed.name}`);
      this.log.push('chem', `加入试剂：${fed.name} → ${to.def.name}`, this.world.time);
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
    // 撤销栈（C9）：载入**不是**用户单步动作 ⇒ 挂起记录
    // （否则 `entity.setProp` 与 `world.connect` 会把整份存档灌成上百条历史）
    // (甲) 用 try/finally：载入体里任何一步抛出（例如 `sc.wires` 里的坏数据）都必须**解挂**，
    // 否则闸门会静静地一直挂着 —— 之后用户真的动手改参数时，历史一条都不记（最难发现的那类失效）。
    this.undo.beginSilent();
    try { this._applyScene(sc); } finally { this.undo.endSilent(); }
    bus.emit(EV.SCENE_DIRTY);
  }

  /**
   * 把一份场景数据落到世界里。**必须**在 undo 挂起中调用（载入不产生历史条目）。
   * 从 `loadScene` 原样搬出：缩进未变、逐字节相同，只为给挂起配上 try/finally。
   */
  _applyScene(sc) {
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
      // 撤销栈（C9）：读档同 `loadScene` —— 挂起记录，整份存档不产生历史条目
      // (甲2) 与 `loadScene` **同一形状**：`beginSilent()` 与 `try` 之间不夹任何语句
      // ⇒ 挂起残留从"被断言保护"变成"结构上不可能"，而不是"今天恰好安全"。
      this.undo.beginSilent();
      let n;
      try { n = this._applySave(data); } finally { this.undo.endSilent(); }
      this.toast(`已载入 ${n} 件器材`);
      this.log.push('sys', '场景已载入', this.world.time);
    } catch (err) {
      // ⚠ 这里**故意不再** `endSilent()`：解挂已由上面那行的 finally 结构性保证 ✓。
      //   留着它会把"将来有人把 `beginSilent` 挪到 `try` 之外"这类失误**重新藏起来**
      //   （catch 兜住 ⇒ 探针不会红 ⇒ 又是一次"被兜底盖住的真实缺口"）。
      this.toast('载入失败：' + err.message, 'warn');
    }
  }

  /**
   * 把一份存档数据落到（已清空的）世界里，返回器材数组。**必须**在 undo 挂起中调用。
   * 从 `load()` 原样搬出（缩进由 6 归到 4，与 `_applyScene` 同一层次），逻辑一字未改。
   */
  _applySave(data) {
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
    return ents;
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
  /**
   * 切换工具。状态栏由 `interaction.setTool` → `setStatusTool` 负责（六段提示常在 +
   * 当前工具加粗）；这里**不能**再用裸工具名去覆盖它，否则加粗与其余五段会被抹掉。
   * `app.interaction` 尚未建起（交互插件被停用）时，状态栏保留 index.html 里的静态六段提示。
   */
  setTool(t) {
    if (this.interaction) this.interaction.setTool(t);
    $$('#toolbar [data-tool]').forEach(b => b.classList.toggle('active', b.dataset.tool === t));
  }

  /**
   * 更新状态栏左侧的工具槽位 `#stTool`（`ui.interaction` 的 setup 会在设完默认工具后调用）。
   *
   * 只写这一个元素的文本，理由有两条：
   * 1. 六段键位提示已经由 `index.html` 的 `.hintline` 常驻在状态栏右侧，
   *    这里再渲染一遍就会在同一行里出现两次（实测确实重复过）。
   * 2. `#statusbar` 的 innerHTML 绝不能整体重写——同组的 `#stCount`（器材数）、
   *    `#stCircuit`（电路状态）、`#stCoupling`（耦合处数）、`#fps`（帧率）
   *    由其他代码按 id 更新，重写会把它们抹掉。
   * `.st-tool` 自带 `color:var(--accent)`，本身就是高亮，无需再包 `<b>`。
   * 未知工具值退化为原样显示，不抛错（无 DOM 的环境直接返回）。
   */
  setStatusTool(t) {
    const el = $('#stTool');
    if (!el) return;
    el.textContent = TOOL_NAME[t] || t;
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
    // 撤销栈（C9）(乙) 口径定案：**重置是基线操作 —— 不产生历史，也不是"一堆用户动作"**。
    //   · 它整体换掉基线（`state` / `props` / `vessel` 一起重写）；把其中两行 `props` 单独改走
    //     `setProp` 只会让它变成"半挂账"——比任一种极端都差；
    //   · 走 `setProp` 还会触发 `onProp` 钩子 ⇒ 那是**行为变化**，本轮无人要求、也无验收覆盖。
    //   ⇒ 定案：直接写 + **清空历史**（旧历史对重置后的世界不再成立）。
    //   ⇒ 这条口径由 `tools/undo-probe.mjs` §6 锁住（源码断言 + 机制断言 + 两个定向变异体），不靠注释自觉。
    this.undo.clear();
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
