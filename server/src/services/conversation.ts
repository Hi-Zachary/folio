import { config } from "../config.js";
import { query } from "../db.js";
import { chatCompletion, type ChatInput } from "./ai.js";

export interface StoredMessage {
  messageId: string;
  role: "user" | "assistant";
  content: string;
}

export async function getSessionMemory(sessionId: string) {
  const rows = await query<any>(
    "SELECT summary, summarized_until_message_id FROM chat_session WHERE session_id = ? LIMIT 1",
    [sessionId],
  );
  const row = rows[0];
  return {
    summary: (row?.summary as string | null) ?? null,
    until: row?.summarized_until_message_id === null || row?.summarized_until_message_id === undefined
      ? null
      : String(row.summarized_until_message_id),
  };
}

/** Messages not yet folded into the summary, capped from the newest side by a char budget. */
export async function getRecentHistory(sessionId: string, until: string | null, beforeMessageId?: string): Promise<StoredMessage[]> {
  const filters: string[] = ["session_id = ?", "role IN ('user', 'assistant')"];
  const params: unknown[] = [sessionId];
  if (until) {
    filters.push("message_id > ?");
    params.push(until);
  }
  if (beforeMessageId) {
    filters.push("message_id < ?");
    params.push(beforeMessageId);
  }
  const rows = await query<any>(
    `SELECT message_id, role, content FROM chat_message
     WHERE ${filters.join(" AND ")}
     ORDER BY message_id`,
    params,
  ).catch(() => []);

  const kept: StoredMessage[] = [];
  let chars = 0;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    const content = String(row.content ?? "");
    if (kept.length && chars + content.length > config.conversation.maxChars) break;
    chars += content.length;
    kept.unshift({ messageId: String(row.message_id), role: row.role, content });
  }
  return kept;
}

function historyText(history: StoredMessage[], max = 2000) {
  return history
    .map((message) => `${message.role === "user" ? "用户" : "助手"}：${message.content.slice(0, 400)}`)
    .join("\n")
    .slice(-max);
}

/** Rewrite the latest question into a standalone retrieval query using the history. */
export async function rewriteQuery(history: StoredMessage[], question: string): Promise<string> {
  const model = config.ai.utilityModel;
  if (!config.conversation.rewriteEnabled || !history.length || !config.ai.baseUrl || !model) {
    return question;
  }
  const raw = await chatCompletion([
    {
      role: "system",
      content: "你是检索查询改写助手。结合对话历史，把用户的最新问题改写成一句不依赖上下文、可独立检索的查询。补全指代与省略的条件，保留关键实体，不要回答问题，不要解释，只输出改写后的查询。",
    },
    { role: "user", content: `对话历史：\n${historyText(history)}\n\n最新问题：${question}` },
  ], model).catch(() => null);
  const rewritten = raw?.split("\n").map((line) => line.trim()).filter(Boolean)[0]?.replace(/^["'“”]|["'“”]$/g, "");
  return rewritten && rewritten.length <= 200 ? rewritten : question;
}

export function buildAnswerMessages(
  summary: string | null,
  history: StoredMessage[],
  question: string,
  context: string,
): ChatInput[] {
  const messages: ChatInput[] = [
    { role: "system", content: "你是个人知识库问答助手。优先根据提供的资料回答；资料不足时明确说明。回答简洁、有条理，保留关键条件，并可以使用 Markdown 排版。当依据某条资料作答时，在相应句子末尾用方括号标注来源编号，例如 [1]、[2]。" },
  ];
  if (summary) messages.push({ role: "system", content: `以下是本次对话较早内容的摘要，可作为上下文参考：\n${summary}` });
  for (const message of history) messages.push({ role: message.role, content: message.content });
  messages.push({
    role: "user",
    content: context
      ? `问题：${question}\n\n资料：\n${context}`
      : `问题：${question}\n\n（知识库中没有检索到相关资料，请直接说明资料不足，不要编造。）`,
  });
  return messages;
}

/**
 * Used when retrieval found nothing: answer from the model's general knowledge
 * instead of refusing. No disclaimer is needed — a material-based answer would
 * have carried citations, so their absence already signals this.
 */
export function buildGeneralAnswerMessages(
  summary: string | null,
  history: StoredMessage[],
  question: string,
): ChatInput[] {
  const messages: ChatInput[] = [
    { role: "system", content: "你是知识库问答助手。知识库中没有检索到与本问题直接相关的资料。可以使用通用知识回答，但必须在开头明确说明“以下内容基于通用知识，不是来自你的资料库”。不要把通用知识伪装成资料库内容。回答简洁、有条理，可以使用 Markdown。" },
  ];
  if (summary) messages.push({ role: "system", content: `以下是本次对话较早内容的摘要，可作为上下文参考：\n${summary}` });
  for (const message of history) messages.push({ role: message.role, content: message.content });
  messages.push({ role: "user", content: question });
  return messages;
}

/**
 * Fold older turns into a rolling summary once the unsummarised history grows
 * past the trigger. The most recent `recentMessages` stay verbatim.
 */
export async function summarizeIfNeeded(sessionId: string): Promise<void> {
  const model = config.ai.utilityModel;
  if (!config.ai.baseUrl || !model) return;
  const { summary, until } = await getSessionMemory(sessionId);
  const rows = await query<any>(
    `SELECT message_id, role, content FROM chat_message
     WHERE session_id = ? AND role IN ('user', 'assistant') ${until ? "AND message_id > ?" : ""}
     ORDER BY message_id`,
    until ? [sessionId, until] : [sessionId],
  ).catch(() => []);

  if (rows.length <= config.conversation.summaryTriggerMessages) return;
  const fold = rows.slice(0, rows.length - config.conversation.recentMessages);
  if (!fold.length) return;

  const text = fold
    .map((row: any) => `${row.role === "user" ? "用户" : "助手"}：${String(row.content).slice(0, 600)}`)
    .join("\n");
  const raw = await chatCompletion([
    {
      role: "system",
      content: `你是对话摘要助手。把下面的对话压缩成一段不超过 ${config.conversation.summaryMaxChars} 字的摘要，保留关键事实、结论、用户意图和尚未解决的问题，不要遗漏重要限定条件。只输出摘要正文。`,
    },
    { role: "user", content: `${summary ? `已有摘要：\n${summary}\n\n` : ""}新增对话：\n${text}` },
  ], model).catch(() => null);

  const next = raw?.trim();
  if (!next) return;
  await query(
    "UPDATE chat_session SET summary = ?, summarized_until_message_id = ? WHERE session_id = ?",
    [next.slice(0, config.conversation.summaryMaxChars), fold[fold.length - 1].message_id, sessionId],
  );
}
