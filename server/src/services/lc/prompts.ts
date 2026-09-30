import { PromptTemplate } from "@langchain/core/prompts";
import { z } from "zod/v3";
import { config } from "../../config.js";
import { getChatModel, toLangChainMessages } from "./models.js";

const summaryTemplate = PromptTemplate.fromTemplate(
  "你是资料摘要助手。请根据提供的资料内容输出 JSON：{\"summary\": \"约 150-300 字的整体概览\", \"keyPoints\": [\"3-6 条核心要点\"], \"outline\": [\"可选的内容结构；没有明显结构时给空数组\"]}。只输出 JSON，不要输出 Markdown 或解释。\n\n资料：\n{material}",
);

export async function structuredDocumentSummary(material: string) {
  if (!config.ai.baseUrl || !config.ai.chatModel) return null;
  const parser = getChatModel().withStructuredOutput(z.object({
    summary: z.string(),
    keyPoints: z.array(z.string()).default([]),
    outline: z.array(z.string()).default([]),
  }));
  const prompt = await summaryTemplate.format({ material: material.slice(0, 20000) });
  return parser.invoke(toLangChainMessages([{ role: "user", content: prompt }]));
}

export async function structuredRerankScores(question: string, documents: string[]) {
  if (!config.ai.baseUrl || !config.ai.utilityModel) return null;
  const model = getChatModel(config.rerank.provider === "llm" && config.rerank.model ? config.rerank.model : config.ai.utilityModel);
  const parser = model.withStructuredOutput(z.array(z.object({ index: z.number().int(), score: z.number().min(0).max(10) })));
  const passages = documents.map((document, index) => `[${index}] ${document.slice(0, 400)}`).join("\n\n");
  return parser.invoke(toLangChainMessages([{
    role: "user",
    content: `问题：${question}\n\n资料片段：\n${passages}\n\n请为每段与问题的相关性打分（0-10）。`,
  }]));
}
