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

/** 解不出来时也要说清是哪一步解不出来：ok:false 不再是一个无信息的黑洞 */
function emptyResult(reason) {
  return {
    ok: false, closed: false, shorted: false, reason: reason || 'unknown',
    branches: new Map(), nodeV: new Map(),
    totalI: 0, maxI: 0, iterations: 0, warnings: [],
  };
}

/**
 * 一次性告警：**同一种器材只喊一次**。
 * solveCircuit 每帧都跑（1/120 s），逐帧 console 会把控制台变成噪音 —— 而噪音等于没有告警。
 */
const warnedOnce = new Set();
function warnOnce(key, msg) {
  if (warnedOnce.has(key)) return;
  warnedOnce.add(key);
  console.warn('[circuit] ⚠ ' + msg);
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
  const warnings = [];   // 显式记账：被忽略的东西不许无声无息地消失
  for (const e of world.entities) {
    if (typeof e.circuitBranch !== 'function') continue;
    // 损坏的器材从电路里彻底消失 —— 烧断的灯丝、烧毁的表头都是开路
    if (e.state && e.state.broken) continue;
    const wp = [];
    for (let i = 0; i < e.ports.length; i++) if (e.ports[i].kind === 'wire') wp.push(i);
    if (wp.length < 2) continue;
    const wired = (i) => world.wires.some((w) => w.kind === 'wire'
      && ((w.a.e === e.id && w.a.p === i) || (w.b.e === e.id && w.b.p === i)));

    // ── 一器材多支路：契约 circuitBranches(world) ──────────────
    // 器材可以声明 N 条支路，每条自带端口对 { a, b }（e.ports 的下标，必须指向 kind:'wire' 口）；
    // 省略 a/b 时：第 1 条用前两个 wire 口（= 旧的单支路行为），第 k 条用 wp[k]/wp[k+1]。
    // 返回 null / [] / 非数组 ⇒ 回落到 circuitBranch()，既有器材一行都不用改。
    //
    // ⚠ 一趟 solve 里只取一次（下面的 arr 常驻），于是 emf/r **结构上**就是常量：
    //   Motor 那条注释（"同一次 solve 里 emf 必须是常量，否则源电压与源电流互为因果，
    //   定点迭代会去追一个不存在的解"）从注释变成了保证。多支路共享一个器材状态时，
    //   跨支路耦合只能读**上一帧**写下的 state，不能读本次迭代的中间量 ——
    //   那会造出迭代内代数环，收敛性没有定义（三极管/运放那道门槛就卡在这里）。
    let defs = null;
    if (typeof e.circuitBranches === 'function') {
      const arr = e.circuitBranches(world);
      if (Array.isArray(arr) && arr.length) defs = arr;
    }
    if (!defs) defs = [e.circuitBranch()];
    if (!defs[0]) continue;                    // 冷态/断路器材照旧整件跳过

    const used = new Set();                    // 被任何一条已声明支路用到的 wire 口
    const resolved = [];
    for (let k = 0; k < defs.length; k++) {
      const br = defs[k];
      if (!br) continue;
      let ia = Number.isInteger(br.a) ? br.a : null;
      let ib = Number.isInteger(br.b) ? br.b : null;
      if (ia === null || ib === null) {
        if (k === 0) { ia = wp[0]; ib = wp[1]; }
        else if (wp.length > k + 1) { ia = wp[k]; ib = wp[k + 1]; }
      }
      const okPort = (i) => Number.isInteger(i) && i >= 0 && i < e.ports.length && e.ports[i].kind === 'wire';
      if (!okPort(ia) || !okPort(ib)) {
        warnings.push({
          code: 'branch-port-bad', entId: e.id, type: e.type, ports: [ia, ib],
          msg: `${e.type}：第 ${k + 1} 条支路的端口对 ${ia}/${ib} 不是合法的 wire 口 —— 该支路被跳过`,
        });
        continue;
      }
      used.add(ia); used.add(ib);
      resolved.push({ br, ia, ib, k });
    }
    if (!resolved.length) continue;

    // ⚠ 仍然会被忽略的端口：**真的接了线**、却不属于任何一条已声明支路。
    //   三端器件当两端用（电位器当变阻器）是合法用法 ⇒ 判据是"接线了没有"，不是"声明了几个口"；
    //   声明了多条支路的三端件只要把那根线接进某条支路，就自然不再告警。
    const orphan = wp.filter((i) => wired(i) && !used.has(i));
    if (orphan.length) {
      const labels = orphan.map((i) => e.ports[i].label || ('#' + (i + 1))).join('/');
      const w0 = {
        code: 'port-ignored', entId: e.id, type: e.type, ports: orphan,
        msg: `${e.type}：接线柱 ${labels} 接了线却被忽略 —— 它不属于该器材声明的任何一条支路`,
      };
      warnings.push(w0);
      warnOnce(e.type, w0.msg);
    }

    for (const r of resolved) {
      list.push({
        kind: 'real', ent: e, bi: r.k, br: r.br,
        ka: e.id + ':' + r.ia, kb: e.id + ':' + r.ib,
        getBr: () => r.br,
      });
    }
  }
  for (const x of extra) {
    if (!x || !x.a || !x.b) continue;
    list.push({
      kind: 'virtual', key: x.key, state: x.state || {},
      ka: x.a.e + ':' + x.a.p, kb: x.b.e + ':' + x.b.p,
      getBr: () => x,
    });
  }
  if (list.length === 0) return emptyResult('no-branch');

  // ── 2. 导线把端点并成电学节点 ──────────────────────────
  for (const w of world.wires) {
    if (w.kind !== 'wire') continue;
    dsu.union(w.a.e + ':' + w.a.p, w.b.e + ':' + w.b.p);
  }

  // ── 2b. 电学连通分量：每个分量各自接地 ──────────────────
  // 只认「会导电的支路」把两边连起来：open 本来就是断路，不该把两边算成一个分量。
  //
  // 为什么必须按分量接地：整张矩阵只挑**一个**全局参考节点时，一个完全悬空的子电路
  // （例如并排摆着、没有任何导线相连的第二个回路）内部只有 1e-12 的 gmin 撑着，
  // 消元到那一块的枢轴会掉到 1e-12 量级 → 被 gauss 的 `max < 1e-12` 判成秩亏 →
  // 整张结果变成 ok:false，**所有**实体的 U/I 静默变 undefined（用户只看到读数全空）。
  // 物理上每个分量的电位本来就只确定到一个任意常数，各自选一个参考节点即可；
  // 等价于「按分量分别求解」，但矩阵仍是同一张，不用把组装逻辑拆成两条路。
  const comp = new DSU();
  for (const b of list) {
    const br = b.getBr();
    if (!br || br.type === 'open') continue;
    comp.union(dsu.find(b.ka), dsu.find(b.kb));
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
  if (roots.length < 2) return emptyResult('too-few-nodes');

  const rowOf = new Map();
  const refOf = new Set();                    // 每个连通分量选一个参考节点接地
  let n = 0;                                  // 未知量 = 非参考节点的节点数
  for (const r of roots) {
    const cr = comp.find(r);
    if (!refOf.has(cr)) { refOf.add(cr); rowOf.set(r, -1); continue; }
    rowOf.set(r, n++);
  }

  // ── 4. 电压源 ──────────────────────────────────────────
  const sources = [];
  for (const b of list) {
    const br = b.getBr();
    if (br && br.type === 'V') sources.push({ b, br, idx: sources.length });
  }
  const m = sources.length;
  const size = n + m;
  if (size <= 0) return emptyResult('no-unknowns');

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

  // 支路电阻的**唯一**守卫口径：非正 / 非有限一律视为断路（1e9 Ω），再夹进 [1e-4, 1e9]。
  // 两个调用点 —— ①盖章进矩阵（本函数下方）②算出电流后**上报**（本函数更下方）—— **必须**同源，
  // 差一处就会让上报值与解出的物理量差 13 个数量级：实测 R=0 时上报 15000 A，
  // 而同一回路的真实电流是 1.5e-9 A（回归护栏 `tools/circuit-rle0-probe.mjs`）。
  // ⚠ 只处理「非正 / 非有限」这一档：**正的**小值（如 5e-9）本来就夹到 1e-4，
  //   那一档的数值**不许变** —— 它是 `circuit-rle0-probe.mjs` §3 的护栏。
  const clampBranchR = (R) => {
    if (!(R > 0) || !isFinite(R)) R = 1e9;
    return Math.max(1e-4, Math.min(R, 1e9));
  };

  let x = null, iterations = 0;
  for (let iter = 0; iter < 26; iter++) {
    iterations = iter + 1;

    const A = Array.from({ length: size }, () => new Array(size).fill(0));
    const z = new Array(size).fill(0);

    for (const b of list) {
      const br = b.getBr();
      if (!br || br.type === 'V' || br.type === 'open') continue;
      // 与上报路径共用同一条守卫（见 `clampBranchR`）。
      const R = clampBranchR(resOf(b, prevU.get(b.ka + b.kb) ?? 0));
      const G = 1 / R;
      const ia = rowOf.get(dsu.find(b.ka)), ib = rowOf.get(dsu.find(b.kb));
      if (ia >= 0) A[ia][ia] += G;
      if (ib >= 0) A[ib][ib] += G;
      if (ia >= 0 && ib >= 0) { A[ia][ib] -= G; A[ib][ia] -= G; }
    }

    for (const s of sources) {
      const ia = rowOf.get(dsu.find(s.b.ka)), ib = rowOf.get(dsu.find(s.b.kb));
      if (ia === ib) return { ...emptyResult('source-shorted'), shorted: true };
      const k = n + s.idx;
      if (ia >= 0) { A[ia][k] += 1; A[k][ia] += 1; }
      if (ib >= 0) { A[ib][k] -= 1; A[k][ib] -= 1; }
      z[k] = s.br.emf;
      const ri = s.br.r || 0;
      if (ri > 0) A[k][k] -= ri;
    }

    // 每个节点对地加一个极小电导（gmin）：给悬空子电路留一条到地的数值通路。
    // ⚠ 它**替代不了**参考节点：一个只靠 gmin 撑着的分量，消元到最后那一块的枢轴会
    // 掉到 1e-12 量级，被 gauss 的阈值判成秩亏 —— 那正是「两个互不连通的回路」曾经
    // 整张结果 ok:false 的原因。真正的解法是上面的 2b（每个分量各自接地），
    // gmin 现在只是残余方向的数值兜底。
    for (let i = 0; i < n; i++) A[i][i] += 1e-12;

    x = gauss(A, z, size);
    if (!x) return emptyResult('rank-deficient');

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
  if (!x) return emptyResult('rank-deficient');

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
      // 与盖章路径共用同一条守卫（见 `clampBranchR`）。
      // 不共用时，上报值会与解出来的物理量差 13 个数量级 —— 实测 R=0 时报出 15000 A，
      // 而同一回路的真实电流是 1.5e-9 A（详见 tools/circuit-rle0-probe.mjs）。
      // ⚠ 只动「非正 / 非有限」这一档：**正的**小值（如 5e-9）两条路径本来就一致（都夹到 1e-4），
      // 那一档不许变 —— 探针 §3 是它的回归护栏。
      R = clampBranchR(resOf(b, U));
      I = U / R;
    }
    const P = Math.abs(U * I);
    const rec = { I, U, P, R, virtual: b.kind === 'virtual' };

    if (b.kind === 'real') {
      // 主边（bi 缺省 = 0）独占实体级键与实体级状态：branches.get(entId)、state.I/U/P/R、
      // 以及导线高亮（下面按实体 id 取记录）都靠它 —— 多支路器材不许把这三样弄丢。
      const primary = !b.bi;
      branches.set(primary ? b.ent.id : b.ent.id + '#' + b.bi, rec);
      if (primary) Object.assign(b.ent.state, { I, U, P, R });
      // 非主边：器材可以在支路对象上挂一个 state 盒子（{ type:'V', r, state: this.state.sec }），
      // 求解器把 {I,U,P,R} 写进去 —— 器材由此拿到自己第二条支路的解，
      // 而求解器**不发明新的 state 键**（键名归器材自己）。
      if (b.br && b.br.state && typeof b.br.state === 'object') Object.assign(b.br.state, { I, U, P, R });
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

  return { ok: true, closed, shorted: false, branches, nodeV, totalI, maxI, iterations, warnings };
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
