#!/usr/bin/env node
import { config as loadDotEnv } from "dotenv";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LarkClient } from "./larkClient.js";
import { getKnowledgeIndexFile, loadKnowledgeIndex, readKnowledgeKeywords, searchKnowledge, type KnowledgeIndex } from "./knowledgeStore.js";
import { createSmartReplyGenerator, extractMessageText, type SmartReplyConversationMessage, type SmartReplyGenerator } from "./smartReply.js";
import { LarkUserClient } from "./userTokenClient.js";

loadDotEnv({ path: resolve(dirname(fileURLToPath(import.meta.url)), "../.env") });

type ApiList<T> = {
  code?: number;
  msg?: string;
  data?: {
    items?: T[];
    has_more?: boolean;
    page_token?: string;
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

type DepartmentSearchItem = {
  department_id?: string;
  open_department_id?: string;
  name?: string;
  i18n_name?: Record<string, string>;
};

type UserInfoResponse = {
  data?: {
    open_id?: string;
    user_id?: string;
    name?: string;
  };
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
    id?: string;
    id_type?: string;
    sender_type?: string;
    sender_id?: {
      open_id?: string;
      user_id?: string;
      union_id?: string;
    };
  };
};

type AutoReplyState = {
  chatId?: string;
  targetOpenId?: string;
  lastCheckedAt?: number;
  repliedMessageIds?: string[];
  lastReplyAtByChat?: Record<string, number>;
  targets?: Record<string, TargetState>;
};

type TargetState = {
  chatId?: string;
  openId?: string;
  isExternal?: boolean;
  lastCheckedAt?: number;
};

type ResolvedTarget = {
  key: string;
  name: string;
  openId: string;
  chatId: string;
  source: string;
  isExternal: boolean;
};

type TargetSpec =
  | {
      type: "person";
      value: string;
      label: string;
    }
  | {
      type: "external_person";
      value: string;
      label: string;
    }
  | {
      type: "department";
      value: string;
      label: string;
    }
  | {
      type: "department_id";
      value: string;
      label: string;
    };

type PageResult<T> = {
  items: T[];
  pageToken?: string;
  hasMore: boolean;
};

type ReplyMode = "fixed" | "smart" | "mixed";

type PollTargetsResult = {
  polled: number;
  failures: number;
  rateLimited: number;
};

type FixedReplySuppressWindow = {
  days: number[];
  startMinute: number;
  endMinute: number;
};

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tokenFile = resolvePath(process.env.LARK_USER_TOKEN_FILE || ".lark-user-token.json");
const stateFile = resolvePath(process.env.LARK_AUTOREPLY_STATE_FILE || ".lark-auto-reply-state.json");
const targetName = process.env.LARK_AUTOREPLY_TARGET_NAME || "陈威";
const targetSpecs = readTargetSpecs();
const smartReplyTargetNames = readNameList(process.env.LARK_SMART_REPLY_TARGET_NAMES, ["李文贤", "何运伟"]);
const excludedTargetNames = readNameList(process.env.LARK_AUTOREPLY_EXCLUDE_TARGET_NAMES, []);
const replyMode = readReplyMode();
const replyTexts = readReplyTexts();
const fixedReplySuppressWindowsEnabled = process.env.LARK_AUTOREPLY_FIXED_REPLY_SUPPRESS_WINDOWS_ENABLED === "true";
const fixedReplySuppressWindows = readFixedReplySuppressWindows();
const pollIntervalMs = readPollIntervalMs();
const pollConcurrency = readPositiveInteger(process.env.LARK_AUTOREPLY_POLL_CONCURRENCY, 10);
const priorityPollConcurrency = readPositiveInteger(process.env.LARK_AUTOREPLY_PRIORITY_POLL_CONCURRENCY, Math.min(pollConcurrency, 5));
const fullPollIntervalMs = readNonNegativeInteger(process.env.LARK_AUTOREPLY_FULL_POLL_MS, Math.max(pollIntervalMs, 10_000));
const rateLimitBackoffMs = readPositiveInteger(process.env.LARK_AUTOREPLY_RATE_LIMIT_BACKOFF_MS, 3_000);
const maxRateLimitBackoffMs = readPositiveInteger(process.env.LARK_AUTOREPLY_MAX_BACKOFF_MS, 30_000);
const lookbackSeconds = readPositiveNumber(process.env.LARK_AUTOREPLY_LOOKBACK_SECONDS, 300);
const contextLookbackSeconds = readPositiveNumber(process.env.LARK_SMART_REPLY_CONTEXT_SECONDS, 24 * 60 * 60);
const maxSmartReplyContextMessages = readPositiveInteger(process.env.LARK_SMART_REPLY_MAX_CONTEXT_MESSAGES, 60);
const replyExisting = process.env.LARK_AUTOREPLY_REPLY_EXISTING === "true";
const maxDepartmentUsers = readPositiveNumber(process.env.LARK_AUTOREPLY_MAX_DEPARTMENT_USERS, 1000);
const maxDepartmentDepth = readPositiveNumber(process.env.LARK_AUTOREPLY_MAX_DEPARTMENT_DEPTH, 6);
const searchMissingDepartmentChatIds = process.env.LARK_AUTOREPLY_SEARCH_MISSING_DEPARTMENT_CHAT_IDS === "true";
const verboseTargetList = process.env.LARK_AUTOREPLY_VERBOSE_TARGETS === "true";
const verboseSkippedTargets = process.env.LARK_AUTOREPLY_VERBOSE_SKIPPED_TARGETS === "true";
const knowledgeEnabled = process.env.LARK_KNOWLEDGE_ENABLED !== "false";
const knowledgeIndexFile = getKnowledgeIndexFile(rootDir);
const knowledgeReloadMs = readPositiveInteger(process.env.LARK_KNOWLEDGE_RELOAD_MS, 60_000);
const knowledgeSearchLimit = readPositiveInteger(process.env.LARK_KNOWLEDGE_SEARCH_LIMIT, 6);
const knowledgeKeywords = readKnowledgeKeywords();

const skippedTargetNames: string[] = [];
let cachedKnowledgeIndex: KnowledgeIndex | undefined;
let cachedKnowledgeLoadedAt = 0;

let running = true;
process.once("SIGINT", () => {
  running = false;
});
process.once("SIGTERM", () => {
  running = false;
});

async function main(): Promise<void> {
  const client = LarkUserClient.fromEnv(tokenFile);
  const botClient = LarkClient.fromEnv();
  const state = await loadState();
  state.repliedMessageIds ??= [];
  state.lastReplyAtByChat ??= {};
  state.targets ??= migrateLegacyTargetState(state);
  const excludedOpenIds = await resolveExcludedOpenIds(client, state);
  pruneExcludedState(state, excludedOpenIds);
  const targets = await resolveTargets(client, state, excludedOpenIds);

  if (targets.length === 0) {
    throw new Error("Could not resolve any auto-reply targets. Check LARK_AUTOREPLY_TARGETS or LARK_AUTOREPLY_TARGET_NAMES in .env.");
  }

  const smartTargets = targets.filter(shouldUseSmartReply);
  const smartReply = smartTargets.length > 0 ? createSmartReplyGenerator() : undefined;
  const priorityTargets = smartTargets.length > 0 ? smartTargets : targets;
  const fullScanTargets = smartTargets.length > 0 ? targets.filter((target) => !shouldUseSmartReply(target)) : [];
  let activePriorityPollIntervalMs = pollIntervalMs;
  let activePriorityPollConcurrency = Math.min(priorityPollConcurrency, priorityTargets.length);
  let activeFullPollConcurrency = Math.min(pollConcurrency, Math.max(fullScanTargets.length, 1));
  let nextFullScanAt = Date.now() + fullPollIntervalMs;
  let lastRateLimitWarningAt = 0;

  const selfOpenId = await getSelfOpenId(client);
  await saveState(state);

  console.log(`Auto reply is running for ${targets.length} target(s).`);
  if (verboseTargetList) {
    console.log(`Target list: ${targets.map(formatTargetLabel).join(", ")}.`);
  }
  console.log(`Resolved ${targets.length} target(s) from ${targetSpecs.length} configured target spec(s).`);
  if (skippedTargetNames.length > 0) {
    console.log(`Skipped ${skippedTargetNames.length} target(s) without a direct chat. Set LARK_AUTOREPLY_VERBOSE_SKIPPED_TARGETS=true to list them.`);
  }
  console.log(`Excluded target names: ${excludedTargetNames.join(", ") || "none"}.`);
  console.log(formatReplyModeLog(smartTargets));
  if (fixedReplySuppressWindowsEnabled && fixedReplySuppressWindows.length > 0 && replyMode !== "smart") {
    console.log(`Fixed replies are suppressed during Beijing windows: ${formatFixedReplySuppressWindows()}.`);
  } else if (!fixedReplySuppressWindowsEnabled && fixedReplySuppressWindows.length > 0 && replyMode !== "smart") {
    console.log("Fixed reply time-window suppression is disabled.");
  }
  if (smartTargets.length > 0 && knowledgeEnabled) {
    const knowledgeIndex = await getKnowledgeIndex();
    console.log(`Knowledge retrieval enabled with ${knowledgeIndex.items.length} indexed item(s).`);
  }
  if (fullScanTargets.length > 0) {
    console.log(`Priority polling every ${pollIntervalMs}ms for ${priorityTargets.length} smart target(s); full scan every ${fullPollIntervalMs}ms for ${fullScanTargets.length} fixed target(s). Press Ctrl+C to stop.`);
  } else {
    console.log(`Polling every ${pollIntervalMs}ms with concurrency ${Math.min(priorityPollConcurrency, targets.length)}. Press Ctrl+C to stop.`);
  }

  while (running) {
    try {
      const priorityResult = await pollTargets(client, botClient, state, priorityTargets, selfOpenId, smartReply, activePriorityPollConcurrency);
      const shouldFullScan = fullScanTargets.length > 0 && Date.now() >= nextFullScanAt;
      const fullScanResult = shouldFullScan ? await pollTargets(client, botClient, state, fullScanTargets, selfOpenId, smartReply, activeFullPollConcurrency) : emptyPollTargetsResult();
      if (shouldFullScan) {
        nextFullScanAt = Date.now() + fullPollIntervalMs;
      }

      if (priorityResult.rateLimited > 0) {
        activePriorityPollConcurrency = Math.max(1, Math.floor(activePriorityPollConcurrency / 2));
        activePriorityPollIntervalMs = Math.min(maxRateLimitBackoffMs, Math.max(rateLimitBackoffMs, activePriorityPollIntervalMs * 2));
      } else {
        activePriorityPollConcurrency = Math.min(priorityPollConcurrency, activePriorityPollConcurrency + 1, priorityTargets.length);
        activePriorityPollIntervalMs = Math.max(pollIntervalMs, Math.floor(activePriorityPollIntervalMs * 0.8));
      }

      if (fullScanResult.rateLimited > 0) {
        activeFullPollConcurrency = Math.max(1, Math.floor(activeFullPollConcurrency / 2));
        nextFullScanAt = Date.now() + Math.max(fullPollIntervalMs, rateLimitBackoffMs);
      } else {
        activeFullPollConcurrency = Math.min(pollConcurrency, activeFullPollConcurrency + 1, Math.max(fullScanTargets.length, 1));
      }

      const rateLimited = priorityResult.rateLimited + fullScanResult.rateLimited;
      if (rateLimited > 0 && Date.now() - lastRateLimitWarningAt > 30_000) {
        console.warn(`Lark rate limited ${rateLimited} request(s); backing off to ${activePriorityPollIntervalMs}ms priority polling, priority concurrency ${activePriorityPollConcurrency}, full-scan concurrency ${activeFullPollConcurrency}.`);
        lastRateLimitWarningAt = Date.now();
      }

      await saveState(state);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
    }

    if (running && activePriorityPollIntervalMs > 0) {
      await delay(activePriorityPollIntervalMs);
    }
  }

  console.log("Auto reply stopped.");
}

async function pollTargets(
  client: LarkUserClient,
  botClient: LarkClient,
  state: AutoReplyState,
  targets: ResolvedTarget[],
  selfOpenId: string | undefined,
  smartReply: SmartReplyGenerator | undefined,
  concurrency: number
): Promise<PollTargetsResult> {
  const result = emptyPollTargetsResult();
  if (targets.length === 0) {
    return result;
  }

  let nextTargetIndex = 0;
  let stopBatch = false;
  const workerCount = Math.min(Math.max(concurrency, 1), targets.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (running && !stopBatch) {
        const target = targets[nextTargetIndex];
        nextTargetIndex += 1;
        if (!target) {
          return;
        }

        try {
          await pollOnce(client, botClient, state, target, selfOpenId, smartReply);
          result.polled += 1;
        } catch (error) {
          if (isRateLimitError(error)) {
            result.rateLimited += 1;
            stopBatch = true;
          } else {
            result.failures += 1;
            console.error(formatTargetPollError(target, error));
          }
        }
      }
    })
  );
  return result;
}

