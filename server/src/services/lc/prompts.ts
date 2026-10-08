import { PromptTemplate } from "@langchain/core/prompts";
import { z } from "zod/v3";
import { config } from "../../config.js";
import { getChatModel, toLangChainMessages } from "./models.js";

const summaryTemplate = PromptTemplate.fromTemplate(
  "你是资料摘要助手。请根据提供的资料内容输出 JSON：{\"summary\": \"约 150-300 字的整体概览\", \"keyPoints\": [\"3-6 条核心要点\"], \"outline\": [\"可选的内容结构；没有明显结构时给空数组\"]}。只输出 JSON，不要输出 Markdown 或解释。\n\n资料：\n{material}",
);

export async function structuredDocumentSummary(material: string, modelName = config.ai.chatModel, sectionCount = 0) {
  if (!config.ai.baseUrl || !modelName) return null;
  const schema = z.object({
    summary: z.string(),
    keyPoints: z.array(z.string()).default([]),
    outline: z.array(z.string()).default([]),
    sections: z.array(z.object({ sectionNo: z.number().int(), title: z.string(), summary: z.string() })).default([]),
  });
  const parser = getChatModel(modelName, 0).withStructuredOutput(schema);
  const promptText = sectionCount
    ? `请完整阅读以下全文。先生成全书概览、核心要点和结构；再为每个标注的分段生成简洁摘要。sections 必须恰好包含 ${sectionCount} 项，sectionNo 使用输入中的编号，不要遗漏或合并分段。分段摘要只总结该段内容，不得补造。\n\n${material}`
    : await summaryTemplate.format({ material: material.slice(0, 20000) });
  return parser.invoke(toLangChainMessages([{ role: "user", content: promptText }]));
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
