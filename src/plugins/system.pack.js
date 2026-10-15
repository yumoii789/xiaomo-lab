// ══════════════════════════════════════════════════════════
// 器材包 —— 让用户自己往实验室里加器材
//
// 器材包是**纯 JSON 数据**：不 eval、不 import、不解压脚本，
// 所以导入陌生人做的包永远是安全的。包里的每件器材都要
// 声明它派生自哪个已有原型（proto），行为全部继承，
// 只覆盖你写明的名称、尺寸、端口、默认参数和可调字段。
//
// 存储：localStorage['xiaomo.packs.v1']
//
// 完整性 —— 注意它**不是真实性**：
//   本地文件导入没有签名，所以这里能证明的只有两件事：
//     ① 我导入的这一份和我以为的一致（包内声明的 sha256，导入时核对）；
//     ② 我每次启动装的还是当初装的那一份（安装时自算指纹 _fp，回放时核对）。
//   它证明不了「作者是谁」，所以文档里也不许这么写。
// ══════════════════════════════════════════════════════════

import { derive, get, remove } from '../equipment/registry.js';

const KEY = 'xiaomo.packs.v1';
const FORMAT = 'xiaomo.equipment.pack';
const FORMAT_VERSION = 1;

// ─────────────────────────────────────────────────────────
// 指纹：规范化器材数组 + sha256
//
// 为什么哈希「规范化后的 equipment」而不是文件字节：
//   JSON 的空白、缩进、键顺序一改字节就变，可包的内容一个字都没改 ——
//   字节哈希对手写的、或被小工具重新序列化过的包只会整天误报。
//
// 为什么手写 sha256（而不是复用 src/core/market.js 的 sha256Hex）：
//   那一个走 crypto.subtle，**是 Promise**；而 install() 必须保持同步 ——
//   社区插件 market/plugins/equipment-booster.js:74 正是
//   `const r = packs.install(PACK, { silent: true }); if (!r.ok) …`
//   这样同步读返回值的，把校验改成异步会当场打断它。
//   手写的密码学必须自证：tools/pack-probe.html 用 crypto.subtle 对同一串
//   字节独立算一遍并断言逐字符相等；Node 侧另有对照。
// ─────────────────────────────────────────────────────────

const SHA_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
const rotr = (x, n) => (x >>> n) | (x << (32 - n));

/** 同步 sha256（小写十六进制）。入参是字符串，内部按 UTF-8 编码 —— 中文与 emoji 都要算对 */
export function sha256Hex(text) {
  const data = new TextEncoder().encode(String(text));
  const bitLen = data.length * 8;
  const padded = new Uint8Array((((data.length + 8) >> 6) + 1) << 6);
  padded.set(data);
  padded[data.length] = 0x80;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padded.length - 8, Math.floor(bitLen / 4294967296), false);
  dv.setUint32(padded.length - 4, bitLen >>> 0, false);

  const H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const x15 = w[i - 15], x2 = w[i - 2];
      const s0 = rotr(x15, 7) ^ rotr(x15, 18) ^ (x15 >>> 3);
      const s1 = rotr(x2, 17) ^ rotr(x2, 19) ^ (x2 >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + SHA_K[i] + w[i]) | 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
    H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
  }
  let out = '';
  for (let i = 0; i < 8; i++) out += (H[i] >>> 0).toString(16).padStart(8, '0');
  return out;
}

/** 键名递归排序：同一个包无论键序怎么写、被谁重新序列化过，规范化文本都是同一串 */
function canon(v) {
  if (Array.isArray(v)) return v.map(canon);
  if (v !== null && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v).sort()) o[k] = canon(v[k]);
    return o;
  }
  return v;
}

/** 规范化文本。探针把它当冻结基准：它一变，所有已声明的 sha256 都会失效 */
export function canonicalEquipmentText(equipment) {
  return JSON.stringify(canon(Array.isArray(equipment) ? equipment : []));
}

