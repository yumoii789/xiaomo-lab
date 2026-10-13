# 小墨实验室 · 桌面版

物理与化学器材共处同一张实验台，两种器材可以相互交互。

桌面版是**一个用 npm 安装管理的 Electron 应用，不发布 exe**：装好之后敲
`xiaomo-lab` 就起窗口，也能在 macOS / Linux 上直接跑同一份代码。

---

## 一、作为 npm 包装（给使用者）

```bash
npm install -g xiaomo-lab     # 装一次，之后随处可用
xiaomo-lab                    # 打开窗口
```

不想装到全局，试一下就跑：

```bash
npx xiaomo-lab
```

会弹出一个窗口。命令行参数原样交给 Electron，例如 `xiaomo-lab --dev`
（带开发者工具）、`xiaomo-lab --help`（看用法，不弹窗）。

> **国内网络**：包里的 Electron 二进制默认从 GitHub 下载，经常连不上
> （报 `ECONNREFUSED` / `ETIMEDOUT`）。装之前先把镜像配上：
>
> ```bash
> npm config set electron_mirror https://registry.npmmirror.com/-/binary/electron/
> ```
>
> 或临时用环境变量：cmd 下 `set ELECTRON_MIRROR=https://registry.npmmirror.com/-/binary/electron/`，
> PowerShell 下 `$env:ELECTRON_MIRROR="https://registry.npmmirror.com/-/binary/electron/"`。
> 装完发现没有窗口、报「找不到 Electron」，多半就是这一步漏了 —— 补救办法是
> 到包目录里补跑一次二进制的安装脚本：
>
> ```bash
> cd <包目录>/node_modules/electron
> node install.js
> ```

---

## 二、在仓库里开发

```bash
cd desktop
npm install      # 装 Electron（首次约 100 MB，命中缓存会很快）
npm start        # 打开小墨实验室窗口
```

开发时用 `npm run dev`（自动打开开发者工具）。只想调前端、不想开窗口，
可以 `npm run serve`，再用浏览器打开 <http://127.0.0.1:7374/>。

仓库根目录还有几个入口，效果一样：

```bash
npm install                    # 在根目录装（根包把 electron 声明成 dependencies）
npm start                      # 等价于 node desktop/cli.mjs
node desktop/launch.mjs        # 或者直接跑启动器
```

双击仓库根目录的 **`启动小墨实验室.cmd`** 也可以，它调的就是 `desktop/launch.mjs`。

> Windows 上如果 PowerShell 提示「禁止运行脚本」，把 `npm` 换成 `npm.cmd`，
> 或者先执行一次 `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`。

### 启动链路

```
启动小墨实验室.cmd ─┐
                    ├─→ desktop/launch.mjs ─→ desktop/cli.mjs ─→ Electron ─→ desktop/main.js
npm bin: xiaomo-lab ┘        （兼容入口）        （唯一实现）
```

启动逻辑只有一份，就是 `desktop/cli.mjs` —— 它也是 npm 包 `xiaomo-lab` 的
bin 入口。它负责两件事：找到 Electron 的可执行文件
（先问 `require('electron')`，再按平台拼兜底路径），然后把**包根**交给
Electron 启动。交给包根而不是 main.js，是为了让应用名、版本号、
用户数据目录不管从哪儿启动都一致。

---

## 三、资源路径怎么解析

桌面的前端代码**不在这里**，而是复用包根（仓库根）的
`index.html` / `src/` / `styles/`，所以前端永远只有一份。主进程
`desktop/main.js` 按这个顺序找资源：

1. `desktop/app/index.html` —— 存在就用它（留给将来做整包内置）
2. 否则用**上一级目录**，也就是仓库根，同时也是 npm 安装后 `xiaomo-lab` 的包根

`__dirname` 始终是主进程文件所在目录，跟用什么方式启动无关，所以
`npm i -g`、`npx`、仓库里直接跑，三种情形解析结果一致。

前端是原生 ES Module，`file://` 下会被 CORS 拒绝，因此窗口里跑的是自定义
`app://xiaomo-lab/` 协议（实现在 `desktop/main.js`，按扩展名给 MIME）。

---

## 四、自己发布这个包

发布对象是**仓库根目录的 `package.json`**（包名 `xiaomo-lab`），不是
`desktop/package.json` —— 后者只是本地开发用的清单，`private: true`，
而且被根包的 `files` 字段排除在外，所以发出去的 tarball 里没有嵌套的
`package.json`。

```bash
cd <仓库根>

npm login                      # 第一次发布需要：浏览器授权或填账号密码/一次性验证码
npm whoami                     # 确认登录成功

npm pack --dry-run             # 先看清单：50 个文件、约 105 kB（不含 Electron）
npm version patch              # 或 minor / major，改的是根 package.json 的版本号
npm publish --access public    # 公开包必须带 --access public
```

要点：

- **不要在 `desktop/` 里执行 `npm publish`**，那里 `private: true`，会被拒绝。
- `npm pack --dry-run` 的清单里应当有 `index.html`、`src/**`、`styles/main.css`、
  `desktop/main.js`、`desktop/preload.js`、`desktop/cli.mjs`、`server.mjs`、
  `README.md`、`LICENSE`，**不应有** `node_modules/`、`tools/`、`docs/`
  （白名单写在根 `package.json` 的 `files` 字段里）。
- `electron` 放在 `dependencies` 里，所以使用者 `npm install` 时会下载约
  100 MB 的 Electron 二进制 —— 这是有意的：装完就能跑，不需要 exe。
