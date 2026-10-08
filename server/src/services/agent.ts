import { query } from "../db.js";
import { parseJson } from "./app.js";
import { displayFilename } from "./filename.js";
import { searchKnowledge, type SearchResult } from "./search.js";
import { rerankResults } from "./rerank.js";
import { enqueueSummaryIfStale } from "./documentProcessor.js";
import { getDocumentSummary } from "./summary.js";

export interface AgentScope {
  restricted: boolean;
  documentIds: string[];
}

export interface StoredHistoryMessage {
  role: "user" | "assistant";
  content: string;
}

export interface AgentResult {
  sources: SearchResult[];
  evidenceText: string;
  hasEvidence: boolean;
  usedTools: string[];
  // True when the agent already produced (and streamed) the final answer in its
  // last turn, so the caller does not need a second generation.
  answered: boolean;
  answerText: string;
}

const MAX_SOURCES = 16;
const TEXT_READ_BUDGET = 6000;

export const AGENT_SYSTEM = [
  "你是个人知识库助手。系统可能会先提供相关资料；你也可以在当前问答范围内发现资料、浏览项目和标签、读取覆盖全文的概要，以及检索原文证据。",
  "你的任务：",
  "1. 判断问题是目录/状态查询、指定资料概览、局部事实，还是多资料比较，只调用完成任务所需的工具。",
  "2. 用户提到资料名、书名、简称或可能的拼写错误时，先用 find_documents 找候选；候选不唯一时先询问用户，不要自行假定。",
  "3. 介绍/概述/总结整份资料时，必须先用 get_document_overview 获取覆盖全文的概要，再按需用 search_chunks 核对具体事实；不能用一两个相似片段冒充全文理解。",
  "4. 具体事实问题用 search_chunks；比较资料时分别读取每篇概要，再查各自原文。项目、标签、资料目录问题使用对应目录工具，不要根据文件名推测内容。",
  "5. 完整概要尚未生成或生成失败时，明确说明状态，不要以正文开头预览冒充全文介绍；可以改为回答用户提出的具体事实问题。",
  "6. list_documents 的结果如果提示还有下一页且用户要求完整列表，应继续翻页，直到列完或达到合理长度。",
  "规则：",
  "1. 只能依据对话中提供的资料回答，不要编造资料中不存在的信息；确实没有就说“资料中没有相关内容”。",
  "2. 只有资料中标有 [N] 时才使用引用；没有编号时不要添加引用。",
  "3. 直接给出结论。禁止提及工具名称、调用过程或“我需要先查看…”这类过程描述。",
  "4. 列出资料目录时不要根据文件名推测资料内容。",
  "5. 回答使用中文，简洁、有条理，可以使用 Markdown。",
].join("\n");

export interface Collector {
  sources: SearchResult[];
  seen: Set<string>;
  blocks: string[];
}

export function addSource(collector: Collector, item: SearchResult) {
  if (collector.sources.length >= MAX_SOURCES) return null;
  const key = `${item.documentId}:${item.chunkId}`;
  if (collector.seen.has(key)) return null;
  collector.seen.add(key);
  collector.sources.push(item);
  return collector.sources.length;
}

function normalizeTitle(value: string) {
  return value.toLocaleLowerCase().normalize("NFKC").replace(/\.[a-z0-9]{1,8}$/i, "").replace(/[^\p{L}\p{N}]+/gu, "");
}

function characterNgrams(value: string, size = 3) {
  const chars = [...value];
  if (chars.length <= size) return new Set(chars.length ? [chars.join("")] : []);
  const grams = new Set<string>();
  for (let index = 0; index <= chars.length - size; index += 1) grams.add(chars.slice(index, index + size).join(""));
  return grams;
}

