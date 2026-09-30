import type { AuthUser, ChatMessage, ChatScope, ChatSession, Collection, CollectionDetail, DocChunk, DocumentNote, DocumentSummary, DocumentVersion, KnowledgeDoc, RelatedDocument, SourceRef, Tag, UnifiedSearchResponse, UnifiedSearchType } from "./types";

const API_URL = (
  import.meta.env.VITE_API_URL?.trim()
  || (import.meta.env.DEV ? "http://localhost:3001/api" : "/api")
).replace(/\/$/, "");

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export function documentFileUrl(id: string, download = false, pageNo?: number | null) {
  const query = download ? "?download=1" : "";
  return `${API_URL}/documents/${encodeURIComponent(id)}/file${query}${pageNo ? `#page=${pageNo}` : ""}`;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    cache: "no-store",
    credentials: "include",
    headers: {
      ...(init?.body instanceof FormData ? {} : { "Content-Type": "application/json" }),
      ...(init?.headers ?? {}),
    },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new ApiError(response.status, response.status === 401
      ? "登录状态已失效，请重新登录"
      : body.message ?? `请求失败（${response.status}）`);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export const api = {
  me: () => request<{ user: AuthUser }>("/auth/me"),
  login: (username: string, password: string) => request<{ user: AuthUser }>(`/auth/login?_=${Date.now()}`, {
    method: "POST", body: JSON.stringify({ username, password }),
  }),
  register: (username: string, nickname: string, password: string) => request<{ user: AuthUser }>(`/auth/register?_=${Date.now()}`, {
    method: "POST", body: JSON.stringify({ username, nickname, password }),
  }),
  logout: () => request<void>("/auth/logout", { method: "POST" }),
  systemInfo: () => request<{
    embeddingConfigured: boolean;
    embeddingModel: string | null;
    chatConfigured: boolean;
    chatModel: string | null;
    maxUploadMB: number;
  }>("/system/info"),
  documents: (params?: { q?: string; tagId?: string; collectionId?: string }) => {
    const search = new URLSearchParams();
    if (params?.q?.trim()) search.set("q", params.q.trim());
    if (params?.tagId) search.set("tagId", params.tagId);
    if (params?.collectionId) search.set("collectionId", params.collectionId);
    const query = search.toString();
    return request<KnowledgeDoc[]>(query ? `/documents?${query}` : "/documents");
  },
  search: (q: string, type: UnifiedSearchType = "all") => {
    const params = new URLSearchParams({ q: q.trim(), type });
    return request<UnifiedSearchResponse>(`/search?${params.toString()}`);
  },
  createTextDocument: (payload: { title: string; content: string }) =>
    request<KnowledgeDoc>("/documents/text", { method: "POST", body: JSON.stringify(payload) }),
  createUrlDocument: (payload: { url: string; title?: string }) =>
    request<KnowledgeDoc>("/documents/url", { method: "POST", body: JSON.stringify(payload) }),
  renameDocument: (id: string, name: string) =>
    request<KnowledgeDoc>(`/documents/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ name }) }),
  documentSummary: (id: string) => request<DocumentSummary>(`/documents/${encodeURIComponent(id)}/summary`),
  generateSummary: (id: string) => request<DocumentSummary>(`/documents/${encodeURIComponent(id)}/summary`, { method: "POST" }),
  collections: () => request<Collection[]>("/collections"),
  createCollection: (name: string, description?: string, documentIds?: string[], smart?: { isSmart?: boolean; smartFilter?: Record<string, unknown> }) =>
    request<Collection>("/collections", { method: "POST", body: JSON.stringify({ name, description, documentIds, ...smart }) }),
  collection: (id: string) => request<CollectionDetail>(`/collections/${encodeURIComponent(id)}`),
  renameCollection: (id: string, name: string) => request<Collection>(`/collections/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ name }) }),
  deleteCollection: (id: string) => request<void>(`/collections/${encodeURIComponent(id)}`, { method: "DELETE" }),
  addCollectionDocuments: (id: string, documentIds: string[]) =>
    request<{ added: number }>(`/collections/${encodeURIComponent(id)}/documents`, { method: "POST", body: JSON.stringify({ documentIds }) }),
  removeCollectionDocument: (id: string, documentId: string) =>
    request<void>(`/collections/${encodeURIComponent(id)}/documents/${encodeURIComponent(documentId)}`, { method: "DELETE" }),
  saveMessageAsNote: (messageId: string, content?: string) =>
    request<DocumentNote>(`/messages/${encodeURIComponent(messageId)}/save-note`, { method: "POST", body: JSON.stringify({ content }) }),
  documentChunks: (id: string) => request<DocChunk[]>(`/documents/${encodeURIComponent(id)}/chunks`),
  documentVersions: (id: string) => request<DocumentVersion[]>(`/documents/${encodeURIComponent(id)}/versions`),
  uploadDocumentVersion: (id: string, file: File) => {
    const body = new FormData(); body.append("file", file);
    return request<{ document: KnowledgeDoc; version: { id: string; versionNo: number } }>(`/documents/${encodeURIComponent(id)}/versions`, { method: "POST", body });
  },
  restoreDocumentVersion: (id: string, versionId: string) => request<{ document: KnowledgeDoc; preservedVersionNo: number }>(`/documents/${encodeURIComponent(id)}/versions/${encodeURIComponent(versionId)}/restore`, { method: "POST" }),
  messageSources: (id: string) => request<Array<{ order: number; chunkId: string | null; documentId: string | null; documentName: string; fileExtension: string | null; pageNo: number | null; sectionTitle: string | null; snippet: string; content: string }>>(`/messages/${encodeURIComponent(id)}/sources`),
  setMessageFeedback: (id: string, value: number) => request<{ value: number }>(`/messages/${encodeURIComponent(id)}/feedback`, { method: "PATCH", body: JSON.stringify({ value }) }),
  suggestions: (messageId: string) => request<string[]>("/chat/suggestions", { method: "POST", body: JSON.stringify({ messageId }) }),
  setDocumentTags: (id: string, tagIds: string[]) =>
    request<Tag[]>(`/documents/${encodeURIComponent(id)}/tags`, { method: "PUT", body: JSON.stringify({ tagIds }) }),
  batchDocuments: (ids: string[], action: "tag", extra?: { tagIds?: string[] }) =>
    request<{ updated: number }>("/documents/batch", { method: "POST", body: JSON.stringify({ ids, action, ...extra }) }),
  relatedDocuments: (id: string, limit = 5) => request<RelatedDocument[]>(`/documents/${encodeURIComponent(id)}/related?limit=${limit}`),
  tags: () => request<Tag[]>("/tags"),
  createTag: (name: string, color?: string) => request<Tag>("/tags", { method: "POST", body: JSON.stringify({ name, color }) }),
  renameTag: (id: string, name: string) => request<Tag>(`/tags/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ name }) }),
  deleteTag: (id: string) => request<void>(`/tags/${encodeURIComponent(id)}`, { method: "DELETE" }),
  documentNotes: (id: string) => request<DocumentNote[]>(`/documents/${encodeURIComponent(id)}/notes`),
  createNote: (documentId: string, note: { content: string; quote?: string; chunkId?: string; color?: string }) =>
    request<DocumentNote>(`/documents/${encodeURIComponent(documentId)}/notes`, { method: "POST", body: JSON.stringify(note) }),
  updateNote: (id: string, update: { content?: string; color?: string | null }) =>
    request<DocumentNote>(`/notes/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(update) }),
  deleteNote: (id: string) => request<void>(`/notes/${encodeURIComponent(id)}`, { method: "DELETE" }),
  upload: (file: File, onProgress?: (progress: number) => void) => new Promise<KnowledgeDoc>((resolve, reject) => {
    const body = new FormData();
    body.append("file", file);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${API_URL}/documents`);
    xhr.withCredentials = true;
    xhr.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable) onProgress?.(Math.round((event.loaded / event.total) * 100));
    });
    xhr.addEventListener("load", () => {
      let payload: { message?: string } & Partial<KnowledgeDoc> = {};
      try { payload = JSON.parse(xhr.responseText) as typeof payload; } catch { /* handled below */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(payload as KnowledgeDoc);
      else {
        reject(new ApiError(xhr.status, xhr.status === 401
          ? "登录状态已失效，请重新登录"
          : payload.message ?? `上传失败（${xhr.status}）`));
      }
    });
    xhr.addEventListener("error", () => reject(new Error("网络错误，上传失败")));
    xhr.addEventListener("abort", () => reject(new Error("上传已取消")));
    xhr.send(body);
  }),
  removeDocument: (id: string) => request<void>(`/documents/${id}`, { method: "DELETE" }),
  retryDocument: (id: string) => request<KnowledgeDoc>(`/documents/${id}/retry`, { method: "POST" }),
  sessions: (query?: string) => request<ChatSession[]>(query?.trim() ? `/sessions?q=${encodeURIComponent(query.trim())}` : "/sessions"),
  sessionMessages: (sessionId: string) => request<ChatMessage[]>(`/sessions/${encodeURIComponent(sessionId)}/messages`),
  deleteSession: (sessionId: string) => request<void>(`/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" }),
  renameSession: (sessionId: string, title: string) => request<ChatSession>(`/sessions/${encodeURIComponent(sessionId)}`, {
    method: "PATCH", body: JSON.stringify({ title }),
  }),
  sessionExportUrl: (sessionId: string, format: "markdown" | "txt") => `${API_URL}/sessions/${encodeURIComponent(sessionId)}/export?format=${format}`,
};

export interface ChatStreamHandlers {
  onSession?: (data: { sessionId: string; userMessageId: string }) => void;
  onStage?: (message: string) => void;
  onReset?: () => void;
  onSources?: (sources: SourceRef[]) => void;
  onDelta?: (text: string) => void;
  onDone?: (data: { sessionId: string; assistantMessageId: string; noMatch: boolean; answerSource?: "document" | "general" | "fallback"; modelName: string | null }) => void;
}

async function consumeEventStream(response: Response, handlers: ChatStreamHandlers) {
  if (!response.ok || !response.body) {
    const body = await response.json().catch(() => ({}));
    throw new ApiError(response.status, body.message ?? `请求失败（${response.status}）`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      boundary = buffer.indexOf("\n\n");
      const event = /^event:\s*(.+)$/m.exec(frame)?.[1]?.trim();
      const dataLine = frame.split("\n").find((line) => line.startsWith("data:"));
      if (!event || !dataLine) continue;
      const data = JSON.parse(dataLine.slice(5).trim()) as Record<string, unknown>;
      if (event === "session") handlers.onSession?.(data as { sessionId: string; userMessageId: string });
      else if (event === "stage") handlers.onStage?.(String(data.message ?? ""));
      else if (event === "reset") handlers.onReset?.();
      else if (event === "sources") handlers.onSources?.((data.sources as SourceRef[]) ?? []);
      else if (event === "delta") handlers.onDelta?.(String(data.text ?? ""));
      else if (event === "done") handlers.onDone?.(data as { sessionId: string; assistantMessageId: string; noMatch: boolean; answerSource?: "document" | "general" | "fallback"; modelName: string | null });
      else if (event === "error") throw new ApiError(500, String(data.message ?? "生成失败"));
    }
  }
}

/** Streams an answer for a new question and dispatches each SSE event. */
export async function streamChatMessage(content: string, sessionId: string | undefined, handlers: ChatStreamHandlers, scope?: ChatScope) {
  const response = await fetch(`${API_URL}/chat/stream`, {
    method: "POST",
    credentials: "include",
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content, sessionId, scope }),
  });
  await consumeEventStream(response, handlers);
}

/** Replaces an existing assistant answer by streaming a fresh one. */
export async function regenerateChatMessage(sessionId: string, assistantMessageId: string, handlers: ChatStreamHandlers) {
  const response = await fetch(`${API_URL}/chat/regenerate`, {
    method: "POST",
    credentials: "include",
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, assistantMessageId }),
  });
  await consumeEventStream(response, handlers);
}
