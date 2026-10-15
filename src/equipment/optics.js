const DEFS = [];
// ══════════════════════════════════════════════════════════
// 物理域 · 光学器材（6 件）
//
// 这一组器材的立身之本是：**每一条光路都由解析几何算出来**，
// 而不是把结果「画得像」。三条约定写在这里，全文件遵守：
//
//   ① 光学台约定：光沿 +x 传播；1 世界像素 = 1 毫米（于是 10 px = 1 cm）。
//   ② 透镜用「实物在左为正、实像在右为正」的符号约定：
//        1/f = 1/u + 1/v ，v > 0 实像（倒立）、v < 0 虚像（正立、与物同侧）
//        m = −v/u （负号 = 倒立），|m| = v/u 就是课本上的放大率大小
//      u = f 时出射平行光，不成像（state.atFocus）。
//   ③ 跨域耦合复用**既有的耦合总线**：core/bus.js 的 bus + EV.COUPLING，
//      以及器材的 insertZone() 空间识别约定（和 bridge.js 同一条通道），
//      不新造一套；bridge.js 不在本插件的写域内，也没有改它。
//
// 纯物理部分（解析几何、斯涅尔、朗伯-比尔…）全部 export，
// Node 里可以直接 import 断言，见 tools/equipment-optics.mjs。
// ══════════════════════════════════════════════════════════

import { Entity, gfx, grad1 } from '../core/entity.js';
import { define } from './registry.js';
import { bus, EV } from '../core/bus.js';

const PH = 'physics';
const CAT = '光学';
const PANEL = '#242c34', EDGE = '#39434d', TXT = '#e6edf3', DIM = '#8d96a0', HOT = '#ffd166', OK = '#4ade80';

/** 世界像素 → 毫米（光学台约定） */
export const MM_PER_PX = 1;
/** 光程 l 用厘米：10 px = 1 cm */
export const PX_PER_CM = 10;

const D2R = Math.PI / 180, R2D = 180 / Math.PI;
export const deg = (r) => r * R2D;
export const rad = (d) => d * D2R;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

// ══════════════════════════════════════════════════════════
// 一、颜色：波长 ↔ RGB
// ══════════════════════════════════════════════════════════

/**
 * 波长（nm）→ sRGB。可见光的分段近似（Bruton 的经典算法）：
 * 一段一段线性的色相 + 两端亮度衰减。
 * 用它而不是查表，是因为要能对**任意**波长（含 5 nm 步长的光谱求和）算色，
 * 表格会插值出不存在的中间色。
 */
export function wavelengthToRGB(lam) {
  let r = 0, g = 0, b = 0;
  if (lam >= 380 && lam < 440) { r = -(lam - 440) / 60; b = 1; }
  else if (lam < 490) { g = (lam - 440) / 50; b = 1; }
  else if (lam < 510) { g = 1; b = -(lam - 510) / 20; }
  else if (lam < 580) { r = (lam - 510) / 70; g = 1; }
  else if (lam < 645) { r = 1; g = -(lam - 645) / 65; }
  else if (lam <= 780) { r = 1; }
  // 两端（380 附近与 700 以后）人眼灵敏度下降，整体压暗，避免出现"纯紫/纯红"的假象
  let f = 1;
  if (lam < 420) f = 0.3 + 0.7 * (lam - 380) / 40;
  else if (lam > 700) f = 0.3 + 0.7 * (780 - lam) / 80;
  return [Math.round(255 * r * f), Math.round(255 * g * f), Math.round(255 * b * f)];
}

/** RGB → 色相角（0..360），用于断言「波长↔颜色」的单调性 */
export function hueOf([r, g, b]) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  if (d === 0) return 0;
  let h;
  if (mx === r) h = 60 * (((g - b) / d) % 6);
  else if (mx === g) h = 60 * ((b - r) / d + 2);
  else h = 60 * ((r - g) / d + 4);
  return (h + 360) % 360;
}

export const rgbCss = ([r, g, b], a = 1) => `rgba(${r},${g},${b},${a})`;
export const gray = (v) => `rgb(${v},${v},${v})`;

// ══════════════════════════════════════════════════════════
// 二、解析几何：直线与矩形/直线求交、反射、折射
// ══════════════════════════════════════════════════════════

/**
 * 直线 P = O + t·D 与轴对齐矩形的交集弦长（slab 法）。
 * 比色法里的光程 l 就是它 —— 光束穿过溶液的实际路程，不是容器宽度。
 * 不交返回 0。
 */
export function lineRectChord(ox, oy, dx, dy, rect) {
  let t0 = -Infinity, t1 = Infinity;
  const axes = [[ox, dx, rect.x, rect.x + rect.w], [oy, dy, rect.y, rect.y + rect.h]];
  for (const [o, d, lo, hi] of axes) {
    if (Math.abs(d) < 1e-12) { if (o < lo || o > hi) return 0; continue; }
    let a = (lo - o) / d, b = (hi - o) / d;
    if (a > b) { const s = a; a = b; b = s; }
    if (a > t0) t0 = a;
    if (b < t1) t1 = b;
    if (t0 > t1) return 0;
  }
  if (!isFinite(t0) || !isFinite(t1) || t1 <= t0) return 0;
  return (t1 - t0) * Math.hypot(dx, dy);
}

/** 单位向量 */
export function norm(dx, dy) { const L = Math.hypot(dx, dy) || 1; return [dx / L, dy / L]; }

/** 直线与直线的交点（P = A + t·D 与 Q = B + s·E），平行返回 null */
export function lineIntersect(ax, ay, adx, ady, bx, by, bdx, bdy) {
  const den = adx * bdy - ady * bdx;
  if (Math.abs(den) < 1e-12) return null;
  const t = ((bx - ax) * bdy - (by - ay) * bdx) / den;
  return { x: ax + t * adx, y: ay + t * ady, t };
}

/**
 * 镜面反射（解析式）：r = d − 2(d·n)n。
 * 反射定律在这个式子里是恒等式 —— 测试要断言的是「由它算出的两个角相等」，
 * 而不是「它看起来像反射」。
 */
export function reflect(dx, dy, nx, ny) {
  const [ux, uy] = norm(dx, dy), [mx, my] = norm(nx, ny);
  const dot = ux * mx + uy * my;
  return { tx: ux - 2 * dot * mx, ty: uy - 2 * dot * my };
}

/** 入射角（与法线夹角，度）；用 |d·n| 是为了不区分法线朝哪一侧 */
export function angleToNormal(dx, dy, nx, ny) {
  const [ux, uy] = norm(dx, dy), [mx, my] = norm(nx, ny);
  return deg(Math.acos(clamp(Math.abs(ux * mx + uy * my), -1, 1)));
}

/**
 * 点关于直线的镜像（平面镜成像的解析式）：
 * P' = P − 2((P−A)·n)n ，A 是镜面上一已知点，n 是单位法线。
 */
export function mirrorPoint(px, py, ax, ay, nx, ny) {
  const [mx, my] = norm(nx, ny);
  const d = (px - ax) * mx + (py - ay) * my;
  return { x: px - 2 * d * mx, y: py - 2 * d * my };
}

/**
 * 折射（矢量形式斯涅尔定律）：
 *   η = n₁/n₂, cosθᵢ = −d·n, sin²θₜ = η²(1−cos²θᵢ)
 *   sin²θₜ > 1 → 全反射（返回 tir:true 与反射方向）
 *   t = ηd + (ηcosθᵢ − √(1−sin²θₜ))·n
 * n 指向入射侧（与 d 相对）。
 */
