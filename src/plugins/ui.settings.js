// ══════════════════════════════════════════════════════════
// 界面插件：设置
//
// 存在的理由是「有些功能该能关掉」——学分是娱乐性玩法，不是实验的一部分，
// 用户得能自己决定要不要它。所以这里只放**开关**，不放参数：
// 需要调参数的（主题、深浅色）各自有入口，重复一遍只会两处走样。
//
// 开关为什么要同时动两个地方：
//   app.host.disable/enable      → 这一刻真的把插件拆掉/装上（界面立刻变）
//   app.pluginState.setItem(...) → 记下这个选择（下次启动还算数）
// 只做前者，刷新就复活；只做后者，页面不动。两者缺一不可。
// ══════════════════════════════════════════════════════════

// 拖出落位那条偏好的**真源在 src/ui/palette.js** —— 消费它的是那里（放手那一刻读）。
// 设置面板只是它的一个界面，所以键名与读写都从那边引进来，不在这里再抄一份：
// 抄一份就有两个真源，改名时必然漏掉一个，而漏掉的那一份**不会报错**。
import { DROP_COLLAPSE_KEY, readDropCollapse, saveDropCollapse } from '../ui/palette.js';

/** 被开关管的插件。写死 id 是有意的：设置面板只承诺管这一个「娱乐功能」 */
const CREDIT_ID = 'xiaomo.system.credit';
const CREDIT_BUNDLE = 'system';
/**
 * 大屏可读模式的持久化键。与 xiaomo.mode.v1（深浅色）/ xiaomo.theme.v1（主题）同族：
 * 它是**用户偏好**，不是插件启停 —— 所以不走 app.pluginState.setItem（那个键按插件 id 走，
 * 语义是「这个插件装不装」）。键名同时被 tools/display-probe.html 断言，改名要一起改。
 */
export const BIGREAD_KEY = 'xiaomo.display.v1';
/** 读取偏好：存储不可用（无痕模式/配额满）时按默认「关」，与 index.html 的兜底口径一致 */
export function readBigRead() {
  try { return localStorage.getItem(BIGREAD_KEY) === '1'; } catch (e) { return false; }
}
export function saveBigRead(on) {
  try { localStorage.setItem(BIGREAD_KEY, on ? '1' : '0'); } catch (e) { /* 存不下就只在本次会话生效 */ }
}
/** 生效方式只有这一条：根元素上一个 class，全部样式在 styles/display.css 里 */
export function applyBigRead(on) {
  const root = document.documentElement;
  if (root) root.classList.toggle('big-read', !!on);
}
/** 打开设置抽屉：⚙ 按钮与学分徽章右键走同一个入口，免得两处各写一套开合逻辑 */
export const SETTINGS_EVENT = 'xiaomo:settings';
/** 打开插件管理器（ui.manager 已在听这个事件） */
const MANAGER_EVENT = 'xiaomo:plugins';

/** 把计算出来的过渡时长换算成毫秒：机器可读的值才是主依据，不写死毫秒 */
function cssMs(v) {
  const n = parseFloat(v) || 0;
  return /ms\s*$/.test(String(v).trim()) ? n : n * 1000;
}

/** 遮罩/面板上最长的过渡时长 + 一帧余量（兜底超时，不是过渡时长本身） */
function exitMs(root) {
  let max = 0;
  for (const el of [root, root.firstElementChild]) {
    if (!el) continue;
    for (const d of getComputedStyle(el).transitionDuration.split(',')) max = Math.max(max, cssMs(d));
  }
  return max + 80;
}

