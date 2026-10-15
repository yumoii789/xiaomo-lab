/**
 * tools/browser-instances.mjs —— 无头浏览器的「实例级」清理判定器（D53）
 *
 * 为什么需要它：每个探针都在 finally 里删自己的临时 profile，可**删没删干净只有它自己知道**。
 * 失败路径尤其需要这句话 —— 探针挂掉时如果 Edge 还活着，profile 目录会被占住、
 * rmSync 失败又被 catch 悄悄吞掉，于是「看起来清理了」和「真残留了一堆进程」长得一模一样。
 * 于是失败报告里必须带一句可判定的结论：**已清理** 还是 **残留 N 个实例**。
 *
 * ⚠ 判定单位必须是**实例，不是进程**（D53）。实测一个无头 Edge 实例 =
 *   **13 个进程**：1 个根 + 12 个带 --type= 的子进程
 *   （crashpad-handler / gpu-process / utility ×2 / renderer ×8）。
 * 所以：
 *   · 用「进程数」当指标，1 个残留实例会报成 13 ⇒ **系统性虚高** ✗；
 *   · 正确做法：按 `--user-data-dir` 的**全路径**归组 ⇒ 每组恰好一个根 ⇒ 组数就是实例数 ✓。
 *
 * 根怎么认：**命令行里没有 `--type=`** 的那个就是根 ✓（实测根无 `--type`，
 * 12 个子进程全都有）。绝不靠「PPID 是不是 0」或「谁先启动」这类会变的特征。
 *
 * 为什么按全路径归组、而不是按目录名前缀：前缀是各探针自己起的
 * （touch-check 用 `xiaomo-cdp-`，dotscan 用 `dotscan-`，hitscan 用 `hitscan-`，
 * credit/motion/settings 用 `xm-*-probe-`），前缀不同却语义相同 ⇒ 归组必须落在
 * **实际传给浏览器的那个路径**上，否则会漏掉一半探针 ✗。
 *
 * 本模块**只读进程表，从不新起浏览器** ✓，因此可以安全地在任何探针的 finally 里调用。
 * 独立跑（人工排查残留）：
 *   node tools/browser-instances.mjs           # 列出全部无头实例与判定
 *   node tools/browser-instances.mjs <前缀>     # 只看某种 profile（如 xiaomo-cdp-）
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const pexec = promisify(execFile);

/**
 * 取当前所有 Edge 进程的 (pid, ppid, 命令行)。
 * ⚠ 用 CIM/WMI 而不是 `tasklist`：只有命令行里才有 `--user-data-dir` 与 `--type`，
 *   而这两个正是本模块判定的**全部**依据。
 * ⚠ PowerShell 在只读沙箱下是 ConstrainedLanguage：这里只用 cmdlet 与原生类型，
 *   不用 [System.IO.*] 之类的静态调用，避免探针在受限环境里直接崩掉。
 */
async function edgeProcesses() {
  const ps = [
    "$ErrorActionPreference='Stop'",
    "$o=@(Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\" -ErrorAction SilentlyContinue)",
    // 输出成一行一个 TSV，避免 ConvertTo-Json 在不同版本上把单元素数组降级成对象
    "$o|ForEach-Object{ \"$($_.ProcessId)`t$($_.ParentProcessId)`t$($_.CommandLine)\" }",
  ].join(';');
  let out = '';
  try {
    // ⚠ 必须走 -NoProfile 且给足超时：进程表查询在忙机器上会慢，但**不能**因此返回空表
    //   —— 空表会被上层读成「已清理」，那是假绿。所以超时/失败一律抛，由上层降级为「无法判定」。
    const r = await pexec('pwsh', ['-NoProfile', '-NonInteractive', '-Command', ps],
      { maxBuffer: 32 * 1024 * 1024, timeout: 60000, windowsHide: true });
    out = r.stdout || '';
  } catch (e) {
    // 换成 powershell.exe 再试一次（老机器可能没有 pwsh）
    const r2 = await pexec('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps],
      { maxBuffer: 32 * 1024 * 1024, timeout: 60000, windowsHide: true });
    out = r2.stdout || '';
  }
  const procs = [];
  for (const line of out.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const pid = Number(parts[0]);
    const ppid = Number(parts[1]);
    const cmd = parts.slice(2).join('\t');
    if (!Number.isFinite(pid)) continue;
    procs.push({ pid, ppid, cmd });
  }
  return procs;
}

