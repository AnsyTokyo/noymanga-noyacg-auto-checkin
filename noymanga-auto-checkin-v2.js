#!/usr/bin/env node
/*
 * Noymanga 自动签到 —— v3「一键版」
 * ============================================================
 * 与 v2 的区别：
 *   1. 默认无窗口运行（headless）：午夜不再弹出浏览器窗口。
 *   2. 需要登录时自动换成有窗口模式，把登录页摆到你面前，并给你 2 分钟。
 *   3. 登录超时会自动关掉窗口、发 Windows 通知、退出——不再留下僵尸窗口。
 *   4. 结果用 Windows 通知提示：签到成功 / 失败 / 需要重新登录。
 *   5. 支持 config.json 覆盖默认参数，不懂代码也能改。
 *   6. 新增 --login（只登录）、--notify-test（测试通知）、--headless/--headed。
 *   7. 「需要登录」的通知可点击：点一下直接弹出登录窗口（协议 noymanga://login）。
 *   8. 通知里显示连续签到天数（接口返回的 continuous）。
 *
 * 不变的设计契约：
 *   - 源码里没有任何账号密码，登录态只存在于 profile 目录（默认 browser-profile/）。
 *   - 首次运行需要你手动登录一次，之后每天全自动。
 *
 * 用法：
 *   node noymanga-auto-checkin-v2.js                 # 正常签到（无窗口）
 *   node noymanga-auto-checkin-v2.js --login         # 只打开登录页，登录后退出
 *   node noymanga-auto-checkin-v2.js --dry-run       # 只体检，不启动浏览器
 *   node noymanga-auto-checkin-v2.js --headless      # 强制无窗口
 *   node noymanga-auto-checkin-v2.js --headed        # 强制有窗口（排错用）
 *   node noymanga-auto-checkin-v2.js --notify-test   # 弹一条测试通知
 *   node noymanga-auto-checkin-v2.js --notify-action-test  # 弹一条"可点击"的测试通知
 *
 * 退出码：0 成功（含"今天已经签过"），2 需要登录，1 其它失败。
 *
 * 运行要求：Node.js 22 或更高版本（脚本用了全局 WebSocket）。
 */

"use strict";

const fs = require("fs");
const http = require("http");
const path = require("path");
const { spawn, execFileSync } = require("child_process");

/* ============================================================
 * 一、参数与配置
 * ============================================================ */
const ROOT = __dirname;

/** 代码里的默认值；config.json 里同名键会覆盖它们。 */
const DEFAULT_CONFIG = {
  url: "https://noymanga.com/user",          // 签到页面
  loginUrl: "https://noymanga.com/login",    // 登录页面（需要登录时打开）
  signinPath: "/api/v4/signin/sign",         // 签到接口（同源 POST，无请求体）
  debugPort: 19346,                          // 调试端口，刻意避开默认的 9222
  profileDirName: "browser-profile",         // 专用浏览器配置目录（登录态存这里）
  headless: true,                            // 无窗口运行；需要登录时自动改用有窗口
  notify: true,                              // 是否弹 Windows 通知
  notifyAction: true,                        // 需要登录的通知可点击（点了直接打开登录窗口）
  protocolScheme: "noymanga",                // 通知点击用的自定义协议，由安装脚本注册
  notifyWaitMs: 12_000,                      // 等通知真正弹出来再退出（计划任务会回收子进程）
  notifyAlready: true,                       // 今天已经签过了也弹一条，方便确认任务跑过
  loginTimeoutSeconds: 120,                  // 需要登录时，给你多久时间登录
  startTimeoutMs: 35_000,                    // 等待浏览器开放调试端口的上限
  pollIntervalMs: 500,                       // 轮询间隔
  pageReadyMs: 2_000,                        // 等前端框架渲染（水合）的固定等待
  inPageWaitMs: 15_000,                      // 页面内等待签到按钮出现的上限
  cdpTimeoutMs: 12_000,                      // 单条 CDP 命令的超时
  checkinAttempts: 3,                        // 签到接口最多尝试次数
  retryDelayMs: 3_000,                       // 重试基础间隔（第 n 次等 n 倍）
  logRetentionDays: 30,                      // 日志保留天数
};

const CONFIG_FILE = path.join(ROOT, "config.json");

/** 读 config.json（如果存在），把同名键覆盖到默认值上。 */
function loadConfig() {
  const config = { ...DEFAULT_CONFIG };
  if (!fs.existsSync(CONFIG_FILE)) return config;
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
    for (const key of Object.keys(DEFAULT_CONFIG)) {
      if (raw[key] !== undefined && raw[key] !== null) config[key] = raw[key];
    }
  } catch (error) {
    console.log(`[WARN] config.json is not valid JSON; using defaults. (${error.message})`);
  }
  return config;
}

const CONFIG = loadConfig();

const PROFILE_DIR = path.join(ROOT, CONFIG.profileDirName);
const LOG_DIR = path.join(ROOT, "logs");
const STATUS_FILE = path.join(ROOT, "status.txt");

// 通知被点击 / 网页调用 noymanga://login 时，可能短时间内触发多次。
// 用一个标记文件做节流，避免一下子弹出好几个登录窗口。
const LOGIN_TRIGGER_FILE = path.join(LOG_DIR, ".login-trigger");
const LOGIN_TRIGGER_COOLDOWN_MS = 10_000;

// 同一时间只允许一个实例。安装向导里的「立即运行一次」很容易和定时任务撞车，
// 两个进程抢同一个浏览器配置目录，页面就会直接崩溃（Target crashed）。
const LOCK_FILE = path.join(LOG_DIR, ".lock");
const LOCK_STALE_MS = 10 * 60_000;

