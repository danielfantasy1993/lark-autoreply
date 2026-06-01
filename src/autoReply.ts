#!/usr/bin/env node
import { config as loadDotEnv } from "dotenv";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LarkClient } from "./larkClient.js";
import { getKnowledgeIndexFile, loadKnowledgeIndex, readKnowledgeKeywords, searchKnowledge, type KnowledgeIndex } from "./knowledgeStore.js";
import { defaultRuntimeSwitches, loadRuntimeSwitches, type RuntimeSwitches } from "./runtimeSwitches.js";
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
  mentions?: MessageMention[];
  body?: {
    content?: string;
    mentions?: MessageMention[];
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

type MessageMention = {
  key?: string;
  id?: string | {
    open_id?: string;
    user_id?: string;
    union_id?: string;
  };
  id_type?: string;
  name?: string;
};

type AutoReplyState = {
  chatId?: string;
  targetOpenId?: string;
  lastCheckedAt?: number;
  repliedMessageIds?: string[];
  lastReplyAtByChat?: Record<string, number>;
  fixedReplyEscalationByChat?: Record<string, FixedReplyEscalationState>;
  pendingWeatherByChat?: Record<string, { requestedAt: number }>;
  targets?: Record<string, TargetState>;
};

type FixedReplyEscalationState = {
  level: number;
  lastAutoReplyAt: number;
};

type TargetState = {
  chatId?: string;
  openId?: string;
  isExternal?: boolean;
  targetType?: "person" | "chat";
  lastCheckedAt?: number;
};

type ResolvedTarget = {
  key: string;
  name: string;
  openId: string;
  chatId: string;
  source: string;
  isExternal: boolean;
  targetType: "person" | "chat";
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
    }
  | {
      type: "chat";
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

type WeatherLookupResult = {
  location: string;
  description: string;
  tempC?: string;
  feelsLikeC?: string;
  humidity?: string;
  windKmph?: string;
};

type WeatherLocationCandidate = {
  label: string;
  queries: string[];
};

type WeatherGeo = {
  name: string;
  latitude: number;
  longitude: number;
};

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tokenFile = resolvePath(process.env.LARK_USER_TOKEN_FILE || ".lark-user-token.json");
const stateFile = resolvePath(process.env.LARK_AUTOREPLY_STATE_FILE || ".lark-auto-reply-state.json");
const targetName = process.env.LARK_AUTOREPLY_TARGET_NAME || "陈威";
const targetSpecs = readTargetSpecs();
const smartReplyTargetNames = readNameList(process.env.LARK_SMART_REPLY_TARGET_NAMES, ["李文贤", "何运伟", "谷力刚", "邓景夫", "吴德宏", "曾庆锦"]);
const priorityFixedTargetNames = readNameList(process.env.LARK_AUTOREPLY_PRIORITY_FIXED_TARGET_NAMES, []);
const excludedTargetNames = readNameList(process.env.LARK_AUTOREPLY_EXCLUDE_TARGET_NAMES, []);
const replyMode = readReplyMode();
const replyTexts = readReplyTexts();
const autoReplyMarker = readAutoReplyMarker();
const replyToSourceMessageEnabled = process.env.LARK_AUTOREPLY_REPLY_TO_SOURCE_MESSAGE_ENABLED !== "false";
const fixedReplySuppressWindowsEnabled = process.env.LARK_AUTOREPLY_FIXED_REPLY_SUPPRESS_WINDOWS_ENABLED === "true";
const fixedReplySuppressWindows = readFixedReplySuppressWindows();
const knownWeatherLocations = [
  "深圳",
  "广州",
  "东莞",
  "佛山",
  "惠州",
  "中山",
  "珠海",
  "上海",
  "北京",
  "杭州",
  "南京",
  "苏州",
  "成都",
  "重庆",
  "武汉",
  "西安",
  "长沙",
  "厦门",
  "福州",
  "香港",
  "澳门",
  "台北"
];
const weatherLocationAliases: Record<string, string[]> = {
  松江: ["松江", "上海"],
  浦东: ["浦东", "上海"],
  徐汇: ["徐汇", "上海"],
  闵行: ["闵行", "上海"],
  宝山: ["宝山", "上海"],
  嘉定: ["嘉定", "上海"],
  青浦: ["青浦", "上海"],
  南山: ["南山", "深圳"],
  福田: ["福田", "深圳"],
  宝安: ["宝安", "深圳"],
  龙岗: ["龙岗", "深圳"],
  龙华: ["龙华", "深圳"],
  罗湖: ["罗湖", "深圳"],
  天河: ["天河", "广州"],
  番禺: ["番禺", "广州"],
  黄埔: ["黄埔", "广州"]
};
const weatherGeoByLocation: Record<string, WeatherGeo> = {
  上海: { name: "上海", latitude: 31.2304, longitude: 121.4737 },
  Shanghai: { name: "上海", latitude: 31.2304, longitude: 121.4737 },
  松江: { name: "上海松江", latitude: 31.0326, longitude: 121.2277 },
  浦东: { name: "上海浦东", latitude: 31.2211, longitude: 121.5441 },
  徐汇: { name: "上海徐汇", latitude: 31.1885, longitude: 121.4368 },
  闵行: { name: "上海闵行", latitude: 31.1128, longitude: 121.3817 },
  宝山: { name: "上海宝山", latitude: 31.4055, longitude: 121.4896 },
  嘉定: { name: "上海嘉定", latitude: 31.3756, longitude: 121.2653 },
  青浦: { name: "上海青浦", latitude: 31.1509, longitude: 121.1242 },
  深圳: { name: "深圳", latitude: 22.5431, longitude: 114.0579 },
  Shenzhen: { name: "深圳", latitude: 22.5431, longitude: 114.0579 },
  南山: { name: "深圳南山", latitude: 22.5333, longitude: 113.9304 },
  福田: { name: "深圳福田", latitude: 22.5229, longitude: 114.0556 },
  宝安: { name: "深圳宝安", latitude: 22.5553, longitude: 113.8831 },
  龙岗: { name: "深圳龙岗", latitude: 22.7209, longitude: 114.2469 },
  龙华: { name: "深圳龙华", latitude: 22.6967, longitude: 114.0458 },
  罗湖: { name: "深圳罗湖", latitude: 22.5483, longitude: 114.1316 },
  广州: { name: "广州", latitude: 23.1291, longitude: 113.2644 },
  Guangzhou: { name: "广州", latitude: 23.1291, longitude: 113.2644 },
  北京: { name: "北京", latitude: 39.9042, longitude: 116.4074 },
  杭州: { name: "杭州", latitude: 30.2741, longitude: 120.1551 },
  南京: { name: "南京", latitude: 32.0603, longitude: 118.7969 },
  苏州: { name: "苏州", latitude: 31.2989, longitude: 120.5853 },
  成都: { name: "成都", latitude: 30.5728, longitude: 104.0668 },
  重庆: { name: "重庆", latitude: 29.563, longitude: 106.5516 },
  武汉: { name: "武汉", latitude: 30.5928, longitude: 114.3055 },
  西安: { name: "西安", latitude: 34.3416, longitude: 108.9398 },
  长沙: { name: "长沙", latitude: 28.2282, longitude: 112.9388 },
  厦门: { name: "厦门", latitude: 24.4798, longitude: 118.0894 },
  福州: { name: "福州", latitude: 26.0745, longitude: 119.2965 },
  香港: { name: "香港", latitude: 22.3193, longitude: 114.1694 },
  澳门: { name: "澳门", latitude: 22.1987, longitude: 113.5439 },
  台北: { name: "台北", latitude: 25.033, longitude: 121.5654 }
};
const pollIntervalMs = readPollIntervalMs();
const pollConcurrency = readPositiveInteger(process.env.LARK_AUTOREPLY_POLL_CONCURRENCY, 10);
const priorityPollConcurrency = readPositiveInteger(process.env.LARK_AUTOREPLY_PRIORITY_POLL_CONCURRENCY, Math.min(pollConcurrency, 5));
const fullPollIntervalMs = readNonNegativeInteger(process.env.LARK_AUTOREPLY_FULL_POLL_MS, Math.max(pollIntervalMs, 10_000));
const rateLimitBackoffMs = readPositiveInteger(process.env.LARK_AUTOREPLY_RATE_LIMIT_BACKOFF_MS, 3_000);
const maxRateLimitBackoffMs = readPositiveInteger(process.env.LARK_AUTOREPLY_MAX_BACKOFF_MS, 30_000);
const pollOverlapSeconds = readNonNegativeInteger(process.env.LARK_AUTOREPLY_POLL_OVERLAP_SECONDS, 120);
const lookbackSeconds = readPositiveNumber(process.env.LARK_AUTOREPLY_LOOKBACK_SECONDS, 300);
const contextLookbackSeconds = readPositiveNumber(process.env.LARK_SMART_REPLY_CONTEXT_SECONDS, 24 * 60 * 60);
const maxSmartReplyContextMessages = readPositiveInteger(process.env.LARK_SMART_REPLY_MAX_CONTEXT_MESSAGES, 60);
const maxSmartReplyMessages = Math.min(readPositiveInteger(process.env.LARK_SMART_REPLY_MAX_MESSAGES, 3), 3);
const realtimeWeatherEnabled = process.env.LARK_REALTIME_WEATHER_ENABLED !== "false";
const realtimeWeatherDefaultLocation = process.env.LARK_REALTIME_WEATHER_DEFAULT_LOCATION?.trim();
const realtimeReplyDelayMs = readNonNegativeInteger(process.env.LARK_REALTIME_REPLY_DELAY_MS, 1800);
const skipIfSelfRepliedEnabled = process.env.LARK_AUTOREPLY_SKIP_IF_SELF_REPLIED_ENABLED === "true";
const selfReplyCheckDelayMs = readNonNegativeInteger(process.env.LARK_AUTOREPLY_SELF_REPLY_CHECK_DELAY_MS, 2_000);
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
const runtimeSwitchesReloadMs = readPositiveInteger(process.env.LARK_AUTOREPLY_SWITCHES_RELOAD_MS, 1_000);

const skippedTargetNames: string[] = [];
let cachedKnowledgeIndex: KnowledgeIndex | undefined;
let cachedKnowledgeLoadedAt = 0;
let cachedRuntimeSwitches: RuntimeSwitches | undefined;
let cachedRuntimeSwitchesLoadedAt = 0;

let running = true;
process.once("SIGINT", () => {
  running = false;
});
process.once("SIGTERM", () => {
  running = false;
});

async function main(): Promise<void> {
  const startedAt = Math.floor(Date.now() / 1000);
  const minimumMessageTime = replyExisting ? 0 : startedAt;
  const client = LarkUserClient.fromEnv(tokenFile);
  const botClient = LarkClient.fromEnv();
  const state = await loadState();
  state.repliedMessageIds ??= [];
  state.lastReplyAtByChat ??= {};
  state.fixedReplyEscalationByChat ??= {};
  state.targets ??= migrateLegacyTargetState(state);
  const excludedOpenIds = await resolveExcludedOpenIds(client, state);
  pruneExcludedState(state, excludedOpenIds);
  const targets = await resolveTargets(client, state, excludedOpenIds);

  if (targets.length === 0) {
    throw new Error("Could not resolve any auto-reply targets. Check LARK_AUTOREPLY_TARGETS or LARK_AUTOREPLY_TARGET_NAMES in .env.");
  }

  const smartTargets = targets.filter(shouldUseSmartReply);
  const priorityFixedTargets = targets.filter((target) => !shouldUseSmartReply(target) && shouldUsePriorityFixedReply(target));
  const smartReply = smartTargets.length > 0 ? createSmartReplyGenerator() : undefined;
  const priorityTargetKeys = new Set([...smartTargets, ...priorityFixedTargets].map((target) => target.key));
  const priorityTargets = priorityTargetKeys.size > 0 ? targets.filter((target) => priorityTargetKeys.has(target.key)) : targets;
  const fullScanTargets = priorityTargetKeys.size > 0 ? targets.filter((target) => !priorityTargetKeys.has(target.key)) : [];
  let activePriorityPollIntervalMs = pollIntervalMs;
  let activePriorityPollConcurrency = Math.min(priorityPollConcurrency, priorityTargets.length);
  let activeFullPollConcurrency = Math.min(pollConcurrency, Math.max(fullScanTargets.length, 1));
  let nextFullScanAt = Date.now() + fullPollIntervalMs;
  let lastRateLimitWarningAt = 0;

  const selfOpenId = await getSelfOpenId(client);
  await saveState(state);

  console.log(`Auto reply is running for ${targets.length} target(s).`);
  if (minimumMessageTime > 0) {
    console.log(`Messages created before this process started will be skipped. Set LARK_AUTOREPLY_REPLY_EXISTING=true to reply to existing messages.`);
  }
  if (verboseTargetList) {
    console.log(`Target list: ${targets.map(formatTargetLabel).join(", ")}.`);
  }
  console.log(`Resolved ${targets.length} target(s) from ${targetSpecs.length} configured target spec(s).`);
  if (skippedTargetNames.length > 0) {
    console.log(`Skipped ${skippedTargetNames.length} target(s) without a direct chat. Set LARK_AUTOREPLY_VERBOSE_SKIPPED_TARGETS=true to list them.`);
  }
  console.log(`Excluded target names: ${excludedTargetNames.join(", ") || "none"}.`);
  console.log(formatReplyModeLog(smartTargets));
  if (priorityFixedTargets.length > 0) {
    console.log(`Priority fixed targets: ${priorityFixedTargets.map(formatTargetLabel).join(", ")}.`);
  }
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
    console.log(`Priority polling every ${pollIntervalMs}ms for ${priorityTargets.length} priority target(s); full scan every ${fullPollIntervalMs}ms for ${fullScanTargets.length} fixed target(s). Press Ctrl+C to stop.`);
  } else {
    console.log(`Polling every ${pollIntervalMs}ms with concurrency ${Math.min(priorityPollConcurrency, targets.length)}. Press Ctrl+C to stop.`);
  }

  while (running) {
    try {
      const runtimeSwitches = await getRuntimeSwitches();
      const priorityResult = await pollTargets(client, botClient, state, priorityTargets, selfOpenId, smartReply, activePriorityPollConcurrency, minimumMessageTime, runtimeSwitches);
      const shouldFullScan = fullScanTargets.length > 0 && Date.now() >= nextFullScanAt;
      const fullScanResult = shouldFullScan ? await pollTargets(client, botClient, state, fullScanTargets, selfOpenId, smartReply, activeFullPollConcurrency, minimumMessageTime, runtimeSwitches) : emptyPollTargetsResult();
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
  concurrency: number,
  minimumMessageTime: number,
  runtimeSwitches: RuntimeSwitches
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
          await pollOnce(client, botClient, state, target, selfOpenId, smartReply, minimumMessageTime, runtimeSwitches);
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

async function getRuntimeSwitches(): Promise<RuntimeSwitches> {
  const now = Date.now();
  if (cachedRuntimeSwitches && now - cachedRuntimeSwitchesLoadedAt < runtimeSwitchesReloadMs) {
    return cachedRuntimeSwitches;
  }
  try {
    cachedRuntimeSwitches = await loadRuntimeSwitches();
    cachedRuntimeSwitchesLoadedAt = now;
  } catch (error) {
    console.warn(`Could not load runtime switches; using previous settings. ${error instanceof Error ? error.message : String(error)}`);
    cachedRuntimeSwitches ??= { ...defaultRuntimeSwitches };
  }
  return cachedRuntimeSwitches;
}

function getDisabledReplyReason(target: ResolvedTarget, useSmartReply: boolean, switches: RuntimeSwitches): string | undefined {
  if (isChatTarget(target) && !useSmartReply && !switches.groupFixedReplyEnabled) {
    return "group fixed replies are off";
  }
  if (isChatTarget(target) && !useSmartReply && !isGroupFixedReplyChatEnabled(target, switches)) {
    return `group fixed replies are off for ${target.chatId}`;
  }
  if (!isChatTarget(target) && useSmartReply && !switches.directSmartReplyEnabled) {
    return "direct AI replies are off";
  }
  if (!isChatTarget(target) && useSmartReply && !isDirectSmartReplyTargetEnabled(target, switches)) {
    return `direct AI replies are off for ${target.name}`;
  }
  if (!isChatTarget(target) && !useSmartReply && !switches.directFixedReplyEnabled) {
    return "direct fixed replies are off";
  }
  return undefined;
}

function isGroupFixedReplyChatEnabled(target: ResolvedTarget, switches: RuntimeSwitches): boolean {
  return switches.groupFixedReplyByChat?.[target.chatId] ?? true;
}

function isDirectSmartReplyTargetEnabled(target: ResolvedTarget, switches: RuntimeSwitches): boolean {
  const selector = smartReplyTargetNames.find((item) => matchesTargetSelector(target, item));
  if (!selector) {
    return true;
  }
  return switches.directSmartReplyByTarget?.[selector] ?? true;
}

async function pollOnce(client: LarkUserClient, botClient: LarkClient, state: AutoReplyState, target: ResolvedTarget, selfOpenId: string | undefined, smartReply: SmartReplyGenerator | undefined, minimumMessageTime: number, runtimeSwitches: RuntimeSwitches): Promise<void> {
  const endTime = Math.floor(Date.now() / 1000);
  const targetState = state.targets?.[target.key] ?? {};
  const checkpointStartTime = targetState.lastCheckedAt === undefined ? endTime : Math.max(0, Math.min(targetState.lastCheckedAt, endTime - pollOverlapSeconds));
  const startTime = Math.max(checkpointStartTime, minimumMessageTime);
  const messages = await listMessages(client, target.chatId, startTime, endTime);
  let newestCreateTime = startTime;

  for (const message of messages) {
    const messageId = message.message_id;
    const createTime = readMessageCreateTime(message);
    if (createTime > newestCreateTime) {
      newestCreateTime = createTime;
    }

    if (minimumMessageTime > 0 && createTime < minimumMessageTime) {
      continue;
    }

    if (!messageId || state.repliedMessageIds?.includes(messageId)) {
      continue;
    }

    const senderOpenId = getSenderOpenId(message);
    if (!shouldRespondToIncomingMessage(message, target, senderOpenId, selfOpenId)) {
      continue;
    }

    const useSmartReply = smartReply !== undefined && shouldUseSmartReply(target);
    const disabledReason = getDisabledReplyReason(target, useSmartReply, runtimeSwitches);
    if (disabledReason) {
      state.repliedMessageIds = [...(state.repliedMessageIds ?? []), messageId].slice(-200);
      console.log(`Skipped ${target.name} message ${messageId}; ${disabledReason}.`);
      continue;
    }

    const replyGuardStartedAt = Date.now();
    if (!useSmartReply && isFixedReplySuppressedNow()) {
      state.repliedMessageIds = [...(state.repliedMessageIds ?? []), messageId].slice(-200);
      console.log(`Skipped fixed reply to ${target.name} message ${messageId} during Beijing working window.`);
      continue;
    }

    const incomingMessage = extractMessageText(message.msg_type, message.content ?? message.body?.content);
    const shouldGuardBeforeImmediateReply = useSmartReply && realtimeWeatherEnabled && (isWeatherRequest(incomingMessage) || hasActivePendingWeatherRequest(state, target.chatId));
    if (shouldGuardBeforeImmediateReply && await shouldSkipBecauseSelfReplied(client, target, selfOpenId, messageId, createTime, replyGuardStartedAt)) {
      state.repliedMessageIds = [...(state.repliedMessageIds ?? []), messageId].slice(-200);
      console.log(`Skipped auto reply to ${target.name} message ${messageId} because you already replied manually.`);
      continue;
    }

    if (!useSmartReply) {
      await resetFixedReplyEscalationIfManuallyReplied(client, state, target, selfOpenId, createTime);
    }

    const realtimeRepliedBy = useSmartReply ? await trySendRealtimeWeatherReply(client, botClient, state, target, incomingMessage, messageId) : undefined;
    const texts = realtimeRepliedBy ? [] : useSmartReply && smartReply ? await buildSmartReplies(client, target, incomingMessage, selfOpenId, endTime, smartReply) : pickFixedReplyTexts(state, target);
    if (!realtimeRepliedBy && await shouldSkipBecauseSelfReplied(client, target, selfOpenId, messageId, createTime, replyGuardStartedAt)) {
      if (!useSmartReply) {
        resetFixedReplyEscalation(state, target.chatId);
      }
      state.repliedMessageIds = [...(state.repliedMessageIds ?? []), messageId].slice(-200);
      console.log(`Skipped auto reply to ${target.name} message ${messageId} because you replied while the reply was being prepared.`);
      continue;
    }
    const repliedBy = realtimeRepliedBy ?? await sendAutoReply(client, botClient, target, texts, messageId);
    if (!useSmartReply && !realtimeRepliedBy) {
      advanceFixedReplyEscalation(state, target.chatId);
    }
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
      targetType: target.targetType,
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

async function shouldSkipBecauseSelfReplied(
  client: LarkUserClient,
  target: ResolvedTarget,
  selfOpenId: string | undefined,
  sourceMessageId: string,
  sourceCreateTime: number,
  guardStartedAt: number
): Promise<boolean> {
  if (!skipIfSelfRepliedEnabled || !selfOpenId) {
    return false;
  }

  const remainingDelayMs = selfReplyCheckDelayMs - (Date.now() - guardStartedAt);
  if (remainingDelayMs > 0) {
    await delay(remainingDelayMs);
  }

  const endTime = Math.floor(Date.now() / 1000);
  const messages = await listMessages(client, target.chatId, Math.max(0, sourceCreateTime - 1), endTime);
  let sourceSeen = false;
  for (const message of messages) {
    if (message.message_id === sourceMessageId) {
      sourceSeen = true;
      continue;
    }

    if (!sourceSeen && readMessageCreateTime(message) <= sourceCreateTime) {
      continue;
    }

    if (getSenderOpenId(message) !== selfOpenId) {
      continue;
    }

    const text = extractMessageText(message.msg_type, message.content ?? message.body?.content);
    if (text && !isDelegatedAutoReplyText(text)) {
      return true;
    }
  }
  return false;
}

function pickFixedReplyTexts(state: AutoReplyState, target: ResolvedTarget): string[] {
  if (replyTexts.length <= 1) {
    return replyTexts;
  }
  const currentLevel = Math.max(0, state.fixedReplyEscalationByChat?.[target.chatId]?.level ?? 0);
  return [replyTexts[Math.min(currentLevel, replyTexts.length - 1)]];
}

function advanceFixedReplyEscalation(state: AutoReplyState, chatId: string): void {
  const currentLevel = Math.max(0, state.fixedReplyEscalationByChat?.[chatId]?.level ?? 0);
  state.fixedReplyEscalationByChat = {
    ...(state.fixedReplyEscalationByChat ?? {}),
    [chatId]: {
      level: Math.min(currentLevel + 1, Math.max(replyTexts.length - 1, 0)),
      lastAutoReplyAt: Date.now()
    }
  };
}

function resetFixedReplyEscalation(state: AutoReplyState, chatId: string): void {
  if (!state.fixedReplyEscalationByChat?.[chatId]) {
    return;
  }
  const nextEscalationByChat = { ...state.fixedReplyEscalationByChat };
  delete nextEscalationByChat[chatId];
  state.fixedReplyEscalationByChat = nextEscalationByChat;
}

async function resetFixedReplyEscalationIfManuallyReplied(
  client: LarkUserClient,
  state: AutoReplyState,
  target: ResolvedTarget,
  selfOpenId: string | undefined,
  incomingCreateTime: number
): Promise<void> {
  const escalation = state.fixedReplyEscalationByChat?.[target.chatId];
  if (!escalation || !selfOpenId) {
    return;
  }

  const messages = await listMessages(client, target.chatId, Math.max(0, Math.floor(escalation.lastAutoReplyAt / 1000) - 1), incomingCreateTime);
  for (const message of messages) {
    const messageCreateTimeMs = readMessageCreateTime(message) * 1000;
    if (messageCreateTimeMs <= escalation.lastAutoReplyAt || messageCreateTimeMs > incomingCreateTime * 1000) {
      continue;
    }
    if (getSenderOpenId(message) !== selfOpenId) {
      continue;
    }

    const text = extractMessageText(message.msg_type, message.content ?? message.body?.content);
    if (text && !isDelegatedAutoReplyText(text)) {
      resetFixedReplyEscalation(state, target.chatId);
      return;
    }
  }
}

async function sendTextMessage(client: LarkUserClient, chatId: string, text: string, sourceMessageId: string, replyIndex: number): Promise<void> {
  const uuid = `ar-${shortHash(`${sourceMessageId}:${replyIndex}`)}`;
  if (replyToSourceMessageEnabled) {
    try {
      await replyTextMessage(client, sourceMessageId, text, uuid);
      return;
    } catch (error) {
      console.warn(`Could not reply to source message ${sourceMessageId}; falling back to direct chat send: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  await client.request({
    method: "POST",
    path: "/open-apis/im/v1/messages",
    query: { receive_id_type: "chat_id" },
    body: {
      receive_id: chatId,
      msg_type: "text",
      content: JSON.stringify({ text }),
      uuid
    }
  });
}

async function replyTextMessage(client: LarkUserClient, sourceMessageId: string, text: string, uuid: string): Promise<void> {
  await client.request({
    method: "POST",
    path: `/open-apis/im/v1/messages/${sourceMessageId}/reply`,
    body: {
      msg_type: "text",
      content: JSON.stringify({ text }),
      uuid
    }
  });
}

async function sendBotTextMessage(
  client: LarkClient,
  receiveId: string,
  receiveIdType: "open_id" | "chat_id",
  text: string,
  sourceMessageId: string,
  replyIndex: number
): Promise<void> {
  const uuid = `bot-ar-${shortHash(`${sourceMessageId}:${replyIndex}`)}`;
  if (replyToSourceMessageEnabled) {
    try {
      await replyBotTextMessage(client, sourceMessageId, text, uuid);
      return;
    } catch (error) {
      console.warn(`Could not reply to source message ${sourceMessageId} as bot; falling back to direct send: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  await client.request({
    method: "POST",
    path: "/open-apis/im/v1/messages",
    query: { receive_id_type: receiveIdType },
    body: {
      receive_id: receiveId,
      msg_type: "text",
      content: JSON.stringify({ text }),
      uuid
    }
  });
}

async function replyBotTextMessage(client: LarkClient, sourceMessageId: string, text: string, uuid: string): Promise<void> {
  await client.request({
    method: "POST",
    path: `/open-apis/im/v1/messages/${sourceMessageId}/reply`,
    body: {
      msg_type: "text",
      content: JSON.stringify({ text }),
      uuid
    }
  });
}

async function sendAutoReply(client: LarkUserClient, botClient: LarkClient, target: ResolvedTarget, texts: string[], sourceMessageId: string, replyIndexOffset = 0): Promise<"user" | "bot"> {
  const markedTexts = texts.map(formatAutoReplyText);
  const botReceiveId = isChatTarget(target) ? target.chatId : target.openId;
  const botReceiveIdType = isChatTarget(target) ? "chat_id" : "open_id";
  if (target.isExternal) {
    for (const [index, text] of markedTexts.entries()) {
      await sendBotTextMessage(botClient, botReceiveId, botReceiveIdType, text, sourceMessageId, index + replyIndexOffset);
    }
    return "bot";
  }

  try {
    for (const [index, text] of markedTexts.entries()) {
      await sendTextMessage(client, target.chatId, text, sourceMessageId, index + replyIndexOffset);
    }
    return "user";
  } catch (error) {
    if (!isExternalChatPermissionError(error)) {
      throw error;
    }
    for (const [index, text] of markedTexts.entries()) {
      await sendBotTextMessage(botClient, botReceiveId, botReceiveIdType, text, sourceMessageId, index + replyIndexOffset);
    }
    return "bot";
  }
}

function formatAutoReplyText(text: string): string {
  const trimmedText = text.trim();
  if (!autoReplyMarker) {
    return trimmedText;
  }
  return isMarkedAutoReplyText(trimmedText) ? trimmedText : `${trimmedText} ${autoReplyMarker}`;
}

async function buildSmartReplies(client: LarkUserClient, target: ResolvedTarget, incomingMessage: string, selfOpenId: string | undefined, endTime: number, smartReply: SmartReplyGenerator): Promise<string[]> {
  const conversation = await readConversationContext(client, target, selfOpenId, endTime);
  const knowledge = knowledgeEnabled ? await searchKnowledgeForReply(incomingMessage, conversation) : [];
  return splitSmartReplyTexts(await smartReply({ targetName: target.name, incomingMessage, conversation, knowledge }));
}

async function trySendRealtimeWeatherReply(client: LarkUserClient, botClient: LarkClient, state: AutoReplyState, target: ResolvedTarget, incomingMessage: string, sourceMessageId: string): Promise<"user" | "bot" | undefined> {
  const hasPendingWeatherRequest = hasActivePendingWeatherRequest(state, target.chatId);
  if (!realtimeWeatherEnabled) {
    return undefined;
  }

  if (isNegatedWeatherRequest(incomingMessage)) {
    clearPendingWeatherRequest(state, target.chatId);
    return undefined;
  }

  const weatherRequest = isWeatherRequest(incomingMessage);
  if (!weatherRequest && !hasPendingWeatherRequest) {
    return undefined;
  }

  const extractedLocation = extractWeatherLocation(incomingMessage) ?? (hasPendingWeatherRequest ? extractStandaloneWeatherLocation(incomingMessage) : undefined);
  if (!weatherRequest && hasPendingWeatherRequest && !extractedLocation) {
    clearPendingWeatherRequest(state, target.chatId);
    return undefined;
  }

  const location = buildWeatherLocationCandidate(extractedLocation ?? (weatherRequest ? realtimeWeatherDefaultLocation : undefined));
  if (!location) {
    state.pendingWeatherByChat = { ...(state.pendingWeatherByChat ?? {}), [target.chatId]: { requestedAt: Date.now() } };
    return sendAutoReply(client, botClient, target, ["你问哪个城市的天气？"], sourceMessageId);
  }

  clearPendingWeatherRequest(state, target.chatId);

  const repliedBy = await sendAutoReply(client, botClient, target, [`我看下${location.label}天气`], sourceMessageId);
  const lookupStartedAt = Date.now();
  const weatherText = await buildWeatherReplyText(location).catch((error) => {
    console.warn(`Could not lookup weather for ${location.label}: ${error instanceof Error ? error.message : String(error)}`);
    return `${location.label}天气我这边没查出来|你可以换成市名问我，比如上海、深圳这种`;
  });
  await delay(Math.max(0, realtimeReplyDelayMs - (Date.now() - lookupStartedAt)));
  await sendAutoReply(client, botClient, target, splitSmartReplyTexts(weatherText), sourceMessageId, 1);
  return repliedBy;
}

function hasActivePendingWeatherRequest(state: AutoReplyState, chatId: string): boolean {
  return Boolean(state.pendingWeatherByChat?.[chatId] && Date.now() - state.pendingWeatherByChat[chatId].requestedAt < 10 * 60 * 1000);
}

function clearPendingWeatherRequest(state: AutoReplyState, chatId: string): void {
  if (!state.pendingWeatherByChat?.[chatId]) {
    return;
  }
  const { [chatId]: _removed, ...rest } = state.pendingWeatherByChat;
  state.pendingWeatherByChat = rest;
}

async function buildWeatherReplyText(location: WeatherLocationCandidate): Promise<string> {
  const weather = await lookupWeather(location);
  const parts = [
    `${weather.location}现在${weather.description}`,
    weather.tempC ? `${weather.tempC}℃` : undefined,
    weather.feelsLikeC ? `体感${weather.feelsLikeC}℃` : undefined,
    weather.humidity ? `湿度${weather.humidity}%` : undefined,
    weather.windKmph ? `风速${weather.windKmph}km/h` : undefined
  ].filter(Boolean);

  return `${parts.join("，")}|你要出门的话还是看眼本地天气 App，临近预报更准`;
}

async function lookupWeather(location: WeatherLocationCandidate): Promise<WeatherLookupResult> {
  let lastError: unknown;
  for (const query of location.queries) {
    try {
      return await lookupWeatherQuery(query, location.label);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function lookupWeatherQuery(query: string, fallbackLabel: string): Promise<WeatherLookupResult> {
  const geo = weatherGeoByLocation[query] ?? (await geocodeWeatherLocation(query));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${geo.latitude}&longitude=${geo.longitude}&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m&timezone=auto`;
    const response = await fetch(url, { signal: controller.signal, headers: { "User-Agent": "lark-autoreply/0.1" } });
    const responseText = await response.text();
    if (!response.ok) {
      throw new Error(`Weather API ${response.status}: ${responseText.slice(0, 200)}`);
    }
    const payload = parseJson(responseText) as Record<string, unknown>;
    const current = typeof payload.current === "object" && payload.current ? (payload.current as Record<string, unknown>) : undefined;
    if (!current) {
      throw new Error(`Weather response missing current: ${responseText.slice(0, 200)}`);
    }
    return {
      location: geo.name || fallbackLabel,
      description: describeWeatherCode(readNumberValue(current.weather_code)),
      tempC: readNumberText(current.temperature_2m),
      feelsLikeC: readNumberText(current.apparent_temperature),
      humidity: readNumberText(current.relative_humidity_2m),
      windKmph: readNumberText(current.wind_speed_10m)
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function geocodeWeatherLocation(query: string): Promise<WeatherGeo> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query)}&count=1&language=zh&format=json`;
    const response = await fetch(url, { signal: controller.signal, headers: { "User-Agent": "lark-autoreply/0.1" } });
    const responseText = await response.text();
    if (!response.ok) {
      throw new Error(`Weather geocoding API ${response.status}: ${responseText.slice(0, 200)}`);
    }
    const payload = parseJson(responseText) as Record<string, unknown>;
    const result = readFirstObject(payload.results);
    const latitude = readNumberValue(result?.latitude);
    const longitude = readNumberValue(result?.longitude);
    if (!result || latitude === undefined || longitude === undefined) {
      throw new Error(`Weather geocoding found no result for ${query}`);
    }
    return {
      name: readString(result.name) ?? query,
      latitude,
      longitude
    };
  } finally {
    clearTimeout(timeout);
  }
}

function splitSmartReplyTexts(reply: string): string[] {
  const texts = reply
    .split("|")
    .map((text) => text.trim())
    .filter(Boolean)
    .slice(0, maxSmartReplyMessages);

  return texts.length > 0 ? texts : [reply.trim()];
}

function isWeatherRequest(text: string): boolean {
  return /(天气|气温|温度|下雨|降雨|暴雨|台风|空气质量|aqi)/i.test(text);
}

function isNegatedWeatherRequest(text: string): boolean {
  return /(没(有)?在?说天气|不是(说|问)?天气|不(是)?问天气|没问天气|不是查天气|别查天气|不用查天气)/.test(text.replace(/\s+/g, ""));
}

function extractWeatherLocation(text: string): string | undefined {
  const compactText = text.replace(/\s+/g, "");
  const knownLocation = knownWeatherLocations.find((location) => compactText.includes(location));
  if (knownLocation) {
    return knownLocation;
  }
  const aliasLocation = Object.keys(weatherLocationAliases).find((location) => compactText.includes(location));
  if (aliasLocation) {
    return aliasLocation;
  }

  const beforeKeyword = compactText.match(/([\u4e00-\u9fa5A-Za-z·.-]{2,24})(?:的)?(?:天气|气温|温度|下雨|降雨|暴雨|台风|空气质量|aqi)/i)?.[1];
  return cleanWeatherLocationCandidate(beforeKeyword);
}

function extractStandaloneWeatherLocation(text: string): string | undefined {
  const compactText = text.replace(/[\s，,。.!！?？]/g, "");
  if (!compactText || compactText.length > 16 || isWeatherRequest(compactText)) {
    return undefined;
  }

  const normalizedText = compactText.replace(/市$/, "");
  if (knownWeatherLocations.includes(normalizedText) || weatherLocationAliases[normalizedText] || weatherGeoByLocation[normalizedText]) {
    return normalizedText;
  }
  if (/^[\u4e00-\u9fa5A-Za-z·.-]{2,24}$/.test(normalizedText) && !/(看不懂|表情|没有|不是|你|我|他|她|它|这|那|什么|怎么|为啥|脑子|坏了)/.test(normalizedText)) {
    return normalizedText;
  }
  return undefined;
}

function buildWeatherLocationCandidate(location: string | undefined): WeatherLocationCandidate | undefined {
  if (!location) {
    return undefined;
  }

  const aliasQueries = weatherLocationAliases[location];
  if (aliasQueries) {
    return { label: location, queries: uniqueStrings([location, ...aliasQueries]) };
  }

  const normalizedLocation = location.replace(/市$/, "");
  const normalizedAliasQueries = weatherLocationAliases[normalizedLocation];
  if (normalizedAliasQueries) {
    return { label: location, queries: uniqueStrings([location, normalizedLocation, ...normalizedAliasQueries]) };
  }

  return { label: location, queries: uniqueStrings([location, normalizedLocation]) };
}

function cleanWeatherLocationCandidate(value: string | undefined): string | undefined {
  const candidate = value
    ?.replace(/^(你能|能不能|可以|可不可以|帮我|给我|麻烦|帮忙|查一下|查下|看一下|看下|问一下|问下|想知道|今天|明天|现在|一下)+/g, "")
    .replace(/(今天|明天|现在|一下|怎么样|如何|吗|呢|啊|呀)$/g, "")
    .trim();

  if (!candidate || candidate.length < 2) {
    return undefined;
  }
  if (/^(天气|气温|温度|下雨|降雨|暴雨|台风|空气质量|aqi)$/i.test(candidate)) {
    return undefined;
  }
  if (/(你能|帮我|给我|麻烦|查|看|问|想知道)/.test(candidate)) {
    return undefined;
  }
  return candidate;
}

function readFirstObject(value: unknown): Record<string, unknown> | undefined {
  return Array.isArray(value) && value[0] && typeof value[0] === "object" ? (value[0] as Record<string, unknown>) : undefined;
}

function readNestedValue(value: unknown, key: string): string | undefined {
  const object = readFirstObject(value);
  return object ? readString(object[key]) : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readNumberValue(value: unknown): number | undefined {
  const numberValue = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(numberValue) ? numberValue : undefined;
}

function readNumberText(value: unknown): string | undefined {
  const numberValue = readNumberValue(value);
  return numberValue === undefined ? undefined : String(Math.round(numberValue));
}

function describeWeatherCode(code: number | undefined): string {
  if (code === undefined) {
    return "天气信息不完整";
  }
  if (code === 0) return "晴";
  if ([1, 2].includes(code)) return "多云";
  if (code === 3) return "阴";
  if ([45, 48].includes(code)) return "有雾";
  if ([51, 53, 55, 56, 57].includes(code)) return "有毛毛雨";
  if ([61, 63, 65, 66, 67].includes(code)) return "有雨";
  if ([71, 73, 75, 77].includes(code)) return "有雪";
  if ([80, 81, 82].includes(code)) return "有阵雨";
  if ([85, 86].includes(code)) return "有阵雪";
  if ([95, 96, 99].includes(code)) return "有雷雨";
  return "天气信息不完整";
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
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
      const baseSpeaker = senderOpenId === selfOpenId ? "me" : senderOpenId === target.openId ? "target" : "other";
      const text = extractMessageText(message.msg_type, message.content ?? message.body?.content);
      if (!text) {
        return undefined;
      }
      const isAutoReply = baseSpeaker === "me" && isDelegatedAutoReplyText(text);
      const speaker = isAutoReply ? "auto" : baseSpeaker;
      const contextText = isAutoReply ? stripAutoReplyMarker(text) : text;
      return { speaker, text: contextText, createdAt: readMessageCreateTime(message) };
    })
    .filter((message): message is SmartReplyConversationMessage => Boolean(message))
    .slice(-maxSmartReplyContextMessages);
}

function stripAutoReplyMarker(text: string): string {
  let result = text.trim();
  if (autoReplyMarker && result.endsWith(` ${autoReplyMarker}`)) {
    result = result.slice(0, -(` ${autoReplyMarker}`).length).trim();
  }
  if (result.endsWith(" ar")) {
    result = result.slice(0, -3).trim();
  }
  return result.replace(/^AR:\s*/i, "").trim();
}

function isDelegatedAutoReplyText(text: string): boolean {
  if (isMarkedAutoReplyText(text)) {
    return true;
  }

  const normalizedText = text.replace(/\s+/g, "");
  if (replyTexts.some((replyText) => normalizedText === replyText.replace(/\s+/g, ""))) {
    return true;
  }

  return ["机器人", "我在出差", "请留言", "稍后再聊", "自动回复"].some((phrase) => normalizedText.includes(phrase));
}

function isMarkedAutoReplyText(text: string): boolean {
  const trimmedText = text.trim();
  return Boolean((autoReplyMarker && trimmedText.endsWith(` ${autoReplyMarker}`)) || trimmedText.endsWith(" ar") || trimmedText.startsWith("AR:"));
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
  const seenTargetKeys = new Set<string>();
  const now = Math.floor(Date.now() / 1000);
  for (const spec of targetSpecs) {
    const specTargets = await resolveTargetSpec(client, state, spec, now, excludedOpenIds);
    for (const target of specTargets) {
      if (seenTargetKeys.has(target.key)) {
        continue;
      }
      seenTargetKeys.add(target.key);
      resolvedTargets.push(target);
    }
  }
  return resolvedTargets;
}

async function resolveTargetSpec(client: LarkUserClient, state: AutoReplyState, spec: TargetSpec, now: number, excludedOpenIds: Set<string>): Promise<ResolvedTarget[]> {
  if (spec.type === "chat") {
    return [resolveChatTarget(state, spec, now)];
  }

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

function resolveChatTarget(state: AutoReplyState, spec: Extract<TargetSpec, { type: "chat" }>, now: number): ResolvedTarget {
  const chatId = spec.value;
  const targetKey = chatTargetKey(chatId);
  const existing = findExistingTargetState(state, [targetKey, spec.label]);
  return persistResolvedTarget(state, targetKey, `群聊 ${chatId}`, chatId, chatId, false, spec.label, existing, now, "chat");
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
  now: number,
  targetType: "person" | "chat" = "person"
): ResolvedTarget {
  const targetState = {
    openId,
    chatId,
    isExternal,
    targetType,
    lastCheckedAt: existing?.lastCheckedAt ?? (replyExisting ? now - lookbackSeconds : now)
  };
  const targets = {
    ...(state.targets ?? {}),
    [key]: targetState
  };
  if (source.startsWith("person:") || source.startsWith("external:") || source.startsWith("chat:")) {
    targets[source] = targetState;
  }
  state.targets = {
    ...targets
  };
  return { key, name, openId, chatId, source, isExternal, targetType };
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
    delete state.fixedReplyEscalationByChat?.[chatId];
  }
}

function userTargetKey(openId: string): string {
  return `user:${openId}`;
}

function chatTargetKey(chatId: string): string {
  return `chat:${chatId}`;
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

function shouldRespondToIncomingMessage(message: Message, target: ResolvedTarget, senderOpenId: string | undefined, selfOpenId: string | undefined): boolean {
  if (!senderOpenId || senderOpenId === selfOpenId) {
    return false;
  }

  if (isChatTarget(target)) {
    const mentionsSelf = isMentioningSelf(message, selfOpenId);
    if (!mentionsSelf && verboseSkippedTargets) {
      console.log(`Skipped group message ${message.message_id ?? "unknown"} in ${target.name}; it did not mention the current user.`);
    }
    return mentionsSelf;
  }

  return senderOpenId === target.openId;
}

function isMentioningSelf(message: Message, selfOpenId: string | undefined): boolean {
  if (!selfOpenId) {
    return false;
  }

  const mentions = [...(message.mentions ?? []), ...(message.body?.mentions ?? []), ...readContentMentions(message.content ?? message.body?.content)];
  if (mentions.some((mention) => getMentionOpenId(mention) === selfOpenId)) {
    return true;
  }
  if (mentions.length > 0) {
    return false;
  }

  const contentText = message.content ?? message.body?.content ?? "";
  return contentText.includes(selfOpenId) || /@_user_\d+/.test(contentText);
}

function readContentMentions(rawContent: string | undefined): MessageMention[] {
  const content = parseJson(rawContent ?? "") as Record<string, unknown>;
  return Array.isArray(content.mentions) ? content.mentions.filter(isMessageMention) : [];
}

function isMessageMention(value: unknown): value is MessageMention {
  return Boolean(value && typeof value === "object");
}

function getMentionOpenId(mention: MessageMention): string | undefined {
  if (typeof mention.id === "string") {
    return mention.id_type === "open_id" ? mention.id : undefined;
  }
  return mention.id?.open_id;
}

function isChatTarget(target: ResolvedTarget): boolean {
  return target.targetType === "chat" || target.source.startsWith("chat:") || target.key.startsWith("chat:");
}

function resolvePath(path: string): string {
  return resolve(rootDir, path);
}

function readPositiveNumber(value: string | undefined, fallback: number): number {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) && numberValue > 0 ? numberValue : fallback;
}

function readAutoReplyMarker(): string {
  const configuredMarker = process.env.LARK_AUTOREPLY_MARKER ?? process.env.LARK_AUTOREPLY_PREFIX;
  const marker = configuredMarker?.trim();
  if (!marker || marker === "AR:") {
    return "ᵃʳ";
  }
  return marker;
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
  return smartReplyTargetNames.some((selector) => matchesTargetSelector(target, selector));
}

function shouldUsePriorityFixedReply(target: ResolvedTarget): boolean {
  return priorityFixedTargetNames.some((selector) => matchesTargetSelector(target, selector));
}

function matchesTargetSelector(target: ResolvedTarget, selector: string): boolean {
  const trimmed = selector.trim();
  const separatorIndex = trimmed.indexOf(":");
  if (separatorIndex !== -1) {
    const type = trimmed.slice(0, separatorIndex).trim().toLowerCase();
    const value = trimmed.slice(separatorIndex + 1).trim();
    if (isExternalPersonType(type)) {
      return target.source === `external:${value}`;
    }
    if (isChatTargetType(type)) {
      return target.source === `chat:${value}`;
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
  if (isChatTarget(target)) {
    return target.name;
  }
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
  if (isChatTargetType(type)) {
    return { type: "chat", value, label: `chat:${value}` };
  }
  if (isExternalPersonType(type)) {
    return { type: "external_person", value, label: `external:${value}` };
  }
  return { type: "person", value, label: `person:${value}` };
}

function isExternalPersonType(type: string): boolean {
  return ["external", "external_person", "external_user", "外部", "外部联系人"].includes(type);
}

function isChatTargetType(type: string): boolean {
  return ["chat", "chat_id", "group", "group_chat", "群", "群聊"].includes(type);
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