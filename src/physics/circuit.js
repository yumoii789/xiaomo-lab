// ══════════════════════════════════════════════════════════
// 电路求解器 —— 改进节点分析 (MNA) + 非线性定点迭代
//
// 它不认识"电池""灯泡""烧杯"，只认识端点与支路。
// 除了器材自带的支路，还接受「虚拟支路」(extra)：
//   · 溶液支路  —— 两根电极插在同一杯溶液里，电阻由离子浓度决定
//   · 原电池支路 —— 两种活泼性不同的金属插在电解液里产生电动势
// 物理与化学就是在这两个入口上焊在一起的。
// ══════════════════════════════════════════════════════════

class DSU {
  constructor() { this.p = new Map(); }
  find(x) {
    if (!this.p.has(x)) { this.p.set(x, x); return x; }
    let r = x;
    while (this.p.get(r) !== r) r = this.p.get(r);
    while (this.p.get(x) !== r) { const nx = this.p.get(x); this.p.set(x, r); x = nx; }
    return r;
  }
  union(a, b) { const ra = this.find(a), rb = this.find(b); if (ra !== rb) this.p.set(ra, rb); }
}

function gauss(A, z, n) {
  for (let col = 0; col < n; col++) {
    let piv = col, max = Math.abs(A[col][col]);
    for (let r = col + 1; r < n; r++) {
      const v = Math.abs(A[r][col]);
      if (v > max) { max = v; piv = r; }
    }
    if (max < 1e-12) return null;
    if (piv !== col) {
      const t = A[piv]; A[piv] = A[col]; A[col] = t;
      const s = z[piv]; z[piv] = z[col]; z[col] = s;
    }
    const d = A[col][col];
    for (let r = col + 1; r < n; r++) {
      const f = A[r][col] / d;
      if (!f) continue;
      for (let c = col; c < n; c++) A[r][c] -= f * A[col][c];
      z[r] -= f * z[col];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = z[r];
    for (let c = r + 1; c < n; c++) s -= A[r][c] * x[c];
    x[r] = s / A[r][r];
  }
  return x;
}

function emptyResult() {
  return {
    ok: false, closed: false, shorted: false,
    branches: new Map(), nodeV: new Map(),
    totalI: 0, maxI: 0, iterations: 0,
  };
}

/**
 * @param {World} world
 * @param {Array} extra 虚拟支路
 *        [{ key, a:{e,p}, b:{e,p}, type:'R'|'V'|'open', r, emf, state }]
 */
export function solveCircuit(world, extra = []) {
  const dsu = new DSU();

  // ── 1. 收集支路 ────────────────────────────────────────
  const list = [];
  for (const e of world.entities) {
    if (typeof e.circuitBranch !== 'function') continue;
    // 损坏的器材从电路里彻底消失 —— 烧断的灯丝、烧毁的表头都是开路
    if (e.state && e.state.broken) continue;
    if (!e.circuitBranch()) continue;
    const wp = [];
    for (let i = 0; i < e.ports.length; i++) if (e.ports[i].kind === 'wire') wp.push(i);
    if (wp.length < 2) continue;
    list.push({
      kind: 'real', ent: e,
      ka: e.id + ':' + wp[0], kb: e.id + ':' + wp[1],
      getBr: () => e.circuitBranch(),
    });
  }
  for (const x of extra) {
    if (!x || !x.a || !x.b) continue;
    list.push({
      kind: 'virtual', key: x.key, state: x.state || {},
      ka: x.a.e + ':' + x.a.p, kb: x.b.e + ':' + x.b.p,
      getBr: () => x,
    });
  }
  if (list.length === 0) return emptyResult();

  // ── 2. 导线把端点并成电学节点 ──────────────────────────
  for (const w of world.wires) {
    if (w.kind !== 'wire') continue;
    dsu.union(w.a.e + ':' + w.a.p, w.b.e + ':' + w.b.p);
  }

  // ── 3. 节点编号 ────────────────────────────────────────
  const nodeIdx = new Map();
  const roots = [];
  for (const b of list) {
    for (const k of [b.ka, b.kb]) {
      const r = dsu.find(k);
      if (!nodeIdx.has(r)) { nodeIdx.set(r, roots.length); roots.push(r); }
    }
  }
  if (roots.length < 2) return emptyResult();

  const n = roots.length - 1;                 // 参考节点(0)接地
  const rowOf = new Map();
  for (let i = 0; i < roots.length; i++) rowOf.set(roots[i], i === 0 ? -1 : i - 1);

  // ── 4. 电压源 ──────────────────────────────────────────
  const sources = [];
  for (const b of list) {
    const br = b.getBr();
    if (br && br.type === 'V') sources.push({ b, br, idx: sources.length });
  }
  const m = sources.length;
  const size = n + m;
  if (size <= 0) return emptyResult();

  // ── 5. 定点迭代求解 ────────────────────────────────────
  const prevU = new Map();
  const resOf = (b, u) => {
    if (b.kind === 'real' && typeof b.ent.resistanceAt === 'function') {
      return b.ent.resistanceAt(u, b.getBr());
    }
    const br = b.getBr();
    if (typeof br.resistanceAt === 'function') return br.resistanceAt(u);
    return br.r;
  };

  let x = null, iterations = 0;
  for (let iter = 0; iter < 26; iter++) {
    iterations = iter + 1;

    const A = Array.from({ length: size }, () => new Array(size).fill(0));
    const z = new Array(size).fill(0);

    for (const b of list) {
      const br = b.getBr();
      if (!br || br.type === 'V' || br.type === 'open') continue;
      let R = resOf(b, prevU.get(b.ka + b.kb) ?? 0);
      if (!(R > 0) || !isFinite(R)) R = 1e9;
      R = Math.max(1e-4, Math.min(R, 1e9));
      const G = 1 / R;
      const ia = rowOf.get(dsu.find(b.ka)), ib = rowOf.get(dsu.find(b.kb));
      if (ia >= 0) A[ia][ia] += G;
      if (ib >= 0) A[ib][ib] += G;
      if (ia >= 0 && ib >= 0) { A[ia][ib] -= G; A[ib][ia] -= G; }
    }

    for (const s of sources) {
      const ia = rowOf.get(dsu.find(s.b.ka)), ib = rowOf.get(dsu.find(s.b.kb));
      if (ia === ib) return { ...emptyResult(), shorted: true };
      const k = n + s.idx;
      if (ia >= 0) { A[ia][k] += 1; A[k][ia] += 1; }
      if (ib >= 0) { A[ib][k] -= 1; A[k][ib] -= 1; }
      z[k] = s.br.emf;
      const ri = s.br.r || 0;
      if (ri > 0) A[k][k] -= ri;
    }

    // 每个节点对地加一个极小电导（gmin）。
    // 没有它，一个完全悬空的子电路（例如两根没接线的电极之间的溶液）
    // 会让节点方程组秩亏，高斯消元直接失败。
    for (let i = 0; i < n; i++) A[i][i] += 1e-12;

    x = gauss(A, z, size);
    if (!x) return emptyResult();

    let maxDelta = 0;
    for (const b of list) {
      const ia = rowOf.get(dsu.find(b.ka)), ib = rowOf.get(dsu.find(b.kb));
      const u = (ia >= 0 ? x[ia] : 0) - (ib >= 0 ? x[ib] : 0);
      const key = b.ka + b.kb;
      maxDelta = Math.max(maxDelta, Math.abs(u - (prevU.get(key) ?? 0)));
      prevU.set(key, u);
    }
    if (iter > 1 && maxDelta < 1e-5) break;
  }
  if (!x) return emptyResult();

  // ── 6. 汇总 ────────────────────────────────────────────
  const nodeV = new Map();
  for (const [root, row] of rowOf) nodeV.set(root, row < 0 ? 0 : x[row]);

  const branches = new Map();
  let maxI = 0, totalI = 0;

  for (const b of list) {
    const br = b.getBr();
    const ia = rowOf.get(dsu.find(b.ka)), ib = rowOf.get(dsu.find(b.kb));
    const U = (ia >= 0 ? x[ia] : 0) - (ib >= 0 ? x[ib] : 0);

    let I = 0, R = Infinity;
    if (br.type === 'V') {
      const si = sources.find(s => s.b === b);
      I = si ? -x[n + si.idx] : 0;
      R = br.r || 0;
    } else if (br.type === 'open') {
      I = 0; R = Infinity;
    } else {
      R = Math.max(1e-4, resOf(b, U));
      I = U / R;
    }
    const P = Math.abs(U * I);
    const rec = { I, U, P, R, virtual: b.kind === 'virtual' };

    if (b.kind === 'real') {
      branches.set(b.ent.id, rec);
      Object.assign(b.ent.state, { I, U, P, R });
    } else {
      branches.set(b.key, rec);
      Object.assign(b.state, { I, U, P, R });
    }
    if (Math.abs(I) > maxI) maxI = Math.abs(I);
    totalI += Math.abs(I);
  }

  const closed = maxI > 1e-4;

  // 把电流写回导线，供渲染高亮
  for (const w of world.wires) {
    if (w.kind !== 'wire') continue;
    const rec = branches.get(w.a.e) || branches.get(w.b.e);
    w.state.current = rec ? rec.I : 0;
    w.state.live = closed;
  }

  return { ok: true, closed, shorted: false, branches, nodeV, totalI, maxI, iterations };
}

// ── 显示格式化 ─────────────────────────────────────────────
export function fmtA(I) {
  const a = Math.abs(I);
  if (a < 1e-9) return '0 A';
  if (a < 1e-3) return (I * 1e6).toFixed(1) + ' µA';
  if (a < 1) return (I * 1e3).toFixed(1) + ' mA';
  return I.toFixed(3) + ' A';
}
export function fmtV(U) {
  if (Math.abs(U) < 1e-9) return '0 V';
  return U.toFixed(Math.abs(U) < 1 ? 3 : 2) + ' V';
}
export function fmtW(P) {
  const a = Math.abs(P);
  if (a < 1e-9) return '0 W';
  if (a < 1e-3) return (P * 1e6).toFixed(0) + ' µW';
  if (a < 1) return (P * 1e3).toFixed(0) + ' mW';
  return P.toFixed(2) + ' W';
}
export function fmtR(R) {
  if (!isFinite(R)) return '∞';
  if (R >= 1e6) return (R / 1e6).toFixed(1) + ' MΩ';
  if (R >= 1e3) return (R / 1e3).toFixed(2) + ' kΩ';
  return R.toFixed(1) + ' Ω';
}

// ── 插件 ──────────────────────────────────────────────────
export default {
  id: 'xiaomo.core.physics',
  name: '电路求解器',
  version: '1.0.0',
  kind: 'core',
  desc: '改进节点分析（MNA）+ 非线性定点迭代；接受溶液与原电池作为虚拟支路接入',
  author: '小墨实验室',
  builtin: true,
  tags: ['物理', '电路', '内核'],
  setup(ctx) {
    ctx.app.services.solver = { solveCircuit, fmtA, fmtV, fmtW, fmtR };
  },
};
