import { Document } from "@langchain/core/documents";
import { BaseRetriever } from "@langchain/core/retrievers";
import { config } from "../../config.js";
import { getEmbeddingModel } from "./models.js";
import { lcSearchVectors } from "./qdrant.js";

type RetrieverOptions = { ownerId: string; limit: number; excludeDocumentId?: string; documentIds?: string[] };

/** Scoped adapter that keeps Folio's owner/document filters on every call. */
class ScopedQdrantRetriever extends BaseRetriever {
  lc_namespace = ["folio", "retrievers"];
  constructor(private readonly options: RetrieverOptions) { super({ tags: ["folio", "qdrant"] }); }

  async _getRelevantDocuments(question: string) {
    const vector = await getEmbeddingModel().embedQuery(question);
    const hits = await lcSearchVectors(vector, this.options.ownerId, this.options.limit, this.options.excludeDocumentId, this.options.documentIds);
    return (hits ?? []).map((hit: any) => new Document({
      id: hit.chunkId,
      pageContent: hit.payload.content,
      metadata: { ...hit.payload, score: hit.score },
    }));
  }
}

export async function retrieveWithLangChain(question: string, options: RetrieverOptions) {
  if (!config.vector.url || !config.ai.embeddingBaseUrl || !config.ai.embeddingModel) return null;
  const retriever = new ScopedQdrantRetriever(options);
  return retriever.invoke(question);
}