function processAlive(pid) {
  if (!pid || !Number.isFinite(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (_) {
    return false;
  }
}

function acquireLock() {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const stale = Date.now() - fs.statSync(LOCK_FILE).mtimeMs > LOCK_STALE_MS;
      const owner = Number(fs.readFileSync(LOCK_FILE, "utf8").trim());
      if (!stale && processAlive(owner)) return false;
    }
    fs.writeFileSync(LOCK_FILE, String(process.pid), "utf8");
    return true;
  } catch (_) {
    return true; // 锁只是防呆，出错不能反过来挡住签到
  }
}

function releaseLock() {
  try {
    if (
      fs.existsSync(LOCK_FILE) &&
      fs.readFileSync(LOCK_FILE, "utf8").trim() === String(process.pid)
    ) {
      fs.unlinkSync(LOCK_FILE);
    }
  } catch (_) {
    /* 忽略 */
  }
}

const ARGS = new Set(process.argv.slice(2));
const DRY_RUN = ARGS.has("--dry-run");
const LOGIN_ONLY = ARGS.has("--login");
const NOTIFY_TEST = ARGS.has("--notify-test");
const NOTIFY_ACTION_TEST = ARGS.has("--notify-action-test");
const CLEANUP_ONLY = ARGS.has("--cleanup");
// 命令行显式指定的模式优先于 config.json
const FORCE_HEADLESS = ARGS.has("--headless");
const FORCE_HEADED = ARGS.has("--headed");

const LOGIN_TIMEOUT_MS = Math.max(15, Number(CONFIG.loginTimeoutSeconds) || 120) * 1000;

/* ============================================================
 * 二、日志与状态
 * ============================================================ */
fs.mkdirSync(LOG_DIR, { recursive: true });

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const logFile = path.join(LOG_DIR, `${stamp}.log`);

// 日志正文一律用英文：Windows PowerShell 5.1 默认 GBK 代码页，
// 中文写进控制台会变成乱码，英文最稳。代码注释用中文，方便阅读。
function log(message, level = "INFO") {
  const line = `[${new Date().toLocaleString("zh-CN", { hour12: false })}] [${level}] ${message}`;
  console.log(line);
  if (DRY_RUN) return;
  try {
    fs.appendFileSync(logFile, `${line}\n`);
  } catch (_) {
    /* 日志写不进去也不该让签到失败 */
  }
}

function fail(message) {
  throw new Error(message);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 把本次运行结果写到 status.txt，方便一键查看最近一次的成败。 */
function writeStatus(state, message, extra = {}) {
  const payload = {
    time: new Date().toISOString(),
    state,
    message,
    ...extra,
  };
  try {
    fs.writeFileSync(STATUS_FILE, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  } catch (_) {
    /* 忽略 */
  }
}

/** 删除超过保留期的日志文件。 */
function cleanupOldLogs() {
  try {
    const cutoff = Date.now() - CONFIG.logRetentionDays * 24 * 60 * 60 * 1000;
    let removed = 0;
    for (const name of fs.readdirSync(LOG_DIR)) {
      if (!name.toLowerCase().endsWith(".log")) continue;
      const full = path.join(LOG_DIR, name);
      try {
        const info = fs.statSync(full);
        if (info.isFile() && info.mtimeMs < cutoff) {
          fs.unlinkSync(full);
          removed += 1;
        }
      } catch (_) {
        /* 单个文件删不掉不影响整体 */
      }
    }
    if (removed > 0) log(`Removed ${removed} log file(s) older than ${CONFIG.logRetentionDays} days.`);
  } catch (error) {
    log(`Log cleanup skipped: ${error.message}`, "WARN");
  }
}

/* ============================================================
 * 三、Windows 通知
 * ------------------------------------------------------------
 * 不依赖任何第三方模块：直接调 WinRT 的 Toast API。
 * 中文内容通过 -EncodedCommand（UTF-16LE + base64）传给 PowerShell，
 * 彻底绕开控制台代码页问题。
 * ============================================================ */
const POWERSHELL_APP_ID =
  "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe";

function escapeXml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** 通知点击后交给系统的协议地址，安装脚本会把 noymanga:// 指回本脚本的 --login。 */
function loginProtocolUrl() {
  return `${CONFIG.protocolScheme || "noymanga"}://login`;
}

/** 协议处理器是否已经注册过（没注册就别加点击动作，免得点了没反应）。 */
function isProtocolRegistered() {
  const scheme = CONFIG.protocolScheme || "noymanga";
  return regQuery(`HKCU\\Software\\Classes\\${scheme}\\shell\\open\\command`, null) !== null;
}

/**
 * 构造一段弹 Toast 的 PowerShell 脚本。
 * actionUrl 非空时，整条通知变成可点击：点击由系统按协议打开 actionUrl。
 */
function toastScript(title, message, seconds = 8, actionUrl = null) {
  const toastAttrs = actionUrl
    ? ` activationType="protocol" launch="${escapeXml(actionUrl)}" duration="long"`
    : "";
  return `
$ErrorActionPreference = 'SilentlyContinue'
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType = WindowsRuntime] > $null
$xml = @'
<toast${toastAttrs}><visual><binding template="ToastGeneric"><text>${escapeXml(title)}</text><text>${escapeXml(message)}</text></binding></visual></toast>
'@
$doc = New-Object Windows.Data.Xml.Dom.XmlDocument
$doc.LoadXml($xml)
$toast = New-Object Windows.UI.Notifications.ToastNotification $doc
$notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${POWERSHELL_APP_ID}')
$notifier.Show($toast)
Start-Sleep -Seconds ${Math.max(1, Math.round(seconds))}
`.trim();
}

/** 用 PowerShell 的 -EncodedCommand 执行一段脚本，返回是否成功。 */
function runPowerShell(script, timeoutMs = 15_000) {
  if (process.platform !== "win32") return false;
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  try {
    execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
      { stdio: "ignore", windowsHide: true, timeout: timeoutMs },
    );
    return true;
  } catch (error) {
    log(`PowerShell helper failed: ${error.message}`, "WARN");
    return false;
  }
}

/**
 * 弹一条 Windows 通知；失败只记日志，不影响签到。
 * options.action === true 时，通知可点击 → 打开登录窗口（需要协议已注册）。
 */
function notify(title, message, options = {}) {
  if (!CONFIG.notify || DRY_RUN) return;
  const wantAction = options.action === true && CONFIG.notifyAction !== false;
  const actionUrl = wantAction && isProtocolRegistered() ? loginProtocolUrl() : null;
  if (wantAction && !actionUrl) log("Notification action skipped: protocol handler not installed.", "WARN");
  const script = toastScript(title, message, 3, actionUrl);
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded];
  // 必须等 PowerShell 把通知交给系统之后再返回：
  // 计划任务在 node 退出时会回收整棵进程树，纯分离的子进程可能还没弹窗就被杀掉。
  try {
    execFileSync("powershell.exe", args, {
      stdio: "ignore",
      windowsHide: true,
      timeout: CONFIG.notifyWaitMs,
    });
    log("Notification shown.");
  } catch (error) {
    if (error.code === "ETIMEDOUT") {
      log("Notification did not finish in time; gave up waiting.", "WARN");
      return;
    }
    log(`Notification wait failed (${error.message}); falling back to a detached process.`, "WARN");
    try {
      spawn("powershell.exe", args, { stdio: "ignore", windowsHide: true, detached: true }).unref();
    } catch (_) {
      /* 通知是尽力而为，失败不影响签到 */
    }
  }
}

