#!/usr/bin/env node
import { McpServer, StdioServerTransport } from "@modelcontextprotocol/server";
import { config as loadDotEnv } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as z from "zod/v4";
import { LarkClient } from "./larkClient.js";

loadDotEnv({ path: resolve(dirname(fileURLToPath(import.meta.url)), "../.env") });

const server = new McpServer({
  name: "lark-copilot-mcp",
  version: "0.1.0"
});

const client = LarkClient.fromEnv();

server.registerTool(
  "feishu_send_text_message",
  {
    description: "Send a plain text message to a Feishu/Lark user or chat.",
    inputSchema: z.object({
      receiveIdType: z.enum(["open_id", "user_id", "union_id", "email", "chat_id"]).describe("Identifier type used by receiveId."),
      receiveId: z.string().min(1).describe("Recipient id, for example chat_id, open_id, user_id, union_id, or email."),
      text: z.string().min(1).describe("Plain text message content.")
    })
  },
  async ({ receiveIdType, receiveId, text }) => {
    const result = await client.sendTextMessage({ receiveIdType, receiveId, text });
    return asTextContent(result);
  }
);

server.registerTool(
  "feishu_list_chats",
  {
    description: "List Feishu/Lark chats that the app bot can access.",
    inputSchema: z.object({
      pageSize: z.number().int().min(1).max(100).default(20),
      pageToken: z.string().optional()
    })
  },
  async ({ pageSize, pageToken }) => {
    const result = await client.listChats(pageSize, pageToken);
    return asTextContent(result);
  }
);

server.registerTool(
  "feishu_api_request",
  {
    description: "Call any Feishu/Lark Open Platform API endpoint with tenant_access_token authentication.",
    inputSchema: z.object({
      method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
      path: z.string().startsWith("/").describe("API path, for example /open-apis/contact/v3/users/batch_get_id."),
      query: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
      body: z.unknown().optional()
    })
  },
  async ({ method, path, query, body }) => {
    const result = await client.request({ method, path, query, body });
    return asTextContent(result);
  }
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

function asTextContent(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value, null, 2)
      }
    ]
  };
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});