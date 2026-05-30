export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type LarkApiOptions = {
  method: HttpMethod;
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
};

export type SendTextMessageOptions = {
  receiveIdType: "open_id" | "user_id" | "union_id" | "email" | "chat_id";
  receiveId: string;
  text: string;
};

type TenantTokenResponse = {
  code?: number;
  msg?: string;
  tenant_access_token?: string;
  expire?: number;
};

export class LarkClient {
  private tenantAccessToken?: string;
  private tokenExpiresAt = 0;

  constructor(
    private readonly appId: string,
    private readonly appSecret: string,
    private readonly baseUrl = "https://open.feishu.cn"
  ) {}

  static fromEnv(): LarkClient {
    const appId = process.env.LARK_APP_ID;
    const appSecret = process.env.LARK_APP_SECRET;
    const baseUrl = process.env.LARK_API_BASE_URL || "https://open.feishu.cn";

    if (!appId || !appSecret) {
      throw new Error("Missing LARK_APP_ID or LARK_APP_SECRET environment variables.");
    }

    return new LarkClient(appId, appSecret, baseUrl.replace(/\/$/, ""));
  }

  async sendTextMessage(options: SendTextMessageOptions): Promise<unknown> {
    return this.request({
      method: "POST",
      path: "/open-apis/im/v1/messages",
      query: { receive_id_type: options.receiveIdType },
      body: {
        receive_id: options.receiveId,
        msg_type: "text",
        content: JSON.stringify({ text: options.text })
      }
    });
  }

  async listChats(pageSize = 20, pageToken?: string): Promise<unknown> {
    return this.request({
      method: "GET",
      path: "/open-apis/im/v1/chats",
      query: {
        page_size: pageSize,
        page_token: pageToken
      }
    });
  }

  async request(options: LarkApiOptions): Promise<unknown> {
    const token = await this.getTenantAccessToken();
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
      throw new Error(`Lark API ${response.status} ${response.statusText}: ${responseText}`);
    }

    return payload;
  }

  private async getTenantAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.tenantAccessToken && now < this.tokenExpiresAt) {
      return this.tenantAccessToken;
    }

    const response = await fetch(`${this.baseUrl}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ app_id: this.appId, app_secret: this.appSecret })
    });

    const responseText = await response.text();
    const payload = parseJson(responseText) as TenantTokenResponse;

    if (!response.ok || payload.code !== 0 || !payload.tenant_access_token) {
      throw new Error(`Failed to get tenant_access_token: ${responseText}`);
    }

    this.tenantAccessToken = payload.tenant_access_token;
    this.tokenExpiresAt = now + Math.max((payload.expire ?? 7200) - 300, 60) * 1000;
    return this.tenantAccessToken;
  }

  private buildUrl(path: string, query?: LarkApiOptions["query"]): string {
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