#!/usr/bin/env node
/**
 * tools/zero-regression.mjs —— 零回归清单的**可执行版**
 *
 * 为什么需要它：task-64 交付报告的 §4.1 与 §6.6 两次写下这条建议 ——
 *   「把 touch-check.mjs --static 纳入零回归清单，否则同类『扫描清单残留』会继续从缝里漏过去」
 * 而在此之前，那份清单**只存在于报告的一个 bash 代码块里**（文档第 253~264 行）。
 * 文档里的期望值不会自己失败：S3 那条真回归（--static 11/12）就是躲在
 * 「清单只写在注释里」的缝里活下来的 —— 因为没人会每次手工敲 8 条命令。
 *
 * ⚠ 本脚本**不是**「跑一遍看 exit 0」的恒绿表。它逐项断言**具体的项数 / 关键数字**：
 *   100 项、32/32、65 项、12/12、44×44 …… 任何一项**少一条**都会红。
 *   只看 exit code 是抓不住这类退化的（一个探针把 100 项砍成 60 项，甩手照样 exit 0）。
 *
 * 用法：
 *   node tools/zero-regression.mjs              # 默认：只跑 Node 层（快、稳，可当提交前门禁）
 *   node tools/zero-regression.mjs --browser    # 追加浏览器层各项（约 5 min；⚠ 见下）
 *   node tools/zero-regression.mjs --mutate     # 能红证明：只跑首项且把期望值改错，必须报红并 exit 1
 *
 * ⚠ 浏览器层各项**单独跑**都是绿的，但**连跑会互相干扰**（实测 dotscan exit 3、
 *   display-runner 主套件 185 s→267 s 超时）。所以它们要显式 `--browser` 才跑，
 *   且同层之间留 3 s。这不是放宽标准：它们的期望值一样是写死的具体数字，
 *   只是不能在同一台机器上背靠背跑。**要判定它们，一个一个来。**
 *
 * 分组：`layer: 'node'` 只需 Node；`layer: 'browser'` 需要 `node server.mjs` 在 7373。
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// ⚠ 不要用 new URL('..', import.meta.url).pathname —— 它不解码 %20，
//   而本仓库路径里有中文与空格（…/DSH Desktop/…），会直接算出一个不存在的目录，
//   子进程随即 ENOENT、且 stdout/stderr 都是空的，表现为「6 项全 0 B、1 ms 退出」。
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

const argv = process.argv.slice(2);
const NO_BROWSER = argv.includes('--no-browser');
const MUTATE = argv.includes('--mutate');
/**
 * ⚠ 2026-10-17 实测结论：**浏览器层各项在连跑时会互相干扰**。
 *
 * 同一批 4 个浏览器层项，单独跑全部是绿的，连在一起跑却会：
 *   · `dotscan` → `exit 3`（单独跑 exit 0，三个圆点各 44×44）
 *   · `display-runner --main-only` → 主套件从 185 s 涨到 **267 s** 并超时（单独跑 59/59）
 * 它们各自要拉起一个 Edge、抢同一台 `127.0.0.1:7373`，还要争 CPU/内存。
 * 这与本会话更早的发现是同一类：`motion-probe` 连跑三次得到过 41/0 → 40/1 → 38/3 ——
 * **变的不是被测代码，是采样环境**。
 *
 * ⇒ 因此**默认只跑 Node 层**（快、稳、可当门禁），浏览器层要用 `--browser` 显式开。
 *   这不是把红改绿 —— 浏览器层项**单独跑**的期望值仍是写死的具体数字，
 *   它们只是不能在同一台机器上背靠背跑。要看它们，就一个一个来。
 */
const WITH_BROWSER = argv.includes('--browser');

/**
 * 每项：跑哪个探针，期望在输出里出现什么（字符串或正则），以及人类可读的期望描述。
 * `forbid` 是反向断言（例如「不应再有 tbCheck 键」）。
 * ⚠ 同时看 stdout 与 stderr：guard-plugins 的结论就打在 stderr 上。
 */
