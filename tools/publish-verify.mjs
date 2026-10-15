#!/usr/bin/env node
/**
 * tools/publish-verify.mjs —— 发布后自检：**现在线上那一份能不能跑？**
 *
 *   node tools/publish-verify.mjs [--ref <branch|sha>]
 *
 * 为什么需要它：发布脚本（tools/publish-github.mjs）只保证「不会带未跟踪文件上去」，
 * 不保证「上去的东西能跑」。本仓库真出过事故 ——
 *   Fix live outage: commit the two new files the app already depends on
 * 病因是「本地全绿、线上白屏」：本地跑工作区（文件都在），线上跑的是被跟踪的那一份。
 * 所以每次发布后都要有一条可复跑的核对。
 *
 * 为什么走 GitHub API 而不是抓 github.io：本机 hosts 把 github.io **和 api.github.com 都**指向
 * 127.0.0.1（本地 TLS 代理），抓网页抓不到；而经本地代理访问 API 是通的。API 读的是**远端仓库内容**，
 * 与 Pages 实际托管的文件同源（Pages 就是拿这棵树渲染的），所以核对有效。
 *
 * ⚠ 本机的证书坑：Node 默认只信任内置 CA，而本地代理用的是 Windows 证书库里的 CA →
 * 直接 fetch 会 UNABLE_TO_VERIFY_LEAF_SIGNATURE。所以这里不用 fetch，改用 node:https 并把
 * Windows 系统证书库的 CA 交给它（等价于 `node --use-system-ca`），这样一条命令即可运行。
 *
 * 只读：本文件不做任何远端写操作。
 *
 * 退出码：0 全过 ／ 1 有实质问题 ／ 2 网络不可达或读不到远端（网络问题 ≠ 线上坏了，
 *         单独区分以免 CI 误判）。
 *
 * 环境变量 XM_PUBLISH_API 可覆盖 API 基址（只为验证「网络失败」这条路径而留的注入点）。
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import process from 'node:process';
import tls from 'node:tls';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const API_BASE = process.env.XM_PUBLISH_API || 'https://api.github.com';
const REF_ARG = (() => {
  const i = process.argv.indexOf('--ref');
  return i > 0 ? process.argv[i + 1] : null;
})();

/** 线上绝不能出现的内部文件（都是 .gitignore 挡住的东西，这里是第二道保险） */
const FORBIDDEN = [
  'plans/',
  'docs/任务清单.md',
  'tools/sync.config.json',
  'tools/.sync-state.json',
  'tools/backup.log',
];

const fail = (msg) => { console.error('✗ ' + msg); process.exit(2); };

/**
 * 从发布脚本里读 OWNER/REPO/BRANCH —— **只做字面量解析，绝不 import**。
 * 那个文件的顶层就是发布流程（读 token、比对、POST commit），import 它等于真的推一次仓库，
 * 而本工具是只读的。复制成两份常量也不行（会漂移），所以解析同一份源码。
 */
function readTarget() {
  const src = readFileSync(path.join(ROOT, 'tools/publish-github.mjs'), 'utf8');
  const pick = (name) => {
    const m = new RegExp(`^const ${name} = '([^']+)'`, 'm').exec(src);
    return m ? m[1] : null;
  };
  const owner = pick('OWNER'), repo = pick('REPO'), branch = pick('BRANCH');
  if (!owner || !repo || !branch) fail('tools/publish-github.mjs 里读不到 OWNER/REPO/BRANCH，地址解析失败。');
  return { owner, repo, branch };
}

// ── GitHub API（只读；node:https + 系统证书库，见文件头「证书坑」）──
let TARGET = null;
const SYSTEM_CA = (() => {
  try {
    const ca = tls.getCACertificates('system');   // Node ≥22.15 / ≥23.2
    return Array.isArray(ca) && ca.length ? ca : [];
  } catch { return []; }
})();

function httpGet(url) {
  // 正常路径是 https://api.github.com；XM_PUBLISH_API 注入的本地 stub 是 http，
  // 按协议挑模块，免得「测试注入口」自己成为不可用的一行。
  const mod = new URL(url).protocol === 'http:' ? http : https;
  return new Promise((resolve, reject) => {
    const req = mod.get(url, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'xiaomo-publish-verify' },
      ...(SYSTEM_CA.length ? { ca: SYSTEM_CA } : {}),
      timeout: 20000,
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; if (body.length > 8e6) req.destroy(new Error('响应过大')); });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('请求超时 20s'), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
  });
}

