// ══════════════════════════════════════════════════════════
// 触控行为层
//
// 这一层只做三件「手指有、鼠标没有」的事，全部靠能力/媒体查询自适应 ——
// 桌面鼠标上它什么都不会做：
//   1. 触屏没有右键 → 给「右键切换主题」补一条长按路径；
//   2. 触屏没有 hover → 长按用来「看一眼」按压目标（这里只做主题圆钮那处）；
//   3. 窄屏 / 触摸设备的窄屏 → 左器材栏与右侧边栏收成浮层抽屉，顶栏给出开合入口。
//
// 手势实现注意：pointerup 之后浏览器仍会补发一次 click，
// 所以长按已经生效时必须把随之而来的 click 吃掉一次，否则「长按换主题」
// 会顺带再执行一次单击的「切深浅色」，两次状态互相抵消。
// 这个「吃掉一次」是一次性开关，用完立刻复位 —— 不能长期挂着，
// 否则用户接下来真正的单击会被莫名其妙吞掉。
// ══════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════
// 架构约束（本文件踩过一次全仓级红灯，别再犯）：
//   UI 模块**不得有模块级 DOM 副作用**。
//   本文件曾在模块顶层直接装配，而 system.credit.js 会 import 本文件的
//   installLongPress —— 于是「插件入口链 → touch.js」被打通，
//   Node 里的 tools/check.mjs 与 tools/guard-plugins 一 import 就抛
//   ReferenceError: document is not defined，**两道闸门同时失效**，
//   所有人（包括调度者）在那段时间里的读数都不可信。
//   现在的形态：本模块**只导出**函数，由宿主 src/main.js 调用 `bootTouch()` ✓
//   —— 模块求值期不碰任何 DOM ✓（qs/qsa 里的无 DOM 兜底是**调用期**判断，
//   不在模块求值期执行）。index.html 也不再单独加载本文件 ✓。
// ══════════════════════════════════════════════════════════

import { theme } from '../core/theme.js';

/** 长按判定时长：短于 500ms 会跟「按住不放的轻点」混淆，长于 700ms 用户会以为没反应 */
const LONG_PRESS_MS = 550;
/** 长按期间允许的位移（px）：超过它说明用户是在拖动（滑页面 / 拖器材），不是长按 */
const LONG_PRESS_SLOP = 10;

/** 当前是否有真实 DOM。Node 侧（tools/check.mjs 等）import 本模块时为 false。 */
function hasDOM() {
  return typeof document !== 'undefined' && typeof document.createElement === 'function';
}

// 这两个查询助手刻意**不**把 document 写进默认参数：
// 默认参数在调用时就求值，Node 里一调 `qs('#x')` 就会抛。
// 无 DOM 时返回 null / []，调用方按「找不到」处理即可。
const qs = (s, r) => {
  if (!hasDOM()) return null;
  return (r || document).querySelector(s);
};
const qsa = (s, r) => {
  if (!hasDOM()) return [];
  return [...(r || document).querySelectorAll(s)];
};

/** 第一次需要时才建按钮，避免拖慢启动 */
function svg(path) {
  return `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">${path}</svg>`;
}

/**
 * 在元素上装一个长按识别器。返回一个「本次点击是否已经被长按消费掉」的判断函数，
 * 交给调用方在 click 里用。
 *
 * 调用方（两处，都是「触控没有右键」的兜底路径）：
 *   · 本文件 installThemeLongPress()  —— 主题圆钮 .fx-orb：长按换主题（= 桌面右键）
 *   · src/plugins/system.credit.js     —— 学分徽章 .credit-badge：长按开设置
 * 抽成导出的公共实现是为了让两处走**同一套**阈值/取消语义，
 * 避免第二处自己写一个「按住 500ms」的近似版（阈值一错就是误触/不触发）。
 *
 * @param {Element} el 要装长按的元素
 * @param {() => void} onLongPress 长按达成时的回调
 * @param {{pressScale?: number, hasCoarsePointer?: () => boolean}} [opts]
 *        pressScale：按下期间给元素加 transform: scale(...) 作为可见反馈。
 *        只在**粗指针**（触摸/笔）上生效 —— 鼠标用户按住左键不该看到元素缩一下。
 *        用 transform 而不是改样式表：它不参与命中测试、不占布局，
 *        所以不会像伪元素扩边那样「以为补了热区其实没有」。
 */
