const DEFS = [];
// ══════════════════════════════════════════════════════════
// 物理域 · 电磁学器材（6 件）
//
// 这一组器材的立身之本是：**画布上看得见的电磁学** —— 能被放置、被拖动、被选中，
// 并把几何关系与方向关系画出来。三条约定写在这里，全文件遵守：
//
//   ① **为什么只给方向、不给大小**（D44，别当成"没做完"）：
//      本 app 的模型里**没有场求解器** —— 没有泊松/拉普拉斯、没有磁路、没有有限元，
//      也没有任何一处算过场的强度。所以本文件导出的每一个场函数
//      **一律返回单位向量**，绝不产出「磁感应强度 B」「磁通量 Φ」「电场强度 E 的大小」
//      这类**我方模型里根本不存在的标量** —— 那些数字给了就是**编出来的**，
//      比没有更坏（学生会当真）。量值求解是另一条远期项（D3），等它落地时在这里接上。
//      ⇒ 下一个读这段代码的人：只给方向是**刻意的口径**，不是遗留的半成品。
//
//   ② 方向的来源都是课本里可复算的关系，不是「画得像」：
//      · 磁体：两磁极模型（N 极 +1、S 极 −1，各按 1/r² 贡献），取向量和再归一化；
//        远处自然退化成偶极子方向。测点落在磁极上、或贡献恰好抵消 → 返回 null，
//        **绝不返回一个兜底方向冒充结论**。
//      · 点电荷：单个正电荷 → 径向朝外，单个负电荷 → 径向朝里；多电荷严格按 q/r² 求和。
//      · 匀强场区：区域自身的场向由 `angle`（+x 起算）与 `flip` 给出；区域内多个场源叠加时，
//        **点电荷按 q/r² 严格求和**，匀强区各贡献一个等权单位向量 ——
//        「等权」是**本插件的声明**（大小不在本插件里），不是物理结论，故写在注释里而不是画在图上。
//      · 检验电荷：F = qE 的**方向**（sign(q)·E 方向）；q = 0 或没有外场 → null（不受力）。
//
//   ③ 画布与断言读的是**同一个函数**：磁体/电荷上那圈方向箭头就是 poleFieldDir() /
//      chargeFieldDir() 的采样。探针断言 rotation 等变性
//      （转源 + 转测点 = 转结果），于是「在局部坐标里画箭头」不是偷懒而是等价变换。
//
// 纯函数（poleWorld / poleFieldDir / fieldDirAt / needleDegAt / chargeFieldDir /
// uniformDir / testChargeForceDir / angleBetween / wrap180）全部 export，
// Node 里可以直接 import 断言，见 tools/electromagnets-visual.mjs。
// ══════════════════════════════════════════════════════════

import { Entity, gfx } from '../core/entity.js';
import { define } from './registry.js';

const PH = 'physics';
const CAT = '电磁';
const PANEL = '#242c34', EDGE = '#39434d', TXT = '#e6edf3', DIM = '#8d96a0', HOT = '#ffd166', OK = '#4ade80';
const NPOL = '#ef5350', SPOL = '#4d7fea';      // N 极红 / S 极蓝（课本惯例）
const FIELD = '#7fd4ff', PLATE = '#c9d3dd';

const D2R = Math.PI / 180, R2D = 180 / Math.PI;
export const rad = (d) => d * D2R;
export const deg = (r) => r * R2D;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/** 角度归一到 (−180, 180]：用于「偏转了多少度」这类差值断言 */
export function wrap180(a) {
  const x = ((a + 180) % 360 + 360) % 360 - 180;
  return x === -180 ? 180 : x;
}

/** 极角（度）→ 方向向量；0° = 画布 +x 方向。全部「给方向」的导出统一返回 {x, y} */
export function axisOf(angleDeg) {
  const a = rad(angleDeg || 0);
  return { x: Math.cos(a), y: Math.sin(a) };
}

/**
 * 从「纯参数对象」或「器材实体」里取同一个参数 —— 器材把可调参数放在 `props` 里，
 * 而场函数按 `{x, y, w, angle, flip}` 的纯形状描述。两种源都吃，于是：
 *   · Compass.step() 可以把 world.entities 直接递给 needleDegAt()；
 *   · 探针可以递一个纯对象，绕开注册表与宿主。
 * 少了这一层，`src.angle` 在实体上恒为 undefined ⇒ 磁体转了、场却没转（第一版就是这个缺陷）。
 */
function prop(src, k) {
  if (src.props && src.props[k] !== undefined) return src.props[k];
  return src[k];
}

