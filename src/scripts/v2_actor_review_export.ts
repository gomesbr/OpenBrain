import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pool } from "../db.js";
import { ensureExtendedSchema } from "../schema.js";

interface ActorRow {
  actorId: string;
  chatNamespace: string;
  actorType: string;
  canonicalName: string;
  confidence: number;
  primarySource: string | null;
  sourceSystems: string[];
  messageCount: number;
  firstSeen: string | null;
  lastSeen: string | null;
  aliases: string[];
  phoneNumbers: string[];
  flags: string[];
}

interface EvidenceSample {
  actorId: string;
  canonicalId: string;
  sourceSystem: string;
  conversationId: string | null;
  sourceMessageId: string | null;
  observedAt: string | null;
  excerpt: string;
}

function getArg(argv: string[], name: string, fallback: string): string {
  const full = `--${name}=`;
  for (const token of argv) {
    if (token.startsWith(full)) return token.slice(full.length).trim() || fallback;
  }
  return fallback;
}

function toNumber(value: unknown, fallback: number): number {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function normalizeName(value: string): string {
  return String(value ?? "")
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
  const text = String(value ?? "")
    .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "")
    .replace(/[\u2010-\u2015\u2212\u2011\u2043]/g, "-")
    .replace(/\u00A0/g, " ");
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

function csvCell(value: string | number | null | undefined): string {
  const raw = value == null ? "" : String(value);
  if (/[",\n\r]/.test(raw)) return `"${raw.replace(/"/g, "\"\"")}"`;
  return raw;
}

function parseUuidSet(raw: string): Set<string> {
  const matches = raw.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) ?? [];
  return new Set(matches.map((id) => id.toLowerCase()));
}

function toCsv(rows: Array<Record<string, unknown>>, columns: string[]): string {
  const header = columns.join(",");
  const body = rows.map((row) => columns.map((col) => csvCell(row[col] as any)).join(",")).join("\n");
  return `${header}\n${body}\n`;
}

function inferFlags(actor: {
  actorType: string;
  canonicalName: string;
  messageCount: number;
  sourceSystems: string[];
}): string[] {
  const flags = new Set<string>();
  const name = String(actor.canonicalName ?? "").trim();
  const normalized = normalizeName(name);
  const tokenCount = normalized ? normalized.split(" ").filter(Boolean).length : 0;

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
  return Array.from(flags);
}

async function loadActorAliases(chatNamespace: string): Promise<Map<string, string[]>> {
  const rows = await pool.query<{ actor_id: string; aliases: string[] }>(
    `SELECT actor_id::text AS actor_id, array_agg(alias ORDER BY alias) AS aliases
       FROM actor_aliases
      WHERE chat_namespace = $1
      GROUP BY actor_id`,
    [chatNamespace]
  );

  const out = new Map<string, string[]>();
  for (const row of rows.rows) {
    out.set(String(row.actor_id), Array.isArray(row.aliases) ? row.aliases.map(String) : []);
  }
  return out;
}

async function loadSampleMessages(chatNamespace: string, samplePerActor: number): Promise<Map<string, EvidenceSample[]>> {
  const rows = await pool.query<{
    actor_id: string;
    canonical_id: string;
    source_system: string;
    conversation_id: string | null;
    source_message_id: string | null;
    observed_at: string | null;
    excerpt: string;
    rn: number;
  }>(
    `WITH ranked AS (
       SELECT
         c.actor_id::text AS actor_id,
         c.id::text AS canonical_id,
         c.source_system,
         c.conversation_id,
         c.source_message_id,
         c.observed_at::text AS observed_at,
         left(m.content, 240) AS excerpt,
         row_number() OVER (
           PARTITION BY c.actor_id
           ORDER BY c.observed_at DESC NULLS LAST, c.id DESC
         ) AS rn
       FROM canonical_messages c
       JOIN memory_items m ON m.id = c.memory_item_id
       WHERE c.chat_namespace = $1
         AND c.actor_id IS NOT NULL
     )
     SELECT actor_id, canonical_id, source_system, conversation_id, source_message_id, observed_at, excerpt, rn
       FROM ranked
      WHERE rn <= $2
      ORDER BY actor_id, rn`,
    [chatNamespace, samplePerActor]
  );

  const out = new Map<string, EvidenceSample[]>();
  for (const row of rows.rows) {
    const key = String(row.actor_id);
    const existing = out.get(key) ?? [];
    existing.push({
      actorId: key,
      canonicalId: String(row.canonical_id),
      sourceSystem: String(row.source_system),
      conversationId: row.conversation_id ? String(row.conversation_id) : null,
      sourceMessageId: row.source_message_id ? String(row.source_message_id) : null,
      observedAt: row.observed_at ? String(row.observed_at) : null,
      excerpt: String(row.excerpt ?? "")
    });
    out.set(key, existing);
  }
  return out;
}

function findMergeCandidates(actors: ActorRow[]): Array<{
  mergeKey: string;
  actorIds: string[];
  names: string[];
  actorTypes: string[];
  messageCountTotal: number;
  sources: string[];
}> {
  const groups = new Map<string, ActorRow[]>();
  for (const actor of actors) {
    const key = compactKey(actor.canonicalName);
    if (!key || key.length < 3) continue;
    const bucket = groups.get(key) ?? [];
    bucket.push(actor);
    groups.set(key, bucket);
  }

  const out: Array<{
    mergeKey: string;
    actorIds: string[];
    names: string[];
    actorTypes: string[];
    messageCountTotal: number;
    sources: string[];
  }> = [];

  for (const [key, bucket] of groups) {
    const uniqueIds = Array.from(new Set(bucket.map((row) => row.actorId)));
    if (uniqueIds.length < 2) continue;
    out.push({
      mergeKey: key,
      actorIds: uniqueIds,
      names: Array.from(new Set(bucket.map((row) => row.canonicalName))),
      actorTypes: Array.from(new Set(bucket.map((row) => row.actorType))),
      messageCountTotal: bucket.reduce((sum, row) => sum + row.messageCount, 0),
      sources: Array.from(new Set(bucket.flatMap((row) => row.sourceSystems)))
    });
  }

  out.sort((a, b) => b.messageCountTotal - a.messageCountTotal);
  return out;
}

async function main(): Promise<void> {
  await ensureExtendedSchema();

  const chatNamespace = getArg(process.argv.slice(2), "chatNamespace", getArg(process.argv.slice(2), "chat", "personal.main"));
  const outDirArg = getArg(process.argv.slice(2), "outputDir", getArg(process.argv.slice(2), "out", "generated/actor_review"));
  const samplePerActor = Math.max(
    1,
    Math.min(10, toNumber(getArg(process.argv.slice(2), "samplesPerActor", getArg(process.argv.slice(2), "samples", "2")), 2))
  );
  const notSuspiciousFile = getArg(
    process.argv.slice(2),
    "notSuspiciousFile",
    getArg(process.argv.slice(2), "notSuspicious", "")
  );
  const outDir = resolve(outDirArg);
  mkdirSync(outDir, { recursive: true });

  const notSuspicious = notSuspiciousFile ? parseUuidSet(readFileSync(resolve(notSuspiciousFile), "utf8")) : new Set<string>();

  const actorsRaw = await pool.query<{
    actor_id: string;
    chat_namespace: string;
    actor_type: string;
    canonical_name: string;
    confidence: number;
    source: string | null;
    source_systems: string[] | null;
    message_count: string;
    first_seen: string | null;
    last_seen: string | null;
  }>(
    `SELECT
       ai.actor_id::text AS actor_id,
       ai.chat_namespace,
       ai.actor_type,
       ai.canonical_name,
       ai.confidence,
       ai.source,
       COALESCE(array_agg(DISTINCT c.source_system) FILTER (WHERE c.source_system IS NOT NULL), '{}'::text[]) AS source_systems,
       COUNT(c.id)::text AS message_count,
       MIN(c.observed_at)::text AS first_seen,
       MAX(c.observed_at)::text AS last_seen
     FROM actor_identities ai
     LEFT JOIN canonical_messages c ON c.actor_id = ai.actor_id
     WHERE ai.chat_namespace = $1
     GROUP BY ai.actor_id, ai.chat_namespace, ai.actor_type, ai.canonical_name, ai.confidence, ai.source
     ORDER BY COUNT(c.id) DESC, ai.canonical_name ASC`,
    [chatNamespace]
  );

  const aliasesByActor = await loadActorAliases(chatNamespace);
  const samplesByActor = await loadSampleMessages(chatNamespace, samplePerActor);

  const actors: ActorRow[] = actorsRaw.rows.map((row) => {
    const aliases = aliasesByActor.get(String(row.actor_id)) ?? [];
    const phoneSet = new Set<string>();
    for (const phone of extractPhonesFromText(String(row.canonical_name ?? ""))) phoneSet.add(phone);
    for (const alias of aliases) {
      for (const phone of extractPhonesFromText(alias)) phoneSet.add(phone);
    }

    const actor: ActorRow = {
      actorId: String(row.actor_id),
      chatNamespace: String(row.chat_namespace),
      actorType: String(row.actor_type),
      canonicalName: String(row.canonical_name),
      confidence: Number(row.confidence ?? 0),
      primarySource: row.source ? String(row.source) : null,
      sourceSystems: Array.isArray(row.source_systems) ? row.source_systems.map(String).filter(Boolean) : [],
      messageCount: Number(row.message_count ?? 0),
      firstSeen: row.first_seen ? String(row.first_seen) : null,
      lastSeen: row.last_seen ? String(row.last_seen) : null,
      aliases,
      phoneNumbers: Array.from(phoneSet),
      flags: []
    };
    actor.flags = inferFlags({
      actorType: actor.actorType,
      canonicalName: actor.canonicalName,
      messageCount: actor.messageCount,
      sourceSystems: actor.sourceSystems
    });
    return actor;
  });

  const merges = findMergeCandidates(actors);
  const suspicious = actors
    .filter((actor) => actor.flags.length > 0 && !notSuspicious.has(actor.actorId.toLowerCase()))
    .sort((a, b) => b.messageCount - a.messageCount);

  const generatedAt = new Date().toISOString();

  const actorsCsv = toCsv(
    actors.map((row) => ({
      actor_id: row.actorId,
      canonical_name: row.canonicalName,
      actor_type: row.actorType,
      chat_namespace: row.chatNamespace,
      confidence: row.confidence.toFixed(3),
      message_count: row.messageCount,
      first_seen: row.firstSeen ?? "",
      last_seen: row.lastSeen ?? "",
      primary_source: row.primarySource ?? "",
      source_systems: row.sourceSystems.join("|"),
      aliases: row.aliases.join("|"),
      phone_numbers: row.phoneNumbers.join("|"),
      flags: row.flags.join("|")
    })),
    [
      "actor_id",
      "canonical_name",
      "actor_type",
      "chat_namespace",
      "confidence",
      "message_count",
      "first_seen",
      "last_seen",
      "primary_source",
      "source_systems",
      "aliases",
      "phone_numbers",
      "flags"
    ]
  );

  const mergesCsv = toCsv(
    merges.map((row) => ({
      merge_key: row.mergeKey,
      actor_ids: row.actorIds.join("|"),
      names: row.names.join("|"),
      actor_types: row.actorTypes.join("|"),
      message_count_total: row.messageCountTotal,
      sources: row.sources.join("|")
    })),
    ["merge_key", "actor_ids", "names", "actor_types", "message_count_total", "sources"]
  );

  const suspiciousCsv = toCsv(
    suspicious.map((row) => ({
      actor_id: row.actorId,
      canonical_name: row.canonicalName,
      actor_type: row.actorType,
      message_count: row.messageCount,
      source_systems: row.sourceSystems.join("|"),
      phone_numbers: row.phoneNumbers.join("|"),
      flags: row.flags.join("|")
    })),
    ["actor_id", "canonical_name", "actor_type", "message_count", "source_systems", "phone_numbers", "flags"]
  );

  writeFileSync(join(outDir, "actors_full.csv"), actorsCsv, "utf8");
  writeFileSync(join(outDir, "actor_merge_candidates.csv"), mergesCsv, "utf8");
  writeFileSync(join(outDir, "actor_suspicious.csv"), suspiciousCsv, "utf8");
  writeFileSync(
    join(outDir, "actor_samples.json"),
    JSON.stringify(
      {
        generatedAt,
        chatNamespace,
        samplePerActor,
        samples: Object.fromEntries(samplesByActor.entries())
      },
      null,
      2
    ),
    "utf8"
  );

  const summary = {
    ok: true,
    generatedAt,
    chatNamespace,
    actorCount: actors.length,
    suspiciousCount: suspicious.length,
    notSuspiciousOverrideCount: notSuspicious.size,
    mergeCandidateGroups: merges.length,
    outDir
  };

  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  await pool.end();
}

main().catch(async (error) => {
  process.stderr.write(`v2 actor review export failed: ${String((error as Error)?.message ?? error)}\n`);
  try {
    await pool.end();
  } catch {
    // no-op
  }
  process.exit(1);
});
