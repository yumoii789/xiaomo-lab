// ══════════════════════════════════════════════════════════
// UI · 属性检视器
// 左边是「可调参数」（来自器材定义的 fields），
// 右边是「实时读数」（电路解和化学状态）。
// ══════════════════════════════════════════════════════════

import { fmtA, fmtV, fmtW, fmtR } from '../physics/circuit.js';
import { SP } from '../chemistry/species.js';
import { menuCaps } from '../equipment/caps.js';

export class Inspector {
  constructor(rootEl, app) {
    this.root = rootEl;
    this.app = app;
    this.ent = null;
    this._live = null;
    this._sig = null;      // 带符号读数区块（只对有电极的容器出现，见 render()）
    this._pos = null;      // 空间位置区块（每件器材都有，见 render()）
    // 「添加到曲线」入口：元素 → 取值闭包。用 WeakMap 挂，**不往 DOM 上加子节点、不加自定义属性**
    // （既有逐字判据按 children[i]/[i+1] 成对读 textContent，多一个子节点就会整体错位）。
    this._picks = new WeakMap();
  }

  show(ent) {
    this.ent = ent;
    this.render();
  }

  empty() {
    this.root.replaceChildren(h('div', 'blank', [
      h('div', 'blank-t', '未选中器材'),
      h('div', 'blank-s', '点击实验台上的器材\n查看并调整它的参数'),
    ]));
    this._live = null;
    this._sig = null;
    this._pos = null;
  }

  render() {
    if (!this.ent) { this.empty(); return; }
    const e = this.ent;

    const frag = document.createDocumentFragment();

    // ── 头部 ──
    const head = h('div', 'ihead ' + domClass(e.domain));
    head.appendChild(h('span', 'ico', e.icon));
    const tt = h('div', 'tt');
    tt.appendChild(h('b', '', e.name));
    tt.appendChild(h('small', '', e.def.desc || e.def.cat));
    head.appendChild(tt);
    frag.appendChild(head);

    // ── 参数 ──
    if (e.def.fields && e.def.fields.length) {
      frag.appendChild(h('div', 'sect', '可调参数'));
      for (const f of e.def.fields) frag.appendChild(this.field(e, f));
    }

    // ── 实时读数 ──
    frag.appendChild(h('div', 'sect', '实时读数'));
    this._live = h('div', 'ro');
    // 逐行入口用**事件委托**（每行不挂自己的监听器：区块每帧重建，逐个挂会一路堆积）。
    this._live.addEventListener('click', (ev) => this.pickRow(ev));
    frag.appendChild(this._live);

    // ── 瞬间读数（带符号）──
    // 「实时读数」里的「通过电流」是**幅度**口径（问的是"通没通电、多大"），逐字不动：
    // 电解产物方向、化学面板既有断言都挂在那一行上。这里**并列**出第二路读数，口径是
    // 参考方向本身 —— 读耦合层每帧写进容器的带符号易失量（bridge.js:172-173，
    // 二者同参考方向：正半周同正、负半周同负），对应 NB 元器件状态面板的「瞬间电流/瞬间电压」。
    // 独立区块而不是并进 _live：既有行集有逐字回归判据（tools/inspector-probe.mjs §②），
    // 新口径必须**并列**可见，不能改写既有行。
    // 区块按「是容器」而不是「有电极」建：先选中烧杯、后插电极的流程里 render() 不会再跑，
    // 靠 updateLive() 每帧刷内容才跟得上（没插电极时那两行显示占位文案，见 updateSigned()）。
    if (e.vessel) {
      frag.appendChild(h('div', 'sect', '瞬间读数（带符号）'));
      this._sig = h('div', 'ro');
      this._sig.addEventListener('click', (ev) => this.pickRow(ev));
      frag.appendChild(this._sig);
      this.updateSigned();
    } else {
      this._sig = null;
    }

    // ── 空间位置 ──
    // 对应 NB 元器件状态面板的第三组「空间位置」（Position + Rotation）。
    // 真源就是 Entity 自己的几何字段（src/core/entity.js:26-28），**不新增第二份真值**：
    //   · x / y —— 实验台坐标，单位是画布 CSS 像素（interact.js:85-88 直接把
    //     clientX-rect.left 当器材坐标用，engine.w/h 就是画布逻辑尺寸），原点是画布左上角，
    //     值是器材**中心**（hitTest/bounds 都按中心算）。
    //   · rot —— **弧度**。entity.js 用它算接线柱世界坐标（cos/sin）、world.js:184 直接喂给
    //     ctx.rotate()。面板按 ° 显示，是因为器材自己的倾角参数一律用 °
    //     （mechanics/optics 的 fields.unit），同一块面板里不混两套角度单位。
    // 二维实验台：真源里**没有 z**，所以这里不摆 Z 行（不许为了对齐 NB 的三维面板而造字段）。
    // 独立区块 + 每帧刷新：拖动时 render() 不会再跑，只有每帧刷内容才跟得上指针
    // （interact.js:268 每个 pointermove 就写一次 x/y）。
    frag.appendChild(h('div', 'sect', '空间位置'));
    this._pos = h('div', 'ro');
    this._pos.addEventListener('click', (ev) => this.pickRow(ev));
    frag.appendChild(this._pos);
    this.updatePosition();

    // ── 操作 ──
    // 菜单项由**器材自己的能力位**决定（三层优先：def.caps → 中央表 src/equipment/caps.js →
    // 兜底，见 caps.js）。改前是 UI 按特征猜（`e.type === 'switch'` / `e.flame` / `e.vessel`），
    // 那三个判断现在退到兜底层：任何没声明能力位的器材（含用户器材包）行为逐位不变
    // ——证据是 tools/inspector-caps-probe.mjs §① 的全量逐件对照。
    const caps = menuCaps(e);
    const btns = h('div', 'btns');
    if (caps.toggle) {
      btns.appendChild(btn('切换通断', 'acc', () => {
        e.toggle(); this.render(); this.app.markDirty();
      }));
    }
    if (caps.ignite) {
      // flame 是「热源」标记：加热板 / 水浴也带它，统一写「酒精灯」会让用户拿酒精灯的字样去点加热板。
      // 文案按器材自己的名字取词；名字里带「灯」的仍是点燃/熄灭（酒精灯本身逐字不变）。
      const noun = e.name || '加热器';
      const verb = /灯/.test(noun)
        ? (e.props.lit ? '熄灭' : '点燃')
        : (e.props.lit ? '关闭' : '开启');
      btns.appendChild(btn(verb + noun, 'chem', () => {
        e.props.lit = !e.props.lit; this.render(); this.app.markDirty();
      }));
    }
    if (caps.empty) {
      btns.appendChild(btn('倒空容器', '', () => {
        e.vessel.empty(); this.render(); this.app.markDirty();
      }));
    }
    if (caps.duplicate) btns.appendChild(btn('复制', '', () => this.app.duplicate(e)));
    if (caps.remove) btns.appendChild(btn('删除', 'dgr', () => this.app.removeEntity(e)));
    frag.appendChild(btns);

    this.root.replaceChildren(frag);
    this.updateLive();
  }

