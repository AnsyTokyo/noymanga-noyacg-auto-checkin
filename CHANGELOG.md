# 更新记录

## v1.1.0（2026-11-11）

### 修复

- **通知弹不出来（重要）**：Windows 只允许「在开始菜单里有快捷方式」的应用发送通知。v1.0.0 的安装包漏了注册通知身份（AppUserModelID）这一步，于是 `Show()` 不报错、日志写着发送成功，但通知被系统静默丢弃——Windows 11 上尤其明显。
  - 现在 `安装.bat` 会在开始菜单创建 `Noymanga 自动签到` 快捷方式，并写入它的 `System.AppUserModel.ID = Noymanga.AutoCheckin`；
  - 同时在 `HKCU\Software\Classes\AppUserModelId\Noymanga.AutoCheckin` 注册显示名，通知里就显示「Noymanga 自动签到」；
  - `卸载.bat` 会把快捷方式和注册表项一起清理。
- **日志不再误报**：`Notification shown.` 现在只有 PowerShell 真的回报 `TOAST OK` 时才写；否则写 `Notification failed: <原因>`，不再把「没弹出来」记成成功。
- **通知兜底**：自己的通知身份发不出去时，自动改用 PowerShell 的身份重发，并留一条 WARN 日志说明原因。

### 文档

- README 新增「通知身份」一节，解释为什么日志会和实际表现不一致；
- 新增两条 FAQ：「日志写着 Notification shown. 但没弹窗」「怎么确认通知到底发出去没有」。

### 升级方式

解压新版本，双击 `安装.bat` 重装一次即可。登录态存在 `browser-profile/` 里，不受影响，不需要重新登录。

## v1.0.0（2026-11-10）

首个可分发版本：

- 双击 `安装.bat` 的交互式向导（选签到时间、选开机补签）
- 自动识别系统默认浏览器（Edge / Chrome / Brave / Vivaldi / Opera 等 Chromium 内核）
- 日常运行无窗口，通过 CDP 调用签到接口，不在脚本里保存账号密码
- 签到成功 / 已签到 / 失败 / 需要重新登录都会发 Windows 通知
- 需要登录时点通知可直接打开登录窗口，2 分钟无人操作自动关窗退出
- `status.txt` 记录最近结果，日志保留 30 天
- 自动请求 UAC 提权，不需要手动右键「以管理员身份运行」