/** 从命令行里取出 --user-data-dir 的值（Chromium 允许写成 --user-data-dir=PATH） */
function profileOf(cmd) {
  const m = /--user-data-dir=(?:"([^"]+)"|([^\s"]+))/.exec(cmd || '');
  if (!m) return null;
  return (m[1] || m[2] || '').replace(/[\\/]+$/, '');
}

/**
 * 这个 profile 是不是**探针建的**（而不是用户自己的 Edge / DSH 内嵌浏览器）。
 *
 * ⚠ 为什么必须过滤：不加过滤时实测会混进来两条**不是探针**的：
 *   · `C:\Users\Admin\.dsh\embedded-browser\profile` —— DSH 会话自己的内嵌浏览器（10 个进程）
 *   · `C:\Users\Admin\AppData\Local\Microsoft\Edge\User` —— 用户自己的 Edge profile
 *   （后者命令行里居然也有 `--user-data-dir`，但它是用户数据目录、不是临时 profile）
 * 把它们算成"残留实例"就是误报 ✗，而**误报会让这条诊断失去可信度**（和漏报一样坏）。
 * 判据 = **profile 落在系统临时目录下** ✓ —— 六条探针全都用 `mkdtempSync(join(tmpdir(),…))`，
 * 这是它们唯一的共同点，也是"本次跑用完即弃"的语义所在。
 */
function isProbeProfile(profile) {
  if (!profile) return false;
  const t = normPath(tmpdir());
  return normPath(profile).startsWith(t + '\\');
}

/**
 * 列出无头浏览器**实例**（按 profile 全路径归组）。
 * 返回 [{ profile, rootPid, ppid, procCount, heap, isProbe }]，heap = 该实例的全部进程 pid。
 * 这里的「实例」定义 = 一组共享同一 --user-data-dir 的进程 ✓。
 *
 * @param {string} [filter] 只保留 profile 里含该串的组
 * @param {boolean} [includeNonProbe] 默认 false：**只列探针自己起的**（tmpdir 下的 profile）✓。
 *   设 true 则连用户自己的 Edge / DSH 内嵌浏览器也列出来，但会带 `isProbe:false` 标记
 *   （只读排查用，**绝不参与 kill** ✗）。
 */
export async function listInstances(filter, includeNonProbe = false) {
  const procs = await edgeProcesses();
  const groups = new Map();
  for (const p of procs) {
    const prof = profileOf(p.cmd);
    if (!prof) continue;                       // 没有 --user-data-dir 的 Edge 不属于任何探针实例
    const probe = isProbeProfile(prof);
    if (!probe && !includeNonProbe) continue;   // 默认把用户自己的浏览器挡在外面 ✗
    const key = prof.toLowerCase();
    if (filter && !key.includes(String(filter).toLowerCase())) continue;
    if (!groups.has(key)) groups.set(key, { profile: prof, members: [], isProbe: probe });
    groups.get(key).members.push(p);
  }
  const out = [];
  for (const g of groups.values()) {
    // 根 = 没有 --type= 的那个。实测每个实例恰好一个；若同组出现多个（异常），
    // 取 PID 最小的那个并把异常如实标出来，不静默吞掉。
    const roots = g.members.filter((p) => !/--type=/.test(p.cmd));
    roots.sort((a, b) => a.pid - b.pid);
    const root = roots[0] || null;
    out.push({
      profile: g.profile,
      isProbe: g.isProbe,
      rootPid: root ? root.pid : null,
      ppid: root ? root.ppid : null,
      rootCount: roots.length,
      procCount: g.members.length,
      heap: g.members.map((p) => p.pid).sort((a, b) => a - b),
    });
  }
  return out;
}

/** 该 pid 是否还活着（用于「根已经不在了 ⇒ 该实例已消散」） */
async function alivePids() {
  const procs = await edgeProcesses();
  return new Set(procs.map((p) => p.pid));
}

