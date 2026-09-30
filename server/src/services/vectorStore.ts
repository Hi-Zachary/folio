import {
  isConfigured,
  lcDeleteCollection,
  lcDeleteDocumentVectors,
  lcEnsureCollection,
  lcSearchVectors,
  lcUpsertVectors,
} from "./lc/qdrant.js";

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

export function isVectorStoreConfigured() {
  return isConfigured();
}

export async function deleteCollection() {
  await lcDeleteCollection();
}

export async function ensureCollection(vectorSize: number) {
  await lcEnsureCollection(vectorSize);
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
  await lcUpsertVectors(points);
}

export async function searchVectors(
  vector: number[],
  ownerId: string,
  limit: number,
  excludeDocumentId?: string,
  documentIds?: string[],
): Promise<VectorSearchHit[]> {
  return (await lcSearchVectors(vector, ownerId, limit, excludeDocumentId, documentIds)) as VectorSearchHit[] ?? [];
}

export async function deleteDocumentVectors(documentId: string) {
  await lcDeleteDocumentVectors(documentId);
}