export function installLongPress(el, onLongPress, opts) {
  const wantScale = opts && typeof opts.pressScale === 'number' ? opts.pressScale : null;
  // 粗指针判定必须**每次按下时再问**，不能在装配时问一次就缓存：
  // 设备能力在运行期是可能变的（平板插上鼠标、DevTools 切换设备模拟），
  // 而且装配时机可能早于浏览器把能力位定下来 —— 实测徽章插件在
  // 设备模拟生效前就装好了，若那时缓存一个 false，触摸下永远不会有按下反馈。
  const coarseSrc = opts && opts.hasCoarsePointer;
  const coarse = () => {
    try {
      if (typeof coarseSrc === 'function') return !!coarseSrc();
      if (typeof coarseSrc === 'boolean') return coarseSrc;
      return hasCoarsePointer();
    } catch (e) { return false; }
  };
  const MAXT = '0.12s';   // 按下反馈要快于 --t-fast(160ms)，否则「按下」感觉迟钝
  let timer = 0;
  let sx = 0, sy = 0;
  let fired = false;
  let armed = false;
  let painted = false;
  let swallow = null;     // 一次性 click 吞噬器（见 disarm 与 installLongPress 尾部）

  /**
   * 解掉「一次性 click 吞噬器」。**必须只在将要取消时才调用**：
   * 哨兵监听器自己命中时会摘掉自己（那时不想再从这里摘一次）。
   * 解掉时把 dataset 标记一并清空 —— 标记是给外部探针看的，残留会误导读数。
   */
  const disarm = () => {
    if (!swallow) return;
    document.removeEventListener('click', swallow, true);
    swallow = null;
    delete document.documentElement.dataset.lpSwallow;
  };

  /**
   * 架起「一次性 click 吞噬器」。
   *
   * 为什么需要它（task-34，320px `CR1` 红）：长按被承认后手指抬起，浏览器会补发一次
   * click，而这次 click 的命中目标是**按抬起那一刻重新算的**。320 档的实测时间线：
   *   652ms 面板开（drawer-mask show in）→ 1025ms pointerup @credit-badge
   *   → 1026ms **click 落在遮罩上** → 1026ms 面板被「点遮罩即关闭」关掉。
   * 抽屉左沿 ≈ innerWidth−301：320 档左沿 173 > 徽章中心 160（徽章在抽屉**外**，
   * 那里只有遮罩）⇒ 中招；360 档左沿 137 < 180（徽章在抽屉**内**）⇒ 不中招。
   * 所以这不是 320px 的布局问题，是**长按自己那次 click 被转交给了别人**。
   *
   * 为什么不能沿用元素级 consume()（主题圆钮那套）：那套靠**元素自己的 click 监听**
   * 拦截，前提是这次 click 仍然解析到该元素。可这里 click 已转交给遮罩，
   * 元素自己的监听根本不跑 ⇒ 元素级方案在这条路径上无效。
   *
   * 为什么是「一次性」而不是「时间窗」：时间窗会在窗内顺手吞掉用户随后的正常点击，
   * 造出更坏的行为 —— 长按之后一段时间点遮罩关不掉面板。这里改成：
   *   · 每次 pointerdown 都 disarm()（用户一旦开始**新的**手势，旧哨兵立即失效）；
   *   · 哨兵命中后**先摘掉自己**再吞（removeEventListener + 清标记），所以至多吞一次；
   *   · 哨兵只挂在 document 捕获阶段，且只做 preventDefault/stopPropagation，
   *     不改任何业务状态。
   * 三点合起来：能吞的只有「本次长按抬手后紧随的那一次 click」。实测那次 click 在
   * pointerup 之后 **1ms** 到达（1025→1026ms），而人「抬手再按」的间隔远大于它，
   * 所以不需要任何时间常数 —— 这里刻意不引入超时窗口，避免「窗长选多大才安全」这种
   * 没有证据支撑的猜测。
   */
  const armSwallow = () => {
    disarm();
    swallow = (ev) => {
      document.removeEventListener('click', swallow, true);
      swallow = null;
      delete document.documentElement.dataset.lpSwallow;
      // 只吞这一次：不改业务状态，只让这次 click 不抵达任何监听者
      ev.preventDefault();
      ev.stopPropagation();
    };
    document.addEventListener('click', swallow, true);
    // 给外部探针一个可读的「哨兵已架起」信号，验收时不必靠猜
    document.documentElement.dataset.lpSwallow = '1';
  };

  /** 按下反馈：只在粗指针上画，且只有调用方明确要求时才画 */
  const paint = () => {
    if (!wantScale || painted || !coarse()) return;
    painted = true;
    el.style.transition = 'transform ' + MAXT + ' var(--ease-out, ease-out)';
    el.style.transform = 'scale(' + wantScale + ')';
  };
  const unpaint = () => {
    if (!painted) return;
    painted = false;
    el.style.transform = '';
    el.style.transition = '';
  };
  const stop = () => {
    clearTimeout(timer);
    timer = 0;
    armed = false;
    unpaint();
  };

  el.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0) return;
    // 一次手势只能有一个所有者。学分徽章自己也监听了 contextmenu 来开设置 ——
    // 长按它时浏览器会派发 contextmenu，于是「主题圆钮的长按兜底」和
    // 「徽章自己的菜单」会被同一次按压同时触发（实测会连主题一起换掉）。
    // 判定依据不是「哪个先到」，而是**手势起源在哪**：起点落在 .credit-badge 里
    // 就不该由主题圆钮这条兜底接管（徽章自己有更贴切的入口）。
    // 用 closest 判起源元素，而不是看 ev.target 是不是徽章本身 ——
    // 长按落在徽章内的图标/数字上时 target 是那些子元素，只看 target 会漏。
    // ⚠ 这条守卫只对「主题圆钮」这一条路径成立，所以徽章自己来装长按时
    //   必须能关掉它（ownOrigin=false），否则徽章永远召不出自己的长按。
    const ownOrigin = !opts || opts.ownOrigin !== false;
    if (ownOrigin && ev.target && ev.target.closest && ev.target.closest('.credit-badge')) return;
    // 鼠标右键本来就是原路径，不必再走长按（按住鼠标左键 550ms 也会触发，
    // 这没坏处：鼠标用户的多了一条路，而不是少了一条）
    stop();
    disarm();
    fired = false;
    armed = true;
    paint();
    // 可观测计数：「有没有真的架起一个长按计时器」。
    // 为什么需要它：守卫要能被验证，而只数「回调跑了几次」验证不了 ——
    // 长按主题圆钮的回调会真的换掉主题，把场景搞脏。数「架起计时器」这件事
    // 是纯观测、没有副作用，按哪里都能测：守卫放行 → 计数 +1，守卫拦下 → 不增。
    // 注意本监听绑在元素自己身上，所以计数只在手势起点真的落在该元素上时才增加 ——
    // 这正好是我们要断言的语义。
    const dt = document.documentElement.dataset;
    dt.lpArm = String((Number(dt.lpArm) || 0) + 1);
    sx = ev.clientX; sy = ev.clientY;
    timer = setTimeout(() => {
      timer = 0;
      if (!armed) return;
      armed = false;
      fired = true;
      unpaint();
      onLongPress();
      armSwallow();
    }, LONG_PRESS_MS);
  });

  el.addEventListener('pointermove', (ev) => {
    if (!armed) return;
    if (Math.hypot(ev.clientX - sx, ev.clientY - sy) > LONG_PRESS_SLOP) stop();
  });
  el.addEventListener('pointerup', stop);
  el.addEventListener('pointercancel', stop);
  el.addEventListener('pointerleave', stop);
  // ⚠ pointerup **不能** disarm()：长按成功后 pointerup 必然晚于哨兵架起
  //   （实测 652ms 架起、1025ms 抬手），在 stop() 里 disarm 会把哨兵撤掉，
  //   那次 click 就照旧转交给遮罩、面板又被关掉 —— 修了等于没修。
  //   哨兵本身是一次性的（命中后自摘），这里只在「根本不会有 click 来」的
  //   取消路径上补一次清理，避免留下永不触发的空监听。
  const dropSwallow = () => disarm();
  el.addEventListener('pointercancel', dropSwallow);
  // 长按在触摸设备上还可能唤出系统的长按菜单/选择，一并挡掉
  el.addEventListener('contextmenu', (ev) => ev.preventDefault());

  /** 消费掉长按后紧跟着的那一次 click */
  return function consume() {
    if (!fired) return false;
    fired = false;
    return true;
  };
}

