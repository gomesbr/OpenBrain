import { pool } from "../db.js";
import { ensureExtendedSchema } from "../schema.js";
import { extractMetadata } from "../metadata_provider.js";

interface QueueClaimRow {
  queue_id: string;
  memory_item_id: string;
}

interface MemoryRow {
  queue_id: string;
  memory_item_id: string;
  content: string;
  source_system: string;
  source_conversation_id: string | null;
  source_message_id: string | null;
  chat_namespace: string | null;
  ts: string | null;
}

interface WorkerStats {
  claimed: number;
  updated: number;
  failed: number;
  done: number;
}

interface RunControl {
  stopRequested: boolean;
}

function readArg(prefix: string, fallback: string): string {
  return process.argv.find((arg) => arg.startsWith(prefix))?.split("=")[1] ?? fallback;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableError(message: string): boolean {
  const m = String(message ?? "").toLowerCase();
  return (
    m.includes("429") ||
    m.includes("rate limit") ||
    m.includes("timeout") ||
    m.includes("timed out") ||
    m.includes("aborted") ||
    m.includes("fetch failed") ||
    m.includes("http 5")
  );
}

async function fetchContextWindow(row: MemoryRow, limit: number): Promise<string[]> {
  if (!row.source_conversation_id) return [];
  const rows = await pool.query<{ content: string }>(
    `SELECT content
       FROM memory_items
      WHERE source_system = $1
        AND source_conversation_id = $2
        AND ($3::text IS NULL OR chat_namespace = $3::text)
        AND (
          ($4::timestamptz IS NOT NULL AND COALESCE(source_timestamp, created_at) < $4::timestamptz)
          OR ($4::timestamptz IS NULL AND ($5::text IS NULL OR source_message_id IS DISTINCT FROM $5::text))
        )
      ORDER BY COALESCE(source_timestamp, created_at) DESC
      LIMIT $6`,
    [
      row.source_system,
      row.source_conversation_id,
      row.chat_namespace,
      row.ts,
      row.source_message_id,
      Math.max(3, Math.min(24, limit))
    ]
  );
  return rows.rows
    .map((r) => String(r.content ?? "").trim())
    .filter((line) => line.length > 0)
    .slice(0, limit)
    .reverse()
    .map((line) => line.slice(0, 420));
}

async function claimBatch(params: {
  chatNamespace: string;
  sourceSystem: string;
  claimSize: number;
  workerId: string;
}): Promise<QueueClaimRow[]> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const rows = await client.query<QueueClaimRow>(
      `WITH claim AS (
         SELECT id
           FROM metadata_enrichment_queue
          WHERE status = 'pending'
            AND ($1::text = '' OR chat_namespace = $1::text)
            AND ($2::text = '' OR source_system = $2::text)
          ORDER BY source_timestamp DESC NULLS LAST, id
          LIMIT $3
          FOR UPDATE SKIP LOCKED
       )
       UPDATE metadata_enrichment_queue q
          SET status = 'processing',
              locked_by = $4,
              locked_at = now(),
              attempt_count = q.attempt_count + 1
         FROM claim
        WHERE q.id = claim.id
       RETURNING q.id::text AS queue_id, q.memory_item_id::text AS memory_item_id`,
      [params.chatNamespace, params.sourceSystem, Math.max(1, params.claimSize), params.workerId]
    );
    await client.query("COMMIT");
    return rows.rows;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function loadClaimRows(queueIds: string[]): Promise<MemoryRow[]> {
  if (queueIds.length === 0) return [];
  const rows = await pool.query<MemoryRow>(
    `SELECT
       q.id::text AS queue_id,
       m.id::text AS memory_item_id,
       m.content,
       m.source_system,
       m.source_conversation_id,
       m.source_message_id,
       m.chat_namespace,
       COALESCE(m.source_timestamp, m.created_at)::text AS ts
     FROM metadata_enrichment_queue q
     JOIN memory_items m ON m.id = q.memory_item_id
     WHERE q.id = ANY($1::bigint[])
     ORDER BY q.id`,
    [queueIds.map((id) => Number(id))]
  );
  return rows.rows;
}

async function markQueueFailed(queueId: string, message: string): Promise<void> {
  await pool.query(
    `UPDATE metadata_enrichment_queue
        SET status = 'failed',
            last_error = $2,
            locked_by = NULL,
            locked_at = NULL
      WHERE id = $1::bigint`,
    [Number(queueId), message.slice(0, 800)]
  );
}

async function markQueueDone(queueId: string): Promise<void> {
  await pool.query(
    `UPDATE metadata_enrichment_queue
        SET status = 'done',
            last_error = NULL,
            locked_by = NULL,
            locked_at = NULL
      WHERE id = $1::bigint`,
    [Number(queueId)]
  );
}

async function releaseQueuePending(queueIds: string[]): Promise<void> {
  if (queueIds.length === 0) return;
  await pool.query(
    `UPDATE metadata_enrichment_queue
        SET status = 'pending',
            locked_by = NULL,
            locked_at = NULL
      WHERE id = ANY($1::bigint[])
        AND status = 'processing'`,
    [queueIds.map((id) => Number(id))]
  );
}

async function runWorker(params: {
  workerId: string;
  chatNamespace: string;
  sourceSystem: string;
  claimSize: number;
  maxRows: number;
  contextLimit: number;
  strictErrors: boolean;
  rowRetries: number;
  retryBackoffMs: number;
  pollMs: number;
  idlePollLimit: number;
  globalStats: WorkerStats;
  control: RunControl;
}): Promise<void> {
  let idlePolls = 0;

  while (true) {
    if (params.control.stopRequested) {
      return;
    }
    if (params.maxRows > 0 && params.globalStats.updated >= params.maxRows) {
      params.control.stopRequested = true;
      return;
    }

    const claimed = await claimBatch({
      chatNamespace: params.chatNamespace,
      sourceSystem: params.sourceSystem,
      claimSize: params.claimSize,
      workerId: params.workerId
    });

    if (claimed.length === 0) {
      idlePolls += 1;
      if (idlePolls >= params.idlePollLimit) {
        return;
      }
      await sleep(params.pollMs);
      continue;
    }

    idlePolls = 0;
    params.globalStats.claimed += claimed.length;
    const rows = await loadClaimRows(claimed.map((r) => r.queue_id));

    for (let idx = 0; idx < rows.length; idx += 1) {
      const row = rows[idx];
      if (params.control.stopRequested || (params.maxRows > 0 && params.globalStats.updated >= params.maxRows)) {
        params.control.stopRequested = true;
        const remaining = rows.slice(idx).map((r) => r.queue_id);
        await releaseQueuePending(remaining);
        return;
      }

      try {
        const contextWindow = await fetchContextWindow(row, params.contextLimit);
        let metadata: Record<string, unknown> | null = null;
        let metadataError = "";
        const attempts = Math.max(1, params.rowRetries + 1);

        for (let attempt = 1; attempt <= attempts; attempt += 1) {
          metadata = await extractMetadata(row.content, {
            contextWindow,
            sourceSystem: row.source_system,
            sourceConversationId: row.source_conversation_id,
            chatNamespace: row.chat_namespace
          });
          metadataError =
            typeof metadata.metadata_extraction_error === "string" && metadata.metadata_extraction_error.trim().length > 0
              ? String(metadata.metadata_extraction_error)
              : "";

          if (!metadataError) break;
          if (!isRetryableError(metadataError) || attempt >= attempts) break;
          const delay = Math.min(15000, params.retryBackoffMs * attempt);
          await sleep(delay);
        }

        if (params.strictErrors && metadataError) {
          params.globalStats.failed += 1;
          await markQueueFailed(row.queue_id, metadataError);
          continue;
        }

        if (!metadata) {
          params.globalStats.failed += 1;
          await markQueueFailed(row.queue_id, "metadata extraction returned no payload");
          continue;
        }

        await pool.query(
          `UPDATE memory_items
              SET metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb,
                  updated_at = now()
            WHERE id = $1::uuid`,
          [row.memory_item_id, JSON.stringify(metadata)]
        );

        await markQueueDone(row.queue_id);
        params.globalStats.updated += 1;
        params.globalStats.done += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (isRetryableError(message) && params.rowRetries > 0) {
          let succeeded = false;
          for (let attempt = 1; attempt <= params.rowRetries; attempt += 1) {
            await sleep(Math.min(15000, params.retryBackoffMs * attempt));
            try {
              const contextWindow = await fetchContextWindow(row, params.contextLimit);
              const metadata = await extractMetadata(row.content, {
                contextWindow,
                sourceSystem: row.source_system,
                sourceConversationId: row.source_conversation_id,
                chatNamespace: row.chat_namespace
              });
              const metadataError =
                typeof metadata.metadata_extraction_error === "string" && metadata.metadata_extraction_error.trim().length > 0
                  ? String(metadata.metadata_extraction_error)
                  : "";
              if (params.strictErrors && metadataError) {
                continue;
              }
              await pool.query(
                `UPDATE memory_items
                    SET metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb,
                        updated_at = now()
                  WHERE id = $1::uuid`,
                [row.memory_item_id, JSON.stringify(metadata)]
              );
              await markQueueDone(row.queue_id);
              params.globalStats.updated += 1;
              params.globalStats.done += 1;
              succeeded = true;
              break;
            } catch {
              // continue retries
            }
          }
          if (succeeded) continue;
        }

        params.globalStats.failed += 1;
        await markQueueFailed(row.queue_id, message);
      }
    }
  }
}

async function main(): Promise<void> {
  await ensureExtendedSchema();

  const chatNamespace = readArg("--chat=", "personal.main");
  const sourceSystem = readArg("--source=", "");
  const workers = Math.max(1, Number(readArg("--workers=", "3")));
  const claimSize = Math.max(1, Number(readArg("--claim=", "8")));
  const contextLimit = Math.max(4, Number(readArg("--context=", "10")));
  const maxRows = Math.max(0, Number(readArg("--max=", "0")));
  const strictErrors = readArg("--strict-errors=", "1") !== "0";
  const rowRetries = Math.max(0, Number(readArg("--row-retries=", "2")));
  const retryBackoffMs = Math.max(200, Number(readArg("--retry-backoff-ms=", "1200")));
  const pollMs = Math.max(250, Number(readArg("--poll-ms=", "1200")));
  const idleSeconds = Math.max(10, Number(readArg("--idle-seconds=", "45")));
  const idlePollLimit = Math.max(2, Math.trunc((idleSeconds * 1000) / pollMs));

  const stats: WorkerStats = {
    claimed: 0,
    updated: 0,
    failed: 0,
    done: 0
  };
  const control: RunControl = { stopRequested: false };
  const startedAt = Date.now();

  const workerPromises: Promise<void>[] = [];
  for (let i = 0; i < workers; i += 1) {
    workerPromises.push(
      runWorker({
        workerId: `meta-w${i + 1}-${process.pid}`,
        chatNamespace,
        sourceSystem,
        claimSize,
        maxRows,
        contextLimit,
        strictErrors,
        rowRetries,
        retryBackoffMs,
        pollMs,
        idlePollLimit,
        globalStats: stats,
        control
      })
    );
  }

  await Promise.all(workerPromises);

  const elapsedSec = Math.max(1, (Date.now() - startedAt) / 1000);
  const queueSnapshot = await pool.query<{
    source_system: string;
    pending: string;
    processing: string;
    done: string;
    failed: string;
  }>(
    `SELECT
       source_system,
       COUNT(*) FILTER (WHERE status='pending')::text AS pending,
       COUNT(*) FILTER (WHERE status='processing')::text AS processing,
       COUNT(*) FILTER (WHERE status='done')::text AS done,
       COUNT(*) FILTER (WHERE status='failed')::text AS failed
     FROM metadata_enrichment_queue
     WHERE ($1::text = '' OR chat_namespace = $1::text)
       AND ($2::text = '' OR source_system = $2::text)
     GROUP BY source_system
     ORDER BY source_system`,
    [chatNamespace, sourceSystem]
  );

  // eslint-disable-next-line no-console
  console.log(JSON.stringify({
    ok: true,
    chatNamespace,
    sourceSystem: sourceSystem || "all",
    workers,
    claimSize,
    contextLimit,
    strictErrors,
    rowRetries,
    retryBackoffMs,
    elapsedSec: Number(elapsedSec.toFixed(2)),
    rowsPerSec: Number((stats.updated / elapsedSec).toFixed(2)),
    stats,
    queueBySource: queueSnapshot.rows
  }, null, 2));
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error("metadata queue worker failed:", error);
  process.exit(1);
});
