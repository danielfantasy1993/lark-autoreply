import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export type KnowledgeItem = {
  id: string;
  source: "message" | "doc" | "sheet" | "mail" | "manual";
  title: string;
  content: string;
  url?: string;
  createdAt?: number;
  updatedAt?: number;
  keywords?: string[];
  parentId?: string;
  parentTitle?: string;
  chunkIndex?: number;
  chunkCount?: number;
  heading?: string;
};

export type KnowledgeIndex = {
  version: 1;
  generatedAt: string;
  items: KnowledgeItem[];
};

export type KnowledgeSearchInput = {
  incomingMessage: string;
  conversationText?: string;
  keywords?: string[];
  limit?: number;
};

export type KnowledgeSnippet = {
  title: string;
  content: string;
  source: KnowledgeItem["source"];
  url?: string;
  score: number;
};

export function getKnowledgeIndexFile(rootDir: string): string {
  return resolve(rootDir, process.env.LARK_KNOWLEDGE_INDEX_FILE || ".knowledge/index.json");
}

export async function loadKnowledgeIndex(indexFile: string): Promise<KnowledgeIndex> {
  try {
    return JSON.parse(await readFile(indexFile, "utf8")) as KnowledgeIndex;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return { version: 1, generatedAt: new Date(0).toISOString(), items: [] };
    }
    throw error;
  }
}

export async function saveKnowledgeIndex(indexFile: string, items: KnowledgeItem[]): Promise<void> {
  await mkdir(dirname(indexFile), { recursive: true });
  const uniqueItems = dedupeKnowledgeItems(expandKnowledgeChunks(items));
  const index: KnowledgeIndex = {
    version: 1,
    generatedAt: new Date().toISOString(),
    items: uniqueItems
  };
  await writeFile(indexFile, `${JSON.stringify(index, null, 2)}\n`, "utf8");
}

export function expandKnowledgeChunks(items: KnowledgeItem[]): KnowledgeItem[] {
  return items.flatMap((item) => (shouldChunkKnowledgeItem(item) ? chunkKnowledgeItem(item) : [item]));
}

