import { pool } from "../db.js";
import { config } from "../config.js";

const OPENAI_BASE = "https://api.openai.com/v1";

type PronounSet = {
  subject: string;
  object: string;
  possessive: string;
  confidence: number;
  source: string;
  rationale: string;
};

type ActorSeed = {
  actorId: string;
  canonicalName: string;
  actorTypes: string[];
  messageCount: number;
  sampleMessages: string[];
  hasPronouns: boolean;
};

function normalizeBaseUrl(value: string, fallback: string): string {
  const base = String(value ?? "").trim() || fallback;
  return base.replace(/\/+$/, "");
}

function resolveModel(model: string): string {
  const trimmed = String(model ?? "").trim();
  return trimmed.replace(/^openai\//i, "") || "gpt-4o-mini";
}

function clamp01(value: unknown, fallback = 0.5): number {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(0, Math.min(1, num));
}

function compactText(value: string, max = 240): string {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 3).trimEnd()}...`;
}

function normalizePronounTriplet(input: Partial<PronounSet> | null | undefined): PronounSet {
  const subject = String(input?.subject ?? "").trim().toLowerCase();
  const object = String(input?.object ?? "").trim().toLowerCase();
  const possessive = String(input?.possessive ?? "").trim().toLowerCase();
  const allowed = new Set([
    "he|him|his",
    "she|her|her",
    "they|them|their",
    "you|you|your",
    "it|it|its"
  ]);
  const key = `${subject}|${object}|${possessive}`;
  if (!allowed.has(key)) {
    return {
      subject: "they",
      object: "them",
      possessive: "their",
      confidence: clamp01(input?.confidence, 0.3),
      source: String(input?.source ?? "ambiguous_default"),
      rationale: compactText(String(input?.rationale ?? "Fallback to neutral pronouns because the inferred set was invalid."), 240)
    };
  }
  return {
    subject,
    object,
    possessive,
    confidence: clamp01(input?.confidence, subject === "they" ? 0.4 : 0.8),
    source: compactText(String(input?.source ?? "openai_inference"), 48),
    rationale: compactText(String(input?.rationale ?? ""), 240)
  };
}

function defaultPronounsForActor(seed: ActorSeed): PronounSet | null {
  const actorTypes = new Set(seed.actorTypes.map((value) => String(value ?? "").trim().toLowerCase()));
  if (actorTypes.has("user")) {
    return {
      subject: "you",
      object: "you",
      possessive: "your",
      confidence: 1,
      source: "actor_type_default",
      rationale: "User actor defaults to second-person pronouns."
    };
  }
  if (actorTypes.has("assistant")) {
    return {
      subject: "they",
      object: "them",
      possessive: "their",
      confidence: 1,
      source: "actor_type_default",
      rationale: "Assistant actor uses neutral pronouns; summaries usually render as 'The assistant'."
    };
  }
  if (actorTypes.has("system")) {
    return {
      subject: "it",
      object: "it",
      possessive: "its",
      confidence: 1,
      source: "actor_type_default",
      rationale: "System actor defaults to it/it/its."
    };
  }
  return null;
}

async function loadActorsMissingPronouns(): Promise<ActorSeed[]> {
  const result = await pool.query<{
    actor_id: string;
    canonical_name: string;
    actor_types: string[] | null;
    message_count: string;
    sample_messages: string[] | null;
    has_pronouns: boolean;
  }>(`
    WITH actor_types AS (
      SELECT actor_id, array_agg(DISTINCT actor_type ORDER BY actor_type) AS actor_types
      FROM actor_context
      GROUP BY actor_id
    ),
    sample_messages AS (
      SELECT
        a.actor_id,
        COUNT(cm.id) AS message_count,
        ARRAY(
          SELECT compact.content_normalized
          FROM (
            SELECT cm2.content_normalized, cm2.quality_score, cm2.observed_at
            FROM canonical_messages cm2
            WHERE cm2.actor_id = a.actor_id
              AND cm2.artifact_state = 'published'
              AND cm2.content_normalized IS NOT NULL
              AND length(trim(cm2.content_normalized)) >= 24
            ORDER BY COALESCE(cm2.quality_score, 0) DESC, cm2.observed_at DESC NULLS LAST
            LIMIT 4
          ) compact
        ) AS sample_messages
      FROM actors a
      LEFT JOIN canonical_messages cm
        ON cm.actor_id = a.actor_id
       AND cm.artifact_state = 'published'
      GROUP BY a.actor_id
    )
    SELECT
      a.actor_id::text,
      a.canonical_name,
      at.actor_types,
      COALESCE(sm.message_count, 0)::text AS message_count,
      sm.sample_messages,
      (a.metadata ? 'pronouns') AS has_pronouns
    FROM actors a
    LEFT JOIN actor_types at ON at.actor_id = a.actor_id
    LEFT JOIN sample_messages sm ON sm.actor_id = a.actor_id
    WHERE NOT (a.metadata ? 'pronouns')
    ORDER BY a.canonical_name ASC
  `);

  return result.rows.map((row) => ({
    actorId: row.actor_id,
    canonicalName: String(row.canonical_name ?? "").trim(),
    actorTypes: Array.isArray(row.actor_types) ? row.actor_types.map((v) => String(v ?? "").trim()).filter(Boolean) : [],
    messageCount: Number(row.message_count ?? 0) || 0,
    sampleMessages: Array.isArray(row.sample_messages) ? row.sample_messages.map((v) => compactText(String(v ?? ""), 320)).filter(Boolean) : [],
    hasPronouns: Boolean(row.has_pronouns)
  }));
}

async function inferPronounsBatch(seeds: ActorSeed[]): Promise<Map<string, PronounSet>> {
  const out = new Map<string, PronounSet>();
  const apiKey = String(config.openAiApiKey ?? "").trim();
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is required for actor pronoun backfill.");
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(120_000, config.requestTimeoutMs * 4));
  try {
    const response = await fetch(`${normalizeBaseUrl(config.openAiBaseUrl, OPENAI_BASE)}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: resolveModel(config.metadataModel),
        max_tokens: 3000,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              "Infer narrative pronouns for actors in a personal-memory system. " +
              "Return ONLY JSON with shape {\"items\":[{\"actorId\":\"...\",\"subject\":\"...\",\"object\":\"...\",\"possessive\":\"...\",\"confidence\":0.0,\"source\":\"...\",\"rationale\":\"...\"}]}.\n" +
              "Allowed pronoun sets only: he/him/his, she/her/her, they/them/their, you/you/your, it/it/its.\n" +
              "Use canonical name, actor types, and sample messages. If evidence is weak or ambiguous, choose they/them/their with lower confidence. " +
              "Do not guess aggressively from a weak name alone. Preserve clear human attribution when the evidence supports it."
          },
          {
            role: "user",
            content: JSON.stringify({
              actors: seeds.map((seed) => ({
                actorId: seed.actorId,
                canonicalName: seed.canonicalName,
                actorTypes: seed.actorTypes,
                messageCount: seed.messageCount,
                sampleMessages: seed.sampleMessages
              }))
            })
          }
        ]
      })
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`OpenAI pronoun inference failed: HTTP ${response.status} ${body.slice(0, 200)}`);
    }

    const payload = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = String(payload?.choices?.[0]?.message?.content ?? "").trim();
    const parsed = JSON.parse(content) as { items?: Array<Record<string, unknown>> };
    for (const item of Array.isArray(parsed.items) ? parsed.items : []) {
      const actorId = String(item.actorId ?? "").trim();
      if (!actorId) continue;
      out.set(actorId, normalizePronounTriplet({
        subject: String(item.subject ?? ""),
        object: String(item.object ?? ""),
        possessive: String(item.possessive ?? ""),
        confidence: Number(item.confidence ?? 0.4),
        source: String(item.source ?? "openai_inference"),
        rationale: String(item.rationale ?? "")
      }));
    }
    return out;
  } finally {
    clearTimeout(timeout);
  }
}

