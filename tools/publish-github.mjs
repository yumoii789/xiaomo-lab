#!/usr/bin/env node
/**
 * 把本地 git 仓库同步到 GitHub —— 走 REST API，不用 git push。
 *
 * 为什么需要它：某些网络环境里 hosts 把 github.com / api.github.com 指向
 * 127.0.0.1（本机就是），git-over-HTTPS 会连到本机从而永远失败，而
 * api.github.com 在 .NET / Node 的直连路径下仍然可用。所以发布改走 API。
 *
 * 用法：
 *   $env:GITHUB_TOKEN = '你的令牌'      # 不要写进任何文件
 *   node --use-system-ca tools/publish-github.mjs        # 真正发布
 *   node --use-system-ca tools/publish-github.mjs --dry  # 只看会改哪些文件
 *
 * 必须带 --use-system-ca：这类网络环境通常有一个本地 HTTPS 拦截代理，
 * 它的根 CA 只装在 Windows 证书库里，Node 自带的 CA 列表不认它，会报
 * UNABLE_TO_VERIFY_LEAF_SIGNATURE。--use-system-ca 让 Node 改用系统证书库。
 *
 * 行为：
 *   - 以本地 HEAD 的树为准，只上传与远端 SHA 不同的 blob（GitHub 的 blob
 *     SHA 就是内容哈希，所以比较 SHA 等价于比较内容）。
 *   - 远端多出来的文件会被删除（本地 HEAD 是唯一事实来源）。
 *   - 提交信息取自本地 HEAD 的提交信息，父提交是远端 main。
 *   - 空仓库首次发布：先用 Contents API 落一个文件（Git Data API 在空仓库
 *     上建 blob 会返回 409），再走正常流程。
 */
import { execFileSync } from 'node:child_process';
import process from 'node:process';

const OWNER = 'yumoii789';
const REPO = 'xiaomo-lab';
const BRANCH = 'main';
const API = `https://api.github.com/repos/${OWNER}/${REPO}`;
const DRY = process.argv.includes('--dry');

const token = process.env.GITHUB_TOKEN;
if (!token) {
  console.error('缺少 GITHUB_TOKEN 环境变量。用法：$env:GITHUB_TOKEN = "..." ; node tools/publish-github.mjs');
  process.exit(1);
}

const MAXBUF = 64 * 1024 * 1024;
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: MAXBUF });

async function api(method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: {
      Authorization: `token ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'xiaomo-lab-publisher',
      // 必须带 charset，且 body 以 UTF-8 字节发送，否则中文路径与提交信息会被
      // 降级成问号（这是踩过的坑）。
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8'),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> HTTP ${res.status}\n${text.slice(0, 600)}`);
  return text ? JSON.parse(text) : null;
}

/** 本地 HEAD 的全部 blob：path -> {mode, sha} */
function readLocalTree() {
  const out = new Map();
  const raw = git('ls-tree', '-r', '-z', '--full-tree', 'HEAD');
  for (const line of raw.split('\0')) {
    if (!line) continue;
    const tab = line.indexOf('\t');
    const [mode, type, sha] = line.slice(0, tab).split(' ');
    if (type !== 'blob') continue;
    out.set(line.slice(tab + 1), { mode, sha });
  }
  return out;
}

const local = readLocalTree();
console.log(`本地 HEAD blob: ${local.size}`);
// 保险一：读不到文件时立刻中止。否则下面的 removed 会等于远端全部文件，
// 一次误跑就会把整个仓库删空。
if (local.size === 0) {
  console.error('中止：本地 HEAD 一个文件都读不到，可能是 git 状态异常。');
  process.exit(1);
}

// 保险二：有未被跟踪的文件就中止。
// 项目已经因此出过一次线上事故——src/main.js 引用了新建的 src/plugins/index.js，
// 但那个文件没被 git add，于是发布出去的站点缺少模块、整个模块图崩掉、
// 应用直接起不来（本地正常，线上全黑）。本脚本只发布被跟踪的内容，
// 所以「本地有、索引里没有」的文件必须在这里被拦下。
const untracked = git('ls-files', '--others', '--exclude-standard').split('\n').filter(Boolean);
if (untracked.length) {
  console.error(`中止：有 ${untracked.length} 个文件未被 git 跟踪，它们不会进入仓库。`);
  for (const f of untracked.slice(0, 40)) console.error('  ? ' + f);
  if (untracked.length > 40) console.error(`  … 另有 ${untracked.length - 40} 个`);
  console.error('处理：需要发布的先 git add；确认无关的加进 .gitignore。');
  process.exit(1);
}
console.log('未跟踪文件检查：通过（0 个）');

