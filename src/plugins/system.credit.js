// ══════════════════════════════════════════════════════════
// 系统插件：学分与实验室管理员
//
//   正确做实验 → 加分（成就体系，一次性解锁）
//   弄坏仪器   → 扣分（由 xiaomo.rules.damage 抛事件）
//   学分归零   → 管理员把你踢出实验室
//   重启之后   → 学分与实验进度一切复原（不落盘、不追责）
//
// 定位：**娱乐性玩法，不是实验的一部分**。所以它是一个可以整个关掉的内置插件
// （设置面板 →「学分系统（娱乐）」）。关掉之后损坏照旧发生，只是不再计分、不再请人出去。
// ══════════════════════════════════════════════════════════

import { bus, EV } from '../core/bus.js';
import { installLongPress, hasCoarsePointer } from '../ui/touch.js';

export const MAX_CREDIT = 100;

/** 成就：达成即加分，只加一次 */
const ACHIEVEMENTS = [
  { id: 'first-wire', name: '第一次连线', credit: 3, hint: '用导线把两件器材连起来',
    check: (app, w) => w.wires.length >= 1 },
  { id: 'closed-circuit', name: '接通闭合电路', credit: 4, hint: '让电流真正流起来',
    check: (app) => !!(app.lastCircuit && app.lastCircuit.closed) },
  { id: 'multi-domain', name: '理化同台', credit: 6, hint: '让物理器材和化学器材同时出现在实验台上',
    check: (app, w) => w.ofDomain('physics').length > 0 && w.ofDomain('chemistry').length > 0 },
  { id: 'first-reaction', name: '第一次反应', credit: 5, hint: '让两种药品发生反应',
    check: (app, w) => w.entities.some(e => e.vessel && e.vessel.reactions && e.vessel.reactions.length > 0) },
  { id: 'precipitate', name: '做出沉淀', credit: 5, hint: '生成一种难溶物',
    check: (app, w) => w.entities.some(e => e.vessel && e.vessel.precip.size > 0) },
  { id: 'gas-collect', name: '收集到气体', credit: 5, hint: '让反应放出气体',
    check: (app, w) => w.entities.some(e => e.vessel && [...e.vessel.gas.values()].some(v => v > 1e-5)) },
  { id: 'neutral', name: '调到中性', credit: 6, hint: '把溶液 pH 调到 7 附近',
    check: (app, w) => w.entities.some(e => e.vessel && e.vessel.volume > 10 && Math.abs(e.vessel.pH() - 7) < 0.6) },
  { id: 'heat-60', name: '加热到 60 ℃', credit: 5, hint: '把液体加热到 60 摄氏度',
    check: (app, w) => w.entities.some(e => e.vessel && e.vessel.temp >= 60) },
  { id: 'electrolysis', name: '电解水 2:1', credit: 8, hint: '通电让水分解出氢气和氧气',
    check: (app, w) => w.entities.some(e => e.vessel
      && (e.vessel.gas.get('H2') || 0) > 1e-5 && (e.vessel.gas.get('O2') || 0) > 1e-5) },
  { id: 'galvanic-light', name: '化学能点灯', credit: 8, hint: '用原电池点亮小灯泡',
    check: (app, w) => w.ofType('lamp').some(l => Math.abs(l.state.P || 0) > 1e-3) },
  { id: 'thermistor-loop', name: '温度的闭环', credit: 8, hint: '让热敏电阻读到容器的温度',
    check: (app, w) => w.ofType('thermistor').some(t => t.state.source && t.state.source !== '室温') },
  { id: 'stir-dissolve', name: '搅拌加速溶解', credit: 4, hint: '用玻璃棒搅拌溶液',
    check: (app, w) => w.entities.some(e => e.vessel && e.vessel.stir > 0.2) },
];

export class CreditSystem {
  constructor(app) {
    this.app = app;
    this.max = MAX_CREDIT;
    this.value = MAX_CREDIT;
    this.earned = 0;
    this.lost = 0;
    this.enabled = true;
    this.expelled = false;
    this.unlocked = new Map();          // 成就 id -> 解锁时间
    this.history = [];                  // 最近变动
    this.acc = 0;
    this.onAchievement = null;          // 由 setup 接到独立成就浮层上（见 §2-C1 C7）
  }

  get percent() { return Math.max(0, Math.min(1, this.value / this.max)); }

  award(n, why) {
    if (!this.enabled || this.expelled) return;
    this.value = Math.min(this.max, this.value + n);
    this.earned += n;
    this._record(n, why);
  }

