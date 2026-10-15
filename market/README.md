# market/ —— 小墨实验室的社区目录源

这个目录既是**本仓库自带的社区目录**，也是「第三方怎么接进来」的一份可运行范本。
整条链路是纯静态的：没有服务端、没有构建步骤、没有依赖。

## 目录结构

```
market/
├── catalog-source.json                        来源 manifest（产品内容：endpoint 指向 GitHub Pages）
├── v1/plugins                                 目录页（DSH catalog-provider-page 的形状；无扩展名是契约要求）
├── v1/xiaomo-extensions.json                  旁挂文档：回答「每个条目在小墨里怎么装」
├── plugins/lab-timer.js                       示例插件：界面（单文件零依赖 ESM）
├── plugins/equipment-booster.js               示例插件：器材（复用宿主的器材包服务，纯数据）
├── market-selftest.mjs                        Node 自测：73 项断言（含哈希与真实字节一致性）
├── README.md
└── _dev-fixtures/                             ↓ 不是目录源内容：本机开发与「拒绝路径」的夹具
    ├── dev/catalog-source.local.json              本机 127.0.0.1:7373 用的 manifest（只有 endpoint 的 origin 不同）
    ├── dev/bad/catalog-source.local.json + v1/plugins   恶意夹具：目录页里有内联代码（验证整页拒绝）
    └── dev/bad-endpoint/catalog-source.local.json  坏夹具：端点路径不含 /v1/plugins（验证 pattern 校验）
```

**下划线开头的 `_dev-fixtures/` 不是给用户和 DSH 的**：它是开发 manifest 与两个故意畸形的夹具，
只为把「坏数据必须被拒」这条路径跑成可复现的证据。目录源本身只有三样东西：
`catalog-source.json`、`v1/**`、`plugins/**`。

## 为什么是两个文件

DSH 的 catalog-provider 契约要求目录 **strict schema、拒绝未知字段**，所以浏览器要的
安装信息（单文件入口、sha256、kind）不能塞进目录页的条目里 —— 那会让整页对 DSH 失效。
于是：

| 文件 | 谁读 | 内容 |
|---|---|---|
| `v1/plugins` | DSH 与小墨 | 条目元数据，字段名与 DSH 一字不差 |
| `v1/xiaomo-extensions.json` | 只小墨读 | 每个条目的 `entry` / `sha256` / `kind` / `pluginId` / `minHost` / `bytes` |

旁挂文档与目录页**同源同目录**，地址由 endpoint 推导，社区作者不需要额外配置。

## 怎么发布自己的插件

1. 写一个**单文件零依赖的 ESM**，`export default { id, name, version, kind, setup(ctx) {...} }`。
   为什么必须单文件零依赖：插件是被 Blob URL 动态 `import()` 的，blob 里解析不了相对 import；
   一切能力只能通过 `setup(ctx)` 拿到（`ctx.slot/log/toast/onDispose`、`ctx.app.services.*`）。
   参考 `plugins/lab-timer.js`（界面）与 `plugins/equipment-booster.js`（器材）。
2. 把它托管在 HTTPS 上（同源最稳，不需要 CORS；跨源要对方返回 CORS 头）。
3. 算哈希，写进旁挂文档：

   ```bash
   node -e "const c=require('crypto'),f=require('fs').readFileSync('plugins/lab-timer.js');console.log(c.createHash('sha256').update(f).digest('hex'), f.length)"
   ```

   改了代码必须重算，否则安装会被拒。本仓库里可以直接：

   ```bash
   node market/market-selftest.mjs --fix   # 按实际字节重算 v1/xiaomo-extensions.json
   node market/market-selftest.mjs         # 校验（CI/手工都跑这个）
   ```

4. `entry` 可以写相对旁挂文档的路径（本目录就是这么写的：`../plugins/lab-timer.js`），
   于是同一份文档在 Pages 与本机各自解析成可用地址。
5. 提交 PR。**默认目录只收录经过审核的条目**；用户自己加进来的来源会在界面上被标成
   「第三方代码」。

## 三条硬规则

- **只收 HTTPS**（唯一例外：回环地址上的 http，仅供本机开发，界面上会标「本地开发」）；
- **目录里不许出现代码、命令或凭据**：`script/code/cmd/command/installCommand/adapter/mapping/
  credential/password/…` 一律拒绝，而且**整页拒收**，不跳过坏条目继续；
- **sha256 是承诺**：安装时会重新拉、重新校验，哈希不符一律拒绝。它只防传输/镜像篡改，
  **防不了索引维护者本身** —— 界面上也是这么写的。

## 换行符（重要）

sha256 是对**字节**的承诺。仓库开着 `core.autocrlf=true`，Windows 检出会把文本文件的 LF
翻成 CRLF，那样哈希就对不上了。建议加一条 `.gitattributes`：

```
market/**/*.js -text
market/v1/plugins -text
```

（这个文件不归本任务的改动范围，已交由 lead 决定；`market-selftest.mjs` 现在会直接报出
文件里有没有 CRLF。）
