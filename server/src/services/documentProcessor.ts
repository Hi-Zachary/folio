import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import mammoth from "mammoth";
import pdfParse from "pdf-parse";
import { config } from "../config.js";
import { query } from "../db.js";
import { embedTexts, isChatConfigured } from "./ai.js";
import { deleteDocumentVectors, ensureCollection, isVectorStoreConfigured, upsertVectors } from "./vectorStore.js";
import { displayFilename } from "./filename.js";
import { ocrAvailable, ocrPdf } from "./ocr.js";
import { generateDocumentSummary } from "./summary.js";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";

interface ExtractedPage {
  pageNo: number | null;
  text: string;
}

interface TextChunk {
  content: string;
  pageNo: number | null;
  sectionTitle: string | null;
  charStart: number;
  charEnd: number;
}

function sha256(value: string | Buffer) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function normalizeText(text: string) {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/[\t ]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function stripHtml(text: string) {
  return text
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<br\s*\/?>(?=\s*)/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li|tr|section|article)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">").replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'");
}

function headingFromLine(line: string) {
  const value = line.trim();
  if (!value || value.length > 160) return null;
  if (/^#{1,6}\s+/.test(value)) return value.replace(/^#{1,6}\s+/, "").trim();
  if (/^(第.{1,30}[章节篇]|[一二三四五六七八九十百]+[、.．]|\d+(?:\.\d+)*[、.．])/.test(value)) return value;
  if (/^(摘要|引言|绪论|结论|参考文献|目录|背景|方法|实验|结果|讨论|附录)[:：]?$/i.test(value)) return value;
  return null;
}

function sectionTitleAt(text: string, offset: number) {
  let title: string | null = null;
  let position = 0;
  for (const line of text.split("\n")) {
    if (position > offset) break;
    title = headingFromLine(line) ?? title;
    position += line.length + 1;
  }
  return title;
}

export async function splitPage(page: ExtractedPage, globalOffset: number, maxLength = 1800, overlap = 220): Promise<TextChunk[]> {
  const text = normalizeText(page.text);
  if (!text) return [];
  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: maxLength,
    chunkOverlap: overlap,
    keepSeparator: true,
    separators: ["。", "！", "？", "\n\n", "\n", ".", " ", ""],
  });
  const parts = await splitter.splitText(text);
  let cursor = 0;
  return parts.map((content) => {
    const foundAt = text.indexOf(content, cursor);
    const start = foundAt < 0 ? cursor : foundAt;
    const charStart = globalOffset + start;
    const actualStart = start;
    cursor = Math.max(cursor, actualStart + Math.max(1, content.length - overlap));
    return {
      content,
      pageNo: page.pageNo,
      sectionTitle: sectionTitleAt(text, actualStart),
      charStart,
      charEnd: globalOffset + actualStart + content.length,
    };
  });
}

async function extractPdfPages(filePath: string): Promise<ExtractedPage[]> {
  const pages: ExtractedPage[] = [];
  await pdfParse(await fs.readFile(filePath), {
    pagerender: async (pageData) => {
      const textContent = await pageData.getTextContent();
      const lines = new Map<number, string[]>();
      for (const item of textContent.items) {
        const value = item.str?.trim();
        if (!value) continue;
        const y = Math.round(item.transform?.[5] ?? 0);
        const line = lines.get(y) ?? [];
        line.push(value);
        lines.set(y, line);
      }
      const text = [...lines.entries()]
        .sort(([a], [b]) => b - a)
        .map(([, values]) => values.join(" "))
        .join("\n");
      pages.push({ pageNo: pages.length + 1, text });
      return text;
    },
  });
  return pages;
}

// A scanned PDF has an image per page but almost no text layer, so the extracted
// text is far below what a real page of text would produce.
function textLength(pages: ExtractedPage[]) {
  return pages.reduce((total, page) => total + normalizeText(page.text).length, 0);
}

function shouldRunOcr(pages: ExtractedPage[]) {
  if (!config.ocr.enabled || !pages.length) return false;
  return textLength(pages) < config.ocr.minCharsPerPage * pages.length;
}

