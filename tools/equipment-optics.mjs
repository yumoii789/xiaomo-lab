// ══════════════════════════════════════════════════════════
// 无头验证：光学器材（6 件）的每一条光路都必须是解析解
//
//   node tools/equipment-optics.mjs
//
// 与 tools/check.mjs 同一套写法：装插件 → 造场景 → 逐步推进 → 断言。
// 关键断言都刻意让**两条互相独立的路径**对撞：
//   · 薄透镜的代数解 v=uf/(u−f)  ⟷  光线追迹求出的交点
//   · 光屏清晰度峰值的扫描位置    ⟷  透镜方程算出的像距 v
//   · 斯涅尔定律的矢量形式        ⟷  n₁sinθ₁ = n₂sinθ₂
//   · 朗伯-比尔的积分结果        ⟷  εcl 的数字链
// 同一条公式自己等于自己不算证据。
// ══════════════════════════════════════════════════════════

import { World } from '../src/core/world.js';
import { PluginHost } from '../src/core/plugin.js';
import { create, list, bindRegistry, equipmentPlugins, groups as regGroups } from '../src/equipment/index.js';
import { bus, EV } from '../src/core/bus.js';
import optics, {
  thinLens, traceLens, wavelengthToRGB, hueOf, rad, deg,
  lineRectChord, angleToNormal, criticalAngle, screenSharpness, bestFocusDistance,
  screenReading, screenImageArrow,
  cauchyN, prismDeviation, prismSpectrum, minDeviationIncidence, MEDIA,
  colorimetry, epsAt, whiteLightThrough, ABSORB,
  MM_PER_PX, PX_PER_CM,
} from '../src/equipment/optics.js';

import physicsPlugin from '../src/physics/circuit.js';
import chemistryPlugin from '../src/chemistry/reactions.js';
import bridgePlugin from '../src/coupling/bridge.js';

// ── 用无头宿主把插件装起来，等价于浏览器里的引导过程 ──
const bootApp = {
  services: {}, ticks: [], world: null, selected: null,
  log: { push() {}, clear() {} }, toast() {},
  addTick(fn) { this.ticks.push(fn); return () => {}; },
};
const host = new PluginHost(bootApp);
const PLUGIN_ID = 'xiaomo.equipment.optics';
for (const p of [physicsPlugin, chemistryPlugin, bridgePlugin, ...equipmentPlugins, optics]) host.define(p);
host.installAll();
bindRegistry(host.registry('equipment'));

let pass = 0, fail = 0;
const ok = (cond, msg) => {
  if (cond) { pass++; console.log('  \x1b[32m✓\x1b[0m ' + msg); }
  else { fail++; console.log('  \x1b[31m✗\x1b[0m ' + msg); }
};
const head = (t) => console.log('\n\x1b[36m' + t + '\x1b[0m');
const f2 = (v, n = 2) => (typeof v === 'number' ? v.toFixed(n) : String(v));
const relErr = (a, b) => Math.abs(a - b) / (Math.abs(b) || 1);

/** Canvas 2D 的替身：只保证调用不报错，用来跑通所有渲染分支 */
function mockCtx() {
  const grad = { addColorStop() {} };
  return new Proxy({}, {
    get(_t, k) {
      if (k === 'createLinearGradient' || k === 'createRadialGradient') return () => grad;
      if (k === 'canvas') return { width: 800, height: 600 };
      if (k === 'measureText') return () => ({ width: 10 });
      if (k === 'getImageData') return () => ({ data: new Uint8ClampedArray(4) });
      return () => {};
    },
    set() { return true; },
  });
}

/** 场景装配：与 main.js 的 loadScene 等价，但不依赖 DOM */
function build(objs) {
  const world = new World();
  const ents = [];
  for (const o of objs) {
    const e = create(o.type, o.x, o.y);
    if (!e) { console.log('  !! 无法创建器材: ' + o.type); continue; }
    if (o.props) for (const k of Object.keys(o.props)) e.setProp(k, o.props[k]);
    if (o.state) Object.assign(e.state, o.state);
    if (o.fill && e.vessel) {
      const v = e.vessel;
      for (const [sid, mL] of o.fill) v.addLiquid(sid, mL);
      if (o.mol) for (const [sid, n] of Object.entries(o.mol)) v.mol.set(sid, n);
      v.updateColor();
    }
    world.add(e, true);
    ents.push(e);
  }
  const byType = (t) => ents.find(e => e.type === t);
  const step = (n = 1, dt = 1 / 120) => { for (let i = 0; i < n; i++) { world.step(dt); } };
  return { world, ents, byType, step };
}

const OPTICS_TYPES = ['lightsource', 'convexlens', 'screen', 'planemirror', 'watertank', 'prism'];
const mine = () => list().filter(d => OPTICS_TYPES.includes(d.type));

// ══════════════════════════════════════════════════════════
head('① 插件与注册表');
{
  ok(optics.id === PLUGIN_ID, `插件 id = ${optics.id}`);
  ok(optics.kind === 'equipment' && optics.domain === 'physics', `kind=${optics.kind} domain=${optics.domain}`);
  ok(optics.builtin === true, 'builtin=true（内建插件，不来自市场）');
  ok(optics.order === 30, `order=${optics.order}（不与其他插件冲突：主题用 0/10，默认 50）`);

  const defs = mine();
  ok(defs.length === 6, `注册了 ${defs.length} 件器材`);
  ok(defs.every(d => d.domain === 'physics'), '全部 domain = physics');
  ok(defs.every(d => d.cat === '光学'), '全部 cat = 光学');
  ok(OPTICS_TYPES.every(t => defs.some(d => d.type === t)),
    '六件齐备：' + defs.map(d => d.type).join(' / '));

  const NEED = ['type', 'name', 'icon', 'domain', 'cat', 'desc', 'tags', 'w', 'h', 'ports', 'fields', 'defaults', 'state', 'create'];
  let missing = [];
  for (const d of defs) for (const k of NEED) {
    if (d[k] === undefined || d[k] === null) missing.push(`${d.type}.${k}`);
  }
  ok(missing.length === 0, missing.length ? '缺字段：' + missing.join(', ') : '每件器材的必需字段齐全');

  let bad = [];
  for (const d of defs) {
    const e = d.create(10, 20);
    if (!e || e.type !== d.type || e.x !== 10 || e.y !== 20) bad.push(d.type);
  }
  ok(bad.length === 0, bad.length ? 'create 异常：' + bad.join(',') : 'create() 都能造出实例且坐标正确');

  const g = regGroups({ domain: 'physics' });
  const cat = g.find(x => x.cat === '光学');
  ok(!!cat && cat.items.length === 6, `器材栏分组「物理/光学」${cat ? cat.items.length : 0} 件`);
}