export function refract(dx, dy, nx, ny, n1, n2) {
  const [ux, uy] = norm(dx, dy), [mx, my] = norm(nx, ny);
  const eta = n1 / n2;
  // 让法线朝向入射侧：d·n < 0 时取 −n（这样后面的公式不必分情况）
  let Nx = mx, Ny = my;
  if (ux * Nx + uy * Ny > 0) { Nx = -mx; Ny = -my; }
  const cosI = clamp(-(ux * Nx + uy * Ny), -1, 1);
  const sin2T = eta * eta * (1 - cosI * cosI);
  const thetaI = deg(Math.acos(cosI));
  if (sin2T > 1) {
    const r = reflect(ux, uy, Nx, Ny);
    return { tir: true, tx: r.tx, ty: r.ty, thetaI, thetaT: NaN, reflect: r };
  }
  const cosT = Math.sqrt(1 - sin2T);
  const tx = eta * ux + (eta * cosI - cosT) * Nx;
  const ty = eta * uy + (eta * cosI - cosT) * Ny;
  return { tir: false, tx, ty, thetaI, thetaT: deg(Math.acos(clamp(cosT, -1, 1))), sinRatio: n1 * Math.sin(rad(thetaI)) - n2 * Math.sin(rad(deg(Math.acos(clamp(cosT, -1, 1))))) };
}

/** 全反射临界角（度）：只在 n₁ > n₂ 时存在，否则返回 NaN */
export function criticalAngle(n1, n2) {
  if (!(n1 > n2)) return NaN;
  return deg(Math.asin(clamp(n2 / n1, -1, 1)));
}

// ══════════════════════════════════════════════════════════
// 三、薄透镜：代数解 + 光线追迹（两条独立路径互相验证）
// ══════════════════════════════════════════════════════════

/**
 * 薄透镜公式的代数解：v = uf/(u−f)。
 * u 是物距、f > 0（凸透镜）。返回的 v 有符号、m 有符号。
 *
 * ⚠ `real` / `inverted` 是**成像判据**，不是公式的纯外推：三档「不成像」必须与
 * 光屏面 `screenReading()` **逐格同判**，否则同一帧画布与光屏会给出相反结论。
 *   · **u ≤ 0 ⇒ 不成像**：几何上 u = 透镜 x − 发光面 x，`u < 0` 只意味着
 *     「**发光面已越过透镜**」。课本里的「虚物」要求入射光本来就在会聚，
 *     而本 app 的模型里**没有「会聚入射光」这个物理对象**（光自发光面发散出去）
 *     ⇒ 虚物成像公式（凸透镜对虚物成实像且正立）虽成立，但在这里**不适用**，
 *     按「几何上无意义、接不到像」处理，与 `screenReading()` 同一口径。
 *   · **u = 0 ⇒ 不成像**：物贴在透镜面上，v = 0、m = −0/0 = NaN；
 *     旧实现靠 `NaN < 0 === false` 兜出一个「正立」，那是兜底值、不是结论。
 *   · **u = f ⇒ 不成像**：出射平行光（v = ∞、m = −∞）；`m = −∞` 时给「倒立」
 *     在物理上无意义，故 inverted 与 `screenReading()` 一样带 `isFinite(m)` 守卫。
 * 其余两档不变：0 < u < f 虚像正立（v < 0、m > 0）；u > f 实像倒立（v > 0、m < 0）。
 */
export function thinLens(f, u) {
  const atFocus = Math.abs(u - f) < 1e-9;
  const v = atFocus ? Infinity : (u * f) / (u - f);
  const m = atFocus ? -Infinity : -v / u;         // 负 = 倒立
  return {
    v, f, u, m,
    mag: atFocus ? Infinity : Math.abs(v / u),    // 课本上的放大率大小 = v/u
    // 实像：v > 0 且有限 **且物真的在透镜前方**（u > 0）—— 与 screenReading() 同判据
    real: u > 0 && v > 0 && isFinite(v),
    // 倒立：m < 0 且有限（m = −∞ / NaN 都不是「倒立」，是不成像）
    inverted: isFinite(m) && m < 0,
    atFocus,
  };
}

/**
 * 光线追迹（解析几何）：平行光线与过光心光线，出射后求交 = 像点。
 * 光轴取 x 轴，透镜放在 x = 0，物点在 (−u, yO)。
 *   · 平行光线：到透镜后过 F′=(f, 0)
 *   · 过光心光线：不改变方向
 * 交点的 x 就是 v、y 与物高之比就是 m —— 与 thinLens() 是**两条独立路径**，
 * 测试断言两者一致（<1%），这就是「光路真的是解析算出来的」的证据。
 */
export function traceLens(f, u, yO) {
  const sol = thinLens(f, u);
  const dir1 = norm(f - 0, 0 - yO);                // 平行光线出射后过 F′=(f,0)
  const dir2 = norm(u, -yO);                       // 过光心后继续前进
  const hit = sol.atFocus ? null : lineIntersect(0, yO, dir1[0], dir1[1], 0, 0, dir2[0], dir2[1]);
  const rays = [
    { from: { x: -u, y: yO }, at: { x: 0, y: yO }, dir: dir1, name: '平行光线' },
    { from: { x: -u, y: yO }, at: { x: 0, y: 0 }, dir: dir2, name: '过光心光线' },
  ];
  if (!sol.atFocus) {
    // 第三条：过焦点 F=(−f,0) 的入射光线，出射后平行于光轴，高度 yO·f/(f−u)
    rays.push({ from: { x: -u, y: yO }, at: { x: 0, y: yO * (f / (f - u)) }, dir: [1, 0], name: '过焦点光线' });
  }
  return { ...sol, point: hit ? { x: hit.x, y: hit.y } : null, rays };
}

// ══════════════════════════════════════════════════════════
// 四、光屏：弥散圆 = 清晰度的解析判据
// ══════════════════════════════════════════════════════════

/**
 * 光屏偏离像面 d−v 时的弥散圆直径：coc = D·|d−v|/v（D = 透镜孔径）。
 * 清晰度取 1/(1+(coc/cRef)²)：d = v 时最大，向两边单调下降 ——
 * 所以「清晰度峰值位置 ≈ 计算出的 v」是一条可断言的性质，不是视觉判断。
 */
export function screenSharpness(v, d, apertureMM, cRefMM = 1) {
  if (!isFinite(v) || v <= 0) return { coc: Infinity, sharpness: 0 };
  const coc = (apertureMM * Math.abs(d - v)) / v;
  return { coc, sharpness: 1 / (1 + (coc / cRefMM) ** 2) };
}

/** 扫描 d 找清晰度峰值位置（测试与界面都用它） */
export function bestFocusDistance(v, apertureMM, dMin = 1, dMax = 400, step = 0.25) {
  let best = dMin, bv = -1;
  for (let d = dMin; d <= dMax; d += step) {
    const s = screenSharpness(v, d, apertureMM).sharpness;
    if (s > bv) { bv = s; best = d; }
  }
  return { d: best, sharpness: bv };
}

/**
 * 光屏该读到什么 —— 把「透镜的解」翻译成「屏上有没有像、像多大、朝哪」。
 *
 * 这是**虚实像分界**的唯一判据，不含任何渲染，测试直接断言它：
 *   · `u > f`  → v > 0 且有限 → `onScreen = true`（实像、可用光屏承接），
 *                 且一定 `m = −v/u < 0` → `inverted = true`（倒立）；
 *   · `u = f`  → 出射光平行（v = ∞）→ **接不到像**；
 *   · `u < f`  → v < 0，像与物同侧 → **虚像、正立、光屏接不到**（这就是课本上
 *                 用光屏找虚实像分界的那一步：屏上什么都不会出现）；
 *   · `u < 0`  → 发光面已经越过透镜，几何上无意义 → 也**接不到像**；
 *   · `u = 0`  → 物（发光面）**贴在透镜面上** → 也不成像（与「越过」分开措辞，两处文案同改）。
 *
 * `signedH = m·yO`（带符号，画布坐标：物在 +yO 一侧，实像落在 −yO 一侧 = 倒立）；
 * `height = |signedH|` 是课本上的像高大小。
 */
