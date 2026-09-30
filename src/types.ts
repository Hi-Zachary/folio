export type DocStatus = "pending" | "parsed" | "parsing" | "failed";

export interface DocChunk {
  id: string;
  chunkNo: number;
  pageNo: number | null;
  sectionTitle: string | null;
  content: string;
  embeddingStatus: string;
  embeddingModel: string | null;
}

export interface AuthUser {
  id: string;
  username: string;
  nickname: string;
  role: "user" | "admin";
}

export interface Tag {
  id: string;
  name: string;
  color?: string | null;
  count?: number;
}

export interface DocumentNote {
  id: string;
  documentId: string;
  chunkId: string | null;
  quote: string | null;
  content: string;
  color: string | null;
  sourceType?: "manual" | "excerpt" | "chat";
  sourceMessageId?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DocumentSummary {
  status: "none" | "stale" | "ready";
  generationStatus?: "pending" | "running" | "failed" | "success" | null;
  summary: string;
  keyPoints: string[];
  outline: string[];
  modelName: string | null;
  generatedAt: string | null;
}

export interface Collection {
  id: string;
  name: string;
  description?: string | null;
  documentCount?: number;
  updatedAt?: string;
  isSmart?: boolean;
  smartFilter?: Record<string, unknown> | null;
}

export interface CollectionDetail extends Collection {
  documents: KnowledgeDoc[];
}

export interface ChatScope {
  type: "library" | "collection" | "documents";
  collectionId?: string;
  documentIds?: string[];
}

export interface KnowledgeDoc {
  id: string;
  number?: number | null;
  name: string;
  type: "PDF" | "Word" | "Markdown" | "HTML" | "CSV" | "TXT";
  uploadedAt: string;
  sizeKB: number;
  status: DocStatus;
  errorMessage?: string | null;
  warningMessage?: string | null;
  jobStatus?: string | null;
  jobType?: string | null;
  jobError?: string | null;
  jobAttempts?: number | null;
  indexFailed?: boolean;
  parsedAt?: string | null;
  indexedAt?: string | null;
  tags?: Tag[];
  downloadUrl: string;
  previewUrl: string;
}

export interface RelatedDocument extends KnowledgeDoc {
  score: number;
  snippet: string;
}

export type UnifiedSearchType = "all" | "documents" | "chunks" | "notes" | "messages";

export interface UnifiedSearchResult {
  id: string;
  type: "document" | "chunk" | "note" | "message";
  title: string;
  subtitle: string;
  snippet: string;
  updatedAt: string | null;
  documentId?: string;
  chunkId?: string;
  messageId?: string;
  sessionId?: string;
}

export interface UnifiedSearchResponse {
  documents: UnifiedSearchResult[];
  chunks: UnifiedSearchResult[];
  notes: UnifiedSearchResult[];
  messages: UnifiedSearchResult[];
}

export interface DocumentVersion {
  id: string;
  versionNo: number;
  name: string;
  fileExtension: string;
  sizeKB: number;
  fileHash: string;
  createdAt: string;
}

export interface SourceRef {
  docId: string;
  chunkId?: string;
  documentId?: string;
  docName: string;
  snippet: string;
  pageNo?: number | null;
  fileExtension?: string | null;
  sectionTitle?: string | null;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  sources?: SourceRef[];
  noMatch?: boolean;
  answerSource?: "document" | "general" | "fallback";
  feedback?: number | null;
}

export interface ChatSession {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  scopeType?: "library" | "collection" | "documents";
  scopeCollectionId?: string;
  scopeDocumentIds?: string[];
  matchSnippet?: string | null;
}
