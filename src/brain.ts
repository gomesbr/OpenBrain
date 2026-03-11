import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import { pool } from "./db.js";
import { getEmbedding } from "./embedding_provider.js";
import {
  computeFinanceSignal,
  detectQueryIntent,
  extractMoneyAmounts,
  hasMoneyAmount,
  isPersonalFinanceEvidenceCandidate,
  isBalanceEvidenceCandidate,
  summarizeFinanceBalance
} from "./finance_intent.js";
import { parseTemporalIntent, temporalRelevance, timestampInHardRange } from "./query_time.js";
import { expandLexicalTokens, toSemanticEmbeddingText } from "./semantic_text.js";
import {
  applyPrivacyToCharts,
  applyPrivacyToEvidence,
  applyPrivacyToGraph,
  applyPrivacyToInsights,
  redactText
} from "./privacy.js";
import type {
  BrainInsight,
  BrainJobStatus,
  BrainQueryRequest,
  BrainQueryResponse,
  ChartPayload,
  ConfidenceScore,
  EvidenceRef,
  FeedbackRecord,
  GraphPayload,
  PrivacyMode
} from "./types.js";

type Domain =
  | "identity"
  | "relationships"
  | "behavior"
  | "health"
  | "diet"
  | "work"
  | "finance"
  | "mood"
  | "timeline"
  | "other";

interface MemoryRow {
  id: string;
  content: string;
  role: string;
  source_system: string;
  source_conversation_id: string | null;
  source_timestamp: string | null;
  chat_namespace: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

interface PendingJobItem {
  id: number;
  job_id: string;
  memory_item_id: string | null;
}

const NAME_RE = /\b[A-Z][a-z]{2,}(?:\s[A-Z][a-z]{2,})?\b/g;
const STOP_NAMES = new Set([
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
  "WhatsApp",
  "ChatGPT",
  "Grok"
]);

const NON_PERSON_TOKENS = new Set([
  "the",
  "this",
  "that",
  "these",
  "those",
  "and",
  "or",
  "but",
  "if",
  "just",
  "let",
  "can",
  "what",
  "when",
  "where",
  "why",
  "how",
  "yes",
  "no",
  "ok",
  "okay",
  "yeah",
  "yep",
  "ahh",
  "ahhh",
  "haha",
  "hahaha",
  "hehe",
  "lol",
  "lmao",
  "vou",
  "por",
  "pra",
  "pero",
  "que",
  "si",
  "isso",
  "esta",
  "gracias",
  "felicidades",
  "couples",
  "neighbors",
  "allstars",
  "amex"
]);

let workerTimer: NodeJS.Timeout | null = null;
let workerRunning = false;

function normalizeName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s_-]+/g, "")
    .replace(/\s+/g, " ");
}

const OWNER_NAME_NORMALIZED = normalizeName(config.ownerName);
const OWNER_ALIASES = new Set(
  [config.ownerName, ...config.ownerAliases]
    .map((item) => normalizeName(item))
    .filter((item) => item.length > 0)
);
OWNER_ALIASES.add(OWNER_NAME_NORMALIZED);

function isOwnerAlias(name: string): boolean {
  const normalized = normalizeName(name);
  if (!normalized) return false;
  if (OWNER_ALIASES.has(normalized)) return true;
  if (OWNER_NAME_NORMALIZED && OWNER_NAME_NORMALIZED.split(" ").length === 1) {
    return normalized.startsWith(`${OWNER_NAME_NORMALIZED} `);
  }
  return false;
}

function parseWhatsappConversationLabel(sourceConversationId: string | null | undefined): string | null {
  if (!sourceConversationId) return null;
  const patterns = [
    /whatsapp chat - (.+?)(?:\.zip)?___chat$/i,
    /whatsapp chat with (.+?)(?:\.zip)?___chat$/i,
    /whatsapp chat - (.+)$/i
  ];
  for (const pattern of patterns) {
    const match = sourceConversationId.match(pattern);
    if (match?.[1]) {
      return match[1].replace(/_/g, " ").trim();
    }
  }
  return sourceConversationId;
}

function isLikelyGroupLabel(label: string): boolean {
  const text = label.toLowerCase();
  return /\b(group|team|squad|community|fam|gang|crew|dojo|circle|pr)\b/.test(text);
}

const DOMAIN_SET: Domain[] = [
  "identity",
  "relationships",
  "behavior",
  "health",
  "diet",
  "work",
  "finance",
  "mood",
  "other"
];

interface DomainCandidate {
  domain: Domain;
  score: number;
  reasons: string[];
}

function inferDomainFromText(text: string): Domain {
  if (/(money|finance|invest|expense|income|budget|loan|mortgage|salary|payment|bank|credit|rent|tax)/.test(text)) return "finance";
  if (/(diet|food|eat|calorie|protein|carb|meal|nutrition|fasting|dinner|lunch|breakfast)/.test(text)) return "diet";
  if (/(doctor|medicine|symptom|blood|health|clinic|hospital|pain|injury|therapy|diagnosis)/.test(text)) return "health";
  if (/(sleep|mood|stress|anx|happy|sad|mental|emotion|overwhelm|burnout)/.test(text)) return "mood";
  if (/(habit|routine|discipline|consisten|streak|practice|tracking|chore|clean|fix|repair|maintenance)/.test(text)) return "behavior";
  if (/(project|client|deadline|meeting|career|office|invoice|contract|repo|pull request|deployment|ticket|sprint)/.test(text)) return "work";
  if (/(identity|personality|belief|value|purpose|self-image|who am i|self)/.test(text)) return "identity";
  if (/(wife|husband|friend|family|brother|sister|mom|dad|partner|kids|daughter|son|girlfriend|boyfriend)/.test(text)) return "relationships";
  return "other";
}

function addDomainScore(
  scores: Map<Domain, number>,
  reasons: Map<Domain, string[]>,
  domain: Domain,
  amount: number,
  reason: string
): void {
  const current = scores.get(domain) ?? 0;
  scores.set(domain, current + amount);
  const list = reasons.get(domain) ?? [];
  if (!list.includes(reason)) list.push(reason);
  reasons.set(domain, list);
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((x): x is string => typeof x === "string").map((x) => x.trim()).filter(Boolean);
}

