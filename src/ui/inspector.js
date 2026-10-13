// ══════════════════════════════════════════════════════════
// UI · 属性检视器
// 左边是「可调参数」（来自器材定义的 fields），
// 右边是「实时读数」（电路解和化学状态）。
// ══════════════════════════════════════════════════════════

import { fmtA, fmtV, fmtW, fmtR } from '../physics/circuit.js';
import { SP } from '../chemistry/species.js';

export class Inspector {
  constructor(rootEl, app) {
    this.root = rootEl;
    this.app = app;
    this.ent = null;
    this._live = null;
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
    frag.appendChild(this._live);

    // ── 操作 ──
    const btns = h('div', 'btns');
    if (e.type === 'switch') {
      btns.appendChild(btn('切换通断', 'acc', () => {
        e.toggle(); this.render(); this.app.markDirty();
      }));
    }
    if (e.flame) {
      btns.appendChild(btn(e.props.lit ? '熄灭酒精灯' : '点燃酒精灯', 'chem', () => {
        e.props.lit = !e.props.lit; this.render(); this.app.markDirty();
      }));
    }
    if (e.vessel) {
      btns.appendChild(btn('倒空容器', '', () => {
        e.vessel.empty(); this.render(); this.app.markDirty();
      }));
    }
    btns.appendChild(btn('复制', '', () => this.app.duplicate(e)));
    btns.appendChild(btn('删除', 'dgr', () => this.app.removeEntity(e)));
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

    if (typeof st.I === 'number') rows.push(['电流 I', fmtA(st.I)]);
    if (typeof st.U === 'number') rows.push(['两端电压 U', fmtV(st.U)]);
    if (typeof st.P === 'number' && st.P > 1e-9) rows.push(['功率 P', fmtW(st.P)]);
    if (typeof st.R === 'number') rows.push(['等效电阻 R', fmtR(st.R)]);

    if (e.type === 'thermistor') {
      rows.push(['感知温度', (st.temp ?? 25).toFixed(1) + ' ℃']);
      rows.push(['温度来源', st.source || '室温']);
      const R = e.resistanceNow ? e.resistanceNow() : st.R;
      rows.push(['当前阻值', fmtR(R)]);
    }
    if (e.type === 'motor') {
      rows.push(['运转状态', st.on ? '转动中' : '停止']);
      rows.push(['转速', Math.round(st.omega || 0) + ' rad/s']);
    }
    if (e.type === 'balance') {
      rows.push(['秤上质量', (st.mass || 0).toFixed(2) + ' g']);
      if (st.onPlate) rows.push(['称量对象', st.onPlate]);
    }
    if (e.type === 'phmeter') rows.push(['测得 pH', (st.pH ?? 7).toFixed(2)]);
    if (e.type === 'phpaper') rows.push(['测得 pH', st.pH === undefined ? '未浸取' : st.pH.toFixed(1)]);
    if (e.type === 'thermometer') rows.push(['测得温度', (st.temp ?? 25).toFixed(2) + ' ℃']);
    if (e.type === 'alcohollamp') {
      rows.push(['状态', e.props.lit ? '燃烧中' : '未点燃']);
      if (st.target) rows.push(['加热对象', this.app.world.get(st.target)?.def.name || '-']);
    }
    if (e.type === 'electrode') {
      const m = e.props.metal;
      rows.push(['电极材料', m === 'graphite' ? '石墨（惰性）' : m]);
      rows.push(['标准电极电势', e.probe && e.probe.E0 !== null && e.probe.E0 !== undefined
        ? (e.probe.E0 > 0 ? '+' : '') + e.probe.E0.toFixed(2) + ' V' : '不参与原电池']);
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

    if (!rows.length) rows.push(['状态', '无读数']);

    const frag = document.createDocumentFragment();
    for (const [k, v] of rows) {
      frag.appendChild(h('div', 'k', k));
      frag.appendChild(h('div', 'v', v));
    }
    this._live.replaceChildren(frag);
  }
}

// ── 小工具 ──
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
