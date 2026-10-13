// ══════════════════════════════════════════════════════════
// UI · 日志面板
// 化学反应、耦合事件、电路状态都汇到这里，带时间戳与域着色。
// ══════════════════════════════════════════════════════════

const MAX = 400;

export class LogPanel {
  constructor(el, app) {
    this.el = el;
    this.app = app;
    this.count = 0;
  }

  push(domain, msg, t) {
    const row = document.createElement('div');
    row.className = 'lg ' + (domain || 'sys');

    const ts = document.createElement('span');
    ts.className = 't';
    ts.textContent = fmtTime(t ?? this.app.world.time);
    row.appendChild(ts);

    const m = document.createElement('span');
    m.className = 'm';
    m.textContent = msg;
    row.appendChild(m);

    const atBottom = this.el.scrollTop + this.el.clientHeight >= this.el.scrollHeight - 24;
    this.el.appendChild(row);
    this.count++;

    while (this.el.childElementCount > MAX) {
      this.el.removeChild(this.el.firstElementChild);
      this.count--;
    }
    if (atBottom) this.el.scrollTop = this.el.scrollHeight;
  }

  clear() {
    this.el.replaceChildren();
    this.count = 0;
  }
}

function fmtTime(sec) {
  const s = Math.max(0, sec || 0);
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return `${String(m).padStart(2, '0')}:${r.toFixed(1).padStart(4, '0')}`;
}
