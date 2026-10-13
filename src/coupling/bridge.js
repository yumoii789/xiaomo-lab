// ══════════════════════════════════════════════════════════
// 耦合总线 —— 物理域 ⟷ 化学域的双向通道
//
// 这是「小墨实验室」区别于任何单一学科实验软件的地方。
// 它做三件事：
//
//   ① 空间识别：谁插在谁里面（电极插进烧杯、电热丝浸入液体）
//   ② 造电路：把「溶液」变成电路里的一条电阻支路，
//             把「两种金属插在电解液里」变成一只电池
//   ③ 搬运能量：电流 → 电解速率 / 焦耳热；
//             反应热 → 溶液温度 → 热敏电阻阻值 → 电流变化（闭环）
//
// 于是形成了两个互逆的过程：
//   电解     ：电能 → 化学能     （物理驱动化学）
//   原电池   ：化学能 → 电能     （化学驱动物理）
// ══════════════════════════════════════════════════════════

import { SP } from '../chemistry/species.js';
import { bus, EV } from '../core/bus.js';

const CONTACT_R = 26;      // 探头插入判定的宽容距离

export class CouplingBus {
  constructor(world) {
    this.world = world;
    this.links = [];         // [{ probe, container }]
    this.branches = [];      // 本帧生成的虚拟电路支路
    this.activeCount = 0;
    this._lastEvent = new Map();
  }

  // ══════════ ① 空间识别 ══════════
  scan() {
    const containers = this.world.entities.filter(e => e.vessel);
    const probes = this.world.entities.filter(e => e.probe);
    const links = [];

    for (const p of probes) {
      let best = null, bd = Infinity;
      for (const c of containers) {
        const z = c.insertZone ? c.insertZone() : {
          x: c.x - c.w / 2, y: c.y - c.h / 2, w: c.w, h: c.h,
        };
        const inside = p.x >= z.x - CONTACT_R && p.x <= z.x + z.w + CONTACT_R
          && p.y >= z.y - CONTACT_R && p.y <= z.y + z.h + CONTACT_R;
        if (!inside) continue;
        const d = Math.hypot(p.x - c.x, p.y - c.y);
        if (d < bd) { bd = d; best = c; }
      }
      if (best) links.push({ probe: p, container: best });
    }
    this.links = links;
    this.activeCount = links.length;
    return links;
  }

  probesIn(container, kind) {
    return this.links
      .filter(L => L.container === container && (!kind || L.probe.probe.kind === kind))
      .map(L => L.probe);
  }

  // ══════════ ② 造电路 ══════════
  buildBranches() {
    this.scan();
    const branches = [];

    // 按容器分组所有电极
    const byVessel = new Map();
    for (const L of this.links) {
      if (L.probe.probe.kind !== 'electrode') continue;
      if (!byVessel.has(L.container)) byVessel.set(L.container, []);
      byVessel.get(L.container).push(L.probe);
    }

    for (const [container, electrodes] of byVessel) {
      const v = container.vessel;
      v.electrodes = electrodes.map(e => e.id);

      if (electrodes.length < 2) continue;

      const [a, b] = electrodes;
      const R = v.resistance();

      // ── 原电池支路：两种活泼性不同的金属 + 电解液 ──
      // 它的内阻本身就是溶液电阻，所以一旦成立就不再另加溶液支路
      let galvanic = false;
      const metals = electrodes.filter(e => e.probe.E0 !== null && e.probe.E0 !== undefined);
      if (metals.length >= 2 && v.ionConc() > 0.05) {
        let low = metals[0], high = metals[0];
        for (const m of metals) {
          if (m.probe.E0 < low.probe.E0) low = m;
          if (m.probe.E0 > high.probe.E0) high = m;
        }
        const emf = high.probe.E0 - low.probe.E0;
        if (emf > 0.05) {
          galvanic = true;
          branches.push({
            key: 'cell:' + container.id,
            a: { e: high.id, p: 0 }, b: { e: low.id, p: 0 },   // 高电位为正极
            type: 'V', emf, r: Math.max(0.5, (isFinite(R) ? R : 20) * 0.6),
            state: {},
            tag: 'galvanic',
            metals: [high.probe.metal, low.probe.metal],
          });
        }
      }

      // ── 溶液电阻支路：任何两根电极浸在同一杯液体里都导通（电解靠它） ──
      if (!galvanic && isFinite(R) && R > 0 && v.volume > 0) {
        branches.push({
          key: 'sol:' + container.id,
          a: { e: a.id, p: 0 }, b: { e: b.id, p: 0 },
          type: 'R', r: Math.min(R, 2e6),
          state: {},
          tag: 'solution',
        });
      }
    }

    this.branches = branches;
    return branches;
  }

