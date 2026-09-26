import { config } from "../config.js";

export interface ChatInput {
  role: "system" | "user" | "assistant";
  content: string;
}

function enabled(model: string) {
  return Boolean(config.ai.baseUrl && model);
}

/**
 * OpenRouter's reasoning controls. Returning an empty object keeps the field out
 * of the request for gateways/models that reject it.
 */
function reasoningField() {
  const effort = (config.ai.reasoningEffort ?? "").toLowerCase();
  if (!effort) return {};
  if (effort === "off" || effort === "none" || effort === "false") return { reasoning: { enabled: false } };
  if (effort === "low" || effort === "medium" || effort === "high") return { reasoning: { effort } };
  return {};
}

function headers(baseUrl: string, apiKey: string) {
  return {
    "Content-Type": "application/json",
    ...(baseUrl.includes("openrouter.ai") ? {
      "HTTP-Referer": config.origin,
      "X-Title": "Folio",
    } : {}),
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
  };
}

async function postJson(baseUrl: string, apiKey: string, path: string, body: unknown) {
  let lastError: unknown;
  for (let attempt = 0; attempt <= config.ai.maxRetries; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}${path}`, {
        method: "POST",
        headers: headers(baseUrl, apiKey),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(config.ai.timeoutMs),
      });

      const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      if (!response.ok) {
        throw new Error(`AI 服务请求失败 (${response.status}): ${JSON.stringify(payload)}`);
      }
      return payload;
    } catch (error) {
      lastError = error;
      if (attempt < config.ai.maxRetries) {
        await new Promise((resolve) => setTimeout(resolve, 800 * (attempt + 1)));
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export function isChatConfigured() {
  return enabled(config.ai.chatModel);
}

export function isEmbeddingConfigured() {
  return Boolean(config.ai.embeddingBaseUrl && config.ai.embeddingModel);
}

export async function chatCompletion(messages: ChatInput[], model = config.ai.chatModel) {
  if (!enabled(model)) return null;
  const payload = await postJson(config.ai.baseUrl, config.ai.apiKey, "/chat/completions", {
    model,
    messages,
    temperature: 0.2,
    ...reasoningField(),
  });
  const choices = payload.choices as Array<{ message?: { content?: string }}> | undefined;
  return choices?.[0]?.message?.content?.trim() ?? "";
}

/**
 * Streams assistant text deltas from an OpenAI-compatible `/chat/completions`
 * endpoint. Throws on transport errors; callers fall back to a non-streamed call.
 */
export interface ToolDefinition {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface AgentTurnStream {
  content?: string;
  done?: { content: string; toolCalls: ToolCall[] };
}

/**
 * Streams one assistant turn that may contain tool calls. Content deltas are
 * surfaced immediately so the final answer can be streamed without a second
 * model call; tool calls are accumulated and returned at the end.
 */
export async function* chatStreamWithTools(
  messages: unknown[],
  tools: ToolDefinition[],
  model = config.ai.chatModel,
  timeoutMs = config.ai.timeoutMs,
): AsyncGenerator<AgentTurnStream> {
  if (!enabled(model)) return;
  const response = await fetch(`${config.ai.baseUrl}/chat/completions`, {
    method: "POST",
    headers: headers(config.ai.baseUrl, config.ai.apiKey),
    body: JSON.stringify({ model, messages, tools, tool_choice: "auto", temperature: 0.2, stream: true, ...reasoningField() }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok || !response.body) {
    const detail = await response.text().catch(() => "");
    throw new Error(`AI 流式请求失败 (${response.status}): ${detail.slice(0, 300)}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const pending = new Map<number, { id: string; name: string; args: string }>();
  let buffer = "";
  let content = "";

  const handleFrame = (data: string): AgentTurnStream | null => {
    if (data === "[DONE]") return null;
    try {
      const parsed = JSON.parse(data) as any;
      if (parsed.error) throw new Error(`AI 流式返回错误：${JSON.stringify(parsed.error).slice(0, 200)}`);
      const delta = parsed.choices?.[0]?.delta ?? {};
      if (Array.isArray(delta.tool_calls)) {
        for (const call of delta.tool_calls) {
          const index = Number(call.index ?? 0);
          const acc = pending.get(index) ?? { id: "", name: "", args: "" };
          if (call.id) acc.id = String(call.id);
          if (call.function?.name) acc.name += String(call.function.name);
          if (call.function?.arguments) acc.args += String(call.function.arguments);
          pending.set(index, acc);
        }
      }
      if (typeof delta.content === "string" && delta.content) {
        content += delta.content;
        return { content: delta.content };
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("AI 流式返回错误")) throw error;
    }
    return null;
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index = buffer.indexOf("\n");
    while (index >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf("\n");
      if (!line || line.startsWith(":") || !line.startsWith("data:")) continue;
      const event = handleFrame(line.slice(5).trim());
      if (event?.content) yield event;
    }
  }

  const toolCalls: ToolCall[] = [...pending.values()]
    .filter((call) => call.name)
    .map((call) => ({ id: call.id, name: call.name, arguments: call.args || "{}" }));
  yield { done: { content, toolCalls } };
}

