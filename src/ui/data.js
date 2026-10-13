// ══════════════════════════════════════════════════════════
// UI · 数据面板
// 自动发现实验台上"可测量"的量，做时间序列并画迷你曲线。
// 采样 10 Hz，保留最近 90 秒。
// ══════════════════════════════════════════════════════════

import { fmtR } from '../physics/circuit.js';

const SAMPLE_DT = 0.1;
const KEEP = 900;          // 90 秒
const CARD_LIMIT = 8;

export class DataPanel {
  constructor(el, app) {
    this.el = el;
    this.app = app;
    this.channels = new Map();   // key -> {label, unit, color, data:[], min, max}
    this.acc = 0;
    this.cards = new Map();
    this._builtFor = '';
    this._empty = true;
    this.el.replaceChildren(blank());
  }

  step(dt) {
    this.acc += dt;
    if (this.acc < SAMPLE_DT) return;
    this.acc = 0;
    this.sample();
    this.draw();
  }

  // ── 采集 ──
  sample() {
    const world = this.app.world;
    for (const e of world.entities) {
      const st = e.state || {};
      if (typeof st.I === 'number' && e.type === 'ammeter') {
        this.push('I:' + e.id, e.def.name, 'A', '#2dd4bf', st.I);
      }
      if (typeof st.U === 'number' && e.type === 'voltmeter') {
        this.push('U:' + e.id, e.def.name, 'V', '#8b5cf6', st.U);
      }
      if (e.type === 'thermistor') {
        this.push('R:' + e.id, '热敏电阻阻值', 'Ω', '#f0a020', e.resistanceNow ? e.resistanceNow() : st.R);
        this.push('T:' + e.id, '热敏电阻温度', '℃', '#ff7a5c', st.temp ?? 25);
      }
      if (e.type === 'thermometer') {
        this.push('TM:' + e.id, '温度计读数', '℃', '#ff9d7a', st.temp ?? 25);
      }
      if (e.vessel) {
        this.push('VT:' + e.id, e.def.name + ' 温度', '℃', '#ff7a5c', e.vessel.temp);
        this.push('VP:' + e.id, e.def.name + ' pH', '', '#6ba8ff', e.vessel.pH());
        if (e.vessel.gas.size) {
          this.push('VG:' + e.id, e.def.name + ' 气体', 'mL', '#a78bfa', e.vessel.gasTotal() * 24000);
        }
        if (e.vessel.volume > 0 && e.vessel.ionConc() > 1e-6) {
          const R = e.vessel.resistance();
          this.push('VR:' + e.id, e.def.name + ' 溶液电阻', 'Ω', '#4ade80', isFinite(R) ? R : 1e7);
        }
      }
      if (e.type === 'balance' && (st.mass || 0) > 0) {
        this.push('M:' + e.id, '天平示数', 'g', '#7fe8d8', st.mass);
      }
      if (e.type === 'phmeter') {
        this.push('PH:' + e.id, 'pH 计读数', '', '#6ba8ff', st.pH ?? 7);
      }
    }
    // 裁剪长度
    for (const ch of this.channels.values()) {
      while (ch.data.length > KEEP) ch.data.shift();
    }
  }

  push(key, label, unit, color, v) {
    let ch = this.channels.get(key);
    if (!ch) {
      ch = { label, unit, color, data: [], min: Infinity, max: -Infinity };
      this.channels.set(key, ch);
    }
    if (!isFinite(v)) v = 0;
    ch.data.push(v);
    if (v < ch.min) ch.min = v;
    if (v > ch.max) ch.max = v;
  }

  hasData() { return this.channels.size > 0; }

  // ── 绘制 ──
  draw() {
    if (this.channels.size === 0) {
      if (!this._empty) { this.el.replaceChildren(blank()); this._empty = true; this.cards.clear(); }
      return;
    }
    const keys = [...this.channels.keys()].slice(0, CARD_LIMIT);
    const sig = keys.join('|');
    if (sig !== this._builtFor) {
      this.rebuild(keys);
      this._builtFor = sig;
    }
    for (const k of keys) {
      const ch = this.channels.get(k);
      const card = this.cards.get(k);
      if (!card) continue;
      card.num.textContent = fmtVal(ch.data[ch.data.length - 1]) + (ch.unit ? ' ' + ch.unit : '');
      drawSpark(card.cv, ch);
    }
    if (this.channels.size > CARD_LIMIT && !this._more) {
      this._more = document.createElement('div');
      this._more.className = 'blank-s';
      this._more.style.textAlign = 'center';
      this._more.textContent = `还有 ${this.channels.size - CARD_LIMIT} 个通道未显示`;
      this.el.appendChild(this._more);
    }
  }

