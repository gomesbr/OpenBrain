import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { PoolClient } from "pg";
import { pool } from "../db.js";
import { ensureExtendedSchema } from "../schema.js";

type DuplicateRow = {
  actorId: string;
  canonicalName: string;
  cleanedName: string;
  normalizedName: string;
  actorTypes: string[];
  chatNamespaces: string[];
  messageCount: number;
  pronounSubject: string | null;
  pronounObject: string | null;
  pronounPossessive: string | null;
  pronounConfidence: number;
  pronounSource: string | null;
  hasPrefixNoise: boolean;
};

type DuplicateGroup = {
  cleanedName: string;
  rows: DuplicateRow[];
};

type MergeStats = {
  groupsMerged: number;
  actorsDeleted: number;
  canonicalMessagesMoved: number;
  evidenceLinksMoved: number;
  aliasRowsMoved: number;
  aliasRowsDeleted: number;
  contextRowsMoved: number;
  contextRowsDeleted: number;
  sourceProfilesMoved: number;
  sourceProfilesDeleted: number;
  actorsRenamed: number;
  pronounUpgrades: number;
};

function getArg(name: string, fallback = ""): string {
  const prefix = `--${name}=`;
  for (const token of process.argv.slice(2)) {
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

function pronounSpecificity(subject: string | null): number {
  switch (String(subject ?? "").toLowerCase()) {
    case "he":
    case "she":
    case "you":
    case "it":
      return 100;
    case "they":
      return 10;
    default:
      return 0;
  }
}

function pronounSourceRank(source: string | null): number {
  switch (String(source ?? "").toLowerCase()) {
    case "owner_review":
      return 1000;
    case "model_inference":
      return 50;
    default:
      return 0;
  }
}

function rowWinnerScore(row: DuplicateRow): number {
  return (
    Math.min(row.messageCount, 10000) * 10 +
    (row.hasPrefixNoise ? 0 : 200) +
    pronounSpecificity(row.pronounSubject) +
    pronounSourceRank(row.pronounSource) +
    row.pronounConfidence * 10
  );
}

function chooseWinner(rows: DuplicateRow[]): DuplicateRow {
  return [...rows].sort((a, b) => {
    const scoreDelta = rowWinnerScore(b) - rowWinnerScore(a);
    if (scoreDelta !== 0) return scoreDelta;
    const messageDelta = b.messageCount - a.messageCount;
    if (messageDelta !== 0) return messageDelta;
    const cleanDelta = Number(a.hasPrefixNoise) - Number(b.hasPrefixNoise);
    if (cleanDelta !== 0) return cleanDelta;
    return a.actorId.localeCompare(b.actorId);
  })[0];
}

function chooseBestPronouns(rows: DuplicateRow[]): {
  subject: string;
  object: string;
  possessive: string;
  confidence: number;
  source: string;
} | null {
  const candidates = rows
    .filter((row) => String(row.pronounSubject ?? "").trim().length > 0)
    .sort((a, b) => {
      const scoreA = pronounSourceRank(a.pronounSource) + pronounSpecificity(a.pronounSubject) + a.pronounConfidence * 10;
      const scoreB = pronounSourceRank(b.pronounSource) + pronounSpecificity(b.pronounSubject) + b.pronounConfidence * 10;
      return scoreB - scoreA;
    });
  const best = candidates[0];
  if (!best) return null;
  return {
    subject: String(best.pronounSubject ?? "").toLowerCase(),
    object: String(best.pronounObject ?? "").toLowerCase(),
    possessive: String(best.pronounPossessive ?? "").toLowerCase(),
    confidence: best.pronounConfidence,
    source: String(best.pronounSource ?? "merge_resolution")
  };
}

async function loadDuplicateGroups(chatNamespace: string): Promise<DuplicateGroup[]> {
  const result = await pool.query<{
    actor_id: string;
    canonical_name: string;
    actor_types: string[] | null;
    chat_namespaces: string[] | null;
    message_count: string;
    pronoun_subject: string | null;
    pronoun_object: string | null;
    pronoun_possessive: string | null;
    pronoun_confidence: string | null;
    pronoun_source: string | null;
  }>(
    `WITH actor_stats AS (
       SELECT
         a.actor_id::text AS actor_id,
         a.canonical_name,
         COALESCE(array_agg(DISTINCT ac.actor_type ORDER BY ac.actor_type) FILTER (WHERE ac.actor_type IS NOT NULL), '{}'::text[]) AS actor_types,
         COALESCE(array_agg(DISTINCT ac.chat_namespace ORDER BY ac.chat_namespace) FILTER (WHERE ac.chat_namespace IS NOT NULL), '{}'::text[]) AS chat_namespaces,
         COUNT(cm.id)::text AS message_count,
         a.metadata->'pronouns'->>'subject' AS pronoun_subject,
         a.metadata->'pronouns'->>'object' AS pronoun_object,
         a.metadata->'pronouns'->>'possessive' AS pronoun_possessive,
         a.metadata->'pronouns'->>'confidence' AS pronoun_confidence,
         a.metadata->'pronouns'->>'source' AS pronoun_source
       FROM actors a
       JOIN actor_context ac ON ac.actor_id = a.actor_id
       LEFT JOIN canonical_messages cm ON cm.actor_id = a.actor_id AND cm.chat_namespace = ac.chat_namespace
       WHERE ac.chat_namespace = $1
       GROUP BY a.actor_id, a.canonical_name, a.metadata
     ),
     keyed AS (
       SELECT
         actor_id,
         canonical_name,
         regexp_replace(replace(replace(canonical_name, chr(160), ' '), chr(8239), ' '), '^[~\\s]+', '') AS cleaned_name,
         lower(regexp_replace(regexp_replace(replace(replace(canonical_name, chr(160), ' '), chr(8239), ' '), '^[~\\s]+', ''), '\\s+', ' ', 'g')) AS cleaned_key,
         actor_types,
         chat_namespaces,
         message_count,
         pronoun_subject,
         pronoun_object,
         pronoun_possessive,
         pronoun_confidence,
         pronoun_source
       FROM actor_stats
     ),
     dup AS (
       SELECT cleaned_key
       FROM keyed
       GROUP BY cleaned_key
       HAVING COUNT(*) > 1
     )
     SELECT
       k.actor_id,
       k.canonical_name,
       k.actor_types,
       k.chat_namespaces,
       k.message_count,
       k.pronoun_subject,
       k.pronoun_object,
       k.pronoun_possessive,
       k.pronoun_confidence,
       k.pronoun_source
     FROM keyed k
     JOIN dup d ON d.cleaned_key = k.cleaned_key
     ORDER BY lower(regexp_replace(regexp_replace(replace(replace(k.canonical_name, chr(160), ' '), chr(8239), ' '), '^[~\\s]+', ''), '\\s+', ' ', 'g')), k.actor_id`,
    [chatNamespace]
  );

  const groups = new Map<string, DuplicateRow[]>();
  for (const row of result.rows) {
    const canonicalName = String(row.canonical_name);
    const cleanedName = cleanDisplayName(canonicalName);
    const normalizedName = normalizeActorName(canonicalName);
    const bucket = groups.get(normalizedName) ?? [];
    bucket.push({
      actorId: String(row.actor_id),
      canonicalName,
      cleanedName,
      normalizedName,
      actorTypes: Array.isArray(row.actor_types) ? row.actor_types.map(String) : [],
      chatNamespaces: Array.isArray(row.chat_namespaces) ? row.chat_namespaces.map(String) : [],
      messageCount: Number(row.message_count ?? 0),
      pronounSubject: row.pronoun_subject,
      pronounObject: row.pronoun_object,
      pronounPossessive: row.pronoun_possessive,
      pronounConfidence: Number(row.pronoun_confidence ?? 0) || 0,
      pronounSource: row.pronoun_source,
      hasPrefixNoise: canonicalName !== cleanedName
    });
    groups.set(normalizedName, bucket);
  }

  return Array.from(groups.entries())
    .map(([cleanedName, rows]) => ({ cleanedName, rows }))
    .filter((group) => group.rows.length > 1);
}

async function mergeActorGlobal(
  client: PoolClient,
  winner: DuplicateRow,
  loser: DuplicateRow,
  cleanedName: string,
  bestPronouns: ReturnType<typeof chooseBestPronouns>,
  stats: MergeStats
): Promise<void> {
  const existingWinnerContexts = await client.query<{
    id: string;
    chat_namespace: string;
    actor_type: string;
    canonical_name: string;
    source: string | null;
    confidence: string | null;
    metadata: Record<string, unknown> | null;
  }>(
    `SELECT id::text, chat_namespace, actor_type, canonical_name, source, confidence::text AS confidence, metadata
       FROM actor_context
      WHERE actor_id = $1::uuid`,
    [winner.actorId]
  );

  const winnerContextMap = new Map<string, (typeof existingWinnerContexts.rows)[number]>();
  for (const row of existingWinnerContexts.rows) {
    const key = `${row.chat_namespace}::${row.actor_type}::${cleanDisplayName(String(row.canonical_name ?? ""))}`;
    winnerContextMap.set(key, row);
  }

  await client.query(
    `UPDATE actors
        SET metadata = jsonb_set(
              COALESCE(metadata, '{}'::jsonb),
              '{mergedActorIds}',
              COALESCE(metadata->'mergedActorIds', '[]'::jsonb) || to_jsonb($2::text),
              true
            ),
            updated_at = now()
      WHERE actor_id = $1::uuid`,
    [winner.actorId, loser.actorId]
  );

  const loserContexts = await client.query<{
    id: string;
    chat_namespace: string;
    actor_type: string;
    canonical_name: string;
    source: string | null;
    confidence: string | null;
    metadata: Record<string, unknown> | null;
  }>(
    `SELECT id::text, chat_namespace, actor_type, canonical_name, source, confidence::text AS confidence, metadata
       FROM actor_context
      WHERE actor_id = $1::uuid`,
    [loser.actorId]
  );

  for (const row of loserContexts.rows) {
    const contextCleanName = cleanDisplayName(String(row.canonical_name ?? ""));
    const key = `${row.chat_namespace}::${row.actor_type}::${contextCleanName}`;
    const winnerContext = winnerContextMap.get(key);
    if (winnerContext) {
      await client.query(
        `UPDATE actor_context
            SET confidence = GREATEST(COALESCE(confidence, 0), $2::double precision),
                source = COALESCE(source, $3),
                metadata = COALESCE(metadata, '{}'::jsonb) || $4::jsonb,
                updated_at = now()
          WHERE id = $1::uuid`,
        [
          winnerContext.id,
          Number(row.confidence ?? 0) || 0,
          row.source,
          JSON.stringify(row.metadata ?? {})
        ]
      );
      const deleted = await client.query(
        `DELETE FROM actor_context
          WHERE id = $1::uuid`,
        [row.id]
      );
      stats.contextRowsDeleted += deleted.rowCount ?? 0;
      continue;
    }

    const moved = await client.query(
      `UPDATE actor_context
          SET actor_id = $1::uuid,
              canonical_name = $2,
              updated_at = now()
        WHERE id = $3::uuid`,
      [winner.actorId, contextCleanName, row.id]
    );
    stats.contextRowsMoved += moved.rowCount ?? 0;
  }

  const deletedAliasDupes = await client.query(
    `DELETE FROM actor_aliases la
      USING actor_aliases wa
     WHERE la.actor_id = $1::uuid
       AND wa.actor_id = $2::uuid
       AND la.chat_namespace = wa.chat_namespace
       AND la.alias = wa.alias`,
    [loser.actorId, winner.actorId]
  );
  stats.aliasRowsDeleted += deletedAliasDupes.rowCount ?? 0;

  const movedAliases = await client.query(
    `UPDATE actor_aliases
        SET actor_id = $1::uuid
      WHERE actor_id = $2::uuid`,
    [winner.actorId, loser.actorId]
  );
  stats.aliasRowsMoved += movedAliases.rowCount ?? 0;

  const deletedSourceDupes = await client.query(
    `DELETE FROM actor_source_profile lsp
      USING actor_source_profile wsp
     WHERE lsp.actor_id = $1::uuid
       AND wsp.actor_id = $2::uuid
       AND lsp.chat_namespace = wsp.chat_namespace
       AND lsp.source_system = wsp.source_system`,
    [loser.actorId, winner.actorId]
  );
  stats.sourceProfilesDeleted += deletedSourceDupes.rowCount ?? 0;

  const movedSourceProfiles = await client.query(
    `UPDATE actor_source_profile
        SET actor_id = $1::uuid
      WHERE actor_id = $2::uuid`,
    [winner.actorId, loser.actorId]
  );
  stats.sourceProfilesMoved += movedSourceProfiles.rowCount ?? 0;

  const movedCanonical = await client.query(
    `UPDATE canonical_messages
        SET actor_id = $1::uuid
      WHERE actor_id = $2::uuid`,
    [winner.actorId, loser.actorId]
  );
  stats.canonicalMessagesMoved += movedCanonical.rowCount ?? 0;

  const movedEvidence = await client.query(
    `UPDATE answer_evidence_links
        SET actor_id = $1::uuid
      WHERE actor_id = $2::uuid`,
    [winner.actorId, loser.actorId]
  );
  stats.evidenceLinksMoved += movedEvidence.rowCount ?? 0;

  await client.query(
    `DELETE FROM actor_identities
      WHERE actor_id = $1::uuid`,
    [loser.actorId]
  );

  const deletedActor = await client.query(
    `DELETE FROM actors
      WHERE actor_id = $1::uuid`,
    [loser.actorId]
  );
  stats.actorsDeleted += deletedActor.rowCount ?? 0;

  const winnerMetadata = await client.query<{ metadata: Record<string, unknown> | null }>(
    `SELECT metadata
       FROM actors
      WHERE actor_id = $1::uuid`,
    [winner.actorId]
  );
  const metadata = { ...(winnerMetadata.rows[0]?.metadata ?? {}) } as Record<string, unknown>;
  metadata.cleanedPrefixNoise = true;
  if (bestPronouns) {
    metadata.pronouns = {
      subject: bestPronouns.subject,
      object: bestPronouns.object,
      possessive: bestPronouns.possessive,
      confidence: bestPronouns.confidence,
      source: bestPronouns.source
    };
    stats.pronounUpgrades += 1;
  }

  const normalizedClean = normalizeActorName(cleanedName);
  const renamed = await client.query(
    `UPDATE actors
        SET canonical_name = $1,
            normalized_name = $2,
            metadata = $3::jsonb,
            updated_at = now()
      WHERE actor_id = $4::uuid`,
    [cleanedName, normalizedClean, JSON.stringify(metadata), winner.actorId]
  );
  stats.actorsRenamed += renamed.rowCount ?? 0;

  await client.query(
    `UPDATE actor_context
        SET canonical_name = regexp_replace(replace(replace(canonical_name, chr(160), ' '), chr(8239), ' '), '^[~\\s]+', ''),
            updated_at = now()
      WHERE actor_id = $1::uuid`,
    [winner.actorId]
  );

  await client.query(
    `UPDATE actor_identities
        SET canonical_name = regexp_replace(replace(replace(canonical_name, chr(160), ' '), chr(8239), ' '), '^[~\\s]+', ''),
            updated_at = now()
      WHERE actor_id = $1::uuid`,
    [winner.actorId]
  );
}

async function verifyNoOrphans(): Promise<Record<string, number>> {
  const checks = {
    orphanActorContext: `SELECT COUNT(*)::int AS n FROM actor_context ac LEFT JOIN actors a ON a.actor_id = ac.actor_id WHERE a.actor_id IS NULL`,
    orphanActorSourceProfile: `SELECT COUNT(*)::int AS n FROM actor_source_profile asp LEFT JOIN actors a ON a.actor_id = asp.actor_id WHERE a.actor_id IS NULL`,
    orphanCanonicalMessages: `SELECT COUNT(*)::int AS n FROM canonical_messages cm LEFT JOIN actors a ON a.actor_id = cm.actor_id WHERE cm.actor_id IS NOT NULL AND a.actor_id IS NULL`,
    orphanEvidenceLinks: `SELECT COUNT(*)::int AS n FROM answer_evidence_links ael LEFT JOIN actors a ON a.actor_id = ael.actor_id WHERE ael.actor_id IS NOT NULL AND a.actor_id IS NULL`,
    orphanActorAliases: `SELECT COUNT(*)::int AS n FROM actor_aliases aa LEFT JOIN actors a ON a.actor_id = aa.actor_id WHERE a.actor_id IS NULL`
  } as const;

  const out: Record<string, number> = {};
  for (const [key, sql] of Object.entries(checks)) {
    const result = await pool.query<{ n: number }>(sql);
    out[key] = Number(result.rows[0]?.n ?? 0);
  }
  return out;
}

async function main(): Promise<void> {
  await ensureExtendedSchema();

  const chatNamespace = getArg("chatNamespace", "personal.main") || "personal.main";
  const apply = getArg("apply", "1") !== "0";
  const outDir = resolve(process.cwd(), "generated", "actor_pronoun_review");
  mkdirSync(outDir, { recursive: true });

  const groups = await loadDuplicateGroups(chatNamespace);
  const preview = groups.map((group) => {
    const winner = chooseWinner(group.rows);
    return {
      cleanedName: group.cleanedName,
      winnerId: winner.actorId,
      winnerName: winner.canonicalName,
      loserIds: group.rows.filter((row) => row.actorId !== winner.actorId).map((row) => row.actorId),
      actorIds: group.rows.map((row) => row.actorId),
      names: group.rows.map((row) => row.canonicalName)
    };
  });

  writeFileSync(join(outDir, "actor_prefix_noise_merge_preview.json"), `${JSON.stringify(preview, null, 2)}\n`, "utf8");

  if (!apply) {
    console.log(JSON.stringify({ ok: true, mode: "dry-run", chatNamespace, groups: preview.length }, null, 2));
    await pool.end();
    return;
  }

  const client = await pool.connect();
  const stats: MergeStats = {
    groupsMerged: 0,
    actorsDeleted: 0,
    canonicalMessagesMoved: 0,
    evidenceLinksMoved: 0,
    aliasRowsMoved: 0,
    aliasRowsDeleted: 0,
    contextRowsMoved: 0,
    contextRowsDeleted: 0,
    sourceProfilesMoved: 0,
    sourceProfilesDeleted: 0,
    actorsRenamed: 0,
    pronounUpgrades: 0
  };

  try {
    await client.query("BEGIN");
    for (const group of groups) {
      const winner = chooseWinner(group.rows);
      const losers = group.rows.filter((row) => row.actorId !== winner.actorId);
      const bestPronouns = chooseBestPronouns(group.rows);
      for (const loser of losers) {
        await mergeActorGlobal(client, winner, loser, cleanDisplayName(winner.canonicalName || group.cleanedName), bestPronouns, stats);
      }
      stats.groupsMerged += 1;
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  const verification = await verifyNoOrphans();
  console.log(JSON.stringify({ ok: true, mode: "apply", chatNamespace, groups: groups.length, stats, verification }, null, 2));
  await pool.end();
}

main().catch(async (error) => {
  console.error("v2 actor prefix noise merge failed:", error);
  try {
    await pool.end();
  } catch {
    // no-op
  }
  process.exit(1);
});