/** 当前指针是不是粗指针（触摸/笔）。用于决定「要不要给按下反馈」。
 *  matchMedia 可能不存在（老环境/测试垫片），一律按「不是粗指针」处理：
 *  宁可少一个视觉反馈，也不要在不支持的浏览器里抛异常把整层拖垮。 */
export function hasCoarsePointer() {
  try { return !!(window.matchMedia && window.matchMedia('(any-pointer: coarse)').matches); }
  catch (e) { return false; }
}

/** 主题圆钮：单击切深浅色，长按换主题（= 桌面上的右键）
 *  返回 true 表示这一次真的装上了（元素已就绪且之前没装过）。 */
function installThemeLongPress() {
  const orb = qs('.fx-orb');
  if (!orb) return false;
  // 幂等：本文件可能因为插槽重建而被重新执行，重复装会出现两个长按计时器，
  // 一次长按就把主题连翻两下。标记打在元素自己身上，元素被换掉时标记自然消失，
  // 那时重新装才是对的。
  if (orb.dataset.lpInstalled) return true;
  orb.dataset.lpInstalled = '1';
  // 每枚圆钮发一个实例号：无头探针里出现过「回调跑了两次、主题却回到原点」，
  // 而那枚被按的圆钮和我读到计数的那枚不是同一个元素。有实例号才分得清
  // 「同一枚上装了两个处理器」和「元素被换掉、新旧两枚各跑了一次」。
  const orbId = 'orb' + Math.random().toString(36).slice(2, 8);
  orb.dataset.lpId = orbId;
  const consume = installLongPress(orb, () => {
    // 可观测计数：长按回调到底跑了几次。没有它，无头探针里
    // 「事件到了但回调没跑」和「回调跑了两次互相抵消」这两种情况长得一模一样。
    const n = (Number(document.documentElement.dataset.lpFires) || 0) + 1;
    document.documentElement.dataset.lpFires = String(n);
    const log = (window.__lpTrace = window.__lpTrace || []);
    log.push({ n, orbId, live: orb.isConnected, theme: theme.id, t: Math.round(performance.now()) });
    const list = theme.list();
    if (list.length < 2) return;
    const i = list.findIndex(t => t.id === theme.id);
    const next = list[(i + 1) % list.length];
    theme.use(next.id);
    log[log.length - 1].after = theme.id;
    window.xiaomo?.toast?.('主题：' + next.name);
  });
  // 捕获阶段先于 ui.themeswitch 自己的 click 监听执行（它在冒泡阶段），
  // 所以在捕获阶段用 stopPropagation 就能把这一次 click 拦掉，且不改动那个插件文件。
  orb.addEventListener('click', (ev) => {
    if (consume()) { ev.stopPropagation(); ev.preventDefault(); }
  }, true);
  return true;
}

