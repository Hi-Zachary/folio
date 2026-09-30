import { QdrantVectorStore } from "@langchain/qdrant";
import { config } from "../../config.js";
import { getEmbeddingModel } from "./models.js";

let cached: QdrantVectorStore | null = null;
let cachedKey = "";

export function isConfigured() {
  return Boolean(config.vector.url);
}

/**
 * Creates the LangChain Qdrant integration lazily.  Folio historically stored
 * metadata as flat Qdrant payload fields, so writes and reads below use the
 * public client exposed by QdrantVectorStore while preserving that payload
 * shape.  This allows an existing collection to be switched without a data
 * migration; the vector store remains the owner of the connection/config.
 */
export async function getQdrantStore() {
  if (!config.vector.url || !config.ai.embeddingBaseUrl || !config.ai.embeddingModel) return null;
  const key = `${config.vector.url}/${config.vector.collection}`;
  if (cached && cachedKey === key) return cached;
  cached = await QdrantVectorStore.fromExistingCollection(getEmbeddingModel(), {
    url: config.vector.url,
    apiKey: config.vector.apiKey || undefined,
    collectionName: config.vector.collection,
    contentPayloadKey: "content",
    metadataPayloadKey: "metadata",
  });
  cachedKey = key;
  return cached;
}

export async function lcUpsertVectors(points: Array<{
  id: string;
  vector: number[];
  ownerId: string;
  documentId: string;
  documentName: string;
  fileExtension?: string | null;
  content: string;
  pageNo: number | null;
  sectionTitle: string | null;
}>) {
  const store = await getQdrantStore();
  if (!store || !points.length) return false;
  await store.client.upsert(config.vector.collection, {
    wait: true,
    points: points.map((point) => ({
      id: Number(point.id),
      vector: point.vector,
      payload: {
        owner_id: Number(point.ownerId),
        document_id: Number(point.documentId),
        document_name: point.documentName,
        file_extension: point.fileExtension ?? null,
        content: point.content,
        page_no: point.pageNo,
        section_title: point.sectionTitle,
      },
    })),
  });
  return true;
}

export async function lcEnsureCollection(vectorSize: number) {
  const store = await getQdrantStore();
  if (!store) return false;
  const collection: any = await store.client.getCollection(config.vector.collection);
  const configuredSize = collection.config?.params?.vectors?.size;
  if (configuredSize && Number(configuredSize) !== vectorSize) {
    throw new Error(`Qdrant collection 向量维度为 ${configuredSize}，当前模型返回 ${vectorSize}；请更换 collection 名称或重建索引`);
  }
  return true;
}

export async function lcDeleteCollection() {
  if (!isConfigured()) return false;
  const store = await getQdrantStore();
  if (store) {
    await store.client.deleteCollection(config.vector.collection).catch((error: any) => {
      if (!String(error?.status ?? error?.message ?? "").includes("404")) throw error;
    });
  }
  cached = null;
  cachedKey = "";
  return true;
}

export async function lcSearchVectors(
  vector: number[], ownerId: string, limit: number, excludeDocumentId?: string, documentIds?: string[],
) {
  const store = await getQdrantStore();
  if (!store) return null;
  const must: any[] = [{ key: "owner_id", match: { value: Number(ownerId) } }];
  const mustNot: any[] = [];
  if (documentIds?.length) must.push({ key: "document_id", match: { any: documentIds.map(Number) } });
  if (excludeDocumentId) mustNot.push({ key: "document_id", match: { value: Number(excludeDocumentId) } });
  const response: any = await store.client.query(config.vector.collection, {
    query: vector,
    limit,
    with_payload: true,
    filter: mustNot.length ? { must, must_not: mustNot } : { must },
  });
  return (response.points ?? []).map((item: any) => ({
    chunkId: String(item.id),
    score: Number(item.score),
    payload: {
      ownerId: String(item.payload?.owner_id ?? ownerId),
      documentId: String(item.payload?.document_id ?? ""),
      documentName: item.payload?.document_name ?? "未知文档",
      fileExtension: item.payload?.file_extension ?? null,
      content: item.payload?.content ?? "",
      pageNo: item.payload?.page_no ?? null,
      sectionTitle: item.payload?.section_title ?? null,
    },
  }));
}

export async function lcDeleteDocumentVectors(documentId: string) {
  const store = await getQdrantStore();
  if (!store) return false;
  await store.delete({ filter: { must: [{ key: "document_id", match: { value: Number(documentId) } }] } });
  return true;
}