function fuzzyTitleScore(queryText: string, title: string, metadata = "") {
  const queryValue = normalizeTitle(queryText);
  const titleValue = normalizeTitle(title);
  if (!queryValue || !titleValue) return 0;
  if (queryValue === titleValue) return 1;
  if (titleValue.includes(queryValue) || queryValue.includes(titleValue)) return 0.92;
  const queryGrams = characterNgrams(queryValue);
  const titleGrams = characterNgrams(titleValue);
  let overlap = 0;
  for (const gram of queryGrams) if (titleGrams.has(gram)) overlap += 1;
  const dice = 2 * overlap / (queryGrams.size + titleGrams.size || 1);
  const normalizedMetadata = normalizeTitle(metadata);
  const metadataMatch = normalizedMetadata.includes(queryValue) ? 0.72 : 0;
  return Math.max(dice, metadataMatch);
}

async function documentCatalog(userId: string, scope: AgentScope, collectionId?: string) {
  const conditions = ["d.owner_id = ?", "d.deleted_at IS NULL"];
  const params: unknown[] = [userId];
  if (scope.restricted) {
    if (!scope.documentIds.length) return [];
    conditions.push(`d.document_id IN (${scope.documentIds.map(() => "?").join(", ")})`);
    params.push(...scope.documentIds);
  }
  if (collectionId) {
    const collections = await query<any>(
      "SELECT collection_id, is_smart, smart_filter FROM collection WHERE collection_id = ? AND owner_id = ?",
      [collectionId, userId],
    );
    if (!collections.length) return [];
    const collection = collections[0];
    if (collection.is_smart) {
      const filter = parseJson<Record<string, unknown>>(collection.smart_filter, {});
      const smartQuery = typeof filter.q === "string" ? filter.q.trim().slice(0, 100) : "";
      if (smartQuery) {
        const pattern = `%${smartQuery.replace(/[\\%_]/g, "\\$&")}%`;
        conditions.push("(d.original_file_name LIKE ? OR EXISTS (SELECT 1 FROM document_chunk sc WHERE sc.document_id=d.document_id AND sc.content LIKE ?))");
        params.push(pattern, pattern);
      }
      if (typeof filter.tagId === "string" && filter.tagId) {
        conditions.push("EXISTS (SELECT 1 FROM document_tag sdt WHERE sdt.document_id=d.document_id AND sdt.tag_id=?)");
        params.push(filter.tagId);
      }
      if (typeof filter.status === "string" && ["pending", "parsing", "parsed", "failed"].includes(filter.status)) {
        conditions.push("d.parse_status = ?");
        params.push(filter.status);
      }
      const extensions: Record<string, string[]> = {
        PDF: [".pdf"], Word: [".doc", ".docx"], Markdown: [".md", ".markdown"], HTML: [".html", ".htm"], CSV: [".csv"], TXT: [".txt"],
      };
      const types = typeof filter.type === "string" ? extensions[filter.type] : undefined;
      if (types?.length) {
        conditions.push(`d.file_extension IN (${types.map(() => "?").join(", ")})`);
        params.push(...types);
      }
    } else {
      conditions.push("EXISTS (SELECT 1 FROM collection_document cd WHERE cd.document_id=d.document_id AND cd.collection_id=?)");
      params.push(collectionId);
    }
  }
  return query<any>(
    `SELECT d.document_id,d.original_file_name,d.file_extension,d.parse_status,
            CASE WHEN d.ai_summary_pipeline_version>=d.content_version THEN d.ai_summary ELSE NULL END AS ai_summary,
            (SELECT COUNT(*) FROM documents earlier WHERE earlier.owner_id=d.owner_id AND earlier.deleted_at IS NULL
              AND (earlier.uploaded_at<d.uploaded_at OR (earlier.uploaded_at=d.uploaded_at AND earlier.document_id<=d.document_id))) AS local_document_no,
            (SELECT GROUP_CONCAT(t.name ORDER BY t.name SEPARATOR '、') FROM document_tag dt JOIN tag t ON t.tag_id=dt.tag_id WHERE dt.document_id=d.document_id) AS tags,
            (SELECT GROUP_CONCAT(t.tag_id SEPARATOR ',') FROM document_tag dt JOIN tag t ON t.tag_id=dt.tag_id WHERE dt.document_id=d.document_id) AS tag_ids
     FROM documents d WHERE ${conditions.join(" AND ")} ORDER BY d.uploaded_at DESC,d.document_id DESC`,
    params,
  ).catch(() => []);
}