export function screenReading(lens, d, apertureMM = 40, cRefMM = 1) {
  const s = lens || {};
  const u = s.u, v = s.v, m = s.m, yO = s.yO || 6;
  const solved = !!s.solved;
  const real = solved && s.real === true && u > 0 && isFinite(v) && v > 0;
  const inverted = isFinite(m) && m < 0;
  const signedH = isFinite(m) ? m * yO : 0;
  // 清晰度只对「真的能在屏上成像」的情形有意义；否则 coc 为 ∞、清晰度 0
  const sh = screenSharpness(real ? v : NaN, d, apertureMM, cRefMM);
  let reason = '';
  if (!solved) reason = '左侧没有光源';
  // u ≤ 0 拆两档措辞：u < 0 是发光面**越过**透镜，u = 0 是物**贴在**透镜面上。
  // ⚠ 与 ConvexLens.render() 的 else 分支必须**逐字同一句**（同一帧两处同问一件事）。
  else if (!(u > 0)) reason = u === 0 ? '物贴在透镜面上（u = 0），不成像' : '发光面已越过透镜（u < 0），不成像';
  else if (s.atFocus) reason = '物在焦点上：出射光平行，不成像';
  else if (!real) reason = 'u < f：虚像与物同侧，光屏接不到';
  return {
    v, d,
    coc: sh.coc, sharpness: sh.sharpness,
    real, inverted, signedH, height: Math.abs(signedH),
    atImage: real && Math.abs(d - v) < 1,
    onScreen: real, reason,
  };
}

/**
 * 屏上那个倒立实像的几何（箭头），纯函数。
 * 画布坐标：物在 +yO（轴下方），所以实像的箭尖必须落在 **−y 一侧**（轴上方）——
 * 这正是「倒立」在图元级上的可断言形式：`tip[1] = m·yO < 0`。
 * 像高按 1 px = 1 mm 画，超出屏面时按 `hPx·0.45` 夹断（只影响画法，不影响读数）。
 */
export function screenImageArrow(st, hPx = 110) {
  if (!st || !st.onScreen) return null;
  const H = clamp(st.height, 0.5, hPx * 0.45);
  const sgn = (st.signedH < 0 ? -1 : 1);
  const tipY = sgn * H;
  const hw = clamp(H * 0.22, 1.5, H * 0.5);
  return {
    h: H, tip: [0, tipY], base: [0, 0],
    head: [[-hw, tipY - sgn * hw], [hw, tipY - sgn * hw]],
    inverted: st.inverted,
  };
}

// ══════════════════════════════════════════════════════════
// 五、色散：柯西公式 + 棱镜偏差
// ══════════════════════════════════════════════════════════

/** 光学介质：柯西 n(λ) = A + B/λ²（λ 单位 µm） */
export const MEDIA = {
  water: { name: '水', n589: 1.333, cauchy: [1.324, 0.0032], dn: '水' },
  alcohol: { name: '酒精', n589: 1.361, cauchy: [1.352, 0.0034] },
  crown: { name: '冕牌玻璃 K9', n589: 1.5168, cauchy: [1.5046, 0.00420] },
  flint: { name: '火石玻璃 F2', n589: 1.6200, cauchy: [1.5968, 0.00910] },
  diamond: { name: '金刚石', n589: 2.417, cauchy: [2.3800, 0.01400] },
};

/** 柯西公式：波长 nm → 折射率。同一种玻璃，紫光折射率大于红光，色散就是这么来的 */
export function cauchyN(media, lamNm) {
  const [A, B] = MEDIA[media].cauchy;
  const um = lamNm / 1000;
  return A + B / (um * um);
}

/**
 * 三棱镜的光路（每一步都是解析解）：
 *   入射面： sinθ₁ = n·sinθ₂
 *   内部：   θ₃ = A − θ₂ （A = 顶角）
 *   出射面： n·sinθ₃ = sinθ₄
 *   偏向角： δ = θ₁ + θ₄ − A
 * 出射面全反射（θ₃ > arcsin(1/n)）时标记 tirOut，此时的 δ 无意义。
 */
export function prismDeviation(lamNm, { media = 'crown', apex = 60, theta1 = 49.3 } = {}) {
  const n = cauchyN(media, lamNm);
  const A = apex, t1 = rad(theta1);
  const sin2 = Math.sin(t1) / n;
  if (Math.abs(sin2) > 1) return { lam: lamNm, n, tirIn: true, tirOut: false, delta: NaN, t2: NaN, t3: NaN, t4: NaN };
  const t2 = Math.asin(sin2);
  const t3 = rad(A) - t2;
  const sin4 = n * Math.sin(t3);
  if (Math.abs(sin4) > 1) {
    return { lam: lamNm, n, tirIn: false, tirOut: true, delta: NaN, t2: deg(t2), t3: deg(t3), t4: NaN };
  }
  const t4 = Math.asin(sin4);
  return {
    lam: lamNm, n, tirIn: false, tirOut: false,
    t2: deg(t2), t3: deg(t3), t4: deg(t4),
    delta: theta1 + deg(t4) - A,
  };
}

/** 最小偏向角配置：θ₁ = arcsin(n·sin(A/2))，此时光路对称、δ 最小 */
export function minDeviationIncidence(lamNm, media, apex) {
  const n = cauchyN(media, lamNm);
  return deg(Math.asin(clamp(n * Math.sin(rad(apex / 2)), -1, 1)));
}

/** 白光过棱镜：逐波长算偏向角（默认 400→700 nm，25 nm 一条） */
export function prismSpectrum({ media = 'crown', apex = 60, theta1 = 49.3, l0 = 400, l1 = 700, step = 25 } = {}) {
  const rows = [];
  for (let lam = l0; lam <= l1; lam += step) {
    const d = prismDeviation(lam, { media, apex, theta1 });
    rows.push({ ...d, rgb: wavelengthToRGB(lam) });
  }
  const ok = rows.filter(r => isFinite(r.delta));
  return { rows, valid: ok.length, spread: ok.length > 1 ? ok[0].delta - ok[ok.length - 1].delta : 0 };
}

// ══════════════════════════════════════════════════════════
// 六、跨域：朗伯-比尔定律（光学 ↔ 化学 · 比色法）
// ══════════════════════════════════════════════════════════

/**
 * 有色溶液的吸收带模型：ε(λ) = εmax·exp(−((λ−λmax)/band)²)。
 * 真实 ε(λ) 是测出来的曲线；这里用一条解析的高斯带代替，
 * 好处是**可复现、可断言**，而且关键数字贴着文献：
 *   KMnO4 在 525 nm 的 ε ≈ 2200 L·mol⁻¹·cm⁻¹（紫红色，吸收绿光）
 *   Cu²⁺ 的 d-d 带在 800 nm 附近，ε ≈ 20（蓝色，吸收红光）
 */
export const ABSORB = {
  KMnO4: { name: '高锰酸钾', epsMax: 2200, lambdaMax: 525, band: 78 },
  // Cu²⁺ 的 d-d 带又宽又弱（ε ~ 20），band 取 200nm 才能让可见光区的红色端真的被吃掉
  CuSO4: { name: '硫酸铜', epsMax: 20, lambdaMax: 800, band: 200 },
  FeCl3: { name: '氯化铁', epsMax: 180, lambdaMax: 480, band: 100 },
  K2Cr2O7: { name: '重铬酸钾', epsMax: 320, lambdaMax: 450, band: 95 },
};

