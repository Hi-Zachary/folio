import { config } from "../config.js";
import { query } from "../db.js";
import { embedTexts, isEmbeddingConfigured } from "./ai.js";
import { displayFilename } from "./filename.js";
import { isVectorStoreConfigured, searchVectors } from "./vectorStore.js";

export interface SearchResult {
  chunkId: string;
  documentId: string;
  documentName: string;
  fileExtension: string | null;
  snippet: string;
  // Chunk plus its immediate neighbours, used only to build the model context.
  context?: string;
  pageNo: number | null;
  sectionTitle: string | null;
  score: number;
  method: "hybrid" | "embedding" | "fulltext" | "keyword";
}

interface Candidate {
  row: any;
  semanticScore: number;
  fulltextScore: number;
  keywordScore: number;
}

/**
 * Chinese has no word boundaries, so MySQL/MariaDB's default FULLTEXT parser does
 * not tokenise it. We instead build CJK bigrams plus latin words and match them
 * with LIKE, which works the same on MySQL and MariaDB.
 */
function tokens(input: string): string[] {
  const result = new Set<string>();
  const lower = input.toLowerCase();
  for (const match of lower.matchAll(/[a-z0-9_]{2,}/g)) result.add(match[0]);
  for (const run of lower.matchAll(/[\u4e00-\u9fff]+/g)) {
    const text = run[0];
    if (text.length >= 2) {
      for (let index = 0; index + 2 <= text.length; index += 1) result.add(text.slice(index, index + 2));
    }
    if (text.length >= 2 && text.length <= 4) result.add(text);
  }
  return [...result];
}

function escapeLike(term: string) {
  return term.replace(/[\\%_]/g, "\\$&");
}

function snippet(content: string, queryText: string) {
  const lower = content.toLowerCase();
  const firstToken = tokens(queryText).find((token) => lower.includes(token));
  const position = firstToken ? lower.indexOf(firstToken) : 0;
  const start = Math.max(0, position - 120);
  const end = Math.min(content.length, start + 520);
  return `${start > 0 ? "…" : ""}${content.slice(start, end)}${end < content.length ? "…" : ""}`;
}

function cosine(a: number[], b: number[]) {
  if (a.length !== b.length || !a.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < a.length; index += 1) {
    dot += a[index] * b[index];
    normA += a[index] ** 2;
    normB += b[index] ** 2;
  }
  return normA && normB ? dot / (Math.sqrt(normA) * Math.sqrt(normB)) : 0;
}

function toResult(candidate: Candidate, score: number, method: SearchResult["method"]): SearchResult {
  return {
    chunkId: String(candidate.row.chunk_id),
    documentId: String(candidate.row.document_id),
    documentName: displayFilename(candidate.row.original_file_name),
    fileExtension: candidate.row.file_extension ?? null,
    snippet: snippet(candidate.row.content, candidate.row.queryText ?? ""),
    pageNo: candidate.row.page_no,
    sectionTitle: candidate.row.section_title,
    score,
    method,
  };
}

async function lexicalSearch(ownerId: string, terms: string[], limit: number, documentIds?: string[]) {
  if (!terms.length) return [] as any[];
  const scoreSql = terms.map(() => "(c.content LIKE ?)").join(" + ");
  const whereSql = terms.map(() => "c.content LIKE ?").join(" OR ");
  const patterns = terms.map((term) => `%${escapeLike(term)}%`);
  const scopeSql = documentIds?.length ? ` AND c.document_id IN (${documentIds.map(() => "?").join(", ")})` : "";
  const params: unknown[] = [...patterns, ownerId];
  if (documentIds?.length) params.push(...documentIds);
  params.push(...patterns, limit);
  return query<any>(
    `SELECT c.chunk_id, c.document_id, d.original_file_name, d.file_extension, c.content, c.page_no, c.section_title,
            (${scoreSql}) AS match_count
     FROM document_chunk c
     INNER JOIN documents d ON d.document_id = c.document_id
     WHERE d.owner_id = ? AND d.parse_status = 'parsed' AND d.deleted_at IS NULL${scopeSql} AND (${whereSql})
     ORDER BY match_count DESC, c.chunk_id DESC
     LIMIT ?`,
    params,
  ).catch(() => []);
}

