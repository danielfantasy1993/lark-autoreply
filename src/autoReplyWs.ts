#!/usr/bin/env node
import * as lark from "@larksuiteoapi/node-sdk";
import { config as loadDotEnv } from "dotenv";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LarkUserClient } from "./userTokenClient.js";

loadDotEnv({ path: resolve(dirname(fileURLToPath(import.meta.url)), "../.env") });

type ApiList<T> = {
  data?: {
    items?: T[];
  };
};

type UserSearchItem = {
  id?: string;
  open_id?: string;
  user_id?: string;
  name?: string;
  en_name?: string;
  display_info?: string;
  meta_data?: {
    chat_id?: string;
    enterprise_mail_address?: string;
    is_cross_tenant?: boolean;
    i18n_names?: Record<string, string>;
  };
};

type MessageReceiveEvent = {
  sender?: {
    sender_id?: {
      open_id?: string;
      user_id?: string;
      union_id?: string;
    };
  };
  message?: {
    chat_id?: string;
    message_id?: string;
  };
};

type AutoReplyState = {
  targetOpenId?: string;
  repliedMessageIds?: string[];
  lastReplyAtByChat?: Record<string, number>;
};

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tokenFile = resolvePath(process.env.LARK_USER_TOKEN_FILE || ".lark-user-token.json");
const stateFile = resolvePath(process.env.LARK_AUTOREPLY_STATE_FILE || ".lark-auto-reply-state.json");
const appId = process.env.LARK_APP_ID;
const appSecret = process.env.LARK_APP_SECRET;
const targetName = process.env.LARK_AUTOREPLY_TARGET_NAME || "何运伟";
const replyText = process.env.LARK_AUTOREPLY_TEXT || "我在出差，请留言。";
const cooldownMinutes = readNonNegativeNumber(process.env.LARK_AUTOREPLY_COOLDOWN_MINUTES, 0);

if (!appId || !appSecret) {
  throw new Error("Missing LARK_APP_ID or LARK_APP_SECRET environment variables.");
}

const larkAppId = appId;
const larkAppSecret = appSecret;

const userClient = LarkUserClient.fromEnv(tokenFile);

async function main(): Promise<void> {
  const state = await loadState();
  state.targetOpenId = process.env.LARK_AUTOREPLY_TARGET_OPEN_ID || state.targetOpenId || (await findTargetOpenId());
  state.repliedMessageIds ??= [];
  state.lastReplyAtByChat ??= {};
  await saveState(state);

  const wsClient = new lark.WSClient({
    appId: larkAppId,
    appSecret: larkAppSecret,
    loggerLevel: lark.LoggerLevel.info
  });

  wsClient.start({
    eventDispatcher: new lark.EventDispatcher({}).register({
      "im.message.receive_v1": async (data: MessageReceiveEvent) => {
        await handleMessageEvent(data, state);
      }
    })
  });

  console.log("Auto reply long connection is running.");
  console.log(`Target: ${targetName}`);
  console.log(`Reply text: ${replyText}`);
}

async function handleMessageEvent(data: MessageReceiveEvent, state: AutoReplyState): Promise<void> {
  state.targetOpenId ??= await findTargetOpenId();
  if (!state.targetOpenId) {
    console.warn(`Could not resolve target user ${targetName}. Set LARK_AUTOREPLY_TARGET_OPEN_ID in .env if names are ambiguous.`);
    return;
  }

  const senderOpenId = data.sender?.sender_id?.open_id;
  const chatId = data.message?.chat_id;
  const messageId = data.message?.message_id;
  if (!senderOpenId || !chatId || !messageId) {
    return;
  }

  if (senderOpenId !== state.targetOpenId) {
    return;
  }

  if (state.repliedMessageIds?.includes(messageId)) {
    return;
  }

  const lastReplyAt = state.lastReplyAtByChat?.[chatId] ?? 0;
  if (Date.now() - lastReplyAt < cooldownMinutes * 60_000) {
    return;
  }

  await sendTextMessage(chatId, messageId);
  state.repliedMessageIds = [...(state.repliedMessageIds ?? []), messageId].slice(-200);
  state.lastReplyAtByChat = { ...(state.lastReplyAtByChat ?? {}), [chatId]: Date.now() };
  await saveState(state);
  console.log(`Replied to ${targetName} in chat ${chatId}.`);
}

async function findTargetOpenId(): Promise<string | undefined> {
  const response = await userClient.request<ApiList<UserSearchItem>>({
    method: "POST",
    path: "/open-apis/contact/v3/users/search",
    query: { user_id_type: "open_id" },
    body: { query: targetName, page_size: 10 }
  });

  const items = response.data?.items ?? [];
  const target = pickTargetUser(items);
  const targetOpenId = target?.open_id ?? target?.id;
  const targetDisplayName = target?.name ?? target?.meta_data?.i18n_names?.zh_cn ?? target?.display_info;
  if (targetOpenId && targetDisplayName && !targetDisplayName.includes(targetName)) {
    console.warn(`Using closest target match "${targetDisplayName}" for configured name "${targetName}".`);
  }
  return targetOpenId;
}

function pickTargetUser(items: UserSearchItem[]): UserSearchItem | undefined {
  return (
    items.find((item) => item.meta_data?.is_cross_tenant === false && (item.display_info?.includes(targetName) || item.meta_data?.i18n_names?.zh_cn?.includes(targetName))) ??
    items.find((item) => item.display_info?.includes(targetName) || item.meta_data?.i18n_names?.zh_cn?.includes(targetName)) ??
    items[0]
  );
}

async function sendTextMessage(chatId: string, sourceMessageId: string): Promise<void> {
  await userClient.request({
    method: "POST",
    path: "/open-apis/im/v1/messages",
    query: { receive_id_type: "chat_id" },
    body: {
      receive_id: chatId,
      msg_type: "text",
      content: JSON.stringify({ text: replyText }),
      uuid: `ar-${shortHash(sourceMessageId)}`
    }
  });
}

async function loadState(): Promise<AutoReplyState> {
  try {
    return JSON.parse(await readFile(stateFile, "utf8")) as AutoReplyState;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

async function saveState(state: AutoReplyState): Promise<void> {
  await writeFile(stateFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function resolvePath(path: string): string {
  return resolve(rootDir, path);
}

function readPositiveNumber(value: string | undefined, fallback: number): number {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) && numberValue > 0 ? numberValue : fallback;
}

function readNonNegativeNumber(value: string | undefined, fallback: number): number {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) && numberValue >= 0 ? numberValue : fallback;
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});