/** 某个波长上的摩尔吸光系数 */
export function epsAt(spec, lamNm) {
  const d = (lamNm - spec.lambdaMax) / spec.band;
  return spec.epsMax * Math.exp(-d * d);
}

/** 朗伯-比尔：A = εcl（c: mol/L，l: cm，ε: L·mol⁻¹·cm⁻¹） */
export function absorbance(eps, c, lCm) { return eps * c * lCm; }

/** 透射率 T = 10^(−A)，以及 T% = 100T */
export function transmittance(A) { return Math.pow(10, -A); }
export const transmittancePct = (A) => 100 * transmittance(A);

/**
 * 单色光穿过溶液：完整的数字链 c、l、ε → A → T。
 */
export function colorimetry(spec, c, lCm, lamNm) {
  const eps = epsAt(spec, lamNm);
  const A = absorbance(eps, c, lCm);
  const T = transmittance(A);
  return { eps, c, l: lCm, A, T, Tpct: 100 * T, lambda: lamNm };
}

/**
 * 白光穿过溶液：逐波长积分，透过色 = Σ w(λ)·T(λ)（w 是该波长的眼睛响应）。
 * 于是「溶液颜色真的影响透过光的颜色」不是画上去的：
 * 高锰酸钾把 525 nm 那一带吸收掉，透过的自然就是紫红。
 */
export function whiteLightThrough(spec, c, lCm, { l0 = 380, l1 = 750, step = 5 } = {}) {
  let r = 0, g = 0, b = 0, r0 = 0, g0 = 0, b0 = 0;
  for (let lam = l0; lam <= l1; lam += step) {
    const [wr, wg, wb] = wavelengthToRGB(lam);
    const T = transmittance(epsAt(spec, lam) * c * lCm);
    r += wr * T; g += wg * T; b += wb * T;
    r0 += wr; g0 += wg; b0 += wb;
  }
  const rel = [r / (r0 || 1), g / (g0 || 1), b / (b0 || 1)];   // 各通道的相对透过率 0..1
  const mx = Math.max(rel[0], rel[1], rel[2]) || 1;
  const rgb = rel.map(v => Math.round(clamp(v / mx, 0, 1) * 255));
  return { rgb, rel, A525: epsAt(spec, spec.lambdaMax) * c * lCm };
}

// ══════════════════════════════════════════════════════════
// 器材公用小工具
// ══════════════════════════════════════════════════════════

/** 找 e 左侧最近的光源（光学台约定：光沿 +x 走） */
function sourceLeft(world, e) {
  let best = null, bd = Infinity;
  for (const s of world.entities) {
    if (s.type !== 'lightsource' || s.x >= e.x) continue;
    const d = e.x - s.x;
    if (d < bd) { bd = d; best = s; }
  }
  return best;
}
/** 光源的发光面（右端）与发光体高度（mm） */
const faceX = (s) => s.x + s.w / 2;
const objHeight = (s) => s.props.size || 6;

/** 器材面板底纹 */
function panel(g, w, h, r = 6) {
  gfx.fillRR(g, -w / 2, -h / 2, w, h, r, PANEL);
  gfx.strokeRR(g, -w / 2, -h / 2, w, h, r, EDGE, 1.5);
}
/** 一条光线的绘制（局部坐标） */
function ray(g, x0, y0, x1, y1, color, lw = 1.6, dash = null) {
  g.save();
  if (dash) g.setLineDash(dash);
  g.strokeStyle = color; g.lineWidth = lw; g.lineCap = 'round';
  g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke();
  g.restore();
}

// ─────────────────────────────────────────────────────────
// 1. 平行光源 / 激光（也是比色法的光源）
// ─────────────────────────────────────────────────────────
class LightSource extends Entity {
  /** 与耦合总线同构：声明成 probe，于是 CouplingBus.scan() 会把「激光 → 容器」记进 describe() */
  probe = { kind: 'laser' };

  /** 当前出射色（单色按波长，白光按等能白） */
  emitRGB() {
    if (this.props.white) return [255, 255, 255];
    return wavelengthToRGB(this.props.wavelength);
  }

  /**
   * 比色法耦合：光束穿过（或穿过附近）某个装了有色溶液的容器时，
   * 用朗伯-比尔算出 A、T 与透过色。用的是既有耦合总线的空间识别约定
   * （insertZone() + 光束直线），并通过 bus 的 EV.COUPLING 播报。
   */
  step(dt, world) {
    const rgb = this.emitRGB();
    this.state.rgb = rgb;
    this.state.lambda = this.props.white ? null : this.props.wavelength;

    const y = this.y;
    let best = null, bd = Infinity;
    for (const v of world.entities) {
      if (!v.vessel || v.x <= this.x) continue;
      const z = v.insertZone ? v.insertZone() : { x: v.x - v.w / 2, y: v.y - v.h / 2, w: v.w, h: v.h };
      // 光束是否穿过液面区域（高度方向留一点余量，避免"擦边就不算"）
      if (y < z.y - 6 || y > z.y + z.h + 6) continue;
      const d = v.x - this.x;
      if (d < bd) { bd = d; best = v; }
    }

    this.state.through = null;
    if (!best) return;

    const z = best.insertZone ? best.insertZone() : { x: best.x - best.w / 2, y: best.y - best.h / 2, w: best.w, h: best.h };
    const chordPx = lineRectChord(this.x, y, 1, 0, z);
    const lCm = chordPx / PX_PER_CM;

    // 找容器里浓度最高的、有吸收模型的溶质
    let spec = null, sid = null, c = 0;
    for (const id of Object.keys(ABSORB)) {
      const cc = best.vessel.conc(id);
      if (cc > c) { c = cc; spec = ABSORB[id]; sid = id; }
    }
    if (!spec || c <= 0 || lCm <= 0) {
      this.state.through = { vessel: best.id, name: best.def.name, c: 0, l: lCm, A: 0, T: 1, Tpct: 100, rgb, species: null };
      return;
    }

    let A, T, Tpct, outRGB, chain;
    if (this.props.white) {
      const w = whiteLightThrough(spec, c, lCm);
      A = w.A525; T = transmittance(A); Tpct = 100 * T; outRGB = w.rgb; chain = w;
    } else {
      chain = colorimetry(spec, c, lCm, this.props.wavelength);
      A = chain.A; T = chain.T; Tpct = chain.Tpct; outRGB = rgb.map(v => Math.round(v * T));
    }
    this.state.through = {
      vessel: best.id, name: best.def.name, species: sid, speciesName: spec.name,
      c, l: lCm, chordPx, eps: chain.eps, A, T, Tpct, rgb: outRGB, rel: chain.rel || null,
    };

    // 走既有的耦合总线播报（2.5 s 去重，与 bridge.js 同一套节流习惯）
    const t = world.time || 0;
    const key = 'colorimetry:' + best.id;
    this._last = this._last || new Map();
    const last = this._last.get(key);
    if (last === undefined || t - last > 2.5) {
      this._last.set(key, t);
      bus.emit(EV.COUPLING, {
        key, domain: 'bridge',
        msg: `比色法：${this.props.white ? '白光' : this.props.wavelength + ' nm 激光'}穿过 ${spec.name} `
          + `c=${c.toFixed(4)} mol/L、l=${lCm.toFixed(2)} cm → A=εcl=${A.toFixed(3)} → T=${Tpct.toFixed(2)}%`,
      });
    }
  }

