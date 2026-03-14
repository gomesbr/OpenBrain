import { createHash } from "node:crypto";
import { config } from "./config.js";

const OPENAI_BASE = "https://api.openai.com/v1";
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

function normalizeBaseUrl(value: string, fallback: string): string {
  const base = String(value ?? "").trim() || fallback;
  return base.replace(/\/+$/, "");
}

function resolveOpenAiEmbeddingModel(model: string): string {
  const trimmed = String(model ?? "").trim();
  return trimmed.replace(/^openai\//i, "") || "text-embedding-3-small";
}

async function requestEmbedding(params: {
  providerLabel: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  text: string;
  timeoutMs: number;
}): Promise<number[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), params.timeoutMs);

  try {
    const response = await fetch(`${params.baseUrl}/embeddings`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${params.apiKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: params.model,
        input: params.text
      })
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`${params.providerLabel} embeddings failed: HTTP ${response.status} ${body.slice(0, 200)}`);
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
  const mode = config.embeddingMode.toLowerCase();

  if (mode === "mock") {
    return createMockEmbedding(text);
  }

  if (mode === "openai") {
    if (!config.openAiApiKey) {
      throw new Error("OPENAI_API_KEY is required for openai embedding mode");
    }

    return requestEmbedding({
      providerLabel: "OpenAI",
      baseUrl: normalizeBaseUrl(config.openAiBaseUrl, OPENAI_BASE),
      apiKey: config.openAiApiKey,
      model: resolveOpenAiEmbeddingModel(config.embeddingModel),
      text,
      timeoutMs: config.requestTimeoutMs
    });
  }

  throw new Error(`Unsupported OPENBRAIN_EMBEDDING_MODE: ${config.embeddingMode}`);
}