function inferDomainCandidates(
  content: string,
  metadata: Record<string, unknown>,
  sourceSystem: string,
  sourceConversationId: string | null,
  detectedPeople: string[]
): DomainCandidate[] {
  const text = `${content}\n${JSON.stringify(metadata)}`.toLowerCase();
  const scores = new Map<Domain, number>();
  const reasons = new Map<Domain, string[]>();

  for (const domain of DOMAIN_SET) {
    scores.set(domain, 0);
    reasons.set(domain, []);
  }

  const add = (domain: Domain, amount: number, reason: string): void => {
    addDomainScore(scores, reasons, domain, amount, reason);
  };

  if (/(wife|husband|partner|family|friend|mom|dad|brother|sister|daughter|son)/.test(text)) {
    add("relationships", 0.85, "relationship_terms");
  }
  if (/(money|budget|invest|loan|salary|cash|income|expense|net worth|bank|credit)/.test(text)) {
    add("finance", 0.9, "finance_terms");
  }
  if (/(diet|meal|food|protein|calorie|nutrition|breakfast|lunch|dinner)/.test(text)) {
    add("diet", 0.85, "diet_terms");
  }
  if (/(doctor|medicine|health|symptom|hospital|clinic|pain|injury|therapy)/.test(text)) {
    add("health", 0.9, "health_terms");
  }
  if (/(mood|stress|anx|anxiety|happy|sad|mental|emotion|burnout|overwhelmed)/.test(text)) {
    add("mood", 0.8, "mood_terms");
  }
  if (/(habit|routine|discipline|streak|consisten|practice|tracking)/.test(text)) {
    add("behavior", 0.75, "habit_terms");
  }

  const professionalHit = /(client|deadline|meeting|repo|pull request|deployment|ticket|sprint|contract|office|invoice|career)/.test(text);
  const genericWorkVerb = /\bwork(ing|ed|s)?\b/.test(text);
  if (professionalHit) {
    add("work", 1.0, "professional_terms");
  } else if (genericWorkVerb) {
    add("work", 0.2, "generic_work_verb");
  }

  if (/(identity|personality|belief|values|purpose|who am i|self-image)/.test(text)) {
    add("identity", 0.75, "identity_terms");
  }

  if (/(house|home|kitchen|bathroom|garage|pipe|plumbing|laundry|clean|fix|repair|maintenance|yard|grocery|weather)/.test(text)) {
    add("behavior", 0.55, "home_chore_context");
    add("relationships", 0.25, "household_context");
  }

  if (detectedPeople.length > 0) {
    add("relationships", Math.min(0.6, 0.18 + detectedPeople.length * 0.08), "people_mentions");
  }

  if (sourceSystem === "whatsapp") {
    const label = parseWhatsappConversationLabel(sourceConversationId);
    if (label && !isLikelyGroupLabel(label)) {
      add("relationships", 0.9, "direct_chat_context");
    } else if (label && isLikelyGroupLabel(label)) {
      add("relationships", 0.35, "group_chat_context");
    }
  }

  const topics = toStringArray(metadata.topics);
  for (const topic of topics) {
    const topicDomain = inferDomainFromText(topic.toLowerCase());
    if (topicDomain !== "other") {
      add(topicDomain, 0.25, "metadata_topics");
    }
  }

  const metadataType = typeof metadata.type === "string" ? metadata.type.toLowerCase() : "";
  if (metadataType === "task") {
    add("behavior", 0.35, "metadata_task_type");
  }
  if (metadataType === "person_note") {
    add("relationships", 0.35, "metadata_person_note_type");
  }

  const ranked = DOMAIN_SET
    .map((domain) => ({
      domain,
      score: Number((scores.get(domain) ?? 0).toFixed(3)),
      reasons: reasons.get(domain) ?? []
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);

  if (ranked.length === 0) {
    return [{ domain: "other", score: 0.2, reasons: ["fallback_other"] }];
  }

  const top = ranked[0]?.score ?? 0;
  const cutoff = Math.max(0.3, top * 0.42);
  const shortlisted = ranked.filter((item) => item.score >= cutoff).slice(0, 3);
  if (shortlisted.length === 0) {
    return [ranked[0]];
  }
  return shortlisted;
}

function parseDateOrNow(value: string | null): Date {
  if (!value) return new Date();
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return new Date();
  const parsed = new Date(ms);
  const now = new Date();
  const maxFuture = new Date(now.getTime() + 48 * 60 * 60 * 1000);
  if (parsed > maxFuture) {
    return now;
  }
  return parsed;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") return {};
  return value as Record<string, unknown>;
}

function detectPeople(content: string, metadata: Record<string, unknown>, sourceConversationId: string | null): string[] {
  const names = new Set<string>();
  const contentKind = typeof metadata.content_kind === "string" ? metadata.content_kind : "";

  const isLikelyNoisePersonName = (value: string): boolean => {
    const raw = String(value ?? "").trim();
    if (!raw) return true;
    if (raw.length < 2 || raw.length > 48) return true;
    if (/https?:\/\//i.test(raw)) return true;

    const normalized = normalizeName(raw);
    if (!normalized) return true;
    if (NON_PERSON_TOKENS.has(normalized)) return true;
    if (/^(ha){2,}|(he){2,}|(hi){3,}|(ah){2,}$/.test(normalized)) return true;
    if (/^\d+$/.test(normalized)) return true;

    const parts = normalized.split(" ").filter(Boolean);
    if (parts.length > 4) return true;
    if (parts.length === 1 && parts[0].length <= 2) return true;
    return false;
  };

  const speaker = metadata.speaker;
  if (typeof speaker === "string" && speaker.trim() && !isLikelyNoisePersonName(speaker)) {
    names.add(speaker.trim());
  }

  const peopleRaw = metadata.people;
  if (Array.isArray(peopleRaw)) {
    for (const item of peopleRaw) {
      if (typeof item === "string" && item.trim() && !isLikelyNoisePersonName(item)) {
        names.add(item.trim());
      }
    }
  }

  const conversationLabel = parseWhatsappConversationLabel(sourceConversationId);
  if (conversationLabel && !isLikelyGroupLabel(conversationLabel) && !isLikelyNoisePersonName(conversationLabel)) {
    names.add(conversationLabel);
  }

  // Avoid noisy regex name extraction on highly structured content.
  if (contentKind !== "table" && contentKind !== "number_series") {
    const matches = content.match(NAME_RE) ?? [];
    for (const match of matches) {
      if (STOP_NAMES.has(match)) continue;
      if (isLikelyNoisePersonName(match)) continue;
      names.add(match.trim());
    }
  }

  return Array.from(names).slice(0, 12);
}

interface WeightedPerson {
  displayName: string;
  weight: number;
}

function canonicalPersonKey(displayName: string): string {
  const normalized = normalizeName(displayName);
  if (!normalized) return normalized;
  if (isOwnerAlias(displayName)) return OWNER_NAME_NORMALIZED;
  return normalized;
}

function mergePeopleRows(rows: Array<{ display_name: string; weight: number }>): WeightedPerson[] {
  const merged = new Map<string, WeightedPerson>();
  for (const row of rows) {
    const key = canonicalPersonKey(row.display_name);
    if (!key) continue;
    const existing = merged.get(key);
    if (existing) {
      existing.weight += Number(row.weight ?? 0);
      if (existing.displayName.length < row.display_name.length && !isOwnerAlias(existing.displayName)) {
        existing.displayName = row.display_name;
      }
      continue;
    }
    merged.set(key, {
      displayName: isOwnerAlias(row.display_name) ? config.ownerName : row.display_name,
      weight: Number(row.weight ?? 0)
    });
  }
  return Array.from(merged.values()).sort((a, b) => b.weight - a.weight);
}

function domainLabel(domain: string): string {
  switch (domain) {
    case "relationships":
      return "social";
    case "behavior":
      return "habits";
    case "diet":
      return "nutrition";
    default:
      return domain;
  }
}

function reclassifyTimelineDomain(storedDomain: string, text: string, metadata: Record<string, unknown>): string {
  const candidatesRaw = metadata.domainCandidates;
  if (Array.isArray(candidatesRaw) && candidatesRaw.length > 0) {
    const first = candidatesRaw[0];
    if (first && typeof first === "object" && typeof (first as { domain?: unknown }).domain === "string") {
      return String((first as { domain: string }).domain);
    }
  }
  if (storedDomain !== "work") return storedDomain;
  const inferred = inferDomainFromText(text.toLowerCase());
  if (inferred === "relationships" || inferred === "other") {
    const sourceConversationId = typeof metadata.sourceConversationId === "string"
      ? metadata.sourceConversationId
      : null;
    const label = parseWhatsappConversationLabel(sourceConversationId);
    if (label && !isLikelyGroupLabel(label)) {
      return "relationships";
    }
    return inferred;
  }
  return storedDomain;
}

async function getOrCreateEntity(
  chatNamespace: string,
  entityType: string,
  displayName: string,
  metadata: Record<string, unknown> = {}
): Promise<string> {
  const normalized = normalizeName(displayName);
  const row = await pool.query<{ id: string }>(
    `INSERT INTO brain_entities (chat_namespace, entity_type, normalized_name, display_name, metadata, weight)
     VALUES ($1, $2, $3, $4, $5::jsonb, 1)
     ON CONFLICT (chat_namespace, entity_type, normalized_name)
     DO UPDATE SET
       display_name = EXCLUDED.display_name,
       weight = brain_entities.weight + 1,
       metadata = brain_entities.metadata || EXCLUDED.metadata
     RETURNING id`,
    [chatNamespace, entityType, normalized, displayName, JSON.stringify(metadata)]
  );

  const id = row.rows[0]?.id;
  if (!id) throw new Error("Failed to upsert entity");

  await pool.query(
    `INSERT INTO brain_entity_aliases (chat_namespace, entity_type, alias_normalized, entity_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (chat_namespace, entity_type, alias_normalized)
     DO UPDATE SET entity_id = EXCLUDED.entity_id`,
    [chatNamespace, entityType, normalized, id]
  );

  return id;
}

async function upsertRelationship(
  chatNamespace: string,
  subjectEntityId: string,
  objectEntityId: string,
  relationType: string,
  seenAt: Date
): Promise<void> {
  await pool.query(
    `INSERT INTO brain_relationship_edges (
       chat_namespace, subject_entity_id, object_entity_id, relation_type, weight, interaction_count, first_seen_at, last_seen_at
     )
     VALUES ($1, $2, $3, $4, 1, 1, $5, $5)
     ON CONFLICT (chat_namespace, subject_entity_id, object_entity_id, relation_type)
     DO UPDATE SET
       weight = brain_relationship_edges.weight + 1,
       interaction_count = brain_relationship_edges.interaction_count + 1,
       first_seen_at = LEAST(COALESCE(brain_relationship_edges.first_seen_at, EXCLUDED.first_seen_at), EXCLUDED.first_seen_at),
       last_seen_at = GREATEST(COALESCE(brain_relationship_edges.last_seen_at, EXCLUDED.last_seen_at), EXCLUDED.last_seen_at)`,
    [chatNamespace, subjectEntityId, objectEntityId, relationType, seenAt.toISOString()]
  );
}

async function upsertRollup(
  day: string,
  chatNamespace: string,
  domain: Domain,
  metricKey: string,
  incrementBy: number
): Promise<void> {
  await pool.query(
    `INSERT INTO brain_daily_rollups (day, chat_namespace, domain, metric_key, metric_value)
     VALUES ($1::date, $2, $3, $4, $5)
     ON CONFLICT (day, chat_namespace, domain, metric_key)
     DO UPDATE SET metric_value = brain_daily_rollups.metric_value + EXCLUDED.metric_value`,
    [day, chatNamespace, domain, metricKey, incrementBy]
  );
}

async function storeFactAndEvidence(
  row: MemoryRow,
  domain: Domain,
  domainCandidates: DomainCandidate[],
  confidence: number,
  subjectEntityId: string | null,
  effectiveTimestampIso: string,
  valueText: string
): Promise<void> {
  const fact = await pool.query<{ id: string }>(
    `INSERT INTO brain_facts (
       chat_namespace, domain, fact_type, subject_entity_id, value_text, confidence, source_timestamp, content_hash, metadata
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, md5($8), $9::jsonb)
     RETURNING id`,
    [
      row.chat_namespace,
      domain,
      "message_observation",
      subjectEntityId,
      valueText,
      confidence,
      effectiveTimestampIso,
      row.content,
      JSON.stringify({
        sourceSystem: row.source_system,
        sourceConversationId: row.source_conversation_id,
        role: row.role,
        domainCandidates,
        conversationLabel: parseWhatsappConversationLabel(row.source_conversation_id)
      })
    ]
  );

  const factId = fact.rows[0]?.id;
  if (!factId) return;
  await pool.query(
    `INSERT INTO brain_fact_evidence (fact_id, memory_item_id, evidence_weight, excerpt)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (fact_id, memory_item_id) DO NOTHING`,
    [factId, row.id, confidence, row.content.slice(0, 400)]
  );
}

async function refreshSocialInsights(chatNamespace: string): Promise<void> {
  const topPeople = await pool.query<{ display_name: string; weight: number }>(
    `SELECT display_name, weight
       FROM brain_entities
      WHERE chat_namespace = $1
        AND entity_type = 'person'
        AND COALESCE((metadata->>'owner')::boolean, false) = false
      ORDER BY weight DESC
      LIMIT 32`,
    [chatNamespace]
  );

  const merged = mergePeopleRows(topPeople.rows).slice(0, 6);
  const peopleText = merged.map((r) => `${r.displayName} (${Math.round(r.weight)})`).join(", ");
  const summary = peopleText
    ? `Most referenced people: ${peopleText}.`
    : "Not enough relationship evidence yet.";

  await pool.query(
    `INSERT INTO brain_insight_snapshots (
       chat_namespace, insight_pack, insight_type, title, summary, confidence, action_text, payload
     )
     VALUES ($1, 'social_behavior', 'top_people', 'Top social circle', $2, $3, $4, $5::jsonb)
     ON CONFLICT (chat_namespace, insight_pack, insight_type)
     DO UPDATE SET
       title = EXCLUDED.title,
       summary = EXCLUDED.summary,
       confidence = EXCLUDED.confidence,
       action_text = EXCLUDED.action_text,
       payload = EXCLUDED.payload`,
    [
      chatNamespace,
      summary,
      merged.length >= 3 ? 0.78 : 0.52,
      "Check reciprocity with top contacts and schedule intentional catch-ups.",
      JSON.stringify({ people: merged })
    ]
  );
}

async function processMemoryItem(memoryItemId: string): Promise<void> {
  const data = await pool.query<MemoryRow>(
    `SELECT id, content, role, source_system, source_conversation_id, source_timestamp, chat_namespace, metadata, created_at
       FROM memory_items
      WHERE id = $1
      LIMIT 1`,
    [memoryItemId]
  );
  const row = data.rows[0];
  if (!row || !row.chat_namespace) return;

  const metadata = asRecord(row.metadata);
  const people = detectPeople(row.content, metadata, row.source_conversation_id).filter((name) => !isOwnerAlias(name));
  const domainCandidates = inferDomainCandidates(row.content, metadata, row.source_system, row.source_conversation_id, people);
  const primaryDomain = domainCandidates[0]?.domain ?? "other";
  const seenAt = parseDateOrNow(row.source_timestamp ?? row.created_at);
  const day = seenAt.toISOString().slice(0, 10);
  const ownerEntityId = await getOrCreateEntity(row.chat_namespace, "person", config.ownerName, {
    owner: true
  });

  for (const personName of people) {
    const personEntityId = await getOrCreateEntity(row.chat_namespace, "person", personName, { detectedFrom: "content" });
    await upsertRelationship(row.chat_namespace, ownerEntityId, personEntityId, "interaction", seenAt);
  }

  const confidence = Math.min(0.95, 0.45 + Math.min(people.length, 4) * 0.1);
  await storeFactAndEvidence(
    row,
    primaryDomain,
    domainCandidates,
    confidence,
    ownerEntityId,
    seenAt.toISOString(),
    row.content.slice(0, 600)
  );

  await upsertRollup(day, row.chat_namespace, primaryDomain, "messages_total", 1);
  await upsertRollup(day, row.chat_namespace, primaryDomain, `source_${row.source_system}`, 1);
  for (const candidate of domainCandidates) {
    await upsertRollup(day, row.chat_namespace, candidate.domain, "messages_weighted", candidate.score);
  }
  if (people.length > 0) {
    await upsertRollup(day, row.chat_namespace, "relationships", "person_mentions", people.length);
  }

  await refreshSocialInsights(row.chat_namespace);
}

async function claimPendingItems(limit: number): Promise<PendingJobItem[]> {
  const result = await pool.query<PendingJobItem>(
    `WITH to_claim AS (
       SELECT i.id
         FROM brain_job_items i
         JOIN brain_jobs j ON j.id = i.job_id
        WHERE i.status = 'pending'
          AND j.job_type = 'rebuild'
          AND j.status = 'running'
        ORDER BY j.created_at DESC, i.created_at ASC
        LIMIT $1
        FOR UPDATE SKIP LOCKED
     )
     UPDATE brain_job_items b
        SET status = 'running',
            attempt_count = b.attempt_count + 1,
            updated_at = now()
      WHERE b.id IN (SELECT id FROM to_claim)
      RETURNING b.id, b.job_id, b.memory_item_id`,
    [limit]
  );
  return result.rows;
}

async function repairInconsistentRebuildJobStatuses(): Promise<void> {
  await pool.query(
    `UPDATE brain_jobs j
        SET status = 'running',
            finished_at = NULL,
            updated_at = now()
      WHERE j.job_type = 'rebuild'
        AND j.status IN ('completed', 'failed', 'partial')
        AND EXISTS (
          SELECT 1
            FROM brain_job_items i
           WHERE i.job_id = j.id
             AND i.status IN ('pending', 'running')
        )`
  );
}

async function runWorkerTick(): Promise<void> {
  if (workerRunning) return;
  workerRunning = true;
  try {
    await repairInconsistentRebuildJobStatuses();
    const items = await claimPendingItems(40);
    for (const item of items) {
      try {
        if (item.memory_item_id) {
          await processMemoryItem(item.memory_item_id);
        }
        await pool.query(`UPDATE brain_job_items SET status = 'completed', updated_at = now() WHERE id = $1`, [item.id]);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await pool.query(
          `UPDATE brain_job_items
              SET status = 'failed',
                  error_text = $2,
                  updated_at = now()
            WHERE id = $1`,
          [item.id, message.slice(0, 500)]
        );
      }
    }
    await finalizeRebuildJobs();
  } finally {
    workerRunning = false;
  }
}

async function finalizeRebuildJobs(): Promise<void> {
  const running = await pool.query<{ id: string }>(
    `SELECT id
       FROM brain_jobs
      WHERE job_type = 'rebuild'
        AND status = 'running'`
  );

  for (const job of running.rows) {
    const counts = await pool.query<{ pending: string; running: string; failed: string }>(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'pending')::text AS pending,
         COUNT(*) FILTER (WHERE status = 'running')::text AS running,
         COUNT(*) FILTER (WHERE status = 'failed')::text AS failed
       FROM brain_job_items
      WHERE job_id = $1`,
      [job.id]
    );
    const row = counts.rows[0];
    const pending = Number(row?.pending ?? "0");
    const active = Number(row?.running ?? "0");
    const failed = Number(row?.failed ?? "0");

    if (pending === 0 && active === 0) {
      await pool.query(
        `UPDATE brain_jobs
            SET status = $2,
                finished_at = now(),
                updated_at = now()
          WHERE id = $1`,
        [job.id, failed > 0 ? "partial" : "completed"]
      );
    }
  }
}

export function startBrainWorker(): void {
  if (workerTimer) return;
  workerTimer = setInterval(() => {
    runWorkerTick().catch(() => {
      // ignore transient worker errors; status rows capture failures.
    });
  }, 5000);
  void runWorkerTick().catch(() => {
    // ignore transient worker errors; status rows capture failures.
  });
}

export function stopBrainWorker(): void {
  if (!workerTimer) return;
  clearInterval(workerTimer);
  workerTimer = null;
}

function queryWindow(timeframe: string | undefined): string {
  switch (timeframe) {
    case "7d":
      return "7 days";
    case "30d":
      return "30 days";
    case "90d":
      return "90 days";
    case "365d":
      return "365 days";
    default:
      return "3650 days";
  }
}

function tokenizeQuery(question: string): string[] {
  const stop = new Set([
    "the",
    "a",
    "an",
    "and",
    "or",
    "to",
    "is",
    "are",
    "i",
    "you",
    "my",
    "me",
    "of",
    "in",
    "for",
    "on",
    "at",
    "do",
    "did",
    "have",
    "has",
    "what",
    "how",
    "much",
    "who",
    "when",
    "where",
    "from",
    "send",
    "sent",
    "today",
    "yesterday",
    "tomorrow"
  ]);
  const base = question
    .toLowerCase()
    .split(/[^a-z0-9_]+/i)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3 && !stop.has(t))
    .slice(0, 10);
  return expandLexicalTokens(base);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasToken(text: string, token: string): boolean {
  const hay = String(text ?? "").toLowerCase();
  const t = String(token ?? "").toLowerCase();
  if (!t) return false;
  if (/^[a-z0-9_]+$/i.test(t)) {
    const re = new RegExp(`(^|[^a-z0-9_])${escapeRegex(t)}([^a-z0-9_]|$)`, "i");
    return re.test(hay);
  }
  return hay.includes(t);
}

interface EvidenceCandidate {
  id: string;
  content: string;
  role: string;
  source_system: string;
  source_conversation_id: string | null;
  chat_namespace: string | null;
  source_timestamp: string | null;
  metadata: Record<string, unknown> | null;
  vector_score: number;
  text_score: number;
  token_score: number;
}

interface QueryFacetHints {
  people: string[];
  quotedPhrases: string[];
  sourceSystems: string[];
  keywordSet: Set<string>;
}

function extractQueryFacetHints(question: string): QueryFacetHints {
  const lower = String(question ?? "").toLowerCase();
  const quotedPhrases = Array.from(question.matchAll(/"([^"]{2,80})"/g))
    .map((match) => String(match[1] ?? "").trim().toLowerCase())
    .filter(Boolean);
  const people = detectPeople(question, {}, null)
    .filter((name) => !isOwnerAlias(name))
    .map((name) => normalizeName(name))
    .filter(Boolean);
  const sourceSystems = [
    /\bwhatsapp\b/.test(lower) ? "whatsapp" : "",
    /\btelegram\b/.test(lower) ? "telegram" : "",
    /\bchatgpt\b/.test(lower) ? "chatgpt" : "",
    /\bgrok\b/.test(lower) ? "grok" : "",
    /\bopenai\b/.test(lower) ? "openai" : ""
  ].filter(Boolean);
  const keywordSet = new Set(
    tokenizeQuery(question)
      .map((token) => token.toLowerCase())
      .filter((token) => token.length >= 3)
  );
  return {
    people,
    quotedPhrases,
    sourceSystems,
    keywordSet
  };
}

function computeMetadataFacetScore(
  row: EvidenceCandidate,
  queryHints: QueryFacetHints,
  temporalIntent: ReturnType<typeof parseTemporalIntent>
): number {
  const metadata = asRecord(row.metadata);
  const people = new Set<string>();
  for (const item of detectPeople(row.content, metadata, row.source_conversation_id)) {
    const normalized = normalizeName(item);
    if (normalized) people.add(normalized);
  }
  for (const item of toStringArray(metadata.people)) {
    const normalized = normalizeName(item);
    if (normalized) people.add(normalized);
  }
  const topics = new Set(toStringArray(metadata.topics).map((item) => item.toLowerCase()));
  const dates = new Set(toStringArray(metadata.dates_mentioned));
  const label = String(parseWhatsappConversationLabel(row.source_conversation_id) ?? "").trim().toLowerCase();

  let score = 0;
  if (queryHints.people.length > 0 && queryHints.people.some((name) => people.has(name) || label.includes(name))) {
    score += 0.45;
  }
  if (queryHints.quotedPhrases.length > 0 && queryHints.quotedPhrases.some((phrase) => (
    phrase && (
      row.content.toLowerCase().includes(phrase)
      || label.includes(phrase)
      || Array.from(topics).some((topic) => topic.includes(phrase))
    )
  ))) {
    score += 0.3;
  }
  if (queryHints.keywordSet.size > 0) {
    const topicOverlap = Array.from(queryHints.keywordSet).reduce((acc, token) => (
      acc + Number(Array.from(topics).some((topic) => hasToken(topic, token)) || hasToken(label, token))
    ), 0);
    score += Math.min(0.2, topicOverlap * 0.05);
  }
  if (queryHints.sourceSystems.length > 0 && queryHints.sourceSystems.includes(String(row.source_system ?? "").toLowerCase())) {
    score += 0.15;
  }
  if (dates.size > 0 && temporalIntent.start && temporalIntent.end) {
    const temporalHit = Array.from(dates).some((value) => {
      const ms = Date.parse(value);
      return Number.isFinite(ms) && ms >= temporalIntent.start!.getTime() && ms <= temporalIntent.end!.getTime();
    });
    if (temporalHit) score += 0.12;
  }
  return Math.max(0, Math.min(1, score));
}

async function fetchConversationContextByEvidenceIds(itemIds: string[]): Promise<Map<string, string>> {
  if (itemIds.length === 0) return new Map<string, string>();
  const rows = await pool.query<{ memory_id: string; context_text: string | null }>(
    `WITH target AS (
       SELECT
         id,
         source_system,
         source_conversation_id,
         chat_namespace,
         COALESCE(source_timestamp, created_at) AS ts
       FROM memory_items
       WHERE id = ANY($1::uuid[])
         AND source_conversation_id IS NOT NULL
     )
     SELECT
       t.id::text AS memory_id,
       STRING_AGG(c.content, ' ' ORDER BY COALESCE(c.source_timestamp, c.created_at) DESC) AS context_text
     FROM target t
     LEFT JOIN LATERAL (
       SELECT content, source_timestamp, created_at
       FROM memory_items c
       WHERE c.source_system = t.source_system
         AND c.source_conversation_id = t.source_conversation_id
         AND COALESCE(c.chat_namespace, '') = COALESCE(t.chat_namespace, '')
         AND COALESCE(c.source_timestamp, c.created_at) <= t.ts
       ORDER BY COALESCE(c.source_timestamp, c.created_at) DESC
       LIMIT 8
     ) c ON true
     GROUP BY t.id`,
    [itemIds]
  );
  const out = new Map<string, string>();
  for (const row of rows.rows) {
    out.set(String(row.memory_id), String(row.context_text ?? ""));
  }
  return out;
}

async function searchEvidence(question: string, chatNamespace: string, timeframe: string | undefined): Promise<EvidenceRef[]> {
  const interval = timeframe === "all" ? null : queryWindow(timeframe);
  const keywords = tokenizeQuery(question);
  const intent = detectQueryIntent(question);
  const temporalIntent = parseTemporalIntent(question);
  const queryHints = extractQueryFacetHints(question);
  const temporalStart = temporalIntent.start ? temporalIntent.start.toISOString() : null;
  const temporalEnd = temporalIntent.end ? temporalIntent.end.toISOString() : null;
  const candidateLimit = temporalIntent.mode === "hard_range" ? 120 : intent.kind === "finance_balance" ? 180 : 60;
  const vector = await getEmbedding(toSemanticEmbeddingText(question));
  const literal = `[${vector.map((n) => Number(n).toFixed(8)).join(",")}]`;

  const [vectorRows, textRows] = await Promise.all([
    pool.query<EvidenceCandidate>(
      `SELECT
         id,
         content,
         role,
         source_system,
         source_conversation_id,
         chat_namespace,
         source_timestamp,
         metadata,
         1 - (embedding <=> $1::vector) AS vector_score,
         0::float8 AS text_score,
         0::float8 AS token_score
       FROM memory_items
      WHERE chat_namespace = $2
        AND COALESCE(source_timestamp, created_at) <= now() + interval '1 day'
        AND ($3::text IS NULL OR COALESCE(source_timestamp, created_at) >= now() - ($3::text)::interval)
        AND ($4::timestamptz IS NULL OR COALESCE(source_timestamp, created_at) >= $4::timestamptz)
        AND ($5::timestamptz IS NULL OR COALESCE(source_timestamp, created_at) <= $5::timestamptz)
      ORDER BY embedding <=> $1::vector
      LIMIT $6`,
      [literal, chatNamespace, interval, temporalStart, temporalEnd, candidateLimit]
    ),
    pool.query<EvidenceCandidate>(
      `SELECT
         id,
         content,
         role,
         source_system,
         source_conversation_id,
         chat_namespace,
         source_timestamp,
         metadata,
         0::float8 AS vector_score,
         GREATEST(similarity(lower(content), lower($1)), 0)::float8 AS text_score,
         (
           SELECT COUNT(*)::float8
             FROM unnest($6::text[]) tok
            WHERE length(tok) > 0
              AND lower(memory_items.content) LIKE '%' || tok || '%'
         ) / GREATEST(array_length($6::text[], 1), 1)::float8 AS token_score
       FROM memory_items
      WHERE chat_namespace = $2
        AND COALESCE(source_timestamp, created_at) <= now() + interval '1 day'
        AND ($3::text IS NULL OR COALESCE(source_timestamp, created_at) >= now() - ($3::text)::interval)
        AND ($4::timestamptz IS NULL OR COALESCE(source_timestamp, created_at) >= $4::timestamptz)
        AND ($5::timestamptz IS NULL OR COALESCE(source_timestamp, created_at) <= $5::timestamptz)
        AND (
          lower(content) % lower($1)
          OR EXISTS (
            SELECT 1
              FROM unnest($6::text[]) tok
             WHERE length(tok) > 0
               AND lower(memory_items.content) LIKE '%' || tok || '%'
          )
        )
      ORDER BY
        (
          GREATEST(similarity(lower(content), lower($1)), 0)::float8
          + (
              SELECT COUNT(*)::float8
                FROM unnest($6::text[]) tok
               WHERE length(tok) > 0
                 AND lower(memory_items.content) LIKE '%' || tok || '%'
            ) / GREATEST(array_length($6::text[], 1), 1)::float8
        ) DESC,
        COALESCE(source_timestamp, created_at) DESC
      LIMIT $7`,
      [question, chatNamespace, interval, temporalStart, temporalEnd, keywords, candidateLimit]
    )
  ]);

  const merged = new Map<string, EvidenceCandidate>();
  for (const row of [...vectorRows.rows, ...textRows.rows]) {
    const current = merged.get(row.id);
    if (!current) {
      merged.set(row.id, row);
      continue;
    }
    merged.set(row.id, {
      ...current,
      vector_score: Math.max(Number(current.vector_score ?? 0), Number(row.vector_score ?? 0)),
      text_score: Math.max(Number(current.text_score ?? 0), Number(row.text_score ?? 0)),
      token_score: Math.max(Number(current.token_score ?? 0), Number(row.token_score ?? 0))
    });
  }

  const contextById = await fetchConversationContextByEvidenceIds(Array.from(merged.keys()));

  const ranked = Array.from(merged.values())
    .filter((row) => timestampInHardRange(row.source_timestamp, temporalIntent))
    .map((row) => {
      const vectorScore = Number(row.vector_score ?? 0);
      const textScore = Number(row.text_score ?? 0);
      const tokenScore = Number(row.token_score ?? 0);
      const semanticScore = Math.max(
        0,
        Math.min(1, vectorScore * 0.55 + textScore * 0.3 + tokenScore * 0.15)
      );
      const temporalScore = temporalRelevance(row.source_timestamp, temporalIntent);
      const contextText = (contextById.get(row.id) ?? "").toLowerCase();
      const contextHits = keywords.reduce((acc, token) => {
        if (!token) return acc;
        return hasToken(contextText, token) ? acc + 1 : acc;
      }, 0);
      const contextScore = Math.max(0, Math.min(1, contextHits / Math.max(1, keywords.length)));
      const metadataScore = computeMetadataFacetScore(row, queryHints, temporalIntent);
      const financeScore = computeFinanceSignal(row.content, contextText, row.source_system, intent, row.role);
      const blended =
        intent.kind === "finance_balance"
          ? Math.max(0, Math.min(1, semanticScore * 0.32 + temporalScore * 0.18 + contextScore * 0.08 + financeScore * 0.32 + metadataScore * 0.1))
          : intent.kind === "finance_general"
            ? Math.max(0, Math.min(1, semanticScore * 0.45 + temporalScore * 0.2 + contextScore * 0.12 + financeScore * 0.13 + metadataScore * 0.1))
            : Math.max(0, Math.min(1, semanticScore * 0.52 + temporalScore * 0.2 + contextScore * 0.12 + metadataScore * 0.16));
      return {
        ...row,
        blended,
        financeScore,
        metadataScore
      };
    })
    .filter((row) => {
      if (intent.kind !== "finance_balance") return true;
      if (!(row.financeScore >= 0.28 && isBalanceEvidenceCandidate(row.content))) return false;
      if (!intent.personal) return true;
      return isPersonalFinanceEvidenceCandidate(row.content, row.source_system, row.role);
    })
    .sort((a, b) => b.blended - a.blended)
    .slice(0, 10);

  return ranked.map((row) => ({
    memoryId: row.id,
    sourceSystem: row.source_system as EvidenceRef["sourceSystem"],
    sourceTimestamp: row.source_timestamp ? new Date(row.source_timestamp).toISOString() : null,
    excerpt: row.content.slice(0, 280),
    similarity: Number(row.blended ?? 0)
  }));
}

function confidenceFromEvidence(evidence: EvidenceRef[]): ConfidenceScore {
  const best = evidence[0]?.similarity ?? 0;
  if (best >= 0.8) return "high";
  if (best >= 0.6) return "medium";
  return "low";
}

function extractMoneyHints(text: string): string[] {
  return extractMoneyAmounts(text).slice(0, 8);
}

function summarizeAnswer(question: string, evidence: EvidenceRef[]): string {
  if (evidence.length === 0) {
    return "No reliable evidence found for this question in the selected timeframe. Try a broader timeframe or different wording.";
  }

  const intent = detectQueryIntent(question);
  if (intent.kind === "finance_balance") {
    return summarizeFinanceBalance(evidence);
  }
  if (intent.kind === "finance_general") {
    const amounts = extractMoneyHints(evidence.map((e) => e.excerpt).join("\n"));
    if (amounts.length === 0) {
      return "I found finance-related messages, but no explicit balance/amount that can answer this directly. Evidence is listed below.";
    }
    return `I found explicit amounts in related messages: ${amounts.join(", ")}. Verify context in evidence before treating this as a final balance.`;
  }

  const highlights = evidence
    .slice(0, 3)
    .map((e, idx) => `${idx + 1}. ${e.excerpt}`)
    .join("\n");
  return `Strongest related memory evidence for "${question}":\n${highlights}`;
}

export async function runBrainQuery(input: BrainQueryRequest, privacyMode: PrivacyMode): Promise<BrainQueryResponse> {
  const chatNamespace = input.chatNamespace?.trim() || "personal.main";
  const question = input.question.trim();
  const evidence = await searchEvidence(question, chatNamespace, input.timeframe);
  const confidence = confidenceFromEvidence(evidence);
  let answer = summarizeAnswer(question, evidence);

  if (config.embeddingMode.toLowerCase() === "mock") {
    answer += "\n\nNote: semantic quality is limited while OPENBRAIN_EMBEDDING_MODE=mock.";
  }

  return {
    ok: true,
    queryId: randomUUID(),
    answer: redactText(answer, privacyMode),
    confidence,
    privacyMode,
    evidenceRefs: applyPrivacyToEvidence(evidence, privacyMode),
    charts: [],
    graphRefs: ["relationships"]
  };
}

export async function getBrainGraph(chatNamespace: string, privacyMode: PrivacyMode): Promise<GraphPayload> {
  const rows = await pool.query<{
    edge_id: string;
    subject_entity_id: string;
    object_entity_id: string;
    relation_type: string;
    weight: number;
    subject_name: string;
    object_name: string;
  }>(
    `SELECT
       e.id AS edge_id,
       e.subject_entity_id,
       e.object_entity_id,
       e.relation_type,
       e.weight,
       s.display_name AS subject_name,
       o.display_name AS object_name
     FROM brain_relationship_edges e
     JOIN brain_entities s ON s.id = e.subject_entity_id
     JOIN brain_entities o ON o.id = e.object_entity_id
     WHERE e.chat_namespace = $1
     ORDER BY e.weight DESC
     LIMIT 260`,
    [chatNamespace]
  );

  const nodeScore = new Map<string, number>();
  for (const row of rows.rows) {
    nodeScore.set(row.subject_entity_id, (nodeScore.get(row.subject_entity_id) ?? 0) + Number(row.weight ?? 0));
    nodeScore.set(row.object_entity_id, (nodeScore.get(row.object_entity_id) ?? 0) + Number(row.weight ?? 0));
  }
  const topNodeIds = new Set(
    Array.from(nodeScore.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 70)
      .map((entry) => entry[0])
  );

  const filteredRows = rows.rows
    .filter((row) => topNodeIds.has(row.subject_entity_id) && topNodeIds.has(row.object_entity_id))
    .slice(0, 170);

  const nodeMap = new Map<string, { id: string; label: string; nodeType: string; value: number }>();
  const edges = filteredRows.map((row) => {
    nodeMap.set(row.subject_entity_id, {
      id: row.subject_entity_id,
      label: row.subject_name,
      nodeType: "person",
      value: row.weight
    });
    nodeMap.set(row.object_entity_id, {
      id: row.object_entity_id,
      label: row.object_name,
      nodeType: "person",
      value: row.weight
    });

    return {
      id: row.edge_id,
      source: row.subject_entity_id,
      target: row.object_entity_id,
      relationType: row.relation_type,
      weight: Number(row.weight ?? 0),
      direction: "both" as const
    };
  });

  const graph: GraphPayload = {
    id: "relationships",
    title: "Relationship Network",
    nodes: Array.from(nodeMap.values()),
    edges
  };
  return applyPrivacyToGraph(graph, privacyMode);
}

export async function getBehaviorCharts(chatNamespace: string, windowLabel: string, privacyMode: PrivacyMode): Promise<ChartPayload[]> {
  const rows = await pool.query<{ day: string; domain: string; metric_value: number }>(
    `SELECT
       day::text,
       domain,
       COALESCE(
         SUM(metric_value) FILTER (WHERE metric_key = 'messages_weighted'),
         SUM(metric_value) FILTER (WHERE metric_key = 'messages_total'),
         0
       )::float AS metric_value
     FROM brain_daily_rollups
     WHERE chat_namespace = $1
       AND day >= (now() - $2::interval)::date
       AND day <= now()::date
       AND metric_key IN ('messages_total', 'messages_weighted')
      GROUP BY day, domain
      ORDER BY day ASC`,
    [chatNamespace, windowLabel]
  );

  const labels = Array.from(new Set(rows.rows.map((row) => row.day))).sort();
  const lookup = new Map<string, Map<string, number>>();
  for (const row of rows.rows) {
    const day = row.day;
    const domain = row.domain;
    const dayMap = lookup.get(day) ?? new Map<string, number>();
    dayMap.set(domain, Number(row.metric_value ?? 0));
    lookup.set(day, dayMap);
  }

  const briefDomains = ["relationships", "behavior", "mood", "work", "diet"];
  const briefSeries = briefDomains.map((domain) => ({
    name: domainLabel(domain),
    data: labels.map((label) => {
      return Number(lookup.get(label)?.get(domain) ?? 0);
    })
  }));

  const behaviorDomains = ["behavior", "mood", "diet"];
  const behaviorSeries = behaviorDomains.map((domain) => ({
    name: domainLabel(domain),
    data: labels.map((label) => Number(lookup.get(label)?.get(domain) ?? 0))
  }));

  return applyPrivacyToCharts(
    [
      {
        id: "brief-domain-weekly",
        title: "Domain Mix",
        chartType: "bar",
        labels,
        series: briefSeries
      },
      {
        id: "behavior-trends",
        title: "Habit and Mood Trend",
        chartType: "line",
        labels,
        series: behaviorSeries
      }
    ],
    privacyMode
  );
}

export async function listBrainInsights(chatNamespace: string, privacyMode: PrivacyMode): Promise<BrainInsight[]> {
  await refreshSocialInsights(chatNamespace);
  const rows = await pool.query<{
    id: string;
    chat_namespace: string;
    insight_pack: string;
    insight_type: string;
    title: string;
    summary: string;
    confidence: number;
    action_text: string | null;
    updated_at: string;
  }>(
    `SELECT id, chat_namespace, insight_pack, insight_type, title, summary, confidence, action_text, updated_at
       FROM brain_insight_snapshots
      WHERE chat_namespace = $1
      ORDER BY updated_at DESC
      LIMIT 24`,
    [chatNamespace]
  );

  const insights: BrainInsight[] = rows.rows.map((row) => ({
    id: row.id,
    chatNamespace: row.chat_namespace,
    insightPack: row.insight_pack as BrainInsight["insightPack"],
    insightType: row.insight_type,
    title: row.title,
    summary: row.summary,
    confidence: Number(row.confidence ?? 0.5),
    action: row.action_text,
    updatedAt: new Date(row.updated_at).toISOString()
  }));

  return applyPrivacyToInsights(insights, privacyMode);
}

export async function getBrainJobs(limit = 30): Promise<BrainJobStatus[]> {
  const rows = await pool.query<{
    id: string;
    job_type: string;
    status: BrainJobStatus["status"];
    scope: Record<string, unknown> | null;
    started_at: string | null;
    finished_at: string | null;
    created_at: string;
    queued_items: string;
    processed_items: string;
    failed_items: string;
  }>(
    `SELECT
       j.id,
       j.job_type,
       j.status,
       j.scope,
       j.started_at,
       j.finished_at,
       j.created_at,
       COUNT(i.*)::text AS queued_items,
       COUNT(*) FILTER (WHERE i.status = 'completed')::text AS processed_items,
       COUNT(*) FILTER (WHERE i.status = 'failed')::text AS failed_items
     FROM brain_jobs j
     LEFT JOIN brain_job_items i ON i.job_id = j.id
     GROUP BY j.id
     ORDER BY j.created_at DESC
     LIMIT $1`,
    [limit]
  );

  return rows.rows.map((row) => ({
    id: row.id,
    jobType: row.job_type,
    status: row.status,
    scope: row.scope ?? {},
    startedAt: row.started_at ? new Date(row.started_at).toISOString() : null,
    finishedAt: row.finished_at ? new Date(row.finished_at).toISOString() : null,
    createdAt: new Date(row.created_at).toISOString(),
    queuedItems: Number(row.queued_items ?? "0"),
    processedItems: Number(row.processed_items ?? "0"),
    failedItems: Number(row.failed_items ?? "0")
  }));
}

async function clearDerivedStateForNamespace(chatNamespace: string): Promise<void> {
  await pool.query(
    `DELETE FROM brain_fact_evidence
      WHERE fact_id IN (
        SELECT id
          FROM brain_facts
         WHERE chat_namespace = $1
      )`,
    [chatNamespace]
  );
  await pool.query(`DELETE FROM brain_facts WHERE chat_namespace = $1`, [chatNamespace]);
  await pool.query(`DELETE FROM brain_relationship_edges WHERE chat_namespace = $1`, [chatNamespace]);
  await pool.query(`DELETE FROM brain_daily_rollups WHERE chat_namespace = $1`, [chatNamespace]);
  await pool.query(`DELETE FROM brain_insight_snapshots WHERE chat_namespace = $1`, [chatNamespace]);
  await pool.query(`DELETE FROM brain_entities WHERE chat_namespace = $1`, [chatNamespace]);
}

export async function rebuildBrainJob(params: {
  chatNamespace?: string;
  days?: number;
  domain?: string;
  requestedBy: string;
}): Promise<{ ok: true; jobId: string; queued: number }> {
  const days = Number.isFinite(Number(params.days)) ? Math.max(1, Math.min(3650, Number(params.days))) : 90;
  const job = await pool.query<{ id: string }>(
    `INSERT INTO brain_jobs (job_type, status, requested_by, scope, started_at)
     VALUES ('rebuild', 'pending', $1, $2::jsonb, now())
     RETURNING id`,
    [params.requestedBy, JSON.stringify(params)]
  );
  const jobId = job.rows[0]?.id;
  if (!jobId) throw new Error("Failed to create rebuild job");

  if (params.chatNamespace && !params.domain) {
    await clearDerivedStateForNamespace(params.chatNamespace);
  }

  await pool.query(
    `DELETE FROM brain_job_items i
      USING brain_jobs j
     WHERE i.job_id = j.id
       AND j.job_type = 'rebuild'
       AND j.id <> $1
       AND j.status <> 'running'
       AND i.status IN ('pending', 'running')`,
    [jobId]
  );

  const queued = await pool.query<{ inserted: string }>(
    `WITH source_rows AS (
       SELECT id
         FROM memory_items
        WHERE ($1::text IS NULL OR chat_namespace = $1)
          AND COALESCE(source_timestamp, created_at) >= now() - make_interval(days => $2)
        ORDER BY COALESCE(source_timestamp, created_at) DESC
     ),
     inserted_rows AS (
       INSERT INTO brain_job_items (job_id, memory_item_id, status)
       SELECT $3, id, 'pending'
       FROM source_rows
       RETURNING 1
     )
     SELECT COUNT(*)::text AS inserted FROM inserted_rows`,
    [params.chatNamespace ?? null, days, jobId]
  );

  const inserted = Number(queued.rows[0]?.inserted ?? "0");
  await pool.query(
    `UPDATE brain_jobs
        SET status = CASE WHEN $2::int > 0 THEN 'running' ELSE 'completed' END,
            finished_at = CASE WHEN $2::int > 0 THEN NULL ELSE now() END,
            updated_at = now()
      WHERE id = $1`,
    [jobId, inserted]
  );
  return { ok: true, jobId, queued: inserted };
}

export async function recordQueryFeedback(input: FeedbackRecord, privacyMode: PrivacyMode): Promise<void> {
  await pool.query(
    `INSERT INTO brain_query_feedback (query_id, verdict, correction, metadata)
     VALUES ($1, $2, $3, $4::jsonb)`,
    [input.queryId, input.verdict, input.correction ?? null, JSON.stringify({ privacyMode })]
  );
}

export async function getPrivacyAwareTimeline(params: {
  chatNamespace: string;
  start?: string;
  end?: string;
  domain?: string;
  timeframe?: string;
  privacyMode: PrivacyMode;
}): Promise<Array<Record<string, unknown>>> {
  const fallbackStart = params.start ? null : (params.timeframe === "all" ? null : queryWindow(params.timeframe));
  const safeEnd = params.end ?? new Date().toISOString();
  const rows = await pool.query<{
    id: string;
    domain: string;
    value_text: string;
    confidence: number;
    source_timestamp: string | null;
    metadata: Record<string, unknown> | null;
  }>(
    `SELECT id, domain, value_text, confidence, source_timestamp, metadata
       FROM brain_facts
      WHERE chat_namespace = $1
        AND ($2::text IS NULL OR domain = $2)
        AND (
          $3::timestamptz IS NOT NULL
          OR $5::text IS NULL
          OR source_timestamp >= now() - ($5::text)::interval
        )
        AND ($3::timestamptz IS NULL OR source_timestamp >= $3::timestamptz)
        AND ($4::timestamptz IS NULL OR source_timestamp <= $4::timestamptz)
      ORDER BY source_timestamp DESC NULLS LAST, created_at DESC
      LIMIT 200`,
    [params.chatNamespace, params.domain ?? null, params.start ?? null, safeEnd, fallbackStart]
  );

  return rows.rows.map((row) => {
    const metadata = asRecord(row.metadata);
    const candidatesRaw = metadata.domainCandidates;
    const domains = Array.isArray(candidatesRaw)
      ? candidatesRaw
          .filter((item): item is { domain: string; score?: number } => Boolean(item) && typeof item === "object" && typeof (item as { domain?: unknown }).domain === "string")
          .map((item) => String(item.domain))
          .slice(0, 3)
      : [];
    const resolvedDomain = domains[0] ?? reclassifyTimelineDomain(row.domain, row.value_text, metadata);

    return {
      id: row.id,
      domain: resolvedDomain,
      domains: domains.length > 0 ? domains : [resolvedDomain],
      text: redactText(row.value_text, params.privacyMode),
      confidence: Number(row.confidence ?? 0.5),
      sourceTimestamp: row.source_timestamp ? new Date(row.source_timestamp).toISOString() : null
    };
  });
}

export async function getProfileSummary(chatNamespace: string, timeframe: string, privacyMode: PrivacyMode): Promise<Record<string, unknown>> {
  const window = queryWindow(timeframe);
  const counts = await pool.query<{ domain: string; total: number }>(
    `SELECT
       domain,
       COALESCE(
         SUM(metric_value) FILTER (WHERE metric_key = 'messages_weighted'),
         SUM(metric_value) FILTER (WHERE metric_key = 'messages_total'),
         0
       )::float AS total
       FROM brain_daily_rollups
      WHERE chat_namespace = $1
        AND day >= (now() - $2::interval)::date
        AND day <= now()::date
        AND metric_key IN ('messages_total', 'messages_weighted')
      GROUP BY domain
      ORDER BY total DESC`,
    [chatNamespace, window]
  );

  const topPeople = await pool.query<{ display_name: string; weight: number }>(
    `SELECT display_name, weight
       FROM brain_entities
      WHERE chat_namespace = $1
        AND entity_type = 'person'
        AND COALESCE((metadata->>'owner')::boolean, false) = false
      ORDER BY weight DESC
      LIMIT 64`,
    [chatNamespace]
  );

  const people = mergePeopleRows(topPeople.rows).slice(0, 12).map((row) => ({
    name: privacyMode === "private" ? row.displayName : `Person-${Math.round(row.weight)}`,
    weight: Number(row.weight ?? 0)
  }));

  return {
    chatNamespace,
    timeframe,
    topDomains: counts.rows.map((row) => ({ domain: domainLabel(row.domain), total: Number(row.total ?? 0) })),
    topPeople: people
  };
}

export async function pruneOperationalLogs(days: number): Promise<{
  ok: true;
  days: number;
  deletedIngestionItems: number;
  deletedBrainItems: number;
  deletedBrainJobs: number;
}> {
  const safeDays = Number.isFinite(Number(days)) ? Math.max(1, Math.min(3650, Math.trunc(days))) : 60;

  const ingest = await pool.query<{ count: string }>(
    `WITH d AS (
       DELETE FROM ingestion_job_items
        WHERE created_at < now() - make_interval(days => $1)
        RETURNING 1
     )
     SELECT COUNT(*)::text AS count FROM d`,
    [safeDays]
  );

  const brainItems = await pool.query<{ count: string }>(
    `WITH d AS (
       DELETE FROM brain_job_items
        WHERE updated_at < now() - make_interval(days => $1)
          AND status IN ('completed', 'failed')
        RETURNING 1
     )
     SELECT COUNT(*)::text AS count FROM d`,
    [safeDays]
  );

  const brainJobs = await pool.query<{ count: string }>(
    `WITH d AS (
       DELETE FROM brain_jobs
        WHERE updated_at < now() - make_interval(days => $1)
          AND status IN ('completed', 'failed')
          AND NOT EXISTS (SELECT 1 FROM brain_job_items i WHERE i.job_id = brain_jobs.id)
        RETURNING 1
     )
     SELECT COUNT(*)::text AS count FROM d`,
    [safeDays]
  );

  return {
    ok: true,
    days: safeDays,
    deletedIngestionItems: Number(ingest.rows[0]?.count ?? "0"),
    deletedBrainItems: Number(brainItems.rows[0]?.count ?? "0"),
    deletedBrainJobs: Number(brainJobs.rows[0]?.count ?? "0")
  };
}