/** 单位化；零向量（< eps）返回 null —— 方向无定义时**不造方向** */
export function unit(x, y, eps = 1e-12) {
  const L = Math.hypot(x, y);
  if (!(L > eps)) return null;
  return { x: x / L, y: y / L };
}

/** 两个方向之间的夹角（度，0..180）；任一为 null / 零向量 → NaN */
export function angleBetween(a, b) {
  const ua = unit(a && a.x, a && a.y), ub = unit(b && b.x, b && b.y);
  if (!ua || !ub) return NaN;
  return deg(Math.acos(clamp(ua.x * ub.x + ua.y * ub.y, -1, 1)));
}

// ══════════════════════════════════════════════════════════
// 一、方向场的纯函数（不碰渲染，探针直接 import 断言）
// ══════════════════════════════════════════════════════════

/**
 * 磁体的两极世界坐标。N 极在 +轴端，`flip` 把 N/S 对调 = 把磁体掉个头。
 * `src` 只要给出 {x, y, w, angle, flip} 即可（器材实体本身就满足）。
 */
export function poleWorld(src) {
  const { x: ux, y: uy } = axisOf(prop(src, 'angle'));
  const ins = prop(src, 'inset');
  const half = (src.w || 120) / 2 - (ins === undefined ? 5 : ins);
  const s = prop(src, 'flip') ? -1 : 1;
  const cx = src.x || 0, cy = src.y || 0;
  return {
    n: { x: cx + ux * half * s, y: cy + uy * half * s },
    s: { x: cx - ux * half * s, y: cy - uy * half * s },
    half,
  };
}

/**
 * 磁体在 (px, py) 处的**方向**：两磁极模型（N=+1、S=−1，各按 1/r²），
 * 向量和归一化。**只给方向** —— 见文件头 ①。
 * 测点落在某个磁极上（r² ≈ 0）→ null；两个磁极贡献恰好抵消 → null。
 */
export function poleFieldDir(src, px, py) {
  const P = poleWorld(src);
  let ex = 0, ey = 0;
  for (const [p, q] of [[P.n, 1], [P.s, -1]]) {
    const dx = px - p.x, dy = py - p.y;
    const r2 = dx * dx + dy * dy;
    if (r2 < 1e-9) return null;
    ex += q * dx / r2;
    ey += q * dy / r2;
  }
  return unit(ex, ey);
}

/**
 * 该点的合场向（多磁体叠加）。没有任何磁体贡献时退到环境场 `ambientDeg`
 * （默认 0° = 指北），并把 `ambient: true` 标出来 —— 让调用方知道这是环境场、不是磁体给的。
 */
export function fieldDirAt(sources, px, py, ambientDeg = 0) {
  let ex = 0, ey = 0, used = 0;
  for (const s of sources || []) {
    const d = poleFieldDir(s, px, py);
    if (!d) continue;
    ex += d.x; ey += d.y; used++;
  }
  const u = unit(ex, ey);
  if (!used || !u) {
    const a = axisOf(ambientDeg);
    return { x: a.x, y: a.y, ambient: true, sources: used };
  }
  return { x: u.x, y: u.y, ambient: false, sources: used };
}

/** 指南针针尖的指向（度，0..360）= 当地场向的极角 */
export function needleDegAt(sources, px, py, ambientDeg = 0) {
  const d = fieldDirAt(sources, px, py, ambientDeg);
  return { deg: (deg(Math.atan2(d.y, d.x)) + 360) % 360, ambient: d.ambient, sources: d.sources };
}

/**
 * 点电荷组的**方向**场：Σ q·(P−r)/r² 后归一化。**只给方向**。
 * 单个正电荷 → 径向朝外；单个负电荷 → 径向朝里；全部 q = 0（或没有电荷）→ null。
 */
export function chargeFieldDir(charges, px, py) {
  let ex = 0, ey = 0;
  for (const c of charges || []) {
    const q = c.q || 0;
    if (q === 0) continue;
    const dx = px - c.x, dy = py - c.y;
    const r2 = dx * dx + dy * dy;
    if (r2 < 1e-9) return null;          // 测点落在电荷上：方向无定义
    ex += q * dx / r2;
    ey += q * dy / r2;
  }
  return unit(ex, ey);
}

/** 匀强场区的场向：区域长边（+x）按 `angle` 旋转，`flip` 反向 */
export function uniformDir(angleDeg, flip) {
  const a = axisOf(angleDeg);
  const s = flip ? -1 : 1;
  return { x: a.x * s, y: a.y * s };
}

/**
 * 检验电荷所受电场力的**方向**：F = qE ⇒ 方向 = sign(q)·E 方向。
 * q = 0 或 E 方向无定义（无外场 / 恰好抵消）→ null：这时**不受力**，返回方向就是编。
 */
