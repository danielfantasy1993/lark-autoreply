import { config as loadDotEnv } from "dotenv";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { execFile } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadRuntimeSwitches, saveRuntimeSwitches, type RuntimeSwitches } from "./runtimeSwitches.js";

loadDotEnv({ path: resolve(dirname(fileURLToPath(import.meta.url)), "../.env") });

const host = process.env.LARK_CONTROL_PANEL_HOST || "0.0.0.0";
const port = readPositiveInteger(process.env.LARK_CONTROL_PANEL_PORT, 8788);
const username = process.env.LARK_CONTROL_PANEL_USERNAME || "admin";
const password = process.env.LARK_CONTROL_PANEL_PASSWORD || "";
const sessionSecret = process.env.LARK_CONTROL_PANEL_SESSION_SECRET || "";
const managedProcessName = process.env.LARK_CONTROL_PANEL_PM2_APP || "lark-autoreply";
const cookieName = "lark_control_session";
const sessionMaxAgeSeconds = readPositiveInteger(process.env.LARK_CONTROL_PANEL_SESSION_SECONDS, 12 * 60 * 60);
const rememberMaxAgeSeconds = readPositiveInteger(process.env.LARK_CONTROL_PANEL_REMEMBER_SECONDS, 30 * 24 * 60 * 60);
const smartReplyTargetNames = readNameList(process.env.LARK_SMART_REPLY_TARGET_NAMES, ["李文贤", "何运伟"]);
let lastStablePm2Status: Pm2Status | undefined;

if (!password || !sessionSecret) {
  throw new Error("LARK_CONTROL_PANEL_PASSWORD and LARK_CONTROL_PANEL_SESSION_SECRET must be configured.");
}

const server = createServer(async (request, response) => {
  try {
    await handleRequest(request, response);
  } catch (error) {
    console.error(error);
    sendHtml(response, 500, renderPage({ error: "控制台内部错误，请稍后重试。", authenticated: isAuthenticated(request) }));
  }
});

server.listen(port, host, () => {
  console.log(`Lark auto-reply control panel listening on http://${host}:${port}`);
});