  // ── 单个字段 ──
  field(e, f) {
    const wrap = h('div', 'field');
    const val = f.unit ? ` ${f.unit}` : '';

    if (f.type === 'range' || f.type === 'number') {
      const lab = h('label');
      lab.appendChild(h('span', '', f.label));
      const v = h('span', 'v', fmtNum(e.props[f.k]) + val);
      lab.appendChild(v);
      wrap.appendChild(lab);

      const inp = document.createElement('input');
      inp.type = 'range';
      inp.min = f.min; inp.max = f.max; inp.step = f.step ?? 1;
      inp.value = e.props[f.k];
      inp.addEventListener('input', () => {
        const nv = parseFloat(inp.value);
        e.setProp(f.k, nv);
        v.textContent = fmtNum(nv) + val;
        if (e.vessel && f.k === 'capacity') e.vessel.capacity = nv;
        this.app.markDirty();
      });
      wrap.appendChild(inp);
    } else if (f.type === 'checkbox') {
      const row = h('label', 'chk-row');
      const inp = document.createElement('input');
      inp.type = 'checkbox';
      inp.checked = !!e.props[f.k];
      inp.addEventListener('change', () => {
        e.setProp(f.k, inp.checked);
        this.app.markDirty();
      });
      row.appendChild(inp);
      row.appendChild(h('span', '', f.text || f.label));
      wrap.appendChild(row);
    } else if (f.type === 'select') {
      const lab = h('label');
      lab.appendChild(h('span', '', f.label));
      wrap.appendChild(lab);
      const sel = document.createElement('select');
      for (const [v, t] of f.options) {
        const o = document.createElement('option');
        o.value = v; o.textContent = t;
        if (e.props[f.k] === v) o.selected = true;
        sel.appendChild(o);
      }
      sel.addEventListener('change', () => {
        e.setProp(f.k, sel.value);
        this.app.markDirty();
      });
      wrap.appendChild(sel);
    } else {
      const lab = h('label');
      lab.appendChild(h('span', '', f.label));
      wrap.appendChild(lab);
      const inp = document.createElement('input');
      inp.type = 'text';
      inp.value = e.props[f.k] ?? '';
      inp.addEventListener('change', () => { e.setProp(f.k, inp.value); this.app.markDirty(); });
      wrap.appendChild(inp);
    }
    return wrap;
  }

