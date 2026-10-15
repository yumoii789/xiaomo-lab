// ══════════════════════════════════════════════════════════
// 社区示例插件 · 器材扩充包
//
// 单文件零依赖 ESM（原因见 lab-timer.js 顶部注释：blob URL 解析不了相对 import）。
//
// 它证明一件更要紧的事：**社区插件不需要自带任何引擎代码，也能往实验台上真的加器材。**
// 做法是复用宿主已有的「器材包」服务（app.services.packs）：
// 器材包本身是纯数据（见 docs/器材包格式.md），每件器材声明自己派生自哪件已有器材，
// 行为全部继承原型，插件只负责「装上」和「拆掉」。
//
// 于是第三方扩展的能力边界被宿主钉死：能配置程序，不能改程序。
// ══════════════════════════════════════════════════════════

/** 包标识写死成常量：卸载时要拿同一个 id 去卸，不能让两次调用算出不同的值 */
const PACK = {
  format: 'xiaomo.equipment.pack',
  version: 1,
  id: 'community.equipment-booster',
  name: '器材扩充包（社区示例）',
  author: '社区示例',
  desc: '三件派生器材：高压电池、宽口烧杯、定值电阻',
  equipment: [
    {
      type: 'community-9v-battery',
      proto: 'battery',
      name: '9V 层叠电池',
      desc: '电动势更高的干电池，内阻也更大 —— 用来观察内阻对端电压的影响',
      icon: '🔋',
      defaults: { emf: 9, internalR: 1.5 },
      tags: ['社区', '电源'],
    },
    {
      type: 'community-wide-beaker',
      proto: 'beaker',
      name: '宽口烧杯 500 mL',
      desc: '容量更大的烧杯，适合做稀释与溶解',
      icon: '🧪',
      w: 92,
      h: 84,
      defaults: { capacity: 500 },
      tags: ['社区', '玻璃器皿'],
    },
    {
      type: 'community-r50',
      proto: 'resistor',
      name: '定值电阻 50 Ω',
      desc: '实验常用的整数阻值，方便手算校验电流',
      icon: '🟫',
      defaults: { resistance: 50 },
      tags: ['社区', '电学'],
    },
  ],
};

export default {
  id: 'xiaomo.community.equipment-booster',
  name: '器材扩充包',
  version: '1.0.0',
  kind: 'equipment',
  desc: '往器材面板里加三件派生器材（纯数据，不改一行程序）',
  author: '社区示例',
  builtin: false,
  tags: ['社区', '器材', '扩展'],
  setup(ctx) {
    // 器材包服务由内置的 system.pack 插件提供。缺失时如实说明并安静退出 ——
    // 社区插件的依赖是「宿主能力」，能力不在就该降级，而不是把整个装载流程搞崩。
    const packs = ctx.app && ctx.app.services && ctx.app.services.packs;
    if (!packs) {
      ctx.log('器材扩充包：宿主没有提供器材包服务（system.pack 未启用），本次不生效');
      ctx.toast('器材扩充包：宿主缺少器材包服务，未生效', 'warn');
      return;
    }

    const r = packs.install(PACK, { silent: true });   // silent：下面自己用 ctx.toast 报，避免两句提示
    if (!r.ok) {
      ctx.log(`器材扩充包装载失败：${r.error}`);
      ctx.toast(`器材扩充包装载失败：${r.error}`, 'danger');
      return;
    }

    ctx.log(`器材扩充包已装载：新增 ${r.made.length} 件器材（${r.made.join(', ')}）`);
    ctx.toast(`器材扩充包已装载，新增 ${r.made.length} 件器材`);

    // 卸载插件时把包一起卸掉：否则器材会以「无主」的形态永远留在器材面板里，
    // 用户会觉得「我明明卸了它」。
    ctx.onDispose(() => {
      try {
        packs.uninstall(PACK.id);
        ctx.log('器材扩充包已卸载');
      } catch (e) {
        console.warn('[community.equipment-booster] 卸载器材包失败', e);
      }
    });
  },
};
