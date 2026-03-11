import { ensureExtendedSchema } from "../schema.js";
import { pool } from "../db.js";

function readArg(prefix: string, fallback: string): string {
  return process.argv.find((arg) => arg.startsWith(prefix))?.split("=")[1] ?? fallback;
}

async function main(): Promise<void> {
  await ensureExtendedSchema();

  const chatNamespace = readArg("--chat=", "personal.main");
  const sourceSystem = readArg("--source=", "");

  const queue = await pool.query<{
    source_system: string;
    pending: string;
    processing: string;
    done: string;
    failed: string;
    total: string;
    pct_done: string;
  }>(
    `SELECT
       source_system,
       COUNT(*) FILTER (WHERE status='pending')::text AS pending,
       COUNT(*) FILTER (WHERE status='processing')::text AS processing,
       COUNT(*) FILTER (WHERE status='done')::text AS done,
       COUNT(*) FILTER (WHERE status='failed')::text AS failed,
       COUNT(*)::text AS total,
       ROUND(
         100.0 * COUNT(*) FILTER (WHERE status='done')
         / GREATEST(COUNT(*), 1),
         2
       )::text AS pct_done
     FROM metadata_enrichment_queue
     WHERE ($1::text = '' OR chat_namespace = $1::text)
       AND ($2::text = '' OR source_system = $2::text)
     GROUP BY source_system
     ORDER BY source_system`,
    [chatNamespace, sourceSystem]
  );

  const v21 = await pool.query<{
    source_system: string;
    total_rows: string;
    v21_rows: string;
    v21_pct: string;
  }>(
    `SELECT
       source_system,
       COUNT(*)::text AS total_rows,
       COUNT(*) FILTER (WHERE COALESCE(metadata->>'inference_version','')='v2.1')::text AS v21_rows,
       ROUND(
         100.0 * COUNT(*) FILTER (WHERE COALESCE(metadata->>'inference_version','')='v2.1')
         / GREATEST(COUNT(*),1),
         2
       )::text AS v21_pct
     FROM memory_items
     WHERE ($1::text = '' OR chat_namespace = $1::text)
       AND ($2::text = '' OR source_system = $2::text)
     GROUP BY source_system
     ORDER BY source_system`,
    [chatNamespace, sourceSystem]
  );

  const stalled = await pool.query<{
    source_system: string;
    stalled_processing: string;
    oldest_lock: string | null;
  }>(
    `SELECT
       source_system,
       COUNT(*)::text AS stalled_processing,
       MIN(locked_at)::text AS oldest_lock
     FROM metadata_enrichment_queue
     WHERE status='processing'
       AND locked_at < now() - interval '30 minutes'
       AND ($1::text = '' OR chat_namespace = $1::text)
       AND ($2::text = '' OR source_system = $2::text)
     GROUP BY source_system
     ORDER BY source_system`,
    [chatNamespace, sourceSystem]
  );

  // eslint-disable-next-line no-console
  console.log(JSON.stringify({
    ok: true,
    generatedAt: new Date().toISOString(),
    chatNamespace,
    sourceSystem: sourceSystem || "all",
    queueBySource: queue.rows,
    v21CoverageBySource: v21.rows,
    stalledProcessing: stalled.rows
  }, null, 2));
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error("metadata queue progress failed:", error);
  process.exit(1);
});