/** 浮层抽屉：左器材栏与右侧边栏在窄屏上收成浮层，这里管开合
 *
 *  ⚠ 幂等标记必须打在**按钮**上，不能打在遮罩上 —— 这是本轮最贵的一个坑。
 *    实测证据（当时临时挂了一份 window.__dockLog 记实例号，收尾已删）：
 *      t=132 建出 btnPalette/dva3si、btnSidebar/d3ekke
 *      t=133 绑定到 dva3si            ← 监听器装在**这一枚**上
 *      t=302 又建出 btnPalette/dymcex、btnSidebar/do3v9f  ← 别的插件重建了顶栏插槽
 *    结果：文档里活着的是 dymcex，监听器却在已被替换的 dva3si 上
 *      ⇒ **按钮在、点它什么都不发生**，而且不报错、所有可见状态都对。
 *    现在实例号仍留在元素上（dataset.dockSeq），验收时可随时读当前活着的是哪一枚。
 *    若标记打在遮罩上（我先前那版），遮罩没被换 ⇒ 第二次进来直接 return ⇒
 *    永远补不上新按钮的监听器。
 *    所以这里改成：每次都重新指向当前活着的按钮，只在「这两枚按钮已经绑过」时跳过。
 *    注意本函数**不需要**被整体重复执行：面板/遮罩/快捷键/resize 那些是全局的，
 *    用 mask 上的标记保证只装一次；会随顶栏重建而失效的只有按钮这一部分。 */
