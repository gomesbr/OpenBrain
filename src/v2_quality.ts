import { randomUUID } from "node:crypto";
import { pool } from "./db.js";
import { config } from "./config.js";
import type {
  V2Decision,
  V2QualityAdjudicateRequest,
  V2QualityEvaluateRequest,
  V2QualityEvaluateResponse
} from "./v2_types.js";

const ARTIFACT_TABLE: Record<string, string> = {
  canonical_message: "canonical_messages",
  entity: "entity_candidates",
  fact: "fact_candidates",
  relationship: "relationship_candidates",
  insight: "insight_candidates"
};

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function evaluatePayloadQuality(payload: Record<string, unknown>): number {
  const keys = Object.keys(payload ?? {});
  if (keys.length === 0) return 0;
  const nonEmpty = keys.filter((key) => {
    const v = (payload as Record<string, unknown>)[key];
    if (v == null) return false;
    if (typeof v === "string") return v.trim().length > 0;
    if (Array.isArray(v)) return v.length > 0;
    if (typeof v === "object") return Object.keys(v as Record<string, unknown>).length > 0;
    return true;
  }).length;
  return clamp01(nonEmpty / Math.max(1, keys.length));
}

function decide(confidence: number, payloadQuality: number): { decision: V2Decision; reasons: string[] } {
  const reasons: string[] = [];
  if (confidence >= 0.82 && payloadQuality >= 0.7) {
    reasons.push("high_confidence", "payload_complete");
    return { decision: "promote", reasons };
  }
  if (confidence >= 0.55 && payloadQuality >= 0.45) {
    reasons.push("needs_review", "intermediate_confidence");
    return { decision: "hold", reasons };
  }
  if (confidence >= 0.35) {
    reasons.push("low_signal", "retry_recommended");
    return { decision: "retry", reasons };
  }
  reasons.push("insufficient_confidence", "reject");
  return { decision: "reject", reasons };
}

async function updateArtifactState(artifactType: string, artifactId: string, decision: V2Decision): Promise<void> {
  const table = ARTIFACT_TABLE[artifactType];
  if (!table) return;

  const nextState =
    decision === "promote"
      ? "published"
      : decision === "deprecate"
        ? "deprecated"
        : decision === "hold"
          ? "validated"
          : "candidate";

  await pool.query(`UPDATE ${table} SET artifact_state = $2, updated_at = now() WHERE id = $1`, [artifactId, nextState]);

  if (decision === "reject") {
    await pool.query(
      `INSERT INTO quarantine_artifacts (artifact_type, artifact_id, reason, payload)
       VALUES ($1, $2::uuid, $3, $4::jsonb)
       ON CONFLICT DO NOTHING`,
      [artifactType, artifactId, "rejected_by_quality_gate", JSON.stringify({})]
    );
  }
}