// ══════════════════════════════════════════════════════════
head('② 凸透镜：1/f = 1/u + 1/v（代数解 + 符号语义）');
{
  const f = 80;
  const cases = [240, 160, 120, 100, 90, 80, 40];
  console.log('        u/mm     v/mm        m      1/f 残差   虚实');
  for (const u of cases) {
    const s = thinLens(f, u);
    if (s.atFocus) {
      ok(!isFinite(s.v), `u = f = ${u}：不成像（出射平行光），v = ${s.v}`);
      continue;
    }
    const res = Math.abs(1 / f - (1 / u + 1 / s.v)) / (1 / f);
    console.log(`    ${String(u).padStart(6)}  ${f2(s.v, 3).padStart(9)}  ${f2(s.m, 3).padStart(7)}   ${(res * 100).toExponential(1).padStart(9)}   ${s.real ? '实像' : '虚像'}`);
    ok(res < 0.01, `u=${u}mm：1/f − (1/u+1/v) 相对残差 ${(res * 100).toExponential(2)} < 1%`);
    ok(Math.abs(Math.abs(s.m) - Math.abs(s.v / u)) < 1e-12, `u=${u}mm：|m| == |v/u| = ${f2(Math.abs(s.v / u), 4)}`);
    if (u > f) ok(s.v > 0 && s.real && s.m < 0, `u=${u} > f：实像（v>0）且倒立（m=${f2(s.m, 3)} < 0）`);
    if (u < f) ok(s.v < 0 && !s.real && s.m > 0, `u=${u} < f：虚像（v=${f2(s.v, 1)} < 0）且正立（m=${f2(s.m, 3)} > 0）`);
    if (u === 2 * f) ok(Math.abs(Math.abs(s.m) - 1) < 0.01, `u = 2f：等大倒立实像 |m| = ${f2(Math.abs(s.m), 4)}`);
  }
}

// ══════════════════════════════════════════════════════════
head('③ 凸透镜：光线追迹交点 ⟷ 公式解（两条独立路径对撞）');
{
  const f = 80, yO = 6;
  console.log('        u/mm    v 公式     v 追迹     m 公式     m 追迹   v 残差   m 残差');
  for (const u of [240, 160, 120, 90, 40]) {
    const t = traceLens(f, u, yO);
    ok(!!t.point, `u=${u}mm：三条光线求交出像点`);
    const dv = relErr(t.point.x, t.v), dm = relErr(t.point.y / yO, t.m);
    console.log(`    ${String(u).padStart(6)}  ${f2(t.v, 3).padStart(8)}  ${f2(t.point.x, 3).padStart(8)}  ${f2(t.m, 4).padStart(8)}  ${f2(t.point.y / yO, 4).padStart(8)}  ${(dv * 100).toExponential(1)}  ${(dm * 100).toExponential(1)}`);
    ok(dv < 0.01, `u=${u}mm：追迹像距 ${f2(t.point.x, 3)}mm ⟷ 公式 v=${f2(t.v, 3)}mm，相对差 ${(dv * 100).toExponential(2)} < 1%`);
    ok(dm < 0.01, `u=${u}mm：追迹放大率 ⟷ m=−v/u，相对差 ${(dm * 100).toExponential(2)} < 1%`);
  }
  // 三条出射光线应交于同一点：过焦点光线的出射高度 == 像高
  const t = traceLens(f, 240, yO);
  ok(Math.abs(t.rays[2].at.y - t.point.y) < 1e-9, `过焦点光线出射高度 ${f2(t.rays[2].at.y, 3)}mm == 像高 ${f2(t.point.y, 3)}mm`);
}

// ══════════════════════════════════════════════════════════
head('④ 光屏：清晰度峰值 ⟷ 计算出的像距 v');
{
  const D = 40;
  for (const v of [120, 240, 60]) {
    const b = bestFocusDistance(v, D);
    ok(Math.abs(b.d - v) < 0.5, `v=${v}mm：扫描出的清晰度峰值在 d=${f2(b.d, 2)}mm（相差 ${f2(Math.abs(b.d - v), 2)}mm < 0.5mm）`);
  }
  const s0 = screenSharpness(120, 120, D).sharpness;
  ok(s0 > 0.999, `d = v 处清晰度 = ${f2(s0, 4)}（弥散圆为 0）`);
  let mono = true, prev = Infinity;
  for (let d = 120; d <= 200; d += 5) { const s = screenSharpness(120, d, D).sharpness; if (s > prev) mono = false; prev = s; }
  let mono2 = true; prev = -Infinity;
  for (let d = 40; d <= 120; d += 5) { const s = screenSharpness(120, d, D).sharpness; if (s < prev) mono2 = false; prev = s; }
  ok(mono && mono2, '清晰度以 d=v 为峰、两侧单调下降');
  const coc20 = screenSharpness(120, 140, D).coc;
  ok(Math.abs(coc20 - D * 20 / 120) < 1e-9, `d=v+20mm 时弥散圆 ${f2(coc20, 3)}mm == D·|d−v|/v = ${f2(D * 20 / 120, 3)}mm`);

  // 端到端：光源 → 透镜 → 光屏
  const sin = build([
    { type: 'lightsource', x: 112, y: 300, props: { size: 6 } },
    { type: 'convexlens', x: 400, y: 300, props: { f: 80 } },
    { type: 'screen', x: 520, y: 300 },
  ]);
  sin.step(2);
  const lens = sin.byType('convexlens'), screen = sin.byType('screen');
  ok(Math.abs(lens.state.u - 240) < 1e-9, `端到端物距 u = ${f2(lens.state.u, 1)}mm（光源发光面 → 透镜）`);
  ok(Math.abs(lens.state.v - 120) < 1e-9, `端到端像距 v = ${f2(lens.state.v, 1)}mm`);
  ok(screen.state.atImage === true, `光屏在 d=${f2(screen.state.d, 1)}mm 判定「在像面」，清晰度 ${(screen.state.sharpness * 100).toFixed(1)}%`);
  screen.x = 540; sin.step(2);
  ok(screen.state.sharpness < 0.5, `光屏移开 20mm 后清晰度降到 ${(screen.state.sharpness * 100).toFixed(1)}%`);
}