function installDrawers() {
  const pal = qs('#palette');
  const side = qs('#sidebar');
  const mask = qs('#drawerMask');
  const btnPal = qs('#btnPalette');
  const btnSide = qs('#btnSidebar');
  if (!pal || !side || !mask || !btnPal || !btnSide) return;

  let open = null;                    // 'palette' | 'sidebar' | null
  const isNarrow = () => window.matchMedia(
    '(max-width: 1024px), ((pointer: coarse) and (max-width: 1180px))').matches;

  const paint = () => {
    pal.toggleAttribute('data-open', open === 'palette');
    side.toggleAttribute('data-open', open === 'sidebar');
    btnPal.classList.toggle('active', open === 'palette');
    btnSide.classList.toggle('active', open === 'sidebar');
    btnPal.setAttribute('aria-expanded', String(open === 'palette'));
    btnSide.setAttribute('aria-expanded', String(open === 'sidebar'));
  };

  const show = (which) => {
    open = which;
    paint();
    mask.classList.add('show');
    // 同一个 tick 里加 .show 又加 .in，「从 display:none 恢复」与「开始过渡」
    // 会被合并成一次样式计算，过渡根本不播放。必须等下一帧。
    requestAnimationFrame(() => { if (open) mask.classList.add('in'); });
  };

  const close = () => {
    if (!open) return;
    open = null;
    paint();
    mask.classList.remove('in');
    // 遮罩先淡出再 display:none，否则那 200ms 的淡出会变成瞬间消失
    setTimeout(() => { if (!open) mask.classList.remove('show'); }, 220);
  };

  const toggle = (which) => { (open === which) ? close() : show(which); };

  // ── 按钮绑定：只在「这两枚按钮自己身上没有绑定标记」时绑 ──────────
  // 按钮被顶栏重建时标记随旧节点消失，下一次调用就会重新绑（这正是我们要的）；
  // 按钮没换时标记在，绝不重复注册。
  //
  // ⚠⚠ 遮罩的 click 监听**必须绑在这里**，不能绑在下面那个「全局只装一次」的块里。
  //   这是本轮最隐蔽的一个坑，实测（给每个实例发随机 id 记录）：
  //     instLog  = enter#A(global=-) / enter#B(global=1) / enter#C(global=1)
  //     showLog  = show#C(palette)          ← 按钮是 C 绑的
  //     closeLog = close#A(open=null)       ← 遮罩监听却是 A 绑的
  //   本函数在插槽到齐前会被反复调用，而**遮罩上的「全局」标记由第一个进入的实例
  //   抢先写下**（那时它自己的 open 还是 null，按钮也还没建）；等按钮真正由实例 C
  //   绑定时，遮罩监听已经归 A 所有 —— 于是点遮罩走的是 A 的 close，
  //   它读的是 A 自己的 open（永远是 null），直接 return。
  //   症状极具误导性：遮罩**收得到**点击（事件记录里有 mask-click）、
  //   程序化 mask.click() 也「有时」能关（那要看是哪次实例），
  //   但真实手指点遮罩就是关不掉。
  //   绑在这里则保证「谁的 open 被 show 写过，就由谁的 close 来读」。
  const bind = () => {
    btnPal.addEventListener('click', () => toggle('palette'));
    btnPal.dataset.drawersBound = 'pal';
    btnSide.addEventListener('click', () => toggle('sidebar'));
    btnSide.dataset.drawersBound = 'side';
    mask.addEventListener('click', close);
  };

  // ── 与按钮无关的全局监听：只装一次（那几个监听者不读 open 之外的闭包状态）──
  if (!mask.dataset.drawersGlobal) {
    mask.dataset.drawersGlobal = '1';
    window.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') close(); });
    // 视口变宽（转到桌面布局）时把浮层收掉：那时两栏是常驻的，
    // 留着 data-open 会让下一次回到窄屏时「一进来就已经开着」。
    window.addEventListener('resize', () => { if (!isNarrow()) close(); });
    // 指针从手指换成鼠标（插上鼠标的平板）也收掉：一个粗指针下开的浮层，
    // 在细指针布局里没有对应的「开着」概念。
    const mqFine = window.matchMedia('(pointer: fine)');
    const onCap = () => { if (mqFine.matches) close(); };
    if (mqFine.addEventListener) mqFine.addEventListener('change', onCap);
    else if (mqFine.addListener) mqFine.addListener(onCap);
  }

  // ── 按钮部分：每次调用都检查（按钮会被顶栏重建）──
  if (btnPal.dataset.drawersBound !== 'pal' || btnSide.dataset.drawersBound !== 'side') {
    bind();
  }

  paint();
}