  render(g) {
    const { w, h } = this;
    const rgb = this.state.rgb || this.emitRGB();
    const col = rgbCss(rgb);
    panel(g, w, h, 5);
    // 出射口
    gfx.fillRR(g, w / 2 - 8, -h * 0.22, 8, h * 0.44, 2, gray(60));
    gfx.text(g, this.props.white ? '白光' : this.props.wavelength + ' nm', 0, -6,
      { color: col, size: 11, weight: '600' });
    gfx.text(g, this.props.power.toFixed(1) + ' mW', 0, 8, { color: DIM, size: 9.5 });

    // 出射光束：单色一条线，白光画三色叠加（色散要有棱镜才发生，这里只是"看起来是白的"）
    const L = 70;
    if (this.props.white) {
      ray(g, w / 2, 0, w / 2 + L, 0, 'rgba(255,90,90,.55)', 3);
      ray(g, w / 2, 0, w / 2 + L, 0, 'rgba(90,255,120,.45)', 3);
      ray(g, w / 2, 0, w / 2 + L, 0, 'rgba(110,150,255,.55)', 3);
    } else {
      ray(g, w / 2, 0, w / 2 + L, 0, col, 2.4);
    }

    // 比色法读数（画在器材上 —— ui/inspector.js 不归本插件，读数只能自己画）
    const th = this.state.through;
    if (th) {
      const y0 = h / 2 + 8;
      gfx.fillRR(g, -w / 2 - 6, y0, w + 40, th.species ? 34 : 16, 3, 'rgba(0,0,0,.4)');
      if (th.species) {
        gfx.text(g, `${th.speciesName} c=${th.c.toFixed(4)} mol/L`, 8, y0 + 8, { color: TXT, size: 9.5 });
        gfx.text(g, `l=${th.l.toFixed(2)} cm  A=${th.A.toFixed(3)}  T=${th.Tpct.toFixed(1)}%`, 8, y0 + 21,
          { color: HOT, size: 9.5 });
      } else {
        gfx.text(g, `${th.name}：无有色溶质，A=0 T=100%`, 8, y0 + 8, { color: DIM, size: 9.5 });
      }
    }
  }
}
const lightDef = {
  type: 'lightsource', name: '平行光源/激光', domain: PH, cat: CAT, icon: '🔺',
  desc: '可调波长的平行光：单色激光或白光；穿过有色溶液时按朗伯-比尔衰减', w: 96, h: 40,
  ports: [],
  defaults: { wavelength: 650, white: false, power: 5, size: 6 },
  state: { rgb: [255, 0, 0], through: null },
  tags: ['光源', '激光', '波长', '比色法', '耦合'],
  fields: [
    { k: 'white', label: '白光', type: 'checkbox', text: '白光（含全部可见光）' },
    { k: 'wavelength', label: '波长', type: 'range', min: 380, max: 750, step: 5, unit: 'nm' },
    { k: 'power', label: '光功率', type: 'range', min: 0.1, max: 50, step: 0.1, unit: 'mW' },
    { k: 'size', label: '发光体高度', type: 'range', min: 2, max: 30, step: 1, unit: 'mm' },
  ],
  create: (x, y) => new LightSource(lightDef, x, y),
};
DEFS.push(() => define(lightDef));

// ─────────────────────────────────────────────────────────
// 2. 凸透镜
// ─────────────────────────────────────────────────────────
class ConvexLens extends Entity {
  /** 给定物距求解（纯计算，测试直接调它） */
  solve(u) { return solveLens(this.props, u, this.props.size || 6); }

  step(dt, world) {
    const s = sourceLeft(world, this);
    if (!s) { this.state.solved = false; return; }
    const u = this.x - faceX(s);
    const r = this.solve(u);
    Object.assign(this.state, r, { solved: true, sourceId: s.id, yO: objHeight(s), srcRGB: s.state.rgb || s.emitRGB() });
    // 像的世界坐标（供光屏承接）
    this.state.imgX = this.x + (isFinite(r.v) ? r.v : 0);
    this.state.imgY = this.y + (isFinite(r.m) ? r.m * objHeight(s) : 0);
  }

  render(g) {
    const { w, h } = this;
    const f = this.props.f;
    // 镜体：两段圆弧组成的双凸
    g.beginPath();
    g.moveTo(0, -h / 2);
    g.quadraticCurveTo(w * 0.55, 0, 0, h / 2);
    g.quadraticCurveTo(-w * 0.55, 0, 0, -h / 2);
    g.closePath();
    g.fillStyle = 'rgba(150,210,255,.20)'; g.fill();
    g.strokeStyle = 'rgba(170,225,255,.85)'; g.lineWidth = 1.6; g.stroke();
    // 光轴与焦点
    ray(g, -w / 2 - 26, 0, w / 2 + 26, 0, 'rgba(140,150,160,.5)', 1, [5, 4]);
    for (const x of [-f, f]) {
      g.beginPath(); g.arc(x, 0, 2.2, 0, Math.PI * 2); g.fillStyle = HOT; g.fill();
      gfx.text(g, 'F', x, 12, { color: HOT, size: 9 });
    }
    gfx.text(g, 'f=' + f + 'mm', 0, -h / 2 - 8, { color: TXT, size: 10 });

    if (!this.state.solved) return;
    const u = this.state.u, v = this.state.v;
    const xo = -u, yO = this.state.yO;
    // 物（发光体）与出射光路
    ray(g, xo, -yO, xo, yO, rgbCss(this.state.srcRGB || [255, 220, 120]), 3);
    for (const r of this.state.rays || []) {
      const L = 320;
      ray(g, r.from.x - this.x, r.from.y, r.at.x - this.x, r.at.y, 'rgba(255,235,150,.75)', 1.2);
      ray(g, r.at.x - this.x, r.at.y, r.at.x - this.x + r.dir[0] * L, r.at.y + r.dir[1] * L,
        'rgba(255,235,150,.55)', 1.1, [4, 3]);
    }
    // 像：实像实线 + 倒立（v > 0），虚像虚线 + 正立（v < 0、与物同侧）
    // ⚠ 只有这两档才画：u ≤ 0（发光面越过透镜）时 v > 0 但**不成像**，
    //   照旧画会在透镜右侧冒出一个「正立实像」，与光屏面同帧的
    //   「发光面已越过透镜（u < 0），不成像」自相矛盾 ⇒ 文案统一到那一侧。
    if (isFinite(v) && (this.state.real || v < 0)) {
      const xv = v, yI = this.state.m * yO;
      ray(g, xv, 0, xv, yI, this.state.real ? OK : 'rgba(120,200,255,.9)', 2.6, this.state.real ? null : [4, 3]);
      gfx.text(g, (this.state.real ? '实像 ' : '虚像 ') + 'v=' + v.toFixed(1) + 'mm',
        xv, yI + (yI >= 0 ? 12 : -12), { color: this.state.real ? OK : '#7fd4ff', size: 9.5 });
      gfx.text(g, 'm=' + this.state.m.toFixed(2), xv, yI + (yI >= 0 ? 24 : -24), { color: DIM, size: 9 });
    } else {
      const why = this.state.atFocus ? 'u=f：出射平行光，不成像'
        : (u === 0 ? '物贴在透镜面上（u = 0），不成像'
          : (u < 0 ? '发光面已越过透镜（u < 0），不成像' : '不成像'));
      gfx.text(g, why, 0, h / 2 + 12, { color: HOT, size: 9.5 });
    }
  }
}
/** 由 props 与物距算出完整解（也供光屏读取） */
export function solveLens(props, u, yO = 6) {
  const f = props.f;
  const t = traceLens(f, u, yO);
  const vT = t.point ? t.point.x : NaN;
  const mT = t.point ? t.point.y / yO : NaN;
  return {
    f, u, v: t.v, m: t.m, mag: t.mag, real: t.real, inverted: t.inverted, atFocus: t.atFocus,
    vTraced: vT, mTraced: mT,
    deltaV: isFinite(vT) && isFinite(t.v) && t.v !== 0 ? Math.abs(vT - t.v) / Math.abs(t.v) : 0,
    deltaM: isFinite(mT) && isFinite(t.m) && t.m !== 0 ? Math.abs(mT - t.m) / Math.abs(t.m) : 0,
    rays: t.rays.map(r => ({ from: r.from, at: r.at, dir: r.dir })),
  };
}
const lensDef = {
  type: 'convexlens', name: '凸透镜', domain: PH, cat: CAT, icon: '🔍',
  desc: '薄凸透镜：1/f = 1/u + 1/v，光路由光线追迹解析求出', w: 34, h: 96,
  ports: [],
  defaults: { f: 80, size: 6 },
  state: { solved: false },
  tags: ['透镜', '成像', '焦距', '折射'],
  fields: [
    { k: 'f', label: '焦距', type: 'range', min: 20, max: 300, step: 5, unit: 'mm' },
    { k: 'size', label: '物高（发光体）', type: 'range', min: 2, max: 30, step: 1, unit: 'mm' },
  ],
  create: (x, y) => new ConvexLens(lensDef, x, y),
};
DEFS.push(() => define(lensDef));

