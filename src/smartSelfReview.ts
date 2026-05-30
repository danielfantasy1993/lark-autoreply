#!/usr/bin/env node
import { config as loadDotEnv } from "dotenv";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createSmartReplyGenerator, type SmartReplyConversationMessage, type SmartReplyKnowledgeSnippet } from "./smartReply.js";

type ReviewCase = {
  id: string;
  targetName: string;
  incomingMessage: string;
  conversation?: SmartReplyConversationMessage[];
  knowledge?: SmartReplyKnowledgeSnippet[];
  idealReply?: string;
  notes?: string;
};

type ReviewResult = ReviewCase & {
  generatedReply: string;
  score: number;
  pass: boolean;
  warnings: string[];
  labels: string[];
  diagnosis: string;
  betterReply?: string;
  similarityToIdeal?: number;
};

type ReviewReport = {
  generatedAt: string;
  sourceFile: string;
  summary: {
    total: number;
    passed: number;
    failed: number;
    averageScore: number;
    averageSimilarityToIdeal?: number;
    frequentWarnings: Array<{ label: string; count: number }>;
  };
  results: ReviewResult[];
  recommendations: string[];
};

type ChatCompletionResponse = {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
};

type JudgePayload = {
  score?: number;
  labels?: string[];
  diagnosis?: string;
  betterReply?: string;
};

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
loadDotEnv({ path: resolve(rootDir, ".env") });

const learnedCasesFile = resolvePath(process.env.LARK_STYLE_LEARN_CASES_FILE || ".training/learned-reply-cases.json");
const evalCasesFile = resolvePath(process.env.LARK_SMART_REPLY_EVAL_FILE || ".training/smart-reply-cases.json");
const outputJsonFile = resolvePath(process.env.LARK_SELF_REVIEW_OUTPUT || ".training/smart-reply-self-review.json");
const outputMarkdownFile = resolvePath(process.env.LARK_SELF_REVIEW_MARKDOWN || ".training/smart-reply-self-review.md");
const maxCases = readPositiveInteger(process.env.LARK_SELF_REVIEW_MAX_CASES, 30);
const passScore = readNumber(process.env.LARK_SELF_REVIEW_PASS_SCORE, 7);
const useAiJudge = process.env.LARK_SELF_REVIEW_AI_JUDGE !== "false";
const failBelow = readOptionalNumber(process.env.LARK_SELF_REVIEW_FAIL_BELOW);