const SUITE = [
  {
    id: 'check',
    cmd: ['tools/check.mjs'],
    expect: '全部通过：100 项',
    label: '内核自检 100 项',
    layer: 'node',
    note: 'task-64 附录第 256 行',
  },
  {
    id: 'guard-plugins',
    cmd: ['tools/guard-plugins.mjs'],
    expect: '装载结果：32/32 装载成功，失败 0 个',
    label: '插件装载守卫 32/32',
    layer: 'node',
    // ⚠ 这条结论打在 **stderr** 上（跑起来会看到 `node : [guard] 装载结果：…`）。
    //   所以必须同时捕获 stderr —— 只看 stdout 会误判成「没找到」。
    note: 'task-64 附录第 257 行（结论在 stderr）',
  },
  {
    id: 'kernel-lifecycle',
    cmd: ['tools/kernel-lifecycle.mjs'],
    expect: '内核生命周期探针全部通过：65 项',
    label: '内核生命周期 65 项',
    layer: 'node',
    note: 'task-64 附录第 258 行',
  },
  {
    id: 'touch-check-static',
    cmd: ['tools/touch-check.mjs', '--static'],
    expect: '"summary":"12/12"',
    label: '触控静态断言 12/12',
    layer: 'node',
    // ★ 这一条就是 task-64 §4.1 说的那个真回归所在的位置：
    //   S3 曾因清单里留着组合选择器 `.tool-btn, .tb-check`（而规则已被精确拆成纯 `.tool-btn`）
    //   而**永久报红**（11/12）。它藏在 --static 模式里，而当时写进零回归清单的只有 --suite。
    note: 'task-64 §4.1 —— S3 真回归的哨兵位；写进清单正是本脚本存在的理由',
  },
  {
    id: 'hitscan',
    cmd: ['tools/hitscan.mjs'],
    expect: null,
    forbid: /tbCheck/,
    label: '命中扫描不再含 tbCheck 键',
    layer: 'browser',
    note: 'task-64 附录第 262 行「输出里不应再有 tbCheck 键」',
  },
  {
    id: 'dotscan',
    cmd: ['tools/dotscan.mjs'],
    expect: /"w":\s*44[\s\S]*"h":\s*44[\s\S]*"w":\s*44[\s\S]*"h":\s*44[\s\S]*"w":\s*44[\s\S]*"h":\s*44/,
    label: '三个圆点各 44×44',
    layer: 'browser',
    note: 'task-64 附录第 263 行',
  },
  {
    id: 'photoresistor-probe',
    cmd: ['tools/photoresistor-probe.mjs'],
    expect: '"items":38,"fail":0',
    label: '光敏电阻专用探针（照度→电阻，连续非线性）',
    layer: 'node',
    note: 'C4 光电元件 · 照度的单值连续函数',
  },
  {
    id: 'photodiode-probe',
    cmd: ['tools/photodiode-probe.mjs'],
    expect: '共 27 项，失败 0 项',
    label: '光敏二极管专用探针 27 项（开关型 + 与电阻并排对照）',
    layer: 'node',
    // ⚠ 这一项存在的理由：光电元件的验收重点是「它和光敏电阻**不是同一件东西**」。
    //   混在大套件里容易被"两边都绿"糊过去，所以 §④ 在同一照度下**并排量**两支器件：
    //   电阻给出中间值（连续单调），二极管给出 V/R 两种形态（开关）。见 T-01 §三十九。
    note: 'C4 另一半 · T-01 §三十九',
  },
  {
    id: 'polarity-probe',
    cmd: ['tools/polarity-probe.mjs'],
    expect: '"probe":"polarity","items":25,"pass":25,"fail":0',
    label: '极性一致性探针 25 项（干电池印的 +/− ↔ 求解器极性）',
    layer: 'node',
    // ⚠ 这一项守的是**画出来的记号**，不是内部数值：干电池 ports[0] 印 '+'、ports[1] 印 '−'，
    //   必须与 solveCircuit() 上报的 U(ports[0]) − U(ports[1]) = emf − ri·I 同号。
    //   改前两者恒反（用户按印的 '+' 推电流方向正好相反），且 gfx 是硬编码字面量 ——
    //   只改 ports[].label 不改图形，或反过来，本项都会红。
    note: 'task-5 · 显示层极性必须与求解器口径同向（含 gfx 落点：+ 在左半、− 在右半、凸点与 + 同侧）',
  },
  {
    id: 'display-runner',
    cmd: ['tools/display-runner.mjs', '--main-only'],
    expect: '"done":{"ok":true,"fail":0,"total":59}',
    label: '大屏可读模式主套件 59/59',
    layer: 'browser',
    // ⚠ 加这一项，是为了不让 display-runner 重蹈它自己刚被救出来的那个覆辙：
    //   「跑得起来、但没有人在跑」等于没有覆盖。它的前身只活在 %TEMP% 里，
    //   临时目录一清就消失了 —— 40 条断言随之失效（见 tools/display-runner.mjs 文件头）。
    //   耗时约 185 s（两个视口 × 全套断言），是清单里最慢的一项。
    note: 'T-01 §三十六（display-probe.html 曾因跑手只存在于 %TEMP% 而静默失去覆盖）',
  },
  {
    id: 'touch-check-suite',
    cmd: ['tools/touch-check.mjs', '--suite'],
    expect: '"summary":"43/43"',
    label: '触控交互套件 43/43',
    layer: 'browser',
    // ⚠ 2026-10-17 才加进来：它的 CR2 原先含一个「短按必须真的短于阈值」的前提，
    //   而 realHold 的实测值是「名义 + 约 460ms 固定开销」，慢机器上会拖过 550ms 阈值
    //   ⇒ 间歇报红（实测 586 / 581 / 408ms），而被测行为其实是正确的（两次 evt 都是 0）。
    //   重构后：长按+移动那半边永远可判，短按那半边只在前提成立时判，且如实标注。
    //   修完才敢写死 43/43 —— 在那之前它的期望值只能是「41~43，会抖」。
    note: 'T-01 §三十七（CR2 前提/断言拆分）',
  },
  {
    id: 'undo-probe',
    cmd: ['tools/undo-probe.mjs'],
    expect: '全部通过：68 项',
    label: '撤销栈 68 项（含 move 类：拖动入栈）',
    layer: 'node',
    // ⚠ 2026-10-17 纳入。它此前 61 条里**没有一条覆盖 move** —— 而拖动器材原本
    //   根本不入栈（位置由 interact.js 直接写 ent.x/y、绕过 setProp，
    //   且 main.js 的 onEntityMoved 是空函数）⇒「栈在跑、用户够不着」。
    //   补了 7 条 move 断言（登记/两条接线/空函数形态已消失/三条机制往返）后纳入清单。
    note: 'T-01 §四十五（④-6 拖动入撤销栈）',
  },
  {
    id: 'pan-probe',
    cmd: ['tools/pan-probe.mjs'],
    expect: '全部通过：107 项',
    label: '视图/交互层 107 项（Node 内直接 new Interaction）',
    layer: 'node',
    // ⚠ 2026-10-18 由实测更正：期望值原写 `100 项`，而 pan-probe 确定打印 **107 项**
    //   （三次复现一致；107 条 ✓ 消息**互不重复**；0 红；exit 0）⇒ 旧数与探针读数不符，
    //   本项恒红。迁移包自述的「零回归 9/9」因此**不可复现**（实测 8/9）。
    //   更正后仍是硬编码具体数字 —— 探针若**少**一条断言，本项照样会红（这是它存在的理由）。
    // ★ 这一项是**交互层唯一可用的 Node 护栏** —— 它在 Node 里直接 `new Interaction(app)`，
    //   断言拖放/平移/命中/端口 等手势层行为（`tools/` 下 DRAG_SLOP、finishDrag、wireFrom、
    //   onEntityClicked… 全都没有别的覆盖）。
    //   ⚠ 它曾因对照副本放在 `%TEMP%` 被清理而**整条崩溃**（`ePre.render()` 读 null），
    //     使交互层在一段时间里完全没有回归网。2026-10-17 已改为**缺失时跳过对比段并如实标注**。
    //   ⇒ 纪律：基线/副本落**项目内**；依赖外部文件时缺失处要**降级**，不要崩。
    note: 'T-01 §四十一（交互层唯一 Node 护栏；原依赖 %TEMP% 副本，已改为降级）',
  },
  {
    id: 'gesture-probe',
    cmd: ['tools/gesture-probe.mjs'],
    expect: '"probe":"gesture","mutate":false,"items":68,"pass":68,"fail":0',
    label: '视口手势层 68 项（两指平移/捏合 + 桌面滚轮 + 单指逐位对照）',
    layer: 'node',
    // ★ task-12 新增。最值钱的不是条数而是**逐位对照**：§⑥ 用改动前的字节副本跑同一串
    //   单指事件（含本轮新增的 S2b「触屏在空白处拖 120px」），比较状态摘要与绘制指令流
    //   ⇒ 「单指在触屏上也起手平移」这个**会毁掉拖动器材**的改动必然红（该变异体实测红在
    //   §⑥§⑦ 两处）。全部 5 个变异体 landInCode 实测、声明红节 ≡ 实测红节、ctrlBad 0。
    //   ⚠ 它的上一版探针曾**自己毒死自己**：用 `eng.zoom` 算屏幕点，而改动前的 engine 上
    //   `zoom` 是 undefined ⇒ 坐标全 NaN ⇒ 报出来的差异指向引擎、其实是探针缺陷
    //   （JSON 里 undefined/NaN 都序列化成 null，长得像 pan 丢了）。
    note: 'task-12（触控视口：两指平移/捏合缩放 + 桌面滚轮缩放）',
  },
  {
    id: 'palette-dnd-probe',
    cmd: ['tools/palette-dnd-probe.mjs'],
    expect: '"items":32,"pass":32,"fail":0',
    label: '器材栏拖出 32 项（长按成立 → 放手即落位 = 放手点）',
    layer: 'node',
    // ★ task-13 新增。⚠ 它第一版有一条**假红**：methodBody() 用 indexOf(name+'(') 锚到的
    //   是**调用点**而不是定义点（本仓元教训 AV），切出来的「函数体」自然不含
    //   screenToWorld( ⇒ 断言红、实现却是对的。修法不是改断言，而是把「取到的是不是定义」
    //   变成返回值里的可断言字段（looksLikeDef），让锚**自己会红**。
    //   同族的另外两面是**假绿**、且只能在 --mutate 下现形：静态判据读的是 srcRaw 而不是
    //   被测那一份（⇒ 变异体下永远不可能红）、以及 /setPointerCapture/ 命中的是注释
    //   （⇒ 把实现整行删掉断言照样绿）。三面同因：**锚错了**。
    //   红档 11 个变异体，expectedRed 14 ≡ observedRed 14、ctrlBad 0、baselineRed []。
    note: 'task-13（器材栏长按拖出到任意落点 + 抽屉重叠取消）',
  },
  {
    id: 'publish-gate',
    cmd: ['tools/publish-gate.mjs'],
    expect: '发布闸门通过：15 项，可以发布',
    label: '发布闸门 15 项（未跟踪 0 / 合规复扫 / 包白名单 / 双版本一致 / 写者停手）',
    layer: 'node',
    // ★ 2026-10-17 新增。`plans/02 §四` 把「凭据与合规闸门」写成"已固化为流程"，
    //   但那套流程**实际是手敲的几条命令** —— 手敲的不算固化。
    //   本项把它变成可执行断言，且**全部离线可得**（`publish-verify` 检查得更全，但依赖远端 API，
    //   发布**之前**跑不了）。含：未跟踪文件=0、凭据合规复扫、`npm pack` 白名单实证、
    //   网页版↔桌面版版本号一致。
    note: 'T-01 §五十（发布前离线闸门）',
  },
  {
    id: 'glass-motion-probe',
    cmd: ['tools/glass-motion-probe.mjs'],
    expect: '"passed":10,"failed":0',
    label: '毛玻璃降级 + 弹跳/拖尾 10/10',
    layer: 'browser',
    // ⚠ 期望值 10/10，**不是 9/10**。
    //   task-64 曾把 F2 判为「既有口径分歧」并把期望值下调到 9/10 —— 那是用下调期望值
    //   丢掉覆盖。2026-10-17 查明：产品 CSS 的 `background: var(--bg) var(--glass)` 是
    //   **语法非法**（两个纯颜色，非最后一层必须是 bg-image），且探针注入后立刻读
    //   getComputedStyle 拿到的是 transition 的**起点**。两处都已修。详见 T-01 交付报告
    //   §三十三 / §三十四，以及 task-64 报告 §5.2 的更正块。
    note: 'T-01 §三十三/§三十四（原 task-64 期望 9/10，已更正）',
  },
];

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function run(item) {
  const t0 = Date.now();
  // ⚠ 用 spawnSync 而不是 execFileSync：后者成功时只返回 stdout，
  //   而 guard-plugins 的结论在 stderr 上 —— 会误判。
  const r = spawnSync(process.execPath, item.cmd, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const ms = Date.now() - t0;
  let out = String(r.stdout || '') + String(r.stderr || '');
  if (!out.trim()) out = `[launcher] ${r.error ? r.error.message : 'no output'}`;
  const exit = typeof r.status === 'number' ? r.status : 1;

  const problems = [];
  if (item.forbid && item.forbid.test(out)) problems.push(`出现了本不该有的内容 ${item.forbid}`);
  if (item.expect) {
    const ok = typeof item.expect === 'string' ? out.includes(item.expect) : item.expect.test(out);
    if (!ok) problems.push(`应出现 ${item.expect} —— 没找到`);
  }
  if (exit !== 0) problems.push(`探针 exit=${exit}`);

  return { problems, ms, exit, bytes: out.length };
}

async function main() {
  let items = [...SUITE];
  // 默认 Node 层。浏览器层要显式 --browser（理由见文件上方那段实测结论）。
  // --no-browser 保留为显式别名，便于把意图写清楚。
  if (!WITH_BROWSER) items = items.filter((i) => i.layer === 'node');
  else if (NO_BROWSER) items = items.filter((i) => i.layer === 'node');

  // --mutate：把首项的期望值故意改错。若这样都不红，本脚本就是一张废纸。
  if (MUTATE) {
    items = [{ ...items[0], expect: '全部通过：999 项' }];
    console.log('--mutate：已把首项期望改为「全部通过：999 项」（真实是 100 项），且只跑这一项。预期报红且 exit 1。\n');
  }

  const nNode = items.filter((i) => i.layer === 'node').length;
  console.log(`零回归清单 · ${items.length} 项（Node 层 ${nNode} / 浏览器层 ${items.length - nNode}）${NO_BROWSER ? ' · --no-browser' : ''}\n`);

  let failed = 0;
  let lastLayer = null;
  for (const item of items) {
    // 浏览器层各项之间留间隔：它们抢同一台 7373 与独占调试端口，连跑会让下一项
    // 读到上一轮的残留、或直接被慢到超时（实测 dotscan exit 3、display-runner 185→267 s）。
    // 3 s 是实测能站稳的量级；再短的 900 ms 不够。
    if (item.layer === 'browser' && lastLayer === 'browser') sleep(3000);
    lastLayer = item.layer;

    const r = run(item);
    const ok = r.problems.length === 0;
    if (!ok) failed++;
    console.log(`${ok ? '✓' : '✗'} [${item.layer}] ${item.label}  (${r.ms} ms, exit ${r.exit}, ${r.bytes} B)`);
    r.problems.forEach((p) => console.log(`    → ${p}`));
  }

  console.log(`\n${items.length - failed}/${items.length} 项通过` + (failed ? `，失败 ${failed} 项` : '，零回归'));
  if (MUTATE) {
    console.log(failed ? '\n✓ 能红证明成立：期望值被改错时本脚本确实报红。' : '\n✗（没红！）--mutate 没能让清单变红 —— 这个开关是假的。');
    process.exit(failed ? 0 : 1);
  }
  process.exit(failed ? 1 : 0);
}

main();
