import os from "node:os";
import { query, transaction } from "../db.js";
import { cleanupExpiredSessions } from "./auth.js";
import { processDocument, processEmbeddingJob, processSummaryJob } from "./documentProcessor.js";

const workerId = `${os.hostname()}-${process.pid}`;
let runningParse = false;
let runningSummary = false;
let runningEmbedding = false;

async function recoverStaleJobs() {
  await query(
    `UPDATE document_job
     SET status = 'pending', locked_at = NULL, locked_by = NULL,
         error_message = CONCAT(COALESCE(error_message, ''), ' [worker restarted]')
     WHERE status = 'running' AND locked_at < DATE_SUB(NOW(), INTERVAL 30 MINUTE)`,
  );
}

async function claimJob(jobType: "parse" | "summary" | "embedding") {
  return transaction(async (connection) => {
    const [rows] = await connection.query<any[]>(
      `SELECT job_id, document_id
       FROM document_job
       WHERE job_type = ? AND status = 'pending'
       ORDER BY created_at, job_id
       LIMIT 1 FOR UPDATE SKIP LOCKED`,
      [jobType],
    );
    if (!rows.length) return null;
    await connection.query(
      `UPDATE document_job
       SET status = 'running', attempt_count = attempt_count + 1, started_at = NOW(),
           locked_at = NOW(), locked_by = ?
       WHERE job_id = ?`,
      [workerId, rows[0].job_id],
    );
    return { jobId: String(rows[0].job_id), documentId: String(rows[0].document_id) };
  });
}

async function tick(jobType: "parse" | "summary" | "embedding") {
  const isRunning = jobType === "parse" ? runningParse : jobType === "summary" ? runningSummary : runningEmbedding;
  if (isRunning) return;
  if (jobType === "parse") runningParse = true;
  else if (jobType === "summary") runningSummary = true;
  else runningEmbedding = true;
  try {
    const job = await claimJob(jobType);
    if (job && jobType === "summary") await processSummaryJob(job.documentId, job.jobId);
    else if (job && jobType === "embedding") await processEmbeddingJob(job.documentId, job.jobId);
    else if (job) await processDocument(job.documentId, job.jobId);
  } catch (error) {
    console.error(`${jobType} worker error`, error);
  } finally {
    if (jobType === "parse") runningParse = false;
    else if (jobType === "summary") runningSummary = false;
    else runningEmbedding = false;
  }
}

export function startBackgroundWorkers() {
  void recoverStaleJobs().catch((error) => console.error("job recovery error", error));
  void cleanupExpiredSessions().catch((error) => console.error("session cleanup error", error));
  const timer = setInterval(() => {
    void tick("parse");
    void tick("summary");
    void tick("embedding");
    void cleanupExpiredSessions().catch(() => undefined);
  }, 1000);
  timer.unref();
  void tick("parse");
  void tick("summary");
  void tick("embedding");
}