  // ── 实时读数（每帧节流调用） ──
  updateLive() {
    const e = this.ent;
    if (!e || !this._live) return;
    const rows = [];
    const st = e.state || {};

    // 这四个键是**电路解**注入的量（circuit.js 只往电路支路器材上写 I/U/P/R）⇒ 只有电路支路器材才该
    // 被贴上电学标签。域盲照发会把别的域的同名键一起贴错 —— 实测两例：lever 的 I（转动惯量 kg·m²）
    // 显示成「电流 I … A」、soundlevel 的 I/P（声强 W/m²、声源功率 W）显示成「电流 I 79.6 µA / 功率 P 1 mW」。
    // 非支路器材不再发这四行 ⇒ 落回各自域的域表，按本域的名字与单位报出（力学「转动惯量 I」、声学「声强」）。
    const isBranch = typeof e.circuitBranch === 'function';
    if (isBranch && typeof st.I === 'number') rows.push(['电流 I', fmtA(st.I)]);
    if (isBranch && typeof st.U === 'number') rows.push(['两端电压 U', fmtV(st.U)]);
    if (isBranch && typeof st.P === 'number' && st.P > 1e-9) rows.push(['功率 P', fmtW(st.P)]);
    if (isBranch && typeof st.R === 'number') rows.push(['等效电阻 R', fmtR(st.R)]);
    // ⑧甲：烧毁 ⇒ 器材已被移出电路（circuit.js:74 跳过它）⇒ 上面四行是 damage 规则清出来的零
    // （rules.damage.js 的 e.state.I = 0; e.state.U = 0; e.state.P = 0;），**不是电路解**。
    // 留着它就会同屏出现「电流 I 0 A」与「示数 —（已烧毁）」两种说法 ⇒ 整组撤下，只留状态。
    // 为什么是后置 filter 而不是直接改上面四行：那四行被两套探针**逐字冻结**（inspector-probe.mjs 的
    // 「旧行是新行的前缀」判据、inspector-stats-probe.mjs 的变异靶点都锚在这四行的源码文本上），
    // 动一个字就打红两套探针 ⇒ 只改渲染结果、不改源码行。
    if (isBranch && st.broken) {
      for (let k = rows.length - 1; k >= 0; k--) if (FOUR_KEYS.has(rows[k][0])) rows.splice(k, 1);
      rows.push(['状态', '已烧毁']);
      if (typeof st.brokenReason === 'string' && st.brokenReason) rows.push(['烧毁原因', st.brokenReason]);
    }

    // ── B4 器材自报统计量（plans/11 §6.3 / §6.5）──────────────────────────────
    //    ⚠ 位置**必须在四键与烧毁 filter 之后、所有 type 专属分支之前**。
    //       这不是风格问题，是**行顺序契约**：迁移前每条器材的读数行就写在各自 type 分支所在的位置上，
    //       而 `inspector-probe.mjs` 的「旧行必须是新行的前缀（只许尾部追加）」判据会**逐件核对顺序**。
    //       本循环若留在文件后段（它最初被写下的位置），已迁器材的行就会跑到 B5「实时/瞬时」、
    //       电表、交流源等分支**之后** ⇒ 旧行不再是前缀 ⇒ 逐件对照立刻红。
    //       2026-10-17 实际发生过一次，而且是 `inspector-probe` 抓到的：本探针当时只按**标签取值**、
    //       **不看顺序**，所以整批迁移都「绿着」通过了，盲区直到 thermistor 那批才被外部判据暴露。
    //       放在这里（烧毁 filter 之后）之后：对已迁器材，stats 行与它们各自原分支的位置**等价**；
    //       对未声明 stats 的器材，本循环一行都不加 ⇒ 零影响。
    //    `read(e)` **每次现取**（与 data.js 的取值闭包、updatePosition 的 read 同一条口径，§6.2 约束 1）。
    //    ⚠ 本步仍**不碰** `picks` / `pickFor`：把 slug 交给器材声明是第 2 步之后的收尾。
    //    `read` 的第二个参数是**视野** `ctx = {app, world}`（plans/11 §6.6）：供需要看别的器材的读数用
    //    （如 alcohollamp 的「加热对象」要 world.get(target).def.name）。只声明 (e) 的旧声明完全不受影响。
    const ctx = { app: this.app, world: this.app && this.app.world };
    for (const s of (e.def && e.def.stats) || []) {
      const v = s.read(e, ctx);
      if (typeof v === 'string') { rows.push([s.label, v]); continue; }
      // ⚠ `fmt` 必须在**有限性检查之前**：它正是用来表达「取不到也有话说」的那一支
      //    （`fmtR(NaN)` ⇒ '∞'）。若先按 !Number.isFinite 跳过，'∞' 就永远上不了屏 ——
      //    而迁移前它是上屏的（`fmtR(R)` 直接拼进 rows）。
      if (s.fmt) { rows.push([s.label, s.fmt(v)]); continue; }
      if (!Number.isFinite(v)) continue;
      rows.push([s.label, fmtBy(s.digits, v) + (s.unit ? ' ' + s.unit : '')]);
    }

    // `thermistor` 的三行已迁到**器材自报**（`electrical.js` 的 thermistorDef.stats）—— plans/11 §6.3 第 2 步。
    // 它是电路支路 ⇒ 四键先出、stats 行紧随其后，顺序与迁移前一致。
    // 「当前阻值」走新接口字段 `fmt: fmtR`（自适应单位 Ω/kΩ/MΩ），接口缺口三已关闭，见 plans/11 §6.5。
    // `motor` 的「运转状态」「转速」已迁到**器材自报**（`electrical.js` 的 motorDef.stats）
    // —— plans/11 §6.3 第 2 步。它是电路支路 ⇒ 求解器四键先出、stats 行紧随其后，顺序与迁移前一致。
    // `balance` / `phmeter` / `phpaper` 的读数行已迁到**器材自报**
    // （`lab.js` 的 balanceDef / phDef / paperDef）—— plans/11 §6.3 第 2 步。
    // 三处的 stats 行都在**兜底之前**，所以行数与顺序与迁移前一致。
    // `thermometer` 的「测得温度」已迁到**器材自报**（`lab.js` 的 `thermoDef.stats`）—— plans/11 §6.3 第 2 步。
    // 这里刻意**不留**空行占位：删掉分支后，行数与顺序由 stats 行在**兜底之前**顶住（⑬ 组已证明该机制）。
    // `alcohollamp` 的两行已迁到**器材自报**（`heating.js` 的 alcoholDef.stats）—— plans/11 §6.3 第 2 步。
    // 这一处带出了第 4 个接口缺口：「加热对象」要报**另一件器材**的名字 ⇒ `read` 增第二参数 `ctx`
    // （视野 {app, world}），见 plans/11 §6.6。**至此八处类型分支全部迁完。**
    // `electrode` 的两行已迁到**器材自报**（`lab.js` 的 electrodeDef.stats）—— plans/11 §6.3 第 2 步。
    // 「标准电极电势」带 `+` 符号前缀，digits/unit 表达不了 ⇒ 由 read 直接返回**字符串**。

    // ── 电子 / 信号器材的读数行（新增） ──
    //    为什么必须逐个显式写：这批器材都是**电路支路**，求解器每帧注入 I/U/P/R ⇒ 上面的四键
    //    永远先凑出行 ⇒ 底下「兜底」那块（if (!rows.length)）对它们从不执行 ⇒ 它们自己算出来的
    //    Urms / iL / tau / eta / duty … 一个都上不了屏（尽管画布上早画出来了）。
    //    取值一律「取不到就给占位文案」，不用 NaN 充数；单位与精度沿用上方 fmtA/fmtV/fmtW/fmtR 的口径。
    if (e.type === 'resistorcap') {
      rows.push(['电容电压 U_C', (st.Uc || 0).toFixed(3) + ' V']);
      rows.push(['充电电流 i', fmtA(st.i || 0)]);
      rows.push(['时间常数 τ=RC', (st.tau || 0).toFixed(3) + ' s']);
      rows.push(['充电进度', (100 * (st.pct || 0)).toFixed(1) + ' %']);
      rows.push(['实测 63.2% 用时', st.t63 >= 0 ? st.t63.toFixed(3) + ' s' : '—（充电中）']);
      rows.push(['计时 t', (st.t || 0).toFixed(2) + ' s']);
      rows.push(['积分窗长 3τ', (st.tEnd || 0).toFixed(3) + ' s']);
      rows.push(['曲线采样点', String((st.traj || []).length)]);
    }
    if (e.type === 'inductorcoil') {
      rows.push(['电感电流 i_L', fmtA(st.iL || 0)]);
      rows.push(['稳态电流 I=U/R', fmtA(st.iSteady || 0)]);
      rows.push(['自感电压 u_L', fmtV(st.uL || 0)]);
      rows.push(['断电自感尖峰', st.spike > 0 ? (st.spike / 1000).toFixed(1) + ' kV' : '—（未断电）']);
      rows.push(['断电瞬时电流 I₀', st.breaking ? fmtA(st.i0break || 0) : '—（未断电）']);
      rows.push(['断路时间常数', st.breaking ? (st.tauOpen || 0).toExponential(2) + ' s' : '—（未断电）']);
      rows.push(['时间常数 τ=L/R', (st.tau || 0).toFixed(3) + ' s']);
      rows.push(['电压来源', st.fromCircuit ? '真电路（求解器端电压）' : '自身 U₀']);
      rows.push(['泄放状态', st.breaking ? '正在泄放' : '静止']);
      rows.push(['计时 t', (st.t || 0).toFixed(2) + ' s']);
      rows.push(['曲线采样点', String((st.traj || []).length)]);
    }
    if (e.type === 'acsource') {
      rows.push(['有效电压 U_rms=Up/√2', (st.Urms || 0).toFixed(3) + ' V']);
      rows.push(['实测有效值', (st.rmsMeas || 0).toFixed(3) + ' V']);
      rows.push(['瞬时电动势 e(t)', (st.emf || 0).toFixed(3) + ' V']);
      rows.push(['峰峰值', (st.pp || 0).toFixed(3) + ' V']);
      rows.push(['周期 T=1/f', (st.T || 0).toFixed(4) + ' s']);
      rows.push(['仿真时刻', (st.t || 0).toFixed(2) + ' s']);
      rows.push(['上次采样时刻', (st.tLast || 0).toFixed(2) + ' s']);
      rows.push(['周期缓冲点数', String((st.buf || []).length)]);
      rows.push(['缓冲时间轴点数', String((st.bufT || []).length)]);
    }
    if (e.type === 'oscilloscope') {
      rows.push(['实测频率', Number.isFinite(st.fMeas) ? st.fMeas.toFixed(2) + ' Hz' : '—（无信号源）']);
      rows.push(['源频率', (st.fSrc || 0).toFixed(2) + ' Hz']);
      rows.push(['源峰值电压', (st.UpSrc || 0).toFixed(3) + ' V']);
      rows.push(['峰峰值', (st.pp || 0).toFixed(3) + ' V']);
      rows.push(['实测有效值', (st.rmsMeas || 0).toFixed(3) + ' V']);
      rows.push(['周期 T=1/f', Number.isFinite(st.T) ? st.T.toFixed(4) + ' s' : '—（无信号源）']);
      rows.push(['采样点数', String(st.n || 0)]);
      rows.push(['测频相对误差', Number.isFinite(st.df) ? (100 * st.df).toFixed(2) + ' %' : '—（无信号源）']);
      rows.push(['首次上升过零', Number.isFinite(st.firstCross) ? st.firstCross.toFixed(3) + ' s' : '—（无信号源）']);
      rows.push(['解析预测过零', Number.isFinite(st.predCross) ? st.predCross.toFixed(3) + ' s' : '—（无信号源）']);
      rows.push(['相位偏差', Number.isFinite(st.dPhase) ? st.dPhase.toFixed(3) + ' 个周期' : '—（无信号源）']);
      rows.push(['信号源', st.srcId ? '已锁定' : '—（附近无信号源）']);
      rows.push(['信号源名称', st.srcName || '—（附近无信号源）']);
      rows.push(['采样缓冲点数', String((st.buf || []).length)]);
      rows.push(['采样时间轴点数', String((st.bt || []).length)]);
    }
    if (e.type === 'transformer') {
      rows.push(['一次电压 U₁', (st.U1 || 0).toFixed(3) + ' V']);
      rows.push(['二次电压 U₂', (st.U2 || 0).toFixed(3) + ' V']);
      rows.push(['一次电流 I₁', fmtA(st.I1 || 0)]);
      rows.push(['二次电流 I₂', fmtA(st.I2 || 0)]);
      rows.push(['一次功率 P₁', fmtW(st.P1 || 0)]);
      rows.push(['二次功率 P₂', fmtW(st.P2 || 0)]);
      rows.push(['效率 η', (100 * (st.eta || 0)).toFixed(1) + ' %']);
      rows.push(['电压比 U₁/U₂', (st.ratio || 0).toFixed(3)]);
      rows.push(['匝数比 N₁/N₂', (st.nRatio || 0).toFixed(3)]);
      rows.push(['信号源', st.srcId ? '已锁定' : '—（附近无信号源）']);
    }
    if (e.type === 'diode') {
      rows.push(['导通状态', st.on ? '导通' : '截止']);
      rows.push(['导通角 θ₀', (st.theta0 || 0).toFixed(1) + ' °']);
      rows.push(['导通占空比（实测）', (100 * (st.duty || 0)).toFixed(1) + ' %']);
      rows.push(['导通占空比（理论）', (100 * (st.dutyTheory || 0)).toFixed(1) + ' %']);
      rows.push(['可整流平均值', (st.meanTheory || 0).toFixed(3) + ' V']);
      rows.push(['源峰值电压', (st.Up || 0).toFixed(3) + ' V']);
      rows.push(['正向压降 Vf', (st.vfEffect || 0).toFixed(2) + ' V']);
      rows.push(['导通采样点数', String((st.buf || []).length)]);
      rows.push(['信号源', st.srcId ? '已锁定' : '—（附近无信号源）']);
    }

    // 容器化学状态
    if (e.vessel) {
      const v = e.vessel;
      rows.push(['液体体积', v.volume.toFixed(1) + ' / ' + v.capacity + ' mL']);
      rows.push(['温度', v.temp.toFixed(2) + ' ℃']);
      rows.push(['pH', v.pH().toFixed(2)]);
      if (v.ionConc() > 1e-6) {
        rows.push(['离子浓度', v.ionConc().toFixed(4) + ' mol/L']);
        rows.push(['电导率', v.conductivity().toFixed(3) + ' S/m']);
        const R = v.resistance();
        rows.push(['溶液电阻', isFinite(R) ? fmtR(R) : '∞（不导电）']);
      }
      if (v.hasElectrodes()) {
        rows.push(['插入电极', v.electrodes.length + ' 根']);
        // electricCurrent 是**幅度**（耦合层另外写了带符号的 currentSigned，只给化学层定电解方向）。
        // 面板显示幅度是有意的：这一行问的是「通没通电、多大」，方向由电解产物自己说话；
        // 改成带符号值会让负半周显示成负读数，反而看不出「正在通电」。
        rows.push(['通过电流', fmtA(v.electricCurrent || 0)]);
      }
      if (v.stir > 0.02) rows.push(['搅拌强度', v.stir.toFixed(2)]);
      if (v.gas.size) {
        for (const [id, q] of v.gas) {
          rows.push([SP[id] ? SP[id].n : id, (q * 24000).toFixed(0) + ' mL']);
        }
      }
      if (v.precip.size) {
        for (const [id, g] of v.precip) {
          rows.push([SP[id] ? SP[id].n : id, g.toFixed(2) + ' g']);
        }
      }
      if (v.solid.size) {
        for (const [id, g] of v.solid) {
          rows.push([SP[id] ? SP[id].n : id, g.toFixed(2) + ' g']);
        }
      }
      if (v.lastReaction) rows.push(['最近反应', v.lastReaction.eq]);
    }

    // ── B3 铭牌补全（plans/10 §4 B3）：NB 灯泡面板给四行铭牌（额定电压/功率/电流/电阻），我方只给前两个**可调字段**。
    //    额定电阻有器材侧真源（Lamp.rHot() = ratedV²/ratedP，electrical.js:169）⇒ 直接消费；额定电流没有，
    //    只能面板按 P/V 派生（口径 额定；派生自两个真源声明 ⇒ 按 §6.2 规则③ 不进 stats）。
    if (e.props && e.props.ratedV > 0 && e.props.ratedP > 0) {
      const RV = e.props.ratedV, RP = e.props.ratedP;
      rows.push(['额定电阻 V²/P', fmtR(typeof e.rHot === 'function' ? e.rHot() : (RV * RV) / RP)]);
      rows.push(['额定电流 P/V', fmtA(RP / RV)]);
    }
    // ── B5「实时 / 瞬时」两行并存（plans/10 §4 B5 + plans/11 §3.5、§4.2.1）：这两个量在灯丝上是**并存量** ——
    //    实时 = 温度的函数（r20·(1+α(T−20))，器材每步缓存进 state.filamentR，electrical.js:233）；
    //    瞬时 = 电压的代数函数（改动前的冷/热两段拟合，e.resistanceAt(U)，electrical.js:159）。
    //    §4.2.1 明令：两列并排写、禁止合并；标签里须带「实时 / 瞬时」字样 ⇒ 两个标签都带。
    //    ⚠ 冻结行「等效电阻 R」（st.R）是**电路解里的那一个**（warm>0 时等于实时、warm=0 时等于瞬时@U=0），
    //    口径随 props 漂移 —— 不动它（四键是冻结合同行），这两行负责把口径写明白。
    if (typeof e.resistanceAt === 'function' && typeof e.resistanceNow === 'function') {
      const Rs = e.resistanceAt(typeof st.U === 'number' ? st.U : 0);
      const Rl = typeof st.filamentR === 'number' ? st.filamentR : e.resistanceNow();
      rows.push(['实时电阻 R(T)', fmtR(Rl)]);
      rows.push(['瞬时电阻 R(u)', fmtR(Rs)]);
    }
    // ── B2「瞬时 / 有效」两行并列（plans/10 §4 B2；只做电压，功率口径未证、电流无真源 ⇒ §4.12）。
    //    交流源面板早有「有效电压 U_rms=Up/√2」（代数量，§3.5 caliber 有效），缺的是**同一路的逐拍终端电压**
    //    （= rec.U = plans/11 §3.5 的「瞬时电压」）⇒ 补这一行与它成对（禁止合并）。
    //    未接线时不给幻影零：求解器对未接线支路照样写 U=0（circuit.js 只要求两个 wire 端口）⇒ 用 ⑧乙 的接线真源。
    if (e.type === 'acsource') {
      const wired = wiredPortsOf(this.app, e).size >= 2;
      rows.push(['瞬时电压 u(t)', wired && typeof st.U === 'number' ? fmtV(st.U) : SIGNED_NA]);
      // B2 的**电流**半边（T-03）：真源由 T-03a 补在器材侧（AcSource 的逐拍电流缓冲 + state.rmsI），
      //   面板只**消费**、不重推（plans/11 §4.12 的口径：器材自报，面板不另算一份）。
      //   与上面那行同路走**追加行**：四行现在是 u(t) / i(t) / U_rms / I_rms，**禁止合并**。
      //   ⚠ 未接线判据必须用**接线真源**（wiredPortsOf ≥ 2），不能拿 rmsI === 0 当"没接线"：
      //     实测未接线时 rmsI 是 MNA 的浮点残差（~1e-12，不是精确 0）⇒ 用零值判定会把"没接线"
      //     误判成"有读数"，于是上屏一个 4e-12 A 的幻影零。
      rows.push(['瞬时电流 i(t)', wired && typeof st.I === 'number' ? fmtA(st.I) : SIGNED_NA]);
      rows.push(['有效电流 I_rms', wired && typeof st.rmsI === 'number' ? fmtA(st.rmsI) : SIGNED_NA]);
    }
    // ── 测量仪表（C1：名义量程 + 示数）──
    //    为什么必须显式写：三件电表都是**电路支路**（circuitBranch()）⇒ 上面四键永远先凑出行 ⇒ 底下兜底
    //    （if (!rows.length)）对它们从不执行 ⇒ 器材侧写的 state.fullScale / state.reading 就算在 STATE_LABELS
    //    里加了表项，也一屏都不会出现。
    //    单位不在这儿重推：器材自己在 Meter.step() 里连同 fullScale/reading 一起写了 state.unit
    //    （get meterUnit()：A 档 'A'、V 档 'V'，多用电表跟着拨盘走）⇒ 面板只消费它。
    if (e.type === 'ammeter' || e.type === 'voltmeter' || e.type === 'multimeter') {
      const u = typeof st.unit === 'string' ? st.unit : '';
      if (u && typeof st.fullScale === 'number' && Number.isFinite(st.fullScale)) {
        rows.push(['名义量程', (+st.fullScale.toFixed(2)) + ' ' + u]);
      }
      // 「示数」只给多用电表：四键行同时给出 I 与 U，看不出一块表此刻在量哪一个 —— 这一行消掉这个歧义。
      // 电流表/电压表的四键行本身就是示数（同一真源、同一 fmtA/fmtV 文本）⇒ 再加一行是同值重复 ⇒ 不加。
      // 三种非读数状态用同一套占位口径：已烧毁（damage 清零）> 未接线（求解器幻影零）> 数值。
      if (e.type === 'multimeter') {
        if (st.broken) rows.push(['示数', BURNT_NA]);
        else if (wiredPortsOf(this.app, e).size < 2) rows.push(['示数', SIGNED_NA]);
        else if (typeof st.reading === 'number' && Number.isFinite(st.reading)) rows.push(['示数', u === 'A' ? fmtA(st.reading) : fmtV(st.reading)]);
      }
    }

    // ── 兜底：通用四键与 type 专属都没渲染出任何一行时，把数值型 state 键当实时读数 ──
    //    触发条件**只用 rows.length === 0**：现有器材要么走通用四键（I/U/P/R）、要么走
    //    type 专属、要么是容器（整块容器面板），都进不到这里，所以回归面收敛到零；
    //    而 T/E/MA/eta 这类键（力学/热学/光学）正好靠它第一次露出来。
    //    ⚠ 自 B4 起「器材自报的 stats 行」也算**渲染出行** ⇒ 声明了 stats 的器材不再落到兜底 ——
    //      这正是第 2 步能逐条搬走类型分支却保持逐字相同的原因（见上方 B4 块的位置说明）。
    if (!rows.length) {
      const fields = (e.def && e.def.fields) || [];
      const cat = (e.def && e.def.cat) || '';
      const hidden = STATE_HIDDEN[cat] || [];
      const known = [], rest = [];
      for (const [k, v] of Object.entries(st)) {
        if (k.charCodeAt(0) === 95) continue;                        // '_' 开头的内部键不露面
        if (typeof v !== 'number' || !Number.isFinite(v)) continue;  // 只收有限数字：NaN / ±∞ / 数组 / 对象 / 布尔都不收
        const fd = fields.find((x) => x.k === k);                    // 器材自己声明过就用它（不另造真值）
        if (!fd && hidden.indexOf(k) >= 0) continue;                 // 域级不展示名单（见 STATE_HIDDEN）；器材自己声明过就仍按它显示
        const lb = (STATE_LABELS[cat] && STATE_LABELS[cat][k]) || STATE_LABELS.通用[k];
        const lab = fd ? [fd.label, fd.unit || ''] : lb;
        (lab ? known : rest).push([lab ? lab[0] : k, fmtLive(v), lab ? lab[1] || '' : '']);
      }
      const all = known.concat(rest);                                // 认得出来的排前面，认不出的显示原始键名
      for (const [k, val, unit] of all) {
        if (rows.length >= LIVE_FALLBACK_MAX) {
          rows.push(['…', '还有 ' + (all.length - rows.length) + ' 项读数']);
          break;
        }
        rows.push([k, unit ? val + ' ' + unit : val]);
      }
    }

    if (!rows.length) rows.push(['状态', '无读数']);

    // 逐行入口：表驱动地给每一行配一个**取值闭包**（拿不到就 null ⇒ 那一行不摆入口）。
    // 放在这里而不是改每一处 rows.push：既有行的文本与顺序因此逐字不变。
    const picks = rows.map(([k]) => pickFor(e, k));

    const frag = document.createDocumentFragment();
    for (let i = 0; i < rows.length; i++) {
      frag.appendChild(h('div', 'k', rows[i][0]));
      frag.appendChild(this.pickable(rows[i][1], picks[i]));
    }
    this._live.replaceChildren(frag);
    this.updateSigned();      // 带符号区块是**另一个**元素，_live 的子节点因此逐字不变
    this.updatePosition();    // 空间位置同上：各自独立元素，互不改写对方的子节点
  }

