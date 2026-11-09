# Noymanga 每日自动签到（Windows + Chrome）

一个跑在 Windows 上的 Noymanga 自动签到脚本。它复用一份独立的 Chrome 用户资料（profile）来保存登录状态，
每天定时打开无头以外的 Chrome、检测签到按钮、调用签到接口，然后把结果写进日志。

- 不保存账号密码，登录状态只存在本地的 `chrome-profile` 目录里
- 不读取、不修改你日常使用的 Chrome 个人资料
- 检测不到按钮或未登录时不会乱点，会保留窗口并写日志说明原因

> 仅限个人学习与自用。请自行确认你的使用方式符合目标网站的服务条款，风险自负。

## 文件说明

| 文件 | 作用 |
| --- | --- |
| `noymanga-auto-checkin.js` | 签到主脚本（Node.js） |
| `install-daily-task.ps1` | 创建每天 00:00 运行的 Windows 计划任务 |
| `chrome-profile/` | 首次登录后自动生成，保存脚本专用的登录状态（**已被 .gitignore 忽略**） |
| `logs/` | 每次运行的日志（**已被 .gitignore 忽略**） |

## 环境要求

- Windows 10 / 11
- [Google Chrome](https://www.google.com/chrome/)（装在默认路径即可，脚本会自动查找）
- [Node.js](https://nodejs.org/) **22 或更高版本**（脚本直接用内置的全局 `WebSocket`，Node 22 起才默认可用；本机实测 v26 正常）

## 首次设置

1. 双击 `noymanga-auto-checkin.js`（或在命令行运行 `node noymanga-auto-checkin.js`）。
   Chrome 会打开一个新的独立窗口并进入 Noymanga 用户页。
2. 在这个窗口里正常登录你的账号。**登录成功后关闭该 Chrome 窗口** —— 登录状态已写入 `chrome-profile`。
3. 右键 `install-daily-task.ps1` → “使用 PowerShell 运行”，出现 `Created task` 即成功。
   若提示“拒绝访问”，请以管理员身份打开 PowerShell，再执行一次该脚本。

## 测试

打开“任务计划程序”，找到 `Noymanga Daily Check-in`，右键“运行”。
日志写在 `logs/` 目录；若当天已签到，脚本会识别“已签到”并自动关闭 Chrome。

也可以随时手动跑一次：

```powershell
node .\noymanga-auto-checkin.js
```

## 工作原理

1. 用 `--user-data-dir=chrome-profile` 启动 Chrome，并开启 `--remote-debugging-port`。
2. 通过 Chrome DevTools Protocol（CDP）连上页面，等待前端渲染完成。
3. 在页面里查找可见的“签到”按钮；若已签到或未登录则直接返回相应状态。
4. 在已登录页面的上下文里 `fetch('/api/v4/signin/sign', { method: 'POST' })`，
   由 Chrome 自动带上 Cookie，服务端返回结果即为签到凭证。

## 注意

- 电脑需要在 00:00 前后保持开机并已登录 Windows；错过时间后计划任务会尽快补跑。
- 网站改版（按钮文字、接口路径）可能导致脚本失效，日志里会写明原因。
- `chrome-profile/` 里含有登录 Cookie，**不要提交到公开仓库**，`.gitignore` 已默认忽略。

## License

MIT