/** 顶栏插槽里补两个开合按钮（不搬动其他插件渲染出来的兄弟节点，避免顺序冲突） */
function installDockButtons() {
  // ⚠ 这个前置守卫是「两个都已存在 → 没事可做」的快捷路径。
  //   它**不能**写成「任一个存在就 return」：本函数要能分开补装（下面的
  //   if (tools && !qs('#btnPalette'))），一个已装另一个没装时仍得进来补。
  if (qs('#btnPalette') && qs('#btnSidebar')) return;

  const mk = (id, title, label, path) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.id = id;
    b.className = 'dock-btn';
    // 唯一实例号：本轮真踩过一个「装了、但装的是另一个节点」的坑 ——
    // dataset 上的标记读不到、行为上点了没反应，而所有可见状态都是对的。
    // 没有实例号就只能看到「标记不见了」，分不清是「没装」还是「装到了别的节点」。
    // 它是**留在 DOM 上的常态观测点**（验收时可以随时读当前活着的按钮是哪一枚），
    // 不是临时日志：临时那份 window.__dockLog 已经在收尾时删掉了。
    b.dataset.dockSeq = 'd' + Math.random().toString(36).slice(2, 7);
    b.title = title;
    b.setAttribute('aria-label', title);
    b.setAttribute('aria-expanded', 'false');
    b.setAttribute('aria-controls', label);
    b.innerHTML = svg(path);
    return b;
  };

  // 左侧的「打开器材栏」放在「工具」那一组的末尾（它最靠近画布左半边）
  const tools = qs('[data-slot="topbar.tools"]');
  // 右侧的「打开属性/数据/日志」放在最靠近右边的「其它动作」组**开头**，
  // 这样它左边是 wincontrols 组之外的位置，打开的就是屏幕右半边。
  const right = qs('[data-slot="topbar.right"]');
  // ⚠ 两个插槽各自判断、各自补装 —— 不要写成「两个都在才装」：
  //   实测本模块执行时两个 slot 都还没被 main.js 渲染出来（都是 null），
  //   若把「都到齐」当成前置条件，就会一个都不装。
  if (tools && !qs('#btnPalette')) {
    tools.appendChild(mk('btnPalette', '器材栏', 'palette',
      '<path d="M2 3.5h12v9H2z" fill="none" stroke="currentColor" stroke-width="1.4"/>' +
      '<path d="M6 3.5v9" stroke="currentColor" stroke-width="1.4"/>'));
  }
  if (right && !qs('#btnSidebar')) {
    right.prepend(mk('btnSidebar', '属性与数据', 'sidebar',
      '<path d="M2 3.5h12v9H2z" fill="none" stroke="currentColor" stroke-width="1.4"/>' +
      '<path d="M10 3.5v9" stroke="currentColor" stroke-width="1.4"/>'));
  }
}

/** 已安装过就不再装第二遍（index.html 里只加载一次，这里防的是脚本被重复引入）
 *  ⚠ 下面三个 installer 里，只有 installThemeLongPress 是幂等的（标记打在被装的元素上）。
 *  installDrawers 每次调用都会**重新注册**一批监听器（按钮 click、遮罩 click、
 *  window keydown/resize、指针形态 change）—— 实测重复调用会让抽屉行为错乱
 *  （同一批监听器堆多份，close/open 交错）。所以补装时**只许重试圆钮那一条**，
 *  不要把 setupTouch 整个再跑一遍。 */