/** Adds each result's immediate neighbours so the context around a hit is not cut off. */
async function expandContext(results: SearchResult[]) {
  if (!results.length) return;
  const ids = results.map((result) => result.chunkId);
  const sourceRows = await query<any>(
    `SELECT chunk_id, document_id, chunk_no FROM document_chunk WHERE chunk_id IN (${ids.map(() => "?").join(", ")})`,
    ids,
  ).catch(() => []);
  const byChunk = new Map<string, any>(sourceRows.map((row: any) => [String(row.chunk_id), row] as [string, any]));
  const bounds = new Map<string, { min: number; max: number }>();
  for (const result of results) {
    const source = byChunk.get(result.chunkId);
    if (!source) continue;
    const documentId = String(source.document_id);
    const current = bounds.get(documentId) ?? { min: Number(source.chunk_no), max: Number(source.chunk_no) };
    current.min = Math.min(current.min, Number(source.chunk_no));
    current.max = Math.max(current.max, Number(source.chunk_no));
    bounds.set(documentId, current);
  }
  if (!bounds.size) {
    for (const result of results) result.context = result.snippet;
    return;
  }
  const rangeConditions: string[] = [];
  const rangeParams: unknown[] = [];
  for (const [documentId, bound] of bounds) {
    rangeConditions.push("(document_id = ? AND chunk_no BETWEEN ? AND ?)");
    rangeParams.push(documentId, bound.min - 1, bound.max + 1);
  }
  const neighbors = await query<any>(
    `SELECT document_id, chunk_no, content FROM document_chunk
     WHERE ${rangeConditions.join(" OR ")} ORDER BY document_id, chunk_no`,
    rangeParams,
  ).catch(() => []);
  const byDocument = new Map<string, any[]>();
  for (const row of neighbors) {
    const list = byDocument.get(String(row.document_id)) ?? [];
    list.push(row);
    byDocument.set(String(row.document_id), list);
  }
  for (const result of results) {
    const source = byChunk.get(result.chunkId);
    const rows = source ? (byDocument.get(String(source.document_id)) ?? []).filter((row: any) => Math.abs(Number(row.chunk_no) - Number(source.chunk_no)) <= 1) : [];
    result.context = (rows.length ? rows.map((row) => String(row.content)).join("\n") : result.snippet).slice(0, 2400);
  }
}

