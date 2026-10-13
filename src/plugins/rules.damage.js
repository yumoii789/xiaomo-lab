// ══════════════════════════════════════════════════════════
// 规则插件：仪器损坏
//
// 每一条都是真实实验里会发生的操作事故：
//   电流表过载烧表头、电压表超量程击穿、灯泡超功率烧灯丝、
//   电热丝过载熔断、干电池短路损坏、电动机堵转过热、
//   玻璃器皿干烧炸裂、电路短路。
//
// 命中的器材会被标记 broken —— 电路求解器随后把它当作开路，
// 反应和耦合也随之失效。扣多少学分由规则自己声明。
// ══════════════════════════════════════════════════════════

const RULES = [
  {
    id: 'meter-overload',
    name: '电表过载',
    check(e) {
      if (e.type !== 'ammeter' && e.type !== 'voltmeter') return null;
      const isA = e.type === 'ammeter';
      const fs = Number(e.props.fullScale) || (isA ? 0.6 : 3);
      const v = Math.abs(isA ? (e.state.I || 0) : (e.state.U || 0));
      if (v > fs * 1.5) {
        return {
          cost: 6,
          reason: `${e.def.name}：${v.toFixed(2)} ${isA ? 'A' : 'V'} 超过量程 ${fs} ${isA ? 'A' : 'V'} 的 1.5 倍，表头烧毁`,
        };
      }
      return null;
    },
  },
  {
    id: 'lamp-burnout',
    name: '灯丝烧断',
    check(e) {
      if (e.type !== 'lamp') return null;
      const rated = Number(e.props.ratedP) || 0.75;
      const P = Math.abs(e.state.P || 0);
      if (P > rated * 1.8) {
        return { cost: 4, reason: `小灯泡：实际功率 ${P.toFixed(2)} W 超过额定 ${rated} W，灯丝烧断` };
      }
      return null;
    },
  },
  {
    id: 'heater-burnout',
    name: '电热丝熔断',
    check(e) {
      if (e.type !== 'heater') return null;
      const maxP = Number(e.props.maxP) || 20;
      const P = Math.abs(e.state.P || 0);
      if (P > maxP * 1.5) {
        return { cost: 5, reason: `电热丝：功率 ${P.toFixed(1)} W 超过额定 ${maxP} W，熔断` };
      }
      return null;
    },
  },
  {
    id: 'battery-damage',
    name: '电源损坏',
    check(e) {
      if (e.type !== 'battery') return null;
      const I = Math.abs(e.state.I || 0);
      if (I > 3) {
        return { cost: 8, reason: `干电池：放电电流 ${I.toFixed(2)} A 过大，电池损坏` };
      }
      return null;
    },
  },
  {
    id: 'motor-burn',
    name: '电动机烧毁',
    check(e) {
      if (e.type !== 'motor') return null;
      const rated = Number(e.props.ratedI) || 0.6;
      const I = Math.abs(e.state.I || 0);
      if (I > rated * 2) {
        return { cost: 6, reason: `电动机：电流 ${I.toFixed(2)} A 超过额定 ${rated} A 的 2 倍，线圈烧毁` };
      }
      return null;
    },
  },
  {
    id: 'glass-dry-burn',
    name: '玻璃干烧炸裂',
    check(e) {
      if (!e.vessel) return null;
      const v = e.vessel;
      // 干烧：里面几乎没液体，却还在持续吸热
      if (v.volume < 4 && (v.heatIn || 0) > 15) {
        return { cost: 10, reason: `${e.def.name}：里面没有液体却在加热，玻璃受热不均炸裂` };
      }
      if (v.temp > 300) {
        return { cost: 10, reason: `${e.def.name}：温度 ${v.temp.toFixed(0)} ℃，玻璃软化变形` };
      }
      return null;
    },
  },
  {
    id: 'glass-thermal-shock',
    name: '骤冷骤热炸裂',
    check(e) {
      if (!e.vessel) return null;
      const v = e.vessel;
      const last = e._lastTemp;
      e._lastTemp = v.temp;
      if (last == null) return null;
      if (Math.abs(v.temp - last) > 40) {
        return { cost: 10, reason: `${e.def.name}：温度瞬间变化 ${Math.abs(v.temp - last).toFixed(0)} ℃，玻璃炸裂` };
      }
      return null;
    },
  },
];

export default {
  id: 'xiaomo.rules.damage',
  name: '仪器损坏规则',
  version: '1.0.0',
  kind: 'rules',
  desc: '过流烧表、超量程击穿、灯丝烧断、电热丝熔断、电源损坏、玻璃干烧炸裂、骤冷骤热',
  author: '小墨实验室',
  builtin: true,
  tags: ['规则', '安全', '学分'],
  requires: [],
  setup(ctx) {
    const app = ctx.app;

    ctx.scope('damage', () => {
      for (const r of RULES) ctx.damage.define({ id: r.id, name: r.name, check: r.check });
    });

    const breakIt = (e, hit) => {
      if (e.state.broken) return;
      e.state.broken = true;
      e.state.brokenReason = hit.reason;
      e.state.brokenAt = app.world.time;
      e.state.I = 0; e.state.U = 0; e.state.P = 0;
      ctx.bus.emit('equipment:broken', {
        id: e.id, type: e.type, name: e.def ? e.def.name : e.type,
        reason: hit.reason, cost: hit.cost,
      });
    };

    let acc = 0;
    app.addTick((dt) => {
      acc += dt;
      if (acc < 0.2) return;              // 每秒检查 5 次足够
      acc = 0;

      const world = app.world;
      const list = ctx.damage.list();
      for (const e of world.entities) {
        if (e.state.broken) continue;
        for (const r of list) {
          let hit = null;
          try { hit = r.check(e, world, app.lastCircuit); } catch (err) { /* 规则自身出错不该拖垮实验台 */ }
          if (hit) { breakIt(e, hit); break; }
        }
      }

      // 整个电路被短接：找到回路里的电源并扣分
      const c = app.lastCircuit;
      if (c && c.shorted && !app._shortWarned) {
        app._shortWarned = true;
        for (const e of world.ofType('battery')) {
          if (!e.state.broken) {
            breakIt(e, { cost: 8, reason: '电路被短接：电源正负极直接连通，电流过大烧毁电池' });
          }
        }
      } else if (c && !c.shorted) {
        app._shortWarned = false;
      }
    });

    app.log.push('sys', `安全规则已加载：${RULES.length} 条损坏判定`);
  },
};