  penalty(n, why) {
    if (!this.enabled || this.expelled) return;
    this.value -= n;
    this.lost += n;
    this._record(-n, why);
    if (this.value <= 0) {
      this.value = 0;
      this.expel();
    }
  }

  _record(delta, why) {
    this.history.unshift({ delta, why, t: this.app.world ? this.app.world.time : 0, value: this.value });
    if (this.history.length > 60) this.history.pop();
    bus.emit('credit:changed', { value: this.value, delta, why });
  }

  expel() {
    if (this.expelled) return;
    this.expelled = true;
    bus.emit('credit:expelled', {
      lost: this.lost,
      reason: '你在实验过程中多次损坏仪器，学分已经扣完。',
    });
  }

  /** 重启后一切复原：学分回满，损坏的仪器修好，场景清空 */
  reset(hard = true) {
    this.value = this.max;
    this.earned = 0;
    this.lost = 0;
    this.expelled = false;
    this.unlocked.clear();
    this.history.length = 0;
    if (hard && this.app.world) {
      this.app.world.clear();
      if (this.app.clearWires) this.app.clearWires();
    }
    bus.emit('credit:changed', { value: this.value, delta: 0, why: '重新开始' });
  }

  /** 每 0.4 秒检查一次成就 */
  tick(dt) {
    if (!this.enabled || this.expelled) return;
    this.acc += dt;
    if (this.acc < 0.4) return;
    this.acc = 0;
    const app = this.app, w = app.world;
    for (const a of ACHIEVEMENTS) {
      if (this.unlocked.has(a.id)) continue;
      let hit = false;
      try { hit = !!a.check(app, w); } catch (e) { /* 成就判定出错不影响实验 */ }
      if (!hit) continue;
      this.unlocked.set(a.id, w.time);
      this.award(a.credit, `达成「${a.name}」`);
      this.app.log.push('ok', `🎓 成就解锁「${a.name}」 +${a.credit} 学分`);
      // 成就走独立浮层（罕见、值得庆祝），不复用每天数十次的 #toast
      if (this.onAchievement) this.onAchievement(a.name, a.credit);
      else this.app.toast(`🎓 ${a.name} +${a.credit} 学分`, 'ok');
    }
  }
}

// ─────────────────────────────────────────────────────────
// 成就浮层样式（§2-C1 C7）
//
// styles/main.css 由工作包 A 独占，所以这里按本项目的插件化做法
// 由插件自己往 document.head 注入一个 <style>。颜色、圆角、阴影、
// 时长、曲线**全部走主题 CSS 变量**，因此深浅双模自动正确、也不写死颜色。
// ─────────────────────────────────────────────────────────

const ACH_STYLE_ID = 'xiaomo.ach-fx-style';
const ACH_HOLD = 3600;        // 驻留时长：明显长于日常 toast 的 2.4s

const ACH_CSS = `
.ach-fx-root{
  position:fixed; left:50%; top:13%; z-index:70; transform:translateX(-50%);
  display:flex; flex-direction:column; align-items:center; gap:8px; pointer-events:none;
}
.ach-fx{
  display:flex; align-items:center; gap:12px; padding:13px 22px;
  border-radius:var(--radius); background:var(--surface); color:var(--text);
  border:1px solid var(--accent-line); box-shadow:var(--shadow);
  opacity:0; transform:translateY(-12px) scale(.95);
  transition:opacity var(--t-slow) var(--ease-out), transform var(--t-slow) var(--ease-out);
}
.ach-fx.in{opacity:1; transform:translateY(0) scale(1)}
.ach-fx-ico{font-size:24px; line-height:1}
.ach-fx-body{display:flex; flex-direction:column; gap:2px; text-align:left}
.ach-fx-name{font-size:13.5px; font-weight:600; letter-spacing:.2px}
.ach-fx-sub{font-size:11px; color:var(--text-2)}
.ach-fx-num{font-size:13px; font-weight:600; color:var(--accent); font-variant-numeric:tabular-nums}
@media (prefers-reduced-motion: reduce){
  .ach-fx{transform:none; transition:opacity var(--t-fast) ease}
  .ach-fx.in{transform:none}
}
`;

/** 注入一次即可：按 id 去重，重复 setup 不会叠加多个 style 标签 */
function injectAchStyle() {
  if (typeof document === 'undefined' || !document.head) return;
  if (document.getElementById(ACH_STYLE_ID)) return;
  const s = document.createElement('style');
  s.id = ACH_STYLE_ID;
  s.textContent = ACH_CSS;
  document.head.appendChild(s);
}

/** 把机器可读的过渡时长换算成毫秒（计算值通常是 0.2s，也兼容 200ms 写法） */
function cssMs(v) {
  const n = parseFloat(v) || 0;
  return /ms\s*$/.test(String(v).trim()) ? n : n * 1000;
}

