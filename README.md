# Noymanga（Noyacg）每日自动签到 · Windows 一键版

双击 `安装.bat`，选一个每天的时间。之后到点，你的电脑会自动打开站点、点上「签到」，再用 Windows 通知告诉你结果。

不需要在脚本里填账号密码——登录态保存在本地一个专用浏览器配置目录里，用一次就记住了。

> ⚠️ 仅用于个人账号的日常签到，签到频率为每天一次。请遵守站点条款。

---

## 它是怎么工作的

1. 用你电脑上**已经安装的默认浏览器**（Chrome / Edge，其他 Chromium 内核浏览器也行）启动一个**独立的**浏览器实例；
2. 通过 Chrome DevTools 协议连上去，打开 `https://noymanga.com/user`；
3. 判断页面状态：
   - 已经签到 → 直接报告「今日已签到」；
   - 有签到按钮 → 先点按钮，再用站点自己的签到接口兜底；
   - 没登录 → 打开登录页等你登录（限时 120 秒）。
4. 关掉浏览器，把结果写进 `status.txt` 和 `logs/`，弹一条 Windows 通知。

全程**无窗口**：除了首次登录，你不会看到浏览器弹出来。

## 特性

| 特性 | 说明 |
| --- | --- |
| 一键安装 | 双击 `安装.bat`，选时间、选要不要补签，完事 |
| 自动提权 | 创建计划任务需要管理员权限，安装器会自己弹一次 UAC，点「是」即可 |
| 无窗口运行 | 用 `--headless=new`，半夜不会弹窗打扰你 |
| 自动识别默认浏览器 | 读注册表里的默认浏览器设置，Chrome / Edge / Brave / Vivaldi / Opera 都行 |
| 登录态本地保存 | 存在 `browser-profile\`，不上传、不外传 |
| 过期自动处理 | 掉登录时打开登录窗口，120 秒没操作就自动关掉并通知你 |
| 结果通知 | 签到成功 / 今日已签到 / 签到失败 / 需要登录，四种情况都有 Windows 通知 |
| 通知可点击 | 「需要登录」的通知点一下，直接弹出登录窗口（自定义协议 `noymanga://login`） |
| 连续签到天数 | 从签到接口返回的 `continuous` 字段读出来，显示在通知和 `status.txt` 里 |
| 错过补跑 | 到点时电脑关着/睡眠，开机后系统会补跑一次 |
| 可配置 | `config.json` 覆盖默认参数，不懂代码也能改 |

## 快速开始

### 0. 准备

- Windows 10 / 11
- **Node.js 22 或更新**（脚本用到全局 `WebSocket`）
- Chrome 或 Edge（装哪个用哪个，脚本自动找默认浏览器）

### 1. 下载并解压

把整个文件夹放到一个**你自己有写权限**的地方，比如：

```
D:\tools\noymanga-auto-checkin\
```

（不要放 `C:\Program Files\`，那里写不了文件；路径里可以有中文。）

### 2. 安装

双击 **`安装.bat`**，按提示回答两个问题：

```
① 每天几点签到？（24 小时制，直接回车用默认值 00:00）
   时间: 03:19

② 如果电脑在签到时间关机/休眠，开机后要自动补签吗？
   开启补签？[Y/n]: y
```

- 时间用 24 小时制，`3:19`、`03:19`、`3：19`（全角冒号）都认
- 补签默认开启（推荐），不想要就输入 `n`
- 首次安装时 Windows 会问「是否允许此应用对你的设备进行更改」，点**是**（创建计划任务必须）

### 3. 首次登录

安装完会问「现在就登录一次吗？」，输入 `y`，浏览器会打开登录页：

1. 在窗口里正常登录（含验证码）
2. 登录成功后窗口会**自动关闭**，并弹一条「Noymanga 登录成功」
3. 登录态就存进 `browser-profile\` 了，以后每天自动复用

当时没登录也没关系，之后随时双击 **`登录.bat`** 补一次。

### 4. 验证

双击 **`查看状态.bat`**，能看到：

```
任务名称：Noymanga Daily Check-in
运行时间：每天 03:19
运行命令："D:\node\node.exe" "...\noymanga-auto-checkin-v2.js"
上次结果：0（成功）
最近一次运行结果：签到成功
```

## 每天会发生什么

```
03:19  计划任务唤醒脚本（无窗口，可能闪一下黑框）
         ↓
       启动浏览器 → 打开 /user
         ↓
       ┌── 已登录 ──→ 签到 → 弹「签到成功 · 已连续签到 N 天」→ 关闭浏览器
       ├── 已签到 ──→ 弹「今日已签到」→ 关闭浏览器
       └── 没登录 ──→ 打开登录窗口，等你 120 秒
                       ├── 登录了 → 保存 → 继续签到
                       └── 超时   → 关窗 → 弹「登录超时」