async function verifyDocument(userId: string, scope: AgentScope, reference: string) {
  const exact = await query<any>(
    `SELECT d.document_id,d.original_file_name,d.file_extension,d.parse_status,
            (SELECT COUNT(*) FROM documents earlier WHERE earlier.owner_id=d.owner_id AND earlier.deleted_at IS NULL
              AND (earlier.uploaded_at<d.uploaded_at OR (earlier.uploaded_at=d.uploaded_at AND earlier.document_id<=d.document_id))) AS local_document_no
     FROM documents d WHERE d.document_id=? AND d.owner_id=? AND d.deleted_at IS NULL`,
    [reference, userId],
  ).catch(() => []);
  let rows = exact;
  if (!rows.length) {
    const number = Number(reference);
    if (!Number.isSafeInteger(number) || number < 1) return null;
    rows = await query<any>(
      `SELECT d.document_id,d.original_file_name,d.file_extension,d.parse_status,
              (SELECT COUNT(*) FROM documents earlier WHERE earlier.owner_id=d.owner_id AND earlier.deleted_at IS NULL
                AND (earlier.uploaded_at<d.uploaded_at OR (earlier.uploaded_at=d.uploaded_at AND earlier.document_id<=d.document_id))) AS local_document_no
       FROM documents d
       WHERE d.owner_id=? AND d.deleted_at IS NULL
         AND (SELECT COUNT(*) FROM documents earlier
              WHERE earlier.owner_id=d.owner_id AND earlier.deleted_at IS NULL
                AND (earlier.uploaded_at<d.uploaded_at OR (earlier.uploaded_at=d.uploaded_at AND earlier.document_id<=d.document_id)))=?`,
      [userId, number],
    ).catch(() => []);
  }
  if (rows[0] && scope.restricted && !scope.documentIds.includes(String(rows[0].document_id))) return null;
  if (rows[0]?.parse_status !== "parsed") return null;
  return rows[0] ?? null;
}

async function toolSearchChunks(userId: string, scope: AgentScope, collector: Collector, args: Record<string, unknown>) {
  const searchQuery = String(args.query ?? "").trim();
  if (!searchQuery) return "缺少 query 参数。";
  const requestedIds = Array.isArray(args.documentIds) ? args.documentIds.map(String) : undefined;
  const documentIds = scope.restricted
    ? requestedIds ? requestedIds.filter((id) => scope.documentIds.includes(id)) : scope.documentIds
    : requestedIds;
  if (documentIds && !documentIds.length) return "指定的资料不在当前问答范围内。";
  const found = await searchKnowledge(userId, searchQuery, { documentIds });
  const ranked = (await rerankResults(searchQuery, found)).slice(0, 5);
  if (!ranked.length) return "没有检索到相关资料。";
  const lines: string[] = [];
  for (const item of ranked) {
    const index = addSource(collector, item);
    if (!index) break;
    lines.push(`[${index}] ${item.documentName}${item.pageNo ? ` · 第 ${item.pageNo} 页` : ""}\n${item.context ?? item.snippet}`);
  }
  return lines.length ? lines.join("\n\n") : "没有检索到相关资料。";
}

