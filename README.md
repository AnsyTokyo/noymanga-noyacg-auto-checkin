# Noymanga（Noyacg）每日自动签到（Windows）

一个跑在 Windows 上的 Noymanga 自动签到脚本。它用**你系统的默认浏览器**（Edge / Chrome / Brave / Vivaldi / Opera 等 Chromium 内核浏览器）
打开一份独立的用户资料（profile）来保存登录状态，每天定时检测签到入口、调用签到接口，并把结果写进日志和 `status.txt`。

- 不保存账号密码，登录状态只存在本地的 profile 目录里
- 不读取、不修改你日常使用的浏览器个人资料
- 检测不到按钮或未登录时不会乱点，会保留窗口并写日志说明原因
- 源码里没有任何账号、Cookie、令牌

> 仅限个人学习与自用。请自行确认你的使用方式符合目标网站的服务条款，风险自负。

## 两个版本

仓库里保留了两份脚本，**推荐用 v2**：

| | v2（推荐） | v1（旧版，保留） |
| --- | --- | --- |
| 入口文件 | `noymanga-auto-checkin-v2.js` | `noymanga-auto-checkin.js` |
| 安装脚本 | `install-daily-task-v2.ps1` | `install-daily-task.ps1` |
| 用哪个浏览器 | 读注册表识别**系统默认浏览器**，非 Chromium 时自动回落到已装的 Chromium 浏览器 | 写死 Chrome 的三个常见路径 |
| 启动失败 | 自动换下一个已安装的浏览器 | 直接报错 |
| 签到请求 | 失败重试 3 次（间隔 3s → 6s），4xx（除 429）不重试 | 只请求一次 |
| 结果文件 | 额外写 `status.txt` | 只写日志 |
| 日志清理 | 自动删除 30 天前的日志 | 不清理 |
| 体检模式 | `--dry-run` 只打印识别结果，不启动、不签到 | 无 |
| profile 目录 | `browser-profile/` | `chrome-profile/` |

## 文件说明

| 文件 | 作用 |
| --- | --- |
| `noymanga-auto-checkin-v2.js` | **推荐**的签到主脚本（Node.js） |
| `install-daily-task-v2.ps1` | 创建每天 00:00 运行 v2 的 Windows 计划任务 |
| `noymanga-auto-checkin.js` | 旧版签到脚本（仅 Chrome） |
| `install-daily-task.ps1` | 创建每天 00:00 运行旧版的计划任务 |
| `browser-profile/` | v2 首次登录后自动生成，保存登录状态（**已被 .gitignore 忽略**） |
| `chrome-profile/` | v1 首次登录后自动生成（**已被 .gitignore 忽略**） |
| `logs/` | 每次运行的日志，一天一个文件（**已被 .gitignore 忽略**） |
| `status.txt` | 最近一次运行的结果（**已被 .gitignore 忽略**） |

## 环境要求

- Windows 10 / 11
- 任意 **Chromium 内核**浏览器：Microsoft Edge（系统自带）、Google Chrome、Brave、Vivaldi、Opera 均可。
  v2 会自动识别，Firefox 等非 Chromium 浏览器无法用调试协议驱动，会被自动跳过。
