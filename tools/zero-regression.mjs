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
    expect: '"probe":"gesture","mutate":false,"items":101,"pass":101,"fail":0',
    label: '视口手势层 101 项（两指平移/捏合 + 滚轮 + 单指逐位对照 + 双击复位视图 + pan≠0 位移换算 + 可见世界夹取）',
    layer: 'node',
    // ⚠ 条数是**硬编码**的，这是刻意的：探针若**少**一条断言，本项照样会红。
    //   2026-10-20 由 68 → 74：§⑧ 新增 6 条钉「双击空白 = 复位整个视图」。
    //   为什么值得单开一节：**zoom=1 时 `resetPan()` 与 `resetView()` 观测效果完全相同**
    //   （都只是把 pan 归零）⇒ 只断言视口状态的判据在恒等视口上是**空转**的。§⑧ 改用
    //   「两个复位函数的调用计数器」把「到底调了哪个」变成可观测量，并配一条
    //   `double-tap-resets-pan-only` 变异体（实测红 §⑧ 4 条）证明它真的会红。
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
    id: 'port-affordance-probe',
    cmd: ['tools/port-affordance-probe.mjs'],
    expect: 'PORT_AFFORDANCE_JSON {"items":63,"pass":63,"fail":0',
    label: '接线柱可见化+吸附 63 项（命中 26 / 吸附 30 两侧夹取 + 重叠次序唯一 + 细指针逐位不变 + 两笔不同源绘制）',
    layer: 'node',
    note: 'task-18（e-transistor）：端口视觉档位读 (pointer: coarse)；视觉尺寸只在 engine.js 的 PORT_R_FINE/COARSE 声明一处。',
  },
  {
    id: 'equipbar-probe',
    cmd: ['tools/equipbar-probe.mjs'],
    expect: 'EQUIPBAR_JSON {"total":61,"pass":61,"fail":0',
    label: '就地浮出控制条 61 项（幂等往返 + 反串台 + 捕获时器材 + 锚点四式两尺寸 + 引擎往返 + 单层结构断言 + 变异体自指元判据 + 位真原语缺契约）',
    layer: 'node',
    note: 'task-19（e-state）：可点浮层必须是 DOM（engine.overlays 只画不点）。数值断言杀不死「第二真相源」，只有结构断言能。',
  },
  {
    id: 'palette-dnd-probe',
    cmd: ['tools/palette-dnd-probe.mjs'],
    expect: '"items":54,"pass":54,"fail":0',
    label: '器材栏拖出 54 项（轴向即时成立 + 长按成立 → 放手即落位 = 放手点；含三角度/纵向/鼠标对照）',
    layer: 'node',
    // ★ task-16 新增 10 条（G7/G7b/G8/G9/G10/G13/G14 + O6；G11/G12 补 fire('click') 修掉一条假绿）。
    //   红档 24 个变异体：expectedRed 64 ≡ observedRed 64、ctrlBad 0、landInCode/redsAligned 全 true。
    //   ⚠ owner 自己单列了 7 条「浏览器仲裁层测不到」：手势 slop 实际数值、pointercancel 与第一个
    //   合格 pointermove 的真实先后（「第 5px 成立」只证明判据层下判断，不证明浏览器没动手）、
    //   pan-y 对 30° 判给哪条轴、真机是否补发兼容 click、真机长按上下文菜单、命中测试来自夹具
    //   getBoundingClientRect（证明的是分支与文案，不是真实布局）、A2 是去注释后的静态检查。
    //   ⇒ 前五项归 Lead 层无头浏览器验证。
    // ★ task-13 新增。⚠ 它第一版有一条**假红**：methodBody() 用 indexOf(name+'(') 锚到的
    //   是**调用点**而不是定义点（本仓元教训 AV），切出来的「函数体」自然不含
    //   screenToWorld( ⇒ 断言红、实现却是对的。修法不是改断言，而是把「取到的是不是定义」
    //   变成返回值里的可断言字段（looksLikeDef），让锚**自己会红**。
    //   同族的另外两面是**假绿**、且只能在 --mutate 下现形：静态判据读的是 srcRaw 而不是
    //   被测那一份（⇒ 变异体下永远不可能红）、以及 /setPointerCapture/ 命中的是注释
    //   （⇒ 把实现整行删掉断言照样绿）。三面同因：**锚错了**。
    //   红档 18 个变异体，expectedRed 31 ≡ observedRed 31、ctrlBad 0、baselineRed []。
    note: 'task-13（器材栏轴向即时拖出 / 长按拖出到任意落点 + 抽屉重叠取消）',
  },
  {
    id: 'inspector-caps-probe',
    cmd: ['tools/inspector-caps-probe.mjs'],
    expect: '"items":35,"pass":35,"fail":0',
    label: '能力位表 35 项（applyCap 单一动作定义 + 256 次逐位等价 + 白名单外逐件不变）',
    layer: 'node',
    // ★ task-17 新增。菜单项过去是 UI 按特征猜（e.type==='switch' / e.flame / e.vessel），
    //   现在由**器材自己的能力位**决定，那三个判断退到兜底层 ⇒ 任何没声明能力位的器材
    //   （含**用户器材包派生**的）行为逐位不变。
    //   最值钱的一条是**全量逐件对照**：117 件 × 2 态 = 234 次读数，改后 render() 与冻结
    //   基线相同，且「改前那三个 if 的逐字副本 oldMenu()」也对同一基线 —— 读数与算法互钉。
    //   ⚠ 中央表今天与兜底**逐件等价**（这正是零行为变化的原因）⇒ 「中央表真被读到」在真实
    //   器材上看不出差别，只能靠注入表抓；这条局限写在探针文件头里，别把它当成覆盖了。
    //   ⚠ 件数口径：注册表实测 **117**（器材单装/加主题规则/加预设/加器材包四种集合一致，
    //   与 guard-plugins 的 stats.equipment 互相印证）。**118** 是浏览器 profile 里装了
    //   器材包/market 派生件时的数，不是固有件数 ⇒ 探针一律按注册表实测，不写死数字。
    //   ⚠ 2026-10-20 追记：注册表实测已到 **119**（新增 spdt/led）。本条断言与件数**解耦**
    //   （只钉 items/pass/fail），所以期望值一个字没改 —— 这正是「断言不与它测的常量耦合」的样子。
    //   ⚠ 作者自己抓住了自己第一版的**死代码**：menuCaps 漏掉兜底层 ⇒ 用户器材包派生的
    //   type 不在中央表里会**整类掉按钮**；是探针 §④ 当场红 3 条才暴露的（不是靠评审）。
    note: 'task-17（能力位表：菜单项由器材声明 + 三层兜底，行为逐位不变）',
  },
  {
    id: 'spdt-led-probe',
    cmd: ['tools/spdt-led-probe.mjs'],
    // ⚠ expect 必须**从 `{` 开始**：探针把 `SPDT_LED_JSON` 这个标签包在 ANSI 粗体转义里
    //   （`\x1b[1mSPDT_LED_JSON\x1b[0m {...}`）⇒ 带标签的子串永不匹配。这不是探针的错，
    //   是本文件既有条目的共同约定（对照 inspector-caps-probe 那条）。
    expect: '"mode":"green","items":33,"pass":33,"fail":0',
    label: '单刀双掷开关 + 发光二极管 33 项（真值表真跑求解器 + 与既有 diode 逐位同解 + 损坏器材 + 端子自报）',
    layer: 'node',
    // ★ task-20 新增：两件 NB 有而本仓没有的器材，加进**既有** electronics 插件 ⇒ UI 插件数仍 32。
    //   最值钱的一条：`orTable` 的四个 out **不是写死的期望值**，是真跑 circuit.js 得到的节点电压
    //   （5.999e-10 / 4.1564 / 4.1564 / 4.1677 V ⇒ 布尔 0111）；`diodeEquivalence` 把同一张网表里的
    //   led 换成既有 diode（同 vf/ron/roff）⇒ uLed == uDio **逐位相同**，不是近似。
    //   ⚠ 未选中那一掷必须是**真开路**（假开路会漏掉孤立支路告警）⇒ M1 与 M5 分工：M1 报
    //   port-ignored、M5 真缺失；选中支路必须在**索引 0**（`circuit.js` 里 `const primary = !b.bi`）。
    //   ⚠ 容差口径来自求解器的**节点电压**收敛界 `maxDelta < 1e-5`，不是随手放宽（两处都复核过源码）：
    //   SPDT-BRANCH0 实测差 2.83e-14 ⇒ near(1e-9)；LED-IFWD-CROSSCHECK 小电流档实测相对差 1.0e-6 ⇒ 1e-4。
    //   ⚠ `uncovered` 台账只剩 10 条，且**多一条就判红**（strayUncovered 非空 ⇒ 红档判红）：
    //   控制组/形状组归 guard-plugins 等；损坏器材整件跳过是 `circuit.js` 的跨文件契约、不在写域。
    note: 'task-20（spdt 单刀双掷 + led 发光二极管；器材自 117 增至 119）',
  },
  {
    id: 'toolbar-probe',
    cmd: ['tools/toolbar-probe.mjs'],
    // ⚠ expect 必须**从 `{` 开始**：探针把 `TOOLBAR_JSON` 标签包在 ANSI 粗体转义里（本文件共同约定）。
    expect: '"total":37,"pass":37,"fail":0',
    label: '画布功能栏 26 项（8 处散落入口去向守恒 + 行为等价逐位读数 + 插槽重建后仍在 + 边界不抛）',
    layer: 'node',
    // ★ task-27 新增。两个值钱的读数：
    //   ① 它抓到的真盲区：`app[MOUNTED]` 复用守卫只对**新实例**生效 ⇒ 只重复 mount 同一实例时，
    //      变异体落地却一条不红；补 `rebuild.secondInstanceReusesFirst` 才把它钉住。
    //   ② 插槽重建风险（接缝图点名）实测结论：冷启动 `mountSlots()` 每槽清一次 `innerHTML`；
    //      热路径 `mountSlot` **体内** `innerHTML` 0 次（剥注释后，体长 2104）；**真刀**是
    //      **兄弟条目**渲染回调写 `host.innerHTML=`（`ui.toolbar.js` 搬家后 3→2）⇒ 同槽任一条目
    //      重渲染 = 整槽被抹；换主题**不是**那条路径（`core/theme.js` 0 次、`core/plugin.js` 2 处发
    //      `slot:changed`）。功能栏挂 `#stage`（插槽之外）⇒ 打不到。**接缝图的怀疑被推翻、但真刀找到了。**
    //   ⚠ 行为等价给的是**逐位读数**（`setTool` 恰好 1 次 / `zoomAt` 目标 2.5 锚点 400 额外置脏 0 次 /
    //   复位 true⇒1 次 false⇒0 次），不是目测。
    note: 'task-27（画布功能栏整合：8 处收拢为 1 条栏，`topbar.tools` 槽不再注册条目 ⇒ 槽 9→8，UI 插件数仍 32）',
  },
  {
    id: 'grid-probe',
    cmd: ['tools/grid-probe.mjs'],
    // ⚠ expect 必须**从 `{` 开始**（探针把 `GRID_JSON` 标签包在 ANSI 粗体里 —— 本文件共同约定）。
    expect: '"items":24,"pass":24,"fail":0',
    label: '网格/坐标开关 24 项（开态 2 条网格指令 vs 关态 0 条 + 换算唯一出口 + 默认态逐位相同 + 有限值边界）',
    layer: 'node',
    // ★ task-28 新增。三个值钱的读数：
    //   ① **默认态逐位相同由构造成立**：`render()` 三个调用点**无条件**、判断全在方法**入口**
    //      ⇒ 开关加进来而默认态的绘制指令流一字不变（这是能同时满足「加功能」与「逐位相同」的形状）。
    //   ② 开/关对照**先证空集不恒真**：ON 有 2 条网格 stroke、OFF 恰好 0 条 ⇒ 两态差异**恰好**是网格。
    //   ③ 它自己推翻的两条前提：`pan-probe` 的指令流只记 `setTransform/translate/clearRect/scale`
    //      ⇒ 网格指令从不在那串里、与 §② **无因果**（接缝图⑥ 与我任务书的最大风险都不成立）；
    //      「`render()` 里加 `if` 就会红」同样不成立。
    //   ⚠ 它抓到的**真 bug**（本仓级）：`gridSize = 0` 与 `gridSize = Infinity` 都会让
    //      `for(…; x += s)` **死循环 ⇒ 页面卡死**（不是画得难看）⇒ 守卫 `!Number.isFinite(s) || !(s > 0)`。
    //      以及 `drawGrid` 可见区方向算反（`floor(pan/s)*s` ⇒ pan≠0 时屏两端各露一条 `2·|pan|` 宽
    //      的无网格带）⇒ 改走 `(屏幕−pan)/zoom`，末尾 `|| 0` 消 `-0` 保住 pan=0/zoom=1 逐位相同。
    note: 'task-28（网格 + 坐标读数开关；默认 true，偏好键 `xiaomo.grid.v1` 复用既有 try/catch 写法、未新建存储）',
  },
  {
    id: 'lock-readout-probe',
    cmd: ['tools/lock-readout-probe.mjs'],
    // ⚠ expect 必须**从 `{` 开始**（探针把 `LOCK_READOUT_JSON` 标签包在 ANSI 粗体里）。
    expect: '"items":101,"pass":101,"fail":0',
    label: '逐件锁定 + 读数 101 项（真值位表 119/119 默认有位 + 存档按需多一键 + 拖动入口就地拦下 + 读数与 Inspector 输出逐字对拍）',
    layer: 'node',
    // ★ task-26 新增。三个值钱的读数：
    //   ① **M2 是次序断言**：「把判定挪到 `this.drag = {` 之后」⇒ **终值一样、次序不同**
    //      —— 专杀「事后把器材夹回来」这种看起来对、手感错的实现。
    //   ② 存档选**甲案（扩 toJSON 白名单，按需写）**：未锁定时 `locked` 键**根本不出现**
    //      ⇒ 旧存档六键 `props,rot,state,type,x,y` 逐字不变，锁定后只多 `locked` 一个键。
    //   ③ 读数**不复制换算、也不复制格式**：`readout.js` 里 `toFixed(` 出现 0 次、`fmtBy` 来自
    //      `inspector.js`、且**完全不按 `e.type` 判断** ⇒ 它与侧栏读数是同一口径。
    //   ⚠ 边界：`def.stats` **一块都没新增**（读数只吃既有 38 块 / 9 文件）；
    //      `caps.js` 的 `LOCK_CAP` **不进** `CAP_KEYS`/`DEFAULT_CAPS`（那两处键集合与按钮清单
    //      被 `inspector-caps-probe` §①/§⑤ 冻结）；`inspector.js` 源码**一字未动**（它的 stats 循环
    //      文本是 `inspector-stats-probe` 的变异锚点 ⇒ 动一个字打红两套探针）。
    note: 'task-26（逐件锁定 + 画布逐件读数；`lock` 是新默认位、在冻结键集之外 ⇒ inspector-caps 5 键口径未动）',
  },
  {
    id: 'assembly-probe',
    cmd: ['tools/assembly-probe.mjs'],
    // ⚠ expect 必须**从 `{` 开始**（本文件共同约定：探针把 JSON 标签包在 ANSI 粗体转义里）。
    expect: '"items":60,"pass":60,"fail":0',
    label: '一键组装 60 项（成套预设自带的连线真落台 + 真求解器读数 + 撤销哈希逐位回来 + 幂等/脏台面不残留）',
    layer: 'node',
    // ★ task-29 新增。诚实命名是本项最要紧的一条：落地的是「**成套预设（含连线）**」——
    //   连线来自预设数据**自带的** `wires`，靠 `loadScene()` 整场景替换落地。
    //   **「组装时算法自动布线」无证据**（两个 umi 包 + 两个编辑器按 `自动连线|自动连接|autoConnect|
    //   autoWire|自动接线` **0 命中**）⇒ 代码注释与 UI 文案一律不许这么写。
    //   ⚠ 它专门为此立了一条**能红**的变异体（`M7-naming-claim`）：让代码"声称自动布线" ⇒ 必红 ✓
    //   —— 把「不是功能、但是红线」的文案口径做成了可证伪断言，这是本项最值钱的一条。
    //   ⚠ 四类「假绿」各立专项：空集恒真（要求非零读数 >0）· 存在性恒真（`WIRE-ENDPOINTS-*`
    //   逐根端点对应，不只数条数）· 断言与常量耦合（件数一律取 `build()` 现测）· 数值路径盲区。
    //   ⚠ 撤销选**甲案**（组装前自动存快照，「撤销组装」= 载回它）：不动 `undo.js` 的
    //   `OP_KINDS.load`（那是产品语义）；快照必须走**存档形状**，因为 `_applyScene()` 只认
    //   `fill.liquid/solid`，会**静默丢** mol/gas/precip/temp。
    note: 'task-29（一键组装：成套预设含连线；撤销 = 载回组装前快照，组装与撤销都**不入撤销栈**）',
  },
  {
    id: 'inspector-stats-probe',
    cmd: ['tools/inspector-stats-probe.mjs'],
    expect: '全部通过：171 项',
    label: '属性检视器读数 171 项（瞬时/有效 并列、额定与实时电阻、自报 stats 位置契约、未接线占位口径）',
    layer: 'node',
    // ★ 这一项是**补登**的，起因是一条真实的「闸门外腐烂」：
    //   它在总网之外已经红着 1/168，谁都没看见 —— 根因是那条断言钉了**代理量**
    //   （「未接线时 rmsI 是 MNA 浮点残差 ~1e-12」），而求解器后来的实现给出**精确 0**
    //   ⇒ 断言自己腐了，产品其实一直是对的（面板按 wiredPortsOf(...).size >= 2 判「未接线」，
    //   是**接线真源** ✓）。⇒ 换成两条：甲）未接线 ⇒ 占位（与 rmsI 取值**无关**，rmsI 只如实记录）；
    //   乙）**已接线但电流合法为 0** ⇒ 必须给读数 0 A 而不是占位 —— **只有这条是鉴别性的**，
    //   它证明判据源是接线：谁把 wired 偷换成 rmsI !== 0，乙必红（探针内配了该变异体，实测能红 ✓）。
    //   两条教训：**钉不变量，不钉附带产物**；**闸门外的绿是假绿** —— 不登记的探针会烂。
    note: '属性检视器 + 未接线占位口径（判据源是接线真源，不是数值）',
  },
  {
    id: 'electrode-polarity-probe',
    cmd: ['tools/electrode-polarity-probe.mjs'],
    expect: '"items":68,"pass":68,"fail":0',
    label: '电极极性契约 68 项（电解池按电流、原电池按 E0 两种情形分派 + 同种电极只对调接线即翻转 + null 七类 + 无副作用）',
    layer: 'node',
    // ★ 本项的判据痛点：vessel.currentU/currentSigned 只由 sol: 支路写，而原电池走 cell: 支路
    //   不写也不清零（distribute() 只清 electrodes/electricCurrent）⇒ 原电池下它们是陈旧值 ✗。
    //   实测反例（同一杯、同一对电极实体）：先电解出 currentU=+0.4613 V，再改成 Cu/Zn ⇒ sol: 消失、cell: 接管，
    //   currentU/currentSigned 与上帧逐位相同而 electricCurrent 已清零 ⇒ 同一根电极由 anode 变 cathode ✓。
    //   ⇒ 两条写死规则各踩空一次（A 高电位端=阳极 在原电池错 ✗、B E0 高者=阴极 电解池错 ✗）——
    //   这就是「判据要钉不变量、不许写死单条规则」的可复现反例 ✓。
    //   ⚠ 另记两条成员自查出来的假绿框架缺陷：① 锚点命中但文本未变的补丁曾被评为通过 ⇒ 现在
    //   landInCode 量文本增量、命中未变更判 land-fail；② runSuite() 不返回 items 时
    //   S.items === ctrl.items 两边 undefined、恒真 ⇒ 条数一致断言是假绿 ⇒ 现在显式算好并加
    //   Number.isFinite 前置 ✓。
    note: 'task-32（电极极性契约：两种情形分派；行为型变异体偷读陈旧 currentU 必红）',
  },
  {
    id: 'diode-gate-probe',
    cmd: ['tools/diode-gate-probe.mjs'],
    expect: '"items":30,"pass":30,"fail":0',
    label: '二极管与门/或门 30 项（Or 真值表 0111、And 真值表 0001、电平结构互为镜像、统一 3 V 余量、万用表高阻与读负载）',
    layer: 'node',
    // ★ 判据口径：统一 3 V 阈值 + 不变量是**电平结构**（Or 高 ≈ Vp−V_D、And 高 ≈ Vp、低 ≈ V_D，高电平差 ≥ 1 V），
    //   不是「两套阈值必须不同」—— 阈值是**代理量**。
    // ⚠ 红档要两面镜子：金丝雀必红 **且** null 对照（只动一个标点、语义为零）必 0 红 ——
    //   只有金丝雀会被「恒红」骗过，只有 null 会被「恒绿」骗过，缺一不可。
    // ⚠ landInCode 必须四条同时成立（代码区恰命中 1 次 / 送出文本锚归零且 repl 多 1 / 盘上副本同样 /
    //   实测文本增量 == repl.length − anchor.length），因为**等长替换的 delta 是 0**，光看长度会漏。
    note: 'task-30（二极管与门：镜像电平结构 + 两面镜子）',
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