export default {
  id: 'xiaomo.ui.settings',
  name: '设置',
  version: '1.0.0',
  kind: 'ui',
  desc: '集中开关那些「要还是不要」的功能，目前是学分系统（娱乐）',
  author: '小墨实验室',
  builtin: true,
  tags: ['界面', '设置', '开关'],
  setup(ctx) {
    const app = ctx.app;

    // 挂载期就把存下的选择应用上去：大屏可读模式不该等到用户打开设置才生效。
    // （index.html 只允许加一行 <link>，没有同步内联脚本的位置，所以这一步晚于首屏配色、
    //   但早于模块脚本执行完 —— main.js 是 defer 的 module，通常仍在首帧之前。）
    applyBigRead(readBigRead());

    /**
     * 「抽屉此刻该是开着的」这个意图必须活在这个插件的 setup 作用域里，不能只活在
     * 渲染闭包内：开关一拨就会让别处的 overlay 项增减（学分插件的管理员弹窗就是），
     * 宿主随即重渲染整个 overlay 槽 —— 抽屉节点被换掉，闭包里的状态也跟着没了。
     * 没有它，用户点一下开关抽屉就自己关掉。
     */
    let wantOpen = false;

    /** window 上的监听器也进处置栈：插件拆掉后不该还有回调在跑 */
    const onWin = (type, fn) => {
      window.addEventListener(type, fn);
      ctx.onDispose(() => window.removeEventListener(type, fn));
    };

    // ── 顶栏入口（order 40：紧挨插件管理器的 30）──
    ctx.slot('topbar.right', (hostEl) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'tb-btn';
      b.id = 'btnSettings';
      b.title = '设置';
      b.textContent = '⚙';
      b.addEventListener('click', () => window.dispatchEvent(new CustomEvent(SETTINGS_EVENT, { detail: true })));
      hostEl.appendChild(b);
    }, { order: 40 });

    // ── 抽屉（复用 .drawer-* 与 .plug-* 既有样式，不新增样式表规则）──
    ctx.slot('overlay', (hostEl) => {
      const mask = document.createElement('div');
      mask.className = 'drawer-mask';
      mask.innerHTML = `
        <aside class="drawer" role="dialog" aria-modal="true" aria-label="设置">
          <header class="drawer-head">
            <div>
              <h2>设置</h2>
              <p class="drawer-sub">功能开关，改完立刻生效</p>
            </div>
            <button type="button" class="drawer-x" title="关闭">✕</button>
          </header>
          <div class="drawer-body">
            <section class="plug-sec">
              <div class="plug-sec-head"><h3>娱乐功能</h3></div>
              <div class="plug-row" id="setRowCredit">
                <div class="plug-main">
                  <div class="plug-title">
                    <b>学分系统（娱乐）</b>
                    <span class="plug-id"></span>
                  </div>
                  <p class="plug-desc">娱乐性玩法，和实验本身无关：正确实验加分、损坏仪器扣分，扣完会被实验室管理员请出去。</p>
                  <p class="plug-desc">关闭后不再计分。注意：<b>损坏依然会发生</b>，只是不扣分、也不会被请出去。</p>
                  <div class="plug-meta">
                    <span class="plug-chip soft">内置插件</span>
                    <span class="plug-chip soft">可在插件管理器里卸载</span>
                  </div>
                </div>
                <button type="button" class="plug-switch" role="switch" aria-label="学分系统（娱乐）" aria-checked="true">
                  <i></i>
                </button>
              </div>
            </section>
            <section class="plug-sec">
              <div class="plug-sec-head"><h3>显示</h3></div>
              <div class="plug-row" id="setRowDisplay">
                <div class="plug-main">
                  <div class="plug-title">
                    <b>大屏可读模式</b>
                    <span class="plug-id">xiaomo.display.v1</span>
                  </div>
                  <p class="plug-desc">投影给整个教室看的时候打开：字号与关键控件整体放大，次要文字提对比度、加字重。站在屏幕前用手指操作时可以关掉。</p>
                  <p class="plug-desc">只动「看得清」的那几件事：布局不变（三栏、实验台宽度、功能都不动），也不引入任何动效。</p>
                  <div class="plug-meta">
                    <span class="plug-chip soft">默认关</span>
                    <span class="plug-chip soft">记住选择</span>
                  </div>
                </div>
                <button type="button" class="plug-switch" role="switch" aria-label="大屏可读模式" aria-checked="false">
                  <i></i>
                </button>
              </div>
            </section>
            <section class="plug-sec">
              <div class="plug-sec-head"><h3>器材栏</h3></div>
              <div class="plug-row" id="setRowDropCollapse">
                <div class="plug-main">
                  <div class="plug-title">
                    <b>拖出器材后收起器材栏</b>
                    <span class="plug-id"></span>
                  </div>
                  <p class="plug-desc">手机与平板上器材栏是浮层抽屉。默认<b>不收起</b>：把器材从器材栏拖到实验台放手后，抽屉保持打开，可以接着拖第二件。</p>
                  <p class="plug-desc">打开这个开关后，放手即自动收起抽屉，露出整个实验台。桌面布局下器材栏是常驻栏，没有「收起」这回事，这个开关在那时不起作用。</p>
                  <div class="plug-meta">
                    <span class="plug-chip soft">默认关（保持打开）</span>
                    <span class="plug-chip soft">记住选择</span>
                  </div>
                </div>
                <button type="button" class="plug-switch" role="switch" aria-label="拖出器材后收起器材栏" aria-checked="false">
                  <i></i>
                </button>
              </div>
            </section>
          </div>
          <footer class="drawer-foot">
            <span class="drawer-hint">关掉学分不影响器材、电路与化学反应。</span>
            <button type="button" class="mini-btn" id="btnOpenPlugins">打开插件管理器</button>
          </footer>
        </aside>`;
      hostEl.appendChild(mask);
      mask.querySelector('#setRowCredit .plug-id').textContent = CREDIT_ID;

      const row = mask.querySelector('#setRowCredit');
      const sw = row.querySelector('.plug-switch');

      // ── 开关 ──────────────────────────────────────────────
      // 显示口径取「用户的选择」（持久化意图），因为那才是开关的语义；
      // 宿主记录只是这个选择的执行结果，重装/失败都会让它暂时对不上。
      const isOn = () => {
        const st = app && app.pluginState;
        if (st && typeof st.isItemOff === 'function') return !st.isItemOff(CREDIT_ID);
        const rec = app && app.host && app.host.get ? app.host.get(CREDIT_ID) : null;
        return rec ? rec.phase === 'active' : true;
      };

      const paint = () => {
        const on = isOn();
        row.classList.toggle('off', !on);
        sw.classList.toggle('on', on);
        sw.setAttribute('aria-checked', String(on));
        sw.title = on ? '关闭学分系统' : '开启学分系统';
      };

      /** 第二参数是「是否启用」：false = 停用，true = 启用 */
      const setOn = (on) => {
        const host = app && app.host;
        if (host && typeof host.enable === 'function' && typeof host.disable === 'function') {
          if (on) host.enable(CREDIT_ID); else host.disable(CREDIT_ID, 'item');
        }
        const st = app && app.pluginState;
        if (st && typeof st.setItem === 'function') st.setItem(CREDIT_ID, on);
        paint();
      };

      sw.addEventListener('click', () => setOn(!isOn()));

      // ── 大屏可读模式（不是插件启停，所以不走 host.enable/disable）──
      // 三件事各归各位：偏好进 localStorage、生效靠根元素 class、界面画法沿用同一套类名。
      const rowD = mask.querySelector('#setRowDisplay');
      const swD = rowD.querySelector('.plug-switch');
      const paintD = () => {
        const on = readBigRead();
        rowD.classList.toggle('off', !on);
        swD.classList.toggle('on', on);
        swD.setAttribute('aria-checked', String(on));
        swD.title = on ? '关闭大屏可读模式' : '开启大屏可读模式';
      };
      swD.addEventListener('click', () => {
        const on = !readBigRead();
        saveBigRead(on);          // 先记选择，再应用：刷新后仍按用户意图恢复
        applyBigRead(on);
        paintD();
      });
      paintD();

      // ── 拖出器材后是否收起器材栏（用户偏好，不是插件启停）──
      // 与上面那条同构：先记选择、再画界面。真正「生效」的一刻在**放手时**，
      // 由 src/ui/palette.js 的 afterDrop() 读这个键决定收不收 —— 这里不申请任何效果。
      const rowC = mask.querySelector('#setRowDropCollapse');
      rowC.querySelector('.plug-id').textContent = DROP_COLLAPSE_KEY;
      const swC = rowC.querySelector('.plug-switch');
      const paintC = () => {
        const on = readDropCollapse();
        rowC.classList.toggle('off', !on);
        swC.classList.toggle('on', on);
        swC.setAttribute('aria-checked', String(on));
        swC.title = on ? '关闭：放手后保持器材栏打开' : '开启：放手后自动收起器材栏';
      };
      swC.addEventListener('click', () => { saveDropCollapse(!readDropCollapse()); paintC(); });
      paintC();

      // ── 浮层时序与焦点（与插件管理器同一套做法）──────────
      const shell = document.getElementById('app');
      const canInert = typeof HTMLElement !== 'undefined' && 'inert' in HTMLElement.prototype;
      let restoreFocus = null;
      let closing = 0;
      const cancelClose = () => { if (closing) { clearTimeout(closing); closing = 0; } };
      const lockBg = () => {
        if (!shell) return;
        if (canInert) shell.inert = true; else shell.setAttribute('aria-hidden', 'true');
      };
      const unlockBg = () => {
        if (!shell) return;
        // 还有别的浮层开着就继续锁着背景，否则关掉一层会把底下的界面放开
        if (document.querySelector('.drawer-mask.show,.expel-mask.show,.about-mask.show')) return;
        if (canInert) shell.inert = false; else shell.removeAttribute('aria-hidden');
      };

      const open = () => {
        cancelClose();
        wantOpen = true;
        paint();                        // 别处可能改过状态，开之前先对一次
        restoreFocus = document.activeElement;
        const wasHidden = !mask.classList.contains('show');
        if (wasHidden) mask.classList.remove('in');
        mask.classList.add('show');
        void mask.offsetWidth;          // 立刻结算起点，抽屉滑入才有过渡
        mask.classList.add('in');
        lockBg();
        const t = mask.querySelector('.drawer-x');
        if (t && t.focus) t.focus({ preventScroll: true });
      };

      const close = (after) => {
        wantOpen = false;
        if (!mask.classList.contains('show')) { if (after) after(); return; }
        mask.classList.remove('in');
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
          if (restoreFocus && restoreFocus.focus) restoreFocus.focus({ preventScroll: true });
          restoreFocus = null;
          if (after) after();
        };
        // 退场以 transitionend 为主信号，计时器只是兜底：动效时长改了这里自动跟随
        const onEnd = (e) => {
          if (e.target !== mask && !mask.contains(e.target)) return;
          if (e.propertyName !== 'transform' && e.propertyName !== 'opacity') return;
          finish();
        };
        mask.addEventListener('transitionend', onEnd);
        closing = setTimeout(finish, wait);
      };

      onWin(SETTINGS_EVENT, (e) => { e.detail ? open() : close(); });
      onWin('keydown', (e) => { if (e.key === 'Escape') close(); });
      mask.querySelector('.drawer-x').addEventListener('click', () => close());
      mask.addEventListener('click', (e) => { if (e.target === mask) close(); });
      // 先退场再开管理器：两层的背景锁是共用的，退场完成回调里派发就不会互相顶掉
      mask.querySelector('#btnOpenPlugins').addEventListener('click', () => {
        close(() => window.dispatchEvent(new CustomEvent(MANAGER_EVENT, { detail: true })));
      });

      paint();

      // 重渲染之后回到「开着」的样子。拨开关会让 overlay 槽里的条目增减，宿主把整个槽
      // 重渲染一遍——不补这一步，用户点一下开关抽屉就自己没了。
      if (wantOpen) {
        mask.classList.add('show', 'in');   // 一起加上，节点首帧就是终态，不会再滑一次
        lockBg();
        restoreFocus = document.getElementById('btnSettings') || null;
        if (sw.focus) sw.focus({ preventScroll: true });
      }
    }, { order: 15 });
  },
};
