import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import { pool } from "./db.js";
import { getEmbedding } from "./embedding_provider.js";
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

let workerTimer: NodeJS.Timeout | null = null;
let workerRunning = false;

function normalizeName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s_-]+/g, "")
    .replace(/\s+/g, " ");
}

function parseDateOrNow(value: string | null): Date {
  if (!value) return new Date();
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return new Date();
  return new Date(ms);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") return {};
  return value as Record<string, unknown>;
}

function inferDomain(content: string, metadata: Record<string, unknown>): Domain {
  const text = `${content}\n${JSON.stringify(metadata)}`.toLowerCase();
  if (/wife|husband|friend|family|brother|sister|mom|dad|john|chat/.test(text)) return "relationships";
  if (/diet|food|eat|calorie|protein|carb|meal/.test(text)) return "diet";
  if (/sleep|mood|stress|anx|happy|sad|mental/.test(text)) return "mood";
  if (/work|job|project|client|deadline|meeting|career/.test(text)) return "work";
  if (/habit|routine|discipline|consisten|streak/.test(text)) return "behavior";
  if (/doctor|medicine|symptom|blood|health|clinic/.test(text)) return "health";
  if (/money|finance|invest|expense|income|budget/.test(text)) return "finance";
  if (/identity|personality|belief|value/.test(text)) return "identity";
  return "other";
}