let installed = false;
/** bootTouch 幂等：宿主只调用一次，但重复调用**也不许**再装一遍 ——
 *  installDrawers 每次调用都重新注册一批监听器（见上），重复装会让抽屉行为错乱 ✗。 */
let booted = false;
export function setupTouch() {
  if (installed) return;
  installed = true;
  // 装配步骤轨迹（只增不改，供无头探针读）：形如 "theme>dock>drawers>"
  const trace = (tag) => {
    const dt = document.documentElement.dataset;
    dt.touchSteps = (dt.touchSteps || '') + tag + '>';
  };
  // ⚠ 每一步单独接住异常并把名字记进 dataset.touchError。
  //   为什么：谁先抛，后面的就全不执行（旧版实测 installDockButtons 的插槽是 null，
  //   于是顶栏两个入口静默缺失，而 dataset.touchLayer 照旧显示 ready —— 一个
  //   「装了但缺件」的状态看起来和「装好了」一模一样）。
  //   顺序也不要改：installDockButtons 必须在 installDrawers 之前，
  //   因为后者要 bind 那两个按钮。
  for (const [name, fn] of [['theme', installThemeLongPress],
    ['dock', installDockButtons], ['drawers', installDrawers]]) {
    try {
      fn();
      // 逐步痕迹：把每一步的**进入与成功**都记下来。
      // 只记「有没有抛」是不够的 —— 本模块的 installer 都是「缺件就安静 return」，
      // 于是「跑了但没装成」和「装成了」在 dataset 里长得一样（都是没报错）。
      // 这正是前面两轮静默缺件的共同形状。
      trace(name);
    } catch (e) {
      const dt = document.documentElement.dataset;
      dt.touchError = (dt.touchError ? dt.touchError + ',' : '') + name
        + ':' + String((e && e.message) || e).slice(0, 80);
      trace(name + '!');
    }
  }
  // 对外留一个可检查的标记：这条触控基线到底装上了没有。
  // 没有它，无头环境里只能靠「按钮存不存在」间接推断，而本轮真踩过这个坑 ——
  // recheck 只盯按钮、漏掉主题圆钮时，长按这条替代路径是**静默**失效的。
  document.documentElement.dataset.touchLayer = 'ready';
}

