import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { PoolClient } from "pg";
import { pool } from "../db.js";
import { ensureExtendedSchema } from "../schema.js";

type PronounSet = {
  subject: string;
  object: string;
  possessive: string;
  confidence: number;
  source: string;
  rationale: string;
};

type ReviewDecision = {
  actorId: string;
  actorName: string;
  review: string;
  sourceFile: string;
};

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

function csvCell(value: string | number | null | undefined): string {
  const raw = value == null ? "" : String(value);
  if (/[",\n\r]/.test(raw)) return `"${raw.replace(/"/g, "\"\"")}"`;
  return raw;
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
    if (ch === "\"") {
      inQuotes = true;
    } else if (ch === ",") {
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
  const raw = readFileSync(resolve(pathValue), "utf8").replace(/^\uFEFF/, "");
  const rows = parseCsv(raw);
  if (rows.length === 0) return [];
  const header = rows[0].map((value) => String(value ?? "").trim());
  const idIdx = header.findIndex((value) => value === "id");
  const nameIdx = header.findIndex((value) => value === "actor_name");
  const reviewIdx = header.findIndex((value) => value === "review");
  if (idIdx < 0 || nameIdx < 0 || reviewIdx < 0) {
    throw new Error(`Review sheet ${pathValue} must contain columns id, actor_name, review`);
  }
  return rows.slice(1).map((cols) => ({
    actorId: String(cols[idIdx] ?? "").trim().toLowerCase(),
    actorName: String(cols[nameIdx] ?? "").trim(),
    review: String(cols[reviewIdx] ?? "").trim().toLowerCase(),
    sourceFile: pathValue
  })).filter((row) => /^[0-9a-f-]{36}$/.test(row.actorId));
}

function toPronouns(review: string, actorName: string): PronounSet {
  switch (review) {
    case "m":
      return {
        subject: "he",
        object: "him",
        possessive: "his",
        confidence: 1,
        source: "owner_review",
        rationale: `Owner-reviewed actor pronoun for ${actorName}: male.`
      };
    case "f":
      return {
        subject: "she",
        object: "her",
        possessive: "her",
        confidence: 1,
        source: "owner_review",
        rationale: `Owner-reviewed actor pronoun for ${actorName}: female.`
      };
    case "i":
      return {
        subject: "it",
        object: "it",
        possessive: "its",
        confidence: 1,
        source: "owner_review",
        rationale: `Owner-reviewed actor pronoun for ${actorName}: non-person / it.`
      };
    default:
      return {
        subject: "they",
        object: "them",
        possessive: "their",
        confidence: 1,
        source: "owner_review",
        rationale: `Owner-reviewed actor pronoun for ${actorName}: ambiguous or neutral.`
      };
  }
}

async function mergeActor(
  client: PoolClient,
  chatNamespace: string,
  winnerId: string,
  loserId: string
): Promise<{
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

  await client.query(`DELETE FROM actor_identities WHERE actor_id = $1::uuid`, [loserId]);

  const deleted = await client.query(`DELETE FROM actors WHERE actor_id = $1::uuid`, [loserId]);

  return {
    canonicalMoved: canonical.rowCount ?? 0,
    evidenceMoved: evidence.rowCount ?? 0,
    aliasesMoved: aliases.rowCount ?? 0,
    contextsMoved: contexts.rowCount ?? 0,
    sourceProfilesMoved: sourceProfiles.rowCount ?? 0,
    loserDeleted: deleted.rowCount ?? 0
  };
}

async function findSystemActorId(client: PoolClient, chatNamespace: string): Promise<string> {
  const result = await client.query<{ actor_id: string }>(
    `SELECT ac.actor_id::text AS actor_id
       FROM actor_context ac
       JOIN actors a ON a.actor_id = ac.actor_id
      WHERE ac.chat_namespace = $1
        AND ac.actor_type = 'system'
        AND a.normalized_name = 'whatsapp system'
      LIMIT 1`,
    [chatNamespace]
  );
  if (result.rowCount === 0) {
    throw new Error(`Could not find canonical WhatsApp system actor in ${chatNamespace}`);
  }
  return String(result.rows[0].actor_id);
}

async function main(): Promise<void> {
  await ensureExtendedSchema();

  const argv = process.argv.slice(2);
  const lowPath = getArg(argv, "low", "generated/actor_pronoun_review/low_confidence_actor_pronouns_review_sheet.csv");
  const theyPath = getArg(argv, "they", "generated/actor_pronoun_review/they_actor_pronouns_review_sheet.csv");
  const chatNamespace = getArg(argv, "chatNamespace", "personal.main");

  const merged = new Map<string, ReviewDecision>();
  for (const row of [...loadReviewFile(lowPath), ...loadReviewFile(theyPath)]) {
    const existing = merged.get(row.actorId);
    if (!existing) {
      merged.set(row.actorId, row);
      continue;
    }
    const existingExplicit = ["m", "f", "i", "w"].includes(existing.review);
    const rowExplicit = ["m", "f", "i", "w"].includes(row.review);
    if (!existingExplicit && rowExplicit) {
      merged.set(row.actorId, row);
    }
  }

  const client = await pool.connect();
  let updated = 0;
  const counts = { m: 0, f: 0, i: 0, w: 0, blank: 0 };
  let whatsappMerged = 0;
  let whatsappCanonicalMoved = 0;
  let whatsappSourceProfilesMoved = 0;
  let whatsappAliasesMoved = 0;
  let whatsappEvidenceMoved = 0;
  let explicitMerges = 0;
  let explicitMergeCanonicalMoved = 0;

  try {
    await client.query("BEGIN");
    const whatsappSystemActorId = await findSystemActorId(client, chatNamespace);

    for (const row of merged.values()) {
      if (row.review === "w") {
        const result = await mergeActor(client, chatNamespace, whatsappSystemActorId, row.actorId);
        whatsappMerged += result.loserDeleted;
        whatsappCanonicalMoved += result.canonicalMoved;
        whatsappSourceProfilesMoved += result.sourceProfilesMoved;
        whatsappAliasesMoved += result.aliasesMoved;
        whatsappEvidenceMoved += result.evidenceMoved;
        counts.w += 1;
        continue;
      }

      const pronouns = toPronouns(row.review, row.actorName);
      const result = await client.query(
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
          row.actorId,
          pronouns.subject,
          pronouns.object,
          pronouns.possessive,
          pronouns.confidence,
          pronouns.source,
          pronouns.rationale
        ]
      );
      updated += result.rowCount ?? 0;
      if (row.review === "m") counts.m += 1;
      else if (row.review === "f") counts.f += 1;
      else if (row.review === "i") counts.i += 1;
      else counts.blank += 1;
    }

    const explicitMergeSource = await client.query<{ actor_id: string; canonical_name: string }>(
      `SELECT actor_id::text, canonical_name
         FROM actors
        WHERE actor_id = '6b929ca7-0b8a-41ca-a0db-d725ae6c2d46'::uuid`
    );
    const explicitMergeTarget = await client.query<{ actor_id: string; canonical_name: string }>(
      `SELECT actor_id::text, canonical_name
         FROM actors
        WHERE actor_id = '273b942d-5b63-4e98-961d-ce63f77b8b68'::uuid`
    );
    if ((explicitMergeSource.rowCount ?? 0) > 0 && (explicitMergeTarget.rowCount ?? 0) > 0) {
      const result = await mergeActor(
        client,
        chatNamespace,
        '273b942d-5b63-4e98-961d-ce63f77b8b68',
        '6b929ca7-0b8a-41ca-a0db-d725ae6c2d46'
      );
      explicitMerges += result.loserDeleted;
      explicitMergeCanonicalMoved += result.canonicalMoved;
      const cleanedTarget = cleanDisplayName("Marinete");
      const normalizedTarget = normalizeActorName("Marinete");
      await client.query(
        `UPDATE actors
            SET canonical_name = $1,
                normalized_name = $2,
                updated_at = now()
          WHERE actor_id = $3::uuid`,
        [cleanedTarget, normalizedTarget, '273b942d-5b63-4e98-961d-ce63f77b8b68']
      );
      await client.query(
        `DELETE FROM actor_context loser
          USING actor_context winner
         WHERE loser.actor_id = $2::uuid
           AND winner.actor_id = $2::uuid
           AND loser.chat_namespace = $3
           AND winner.chat_namespace = $3
           AND loser.actor_type = winner.actor_type
           AND regexp_replace(replace(replace(loser.canonical_name, chr(160), ' '), chr(8239), ' '), '^[~[:space:]]+', '') <> $1
           AND regexp_replace(replace(replace(winner.canonical_name, chr(160), ' '), chr(8239), ' '), '^[~[:space:]]+', '') = $1`,
        [cleanedTarget, '273b942d-5b63-4e98-961d-ce63f77b8b68', chatNamespace]
      );
      await client.query(
        `UPDATE actor_context
            SET canonical_name = $1,
                updated_at = now()
          WHERE actor_id = $2::uuid
            AND chat_namespace = $3
            AND regexp_replace(replace(replace(canonical_name, chr(160), ' '), chr(8239), ' '), '^[~[:space:]]+', '') <> $1`,
        [cleanedTarget, '273b942d-5b63-4e98-961d-ce63f77b8b68', chatNamespace]
      );
      await client.query(
        `UPDATE actor_identities
            SET canonical_name = $1,
                updated_at = now()
          WHERE actor_id = $2::uuid
            AND chat_namespace = $3`,
        [cleanedTarget, '273b942d-5b63-4e98-961d-ce63f77b8b68', chatNamespace]
      );
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }

  console.log(JSON.stringify({
    ok: true,
    updated,
    actorCount: merged.size,
    counts,
    chatNamespace,
    whatsappMerged,
    whatsappCanonicalMoved,
    whatsappSourceProfilesMoved,
    whatsappAliasesMoved,
    whatsappEvidenceMoved,
    explicitMerges,
    explicitMergeCanonicalMoved,
    sources: [lowPath, theyPath]
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