export function testChargeForceDir(q, ex, ey) {
  if (!(q !== 0)) return null;
  const u = unit(ex, ey);
  if (!u) return null;
  const s = q > 0 ? 1 : -1;
  return { x: s * u.x, y: s * u.y };
}

/**
 * 世界坐标 (px, py) 处的电场**矢量和**（未归一化）：
 *   · 点电荷：严格按 q/r² 求和（这是真正的叠加）；
 *   · 匀强场区（区域包含该点）：每个区域贡献一个等权单位向量 ——
 *     「等权」是本插件的声明（大小不在这里），理由写在文件头 ② 里。
 * 返回未归一化的 (ex, ey)；方向由调用方归一化（testChargeForceDir 会做）。
 */
export function fieldVectorAt(world, px, py) {
  let ex = 0, ey = 0;
  const inside = [];
  let nCharge = 0;
  const es = (world && world.entities) || [];
  for (const e of es) {
    if (e.type === 'efield' && e.hitTest(px, py)) {
      const d = uniformDir(e.props.angle, e.props.flip);
      ex += d.x; ey += d.y;
      inside.push(e.id);
    }
  }
  for (const c of es) {
    if (c.type !== 'charge') continue;
    const q = c.props.q || 0;
    if (q === 0) continue;
    const dx = px - c.x, dy = py - c.y;
    const r2 = dx * dx + dy * dy;
    if (r2 < 1e-9) continue;
    ex += q * dx / r2; ey += q * dy / r2;
    nCharge++;
  }
  return { ex, ey, inside, nCharge };
}

// ══════════════════════════════════════════════════════════
// 二、绘制小工具
// ══════════════════════════════════════════════════════════

/** 器材面板底纹 */
function panel(g, w, h, r = 6) {
  gfx.fillRR(g, -w / 2, -h / 2, w, h, r, PANEL);
  gfx.strokeRR(g, -w / 2, -h / 2, w, h, r, EDGE, 1.5);
}

/** 一支带箭头的短线：从 (x, y) 沿 (dx, dy) 方向画 len 长 */
function arrow(g, x, y, dx, dy, len, color, lw = 1.6) {
  const L = Math.hypot(dx, dy) || 1;
  const ux = dx / L, uy = dy / L;
  const x1 = x + ux * len, y1 = y + uy * len;
  const hw = Math.max(2.2, len * 0.3);
  g.save();
  g.strokeStyle = color; g.fillStyle = color; g.lineWidth = lw; g.lineCap = 'round';
  g.beginPath(); g.moveTo(x, y); g.lineTo(x1, y1); g.stroke();
  g.beginPath();
  g.moveTo(x1, y1);
  g.lineTo(x1 - ux * hw - uy * hw * 0.55, y1 - uy * hw + ux * hw * 0.55);
  g.lineTo(x1 - ux * hw + uy * hw * 0.55, y1 - uy * hw - ux * hw * 0.55);
  g.closePath(); g.fill();
  g.restore();
}

/** 虚线矩形（底面 + 边框），匀强场区的「区域」就是它 —— 与 hitTest 的矩形同形 */
function dashedBox(g, w, h, color) {
  g.save();
  g.setLineDash([6, 5]);
  gfx.fillRR(g, -w / 2, -h / 2, w, h, 4, 'rgba(127,212,255,.06)');
  gfx.strokeRR(g, -w / 2, -h / 2, w, h, 4, color, 1.3);
  g.restore();
}

// ─────────────────────────────────────────────────────────
// 1. 条形磁铁
// ─────────────────────────────────────────────────────────
class BarMagnet extends Entity {
  /** 局部坐标（angle = 0）下的方向场采样：画箭头用，与断言共用 poleFieldDir */
  fieldAt(px, py) {
    return poleFieldDir({ x: 0, y: 0, w: this.w, angle: 0, flip: this.props.flip }, px, py);
  }

  step() {
    const P = poleWorld(this);
    this.state.axis = axisOf(this.props.angle);
    this.state.poleN = P.n;
    this.state.poleS = P.s;
    this.state.half = P.half;
    this.state.poleGap = P.half * 2;      // 两极间距（px，1 px = 1 世界像素）
  }