export async function searchKnowledge(
  ownerId: string,
  question: string,
  options: { limit?: number; documentIds?: string[] } = {},
): Promise<SearchResult[]> {
  const limit = options.limit ?? config.search.resultLimit;
  const documentIds = options.documentIds?.length ? options.documentIds : undefined;
  const candidateLimit = config.search.candidateLimit;
  const useVectorStore = isVectorStoreConfigured();
  const queryTokens = tokens(question);
  const terms = queryTokens.slice(0, 8);

  const lexicalRows = await lexicalSearch(ownerId, terms, candidateLimit, documentIds);
  const maxMatches = Math.max(terms.length, 1);
  const candidates = new Map<string, Candidate>();

  for (const row of lexicalRows) {
    candidates.set(String(row.chunk_id), {
      row: { ...row, queryText: question },
      semanticScore: 0,
      fulltextScore: Math.min(1, Number(row.match_count) / maxMatches),
      keywordScore: Number(row.match_count),
    });
  }

  // MySQL-json fallback mode needs every chunk to score cosine in-process; Qdrant
  // mode does not, so it skips this potentially large scan.
  if (!useVectorStore) {
    const scopeSql = documentIds?.length ? ` AND c.document_id IN (${documentIds.map(() => "?").join(", ")})` : "";
    const rows = await query<any>(
      `SELECT c.chunk_id, c.document_id, d.original_file_name, d.file_extension, c.content, c.page_no, c.section_title,
              c.embedding_json
       FROM document_chunk c
       INNER JOIN documents d ON d.document_id = c.document_id
       WHERE d.owner_id = ? AND d.parse_status = 'parsed' AND d.deleted_at IS NULL${scopeSql}
       ORDER BY c.chunk_id DESC LIMIT ?`,
      documentIds?.length ? [ownerId, ...documentIds, config.maxEmbeddingCandidates] : [ownerId, config.maxEmbeddingCandidates],
    ).catch(() => []);
    for (const row of rows) {
      const existing = candidates.get(String(row.chunk_id));
      const lower = String(row.content).toLowerCase();
      candidates.set(String(row.chunk_id), {
        row: { ...row, queryText: question },
        semanticScore: existing?.semanticScore ?? 0,
        fulltextScore: existing?.fulltextScore ?? 0,
        keywordScore: terms.reduce((total, term) => total + (lower.includes(term) ? 1 : 0), 0),
      });
    }
  }

  if (isEmbeddingConfigured()) {
    const questionVector = await embedTexts([question]).catch(() => null);
    if (questionVector?.[0]) {
      const vectorHits = await searchVectors(questionVector[0], ownerId, candidateLimit, undefined, documentIds).catch(() => []);
      const hitDocumentIds = [...new Set(vectorHits.map((hit) => hit.payload.documentId).filter(Boolean))];
      const canonicalRows = hitDocumentIds.length ? await query<any>(
        `SELECT document_id, original_file_name, file_extension FROM documents
         WHERE owner_id = ? AND deleted_at IS NULL AND parse_status = 'parsed'
           AND document_id IN (${hitDocumentIds.map(() => "?").join(", ")})`,
        [ownerId, ...hitDocumentIds],
      ).catch(() => []) : [];
      const canonicalDocuments = new Map<string, any>(canonicalRows.map((row: any) => [String(row.document_id), row] as [string, any]));
      for (const hit of vectorHits) {
        const canonical = canonicalDocuments.get(hit.payload.documentId);
        if (!canonical) continue;
        const existing = candidates.get(hit.chunkId);
        const lower = hit.payload.content.toLowerCase();
        candidates.set(hit.chunkId, {
          row: {
            ...(existing?.row ?? {}),
            chunk_id: hit.chunkId,
            document_id: hit.payload.documentId,
            original_file_name: displayFilename(canonical.original_file_name),
            file_extension: canonical.file_extension,
            content: hit.payload.content,
            page_no: hit.payload.pageNo,
            section_title: hit.payload.sectionTitle,
            queryText: question,
          },
          semanticScore: hit.score,
          fulltextScore: existing?.fulltextScore ?? 0,
          keywordScore: existing?.keywordScore ?? terms.reduce((total, term) => total + (lower.includes(term) ? 1 : 0), 0),
        });
      }
      if (!useVectorStore) {
        for (const candidate of candidates.values()) {
          if (candidate.semanticScore > 0) continue;
          let vector: number[] | null = null;
          try {
            vector = Array.isArray(candidate.row.embedding_json)
              ? candidate.row.embedding_json
              : candidate.row.embedding_json
                ? JSON.parse(candidate.row.embedding_json)
                : null;
          } catch {
            vector = null;
          }
          if (vector) candidate.semanticScore = cosine(questionVector[0], vector);
        }
      }
    }
  }

  if (!candidates.size) return [];

  const ranked = [...candidates.values()]
    .map((candidate) => {
      const hasSemantic = candidate.semanticScore > 0;
      const hasFulltext = candidate.fulltextScore > 0;
      const hasKeyword = candidate.keywordScore > 0;
      const score = hasSemantic
        ? candidate.semanticScore * 0.7 + candidate.fulltextScore * 0.2 + Math.min(candidate.keywordScore, 3) / 3 * 0.1
        : hasFulltext
          ? candidate.fulltextScore * 0.8 + Math.min(candidate.keywordScore, 3) / 3 * 0.2
          : Math.min(candidate.keywordScore, 3) / 3;
      return { candidate, score, hasSemantic, hasFulltext, hasKeyword };
    })
    .filter((item) => {
      // Relevance gate: unrelated chunks must not be injected into the model context.
      if (item.hasSemantic && item.candidate.semanticScore >= config.search.semanticMin) return true;
      if (item.hasFulltext && item.candidate.fulltextScore >= config.search.fulltextMin) return true;
      if (item.hasKeyword && item.candidate.keywordScore >= config.search.keywordMin) return true;
      return false;
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(limit, config.rerank.candidates));

  const results = ranked.map((item) => toResult(
    item.candidate,
    item.score,
    item.hasSemantic && (item.hasFulltext || item.hasKeyword)
      ? "hybrid"
      : item.hasSemantic
        ? "embedding"
        : item.hasFulltext
          ? "fulltext"
          : "keyword",
  ));
  await expandContext(results);
  return results;
}
