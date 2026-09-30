import { config } from "../config.js";
import { query } from "../db.js";
import { chatCompletion, isChatConfigured } from "./ai.js";
import { structuredDocumentSummary } from "./lc/prompts.js";

/** Approximate characters folded into one map step before the final reduce. */
const GROUP_CHARS = 6000;
const MAX_GROUPS = 20;
const MATERIAL_LIMIT = 20000;
const SUMMARY_CONCURRENCY = 3;

export interface DocumentSummaryState {
  status: "none" | "stale" | "ready" | "generating" | "failed";
  generationStatus?: "pending" | "running" | "failed" | "success" | null;
  summary: string;
  keyPoints: string[];
  outline: string[];
  modelName: string | null;
  generatedAt: string | null;
}

function stringList(value: unknown, max = 12): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === "string" ? item : typeof item === "number" ? String(item) : ""))
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, max);
}

function chunkGroups(texts: string[]): string[][] {
  const groups: string[][] = [];
  let current: string[] = [];
  let size = 0;
  for (const text of texts) {
    if (current.length && size + text.length > GROUP_CHARS) {
      groups.push(current);
      current = [];
      size = 0;
    }
    current.push(text);
    size += text.length;
  }
  if (current.length) groups.push(current);
  return groups;
}

async function summarizeSegment(text: string): Promise<string | null> {
  return chatCompletion([
    { role: "system", content: "你是资料摘要助手。请用中文把这段资料压缩成要点式摘要，保留关键概念、结论和重要条件，不要加入资料之外的信息。" },
    { role: "user", content: text.slice(0, GROUP_CHARS) },
  ]).catch(() => null);
}

/**
 * Hierarchical ("map → reduce") summary so long documents are covered by the whole
 * text rather than a few top-k chunks. The result is cached on the document row and
 * stamped with the content version so it can be detected as stale after a re-parse.
 */
