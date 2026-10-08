import { tool } from "@langchain/core/tools";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { Annotation, START, StateGraph } from "@langchain/langgraph";
import { ToolNode, toolsCondition } from "@langchain/langgraph/prebuilt";
import { z } from "zod/v3";
import { config } from "../../config.js";
import {
  AGENT_SYSTEM,
  addSource,
  executeTool,
  type AgentResult,
  type AgentScope,
  type Collector,
  type StoredHistoryMessage,
} from "../agent.js";
import { getChatModel, toLangChainMessages, textFromMessage } from "./models.js";

interface GraphParams {
  userId: string;
  scope: AgentScope;
  history: StoredHistoryMessage[];
  question: string;
  baselineText?: string;
  baselineSources?: any[];
  timeoutMs?: number;
  onStage?: (message: string) => void;
  onDelta?: (text: string) => void;
  onReset?: () => void;
  onSources?: (sources: any[]) => void;
}

const GraphState = Annotation.Root({
  messages: Annotation<any[]>({ reducer: (left, right) => left.concat(Array.isArray(right) ? right : [right]), default: () => [] }),
});

function stage(name: string) {
  const labels: Record<string, string> = {
    find_documents: "正在查找相关资料…",
    search_chunks: "正在检索资料…",
    list_documents: "正在查看资料目录…",
    list_tags: "正在查看标签…",
    get_document_status: "正在查询资料状态…",
    get_document: "正在阅读资料…",
    get_document_overview: "正在整理全文概要…",
    list_collections: "正在查看项目…",
  };
  return labels[name] ?? "正在处理…";
}