async function applyPronouns(actorId: string, pronouns: PronounSet): Promise<void> {
  await pool.query(
    `UPDATE actors
        SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
          'pronouns',
          jsonb_build_object(
            'subject', $2::text,
            'object', $3::text,
            'possessive', $4::text,
            'confidence', $5::double precision,
            'source', $6::text,
            'rationale', $7::text,
            'inferredAt', to_jsonb(now())
          )
        ),
            updated_at = now()
      WHERE actor_id = $1::uuid`,
    [
      actorId,
      pronouns.subject,
      pronouns.object,
      pronouns.possessive,
      pronouns.confidence,
      pronouns.source,
      pronouns.rationale
    ]
  );
}

async function main(): Promise<void> {
  const all = await loadActorsMissingPronouns();
  const defaults = all
    .map((seed) => ({ seed, pronouns: defaultPronounsForActor(seed) }))
    .filter((entry): entry is { seed: ActorSeed; pronouns: PronounSet } => Boolean(entry.pronouns));

  for (const entry of defaults) {
    await applyPronouns(entry.seed.actorId, entry.pronouns);
  }

  const unresolved = all.filter((seed) => !defaultPronounsForActor(seed));
  const batchSize = 10;
  let inferredCount = 0;
  for (let i = 0; i < unresolved.length; i += batchSize) {
    const batch = unresolved.slice(i, i + batchSize);
    const inferred = await inferPronounsBatch(batch);
    for (const seed of batch) {
      const pronouns = inferred.get(seed.actorId) ?? {
        subject: "they",
        object: "them",
        possessive: "their",
        confidence: 0.25,
        source: "ambiguous_default",
        rationale: "Model did not return a pronoun set for this actor; using neutral fallback."
      };
      await applyPronouns(seed.actorId, pronouns);
      inferredCount += 1;
    }
    console.log(JSON.stringify({
      phase: "batch",
      completed: Math.min(i + batch.length, unresolved.length),
      total: unresolved.length
    }));
  }

  const coverage = await pool.query<{ total: string; with_pronouns: string }>(
    `SELECT
       COUNT(*)::text AS total,
       COUNT(*) FILTER (WHERE metadata ? 'pronouns')::text AS with_pronouns
     FROM actors`
  );
  console.log(JSON.stringify({
    ok: true,
    defaultsApplied: defaults.length,
    inferredApplied: inferredCount,
    coverage: coverage.rows[0]
  }, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end().catch(() => undefined);
  });
