import { config } from "../config.js";
import { query } from "../db.js";
import { chatStreamWithTools, type ToolDefinition } from "./ai.js";
import { displayFilename } from "./filename.js";
import { searchKnowledge, type SearchResult } from "./search.js";
import { rerankResults } from "./rerank.js";
import { getFreshSummaryText } from "./summary.js";

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

const MAX_SOURCES = 8;
const EVIDENCE_LIMIT = 14000;
const TEXT_READ_BUDGET = 6000;

const TOOLS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "search_chunks",
      description: "在用户的知识库（或当前问答范围）中检索与问题最相关的资料片段。适合回答具体事实、概念、细节类问题。",
      parameters: { type: "object", properties: { query: { type: "string", description: "检索用的关键词或问句" } }, required: ["query"] },
    },
  },
  {
    type: "function",
    function: {
      name: "list_documents",
      description: "列出用户知识库（或当前范围）的资料编号、名称和标签。默认不包含处理状态；用户明确询问解析或索引状态时再列出状态。",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "get_document_status",
      description: "查询资料的解析状态。仅用于回答用户关于资料是否解析完成、哪些资料解析失败或仍在处理的问题；documentNumber 可选，不传时列出当前范围内所有资料的状态。",
      parameters: {
        type: "object",
        properties: { documentNumber: { type: "string", description: "用户资料编号；省略时查询当前范围内全部资料" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_document",
      description: "读取指定资料的摘要或正文。总结、通读、比较某篇资料时使用；正文较长时会分段返回。",
      parameters: {
        type: "object",
        properties: {
          documentId: { type: "string", description: "用户资料编号（来自 list_documents 的编号）" },
          mode: { type: "string", enum: ["summary", "text"], description: "summary 读取摘要，text 读取正文" },
        },
        required: ["documentId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_collections",
      description: "列出用户创建的项目（每个项目包含多少篇资料）。",
      parameters: { type: "object", properties: {} },
    },
  },
];

const AGENT_SYSTEM = [
  "你是个人知识库助手。系统会先自动检索一批相关资料放在对话里。",
  "你的任务：",
  "1. 如果已有资料足以回答，直接作答，不要再调用工具。",
  "2. 如果资料不足，可调用工具补充：search_chunks（继续检索）、list_documents（资料目录）、get_document（读取某篇的摘要或正文）、get_document_status（解析状态）、list_collections（项目列表）。",
  "规则：",
  "1. 只能依据对话中提供的资料回答，不要编造资料中不存在的信息；确实没有就说“资料中没有相关内容”。",
  "2. 只有资料中标有 [N] 时才使用引用；没有编号时不要添加引用。",
  "3. 直接给出结论。禁止提及工具名称、调用过程或“我需要先查看…”这类过程描述。",
  "4. 列出资料目录时不要根据文件名推测资料内容。",
  "5. 回答使用中文，简洁、有条理，可以使用 Markdown。",
].join("\n");

interface Collector {
  sources: SearchResult[];
  seen: Set<string>;
  blocks: string[];
}

function addSource(collector: Collector, item: SearchResult) {
  if (collector.sources.length >= MAX_SOURCES) return null;
  const key = `${item.documentId}:${item.chunkId}`;
  if (collector.seen.has(key)) return null;
  collector.seen.add(key);
  collector.sources.push(item);
  return collector.sources.length;
}

async function verifyDocument(userId: string, scope: AgentScope, documentNumber: string) {
  const number = Number(documentNumber);
  if (!Number.isSafeInteger(number) || number < 1) return null;
  const rows = await query<any>(
    `SELECT d.document_id, d.original_file_name, d.file_extension,
            (SELECT MIN(chunk_id) FROM document_chunk c WHERE c.document_id = d.document_id) AS first_chunk
     FROM documents d
     WHERE d.owner_id = ? AND d.deleted_at IS NULL AND d.parse_status = 'parsed'
       AND (SELECT COUNT(*) FROM documents earlier
            WHERE earlier.owner_id = d.owner_id AND earlier.deleted_at IS NULL
              AND (earlier.uploaded_at < d.uploaded_at OR (earlier.uploaded_at = d.uploaded_at AND earlier.document_id <= d.document_id))) = ?`,
    [userId, number],
  ).catch(() => []);
  if (rows[0] && scope.restricted && !scope.documentIds.includes(String(rows[0].document_id))) return null;
  return rows[0] ?? null;
}

async function toolSearchChunks(userId: string, scope: AgentScope, collector: Collector, args: Record<string, unknown>) {
  const searchQuery = String(args.query ?? "").trim();
  if (!searchQuery) return "缺少 query 参数。";
  const found = await searchKnowledge(userId, searchQuery, { documentIds: scope.restricted ? scope.documentIds : undefined });
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

async function toolListDocuments(userId: string, scope: AgentScope) {
  const conditions = ["d.owner_id = ?", "d.deleted_at IS NULL"];
  const params: unknown[] = [userId];
  if (scope.restricted) {
    if (!scope.documentIds.length) return "当前范围没有资料。";
    conditions.push(`d.document_id IN (${scope.documentIds.map(() => "?").join(", ")})`);
    params.push(...scope.documentIds);
  }
  const rows = await query<any>(
    `SELECT d.document_id, d.original_file_name, d.parse_status, d.uploaded_at,
            (SELECT COUNT(*) FROM documents earlier WHERE earlier.owner_id = d.owner_id AND earlier.deleted_at IS NULL
              AND (earlier.uploaded_at < d.uploaded_at OR (earlier.uploaded_at = d.uploaded_at AND earlier.document_id <= d.document_id))) AS local_document_no,
            (SELECT GROUP_CONCAT(t.name ORDER BY t.name) FROM document_tag dt
             INNER JOIN tag t ON t.tag_id = dt.tag_id WHERE dt.document_id = d.document_id) AS tags
     FROM documents d WHERE ${conditions.join(" AND ")}
     ORDER BY d.uploaded_at DESC, d.document_id DESC LIMIT 100`,
    params,
  ).catch(() => []);
  if (!rows.length) return "没有资料。";
  const lines = [`共 ${rows.length} 篇资料：`];
  for (const row of rows) {
    const tags = row.tags ? ` [${row.tags}]` : "";
    lines.push(`- ${row.local_document_no}. ${displayFilename(row.original_file_name)}${tags}`);
  }
  return lines.join("\n");
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

async function toolGetDocument(userId: string, scope: AgentScope, collector: Collector, args: Record<string, unknown>) {
  const document = await verifyDocument(userId, scope, String(args.documentId ?? ""));
  if (!document) return "资料不存在、未解析完成，或不在当前问答范围内。";
  const mode = args.mode === "summary" ? "summary" : "text";
  const name = displayFilename(document.original_file_name);

  if (mode === "summary") {
    const summary = await getFreshSummaryText(String(document.document_id), userId).catch(() => null);
    if (summary) {
      const first = await query<any>(
        "SELECT chunk_id, content, page_no, section_title, document_id FROM document_chunk WHERE document_id = ? ORDER BY chunk_no LIMIT 1",
        [document.document_id],
      ).catch(() => []);
      let sourcePrefix = "";
      if (first.length) {
        const chunk = first[0];
        const source: SearchResult = {
          chunkId: String(chunk.chunk_id), documentId: String(chunk.document_id), documentName: name,
          fileExtension: document.file_extension ?? null, snippet: `文档摘要：${summary.slice(0, 600)}`,
          context: String(chunk.content), pageNo: chunk.page_no ?? null, sectionTitle: chunk.section_title ?? null,
          score: 1, method: "fulltext",
        };
        const index = addSource(collector, source);
        if (index) sourcePrefix = `[${index}] `;
      }
      return `${sourcePrefix}《${name}》的摘要：\n${summary}`;
    }
    // Never block an interactive answer on on-demand map/reduce summarisation.
    // A short beginning-of-document excerpt is immediately available and is
    // enough for “分别讲什么” questions; the user can generate the full
    // cached summary from the document viewer separately.
    const preview = await query<any>(
      "SELECT chunk_id, content, page_no, section_title, document_id FROM document_chunk WHERE document_id = ? ORDER BY chunk_no LIMIT 3",
      [document.document_id],
    ).catch(() => []);
    if (!preview.length) return `《${name}》暂时没有可用摘要。`;
    const lines = [`《${name}》尚未生成摘要，以下是正文开头：`];
    for (const chunk of preview) {
      const source: SearchResult = {
        chunkId: String(chunk.chunk_id), documentId: String(chunk.document_id), documentName: name,
        fileExtension: document.file_extension ?? null, snippet: String(chunk.content).slice(0, 600),
        context: String(chunk.content), pageNo: chunk.page_no ?? null, sectionTitle: chunk.section_title ?? null,
        score: 1, method: "fulltext",
      };
      const index = addSource(collector, source);
      lines.push(`${index ? `[${index}] ` : ""}${String(chunk.content).slice(0, 1800)}`);
    }
    return lines.join("\n\n");
  }

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
    `SELECT c.collection_id, c.name, COUNT(cd.document_id) AS document_count
     FROM collection c LEFT JOIN collection_document cd ON cd.collection_id = c.collection_id
     WHERE c.owner_id = ? GROUP BY c.collection_id, c.name ORDER BY c.updated_at DESC LIMIT 50`,
    [userId],
  ).catch(() => []);
  if (!rows.length) return "没有项目。";
      return `共 ${rows.length} 个项目：\n${rows.map((row: any) => `- ${row.name}（${Number(row.document_count)} 篇）— ID ${row.collection_id}`).join("\n")}`;
}

function friendlyStage(name: string) {
  switch (name) {
    case "search_chunks": return "正在检索资料…";
    case "list_documents": return "正在查看资料目录…";
    case "get_document_status": return "正在查询资料状态…";
    case "get_document": return "正在阅读资料…";
    case "list_collections": return "正在查看项目…";
    default: return "正在处理…";
  }
}

/**
 * Agentic retrieval: the model decides which tools to call (possibly several times)
 * before answering, instead of a single fixed top-k retrieval. Falls back to the
 * one-shot pipeline in the caller when it yields nothing.
 */
async function executeTool(
  userId: string,
  scope: AgentScope,
  collector: Collector,
  call: { name: string; arguments: string },
) {
  let args: Record<string, unknown> = {};
  try { args = JSON.parse(call.arguments || "{}"); } catch { args = {}; }
  if (call.name === "search_chunks") return toolSearchChunks(userId, scope, collector, args);
  if (call.name === "list_documents") return toolListDocuments(userId, scope);
  if (call.name === "get_document_status") return toolGetDocumentStatus(userId, scope, args);
  if (call.name === "get_document") return toolGetDocument(userId, scope, collector, args);
  if (call.name === "list_collections") return toolListCollections(userId);
  return `未知工具：${call.name}`;
}

export async function runAgent(params: {
  userId: string;
  scope: AgentScope;
  history: StoredHistoryMessage[];
  question: string;
  baselineText?: string;
  baselineSources?: SearchResult[];
  timeoutMs?: number;
  onStage?: (message: string) => void;
  onDelta?: (text: string) => void;
  onReset?: () => void;
  onSources?: (sources: SearchResult[]) => void;
}): Promise<AgentResult> {
  const { userId, scope, history, question, onStage, onDelta, onReset, onSources } = params;
  const collector: Collector = { sources: [], seen: new Set(), blocks: [] };
  const usedTools: string[] = [];
  let produced = false;

  const messages: any[] = [
    { role: "system", content: AGENT_SYSTEM },
    ...history.map((message) => ({ role: message.role, content: message.content })),
    { role: "user", content: question },
  ];

  // Seed with the caller's one-shot retrieval (which also handles scoped
  // summarise/compare via document summaries), so grounding does not depend on
  // the model remembering to call search_chunks.
  for (const item of params.baselineSources ?? []) addSource(collector, item);
  if (params.baselineText && collector.sources.length) {
    messages.push({ role: "system", content: `以下是自动检索到的相关资料，可直接用于回答：\n\n${params.baselineText}` });
    collector.blocks.push(params.baselineText);
    produced = true;
  }
  onSources?.(collector.sources);

  const agentModel = config.agent.model || config.ai.chatModel;
  const stepTimeout = params.timeoutMs ?? config.agent.stepTimeoutMs;

  for (let step = 0; step < config.agent.maxSteps; step += 1) {
    let content = "";
    let toolCalls: Array<{ id: string; name: string; arguments: string }> = [];
    try {
      for await (const event of chatStreamWithTools(messages, TOOLS, agentModel, stepTimeout)) {
        if (event.content) { content += event.content; onDelta?.(event.content); }
        if (event.done) toolCalls = event.done.toolCalls;
      }
    } catch (error) {
      // Partial answer may already have been streamed; tell the client to clear it.
      if (content.trim()) onReset?.();
      console.warn(`[agent] model call failed: ${error instanceof Error ? error.message : String(error)}`);
      break;
    }

    if (!toolCalls.length) {
      // The agent answered directly; its text has already been streamed.
      return {
        sources: collector.sources,
        evidenceText: collector.blocks.filter(Boolean).join("\n\n").slice(0, EVIDENCE_LIMIT),
        hasEvidence: produced,
        usedTools,
        answered: content.trim().length > 0,
        answerText: content.trim(),
      };
    }

    // Text streamed before a tool call is not the answer; clear it on the client.
    if (content.trim()) onReset?.();

    messages.push({
      role: "assistant",
      content: content || null,
      tool_calls: toolCalls.map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: call.arguments } })),
    });

    // Independent tool calls run in parallel.
    const outputs = await Promise.all(toolCalls.map(async (call) => {
      usedTools.push(call.name);
      onStage?.(friendlyStage(call.name));
      try {
        return { call, output: await executeTool(userId, scope, collector, call) };
      } catch (error) {
        return { call, output: `工具执行失败：${error instanceof Error ? error.message : String(error)}` };
      }
    }));

    for (const { call, output } of outputs) {
      if (output && !output.startsWith("工具执行失败")) produced = true;
      collector.blocks.push(output);
      messages.push({ role: "tool", tool_call_id: call.id, content: output });
    }
    // Let the caller show sources as soon as they are known (before the answer streams).
    onSources?.(collector.sources);
  }

  return {
    sources: collector.sources,
    evidenceText: collector.blocks.filter(Boolean).join("\n\n").slice(0, EVIDENCE_LIMIT),
    hasEvidence: produced,
    usedTools,
    answered: false,
    answerText: "",
  };
}
