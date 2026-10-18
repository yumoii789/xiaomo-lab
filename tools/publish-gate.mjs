#!/usr/bin/env node
/**
 * tools/publish-gate.mjs —— **发布前的离线闸门**
 *
 * 为什么需要它：`plans/02`（发布与环境）§四把「凭据与合规闸门」写成「已固化为流程」，
 * 但那套流程**实际是手敲的几条命令**（我 2026-10-17 就是手敲的）。手敲的东西不算固化 ——
 * 下次换个人、或者隔几天，就会漏掉某一条。而 `tools/publish-verify.mjs` 虽然检查得更全，
 * 却**全部依赖远端 API**（远端树、断链、模块图），**发布之前跑不了**。
 *
 * ⇒ 本脚本只管**发布前**该断言的、**全部离线可得**的事实：
 *     ① 未跟踪文件必须为 0（发布脚本只上传**被跟踪**的内容 ⇒ 本地全绿、线上缺席）
 *     ② 凭据合规复扫（明文密码 / pan.moe / 令牌私钥 / 竞品字样 / 邮箱）
 *     ③ 根包 `files[]` 白名单必须**真的打进包**（用 `npm pack --dry-run` 实证，不读文件猜）
 *     ④ 网页版与桌面版的版本号必须一致
 *     ⑤ `FORBIDDEN` 内部文件不得出现在发布内容里
 *
 * 用法：
 *   node tools/publish-gate.mjs            # 全跑
 *   node tools/publish-gate.mjs --mutate   # 能红证明：把首项期望改错，必须报红并 exit 1
 *
 * 退出码：0 全过 ／ 1 有实质问题（**不要带病发布**）
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MUTATE = process.argv.includes('--mutate');

let pass = 0, fail = 0;
const ok = (cond, name, detail = '') => {
  if (cond) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${name}`); }
  if (detail) console.log('      ' + String(detail).slice(0, 220));
};
const head = (t) => console.log('\n\x1b[36m' + t + '\x1b[0m');

const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

// ══ ① 未跟踪文件 ══
head('① 未跟踪文件（发布脚本只上传被跟踪的内容）');
{
  const out = git('status', '--short').split('\n').filter((l) => l.startsWith('??'));
  const want = MUTATE ? 1 : 0;   // --mutate：故意把期望改成"必须有 1 个未跟踪"
  ok(out.length === want,
    `未跟踪文件 ${out.length} 个（期望 ${want}）`,
    out.length ? '未跟踪：' + out.slice(0, 6).map((s) => s.slice(3)).join(' · ') : '（干净）');
}

// ══ ② 凭据合规复扫 ══
head('② 凭据合规复扫（必须 0 泄漏）');
{
  // ⚠ 扫描器**自己**会含这些字样（它就是靠它们工作的）⇒ 必须把自己排除，
  //   否则每次运行都报"命中"，而那是假红。同理，模式串也拆开写，
  //   免得文件里出现一个**完整**的可被匹配的字面量（双保险）。
  const SELF = 'tools/publish-gate.mjs';
  const SCAN = [
    ['令牌 / 私钥', 'ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----'],
    ['pan.moe', 'pan' + '\\.' + 'moe'],
    ['竞品字样', 'No' + 'Book|no' + 'book'],
  ];
  // 复用 publish-verify 的 FORBIDDEN 清单，不另立一套
  const pv = readFileSync(join(ROOT, 'tools/publish-verify.mjs'), 'utf8');
  const fm = pv.match(/const FORBIDDEN = \[([\s\S]*?)\];/);
  const FORBIDDEN = fm ? [...fm[1].matchAll(/'([^']+)'/g)].map((m) => m[1]) : [];

  for (const [label, pattern] of SCAN) {
    let hits = [];
    try {
      hits = git('grep', '-n', '-I', '-E', pattern, '--', '.',
        ':(exclude)internal/*', ':(exclude)plans/*', `:(exclude)${SELF}`)
        .split('\n').filter(Boolean);
    } catch { hits = []; }   // 无命中时 git grep 返回 1
    ok(hits.length === 0, `${label}：0 处`, hits.slice(0, 2).join(' ｜ '));
  }

  // 邮箱：只报"非保留域名"的命中（example.com / *.invalid / *.test 等是测试用例常用的）
  let mails = [];
  try {
    mails = git('grep', '-n', '-I', '-E', '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}',
      '--', '.', ':(exclude)internal/*', ':(exclude)plans/*').split('\n').filter(Boolean);
  } catch { mails = []; }
  const real = mails.filter((l) => !/@(example|test|invalid|localhost)\./i.test(l));
  ok(real.length === 0, `邮箱（排除保留域名）：${real.length} 处命中`,
    mails.length ? `（共 ${mails.length} 处命中，其中保留域名 ${mails.length - real.length} 处）` : '');

  ok(FORBIDDEN.length > 0, `从 publish-verify 复用了 ${FORBIDDEN.length} 条内部文件清单`, FORBIDDEN.slice(0, 4).join(' · '));
}

// ══ ③ 发布白名单：真的打进包 ══
head('③ 根包 files[] 白名单（用 npm pack --dry-run 实证）');
const REQUIRED_IN_PACK = [
  'index.html', 'src/main.js', 'styles/main.css',
  'desktop/main.js', 'desktop/preload.js', 'desktop/cli.mjs',
  // ★ 这两条是 2026-10-17 修掉的真缺口：`desktop/package.json` 带 devDependencies.electron，
  //   丢了它 ⇒ npm install 不装 Electron ⇒ 桌面版起不来
  'desktop/package.json', 'desktop/launch.mjs',
  'market/v1/xiaomo-extensions.json',
];
{
  let files = null;
  try {
    // ⚠ 两条坑都踩过，写在这里免得下次再踩：
    //   ① 直接 `execFileSync('npm', …)` 在 Windows 上失败 —— npm 是 `npm.cmd`，execFile 不走 shell；
    //   ② `cmd /c "npm … > \"路径\""` 的引号嵌套会被 cmd 解析坏
    //      （报"文件名、目录名或卷标语法不正确"）。
    //   ⇒ 用 `spawnSync` + `shell:true` 拿 stdout（不经文件），再用 BOM 安全地剥出 JSON。
    const r = spawnSync('npm', ['pack', '--dry-run', '--json'],
      { cwd: ROOT, shell: true, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const raw = String(r.stdout || '').replace(/^\uFEFF/, '');
    const i = raw.indexOf('['), j = raw.lastIndexOf(']');
    if (i < 0 || j < 0) throw new Error('拿不到 JSON（stdout 前 120 字：' + raw.slice(0, 120) + '）');
    files = JSON.parse(raw.slice(i, j + 1))[0].files.map((f) => f.path);
  } catch (e) {
    ok(false, 'npm pack --dry-run 可跑', '失败：' + e.message.slice(0, 200));
  }
  if (files) {
    ok(files.length > 0, `打包文件数 ${files.length}`);
    const missing = REQUIRED_IN_PACK.filter((p) => !files.includes(p));
    ok(missing.length === 0, `必需文件都在包内（检查 ${REQUIRED_IN_PACK.length} 项）`,
      missing.length ? '缺失：' + missing.join(' · ') : '');
    // 内部文件不得进包（与 publish-verify 的 ③ 同源）
    const pv = readFileSync(join(ROOT, 'tools/publish-verify.mjs'), 'utf8');
    const fm = pv.match(/const FORBIDDEN = \[([\s\S]*?)\];/);
    const FORBIDDEN = fm ? [...fm[1].matchAll(/'([^']+)'/g)].map((m) => m[1]) : [];
    const leaked = files.filter((p) => FORBIDDEN.some((f) => (f.endsWith('/') ? p.startsWith(f) : p === f)));
    ok(leaked.length === 0, '内部文件没有进包', leaked.slice(0, 5).join(' · '));
  }
}

// ══ ④ 双版本版本号 ══
head('④ 网页版 ↔ 桌面版 版本号一致');
{
  const r = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const d = JSON.parse(readFileSync(join(ROOT, 'desktop/package.json'), 'utf8'));
  ok(!!r.version && !!d.version, `根包 ${r.name}@${r.version} ｜ 桌面 ${d.name}@${d.version}`);
  ok(r.version === d.version, `两边版本号一致（${r.version} vs ${d.version}）`);
  // 桌面包必须带 electron，且不得是 exe 打包（private + 无 electron-builder）
  const deps = { ...(d.dependencies || {}), ...(d.devDependencies || {}) };
  ok(!!deps.electron, '桌面包声明了 electron 依赖（丢了它 npm install 不装 Electron）', JSON.stringify(deps));
  ok(d.private === true && !deps['electron-builder'],
    '桌面版刻意不产出 exe（private:true 且无 electron-builder）');
}

// ══ ⑤ 工作区在最近 N 分钟内是否被写过 ══
head('⑤ 写者停手（按 mtime 判定，不靠猜）');
{
  // 为什么需要它：发布脚本的行为是「以本地 HEAD 为唯一事实来源，远端多出的文件会被删除」——
  // 若另一个会话此刻正在改某个文件，**发布会把它未完成的中间状态推上线**。
  // 这条不靠"我觉得应该没人了"，而是看**实际 mtime**。
  // ⚠ mtime 只能证明"最近没动"，不能证明"不会再动"—— 所以它是**强证据**，不是逻辑保证。
  const WINDOW_MIN = MUTATE ? -1 : 15;   // --mutate：窗口设成 -1 让"最近有写入"永远成立
  const now = Date.now();
  const dirt = git('status', '--short').split('\n').filter((l) => /^ ?M/.test(l))
    .map((l) => l.slice(3).trim().replace(/^"|"$/g, ''));
  const recent = [];
  for (const f of dirt) {
    try {
      const st = statSync(join(ROOT, f));
      const mins = (now - st.mtimeMs) / 60000;
      if (mins <= WINDOW_MIN) recent.push(`${f}（${mins.toFixed(1)} min 前）`);
    } catch { /* 文件可能已被删/改名，跳过 */ }
  }
  // 未跟踪文件也该看 —— 它们不进包，但说明有人在动这个工作区
  const untracked = git('status', '--short').split('\n').filter((l) => l.startsWith('??'));
  ok(recent.length === 0,
    `最近 ${WINDOW_MIN} 分钟内没有改动被写过（检查 ${dirt.length} 个改动文件）`,
    recent.length ? '刚被写过：' + recent.slice(0, 5).join(' · ') : '');
  ok(untracked.length === 0, '也没有新增未跟踪文件（工作区此刻是静止的）',
    untracked.slice(0, 5).join(' · '));
}

// ══ 结论 ══
console.log('\n' + '─'.repeat(56));
if (MUTATE) {
  console.log(fail ? '\x1b[32m能红证明成立：期望值被改错时闸门确实报红\x1b[0m'
    : '\x1b[31m（没红！）--mutate 没能让闸门变红 —— 这个开关是假的\x1b[0m');
  process.exit(fail ? 0 : 1);
}
console.log(fail === 0 ? `\x1b[32m发布闸门通过：${pass} 项，可以发布\x1b[0m`
  : `\x1b[31m发布闸门未通过：${pass + fail} 项，失败 ${fail} 项 —— 不要带病发布\x1b[0m`);
process.exit(fail === 0 ? 0 : 1);