async function extractPages(filePath: string, extension: string): Promise<ExtractedPage[]> {
  const lower = extension.toLowerCase();
  if (lower === ".pdf") {
    const pages = await extractPdfPages(filePath);
    if (shouldRunOcr(pages) && await ocrAvailable()) {
      try {
        const { pages: ocrPages, provider } = await ocrPdf(filePath);
        const usable = ocrPages.filter((page) => normalizeText(page.text).length > 0);
        if (usable.length) {
          console.log(`[ocr] ${path.basename(filePath)} 缺少文字层，已用 ${provider} 识别 ${usable.length} 页`);
          // OCR may be capped for cost/time reasons. Preserve every page from
          // the original extraction instead of replacing a long PDF with only
          // its first N OCR pages.
          const byPage = new Map(ocrPages.map((page) => [page.pageNo, page.text]));
          return pages.map((page) => ({
            pageNo: page.pageNo,
            text: normalizeText(byPage.get(page.pageNo ?? -1) ?? page.text),
          }));
        }
      } catch (error) {
        console.warn(`[ocr] 回退失败：${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return pages;
  }
  if (lower === ".docx") {
    const result = await mammoth.extractRawText({ path: filePath });
    return [{ pageNo: null, text: result.value }];
  }
  if (lower === ".md" || lower === ".markdown" || lower === ".txt" || lower === ".csv") {
    return [{ pageNo: null, text: await fs.readFile(filePath, "utf8") }];
  }
  if (lower === ".html" || lower === ".htm") {
    return [{ pageNo: null, text: stripHtml(await fs.readFile(filePath, "utf8")) }];
  }
  throw new Error(`暂不支持解析 ${extension} 文件`);
}

async function createJob(documentId: string, jobType: "parse" | "chunk" | "embedding") {
  const result = await query<any>(
    `INSERT INTO document_job (document_id, job_type, status, attempt_count, started_at)
     VALUES (?, ?, 'running', 1, NOW())`,
    [documentId, jobType],
  );
  return String(result.insertId);
}

export async function enqueueDocument(documentId: string) {
  await query(
    `INSERT INTO document_job (document_id, job_type, status, attempt_count)
     VALUES (?, 'parse', 'pending', 0)`,
    [documentId],
  );
}

export async function enqueueSummary(documentId: string) {
  if (!isChatConfigured()) return;
  const existing = await query<any>(
    `SELECT job_id FROM document_job
     WHERE document_id = ? AND job_type = 'summary' AND status IN ('pending', 'running')
     LIMIT 1`,
    [documentId],
  );
  if (existing.length) return;
  await query(
    `INSERT INTO document_job (document_id, job_type, status, attempt_count)
     VALUES (?, 'summary', 'pending', 0)`,
    [documentId],
  );
}

export async function processSummaryJob(documentId: string, jobId: string) {
  const documents = await query<any>(
    `SELECT owner_id FROM documents WHERE document_id = ? AND deleted_at IS NULL AND parse_status = 'parsed'`,
    [documentId],
  );
  if (!documents.length) {
    await finishJob(jobId, "skipped", "文档已删除或尚未解析完成");
    return;
  }
  try {
    await generateDocumentSummary(documentId, String(documents[0].owner_id));
    await finishJob(jobId, "success");
  } catch (error) {
    await finishJob(jobId, "failed", error instanceof Error ? error.message : String(error));
  }
}

async function finishJob(jobId: string, status: "success" | "failed" | "skipped", errorMessage?: string) {
  await query(
    `UPDATE document_job SET status = ?, error_message = ?, finished_at = NOW(), locked_at = NULL, locked_by = NULL WHERE job_id = ?`,
    [status, errorMessage ?? null, jobId],
  );
}

async function indexChunks(documentId: string, existingJobId?: string) {
  const embeddingJobId = existingJobId ?? await createJob(documentId, "embedding");
  const rows = await query<any>(
    `SELECT c.chunk_id, c.content, c.page_no, c.section_title, d.owner_id, d.original_file_name, d.file_extension
     FROM document_chunk c INNER JOIN documents d ON d.document_id = c.document_id
     WHERE c.document_id = ? ORDER BY c.chunk_no`,
    [documentId],
  );

  if (!config.ai.baseUrl || !config.ai.embeddingModel) {
    await query(
      `UPDATE document_chunk SET embedding_status = 'skipped', embedding_json = NULL,
       embedding_model = NULL, vector_id = NULL WHERE document_id = ?`,
      [documentId],
    );
    await finishJob(embeddingJobId, "skipped", "未配置 Embedding API，使用混合文本检索");
    await query(`UPDATE documents SET indexed_at = NOW() WHERE document_id = ?`, [documentId]);
    return;
  }

  await query(
    `UPDATE document_chunk SET embedding_status = 'pending', embedding_json = NULL,
     embedding_model = NULL, vector_collection = ?, vector_id = NULL
     WHERE document_id = ?`,
    [isVectorStoreConfigured() ? "qdrant+mysql-json" : "mysql-json", documentId],
  );

  try {
    for (let index = 0; index < rows.length; index += 32) {
      const batch = rows.slice(index, index + 32);
      const vectors = await embedTexts(batch.map((row: any) => row.content));
      if (!vectors) throw new Error("Embedding API 未启用");
      if (isVectorStoreConfigured()) {
        await ensureCollection(vectors[0].length);
        await upsertVectors(vectors.map((vector, batchIndex) => {
          const row = batch[batchIndex];
          return {
            id: String(row.chunk_id), vector, ownerId: String(row.owner_id),
            documentId, documentName: displayFilename(row.original_file_name), content: row.content,
            fileExtension: row.file_extension,
            pageNo: row.page_no, sectionTitle: row.section_title,
          };
        }));
      }
      for (const [batchIndex, vector] of vectors.entries()) {
        const row = batch[batchIndex];
        await query(
          `UPDATE document_chunk
           SET embedding_status = 'success', embedding_model = ?, embedding_json = ?,
               vector_collection = ?, vector_id = ?
           WHERE chunk_id = ?`,
          [
            config.ai.embeddingModel,
            JSON.stringify(vector),
            isVectorStoreConfigured() ? config.vector.collection : "chunk-local",
            isVectorStoreConfigured() ? String(row.chunk_id) : null,
            row.chunk_id,
          ],
        );
      }
    }
    await query(`UPDATE documents SET indexed_at = NOW() WHERE document_id = ?`, [documentId]);
    await finishJob(embeddingJobId, "success");
  } catch (error) {
    await query(
      `UPDATE document_chunk SET embedding_status = 'failed' WHERE document_id = ?`,
      [documentId],
    );
    await finishJob(embeddingJobId, "failed", error instanceof Error ? error.message : String(error));
    await query(`UPDATE documents SET indexed_at = NOW() WHERE document_id = ?`, [documentId]);
  }
}

export async function processEmbeddingJob(documentId: string, jobId: string) {
  const documents = await query<any>(
    `SELECT document_id FROM documents WHERE document_id = ? AND deleted_at IS NULL AND parse_status = 'parsed'`,
    [documentId],
  );
  if (!documents.length) {
    await finishJob(jobId, "skipped", "文档已删除或尚未解析完成");
    return;
  }
  await indexChunks(documentId, jobId);
}

export async function processDocument(documentId: string, existingParseJobId?: string) {
  const rows = await query<any>(
    `SELECT document_id, storage_key, file_extension FROM documents
     WHERE document_id = ? AND deleted_at IS NULL`,
    [documentId],
  );
  const document = rows[0];
  if (!document) return;

  const parseJobId = existingParseJobId ?? await createJob(documentId, "parse");
  let chunkJobId: string | null = null;
  try {
    await query(
      `UPDATE documents SET parse_status = 'parsing', parse_error = NULL, parse_warning = NULL WHERE document_id = ?`,
      [documentId],
    );
    const filePath = path.resolve(config.uploadDir, document.storage_key);
    const pages = await extractPages(filePath, document.file_extension);
    const parseWarning = document.file_extension.toLowerCase() === ".pdf"
      && pages.length > config.ocr.maxPages
      && textLength(pages) < config.ocr.minCharsPerPage * pages.length
      ? `扫描 PDF 仅对前 ${config.ocr.maxPages} 页执行 OCR，后续页面可能缺少文字内容`
      : null;
    const chunks = (await Promise.all(pages.map((page, pageIndex) => splitPage(
      page,
      pages.slice(0, pageIndex).reduce((total, item) => total + normalizeText(item.text).length + 1, 0),
    )))).flat();
    if (!chunks.length) {
      throw new Error("文件没有提取到可用文本；如果这是扫描版 PDF，请先进行 OCR");
    }

    await deleteDocumentVectors(documentId);
    await query(`DELETE FROM document_chunk WHERE document_id = ?`, [documentId]);
    chunkJobId = await createJob(documentId, "chunk");
    for (const [index, chunk] of chunks.entries()) {
      await query(
        `INSERT INTO document_chunk
          (document_id, chunk_no, content, page_no, section_title, char_start, char_end, token_count, content_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          documentId,
          index + 1,
          chunk.content,
          chunk.pageNo,
          chunk.sectionTitle,
          chunk.charStart,
          chunk.charEnd,
          Math.max(1, Math.ceil(chunk.content.length / 1.5)),
          sha256(chunk.content),
        ],
      );
    }
    await finishJob(chunkJobId, "success");
    await query(
      `UPDATE documents SET parse_status = 'parsed', parsed_at = NOW(), parse_error = NULL, parse_warning = ?,
              content_version = content_version + 1
       WHERE document_id = ?`,
      [parseWarning, documentId],
    );
    await finishJob(parseJobId, "success");
    await indexChunks(documentId);
    await enqueueSummary(documentId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (chunkJobId) await finishJob(chunkJobId, "failed", message).catch(() => undefined);
    await query(
      `UPDATE documents SET parse_status = 'failed', parse_error = ? WHERE document_id = ?`,
      [message, documentId],
    );
    await finishJob(parseJobId, "failed", message);
  }
}