async function toolListDocuments(userId: string, scope: AgentScope, args: Record<string, unknown>) {
  const collectionId = String(args.collectionId ?? "").trim() || undefined;
  let rows = await documentCatalog(userId, scope, collectionId);
  const queryText = String(args.query ?? "").trim();
  const normalizedQuery = normalizeTitle(queryText);
  const tagId = String(args.tagId ?? "").trim();
  const status = String(args.status ?? "").trim();
  const type = String(args.type ?? "").trim();
  const extensionGroups: Record<string, string[]> = {
    PDF: [".pdf"], Word: [".doc", ".docx"], Markdown: [".md", ".markdown"], HTML: [".html", ".htm"], CSV: [".csv"], TXT: [".txt"],
  };
  rows = rows.filter((row: any) => {
    if (status && row.parse_status !== status) return false;
    if (type && !extensionGroups[type]?.includes(String(row.file_extension).toLowerCase())) return false;
    if (tagId && !String(row.tag_ids ?? "").split(",").includes(tagId)) return false;
    if (normalizedQuery && !normalizeTitle(String(row.original_file_name)).includes(normalizedQuery)) return false;
    return true;
  });
  const pageSize = Math.min(50, Math.max(1, Number(args.pageSize) || 25));
  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
  const page = Math.min(pageCount, Math.max(1, Number(args.page) || 1));
  const pageRows = rows.slice((page - 1) * pageSize, page * pageSize);
  if (!rows.length) return "当前筛选条件下没有资料。";
  const lines = [`共 ${rows.length} 篇资料；第 ${page}/${pageCount} 页：`];
  for (const row of pageRows) {
    const tags = row.tags ? `；标签：${row.tags}` : "";
    lines.push(`- 资料编号 ${row.local_document_no}（documentId=${row.document_id}）：${displayFilename(row.original_file_name)}；状态：${row.parse_status}${tags}`);
  }
  if (page < pageCount) lines.push(`还有 ${pageCount - page} 页；用户要求完整列表时继续读取下一页。`);
  return lines.join("\n");
}

async function toolFindDocuments(userId: string, scope: AgentScope, args: Record<string, unknown>) {
  const searchQuery = String(args.query ?? "").trim();
  if (!searchQuery) return "缺少要查找的资料名称或关键词。";
  const rows = await documentCatalog(userId, scope, String(args.collectionId ?? "").trim() || undefined);
  if (!rows.length) return "当前范围没有可查找的资料。";
  const scored: Array<{ row: any; score: number }> = (rows as any[])
    .map((row: any) => ({
      row,
      score: fuzzyTitleScore(searchQuery, String(row.original_file_name), `${row.tags ?? ""} ${row.ai_summary ?? ""}`),
    }))
    .filter((item: { row: any; score: number }) => item.score >= 0.16)
    .sort((a: { score: number }, b: { score: number }) => b.score - a.score)
    .slice(0, 5);
  if (!scored.length) return "没有找到标题或资料概要相近的候选资料；可以改用 search_chunks 检索正文主题。";
  return [
    `找到 ${scored.length} 个候选资料，匹配度仅用于排序，不代表内容相关性：`,
    ...scored.map(({ row, score }: { row: any; score: number }) => `- 资料编号 ${row.local_document_no}（documentId=${row.document_id}）：${displayFilename(row.original_file_name)}（${Math.round(score * 100)}% 标题/标签/概要匹配；状态：${row.parse_status}${row.tags ? `；标签：${row.tags}` : ""}）`),
    "若多个候选都合理，先询问用户选哪一篇；确定后可使用资料编号或 documentId 读取概要、限定原文检索。",
  ].join("\n");
}