/** 包内容指纹：规范化后的 equipment 的 sha256（小写十六进制） */
export function contentFingerprint(pack) {
  return sha256Hex(canonicalEquipmentText(pack && pack.equipment));
}

// ─────────────────────────────────────────────────────────
// 校验
// ─────────────────────────────────────────────────────────

/** 顶层字段该长什么样。表里没有的字段一律放行（取舍见 checkTypes 的注释） */
const TOP_TYPES = Object.freeze({
  name: 'string', author: 'string', desc: 'string', version: 'number', sha256: 'string',
});
/** 器材字段该长什么样。type / proto 不在这里 —— 上面几条检查给的理由更具体 */
const ITEM_TYPES = Object.freeze({
  name: 'string', desc: 'string', icon: 'string', domain: 'string', cat: 'string',
  tags: 'strings', w: 'positive', h: 'positive', ports: 'array', fields: 'array',
  defaults: 'object', state: 'object',
});
const SHA256_RE = /^[0-9a-f]{64}$/;
const TYPE_WANT = Object.freeze({
  string: '字符串', number: '数字', positive: '正数', array: '数组', object: '对象', strings: '字符串数组',
});

const isPlainObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isStr = (v) => typeof v === 'string';
const typeName = (v) => (Array.isArray(v) ? '数组' : v === null ? 'null' : typeof v === 'object' ? '对象' : typeof v);

/**
 * 逐字段过类型。返回可读理由，通过返回 null。
 *
 * 为什么必须有：原来只查「字段在不在」，不查「类型对不对」。于是
 *   defaults:5  → 展开成 {}，无效果也无报错（静默脏数据）
 *   state:'x'   → 展开成 {0:'x'} 这样的脏键
 *   w:'152'     → 进几何运算变 NaN 布局
 *   tags:1      → 抛原生 «not iterable»
 *   ports:'x'   → 抛原生 «is not a function»
 * 后两条虽然会被 install 的 catch 兜住并回滚（不会留残留），但理由不可读，
 * 而且拒绝发生在装到一半之后 —— 与文档承诺的「任何一条不过就整包拒绝」不符。
 *
 * 为什么**不**拒绝未知字段：JSON 天然惰性（不 eval、不 import），多一个键
 * 构不成风险，而白名单会随版本迭代误伤将来的包。这是有意做的取舍。
 */
function checkTypes(where, obj, spec) {
  for (const key of Object.keys(spec)) {
    const v = obj[key];
    if (v === undefined) continue;
    const kind = spec[key];
    const bad =
      (kind === 'string' && !isStr(v)) ||
      (kind === 'number' && !isNum(v)) ||
      (kind === 'positive' && (!isNum(v) || v <= 0)) ||
      (kind === 'array' && !Array.isArray(v)) ||
      (kind === 'object' && !isPlainObj(v)) ||
      (kind === 'strings' && !(Array.isArray(v) && v.every(isStr)));
    if (bad) return `${where}的 ${key} 应该是${TYPE_WANT[kind]}，收到 ${typeName(v)}`;
  }
  return null;
}

/**
 * 检查一个器材包能不能装。
 * 只做结构检查 + 原型存在性检查，任何一条不过就直接拒绝，
 * 避免装到一半留下半套器材。
 *
 * 坏包必须在 derive() **之前**被拒 —— tools/pack-probe.html 用一个订阅
 * registry.onChange 的计数器来证明这一点：被拒的导入触发 0 次变更通知。
 */