  rebuild(keys) {
    this._empty = false;
    this._more = null;
    const frag = document.createDocumentFragment();
    this.cards.clear();

    for (const k of keys) {
      const ch = this.channels.get(k);
      const card = document.createElement('div');
      card.className = 'dcard';

      const dh = document.createElement('div');
      dh.className = 'dh';
      const b = document.createElement('b');
      b.textContent = ch.label;
      dh.appendChild(b);
      if (ch.unit) { const u = document.createElement('span'); u.className = 'u'; u.textContent = ch.unit; dh.appendChild(u); }
      const num = document.createElement('span');
      num.className = 'num';
      dh.appendChild(num);
      card.appendChild(dh);

      const cv = document.createElement('canvas');
      card.appendChild(cv);

      frag.appendChild(card);
      this.cards.set(k, { cv, num, ch });
    }
    this.el.replaceChildren(frag);
    // canvas 需要等布局完成后再设尺寸
    requestAnimationFrame(() => {
      for (const { cv } of this.cards.values()) fitCanvas(cv);
    });
  }

  clear() {
    this.channels.clear();
    this.cards.clear();
    this._builtFor = '';
    this._empty = true;
    this._more = null;
    this.el.replaceChildren(blank());
  }
}

function blank() {
  const d = document.createElement('div');
  d.className = 'blank';
  d.innerHTML = '<div class="blank-t">暂无数据</div>'
    + '<div class="blank-s">接入电流表、电压表、温度计或天平<br>测量值会实时记录在这里</div>';
  return d;
}

function fitCanvas(cv) {
  const r = cv.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  if (r.width < 2) return;
  cv.width = Math.round(r.width * dpr);
  cv.height = Math.round(r.height * dpr);
}

function drawSpark(cv, ch) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  if (!cv.width) fitCanvas(cv);
  const g = cv.getContext('2d');
  const W = cv.width / dpr, H = cv.height / dpr;
  if (W < 2) return;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);

  const d = ch.data;
  if (d.length < 2) return;

  let lo = Infinity, hi = -Infinity;
  for (const v of d) { if (v < lo) lo = v; if (v > hi) hi = v; }
  if (!isFinite(lo)) return;
  if (hi - lo < 1e-9) { hi = lo + Math.max(1e-6, Math.abs(lo) * 0.1 + 0.5); lo -= (hi - lo) * 0.5; }
  const pad = (hi - lo) * 0.12;
  lo -= pad; hi += pad;

  const n = d.length;
  const x = (i) => (i / (n - 1)) * W;
  const y = (v) => H - ((v - lo) / (hi - lo)) * H;

  // 网格线
  g.strokeStyle = 'rgba(255,255,255,.05)';
  g.lineWidth = 1;
  for (let i = 1; i < 3; i++) {
    const yy = (H * i / 3) + .5;
    g.beginPath(); g.moveTo(0, yy); g.lineTo(W, yy); g.stroke();
  }

  // 面积
  g.beginPath();
  g.moveTo(0, H);
  for (let i = 0; i < n; i++) g.lineTo(x(i), y(d[i]));
  g.lineTo(W, H);
  g.closePath();
  const grd = g.createLinearGradient(0, 0, 0, H);
  grd.addColorStop(0, hexA(ch.color, 0.28));
  grd.addColorStop(1, hexA(ch.color, 0));
  g.fillStyle = grd;
  g.fill();

  // 曲线
  g.beginPath();
  for (let i = 0; i < n; i++) {
    const xx = x(i), yy = y(d[i]);
    i === 0 ? g.moveTo(xx, yy) : g.lineTo(xx, yy);
  }
  g.strokeStyle = ch.color;
  g.lineWidth = 1.6;
  g.lineJoin = 'round';
  g.stroke();
}

function hexA(hex, a) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function fmtVal(v) {
  if (v === undefined || v === null || !isFinite(v)) return '--';
  const a = Math.abs(v);
  if (a === 0) return '0';
  if (a >= 1e6) return (v / 1e6).toFixed(2) + 'M';
  if (a >= 1000) return v.toFixed(0);
  if (a >= 100) return v.toFixed(1);
  if (a >= 1) return v.toFixed(2);
  if (a >= 0.01) return v.toFixed(3);
  return v.toExponential(1);
}