// ── 装配入口：由宿主调用（原「模块级装配」）─────────────────────────────────
// 调用者：src/main.js 的浏览器路径，位置在 `this.mountSlots(); this.afterSlots();` 之后 ✓
// （index.html 不再单独加载本文件 ✓；`bootTouch` 幂等 ✓）。
//
// ⚠ 但「main.js 先执行完」**不等于**「该有的元素都到齐了」，实测两次踩坑：
//   ① qs('.fx-orb') 连续三次返回 null，主题圆钮直到 ~320ms 后才被挂上；
//   ② 更严重的一次：两个 [data-slot="topbar.*"] 插槽在本模块执行时**都还是
//      null**（它们是 index.html 里的静态标签，但里面的内容由 main.js 的插件
//      渲染）。installDockButtons 当时拿到 null 就什么都没建，于是
//      「顶栏没有器材栏/侧边栏入口」+「圆钮没有长按」两个用户可见缺陷同时出现，
//      而 dataset.touchLayer 照样是 'ready' —— **装了但缺件**，看起来和装好了
//      一模一样。这正是 L329 那个标记当初想防的事，只是标记本身不够。
//   所以装配必须等到 DOM 就绪之后再跑，而不是在模块求值的那一刻跑。
// 为什么必须包环境守卫：本模块会被 src/plugins/system.credit.js 通过 import 引用
// （为了复用 installLongPress），于是「插件入口链 → 本模块」被打通。
// Node 侧的工具（tools/check.mjs 等）会在 Node 里 import 整条插件链，
// 那里没有 document —— 模块顶层一碰 DOM 就抛，会把 **全仓闸门一起打掉**。
// ⚠ 本函数由宿主调用，模块求值期**不碰 DOM** ✓ —— 因此这里**不需要**环境守卫：
//   有守卫反而是把哨兵留着 ✗（守卫能让闸门变绿，但债还在 ✗）。
export function bootTouch() {
  if (booted) return;
  booted = true;
  const boot = () => {
    try {
      setupTouch();
      // 装完再问一次「缺不缺件」。两样东西都可能比这一步更晚到：
      //   · 主题圆钮（installThemeLongPress 自带幂等标记，重问安全）
      //   · 顶栏两个入口（installDockButtons 现在自带逐按钮幂等）
      // ⚠ 这里**不能**用 `A && B` 串起来：&& 会短路，A 不成立时 B 永远不执行。
      //   旧版正是 `!!qs('#btnPalette') && installThemeLongPress()`，
      //   而 #btnPalette 恰恰就是缺的那个 ⇒ 长按兜底永不重试 ⇒ 静默失效。
      const stillMissing = () => !qs('.fx-orb') || !qs('#btnPalette') || !qs('#btnSidebar');
      // ⚠ 「还缺什么」必须是**每次补装后重新同步**的观测，不能只在 boot 里写一次快照：
      //   实测首屏快照会写下 touchMissing="orb"（那时圆钮确实还没到），
      //   等圆钮到了、长按也装上了，这个标记却留在页面上骗人 ——
      //   一个会说谎的标记比没有标记更坏（验收方会照着它去查一个不存在的问题）。
      const syncMissing = () => {
        const dt = document.documentElement.dataset;
        const missing = [qs('.fx-orb') ? null : 'orb',
          qs('#btnPalette') ? null : 'btnPalette',
          qs('#btnSidebar') ? null : 'btnSidebar'].filter(Boolean);
        if (missing.length) dt.touchMissing = missing.join(',');
        else delete dt.touchMissing;
        return !missing.length;
      };
      // ⚠⚠ 补装必须把**三个 installer 全带上**，少一个就是一次静默的缺件。
      //   实测踩过两次，都是「按依赖顺序只补了前一半」：
      //     第一次只补了圆钮 → 顶栏两个入口永久缺失；
      //     第二次补了圆钮 + 两个入口、漏了抽屉 → 按钮在、监听器不在，
      //       点按钮**什么都不发生**且不报错。
      //   依赖顺序：installDockButtons 必须先于 installDrawers（后者要 bind 前者的产物）。
      //   三者现在都各自幂等（标记分别打在圆钮 / 逐按钮 / 遮罩上），重复调用安全。
      const retry = () => {
        installDockButtons();
        installThemeLongPress();
        installDrawers();
        return syncMissing();
      };
      // ⚠ 写成独立的 if/else，不要用 `A || retry()` 那种短路组合 ——
      //   本文件已经因为一个 && 短路吃过一次静默失效。
      // ⚠ DOMContentLoaded 也**不**保证元素齐（实测两个 topbar 插槽的填充发生在
      //   它之后），所以这里仍要挂观察器，只是有上限、且补装本身是幂等的。
      syncMissing();
      if (stillMissing()) {
        // 第一次补装；成功就不必挂观察器
        if (!retry()) {
          // 为什么不用定时器轮询：轮询要么间隔太密（白烧 CPU）要么太疏（还是赌时序）；
          // MutationObserver 是事件驱动的，元素一插入就会跑，且没变化时零开销。
          const mo = new MutationObserver(() => { if (retry()) mo.disconnect(); });
          mo.observe(document.documentElement, { childList: true, subtree: true });
          // 兜底：某些环境下插槽可能始终不出现，给一个上限，免得观察器永远挂着。
          setTimeout(() => mo.disconnect(), 6000);
        }
      }
    } catch (e) {
      // 装配本身抛了也必须留下痕迹，否则 dataset 里只有一句 ready（旧版就是这样）。
      document.documentElement.dataset.touchError = 'boot:'
        + String((e && e.message) || e).slice(0, 120);
    }
  };
  // ⚠ 就绪判断不能用 document.readyState === 'complete' 作为**前置条件**：
  //   完不成（某些环境下 load 迟迟不来）就永远不装。这里只在还处于 loading
  //   时等 DOMContentLoaded，其余情况立刻装。
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
}
