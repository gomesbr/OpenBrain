import { createHash } from "node:crypto";
import { Pool } from "pg";
import { config } from "./config.js";
import { getEmbedding } from "./embedding_provider.js";
import { extractMetadata } from "./metadata_provider.js";
import { normalizeTimestamp } from "./time.js";
import type {
  BatchCaptureItem,
  BatchCaptureRequest,
  BatchCaptureResponse,
  CaptureMemoryRequest,
  CaptureMemoryResponse,
  MemoryStatsResponse,
  RecentMemoryResponse,
  SearchMemoryMatch,
  SearchMemoryRequest,
  SearchMemoryResponse
} from "./types.js";

const CONTENT_MAX = 12_000;
const DEDUPE_WINDOW_MINUTES = 10;

export const pool = new Pool({
  host: config.postgresHost,
  port: config.postgresPort,
  database: config.postgresDb,
  user: config.postgresUser,
  password: config.postgresPassword,
  max: 10
});

function truncateContent(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= CONTENT_MAX) return trimmed;
  return `${trimmed.slice(0, CONTENT_MAX - 3).trimEnd()}...`;
}

function toVectorLiteral(vector: number[]): string {
  return `[${vector.map((n) => Number(n).toFixed(8)).join(",")}]`;
}

function toIsoOrNull(value: string | null | undefined): string | null {
  if (!value) return null;
  return normalizeTimestamp(value);
}

