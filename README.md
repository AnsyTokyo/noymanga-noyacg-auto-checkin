# Noymanga（Noyacg）每日自动签到（Windows）

在 Windows 上每天自动完成 Noymanga 的每日签到。它用**你系统的默认浏览器**（Edge / Chrome / Brave / Vivaldi / Opera 等
Chromium 内核浏览器）打开一份**独立的浏览器配置目录**保存登录态，到点自动检测签到入口、调用签到接口，
把结果写进日志和 `status.txt`，并用 Windows 通知告诉你成功还是失败。

- **双击就能装**：`安装.bat` 是个向导，问你要几点签到，然后自动创建计划任务
- **平时无窗口**：日常运行时浏览器在后台无窗口执行，不会在午夜弹窗
- **需要登录时会给你窗口**：登录态失效时自动弹出登录页，给你 2 分钟；超时自动关窗、发通知、退出，不留僵尸窗口
- **点通知就能登录**：收到"需要登录"的通知，点一下它就直接弹出登录窗口
- **通知里显示连续签到天数**：签到成功会告诉你"已连续签到 N 天"
- 不保存账号密码，登录状态只存在本地 `browser-profile/` 里
- 不读取、不修改你日常使用的浏览器个人资料
- 源码里没有任何账号、Cookie、令牌

> 仅限个人学习与自用。请自行确认你的使用方式符合目标网站的服务条款，风险自负。

## 快速开始

