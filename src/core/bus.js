// ══════════════════════════════════════════════════════════
// 事件总线 —— 内核各域之间唯一的通信通道
// 物理域、化学域、耦合总线、UI 全部通过它解耦
// ══════════════════════════════════════════════════════════

export class EventBus {
  constructor() {
    this._handlers = new Map();
    this._any = [];
  }

  /** 订阅，返回取消订阅函数 */
  on(type, fn) {
    if (!this._handlers.has(type)) this._handlers.set(type, []);
    this._handlers.get(type).push(fn);
    return () => this.off(type, fn);
  }

  once(type, fn) {
    const un = this.on(type, (p) => { un(); fn(p); });
    return un;
  }

  off(type, fn) {
    const arr = this._handlers.get(type);
    if (!arr) return;
    const i = arr.indexOf(fn);
    if (i >= 0) arr.splice(i, 1);
  }

  /** 监听所有事件（调试/日志用） */
  onAny(fn) {
    this._any.push(fn);
    return () => {
      const i = this._any.indexOf(fn);
      if (i >= 0) this._any.splice(i, 1);
    };
  }

  emit(type, payload) {
    const arr = this._handlers.get(type);
    if (arr) {
      // 复制一份，允许处理函数内部退订
      for (const fn of arr.slice()) {
        try { fn(payload); } catch (e) { console.error(`[bus] ${type}`, e); }
      }
    }
    for (const fn of this._any.slice()) {
      try { fn(type, payload); } catch { /* ignore */ }
    }
  }
}

/** 全局总线 */
export const bus = new EventBus();

/** 标准事件名 */
export const EV = {
  ENTITY_ADD: 'entity:add',
  ENTITY_REMOVE: 'entity:remove',
  ENTITY_SELECT: 'entity:select',
  ENTITY_MOVE: 'entity:move',
  ENTITY_PROP: 'entity:prop',

  WIRE_ADD: 'wire:add',
  WIRE_REMOVE: 'wire:remove',

  CIRCUIT_SOLVED: 'circuit:solved',
  REACTION: 'chem:reaction',
  COUPLING: 'coupling:fire',

  LOG: 'ui:log',
  TOAST: 'ui:toast',
  DATA: 'ui:data',
  SCENE_DIRTY: 'scene:dirty',
};
