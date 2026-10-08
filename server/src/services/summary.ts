import { config } from "../config.js";
import { query } from "../db.js";
import { chatCompletion, isChatConfigured } from "./ai.js";
import { structuredDocumentSummary } from "./lc/prompts.js";
import { getEncoding } from "js-tiktoken";

/** Approximate characters folded into one map/reduce request. */
const GROUP_CHARS = config.summary.groupChars;
const MATERIAL_LIMIT = 20000;
const SUMMARY_TOKENIZER = getEncoding("o200k_base");

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

function indexedChunkGroups(chunks: any[], maxChars = GROUP_CHARS) {
  const groups: Array<{ start: number; end: number; texts: string[]; title: string }> = [];
  let start = 0;
  let current: string[] = [];
  let size = 0;
  for (const [index, chunk] of chunks.entries()) {
    const text = String(chunk.content);
    if (current.length && size + text.length > maxChars) {
      const title = String(chunks[start]?.section_title ?? "").trim();
      groups.push({ start, end: index - 1, texts: current, title });
      start = index;
      current = [];
      size = 0;
    }
    current.push(text);
    size += text.length;
  }
  if (current.length) groups.push({ start, end: chunks.length - 1, texts: current, title: String(chunks[start]?.section_title ?? "").trim() });
  return groups;
}

async function summarizeSegment(text: string): Promise<string | null> {
  return chatCompletion([
    { role: "system", content: "你是资料摘要助手。请用中文概括提供的资料片段，保留本段的关键人物、事件、论点、结论、条件和因果关系，不要加入资料之外的信息。若原文有章节或段落标题，请保留标题。" },
    { role: "user", content: text.slice(0, GROUP_CHARS) },
  ], config.ai.utilityModel, 0).catch(() => null);
}

async function summarizeGroups(groups: string[][]) {
  const summaries: string[] = [];
  for (let index = 0; index < groups.length; index += config.summary.mapConcurrency) {
    const batch = await Promise.all(groups.slice(index, index + config.summary.mapConcurrency).map((group) => summarizeSegment(group.join("\n"))));
    if (batch.some((summary) => !summary)) throw new Error(`摘要分段生成失败（${index + 1}-${index + batch.length}/${groups.length}）`);
    summaries.push(...batch as string[]);
  }
  return summaries;
}

async function persistSummarySections(documentId: string, sourceVersion: number, sections: Array<{ sectionNo: number; title: string; summary: string; startChunk: number; endChunk: number }>) {
  await query("DELETE FROM document_summary_section WHERE document_id = ?", [documentId]);
  for (const section of sections) {
    await query(
      `INSERT INTO document_summary_section
        (document_id,content_version,section_no,title,summary,start_chunk_no,end_chunk_no)
       VALUES (?,?,?,?,?,?,?)`,
      [documentId, sourceVersion, section.sectionNo, section.title, section.summary, section.startChunk, section.endChunk],
    );
  }
}

/**
 * Hierarchical ("map → reduce") summary so long documents are covered by the whole
 * text rather than a few top-k chunks. The result is cached on the document row and
 * stamped with the content version so it can be detected as stale after a re-parse.
 */