// ══════════════════════════════════════════════════════════
head('⑤ 光源：波长 ⟷ 颜色');
{
  const anchors = [[650, 0], [530, 1], [450, 2], [400, 2]];
  for (const [lam, ch] of anchors) {
    const rgb = wavelengthToRGB(lam);
    const mx = rgb.indexOf(Math.max(...rgb));
    console.log(`    ${lam} nm → rgb(${rgb.join(',')})  主导通道 ${'RGB'[mx]}`);
    ok(mx === ch, `${lam}nm 的主导通道是 ${'RGB'[mx]}`);
  }
  let mono = true, prevHue = Infinity;
  for (let lam = 400; lam <= 640; lam += 5) {
    const h = hueOf(wavelengthToRGB(lam));
    if (!(h < prevHue)) mono = false;
    prevHue = h;
  }
  ok(mono, '400→640nm 色相角严格单调（紫 → 红）');
  let nonInc = true; prevHue = Infinity;
  for (let lam = 400; lam <= 750; lam += 5) {
    const h = hueOf(wavelengthToRGB(lam));
    if (h > prevHue + 1e-9) nonInc = false;
    prevHue = h;
  }
  ok(nonInc, '400→750nm 色相角不递增（两端压暗处也不反弹）');
  const w = wavelengthToRGB(650);
  ok(w[0] > 200 && w[1] < 20 && w[2] < 20, `650nm = rgb(${w.join(',')})，红`);
  const g = wavelengthToRGB(530);
  ok(g[1] > 200 && g[0] < 100 && g[2] < 20, `530nm = rgb(${g.join(',')})，绿`);
  const b = wavelengthToRGB(450);
  ok(b[2] > 200 && b[0] < 20, `450nm = rgb(${b.join(',')})，蓝`);
}

// ══════════════════════════════════════════════════════════
head('⑥ 平面镜：反射定律 + 关于镜面的对称');
{
  const mirror = build([{ type: 'planemirror', x: 300, y: 200, props: { angle: 45 } }]).byType('planemirror');
  for (const a of [15, 30, 45, 60, 75, 90]) {
    const m = build([{ type: 'planemirror', x: 0, y: 0, props: { angle: a } }]).byType('planemirror');
    let worst = 0, cnt = 0;
    for (const yy of [-30, -10, 0, 10, 30]) {
      const r = m.solveAt(yy);
      if (!r) continue;
      cnt++;
      worst = Math.max(worst, Math.abs(r.thetaI - r.thetaR));
      ok(Math.abs(r.thetaI - r.thetaR) < 0.5,
        `镜面 ${a}°、光高 ${yy}：入射角 ${f2(r.thetaI, 3)}° == 反射角 ${f2(r.thetaR, 3)}°`);
    }
    ok(cnt > 0, `镜面 ${a}°：光束打到了镜面上（命中 ${cnt} 个位置）`);
    ok(worst < 0.5, `镜面 ${a}°：全部命中里最大角差 ${worst.toExponential(2)}° < 0.5°`);
  }
  // 反射方向：45° 镜面把水平光反射成竖直（0,1）；90° 镜面原路返回（−1,0）
  const r45 = build([{ type: 'planemirror', x: 0, y: 0, props: { angle: 45 } }]).byType('planemirror').solveAt(0);
  ok(Math.abs(r45.tx) < 1e-9 && Math.abs(r45.ty - 1) < 1e-9, `45° 镜面：水平入射 → 反射方向 (${f2(r45.tx, 6)}, ${f2(r45.ty, 6)})`);
  const r90 = build([{ type: 'planemirror', x: 0, y: 0, props: { angle: 90 } }]).byType('planemirror').solveAt(0);
  ok(Math.abs(r90.tx + 1) < 1e-9 && Math.abs(r90.ty) < 1e-9, `90° 镜面：正入射 → 反射方向 (${f2(r90.tx, 6)}, ${f2(r90.ty, 6)})`);

  // 对称性：|P′A| == |PA|、PP′ ⊥ 镜面、中点在镜面上
  let worstSym = 0, worstPerp = 0, worstOn = 0;
  for (const a of [15, 45, 75]) {
    const m = build([{ type: 'planemirror', x: 300, y: 200, props: { angle: a } }]).byType('planemirror');
    const L = m.mirrorLine();
    for (const P of [{ x: 260, y: 180 }, { x: 320, y: 260 }, { x: 340, y: 190 }]) {
      const Q = m.imageOf(P.x, P.y);
      worstSym = Math.max(worstSym, Math.abs(Math.hypot(Q.x - L.ax, Q.y - L.ay) - Math.hypot(P.x - L.ax, P.y - L.ay)));
      worstPerp = Math.max(worstPerp, Math.abs((Q.x - P.x) * L.ux + (Q.y - P.y) * L.uy));
      const mx = (P.x + Q.x) / 2, my = (P.y + Q.y) / 2;
      worstOn = Math.max(worstOn, Math.abs((mx - L.ax) * L.ux + (my - L.ay) * L.uy - 0) * 0 + Math.abs((mx - L.ax) * L.nx + (my - L.ay) * L.ny));
    }
  }
  ok(worstSym < 1e-9, `像到镜面距离 == 物到镜面距离（最大偏差 ${worstSym.toExponential(2)}）`);
  ok(worstPerp < 1e-9, `物像连线 ⊥ 镜面（最大偏差 ${worstPerp.toExponential(2)}）`);
  ok(worstOn < 1e-9, `物像中点在镜面上（最大偏差 ${worstOn.toExponential(2)}）`);

  // 端到端：光源 + 45° 镜面
  const sim = build([
    { type: 'lightsource', x: 100, y: 200 },
    { type: 'planemirror', x: 300, y: 200, props: { angle: 45 } },
  ]);
  sim.step(2);
  const ms = sim.byType('planemirror');
  ok(ms.state.solved === true, '器材自身解出了光路（state.solved）');
  ok(Math.abs(ms.state.thetaI - ms.state.thetaR) < 0.5, `器材内：θᵢ=${f2(ms.state.thetaI, 3)}° θᵣ=${f2(ms.state.thetaR, 3)}°`);
  ok(Math.abs(ms.state.distObj - ms.state.distImg) < 1e-9, `光源到镜面 ${f2(ms.state.distObj, 3)} == 虚像到镜面 ${f2(ms.state.distImg, 3)}`);
}