**前提**：Windows 10/11 + [Node.js 22 或更高](https://nodejs.org/)（选 LTS）+ 装了 Edge 或 Chrome。

1. 下载本仓库（`Code` → `Download ZIP`，或 `git clone`）
2. 双击 **`安装.bat`**
3. 按提示输入每天签到的时间（直接回车 = `00:00`）
4. 选择是否开启"开机补签"（推荐开启）
5. 向导最后会问要不要立刻登录一次，选 `Y` —— 在弹出的浏览器里正常登录 Noymanga，登录完窗口会自动关闭

装完就没事了。之后每天到点自动签到；想提前确认，可以双击 `查看状态.bat`。

## 六个双击即用的入口

| 文件 | 作用 |
| --- | --- |
| `安装.bat` | 安装向导：选时间、开机补签、首次登录（也可以用来**改时间**：重新跑一遍即可覆盖旧任务） |
| `查看状态.bat` | 看计划任务、上次运行时间、最近一次结果、最新日志 |
| `登录.bat` | 重新登录一次（登录态过期时用，会直接打开登录页） |
| `取消自动签到.bat` | **只删计划任务**，脚本、登录态、日志全部保留；想恢复就再双击 `安装.bat` |
| `卸载.bat` | 删除计划任务和通知点击协议（脚本、登录态、日志都保留，想彻底删就删整个文件夹） |
| `打包.bat` | 把当前版本打成一个 zip（用于发 GitHub Releases） |

命令行用法（不想用向导时）：

```powershell
# 直接指定时间安装
powershell -ExecutionPolicy Bypass -File .\install-daily-task-v2.ps1 -Time 08:30

# 关闭开机补签
powershell -ExecutionPolicy Bypass -File .\install-daily-task-v2.ps1 -Time 08:30 -NoCatchUp

# 只看计划任务定义，不真正创建
powershell -ExecutionPolicy Bypass -File .\install-daily-task-v2.ps1 -Time 08:30 -DryRun

# 查看状态 / 重新登录 / 仅取消自动签到 / 完全卸载
powershell -ExecutionPolicy Bypass -File .\install-daily-task-v2.ps1 -Status
powershell -ExecutionPolicy Bypass -File .\install-daily-task-v2.ps1 -Login
powershell -ExecutionPolicy Bypass -File .\install-daily-task-v2.ps1 -RemoveTask
powershell -ExecutionPolicy Bypass -File .\install-daily-task-v2.ps1 -Uninstall
```

## 文件说明

| 文件 | 作用 |
| --- | --- |
| `noymanga-auto-checkin-v2.js` | **主脚本**（Node.js）：识别默认浏览器、驱动它签到、写日志和状态 |
| `install-daily-task-v2.ps1` | 安装/管理引擎：生成计划任务 XML、交互式向导、状态查看、登录、卸载 |
| `安装.bat` / `查看状态.bat` / `登录.bat` / `取消自动签到.bat` / `卸载.bat` / `打包.bat` | 上面的六个快捷入口（前五个调用 `install-daily-task-v2.ps1`，`打包.bat` 用 `git archive` 生成 zip） |
| `config.example.json` | 可选的配置文件模板（复制成 `config.json` 后生效） |
| `noymanga-auto-checkin.js` | 旧版脚本（v1，写死 Chrome 路径，保留给老用户） |
| `install-daily-task.ps1` | 旧版安装脚本（v1 用） |
| `browser-profile/` | 首次登录后自动生成，保存登录状态（**已被 .gitignore 忽略**） |
| `logs/` | 每次运行的日志，一天一个文件，保留 30 天（**已被 .gitignore 忽略**） |
| `status.txt` | 最近一次运行的结果，给 `查看状态.bat` 读（**已被 .gitignore 忽略**） |

## 每天到底发生了什么

以 00:00 为例：

```
00:00  计划任务触发（不弹窗口）
00:00  启动默认浏览器 headless → 打开 https://noymanga.com/user
00:01  已登录？ → 调用签到接口 → 写 status.txt → 关闭浏览器
       未登录？ → 关掉无窗口实例 → 弹出有窗口的登录页，给你 2 分钟
                   2 分钟内登录成功 → 继续签到 → 关窗口
                   超时 → 关窗口 → 发通知"登录超时" → 退出（退出码 2）
```

- **开机补签**（默认开启）：如果 00:00 电脑是关机/休眠的，开机后会尽快补跑一次
- **不唤醒睡眠**：不会为了签到把睡着的电脑叫醒
- **电池上也会跑**：笔记本没插电也算数

## 结果与通知

`status.txt` 里的 `state` 有这几种：

| state | 含义 | 会发生什么 |
| --- | --- | --- |
| `CHECKED_IN` | 签到成功（`status.txt` 里带 `continuous` 连续天数） | 弹通知"已连续签到 N 天" |
| `ALREADY_CHECKED_IN` | 今天已经签过了 | 安静退出，不打扰 |
| `LOGIN_REQUIRED` | 需要重新登录 | 弹登录窗口 + **可点击**的通知 |
| `LOGIN_TIMEOUT` | 登录窗口 2 分钟没人操作 | 关窗 + 可点击的通知"登录超时" |
| `CHECKIN_FAILED` | 服务器拒绝（输出了 HTTP 状态码） | 通知"签到失败" |
| `NO_BUTTON` | 页面上找不到签到按钮（站点可能改版） | 通知"签到失败" |
| `ERROR` | 脚本运行出错（网络、浏览器等） | 通知错误摘要 |

通知用的是 Windows 自带的 Toast，不需要装任何东西。如果没看到通知，检查
**设置 → 系统 → 通知** 里是否允许了 PowerShell / Windows PowerShell 的通知。

**关于"点通知直接登录"**：安装时会在 `HKCU\Software\Classes\noymanga` 注册一个 `noymanga://login`
协议（普通用户权限即可，不需要管理员），并把它指向本目录的脚本。所以「需要登录 / 登录超时」的通知可以点击，
点一下就直接弹出登录窗口，不用再去文件夹里找 `登录.bat`。卸载时会自动删掉这个注册表项。
不想用这个功能可以把 `config.json` 里的 `notifyAction` 设为 `false`。

验证它是否生效：

```powershell
node .\noymanga-auto-checkin-v2.js --dry-run              # 看 "Notification click action" 是不是 on
node .\noymanga-auto-checkin-v2.js --notify-action-test   # 弹一条可点击的通知，点一下试试
```

## 可选配置 `config.json`

把 `config.example.json` 复制成 `config.json`（同目录），按需修改，**改完立即生效，不用重新安装**：

```json
{
  "headless": true,
  "notify": true,
  "loginTimeoutSeconds": 120
}
```

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `headless` | `true` | `false` 则每次都有可见窗口（排错时用） |
| `notify` | `true` | `false` 关掉所有 Windows 通知 |
| `notifyAction` | `true` | `false` 则通知不可点击（就不用注册 noymanga:// 协议） |
| `loginTimeoutSeconds` | `120` | 需要登录时给多少秒 |
| `debugPort` | `19346` | 浏览器调试端口，被占用时改它 |

其它可调项（URL、重试次数、日志保留天数等）见脚本顶部的 `DEFAULT_CONFIG`。

## 怎么知道它在正常工作

```powershell
# 查看最近结果
Get-Content .\status.txt

# 看最新一条日志
Get-Content (Get-ChildItem .\logs\*.log | Sort-Object LastWriteTime | Select-Object -Last 1)

# 手动跑一次（会真的签到，已签过就什么都不做）
node .\noymanga-auto-checkin-v2.js

# 只体检，不启动浏览器
node .\noymanga-auto-checkin-v2.js --dry-run

# 测一下通知能不能弹
node .\noymanga-auto-checkin-v2.js --notify-test
```

## 常见问题

**Q：第一天就提示"需要登录"？**
A：首次使用必须先登录一次（登录态存在 `browser-profile/` 里）。双击 `登录.bat` 登录即可。

**Q：以前能用，某天开始老是"需要登录"？**
A：站点的登录 Cookie 会过期。双击 `登录.bat` 重新登录一次就好。也可能是浏览器升级后加密方式变了，重新登录同样能解决。

**Q：`status.txt` 的时间戳没更新？**
A：说明任务没跑。按顺序检查：① 电脑当时是开着的吗 ② 这个 Windows 账户登录着吗（注销/关机不会跑）③
`查看状态.bat` 里"上次结果"是不是 `0x0`。如果开机补签开着，开机后会自动补。

**Q：页面改版导致 `NO_BUTTON`？**
A：脚本有精确按钮、元素可点击性、文字兜底三层匹配；真改版了也会写日志，不会乱点。把日志发到 Issues 一起看看。

**Q：需要管理员权限吗？**
A：**需要，但你不用做什么** —— 直接双击 `安装.bat`，脚本会自动弹出一次 UAC，
点「是」之后所有步骤都在提权后的窗口里继续（问时间、建任务、可选登录）。
不用右键"以管理员身份运行"，也不用事先开管理员终端。

> 为什么要提权：在 Windows 里"创建计划任务"必须管理员权限（实测普通权限会报 `ERROR: Access is denied.`）。
> 其余操作——写 `HKCU` 注册表项、临时改执行策略——都只是用户级动作。

**Q：双击 `安装.bat` 一闪而过？**
A：在 PowerShell 里 `cd` 到本目录再执行 `.\安装.bat`，就能看到完整错误信息。

**Q：公司电脑不让建计划任务？**
A：需要管理员权限或组策略允许。可以右键 `安装.bat` →「以管理员身份运行」再试。

**Q：点了"需要登录"的通知，没反应？**
A：说明 `noymanga://login` 还没注册（例如任务是从旧版升级来的）。重新运行一次 `安装.bat`（或 `登录.bat`）即可注册；
`node .\noymanga-auto-checkin-v2.js --dry-run` 里的 `Notification click action` 会显示是否已就绪。

**Q：想发到 GitHub Releases，怎么打包？**
A：双击 `打包.bat`，会在本地生成 `noymanga-auto-checkin.zip`（只含仓库文件，不含登录态和日志）。把这个 zip 拖到
Releases 里即可。

## 工作原理（给好奇的人）

1. 读注册表 `…\UrlAssociations\https\UserChoice` 找出系统默认浏览器的 ProgId，再从 `HKCR\<ProgId>\shell\open\command`
   解析出 `.exe` 路径；不是 Chromium 内核就回落到已安装的 Chromium 浏览器
2. 用 `--remote-debugging-port` 和独立的 `--user-data-dir` 启动它（所以**不会**碰你日常的浏览器资料）
3. 通过 CDP（Chrome DevTools Protocol）连上去，在页面上下文里 `fetch` 签到接口
   —— 请求由浏览器自己发出，Cookie 自动带上，不需要在脚本里存任何凭据
4. 关闭浏览器时用 `Browser.close`，让 Cookie 正常刷盘

## 安全说明

- 仓库里**没有**账号、密码、Cookie、令牌
- `browser-profile/`（登录态）、`logs/`、`status.txt`、`config.json` 都在 `.gitignore` 里，不会被提交
- 如果你不小心把 `browser-profile/` 传上去了：**立刻去 Noymanga 改密码**，然后删除整个仓库重新建

## 环境要求

| 项目 | 要求 |
| --- | --- |
| 系统 | Windows 10 / 11 |
| Node.js | 22 或更高（脚本用了全局 `WebSocket`） |
| 浏览器 | Edge / Chrome / Brave / Vivaldi / Opera 等 Chromium 内核浏览器 |

## License

[MIT](LICENSE)