/** 通知/网页连续触发时，10 秒内只认第一次，避免弹出一堆登录窗口。 */
function loginTriggeredTooSoon() {
  try {
    if (!fs.existsSync(LOGIN_TRIGGER_FILE)) return false;
    const age = Date.now() - fs.statSync(LOGIN_TRIGGER_FILE).mtimeMs;
    return age >= 0 && age < LOGIN_TRIGGER_COOLDOWN_MS;
  } catch (_) {
    return false;
  }
}

function markLoginTriggered() {
  try {
    fs.writeFileSync(LOGIN_TRIGGER_FILE, String(Date.now()), "utf8");
  } catch (_) {
    /* 写不了就算了，节流只是锦上添花 */
  }
}

/* ============================================================
 * 四、识别系统默认浏览器
 * ------------------------------------------------------------
 * 思路：Windows 把「.html/https 的默认程序」记在注册表的 UserChoice 键里，
 * 值是 ProgId（如 MSEdgeHTM / ChromeHTML）。再用 ProgId 去 HKCR 查出
 * 它的启动命令行，从中提取 .exe 路径。全程只读注册表，不改任何设置。
 * ============================================================ */
const URL_ASSOC_KEY =
  "HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice";

/** 读取注册表某个键下的一个值；valueName 传 null 表示读默认值。读不到返回 null。 */
function regQuery(keyPath, valueName) {
  if (process.platform !== "win32") return null;
  const args = ["query", keyPath];
  if (valueName) args.push("/v", valueName);
  else args.push("/ve");
  try {
    const out = execFileSync("reg.exe", args, {
      encoding: "utf8",
      windowsHide: true,
      timeout: 5_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    // 输出形如：    (Default)    REG_SZ    "C:\...\msedge.exe" --single-argument %1
    const line = out.split(/\r?\n/).find((item) => item.includes("REG_"));
    if (!line) return null;
    const match = line.match(/REG_\w+\s+(.*)$/);
    return match ? match[1].trim() : null;
  } catch (_) {
    return null;
  }
}

/** 从 "C:\path\browser.exe" --arg %1 这样的命令行里取出 exe 路径。 */
function extractExePath(commandLine) {
  if (!commandLine) return null;
  const quoted = commandLine.match(/"([^"]+\.exe)"/i);
  if (quoted) return quoted[1];
  const bare = commandLine.match(/^([^\s]+\.exe)/i);
  return bare ? bare[1] : null;
}

/** ProgId -> 可执行文件路径，按 HKCR / 用户级 / 机器级 三个位置依次尝试。 */
function resolveExeFromProgId(progId) {
  if (!progId) return null;
  const roots = ["HKCR", "HKCU\\Software\\Classes", "HKLM\\Software\\Classes"];
  for (const root of roots) {
    const commandLine = regQuery(`${root}\\${progId}\\shell\\open\\command`, null);
    const exe = extractExePath(commandLine);
    if (exe && fs.existsSync(exe)) return exe;
  }
  return null;
}

// 只有 Chromium 内核的浏览器才支持 CDP 调试协议。
const CHROMIUM_EXECUTABLES = new Set([
  "chrome.exe",
  "msedge.exe",
  "brave.exe",
  "vivaldi.exe",
  "opera.exe",
  "chromium.exe",
  "thorium.exe",
  "yandex.exe",
  "arc.exe",
]);

function isChromiumExe(exePath) {
  return CHROMIUM_EXECUTABLES.has(path.basename(exePath).toLowerCase());
}

const PF = process.env.ProgramFiles || "C:\\Program Files";
const PF86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
const LOCAL = process.env.LOCALAPPDATA || "";

/** 已知 Chromium 浏览器的常见安装位置，作为默认浏览器之外的兜底。 */
const KNOWN_BROWSERS = [
  {
    id: "chrome",
    name: "Google Chrome",
    paths: [
      path.join(PF, "Google", "Chrome", "Application", "chrome.exe"),
      path.join(PF86, "Google", "Chrome", "Application", "chrome.exe"),
      LOCAL ? path.join(LOCAL, "Google", "Chrome", "Application", "chrome.exe") : "",
    ],
  },
  {
    id: "edge",
    name: "Microsoft Edge",
    paths: [
      path.join(PF86, "Microsoft", "Edge", "Application", "msedge.exe"),
      path.join(PF, "Microsoft", "Edge", "Application", "msedge.exe"),
    ],
  },
  {
    id: "brave",
    name: "Brave",
    paths: [
      path.join(PF, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
      path.join(PF86, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
      LOCAL ? path.join(LOCAL, "BraveSoftware", "Brave-Browser", "Application", "brave.exe") : "",
    ],
  },
  {
    id: "vivaldi",
    name: "Vivaldi",
    paths: [
      path.join(PF, "Vivaldi", "Application", "vivaldi.exe"),
      LOCAL ? path.join(LOCAL, "Vivaldi", "Application", "vivaldi.exe") : "",
    ],
  },
  {
    id: "opera",
    name: "Opera",
    paths: [LOCAL ? path.join(LOCAL, "Programs", "Opera", "opera.exe") : ""],
  },
];

/**
 * 解析出「按优先级排列的浏览器列表」：
 * 第一顺位是系统默认浏览器（若它是 Chromium），后面是其它已安装的 Chromium 浏览器。
 * 返回 { browsers, notes }，notes 是给用户看的提示信息。
 */
function resolveBrowsers() {
  const notes = [];
  const found = [];

  const progId = regQuery(URL_ASSOC_KEY, "ProgId");
  if (!progId) {
    notes.push("Could not read the Windows default-browser setting; falling back to installed browsers.");
  } else {
    const exe = resolveExeFromProgId(progId);
    if (!exe) {
      notes.push(`Default browser ProgId is "${progId}", but its executable path was not found.`);
    } else if (!isChromiumExe(exe)) {
      notes.push(
        `Default browser "${path.basename(exe)}" is not Chromium-based, so it cannot be driven by the DevTools protocol. Falling back to a Chromium browser.`,
      );
    } else {
      found.push({ name: `System default browser (${path.basename(exe)})`, exe, isDefault: true });
    }
  }

  for (const browser of KNOWN_BROWSERS) {
    for (const candidate of browser.paths) {
      if (candidate && fs.existsSync(candidate)) {
        found.push({ name: browser.name, exe: candidate });
        break;
      }
    }
  }

  // 去重（默认浏览器可能和候选列表里的是同一个 exe）
  const seen = new Set();
  const browsers = found.filter((item) => {
    const key = item.exe.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // 排错用：环境变量 NOYMANG_BROWSER 可以强制指定浏览器（绝对路径）
  const override = process.env.NOYMANG_BROWSER;
  if (override && fs.existsSync(override)) {
    browsers.unshift({ name: `Override (${path.basename(override)})`, exe: override });
  }

  return { browsers, notes };
}

/* ============================================================
 * 五、与浏览器通信的基础件（CDP）
 * ============================================================ */

/** 向浏览器调试端口发 HTTP GET 并解析 JSON。 */
function getJson(url) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { timeout: 2_000 }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (part) => {
        body += part;
      });
      response.on("end", () => {
        if (response.statusCode !== 200) {
          reject(new Error(`Browser debugging endpoint returned HTTP ${response.statusCode}`));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
    });
    request.on("error", reject);
    request.on("timeout", () => request.destroy(new Error("Browser debugging request timed out")));
  });
}

/** 取浏览器级别的 WebSocket 地址（/json/version），浏览器级命令要从这里发。 */
async function getBrowserWsUrl() {
  try {
    const info = await getJson(`http://127.0.0.1:${CONFIG.debugPort}/json/version`);
    return info && info.webSocketDebuggerUrl ? info.webSocketDebuggerUrl : null;
  } catch (_) {
    return null;
  }
}

/** 按调试端口的监听者反查浏览器主进程 pid（spawn 拿到的可能是启动器壳进程）。 */
function findPidByPort(port) {
  try {
    const output = execFileSync("netstat.exe", ["-ano", "-p", "tcp"], {
      encoding: "utf8",
      windowsHide: true,
    });
    for (const line of output.split(/\r?\n/)) {
      if (!line.includes(`:${port}`)) continue;
      if (!/LISTENING/i.test(line)) continue;
      const parts = line.trim().split(/\s+/);
      const pid = Number(parts[parts.length - 1]);
      if (Number.isFinite(pid) && pid > 0) return pid;
    }
  } catch (_) {
    /* netstat 不可用就算了 */
  }
  return 0;
}

/** 按 pid 强杀整棵进程树（浏览器不响应关闭请求时的最后手段）。 */
function killProcessTree(pid) {
  if (!pid) return false;
  try {
    const killer = spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    killer.unref();
    return true;
  } catch (_) {
    try {
      process.kill(pid);
      return true;
    } catch (_error) {
      return false;
    }
  }
}

/** 探测一次调试端口，拿到当前可用的页面目标；没有则返回 null。 */
async function probeTarget() {
  try {
    const targets = await getJson(`http://127.0.0.1:${CONFIG.debugPort}/json/list`);
    return targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl) || null;
  } catch (_) {
    return null;
  }
}

/** 在截止时间之前反复探测，直到出现页面目标或超时。 */
async function waitForTarget(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const target = await probeTarget();
    if (target) return target;
    await delay(CONFIG.pollIntervalMs);
  }
  return null;
}