// ══════════════════════════════════════════════════════════
head('⑦ 水槽：斯涅尔定律 + 全反射临界角');
{
  const tank = build([{ type: 'watertank', x: 0, y: 0, props: { medium: 'water', n2: 1.333, angle: 45, direction: 'air2water' } }]).byType('watertank');
  let worst = 0;
  for (const t1 of [0, 10, 30, 45, 60, 80, 89]) {
    const r = tank.solve(t1);
    const lhs = r.n1 * Math.sin(rad(r.thetaI)), rhs = r.n2 * Math.sin(rad(r.thetaT));
    worst = Math.max(worst, Math.abs(lhs - rhs));
    ok(Math.abs(lhs - rhs) < 0.01,
      `空气→水 θ₁=${t1}°：n₁sinθ₁=${f2(lhs, 6)} == n₂sinθ₂=${f2(rhs, 6)}（θ₂=${f2(r.thetaT, 3)}°）`);
    ok(r.tir === false, `空气→水 θ₁=${t1}°：不会全反射`);
  }
  console.log(`    最大 |n₁sinθ₁ − n₂sinθ₂| = ${worst.toExponential(2)}`);
  const tc = criticalAngle(1.333, 1.0);
  ok(Math.abs(deg(Math.asin(1 / 1.333)) - tc) < 1e-12, `θc = arcsin(n₂/n₁) = ${f2(tc, 4)}°（1.333 → 空气）`);
  const upTank = build([{ type: 'watertank', x: 0, y: 0, props: { n2: 1.333, direction: 'water2air' } }]).byType('watertank');
  const rBelow = upTank.solve(tc - 1.5), rAbove = upTank.solve(tc + 1.5), rNear = upTank.solve(tc - 0.05);
  ok(!rBelow.tir && Math.abs(rBelow.n1 * Math.sin(rad(rBelow.thetaI)) - rBelow.n2 * Math.sin(rad(rBelow.thetaT))) < 0.01,
    `θ₁ = θc−1.5° = ${f2(tc - 1.5, 2)}°：仍折射（θ₂=${f2(rBelow.thetaT, 2)}°），斯涅尔继续成立`);
  ok(!rNear.tir && rNear.thetaT > 85,
    `θ₁ = θc−0.05°：折射角 ${f2(rNear.thetaT, 2)}° → 逼近 90°（临界角就在这里）`);
  ok(rAbove.tir === true, `θ₁ = θc+1.5° = ${f2(tc + 1.5, 2)}°：发生全反射`);
  const r60 = upTank.solve(60);
  ok(r60.tir && Math.abs(angleToNormal(r60.dir[0], r60.dir[1], 0, -1) - 60) < 0.5,
    `液体→空气 θ₁=60°：全反射，反射角 ${f2(angleToNormal(r60.dir[0], r60.dir[1], 0, -1), 3)}° == 入射角`);
  for (const [med, n] of [['alcohol', 1.361], ['crown', 1.517], ['flint', 1.62], ['diamond', 2.417]]) {
    ok(Math.abs(MEDIA[med].n589 - n) < 0.002, `介质表 ${MEDIA[med].name}：n₅₈₉=${MEDIA[med].n589} ≈ ${n}`);
  }
  const tr = build([{ type: 'watertank', x: 0, y: 0, props: { direction: 'water2air', angle: 60 } }]);
  tr.step(1);
  const t2 = tr.byType('watertank');
  ok(t2.state.tir === true && Math.abs(t2.state.thetaC - tc) < 1e-9, `器材内：θᵢ=${f2(t2.state.thetaI, 2)}° ≥ θc=${f2(t2.state.thetaC, 2)}° 判定全反射`);
  // 介质选择联动：换介质自动换 n₂
  const t3 = build([{ type: 'watertank', x: 0, y: 0 }]).byType('watertank');
  t3.setProp('medium', 'diamond');
  ok(Math.abs(t3.props.n2 - MEDIA.diamond.n589) < 1e-9, `选「金刚石」后 n₂ 自动变成 ${t3.props.n2}`);
}