  /**
   * 读数值元素。带入口的行**只改类名与 title**：
   *   · 不加子节点 —— 既有逐字判据按 `children[i] / children[i+1]` 成对读 textContent（inspector-probe §②），
   *     多一个子节点会让整块配对错位；
   *   · 不改文本 —— 同上，行文本是逐字冻结的。
   * 面板（app.data）不存在时**不标 pickable**：不摆点了没反应的入口。
   */
  pickable(text, pk) {
    const el = h('div', 'v', text);
    if (pk && this.dataSink()) {
      const key = this.pickKey(pk);
      const on = typeof this.app.data.has === 'function' && this.app.data.has(key);
      el.className = 'v pickable' + (on ? ' picked' : '');
      el.title = (on ? '已在曲线上：' : '点击添加到曲线：') + pk.label;
      this._picks.set(el, pk);
    }
    return el;
  }

  /** 一个「行 × 器材」唯一对应一路通道 ⇒ 重复点同一行是幂等的（换器材就是另一路） */
  pickKey(pk) { return this.ent ? 'pick:' + this.ent.id + ':' + pk.slug : ''; }

  dataSink() {
    return !!(this.app && this.app.data && typeof this.app.data.pick === 'function');
  }

  /**
   * 逐行入口的落点：点在某个读数值上 ⇒ 把**这一路**接到曲线上。
   *
   * 交出去的是 (key, label, unit, read 闭包)：read 每次采样现取，**不是点击那一刻的数值** ——
   * 存数值就会画出一条常量线（这正是不变量断言要抓的错法）。
   * 点在空白处 / 纯文本行上（没登记取值闭包）⇒ 静默返回 false，不弹任何东西。
   */
  pickRow(ev) {
    const el = ev && ev.target;
    const pk = el ? this._picks.get(el) : null;
    if (!pk || !this.ent) return false;
    const sink = this.app && this.app.data;
    if (!sink || typeof sink.pick !== 'function') return false;
    sink.pick({ key: this.pickKey(pk), label: pk.label, unit: pk.unit, read: pk.read });
    return true;
  }