  render(g) {
    const { w, h } = this;
    const sgn = this.props.flip ? -1 : 1;
    const half = w / 2;
    g.save();
    g.rotate(rad(this.props.angle));
    // 磁体本体：N 半红、S 半蓝（flip 时两半对调）
    gfx.fillRR(g, sgn > 0 ? 0 : -half, -h / 2, half, h, 3, NPOL);
    gfx.fillRR(g, sgn > 0 ? -half : 0, -h / 2, half, h, 3, SPOL);
    gfx.strokeRR(g, -half, -h / 2, w, h, 3, EDGE, 1.2);
    gfx.text(g, 'N', sgn * half * 0.5, 0, { color: '#ffffff', size: 14, weight: '700' });
    gfx.text(g, 'S', -sgn * half * 0.5, 0, { color: '#ffffff', size: 14, weight: '700' });

    // 方向场采样：一圈小箭头，方向来自 fieldAt()（= poleFieldDir 的局部等价形式）
    if (this.props.showField) {
      const gx = half + 30, gy = h / 2 + 26;
      for (let i = -2; i <= 2; i++) {
        for (let j = -1; j <= 1; j++) {
          if (i === 0 && j === 0) continue;              // 磁体内部不画
          const px = i * gx * 0.5, py = j * gy;
          const d = this.fieldAt(px, py);
          g.beginPath();
          g.arc(px, py, 1.6, 0, Math.PI * 2);
          g.fillStyle = 'rgba(127,212,255,.55)'; g.fill();
          if (d) arrow(g, px, py, d.x, d.y, 15, 'rgba(127,212,255,.85)', 1.3);
        }
      }
    }
    g.restore();

    const y0 = h / 2 + 26;
    gfx.text(g, `θ = ${this.props.angle}°${this.props.flip ? ' · N/S 已对调' : ''}`,
      0, y0, { color: TXT, size: 10 });
    gfx.text(g, `两极间距 ${((this.state.poleGap || 0)).toFixed(0)} px · 方向场只给方向`,
      0, y0 + 12, { color: DIM, size: 9 });
  }
}
const barDef = {
  type: 'barmagnet', name: '条形磁铁', domain: PH, cat: CAT, icon: '🧲',
  desc: '条形磁铁：N 极红 / S 极蓝，可整体旋转、可对调磁极；周围一圈箭头是两磁极方向场的采样',
  w: 130, h: 34,
  ports: [],
  defaults: { angle: 0, flip: false, showField: true },
  state: { axis: { x: 1, y: 0 }, poleN: { x: 0, y: 0 }, poleS: { x: 0, y: 0 }, half: 0, poleGap: 0 },
  tags: ['磁铁', '磁极', 'N极', 'S极', '方向场'],
  fields: [
    { k: 'angle', label: '摆放角', type: 'range', min: 0, max: 360, step: 5, unit: '°' },
    { k: 'flip', label: '磁极对调', type: 'checkbox', text: '对调 N / S（= 把磁铁掉个头）' },
    { k: 'showField', label: '方向采样', type: 'checkbox', text: '画一圈方向场箭头' },
  ],
  // ── B4 第 3 步 · 电磁：2 行 ──
  stats: [
    { label: '磁极半距', unit: 'px', read: (e) => e.state.half },
    { label: '两极间距', unit: 'px', read: (e) => e.state.poleGap },
  ],
  create: (x, y) => new BarMagnet(barDef, x, y),
};
DEFS.push(() => define(barDef));

// ─────────────────────────────────────────────────────────
// 2. 指南针（针尖指向 = 当地合场向）
// ─────────────────────────────────────────────────────────
class Compass extends Entity {
  step(dt, world) {
    const es = (world && world.entities) || [];
    const magnets = es.filter((e) => e.type === 'barmagnet');
    const r = needleDegAt(magnets, this.x, this.y, this.props.north);
    this.state.needleDeg = r.deg;
    this.state.ambient = r.ambient;
    this.state.srcCount = r.sources;
    this.state.deflection = wrap180(r.deg - this.props.bodyAngle);
    let best = null, bd = Infinity;
    for (const m of magnets) {
      const d = Math.hypot(m.x - this.x, m.y - this.y);
      if (d < bd) { bd = d; best = m; }
    }
    this.state.srcId = best ? best.id : null;
    this.state.srcDist = best ? bd : null;
  }

  render(g) {
    const { w, h } = this;
    const R = Math.min(w, h) / 2 - 2;
    // 刻度盘：随「本体方位角」转（盘转、针不跟着盘转）
    g.save();
    g.rotate(rad(this.props.bodyAngle) - this.rot);
    g.beginPath(); g.arc(0, 0, R, 0, Math.PI * 2);
    g.fillStyle = 'rgba(240,246,255,.10)'; g.fill();
    g.strokeStyle = EDGE; g.lineWidth = 1.6; g.stroke();
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      const r1 = R - (i % 6 === 0 ? 9 : 5), r2 = R - 1;
      g.beginPath();
      g.moveTo(Math.cos(a) * r1, Math.sin(a) * r1);
      g.lineTo(Math.cos(a) * r2, Math.sin(a) * r2);
      g.strokeStyle = i % 6 === 0 ? '#aab4be' : '#5d6874';
      g.lineWidth = i % 6 === 0 ? 1.6 : 1;
      g.stroke();
    }
    gfx.text(g, 'N', 0, -R + 13, { color: '#ef5350', size: 11, weight: '700' });
    gfx.text(g, 'S', 0, R - 13, { color: '#8d96a0', size: 11 });
    gfx.text(g, 'E', R - 12, 0, { color: DIM, size: 10 });
    gfx.text(g, 'W', -R + 12, 0, { color: DIM, size: 10 });
    g.restore();

