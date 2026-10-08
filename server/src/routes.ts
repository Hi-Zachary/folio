import crypto from "node:crypto";
import { lookup } from "node:dns/promises";
import fs from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";
import { Router } from "express";
import multer from "multer";
import { Agent } from "undici";
import { z } from "zod";
import { config } from "./config.js";
import { query, transaction } from "./db.js";
import { parseJson } from "./services/app.js";
import { chatCompletion, chatCompletionStream, configuredModelName, isChatConfigured, isEmbeddingConfigured } from "./services/ai.js";
import { buildAnswerMessages, buildGeneralAnswerMessages, getRecentHistory, getSessionMemory, rewriteQuery, summarizeIfNeeded } from "./services/conversation.js";
import { rerankResults } from "./services/rerank.js";
import { getDocumentSummary, getFreshSummaryText } from "./services/summary.js";
import { runLangGraphAgent } from "./services/lc/graphAgent.js";
import { createSession, currentUser, destroySession, hashPassword, requireAuth, verifyPassword } from "./services/auth.js";
import { enqueueDocument, enqueueSummary } from "./services/documentProcessor.js";
import { displayFilename } from "./services/filename.js";
import { searchKnowledge, type SearchResult } from "./services/search.js";
import { deleteDocumentVectors, isVectorStoreConfigured, searchVectors } from "./services/vectorStore.js";

export const api = Router();

const upload = multer({
  dest: config.uploadDir,
  limits: { fileSize: config.maxUploadBytes },
  fileFilter: (_req, file, callback) => {
    const allowed = new Set([".pdf", ".docx", ".md", ".markdown", ".txt", ".html", ".htm", ".csv"]);
    callback(null, allowed.has(path.extname(file.originalname).toLowerCase()));
  },
});

function publicDocument(row: any) {
  return {
    id: String(row.document_id),
    number: row.local_document_no === undefined ? null : Number(row.local_document_no),
    name: displayFilename(row.original_file_name),
    type: row.file_extension.toLowerCase() === ".pdf"
      ? "PDF"
      : [".doc", ".docx"].includes(row.file_extension.toLowerCase())
        ? "Word"
        : [".md", ".markdown"].includes(row.file_extension.toLowerCase())
          ? "Markdown"
          : [".html", ".htm"].includes(row.file_extension.toLowerCase())
            ? "HTML"
            : row.file_extension.toLowerCase() === ".csv"
              ? "CSV"
            : "TXT",
    uploadedAt: row.uploaded_at,
    sizeKB: Math.max(1, Math.round(Number(row.file_size) / 1024)),
    status: row.parse_status,
    errorMessage: row.parse_error,
    warningMessage: row.parse_warning ?? null,
    parsedAt: row.parsed_at,
    indexedAt: row.indexed_at,
    jobStatus: row.job_status ?? null,
    jobType: row.job_type ?? null,
    jobError: row.job_error ?? null,
    jobAttempts: row.job_attempts === null || row.job_attempts === undefined ? null : Number(row.job_attempts),
    indexFailed: Number(row.embedding_failed_count ?? 0) > 0,
    downloadUrl: `/api/documents/${row.document_id}/file?download=1`,
    previewUrl: `/api/documents/${row.document_id}/file`,
  };
}

/** Attaches each document's tags in a single query to avoid N+1 lookups. */
async function withTags(rows: any[]) {
  if (!rows.length) return rows.map(publicDocument);
  const ids = rows.map((row) => row.document_id);
  const ownerIds = [...new Set(rows.map((row) => String(row.owner_id)).filter(Boolean))];
  const placeholders = ids.map(() => "?").join(", ");
  const tagRows = await query<any>(
    `SELECT dt.document_id, t.tag_id, t.name, t.color
     FROM document_tag dt INNER JOIN tag t ON t.tag_id = dt.tag_id
     WHERE dt.document_id IN (${placeholders})
     ORDER BY t.name`,
    ids,
  );
  const byDocument = new Map<string, Array<{ id: string; name: string; color: string | null }>>();
  for (const row of tagRows) {
    const key = String(row.document_id);
    if (!byDocument.has(key)) byDocument.set(key, []);
    byDocument.get(key)!.push({ id: String(row.tag_id), name: row.name, color: row.color });
  }
  const jobRows = await query<any>(
    `SELECT j.document_id, j.status AS job_status, j.job_type, j.error_message AS job_error, j.attempt_count AS job_attempts
     FROM document_job j
     INNER JOIN (
       SELECT document_id, MAX(job_id) AS latest_job_id
       FROM document_job WHERE document_id IN (${ids.map(() => "?").join(", ")})
       GROUP BY document_id
     ) latest ON latest.latest_job_id = j.job_id`,
    ids,
  ).catch(() => []);
  const byDocumentJob = new Map<string, any>();
  for (const row of jobRows) byDocumentJob.set(String(row.document_id), row);
  const embeddingRows = await query<any>(
    `SELECT document_id, SUM(embedding_status = 'failed') AS embedding_failed_count
     FROM document_chunk WHERE document_id IN (${placeholders}) GROUP BY document_id`,
    ids,
  ).catch(() => []);
  const embeddingFailedByDocument = new Map<string, number>();
  for (const row of embeddingRows) embeddingFailedByDocument.set(String(row.document_id), Number(row.embedding_failed_count));
  const numbers = ownerIds.length ? await query<any>(
    `SELECT document_id, local_document_no FROM (
       SELECT document_id, ROW_NUMBER() OVER (PARTITION BY owner_id ORDER BY uploaded_at, document_id) AS local_document_no
       FROM documents WHERE owner_id IN (${ownerIds.map(() => "?").join(", ")}) AND deleted_at IS NULL
     ) numbered WHERE document_id IN (${ids.map(() => "?").join(", ")})`,
    [...ownerIds, ...ids],
  ).catch(() => []) : [];
  const numberByDocument = new Map<string, number>();
  for (const row of numbers) numberByDocument.set(String(row.document_id), Number(row.local_document_no));
  return rows.map((row) => ({
    ...publicDocument({
      ...row,
      local_document_no: numberByDocument.get(String(row.document_id)),
      embedding_failed_count: embeddingFailedByDocument.get(String(row.document_id)) ?? 0,
      ...(byDocumentJob.get(String(row.document_id)) ?? {}),
    }),
    tags: byDocument.get(String(row.document_id)) ?? [],
  }));
}

function safeStoragePath(storageKey: string) {
  const root = path.resolve(config.uploadDir);
  const target = path.resolve(root, storageKey);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    throw new Error("非法文件路径");
  }
  return target;
}

function contentDisposition(name: string, disposition: "inline" | "attachment") {
  const fallback = name.replace(/[\\"\r\n]/g, "_").replace(/[^\x20-\x7E]/g, "_") || "download";
  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

function htmlToText(html: string) {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, "")
    .replace(/<br\s*\/?>(?=\s*)/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li|tr|section|article)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_match, value) => String.fromCodePoint(Number(value)))
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

class RequestInputError extends Error {
  constructor(message: string, readonly statusCode = 400) { super(message); }
}

function isPublicIp(address: string) {
  const family = isIP(address);
  if (family === 4) {
    const [a, b, c] = address.split(".").map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99))) return false;
    if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) return false;
    if (a === 203 && b === 0 && c === 113) return false;
    return true;
  }
  if (family === 6) {
    const host = address.toLowerCase();
    // Only global unicast (2000::/3); reject special ranges and IPv4-mapped IPs.
    return /^2[0-9a-f]{3}:/.test(host) && !host.startsWith("2001:db8:") && !host.startsWith("2001:0:");
  }
  return false;
}

async function resolvePublicAddresses(value: URL) {
  if ((value.protocol !== "http:" && value.protocol !== "https:") || value.username || value.password) {
    throw new RequestInputError("只允许不带凭据的公开 HTTP/HTTPS 页面");
  }
  const hostname = value.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    throw new RequestInputError("只允许导入公开地址");
  }
  const family = isIP(hostname);
  const addresses = family
    ? [{ address: hostname, family }]
    : await lookup(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => !isPublicIp(address))) {
    throw new RequestInputError("只允许导入解析到公网地址的页面");
  }
  return addresses;
}

async function fetchPublicText(startUrl: URL, maxBytes: number) {
  let currentUrl = startUrl;
  const signal = AbortSignal.timeout(30_000);
  for (let redirectCount = 0; redirectCount <= 5; redirectCount += 1) {
    const addresses = await resolvePublicAddresses(currentUrl);
    const dispatcher = new Agent({
      connect: {
        lookup: ((_hostname: string, options: any, callback: (...args: any[]) => void) => {
          // Pin DNS to the addresses that were checked above to prevent DNS rebinding.
          if (options?.all) callback(null, addresses);
          else callback(null, addresses[0].address, addresses[0].family);
        }) as any,
      },
    });
    try {
      const response = await fetch(currentUrl, {
        redirect: "manual",
        signal,
        dispatcher,
        headers: { "User-Agent": "Folio/1.0 document importer" },
      } as RequestInit & { dispatcher: Agent });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        await response.body?.cancel();
        if (!location) throw new RequestInputError("网页重定向缺少目标地址");
        if (redirectCount === 5) throw new RequestInputError("网页重定向次数过多");
        currentUrl = new URL(location, currentUrl);
        continue;
      }
      if (!response.ok) return { ok: false as const, status: response.status, url: currentUrl, contentType: "", text: "" };
      const contentType = response.headers.get("content-type") ?? "";
      const declaredLength = Number(response.headers.get("content-length") ?? 0);
      if (declaredLength > maxBytes) throw new RequestInputError("网页内容超过 2 MB 限制", 413);
      if (!response.body) return { ok: true as const, status: response.status, url: currentUrl, contentType, text: "" };
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let totalBytes = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          totalBytes += value.byteLength;
          if (totalBytes > maxBytes) {
            await reader.cancel();
            throw new RequestInputError("网页内容超过 2 MB 限制", 413);
          }
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
      return { ok: true as const, status: response.status, url: currentUrl, contentType, text: Buffer.concat(chunks).toString("utf8") };
    } finally {
      await dispatcher.close();
    }
  }
  throw new RequestInputError("网页重定向次数过多");
}

async function ownedDocument(documentId: string, ownerId: string) {
  const rows = await query<any>(
    "SELECT d.* FROM documents d WHERE d.document_id = ? AND d.owner_id = ? AND d.deleted_at IS NULL",
    [documentId, ownerId],
  );
  return rows[0] as any | undefined;
}

