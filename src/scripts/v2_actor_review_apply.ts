import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { PoolClient } from "pg";
import { pool } from "../db.js";
import { ensureExtendedSchema } from "../schema.js";

interface MergeGroup {
  mergeKey: string;
  winnerId: string;
  loserIds: string[];
}

interface ApplyStats {
  mergedCanonicalMessages: number;
  mergedEvidenceLinks: number;
  mergedAliases: number;
  mergedActorContexts: number;
  mergedActorSourceProfiles: number;
  deletedActorsFromMerge: number;
  deletedActorsByList: number;
  deletedAliasesByList: number;
  deletedMemoryItemsByList: number;
  renamedActors: number;
}

function cleanDisplayName(value: string): string {
  return String(value ?? "")
    .replace(/^\uFEFF/, "")
    .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "")
    .replace(/\u00A0/g, " ")
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

function getArg(name: string, fallback?: string): string | undefined {
  const full = `--${name}=`;
  for (const token of process.argv.slice(2)) {
    if (token.startsWith(full)) return token.slice(full.length).trim();
  }
  return fallback;
}

function requireArg(name: string): string {
  const value = getArg(name);
  if (!value) {
    throw new Error(`Missing required arg --${name}=...`);
  }
  return value;
}

function parseUuidList(raw: string): string[] {
  const matches = raw.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) ?? [];
  return Array.from(new Set(matches.map((id) => id.toLowerCase())));
}

function parseMergeFile(pathValue: string): MergeGroup[] {
  const raw = readFileSync(resolve(pathValue), "utf8");
  const lines = raw.replace(/^\uFEFF/, "").split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length < 2) return [];
  const header = lines[0].split("\t").map((v) => v.trim());
  const mergeKeyIdx = header.findIndex((h) => h === "merge_key");
  const actorIdsIdx = header.findIndex((h) => h === "actor_ids");
  if (mergeKeyIdx < 0 || actorIdsIdx < 0) {
    throw new Error(`Merge file must contain tab-delimited columns: merge_key, actor_ids`);
  }

  const out: MergeGroup[] = [];
  for (let i = 1; i < lines.length; i += 1) {
    const cols = lines[i].split("\t");
    const mergeKey = String(cols[mergeKeyIdx] ?? "").trim();
    const actorIdsRaw = String(cols[actorIdsIdx] ?? "").trim();
    if (!actorIdsRaw) continue;
    const ids = actorIdsRaw
      .split("|")
      .map((id) => id.trim().toLowerCase())
      .filter((id) => /^[0-9a-f-]{36}$/.test(id));
    if (ids.length < 2) continue;
    out.push({
      mergeKey,
      winnerId: ids[0],
      loserIds: Array.from(new Set(ids.slice(1).filter((id) => id !== ids[0])))
    });
  }
  return out;
}