async function main(): Promise<void> {
  const { cases, sourceFile } = await loadCases();
  const selectedCases = cases.slice(0, maxCases);
  if (!selectedCases.length) {
    throw new Error(`No review cases found in ${sourceFile}. Run npm.cmd run smart:learn first or add .training/smart-reply-cases.json.`);
  }

  const smartReply = createSmartReplyGenerator();
  const results: ReviewResult[] = [];

  for (const reviewCase of selectedCases) {
    const generatedReply = await smartReply({
      targetName: reviewCase.targetName,
      incomingMessage: reviewCase.incomingMessage,
      conversation: reviewCase.conversation ?? [],
      knowledge: reviewCase.knowledge ?? []
    });
    const warnings = analyzeReply(generatedReply, reviewCase);
    const judge = useAiJudge ? await judgeReply(reviewCase, generatedReply, warnings).catch((error) => fallbackJudge(warnings, error)) : fallbackJudge(warnings);
    const score = clampScore(judge.score ?? fallbackScore(warnings, reviewCase, generatedReply));
    const result: ReviewResult = {
      ...reviewCase,
      generatedReply,
      score,
      pass: score >= passScore && warnings.length === 0,
      warnings,
      labels: normalizeLabels(judge.labels ?? warnings),
      diagnosis: judge.diagnosis || (warnings.length ? warnings.join("; ") : "通过基础检查。"),
      betterReply: judge.betterReply,
      similarityToIdeal: reviewCase.idealReply ? scoreSimilarity(generatedReply, reviewCase.idealReply) : undefined
    };
    results.push(result);
    printResult(result);
  }

  const report = buildReport(sourceFile, results);
  await mkdir(dirname(outputJsonFile), { recursive: true });
  await writeFile(outputJsonFile, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(outputMarkdownFile, `${formatMarkdown(report)}\n`, "utf8");

  console.log(`\nSaved self-review JSON to ${outputJsonFile}`);
  console.log(`Saved self-review report to ${outputMarkdownFile}`);

  if (failBelow !== undefined && report.summary.averageScore < failBelow) {
    throw new Error(`Average self-review score ${report.summary.averageScore} is below LARK_SELF_REVIEW_FAIL_BELOW=${failBelow}.`);
  }
}

async function loadCases(): Promise<{ cases: ReviewCase[]; sourceFile: string }> {
  const learned = await readCasesFile(learnedCasesFile).catch(() => []);
  if (learned.length) {
    return { cases: learned, sourceFile: learnedCasesFile };
  }
  const evalCases = await readCasesFile(evalCasesFile).catch(() => []);
  if (evalCases.length) {
    return { cases: evalCases, sourceFile: evalCasesFile };
  }
  return { cases: [], sourceFile: `${learnedCasesFile} or ${evalCasesFile}` };
}

async function readCasesFile(filePath: string): Promise<ReviewCase[]> {
  const payload = JSON.parse(await readFile(filePath, "utf8")) as { cases?: ReviewCase[] } | ReviewCase[];
  const cases = Array.isArray(payload) ? payload : payload.cases;
  return (cases ?? []).filter((item) => item.id && item.targetName && item.incomingMessage);
}

async function judgeReply(reviewCase: ReviewCase, generatedReply: string, warnings: string[]): Promise<JudgePayload> {
  const apiUrl = process.env.LARK_SELF_REVIEW_API_URL || process.env.LARK_SMART_REPLY_API_URL || "https://api.openai.com/v1/chat/completions";
  const apiKey = readSmartReplyApiKey(apiUrl);
  if (!apiKey) {
    throw new Error("Missing API key for self review judge.");
  }
  const model = process.env.LARK_SELF_REVIEW_MODEL || process.env.LARK_SMART_REPLY_MODEL || process.env.OPENAI_MODEL || "gpt-4o-mini";
  const body = buildChatCompletionBody(apiUrl, model, [
    {
      role: "system",
      content: [
        "你是飞书自动回复质量评审员。你要严厉但务实地评价候选回复是否像用户本人。",
        "评分 0-10 分，10 分表示可以直接发送；低于 7 分表示需要改。",
        "重点检查：是否有人味、是否符合上下文、是否过度客服腔、是否暴露 AI/机器人、是否承诺查资料但没有真实工具结果、是否把自动回复当真人风格。",
        "只输出 JSON：{\"score\":number,\"labels\":[string],\"diagnosis\":string,\"betterReply\":string}。betterReply 要是可直接发送的一句话或用 | 分隔的短消息。"
      ].join("\n")
    },
    {
      role: "user",
      content: JSON.stringify(
        {
          targetName: reviewCase.targetName,
          incomingMessage: reviewCase.incomingMessage,
          conversation: reviewCase.conversation ?? [],
          knowledge: reviewCase.knowledge ?? [],
          idealReply: reviewCase.idealReply,
          notes: reviewCase.notes,
          generatedReply,
          ruleWarnings: warnings
        },
        null,
        2
      )
    }
  ], 0.1, 360);

  const response = await fetch(apiUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(`Self review API ${response.status} ${response.statusText}: ${responseText}`);
  }
  const payload = parseJson(responseText) as ChatCompletionResponse;
  const content = payload.choices?.[0]?.message?.content?.trim();
  if (!content) {
    throw new Error(`Self review API returned an empty response: ${responseText}`);
  }
  return parseJson(extractJson(content)) as JudgePayload;
}

function analyzeReply(reply: string, reviewCase: ReviewCase): string[] {
  const warnings: string[] = [];
  if (/(机器人|自动回复|AI|模型)/i.test(reply)) {
    warnings.push("mentions automation identity");
  }
  if (/(我查一下|我查下|我翻一下|我翻下|稍等|一会回你|晚点回你|确认后回你)/.test(reply)) {
    warnings.push("promises unsupported follow-up");
  }
  if (reply.length > 160) {
    warnings.push("too long for casual chat");
  }
  if (/^(收到|好的|了解|明白)[，,。]/.test(reply)) {
    warnings.push("generic opening");
  }
  if (reply.trim().startsWith(process.env.LARK_AUTOREPLY_PREFIX ?? "AR:")) {
    warnings.push("contains auto-reply prefix");
  }
  if (reviewCase.idealReply && scoreSimilarity(reply, reviewCase.idealReply) < 0.08) {
    warnings.push("low similarity to human reply");
  }
  return warnings;
}

function buildReport(sourceFile: string, results: ReviewResult[]): ReviewReport {
  const averageScore = round(results.reduce((sum, item) => sum + item.score, 0) / results.length);
  const similarities = results.map((item) => item.similarityToIdeal).filter((item): item is number => item !== undefined);
  const frequentWarnings = topLabels(results.flatMap((item) => [...item.warnings, ...item.labels]), 10).map(([label, count]) => ({ label, count }));
  return {
    generatedAt: new Date().toISOString(),
    sourceFile,
    summary: {
      total: results.length,
      passed: results.filter((item) => item.pass).length,
      failed: results.filter((item) => !item.pass).length,
      averageScore,
      averageSimilarityToIdeal: similarities.length ? round(similarities.reduce((sum, item) => sum + item, 0) / similarities.length) : undefined,
      frequentWarnings
    },
    results,
    recommendations: buildRecommendations(results)
  };
}

function buildRecommendations(results: ReviewResult[]): string[] {
  const labels = new Set(results.flatMap((item) => [...item.warnings, ...item.labels]));
  const recommendations: string[] = [];
  if (labels.has("mentions automation identity")) {
    recommendations.push("继续禁止回复里出现 AI、机器人、自动回复等身份暴露词。");
  }
  if (labels.has("promises unsupported follow-up")) {
    recommendations.push("把没有真实工具支撑的“我查下/稍等回你”改成直接说明当前无法确认，或要求对方补关键上下文。");
  }
  if (labels.has("generic opening")) {
    recommendations.push("减少“收到/好的/了解”这类固定开头，让回复更像临场输入。");
  }
  if (labels.has("low similarity to human reply")) {
    recommendations.push("补充更多真人理想回复样本，尤其是项目编号、天气、表情误判和短确认场景。");
  }
  if (recommendations.length === 0) {
    recommendations.push("当前样本没有暴露明显硬伤；继续扩大样本量，观察低分案例。") ;
  }
  return recommendations;
}

function formatMarkdown(report: ReviewReport): string {
  const failed = report.results.filter((item) => !item.pass).slice(0, 12);
  return [
    "# 智能回复自评报告",
    "",
    `- 生成时间：${report.generatedAt}`,
    `- 样本来源：${report.sourceFile}`,
    `- 样本数：${report.summary.total}`,
    `- 通过：${report.summary.passed}`,
    `- 未通过：${report.summary.failed}`,
    `- 平均分：${report.summary.averageScore}/10`,
    report.summary.averageSimilarityToIdeal !== undefined ? `- 真人回复相似度：${report.summary.averageSimilarityToIdeal}` : undefined,
    "",
    "## 高频问题",
    report.summary.frequentWarnings.length ? report.summary.frequentWarnings.map((item) => `- ${item.label}：${item.count}`).join("\n") : "- 暂无",
    "",
    "## 建议",
    report.recommendations.map((item) => `- ${item}`).join("\n"),
    "",
    "## 低分案例",
    failed.length
      ? failed
          .map((item) => [
            `### ${item.id}（${item.score}/10）`,
            `- 对方：${item.incomingMessage}`,
            `- 生成：${item.generatedReply}`,
            item.idealReply ? `- 真人样例：${item.idealReply}` : undefined,
            `- 诊断：${item.diagnosis}`,
            item.betterReply ? `- 建议回复：${item.betterReply}` : undefined
          ].filter(Boolean).join("\n"))
          .join("\n\n")
      : "暂无"
  ]
    .filter((item): item is string => item !== undefined)
    .join("\n");
}

function fallbackJudge(warnings: string[], error?: unknown): JudgePayload {
  return {
    score: Math.max(0, 8 - warnings.length * 1.5),
    labels: warnings,
    diagnosis: error instanceof Error ? `AI 评审不可用，使用规则评审：${error.message}` : warnings.length ? warnings.join("; ") : "通过基础规则评审。"
  };
}

function fallbackScore(warnings: string[], reviewCase: ReviewCase, generatedReply: string): number {
  const similarityPenalty = reviewCase.idealReply && scoreSimilarity(generatedReply, reviewCase.idealReply) < 0.08 ? 1 : 0;
  return Math.max(0, 8 - warnings.length * 1.5 - similarityPenalty);
}

function scoreSimilarity(actual: string, ideal: string): number {
  const actualTokens = tokenize(actual);
  const idealTokens = tokenize(ideal);
  if (actualTokens.size === 0 || idealTokens.size === 0) {
    return 0;
  }
  const overlap = [...actualTokens].filter((token) => idealTokens.has(token)).length;
  return round(overlap / Math.max(actualTokens.size, idealTokens.size));
}

function tokenize(value: string): Set<string> {
  return new Set(value.toLowerCase().replace(/[\s，。！？、,.!?|]/g, "").split(""));
}

function readSmartReplyApiKey(apiUrl: string): string | undefined {
  const configuredKey = process.env.LARK_SELF_REVIEW_API_KEY || process.env.LARK_SMART_REPLY_API_KEY || process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY;
  if (configuredKey) {
    return configuredKey;
  }
  if (!apiUrl.includes("api.deepseek.com")) {
    return process.env.GITHUB_TOKEN;
  }
  return undefined;
}

function buildChatCompletionBody(apiUrl: string, model: string, messages: Array<{ role: "system" | "user"; content: string }>, temperature: number, maxTokens: number): Record<string, unknown> {
  const body: Record<string, unknown> = { model, messages, temperature, max_tokens: maxTokens };
  if (apiUrl.includes("api.deepseek.com")) {
    body.thinking = { type: "disabled" };
  }
  return body;
}

function normalizeLabels(labels: string[]): string[] {
  return [...new Set(labels.map((item) => item.trim()).filter(Boolean))];
}

function topLabels(values: string[], limit: number): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const value of values.map((item) => item.trim()).filter(Boolean)) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()].sort((left, right) => right[1] - left[1]).slice(0, limit);
}

function printResult(result: ReviewResult): void {
  console.log(`\n[${result.pass ? "PASS" : "FAIL"}] ${result.id} ${result.score}/10`);
  console.log(`Incoming: ${result.incomingMessage}`);
  console.log(`Generated: ${result.generatedReply}`);
  if (result.diagnosis) {
    console.log(`Review: ${result.diagnosis}`);
  }
}

function extractJson(value: string): string {
  const fenced = value.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) {
    return fenced[1];
  }
  const start = value.indexOf("{");
  const end = value.lastIndexOf("}");
  return start >= 0 && end > start ? value.slice(start, end + 1) : value;
}

function parseJson(text: string): unknown {
  if (!text) {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function clampScore(value: number): number {
  return round(Math.min(10, Math.max(0, value)));
}

function round(value: number): number {
  return Number(value.toFixed(2));
}

function readNumber(value: string | undefined, fallback: number): number {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : fallback;
}

function readOptionalNumber(value: string | undefined): number | undefined {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : undefined;
}

function readPositiveInteger(value: string | undefined, fallback: number): number {
  const numberValue = Number(value);
  return Number.isInteger(numberValue) && numberValue > 0 ? numberValue : fallback;
}

function resolvePath(value: string): string {
  return resolve(rootDir, value);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});