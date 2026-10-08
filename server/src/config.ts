import path from "node:path";
import dotenv from "dotenv";

dotenv.config();

function integer(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function fraction(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : fallback;
}

const baseUrl = (process.env.AI_BASE_URL ?? "").replace(/\/$/, "");

export const config = {
  port: integer("APP_PORT", 3001),
  origin: process.env.APP_ORIGIN ?? "http://localhost:5173",
  maxUploadBytes: integer("MAX_UPLOAD_MB", 50) * 1024 * 1024,
  uploadDir: path.resolve(process.cwd(), process.env.UPLOAD_DIR ?? "storage"),
  publicBasePath: process.env.PUBLIC_BASE_PATH ?? "/folio",
  cookieName: process.env.AUTH_COOKIE_NAME ?? "kb_session",
  sessionDays: integer("AUTH_SESSION_DAYS", 14),
  allowRegistration: process.env.ALLOW_REGISTRATION !== "false",
  secureCookies: process.env.SECURE_COOKIES === "true",
  maxEmbeddingCandidates: integer("MAX_EMBEDDING_CANDIDATES", 10000),
  search: {
    // Minimum cosine similarity for an embedding hit to be considered relevant.
    semanticMin: fraction("SEARCH_SEMANTIC_MIN", 0.35),
    // Full-text score is normalized to the best hit, so 0.5 means "at least half as good".
    fulltextMin: fraction("SEARCH_FULLTEXT_MIN", 0.5),
    // Number of query tokens that must appear verbatim for a keyword-only fallback hit.
    keywordMin: integer("SEARCH_KEYWORD_MIN", 2),
    // Maximum number of chunks injected into the model context / returned as sources.
    resultLimit: integer("SEARCH_RESULT_LIMIT", 4),
    // Candidate pool size pulled from full-text and vector search before ranking.
    candidateLimit: integer("SEARCH_CANDIDATE_LIMIT", 40),
  },
  rerank: {
    // Re-score the retrieved candidates before building the context.
    // provider: api (dedicated cross-encoder via /rerank) | llm (listwise chat) | off
    enabled: process.env.RERANK_ENABLED !== "false",
    provider: (process.env.RERANK_PROVIDER ?? "auto") as "auto" | "api" | "llm" | "off",
    // Dedicated rerank endpoint (Cohere/Jina/SiliconFlow/TEI/local service shape).
    url: process.env.RERANK_URL ?? "",
    apiKey: process.env.RERANK_API_KEY ?? "",
    // Model name for the api provider; also used as the LLM override when provider=llm.
    model: process.env.RERANK_MODEL ?? "",
    candidates: integer("RERANK_CANDIDATES", 12),
    // Normalized 0-1; candidates below this are dropped after reranking.
    minScore: fraction("RERANK_MIN_SCORE", 0.4),
  },
  agent: {
    // Agentic retrieval: let the model choose tools (search / list / read / collections)
    // before answering. Falls back to the one-shot pipeline on any failure.
    enabled: process.env.AGENT_ENABLED !== "false",
    maxSteps: integer("AGENT_MAX_STEPS", 6),
    // Model used to choose/sequence tools; defaults to the chat model (tool choice
    // quality matters more than the small speed gain of a weaker model).
    model: process.env.AGENT_MODEL || process.env.AI_CHAT_MODEL || "",
    // Per agent step timeout: a stalled tool-turn falls back instead of hanging.
    stepTimeoutMs: integer("AGENT_STEP_TIMEOUT_MS", 45_000),
  },
  summary: {
    // The configured DeepSeek V4.1 Flash model supports 1M context. Reserve room
    // for prompts/output; documents over this budget use map/reduce instead.
    contextTokens: integer("SUMMARY_CONTEXT_TOKENS", 1_048_576),
    contextReserveTokens: integer("SUMMARY_CONTEXT_RESERVE_TOKENS", 150_000),
    groupChars: integer("SUMMARY_GROUP_CHARS", 60_000),
    sectionChars: integer("SUMMARY_SECTION_CHARS", 120_000),
    mapConcurrency: integer("SUMMARY_MAP_CONCURRENCY", 6),
    jobConcurrency: integer("SUMMARY_JOB_CONCURRENCY", 2),
  },
  conversation: {
    // Turns kept verbatim in the prompt; older ones are folded into the summary.
    recentMessages: integer("HISTORY_RECENT_MESSAGES", 8),
    maxChars: integer("HISTORY_MAX_CHARS", 6000),
    summaryTriggerMessages: integer("SUMMARY_TRIGGER_MESSAGES", 12),
    summaryMaxChars: integer("SUMMARY_MAX_CHARS", 2000),
    rewriteEnabled: process.env.QUERY_REWRITE !== "false",
  },
  ocr: {
    // When a PDF yields almost no text layer it is treated as scanned and OCR runs.
    enabled: process.env.OCR_ENABLED !== "false",
    provider: (process.env.OCR_PROVIDER ?? "auto") as "auto" | "tesseract" | "model",
    model: process.env.OCR_MODEL ?? "",
    language: process.env.OCR_LANGUAGE ?? "chi_sim+eng",
    // A real text page has hundreds of characters; below this average it is likely an image.
    minCharsPerPage: integer("OCR_MIN_CHARS_PER_PAGE", 30),
    maxPages: integer("OCR_MAX_PAGES", 30),
    dpi: integer("OCR_DPI", 200),
  },
  vector: {
    url: (process.env.QDRANT_URL ?? "").replace(/\/$/, ""),
    apiKey: process.env.QDRANT_API_KEY ?? "",
    collection: process.env.QDRANT_COLLECTION ?? "folio_chunks",
  },
  mysql: {
    host: process.env.MYSQL_HOST ?? "127.0.0.1",
    port: integer("MYSQL_PORT", 3306),
    database: process.env.MYSQL_DATABASE ?? "folio",
    user: process.env.MYSQL_USER ?? "root",
    password: process.env.MYSQL_PASSWORD ?? "",
  },
  defaultUser: {
    email: process.env.DEFAULT_USER_EMAIL ?? "local@folio.dev",
    displayName: process.env.DEFAULT_USER_NAME ?? "本地用户",
  },
  ai: {
    baseUrl,
    apiKey: process.env.AI_API_KEY ?? "",
    chatModel: process.env.AI_CHAT_MODEL ?? "",
    // Cheap/fast model for query rewrite, rerank and summary; defaults to the chat model.
    utilityModel: process.env.AI_UTILITY_MODEL || process.env.AI_CHAT_MODEL || "",
    embeddingModel: process.env.AI_EMBEDDING_MODEL ?? "",
    // Embeddings can run against a different (e.g. local) OpenAI-compatible server.
    embeddingBaseUrl: (process.env.EMBEDDING_BASE_URL || baseUrl).replace(/\/$/, ""),
    embeddingApiKey: process.env.EMBEDDING_API_KEY ?? process.env.AI_API_KEY ?? "",
    timeoutMs: integer("AI_TIMEOUT_MS", 120_000),
    maxRetries: integer("AI_MAX_RETRIES", 3),
    // "off" disables model reasoning; "low"/"medium"/"high" request that effort level;
    // empty means "do not send the reasoning field at all".
    reasoningEffort: process.env.AI_REASONING_EFFORT ?? "off",
    // When the knowledge base has nothing relevant, still answer with the model's
    // general knowledge (clearly labelled) instead of refusing.
    answerWithoutContext: process.env.ANSWER_WITHOUT_CONTEXT !== "false",
  },
};
