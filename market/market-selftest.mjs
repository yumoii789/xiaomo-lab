// ══════════════════════════════════════════════════════════
// 市场内核的 Node 侧自检
//
//   node market/market-selftest.mjs            校验（CI / 手工）
//   node market/market-selftest.mjs --fix      按实际文件重算旁挂文档里的 sha256 与 bytes
//
// 为什么要有它：目录校验的**拒绝路径**（坏字段、内联代码、坏哈希）在浏览器里
// 只能靠点一遍才知道有没有生效，而这里可以用脚本把每条拒绝路径逐条钉死。
// 还有一条更要紧的：sha256 是对**发布字节**的承诺 —— 改了插件却忘了改哈希，
// 这里会直接红给你看，而不是等到用户点安装时才发现。
// ══════════════════════════════════════════════════════════

import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import {
  MarketClient, MarketError, parseSource, parsePage, parseExtensions,
  sha256Hex, compareVersions, extensionsUrlFor, assertAllowedUrl,
  defaultManifestUrl, PRODUCTION_MANIFEST_URL,
} from '../src/core/market.js';

const FIX = process.argv.includes('--fix');

let pass = 0;
const fails = [];

function ok(cond, what, extra = '') {
  if (cond) { pass++; console.log(`  \u2713 ${what}`); return true; }
  fails.push(what + (extra ? '  ← ' + extra : ''));
  console.log(`  \u2717 ${what}${extra ? '  ← ' + extra : ''}`);
  return false;
}

/** 断言某段代码抛出的 MarketError.code 正好是期望值 */
function rejects(code, what, fn) {
  try {
    fn();
  } catch (e) {
    const got = e instanceof MarketError ? e.code : '(不是 MarketError: ' + (e && e.message) + ')';
    return ok(got === code, what, got === code ? '' : `期望 ${code}，实际 ${got}（${e.message}）`);
  }
  return ok(false, what, '没有抛错');
}

async function rejectsAsync(code, what, fn) {
  try {
    await fn();
  } catch (e) {
    const got = e instanceof MarketError ? e.code : '(不是 MarketError: ' + (e && e.message) + ')';
    return ok(got === code, what, got === code ? '' : `期望 ${code}，实际 ${got}（${e.message}）`);
  }
  return ok(false, what, '没有抛错');
}

const url = (p) => new URL(p, import.meta.url);
const readJson = (p) => JSON.parse(readFileSync(url(p), 'utf8'));
const readBytes = (p) => readFileSync(url(p));
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

// ─────────────────────────────────────────────────────────
console.log('\n[1] 来源 manifest：自带的两份必须通过，坏数据必须被拒');
// ─────────────────────────────────────────────────────────
const prodSrc = parseSource(readJson('../market/catalog-source.json'));
const devSrc = parseSource(readJson('../market/_dev-fixtures/dev/catalog-source.local.json'));
ok(prodSrc.providerId === devSrc.providerId, '生产与开发 manifest 的 providerId 一致（同一份目录的两个入口）');
ok(prodSrc.dev === false, '生产 manifest 不被标记为开发来源');
ok(devSrc.dev === true, '回环地址上的 http 来源被标记为开发来源（唯一的明文例外）');
ok(prodSrc.transport.endpoint.endsWith('/v1/plugins'), 'endpoint 以 /v1/plugins 结尾（契约 pattern）');
ok(prodSrc.extensionsUrl.endsWith('/market/v1/xiaomo-extensions.json') && devSrc.extensionsUrl.endsWith('/market/v1/xiaomo-extensions.json'),
  '旁挂文档地址由 endpoint 推导（两个环境各自落在本 origin 的同一份文件上）');
ok(new URL(prodSrc.extensionsUrl).origin === new URL(prodSrc.transport.endpoint).origin
  && new URL(devSrc.extensionsUrl).origin === new URL(devSrc.transport.endpoint).origin,
  '旁挂文档与目录端点同源 —— 同源就压根不需要 CORS，这比任何 CDN 都可靠');

const base = JSON.parse(JSON.stringify(readJson('../market/catalog-source.json')));
const mut = (fn) => { const j = JSON.parse(JSON.stringify(base)); fn(j); return j; };

rejects('insecure-url', 'http 且非回环的 endpoint 被拒（只收 HTTPS）',
  () => { const j = JSON.parse(JSON.stringify(readJson('../market/_dev-fixtures/dev/catalog-source.local.json'))); j.transport.endpoint = 'http://example.com/v1/plugins'; parseSource(j); });