```

## 文件说明

| 文件 | 作用 |
| --- | --- |
| `安装.bat` | **入口**。双击它完成安装 / 改时间 |
| `查看状态.bat` | 看任务状态、下次运行时间、上次结果 |
| `登录.bat` | 单独打开登录窗口（掉登录时用） |
| `卸载.bat` | 删除计划任务和通知协议（不删文件） |
| `打包.bat` | 把仓库里已提交的文件打成 zip，方便发 Release |
| `noymanga-auto-checkin-v2.js` | 主程序 |
| `install-daily-task-v2.ps1` | 安装器（被上面几个 bat 调用） |
| `config.example.json` | 配置模板，复制成 `config.json` 后生效 |
| `noymanga-auto-checkin.js` / `install-daily-task.ps1` | 旧版（v1，仅备份保留，不需要运行） |

运行时自动生成（**不要提交到 Git**）：

| 路径 | 内容 |
| --- | --- |
| `browser-profile\` | 浏览器配置目录，**含登录 Cookie** |
| `logs\` | 每次运行的日志，保留 30 天 |
| `status.txt` | 最近一次运行结果（JSON） |
| `config.json` | 你的本地配置（可选） |

`.gitignore` 已经把这些都排除了。

## 运行结果（status.txt）

| state | 含义 | 有没有通知 |
| --- | --- | --- |
| `CHECKED_IN` | 本次签到成功 | ✅ 签到成功 |
| `ALREADY_CHECKED_IN` | 今天已经签过了 | ✅ 今日已签到 |
| `LOGIN_REQUIRED` | 需要登录（页面要求登录） | ✅ 需要登录（可点击） |
| `LOGIN_TIMEOUT` | 登录窗口等了 120 秒没完成 | ✅ 登录超时 |
| `LOGIN_OK` | `登录.bat` 跑完，登录成功 | ✅ 登录成功 |
| `NO_BUTTON` | 页面上找不到签到按钮（多半是站点改版） | ✅ 签到失败 |
| `CHECKIN_FAILED` | 签到接口返回错误 | ✅ 签到失败 |
| `ERROR` | 脚本异常 | ✅ 签到出错 |

## 配置（可选）

需要改默认行为时，把 `config.example.json` 复制成 `config.json`，按需修改：

```json
{
  "headless": true,
  "notify": true,
  "notifyAction": true,
  "loginTimeoutSeconds": 120
}
```

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `headless` | `true` | 是否无窗口运行；改 `false` 方便看它到底在干什么 |
| `notify` | `true` | 是否弹 Windows 通知 |
| `notifyAction` | `true` | 「需要登录」通知是否可点击（需要安装时注册过协议） |
| `loginTimeoutSeconds` | `120` | 登录窗口最多等多久 |

更多键（`debugPort`、`pageReadyMs`、`checkinAttempts` 等）见脚本顶部的 `DEFAULT_CONFIG`，同名覆盖即可。

## 命令行用法

```powershell
node noymanga-auto-checkin-v2.js                  # 正常签到
node noymanga-auto-checkin-v2.js --dry-run        # 只体检，不启动浏览器
node noymanga-auto-checkin-v2.js --login          # 只打开登录页
node noymanga-auto-checkin-v2.js --notify-test    # 弹一条测试通知
node noymanga-auto-checkin-v2.js --notify-action-test  # 弹一条可点击的测试通知
node noymanga-auto-checkin-v2.js --headed         # 强制有窗口（排错用）
node noymanga-auto-checkin-v2.js --headless       # 强制无窗口
```

安装器也支持命令行：

```powershell
.\install-daily-task-v2.ps1 -Time 08:30          # 改签到时间
.\install-daily-task-v2.ps1 -Time 08:30 -NoCatchUp
.\install-daily-task-v2.ps1 -Status              # 查看状态
.\install-daily-task-v2.ps1 -Login               # 重新登录
.\install-daily-task-v2.ps1 -Uninstall           # 卸载
```

## 常见问题

**Q：安装时报 `ERROR: Access is denied.`？**
安装器会自动请求管理员权限。如果 UAC 被你点掉了，重跑一次 `安装.bat` 就行。如果公司电脑的组策略禁止创建计划任务，那就只能用启动项方案，没办法。

**Q：到点没有弹通知？**
先跑 `node noymanga-auto-checkin-v2.js --notify-test`。能弹说明通知正常，多半是通知被「专注助手 / 勿扰模式」拦住了。另外系统设置里 PowerShell 的通知开关要是开着的。

**Q：到点会闪一下黑窗口？**
会。计划任务直接调 `node.exe`，它是个控制台程序，所以窗口会出现一两秒。这是不引入额外启动器的代价。

**Q：掉登录了怎么办？**
双击 `登录.bat`，重新登录一次即可。通知里如果显示「需要登录」，点那条通知也会打开登录窗口。

**Q：想改签到时间？**
重新双击 `安装.bat`，输入新时间，任务会被覆盖。

**Q：提示 `Recv failure: Connection was reset` / 连不上？**
网络问题。开了代理的话，Git / 浏览器可能没走代理；换网络或重试即可。

**Q：`status.txt` 里是 `NO_BUTTON`？**
站点改版了，页面上找不到签到控件。这种情况需要更新脚本里的选择规则。

**Q：能多开/多账号吗？**
不行，一份目录对应一个账号（登录态存在同一个 `browser-profile`）。

## 安全说明

- 源码里**没有**账号、密码、Cookie。
- 登录态只存在 `browser-profile\`，那是本机的浏览器配置目录，和你的日常浏览器隔离。
- **不要**把 `browser-profile\`、`logs\`、`status.txt`、`config.json` 提交到公开仓库（`.gitignore` 已排除）。
- 如果误传了 `browser-profile`：立刻改站点密码，并删掉整个仓库重建。

## 卸载

1. 双击 `卸载.bat`（删除计划任务 + `noymanga://` 协议，保留脚本和登录态）
2. 直接删掉整个文件夹

## 环境要求

- Windows 10 / 11
- Node.js **22+**
- Chrome / Edge / Brave / Vivaldi / Opera / Chromium 任一

## License

[MIT](LICENSE)
