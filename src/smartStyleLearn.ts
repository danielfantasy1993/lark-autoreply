#!/usr/bin/env node
import { config as loadDotEnv } from "dotenv";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { extractMessageText, type SmartReplyConversationMessage } from "./smartReply.js";
import { LarkUserClient } from "./userTokenClient.js";

type AutoReplyState = {
  targets?: Record<string, TargetState>;
};

type TargetState = {
  chatId?: string;
  openId?: string;
  isExternal?: boolean;
};

type Message = {
  message_id?: string;
  msg_type?: string;
  create_time?: string;
  content?: string;
  body?: {
    content?: string;
  };
  sender?: {
    sender_id?: {
      open_id?: string;
    };
  };
};

type ApiList<T> = {
  data?: {
    items?: T[];
    has_more?: boolean;
    page_token?: string;
  };
};

type UserInfoResponse = {
  data?: {
    open_id?: string;
  };
};

type LearnedCase = {
  id: string;
  targetName: string;
  incomingMessage: string;
  conversation: SmartReplyConversationMessage[];
  idealReply: string;
};

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
loadDotEnv({ path: resolve(rootDir, ".env") });

const tokenFile = resolvePath(process.env.LARK_USER_TOKEN_FILE || ".lark-user-token.json");
const stateFile = resolvePath(process.env.LARK_AUTOREPLY_STATE_FILE || ".lark-auto-reply-state.json");
const lookbackDays = readPositiveInteger(process.env.LARK_STYLE_LEARN_LOOKBACK_DAYS, 14);
const maxChats = readPositiveInteger(process.env.LARK_STYLE_LEARN_MAX_CHATS, 20);
const maxCases = readPositiveInteger(process.env.LARK_STYLE_LEARN_MAX_CASES, 120);
const maxMessagesPerChat = readPositiveInteger(process.env.LARK_STYLE_LEARN_MAX_MESSAGES_PER_CHAT, 200);
const learnMode = readLearnMode(process.env.LARK_STYLE_LEARN_MODE);
const outputCasesFile = resolvePath(process.env.LARK_STYLE_LEARN_CASES_FILE || ".training/learned-reply-cases.json");
const outputProfileFile = resolvePath(process.env.LARK_SMART_REPLY_LEARNED_STYLE_FILE || ".training/style-profile.md");
const autoReplyPrefix = process.env.LARK_AUTOREPLY_PREFIX ?? "AR:";

