import { config } from "./config.js";
import { pool, query } from "./db.js";
import { displayFilename } from "./services/filename.js";
import { deleteCollection, ensureCollection, isVectorStoreConfigured, upsertVectors } from "./services/vectorStore.js";

interface ReindexPoint {
  id: string;
  vector: number[];
  ownerId: string;
  documentId: string;
  documentName: string;
  fileExtension: string | null;
  content: string;
  pageNo: number | null;
  sectionTitle: string | null;
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

async function main() {
  if (!isVectorStoreConfigured()) {
    throw new Error("QDRANT_URL 未配置，无法重建向量库");
  }

  const rows = await query<any>(
    `SELECT c.chunk_id, c.content, c.page_no, c.section_title, c.embedding_json,
            d.document_id, d.owner_id, d.original_file_name, d.file_extension
     FROM document_chunk c
     INNER JOIN documents d ON d.document_id = c.document_id
     WHERE d.deleted_at IS NULL AND d.parse_status = 'parsed' AND c.embedding_json IS NOT NULL
     ORDER BY c.chunk_id`,
  );

  const points: ReindexPoint[] = [];
  let dimensions = 0;
  let skipped = 0;
  for (const row of rows) {
    const vector = parseEmbedding(row.embedding_json);
    if (!vector?.length) {
      skipped += 1;
      continue;
    }
    if (!dimensions) dimensions = vector.length;
    if (vector.length !== dimensions) {
      skipped += 1;
      continue;
    }
    points.push({
      id: String(row.chunk_id),
      vector,
      ownerId: String(row.owner_id),
      documentId: String(row.document_id),
      documentName: displayFilename(row.original_file_name),
      fileExtension: row.file_extension ?? null,
      content: row.content,
      pageNo: row.page_no,
      sectionTitle: row.section_title,
    });
  }

  if (!points.length) {
    throw new Error("没有可写入的向量，请先完成文档解析与 embedding");
  }

  console.log(`重建 collection「${config.vector.collection}」：维度 ${dimensions}，共 ${points.length} 个分块待写入${skipped ? `，跳过 ${skipped} 个` : ""}`);

  await deleteCollection();
  await ensureCollection(dimensions);

  const batchSize = 128;
  for (let index = 0; index < points.length; index += batchSize) {
    const batch = points.slice(index, index + batchSize);
    await upsertVectors(batch);
    for (const point of batch) {
      await query(
        "UPDATE document_chunk SET vector_collection = ?, vector_id = ? WHERE chunk_id = ?",
        [config.vector.collection, point.id, point.id],
      );
    }
    process.stdout.write(`\r已写入 ${Math.min(index + batchSize, points.length)}/${points.length}`);
  }

  console.log(`\n完成：${points.length} 个分块已写入 ${config.vector.url}`);
  await pool.end();
}

main().catch(async (error) => {
  console.error(error instanceof Error ? error.message : error);
  await pool.end().catch(() => undefined);
  process.exitCode = 1;
});