  /**
   * 空间位置：只读 Entity 的 x / y / rot（弧度 → °）。
   *
   * 为什么先判 typeof + isFinite：这三个字段由拖拽与存档写回（interact.js:268 / loadJSON:120），
   * 旧存档或 DOM 替身里的实体可能根本没有它们 —— 不判就会把 undefined 渲染成 NaN
   * （与 updateSigned() 完全同一条范式）。占位文案与真 0 分开：0 是「就在原点/没转过」，
   * 占位是「这一路没有数据」。
   */
  updatePosition() {
    const el = this._pos;
    if (!el) return;
    const e = this.ent;
    const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
    const x = num(e && e.x), y = num(e && e.y), r = num(e && e.rot);
    const deg = r === null ? null : r * 180 / Math.PI;
    const pickX = { slug: 'pos.x', label: 'X 坐标', unit: 'px', read: () => num(e && e.x) === null ? NaN : e.x };
    const pickY = { slug: 'pos.y', label: 'Y 坐标', unit: 'px', read: () => num(e && e.y) === null ? NaN : e.y };
    const pickD = { slug: 'pos.deg', label: '旋转角', unit: '°', read: () => (num(e && e.rot) === null ? NaN : e.rot * 180 / Math.PI) };
    el.replaceChildren(
      h('div', 'k', 'X'), this.pickable(x === null ? POS_NA : x.toFixed(1) + ' px', x === null ? null : pickX),
      h('div', 'k', 'Y'), this.pickable(y === null ? POS_NA : y.toFixed(1) + ' px', y === null ? null : pickY),
      h('div', 'k', '旋转角'), this.pickable(deg === null ? POS_NA : deg.toFixed(1) + '°', deg === null ? null : pickD),
    );
  }