export function searchKnowledge(index: KnowledgeIndex, input: KnowledgeSearchInput): KnowledgeSnippet[] {
  const limit = input.limit ?? readPositiveInteger(process.env.LARK_KNOWLEDGE_SEARCH_LIMIT, 6);
  const queryTerms = buildQueryTerms(input.incomingMessage, input.conversationText, input.keywords);
  if (queryTerms.length === 0 || index.items.length === 0) {
    return [];
  }

  return index.items
    .map((item) => ({ item, score: scoreKnowledgeItem(item, queryTerms) }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, limit)
    .map(({ item, score }) => ({
      title: item.title,
      content: truncateText(item.content, readPositiveInteger(process.env.LARK_KNOWLEDGE_SNIPPET_CHARS, 420)),
      source: item.source,
      url: item.url,
      score
    }));
}

export function readKnowledgeKeywords(): string[] {
  return readList(process.env.LARK_KNOWLEDGE_KEYWORDS || "DK057,DK075");
}

export function readList(value: string | undefined): string[] {
  return (value ?? "")
    .split(/[,，|\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function shortStableId(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function dedupeKnowledgeItems(items: KnowledgeItem[]): KnowledgeItem[] {
  const seen = new Set<string>();
  const deduped: KnowledgeItem[] = [];
  for (const item of items) {
    const key = item.id || `${item.source}:${item.title}:${item.content}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(item);
  }
  return deduped;
}

function shouldChunkKnowledgeItem(item: KnowledgeItem): boolean {
  if (item.source !== "doc" || item.parentId) {
    return false;
  }
  return item.content.length > readPositiveInteger(process.env.LARK_KNOWLEDGE_CHUNK_CHARS, 1800);
}

function chunkKnowledgeItem(item: KnowledgeItem): KnowledgeItem[] {
  const maxChars = readPositiveInteger(process.env.LARK_KNOWLEDGE_CHUNK_CHARS, 1800);
  const overlapChars = Math.min(readPositiveInteger(process.env.LARK_KNOWLEDGE_CHUNK_OVERLAP_CHARS, 180), Math.floor(maxChars / 3));
  const sections = splitMarkdownSections(item.content);
  const chunks: Array<{ heading?: string; content: string }> = [];

  let currentHeading: string | undefined;
  let currentParts: string[] = [];
  let currentLength = 0;

  for (const section of sections) {
    if (section.content.length > maxChars) {
      flushCurrentChunk();
      chunks.push(...splitOversizedText(section.content, maxChars, overlapChars).map((content, index) => ({
        heading: section.heading ? `${section.heading} / Part ${index + 1}` : undefined,
        content
      })));
      continue;
    }

    if (currentLength > 0 && currentLength + section.content.length > maxChars) {
      flushCurrentChunk();
    }
    currentHeading ??= section.heading;
    currentParts.push(section.content);
    currentLength += section.content.length;
  }
  flushCurrentChunk();

  const chunkCount = chunks.length;
  return chunks.map((chunk, index) => ({
    ...item,
    id: `${item.id}:chunk:${index + 1}`,
    title: chunk.heading ? `${item.title} / ${chunk.heading}` : `${item.title} / Chunk ${index + 1}`,
    content: chunk.content,
    parentId: item.id,
    parentTitle: item.title,
    chunkIndex: index + 1,
    chunkCount,
    heading: chunk.heading
  }));

  function flushCurrentChunk(): void {
    const content = currentParts.join("\n\n").trim();
    if (content) {
      chunks.push({ heading: currentHeading, content });
    }
    currentHeading = undefined;
    currentParts = [];
    currentLength = 0;
  }
}

function splitMarkdownSections(markdown: string): Array<{ heading?: string; content: string }> {
  const lines = markdown.split(/\r?\n/);
  const sections: Array<{ heading?: string; content: string }> = [];
  let currentHeading: string | undefined;
  let currentLines: string[] = [];

  for (const line of lines) {
    const heading = parseMarkdownHeading(line);
    if (heading && currentLines.length > 0) {
      sections.push({ heading: currentHeading, content: currentLines.join("\n").trim() });
      currentLines = [];
    }
    if (heading) {
      currentHeading = heading;
    }
    currentLines.push(line);
  }

  const content = currentLines.join("\n").trim();
  if (content) {
    sections.push({ heading: currentHeading, content });
  }
  return sections;
}

function splitOversizedText(text: string, maxChars: number, overlapChars: number): string[] {
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(text.length, start + maxChars);
    chunks.push(text.slice(start, end).trim());
    if (end === text.length) {
      break;
    }
    start = Math.max(0, end - overlapChars);
  }
  return chunks.filter(Boolean);
}

function parseMarkdownHeading(line: string): string | undefined {
  const match = line.match(/^#{1,6}\s+(.+)$/);
  return match?.[1]?.replace(/\\([_\-.*#[\]()])/g, "$1").trim();
}

function buildQueryTerms(incomingMessage: string, conversationText: string | undefined, keywords: string[] | undefined): string[] {
  const terms = new Set<string>();
  const text = `${incomingMessage}\n${conversationText ?? ""}`;
  const normalizedText = text.toLowerCase();
  for (const keyword of keywords ?? []) {
    const normalizedKeyword = keyword.trim().toLowerCase();
    if (normalizedKeyword && normalizedText.includes(normalizedKeyword)) {
      terms.add(normalizedKeyword);
    }
  }

  const explicitCodes = text.match(/[A-Za-z]{2,}\d{2,}/g) ?? [];
  for (const code of explicitCodes) {
    terms.add(code.toLowerCase());
  }

  for (const token of text.split(/[^\p{L}\p{N}_-]+/u)) {
    const normalized = token.trim().toLowerCase();
    if (normalized.length >= 2 && normalized.length <= 40) {
      terms.add(normalized);
    }
  }
  return [...terms].slice(0, 40);
}

function scoreKnowledgeItem(item: KnowledgeItem, queryTerms: string[]): number {
  const title = item.title.toLowerCase();
  const content = item.content.toLowerCase();
  const keywords = (item.keywords ?? []).map((keyword) => keyword.toLowerCase());
  let score = 0;
  for (const term of queryTerms) {
    if (keywords.includes(term)) {
      score += 8;
    }
    if (title.includes(term)) {
      score += 5;
    }
    if (content.includes(term)) {
      score += 2;
    }
  }

  if (item.updatedAt) {
    const ageDays = Math.max(0, (Date.now() / 1000 - item.updatedAt) / 86400);
    score += Math.max(0, 2 - ageDays / 14);
  }
  return score;
}

function truncateText(text: string, maxChars: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length <= maxChars ? normalized : `${normalized.slice(0, maxChars)}...`;
}

function readPositiveInteger(value: string | undefined, fallback: number): number {
  const numberValue = Number(value);
  return Number.isInteger(numberValue) && numberValue > 0 ? numberValue : fallback;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