function emptyPollTargetsResult(): PollTargetsResult {
  return { polled: 0, failures: 0, rateLimited: 0 };
}

async function pollOnce(client: LarkUserClient, botClient: LarkClient, state: AutoReplyState, target: ResolvedTarget, selfOpenId: string | undefined, smartReply: SmartReplyGenerator | undefined): Promise<void> {
  const endTime = Math.floor(Date.now() / 1000);
  const targetState = state.targets?.[target.key] ?? {};
  const startTime = targetState.lastCheckedAt ?? endTime;
  const messages = await listMessages(client, target.chatId, startTime, endTime);
  let newestCreateTime = startTime;

  for (const message of messages) {
    const messageId = message.message_id;
    const createTime = readMessageCreateTime(message);
    if (createTime > newestCreateTime) {
      newestCreateTime = createTime;
    }

    if (!messageId || state.repliedMessageIds?.includes(messageId)) {
      continue;
    }

    const senderOpenId = getSenderOpenId(message);
    if (!senderOpenId || senderOpenId === selfOpenId || senderOpenId !== target.openId) {
      continue;
    }

    const useSmartReply = smartReply !== undefined && shouldUseSmartReply(target);
    if (!useSmartReply && isFixedReplySuppressedNow()) {
      state.repliedMessageIds = [...(state.repliedMessageIds ?? []), messageId].slice(-200);
      console.log(`Skipped fixed reply to ${target.name} message ${messageId} during Beijing working window.`);
      continue;
    }

    const texts = useSmartReply && smartReply ? [await buildSmartReply(client, target, message, selfOpenId, endTime, smartReply)] : replyTexts;
    const repliedBy = await sendAutoReply(client, botClient, target, texts, messageId);
    state.repliedMessageIds = [...(state.repliedMessageIds ?? []), messageId].slice(-200);
    state.lastReplyAtByChat = { ...(state.lastReplyAtByChat ?? {}), [target.chatId]: Date.now() };
    console.log(`Replied to ${target.name} message ${messageId} as ${repliedBy}.`);
  }

  state.targets = {
    ...(state.targets ?? {}),
    [target.key]: {
      chatId: target.chatId,
      openId: target.openId,
      isExternal: target.isExternal,
      lastCheckedAt: Math.max(newestCreateTime, endTime - 1)
    }
  };
}