const TLS_HINT = /UNABLE_TO_VERIFY|SELF_SIGNED|CERT_|ERR_TLS/i;

async function api(pathname) {
  const url = `${API_BASE}/repos/${TARGET.owner}/${TARGET.repo}${pathname}`;
  let res;
  try {
    res = await httpGet(url);
  } catch (e) {
    const err = new Error(`${API_BASE} 不可达（${e.code || e.name}: ${e.message}）`
      + (TLS_HINT.test(String(e.code) + e.message)
        ? '\n  提示：本机 hosts 把 api.github.com 指向 127.0.0.1 的本地代理，其证书在 Windows 证书库；' +
          (SYSTEM_CA.length ? '本进程已加载系统 CA，仍失败说明代理未运行。' : '本进程读不到系统 CA，请改用 node --use-system-ca 运行。')
        : ''));
    err.network = true;
    throw err;
  }
  if (res.status < 200 || res.status >= 300) {
    const err = new Error(`HTTP ${res.status} ${pathname}\n${res.body.slice(0, 300)}`);
    // 5xx / 限流：是我们读不到，不是线上坏了 → 也算网络类，交给退出码 2
    if (res.status >= 500 || res.status === 403) err.network = true;
    throw err;
  }
  return JSON.parse(res.body);
}

async function readRemoteFile(file, ref) {
  const enc = file.split('/').map(encodeURIComponent).join('/');
  const j = await api(`/contents/${enc}?ref=${encodeURIComponent(ref)}`);
  if (Array.isArray(j)) throw new Error('这是一个目录，不是文件');
  return Buffer.from(j.content || '', 'base64').toString('utf8');
}

// ── 引用解析（正则；允许把认不出的当「跳过」，但不许漏报相对路径）──
const SKIP_SCHEME = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i;

function resolveFrom(fromFile, spec) {
  if (SKIP_SCHEME.test(spec) || !spec.startsWith('.')) return null;
  const clean = spec.split('?')[0].split('#')[0];
  if (!clean) return null;
  return path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), clean));
}

/** index.html 在仓库根目录：HTML 里的本地资源本来就写成 `src/main.js` 这种不带 `./` 的相对路径，
    不能套用 JS 模块说明符那套「只认 ./」的规则（第一版就是这么错的：断链检查报了 0 个引用）。 */
function resolveHtmlRef(spec) {
  if (SKIP_SCHEME.test(spec)) return null;
  const clean = spec.split('?')[0].split('#')[0];
  if (!clean) return null;
  return clean.startsWith('/') ? clean.slice(1) : path.posix.normalize(clean);
}

/** index.html 里引用的本地资源 */
function refsInHtml(html) {
  const out = new Map();
  const add = (spec, why) => {
    const p = resolveHtmlRef(spec);
    if (p && !out.has(p)) out.set(p, why);
  };
  for (const m of html.matchAll(/<script[^>]*\ssrc=["']([^"']+)["']/gi)) add(m[1], 'index.html <script src>');
  for (const m of html.matchAll(/<link[^>]*\shref=["']([^"']+)["']/gi)) add(m[1], 'index.html <link href>');
  for (const m of html.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)) add(m[1], 'index.html 内联 import()');
  for (const m of html.matchAll(/\bsrc=["']([^"']+\.(?:png|jpe?g|svg|webp|ico|json))["']/gi)) add(m[1], 'index.html 资源 src');
  return out;
}

const SPEC_RES = [
  /\bimport\s+[^"'`;()]*?\sfrom\s*["']([^"']+)["']/g,  // import x from '…'（含跨行的大括号列表）
  /\bimport\s*["']([^"']+)["']/g,                      // import '…'（副作用导入）
  /\bexport\s+[^"'`;()]*?\sfrom\s*["']([^"']+)["']/g,   // export … from '…'
  /\bimport\(\s*["']([^"']+)["']\s*\)/g,               // 动态 import('…') 字面量
];

