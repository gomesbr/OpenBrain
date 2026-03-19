import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { PoolClient } from "pg";
import { pool } from "../db.js";
import { ensureExtendedSchema } from "../schema.js";
import { materializeCandidates, applyUniversalQualityGate, remediateLegacyArtifacts } from "../v2_pipeline.js";
import { runCanonicalBootstrap, repairActorAbstractions } from "../v2_quality.js";
import { rebuildNetworkGraphArtifacts } from "../v2_network.js";

type ReviewDecision = { actorName: string; review: string; sourceFile: string };

function getArg(argv: string[], name: string, fallback = ""): string {
  const prefix = `--${name}=`;
  for (const token of argv) {
    if (token.startsWith(prefix)) return token.slice(prefix.length).trim() || fallback;
  }
  return fallback;
}

function cleanDisplayName(value: string): string {
  return String(value ?? "")
    .replace(/^\uFEFF/, "")
    .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "")
    .replace(/[\u00A0\u202F]/g, " ")
    .replace(/^[~\s]+/u, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeActorName(value: string): string {
  return cleanDisplayName(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseCsv(content: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < content.length; i += 1) {
    const ch = content[i];
    if (inQuotes) {
      if (ch === "\"") {
        if (content[i + 1] === "\"") {
          cell += "\"";
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === "\"") inQuotes = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n") {
      row.push(cell.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += ch;
    }
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell.replace(/\r$/, ""));
    rows.push(row);
  }
  return rows.filter((parts) => parts.some((part) => String(part ?? "").trim().length > 0));
}

function loadReviewFile(pathValue: string): ReviewDecision[] {
  const absolute = resolve(pathValue);
  if (!existsSync(absolute)) return [];
  const raw = readFileSync(absolute, "utf8").replace(/^\uFEFF/, "");
  const rows = parseCsv(raw);
  if (rows.length === 0) return [];
  const header = rows[0].map((value) => String(value ?? "").trim());
  const nameIdx = header.findIndex((value) => value === "actor_name");
  const reviewIdx = header.findIndex((value) => value === "review");
  if (nameIdx < 0 || reviewIdx < 0) return [];
  return rows.slice(1).map((cols) => ({
    actorName: String(cols[nameIdx] ?? "").trim(),
    review: String(cols[reviewIdx] ?? "").trim().toLowerCase(),
    sourceFile: pathValue
  }));
}

async function snapshotTableCounts(client: PoolClient): Promise<Record<string, number>> {
  const tables = await client.query<{ tablename: string }>(
    `SELECT tablename
       FROM pg_tables
      WHERE schemaname = 'public'
      ORDER BY tablename`
  );
  const counts: Record<string, number> = {};
  for (const row of tables.rows) {
    const result = await client.query(`SELECT COUNT(*)::int AS n FROM "${row.tablename}"`);
    counts[row.tablename] = Number(result.rows[0]?.n ?? 0);
  }
  return counts;
}

async function snapshotMetrics(client: PoolClient, chatNamespace: string): Promise<Record<string, unknown>> {
  const actors = await client.query(
    `WITH actor_stats AS (
       SELECT
         a.actor_id,
         COUNT(DISTINCT ac.canonical_name) AS context_names,
         COUNT(DISTINCT ac.actor_type) AS context_types
       FROM actors a
       LEFT JOIN actor_context ac
         ON ac.actor_id = a.actor_id
        AND ac.chat_namespace = $1
       GROUP BY a.actor_id
     )
     SELECT
       COUNT(*)::int AS total,
       COUNT(*) FILTER (
         WHERE canonical_name <> regexp_replace(replace(replace(canonical_name, chr(160), ' '), chr(8239), ' '), '^[~\\s]+', '')
       )::int AS dirty_names,
       COUNT(*) FILTER (WHERE actor_stats.context_names > 1)::int AS multi_context_actors,
       COUNT(*) FILTER (WHERE actor_stats.context_types > 1)::int AS multi_type_actors
     FROM actors
     JOIN actor_stats
       ON actor_stats.actor_id = actors.actor_id`,
    [chatNamespace]
  );

  const canonical = await client.query(
    `SELECT
       COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE actor_id IS NULL)::int AS null_actor_rows,
       COUNT(*) FILTER (
         WHERE actor_id IS NOT NULL
           AND EXISTS (
             SELECT 1
               FROM actor_context ac
              WHERE ac.actor_id = canonical_messages.actor_id
                AND ac.chat_namespace = canonical_messages.chat_namespace
                AND ac.actor_type <> COALESCE(canonical_messages.actor_type, '')
           )
       )::int AS actor_type_mismatch,
       COUNT(*) FILTER (
         WHERE source_system = 'whatsapp'
           AND lower(trim(COALESCE(metadata->>'speaker', ''))) = lower(trim(COALESCE(metadata->>'conversationLabel', '')))
           AND COALESCE(metadata->>'system_event', 'false') <> 'true'
       )::int AS whatsapp_speaker_equals_conversation
     FROM canonical_messages
     WHERE chat_namespace = $1`,
    [chatNamespace]
  );

  const brain = await client.query(
    `SELECT
       COUNT(*)::int AS person_total,
       COUNT(*) FILTER (
         WHERE NOT EXISTS (
           SELECT 1
             FROM actors a
            WHERE a.normalized_name = brain_entities.normalized_name
         )
       )::int AS person_unmatched
     FROM brain_entities
     WHERE chat_namespace = $1
       AND entity_type = 'person'`,
    [chatNamespace]
  );

  const network = await client.query<{ entity_type: string; count: number }>(
    `SELECT entity_type, COUNT(*)::int AS count
       FROM network_entities
      WHERE chat_namespace = $1
      GROUP BY entity_type
      ORDER BY entity_type`,
    [chatNamespace]
  );

  const auditArtifacts = await client.query(
    `SELECT
       (SELECT COUNT(*)::bigint - COUNT(DISTINCT coalesce(artifact_type, '') || '|' || coalesce(artifact_id::text, '') || '|' || coalesce(reason, ''))
          FROM quarantine_artifacts) AS quarantine_duplicates,
       (SELECT COUNT(*)::bigint - COUNT(DISTINCT coalesce(decided_by, '') || '|' || coalesce(trace_id, ''))
          FROM quality_decisions
         WHERE trace_id IS NOT NULL) AS quality_decision_duplicates`
  );

  return {
    actors: actors.rows[0] ?? {},
    canonicalMessages: canonical.rows[0] ?? {},
    brain: brain.rows[0] ?? {},
    networkEntitiesByType: Object.fromEntries(network.rows.map((row) => [row.entity_type, Number(row.count)])),
    auditArtifacts: auditArtifacts.rows[0] ?? {}
  };
}

async function dedupeAuditArtifacts(client: PoolClient): Promise<Record<string, number>> {
  const quarantineDeduped = await client.query(
    `WITH ranked AS (
       SELECT
         id,
         ROW_NUMBER() OVER (
           PARTITION BY artifact_type, artifact_id, reason
           ORDER BY created_at DESC, id DESC
         ) AS rn
       FROM quarantine_artifacts
       WHERE artifact_id IS NOT NULL
     )
     DELETE FROM quarantine_artifacts qa
      USING ranked r
      WHERE qa.id = r.id
        AND r.rn > 1`
  );

  const qualityDeduped = await client.query(
    `WITH ranked AS (
       SELECT
         id,
         ROW_NUMBER() OVER (
           PARTITION BY decided_by, trace_id
           ORDER BY created_at DESC, id DESC
         ) AS rn
       FROM quality_decisions
       WHERE trace_id IS NOT NULL
     )
     DELETE FROM quality_decisions qd
      USING ranked r
      WHERE qd.id = r.id
        AND r.rn > 1`
  );

  await client.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_quarantine_artifacts_unique
       ON quarantine_artifacts(artifact_type, artifact_id, reason)
       WHERE artifact_id IS NOT NULL`
  );

  await client.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_quality_decisions_trace_unique
       ON quality_decisions(decided_by, trace_id)
       WHERE trace_id IS NOT NULL`
  );

  return {
    quarantineDeduped: quarantineDeduped.rowCount ?? 0,
    qualityDecisionDeduped: qualityDeduped.rowCount ?? 0
  };
}

async function rebuildLegacyBrainPeople(client: PoolClient, chatNamespace: string): Promise<Record<string, number>> {
  const people = await client.query(
    `INSERT INTO brain_entities (
       chat_namespace,
       entity_type,
       normalized_name,
       display_name,
       weight,
       metadata
     )
     SELECT
       ac.chat_namespace,
       'person',
       a.normalized_name,
       a.canonical_name,
       GREATEST(COALESCE(SUM(asp.message_count), 0), 1)::float8,
       jsonb_build_object('source', 'actors', 'actorId', a.actor_id, 'actorType', ac.actor_type)
     FROM actors a
     JOIN actor_context ac
       ON ac.actor_id = a.actor_id
     LEFT JOIN actor_source_profile asp
       ON asp.actor_id = a.actor_id
      AND asp.chat_namespace = ac.chat_namespace
     WHERE ac.chat_namespace = $1
       AND ac.actor_type IN ('user', 'contact')
     GROUP BY ac.chat_namespace, a.actor_id, a.normalized_name, a.canonical_name, ac.actor_type
     ON CONFLICT (chat_namespace, entity_type, normalized_name)
     DO UPDATE SET
       display_name = EXCLUDED.display_name,
       weight = EXCLUDED.weight,
       metadata = EXCLUDED.metadata`,
    [chatNamespace]
  );

  const staleFactsSubject = await client.query(
    `WITH desired AS (
       SELECT DISTINCT ac.chat_namespace, a.normalized_name
         FROM actors a
         JOIN actor_context ac
           ON ac.actor_id = a.actor_id
        WHERE ac.chat_namespace = $1
          AND ac.actor_type IN ('user', 'contact')
     ),
     stale AS (
       SELECT be.id
         FROM brain_entities be
         LEFT JOIN desired d
           ON d.chat_namespace = be.chat_namespace
          AND d.normalized_name = be.normalized_name
        WHERE be.chat_namespace = $1
          AND be.entity_type = 'person'
          AND d.normalized_name IS NULL
     )
     UPDATE brain_facts bf
        SET subject_entity_id = NULL
      WHERE bf.subject_entity_id IN (SELECT id FROM stale)`,
    [chatNamespace]
  );

  const staleFactsObject = await client.query(
    `WITH desired AS (
       SELECT DISTINCT ac.chat_namespace, a.normalized_name
         FROM actors a
         JOIN actor_context ac
           ON ac.actor_id = a.actor_id
        WHERE ac.chat_namespace = $1
          AND ac.actor_type IN ('user', 'contact')
     ),
     stale AS (
       SELECT be.id
         FROM brain_entities be
         LEFT JOIN desired d
           ON d.chat_namespace = be.chat_namespace
          AND d.normalized_name = be.normalized_name
        WHERE be.chat_namespace = $1
          AND be.entity_type = 'person'
          AND d.normalized_name IS NULL
     )
     UPDATE brain_facts bf
        SET object_entity_id = NULL
      WHERE bf.object_entity_id IN (SELECT id FROM stale)`,
    [chatNamespace]
  );

  const staleEdges = await client.query(
    `WITH desired AS (
       SELECT DISTINCT ac.chat_namespace, a.normalized_name
         FROM actors a
         JOIN actor_context ac
           ON ac.actor_id = a.actor_id
        WHERE ac.chat_namespace = $1
          AND ac.actor_type IN ('user', 'contact')
     ),
     stale AS (
       SELECT be.id
         FROM brain_entities be
         LEFT JOIN desired d
           ON d.chat_namespace = be.chat_namespace
          AND d.normalized_name = be.normalized_name
        WHERE be.chat_namespace = $1
          AND be.entity_type = 'person'
          AND d.normalized_name IS NULL
     )
     DELETE FROM brain_relationship_edges bre
      WHERE bre.chat_namespace = $1
        AND (
          bre.subject_entity_id IN (SELECT id FROM stale)
          OR bre.object_entity_id IN (SELECT id FROM stale)
        )`,
    [chatNamespace]
  );

  const staleAliases = await client.query(
    `WITH desired AS (
       SELECT DISTINCT ac.chat_namespace, a.normalized_name
         FROM actors a
         JOIN actor_context ac
           ON ac.actor_id = a.actor_id
        WHERE ac.chat_namespace = $1
          AND ac.actor_type IN ('user', 'contact')
     ),
     stale AS (
       SELECT be.id
         FROM brain_entities be
         LEFT JOIN desired d
           ON d.chat_namespace = be.chat_namespace
          AND d.normalized_name = be.normalized_name
        WHERE be.chat_namespace = $1
          AND be.entity_type = 'person'
          AND d.normalized_name IS NULL
     )
     DELETE FROM brain_entity_aliases bea
      WHERE bea.entity_id IN (SELECT id FROM stale)`,
    [chatNamespace]
  );

  const stalePeople = await client.query(
    `WITH desired AS (
       SELECT DISTINCT ac.chat_namespace, a.normalized_name
         FROM actors a
         JOIN actor_context ac
           ON ac.actor_id = a.actor_id
        WHERE ac.chat_namespace = $1
          AND ac.actor_type IN ('user', 'contact')
     )
     DELETE FROM brain_entities be
      WHERE be.chat_namespace = $1
        AND be.entity_type = 'person'
        AND NOT EXISTS (
          SELECT 1
            FROM desired d
           WHERE d.chat_namespace = be.chat_namespace
             AND d.normalized_name = be.normalized_name
        )`,
    [chatNamespace]
  );

  await client.query(`DELETE FROM brain_relationship_edges WHERE chat_namespace = $1`, [chatNamespace]);
  await client.query(
    `DELETE FROM brain_entity_aliases
      WHERE entity_id IN (
        SELECT id
          FROM brain_entities
         WHERE chat_namespace = $1
           AND entity_type = 'person'
      )`,
    [chatNamespace]
  );

  const aliases = await client.query(
    `WITH person_entities AS (
       SELECT
         id AS entity_id,
         (metadata->>'actorId')::uuid AS actor_id,
         chat_namespace,
         entity_type,
         normalized_name AS alias_normalized,
         normalized_name AS entity_normalized
       FROM brain_entities
       WHERE chat_namespace = $1
         AND entity_type = 'person'
     ),
     alias_rows AS (
       SELECT chat_namespace, entity_type, alias_normalized, entity_id, true AS is_canonical
       FROM person_entities
       UNION
       SELECT
         aa.chat_namespace,
         'person',
         lower(trim(regexp_replace(regexp_replace(unaccent(replace(replace(aa.alias, chr(160), ' '), chr(8239), ' ')), '^[~\\s]+', ''), '[^a-z0-9\\s]+', ' ', 'g'))) AS alias_normalized,
         pe.entity_id,
         false AS is_canonical
       FROM actor_aliases aa
       JOIN person_entities pe
         ON pe.actor_id = aa.actor_id
        AND pe.chat_namespace = aa.chat_namespace
       WHERE aa.chat_namespace = $1
     ),
     ranked_aliases AS (
       SELECT
         ar.chat_namespace,
         ar.entity_type,
         ar.alias_normalized,
         ar.entity_id,
         ROW_NUMBER() OVER (
           PARTITION BY ar.chat_namespace, ar.entity_type, ar.alias_normalized
           ORDER BY ar.is_canonical DESC, ar.entity_id
         ) AS rn
       FROM alias_rows ar
     )
     INSERT INTO brain_entity_aliases (chat_namespace, entity_type, alias_normalized, entity_id)
     SELECT chat_namespace, entity_type, alias_normalized, entity_id
     FROM ranked_aliases
     WHERE alias_normalized <> ''
       AND rn = 1
     ON CONFLICT (chat_namespace, entity_type, alias_normalized)
     DO UPDATE SET entity_id = EXCLUDED.entity_id`,
    [chatNamespace]
  );

  const edges = await client.query(
    `WITH alias_map AS (
       SELECT entity_id, alias_normalized
       FROM brain_entity_aliases
       WHERE chat_namespace = $1
         AND entity_type = 'person'
     ),
     resolved AS (
       SELECT
         sm.entity_id AS subject_entity_id,
         om.entity_id AS object_entity_id,
         rc.relation_type,
         MAX(rc.weight) AS weight,
         COUNT(*)::int AS interaction_count
       FROM relationship_candidates rc
       JOIN alias_map sm
         ON sm.alias_normalized = lower(trim(regexp_replace(regexp_replace(unaccent(replace(replace(rc.subject_name, chr(160), ' '), chr(8239), ' ')), '^[~\\s]+', ''), '[^a-z0-9\\s]+', ' ', 'g')))
       JOIN alias_map om
         ON om.alias_normalized = lower(trim(regexp_replace(regexp_replace(unaccent(replace(replace(rc.object_name, chr(160), ' '), chr(8239), ' ')), '^[~\\s]+', ''), '[^a-z0-9\\s]+', ' ', 'g')))
       WHERE rc.chat_namespace = $1
         AND rc.artifact_state = 'published'
         AND sm.entity_id <> om.entity_id
       GROUP BY sm.entity_id, om.entity_id, rc.relation_type
     )
     INSERT INTO brain_relationship_edges (
       chat_namespace,
       subject_entity_id,
       object_entity_id,
       relation_type,
       weight,
       interaction_count,
       metadata
     )
     SELECT $1, subject_entity_id, object_entity_id, relation_type, weight, interaction_count, jsonb_build_object('source', 'relationship_candidates')
     FROM resolved`,
    [chatNamespace]
  );

  return {
    personEntitiesUpserted: people.rowCount ?? 0,
    stalePersonFactsSubjectCleared: staleFactsSubject.rowCount ?? 0,
    stalePersonFactsObjectCleared: staleFactsObject.rowCount ?? 0,
    stalePersonAliasesDeleted: staleAliases.rowCount ?? 0,
    stalePersonEdgesDeleted: staleEdges.rowCount ?? 0,
    stalePersonEntitiesDeleted: stalePeople.rowCount ?? 0,
    personAliasesInserted: aliases.rowCount ?? 0,
    relationshipEdgesInserted: edges.rowCount ?? 0
  };
}

async function countMissingCanonicalMessages(chatNamespace: string): Promise<number> {
  const result = await pool.query(
    `SELECT COUNT(*)::int AS n
       FROM memory_items m
       LEFT JOIN canonical_messages c
         ON c.memory_item_id = m.id
      WHERE c.id IS NULL
        AND COALESCE(m.chat_namespace, 'personal.main') = $1`,
    [chatNamespace]
  );
  return Number(result.rows[0]?.n ?? 0);
}

async function main(): Promise<void> {
  await ensureExtendedSchema();
  const argv = process.argv.slice(2);
  const chatNamespace = getArg(argv, "chatNamespace", "personal.main");
  const outputPath = resolve(getArg(argv, "output", "generated/dq_audit_latest.json"));
  const reviewFiles = [
    "generated/actor_pronoun_review/they_actor_pronouns_review_sheet_round2.csv",
    "generated/actor_pronoun_review/they_actor_pronouns_review_sheet.csv",
    "generated/actor_pronoun_review/low_confidence_actor_pronouns_review_sheet.csv"
  ];

  const client = await pool.connect();
  try {
    const before = {
      tableCounts: await snapshotTableCounts(client),
      metrics: await snapshotMetrics(client, chatNamespace)
    };

    await client.query("BEGIN");
    let labelOverridesUpserted = 0;
    for (const file of reviewFiles) {
      for (const row of loadReviewFile(file)) {
        if (row.review !== "w") continue;
        const normalizedLabel = normalizeActorName(row.actorName);
        if (!normalizedLabel) continue;
        const result = await client.query(
          `INSERT INTO actor_label_overrides (
             chat_namespace,
             normalized_label,
             display_label,
             classification,
             source_system,
             metadata
           ) VALUES ($1, $2, $3, 'group_chat', 'whatsapp', $4::jsonb)
           ON CONFLICT (chat_namespace, normalized_label, source_system)
           DO UPDATE SET
             display_label = EXCLUDED.display_label,
             classification = EXCLUDED.classification,
             metadata = COALESCE(actor_label_overrides.metadata, '{}'::jsonb) || EXCLUDED.metadata,
             updated_at = now()`,
          [chatNamespace, normalizedLabel, cleanDisplayName(row.actorName) || row.actorName, JSON.stringify({ source: "owner_review", sourceFile: row.sourceFile })]
        );
        labelOverridesUpserted += result.rowCount ?? 0;
      }
    }

    const blankActorDeletes = await client.query(
      `DELETE FROM actors a
        WHERE lower(trim(regexp_replace(regexp_replace(unaccent(replace(replace(a.canonical_name, chr(160), ' '), chr(8239), ' ')), '^[~\\s]+', ''), '[^a-z0-9\\s]+', ' ', 'g'))) = ''
          AND NOT EXISTS (
                SELECT 1
                  FROM canonical_messages c
                 WHERE c.actor_id = a.actor_id
              )
          AND NOT EXISTS (
                SELECT 1
                  FROM answer_evidence_links ael
                 WHERE ael.actor_id = a.actor_id
              )`
    );

    const actorDisplayCleanup = await client.query(
      `WITH cleaned AS (
         SELECT
           actor_id,
           trim(
             regexp_replace(
               regexp_replace(
                 replace(replace(replace(replace(canonical_name, chr(160), ' '), chr(8239), ' '), chr(8234), ''), chr(8236), ''),
                 '^[~\\s]+',
                 ''
               ),
               '\\s+',
               ' ',
               'g'
             )
           ) AS cleaned_name
         FROM actors
       )
       UPDATE actors a
          SET canonical_name = c.cleaned_name
         FROM cleaned c
        WHERE a.actor_id = c.actor_id
          AND c.cleaned_name <> ''
          AND a.canonical_name IS DISTINCT FROM c.cleaned_name`
    );

    await client.query("COMMIT");

    const auditArtifactsRepair = await dedupeAuditArtifacts(client);

    const bootstrapRuns: Array<Record<string, number>> = [];
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const missingBefore = await countMissingCanonicalMessages(chatNamespace);
      if (missingBefore <= 0) break;
      const result = await runCanonicalBootstrap(10000);
      bootstrapRuns.push({ missingBefore, ...result });
      if ((result.canonicalized ?? 0) <= 0) break;
    }

    const actorRepair = await repairActorAbstractions(chatNamespace);
    const candidateMaterialization = await materializeCandidates(500000);
    const qualityGate = await applyUniversalQualityGate();
    const legacyArtifacts = await remediateLegacyArtifacts();

    await client.query("BEGIN");
    const legacyBrain = await rebuildLegacyBrainPeople(client, chatNamespace);
    await client.query("COMMIT");

    const networkRebuild = await rebuildNetworkGraphArtifacts({ chatNamespace, clearExisting: true });
    const after = {
      tableCounts: await snapshotTableCounts(client),
      metrics: await snapshotMetrics(client, chatNamespace)
    };

    const report = {
      ok: true,
      generatedAt: new Date().toISOString(),
      chatNamespace,
      actions: {
        labelOverridesUpserted,
        blankActorsDeleted: blankActorDeletes.rowCount ?? 0,
        actorDisplayNamesCleaned: actorDisplayCleanup.rowCount ?? 0,
        actorNamesNormalized: 0,
        auditArtifactsRepair,
        bootstrapRuns,
        actorRepair,
        candidateMaterialization,
        qualityGate,
        legacyArtifacts,
        legacyBrain,
        networkRebuild
      },
      before,
      after
    };

    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, JSON.stringify(report, null, 2), "utf8");
    console.log(JSON.stringify(report, null, 2));
  } finally {
    client.release();
    await pool.end().catch(() => undefined);
  }
}

main().catch((error) => {
  console.error("dq_repair_full failed:", error);
  process.exit(1);
});