  /**
   * 瞬间读数（带符号）：与 updateLive() 分开的独立区块，只在对有电极的容器调用。
   *
   * 为什么先判 typeof：两路带符号量由耦合层每帧写入，vessel.js 里已与 electricCurrent 一起声明为 0，
   * 但旧存档 / 单测替身里的容器可能**没有**这两个字段（reactions.js:247 也为此保留了退回分支）——
   * 不判就会把 undefined 渲染成 NaN。
   * 「未接线」与「0」用不同文案区分：前者是"这一路没有数据"，后者是"读过，是 0"。
   */
  updateSigned() {
    const el = this._sig;
    if (!el) return;
    const v = this.ent && this.ent.vessel;
    if (!v) return;
    // 没插电极就没有回路，两路带符号量都是 0 —— 但"电路没接"与"接了没有电流"不是一回事，
    // 所以给一句占位文案而不是显示 0 A / 0 V。
    if (!v.hasElectrodes()) {
      el.replaceChildren(h('div', 'k', '瞬间读数'), h('div', 'v', '插入电极后出现'));
      return;
    }
    const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
    const I = num(v.currentSigned), U = num(v.currentU);
    const pickI = { slug: 'sig.I', label: '瞬间电流（带符号）', unit: 'A', read: () => num(v.currentSigned) === null ? NaN : v.currentSigned };
    const pickU = { slug: 'sig.U', label: '瞬间电压（带符号）', unit: 'V', read: () => num(v.currentU) === null ? NaN : v.currentU };
    el.replaceChildren(
      h('div', 'k', '瞬间电流（带符号）'),
      this.pickable(I === null ? SIGNED_NA : fmtA(I), I === null ? null : pickI),
      h('div', 'k', '瞬间电压（带符号）'),
      this.pickable(U === null ? SIGNED_NA : fmtV(U), U === null ? null : pickU),
    );
  }
}

// ── 小工具 ──

/**
 * 一行读数 → 「添加到曲线」的取值闭包（表驱动）。
 *
 * 为什么表驱动而不是改每一处 `rows.push`：那样既有行的文本与顺序都得逐个复核，回归面太大；
 * 这里一处都不动，只在行建好之后按标签配取值函数 ✓。
 * 表里没有的（纯文本行如「温度来源」「最近反应」，或算不出取值函数的行）返回 null ⇒ **不摆入口**
 * （不摆点了没反应的入口）。
 *
 * read() 返回**当时的**原始 SI 值（单位由 unit 给出；显示精度沿用数据面板既有的 fmtVal 口径），
 * 不是点击那一刻的快照 —— 存快照会画出一条常量线。
 */
function pickFor(e, label) {
  const st = e.state || {};
  const v = e.vessel;
  const n = (f) => () => { const x = f(); return typeof x === 'number' && Number.isFinite(x) ? x : NaN; };
  const T = (slug, unit, read) => ({ slug, unit, read, label });

  const fixed = {
    '电流 I': T('st.I', 'A', n(() => st.I)),
    '两端电压 U': T('st.U', 'V', n(() => st.U)),
    '功率 P': T('st.P', 'W', n(() => st.P)),
    '等效电阻 R': T('st.R', 'Ω', n(() => st.R)),
    '感知温度': T('st.temp', '℃', n(() => (st.temp === undefined ? 25 : st.temp))),
    '当前阻值': T('th.R', 'Ω', n(() => (e.resistanceNow ? e.resistanceNow() : st.R))),
    '转速': T('st.omega', 'rad/s', n(() => st.omega)),
    '秤上质量': T('st.mass', 'g', n(() => st.mass)),
    '测得 pH': T('st.pH', '', n(() => (st.pH === undefined ? 7 : st.pH))),
    '测得温度': T('st.temp', '℃', n(() => (st.temp === undefined ? 25 : st.temp))),
    '液体体积': T('v.volume', 'mL', n(() => v && v.volume)),
    '温度': T('v.temp', '℃', n(() => v && v.temp)),
    'pH': T('v.pH', '', n(() => v && v.pH())),
    '离子浓度': T('v.conc', 'mol/L', n(() => v && v.ionConc())),
    '电导率': T('v.k', 'S/m', n(() => v && v.conductivity())),
    '溶液电阻': T('v.R', 'Ω', n(() => v && v.resistance())),
    '插入电极': T('v.nE', '根', n(() => v && v.electrodes.length)),
    '搅拌强度': T('v.stir', '', n(() => v && v.stir)),
    // 幅度口径那一路：与「瞬间电流（带符号）」**并列**（各是各的口径，谁也不替谁）
    '通过电流': T('v.I', 'A', n(() => v && v.electricCurrent)),
  };
  if (fixed[label]) return fixed[label];

  // 容器里的物种量：标签就是物种名，取值必须**重新查 Map**（循环里那个 q 是采样时的快照）
  if (v) {
    for (const [arg, unit, k] of [['gas', 'mL', 24000], ['precip', 'g', 1], ['solid', 'g', 1]]) {
      const table = v[arg];
      if (!table || table.size === 0) continue;
      for (const id of table.keys()) {
        if ((SP[id] ? SP[id].n : id) !== label) continue;
        return T('v.' + arg + '.' + id, unit, n(() => (v[arg].get(id) || 0) * k));
      }
    }
  }

  // 兜底行的标签可能来自：器材自己声明的 fields ／ 域级标签表 ／ 原始键名
  const cat = (e.def && e.def.cat) || '';
  const fd = ((e.def && e.def.fields) || []).find((f) => f.label === label);
  if (fd && typeof st[fd.k] === 'number') return T('st.' + fd.k, fd.unit || '', n(() => st[fd.k]));
  for (const tbl of [STATE_LABELS[cat], STATE_LABELS.通用]) {
    if (!tbl) continue;
    for (const k of Object.keys(tbl)) {
      if (tbl[k] && tbl[k][0] === label && typeof st[k] === 'number') {
        return T('st.' + k, tbl[k][1] || '', n(() => st[k]));
      }
    }
  }
  if (typeof st[label] === 'number') return T('st.' + label, '', n(() => st[label]));
  return null;
}