function specsInJs(src) {
  const out = new Set();
  for (const re of SPEC_RES) {
    for (const m of src.matchAll(re)) {
      // 说明符不含空白、也不会很长：把「正则跨进了 HTML 模板字面量」这类误捕挡掉
      if (!/\s/.test(m[1]) && m[1].length <= 120) out.add(m[1]);
    }
  }
  return out;
}

// ── 主流程 ──
TARGET = readTarget();
const ref = REF_ARG || TARGET.branch;
const line = (s = '') => console.log(s);
const list = (arr, max = 12) => {
  for (const s of arr.slice(0, max)) line('    · ' + s);
  if (arr.length > max) line(`    … 另有 ${arr.length - max} 条`);
};

line(`远端：${TARGET.owner}/${TARGET.repo}@${ref}（owner/repo/branch 解析自 tools/publish-github.mjs）`);

let tree, head;
try {
  head = await api(`/commits/${encodeURIComponent(ref)}`);
  tree = await api(`/git/trees/${encodeURIComponent(ref)}?recursive=1`);
} catch (e) {
  if (e.network) { console.error('✗ 读不到远端（网络类失败，退出码 2）：\n  ' + e.message); process.exit(2); }
  console.error('✗ 读远端失败：' + e.message);
  process.exit(1);
}
const remoteSha = new Map(tree.tree.filter((e) => e.type === 'blob').map((e) => [e.path, e.sha]));
const blobs = new Set(remoteSha.keys());
line(`线上提交：${head.sha.slice(0, 7)}   ${head.commit.committer.date}   「${(head.commit.message || '').split('\n')[0].slice(0, 60)}」`);
line(`线上 blob：${blobs.size}${tree.truncated ? '（⚠ 树被 GitHub 截断，下面的检查不完整）' : ''}`);

// ── ① 断链：index.html 引用的资源必须在线上树里 ──
let html = null;
try { html = await readRemoteFile('index.html', ref); } catch (e) { line(`⚠ 读不到线上 index.html：${e.message}`); }
const htmlRefs = html ? refsInHtml(html) : new Map();
const brokenRefs = [...htmlRefs].filter(([p]) => !blobs.has(p));

// ── ② 入口可达性：从入口模块递归走静态 import ──
const entry = [...htmlRefs.keys()].find((p) => p.endsWith('.js')) || 'src/main.js';
const seen = new Set();
const modMissing = [];
const skipped = new Set();
let fetched = 0;
const queue = [entry];
while (queue.length) {
  const f = queue.shift();
  if (seen.has(f)) continue;
  seen.add(f);
  if (!blobs.has(f)) { modMissing.push(`${f}（线上树里没有这个文件）`); continue; }
  let src;
  try { src = await readRemoteFile(f, ref); } catch (e) { modMissing.push(`${f}（读取失败：${e.message}）`); continue; }
  fetched++;
  for (const spec of specsInJs(src)) {
    const t = resolveFrom(f, spec);
    if (!t) { skipped.add(spec); continue; }           // 裸模块名/绝对 URL：零依赖项目里出现即为可疑，但不算漏报
    const cands = [t, t + '.js', t + '/index.js'];
    const hit = cands.find((c) => blobs.has(c));
    if (hit) queue.push(hit);
    else modMissing.push(`${t}（被 ${f} 引用）`);
  }
}

// ── ③ 内部文件泄漏 ──
const leaks = [...blobs].filter((p) => FORBIDDEN.some((f) => (f.endsWith('/') ? p.startsWith(f) : p === f)));

// ── ④ 与本地对照（本地真值取 HEAD：发布脚本推的就是 HEAD 的整棵树，不是索引也不是工作区）──
const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
// 同时取 blob sha：GitHub 的 tree 条目 sha 就是 git blob sha，只比路径会漏掉
// 「路径一样、内容还是旧版」——线上落后一个提交时就是这种情况。
const localSha = new Map();
for (const l of git('ls-tree', '-r', 'HEAD').split('\n')) {
  if (!l) continue;
  const tab = l.indexOf('\t');
  if (tab < 0) continue;
  localSha.set(l.slice(tab + 1), l.slice(0, tab).split(/\s+/)[2]);
}
const local = new Set(localSha.keys());
const staged = git('diff', '--cached', '--name-only').split('\n').filter(Boolean);
// 这两条是「本地看着是全的、上线却是旧版/缺文件」的另两种来源：
// 未跟踪的文件发布脚本会直接拒绝发布；改了但没提交的文件不会被推上去（发布读的是 HEAD）。
const untracked = git('ls-files', '--others', '--exclude-standard').split('\n').filter(Boolean);
const dirty = git('diff', '--name-only', 'HEAD').split('\n').filter(Boolean);
const localOnly = [...local].filter((p) => !blobs.has(p));   // 本地有线上无 → 这次没发布上去
const remoteOnly = [...blobs].filter((p) => !local.has(p));  // 线上有本地无 → 旧文件没清掉
const contentDiff = [...local].filter((p) => blobs.has(p) && localSha.get(p) !== remoteSha.get(p));
const same = [...local].filter((p) => blobs.has(p)).length;