async function snapshotDocumentVersion(document: any) {
  const latest = await query<any>("SELECT COALESCE(MAX(version_no), 0) AS max_version FROM document_version WHERE document_id = ?", [document.document_id]);
  const versionNo = Number(latest[0]?.max_version ?? 0) + 1;
  const versionStorage = `${crypto.randomBytes(16).toString("hex")}.version${document.file_extension}`;
  try {
    await fs.copyFile(safeStoragePath(document.storage_key), safeStoragePath(versionStorage));
    const created = await query<any>(
      `INSERT INTO document_version
        (document_id, version_no, original_file_name, storage_key, mime_type, file_extension, file_size, file_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [document.document_id, versionNo, document.original_file_name, versionStorage, document.mime_type, document.file_extension, document.file_size, document.file_hash],
    );
    await query(
      `INSERT INTO document_version_chunk
        (version_id, chunk_no, content, page_no, section_title, char_start, char_end, token_count, content_hash)
       SELECT ?, chunk_no, content, page_no, section_title, char_start, char_end, token_count, content_hash
       FROM document_chunk WHERE document_id = ? ORDER BY chunk_no`,
      [created.insertId, document.document_id],
    );
    return { versionId: String(created.insertId), versionNo, storageKey: versionStorage };
  } catch (error) {
    await fs.rm(safeStoragePath(versionStorage), { force: true }).catch(() => undefined);
    throw error;
  }
}

api.get("/health", async (_req, res) => {
  try {
    await query("SELECT 1");
    res.json({ ok: true, database: "connected" });
  } catch (error) {
    res.status(503).json({ ok: false, database: "unavailable", error: error instanceof Error ? error.message : String(error) });
  }
});

api.get("/system/info", (_req, res) => {
  res.json({
    embeddingConfigured: isEmbeddingConfigured(),
    embeddingModel: config.ai.embeddingModel || null,
    chatConfigured: isChatConfigured(),
    chatModel: config.ai.chatModel || null,
    maxUploadMB: Math.round(config.maxUploadBytes / 1024 / 1024),
  });
});

api.get("/auth/me", async (req, res, next) => {
  try {
    const user = await currentUser(req);
    if (!user) return res.status(401).json({ message: "未登录" });
    res.json({ user });
  } catch (error) { next(error); }
});

api.post("/auth/register", async (req, res, next) => {
  try {
    if (!config.allowRegistration) return res.status(403).json({ message: "当前系统已关闭注册" });
    const body = z.object({
      username: z.string().trim().min(1).max(255),
      nickname: z.string().trim().min(1).max(100),
      password: z.string().min(8).max(128),
    }).parse(req.body);
    const username = body.username.toLowerCase();
    const existing = await query<any>("SELECT user_id FROM app_user WHERE email = ? LIMIT 1", [username]);
    if (existing.length) return res.status(409).json({ message: "该用户名已经注册" });
    const result = await query<any>(
      "INSERT INTO app_user (email, display_name, password_hash) VALUES (?, ?, ?)",
      [username, body.nickname, await hashPassword(body.password)],
    );
    await createSession(String(result.insertId), req, res);
    res.status(201).json({ user: { id: String(result.insertId), username, nickname: body.nickname, role: "user" } });
  } catch (error) { next(error); }
});

api.post("/auth/login", async (req, res, next) => {
  try {
    const body = z.object({ username: z.string().trim().min(1).max(255), password: z.string().min(1).max(128) }).parse(req.body);
    const rows = await query<any>(
      "SELECT user_id, email, display_name, role, password_hash FROM app_user WHERE email = ? AND is_active = TRUE LIMIT 1",
      [body.username.toLowerCase()],
    );
    if (!rows.length || !(await verifyPassword(body.password, rows[0].password_hash))) {
      return res.status(401).json({ message: "用户名或密码错误" });
    }
    await query("UPDATE app_user SET last_login_at = NOW() WHERE user_id = ?", [rows[0].user_id]);
    await createSession(String(rows[0].user_id), req, res);
    res.json({ user: { id: String(rows[0].user_id), username: rows[0].email, nickname: rows[0].display_name, role: rows[0].role } });
  } catch (error) { next(error); }
});

api.post("/auth/logout", async (req, res, next) => {
  try {
    await destroySession(req, res);
    res.status(204).send();
  } catch (error) { next(error); }
});

api.use(requireAuth);

function searchExcerpt(value: string, keyword: string, radius = 180) {
  const normalized = value.replace(/\s+/g, " ").trim();
  const offset = normalized.toLocaleLowerCase().indexOf(keyword.toLocaleLowerCase());
  const start = Math.max(0, (offset < 0 ? 0 : offset) - Math.floor(radius / 2));
  const end = Math.min(normalized.length, start + radius);
  return `${start ? "…" : ""}${normalized.slice(start, end)}${end < normalized.length ? "…" : ""}`;
}

api.get("/search", async (req, res, next) => {
  try {
    const keyword = z.string().trim().min(1).max(100).parse(req.query.q ?? "");
    const type = z.enum(["all", "documents", "chunks", "notes", "messages"]).default("all").parse(req.query.type ?? "all");
    const userId = req.user!.id;
    const like = `%${keyword.replace(/[\\%_]/g, "\\$&")}%`;
    const include = (kind: typeof type) => type === "all" || type === kind;

    const [documents, chunks, notes, messages] = await Promise.all([
      include("documents") ? query<any>(
        `SELECT d.document_id, d.original_file_name, d.file_extension, d.parse_status, d.uploaded_at,
                (SELECT GROUP_CONCAT(t.name ORDER BY t.name SEPARATOR '、')
                 FROM document_tag dt JOIN tag t ON t.tag_id = dt.tag_id WHERE dt.document_id = d.document_id) AS tag_names
         FROM documents d
         WHERE d.owner_id = ? AND d.deleted_at IS NULL
           AND (d.original_file_name LIKE ? OR EXISTS (
             SELECT 1 FROM document_chunk c WHERE c.document_id = d.document_id AND c.content LIKE ?
           ) OR EXISTS (
             SELECT 1 FROM document_note n WHERE n.document_id = d.document_id AND (n.content LIKE ? OR n.quote LIKE ?)
           ))
         ORDER BY CASE WHEN d.original_file_name LIKE ? THEN 0 ELSE 1 END, d.uploaded_at DESC, d.document_id DESC
         LIMIT 8`,
        [userId, like, like, like, like, like],
      ) : Promise.resolve([]),
      include("chunks") ? query<any>(
        `SELECT c.chunk_id, c.document_id, c.page_no, c.section_title, c.content,
                d.original_file_name, d.file_extension
         FROM document_chunk c JOIN documents d ON d.document_id = c.document_id
         WHERE d.owner_id = ? AND d.deleted_at IS NULL AND d.parse_status = 'parsed' AND c.content LIKE ?
         ORDER BY c.chunk_id DESC LIMIT 8`,
        [userId, like],
      ) : Promise.resolve([]),
      include("notes") ? query<any>(
        `SELECT n.note_id, n.document_id, n.quote, n.content, n.updated_at,
                d.original_file_name, d.file_extension
         FROM document_note n JOIN documents d ON d.document_id = n.document_id
         WHERE n.owner_id = ? AND d.owner_id = ? AND d.deleted_at IS NULL
           AND (n.content LIKE ? OR n.quote LIKE ?)
         ORDER BY n.updated_at DESC, n.note_id DESC LIMIT 8`,
        [userId, userId, like, like],
      ) : Promise.resolve([]),
      include("messages") ? query<any>(
        `SELECT m.message_id, m.session_id, m.role, m.content, m.created_at, s.title AS session_title
         FROM chat_message m JOIN chat_session s ON s.session_id = m.session_id
         WHERE s.owner_id = ? AND m.role IN ('user', 'assistant') AND m.content LIKE ?
         ORDER BY m.created_at DESC, m.message_id DESC LIMIT 8`,
        [userId, like],
      ) : Promise.resolve([]),
    ]);

    res.json({
      documents: documents.map((row: any) => ({
        id: String(row.document_id), type: "document", documentId: String(row.document_id),
        title: displayFilename(row.original_file_name),
        subtitle: `${row.file_extension.toUpperCase().replace(/^\./, "")} · ${row.parse_status === "parsed" ? "已解析" : row.parse_status}`,
        snippet: row.tag_names ? `标签：${row.tag_names}` : "打开资料查看内容",
        updatedAt: row.uploaded_at,
      })),
      chunks: chunks.map((row: any) => ({
        id: String(row.chunk_id), type: "chunk", documentId: String(row.document_id), chunkId: String(row.chunk_id),
        title: displayFilename(row.original_file_name),
        subtitle: [row.page_no ? `第 ${row.page_no} 页` : null, row.section_title].filter(Boolean).join(" · ") || "正文片段",
        snippet: searchExcerpt(String(row.content), keyword), updatedAt: null,
      })),
      notes: notes.map((row: any) => ({
        id: String(row.note_id), type: "note", documentId: String(row.document_id),
        title: `${displayFilename(row.original_file_name)} · 笔记`,
        subtitle: row.quote ? "摘录笔记" : "文档笔记",
        snippet: searchExcerpt([row.quote, row.content].filter(Boolean).join(" · "), keyword), updatedAt: row.updated_at,
      })),
      messages: messages.map((row: any) => ({
        id: String(row.message_id), type: "message", messageId: String(row.message_id), sessionId: String(row.session_id),
        title: row.session_title || "未命名对话", subtitle: row.role === "user" ? "用户提问" : "AI 回答",
        snippet: searchExcerpt(String(row.content), keyword), updatedAt: row.created_at,
      })),
    });
  } catch (error) { next(error); }
});

api.get("/documents", async (req, res, next) => {
  try {
    const userId = req.user!.id;
    const keyword = z.string().trim().max(100).optional().parse(req.query.q ?? undefined);
    const tagId = z.string().optional().parse(req.query.tagId ?? undefined);
    const collectionId = z.string().optional().parse(req.query.collectionId ?? undefined);
    const selectedCollection = collectionId ? await ownedCollection(collectionId, userId) : null;
    if (collectionId && !selectedCollection) return res.json([]);

    const conditions = ["d.owner_id = ?", "d.deleted_at IS NULL"];
    const params: unknown[] = [userId];
    if (keyword) {
      const like = `%${keyword.replace(/[\\%_]/g, "\\$&")}%`;
      conditions.push(
        `(d.original_file_name LIKE ?
          OR EXISTS (SELECT 1 FROM document_chunk ch WHERE ch.document_id = d.document_id AND ch.content LIKE ?)
          OR EXISTS (SELECT 1 FROM document_note n WHERE n.document_id = d.document_id AND (n.content LIKE ? OR n.quote LIKE ?)))`,
      );
      params.push(like, like, like, like);
    }
    if (tagId) {
      conditions.push("EXISTS (SELECT 1 FROM document_tag dt WHERE dt.document_id = d.document_id AND dt.tag_id = ?)");
      params.push(tagId);
    }
    if (collectionId && selectedCollection?.is_smart) {
      const filter = parseJson<Record<string, unknown>>(selectedCollection.smart_filter, {});
      const smartQuery = typeof filter.q === "string" ? filter.q.trim().slice(0, 100) : "";
      if (smartQuery) {
        const smartLike = `%${smartQuery.replace(/[\\%_]/g, "\\$&")}%`;
        conditions.push(`(d.original_file_name LIKE ? OR EXISTS (SELECT 1 FROM document_chunk ch WHERE ch.document_id = d.document_id AND ch.content LIKE ?))`);
        params.push(smartLike, smartLike);
      }
      if (typeof filter.tagId === "string" && filter.tagId) { conditions.push("EXISTS (SELECT 1 FROM document_tag sdt WHERE sdt.document_id = d.document_id AND sdt.tag_id = ?)"); params.push(filter.tagId); }
      if (typeof filter.status === "string" && ["pending", "parsing", "parsed", "failed"].includes(filter.status)) { conditions.push("d.parse_status = ?"); params.push(filter.status); }
      appendDocumentTypeFilter(conditions, params, filter.type);
    } else if (collectionId) {
      conditions.push("EXISTS (SELECT 1 FROM collection_document cd WHERE cd.document_id = d.document_id AND cd.collection_id = ?)");
      params.push(collectionId);
    }

    const rows = await query<any>(
      `SELECT d.* FROM documents d WHERE ${conditions.join(" AND ")} ORDER BY d.uploaded_at DESC, d.document_id DESC`,
      params,
    );
    res.json(await withTags(rows));
  } catch (error) { next(error); }
});

api.get("/documents/:id/file", async (req, res, next) => {
  try {
    const document = await ownedDocument(req.params.id, req.user!.id);
    if (!document) return res.status(404).json({ message: "文档不存在" });
    const filePath = safeStoragePath(document.storage_key);
    await fs.access(filePath);
    res.setHeader("Content-Type", document.mime_type || "application/octet-stream");
    res.setHeader(
      "Content-Disposition",
      contentDisposition(displayFilename(document.original_file_name), req.query.download === "1" ? "attachment" : "inline"),
    );
    res.sendFile(filePath);
  } catch (error) { next(error); }
});

api.get("/documents/:id/chunks", async (req, res, next) => {
  try {
    const document = await ownedDocument(req.params.id, req.user!.id);
    if (!document) return res.status(404).json({ message: "文档不存在" });
    const chunks = await query<any>(
      `SELECT chunk_id, chunk_no, page_no, section_title, content, embedding_status, embedding_model
       FROM document_chunk WHERE document_id = ? ORDER BY chunk_no`,
      [req.params.id],
    );
    res.json(chunks.map((chunk: any) => ({
      id: String(chunk.chunk_id), chunkNo: chunk.chunk_no, pageNo: chunk.page_no,
      sectionTitle: chunk.section_title, content: chunk.content,
      embeddingStatus: chunk.embedding_status, embeddingModel: chunk.embedding_model,
    })));
  } catch (error) { next(error); }
});

function publicNote(row: any) {
  return {
    id: String(row.note_id),
    documentId: String(row.document_id),
    chunkId: row.chunk_id === null || row.chunk_id === undefined ? null : String(row.chunk_id),
    quote: row.quote,
    content: row.content,
    color: row.color,
    sourceType: row.source_type ?? "manual",
    sourceMessageId: row.source_message_id === null || row.source_message_id === undefined ? null : String(row.source_message_id),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ---------- Tags ----------

api.get("/tags", async (req, res, next) => {
  try {
    const rows = await query<any>(
      `SELECT t.tag_id, t.name, t.color, COUNT(d.document_id) AS usage_count
       FROM tag t
       LEFT JOIN document_tag dt ON dt.tag_id = t.tag_id
       LEFT JOIN documents d ON d.document_id = dt.document_id AND d.deleted_at IS NULL
       WHERE t.owner_id = ?
       GROUP BY t.tag_id, t.name, t.color
       ORDER BY t.name`,
      [req.user!.id],
    );
    res.json(rows.map((row: any) => ({ id: String(row.tag_id), name: row.name, color: row.color, count: Number(row.usage_count) })));
  } catch (error) { next(error); }
});

api.post("/tags", async (req, res, next) => {
  try {
    const userId = req.user!.id;
    const body = z.object({ name: z.string().trim().min(1).max(50), color: z.string().trim().max(20).optional() }).parse(req.body);
    const existing = await query<any>("SELECT tag_id FROM tag WHERE owner_id = ? AND name = ? LIMIT 1", [userId, body.name]);
    if (existing.length) return res.status(409).json({ message: "已存在同名标签" });
    const created = await query<any>("INSERT INTO tag (owner_id, name, color) VALUES (?, ?, ?)", [userId, body.name, body.color ?? null]);
    res.status(201).json({ id: String(created.insertId), name: body.name, color: body.color ?? null, count: 0 });
  } catch (error) { next(error); }
});

api.patch("/tags/:id", async (req, res, next) => {
  try {
    const userId = req.user!.id;
    const body = z.object({ name: z.string().trim().min(1).max(50).optional(), color: z.string().trim().max(20).nullable().optional() }).parse(req.body);
    const owned = await query<any>("SELECT tag_id FROM tag WHERE tag_id = ? AND owner_id = ?", [req.params.id, userId]);
    if (!owned.length) return res.status(404).json({ message: "标签不存在" });
    if (body.name) {
      const clash = await query<any>("SELECT tag_id FROM tag WHERE owner_id = ? AND name = ? AND tag_id <> ? LIMIT 1", [userId, body.name, req.params.id]);
      if (clash.length) return res.status(409).json({ message: "已存在同名标签" });
      await query("UPDATE tag SET name = ? WHERE tag_id = ?", [body.name, req.params.id]);
    }
    if (body.color !== undefined) await query("UPDATE tag SET color = ? WHERE tag_id = ?", [body.color, req.params.id]);
    const rows = await query<any>("SELECT tag_id, name, color FROM tag WHERE tag_id = ?", [req.params.id]);
    res.json({ id: String(rows[0].tag_id), name: rows[0].name, color: rows[0].color });
  } catch (error) { next(error); }
});

api.delete("/tags/:id", async (req, res, next) => {
  try {
    const result = await query<any>("DELETE FROM tag WHERE tag_id = ? AND owner_id = ?", [req.params.id, req.user!.id]);
    if (!result.affectedRows) return res.status(404).json({ message: "标签不存在" });
    res.status(204).send();
  } catch (error) { next(error); }
});

api.put("/documents/:id/tags", async (req, res, next) => {
  try {
    const userId = req.user!.id;
    const document = await ownedDocument(String(req.params.id), userId);
    if (!document) return res.status(404).json({ message: "文档不存在" });
    const body = z.object({ tagIds: z.array(z.string()).max(20) }).parse(req.body);
    const tagIds = [...new Set(body.tagIds)];
    if (tagIds.length) {
      const placeholders = tagIds.map(() => "?").join(", ");
      const ownedTags = await query<any>(`SELECT tag_id FROM tag WHERE owner_id = ? AND tag_id IN (${placeholders})`, [userId, ...tagIds]);
      if (ownedTags.length !== tagIds.length) return res.status(400).json({ message: "包含无效标签" });
    }
    await query("DELETE FROM document_tag WHERE document_id = ?", [req.params.id]);
    if (tagIds.length) {
      const values = tagIds.map(() => "(?, ?)").join(", ");
      await query(`INSERT IGNORE INTO document_tag (document_id, tag_id) VALUES ${values}`, tagIds.flatMap((tagId) => [req.params.id, tagId]));
    }
    const rows = await query<any>("SELECT tag_id, name, color FROM tag JOIN document_tag dt USING (tag_id) WHERE dt.document_id = ? ORDER BY name", [req.params.id]);
    res.json(rows.map((row: any) => ({ id: String(row.tag_id), name: row.name, color: row.color })));
  } catch (error) { next(error); }
});

api.patch("/documents/:id", async (req, res, next) => {
  try {
    const userId = req.user!.id;
    const body = z.object({ name: z.string().trim().min(1).max(512) }).parse(req.body);
    const document = await ownedDocument(String(req.params.id), userId);
    if (!document) return res.status(404).json({ message: "资料不存在" });
    const extension = String(document.file_extension ?? "").toLowerCase();
    let name = body.name.trim();
    if (/[\\/\0\r\n]/.test(name) || name === "." || name === "..") {
      return res.status(400).json({ message: "名称不能包含路径或换行符" });
    }
    const enteredExtension = path.extname(name).toLowerCase();
    if (enteredExtension && enteredExtension !== extension) {
      return res.status(400).json({ message: `文件类型由内容决定，名称需要保留 ${extension} 扩展名` });
    }
    if (!enteredExtension && extension) name += extension;
    if (name.length > 512) return res.status(400).json({ message: "名称过长" });

    await transaction(async (connection) => {
      await connection.query(
        "UPDATE documents SET original_file_name = ? WHERE document_id = ? AND owner_id = ? AND deleted_at IS NULL",
        [name, req.params.id, userId],
      );
      await connection.query(
        `UPDATE message_source ms
         INNER JOIN chat_message m ON m.message_id = ms.message_id
         INNER JOIN chat_session s ON s.session_id = m.session_id
         SET ms.document_name = ?
         WHERE ms.document_id = ? AND s.owner_id = ?`,
        [name, req.params.id, userId],
      );
    });
    const rows = await query<any>("SELECT d.* FROM documents d WHERE d.document_id = ? AND d.owner_id = ? AND d.deleted_at IS NULL", [req.params.id, userId]);
    res.json((await withTags(rows))[0]);
  } catch (error) { next(error); }
});

api.post("/documents/batch", async (req, res, next) => {
  try {
    const userId = req.user!.id;
    const body = z.object({
      ids: z.array(z.string()).min(1).max(200),
      action: z.literal("tag"),
      tagIds: z.array(z.string()).max(50).optional(),
    }).parse(req.body);
    const ids = [...new Set(body.ids)];
    const placeholders = ids.map(() => "?").join(", ");
    const owned = await query<any>(
      `SELECT document_id FROM documents WHERE owner_id = ? AND deleted_at IS NULL AND document_id IN (${placeholders})`,
      [userId, ...ids],
    );
    const ownedIds: string[] = (owned as any[]).map((row) => String(row.document_id));
    if (!ownedIds.length) return res.json({ updated: 0 });
    {
      const tagIds = [...new Set(body.tagIds ?? [])];
      if (!tagIds.length) return res.status(400).json({ message: "请选择要添加的标签" });
      const tagPlaceholders = tagIds.map(() => "?").join(", ");
      const ownedTags = await query<any>(`SELECT tag_id FROM tag WHERE owner_id = ? AND tag_id IN (${tagPlaceholders})`, [userId, ...tagIds]);
      const validTags: string[] = (ownedTags as any[]).map((row) => String(row.tag_id));
      const pairs = ownedIds.flatMap((documentId) => validTags.map((tagId) => [documentId, tagId]));
      if (pairs.length) {
        const values = pairs.map(() => "(?, ?)").join(", ");
        await query(`INSERT IGNORE INTO document_tag (document_id, tag_id) VALUES ${values}`, pairs.flat());
      }
    }
    res.json({ updated: ownedIds.length });
  } catch (error) { next(error); }
});

// ---------- Notes ----------

api.get("/documents/:id/notes", async (req, res, next) => {
  try {
    const document = await ownedDocument(req.params.id, req.user!.id);
    if (!document) return res.status(404).json({ message: "文档不存在" });
    const rows = await query<any>(
      "SELECT * FROM document_note WHERE document_id = ? AND owner_id = ? ORDER BY created_at DESC, note_id DESC",
      [req.params.id, req.user!.id],
    );
    res.json(rows.map(publicNote));
  } catch (error) { next(error); }
});

api.post("/documents/:id/notes", async (req, res, next) => {
  try {
    const userId = req.user!.id;
    const document = await ownedDocument(String(req.params.id), userId);
    if (!document) return res.status(404).json({ message: "文档不存在" });
    const body = z.object({
      content: z.string().trim().min(1).max(4000),
      quote: z.string().trim().max(1000).optional(),
      color: z.string().trim().max(20).optional(),
      chunkId: z.string().optional(),
      sourceType: z.enum(["manual", "excerpt"]).optional(),
    }).parse(req.body);
    if (body.chunkId) {
      const chunks = await query<any>("SELECT chunk_id FROM document_chunk WHERE chunk_id = ? AND document_id = ?", [body.chunkId, req.params.id]);
      if (!chunks.length) return res.status(400).json({ message: "关联的分块不存在" });
    }
    const sourceType = body.sourceType ?? (body.quote ? "excerpt" : "manual");
    const created = await query<any>(
      "INSERT INTO document_note (owner_id, document_id, chunk_id, quote, content, color, source_type) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [userId, req.params.id, body.chunkId ?? null, body.quote ?? null, body.content, body.color ?? null, sourceType],
    );
    const rows = await query<any>("SELECT * FROM document_note WHERE note_id = ?", [created.insertId]);
    res.status(201).json(publicNote(rows[0]));
  } catch (error) { next(error); }
});

api.patch("/notes/:id", async (req, res, next) => {
  try {
    const userId = req.user!.id;
    const body = z.object({ content: z.string().trim().min(1).max(4000).optional(), color: z.string().trim().max(20).nullable().optional() }).parse(req.body);
    const updates: string[] = [];
    const params: unknown[] = [];
    if (body.content !== undefined) { updates.push("content = ?"); params.push(body.content); }
    if (body.color !== undefined) { updates.push("color = ?"); params.push(body.color); }
    if (!updates.length) return res.status(400).json({ message: "没有需要更新的字段" });
    const result = await query<any>(`UPDATE document_note SET ${updates.join(", ")} WHERE note_id = ? AND owner_id = ?`, [...params, req.params.id, userId]);
    if (!result.affectedRows) return res.status(404).json({ message: "笔记不存在" });
    const rows = await query<any>("SELECT * FROM document_note WHERE note_id = ?", [req.params.id]);
    res.json(publicNote(rows[0]));
  } catch (error) { next(error); }
});

api.delete("/notes/:id", async (req, res, next) => {
  try {
    const result = await query<any>("DELETE FROM document_note WHERE note_id = ? AND owner_id = ?", [req.params.id, req.user!.id]);
    if (!result.affectedRows) return res.status(404).json({ message: "笔记不存在" });
    res.status(204).send();
  } catch (error) { next(error); }
});

// ---------- Related documents ----------

function cosineSimilarity(a: number[], b: number[]) {
  if (a.length !== b.length || !a.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < a.length; index += 1) {
    dot += a[index] * b[index];
    normA += a[index] ** 2;
    normB += b[index] ** 2;
  }
  return normA && normB ? dot / (Math.sqrt(normA) * Math.sqrt(normB)) : 0;
}

function parseEmbedding(value: unknown): number[] | null {
  if (Array.isArray(value)) return value as number[];
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

api.get("/documents/:id/related", async (req, res, next) => {
  try {
    const userId = req.user!.id;
    const document = await ownedDocument(req.params.id, userId);
    if (!document) return res.status(404).json({ message: "文档不存在" });
    const limit = z.coerce.number().int().min(1).max(10).catch(5).parse(req.query.limit ?? 5);
    const anchor = await query<any>(
      "SELECT embedding_json FROM document_chunk WHERE document_id = ? AND embedding_json IS NOT NULL LIMIT 1",
      [req.params.id],
    );
    const vector = anchor.length ? parseEmbedding(anchor[0].embedding_json) : null;
    if (!vector) return res.json([]);

    const best = new Map<string, { documentId: string; score: number; snippet: string }>();
    if (isVectorStoreConfigured()) {
      const hits = await searchVectors(vector, userId, limit * 6 + 10, String(req.params.id)).catch(() => []);
      for (const hit of hits) {
        const documentId = hit.payload.documentId;
        if (!documentId || documentId === String(req.params.id)) continue;
        const current = best.get(documentId);
        if (!current || hit.score > current.score) best.set(documentId, { documentId, score: hit.score, snippet: hit.payload.content.slice(0, 160) });
      }
    } else {
      const rows = await query<any>(
        `SELECT c.document_id, c.content, c.embedding_json FROM document_chunk c
         INNER JOIN documents d ON d.document_id = c.document_id
         WHERE d.owner_id = ? AND d.deleted_at IS NULL AND c.embedding_json IS NOT NULL AND c.document_id <> ?
         LIMIT 3000`,
        [userId, req.params.id],
      );
      for (const row of rows) {
        const other = parseEmbedding(row.embedding_json);
        if (!other) continue;
        const score = cosineSimilarity(vector, other);
        const documentId = String(row.document_id);
        const current = best.get(documentId);
        if (!current || score > current.score) best.set(documentId, { documentId, score, snippet: String(row.content).slice(0, 160) });
      }
    }

    const ranked = [...best.values()].sort((a, b) => b.score - a.score).slice(0, limit);
    if (!ranked.length) return res.json([]);
    const placeholders = ranked.map(() => "?").join(", ");
    const docs = await query<any>(
      `SELECT d.* FROM documents d WHERE d.owner_id = ? AND d.deleted_at IS NULL AND d.document_id IN (${placeholders})`,
      [userId, ...ranked.map((item) => item.documentId)],
    );
    const byId = new Map(docs.map((row: any) => [String(row.document_id), row]));
    res.json(ranked
      .filter((item) => byId.has(item.documentId))
      .map((item) => ({ ...publicDocument(byId.get(item.documentId)), score: item.score, snippet: item.snippet })));
  } catch (error) { next(error); }
});

api.patch("/messages/:id/feedback", async (req, res, next) => {
  try {
    const userId = req.user!.id;
    const body = z.object({ value: z.union([z.literal(1), z.literal(0), z.literal(-1)]) }).parse(req.body);
    const rows = await query<any>(
      `SELECT m.message_id FROM chat_message m INNER JOIN chat_session s ON s.session_id = m.session_id
       WHERE m.message_id = ? AND s.owner_id = ?`,
      [req.params.id, userId],
    );
    if (!rows.length) return res.status(404).json({ message: "消息不存在" });
    await query("UPDATE chat_message SET feedback = ? WHERE message_id = ?", [body.value === 0 ? null : body.value, req.params.id]);
    res.json({ value: body.value });
  } catch (error) { next(error); }
});

api.post("/chat/suggestions", async (req, res, next) => {
  try {
    const userId = req.user!.id;
    const body = z.object({ messageId: z.string().min(1) }).parse(req.body);
    const rows = await query<any>(
      `SELECT m.session_id, m.content FROM chat_message m INNER JOIN chat_session s ON s.session_id = m.session_id
       WHERE m.message_id = ? AND s.owner_id = ?`,
      [body.messageId, userId],
    );
    if (!rows.length) return res.status(404).json({ message: "消息不存在" });
    if (!config.ai.baseUrl || !config.ai.utilityModel) return res.json([]);

    const questionRows = await query<any>(
      "SELECT content FROM chat_message WHERE session_id = ? AND role = 'user' AND message_id < ? ORDER BY message_id DESC LIMIT 1",
      [rows[0].session_id, body.messageId],
    );
    const sources = await query<any>("SELECT snippet FROM message_source WHERE message_id = ? ORDER BY source_order LIMIT 3", [body.messageId]);
    const context = sources.map((source: any) => source.snippet).join("\n").slice(0, 1500);
    const raw = await chatCompletion([
      { role: "system", content: "你是知识库助手。根据用户的问题、已有回答和资料来源，生成 3 个用户可能想继续追问的问题。只输出一个 JSON 字符串数组，每项不超过 20 个字，不要输出其他内容。" },
      { role: "user", content: `问题：${questionRows[0]?.content ?? ""}\n\n回答要点：${String(rows[0].content).slice(0, 800)}\n\n资料：\n${context}` },
    ], config.ai.utilityModel).catch(() => null);
    const suggestions = stringList(parseJson(raw ?? "", [])).slice(0, 3);
    res.json(suggestions);
  } catch (error) { next(error); }
});

// ---------- Document AI summary ----------

api.get("/documents/:id/summary", async (req, res, next) => {
  try {
    const document = await ownedDocument(req.params.id, req.user!.id);
    if (!document) return res.status(404).json({ message: "文档不存在" });
    res.json(await getDocumentSummary(req.params.id, req.user!.id));
  } catch (error) { next(error); }
});

api.post("/documents/:id/summary", async (req, res, next) => {
  try {
    const document = await ownedDocument(req.params.id, req.user!.id);
    if (!document) return res.status(404).json({ message: "文档不存在" });
    if (document.parse_status !== "parsed") return res.status(400).json({ message: "文档尚未解析完成" });
    await enqueueSummary(String(req.params.id));
    res.status(202).json(await getDocumentSummary(String(req.params.id), req.user!.id));
  } catch (error) { next(error); }
});

// ---------- Collections (long-lived working scope over several documents) ----------

function publicCollection(row: any) {
  return {
    id: String(row.collection_id),
    name: row.name,
    description: row.description,
    documentCount: row.document_count === undefined ? undefined : Number(row.document_count),
    isSmart: Boolean(row.is_smart),
    smartFilter: parseJson(row.smart_filter, null),
    updatedAt: row.updated_at,
  };
}

async function ownedCollection(collectionId: string, userId: string) {
  const rows = await query<any>("SELECT * FROM collection WHERE collection_id = ? AND owner_id = ?", [collectionId, userId]);
  return rows[0];
}

function appendDocumentTypeFilter(conditions: string[], params: unknown[], type: unknown) {
  if (typeof type !== "string" || !type) return;
  const extensions: Record<string, string[]> = {
    PDF: [".pdf"], Word: [".doc", ".docx"], Markdown: [".md", ".markdown"], HTML: [".html", ".htm"], CSV: [".csv"], TXT: [".txt"],
  };
  const values = extensions[type] ?? [];
  if (!values.length) return;
  conditions.push(`d.file_extension IN (${values.map(() => "?").join(", ")})`);
  params.push(...values);
}

async function insertCollectionDocuments(collectionId: string, userId: string, documentIds: string[]) {
  const ids = [...new Set(documentIds)];
  if (!ids.length) return 0;
  const placeholders = ids.map(() => "?").join(", ");
  const owned = await query<any>(
    `SELECT document_id FROM documents WHERE owner_id = ? AND deleted_at IS NULL AND document_id IN (${placeholders})`,
    [userId, ...ids],
  );
  const valid: string[] = (owned as any[]).map((row) => String(row.document_id));
  if (!valid.length) return 0;
  const values = valid.map(() => "(?, ?)").join(", ");
  await query(`INSERT IGNORE INTO collection_document (collection_id, document_id) VALUES ${values}`, valid.flatMap((id) => [collectionId, id]));
  return valid.length;
}

async function smartCollectionDocuments(collection: any, userId: string) {
  const filter = parseJson<Record<string, unknown>>(collection.smart_filter, {});
  const conditions = ["d.owner_id = ?", "d.deleted_at IS NULL"];
  const params: unknown[] = [userId];
  const smartQuery = typeof filter.q === "string" ? filter.q.trim().slice(0, 100) : "";
  if (smartQuery) {
    const like = `%${smartQuery.replace(/[\\%_]/g, "\\$&")}%`;
    conditions.push("(d.original_file_name LIKE ? OR EXISTS (SELECT 1 FROM document_chunk ch WHERE ch.document_id = d.document_id AND ch.content LIKE ?))");
    params.push(like, like);
  }
  if (typeof filter.tagId === "string" && filter.tagId) { conditions.push("EXISTS (SELECT 1 FROM document_tag dt WHERE dt.document_id = d.document_id AND dt.tag_id = ?)"); params.push(filter.tagId); }
  if (typeof filter.status === "string" && ["pending", "parsing", "parsed", "failed"].includes(filter.status)) { conditions.push("d.parse_status = ?"); params.push(filter.status); }
  appendDocumentTypeFilter(conditions, params, filter.type);
  return query<any>(`SELECT d.* FROM documents d WHERE ${conditions.join(" AND ")} ORDER BY d.uploaded_at DESC, d.document_id DESC`, params);
}

api.get("/collections", async (req, res, next) => {
  try {
    const rows = await query<any>(
      `SELECT c.collection_id, c.name, c.description, c.updated_at, c.is_smart, c.smart_filter, COUNT(cd.document_id) AS document_count
       FROM collection c
       LEFT JOIN collection_document cd ON cd.collection_id = c.collection_id
       WHERE c.owner_id = ?
       GROUP BY c.collection_id, c.name, c.description, c.updated_at, c.is_smart, c.smart_filter
       ORDER BY c.updated_at DESC, c.collection_id DESC`,
      [req.user!.id],
    );
    const result = await Promise.all(rows.map(async (row: any) => {
      if (!row.is_smart) return publicCollection(row);
      const smartRows = await smartCollectionDocuments(row, req.user!.id);
      return publicCollection({ ...row, document_count: smartRows.length });
    }));
    res.json(result);
  } catch (error) { next(error); }
});

api.post("/collections", async (req, res, next) => {
  try {
    const userId = req.user!.id;
    const body = z.object({
      name: z.string().trim().min(1).max(100),
      description: z.string().trim().max(500).optional(),
      documentIds: z.array(z.string()).max(200).optional(),
      isSmart: z.boolean().optional(),
      smartFilter: z.object({ q: z.string().max(100).optional(), tagId: z.string().optional(), type: z.string().max(20).optional(), status: z.enum(["pending", "parsing", "parsed", "failed"]).optional() }).optional(),
    }).parse(req.body);
    const created = await query<any>(
      "INSERT INTO collection (owner_id, name, description, is_smart, smart_filter) VALUES (?, ?, ?, ?, ?)",
      [userId, body.name, body.description ?? null, Boolean(body.isSmart && body.smartFilter), body.isSmart && body.smartFilter ? JSON.stringify(body.smartFilter) : null],
    );
    const collectionId = String(created.insertId);
    if (body.documentIds?.length) await insertCollectionDocuments(collectionId, userId, body.documentIds);
    const rows = await query<any>(
      `SELECT c.*, (SELECT COUNT(*) FROM collection_document cd WHERE cd.collection_id = c.collection_id) AS document_count
       FROM collection c WHERE c.collection_id = ?`,
      [collectionId],
    );
    res.status(201).json(publicCollection(rows[0]));
  } catch (error) { next(error); }
});

api.get("/collections/:id", async (req, res, next) => {
  try {
    const userId = req.user!.id;
    const collection = await ownedCollection(req.params.id, userId);
    if (!collection) return res.status(404).json({ message: "专题不存在" });
    const documents = collection.is_smart
      ? await smartCollectionDocuments(collection, userId)
      : await query<any>(
        `SELECT d.* FROM collection_document cd
         INNER JOIN documents d ON d.document_id = cd.document_id
         WHERE cd.collection_id = ? AND d.deleted_at IS NULL
         ORDER BY cd.created_at DESC, d.document_id DESC`,
        [req.params.id],
      );
    res.json({
      ...publicCollection({ ...collection, document_count: documents.length }),
      documents: await withTags(documents),
    });
  } catch (error) { next(error); }
});

api.patch("/collections/:id", async (req, res, next) => {
  try {
    const userId = req.user!.id;
    const collection = await ownedCollection(req.params.id, userId);
    if (!collection) return res.status(404).json({ message: "专题不存在" });
    const body = z.object({
      name: z.string().trim().min(1).max(100).optional(),
      description: z.string().trim().max(500).nullable().optional(),
      isSmart: z.boolean().optional(),
      smartFilter: z.object({ q: z.string().max(100).optional(), tagId: z.string().optional(), type: z.string().max(20).optional(), status: z.enum(["pending", "parsing", "parsed", "failed"]).optional() }).nullable().optional(),
    }).parse(req.body);
    const updates: string[] = [];
    const params: unknown[] = [];
    if (body.name !== undefined) { updates.push("name = ?"); params.push(body.name); }
    if (body.description !== undefined) { updates.push("description = ?"); params.push(body.description); }
    if (body.smartFilter !== undefined) { updates.push("is_smart = ?", "smart_filter = ?"); params.push(Boolean(body.smartFilter), body.smartFilter ? JSON.stringify(body.smartFilter) : null); }
    if (!updates.length) return res.status(400).json({ message: "没有需要更新的字段" });
    await query(`UPDATE collection SET ${updates.join(", ")} WHERE collection_id = ? AND owner_id = ?`, [...params, req.params.id, userId]);
    const rows = await query<any>(
      `SELECT c.*, (SELECT COUNT(*) FROM collection_document cd WHERE cd.collection_id = c.collection_id) AS document_count
       FROM collection c WHERE c.collection_id = ?`,
      [req.params.id],
    );
    res.json(publicCollection(rows[0]));
  } catch (error) { next(error); }
});

api.delete("/collections/:id", async (req, res, next) => {
  try {
    const result = await query<any>("DELETE FROM collection WHERE collection_id = ? AND owner_id = ?", [req.params.id, req.user!.id]);
    if (!result.affectedRows) return res.status(404).json({ message: "专题不存在" });
    res.status(204).send();
  } catch (error) { next(error); }
});

api.post("/collections/:id/documents", async (req, res, next) => {
  try {
    const userId = req.user!.id;
    const collection = await ownedCollection(req.params.id, userId);
    if (!collection) return res.status(404).json({ message: "专题不存在" });
    if (collection.is_smart) return res.status(409).json({ message: "智能专题由筛选条件自动维护，不能手动加入资料" });
    const body = z.object({ documentIds: z.array(z.string()).min(1).max(200) }).parse(req.body);
    const added = await insertCollectionDocuments(req.params.id, userId, body.documentIds);
    res.json({ added });
  } catch (error) { next(error); }
});

api.delete("/collections/:id/documents/:documentId", async (req, res, next) => {
  try {
    const userId = req.user!.id;
    const collection = await ownedCollection(req.params.id, userId);
    if (!collection) return res.status(404).json({ message: "专题不存在" });
    if (collection.is_smart) return res.status(409).json({ message: "智能专题由筛选条件自动维护，不能手动移出资料" });
    await query("DELETE FROM collection_document WHERE collection_id = ? AND document_id = ?", [req.params.id, req.params.documentId]);
    res.status(204).send();
  } catch (error) { next(error); }
});

// ---------- Save an AI answer as a note ----------

api.post("/messages/:id/save-note", async (req, res, next) => {
  try {
    const userId = req.user!.id;
    const body = z.object({ content: z.string().trim().min(1).max(4000).optional(), documentId: z.string().optional() }).parse(req.body);
    const rows = await query<any>(
      `SELECT m.message_id, m.session_id, m.content,
              (SELECT ms.document_id FROM message_source ms WHERE ms.message_id = m.message_id ORDER BY ms.source_order LIMIT 1) AS document_id
       FROM chat_message m INNER JOIN chat_session s ON s.session_id = m.session_id
       WHERE m.message_id = ? AND s.owner_id = ? AND m.role = 'assistant'`,
      [req.params.id, userId],
    );
    if (!rows.length) return res.status(404).json({ message: "消息不存在" });
    let documentId = body.documentId ?? (rows[0].document_id ? String(rows[0].document_id) : null);
    if (!documentId) {
      // Summary / multi-document answers have no chunk source; fall back to the
      // documents the question was scoped to.
      const scopeRows = await query<any>(
        "SELECT scope_snapshot FROM chat_message WHERE session_id = ? AND role = 'user' AND message_id < ? ORDER BY message_id DESC LIMIT 1",
        [rows[0].session_id, req.params.id],
      );
      const snapshot = scopeRows.length ? parseJson<Record<string, unknown>>(scopeRows[0].scope_snapshot, {}) : {};
      const scoped = stringList(snapshot?.documentIds);
      documentId = scoped[0] ?? null;
    }
    if (!documentId) return res.status(400).json({ message: "该回答没有可关联的资料，无法保存为笔记" });
    const document = await query<any>("SELECT document_id FROM documents WHERE document_id = ? AND owner_id = ? AND deleted_at IS NULL", [documentId, userId]);
    if (!document.length) return res.status(400).json({ message: "关联的资料不存在" });
    const content = body.content?.trim() || String(rows[0].content).slice(0, 4000);
    const created = await query<any>(
      `INSERT INTO document_note (owner_id, document_id, chunk_id, quote, content, source_type, source_message_id)
       VALUES (?, ?, NULL, NULL, ?, 'chat', ?)`,
      [userId, documentId, content, req.params.id],
    );
    const noteRows = await query<any>("SELECT * FROM document_note WHERE note_id = ?", [created.insertId]);
    res.status(201).json(publicNote(noteRows[0]));
  } catch (error) { next(error); }
});

// ---------- Create a document by pasting text ----------

api.post("/documents/text", async (req, res, next) => {
  let storedPath: string | null = null;
  try {
    const userId = req.user!.id;
    const body = z.object({
      title: z.string().trim().min(1).max(120),
      content: z.string().trim().min(1).max(200000),
    }).parse(req.body);

    const buffer = Buffer.from(body.content, "utf8");
    const fileHash = crypto.createHash("sha256").update(buffer).digest("hex");
    const existing = await query<any>("SELECT document_id FROM documents WHERE owner_id = ? AND file_hash = ? AND deleted_at IS NULL LIMIT 1", [userId, fileHash]);
    if (existing.length) return res.status(409).json({ message: "相同内容已经导入过了", documentId: String(existing[0].document_id) });

    const storedName = `${crypto.randomBytes(16).toString("hex")}.md`;
    storedPath = path.join(config.uploadDir, storedName);
    await fs.writeFile(storedPath, buffer);
    const displayName = body.title.toLowerCase().endsWith(".md") ? body.title : `${body.title}.md`;
    const result = await query<any>(
      `INSERT INTO documents
        (owner_id, original_file_name, stored_file_name, storage_key, mime_type, file_extension, file_size, file_hash, parse_status)
       VALUES (?, ?, ?, ?, 'text/markdown', '.md', ?, ?, 'pending')`,
      [userId, displayName, storedName, storedName, buffer.length, fileHash],
    );
    const documentId = String(result.insertId);
    await enqueueDocument(documentId);
    const rows = await query<any>("SELECT d.* FROM documents d WHERE d.document_id = ?", [documentId]);
    res.status(201).json((await withTags(rows))[0]);
  } catch (error) { next(error); }
  finally {
    // If insertion or queueing failed after the file was written, do not leave
    // an unreferenced object in local storage.
    if (storedPath) {
      const rows = await query<any>("SELECT document_id FROM documents WHERE storage_key = ? LIMIT 1", [path.basename(storedPath)]).catch(() => []);
      if (!rows.length) await fs.rm(storedPath, { force: true }).catch(() => undefined);
    }
  }
});

// ---------- Import a web page as a document ----------

api.post("/documents/url", async (req, res, next) => {
  let storedPath: string | null = null;
  try {
    const userId = req.user!.id;
    const body = z.object({
      url: z.string().trim().url().max(2000),
      title: z.string().trim().max(120).optional(),
    }).parse(req.body);
    const target = new URL(body.url);
    const response = await fetchPublicText(target, 2_000_000);
    if (!response.ok) return res.status(400).json({ message: `网页请求失败（${response.status}）` });
    const contentType = response.contentType;
    if (contentType && !/text\/html|text\/plain|application\/xhtml\+xml/i.test(contentType)) {
      return res.status(415).json({ message: "该地址不是 HTML 或纯文本页面" });
    }
    const raw = response.text;
    const content = /text\/html|xhtml/i.test(contentType) || /<html[\s>]/i.test(raw) ? htmlToText(raw) : raw.trim();
    if (!content) return res.status(400).json({ message: "网页没有可提取的正文" });
    const titleMatch = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = (body.title || (titleMatch ? htmlToText(titleMatch[1]) : "") || response.url.hostname).slice(0, 120);
    const buffer = Buffer.from(`# ${title}\n\n来源：${response.url.href}\n\n${content}`, "utf8");
    const fileHash = crypto.createHash("sha256").update(buffer).digest("hex");
    const existing = await query<any>("SELECT document_id FROM documents WHERE owner_id = ? AND file_hash = ? LIMIT 1", [userId, fileHash]);
    if (existing.length) return res.status(409).json({ message: "相同网页内容已经导入过了", documentId: String(existing[0].document_id) });
    const storedName = `${crypto.randomBytes(16).toString("hex")}.md`;
    storedPath = path.join(config.uploadDir, storedName);
    await fs.writeFile(storedPath, buffer);
    const result = await query<any>(
      `INSERT INTO documents
        (owner_id, original_file_name, stored_file_name, storage_key, mime_type, file_extension, file_size, file_hash, parse_status)
       VALUES (?, ?, ?, ?, 'text/markdown', '.md', ?, ?, 'pending')`,
      [userId, `${title}.md`, storedName, storedName, buffer.length, fileHash],
    );
    const documentId = String(result.insertId);
    await enqueueDocument(documentId);
    const rows = await query<any>("SELECT d.* FROM documents d WHERE d.document_id = ?", [documentId]);
    res.status(201).json((await withTags(rows))[0]);
  } catch (error) { next(error); }
  finally {
    if (storedPath) {
      const rows = await query<any>("SELECT document_id FROM documents WHERE storage_key = ? LIMIT 1", [path.basename(storedPath)]).catch(() => []);
      if (!rows.length) await fs.rm(storedPath, { force: true }).catch(() => undefined);
    }
  }
});