    // 磁针：指向世界坐标里的 needleDeg（针不受本体方位角影响，只受场影响）
    const na = rad(this.state.needleDeg == null ? 0 : this.state.needleDeg) - this.rot;
    const nx = Math.cos(na), ny = Math.sin(na);
    g.save();
    g.beginPath();
    g.moveTo(nx * R * 0.78, ny * R * 0.78);
    g.lineTo(-ny * 5, nx * 5);
    g.lineTo(ny * 5, -nx * 5);
    g.closePath();
    g.fillStyle = '#ef5350'; g.fill();
    g.beginPath();
    g.moveTo(-nx * R * 0.78, -ny * R * 0.78);
    g.lineTo(-ny * 5, nx * 5);
    g.lineTo(ny * 5, -nx * 5);
    g.closePath();
    g.fillStyle = '#dfe6ee'; g.fill();
    g.beginPath(); g.arc(0, 0, 3.2, 0, Math.PI * 2); g.fillStyle = '#8d96a0'; g.fill();
    g.restore();

    const y0 = h / 2 + 12;
    gfx.text(g, `指向 ${(this.state.needleDeg || 0).toFixed(0)}° · 偏转 ${(this.state.deflection || 0).toFixed(0)}°`,
      0, y0, { color: this.state.ambient ? DIM : HOT, size: 10 });
    gfx.text(g, this.state.ambient
      ? `附近没有磁体：跟着环境场（${this.props.north}°）`
      : `受 ${this.state.srcCount} 个磁体影响 · 最近 ${(this.state.srcDist || 0).toFixed(0)} px`,
      0, y0 + 12, { color: DIM, size: 9 });
  }
}
const compassDef = {
  type: 'compass', name: '指南针', domain: PH, cat: CAT, icon: '🧭',
  desc: '指南针：磁针指向当地合场向（多个条形磁铁按方向叠加），可设本体方位与环境场（地磁）方向',
  w: 78, h: 78,
  ports: [],
  defaults: { bodyAngle: 0, north: 0 },
  state: { needleDeg: 0, ambient: true, srcCount: 0, deflection: 0, srcId: null, srcDist: null },
  tags: ['指南针', '磁针', '地磁', '方向'],
  fields: [
    { k: 'bodyAngle', label: '本体方位', type: 'range', min: 0, max: 360, step: 5, unit: '°' },
    { k: 'north', label: '环境场方向', type: 'range', min: 0, max: 360, step: 5, unit: '°' },
  ],
  // ── B4 第 3 步 · 电磁：4 行 ──
  stats: [
    { label: '磁针指向', unit: '°', read: (e) => e.state.needleDeg },
    { label: '场源数', unit: '个', read: (e) => e.state.srcCount },
    { label: '相对本体偏转', unit: '°', read: (e) => e.state.deflection },
    { label: '最近磁体距离', unit: 'px', read: (e) => e.state.srcDist },
  ],
  create: (x, y) => new Compass(compassDef, x, y),
};
DEFS.push(() => define(compassDef));

// ─────────────────────────────────────────────────────────
// 3. 正负电荷（一件器材，符号由 q 的符号给出）
// ─────────────────────────────────────────────────────────
class Charge extends Entity {
  step() {
    const q = this.props.q || 0;
    this.state.q = q;
    this.state.sign = q > 0 ? 1 : (q < 0 ? -1 : 0);
    this.state.qAbs = Math.abs(q);
    // 场的「指向」随测点变化，不存在一个常数角度 —— 真源不存在就不造字段（D44）
    this.state.fieldDefined = this.state.sign !== 0;
    this.state.lineCount = this.props.showField && this.state.sign !== 0 ? 8 : 0;
  }