  // ══════════ ③ 搬运能量 ══════════
  /** 在电路求解之后调用，把结果分发到化学域 / 传感器 */
  distribute(dt, circuit) {
    const world = this.world;

    // 清空上一帧的电极登记
    for (const e of world.entities) {
      if (e.vessel) { e.vessel.electrodes = []; e.vessel.electricCurrent = 0; }
    }

    // ── 容器：电极 / 电热丝 / 温度计 / pH 计 / 搅拌 ──
    for (const L of this.links) {
      const v = L.container.vessel;
      const p = L.probe;
      const kind = p.probe.kind;

      if (kind === 'electrode') {
        if (!v.electrodes.includes(p.id)) v.electrodes.push(p.id);
      } else if (kind === 'heater') {
        const rec = circuit.branches.get(p.id);
        const P = rec ? Math.abs(rec.P) : 0;
        p.state.heatOut = P;
        if (P > 0) v.addHeat(P * dt);
      } else if (kind === 'thermometer') {
        p.state.temp = v.temp;
      } else if (kind === 'ph') {
        p.state.pH = v.pH();
        p.state.color = v.color;
      } else if (kind === 'stirrer') {
        const on = p.state.on;
        if (on) v.stir = Math.min(2, v.stir + 1.2);
        p.state.stir = v.stir;
      }
    }

    // ── 溶液电流 → 电解 ──
    for (const [key, rec] of circuit.branches) {
      if (!key.startsWith('sol:')) continue;
      const container = world.get(key.slice(4));
      if (container && container.vessel) {
        container.vessel.electricCurrent = Math.abs(rec.I);
        container.vessel.currentU = rec.U;
      }
    }
    // 原电池：把化学能产生的电流回写到电极
    for (const [key, rec] of circuit.branches) {
      if (!key.startsWith('cell:')) continue;
      const container = world.get(key.slice(5));
      if (!container) continue;
      const br = this.branches.find(b => b.key === key);
      this._fire('galvanic:' + container.id,
        `原电池工作：${br?.metals?.[0] ?? '?'}｜${br?.metals?.[1] ?? '?'} 产生 ${rec.U.toFixed(2)} V、${(rec.I * 1000).toFixed(0)} mA`,
        'bridge');
    }

    // ── 酒精灯 → 上方容器 ──
    for (const lamp of world.entities) {
      if (!lamp.flame) continue;
      if (!lamp.props.lit) { lamp.state.target = null; continue; }
      const fx = lamp.x, fy = lamp.y - lamp.h * 0.9;
      let best = null, bd = Infinity;
      for (const c of world.entities) {
        if (!c.vessel) continue;
        const z = c.insertZone ? c.insertZone() : { x: c.x - c.w / 2, y: c.y - c.h / 2, w: c.w, h: c.h };
        const cx = Math.max(z.x, Math.min(fx, z.x + z.w));
        const cy = Math.max(z.y, Math.min(fy, z.y + z.h));
        const d = Math.hypot(fx - cx, fy - cy);
        if (d < 26 && d < bd) { bd = d; best = c; }
      }
      if (best) {
        best.vessel.addHeat(lamp.props.power * dt);
        lamp.state.target = best.id;
        this._fire('boil:' + lamp.id + ':' + best.id,
          `加热中：${best.def.name} 温度 ${best.vessel.temp.toFixed(1)} ℃`, 'bridge');
      } else {
        lamp.state.target = null;
      }
    }

    // ── 热敏电阻读数 ← 最近的容器温度（闭环的关键一步） ──
    for (const t of world.entities) {
      if (t.type !== 'thermistor') continue;
      let best = null, bd = 150;
      for (const c of world.entities) {
        if (!c.vessel) continue;
        const d = Math.hypot(t.x - c.x, t.y - c.y);
        if (d < bd) { bd = d; best = c; }
      }
      t.state.temp = best ? best.vessel.temp : 25;
      t.state.source = best ? best.def.name : '室温';
      if (best && best.vessel.temp > 40) {
        this._fire('th:' + t.id, `热敏电阻感受到 ${best.vessel.temp.toFixed(1)} ℃，阻值降至 ${Math.round(t.resistanceNow())} Ω`, 'bridge');
      }
    }

    // ── 电动机 → 邻近容器搅拌 ──
    for (const m of world.entities) {
      if (m.type !== 'motor') continue;
      if (!m.state.on) continue;
      for (const c of world.entities) {
        if (!c.vessel) continue;
        if (Math.hypot(m.x - c.x, m.y - c.y) < 160) {
          c.vessel.stir = Math.min(2, c.vessel.stir + 1.0);
          m.state.stirTarget = c.id;
        }
      }
    }

    // 搅拌随时间衰减
    for (const c of world.entities) {
      if (c.vessel) c.vessel.stir *= Math.pow(0.02, dt);
    }

    // ── 天平称量上方容器 ──
    for (const bal of world.entities) {
      if (bal.type !== 'balance') continue;
      const plateY = bal.y - bal.h * 0.35;
      let total = 0, names = [];
      for (const c of world.entities) {
        if (!c.vessel) continue;
        const dx = Math.abs(c.x - bal.x);
        const dy = Math.abs(c.y - plateY);
        if (dx < bal.w * 0.55 && dy < 40) {
          const m = c.vessel.totalMass() + (c.props.tare || 0);
          total += m;
          names.push(c.def.name);
        }
      }
      if (bal.state.onPlate !== names.join(',')) {
        bal.state.onPlate = names.join(',');
      }
      bal.state.mass = total;         // g
    }
  }

