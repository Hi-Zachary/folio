import { AIMessage, HumanMessage, SystemMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import { ChatOpenAI, OpenAIEmbeddings } from "@langchain/openai";
import { config } from "../../config.js";

/**
 * LangChain's OpenAI adapters speak the same OpenAI-compatible endpoints that
 * Folio already used.  Keeping construction here makes the rest of the app
 * independent from provider specific constructor changes.
 */
function reasoningField() {
  const effort = (config.ai.reasoningEffort ?? "").toLowerCase();
  if (!effort) return {};
  if (["off", "none", "false"].includes(effort)) return { reasoning: { enabled: false } };
  if (["low", "medium", "high"].includes(effort)) return { reasoning: { effort } };
  return {};
}

export function getChatModel(model = config.ai.chatModel) {
  return new ChatOpenAI({
    model,
    apiKey: config.ai.apiKey || "local",
    temperature: 0.2,
    timeout: config.ai.timeoutMs,
    maxRetries: config.ai.maxRetries,
    configuration: {
      baseURL: config.ai.baseUrl || undefined,
      defaultHeaders: config.ai.baseUrl?.includes("openrouter.ai")
        ? { "HTTP-Referer": config.origin, "X-Title": "Folio" }
        : undefined,
    },
    modelKwargs: reasoningField(),
  });
}

export function getEmbeddingModel() {
  return new OpenAIEmbeddings({
    model: config.ai.embeddingModel,
    apiKey: config.ai.embeddingApiKey || "local",
    timeout: config.ai.timeoutMs,
    batchSize: 128,
    configuration: { baseURL: config.ai.embeddingBaseUrl || undefined },
  });
}

function messageContent(value: unknown) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map((part) => typeof part === "string" ? part : String((part as any)?.text ?? "")).join("");
  }
  return value == null ? "" : String(value);
}

export function toLangChainMessages(messages: unknown[]): BaseMessage[] {
  return messages.map((raw: any) => {
    const content = messageContent(raw?.content);
    if (raw?.role === "system") return new SystemMessage(content);
    if (raw?.role === "tool") return new ToolMessage({ content, tool_call_id: String(raw.tool_call_id ?? "") });
    if (raw?.role === "assistant") {
      return new AIMessage({
        content,
        tool_calls: Array.isArray(raw.tool_calls)
          ? raw.tool_calls.map((call: any) => ({
              id: String(call.id ?? ""),
              name: String(call.function?.name ?? call.name ?? ""),
              args: typeof call.function?.arguments === "string"
                ? safeJson(call.function.arguments)
                : call.function?.arguments ?? call.args ?? {},
            }))
          : undefined,
      });
    }
    return new HumanMessage(content);
  });
}

function safeJson(value: string) {
  try { return JSON.parse(value); } catch { return {}; }
}

export function textFromMessage(message: any) {
  return messageContent(message?.content).trim();
}

export async function lcChatCompletion(messages: unknown[], model = config.ai.chatModel) {
  if (!config.ai.baseUrl || !model) return null;
  const response = await getChatModel(model).invoke(toLangChainMessages(messages));
  return textFromMessage(response);
}

export async function* lcChatCompletionStream(messages: unknown[], model = config.ai.chatModel) {
  if (!config.ai.baseUrl || !model) return;
  for await (const chunk of await getChatModel(model).stream(toLangChainMessages(messages))) {
    const text = messageContent((chunk as any).content);
    if (text) yield text;
  }
}

export async function lcEmbedTexts(input: string[]) {
  if (!config.ai.embeddingBaseUrl || !config.ai.embeddingModel) return null;
  return getEmbeddingModel().embedDocuments(input);
}