/**
 * One turn of a tool-calling conversation (non-streaming).
 */
export async function chatWithTools(
  messages: unknown[],
  tools: ToolDefinition[],
  model = config.ai.chatModel,
): Promise<{ content: string; toolCalls: ToolCall[] } | null> {
  if (!enabled(model)) return null;
  const payload = await postJson(config.ai.baseUrl, config.ai.apiKey, "/chat/completions", {
    model,
    messages,
    tools,
    tool_choice: "auto",
    temperature: 0.2,
    ...reasoningField(),
  });
  const choice = (payload.choices as any[] | undefined)?.[0];
  const message = choice?.message ?? {};
  const toolCalls: ToolCall[] = Array.isArray(message.tool_calls)
    ? message.tool_calls.map((call: any) => ({
        id: String(call.id ?? ""),
        name: String(call.function?.name ?? ""),
        arguments: String(call.function?.arguments ?? "{}"),
      })).filter((call: ToolCall) => call.name)
    : [];
  return { content: typeof message.content === "string" ? message.content : "", toolCalls };
}

export async function* chatCompletionStream(messages: ChatInput[], model = config.ai.chatModel): AsyncGenerator<string> {
  if (!enabled(model)) return;
  const response = await fetch(`${config.ai.baseUrl}/chat/completions`, {
    method: "POST",
    headers: headers(config.ai.baseUrl, config.ai.apiKey),
    body: JSON.stringify({ model, messages, temperature: 0.2, stream: true, ...reasoningField() }),
    signal: AbortSignal.timeout(config.ai.timeoutMs),
  });
  if (!response.ok || !response.body) {
    const detail = await response.text().catch(() => "");
    throw new Error(`AI 流式请求失败 (${response.status}): ${detail.slice(0, 300)}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let produced = false;
  let sawDone = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index = buffer.indexOf("\n");
    while (index >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf("\n");
      if (!line || line.startsWith(":")) continue;
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") { sawDone = true; return; }
      try {
        const parsed = JSON.parse(data) as {
          choices?: Array<{ delta?: { content?: string } }>;
          error?: unknown;
        };
        // Providers can return HTTP 200 and then an error frame mid-stream; surface
        // it instead of silently finishing with no content.
        if (parsed.error) throw new Error(`AI 流式返回错误：${JSON.stringify(parsed.error).slice(0, 200)}`);
        const delta = parsed.choices?.[0]?.delta?.content;
        if (delta) { produced = true; yield delta; }
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("AI 流式返回错误")) throw error;
        // Ignore keep-alive or partial frames; the next read continues the stream.
      }
    }
  }
  if (!produced) console.warn(`[ai] stream finished with no content (sawDone=${sawDone})`);
}

export async function embedTexts(input: string[]) {
  if (!isEmbeddingConfigured()) return null;
  const payload = await postJson(config.ai.embeddingBaseUrl, config.ai.embeddingApiKey, "/embeddings", {
    model: config.ai.embeddingModel,
    input,
  });
  const rawData = (payload.data ?? payload.embeddings) as Array<{ embedding?: number[]; index?: number } | number[]> | undefined;
  const data = rawData?.map((item, index) => Array.isArray(item) ? { embedding: item, index } : item);
  if (!data?.length || data.some((item) => !item.embedding)) {
    throw new Error("Embedding 服务返回了无效结果");
  }
  return [...data]
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    .map((item) => item.embedding as number[]);
}

export function configuredModelName() {
  return config.ai.chatModel || null;
}
