import { config } from "../config.js";
import { chatCompletion } from "./ai.js";
import type { SearchResult } from "./search.js";

function clampScore(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : null;
}

function parseLlmScores(text: string, expected: number): number[] | null {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as unknown;
    if (!Array.isArray(parsed)) return null;
    const scores = new Array<number>(expected).fill(0);
    let seen = false;
    for (const item of parsed) {
      if (typeof item !== "object" || item === null) continue;
      const record = item as Record<string, unknown>;
      const index = Number(record.index ?? record.i ?? record.id);
      const raw = clampScore(Number(record.score ?? record.relevance) / 10);
      if (!Number.isInteger(index) || index < 0 || index >= expected || raw === null) continue;
      scores[index] = raw;
      seen = true;
    }
    return seen ? scores : null;
  } catch {
    return null;
  }
}

/** Dedicated cross-encoder rerank endpoint (Cohere/Jina/SiliconFlow/TEI/local shape). */
async function apiScores(question: string, documents: string[]): Promise<number[] | null> {
  const response = await fetch(config.rerank.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(config.rerank.apiKey ? { Authorization: `Bearer ${config.rerank.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: config.rerank.model || undefined,
      query: question,
      documents,
      top_n: documents.length,
    }),
    signal: AbortSignal.timeout(config.ai.timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`Rerank 服务请求失败 (${response.status}): ${(await response.text().catch(() => "")).slice(0, 200)}`);
  }
  const payload = (await response.json()) as { results?: unknown; data?: unknown };
  const list = (payload.results ?? payload.data) as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(list)) return null;
  const scores = new Array<number>(documents.length).fill(0);
  let seen = false;
  for (const item of list) {
    const index = Number(item.index ?? item.document_index);
    const score = clampScore(item.relevance_score ?? item.score);
    if (!Number.isInteger(index) || index < 0 || index >= documents.length || score === null) continue;
    scores[index] = score;
    seen = true;
  }
  return seen ? scores : null;
}

/** Listwise LLM scoring as a portable fallback when no rerank endpoint is configured. */
async function llmScores(question: string, documents: string[]): Promise<number[] | null> {
  const model = config.rerank.provider === "llm" && config.rerank.model ? config.rerank.model : config.ai.utilityModel;
  if (!config.ai.baseUrl || !model) return null;
  const passages = documents.map((document, index) => `[${index}] ${document.slice(0, 400)}`).join("\n\n");
  const raw = await chatCompletion([
    {
      role: "system",
      content: "你是检索相关性重排助手。给定问题和若干资料片段，为每段与问题的相关性打分（0-10，10 表示能直接回答，0 表示完全无关）。只输出一个 JSON 数组，元素形如 {\"index\": 序号, \"score\": 分数}，不要输出任何其他文字。",
    },
    { role: "user", content: `问题：${question}\n\n资料片段：\n${passages}` },
  ], model).catch(() => null);
  return raw ? parseLlmScores(raw, documents.length) : null;
}

/**
 * Re-score retrieved candidates and keep the most relevant. Prefers a dedicated
 * cross-encoder endpoint, falls back to LLM listwise scoring, then to the
 * original vector/keyword order.
 */
export async function rerankResults(question: string, results: SearchResult[]): Promise<SearchResult[]> {
  const limit = config.search.resultLimit;
  const provider = config.rerank.provider;
  if (!config.rerank.enabled || provider === "off" || results.length <= 1) {
    return results.slice(0, limit);
  }

  const pool = results.slice(0, config.rerank.candidates);
  const documents = pool.map((item) => item.snippet);

  let scores: number[] | null = null;
  if ((provider === "api" || provider === "auto") && config.rerank.url) {
    scores = await apiScores(question, documents).catch((error) => {
      console.warn(`[rerank] api provider failed: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    });
  }
  if (!scores && (provider === "llm" || provider === "auto")) {
    scores = await llmScores(question, documents).catch(() => null);
  }
  if (!scores) return pool.slice(0, limit);

  const scored = pool.map((item, index) => ({ item, score: scores[index] }));
  scored.sort((a, b) => b.score - a.score);
  // Honour the threshold strictly: if nothing clears it, the answer should say
  // "no matching material" rather than force the least-irrelevant chunks in.
  return scored
    .filter((entry) => entry.score >= config.rerank.minScore)
    .slice(0, limit)
    .map((entry) => ({ ...entry.item, score: entry.score }));
}