- 版本号看根 `package.json`；`desktop/package.json` 里的 `2.0.0` 只是仓库内的
  开发版本标记，改了不影响发布。
- 发布后验证：`npx xiaomo-lab@latest --version`。

---

## 五、发布内容 / 目录结构

```text
xiaomo-lab/                  ← 包根（= 仓库根）
  package.json               npm 清单：name / bin / files / dependencies
  index.html                 前端入口（桌面版与网页版共用）
  src/**                     前端 ES Module（40 个文件）
  styles/main.css            样式
  server.mjs                 网页版静态服务器：node server.mjs → :7373
  LICENSE                    MIT
  README.md                  仓库总览（npm 页面显示的就是它）
  desktop/
    package.json             ← 仅本地开发用，不发布（private，且被 files 排除）
    main.js                  主进程：窗口、app:// 协议、菜单、IPC、生命周期
    preload.js               预加载桥：把桌面能力挂到 window.xiaomoDesktop
    cli.mjs                  npm bin 入口（启动器，唯一实现）
    launch.mjs               仓库内兼容入口，转发到 cli.mjs
    serve.mjs                纯调试用的静态服务器（不发布）
    .npmrc                   Electron 镜像配置（本地开发用，不发布）
  tools/                     备份等开发脚本（不发布）
```

---

## 六、兼容性

**最低 Windows 10。** 具体取舍：

| 项目 | 做法 | 原因 |
| --- | --- | --- |
| 标题栏 | `frame: false` + 前端自绘 | Win10 没有系统级云母/圆角，自绘两端一致 |
| 背景材质 | 不用 `backgroundMaterial: 'mica'` | 该接口仅 Win11 有效 |
| 标题栏叠加层 | 不用 `titleBarOverlay` | 较新的 Electron 才支持，Win10 上无收益 |
| 圆角 / 毛玻璃 | CSS `border-radius` + `backdrop-filter` | Chromium 在 Win10 上完整支持 |
| 文件协议 | 自定义 `app://`，而非 `file://` | 前端是原生 ES Module，file 协议会被 CORS 拒绝 |
| 构建步骤 | 无 | 原生 ES Module 直接跑，装完即可启动 |

Electron 33 自带的 Chromium 在 Win10 1809 及以上都能跑。

---

## 七、桌面能力

前端通过 `window.xiaomoDesktop` 使用（浏览器里这个对象不存在，
`src/plugins/system.desktop.js` 会自动静默，所以同一份代码两头都能跑）：

| API | 作用 |
| --- | --- |
| `minimize` / `toggleMaximize` / `close` | 窗口控制 |
| `onWindowState` | 最大化状态变化，用于切换还原图标 |
| `saveScene` / `openScene` | 原生对话框读写 `.xiaomo` 场景文件 |
| `exportPng` | 把实验台导出成 PNG |
| `importPack` / `exportPack` | 导入导出器材包 |
| `onMenu` | 接收应用菜单指令 |
| `onSystemTheme` / `getSystemTheme` | 跟随系统深浅色 |
| `openExternal` | 外链交给系统浏览器 |

渲染进程开了 `contextIsolation`、关了 `nodeIntegration`，
拿不到 `require`，只能调用上面这些白名单方法。

---

## 八、应用菜单

| 菜单 | 快捷键 | 说明 |
| --- | --- | --- |
| 新建实验 | `Ctrl+N` | 清空实验台 |
| 打开实验 | `Ctrl+O` | 原生打开对话框 |
| 保存实验 | `Ctrl+S` | 原生保存对话框 |
| 导出图片 | `Ctrl+Shift+E` | 导出 PNG |
| 切换浅色 / 深色 | `Ctrl+D` | 跟随主题系统 |
| 换一个主题 | `Ctrl+Shift+D` | 在已装主题间轮换 |
| 运行 / 暂停 | `F5` | |
| 重置实验 | `Ctrl+Shift+R` | |
| 全屏 | `F11` | |
| 开发者工具 | `Ctrl+Shift+I` | |

（菜单里刻意没有用 `Space` 做加速键，否则输入框里打不出空格。）

---

## 九、窗口状态

尺寸、位置和是否最大化保存在
`%APPDATA%\小墨实验室\window-state.json`（目录名取自 `package.json` 的
`productName`，所以从 bin 启动和从仓库里启动落在同一个地方），
下次启动自动还原。如果那块区域已经不在任何显示器上（换过屏或改过分辨率），
会自动回落到默认尺寸并居中。

---

## 十、自检

无人值守时可以用 `--selftest` 确认「协议通、前端起来了、窗口按钮挂上了、
IPC 与器材包链路都活着」，它跑完会自己退出：

```bash
xiaomo-lab --selftest         # 或 node desktop/cli.mjs --selftest
```

输出形如：

```
SELFTEST_OK {"title":"小墨实验室 · XiaoMo Lab","url":"app://xiaomo-lab/index.html","canvas":true,"winButtons":3,... ,"errors":[]}
SELFTEST_IPC_OK {"before":false,"on":true,"off":false,"sysTheme":"light"}
SELFTEST_PACK_OK {"good":{"installed":true,...},"bad":{"rejected":true,...}}
```

再加一个 `--shot` 会把窗口截图存到 `desktop/preview.png`。

---

## 十一、备份

仓库内的项目文件通过 WebDAV 定期同步，脚本在
`../tools/sync-webdav.ps1`，配置在 `../tools/sync.config.json`。
详见仓库根目录的 `tools/README-backup.md`。
（`tools/` 不随 npm 包发布。）
