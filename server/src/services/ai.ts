import { config } from "../config.js";
import { lcChatCompletion, lcChatCompletionStream, lcEmbedTexts } from "./lc/models.js";

export interface ChatInput {
  role: "system" | "user" | "assistant";
  content: string;
}

export function isChatConfigured() {
  return Boolean(config.ai.baseUrl && config.ai.chatModel);
}

export function isEmbeddingConfigured() {
  return Boolean(config.ai.embeddingBaseUrl && config.ai.embeddingModel);
}

/** LangChain-backed chat entry point used by routes, summaries and memory. */
export async function chatCompletion(messages: ChatInput[], model = config.ai.chatModel) {
  return lcChatCompletion(messages, model);
}

/** LangChain streaming entry point; route-level SSE mapping stays unchanged. */
export async function* chatCompletionStream(messages: ChatInput[], model = config.ai.chatModel): AsyncGenerator<string> {
  yield* lcChatCompletionStream(messages, model);
}

/** LangChain OpenAI-compatible embedding entry point. */
export async function embedTexts(input: string[]) {
  return lcEmbedTexts(input);
}

export function configuredModelName() {
  return config.ai.chatModel || null;
}