export function validatePack(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: '不是一个 JSON 对象' };
  }
  if (raw.format !== FORMAT) {
    return { ok: false, error: `不是小墨器材包（format 应为 "${FORMAT}"）` };
  }
  if (raw.version !== undefined && (!isNum(raw.version) || raw.version < 1)) {
    return { ok: false, error: `version 应该是正整数，收到 ${JSON.stringify(raw.version)}` };
  }
  if (isNum(raw.version) && raw.version > FORMAT_VERSION) {
    return { ok: false, error: `这个包用的是格式版本 v${raw.version}，当前软件只懂 v${FORMAT_VERSION}，请先升级` };
  }
  if (!raw.id || typeof raw.id !== 'string') {
    return { ok: false, error: '缺少包标识 id' };
  }
  const topErr = checkTypes('器材包', raw, TOP_TYPES);
  if (topErr) return { ok: false, error: topErr };
  if (raw.sha256 !== undefined && !SHA256_RE.test(raw.sha256)) {
    return { ok: false, error: 'sha256 必须是 64 位小写十六进制（用 sha256 算出来的那串值）' };
  }
  if (!Array.isArray(raw.equipment) || raw.equipment.length === 0) {
    return { ok: false, error: '包里没有任何器材' };
  }
  // 声明了 sha256 就当场核对：对不上整包拒绝。
  // 这是完整性，不是真实性 —— 它只证明这份器材内容与声明的一致。
  if (raw.sha256 !== undefined) {
    const actual = contentFingerprint(raw);
    if (actual !== raw.sha256) {
      return { ok: false, error: `声明的 sha256 与实际内容不一致：声明 ${raw.sha256.slice(0, 12)}…，实际 ${actual.slice(0, 12)}…` };
    }
  }

  const seen = new Set();
  for (let i = 0; i < raw.equipment.length; i++) {
    const e = raw.equipment[i];
    const tag = `第 ${i + 1} 件器材`;

    if (!e || typeof e !== 'object' || Array.isArray(e)) {
      return { ok: false, error: `${tag}不是对象` };
    }
    if (!e.type || typeof e.type !== 'string') {
      return { ok: false, error: `${tag}缺少 type` };
    }
    if (seen.has(e.type)) {
      return { ok: false, error: `器材标识「${e.type}」在包里重复出现` };
    }
    seen.add(e.type);

    if (!e.proto || typeof e.proto !== 'string') {
      return { ok: false, error: `器材「${e.name || e.type}」缺少 proto（它派生自哪件器材）` };
    }
    if (!get(e.proto)) {
      return { ok: false, error: `器材「${e.name || e.type}」引用了不存在的原型「${e.proto}」` };
    }
    // 同一个包**重新导入**（改完包再导一次）是合法的：install 会先卸掉旧版本再装新的。
    // derive 给 def 打了 pack 标记，所以这里能分辨「这个 type 是本包上一版贡献的」
    // 与「被别人占了」。改造前这里只判 `get(e.type)`，于是同一 id 改完重导会被
    // 自己的旧条目挡下 —— 与文档「改完直接重新导入即可」的承诺不符
    // （tools/pack-probe.html 抓到过原始拒绝理由）。
    const existing = get(e.type);
    if (existing && existing.pack !== raw.id) {
      return { ok: false, error: `器材标识「${e.type}」已被占用，换个 type 再试` };
    }

    const who = `器材「${e.name || e.type}」`;
    const tErr = checkTypes(who, e, ITEM_TYPES);
    if (tErr) return { ok: false, error: tErr };

    // ports / fields 的元素形状也要看：derive 会整组替换它们，形状不对会在渲染期炸
    if (e.ports !== undefined) {
      for (let j = 0; j < e.ports.length; j++) {
        const p = e.ports[j];
        const pTag = `${who}的第 ${j + 1} 个接线柱`;
        if (!isPlainObj(p)) return { ok: false, error: `${pTag}不是对象` };
        if (!isStr(p.id) || !p.id) return { ok: false, error: `${pTag}缺少 id` };
        if (!isNum(p.x) || !isNum(p.y) || p.x < 0 || p.x > 1 || p.y < 0 || p.y > 1) {
          return { ok: false, error: `${pTag}的 x/y 应该是 0~1 的数字（相对器材左上角的归一化坐标）` };
        }
        if (p.polarity !== undefined && !isStr(p.polarity)) {
          return { ok: false, error: `${pTag}的 polarity 应该是字符串` };
        }
      }
    }
    if (e.fields !== undefined) {
      for (let j = 0; j < e.fields.length; j++) {
        const f = e.fields[j];
        if (!isPlainObj(f) || !isStr(f.k) || !f.k) {
          return { ok: false, error: `${who}的第 ${j + 1} 个可调字段应该是带 k 的对象` };
        }
      }
    }
  }

  return { ok: true, pack: raw };
}

