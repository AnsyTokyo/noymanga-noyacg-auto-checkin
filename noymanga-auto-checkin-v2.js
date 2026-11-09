#!/usr/bin/env node
/*
 * Noymanga 自动签到 —— v2「默认浏览器版」
 * ============================================================
 * 与 v1 的区别：
 *   1. 不再硬编码 Chrome，而是读取 Windows 注册表找出系统默认浏览器，
 *      用它的可执行文件启动（Edge / Chrome / Brave / Vivaldi / Opera 均支持）。
 *   2. 默认浏览器不是 Chromium 内核（如 Firefox）时，自动回落到已安装的 Chromium 浏览器。
 *   3. 签到请求失败自动重试（指数退避），浏览器启动失败自动换下一个候选。
 *   4. 每次运行结果写入 status.txt，日志自动保留 30 天。
 *   5. 增加 --dry-run：只检测浏览器和环境，不启动任何窗口、不签到。
 *
 * 不变的设计契约：
 *   - 源码里没有任何账号密码，登录态只存在于 profile 目录（默认 browser-profile/）。
 *   - 首次运行会打开浏览器窗口，请在里面正常登录 Noymanga，然后关闭窗口。
 *     登录信息被写入 profile 目录，之后每天的计划任务就全自动了。
 *
 * 用法：
 *   node noymanga-auto-checkin-v2.js             # 正常签到
 *   node noymanga-auto-checkin-v2.js --dry-run   # 只体检，不启动浏览器
 *
 * 运行要求：Node.js 22 或更高版本（脚本用了全局 WebSocket）。
 */

"use strict";

const fs = require("fs");
const http = require("http");
const path = require("path");
const { spawn, execFileSync } = require("child_process");

/* ============================================================
 * 一、可调参数
 * ============================================================ */
const CONFIG = {
  url: "https://noymanga.com/user",          // 签到页面
  signinPath: "/api/v4/signin/sign",         // 签到接口（同源 POST，无请求体）
  debugPort: 19346,                          // 调试端口，刻意避开默认的 9222
  profileDirName: "browser-profile",         // 专用浏览器配置目录（登录态存这里）
  startTimeoutMs: 35_000,                    // 等待浏览器开放调试端口的上限
  pollIntervalMs: 500,                       // 轮询间隔
  pageReadyMs: 2_000,                        // 等前端框架渲染（水合）的固定等待
  inPageWaitMs: 15_000,                      // 页面内等待签到按钮出现的上限
  cdpTimeoutMs: 12_000,                      // 单条 CDP 命令的超时
  checkinAttempts: 3,                        // 签到接口最多尝试次数
  retryDelayMs: 3_000,                       // 重试基础间隔（第 n 次等 n 倍）
  logRetentionDays: 30,                      // 日志保留天数
};

const DRY_RUN = process.argv.includes("--dry-run");

const ROOT = __dirname;
const PROFILE_DIR = path.join(ROOT, CONFIG.profileDirName);
const LOG_DIR = path.join(ROOT, "logs");
const STATUS_FILE = path.join(ROOT, "status.txt");

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

/** 把本次运行结果写到 status.txt，方便一眼看最近一次的成败。 */
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
 * 三、识别系统默认浏览器
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

  return { browsers, notes };
}

/* ============================================================
 * 四、与浏览器通信的基础件（CDP）
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

/** 用 CDP 优雅关闭浏览器（让 Cookie 等数据刷盘）。 */
async function closeBrowser(cdp) {
  try {
    await cdp.send("Browser.close");
  } catch (_) {
    /* 可能已经关闭 */
  }
}

/* ============================================================
 * 五、页面判断与签到
 * ============================================================ */

/**
 * 在页面里轮询，直到能判断出当前状态。
 * 返回 { actionable, already, login, title, url }。
 */