async function listMessages(client: LarkUserClient, chatId: string, startTime: number, endTime: number): Promise<Message[]> {
  const response = await client.request<ApiList<Message>>({
    method: "GET",
    path: "/open-apis/im/v1/messages",
    query: {
      container_id_type: "chat",
      container_id: chatId,
      start_time: startTime,
      end_time: endTime,
      sort_type: "ByCreateTimeAsc",
      page_size: 50
    }
  });

  return response.data?.items ?? [];
}

async function sendTextMessage(client: LarkUserClient, chatId: string, text: string, sourceMessageId: string, replyIndex: number): Promise<void> {
  await client.request({
    method: "POST",
    path: "/open-apis/im/v1/messages",
    query: { receive_id_type: "chat_id" },
    body: {
      receive_id: chatId,
      msg_type: "text",
      content: JSON.stringify({ text }),
      uuid: `ar-${shortHash(`${sourceMessageId}:${replyIndex}`)}`
    }
  });
}

async function sendBotTextMessage(client: LarkClient, openId: string, text: string, sourceMessageId: string, replyIndex: number): Promise<void> {
  await client.request({
    method: "POST",
    path: "/open-apis/im/v1/messages",
    query: { receive_id_type: "open_id" },
    body: {
      receive_id: openId,
      msg_type: "text",
      content: JSON.stringify({ text }),
      uuid: `bot-ar-${shortHash(`${sourceMessageId}:${replyIndex}`)}`
    }
  });
}

