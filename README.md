# 小墨实验室 · XiaoMo Lab

**物理器材和化学器材在同一个实验台里，而且它们能互相作用。**

电解水实验就是最好的例子：你接上电源、按下开关，电流会真的流过烧杯里的水，
电极上开始冒氢气和氧气；反过来，如果你把锌片和铜片插进溶液，它自己就变成
一个原电池，能点亮旁边的小灯泡。物理和化学在这里不是两个切换的标签页，
而是同一张桌子上的两套器材。

---

## 快速开始

### 桌面版（推荐）

需要一个 Node.js（18 以上）。之后：

```bash
cd desktop
npm install       # 首次约 100 MB，装 Electron
npm start         # 打开窗口
```

或者直接双击仓库根目录的 **`启动小墨实验室.cmd`**，它会自动检查依赖并拉起窗口。

> **国内网络提示**：Electron 的二进制默认从 GitHub 下载，经常连不上。
> `desktop/.npmrc` 里已经配好了 npmmirror 镜像，一般不需要额外操作。
> 如果 PowerShell 报「禁止运行脚本」，把 `npm` 换成 `npm.cmd`。

最低兼容 **Windows 10**；macOS 和 Linux 用同一份代码，也会走同一条路径。

### 网页版

前端是零依赖的原生 ES Module，不需要构建，但**不能直接双击 `index.html`**
（`file://` 协议下浏览器会因 CORS 拒绝加载模块）。起一个静态服务器：

```bash
node server.mjs        # 然后打开 http://127.0.0.1:7373/
```

---

## 桌面版和网页版的关系

桌面的前端代码**不在 `desktop/` 里**，桌面版复用仓库根目录的
`index.html` / `src/` / `styles/`。`desktop/` 只装 Electron 外壳：

```
desktop/
  package.json     npm 清单
  .npmrc           Electron 二进制镜像
  main.js          主进程：窗口、app:// 协议、菜单、IPC
  preload.js       预加载桥，把桌面能力挂到 window.xiaomoDesktop
  launch.mjs       一键启动器
  serve.mjs        纯调试用的静态服务器
  README.md        桌面版细节
```

前端检测到 `window.xiaomoDesktop` 才显示窗口按钮、走原生对话框；
在浏览器里这个对象不存在，`src/plugins/system.desktop.js` 会自动静默。
所以同一份前端两头都能跑，不会分叉。

---

## 架构：内核 + 一切皆插件

内核只提供插件宿主、注册表、实体/世界/引擎、主题管理器和事件总线。
**器材、界面、主题、规则全都是插件**，可以单独启停：

```js
export default {
  id: 'xiaomo.equipment.electrical',
  name: '电学器材',
  kind: 'equipment',
  requires: ['xiaomo.core.physics'],
  setup(ctx) {
    ctx.scope('equipment', () => {
      define({ type: 'battery', name: '干电池', /* … */ });
    });
  },
};
```

| 种类 | 说明 | 现有插件 |
| --- | --- | --- |
| `core` | 仿真内核 | 物理电路求解、化学反应规则 |
| `equipment` | 器材 | 电学、玻璃器皿、加热、通用实验器材 |
| `theme` | 主题皮肤 | Mint 青柠（默认）、Graphite 石墨 |
| `rules` | 规则与惩罚 | 器材损坏判定 |
| `system` | 系统功能 | 学分系统、器材包、桌面外壳 |
| `ui` | 界面 | 器材面板、属性、数据、日志、工具栏、主题开关、插件管理器 |

界面通过**插槽**拼装，插件往插槽里塞内容就行，不用改 HTML：

`topbar.brand` · `topbar.tools` · `topbar.actions` · `topbar.right` ·
`topbar.wincontrols` · `palette` · `stage.overlay` ·
`sidebar.pane.inspector` · `sidebar.pane.data` · `sidebar.pane.log` · `overlay`

点右上角的 🧩 可以看每个插件贡献了什么，并单独关掉。

---

## 器材包

器材包是**纯 JSON 数据**，不允许任何代码，所以导入别人做的包永远是安全的。
一个包可以基于已有器材派生出新器材（改参数、改外观、改默认值）：

```json
{
  "format": "xiaomo.equipment.pack",
  "version": 1,
  "id": "demo.pack",
  "name": "演示器材包",
  "equipment": [
    {
      "type": "big-battery",
      "proto": "battery",
      "name": "大号干电池",
      "desc": "电动势更高的干电池",
      "defaults": { "emf": 9, "internalR": 1.2 }
    }
  ]
}
```

`proto` 必须指向一个已注册的器材类型，派生出的器材会继承原型的行为
（渲染、电路特性、化学性质），只覆盖你写明的字段。导入、导出、卸载的
入口都在插件管理器里。

---

## 学分系统

开启后，器材损坏会扣学分，正确完成实验会加学分：

- 满分 **100**，右上角徽章实时显示
- 完成实验、正确连接、观察现象 → 加分
- 电流表超量程、灯泡烧毁、干烧玻璃器皿、骤冷炸裂 → 扣分
- 扣到 **0** 会被请出实验室，重新进入即可恢复学分和实验进度

---

## 备份

项目通过 WebDAV 定期同步，脚本在 `tools/`：

```powershell
node tools\backup-daemon.mjs --every=10   # 每 10 分钟一次
```

细节和排错见 [`tools/README-backup.md`](tools/README-backup.md)。

---

## 兼容性说明

| 项目 | 做法 |
| --- | --- |
| 最低系统 | Windows 10（不使用 Mica 等 Win11 专属接口） |
| 标题栏 | 自绘，深浅色与主题联动 |
| 圆角 / 毛玻璃 | CSS `border-radius` + `backdrop-filter` |
| 窗口状态 | 记住尺寸、位置、最大化，换屏后自动回落 |
| 动画 | 只动 `transform` / `opacity`；尊重 `prefers-reduced-motion` |

---

## 许可

MIT。物理仿真思路参考了 [PhET](https://phet.colorado.edu/)（CC-BY）与
[CircuitJS1](https://github.com/sharpie7/circuitjs1) 的公开做法。