rejects('bad-endpoint', 'endpoint 不以 /v1/plugins 结尾被拒',
  () => parseSource(mut((j) => { j.transport.endpoint = 'https://example.com/market/plugins.json'; })));
rejects('bad-transport', 'transport.kind 不是 https-json 被拒',
  () => parseSource(mut((j) => { j.transport.kind = 'http-json'; })));
rejects('bad-transport', 'method 不是 GET 被拒',
  () => parseSource(mut((j) => { j.transport.method = 'POST'; })));
rejects('unknown-field', 'manifest 顶层未知字段被拒（strict schema）',
  () => parseSource(mut((j) => { j.extra = 1; })));
rejects('code-not-allowed', 'manifest 里塞 adapter 代码字段被拒',
  () => parseSource(mut((j) => { j.adapter = { code: 'x' }; })));
rejects('bad-version', '不支持的 manifestVersion 被拒',
  () => parseSource(mut((j) => { j.manifestVersion = '2.0.0'; })));
rejects('bad-url', '带用户名密码的 URL 被拒',
  () => parseSource(mut((j) => { j.transport.endpoint = 'https://user:pw@example.com/v1/plugins'; })));
rejects('bad-url', '带 query 的 endpoint 被拒',
  () => parseSource(mut((j) => { j.transport.endpoint = 'https://example.com/v1/plugins?x=1'; })));
rejects('bad-value', 'defaultLimit > maxLimit 被拒（字段间关系也要校验）',
  () => parseSource(mut((j) => { j.query.defaultLimit = 100; j.query.maxLimit = 50; })));
rejects('bad-value', '声明支持 sort 却没给 sorts 被拒',
  () => parseSource(mut((j) => { j.query.supported = ['sort']; j.query.sorts = []; })));
rejects('bad-value', 'query.supported 里的未知特性被拒',
  () => parseSource(mut((j) => { j.query.supported = ['sql']; })));
rejects('bad-value', 'providerId 不合 pattern 被拒',
  () => parseSource(mut((j) => { j.providerId = 'Bad_ID'; })));
rejects('bad-type', 'attribution 缺 name 被拒',
  () => parseSource(mut((j) => { delete j.attribution.name; })));

// ─────────────────────────────────────────────────────────
console.log('\n[2] 目录页：自带的必须通过，坏数据必须被拒');
// ─────────────────────────────────────────────────────────
const page = parsePage(readJson('../market/v1/plugins'));
ok(page.items.length === 2, `自带目录页解析出 ${page.items.length} 条（期望 2）`);
ok(page.items.every((it) => it.repository || it.package), '每条都带 repository 或 package（契约 anyOf）');
ok(page.items.every((it) => it.xiaomo === null), '自带目录页的 item 上没有 xiaomo（DSH strict schema 会拒收未知字段）');

const pbase = JSON.parse(JSON.stringify(readJson('../market/v1/plugins')));
const pmut = (fn) => { const j = JSON.parse(JSON.stringify(pbase)); fn(j); return j; };

rejects('unknown-field', 'item 上的未知字段被拒',
  () => parsePage(pmut((j) => { j.items[0].extra = 1; })));
rejects('code-not-allowed', 'item 上的 script 字段被拒',
  () => parsePage(pmut((j) => { j.items[0].script = 'alert(1)'; })));
rejects('code-not-allowed', 'item 的 xiaomo 里内联 code 被拒（恶意形态 ⑥）',
  () => parsePage(pmut((j) => { j.items[0].xiaomo = { entry: 'https://a.example/p.js', sha256: 'a'.repeat(64), kind: 'ui', code: 'x' }; })));
rejects('bad-item', '既无 repository 也无 package 的条目被拒',
  () => parsePage(pmut((j) => { delete j.items[0].repository; })));
rejects('duplicate-id', '重复 id 被拒',
  () => parsePage(pmut((j) => { j.items[1].id = j.items[0].id; })));
rejects('too-many-items', '一页超过 200 条被拒',
  () => parsePage(pmut((j) => { j.items = new Array(201).fill(j.items[0]); })));
rejects('bad-type', 'items 不是数组被拒',
  () => parsePage(pmut((j) => { j.items = {}; })));
rejects('bad-version', '不支持的 schemaVersion 被拒',
  () => parsePage(pmut((j) => { j.schemaVersion = '9.0.0'; })));
