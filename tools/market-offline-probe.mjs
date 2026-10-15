/**
 * tools/market-offline-probe.mjs —— 「桌面版无网也能装插件」的最小改动探针
 *
 * 常态（全绿，EXIT=0）：
 *   node tools/market-offline-probe.mjs
 * 红测（同一批断言在变异体上必须红，EXIT=1）：
 *   node tools/market-offline-probe.mjs --mutate          # 让「app: → 包内离线 manifest」恒不走
 *   node tools/market-offline-probe.mjs --mutate=allow    # 让 assertAllowedUrl 不再认 app:
 *
 * 为什么要有它：这次改动的价值全在**无网时也能把市场用起来**，而无网没法当场复现
 * （改 hosts 是系统级动作）。于是把「离线可用」拆成可静态判定的事实：
 *   ① 桌面版 origin（app://）的默认来源 = 包内离线 manifest；
 *   ② 这份 manifest 的 endpoint / 旁挂文档 / 插件入口**全部落在包内**，且 sha256 与目录声明一致；
 *   ③ npm 包清单真的带上这些字节（否则「有兜底」是空话）；
 *   ④ 其余分支（https / 回环 / file / 畸形）**逐字不变** —— 在线行为一个字节都不许变。
 * ④ 的期望值是改动前实测的输出，硬编码在这里当回归基线；①②③ 是本轮新增的事实。
 *
 * 写盘范围：只在 %TEMP% 里写变异体，跑完删除；仓库零写入（末尾自检 sha256 与开头一致）。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const TMP = process.env.TEMP || process.env.TMPDIR || '/tmp';
const ARGV = process.argv.slice(2);
const MUTATE = ARGV.includes('--mutate') || ARGV.includes('--mutate=url') ? 'url'
  : ARGV.includes('--mutate=allow') ? 'allow' : null;

const MARKET_JS = path.join(ROOT, 'src/core/market.js');
const LOCAL_MANIFEST = path.join(ROOT, 'market/catalog-source.local.json');
const PAGE_MANIFEST = path.join(ROOT, 'market/catalog-source.json');
const V1 = path.join(ROOT, 'market/v1/plugins');
const V1_EXT = path.join(ROOT, 'market/v1/xiaomo-extensions.json');
const PKG = path.join(ROOT, 'package.json');
const README = path.join(ROOT, 'README.md');
const TOUCHED = [MARKET_JS, PKG, README, LOCAL_MANIFEST, V1, V1_EXT];

const read = (p) => fs.readFileSync(p);
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex').toUpperCase();
const rel = (p) => path.relative(ROOT, p).replace(/\\/g, '/');
const head = (s) => console.log('\n' + s);
let pass = 0; let fail = 0;
const ok = (cond, name) => { if (cond) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name); } };
const stamp = (label) => { for (const p of TOUCHED) console.log(`  [D36·${label}] ${rel(p).padEnd(34)} ${String(read(p).length).padStart(6)} B  ${sha256(read(p))}`); };

const APP_INDEX = 'app://xiaomo-lab/index.html';
const LOCAL_HREF = 'app://xiaomo-lab/market/catalog-source.local.json';
const ENDPOINT = 'app://xiaomo-lab/market/v1/plugins';
const EXT_HREF = 'app://xiaomo-lab/market/v1/xiaomo-extensions.json';
const PRODUCTION = 'https://yumoii789.github.io/xiaomo-lab/market/catalog-source.json';

// ── ① 开头戳 ─────────────────────────────────────────────
head('① 开头戳（D36：本轮改动的文件，字节数 + sha256）');
stamp('首');
const START_SHA = new Map(TOUCHED.map((p) => [p, sha256(read(p))]));

const M = await import(pathToFileURL(MARKET_JS).href);

// ── ② 默认来源分支表 ─────────────────────────────────────
head('② defaultManifestUrl 分支表（后 5 行是改动前的实测输出 = 在线行为回归基线）');
const CASES = [
  [APP_INDEX, LOCAL_HREF, 'app:（桌面版）→ 包内离线 manifest'],
  ['https://yumoii789.github.io/xiaomo-lab/index.html', PRODUCTION, 'https: → 同源 catalog-source.json'],
  ['http://127.0.0.1:7373/index.html', 'http://127.0.0.1:7373/market/_dev-fixtures/dev/catalog-source.local.json', '回环 http → 开发 fixture'],
  ['http://localhost:8080/a.html', 'http://localhost:8080/market/_dev-fixtures/dev/catalog-source.local.json', 'localhost 也算回环'],
  ['file:///C:/x/index.html', PRODUCTION, 'file: → 远端（不变）'],
  [null, PRODUCTION, 'null → 远端（不变）'],
  ['ftp://h/x', PRODUCTION, '未知协议 → 远端（不变）'],
];
for (const [href, want, why] of CASES) {
  const got = M.defaultManifestUrl(href === null ? null : { href });
  ok(got === want, `${why}：${got}`);
}

// ── ③ 包内离线 manifest 自身 ──────────────────────────────
head('③ 离线 manifest：地址全落在包内、信任标记是「内置」而不是「本地开发」');
const man = JSON.parse(read(LOCAL_MANIFEST).toString('utf8'));
const src = M.parseSource(man, { allowPackaged: true });
ok(src.transport.endpoint === ENDPOINT, `transport.endpoint = ${src.transport.endpoint}`);
ok(src.dev === false, 'dev === false（不冒充「本地开发来源」）');
ok(/\/v1\/plugins$/.test(new URL(src.transport.endpoint).pathname), 'endpoint 路径满足契约 pattern /v1/plugins');
ok(M.extensionsUrlFor(new URL(src.transport.endpoint)) === EXT_HREF, `旁挂文档地址 = ${EXT_HREF}`);
ok(src.providerId === JSON.parse(read(PAGE_MANIFEST).toString('utf8')).providerId, '与 Pages 上那份是同一个 providerId（同一份目录内容）');
ok(M.assertAllowedUrl(ENDPOINT, '测试', { allowPackaged: true }).dev === false, '包内通道下 app:// 不会被标成 dev');
let strictThrew = false;
try { M.assertAllowedUrl(ENDPOINT, '测试'); } catch { strictThrew = true; }
ok(strictThrew, '★ 不放行包内来源时 app:// 仍被拒 —— 信任边界没有被整体放宽');
ok(M.isPackagedSource({ bundled: true, url: LOCAL_HREF }) === true
  && M.isPackagedSource({ bundled: false, url: LOCAL_HREF }) === false
  && M.isPackagedSource({ bundled: true, url: 'https://x.example/m.json' }) === false,
  'isPackagedSource 只认「内置 + app:」两个条件都成立的记录');

// ── ④ 负向控制：放宽只针对 app: ──────────────────────────
head('④ 负向控制（放宽只针对 app:；别的仍然一律拒）');
const DENY = [
  ['http://evil.example/market/v1/plugins', '外部 http 主机'],
  ['ftp://x/market/v1/plugins', 'ftp:'],
  ['data:application/json,%7B%7D', 'data:'],
  ['file:///C:/x/market/v1/plugins', 'file:'],
  ['https://x.example:8443/market/v1/plugins', '非 443 端口'],
  ['app://xiaomo-lab/market/v1/plugins?x=1', 'app: 带 query（默认不允许）'],
  ['app://xiaomo-lab/market/v1/plugins', 'app: 默认不放行（与 ③ 收下的那条是同一个地址，差的只是 allowPackaged）'],
];
for (const [u, why] of DENY) {
  let threw = false;
  try { M.assertAllowedUrl(u, '测试'); } catch { threw = true; }
  ok(threw, `仍然拒绝：${why}`);
}

// ── ⑤ 端到端「离线能装」：入口字节在包内且哈希对得上 ──────
head('⑤ 离线安装链：目录 → 旁挂安装信息 → 包内字节 → sha256 校验');
const cat = JSON.parse(read(V1).toString('utf8'));
const ext = JSON.parse(read(V1_EXT).toString('utf8'));
ok(cat.items.length >= 1, `目录里有 ${cat.items.length} 条`);
for (const it of cat.items) {
  const e = ext.items[it.id];
  ok(!!e, `${it.id}：旁挂安装信息里有条目`);
  if (!e) continue;
  const abs = new URL(e.entry, ENDPOINT);
  ok(abs.protocol === 'app:' && abs.host === 'xiaomo-lab', `${it.id}：入口解析后仍落在包内（${abs.href}）`);
  const file = path.join(ROOT, decodeURIComponent(abs.pathname).replace(/^\/+/, ''));
  ok(fs.existsSync(file), `${it.id}：字节在包内（${rel(file)}）`);
  if (!fs.existsSync(file)) continue;
  const buf = read(file);
  ok(buf.length === e.bytes, `${it.id}：字节数一致（声明 ${e.bytes}，实测 ${buf.length}）`);
  ok(sha256(buf) === String(e.sha256).toUpperCase(), `${it.id}：sha256 与目录声明一致`);
}

// ── ⑥ npm 包清单真的带上这些字节 ─────────────────────────
head('⑥ package.json files：上面用到的每个路径都被覆盖');
const files = JSON.parse(read(PKG).toString('utf8')).files;
const covered = (r) => files.some((f) => f === r || (f.endsWith('/') && r.startsWith(f)));
for (const r of ['market/catalog-source.local.json', 'market/v1/plugins', 'market/v1/xiaomo-extensions.json',
  'market/plugins/lab-timer.js', 'market/plugins/equipment-booster.js']) {
  ok(covered(r), `覆盖 ${r}`);
}

// ── ⑦ 不变量：默认来源永远是个「能过校验」的地址 ─────────
head('⑦ 不变量：任何输入下 defaultManifestUrl 的返回值都过 assertAllowedUrl');
const HREFS = [null, '', APP_INDEX, 'APP://X/index.html', 'https://a.example/b', 'http://127.0.0.1:1/x',
  'http://example.com/x', 'file:///c:/x', 'chrome://x', 'not a url', '//x/y', 'app://xiaomo-lab/deep/dir/page.html'];
const bad = [];
for (const h of HREFS) {
  const u = M.defaultManifestUrl(h === null ? null : { href: h });
  try { M.assertAllowedUrl(u, '默认来源', { allowPackaged: u.startsWith('app:') }); } catch { bad.push(`${JSON.stringify(h)} → ${u}`); }
}
ok(bad.length === 0, bad.length ? `有 ${bad.length} 个输入违反了不变量：${bad.join(' | ')}` : `${HREFS.length} 个输入全部通过`);
console.log(`    （app: 的深路径也验一条：${M.defaultManifestUrl({ href: 'app://xiaomo-lab/deep/dir/page.html' })}）`);

// ── ⑧ 红测：同一批断言在变异体上必须红 ───────────────────
if (MUTATE) {
  head(`⑧ 变异（${MUTATE === 'url' ? '让 app: 这一支恒不走' : '让 assertAllowedUrl 不再认 app:'}）—— 同一批断言必须红`);
  const FROM = MUTATE === 'url' ? "      if (u.protocol === 'app:') {" : "const packaged = allowPackaged && u.protocol === 'app:';";
  const TO = MUTATE === 'url' ? "      if (false && u.protocol === 'app:') {" : 'const packaged = false;';
  let text = read(MARKET_JS).toString('utf8');
  const before = text.length;
  if (!text.includes(FROM)) { console.log('  ✗ 变异点没找到：' + FROM); fail++; }
  else {
    text = text.split(FROM).join(TO);
    text = text.split("'./bus.js'").join(JSON.stringify(pathToFileURL(path.join(ROOT, 'src/core/bus.js')).href));
    const out = path.join(TMP, `market-mutant-${MUTATE}-${process.pid}.mjs`);
    fs.writeFileSync(out, text);
    console.log(`  变异体：${out}`);
    console.log(`  源码 ${before} → ${text.length} 字节，改动行：`);
    text.split('\n').forEach((l, i) => { if (l.includes('false && u.protocol') || l.includes('const packaged = false')) console.log(`    ${i + 1}: ${l.trim()}`); });
    const MM = await import(pathToFileURL(out).href);

    // ★ 与 ② / ③ 里**同一条**断言：在变异体上必须不成立（这就是红测的形式）
    ok(MM.defaultManifestUrl({ href: APP_INDEX }) === LOCAL_HREF, '★ 同一条断言在变异体上（预期红）：app:// 仍返回包内离线 manifest');
    console.log(`     变异体实际返回：${MM.defaultManifestUrl({ href: APP_INDEX })}`);
    let parsed = null; let threw = false;
    try { parsed = MM.parseSource(man, { allowPackaged: true }); } catch { threw = true; }
    ok(!threw && parsed.transport.endpoint === ENDPOINT, '★ 同一条断言在变异体上（预期红）：包内 manifest 仍能过校验');
    fs.unlinkSync(out);
  }
}

// ── ⑨ 结尾戳 + 零写入自检 ────────────────────────────────
head('⑨ 结尾戳 + 零写入自检（仓库文件在本次运行中必须逐字节不变）');
stamp('尾');
let drift = 0;
for (const p of TOUCHED) if (sha256(read(p)) !== START_SHA.get(p)) { drift++; console.log('  ✗ 运行期间被改动：' + rel(p)); }
ok(drift === 0, '仓库零写入');

head(`结果：${pass} 项通过 / ${fail} 项失败${MUTATE ? `（变异模式 ${MUTATE}：预期有失败）` : ''}`);
process.exit(fail === 0 ? 0 : 1);