async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);

  if (url.pathname === "/health") {
    sendJson(response, 200, { status: "ok", app: managedProcessName });
    return;
  }

  if (url.pathname === "/api/status") {
    if (!isAuthenticated(request)) {
      sendJson(response, 401, { error: "unauthorized" });
      return;
    }
    sendJson(response, 200, { app: managedProcessName, status: await getPm2Status(), checkedAt: new Date().toISOString() });
    return;
  }

  if (url.pathname === "/api/switches") {
    if (!isAuthenticated(request)) {
      sendJson(response, 401, { error: "unauthorized" });
      return;
    }
    if (request.method === "GET") {
      sendJson(response, 200, { switches: await loadRuntimeSwitches() });
      return;
    }
    if (request.method === "POST") {
      const fields = parseForm(await readRequestBody(request));
      const switches = await saveRuntimeSwitches({
        groupFixedReplyEnabled: isTruthy(fields.groupFixedReplyEnabled),
        directFixedReplyEnabled: isTruthy(fields.directFixedReplyEnabled),
        directSmartReplyEnabled: isTruthy(fields.directSmartReplyEnabled),
        directSmartReplyByTarget: readSmartReplyTargetSwitchFields(fields)
      });
      sendJson(response, 200, { switches });
      return;
    }
    sendJson(response, 405, { error: "method not allowed" });
    return;
  }

  if (url.pathname === "/login" && request.method === "POST") {
    const fields = parseForm(await readRequestBody(request));
    if (safeEquals(fields.username || "", username) && safeEquals(fields.password || "", password)) {
      const maxAgeSeconds = isTruthy(fields.remember) ? rememberMaxAgeSeconds : sessionMaxAgeSeconds;
      response.statusCode = 303;
      response.setHeader("Location", "/");
      response.setHeader("Set-Cookie", `${cookieName}=${createSessionCookie(maxAgeSeconds)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}`);
      response.end();
      return;
    }
    sendHtml(response, 401, renderPage({ authenticated: false, error: "用户名或密码不正确。" }));
    return;
  }

  if (url.pathname === "/logout") {
    response.statusCode = 303;
    response.setHeader("Location", "/");
    response.setHeader("Set-Cookie", `${cookieName}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
    response.end();
    return;
  }

  if (url.pathname === "/favicon.ico") {
    response.statusCode = 204;
    response.end();
    return;
  }

  if (url.pathname === "/action" && request.method === "GET") {
    response.statusCode = 303;
    response.setHeader("Location", "/");
    response.end();
    return;
  }

  if (url.pathname === "/action" && request.method === "POST") {
    if (!isAuthenticated(request)) {
      sendHtml(response, 401, renderPage({ authenticated: false, error: "请先登录。" }));
      return;
    }
    const fields = parseForm(await readRequestBody(request));
    const action = fields.action || "";
    if (!isAllowedAction(action)) {
      sendHtml(response, 400, renderPage({ authenticated: true, error: "不支持的操作。", status: await getPm2Status() }));
      return;
    }
    const result = await runPm2(action);
    response.statusCode = 303;
    response.setHeader("Location", `/?${result.ok ? "message" : "error"}=${encodeURIComponent(result.message)}`);
    response.end();
    return;
  }

  if (url.pathname !== "/") {
    sendHtml(response, 404, renderPage({ authenticated: isAuthenticated(request), error: "页面不存在。" }));
    return;
  }

  if (!isAuthenticated(request)) {
    sendHtml(response, 200, renderPage({ authenticated: false }));
    return;
  }

  sendHtml(response, 200, renderPage({ authenticated: true, status: await getPm2Status(), switches: await loadRuntimeSwitches(), message: url.searchParams.get("message") || undefined, error: url.searchParams.get("error") || undefined }));
}

function renderPage(options: { authenticated: boolean; status?: Pm2Status; switches?: RuntimeSwitches; message?: string; error?: string }): string {
  const status = options.status;
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>自动回复控制台</title>
  <style>
    :root { color-scheme: light; --bg:#f5f7fb; --panel:#fff; --ink:#111827; --muted:#667085; --line:#d0d5dd; --green:#067647; --red:#b42318; --blue:#175cd3; --shadow:0 14px 40px rgba(16,24,40,.08); }
    * { box-sizing:border-box; }
    body { margin:0; min-height:100vh; font-family:"Segoe UI","Microsoft YaHei",sans-serif; background:var(--bg); color:var(--ink); display:grid; place-items:center; padding:20px; }
    .card { width:min(520px,100%); background:var(--panel); border:1px solid var(--line); border-radius:12px; box-shadow:var(--shadow); padding:22px; }
    h1 { margin:0 0 8px; font-size:24px; letter-spacing:0; }
    p { color:var(--muted); line-height:1.6; }
    label { display:block; font-size:14px; font-weight:700; margin:14px 0 7px; }
    input { width:100%; border:1px solid var(--line); border-radius:8px; padding:12px; font:inherit; }
    .check { display:flex; align-items:center; gap:9px; margin-top:14px; color:var(--muted); font-size:14px; font-weight:600; }
    .check input { width:18px; height:18px; padding:0; }
    button, a.button { display:inline-flex; justify-content:center; align-items:center; min-height:44px; border:0; border-radius:8px; padding:0 16px; font:inherit; font-weight:750; cursor:pointer; text-decoration:none; }
    .primary { width:100%; margin-top:18px; color:white; background:var(--blue); }
    .actions { display:grid; grid-template-columns:repeat(3,1fr); gap:10px; margin-top:16px; }
    .start { color:white; background:var(--green); }
    .stop { color:white; background:var(--red); }
    .restart { color:white; background:var(--blue); }
    .refresh { color:var(--ink); background:#eef2f6; border:1px solid var(--line); }
    .status { margin:18px 0 0; padding:14px; border-radius:10px; background:#f8fafc; border:1px solid var(--line); }
    .status-head { display:flex; align-items:center; justify-content:space-between; gap:12px; }
    .switches { margin:16px 0 0; display:grid; gap:10px; }
    .switch-row { display:flex; align-items:center; justify-content:space-between; gap:14px; padding:12px; border:1px solid var(--line); border-radius:10px; background:#fff; }
    .switch-row.compact { padding:10px 12px; }
    .switch-title { font-weight:750; }
    .switch-sub { margin:3px 0 0; color:var(--muted); font-size:12px; line-height:1.45; }
    .switch-children { display:grid; gap:8px; margin:-2px 0 2px 12px; padding-left:10px; border-left:2px solid var(--line); }
    .toggle { position:relative; display:inline-flex; width:50px; height:28px; flex:0 0 auto; }
    .toggle input { position:absolute; opacity:0; width:1px; height:1px; }
    .slider { position:absolute; inset:0; cursor:pointer; border-radius:999px; background:#d0d5dd; transition:.18s ease; }
    .slider::before { content:""; position:absolute; width:22px; height:22px; left:3px; top:3px; border-radius:50%; background:#fff; box-shadow:0 2px 5px rgba(16,24,40,.2); transition:.18s ease; }
    .toggle input:checked + .slider { background:var(--blue); }
    .toggle input:checked + .slider::before { transform:translateX(22px); }
    .pill { display:inline-flex; padding:4px 9px; border-radius:999px; font-size:13px; font-weight:750; background:#eef4ff; color:#3538cd; }
    .online { background:#ecfdf3; color:#067647; }
    .stopped { background:#fff1f3; color:#c01048; }
    .meta { margin:10px 0 0; font-size:14px; }
    .tiny { margin:8px 0 0; color:var(--muted); font-size:12px; }
    .alert { margin-top:14px; padding:12px; border-radius:8px; border:1px solid; line-height:1.55; }
    .ok { border-color:#abefc6; background:#ecfdf3; color:#067647; }
    .err { border-color:#fecdca; background:#fff4f2; color:#b42318; }
    .top { display:flex; justify-content:space-between; align-items:center; gap:12px; }
    .logout { color:var(--muted); font-size:14px; }
  </style>
</head>
<body>
  <main class="card">
    ${options.authenticated ? renderControlContent(status, options.switches, options.message, options.error) : renderLoginContent(options.error)}
  </main>
  ${options.authenticated ? renderStatusScript() : ""}
</body>
</html>`;
}

function renderLoginContent(error?: string): string {
  const rememberDays = Math.max(1, Math.round(rememberMaxAgeSeconds / 86400));
  return `<h1>自动回复控制台</h1>
    <p>登录后可以一键启动、停止或重启服务器上的自动回复服务。</p>
    ${error ? `<div class="alert err">${escapeHtml(error)}</div>` : ""}
    <form method="post" action="/login">
      <label for="username">用户名</label>
      <input id="username" name="username" autocomplete="username" required>
      <label for="password">密码</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required>
      <label class="check" for="remember"><input id="remember" name="remember" type="checkbox" checked>记住登录 ${rememberDays} 天</label>
      <button class="primary" type="submit">登录</button>
    </form>`;
}

function renderControlContent(status: Pm2Status | undefined, switches: RuntimeSwitches | undefined, message?: string, error?: string): string {
  const statusText = status?.status || "unknown";
  const statusClass = statusText === "online" ? "online" : statusText === "stopped" ? "stopped" : "";
  const currentSwitches = switches ?? { groupFixedReplyEnabled: true, directFixedReplyEnabled: true, directSmartReplyEnabled: true, directSmartReplyByTarget: {} };
  return `<div class="top"><div><h1>自动回复控制台</h1><p>${escapeHtml(managedProcessName)}</p></div><a class="logout" href="/logout">退出</a></div>
    ${message && !error ? `<div class="alert ok">${escapeHtml(message)}</div>` : ""}
    ${error ? `<div class="alert err">${escapeHtml(error)}</div>` : ""}
    <div class="status">
      <div class="status-head">
        <div>当前状态：<span id="status-pill" class="pill ${statusClass}">${escapeHtml(statusText)}</span></div>
        <button class="refresh" id="refresh-status" type="button">刷新状态</button>
      </div>
      <p class="meta">PID：<span id="status-pid">${escapeHtml(String(status?.pid ?? "-"))}</span>　重启次数：<span id="status-restarts">${escapeHtml(String(status?.restarts ?? "-"))}</span></p>
      <p class="tiny">最后刷新：<span id="status-checked-at">刚刚</span></p>
    </div>
    <form class="actions" method="post" action="/action">
      <button class="start" name="action" value="start" type="submit">启动</button>
      <button class="stop" name="action" value="stop" type="submit">停止</button>
      <button class="restart" name="action" value="restart" type="submit">重启</button>
    </form>
    <form class="switches" id="reply-switches">
      ${renderSwitch("groupFixedReplyEnabled", "群聊固定回复", "群聊里 @ 你时发送固定文案", currentSwitches.groupFixedReplyEnabled)}
      ${renderSwitch("directFixedReplyEnabled", "单聊固定回复", "单聊目标使用固定文案回复", currentSwitches.directFixedReplyEnabled)}
      ${renderSwitch("directSmartReplyEnabled", "单聊 AI 回复", "单聊智能目标使用 AI 生成回复", currentSwitches.directSmartReplyEnabled)}
      ${renderSmartReplyTargetSwitches(currentSwitches)}
    </form>`;
}

function renderSwitch(name: string, title: string, subtitle: string, checked: boolean, compact = false): string {
  return `<div class="switch-row${compact ? " compact" : ""}">
      <div><div class="switch-title">${escapeHtml(title)}</div><p class="switch-sub">${escapeHtml(subtitle)}</p></div>
      <label class="toggle" title="${escapeHtml(title)}"><input name="${escapeHtml(name)}" type="checkbox" ${checked ? "checked" : ""}><span class="slider"></span></label>
    </div>`;
}

function renderSmartReplyTargetSwitches(switches: RuntimeSwitches): string {
  if (smartReplyTargetNames.length === 0) {
    return "";
  }
  return `<div class="switch-children">
      ${smartReplyTargetNames.map((selector) => renderSwitch(smartReplyTargetFieldName(selector), formatSmartReplyTargetLabel(selector), "只控制这个人的 AI 单聊回复", switches.directSmartReplyByTarget?.[selector] ?? true, true)).join("")}
    </div>`;
}

function renderStatusScript(): string {
  return `<script>
    const statusPill = document.getElementById('status-pill');
    const statusPid = document.getElementById('status-pid');
    const statusRestarts = document.getElementById('status-restarts');
    const statusCheckedAt = document.getElementById('status-checked-at');
    const refreshButton = document.getElementById('refresh-status');
    const switchForm = document.getElementById('reply-switches');

    function setStatus(payload) {
      const status = payload && payload.status ? payload.status : { status: 'unknown' };
      const statusText = status.status || 'unknown';
      statusPill.textContent = statusText;
      statusPill.className = 'pill ' + (statusText === 'online' ? 'online' : statusText === 'stopped' ? 'stopped' : '');
      statusPid.textContent = status.pid ?? '-';
      statusRestarts.textContent = status.restarts ?? '-';
      statusCheckedAt.textContent = payload && payload.checkedAt ? new Date(payload.checkedAt).toLocaleString() : new Date().toLocaleString();
    }

    async function refreshStatus() {
      refreshButton.disabled = true;
      try {
        const response = await fetch('/api/status', { cache: 'no-store' });
        if (!response.ok) throw new Error('status request failed');
        setStatus(await response.json());
      } catch {
        setStatus({ status: { status: 'refresh failed' }, checkedAt: new Date().toISOString() });
      } finally {
        refreshButton.disabled = false;
      }
    }

    refreshButton.addEventListener('click', refreshStatus);
    switchForm.addEventListener('change', async () => {
      const formData = new FormData(switchForm);
      const body = new URLSearchParams();
      const switchNames = Array.from(switchForm.querySelectorAll('input[type="checkbox"]')).map((input) => input.name);
      for (const name of switchNames) {
        body.set(name, formData.has(name) ? 'true' : 'false');
      }
      await fetch('/api/switches', { method: 'POST', body, cache: 'no-store' });
    });
    refreshStatus();
    setInterval(refreshStatus, 2000);
  </script>`;
}

type Pm2Status = {
  status: string;
  pid?: number;
  restarts?: number;
  rawStatus?: string;
};

async function getPm2Status(): Promise<Pm2Status> {
  const result = await execPm2(["jlist"]);
  if (!result.ok) {
    return { status: "pm2 unavailable" };
  }
  try {
    const apps = JSON.parse(result.stdout) as Array<Record<string, unknown>>;
    const app = apps.find((item) => item.name === managedProcessName);
    if (!app) {
      return { status: "not found" };
    }
    const pm2Env = app.pm2_env as Record<string, unknown> | undefined;
    return smoothPm2Status({
      status: String(pm2Env?.status || "unknown"),
      pid: typeof app.pid === "number" ? app.pid : undefined,
      restarts: typeof pm2Env?.restart_time === "number" ? pm2Env.restart_time : undefined,
    });
  } catch {
    return { status: "status parse failed" };
  }
}

function smoothPm2Status(status: Pm2Status): Pm2Status {
  if (status.status === "online" || status.status === "stopped") {
    lastStablePm2Status = status;
    return status;
  }
  if ((status.status === "stopping" || status.status === "launching" || status.status === "errored") && lastStablePm2Status) {
    return { ...lastStablePm2Status, rawStatus: status.status };
  }
  return status;
}

async function runPm2(action: string): Promise<{ ok: boolean; message: string }> {
  const result = await execPm2([action, managedProcessName]);
  if (!result.ok) {
    return { ok: false, message: result.stderr || result.stdout || `${action} failed.` };
  }
  const labels: Record<string, string> = { start: "启动", stop: "停止", restart: "重启" };
  return { ok: true, message: `已${labels[action] || action} ${managedProcessName}。` };
}

function execPm2(args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile("pm2", args, { cwd: process.cwd(), timeout: 30_000 }, (error, stdout, stderr) => {
      resolve({ ok: !error, stdout: stdout.toString(), stderr: stderr.toString() });
    });
  });
}