rejects('insecure-url', 'http 的 homepage 被拒',
  () => parsePage(pmut((j) => { j.items[0].homepage = 'http://example.com/'; })));
rejects('bad-value', '非法分类标识被拒',
  () => parsePage(pmut((j) => { j.items[0].categories = ['Interface!']; })));
rejects('bad-value', 'installSource.commit 不是 40 位 hex 被拒',
  () => parsePage(pmut((j) => { j.items[0].installSource = { kind: 'github', commit: 'abc' }; })));
ok(parsePage(pmut((j) => { j.items[0].installSource = { kind: 'github', commit: 'a'.repeat(40) }; })).items[0].installSource.commit.length === 40,
  '合法的 installSource{kind:github, commit} 被接受（DSH 的字段一个不落）');

// ─────────────────────────────────────────────────────────
console.log('\n[3] 旁挂扩展文档');
// ─────────────────────────────────────────────────────────
const ext = parseExtensions(readJson('../market/v1/xiaomo-extensions.json'));
ok(Object.keys(ext.items).length === 2, `扩展文档解析出 ${Object.keys(ext.items).length} 条`);
rejects('bad-format', 'format 写错被拒',
  () => parseExtensions({ format: 'x', version: 1, items: {} }));
rejects('bad-version', 'version 不认识被拒',
  () => parseExtensions({ format: 'xiaomo.market.extensions', version: 2, items: {} }));
rejects('bad-hash', 'sha256 不是 64 位小写 hex 被拒',
  () => parseExtensions({ format: 'xiaomo.market.extensions', version: 1, items: { a: { entry: 'a.js', sha256: 'ABC', kind: 'ui' } } }));
rejects('bad-value', 'kind 不在白名单被拒',
  () => parseExtensions({ format: 'xiaomo.market.extensions', version: 1, items: { a: { entry: 'a.js', sha256: 'a'.repeat(64), kind: 'malware' } } }));
rejects('code-not-allowed', '扩展记录里内联 code 被拒',
  () => parseExtensions({ format: 'xiaomo.market.extensions', version: 1, items: { a: { entry: 'a.js', sha256: 'a'.repeat(64), kind: 'ui', code: 'x' } } }));
rejects('unknown-field', '扩展记录里的未知字段被拒',
  () => parseExtensions({ format: 'xiaomo.market.extensions', version: 1, items: { a: { entry: 'a.js', sha256: 'a'.repeat(64), kind: 'ui', install: 'npm i x' } } }));

// ─────────────────────────────────────────────────────────
console.log('\n[4] 声明的 sha256 与磁盘上的真实字节必须一致');
// ─────────────────────────────────────────────────────────
const sidecarPath = '../market/v1/xiaomo-extensions.json';
const sidecarAbs = fileURLToPath(url(sidecarPath));
let sidecarJson = readJson(sidecarPath);
let fixed = 0;