  render(g) {
    const { w, h } = this;
    const R = Math.min(w, h) / 2 - 4;
    const s = this.state.sign || 0;
    const col = s > 0 ? NPOL : (s < 0 ? SPOL : '#6b7480');
    // 电场线方向采样：正电荷朝外、负电荷朝里（与断言共用 chargeFieldDir）
    if (this.props.showField && s !== 0) {
      const q = this.state.q || 0;
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        const px = Math.cos(a) * (R + 16), py = Math.sin(a) * (R + 16);
        const d = chargeFieldDir([{ x: 0, y: 0, q }], px, py);
        g.beginPath(); g.arc(px, py, 1.5, 0, Math.PI * 2);
        g.fillStyle = 'rgba(127,212,255,.5)'; g.fill();
        if (d) arrow(g, px, py, d.x, d.y, 14, 'rgba(127,212,255,.85)', 1.3);
      }
    }
    g.beginPath(); g.arc(0, 0, R, 0, Math.PI * 2);
    g.fillStyle = col; g.fill();
    g.strokeStyle = 'rgba(255,255,255,.35)'; g.lineWidth = 1.4; g.stroke();
    gfx.text(g, s > 0 ? '+' : (s < 0 ? '−' : '0'), 0, 0, { color: '#ffffff', size: 22, weight: '700' });

    const y0 = h / 2 + 12;
    gfx.text(g, `q = ${s === 0 ? '0' : (s > 0 ? '+' : '−') + this.state.qAbs.toFixed(1)} µC`,
      0, y0, { color: TXT, size: 10 });
    gfx.text(g, s === 0 ? '不带电：不产生电场' : (s > 0 ? '场向 = 径向朝外' : '场向 = 径向朝里'),
      0, y0 + 12, { color: DIM, size: 9 });
  }
}
const chargeDef = {
  type: 'charge', name: '正负电荷', domain: PH, cat: CAT, icon: '⚡',
  desc: '点电荷：q 取正为红（场向径向朝外）、取负为蓝（场向径向朝里）、取 0 为不带电（不产生电场）',
  w: 60, h: 60,
  ports: [],
  defaults: { q: 2, showField: true },
  state: { q: 2, sign: 1, qAbs: 2, fieldDefined: true, lineCount: 8 },
  tags: ['电荷', '正电荷', '负电荷', '电场线', '点电荷'],
  fields: [
    { k: 'q', label: '电量 q', type: 'range', min: -5, max: 5, step: 0.1, unit: 'µC' },
    { k: 'showField', label: '方向采样', type: 'checkbox', text: '画一圈电场方向箭头' },
  ],
  // ── B4 第 3 步 · 电磁：4 行 ──
  //    ⚠ 首行「电量 q」的标签**不来自域表**（电磁表里没有 `q`），由本器材 `fields` 提供；
  //      「带电符号」的 unit 是**空串**（`sign: ['带电符号','']`）⇒ 只写 label、不写 unit。
  stats: [
    { label: '电量 q', unit: 'µC', read: (e) => e.state.q },
    { label: '带电符号', read: (e) => e.state.sign },
    { label: '电量大小 |q|', unit: 'µC', read: (e) => e.state.qAbs },
    { label: '方向箭头支数', unit: '支', read: (e) => e.state.lineCount },
  ],
  create: (x, y) => new Charge(chargeDef, x, y),
};
DEFS.push(() => define(chargeDef));

// ─────────────────────────────────────────────────────────
// 4. 检验电荷（受力方向 = sign(q)·E 方向）
// ─────────────────────────────────────────────────────────
class TestCharge extends Entity {
  /** 纯计算：把 world 里的场源合成方向，再按 q 的符号给受力方向（探针直接调它） */
  solve(world) {
    const v = fieldVectorAt(world, this.x, this.y);
    const f = testChargeForceDir(this.props.q || 0, v.ex, v.ey);
    let reason = '';
    if (!f) {
      if (!(this.props.q !== 0)) reason = 'q = 0：不带电，不受电场力';
      else if (!v.inside.length && !v.nCharge) reason = '不在场区里、附近也没有电荷：E = 0，不受力';
      else reason = '合场向为零（多场源抵消）：不受力';
    }
    return { f, ...v, reason };
  }

  step(dt, world) {
    const s = this.solve(world);
    this.state.force = s.f;
    this.state.forceDeg = s.f ? (deg(Math.atan2(s.f.y, s.f.x)) + 360) % 360 : null;
    this.state.nRegions = s.inside.length;
    this.state.nCharges = s.nCharge;
    this.state.inField = s.inside.length > 0 || s.nCharge > 0;
    this.state.reason = s.reason;
  }