function toContentHash(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

interface DedupeResult {
  status: "inserted" | "deduped";
  existingId?: string;
  reason?: string;
}

interface MemoryItemRow {
  id: string;
  content: string;
  role: string;
  source_system: string;
  source_conversation_id: string | null;
  source_message_id: string | null;
  source_timestamp: string | Date | null;
  chat_namespace: string | null;
  metadata: Record<string, unknown> | null;
  similarity: number | string;
  created_at: string | Date;
}

async function findExistingByDedupe(req: {
  idempotencyKey: string | null;
  sourceSystem: string;
  sourceConversationId: string | null;
  sourceMessageId: string | null;
  contentHash: string;
  chatNamespace: string | null;
  role: string;
  sourceTimestamp: string | null;
}): Promise<DedupeResult | null> {
  if (req.idempotencyKey) {
    const byKey = await pool.query<{ id: string }>(
      `SELECT id FROM memory_items WHERE idempotency_key = $1 LIMIT 1`,
      [req.idempotencyKey]
    );
    if (byKey.rowCount && byKey.rows[0]?.id) {
      return { status: "deduped", existingId: byKey.rows[0].id, reason: "idempotency_key" };
    }
  }

  if (req.sourceConversationId && req.sourceMessageId) {
    const bySourceTuple = await pool.query<{ id: string }>(
      `SELECT id
         FROM memory_items
        WHERE source_system = $1
          AND source_conversation_id = $2
          AND source_message_id = $3
        LIMIT 1`,
      [req.sourceSystem, req.sourceConversationId, req.sourceMessageId]
    );
    if (bySourceTuple.rowCount && bySourceTuple.rows[0]?.id) {
      return { status: "deduped", existingId: bySourceTuple.rows[0].id, reason: "source_tuple" };
    }
  }

  if (req.sourceTimestamp) {
    const byHashWindow = await pool.query<{ id: string }>(
      `SELECT id
         FROM memory_items
        WHERE content_hash = $1
          AND role = $2
          AND ($3::text IS NULL OR chat_namespace = $3::text)
          AND source_timestamp IS NOT NULL
          AND source_timestamp BETWEEN ($4::timestamptz - make_interval(mins => $5))
                                   AND ($4::timestamptz + make_interval(mins => $5))
        LIMIT 1`,
      [
        req.contentHash,
        req.role,
        req.chatNamespace,
        req.sourceTimestamp,
        DEDUPE_WINDOW_MINUTES
      ]
    );

    if (byHashWindow.rowCount && byHashWindow.rows[0]?.id) {
      return { status: "deduped", existingId: byHashWindow.rows[0].id, reason: "hash_window" };
    }
  } else {
    const byHashRecent = await pool.query<{ id: string }>(
      `SELECT id
         FROM memory_items
        WHERE content_hash = $1
          AND role = $2
          AND ($3::text IS NULL OR chat_namespace = $3::text)
          AND created_at >= now() - interval '90 minutes'
        LIMIT 1`,
      [req.contentHash, req.role, req.chatNamespace]
    );

    if (byHashRecent.rowCount && byHashRecent.rows[0]?.id) {
      return { status: "deduped", existingId: byHashRecent.rows[0].id, reason: "hash_recent" };
    }
  }

  return null;
}

export async function captureMemory(req: CaptureMemoryRequest): Promise<CaptureMemoryResponse> {
  const content = truncateContent(String(req.content ?? ""));
  if (!content) {
    throw new Error("content is required");
  }

  const role = req.role;
  const sourceSystem = req.sourceSystem;
  const sourceConversationId = req.sourceConversationId ? String(req.sourceConversationId) : null;
  const sourceMessageId = req.sourceMessageId ? String(req.sourceMessageId) : null;
  const sourceTimestamp = toIsoOrNull(req.sourceTimestamp ?? null);
  const chatNamespace = req.chatNamespace ? String(req.chatNamespace) : null;
  const idempotencyKey = req.idempotencyKey ? String(req.idempotencyKey) : null;
  const contentHash = toContentHash(content);

  const dedupe = await findExistingByDedupe({
    idempotencyKey,
    sourceSystem,
    sourceConversationId,
    sourceMessageId,
    contentHash,
    chatNamespace,
    role,
    sourceTimestamp
  });

  if (dedupe?.status === "deduped") {
    return {
      ok: true,
      status: "deduped",
      id: String(dedupe.existingId),
      contentHash,
      dedupeReason: dedupe.reason
    };
  }

  const [embedding, extracted] = await Promise.all([
    getEmbedding(content),
    req.skipMetadataExtraction ? Promise.resolve<Record<string, unknown>>({}) : extractMetadata(content)
  ]);

  const metadata = {
    ...extracted,
    ...(req.metadata ?? {})
  };

  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO memory_items (
       content,
       embedding,
       role,
       source_system,
       source_conversation_id,
       source_message_id,
       source_timestamp,
       chat_namespace,
       metadata,
       content_hash,
       idempotency_key
     )
     VALUES ($1, $2::vector, $3, $4, $5, $6, $7::timestamptz, $8, $9::jsonb, $10, $11)
     RETURNING id`,
    [
      content,
      toVectorLiteral(embedding),
      role,
      sourceSystem,
      sourceConversationId,
      sourceMessageId,
      sourceTimestamp,
      chatNamespace,
      JSON.stringify(metadata),
      contentHash,
      idempotencyKey
    ]
  );

  const id = inserted.rows[0]?.id;
  if (!id) {
    throw new Error("Failed to persist memory item");
  }
  await queueBrainJobItem(id);

  return {
    ok: true,
    status: "inserted",
    id,
    contentHash
  };
}

async function createIngestionJob(sourceSystem: string, inputRef: string | undefined): Promise<string> {
  const row = await pool.query<{ id: string }>(
    `INSERT INTO ingestion_jobs (source_system, status, input_ref, started_at)
     VALUES ($1, 'running', $2, now())
     RETURNING id`,
    [sourceSystem, inputRef ?? null]
  );

  const jobId = row.rows[0]?.id;
  if (!jobId) throw new Error("Failed to create ingestion job");
  return jobId;
}

async function finalizeIngestionJob(jobId: string, params: {
  status: "completed" | "failed" | "partial";
  summary: Record<string, unknown>;
  errorText?: string;
}): Promise<void> {
  await pool.query(
    `UPDATE ingestion_jobs
        SET status = $2,
            summary = $3::jsonb,
            error_text = $4,
            finished_at = now()
      WHERE id = $1`,
    [jobId, params.status, JSON.stringify(params.summary), params.errorText ?? null]
  );
}

async function appendIngestionJobItem(
  jobId: string,
  itemKey: string,
  status: "inserted" | "deduped" | "failed",
  errorText?: string
): Promise<void> {
  await pool.query(
    `INSERT INTO ingestion_job_items (job_id, item_key, status, error_text)
     VALUES ($1, $2, $3, $4)`,
    [jobId, itemKey, status, errorText ?? null]
  );
}

async function queueBrainJobItem(memoryItemId: string): Promise<void> {
  const running = await pool.query<{ id: string }>(
    `SELECT id
       FROM brain_jobs
      WHERE job_type = 'incremental'
        AND status = 'running'
      ORDER BY created_at ASC
      LIMIT 1`
  );

  let jobId = running.rows[0]?.id;
  if (!jobId) {
    const created = await pool.query<{ id: string }>(
      `INSERT INTO brain_jobs (job_type, status, requested_by, scope, started_at)
       VALUES ('incremental', 'running', 'system', '{}'::jsonb, now())
       RETURNING id`
    );
    jobId = created.rows[0]?.id;
  }

  if (!jobId) return;

  await pool.query(
    `INSERT INTO brain_job_items (job_id, memory_item_id, status)
     VALUES ($1, $2, 'pending')
     ON CONFLICT DO NOTHING`,
    [jobId, memoryItemId]
  );
}

export async function batchCapture(req: BatchCaptureRequest): Promise<BatchCaptureResponse> {
  if (!Array.isArray(req.items) || req.items.length === 0) {
    throw new Error("items must be a non-empty array");
  }

  const dryRun = Boolean(req.dryRun);
  const jobId = await createIngestionJob(req.sourceSystem, req.inputRef);

  let inserted = 0;
  let deduped = 0;
  let failed = 0;

  try {
    for (let i = 0; i < req.items.length; i += 1) {
      const item = req.items[i] as BatchCaptureItem;
      const itemKey = String(item.itemKey ?? `${i + 1}`);

      try {
        if (dryRun) {
          const content = truncateContent(String(item.content ?? ""));
          const role = item.role;
          const sourceConversationId = item.sourceConversationId ? String(item.sourceConversationId) : null;
          const sourceMessageId = item.sourceMessageId ? String(item.sourceMessageId) : null;
          const sourceTimestamp = toIsoOrNull(item.sourceTimestamp ?? null);
          const chatNamespace = item.chatNamespace ? String(item.chatNamespace) : null;
          const idempotencyKey = item.idempotencyKey ? String(item.idempotencyKey) : null;
          const contentHash = toContentHash(content);
          const dup = await findExistingByDedupe({
            idempotencyKey,
            sourceSystem: item.sourceSystem,
            sourceConversationId,
            sourceMessageId,
            contentHash,
            chatNamespace,
            role,
            sourceTimestamp
          });

          if (dup) {
            deduped += 1;
            await appendIngestionJobItem(jobId, itemKey, "deduped", dup.reason);
          } else {
            inserted += 1;
            await appendIngestionJobItem(jobId, itemKey, "inserted", "dry_run_would_insert");
          }

          continue;
        }

        const result = await captureMemory(item);
        if (result.status === "inserted") {
          inserted += 1;
          await appendIngestionJobItem(jobId, itemKey, "inserted");
        } else {
          deduped += 1;
          await appendIngestionJobItem(jobId, itemKey, "deduped", result.dedupeReason);
        }
      } catch (error) {
        failed += 1;
        const message = error instanceof Error ? error.message : String(error);
        await appendIngestionJobItem(jobId, itemKey, "failed", message.slice(0, 500));
      }
    }

    const status: "completed" | "partial" = failed > 0 ? "partial" : "completed";
    await finalizeIngestionJob(jobId, {
      status,
      summary: { inserted, deduped, failed, dryRun }
    });

    return {
      ok: true,
      jobId,
      inserted,
      deduped,
      failed,
      dryRun
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await finalizeIngestionJob(jobId, {
      status: "failed",
      summary: { inserted, deduped, failed, dryRun },
      errorText: message.slice(0, 1000)
    });
    throw error;
  }
}

function mapMatch(row: MemoryItemRow): SearchMemoryMatch {
  return {
    id: String(row.id),
    content: String(row.content ?? ""),
    role: String(row.role) as SearchMemoryMatch["role"],
    sourceSystem: String(row.source_system ?? "manual") as SearchMemoryMatch["sourceSystem"],
    sourceConversationId: row.source_conversation_id ? String(row.source_conversation_id) : null,
    sourceMessageId: row.source_message_id ? String(row.source_message_id) : null,
    sourceTimestamp: row.source_timestamp ? new Date(row.source_timestamp).toISOString() : null,
    chatNamespace: row.chat_namespace ? String(row.chat_namespace) : null,
    metadata: row.metadata && typeof row.metadata === "object" ? row.metadata : {},
    similarity: Number(row.similarity ?? 0),
    createdAt: new Date(row.created_at).toISOString()
  };
}

export async function searchMemory(req: SearchMemoryRequest): Promise<SearchMemoryResponse> {
  const queryText = String(req.query ?? "").trim();
  if (!queryText) {
    return { ok: true, query: "", count: 0, matches: [] };
  }

  const threshold = Number.isFinite(Number(req.threshold)) ? Number(req.threshold) : 0.55;
  const limit = Number.isFinite(Number(req.limit)) ? Math.max(1, Math.min(50, Number(req.limit))) : 10;
  const embedding = await getEmbedding(queryText);

  const rows = await pool.query<MemoryItemRow>(
    `SELECT * FROM match_memory_items(
      $1::vector,
      $2::float,
      $3::int,
      $4::text,
      $5::text,
      $6::text
    )`,
    [
      toVectorLiteral(embedding),
      threshold,
      limit,
      req.chatNamespace ?? null,
      req.sourceSystem ?? null,
      req.role ?? null
    ]
  );

  const matches = rows.rows.map((row) => mapMatch(row));
  return {
    ok: true,
    query: queryText,
    count: matches.length,
    matches
  };
}

export async function listRecent(params: {
  chatNamespace?: string;
  limit?: number;
  sourceSystem?: string;
  role?: string;
}): Promise<RecentMemoryResponse> {
  const limit = Number.isFinite(Number(params.limit))
    ? Math.max(1, Math.min(100, Number(params.limit)))
    : 20;

  const rows = await pool.query<MemoryItemRow>(
    `SELECT
       id,
       content,
       role,
       source_system,
       source_conversation_id,
       source_message_id,
       source_timestamp,
       chat_namespace,
       metadata,
       1::float AS similarity,
       created_at
     FROM memory_items
     WHERE ($1::text IS NULL OR chat_namespace = $1::text)
       AND ($2::text IS NULL OR source_system = $2::text)
       AND ($3::text IS NULL OR role = $3::text)
     ORDER BY COALESCE(source_timestamp, created_at) DESC, created_at DESC
     LIMIT $4`,
    [params.chatNamespace ?? null, params.sourceSystem ?? null, params.role ?? null, limit]
  );

  const items = rows.rows.map((row) => mapMatch(row));
  return {
    ok: true,
    count: items.length,
    items
  };
}

export async function getStats(chatNamespace: string | null, days = 30): Promise<MemoryStatsResponse> {
  const safeDays = Number.isFinite(Number(days)) ? Math.max(1, Math.min(3650, Number(days))) : 30;

  const totalRow = await pool.query<{ total: string; latest: string | null }>(
    `SELECT COUNT(*)::text AS total,
            MAX(COALESCE(source_timestamp, created_at))::text AS latest
       FROM memory_items
      WHERE ($1::text IS NULL OR chat_namespace = $1::text)
        AND created_at >= now() - make_interval(days => $2)`,
    [chatNamespace, safeDays]
  );

  const sourceRows = await pool.query<{ source_system: string; count: string }>(
    `SELECT source_system, COUNT(*)::text AS count
       FROM memory_items
      WHERE ($1::text IS NULL OR chat_namespace = $1::text)
        AND created_at >= now() - make_interval(days => $2)
      GROUP BY source_system
      ORDER BY count DESC`,
    [chatNamespace, safeDays]
  );

  const roleRows = await pool.query<{ role: string; count: string }>(
    `SELECT role, COUNT(*)::text AS count
       FROM memory_items
      WHERE ($1::text IS NULL OR chat_namespace = $1::text)
        AND created_at >= now() - make_interval(days => $2)
      GROUP BY role
      ORDER BY count DESC`,
    [chatNamespace, safeDays]
  );

  const total = Number(totalRow.rows[0]?.total ?? 0);
  const latest = totalRow.rows[0]?.latest ? new Date(totalRow.rows[0].latest).toISOString() : null;

  return {
    ok: true,
    chatNamespace,
    days: safeDays,
    totalItems: total,
    bySourceSystem: sourceRows.rows.map((row: { source_system: string; count: string }) => ({
      sourceSystem: row.source_system,
      count: Number(row.count)
    })),
    byRole: roleRows.rows.map((row: { role: string; count: string }) => ({ role: row.role, count: Number(row.count) })),
    latestCaptureAt: latest
  };
}

export async function healthcheck(): Promise<{ ok: boolean; postgres: string }> {
  try {
    await pool.query("SELECT 1");
    return { ok: true, postgres: "ok" };
  } catch {
    return { ok: false, postgres: "error" };
  }
}