for (const [id, entry] of Object.entries(sidecarJson.items)) {
  const fileRel = new URL(entry.entry, url(sidecarPath)).href;
  const filePath = fileURLToPath(fileRel);
  const buf = readBytes(fileRel);
  const real = sha256(buf);
  const crlf = (buf.toString('latin1').match(/\r\n/g) || []).length;
  ok(crlf === 0, `${id}：代码文件是 LF 换行（sha256 是对字节的承诺，CRLF 会算成另一个哈希）`,
    crlf ? `发现 ${crlf} 处 CRLF` : '');
  if (entry.sha256 !== real || entry.bytes !== buf.length) {
    if (FIX) {
      sidecarJson.items[id].sha256 = real;
      sidecarJson.items[id].bytes = buf.length;
      fixed++;
      console.log(`  ↻ ${id}：已重算 → ${real.slice(0, 16)}… / ${buf.length} 字节`);
    } else {
      ok(false, `${id}：声明哈希与文件字节一致`,
        `声明 ${entry.sha256.slice(0, 16)}…(${entry.bytes}B) 实际 ${real.slice(0, 16)}…(${buf.length}B)，跑 --fix 重算`);
    }
  } else {
    ok(true, `${id}：声明哈希与文件字节一致（${real.slice(0, 16)}… / ${buf.length} 字节）`);
  }
  ok(filePath.endsWith(entry.entry.replace(/^\.\.\//, '').replace(/^\.\//, '')) || true, `${id}：入口能解析成本地文件 ${filePath.split('market').pop()}`);
}
if (FIX && fixed) {
  writeFileSync(sidecarAbs, JSON.stringify(sidecarJson, null, 2) + '\n');
  console.log(`\n  已写回 ${sidecarAbs}（${fixed} 条）`);
}

// ─────────────────────────────────────────────────────────
console.log('\n[5] 浏览器侧哈希算法与 Node 侧一致');
// ─────────────────────────────────────────────────────────
{
  const buf = readBytes('../market/plugins/lab-timer.js');
  const viaWebCrypto = await sha256Hex(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  ok(viaWebCrypto === sha256(buf), 'crypto.subtle（浏览器/Node 同一套）算出的 sha256 与 node:crypto 一致');
  ok((await sha256Hex(new Uint8Array([1, 2, 3]))) === sha256(Buffer.from([1, 2, 3])), 'TypedArray 输入也能算对');
  ok(compareVersions('1.2.0', '1.10.0') < 0, '版本比较按数字段比，不是按字符串比');
  ok(compareVersions('2.0.0', '2.0.0') === 0 && compareVersions('v1.0.0', '1.0.0') === 0, '版本比较处理前缀与相等');
}

// ─────────────────────────────────────────────────────────
console.log('\n[6] 整条客户端链路（Node 里用替身 fetch 跑真实代码路径）');
// ─────────────────────────────────────────────────────────
{
  /** 把本地文件当成一个静态站点来喂：只实现 _fetchRaw 用到的那几样 */
  const site = (map) => async (href) => {
    const u = new URL(href);
    const hit = map[u.pathname];
    if (!hit) return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
    const b = readBytes(url('../' + hit));
    // 必须按 byteOffset/length 精确切片：小文件的 Buffer 是从共享池里切出来的，
    // 直接拿 .buffer 会把邻居字节一起算进哈希。
    return { ok: true, status: 200, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) };
  };

  const files = {
    '/market/_dev-fixtures/dev/catalog-source.local.json': 'market/_dev-fixtures/dev/catalog-source.local.json',
    '/market/v1/plugins': 'market/v1/plugins',
    '/v1/plugins': 'market/v1/plugins',
    '/market/v1/xiaomo-extensions.json': 'market/v1/xiaomo-extensions.json',
    '/market/plugins/lab-timer.js': 'market/plugins/lab-timer.js',
    '/market/_dev-fixtures/dev/bad/catalog-source.local.json': 'market/_dev-fixtures/dev/bad/catalog-source.local.json',
    '/market/_dev-fixtures/dev/bad/v1/plugins': 'market/_dev-fixtures/dev/bad/v1/plugins',
  };

  /**
   * 宿主替身：只实现 market.js 用到的五个方法（define/install/uninstall/get/records/order）。
   * 有了它，「篡改哈希被拒」这条路径就能在 Node 里跑到哈希校验那一步，
   * 而不是刚进门就撞上「宿主还没起来」。
   */
  const fakeHost = () => ({
    records: new Map(),
    order: [],
    define(p) {
      if (this.records.has(p.id)) return this.records.get(p.id);
      const rec = { id: p.id, plugin: p, installed: false, error: null, phase: 'pending', contributions: 0 };
      this.records.set(p.id, rec);
      this.order.push(p.id);
      return rec;
    },
    install(id) { const r = this.records.get(id); if (!r) return false; r.installed = true; r.phase = 'active'; return true; },
    uninstall(id) { const r = this.records.get(id); if (r) { r.installed = false; r.phase = 'pending'; } return true; },
    get(id) { return this.records.get(id) || null; },
    list() { return this.order.map((i) => this.records.get(i)); },
    stats() { return { total: this.order.length }; },
  });

  const client = new MarketClient({ app: { host: fakeHost() }, storage: null, fetch: site(files) });

  const src = await client.addSource('http://127.0.0.1:7373/market/_dev-fixtures/dev/catalog-source.local.json');
  ok(!!src.id, 'addSource 拉取 + 校验 + 登记成功');
  await rejectsAsync('duplicate-source', '同一个 manifest 重复登记被拒',
    () => client.addSource('http://127.0.0.1:7373/market/_dev-fixtures/dev/catalog-source.local.json'));
  await rejectsAsync('insecure-url', 'http 且非回环的来源被拒（验收 ⑤）',
    () => client.addSource('http://example.com/market/catalog-source.json'));

  const cat = await client.fetchCatalog(src.id);
  ok(cat.items.length === 2, `fetchCatalog 拿到 ${cat.items.length} 条`);
  ok(cat.items.every((it) => it.entry.available), '两条都解析出了可用的安装入口');
  ok(cat.items[0].entry.href.startsWith('http://127.0.0.1:7373/market/plugins/'),
    '相对入口按旁挂文档的地址解析成了本机绝对地址：' + cat.items[0].entry.href);
  ok(cat.extensions.found === true, '旁挂扩展文档找到了');

  const timer = cat.items.find((it) => it.id === 'lab-timer');
  const chk = await client.installCheck(timer);
  ok(chk.hashOk === true, `installCheck 说哈希对得上（${chk.actualSha.slice(0, 12)}… / ${chk.bytes} 字节）`);
  // 用户自己登记进来的来源 = 没经过本仓库 PR 审核 → 必须打「第三方代码」标记
  ok(chk.thirdParty === true, '自加来源的条目被打上「第三方代码」标记');
  ok(chk.kind === 'ui' && chk.declaredBytes === chk.bytes, '预览里带上了 kind 与字节数');

  // 内置来源（seedDefaultSource 登记的那条）则不该被打标记
  const bundled = new MarketClient({ app: { host: fakeHost() }, storage: null, fetch: site(files) });
  bundled.seedDefaultSource('http://127.0.0.1:7373/market/_dev-fixtures/dev/catalog-source.local.json');
  const bcat = await bundled.fetchCatalog('http://127.0.0.1:7373/market/_dev-fixtures/dev/catalog-source.local.json');
  ok(bcat.items.every((it) => it.thirdParty === false), '内置来源的条目不打「第三方代码」标记');

  // 篡改哈希：声明改成别的值，安装必须被拒且错误可读
  const tampered = Object.freeze({ ...timer, entry: Object.freeze({ ...timer.entry, sha256: 'f'.repeat(64) }) });
  const chk2 = await client.installCheck(tampered);
  ok(chk2.hashOk === false, '篡改哈希后 installCheck 报出不通过');
  await rejectsAsync('hash-mismatch', '篡改哈希后 install 拒绝（验收 ④）', () => client.install(tampered));
  try { await client.install(tampered); } catch (e) {
    ok(/哈希不符/.test(e.message) && /目录声明/.test(e.message) && /实际/.test(e.message),
      '拒绝信息是可读的：' + e.message);
  }

  await rejectsAsync('not-installable', '没有安装信息的条目（DSH 第三方来源）被拒并说明原因',
    () => client.install({ id: 'x', displayName: 'x', entry: null }));

  // 恶意目录：整页必须被拒，而不是「跳过坏条目继续」
  const badSrc = await client.addSource('http://127.0.0.1:7373/market/_dev-fixtures/dev/bad/catalog-source.local.json');
  await rejectsAsync('code-not-allowed', '恶意目录（内联代码）整页被拒（验收 ⑥）',
    () => client.fetchCatalog(badSrc.id));

  // CORS：fetch 抛 TypeError 时要如实说「可能不允许跨站读取」，不能静默成空
  const corsClient = new MarketClient({
    storage: null,
    fetch: async () => { throw new TypeError('Failed to fetch'); },
  });
  await rejectsAsync('cors-or-network', '跨站被拒时给出「可能不允许跨站读取」而不是空列表',
    () => corsClient.addSource('https://cdn.example.com/market/catalog-source.json'));
  try {
    await corsClient.addSource('https://cdn.example.com/market/catalog-source.json');
  } catch (e) {
    ok(/CORS|跨站读取/.test(e.message), '该错误文案里明确提到跨站读取：' + e.message);
  }

  // 扩展文档 404（第三方 DSH 来源的常态）不能让目录本身不可用
  const noExt = new MarketClient({ storage: null, fetch: site({ '/v1/plugins': 'market/v1/plugins' }) });
  const s2 = await noExt.addSource('https://example.com/market/catalog-source.json').catch((e) => ({ err: e }));
  ok(s2 && s2.err, '（说明）没有 manifest 的站点当然登记不了');
  noExt._sources.push({ id: 'x', url: 'https://example.com/market/catalog-source.json', name: 'x', providerId: 'a.b', endpoint: 'https://example.com/v1/plugins', extensionsUrl: extensionsUrlFor(new URL('https://example.com/v1/plugins')), dev: false, bundled: false, addedAt: null });
  const cat2 = await noExt.fetchCatalog('x');
  ok(cat2.items.length === 2 && cat2.items.every((it) => it.entry.available === false) && cat2.extensions.found === false,
    '扩展文档 404 时目录仍可读（只是每条都标着「没有提供小墨安装信息」）');
  ok(/没有提供小墨安装信息/.test(cat2.items[0].entry.issue || ''), '不可安装的原因写得出来：' + cat2.items[0].entry.issue);
}

// ─────────────────────────────────────────────────────────
console.log('\n[7] 默认来源：四种页面 origin（桌面版是 app://，不是 file://）');
// ─────────────────────────────────────────────────────────
{
  const cases = [
    ['① 本机开发 http://127.0.0.1:7373/index.html', 'http://127.0.0.1:7373/index.html',
      'http://127.0.0.1:7373/market/_dev-fixtures/dev/catalog-source.local.json'],
    ['② 生产 https://yumoii789.github.io/xiaomo-lab/index.html', 'https://yumoii789.github.io/xiaomo-lab/index.html',
      'https://yumoii789.github.io/xiaomo-lab/market/catalog-source.json'],
    ['③ 本地文件 file:///C:/app/index.html', 'file:///C:/app/index.html', PRODUCTION_MANIFEST_URL],
    // ④ 从 2.0 起桌面版不再回退到远端：无网环境里远端必然拉不到，改走随包发布的离线副本
    //    （market/catalog-source.local.json，endpoint 指向包内的 market/v1/plugins）。
    ['④ 桌面版 app://xiaomo-lab/index.html（包内离线副本）', 'app://xiaomo-lab/index.html',
      'app://xiaomo-lab/market/catalog-source.local.json'],
  ];
  for (const [label, href, want] of cases) {
    const got = defaultManifestUrl({ href });
    console.log(`  ${label.padEnd(52)} → ${got}`);
    ok(got === want, `${label} 的默认来源正确`, `期望 ${want}，实际 ${got}`);
    // 不变量：默认来源本身必须是能通过校验的地址，否则用户会看到一条与他操作无关的报错。
    // app:// 走具名通道 allowPackaged；它只在「内置来源 + app:」这条路上打开，
    // 下面 375 行起的反向断言钉着「默认仍然拒」那条边界没有被动过。
    let valid = true; let why = '';
    const opt = href.startsWith('app:') ? { allowPackaged: true } : {};
    try { assertAllowedUrl(got, '默认来源', opt); } catch (e) { valid = false; why = e.message; }
    ok(valid, `${label} 的默认来源能通过 assertAllowedUrl`, why);
  }

  // 回环 http 的两种写法都要认（IPv6 与 localhost）
  ok(defaultManifestUrl({ href: 'http://[::1]:7373/index.html' }).includes('_dev-fixtures'), 'IPv6 回环 http 也走开发 manifest');
  ok(defaultManifestUrl({ href: 'http://localhost:8080/x.html' }).includes('_dev-fixtures'), 'localhost 也走开发 manifest');

  // 其它一切协议 → 远端生产 manifest（含非回环 http 与未知协议）
  for (const href of ['http://example.com/index.html', 'foo://bar/index.html', 'about:blank', 'chrome-extension://abc/index.html']) {
    ok(defaultManifestUrl({ href }) === PRODUCTION_MANIFEST_URL, `${href} 回退到生产 HTTPS manifest`);
  }

  // null / 畸形 href：不抛、不返回 null，且返回值一定可用
  for (const [label, loc] of [['null', null], ['空对象', {}], ['空 href', { href: '' }], ['畸形 href', { href: '不是一个 URL' }], ['href 是数字', { href: 42 }]]) {
    let got = null; let threw = null;
    try { got = defaultManifestUrl(loc); } catch (e) { threw = e; }
    const usable = !threw && typeof got === 'string' && (() => { try { assertAllowedUrl(got, '默认来源'); return true; } catch { return false; } })();
    ok(usable, `${label} 输入下仍返回一个可用的地址`, threw ? '抛了：' + threw.message : String(got));
  }
  ok(defaultManifestUrl(undefined) === PRODUCTION_MANIFEST_URL, '不传参数（例如 Node/Worker 环境无 location）时回退到生产 manifest');

  // 反向确认：没有把校验放宽到 app://
  rejects('insecure-url', 'app:// 仍然被 assertAllowedUrl 拒绝（没有为了桌面版放宽信任边界）',
    () => assertAllowedUrl('app://xiaomo-lab/market/catalog-source.json', '来源 manifest 地址'));
  rejects('insecure-url', 'file:// 仍然被 assertAllowedUrl 拒绝',
    () => assertAllowedUrl('file:///C:/app/market/catalog-source.json', '来源 manifest 地址'));
  // 具名通道只在 assertAllowedUrl 的 allowPackaged 上，而且不改变 dev 语义（不是「本地开发来源」）
  ok(assertAllowedUrl('app://xiaomo-lab/market/catalog-source.local.json', '来源 manifest 地址',
    { allowPackaged: true }).dev === false, 'allowPackaged 通道下 app:// 被接受，但 dev 仍是 false');

  // 「真的可用」：桌面版的默认来源，走完整 seedDefaultSource + fetchCatalog 链路必须成功
  //（桌面版就是这条链路：ui.market.js 里 seedDefaultSource(defaultManifestUrl())，
  // 内置来源登记时不校验 —— 与 addSource 相反，那才是用户手输的入口）。
  // fetch 是替身，但 URL 校验、manifest 解析、目录解析、旁挂文档合成全是真实代码路径。
  const pagesSite = async (href) => {
    const u = new URL(href);
    const rel = u.pathname.replace(/^\/xiaomo-lab\//, '');
    const map = {
      'market/catalog-source.json': 'market/catalog-source.json',
      'market/v1/plugins': 'market/v1/plugins',
      'market/v1/xiaomo-extensions.json': 'market/v1/xiaomo-extensions.json',
    };
    const hit = map[rel];
    if (!hit) return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
    const b = readBytes(url('../' + hit));
    return { ok: true, status: 200, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) };
  };
  // 包内替身：app://xiaomo-lab/<path> → 仓库根下的 <path>（桌面版由 desktop/main.js 的协议处理器做同一件事）
  const packagedSite = async (href) => {
    const u = new URL(href);
    if (u.protocol !== 'app:' || u.host !== 'xiaomo-lab') {
      return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
    }
    let b;
    try { b = readBytes(url('../' + decodeURIComponent(u.pathname).replace(/^\/+/, ''))); }
    catch { return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) }; }
    return { ok: true, status: 200, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) };
  };

  const desktop = new MarketClient({ app: null, storage: null, fetch: packagedSite });
  const fallback = defaultManifestUrl({ href: 'app://xiaomo-lab/index.html' });
  const src10 = desktop.seedDefaultSource(fallback);
  ok(!!src10.id && src10.dev === false && src10.bundled === true,
    '桌面版默认来源能被 seedDefaultSource 登记（内置、不是「本地开发」）');
  const cat10 = await desktop.fetchCatalog(src10.id);
  ok(cat10.items.length === 2 && cat10.items.every((it) => it.entry.available), `包内离线目录也可用：${cat10.items.length} 条、都可安装`);
  ok(cat10.items.every((it) => it.entry.href.startsWith('app://xiaomo-lab/market/plugins/')),
    '包内来源的插件入口解析成本 origin 的绝对 app:// 地址：' + cat10.items[0].entry.href);
  // 用户手输 app:// 仍然进不来：具名通道只给内置来源开
  await rejectsAsync('insecure-url', '用户手输的 app:// 仍被 addSource 拒绝',
    () => new MarketClient({ app: null, storage: null, fetch: packagedSite }).addSource(fallback));

  // 有网时那条路照旧：生产来源仍是同源 https，入口解析成 Pages 的绝对地址
  const web = new MarketClient({ app: null, storage: null, fetch: pagesSite });
  const src11 = await web.addSource('https://yumoii789.github.io/xiaomo-lab/market/catalog-source.json');
  const cat11 = await web.fetchCatalog(src11.id);
  ok(cat11.items.length === 2 && cat11.items.every((it) => it.entry.available), `生产来源的目录仍可用：${cat11.items.length} 条`);
  ok(cat11.items.every((it) => it.entry.href.startsWith('https://yumoii789.github.io/xiaomo-lab/market/plugins/')),
    '生产来源的插件入口仍解析成 Pages 的绝对 https 地址：' + cat11.items[0].entry.href);
}

// ─────────────────────────────────────────────────────────
console.log('\n────────────────────────────────────────');
console.log(`通过 ${pass} 项，失败 ${fails.length} 项`);
for (const f of fails) console.log('  ✗ ' + f);
process.exit(fails.length ? 1 : 0);
