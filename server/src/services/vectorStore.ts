import { config } from "../config.js";

export interface VectorSearchHit {
  chunkId: string;
  score: number;
  payload: {
    ownerId: string;
    documentId: string;
    documentName: string;
    fileExtension?: string | null;
    content: string;
    pageNo: number | null;
    sectionTitle: string | null;
  };
}

function headers() {
  return {
    "Content-Type": "application/json",
    ...(config.vector.apiKey ? { "api-key": config.vector.apiKey } : {}),
  };
}

async function request(path: string, init?: RequestInit) {
  const response = await fetch(`${config.vector.url}${path}`, {
    ...init,
    headers: { ...headers(), ...(init?.headers ?? {}) },
    signal: AbortSignal.timeout(30_000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Qdrant 请求失败 (${response.status}): ${JSON.stringify(payload)}`);
  return payload as any;
}

export function isVectorStoreConfigured() {
  return Boolean(config.vector.url);
}

export async function deleteCollection() {
  if (!isVectorStoreConfigured()) return;
  await request(`/collections/${encodeURIComponent(config.vector.collection)}`, { method: "DELETE" }).catch((error) => {
    if (!(error instanceof Error) || !error.message.includes("(404)")) throw error;
  });
}

export async function ensureCollection(vectorSize: number) {
  if (!isVectorStoreConfigured()) return;
  try {
    const collection = await request(`/collections/${encodeURIComponent(config.vector.collection)}`);
    const configuredSize = collection.result?.config?.params?.vectors?.size;
    if (configuredSize && Number(configuredSize) !== vectorSize) {
      throw new Error(`Qdrant collection 向量维度为 ${configuredSize}，当前模型返回 ${vectorSize}；请更换 collection 名称或重建索引`);
    }
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("(404)")) throw error;
    await request(`/collections/${encodeURIComponent(config.vector.collection)}`, {
      method: "PUT",
      body: JSON.stringify({ vectors: { size: vectorSize, distance: "Cosine" } }),
    });
  }
}

export async function upsertVectors(points: Array<{
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
  if (!isVectorStoreConfigured() || !points.length) return;
  await request(`/collections/${encodeURIComponent(config.vector.collection)}/points?wait=true`, {
    method: "PUT",
    body: JSON.stringify({
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
    }),
  });
}

export async function searchVectors(
  vector: number[],
  ownerId: string,
  limit: number,
  excludeDocumentId?: string,
  documentIds?: string[],
): Promise<VectorSearchHit[]> {
  if (!isVectorStoreConfigured()) return [];
  const must: unknown[] = [{ key: "owner_id", match: { value: Number(ownerId) } }];
  const mustNot: unknown[] = [];
  if (documentIds?.length) must.push({ key: "document_id", match: { any: documentIds.map((id) => Number(id)) } });
  if (excludeDocumentId) mustNot.push({ key: "document_id", match: { value: Number(excludeDocumentId) } });
  const payload = await request(`/collections/${encodeURIComponent(config.vector.collection)}/points/search`, {
    method: "POST",
    body: JSON.stringify({
      vector,
      limit,
      with_payload: true,
      filter: mustNot.length ? { must, must_not: mustNot } : { must },
    }),
  });
  return (payload.result ?? []).map((item: any) => ({
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

export async function deleteDocumentVectors(documentId: string) {
  if (!isVectorStoreConfigured()) return;
  await request(`/collections/${encodeURIComponent(config.vector.collection)}/points/delete?wait=true`, {
    method: "POST",
    body: JSON.stringify({ filter: { must: [{ key: "document_id", match: { value: Number(documentId) } }] } }),
  });
}