// ─────────────────────────────────────────────────────────
// 3. 光屏（承接实像）
// ─────────────────────────────────────────────────────────
class Screen extends Entity {
  /** 光屏在 d 处的清晰度（纯计算） */
  readAt(lens, d) {
    const st = lens && lens.state ? lens.state : null;
    const r = screenReading(st, d, lens ? lens.props.aperture || 40 : 40, this.props.cRef || 1);
    return { v: r.v, d, coc: r.coc, sharpness: r.sharpness, ...r };
  }

  step(dt, world) {
    let best = null;
    for (const e of world.entities) {
      if (e.type !== 'convexlens' || e.x >= this.x) continue;
      if (!best || e.x > best.x) best = e;
    }
    if (!best || !best.state || !best.state.solved) {
      this.state.lensId = null;
      this.state.onScreen = false; this.state.reason = '左侧没有光源';
      this.state.real = false; this.state.inverted = false;
      this.state.signedH = 0; this.state.height = 0; this.state.imgHeight = 0;
      return;
    }
    const d = this.x - best.x;
    const r = this.readAt(best, d);
    const st = this.state;
    st.lensId = best.id;
    st.d = d; st.v = r.v; st.coc = r.coc; st.sharpness = r.sharpness;
    st.atImage = r.atImage;
    // 屏上到底有没有像、像多大、朝哪 —— 由 screenReading() 的虚实像判据给出
    st.real = r.real; st.inverted = r.inverted;
    st.signedH = r.signedH; st.height = r.height; st.imgHeight = r.onScreen ? r.height : 0;
    st.onScreen = r.onScreen; st.reason = r.reason;
    st.mag = isFinite(best.state.m) ? best.state.m : NaN;
    st.u = best.state.u; st.f = best.state.f;
    st.srcRGB = best.state.srcRGB || null;
  }

  render(g) {
    const { w, h } = this;
    // 屏板（有颗粒的白色幕布）
    gfx.fillRR(g, -w / 2, -h / 2, w, h, 3, '#cfd6dd');
    gfx.strokeRR(g, -w / 2, -h / 2, w, h, 3, '#8d96a0', 1.2);
    g.save(); gfx.clipRR(g, -w / 2, -h / 2, w, h, 3);
    const rnd = (i) => ((Math.sin(i * 12.9898) * 43758.5453) % 1 + 1) % 1;
    g.globalAlpha = 0.12;
    for (let i = 0; i < 90; i++) {
      g.fillStyle = i % 2 ? '#7d858d' : '#ffffff';
      g.fillRect(-w / 2 + rnd(i) * w, -h / 2 + rnd(i + 99) * h, 1.4, 1.4);
    }
    g.globalAlpha = 1;
    g.restore();

    const st = this.state;
    const y0 = h / 2 + 11;
    if (st.lensId && st.onScreen) {
      // ① 弥散光斑：半径就是弥散圆（mm→px 1:1），亮度随清晰度
      const s = st.sharpness || 0;
      const r = clamp((st.coc || 0) / 2, 0.6, h * 0.5);
      const grd = grad1(this, '_gSpot', g, r.toFixed(1) + '|' + s.toFixed(2), () => {
        const gg = g.createRadialGradient(0, 0, 0, 0, 0, Math.max(2, r));
        gg.addColorStop(0, `rgba(255,246,200,${0.55 + s * 0.4})`);
        gg.addColorStop(1, 'rgba(255,220,120,0)');
        return gg;
      });
      g.fillStyle = grd;
      g.beginPath(); g.arc(0, 0, Math.max(2, r), 0, Math.PI * 2); g.fill();

      // ② 倒立的实像：箭尖落在光轴的另一侧（物在轴下方 ⇒ 像在轴上方）
      const col = rgbCss(st.srcRGB || [255, 246, 200]);
      const ar = screenImageArrow(st, h);
      if (ar) {
        const blur = 1 - s;
        const [tx, ty] = ar.tip;
        g.save();
        g.globalAlpha = 0.30 + 0.70 * s;
        ray(g, 0, 0, tx, ty, col, 2 + blur * 5, blur > 0.35 ? [3, 3] : null);
        g.beginPath();
        g.moveTo(ar.head[0][0], ar.head[0][1]);
        g.lineTo(tx, ty);
        g.lineTo(ar.head[1][0], ar.head[1][1]);
        g.fillStyle = col; g.fill();
        g.restore();
        gfx.text(g, `倒立的实像 ${ar.h.toFixed(1)}mm（m=${isFinite(st.mag) ? st.mag.toFixed(2) : '—'}）`,
          0, y0 + 33, { color: st.inverted ? OK : BAD, size: 9.5 });
      }
      gfx.text(g, 'd=' + st.d.toFixed(1) + 'mm', 0, y0, { color: DIM, size: 9.5 });
      gfx.text(g, `清晰度 ${(s * 100).toFixed(0)}%` + (st.atImage ? '（在像面）' : ''),
        0, y0 + 11, { color: st.atImage ? OK : TXT, size: 9.5 });
      gfx.text(g, `h=${st.imgHeight.toFixed(1)}mm（u=${isFinite(st.u) ? st.u.toFixed(0) : '—'} f=${st.f}）`,
        0, y0 + 22, { color: DIM, size: 9 });
    } else if (st.lensId) {
      // 接不到像：一个光斑都不画（虚实像分界就该是「屏上什么都没有」）
      gfx.text(g, '光屏上接不到像', 0, y0 + 11, { color: HOT, size: 10 });
      gfx.text(g, st.reason || '', 0, y0 + 23, { color: DIM, size: 9 });
      gfx.text(g, 'd=' + st.d.toFixed(1) + 'mm', 0, y0, { color: DIM, size: 9.5 });
    } else {
      gfx.text(g, '光屏', 0, h / 2 + 11, { color: DIM, size: 9.5 });
    }
  }
}
const screenDef = {
  type: 'screen', name: '光屏', domain: PH, cat: CAT, icon: '⬜',
  desc: '承接实像：实像倒立（m=−v/u<0），清晰度峰值出现在像距 v 处；u<f 时屏上接不到像', w: 20, h: 110,
  ports: [],
  defaults: { cRef: 1 },
  state: { lensId: null, onScreen: false, real: false, inverted: false, signedH: 0, imgHeight: 0, reason: '' },
  tags: ['光屏', '成像', '清晰度', '实像', '倒立'],
  fields: [{ k: 'cRef', label: '容许弥散圆', type: 'range', min: 0.2, max: 4, step: 0.1, unit: 'mm' }],
  create: (x, y) => new Screen(screenDef, x, y),
};
DEFS.push(() => define(screenDef));

