// ══════════════════════════════════════════════════════════
// 无头验证：电磁学器材（6 件）的方向场与几何
//
//   node tools/electromagnets-visual.mjs            # 常态：绿，exit 0
//   node tools/electromagnets-visual.mjs --mutate   # 红测：证明断言真的能红
//
// 与 tools/check.mjs / tools/equipment-optics.mjs 同一套写法：装插件 → 造场景 →
// 逐步推进 → 断言。这一组的断言刻意分成两类：
//
//   ① **两条互相独立的路径对撞**（同一条公式自己等于自己不算证据）：
//      · 指南针：纯函数 needleDegAt() ⟷ 世界里 Compass.step() 的 state.needleDeg
//      · 检验电荷：纯函数 testChargeForceDir() ⟷ 世界里 TestCharge.step() 的 state.forceDeg
//      · 磁体几何：poleWorld() 的解析极坐标 ⟷ poleFieldDir() 的旋转等变性
//   ② **不许被空集 / 零值骗过**（D35 / D37）：
//      凡断言「某量 ≈ 0 / 为 null / 全体满足」，都必须同时给出一个**该量 ≠ 0 的正控场景**
//      （例如 q = 0 → 不受力 的旁边，一定有 q = 2 → 受力 的读数）。
//
// ── `--mutate` 的退出码语义（别误读）──────────────────────
//   0 = N 条断言**全部按预期在变体上变红**（= 红测成功，断言确实有红的能力）
//   1 = 桩没生效 / 断言没红 / 锚点在正本里不唯一（= 红测失败）
// 变体一律用「读源码文本进内存 → 改一处 → 写 %TEMP% → import」造出来，
// **仓库零字节改动**（D43/D47）；并且先打印被改的行与变体的实际读数**证明桩生效**，再取读数。
//
// ── 探针自身的两条纪律（形状照 tools/lamp-thermal-probe.mjs）──────────
//   甲 源码判据 / 变异提取的输入一律先剥注释：`stripComments` 在**读取处统一剥**，
//      不是每条断言各自记得剥（注释里的字样不算「代码里有」）。
//   乙 开关只认 `--mutate`：任何别的开关都 **exit=2 明确报错** ——
//      不认识的开关 + exit=0 与「我验了」长得一模一样，空转的绿最难被发现。
// ══════════════════════════════════════════════════════════

import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

import { World } from '../src/core/world.js';
import { PluginHost } from '../src/core/plugin.js';
import { create, list, bindRegistry, equipmentPlugins } from '../src/equipment/index.js';
import em, * as emMod from '../src/equipment/electromagnets.js';

import physicsPlugin from '../src/physics/circuit.js';
import chemistryPlugin from '../src/chemistry/reactions.js';
import bridgePlugin from '../src/coupling/bridge.js';

// ── 未知开关 ⇒ 明确报错退出（不许静默忽略）──
// 理由：不认识的开关 + exit=0 与「我验了」长得一模一样 ⇒ 空转的绿最难被发现。
const known = new Set(['--mutate']);
const bad = process.argv.slice(2).filter((a) => !known.has(a));
if (bad.length) { console.log(`✗ 不认识的开关：${bad.join(' ')} —— 本探针只认 ${[...known].join(' / ')}`); process.exit(2); }

// ── 源码文本的读入口：`readCode` 的返回**已剥注释**（凡「源码里有 X」的判据与变异提取都用它）──
const stripComments = (s) => s.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

// ─────────────────────────────────────────────────────────
// 断言 / 输出
// ─────────────────────────────────────────────────────────
let pass = 0, fail = 0;
const ok = (cond, msg) => {
  if (cond) { pass++; console.log('  \x1b[32m✓\x1b[0m ' + msg); }
  else { fail++; console.log('  \x1b[31m✗\x1b[0m ' + msg); }
};
const head = (t) => console.log('\n\x1b[36m' + t + '\x1b[0m');
const near = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;
const dirOf = (d) => (d ? { x: d.x, y: d.y } : null);
const dirDeg = (d) => (d ? (emMod.deg(Math.atan2(d.y, d.x)) + 360) % 360 : null);
const rotV = (v, th) => ({ x: v.x * Math.cos(th) - v.y * Math.sin(th), y: v.x * Math.sin(th) + v.y * Math.cos(th) });

// ─────────────────────────────────────────────────────────
// D36：依赖文件的 sha256 + 字节数（运行首尾各取一次）
// ─────────────────────────────────────────────────────────
const REPO = new URL('../', import.meta.url);
const WATCH = ['src/equipment/electromagnets.js', 'src/equipment/index.js'];
const absOf = (rel) => fileURLToPath(new URL(rel, REPO));
const shaOf = (rel) => {
  const b = readFileSync(new URL(rel, REPO));
  return { file: rel, sha256: createHash('sha256').update(b).digest('hex'), bytes: b.length };
};
const shaLine = (tag) => {
  const rows = WATCH.map(shaOf);
  console.log(`SHA ${tag} ${JSON.stringify(rows)}`);
  return rows;
};
const readRaw = (rel) => readFileSync(new URL(rel, REPO), 'utf8');
const readCode = (rel) => stripComments(readRaw(rel));

// ══════════════════════════════════════════════════════════
// 绿测与红测**共用**的谓词 —— 红测拿的就是这一份（同一条断言在变体上失败才算红）
// ══════════════════════════════════════════════════════════
const PREDICATES = {
  /** F = sign(q)·E：q = +2 落在 +x 匀强场里，受力方向必须是 0° */
  forceSign(mod) {
    const f = mod.testChargeForceDir(2, 1, 0);
    const d = dirDeg(f);
    return { ok: d === 0, detail: `q=+2、E=+x → F 方向 ${d === null ? 'null' : d + '°'}（应为 0°）` };
  },
  /** flip = true 时 N 极必须跑到 −x 端（w = 130 ⇒ 极心在 ±60） */
  flipIgnored(mod) {
    const p = mod.poleWorld({ x: 0, y: 0, w: 130, angle: 0, flip: true });
    return {
      ok: near(p.n.x, -60) && near(p.s.x, 60),
      detail: `flip=true、w=130 → N 极 x=${p.n.x}、S 极 x=${p.s.x}（应为 −60 / +60）`,
    };
  },
};
/** 变体「未改动处仍与正本一致」的对照：证明变体不是整体坏掉，红的只是被改的那条 */
const CONTROL = (mod) => {
  const u = mod.uniformDir(0, false);
  return { ok: near(u.x, 1) && near(u.y, 0), detail: `uniformDir(0,false) = (${u.x}, ${u.y})` };
};

// ─────────────────────────────────────────────────────────
// 红测：仓库零字节改动地造变体
// ─────────────────────────────────────────────────────────
const MUTATIONS = {
  forceSign: {
    what: '检验电荷受力方向的符号（把 F = sign(q)·E 反转）',
    find: 'const s = q > 0 ? 1 : -1;',
    replace: 'const s = q > 0 ? -1 : 1;',
  },
  flipIgnored: {
    what: '磁极对调被忽略（flip 不再交换 N/S）',
    find: "const s = prop(src, 'flip') ? -1 : 1;",
    replace: 'const s = 1;',
  },
};