async function sendAutoReply(client: LarkUserClient, botClient: LarkClient, target: ResolvedTarget, texts: string[], sourceMessageId: string): Promise<"user" | "bot"> {
  if (target.isExternal) {
    for (const [index, text] of texts.entries()) {
      await sendBotTextMessage(botClient, target.openId, text, sourceMessageId, index);
    }
    return "bot";
  }

  try {
    for (const [index, text] of texts.entries()) {
      await sendTextMessage(client, target.chatId, text, sourceMessageId, index);
    }
    return "user";
  } catch (error) {
    if (!isExternalChatPermissionError(error)) {
      throw error;
    }
    for (const [index, text] of texts.entries()) {
      await sendBotTextMessage(botClient, target.openId, text, sourceMessageId, index);
    }
    return "bot";
  }
}

async function buildSmartReply(client: LarkUserClient, target: ResolvedTarget, message: Message, selfOpenId: string | undefined, endTime: number, smartReply: SmartReplyGenerator): Promise<string> {
  const incomingMessage = extractMessageText(message.msg_type, message.content ?? message.body?.content);
  const conversation = await readConversationContext(client, target, selfOpenId, endTime);
  const knowledge = knowledgeEnabled ? await searchKnowledgeForReply(incomingMessage, conversation) : [];
  return smartReply({ targetName: target.name, incomingMessage, conversation, knowledge });
}

async function searchKnowledgeForReply(incomingMessage: string, conversation: SmartReplyConversationMessage[]) {
  const index = await getKnowledgeIndex();
  const conversationText = conversation.map((message) => message.text).join("\n");
  return searchKnowledge(index, {
    incomingMessage,
    conversationText,
    keywords: knowledgeKeywords,
    limit: knowledgeSearchLimit
  });
}

async function getKnowledgeIndex(): Promise<KnowledgeIndex> {
  if (!knowledgeEnabled) {
    return { version: 1, generatedAt: new Date(0).toISOString(), items: [] };
  }
  const now = Date.now();
  if (!cachedKnowledgeIndex || now - cachedKnowledgeLoadedAt > knowledgeReloadMs) {
    cachedKnowledgeIndex = await loadKnowledgeIndex(knowledgeIndexFile);
    cachedKnowledgeLoadedAt = now;
  }
  return cachedKnowledgeIndex;
}

async function readConversationContext(client: LarkUserClient, target: ResolvedTarget, selfOpenId: string | undefined, endTime: number): Promise<SmartReplyConversationMessage[]> {
  const messages = await listMessages(client, target.chatId, Math.max(0, endTime - contextLookbackSeconds), endTime);
  return messages
    .map((message): SmartReplyConversationMessage | undefined => {
      const senderOpenId = getSenderOpenId(message);
      const speaker = senderOpenId === selfOpenId ? "me" : senderOpenId === target.openId ? "target" : "other";
      const text = extractMessageText(message.msg_type, message.content ?? message.body?.content);
      if (!text || (speaker === "me" && isDelegatedAutoReplyText(text))) {
        return undefined;
      }
      return { speaker, text, createdAt: readMessageCreateTime(message) };
    })
    .filter((message): message is SmartReplyConversationMessage => Boolean(message))
    .slice(-maxSmartReplyContextMessages);
}

function isDelegatedAutoReplyText(text: string): boolean {
  const normalizedText = text.replace(/\s+/g, "");
  if (replyTexts.some((replyText) => normalizedText === replyText.replace(/\s+/g, ""))) {
    return true;
  }

  return ["机器人", "我在出差", "请留言", "稍后再聊", "自动回复"].some((phrase) => normalizedText.includes(phrase));
}