function detectPeople(content: string, metadata: Record<string, unknown>): string[] {
  const names = new Set<string>();

  const speaker = metadata.speaker;
  if (typeof speaker === "string" && speaker.trim()) {
    names.add(speaker.trim());
  }

  const peopleRaw = metadata.people;
  if (Array.isArray(peopleRaw)) {
    for (const item of peopleRaw) {
      if (typeof item === "string" && item.trim()) names.add(item.trim());
    }
  }

  const matches = content.match(NAME_RE) ?? [];
  for (const match of matches) {
    if (STOP_NAMES.has(match)) continue;
    names.add(match.trim());
  }

  return Array.from(names).slice(0, 12);
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
  confidence: number,
  subjectEntityId: string | null,
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
      row.source_timestamp,
      row.content,
      JSON.stringify({ sourceSystem: row.source_system, role: row.role })
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
      ORDER BY weight DESC
      LIMIT 6`,
    [chatNamespace]
  );

  const peopleText = topPeople.rows.map((r) => `${r.display_name} (${Math.round(r.weight)})`).join(", ");
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
      topPeople.rows.length >= 3 ? 0.78 : 0.52,
      "Check reciprocity with top contacts and schedule intentional catch-ups.",
      JSON.stringify({ people: topPeople.rows })
    ]
  );
}

async function processMemoryItem(memoryItemId: string): Promise<void> {
  const data = await pool.query<MemoryRow>(
    `SELECT id, content, role, source_system, source_timestamp, chat_namespace, metadata, created_at
       FROM memory_items
      WHERE id = $1
      LIMIT 1`,
    [memoryItemId]
  );
  const row = data.rows[0];
  if (!row || !row.chat_namespace) return;

  const metadata = asRecord(row.metadata);
  const domain = inferDomain(row.content, metadata);
  const seenAt = parseDateOrNow(row.source_timestamp ?? row.created_at);
  const day = seenAt.toISOString().slice(0, 10);
  const ownerEntityId = await getOrCreateEntity(row.chat_namespace, "person", config.ownerName, {
    owner: true
  });

  const people = detectPeople(row.content, metadata).filter((name) => normalizeName(name) !== normalizeName(config.ownerName));
  for (const personName of people) {
    const personEntityId = await getOrCreateEntity(row.chat_namespace, "person", personName, { detectedFrom: "content" });
    await upsertRelationship(row.chat_namespace, ownerEntityId, personEntityId, "interaction", seenAt);
  }

  const confidence = Math.min(0.95, 0.45 + Math.min(people.length, 4) * 0.1);
  await storeFactAndEvidence(row, domain, confidence, ownerEntityId, row.content.slice(0, 600));

  await upsertRollup(day, row.chat_namespace, domain, "messages_total", 1);
  await upsertRollup(day, row.chat_namespace, domain, `source_${row.source_system}`, 1);
  if (people.length > 0) {
    await upsertRollup(day, row.chat_namespace, "relationships", "person_mentions", people.length);
  }

  await refreshSocialInsights(row.chat_namespace);
}

async function claimPendingItems(limit: number): Promise<PendingJobItem[]> {
  const result = await pool.query<PendingJobItem>(
    `WITH to_claim AS (
       SELECT id
         FROM brain_job_items
        WHERE status = 'pending'
        ORDER BY created_at ASC
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

async function runWorkerTick(): Promise<void> {
  if (workerRunning) return;
  workerRunning = true;
  try {
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

async function searchEvidence(question: string, chatNamespace: string): Promise<EvidenceRef[]> {
  const vector = await getEmbedding(question);
  const literal = `[${vector.map((n) => Number(n).toFixed(8)).join(",")}]`;
  const rows = await pool.query<{
    id: string;
    content: string;
    source_system: string;
    source_timestamp: string | null;
    similarity: number;
  }>(
    `SELECT id, content, source_system, source_timestamp, 1 - (embedding <=> $1::vector) AS similarity
       FROM memory_items
      WHERE chat_namespace = $2
      ORDER BY embedding <=> $1::vector
      LIMIT 8`,
    [literal, chatNamespace]
  );

  return rows.rows.map((row) => ({
    memoryId: row.id,
    sourceSystem: row.source_system as EvidenceRef["sourceSystem"],
    sourceTimestamp: row.source_timestamp ? new Date(row.source_timestamp).toISOString() : null,
    excerpt: row.content.slice(0, 280),
    similarity: Number(row.similarity ?? 0)
  }));
}

function confidenceFromEvidence(evidence: EvidenceRef[]): ConfidenceScore {
  const best = evidence[0]?.similarity ?? 0;
  if (best >= 0.78) return "high";
  if (best >= 0.58) return "medium";
  return "low";
}

function summarizeAnswer(question: string, evidence: EvidenceRef[]): string {
  if (evidence.length === 0) {
    return "I found limited supporting memory for this question. Ingest more messages or expand timeframe.";
  }
  const highlights = evidence.slice(0, 3).map((e, idx) => `${idx + 1}. ${e.excerpt}`).join("\n");
  return `Based on your stored memory, here is the strongest evidence I found for: "${question}"\n${highlights}`;
}

export async function runBrainQuery(input: BrainQueryRequest, privacyMode: PrivacyMode): Promise<BrainQueryResponse> {
  const chatNamespace = input.chatNamespace?.trim() || "personal.main";
  const question = input.question.trim();
  const evidence = await searchEvidence(question, chatNamespace);
  const confidence = confidenceFromEvidence(evidence);
  const answer = summarizeAnswer(question, evidence);

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
     LIMIT 120`,
    [chatNamespace]
  );

  const nodeMap = new Map<string, { id: string; label: string; nodeType: string; value: number }>();
  const edges = rows.rows.map((row) => {
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
    `SELECT day::text, domain, SUM(metric_value)::float AS metric_value
       FROM brain_daily_rollups
      WHERE chat_namespace = $1
        AND day >= (now() - $2::interval)::date
      GROUP BY day, domain
      ORDER BY day ASC`,
    [chatNamespace, windowLabel]
  );

  const labels = Array.from(new Set(rows.rows.map((row) => row.day))).sort();
  const domains = ["relationships", "behavior", "mood", "work", "diet"];
  const series = domains.map((domain) => ({
    name: domain,
    data: labels.map((label) => {
      const item = rows.rows.find((r) => r.day === label && r.domain === domain);
      return Number(item?.metric_value ?? 0);
    })
  }));

  return applyPrivacyToCharts(
    [
      {
        id: "daily-domain-intensity",
        title: "Daily Domain Intensity",
        chartType: "line",
        labels,
        series
      }
    ],
    privacyMode
  );
}

export async function listBrainInsights(chatNamespace: string, privacyMode: PrivacyMode): Promise<BrainInsight[]> {
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

export async function rebuildBrainJob(params: {
  chatNamespace?: string;
  days?: number;
  domain?: string;
  requestedBy: string;
}): Promise<{ ok: true; jobId: string; queued: number }> {
  const days = Number.isFinite(Number(params.days)) ? Math.max(1, Math.min(3650, Number(params.days))) : 90;
  const job = await pool.query<{ id: string }>(
    `INSERT INTO brain_jobs (job_type, status, requested_by, scope, started_at)
     VALUES ('rebuild', 'running', $1, $2::jsonb, now())
     RETURNING id`,
    [params.requestedBy, JSON.stringify(params)]
  );
  const jobId = job.rows[0]?.id;
  if (!jobId) throw new Error("Failed to create rebuild job");

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
  privacyMode: PrivacyMode;
}): Promise<Array<Record<string, unknown>>> {
  const rows = await pool.query<{
    id: string;
    domain: string;
    value_text: string;
    confidence: number;
    source_timestamp: string | null;
  }>(
    `SELECT id, domain, value_text, confidence, source_timestamp
       FROM brain_facts
      WHERE chat_namespace = $1
        AND ($2::text IS NULL OR domain = $2)
        AND ($3::timestamptz IS NULL OR source_timestamp >= $3::timestamptz)
        AND ($4::timestamptz IS NULL OR source_timestamp <= $4::timestamptz)
      ORDER BY source_timestamp DESC NULLS LAST, created_at DESC
      LIMIT 200`,
    [params.chatNamespace, params.domain ?? null, params.start ?? null, params.end ?? null]
  );

  return rows.rows.map((row) => ({
    id: row.id,
    domain: row.domain,
    text: redactText(row.value_text, params.privacyMode),
    confidence: Number(row.confidence ?? 0.5),
    sourceTimestamp: row.source_timestamp ? new Date(row.source_timestamp).toISOString() : null
  }));
}

export async function getProfileSummary(chatNamespace: string, timeframe: string, privacyMode: PrivacyMode): Promise<Record<string, unknown>> {
  const window = queryWindow(timeframe);
  const counts = await pool.query<{ domain: string; total: number }>(
    `SELECT domain, SUM(metric_value)::float AS total
       FROM brain_daily_rollups
      WHERE chat_namespace = $1
        AND day >= (now() - $2::interval)::date
      GROUP BY domain
      ORDER BY total DESC`,
    [chatNamespace, window]
  );

  const topPeople = await pool.query<{ display_name: string; weight: number }>(
    `SELECT display_name, weight
       FROM brain_entities
      WHERE chat_namespace = $1
        AND entity_type = 'person'
      ORDER BY weight DESC
      LIMIT 12`,
    [chatNamespace]
  );

  const people = topPeople.rows.map((row) => ({
    name: privacyMode === "private" ? row.display_name : `Person-${Math.round(row.weight)}`,
    weight: Number(row.weight ?? 0)
  }));

  return {
    chatNamespace,
    timeframe,
    topDomains: counts.rows.map((row) => ({ domain: row.domain, total: Number(row.total ?? 0) })),
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