async function toolListTags(userId: string, scope: AgentScope) {
  if (scope.restricted) {
    if (!scope.documentIds.length) return "当前范围没有资料标签。";
    const ids = scope.documentIds.map(() => "?").join(", ");
    const rows = await query<any>(
      `SELECT t.tag_id,t.name,t.color,COUNT(DISTINCT d.document_id) AS document_count
       FROM tag t JOIN document_tag dt ON dt.tag_id=t.tag_id
       JOIN documents d ON d.document_id=dt.document_id
       WHERE t.owner_id=? AND d.owner_id=? AND d.deleted_at IS NULL AND d.document_id IN (${ids})
       GROUP BY t.tag_id,t.name,t.color ORDER BY t.name LIMIT 100`,
      [userId, userId, ...scope.documentIds],
    ).catch(() => []);
    if (!rows.length) return "当前范围没有标签。";
    return [`当前范围内共 ${rows.length} 个标签：`, ...rows.map((row: any) => `- ${row.name}（tagId=${row.tag_id}，${Number(row.document_count)} 篇资料）`)].join("\n");
  }
  const rows = await query<any>(
    `SELECT t.tag_id,t.name,t.color,COUNT(DISTINCT d.document_id) AS document_count
     FROM tag t LEFT JOIN document_tag dt ON dt.tag_id=t.tag_id
     LEFT JOIN documents d ON d.document_id=dt.document_id AND d.owner_id=t.owner_id AND d.deleted_at IS NULL
     WHERE t.owner_id=? GROUP BY t.tag_id,t.name,t.color ORDER BY t.name LIMIT 100`,
    [userId],
  ).catch(() => []);
  if (!rows.length) return "没有标签。";
  return [`共 ${rows.length} 个标签：`, ...rows.map((row: any) => `- ${row.name}（tagId=${row.tag_id}，${Number(row.document_count)} 篇资料）`)].join("\n");
}

async function toolGetDocumentStatus(userId: string, scope: AgentScope, args: Record<string, unknown>) {
  const conditions = ["d.owner_id = ?", "d.deleted_at IS NULL"];
  const params: unknown[] = [userId];
  if (scope.restricted) {
    if (!scope.documentIds.length) return "当前范围没有资料。";
    conditions.push(`d.document_id IN (${scope.documentIds.map(() => "?").join(", ")})`);
    params.push(...scope.documentIds);
  }

  const requestedNumber = String(args.documentNumber ?? "").trim();
  if (requestedNumber) {
    const number = Number(requestedNumber);
    if (!Number.isSafeInteger(number) || number < 1) return "资料编号无效。";
    conditions.push(`(SELECT COUNT(*) FROM documents earlier
      WHERE earlier.owner_id = d.owner_id AND earlier.deleted_at IS NULL
        AND (earlier.uploaded_at < d.uploaded_at OR (earlier.uploaded_at = d.uploaded_at AND earlier.document_id <= d.document_id))) = ?`);
    params.push(number);
  }

  const rows = await query<any>(
    `SELECT d.document_id, d.original_file_name, d.parse_status, d.uploaded_at,
            (SELECT COUNT(*) FROM documents earlier
             WHERE earlier.owner_id = d.owner_id AND earlier.deleted_at IS NULL
               AND (earlier.uploaded_at < d.uploaded_at OR (earlier.uploaded_at = d.uploaded_at AND earlier.document_id <= d.document_id))) AS local_document_no
     FROM documents d WHERE ${conditions.join(" AND ")}
     ORDER BY d.uploaded_at DESC, d.document_id DESC LIMIT 100`,
    params,
  ).catch(() => []);
  if (!rows.length) return "没有找到符合范围的资料。";
  const statusLabel: Record<string, string> = { parsed: "已解析", parsing: "解析中", pending: "等待解析", failed: "解析失败" };
  if (requestedNumber) {
    const row = rows[0];
    return `资料 ${row.local_document_no}《${displayFilename(row.original_file_name)}》：${statusLabel[row.parse_status] ?? row.parse_status}。`;
  }
  return [`共 ${rows.length} 篇资料的解析状态：`, ...rows.map((row: any) => `- ${row.local_document_no}. ${displayFilename(row.original_file_name)}：${statusLabel[row.parse_status] ?? row.parse_status}`)].join("\n");
}

