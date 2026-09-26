import { config } from "./config.js";
import { pool, query } from "./db.js";
import { embedTexts, isEmbeddingConfigured } from "./services/ai.js";
import { displayFilename } from "./services/filename.js";
import { deleteCollection, ensureCollection, isVectorStoreConfigured, upsertVectors } from "./services/vectorStore.js";

/**
 * Re-embed every chunk with the currently configured embedding model. Needed
 * after switching embedding providers/models, because the vector dimension
 * changes and the old vectors are incompatible.
 */
async function main() {
  if (!isEmbeddingConfigured()) throw new Error("未配置 Embedding 服务");

  const rows = await query<any>(
    `SELECT c.chunk_id, c.content, c.page_no, c.section_title,
            d.document_id, d.owner_id, d.original_file_name, d.file_extension
     FROM document_chunk c
     INNER JOIN documents d ON d.document_id = c.document_id
     WHERE d.deleted_at IS NULL AND d.parse_status = 'parsed'
     ORDER BY c.chunk_id`,
  );
  if (!rows.length) {
    console.log("没有需要重建的分块");
    await pool.end();
    return;
  }

  const probe = await embedTexts([rows[0].content]);
  const dimensions = probe?.[0]?.length ?? 0;
  if (!dimensions) throw new Error("Embedding 服务返回为空");
  const useVectorStore = isVectorStoreConfigured();
  console.log(`使用 ${config.ai.embeddingModel}（维度 ${dimensions}）重建 ${rows.length} 个分块${useVectorStore ? `，写入 ${config.vector.collection}` : ""}`);

  if (useVectorStore) {
    await deleteCollection();
    await ensureCollection(dimensions);
  }

  const batchSize = 16;
  let done = 0;
  for (let index = 0; index < rows.length; index += batchSize) {
    const batch = rows.slice(index, index + batchSize);
    const vectors = await embedTexts(batch.map((row: any) => row.content));
    if (!vectors) throw new Error("Embedding 服务返回为空");

    const points = [];
    for (let offset = 0; offset < batch.length; offset += 1) {
      const row = batch[offset];
      const vector = vectors[offset];
      await query(
        `UPDATE document_chunk
         SET embedding_json = ?, embedding_status = 'success', embedding_model = ?, vector_collection = ?, vector_id = ?
         WHERE chunk_id = ?`,
        [JSON.stringify(vector), config.ai.embeddingModel, useVectorStore ? config.vector.collection : null, String(row.chunk_id), String(row.chunk_id)],
      );
      if (useVectorStore) {
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
    }
    if (points.length) await upsertVectors(points);
    done += batch.length;
    process.stdout.write(`\r已重建 ${done}/${rows.length}`);
  }

  console.log("\n完成");
  await pool.end();
}

main().catch(async (error) => {
  console.error(error instanceof Error ? error.message : error);
  await pool.end().catch(() => undefined);
  process.exitCode = 1;
});
