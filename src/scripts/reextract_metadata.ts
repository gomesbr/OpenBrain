import { pool } from "../db.js";
import { extractMetadata } from "../metadata_provider.js";
import { ensureExtendedSchema } from "../schema.js";

interface CandidateRow {
  id: string;
  content: string;
  source_system: string;
  source_conversation_id: string | null;
  source_message_id: string | null;
  chat_namespace: string | null;
  ts: string | null;
}

export interface ReextractMetadataOptions {
  chatNamespace?: string;
  sourceSystem?: string;
  batchSize?: number;
  maxRows?: number;
  onlyMissing?: boolean;
  order?: "asc" | "desc";
  onProgress?: (status: {
    scanned: number;
    updated: number;
    failed: number;
  }) => void;
}

function readArg(prefix: string, fallback: string): string {
  return process.argv.find((arg) => arg.startsWith(prefix))?.split("=")[1] ?? fallback;
}

async function fetchContextWindow(row: CandidateRow, limit = 10): Promise<string[]> {
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
      Math.max(3, Math.min(16, limit))
    ]
  );
  return rows.rows
    .map((r) => String(r.content ?? "").trim())
    .filter((line) => line.length > 0)
    .slice(0, limit)
    .reverse()
    .map((line) => line.slice(0, 360));
}

export async function reextractMetadata(options: ReextractMetadataOptions = {}): Promise<{
  ok: true;
  scanned: number;
  updated: number;
  failed: number;
  chatNamespace: string;
  sourceSystem: string;
  order: "asc" | "desc";
}> {
  await ensureExtendedSchema();
  const chatNamespace = String(options.chatNamespace ?? "personal.main").trim() || "personal.main";
  const sourceSystem = String(options.sourceSystem ?? "").trim();
  const batchSize = Number(options.batchSize ?? 200);
  const maxRows = Number(options.maxRows ?? 0);
  const onlyMissing = options.onlyMissing !== false;
  const order = String(options.order ?? "desc").toLowerCase() === "asc" ? "ASC" : "DESC";
  let updated = 0;
  let failed = 0;
  let scanned = 0;

  while (true) {
    if (maxRows > 0 && scanned >= maxRows) break;
    const rows = await pool.query<CandidateRow>(
      `SELECT
         id::text,
         content,
         source_system,
         source_conversation_id,
         source_message_id,
         chat_namespace,
         COALESCE(source_timestamp, created_at)::text AS ts
       FROM memory_items
       WHERE ($1::text = '' OR chat_namespace = $1::text)
         AND ($2::text = '' OR source_system = $2::text)
       AND (
           $3::boolean = false
           OR COALESCE(metadata->>'inference_version', '') <> 'v2.1'
           OR NOT (metadata ? 'domain_scores')
           OR jsonb_typeof(COALESCE(metadata->'domain_scores', '{}'::jsonb)) <> 'object'
         )
       ORDER BY COALESCE(source_timestamp, created_at) ${order}
       LIMIT $4`,
      [chatNamespace, sourceSystem, onlyMissing, Math.max(10, Math.min(1000, batchSize))]
    );

    if (rows.rowCount === 0) break;

    for (const row of rows.rows) {
      if (maxRows > 0 && scanned >= maxRows) break;
      scanned += 1;
      try {
        const contextWindow = await fetchContextWindow(row, 10);
        const metadata = await extractMetadata(row.content, {
          contextWindow,
          sourceSystem: row.source_system,
          sourceConversationId: row.source_conversation_id,
          chatNamespace: row.chat_namespace
        });
        await pool.query(
          `UPDATE memory_items
              SET metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb,
                  updated_at = now()
            WHERE id = $1::uuid`,
          [row.id, JSON.stringify(metadata)]
        );
        updated += 1;
      } catch (error) {
        failed += 1;
        const message = error instanceof Error ? error.message : String(error);
        // eslint-disable-next-line no-console
        console.error(`metadata update failed for ${row.id}: ${message}`);
      }
    }

    options.onProgress?.({ scanned, updated, failed });
  }

  return {
    ok: true,
    scanned,
    updated,
    failed,
    chatNamespace,
    sourceSystem: sourceSystem || "all",
    order: order.toLowerCase() === "asc" ? "asc" : "desc"
  };
}

async function main(): Promise<void> {
  const result = await reextractMetadata({
    chatNamespace: readArg("--chat=", "personal.main"),
    sourceSystem: readArg("--source=", ""),
    batchSize: Number(readArg("--batch=", "200")),
    maxRows: Number(readArg("--max=", "0")),
    onlyMissing: readArg("--only-missing=", "1") !== "0",
    order: readArg("--order=", "desc").toLowerCase() === "asc" ? "asc" : "desc",
    onProgress: ({ scanned, updated, failed }) => {
      // eslint-disable-next-line no-console
      console.log(`reextract progress: scanned=${scanned} updated=${updated} failed=${failed}`);
    }
  });
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error("reextract metadata failed:", error);
  process.exit(1);
});
