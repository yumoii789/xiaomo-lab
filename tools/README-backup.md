# 定期备份到 WebDAV

项目文件会镜像到你的 WebDAV 空间（例如 `https://<你的 WebDAV 地址>/dav/xiaomo-lab/`）。
所有脚本在 `tools/` 下，配置在 `sync.config.json`。

> `sync.config.json` 含明文账号密码，已被 `.gitignore` 排除，不会进入仓库。
> 换一台机器时请按下面的「配置」一节自己新建一份。

---

## 三种用法

### 1. 跑一次

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools\sync-webdav.ps1
```

只上传**有变化**的文件（按"修改时间 + 大小"判断），所以很快。

| 参数 | 作用 |
| --- | --- |
| `-Full` | 全量重传，忽略本地状态 |
| `-DryRun` | 只列出将要上传的文件，不真传 |

### 2. 挂着定期备份（推荐）

```powershell
node tools\backup-daemon.mjs              # 每 10 分钟一次
node tools\backup-daemon.mjs --every=5    # 每 5 分钟一次
node tools\backup-daemon.mjs --once       # 只跑一次
node tools\backup-daemon.mjs --full       # 每次都全量
```

守护进程用递归 `setTimeout` 而不是 `setInterval`——万一某次上传比间隔还慢，
也不会堆积成并发上传。每次结果都追加到 `tools/backup.log`。

Ctrl+C 停止。

### 3. 开机自动跑

用任务计划程序注册一个登录时启动的任务：

```powershell
$action  = New-ScheduledTaskAction -Execute 'node.exe' `
  -Argument 'tools\backup-daemon.mjs --every=15' `
  -WorkingDirectory 'E:\dsh work\xiaomo-lab'
$trigger = New-ScheduledTaskTrigger -AtLogOn
Register-ScheduledTask -TaskName '小墨实验室-自动备份' `
  -Action $action -Trigger $trigger -RunLevel Limited
```

取消：`Unregister-ScheduledTask -TaskName '小墨实验室-自动备份'`

---

## 配置

`tools/sync.config.json`：

```json
{
  "baseUrl": "https://<你的 WebDAV 地址>/dav",
  "user": "…",
  "password": "…",
  "localDir": "<仓库的绝对路径>",
  "remoteDir": "xiaomo-lab",
  "exclude": [".git", "node_modules", "*.tmp", "*.log", ".DS_Store", "Thumbs.db"]
}
```

`exclude` 的元素既可以匹配文件名（`*.log`），也可以匹配目录名（`node_modules`
会连同其下所有内容一起跳过）。

> `node_modules` 一定要留在排除列表里——桌面版装完 Electron 之后那目录有
> 几百 MB，传上去纯属浪费。

---

## 状态与日志

| 文件 | 内容 |
| --- | --- |
| `tools/.sync-state.json` | 已上传文件的指纹，用于增量判断。删掉它 = 下次全量 |
| `tools/backup.log` | 守护进程的每次执行记录 |

---

## 排错

**上传全失败** — 先单跑一次 `-DryRun` 看能不能列出文件，再检查账号密码。
服务器返回 `207 Multi-Status` 才算通，`401` 是密码错了。

**只传了一部分** — 看日志里的 `[FAIL]` 行。WebDAV 对大文件偶尔会超时，
重跑一次通常就好（脚本只重传没成功的）。

**想彻底重来** — 删掉 `tools/.sync-state.json`，再跑 `-Full`。

**PowerShell 提示禁止运行脚本** — 脚本已经用
`-ExecutionPolicy Bypass` 启动了，如果还是被拦，执行一次：

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```