function h(tag, cls, content) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (typeof content === 'string') n.textContent = content;
  else if (Array.isArray(content)) for (const c of content) n.appendChild(c);
  return n;
}
function btn(text, cls, fn) {
  const b = document.createElement('button');
  b.className = 'btn' + (cls ? ' ' + cls : '');
  b.textContent = text;
  b.addEventListener('click', fn);
  return b;
}
function domClass(d) { return d === 'physics' ? 'phys' : d === 'chemistry' ? 'chem' : 'bridge'; }
function fmtNum(v) {
  if (typeof v !== 'number') return String(v);
  return Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2);
}

/** 兜底读数的行数上限：超了就截断成一行「还有 N 项读数」，不把面板撑爆 */
export const LIVE_FALLBACK_MAX = 8;

/** 「瞬间读数」两路都拿不到数时的占位文案（与真 0 区分：0 会正常显示成 0 A / 0 V） */
export const BURNT_NA = '—（已烧毁）';

/** 四键行（电路解注入量）的标签 —— 烧毁器材整组撤下时按它筛（见 updateLive() 的 ⑧甲 段）。 */
export const FOUR_KEYS = new Set(['电流 I', '两端电压 U', '功率 P', '等效电阻 R']);

/**
 * 这块器材的哪些端口被导线占了（≥2 个才算接成一个回路）。
 *
 * 为什么必须是这个真源：circuit.js:71-78 收集支路只要求「器材有两个 wire 端口」，**不要求接线** ——
 * 所以一块没接线的表照样会被写入 I/U/P/R = 0。那是**幻影零**，不是「读到的值」；
 * 与 updateSigned() 里「未接线」/「0」用不同文案区分是同一个口径（inspector.js:501）。
 */
function wiredPortsOf(app, ent) {
  const ws = (app && app.world && app.world.wires) || [];
  const s = new Set();
  for (const w of ws) {
    if (!w || w.kind !== 'wire') continue;
    if (w.a && w.a.e === ent.id) s.add(w.a.p);
    if (w.b && w.b.e === ent.id) s.add(w.b.p);
  }
  return s;
}
export const SIGNED_NA = '—（未接线）';

/** 「空间位置」拿不到几何字段时的占位文案（与真 0 区分：0 是「就在原点 / 没转过」） */
export const POS_NA = '—（未定位）';

/**
 * state 键 → [中文标签, 单位]，按器材自身分组名（def.cat）取词：同一个键在不同域含义不同
 * （T 在力学是周期、在热学是温度）。**只收有把握的键**；没把握的不退到猜测，直接在面板上
 * 显示原始键名且不给单位 —— 宁可少写，不可写错。
 */