  render(g) {
    const { w, h } = this;
    const R = Math.min(w, h) / 2 - 3;
    const q = this.props.q || 0;
    const s = q > 0 ? 1 : (q < 0 ? -1 : 0);
    const col = s > 0 ? NPOL : (s < 0 ? SPOL : '#6b7480');
    g.beginPath(); g.arc(0, 0, R, 0, Math.PI * 2);
    g.fillStyle = col; g.fill();
    g.strokeStyle = 'rgba(255,255,255,.5)'; g.lineWidth = 1.2; g.stroke();
    gfx.text(g, s > 0 ? '+' : (s < 0 ? '−' : '0'), 0, 0, { color: '#ffffff', size: 15, weight: '700' });

    // 受力方向：世界方向换算回局部（画布已按 this.rot 旋转过）
    if (this.state.force) {
      const fa = Math.atan2(this.state.force.y, this.state.force.x) - this.rot;
      g.save();
      g.rotate(fa);
      arrow(g, R + 2, 0, 1, 0, 26, HOT, 2);
      g.restore();
      gfx.text(g, 'F', (R + 30) * Math.cos(fa), (R + 30) * Math.sin(fa),
        { color: HOT, size: 11, weight: '700' });
    }
    const y0 = h / 2 + 12;
    gfx.text(g, `q = ${s === 0 ? '0' : (s > 0 ? '+' : '−') + Math.abs(q).toFixed(1)} µC`,
      0, y0, { color: TXT, size: 10 });
    gfx.text(g, this.state.force ? `受力方向 ${(this.state.forceDeg).toFixed(0)}°` : (this.state.reason || '不受力'),
      0, y0 + 12, { color: this.state.force ? HOT : DIM, size: 9 });
  }
}
const testDef = {
  type: 'testcharge', name: '检验电荷', domain: PH, cat: CAT, icon: '🔴',
  desc: '检验电荷：放在匀强电场区里或电荷附近时，按 F = qE 给出受力方向（q = 0 或 E = 0 时不受力）',
  w: 30, h: 30,
  ports: [],
  defaults: { q: 1 },
  state: { force: null, forceDeg: null, nRegions: 0, nCharges: 0, inField: false, reason: '' },
  tags: ['检验电荷', '受力', '电场力', 'qE'],
  fields: [{ k: 'q', label: '电量 q', type: 'range', min: -5, max: 5, step: 0.1, unit: 'µC' }],
  // ── B4 第 3 步 · 电磁：3 行 ──
  stats: [
    { label: '受力方向', unit: '°', read: (e) => e.state.forceDeg },
    { label: '所在场区数', unit: '个', read: (e) => e.state.nRegions },
    { label: '附近电荷数', unit: '个', read: (e) => e.state.nCharges },
  ],
  create: (x, y) => new TestCharge(testDef, x, y),
};
DEFS.push(() => define(testDef));

// ─────────────────────────────────────────────────────────
// 5. 匀强电场区（平行板）
// ─────────────────────────────────────────────────────────
class UniformEField extends Entity {
  step() {
    const d = uniformDir(this.props.angle, this.props.flip);
    this.state.dir = d;
    this.state.fieldDeg = (deg(Math.atan2(d.y, d.x)) + 360) % 360;
  }

  render(g) {
    const { w, h } = this;
    dashedBox(g, w, h, 'rgba(127,212,255,.55)');
    const sgn = this.props.flip ? -1 : 1;
    const px = w * 0.42;
    g.save();
    g.rotate(rad(this.props.angle));
    if (this.props.showPlates) {
      gfx.fillRR(g, -px - 3, -h * 0.40, 6, h * 0.80, 2, PLATE);
      gfx.fillRR(g, px - 3, -h * 0.40, 6, h * 0.80, 2, PLATE);
    }
    const len = px * 2 - (this.props.showPlates ? 14 : 0);
    for (let i = 0; i < 4; i++) {
      const y = -h * 0.30 + i * (h * 0.60 / 3);
      const x0 = sgn > 0 ? -px + (this.props.showPlates ? 7 : 0) : px - (this.props.showPlates ? 7 : 0);
      arrow(g, x0, y, sgn, 0, len, FIELD, 1.7);
    }
    g.restore();
    gfx.text(g, '匀强电场', 0, -h / 2 + 13, { color: FIELD, size: 10 });
    gfx.text(g, `E 方向 ${(this.state.fieldDeg || 0).toFixed(0)}°（θ=${this.props.angle}°${this.props.flip ? ' · 反向' : ''}）`,
      0, h / 2 + 12, { color: DIM, size: 9 });
  }
}
const efieldDef = {
  type: 'efield', name: '匀强电场', domain: PH, cat: CAT, icon: '⬛',
  desc: '匀强电场区（平行板模型）：虚线框内场向一致，可整体转向、可反向；只给方向，不给场强大小',
  w: 170, h: 170,
  ports: [],
  defaults: { angle: 0, flip: false, showPlates: true },
  state: { dir: { x: 1, y: 0 }, fieldDeg: 0 },
  tags: ['匀强电场', '平行板', '电场', '区域'],
  fields: [
    { k: 'angle', label: '场向角 θ', type: 'range', min: 0, max: 360, step: 5, unit: '°' },
    { k: 'flip', label: '反向', type: 'checkbox', text: '场向反向 180°' },
    { k: 'showPlates', label: '极板', type: 'checkbox', text: '画两块极板' },
  ],
  // ── B4 第 3 步 · 电磁：1 行 ──
  //    ⚠ 同分类的 `bfield`（匀强磁场）**不在此列**：两个 state 键都不是数字
  //      （`symbol` 是字符串、`outOfPage` 是布尔）⇒ 兜底一行也不产 ⇒ 面板显示「状态 · 无读数」，
  //      它**从不读域表**，退役电磁表对它无影响（见 `inspector.js:774` 的说明）。
  stats: [{ label: '场向角', unit: '°', read: (e) => e.state.fieldDeg }],
  create: (x, y) => new UniformEField(efieldDef, x, y),
};
DEFS.push(() => define(efieldDef));