/** 等调试端口彻底关闭（浏览器进程真的退出了）。 */
async function waitForPortClosed(timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await probeTarget())) return true;
    await delay(300);
  }
  return false;
}

/** 一个最小可用的 CDP 客户端：用 id 把「请求」和「响应」配对。 */
function connectCdp(wsUrl) {
  const socket = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();

  socket.addEventListener("message", ({ data }) => {
    const packet = JSON.parse(data);
    if (!packet.id) return; // 没有 id 的是事件推送，忽略
    const request = pending.get(packet.id);
    if (!request) return;
    pending.delete(packet.id);
    if (packet.error) request.reject(new Error(packet.error.message));
    else request.resolve(packet.result);
  });

  const opened = new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", () => reject(new Error("Unable to connect to the browser.")), {
      once: true,
    });
  });

  return {
    opened,
    close: () => socket.close(),
    send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const requestId = ++id;
        pending.set(requestId, { resolve, reject });
        socket.send(JSON.stringify({ id: requestId, method, params }));
        setTimeout(() => {
          // 返回 true 说明还没被响应过，命令确实超时了
          if (pending.delete(requestId)) reject(new Error(`${method} timed out`));
        }, CONFIG.cdpTimeoutMs);
      });
    },
  };
}

/** 在页面上下文里执行 JS 并取回结果。 */
async function evaluate(cdp, expression) {
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) fail(result.exceptionDetails.text || "Page JavaScript failed.");
  return result.result.value;
}