// ══════════════════════════════════════════════════════════
head('⑧ 三棱镜：柯西色散、单调性、最小偏向角');
{
  const A = 60, t1 = 49.3;
  ok(cauchyN('crown', 400) > cauchyN('crown', 500) && cauchyN('crown', 500) > cauchyN('crown', 700),
    `柯西公式单调：n(400)=${f2(cauchyN('crown', 400), 5)} > n(500)=${f2(cauchyN('crown', 500), 5)} > n(700)=${f2(cauchyN('crown', 700), 5)}`);
  ok(Math.abs(cauchyN('crown', 589) - MEDIA.crown.n589) < 0.001,
    `n(589nm)=${f2(cauchyN('crown', 589), 5)} ≈ 手册值 ${MEDIA.crown.n589}`);

  let prev = Infinity, mono = true, worstSin = 0;
  for (let lam = 400; lam <= 700; lam += 25) {
    const r = prismDeviation(lam, { media: 'crown', apex: A, theta1: t1 });
    ok(!r.tirIn && !r.tirOut, `${lam}nm：两面都不全反射（θ₂=${f2(r.t2, 2)}° θ₃=${f2(r.t3, 2)}°）`);
    worstSin = Math.max(worstSin,
      Math.abs(Math.sin(rad(t1)) - r.n * Math.sin(rad(r.t2))),
      Math.abs(r.n * Math.sin(rad(r.t3)) - Math.sin(rad(r.t4))),
      Math.abs(r.delta - (t1 + r.t4 - A)));
    if (!(r.delta < prev)) mono = false;
    prev = r.delta;
    console.log(`    ${String(lam).padStart(3)}nm  n=${f2(r.n, 5)}  θ₄=${f2(r.t4, 3)}°  δ=${f2(r.delta, 3)}°`);
  }
  ok(worstSin < 1e-9, `每一步折射关系与 δ=θ₁+θ₄−A 的残差上限 ${worstSin.toExponential(2)} < 1e-9`);
  ok(mono, 'δ 随波长严格单调递减（紫光偏折最大）');
  const sp = prismSpectrum({ media: 'crown', apex: A, theta1: t1 });
  ok(sp.spread > 1, `400→700nm 谱宽 = ${f2(sp.spread, 3)}° > 1°（白光真的展开了）`);
  const steep = prismDeviation(400, { media: 'crown', apex: A, theta1: 20 });
  ok(steep.tirOut === true, `θ₁=20°：出射面全反射（θ₃=${f2(steep.t3, 2)}° > arcsin(1/n)=${f2(deg(Math.asin(1 / steep.n)), 2)}°），无出射光`);

  const tmin = minDeviationIncidence(589, 'crown', A);
  const rm = prismDeviation(589, { media: 'crown', apex: A, theta1: tmin });
  const dmin = 2 * deg(Math.asin(cauchyN('crown', 589) * Math.sin(rad(A / 2)))) - A;
  ok(Math.abs(tmin - 49.30) < 0.05, `最小偏向角入射角 θ₁ = arcsin(n·sin(A/2)) = ${f2(tmin, 3)}°`);
  ok(Math.abs(rm.delta - dmin) < 0.01, `θ₁=${f2(tmin, 2)}° 时 δ=${f2(rm.delta, 3)}° == δmin=2arcsin(n·sin(A/2))−A=${f2(dmin, 3)}°`);
  ok(Math.abs(rm.t4 - tmin) < 0.05, `最小偏向角配置下光路对称：θ₄=${f2(rm.t4, 3)}° == θ₁=${f2(tmin, 3)}°`);
  const sim = build([{ type: 'prism', x: 0, y: 0, props: { media: 'crown', apex: 60, theta1: 49.3 } }]);
  sim.step(1);
  const pr = sim.byType('prism');
  ok(pr.state.rows.length === 13 && pr.state.spread > 1, `器材内：${pr.state.rows.length} 条谱线，谱宽 ${f2(pr.state.spread, 3)}°`);
}

// ══════════════════════════════════════════════════════════
head('⑨ 跨域：朗伯-比尔 A = εcl（光学 ↔ 化学比色法）');
{
  const km = ABSORB.KMnO4;
  const ch = colorimetry(km, 2e-4, 1, 525);
  console.log(`    数字链：ε(525nm)=${ch.eps} L·mol⁻¹·cm⁻¹，c=2e-4 mol/L，l=1.00 cm`);
  console.log(`            A = εcl = ${f2(ch.A, 6)}   T = 10^(−A) = ${f2(ch.T, 6)}   T% = ${f2(ch.Tpct, 4)}%`);
  ok(Math.abs(ch.A - ch.eps * ch.c * ch.l) < 1e-12, `A == εcl（残差 ${Math.abs(ch.A - ch.eps * ch.c * ch.l).toExponential(2)}）`);
  ok(Math.abs(ch.T - Math.pow(10, -ch.A)) < 1e-12, `T == 10^(−A)`);
  ok(Math.abs(ch.A - 0.44) < 1e-9, `A = 2200 × 2e-4 × 1 = ${f2(ch.A, 4)}`);
  ok(Math.abs(ch.Tpct - 36.3078) < 0.01, `T% = ${f2(ch.Tpct, 4)}%`);
  const dense = colorimetry(km, 0.02, 1, 525);
  console.log(`    任务书里的 c=0.02 mol/L：A=${f2(dense.A, 3)}，T=${dense.T.toExponential(3)}（${f2(dense.Tpct, 10)}%）—— 模型说它已经不透光了`);
  ok(dense.A > 10, `c=0.02 mol/L 时 A=${f2(dense.A, 2)} ≫ 1，宏观上不透光（这是正确的物理，不是 bug）`);
  const dbl = colorimetry(km, 4e-4, 1, 525);
  ok(Math.abs(dbl.A - 2 * ch.A) < 1e-12 && Math.abs(dbl.T - ch.T * ch.T) < 1e-15,
    `浓度翻倍：A 翻倍 (${f2(dbl.A, 4)})、T 平方 (${f2(dbl.T, 5)})`);
  ok(dbl.T < ch.T, '浓度越高透射率越低（单调）');

  const wh = whiteLightThrough(km, 2e-4, 1);
  console.log(`    白光过 KMnO4：相对透过 R=${f2(wh.rel[0], 4)} G=${f2(wh.rel[1], 4)} B=${f2(wh.rel[2], 4)} → rgb(${wh.rgb.join(',')})`);
  ok(wh.rel[1] < wh.rel[0] && wh.rel[1] < wh.rel[2], '绿光被吸收得最多（高锰酸钾吸收 525nm 一带）');
  ok(wh.rgb[1] < wh.rgb[0] && wh.rgb[1] < wh.rgb[2], `透过色 rgb(${wh.rgb.join(',')}) 是紫红 —— 溶液颜色真的改变了透过光颜色`);
  const cu = whiteLightThrough(ABSORB.CuSO4, 0.2, 1);
  console.log(`    白光过 CuSO4 (0.2 mol/L)：相对透过 R=${f2(cu.rel[0], 4)} G=${f2(cu.rel[1], 4)} B=${f2(cu.rel[2], 4)} → rgb(${cu.rgb.join(',')})`);
  ok(cu.rel[0] < cu.rel[1] && cu.rel[0] < cu.rel[2], '红光被吸收得最多（Cu²⁺ 吸收带在 800nm）');
  ok(cu.rgb[0] < cu.rgb[2], `透过色 rgb(${cu.rgb.join(',')}) 偏蓝`);

  // 光程：光束穿过容器的实际弦长
  const rect = { x: 0, y: -10, w: 60, h: 20 };
  ok(Math.abs(lineRectChord(-100, 0, 1, 0, rect) - 60) < 1e-9, '水平光束穿过 60px 宽的液面：弦长 = 60px');
  ok(lineRectChord(-100, 40, 1, 0, rect) === 0, '光束在液面上方：弦长 = 0（不假装穿了）');
  ok(PX_PER_CM === 10 && MM_PER_PX === 1, `光学台标度：1px = ${MM_PER_PX}mm，${PX_PER_CM}px = 1cm`);

  // 端到端：激光穿过装了 CuSO4 的烧杯（复用化学域的容器）
  let fired = null;
  const off = bus.on(EV.COUPLING, (p) => { if (String(p.key).startsWith('colorimetry:')) fired = p; });
  const sim = build([
    { type: 'lightsource', x: 100, y: 300, props: { wavelength: 650, white: false } },
    { type: 'beaker', x: 300, y: 300, fill: [['CuSO4', 100]], mol: { CuSO4: 2e-5 } },
  ]);
  sim.step(1);
  off();
  const laser = sim.byType('lightsource'), beaker = sim.byType('beaker');
  const th = laser.state.through;
  ok(!!th && th.vessel === beaker.id, `激光找到了光束上的容器：${th && th.name}`);
  ok(th && th.species === 'CuSO4', `识别出有色溶质：${th && th.speciesName}`);
  ok(th && Math.abs(th.c - 2e-4) < 1e-12, `取到容器里的浓度 c = ${th && th.c} mol/L`);
  const chord = lineRectChord(laser.x, laser.y, 1, 0, beaker.insertZone());
  ok(th && Math.abs(th.l - chord / PX_PER_CM) < 1e-12, `光程 l = 弦长/10 = ${th && f2(th.l, 3)}cm（弦长 ${f2(chord, 1)}px）`);
  ok(th && Math.abs(th.A - epsAt(ABSORB.CuSO4, 650) * th.c * th.l) < 1e-12,
    `端到端 A = ε(650nm)·c·l = ${th && f2(th.A, 5)}（ε=${th && f2(th.eps, 4)}）`);
  ok(th && Math.abs(th.T - Math.pow(10, -th.A)) < 1e-12, `端到端 T = ${th && f2(th.Tpct, 3)}%`);
  ok(!!fired && /A=/.test(fired.msg), `耦合总线收到事件：${fired && fired.msg}`);
  ok(!!fired && fired.domain === 'bridge', `耦合事件 domain = ${fired && fired.domain}（与 bridge.js 同一条通道）`);

  // 没有溶质时不虚构吸收
  const sim2 = build([
    { type: 'lightsource', x: 100, y: 300, props: { wavelength: 650 } },
    { type: 'beaker', x: 300, y: 300, fill: [['H2O', 100]] },
  ]);
  sim2.step(1);
  const l2 = sim2.byType('lightsource');
  ok(!!l2.state.through && l2.state.through.species === null && l2.state.through.A === 0,
    '装纯水的烧杯：A = 0、T = 100%（没有色溶质就不吸收）');
}