// ─────────────────────────────────────────────────────────
// 4. 平面镜
// ─────────────────────────────────────────────────────────
class PlaneMirror extends Entity {
  /** 镜面直线（世界坐标）：过中心，方向由 props.angle 决定 */
  mirrorLine() {
    const a = rad(this.props.angle);
    const ux = Math.cos(a), uy = Math.sin(a);
    const nx = -uy, ny = ux;
    const half = this.w / 2;      // 镜面沿器材宽度方向展开，不是厚度方向
    return { ax: this.x, ay: this.y, ux, uy, nx, ny, half };
  }

  /** 一束沿 +x、高度 y 的光打到镜面上：返回入射角/反射角与反射光 */
  solveAt(y) {
    const m = this.mirrorLine();
    const hit = lineIntersect(this.x - 400, y, 1, 0, m.ax, m.ay, m.ux, m.uy);
    if (!hit) return null;
    // lineIntersect 给的 t 是沿光束的；镜面是**有限长**的，要另算沿镜面的投影
    const s = (hit.x - m.ax) * m.ux + (hit.y - m.ay) * m.uy;
    if (Math.abs(s) > m.half) return null;
    const d = [1, 0];
    const { tx, ty } = reflect(d[0], d[1], m.nx, m.ny);
    const thetaI = angleToNormal(d[0], d[1], m.nx, m.ny);
    const thetaR = angleToNormal(tx, ty, m.nx, m.ny);
    return { hit: { x: hit.x, y: hit.y }, thetaI, thetaR, tx, ty, mirror: m };
  }

  /** 物的像：关于镜面直线对称的点 */
  imageOf(px, py) { const m = this.mirrorLine(); return mirrorPoint(px, py, m.ax, m.ay, m.nx, m.ny); }

  step(dt, world) {
    const s = sourceLeft(world, this);
    const y = s ? s.y : this.y;
    const r = this.solveAt(y);
    this.state.sourceId = s ? s.id : null;
    this.state.solved = !!r;
    if (!r) return;
    this.state.thetaI = r.thetaI; this.state.thetaR = r.thetaR;
    this.state.hitX = r.hit.x; this.state.hitY = r.hit.y;
    this.state.dir = [r.tx, r.ty];
    if (s) {
      const p = this.imageOf(faceX(s), s.y);
      this.state.imageX = p.x; this.state.imageY = p.y;
      this.state.distObj = Math.hypot(faceX(s) - this.x, s.y - this.y);
      this.state.distImg = Math.hypot(p.x - this.x, p.y - this.y);
    }
  }

  render(g) {
    const { w, h } = this;
    const m = this.mirrorLine();
    g.save();
    g.rotate(rad(this.props.angle));
    // 镜面：正面亮银 + 背面涂漆
    gfx.fillRR(g, -w / 2, -4, w, 6, 1, 'rgba(190,225,245,.85)');
    gfx.fillRR(g, -w / 2, 2, w, 3, 1, '#4b545e');
    g.restore();
    // 法线
    for (const sgn of [1, -1]) {
      ray(g, 0, 0, sgn * m.nx * (h * 0.45), sgn * m.ny * (h * 0.45), 'rgba(150,160,172,.55)', 1, [4, 3]);
    }
    if (!this.state.solved) { gfx.text(g, '平面镜 ' + this.props.angle + '°', 0, h / 2 + 12, { color: DIM, size: 9.5 }); return; }

    const hx = this.state.hitX - this.x, hy = this.state.hitY - this.y;
    const di = [1, 0];
    const L = 150;
    // 入射光（从左侧到命中点）与反射光
    ray(g, hx - 260, hy, hx, hy, 'rgba(255,225,140,.8)', 1.6, [5, 4]);
    ray(g, hx, hy, hx + this.state.dir[0] * L, hy + this.state.dir[1] * L, 'rgba(255,225,140,.95)', 1.8);
    // 法线到入射/反射光的角标注
    gfx.text(g, `θᵢ=${this.state.thetaI.toFixed(1)}°  θᵣ=${this.state.thetaR.toFixed(1)}°`,
      0, h / 2 + 12, { color: Math.abs(this.state.thetaI - this.state.thetaR) < 0.01 ? OK : '#ff8080', size: 9.5 });
    // 物与虚像（关于镜面对称）
    if (this.state.imageX !== undefined) {
      const ix = this.state.imageX - this.x, iy = this.state.imageY - this.y;
      const pObj = this.imageOf(ix + this.x, iy + this.y);   // 再镜像一次 = 物点
      ray(g, pObj.x - this.x, pObj.y - this.y, ix, iy, 'rgba(140,200,255,.5)', 1, [3, 3]);
      g.beginPath(); g.arc(ix, iy, 3.4, 0, Math.PI * 2);
      g.strokeStyle = 'rgba(140,200,255,.95)'; g.lineWidth = 1.6; g.stroke();
      gfx.text(g, '虚像', ix, iy - 10, { color: '#7fd4ff', size: 9 });
    }
  }
}
const mirrorDef = {
  type: 'planemirror', name: '平面镜', domain: PH, cat: CAT, icon: '🪞',
  desc: '反射定律：入射角 = 反射角；像与物关于镜面对称', w: 120, h: 14,
  ports: [],
  defaults: { angle: 45 },
  state: { solved: false },
  tags: ['平面镜', '反射', '成像'],
  fields: [{ k: 'angle', label: '镜面倾角', type: 'range', min: 0, max: 90, step: 1, unit: '°' }],
  create: (x, y) => new PlaneMirror(mirrorDef, x, y),
};
DEFS.push(() => define(mirrorDef));

// ─────────────────────────────────────────────────────────
// 5. 水槽（折射 / 全反射）
// ─────────────────────────────────────────────────────────
class WaterTank extends Entity {
  /** 换介质就把 n₂ 设成它的 n₅₈₉（还能用滑杆微调，两者不打架） */
  onProp(k, v) { if (k === 'medium' && MEDIA[v]) this.props.n2 = MEDIA[v].n589; }

  /** 给定入射角求解（纯计算，测试直接调它） */
  solve(theta1Deg) {
    const n2 = this.props.n2;
    const down = this.props.direction !== 'water2air';
    const n1 = down ? 1.0 : n2;
    const n2eff = down ? n2 : 1.0;
    // 法线取竖直向上（空气侧），入射方向由入射角决定
    const t1 = rad(theta1Deg);
    const d = [Math.sin(t1), Math.cos(t1)];       // 从左上射向液面（向下）
    const r = refract(d[0], d[1], 0, -1, n1, n2eff);
    return {
      thetaI: r.thetaI, thetaT: r.thetaT, tir: r.tir,
      thetaC: criticalAngle(n1, n2eff),
      n1, n2: n2eff,
      dir: [r.tx, r.ty], reflectDir: r.tir ? [r.tx, r.ty] : (r.reflect ? [r.reflect.tx, r.reflect.ty] : null),
    };
  }

  step() {
    const r = this.solve(this.props.angle);
    this.state.thetaI = r.thetaI; this.state.thetaT = r.thetaT; this.state.tir = r.tir;
    this.state.thetaC = r.thetaC; this.state.dir = r.dir; this.state.n1 = r.n1; this.state.n2 = r.n2;
  }