/**
 * 关掉浏览器，并且**确认它真的退出了**。
 *
 * 注意：Browser.close 属于浏览器级命令，从「页面会话」发往往被忽略
 * （这就是以前登录成功后窗口关不掉的原因），所以这里优先从
 * /json/version 的浏览器级 WebSocket 发；5 秒还没退出就按 pid 强杀进程树。
 */
// 上一次运行如果崩在半路，会留下还在跑、但已经没用的浏览器进程：
// 它们占着配置目录，还会让计划任务一直显示「正在运行」，新的运行直接被拒。
// 这里按命令行里的配置目录路径把它们找出来清掉。
function killStaleBrowsers() {
  let killed = 0;
  try {
    const script = [
      "Get-CimInstance Win32_Process",
      `Where-Object { $_.CommandLine -like '*${PROFILE_DIR}*' -and $_.Name -match '^(msedge|chrome)' }`,
      "ForEach-Object { $_.ProcessId }",
    ].join(" | ");
    const out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 20_000,
    });
    for (const line of out.split(/\r?\n/)) {
      const pid = Number(line.trim());
      if (Number.isFinite(pid) && pid > 0 && pid !== process.pid) {
        log(`Terminating stale browser process pid ${pid}.`, "WARN");
        killProcessTree(pid);
        killed += 1;
      }
    }
  } catch (_) {
    /* 查不到就算了，不能因为清理失败挡住签到 */
  }
  return killed;
}

async function shutdownBrowser({ cdp = null, pid = 0, label = "Browser" } = {}) {
  // ① 页面会话里也发一次（老版本浏览器认这个）
  if (cdp) {
    try {
      await cdp.send("Browser.close");
    } catch (_) {
      /* 已经关了也没关系 */
    }
  }

  // ② 浏览器级会话是正主
  const browserWs = await getBrowserWsUrl();
  if (browserWs) {
    try {
      const browserCdp = connectCdp(browserWs);
      await browserCdp.opened;
      await browserCdp.send("Browser.close");
      browserCdp.close();
    } catch (_) {
      /* 忽略：下面还有兜底 */
    }
  }

  if (await waitForPortClosed(5_000)) return true;

  // ③ 兜底：按「端口占用者」和「spawn 得到的 pid」强杀整棵进程树
  const portPid = findPidByPort(CONFIG.debugPort);
  const targets = [...new Set([portPid, pid].filter(Boolean))];
  for (const target of targets) {
    log(`${label} ignored the close request; terminating pid ${target}.`, "WARN");
    killProcessTree(target);
  }
  if (targets.length && (await waitForPortClosed(5_000))) return true;
  log(`${label} is still running after the close request.`, "WARN");
  return false;
}

/* ============================================================
 * 六、启动 / 关闭浏览器
 * ============================================================ */

/** 按优先级依次尝试启动浏览器；成功返回 { target, browser }，全失败返回 null。 */
async function launchBrowser(headless, startUrl) {
  const { browsers } = resolveBrowsers();
  for (const browser of browsers) {
    log(`Launching ${browser.name}${headless ? " (headless)" : ""}: ${browser.exe}`);
    const args = [
      `--remote-debugging-port=${CONFIG.debugPort}`,
      `--user-data-dir=${PROFILE_DIR}`,
      "--remote-allow-origins=*",
      "--no-first-run",
      "--no-default-browser-check",
    ];
    if (headless) args.push("--headless=new", "--hide-scrollbars", "--mute-audio");
    args.push(startUrl);

    let child;
    try {
      child = spawn(browser.exe, args, { detached: false, stdio: "ignore" });
      child.unref();
    } catch (error) {
      log(`Failed to spawn ${browser.name}: ${error.message}`, "WARN");
      continue;
    }

    const target = await waitForTarget(CONFIG.startTimeoutMs);
    if (target) return { target, browser, pid: child.pid || 0 };
    log(`${browser.name} did not open the debug port in time; trying the next one.`, "WARN");
    try {
      child.kill();
    } catch (_) {
      /* 忽略 */
    }
    killProcessTree(child.pid);
    await delay(1_000);
  }
  return null;
}

/**
 * 打开浏览器 → 连上 → 执行 fn(cdp) → 关掉浏览器。
 * headless 启动失败时自动回退到有窗口模式（有些机器/杀软会拦 headless）。
 */
async function withBrowser(headless, startUrl, fn) {
  // 上一次运行残留的会话直接复用，避免重复启动
  let target = await probeTarget();
  let usedHeadless = headless;
  let childPid = 0;
  if (target) {
    log("An existing browser debug session is still open; reusing it.");
  } else {
    let launched = await launchBrowser(headless, startUrl);
    if (!launched && headless) {
      log("Headless launch failed; retrying with a visible window.", "WARN");
      await waitForPortClosed(5_000);
      launched = await launchBrowser(false, startUrl);
      usedHeadless = false;
    }
    if (!launched) {
      fail("None of the browsers opened a debug port in time. Close leftover browser windows and retry.");
    }
    target = launched.target;
    childPid = launched.pid || 0;
  }

  const cdp = connectCdp(target.webSocketDebuggerUrl);
  await cdp.opened;
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");

  try {
    return await fn(cdp, usedHeadless);
  } finally {
    // 关不掉就强杀，避免把窗口/进程留在后台
    await shutdownBrowser({ cdp, pid: childPid });
    cdp.close();
  }
}