// ══════════════════════════════════════════════════════════
head('⑩ 插件启停 + 渲染冒烟');
{
  const before = mine().length;
  host.disable(PLUGIN_ID);
  const off = mine().length;
  ok(off === 0, `停用后在插件管理器里 6 件器材全部消失（注册表里剩 ${off} 件）`);
  ok(!list().some(d => OPTICS_TYPES.includes(d.type)), '光学器材的定义真的从注册表摘掉了');
  ok(host.enable(PLUGIN_ID) === true, '重新启用成功');
  ok(mine().length === before, `启用后恢复 ${mine().length} 件`);
  const g2 = (host.registry('equipment')).list();
  ok(g2.filter(d => d.cat === '光学').length === 6, '器材栏分组也恢复了 6 件');

  // 渲染冒烟：6 件器材在完整场景里都画一遍
  const sim = build([
    { type: 'lightsource', x: 112, y: 300, props: { white: true } },
    { type: 'convexlens', x: 400, y: 300, props: { f: 80 } },
    { type: 'screen', x: 520, y: 300 },
    { type: 'planemirror', x: 300, y: 460, props: { angle: 45 } },
    { type: 'watertank', x: 300, y: 620, props: { direction: 'water2air', angle: 60 } },
    { type: 'prism', x: 300, y: 780, props: { apex: 60, theta1: 49.3 } },
  ]);
  sim.step(3);
  let drawn = 0, errs = [];
  for (const e of sim.ents) {
    try { e.render(mockCtx()); drawn++; } catch (err) { errs.push(`${e.type}: ${err.message}`); }
  }
  ok(errs.length === 0 && drawn === 6, errs.length ? '渲染抛错：' + errs.join('; ') : `${drawn} 件器材的 render() 全部跑通`);
  // 再画一遍需要 state 的分支（第二次进入渐变缓存分支）
  let errs2 = [];
  for (const e of sim.ents) { try { e.render(mockCtx()); } catch (err) { errs2.push(`${e.type}: ${err.message}`); } }
  ok(errs2.length === 0, errs2.length ? '第二帧渲染抛错：' + errs2.join('; ') : '第二帧渲染（渐变缓存命中）也跑通');
  ok(sim.byType('lightsource').state.rgb.join(',') === '255,255,255', '白光光源的出射色是白色');

  // 空场景（一个光源都没有）：这是 check.mjs「全部器材渲染并步进」会走到的路径，
  // 接线之后它会逐个 create + render + step，所以这里必须单独钉一遍
  const bare = build(OPTICS_TYPES.filter(t => t !== 'lightsource').map((t, i) => ({ type: t, x: 200 + i * 60, y: 200 })));
  let errs3 = [];
  for (const e of bare.ents) {
    try { e.render(mockCtx(), bare.world); e.step(1 / 120, bare.world); e.render(mockCtx(), bare.world); }
    catch (err) { errs3.push(`${e.type}: ${err.message}`); }
  }
  ok(errs3.length === 0, errs3.length ? '无光源场景抛错：' + errs3.join('; ') : '无光源的空场景下 5 件器材仍能渲染并步进');
  bare.step(3);
  ok(bare.byType('convexlens').state.solved === false && bare.byType('screen').state.lensId === null,
    '没有光源时不虚构光路（透镜 solved=false、光屏无像可承）');
}