async function getSelfOpenId(client: LarkUserClient): Promise<string | undefined> {
  try {
    const response = await client.request<UserInfoResponse>({ method: "GET", path: "/open-apis/authen/v1/user_info" });
    return response.data?.open_id;
  } catch (error) {
    console.warn(`Could not read current user info: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

function pickTargetUser(items: UserSearchItem[], name = targetName, preferExternal = false): UserSearchItem | undefined {
  const preferredTenantMatch = preferExternal ? true : false;
  const fallbackTenantMatch = preferExternal ? false : true;
  return (
    items.find((item) => item.meta_data?.is_cross_tenant === preferredTenantMatch && (item.display_info?.includes(name) || item.meta_data?.i18n_names?.zh_cn?.includes(name))) ??
    items.find((item) => item.meta_data?.is_cross_tenant === fallbackTenantMatch && (item.display_info?.includes(name) || item.meta_data?.i18n_names?.zh_cn?.includes(name))) ??
    items.find((item) => item.display_info?.includes(name) || item.meta_data?.i18n_names?.zh_cn?.includes(name)) ??
    items[0]
  );
}

async function findTargetUser(client: LarkUserClient, name = targetName, preferExternal = false): Promise<UserSearchItem | undefined> {
  try {
    const response = await client.request<ApiList<UserSearchItem>>({
      method: "POST",
      path: "/open-apis/contact/v3/users/search",
      query: { user_id_type: "open_id" },
      body: { query: name, page_size: 10 }
    });

    return pickTargetUser(response.data?.items ?? [], name, preferExternal);
  } catch (error) {
    console.warn(`Could not search target user ${name}: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

async function resolveTargets(client: LarkUserClient, state: AutoReplyState, excludedOpenIds: Set<string>): Promise<ResolvedTarget[]> {
  const resolvedTargets: ResolvedTarget[] = [];
  const seenOpenIds = new Set<string>();
  const now = Math.floor(Date.now() / 1000);
  for (const spec of targetSpecs) {
    const specTargets = await resolveTargetSpec(client, state, spec, now, excludedOpenIds);
    for (const target of specTargets) {
      if (seenOpenIds.has(target.openId)) {
        continue;
      }
      seenOpenIds.add(target.openId);
      resolvedTargets.push(target);
    }
  }
  return resolvedTargets;
}

async function resolveTargetSpec(client: LarkUserClient, state: AutoReplyState, spec: TargetSpec, now: number, excludedOpenIds: Set<string>): Promise<ResolvedTarget[]> {
  if (spec.type === "person" || spec.type === "external_person") {
    if (isExcludedName(spec.value)) {
      return [];
    }
    const target = await resolvePersonTarget(client, state, spec.value, spec, now);
    return target ? [target] : [];
  }

  const departmentId = spec.type === "department_id" ? spec.value : await findDepartmentId(client, spec.value);
  if (!departmentId) {
    console.warn(`Could not resolve auto-reply department ${spec.value}.`);
    return [];
  }

  const users = await listDepartmentUsers(client, departmentId);
  const targets: ResolvedTarget[] = [];
  for (const user of users.slice(0, maxDepartmentUsers)) {
    const name = getUserDisplayName(user, user.open_id ?? user.id ?? spec.value);
    if (isExcludedUser(user, name, excludedOpenIds)) {
      continue;
    }
    const target = await resolveUserItemTarget(client, state, user, name, spec, now);
    if (target) {
      targets.push(target);
    }
  }

  if (users.length > maxDepartmentUsers) {
    console.warn(`Department ${spec.value} has ${users.length} users; only the first ${maxDepartmentUsers} are monitored. Increase LARK_AUTOREPLY_MAX_DEPARTMENT_USERS if needed.`);
  }
  return targets;
}

async function resolvePersonTarget(client: LarkUserClient, state: AutoReplyState, name: string, spec: TargetSpec, now: number): Promise<ResolvedTarget | undefined> {
  const legacyExisting = findExistingTargetState(state, spec.type === "external_person" ? [`external:${name}`] : [`person:${name}`, name]);
  const usePrimaryTargetOverrides = targetSpecs.length === 1 || name === targetName;
  const configuredOpenId = usePrimaryTargetOverrides ? process.env.LARK_AUTOREPLY_TARGET_OPEN_ID : undefined;
  const configuredChatId = usePrimaryTargetOverrides ? process.env.LARK_AUTOREPLY_CHAT_ID : undefined;
  const hasCachedTarget = Boolean(legacyExisting?.openId && legacyExisting?.chatId && (spec.type !== "external_person" || legacyExisting.isExternal));
  const cachedTarget = hasCachedTarget ? legacyExisting : undefined;
  const user = configuredOpenId && configuredChatId || hasCachedTarget ? undefined : await findTargetUser(client, name, spec.type === "external_person");
  const openId = configuredOpenId ?? cachedTarget?.openId ?? user?.open_id ?? user?.id;
  const chatId = configuredChatId ?? cachedTarget?.chatId ?? user?.meta_data?.chat_id;
  const isExternal = cachedTarget?.isExternal ?? user?.meta_data?.is_cross_tenant === true;

  if (!openId || !chatId) {
    console.warn(`Could not resolve auto-reply person ${name}.`);
    return undefined;
  }

  const targetKey = userTargetKey(openId);
  const existing = findExistingTargetState(state, [targetKey, `person:${name}`, name]);
  return persistResolvedTarget(state, targetKey, name, openId, chatId, isExternal, spec.label, existing, now);
}

async function resolveUserItemTarget(client: LarkUserClient, state: AutoReplyState, user: UserSearchItem, fallbackName: string, spec: TargetSpec, now: number): Promise<ResolvedTarget | undefined> {
  const openId = user.open_id ?? user.id;
  if (!openId) {
    return undefined;
  }

  const targetKey = userTargetKey(openId);
  const existing = findExistingTargetState(state, [targetKey, fallbackName]);
  let chatId = existing?.chatId ?? user.meta_data?.chat_id;
  const isExternal = existing?.isExternal ?? user.meta_data?.is_cross_tenant === true;
  let name = fallbackName;

  if (!chatId && searchMissingDepartmentChatIds) {
    const searchedUser = await findTargetUser(client, fallbackName);
    chatId = searchedUser?.meta_data?.chat_id;
    name = getUserDisplayName(searchedUser ?? user, fallbackName);
  }

  if (!chatId) {
    recordSkippedTarget(fallbackName);
    return undefined;
  }

  return persistResolvedTarget(state, targetKey, name, openId, chatId, isExternal, spec.label, existing, now);
}

function persistResolvedTarget(
  state: AutoReplyState,
  key: string,
  name: string,
  openId: string,
  chatId: string,
  isExternal: boolean,
  source: string,
  existing: TargetState | undefined,
  now: number
): ResolvedTarget {
  const targetState = {
    openId,
    chatId,
    isExternal,
    lastCheckedAt: existing?.lastCheckedAt ?? (replyExisting ? now - lookbackSeconds : now)
  };
  const targets = {
    ...(state.targets ?? {}),
    [key]: targetState
  };
  if (source.startsWith("person:") || source.startsWith("external:")) {
    targets[source] = targetState;
  }
  state.targets = {
    ...targets
  };
  return { key, name, openId, chatId, source, isExternal };
}

async function findDepartmentId(client: LarkUserClient, name: string): Promise<string | undefined> {
  try {
    const response = await client.request<ApiList<DepartmentSearchItem>>({
      method: "POST",
      path: "/open-apis/contact/v3/departments/search",
      query: { department_id_type: "open_department_id" },
      body: { query: name, page_size: 10 }
    });
    const department = pickDepartment(response.data?.items ?? [], name);
    return department?.open_department_id ?? department?.department_id;
  } catch (error) {
    console.warn(`Could not search department ${name}: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

async function listDepartmentUsers(client: LarkUserClient, departmentId: string): Promise<UserSearchItem[]> {
  const departmentIds = await listDepartmentTreeIds(client, departmentId);
  const users: UserSearchItem[] = [];
  const seenOpenIds = new Set<string>();

  for (const currentDepartmentId of departmentIds) {
    const directUsers = await listDirectDepartmentUsers(client, currentDepartmentId, maxDepartmentUsers - users.length);
    for (const user of directUsers) {
      const openId = user.open_id ?? user.id;
      if (!openId || seenOpenIds.has(openId)) {
        continue;
      }
      seenOpenIds.add(openId);
      users.push(user);
      if (users.length >= maxDepartmentUsers) {
        return users;
      }
    }
  }

  return users;
}

async function listDirectDepartmentUsers(client: LarkUserClient, departmentId: string, maxUsers: number): Promise<UserSearchItem[]> {
  const users: UserSearchItem[] = [];
  let pageToken: string | undefined;
  do {
    const page = await listDepartmentUsersPage(client, departmentId, pageToken);
    users.push(...page.items);
    pageToken = page.hasMore ? page.pageToken : undefined;
  } while (pageToken && users.length < maxUsers);
  return users.slice(0, maxUsers);
}

async function listDepartmentUsersPage(client: LarkUserClient, departmentId: string, pageToken?: string): Promise<PageResult<UserSearchItem>> {
  const response = await client.request<ApiList<UserSearchItem>>({
    method: "GET",
    path: "/open-apis/contact/v3/users/find_by_department",
    query: {
      department_id: departmentId,
      department_id_type: "open_department_id",
      user_id_type: "open_id",
      page_size: 50,
      page_token: pageToken
    }
  });

  return {
    items: response.data?.items ?? [],
    pageToken: response.data?.page_token,
    hasMore: response.data?.has_more ?? false
  };
}

async function listDepartmentTreeIds(client: LarkUserClient, rootDepartmentId: string): Promise<string[]> {
  const departmentIds: string[] = [];
  const seenDepartmentIds = new Set<string>();
  const queue: Array<{ departmentId: string; depth: number }> = [{ departmentId: rootDepartmentId, depth: 0 }];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || seenDepartmentIds.has(current.departmentId) || current.depth > maxDepartmentDepth) {
      continue;
    }

    seenDepartmentIds.add(current.departmentId);
    departmentIds.push(current.departmentId);

    if (current.depth === maxDepartmentDepth) {
      continue;
    }

    const children = await listChildDepartments(client, current.departmentId);
    for (const child of children) {
      const childDepartmentId = child.open_department_id ?? child.department_id;
      if (childDepartmentId && !seenDepartmentIds.has(childDepartmentId)) {
        queue.push({ departmentId: childDepartmentId, depth: current.depth + 1 });
      }
    }
  }

  return departmentIds;
}

async function listChildDepartments(client: LarkUserClient, departmentId: string): Promise<DepartmentSearchItem[]> {
  const departments: DepartmentSearchItem[] = [];
  let pageToken: string | undefined;
  do {
    const page = await listChildDepartmentsPage(client, departmentId, pageToken);
    departments.push(...page.items);
    pageToken = page.hasMore ? page.pageToken : undefined;
  } while (pageToken);
  return departments;
}

async function listChildDepartmentsPage(client: LarkUserClient, departmentId: string, pageToken?: string): Promise<PageResult<DepartmentSearchItem>> {
  try {
    const response = await client.request<ApiList<DepartmentSearchItem>>({
      method: "GET",
      path: `/open-apis/contact/v3/departments/${encodeURIComponent(departmentId)}/children`,
      query: {
        department_id_type: "open_department_id",
        page_size: 50,
        page_token: pageToken
      }
    });

    return {
      items: response.data?.items ?? [],
      pageToken: response.data?.page_token,
      hasMore: response.data?.has_more ?? false
    };
  } catch (error) {
    console.warn(`Could not list child departments for ${departmentId}: ${error instanceof Error ? error.message : String(error)}`);
    return { items: [], hasMore: false };
  }
}

function pickDepartment(items: DepartmentSearchItem[], name: string): DepartmentSearchItem | undefined {
  return (
    items.find((item) => item.name === name || item.i18n_name?.zh_cn === name) ??
    items.find((item) => item.name?.includes(name) || item.i18n_name?.zh_cn?.includes(name)) ??
    items[0]
  );
}

function findExistingTargetState(state: AutoReplyState, keys: string[]): TargetState | undefined {
  for (const key of keys) {
    const targetState = state.targets?.[key];
    if (targetState) {
      return targetState;
    }
  }
  return undefined;
}

async function resolveExcludedOpenIds(client: LarkUserClient, state: AutoReplyState): Promise<Set<string>> {
  const openIds = new Set<string>();
  for (const name of excludedTargetNames) {
    const existing = findExistingTargetState(state, [name, `person:${name}`]);
    if (existing?.openId) {
      openIds.add(existing.openId);
    }

    const user = await findTargetUser(client, name);
    const openId = user?.open_id ?? user?.id;
    if (openId) {
      openIds.add(openId);
    }
  }
  return openIds;
}

function pruneExcludedState(state: AutoReplyState, excludedOpenIds: Set<string>): void {
  const removedChatIds = new Set<string>();
  const excludedKeys = new Set(excludedTargetNames.flatMap((name) => [name, `person:${name}`]));

  for (const [key, targetState] of Object.entries(state.targets ?? {})) {
    if (excludedKeys.has(key) || (targetState.openId && excludedOpenIds.has(targetState.openId))) {
      if (targetState.chatId) {
        removedChatIds.add(targetState.chatId);
      }
      delete state.targets?.[key];
    }
  }

  if (state.targetOpenId && excludedOpenIds.has(state.targetOpenId)) {
    if (state.chatId) {
      removedChatIds.add(state.chatId);
    }
    delete state.targetOpenId;
    delete state.chatId;
    delete state.lastCheckedAt;
  }

  for (const chatId of removedChatIds) {
    delete state.lastReplyAtByChat?.[chatId];
  }
}

function userTargetKey(openId: string): string {
  return `user:${openId}`;
}

function migrateLegacyTargetState(state: AutoReplyState): Record<string, TargetState> {
  if (!state.chatId && !state.targetOpenId && !state.lastCheckedAt) {
    return {};
  }

  return {
    [targetName]: {
      chatId: state.chatId,
      openId: state.targetOpenId,
      lastCheckedAt: state.lastCheckedAt
    }
  };
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

function readMessageCreateTime(message: Message): number {
  const raw = Number(message.create_time);
  if (!Number.isFinite(raw)) {
    return 0;
  }
  return raw > 10_000_000_000 ? Math.floor(raw / 1000) : raw;
}

function getSenderOpenId(message: Message): string | undefined {
  return message.sender?.sender_id?.open_id ?? (message.sender?.id_type === "open_id" ? message.sender.id : undefined);
}

function resolvePath(path: string): string {
  return resolve(rootDir, path);
}

function readPositiveNumber(value: string | undefined, fallback: number): number {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) && numberValue > 0 ? numberValue : fallback;
}

function readPositiveInteger(value: string | undefined, fallback: number): number {
  const numberValue = Number(value);
  return Number.isInteger(numberValue) && numberValue > 0 ? numberValue : fallback;
}

function readNonNegativeInteger(value: string | undefined, fallback: number): number {
  const numberValue = Number(value);
  return Number.isInteger(numberValue) && numberValue >= 0 ? numberValue : fallback;
}

function readPollIntervalMs(): number {
  if (process.env.LARK_AUTOREPLY_POLL_MS !== undefined) {
    return readNonNegativeInteger(process.env.LARK_AUTOREPLY_POLL_MS, 1000);
  }
  return Math.max(0, Math.round(readPositiveNumber(process.env.LARK_AUTOREPLY_POLL_SECONDS, 1) * 1000));
}

function isRateLimitError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("99991400") || message.includes("429") || /frequency limit|too many requests/i.test(message);
}

function readNonNegativeNumber(value: string | undefined, fallback: number): number {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) && numberValue >= 0 ? numberValue : fallback;
}

function readTargetNames(): string[] {
  const raw = process.env.LARK_AUTOREPLY_TARGET_NAMES || [targetName, "谷力刚"].join(",");
  return readNameList(raw, []);
}

function readReplyTexts(): string[] {
  const rawTexts = process.env.LARK_AUTOREPLY_TEXTS;
  if (rawTexts) {
    const texts = rawTexts
      .split("|")
      .map((text) => text.replace(/\\n/g, "\n").trim())
      .filter((text) => text.length > 0);
    if (texts.length > 0) {
      return texts;
    }
  }

  if (process.env.LARK_AUTOREPLY_TEXT) {
    return [process.env.LARK_AUTOREPLY_TEXT];
  }

  return ["机器人： 我在出差，请留言", "机器人： 现在几点了，心里没数么？", "机器人：当前是调试阶段，不要介意。"];
}

function readFixedReplySuppressWindows(): FixedReplySuppressWindow[] {
  const rawWindows = process.env.LARK_AUTOREPLY_FIXED_REPLY_SUPPRESS_WINDOWS || "1-5 10:00-12:00,14:00-18:00";
  return rawWindows
    .split(";")
    .flatMap((windowText) => parseFixedReplySuppressWindow(windowText.trim()));
}

function parseFixedReplySuppressWindow(value: string): FixedReplySuppressWindow[] {
  const match = value.match(/^(\d)(?:-(\d))?\s+(.+)$/);
  if (!match) {
    return [];
  }

  const startDay = Number(match[1]);
  const endDay = Number(match[2] ?? match[1]);
  if (!isValidIsoWeekday(startDay) || !isValidIsoWeekday(endDay) || endDay < startDay) {
    return [];
  }

  const windows: FixedReplySuppressWindow[] = [];
  for (const timeRange of match[3].split(",")) {
    const timeMatch = timeRange.trim().match(/^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/);
    if (!timeMatch) {
      continue;
    }
    const startMinute = Number(timeMatch[1]) * 60 + Number(timeMatch[2]);
    const endMinute = Number(timeMatch[3]) * 60 + Number(timeMatch[4]);
    if (startMinute < endMinute && endMinute <= 24 * 60) {
      windows.push({ days: buildIsoWeekdays(startDay, endDay), startMinute, endMinute });
    }
  }
  return windows;
}

function isFixedReplySuppressedNow(date = new Date()): boolean {
  if (!fixedReplySuppressWindowsEnabled || fixedReplySuppressWindows.length === 0) {
    return false;
  }
  const beijingDate = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  const isoWeekday = beijingDate.getUTCDay() === 0 ? 7 : beijingDate.getUTCDay();
  const minuteOfDay = beijingDate.getUTCHours() * 60 + beijingDate.getUTCMinutes();
  return fixedReplySuppressWindows.some((window) => window.days.includes(isoWeekday) && minuteOfDay >= window.startMinute && minuteOfDay < window.endMinute);
}

function formatFixedReplySuppressWindows(): string {
  return process.env.LARK_AUTOREPLY_FIXED_REPLY_SUPPRESS_WINDOWS || "1-5 10:00-12:00,14:00-18:00";
}

function buildIsoWeekdays(startDay: number, endDay: number): number[] {
  return Array.from({ length: endDay - startDay + 1 }, (_, index) => startDay + index);
}

function isValidIsoWeekday(day: number): boolean {
  return Number.isInteger(day) && day >= 1 && day <= 7;
}

function readReplyMode(): ReplyMode {
  const rawMode = process.env.LARK_AUTOREPLY_MODE?.trim().toLowerCase();
  if (rawMode === "smart" || rawMode === "ai") {
    return "smart";
  }
  if (rawMode === "fixed" || rawMode === "text") {
    return "fixed";
  }
  if (rawMode === "mixed" || rawMode === "hybrid") {
    return "mixed";
  }
  return "mixed";
}

function shouldUseSmartReply(target: ResolvedTarget): boolean {
  if (replyMode === "smart") {
    return true;
  }
  if (replyMode === "fixed") {
    return false;
  }
  return smartReplyTargetNames.some((selector) => matchesSmartReplySelector(target, selector));
}

function matchesSmartReplySelector(target: ResolvedTarget, selector: string): boolean {
  const trimmed = selector.trim();
  const separatorIndex = trimmed.indexOf(":");
  if (separatorIndex !== -1) {
    const type = trimmed.slice(0, separatorIndex).trim().toLowerCase();
    const value = trimmed.slice(separatorIndex + 1).trim();
    if (isExternalPersonType(type)) {
      return target.source === `external:${value}`;
    }
    return target.source === `person:${value}`;
  }
  return target.name.trim() === trimmed || target.source === `person:${trimmed}`;
}

function formatReplyModeLog(smartTargets: ResolvedTarget[]): string {
  if (replyMode === "fixed") {
    return `Reply mode: fixed texts for all targets. Reply texts: ${replyTexts.join(" | ")}`;
  }
  if (replyMode === "smart") {
    return "Reply mode: smart dynamic reply for all targets.";
  }

  const smartTargetNames = smartTargets.map(formatTargetLabel).join(", ") || "none";
  return `Reply mode: mixed. Smart targets: ${smartTargetNames}. Other targets use fixed texts: ${replyTexts.join(" | ")}`;
}

function formatTargetLabel(target: ResolvedTarget): string {
  return target.isExternal ? `${target.name} (external)` : target.name;
}

function recordSkippedTarget(name: string): void {
  skippedTargetNames.push(name);
  if (verboseSkippedTargets) {
    console.warn(`Could not find a direct chat for ${name}; skipped.`);
  }
}

function readNameList(raw: string | undefined, fallback: string[]): string[] {
  const names = (raw ?? fallback.join(","))
    .split(/[,，]/)
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  return [...new Set(names)];
}

function readTargetSpecs(): TargetSpec[] {
  const rawTargets = process.env.LARK_AUTOREPLY_TARGETS;
  if (!rawTargets) {
    return [
      { type: "department", value: "研发中心", label: "department:研发中心" },
      { type: "department", value: "产品中心", label: "department:产品中心" },
      { type: "department", value: "项目中心", label: "department:项目中心" },
      { type: "department", value: "Global Business", label: "department:Global Business" },
      { type: "person", value: "陈威", label: "person:陈威" },
      { type: "person", value: "刘峥", label: "person:刘峥" }
    ];
  }

  const specs = rawTargets
    .split(/[,，]/)
    .map((target) => target.trim())
    .filter((target) => target.length > 0)
    .map(parseTargetSpec);
  return dedupeTargetSpecs(specs);
}

function parseTargetSpec(raw: string): TargetSpec {
  const separatorIndex = raw.indexOf(":");
  if (separatorIndex === -1) {
    return { type: "person", value: raw, label: `person:${raw}` };
  }

  const type = raw.slice(0, separatorIndex).trim().toLowerCase();
  const value = raw.slice(separatorIndex + 1).trim();
  if (["department", "dept", "部门"].includes(type)) {
    return { type: "department", value, label: `department:${value}` };
  }
  if (["department_id", "dept_id", "open_department_id", "部门id"].includes(type)) {
    return { type: "department_id", value, label: `department_id:${value}` };
  }
  if (isExternalPersonType(type)) {
    return { type: "external_person", value, label: `external:${value}` };
  }
  return { type: "person", value, label: `person:${value}` };
}

function isExternalPersonType(type: string): boolean {
  return ["external", "external_person", "external_user", "外部", "外部联系人"].includes(type);
}

function dedupeTargetSpecs(specs: TargetSpec[]): TargetSpec[] {
  const seen = new Set<string>();
  return specs.filter((spec) => {
    const key = `${spec.type}:${spec.value}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function getUserDisplayName(user: UserSearchItem, fallback: string): string {
  return user.name ?? user.meta_data?.i18n_names?.zh_cn ?? cleanDisplayInfo(user.display_info) ?? fallback;
}

function isExcludedUser(user: UserSearchItem, fallbackName: string, excludedOpenIds: Set<string>): boolean {
  const openId = user.open_id ?? user.id;
  if (openId && excludedOpenIds.has(openId)) {
    return true;
  }

  const candidates = [user.name, user.meta_data?.i18n_names?.zh_cn, cleanDisplayInfo(user.display_info), fallbackName].filter((name): name is string => Boolean(name));
  return candidates.some(isExcludedName);
}

function isExcludedName(name: string): boolean {
  return excludedTargetNames.includes(name.trim());
}

function cleanDisplayInfo(displayInfo: string | undefined): string | undefined {
  const text = displayInfo?.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
  return text || undefined;
}

function formatTargetPollError(target: ResolvedTarget, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (isExternalChatPermissionError(error)) {
    return `Could not poll ${target.name}: missing permission to operate external chats. Internal contacts use user replies; external contacts need the bot single-chat relationship and bot send permission.`;
  }
  if (isBotAvailabilityError(error)) {
    return `Could not poll ${target.name}: bot has no availability to this external user. Ask the external user to open/authorize a single chat with the bot first.`;
  }
  return `Could not poll ${target.name}: ${message}`;
}

function isExternalChatPermissionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('"code":230027') || message.includes("no permission to operate external chats");
}

function isBotAvailabilityError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('"code":230013') || message.includes("Bot has NO availability to this user");
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});