export const STATE_LABELS = {
  // ══ `力学` 表已退役（B4 第 3 步第 2 例，2026-10-17）═════════════════════════════════
  // 力学 8 件（小车 / 自由落体管 / 摩擦块 / 斜面 / 弹簧振子 / 单摆 / 滑轮组 / 杠杆）的读数
  // 现在全部由 `def.stats` **自报**。判据仍是**逐字相同**（`inspector-stats-probe` §⑥ 在跑过
  // step 的实体上证明未丢量 / 未改写 / 未变序；报告 §二十 / §二十一）。
  //
  // 与声学退役（§19.6）同一条纪律：**先解耦，再撤表**。此处解耦的条件④ b) 分支已经就位，
  // 唯二需要点名的两件事：
  //   ① `lever` 的 `I` 在本域是**转动惯量**（kg·m²），不是电流 —— 它是豁免条件④里**唯一**
  //      曾靠域表（分支 a）成立的那件器材。本表撤掉后 a) 对力学永久消失，`lever` 改由 b)
  //      （已声明 stats）承接；`§⑧` 的变异体也相应从「改本表 I 的定义」改造成「掐掉 stats 消费」，
  //      否则那条变异体会**失去靶点而悄悄失效**。
  //   ② 两处**有意的**行为变化：`pulley` 运行时 11 个数值键 > `LIVE_FALLBACK_MAX = 8`，
  //      旧路径截成 8 行 + `… 还有 3 项读数` 占位；`stats` 路径不受该上限约束 ⇒ 11 行全出
  //      （放出「效率 / 机械利益 / 提升次数」）。另 `springbob.tPrev` 被 `STATE_HIDDEN` 隐藏，
  //      两路径都不显示，口径未变。
  //
  // 原表备查（如需回滚，整段粘回 `力学:` 键即可）：
  //   t/v/s/a/x/h/T/E/E0/drift/p/th/theta/w/alpha/tau1/tau2/net/I/N/f/fsMax/
  //   weight/W/rope/maxv/n/need/eta/MA/collided/lifts
  // 「通用」表**必须保留**：各分类认不出的键都落到那里（见上方注释）。
  // ══ `热学` 表已退役（B4 第 3 步第 3 例，2026-10-17）═════════════════════════════════
  // 热学**真正读域表**的 4 件（加热板 / 热传导棒 / 沸腾装置 / 热膨胀球环）已由 `def.stats` 自报，
  // 判据仍是**逐字相同**（`inspector-stats-probe` §⑥ 在跑过 step 的实体上证明；报告 §二十五）。
  //
  // ⚠ 本分类**另有 2 件不在此列**：`calorimeter`（量热器）与 `icebath`（冰水浴）。
  //   它们走的是**器皿面板**（下方 `if (e.vessel)` 一带），那条路径在兜底之前就已 `rows.push`
  //   ⇒ `if (!rows.length)` 永不成立 ⇒ **从不读 `STATE_LABELS`**。
  //   实测证据：`calorimeter.state` 只有 `{Tf,T1,T2}`，面板却出「液体体积 / 温度 / pH」。
  //   **⇒ 给它们写 `stats` 是有害的**：`stats` 行在四键之后产生、器皿行更在后面，
  //     加了反而会让面板顺序变成「stats 在前、器皿在后」。故本表退役时**不动**这两件。
  //   （这正是「退役的充分条件是**用域表的件都自报了**」而非「分类里每件都自报了」的实例。）
  //
  // 原表备查（回滚时整段粘回 `热学:` 键即可）：
  //   t/Q/surf/heatOut/Tf/T1/T2/flux/fluxBar/mid/mIce/melted/Qlatent/waterT/steam/bp/d/dL/Tc
  //   ⚠ 其中 `Tf/T1/T2/mIce/melted/Qlatent` 只服务于上面那两件器皿（它们不读表），
  //     故这些条目本就没有消费者，退役无影响。
  // 「通用」表**必须保留**。
  // ══ `光学` 表已退役（B4 第 3 步第 4 例，2026-10-17）═════════════════════════════════
  // 光学**真正读域表**的 4 件（光源 / 平面镜 / 水槽 / 三棱镜）已由 `def.stats` 自报，
  // 逐字等价由 `inspector-stats-probe` §⑥ 在跑过 step 的实体上证明（报告 §二十六）。
  //
  // ⚠ 本分类**另有 2 件不在此列**：`convexlens`（凸透镜）与 `screen`（光屏）。
  //   它们早已由 `stats` 供行（另见其 `stats` 声明），从不落到兜底 ⇒ 退役本表对它们无影响。
  //   ⇒ 再次印证：退役的充分条件是「**用域表的件都自报了**」，不是「分类里每件都自报了」。
  //
  // 原表备查（回滚时整段粘回 `光学:` 键即可）：
  //   lambda:['波长','nm'] thetaI:['入射角','°'] thetaR:['反射角','°'] thetaT:['折射角','°']
  //   spread:['谱宽','°']   // 器材自己在画布上写的就是「谱宽 xx°」，面板沿用它的词
  //   ⚠ `hitX/hitY/n1/n2/valid` 从来就**不在**本表里（落 `通用` → 再落原始键名），
  //     其中 `n2` 的中文名「折射率 n₂」由器材 `fields` 提供。退役无影响。
  // 「通用」表**必须保留**。
  // ══ `电磁` 表已退役（B4 第 3 步**收官**，2026-10-17）══════════════════════════════
  // 电磁**真正读域表**的 5 件（条形磁铁 / 指南针 / 正负电荷 / 检验电荷 / 匀强电场）已由
  // `def.stats` 自报，逐字等价由 `inspector-stats-probe` §⑥ 在跑过 step 的实体上证明（报告 §二十七）。
  //
  // ⚠ 本分类**另有 1 件不在此列**：`bfield`（匀强磁场）。它两个 state 键都不是数字
  //   （`symbol` 是字符串、`outOfPage` 是布尔）⇒ 兜底一行也不产 ⇒ 面板显示「状态 · 无读数」，
  //   **从不读域表**，退役无影响。
  //
  // 原表备查（回滚时整段粘回 `电磁:` 键即可）：
  //   half:['磁极半距','px'] poleGap:['两极间距','px']
  //   needleDeg:['磁针指向','°'] srcCount:['场源数','个']
  //   deflection:['相对本体偏转','°'] srcDist:['最近磁体距离','px']
  //   sign:['带电符号',''] qAbs:['电量大小 |q|','µC'] lineCount:['方向箭头支数','支']
  //   nRegions:['所在场区数','个'] nCharges:['附近电荷数','个'] forceDeg:['受力方向','°']
  //   fieldDeg:['场向角','°']
  //   ⚠ `q`（电量）从来**不在**本表里 —— 它的中文名「电量 q」由 charge 的 `fields` 提供。
  //   ⚠ 只收兜底口径真读得到的键：对象型的 axis / poleN / poleS / dir / force、布尔与文案型的
  //     ambient / inField / fieldDefined / symbol / outOfPage 都到不了这张表。
  // 「通用」表**必须保留** —— 它是兜底链的第二级，任何分类表退役它都不动。
  //
  // ★★ 至此 `def.cat` 的**全部**分类表已退役，第 3 步完成：声学 4 + 力学 8 + 热学 4 + 光学 4 + 电磁 5
  //    = **25 件**由 `def.stats` 自报。
  // ══ `声学` 表已退役（B4 第 3 步首例，2026-10-17）═════════════════════════════════
  // 声学 4 件（音叉 / 共鸣管 / 分贝计 / 波形显示）的读数现在全部由 `def.stats` **自报**。
  // 退役判据不是「差不多」，而是**逐字相同**：`tools/inspector-stats-probe.mjs` §⑥ 在
  // **跑过 step 的实体**上（运行时真值）证明这些行未丢量、未改写、未变序（报告 §十九）。
  //
  // 撤这张表一度弄坏了两套探针 —— 不是它们写错了，而是本表当时**还被别处当作证据源**：
  // 「域盲四键退场」豁免的条件④拿本表**现查**「这个键在本域是否有别的物理义」
  // （`soundlevel` 的 `I`/`P` 在此是声强/声源功率，不是电流/功率）。所以退役是**分两步**做的：
  //   ① 先把那份证据迁到 `stats` 侧（豁免条件④增加分支 b)「该器材已声明 stats」）；
  //   ② 再撤本表。
  // ⚠ 次序不能颠倒 —— 详情与实测序列见报告 §19.5；`plans/11 §6.3` 也补记了这个额外前置。
  //
  // 两处**有意的**行为变化（不是回归）：
  //   ① `stats` 路径**不受** `LIVE_FALLBACK_MAX` 约束（下面兜底里的截断只管兜底）⇒
  //      读数超过 8 项的器材（分贝计 11 项、波形显示 10 项）现在显示**全部**读数，
  //      而不再被截成 8 行 + 一行 `… 还有 N 项读数` 占位；
  //   ② 因此退役**减少了**信息丢失 —— 原来被截掉的是真读数。
  //
  // 原表备查（如需回滚，整段粘回 `声学:` 键即可）：
  //   f1/f2/fbeat/Tbeat/df/dist/mateId/windowS/envPeriodMeas/raster ·
  //   f0/nUsed/rejected/v/lambda/T/vBack/amp/peak/dPeak/atResonance ·
  //   Lw/P/I/L/LAnalytic/dL/L2/drop/theory/rThresh/needle ·
  //   n/fMeas/fAuto/fCarrier/beat/fAutoUsable/fIn/dZc/dAc/pp/envX
  // 「通用」表**必须保留**：各分类认不出的键都落到那里（见上方注释）。
  // 通用只留「跨到哪个域都只有一个意思」的键。t / v / a / s / T / E 这类单字母键的含义随域而变
  // （光学里 v 是像距 mm：凸透镜的 -30.34 配上 u=22、f=80 正好满足 1/v = 1/f − 1/u），
  // 一律交给域表或原始键名 —— 宁可显示 v，不可写成「速度 m/s」。
  通用: { temp: ['温度', '℃'], mass: ['质量', 'g'], pH: ['pH', ''] },
};

/**
 * 域级「不展示」名单：内部记账值不是物理读数，不该出现在实时面板里。
 * 单独一张表而不是塞进 STATE_LABELS —— 那是「键 → 标签」的查找表，混进控制数据会让按 k 查表的行为变得不可预期。
 * 也不做成通用黑名单：同一个键名在别的域可能是真实读数（tPrev 只出现在力学的 step 里）。
 */
const STATE_HIDDEN = { 力学: ['tPrev'] };

/**
 * 自报统计量的取值格式化：`digits` 是**器材声明**的定点位数（plans/11 §6.2 的 `fmtBy(s.digits, …)`）。
 *
 * 为什么需要它：八处既有类型分支里有 `toFixed(1)` / `toFixed(2)` / `Math.round` 这类**定精度**行，
 * 而 `fmtLive` 按量级自动选精度 —— 直接迁到 stats 会改变文本，违反第 2 步「与迁移前逐字相同」的判据。
 * `digits` 缺省（非有限数）⇒ 落回 `fmtLive`，第 1 步的既有口径因此**不变**。
 * ⚠ 与 `Math.round` 的**唯一**边界差异：`(-0.5).toFixed(0)` 是 `'-1'`，而 `Math.round(-0.5)` 是 `-0`（`'0'`）。
 */
export function fmtBy(digits, v) {
  if (!Number.isFinite(digits)) return fmtLive(v);
  // digits === 0 走 `Math.round` 而不是 `toFixed(0)`：两者只在**负 .5** 边界不同
  // （`(-0.5).toFixed(0)` 是 '-1'，而 `Math.round(-0.5)` 是 -0 ⇒ `String(-0)` 得 '0'），
  // 而迁移来源（`motor` 转速那一行）用的正是 `Math.round(...)` —— 依它才能逐字相同。
  return digits === 0 ? String(Math.round(v)) : v.toFixed(digits);
}

/** 兜底读数按量级选精度：不出现 0.30000000000000004 这种尾巴 */
export function fmtLive(v) {
  const a = Math.abs(v);
  if (a >= 100) return v.toFixed(1);
  if (a >= 1) return v.toFixed(2);
  if (a > 0 && a < 1e-4) return v.toExponential(2);
  return v.toFixed(4);
}
