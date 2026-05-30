import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export type SmartReplyConversationMessage = {
  speaker: "me" | "target" | "other";
  text: string;
  createdAt?: number;
};

export type SmartReplyInput = {
  targetName: string;
  incomingMessage: string;
  conversation: SmartReplyConversationMessage[];
  knowledge?: SmartReplyKnowledgeSnippet[];
};

export type SmartReplyKnowledgeSnippet = {
  title: string;
  content: string;
  source: "message" | "doc" | "sheet" | "manual";
  url?: string;
};

type ChatCompletionResponse = {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
};

type ChatCompletionRequestMessage = {
  role: "system" | "user";
  content: string;
};

export type SmartReplyGenerator = (input: SmartReplyInput) => Promise<string>;

const defaultStyleGuide = [
  "用中文自然回复，像本人在飞书里顺手回消息，不要像客服、公告、秘书或机器人。",
  "先理解对方真正想表达什么，再给出具体回应；能直接答就直接答，不要绕。",
  "保持简洁、口语化、有上下文，可以有一点人的迟疑和边界感，但不要敷衍。",
  "不要每次都用收到、好的、我看下开头；除非对方只是确认或信息不足。",
  "不要机械复述对方问题，不要写总结腔，不要用首先/其次/感谢你的反馈。",
  "对需要查日历、邮件、飞书云文档、表格、天气或其他外部实时信息的问题，不要编造，也不要承诺稍后查询或稍后回复。",
  "如果缺少实时信息或无法实际查询，直接说明当前没法确认，必要时问一句关键信息或给一个现实建议。",
  "不要输出我在出差、请留言、稍后再聊、机器人等托管回复口吻。",
  "不要暴露自己是 AI、模型、机器人或自动回复。",
  "不要说我去查一下、我确认后回你、稍等、稍后给你答复，除非上下文里已经明确有后续结果。",
  "可以用 | 分隔 1 到 3 条短消息，模拟真人连续发几句；不要超过 3 条。",
  "只输出要发送给对方的消息正文，不要解释你的推理。"
].join("\n");

export function createSmartReplyGenerator(): SmartReplyGenerator {
  const apiUrl = process.env.LARK_SMART_REPLY_API_URL || "https://api.openai.com/v1/chat/completions";
  const apiKey = readSmartReplyApiKey(apiUrl);
  const model = process.env.LARK_SMART_REPLY_MODEL || process.env.OPENAI_MODEL || "gpt-4o-mini";
  const temperature = readNumber(process.env.LARK_SMART_REPLY_TEMPERATURE, 0.6);
  const maxTokens = readInteger(process.env.LARK_SMART_REPLY_MAX_TOKENS, 180);
  const styleGuide = process.env.LARK_SMART_REPLY_STYLE || defaultStyleGuide;
  const extraContext = process.env.LARK_SMART_REPLY_EXTRA_CONTEXT;
  const learnedStyleFile = process.env.LARK_SMART_REPLY_LEARNED_STYLE_FILE || ".training/style-profile.md";

  if (!apiKey) {
    throw new Error("Missing LARK_SMART_REPLY_API_KEY, OPENAI_API_KEY, or GITHUB_TOKEN. Smart auto-reply needs an OpenAI-compatible chat completions API key.");
  }

  return async (input: SmartReplyInput): Promise<string> => {
    const learnedStyle = await readOptionalTextFile(learnedStyleFile);
    const messages: ChatCompletionRequestMessage[] = [
      {
        role: "system",
        content: buildSystemPrompt(styleGuide, extraContext, learnedStyle)
      },
      {
        role: "user",
        content: buildUserPrompt(input)
      }
    ];

    const response = await fetch(apiUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(buildChatCompletionBody(apiUrl, model, messages, temperature, maxTokens))
    });

    const responseText = await response.text();
    if (!response.ok) {
      throw new Error(`Smart reply API ${response.status} ${response.statusText}: ${responseText}`);
    }

    const payload = parseJson(responseText) as ChatCompletionResponse;
    const reply = payload.choices?.[0]?.message?.content?.trim();
    if (!reply) {
      throw new Error(`Smart reply API returned an empty response: ${responseText}`);
    }

    return sanitizeSmartReply(stripWrappingQuotes(reply), input);
  };
}

function readSmartReplyApiKey(apiUrl: string): string | undefined {
  const configuredKey = process.env.LARK_SMART_REPLY_API_KEY || process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY;
  if (configuredKey) {
    return configuredKey;
  }

  if (!apiUrl.includes("api.deepseek.com")) {
    return process.env.GITHUB_TOKEN;
  }
  return undefined;
}

function buildChatCompletionBody(apiUrl: string, model: string, messages: ChatCompletionRequestMessage[], temperature: number, maxTokens: number): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model,
    messages,
    temperature,
    max_tokens: maxTokens
  };

  if (apiUrl.includes("api.deepseek.com")) {
    body.thinking = { type: "disabled" };
  }

  return body;
}

export function extractMessageText(messageType: string | undefined, rawContent: string | undefined): string {
  const content = parseJson(rawContent ?? "") as Record<string, unknown>;
  if (typeof content.text === "string" && content.text.trim()) {
    return content.text.trim();
  }
  if (typeof content.title === "string" && content.title.trim()) {
    return content.title.trim();
  }
  if (typeof content.content === "string" && content.content.trim()) {
    return content.content.trim();
  }
  if (typeof content.file_name === "string" && content.file_name.trim()) {
    return content.file_name.trim();
  }
  if (typeof content.name === "string" && content.name.trim()) {
    return content.name.trim();
  }
  if (typeof rawContent === "string" && rawContent.trim()) {
    return rawContent.trim();
  }
  return `[收到一条${messageType || "非文本"}消息]`;
}

