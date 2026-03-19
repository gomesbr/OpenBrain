import { createHash } from "node:crypto";
import { pool } from "./db.js";
import { config } from "./config.js";
import { TAXONOMY_DOMAINS } from "./domain_inference.js";

const STOP_ENTITY = new Set([
  "yes",
  "no",
  "ok",
  "aha",
  "ahh",
  "haha",
  "hahaha",
  "isso",
  "esta",
  "pero",
  "mas",
  "como",
  "que",
  "this",
  "that",
  "you",
  "me",
  "i",
  "the",
  "just",
  "let",
  "can",
  "what",
  "yeah",
  "thanks",
  "thank",
  "gracias",
  "pero",
  "vou",
  "pra",
  "por",
  "tem",
  "isso",
  "amem"
]);

const GENERIC_PERSON_TOKENS = new Set([
  "family",
  "friend",
  "friends",
  "couple",
  "partner",
  "parents",
  "mom",
  "dad",
  "wife",
  "husband",
  "baby",
  "participants",
  "neighbor",
  "neighbors"
]);

function norm(value: string): string {
  return String(value ?? "")
    .replaceAll("\u00a0", " ")
    .replaceAll("\u202f", " ")
    .replace(/^[~\s]+/u, "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s_-]+/g, "")
    .replace(/\s+/g, " ");
}

function hashKey(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function isLikelyNoiseEntity(name: string): boolean {
  const n = norm(name);
  if (!n) return true;
  if (n.length < 2) return true;
  if (STOP_ENTITY.has(n)) return true;
  if (GENERIC_PERSON_TOKENS.has(n)) return true;
  if (/\d/.test(n)) return true;
  if (/[,&/]/.test(String(name ?? ""))) return true;
  if (/\b(and|with|plus|participants|neighbors?)\b/.test(n)) return true;
  const tokens = n.split(" ").filter(Boolean);
  if (tokens.length > 4) return true;
  if (tokens.every((token) => STOP_ENTITY.has(token))) return true;
  if (tokens.some((token) => GENERIC_PERSON_TOKENS.has(token)) && tokens.length > 1) return true;
  if (tokens.every((token) => token.length <= 2)) return true;
  if (/^(ha)+$/.test(n)) return true;
  return false;
}

export async function materializeCandidates(limit = 2500): Promise<Record<string, number>> {
  const safeLimit = Number.isFinite(Number(limit)) ? Math.max(100, Math.min(500000, Number(limit))) : 2500;

  const insertedEntities = await pool.query(
    `WITH actor_projection AS (
       SELECT
         ac.chat_namespace,
         a.actor_id,
         a.normalized_name,
         a.canonical_name AS display_name,
         MAX(ac.confidence) AS base_confidence,
         COALESCE(SUM(asp.message_count), 0)::int AS message_count,
         MAX(COALESCE(asp.last_seen_at, ac.updated_at)) AS observed_at
       FROM actors a
       JOIN actor_context ac
         ON ac.actor_id = a.actor_id
       LEFT JOIN actor_source_profile asp
         ON asp.actor_id = a.actor_id
        AND asp.chat_namespace = ac.chat_namespace
       WHERE ac.actor_type IN ('user', 'contact')
       GROUP BY ac.chat_namespace, a.actor_id, a.normalized_name, a.canonical_name
       ORDER BY MAX(COALESCE(asp.last_seen_at, ac.updated_at)) DESC NULLS LAST
       LIMIT $1
     )
     INSERT INTO entity_candidates (
       chat_namespace,
       entity_type,
       normalized_name,
       display_name,
       confidence,
       evidence,
       artifact_state,
       quality_signals,
       created_at,
       updated_at
     )
     SELECT
       ap.chat_namespace,
       'person',
       ap.normalized_name,
       ap.display_name,
       LEAST(1.0, GREATEST(0.7, COALESCE(ap.base_confidence, 0.5) * 0.8 + LEAST(ap.message_count, 250)::float8 / 250.0 * 0.2)),
       jsonb_build_object(
         'actorId', ap.actor_id,
         'observedAt', ap.observed_at,
         'messageCount', ap.message_count,
         'sourceKind', 'actor_projection'
       ),
       'candidate',
       jsonb_build_object('source', 'actors', 'messageCount', ap.message_count, 'baseConfidence', ap.base_confidence),
       now(),
       now()
     FROM actor_projection ap
     WHERE ap.normalized_name <> ''
     ON CONFLICT (chat_namespace, entity_type, normalized_name)
     DO UPDATE SET
       display_name = EXCLUDED.display_name,
       confidence = GREATEST(entity_candidates.confidence, EXCLUDED.confidence),
       evidence = EXCLUDED.evidence,
       quality_signals = COALESCE(entity_candidates.quality_signals, '{}'::jsonb) || EXCLUDED.quality_signals,
       updated_at = now()`,
    [safeLimit]
  );

  const insertedFacts = await pool.query(
    `WITH src AS (
       SELECT
         c.id,
         c.chat_namespace,
         c.content_normalized,
         c.observed_at,
         c.quality_score,
         c.metadata
       FROM canonical_messages c
       WHERE c.artifact_state = 'published'
       ORDER BY c.observed_at DESC
       LIMIT $1
     ),
     domain_candidates AS (
       SELECT
         src.id,
         src.chat_namespace,
         src.content_normalized,
         src.observed_at,
         src.quality_score,
         d.key::text AS domain,
         LEAST(1.0, GREATEST(0.0, COALESCE(NULLIF(d.value, '')::float8, 0.0))) AS domain_score
       FROM src
       CROSS JOIN LATERAL jsonb_each_text(COALESCE(src.metadata->'domain_scores', '{}'::jsonb)) d(key, value)
       WHERE LEAST(1.0, GREATEST(0.0, COALESCE(NULLIF(d.value, '')::float8, 0.0))) >= 0.22
       UNION
       SELECT
         src.id,
         src.chat_namespace,
         src.content_normalized,
         src.observed_at,
         src.quality_score,
         top.value::text AS domain,
         GREATEST(0.28, LEAST(1.0, src.quality_score * 0.35)) AS domain_score
       FROM src
       CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(src.metadata->'domain_top', '[]'::jsonb)) top(value)
       UNION
       SELECT
         src.id,
         src.chat_namespace,
         src.content_normalized,
         src.observed_at,
         src.quality_score,
         'personality_traits'::text AS domain,
         0.34::float8 AS domain_score
       FROM src
       WHERE src.content_normalized ~ '(introvert|extrovert|personality|organized|disciplin|impulsiv|calm|patient|conscient|neurotic)'
       UNION
       SELECT
         src.id,
         src.chat_namespace,
         src.content_normalized,
         src.observed_at,
         src.quality_score,
         'romantic_relationship'::text AS domain,
         0.45::float8 AS domain_score
       FROM src
       WHERE src.content_normalized ~ '(wife|husband|spouse|girlfriend|boyfriend|partner|esposa|marido|novia|novio|namorada|namorado|te amo|mi amor|amor)'
       UNION
       SELECT
         src.id,
         src.chat_namespace,
         src.content_normalized,
         src.observed_at,
         src.quality_score,
         'mental_health_signals'::text AS domain,
         0.42::float8 AS domain_score
       FROM src
       WHERE src.content_normalized ~ '(anxiety|anxious|depress|panic|burnout|therapy|terapia|ansiedad|ansioso|ansiosa|stress|estress)'
       UNION
       SELECT
         src.id,
         src.chat_namespace,
         src.content_normalized,
         src.observed_at,
         src.quality_score,
         'family_relationships'::text AS domain,
         0.4::float8 AS domain_score
       FROM src
       WHERE src.content_normalized ~ '(mother|father|mom|dad|brother|sister|family|mae|pai|irmao|irma|familia|tio|tia)'
       UNION
       SELECT
         src.id,
         src.chat_namespace,
         src.content_normalized,
         src.observed_at,
         src.quality_score,
         'friendships'::text AS domain,
         0.36::float8 AS domain_score
       FROM src
       WHERE src.content_normalized ~ '(friend|buddy|amigo|amiga|bro|bestie|colega)'
       UNION
       SELECT
         src.id,
         src.chat_namespace,
         src.content_normalized,
         src.observed_at,
         src.quality_score,
         'financial_behavior'::text AS domain,
         0.38::float8 AS domain_score
       FROM src
       WHERE src.content_normalized ~ '(money|budget|saving|invest|portfolio|bank|account|tax|salary|income|expense|dinheiro|dinero|conta|saldo|401k|roth|robinhood)'
     ),
     domain_dedup AS (
       SELECT
         dc.id,
         dc.chat_namespace,
         dc.content_normalized,
         dc.observed_at,
         dc.quality_score,
         dc.domain,
         MAX(dc.domain_score) AS domain_score
       FROM domain_candidates dc
       WHERE dc.domain = ANY($2::text[])
       GROUP BY
         dc.id,
         dc.chat_namespace,
         dc.content_normalized,
         dc.observed_at,
         dc.quality_score,
         dc.domain
     )
     ,
     candidate_rows AS (
       SELECT
         dc.chat_namespace,
         dc.domain,
         'message_claim'::text AS fact_type,
         left(dc.content_normalized, 450) AS value_text,
         jsonb_build_object('rawLength', length(dc.content_normalized), 'domainScore', dc.domain_score) AS value_json,
         LEAST(1.0, GREATEST(0.0, dc.quality_score * (0.55 + dc.domain_score * 0.45))) AS confidence,
         jsonb_build_object('canonicalMessageId', dc.id) AS evidence,
         'candidate'::text AS artifact_state,
         jsonb_build_object('source', 'canonical_messages') AS quality_signals,
         md5(dc.chat_namespace || '|' || dc.domain || '|' || dc.content_normalized || '|' || coalesce(dc.observed_at::text, '')) AS content_hash,
         dc.observed_at AS source_timestamp,
         dc.id AS canonical_message_id
       FROM domain_dedup dc
       WHERE length(dc.content_normalized) > 0
     ),
     chosen AS (
       SELECT *
       FROM (
         SELECT
           cr.*,
           ROW_NUMBER() OVER (
             PARTITION BY cr.chat_namespace, cr.content_hash
             ORDER BY cr.confidence DESC, cr.source_timestamp DESC NULLS LAST, cr.canonical_message_id
           ) AS rn
         FROM candidate_rows cr
       ) ranked
       WHERE rn = 1
     )
     INSERT INTO fact_candidates (
       chat_namespace,
       domain,
       fact_type,
       value_text,
       value_json,
       confidence,
       evidence,
       artifact_state,
       quality_signals,
       content_hash,
       source_timestamp,
       created_at,
       updated_at
     )
     SELECT
       c.chat_namespace,
       c.domain,
       c.fact_type,
       c.value_text,
       c.value_json,
       c.confidence,
       c.evidence,
       c.artifact_state,
       c.quality_signals,
       c.content_hash,
       c.source_timestamp,
       now(),
       now()
     FROM chosen c
     ON CONFLICT (chat_namespace, content_hash)
     DO UPDATE SET confidence = GREATEST(fact_candidates.confidence, EXCLUDED.confidence), updated_at = now()`,
    [safeLimit, TAXONOMY_DOMAINS]
  );

  const insertedTraitFacts = await pool.query(
    `WITH src AS (
       SELECT
         c.id,
         c.chat_namespace,
         c.content_normalized,
         c.observed_at,
         c.quality_score,
         c.metadata
       FROM canonical_messages c
       WHERE c.artifact_state = 'published'
       ORDER BY c.observed_at DESC
       LIMIT $1
     ),
     traits AS (
       SELECT
         src.id,
         src.chat_namespace,
         src.content_normalized,
         src.observed_at,
         src.quality_score,
         t.key::text AS trait_key,
         LEAST(1.0, GREATEST(0.0, COALESCE(NULLIF(t.value, '')::float8, 0.0))) AS trait_score
       FROM src
       CROSS JOIN LATERAL jsonb_each_text(COALESCE(src.metadata->'trait_scores', '{}'::jsonb)) t(key, value)
       WHERE LEAST(1.0, GREATEST(0.0, COALESCE(NULLIF(t.value, '')::float8, 0.0))) >= 0.30
     )
     ,
     candidate_rows AS (
       SELECT
         traits.chat_namespace,
         'personality_traits'::text AS domain,
         'trait_signal'::text AS fact_type,
         traits.trait_key AS value_text,
         jsonb_build_object('trait', traits.trait_key, 'score', traits.trait_score, 'textSample', left(traits.content_normalized, 180)) AS value_json,
         LEAST(1.0, GREATEST(0.0, traits.quality_score * (0.50 + traits.trait_score * 0.50))) AS confidence,
         jsonb_build_object('canonicalMessageId', traits.id) AS evidence,
         'candidate'::text AS artifact_state,
         jsonb_build_object('source', 'trait_scores') AS quality_signals,
         md5(traits.chat_namespace || '|trait|' || traits.trait_key || '|' || traits.content_normalized || '|' || coalesce(traits.observed_at::text, '')) AS content_hash,
         traits.observed_at AS source_timestamp,
         traits.id AS canonical_message_id
       FROM traits
     ),
     chosen AS (
       SELECT *
       FROM (
         SELECT
           cr.*,
           ROW_NUMBER() OVER (
             PARTITION BY cr.chat_namespace, cr.content_hash
             ORDER BY cr.confidence DESC, cr.source_timestamp DESC NULLS LAST, cr.canonical_message_id
           ) AS rn
         FROM candidate_rows cr
       ) ranked
       WHERE rn = 1
     )
     INSERT INTO fact_candidates (
       chat_namespace,
       domain,
       fact_type,
       value_text,
       value_json,
       confidence,
       evidence,
       artifact_state,
       quality_signals,
       content_hash,
       source_timestamp,
       created_at,
       updated_at
     )
     SELECT
       c.chat_namespace,
       c.domain,
       c.fact_type,
       c.value_text,
       c.value_json,
       c.confidence,
       c.evidence,
       c.artifact_state,
       c.quality_signals,
       c.content_hash,
       c.source_timestamp,
       now(),
       now()
     FROM chosen c
     ON CONFLICT (chat_namespace, content_hash)
     DO UPDATE SET confidence = GREATEST(fact_candidates.confidence, EXCLUDED.confidence), updated_at = now()`,
    [safeLimit]
  );

  const ownerNormalized = norm(config.ownerName);
  const insertedRelationships = await pool.query(
    `WITH src_msgs AS (
       SELECT
         c.id,
         c.chat_namespace,
         c.quality_score,
         c.metadata,
         c.observed_at
       FROM canonical_messages c
       WHERE c.artifact_state = 'published'
       ORDER BY c.observed_at DESC
       LIMIT $1
     ),
     ppl AS (
       SELECT chat_namespace, normalized_name, display_name, confidence
         FROM entity_candidates
        WHERE artifact_state IN ('candidate','validated','published')
          AND entity_type = 'person'
        ORDER BY updated_at DESC
        LIMIT $1
     ),
     hint_rel AS (
       SELECT
         src.chat_namespace,
         $2::text AS subject_name,
         trim(COALESCE(h.value->>'targetHint', '')) AS object_name,
         CASE lower(COALESCE(h.value->>'relationType', 'interaction'))
           WHEN 'spouse_partner' THEN 'spouse_partner'
           WHEN 'family' THEN 'family'
           WHEN 'friend' THEN 'friend'
           WHEN 'colleague' THEN 'colleague'
           ELSE 'community'
         END AS relation_type,
         GREATEST(0.3, LEAST(1.0, COALESCE((h.value->>'confidence')::float8, 0.45) * src.quality_score)) AS weight,
         LEAST(1.0, GREATEST(0.25, COALESCE((h.value->>'confidence')::float8, 0.45))) AS confidence,
         jsonb_build_object('canonicalMessageId', src.id, 'source', 'relationship_hint') AS evidence
       FROM src_msgs src
       CROSS JOIN LATERAL jsonb_array_elements(COALESCE(src.metadata->'relationship_hints', '[]'::jsonb)) h(value)
       WHERE trim(COALESCE(h.value->>'targetHint', '')) <> ''
     ),
     fallback_rel AS (
       SELECT
         p.chat_namespace,
         $2::text AS subject_name,
         p.display_name AS object_name,
         'interaction'::text AS relation_type,
         p.confidence AS weight,
         LEAST(1.0, p.confidence) AS confidence,
         jsonb_build_object('entityNormalized', p.normalized_name, 'source', 'entity_candidates') AS evidence
       FROM ppl p
       WHERE p.normalized_name <> $2
         AND p.confidence >= 0.86
     ),
     rel AS (
       SELECT * FROM hint_rel
       UNION ALL
       SELECT * FROM fallback_rel
     ),
     rel_ranked AS (
       SELECT
         rel.*,
         ROW_NUMBER() OVER (
           PARTITION BY rel.chat_namespace, rel.subject_name, rel.object_name, rel.relation_type
           ORDER BY rel.confidence DESC, rel.weight DESC
         ) AS rn
       FROM rel
     )
     INSERT INTO relationship_candidates (
       chat_namespace,
       subject_name,
       object_name,
       relation_type,
       weight,
       confidence,
       evidence,
       artifact_state,
       quality_signals,
       created_at,
       updated_at
     )
     SELECT
       rel.chat_namespace,
       rel.subject_name,
       rel.object_name,
       rel.relation_type,
       rel.weight,
       rel.confidence,
       rel.evidence,
       'candidate',
       jsonb_build_object('source', 'relationship_candidates'),
       now(),
       now()
     FROM rel_ranked rel
     WHERE trim(rel.object_name) <> ''
       AND trim(lower(rel.object_name)) <> $2
       AND rel.rn = 1
     ON CONFLICT (chat_namespace, subject_name, object_name, relation_type)
     DO UPDATE SET
       weight = GREATEST(relationship_candidates.weight, EXCLUDED.weight),
       confidence = GREATEST(relationship_candidates.confidence, EXCLUDED.confidence),
       evidence = EXCLUDED.evidence,
        updated_at = now()`,
    [safeLimit, ownerNormalized || "owner"]
  );

  const insertedInsights = await pool.query(
    `INSERT INTO insight_candidates (
       chat_namespace,
       insight_pack,
       insight_type,
       title,
       summary,
       confidence,
       evidence,
       artifact_state,
       quality_signals,
       created_at,
       updated_at
     )
     SELECT
       f.chat_namespace,
       'social_behavior',
       'candidate_summary',
       'Candidate Insight Snapshot',
       'Auto-generated insight candidate from published canonical messages.',
       0.6,
       jsonb_build_object('factCount', COUNT(*)),
       'candidate',
       jsonb_build_object('source', 'fact_candidates'),
       now(),
       now()
     FROM fact_candidates f
     WHERE f.artifact_state IN ('candidate','validated','published')
     GROUP BY f.chat_namespace
     ON CONFLICT (chat_namespace, insight_pack, insight_type)
     DO UPDATE SET
       confidence = EXCLUDED.confidence,
       evidence = EXCLUDED.evidence,
       updated_at = now()`
  );

  return {
    entities: insertedEntities.rowCount ?? 0,
    facts: insertedFacts.rowCount ?? 0,
    traitFacts: insertedTraitFacts.rowCount ?? 0,
    relationships: insertedRelationships.rowCount ?? 0,
    insights: insertedInsights.rowCount ?? 0
  };
}

async function applyGateForTable(table: "entity_candidates" | "fact_candidates" | "relationship_candidates" | "insight_candidates"): Promise<{ published: number; validated: number; deprecated: number }> {
  const rows = await pool.query<{ id: string; confidence: number; artifact_state: string; row_json: Record<string, unknown> }>(
    `SELECT id, confidence, artifact_state, to_jsonb(t) AS row_json FROM ${table} t`
  );

  let published = 0;
  let validated = 0;
  let deprecated = 0;
  const artifactType = table.replace("_candidates", "");
  const classified: Array<{
    id: string;
    currentState: string;
    nextState: string;
    decision: "promote" | "hold" | "retry" | "deprecate";
    confidence: number;
    name: string;
    traceId: string;
  }> = [];

  for (const row of rows.rows) {
    const confidence = Number(row.confidence ?? 0);
    const payload = row.row_json ?? {};
    const name = String(
      payload.normalized_name ??
      payload.display_name ??
      payload.value_text ??
      payload.subject_name ??
      payload.title ??
      ""
    );
    let next = "candidate";

    if (isLikelyNoiseEntity(name)) {
      next = "deprecated";
      deprecated += 1;
    } else if (confidence >= 0.82) {
      next = "published";
      published += 1;
    } else if (confidence >= 0.55) {
      next = "validated";
      validated += 1;
    } else {
      next = "candidate";
    }

    classified.push({
      id: row.id,
      currentState: String(row.artifact_state ?? ""),
      nextState: next,
      decision:
        next === "published" ? "promote" :
        next === "validated" ? "hold" :
        next === "deprecated" ? "deprecate" :
        "retry",
      confidence,
      name,
      traceId: hashKey(`${table}:${row.id}:${next}`)
    });
  }

  const changed = classified.filter((row) => row.currentState !== row.nextState);
  const batchSize = 5000;
  for (let offset = 0; offset < changed.length; offset += batchSize) {
    const chunk = changed.slice(offset, offset + batchSize);
    const chunkJson = JSON.stringify(chunk);

    await pool.query(
      `WITH payload AS (
         SELECT *
           FROM json_to_recordset($1::json) AS x(
             id uuid,
             "currentState" text,
             "nextState" text,
             decision text,
             confidence double precision,
             name text,
             "traceId" text
           )
       )
       UPDATE ${table} t
          SET artifact_state = p."nextState",
              updated_at = now()
         FROM payload p
        WHERE t.id = p.id`,
      [chunkJson]
    );

    await pool.query(
      `WITH payload AS (
         SELECT *
           FROM json_to_recordset($1::json) AS x(
             id uuid,
             "currentState" text,
             "nextState" text,
             decision text,
             confidence double precision,
             name text,
             "traceId" text
           )
       )
       INSERT INTO quarantine_artifacts (artifact_type, artifact_id, reason, payload)
       SELECT $2, p.id, 'noise_or_low_semantic_value', jsonb_build_object('name', p.name)
         FROM payload p
        WHERE p."nextState" = 'deprecated'
        ON CONFLICT DO NOTHING`,
      [chunkJson, artifactType]
    );

    await pool.query(
      `WITH payload AS (
         SELECT *
           FROM json_to_recordset($1::json) AS x(
             id uuid,
             "currentState" text,
             "nextState" text,
             decision text,
             confidence double precision,
             name text,
             "traceId" text
           )
       )
       INSERT INTO quality_decisions (
         artifact_type,
         artifact_id,
         decision,
         confidence,
         reason_codes,
         reasoning,
         decided_by,
         trace_id
       )
       SELECT
         $2,
         p.id,
         p.decision,
         p.confidence,
         ARRAY[p."nextState"]::text[],
         jsonb_build_object('table', $3::text, 'name', p.name),
         'quality_adjudicator_agent',
         p."traceId"
       FROM payload p
       ON CONFLICT DO NOTHING`,
      [chunkJson, artifactType, table]
    );
  }

  return { published, validated, deprecated };
}

export async function applyUniversalQualityGate(): Promise<Record<string, unknown>> {
  const entity = await applyGateForTable("entity_candidates");
  const fact = await applyGateForTable("fact_candidates");
  const relationship = await applyGateForTable("relationship_candidates");
  const insight = await applyGateForTable("insight_candidates");

  return { ok: true, entity, fact, relationship, insight };
}

export async function remediateLegacyArtifacts(): Promise<Record<string, unknown>> {
  await pool.query(
    `UPDATE brain_entities
        SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{deprecated}', 'true'::jsonb, true),
            updated_at = now()
      WHERE length(COALESCE(normalized_name, '')) < 2
         OR normalized_name IN ('yes','no','ok','haha','hahaha','this','that','you','me','i')`
  );

  await pool.query(
    `INSERT INTO brain_entities (chat_namespace, entity_type, normalized_name, display_name, weight, metadata)
     SELECT
       c.chat_namespace,
       c.entity_type,
       c.normalized_name,
       c.display_name,
       GREATEST(1, c.confidence * 10),
       jsonb_build_object('source', 'entity_candidates', 'artifactState', c.artifact_state)
     FROM entity_candidates c
     WHERE c.artifact_state = 'published'
     ON CONFLICT (chat_namespace, entity_type, normalized_name)
     DO UPDATE SET
       display_name = EXCLUDED.display_name,
       weight = GREATEST(brain_entities.weight, EXCLUDED.weight),
       metadata = EXCLUDED.metadata,
       updated_at = now()`
  );

  await pool.query(
    `INSERT INTO brain_facts (chat_namespace, domain, fact_type, value_text, confidence, source_timestamp, content_hash, metadata)
     SELECT
       c.chat_namespace,
       c.domain,
       c.fact_type,
       c.value_text,
       c.confidence,
       c.source_timestamp,
       c.content_hash,
       jsonb_build_object('source', 'fact_candidates', 'artifactState', c.artifact_state)
     FROM fact_candidates c
     WHERE c.artifact_state = 'published'
     ON CONFLICT DO NOTHING`
  );

  await pool.query(
    `INSERT INTO brain_insight_snapshots (chat_namespace, insight_pack, insight_type, title, summary, confidence, action_text, payload)
     SELECT
       c.chat_namespace,
       c.insight_pack,
       c.insight_type,
       c.title,
       c.summary,
       c.confidence,
       NULL,
       jsonb_build_object('source', 'insight_candidates')
     FROM insight_candidates c
     WHERE c.artifact_state = 'published'
     ON CONFLICT (chat_namespace, insight_pack, insight_type)
     DO UPDATE SET
       title = EXCLUDED.title,
       summary = EXCLUDED.summary,
       confidence = EXCLUDED.confidence,
       payload = EXCLUDED.payload,
       updated_at = now()`
  );

  return { ok: true };
}