// 远端现状
let remoteCommit = null;
let remoteTreeSha = null;
try {
  remoteCommit = (await api('GET', `/git/ref/heads/${BRANCH}`)).object.sha;
  remoteTreeSha = (await api('GET', `/git/commits/${remoteCommit}`)).tree.sha;
} catch (e) {
  if (!/HTTP 404|HTTP 409/.test(e.message)) throw e;
  console.log('远端还没有 main 分支（空仓库），将走首次发布流程。');
}

const remote = new Map();
if (remoteTreeSha) {
  const t = await api('GET', `/git/trees/${remoteTreeSha}?recursive=1`);
  for (const e of t.tree) if (e.type === 'blob') remote.set(e.path, e.sha);
}
console.log(`远端 main blob: ${remote.size}`);

// 差异
const changed = [];
for (const [path, e] of local) if (remote.get(path) !== e.sha) changed.push(path);
const removed = [...remote.keys()].filter((p) => !local.has(p));
// 先建一个占位文件，避免空仓库不能建 blob 的 409
if (!remoteTreeSha && changed.length) {
  const seed = changed.includes('README.md') ? 'README.md' : changed[0];
  const b64 = execFileSync('git', ['cat-file', 'blob', local.get(seed).sha], { maxBuffer: MAXBUF }).toString('base64');
  const r = await api('PUT', `/contents/${encodeURIComponent(seed)}`, {
    message: git('log', '-1', '--pretty=%s').trim() || '初始化',
    content: b64,
  });
  remoteCommit = r.commit.sha;
  remoteTreeSha = (await api('GET', `/git/commits/${remoteCommit}`)).tree.sha;
  remote.set(seed, local.get(seed).sha);
  console.log(`首次发布：先落 ${seed}（${remoteCommit.slice(0, 7)}）`);
}

const todo = changed.filter((p) => remote.get(p) !== local.get(p).sha);
console.log(`新增/修改 ${todo.length} 个，删除 ${removed.length} 个`);
for (const p of todo.slice(0, 40)) console.log(`  M ${p}`);
if (todo.length > 40) console.log(`  … 另有 ${todo.length - 40} 个`);
for (const p of removed.slice(0, 40)) console.log(`  D ${p}`);

if (DRY) {
  console.log('--dry：未做任何修改。');
  process.exit(0);
}
if (todo.length === 0 && removed.length === 0) {
  console.log('远端已与本地 HEAD 一致，无需发布。');
  process.exit(0);
}

// 上传 blob
const tree = [];
for (const path of todo) {
  const sha = local.get(path).sha;
  const b64 = execFileSync('git', ['cat-file', 'blob', sha], { maxBuffer: MAXBUF }).toString('base64');
  const blob = await api('POST', '/git/blobs', { content: b64, encoding: 'base64' });
  tree.push({ path, mode: local.get(path).mode, type: 'blob', sha: blob.sha });
}
for (const path of removed) tree.push({ path, mode: '100644', type: 'blob', sha: null });

const newTree = await api('POST', '/git/trees', { base_tree: remoteTreeSha, tree });
const message = git('log', '-1', '--pretty=%B').trim() || '更新';
const parents = remoteCommit ? [remoteCommit] : [];
const commit = await api('POST', '/git/commits', { message, tree: newTree.sha, parents });
if (remoteCommit) {
  await api('PATCH', `/git/refs/heads/${BRANCH}`, { sha: commit.sha, force: false });
} else {
  await api('POST', '/git/refs', { ref: `refs/heads/${BRANCH}`, sha: commit.sha });
}

console.log(`已发布：${commit.sha.slice(0, 7)}  树 ${newTree.sha.slice(0, 7)}（${newTree.tree.length} 条变更）`);
console.log(`仓库：https://github.com/${OWNER}/${REPO}`);
console.log(`站点：https://${OWNER}.github.io/${REPO}/   （Pages 通常 30–60 秒后更新）`);