async function readPageState(cdp) {
  return evaluate(
    cdp,
    `(async () => {
      const until = Date.now() + ${CONFIG.inPageWaitMs};
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
 * 六、主流程
 * ============================================================ */
async function main() {
  cleanupOldLogs();

  const { browsers, notes } = resolveBrowsers();
  for (const note of notes) log(note, "WARN");
  if (browsers.length === 0) {
    fail("No Chromium-based browser found. Install Edge/Chrome, or add its path to KNOWN_BROWSERS.");
  }
  log(`Browser priority: ${browsers.map((item) => item.name).join(" -> ")}`);

  if (DRY_RUN) {
    log("--dry-run: nothing will be launched.");
    log(`Profile directory: ${PROFILE_DIR}`);
    log(`Debug port: ${CONFIG.debugPort}`);
    log(`Target URL: ${CONFIG.url}`);
    for (const browser of browsers) log(`  candidate: ${browser.name} => ${browser.exe}`);
    return;
  }

  // ① 如果上一次运行留下的浏览器还开着（调试端口仍在），直接复用，避免重复启动
  let target = await probeTarget();
  if (target) {
    log("An existing browser debug session is still open; reusing it.");
  } else {
    // ② 否则按优先级依次尝试启动
    for (const browser of browsers) {
      log(`Launching ${browser.name}: ${browser.exe}`);
      const child = spawn(
        browser.exe,
        [
          `--remote-debugging-port=${CONFIG.debugPort}`,
          `--user-data-dir=${PROFILE_DIR}`,
          "--remote-allow-origins=*",
          "--no-first-run",
          "--no-default-browser-check",
          CONFIG.url,
        ],
        { detached: false, stdio: "ignore" },
      );
      child.unref();

      target = await waitForTarget(CONFIG.startTimeoutMs);
      if (target) {
        log(`Connected to ${browser.name}.`);
        break;
      }
      log(`${browser.name} did not open the debug port in time; trying the next one.`, "WARN");
      try {
        child.kill();
      } catch (_) {
        /* 忽略 */
      }
    }
    if (!target) {
      fail("None of the browsers opened a debug port in time. Close leftover browser windows and retry.");
    }
  }

  const cdp = connectCdp(target.webSocketDebuggerUrl);
  await cdp.opened;
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Page.navigate", { url: CONFIG.url });
  // 页面是前端渲染的：HTML 很快返回，但签到按钮要等框架渲染完成才出现
  await delay(CONFIG.pageReadyMs);

  const state = await readPageState(cdp);
  log(`Page loaded: ${state.title || "(untitled)"}; ${state.url}`);

  if (state.already) {
    log("Already checked in today. Closing the browser.");
    writeStatus("ALREADY_CHECKED_IN", "already checked in today");
    await closeBrowser(cdp);
    return;
  }

  if (state.login) {
    log("LOGIN REQUIRED: log in once in the browser window, then close it. Cookies are saved automatically.");
    writeStatus("LOGIN_REQUIRED", "manual login needed");
    // 故意不关浏览器：留给你手动登录
    return;
  }

  if (!state.actionable) {
    log("Could not find the check-in control. The browser is left open for inspection; nothing was clicked.");
    writeStatus("NO_BUTTON", "check-in control not found");
    return;
  }

  const result = await requestCheckinWithRetry(cdp);
  log(`Check-in API response: HTTP ${result.status}; ${result.body || "(empty response)"}`);

  if (!result.ok) {
    log("The server did not accept the check-in request. The browser is left open for inspection.");
    writeStatus("CHECKIN_FAILED", `HTTP ${result.status}`, { body: result.body });
    return;
  }

  log("Check-in confirmed by the server. Closing the browser.");
  writeStatus("CHECKED_IN", "check-in succeeded", { httpStatus: result.status });
  await closeBrowser(cdp);
}

main().catch((error) => {
  log(`ERROR: ${error.message}`, "ERROR");
  writeStatus("ERROR", error.message);
  process.exitCode = 1;
});
