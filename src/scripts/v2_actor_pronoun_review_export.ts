import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pool } from "../db.js";
import { ensureExtendedSchema } from "../schema.js";

type ReviewRow = {
  actor_id: string;
  chat_namespace: string;
  actor_type: string;
  canonical_name: string;
  actor_types: string[] | null;
  source_systems: string[] | null;
  message_count: string;
  subject: string | null;
  object: string | null;
  possessive: string | null;
  confidence: string | null;
  source: string | null;
  rationale: string | null;
  sample_messages: string[] | null;
};

type NormalizedReviewRow = {
  actorId: string;
  chatNamespace: string;
  canonicalName: string;
  actorType: string;
  actorTypes: string[];
  sourceSystems: string[];
  messageCount: number;
  pronouns: {
    subject: string | null;
    object: string | null;
    possessive: string | null;
  };
  confidence: number;
  source: string | null;
  rationale: string | null;
  sampleMessages: string[];
  flags: string[];
};

function getArg(argv: string[], name: string, fallback = ""): string {
  const prefix = `--${name}=`;
  for (const token of argv) {
    if (token.startsWith(prefix)) return token.slice(prefix.length).trim() || fallback;
  }
  return fallback;
}

function csvCell(value: string | number | null | undefined): string {
  const raw = value == null ? "" : String(value);
  if (/[",\n\r]/.test(raw)) return `"${raw.replace(/"/g, "\"\"")}"`;
  return raw;
}

function toCsv(rows: Array<Record<string, unknown>>, columns: string[]): string {
  const header = columns.join(",");
  const body = rows.map((row) => columns.map((col) => csvCell(row[col] as any)).join(",")).join("\n");
  return `${header}\n${body}\n`;
}

function stripDisplayNoise(value: string): string {
  return String(value ?? "")
    .replace(/^\uFEFF/, "")
    .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "")
    .replace(/\u00A0/g, " ")
    .replace(/^[~\s]+/u, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeName(value: string): string {
  return stripDisplayNoise(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function compactKey(value: string): string {
  return normalizeName(value).replace(/\d+/g, "").replace(/\s+/g, "");
}

function normalizePhone(raw: string): string | null {
  const trimmed = String(raw ?? "")
    .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "")
    .replace(/[\u2010-\u2015\u2212\u2011\u2043]/g, "-")
    .replace(/\u00A0/g, " ")
    .trim();
  if (!trimmed) return null;
  const plus = trimmed.startsWith("+");
  const digits = trimmed.replace(/\D+/g, "");
  if (digits.length < 10 || digits.length > 15) return null;
  return plus ? `+${digits}` : digits;
}

function extractPhonesFromText(value: string): string[] {
  const text = stripDisplayNoise(value);
  if (!text) return [];
  const matches = text.match(/(?:\+?\d[\d\-\(\)\s]{8,}\d)/g) ?? [];
  const out = new Set<string>();
  for (const match of matches) {
    const normalized = normalizePhone(match);
    if (normalized) out.add(normalized);
  }
  if (out.size === 0 && !/[A-Za-z]/.test(text)) {
    const normalizedWhole = normalizePhone(text);
    if (normalizedWhole) out.add(normalizedWhole);
  }
  return Array.from(out);
}

function inferFlags(actor: {
  actorType: string;
  canonicalName: string;
  messageCount: number;
  sourceSystems: string[];
  sampleMessages: string[];
}): string[] {
  const flags = new Set<string>();
  const name = stripDisplayNoise(actor.canonicalName);
  const normalized = normalizeName(name);
  const tokenCount = normalized ? normalized.split(" ").filter(Boolean).length : 0;
  const samplesJoined = actor.sampleMessages.join(" || ").toLowerCase();

  const fillerWords = new Set([
    "yes",
    "no",
    "ok",
    "okay",
    "haha",
    "ahah",
    "lol",
    "lmao",
    "bom",
    "mas",
    "pero",
    "vou",
    "sim",
    "this",
    "that",
    "you",
    "me",
    "we",
    "they",
    "couples",
    "neighbors"
  ]);

  if (!name) flags.add("empty_name");
  if (name.length <= 2) flags.add("very_short_name");
  if (!/[A-Za-z]/.test(name)) flags.add("no_alpha_chars");
  if (fillerWords.has(normalized)) flags.add("filler_like_token");
  if (tokenCount === 1 && normalized.length <= 4 && actor.messageCount < 4) flags.add("short_low_signal");
  if (actor.actorType === "contact" && actor.messageCount === 1) flags.add("single_message_contact");
  if (/^(openai|chatgpt|grok|codexclaw|whatsapp|system|assistant)$/i.test(normalized) && actor.actorType === "contact") {
    flags.add("source_name_as_contact");
  }
  if (actor.sourceSystems.length === 1 && actor.sourceSystems[0] === "whatsapp" && tokenCount === 1 && normalized.length <= 3) {
    flags.add("whatsapp_single_token_name");
  }
  if (extractPhonesFromText(name).length > 0 && !/[A-Za-z]/.test(name)) {
    flags.add("phone_only_name");
  }
  if (/[~]/.test(String(actor.canonicalName ?? ""))) {
    flags.add("tilde_prefixed_alias");
  }
  if (
    /\b(team|group|fam|family|crew|colleagues|latinos)\b/i.test(name) ||
    /\s(?:e|and|&)\s/i.test(name) ||
    /you created group|removed .* from the group|added .* to the group/i.test(samplesJoined)
  ) {
    flags.add("group_like_name");
  }
  return Array.from(flags);
}

function shouldExcludeFromPronounReview(row: NormalizedReviewRow): boolean {
  const severeFlags = new Set([
    "empty_name",
    "no_alpha_chars",
    "filler_like_token",
    "source_name_as_contact",
    "whatsapp_single_token_name",
    "phone_only_name",
    "group_like_name"
  ]);
  if (row.flags.some((flag) => severeFlags.has(flag))) return true;
  if (row.flags.includes("single_message_contact") && row.flags.includes("short_low_signal")) return true;
  if (row.flags.includes("tilde_prefixed_alias") && row.messageCount <= 1) return true;
  return false;
}

async function loadReviewRows(chatNamespace: string): Promise<ReviewRow[]> {
  const result = await pool.query<ReviewRow>(`
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
              AND cm2.chat_namespace = $1
              AND cm2.artifact_state = 'published'
              AND cm2.content_normalized IS NOT NULL
              AND length(trim(cm2.content_normalized)) >= 24
            ORDER BY COALESCE(cm2.quality_score, 0) DESC, cm2.observed_at DESC NULLS LAST
            LIMIT 4
          ) compact
        ) AS sample_messages
      FROM actors a
      JOIN actor_context ai
        ON ai.actor_id = a.actor_id
       AND ai.chat_namespace = $1
      LEFT JOIN canonical_messages cm
        ON cm.actor_id = a.actor_id
       AND cm.chat_namespace = $1
       AND cm.artifact_state = 'published'
      GROUP BY a.actor_id
    )
    SELECT
      a.actor_id::text,
      $1::text AS chat_namespace,
      MIN(ai.actor_type) AS actor_type,
      regexp_replace(a.canonical_name, '^[~\s]+', '') AS canonical_name,
      COALESCE(at.actor_types, ARRAY[]::text[]) AS actor_types,
      COALESCE(array_agg(DISTINCT cm.source_system) FILTER (WHERE cm.source_system IS NOT NULL), '{}'::text[]) AS source_systems,
      COALESCE(sm.message_count, 0)::text AS message_count,
      a.metadata->'pronouns'->>'subject' AS subject,
      a.metadata->'pronouns'->>'object' AS object,
      a.metadata->'pronouns'->>'possessive' AS possessive,
      a.metadata->'pronouns'->>'confidence' AS confidence,
      a.metadata->'pronouns'->>'source' AS source,
      a.metadata->'pronouns'->>'rationale' AS rationale,
      sm.sample_messages
    FROM actors a
    JOIN actor_context ai
      ON ai.actor_id = a.actor_id
     AND ai.chat_namespace = $1
    LEFT JOIN actor_types at ON at.actor_id = ai.actor_id
    LEFT JOIN sample_messages sm ON sm.actor_id = ai.actor_id
    LEFT JOIN canonical_messages cm
      ON cm.actor_id = a.actor_id
     AND cm.chat_namespace = ai.chat_namespace
     AND cm.artifact_state = 'published'
    WHERE a.metadata ? 'pronouns'
    GROUP BY
      a.actor_id,
      a.canonical_name,
      at.actor_types,
      sm.message_count,
      sm.sample_messages,
      a.metadata
    ORDER BY a.canonical_name ASC
  `, [chatNamespace]);
  return result.rows;
}

function normalizeRow(row: ReviewRow): NormalizedReviewRow {
  const sampleMessages = Array.isArray(row.sample_messages)
    ? row.sample_messages.map((message) => stripDisplayNoise(String(message ?? ""))).filter(Boolean)
    : [];
  const normalized: NormalizedReviewRow = {
    actorId: String(row.actor_id),
    chatNamespace: String(row.chat_namespace),
    canonicalName: stripDisplayNoise(String(row.canonical_name ?? "")),
    actorType: String(row.actor_type ?? ""),
    actorTypes: Array.isArray(row.actor_types) ? row.actor_types.map(String).filter(Boolean) : [],
    sourceSystems: Array.isArray(row.source_systems) ? row.source_systems.map(String).filter(Boolean) : [],
    messageCount: Number(row.message_count ?? 0) || 0,
    pronouns: {
      subject: row.subject,
      object: row.object,
      possessive: row.possessive
    },
    confidence: Number(row.confidence ?? 0) || 0,
    source: row.source,
    rationale: row.rationale,
    sampleMessages,
    flags: []
  };
  normalized.flags = inferFlags({
    actorType: normalized.actorType,
    canonicalName: normalized.canonicalName,
    messageCount: normalized.messageCount,
    sourceSystems: normalized.sourceSystems,
    sampleMessages: normalized.sampleMessages
  });
  return normalized;
}

function dedupeByCompactKey(rows: NormalizedReviewRow[]): NormalizedReviewRow[] {
  const bestByKey = new Map<string, NormalizedReviewRow>();
  for (const row of rows) {
    const key = compactKey(row.canonicalName);
    if (!key) continue;
    const existing = bestByKey.get(key);
    if (!existing) {
      bestByKey.set(key, row);
      continue;
    }
    const rowScore = row.messageCount * 100 + row.confidence * 10 - row.flags.length;
    const existingScore = existing.messageCount * 100 + existing.confidence * 10 - existing.flags.length;
    if (rowScore > existingScore) {
      bestByKey.set(key, row);
    }
  }
  return Array.from(bestByKey.values());
}

async function main(): Promise<void> {
  await ensureExtendedSchema();

  const chatNamespace = getArg(process.argv.slice(2), "chatNamespace", getArg(process.argv.slice(2), "chat", "personal.main"));
  const outputDir = getArg(process.argv.slice(2), "outputDir", resolve(process.cwd(), "generated", "actor_pronoun_review"));
  const rows = await loadReviewRows(chatNamespace);
  const normalized = rows.map(normalizeRow);
  const cleaned = dedupeByCompactKey(normalized.filter((row) => !shouldExcludeFromPronounReview(row)));

  const lowConfidence = cleaned
    .filter((row) => row.confidence < 0.5)
    .sort((a, b) => Number(a.confidence ?? 0) - Number(b.confidence ?? 0) || String(a.canonicalName).localeCompare(String(b.canonicalName)));
  const theyActors = cleaned
    .filter((row) => String(row.pronouns.subject ?? "") === "they")
    .sort((a, b) => Number(a.confidence ?? 0) - Number(b.confidence ?? 0) || String(a.canonicalName).localeCompare(String(b.canonicalName)));

  const outDir = resolve(outputDir);
  mkdirSync(outDir, { recursive: true });

  const lowConfidenceJson = join(outDir, "low_confidence_actor_pronouns.json");
  const lowConfidenceCsv = join(outDir, "low_confidence_actor_pronouns.csv");
  const theyJson = join(outDir, "they_actor_pronouns.json");
  const theyCsv = join(outDir, "they_actor_pronouns.csv");

  writeFileSync(lowConfidenceJson, `${JSON.stringify(lowConfidence, null, 2)}\n`, "utf8");
  writeFileSync(theyJson, `${JSON.stringify(theyActors, null, 2)}\n`, "utf8");

  const csvColumns = ["actorId", "canonicalName", "actorTypes", "messageCount", "subject", "object", "possessive", "confidence", "source", "rationale", "flags", "sampleMessages"];
  const toCsvRows = (items: NormalizedReviewRow[]) =>
    items.map((row) => ({
      actorId: row.actorId,
      canonicalName: row.canonicalName,
      actorTypes: row.actorTypes.join(" | "),
      messageCount: row.messageCount,
      subject: row.pronouns.subject ?? "",
      object: row.pronouns.object ?? "",
      possessive: row.pronouns.possessive ?? "",
      confidence: row.confidence,
      source: row.source,
      rationale: row.rationale,
      flags: row.flags.join(" | "),
      sampleMessages: row.sampleMessages.join(" || ")
    }));
  writeFileSync(lowConfidenceCsv, toCsv(toCsvRows(lowConfidence), csvColumns), "utf8");
  writeFileSync(theyCsv, toCsv(toCsvRows(theyActors), csvColumns), "utf8");

  console.log(JSON.stringify({
    ok: true,
    chatNamespace,
    rawCount: normalized.length,
    cleanedCount: cleaned.length,
    lowConfidenceCount: lowConfidence.length,
    theyCount: theyActors.length,
    files: {
      lowConfidenceJson,
      lowConfidenceCsv,
      theyJson,
      theyCsv
    }
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