// ══════════════════════════════════════════════════════════
head('⑪ 光屏的实像必须是倒立的，且 u<f 时屏上不得出现像（task-27）');
// ══════════════════════════════════════════════════════════
{
  const info = (t) => console.log('  \x1b[90m' + t + '\x1b[0m');   // 本节的旁注，不参与计数
  // 记录型 canvas 替身：把 render 真正下发到 canvas 的图元抓下来 ——
  // 「屏上有没有像」必须是图元级证据，不是读代码猜的
  const recCtx = () => {
    const log = { arcs: [], pts: [], texts: [] };
    const grad = { addColorStop() {} };
    const ctx = new Proxy({}, {
      get(_t, k) {
        if (k === 'canvas') return { width: 800, height: 600 };
        if (k === 'measureText') return () => ({ width: 10 });
        if (k === 'createRadialGradient' || k === 'createLinearGradient') return () => grad;
        if (k === 'arc') return (x, y, r) => log.arcs.push({ x, y, r });
        if (k === 'moveTo' || k === 'lineTo') return (x, y) => log.pts.push({ x, y });
        if (k === 'fillText') return (s) => log.texts.push(String(s));
        return () => {};
      },
      set() { return true; },
    });
    return { ctx, log, reset() { log.arcs.length = 0; log.pts.length = 0; log.texts.length = 0; } };
  };

  /** 光源(物高 6mm) + 凸透镜(f) + 光屏，光屏默认摆在像距 v 处 */
  const scene = (u, f, screenD = null) => {
    const world = new World();
    const src = create('lightsource', 40, 300);
    src.setProp('size', 6);
    const lens = create('convexlens', 40 + u + 48, 300);   // +48 = 光源发光面到圆心的距离
    lens.setProp('f', f);
    const scr = create('screen', 0, 300);
    world.add(src, true); world.add(lens, true); world.add(scr, true);
    world.step(1 / 120);
    const uReal = lens.state.u;
    scr.x = lens.x + (screenD !== null ? screenD : (isFinite(lens.state.v) && lens.state.v > 0 ? lens.state.v : 60));
    world.step(1 / 120);
    return { world, src, lens, scr, uReal };
  };

  // ── 1. 纯函数判据：v、m、倒立标志（与 1/f = 1/u + 1/v 独立对撞） ──
  const CASES = [[200, 50], [100, 50], [75, 50], [120, 30]];
  for (const [u, f] of CASES) {
    const vTheo = (u * f) / (u - f);
    const mTheo = -vTheo / u;
    const S = scene(u, f);
    const L = S.lens.state, P = S.scr.state;
    ok(Math.abs(S.uReal - u) < 1e-9, `u=${u}、f=${f}：场景摆位正确（实测 u=${S.uReal.toFixed(1)}mm）`);
    ok(relErr(L.v, vTheo) < 1e-9 && relErr(L.m, mTheo) < 1e-9,
      `  透镜解 v=${L.v.toFixed(3)}（解析 ${vTheo.toFixed(3)}）、m=${L.m.toFixed(3)}（解析 ${mTheo.toFixed(3)}）`);
    ok(P.onScreen === true && P.inverted === true,
      `  屏上接得到实像：onScreen=${P.onScreen}、inverted=${P.inverted}（倒立标志）`);
    ok(Math.abs(P.signedH - mTheo * 6) < 1e-9 && Math.abs(P.imgHeight - Math.abs(mTheo) * 6) < 1e-9,
      `  像高：带符号 signedH=${P.signedH.toFixed(3)}mm（=m·物高，负=倒立）、大小 h=${P.imgHeight.toFixed(3)}mm`);
  }

  // ── 2. 图元级：实像的箭尖必须落在光轴另一侧（物在 +yO ⇒ 像在 −|m|yO） ──
  for (const [u, f] of [[200, 50], [100, 50], [75, 50]]) {
    const S = scene(u, f);
    const P = S.scr.state;
    const R = recCtx();
    S.scr.render(R.ctx);
    const tip = R.log.pts.filter(p => Math.abs(p.x) < 6 && p.y !== 0).sort((a, b) => Math.abs(b.y) - Math.abs(a.y))[0];
    ok(tip && Math.abs(tip.y - P.signedH) < 1e-9 && tip.y < 0,
      `  屏上真的画出了倒立的像：箭尖 y=${tip ? tip.y.toFixed(3) : '—'}（画布坐标，负=与物相反一侧），m=${P.mag.toFixed(3)}`);
    ok(R.log.arcs.length >= 1, `  离焦光斑仍在（arc r=${R.log.arcs.map(a => a.r.toFixed(2)).join(',')}）`);
  }

  // ── 3. 虚实像分界：u<f 与 u=f 时屏上一个光斑都不许有 ──
  for (const [u, f, why] of [[30, 50, 'u < f'], [50, 50, 'u = f']]) {
    const S = scene(u, f);
    const P = S.scr.state;
    const R = recCtx();
    S.scr.render(R.ctx);
    ok(P.onScreen === false && P.real === false && P.imgHeight === 0,
      `${why}（u=${S.uReal.toFixed(1)}、v=${isFinite(P.v) ? P.v.toFixed(1) : '∞'}）：onScreen=${P.onScreen}、imgHeight=${P.imgHeight} —— 没有实像`);
    ok(R.log.arcs.length === 0,
      `  屏上**一个光斑都没有**（arc 数 = ${R.log.arcs.length}）—— 改前这里会画出一个 ${(110 * 0.5).toFixed(0)}px 的大亮斑`);
    ok(R.log.texts.some(t => t.includes('接不到像')),
      `  屏上给出明确反馈：「${R.log.texts.find(t => t.includes('接不到像')) || '（没有）'}」 / ${P.reason}`);
  }

  // ── 4. 连续性：u 从 >2f 连续变到 f<u<2f，像高单调增、方向恒倒立；越过 f 立刻翻成「接不到」 ──
  let prevH = -1, monoH = true, allInv = true;
  const sweep = [];
  for (const u of [200, 150, 125, 100, 90, 80, 75, 70, 65, 60, 55, 52]) {
    const S = scene(u, 50);
    const P = S.scr.state;
    sweep.push(`u=${u}→h=${P.imgHeight.toFixed(2)}mm`);
    if (!(P.onScreen && P.inverted)) allInv = false;
    if (!(P.imgHeight > prevH)) monoH = false;
    prevH = P.imgHeight;
  }
  ok(allInv, `  u 从 4f 到 1.04f 全程 onScreen=true 且 inverted=true（${sweep.slice(0, 3).join('、')} … ${sweep.slice(-2).join('、')}）`);
  ok(monoH, `  像高随 u 减小而单调增大：${sweep.join(' ')}`);
  const below = scene(49, 50).scr.state;
  ok(below.onScreen === false && below.reason.includes('虚像'),
    `  u=f−1mm 立刻翻成「接不到像」（reason：${below.reason}）——这是课本上那段分界`);
  const beyond = scene(5, 50).scr.state;
  ok(beyond.onScreen === false, '  物几乎贴在透镜上（u=5mm≪f）：仍是虚像、屏上接不到');

  // ── 4b. 两段各自的放大率：u ≥ 2f 段 |m| ≤ 1、f < u < 2f 段 |m| > 1，符号恒为负 ──
  {
    const s1 = [200, 150, 125, 100].map(u => { const L = scene(u, 50).lens.state; return { m: L.m, a: L.mag }; });
    ok(s1.every(x => x.m < 0) && s1.every(x => x.a <= 1 + 1e-9) && s1.every((x, i) => i === 0 || x.a > s1[i - 1].a),
      `u ≥ 2f 段（缩小的倒立实像）：|m| = ${s1.map(x => x.a.toFixed(3)).join(' → ')}，全部 ≤1、随 u 减小单调增，m 全为负`);
    const s2 = [80, 75, 65, 60].map(u => { const L = scene(u, 50).lens.state; return { m: L.m, a: L.mag }; });
    ok(s2.every(x => x.m < 0) && s2.every(x => x.a > 1) && s2.every((x, i) => i === 0 || x.a > s2[i - 1].a),
      `f < u < 2f 段（放大的倒立实像）：|m| = ${s2.map(x => x.a.toFixed(3)).join(' → ')}，全部 >1、随 u 减小单调增，m 全为负`);
  }

  // ── 5. 边界：发光面越过透镜（u < 0）与物贴在透镜面上（u = 0）都不许虚构实像 ──
  {
    const S = scene(100, 50, 60);
    S.lens.x = S.src.x + 20;                     // 光源中心仍在透镜左侧，但发光面已越过透镜
    S.scr.x = S.lens.x + 60;
    S.world.step(1 / 120);
    const P = S.scr.state;
    ok(S.lens.state.u < 0 && P.onScreen === false && P.reason.includes('越过透镜'),
      `u=${S.lens.state.u.toFixed(1)}mm（发光面越过透镜）：onScreen=${P.onScreen}、reason=「${P.reason}」——不虚构正立实像`);
    // 原哨兵（写的是缺陷态：「thinLens(f,−28) 仍会给出 real=true/inverted=false」）
    // 在 task-47 修好缺陷后按纪律**升级成永久不变量**，不删、不留红。
    const neg = thinLens(50, -28);
    ok(neg.real === false && neg.inverted === false
      && S.lens.state.real === false && S.lens.state.inverted === false,
      `  代数面 ⟷ 光屏面同判：thinLens(f,−28).real=${neg.real}、.inverted=${neg.inverted}；`
      + `透镜 state.real=${S.lens.state.real}、state.inverted=${S.lens.state.inverted}（u ≤ 0 一律不成像）`);
    const atF = thinLens(50, 50), atZero = thinLens(50, 0);
    ok(atF.real === false && atF.inverted === false && atZero.real === false && atZero.inverted === false,
      `  u=f 与 u=0：m=−∞ / NaN 都不再给「倒立」—— thinLens(f,f).inverted=${atF.inverted}、`
      + `thinLens(f,0).inverted=${atZero.inverted}（isFinite 守卫）`);
  }

  // ── 6. 箭头几何纯函数 ──
  {
    const a1 = screenImageArrow({ onScreen: true, height: 12, signedH: -12, inverted: true }, 110);
    const barbs = [a1.head[0][1], a1.head[1][1]];
    ok(a1 && a1.tip[1] === -12 && barbs.every(y => Math.sign(y) === Math.sign(a1.tip[1]) && Math.abs(y) < Math.abs(a1.tip[1])),
      `箭头几何（实像）：tip=(${a1.tip})、箭头两翼 y=${barbs.map(y => y.toFixed(2)).join('/')}（与箭尖同侧、更靠近光轴 = 朝轴回收）`);
    const a2 = screenImageArrow({ onScreen: true, height: 300, signedH: -300, inverted: true }, 110);
    ok(Math.abs(a2.h - 49.5) < 1e-9 && Math.abs(a2.tip[1]) <= 49.5,
      `超大像（应 300mm）按屏面夹断到 ${a2.h}px，读数仍是真实 ${300}mm —— 画法与读数分离`);
    ok(screenImageArrow({ onScreen: false, height: 15, signedH: 15, inverted: false }, 110) === null,
      '接不到像时箭头几何为空（render 里因此一个图元都不画）');
  }
  info('改前实测：u=30mm(<f) 时屏上画的是 arc r=55px、alpha 0.55 的大亮斑（clamp(∞/2, 0.6, h/2)），');
  info('且 imgHeight=|m|·yO=15mm 没有任何「无实像」标志 —— 现在这两条都由 screenReading() 的判据挡住。');
}

// ══════════════════════════════════════════════════════════
console.log(`\n${'─'.repeat(56)}`);
if (fail === 0) console.log(`\x1b[32m全部通过：${pass} 项\x1b[0m`);
else console.log(`\x1b[31m通过 ${pass} 项，失败 ${fail} 项\x1b[0m`);
process.exit(fail === 0 ? 0 : 1);