async function toolGetDocumentOverview(userId: string, scope: AgentScope, collector: Collector, args: Record<string, unknown>) {
  const document = await verifyDocument(userId, scope, String(args.documentId ?? args.documentNumber ?? ""));
  if (!document) return "资料不存在、尚未解析完成，或不在当前问答范围内。";
  const documentId = String(document.document_id);
  const state = await getDocumentSummary(documentId, userId).catch(() => null);
  if (!state || state.status !== "ready") {
    await enqueueSummaryIfStale(documentId).catch(() => undefined);
    const refreshed = await getDocumentSummary(documentId, userId).catch(() => null);
    const generation = refreshed?.generationStatus ?? state?.generationStatus;
    if (generation === "failed") return `《${displayFilename(document.original_file_name)}》的全文概要生成失败。目前没有完整概要，不能用正文开头或少量相似片段冒充全书内容。可以让用户稍后重试概要，或把问题收窄后调用 search_chunks 查询具体证据。`;
    return `《${displayFilename(document.original_file_name)}》的全文概要尚未准备好${generation === "pending" || generation === "running" ? "，正在后台整理" : ""}。不要仅根据正文开头或少量检索片段概述整份资料；可以针对用户的具体问题使用 search_chunks。`;
  }

  const sectionCountRows = await query<any>(
    `SELECT COUNT(*) AS total FROM document_summary_section
     WHERE document_id=? AND content_version=(SELECT content_version FROM documents WHERE document_id=?)`,
    [documentId, documentId],
  ).catch(() => []);
  const totalSections = Number(sectionCountRows[0]?.total ?? 0);
  const pageSize = Math.min(8, Math.max(1, Number(args.pageSize) || 5));
  const pageCount = Math.max(1, Math.ceil(totalSections / pageSize));
  const page = Math.min(pageCount, Math.max(1, Number(args.sectionPage) || 1));
  const rows = await query<any>(
    `SELECT s.section_no,s.title,s.summary,s.start_chunk_no,s.end_chunk_no,
            c.chunk_id,c.content,c.page_no,c.section_title
     FROM document_summary_section s
     LEFT JOIN document_chunk c ON c.document_id=s.document_id
       AND c.chunk_no=FLOOR((s.start_chunk_no+s.end_chunk_no)/2)
     WHERE s.document_id=? AND s.content_version=(SELECT content_version FROM documents WHERE document_id=?)
     ORDER BY s.section_no LIMIT ? OFFSET ?`,
    [documentId, documentId, pageSize, (page - 1) * pageSize],
  ).catch(() => []);
  const name = displayFilename(document.original_file_name);
  const lines = [`《${name}》全文概要：\n${state.summary}`];
  if (rows.length) {
    lines.push(`全文分段概要（第 ${page}/${pageCount} 页；${totalSections} 个分段，按资料顺序）：`);
    for (const row of rows) {
      let citation = "";
      if (row.chunk_id) {
        const index = addSource(collector, {
          chunkId: String(row.chunk_id), documentId, documentName: name,
          fileExtension: document.file_extension ?? null,
          snippet: String(row.content ?? row.summary).slice(0, 600), context: String(row.content ?? row.summary),
          pageNo: row.page_no ?? null, sectionTitle: row.section_title ?? row.title ?? null,
          score: 1, method: "fulltext",
        });
        if (index) citation = ` [${index}]`;
      }
      lines.push(`- ${row.title}：${row.summary}${citation}`);
    }
  } else if (state.outline.length) {
    lines.push(`文档结构：${state.outline.join("；")}`);
  }
  if (page < pageCount) lines.push(`后续还有 ${pageCount - page} 页分段概要。若问题需要覆盖更多章节，可继续请求 sectionPage=${page + 1}。`);
  return lines.join("\n\n").slice(0, 12000);
}

