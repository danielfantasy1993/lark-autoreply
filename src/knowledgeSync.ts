#!/usr/bin/env node
import { config as loadDotEnv } from "dotenv";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { extractMessageText } from "./smartReply.js";
import { LarkUserClient } from "./userTokenClient.js";
import { getKnowledgeIndexFile, readKnowledgeKeywords, readList, saveKnowledgeIndex, shortStableId, type KnowledgeItem } from "./knowledgeStore.js";

loadDotEnv({ path: resolve(dirname(fileURLToPath(import.meta.url)), "../.env") });

type ApiList<T> = {
  data?: {
    items?: T[];
    has_more?: boolean;
    page_token?: string;
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
};

type Mailbox = {
  id?: string;
  mailbox_id?: string;
  user_mailbox_id?: string;
  email?: string;
  name?: string;
};

type MailMessage = {
  id?: string;
  message_id?: string;
  subject?: string;
  from?: unknown;
  to?: unknown;
  cc?: unknown;
  body?: unknown;
  content?: unknown;
  body_plain_text?: string;
  body_html?: string;
  snippet?: string;
  summary?: string;
  sent_at?: string | number;
  received_at?: string | number;
  created_at?: string | number;
  updated_at?: string | number;
};

type TargetState = {
  chatId?: string;
  openId?: string;
  isExternal?: boolean;
  lastCheckedAt?: number;
};

type AutoReplyState = {
  targets?: Record<string, TargetState>;
};

type DocxRawContentResponse = {
  data?: {
    content?: string;
  };
};

type DocsContentResponse = {
  data?: {
    content?: string;
  };
};

type SearchDataResponse = {
  data?: {
    items?: unknown[];
    docs_entities?: unknown[];
    objects?: unknown[];
    has_more?: boolean;
    page_token?: string;
  };
};

type UserInfoResponse = {
  data?: {
    open_id?: string;
    user_id?: string;
    name?: string;
  };
};

type CloudDocCandidate = {
  id: string;
  token?: string;
  title: string;
  content?: string;
  url?: string;
  source: "doc" | "sheet";
  keywords: string[];
};

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tokenFile = resolvePath(process.env.LARK_USER_TOKEN_FILE || ".lark-user-token.json");
const stateFile = resolvePath(process.env.LARK_AUTOREPLY_STATE_FILE || ".lark-auto-reply-state.json");
const indexFile = getKnowledgeIndexFile(rootDir);
const keywords = readKnowledgeKeywords();
const syncDays = readPositiveNumber(process.env.LARK_KNOWLEDGE_SYNC_DAYS, 30);
const maxChats = readPositiveInteger(process.env.LARK_KNOWLEDGE_MAX_CHATS, 120);
const maxMessagesPerChat = readPositiveInteger(process.env.LARK_KNOWLEDGE_MAX_MESSAGES_PER_CHAT, 50);
const syncRateLimitBackoffMs = readPositiveInteger(process.env.LARK_KNOWLEDGE_SYNC_RATE_LIMIT_BACKOFF_MS, 3_000);
const includeAllMonitoredChats = process.env.LARK_KNOWLEDGE_SYNC_MONITORED_CHATS !== "false";
const syncAllChatMessages = process.env.LARK_KNOWLEDGE_SYNC_ALL_CHAT_MESSAGES !== "false";
const syncCloudSearch = process.env.LARK_KNOWLEDGE_SEARCH_CLOUD_DOCS !== "false";
const cloudSearchPageSize = readPositiveInteger(process.env.LARK_KNOWLEDGE_SEARCH_PAGE_SIZE, 20);
const cloudSearchMaxPages = readPositiveInteger(process.env.LARK_KNOWLEDGE_SEARCH_MAX_PAGES, 3);
const cloudSearchDataTypes = readList(process.env.LARK_KNOWLEDGE_SEARCH_TYPES || "doc,sheet");
const cloudSearchOwnerIds = readList(process.env.LARK_KNOWLEDGE_OWNER_IDS || process.env.LARK_KNOWLEDGE_CREATOR_IDS);
const cloudSearchRequiredScopes = ["search:docs:read", "drive:drive:readonly", "drive:drive", "drive:drive.search:readonly"];
const docsContentRequiredScopes = ["docs:document.content:read"];
const syncMail = process.env.LARK_KNOWLEDGE_SYNC_MAIL !== "false";
const mailDays = readPositiveNumber(process.env.LARK_KNOWLEDGE_MAIL_DAYS, syncDays);
const mailMaxMessages = readPositiveInteger(process.env.LARK_KNOWLEDGE_MAIL_MAX_MESSAGES, 300);
const mailRequiredScopes = ["mail:user_mailbox:readonly", "mail:mail:readonly", "mail:message:readonly"];
let canReadDocsContent: boolean | undefined;

async function main(): Promise<void> {
  const client = LarkUserClient.fromEnv(tokenFile);
  const items: KnowledgeItem[] = [];

  items.push(...readManualKnowledgeItems());
  if (includeAllMonitoredChats) {
    items.push(...(await syncMonitoredChatItems(client)));
  }
  if (syncCloudSearch) {
    if (!(await hasAnyRequiredUserScope(cloudSearchRequiredScopes))) {
      console.warn(`Cloud doc search warning: saved user token scope does not list any of ${cloudSearchRequiredScopes.join(", ")}. Trying the API anyway because Feishu may omit some doc scopes from the token metadata.`);
    }
    items.push(...(await syncCloudSearchItems(client)));
  }
  items.push(...(await syncDocxItems(client)));
  if (syncMail) {
    if (!(await hasAnyRequiredUserScope(mailRequiredScopes))) {
      console.warn(`Mail sync warning: saved user token scope does not list any of ${mailRequiredScopes.join(", ")}. Trying the API anyway; if it fails, add Feishu mail read scopes and run oauth:login again.`);
    }
    items.push(...(await syncMailItems(client)));
  }

  await saveKnowledgeIndex(indexFile, items);
  console.log(`Knowledge sync complete: ${items.length} item(s) saved to ${indexFile}.`);
  if (items.length === 0) {
    console.log("No knowledge items were collected. Add LARK_KNOWLEDGE_DOC_URLS or check chat/doc/mail permissions.");
  }
}

async function syncCloudSearchItems(client: LarkUserClient): Promise<KnowledgeItem[]> {
  const items: KnowledgeItem[] = [];
  const seen = new Set<string>();
  const searchTerms = readList(process.env.LARK_KNOWLEDGE_SEARCH_KEYS).length > 0 ? readList(process.env.LARK_KNOWLEDGE_SEARCH_KEYS) : buildCloudSearchTerms();
  if (searchTerms.length === 0) {
    console.warn("Cloud doc search skipped: search_key is required. Set LARK_KNOWLEDGE_KEYWORDS or LARK_KNOWLEDGE_SEARCH_KEYS.");
    return [];
  }

  for (const keyword of searchTerms) {
    let offset = 0;
    for (let page = 0; page < cloudSearchMaxPages; page += 1) {
      let response: SearchDataResponse;
      try {
        response = await client.request<SearchDataResponse>({
          method: "POST",
          path: "/open-apis/suite/docs-api/search/object",
          body: {
            search_key: keyword,
            count: cloudSearchPageSize,
            offset,
            docs_types: cloudSearchDataTypes,
            owner_ids: cloudSearchOwnerIds.length > 0 ? cloudSearchOwnerIds : undefined
          }
        });
      } catch (error) {
        console.warn(`Could not search cloud docs for ${keyword}: ${error instanceof Error ? error.message : String(error)}`);
        break;
      }

      for (const candidate of parseCloudDocCandidates(response, keyword)) {
        if (seen.has(candidate.id)) {
          continue;
        }
        seen.add(candidate.id);
        const syncedItem = await buildCloudKnowledgeItem(client, candidate);
        if (syncedItem) {
          items.push(syncedItem);
        }
      }

      if (!response.data?.has_more) {
        break;
      }
      offset += cloudSearchPageSize;
      await delay(readPositiveInteger(process.env.LARK_KNOWLEDGE_SYNC_DELAY_MS, 120));
    }
  }

  if (items.length > 0) {
    console.log(`Cloud doc search collected ${items.length} item(s).`);
  }
  return items;
}

async function buildCloudKnowledgeItem(client: LarkUserClient, candidate: CloudDocCandidate): Promise<KnowledgeItem | undefined> {
  const now = Math.floor(Date.now() / 1000);
  if (candidate.source === "doc" && candidate.token && (await hasDocsContentScope())) {
    try {
      const response = await readDocsMarkdownContent(client, candidate.token);
      const content = response.data?.content?.trim();
      if (content) {
        return {
          id: `cloud-doc:${candidate.token}`,
          source: "doc",
          title: candidate.title,
          content,
          url: candidate.url,
          updatedAt: now,
          keywords: matchKeywords(`${candidate.title}\n${content}`, keywords)
        };
      }
    } catch (error) {
      console.warn(`Could not read cloud doc ${candidate.title}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const fallbackContent = [candidate.title, candidate.content].filter(Boolean).join("\n").trim();
  if (!fallbackContent) {
    return undefined;
  }
  return {
    id: `cloud-search:${candidate.id}`,
    source: candidate.source,
    title: candidate.title,
    content: fallbackContent,
    url: candidate.url,
    updatedAt: now,
    keywords: candidate.keywords.length > 0 ? candidate.keywords : matchKeywords(fallbackContent, keywords)
  };
}

async function hasDocsContentScope(): Promise<boolean> {
  canReadDocsContent ??= await hasAnyRequiredUserScope(docsContentRequiredScopes);
  return canReadDocsContent;
}

async function readDocsMarkdownContent(client: LarkUserClient, docToken: string): Promise<DocsContentResponse> {
  return client.request<DocsContentResponse>({
    method: "GET",
    path: "/open-apis/docs/v1/content",
    query: {
      doc_token: docToken,
      doc_type: "docx",
      content_type: "markdown",
      lang: "zh"
    }
  });
}

function parseCloudDocCandidates(response: SearchDataResponse, keyword: string): CloudDocCandidate[] {
  return (response.data?.items ?? response.data?.docs_entities ?? response.data?.objects ?? [])
    .map((rawItem) => parseCloudDocCandidate(rawItem, keyword))
    .filter((item): item is CloudDocCandidate => Boolean(item));
}

function parseCloudDocCandidate(rawItem: unknown, keyword: string): CloudDocCandidate | undefined {
  const item = asRecord(rawItem);
  if (!item) {
    return undefined;
  }
  const nested = asRecord(item.data) ?? asRecord(item.resource) ?? asRecord(item.doc) ?? item;
  const rawType = readString(item.docs_type) ?? readString(nested.docs_type) ?? readString(item.data_type) ?? readString(item.type) ?? readString(nested.type) ?? "doc";
  const source = rawType.toLowerCase().includes("sheet") ? "sheet" : "doc";
  const title = readString(nested.title) ?? readString(item.title) ?? readString(nested.name) ?? readString(item.name) ?? "未命名云文档";
  const url = readString(nested.url) ?? readString(item.url) ?? readString(nested.link) ?? readString(item.link);
  const token = readString(nested.docs_token) ?? readString(item.docs_token) ?? readString(nested.token) ?? readString(nested.document_id) ?? readString(nested.doc_token) ?? readString(nested.obj_token) ?? parseDocxDocumentId(url ?? "");
  const id = token ?? readString(nested.id) ?? readString(item.id) ?? shortStableId(JSON.stringify(item));
  const content = readString(nested.summary) ?? readString(item.summary) ?? readString(nested.content) ?? readString(item.content) ?? readString(nested.snippet) ?? readString(item.snippet);

  return {
    id: `${source}:${id}`,
    token,
    title,
    content,
    url,
    source,
    keywords: matchKeywords(`${keyword}\n${title}\n${content ?? ""}`, keywords)
  };
}

async function hasAnyRequiredUserScope(scopes: string[]): Promise<boolean> {
  try {
    const token = JSON.parse(await readFile(tokenFile, "utf8")) as { scope?: string };
    const tokenScopes = new Set((token.scope ?? "").split(/\s+/).filter(Boolean));
    return scopes.some((scope) => tokenScopes.has(scope));
  } catch {
    return false;
  }
}

function readManualKnowledgeItems(): KnowledgeItem[] {
  const notes = readManualNotes(process.env.LARK_KNOWLEDGE_NOTES);
  return notes.map((note, index) => ({
    id: `manual:${shortStableId(`${index}:${note}`)}`,
    source: "manual",
    title: `手动背景 ${index + 1}`,
    content: note,
    updatedAt: Math.floor(Date.now() / 1000),
    keywords: keywords.filter((keyword) => note.toLowerCase().includes(keyword.toLowerCase()))
  }));
}

function readManualNotes(value: string | undefined): string[] {
  return (value ?? "")
    .split(/[|\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

async function syncDocxItems(client: LarkUserClient): Promise<KnowledgeItem[]> {
  const urls = readList(process.env.LARK_KNOWLEDGE_DOC_URLS);
  const items: KnowledgeItem[] = [];
  for (const url of urls) {
    const documentId = parseDocxDocumentId(url);
    if (!documentId) {
      console.warn(`Skipped unsupported doc URL: ${url}`);
      continue;
    }

    try {
      const response = await client.request<DocxRawContentResponse>({
        method: "GET",
        path: `/open-apis/docx/v1/documents/${encodeURIComponent(documentId)}/raw_content`,
        query: { lang: 0 }
      });
      const content = response.data?.content?.trim();
      if (!content) {
        continue;
      }
      items.push({
        id: `doc:${documentId}`,
        source: "doc",
        title: `飞书文档 ${documentId}`,
        content,
        url,
        updatedAt: Math.floor(Date.now() / 1000),
        keywords: keywords.filter((keyword) => content.toLowerCase().includes(keyword.toLowerCase()))
      });
    } catch (error) {
      console.warn(`Could not sync doc ${url}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return items;
}

async function syncMonitoredChatItems(client: LarkUserClient): Promise<KnowledgeItem[]> {
  const state = await loadState();
  const targets = Object.entries(state.targets ?? {})
    .filter(([key, target]) => key.startsWith("person:") && Boolean(target.chatId))
    .slice(0, maxChats);
  const items: KnowledgeItem[] = [];
  const endTime = Math.floor(Date.now() / 1000);
  const startTime = Math.max(0, endTime - syncDays * 86400);

  for (const [key, target] of targets) {
    if (!target.chatId) {
      continue;
    }
    try {
      const messages = await listMessages(client, target.chatId, startTime, endTime);
      for (const message of messages.slice(-maxMessagesPerChat)) {
        const text = extractMessageText(message.msg_type, message.content ?? message.body?.content);
        if (!text || isDelegatedAutoReplyText(text)) {
          continue;
        }
        const matchedKeywords = matchKeywords(text, keywords);
        if (!syncAllChatMessages && matchedKeywords.length === 0) {
          continue;
        }
        items.push({
          id: `message:${message.message_id ?? shortStableId(`${key}:${text}`)}`,
          source: "message",
          title: `${key.replace(/^person:/, "")} 的相关聊天`,
          content: text,
          createdAt: readMessageCreateTime(message),
          updatedAt: readMessageCreateTime(message),
          keywords: matchedKeywords
        });
      }
    } catch (error) {
      console.warn(`Could not sync chat ${key}: ${error instanceof Error ? error.message : String(error)}`);
      if (isRateLimitError(error)) {
        await delay(syncRateLimitBackoffMs);
      }
    }
    await delay(readPositiveInteger(process.env.LARK_KNOWLEDGE_SYNC_DELAY_MS, 120));
  }
  if (items.length > 0) {
    console.log(`Chat sync collected ${items.length} item(s) from ${targets.length} monitored chat(s).`);
  }
  return items;
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
    pageToken = response.data?.page_token;
  } while (pageToken && messages.length < maxMessagesPerChat);
  return messages;
}

async function syncMailItems(client: LarkUserClient): Promise<KnowledgeItem[]> {
  const mailboxes = await listMailboxes(client).catch((error) => {
    console.warn(`Could not list Feishu mailboxes: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  });
  const items: KnowledgeItem[] = [];
  const endTime = Math.floor(Date.now() / 1000);
  const startTime = Math.max(0, endTime - mailDays * 86400);

  for (const mailbox of mailboxes) {
    const mailboxId = mailbox.user_mailbox_id ?? mailbox.mailbox_id ?? mailbox.id;
    if (!mailboxId) {
      continue;
    }
    const messages = await listMailMessages(client, mailboxId, startTime, endTime).catch((error) => {
      console.warn(`Could not sync mailbox ${mailbox.email ?? mailbox.name ?? mailboxId}: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    });
    for (const message of messages.slice(-mailMaxMessages)) {
      const content = formatMailMessage(message).trim();
      if (!content) {
        continue;
      }
      const messageId = message.message_id ?? message.id ?? shortStableId(content);
      items.push({
        id: `mail:${mailboxId}:${messageId}`,
        source: "mail",
        title: `邮件：${message.subject?.trim() || "无主题"}`,
        content,
        createdAt: readFlexibleTime(message.received_at ?? message.sent_at ?? message.created_at),
        updatedAt: readFlexibleTime(message.updated_at ?? message.received_at ?? message.sent_at),
        keywords: matchKeywords(content, keywords)
      });
    }
    await delay(readPositiveInteger(process.env.LARK_KNOWLEDGE_SYNC_DELAY_MS, 120));
  }

  if (items.length > 0) {
    console.log(`Mail sync collected ${items.length} item(s).`);
  }
  return items;
}

async function listMailboxes(client: LarkUserClient): Promise<Mailbox[]> {
  const response = await client.request<ApiList<Mailbox>>({
    method: "GET",
    path: "/open-apis/mail/v1/user_mailboxes",
    query: { page_size: 50 }
  });
  return response.data?.items ?? [];
}

async function listMailMessages(client: LarkUserClient, mailboxId: string, startTime: number, endTime: number): Promise<MailMessage[]> {
  const messages: MailMessage[] = [];
  let pageToken: string | undefined;
  do {
    const response = await client.request<ApiList<MailMessage>>({
      method: "GET",
      path: `/open-apis/mail/v1/user_mailboxes/${encodeURIComponent(mailboxId)}/messages`,
      query: {
        page_size: 50,
        page_token: pageToken,
        start_time: startTime,
        end_time: endTime
      }
    });
    messages.push(...(response.data?.items ?? []));
    pageToken = response.data?.page_token;
  } while (pageToken && messages.length < mailMaxMessages);
  return messages;
}

function formatMailMessage(message: MailMessage): string {
  const body = readString(message.body_plain_text) ?? readString(message.snippet) ?? readString(message.summary) ?? readString(message.body_html) ?? stringifyMailField(message.body) ?? stringifyMailField(message.content);
  return [
    message.subject ? `主题：${message.subject}` : undefined,
    stringifyMailField(message.from) ? `发件人：${stringifyMailField(message.from)}` : undefined,
    stringifyMailField(message.to) ? `收件人：${stringifyMailField(message.to)}` : undefined,
    body
  ].filter(Boolean).join("\n");
}

function stringifyMailField(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  if (Array.isArray(value)) {
    return value.map(stringifyMailField).filter(Boolean).join(", ") || undefined;
  }
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  return readString(record.email) ?? readString(record.address) ?? readString(record.name) ?? readString(record.text) ?? readString(record.content) ?? JSON.stringify(record);
}

function readFlexibleTime(value: string | number | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const numberValue = Number(value);
  if (Number.isFinite(numberValue)) {
    return numberValue > 10_000_000_000 ? Math.floor(numberValue / 1000) : numberValue;
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : undefined;
}

function buildCloudSearchTerms(): string[] {
  return [...new Set([...keywords, ...readList(process.env.LARK_KNOWLEDGE_EXTRA_SEARCH_KEYS)])].filter(Boolean);
}

function isDelegatedAutoReplyText(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.endsWith("ᵃʳ") || /^AR:/i.test(trimmed) || /自动回复|请留言|我现在不在/.test(trimmed);
}

function isRateLimitError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("99991400") || message.includes("429") || /frequency limit|too many requests/i.test(message);
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

function parseDocxDocumentId(urlOrId: string): string | undefined {
  const trimmed = urlOrId.trim();
  if (/^dox[a-zA-Z0-9]{20,}$/.test(trimmed)) {
    return trimmed;
  }
  const match = trimmed.match(/\/(?:docx|docs)\/([A-Za-z0-9]+)/);
  return match?.[1];
}

function matchKeywords(text: string, keywordList: string[]): string[] {
  const normalized = text.toLowerCase();
  return keywordList.filter((keyword) => normalized.includes(keyword.toLowerCase()));
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readMessageCreateTime(message: Message): number | undefined {
  const raw = Number(message.create_time);
  if (!Number.isFinite(raw)) {
    return undefined;
  }
  return raw > 10_000_000_000 ? Math.floor(raw / 1000) : raw;
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