async function mergeActor(client: PoolClient, chatNamespace: string, winnerId: string, loserId: string): Promise<{
  canonicalMoved: number;
  evidenceMoved: number;
  aliasesMoved: number;
  contextsMoved: number;
  sourceProfilesMoved: number;
  loserDeleted: number;
}> {
  if (winnerId === loserId) {
    return { canonicalMoved: 0, evidenceMoved: 0, aliasesMoved: 0, contextsMoved: 0, sourceProfilesMoved: 0, loserDeleted: 0 };
  }

  await client.query(
    `UPDATE actors winner
        SET metadata = COALESCE(winner.metadata, '{}'::jsonb)
                     || COALESCE(loser.metadata, '{}'::jsonb)
                     || jsonb_build_object(
                          'mergedActorIds',
                          COALESCE(winner.metadata->'mergedActorIds', '[]'::jsonb) || to_jsonb($2::text)
                        ),
            updated_at = now()
       FROM actors loser
      WHERE winner.actor_id = $1::uuid
        AND loser.actor_id = $2::uuid`,
    [winnerId, loserId]
  );

  await client.query(
    `DELETE FROM actor_aliases a
      USING actor_aliases b
     WHERE a.actor_id = $1::uuid
       AND b.actor_id = $2::uuid
       AND a.chat_namespace = $3
       AND b.chat_namespace = $3
       AND a.alias = b.alias`,
    [loserId, winnerId, chatNamespace]
  );

  await client.query(
    `DELETE FROM actor_context lc
      USING actor_context wc
     WHERE lc.actor_id = $1::uuid
       AND wc.actor_id = $2::uuid
       AND lc.chat_namespace = wc.chat_namespace
       AND lc.actor_type = wc.actor_type
       AND lc.canonical_name = wc.canonical_name`,
    [loserId, winnerId]
  );

  const contexts = await client.query(
    `UPDATE actor_context
        SET actor_id = $1::uuid
      WHERE actor_id = $2::uuid
        AND chat_namespace = $3`,
    [winnerId, loserId, chatNamespace]
  );

  await client.query(
    `DELETE FROM actor_source_profile lsp
      USING actor_source_profile wsp
     WHERE lsp.actor_id = $1::uuid
       AND wsp.actor_id = $2::uuid
       AND lsp.chat_namespace = wsp.chat_namespace
       AND lsp.source_system = wsp.source_system`,
    [loserId, winnerId]
  );

  const sourceProfiles = await client.query(
    `UPDATE actor_source_profile
        SET actor_id = $1::uuid
      WHERE actor_id = $2::uuid
        AND chat_namespace = $3`,
    [winnerId, loserId, chatNamespace]
  );

  const aliases = await client.query(
    `UPDATE actor_aliases
        SET actor_id = $1::uuid
      WHERE actor_id = $2::uuid
        AND chat_namespace = $3`,
    [winnerId, loserId, chatNamespace]
  );

  const canonical = await client.query(
    `UPDATE canonical_messages
        SET actor_id = $1::uuid
      WHERE actor_id = $2::uuid
        AND chat_namespace = $3`,
    [winnerId, loserId, chatNamespace]
  );

  const evidence = await client.query(
    `UPDATE answer_evidence_links
        SET actor_id = $1::uuid
      WHERE actor_id = $2::uuid`,
    [winnerId, loserId]
  );

  await client.query(
    `DELETE FROM actor_identities
      WHERE actor_id = $1::uuid`,
    [loserId]
  );

  const deleted = await client.query(
    `DELETE FROM actors
      WHERE actor_id = $1::uuid`,
    [loserId]
  );

  return {
    canonicalMoved: canonical.rowCount ?? 0,
    evidenceMoved: evidence.rowCount ?? 0,
    aliasesMoved: aliases.rowCount ?? 0,
    contextsMoved: contexts.rowCount ?? 0,
    sourceProfilesMoved: sourceProfiles.rowCount ?? 0,
    loserDeleted: deleted.rowCount ?? 0
  };
}

async function maybeMergeNameConflict(
  client: PoolClient,
  chatNamespace: string,
  targetActorId: string,
  targetName: string
): Promise<void> {
  const self = await client.query<{ actor_type: string }>(
    `SELECT actor_type
       FROM actor_context
      WHERE actor_id = $1::uuid
        AND chat_namespace = $2`,
    [targetActorId, chatNamespace]
  );
  if (self.rowCount === 0) return;
  const actorType = String(self.rows[0].actor_type);
  const normalizedName = normalizeActorName(targetName);

  const conflict = await client.query<{ actor_id: string }>(
    `SELECT ac.actor_id::text AS actor_id
       FROM actor_context ac
       JOIN actors a ON a.actor_id = ac.actor_id
      WHERE ac.chat_namespace = $1
        AND ac.actor_type = $2
        AND a.normalized_name = $3
        AND ac.actor_id <> $4::uuid
      LIMIT 1`,
    [chatNamespace, actorType, normalizedName, targetActorId]
  );

  if (conflict.rowCount === 0) return;
  await mergeActor(client, chatNamespace, targetActorId, String(conflict.rows[0].actor_id));
}