/* ============================================================
 * 七、页面判断与签到
 * ============================================================ */

/**
 * 在页面里轮询，直到能判断出当前状态。
 * 返回 { actionable, already, login, title, url }。
 */
async function readPageState(cdp, waitMs = CONFIG.inPageWaitMs) {
  return evaluate(
    cdp,
    `(async () => {
      const until = Date.now() + ${waitMs};
      while (Date.now() < until) {
        const text = document.body?.innerText || '';
        const checkinLabel = /^(?:每日)?[签簽]\\s*到|立即[签簽]\\s*到$/u;

        // ① 站点当前使用的签到按钮（shadcn/ui 组件特征 + 撑满宽度）
        const exactButton = [...document.querySelectorAll('button[data-slot="button"].w-full')]
          .find(el => {
            if (!checkinLabel.test((el.innerText || el.textContent || '').trim())) return false;
            const box = el.getBoundingClientRect();
            const style = getComputedStyle(el);
            const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
            return box.width > 20 && box.height > 12 &&
              style.visibility !== 'hidden' && style.display !== 'none' &&
              (hit === el || el.contains(hit));
          });

        // ② 站点改版时的文字兜底：取文字匹配且子元素最少的元素（最靠近可点击叶子）
        const actionable = exactButton || [...document.querySelectorAll('button, a, [role="button"], div, span')]
          .filter(el => {
            const label = (el.innerText || el.textContent || '').trim();
            const box = el.getBoundingClientRect();
            return checkinLabel.test(label) && box.width > 20 && box.height > 12;
          })
          .sort((a, b) => a.children.length - b.children.length)[0];

        const already = /(?:今日)?已[签簽]到|[签簽]到成功|已经[签簽]到/u.test(text);
        // 有「登录」字样且没有「退出登录/登出」，才认为未登录
        const login = /登录|登入/u.test(text) && !/退出登录|登出/u.test(text);

        if (actionable || already || login) {
          return { actionable: !!actionable, already, login, title: document.title, url: location.href };
        }
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      return { actionable: false, already: false, login: false, title: document.title, url: location.href };
    })()`,
  );
}

/** 轻量读取页面身份：只要 url 和"是否还显示登录入口"，用于登录轮询。 */
async function readQuickState(cdp) {
  try {
    return await evaluate(
      cdp,
      `(() => {
        const text = document.body?.innerText || '';
        return {
          url: location.href,
          login: /登录|登入/u.test(text) && !/退出登录|登出/u.test(text),
          title: document.title,
        };
      })()`,
    );
  } catch (_) {
    return null; // 页面正在跳转时可能报错，忽略
  }
}

/** 在已登录页面里调用签到接口（浏览器会自动带上 Cookie）。 */
async function requestCheckin(cdp) {
  return evaluate(
    cdp,
    `(async () => {
      const response = await fetch(${JSON.stringify(CONFIG.signinPath)}, {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      });
      return { ok: response.ok, status: response.status, body: (await response.text()).slice(0, 800) };
    })()`,
  );
}

/**
 * 带重试的签到请求。
 * 4xx（除 429）视为「请求本身有问题」，重试也没用，直接返回；
 * 网络异常和 5xx 才重试。
 */
async function requestCheckinWithRetry(cdp) {
  let last = null;
  for (let attempt = 1; attempt <= CONFIG.checkinAttempts; attempt += 1) {
    try {
      const result = await requestCheckin(cdp);
      last = result;
      if (result.ok) return result;
      if (result.status >= 400 && result.status < 500 && result.status !== 429) {
        log(`Check-in rejected by server with HTTP ${result.status}; not retrying.`, "WARN");
        return result;
      }
      log(`Check-in attempt ${attempt}/${CONFIG.checkinAttempts} failed with HTTP ${result.status}.`, "WARN");
    } catch (error) {
      last = { ok: false, status: 0, body: error.message };
      log(`Check-in attempt ${attempt}/${CONFIG.checkinAttempts} threw: ${error.message}`, "WARN");
    }
    if (attempt < CONFIG.checkinAttempts) await delay(CONFIG.retryDelayMs * attempt);
  }
  return last || { ok: false, status: 0, body: "unknown error" };
}

/* ============================================================
 * 八、登录流程
 * ------------------------------------------------------------
 * 需要登录 → 关掉无窗口实例 → 弹出有窗口的登录页 → 最多等 2 分钟：
 *   · 登录成功：继续签到
 *   · 超时：关掉窗口、发通知、退出（不留僵尸窗口）
 * ============================================================ */