export async function generateDocumentSummary(documentId: string, ownerId: string) {
  if (!isChatConfigured()) throw new Error("未配置对话模型，无法生成摘要");
  const documents = await query<any>(
    `SELECT original_file_name, content_version, ai_summary_pipeline_version FROM documents
     WHERE document_id = ? AND owner_id = ? AND parse_status = 'parsed' AND deleted_at IS NULL`,
    [documentId, ownerId],
  );
  if (!documents.length) throw new Error("文档不存在或尚未解析完成");

  const chunks = await query<any>("SELECT chunk_no,content,section_title FROM document_chunk WHERE document_id = ? ORDER BY chunk_no", [documentId]);
  if (!chunks.length) throw new Error("文档没有可用的解析内容");
  const texts = chunks.map((chunk: any) => String(chunk.content));

  const sourceVersion = Number(documents[0].content_version);
  const summaryModel = config.ai.utilityModel || config.ai.chatModel;
  const singlePassGroups = indexedChunkGroups(chunks, config.summary.sectionChars);
  const singlePassMaterial = singlePassGroups.map((group, index) => {
    const title = group.title ? `；章节：${group.title}` : "";
    return `【全文分段 ${index + 1}；原文 chunk ${chunks[group.start].chunk_no}-${chunks[group.end].chunk_no}${title}】\n${group.texts.join("\n")}`;
  }).join("\n\n");
  const estimatedTokens = SUMMARY_TOKENIZER.encode(singlePassMaterial).length + 12000;
  const singlePassBudget = Math.max(0, config.summary.contextTokens - config.summary.contextReserveTokens);

  if (estimatedTokens <= singlePassBudget) {
    const result = await structuredDocumentSummary(singlePassMaterial, summaryModel, singlePassGroups.length);
    const bySection = new Map<number, { title: string; summary: string }>();
    for (const section of result?.sections ?? []) {
      if (section.sectionNo >= 1 && section.sectionNo <= singlePassGroups.length && section.summary.trim()) {
        bySection.set(section.sectionNo, { title: section.title.trim(), summary: section.summary.trim() });
      }
    }
    if (result?.summary?.trim() && bySection.size === singlePassGroups.length) {
      const sections = singlePassGroups.map((group, index) => ({
        sectionNo: index + 1,
        title: bySection.get(index + 1)!.title || group.title || `资料第 ${index + 1} 部分`,
        summary: bySection.get(index + 1)!.summary,
        startChunk: Number(chunks[group.start].chunk_no),
        endChunk: Number(chunks[group.end].chunk_no),
      }));
      const summary = result.summary.trim().slice(0, 2000);
      const keyPoints = stringList(result.keyPoints, 8);
      const outline = stringList(result.outline, 10);
      await persistSummarySections(documentId, sourceVersion, sections);
      await query(
        `UPDATE documents
         SET ai_summary=?,ai_summary_key_points=?,ai_summary_outline=?,ai_summary_model=?,ai_summary_at=NOW(),
             ai_summary_version=content_version,ai_summary_pipeline_version=content_version
         WHERE document_id=? AND owner_id=? AND content_version=?`,
        [summary, JSON.stringify(keyPoints), JSON.stringify(outline), summaryModel, documentId, ownerId, sourceVersion],
      );
      return { status: "ready" as const, summary, keyPoints, outline, modelName: summaryModel, generatedAt: new Date().toISOString() };
    }
    throw new Error("单次全文摘要没有返回完整的分段概要；任务停止以避免重复提交大额长上下文请求");
  } else {
    console.log(`[summary] document ${documentId} estimated at ${estimatedTokens} tokens, above single-pass budget ${singlePassBudget}; using map/reduce`);
  }

  let material = texts.join("\n");
  let sections: Array<{ sectionNo: number; title: string; summary: string; startChunk: number; endChunk: number }> = [];
  if (material.length > GROUP_CHARS) {
    const indexedGroups = indexedChunkGroups(chunks);
    const partials = await summarizeGroups(indexedGroups.map((group) => group.texts));
    sections = indexedGroups.map((group, index) => ({
      sectionNo: index + 1,
      title: group.title || `资料第 ${index + 1} 部分`,
      summary: partials[index],
      startChunk: Number(chunks[group.start].chunk_no),
      endChunk: Number(chunks[group.end].chunk_no),
    }));

    let reduceEntries = sections.map((section) => ({ summary: section.summary, sections: [section] }));
    let reduceMaterial = reduceEntries.map((entry, index) => `[${index + 1}] ${entry.summary}`).join("\n\n");
    while (reduceMaterial.length > MATERIAL_LIMIT) {
      const grouped = chunkGroups(reduceEntries.map((entry) => entry.summary));
      const next: typeof reduceEntries = [];
      let offset = 0;
      for (const group of grouped) {
        const selected = reduceEntries.slice(offset, offset + group.length);
        const reduced = await summarizeSegment(group.join("\n\n"));
        if (!reduced) throw new Error("长文概要归并失败");
        next.push({ summary: reduced, sections: selected.flatMap((entry) => entry.sections) });
        offset += group.length;
      }
      reduceEntries = next;
      reduceMaterial = reduceEntries.map((entry, index) => `[${index + 1}] ${entry.summary}`).join("\n\n");
    }
    sections = reduceEntries.map((entry, index) => ({
      sectionNo: index + 1,
      title: entry.sections.length === 1 ? entry.sections[0].title : `全文概要部分 ${index + 1}`,
      summary: entry.summary,
      startChunk: Math.min(...entry.sections.map((section) => section.startChunk)),
      endChunk: Math.max(...entry.sections.map((section) => section.endChunk)),
    }));
    material = reduceMaterial;
  } else {
    sections = [{
      sectionNo: 1,
      title: "全文",
      summary: material,
      startChunk: Number(chunks[0].chunk_no),
      endChunk: Number(chunks[chunks.length - 1].chunk_no),
    }];
  }

  const structured = await structuredDocumentSummary(material, summaryModel).catch(() => null);
  if (structured?.summary) {
    const summary = structured.summary.trim().slice(0, 2000);
    const keyPoints = stringList(structured.keyPoints, 8);
    const outline = stringList(structured.outline, 10);
    if (sections.length === 1 && sections[0].title === "全文") sections[0].summary = summary;
    await persistSummarySections(documentId, sourceVersion, sections);
    await query(
      `UPDATE documents
       SET ai_summary = ?, ai_summary_key_points = ?, ai_summary_outline = ?,
           ai_summary_model = ?, ai_summary_at = NOW(), ai_summary_version = content_version,
           ai_summary_pipeline_version = content_version
       WHERE document_id = ? AND owner_id = ? AND content_version = ?`,
      [summary, JSON.stringify(keyPoints), JSON.stringify(outline), summaryModel, documentId, ownerId, sourceVersion],
    );
    return { status: "ready" as const, summary, keyPoints, outline, modelName: summaryModel, generatedAt: new Date().toISOString() };
  }

  const raw = await chatCompletion([
    {
      role: "system",
      content: "你是资料摘要助手。请根据提供的资料内容输出 JSON：{\"summary\": \"约 150-300 字的整体概览\", \"keyPoints\": [\"3-6 条核心要点\"], \"outline\": [\"可选的内容结构；没有明显结构时给空数组\"]}。只输出 JSON，不要输出 Markdown 或解释。",
    },
    { role: "user", content: material },
  ], summaryModel, 0);
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

  if (sections.length === 1 && sections[0].title === "全文") sections[0].summary = summary;
  await persistSummarySections(documentId, sourceVersion, sections);
  await query(
    `UPDATE documents
     SET ai_summary = ?, ai_summary_key_points = ?, ai_summary_outline = ?,
         ai_summary_model = ?, ai_summary_at = NOW(), ai_summary_version = content_version,
         ai_summary_pipeline_version = content_version
     WHERE document_id = ? AND owner_id = ? AND content_version = ?`,
    [summary, JSON.stringify(keyPoints), JSON.stringify(outline), summaryModel, documentId, ownerId, sourceVersion],
  );
  return {
    status: "ready" as const,
    summary,
    keyPoints,
    outline,
    modelName: summaryModel,
    generatedAt: new Date().toISOString(),
  };
}

export async function getDocumentSummary(documentId: string, ownerId: string): Promise<DocumentSummaryState> {
  const rows = await query<any>(
    `SELECT ai_summary, ai_summary_key_points, ai_summary_outline, ai_summary_model, ai_summary_at,
            ai_summary_version, ai_summary_pipeline_version, content_version,
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
  const pipelineStale = Number(row.ai_summary_pipeline_version ?? 0) < Number(row.content_version);
  return {
    status: !pipelineStale && row.ai_summary_version === row.content_version ? "ready" : "stale",
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