function isAllowedAction(action: string): action is "start" | "stop" | "restart" {
  return action === "start" || action === "stop" || action === "restart";
}

function isAuthenticated(request: IncomingMessage): boolean {
  const cookieHeader = request.headers.cookie || "";
  const session = cookieHeader
    .split(";")
    .map((item) => item.trim())
    .find((item) => item.startsWith(`${cookieName}=`))
    ?.slice(cookieName.length + 1);
  if (!session) {
    return false;
  }
  const [nonce, signature] = session.split(".");
  if (!nonce || !signature) {
    return false;
  }
  if (!safeEquals(sign(nonce), signature)) {
    return false;
  }
  try {
    const payload = JSON.parse(Buffer.from(nonce, "base64url").toString("utf8")) as { exp?: number };
    return typeof payload.exp === "number" && payload.exp > Math.floor(Date.now() / 1000);
  } catch {
    return true;
  }
}

function createSessionCookie(maxAgeSeconds: number): string {
  const payload = Buffer.from(JSON.stringify({ nonce: randomBytes(24).toString("base64url"), exp: Math.floor(Date.now() / 1000) + maxAgeSeconds })).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

function sign(value: string): string {
  return createHmac("sha256", sessionSecret).update(value).digest("base64url");
}

function safeEquals(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function parseForm(body: string): Record<string, string> {
  const params = new URLSearchParams(body);
  const fields: Record<string, string> = {};
  for (const [key, value] of params) {
    fields[key] = value;
  }
  return fields;
}

function isTruthy(value: string | undefined): boolean {
  return value === "on" || value === "true" || value === "1" || value === "yes";
}

function readSmartReplyTargetSwitchFields(fields: Record<string, string>): Record<string, boolean> {
  const switches: Record<string, boolean> = {};
  const prefix = "directSmartReplyByTarget.";
  for (const [key, value] of Object.entries(fields)) {
    if (key.startsWith(prefix)) {
      switches[decodeBase64Url(key.slice(prefix.length))] = isTruthy(value);
    }
  }
  return switches;
}

function smartReplyTargetFieldName(selector: string): string {
  return `directSmartReplyByTarget.${Buffer.from(selector).toString("base64url")}`;
}

function decodeBase64Url(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8");
}

function formatSmartReplyTargetLabel(selector: string): string {
  const separatorIndex = selector.indexOf(":");
  return separatorIndex === -1 ? selector : selector.slice(separatorIndex + 1).trim() || selector;
}

function readNameList(value: string | undefined, fallback: string[]): string[] {
  const raw = value?.trim();
  if (!raw) {
    return fallback;
  }
  return raw.split(",").map((item) => item.trim()).filter(Boolean);
}

function readRequestBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function sendHtml(response: ServerResponse, statusCode: number, html: string): void {
  response.writeHead(statusCode, { "Content-Type": "text/html; charset=utf-8" });
  response.end(html);
}

function sendJson(response: ServerResponse, statusCode: number, value: unknown): void {
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] || char);
}

function readPositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}