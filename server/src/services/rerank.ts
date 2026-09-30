import { config } from "../config.js";
import type { SearchResult } from "./search.js";
import { structuredRerankScores } from "./lc/prompts.js";

function clampScore(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : null;
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

/** Structured LangChain scoring as a fallback when no rerank endpoint is configured. */
async function llmScores(question: string, documents: string[]): Promise<number[] | null> {
  const structured = await structuredRerankScores(question, documents).catch(() => null);
  if (!structured?.length) return null;
  const scores = new Array<number>(documents.length).fill(0);
  for (const item of structured) {
    if (item.index >= 0 && item.index < scores.length) {
      scores[item.index] = Math.max(0, Math.min(1, item.score / 10));
    }
  }
  return scores;
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