- [Node.js](https://nodejs.org/) **22 或更高版本**（脚本直接用内置的全局 `WebSocket`，Node 22 起才默认可用）

## 快速开始（v2）

### 1. 体检：确认脚本认出了你的默认浏览器

```powershell
node .\noymanga-auto-checkin-v2.js --dry-run
```

期望第一行类似：

```
[INFO] Browser priority: System default browser (msedge.exe) -> Google Chrome
[INFO]   candidate: System default browser (msedge.exe) => C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe
```

它只读注册表、打印信息，**不启动浏览器、不联网、不签到**。

### 2. 首次运行并登录

```powershell
node .\noymanga-auto-checkin-v2.js
```

会弹出浏览器窗口进入 Noymanga 用户页。如果提示：

```
[INFO] LOGIN REQUIRED: log in once in the browser window, then close it. Cookies are saved automatically.
```

就在这个窗口里正常登录，然后用窗口右上角的 **✕ 正常关闭**（不要用任务管理器强杀，Cookie 要正常退出才落盘）。

### 3. 再运行一次，确认签到成功

```powershell
node .\noymanga-auto-checkin-v2.js
```

成功后日志会显示 `Check-in API response: HTTP 200` 和 `Check-in confirmed by the server.`，窗口自动关闭。

### 4. 安装每日计划任务

右键 `install-daily-task-v2.ps1` → “使用 PowerShell 运行”，看到 `Created task: Noymanga Daily Check-in` 即成功。
若提示“拒绝访问”，请以管理员身份打开 PowerShell 再执行一次。

> 两个安装脚本用的是**同一个任务名**，所以运行 v2 的安装脚本会把已有的每日任务切换成 v2，而不是新增第二个任务。

## 结果与日志

`status.txt` 里的 `state` 字段含义：

| state | 含义 |
| --- | --- |
| `CHECKED_IN` | 签到成功（接口返回 2xx） |
| `ALREADY_CHECKED_IN` | 今天已经签过了，本次没有重复请求 |
| `LOGIN_REQUIRED` | 未登录。窗口会留着，登录并关闭后再跑一次 |
| `NO_BUTTON` | 找不到签到入口（多半是网站改版），窗口留着便于排查 |
| `CHECKIN_FAILED` | 接口拒绝或服务器错误，`body` 里有服务端原文 |
| `ERROR` | 脚本自身出错，`message` 里有原因 |

日志在 `logs/`，一天一个文件，超过 30 天自动清理。查看最近一次：

```powershell
Get-Content status.txt
Get-Content (Get-ChildItem logs\*.log | Sort-Object LastWriteTime | Select-Object -Last 1).FullName
```

也可以随时手动跑：`node .\noymanga-auto-checkin-v2.js`，
或用任务计划程序找到 `Noymanga Daily Check-in` 右键“运行”。

## 工作原理

1. 读注册表 `HKCU\...\UrlAssociations\https\UserChoice` 得到系统默认浏览器的 ProgId（如 `MSEdgeHTM`），
   再用 ProgId 查 `HKCR\<ProgId>\shell\open\command` 得到真实 exe 路径；非 Chromium 或读取失败时，按内置候选列表回落。
2. 用 `--user-data-dir=browser-profile --remote-debugging-port=19346` 启动它，开一个独立的专用窗口。
3. 通过 DevTools Protocol（CDP）连上页面，等前端渲染完成后用多种特征找“签到”按钮：
   `button[data-slot="button"].w-full` 精确选择器 + 可见性/命中测试 + 文字正则兜底。
4. 判断页面状态：已签到 / 未登录 / 可签到，然后按状态决定关闭窗口、保留窗口还是继续。
5. 在已登录页面的上下文里 `fetch('/api/v4/signin/sign', { method: 'POST', credentials: 'same-origin' })`，
   由浏览器自动带上 Cookie，服务端返回 `{"status":200,"msg":"success","continuous":N}` 即为签到凭证。

## 常见问题

**为什么非要单独登录一次？**
因为脚本用的是独立的 profile 目录，等于一个全新的浏览器配置，没有你日常浏览器的 Cookie。
而且新版 Chrome/Edge 的 Cookie 有应用绑定加密，不同浏览器、不同账户之间无法通用，所以首次必须在这个专用窗口里登录一次。
之后登录态就一直在 profile 目录里，不需要再登录。

**任务没跑 / 窗口没弹出来？**
计划任务不会在你未登录 Windows 时运行；00:00 需要电脑处于开机且已登录状态。
可在“任务计划程序”里查看“上次运行结果”，或手动右键“运行”来验证。

**网站改版导致失效？**
日志会写明是 `NO_BUTTON`、`LOGIN_REQUIRED` 还是 `CHECKIN_FAILED`。
`NO_BUTTON` 说明按钮选择器需要更新，`CHECKIN_FAILED` 说明接口路径或参数变了。

**会不会重复签到？**
不会。页面显示已签到时脚本直接返回 `ALREADY_CHECKED_IN`，不再发请求。

## 注意

- 电脑需要在 00:00 前后保持开机并已登录 Windows。
- 网站改版（按钮文字、接口路径）可能导致脚本失效，日志里会写明原因。
- `browser-profile/`、`chrome-profile/` 里含有登录 Cookie，**不要提交到公开仓库**，`.gitignore` 已默认忽略。

## License

MIT