async function main(): Promise<void> {
  await ensureExtendedSchema();

  const chatNamespace = getArg("chatNamespace", "personal.main")!;
  const mergeFile = requireArg("mergeFile");
  const deleteFile = requireArg("deleteFile");
  const renameArg = getArg("rename", "");
  const apply = getArg("apply", "0") === "1";

  const mergeGroups = parseMergeFile(mergeFile);
  const deleteIds = parseUuidList(readFileSync(resolve(deleteFile), "utf8"));

  const renameEntries = String(renameArg ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean)
    .map((entry) => {
      const idx = entry.indexOf(":");
      if (idx < 0) throw new Error(`Invalid --rename entry: ${entry}. Expected actorId:New Name`);
      const actorId = entry.slice(0, idx).trim().toLowerCase();
      const newName = entry.slice(idx + 1).trim();
      if (!/^[0-9a-f-]{36}$/.test(actorId) || !newName) {
        throw new Error(`Invalid --rename entry: ${entry}.`);
      }
      return { actorId, newName };
    });

  const preview = {
    chatNamespace,
    mergeGroups: mergeGroups.length,
    mergeLosers: mergeGroups.reduce((sum, group) => sum + group.loserIds.length, 0),
    deleteIds: deleteIds.length,
    renameEntries
  };

  if (!apply) {
    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify(
        {
          ok: true,
          mode: "dry-run",
          preview
        },
        null,
        2
      )
    );
    return;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const stats: ApplyStats = {
      mergedCanonicalMessages: 0,
      mergedEvidenceLinks: 0,
      mergedAliases: 0,
      mergedActorContexts: 0,
      mergedActorSourceProfiles: 0,
      deletedActorsFromMerge: 0,
      deletedActorsByList: 0,
      deletedAliasesByList: 0,
      deletedMemoryItemsByList: 0,
      renamedActors: 0
    };

    for (const group of mergeGroups) {
      for (const loserId of group.loserIds) {
        const result = await mergeActor(client, chatNamespace, group.winnerId, loserId);
        stats.mergedCanonicalMessages += result.canonicalMoved;
        stats.mergedEvidenceLinks += result.evidenceMoved;
        stats.mergedAliases += result.aliasesMoved;
        stats.mergedActorContexts += result.contextsMoved;
        stats.mergedActorSourceProfiles += result.sourceProfilesMoved;
        stats.deletedActorsFromMerge += result.loserDeleted;
      }
    }

    for (const rename of renameEntries) {
      await maybeMergeNameConflict(client, chatNamespace, rename.actorId, rename.newName);
      const cleanedName = cleanDisplayName(rename.newName);
      const normalizedName = normalizeActorName(rename.newName);
      const renamed = await client.query(
        `UPDATE actors
            SET canonical_name = $1,
                normalized_name = $2,
                updated_at = now()
          WHERE actor_id = $3::uuid`,
        [cleanedName, normalizedName, rename.actorId]
      );
      stats.renamedActors += renamed.rowCount ?? 0;

      await client.query(
        `UPDATE actor_context
            SET canonical_name = $1,
                updated_at = now()
          WHERE actor_id = $2::uuid
            AND chat_namespace = $3`,
        [cleanedName, rename.actorId, chatNamespace]
      );

      await client.query(
        `UPDATE actor_identities
            SET canonical_name = $1,
                updated_at = now()
          WHERE actor_id = $2::uuid
            AND chat_namespace = $3`,
        [cleanedName, rename.actorId, chatNamespace]
      );
    }

    if (deleteIds.length > 0) {
      const deletedMemory = await client.query(
        `WITH target AS (
           SELECT DISTINCT memory_item_id
             FROM canonical_messages
            WHERE chat_namespace = $1
              AND actor_id = ANY($2::uuid[])
         ),
         deleted AS (
           DELETE FROM memory_items
            WHERE id IN (SELECT memory_item_id FROM target)
            RETURNING id
         )
         SELECT COUNT(*)::int AS n FROM deleted`,
        [chatNamespace, deleteIds]
      );
      stats.deletedMemoryItemsByList = Number(deletedMemory.rows[0]?.n ?? 0);

      const deletedAliases = await client.query(
        `DELETE FROM actor_aliases
          WHERE actor_id = ANY($1::uuid[])
            AND chat_namespace = $2`,
        [deleteIds, chatNamespace]
      );
      stats.deletedAliasesByList = deletedAliases.rowCount ?? 0;

      await client.query(
        `DELETE FROM actor_identities
          WHERE actor_id = ANY($1::uuid[])`,
        [deleteIds]
      );

      const deletedActors = await client.query(
        `DELETE FROM actors
          WHERE actor_id = ANY($1::uuid[])`,
        [deleteIds]
      );
      stats.deletedActorsByList = deletedActors.rowCount ?? 0;
    }

    await client.query("COMMIT");

    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify(
        {
          ok: true,
          mode: "apply",
          preview,
          stats
        },
        null,
        2
      )
    );
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

main()
  .catch((error) => {
    // eslint-disable-next-line no-console
    console.error("v2 actor review apply failed:", error);
    process.exit(1);
  })
  .finally(async () => {
    await pool.end();
  });