export async function runLangGraphAgent(params: GraphParams): Promise<AgentResult> {
  const stepTimeout = params.timeoutMs ?? config.agent.stepTimeoutMs;
  const withTimeout = <T>(promise: Promise<T>) => new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Agent 步骤超时")), stepTimeout);
    promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
  const collector: Collector = { sources: [], seen: new Set(), blocks: [] };
  const usedTools: string[] = [];
  let hasEvidence = false;
  for (const item of params.baselineSources ?? []) addSource(collector, item);
  if (params.baselineText && collector.sources.length) {
    collector.blocks.push(params.baselineText);
    hasEvidence = true;
  }
  params.onSources?.(collector.sources);

  const call = async (name: string, input: Record<string, unknown>) => {
    usedTools.push(name);
    params.onStage?.(stage(name));
    const output = await withTimeout(executeTool(params.userId, params.scope, collector, { name, arguments: JSON.stringify(input) }));
    if (output && !output.startsWith("工具执行失败")) hasEvidence = true;
    collector.blocks.push(output);
    params.onSources?.(collector.sources);
    return output;
  };

  const tools = [
    tool((input) => call("find_documents", input), {
      name: "find_documents",
      description: "Find document candidates by title, near spelling, tags and an existing document overview. Use when the user names a book or file, including an approximate or misspelled title. If multiple candidates are plausible, ask the user to choose.",
      schema: z.object({ query: z.string().describe("Document name, book title, alias, or description"), collectionId: z.string().optional() }),
    }),
    tool((input) => call("list_documents", input), {
      name: "list_documents",
      description: "List documents in the current accessible scope or a specified project. Filter by tag, status, file type or title; paginate through results when the user asks for a complete list.",
      schema: z.object({ collectionId: z.string().optional(), tagId: z.string().optional(), type: z.enum(["PDF", "Word", "Markdown", "HTML", "CSV", "TXT"]).optional(), status: z.enum(["pending", "parsing", "parsed", "failed"]).optional(), query: z.string().optional(), page: z.number().int().min(1).optional(), pageSize: z.number().int().min(1).max(50).optional() }),
    }),
    tool(() => call("list_tags", {}), {
      name: "list_tags",
      description: "List tags in the current accessible scope and the number of associated documents.",
      schema: z.object({}),
    }),
    tool((input) => call("get_document_status", input), {
      name: "get_document_status",
      description: "查询资料解析状态。",
      schema: z.object({ documentNumber: z.string().optional() }),
    }),
    tool((input) => call("get_document", input), {
      name: "get_document",
      description: "Read a bounded excerpt of a document's original text for specific factual questions. Use get_document_overview for whole-document questions.",
      schema: z.object({ documentId: z.string(), mode: z.enum(["summary", "text"]).optional() }),
    }),
    tool((input) => call("get_document_overview", input), {
      name: "get_document_overview",
      description: "Get a full-coverage hierarchical overview and ordered section summaries mapped to source passages. Use for whole-document summaries, book introductions, themes, or structure. If the overview is not ready, do not substitute the beginning of the text for a full overview.",
      schema: z.object({ documentId: z.string().optional(), documentNumber: z.string().optional(), sectionPage: z.number().int().min(1).optional(), pageSize: z.number().int().min(1).max(8).optional() }),
    }),
    tool((input) => call("search_chunks", input), {
      name: "search_chunks",
      description: "Search original passages for concrete evidence. Optionally restrict to candidate document IDs returned by find_documents. Use to verify claims from an overview and provide citations.",
      schema: z.object({ query: z.string().describe("Search keywords or question"), documentIds: z.array(z.string()).max(50).optional() }),
    }),
    tool(() => call("list_collections", {}), {
      name: "list_collections",
      description: "列出用户创建的项目。",
      schema: z.object({}),
    }),
  ];

  const model = getChatModel(config.agent.model || config.ai.chatModel).bindTools(tools);
  const agentNode = async (state: typeof GraphState.State) => ({ messages: [await withTimeout(model.invoke(state.messages))] });
  const graph = new StateGraph(GraphState)
    .addNode("agent", agentNode)
    .addNode("tools", new ToolNode(tools))
    .addEdge(START, "agent")
    .addConditionalEdges("agent", toolsCondition)
    .addEdge("tools", "agent")
    .compile();

  const initial: any[] = [
    ...toLangChainMessages([{ role: "system", content: AGENT_SYSTEM }]),
    ...toLangChainMessages(params.history.map((message) => ({ role: message.role, content: message.content }))),
    new HumanMessage(params.question),
  ];
  if (params.baselineText && collector.sources.length) {
    initial.splice(1, 0, ...toLangChainMessages([{ role: "system", content: `以下是自动检索到的相关资料，可直接用于回答：\n\n${params.baselineText}` }]));
  }

  let answerText = "";
  const emitted = new Set<string>();
  let sawModelStream = false;
  // streamEvents is LangGraph's astreamEvents equivalent.  We map chain
  // updates back into Folio's existing onDelta callback, so SSE consumers do
  // not need to know how the graph is orchestrated.
  const stream = await (graph as any).streamEvents({ messages: initial }, {
    recursionLimit: Math.max(3, config.agent.maxSteps * 2 + 1),
    version: "v2",
  });
  for await (const event of stream as any) {
    if (event?.event === "on_chat_model_stream") {
      const text = textFromMessage(event.data?.chunk);
      if (text) {
        sawModelStream = true;
        answerText += text;
        params.onDelta?.(text);
      }
      continue;
    }
    if (event?.event === "on_chat_model_end" && (event.data?.output?.tool_calls?.length ?? 0) > 0) {
      if (answerText.trim()) params.onReset?.();
      answerText = "";
      continue;
    }
    const state = event?.event === "on_chain_stream"
      ? event.data?.chunk
      : null;
    if (sawModelStream) continue;
    const messages = state instanceof AIMessage ? [state] : state?.messages ?? [];
    messages.forEach((message: any, index: number) => {
      if (!(message instanceof AIMessage) || (message.tool_calls?.length ?? 0) > 0) return;
      const text = textFromMessage(message);
      const key = `${message.id ?? ""}:${index}:${text}`;
      if (!text || emitted.has(key)) return;
      emitted.add(key);
      answerText += text;
      params.onDelta?.(text);
    });
  }

  return {
    sources: collector.sources,
    evidenceText: collector.blocks.filter(Boolean).join("\n\n").slice(0, 14000),
    hasEvidence,
    usedTools,
    answered: answerText.trim().length > 0,
    answerText: answerText.trim(),
  };
}