async function loginFlow() {
  // 1) 先确保没有同 profile 的实例占着（Chrome 的 profile 是独占的）
  const existing = await probeTarget();
  if (existing) {
    await shutdownBrowser({ label: "Leftover browser instance" });
    await waitForPortClosed(5_000);
  }

  // 2) 有窗口启动，直接落在登录页
  const launched = await launchBrowser(false, CONFIG.loginUrl);
  if (!launched) fail("Could not launch a browser window for login.");

  const cdp = connectCdp(launched.target.webSocketDebuggerUrl);
  await cdp.opened;
  try {
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    try {
      await cdp.send("Page.navigate", { url: CONFIG.loginUrl });
    } catch (_) {
      /* 已经在登录页也无所谓 */
    }
    await delay(1_500);

    const deadline = Date.now() + LOGIN_TIMEOUT_MS;
    let closedByUser = false;
    while (Date.now() < deadline) {
      const quick = await readQuickState(cdp);
      if (!quick) {
        // 读不到页面：可能是你手动关掉了窗口
        if (!(await probeTarget())) {
          closedByUser = true;
          break;
        }
        await delay(1_000);
        continue;
      }
      // 登录成功的判定：只要离开了登录页、页面上也不再显示登录入口，就算登录好了。
      // （实测站点登录后可能跳回首页 "/" 而不是 "/user"，所以不能只认 /user。）
      const onLoginPage = /\/login(\?|#|$)/i.test(quick.url);
      if (!quick.login && !onLoginPage && /noymanga\.com/i.test(quick.url)) {
        log(`Login detected on ${quick.url}; continuing.`);
        await delay(1_000);
        return true;
      }
      await delay(2_000);
    }
    if (closedByUser) log("The login window was closed before login completed.", "WARN");
    else log(`Login timed out after ${Math.round(LOGIN_TIMEOUT_MS / 1000)}s.`, "WARN");
    return false;
  } finally {
    // 无论成功失败都关掉，绝不留僵尸窗口（关不掉就强杀）
    const closed = await shutdownBrowser({ cdp, pid: launched.pid || 0, label: "Login window" });
    if (closed) log("Login window closed.");
    cdp.close();
  }
}

/* ============================================================
 * 九、主流程
 * ============================================================ */

/** 判断页面的三种结局：已签到 / 可签到 / 需要登录。 */
async function inspectPage(cdp) {
  await cdp.send("Page.navigate", { url: CONFIG.url });
  // 页面是前端渲染的：HTML 很快返回，但签到按钮要等框架渲染完成才出现
  await delay(CONFIG.pageReadyMs);
  const state = await readPageState(cdp);
  log(`Page loaded: ${state.title || "(untitled)"}; ${state.url}`);
  return state;
}

/** 在已经登录的页面上完成签到。返回状态名。 */
async function doCheckin(cdp, state) {
  if (state.already) {
    log("Already checked in today. Nothing to do.");
    writeStatus("ALREADY_CHECKED_IN", "already checked in today");
    if (CONFIG.notifyAlready !== false) {
      notify("Noymanga 今天已签到", "今天已经签过了，不需要重复签到。");
    }
    return "ALREADY_CHECKED_IN";
  }

  if (!state.actionable) {
    log("Could not find the check-in control on the page.", "WARN");
    writeStatus("NO_BUTTON", "check-in control not found");
    notify("Noymanga 签到失败", "页面上找不到签到按钮，可能站点改版了。请查看 logs 目录。");
    return "NO_BUTTON";
  }

  const result = await requestCheckinWithRetry(cdp);
  log(`Check-in API response: HTTP ${result.status}; ${result.body || "(empty response)"}`);

  if (!result.ok) {
    writeStatus("CHECKIN_FAILED", `HTTP ${result.status}`, { body: result.body });
    notify("Noymanga 签到失败", `服务器返回 HTTP ${result.status}，请查看 logs 目录。`);
    return "CHECKIN_FAILED";
  }

  const body = String(result.body || "");
  const already = /已[签簽]到|already/i.test(body);
  const stateName = already ? "ALREADY_CHECKED_IN" : "CHECKED_IN";
  // 接口会返回 {"continuous":N,...}：连续签到天数，顺手显示出来
  let continuous = null;
  try {
    const parsed = JSON.parse(body);
    if (parsed && Number.isFinite(Number(parsed.continuous))) continuous = Number(parsed.continuous);
  } catch (_) {
    /* 不是 JSON 就不显示天数 */
  }
  log(already ? "Server says you had already checked in today." : "Check-in confirmed by the server.");
  if (continuous !== null) log(`Continuous check-in days: ${continuous}`);
  writeStatus(stateName, already ? "already checked in today" : "check-in succeeded", {
    httpStatus: result.status,
    ...(continuous !== null ? { continuous } : {}),
    body: body.slice(0, 200),
  });
  if (!already) {
    const suffix = continuous !== null ? `已连续签到 ${continuous} 天。` : "今天的签到已完成。";
    notify("Noymanga 签到成功", suffix);
  } else if (CONFIG.notifyAlready !== false) {
    notify("Noymanga 今天已签到", "服务器说今天已经签过了，无需重复签到。");
  }
  return stateName;
}

async function main() {
  cleanupOldLogs();

  if (NOTIFY_ACTION_TEST) {
    if (!CONFIG.notify) {
      log("Notifications are disabled in config.json.", "WARN");
      return 1;
    }
    if (!isProtocolRegistered()) {
      log("noymanga:// is not registered yet. Run 安装.bat (or 登录.bat) once to register it.", "WARN");
      return 1;
    }
    log(`Sending a clickable notification (${loginProtocolUrl()})...`);
    const ok = runPowerShell(
      toastScript("Noymanga 通知测试", "点击这条通知，应该会弹出登录窗口。", 15, loginProtocolUrl()),
      25_000,
    );
    log(ok ? "Clickable notification sent. Now click it." : "Test notification could not be delivered.", ok ? "INFO" : "WARN");
    return ok ? 0 : 1;
  }

  if (NOTIFY_TEST) {
    log("Sending a test notification...");
    notify("Noymanga 签到助手", "如果你看到这条通知，说明通知功能正常。");
    const ok = runPowerShell(toastScript("Noymanga 签到助手", "通知通道自检完成。", 3), 12_000);
    log(ok ? "Test notification sent." : "Test notification could not be delivered.", ok ? "INFO" : "WARN");
    return 0;
  }

  const { browsers, notes } = resolveBrowsers();
  for (const note of notes) log(note, "WARN");
  if (browsers.length === 0) {
    fail("No Chromium-based browser found. Install Edge/Chrome, or add its path to KNOWN_BROWSERS.");
  }
  log(`Browser priority: ${browsers.map((item) => item.name).join(" -> ")}`);

  const headless = FORCE_HEADED ? false : FORCE_HEADLESS ? true : CONFIG.headless !== false;

  if (DRY_RUN) {
    log("--dry-run: nothing will be launched.");
    log(`Node version: ${process.version}`);
    log(`Profile directory: ${PROFILE_DIR} (${fs.existsSync(PROFILE_DIR) ? "exists" : "missing"})`);
    log(`Debug port: ${CONFIG.debugPort}`);
    log(`Target URL: ${CONFIG.url}`);
    log(`Headless mode: ${headless ? "yes (no window)" : "no (visible window)"}`);
    log(`Notifications: ${CONFIG.notify ? "on" : "off"}; login timeout: ${Math.round(LOGIN_TIMEOUT_MS / 1000)}s`);
    log(
      `Notification click action: ${
        CONFIG.notifyAction === false
          ? "off"
          : isProtocolRegistered()
            ? `on (${loginProtocolUrl()})`
            : "not installed yet (run 安装.bat)"
      }`,
    );
    log(`Config file: ${fs.existsSync(CONFIG_FILE) ? CONFIG_FILE : "(none, using defaults)"}`);
    for (const browser of browsers) log(`  candidate: ${browser.name} => ${browser.exe}`);
    return 0;
  }

  if (LOGIN_ONLY) {
    if (loginTriggeredTooSoon()) {
      log("Another login window was opened less than 10s ago; ignoring this trigger.", "WARN");
      return 0;
    }
    markLoginTriggered();
    log("Login-only mode: a browser window will open on the login page.");
    const ok = await loginFlow();
    // 兜底：退出前再确认一次，别把窗口留在桌面上
    if (await probeTarget()) {
      await shutdownBrowser({ label: "Login browser" });
    }
    if (ok) {
      log("Login saved. Future runs will reuse it.");
      writeStatus("LOGIN_OK", "login completed");
      notify("Noymanga 登录成功", "登录态已保存，之后会自动签到。");
      return 0;
    }
    writeStatus("LOGIN_REQUIRED", "login was not completed in time");
    notify("Noymanga 需要登录", "登录没有完成，签到暂时无法进行。点这条通知可直接重新登录（或双击 登录.bat）。", {
      action: true,
    });
    return 2;
  }

  if (CLEANUP_ONLY) {
    const killed = killStaleBrowsers();
    if (killed === 0) {
      log("No leftover browser processes were found.");
    } else {
      log(`Cleaned up ${killed} leftover browser process(es).`);
    }
    return 0;
  }

  // 上一轮崩掉留下的浏览器会占着配置目录，启动前先清一遍
  const stale = killStaleBrowsers();
  if (stale > 0) log(`Cleaned up ${stale} leftover browser process(es) before starting.`);

  if (!acquireLock()) {
    log("Another instance is already running; skipping this run.", "WARN");
    return 0;
  }

  const checkinPass = async () => {
    let result = null;
    await withBrowser(headless, CONFIG.url, async (cdp) => {
      const state = await inspectPage(cdp);
      if (state.login) {
        result = "LOGIN_REQUIRED";
        return;
      }
      result = await doCheckin(cdp, state);
    });
    return result;
  };

  // ① 先跑一趟：已登录就直接签，未登录就记录状态交给下一阶段
  let outcome = null;
  try {
    outcome = await checkinPass();
  } catch (error) {
    // 页面目标崩溃，多半是上一次运行留下的浏览器没退干净，还占着同一个配置目录。
    // 清掉残留实例再完整重试一次，比直接把 ERROR 写进状态有用得多。
    log(`First attempt failed (${error.message}); cleaning up and retrying once.`, "WARN");
    try {
      if (await probeTarget()) await shutdownBrowser({ label: "Crashed browser" });
      await waitForPortClosed(5_000);
      killStaleBrowsers();
    } catch (_) {
      /* 清理失败也要继续重试 */
    }
    await delay(3_000);
    outcome = await checkinPass();
  }

  // ② 需要登录：切到有窗口模式，给你 2 分钟
  if (outcome === "LOGIN_REQUIRED") {
    log("LOGIN REQUIRED: opening a visible window on the login page.");
    writeStatus("LOGIN_REQUIRED", "manual login needed", { stage: "waiting" });
    notify("Noymanga 需要登录", "已弹出登录窗口，请在那 2 分钟内在页面上完成登录。", { action: true });

    const ok = await loginFlow();
    if (!ok) {
      log("Login was not completed in time; the browser window has been closed.", "WARN");
      writeStatus("LOGIN_TIMEOUT", "login window closed after timeout");
      notify("Noymanga 登录超时", "登录窗口已自动关闭，今天的签到没有完成。点这条通知可重新登录。", {
        action: true,
      });
      return 2;
    }

    log("Login saved. Continuing with the check-in.");
    // ③ 登录成功后，重新无窗口跑一趟
    let finalState = null;
    await withBrowser(headless, CONFIG.url, async (cdp) => {
      finalState = await inspectPage(cdp);
      if (finalState.login) {
        log("Still seeing the login indicator after login; giving up for today.", "WARN");
        writeStatus("LOGIN_REQUIRED", "still logged out after login flow");
        notify("Noymanga 需要登录", "登录后仍然未登录，点这条通知可重试，或双击 登录.bat 检查。", {
          action: true,
        });
        finalState = null;
        return;
      }
      await doCheckin(cdp, finalState);
    });
    if (!finalState) return 2;
    return 0;
  }

  // ④ 已登录：签完了，按结果决定退出码
  return outcome && !["NO_BUTTON", "CHECKIN_FAILED"].includes(outcome) ? 0 : 1;
}

main()
  .then((code) => {
    if (typeof code === "number") process.exitCode = code;
  })
  .finally(() => {
    releaseLock();
  })
  .catch((error) => {
    log(`ERROR: ${error.message}`, "ERROR");
    writeStatus("ERROR", error.message);
    notify("Noymanga 签到出错", error.message.slice(0, 120));
    process.exitCode = 1;
  });
