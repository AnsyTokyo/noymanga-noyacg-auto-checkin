/*
 * Noymanga daily check-in for Windows + Google Chrome.
 *
 * First run: a separate Chrome profile opens. Log in normally and then close
 * Chrome. Later runs reuse that profile's cookies and are fully automatic.
 * No account name or password is stored in this file.
 */

"use strict";

const fs = require("fs");
const http = require("http");
const path = require("path");
const { spawn } = require("child_process");

const ROOT = __dirname;
const URL = "https://noymanga.com/user";
const DEBUG_PORT = 19346;
const PROFILE_DIR = path.join(ROOT, "chrome-profile");
const LOG_DIR = path.join(ROOT, "logs");
const TIMEOUT_MS = 35_000;
const CHROME_PATHS = [
  path.join(process.env.PROGRAMFILES || "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"),
  path.join(process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)", "Google", "Chrome", "Application", "chrome.exe"),
  path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe"),
];

fs.mkdirSync(LOG_DIR, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const logFile = path.join(LOG_DIR, `${stamp}.log`);
function log(message) {
  const line = `[${new Date().toLocaleString("zh-CN", { hour12: false })}] ${message}`;
  console.log(line);
  fs.appendFileSync(logFile, `${line}\n`);
}
function fail(message) { throw new Error(message); }
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function getJson(url) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { timeout: 2_000 }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (part) => { body += part; });
      response.on("end", () => {
        if (response.statusCode !== 200) return reject(new Error(`Chrome debugging returned HTTP ${response.statusCode}`));
        try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
      });
    });
    request.on("error", reject);
    request.on("timeout", () => request.destroy(new Error("Chrome debugging request timed out")));
  });
}

async function waitForDebugTarget() {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const targets = await getJson(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
      const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
      if (page) return page;
    } catch (_) { /* Chrome is still starting. */ }
    await delay(500);
  }
  fail("Chrome did not start its automation connection in time.");
}

function connectCdp(wsUrl) {
  const socket = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  socket.addEventListener("message", ({ data }) => {
    const packet = JSON.parse(data);
    if (!packet.id) return;
    const request = pending.get(packet.id);
    if (!request) return;
    pending.delete(packet.id);
    packet.error ? request.reject(new Error(packet.error.message)) : request.resolve(packet.result);
  });
  const opened = new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", () => reject(new Error("Unable to connect to Chrome.")), { once: true });
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
          if (pending.delete(requestId)) reject(new Error(`${method} timed out`));
        }, 12_000);
      });
    },
  };
}

async function evaluate(cdp, expression) {
  const result = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) fail(result.exceptionDetails.text || "Page JavaScript failed.");
  return result.result.value;
}

async function closeChrome(cdp) {
  try { await cdp.send("Browser.close"); } catch (_) { /* Browser may already be closed. */ }
}

async function main() {
  const chrome = CHROME_PATHS.find((candidate) => fs.existsSync(candidate));
  if (!chrome) fail("Google Chrome was not found. Install Chrome or update CHROME_PATHS in the script.");

  log("Starting Chrome and opening the Noymanga user page.");
  const chromeProcess = spawn(chrome, [
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${PROFILE_DIR}`,
    "--no-first-run",
    "--no-default-browser-check",
    URL,
  ], { detached: false, stdio: "ignore" });
  chromeProcess.unref();

  const target = await waitForDebugTarget();
  const cdp = connectCdp(target.webSocketDebuggerUrl);
  await cdp.opened;
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Page.navigate", { url: URL });
  // The user page is a client-rendered app. Wait until its check-in dialog has
  // hydrated instead of looking only once at an arbitrary page-load moment.
  await delay(2_000);

  // The exact CSS class changes from time to time. This site renders the
  // check-in control as a custom div on some pages, so match visible text
  // rather than relying only on semantic button/link elements.
  const status = await evaluate(cdp, `(async () => {
    const until = Date.now() + 15_000;
    while (Date.now() < until) {
    const text = document.body?.innerText || '';
    const checkinLabel = /^(?:每日)?[签簽]\s*到|立即[签簽]\s*到$/u;
    // This is the selector used by Noymanga's current check-in dialog.
    const exactButton = [...document.querySelectorAll('button[data-slot="button"].w-full')]
      .find(el => {
        if (!checkinLabel.test((el.innerText || el.textContent || '').trim())) return false;
        const box = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
        return box.width > 20 && box.height > 12 && style.visibility !== 'hidden' && style.display !== 'none' && (hit === el || el.contains(hit));
      });
    const actionable = exactButton || [...document.querySelectorAll('button, a, [role="button"], div, span')]
      .filter(el => {
        const label = (el.innerText || el.textContent || '').trim();
        const box = el.getBoundingClientRect();
        return checkinLabel.test(label) && box.width > 20 && box.height > 12;
      })
      .sort((a, b) => a.children.length - b.children.length)[0];
    const already = /(?:今日)?已[签簽]到|[签簽]到成功|已经[签簽]到/u.test(text);
    const login = /登录|登入/u.test(text) && !/退出登录|登出/u.test(text);
    if (actionable || already || login) return { actionable: !!actionable, already, login, title: document.title, url: location.href };
    await new Promise(resolve => setTimeout(resolve, 500));
    }
    return { actionable: false, already: false, login: false, title: document.title, url: location.href };
  })()`);
  log(`Page loaded: ${status.title || "(untitled)"}; ${status.url}`);

  if (status.already) {
    log("Already checked in today. Closing Chrome.");
    await closeChrome(cdp);
    return;
  }
  if (status.login) {
    log("LOGIN REQUIRED: Please log in once in the Chrome window. It is intentionally left open so Chrome can save the login.");
    return;
  }
  if (!status.actionable) {
    log("Could not find the check-in button. Chrome is left open for review; no click was made.");
    return;
  }

  // Noymanga's check-in action is a same-origin POST with no request body.
  // Calling it from this logged-in page makes Chrome attach the profile's
  // cookies automatically, while the server response provides confirmation.
  const result = await evaluate(cdp, `(async () => {
    const response = await fetch('/api/v4/signin/sign', {
      method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    return { ok: response.ok, status: response.status, body: (await response.text()).slice(0, 800) };
  })()`);
  log(`Check-in API response: HTTP ${result.status}; ${result.body || '(empty response)'}`);
  if (!result.ok) {
    log("The server did not accept the check-in request. Chrome is left open for review.");
    return;
  }
  log("Check-in confirmed by the server. Closing Chrome.");
  await closeChrome(cdp);
}

main().catch((error) => {
  log(`ERROR: ${error.message}`);
  process.exitCode = 1;
});