async function mutateRun() {
  console.log('红测模式：--mutate（读源码进内存 → 改一处 → 写 %TEMP% → import；仓库零字节改动）\n');
  const srcPath = new URL('src/equipment/electromagnets.js', REPO);
  const srcRaw = readFileSync(srcPath, 'utf8');            // 变异基质：要写进 %TEMP% 的真代码
  const srcCode = stripComments(srcRaw);                   // 提取器的输入：注释不是它的输入
  const entURL = pathToFileURL(absOf('src/core/entity.js')).href;
  const regURL = pathToFileURL(absOf('src/equipment/registry.js')).href;
  const dir = mkdtempSync(join(tmpdir(), 'xm-em-mutate-'));
  const keys = Object.keys(MUTATIONS);
  let observedRed = 0, ctrlBad = 0;

  for (const key of keys) {
    const m = MUTATIONS[key];
    head(`桩 ${key}：${m.what}`);
    const hitsRaw = srcRaw.split(m.find).length - 1;
    const hits = srcCode.split(m.find).length - 1;
    console.log(`  锚点在正本里出现 ${hits} 次（剥注释后；原始文本 ${hitsRaw} 次）—— 必须 = 1，否则先怀疑提取器）`);
    if (hits !== 1) { ok(false, `桩 ${key} 锚点不唯一：剥注释后 ${hits} 次（原始 ${hitsRaw} 次）`); continue; }
    if (hitsRaw !== hits) { ok(false, `桩 ${key} 的锚点也出现在注释里（原始 ${hitsRaw} ⟷ 剥后 ${hits}）⇒ 提取器可能改到注释上`); continue; }

    let txt = srcRaw.replace(m.find, m.replace);
    const e0 = txt.split("'../core/entity.js'").length - 1;
    const r0 = txt.split("'./registry.js'").length - 1;
    txt = txt.replace("'../core/entity.js'", `'${entURL}'`).replace("'./registry.js'", `'${regURL}'`);
    console.log(`  变体 import 改写：entity.js ${e0} 处、registry.js ${r0} 处（%TEMP% 里相对路径会解析错，必须改绝对 file://）`);
    ok(stripComments(txt).split(m.find).length - 1 === 0 && stripComments(txt).includes(m.replace),
      `桩落在**代码行**上：变体剥注释后旧行 0 处、新行在（不是把注释里的字样换掉了）`);

    const tmp = join(dir, `electromagnets.${key}.mjs`);
    writeFileSync(tmp, txt, 'utf8');
    console.log(`  变体文件：${tmp}`);
    console.log('  被改的行（正本 → 变体）：');
    console.log(`    - ${m.find}`);
    console.log(`    + ${m.replace}`);
    console.log('  变体文件里该行的实际内容：');
    for (const line of txt.split('\n')) if (line.trim() === m.replace) console.log(`    | ${line.trim()}`);

    let mod = null;
    try { mod = await import(pathToFileURL(tmp).href + '?v=' + key); }
    catch (e) { ok(false, `变体 import 失败：${e.message}`); continue; }

    const ctrl = CONTROL(mod);
    const r = PREDICATES[key](mod);           // ← 绿测用的同一份谓词
    console.log(`  变体读数（未改动处对照）：${ctrl.detail} → ${ctrl.ok ? '与正本一致 ✓' : '异常 ✗'}`);
    console.log(`  变体读数（被改处）：${r.detail}`);
    ok(!r.ok, `同一条断言在变体上${r.ok ? '仍然通过 ⇒ 桩没生效 / 断言没有红的能力' : '失败 ⇒ 红'}`);
    if (!ctrl.ok) ctrlBad++;
    if (!r.ok) observedRed++;
  }

  try { rmSync(dir, { recursive: true, force: true }); } catch { /* 文件可能还被占着 */ }
  shaLine('after');
  const expected = keys.length;
  const good = observedRed === expected && ctrlBad === 0;
  console.log(`\n${good ? '\x1b[32m' : '\x1b[31m'}红测${good ? '通过' : '失败'}：`
    + `${observedRed}/${expected} 条断言按预期在变体上变红，对照异常 ${ctrlBad} 条\x1b[0m`);
  console.log(`MUTATE_JSON ${JSON.stringify({ expectedRed: expected, observedRed, ctrlBad, ok: good })}`);
  process.exit(good ? 0 : 1);
}

// ─────────────────────────────────────────────────────────
// 绿测：无头宿主装插件（等价于浏览器里的引导过程）
// ─────────────────────────────────────────────────────────
const bootApp = {
  services: {}, ticks: [], world: null, selected: null,
  log: { push() {}, clear() {} }, toast() {},
  addTick(fn) { this.ticks.push(fn); return () => {}; },
};
const host = new PluginHost(bootApp);
for (const p of [physicsPlugin, chemistryPlugin, bridgePlugin, ...equipmentPlugins]) host.define(p);
host.installAll();
bindRegistry(host.registry('equipment'));

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

/**
 * 记录型画布：把 fill / stroke / fillText 连同**路径点**记下来。
 * 用途：把「渲染没抛错」升级成「画出来的东西是什么」—— 可视层的证据必须落在几何上。
 * 只记「谁在什么颜色下画了什么形状」，坐标一律是**当前变换下的局部坐标**（与渲染代码一致）。
 */
function recCtx() {
  const rec = { ops: [], path: [], txt: [] };
  const st = { fillStyle: '', strokeStyle: '', lineWidth: 1, font: '', textAlign: '', textBaseline: '' };
  const g = new Proxy({}, {
    get(_t, k) {
      switch (k) {
        case '__rec': return rec;
        case 'canvas': return { width: 800, height: 600 };
        case 'measureText': return () => ({ width: 10 });
        case 'beginPath': return () => { rec.path = []; };
        case 'moveTo': case 'lineTo': return (x, y) => rec.path.push({ x, y });
        case 'arcTo': return (x1, y1, x2, y2) => rec.path.push({ x: x1, y: y1 }, { x: x2, y: y2 });
        case 'arc': return (x, y, r) => rec.path.push({ x, y, r });
        case 'fill': return () => rec.ops.push({ op: 'fill', color: st.fillStyle, path: rec.path.slice() });
        case 'stroke': return () => rec.ops.push({ op: 'stroke', color: st.strokeStyle, lw: st.lineWidth, path: rec.path.slice() });
        case 'rotate': return (a) => rec.ops.push({ op: 'rotate', a });
        case 'translate': return (x, y) => rec.ops.push({ op: 'translate', x, y });
        case 'fillText': return (s, x, y) => rec.txt.push({ s, x, y, color: st.fillStyle, align: st.textAlign });
        default: return () => {};
      }
    },
    set(_t, k, v) { st[k] = v; return true; },
  });
  return g;
}
const bbox = (path) => {
  const xs = path.map(p => p.x), ys = path.map(p => p.y);
  return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
};
const fillsOf = (rec, color) => rec.ops.filter(o => o.op === 'fill' && o.color === color);
const strokesOf = (rec, color) => rec.ops.filter(o => o.op === 'stroke' && o.color === color);
/** 一条线段的走向（记录型画布下 stroke 路径只有首尾两点） */
const pathDir = (path) => ({ x: path[path.length - 1].x - path[0].x, y: path[path.length - 1].y - path[0].y });
const unitOf = (d) => { const L = Math.hypot(d.x, d.y) || 1; return { x: d.x / L, y: d.y / L }; };