async function toolGetDocument(userId: string, scope: AgentScope, collector: Collector, args: Record<string, unknown>) {
  const document = await verifyDocument(userId, scope, String(args.documentId ?? args.documentNumber ?? ""));
  if (!document) return "资料不存在、未解析完成，或不在当前问答范围内。";
  if (args.mode === "summary") return toolGetDocumentOverview(userId, scope, collector, { documentId: String(document.document_id) });
  const name = displayFilename(document.original_file_name);

  // Full text, chunk by chunk (capped), each usable as a citation.
  const chunks = await query<any>(
    "SELECT chunk_id, content, page_no, section_title, document_id FROM document_chunk WHERE document_id = ? ORDER BY chunk_no",
    [document.document_id],
  ).catch(() => []);
  if (!chunks.length) return `《${name}》没有可读的正文。`;
  const lines: string[] = [`《${name}》正文（节选）：`];
  let size = 0;
  for (const chunk of chunks) {
    if (size >= TEXT_READ_BUDGET) break;
    const source: SearchResult = {
      chunkId: String(chunk.chunk_id),
      documentId: String(chunk.document_id),
      documentName: name,
      fileExtension: document.file_extension ?? null,
      snippet: String(chunk.content).slice(0, 600),
      context: String(chunk.content),
      pageNo: chunk.page_no ?? null,
      sectionTitle: chunk.section_title ?? null,
      score: 1,
      method: "fulltext",
    };
    const index = addSource(collector, source);
    lines.push(index ? `[${index}] ${chunk.page_no ? `第 ${chunk.page_no} 页` : "片段"}\n${chunk.content}` : String(chunk.content));
    size += String(chunk.content).length;
  }
  return lines.join("\n\n");
}

async function toolListCollections(userId: string) {
  const rows = await query<any>(
    `SELECT c.collection_id,c.name,c.description,c.is_smart,c.smart_filter,COUNT(cd.document_id) AS document_count
     FROM collection c LEFT JOIN collection_document cd ON cd.collection_id = c.collection_id
     WHERE c.owner_id=? GROUP BY c.collection_id,c.name,c.description,c.is_smart,c.smart_filter ORDER BY c.updated_at DESC LIMIT 100`,
    [userId],
  ).catch(() => []);
  if (!rows.length) return "没有项目。";
  const collections = await Promise.all(rows.map(async (row: any) => {
    const count = row.is_smart
      ? (await documentCatalog(userId, { restricted: false, documentIds: [] }, String(row.collection_id))).length
      : Number(row.document_count);
    return `- ${row.name}（${count} 篇${row.is_smart ? "，智能项目" : ""}）— 项目 ID ${row.collection_id}${row.description ? `；${row.description}` : ""}`;
  }));
  return [`共 ${rows.length} 个项目：`, ...collections].join("\n");
}

/**
 * Agentic retrieval: the model decides which tools to call (possibly several times)
 * before answering, instead of a single fixed top-k retrieval. Falls back to the
 * one-shot pipeline in the caller when it yields nothing.
 */
export async function executeTool(
  userId: string,
  scope: AgentScope,
  collector: Collector,
  call: { name: string; arguments: string },
) {
  let args: Record<string, unknown> = {};
  try { args = JSON.parse(call.arguments || "{}"); } catch { args = {}; }
  if (call.name === "search_chunks") return toolSearchChunks(userId, scope, collector, args);
  if (call.name === "find_documents") return toolFindDocuments(userId, scope, args);
  if (call.name === "list_documents") return toolListDocuments(userId, scope, args);
  if (call.name === "list_tags") return toolListTags(userId, scope);
  if (call.name === "get_document_status") return toolGetDocumentStatus(userId, scope, args);
  if (call.name === "get_document") return toolGetDocument(userId, scope, collector, args);
  if (call.name === "get_document_overview") return toolGetDocumentOverview(userId, scope, collector, args);
  if (call.name === "list_collections") return toolListCollections(userId);
  return `未知工具：${call.name}`;
}