// ─────────────────────────────────────────────────────────
// 6. 匀强磁场区（× / · 符号区）
// ─────────────────────────────────────────────────────────
class UniformBField extends Entity {
  step() {
    this.state.symbol = this.props.dir === 'out' ? '·' : '×';
    this.state.outOfPage = this.props.dir === 'out';
  }

  render(g) {
    const { w, h } = this;
    dashedBox(g, w, h, 'rgba(140,180,255,.55)');
    const sp = Math.max(16, this.props.spacing);
    const cols = Math.max(2, Math.floor((w - 24) / sp));
    const rows = Math.max(2, Math.floor((h - 24) / sp));
    const x0 = -((cols - 1) * sp) / 2, y0 = -((rows - 1) * sp) / 2;
    const out = this.props.dir === 'out';
    for (let i = 0; i < cols; i++) {
      for (let j = 0; j < rows; j++) {
        const x = x0 + i * sp, y = y0 + j * sp;
        if (out) {
          g.beginPath(); g.arc(x, y, 3.4, 0, Math.PI * 2);
          g.fillStyle = 'rgba(150,190,255,.9)'; g.fill();
          g.beginPath(); g.arc(x, y, 1.2, 0, Math.PI * 2);
          g.fillStyle = '#101820'; g.fill();
        } else {
          g.save();
          g.strokeStyle = 'rgba(150,190,255,.9)'; g.lineWidth = 1.6; g.lineCap = 'round';
          g.beginPath(); g.moveTo(x - 4, y - 4); g.lineTo(x + 4, y + 4); g.stroke();
          g.beginPath(); g.moveTo(x + 4, y - 4); g.lineTo(x - 4, y + 4); g.stroke();
          g.restore();
        }
      }
    }
    gfx.text(g, '匀强磁场', 0, -h / 2 + 13, { color: '#9ec1ff', size: 10 });
    gfx.text(g, out ? '垂直纸面向外（·）' : '垂直纸面向里（×）', 0, h / 2 + 12, { color: DIM, size: 9 });
  }
}
const bfieldDef = {
  type: 'bfield', name: '匀强磁场', domain: PH, cat: CAT, icon: '⊞',
  desc: '匀强磁场区：用 ·（垂直纸面向外）或 ×（垂直纸面向里）铺满的虚线框区域；本插件只画区域与方向',
  w: 180, h: 150,
  ports: [],
  defaults: { dir: 'out', spacing: 26 },
  state: { symbol: '·', outOfPage: true },
  tags: ['匀强磁场', '磁场', '垂直纸面', '区域'],
  fields: [
    {
      k: 'dir', label: '磁场方向', type: 'select',
      options: [['out', '垂直纸面向外 ·'], ['into', '垂直纸面向里 ×']],
    },
    { k: 'spacing', label: '符号间距', type: 'range', min: 18, max: 60, step: 2, unit: 'px' },
  ],
  create: (x, y) => new UniformBField(bfieldDef, x, y),
};
DEFS.push(() => define(bfieldDef));

export { BarMagnet, Compass, Charge, TestCharge, UniformEField, UniformBField };

// ── 插件 ───────────────────────────────────────────────────
export default {
  id: 'xiaomo.equipment.electromagnets',
  name: '电磁器材',
  version: '1.0.0',
  kind: 'equipment',
  domain: PH,
  order: 36,
  desc: '电磁学 6 件：条形磁铁、指南针、正负电荷、检验电荷、匀强电场、匀强磁场；只画方向与几何，不做场量求解',
  author: '小墨实验室',
  builtin: true,
  tags: ['物理', '电磁', '磁体', '电场', '磁场', '器材'],
  setup(ctx) { ctx.scope('equipment', () => DEFS.forEach(f => f())); },
};