  render(g) {
    const { w, h } = this;
    const sf = -h * 0.12;                       // 液面（局部 y）
    // 水槽
    gfx.fillRR(g, -w / 2, -h / 2, w, h, 4, 'rgba(180,220,235,.10)');
    gfx.strokeRR(g, -w / 2, -h / 2, w, h, 4, 'rgba(190,225,240,.7)', 1.4);
    // 液体
    gfx.fillRR(g, -w / 2 + 2, sf, w - 4, h / 2 + h * 0.12 - 2, 2, 'rgba(90,170,220,.35)');
    ray(g, -w / 2 + 2, sf, w / 2 - 2, sf, 'rgba(210,240,255,.9)', 1.4);
    // 法线
    ray(g, 0, sf, 0, sf - 46, 'rgba(150,160,172,.6)', 1, [4, 3]);

    if (this.state.thetaI === undefined) return;
    const t1 = rad(this.state.thetaI);
    const hit = { x: 0, y: sf };
    const L = 78;
    // 入射光
    ray(g, hit.x - Math.sin(t1) * L, hit.y - Math.cos(t1) * L, hit.x, hit.y, 'rgba(255,225,140,.9)', 1.8);
    if (this.state.tir) {
      // 全反射：反射回同侧
      const dir = this.state.dir;
      ray(g, hit.x, hit.y, hit.x + dir[0] * L, hit.y + dir[1] * L, 'rgba(255,140,140,.95)', 2);
      gfx.text(g, `全反射 θᵢ=${this.state.thetaI.toFixed(1)}° ≥ θc=${this.state.thetaC.toFixed(1)}°`,
        0, h / 2 + 12, { color: '#ff9090', size: 9.5 });
    } else {
      const dir = this.state.dir;
      ray(g, hit.x, hit.y, hit.x + dir[0] * L, hit.y + dir[1] * L, 'rgba(140,240,255,.95)', 1.8);
      gfx.text(g, `n₁sinθ₁ = n₂sinθ₂  θ₂=${this.state.thetaT.toFixed(1)}°`,
        0, h / 2 + 12, { color: OK, size: 9.5 });
      if (isFinite(this.state.thetaC)) {
        gfx.text(g, `临界角 θc=${this.state.thetaC.toFixed(1)}°`, 0, h / 2 + 23, { color: DIM, size: 9 });
      }
    }
    gfx.text(g, MEDIA[this.props.medium] ? MEDIA[this.props.medium].name : '' , 0, -h / 2 + 10,
      { color: DIM, size: 9 });
  }
}
const tankDef = {
  type: 'watertank', name: '水槽（折射）', domain: PH, cat: CAT, icon: '🛢',
  desc: '斯涅尔定律与全反射临界角：可切换空气→液体 / 液体→空气', w: 150, h: 110,
  ports: [],
  defaults: { medium: 'water', n2: 1.333, angle: 45, direction: 'air2water' },
  state: { tir: false },
  tags: ['折射', '全反射', '斯涅尔', '临界角'],
  fields: [
    {
      k: 'medium', label: '液体介质', type: 'select',
      options: [['water', '水 n=1.333'], ['alcohol', '酒精 n=1.361'], ['crown', '玻璃 K9 n=1.517'], ['flint', '火石玻璃 n=1.620'], ['diamond', '金刚石 n=2.417']],
    },
    { k: 'n2', label: '折射率 n₂', type: 'range', min: 1.0, max: 2.6, step: 0.001 },
    { k: 'angle', label: '入射角 θ₁', type: 'range', min: 0, max: 89, step: 0.5, unit: '°' },
    {
      k: 'direction', label: '传播方向', type: 'select',
      options: [['air2water', '空气 → 液体'], ['water2air', '液体 → 空气（会全反射）']],
    },
  ],
  create: (x, y) => new WaterTank(tankDef, x, y),
};
DEFS.push(() => define(tankDef));

// ─────────────────────────────────────────────────────────
// 6. 三棱镜（色散）
// ─────────────────────────────────────────────────────────
class Prism extends Entity {
  step() {
    const { media, apex, theta1 } = this.props;
    const sp = prismSpectrum({ media, apex, theta1 });
    this.state.rows = sp.rows;
    this.state.spread = sp.spread;
    this.state.valid = sp.valid;
    this.state.tirOut = sp.rows.some(r => r.tirOut);
  }

  render(g) {
    const { w, h } = this;
    const A = rad(this.props.apex);
    const top = { x: 0, y: -h / 2 };
    const left = { x: -Math.tan(A / 2) * h / 2 - w * 0.1, y: h / 2 };
    const right = { x: Math.tan(A / 2) * h / 2 + w * 0.1, y: h / 2 };
    g.beginPath();
    g.moveTo(top.x, top.y); g.lineTo(right.x, right.y); g.lineTo(left.x, left.y); g.closePath();
    g.fillStyle = 'rgba(175,215,245,.20)'; g.fill();
    g.strokeStyle = 'rgba(190,230,255,.85)'; g.lineWidth = 1.6; g.stroke();
    gfx.text(g, MEDIA[this.props.media].name + ' A=' + this.props.apex + '°', 0, h / 2 + 12, { color: DIM, size: 9 });

    if (!this.state.rows) return;
    // 入射白光
    ray(g, -w / 2 - 90, 0, left.x + 6, 0, 'rgba(255,255,255,.85)', 2.2);
    // 逐波长出射：偏向角越大越往下偏（紫光偏得最多）
    for (const r of this.state.rows) {
      if (!isFinite(r.delta)) continue;
      const dd = r.delta - this.props.theta1;      // 相对入射方向的偏折
      const a = rad(dd);
      const x0 = right.x * 0.4, y0 = 0;
      ray(g, x0, y0, x0 + Math.cos(a) * 150, y0 + Math.sin(a) * 150, rgbCss(r.rgb, 0.95), 1.8);
    }
    const rows = this.state.rows.filter(r => isFinite(r.delta));
    if (rows.length > 1) {
      gfx.text(g, `δ(${rows[0].lam}nm)=${rows[0].delta.toFixed(2)}° → δ(${rows[rows.length - 1].lam}nm)=${rows[rows.length - 1].delta.toFixed(2)}°`,
        0, h / 2 + 23, { color: HOT, size: 9 });
      gfx.text(g, `谱宽 ${this.state.spread.toFixed(2)}°（紫偏折最大）`, 0, h / 2 + 34, { color: TXT, size: 9 });
    }
    if (this.state.tirOut) gfx.text(g, '出射面全反射，无出射光', 0, -h / 2 - 8, { color: '#ff9090', size: 9.5 });
  }
}
const prismDef = {
  type: 'prism', name: '三棱镜', domain: PH, cat: CAT, icon: '🔺',
  desc: '色散：柯西 n(λ) → 不同波长偏向角不同，白光展开成谱', w: 120, h: 100,
  ports: [],
  defaults: { media: 'crown', apex: 60, theta1: 49.3 },
  state: { rows: null, spread: 0 },
  tags: ['棱镜', '色散', '光谱', '折射率'],
  fields: [
    {
      k: 'media', label: '棱镜材料', type: 'select',
      options: [['crown', '冕牌玻璃 K9'], ['flint', '火石玻璃 F2'], ['water', '水（棱镜形水槽）'], ['diamond', '金刚石']],
    },
    { k: 'apex', label: '顶角 A', type: 'range', min: 20, max: 90, step: 1, unit: '°' },
    { k: 'theta1', label: '入射角 θ₁', type: 'range', min: 5, max: 85, step: 0.1, unit: '°' },
  ],
  create: (x, y) => new Prism(prismDef, x, y),
};
DEFS.push(() => define(prismDef));

export { LightSource, ConvexLens, Screen, PlaneMirror, WaterTank, Prism };

// ── 插件 ──────────────────────────────────────────────────
export default {
  id: 'xiaomo.equipment.optics',
  name: '光学器材',
  version: '1.0.0',
  kind: 'equipment',
  domain: 'physics',
  order: 30,
  desc: '平行光源/激光、凸透镜、光屏、平面镜、水槽（折射/全反射）、三棱镜（色散）；光路全部由解析几何求解',
  author: '小墨实验室',
  builtin: true,
  tags: ['物理', '光学', '折射', '反射', '色散', '比色法', '耦合'],
  setup(ctx) { ctx.scope('equipment', () => DEFS.forEach(f => f())); },
};
