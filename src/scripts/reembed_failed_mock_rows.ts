import { readFileSync } from "node:fs";
import { config } from "../config.js";
import { pool } from "../db.js";
import { createMockEmbedding } from "../embedding_provider.js";
import { toSemanticEmbeddingText } from "../semantic_text.js";

const EMBEDDING_DIM = 1536;

function toVectorLiteral(vector: number[]): string {
  return `[${vector.map((n) => Number(n).toFixed(8)).join(",")}]`;
}

function normalize(vector: number[]): number[] {
  const norm = Math.sqrt(vector.reduce((acc, item) => acc + item * item, 0));
  if (!Number.isFinite(norm) || norm === 0) return vector;
  return vector.map((item) => item / norm);
}

function avgVectors(vectors: number[][]): number[] {
  const out = new Array<number>(EMBEDDING_DIM).fill(0);
  for (const v of vectors) {
    for (let i = 0; i < EMBEDDING_DIM; i += 1) {
      out[i] += Number(v[i] || 0);
    }
  }
  const count = Math.max(1, vectors.length);
  for (let i = 0; i < EMBEDDING_DIM; i += 1) out[i] /= count;
  return normalize(out);
}

function sanitizeText(input: string): string {
  let text = String(input || "");
  text = text.replace(/\u0000/g, " ");
  text = text.replace(/[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ");
  text = text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, "");
  text = text.replace(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");
  text = text.replace(/\s+/g, " ").trim();
  return text.length > 0 ? text : "[empty]";
}

function openAiModel(): string {
  return String(config.embeddingModel || "text-embedding-3-small")
    .trim()
    .replace(/^openai\//i, "") || "text-embedding-3-small";
}

async function fetchOpenAiEmbedding(text: string): Promise<number[]> {
  const key = String(config.openAiApiKey || "").trim();
  if (!key) {
    throw new Error("OPENAI_API_KEY missing");
  }
  const base = String(config.openAiBaseUrl || "https://api.openai.com/v1").replace(/\/+$/, "");
  const res = await fetch(`${base}/embeddings`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: openAiModel(),
      input: text
    })
  });
  const raw = await res.text();
  let payload: any = null;
  try {
    payload = JSON.parse(raw);
  } catch {
    payload = null;
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${raw.slice(0, 260)}`);
  }
  const embedding = payload?.data?.[0]?.embedding;
  if (!Array.isArray(embedding) || embedding.length !== EMBEDDING_DIM) {
    throw new Error("Invalid embedding payload shape");
  }
  return embedding;
}

async function robustEmbedding(text: string): Promise<number[]> {
  const clean = sanitizeText(toSemanticEmbeddingText(text));
  try {
    return await fetchOpenAiEmbedding(clean);
  } catch {
    const chunks = clean.match(/[\s\S]{1,800}/g) || [clean];
    const vectors: number[][] = [];
    for (const chunk of chunks) {
      vectors.push(await fetchOpenAiEmbedding(chunk));
    }
    return avgVectors(vectors);
  }
}

async function isMockEmbedding(id: string, content: string): Promise<boolean> {
  const mockLiteral = toVectorLiteral(createMockEmbedding(content));
  const res = await pool.query<{ is_mock: boolean }>(
    `SELECT (embedding = $2::vector) AS is_mock
       FROM memory_items
      WHERE id = $1::uuid`,
    [id, mockLiteral]
  );
  return Boolean(res.rows[0]?.is_mock);
}

function parseFailedIdsFromLog(logPath: string): string[] {
  const raw = readFileSync(logPath, "utf8");
  const ids = new Set<string>();
  for (const m of raw.matchAll(/Re-embed failed for ([0-9a-f\-]{36})/gi)) {
    ids.add(String(m[1]).toLowerCase());
  }
  return Array.from(ids.values());
}

async function main(): Promise<void> {
  const ids = parseFailedIdsFromLog(".reembed.log");
  let targetedMockRows = 0;
  let fixed = 0;
  let stillFailed = 0;

  for (const id of ids) {
    const rowRes = await pool.query<{ content: string }>(
      `SELECT content
         FROM memory_items
        WHERE id = $1::uuid`,
      [id]
    );
    if (rowRes.rowCount === 0) continue;
    const content = String(rowRes.rows[0]?.content || "");
    if (!(await isMockEmbedding(id, content))) continue;

    targetedMockRows += 1;
    try {
      const embedding = await robustEmbedding(content);
      await pool.query(
        `UPDATE memory_items
            SET embedding = $1::vector,
                updated_at = now()
          WHERE id = $2::uuid`,
        [toVectorLiteral(embedding), id]
      );

      if (await isMockEmbedding(id, content)) {
        stillFailed += 1;
        process.stdout.write(`${id} -> update_applied_but_still_mock\n`);
      } else {
        fixed += 1;
        process.stdout.write(`${id} -> fixed\n`);
      }
    } catch (error) {
      stillFailed += 1;
      const message = error instanceof Error ? error.message : String(error);
      process.stdout.write(`${id} -> failed (${message.slice(0, 180)})\n`);
    }
  }

  process.stdout.write(
    `${JSON.stringify({ failedIds: ids.length, targetedMockRows, fixed, stillFailed }, null, 2)}\n`
  );
}

main()
  .catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`reembed_failed_mock_rows failed: ${message}\n`);
    process.exit(1);
  })
  .finally(async () => {
    await pool.end().catch(() => {});
  });