// ─────────────────────────────────────────────────────────
// 已安装列表（只存原始 JSON，启动时重放）
// ─────────────────────────────────────────────────────────

function loadAll() {
  try {
    const arr = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function saveAll(arr) {
  try { localStorage.setItem(KEY, JSON.stringify(arr)); } catch { /* 配额满了就算了 */ }
}

/** 把包里的器材真正注册进去，返回装上的 type 列表 */
function applyPack(pack) {
  const made = [];
  for (const e of pack.equipment) {
    derive(e, pack);
    made.push(e.type);
  }
  return made;
}

/** 卸掉包里的器材 */
function unapplyPack(pack) {
  for (const e of pack.equipment) remove(e.type);
}

// ─────────────────────────────────────────────────────────
// 插件
// ─────────────────────────────────────────────────────────

export default {
  id: 'xiaomo.system.pack',
  name: '器材包',
  version: '1.0.0',
  kind: 'system',
  desc: '导入 / 导出 / 卸载器材包：纯数据扩展，不改一行代码就能加新器材',
  author: '小墨实验室',
  builtin: true,
  requires: ['xiaomo.equipment.electrical'],
  tags: ['器材', '扩展'],
  setup(ctx) {
    const app = ctx.app;

    // ── 启动时重放已安装的包 ──
    // brokenById：装载不成功的包 → 可读原因。抽屉里据此显示「校验不通过」，
    // 记录一律保留（绝不静默丢弃用户数据），只是不装载。
    const brokenById = new Map();
    const packs = loadAll();
    let restored = 0;
    let migrated = 0;
    const broken = [];
    for (const p of packs) {
      const v = validatePack(p);
      if (!v.ok) { broken.push({ pack: p, error: v.error }); continue; }
      // 安装时自己写的指纹：对不上就不装载。
      // 这回答的是「我这次启动装的，还是当初装的那一份吗」—— 存盘被手改、
      // 被别的脚本写脏、跨版本迁移出错，都会在这里现形。
      // 早期版本的记录没有 _fp：补写一次而不是拒绝，否则升级后所有人已装的包会当场失效。
      const fp = contentFingerprint(p);
      if (p._fp === undefined) { p._fp = fp; migrated++; }
      else if (p._fp !== fp) {
        broken.push({ pack: p, error: `指纹不符：包内容与安装时不一致（期望 ${String(p._fp).slice(0, 12)}…，实际 ${fp.slice(0, 12)}…）` });
        continue;
      }
      try { applyPack(p); restored++; }
      catch (e) { broken.push({ pack: p, error: e.message }); }
    }
    if (migrated) saveAll(packs);       // 只补指纹，不动器材
    if (restored) app.toast(`已装载 ${restored} 个器材包`);
    for (const b of broken) {
      if (b.pack && b.pack.id) brokenById.set(b.pack.id, b.error);
      console.warn('[器材包] 装载失败：' + (b.pack && b.pack.name) + ' —— ' + b.error);
    }

    /** 装一个包 */
    const install = (raw, { silent = false } = {}) => {
      const v = validatePack(raw);
      if (!v.ok) {
        if (!silent) app.toast('器材包有问题：' + v.error, 'danger');
        return v;
      }
      // 落盘时补一份自己的指纹；文件里若带了 _fp 一概不信任（重导出的旧记录会带它）
      const record = { ...raw, _fp: contentFingerprint(raw) };
      const all = loadAll();
      if (all.some(p => p.id === raw.id)) {
        // 同 id 先卸旧的再装新的，方便改包后重装
        const old = all.find(p => p.id === raw.id);
        unapplyPack(old);
        saveAll(all.filter(p => p.id !== raw.id));
      }
      try {
        const made = applyPack(raw);
        saveAll([...loadAll(), record]);
        if (!silent) app.toast(`器材包「${raw.name || raw.id}」已装载，新增 ${made.length} 件器材`);
        return { ok: true, pack: raw, made };
      } catch (e) {
        // 装到一半失败：把已经注册的撤掉，保持干净
        try { unapplyPack(raw); } catch { /* 尽力而为 */ }
        if (!silent) app.toast('装载失败：' + e.message, 'danger');
        return { ok: false, error: e.message };
      }
    };

    /** 卸一个包 */
    const uninstall = (id) => {
      const all = loadAll();
      const p = all.find(x => x.id === id);
      if (!p) return { ok: false, error: '没有这个包' };
      unapplyPack(p);
      saveAll(all.filter(x => x.id !== id));
      app.toast(`已卸载器材包「${p.name || p.id}」`);
      return { ok: true };
    };

    const listPacks = () => loadAll();

    /**
     * 从一段文本导入一个包。
     *
     * 为什么需要这个函数（它不是多余的 API）：网页版的入口是 <input type=file>，
     * 而那个 input 是 document.createElement 出来的**游离节点** —— 从不进 DOM、
     * 直接 .click()，所以无头浏览器拿不到它的 node id，DOM.setFileInputFiles 无从下手。
     * 也就是说「选文件」那一层没法被机械验证。把「文本 → 解析 → 校验 → 安装」
     * 抽成这个可调用的函数后，探针能测这一段（真实入口），file 那一层留给真机人工确认。
     * 文件名叫什么都不影响包的内容，所以 name 只用来写提示。
     */
    const importText = (name, text, opts) => {
      let raw;
      try { raw = JSON.parse(String(text)); }
      catch (e) { return { ok: false, kind: 'parse', error: `${name || '这个文件'} 不是合法 JSON（${e.message}）` }; }
      const r = install(raw, opts);
      return { ...r, kind: r.ok ? 'installed' : 'rejected' };
    };

    // 暴露给别的插件 / 控制台
    ctx.app.services.packs = { install, uninstall, list: listPacks, validate: validatePack, importText };

    // ─────────────────────────────────────────────────────
    // 界面：入口按钮
    // ─────────────────────────────────────────────────────
    ctx.slot('topbar.right', (host) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'tb-btn';
      b.id = 'btnPacks';
      b.title = '器材包';
      b.textContent = '📦';
      b.addEventListener('click', () => openDrawer());
      host.appendChild(b);
    }, { order: 40 });

    // ─────────────────────────────────────────────────────
    // 界面：抽屉
    // ─────────────────────────────────────────────────────
    let renderBody = () => {};
    let openDrawer = () => {};   // 在下面的 slot 回调里被真正赋值

    ctx.slot('overlay', (host) => {
      const mask = document.createElement('div');
      mask.className = 'drawer-mask';
      mask.innerHTML = `
        <div class="drawer" role="dialog" aria-modal="true" aria-label="器材包">
          <div class="drawer-head">
            <b>器材包</b>
            <span class="pack-sub">纯数据扩展，安全可卸载</span>
            <button type="button" class="drawer-x" title="关闭">✕</button>
          </div>
          <div class="drawer-body pack-body"></div>
          <div class="drawer-foot">
            <button type="button" class="btn acc" data-act="import">导入器材包…</button>
            <button type="button" class="btn" data-act="export">导出示例</button>
            <button type="button" class="btn" data-act="doc">格式说明</button>
          </div>
        </div>`;
      host.appendChild(mask);

      const body = mask.querySelector('.pack-body');

      // ── 浮层时序与焦点（§2-C1 C1 / C2 / C8）──────────────
      // 退场时长不写死：读遮罩与面板的计算过渡时长，并以 transitionend 为主信号。
      // §2-A12 把退场收到 --t-base 之后，这里自动跟随，不需要改任何毫秒数。
      const EXIT_SLACK = 80;    // 兜底余量（约一帧多），不是过渡时长
      const toMs = (v) => {
        const n = parseFloat(v) || 0;
        return /ms\s*$/.test(String(v).trim()) ? n : n * 1000;
      };
      const exitMs = (root) => {
        let max = 0;
        for (const el of [root, root.firstElementChild]) {
          if (!el) continue;
          for (const d of getComputedStyle(el).transitionDuration.split(',')) max = Math.max(max, toMs(d));
        }
        return max + EXIT_SLACK;
      };

      const shell = document.getElementById('app');
      const canInert = typeof HTMLElement !== 'undefined' && 'inert' in HTMLElement.prototype;
      let restoreFocus = null;
      const lockBg = () => {
        if (!shell) return;
        if (canInert) shell.inert = true; else shell.setAttribute('aria-hidden', 'true');
      };
      const unlockBg = () => {
        if (!shell) return;
        // 还有别的浮层开着就别解除（所有浮层共用同一层被遮背景）
        if (document.querySelector('.drawer-mask.show,.expel-mask.show,.about-mask.show')) return;
        if (canInert) shell.inert = false; else shell.removeAttribute('aria-hidden');
      };
      const focusPanel = () => {
        const t = mask.querySelector('button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])');
        if (t && t.focus) t.focus({ preventScroll: true });
      };
      const giveBackFocus = () => {
        if (restoreFocus && restoreFocus.focus) restoreFocus.focus({ preventScroll: true });
        restoreFocus = null;
      };

      let closing = 0;
      const cancelClose = () => { if (closing) { clearTimeout(closing); closing = 0; } };

      const close = () => {
        if (!mask.classList.contains('show')) return;
        mask.classList.remove('in');        // 必须和 show 一起移除：残留的 in 会让下次打开首帧就位
        const wait = exitMs(mask);
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          mask.removeEventListener('transitionend', onEnd);
          clearTimeout(closing);
          closing = 0;
          if (!mask.classList.contains('in')) mask.classList.remove('show');
          unlockBg();
          giveBackFocus();
        };
        const onEnd = (e) => {
          if (e.target !== mask && !mask.contains(e.target)) return;
          if (e.propertyName !== 'transform' && e.propertyName !== 'opacity') return;
          finish();
        };
        mask.addEventListener('transitionend', onEnd);
        closing = setTimeout(finish, wait);
      };

      openDrawer = () => {
        cancelClose();
        renderBody();
        restoreFocus = document.activeElement;
        const wasHidden = !mask.classList.contains('show');
        if (wasHidden) mask.classList.remove('in');   // 关闭态重开：先回到起点，滑入才会真的播放
        mask.classList.add('show');
        void mask.offsetWidth;                        // 立刻结算起点（display:none → flex 后位移才有过渡）
        mask.classList.add('in');
        lockBg();
        focusPanel();
      };

      mask.addEventListener('click', (e) => { if (e.target === mask) close(); });
      mask.querySelector('.drawer-x').addEventListener('click', close);
      window.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });

      // ── 主进程菜单 / 桌面事件也能唤起 ──
      window.addEventListener('xiaomo:pack-import', () => { openDrawer(); doImport(); });

      // ── 抽屉内容 ──
      renderBody = () => {
        const packs = listPacks();
        if (!packs.length) {
          body.innerHTML = `
            <div class="blank">
              <div class="blank-t">还没有装过器材包</div>
              <div class="blank-s">器材包是一个 JSON 文件，<br>里面可以用已有器材派生出新器材。</div>
            </div>`;
          return;
        }
        body.innerHTML = '';
        for (const p of packs) {
          const n = (p.equipment || []).length;
          // 装载不成功的包：记录还在（绝不静默丢弃），但当场标明为什么没生效。
          // 没有新样式（styles/** 不在本任务的写域），所以徽标借用既有 .pack-count 药丸样式、
          // 原因行借用 .pack-desc 的次级文字样式；data-bad 是给探针用的锚点。
          const bad = brokenById.get(p.id);
          const row = document.createElement('div');
          row.className = 'pack-card';
          if (bad) row.dataset.bad = '1';
          row.innerHTML = `
            <div class="pack-head">
              <b>${esc(p.name || p.id)}</b>
              ${bad ? '<span class="pack-count">校验不通过</span>' : `<span class="pack-count">${n} 件</span>`}
            </div>
            <div class="pack-desc">${esc(bad || p.desc || p.author || '')}</div>
            <div class="pack-items">${(p.equipment || []).map(e => `<span>${esc(e.name || e.type)}</span>`).join('')}</div>
            <div class="pack-acts">
              <button type="button" class="btn dgr" data-del="${esc(p.id)}">卸载</button>
            </div>`;
          body.appendChild(row);
        }
        body.querySelectorAll('[data-del]').forEach((btn) => {
          btn.addEventListener('click', () => { uninstall(btn.dataset.del); renderBody(); });
        });
      };

      // ── 导入：桌面版走原生对话框，网页版走 <input type=file> ──
      const ingest = (texts) => {
        let okCount = 0;
        for (const { name, text } of texts) {
          const r = importText(name, text);
          if (r.ok) okCount++;
          else if (r.kind === 'parse') app.toast(r.error, 'danger');   // 校验失败的理由由 install 自己报，避免两句提示
        }
        renderBody();
        if (okCount > 1) app.toast(`共装载 ${okCount} 个器材包`);
      };

      const doImport = async () => {
        const D = window.xiaomoDesktop;
        if (D && D.isDesktop && D.importPack) {
          const r = await D.importPack();
          if (!r.ok) { if (!r.canceled) app.toast('导入失败：' + (r.error || ''), 'danger'); return; }
          ingest(r.packs);
          return;
        }
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json,.xiaomo-pack,application/json';
        input.multiple = true;
        input.addEventListener('change', async () => {
          const files = [...(input.files || [])];
          const texts = [];
          for (const f of files) texts.push({ name: f.name, text: await f.text() });
          ingest(texts);
        });
        input.click();
      };

      // ── 导出示例 ──
      const SAMPLE = {
        format: FORMAT,
        version: 1,
        id: 'xiaomo.sample.pack',
        name: '示例器材包',
        author: '小墨实验室',
        desc: '演示怎么用已有器材派生出新器材',
        equipment: [
          {
            type: 'sample-big-battery',
            proto: 'battery',
            name: '大号干电池',
            desc: '电动势更高的干电池，内阻也更大',
            icon: '🔋',
            defaults: { emf: 9, internalR: 1.2 },
          },
          {
            type: 'sample-wide-beaker',
            proto: 'beaker',
            name: '宽口烧杯',
            desc: '容量更大的烧杯',
            w: 92,
            h: 84,
            defaults: { capacity: 500 },
          },
        ],
      };

      const doExport = async () => {
        // 导出的模板自带一份算好的 sha256：它是「这个字段怎么写」的活例子，
        // 而且每次导出都现算 —— 不会因为以后有人改了 SAMPLE 就留下一份过期的假声明。
        const json = JSON.stringify({ ...SAMPLE, sha256: contentFingerprint(SAMPLE) }, null, 2);
        const D = window.xiaomoDesktop;
        if (D && D.isDesktop && D.exportPack) {
          const r = await D.exportPack(json, '示例器材包.xiaomo-pack');
          if (r.ok) app.toast('已导出到 ' + r.name);
          else if (!r.canceled) app.toast('导出失败：' + (r.error || ''), 'danger');
          return;
        }
        const blob = new Blob([json], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = '示例器材包.xiaomo-pack';
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 2000);
        app.toast('示例器材包已下载');
      };

      const doDoc = () => {
        window.dispatchEvent(new CustomEvent('xiaomo:about', { detail: true }));
        app.toast('格式说明见仓库 docs/器材包格式.md');
      };

      mask.querySelector('[data-act=import]').addEventListener('click', doImport);
      mask.querySelector('[data-act=export]').addEventListener('click', doExport);
      mask.querySelector('[data-act=doc]').addEventListener('click', doDoc);
    }, { order: 21 });

    // 供顶部按钮调用
  },
};

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
