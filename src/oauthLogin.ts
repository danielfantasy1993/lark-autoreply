#!/usr/bin/env node
import { config as loadDotEnv } from "dotenv";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";

loadDotEnv({ path: resolve(dirname(fileURLToPath(import.meta.url)), "../.env") });

type AppAccessTokenResponse = {
  code?: number;
  msg?: string;
  app_access_token?: string;
  expire?: number;
};

type OAuthTokenResponse = {
  code?: number;
  msg?: string;
  access_token?: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number;
  refresh_expires_in?: number;
  scope?: string;
  data?: {
    access_token?: string;
    refresh_token?: string;
    token_type?: string;
    expires_in?: number;
    refresh_expires_in?: number;
    scope?: string;
  };
};

const appId = process.env.LARK_APP_ID;
const appSecret = process.env.LARK_APP_SECRET;
const baseUrl = (process.env.LARK_API_BASE_URL || "https://open.feishu.cn").replace(/\/$/, "");
const port = Number(process.env.LARK_OAUTH_PORT || 8787);
const host = process.env.LARK_OAUTH_HOST || "localhost";
const callbackPath = process.env.LARK_OAUTH_CALLBACK_PATH || "/oauth/callback";
const redirectUri = process.env.LARK_OAUTH_REDIRECT_URI || `http://${host}:${port}${callbackPath}`;
const oauthScopes = readScopes(process.env.LARK_OAUTH_SCOPES);
const includeOauthScopes = process.env.LARK_OAUTH_INCLUDE_SCOPES === "true";
const oauthScopeMode = readOAuthScopeMode(process.env.LARK_OAUTH_SCOPE_MODE);
const state = randomBytes(16).toString("hex");
const tokenFile = resolve(dirname(fileURLToPath(import.meta.url)), "../.lark-user-token.json");

if (!appId || !appSecret) {
  throw new Error("Missing LARK_APP_ID or LARK_APP_SECRET environment variables.");
}

const authorizeUrl = buildAuthorizeUrl();

const server = createServer(async (request, response) => {
  try {
    await handleRequest(request, response);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendHtml(response, 500, "OAuth failed", `<pre>${escapeHtml(message)}</pre>`);
  }
});

server.listen(port, () => {
  console.log(`OAuth callback server listening on ${redirectUri}`);
  console.log("Open this URL to authorize your Feishu/Lark user identity:");
  console.log(authorizeUrl);
  openBrowser(authorizeUrl);
});

async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const requestUrl = new URL(request.url ?? "/", redirectUri);

  if (requestUrl.pathname !== callbackPath) {
    sendHtml(response, 200, "Feishu OAuth Login", buildAuthorizeLinkHtml());
    return;
  }

  const error = requestUrl.searchParams.get("error");
  if (error) {
    const errorDescription = requestUrl.searchParams.get("error_description") ?? "";
    sendHtml(response, 400, "Authorization denied", `<pre>${escapeHtml(`${error}\n${errorDescription}`)}</pre>`);
    return;
  }

  const returnedState = requestUrl.searchParams.get("state");
  if (returnedState !== state) {
    sendHtml(response, 400, "Invalid state", "<p>The OAuth state value did not match. Please restart the login command.</p>");
    return;
  }

  const code = requestUrl.searchParams.get("code");
  if (!code) {
    sendHtml(response, 400, "Missing code", "<p>The callback URL did not include an authorization code.</p>");
    return;
  }

  const appAccessToken = await getAppAccessToken();
  const tokenPayload = await exchangeCodeForUserToken(appAccessToken, code);
  const tokenData = tokenPayload.data ?? tokenPayload;
  if (!tokenData?.access_token) {
    throw new Error(`OAuth token response did not include access_token: ${JSON.stringify(tokenPayload, null, 2)}`);
  }

  const saved = {
    access_token: tokenData.access_token,
    refresh_token: tokenData.refresh_token,
    token_type: tokenData.token_type,
    expires_at: Date.now() + Math.max((tokenData.expires_in ?? 0) - 60, 0) * 1000,
    refresh_expires_at: tokenData.refresh_expires_in ? Date.now() + tokenData.refresh_expires_in * 1000 : undefined,
    scope: tokenData.scope,
    created_at: new Date().toISOString()
  };

  await writeFile(tokenFile, JSON.stringify(saved, null, 2), "utf8");
  sendHtml(response, 200, "Authorization successful", `<p>User access token saved locally.</p><p>You can close this tab and return to VS Code.</p><p><code>${escapeHtml(tokenFile)}</code></p>`);
  console.log(`Saved user token to ${tokenFile}`);
  server.close();
}

async function getAppAccessToken(): Promise<string> {
  const response = await fetch(`${baseUrl}/open-apis/auth/v3/app_access_token/internal`, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret })
  });
  const responseText = await response.text();
  const payload = parseJson(responseText) as AppAccessTokenResponse;
  if (!response.ok || payload.code !== 0 || !payload.app_access_token) {
    throw new Error(`Failed to get app_access_token: ${responseText}`);
  }
  return payload.app_access_token;
}

async function exchangeCodeForUserToken(appAccessToken: string, code: string): Promise<OAuthTokenResponse> {
  const response = await fetch(`${baseUrl}/open-apis/authen/v2/oauth/token`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${appAccessToken}`,
      "Content-Type": "application/json; charset=utf-8"
    },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code,
      client_id: appId,
      client_secret: appSecret,
      redirect_uri: redirectUri
    })
  });
  const responseText = await response.text();
  const payload = parseJson(responseText) as OAuthTokenResponse;
  if (!response.ok || payload.code !== 0) {
    throw new Error(`Failed to exchange code for user_access_token: ${responseText}`);
  }
  return payload;
}

function openBrowser(url: string): void {
  const command = process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.unref();
}

function buildAuthorizeUrl(): string {
  const query = new Map<string, string>();
  query.set("app_id", appId ?? "");
  query.set("redirect_uri", redirectUri);
  query.set("state", state);

  const requestedScopes = buildRequestedScopes();
  if (requestedScopes.length > 0) {
    query.set("scope", requestedScopes.join(" "));
  }

  const queryText = [...query]
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
  return `${baseUrl}/open-apis/authen/v1/authorize?${queryText}`;
}

function buildAuthorizeLinkHtml(): string {
  return `<p>OAuth server is running.</p><p><a href="${escapeHtml(authorizeUrl)}">Start authorization</a></p>`;
}

function sendHtml(response: ServerResponse, statusCode: number, title: string, body: string): void {
  response.writeHead(statusCode, { "Content-Type": "text/html; charset=utf-8" });
  response.end(`<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body><h1>${escapeHtml(title)}</h1>${body}</body></html>`);
}

function parseJson(text: string): unknown {
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char);
}

function readScopes(value: string | undefined): string[] {
  return (value ?? "")
    .split(/[\s,，|]+/)
    .map((scope) => scope.trim())
    .filter(Boolean);
}

function buildRequestedScopes(): string[] {
  if (oauthScopeMode === "offline") {
    return ["offline_access"];
  }

  if (oauthScopeMode === "full_with_offline") {
    return uniqueScopes([...oauthScopes, "offline_access"]);
  }

  if (oauthScopeMode === "full" || includeOauthScopes) {
    return uniqueScopes(oauthScopes);
  }

  return [];
}

function readOAuthScopeMode(value: string | undefined): "default" | "offline" | "full" | "full_with_offline" {
  if (value === "offline" || value === "full" || value === "full_with_offline") {
    return value;
  }
  return "default";
}

function uniqueScopes(scopes: string[]): string[] {
  return [...new Set(scopes.filter(Boolean))];
}