/**
 * 该 profile 目录是否还在磁盘上。
 *
 * 为什么必须单独看它（Lead 裁定 ③）：**进程清空 ≠ 目录清空** ✗。
 * 本探针怀疑的那条路径正是「子进程树占住目录 ⇒ rmSync 失败 ⇒ 被 catch 悄悄吞掉」，
 * 所以「已清理」这句话**不能盖住**「目录还在」✗。
 * 返回 { exists, path }；path 一定原样回传，便于人工直接去删 ✓。
 */
function profileDirState(profile) {
  try {
    return { exists: existsSync(profile), path: profile };
  } catch {
    return { exists: false, path: profile, unknown: true };
  }
}

/**
 * 归一化路径用于**严格比对**：Windows 路径大小写不敏感、分隔符可混用、可能有尾斜杠。
 * 只做大小写与前缀归一，不做任何"模糊匹配" —— 因为这里的结果会决定杀谁 ✗。
 */
function normPath(p) {
  return String(p || '').replace(/[\\/]+$/, '').replace(/\//g, '\\').toLowerCase();
}

/**
 * 判定清理结果。这是本模块的对外主入口。
 *
 * @param {string|string[]} prefixesOrPaths 关注哪些 profile。
 *   可以给**目录名前缀**（`xiaomo-cdp-`，按包含匹配），也可以给**精确路径**
 *   （`C:\...\xiaomo-cdp-ab12`，按归一化后全等匹配）。两者都支持是刻意的：
 *   探针自己知道精确路径 ⇒ 用精确路径（不误伤）；人工排查只知道前缀 ⇒ 用前缀。
 * @returns {{cleaned:boolean, leftover:number, leftoverProcs:number, total:number,
 *            dirLeftover:number, text:string, instances:Array, unknown?:string}}
 *   text —— **直接可以贴进错误文案的一行中文**，形如：
 *     「是否已清理：已清理（0 个实例残留，profile 目录已删）」
 *     「是否已清理：残留 2 个实例（13 个进程）…；⚠ profile 目录仍存在：C:\...\xiaomo-cdp-xx」
 *   ⚠ **cleaned 同时要求「进程清空」和「目录清空」** ✓ —— 两者都算清理，
 *     任一残留都不算已清理（否则 rmSync 失败会被这句话盖住 ✗）。
 *   unknown —— 进程表读不到时给出原因；**此时 cleaned=false 而不是 true** ✗
 *     （读不到 ≠ 已清理，把"不知道"当"已清理"就是假绿）
 */
export async function checkCleanup(prefixesOrPaths) {
  const want = (Array.isArray(prefixesOrPaths) ? prefixesOrPaths : [prefixesOrPaths])
    .filter(Boolean).map(String);
  const wantNorm = want.map(normPath);
  /** 前缀命中（人工排查用，会给全局存量）：路径里包含该串 */
  const matchesPrefix = (profile) => {
    if (!want.length) return true;
    const np = normPath(profile);
    return wantNorm.some((w) => np.includes(w));
  };

  let all;
  try {
    all = await listInstances();
  } catch (e) {
    return {
      cleaned: false, leftover: -1, leftoverProcs: -1, total: -1, dirLeftover: -1, instances: [],
      unknown: String((e && e.message) || e).slice(0, 200),
      text: '是否已清理：**无法判定**（读不到进程表：'
        + String((e && e.message) || e).slice(0, 120) + '）',
    };
  }
  const mine = all.filter((i) => matchesPrefix(i.profile));
  const leftover = mine.length;
  // 实例 ≠ 进程：残留进程数单独数，两个数都给，谁也别想拿进程数当实例数 ✗
  const leftoverProcs = mine.reduce((n, i) => n + i.procCount, 0);

  // ── 目录侧：**只看传进来的确切路径**（不看前缀）✓
  //
  // ⚠ 这里踩过一个坑：一开始对"前缀命中的实例"逐个查目录，可进程已经死掉的旧 profile
  //   不在进程表里 ⇒ 查不到 ⇒ 那些目录残留永远报告不出来。整盘按前缀扫又会**把历史存量
  //   算进每一次跑**（实测磁盘上已有 **164 个** `xiaomo-cdp-*` 残留目录，多半来自早期
  //   失败跑）⇒ 任何探针都会恒报"残留"，诊断立刻变成噪声 ✗✗。
  //   所以：**核对确路径**（探针自己给的、本次跑的那个）✓；前缀只用于进程侧与
  //   全局存量提示（见 standaloneCounts），两者分开表达 ✓。
  const exact = wantNorm;
  const dirs = exact.map((w, idx) => {
    // 用传进来的**原始**路径查磁盘（归一化只用于比对，实际文件操作走原路径）
    return { norm: w, ...profileDirState(want[idx]) };
  });
  const dirAlive = dirs.filter((d) => d.exists);

  const procPart = leftover === 0
    ? '0 个实例残留'
    : `**残留 ${leftover} 个实例**（共 ${leftoverProcs} 个进程`
      + (leftoverProcs !== leftover ? ' ⇒ 实例数 ≠ 进程数' : '') + '）';

  let text;
  if (leftover === 0 && dirAlive.length === 0) {
    text = '是否已清理：已清理（0 个实例残留，无 profile 进程；本次 profile 目录已删）';
  } else {
    const bits = [`是否已清理：${leftover === 0 ? '进程已清空' : procPart}`];
    if (leftover > 0) {
      const detail = mine.map((i) => {
        const pids = i.heap.slice(0, 4).join('/') + (i.heap.length > 4 ? '…' : '');
        const pfx = i.profile.split(/[\\/]/).pop();
        return `${pfx}（根 PID ${i.rootPid ?? '?'}，${i.procCount} 个进程：${pids}）`;
      }).join('；');
      bits.push(detail);
    }
    if (dirAlive.length) {
      // ⚠ 明确打印路径：人工可以直接去删，不用再猜
      bits.push(`⚠ 本次 profile 目录仍存在：${dirAlive.map((d) => d.path).join('、')}`);
    }
    text = bits.join('；');
  }
  return {
    cleaned: leftover === 0 && dirAlive.length === 0,
    leftover, leftoverProcs, total: all.length,
    dirLeftover: dirAlive.length, dirs, instances: mine, text,
  };
}

/** 全局存量：tmpdir 下所有探针 profile 目录（人工排查用，**不计入单次跑的判定**）✓
 *
 * ⚠ 前缀要**收窄到探针真实用的那几个**，并且必须是**目录**：
 *   第一版用 `/^(xiaomo-cdp-|dotscan-|hitscan-|xm-)/` 匹配名字，结果把
 *   `xm-back-main.js`、`xm-bezier.mjs` 这类**临时脚本文件**也数进去了 ✗
 *   （`xm-` 这个前缀太宽）。六条探针的 profile 前缀是封闭集合：
 *     xiaomo-cdp-   touch-check
 *     dotscan-      dotscan
 *     hitscan-      hitscan
 *     xm-credit-probe- / xm-motion-probe- / xm-settings-probe-
 */
const PROBE_DIR_RE = /^(xiaomo-cdp-|dotscan-|hitscan-|xm-(credit|motion|settings)-probe-)/;
export function probeDirBacklog() {
  const t = tmpdir();
  const out = [];
  try {
    for (const d of readdirSync(t, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;                  // 只认目录，别把临时脚本算进来 ✗
      if (PROBE_DIR_RE.test(d.name)) out.push(join(t, d.name));
    }
  } catch { /* 读不到临时目录就跳过 */ }
  return out;
}

/**
 * 兜底清理：把**指定** profile 的实例整棵树 taskkill 掉。
 *
 * ⚠ 硬要求（Lead 裁定 ②）：**只杀自己那一组** ✓。
 *   · 定位方式 = **`--user-data-dir` 归一化后的全等匹配** ⇒ 只有精确属于本次跑的那个
 *     profile 的根进程会被杀 ✓；
 *   · **绝不按镜像名杀**（`taskkill /IM msedge.exe` 会把用户自己开着的 Edge 一起杀掉 ✗✗）、
 *     **也绝不按调试端口杀**（端口是可复用的，并发跑手会撞上 ✗）；
 *   · **不给前缀就什么都不杀** ✓ —— 无参调用退回"杀全部探针实例"是危险的默认值，
 *     这里刻意改成拒绝执行（宁可不清理，也不误杀）。
 *
 * 返回 { killed, refused?, remained, remainedProcs, text }。
 */
export async function killInstances(prefixesOrPaths) {
  const want = (Array.isArray(prefixesOrPaths) ? prefixesOrPaths : [prefixesOrPaths])
    .filter(Boolean).map(String);
  if (!want.length) {
    return {
      killed: 0, refused: '必须给出确切的 profile 路径（拒绝执行，以免误杀并发跑手或用户自己的浏览器）',
      remained: -1, text: '未执行清理：调用方没给 profile 路径',
    };
  }
  const wantNorm = want.map(normPath);
  const all = await listInstances();
  // 只取**精确相等**的：包含匹配在这里太危险（`dotscan-x` 会命中 `dotscan-xy`）
  const mine = all.filter((i) => wantNorm.includes(normPath(i.profile)));
  let killed = 0;
  for (const i of mine) {
    if (i.rootPid == null) continue;
    try {
      // /T 连子树；PID 精确定位到本组根进程
      await pexec('taskkill', ['/PID', String(i.rootPid), '/T', '/F'],
        { windowsHide: true, timeout: 30000 });
      killed++;
    } catch { /* 已经退出或权限不足 */ }
  }
  const after = await checkCleanup(want);
  return {
    killed, remained: after.leftover, remainedProcs: after.leftoverProcs,
    dirRemained: after.dirLeftover, text: after.text,
  };
}

// ── 独立运行：列出实例与判定 ────────────────────────────────
//
// 两种用法，语义不同，别混 ✗：
//   node tools/browser-instances.mjs                    → 全局排查：当前有哪些探针实例 + 磁盘存量
//   node tools/browser-instances.mjs <profile 全路径>    → 单次核对：那一个 profile 是否清理干净
const isMain = process.argv[1] && /browser-instances\.mjs$/i.test(process.argv[1]);
if (isMain) {
  const arg = process.argv[2] || undefined;
  // 传的是**路径**（含分隔符）就按单次核对走；否则当成关键字筛进程表
  const isPath = !!arg && /[\\/]/.test(arg);
  try {
    if (isPath) {
      const r = await checkCleanup(arg);
      console.log(`核对 profile：${arg}`);
      console.log(r.text);
      if (r.leftover > 0) {
        console.log(`  读数：残留实例 ${r.leftover} 个 ／ 残留进程 ${r.leftoverProcs} 个 ／ 残留目录 ${r.dirLeftover} 个`);
      }
    } else {
      const all = await listInstances(arg);
      const totalProcs = all.reduce((n, i) => n + i.procCount, 0);
      console.log(`探针实例数：${all.length}${arg ? `（筛 ${arg}）` : ''}　｜　进程总数：${totalProcs}`
        + (all.length ? `　⇒ 实例数 ≠ 进程数（平均 ${(totalProcs / all.length).toFixed(1)} 进程/实例）` : ''));
      for (const i of all) {
        console.log(`  · ${i.profile}`);
        console.log(`      根 PID ${i.rootPid}（父 ${i.ppid}）｜进程 ${i.procCount} 个｜根个数 ${i.rootCount}`
          + (i.rootCount !== 1 ? ' ⚠ 异常：根不止一个' : ''));
      }
      // 磁盘存量：**单列**，不计入单次跑的判定 ✓
      const backlog = probeDirBacklog();
      if (backlog.length) {
        console.log(`\n⚠ 磁盘上累计 ${backlog.length} 个探针 profile 目录（多为早期失败跑的存量；`
          + `单次跑的判定只看本次那个 profile，不受此影响）：`);
        for (const d of backlog.slice(0, 8)) console.log('  · ' + d);
        if (backlog.length > 8) console.log(`  … 其余 ${backlog.length - 8} 个`);
      } else {
        console.log('\n磁盘上没有残留的探针 profile 目录 ✓');
      }
      // 顺带看一眼非探针浏览器（只读，绝不参与清理）
      const other = (await listInstances(undefined, true)).filter((i) => !i.isProbe);
      if (other.length) {
        console.log(`\n非探针浏览器 ${other.length} 个（用户自己的/DSH 内嵌，**不在清理范围内**）：`);
        for (const i of other) console.log(`  · ${i.profile}（${i.procCount} 个进程）`);
      }
    }
  } catch (e) {
    console.error('判定失败：' + ((e && e.stack) || e));
    process.exitCode = 2;
  }
}
