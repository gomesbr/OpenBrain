import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pool } from "../db.js";
import { getEmbedding } from "../embedding_provider.js";
import { toSemanticEmbeddingText } from "../semantic_text.js";
import { containsEmoji, extractContextKeywords } from "../semantic_text.js";

type Checkpoint = {
  lastCreatedAt: string | null;
  lastId: string | null;
  processed: number;
  failed: number;
  startedAt: string;
  updatedAt: string;
};

type Args = {
  batchSize: number;
  chatNamespace: string | null;
  sourceSystem: string | null;
  checkpointPath: string;
  resetCheckpoint: boolean;
};

function toVectorLiteral(vector: number[]): string {
  return `[${vector.map((n) => Number(n).toFixed(8)).join(",")}]`;
}

function parseArgs(argv: string[]): Args {
  let batchSize = 32;
  let chatNamespace: string | null = null;
  let sourceSystem: string | null = null;
  let checkpointPath = ".reembed_checkpoint.json";
  let resetCheckpoint = false;

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const next = argv[i + 1];

    if (token === "--batch-size") {
      const parsed = Number(next ?? "");
      if (Number.isFinite(parsed) && parsed > 0) batchSize = Math.trunc(parsed);
      i += 1;
    } else if (token === "--chat-namespace") {
      const value = String(next ?? "").trim();
      chatNamespace = value || null;
      i += 1;
    } else if (token === "--source-system") {
      const value = String(next ?? "").trim();
      sourceSystem = value || null;
      i += 1;
    } else if (token === "--checkpoint") {
      const value = String(next ?? "").trim();
      checkpointPath = value || checkpointPath;
      i += 1;
    } else if (token === "--reset-checkpoint") {
      resetCheckpoint = true;
    }
  }

  return {
    batchSize: Math.max(1, Math.min(500, batchSize)),
    chatNamespace,
    sourceSystem,
    checkpointPath: resolve(checkpointPath),
    resetCheckpoint
  };
}

function readCheckpoint(path: string): Checkpoint | null {
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf8");
  const parsed = JSON.parse(raw) as Partial<Checkpoint>;
  if (!parsed || typeof parsed !== "object") return null;
  return {
    lastCreatedAt: typeof parsed.lastCreatedAt === "string" ? parsed.lastCreatedAt : null,
    lastId: typeof parsed.lastId === "string" ? parsed.lastId : null,
    processed: Number(parsed.processed ?? 0),
    failed: Number(parsed.failed ?? 0),
    startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : new Date().toISOString(),
    updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString()
  };
}

function writeCheckpoint(path: string, checkpoint: Checkpoint): void {
  writeFileSync(path, `${JSON.stringify(checkpoint, null, 2)}\n`, "utf8");
}

function isLikelyCreditOrQuotaError(error: unknown): boolean {
  const message = String((error as Error)?.message ?? error ?? "").toLowerCase();
  return (
    message.includes("http 402") ||
    message.includes("insufficient") ||
    message.includes("quota") ||
    message.includes("billing")
  );
}

