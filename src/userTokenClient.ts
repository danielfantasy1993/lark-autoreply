import { readFile, writeFile } from "node:fs/promises";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type UserApiOptions = {
  method: HttpMethod;
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
};

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

export type UserTokenFile = {
  access_token: string;
  refresh_token?: string;
  token_type?: string;
  expires_at?: number;
  refresh_expires_at?: number;
  scope?: string;
  created_at?: string;
  updated_at?: string;
};

export class LarkUserClient {
  private token?: UserTokenFile;

  constructor(
    private readonly appId: string,
    private readonly appSecret: string,
    private readonly baseUrl: string,
    private readonly tokenFile: string
  ) {}

  static fromEnv(tokenFile: string): LarkUserClient {
    const appId = process.env.LARK_APP_ID;
    const appSecret = process.env.LARK_APP_SECRET;
    const baseUrl = (process.env.LARK_API_BASE_URL || "https://open.feishu.cn").replace(/\/$/, "");

    if (!appId || !appSecret) {
      throw new Error("Missing LARK_APP_ID or LARK_APP_SECRET environment variables.");
    }

    return new LarkUserClient(appId, appSecret, baseUrl, tokenFile);
  }

  async request<T = unknown>(options: UserApiOptions): Promise<T> {
    const token = await this.getAccessToken();
    const url = this.buildUrl(options.path, options.query);
    const response = await fetch(url, {
      method: options.method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8"
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body)
    });

    const responseText = await response.text();
    const payload = parseJson(responseText) as { code?: number; msg?: string };

    if (!response.ok || (typeof payload.code === "number" && payload.code !== 0)) {
      throw new Error(`Lark user API ${response.status} ${response.statusText}: ${responseText}`);
    }

    return payload as T;
  }

  private async getAccessToken(): Promise<string> {
    const token = await this.readToken();
    const now = Date.now();

    if (token.access_token && (!token.expires_at || now < token.expires_at - 60_000)) {
      return token.access_token;
    }

    return this.refreshAccessToken(token);
  }

  private async readToken(): Promise<UserTokenFile> {
    if (this.token) {
      return this.token;
    }

    const text = await readFile(this.tokenFile, "utf8");
    const token = parseJson(text) as Partial<UserTokenFile>;
    if (!token.access_token) {
      throw new Error(`User token file does not include access_token: ${this.tokenFile}`);
    }

    this.token = token as UserTokenFile;
    return this.token;
  }

  private async refreshAccessToken(token: UserTokenFile): Promise<string> {
    if (!token.refresh_token) {
      throw new Error("User access token expired and no refresh_token is available. Run npm.cmd run oauth:login again.");
    }

    const appAccessToken = await this.getAppAccessToken();
    const response = await fetch(`${this.baseUrl}/open-apis/authen/v2/oauth/token`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${appAccessToken}`,
        "Content-Type": "application/json; charset=utf-8"
      },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: token.refresh_token,
        client_id: this.appId,
        client_secret: this.appSecret
      })
    });

    const responseText = await response.text();
    const payload = parseJson(responseText) as OAuthTokenResponse;
    if (!response.ok || payload.code !== 0) {
      throw new Error(`Failed to refresh user_access_token: ${responseText}`);
    }

    const tokenData = payload.data ?? payload;
    if (!tokenData.access_token) {
      throw new Error(`Refresh response did not include access_token: ${responseText}`);
    }

    const nextToken: UserTokenFile = {
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token ?? token.refresh_token,
      token_type: tokenData.token_type ?? token.token_type,
      expires_at: Date.now() + Math.max((tokenData.expires_in ?? 0) - 60, 0) * 1000,
      refresh_expires_at: tokenData.refresh_expires_in ? Date.now() + tokenData.refresh_expires_in * 1000 : token.refresh_expires_at,
      scope: tokenData.scope ?? token.scope,
      created_at: token.created_at,
      updated_at: new Date().toISOString()
    };

    await writeFile(this.tokenFile, `${JSON.stringify(nextToken, null, 2)}\n`, "utf8");
    this.token = nextToken;
    return nextToken.access_token;
  }

  private async getAppAccessToken(): Promise<string> {
    const response = await fetch(`${this.baseUrl}/open-apis/auth/v3/app_access_token/internal`, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ app_id: this.appId, app_secret: this.appSecret })
    });

    const responseText = await response.text();
    const payload = parseJson(responseText) as AppAccessTokenResponse;
    if (!response.ok || payload.code !== 0 || !payload.app_access_token) {
      throw new Error(`Failed to get app_access_token: ${responseText}`);
    }

    return payload.app_access_token;
  }

  private buildUrl(path: string, query?: UserApiOptions["query"]): string {
    if (!path.startsWith("/")) {
      throw new Error("Lark API path must start with '/'.");
    }

    const url = new URL(path, this.baseUrl);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }
}

function parseJson(text: string): unknown {
  if (!text) {
    return {};
  }

  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}