// ── 报告 ──
line('');
line('① 断链检查（index.html 引用的资源是否都在线上）');
line(`  引用 ${htmlRefs.size} 个本地资源，断链 ${brokenRefs.length} 个`);
list(brokenRefs.map(([p, why]) => `${p}  ← ${why}`));

line('');
line('② 入口可达性（从 ' + entry + ' 递归静态 import）');
line(`  遍历到模块 ${fetched} 个，缺失 ${modMissing.length} 个，跳过（非相对说明符）${skipped.size} 个`);
list(modMissing);
if (skipped.size) list([...skipped].map((s) => `跳过：${s}`));

line('');
line('③ 内部文件泄漏（plans/ · docs/任务清单.md · sync.config.json · .sync-state.json · backup.log）');
line(`  泄漏 ${leaks.length} 条`);
list(leaks);

line('');
line(`④ 与本地对照（本地真值 = HEAD 的 ${local.size} 个 blob；发布脚本推的就是它）`);
line(`  一致 ${same} · 本地有线上无 ${localOnly.length} · 线上有本地无 ${remoteOnly.length} · 内容不同 ${contentDiff.length}`);
if (localOnly.length) { line('  ⚠ 本地有线上无（这次没发布上去 → 线上可能缺文件）：'); list(localOnly); }
if (remoteOnly.length) { line('  ⚠ 线上有本地无（旧文件残留，不判红，但发布前值得看一眼）：'); list(remoteOnly); }
if (contentDiff.length) { line('  ⚠ 内容不同（路径一样但线上还是旧版 → 线上落后于本地 HEAD）：'); list(contentDiff); }
if (staged.length) { line(`  ⚠ 暂存未提交 ${staged.length} 个（它们不在 HEAD 里，不会被发布）：`); list(staged); }
if (untracked.length) { line(`  ⚠ 未跟踪 ${untracked.length} 个（发布脚本会因此拒绝发布；线上不会有它们）：`); list(untracked); }
if (dirty.length) { line(`  ⚠ 改了但没提交 ${dirty.length} 个（发布推的是 HEAD，这些改动不会上线）：`); list(dirty); }

// 「能不能跑」= 站点自身自洽（引用都在、模块图完整、无内部文件泄漏），
// 以及确实读到了 index.html 与它的引用（读到 0 个引用说明检查本身失效，不能算绿）。
// 与本地 HEAD 的落差（落后一个提交 / 有文件待发布）是**发布节奏**问题，只警告不判红 ——
// 否则开发期的正常状态会天天报警，告警一多就没人看了。
const ok = brokenRefs.length === 0 && modMissing.length === 0 && leaks.length === 0
  && htmlRefs.size > 0 && html !== null && !tree.truncated;
line('');
line(`PUBLISH_CHECK ok=${ok} remote=${blobs.size} local=${local.size} missing=${localOnly.length} extra=${remoteOnly.length} leaks=${leaks.length} brokenRefs=${brokenRefs.length}`);
line(`PUBLISH_EXTRA commit=${head.sha.slice(0, 7)} modules=${fetched} moduleMissing=${modMissing.length} skipped=${skipped.size} staged=${staged.length} untracked=${untracked.length} dirty=${dirty.length} contentDiff=${contentDiff.length} htmlRefs=${htmlRefs.size} truncated=${tree.truncated} forbiddenSources=${FORBIDDEN.length}`);
line(ok ? '线上这份能跑：无断链、无缺失模块、无内部文件泄漏（与本地 HEAD 的落差见 ④ 的警告）。'
        : '⚠ 线上这份有问题，见上面各节。');
process.exit(ok ? 0 : 1);