/** 场景装配：与 main.js 的 loadScene 等价，但不依赖 DOM */function build(objs) {
  const world = new World();
  const ents = [];
  for (const o of objs) {
    const e = create(o.type, o.x, o.y);
    if (!e) { console.log('  !! 无法创建器材: ' + o.type); continue; }
    if (o.props) for (const k of Object.keys(o.props)) e.setProp(k, o.props[k]);
    world.add(e, true);
    ents.push(e);
  }
  const byType = (t) => ents.find(e => e.type === t);
  const step = (n = 1, dt = 1 / 120) => { for (let i = 0; i < n; i++) world.step(dt); };
  return { world, ents, byType, step };
}

const EM_TYPES = ['barmagnet', 'compass', 'charge', 'testcharge', 'efield', 'bfield'];
const mine = () => list().filter(d => EM_TYPES.includes(d.type));

async function greenRun() {
  console.log('命令：node tools/electromagnets-visual.mjs（常态绿）\n');
  shaLine('before');

  // ══════════════════════════════════════════════════════════
  head('① 插件与注册表');
  {
    ok(em.id === 'xiaomo.equipment.electromagnets', `插件 id = ${em.id}`);
    ok(em.kind === 'equipment' && em.domain === 'physics', `kind=${em.kind} domain=${em.domain}`);
    ok(em.builtin === true, 'builtin=true（内建插件，不来自市场）');
    ok(em.order === 36, `order=${em.order}（30/32/34 已被 optics/electronics/acoustics 占用，36 不撞）`);

    const defs = mine();
    ok(defs.length === 6, `注册了 ${defs.length} 件器材`);     // 计数先钉住：后面的 every() 才不是空集恒真
    ok(defs.every(d => d.domain === 'physics'), '全部 domain = physics');
    ok(defs.every(d => d.cat === '电磁'), '全部 cat = 电磁（器材栏会新出一组）');
    ok(EM_TYPES.every(t => defs.some(d => d.type === t)),
      '六件齐备：' + defs.map(d => d.type).join(' / '));

    const NEED = ['type', 'name', 'icon', 'domain', 'cat', 'desc', 'tags', 'w', 'h', 'ports', 'fields', 'defaults', 'state', 'create'];
    const missing = [];
    for (const d of defs) for (const k of NEED) if (d[k] === undefined || d[k] === null) missing.push(`${d.type}.${k}`);
    ok(missing.length === 0, missing.length ? '缺字段：' + missing.join(', ') : '每件器材的必需字段齐全');

    const badF = [], badD = [], thin = [];
    for (const d of defs) {
      for (const f of d.fields) {
        if (!f.k || !f.label || !f.type) badF.push(`${d.type}.${f.k || '?'} 缺 k/label/type`);
        if (f.type === 'range' && (typeof f.min !== 'number' || typeof f.max !== 'number')) badF.push(`${d.type}.${f.k} range 缺 min/max`);
        if (f.type === 'select' && (!Array.isArray(f.options) || !f.options.length)) badF.push(`${d.type}.${f.k} select 缺 options`);
      }
      for (const k of Object.keys(d.defaults)) if (!d.fields.some(f => f.k === k)) badD.push(`${d.type}.${k}`);
      if ((d.tags || []).length < 3 || !d.desc || d.desc.length < 20) thin.push(d.type);
    }
    ok(badF.length === 0, badF.length ? '字段不自洽：' + badF.join('; ') : '14 个字段全部自洽（range 有 min/max、select 有 options）');
    ok(badD.length === 0, badD.length ? 'defaults 里没有对应字段：' + badD.join(', ') : 'defaults 的每个键都在 fields 里有对应项（面板改得到）');
    ok(thin.length === 0, thin.length ? '标签/说明太薄：' + thin.join(', ') : '每件都有 ≥3 个标签与 ≥20 字说明');

    const bad = [];
    for (const d of defs) {
      const e = d.create(10, 20);
      if (!e || e.type !== d.type || e.x !== 10 || e.y !== 20) bad.push(d.type);
      else if (!e.hitTest(10, 20) || e.hitTest(999, 999)) bad.push(d.type + ' hitTest');
    }
    ok(bad.length === 0, bad.length ? 'create/命中异常：' + bad.join(', ') : '6 件都能在指定坐标创建，且该点能被自己命中（= 可选中、可拖动）');
  }

  // ══════════════════════════════════════════════════════════
  head('② 磁体几何：极坐标解析式 + 旋转等变性（poleWorld / poleFieldDir）');
  {
    const m0 = { x: 0, y: 0, w: 130, angle: 0, flip: false };
    const P0 = emMod.poleWorld(m0);
    ok(near(P0.n.x, 60) && near(P0.n.y, 0), `N 极在 +x 端：(${P0.n.x}, ${P0.n.y})，极心 ±(130/2−5) = ±60`);
    ok(near(P0.s.x, -60), `S 极在 −x 端：(${P0.s.x}, ${P0.s.y})`);
    const P90 = emMod.poleWorld({ ...m0, angle: 90 });
    ok(near(P90.n.y, 60) && near(P90.n.x, 0), `angle=90 → N 极转到 +y：(${P90.n.x.toFixed(6)}, ${P90.n.y})`);
    const Pf = emMod.poleWorld({ ...m0, flip: true });
    ok(near(Pf.n.x, -60) && near(Pf.s.x, 60), `flip=true → N/S 对调：N 极 x=${Pf.n.x}、S 极 x=${Pf.s.x}`);
    ok(near(emMod.angleBetween({ x: P0.n.x - P0.s.x, y: P0.n.y - P0.s.y }, { x: 1, y: 0 }), 0),
      '两极连线与磁体轴同向（几何自洽）');

    // 轴上 / 赤道：两个方向的解析值不同，且都不是 null（正控）
    const onAxis = emMod.poleFieldDir(m0, 200, 0);
    const equator = emMod.poleFieldDir(m0, 0, 200);
    ok(onAxis && near(dirDeg(onAxis), 0), `轴上 (200,0)：场向 ${dirDeg(onAxis)}°（沿 +x，远离 N 极）`);
    ok(equator && near(dirDeg(equator), 180), `赤道 (0,200)：场向 ${dirDeg(equator)}°（与 N 反向 = 指向 S 极一侧）`);
    ok(near(emMod.angleBetween(onAxis, equator), 180), '轴上与赤道的场向严格相差 180°（两个方向的解析值真的不同）');
    ok(emMod.angleBetween(null, onAxis) !== emMod.angleBetween(null, onAxis), 'angleBetween(null, ·) = NaN（无方向时不硬算夹角）');
    ok(emMod.poleFieldDir(m0, 60, 0) === null, '测点在 N 极上（r=0）：方向无定义 → null（不返回兜底方向）');
    ok(emMod.angleBetween(equator, equator) < 1e-9, 'angleBetween(·, ·) 自比为 0（NaN 的对照）');

    // 旋转等变性：转源 + 转测点 = 转结果（这条同时证明「局部坐标里画箭头」是等价变换）
    let worst = 0, n = 0;
    for (const th of [0, 30, 90, 137, 200, 300]) {
      const src = { x: 10, y: -20, w: 130, angle: th, flip: false };
      for (const p of [[40, 0], [0, 60], [-70, 20], [120, 90]]) {
        const rp = rotV({ x: p[0], y: p[1] }, emMod.rad(th));
        const a = emMod.poleFieldDir(src, 10 + rp.x, -20 + rp.y);
        const b = emMod.poleFieldDir({ ...src, x: 0, y: 0, angle: 0 }, p[0], p[1]);
        worst = Math.max(worst, emMod.angleBetween(a, b ? rotV(b, emMod.rad(th)) : null));
        n++;
      }
    }
    ok(n === 24 && worst < 1e-4, `旋转等变性：${n} 个「角度 × 测点」组合，最大偏差 ${worst.toExponential(2)}°（阈值 1e-4°，双精度噪声量级；真缺陷会是「度」级）`);

    // 真源抵消 → 不许造方向：两块磁铁 N 极相对，正中间是解析零点
    const A = { x: -100, y: 0, w: 130, angle: 0, flip: false };      // N 在 −40
    const B = { x: 100, y: 0, w: 130, angle: 180, flip: false };     // 转 180° ⇒ N 在 +40
    const zero = emMod.fieldDirAt([A, B], 0, 0, 0);
    ok(zero.ambient === true && zero.sources === 2,
      `两块磁铁 N 极相对、正中间：合场向恰好抵消 → 退到环境场（sources=${zero.sources}，不是空集路径）`);
    const nonZero = emMod.fieldDirAt([A], 0, 0, 0);
    ok(nonZero.ambient === false && nonZero.sources === 1,
      `正控：只留一块磁铁，同一点有真实场向 ${dirDeg(nonZero)}°（不是环境场）`);
  }

  // ══════════════════════════════════════════════════════════
  head('③ 指南针：纯函数 ⟷ 世界里实体 step() 的两条路径');
  {
    const mag = { x: 300, y: 300, w: 130, angle: 0, flip: false };
    const onAxis = emMod.needleDegAt([mag], 500, 300, 0);
    ok(near(emMod.wrap180(onAxis.deg - 0), 0), `轴上前方 (500,300)：针指向 ${onAxis.deg.toFixed(2)}° = 磁体轴方向`);
    const eq = emMod.needleDegAt([mag], 300, 500, 0);
    ok(near(emMod.angleBetween(dirOf({ x: Math.cos(emMod.rad(eq.deg)), y: Math.sin(emMod.rad(eq.deg)) }), { x: 1, y: 0 }), 180),
      `赤道侧方 (300,500)：针指向 ${eq.deg.toFixed(2)}°（与 N 反向，仍沿磁体轴）`);
    ok(near(emMod.angleBetween(
      dirOf({ x: Math.cos(emMod.rad(onAxis.deg)), y: Math.sin(emMod.rad(onAxis.deg)) }),
      dirOf({ x: Math.cos(emMod.rad(eq.deg)), y: Math.sin(emMod.rad(eq.deg)) })), 180),
      '轴前 0° 与赤道 180° 相差 180°：针真的在区分位置，不是常数');
    const flipped = emMod.needleDegAt([{ ...mag, flip: true }], 500, 300, 0);
    ok(near(emMod.wrap180(flipped.deg - onAxis.deg), 180) || near(emMod.wrap180(flipped.deg - onAxis.deg), -180),
      `磁极对调 → 针反向：${onAxis.deg.toFixed(2)}° → ${flipped.deg.toFixed(2)}°（差 180°）`);

    const none = emMod.needleDegAt([], 300, 300, 0);
    ok(none.ambient === true && near(none.deg, 0), '空集负控：附近没有磁体 → 跟着环境场 0°（并标 ambient=true）');
    const none90 = emMod.needleDegAt([], 300, 300, 90);
    ok(none90.ambient === true && near(none90.deg, 90), '上一条的正控：环境场设 90° → 针跟着 90°（不是恒 0）');

    // 世界路径：实体的 state.needleDeg 必须与纯函数逐位一致
    const S = build([
      { type: 'barmagnet', x: 300, y: 300, props: { angle: 0 } },
      { type: 'compass', x: 300, y: 500, props: { bodyAngle: 0, north: 0 } },
    ]);
    S.step(2);
    const c = S.byType('compass');
    ok(c.state.ambient === false && c.state.srcCount === 1, `实体路径：认到 ${c.state.srcCount} 个磁体、最近 ${c.state.srcDist.toFixed(0)} px`);
    ok(near(emMod.wrap180(c.state.needleDeg - eq.deg), 0), `实体 step() 的针向 ${c.state.needleDeg.toFixed(2)}° ⟷ 纯函数 ${eq.deg.toFixed(2)}°（两条独立路径一致）`);
    ok(near(c.state.deflection, 180), `偏转角 = ${c.state.deflection.toFixed(2)}°（本体 0° 与针向 180° 之差，归一在 (−180,180]）`);
    c.setProp('bodyAngle', 180);
    S.step(1);
    ok(near(c.state.deflection, 0) && near(emMod.wrap180(c.state.needleDeg - eq.deg), 0),
      `转本体不转针：bodyAngle=180 → 偏转 ${c.state.deflection.toFixed(2)}°、针向仍 ${c.state.needleDeg.toFixed(2)}°`);
    // world 路径必须吃实体 props 里的 angle（第一版漏了这个：src.angle 恒为 undefined）
    const S3 = build([
      { type: 'barmagnet', x: 300, y: 300, props: { angle: 90 } },
      { type: 'compass', x: 500, y: 300, props: { bodyAngle: 0, north: 0 } },
    ]);
    S3.step(2);
    const c3 = S3.byType('compass');
    const pure3 = emMod.needleDegAt([{ x: 300, y: 300, w: 130, angle: 90, flip: false }], 500, 300, 0);
    ok(near(emMod.wrap180(c3.state.needleDeg - pure3.deg), 0),
      `转过 90° 的磁体：实体 ${c3.state.needleDeg.toFixed(2)}° ⟷ 纯函数 ${pure3.deg.toFixed(2)}°（world 路径真的读了 props.angle）`);
    ok(near(emMod.angleBetween(dirOf({ x: Math.cos(emMod.rad(c3.state.needleDeg)), y: Math.sin(emMod.rad(c3.state.needleDeg)) }), { x: 0, y: 1 }), 180),
      `东侧 (500,300) 遇转 90° 的磁体：针指 ${c3.state.needleDeg.toFixed(2)}°，与磁体轴（90°）相差 180°（赤道处场向与 N 反向）`);

    const S2 = build([{ type: 'compass', x: 0, y: 0, props: { north: 90 } }]);
    S2.step(1);
    ok(S2.byType('compass').state.ambient === true, '世界路径的空场负控：场上没有磁体 → ambient=true（不是 srcCount=0 却报 -90）');
  }

  // ══════════════════════════════════════════════════════════
  head('④ 正负电荷：方向场随 q 的符号（chargeFieldDir）');
  {
    const p = emMod.chargeFieldDir([{ x: 0, y: 0, q: 2 }], 10, 0);
    const n = emMod.chargeFieldDir([{ x: 0, y: 0, q: -2 }], 10, 0);
    ok(p && near(dirDeg(p), 0), `正电荷右侧：场向 ${dirDeg(p)}°（径向朝外）`);
    ok(n && near(dirDeg(n), 180), `负电荷右侧：场向 ${dirDeg(n)}°（径向朝里）`);
    ok(near(emMod.angleBetween(p, n), 180), '同一点上 +q 与 −q 的场向严格相差 180°');
    ok(emMod.chargeFieldDir([{ x: 0, y: 0, q: 0 }], 10, 0) === null, 'q = 0 负控：不产生电场 → null');
    ok(emMod.chargeFieldDir([], 10, 0) === null, '空集负控：没有电荷 → null');
    ok(emMod.chargeFieldDir([{ x: 0, y: 0, q: 2 }], 0, 0) === null, '测点落在电荷上（r = 0）→ null，不返回兜底方向');
    ok(p !== null && n !== null, '上面三条 null 的正控：同一函数在 q=±2、r>0 时都给出确定方向');

    const pair = emMod.chargeFieldDir([{ x: -50, y: 0, q: 3 }, { x: 50, y: 0, q: -3 }], 0, 0);
    ok(pair && near(dirDeg(pair), 0), `正负电荷中点：场向 ${dirDeg(pair)}°（由 + 指向 −，课本里的电场线走向）`);
    const a1 = emMod.chargeFieldDir([{ x: 0, y: 0, q: 1 }], 30, 40);
    const a2 = emMod.chargeFieldDir([{ x: 0, y: 0, q: 7 }], 30, 40);
    ok(near(emMod.angleBetween(a1, a2), 0), 'q 放大 7 倍、方向逐位不变 —— 本插件只给方向（大小不可观测，D44）');

    // 世界路径：器材的 state 与纯函数同判
    const S = build([{ type: 'charge', x: 0, y: 0, props: { q: -3 } }]);
    S.step(1);
    const ch = S.byType('charge');
    ok(ch.state.sign === -1 && near(ch.state.qAbs, 3), `实体：sign=${ch.state.sign}、|q|=${ch.state.qAbs}`);
    ok(ch.state.lineCount === 8, `实体：画 ${ch.state.lineCount} 条方向箭头（showField 打开且 q≠0）`);
    ch.setProp('q', 0);
    S.step(1);
    ok(ch.state.sign === 0 && ch.state.lineCount === 0 && ch.state.fieldDefined === false,
      '实体：q 改成 0 → sign=0、箭头 0、fieldDefined=false（与纯函数的 null 同判）');
    ch.setProp('q', 1);
    S.step(1);
    ok(ch.state.sign === 1 && ch.state.lineCount === 8, '正控：q 改回 +1 → sign=1、箭头回到 8（不是一直 0）');
  }

  // ══════════════════════════════════════════════════════════
  head('⑤ 匀强电场区：场向（uniformDir）+ 区域包含判定');
  {
    const u0 = emMod.uniformDir(0, false), u90 = emMod.uniformDir(90, false), uf = emMod.uniformDir(37, true);
    ok(near(u0.x, 1) && near(u0.y, 0), `θ=0 未反向 → (${u0.x}, ${u0.y})`);
    ok(near(u90.x, 0) && near(u90.y, 1), `θ=90 → (${u90.x.toFixed(12)}, ${u90.y})`);
    ok(near(emMod.angleBetween(u0, emMod.uniformDir(0, true)), 180), 'flip 未变：θ=0 + flip → 严格反向 180°');
    ok(near(emMod.angleBetween(emMod.uniformDir(37, false), uf), 180), `θ=37 + flip → 反向 180°（${dirDeg(emMod.uniformDir(37, false))}° → ${dirDeg(uf)}°）`);

    // 形状契约：所有「给方向」的导出必须返回同一个形状 {x, y}
    // （D49：探针的提取器先怀疑自己 —— 这条断言把「两种形状混用」这种坑钉成红灯）
    const DIR_FNS = {
      axisOf: () => emMod.axisOf(30),
      poleFieldDir: () => emMod.poleFieldDir({ x: 0, y: 0, w: 130, angle: 0, flip: false }, 0, 200),
      chargeFieldDir: () => emMod.chargeFieldDir([{ x: 0, y: 0, q: 1 }], 10, 0),
      testChargeForceDir: () => emMod.testChargeForceDir(1, 1, 0),
      uniformDir: () => emMod.uniformDir(0, false),
      fieldDirAt: () => emMod.fieldDirAt([], 0, 0, 30),
    };
    const shapes = Object.entries(DIR_FNS).map(([k, f]) => ({ k, d: f() }));
    ok(shapes.length === 6 && shapes.every(s => typeof s.d.x === 'number' && typeof s.d.y === 'number'),
      `形状契约：${shapes.length} 个给方向的导出全部返回 {x, y}（形状漂移会在这里变红）`);

    const reg = create('efield', 400, 400);
    ok(reg.w === 170 && reg.h === 170, `区域几何 ${reg.w}×${reg.h}（与 hitTest 的矩形同形，不另造一套）`);
    ok(reg.hitTest(400, 400) && reg.hitTest(400 + 84, 400) && !reg.hitTest(400 + 86, 400),
      '包含判定：中心与 ±84 在内、±86 在外（半宽 85）');
    reg.step(1 / 120, null);
    ok(near(reg.state.fieldDeg, 0), `区域 state.fieldDeg = ${reg.state.fieldDeg}°`);
    reg.setProp('angle', 90); reg.setProp('flip', true); reg.step(1 / 120, null);
    ok(near(reg.state.fieldDeg, 270), `θ=90 + flip → state.fieldDeg = ${reg.state.fieldDeg}°（与 uniformDir 同判）`);
  }

  // ══════════════════════════════════════════════════════════
  head('⑥ 检验电荷：F = sign(q)·E 的两条独立路径 + 负控/正控');
  {
    const u = emMod.uniformDir(0, false);
    const fP = emMod.testChargeForceDir(1.5, u.x, u.y);
    const fN = emMod.testChargeForceDir(-1.5, u.x, u.y);
    ok(fP && near(dirDeg(fP), 0), `A 路径：q=+1.5 在 +x 场里 → F 方向 ${dirDeg(fP)}°`);
    ok(fN && near(dirDeg(fN), 180), `A 路径：q=−1.5 → F 方向 ${dirDeg(fN)}°`);
    ok(near(emMod.angleBetween(fP, fN), 180), '正负检验电荷的受力方向严格相差 180°');
    ok(emMod.testChargeForceDir(0, 1, 0) === null, 'A 路径负控：q = 0 → null（不受力）');
    ok(emMod.testChargeForceDir(2, 0, 0) === null, 'A 路径负控：E 方向为零 → null（不返回兜底方向）');
    ok(fP !== null && fN !== null, '上面两条 null 的正控：q≠0 且 E≠0 时两条都给出确定方向');
    ok(near(emMod.angleBetween(emMod.testChargeForceDir(3, u.x, u.y), emMod.testChargeForceDir(99, u.x, u.y)), 0),
      '|q| 放大 33 倍，F 方向不变（只给方向，不给大小）');

    // B 路径：世界里的实体 step() 读数
    const S = build([
      { type: 'efield', x: 400, y: 400, props: { angle: 0, flip: false } },
      { type: 'testcharge', x: 400, y: 400, props: { q: 1.5 } },
    ]);
    S.step(2);
    const tc = S.byType('testcharge');
    ok(tc.state.nRegions === 1 && tc.state.inField === true, `B 路径：落在 ${tc.state.nRegions} 个场区里`);
    ok(tc.state.forceDeg !== null && near(tc.state.forceDeg, 0), `B 路径：实体 step() 给出受力方向 ${tc.state.forceDeg}°`);
    ok(near(emMod.wrap180(tc.state.forceDeg - dirDeg(fP)), 0),
      `A/B 两条独立路径一致：纯函数 ${dirDeg(fP)}° ⟷ 实体 ${tc.state.forceDeg}°`);

    tc.setProp('q', -1.5); S.step(1);
    ok(tc.state.forceDeg !== null && near(tc.state.forceDeg, 180), `B 路径：q 改负 → 受力方向 ${tc.state.forceDeg}°`);
    tc.setProp('q', 0); S.step(1);
    ok(tc.state.force === null && tc.state.forceDeg === null, 'B 路径负控：q 改成 0 → 不受力（force=null）');
    ok(tc.state.reason.includes('q = 0'), `负控文案：${tc.state.reason}`);
    tc.setProp('q', 1.5); tc.x = 900; tc.y = 900; S.step(1);
    ok(tc.state.force === null && tc.state.nRegions === 0, 'B 路径负控：拖到场区外 → 不受力（inField=false）');
    tc.x = 400; tc.y = 400; S.step(1);
    ok(tc.state.forceDeg !== null, '正控：拖回场区内 → 受力方向回来（上面三条 null 不是恒 null）');

    // 抵消：两个反向匀强区重叠 → 合场向为零 → 不受力（物理上就是叠加为零）
    const S2 = build([
      { type: 'efield', x: 400, y: 400, props: { angle: 0, flip: false } },
      { type: 'efield', x: 400, y: 400, props: { angle: 0, flip: true } },
      { type: 'testcharge', x: 400, y: 400, props: { q: 2 } },
    ]);
    S2.step(2);
    const t2 = S2.byType('testcharge');
    ok(t2.state.nRegions === 2 && t2.state.force === null, `两个反向场区重叠（nRegions=${t2.state.nRegions}）→ 合场向为零 → 不受力`);
    ok(t2.state.reason.includes('抵消'), `抵消文案：${t2.state.reason}`);

    // 点电荷那条支路
    const S3 = build([
      { type: 'charge', x: 300, y: 300, props: { q: 3 } },
      { type: 'testcharge', x: 400, y: 300, props: { q: 1 } },
    ]);
    S3.step(2);
    const t3 = S3.byType('testcharge');
    ok(t3.state.nCharges === 1 && t3.state.forceDeg !== null && near(t3.state.forceDeg, 0),
      `点电荷支路：正电荷右侧 → 受力方向 ${t3.state.forceDeg}°（斥力，沿 +x）`);
    S3.byType('charge').setProp('q', -3); S3.step(1);
    ok(near(t3.state.forceDeg, 180), `把源电荷改成负 → 受力方向 ${t3.state.forceDeg}°（吸引，沿 −x）`);
    ok(near(emMod.angleBetween(dirOf(t3.state.force), { x: 1, y: 0 }), 180), '同上，用方向向量核一遍');
  }

  // ══════════════════════════════════════════════════════════
  head('⑦ 匀强磁场区：·（向外）/ ×（向里）');
  {
    const S = build([{ type: 'bfield', x: 500, y: 500, props: { dir: 'out' } }]);
    S.step(1);
    const b = S.byType('bfield');
    ok(b.state.symbol === '·' && b.state.outOfPage === true, `dir=out → 符号「${b.state.symbol}」、outOfPage=true`);
    b.setProp('dir', 'into'); S.step(1);
    ok(b.state.symbol === '×' && b.state.outOfPage === false, `dir=into → 符号「${b.state.symbol}」、outOfPage=false`);
    b.setProp('spacing', 40);
    ok(b.props.spacing === 40 && b.hitTest(500, 500), '符号间距可调、区域本身可命中（可拖动/选中）');
  }

  // ══════════════════════════════════════════════════════════
  head('⑧ 渲染冒烟：6 件 × 两种开关状态各画一帧');
  {
    const ctx = mockCtx();
    const S = build(EM_TYPES.map((t, i) => ({ type: t, x: 100 + i * 150, y: 300 })));
    const errs = [];
    let drawn = 0;
    for (const e of S.ents) {
      try { e.render(ctx, S.world); drawn++; } catch (err) { errs.push(`${e.type} 待机帧: ${err.message}`); }
    }
    S.step(2);
    for (const e of S.ents) {
      if ('showField' in e.props) e.setProp('showField', false);
      if ('showPlates' in e.props) e.setProp('showPlates', false);
      try { e.render(ctx, S.world); drawn++; } catch (err) { errs.push(`${e.type} 关采样帧: ${err.message}`); }
    }
    ok(errs.length === 0, errs.length ? '渲染抛错：' + errs.join('; ') : `${drawn} 次 render()（6 件 × 待机/关采样）全部跑通`);
    ok(drawn === 12, `渲染次数 ${drawn}（6 件 × 2 态），不是空循环`);
  }

  // ══════════════════════════════════════════════════════════
  head('⑧b 画出来的几何：记录型画布把 fill/stroke/fillText 连坐标记下来再断言');
  {
    // 这一节是「画得出、看得见」的硬证据：不只跑通，还断言**画出来的形状与朝向**

    // ── 条形磁铁：红 N 半 / 蓝 S 半 / 字母 / 14 支方向采样箭头 ──
    const m = build([{ type: 'barmagnet', x: 0, y: 0, props: { angle: 0, flip: false, showField: true } }]).ents[0];
    let g = recCtx();
    m.render(g);
    const red = fillsOf(g.__rec, '#ef5350'), blue = fillsOf(g.__rec, '#4d7fea');
    ok(red.length === 1 && blue.length === 1, `磁体两半各是一块填充：红 ${red.length} 块 / 蓝 ${blue.length} 块`);
    const bN = red[0] && bbox(red[0].path), bS = blue[0] && bbox(blue[0].path);
    ok(bN && bN.x0 >= -0.001 && bN.x1 <= 65.001 && near(bN.y0, -17) && near(bN.y1, 17),
      `红（N）半画在 +x：x ∈ [${bN.x0}, ${bN.x1}]、y ∈ [${bN.y0}, ${bN.y1}]（半宽 65、厚 34）`);
    ok(bS && bS.x1 <= 0.001 && near(bS.x0, -65), `蓝（S）半画在 −x：x ∈ [${bS.x0}, ${bS.x1}]`);
    const tN = g.__rec.txt.find(t => t.s === 'N'), tS = g.__rec.txt.find(t => t.s === 'S');
    ok(!!tN && tN.x > 0 && !!tS && tS.x < 0, `字母也跟着分左右：N 在 x=${tN && tN.x}、S 在 x=${tS && tS.x}`);
    const dots = fillsOf(g.__rec, 'rgba(127,212,255,.55)'), arrs = strokesOf(g.__rec, 'rgba(127,212,255,.85)');
    ok(dots.length === 14 && arrs.length === 14,
      `方向场采样：5×3 格去掉磁体内部那一格 = ${dots.length} 个采样点、${arrs.length} 支箭头`);
    ok(arrs.every(o => Math.hypot(pathDir(o.path).x, pathDir(o.path).y) > 10),
      '每支采样箭头都有实际长度（不是零长度占位）');

    m.setProp('flip', true); g = recCtx(); m.render(g);
    const fN = bbox(fillsOf(g.__rec, '#ef5350')[0].path), fS = bbox(fillsOf(g.__rec, '#4d7fea')[0].path);
    ok(fN.x1 <= 0.001 && fS.x0 >= -0.001, `flip=true → 红蓝左右互换：红 x ∈ [${fN.x0}, ${fN.x1}]、蓝 x ∈ [${fS.x0}, ${fS.x1}]`);
    ok(g.__rec.txt.find(t => t.s === 'N').x < 0, 'flip=true → 字母 N 也换到了左边');

    // ── 指南针：画出来的针尖朝向 = state.needleDeg = 纯函数（第三条独立路径）──
    const S1 = build([
      { type: 'barmagnet', x: 0, y: 0, props: { angle: 0 } },
      { type: 'compass', x: 0, y: 300 },
    ]);
    S1.step(2);
    const cp = S1.byType('compass');
    g = recCtx(); cp.render(g);
    const needle = fillsOf(g.__rec, '#ef5350')[0];
    const apex = needle && needle.path[0];
    const apexDeg = apex ? (emMod.deg(Math.atan2(apex.y, apex.x)) + 360) % 360 : null;
    ok(needle && near(emMod.angleBetween(apex, { x: Math.cos(emMod.rad(cp.state.needleDeg)), y: Math.sin(emMod.rad(cp.state.needleDeg)) }), 0),
      `画出来的针尖 ${apexDeg.toFixed(2)}° ⟷ state.needleDeg ${cp.state.needleDeg.toFixed(2)}°（渲染/状态/纯函数三路一致）`);
    ok(apex && near(Math.hypot(apex.x, apex.y), 0.78 * 37), `针尖落在半径 ${apex ? Math.hypot(apex.x, apex.y).toFixed(2) : '?'} = 0.78 × 37`);
    ok(strokesOf(g.__rec, '#39434d').length === 1, '刻度盘外圈画了 1 个圆（strokeStyle = EDGE）');
    ok(strokesOf(g.__rec, '#aab4be').length === 4, '24 个刻度里恰好 4 个长刻度用亮色（0/6/12/18）');

    // ── 电荷：8 支箭头的**朝向**（点积符号）而不是只数个数 ──
    const S2 = build([{ type: 'charge', x: 0, y: 0, props: { q: 3, showField: true } }]);
    S2.step(1);
    const ch = S2.byType('charge');
    const chargeArrows = () => {
      const gg = recCtx(); ch.render(gg);
      return strokesOf(gg.__rec, 'rgba(127,212,255,.85)')
        .map(o => { const d = pathDir(o.path), p = o.path[0]; return d.x * p.x + d.y * p.y; });
    };
    const out3 = chargeArrows();
    ok(out3.length === 8 && out3.every(v => v > 0),
      `q=+3：8 支箭头全部朝外（「方向·位置」点积最小 ${Math.min(...out3).toFixed(1)} > 0）`);
    ch.setProp('q', -3); S2.step(1);
    const in3 = chargeArrows();
    ok(in3.length === 8 && in3.every(v => v < 0),
      `q=−3：8 支箭头全部朝里（点积最大 ${Math.max(...in3).toFixed(1)} < 0）`);
    ch.setProp('q', 0); S2.step(1);
    const g0 = recCtx(); ch.render(g0);
    ok(strokesOf(g0.__rec, 'rgba(127,212,255,.85)').length === 0, 'q=0 负控：一支箭头都不画（正控是上面的 8 支）');
    ok(fillsOf(g0.__rec, '#6b7480').length === 1 && g0.__rec.txt.some(t => t.s === '0'),
      'q=0：圆点转成灰色、字写成「0」');

    // ── 匀强电场：4 支箭头朝向 + 两块极板位置 + 「区域转了场向跟着转」──
    const S3 = build([{ type: 'efield', x: 0, y: 0, props: { angle: 0, flip: false } }]);
    S3.step(1);
    const ef = S3.byType('efield');
    const efArrows = () => {
      const gg = recCtx(); ef.render(gg);
      return {
        dirs: strokesOf(gg.__rec, '#7fd4ff').map(o => unitOf(pathDir(o.path))),
        rot: gg.__rec.ops.filter(o => o.op === 'rotate'),
        plates: fillsOf(gg.__rec, '#c9d3dd').map(o => bbox(o.path)),
      };
    };
    let E = efArrows();
    ok(E.dirs.length === 4 && E.dirs.every(d => near(d.x, 1) && near(d.y, 0)), 'θ=0：4 支箭头全部指向 +x');
    ok(E.plates.length === 2 && near(E.plates[0].x0, -74.4) && near(E.plates[1].x1, 74.4),
      `两块极板画在 x ∈ [${E.plates[0].x0}, ${E.plates[1].x1}]（±0.42×170 ∓3）`);
    ef.setProp('flip', true); S3.step(1);
    E = efArrows();
    ok(E.dirs.length === 4 && E.dirs.every(d => near(d.x, -1) && near(d.y, 0)), 'flip：4 支箭头全部指向 −x');
    ef.setProp('angle', 90); ef.setProp('flip', false); S3.step(1);
    E = efArrows();
    ok(E.rot.length === 1 && near(E.rot[0].a, Math.PI / 2), `θ=90：区域整体转了 ${(E.rot[0].a * 180 / Math.PI).toFixed(1)}°`);
    ok(E.dirs.length === 4 && E.dirs.every(d => near(d.x, 1) && near(d.y, 0)),
      'θ=90：箭头在**局部坐标**里仍是 +x —— 区域转了，箭头跟着转（不是原地不动）');
    ok(near(ef.state.fieldDeg, 90), `θ=90：state.fieldDeg = ${ef.state.fieldDeg}°（世界口径，与局部画法互为印证）`);

    // ── 匀强磁场：· / × 的符号数量与形状 ──
    const S4 = build([{ type: 'bfield', x: 0, y: 0, props: { dir: 'into', spacing: 26 } }]);
    S4.step(1);
    const bf = S4.byType('bfield');
    g = recCtx(); bf.render(g);
    const into = strokesOf(g.__rec, 'rgba(150,190,255,.9)');
    ok(into.length === 48, `×（垂直纸面向里）：6 列 × 4 行 = 24 个符号 × 2 笔 = ${into.length} 条线段`);
    ok(into.every(o => near(o.lw, 1.6)), '× 的每一笔线宽都是 1.6');
    bf.setProp('dir', 'out'); S4.step(1);
    g = recCtx(); bf.render(g);
    const outer = fillsOf(g.__rec, 'rgba(150,190,255,.9)');
    ok(outer.length === 24 && outer.every(o => near(o.path[0].r, 3.4)), `·（垂直纸面向外）：${outer.length} 个空心圆（r = 3.4）`);
    ok(fillsOf(g.__rec, '#101820').length === 24 && fillsOf(g.__rec, '#101820').every(o => near(o.path[0].r, 1.2)),
      '每个圆圈里还有一个实心小点（r = 1.2）—— 「·」不是空圆');
    ok(fillsOf(g.__rec, 'rgba(127,212,255,.06)').length === 1, '两个场区共用同一种虚线框底纹（本帧 1 个）');
  }

  // ══════════════════════════════════════════════════════════
  head('⑨ 与现有器材一致：拖动 = 平移、属性面板 = 几何联动');
  {
    const e = create('barmagnet', 100, 100);
    const b0 = emMod.poleWorld(e);
    e.x += 40; e.y -= 25;
    const b1 = emMod.poleWorld(e);
    ok(near(b1.n.x - b1.s.x, b0.n.x - b0.s.x) && near(b1.n.y - b1.s.y, b0.n.y - b0.s.y),
      '拖动只平移：两极的相对几何逐位不变（不是绕着别处转）');
    ok(near(b1.n.x, b0.n.x + 40) && near(b1.n.y, b0.n.y - 25), `两极跟着走：N 极位移 (+40, −25) = 器材位移`);
    ok(e.hitTest(e.x, e.y) && !e.hitTest(e.x + 200, e.y), '拖到哪都能被自己命中（选中/拖动走的是基类 hitTest）');

    const g1 = create('barmagnet', 0, 0);
    g1.setProp('angle', 90); g1.step(1 / 120, null);
    ok(near(g1.state.poleN.y, 60) && near(g1.state.poleN.x, 0), `setProp(angle,90) → state.poleN 跟到 (${g1.state.poleN.x.toFixed(6)}, ${g1.state.poleN.y})`);
    g1.setProp('flip', true); g1.step(1 / 120, null);
    ok(near(g1.state.poleN.y, -60), `再 setProp(flip,true) → state.poleN 翻到 y=${g1.state.poleN.y}（面板与几何双向联动）`);
    ok(near(g1.state.poleGap, 120), `两极间距读数字段 poleGap = ${g1.state.poleGap}（130 − 2×5）`);

    // 实体当源 ⟷ 纯参数对象当源：器材把 angle/flip 放在 props 里，场函数两种源都必须吃
    const ee = create('barmagnet', 0, 0);
    ee.setProp('angle', 90);
    const pe = emMod.poleWorld(ee);
    const pp = emMod.poleWorld({ x: 0, y: 0, w: ee.w, angle: 90, flip: false });
    ok(near(pe.n.x, pp.n.x) && near(pe.n.y, pp.n.y),
      `实体当源 ⟷ 纯对象当源：N 极都在 (${pe.n.x.toFixed(6)}, ${pe.n.y})（实体把 angle 放在 props 里）`);
    ok(near(pe.n.y, 60) && near(pe.n.x, 0), '转过 90° 的实体，极坐标真的跟着转（读 src.angle 会恒得 0°）');
    ee.setProp('flip', true);
    ok(near(emMod.poleWorld(ee).n.y, -60), `实体 flip=true → N 极翻到 y=${emMod.poleWorld(ee).n.y}（对调在实体路径上同样生效）`);

    const c1 = create('compass', 0, 0);
    c1.setProp('north', 45); c1.step(1 / 120, { entities: [] });
    ok(near(c1.state.needleDeg, 45) && c1.state.ambient === true,
      `空世界里指南针跟着环境场：needleDeg=${c1.state.needleDeg}°（world 为空数组也不抛错）`);
    c1.step(1 / 120, null);
    ok(c1.state.needleDeg === 45, 'step(dt, null) 也不抛错（check.mjs 会以各种 world 调 step）');
  }

  // ══════════════════════════════════════════════════════════
  head('⑩ 可单独启停：停用只摘本插件，别的器材不动');
  {
    const mineCount = () => host.registry('equipment').list().filter(d => EM_TYPES.includes(d.type)).length;
    const total = host.registry('equipment').list().length;
    ok(mineCount() === 6 && total > 80, `初始：注册表共 ${total} 件，本插件 ${mineCount()} 件`);
    ok(host.disable('xiaomo.equipment.electromagnets') === true, "disable('xiaomo.equipment.electromagnets') 返回 true");
    ok(mineCount() === 0, `停用后：本插件器材 ${mineCount()} 件（器材栏里一起消失）`);
    ok(host.registry('equipment').list().length === total - 6 && host.registry('equipment').has('battery'),
      `停用只影响本插件：${total - 6} 件仍在（electrical 的 battery 还在）`);
    ok(host.enable('xiaomo.equipment.electromagnets') === true && mineCount() === 6,
      `重新启用后：本插件器材回到 ${mineCount()} 件（不翻倍、不残留）`);
    const after = host.registry('equipment').list();
    ok(new Set(after.map(d => d.type)).size === after.length, '启用后注册表里没有重复 type（拆除干净，不是叠加）');
  }

  // ══════════════════════════════════════════════════════════
  head('⑪ 绿测与红测共用的两条谓词（--mutate 拿的就是这一份）');
  for (const [k, fn] of Object.entries(PREDICATES)) {
    const r = fn(emMod);
    ok(r.ok, `${k}：${r.detail}`);
  }
  {
    const c = CONTROL(emMod);
    ok(c.ok, `对照（变体里必须仍与正本一致）：${c.detail}`);
  }

  // ══════════════════════════════════════════════════════════
  head('⑫ 探针自身的纪律自检：源码判据的输入必须先剥注释');
  {
    const RAW = readRaw(WATCH[0]);                    // ← 红测真正读的那一份
    const CODE = readCode(WATCH[0]);
    const MARK = 'XIAOMO_STRIP_SELFCHECK';
    const injected = `      // ${MARK}\n` + RAW;        // 注释注进**真被读的文本**里，不是另造一个字符串
    ok(CODE !== RAW && CODE.length < RAW.length,
      `正控（非空转）：剥注释确实动过真源码文本 ${Buffer.byteLength(RAW)} → ${Buffer.byteLength(CODE)} B`);
    ok(injected.includes(MARK) && !stripComments(injected).includes(MARK),
      `注入一条含标志词的注释 ⇒ 不过滤时看得见（${injected.includes(MARK)}），剥注释后它不在判据的输入里（${!stripComments(injected).includes(MARK)}）`);
  }

  const after = shaLine('after');
  const before = shaOf(WATCH[0]);
  console.log(`\n\x1b[1m全部通过：${pass} 项\x1b[0m` + (fail ? `  \x1b[31m失败 ${fail} 项\x1b[0m` : ''));
  console.log(`ELECTROMAGNETS_JSON ${JSON.stringify({
    ok: fail === 0, pass, fail,
    files: after,
    electromagnetsSha256: before.sha256,
  })}`);
  process.exit(fail ? 1 : 0);
}

if (process.argv.includes('--mutate')) await mutateRun();
else await greenRun();
