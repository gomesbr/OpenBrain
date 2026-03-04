import { createHash } from "node:crypto";
import { config } from "./config.js";

const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
const EMBEDDING_DIM = 1536;

function hashToUnitFloat(input: string): number {
  const hash = createHash("sha256").update(input).digest();
  const n = hash.readUInt32BE(0);
  return (n / 0xffffffff) * 2 - 1;
}

function normalize(vec: number[]): number[] {
  const norm = Math.sqrt(vec.reduce((acc, item) => acc + item * item, 0));
  if (!Number.isFinite(norm) || norm === 0) return vec;
  return vec.map((v) => v / norm);
}

export function createMockEmbedding(text: string): number[] {
  const tokens = text
    .toLowerCase()
    .split(/[^a-z0-9_]+/i)
    .map((x) => x.trim())
    .filter((x) => x.length > 0);

  const vector = new Array<number>(EMBEDDING_DIM).fill(0);
  const effective = tokens.length > 0 ? tokens : [text.slice(0, 64) || "empty"];

  for (let i = 0; i < effective.length; i += 1) {
    const token = effective[i];
    for (let d = 0; d < EMBEDDING_DIM; d += 1) {
      const mix = `${token}:${d}:${i}`;
      vector[d] += hashToUnitFloat(mix);
    }
  }

  return normalize(vector);
}

export async function getEmbedding(text: string): Promise<number[]> {
  if (config.embeddingMode !== "openrouter") {
    return createMockEmbedding(text);
  }

  if (!config.openRouterApiKey) {
    throw new Error("OPENROUTER_API_KEY is required for openrouter embedding mode");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);

  try {
    const response = await fetch(`${OPENROUTER_BASE}/embeddings`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${config.openRouterApiKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: config.embeddingModel,
        input: text
      })
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`OpenRouter embeddings failed: HTTP ${response.status} ${body.slice(0, 200)}`);
    }

    const payload = (await response.json()) as { data?: Array<{ embedding?: number[] }> };
    const embedding = payload?.data?.[0]?.embedding;
    if (!Array.isArray(embedding) || embedding.length !== EMBEDDING_DIM) {
      throw new Error(`Unexpected embedding response shape or dimension (expected ${EMBEDDING_DIM}).`);
    }

    return embedding;
  } finally {
    clearTimeout(timeout);
  }
}