export async function generateDocumentSummary(documentId: string, ownerId: string) {
  if (!isChatConfigured()) throw new Error("未配置对话模型，无法生成摘要");
  const documents = await query<any>(
    `SELECT original_file_name, content_version FROM documents
     WHERE document_id = ? AND owner_id = ? AND parse_status = 'parsed' AND deleted_at IS NULL`,
    [documentId, ownerId],
  );
  if (!documents.length) throw new Error("文档不存在或尚未解析完成");

  const chunks = await query<any>("SELECT content FROM document_chunk WHERE document_id = ? ORDER BY chunk_no", [documentId]);
  if (!chunks.length) throw new Error("文档没有可用的解析内容");
  const texts = chunks.map((chunk: any) => String(chunk.content));

  let material = texts.join("\n");
  const sourceVersion = Number(documents[0].content_version);
  if (material.length > GROUP_CHARS) {
    const groups = chunkGroups(texts).slice(0, MAX_GROUPS);
    const partials: string[] = [];
    for (let index = 0; index < groups.length; index += SUMMARY_CONCURRENCY) {
      const batch = await Promise.all(groups.slice(index, index + SUMMARY_CONCURRENCY).map((group) => summarizeSegment(group.join("\n"))));
      partials.push(...batch.filter((partial): partial is string => Boolean(partial)));
    }
    if (!partials.length) throw new Error("摘要生成失败");
    material = partials.join("\n\n");
  }

  const structured = await structuredDocumentSummary(material).catch(() => null);
  if (structured?.summary) {
    const summary = structured.summary.trim().slice(0, 2000);
    const keyPoints = stringList(structured.keyPoints, 8);
    const outline = stringList(structured.outline, 10);
    await query(
      `UPDATE documents
       SET ai_summary = ?, ai_summary_key_points = ?, ai_summary_outline = ?,
           ai_summary_model = ?, ai_summary_at = NOW(), ai_summary_version = content_version
       WHERE document_id = ? AND owner_id = ? AND content_version = ?`,
      [summary, JSON.stringify(keyPoints), JSON.stringify(outline), config.ai.chatModel, documentId, ownerId, sourceVersion],
    );
    return { status: "ready" as const, summary, keyPoints, outline, modelName: config.ai.chatModel, generatedAt: new Date().toISOString() };
  }

  const raw = await chatCompletion([
    {
      role: "system",
      content: "你是资料摘要助手。请根据提供的资料内容输出 JSON：{\"summary\": \"约 150-300 字的整体概览\", \"keyPoints\": [\"3-6 条核心要点\"], \"outline\": [\"可选的内容结构；没有明显结构时给空数组\"]}。只输出 JSON，不要输出 Markdown 或解释。",
    },
    { role: "user", content: material.slice(0, MATERIAL_LIMIT) },
  ]);
  if (!raw) throw new Error("摘要生成失败");

  let summary = "";
  let keyPoints: string[] = [];
  let outline: string[] = [];
  try {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    const parsed = JSON.parse(start >= 0 && end > start ? raw.slice(start, end + 1) : raw) as Record<string, unknown>;
    summary = typeof parsed.summary === "string" ? parsed.summary.trim().slice(0, 2000) : "";
    keyPoints = stringList(parsed.keyPoints, 8);
    outline = stringList(parsed.outline, 10);
  } catch {
    summary = raw.trim().slice(0, 2000);
  }
  if (!summary) throw new Error("摘要生成失败");

  await query(
    `UPDATE documents
     SET ai_summary = ?, ai_summary_key_points = ?, ai_summary_outline = ?,
         ai_summary_model = ?, ai_summary_at = NOW(), ai_summary_version = content_version
     WHERE document_id = ? AND owner_id = ? AND content_version = ?`,
    [summary, JSON.stringify(keyPoints), JSON.stringify(outline), config.ai.chatModel, documentId, ownerId, sourceVersion],
  );

  return {
    status: "ready" as const,
    summary,
    keyPoints,
    outline,
    modelName: config.ai.chatModel,
    generatedAt: new Date().toISOString(),
  };
}

export async function getDocumentSummary(documentId: string, ownerId: string): Promise<DocumentSummaryState> {
  const rows = await query<any>(
    `SELECT ai_summary, ai_summary_key_points, ai_summary_outline, ai_summary_model, ai_summary_at,
            ai_summary_version, content_version,
            (SELECT status FROM document_job WHERE document_id = documents.document_id AND job_type = 'summary' ORDER BY job_id DESC LIMIT 1) AS summary_job_status
     FROM documents WHERE document_id = ? AND owner_id = ? AND deleted_at IS NULL`,
    [documentId, ownerId],
  );
  if (!rows.length) throw new Error("文档不存在");
  const row = rows[0];
  if (!row.ai_summary_at || !row.ai_summary) {
    return {
      status: "none", generationStatus: row.summary_job_status ?? null,
      summary: "", keyPoints: [], outline: [], modelName: null, generatedAt: null,
    };
  }
  const parse = (value: unknown) => {
    if (Array.isArray(value)) return value as unknown[];
    if (typeof value === "string") {
      try { return JSON.parse(value) as unknown[]; } catch { return []; }
    }
    return [];
  };
  return {
    status: row.ai_summary_version === row.content_version ? "ready" : "stale",
    generationStatus: row.summary_job_status ?? null,
    summary: String(row.ai_summary),
    keyPoints: stringList(parse(row.ai_summary_key_points)),
    outline: stringList(parse(row.ai_summary_outline)),
    modelName: row.ai_summary_model ?? null,
    generatedAt: row.ai_summary_at,
  };
}

/** Cached, non-stale summary text, used to feed full-document / multi-document tasks. */
export async function getFreshSummaryText(documentId: string, ownerId: string): Promise<string | null> {
  const state = await getDocumentSummary(documentId, ownerId);
  return state.status === "ready" ? state.summary : null;
}