/** 面板/遮罩上最长的过渡时长 + 一帧余量（兜底超时，不是过渡时长本身） */
function exitMs(root) {
  let max = 0;
  for (const el of [root, root.firstElementChild]) {
    if (!el) continue;
    for (const d of getComputedStyle(el).transitionDuration.split(',')) max = Math.max(max, cssMs(d));
  }
  return max + 80;
}

export default {
  id: 'xiaomo.system.credit',
  name: '学分系统（娱乐）',
  version: '1.0.0',
  kind: 'system',
  desc: '娱乐性玩法：正确实验加分、损坏仪器扣分，扣完由实验室管理员把你请出去。可在「设置」里随时关掉，关掉后不再计分',
  author: '小墨实验室',
  builtin: true,
  tags: ['学分', '成就', '管理员', '娱乐'],
  requires: ['xiaomo.rules.damage'],
  setup(ctx) {
    const app = ctx.app;
    const credit = new CreditSystem(app);
    app.credit = credit;

    // 停用要把这套东西拆干净。宿主只自动回收经 ctx.slot / ctx.onDispose 登记的东西，
    // 而 app.addTick、bus.on、app.credit 都是直接挂在原对象上的（ctx.app / ctx.bus 就是原对象），
    // 不登记的话关掉之后计时器还在跑、成就还会弹、app.credit 还留着个死对象。
    const busUnsubs = [];
    ctx.onDispose(app.addTick((dt) => credit.tick(dt)));
    ctx.onDispose(() => {
      if (app.credit === credit) app.credit = null;      // 「关了」就得真的不是可用对象
      if (achRoot) { achRoot.remove(); achRoot = null; }
      for (const off of busUnsubs.splice(0)) { try { off(); } catch { /* 已解绑 */ } }
    });

    // ── 成就浮层：居中偏上、带 🎓 与学分数字，比日常提示停留更久（C7）──
    let achRoot = null;
    const showAchievement = (name, gain) => {
      if (typeof document === 'undefined' || !document.body) return;
      injectAchStyle();
      if (!achRoot) {
        achRoot = document.createElement('div');
        achRoot.className = 'ach-fx-root';
        achRoot.setAttribute('role', 'status');
        achRoot.setAttribute('aria-live', 'polite');
        document.body.appendChild(achRoot);
      }
      const card = document.createElement('div');
      card.className = 'ach-fx';
      card.innerHTML = `
        <span class="ach-fx-ico" aria-hidden="true">🎓</span>
        <span class="ach-fx-body">
          <span class="ach-fx-name"></span>
          <span class="ach-fx-sub">成就解锁</span>
        </span>
        <span class="ach-fx-num"></span>`;
      card.querySelector('.ach-fx-name').textContent = name;
      card.querySelector('.ach-fx-num').textContent = '+' + gain + ' 学分';
      achRoot.appendChild(card);
      void card.offsetWidth;                 // 结算起点，入场位移与淡入才会播
      card.classList.add('in');

      setTimeout(() => {
        card.classList.remove('in');
        let out = 0;
        for (const d of getComputedStyle(card).transitionDuration.split(',')) out = Math.max(out, cssMs(d));
        const drop = () => card.remove();
        card.addEventListener('transitionend', (e) => { if (e.target === card) drop(); }, { once: true });
        setTimeout(drop, out + 80);          // 兜底超时，同样由退场时长推出
      }, ACH_HOLD);
    };
    credit.onAchievement = showAchievement;

    // 损坏 → 扣分
    const onBroken = (info) => {
      credit.penalty(info.cost || 5, info.reason);
      app.log.push('danger', `💥 ${info.reason}（-${info.cost} 学分）`);
    };
    bus.on('equipment:broken', onBroken);
    busUnsubs.push(() => bus.off('equipment:broken', onBroken));

    // ── 学分徽章：挂在顶栏右侧 ──
    ctx.slot('topbar.right', (host) => {
      const el = document.createElement('div');
      el.className = 'credit-badge';
      el.title = '学分（娱乐功能，可在设置中关闭）：正确实验会加分，损坏仪器会扣分 · 右键或长按打开设置';
      // 徽章是最显眼的位置，右键直达设置能省掉「先去找 ⚙」这一步。
      // ⚠ 触屏没有右键，所以下面还要补一条长按路径；两者**走同一个入口**：
      // 都只是派发 xiaomo:settings，没有第二份「打开设置」的逻辑。
      const openSettings = () => {
        window.dispatchEvent(new CustomEvent('xiaomo:settings', { detail: true }));
      };
      el.addEventListener('contextmenu', (ev) => {
        ev.preventDefault();
        openSettings();
      });
      // 触屏长按 = 桌面右键。复用 src/ui/touch.js 的公共长按识别器，
      // 不在这里另写一套（阈值/取消语义必须是同一份，否则第二处会漂移）。
      // ownOrigin:false —— 那个识别器默认会跳过 .credit-badge 上的手势，
      // 那是为了不让「主题圆钮的长按」误接管徽章；徽章**自己**来装就必须关掉它。
      // pressScale —— 粗指针上按下时徽章缩一下，否则长按期间完全没有可见反馈。
      installLongPress(el, openSettings, {
        ownOrigin: false,
        pressScale: 0.9,
        hasCoarsePointer,
      });
      el.innerHTML = `
        <span class="credit-ico">🎓</span>
        <span class="credit-num">100</span>
        <span class="credit-bar"><i></i></span>`;
      const num = el.querySelector('.credit-num');
      const bar = el.querySelector('.credit-bar i');
      const paint = () => {
        num.textContent = String(Math.round(credit.value));
        const p = credit.percent;
        bar.style.width = (p * 100).toFixed(1) + '%';
        el.classList.toggle('low', p <= 0.3);
        el.classList.toggle('mid', p > 0.3 && p <= 0.6);
      };
      busUnsubs.push(bus.on('credit:changed', paint));
      paint();
      host.appendChild(el);
    }, { order: 10 });

    // ── 管理员弹窗 ──
    ctx.slot('overlay', (host) => {
      const mask = document.createElement('div');
      mask.className = 'expel-mask';
      mask.innerHTML = `
        <div class="expel-card" role="alertdialog" aria-modal="true">
          <div class="expel-ico">🚪</div>
          <h2>你被实验室管理员踢出了实验室</h2>
          <p class="expel-msg"></p>
          <p class="expel-sub">学分已经扣完。重启实验室后，学分与实验进度会全部复原。</p>
          <div class="expel-stats"></div>
          <button class="expel-btn" type="button">重新进入实验室</button>
        </div>`;
      const stats = mask.querySelector('.expel-stats');
      const msg = mask.querySelector('.expel-msg');

      // ── 浮层时序与焦点（§2-C1 C1 / C8）──────────────────
      // 退场时长不写死（原来是 220ms）：读遮罩与面板的计算过渡时长，
      // 并以 transitionend 为主信号，§2-A12 调过时长后这里自动跟随。
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
        if (document.querySelector('.drawer-mask.show,.expel-mask.show,.about-mask.show')) return;
        if (canInert) shell.inert = false; else shell.removeAttribute('aria-hidden');
      };
      const giveBackFocus = () => {
        if (restoreFocus && restoreFocus.focus) restoreFocus.focus({ preventScroll: true });
        restoreFocus = null;
      };

      const show = (info) => {
        msg.textContent = info.reason;
        stats.innerHTML = `
          <span>累计获得 <b>+${credit.earned}</b></span>
          <span>累计扣除 <b>-${credit.lost}</b></span>
          <span>解锁成就 <b>${credit.unlocked.size}</b></span>`;
        cancelClose();
        restoreFocus = document.activeElement;
        const wasHidden = !mask.classList.contains('show');
        if (wasHidden) mask.classList.remove('in');
        mask.classList.add('show');
        void mask.offsetWidth;          // 立刻结算起点，弹窗的缩放淡入才会播
        mask.classList.add('in');
        lockBg();
        const btn = mask.querySelector('.expel-btn');
        if (btn && btn.focus) btn.focus({ preventScroll: true });
      };
      busUnsubs.push(bus.on('credit:expelled', show));

      /** 关闭并在退场结束后执行 after（after 在未打开时也会执行，避免状态卡住） */
      const close = (after) => {
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
          giveBackFocus();
          if (after) after();
        };
        const onEnd = (e) => {
          if (e.target !== mask && !mask.contains(e.target)) return;
          if (e.propertyName !== 'transform' && e.propertyName !== 'opacity') return;
          finish();
        };
        mask.addEventListener('transitionend', onEnd);
        closing = setTimeout(finish, wait);
      };

      mask.querySelector('.expel-btn').addEventListener('click', () => {
        close(() => {
          credit.reset(true);
          if (app.hideHint) app.hideHint();
          app.toast('学分与实验进度已复原，请重新开始实验', 'ok');
        });
      });

      host.appendChild(mask);
    }, { order: 80 });

    app.log.push('sys', `学分系统已启用（初始 ${MAX_CREDIT} 分，成就 ${ACHIEVEMENTS.length} 项）`);
  },
};