  /** 事件去重（同一条耦合 2.5 秒内只播报一次） */
  _fire(key, msg, domain) {
    const t = this.world.time;
    const last = this._lastEvent.get(key);
    if (last !== undefined && t - last < 2.5) return;
    this._lastEvent.set(key, t);
    bus.emit(EV.COUPLING, { key, msg, domain });
  }

  /** 给 UI 用：当前所有活跃耦合的说明 */
  describe() {
    const out = [];
    for (const b of this.branches) {
      if (b.tag === 'solution') out.push('溶液导电支路');
      if (b.tag === 'galvanic') out.push(`原电池 ${b.metals?.join('|')} ${b.emf.toFixed(2)}V`);
    }
    for (const L of this.links) {
      out.push(`${L.probe.def.name} → ${L.container.def.name}`);
    }
    return out;
  }
}

// ── 插件 ──────────────────────────────────────────────────
export default {
  id: 'xiaomo.coupling.bridge',
  name: '跨域耦合总线',
  version: '1.0.0',
  kind: 'core',
  desc: '把溶液与原电池送进电路、把电流送进化学、把热量送进容器、把温度送回电路 —— 理化互通的枢纽',
  author: '小墨实验室',
  builtin: true,
  tags: ['耦合', '跨域', '内核'],
  requires: ['xiaomo.core.physics', 'xiaomo.core.chemistry'],
  setup(ctx) {
    ctx.app.services.CouplingBus = CouplingBus;
  },
};
