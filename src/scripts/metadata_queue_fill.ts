import { ensureExtendedSchema } from "../schema.js";
import { pool } from "../db.js";

function readArg(prefix: string, fallback: string): string {
  return process.argv.find((arg) => arg.startsWith(prefix))?.split("=")[1] ?? fallback;
}

async function main(): Promise<void> {
  await ensureExtendedSchema();

  const chatNamespace = readArg("--chat=", "personal.main");
  const sourceSystem = readArg("--source=", "");
  const onlyMissing = readArg("--only-missing=", "1") !== "0";
  const retryFailed = readArg("--retry-failed=", "1") !== "0";
  const resetStaleProcessingMinutes = Number(readArg("--reset-stale-processing-min=", "120"));
  const force = readArg("--force=", "0") === "1";

  if (retryFailed) {
    await pool.query(
      `UPDATE metadata_enrichment_queue
          SET status = 'pending',
              last_error = NULL,
              locked_by = NULL,
              locked_at = NULL
        WHERE status = 'failed'
          AND ($1::text = '' OR chat_namespace = $1::text)
          AND ($2::text = '' OR source_system = $2::text)`,
      [chatNamespace, sourceSystem]
    );
  }

  if (Number.isFinite(resetStaleProcessingMinutes) && resetStaleProcessingMinutes > 0) {
    await pool.query(
      `UPDATE metadata_enrichment_queue
          SET status = 'pending',
              locked_by = NULL,
              locked_at = NULL
        WHERE status = 'processing'
          AND locked_at < now() - make_interval(mins => $1::int)
          AND ($2::text = '' OR chat_namespace = $2::text)
          AND ($3::text = '' OR source_system = $3::text)`,
      [Math.trunc(resetStaleProcessingMinutes), chatNamespace, sourceSystem]
    );
  }

  const inserted = await pool.query<{ inserted_rows: string }>(
    `WITH candidates AS (
       SELECT
         id AS memory_item_id,
         chat_namespace,
         source_system,
         source_timestamp
       FROM memory_items
       WHERE ($1::text = '' OR chat_namespace = $1::text)
         AND ($2::text = '' OR source_system = $2::text)
         AND (
           $3::boolean = false
           OR COALESCE(metadata->>'inference_version','') <> 'v2.1'
           OR NOT (metadata ? 'domain_scores')
           OR jsonb_typeof(COALESCE(metadata->'domain_scores', '{}'::jsonb)) <> 'object'
         )
     ),
     ins AS (
       INSERT INTO metadata_enrichment_queue (
         memory_item_id, chat_namespace, source_system, source_timestamp, status
       )
       SELECT memory_item_id, chat_namespace, source_system, source_timestamp, 'pending'
       FROM candidates
       ON CONFLICT (memory_item_id) DO NOTHING
       RETURNING 1
     )
     SELECT COUNT(*)::text AS inserted_rows FROM ins`,
    [chatNamespace, sourceSystem, onlyMissing]
  );

  if (force) {
    await pool.query(
      `UPDATE metadata_enrichment_queue q
          SET status = 'pending',
              last_error = NULL,
              locked_by = NULL,
              locked_at = NULL
        FROM memory_items m
       WHERE q.memory_item_id = m.id
         AND q.status <> 'processing'
         AND ($1::text = '' OR m.chat_namespace = $1::text)
         AND ($2::text = '' OR m.source_system = $2::text)`,
      [chatNamespace, sourceSystem]
    );
  }

  const queueCounts = await pool.query<{
    source_system: string;
    pending: string;
    processing: string;
    done: string;
    failed: string;
    total: string;
  }>(
    `SELECT
       source_system,
       COUNT(*) FILTER (WHERE status='pending')::text AS pending,
       COUNT(*) FILTER (WHERE status='processing')::text AS processing,
       COUNT(*) FILTER (WHERE status='done')::text AS done,
       COUNT(*) FILTER (WHERE status='failed')::text AS failed,
       COUNT(*)::text AS total
     FROM metadata_enrichment_queue
     WHERE ($1::text = '' OR chat_namespace = $1::text)
       AND ($2::text = '' OR source_system = $2::text)
     GROUP BY source_system
     ORDER BY source_system`
  , [chatNamespace, sourceSystem]);

  // eslint-disable-next-line no-console
  console.log(JSON.stringify({
    ok: true,
    insertedRows: Number(inserted.rows[0]?.inserted_rows ?? "0"),
    chatNamespace,
    sourceSystem: sourceSystem || "all",
    onlyMissing,
    retryFailed,
    force,
    queueBySource: queueCounts.rows
  }, null, 2));
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error("metadata queue fill failed:", error);
  process.exit(1);
});