async function readOptionalTextFile(filePath: string): Promise<string | undefined> {
  try {
    const text = await readFile(resolve(process.cwd(), filePath), "utf8");
    return text.trim() || undefined;
  } catch {
    return undefined;
  }
}

function buildSystemPrompt(styleGuide: string, extraContext: string | undefined, learnedStyle: string | undefined): string {
  return [
    "你正在代替用户回复飞书私聊。回复要像用户本人发出的消息。",
    "你只能使用调用方实际提供给你的信息：最近飞书聊天上下文、最新消息、相关飞书知识和补充背景。",
    "如果相关飞书知识或补充背景里有项目、客户、编号、任务、当前工作重点，要优先当作用户已知背景来理解对方消息。",
    "不要声称自己已经查看了日历、邮件、飞书云文档、表格、系统记录或其他外部资料，除非这些内容已经明确出现在上下文里。",
    "如果回复需要依赖外部资料或实时状态，但上下文没有给出答案，直接承认当前没法确认，或者向对方要一个必要信息；不要承诺稍后查看或确认后再回。",
    "特别是天气、实时价格、实时进度、日程空闲等问题：如果上下文没有结果，不要说正在查询、马上查、稍等一下。",
    "聊天上下文里如果出现过自动回复、我在出差、请留言、稍后再聊等固定托管文案，不要模仿、不要复用。",
    "对方只发 1、收到、好、ok、嗯这类短确认时，用一句自然短回复接住，例如“行，我看下”或“好，我确认下”。",
    "回复长度默认 1 到 2 句。只有对方明确问复杂问题时才多说。可以用 | 分隔最多 3 条短消息，表示连续发送。",
    "风格要求：",
    styleGuide,
    learnedStyle ? `从用户历史真实回复中学习到的风格画像：\n${learnedStyle}` : undefined,
    extraContext ? `补充背景：\n${extraContext}` : undefined
  ]
    .filter(Boolean)
    .join("\n\n");
}

function buildUserPrompt(input: SmartReplyInput): string {
  const history = input.conversation
    .map((message) => `${speakerLabel(message.speaker, input.targetName)}：${message.text}`)
    .join("\n");
  const knowledge = formatKnowledge(input.knowledge ?? []);

  return [
    `对方：${input.targetName}`,
    "最近上下文：",
    history || "（没有更多上下文）",
    "相关飞书知识：",
    knowledge || "（没有检索到相关知识）",
    "需要回复的最新消息：",
    `${input.targetName}：${input.incomingMessage}`,
    "请直接给出可以发送的回复。可以是一条消息，也可以用 | 分隔最多 3 条短消息。不要解释、不要加引号、不要写成模板。"
  ].join("\n\n");
}

function speakerLabel(speaker: SmartReplyConversationMessage["speaker"], targetName: string): string {
  if (speaker === "me") {
    return "我";
  }
  if (speaker === "target") {
    return targetName;
  }
  return "其他人";
}

function stripWrappingQuotes(value: string): string {
  return value.replace(/^[“”"'\s]+|[“”"'\s]+$/g, "").trim();
}

function sanitizeSmartReply(reply: string, input: SmartReplyInput): string {
  if (isRealtimeInfoQuestion(input.incomingMessage) && hasUnsupportedFollowUpPromise(reply)) {
    if (/(天气|下雨|降雨|气温|温度|台风|暴雨|空气质量|aqi)/i.test(input.incomingMessage)) {
      return "我这边没法直接看实时天气|你说下哪个城市，我按你发的情况帮你判断下";
    }
    return "这个我现在没法直接确认|你把具体信息发我，我按现有信息帮你判断下";
  }

  if (hasUnsupportedFollowUpPromise(reply)) {
    return reply
      .replace(/我(去|来)?(查|翻|看|确认|核|问)(一下|下|一眼|一遍)?(天气|资料|文档|表格|状态|进度|日程)?[，,。.!！\s]*(稍等|等我下|一会儿?回你|晚点回你|确认后回你)?/g, "这个我现在没法直接确认")
      .replace(/(稍等|等我下|一会儿?回你|晚点回你|确认后回你)/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  return reply;
}

function isRealtimeInfoQuestion(text: string): boolean {
  return /(天气|下雨|降雨|气温|温度|台风|暴雨|空气质量|aqi|现在|实时|今天|明天|日程|排期|进度|状态|价格|库存)/i.test(text);
}

function hasUnsupportedFollowUpPromise(text: string): boolean {
  return /(查一下|查下|翻一下|翻下|看一下|看下|确认一下|确认下|核一下|核下|问一下|问下|稍等|等我下|一会儿?回你|晚点回你|确认后回你)/i.test(text);
}

function readNumber(value: string | undefined, fallback: number): number {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : fallback;
}

function readInteger(value: string | undefined, fallback: number): number {
  const numberValue = Number(value);
  return Number.isInteger(numberValue) && numberValue > 0 ? numberValue : fallback;
}

function parseJson(text: string): unknown {
  if (!text) {
    return {};
  }

  try {
    return JSON.parse(text);
  } catch {
    return { content: text };
  }
}

function formatKnowledge(items: SmartReplyKnowledgeSnippet[]): string {
  return items
    .map((item, index) => {
      const sourceLabel = item.source === "doc" ? "文档" : item.source === "sheet" ? "表格" : item.source === "message" ? "聊天" : "手动背景";
      return `${index + 1}. [${sourceLabel}] ${item.title}\n${item.content}`;
    })
    .join("\n\n");
}