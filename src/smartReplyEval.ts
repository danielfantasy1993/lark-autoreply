#!/usr/bin/env node
import { config as loadDotEnv } from "dotenv";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createSmartReplyGenerator, type SmartReplyConversationMessage, type SmartReplyKnowledgeSnippet } from "./smartReply.js";

type EvalCase = {
  id: string;
  targetName: string;
  incomingMessage: string;
  conversation?: SmartReplyConversationMessage[];
  knowledge?: SmartReplyKnowledgeSnippet[];
  idealReply?: string;
  notes?: string;
};

type EvalResult = EvalCase & {
  generatedReply: string;
  warnings: string[];
  similarityToIdeal?: number;
};

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
loadDotEnv({ path: resolve(rootDir, ".env") });

const evalFile = resolvePath(process.env.LARK_SMART_REPLY_EVAL_FILE || ".training/smart-reply-cases.json");
const outputFile = resolvePath(process.env.LARK_SMART_REPLY_EVAL_OUTPUT || ".training/smart-reply-eval-results.json");

async function main(): Promise<void> {
  const cases = await loadCases();
  const smartReply = createSmartReplyGenerator();
  const results: EvalResult[] = [];

  for (const evalCase of cases) {
    const generatedReply = await smartReply({
      targetName: evalCase.targetName,
      incomingMessage: evalCase.incomingMessage,
      conversation: evalCase.conversation ?? [],
      knowledge: evalCase.knowledge ?? []
    });
    const result: EvalResult = {
      ...evalCase,
      generatedReply,
      warnings: analyzeReply(generatedReply),
      similarityToIdeal: evalCase.idealReply ? scoreSimilarity(generatedReply, evalCase.idealReply) : undefined
    };
    results.push(result);
    printResult(result);
  }

  await mkdir(dirname(outputFile), { recursive: true });
  await writeFile(outputFile, `${JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2)}\n`, "utf8");
  console.log(`\nSaved eval results to ${outputFile}`);
}

async function loadCases(): Promise<EvalCase[]> {
  try {
    const payload = JSON.parse(await readFile(evalFile, "utf8")) as { cases?: EvalCase[] } | EvalCase[];
    const cases = Array.isArray(payload) ? payload : payload.cases;
    if (!cases?.length) {
      throw new Error("No cases found.");
    }
    return cases;
  } catch (error) {
    await mkdir(dirname(evalFile), { recursive: true });
    const example = {
      cases: [
        {
          id: "lee-weather-reaction",
          targetName: "Lee",
          incomingMessage: "看不懂表情？",
          conversation: [
            { speaker: "target", text: "🙂✅🔥" },
            { speaker: "me", text: "行，松江天气我这边没法直接看，你拿天气 App 扫一眼吧。" }
          ],
          idealReply: "哈哈我刚没反应过来，你发的是表情，不是在说天气。",
          notes: "不要把表情误判成天气任务。"
        }
      ]
    };
    await writeFile(evalFile, `${JSON.stringify(example, null, 2)}\n`, "utf8");
    throw new Error(`Created example eval file at ${evalFile}. Edit it with your real cases, then run npm.cmd run smart:evaluate again. Original error: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function analyzeReply(reply: string): string[] {
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
  return warnings;
}

function scoreSimilarity(actual: string, ideal: string): number {
  const actualTokens = tokenize(actual);
  const idealTokens = tokenize(ideal);
  if (actualTokens.size === 0 || idealTokens.size === 0) {
    return 0;
  }
  const overlap = [...actualTokens].filter((token) => idealTokens.has(token)).length;
  return Number((overlap / Math.max(actualTokens.size, idealTokens.size)).toFixed(3));
}

function tokenize(value: string): Set<string> {
  return new Set(value.toLowerCase().replace(/[\s，。！？、,.!?|]/g, "").split(""));
}

function printResult(result: EvalResult): void {
  console.log(`\n[${result.id}] ${result.targetName}`);
  console.log(`Incoming: ${result.incomingMessage}`);
  console.log(`Generated: ${result.generatedReply}`);
  if (result.idealReply) {
    console.log(`Ideal: ${result.idealReply}`);
    console.log(`Similarity: ${result.similarityToIdeal}`);
  }
  if (result.warnings.length > 0) {
    console.log(`Warnings: ${result.warnings.join(", ")}`);
  }
}

function resolvePath(value: string): string {
  return resolve(rootDir, value);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});