api.post("/documents", upload.single("file"), async (req, res, next) => {
  const file = req.file;
  try {
    if (!file) return res.status(400).json({ message: "请选择支持的 PDF、DOCX、Markdown、HTML 或 TXT 文件" });
    const originalFileName = displayFilename(file.originalname);
    const ownerId = req.user!.id;
    const buffer = await fs.readFile(file.path);
    const extension = path.extname(originalFileName).toLowerCase();
    const isPdf = extension === ".pdf" && buffer.subarray(0, 5).toString() === "%PDF-";
    const isZipDocument = extension === ".docx" && buffer[0] === 0x50 && buffer[1] === 0x4b;
    const isText = [".md", ".markdown", ".txt", ".html", ".htm", ".csv"].includes(extension);
    if (!(isPdf || isZipDocument || isText)) {
      await fs.rm(file.path, { force: true });
      return res.status(415).json({ message: "文件内容与扩展名不匹配，无法安全解析" });
    }
    const fileHash = crypto.createHash("sha256").update(buffer).digest("hex");
    const existing = await query<any>(
      "SELECT document_id FROM documents WHERE owner_id = ? AND file_hash = ? AND deleted_at IS NULL LIMIT 1",
      [ownerId, fileHash],
    );
    if (existing.length) {
      await fs.rm(file.path, { force: true });
      return res.status(409).json({ message: "该文件已经上传过了", documentId: String(existing[0].document_id) });
    }

    const result = await query<any>(
      `INSERT INTO documents
        (owner_id, original_file_name, stored_file_name, storage_key, mime_type,
         file_extension, file_size, file_hash, parse_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
      [ownerId, originalFileName, file.filename, file.filename, file.mimetype, extension, file.size, fileHash],
    );
    const documentId = String(result.insertId);
    await enqueueDocument(documentId);
    const rows = await query<any>("SELECT d.* FROM documents d WHERE d.document_id = ?", [documentId]);
    res.status(201).json((await withTags(rows))[0]);
  } catch (error) {
    if (file) await fs.rm(file.path, { force: true }).catch(() => undefined);
    next(error);
  }
});

api.get("/documents/:id/versions", async (req, res, next) => {
  try {
    const document = await ownedDocument(req.params.id, req.user!.id);
    if (!document) return res.status(404).json({ message: "文档不存在" });
    const rows = await query<any>(
      `SELECT version_id, version_no, original_file_name, file_extension, file_size, file_hash, created_at
       FROM document_version WHERE document_id = ? ORDER BY version_no DESC`,
      [req.params.id],
    );
    res.json(rows.map((row: any) => ({
      id: String(row.version_id), versionNo: Number(row.version_no), name: displayFilename(row.original_file_name),
      fileExtension: row.file_extension, sizeKB: Math.max(1, Math.round(Number(row.file_size) / 1024)),
      fileHash: row.file_hash, createdAt: row.created_at,
    })));
  } catch (error) { next(error); }
});

api.post("/documents/:id/versions", upload.single("file"), async (req, res, next) => {
  const file = req.file;
  let snapshotKey: string | null = null;
  let newStoredPath: string | null = null;
  let completed = false;
  let documentUpdated = false;
  try {
    if (!file) return res.status(400).json({ message: "请选择要替换的新版本文件" });
    const userId = req.user!.id;
    const document = await ownedDocument(String(req.params.id), userId);
    if (!document) return res.status(404).json({ message: "文档不存在" });
    const originalFileName = displayFilename(file.originalname);
    const extension = path.extname(originalFileName).toLowerCase();
    const buffer = await fs.readFile(file.path);
    const isPdf = extension === ".pdf" && buffer.subarray(0, 5).toString() === "%PDF-";
    const isZipDocument = extension === ".docx" && buffer[0] === 0x50 && buffer[1] === 0x4b;
    const isText = [".md", ".markdown", ".txt", ".html", ".htm", ".csv"].includes(extension);
    if (!(isPdf || isZipDocument || isText)) return res.status(415).json({ message: "文件内容与扩展名不匹配，无法安全解析" });
    const fileHash = crypto.createHash("sha256").update(buffer).digest("hex");
    const duplicate = await query<any>("SELECT document_id FROM documents WHERE owner_id = ? AND file_hash = ? AND document_id <> ? LIMIT 1", [userId, fileHash, String(req.params.id)]);
    if (duplicate.length) return res.status(409).json({ message: "相同内容已经作为另一份资料导入过了", documentId: String(duplicate[0].document_id) });
    const snapshot = await snapshotDocumentVersion(document);
    snapshotKey = snapshot.storageKey;
    await deleteDocumentVectors(String(req.params.id));
    const storedName = `${crypto.randomBytes(16).toString("hex")}${extension}`;
    newStoredPath = safeStoragePath(storedName);
    await fs.rename(file.path, newStoredPath);
    await query(
      `UPDATE documents SET original_file_name = ?, stored_file_name = ?, storage_key = ?, mime_type = ?,
              file_extension = ?, file_size = ?, file_hash = ?, parse_status = 'pending', parse_error = NULL,
              parse_warning = NULL, parsed_at = NULL, indexed_at = NULL, content_version = content_version + 1
       WHERE document_id = ? AND owner_id = ?`,
      [originalFileName, storedName, storedName, file.mimetype, extension, file.size, fileHash, req.params.id, userId],
    );
    documentUpdated = true;
    await query("DELETE FROM document_chunk WHERE document_id = ?", [req.params.id]);
    await enqueueDocument(String(req.params.id));
    const rows = await query<any>("SELECT d.* FROM documents d WHERE d.document_id = ?", [req.params.id]);
    res.status(201).json({ document: (await withTags(rows))[0], version: { id: snapshot.versionId, versionNo: snapshot.versionNo } });
    completed = true;
    snapshotKey = null;
  } catch (error) { next(error); }
  finally {
    if (file) await fs.rm(file.path, { force: true }).catch(() => undefined);
    if (!completed && !documentUpdated && newStoredPath) await fs.rm(newStoredPath, { force: true }).catch(() => undefined);
    if (!completed && !documentUpdated && snapshotKey) await query("DELETE FROM document_version WHERE storage_key = ?", [snapshotKey]).catch(() => undefined);
    if (snapshotKey && !documentUpdated) await fs.rm(safeStoragePath(snapshotKey), { force: true }).catch(() => undefined);
  }
});

api.post("/documents/:id/versions/:versionId/restore", async (req, res, next) => {
  let newStoredPath: string | null = null;
  let snapshotKey: string | null = null;
  let completed = false;
  let documentUpdated = false;
  try {
    const userId = req.user!.id;
    const rows = await query<any>(
      `SELECT d.*, v.version_id, v.original_file_name AS version_file_name, v.storage_key AS version_storage_key,
              v.mime_type AS version_mime_type, v.file_extension AS version_file_extension,
              v.file_size AS version_file_size, v.file_hash AS version_file_hash
       FROM documents d INNER JOIN document_version v ON v.document_id = d.document_id
       WHERE d.document_id = ? AND d.owner_id = ? AND d.deleted_at IS NULL AND v.version_id = ?`,
      [req.params.id, userId, req.params.versionId],
    );
    const document = rows[0];
    if (!document) return res.status(404).json({ message: "版本不存在" });
    const duplicate = await query<any>("SELECT document_id FROM documents WHERE owner_id = ? AND file_hash = ? AND document_id <> ? LIMIT 1", [userId, document.version_file_hash, req.params.id]);
    if (duplicate.length) return res.status(409).json({ message: "该版本内容已存在于另一份资料中" });
    const snapshot = await snapshotDocumentVersion(document);
    snapshotKey = snapshot.storageKey;
    await deleteDocumentVectors(String(req.params.id));
    const storedName = `${crypto.randomBytes(16).toString("hex")}${document.version_file_extension}`;
    newStoredPath = safeStoragePath(storedName);
    await fs.copyFile(safeStoragePath(document.version_storage_key), newStoredPath);
    await query(
      `UPDATE documents SET original_file_name = ?, stored_file_name = ?, storage_key = ?, mime_type = ?,
              file_extension = ?, file_size = ?, file_hash = ?, parse_status = 'pending', parse_error = NULL,
              parse_warning = NULL, parsed_at = NULL, indexed_at = NULL, content_version = content_version + 1
       WHERE document_id = ? AND owner_id = ?`,
      [document.version_file_name, storedName, storedName, document.version_mime_type, document.version_file_extension, document.version_file_size, document.version_file_hash, req.params.id, userId],
    );
    documentUpdated = true;
    await query("DELETE FROM document_chunk WHERE document_id = ?", [req.params.id]);
    await enqueueDocument(String(req.params.id));
    const updated = await query<any>("SELECT d.* FROM documents d WHERE d.document_id = ?", [req.params.id]);
    res.status(201).json({ document: (await withTags(updated))[0], preservedVersionNo: snapshot.versionNo });
    completed = true;
  } catch (error) { next(error); }
  finally {
    if (!completed && !documentUpdated && newStoredPath) await fs.rm(newStoredPath, { force: true }).catch(() => undefined);
    if (!completed && !documentUpdated && snapshotKey) await query("DELETE FROM document_version WHERE storage_key = ?", [snapshotKey]).catch(() => undefined);
    if (!completed && !documentUpdated && snapshotKey) await fs.rm(safeStoragePath(snapshotKey), { force: true }).catch(() => undefined);
  }
});

api.delete("/documents/:id", async (req, res, next) => {
  try {
    const userId = req.user!.id;
    const rows = await query<any>("SELECT storage_key FROM documents WHERE document_id = ? AND owner_id = ? AND deleted_at IS NULL", [req.params.id, userId]);
    if (!rows.length) return res.status(404).json({ message: "文档不存在" });
    const versions = await query<any>("SELECT storage_key FROM document_version WHERE document_id = ?", [req.params.id]).catch(() => []);
    await deleteDocumentVectors(String(req.params.id));
    // Delete the row so the same content can be uploaded again.  Message
    // sources keep denormalized document metadata; chunk references are
    // nullable and are cleared by the FK, while notes/collection links cascade.
    await query("DELETE FROM documents WHERE document_id = ? AND owner_id = ?", [req.params.id, userId]);
    await fs.rm(safeStoragePath(rows[0].storage_key), { force: true }).catch(() => undefined);
    await Promise.all(versions.map((version: any) => fs.rm(safeStoragePath(version.storage_key), { force: true }).catch(() => undefined)));
    res.status(204).send();
  } catch (error) { next(error); }
});

api.post("/documents/:id/retry", async (req, res, next) => {
  try {
    const userId = req.user!.id;
    const rows = await query<any>(
      "SELECT d.* FROM documents d WHERE d.document_id = ? AND d.owner_id = ? AND d.deleted_at IS NULL",
      [req.params.id, userId],
    );
    if (!rows.length) return res.status(404).json({ message: "文档不存在" });
    if (rows[0].parse_status === "parsed") {
      const failedChunks = await query<any>(
        "SELECT COUNT(*) AS failed_count FROM document_chunk WHERE document_id = ? AND embedding_status = 'failed'",
        [req.params.id],
      );
      if (Number(failedChunks[0]?.failed_count ?? 0) === 0) {
        return res.status(409).json({ message: "该资料没有失败的索引任务" });
      }
      const jobs = await query<any>(
        "SELECT job_id, status FROM document_job WHERE document_id = ? AND job_type = 'embedding' ORDER BY job_id DESC LIMIT 1",
        [req.params.id],
      );
      if (jobs[0]?.status === "pending" || jobs[0]?.status === "running") {
        return res.status(409).json({ message: "索引任务已在处理中" });
      }
      if (jobs[0]?.status === "failed") {
        const reset = await query<any>(
          `UPDATE document_job SET status = 'pending', error_message = NULL, finished_at = NULL,
                  locked_at = NULL, locked_by = NULL
           WHERE job_id = ? AND status = 'failed'`,
          [jobs[0].job_id],
        );
        if (!reset.affectedRows) return res.status(409).json({ message: "索引任务状态已变化，请刷新后重试" });
      } else {
        await query(
          `INSERT INTO document_job (document_id, job_type, status, attempt_count)
           VALUES (?, 'embedding', 'pending', 0)`,
          [req.params.id],
        );
      }
      const updatedRows = await query<any>("SELECT d.* FROM documents d WHERE d.document_id = ?", [req.params.id]);
      const [updated] = await withTags(updatedRows);
      return res.json(updated);
    }
    if (rows[0].parse_status !== "failed") return res.status(409).json({ message: "只有解析或索引失败的资料可以重试" });
    await query("UPDATE documents SET parse_status = 'pending', parse_error = NULL WHERE document_id = ?", [req.params.id]);
    await query(
      `UPDATE document_job SET status = 'skipped', finished_at = NOW(), error_message = 'replaced by retry'
       WHERE document_id = ? AND job_type = 'parse' AND status IN ('pending', 'running')`,
      [req.params.id],
    );
    await enqueueDocument(String(req.params.id));
    const [updated] = await withTags([{ ...rows[0], parse_status: "pending", parse_error: null }]);
    res.json(updated);
  } catch (error) { next(error); }
});

function stringList(value: unknown, max = 20): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === "string" ? item : typeof item === "number" ? String(item) : ""))
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, max);
}

api.get("/sessions", async (req, res, next) => {
  try {
    const keyword = z.string().trim().max(100).optional().parse(req.query.q ?? undefined);
    const like = keyword ? `%${keyword.replace(/[\\%_]/g, "\\$&")}%` : null;
    const matchSnippet = like
      ? `(SELECT LEFT(matched.content, 180) FROM chat_message matched WHERE matched.session_id = s.session_id AND matched.content LIKE ? ORDER BY matched.message_id DESC LIMIT 1)`
      : "NULL";
    const conditions = ["s.owner_id = ?"];
    const params: unknown[] = [];
    if (like) params.push(like);
    params.push(req.user!.id);
    if (like) {
      conditions.push("(s.title LIKE ? OR EXISTS (SELECT 1 FROM chat_message search_message WHERE search_message.session_id = s.session_id AND search_message.content LIKE ?))");
      params.push(like, like);
    }
    const rows = await query<any>(
      `SELECT s.session_id, s.title, s.created_at, s.updated_at, s.scope_type, s.scope_collection_id, s.scope_document_ids,
              ${matchSnippet} AS match_snippet,
              COUNT(m.message_id) AS message_count
       FROM chat_session s LEFT JOIN chat_message m ON m.session_id = s.session_id
       WHERE ${conditions.join(" AND ")}
       GROUP BY s.session_id, s.title, s.created_at, s.updated_at, s.scope_type, s.scope_collection_id, s.scope_document_ids
       ORDER BY s.updated_at DESC, s.session_id DESC`,
      params,
    );
    res.json(rows.map((row: any) => ({
      id: String(row.session_id), title: row.title, createdAt: row.created_at,
      updatedAt: row.updated_at, messageCount: Number(row.message_count),
      scopeType: row.scope_type ?? "library",
      scopeCollectionId: row.scope_collection_id ? String(row.scope_collection_id) : undefined,
      scopeDocumentIds: stringList(parseJson(row.scope_document_ids, [])),
      matchSnippet: row.match_snippet ?? null,
    })));
  } catch (error) { next(error); }
});

api.delete("/sessions/:id", async (req, res, next) => {
  try {
    const result = await query<any>(
      "DELETE FROM chat_session WHERE session_id = ? AND owner_id = ?",
      [req.params.id, req.user!.id],
    );
    if (!result.affectedRows) return res.status(404).json({ message: "会话不存在" });
    res.status(204).send();
  } catch (error) { next(error); }
});

api.patch("/sessions/:id", async (req, res, next) => {
  try {
    const body = z.object({ title: z.string().trim().min(1).max(100) }).parse(req.body);
    const owned = await query<any>(
      "SELECT session_id FROM chat_session WHERE session_id = ? AND owner_id = ?",
      [req.params.id, req.user!.id],
    );
    if (!owned.length) return res.status(404).json({ message: "会话不存在" });
    await query(
      "UPDATE chat_session SET title = ? WHERE session_id = ? AND owner_id = ?",
      [body.title, req.params.id, req.user!.id],
    );
    const rows = await query<any>(
      `SELECT s.session_id, s.title, s.created_at, s.updated_at, s.scope_type, s.scope_collection_id, s.scope_document_ids, COUNT(m.message_id) AS message_count
       FROM chat_session s LEFT JOIN chat_message m ON m.session_id = s.session_id
       WHERE s.session_id = ? AND s.owner_id = ?
       GROUP BY s.session_id, s.title, s.created_at, s.updated_at, s.scope_type, s.scope_collection_id, s.scope_document_ids`,
      [req.params.id, req.user!.id],
    );
    const row = rows[0];
    res.json({
      id: String(row.session_id), title: row.title, createdAt: row.created_at,
      updatedAt: row.updated_at, messageCount: Number(row.message_count),
      scopeType: row.scope_type ?? "library",
      scopeCollectionId: row.scope_collection_id ? String(row.scope_collection_id) : undefined,
      scopeDocumentIds: stringList(parseJson(row.scope_document_ids, [])),
    });
  } catch (error) { next(error); }
});

api.get("/sessions/:id/export", async (req, res, next) => {
  try {
    const format = z.enum(["markdown", "txt"]).parse(String(req.query.format ?? "markdown"));
    const sessionRows = await query<any>(
      "SELECT session_id, title FROM chat_session WHERE session_id = ? AND owner_id = ?",
      [req.params.id, req.user!.id],
    );
    if (!sessionRows.length) return res.status(404).json({ message: "会话不存在" });
    const session = sessionRows[0];
    const messages = await query<any>(
      `SELECT message_id, role, content, created_at FROM chat_message
       WHERE session_id = ? ORDER BY created_at, message_id`,
      [req.params.id],
    );
    const sections: string[] = format === "markdown"
      ? [`# ${session.title}`, "", `_导出时间：${new Date().toLocaleString("zh-CN")}_`, ""]
      : [`会话：${session.title}`, `导出时间：${new Date().toLocaleString("zh-CN")}`, ""];

    for (const message of messages) {
      const role = message.role === "user" ? "用户" : message.role === "assistant" ? "助手" : message.role;
      const sources = await query<any>(
        `SELECT COALESCE(ms.document_name, d.original_file_name) AS original_file_name, ms.page_no
         FROM message_source ms
         LEFT JOIN document_chunk c ON c.chunk_id = ms.chunk_id
         LEFT JOIN documents d ON d.document_id = c.document_id
         WHERE ms.message_id = ? ORDER BY ms.source_order`,
        [message.message_id],
      );
      if (format === "markdown") {
        sections.push(`## ${role}`, "", message.content, "");
        if (sources.length) {
          sections.push("来源：", ...sources.map((source: any) => `- ${displayFilename(source.original_file_name)}${source.page_no ? `（第 ${source.page_no} 页）` : ""}`), "");
        }
      } else {
        sections.push(`[${role}]`, message.content, "");
        if (sources.length) sections.push(`来源：${sources.map((source: any) => `${displayFilename(source.original_file_name)}${source.page_no ? `（第 ${source.page_no} 页）` : ""}`).join("；")}`, "");
      }
    }

    const extension = format === "markdown" ? "md" : "txt";
    const fileName = String(session.title).replace(/[\\/:*?"<>|]/g, "_").trim() || "会话";
    res.setHeader("Content-Type", format === "markdown" ? "text/markdown; charset=utf-8" : "text/plain; charset=utf-8");
    res.setHeader("Content-Disposition", contentDisposition(`${fileName}.${extension}`, "attachment"));
    res.send(`${sections.join("\n")}\n`);
  } catch (error) { next(error); }
});

api.get("/sessions/:id/messages", async (req, res, next) => {
  try {
    const userId = req.user!.id;
    const rows = await query<any>(
      `SELECT m.* FROM chat_message m INNER JOIN chat_session s ON s.session_id = m.session_id
       WHERE m.session_id = ? AND s.owner_id = ? ORDER BY m.created_at, m.message_id`,
      [req.params.id, userId],
    );
    const messageIds = rows.map((row: any) => row.message_id);
    const sourceRows = messageIds.length ? await query<any>(
      `SELECT ms.message_id, ms.chunk_id, ms.snippet, ms.page_no, ms.section_title,
              COALESCE(ms.document_id, d.document_id) AS document_id,
              COALESCE(ms.document_name, d.original_file_name) AS original_file_name,
              COALESCE(ms.file_extension, d.file_extension) AS file_extension
       FROM message_source ms
       LEFT JOIN document_chunk c ON c.chunk_id = ms.chunk_id
       LEFT JOIN documents d ON d.document_id = c.document_id
       WHERE ms.message_id IN (${messageIds.map(() => "?").join(", ")}) ORDER BY ms.message_id, ms.source_order`,
      messageIds,
    ) : [];
    const sourcesByMessage = new Map<string, any[]>();
    for (const source of sourceRows) {
      const list = sourcesByMessage.get(String(source.message_id)) ?? [];
      list.push(source);
      sourcesByMessage.set(String(source.message_id), list);
    }
    const messages = rows.map((row: any) => {
      const sources = sourcesByMessage.get(String(row.message_id)) ?? [];
      return {
        id: String(row.message_id), role: row.role, content: row.content, noMatch: Boolean(row.no_match),
        answerSource: row.answer_source ?? "fallback",
        sources: sources.map((source: any) => ({
          docId: source.chunk_id !== null && source.chunk_id !== undefined ? String(source.chunk_id) : String(source.document_id ?? ""),
          chunkId: source.chunk_id !== null && source.chunk_id !== undefined ? String(source.chunk_id) : undefined,
          documentId: source.document_id !== null && source.document_id !== undefined ? String(source.document_id) : undefined,
          docName: displayFilename(source.original_file_name ?? ""),
          snippet: source.snippet,
          pageNo: source.page_no,
          sectionTitle: source.section_title,
          fileExtension: source.file_extension,
        })),
      };
    });
    res.json(messages);
  } catch (error) { next(error); }
});

const scopeSchema = z.object({
  type: z.enum(["library", "collection", "documents"]),
  collectionId: z.string().optional(),
  documentIds: z.array(z.string()).max(50).optional(),
});
const chatBody = z.object({
  sessionId: z.string().optional(),
  content: z.string().trim().min(1).max(10000),
  scope: scopeSchema.optional(),
});

interface ResolvedScope {
  restricted: boolean;
  documentIds: string[];
  snapshot: Record<string, unknown>;
}

/** Turns a requested scope into the concrete, ownership-checked document ids to search. */
async function resolveScope(userId: string, scope?: z.infer<typeof scopeSchema>): Promise<ResolvedScope> {
  if (!scope || scope.type === "library") {
    return { restricted: false, documentIds: [], snapshot: { type: "library" } };
  }
  if (scope.type === "collection") {
    if (!scope.collectionId) return { restricted: true, documentIds: [], snapshot: { type: "collection", collectionId: null, documentIds: [] } };
    const owned = await query<any>("SELECT collection_id FROM collection WHERE collection_id = ? AND owner_id = ?", [scope.collectionId, userId]);
    if (!owned.length) return { restricted: true, documentIds: [], snapshot: { type: "collection", collectionId: scope.collectionId, documentIds: [] } };
    const rows = await query<any>(
      `SELECT d.document_id FROM collection_document cd
       INNER JOIN documents d ON d.document_id = cd.document_id
       WHERE cd.collection_id = ? AND d.owner_id = ? AND d.deleted_at IS NULL AND d.parse_status = 'parsed'`,
      [scope.collectionId, userId],
    );
    const documentIds = rows.map((row: any) => String(row.document_id));
    return { restricted: true, documentIds, snapshot: { type: "collection", collectionId: scope.collectionId, documentIds } };
  }
  const requested = [...new Set(scope.documentIds ?? [])];
  if (!requested.length) return { restricted: true, documentIds: [], snapshot: { type: "documents", documentIds: [] } };
  const placeholders = requested.map(() => "?").join(", ");
  const rows = await query<any>(
    `SELECT document_id FROM documents
     WHERE owner_id = ? AND deleted_at IS NULL AND parse_status = 'parsed' AND document_id IN (${placeholders})`,
    [userId, ...requested],
  );
  const documentIds = rows.map((row: any) => String(row.document_id));
  return { restricted: true, documentIds, snapshot: { type: "documents", documentIds } };
}

async function applySessionScope(sessionId: string, snapshot: Record<string, unknown>) {
  const type = String(snapshot.type ?? "library");
  await query(
    "UPDATE chat_session SET scope_type = ?, scope_collection_id = ?, scope_document_ids = ? WHERE session_id = ?",
    [
      type === "collection" || type === "documents" ? type : "library",
      type === "collection" ? Number(snapshot.collectionId ?? 0) || null : null,
      type === "documents" ? JSON.stringify(snapshot.documentIds ?? []) : null,
      sessionId,
    ],
  );
}

const FULL_DOCUMENT_TASK = /总结|概述|概括|综述|讲(了|的|在讲|的是)?什么|说什么|说的什么|主要内容|内容是什么|介绍|主题|核心|意图|目的|目标|比较|对比|区别|差异|异同/;

function requiresWholeDocumentEvidence(question: string) {
  return FULL_DOCUMENT_TASK.test(question)
    || /讲讲|说说|介绍一下|overview|about this (book|document|paper)/i.test(question);
}

function publicSource(result: SearchResult) {
  return {
    docId: result.chunkId,
    chunkId: result.chunkId,
    documentId: result.documentId,
    docName: result.documentName,
    snippet: result.snippet,
    pageNo: result.pageNo,
    fileExtension: result.fileExtension,
  };
}

async function resolveChatSession(userId: string, sessionId: string | undefined, content: string) {
  if (sessionId) {
    const rows = await query<any>("SELECT session_id FROM chat_session WHERE session_id = ? AND owner_id = ?", [sessionId, userId]);
    if (rows.length) return sessionId;
  }
  const created = await query<any>("INSERT INTO chat_session (owner_id, title) VALUES (?, ?)", [userId, content.slice(0, 50)]);
  return String(created.insertId);
}

function answerContext(results: SearchResult[]) {
  return results
    .slice(0, config.search.resultLimit)
    .map((item, index) => `[${index + 1}] ${item.documentName}\n${item.context ?? item.snippet}`)
    .join("\n\n");
}

/**
 * Retrieves evidence for a question. When the scope is narrow (1-3 documents) and the
 * task looks like summarising/comparing, it also folds in each document's cached
 * summary so the answer is not based on a few arbitrary top-k chunks.
 */
/** One-shot retrieval fallback: hybrid recall → gate → rerank → optional document summaries. */
async function retrieveEvidence(
  userId: string,
  question: string,
  scope: ResolvedScope,
  history: Array<{ role: "user" | "assistant"; content: string }>,
) {
  if (scope.restricted && !scope.documentIds.length) {
    return { results: [] as SearchResult[], contextText: "", stage: null as string | null, hasContext: false };
  }

  const retrievalQuery = await rewriteQuery(history as any, question);
  const found = await searchKnowledge(userId, retrievalQuery, { documentIds: scope.restricted ? scope.documentIds : undefined });
  let results = await rerankResults(retrievalQuery, found);
  let contextText = answerContext(results);
  let stage: string | null = null;
  let summaryUsed = false;

  if (scope.restricted && scope.documentIds.length >= 1 && scope.documentIds.length <= 3 && FULL_DOCUMENT_TASK.test(question)) {
    stage = `正在读取 ${scope.documentIds.length} 篇资料`;
    const placeholders = scope.documentIds.map(() => "?").join(", ");
    const documents = await query<any>(
      `SELECT document_id, original_file_name, file_extension FROM documents WHERE owner_id = ? AND document_id IN (${placeholders})`,
      [userId, ...scope.documentIds],
    ).catch(() => []);
    const nameById = new Map<string, string>();
    const extensionById = new Map<string, string | null>();
    for (const row of documents as any[]) {
      nameById.set(String(row.document_id), displayFilename(row.original_file_name));
      extensionById.set(String(row.document_id), row.file_extension ?? null);
    }
    const firstChunks = await query<any>(
      `SELECT document_id, MIN(chunk_id) AS first_chunk FROM document_chunk WHERE document_id IN (${placeholders}) GROUP BY document_id`,
      scope.documentIds,
    ).catch(() => []);
    const firstChunkById = new Map<string, string>();
    for (const row of firstChunks as any[]) firstChunkById.set(String(row.document_id), String(row.first_chunk));

    // Document-level sources so the answer's [1][2] map to real, clickable documents.
    const documentParts: string[] = [];
    const documentSources: SearchResult[] = [];
    let usedPreview = false;
    for (const documentId of scope.documentIds) {
      const firstChunkId = firstChunkById.get(documentId);
      if (!firstChunkId) continue;
      let summary = await getFreshSummaryText(documentId, userId).catch(() => null);
      let sourceLabel = "文档摘要";
      if (!summary) {
        const previewRows = await query<any>(
          "SELECT content FROM document_chunk WHERE document_id = ? ORDER BY chunk_no LIMIT 3",
          [documentId],
        ).catch(() => []);
        if (previewRows.length) {
          summary = previewRows.map((row: any) => String(row.content)).join("\n\n").slice(0, 4200);
          sourceLabel = "正文开头预览（摘要尚未生成）";
          usedPreview = true;
        }
      }
      if (!summary) continue;
      const name = nameById.get(documentId) ?? "未命名";
      const index = documentSources.length + 1;
      documentParts.push(`[${index}] 资料：${name}\n${sourceLabel}：\n${summary}`);
      documentSources.push({
        chunkId: firstChunkId,
        documentId,
        documentName: name,
        fileExtension: extensionById.get(documentId) ?? null,
        snippet: `${sourceLabel}：${summary.slice(0, 300)}`,
        pageNo: null,
        sectionTitle: null,
        score: 0,
        method: "fulltext",
      });
    }
    if (documentParts.length) {
      summaryUsed = true;
      const offset = documentSources.length;
      const evidence = results
        .slice(0, config.search.resultLimit)
        .map((item, index) => `[${offset + index + 1}] ${item.documentName}\n${item.context ?? item.snippet}`)
        .join("\n\n");
      const description = usedPreview
        ? "以下为所选资料的文档摘要；摘要尚未生成的资料明确标注为正文开头预览，不代表全文："
        : "以下为所选资料的文档摘要，用于整体理解与比较：";
      contextText = `${description}\n\n${documentParts.join("\n\n")}\n\n可参考的原文片段：\n${evidence}`;
      results = [...documentSources, ...results];
    }
  }

  // The relevance gate may legitimately return no chunk for "compare/summarise"
  // questions, but the injected document summaries still give us a basis to answer.
  return { results, contextText, stage, hasContext: results.length > 0 || summaryUsed };
}

/**
 * Evidence gathering: prefer the agent (model-chosen tools, possibly several
 * rounds); fall back to the one-shot pipeline when the agent is disabled or
 * produced nothing.
 */
async function gatherEvidence(
  userId: string,
  sessionId: string,
  messageId: string,
  question: string,
  scope: ResolvedScope,
  callbacks: {
    onStage?: (message: string) => void;
    onDelta?: (text: string) => void;
    onReset?: () => void;
    onSources?: (sources: SearchResult[]) => void;
  } = {},
) {
  const memory = await getSessionMemory(sessionId);
  const history = await getRecentHistory(sessionId, memory.until, messageId);
  const aiReady = Boolean(config.ai.baseUrl && config.ai.chatModel);
  const broadDocumentRequest = requiresWholeDocumentEvidence(question);

  if (aiReady && config.agent.enabled) {
    try {
      // Deterministic retrieval first (also covers scoped summarise/compare via
      // document summaries); the agent then decides whether more tools are needed.
      // For broad requests don't bias the Agent with one arbitrary top-k passage;
      // let it find the named document and request its full-coverage overview.
      const baseline = broadDocumentRequest
        ? { results: [] as SearchResult[], contextText: "", stage: null as string | null, hasContext: false }
        : await retrieveEvidence(userId, question, scope, history);
      if (baseline.stage) callbacks.onStage?.(baseline.stage);
      const agent = await runLangGraphAgent({
        userId,
        scope: { restricted: scope.restricted, documentIds: scope.documentIds },
        history: history.map((message) => ({ role: message.role, content: message.content })),
        question,
        baselineText: baseline.contextText,
        baselineSources: baseline.results,
        onStage: callbacks.onStage,
        onDelta: callbacks.onDelta,
        onReset: callbacks.onReset,
        onSources: callbacks.onSources,
      });
      if (agent.answered) {
        return { memory, history, results: agent.sources, contextText: agent.evidenceText, hasContext: true, answered: true, answerText: agent.answerText };
      }
      if (agent.hasEvidence) {
        return { memory, history, results: agent.sources, contextText: agent.evidenceText, hasContext: true, answered: false, answerText: "" };
      }
      // A tool round without usable evidence: fall through to the deterministic
      // retrieval result computed above.
      if (baseline.hasContext) {
        return { memory, history, results: baseline.results, contextText: baseline.contextText, hasContext: true, answered: false, answerText: "" };
      }
    } catch (error) {
      callbacks.onReset?.();
      console.warn(`[agent] failed, falling back to one-shot retrieval: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const evidence = await retrieveEvidence(userId, question, scope, history);
  if (evidence.stage) callbacks.onStage?.(evidence.stage);
  return { memory, history, results: evidence.results, contextText: evidence.contextText, hasContext: evidence.hasContext, answered: false, answerText: "" };
}

function fallbackAnswer(noMatch: boolean, results: SearchResult[]) {
  if (noMatch || !results.length) {
    return "未在知识库中找到与该问题相关的资料，暂无法给出有依据的回答。你可以换一种提问方式，或先上传相关资料。";
  }
  return `检索到 ${results.length} 个相关资料片段。${results[0].snippet}`;
}

function sanitizeCitations(answer: string, sourceCount: number) {
  return answer.replace(/\[(\d{1,3})\](?:\([^)]+\))?/g, (_match, digits: string) => {
    const index = Number(digits);
    return index >= 1 && index <= sourceCount ? `[${index}]` : "";
  });
}

function answerSource(hasContext: boolean, useGeneral: boolean): "document" | "general" | "fallback" {
  if (hasContext) return "document";
  if (useGeneral) return "general";
  return "fallback";
}

api.get("/messages/:id/sources", async (req, res, next) => {
  try {
    const rows = await query<any>(
      `SELECT ms.source_order, ms.chunk_id, ms.snippet, ms.page_no, ms.section_title,
              COALESCE(ms.document_id, d.document_id) AS document_id,
              COALESCE(ms.document_name, d.original_file_name) AS document_name,
              COALESCE(ms.file_extension, d.file_extension) AS file_extension,
              c.content AS full_content
       FROM message_source ms
       INNER JOIN chat_message m ON m.message_id = ms.message_id
       INNER JOIN chat_session s ON s.session_id = m.session_id
       LEFT JOIN document_chunk c ON c.chunk_id = ms.chunk_id
       LEFT JOIN documents d ON d.document_id = c.document_id
       WHERE ms.message_id = ? AND s.owner_id = ? ORDER BY ms.source_order`,
      [req.params.id, req.user!.id],
    );
    if (!rows.length) {
      const owned = await query<any>(
        `SELECT m.message_id FROM chat_message m INNER JOIN chat_session s ON s.session_id = m.session_id
         WHERE m.message_id = ? AND s.owner_id = ?`,
        [req.params.id, req.user!.id],
      );
      if (!owned.length) return res.status(404).json({ message: "消息不存在" });
    }
    res.json(rows.map((row: any) => ({
      order: Number(row.source_order), chunkId: row.chunk_id ? String(row.chunk_id) : null,
      documentId: row.document_id ? String(row.document_id) : null, documentName: displayFilename(row.document_name ?? ""),
      fileExtension: row.file_extension ?? null, pageNo: row.page_no, sectionTitle: row.section_title,
      snippet: row.snippet, content: row.full_content ?? row.snippet,
    })));
  } catch (error) { next(error); }
});



async function persistAnswer(assistantMessageId: unknown, results: SearchResult[], selectedForContext: boolean) {
  for (const [index, result] of results.entries()) {
    await query(
      `INSERT INTO message_retrieval (message_id, chunk_id, rank_no, similarity_score, retrieval_method, selected_for_context)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [assistantMessageId, result.chunkId, index + 1, result.score, result.method, selectedForContext],
    );
    await query(
      `INSERT INTO message_source
        (message_id, chunk_id, document_id, document_name, file_extension, source_order, snippet, page_no, section_title)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [assistantMessageId, result.chunkId, result.documentId, result.documentName, result.fileExtension, index + 1, result.snippet, result.pageNo, result.sectionTitle],
    );
  }
}

api.post("/chat/messages", async (req, res, next) => {
  try {
    const body = chatBody.parse(req.body);
    const userId = req.user!.id;
    const scope = await resolveScope(userId, body.scope);
    const sessionId = await resolveChatSession(userId, body.sessionId, body.content);
    if (body.scope) await applySessionScope(sessionId, scope.snapshot);
    const userMessage = await query<any>(
      "INSERT INTO chat_message (session_id, role, content, scope_snapshot) VALUES (?, 'user', ?, ?)",
      [sessionId, body.content, JSON.stringify(scope.snapshot)],
    );
    const evidence = await gatherEvidence(userId, sessionId, String(userMessage.insertId), body.content, scope);
    const { memory, history, results, contextText, hasContext } = evidence;

    // Only chunks that passed the relevance gate are injected into the model context.
    const aiReady = Boolean(config.ai.baseUrl && config.ai.chatModel);
    const useResultsForContext = Boolean(hasContext && aiReady && !evidence.answered);
    const useGeneral = Boolean(!hasContext && aiReady && config.ai.answerWithoutContext);
    let answer = evidence.answerText;
    if (!evidence.answered) {
      if (useResultsForContext) {
        answer = await chatCompletion(buildAnswerMessages(memory.summary, history, body.content, contextText)).catch(() => null) ?? "";
      } else if (useGeneral) {
        answer = await chatCompletion(buildGeneralAnswerMessages(memory.summary, history, body.content)).catch(() => null) ?? "";
      }
    }
    const noMatch = !evidence.answered && !hasContext && !useGeneral;
    const source = answerSource(hasContext, useGeneral);
    if (!answer.trim() && !evidence.answered && (useResultsForContext || useGeneral)) answer = "模型暂时没有返回内容，请重试。";
    if (!answer.trim()) answer = fallbackAnswer(noMatch, results);
    answer = sanitizeCitations(answer, results.length);
    const assistantMessage = await query<any>(
      "INSERT INTO chat_message (session_id, role, content, no_match, answer_source, model_name) VALUES (?, 'assistant', ?, ?, ?, ?)",
      [sessionId, answer, noMatch, source, configuredModelName()],
    );
    await persistAnswer(assistantMessage.insertId, results, Boolean(hasContext && aiReady));
    await query("UPDATE chat_session SET updated_at = NOW() WHERE session_id = ?", [sessionId]);
    void summarizeIfNeeded(sessionId).catch(() => undefined);

    res.status(201).json({
      sessionId,
      userMessage: { id: String(userMessage.insertId), role: "user", content: body.content },
      assistantMessage: {
        id: String(assistantMessage.insertId), role: "assistant", content: answer, noMatch,
        answerSource: source,
        sources: results.map(publicSource),
      },
    });
  } catch (error) { next(error); }
});

/** Shared SSE answer pipeline for both a fresh question and a regeneration. */
async function streamAnswer(
  req: any,
  res: any,
  params: { userId: string; sessionId: string; question: string; userMessageId: string; replaceAssistantId?: string; scope: ResolvedScope },
) {
  const { userId, sessionId, question, userMessageId, replaceAssistantId, scope } = params;
  res.status(200).set({
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders?.();
  let closed = false;
  req.on("close", () => { closed = true; });
  const send = (event: string, data: unknown) => {
    if (closed || res.writableEnded) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  send("session", { sessionId, userMessageId });

  try {
    let sourcesSent = false;
    const sendSources = (list: SearchResult[]) => { send("sources", { sources: list.map(publicSource) }); sourcesSent = true; };
    const evidence = await gatherEvidence(userId, sessionId, userMessageId, question, scope, {
      onStage: (message) => send("stage", { message }),
      onDelta: (text) => send("delta", { text }),
      onReset: () => send("reset", {}),
      onSources: sendSources,
    });
    const { memory, history, results, contextText, hasContext } = evidence;
    if (!sourcesSent) sendSources(results);

    const aiReady = Boolean(config.ai.baseUrl && config.ai.chatModel);
    // When the agent already streamed its answer we skip a second generation.
    const useResultsForContext = Boolean(hasContext && aiReady && !evidence.answered);
    // Nothing relevant in the knowledge base: answer from general knowledge.
    const useGeneral = Boolean(!hasContext && aiReady && config.ai.answerWithoutContext);
    let answer = evidence.answerText;
    if (!evidence.answered && (useResultsForContext || useGeneral)) {
      const messages = useResultsForContext
        ? buildAnswerMessages(memory.summary, history, question, contextText)
        : buildGeneralAnswerMessages(memory.summary, history, question);
      try {
        for await (const delta of chatCompletionStream(messages)) {
          answer += delta;
          send("delta", { text: delta });
        }
      } catch (error) {
        console.warn(`[chat] stream failed, retrying non-stream: ${error instanceof Error ? error.message : String(error)}`);
        if (answer.trim()) send("reset", {});
        answer = "";
        const full = await chatCompletion(messages).catch((fallbackError) => {
          console.warn(`[chat] non-stream fallback failed: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`);
          return null;
        });
        if (full) {
          answer = full;
          send("delta", { text: full });
        }
      }
    }
    const noMatch = !evidence.answered && !hasContext && !useGeneral;
    const source = answerSource(hasContext, useGeneral);
    if (!answer.trim() && !evidence.answered && (useResultsForContext || useGeneral)) {
      // The model was expected to answer but returned nothing (provider hiccup).
      answer = "模型暂时没有返回内容，请重试或点击“重新生成”。";
      send("delta", { text: answer });
    }
    if (!answer.trim()) {
      answer = fallbackAnswer(noMatch, results);
      send("delta", { text: answer });
    }
    // Replace already streamed text if the model used a citation outside this
    // answer's source list so the visible and persisted answers stay identical.
    const sanitizedAnswer = sanitizeCitations(answer, results.length);
    if (sanitizedAnswer !== answer) {
      answer = sanitizedAnswer;
      send("reset", {});
      if (answer) send("delta", { text: answer });
    }

    const assistantMessage = await query<any>(
      "INSERT INTO chat_message (session_id, role, content, no_match, answer_source, model_name) VALUES (?, 'assistant', ?, ?, ?, ?)",
      [sessionId, answer, noMatch, source, configuredModelName()],
    );
    await persistAnswer(assistantMessage.insertId, results, Boolean(hasContext && aiReady));
    if (replaceAssistantId) {
      // Keep the old answer until the replacement is fully persisted. A model
      // or database failure must not destroy a previously usable response.
      await query("DELETE FROM chat_message WHERE message_id = ? AND role = 'assistant' AND session_id = ?", [replaceAssistantId, sessionId]);
    }
    await query("UPDATE chat_session SET updated_at = NOW() WHERE session_id = ?", [sessionId]);
    void summarizeIfNeeded(sessionId).catch(() => undefined);

    send("done", {
      sessionId,
      assistantMessageId: String(assistantMessage.insertId),
      noMatch,
      answerSource: source,
      modelName: configuredModelName(),
    });
    if (!closed) res.end();
  } catch (error) {
    send("error", { message: error instanceof Error ? error.message : String(error) });
    if (!closed) res.end();
  }
}

api.post("/chat/stream", async (req, res, next) => {
  let body: z.infer<typeof chatBody>;
  try {
    body = chatBody.parse(req.body);
  } catch (error) {
    return next(error);
  }

  const userId = req.user!.id;
  let sessionId: string;
  let userMessageId: string;
  let scope: ResolvedScope;
  try {
    scope = await resolveScope(userId, body.scope);
    sessionId = await resolveChatSession(userId, body.sessionId, body.content);
    if (body.scope) await applySessionScope(sessionId, scope.snapshot);
    const userMessage = await query<any>(
      "INSERT INTO chat_message (session_id, role, content, scope_snapshot) VALUES (?, 'user', ?, ?)",
      [sessionId, body.content, JSON.stringify(scope.snapshot)],
    );
    userMessageId = String(userMessage.insertId);
  } catch (error) {
    return next(error);
  }

  await streamAnswer(req, res, { userId, sessionId, question: body.content, userMessageId, scope });
});

api.post("/chat/regenerate", async (req, res, next) => {
  let body: { sessionId: string; assistantMessageId: string };
  try {
    body = z.object({ sessionId: z.string().min(1), assistantMessageId: z.string().min(1) }).parse(req.body);
  } catch (error) {
    return next(error);
  }

  const userId = req.user!.id;
  try {
    const session = await query<any>(
      "SELECT session_id, scope_type, scope_collection_id, scope_document_ids FROM chat_session WHERE session_id = ? AND owner_id = ?",
      [body.sessionId, userId],
    );
    if (!session.length) return res.status(404).json({ message: "会话不存在" });
    const stored = session[0];
    const storedScope = stored.scope_type === "collection"
      ? { type: "collection" as const, collectionId: stored.scope_collection_id ? String(stored.scope_collection_id) : undefined }
      : stored.scope_type === "documents"
        ? { type: "documents" as const, documentIds: stringList(parseJson(stored.scope_document_ids, [])) }
        : { type: "library" as const };
    const scope = await resolveScope(userId, storedScope);
    const assistant = await query<any>(
      "SELECT message_id FROM chat_message WHERE message_id = ? AND session_id = ? AND role = 'assistant'",
      [body.assistantMessageId, body.sessionId],
    );
    if (!assistant.length) return res.status(404).json({ message: "消息不存在" });
    const previous = await query<any>(
      "SELECT message_id, content FROM chat_message WHERE session_id = ? AND role = 'user' AND message_id < ? ORDER BY message_id DESC LIMIT 1",
      [body.sessionId, body.assistantMessageId],
    );
    if (!previous.length) return res.status(400).json({ message: "找不到对应的问题，无法重新生成" });

    await streamAnswer(req, res, {
      userId,
      sessionId: body.sessionId,
      question: previous[0].content,
      userMessageId: String(previous[0].message_id),
      replaceAssistantId: body.assistantMessageId,
      scope,
    });
  } catch (error) {
    next(error);
  }
});

api.use((error: unknown, _req: any, res: any, _next: any) => {
  const isMulterError = error instanceof multer.MulterError;
  const mysqlCode = typeof error === "object" && error !== null && "code" in error ? String((error as any).code) : "";
  const isDuplicate = mysqlCode === "ER_DUP_ENTRY";
  const explicitStatus = typeof error === "object" && error !== null && "statusCode" in error ? Number((error as any).statusCode) : 0;
  const status = error instanceof z.ZodError ? 400 : isMulterError && error.code === "LIMIT_FILE_SIZE" ? 413 : isMulterError ? 400 : isDuplicate ? 409 : explicitStatus >= 400 && explicitStatus < 500 ? explicitStatus : 500;
  const message = error instanceof z.ZodError
    ? error.issues.map((issue) => issue.message).join("；")
    : isMulterError && error.code === "LIMIT_FILE_SIZE"
      ? `文件超过 ${Math.round(config.maxUploadBytes / 1024 / 1024)} MB 限制`
      : isDuplicate
        ? "相同内容已经导入过了"
      : error instanceof Error ? error.message : String(error);
  if (status >= 500) console.error("API error", error);
  res.status(status).json({ message });
});