async function fetchConversationContextTerms(params: {
  sourceSystem: string;
  sourceConversationId: string | null;
  chatNamespace: string | null;
  sourceTimestamp: string | null;
}): Promise<string[]> {
  if (!params.sourceConversationId || !params.sourceTimestamp) return [];
  const rows = await pool.query<{ content: string }>(
    `SELECT content
       FROM memory_items
      WHERE source_system = $1
        AND source_conversation_id = $2
        AND ($3::text IS NULL OR chat_namespace = $3::text)
        AND source_timestamp IS NOT NULL
        AND source_timestamp < $4::timestamptz
      ORDER BY source_timestamp DESC
      LIMIT 8`,
    [params.sourceSystem, params.sourceConversationId, params.chatNamespace, params.sourceTimestamp]
  );
  return extractContextKeywords(rows.rows.map((row) => String(row.content ?? "")), 16);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const checkpointPath = args.checkpointPath;

  let checkpoint: Checkpoint = {
    lastCreatedAt: null,
    lastId: null,
    processed: 0,
    failed: 0,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  if (!args.resetCheckpoint) {
    const prior = readCheckpoint(checkpointPath);
    if (prior) {
      checkpoint = prior;
      process.stdout.write(`Resuming from checkpoint ${checkpointPath}\n`);
    }
  }

  const totalResult = await pool.query<{ total: string }>(
    `SELECT COUNT(*)::text AS total
       FROM memory_items
      WHERE ($1::text IS NULL OR chat_namespace = $1::text)
        AND ($2::text IS NULL OR source_system = $2::text)`,
    [args.chatNamespace, args.sourceSystem]
  );
  const total = Number(totalResult.rows[0]?.total ?? 0);
  process.stdout.write(`Rows eligible for re-embedding: ${total}\n`);

  const runStart = Date.now();
  const runStartProcessed = checkpoint.processed;

  while (true) {
    const rows = await pool.query<{
      id: string;
      content: string;
      source_system: string;
      source_conversation_id: string | null;
      chat_namespace: string | null;
      source_timestamp: string | null;
      created_at: string;
    }>(
      `SELECT id, content, source_system, source_conversation_id, chat_namespace, source_timestamp, created_at
         FROM memory_items
        WHERE ($1::text IS NULL OR chat_namespace = $1::text)
          AND ($2::text IS NULL OR source_system = $2::text)
          AND (
                $3::timestamptz IS NULL
                OR (created_at, id) > ($3::timestamptz, $4::uuid)
              )
        ORDER BY created_at ASC, id ASC
        LIMIT $5`,
      [args.chatNamespace, args.sourceSystem, checkpoint.lastCreatedAt, checkpoint.lastId, args.batchSize]
    );

    if (rows.rowCount === 0) {
      break;
    }

    for (const row of rows.rows) {
      try {
        const shouldUseConversationContext = containsEmoji(row.content) || row.content.length <= 48;
        const contextTerms = shouldUseConversationContext
          ? await fetchConversationContextTerms({
              sourceSystem: row.source_system,
              sourceConversationId: row.source_conversation_id,
              chatNamespace: row.chat_namespace,
              sourceTimestamp: row.source_timestamp
            })
          : [];
        const embedding = await getEmbedding(toSemanticEmbeddingText(row.content, { contextTerms }));
        await pool.query(
          `UPDATE memory_items
              SET embedding = $1::vector,
                  updated_at = now()
            WHERE id = $2::uuid`,
          [toVectorLiteral(embedding), row.id]
        );
        checkpoint.processed += 1;
      } catch (error) {
        checkpoint.failed += 1;
        checkpoint.lastCreatedAt = new Date(row.created_at).toISOString();
        checkpoint.lastId = row.id;
        checkpoint.updatedAt = new Date().toISOString();
        writeCheckpoint(checkpointPath, checkpoint);

        if (isLikelyCreditOrQuotaError(error)) {
          process.stderr.write(
            `Stopped on likely credit/quota error after ${checkpoint.processed} updates. Checkpoint saved: ${checkpointPath}\n`
          );
          throw error;
        }

        process.stderr.write(`Re-embed failed for ${row.id}: ${String((error as Error)?.message ?? error)}\n`);
      }

      checkpoint.lastCreatedAt = new Date(row.created_at).toISOString();
      checkpoint.lastId = row.id;
    }

    checkpoint.updatedAt = new Date().toISOString();
    writeCheckpoint(checkpointPath, checkpoint);

    const elapsedSec = Math.max(1, Math.floor((Date.now() - runStart) / 1000));
    const runProcessed = checkpoint.processed - runStartProcessed;
    const rate = (runProcessed / elapsedSec).toFixed(2);
    const pct = total > 0 ? ((checkpoint.processed / total) * 100).toFixed(2) : "100.00";
    process.stdout.write(
      `Progress: ${checkpoint.processed}/${total} (${pct}%) | failed=${checkpoint.failed} | rate=${rate} rows/s\n`
    );
  }

  checkpoint.updatedAt = new Date().toISOString();
  writeCheckpoint(checkpointPath, checkpoint);

  process.stdout.write(
    `Re-embedding complete. Processed=${checkpoint.processed}, Failed=${checkpoint.failed}, Checkpoint=${checkpointPath}\n`
  );
}

main()
  .catch((error) => {
    process.stderr.write(`Re-embedding failed: ${String((error as Error)?.message ?? error)}\n`);
    process.exit(1);
  })
  .finally(async () => {
    await pool.end().catch(() => {});
  });