export async function evaluateQuality(input: V2QualityEvaluateRequest): Promise<V2QualityEvaluateResponse> {
  const artifactType = String(input.artifactType ?? "");
  if (!ARTIFACT_TABLE[artifactType]) {
    throw new Error("Unsupported artifactType");
  }

  const confidence = clamp01(Number(input.confidence ?? 0.5));
  const payloadQuality = evaluatePayloadQuality(input.payload ?? {});
  const combined = clamp01(confidence * 0.7 + payloadQuality * 0.3);
  const result = decide(combined, payloadQuality);
  const reasons = [...(input.reasons ?? []), ...result.reasons];

  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO quality_decisions (
       artifact_type,
       artifact_id,
       decision,
       confidence,
       reason_codes,
       reasoning,
       decided_by,
       trace_id
     ) VALUES ($1, $2::uuid, $3, $4, $5::text[], $6::jsonb, $7, $8)
     RETURNING id`,
    [
      artifactType,
      input.artifactId ?? randomUUID(),
      result.decision,
      combined,
      reasons,
      JSON.stringify({ payloadQuality, inputConfidence: confidence }),
      "quality_adjudicator_agent",
      input.traceId ?? null
    ]
  );

  const qualityDecisionId = inserted.rows[0]?.id;
  if (!qualityDecisionId) {
    throw new Error("Failed to persist quality decision");
  }

  return {
    ok: true,
    decision: result.decision,
    confidence: combined,
    reasons,
    qualityDecisionId
  };
}

export async function adjudicateQuality(input: V2QualityAdjudicateRequest): Promise<{ ok: true; decision: V2Decision }> {
  const artifactType = String(input.artifactType ?? "");
  if (!ARTIFACT_TABLE[artifactType]) {
    throw new Error("Unsupported artifactType");
  }
  const decision = input.decision;
  const confidence = clamp01(Number(input.confidence ?? 0.5));

  await pool.query(
    `INSERT INTO quality_decisions (
       artifact_type,
       artifact_id,
       decision,
       confidence,
       reason_codes,
       reasoning,
       decided_by,
       trace_id
     ) VALUES ($1, $2::uuid, $3, $4, $5::text[], $6::jsonb, $7, $8)`,
    [
      artifactType,
      input.artifactId,
      decision,
      confidence,
      input.reasons ?? [],
      JSON.stringify({ manualAdjudication: true }),
      "quality_adjudicator_agent",
      input.traceId ?? null
    ]
  );

  await updateArtifactState(artifactType, input.artifactId, decision);

  return { ok: true, decision };
}

export async function getQualityMetrics(days = 30): Promise<Record<string, unknown>> {
  const safeDays = Number.isFinite(Number(days)) ? Math.max(1, Math.min(3650, Number(days))) : 30;

  const decisionRows = await pool.query<{ decision: string; count: string }>(
    `SELECT decision, COUNT(*)::text AS count
       FROM quality_decisions
      WHERE created_at >= now() - make_interval(days => $1)
      GROUP BY decision
      ORDER BY count DESC`,
    [safeDays]
  );

  const stateRows = await pool.query<{ artifact_type: string; artifact_state: string; count: string }>(
    `SELECT artifact_type, artifact_state, COUNT(*)::text AS count
       FROM (
         SELECT 'canonical_message'::text AS artifact_type, artifact_state FROM canonical_messages
         UNION ALL
         SELECT 'entity'::text AS artifact_type, artifact_state FROM entity_candidates
         UNION ALL
         SELECT 'fact'::text AS artifact_type, artifact_state FROM fact_candidates
         UNION ALL
         SELECT 'relationship'::text AS artifact_type, artifact_state FROM relationship_candidates
         UNION ALL
         SELECT 'insight'::text AS artifact_type, artifact_state FROM insight_candidates
       ) t
      GROUP BY artifact_type, artifact_state
      ORDER BY artifact_type, artifact_state`
  );

  return {
    ok: true,
    days: safeDays,
    decisions: decisionRows.rows.map((row) => ({ decision: row.decision, count: Number(row.count) })),
    artifactStates: stateRows.rows.map((row) => ({
      artifactType: row.artifact_type,
      artifactState: row.artifact_state,
      count: Number(row.count)
    }))
  };
}

async function ensureWhatsAppSystemActor(chatNamespace: string): Promise<string> {
  const existing = await pool.query<{ actor_id: string }>(
    `SELECT a.actor_id::text
       FROM actors a
       JOIN actor_context ac
         ON ac.actor_id = a.actor_id
      WHERE ac.chat_namespace = $1
        AND ac.actor_type = 'system'
        AND a.normalized_name = 'whatsapp system'
      LIMIT 1`,
    [chatNamespace]
  );
  if (existing.rows[0]?.actor_id) return existing.rows[0].actor_id;

  const inserted = await pool.query<{ actor_id: string }>(
    `INSERT INTO actors (canonical_name, normalized_name, metadata)
     VALUES ('WhatsApp system', 'whatsapp system', jsonb_build_object('seededBy', 'v2_quality_bootstrap'))
     ON CONFLICT (normalized_name)
     DO UPDATE SET canonical_name = EXCLUDED.canonical_name, updated_at = now()
     RETURNING actor_id::text`,
    []
  );
  const actorId = inserted.rows[0]?.actor_id;
  if (!actorId) {
    throw new Error("Failed to ensure WhatsApp system actor");
  }
  await pool.query(
    `INSERT INTO actor_context (
       actor_id,
       chat_namespace,
       actor_type,
       canonical_name,
       source,
       confidence,
       metadata
     ) VALUES ($1::uuid, $2, 'system', 'WhatsApp system', 'whatsapp', 1, jsonb_build_object('seededBy', 'v2_quality_bootstrap'))
     ON CONFLICT (chat_namespace, actor_type, canonical_name)
     DO UPDATE SET actor_id = EXCLUDED.actor_id, confidence = GREATEST(actor_context.confidence, EXCLUDED.confidence), updated_at = now()`,
    [actorId, chatNamespace]
  );
  return actorId;
}

export async function repairActorAbstractions(chatNamespace = "personal.main"): Promise<{
  groupPlaceholderRowsNullified: number;
  systemRowsRemapped: number;
  actorContextsRebuilt: number;
  actorIdentitiesRebuilt: number;
  actorAliasesRebuilt: number;
  actorSourceProfilesRebuilt: number;
  orphanActorsDeleted: number;
  evidenceLinksSynced: number;
}> {
  const whatsappSystemActorId = await ensureWhatsAppSystemActor(chatNamespace);

  const groupPlaceholderRows = await pool.query(
    `WITH normalized_rows AS (
       SELECT
         c.id,
         lower(
           regexp_replace(
             regexp_replace(
               unaccent(replace(replace(COALESCE(c.metadata->>'speaker', c.metadata->>'sender', c.metadata->>'author', ''), chr(160), ' '), chr(8239), ' ')),
               '^[~\\s]+',
               ''
             ),
             '[^a-z0-9\\s_-]+',
             '',
             'g'
           )
         ) AS speaker_norm,
         lower(
           regexp_replace(
             regexp_replace(
               unaccent(replace(replace(COALESCE(c.metadata->>'conversationLabel', c.source_conversation_id, c.conversation_id, ''), chr(160), ' '), chr(8239), ' ')),
               '^[~\\s]+',
               ''
             ),
             '[^a-z0-9\\s_-]+',
             '',
             'g'
           )
         ) AS conversation_norm,
         c.role,
         COALESCE(c.metadata->>'system_event', 'false') AS system_event
       FROM canonical_messages c
       WHERE c.chat_namespace = $1
         AND c.source_system = 'whatsapp'
     ),
     targets AS (
       SELECT DISTINCT nr.id
       FROM normalized_rows nr
       LEFT JOIN actor_label_overrides alo
         ON alo.chat_namespace = $1
        AND alo.normalized_label = nr.speaker_norm
        AND alo.source_system IN ('', 'whatsapp')
       WHERE nr.speaker_norm <> ''
         AND nr.role <> 'system'
         AND nr.system_event <> 'true'
         AND (
           (nr.speaker_norm = nr.conversation_norm AND nr.conversation_norm <> '')
           OR alo.classification IN ('group_chat', 'ignore')
         )
     )
     UPDATE canonical_messages c
        SET actor_id = NULL,
            actor_type = 'unknown',
            updated_at = now()
       FROM targets t
      WHERE c.id = t.id
        AND (c.actor_id IS NOT NULL OR c.actor_type IS DISTINCT FROM 'unknown')`,
    [chatNamespace]
  );

  const systemRows = await pool.query(
    `WITH system_targets AS (
       SELECT c.id
         FROM canonical_messages c
        WHERE c.chat_namespace = $1
          AND (
            c.role = 'system'
            OR COALESCE(c.metadata->>'system_event', 'false') = 'true'
            OR EXISTS (
              SELECT 1
                FROM actor_label_overrides alo
               WHERE alo.chat_namespace = $1
                 AND alo.classification = 'system'
                 AND alo.source_system IN ('', c.source_system)
                 AND alo.normalized_label = lower(
                   regexp_replace(
                     regexp_replace(
                       unaccent(replace(replace(COALESCE(c.metadata->>'speaker', c.metadata->>'sender', c.metadata->>'author', ''), chr(160), ' '), chr(8239), ' ')),
                       '^[~\\s]+',
                       ''
                     ),
                     '[^a-z0-9\\s_-]+',
                     '',
                     'g'
                   )
                 )
            )
          )
     )
     UPDATE canonical_messages c
        SET actor_id = $2::uuid,
            actor_type = 'system',
            updated_at = now()
       FROM system_targets t
      WHERE c.id = t.id
        AND (c.actor_id IS DISTINCT FROM $2::uuid OR c.actor_type IS DISTINCT FROM 'system')`,
    [chatNamespace, whatsappSystemActorId]
  );

  await pool.query(`DELETE FROM actor_aliases WHERE chat_namespace = $1`, [chatNamespace]);
  await pool.query(`DELETE FROM actor_source_profile WHERE chat_namespace = $1`, [chatNamespace]);
  await pool.query(`DELETE FROM actor_context WHERE chat_namespace = $1`, [chatNamespace]);
  await pool.query(`DELETE FROM actor_identities WHERE chat_namespace = $1`, [chatNamespace]);

  const actorContexts = await pool.query(
    `WITH actor_rows AS (
       SELECT
         c.actor_id,
         c.chat_namespace,
         COALESCE(NULLIF(c.actor_type, ''), 'unknown') AS actor_type,
         c.source_system,
         c.observed_at,
         c.quality_score
       FROM canonical_messages c
       WHERE c.chat_namespace = $1
         AND c.actor_id IS NOT NULL
     ),
     actor_type_rollup AS (
       SELECT
         actor_id,
         chat_namespace,
         actor_type,
         COUNT(*)::int AS message_count,
         MIN(observed_at) AS first_seen_at,
         MAX(observed_at) AS last_seen_at,
         MAX(quality_score) AS max_quality_score,
         (ARRAY_AGG(source_system ORDER BY source_system))[1] AS source_system
       FROM actor_rows
       GROUP BY actor_id, chat_namespace, actor_type
     ),
     chosen AS (
       SELECT DISTINCT ON (actor_id, chat_namespace)
         actor_id,
         chat_namespace,
         actor_type,
         source_system,
         message_count,
         first_seen_at,
         last_seen_at,
         max_quality_score
       FROM actor_type_rollup
       ORDER BY actor_id, chat_namespace, message_count DESC, max_quality_score DESC, actor_type
     )
     INSERT INTO actor_context (
       actor_id,
       chat_namespace,
       actor_type,
       canonical_name,
       source,
       confidence,
       metadata
     )
     SELECT
       c.actor_id,
       c.chat_namespace,
       c.actor_type,
       a.canonical_name,
       c.source_system,
       LEAST(1.0, GREATEST(COALESCE(c.max_quality_score, 0.5), 0.25)),
       jsonb_build_object(
         'firstSeenAt', c.first_seen_at,
         'lastSeenAt', c.last_seen_at,
         'messageCount', c.message_count
       )
     FROM chosen c
     JOIN actors a
       ON a.actor_id = c.actor_id`,
    [chatNamespace]
  );

  await pool.query(
    `UPDATE canonical_messages c
        SET actor_type = ac.actor_type,
            updated_at = now()
       FROM actor_context ac
      WHERE c.chat_namespace = $1
        AND c.actor_id IS NOT NULL
        AND ac.chat_namespace = c.chat_namespace
        AND ac.actor_id = c.actor_id
        AND c.actor_type IS DISTINCT FROM ac.actor_type`,
    [chatNamespace]
  );

  const actorIdentities = await pool.query(
    `INSERT INTO actor_identities (
       actor_id,
       chat_namespace,
       actor_type,
       canonical_name,
       source,
       confidence,
       metadata
     )
     SELECT
       ac.actor_id,
       ac.chat_namespace,
       ac.actor_type,
       ac.canonical_name,
       ac.source,
       ac.confidence,
       ac.metadata
     FROM actor_context ac
     WHERE ac.chat_namespace = $1`,
    [chatNamespace]
  );

  const actorAliases = await pool.query(
    `WITH raw_aliases AS (
       SELECT
         c.actor_id,
         c.chat_namespace,
         c.source_system,
         trim(v.alias) AS alias,
         COUNT(*)::int AS evidence_count,
         MIN(c.observed_at) AS first_seen_at,
         MAX(c.observed_at) AS last_seen_at
       FROM canonical_messages c
       CROSS JOIN LATERAL (
         VALUES
           (c.metadata->>'speaker'),
           (c.metadata->>'sender'),
           (c.metadata->>'author'),
           (c.metadata->>'actor'),
           (c.metadata->>'agent'),
           (c.metadata->>'name')
       ) v(alias)
       WHERE c.chat_namespace = $1
         AND c.actor_id IS NOT NULL
         AND v.alias IS NOT NULL
         AND trim(v.alias) <> ''
       GROUP BY c.actor_id, c.chat_namespace, c.source_system, trim(v.alias)
     ),
     filtered AS (
       SELECT ra.*
       FROM raw_aliases ra
       JOIN actors a
         ON a.actor_id = ra.actor_id
       LEFT JOIN actor_label_overrides alo
         ON alo.chat_namespace = ra.chat_namespace
        AND alo.source_system IN ('', ra.source_system)
        AND alo.normalized_label = lower(
          regexp_replace(
            regexp_replace(
              unaccent(replace(replace(ra.alias, chr(160), ' '), chr(8239), ' ')),
              '^[~\\s]+',
              ''
            ),
            '[^a-z0-9\\s_-]+',
            '',
            'g'
          )
        )
       WHERE lower(trim(ra.alias)) <> lower(a.canonical_name)
         AND COALESCE(alo.classification, '') NOT IN ('group_chat', 'ignore')
         AND NOT (
           ra.source_system = 'whatsapp'
           AND lower(
             regexp_replace(
               regexp_replace(
                 unaccent(replace(replace(ra.alias, chr(160), ' '), chr(8239), ' ')),
                 '^[~\\s]+',
                 ''
               ),
               '[^a-z0-9\\s_-]+',
               '',
               'g'
             )
           ) = lower(
             regexp_replace(
               regexp_replace(
                 unaccent(replace(replace(COALESCE(
                   (
                     SELECT max(cm.metadata->>'conversationLabel')
                     FROM canonical_messages cm
                     WHERE cm.chat_namespace = ra.chat_namespace
                       AND cm.actor_id = ra.actor_id
                       AND cm.source_system = ra.source_system
                   ),
                   ''
                 ), chr(160), ' '), chr(8239), ' ')),
                 '^[~\\s]+',
                 ''
               ),
               '[^a-z0-9\\s_-]+',
               '',
               'g'
             )
           )
         )
     )
     ,
     chosen AS (
       SELECT
         f.*,
         ROW_NUMBER() OVER (
           PARTITION BY f.chat_namespace, f.alias
           ORDER BY f.evidence_count DESC, f.last_seen_at DESC NULLS LAST, f.actor_id
         ) AS rn
       FROM filtered f
     )
     INSERT INTO actor_aliases (
       actor_id,
       chat_namespace,
       alias,
       source_system,
       confidence,
       first_seen_at,
       last_seen_at
     )
     SELECT
       actor_id,
       chat_namespace,
       alias,
       source_system,
       0.8,
       first_seen_at,
       last_seen_at
     FROM chosen
     WHERE rn = 1
     ON CONFLICT (chat_namespace, alias)
     DO UPDATE SET
       actor_id = EXCLUDED.actor_id,
       source_system = EXCLUDED.source_system,
       confidence = GREATEST(actor_aliases.confidence, EXCLUDED.confidence),
       first_seen_at = COALESCE(LEAST(actor_aliases.first_seen_at, EXCLUDED.first_seen_at), actor_aliases.first_seen_at, EXCLUDED.first_seen_at),
       last_seen_at = COALESCE(GREATEST(actor_aliases.last_seen_at, EXCLUDED.last_seen_at), actor_aliases.last_seen_at, EXCLUDED.last_seen_at)`,
    [chatNamespace]
  );

  const actorSourceProfiles = await pool.query(
    `INSERT INTO actor_source_profile (
       actor_id,
       chat_namespace,
       source_system,
       message_count,
       first_seen_at,
       last_seen_at,
       max_quality_score,
       metadata
     )
     SELECT
       c.actor_id,
       c.chat_namespace,
       c.source_system,
       COUNT(*)::int,
       MIN(c.observed_at),
       MAX(c.observed_at),
       COALESCE(MAX(c.quality_score), 0),
       jsonb_build_object(
         'publishedCount', COUNT(*) FILTER (WHERE c.artifact_state = 'published'),
         'candidateCount', COUNT(*) FILTER (WHERE c.artifact_state = 'candidate')
       )
     FROM canonical_messages c
     WHERE c.chat_namespace = $1
       AND c.actor_id IS NOT NULL
     GROUP BY c.actor_id, c.chat_namespace, c.source_system`,
    [chatNamespace]
  );

  const orphanActors = await pool.query(
    `DELETE FROM actors a
      WHERE NOT EXISTS (
              SELECT 1
                FROM canonical_messages c
               WHERE c.actor_id = a.actor_id
            )
        AND NOT EXISTS (
              SELECT 1
                FROM actor_context ac
               WHERE ac.actor_id = a.actor_id
            )
        AND NOT EXISTS (
              SELECT 1
                FROM answer_evidence_links ael
               WHERE ael.actor_id = a.actor_id
            )
        AND NOT EXISTS (
              SELECT 1
                FROM network_saved_views nsv
               WHERE nsv.owner_actor_id = a.actor_id
            )
        AND NOT EXISTS (
              SELECT 1
                FROM network_snapshots ns
               WHERE ns.owner_actor_id = a.actor_id
            )`
  );

  const evidenceLinks = await pool.query(
    `UPDATE answer_evidence_links ael
        SET actor_id = c.actor_id,
            source_timestamp = COALESCE(ael.source_timestamp, c.observed_at)
       FROM canonical_messages c
      WHERE ael.canonical_message_id = c.id
        AND c.chat_namespace = $1
        AND ael.actor_id IS DISTINCT FROM c.actor_id`,
    [chatNamespace]
  );

  return {
    groupPlaceholderRowsNullified: groupPlaceholderRows.rowCount ?? 0,
    systemRowsRemapped: systemRows.rowCount ?? 0,
    actorContextsRebuilt: actorContexts.rowCount ?? 0,
    actorIdentitiesRebuilt: actorIdentities.rowCount ?? 0,
    actorAliasesRebuilt: actorAliases.rowCount ?? 0,
    actorSourceProfilesRebuilt: actorSourceProfiles.rowCount ?? 0,
    orphanActorsDeleted: orphanActors.rowCount ?? 0,
    evidenceLinksSynced: evidenceLinks.rowCount ?? 0
  };
}

export async function runCanonicalBootstrap(limit = 2000): Promise<{ canonicalized: number; published: number; quarantined: number }> {
  const safeLimit = Number.isFinite(Number(limit)) ? Math.max(100, Math.min(10000, Number(limit))) : 2000;
  const ownerName = String(config.ownerName ?? "Owner").trim() || "Owner";

  await pool.query(
    `UPDATE canonical_messages c
        SET metadata = COALESCE(m.metadata, '{}'::jsonb),
            conversation_id = COALESCE(NULLIF(m.source_conversation_id, ''), NULLIF(c.conversation_id, ''), COALESCE(m.chat_namespace, 'personal.main'), m.id::text),
            source_conversation_id = COALESCE(NULLIF(m.source_conversation_id, ''), c.source_conversation_id),
            source_message_id = COALESCE(NULLIF(m.source_message_id, ''), c.source_message_id, m.id::text),
            reply_to_message_id = COALESCE(
              NULLIF(COALESCE(m.metadata->>'reply_to_message_id', ''), ''),
              NULLIF(COALESCE(m.metadata->>'replyToMessageId', ''), ''),
              NULLIF(COALESCE(m.metadata->>'response_parent_id', ''), ''),
              c.reply_to_message_id
            ),
            language = COALESCE(NULLIF(m.metadata->>'language', ''), c.language, 'unknown'),
            observed_at = COALESCE(m.source_timestamp, c.observed_at),
            quality_score = CASE
              WHEN COALESCE(m.metadata->>'system_event', 'false') = 'true' THEN 0.05
              WHEN COALESCE(m.source_timestamp, c.observed_at) < '1983-01-01'::timestamptz THEN 0.1
              WHEN COALESCE(m.source_timestamp, c.observed_at) > now() + interval '1 day' THEN 0.2
              WHEN length(trim(COALESCE(m.content, ''))) = 0 THEN 0.2
              WHEN length(trim(COALESCE(m.content, ''))) <= 2
                AND (
                  COALESCE(
                    NULLIF(COALESCE(m.metadata->>'reply_to_message_id', ''), ''),
                    NULLIF(COALESCE(m.metadata->>'replyToMessageId', ''), ''),
                    NULLIF(COALESCE(m.metadata->>'response_parent_id', ''), ''),
                    c.reply_to_message_id
                  ) IS NOT NULL
                  OR EXISTS (
                    SELECT 1
                      FROM memory_items mx
                     WHERE COALESCE(NULLIF(mx.source_conversation_id, ''), NULLIF(mx.metadata->>'conversation_id', ''), NULLIF(mx.metadata->>'conversationId', ''), NULLIF(mx.metadata->>'conversationLabel', ''), COALESCE(mx.chat_namespace, 'personal.main'), mx.id::text)
                           = COALESCE(NULLIF(m.source_conversation_id, ''), NULLIF(m.metadata->>'conversation_id', ''), NULLIF(m.metadata->>'conversationId', ''), NULLIF(m.metadata->>'conversationLabel', ''), COALESCE(m.chat_namespace, 'personal.main'), m.id::text)
                       AND ABS(EXTRACT(EPOCH FROM (COALESCE(mx.source_timestamp, mx.created_at) - COALESCE(m.source_timestamp, c.observed_at)))) <= 900
                       AND length(trim(COALESCE(mx.content, ''))) >= 3
                       AND COALESCE(mx.metadata->>'system_event', 'false') <> 'true'
                  )
                ) THEN 0.75
              WHEN length(trim(COALESCE(m.content, ''))) <= 2 THEN 0.2
              ELSE 0.9
            END,
            quality_signals = COALESCE(c.quality_signals, '{}'::jsonb)
              || jsonb_build_object(
                'metadataRefreshedAt', now()::text,
                'contextualShort', (
                  COALESCE(m.metadata->>'system_event', 'false') <> 'true'
                  AND length(trim(COALESCE(m.content, ''))) <= 2
                  AND (
                    COALESCE(
                      NULLIF(COALESCE(m.metadata->>'reply_to_message_id', ''), ''),
                      NULLIF(COALESCE(m.metadata->>'replyToMessageId', ''), ''),
                      NULLIF(COALESCE(m.metadata->>'response_parent_id', ''), ''),
                      c.reply_to_message_id
                    ) IS NOT NULL
                    OR EXISTS (
                      SELECT 1
                        FROM memory_items mx
                       WHERE COALESCE(NULLIF(mx.source_conversation_id, ''), NULLIF(mx.metadata->>'conversation_id', ''), NULLIF(mx.metadata->>'conversationId', ''), NULLIF(mx.metadata->>'conversationLabel', ''), COALESCE(mx.chat_namespace, 'personal.main'), mx.id::text)
                             = COALESCE(NULLIF(m.source_conversation_id, ''), NULLIF(m.metadata->>'conversation_id', ''), NULLIF(m.metadata->>'conversationId', ''), NULLIF(m.metadata->>'conversationLabel', ''), COALESCE(m.chat_namespace, 'personal.main'), m.id::text)
                         AND ABS(EXTRACT(EPOCH FROM (COALESCE(mx.source_timestamp, mx.created_at) - COALESCE(m.source_timestamp, c.observed_at)))) <= 900
                         AND length(trim(COALESCE(mx.content, ''))) >= 3
                         AND COALESCE(mx.metadata->>'system_event', 'false') <> 'true'
                    )
                  )
                )
              ),
            updated_at = now()
        FROM memory_items m
      WHERE m.id = c.memory_item_id
        AND (
          c.metadata IS DISTINCT FROM COALESCE(m.metadata, '{}'::jsonb)
          OR c.conversation_id = ''
          OR c.source_message_id IS NULL
          OR c.language = 'unknown'
          OR c.quality_score <> CASE
            WHEN COALESCE(m.metadata->>'system_event', 'false') = 'true' THEN 0.05
            WHEN COALESCE(m.source_timestamp, c.observed_at) < '1983-01-01'::timestamptz THEN 0.1
            WHEN COALESCE(m.source_timestamp, c.observed_at) > now() + interval '1 day' THEN 0.2
            WHEN length(trim(COALESCE(m.content, ''))) = 0 THEN 0.2
            WHEN length(trim(COALESCE(m.content, ''))) <= 2
              AND (
                COALESCE(
                  NULLIF(COALESCE(m.metadata->>'reply_to_message_id', ''), ''),
                  NULLIF(COALESCE(m.metadata->>'replyToMessageId', ''), ''),
                  NULLIF(COALESCE(m.metadata->>'response_parent_id', ''), ''),
                  c.reply_to_message_id
                ) IS NOT NULL
                OR EXISTS (
                  SELECT 1
                    FROM memory_items mx
                   WHERE COALESCE(NULLIF(mx.source_conversation_id, ''), NULLIF(mx.metadata->>'conversation_id', ''), NULLIF(mx.metadata->>'conversationId', ''), NULLIF(mx.metadata->>'conversationLabel', ''), COALESCE(mx.chat_namespace, 'personal.main'), mx.id::text)
                         = COALESCE(NULLIF(m.source_conversation_id, ''), NULLIF(m.metadata->>'conversation_id', ''), NULLIF(m.metadata->>'conversationId', ''), NULLIF(m.metadata->>'conversationLabel', ''), COALESCE(m.chat_namespace, 'personal.main'), m.id::text)
                     AND ABS(EXTRACT(EPOCH FROM (COALESCE(mx.source_timestamp, mx.created_at) - COALESCE(m.source_timestamp, c.observed_at)))) <= 900
                     AND length(trim(COALESCE(mx.content, ''))) >= 3
                     AND COALESCE(mx.metadata->>'system_event', 'false') <> 'true'
                )
              ) THEN 0.75
            WHEN length(trim(COALESCE(m.content, ''))) <= 2 THEN 0.2
            ELSE 0.9
          END
        )`
  );

  const inserted = await pool.query(
    `WITH source_rows AS (
       SELECT
         m.id AS memory_item_id,
         m.chat_namespace,
         m.source_system,
         m.source_conversation_id,
         m.source_message_id,
         m.role,
         m.content,
         COALESCE(m.source_timestamp, m.created_at) AS observed_at,
         m.metadata
       FROM memory_items m
       LEFT JOIN canonical_messages c ON c.memory_item_id = m.id
       WHERE c.id IS NULL
       ORDER BY COALESCE(m.source_timestamp, m.created_at) ASC
       LIMIT $1
     )
     INSERT INTO canonical_messages (
       memory_item_id,
       chat_namespace,
       source_system,
       role,
       content_normalized,
       language,
       observed_at,
       valid_from,
       valid_to,
       recorded_at,
       quality_score,
       artifact_state,
       quality_signals,
        metadata,
        conversation_id,
        source_conversation_id,
        source_message_id,
        reply_to_message_id
      )
      SELECT
        s.memory_item_id,
       COALESCE(s.chat_namespace, 'personal.main'),
       s.source_system,
       s.role,
       trim(regexp_replace(lower(s.content), '\\s+', ' ', 'g')),
       'unknown',
       s.observed_at,
       s.observed_at,
       NULL,
       now(),
         CASE
           WHEN COALESCE(s.metadata->>'system_event', 'false') = 'true' THEN 0.05
           WHEN s.observed_at < '1983-01-01'::timestamptz THEN 0.1
           WHEN s.observed_at > now() + interval '1 day' THEN 0.2
           WHEN length(trim(COALESCE(s.content, ''))) = 0 THEN 0.2
           WHEN length(trim(COALESCE(s.content, ''))) <= 2
             AND (
               COALESCE(
                 NULLIF(COALESCE(s.metadata->>'reply_to_message_id', ''), ''),
                 NULLIF(COALESCE(s.metadata->>'replyToMessageId', ''), ''),
                 NULLIF(COALESCE(s.metadata->>'response_parent_id', ''), '')
               ) IS NOT NULL
               OR EXISTS (
                 SELECT 1
                   FROM memory_items mx
                  WHERE COALESCE(NULLIF(mx.source_conversation_id, ''), NULLIF(mx.metadata->>'conversation_id', ''), NULLIF(mx.metadata->>'conversationId', ''), NULLIF(mx.metadata->>'conversationLabel', ''), COALESCE(mx.chat_namespace, 'personal.main'), mx.id::text)
                        = COALESCE(NULLIF(s.source_conversation_id, ''), NULLIF(s.metadata->>'conversation_id', ''), NULLIF(s.metadata->>'conversationId', ''), NULLIF(s.metadata->>'conversationLabel', ''), COALESCE(s.chat_namespace, 'personal.main'), s.memory_item_id::text)
                    AND ABS(EXTRACT(EPOCH FROM (COALESCE(mx.source_timestamp, mx.created_at) - s.observed_at))) <= 900
                    AND length(trim(COALESCE(mx.content, ''))) >= 3
                    AND COALESCE(mx.metadata->>'system_event', 'false') <> 'true'
               )
             ) THEN 0.75
           WHEN length(trim(COALESCE(s.content, ''))) <= 2 THEN 0.2
           ELSE 0.9
         END,
       'candidate',
         jsonb_build_object(
           'sourceTimestamp', s.observed_at,
           'length', length(s.content),
           'timestampPlausible', (s.observed_at >= '1983-01-01'::timestamptz AND s.observed_at <= now() + interval '1 day'),
           'systemEvent', (COALESCE(s.metadata->>'system_event', 'false') = 'true'),
           'contextualShort', (
             COALESCE(s.metadata->>'system_event', 'false') <> 'true'
             AND length(trim(COALESCE(s.content, ''))) <= 2
             AND (
               COALESCE(
                 NULLIF(COALESCE(s.metadata->>'reply_to_message_id', ''), ''),
                 NULLIF(COALESCE(s.metadata->>'replyToMessageId', ''), ''),
                 NULLIF(COALESCE(s.metadata->>'response_parent_id', ''), '')
               ) IS NOT NULL
               OR EXISTS (
                 SELECT 1
                   FROM memory_items mx
                  WHERE COALESCE(NULLIF(mx.source_conversation_id, ''), NULLIF(mx.metadata->>'conversation_id', ''), NULLIF(mx.metadata->>'conversationId', ''), NULLIF(mx.metadata->>'conversationLabel', ''), COALESCE(mx.chat_namespace, 'personal.main'), mx.id::text)
                        = COALESCE(NULLIF(s.source_conversation_id, ''), NULLIF(s.metadata->>'conversation_id', ''), NULLIF(s.metadata->>'conversationId', ''), NULLIF(s.metadata->>'conversationLabel', ''), COALESCE(s.chat_namespace, 'personal.main'), s.memory_item_id::text)
                    AND ABS(EXTRACT(EPOCH FROM (COALESCE(mx.source_timestamp, mx.created_at) - s.observed_at))) <= 900
                    AND length(trim(COALESCE(mx.content, ''))) >= 3
                    AND COALESCE(mx.metadata->>'system_event', 'false') <> 'true'
               )
             )
           )
         ),
        COALESCE(s.metadata, '{}'::jsonb),
        COALESCE(NULLIF(s.source_conversation_id, ''), NULLIF(s.metadata->>'conversation_id', ''), NULLIF(s.metadata->>'conversationId', ''), NULLIF(s.metadata->>'conversationLabel', ''), COALESCE(s.chat_namespace, 'personal.main'), s.memory_item_id::text),
        COALESCE(NULLIF(s.source_conversation_id, ''), NULLIF(s.metadata->>'conversationLabel', '')),
        COALESCE(NULLIF(s.source_message_id, ''), NULLIF(s.metadata->>'source_message_id', ''), NULLIF(s.metadata->>'sourceMessageId', ''), NULLIF(s.metadata->>'message_id', ''), NULLIF(s.metadata->>'messageId', ''), s.memory_item_id::text),
        COALESCE(NULLIF(s.metadata->>'reply_to_message_id', ''), NULLIF(s.metadata->>'replyToMessageId', ''), NULLIF(s.metadata->>'response_parent_id', ''))
      FROM source_rows s`,
    [safeLimit]
  );

  await pool.query(
    `WITH actor_base AS (
       SELECT
         c.chat_namespace,
         CASE
           WHEN c.role = 'assistant' THEN 'assistant'
           WHEN c.role = 'system' THEN 'system'
           WHEN c.role = 'user' THEN CASE
             WHEN c.source_system = 'whatsapp'
               AND lower(
                     regexp_replace(
                       replace(replace(COALESCE(c.metadata->>'speaker', c.metadata->>'sender', c.metadata->>'author', ''), chr(160), ' '), chr(8239), ' '),
                       '^[~\\s]+',
                       ''
                     )
                   ) <> lower(
                     regexp_replace(
                       replace(replace($1, chr(160), ' '), chr(8239), ' '),
                       '^[~\\s]+',
                       ''
                     )
                   )
               THEN 'contact'
             ELSE 'user'
           END
           ELSE 'unknown'
         END AS actor_type,
         NULLIF(trim(regexp_replace(replace(replace(COALESCE(
           c.metadata->>'speaker',
           c.metadata->>'sender',
           c.metadata->>'author',
           c.metadata->>'actor',
           c.metadata->>'agent',
           c.metadata->>'name',
           CASE
             WHEN c.role = 'assistant' THEN initcap(c.source_system) || ' assistant'
             WHEN c.role = 'system' THEN initcap(c.source_system) || ' system'
             WHEN c.role = 'user' THEN $1
             ELSE 'unknown'
           END
         ), chr(160), ' '), chr(8239), ' '), '^[~\\s]+', '')), '') AS actor_name,
         c.source_system,
         c.quality_score,
         c.observed_at
       FROM canonical_messages c
     ),
     actor_src AS (
       SELECT
         b.chat_namespace,
         b.actor_type,
         b.actor_name,
         MIN(b.source_system) AS source_system,
         MAX(b.quality_score) AS confidence,
         MIN(b.observed_at) AS first_seen,
         MAX(b.observed_at) AS last_seen,
         lower(regexp_replace(trim(b.actor_name), '\s+', ' ', 'g')) AS normalized_name
       FROM actor_base b
       WHERE b.actor_name IS NOT NULL
         AND b.actor_name <> ''
       GROUP BY b.chat_namespace, b.actor_type, b.actor_name, lower(regexp_replace(trim(b.actor_name), '\s+', ' ', 'g'))
     ),
     actor_best AS (
       SELECT
         s.actor_name,
         s.normalized_name,
         s.source_system,
         s.confidence,
         s.first_seen,
         s.last_seen,
         ROW_NUMBER() OVER (
           PARTITION BY s.normalized_name
           ORDER BY s.confidence DESC NULLS LAST, s.last_seen DESC NULLS LAST, s.actor_name
         ) AS rn
       FROM actor_src s
     )
     INSERT INTO actors (
       canonical_name,
       normalized_name,
       metadata,
       created_at,
       updated_at
     )
     SELECT
       b.actor_name,
       b.normalized_name,
       jsonb_build_object(
         'seededBy', 'v2_quality_bootstrap',
         'lastObservedSource', b.source_system,
         'firstSeenAt', b.first_seen,
         'lastSeenAt', b.last_seen,
         'confidence', LEAST(1.0, GREATEST(0.25, b.confidence))
       ),
       now(),
       now()
     FROM actor_best b
     WHERE b.rn = 1
     ON CONFLICT (normalized_name)
     DO UPDATE SET
       canonical_name = EXCLUDED.canonical_name,
       metadata = COALESCE(actors.metadata, '{}'::jsonb) || EXCLUDED.metadata,
       updated_at = now()`,
    [ownerName]
  );

  await pool.query(
    `WITH actor_base AS (
       SELECT
         c.chat_namespace,
         CASE
           WHEN c.role = 'assistant' THEN 'assistant'
           WHEN c.role = 'system' THEN 'system'
           WHEN c.role = 'user' THEN CASE
             WHEN c.source_system = 'whatsapp'
               AND lower(
                     regexp_replace(
                       replace(replace(COALESCE(c.metadata->>'speaker', c.metadata->>'sender', c.metadata->>'author', ''), chr(160), ' '), chr(8239), ' '),
                       '^[~\\s]+',
                       ''
                     )
                   ) <> lower(
                     regexp_replace(
                       replace(replace($1, chr(160), ' '), chr(8239), ' '),
                       '^[~\\s]+',
                       ''
                     )
                   )
               THEN 'contact'
             ELSE 'user'
           END
           ELSE 'unknown'
         END AS actor_type,
         NULLIF(trim(regexp_replace(replace(replace(COALESCE(
           c.metadata->>'speaker',
           c.metadata->>'sender',
           c.metadata->>'author',
           c.metadata->>'actor',
           c.metadata->>'agent',
           c.metadata->>'name',
           CASE
             WHEN c.role = 'assistant' THEN initcap(c.source_system) || ' assistant'
             WHEN c.role = 'system' THEN initcap(c.source_system) || ' system'
             WHEN c.role = 'user' THEN $1
             ELSE 'unknown'
           END
         ), chr(160), ' '), chr(8239), ' '), '^[~\\s]+', '')), '') AS actor_name,
         c.source_system,
         c.quality_score,
         c.observed_at
       FROM canonical_messages c
     ),
     actor_src AS (
       SELECT
         b.chat_namespace,
         b.actor_type,
         b.actor_name,
         MIN(b.source_system) AS source_system,
         MAX(b.quality_score) AS confidence,
         MIN(b.observed_at) AS first_seen,
         MAX(b.observed_at) AS last_seen,
         lower(regexp_replace(trim(b.actor_name), '\s+', ' ', 'g')) AS normalized_name
       FROM actor_base b
       WHERE b.actor_name IS NOT NULL
         AND b.actor_name <> ''
       GROUP BY b.chat_namespace, b.actor_type, b.actor_name, lower(regexp_replace(trim(b.actor_name), '\s+', ' ', 'g'))
     )
     INSERT INTO actor_context (
       actor_id,
       chat_namespace,
       actor_type,
       canonical_name,
       source,
       confidence,
       metadata,
       created_at,
       updated_at
     )
     SELECT
       a.actor_id,
       s.chat_namespace,
       s.actor_type,
       s.actor_name,
       s.source_system,
       LEAST(1.0, GREATEST(0.25, s.confidence)),
       jsonb_build_object('firstSeenAt', s.first_seen, 'lastSeenAt', s.last_seen),
       now(),
       now()
     FROM actor_src s
     JOIN actors a ON a.normalized_name = s.normalized_name
     ON CONFLICT (chat_namespace, actor_type, canonical_name)
     DO UPDATE SET
       actor_id = EXCLUDED.actor_id,
       source = EXCLUDED.source,
       confidence = GREATEST(actor_context.confidence, EXCLUDED.confidence),
       metadata = COALESCE(actor_context.metadata, '{}'::jsonb) || EXCLUDED.metadata,
       updated_at = now()`,
    [ownerName]
  );

  await pool.query(
    `WITH resolved AS (
       SELECT
         c.id,
         c.chat_namespace,
         CASE
           WHEN c.role = 'assistant' THEN 'assistant'
           WHEN c.role = 'system' THEN 'system'
           WHEN c.role = 'user' THEN CASE
             WHEN c.source_system = 'whatsapp'
               AND lower(
                     regexp_replace(
                       replace(replace(COALESCE(c.metadata->>'speaker', c.metadata->>'sender', c.metadata->>'author', ''), chr(160), ' '), chr(8239), ' '),
                       '^[~\\s]+',
                       ''
                     )
                   ) <> lower(
                     regexp_replace(
                       replace(replace($1, chr(160), ' '), chr(8239), ' '),
                       '^[~\\s]+',
                       ''
                     )
                   )
               THEN 'contact'
             ELSE 'user'
           END
           ELSE 'unknown'
         END AS actor_type,
         NULLIF(trim(regexp_replace(replace(replace(COALESCE(
           c.metadata->>'speaker',
           c.metadata->>'sender',
           c.metadata->>'author',
           c.metadata->>'actor',
           c.metadata->>'agent',
           c.metadata->>'name',
           CASE
             WHEN c.role = 'assistant' THEN initcap(c.source_system) || ' assistant'
             WHEN c.role = 'system' THEN initcap(c.source_system) || ' system'
             WHEN c.role = 'user' THEN $1
             ELSE 'unknown'
           END
         ), chr(160), ' '), chr(8239), ' '), '^[~\\s]+', '')), '') AS actor_name
       FROM canonical_messages c
     ),
      matched AS (
        SELECT
          r.id,
          ac.actor_id,
          r.actor_type
        FROM resolved r
        JOIN actor_context ac
          ON ac.chat_namespace = r.chat_namespace
         AND ac.actor_type = r.actor_type
         AND ac.canonical_name = r.actor_name
        WHERE r.actor_name IS NOT NULL
      )
     UPDATE canonical_messages c
        SET actor_id = m.actor_id,
            actor_type = m.actor_type,
            updated_at = now()
       FROM matched m
      WHERE c.id = m.id
        AND (c.actor_id IS DISTINCT FROM m.actor_id OR c.actor_type IS DISTINCT FROM m.actor_type)`,
    [ownerName]
  );

  await pool.query(
    `UPDATE canonical_messages c
        SET actor_type = ac.actor_type,
            updated_at = now()
       FROM actor_context ac
      WHERE c.actor_id IS NOT NULL
        AND ac.chat_namespace = c.chat_namespace
        AND ac.actor_id = c.actor_id
        AND c.actor_type IS DISTINCT FROM ac.actor_type`
  );

  await pool.query(
    `WITH aliases AS (
       SELECT
         c.actor_id,
         c.chat_namespace,
         c.source_system,
         lower(trim(v.alias)) AS alias,
         MIN(c.observed_at) AS first_seen,
         MAX(c.observed_at) AS last_seen
       FROM canonical_messages c
        JOIN actors ai ON ai.actor_id = c.actor_id
       CROSS JOIN LATERAL (
         VALUES
           (c.metadata->>'speaker'),
           (c.metadata->>'sender'),
           (c.metadata->>'author'),
           (c.metadata->>'actor'),
           (c.metadata->>'agent'),
           (c.metadata->>'name')
       ) v(alias)
       WHERE c.actor_id IS NOT NULL
         AND v.alias IS NOT NULL
         AND trim(v.alias) <> ''
         AND lower(trim(v.alias)) <> lower(ai.canonical_name)
       GROUP BY c.actor_id, c.chat_namespace, c.source_system, lower(trim(v.alias))
     )
     INSERT INTO actor_aliases (
       actor_id,
       chat_namespace,
       alias,
       source_system,
       confidence,
       first_seen_at,
       last_seen_at,
       created_at
     )
     SELECT
       a.actor_id,
       a.chat_namespace,
       a.alias,
       a.source_system,
       0.8,
       a.first_seen,
       a.last_seen,
       now()
     FROM aliases a
     WHERE a.alias <> ''
      ON CONFLICT (chat_namespace, alias)
      DO UPDATE SET
        actor_id = EXCLUDED.actor_id,
        source_system = EXCLUDED.source_system,
        confidence = GREATEST(actor_aliases.confidence, EXCLUDED.confidence),
        first_seen_at = COALESCE(LEAST(actor_aliases.first_seen_at, EXCLUDED.first_seen_at), actor_aliases.first_seen_at, EXCLUDED.first_seen_at),
        last_seen_at = COALESCE(GREATEST(actor_aliases.last_seen_at, EXCLUDED.last_seen_at), actor_aliases.last_seen_at, EXCLUDED.last_seen_at)`
  );

  await pool.query(
    `INSERT INTO actor_source_profile (
       actor_id,
       chat_namespace,
       source_system,
       message_count,
       first_seen_at,
       last_seen_at,
       max_quality_score,
       metadata,
       created_at,
       updated_at
     )
     SELECT
       c.actor_id,
       c.chat_namespace,
       c.source_system,
       COUNT(*)::int AS message_count,
       MIN(c.observed_at) AS first_seen_at,
       MAX(c.observed_at) AS last_seen_at,
       COALESCE(MAX(c.quality_score), 0) AS max_quality_score,
       jsonb_build_object(
         'publishedCount', COUNT(*) FILTER (WHERE c.artifact_state = 'published'),
         'candidateCount', COUNT(*) FILTER (WHERE c.artifact_state = 'candidate')
       ),
       now(),
       now()
     FROM canonical_messages c
     WHERE c.actor_id IS NOT NULL
     GROUP BY c.actor_id, c.chat_namespace, c.source_system
     ON CONFLICT (actor_id, chat_namespace, source_system)
     DO UPDATE SET
       message_count = EXCLUDED.message_count,
       first_seen_at = COALESCE(LEAST(actor_source_profile.first_seen_at, EXCLUDED.first_seen_at), actor_source_profile.first_seen_at, EXCLUDED.first_seen_at),
       last_seen_at = COALESCE(GREATEST(actor_source_profile.last_seen_at, EXCLUDED.last_seen_at), actor_source_profile.last_seen_at, EXCLUDED.last_seen_at),
       max_quality_score = GREATEST(actor_source_profile.max_quality_score, EXCLUDED.max_quality_score),
       metadata = EXCLUDED.metadata,
       updated_at = now()`
  );

  const namespaces = await pool.query<{ chat_namespace: string }>(
    `SELECT DISTINCT chat_namespace
       FROM canonical_messages`
  );
  for (const row of namespaces.rows) {
    const chatNamespace = String(row.chat_namespace ?? "").trim();
    if (!chatNamespace) continue;
    await repairActorAbstractions(chatNamespace);
  }

  const promoteResult = await pool.query<{ id: string; quality_score: number }>(
    `UPDATE canonical_messages
        SET artifact_state = CASE WHEN quality_score >= 0.7 THEN 'published' ELSE 'candidate' END,
            updated_at = now()
      WHERE artifact_state IN ('candidate', 'validated', 'published')
      RETURNING id, quality_score`
  );

  let published = 0;
  let quarantined = 0;
  for (const row of promoteResult.rows) {
    if (Number(row.quality_score) >= 0.7) {
      published += 1;
      continue;
    }
    quarantined += 1;
    await pool.query(
      `INSERT INTO quarantine_artifacts (artifact_type, artifact_id, reason, payload)
       VALUES ('canonical_message', $1::uuid, $2, $3::jsonb)
       ON CONFLICT DO NOTHING`,
      [row.id, "low_quality_score", JSON.stringify({ qualityScore: row.quality_score })]
    );
  }

  return {
    canonicalized: inserted.rowCount ?? 0,
    published,
    quarantined
  };
}