async function main(): Promise<void> {
  const client = LarkUserClient.fromEnv(tokenFile);
  const selfOpenId = await getSelfOpenId(client);
  if (!selfOpenId) {
    throw new Error("Could not read current user open_id.");
  }

  const state = await readState();
  const targets = Object.entries(state.targets ?? {})
    .map(([key, target]) => ({ key, ...target }))
    .filter((target): target is { key: string; chatId: string; openId: string; isExternal?: boolean } => Boolean(target.chatId && target.openId))
    .slice(0, maxChats);

  const cases: LearnedCase[] = [];
  const endTime = Math.floor(Date.now() / 1000);
  const startTime = endTime - lookbackDays * 24 * 60 * 60;

  for (const target of targets) {
    const messages = await listMessages(client, target.chatId, startTime, endTime).catch((error) => {
      console.warn(`Could not learn from ${target.key}: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    });
    cases.push(...extractCases(target.key, target.openId, selfOpenId, messages));
    if (cases.length >= maxCases) {
      break;
    }
  }

  const selectedCases = cases.slice(0, maxCases);
  await mkdir(dirname(outputCasesFile), { recursive: true });
  await writeFile(outputCasesFile, `${JSON.stringify({ generatedAt: new Date().toISOString(), cases: selectedCases }, null, 2)}\n`, "utf8");

  const profile = buildStyleProfile(selectedCases);
  await mkdir(dirname(outputProfileFile), { recursive: true });
  await writeFile(outputProfileFile, `${profile}\n`, "utf8");

  console.log(`Learned ${selectedCases.length} reply case(s) from ${targets.length} chat(s) using ${learnMode} mode.`);
  console.log(`Saved cases to ${outputCasesFile}`);
  console.log(`Saved style profile to ${outputProfileFile}`);
}

async function getSelfOpenId(client: LarkUserClient): Promise<string | undefined> {
  const response = await client.request<UserInfoResponse>({ method: "GET", path: "/open-apis/authen/v1/user_info" });
  return response.data?.open_id;
}

async function readState(): Promise<AutoReplyState> {
  return JSON.parse(await readFile(stateFile, "utf8")) as AutoReplyState;
}

async function listMessages(client: LarkUserClient, chatId: string, startTime: number, endTime: number): Promise<Message[]> {
  const messages: Message[] = [];
  let pageToken: string | undefined;
  do {
    const response = await client.request<ApiList<Message>>({
      method: "GET",
      path: "/open-apis/im/v1/messages",
      query: {
        container_id_type: "chat",
        container_id: chatId,
        start_time: startTime,
        end_time: endTime,
        sort_type: "ByCreateTimeAsc",
        page_size: 50,
        page_token: pageToken
      }
    });
    messages.push(...(response.data?.items ?? []));
    pageToken = response.data?.has_more && messages.length < maxMessagesPerChat ? response.data.page_token : undefined;
  } while (pageToken);

  return messages.slice(0, maxMessagesPerChat);
}

function extractCases(targetName: string, targetOpenId: string, selfOpenId: string, messages: Message[]): LearnedCase[] {
  if (learnMode === "broad") {
    return extractBroadCases(targetName, selfOpenId, messages);
  }

  const cases: LearnedCase[] = [];
  for (let index = 0; index < messages.length - 1; index += 1) {
    const incoming = messages[index];
    if (getSenderOpenId(incoming) !== targetOpenId) {
      continue;
    }
    const replyIndex = messages.findIndex((message, candidateIndex) => candidateIndex > index && getSenderOpenId(message) === selfOpenId && readMessageCreateTime(message) - readMessageCreateTime(incoming) <= 15 * 60);
    if (replyIndex === -1) {
      continue;
    }
    const reply = messages[replyIndex];
    const incomingText = extractMessageText(incoming.msg_type, incoming.content ?? incoming.body?.content);
    const replyText = extractMessageText(reply.msg_type, reply.content ?? reply.body?.content);
    if (!isUsableText(incomingText) || !isUsableText(replyText)) {
      continue;
    }
    const context = messages.slice(Math.max(0, index - 6), replyIndex).map((message): SmartReplyConversationMessage => ({
      speaker: getSenderOpenId(message) === selfOpenId ? "me" : getSenderOpenId(message) === targetOpenId ? "target" : "other",
      text: extractMessageText(message.msg_type, message.content ?? message.body?.content),
      createdAt: readMessageCreateTime(message)
    }));
    cases.push({
      id: `${targetName}-${incoming.message_id ?? index}`,
      targetName,
      incomingMessage: incomingText,
      conversation: context,
      idealReply: replyText
    });
  }
  return learnMode === "both" ? dedupeCases([...cases, ...extractBroadCases(targetName, selfOpenId, messages)]) : cases;
}

function extractBroadCases(targetName: string, selfOpenId: string, messages: Message[]): LearnedCase[] {
  const cases: LearnedCase[] = [];
  for (let replyIndex = 1; replyIndex < messages.length; replyIndex += 1) {
    const reply = messages[replyIndex];
    if (getSenderOpenId(reply) !== selfOpenId) {
      continue;
    }

    const incomingIndex = findNearestIncomingIndex(messages, replyIndex, selfOpenId);
    if (incomingIndex === -1) {
      continue;
    }

    const incoming = messages[incomingIndex];
    const incomingSenderOpenId = getSenderOpenId(incoming);
    if (!incomingSenderOpenId) {
      continue;
    }

    const incomingText = extractMessageText(incoming.msg_type, incoming.content ?? incoming.body?.content);
    const replyText = extractMessageText(reply.msg_type, reply.content ?? reply.body?.content);
    if (!isUsableText(incomingText) || !isUsableText(replyText)) {
      continue;
    }

    const context = messages.slice(Math.max(0, incomingIndex - 6), replyIndex).map((message): SmartReplyConversationMessage => ({
      speaker: getSenderOpenId(message) === selfOpenId ? "me" : getSenderOpenId(message) === incomingSenderOpenId ? "target" : "other",
      text: extractMessageText(message.msg_type, message.content ?? message.body?.content),
      createdAt: readMessageCreateTime(message)
    }));

    cases.push({
      id: `${targetName}-${incoming.message_id ?? incomingIndex}-${reply.message_id ?? replyIndex}`,
      targetName,
      incomingMessage: incomingText,
      conversation: context,
      idealReply: replyText
    });
  }
  return cases;
}

function findNearestIncomingIndex(messages: Message[], replyIndex: number, selfOpenId: string): number {
  const replyTime = readMessageCreateTime(messages[replyIndex]);
  for (let index = replyIndex - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const senderOpenId = getSenderOpenId(message);
    const ageSeconds = replyTime - readMessageCreateTime(message);
    if (ageSeconds > 15 * 60) {
      return -1;
    }
    if (senderOpenId && senderOpenId !== selfOpenId) {
      return index;
    }
  }
  return -1;
}

function dedupeCases(cases: LearnedCase[]): LearnedCase[] {
  const seen = new Set<string>();
  return cases.filter((item) => {
    const key = `${item.incomingMessage}\n${item.idealReply}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function buildStyleProfile(cases: LearnedCase[]): string {
  const replies = cases.map((item) => item.idealReply);
  const avgLength = replies.length ? Math.round(replies.reduce((sum, reply) => sum + reply.length, 0) / replies.length) : 0;
  const shortRatio = replies.length ? replies.filter((reply) => reply.length <= 20).length / replies.length : 0;
  const sampleReplies = replies.slice(0, 12).map((reply) => `- ${reply}`).join("\n");
  const commonOpeners = topPhrases(replies.map((reply) => reply.slice(0, 4)), 8).join("、") || "无明显固定开头";
  const commonWords = topPhrases(replies.flatMap((reply) => reply.match(/[\u4e00-\u9fa5A-Za-z0-9]{2,4}/g) ?? []), 16).join("、") || "无";

  return [
    "# 自动学习到的回复风格",
    "",
    `- 样本数：${cases.length}`,
    `- 平均回复长度：约 ${avgLength} 字`,
    `- 短回复占比：${Math.round(shortRatio * 100)}%`,
    `- 常见开头：${commonOpeners}`,
    `- 高频短语：${commonWords}`,
    "- 优先模仿用户真实回复：短、直接、口语化，少解释，不要客服腔。",
    "- 如果上下文显示用户已经纠正过误解，要先承认误解，不要继续强行解释。",
    "",
    "## 真实回复样例",
    sampleReplies || "（暂无）"
  ].join("\n");
}

function topPhrases(values: string[], limit: number): string[] {
  const counts = new Map<string, number>();
  for (const value of values.map((item) => item.trim()).filter((item) => item.length >= 2)) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, limit)
    .map(([value]) => value);
}

function getSenderOpenId(message: Message): string | undefined {
  return message.sender?.sender_id?.open_id;
}

function readMessageCreateTime(message: Message): number {
  const value = Number(message.create_time ?? 0);
  return value > 10_000_000_000 ? Math.floor(value / 1000) : value;
}

function isUsableText(text: string): boolean {
  const trimmedText = text.trim();
  return Boolean(trimmedText && trimmedText.length <= 500 && !(autoReplyPrefix && trimmedText.startsWith(autoReplyPrefix)) && !trimmedText.includes("自动回复：") && !trimmedText.includes("我现在不在"));
}

function readPositiveInteger(value: string | undefined, fallback: number): number {
  const numberValue = Number(value);
  return Number.isInteger(numberValue) && numberValue > 0 ? numberValue : fallback;
}

function readLearnMode(value: string | undefined): "target" | "broad" | "both" {
  return value === "target" || value === "both" ? value : "broad";
}

function resolvePath(value: string): string {
  return resolve(rootDir, value);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});