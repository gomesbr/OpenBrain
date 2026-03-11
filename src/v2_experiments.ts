import { createHash, randomUUID } from "node:crypto";
import { mkdir, appendFile } from "node:fs/promises";
import path from "node:path";
import { pool } from "./db.js";
import { config } from "./config.js";
import { askV2 } from "./v2_ask.js";
import { inferStructuredSignals } from "./domain_inference.js";
import { toSemanticEmbeddingText } from "./semantic_text.js";
import { fetchContextWindow } from "./v2_search.js";
import type {
  BenchmarkFreshnessStatus,
  BenchmarkAdmissionDecision,
  BenchmarkAuthoringCritique,
  BenchmarkAuthoringDraft,
  BenchmarkFeasibilityReport,
  BenchmarkSemanticFrame,
  ComponentSelection,
  EvaluationScorecard,
  FailureBreakdown,
  ExperimentRole,
  HypothesisEvaluation,
  HypothesisRecord,
  OntologyCandidate,
  OntologyCandidateReview,
  OntologyDriftSummary,
  StrategyVariant,
  StrategyVariantConfig,
  TaxonomyFacetCoverageRow,
  TaxonomyFacetCoverageSummary,
  TaxonomyPairSupport,
  TaxonomyVersion,
  V2AskRequest,
  V2AskResponse,
  V2Principal
} from "./v2_types.js";

const TAXONOMY_DOMAINS = [
  "identity_profile",
  "values_beliefs",
  "personality_traits",
  "emotional_baseline",
  "mental_health_signals",
  "cognitive_style",
  "decision_behavior",
  "attention_productivity",
  "habit_systems",
  "sleep_recovery",
  "nutrition_eating_behavior",
  "exercise_sports",
  "medical_context",
  "substance_use",
  "energy_management",
  "romantic_relationship",
  "family_relationships",
  "friendships",
  "social_graph_dynamics",
  "communication_style",
  "memorable_moments",
  "career_trajectory",
  "work_performance",
  "learning_growth",
  "financial_behavior",
  "lifestyle_environment",
  "leisure_creativity",
  "travel_mobility",
  "life_goals_planning",
  "personal_narrative",
  "digital_behavior",
  "reputation_network_capital",
  "ethics_privacy_boundaries",
  "risk_safety",
  "financial_planning",
  "health_routines",
  "message_drafting",
  "software_troubleshooting",
  "work_execution",
  "battery_range_planning",
  "risk_safety_decisions",
  "meaning_spirituality",
  "meta_memory_quality"
] as const;

const ANALYSIS_LENSES = [
  "descriptive",
  "diagnostic",
  "predictive",
  "prescriptive",
  "causal_hypotheses",
  "trend_trajectory",
  "outlier_detection",
  "counterfactuals",
  "confidence_scoring",
  "actionability",
  "actor_attribution",
  "thread_reconstruction",
  "timeline_reconstruction"
] as const;

const FAILURE_BUCKETS = [
  "retrieval_miss",
  "ranking_failure",
  "context_expansion_miss",
  "thread_continuity_miss",
  "actor_attribution_miss",
  "temporal_interpretation_miss",
  "reasoning_synthesis_miss",
  "answer_contract_format_miss",
  "contradiction_handling_miss",
  "provenance_mismatch",
  "plan_window_compaction_miss"
] as const;

type FailureBucket = (typeof FAILURE_BUCKETS)[number];

interface ExperimentStartInput {
  name?: string;
  chatNamespace?: string;
  targetPassRate?: number;
  criticalTargetPassRate?: number;
  perDomainFloor?: number;
  latencyGateMultiplier?: number;
  costGateMultiplier?: number;
  datasetVersion?: string;
  strategyIds?: string[];
  maxCasesPerPair?: number;
  taxonomyVersionId?: string;
}

interface ExperimentStepInput {
  experimentId: string;
  variantId?: string;
  caseSet?: "dev" | "critical" | "certification" | "all";
}

interface ExperimentCaseRow {
  id: string;
  case_set: "dev" | "critical" | "certification" | "stress" | "coverage";
  case_key: string;
  case_type: string;
  domain: string;
  lens: string;
  question: string;
  chat_namespace: string;
  expected_contract: Record<string, unknown>;
  expected_core_claims: string[];
  evidence_ids: string[];
  conversation_ids: string[];
  actor_ids: string[];
  fact_id?: string | null;
  source_evidence_id?: string | null;
  taxonomy_path?: string | null;
  acceptable_answer_forms?: string[];
  required_evidence_ids?: string[];
  difficulty_type?: string;
  generation_method?: string;
  ambiguity_class?: "clear" | "clarify_required" | "unresolved";
  owner_validation_state?: "pending" | "approved" | "rejected" | "not_required";
  clarification_quality_expected?: boolean;
  benchmark_lock_version?: string | null;
  eligible_for_scoring?: boolean;
  metadata: Record<string, unknown>;
}

interface StrategyRow {
  id: string;
  strategy_id: string;
  variant_id: string;
  label: string;
  position: number;
  status: "queued" | "running" | "completed" | "failed" | "skipped";
  hypothesis_id?: string | null;
  experiment_role?: ExperimentRole;
  parent_strategy_variant_id?: string | null;
  parent_hypothesis_id?: string | null;
  modified_components?: string[];
  lineage_reason?: string | null;
  config: StrategyVariantConfig;
  metrics: Record<string, unknown>;
}

interface ExperimentRow {
  id: string;
  name: string;
  chat_namespace: string;
  status: "queued" | "running" | "completed" | "failed";
  terminal_state?: "normal" | "interrupted" | "aborted";
  interrupted_at?: string | null;
  aborted_at?: string | null;
  target_pass_rate: number;
  critical_target_pass_rate: number;
  per_domain_floor: number;
  latency_gate_multiplier: number;
  cost_gate_multiplier: number;
  dataset_version: string;
  taxonomy_version_id?: string | null;
  active_benchmark_lock_version?: string | null;
  autonomous_mode?: boolean;
  human_input_allowed?: boolean;
  benchmark_generated_at?: string | null;
  benchmark_support_scanned_at?: string | null;
  benchmark_stale?: boolean;
  strategy_cursor: number;
  winner_strategy_id: string | null;
  winner_variant_id: string | null;
  notes: string | null;
  config: Record<string, unknown>;
}

interface TaxonomyVersionRow extends TaxonomyVersion {
  status: "published" | "archived";
}

interface TaxonomySupportRow extends TaxonomyPairSupport {}

const BENCHMARK_AUTHORING_VERSION = "v1.7";
const BENCHMARK_ORACLE_VERSION = "oracle_v1";
const TAXONOMY_SUPPORT_SCAN_VERSION = "taxonomy_support_v1";
const AUTHORING_RETRIEVAL_K = 8;
const AUTHORING_AGENT_TIMEOUT_MS = 15000;
const AUTHORING_MAX_ATTEMPTS = 3;
const AUTHORING_TIMING_LOG_PATH = path.resolve("generated/strategy_program/benchmark_authoring_call_times.jsonl");
const DEFAULT_TAXONOMY_VERSION_KEY = "taxonomy_v1";
const DEFAULT_TAXONOMY_VERSION_NAME = "OpenBrain Taxonomy v1";

function clamp01(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function nowIso(): string {
  return new Date().toISOString();
}

function humanizeTaxonomyKey(value: string): string {
  return String(value ?? "")
    .trim()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\b\w/g, (m) => m.toUpperCase());
}

function slugifyTaxonomyKey(value: string): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_{2,}/g, "_")
    .slice(0, 96);
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return Array.from(new Set(values.map((item) => String(item ?? "").trim()).filter(Boolean)));
}

function normalizeTaxonomyVersionRow(row: {
  id: string;
  version_key: string;
  name: string;
  status: "published" | "archived";
  source_chat_namespace: string;
  parent_version_id: string | null;
  scan_completed_at: string | null;
  published_at: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}): TaxonomyVersionRow {
  return {
    id: row.id,
    versionKey: row.version_key,
    name: row.name,
    status: row.status,
    sourceChatNamespace: row.source_chat_namespace,
    parentVersionId: row.parent_version_id,
    scanCompletedAt: row.scan_completed_at,
    publishedAt: row.published_at,
    metadata: row.metadata ?? {},
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

async function loadTaxonomyVersionRowById(versionId: string): Promise<TaxonomyVersionRow> {
  const rows = await pool.query<{
    id: string;
    version_key: string;
    name: string;
    status: "published" | "archived";
    source_chat_namespace: string;
    parent_version_id: string | null;
    scan_completed_at: string | null;
    published_at: string | null;
    metadata: Record<string, unknown> | null;
    created_at: string;
    updated_at: string;
  }>(
    `SELECT
       id::text,
       version_key,
       name,
       status,
       source_chat_namespace,
       parent_version_id::text,
       scan_completed_at::text,
       published_at::text,
       metadata,
       created_at::text,
       updated_at::text
     FROM taxonomy_versions
     WHERE id = $1::uuid
     LIMIT $2`,
    [versionId, 1]
  );
  const row = rows.rows[0];
  if (!row) throw new Error("Taxonomy version not found");
  return normalizeTaxonomyVersionRow(row);
}

async function ensureBootstrapTaxonomyVersion(chatNamespace = "personal.main"): Promise<TaxonomyVersionRow> {
  const existing = await pool.query<{
    id: string;
    version_key: string;
    name: string;
    status: "published" | "archived";
    source_chat_namespace: string;
    parent_version_id: string | null;
    scan_completed_at: string | null;
    published_at: string | null;
    metadata: Record<string, unknown> | null;
    created_at: string;
    updated_at: string;
  }>(
    `SELECT
       id::text,
       version_key,
       name,
       status,
       source_chat_namespace,
       parent_version_id::text,
       scan_completed_at::text,
       published_at::text,
       metadata,
       created_at::text,
       updated_at::text
     FROM taxonomy_versions
     WHERE status = 'published'
     ORDER BY published_at DESC NULLS LAST, created_at DESC
     LIMIT 1`
  );
  if (existing.rows[0]) return normalizeTaxonomyVersionRow(existing.rows[0]);

  const versionId = randomUUID();
  await pool.query(
    `INSERT INTO taxonomy_versions (
       id, version_key, name, status, source_chat_namespace, published_at, metadata
     ) VALUES (
       $1::uuid, $2, $3, 'published', $4, now(), $5::jsonb
     )`,
    [
      versionId,
      DEFAULT_TAXONOMY_VERSION_KEY,
      DEFAULT_TAXONOMY_VERSION_NAME,
      chatNamespace,
      JSON.stringify({ bootstrap: true, source: "system_constants" })
    ]
  );
  for (const domain of TAXONOMY_DOMAINS) {
    await pool.query(
      `INSERT INTO taxonomy_domains (
         taxonomy_version_id, domain_key, label, status, metadata
       ) VALUES (
         $1::uuid, $2, $3, 'active', '{}'::jsonb
       )
       ON CONFLICT (taxonomy_version_id, domain_key) DO NOTHING`,
      [versionId, domain, humanizeTaxonomyKey(domain)]
    );
  }
  for (const lens of ANALYSIS_LENSES) {
    await pool.query(
      `INSERT INTO taxonomy_lenses (
         taxonomy_version_id, lens_key, label, status, metadata
       ) VALUES (
         $1::uuid, $2, $3, 'active', '{}'::jsonb
       )
       ON CONFLICT (taxonomy_version_id, lens_key) DO NOTHING`,
      [versionId, lens, humanizeTaxonomyKey(lens)]
    );
  }
  return loadTaxonomyVersionRowById(versionId);
}

async function getPublishedTaxonomyVersion(versionId?: string | null): Promise<TaxonomyVersionRow> {
  if (versionId) {
    return loadTaxonomyVersionRowById(versionId);
  }
  return ensureBootstrapTaxonomyVersion();
}

async function loadTaxonomyDomainKeys(versionId: string): Promise<string[]> {
  const rows = await pool.query<{ domain_key: string }>(
    `SELECT domain_key
     FROM taxonomy_domains
     WHERE taxonomy_version_id = $1::uuid
       AND status = 'active'
     ORDER BY domain_key ASC`,
    [versionId]
  );
  return rows.rows.map((row) => row.domain_key);
}

async function loadTaxonomyLensKeys(versionId: string): Promise<string[]> {
  const rows = await pool.query<{ lens_key: string }>(
    `SELECT lens_key
     FROM taxonomy_lenses
     WHERE taxonomy_version_id = $1::uuid
       AND status = 'active'
     ORDER BY lens_key ASC`,
    [versionId]
  );
  return rows.rows.map((row) => row.lens_key);
}

async function loadTaxonomySupportRows(versionId: string, chatNamespace: string): Promise<TaxonomySupportRow[]> {
  const rows = await pool.query<{
    taxonomy_version_id: string;
    chat_namespace: string;
    domain_key: string;
    lens_key: string;
    support_status: "supported" | "unsupported";
    evidence_count: string;
    support_count: string;
    avg_domain_score: string;
    sample_evidence_ids: string[] | string;
    sample_conversation_ids: string[] | string;
    rationale: string | null;
    metadata: Record<string, unknown> | null;
    updated_at: string;
  }>(
    `SELECT
       taxonomy_version_id::text,
       chat_namespace,
       domain_key,
       lens_key,
       support_status,
       evidence_count::text,
       support_count::text,
       avg_domain_score::text,
       COALESCE(sample_evidence_ids::text, '{}') AS sample_evidence_ids,
       COALESCE(sample_conversation_ids::text, '{}') AS sample_conversation_ids,
       rationale,
       metadata,
       updated_at::text
     FROM taxonomy_pair_support
     WHERE taxonomy_version_id = $1::uuid
       AND chat_namespace = $2
     ORDER BY domain_key ASC, lens_key ASC`,
    [versionId, chatNamespace]
  );
  return rows.rows.map((row) => ({
    taxonomyVersionId: row.taxonomy_version_id,
    chatNamespace: row.chat_namespace,
    domainKey: row.domain_key,
    lensKey: row.lens_key,
    supportStatus: row.support_status,
    evidenceCount: Number(row.evidence_count ?? 0),
    supportCount: Number(row.support_count ?? 0),
    avgDomainScore: Number(row.avg_domain_score ?? 0),
    sampleEvidenceIds: Array.isArray(row.sample_evidence_ids)
      ? row.sample_evidence_ids.map(String)
      : parsePgTextArray(String(row.sample_evidence_ids ?? "{}")),
    sampleConversationIds: Array.isArray(row.sample_conversation_ids)
      ? row.sample_conversation_ids.map(String)
      : parsePgTextArray(String(row.sample_conversation_ids ?? "{}")),
    rationale: row.rationale,
    metadata: row.metadata ?? {},
    updatedAt: row.updated_at
  }));
}

async function recordBenchmarkAuthoringCall(metric: {
  domain: string;
  lens: string;
  window: string;
  actorName: string | null;
  durationMs: number;
  ok: boolean;
  status: "ok" | "http_error" | "invalid_json" | "request_failed" | "no_model";
  detail?: string | null;
}): Promise<void> {
  try {
    await appendFile(
      AUTHORING_TIMING_LOG_PATH,
      `${JSON.stringify({
        recordedAt: nowIso(),
        ...metric
      })}\n`,
      "utf8"
    );
  } catch {
    // best-effort timing log
  }
}

function compactText(text: string, max = 180): string {
  const normalized = String(text ?? "").replace(/\s+/g, " ").trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 3)}...`;
}

function relativeWindowPhrase(timestampIso: string | null): string {
  if (!timestampIso) return "recently";
  const ts = Date.parse(timestampIso);
  if (!Number.isFinite(ts)) return "recently";
  const deltaDays = Math.floor((Date.now() - ts) / 86400000);
  if (deltaDays <= 7) return "in the last week";
  if (deltaDays <= 31) return "in the last month";
  if (deltaDays <= 90) return "in the last quarter";
  return "this year";
}

function cleanAnchorSnippet(content: string): { snippet: string; weak: boolean } {
  const raw = String(content ?? "")
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/[`*_#>\[\]\(\)\{\}|]/g, " ")
    .replace(/["']/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const firstSentence = raw.split(/[.!?]/)[0]?.trim() ?? raw;
  const tokens = firstSentence.split(/\s+/).filter(Boolean);
  const short = tokens.slice(0, 16).join(" ");
  const weak = tokens.length < 4 || short.length < 18;
  return { snippet: compactText(short, 110), weak };
}

function lowerText(value: string | null | undefined): string {
  return String(value ?? "").toLowerCase();
}

const QUESTION_GROUNDING_STOPWORDS = new Set([
  "about", "after", "again", "also", "am", "and", "any", "are", "around", "back", "been", "before",
  "being", "between", "both", "bring", "can", "did", "does", "for", "from", "get", "got", "had",
  "have", "here", "into", "just", "last", "like", "made", "make", "more", "most", "much", "need",
  "next", "our", "over", "plan", "plans", "please", "recent", "recently", "regarding", "said",
  "say", "should", "some", "something", "talk", "talked", "that", "the", "their", "them", "there",
  "these", "this", "those", "through", "trip", "update", "updates", "was", "were", "what", "when",
  "where", "which", "while", "will", "with", "would", "year", "your"
]);

function extractConcreteCueTerms(rows: SeedEvidenceCandidate[], actorName: string | null): string[] {
  const counts = new Map<string, number>();
  const actorTokens = new Set(
    uniqueNames([actorName, ...rows.map((row) => row.actor_name)])
      .flatMap((name) => name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean))
  );
  for (const row of rows) {
    const matches = lowerText(row.content).match(/\b[a-z][a-z0-9._-]{3,}\b/g) ?? [];
    for (const token of matches) {
      if (QUESTION_GROUNDING_STOPWORDS.has(token)) continue;
      if (actorTokens.has(token)) continue;
      counts.set(token, Number(counts.get(token) ?? 0) + 1);
    }
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length || a[0].localeCompare(b[0]))
    .map(([token]) => token)
    .slice(0, 12);
}

function dominantSpeakerProfile(rows: SeedEvidenceCandidate[]): {
  dominantUserRows: number;
  dominantOtherName: string | null;
  dominantOtherRows: number;
} {
  let dominantUserRows = 0;
  const others = new Map<string, { name: string; count: number }>();
  for (const row of rows) {
    const actorType = lowerText(row.actor_type);
    const name = String(row.actor_name ?? "").trim();
    if (actorType === "user") {
      dominantUserRows += 1;
      continue;
    }
    if (!isLikelyName(name)) continue;
    const key = name.toLowerCase();
    const entry = others.get(key) ?? { name, count: 0 };
    entry.count += 1;
    others.set(key, entry);
  }
  const topOther = Array.from(others.values()).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))[0] ?? null;
  return {
    dominantUserRows,
    dominantOtherName: topOther?.name ?? null,
    dominantOtherRows: topOther?.count ?? 0
  };
}

function preferredVoicesForStatementOwner(role: "user" | "other_human" | "assistant_or_system" | "mixed"): Array<"user_first_person" | "user_about_other" | "assistant_proxy"> {
  switch (role) {
    case "user":
      return ["user_first_person", "assistant_proxy"];
    case "other_human":
      return ["user_about_other", "assistant_proxy"];
    case "assistant_or_system":
      return ["user_first_person", "assistant_proxy"];
    default:
      return ["user_first_person", "user_about_other", "assistant_proxy"];
  }
}

function inferStatementOwner(anchor: SeedEvidenceCandidate, contextRows: SeedEvidenceCandidate[]): {
  statementOwnerName: string | null;
  statementOwnerRole: "user" | "other_human" | "assistant_or_system" | "mixed";
  preferredQuestionVoices: Array<"user_first_person" | "user_about_other" | "assistant_proxy">;
} {
  const anchorActorType = lowerText(anchor.actor_type);
  const anchorActorName = String(anchor.actor_name ?? "").trim() || null;
  if (anchorActorType === "user") {
    return {
      statementOwnerName: anchorActorName,
      statementOwnerRole: "user",
      preferredQuestionVoices: preferredVoicesForStatementOwner("user")
    };
  }
  if (anchorActorType === "assistant" || anchorActorType === "system") {
    return {
      statementOwnerName: anchorActorName,
      statementOwnerRole: "assistant_or_system",
      preferredQuestionVoices: preferredVoicesForStatementOwner("assistant_or_system")
    };
  }
  if (isLikelyName(anchorActorName)) {
    return {
      statementOwnerName: anchorActorName,
      statementOwnerRole: "other_human",
      preferredQuestionVoices: preferredVoicesForStatementOwner("other_human")
    };
  }
  const dominantSpeaker = dominantSpeakerProfile(contextRows);
  if (dominantSpeaker.dominantOtherName && dominantSpeaker.dominantOtherRows > dominantSpeaker.dominantUserRows) {
    return {
      statementOwnerName: dominantSpeaker.dominantOtherName,
      statementOwnerRole: "other_human",
      preferredQuestionVoices: preferredVoicesForStatementOwner("other_human")
    };
  }
  return {
    statementOwnerName: anchorActorName,
    statementOwnerRole: "mixed",
    preferredQuestionVoices: preferredVoicesForStatementOwner("mixed")
  };
}

function buildOracleSearchQuery(question: string): string {
  const tokens = lowerText(question).match(/\b[a-z][a-z0-9._-]{3,}\b/g) ?? [];
  const filtered = Array.from(new Set(
    tokens.filter((token) => !QUESTION_GROUNDING_STOPWORDS.has(token))
  ));
  return filtered.slice(0, 8).join(" ").trim() || String(question ?? "").trim();
}

function looksLikeFileMetaFragment(content: string): boolean {
  const text = lowerText(content);
  return (
    /full file|entire file|fixed import|src\/|package\.json|tsconfig|patch|diff|line \d+|column \d+/.test(text)
    || /import\s+\{/.test(text)
    || /from\s+["'][^"']+["']/.test(text)
  );
}

function looksLikeCodeOnly(content: string): boolean {
  const text = String(content ?? "");
  const codeHits = (text.match(/\b(const|let|function|return|import|export|class|await|console\.log)\b/g) ?? []).length;
  const proseHits = (text.match(/\b(i|we|you|need|want|should|because|issue|problem|conversation|chat|message)\b/gi) ?? []).length;
  return codeHits >= 3 && proseHits <= 1;
}

function rejectAnchorReason(content: string, domainScore: number): string | null {
  const { weak } = cleanAnchorSnippet(content);
  if (weak) return "low_signal_anchor";
  if (looksLikeFileMetaFragment(content)) return "file_or_meta_fragment";
  if (looksLikeCodeOnly(content)) return "code_only_without_intent";
  if (domainScore < 0.28) return "weak_domain_mapping";
  return null;
}

function questionTopicPhrase(focusArea: string, domain: string): string {
  switch (focusArea) {
    case "software troubleshooting":
      return "software debugging";
    case "battery range planning":
      return "battery range planning";
    case "personal energy levels":
      return "your energy levels";
    case "financial planning":
      return "money and asset calculations";
    case "work execution":
      return "work execution";
    case "relationship conversations":
      if (domain === "romantic_relationship") return "your relationship";
      if (domain === "family_relationships") return "family matters";
      if (domain === "friendships") return "your friendship";
      if (domain === "social_graph_dynamics") return "your social circle";
      return "the relationship topic";
    case "message drafting":
      return "message drafting";
    case "risk and safety decisions":
      return "risk or safety decisions";
    case "health routines":
      return "health routines";
    case "thread reconstruction":
      return "that conversation thread";
    case "timeline reconstruction":
      return "the timeline";
    default:
      return domain.replace(/_/g, " ");
  }
}

function conversationalWindowPhrase(window: string, mode: "recall" | "trend" = "recall"): string {
  const normalized = String(window ?? "").trim().toLowerCase() || "recently";
  if (mode === "trend") {
    if (normalized === "in the last week") return "over the last week";
    if (normalized === "in the last month") return "over the last month";
    if (normalized === "in the last quarter") return "over the last few months";
    if (normalized === "this year") return "this year";
    return `over ${normalized.replace(/^in\s+/, "")}`;
  }
  if (normalized === "in the last week") return "from the last week";
  if (normalized === "in the last month") return "from the last month";
  if (normalized === "in the last quarter") return "from the last few months";
  if (normalized === "this year") return "from this year";
  if (normalized === "recently") return "from recently";
  return `from ${normalized.replace(/^in\s+/, "")}`;
}

function recallLead(params: {
  actorName?: string | null;
  window: string;
  topicPhrase: string;
}): string {
  const actor = isLikelyName(params.actorName) ? ` with ${String(params.actorName).trim()}` : "";
  return `I'm trying to find a conversation${actor} ${conversationalWindowPhrase(params.window)} about ${params.topicPhrase}.`;
}

function buildQuestionTemplate(params: {
  lens: string;
  domain: string;
  focusArea: string;
  actorName?: string | null;
  window: string;
  mode?: "base" | "paraphrase" | "clarify" | "temporal" | "disambiguation";
}): string {
  let topicPhrase = questionTopicPhrase(params.focusArea, params.domain);
  if (isLikelyName(params.actorName) && topicPhrase === "your relationship") topicPhrase = "our relationship";
  if (isLikelyName(params.actorName) && topicPhrase === "your friendship") topicPhrase = "our friendship";
  const lead = recallLead({
    actorName: params.actorName,
    window: params.window,
    topicPhrase
  });
  const trendLead = `Looking ${conversationalWindowPhrase(params.window, "trend")} at my conversations about ${topicPhrase},`;
  const mode = params.mode ?? "base";
  const diagnosticTail = (
    params.focusArea === "software troubleshooting"
    || params.focusArea === "battery range planning"
    || params.focusArea === "risk and safety decisions"
  )
    ? "what seemed to be causing the issue?"
    : "what seemed to be driving it?";

  if (mode === "clarify") {
    return `I'm trying to find a conversation ${conversationalWindowPhrase(params.window)} but I can't remember which one. Can you help me locate the right thread?`;
  }
  if (mode === "temporal") {
    return `${trendLead} what changed most?`;
  }
  if (mode === "disambiguation") {
    return `${lead} Can you tell me which thread is actually the important one, not just a passing mention?`;
  }
  if (mode === "paraphrase") {
    return `${lead} Can you find it and pull out the key takeaway?`;
  }

  switch (params.lens) {
    case "descriptive":
      return `${lead} Can you find it and summarize the main point?`;
    case "diagnostic":
      return `${lead} Can you find it and tell me ${diagnosticTail}`;
    case "predictive":
      return `${lead} Based on that thread, what seemed likely to happen next?`;
    case "prescriptive":
      return `${lead} What next step was being recommended there?`;
    case "causal_hypotheses":
      return `${lead} What likely drove the change being discussed?`;
    case "trend_trajectory":
      return `${trendLead} what trend stands out?`;
    case "outlier_detection":
      return `${trendLead} was there any standout moment, and what made it unusual?`;
    case "counterfactuals":
      return `${lead} If one factor had changed, what outcome would likely have been different?`;
    case "confidence_scoring":
      return `${lead} How confident should I be in taking one conclusion from it?`;
    case "actionability":
      return `${lead} What concrete action was proposed to move things forward?`;
    case "actor_attribution":
      return `${lead} What did the other person actually say there?`;
    case "thread_reconstruction":
      return `${lead} Can you identify the exact thread and summarize why it matters?`;
    case "timeline_reconstruction":
      return `${lead} Can you reconstruct the timeline of what happened there?`;
    default:
      return `${lead} Can you summarize what mattered there?`;
  }
}

function scoreCaseQuality(params: {
  question: string;
  ambiguityClass: "clear" | "clarify_required" | "unresolved";
  clarificationPrompt: string | null;
  evidenceIds: string[];
  anchorRejectReason: string | null;
  domainScore: number;
}): {
  status: "pass" | "fail";
  score: number;
  reasons: string[];
  dimensions: {
    naturalness: number;
    answerability: number;
    ambiguityCorrectness: number;
    evidenceGrounding: number;
  };
} {
  const question = String(params.question ?? "").trim();
  const qLower = question.toLowerCase();
  const reasons: string[] = [];

  let naturalness = 1;
  if (question.length < 30 || question.length > 220) naturalness -= 0.25;
  if (qLower.includes('"') || qLower.includes(" around ")) naturalness -= 0.25;
  if (looksLikeFileMetaFragment(question)) naturalness -= 0.5;
  if (/json|expected answer|evidence ids/.test(qLower)) naturalness -= 0.4;

  let answerability = 1;
  if (params.evidenceIds.length === 0) answerability -= 0.6;
  if (/\bthis|that|it|there|here\b/.test(qLower) && params.ambiguityClass === "clear") answerability -= 0.2;
  if (qLower.includes("can't remember") && params.ambiguityClass === "clear") answerability -= 0.3;

  let ambiguityCorrectness = 1;
  const soundsAmbiguous = /can't remember|not sure|which one|right thread/.test(qLower);
  if (params.ambiguityClass === "clarify_required" && !soundsAmbiguous) ambiguityCorrectness -= 0.4;
  if (params.ambiguityClass === "clarify_required" && !params.clarificationPrompt) ambiguityCorrectness -= 0.4;
  if (params.ambiguityClass === "clear" && soundsAmbiguous) ambiguityCorrectness -= 0.45;

  let evidenceGrounding = clamp01(params.domainScore, 0.2);
  if (params.anchorRejectReason) evidenceGrounding -= 0.65;

  naturalness = clamp01(naturalness, 0);
  answerability = clamp01(answerability, 0);
  ambiguityCorrectness = clamp01(ambiguityCorrectness, 0);
  evidenceGrounding = clamp01(evidenceGrounding, 0);

  if (naturalness < 0.72) reasons.push("question_not_natural_enough");
  if (answerability < 0.72) reasons.push("question_not_answerable_enough");
  if (ambiguityCorrectness < 0.72) reasons.push("ambiguity_label_mismatch");
  if (evidenceGrounding < 0.72) reasons.push(params.anchorRejectReason ?? "question_not_grounded_enough");

  const score = (naturalness + answerability + ambiguityCorrectness + evidenceGrounding) / 4;
  return {
    status: score >= 0.72 && reasons.length === 0 ? "pass" : "fail",
    score,
    reasons,
    dimensions: {
      naturalness,
      answerability,
      ambiguityCorrectness,
      evidenceGrounding
    }
  };
}

function inferFocusArea(domain: string, content: string): string {
  if (["financial_behavior", "financial_planning"].includes(domain)) {
    return "financial planning";
  }
  if (["romantic_relationship", "family_relationships", "friendships", "social_graph_dynamics"].includes(domain)) {
    return "relationship conversations";
  }
  if (["sleep_recovery", "nutrition_eating_behavior", "exercise_sports", "medical_context", "health_routines"].includes(domain)) {
    return "health routines";
  }
  if (["energy_management", "battery_range_planning"].includes(domain)) {
    const text = String(content ?? "").toLowerCase();
    if (/(battery|range|charger|supercharger|miles|mile|tesla)/.test(text)) return "battery range planning";
    if (/(tired|fatigue|rest|sleep|burned out|burnt out)/.test(text)) return "personal energy levels";
    return "energy management";
  }
  if (["software_troubleshooting"].includes(domain)) {
    return "software troubleshooting";
  }
  if (["message_drafting"].includes(domain)) {
    return "message drafting";
  }
  if (["communication_style"].includes(domain)) {
    return "communication";
  }
  if (["risk_safety", "ethics_privacy_boundaries", "risk_safety_decisions"].includes(domain)) {
    return "risk and safety decisions";
  }
  if (["work_performance", "career_trajectory", "attention_productivity", "learning_growth", "work_execution"].includes(domain)) {
    return "work and execution";
  }

  const text = String(content ?? "").toLowerCase();
  if (/(server|router|api|deploy|docker|bug|debug|log|database|script|build|runtime|timeout)/.test(text)) {
    return "software troubleshooting";
  }
  if (/(401k|roth|bank|balance|asset|portfolio|money|commission|loan|house|spouse share)/.test(text)) {
    return "financial planning";
  }
  if (/(wife|husband|marriage|spouse|family|friend|relationship|costco)/.test(text)) {
    return "relationship conversations";
  }
  if (/(subject line|email|message|tone|wording|chat draft)/.test(text)) {
    return "message drafting";
  }
  if (/(sleep|workout|health|doctor|diet|exercise)/.test(text)) {
    return "health routines";
  }
  if (domain === "decision_behavior") return "decision-making";
  if (domain === "communication_style") return "communication";
  return domain.replace(/_/g, " ");
}

function isLikelyName(value: string | null | undefined): boolean {
  const v = String(value ?? "").trim();
  if (!v) return false;
  if (/^[a-f0-9-]{36}$/i.test(v)) return false;
  if (/^\+?\d[\d\s().-]{5,}$/.test(v)) return false;
  if (/^(you|assistant|system)$/i.test(v)) return false;
  return true;
}

function temporalQualifier(window: string): string {
  const w = String(window ?? "").trim();
  if (!w) return "recently";
  return w;
}

function quotedAnchor(snippet: string, focusArea: string): string {
  const clean = String(snippet ?? "").trim();
  if (!clean) return `that ${focusArea} topic`;
  return `"${clean}"`;
}

function clarificationPromptForDomain(domain: string, focusArea: string): string {
  switch (focusArea) {
    case "software troubleshooting":
      return "Which part of the software troubleshooting should I focus on?";
    case "financial planning":
      return "What exact financial measure should I focus on?";
    case "relationship conversations":
      return "Which relationship context should I focus on?";
    case "message drafting":
      return "What kind of message context should I focus on?";
    default:
      switch (domain) {
        case "decision_behavior":
          return "Which decision context should I focus on?";
        case "communication_style":
          return "Which communication context should I focus on?";
        case "financial_behavior":
          return "What exact financial scope should I use?";
        default:
          return `Can you clarify which part of ${domain.replace(/_/g, " ")} you want me to focus on?`;
      }
  }
}

function lensPrompt(lens: string, domain: string, window: string): string {
  const topic = domain.replace(/_/g, " ");
  switch (lens) {
    case "descriptive":
      return `What are the strongest signals about my ${topic} ${window}?`;
    case "diagnostic":
      return `Why did my ${topic} pattern look the way it did ${window}?`;
    case "predictive":
      return `Based on ${window}, what is likely next in my ${topic}?`;
    case "prescriptive":
      return `Given my ${topic} ${window}, what should I do next?`;
    case "causal_hypotheses":
      return `What likely drove changes in my ${topic} ${window}?`;
    case "trend_trajectory":
      return `How is my ${topic} trending ${window}?`;
    case "outlier_detection":
      return `Any outlier moments in my ${topic} ${window}, and why?`;
    case "counterfactuals":
      return `If one key factor changed, how might my ${topic} differ ${window}?`;
    case "confidence_scoring":
      return `How confident should we be about conclusions on my ${topic} ${window}?`;
    case "actionability":
      return `What concrete next step is most actionable for my ${topic} ${window}?`;
    default:
      return `What does my ${topic} look like ${window}?`;
  }
}

function buildGroundedQuestion(params: {
  lens: string;
  domain: string;
  window: string;
  anchorContent: string;
  contextContent?: string;
  actorName?: string | null;
  sourceSystem?: string | null;
  domainScore?: number;
}): {
  question: string;
  anchorSnippet: string;
  focusArea: string;
  ambiguityClass: "clear" | "clarify_required" | "unresolved";
  clarificationPrompt: string | null;
  expectedBehavior: "answer_now" | "clarify_first";
  qualityGate: {
    status: "pass" | "fail";
    score: number;
    reasons: string[];
    dimensions: {
      naturalness: number;
      answerability: number;
      ambiguityCorrectness: number;
      evidenceGrounding: number;
    };
  };
} {
  const { snippet } = cleanAnchorSnippet(params.anchorContent);
  const focusArea = inferFocusArea(params.domain, String(params.contextContent ?? params.anchorContent));
  const window = temporalQualifier(params.window);
  const anchorRejectReason = rejectAnchorReason(params.anchorContent, Number(params.domainScore ?? 0));
  const clarificationPrompt = null;
  const ambiguityClass = anchorRejectReason || !snippet ? "unresolved" : "clear";
  const question = buildQuestionTemplate({
    lens: params.lens,
    domain: params.domain,
    focusArea,
    actorName: params.actorName,
    window,
    mode: "base"
  });
  const qualityGate = scoreCaseQuality({
    question,
    ambiguityClass,
    clarificationPrompt,
    evidenceIds: snippet ? [snippet] : [],
    anchorRejectReason,
    domainScore: Number(params.domainScore ?? 0)
  });
  return {
    question: compactText(question, 220),
    anchorSnippet: snippet,
    focusArea,
    ambiguityClass: qualityGate.status === "pass" ? ambiguityClass : "unresolved",
    clarificationPrompt,
    expectedBehavior: "answer_now",
    qualityGate
  };
}

const MIN_DOMAIN_SCORE_FOR_CASE = 0.78;
const MIN_DOMAIN_SCORE_FOR_SUPPORT_SCAN = 0.56;
const MAX_DOMAIN_ANCHORS_TO_SCAN = 18;
const TAXONOMY_FACET_TYPES = [
  "actor_name",
  "group_label",
  "thread_title",
  "source_system",
  "month_bucket"
] as const;

type TaxonomyFacetType = (typeof TAXONOMY_FACET_TYPES)[number];

type SeedEvidenceCandidate = {
  canonical_id: string;
  memory_id: string;
  conversation_id: string;
  source_conversation_id?: string | null;
  actor_id: string | null;
  actor_name: string | null;
  actor_type: string | null;
  source_system: string;
  source_timestamp: string | null;
  content: string;
  has_plan_block: boolean;
  domain_score: number;
  metadata?: Record<string, unknown> | null;
};

function uniqSeedRows(rows: SeedEvidenceCandidate[], limit: number): SeedEvidenceCandidate[] {
  const out: SeedEvidenceCandidate[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.canonical_id)) continue;
    seen.add(row.canonical_id);
    out.push(row);
    if (out.length >= limit) break;
  }
  return out;
}

function actorIdentityKey(row: Pick<SeedEvidenceCandidate, "actor_id" | "actor_name" | "actor_type">): string {
  const actorId = String(row.actor_id ?? "").trim();
  if (actorId) return actorId;
  const actorName = String(row.actor_name ?? "").trim().toLowerCase();
  if (actorName) return `${String(row.actor_type ?? "").trim().toLowerCase()}:${actorName}`;
  return "";
}

function rowMetadata(row: Pick<SeedEvidenceCandidate, "metadata">): Record<string, unknown> {
  return row.metadata && typeof row.metadata === "object" ? row.metadata : {};
}

function metadataStringArray(row: Pick<SeedEvidenceCandidate, "metadata">, key: string): string[] {
  const value = rowMetadata(row)[key];
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => String(item ?? "").trim())
    .filter(Boolean);
}

function parseConversationLabel(sourceConversationId: string | null | undefined): string | null {
  if (!sourceConversationId) return null;
  const raw = String(sourceConversationId).trim();
  if (!raw) return null;
  const patterns = [
    /whatsapp chat - (.+?)(?:\.zip)?___chat$/i,
    /whatsapp chat with (.+?)(?:\.zip)?___chat$/i,
    /whatsapp chat - (.+)$/i
  ];
  for (const pattern of patterns) {
    const match = raw.match(pattern);
    if (match?.[1]) return match[1].replace(/_/g, " ").trim();
  }
  return raw;
}

function blendDerivedScore(scores: number[], text: string, patterns: RegExp[], floor = 0): number {
  const base = scores.reduce((max, value) => Math.max(max, Number(value ?? 0)), floor);
  const hits = patterns.reduce((count, pattern) => count + (pattern.test(text) ? 1 : 0), 0);
  if (hits <= 0) return clamp01(base, 0);
  return clamp01(Math.max(base, Math.min(1, base + 0.14 + hits * 0.09)), 0);
}

function deriveVersionedDomainScores(params: {
  content: string;
  sourceSystem: string;
  sourceConversationId?: string | null;
  storedScoreMap: Record<string, unknown>;
  inferredScoreMap: Record<string, number>;
}): Record<string, number> {
  const text = lowerText(params.content);
  const stored = params.storedScoreMap ?? {};
  const inferred = params.inferredScoreMap ?? {};
  const getScore = (key: string): number => Math.max(
    Number(stored[key] ?? 0),
    Number(inferred[key as keyof typeof inferred] ?? 0)
  );

  const derived: Record<string, number> = {};
  derived.financial_planning = blendDerivedScore(
    [getScore("financial_behavior"), getScore("life_goals_planning")],
    text,
    [/\b(401k|roth|ira|portfolio|asset|assets|balance|balances|net worth|budget|spouse share|premarital|marital|brokerage|house equity|commission)\b/i]
  );
  derived.health_routines = blendDerivedScore(
    [
      getScore("sleep_recovery"),
      getScore("nutrition_eating_behavior"),
      getScore("exercise_sports"),
      getScore("medical_context"),
      getScore("habit_systems")
    ],
    text,
    [/\b(workout|exercise|diet|meal|protein|sleep|rest|doctor|vitamin|routine|medication|recovery)\b/i]
  );
  derived.message_drafting = blendDerivedScore(
    [getScore("communication_style"), getScore("digital_behavior")],
    text,
    [/\b(subject line|draft|drafting|wording|message|email|send this|rewrite|tone)\b/i]
  );
  derived.software_troubleshooting = blendDerivedScore(
    [getScore("digital_behavior"), getScore("work_performance"), getScore("work_execution")],
    text,
    [/\b(error|debug|bug|router|server|deploy|docker|runtime|import|build|script|repo|trace|timeout|log)\b/i]
  );
  derived.work_execution = blendDerivedScore(
    [getScore("work_performance"), getScore("career_trajectory"), getScore("attention_productivity"), getScore("digital_behavior")],
    text,
    [/\b(deadline|deliver|delivery|ship|execute|execution|ticket|sprint|client|meeting|deployment|fix|production)\b/i]
  );
  derived.battery_range_planning = blendDerivedScore(
    [getScore("energy_management"), getScore("travel_mobility"), getScore("digital_behavior")],
    text,
    [/\b(battery|range|supercharger|charger|miles|mile|tesla|route update|route|charge stop)\b/i]
  );
  derived.risk_safety_decisions = blendDerivedScore(
    [getScore("risk_safety"), getScore("ethics_privacy_boundaries")],
    text,
    [/\b(risk|safety|unsafe|legal|liability|fraud|scam|kill chain|surveillance|privacy|consent|boundary)\b/i]
  );
  return Object.fromEntries(
    Object.entries(derived).filter(([, score]) => Number(score ?? 0) > 0)
  );
}

function isLikelyGroupConversationLabel(label: string | null | undefined): boolean {
  const text = lowerText(label);
  if (!text) return false;
  return /\b(group|team|squad|community|fam|gang|crew|circle|wedding|neighborhood|family|friends)\b/.test(text);
}

function sourceTimeMs(row: Pick<SeedEvidenceCandidate, "source_timestamp">): number {
  const ts = Date.parse(String(row.source_timestamp ?? ""));
  return Number.isFinite(ts) ? ts : 0;
}

function sortConversationRows(rows: SeedEvidenceCandidate[]): SeedEvidenceCandidate[] {
  return [...rows].sort((a, b) => {
    const diff = sourceTimeMs(a) - sourceTimeMs(b);
    if (diff !== 0) return diff;
    return String(a.canonical_id).localeCompare(String(b.canonical_id));
  });
}

function buildCaseContextRows(anchor: SeedEvidenceCandidate, conversationRows: SeedEvidenceCandidate[]): SeedEvidenceCandidate[] {
  const ordered = sortConversationRows(
    conversationRows.filter((row) => row.conversation_id === anchor.conversation_id)
  );
  const anchorIndex = ordered.findIndex((row) => row.canonical_id === anchor.canonical_id);
  if (anchorIndex < 0) return [anchor];

  const localWindow = ordered.slice(Math.max(0, anchorIndex - 2), Math.min(ordered.length, anchorIndex + 3));
  const anchorActorKey = actorIdentityKey(anchor);
  const sameActorLocal = anchorActorKey
    ? localWindow.filter((row) => actorIdentityKey(row) === anchorActorKey)
    : [];
  if (sameActorLocal.length >= 2) {
    return uniqSeedRows([...sameActorLocal, ...localWindow], 4);
  }
  if (localWindow.length >= 2) {
    return uniqSeedRows(localWindow, 4);
  }
  return [anchor];
}

function sampleTemporalSeriesRows(rows: SeedEvidenceCandidate[], limit = 8, anchorId?: string): SeedEvidenceCandidate[] {
  const ordered = sortConversationRows(rows);
  if (ordered.length <= limit) return uniqSeedRows(ordered, limit);
  const anchorIndex = anchorId ? ordered.findIndex((row) => row.canonical_id === anchorId) : -1;
  const picks = new Set<number>([0, ordered.length - 1]);
  if (anchorIndex >= 0) picks.add(anchorIndex);
  const evenlyNeeded = Math.max(0, limit - picks.size);
  for (let i = 1; i <= evenlyNeeded; i += 1) {
    const idx = Math.round((i * (ordered.length - 1)) / (evenlyNeeded + 1));
    picks.add(Math.max(0, Math.min(ordered.length - 1, idx)));
  }
  const selected = Array.from(picks)
    .sort((a, b) => a - b)
    .map((idx) => ordered[idx]);
  return uniqSeedRows(selected, limit);
}

function buildTemporalCaseContextRows(anchor: SeedEvidenceCandidate, conversationRows: SeedEvidenceCandidate[]): SeedEvidenceCandidate[] {
  const ordered = sortConversationRows(
    conversationRows.filter((row) => row.conversation_id === anchor.conversation_id)
  );
  if (ordered.length === 0) return [anchor];
  const anchorActorKey = actorIdentityKey(anchor);
  const sameActorSeries = anchorActorKey
    ? ordered.filter((row) => actorIdentityKey(row) === anchorActorKey)
    : [];
  if (sameActorSeries.length >= 3 && temporalSpreadDays(sameActorSeries) >= 7) {
    return sampleTemporalSeriesRows(sameActorSeries, 8, anchor.canonical_id);
  }
  if (ordered.length >= 3 && temporalSpreadDays(ordered) >= 7) {
    return sampleTemporalSeriesRows(ordered, 8, anchor.canonical_id);
  }
  return buildCaseContextRows(anchor, conversationRows);
}

function buildLensAwareContextRows(params: {
  anchor: SeedEvidenceCandidate;
  conversationRows: SeedEvidenceCandidate[];
  lens: string;
}): SeedEvidenceCandidate[] {
  if (params.lens === "trend_trajectory" || params.lens === "outlier_detection") {
    return buildTemporalCaseContextRows(params.anchor, params.conversationRows);
  }
  return buildCaseContextRows(params.anchor, params.conversationRows);
}

function resolveQuestionActorName(anchor: SeedEvidenceCandidate, contextRows: SeedEvidenceCandidate[]): string | null {
  const candidates = new Map<string, { name: string; count: number }>();
  for (const row of contextRows) {
    const actorType = String(row.actor_type ?? "").trim().toLowerCase();
    if (actorType === "user") continue;
    if (!isLikelyName(row.actor_name)) continue;
    const key = actorIdentityKey(row);
    if (!key) continue;
    const entry = candidates.get(key) ?? { name: String(row.actor_name ?? "").trim(), count: 0 };
    entry.count += 1;
    candidates.set(key, entry);
  }
  const ranked = Array.from(candidates.values()).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  if (ranked.length === 1) return ranked[0].name;

  const anchorActorType = String(anchor.actor_type ?? "").trim().toLowerCase();
  if (anchorActorType && anchorActorType !== "user" && isLikelyName(anchor.actor_name)) {
    const anchorKey = actorIdentityKey(anchor);
    const anchorEntry = anchorKey ? candidates.get(anchorKey) : null;
    if (anchorEntry && anchorEntry.count >= 2) return anchorEntry.name;
  }
  return null;
}

function combinedEvidenceText(rows: SeedEvidenceCandidate[]): string {
  return rows.map((row) => String(row.content ?? "")).join(" \n ").toLowerCase();
}

function hasAnyPattern(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

function domainSemanticMismatchReason(domain: string, contextRows: SeedEvidenceCandidate[]): string | null {
  const text = combinedEvidenceText(contextRows);
  switch (domain) {
    case "romantic_relationship": {
      const strongRomantic = [
        /\b(spouse|girlfriend|boyfriend|fiance|fiancée|partner)\b/,
        /\b(my wife|my husband|our marriage|we got married|got married|married|divorce|separated)\b/,
        /\b(premarital|marital|spouse share|relationship with my wife|relationship with my husband)\b/
      ];
      return hasAnyPattern(text, strongRomantic) ? null : "domain_semantic_mismatch";
    }
    case "family_relationships": {
      const familySignals = [
        /\b(mom|mother|dad|father|uncle|aunt|cousin|brother|sister|grandma|grandpa|family|son|daughter)\b/,
        /\b(m[aã]e|pai|tio|tia|irm[aã]o|irm[aã]|filh[aã]o|filh[aã]|prima|primo)\b/
      ];
      return hasAnyPattern(text, familySignals) ? null : "domain_semantic_mismatch";
    }
    case "friendships": {
      const friendshipSignals = [
        /\b(friend|friends|buddy|pal|hang out|best friend|close friend)\b/,
        /\b(amigo|amiga|amizade)\b/
      ];
      return hasAnyPattern(text, friendshipSignals) ? null : "domain_semantic_mismatch";
    }
    case "energy_management": {
      const energySignals = [
        /\b(battery|charge|charger|range|supercharger|kwh|energy|mileage|miles)\b/,
        /\b(tired|fatigue|rest|sleep|recharge)\b/
      ];
      return hasAnyPattern(text, energySignals) ? null : "domain_semantic_mismatch";
    }
    case "battery_range_planning": {
      const rangeSignals = [
        /\b(battery|charge|charger|range|supercharger|kwh|mileage|miles|tesla|route)\b/,
        /\b(stop to charge|charging stop|route update)\b/
      ];
      return hasAnyPattern(text, rangeSignals) ? null : "domain_semantic_mismatch";
    }
    case "financial_behavior": {
      const financialSignals = [
        /\b(401k|roth|balance|bank|asset|portfolio|money|loan|debt|equity|brokerage|savings|cash|house)\b/,
        /\b(premarital|marital|commission|robinhood|ira)\b/
      ];
      return hasAnyPattern(text, financialSignals) ? null : "domain_semantic_mismatch";
    }
    case "financial_planning": {
      const planningSignals = [
        /\b(401k|roth|ira|asset|assets|portfolio|balance|balances|equity|house|brokerage|spouse share|summary|totals)\b/,
        /\b(financial plan|asset calculation|premarital|marital|estimated spouse share)\b/
      ];
      return hasAnyPattern(text, planningSignals) ? null : "domain_semantic_mismatch";
    }
    case "health_routines": {
      const healthSignals = [
        /\b(workout|exercise|sleep|diet|meal|protein|doctor|routine|vitamin|recovery|rest)\b/,
        /\b(training|nutrition|medication|healthy|health)\b/
      ];
      return hasAnyPattern(text, healthSignals) ? null : "domain_semantic_mismatch";
    }
    case "message_drafting": {
      const draftSignals = [
        /\b(subject line|draft|drafting|wording|message|email|send this|tone|rewrite)\b/,
        /\b(may sound|too clinical|too heavy|how should i phrase)\b/
      ];
      return hasAnyPattern(text, draftSignals) ? null : "domain_semantic_mismatch";
    }
    case "software_troubleshooting": {
      const troubleshootingSignals = [
        /\b(error|debug|router|server|deploy|api|docker|runtime|log|import|build|trace|timeout)\b/,
        /\b(root cause|broken|fix|failure|issue)\b/
      ];
      return hasAnyPattern(text, troubleshootingSignals) ? null : "domain_semantic_mismatch";
    }
    case "work_execution": {
      const executionSignals = [
        /\b(deadline|deliver|delivery|ship|execute|execution|ticket|sprint|client|meeting|deployment|production)\b/,
        /\b(move this forward|next step|rollout|release)\b/
      ];
      return hasAnyPattern(text, executionSignals) ? null : "domain_semantic_mismatch";
    }
    case "risk_safety": {
      const riskSignals = [
        /\b(risk|safe|unsafe|danger|security|secure|threat|harm|guardrail)\b/,
        /\b(vulnerability|attack|breach|injury|safety)\b/
      ];
      return hasAnyPattern(text, riskSignals) ? null : "domain_semantic_mismatch";
    }
    case "risk_safety_decisions": {
      const riskSignals = [
        /\b(risk|safe|unsafe|danger|security|secure|threat|harm|guardrail|privacy|consent|boundary)\b/,
        /\b(legal|liability|kill chain|surveillance|weapons|mass domestic surveillance)\b/
      ];
      return hasAnyPattern(text, riskSignals) ? null : "domain_semantic_mismatch";
    }
    default:
      return null;
  }
}

function isHumanCenteredDomain(domain: string): boolean {
  return [
    "romantic_relationship",
    "family_relationships",
    "friendships",
    "social_graph_dynamics",
    "communication_style",
    "decision_behavior",
    "emotional_baseline",
    "mental_health_signals",
    "energy_management",
    "health_routines"
  ].includes(domain);
}

function temporalSpreadDays(rows: SeedEvidenceCandidate[]): number {
  const timestamps = rows
    .map((row) => Date.parse(String(row.source_timestamp ?? "")))
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);
  if (timestamps.length < 2) return 0;
  return Math.max(0, Math.floor((timestamps[timestamps.length - 1] - timestamps[0]) / 86400000));
}

function lensSupportFailureReason(params: {
  domain: string;
  lens: string;
  anchor: SeedEvidenceCandidate;
  contextRows: SeedEvidenceCandidate[];
  minDomainScore?: number;
}): string | null {
  const minDomainScore = Number(params.minDomainScore ?? MIN_DOMAIN_SCORE_FOR_CASE);
  if (params.anchor.domain_score < minDomainScore) return "weak_domain_mapping";
  const rejectReason = rejectAnchorReason(params.anchor.content, params.anchor.domain_score);
  if (rejectReason) return rejectReason;

  const text = combinedEvidenceText(params.contextRows);
  const rowCount = params.contextRows.length;
  const spreadDays = temporalSpreadDays(params.contextRows);
  const semanticMismatch = domainSemanticMismatchReason(params.domain, params.contextRows);
  if (semanticMismatch) return semanticMismatch;
  const hasActionSignal = /(should|need to|next step|plan to|action|send|file|reply|call|schedule|recommend|propose|proposed|move forward)/.test(text);
  const hasProblemSignal = /(issue|problem|stuck|blocked|error|fail|wrong|trouble|conflict|concern)/.test(text);
  const hasCausalSignal = /(because|reason|caused|cause|drove|driver|why|issue was|problem was|root cause|due to)/.test(text);
  const hasFutureSignal = /(will|likely|going to|expected to|next|soon|tomorrow|later|follow up)/.test(text);
  const hasCounterfactualSignal = /\b(if|had|would|could have|otherwise)\b/.test(text);
  const hasUncertaintySignal = /(not sure|unclear|maybe|might|probably|conflict|contradict|uncertain|confidence)/.test(text);
  const namedParticipants = uniqueNames(params.contextRows.map((row) => row.actor_name));
  const hasActorTarget = namedParticipants.some((name) => isLikelyName(name) && lowerText(name) !== lowerText(params.anchor.actor_name));
  const hasThreadTarget = params.contextRows.length >= 2 || Boolean(parseConversationLabel(params.anchor.source_conversation_id ?? params.anchor.conversation_id));
  const hasTimelineTarget = rowCount >= 2 && params.contextRows.some((row) => Boolean(row.source_timestamp));

  switch (params.lens) {
    case "descriptive":
      return null;
    case "diagnostic":
      if (rowCount < 2) return "lens_requires_supported_context";
      return hasCausalSignal || hasProblemSignal ? null : "lens_requires_explanation_signal";
    case "predictive":
      if (rowCount < 2) return "lens_requires_supported_context";
      return hasFutureSignal || hasActionSignal ? null : "lens_requires_future_signal";
    case "prescriptive":
    case "actionability":
      if (rowCount < 2) return "lens_requires_supported_context";
      return hasActionSignal ? null : "lens_requires_action_signal";
    case "causal_hypotheses":
      if (rowCount < 2) return "lens_requires_supported_context";
      return hasCausalSignal ? null : "lens_requires_causal_signal";
    case "trend_trajectory":
    case "outlier_detection":
      return rowCount >= 3 && spreadDays >= 7 ? null : "lens_requires_temporal_series";
    case "counterfactuals":
      if (rowCount < 2) return "lens_requires_supported_context";
      return hasCounterfactualSignal ? null : "lens_requires_counterfactual_signal";
    case "confidence_scoring":
      if (rowCount < 2) return "lens_requires_supported_context";
      return hasUncertaintySignal || rowCount >= 2 ? null : "lens_requires_uncertainty_signal";
    case "actor_attribution":
      return hasActorTarget || isLikelyName(params.anchor.actor_name) ? null : "lens_requires_actor_reference";
    case "thread_reconstruction":
      return hasThreadTarget ? null : "lens_requires_thread_context";
    case "timeline_reconstruction":
      return hasTimelineTarget ? null : "lens_requires_timeline_signal";
    default:
      return null;
  }
}

type AuthoringQuestionCandidate = {
  kind: string;
  question: string;
  rationale: string;
  expectedBehavior: "answer_now" | "clarify_first";
  clarificationQuestion: string | null;
  resolvedQuestionAfterClarification: string | null;
};

function uniqueNames(values: Array<string | null | undefined>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const name = String(value ?? "").trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

function inferConversationIntent(domain: string, text: string): string {
  const lower = text.toLowerCase();
  if (/(error|debug|router|server|deploy|route updated|supercharger)/.test(lower)) return "problem-solving";
  if (/(why|incorrect|not sure what you're trying to achieve|conflict|wrong|issue)/.test(lower)) return "disagreement";
  if (/(need to|should|tomorrow|next step|move forward|proposed|recommend)/.test(lower)) return "planning";
  if (/(subject line|wording|message|draft|send)/.test(lower)) return "drafting";
  if (domain === "message_drafting") return "drafting";
  if (domain === "software_troubleshooting") return "problem-solving";
  if (domain === "work_execution") return "execution planning";
  if (domain === "health_routines") return "habit planning";
  if (domain === "family_relationships" || domain === "romantic_relationship" || domain === "friendships") return "personal coordination";
  if (domain === "financial_behavior" || domain === "financial_planning") return "financial discussion";
  if (domain === "energy_management" || domain === "battery_range_planning") return "range or energy planning";
  if (domain === "risk_safety_decisions") return "risk evaluation";
  return "conversation analysis";
}

function inferSupportDepth(rows: SeedEvidenceCandidate[]): "thin" | "moderate" | "rich" {
  if (rows.length >= 4) return "rich";
  if (rows.length >= 2) return "moderate";
  return "thin";
}

function inferAmbiguityRisk(params: {
  actorName: string | null;
  contextRows: SeedEvidenceCandidate[];
  lens: string;
}): "low" | "medium" | "high" {
  if (!params.actorName) return "medium";
  if (params.contextRows.length <= 1) return "high";
  if (["diagnostic", "predictive", "prescriptive", "actionability", "confidence_scoring"].includes(params.lens) && params.contextRows.length < 3) {
    return "medium";
  }
  return "low";
}

function buildSemanticFrame(params: {
  domain: string;
  lens: string;
  window: string;
  contextRows: SeedEvidenceCandidate[];
  anchor: SeedEvidenceCandidate;
  actorName: string | null;
  minDomainScore?: number;
}): BenchmarkSemanticFrame {
  const text = combinedEvidenceText(params.contextRows);
  const statementOwner = inferStatementOwner(params.anchor, params.contextRows);
  const supportedLenses = ANALYSIS_LENSES.filter((lens) => (
    lensSupportFailureReason({
      domain: params.domain,
      lens,
      anchor: params.anchor ?? {
        canonical_id: "",
        memory_id: "",
        conversation_id: "",
        actor_id: null,
        actor_name: null,
        actor_type: null,
        source_system: "",
        source_timestamp: null,
        content: "",
        has_plan_block: false,
        domain_score: 1
      },
      contextRows: params.contextRows,
      minDomainScore: params.minDomainScore
    }) == null
  ));
  return {
    domain: params.domain,
    lens: params.lens,
    participants: uniqueNames(params.contextRows.map((row) => row.actor_name)),
    actorScope: params.actorName,
    statementOwnerName: statementOwner.statementOwnerName,
    statementOwnerRole: statementOwner.statementOwnerRole,
    preferredQuestionVoices: statementOwner.preferredQuestionVoices,
    timeframe: temporalQualifier(params.window),
    conversationIntent: inferConversationIntent(params.domain, text),
    topicSummary: inferFocusArea(params.domain, text),
    supportDepth: inferSupportDepth(params.contextRows),
    ambiguityRisk: inferAmbiguityRisk({
      actorName: params.actorName,
      contextRows: params.contextRows,
      lens: params.lens
    }),
    supportedLenses
  };
}

function selfThirdPersonReason(question: string, contextRows: SeedEvidenceCandidate[]): string | null {
  const q = lowerText(question);
  for (const row of contextRows) {
    if (String(row.actor_type ?? "").trim().toLowerCase() !== "user") continue;
    const name = String(row.actor_name ?? "").trim();
    if (!name) continue;
    if (q.includes(name.toLowerCase())) return "user_third_person_reference";
  }
  return null;
}

function unsupportedPossessiveRewriteReason(question: string, contextRows: SeedEvidenceCandidate[]): string | null {
  const q = lowerText(question);
  const text = combinedEvidenceText(contextRows);
  const matches = q.match(/\b(my|our|his|her)\s+(mom|mother|dad|father|uncle|aunt|cousin|brother|sister|grandma|grandpa|wife|husband|401k|roth|ira|account|balance|house|portfolio)\b/g) ?? [];
  for (const phrase of matches) {
    if (text.includes(phrase)) continue;
    const noun = phrase.replace(/^(my|our|his|her)\s+/, "");
    if (!text.includes(noun)) continue;
    return "unsupported_possessive_rewrite";
  }
  return null;
}

function scoreAuthoringCritique(params: {
  question: string;
  questionVoice?: string | null;
  expectedBehavior: "answer_now" | "clarify_first";
  clarificationQuestion: string | null;
  resolvedQuestionAfterClarification: string | null;
  actorName: string | null;
  domain: string;
  lens: string;
  semanticFrame: BenchmarkSemanticFrame;
  contextRows: SeedEvidenceCandidate[];
  domainScore: number;
  hardGuardReasons: string[];
}): BenchmarkAuthoringCritique {
  const question = String(params.question ?? "").trim();
  const qLower = question.toLowerCase();
  const text = combinedEvidenceText(params.contextRows);
  const reasons = [...params.hardGuardReasons];
  const hasProblemSignal = /(issue|problem|stuck|blocked|error|fail|wrong|trouble|conflict|concern)/.test(text);
  const cueTerms = extractConcreteCueTerms(params.contextRows, params.actorName);
  const cueOverlap = cueTerms.filter((term) => qLower.includes(term)).length;
  const dominantSpeaker = dominantSpeakerProfile(params.contextRows);
  const questionVoice = String(params.questionVoice ?? "").trim();

  let naturalness = 1;
  if (question.length < 28 || question.length > 240) naturalness -= 0.25;
  if (looksLikeFileMetaFragment(question)) naturalness -= 0.5;
  if (/json|expected answer|evidence ids/.test(qLower)) naturalness -= 0.4;
  if (isHumanCenteredDomain(params.domain) && /(issue|problem|root cause|causing the issue|caused the issue)/.test(qLower) && !hasProblemSignal) {
    naturalness -= 0.35;
    reasons.push("human_domain_technical_issue_wording");
  }

  let actorScopeFidelity = 1;
  const selfReason = selfThirdPersonReason(question, params.contextRows);
  if (selfReason) {
    actorScopeFidelity -= 0.8;
    reasons.push(selfReason);
  }
  const possessiveRewriteReason = unsupportedPossessiveRewriteReason(question, params.contextRows);
  if (possessiveRewriteReason) {
    actorScopeFidelity -= 0.35;
    reasons.push(possessiveRewriteReason);
  }
  if (params.actorName && !qLower.includes(`with ${params.actorName.toLowerCase()}`) && !qLower.includes(params.actorName.toLowerCase())) {
    actorScopeFidelity -= 0.25;
  }
  if (!params.actorName && /\bwith\s+[a-z]/.test(qLower)) actorScopeFidelity -= 0.2;
  const usesFirstPerson = /\b(i|my|our|me)\b/.test(qLower);
  const mentionsDominantOther = dominantSpeaker.dominantOtherName
    ? qLower.includes(dominantSpeaker.dominantOtherName.toLowerCase())
    : false;
  const mentionsStatementOwner = params.semanticFrame.statementOwnerName
    ? qLower.includes(params.semanticFrame.statementOwnerName.toLowerCase())
    : false;
  if (
    dominantSpeaker.dominantOtherName
    && dominantSpeaker.dominantOtherRows > dominantSpeaker.dominantUserRows
    && usesFirstPerson
    && !mentionsDominantOther
  ) {
    actorScopeFidelity -= 0.45;
    reasons.push("question_uses_wrong_point_of_view");
  }
  if (params.semanticFrame.statementOwnerRole === "other_human" && usesFirstPerson) {
    actorScopeFidelity -= 0.6;
    reasons.push("question_uses_user_voice_for_other_human_statement");
  }
  if (params.semanticFrame.statementOwnerRole === "other_human" && params.actorName && !mentionsStatementOwner) {
    actorScopeFidelity -= 0.25;
    reasons.push("missing_statement_owner_reference");
  }
  if (
    params.semanticFrame.statementOwnerRole === "assistant_or_system"
    && params.actorName
    && qLower.includes(params.actorName.toLowerCase())
    && cueOverlap === 0
  ) {
    actorScopeFidelity -= 0.2;
    reasons.push("tool_actor_without_task_anchor");
  }
  if (questionVoice && !params.semanticFrame.preferredQuestionVoices.includes(questionVoice as "user_first_person" | "user_about_other" | "assistant_proxy")) {
    actorScopeFidelity -= 0.45;
    reasons.push("question_voice_not_allowed_for_statement_owner");
  }
  const counterpartyIsToolLike = params.contextRows.some((row) => {
    const actorType = lowerText(row.actor_type);
    const actor = lowerText(row.actor_name);
    return actorType === "assistant" || actorType === "system" || actor.includes("assistant");
  });
  if (counterpartyIsToolLike && params.actorName && qLower.includes(params.actorName.toLowerCase()) && cueOverlap === 0) {
    actorScopeFidelity -= 0.2;
    reasons.push("tool_actor_without_task_anchor");
  }

  let ambiguityCorrectness = 1;
  const soundsAmbiguous = /can't remember|not sure|which one|locate the right thread|clarify/.test(qLower);
  if (params.expectedBehavior === "clarify_first") {
    if (!params.clarificationQuestion) ambiguityCorrectness -= 0.5;
    if (!params.resolvedQuestionAfterClarification) ambiguityCorrectness -= 0.4;
    if (!soundsAmbiguous && params.semanticFrame.ambiguityRisk === "low") ambiguityCorrectness -= 0.25;
  } else if (soundsAmbiguous) {
    ambiguityCorrectness -= 0.45;
  }

  let answerability = 1;
  if (params.contextRows.length === 0) answerability -= 0.6;
  if (params.expectedBehavior === "answer_now" && /\bthis|that|it|there|here\b/.test(qLower)) answerability -= 0.2;
  if (params.expectedBehavior === "clarify_first" && !params.resolvedQuestionAfterClarification) answerability -= 0.35;

  let lensFit = lensSupportFailureReason({
    domain: params.domain,
    lens: params.lens,
    anchor: params.contextRows[0]!,
    contextRows: params.contextRows
  }) == null ? 1 : 0.2;
  if (!params.semanticFrame.supportedLenses.includes(params.lens)) lensFit -= 0.2;

  let evidenceGrounding = 0.72;
  if (params.contextRows.length >= 4) evidenceGrounding += 0.14;
  else if (params.contextRows.length >= 2) evidenceGrounding += 0.08;
  if (params.domainScore >= MIN_DOMAIN_SCORE_FOR_CASE) evidenceGrounding += 0.08;
  else if (params.domainScore < 0.5) evidenceGrounding -= 0.08;
  if (!text.includes(lowerText(params.semanticFrame.topicSummary).split(/\s+/)[0] ?? "")) evidenceGrounding -= 0.05;
  if (params.contextRows.length <= 1 && params.lens !== "descriptive") evidenceGrounding -= 0.35;
  if (params.hardGuardReasons.length > 0) evidenceGrounding -= 0.4;
  if (cueTerms.length >= 2 && cueOverlap === 0) evidenceGrounding -= 0.45;
  else if (cueTerms.length >= 3 && cueOverlap < 2) evidenceGrounding -= 0.2;

  naturalness = clamp01(naturalness, 0);
  actorScopeFidelity = clamp01(actorScopeFidelity, 0);
  ambiguityCorrectness = clamp01(ambiguityCorrectness, 0);
  answerability = clamp01(answerability, 0);
  lensFit = clamp01(lensFit, 0);
  evidenceGrounding = clamp01(evidenceGrounding, 0);

  if (naturalness < 0.72) reasons.push("question_not_natural_enough");
  if (actorScopeFidelity < 0.72) reasons.push("actor_scope_mismatch");
  if (ambiguityCorrectness < 0.72) reasons.push("ambiguity_label_mismatch");
  if (answerability < 0.72) reasons.push("question_not_answerable_enough");
  if (lensFit < 0.72) reasons.push("lens_fit_mismatch");
  if (evidenceGrounding < 0.72) reasons.push("question_not_grounded_enough");
  if (cueTerms.length >= 2 && cueOverlap === 0) reasons.push("missing_concrete_cluster_details");

  const score = (
    naturalness
    + actorScopeFidelity
    + ambiguityCorrectness
    + answerability
    + lensFit
    + evidenceGrounding
  ) / 6;
  return {
    pass: score >= 0.74 && reasons.length === 0,
    score,
    reasons: Array.from(new Set(reasons)),
    dimensions: {
      naturalness,
      actorScopeFidelity,
      ambiguityCorrectness,
      answerability,
      lensFit,
      evidenceGrounding
    }
  };
}

function qualityGateFromAuthoringCritique(critique: BenchmarkAuthoringCritique): {
  status: "pass" | "fail";
  score: number;
  reasons: string[];
  dimensions: {
    naturalness: number;
    answerability: number;
    ambiguityCorrectness: number;
    evidenceGrounding: number;
  };
} {
  return {
    status: critique.pass ? "pass" : "fail",
    score: critique.score,
    reasons: critique.reasons,
    dimensions: {
      naturalness: critique.dimensions.naturalness,
      answerability: critique.dimensions.answerability,
      ambiguityCorrectness: critique.dimensions.ambiguityCorrectness,
      evidenceGrounding: critique.dimensions.evidenceGrounding
    }
  };
}

function fallbackAuthoringCandidates(params: {
  domain: string;
  lens: string;
  window: string;
  actorName: string | null;
  focusArea: string;
  semanticFrame: BenchmarkSemanticFrame;
}): AuthoringQuestionCandidate[] {
  const direct = buildQuestionTemplate({
    lens: params.lens,
    domain: params.domain,
    focusArea: params.focusArea,
    actorName: params.actorName,
    window: params.window,
    mode: "base"
  });
  const paraphrase = buildQuestionTemplate({
    lens: params.lens,
    domain: params.domain,
    focusArea: params.focusArea,
    actorName: params.actorName,
    window: params.window,
    mode: "paraphrase"
  });
  const out: AuthoringQuestionCandidate[] = [
    {
      kind: "direct_clear",
      question: direct,
      rationale: "Direct first-turn recall question grounded in the local conversation cluster.",
      expectedBehavior: "answer_now",
      clarificationQuestion: null,
      resolvedQuestionAfterClarification: null
    },
    {
      kind: "paraphrase_clear",
      question: paraphrase,
      rationale: "Natural paraphrase of the same recall intent.",
      expectedBehavior: "answer_now",
      clarificationQuestion: null,
      resolvedQuestionAfterClarification: null
    }
  ];
  if (params.semanticFrame.ambiguityRisk !== "low") {
    const clarificationQuestion = clarificationPromptForDomain(params.domain, params.focusArea);
    out.push({
      kind: "clarify_first",
      question: "I remember talking about this but I can't place the exact thread. Can you help me find the right conversation?",
      rationale: "The context supports a plausible memory lookup, but the first turn can reasonably require one short clarification.",
      expectedBehavior: "clarify_first",
      clarificationQuestion,
      resolvedQuestionAfterClarification: direct
    });
  }
  if (params.semanticFrame.supportedLenses.includes("trend_trajectory")) {
    out.push({
      kind: "temporal_relative",
      question: buildQuestionTemplate({
        lens: params.lens,
        domain: params.domain,
        focusArea: params.focusArea,
        actorName: params.actorName,
        window: params.window,
        mode: "temporal"
      }),
      rationale: "Temporal relative phrasing grounded in a multi-row window.",
      expectedBehavior: "answer_now",
      clarificationQuestion: null,
      resolvedQuestionAfterClarification: null
    });
  }
  return out;
}

function fallbackAuthoringDraft(params: {
  domain: string;
  lens: string;
  window: string;
  actorName: string | null;
  semanticFrame: BenchmarkSemanticFrame;
  contextRows: SeedEvidenceCandidate[];
  domainScore: number;
}): BenchmarkAuthoringDraft {
  const focusArea = params.semanticFrame.topicSummary;
  const candidates = fallbackAuthoringCandidates({
    domain: params.domain,
    lens: params.lens,
    window: params.window,
    actorName: params.actorName,
    focusArea,
    semanticFrame: params.semanticFrame
  });
  const chosen = candidates.find((item) => item.kind === "direct_clear") ?? candidates[0];
  const critique = scoreAuthoringCritique({
    question: chosen.question,
    questionVoice: "unknown",
    expectedBehavior: chosen.expectedBehavior,
    clarificationQuestion: chosen.clarificationQuestion,
    resolvedQuestionAfterClarification: chosen.resolvedQuestionAfterClarification,
    actorName: params.actorName,
    domain: params.domain,
    lens: params.lens,
    semanticFrame: params.semanticFrame,
    contextRows: params.contextRows,
    domainScore: params.domainScore,
    hardGuardReasons: []
  });
  return {
    authoringVersion: BENCHMARK_AUTHORING_VERSION,
    semanticFrame: params.semanticFrame,
    authoringDecision: critique.pass ? "accept" : "reject",
    rejectionReasons: critique.pass ? [] : critique.reasons,
    questionVoice: "unknown",
    candidateQuestions: candidates,
    chosenQuestion: chosen.question,
    chosenQuestionRationale: chosen.rationale,
    expectedBehavior: chosen.expectedBehavior,
    clarificationQuestion: chosen.clarificationQuestion,
    resolvedQuestionAfterClarification: chosen.resolvedQuestionAfterClarification,
    expectedAnswerSummaryHuman: buildHumanAnswerSummary({
      domain: params.domain,
      lens: params.lens,
      expectedBehavior: chosen.expectedBehavior,
      expectedCoreClaims: params.contextRows.map((row) => compactText(row.content, 140)),
      actorName: params.actorName
    }),
    authoringCritique: critique
  };
}

function normalizeQuestionCandidate(value: unknown): AuthoringQuestionCandidate | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  const question = compactText(String(obj.question ?? "").trim(), 240);
  if (!question) return null;
  const expectedBehavior = String(obj.expectedBehavior ?? "").trim() === "clarify_first" ? "clarify_first" : "answer_now";
  return {
    kind: compactText(String(obj.kind ?? "candidate").trim() || "candidate", 40),
    question,
    rationale: compactText(String(obj.rationale ?? "").trim() || "Grounded candidate question.", 240),
    expectedBehavior,
    clarificationQuestion: expectedBehavior === "clarify_first"
      ? compactText(String(obj.clarificationQuestion ?? "").trim(), 180) || null
      : null,
    resolvedQuestionAfterClarification: expectedBehavior === "clarify_first"
      ? compactText(String(obj.resolvedQuestionAfterClarification ?? "").trim(), 240) || null
      : null
  };
}

function normalizeAuthoringDraft(params: {
  parsed: Record<string, unknown>;
  fallback: BenchmarkAuthoringDraft;
  domain: string;
  lens: string;
  actorName: string | null;
  contextRows: SeedEvidenceCandidate[];
  domainScore: number;
}): BenchmarkAuthoringDraft {
  const parsedFrame = (params.parsed.semanticFrame && typeof params.parsed.semanticFrame === "object" && !Array.isArray(params.parsed.semanticFrame))
    ? (params.parsed.semanticFrame as Record<string, unknown>)
    : {};
  const semanticFrame: BenchmarkSemanticFrame = {
    ...params.fallback.semanticFrame,
    participants: Array.isArray(parsedFrame.participants) ? uniqueNames(parsedFrame.participants.map((item) => String(item ?? ""))) : params.fallback.semanticFrame.participants,
    actorScope: String(parsedFrame.actorScope ?? "").trim() || params.fallback.semanticFrame.actorScope,
    statementOwnerName: compactText(String(parsedFrame.statementOwnerName ?? "").trim() || params.fallback.semanticFrame.statementOwnerName || "", 80) || null,
    statementOwnerRole: ["user", "other_human", "assistant_or_system", "mixed"].includes(String(parsedFrame.statementOwnerRole ?? ""))
      ? (String(parsedFrame.statementOwnerRole) as "user" | "other_human" | "assistant_or_system" | "mixed")
      : params.fallback.semanticFrame.statementOwnerRole,
    preferredQuestionVoices: Array.isArray(parsedFrame.preferredQuestionVoices)
      ? parsedFrame.preferredQuestionVoices
          .map((item) => String(item ?? "").trim())
          .filter((item): item is "user_first_person" | "user_about_other" | "assistant_proxy" => item === "user_first_person" || item === "user_about_other" || item === "assistant_proxy")
      : params.fallback.semanticFrame.preferredQuestionVoices,
    timeframe: compactText(String(parsedFrame.timeframe ?? "").trim() || params.fallback.semanticFrame.timeframe, 80),
    conversationIntent: compactText(String(parsedFrame.conversationIntent ?? "").trim() || params.fallback.semanticFrame.conversationIntent, 120),
    topicSummary: compactText(String(parsedFrame.topicSummary ?? "").trim() || params.fallback.semanticFrame.topicSummary, 120),
    supportDepth: ["thin", "moderate", "rich"].includes(String(parsedFrame.supportDepth ?? ""))
      ? (String(parsedFrame.supportDepth) as "thin" | "moderate" | "rich")
      : params.fallback.semanticFrame.supportDepth,
    ambiguityRisk: ["low", "medium", "high"].includes(String(parsedFrame.ambiguityRisk ?? ""))
      ? (String(parsedFrame.ambiguityRisk) as "low" | "medium" | "high")
      : params.fallback.semanticFrame.ambiguityRisk,
    supportedLenses: Array.isArray(parsedFrame.supportedLenses)
      ? parsedFrame.supportedLenses.map((item) => String(item ?? "")).filter((item) => (ANALYSIS_LENSES as readonly string[]).includes(item))
      : params.fallback.semanticFrame.supportedLenses
  };
  const candidatesRaw = Array.isArray(params.parsed.candidateQuestions) ? params.parsed.candidateQuestions : [];
  const candidateQuestions = candidatesRaw
    .map((item) => normalizeQuestionCandidate(item))
    .filter((item): item is AuthoringQuestionCandidate => Boolean(item))
    .slice(0, 6);
  const initialChosenQuestion = compactText(String(params.parsed.chosenQuestion ?? "").trim(), 240);
  const initialExpectedBehavior: "answer_now" | "clarify_first" = String(params.parsed.expectedBehavior ?? "").trim() === "clarify_first"
    ? "clarify_first"
    : "answer_now";
  const initialClarificationQuestion = initialExpectedBehavior === "clarify_first"
    ? compactText(String(params.parsed.clarificationQuestion ?? "").trim(), 180) || null
    : null;
  const initialResolvedQuestion = initialExpectedBehavior === "clarify_first"
    ? compactText(String(params.parsed.resolvedQuestionAfterClarification ?? "").trim(), 240) || initialChosenQuestion || null
    : null;
  const candidates: AuthoringQuestionCandidate[] = candidateQuestions.length > 0
    ? candidateQuestions
    : (initialChosenQuestion
      ? [{
        kind: initialExpectedBehavior === "clarify_first" ? "clarify_first" : "direct_clear",
        question: initialChosenQuestion,
        rationale: "Only grounded candidate returned by the authoring agent.",
        expectedBehavior: initialExpectedBehavior,
        clarificationQuestion: initialClarificationQuestion,
        resolvedQuestionAfterClarification: initialResolvedQuestion
      }]
      : []);
  const chosenQuestion = initialChosenQuestion || candidates[0]?.question || "";
  const chosenCandidate = candidates.find((item) => item.question === chosenQuestion) ?? candidates[0] ?? null;
  const expectedBehavior: "answer_now" | "clarify_first" = String(params.parsed.expectedBehavior ?? "").trim() === "clarify_first"
    ? "clarify_first"
    : chosenCandidate?.expectedBehavior ?? "answer_now";
  const clarificationQuestion = expectedBehavior === "clarify_first"
    ? compactText(String(params.parsed.clarificationQuestion ?? chosenCandidate?.clarificationQuestion ?? "").trim(), 180) || null
    : null;
  const resolvedQuestionAfterClarification = expectedBehavior === "clarify_first"
    ? compactText(String(params.parsed.resolvedQuestionAfterClarification ?? chosenCandidate?.resolvedQuestionAfterClarification ?? "").trim(), 240) || chosenQuestion || null
    : null;
  const questionVoiceRaw = String(params.parsed.questionVoice ?? "").trim();
  const questionVoice = questionVoiceRaw === "user_first_person" || questionVoiceRaw === "user_about_other" || questionVoiceRaw === "assistant_proxy"
    ? questionVoiceRaw
    : "unknown";
  const critique = scoreAuthoringCritique({
    question: chosenQuestion,
    questionVoice,
    expectedBehavior,
    clarificationQuestion,
    resolvedQuestionAfterClarification,
    actorName: params.actorName,
    domain: params.domain,
    lens: params.lens,
    semanticFrame,
    contextRows: params.contextRows,
    domainScore: params.domainScore,
    hardGuardReasons: []
  });
  const authoringDecisionRaw = String(params.parsed.authoringDecision ?? "").trim();
  const rejectionReasons = Array.isArray(params.parsed.rejectionReasons)
    ? Array.from(new Set(
      params.parsed.rejectionReasons
        .map((item) => compactText(String(item ?? "").trim(), 80))
        .filter(Boolean)
    )).slice(0, 8)
    : [];
  if (!chosenQuestion) rejectionReasons.push("model_missing_question");
  const authoringDecision: "accept" | "reject" = authoringDecisionRaw === "reject" || rejectionReasons.length > 0
    ? "reject"
    : (authoringDecisionRaw === "accept" ? "accept" : (critique.pass ? "accept" : "reject"));
  return {
    authoringVersion: BENCHMARK_AUTHORING_VERSION,
    semanticFrame,
    authoringDecision,
    rejectionReasons,
    questionVoice,
    candidateQuestions: candidates,
    chosenQuestion,
    chosenQuestionRationale: compactText(String(params.parsed.chosenQuestionRationale ?? chosenCandidate?.rationale ?? "").trim() || "Chosen because it is the most natural grounded first-turn question for this evidence cluster.", 240),
    expectedBehavior,
    clarificationQuestion,
    resolvedQuestionAfterClarification,
    expectedAnswerSummaryHuman: compactText(String(params.parsed.expectedAnswerSummaryHuman ?? "").trim() || params.fallback.expectedAnswerSummaryHuman, 320),
    authoringCritique: critique
  };
}

async function runBenchmarkAuthoringAgent(params: {
  domain: string;
  lens: string;
  window: string;
  actorName: string | null;
  semanticFrame: BenchmarkSemanticFrame;
  contextRows: SeedEvidenceCandidate[];
  domainScore: number;
  repairContext?: {
    attempt: number;
    priorQuestion: string;
    priorQuestionVoice: string;
    failureReasons: string[];
    oracleFailure?: string | null;
  };
}): Promise<BenchmarkAuthoringDraft | null> {
  const fallback = fallbackAuthoringDraft(params);
  const startedAt = Date.now();
  const anchor = params.contextRows[0];
  const suggestedConcreteAnchors = extractConcreteCueTerms(params.contextRows, params.actorName).slice(0, 8);
  const preflightWarnings = Array.from(new Set([
    ...(anchor ? (rejectAnchorReason(anchor.content, params.domainScore) ? [rejectAnchorReason(anchor.content, params.domainScore)!] : []) : []),
    ...(params.semanticFrame.supportedLenses.includes(params.lens) ? [] : ["requested_lens_not_supported_by_cluster"]),
    ...(params.semanticFrame.supportDepth === "thin" && params.lens !== "descriptive" ? ["support_depth_too_thin_for_requested_lens"] : [])
  ]));
  const openAiKey = String(config.openAiApiKey ?? "").trim();
  const openRouterKey = String(config.openRouterApiKey ?? "").trim();
  const hasModel = openAiKey.length > 0 || openRouterKey.length > 0;
  if (!hasModel) {
    await recordBenchmarkAuthoringCall({
      domain: params.domain,
      lens: params.lens,
      window: params.window,
      actorName: params.actorName,
      durationMs: Date.now() - startedAt,
      ok: false,
      status: "no_model",
      detail: "missing_model_key"
    });
    throw new Error("Benchmark authoring requires a configured model key.");
  }

  const provider = openAiKey ? "openai" : "openrouter";
  const url = provider === "openai"
    ? `${String(config.openAiBaseUrl || "https://api.openai.com/v1").replace(/\/+$/, "")}/chat/completions`
    : "https://openrouter.ai/api/v1/chat/completions";
  const apiKey = provider === "openai" ? openAiKey : openRouterKey;
  const model = provider === "openai"
    ? String(config.metadataModel || "gpt-4o-mini").replace(/^openai\//i, "")
    : String(config.metadataModel || "openai/gpt-4o-mini");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), AUTHORING_AGENT_TIMEOUT_MS);
  const counterpartyKinds = Array.from(new Set(
    params.contextRows
      .map((row) => lowerText(row.actor_type))
      .filter((actorType) => actorType && actorType !== "user")
  ));
  try {
    const response = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: 1100,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              "You are BenchmarkAuthoringAgent for OpenBrain. Your job is to author benchmark cases from a real evidence cluster, not to answer the user's question. " +
              "Work sequentially: interpret the cluster, refine the semantic frame, propose natural candidate questions, choose the best base question, decide answer_now vs clarify_first, write a concise expected answer summary, then critique your own draft against the evaluation rubric below. " +
              "Allowed question voices are only: user_first_person (I/my/our when the memory is about the user's own statements or plans), user_about_other (the user asking about another person's statements or plans, e.g. 'What did Jenn plan to bring?'), or assistant_proxy (for an AI agent speaking on the user's behalf). Never refer to the user by proper name as the target of the question. " +
              "The benchmark question must always come from the user's point of view or an agent's point of view, never from the speaker's point of view unless the speaker is the user. Respect preferredQuestionVoices. If statementOwnerRole is other_human, first-person wording like 'What did I plan?' is wrong and must be rejected. In that case, write the question as the user or agent asking about that person, e.g. 'What did Jenn plan to bring for Uncle Bob and my mom?' " +
              "If actor scope is explicit, the question must clearly target that actor's conversation or thread. If the evidence is too weak for the requested lens, self-reject the draft instead of forcing a stronger question. " +
              "If preflightWarnings says the requested lens is unsupported or the support depth is too thin, default to authoringDecision='reject'. " +
              "Use concrete details from the cluster when they exist: specific people, places, objects, actions, or timing cues. Do not write a generic domain-level question when the evidence contains distinctive anchors like breakfast, 401k, supercharger, specific relatives, or named plans. " +
              "Do not invent possessive ownership that the evidence does not support. If the evidence says 'mom' or '401k' without clarifying whose it is, preserve the neutral wording instead of rewriting it as 'her mom', 'my mom', or 'her 401k' unless the ownership is explicit in the cluster. Good: 'What did Jenn say she needed to bring for Uncle Bob and mom tomorrow?' Good: 'What did Jenn say about the 401k numbers?' Bad: 'What did Jenn say she needed to bring for Uncle Bob and her mom tomorrow?' Bad: 'What did Jenn say about her 401k?' " +
              "When suggestedConcreteAnchors are provided, include at least one or two of them in the chosen question whenever that still sounds natural. If the only natural question would omit those anchors and become generic, reject the case. " +
              "When the counterparty is an assistant, system, or tool, prioritize the concrete task details over naming the tool itself. The actor name can be secondary or omitted if the task details are the stronger retrieval anchor. " +
              "If repairContext is present, you are revising a previously failed draft. Fix the listed failureReasons directly instead of rephrasing lightly. If failureReasons includes unsupported_possessive_rewrite, remove invented possessive pronouns from ambiguous kinship or asset nouns and preserve the evidence wording more literally. When oracleFailure says the expected thread was not recovered, make the question more concretely anchored to the evidence cluster. " +
              "semanticFrame.topicSummary must be a specific evidence-grounded summary, not a generic label like 'relationship conversations' or 'financial matters'. " +
              "Only use issue/root-cause/problem wording when the evidence cluster contains an actual problem, conflict, or explanatory signal. For descriptive evidence, prefer locate/summarize/what was discussed over explain/predict/recommend. " +
              "The draft will be automatically rejected if it contains: user-in-third-person wording, actor-scope mismatch, unsupported higher-order lens claims, generic non-retrievable phrasing, or facts not grounded in the evidence cluster. " +
              "Return JSON only with keys: semanticFrame, questionVoice, candidateQuestions, chosenQuestion, chosenQuestionRationale, expectedBehavior, clarificationQuestion, resolvedQuestionAfterClarification, expectedAnswerSummaryHuman, authoringDecision, rejectionReasons."
          },
          {
            role: "user",
            content: JSON.stringify({
              evaluationContext: {
                acceptedOnlyIf: [
                  "the question sounds like a real first-turn memory request",
                  "the question is grounded in this exact evidence cluster",
                  "the actor scope matches the conversation being referenced",
                  "the chosen lens is actually supported by the evidence depth",
                  "clarify_first is used only when ambiguity is genuinely present"
                ],
                autoRejectIf: [
                  "user is referred to by proper name in the question",
                  "question talks about a different actor/thread than the evidence cluster",
                  "descriptive evidence is inflated into diagnostic, predictive, or prescriptive claims",
                  "question is too generic to recover the evidence family",
                  "human-topic questions use technical issue wording without a real issue signal"
                ]
              },
              domain: params.domain,
              lens: params.lens,
              window: params.window,
              actorScope: params.actorName,
              statementOwnerName: params.semanticFrame.statementOwnerName,
              statementOwnerRole: params.semanticFrame.statementOwnerRole,
              preferredQuestionVoices: params.semanticFrame.preferredQuestionVoices,
              counterpartyKinds,
              semanticFrameDraft: params.semanticFrame,
              suggestedConcreteAnchors,
              preflightWarnings,
              repairContext: params.repairContext ?? null,
              evidenceCluster: params.contextRows.map((row) => ({
                actorName: row.actor_name,
                actorType: row.actor_type,
                observedAt: row.source_timestamp,
                content: compactText(row.content, 220)
              }))
            })
          }
        ]
      })
    });
    if (!response.ok) {
      await recordBenchmarkAuthoringCall({
        domain: params.domain,
        lens: params.lens,
        window: params.window,
        actorName: params.actorName,
        durationMs: Date.now() - startedAt,
        ok: false,
        status: "http_error",
        detail: String(response.status)
      });
      return null;
    }
    const payload = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const raw = String(payload?.choices?.[0]?.message?.content ?? "").trim();
    const parsed = parseJsonObjectLike(raw);
    if (!parsed) {
      await recordBenchmarkAuthoringCall({
        domain: params.domain,
        lens: params.lens,
        window: params.window,
        actorName: params.actorName,
        durationMs: Date.now() - startedAt,
        ok: false,
        status: "invalid_json",
        detail: compactText(raw, 160)
      });
      return null;
    }
    const normalized = normalizeAuthoringDraft({
      parsed,
      fallback,
      domain: params.domain,
      lens: params.lens,
      actorName: params.actorName,
      contextRows: params.contextRows,
      domainScore: params.domainScore
    });
    await recordBenchmarkAuthoringCall({
      domain: params.domain,
      lens: params.lens,
      window: params.window,
      actorName: params.actorName,
      durationMs: Date.now() - startedAt,
      ok: true,
      status: "ok",
      detail: normalized.expectedBehavior
    });
    return normalized;
  } catch {
    await recordBenchmarkAuthoringCall({
      domain: params.domain,
      lens: params.lens,
      window: params.window,
      actorName: params.actorName,
      durationMs: Date.now() - startedAt,
      ok: false,
      status: "request_failed",
      detail: null
    });
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function buildAuthoringHardGuardReasons(params: {
  anchor: SeedEvidenceCandidate;
  contextRows: SeedEvidenceCandidate[];
  question: string;
  expectedBehavior: "answer_now" | "clarify_first";
  domain: string;
  lens: string;
}): string[] {
  const reasons: string[] = [];
  const rejectReason = rejectAnchorReason(params.anchor.content, params.anchor.domain_score);
  if (rejectReason) reasons.push(rejectReason);
  if (new Set(params.contextRows.map((row) => row.conversation_id)).size > 1) reasons.push("cross_thread_context");
  const selfReason = selfThirdPersonReason(params.question, params.contextRows);
  if (selfReason) reasons.push(selfReason);
  if (params.contextRows.length <= 1 && params.lens !== "descriptive") reasons.push("higher_order_lens_on_single_line");
  const lensFailure = lensSupportFailureReason({
    domain: params.domain,
    lens: params.lens,
    anchor: params.anchor,
    contextRows: params.contextRows
  });
  if (lensFailure) reasons.push(lensFailure);
  if (params.expectedBehavior === "answer_now" && /can't remember|not sure|right thread/i.test(params.question)) {
    reasons.push("ambiguous_question_marked_clear");
  }
  return Array.from(new Set(reasons));
}

type OracleTopHit = {
  mode: string;
  canonicalId: string | null;
  conversationId: string | null;
  actorName: string | null;
  score: number;
};

async function queryOracleHits(params: {
  chatNamespace: string;
  question: string;
  mode: "lexical" | "vector" | "hybrid";
  limit: number;
}): Promise<OracleTopHit[]> {
  const lexicalQuery = buildOracleSearchQuery(String(params.question ?? "").trim());
  const queryTokens = lexicalQuery.split(/\s+/).map((token) => token.trim()).filter((token) => token.length >= 3);
  const semanticQuery = compactText(toSemanticEmbeddingText(lexicalQuery), 320);
  if (!lexicalQuery) return [];
  if (params.mode === "lexical") {
    const rows = await pool.query<{
      canonical_id: string;
      conversation_id: string;
      actor_name: string | null;
      token_hits: number;
      score: number;
    }>(
      `WITH scored AS (
         SELECT
           c.id::text AS canonical_id,
           c.conversation_id,
           a.canonical_name AS actor_name,
           (
             SELECT count(*)
             FROM unnest($1::text[]) AS token
             WHERE c.content_normalized ILIKE '%' || token || '%'
           )::int AS token_hits,
           GREATEST(
             similarity(c.content_normalized, $2),
             ts_rank_cd(to_tsvector('simple', c.content_normalized), plainto_tsquery('simple', $2))
           )::float8 AS score,
           c.observed_at
         FROM canonical_messages c
         LEFT JOIN actors a ON a.actor_id = c.actor_id
         WHERE c.chat_namespace = $3
           AND c.artifact_state = 'published'
           AND (
             c.content_normalized % $2
             OR to_tsvector('simple', c.content_normalized) @@ plainto_tsquery('simple', $2)
             OR EXISTS (
               SELECT 1
               FROM unnest($1::text[]) AS token
               WHERE c.content_normalized ILIKE '%' || token || '%'
             )
           )
       )
       SELECT canonical_id, conversation_id, actor_name, token_hits, score
       FROM scored
       ORDER BY token_hits DESC, score DESC, observed_at DESC
       LIMIT $4`,
      [queryTokens, lexicalQuery, params.chatNamespace, params.limit]
    );
    return rows.rows.map((row) => ({
      mode: "lexical",
      canonicalId: row.canonical_id,
      conversationId: row.conversation_id,
      actorName: row.actor_name ?? null,
      score: clamp01(Number(row.score ?? 0), 0)
    }));
  }
  if (params.mode === "vector") {
    const rows = await pool.query<{
      canonical_id: string;
      conversation_id: string;
      actor_name: string | null;
      token_hits: number;
      score: number;
    }>(
      `WITH scored AS (
         SELECT
           c.id::text AS canonical_id,
           c.conversation_id,
           a.canonical_name AS actor_name,
           (
             SELECT count(*)
             FROM unnest($1::text[]) AS token
             WHERE c.content_normalized ILIKE '%' || token || '%'
           )::int AS token_hits,
           GREATEST(
             similarity(c.content_normalized, $2),
             ts_rank_cd(to_tsvector('simple', c.content_normalized), plainto_tsquery('simple', $2))
           )::float8 AS score,
           c.observed_at
         FROM canonical_messages c
         LEFT JOIN actors a ON a.actor_id = c.actor_id
         WHERE c.chat_namespace = $3
           AND c.artifact_state = 'published'
           AND (
             c.content_normalized % $2
             OR to_tsvector('simple', c.content_normalized) @@ plainto_tsquery('simple', $2)
             OR EXISTS (
               SELECT 1
               FROM unnest($1::text[]) AS token
               WHERE c.content_normalized ILIKE '%' || token || '%'
             )
           )
       )
       SELECT canonical_id, conversation_id, actor_name, token_hits, score
       FROM scored
       ORDER BY token_hits DESC, score DESC, observed_at DESC
       LIMIT $4`,
      [queryTokens, semanticQuery, params.chatNamespace, params.limit]
    );
    return rows.rows.map((row) => ({
      mode: "vector",
      canonicalId: row.canonical_id,
      conversationId: row.conversation_id,
      actorName: row.actor_name ?? null,
      score: clamp01(Number(row.score ?? 0), 0)
    }));
  }
  const rows = await pool.query<{
    canonical_id: string;
    conversation_id: string;
    actor_name: string | null;
    token_hits: number;
    score: number;
  }>(
    `WITH scored AS (
       SELECT
         c.id::text AS canonical_id,
         c.conversation_id,
         a.canonical_name AS actor_name,
         (
           SELECT count(*)
           FROM unnest($1::text[]) AS token
           WHERE c.content_normalized ILIKE '%' || token || '%'
         )::int AS token_hits,
         GREATEST(
           (0.6 * GREATEST(
             similarity(c.content_normalized, $2),
             ts_rank_cd(to_tsvector('simple', c.content_normalized), plainto_tsquery('simple', $2))
           )) +
           (0.4 * GREATEST(
             similarity(c.content_normalized, $3),
             ts_rank_cd(to_tsvector('simple', c.content_normalized), plainto_tsquery('simple', $3))
           )),
           similarity(c.content_normalized, $2),
           similarity(c.content_normalized, $3)
         )::float8 AS score,
         c.observed_at
       FROM canonical_messages c
       LEFT JOIN actors a ON a.actor_id = c.actor_id
       WHERE c.chat_namespace = $4
         AND c.artifact_state = 'published'
         AND (
           c.content_normalized % $2
           OR c.content_normalized % $3
           OR to_tsvector('simple', c.content_normalized) @@ plainto_tsquery('simple', $2)
           OR to_tsvector('simple', c.content_normalized) @@ plainto_tsquery('simple', $3)
           OR EXISTS (
             SELECT 1
             FROM unnest($1::text[]) AS token
             WHERE c.content_normalized ILIKE '%' || token || '%'
           )
         )
     )
     SELECT canonical_id, conversation_id, actor_name, token_hits, score
     FROM scored
     ORDER BY token_hits DESC, score DESC, observed_at DESC
     LIMIT $5`,
    [queryTokens, lexicalQuery, semanticQuery, params.chatNamespace, params.limit]
  );
  return rows.rows.map((row) => ({
    mode: "hybrid",
    canonicalId: row.canonical_id,
    conversationId: row.conversation_id,
    actorName: row.actor_name ?? null,
    score: clamp01(Number(row.score ?? 0), 0)
  }));
}

async function queryActorConstrainedHits(params: {
  chatNamespace: string;
  actorName: string;
  question: string;
  limit: number;
}): Promise<OracleTopHit[]> {
  const lexicalQuery = buildOracleSearchQuery(String(params.question ?? "").trim());
  const queryTokens = lexicalQuery.split(/\s+/).map((token) => token.trim()).filter((token) => token.length >= 3);
  if (!lexicalQuery) return [];
  const rows = await pool.query<{
    canonical_id: string;
    conversation_id: string;
    actor_name: string | null;
    token_hits: number;
    score: number;
  }>(
    `WITH scored AS (
       SELECT
         c.id::text AS canonical_id,
         c.conversation_id,
         a.canonical_name AS actor_name,
         (
           SELECT count(*)
           FROM unnest($3::text[]) AS token
           WHERE c.content_normalized ILIKE '%' || token || '%'
         )::int AS token_hits,
         GREATEST(
           similarity(c.content_normalized, $4),
           ts_rank_cd(to_tsvector('simple', c.content_normalized), plainto_tsquery('simple', $4))
         )::float8 AS score,
         c.observed_at
       FROM canonical_messages c
       LEFT JOIN actors a ON a.actor_id = c.actor_id
       WHERE c.chat_namespace = $1
         AND c.artifact_state = 'published'
         AND lower(COALESCE(a.canonical_name, '')) = lower($2)
         AND (
           c.content_normalized % $4
           OR to_tsvector('simple', c.content_normalized) @@ plainto_tsquery('simple', $4)
           OR EXISTS (
             SELECT 1
             FROM unnest($3::text[]) AS token
             WHERE c.content_normalized ILIKE '%' || token || '%'
           )
         )
     )
     SELECT canonical_id, conversation_id, actor_name, token_hits, score
     FROM scored
     ORDER BY token_hits DESC, score DESC, observed_at DESC
     LIMIT $5`,
    [params.chatNamespace, params.actorName, queryTokens, lexicalQuery, params.limit]
  );
  return rows.rows.map((row) => ({
    mode: "actor_constrained",
    canonicalId: row.canonical_id,
    conversationId: row.conversation_id,
    actorName: row.actor_name ?? null,
    score: clamp01(Number(row.score ?? 0), 0)
  }));
}

async function runOracleFeasibilityVerifier(params: {
  chatNamespace: string;
  question: string;
  resolvedQuestionAfterClarification: string | null;
  actorName: string | null;
  evidenceIds: string[];
  conversationIds: string[];
}): Promise<BenchmarkFeasibilityReport> {
  const verifiedQuestion = String(params.resolvedQuestionAfterClarification ?? params.question).trim();
  const evidenceSet = new Set(params.evidenceIds.map(String));
  const conversationSet = new Set(params.conversationIds.map(String));
  const modesTried: string[] = [];
  const topHits: OracleTopHit[] = [];
  let exactEvidenceHit = false;
  let conversationHit = false;
  let actorConstrainedHit = false;

  const checkAnchorWindow = async (mode: string, canonicalId: string | null, conversationId: string | null): Promise<void> => {
    if (!canonicalId || !conversationId) return;
    if (evidenceSet.has(canonicalId)) exactEvidenceHit = true;
    if (!conversationSet.has(conversationId)) return;
    conversationHit = true;
    const window = await fetchContextWindow({
      chatNamespace: params.chatNamespace,
      conversationId,
      anchorMessageId: canonicalId,
      beforeN: 3,
      afterN: 3
    });
    if (window.items.some((item) => evidenceSet.has(String(item.canonicalId ?? "")))) {
      exactEvidenceHit = true;
      if (mode === "actor_constrained") actorConstrainedHit = true;
    }
  };

  for (const mode of ["lexical", "hybrid", "vector"] as const) {
    modesTried.push(mode);
    const hits = await queryOracleHits({
      question: verifiedQuestion,
      chatNamespace: params.chatNamespace,
      mode,
      limit: AUTHORING_RETRIEVAL_K
    });
    for (const anchor of hits.slice(0, 4)) {
      topHits.push({
        mode,
        canonicalId: anchor.canonicalId ?? null,
        conversationId: anchor.conversationId ?? null,
        actorName: anchor.actorName ?? null,
        score: Number(anchor.score ?? 0)
      });
      await checkAnchorWindow(mode, anchor.canonicalId ?? null, anchor.conversationId ?? null);
      if (exactEvidenceHit || conversationHit) break;
    }
    if (exactEvidenceHit || conversationHit) break;
  }

  if (params.actorName && !exactEvidenceHit && !conversationHit) {
    modesTried.push("actor_constrained");
    const actorHits = await queryActorConstrainedHits({
      chatNamespace: params.chatNamespace,
      actorName: params.actorName,
      question: verifiedQuestion,
      limit: AUTHORING_RETRIEVAL_K
    });
    for (const hit of actorHits.slice(0, 4)) {
      topHits.push(hit);
      await checkAnchorWindow(hit.mode, hit.canonicalId, hit.conversationId);
      if (conversationSet.has(String(hit.conversationId ?? ""))) actorConstrainedHit = true;
      if (exactEvidenceHit || conversationHit) break;
    }
  }

  const pass = exactEvidenceHit || conversationHit;
  return {
    version: BENCHMARK_ORACLE_VERSION,
    verifiedQuestion,
    pass,
    modesTried,
    exactEvidenceHit,
    conversationHit,
    actorConstrainedHit,
    topHits: topHits.slice(0, 8),
    rationale: pass
      ? "Oracle verifier recovered the expected evidence family or conversation."
      : "Oracle verifier did not recover the expected evidence family."
  };
}

function buildAdmissionDecision(params: {
  critique: BenchmarkAuthoringCritique;
  feasibility: BenchmarkFeasibilityReport;
  hardGuardReasons: string[];
  modelDecision?: "accept" | "reject";
  modelReasons?: string[];
}): BenchmarkAdmissionDecision {
  const critiqueReasons = Array.from(new Set(params.critique.reasons));
  const reasons = Array.from(new Set([
    ...params.hardGuardReasons,
    ...critiqueReasons,
    ...((params.modelDecision === "reject" ? (params.modelReasons ?? ["model_self_rejected"]) : [])),
    ...(params.feasibility.pass ? [] : ["oracle_verifier_failed"])
  ]));
  if (params.hardGuardReasons.includes("low_signal_anchor")
    || params.hardGuardReasons.includes("weak_domain_mapping")
    || params.hardGuardReasons.includes("domain_semantic_mismatch")
    || params.hardGuardReasons.includes("lens_requires_supported_context")
    || params.hardGuardReasons.includes("higher_order_lens_on_single_line")) {
    return {
      admitted: false,
      status: "unresolved",
      reasons,
      verifierVersion: params.feasibility.version
    };
  }
  if (params.modelDecision === "reject") {
    return {
      admitted: false,
      status: "rejected",
      reasons,
      verifierVersion: params.feasibility.version
    };
  }
  const marginalGroundingMissOnly = params.feasibility.pass
    && params.critique.score >= 0.86
    && critiqueReasons.length === 1
    && critiqueReasons[0] === "question_not_grounded_enough";
  if (marginalGroundingMissOnly) {
    return {
      admitted: true,
      status: "accepted",
      reasons: [],
      verifierVersion: params.feasibility.version
    };
  }
  if (!params.critique.pass || !params.feasibility.pass) {
    return {
      admitted: false,
      status: "rejected",
      reasons,
      verifierVersion: params.feasibility.version
    };
  }
  return {
    admitted: true,
    status: "accepted",
    reasons: [],
    verifierVersion: params.feasibility.version
  };
}

const AUTHORING_PRE_ORACLE_REPAIR_REASONS = new Set([
  "model_missing_question",
  "user_third_person_reference",
  "question_uses_wrong_point_of_view",
  "question_uses_user_voice_for_other_human_statement",
  "missing_statement_owner_reference",
  "unsupported_possessive_rewrite",
  "actor_scope_mismatch",
  "question_not_natural_enough",
  "human_domain_technical_issue_wording",
  "missing_concrete_cluster_details"
]);

const AUTHORING_POST_ORACLE_REPAIR_REASONS = new Set([
  "question_not_grounded_enough",
  "missing_concrete_cluster_details",
  "actor_scope_mismatch"
]);

async function authorBenchmarkCaseWithRepairs(params: {
  chatNamespace: string;
  domain: string;
  lens: string;
  window: string;
  actorName: string | null;
  semanticFrame: BenchmarkSemanticFrame;
  contextRows: SeedEvidenceCandidate[];
  anchor: SeedEvidenceCandidate;
  domainScore: number;
  evidenceIds: string[];
  conversationIds: string[];
}): Promise<{
  draft: BenchmarkAuthoringDraft;
  critique: BenchmarkAuthoringCritique;
  hardGuardReasons: string[];
  feasibilityReport: BenchmarkFeasibilityReport;
  admissionDecision: BenchmarkAdmissionDecision;
} | null> {
  let repairContext: {
    attempt: number;
    priorQuestion: string;
    priorQuestionVoice: string;
    failureReasons: string[];
    oracleFailure?: string | null;
  } | undefined;
  let lastResult: {
    draft: BenchmarkAuthoringDraft;
    critique: BenchmarkAuthoringCritique;
    hardGuardReasons: string[];
    feasibilityReport: BenchmarkFeasibilityReport;
    admissionDecision: BenchmarkAdmissionDecision;
  } | null = null;

  for (let attempt = 1; attempt <= AUTHORING_MAX_ATTEMPTS; attempt += 1) {
    if (repairContext) {
      console.log(`[authoring] repair attempt ${attempt} ${params.domain}/${params.lens}: ${repairContext.failureReasons.join(", ")}`);
    }
    const initialDraft = await runBenchmarkAuthoringAgent({
      domain: params.domain,
      lens: params.lens,
      window: params.window,
      actorName: params.actorName,
      semanticFrame: params.semanticFrame,
      contextRows: params.contextRows,
      domainScore: params.domainScore,
      repairContext
    });
    if (!initialDraft) {
      repairContext = {
        attempt: attempt + 1,
        priorQuestion: "",
        priorQuestionVoice: "unknown",
        failureReasons: ["authoring_request_failed"],
        oracleFailure: null
      };
      continue;
    }

    const hardGuardReasons = buildAuthoringHardGuardReasons({
      anchor: params.anchor,
      contextRows: params.contextRows,
      question: initialDraft.chosenQuestion,
      expectedBehavior: initialDraft.expectedBehavior,
      domain: params.domain,
      lens: params.lens
    });
    const critique = scoreAuthoringCritique({
      question: initialDraft.chosenQuestion,
      questionVoice: initialDraft.questionVoice,
      expectedBehavior: initialDraft.expectedBehavior,
      clarificationQuestion: initialDraft.clarificationQuestion,
      resolvedQuestionAfterClarification: initialDraft.resolvedQuestionAfterClarification,
      actorName: params.actorName,
      domain: params.domain,
      lens: params.lens,
      semanticFrame: initialDraft.semanticFrame,
      contextRows: params.contextRows,
      domainScore: params.domainScore,
      hardGuardReasons
    });
    const draft: BenchmarkAuthoringDraft = {
      ...initialDraft,
      authoringCritique: critique
    };
    const critiqueReasons = Array.from(new Set([...hardGuardReasons, ...critique.reasons]));
    const shouldRepairBeforeOracle = attempt < AUTHORING_MAX_ATTEMPTS && critiqueReasons.some((reason) => AUTHORING_PRE_ORACLE_REPAIR_REASONS.has(reason));
    if (shouldRepairBeforeOracle) {
      repairContext = {
        attempt: attempt + 1,
        priorQuestion: draft.chosenQuestion,
        priorQuestionVoice: String(draft.questionVoice ?? "unknown"),
        failureReasons: critiqueReasons.slice(0, 8),
        oracleFailure: null
      };
      continue;
    }

    const feasibilityReport = await runOracleFeasibilityVerifier({
      chatNamespace: params.chatNamespace,
      question: draft.chosenQuestion,
      resolvedQuestionAfterClarification: draft.resolvedQuestionAfterClarification,
      actorName: params.actorName,
      evidenceIds: params.evidenceIds,
      conversationIds: params.conversationIds
    });
    const admissionDecision = buildAdmissionDecision({
      critique,
      feasibility: feasibilityReport,
      hardGuardReasons,
      modelDecision: draft.authoringDecision,
      modelReasons: draft.rejectionReasons
    });
    lastResult = {
      draft,
      critique,
      hardGuardReasons,
      feasibilityReport,
      admissionDecision
    };
    if (admissionDecision.admitted) return lastResult;

    const shouldRepairAfterOracle = (
      attempt < AUTHORING_MAX_ATTEMPTS
      && !feasibilityReport.pass
      && critique.score >= 0.74
      && critiqueReasons.some((reason) => AUTHORING_POST_ORACLE_REPAIR_REASONS.has(reason))
    );
    if (!shouldRepairAfterOracle) return lastResult;
    repairContext = {
      attempt: attempt + 1,
      priorQuestion: draft.chosenQuestion,
      priorQuestionVoice: String(draft.questionVoice ?? "unknown"),
      failureReasons: Array.from(new Set([
        ...critiqueReasons,
        "oracle_failed_to_recover_expected_thread"
      ])).slice(0, 8),
      oracleFailure: compactText(feasibilityReport.rationale, 180)
    };
  }

  return lastResult;
}

function summarizeSemanticFrame(frame: BenchmarkSemanticFrame | null | undefined): string {
  if (!frame) return "";
  const participants = frame.participants.length > 0 ? frame.participants.join(", ") : "unknown participants";
  const owner = frame.statementOwnerName
    ? `${frame.statementOwnerName} (${frame.statementOwnerRole})`
    : frame.statementOwnerRole;
  return [
    frame.topicSummary,
    frame.conversationIntent,
    `owner: ${owner}`,
    `participants: ${participants}`,
    `support: ${frame.supportDepth}`,
    `ambiguity: ${frame.ambiguityRisk}`
  ].join(" | ");
}
const CORE_COMPONENT_TYPES: Array<{
  type: "query_policy" | "retrieval_policy" | "ranking_policy" | "context_policy" | "synthesis_policy";
  order: number;
}> = [
  { type: "query_policy", order: 1 },
  { type: "retrieval_policy", order: 2 },
  { type: "ranking_policy", order: 3 },
  { type: "context_policy", order: 4 },
  { type: "synthesis_policy", order: 5 }
];

function inferRankingMode(retrievalMode: StrategyVariantConfig["retrievalMode"]): string {
  return retrievalMode === "hybrid_rerank" ? "cross_encoder_rerank" : "none";
}

function buildCoreComponentBlueprint(configIn: StrategyVariantConfig): Array<{
  componentType: string;
  componentName: string;
  componentConfig: Record<string, unknown>;
  bindingOrder: number;
  isCore: boolean;
}> {
  const config = { ...configIn };
  const queryName = `query_${String(config.plannerMode ?? "baseline")}_${String(config.refinementMode ?? "fixed")}`;
  const retrievalName = `retrieval_${String(config.retrievalMode ?? "baseline")}`;
  const rankingMode = inferRankingMode(config.retrievalMode);
  const rankingName = `ranking_${rankingMode}`;
  const contextName = `context_${String(config.contextMode ?? "window_thread")}_loops_${Math.max(1, Number(config.maxLoops ?? 2))}`;
  const synthesisName = `synthesis_${String(config.composerMode ?? "minimal_llm")}`;

  return [
    {
      componentType: "query_policy",
      componentName: queryName,
      componentConfig: {
        plannerMode: config.plannerMode ?? "baseline",
        refinementMode: config.refinementMode ?? "fixed"
      },
      bindingOrder: 1,
      isCore: true
    },
    {
      componentType: "retrieval_policy",
      componentName: retrievalName,
      componentConfig: {
        retrievalMode: config.retrievalMode ?? "baseline"
      },
      bindingOrder: 2,
      isCore: true
    },
    {
      componentType: "ranking_policy",
      componentName: rankingName,
      componentConfig: {
        rankingMode,
        retrievalMode: config.retrievalMode ?? "baseline"
      },
      bindingOrder: 3,
      isCore: true
    },
    {
      componentType: "context_policy",
      componentName: contextName,
      componentConfig: {
        contextMode: config.contextMode ?? "window_thread",
        maxLoops: Math.max(1, Number(config.maxLoops ?? 2))
      },
      bindingOrder: 4,
      isCore: true
    },
    {
      componentType: "synthesis_policy",
      componentName: synthesisName,
      componentConfig: {
        composerMode: config.composerMode ?? "minimal_llm"
      },
      bindingOrder: 5,
      isCore: true
    }
  ];
}

function normalizeExperimentRole(index: number, total: number): ExperimentRole {
  const safeTotal = Math.max(1, total);
  const treatmentCut = Math.ceil(safeTotal * 0.7);
  const controlCut = treatmentCut + Math.ceil(safeTotal * 0.2);
  if (index < treatmentCut) return "treatment";
  if (index < controlCut) return "control";
  return "explore";
}

async function ensureComponentRecord(input: {
  componentType: string;
  componentName: string;
  componentConfig: Record<string, unknown>;
  isCore: boolean;
}): Promise<string> {
  const row = await pool.query<{ id: string }>(
    `INSERT INTO component_registry (
       component_type, component_name, version, is_core, status, config
     ) VALUES (
       $1, $2, 1, $3, 'active', $4::jsonb
     )
     ON CONFLICT (component_type, component_name, version)
     DO UPDATE SET
       is_core = component_registry.is_core OR EXCLUDED.is_core,
       config = EXCLUDED.config,
       updated_at = now()
     RETURNING id::text AS id`,
    [input.componentType, input.componentName, input.isCore, JSON.stringify(input.componentConfig)]
  );
  return row.rows[0].id;
}

async function bindStrategyComponents(params: {
  experimentId: string;
  strategyVariantId: string;
  config: StrategyVariantConfig;
}): Promise<ComponentSelection[]> {
  const core = buildCoreComponentBlueprint(params.config);
  const selections: ComponentSelection[] = [];

  await pool.query(
    `DELETE FROM strategy_component_bindings
     WHERE strategy_variant_id = $1::uuid`,
    [params.strategyVariantId]
  );

  for (const c of core) {
    const componentId = await ensureComponentRecord({
      componentType: c.componentType,
      componentName: c.componentName,
      componentConfig: c.componentConfig,
      isCore: true
    });
    await pool.query(
      `INSERT INTO strategy_component_bindings (
         experiment_id, strategy_variant_id, component_type, component_id, binding_order, is_core
       ) VALUES (
         $1::uuid, $2::uuid, $3, $4::uuid, $5, true
       )
       ON CONFLICT (strategy_variant_id, component_type, binding_order)
       DO UPDATE SET
         component_id = EXCLUDED.component_id,
         is_core = true`,
      [params.experimentId, params.strategyVariantId, c.componentType, componentId, c.bindingOrder]
    );
    selections.push({ componentType: c.componentType, componentId, isCore: true });
  }

  const extras = Array.isArray(params.config.extraComponents) ? params.config.extraComponents : [];
  let offset = 100;
  for (const item of extras) {
    if (!item || typeof item !== "object") continue;
    const rec = item as ComponentSelection;
    if (!rec.componentType || !rec.componentId) continue;
    await pool.query(
      `INSERT INTO strategy_component_bindings (
         experiment_id, strategy_variant_id, component_type, component_id, binding_order, is_core
       ) VALUES (
         $1::uuid, $2::uuid, $3, $4::uuid, $5, false
       )
       ON CONFLICT (strategy_variant_id, component_type, binding_order)
       DO UPDATE SET
         component_id = EXCLUDED.component_id,
         is_core = false`,
      [params.experimentId, params.strategyVariantId, rec.componentType, rec.componentId, offset]
    );
    selections.push({ componentType: rec.componentType, componentId: rec.componentId, isCore: false });
    offset += 1;
  }

  return selections;
}

function buildDefaultHypothesis(strategy: StrategyVariant, role: ExperimentRole): {
  title: string;
  failurePattern: Record<string, unknown>;
  causalClaim: string;
  predictedMetricChanges: Record<string, unknown>;
} {
  return {
    title: `${strategy.strategyId}: ${strategy.label}`,
    failurePattern: {
      target: "mixed_failure_buckets",
      strategyId: strategy.strategyId,
      role
    },
    causalClaim:
      "Adjusting retrieval/ranking/context/synthesis composition will improve evidence alignment and answer reliability without violating latency/cost guardrails.",
    predictedMetricChanges: {
      pass_rate_delta_gte: role === "explore" ? 0.005 : 0.02,
      recall_at_k_delta_gte: 0.01,
      ndcg_delta_gte: 0.01,
      provenance_mismatch_rate_delta_lte: -0.01
    }
  };
}

async function createHypothesis(params: {
  experimentId: string;
  strategy: StrategyVariant;
  role: ExperimentRole;
}): Promise<string> {
  const draft = buildDefaultHypothesis(params.strategy, params.role);
  const row = await pool.query<{ id: string }>(
    `INSERT INTO hypotheses (
       experiment_id, title, failure_pattern, causal_claim, predicted_metric_changes, confidence, status, metadata
     ) VALUES (
       $1::uuid, $2, $3::jsonb, $4, $5::jsonb, 0.50, 'open', $6::jsonb
     )
     RETURNING id::text AS id`,
    [
      params.experimentId,
      draft.title,
      JSON.stringify(draft.failurePattern),
      draft.causalClaim,
      JSON.stringify(draft.predictedMetricChanges),
      JSON.stringify({
        generatedBy: "strategy_bootstrap",
        strategyId: params.strategy.strategyId,
        role: params.role
      })
    ]
  );
  const hypothesisId = row.rows[0].id;
  const predictions = [
    { metricKey: "pass_rate", comparator: "delta_gte", target: Number(draft.predictedMetricChanges.pass_rate_delta_gte ?? 0.02), weight: 1.0 },
    { metricKey: "recall_at_k", comparator: "delta_gte", target: Number(draft.predictedMetricChanges.recall_at_k_delta_gte ?? 0.01), weight: 0.7 },
    { metricKey: "ndcg", comparator: "delta_gte", target: Number(draft.predictedMetricChanges.ndcg_delta_gte ?? 0.01), weight: 0.7 }
  ];
  for (const p of predictions) {
    await pool.query(
      `INSERT INTO hypothesis_predictions (
         hypothesis_id, metric_key, comparator, target_value, weight
       ) VALUES (
         $1::uuid, $2, $3, $4, $5
       )`,
      [hypothesisId, p.metricKey, p.comparator, p.target, p.weight]
    );
  }
  return hypothesisId;
}

function inferModifiedComponentsFromPatch(patch: Partial<StrategyVariantConfig> | null | undefined): string[] {
  if (!patch || typeof patch !== "object") return [];
  const out = new Set<string>();
  if ("plannerMode" in patch || "refinementMode" in patch) out.add("query_policy");
  if ("retrievalMode" in patch) {
    out.add("retrieval_policy");
    out.add("ranking_policy");
  }
  if ("contextMode" in patch || "maxLoops" in patch) out.add("context_policy");
  if ("composerMode" in patch) out.add("synthesis_policy");
  if ("extraComponents" in patch) out.add("extra_component");
  return Array.from(out);
}

async function ensureStrategyHypothesis(params: {
  experimentId: string;
  strategyId: string;
  label: string;
  config: StrategyVariantConfig;
  role?: ExperimentRole;
  reuseHypothesisId?: string | null;
}): Promise<{ hypothesisId: string; role: ExperimentRole }> {
  const role = params.role ?? "explore";
  const reuse = String(params.reuseHypothesisId ?? "").trim();
  if (reuse) {
    return { hypothesisId: reuse, role };
  }
  const hypothesisId = await createHypothesis({
    experimentId: params.experimentId,
    strategy: {
      strategyId: params.strategyId,
      label: params.label,
      config: { ...params.config, strategyId: params.strategyId }
    },
    role
  });
  return { hypothesisId, role };
}

async function insertQueuedStrategyVariant(params: {
  experimentId: string;
  strategyId: string;
  variantId: string;
  label: string;
  position: number;
  config: StrategyVariantConfig;
  role?: ExperimentRole;
  reuseHypothesisId?: string | null;
  parentStrategyVariantId?: string | null;
  parentHypothesisId?: string | null;
  modifiedComponents?: string[] | null;
  lineageReason?: string | null;
  notes?: string | null;
}): Promise<{ strategyVariantId: string; hypothesisId: string; role: ExperimentRole; config: StrategyVariantConfig; components: ComponentSelection[] }> {
  const ensured = await ensureStrategyHypothesis({
    experimentId: params.experimentId,
    strategyId: params.strategyId,
    label: params.label,
    config: params.config,
    role: params.role,
    reuseHypothesisId: params.reuseHypothesisId
  });
  const role = ensured.role;
  const hypothesisId = ensured.hypothesisId;
  const mergedConfig: StrategyVariantConfig = {
    ...params.config,
    strategyId: params.strategyId,
    hypothesisId,
    experimentRole: role,
    parentStrategyVariantId: params.parentStrategyVariantId ?? params.config.parentStrategyVariantId,
    parentHypothesisId: params.parentHypothesisId ?? params.config.parentHypothesisId,
    modifiedComponents: (params.modifiedComponents && params.modifiedComponents.length > 0)
      ? params.modifiedComponents
      : params.config.modifiedComponents,
    lineageReason: params.lineageReason ?? params.config.lineageReason
  };

  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO experiment_strategies (
       experiment_id, strategy_id, variant_id, label, position, status, config,
       hypothesis_id, experiment_role, parent_strategy_variant_id, parent_hypothesis_id, modified_components, lineage_reason
     ) VALUES (
       $1::uuid, $2, $3, $4, $5, 'queued', $6::jsonb,
       $7::uuid, $8, $9::uuid, $10::uuid, $11::text[], $12
     )
     RETURNING id::text AS id`,
    [
      params.experimentId,
      params.strategyId,
      params.variantId,
      params.label,
      params.position,
      JSON.stringify(mergedConfig),
      hypothesisId,
      role,
      params.parentStrategyVariantId ?? null,
      params.parentHypothesisId ?? null,
      (params.modifiedComponents && params.modifiedComponents.length > 0) ? params.modifiedComponents : [],
      params.lineageReason ?? null
    ]
  );
  const strategyVariantId = inserted.rows[0].id;
  const components = await bindStrategyComponents({
    experimentId: params.experimentId,
    strategyVariantId,
    config: mergedConfig
  });
  await pool.query(
    `UPDATE experiment_strategies
     SET config = $2::jsonb
     WHERE id = $1::uuid`,
    [strategyVariantId, JSON.stringify({ ...mergedConfig, components })]
  );
  await pool.query(
    `INSERT INTO hypothesis_experiments (
       hypothesis_id, strategy_variant_id, experiment_role, notes
     ) VALUES (
       $1::uuid, $2::uuid, $3, $4
     )
     ON CONFLICT (hypothesis_id, strategy_variant_id)
     DO NOTHING`,
    [hypothesisId, strategyVariantId, role, String(params.notes ?? "strategy_variant_binding")]
  );

  return { strategyVariantId, hypothesisId, role, config: { ...mergedConfig, components }, components };
}

function detectBenchmarkLeakage(config: StrategyVariantConfig, cases: ExperimentCaseRow[]): Array<Record<string, unknown>> {
  const text = JSON.stringify(config ?? {}).toLowerCase();
  if (!text || text === "{}") return [];
  const findings: Array<Record<string, unknown>> = [];
  for (const testCase of cases) {
    const q = String(testCase.question ?? "").trim().toLowerCase();
    if (!q) continue;
    const longFragment = q.length > 80 ? q.slice(0, 80) : q;
    if (longFragment.length >= 28 && text.includes(longFragment)) {
      findings.push({
        caseId: testCase.id,
        caseKey: testCase.case_key,
        reason: "strategy_config_contains_question_fragment",
        fragment: longFragment
      });
    }
  }
  return findings;
}

const STRATEGY_CATALOG: StrategyVariant[] = [
  {
    strategyId: "S0",
    label: "Current baseline (as-is V2 ask)",
    config: { strategyId: "S0", retrievalMode: "baseline", contextMode: "window_thread", plannerMode: "baseline", composerMode: "minimal_llm", refinementMode: "fixed", maxLoops: 2 }
  },
  {
    strategyId: "S1",
    label: "One-agent minimal capability-first",
    config: { strategyId: "S1", retrievalMode: "hybrid", contextMode: "window_thread", plannerMode: "single_agent_minimal", composerMode: "minimal_llm", refinementMode: "adaptive", maxLoops: 2 }
  },
  {
    strategyId: "S2",
    label: "One-agent sequential-skills",
    config: { strategyId: "S2", retrievalMode: "hybrid", contextMode: "adaptive", plannerMode: "single_agent_sequential", composerMode: "minimal_llm", refinementMode: "adaptive", maxLoops: 3 }
  },
  {
    strategyId: "S3",
    label: "Lean multi-agent mesh",
    config: { strategyId: "S3", retrievalMode: "hybrid_rerank", contextMode: "adaptive", plannerMode: "mesh_lean", composerMode: "minimal_llm", refinementMode: "adaptive", maxLoops: 3, confidenceGatedRetry: true, confidenceRetryThreshold: "low" }
  },
  {
    strategyId: "S4",
    label: "Retrieval vector-only",
    config: { strategyId: "S4", retrievalMode: "vector", contextMode: "window_thread", plannerMode: "baseline", composerMode: "minimal_llm", refinementMode: "fixed", maxLoops: 2 }
  },
  {
    strategyId: "S5",
    label: "Retrieval lexical-only",
    config: { strategyId: "S5", retrievalMode: "lexical", contextMode: "window_thread", plannerMode: "baseline", composerMode: "minimal_llm", refinementMode: "fixed", maxLoops: 2 }
  },
  {
    strategyId: "S6",
    label: "Retrieval hybrid fusion",
    config: { strategyId: "S6", retrievalMode: "hybrid", contextMode: "window_thread", plannerMode: "baseline", composerMode: "minimal_llm", refinementMode: "fixed", maxLoops: 2 }
  },
  {
    strategyId: "S7",
    label: "Retrieval hybrid + reranking",
    config: { strategyId: "S7", retrievalMode: "hybrid_rerank", contextMode: "window_thread", plannerMode: "baseline", composerMode: "minimal_llm", refinementMode: "fixed", maxLoops: 2 }
  },
  {
    strategyId: "S8",
    label: "Context anchor-only",
    config: { strategyId: "S8", retrievalMode: "hybrid_rerank", contextMode: "anchor_only", plannerMode: "baseline", composerMode: "minimal_llm", refinementMode: "fixed", maxLoops: 2 }
  },
  {
    strategyId: "S9",
    label: "Context anchor + bounded window",
    config: { strategyId: "S9", retrievalMode: "hybrid_rerank", contextMode: "window", plannerMode: "baseline", composerMode: "minimal_llm", refinementMode: "fixed", maxLoops: 2 }
  },
  {
    strategyId: "S10",
    label: "Context anchor + window + thread",
    config: { strategyId: "S10", retrievalMode: "hybrid_rerank", contextMode: "window_thread", plannerMode: "baseline", composerMode: "minimal_llm", refinementMode: "fixed", maxLoops: 2 }
  },
  {
    strategyId: "S11",
    label: "Context adaptive expansion by uncertainty",
    config: { strategyId: "S11", retrievalMode: "hybrid_rerank", contextMode: "adaptive", plannerMode: "baseline", composerMode: "minimal_llm", refinementMode: "adaptive", maxLoops: 3, confidenceGatedRetry: true, confidenceRetryThreshold: "medium" }
  },
  {
    strategyId: "S12",
    label: "Deterministic answer composer",
    config: { strategyId: "S12", retrievalMode: "hybrid_rerank", contextMode: "adaptive", plannerMode: "single_agent_sequential", composerMode: "heuristic", refinementMode: "adaptive", maxLoops: 3 }
  },
  {
    strategyId: "S13",
    label: "Minimal LLM answer composer",
    config: { strategyId: "S13", retrievalMode: "hybrid_rerank", contextMode: "adaptive", plannerMode: "single_agent_sequential", composerMode: "minimal_llm", refinementMode: "adaptive", maxLoops: 3 }
  },
  {
    strategyId: "S14",
    label: "Fixed refinement-loop policy",
    config: { strategyId: "S14", retrievalMode: "hybrid_rerank", contextMode: "adaptive", plannerMode: "single_agent_sequential", composerMode: "minimal_llm", refinementMode: "fixed", maxLoops: 2 }
  },
  {
    strategyId: "S15",
    label: "Adaptive refinement-loop policy",
    config: { strategyId: "S15", retrievalMode: "hybrid_rerank", contextMode: "adaptive", plannerMode: "single_agent_sequential", composerMode: "minimal_llm", refinementMode: "adaptive", maxLoops: 3, confidenceGatedRetry: true, confidenceRetryThreshold: "low" }
  }
];

function expectedContractTemplate(): Record<string, unknown> {
  return {
    decision: true,
    intentSummary: true,
    requiresClarification: true,
    clarificationQuestion: true,
    assumptionsUsed: true,
    constraintChecks: true,
    finalAnswer: true,
    status: true
  };
}

function parseJsonArray(text: string): string[] {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.map((v) => String(v ?? "")).filter((v) => v.length > 0);
  } catch {
    return [];
  }
}

function parsePgTextArray(text: string): string[] {
  const raw = String(text ?? "").trim();
  if (!raw || raw === "{}") return [];
  if (raw.startsWith("{") && raw.endsWith("}")) {
    const body = raw.slice(1, -1).trim();
    if (!body) return [];
    return body
      .split(",")
      .map((item) => item.trim().replace(/^"|"$/g, ""))
      .filter((item) => item.length > 0);
  }
  return parseJsonArray(raw);
}

function parseJsonObject(text: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // noop
  }
  return {};
}

function normalizeFailureCounts(rows: Array<{ bucket: string; count: number }>): FailureBreakdown {
  const out: FailureBreakdown = {
    retrievalMiss: 0,
    rankingFailure: 0,
    contextExpansionMiss: 0,
    threadContinuityMiss: 0,
    actorAttributionMiss: 0,
    temporalInterpretationMiss: 0,
    reasoningSynthesisMiss: 0,
    answerFormatMiss: 0,
    contradictionHandlingMiss: 0,
    provenanceMismatch: 0,
    planWindowCompactionMiss: 0
  };
  for (const row of rows) {
    if (row.bucket === "retrieval_miss") out.retrievalMiss += row.count;
    if (row.bucket === "ranking_failure") out.rankingFailure += row.count;
    if (row.bucket === "context_expansion_miss") out.contextExpansionMiss += row.count;
    if (row.bucket === "thread_continuity_miss") out.threadContinuityMiss += row.count;
    if (row.bucket === "actor_attribution_miss") out.actorAttributionMiss += row.count;
    if (row.bucket === "temporal_interpretation_miss") out.temporalInterpretationMiss += row.count;
    if (row.bucket === "reasoning_synthesis_miss") out.reasoningSynthesisMiss += row.count;
    if (row.bucket === "answer_contract_format_miss") out.answerFormatMiss += row.count;
    if (row.bucket === "contradiction_handling_miss") out.contradictionHandlingMiss += row.count;
    if (row.bucket === "provenance_mismatch") out.provenanceMismatch += row.count;
    if (row.bucket === "plan_window_compaction_miss") out.planWindowCompactionMiss += row.count;
  }
  return out;
}

async function readExperiment(experimentId: string): Promise<ExperimentRow> {
  const row = await pool.query<{
    id: string;
    name: string;
    chat_namespace: string;
    status: "queued" | "running" | "completed" | "failed";
    terminal_state: "normal" | "interrupted" | "aborted";
    interrupted_at: string | null;
    aborted_at: string | null;
    target_pass_rate: number;
    critical_target_pass_rate: number;
    per_domain_floor: number;
    latency_gate_multiplier: number;
    cost_gate_multiplier: number;
    dataset_version: string;
    taxonomy_version_id: string | null;
    active_benchmark_lock_version: string | null;
    autonomous_mode: boolean;
    human_input_allowed: boolean;
    benchmark_generated_at: string | null;
    benchmark_support_scanned_at: string | null;
    benchmark_stale: boolean;
    strategy_cursor: number;
    winner_strategy_id: string | null;
    winner_variant_id: string | null;
    notes: string | null;
    config: Record<string, unknown>;
  }>(
    `SELECT
       id::text,
       name,
       chat_namespace,
       status,
       terminal_state,
       interrupted_at::text,
       aborted_at::text,
       target_pass_rate,
       critical_target_pass_rate,
       per_domain_floor,
       latency_gate_multiplier,
       cost_gate_multiplier,
       dataset_version,
       taxonomy_version_id::text,
       active_benchmark_lock_version,
       autonomous_mode,
       human_input_allowed,
       benchmark_generated_at::text,
       benchmark_support_scanned_at::text,
       benchmark_stale,
       strategy_cursor,
       winner_strategy_id,
       winner_variant_id,
       notes,
       config
     FROM experiment_runs
     WHERE id = $1::uuid`,
    [experimentId]
  );
  if (row.rows.length === 0) {
    throw new Error("Experiment not found");
  }
  return row.rows[0];
}

async function loadExperimentStrategies(experimentId: string): Promise<StrategyRow[]> {
  const rows = await pool.query<{
    id: string;
    strategy_id: string;
    variant_id: string;
    label: string;
    position: number;
    status: "queued" | "running" | "completed" | "failed" | "skipped";
    hypothesis_id: string | null;
    experiment_role: ExperimentRole;
    parent_strategy_variant_id: string | null;
    parent_hypothesis_id: string | null;
    modified_components: string[] | string;
    lineage_reason: string | null;
    config: Record<string, unknown>;
    metrics: Record<string, unknown>;
  }>(
    `SELECT
       id::text,
       strategy_id,
       variant_id,
       label,
       position,
       status,
       hypothesis_id::text,
       experiment_role,
       parent_strategy_variant_id::text,
       parent_hypothesis_id::text,
       COALESCE(modified_components::text, '{}') AS modified_components,
       lineage_reason,
       config,
       metrics
     FROM experiment_strategies
     WHERE experiment_id = $1::uuid
     ORDER BY position ASC`,
    [experimentId]
  );
  return rows.rows.map((row) => ({
    ...row,
    modified_components: Array.isArray(row.modified_components)
      ? row.modified_components.map(String)
      : parsePgTextArray(String(row.modified_components ?? "{}")),
    config: ({
      strategyId: row.strategy_id,
      hypothesisId: row.hypothesis_id ?? undefined,
      experimentRole: row.experiment_role ?? "explore",
      ...(row.config ?? {})
    } as unknown as StrategyVariantConfig)
  }));
}

async function queryDomainEvidence(params: {
  chatNamespace: string;
  domain: string;
  limit: number;
}): Promise<
  Array<{
    canonical_id: string;
    memory_id: string;
    conversation_id: string;
    actor_id: string | null;
    actor_name: string | null;
    source_system: string;
    source_timestamp: string | null;
    content: string;
    has_plan_block: boolean;
    domain_score: number;
  }>
> {
  const rows = await pool.query<{
    canonical_id: string;
    memory_id: string;
    conversation_id: string;
    actor_id: string | null;
    actor_name: string | null;
    source_system: string;
    source_timestamp: string | null;
    content: string;
    has_plan_block: boolean;
    domain_score: string | null;
  }>(
    `SELECT
       c.id::text AS canonical_id,
       c.memory_item_id::text AS memory_id,
       c.conversation_id,
       c.actor_id::text,
       a.canonical_name AS actor_name,
       c.source_system,
       c.observed_at::text AS source_timestamp,
       c.content_normalized AS content,
       (
         lower(c.content_normalized) LIKE '%plan:%'
         OR lower(c.content_normalized) LIKE '%execution plan%'
         OR lower(c.content_normalized) LIKE '%step 1%'
       ) AS has_plan_block,
       CASE
         WHEN COALESCE(c.metadata->'domain_scores'->>$2, '') ~ '^[0-9]+(\\.[0-9]+)?$'
         THEN (c.metadata->'domain_scores'->>$2)
         ELSE NULL
       END AS domain_score
     FROM canonical_messages c
     LEFT JOIN actors a
       ON a.actor_id = c.actor_id
     WHERE c.chat_namespace = $1
       AND c.artifact_state = 'published'
       AND (
         COALESCE(c.metadata->>'primary_domain', '') = $2
         OR COALESCE(c.metadata->'domain_top', '[]'::jsonb) ? $2
         OR (
           CASE
             WHEN COALESCE(c.metadata->'domain_scores'->>$2, '') ~ '^[0-9]+(\\.[0-9]+)?$'
             THEN (c.metadata->'domain_scores'->>$2)::float8
             ELSE 0
           END
         ) >= 0.32
       )
     ORDER BY
       CASE
         WHEN COALESCE(c.metadata->>'primary_domain', '') = $2 THEN 0
         WHEN COALESCE(c.metadata->'domain_top', '[]'::jsonb) ? $2 THEN 1
         ELSE 2
       END ASC,
       CASE
         WHEN COALESCE(c.metadata->'domain_scores'->>$2, '') ~ '^[0-9]+(\\.[0-9]+)?$'
         THEN (c.metadata->'domain_scores'->>$2)::float8
         ELSE 0
       END DESC,
       c.quality_score DESC,
       c.observed_at DESC
     LIMIT $3`,
    [params.chatNamespace, params.domain, params.limit]
  );
  return rows.rows.map((row) => ({
    ...row,
    domain_score: Number(row.domain_score ?? 0)
  })) as Array<{
    canonical_id: string;
    memory_id: string;
    conversation_id: string;
    actor_id: string | null;
    actor_name: string | null;
    source_system: string;
    source_timestamp: string | null;
    content: string;
    has_plan_block: boolean;
    domain_score: number;
  }>;
}

async function loadSeedEvidencePool(params: {
  chatNamespace: string;
  limit: number;
}): Promise<Array<{
  canonical_id: string;
  memory_id: string;
  conversation_id: string;
  source_conversation_id: string | null;
  actor_id: string | null;
  actor_name: string | null;
  actor_type: string | null;
  source_system: string;
  source_timestamp: string | null;
  content: string;
  has_plan_block: boolean;
  primary_domain: string | null;
  domain_top: string[];
  domain_score_map: Record<string, unknown>;
  metadata: Record<string, unknown> | null;
}>> {
  const rows = await pool.query<{
    canonical_id: string;
    memory_id: string;
    conversation_id: string;
    source_conversation_id: string | null;
    actor_id: string | null;
    actor_name: string | null;
    actor_type: string | null;
    source_system: string;
    source_timestamp: string | null;
    content: string;
    has_plan_block: boolean;
    primary_domain: string | null;
    domain_top: string[] | string;
    domain_score_map: Record<string, unknown>;
    metadata: Record<string, unknown> | null;
  }>(
    `SELECT
       c.id::text AS canonical_id,
       c.memory_item_id::text AS memory_id,
       c.conversation_id,
       c.source_conversation_id,
       c.actor_id::text,
       a.canonical_name AS actor_name,
       ac.actor_type,
       c.source_system,
       c.observed_at::text AS source_timestamp,
       c.content_normalized AS content,
       (
         lower(c.content_normalized) LIKE '%plan:%'
         OR lower(c.content_normalized) LIKE '%execution plan%'
         OR lower(c.content_normalized) LIKE '%step 1%'
       ) AS has_plan_block,
       NULLIF(c.metadata->>'primary_domain', '') AS primary_domain,
       COALESCE(c.metadata->'domain_top', '[]'::jsonb)::text AS domain_top,
       COALESCE(c.metadata->'domain_scores', '{}'::jsonb) AS domain_score_map,
       c.metadata
     FROM canonical_messages c
     LEFT JOIN actors a ON a.actor_id = c.actor_id
     LEFT JOIN LATERAL (
       SELECT actor_type
       FROM actor_context
       WHERE actor_id = c.actor_id
         AND chat_namespace = c.chat_namespace
       ORDER BY confidence DESC, updated_at DESC
       LIMIT 1
     ) ac ON true
     WHERE c.chat_namespace = $1
       AND c.artifact_state = 'published'
       AND (
         COALESCE(c.metadata->>'primary_domain', '') <> ''
         OR jsonb_array_length(COALESCE(c.metadata->'domain_top', '[]'::jsonb)) > 0
       )
       AND c.observed_at IS NOT NULL
     ORDER BY c.observed_at DESC
     LIMIT $2`,
    [params.chatNamespace, params.limit]
  );
  return rows.rows.map((row) => ({
    ...row,
    domain_top: Array.isArray(row.domain_top)
      ? row.domain_top.map(String)
      : parseJsonArray(String(row.domain_top ?? "[]")),
    domain_score_map: row.domain_score_map ?? {},
    metadata: row.metadata ?? {}
  }));
}

async function loadConversationContextRows(params: {
  chatNamespace: string;
  conversationId: string;
}): Promise<SeedEvidenceCandidate[]> {
  const rows = await pool.query<{
    canonical_id: string;
    memory_id: string;
    conversation_id: string;
    source_conversation_id: string | null;
    actor_id: string | null;
    actor_name: string | null;
    actor_type: string | null;
    source_system: string;
    source_timestamp: string | null;
    content: string;
    has_plan_block: boolean;
    metadata: Record<string, unknown> | null;
  }>(
    `SELECT
       c.id::text AS canonical_id,
       c.memory_item_id::text AS memory_id,
       c.conversation_id,
       c.source_conversation_id,
       c.actor_id::text AS actor_id,
       a.canonical_name AS actor_name,
       ac.actor_type,
       c.source_system,
       c.observed_at::text AS source_timestamp,
       c.content_normalized AS content,
       (
         lower(c.content_normalized) LIKE '%plan:%'
         OR lower(c.content_normalized) LIKE '%execution plan%'
         OR lower(c.content_normalized) LIKE '%step 1%'
       ) AS has_plan_block,
       c.metadata
     FROM canonical_messages c
     LEFT JOIN actors a ON a.actor_id = c.actor_id
     LEFT JOIN LATERAL (
       SELECT actor_type
       FROM actor_context
       WHERE actor_id = c.actor_id
         AND chat_namespace = c.chat_namespace
       ORDER BY confidence DESC, updated_at DESC
       LIMIT 1
     ) ac ON true
     WHERE c.chat_namespace = $1
       AND c.artifact_state = 'published'
       AND c.conversation_id = $2
       AND c.observed_at IS NOT NULL
     ORDER BY c.observed_at ASC, c.id ASC`,
    [params.chatNamespace, params.conversationId]
  );

  return rows.rows.map((row) => ({
    canonical_id: row.canonical_id,
    memory_id: row.memory_id,
    conversation_id: row.conversation_id,
    source_conversation_id: row.source_conversation_id,
    actor_id: row.actor_id,
    actor_name: row.actor_name,
    actor_type: row.actor_type,
    source_system: row.source_system,
    source_timestamp: row.source_timestamp,
    content: row.content,
    has_plan_block: Boolean(row.has_plan_block),
    domain_score: 1,
    metadata: row.metadata ?? {}
  }));
}

function buildEvidenceByDomainMap(
  evidencePool: Array<{
    canonical_id: string;
    memory_id: string;
    conversation_id: string;
    source_conversation_id: string | null;
    actor_id: string | null;
    actor_name: string | null;
    actor_type: string | null;
    source_system: string;
    source_timestamp: string | null;
    content: string;
    has_plan_block: boolean;
    primary_domain: string | null;
    domain_top: string[];
    domain_score_map: Record<string, unknown>;
    metadata: Record<string, unknown> | null;
  }>,
  options?: {
    minDomainScore?: number;
    includeUserRows?: boolean;
  }
): Map<string, Array<{
  canonical_id: string;
  memory_id: string;
  conversation_id: string;
  source_conversation_id?: string | null;
  actor_id: string | null;
  actor_name: string | null;
  actor_type: string | null;
  source_system: string;
  source_timestamp: string | null;
  content: string;
  has_plan_block: boolean;
  domain_score: number;
  metadata?: Record<string, unknown> | null;
}>> {
  const minDomainScore = Number(options?.minDomainScore ?? MIN_DOMAIN_SCORE_FOR_CASE);
  const includeUserRows = options?.includeUserRows !== false;
  const evidenceByDomain = new Map<string, Array<{
    canonical_id: string;
    memory_id: string;
    conversation_id: string;
    source_conversation_id?: string | null;
    actor_id: string | null;
    actor_name: string | null;
    actor_type: string | null;
    source_system: string;
    source_timestamp: string | null;
    content: string;
    has_plan_block: boolean;
    domain_score: number;
    metadata?: Record<string, unknown> | null;
  }>>();
  for (const row of evidencePool) {
    const inferred = inferStructuredSignals({
      text: row.content,
      contextWindow: [
        ...metadataStringArray(row, "topics").slice(0, 6),
        ...metadataStringArray(row, "people").slice(0, 6)
      ],
      sourceSystem: row.source_system,
      sourceConversationId: row.source_conversation_id ?? row.conversation_id
    });
    const derived = deriveVersionedDomainScores({
      content: row.content,
      sourceSystem: row.source_system,
      sourceConversationId: row.source_conversation_id ?? row.conversation_id,
      storedScoreMap: row.domain_score_map ?? {},
      inferredScoreMap: inferred.domainScores
    });
    const candidateDomains = new Set<string>();
    if (row.primary_domain) candidateDomains.add(String(row.primary_domain));
    for (const domainName of row.domain_top) candidateDomains.add(String(domainName));
    for (const domainName of inferred.domainTop) candidateDomains.add(String(domainName));
    for (const domainName of Object.keys(derived)) candidateDomains.add(String(domainName));
    for (const domainName of candidateDomains) {
      if (!domainName) continue;
      const bucket = evidenceByDomain.get(domainName) ?? [];
      if (bucket.some((existing) => existing.canonical_id === row.canonical_id)) continue;
      if (!includeUserRows && String(row.actor_type ?? "").toLowerCase() === "user") continue;
      const storedScore = Number((row.domain_score_map ?? {})[domainName] ?? (row.primary_domain === domainName ? 1 : 0));
      const inferredScore = Number(inferred.domainScores[domainName as keyof typeof inferred.domainScores] ?? 0);
      const derivedScore = Number(derived[domainName] ?? 0);
      const domainScore = Math.max(storedScore, inferredScore, derivedScore);
      if (domainScore < minDomainScore) continue;
      bucket.push({
        canonical_id: row.canonical_id,
        memory_id: row.memory_id,
        conversation_id: row.conversation_id,
        source_conversation_id: row.source_conversation_id,
        actor_id: row.actor_id,
        actor_name: row.actor_name,
        actor_type: row.actor_type,
        source_system: row.source_system,
        source_timestamp: row.source_timestamp,
        content: row.content,
        has_plan_block: row.has_plan_block,
        domain_score: domainScore,
        metadata: row.metadata ?? {}
      });
      bucket.sort((a, b) => {
        const scoreDiff = Number(b.domain_score ?? 0) - Number(a.domain_score ?? 0);
        if (scoreDiff !== 0) return scoreDiff;
        const actorBias = Number(lowerText(b.actor_type) !== "user") - Number(lowerText(a.actor_type) !== "user");
        if (actorBias !== 0) return actorBias;
        return String(b.source_timestamp ?? "").localeCompare(String(a.source_timestamp ?? ""));
      });
      evidenceByDomain.set(domainName, bucket);
    }
  }
  return evidenceByDomain;
}

function contextFacetSignals(rows: SeedEvidenceCandidate[]): {
  actorMentionCount: number;
  topicCount: number;
  dateMentionCount: number;
  groupConversation: boolean;
  sourceSystems: string[];
} {
  const actorMentions = new Set<string>();
  const topics = new Set<string>();
  const dates = new Set<string>();
  const sourceSystems = new Set<string>();
  let groupConversation = false;
  for (const row of rows) {
    sourceSystems.add(String(row.source_system ?? "").trim().toLowerCase());
    const label = parseConversationLabel(row.source_conversation_id ?? row.conversation_id);
    if (label && isLikelyGroupConversationLabel(label)) groupConversation = true;
    for (const name of metadataStringArray(row, "people")) actorMentions.add(lowerText(name));
    for (const topic of metadataStringArray(row, "topics")) topics.add(lowerText(topic));
    for (const date of metadataStringArray(row, "dates_mentioned")) dates.add(String(date).trim());
  }
  return {
    actorMentionCount: actorMentions.size,
    topicCount: topics.size,
    dateMentionCount: dates.size,
    groupConversation,
    sourceSystems: Array.from(sourceSystems).filter(Boolean).sort()
  };
}

type FacetCoverageAggregate = {
  facetType: TaxonomyFacetType;
  facetKey: string;
  facetLabel: string;
  evidenceCount: number;
  conversationIds: Set<string>;
  benchmarkCaseIds: Set<string>;
  sampleEvidenceIds: string[];
  sampleConversationIds: string[];
  metadata: Record<string, unknown>;
};

function pushUniqueSample(values: string[], value: string, limit = 8): void {
  const normalized = String(value ?? "").trim();
  if (!normalized || values.includes(normalized)) return;
  values.push(normalized);
  if (values.length > limit) values.length = limit;
}

function ensureFacetAggregate(
  aggregates: Map<string, FacetCoverageAggregate>,
  params: {
    facetType: TaxonomyFacetType;
    facetKey: string;
    facetLabel: string;
    metadata?: Record<string, unknown>;
  }
): FacetCoverageAggregate {
  const storeKey = `${params.facetType}|${params.facetKey}`;
  const existing = aggregates.get(storeKey);
  if (existing) return existing;
  const created: FacetCoverageAggregate = {
    facetType: params.facetType,
    facetKey: params.facetKey,
    facetLabel: params.facetLabel,
    evidenceCount: 0,
    conversationIds: new Set<string>(),
    benchmarkCaseIds: new Set<string>(),
    sampleEvidenceIds: [],
    sampleConversationIds: [],
    metadata: params.metadata ?? {}
  };
  aggregates.set(storeKey, created);
  return created;
}

function facetThresholds(facetType: TaxonomyFacetType): { evidenceCount: number; conversationCount: number } {
  switch (facetType) {
    case "source_system":
      return { evidenceCount: 1, conversationCount: 1 };
    case "month_bucket":
      return { evidenceCount: 20, conversationCount: 3 };
    case "actor_name":
      return { evidenceCount: 6, conversationCount: 2 };
    case "group_label":
      return { evidenceCount: 6, conversationCount: 1 };
    case "thread_title":
      return { evidenceCount: 6, conversationCount: 1 };
    default:
      return { evidenceCount: 6, conversationCount: 1 };
  }
}

function classifyFacetCoverage(params: {
  facetType: TaxonomyFacetType;
  evidenceCount: number;
  conversationCount: number;
  benchmarkCaseCount: number;
}): "covered" | "gap" | "sparse" {
  if (params.benchmarkCaseCount > 0) return "covered";
  const thresholds = facetThresholds(params.facetType);
  if (params.evidenceCount >= thresholds.evidenceCount && params.conversationCount >= thresholds.conversationCount) {
    return "gap";
  }
  return "sparse";
}

function monthBucket(timestampIso: string | null | undefined): string | null {
  const ts = Date.parse(String(timestampIso ?? ""));
  if (!Number.isFinite(ts)) return null;
  return new Date(ts).toISOString().slice(0, 7);
}

async function loadBenchmarkCaseCoverageMaps(params: {
  taxonomyVersionId: string;
}): Promise<{
  evidenceCaseIds: Map<string, Set<string>>;
  conversationCaseIds: Map<string, Set<string>>;
}> {
  const rows = await pool.query<{
    case_id: string;
    evidence_ids: string[] | string;
    conversation_ids: string[] | string;
  }>(
    `SELECT
       c.id::text AS case_id,
       COALESCE(c.evidence_ids::text, '{}') AS evidence_ids,
       COALESCE(c.conversation_ids::text, '{}') AS conversation_ids
     FROM experiment_cases c
     JOIN experiment_runs e ON e.id = c.experiment_id
     WHERE e.taxonomy_version_id = $1::uuid
       AND c.is_stale = false
       AND COALESCE(c.metadata->'admissionDecision'->>'status', 'accepted') = 'accepted'`,
    [params.taxonomyVersionId]
  );
  const evidenceCaseIds = new Map<string, Set<string>>();
  const conversationCaseIds = new Map<string, Set<string>>();
  for (const row of rows.rows) {
    const evidenceIds = Array.isArray(row.evidence_ids)
      ? row.evidence_ids.map(String)
      : parsePgTextArray(String(row.evidence_ids ?? "{}"));
    const conversationIds = Array.isArray(row.conversation_ids)
      ? row.conversation_ids.map(String)
      : parsePgTextArray(String(row.conversation_ids ?? "{}"));
    for (const evidenceId of evidenceIds) {
      const bucket = evidenceCaseIds.get(evidenceId) ?? new Set<string>();
      bucket.add(row.case_id);
      evidenceCaseIds.set(evidenceId, bucket);
    }
    for (const conversationId of conversationIds) {
      const bucket = conversationCaseIds.get(conversationId) ?? new Set<string>();
      bucket.add(row.case_id);
      conversationCaseIds.set(conversationId, bucket);
    }
  }
  return {
    evidenceCaseIds,
    conversationCaseIds
  };
}

async function runTaxonomyFacetCoverageScan(params: {
  taxonomyVersionId: string;
  chatNamespace: string;
}): Promise<TaxonomyFacetCoverageSummary> {
  const benchmarkCoverage = await loadBenchmarkCaseCoverageMaps({
    taxonomyVersionId: params.taxonomyVersionId
  });
  const corpusRows = await pool.query<{
    canonical_id: string;
    conversation_id: string;
    source_conversation_id: string | null;
    source_system: string;
    observed_at: string | null;
    actor_id: string | null;
    actor_name: string | null;
    actor_type: string | null;
  }>(
    `SELECT
       c.id::text AS canonical_id,
       c.conversation_id,
       c.source_conversation_id,
       c.source_system,
       c.observed_at::text,
       c.actor_id::text,
       a.canonical_name AS actor_name,
       ac.actor_type
     FROM canonical_messages c
     LEFT JOIN actors a ON a.actor_id = c.actor_id
     LEFT JOIN LATERAL (
       SELECT actor_type
       FROM actor_context
       WHERE actor_id = c.actor_id
         AND chat_namespace = c.chat_namespace
       ORDER BY confidence DESC, updated_at DESC
       LIMIT 1
     ) ac ON true
     WHERE c.chat_namespace = $1
       AND c.artifact_state = 'published'
       AND c.observed_at IS NOT NULL
     ORDER BY c.observed_at DESC, c.id DESC`,
    [params.chatNamespace]
  );

  await pool.query(
    `DELETE FROM taxonomy_facet_coverage
     WHERE taxonomy_version_id = $1::uuid
       AND chat_namespace = $2`,
    [params.taxonomyVersionId, params.chatNamespace]
  );

  const aggregates = new Map<string, FacetCoverageAggregate>();
  const conversationStats = new Map<string, {
    label: string | null;
    isGroup: boolean;
    sourceSystem: string;
    evidenceCount: number;
    sampleEvidenceIds: string[];
    benchmarkCaseIds: Set<string>;
  }>();

  for (const row of corpusRows.rows) {
    const evidenceCaseIds = benchmarkCoverage.evidenceCaseIds.get(row.canonical_id) ?? new Set<string>();
    const conversationCaseIds = benchmarkCoverage.conversationCaseIds.get(row.conversation_id) ?? new Set<string>();

    const sourceAgg = ensureFacetAggregate(aggregates, {
      facetType: "source_system",
      facetKey: String(row.source_system ?? "").trim().toLowerCase() || "unknown",
      facetLabel: String(row.source_system ?? "unknown").trim() || "unknown"
    });
    sourceAgg.evidenceCount += 1;
    sourceAgg.conversationIds.add(row.conversation_id);
    evidenceCaseIds.forEach((id) => sourceAgg.benchmarkCaseIds.add(id));
    pushUniqueSample(sourceAgg.sampleEvidenceIds, row.canonical_id);
    pushUniqueSample(sourceAgg.sampleConversationIds, row.conversation_id);

    const month = monthBucket(row.observed_at);
    if (month) {
      const monthAgg = ensureFacetAggregate(aggregates, {
        facetType: "month_bucket",
        facetKey: month,
        facetLabel: month
      });
      monthAgg.evidenceCount += 1;
      monthAgg.conversationIds.add(row.conversation_id);
      evidenceCaseIds.forEach((id) => monthAgg.benchmarkCaseIds.add(id));
      pushUniqueSample(monthAgg.sampleEvidenceIds, row.canonical_id);
      pushUniqueSample(monthAgg.sampleConversationIds, row.conversation_id);
    }

    const actorName = String(row.actor_name ?? "").trim();
    if (actorName) {
      const actorKey = String(row.actor_id ?? `${String(row.actor_type ?? "").trim().toLowerCase()}:${actorName.toLowerCase()}`);
      const actorAgg = ensureFacetAggregate(aggregates, {
        facetType: "actor_name",
        facetKey: actorKey,
        facetLabel: actorName,
        metadata: {
          actorType: String(row.actor_type ?? "").trim().toLowerCase() || null
        }
      });
      actorAgg.evidenceCount += 1;
      actorAgg.conversationIds.add(row.conversation_id);
      evidenceCaseIds.forEach((id) => actorAgg.benchmarkCaseIds.add(id));
      pushUniqueSample(actorAgg.sampleEvidenceIds, row.canonical_id);
      pushUniqueSample(actorAgg.sampleConversationIds, row.conversation_id);
    }

    const label = parseConversationLabel(row.source_conversation_id ?? row.conversation_id);
    if (label) {
      const conversation = conversationStats.get(row.conversation_id) ?? {
        label,
        isGroup: isLikelyGroupConversationLabel(label),
        sourceSystem: row.source_system,
        evidenceCount: 0,
        sampleEvidenceIds: [],
        benchmarkCaseIds: new Set<string>()
      };
      conversation.label = label;
      conversation.isGroup = isLikelyGroupConversationLabel(label);
      conversation.sourceSystem = row.source_system;
      conversation.evidenceCount += 1;
      pushUniqueSample(conversation.sampleEvidenceIds, row.canonical_id);
      conversationCaseIds.forEach((id) => conversation.benchmarkCaseIds.add(id));
      conversationStats.set(row.conversation_id, conversation);
    }
  }

  for (const [conversationId, convo] of conversationStats.entries()) {
    if (!convo.label) continue;
    const facetType: TaxonomyFacetType = convo.isGroup ? "group_label" : "thread_title";
    const agg = ensureFacetAggregate(aggregates, {
      facetType,
      facetKey: lowerText(convo.label),
      facetLabel: convo.label,
      metadata: {
        sourceSystem: convo.sourceSystem
      }
    });
    agg.evidenceCount += convo.evidenceCount;
    agg.conversationIds.add(conversationId);
    convo.benchmarkCaseIds.forEach((id) => agg.benchmarkCaseIds.add(id));
    convo.sampleEvidenceIds.forEach((id) => pushUniqueSample(agg.sampleEvidenceIds, id));
    pushUniqueSample(agg.sampleConversationIds, conversationId);
  }

  const summaryCounts = new Map<TaxonomyFacetType, { total: number; covered: number; gap: number; sparse: number }>();
  let totalRows = 0;
  let coveredRows = 0;
  let gapRows = 0;
  let sparseRows = 0;
  for (const agg of aggregates.values()) {
    const benchmarkCaseCount = agg.benchmarkCaseIds.size;
    const conversationCount = agg.conversationIds.size;
    const coverageStatus = classifyFacetCoverage({
      facetType: agg.facetType,
      evidenceCount: agg.evidenceCount,
      conversationCount,
      benchmarkCaseCount
    });
    const rationale = coverageStatus === "covered"
      ? `Represented by ${benchmarkCaseCount} benchmark case(s).`
      : coverageStatus === "gap"
        ? `Facet has ${agg.evidenceCount} evidence row(s) across ${conversationCount} conversation(s) but no benchmark cases yet.`
        : `Facet is currently too sparse for benchmark coverage.`;
    await pool.query(
      `INSERT INTO taxonomy_facet_coverage (
         taxonomy_version_id, chat_namespace, facet_type, facet_key, facet_label, coverage_status,
         evidence_count, conversation_count, benchmark_case_count, sample_evidence_ids, sample_conversation_ids,
         rationale, metadata
       ) VALUES (
         $1::uuid, $2, $3, $4, $5, $6,
         $7, $8, $9, $10::uuid[], $11::text[],
         $12, $13::jsonb
       )
       ON CONFLICT (taxonomy_version_id, chat_namespace, facet_type, facet_key)
       DO UPDATE SET
         facet_label = EXCLUDED.facet_label,
         coverage_status = EXCLUDED.coverage_status,
         evidence_count = EXCLUDED.evidence_count,
         conversation_count = EXCLUDED.conversation_count,
         benchmark_case_count = EXCLUDED.benchmark_case_count,
         sample_evidence_ids = EXCLUDED.sample_evidence_ids,
         sample_conversation_ids = EXCLUDED.sample_conversation_ids,
         rationale = EXCLUDED.rationale,
         metadata = EXCLUDED.metadata,
         updated_at = now()`,
      [
        params.taxonomyVersionId,
        params.chatNamespace,
        agg.facetType,
        agg.facetKey,
        agg.facetLabel,
        coverageStatus,
        agg.evidenceCount,
        conversationCount,
        benchmarkCaseCount,
        agg.sampleEvidenceIds,
        agg.sampleConversationIds,
        rationale,
        JSON.stringify(agg.metadata ?? {})
      ]
    );
    totalRows += 1;
    if (coverageStatus === "covered") coveredRows += 1;
    else if (coverageStatus === "gap") gapRows += 1;
    else sparseRows += 1;
    const bucket = summaryCounts.get(agg.facetType) ?? { total: 0, covered: 0, gap: 0, sparse: 0 };
    bucket.total += 1;
    if (coverageStatus === "covered") bucket.covered += 1;
    else if (coverageStatus === "gap") bucket.gap += 1;
    else bucket.sparse += 1;
    summaryCounts.set(agg.facetType, bucket);
  }

  const summary: TaxonomyFacetCoverageSummary = {
    totalRows,
    coveredRows,
    gapRows,
    sparseRows,
    byFacetType: TAXONOMY_FACET_TYPES.map((facetType) => {
      const bucket = summaryCounts.get(facetType) ?? { total: 0, covered: 0, gap: 0, sparse: 0 };
      return {
        facetType,
        totalRows: bucket.total,
        coveredRows: bucket.covered,
        gapRows: bucket.gap,
        sparseRows: bucket.sparse
      };
    })
  };
  await pool.query(
    `UPDATE taxonomy_versions
        SET metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb,
            updated_at = now()
      WHERE id = $1::uuid`,
    [
      params.taxonomyVersionId,
      JSON.stringify({
        latestFacetCoverageScan: {
          chatNamespace: params.chatNamespace,
          totalRows,
          coveredRows,
          gapRows,
          sparseRows,
          scannedAt: nowIso()
        }
      })
    ]
  );
  return summary;
}

async function ensureTaxonomyFacetCoverageRows(params: {
  taxonomyVersionId: string;
  chatNamespace: string;
}): Promise<void> {
  const row = await pool.query<{ c: string }>(
    `SELECT COUNT(*)::text AS c
     FROM taxonomy_facet_coverage
     WHERE taxonomy_version_id = $1::uuid
       AND chat_namespace = $2`,
    [params.taxonomyVersionId, params.chatNamespace]
  );
  if (Number(row.rows[0]?.c ?? 0) > 0) return;
  await runTaxonomyFacetCoverageScan(params);
}

function mergeSplitSignal(
  groups: Map<string, {
    sourceDomainKey: string;
    topicSummary: string;
    evidenceIds: Set<string>;
    conversationIds: Set<string>;
    count: number;
  }>,
  params: {
    sourceDomainKey: string;
    topicSummary: string;
    evidenceIds: string[];
    conversationIds: string[];
    weight?: number;
  }
): void {
  const splitKey = `${params.sourceDomainKey}|${slugifyTaxonomyKey(params.topicSummary)}`;
  const splitAgg = groups.get(splitKey) ?? {
    sourceDomainKey: params.sourceDomainKey,
    topicSummary: params.topicSummary,
    evidenceIds: new Set<string>(),
    conversationIds: new Set<string>(),
    count: 0
  };
  splitAgg.count += Math.max(1, Number(params.weight ?? 1));
  params.evidenceIds.forEach((id) => splitAgg.evidenceIds.add(id));
  params.conversationIds.forEach((id) => splitAgg.conversationIds.add(id));
  groups.set(splitKey, splitAgg);
}

function mergeLensSignal(
  groups: Map<string, {
    title: string;
    evidenceIds: Set<string>;
    conversationIds: Set<string>;
    count: number;
  }>,
  params: {
    proposedKey: string;
    title: string;
    evidenceIds: string[];
    conversationIds: string[];
    weight?: number;
  }
): void {
  const agg = groups.get(params.proposedKey) ?? {
    title: params.title,
    evidenceIds: new Set<string>(),
    conversationIds: new Set<string>(),
    count: 0
  };
  agg.count += Math.max(1, Number(params.weight ?? 1));
  params.evidenceIds.forEach((id) => agg.evidenceIds.add(id));
  params.conversationIds.forEach((id) => agg.conversationIds.add(id));
  groups.set(params.proposedKey, agg);
}

async function collectCorpusOntologySignals(params: {
  taxonomyVersionId: string;
  chatNamespace: string;
}): Promise<{
  splitGroups: Map<string, {
    sourceDomainKey: string;
    topicSummary: string;
    evidenceIds: Set<string>;
    conversationIds: Set<string>;
    count: number;
  }>;
  newLensGroups: Map<string, {
    title: string;
    evidenceIds: Set<string>;
    conversationIds: Set<string>;
    count: number;
  }>;
}> {
  const domainKeys = await loadTaxonomyDomainKeys(params.taxonomyVersionId);
  const evidencePool = await loadSeedEvidencePool({
    chatNamespace: params.chatNamespace,
    limit: Math.max(12000, domainKeys.length * 160)
  });
  const evidenceByDomain = buildEvidenceByDomainMap(evidencePool, {
    minDomainScore: MIN_DOMAIN_SCORE_FOR_SUPPORT_SCAN,
    includeUserRows: true
  });
  const conversationContextCache = new Map<string, SeedEvidenceCandidate[]>();
  const splitGroups = new Map<string, {
    sourceDomainKey: string;
    topicSummary: string;
    evidenceIds: Set<string>;
    conversationIds: Set<string>;
    count: number;
  }>();
  const newLensGroups = new Map<string, {
    title: string;
    evidenceIds: Set<string>;
    conversationIds: Set<string>;
    count: number;
  }>();

  for (const domain of domainKeys) {
    const anchors = (evidenceByDomain.get(domain) ?? []).slice(0, MAX_DOMAIN_ANCHORS_TO_SCAN * 2);
    for (const anchor of anchors) {
      const anchorReject = rejectAnchorReason(anchor.content, anchor.domain_score);
      if (anchorReject) continue;
      let conversationRows = conversationContextCache.get(anchor.conversation_id);
      if (!conversationRows) {
        conversationRows = await loadConversationContextRows({
          chatNamespace: params.chatNamespace,
          conversationId: anchor.conversation_id
        });
        conversationContextCache.set(anchor.conversation_id, conversationRows);
      }
      const contextRows = buildCaseContextRows(anchor, conversationRows);
      const actorName = resolveQuestionActorName(anchor, contextRows);
      const semanticFrame = buildSemanticFrame({
        domain,
        lens: "descriptive",
        window: relativeWindowPhrase(anchor.source_timestamp),
        anchor,
        contextRows,
        actorName,
        minDomainScore: MIN_DOMAIN_SCORE_FOR_SUPPORT_SCAN
      });
      const topicSummary = String(semanticFrame.topicSummary ?? "").trim();
      const evidenceIds = contextRows.map((row) => row.canonical_id).slice(0, 8);
      const conversationIds = Array.from(new Set(contextRows.map((row) => row.conversation_id))).slice(0, 8);
      if (topicSummary && semanticFrame.supportDepth !== "thin") {
        mergeSplitSignal(splitGroups, {
          sourceDomainKey: domain,
          topicSummary,
          evidenceIds,
          conversationIds
        });
      }
      const facetSignals = contextFacetSignals(contextRows);
      if (semanticFrame.statementOwnerRole === "other_human" && actorName) {
        mergeLensSignal(newLensGroups, {
          proposedKey: "actor_attribution",
          title: "Actor attribution lens",
          evidenceIds,
          conversationIds
        });
      }
      if (contextRows.length >= 3 || Boolean(parseConversationLabel(anchor.source_conversation_id ?? anchor.conversation_id))) {
        mergeLensSignal(newLensGroups, {
          proposedKey: "thread_reconstruction",
          title: "Thread reconstruction lens",
          evidenceIds,
          conversationIds
        });
      }
      if (facetSignals.dateMentionCount > 0 || temporalSpreadDays(contextRows) >= 7) {
        mergeLensSignal(newLensGroups, {
          proposedKey: "timeline_reconstruction",
          title: "Timeline reconstruction lens",
          evidenceIds,
          conversationIds
        });
      }
    }
  }

  return {
    splitGroups,
    newLensGroups
  };
}

async function runTaxonomySupportScan(params: {
  taxonomyVersionId: string;
  chatNamespace: string;
}): Promise<OntologyDriftSummary> {
  const domainKeys = await loadTaxonomyDomainKeys(params.taxonomyVersionId);
  const lensKeys = await loadTaxonomyLensKeys(params.taxonomyVersionId);
  const pairs = domainKeys.flatMap((domain) => lensKeys.map((lens) => ({ domain, lens })));
  const evidencePool = await loadSeedEvidencePool({
    chatNamespace: params.chatNamespace,
    limit: Math.max(8000, pairs.length * 24)
  });
  const evidenceByDomain = buildEvidenceByDomainMap(evidencePool, {
    minDomainScore: MIN_DOMAIN_SCORE_FOR_SUPPORT_SCAN,
    includeUserRows: true
  });
  const conversationContextCache = new Map<string, SeedEvidenceCandidate[]>();
  const scannedAt = nowIso();

  await pool.query(
    `DELETE FROM taxonomy_pair_support
     WHERE taxonomy_version_id = $1::uuid
       AND chat_namespace = $2`,
    [params.taxonomyVersionId, params.chatNamespace]
  );

  let supportedPairs = 0;
  let unsupportedPairs = 0;
  let repeatedMismatchCount = 0;
  for (const { domain, lens } of pairs) {
    const evidenceRows = (evidenceByDomain.get(domain) ?? []).slice(0, MAX_DOMAIN_ANCHORS_TO_SCAN);
    const unsupportedReasonCounts = new Map<string, number>();
    const sampleEvidenceIds = new Set<string>();
    const sampleConversationIds = new Set<string>();
    const sourceSystems = new Set<string>();
    let actorMentionClusters = 0;
    let topicRichClusters = 0;
    let dateRichClusters = 0;
    let groupConversationClusters = 0;
    let supportCount = 0;
    let avgDomainScore = 0;
    let scoredAnchors = 0;

    for (const anchor of evidenceRows) {
      const anchorReject = rejectAnchorReason(anchor.content, anchor.domain_score);
      if (anchorReject) {
        unsupportedReasonCounts.set(anchorReject, (unsupportedReasonCounts.get(anchorReject) ?? 0) + 1);
        continue;
      }
      let conversationRows = conversationContextCache.get(anchor.conversation_id);
      if (!conversationRows) {
        conversationRows = await loadConversationContextRows({
          chatNamespace: params.chatNamespace,
          conversationId: anchor.conversation_id
        });
        conversationContextCache.set(anchor.conversation_id, conversationRows);
      }
      const contextRows = buildLensAwareContextRows({
        anchor,
        conversationRows,
        lens
      });
      const lensFailure = lensSupportFailureReason({
        domain,
        lens,
        anchor,
        contextRows,
        minDomainScore: MIN_DOMAIN_SCORE_FOR_SUPPORT_SCAN
      });
      if (lensFailure) {
        unsupportedReasonCounts.set(lensFailure, (unsupportedReasonCounts.get(lensFailure) ?? 0) + 1);
        if (hasTaxonomyMismatchReason([lensFailure])) repeatedMismatchCount += 1;
        continue;
      }
      const semanticFrame = buildSemanticFrame({
        domain,
        lens,
        window: relativeWindowPhrase(anchor.source_timestamp),
        anchor,
        contextRows,
        actorName: resolveQuestionActorName(anchor, contextRows),
        minDomainScore: MIN_DOMAIN_SCORE_FOR_SUPPORT_SCAN
      });
      if (!semanticFrame.supportedLenses.includes(lens)) {
        unsupportedReasonCounts.set("semantic_frame_lens_unsupported", (unsupportedReasonCounts.get("semantic_frame_lens_unsupported") ?? 0) + 1);
        repeatedMismatchCount += 1;
        continue;
      }
      const facetSignals = contextFacetSignals(contextRows);
      supportCount += 1;
      avgDomainScore += Number(anchor.domain_score ?? 0);
      scoredAnchors += 1;
      sampleEvidenceIds.add(anchor.canonical_id);
      sampleConversationIds.add(anchor.conversation_id);
      facetSignals.sourceSystems.forEach((system) => sourceSystems.add(system));
      if (facetSignals.actorMentionCount > 0) actorMentionClusters += 1;
      if (facetSignals.topicCount > 0) topicRichClusters += 1;
      if (facetSignals.dateMentionCount > 0) dateRichClusters += 1;
      if (facetSignals.groupConversation) groupConversationClusters += 1;
      if (sampleEvidenceIds.size >= 4) break;
    }

    const supportStatus: "supported" | "unsupported" = supportCount > 0 ? "supported" : "unsupported";
    if (supportStatus === "supported") supportedPairs += 1;
    else unsupportedPairs += 1;
    await pool.query(
      `INSERT INTO taxonomy_pair_support (
         taxonomy_version_id, chat_namespace, domain_key, lens_key, support_status,
         evidence_count, support_count, avg_domain_score, sample_evidence_ids, sample_conversation_ids,
         rationale, metadata
       ) VALUES (
         $1::uuid, $2, $3, $4, $5, $6, $7, $8, $9::uuid[], $10::text[], $11, $12::jsonb
       )
       ON CONFLICT (taxonomy_version_id, chat_namespace, domain_key, lens_key)
       DO UPDATE SET
         support_status = EXCLUDED.support_status,
         evidence_count = EXCLUDED.evidence_count,
         support_count = EXCLUDED.support_count,
         avg_domain_score = EXCLUDED.avg_domain_score,
         sample_evidence_ids = EXCLUDED.sample_evidence_ids,
         sample_conversation_ids = EXCLUDED.sample_conversation_ids,
         rationale = EXCLUDED.rationale,
         metadata = EXCLUDED.metadata,
         updated_at = now()`,
      [
        params.taxonomyVersionId,
        params.chatNamespace,
        domain,
        lens,
        supportStatus,
        evidenceRows.length,
        supportCount,
        scoredAnchors > 0 ? avgDomainScore / scoredAnchors : 0,
        Array.from(sampleEvidenceIds),
        Array.from(sampleConversationIds),
        supportStatus === "supported"
          ? `Supported by ${supportCount} evidence cluster(s).`
          : `No supported evidence clusters found for ${domain}/${lens}.`,
        JSON.stringify({
          scanVersion: TAXONOMY_SUPPORT_SCAN_VERSION,
          scannedAt,
          unsupportedReasonCounts: Object.fromEntries(unsupportedReasonCounts.entries()),
          facetCoverage: {
            actorMentionClusters,
            topicRichClusters,
            dateRichClusters,
            groupConversationClusters,
            sourceSystems: Array.from(sourceSystems).sort()
          }
        })
      ]
    );
  }

  await pool.query(
    `UPDATE taxonomy_versions
        SET scan_completed_at = now(),
            metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb,
            updated_at = now()
      WHERE id = $1::uuid`,
    [
      params.taxonomyVersionId,
      JSON.stringify({
        latestSupportScan: {
          chatNamespace: params.chatNamespace,
          scanVersion: TAXONOMY_SUPPORT_SCAN_VERSION,
          supportedPairs,
          unsupportedPairs,
          totalPairs: pairs.length,
          scannedAt
        }
      })
    ]
  );
  await pool.query(
    `UPDATE experiment_runs
        SET benchmark_stale = true,
            updated_at = now()
      WHERE taxonomy_version_id = $1::uuid
        AND benchmark_generated_at IS NOT NULL`,
    [params.taxonomyVersionId]
  );

  const facetSummary = await runTaxonomyFacetCoverageScan({
    taxonomyVersionId: params.taxonomyVersionId,
    chatNamespace: params.chatNamespace
  });

  const candidateBacklogRow = await pool.query<{ c: string }>(
    `SELECT COUNT(*)::text AS c
     FROM taxonomy_candidate_reviews
     WHERE taxonomy_version_id = $1::uuid
       AND status = 'pending'`,
    [params.taxonomyVersionId]
  );
  return {
    taxonomyVersionId: params.taxonomyVersionId,
    chatNamespace: params.chatNamespace,
    supportedPairs,
    unsupportedPairs,
    supportCoverageRatio: pairs.length > 0 ? supportedPairs / pairs.length : 0,
    candidateBacklog: Number(candidateBacklogRow.rows[0]?.c ?? 0),
    repeatedMismatchCount,
    latestScanAt: scannedAt,
    facetSummary
  };
}

async function ensureTaxonomySupportRows(params: {
  taxonomyVersionId: string;
  chatNamespace: string;
}): Promise<TaxonomySupportRow[]> {
  const existing = await loadTaxonomySupportRows(params.taxonomyVersionId, params.chatNamespace);
  if (existing.length > 0) return existing;
  await runTaxonomySupportScan(params);
  return loadTaxonomySupportRows(params.taxonomyVersionId, params.chatNamespace);
}

const QUESTION_ALIGNMENT_STOPWORDS = new Set([
  "about", "after", "again", "being", "based", "because", "before", "between", "bring",
  "came", "can", "could", "did", "find", "from", "have", "help", "into", "just", "last",
  "look", "main", "month", "more", "most", "next", "over", "part", "point", "recent",
  "recently", "relationship", "said", "same", "seemed", "should", "something", "stand",
  "step", "summarize", "take", "tell", "that", "their", "them", "there", "these", "this",
  "thread", "trying", "what", "when", "which", "while", "with", "year", "your", "our"
]);

function meaningfulTokens(text: string): string[] {
  return Array.from(new Set(
    String(text ?? "")
      .toLowerCase()
      .split(/[^a-z0-9]+/g)
      .map((token) => token.trim())
      .filter((token) => token.length >= 4 && !QUESTION_ALIGNMENT_STOPWORDS.has(token))
  ));
}

function normalizeOntologyTopicCandidate(topicSummary: string): string | null {
  const tokens = meaningfulTokens(topicSummary)
    .filter((token) => !["today", "tomorrow", "yesterday", "recent", "recently", "thread", "conversation"].includes(token));
  if (tokens.length < 2 || tokens.length > 4) return null;
  const key = slugifyTaxonomyKey(tokens.slice(0, 4).join(" "));
  if (!key || key.length > 40) return null;
  return key;
}

function rankStructuredDomains(text: string): Array<{ domain: string; score: number }> {
  const inferred = inferStructuredSignals({
    text,
    contextWindow: [],
    sourceSystem: "ontology_review",
    sourceConversationId: "ontology_review"
  });
  const derived = deriveVersionedDomainScores({
    content: text,
    sourceSystem: "ontology_review",
    sourceConversationId: "ontology_review",
    storedScoreMap: {},
    inferredScoreMap: inferred.domainScores
  });
  const combined = new Map<string, number>();
  for (const [domain, score] of Object.entries(inferred.domainScores)) combined.set(domain, Number(score ?? 0));
  for (const [domain, score] of Object.entries(derived)) combined.set(domain, Math.max(Number(score ?? 0), Number(combined.get(domain) ?? 0)));
  return Array.from(combined.entries())
    .map(([domain, score]) => ({ domain, score: Number(score ?? 0) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);
}

function semanticCandidatePlausibility(params: {
  candidateType: OntologyCandidate["candidateType"];
  sourceDomainKey?: string | null;
  proposedKey?: string | null;
  topicSummary: string;
  occurrences: number;
}): {
  accepted: boolean;
  reason?: string;
  inferredTopDomain?: string | null;
  inferredTopScore?: number;
} {
  const normalizedTopic = normalizeOntologyTopicCandidate(params.topicSummary);
  const proposedKey = String(params.proposedKey ?? "").trim();
  if (!normalizedTopic && (params.candidateType === "split_candidate" || params.candidateType === "new_domain_candidate")) {
    return { accepted: false, reason: "topic_not_stable_enough" };
  }

  const semanticText = [
    humanizeTaxonomyKey(proposedKey || normalizedTopic || ""),
    params.topicSummary
  ].filter(Boolean).join(". ");
  const ranked = rankStructuredDomains(semanticText);
  const top = ranked[0] ?? null;
  if (!top) {
    return params.occurrences >= 3
      ? { accepted: true, inferredTopDomain: null, inferredTopScore: 0 }
      : { accepted: false, reason: "insufficient_semantic_signal", inferredTopDomain: null, inferredTopScore: 0 };
  }

  if (
    (params.candidateType === "split_candidate" || params.candidateType === "new_domain_candidate")
    && top.score >= 0.62
    && TAXONOMY_DOMAINS.includes(top.domain as (typeof TAXONOMY_DOMAINS)[number])
    && top.domain !== String(params.sourceDomainKey ?? "").trim()
  ) {
    return {
      accepted: false,
      reason: `maps_to_existing_domain:${top.domain}`,
      inferredTopDomain: top.domain,
      inferredTopScore: top.score
    };
  }

  return {
    accepted: true,
    inferredTopDomain: top.domain,
    inferredTopScore: top.score
  };
}

async function loadExperimentCases(
  experimentId: string,
  caseSet?: string,
  lockVersion?: string | null,
  options?: {
    eligibleOnly?: boolean;
  }
): Promise<ExperimentCaseRow[]> {
  const rows = await pool.query<{
    id: string;
    case_set: "dev" | "critical" | "certification" | "stress" | "coverage";
    case_key: string;
    case_type: string;
    domain: string;
    lens: string;
    question: string;
    chat_namespace: string;
    expected_contract: Record<string, unknown>;
    expected_core_claims: string[] | string;
    evidence_ids: string[] | string;
    conversation_ids: string[] | string;
    actor_ids: string[] | string;
    fact_id: string | null;
    source_evidence_id: string | null;
    taxonomy_path: string | null;
    acceptable_answer_forms: string[] | string;
    required_evidence_ids: string[] | string;
    difficulty_type: string;
    generation_method: string;
    ambiguity_class: "clear" | "clarify_required" | "unresolved";
    owner_validation_state: "pending" | "approved" | "rejected" | "not_required";
    clarification_quality_expected: boolean;
    benchmark_lock_version: string | null;
    eligible_for_scoring: boolean;
    metadata: Record<string, unknown>;
  }>(
    `SELECT
       id::text,
       case_set,
       case_key,
       case_type,
       domain,
       lens,
       question,
       chat_namespace,
       expected_contract,
       COALESCE(expected_core_claims::text, '[]') AS expected_core_claims,
       COALESCE(evidence_ids::text, '{}') AS evidence_ids,
       COALESCE(conversation_ids::text, '{}') AS conversation_ids,
       COALESCE(actor_ids::text, '{}') AS actor_ids,
       fact_id::text,
       source_evidence_id::text,
       taxonomy_path,
       COALESCE(acceptable_answer_forms::text, '[]') AS acceptable_answer_forms,
       COALESCE(required_evidence_ids::text, '{}') AS required_evidence_ids,
       difficulty_type,
       generation_method,
       ambiguity_class,
       owner_validation_state,
       clarification_quality_expected,
       benchmark_lock_version,
       eligible_for_scoring,
       metadata
     FROM experiment_cases
     WHERE experiment_id = $1::uuid
       AND is_stale = false
       AND ($2::text IS NULL OR case_set = $2::text)
       AND ($3::text IS NULL OR benchmark_lock_version = $3::text)
       AND ($4::boolean IS NOT TRUE OR eligible_for_scoring = true)
     ORDER BY case_set, domain, lens, case_key`,
    [experimentId, caseSet ?? null, lockVersion ?? null, options?.eligibleOnly === true]
  );

  return rows.rows.map((row) => {
    const evidenceIds = Array.isArray(row.evidence_ids)
      ? row.evidence_ids.map(String)
      : parsePgTextArray(String(row.evidence_ids));
    const conversationIds = Array.isArray(row.conversation_ids)
      ? row.conversation_ids.map(String)
      : parsePgTextArray(String(row.conversation_ids));
    const actorIds = Array.isArray(row.actor_ids)
      ? row.actor_ids.map(String)
      : parsePgTextArray(String(row.actor_ids));
    const acceptableForms = Array.isArray(row.acceptable_answer_forms)
      ? row.acceptable_answer_forms.map(String)
      : parseJsonArray(String(row.acceptable_answer_forms));
    const requiredEvidenceIds = Array.isArray(row.required_evidence_ids)
      ? row.required_evidence_ids.map(String)
      : parsePgTextArray(String(row.required_evidence_ids));
    const expectedCoreClaims = Array.isArray(row.expected_core_claims)
      ? row.expected_core_claims.map(String)
      : parseJsonArray(String(row.expected_core_claims));
    return {
      ...row,
      expected_contract: row.expected_contract ?? {},
      expected_core_claims: expectedCoreClaims,
      evidence_ids: evidenceIds,
      conversation_ids: conversationIds,
      actor_ids: actorIds,
      fact_id: row.fact_id ?? null,
      source_evidence_id: row.source_evidence_id ?? null,
      taxonomy_path: row.taxonomy_path ?? null,
      acceptable_answer_forms: acceptableForms,
      required_evidence_ids: requiredEvidenceIds,
      difficulty_type: row.difficulty_type ?? "direct",
      generation_method: row.generation_method ?? "reverse_engineered",
      ambiguity_class: row.ambiguity_class ?? "clear",
      owner_validation_state: row.owner_validation_state ?? "pending",
      clarification_quality_expected: Boolean(row.clarification_quality_expected),
      benchmark_lock_version: row.benchmark_lock_version ?? null,
      eligible_for_scoring: Boolean(row.eligible_for_scoring),
      metadata: row.metadata ?? {}
    };
  });
}

function readCaseQualityGate(metadata: Record<string, unknown>): {
  status: "pass" | "fail";
  score: number;
  reasons: string[];
  dimensions: {
    naturalness: number;
    answerability: number;
    ambiguityCorrectness: number;
    evidenceGrounding: number;
  };
} {
  const raw = metadata?.qualityGate;
  const gate = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const critique = readAuthoringCritique(metadata);
  const dims = gate.dimensions && typeof gate.dimensions === "object"
    ? (gate.dimensions as Record<string, unknown>)
    : {};
  if (!gate.status && critique) {
    return qualityGateFromAuthoringCritique(critique);
  }
  return {
    status: gate.status === "fail" ? "fail" : "pass",
    score: Number(gate.score ?? 0),
    reasons: Array.isArray(gate.reasons) ? gate.reasons.map(String) : [],
    dimensions: {
      naturalness: Number(dims.naturalness ?? 0),
      answerability: Number(dims.answerability ?? 0),
      ambiguityCorrectness: Number(dims.ambiguityCorrectness ?? 0),
      evidenceGrounding: Number(dims.evidenceGrounding ?? 0)
    }
  };
}

function readSemanticFrame(metadata: Record<string, unknown>): BenchmarkSemanticFrame | null {
  const raw = metadata?.semanticFrame;
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  return {
    domain: String(obj.domain ?? "").trim(),
    lens: String(obj.lens ?? "").trim(),
    participants: Array.isArray(obj.participants) ? obj.participants.map(String).filter(Boolean) : [],
    actorScope: String(obj.actorScope ?? "").trim() || null,
    statementOwnerName: String(obj.statementOwnerName ?? "").trim() || null,
    statementOwnerRole: String(obj.statementOwnerRole ?? "mixed").trim() as "user" | "other_human" | "assistant_or_system" | "mixed",
    preferredQuestionVoices: Array.isArray(obj.preferredQuestionVoices)
      ? obj.preferredQuestionVoices
          .map((item) => String(item ?? "").trim())
          .filter((item): item is "user_first_person" | "user_about_other" | "assistant_proxy" => item === "user_first_person" || item === "user_about_other" || item === "assistant_proxy")
      : preferredVoicesForStatementOwner("mixed"),
    timeframe: String(obj.timeframe ?? "").trim(),
    conversationIntent: String(obj.conversationIntent ?? "").trim(),
    topicSummary: String(obj.topicSummary ?? "").trim(),
    supportDepth: String(obj.supportDepth ?? "thin").trim() as "thin" | "moderate" | "rich",
    ambiguityRisk: String(obj.ambiguityRisk ?? "high").trim() as "low" | "medium" | "high",
    supportedLenses: Array.isArray(obj.supportedLenses) ? obj.supportedLenses.map(String).filter(Boolean) : []
  };
}

function readSemanticFrameSummary(metadata: Record<string, unknown>): string {
  const fromMetadata = compactText(String(metadata?.semanticFrameSummary ?? "").trim(), 240);
  if (fromMetadata) return fromMetadata;
  const frame = readSemanticFrame(metadata);
  return frame ? summarizeSemanticFrame(frame) : "";
}

function readClarificationQuestion(metadata: Record<string, unknown>): string | null {
  const value = compactText(String(metadata?.clarificationQuestion ?? "").trim(), 180);
  return value || null;
}

function readResolvedQuestionAfterClarification(metadata: Record<string, unknown>): string | null {
  const value = compactText(String(metadata?.resolvedQuestionAfterClarification ?? "").trim(), 240);
  return value || null;
}

function readAuthoringCritique(metadata: Record<string, unknown>): BenchmarkAuthoringCritique | null {
  const raw = metadata?.authoringCritique;
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const dims = obj.dimensions && typeof obj.dimensions === "object"
    ? obj.dimensions as Record<string, unknown>
    : {};
  return {
    pass: Boolean(obj.pass),
    score: Number(obj.score ?? 0),
    reasons: Array.isArray(obj.reasons) ? obj.reasons.map(String) : [],
    dimensions: {
      naturalness: Number(dims.naturalness ?? 0),
      actorScopeFidelity: Number(dims.actorScopeFidelity ?? 0),
      ambiguityCorrectness: Number(dims.ambiguityCorrectness ?? 0),
      answerability: Number(dims.answerability ?? 0),
      lensFit: Number(dims.lensFit ?? 0),
      evidenceGrounding: Number(dims.evidenceGrounding ?? 0)
    }
  };
}

function readFeasibilityReport(metadata: Record<string, unknown>): BenchmarkFeasibilityReport | null {
  const raw = metadata?.feasibilityReport;
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  return {
    version: String(obj.version ?? "").trim(),
    verifiedQuestion: String(obj.verifiedQuestion ?? "").trim(),
    pass: Boolean(obj.pass),
    modesTried: Array.isArray(obj.modesTried) ? obj.modesTried.map(String).filter(Boolean) : [],
    exactEvidenceHit: Boolean(obj.exactEvidenceHit),
    conversationHit: Boolean(obj.conversationHit),
    actorConstrainedHit: Boolean(obj.actorConstrainedHit),
    topHits: Array.isArray(obj.topHits)
      ? obj.topHits.map((entry) => {
          const item = entry && typeof entry === "object" ? entry as Record<string, unknown> : {};
          return {
            mode: String(item.mode ?? "").trim(),
            canonicalId: String(item.canonicalId ?? "").trim() || null,
            conversationId: String(item.conversationId ?? "").trim() || null,
            actorName: String(item.actorName ?? "").trim() || null,
            score: Number(item.score ?? 0)
          };
        })
      : [],
    rationale: String(obj.rationale ?? "").trim()
  };
}

function readAdmissionDecision(metadata: Record<string, unknown>): BenchmarkAdmissionDecision | null {
  const raw = metadata?.admissionDecision;
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  return {
    admitted: Boolean(obj.admitted),
    status: String(obj.status ?? "rejected").trim() as "accepted" | "rejected" | "unresolved",
    reasons: Array.isArray(obj.reasons) ? obj.reasons.map(String) : [],
    verifierVersion: String(obj.verifierVersion ?? "").trim()
  };
}

function readExpectedBehavior(row: ExperimentCaseRow): "answer_now" | "clarify_first" {
  const fromMetadata = String(row.metadata?.expectedBehavior ?? "").trim();
  if (fromMetadata === "clarify_first") return "clarify_first";
  if (fromMetadata === "answer_now") return "answer_now";
  return row.ambiguity_class === "clarify_required" ? "clarify_first" : "answer_now";
}

function readExpectedAnswerSummaryHuman(row: ExperimentCaseRow): string {
  const fromMetadata = String(row.metadata?.expectedAnswerSummaryHuman ?? "").trim();
  if (fromMetadata) return fromMetadata;
  return buildHumanAnswerSummary({
    domain: row.domain,
    lens: row.lens,
    expectedBehavior: readExpectedBehavior(row),
    expectedCoreClaims: row.expected_core_claims
  });
}

async function loadEvidencePreviewMap(evidenceIds: string[]): Promise<Map<string, {
  evidenceId: string;
  actorName: string | null;
  observedAt: string | null;
  sourceSystem: string;
  snippet: string;
}>> {
  const ids = Array.from(new Set(evidenceIds.filter((id) => /^[0-9a-fA-F-]{36}$/.test(id))));
  if (ids.length === 0) return new Map();
  const rows = await pool.query<{
    evidence_id: string;
    actor_name: string | null;
    observed_at: string | null;
    source_system: string;
    snippet: string;
  }>(
    `SELECT
       c.id::text AS evidence_id,
       a.canonical_name AS actor_name,
       c.observed_at::text,
       c.source_system,
       c.content_normalized AS snippet
     FROM canonical_messages c
     LEFT JOIN actors a ON a.actor_id = c.actor_id
     WHERE c.id = ANY($1::uuid[])`,
    [ids]
  );
  return new Map(rows.rows.map((row) => [
    row.evidence_id,
    {
      evidenceId: row.evidence_id,
      actorName: row.actor_name ?? null,
      observedAt: row.observed_at ?? null,
      sourceSystem: row.source_system,
      snippet: compactText(row.snippet, 220)
    }
  ]));
}

async function markStaleCases(experimentId: string): Promise<void> {
  await pool.query(
    `UPDATE experiment_cases c
        SET is_stale = true, updated_at = now()
      WHERE c.experiment_id = $1::uuid
        AND NOT EXISTS (
          SELECT 1
          FROM canonical_messages cm
          WHERE cm.id = ANY(c.evidence_ids)
            AND cm.artifact_state = 'published'
        )`,
    [experimentId]
  );
}

function pickSetLabel(index: number): "dev" | "critical" | "certification" {
  if (index % 7 === 0) return "critical";
  if (index % 3 === 0) return "certification";
  return "dev";
}

function inferDifficultyType(lens: string): string {
  if (lens === "descriptive") return "direct_fact";
  if (lens === "diagnostic" || lens === "confidence_scoring") return "paraphrased";
  if (lens === "trend_trajectory" || lens === "predictive") return "temporal";
  if (lens === "counterfactuals" || lens === "causal_hypotheses") return "multi_fact_reasoning";
  if (lens === "outlier_detection") return "ambiguity_resolution";
  return "multi_fact_reasoning";
}

function buildHumanAnswerSummary(params: {
  domain: string;
  lens: string;
  expectedBehavior: "answer_now" | "clarify_first";
  expectedCoreClaims: string[];
  actorName?: string | null;
}): string {
  const actorPart = isLikelyName(params.actorName) ? ` with ${String(params.actorName).trim()}` : "";
  const topClaims = params.expectedCoreClaims.slice(0, 2).join(" ");
  if (params.expectedBehavior === "clarify_first") {
    return `The agent should ask one short clarification question before answering. After clarification, it should retrieve the right conversation${actorPart} and ground the answer in the matching evidence.`;
  }
  if (params.lens === "actionability") {
    return `The answer should state the concrete next step that was proposed${actorPart}, using the evidence rather than guessing.`;
  }
  if (params.lens === "diagnostic") {
    return `The answer should identify the likely cause discussed${actorPart}, grounded in the retrieved conversation.`;
  }
  if (params.lens === "confidence_scoring") {
    return `The answer should explain how confident the agent should be in one conclusion${actorPart}, and mention contradictions if the evidence conflicts.`;
  }
  return topClaims
    ? `The answer should summarize the main point${actorPart} using evidence like: ${topClaims}`
    : `The answer should summarize the relevant conversation${actorPart} using grounded evidence.`;
}

function passesQuestionContextGate(params: {
  question: string;
  focusArea: string;
  actorName: string | null;
  contextRows: SeedEvidenceCandidate[];
}): boolean {
  const contextText = combinedEvidenceText(params.contextRows);
  const questionTokens = meaningfulTokens(params.question);
  const focusTokens = meaningfulTokens(params.focusArea);
  const questionOverlap = questionTokens.filter((token) => contextText.includes(token)).length;
  const focusOverlap = focusTokens.filter((token) => contextText.includes(token)).length;
  let actorHit = false;
  if (params.actorName) {
    actorHit = params.contextRows.some((row) => String(row.actor_name ?? "").trim().toLowerCase() === params.actorName!.trim().toLowerCase());
    if (!actorHit) return false;
  }
  if (questionOverlap >= 2 || focusOverlap >= 1) return true;
  if (actorHit && params.contextRows.length >= 2) return true;
  return false;
}

function robustnessVariants(params: {
  domain: string;
  lens: string;
  window: string;
  anchorContent: string;
  focusArea: string;
  anchorSnippet: string;
  actorName?: string | null;
  domainScore?: number;
}): Array<{
  kind: "paraphrase" | "vague" | "temporal_relative" | "disambiguation";
  question: string;
  difficultyType: string;
  ambiguityClass: "clear" | "clarify_required" | "unresolved";
  clarificationPrompt: string | null;
  expectedBehavior: "answer_now" | "clarify_first";
  qualityGate: {
    status: "pass" | "fail";
    score: number;
    reasons: string[];
    dimensions: {
      naturalness: number;
      answerability: number;
      ambiguityCorrectness: number;
      evidenceGrounding: number;
    };
  };
}> {
  const baseWindow = temporalQualifier(params.window);
  const anchorRejectReason = rejectAnchorReason(params.anchorContent, Number(params.domainScore ?? 0));
  const baseCandidates: Array<{
    kind: "paraphrase" | "vague" | "temporal_relative" | "disambiguation";
    difficultyType: string;
    mode: "paraphrase" | "clarify" | "temporal" | "disambiguation";
    ambiguityClass: "clear" | "clarify_required";
  }> = [
    {
      kind: "paraphrase",
      difficultyType: "paraphrased",
      mode: "paraphrase",
      ambiguityClass: "clear"
    },
    {
      kind: "vague",
      difficultyType: "ambiguity_resolution",
      mode: "clarify",
      ambiguityClass: "clarify_required"
    },
    {
      kind: "temporal_relative",
      difficultyType: "temporal",
      mode: "temporal",
      ambiguityClass: "clear"
    }
  ];
  if (params.lens === "diagnostic" || params.lens === "counterfactuals" || params.lens === "outlier_detection") {
    baseCandidates.push({
      kind: "disambiguation",
      difficultyType: "ambiguity_resolution"
      ,
      mode: "disambiguation",
      ambiguityClass: "clarify_required"
    });
  }
  return baseCandidates.map((candidate) => {
    const clarificationPrompt = candidate.ambiguityClass === "clarify_required"
      ? clarificationPromptForDomain(params.domain, params.focusArea)
      : null;
    const question = buildQuestionTemplate({
      lens: params.lens,
      domain: params.domain,
      focusArea: params.focusArea,
      actorName: params.actorName,
      window: baseWindow,
      mode: candidate.mode
    });
    const qualityGate = scoreCaseQuality({
      question,
      ambiguityClass: candidate.ambiguityClass,
      clarificationPrompt,
      evidenceIds: params.anchorSnippet ? [params.anchorSnippet] : [],
      anchorRejectReason,
      domainScore: Number(params.domainScore ?? 0)
    });
    return {
      kind: candidate.kind,
      question,
      difficultyType: candidate.difficultyType,
      ambiguityClass: qualityGate.status === "pass" ? candidate.ambiguityClass : "unresolved",
      clarificationPrompt,
      expectedBehavior: candidate.ambiguityClass === "clarify_required" ? "clarify_first" : "answer_now",
      qualityGate
    };
  });
}

async function upsertExperimentCase(params: {
  experimentId: string;
  caseSet: "dev" | "critical" | "certification" | "stress" | "coverage";
  caseKey: string;
  caseType: string;
  domain: string;
  lens: string;
  question: string;
  chatNamespace: string;
  expectedCoreClaims: string[];
  evidenceIds: string[];
  conversationIds: string[];
  actorIds: string[];
  sourceEvidenceId: string | null;
  taxonomyPath: string;
  difficultyType: string;
  generationMethod: string;
  ambiguityClass: "clear" | "clarify_required" | "unresolved";
  ownerValidationState: "pending" | "approved" | "rejected" | "not_required";
  clarificationQualityExpected: boolean;
  metadata: Record<string, unknown>;
}): Promise<void> {
  await pool.query(
    `INSERT INTO experiment_cases (
       experiment_id,
       case_set,
       case_key,
       case_type,
       domain,
       lens,
       question,
       chat_namespace,
       expected_contract,
       expected_core_claims,
       evidence_ids,
       conversation_ids,
       actor_ids,
       fact_id,
       source_evidence_id,
       taxonomy_path,
       acceptable_answer_forms,
       required_evidence_ids,
       difficulty_type,
       generation_method,
       ambiguity_class,
       owner_validation_state,
       clarification_quality_expected,
       benchmark_lock_version,
       eligible_for_scoring,
       metadata,
       is_stale
     ) VALUES (
       $1::uuid, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11::uuid[], $12::text[], $13::uuid[],
       $14::uuid, $15::uuid, $16, $17::jsonb, $18::uuid[], $19, $20, $21, $22, $23, $24, $25, $26::jsonb, false
     )
     ON CONFLICT (experiment_id, case_set, case_key)
     DO UPDATE SET
       question = EXCLUDED.question,
       expected_contract = EXCLUDED.expected_contract,
       expected_core_claims = EXCLUDED.expected_core_claims,
       evidence_ids = EXCLUDED.evidence_ids,
       conversation_ids = EXCLUDED.conversation_ids,
       actor_ids = EXCLUDED.actor_ids,
       fact_id = EXCLUDED.fact_id,
       source_evidence_id = EXCLUDED.source_evidence_id,
       taxonomy_path = EXCLUDED.taxonomy_path,
       acceptable_answer_forms = EXCLUDED.acceptable_answer_forms,
       required_evidence_ids = EXCLUDED.required_evidence_ids,
       difficulty_type = EXCLUDED.difficulty_type,
       generation_method = EXCLUDED.generation_method,
       ambiguity_class = EXCLUDED.ambiguity_class,
       owner_validation_state = EXCLUDED.owner_validation_state,
       clarification_quality_expected = EXCLUDED.clarification_quality_expected,
       benchmark_lock_version = NULL,
       eligible_for_scoring = false,
       metadata = EXCLUDED.metadata,
       chat_namespace = EXCLUDED.chat_namespace,
       is_stale = false,
       updated_at = now()`,
    [
      params.experimentId,
      params.caseSet,
      params.caseKey,
      params.caseType,
      params.domain,
      params.lens,
      params.question,
      params.chatNamespace,
      JSON.stringify(expectedContractTemplate()),
      JSON.stringify(params.expectedCoreClaims),
      params.evidenceIds,
      params.conversationIds,
      params.actorIds,
      null,
      params.sourceEvidenceId,
      params.taxonomyPath,
      JSON.stringify(["direct", "estimate", "evidence_cited"]),
      params.evidenceIds,
      params.difficultyType,
      params.generationMethod,
      params.ambiguityClass,
      params.ownerValidationState,
      params.clarificationQualityExpected,
      null,
      false,
      JSON.stringify(params.metadata)
    ]
  );
}

async function seedExperimentCases(params: {
  experimentId: string;
  chatNamespace: string;
  maxCasesPerPair: number;
  taxonomyVersionId: string;
}): Promise<{ inserted: number; staleMarked: number }> {
  await markStaleCases(params.experimentId);

  const stale = await pool.query<{ c: string }>(
    `SELECT COUNT(*)::text AS c
     FROM experiment_cases
     WHERE experiment_id = $1::uuid
       AND is_stale = true`,
    [params.experimentId]
  );
  const staleMarked = Number(stale.rows[0]?.c ?? 0);

  const supportRows = await ensureTaxonomySupportRows({
    taxonomyVersionId: params.taxonomyVersionId,
    chatNamespace: params.chatNamespace
  });
  const pairs = supportRows
    .filter((row) => row.supportStatus === "supported")
    .map((row) => ({
      domain: row.domainKey,
      lens: row.lensKey
    }));
  const evidencePool = await loadSeedEvidencePool({
    chatNamespace: params.chatNamespace,
    limit: Math.max(6000, pairs.length * Math.max(8, params.maxCasesPerPair * 4))
  });
  const evidenceByDomain = buildEvidenceByDomainMap(evidencePool, {
    minDomainScore: MIN_DOMAIN_SCORE_FOR_CASE,
    includeUserRows: true
  });
  const conversationContextCache = new Map<string, SeedEvidenceCandidate[]>();

  let inserted = 0;
  const coveragePairs: Array<{
    domain: string;
    lens: string;
    anchor: SeedEvidenceCandidate;
    actorName: string | null;
    contextRows: SeedEvidenceCandidate[];
    draft: BenchmarkAuthoringDraft;
    feasibilityReport: BenchmarkFeasibilityReport;
    admissionDecision: BenchmarkAdmissionDecision;
  }> = [];

  for (let i = 0; i < pairs.length; i += 1) {
    const { domain, lens } = pairs[i];
    console.log(`[authoring] pair ${i + 1}/${pairs.length} ${domain}/${lens}`);
    const evidenceRows = (evidenceByDomain.get(domain) ?? []).slice(0, MAX_DOMAIN_ANCHORS_TO_SCAN);
    if (evidenceRows.length === 0) continue;

    let generatedForPair = 0;
    const retryIndexes: number[] = [];
    const processAnchorAtIndex = async (j: number, collectRetry: boolean): Promise<void> => {
      const anchor = evidenceRows[j];
      const anchorReject = rejectAnchorReason(anchor.content, anchor.domain_score);
      if (anchorReject) {
        console.log(`[authoring] skip ${domain}/${lens} anchor ${j + 1}: ${anchorReject}`);
        return;
      }
      let conversationRows = conversationContextCache.get(anchor.conversation_id);
      if (!conversationRows) {
        conversationRows = await loadConversationContextRows({
          chatNamespace: params.chatNamespace,
          conversationId: anchor.conversation_id
        });
        conversationContextCache.set(anchor.conversation_id, conversationRows);
      }
      const contextRows = buildCaseContextRows(anchor, conversationRows);
      const actorName = resolveQuestionActorName(anchor, contextRows);
      const caseSet = pickSetLabel(i + j);
      const window = relativeWindowPhrase(anchor.source_timestamp);
      const caseType = `${lens}:${domain}`;
      const caseKey = `${domain}:${lens}:${generatedForPair + 1}`;
      const evidenceIds = contextRows.map((row) => row.canonical_id);
      const conversationIds = Array.from(new Set(contextRows.map((row) => row.conversation_id)));
      const actorIds = Array.from(new Set(contextRows.map((row) => row.actor_id).filter((id): id is string => Boolean(id))));
      const expectedCoreClaims = contextRows.map((row) => compactText(row.content, 140));
      const hasPlan = contextRows.some((row) => row.has_plan_block);
      const difficultyType = inferDifficultyType(lens);
      const taxonomyPath = `${domain}.${lens}`;
      const semanticFrame = buildSemanticFrame({
        domain,
        lens,
        window,
        anchor,
        contextRows,
        actorName
      });
      if (!semanticFrame.supportedLenses.includes(lens)) {
        console.log(`[authoring] skip ${domain}/${lens} anchor ${j + 1}: requested lens not supported by cluster`);
        return;
      }
      if (semanticFrame.supportDepth === "thin" && lens !== "descriptive") {
        console.log(`[authoring] skip ${domain}/${lens} anchor ${j + 1}: support depth too thin`);
        return;
      }
      const authored = await authorBenchmarkCaseWithRepairs({
        chatNamespace: params.chatNamespace,
        domain,
        lens,
        window,
        actorName,
        semanticFrame,
        contextRows,
        anchor,
        domainScore: anchor.domain_score,
        evidenceIds,
        conversationIds
      });
      if (!authored) {
        if (collectRetry) retryIndexes.push(j);
        return;
      }
      const {
        draft: authoringDraft,
        critique: authoringCritique,
        hardGuardReasons,
        feasibilityReport,
        admissionDecision
      } = authored;
      const storedAmbiguityClass: "clear" | "clarify_required" | "unresolved" = admissionDecision.status === "unresolved"
        ? "unresolved"
        : (authoringDraft.expectedBehavior === "clarify_first" ? "clarify_required" : "clear");
      const ownerValidationState: "pending" | "approved" | "rejected" | "not_required" = admissionDecision.admitted
        ? "pending"
        : "not_required";
      await upsertExperimentCase({
        experimentId: params.experimentId,
        caseSet,
        caseKey,
        caseType,
        domain,
        lens,
        question: authoringDraft.chosenQuestion,
        chatNamespace: params.chatNamespace,
        expectedCoreClaims,
        evidenceIds,
        conversationIds,
        actorIds,
        sourceEvidenceId: anchor.canonical_id,
        taxonomyPath,
        difficultyType,
        generationMethod: `v1.6_${authoringDraft.expectedBehavior === "clarify_first" ? "clarify" : "direct"}`,
        ambiguityClass: storedAmbiguityClass,
        ownerValidationState,
        clarificationQualityExpected: authoringDraft.expectedBehavior === "clarify_first",
        metadata: {
          generationVersion: BENCHMARK_AUTHORING_VERSION,
          authoringVersion: BENCHMARK_AUTHORING_VERSION,
          window,
          expectedBehavior: authoringDraft.expectedBehavior,
          expectedAnswerSummaryHuman: authoringDraft.expectedAnswerSummaryHuman,
          qualityGate: qualityGateFromAuthoringCritique(authoringDraft.authoringCritique),
          semanticFrame: authoringDraft.semanticFrame,
          questionVoice: authoringDraft.questionVoice,
          candidateQuestions: authoringDraft.candidateQuestions,
          chosenQuestionRationale: authoringDraft.chosenQuestionRationale,
          authoringDecision: authoringDraft.authoringDecision,
          rejectionReasons: authoringDraft.rejectionReasons,
          clarificationQuestion: authoringDraft.clarificationQuestion,
          resolvedQuestionAfterClarification: authoringDraft.resolvedQuestionAfterClarification,
          authoringCritique: authoringDraft.authoringCritique,
          feasibilityReport,
          admissionDecision,
          semanticFrameSummary: summarizeSemanticFrame(authoringDraft.semanticFrame),
          planWindowExpected: hasPlan,
          contradictionExpected: domain === "financial_behavior" || lens === "confidence_scoring"
        }
      });
      inserted += 1;
      console.log(`[authoring] ${domain}/${lens} => ${admissionDecision.status} | score=${authoringCritique.score.toFixed(2)} | oracle=${feasibilityReport.pass ? "pass" : "fail"} | voice=${authoringDraft.questionVoice ?? "unknown"}`);
      if (!admissionDecision.admitted) return;

      generatedForPair += 1;
      coveragePairs.push({
        domain,
        lens,
        anchor,
        actorName,
        contextRows,
        draft: authoringDraft,
        feasibilityReport,
        admissionDecision
      });

      const variantDifficulty = (kind: string): string => {
        if (kind === "paraphrase_clear") return "paraphrased";
        if (kind === "clarify_first") return "ambiguity_resolution";
        if (kind === "temporal_relative") return "temporal";
        return difficultyType;
      };
      const variantPriority = ["paraphrase_clear", "clarify_first", "temporal_relative", "direct_clear"];
      const variants = Array.from(new Map(
        authoringDraft.candidateQuestions
          .filter((item) => item.question !== authoringDraft.chosenQuestion)
          .sort((a, b) => variantPriority.indexOf(a.kind) - variantPriority.indexOf(b.kind))
          .map((item) => [item.kind, item])
      ).values()).slice(0, 2);
      for (const variant of variants) {
        const variantHardGuardReasons = buildAuthoringHardGuardReasons({
          anchor,
          contextRows,
          question: variant.question,
          expectedBehavior: variant.expectedBehavior,
          domain,
          lens
        });
        const variantCritique = scoreAuthoringCritique({
          question: variant.question,
          questionVoice: authoringDraft.questionVoice,
          expectedBehavior: variant.expectedBehavior,
          clarificationQuestion: variant.clarificationQuestion,
          resolvedQuestionAfterClarification: variant.resolvedQuestionAfterClarification,
          actorName,
          domain,
          lens,
          semanticFrame: authoringDraft.semanticFrame,
          contextRows,
          domainScore: anchor.domain_score,
          hardGuardReasons: variantHardGuardReasons
        });
        const variantFeasibility = await runOracleFeasibilityVerifier({
          chatNamespace: params.chatNamespace,
          question: variant.question,
          resolvedQuestionAfterClarification: variant.resolvedQuestionAfterClarification,
          actorName,
          evidenceIds,
          conversationIds
        });
        const variantAdmission = buildAdmissionDecision({
          critique: variantCritique,
          feasibility: variantFeasibility,
          hardGuardReasons: variantHardGuardReasons
        });
        const variantStoredAmbiguity: "clear" | "clarify_required" | "unresolved" = variantAdmission.status === "unresolved"
          ? "unresolved"
          : (variant.expectedBehavior === "clarify_first" ? "clarify_required" : "clear");
        await upsertExperimentCase({
          experimentId: params.experimentId,
          caseSet: "stress",
          caseKey: `stress:${domain}:${lens}:${generatedForPair}:${variant.kind}`,
          caseType: `${caseType}:stress:${variant.kind}`,
          domain,
          lens,
          question: variant.question,
          chatNamespace: params.chatNamespace,
          expectedCoreClaims,
          evidenceIds,
          conversationIds,
          actorIds,
          sourceEvidenceId: anchor.canonical_id,
          taxonomyPath,
          difficultyType: variantDifficulty(variant.kind),
          generationMethod: `v1.6_${variant.kind}`,
          ambiguityClass: variantStoredAmbiguity,
          ownerValidationState: variantAdmission.admitted ? "pending" : "not_required",
          clarificationQualityExpected: variant.expectedBehavior === "clarify_first",
          metadata: {
            generationVersion: BENCHMARK_AUTHORING_VERSION,
            authoringVersion: BENCHMARK_AUTHORING_VERSION,
            window,
            robustnessVariant: variant.kind,
            sourceCaseKey: caseKey,
            expectedBehavior: variant.expectedBehavior,
            expectedAnswerSummaryHuman: buildHumanAnswerSummary({
              domain,
              lens,
              expectedBehavior: variant.expectedBehavior,
              expectedCoreClaims,
              actorName
            }),
            qualityGate: qualityGateFromAuthoringCritique(variantCritique),
            semanticFrame: authoringDraft.semanticFrame,
            questionVoice: authoringDraft.questionVoice,
            candidateQuestions: authoringDraft.candidateQuestions,
            chosenQuestionRationale: variant.rationale,
            authoringDecision: "accept",
            rejectionReasons: [],
            clarificationQuestion: variant.clarificationQuestion,
            resolvedQuestionAfterClarification: variant.resolvedQuestionAfterClarification,
            authoringCritique: variantCritique,
            feasibilityReport: variantFeasibility,
            admissionDecision: variantAdmission,
            semanticFrameSummary: summarizeSemanticFrame(authoringDraft.semanticFrame),
            contradictionExpected: domain === "financial_behavior" || lens === "confidence_scoring"
          }
        });
        inserted += 1;
      }
    };
    for (let j = 0; j < evidenceRows.length && generatedForPair < params.maxCasesPerPair; j += 1) {
      await processAnchorAtIndex(j, true);
    }
    if (generatedForPair < params.maxCasesPerPair) {
      for (const retryIndex of retryIndexes) {
        if (generatedForPair >= params.maxCasesPerPair) break;
        await processAnchorAtIndex(retryIndex, false);
      }
    }
  }

  for (const pair of coveragePairs.slice(0, 300)) {
    const anchor = pair.anchor;
    const coverageDraft = pair.draft;
    await upsertExperimentCase({
      experimentId: params.experimentId,
      caseSet: "coverage",
      caseKey: `${pair.domain}:${pair.lens}`,
      caseType: `coverage:${pair.domain}:${pair.lens}`,
      domain: pair.domain,
      lens: pair.lens,
      question: coverageDraft.chosenQuestion,
      chatNamespace: params.chatNamespace,
      expectedCoreClaims: pair.contextRows.map((row) => compactText(row.content, 140)),
      evidenceIds: pair.contextRows.map((row) => row.canonical_id),
      conversationIds: Array.from(new Set(pair.contextRows.map((row) => row.conversation_id))),
      actorIds: Array.from(new Set(pair.contextRows.map((row) => row.actor_id).filter((id): id is string => Boolean(id)))),
      sourceEvidenceId: anchor.canonical_id,
      taxonomyPath: `${pair.domain}.${pair.lens}`,
      difficultyType: inferDifficultyType(pair.lens),
      generationMethod: "v1.6_coverage",
      ambiguityClass: coverageDraft.expectedBehavior === "clarify_first" ? "clarify_required" : "clear",
      ownerValidationState: "pending",
      clarificationQualityExpected: coverageDraft.expectedBehavior === "clarify_first",
      metadata: {
        generationVersion: BENCHMARK_AUTHORING_VERSION,
        authoringVersion: BENCHMARK_AUTHORING_VERSION,
        window: relativeWindowPhrase(anchor.source_timestamp),
        coverage: true,
        expectedBehavior: coverageDraft.expectedBehavior,
        expectedAnswerSummaryHuman: coverageDraft.expectedAnswerSummaryHuman,
        qualityGate: qualityGateFromAuthoringCritique(coverageDraft.authoringCritique),
        semanticFrame: coverageDraft.semanticFrame,
        questionVoice: coverageDraft.questionVoice,
        candidateQuestions: coverageDraft.candidateQuestions,
        chosenQuestionRationale: coverageDraft.chosenQuestionRationale,
        clarificationQuestion: coverageDraft.clarificationQuestion,
        resolvedQuestionAfterClarification: coverageDraft.resolvedQuestionAfterClarification,
        authoringCritique: coverageDraft.authoringCritique,
        feasibilityReport: pair.feasibilityReport,
        admissionDecision: pair.admissionDecision,
        semanticFrameSummary: summarizeSemanticFrame(coverageDraft.semanticFrame)
      }
    });
    inserted += 1;
  }

  return { inserted, staleMarked };
}

function extractReturnedCanonicalIds(response: V2AskResponse): string[] {
  const ids = new Set<string>();
  for (const ev of response.evidence ?? []) {
    if (ev.canonicalId && /^[0-9a-fA-F-]{36}$/.test(ev.canonicalId)) ids.add(ev.canonicalId);
  }
  return Array.from(ids);
}

function answerHasContractShape(response: V2AskResponse): boolean {
  const a = response.answerContract;
  if (!a) return false;
  const decisionOk = a.decision === "answer_now" || a.decision === "clarify_first" || a.decision === "insufficient";
  const statusOk = ["definitive", "estimated", "partial", "insufficient", "clarification_needed"].includes(a.status);
  const checksOk = Array.isArray(a.constraintChecks);
  const assumptionsOk = Array.isArray(a.assumptionsUsed);
  const clarificationOk = a.clarificationQuestion === null || typeof a.clarificationQuestion === "string";
  const finalAnswerOk = a.finalAnswer === null || (
    typeof a.finalAnswer === "object"
    && (a.finalAnswer.direct === null || typeof a.finalAnswer.direct === "string")
    && (a.finalAnswer.estimate === null || typeof a.finalAnswer.estimate === "string")
    && (a.finalAnswer.contradictionCallout === null || typeof a.finalAnswer.contradictionCallout === "string")
    && typeof a.finalAnswer.definitiveNextData === "string"
    && ["low", "medium", "high"].includes(a.finalAnswer.confidence)
  );
  return Boolean(
    decisionOk
    && statusOk
    && typeof a.intentSummary === "string"
    && typeof a.requiresClarification === "boolean"
    && clarificationOk
    && assumptionsOk
    && checksOk
    && finalAnswerOk
  );
}

function estimateCostPer1k(response: V2AskResponse): number {
  const loops = Number(response.qualitySignals?.loopCount ?? 1);
  const evidenceCount = Number(response.evidence?.length ?? 0);
  const base = 6.5;
  return Number((base + loops * 1.25 + evidenceCount * 0.12).toFixed(3));
}

function normalizeConfidenceLevel(value: unknown): "low" | "medium" | "high" {
  const raw = String(value ?? "").trim().toLowerCase();
  if (raw.includes("high")) return "high";
  if (raw.includes("med")) return "medium";
  return "low";
}

function shouldApplyConfidenceRetry(params: {
  config: StrategyVariantConfig;
  response: V2AskResponse;
  evaluated: { recallAtK: number; evidenceHitRate: number; returnedEvidenceIds: string[]; pass: boolean };
}): boolean {
  if (!params.config.confidenceGatedRetry) return false;
  if (params.evaluated.pass) return false;
  const threshold = params.config.confidenceRetryThreshold ?? "low";
  const confidence = normalizeConfidenceLevel(params.response.answerContract?.finalAnswer?.confidence);
  const lowEvidence = params.evaluated.returnedEvidenceIds.length === 0 || params.evaluated.recallAtK <= 0 || params.evaluated.evidenceHitRate <= 0;
  if (!lowEvidence) return false;
  if (threshold === "medium") return confidence === "low" || confidence === "medium";
  return confidence === "low";
}

function evaluateCase(params: {
  row: ExperimentCaseRow;
  response: V2AskResponse;
  latencyMs: number;
}): {
  pass: boolean;
  score: number;
  buckets: FailureBucket[];
  returnedEvidenceIds: string[];
  recallAtK: number;
  mrr: number;
  ndcg: number;
  evidenceHitRate: number;
  estimatedCostPer1k: number;
  clarificationTriggered: boolean;
  clarificationQualityScore: number;
  scoringBucket: "clear" | "clarify" | "unresolved_excluded";
} {
  const { row, response } = params;
  const buckets: FailureBucket[] = [];
  const returnedEvidenceIds = extractReturnedCanonicalIds(response);
  const expectedEvidence = new Set(row.evidence_ids);
  const metadata = row.metadata ?? {};
  const ambiguityClass =
    row.ambiguity_class
    ?? (Boolean(metadata.clarificationNeeded) ? "clarify_required" : "clear");
  const clarificationExpected = ambiguityClass === "clarify_required" || Boolean(metadata.clarificationNeeded);
  const unresolved = ambiguityClass === "unresolved" || row.eligible_for_scoring === false;
  const clarificationTriggered = response.answerContract?.decision === "clarify_first"
    && Boolean(String(response.answerContract?.clarificationQuestion ?? "").trim());
  const clarificationQuestion = String(response.answerContract?.clarificationQuestion ?? "").trim();
  const clarificationQualityScore = clarificationTriggered
    ? (() => {
        const shortEnough = clarificationQuestion.length > 0 && clarificationQuestion.length <= 140;
        const endsAsQuestion = /\?$/.test(clarificationQuestion);
        const specificCue = /(which|what|who|when|where|scope|metric|time window|person|group|topic)/i.test(clarificationQuestion);
        const score = (shortEnough ? 0.4 : 0) + (endsAsQuestion ? 0.3 : 0) + (specificCue ? 0.3 : 0);
        return Math.max(0, Math.min(1, score));
      })()
    : 0;
  const answerText = [
    String(response.answerContract?.finalAnswer?.direct ?? ""),
    String(response.answerContract?.finalAnswer?.estimate ?? ""),
    String(response.answerContract?.intentSummary ?? "")
  ].join(" ");
  const overlap = returnedEvidenceIds.filter((id) => expectedEvidence.has(id)).length;
  const recallAtK = expectedEvidence.size > 0 ? overlap / expectedEvidence.size : ((response.evidence?.length ?? 0) > 0 ? 1 : 0);
  const evidenceHitRate = returnedEvidenceIds.length > 0 ? overlap / returnedEvidenceIds.length : 0;

  let mrr = 0;
  for (let i = 0; i < returnedEvidenceIds.length; i += 1) {
    if (expectedEvidence.has(returnedEvidenceIds[i])) {
      mrr = 1 / (i + 1);
      break;
    }
  }
  let dcg = 0;
  for (let i = 0; i < returnedEvidenceIds.length; i += 1) {
    if (expectedEvidence.has(returnedEvidenceIds[i])) {
      dcg += 1 / Math.log2(i + 2);
    }
  }
  let idcg = 0;
  for (let i = 0; i < Math.min(expectedEvidence.size, returnedEvidenceIds.length); i += 1) {
    idcg += 1 / Math.log2(i + 2);
  }
  const ndcg = idcg > 0 ? dcg / idcg : (overlap > 0 ? 1 : 0);

  if (!unresolved) {
    if (!answerHasContractShape(response)) {
      buckets.push("answer_contract_format_miss");
    }
    if (clarificationExpected) {
      if (!clarificationTriggered) {
        buckets.push("reasoning_synthesis_miss");
      } else if (clarificationQualityScore < 0.99) {
        buckets.push("answer_contract_format_miss");
      }
    } else {
      if (clarificationTriggered) {
        buckets.push("reasoning_synthesis_miss");
      }
      if ((response.evidence?.length ?? 0) === 0) {
        buckets.push("retrieval_miss");
      }
      if (overlap === 0) {
        buckets.push("provenance_mismatch");
      }
      if (overlap > 0 && returnedEvidenceIds.length > 0 && !expectedEvidence.has(returnedEvidenceIds[0])) {
        buckets.push("ranking_failure");
      }
      if (row.actor_ids.length > 0) {
        const actorOverlap = (response.evidence ?? []).some((e) => e.actorId && row.actor_ids.includes(e.actorId));
        if (!actorOverlap) buckets.push("actor_attribution_miss");
      }

      const hasRelativeWindow = /\b(last|this|recent|week|month|quarter|year)\b/i.test(row.question);
      if (hasRelativeWindow) {
        const hasTimestampEvidence = (response.evidence ?? []).some((e) => Boolean(e.sourceTimestamp));
        if (!hasTimestampEvidence) buckets.push("temporal_interpretation_miss");
      }

      const metadataText = JSON.stringify(metadata);
      if (metadataText.includes("\"planWindowExpected\":true")) {
        const fullPlanHit = (response.evidence ?? []).some((e) => /plan|step\s+\d+/i.test(e.excerpt));
        if (!fullPlanHit) buckets.push("plan_window_compaction_miss");
      }

      if (metadataText.includes("\"contradictionExpected\":true")) {
        if (!response.answerContract?.finalAnswer?.contradictionCallout) {
          buckets.push("contradiction_handling_miss");
        }
      }
      if (!response.answerContract.finalAnswer?.direct && !response.answerContract.finalAnswer?.estimate && answerText.trim().length === 0) {
        buckets.push("reasoning_synthesis_miss");
      }

      const contextMode = String(response.qualitySignals?.contextMode ?? "");
      if (contextMode === "anchor_only" && (response.evidence?.length ?? 0) < 2) {
        buckets.push("context_expansion_miss");
      }
      if ((response.qualitySignals?.contextMode === "window_thread" || response.qualitySignals?.contextMode === "adaptive")
          && !(response.qualitySignals?.threadEnriched === true)) {
        buckets.push("thread_continuity_miss");
      }
    }
  }

  let score = unresolved ? 0 : (clarificationExpected ? clarificationQualityScore : 1.0);
  for (const bucket of buckets) {
    if (bucket === "retrieval_miss") score -= 0.35;
    else if (bucket === "provenance_mismatch") score -= 0.25;
    else if (bucket === "answer_contract_format_miss") score -= 0.15;
    else score -= 0.08;
  }
  if (params.latencyMs > 20000) score -= 0.1;
  score = Math.max(0, Math.min(1, score));
  const scoringBucket: "clear" | "clarify" | "unresolved_excluded" = unresolved
    ? "unresolved_excluded"
    : clarificationExpected
      ? "clarify"
      : "clear";
  const pass = unresolved
    ? false
    : clarificationExpected
      ? clarificationTriggered && clarificationQualityScore >= 0.99 && buckets.length === 0
      : score >= 0.99 && buckets.length === 0;

  return {
    pass,
    score,
    buckets,
    returnedEvidenceIds,
    recallAtK,
    mrr,
    ndcg,
    evidenceHitRate,
    estimatedCostPer1k: estimateCostPer1k(response),
    clarificationTriggered,
    clarificationQualityScore,
    scoringBucket
  };
}

function percentile95(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * 0.95) - 1));
  return sorted[idx];
}

function chooseStrategyCatalog(strategyIds: string[] | undefined): StrategyVariant[] {
  if (!strategyIds || strategyIds.length === 0) return STRATEGY_CATALOG;
  const wanted = new Set(strategyIds.map((s) => s.trim()).filter(Boolean));
  const selected = STRATEGY_CATALOG.filter((s) => wanted.has(s.strategyId));
  return selected.length > 0 ? selected : STRATEGY_CATALOG;
}

interface LearningAdjustment {
  field: "retrievalMode" | "contextMode" | "plannerMode" | "composerMode" | "refinementMode" | "maxLoops";
  from: unknown;
  to: unknown;
  reason: string;
}

function emptyFailureBreakdown(): FailureBreakdown {
  return {
    retrievalMiss: 0,
    rankingFailure: 0,
    contextExpansionMiss: 0,
    threadContinuityMiss: 0,
    actorAttributionMiss: 0,
    temporalInterpretationMiss: 0,
    reasoningSynthesisMiss: 0,
    answerFormatMiss: 0,
    contradictionHandlingMiss: 0,
    provenanceMismatch: 0,
    planWindowCompactionMiss: 0
  };
}

function parseFailureBreakdown(value: unknown): FailureBreakdown {
  const base = emptyFailureBreakdown();
  if (!value || typeof value !== "object") return base;
  const src = value as Record<string, unknown>;
  for (const key of Object.keys(base) as Array<keyof FailureBreakdown>) {
    const n = Number(src[key]);
    base[key] = Number.isFinite(n) && n > 0 ? n : 0;
  }
  return base;
}

async function loadPreviousFailureBreakdown(experimentId: string, beforePosition: number): Promise<FailureBreakdown | null> {
  const row = await pool.query<{ fb: unknown }>(
    `SELECT metrics->'failureBreakdown' AS fb
     FROM experiment_strategies
     WHERE experiment_id = $1::uuid
       AND position < $2
       AND status IN ('failed', 'completed')
     ORDER BY position DESC
     LIMIT 1`,
    [experimentId, beforePosition]
  );
  if (row.rows.length === 0) return null;
  return parseFailureBreakdown(row.rows[0].fb);
}

function applyLearningAdjustments(
  config: StrategyVariantConfig,
  failure: FailureBreakdown
): { config: StrategyVariantConfig; adjustments: LearningAdjustment[] } {
  const next: StrategyVariantConfig = { ...config };
  const adjustments: LearningAdjustment[] = [];

  const applyField = <K extends keyof StrategyVariantConfig>(field: K, target: StrategyVariantConfig[K], reason: string): void => {
    if (next[field] === target) return;
    adjustments.push({ field: field as LearningAdjustment["field"], from: next[field], to: target, reason });
    next[field] = target;
  };

  // Retrieval/provenance misses -> strengthen recall + rank quality.
  if (failure.retrievalMiss + failure.rankingFailure + failure.provenanceMismatch >= 2) {
    applyField("retrievalMode", "hybrid_rerank", "Boost retrieval recall/precision after miss+mismatch failures.");
  }

  // Context/thread/plan misses -> expand context gathering.
  if (failure.contextExpansionMiss + failure.threadContinuityMiss + failure.planWindowCompactionMiss >= 2) {
    applyField("contextMode", "adaptive", "Increase context expansion depth from anchor to adaptive windows/threads.");
  }

  // Actor/time/reasoning misses -> use stronger sequential planning.
  if (failure.actorAttributionMiss + failure.temporalInterpretationMiss + failure.reasoningSynthesisMiss >= 2) {
    applyField("plannerMode", "single_agent_sequential", "Use sequential planner to improve attribution, temporal parsing, and synthesis.");
  }

  // Contract format misses -> prefer deterministic composer; else keep minimal LLM.
  if (failure.answerFormatMiss > 0) {
    applyField("composerMode", "heuristic", "Enforce deterministic output contract formatting.");
  } else if (failure.reasoningSynthesisMiss > 0 && next.composerMode !== "minimal_llm") {
    applyField("composerMode", "minimal_llm", "Use LLM synthesis when reasoning depth is missing.");
  }

  // Contradiction/time misses benefit from adaptive refinement.
  if (failure.contradictionHandlingMiss > 0 || failure.temporalInterpretationMiss > 0) {
    applyField("refinementMode", "adaptive", "Enable adaptive refinement for conflict/time-sensitive queries.");
  }

  const currentLoops = Number(next.maxLoops ?? 2);
  if (
    failure.retrievalMiss + failure.reasoningSynthesisMiss + failure.planWindowCompactionMiss >= 2
    && Number.isFinite(currentLoops)
    && currentLoops < 3
  ) {
    adjustments.push({
      field: "maxLoops",
      from: next.maxLoops ?? null,
      to: 3,
      reason: "Allow one additional bounded loop for insufficiency recovery."
    });
    next.maxLoops = 3;
  }

  return { config: next, adjustments };
}

function topFailureBuckets(failure: FailureBreakdown, limit = 3): Array<{ name: string; count: number }> {
  const rows = [
    { name: "retrieval_miss", count: failure.retrievalMiss },
    { name: "ranking_failure", count: failure.rankingFailure },
    { name: "context_expansion_miss", count: failure.contextExpansionMiss },
    { name: "thread_continuity_miss", count: failure.threadContinuityMiss },
    { name: "actor_attribution_miss", count: failure.actorAttributionMiss },
    { name: "temporal_interpretation_miss", count: failure.temporalInterpretationMiss },
    { name: "reasoning_synthesis_miss", count: failure.reasoningSynthesisMiss },
    { name: "answer_contract_format_miss", count: failure.answerFormatMiss },
    { name: "contradiction_handling_miss", count: failure.contradictionHandlingMiss },
    { name: "provenance_mismatch", count: failure.provenanceMismatch },
    { name: "plan_window_compaction_miss", count: failure.planWindowCompactionMiss }
  ];
  return rows.filter((r) => r.count > 0).sort((a, b) => b.count - a.count).slice(0, limit);
}

function buildNextHypothesis(params: {
  strategyPass: boolean;
  failure: FailureBreakdown;
  adjustments: LearningAdjustment[];
}): string {
  if (params.strategyPass) {
    return "Candidate meets threshold and gates. Continue ranking remaining strategies with same constraints.";
  }
  const top = topFailureBuckets(params.failure, 3);
  const topText = top.length > 0
    ? top.map((x) => `${x.name}=${x.count}`).join(", ")
    : "no dominant buckets";
  if (params.adjustments.length === 0) {
    return `Top failures: ${topText}. No safe generic config shift identified; keep architecture fixed and queue research variants.`;
  }
  const adj = params.adjustments
    .map((a) => `${a.field}:${String(a.from ?? "null")}->${String(a.to ?? "null")}`)
    .join("; ");
  return `Top failures: ${topText}. Next run adjustments: ${adj}.`;
}

async function askWithTimeout(payload: V2AskRequest, principal: V2Principal, timeoutMs = 45000): Promise<V2AskResponse> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return await askV2(payload, principal);
  }
  return await Promise.race([
    askV2(payload, principal),
    new Promise<V2AskResponse>((_, reject) => {
      const timer = setTimeout(() => {
        clearTimeout(timer);
        reject(new Error(`ask timeout after ${timeoutMs}ms`));
      }, timeoutMs);
    })
  ]);
}

interface AskAttemptResult {
  response: V2AskResponse;
  latencyMs: number;
  timedOut: boolean;
  attempts: number;
  rescueApplied: boolean;
}

function timeoutFallbackResponse(error: unknown, timeoutMs: number): V2AskResponse {
  const timeoutContract = {
    decision: "insufficient" as const,
    intentSummary: "Execution timed out before grounded evidence retrieval completed.",
    requiresClarification: false,
    clarificationQuestion: null,
    assumptionsUsed: [],
    constraintChecks: [
      { name: "truth_over_task", passed: false, note: "No evidence returned due to timeout." },
      { name: "safety_privacy_over_completion", passed: true, note: "No unsafe fallback path used." },
      { name: "no_ungrounded_claims", passed: true, note: "No definitive claim emitted." }
    ],
    finalAnswer: null,
    status: "insufficient" as const
  };
  return {
    ok: true,
    traceId: randomUUID(),
    answerRunId: randomUUID(),
    decision: "hold",
    answerContract: timeoutContract,
    answer: timeoutContract,
    qualitySignals: {
      timeout: true,
      timeoutMs,
      error: error instanceof Error ? error.message : String(error)
    },
    evidence: []
  };
}

async function askWithRescue(params: {
  payload: V2AskRequest;
  principal: V2Principal;
  timeoutMs: number;
  timeoutRetryLimit: number;
  rescueOnTimeout: boolean;
}): Promise<AskAttemptResult> {
  if (!Number.isFinite(params.timeoutMs) || params.timeoutMs <= 0) {
    const startMs = Date.now();
    const response = await askV2(params.payload, params.principal);
    return {
      response,
      latencyMs: Date.now() - startMs,
      timedOut: false,
      attempts: 1,
      rescueApplied: false
    };
  }

  const attemptsMax = Math.max(1, Math.min(3, params.timeoutRetryLimit));
  let attempts = 0;
  let lastError: unknown = null;
  let rescueApplied = false;
  let finalLatency = 0;

  while (attempts < attemptsMax) {
    attempts += 1;
    const startMs = Date.now();
    try {
      const requestPayload: V2AskRequest = (() => {
        if (!(params.rescueOnTimeout && attempts >= 3)) return params.payload;
        const base: StrategyVariantConfig = params.payload.strategyConfig ?? { strategyId: "S0" };
        rescueApplied = true;
        return {
          ...params.payload,
          maxLoops: 1,
          strategyConfig: {
            ...base,
            contextMode: base.contextMode === "adaptive" ? "window_thread" : (base.contextMode ?? "window_thread"),
            refinementMode: "fixed",
            maxLoops: 1
          }
        };
      })();

      const response = await askWithTimeout(requestPayload, params.principal, params.timeoutMs);
      finalLatency = Date.now() - startMs;
      return {
        response,
        latencyMs: finalLatency,
        timedOut: false,
        attempts,
        rescueApplied
      };
    } catch (error) {
      finalLatency = Date.now() - startMs;
      lastError = error;
      if (attempts < attemptsMax) {
        await new Promise((resolve) => setTimeout(resolve, attempts * 250));
      }
    }
  }

  return {
    response: timeoutFallbackResponse(lastError, params.timeoutMs),
    latencyMs: finalLatency,
    timedOut: true,
    attempts,
    rescueApplied
  };
}

async function appendStrategyKnowledge(entry: Record<string, unknown>): Promise<void> {
  const dir = path.resolve(process.cwd(), "generated/strategy_program");
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, "strategy_knowledge.jsonl");
  await appendFile(file, `${JSON.stringify(entry)}\n`, "utf8");
}

async function resolveBaselineMetrics(experimentId: string): Promise<{ p95LatencyMs: number; costPer1k: number } | null> {
  const row = await pool.query<{ p95: string; cost: string }>(
    `SELECT
       COALESCE((metrics->>'p95LatencyMs')::float8, 0)::text AS p95,
       COALESCE((metrics->>'estimatedCostPer1kAsks')::float8, 0)::text AS cost
     FROM experiment_strategies
     WHERE experiment_id = $1::uuid
       AND strategy_id = 'S0'
       AND status = 'completed'
     ORDER BY position ASC
     LIMIT 1`,
    [experimentId]
  );
  if (row.rows.length === 0) return null;
  return {
    p95LatencyMs: Number(row.rows[0].p95 ?? 0),
    costPer1k: Number(row.rows[0].cost ?? 0)
  };
}

async function resolveBaselineEvalMetrics(experimentId: string): Promise<Record<string, number>> {
  const row = await pool.query<{ metrics: unknown }>(
    `SELECT metrics
     FROM experiment_strategies
     WHERE experiment_id = $1::uuid
       AND strategy_id = 'S0'
       AND status = 'completed'
     ORDER BY position ASC
     LIMIT 1`,
    [experimentId]
  );
  if (row.rows.length === 0) {
    return {
      pass_rate: 0,
      recall_at_k: 0,
      ndcg: 0,
      mrr: 0,
      evidence_hit_rate: 0,
      provenance_mismatch_rate: 0
    };
  }
  const m = row.rows[0].metrics as Record<string, unknown> | undefined;
  const fb = (m?.failureBreakdown ?? {}) as Record<string, unknown>;
  const totalCases = Number(m?.totalCases ?? 0);
  const provenanceMiss = Number(fb.provenanceMismatch ?? 0);
  return {
    pass_rate: Number(m?.passRate ?? 0),
    recall_at_k: Number(m?.recallAtK ?? 0),
    ndcg: Number(m?.ndcg ?? 0),
    mrr: Number(m?.mrr ?? 0),
    evidence_hit_rate: Number(m?.evidenceHitRate ?? 0),
    provenance_mismatch_rate: totalCases > 0 ? provenanceMiss / totalCases : 0
  };
}

async function updateComponentPerformanceAndStability(params: {
  experimentId: string;
  strategyVariantId: string;
  caseSet: string;
  scorecard: EvaluationScorecard;
}): Promise<void> {
  const bindings = await pool.query<{
    component_id: string;
    component_type: string;
  }>(
    `SELECT component_id::text, component_type
     FROM strategy_component_bindings
     WHERE strategy_variant_id = $1::uuid
     ORDER BY binding_order ASC`,
    [params.strategyVariantId]
  );
  if (bindings.rows.length === 0) return;

  const recallAtK = Number(params.scorecard.recallAtK ?? 0);
  const mrr = Number(params.scorecard.mrr ?? 0);
  const ndcg = Number(params.scorecard.ndcg ?? 0);
  const hitRate = Number(params.scorecard.evidenceHitRate ?? 0);
  const avgScore = Math.max(0, Math.min(1, (params.scorecard.passRate + recallAtK + mrr + ndcg + hitRate) / 5));
  const p95 = Number(params.scorecard.p95LatencyMs ?? 0);
  const cost = Number(params.scorecard.estimatedCostPer1kAsks ?? 0);
  const conf = Math.max(0, Math.min(1, params.scorecard.totalCases > 0 ? params.scorecard.passedCases / params.scorecard.totalCases : 0));

  for (const b of bindings.rows) {
    await pool.query(
      `INSERT INTO component_performance (
         experiment_id, component_id, domain, lens, difficulty_type, case_set,
         runs, pass_rate, avg_score, recall_at_k, mrr, ndcg, evidence_hit_rate,
         latency_ms_p95, cost_per_1k, confidence
       ) VALUES (
         $1::uuid, $2::uuid, '__all__', '__all__', 'mixed', $3,
         1, $4, $5, $6, $7, $8, $9, $10, $11, $12
       )
       ON CONFLICT (component_id, domain, lens, difficulty_type, case_set)
       DO UPDATE SET
         runs = component_performance.runs + 1,
         pass_rate = ((component_performance.pass_rate * component_performance.runs) + EXCLUDED.pass_rate) / (component_performance.runs + 1),
         avg_score = ((component_performance.avg_score * component_performance.runs) + EXCLUDED.avg_score) / (component_performance.runs + 1),
         recall_at_k = ((component_performance.recall_at_k * component_performance.runs) + EXCLUDED.recall_at_k) / (component_performance.runs + 1),
         mrr = ((component_performance.mrr * component_performance.runs) + EXCLUDED.mrr) / (component_performance.runs + 1),
         ndcg = ((component_performance.ndcg * component_performance.runs) + EXCLUDED.ndcg) / (component_performance.runs + 1),
         evidence_hit_rate = ((component_performance.evidence_hit_rate * component_performance.runs) + EXCLUDED.evidence_hit_rate) / (component_performance.runs + 1),
         latency_ms_p95 = ((component_performance.latency_ms_p95 * component_performance.runs) + EXCLUDED.latency_ms_p95) / (component_performance.runs + 1),
         cost_per_1k = ((component_performance.cost_per_1k * component_performance.runs) + EXCLUDED.cost_per_1k) / (component_performance.runs + 1),
         confidence = ((component_performance.confidence * component_performance.runs) + EXCLUDED.confidence) / (component_performance.runs + 1),
         updated_at = now()`,
      [
        params.experimentId,
        b.component_id,
        params.caseSet,
        params.scorecard.passRate,
        avgScore,
        recallAtK,
        mrr,
        ndcg,
        hitRate,
        p95,
        cost,
        conf
      ]
    );

    const stabilityRows = await pool.query<{ runs: string; stddev: string }>(
      `SELECT
         COUNT(*)::text AS runs,
         COALESCE(stddev_pop((r.pass)::int), 0)::text AS stddev
       FROM experiment_case_results r
       JOIN strategy_component_bindings b
         ON b.strategy_variant_id = r.strategy_variant_id
       WHERE b.component_id = $1::uuid`,
      [b.component_id]
    );
    const runs = Number(stabilityRows.rows[0]?.runs ?? 0);
    const stddev = Number(stabilityRows.rows[0]?.stddev ?? 0);
    const stabilityScore = Math.max(0, Math.min(1, 1 - stddev));
    const stabilityConfidence = Math.max(0, Math.min(1, runs / 50));
    await pool.query(
      `INSERT INTO component_stability (
         component_id, runs, pass_rate_stddev, component_stability_score, confidence, updated_at
       ) VALUES (
         $1::uuid, $2, $3, $4, $5, now()
       )
       ON CONFLICT (component_id)
       DO UPDATE SET
         runs = EXCLUDED.runs,
         pass_rate_stddev = EXCLUDED.pass_rate_stddev,
         component_stability_score = EXCLUDED.component_stability_score,
         confidence = EXCLUDED.confidence,
         updated_at = now()`,
      [b.component_id, runs, stddev, stabilityScore, stabilityConfidence]
    );
  }

  for (let i = 0; i < bindings.rows.length; i += 1) {
    for (let j = i + 1; j < bindings.rows.length; j += 1) {
      const a = bindings.rows[i].component_id;
      const b = bindings.rows[j].component_id;
      await pool.query(
        `INSERT INTO component_pair_performance (
           component_a_id, component_b_id, domain, difficulty_type, runs, joint_score, confidence
         ) VALUES (
           $1::uuid, $2::uuid, '__all__', 'mixed', 1, $3, $4
         )
         ON CONFLICT (component_a_id, component_b_id, domain, difficulty_type)
         DO UPDATE SET
           runs = component_pair_performance.runs + 1,
           joint_score = ((component_pair_performance.joint_score * component_pair_performance.runs) + EXCLUDED.joint_score) / (component_pair_performance.runs + 1),
           confidence = ((component_pair_performance.confidence * component_pair_performance.runs) + EXCLUDED.confidence) / (component_pair_performance.runs + 1),
           updated_at = now()`,
        [a, b, params.scorecard.passRate, conf]
      );
    }
  }
}

async function evaluateAndUpdateHypothesis(params: {
  experimentId: string;
  strategy: StrategyRow;
  scorecard: EvaluationScorecard;
}): Promise<HypothesisEvaluation | null> {
  const hypothesisId = params.strategy.hypothesis_id ? String(params.strategy.hypothesis_id) : "";
  if (!hypothesisId) return null;

  const hypothesisRow = await pool.query<{
    id: string;
    confidence: string;
    status: "open" | "confirmed" | "partially_confirmed" | "rejected";
  }>(
    `SELECT id::text, confidence::text, status
     FROM hypotheses
     WHERE id = $1::uuid`,
    [hypothesisId]
  );
  if (hypothesisRow.rows.length === 0) return null;

  const predictions = await pool.query<{
    metric_key: string;
    comparator: "gte" | "lte" | "delta_gte" | "delta_lte";
    target_value: string;
    weight: string;
  }>(
    `SELECT metric_key, comparator, target_value::text, weight::text
     FROM hypothesis_predictions
     WHERE hypothesis_id = $1::uuid`,
    [hypothesisId]
  );

  const baseline = await resolveBaselineEvalMetrics(params.experimentId);
  const totalCases = Math.max(1, params.scorecard.totalCases);
  const current: Record<string, number> = {
    pass_rate: params.scorecard.passRate,
    recall_at_k: Number(params.scorecard.recallAtK ?? 0),
    ndcg: Number(params.scorecard.ndcg ?? 0),
    mrr: Number(params.scorecard.mrr ?? 0),
    evidence_hit_rate: Number(params.scorecard.evidenceHitRate ?? 0),
    provenance_mismatch_rate: Number(params.scorecard.failureBreakdown.provenanceMismatch ?? 0) / totalCases
  };

  let passedWeight = 0;
  let totalWeight = 0;
  const deltas: Record<string, number> = {};
  for (const pred of predictions.rows) {
    const metric = pred.metric_key;
    const target = Number(pred.target_value ?? 0);
    const weight = Math.max(0.1, Number(pred.weight ?? 1));
    const cur = Number(current[metric] ?? 0);
    const base = Number(baseline[metric] ?? 0);
    const delta = cur - base;
    deltas[metric] = delta;
    let ok = false;
    if (pred.comparator === "gte") ok = cur >= target;
    else if (pred.comparator === "lte") ok = cur <= target;
    else if (pred.comparator === "delta_gte") ok = delta >= target;
    else if (pred.comparator === "delta_lte") ok = delta <= target;
    totalWeight += weight;
    if (ok) passedWeight += weight;
  }
  const successRatio = totalWeight > 0 ? passedWeight / totalWeight : 0;
  let decision: "confirmed" | "partially_confirmed" | "rejected" =
    successRatio >= 0.8 ? "confirmed" : successRatio >= 0.4 ? "partially_confirmed" : "rejected";
  const minRejectCases = Math.max(
    3,
    Math.min(50, Number((params.strategy.config as unknown as Record<string, unknown>)?.hypothesisMinRejectCases ?? 5))
  );
  let confidenceDelta = decision === "confirmed" ? 0.10 : decision === "partially_confirmed" ? 0.03 : -0.08;
  const insufficientForReject = decision === "rejected" && params.scorecard.totalCases < minRejectCases;
  if (insufficientForReject) {
    decision = "partially_confirmed";
    confidenceDelta = 0;
  }

  const before = Number(hypothesisRow.rows[0].confidence ?? 0.5);
  const after = Math.max(0, Math.min(1, before + confidenceDelta));
  const rationale = insufficientForReject
    ? `Insufficient evidence to reject (cases=${params.scorecard.totalCases}, minRejectCases=${minRejectCases}); hold confidence. ratio=${successRatio.toFixed(3)}.`
    : `Fixed-delta evaluation ratio=${successRatio.toFixed(3)} decision=${decision}.`;

  await pool.query(
    `INSERT INTO hypothesis_updates (
       hypothesis_id, strategy_variant_id, decision, confidence_before, confidence_after, metric_deltas, rationale
     ) VALUES (
       $1::uuid, $2::uuid, $3, $4, $5, $6::jsonb, $7
     )`,
    [hypothesisId, params.strategy.id, decision, before, after, JSON.stringify(deltas), rationale]
  );
  await pool.query(
    `UPDATE hypotheses
     SET confidence = $2,
         status = $3,
         updated_at = now()
     WHERE id = $1::uuid`,
    [hypothesisId, after, decision]
  );

  return {
    hypothesisId,
    strategyVariantId: params.strategy.variant_id,
    decision,
    confidenceBefore: before,
    confidenceAfter: after,
    deltas,
    rationale
  };
}

async function persistStructuredLesson(params: {
  experimentId: string;
  strategy: StrategyRow;
  hypothesisId?: string | null;
  failure: FailureBreakdown;
  recommendation: string;
  confidence: number;
  payload: Record<string, unknown>;
}): Promise<void> {
  const topBuckets = topFailureBuckets(params.failure, 4).map((b) => b.name);
  await pool.query(
    `INSERT INTO strategy_lessons (
       experiment_id, strategy_variant_id, hypothesis_id, lesson_type, failure_reason, causal_explanation,
       affected_domains, affected_taxonomies, recommendation, confidence, evidence_refs, payload
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, 'strategy', $4, $5, '{}'::text[], $6::text[], $7, $8, $9::jsonb, $10::jsonb
     )`,
    [
      params.experimentId,
      params.strategy.id,
      params.hypothesisId ?? null,
      `Top failure buckets: ${topBuckets.join(", ") || "none"}`,
      "Failure diagnostics and scoring buckets from experiment run.",
      topBuckets,
      params.recommendation,
      Math.max(0, Math.min(1, params.confidence)),
      JSON.stringify({ strategyVariantId: params.strategy.variant_id }),
      JSON.stringify(params.payload)
    ]
  );
}

function parseStrategyNumber(strategyId: string): number {
  const m = String(strategyId ?? "").match(/^S(\d+)$/i);
  if (!m) return -1;
  return Number(m[1]);
}

function inferGroupId(strategyId: string, configObj: Record<string, unknown> | null | undefined): number {
  const explicit = Number((configObj ?? {}).groupId);
  if (Number.isFinite(explicit) && explicit > 0) return Math.trunc(explicit);
  const n = parseStrategyNumber(strategyId);
  if (n < 0) return 1;
  if (n <= 15) return 1;
  return Math.floor((n - 16) / 10) + 2;
}

function topFailuresSummary(f: FailureBreakdown): Array<{ name: string; count: number }> {
  return [
    { name: "retrieval_miss", count: f.retrievalMiss },
    { name: "ranking_failure", count: f.rankingFailure },
    { name: "context_expansion_miss", count: f.contextExpansionMiss },
    { name: "thread_continuity_miss", count: f.threadContinuityMiss },
    { name: "actor_attribution_miss", count: f.actorAttributionMiss },
    { name: "temporal_interpretation_miss", count: f.temporalInterpretationMiss },
    { name: "reasoning_synthesis_miss", count: f.reasoningSynthesisMiss },
    { name: "answer_contract_format_miss", count: f.answerFormatMiss },
    { name: "contradiction_handling_miss", count: f.contradictionHandlingMiss },
    { name: "provenance_mismatch", count: f.provenanceMismatch },
    { name: "plan_window_compaction_miss", count: f.planWindowCompactionMiss }
  ].filter((x) => x.count > 0).sort((a, b) => b.count - a.count);
}

async function loadExperimentLessons(experimentId: string): Promise<{
  topFailures: Array<{ name: string; count: number }>;
  strategySummaries: Array<{
    strategyId: string;
    variantId: string;
    passRate: number;
    p95LatencyMs: number;
    timeoutRate: number;
    failureBreakdown: FailureBreakdown;
    status: string;
  }>;
}> {
  const summaryRows = await pool.query<{
    strategy_id: string;
    variant_id: string;
    status: string;
    pass_rate: string;
    p95_ms: string;
    timeout_rate: string;
    fb: unknown;
  }>(
    `SELECT
       strategy_id,
       variant_id,
       status,
       COALESCE((metrics->>'passRate')::float8, 0)::text AS pass_rate,
       COALESCE((metrics->>'p95LatencyMs')::float8, 0)::text AS p95_ms,
       COALESCE((metrics->>'timeoutRate')::float8, 0)::text AS timeout_rate,
       metrics->'failureBreakdown' AS fb
     FROM experiment_strategies
     WHERE experiment_id = $1::uuid
     ORDER BY position ASC`,
    [experimentId]
  );
  const strategySummaries = summaryRows.rows.map((r) => ({
    strategyId: r.strategy_id,
    variantId: r.variant_id,
    passRate: Number(r.pass_rate ?? 0),
    p95LatencyMs: Number(r.p95_ms ?? 0),
    timeoutRate: Number(r.timeout_rate ?? 0),
    failureBreakdown: parseFailureBreakdown(r.fb),
    status: r.status
  }));

  const agg = await pool.query<{ bucket: string; c: string }>(
    `SELECT bucket, COUNT(*)::text AS c
     FROM experiment_failures
     WHERE experiment_id = $1::uuid
     GROUP BY bucket
     ORDER BY COUNT(*) DESC`,
    [experimentId]
  );
  const topFailures = agg.rows.map((r) => ({ name: r.bucket, count: Number(r.c ?? 0) }));
  return { topFailures, strategySummaries };
}

function buildWebQueries(lastFailure: FailureBreakdown): string[] {
  const top = topFailuresSummary(lastFailure).slice(0, 4).map((x) => x.name);
  const base = [
    "RAG provenance mismatch mitigation strategies",
    "multi-agent retrieval evaluation failure analysis",
    "context window thread expansion retrieval quality",
    "answer attribution temporal reasoning in RAG systems"
  ];
  for (const bucket of top) {
    if (bucket === "provenance_mismatch") base.push("RAG citation provenance grounding techniques");
    if (bucket === "retrieval_miss") base.push("hybrid lexical vector retrieval tuning best practices");
    if (bucket === "plan_window_compaction_miss") base.push("long context compaction preserving structured plans");
    if (bucket === "actor_attribution_miss") base.push("conversation actor attribution in chat datasets");
    if (bucket === "temporal_interpretation_miss") base.push("relative time parsing and temporal filters in search");
  }
  return Array.from(new Set(base)).slice(0, 8);
}

function extractDdgTexts(raw: unknown): string[] {
  if (!raw || typeof raw !== "object") return [];
  const obj = raw as Record<string, unknown>;
  const out: string[] = [];
  const abs = String(obj.AbstractText ?? "").trim();
  if (abs.length > 40) out.push(abs);
  const heading = String(obj.Heading ?? "").trim();
  const related = obj.RelatedTopics;
  if (Array.isArray(related)) {
    for (const item of related) {
      if (!item || typeof item !== "object") continue;
      const rec = item as Record<string, unknown>;
      const text = String(rec.Text ?? "").trim();
      if (text.length > 40) out.push(text);
      const nested = rec.Topics;
      if (Array.isArray(nested)) {
        for (const n of nested) {
          if (!n || typeof n !== "object") continue;
          const txt = String((n as Record<string, unknown>).Text ?? "").trim();
          if (txt.length > 40) out.push(txt);
        }
      }
    }
  }
  if (out.length === 0 && heading) out.push(heading);
  return out;
}

async function fetchWebResearchSnippets(queries: string[]): Promise<string[]> {
  const enabled = String(process.env.OPENBRAIN_STRATEGY_WEB_RESEARCH_ENABLED ?? "1").trim() !== "0";
  if (!enabled) return [];
  const snippets: string[] = [];
  for (const query of queries.slice(0, 6)) {
    try {
      const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_redirect=1&no_html=1`;
      const res = await fetch(url, {
        method: "GET",
        headers: { "accept": "application/json" }
      });
      if (!res.ok) continue;
      const payload = await res.json();
      const texts = extractDdgTexts(payload);
      for (const t of texts) {
        const compact = compactText(t, 260);
        if (compact.length > 40) snippets.push(compact);
        if (snippets.length >= 30) break;
      }
      if (snippets.length >= 30) break;
    } catch {
      // Ignore per-query web failures.
    }
  }
  return Array.from(new Set(snippets)).slice(0, 20);
}

interface ResearchPlanCandidate {
  label: string;
  hypothesis: string;
  configPatch: Partial<StrategyVariantConfig>;
}

interface ResearchEnqueueResult {
  inserted: number;
  nextGroup: number | null;
  plannedCount: number;
  insertedStrategies: Array<{ strategyId: string; variantId: string; label: string }>;
}

function readResearchGroupTargetSize(): number {
  const raw = Number(process.env.OPENBRAIN_STRATEGY_RESEARCH_GROUP_SIZE ?? "10");
  if (!Number.isFinite(raw)) return 10;
  return Math.max(3, Math.min(20, Math.trunc(raw)));
}

function strategyPatchSignature(patch: Partial<StrategyVariantConfig>): string {
  const normalized = {
    retrievalMode: patch.retrievalMode ?? null,
    contextMode: patch.contextMode ?? null,
    plannerMode: patch.plannerMode ?? null,
    composerMode: patch.composerMode ?? null,
    refinementMode: patch.refinementMode ?? null,
    maxLoops: Number(patch.maxLoops ?? 0),
    timeoutMs: Number(patch.timeoutMs ?? 0),
    timeoutRetryLimit: Number(patch.timeoutRetryLimit ?? 0),
    noDataRetryLimit: Number(patch.noDataRetryLimit ?? 0),
    rescueOnTimeout: patch.rescueOnTimeout === false ? false : true
  };
  return JSON.stringify(normalized);
}

function buildResearchCodeWave(params: {
  baseConfig: StrategyVariantConfig;
  planned: ResearchPlanCandidate[];
  lastFailure: FailureBreakdown;
  targetSize: number;
}): ResearchPlanCandidate[] {
  const out: ResearchPlanCandidate[] = [];
  const seenSignatures = new Set<string>();
  const seenLabels = new Set<string>();

  const addCandidate = (candidate: ResearchPlanCandidate): void => {
    const patch = sanitizeConfigPatch(params.baseConfig, candidate.configPatch);
    const signature = strategyPatchSignature(patch);
    const label = compactText(candidate.label, 90);
    if (!label || seenSignatures.has(signature) || seenLabels.has(label.toLowerCase())) return;
    seenSignatures.add(signature);
    seenLabels.add(label.toLowerCase());
    out.push({
      label,
      hypothesis: compactText(candidate.hypothesis, 240),
      configPatch: patch
    });
  };

  for (const candidate of params.planned) addCandidate(candidate);

  const top = topFailuresSummary(params.lastFailure).slice(0, 3).map((x) => x.name).join(", ");
  const topPhrase = top || "mixed failure buckets";

  const templates: ResearchPlanCandidate[] = [
    {
      label: "Code-wave: hybrid rerank + adaptive context + sequential planner",
      hypothesis: `Address ${topPhrase} with robust retrieval precision and bounded adaptive context.`,
      configPatch: { retrievalMode: "hybrid_rerank", contextMode: "adaptive", plannerMode: "single_agent_sequential", composerMode: "minimal_llm", refinementMode: "adaptive", maxLoops: 3 }
    },
    {
      label: "Code-wave: hybrid fusion + adaptive context + minimal planner",
      hypothesis: "Reduce planner overhead while preserving retrieval breadth.",
      configPatch: { retrievalMode: "hybrid", contextMode: "adaptive", plannerMode: "single_agent_minimal", composerMode: "minimal_llm", refinementMode: "adaptive", maxLoops: 3 }
    },
    {
      label: "Code-wave: hybrid rerank + window/thread continuity",
      hypothesis: "Improve context continuity and causal references in conversational chains.",
      configPatch: { retrievalMode: "hybrid_rerank", contextMode: "window_thread", plannerMode: "single_agent_sequential", composerMode: "minimal_llm", refinementMode: "adaptive", maxLoops: 3 }
    },
    {
      label: "Code-wave: hybrid rerank + deterministic composer",
      hypothesis: "Stabilize output contract and reduce synthesis drift.",
      configPatch: { retrievalMode: "hybrid_rerank", contextMode: "adaptive", plannerMode: "single_agent_sequential", composerMode: "heuristic", refinementMode: "adaptive", maxLoops: 3 }
    },
    {
      label: "Code-wave: mesh planner + hybrid rerank",
      hypothesis: "Use lean multi-agent decomposition to improve hard diagnostic and temporal cases.",
      configPatch: { retrievalMode: "hybrid_rerank", contextMode: "adaptive", plannerMode: "mesh_lean", composerMode: "minimal_llm", refinementMode: "adaptive", maxLoops: 3 }
    },
    {
      label: "Code-wave: vector retrieval stress profile",
      hypothesis: "Test semantic-heavy recall path against noisy lexical evidence.",
      configPatch: { retrievalMode: "vector", contextMode: "adaptive", plannerMode: "single_agent_sequential", composerMode: "minimal_llm", refinementMode: "adaptive", maxLoops: 3 }
    },
    {
      label: "Code-wave: lexical retrieval stress profile",
      hypothesis: "Test lexical precision and explicit mention handling under strict context windows.",
      configPatch: { retrievalMode: "lexical", contextMode: "window", plannerMode: "single_agent_sequential", composerMode: "minimal_llm", refinementMode: "adaptive", maxLoops: 3 }
    },
    {
      label: "Code-wave: adaptive refinement with conservative loops",
      hypothesis: "Keep reliability while controlling cost and latency variance.",
      configPatch: { retrievalMode: "hybrid_rerank", contextMode: "adaptive", plannerMode: "single_agent_sequential", composerMode: "minimal_llm", refinementMode: "adaptive", maxLoops: 2, timeoutMs: 0, timeoutRetryLimit: 1 }
    },
    {
      label: "Code-wave: anchor-window strict attribution",
      hypothesis: "Increase actor attribution stability by favoring local context around anchors.",
      configPatch: { retrievalMode: "hybrid_rerank", contextMode: "window", plannerMode: "single_agent_sequential", composerMode: "heuristic", refinementMode: "fixed", maxLoops: 2 }
    },
    {
      label: "Code-wave: no-data resilience profile",
      hypothesis: "Harden recovery for missing-evidence cases while keeping generic reasoning.",
      configPatch: { retrievalMode: "hybrid_rerank", contextMode: "adaptive", plannerMode: "single_agent_sequential", composerMode: "minimal_llm", refinementMode: "adaptive", maxLoops: 3, noDataRetryLimit: 30, rescueOnTimeout: true }
    }
  ];

  for (const candidate of templates) addCandidate(candidate);

  return out.slice(0, params.targetSize);
}

function fallbackResearchPlan(lastFailure: FailureBreakdown): ResearchPlanCandidate[] {
  const top = topFailuresSummary(lastFailure);
  const emphasis = top[0]?.name ?? "general_quality";
  return [
    {
      label: "Research: robust hybrid rerank + adaptive context",
      hypothesis: `Primary failures emphasize ${emphasis}; increase retrieval precision and context depth.`,
      configPatch: { retrievalMode: "hybrid_rerank", contextMode: "adaptive", plannerMode: "single_agent_sequential", refinementMode: "adaptive", maxLoops: 3 }
    },
    {
      label: "Research: deterministic contract composer",
      hypothesis: "Stabilize final answer contract formatting while keeping retrieval strong.",
      configPatch: { composerMode: "heuristic", retrievalMode: "hybrid_rerank", contextMode: "adaptive", plannerMode: "single_agent_sequential", refinementMode: "adaptive", maxLoops: 3 }
    },
    {
      label: "Research: minimal planner + heavy retrieval",
      hypothesis: "Reduce planner overhead, maximize retrieval and reranking quality.",
      configPatch: { plannerMode: "single_agent_minimal", retrievalMode: "hybrid_rerank", contextMode: "adaptive", refinementMode: "adaptive", maxLoops: 2 }
    },
    {
      label: "Research: thread-focused context routing",
      hypothesis: "Improve continuity-sensitive cases with thread-enriched context first.",
      configPatch: { contextMode: "window_thread", retrievalMode: "hybrid_rerank", plannerMode: "single_agent_sequential", refinementMode: "adaptive", maxLoops: 3 }
    },
    {
      label: "Research: conservative loops + strict timeout resilience",
      hypothesis: "Minimize infra noise while preserving coverage for every case.",
      configPatch: { maxLoops: 2, timeoutMs: 0, timeoutRetryLimit: 1, rescueOnTimeout: true, retrievalMode: "hybrid_rerank", contextMode: "adaptive", plannerMode: "single_agent_sequential", refinementMode: "adaptive" }
    }
  ];
}

async function runResearchStrategyPlanner(params: {
  experimentId: string;
  lastFailure: FailureBreakdown;
  lessons: Awaited<ReturnType<typeof loadExperimentLessons>>;
  webSnippets: string[];
  baseConfig: StrategyVariantConfig;
}): Promise<ResearchPlanCandidate[]> {
  const fallback = fallbackResearchPlan(params.lastFailure);
  const openAiKey = String(config.openAiApiKey ?? "").trim();
  const openRouterKey = String(config.openRouterApiKey ?? "").trim();
  const hasModel = openAiKey.length > 0 || openRouterKey.length > 0;
  if (!hasModel) return fallback;

  const provider = openAiKey ? "openai" : "openrouter";
  const url = provider === "openai"
    ? `${String(config.openAiBaseUrl || "https://api.openai.com/v1").replace(/\/+$/, "")}/chat/completions`
    : "https://openrouter.ai/api/v1/chat/completions";
  const apiKey = provider === "openai" ? openAiKey : openRouterKey;
  const model = provider === "openai"
    ? String(config.metadataModel || "gpt-4o-mini").replace(/^openai\//i, "")
    : String(config.metadataModel || "openai/gpt-4o-mini");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: 800,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              "You are StrategyResearchAgent. Build a NEW strategy group for next experiment phase. " +
              "Use lessons learned from prior runs plus provided web snippets to propose generic, non-topic-specific strategy variants. " +
              "Do not use case-specific instructions. " +
              "Return JSON only with key strategies: array of 5-10 items. " +
              "Each item keys: label, hypothesis, configPatch. " +
              "Allowed configPatch keys: retrievalMode,contextMode,plannerMode,composerMode,refinementMode,maxLoops,timeoutMs,timeoutRetryLimit,rescueOnTimeout,noDataRetryLimit."
          },
          {
            role: "user",
            content: JSON.stringify({
              experimentId: params.experimentId,
              lastFailure: params.lastFailure,
              topFailures: params.lessons.topFailures.slice(0, 10),
              previousStrategies: params.lessons.strategySummaries.slice(-25),
              webSnippets: params.webSnippets,
              baseConfig: params.baseConfig
            })
          }
        ]
      })
    });
    if (!response.ok) return fallback;
    const payload = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const raw = String(payload?.choices?.[0]?.message?.content ?? "").trim();
    const parsed = parseJsonObjectLike(raw);
    if (!parsed) return fallback;
    const strategiesRaw = Array.isArray(parsed.strategies) ? parsed.strategies : [];
    const planned: ResearchPlanCandidate[] = [];
    for (const item of strategiesRaw.slice(0, 10)) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const obj = item as Record<string, unknown>;
      const label = compactText(String(obj.label ?? "").trim(), 90);
      const hypothesis = compactText(String(obj.hypothesis ?? "").trim(), 240);
      if (!label || !hypothesis) continue;
      const patch = sanitizeConfigPatch(params.baseConfig, obj.configPatch);
      planned.push({
        label,
        hypothesis,
        configPatch: patch
      });
    }
    return planned.length > 0 ? planned : fallback;
  } catch {
    return fallback;
  } finally {
    clearTimeout(timeout);
  }
}

async function enqueueResearchCandidates(experimentId: string, lastFailure: FailureBreakdown): Promise<ResearchEnqueueResult> {
  const existing = await pool.query<{ variant_id: string; strategy_id: string; config: Record<string, unknown> }>(
    `SELECT variant_id, strategy_id, config
     FROM experiment_strategies
     WHERE experiment_id = $1::uuid`,
    [experimentId]
  );
  const existingVariantIds = new Set(existing.rows.map((r) => r.variant_id));
  const maxGroup = existing.rows.reduce((acc, row) => Math.max(acc, inferGroupId(row.strategy_id, row.config)), 1);
  const nextGroup = maxGroup + 1;
  let maxStrategyNum = existing.rows.reduce((acc, row) => Math.max(acc, parseStrategyNumber(row.strategy_id)), 15);
  if (maxStrategyNum < 15) maxStrategyNum = 15;

  const positionRow = await pool.query<{ p: string }>(
    `SELECT COALESCE(MAX(position), -1)::text AS p
     FROM experiment_strategies
     WHERE experiment_id = $1::uuid`,
    [experimentId]
  );
  let position = Number(positionRow.rows[0]?.p ?? -1);

  const lessons = await loadExperimentLessons(experimentId);
  const webQueries = buildWebQueries(lastFailure);
  const webSnippets = await fetchWebResearchSnippets(webQueries);
  const baseConfig: StrategyVariantConfig = {
    strategyId: "S0",
    retrievalMode: "hybrid_rerank",
    contextMode: "adaptive",
    plannerMode: "single_agent_sequential",
    composerMode: "minimal_llm",
    refinementMode: "adaptive",
    maxLoops: 3,
    timeoutMs: 0,
    timeoutRetryLimit: 1,
    rescueOnTimeout: true,
    noDataRetryLimit: 20
  };
  const planned = await runResearchStrategyPlanner({
    experimentId,
    lastFailure,
    lessons,
    webSnippets,
    baseConfig
  });
  const targetSize = readResearchGroupTargetSize();
  const codeWave = buildResearchCodeWave({
    baseConfig,
    planned,
    lastFailure,
    targetSize
  });

  let inserted = 0;
  const insertedStrategies: Array<{ strategyId: string; variantId: string; label: string }> = [];
  for (let idx = 0; idx < codeWave.length; idx += 1) {
    const candidate = codeWave[idx];
    maxStrategyNum += 1;
    const strategyId = `S${maxStrategyNum}`;
    const variantId = `${strategyId}.v1`;
    if (existingVariantIds.has(variantId)) continue;
    position += 1;
    const role = normalizeExperimentRole(idx, codeWave.length);
    const mergedConfig: StrategyVariantConfig = {
      ...baseConfig,
      ...candidate.configPatch,
      strategyId,
      groupId: nextGroup,
      generatedBy: "research_agent",
      researchHypothesis: candidate.hypothesis,
      researchWebSnippetCount: webSnippets.length,
      experimentRole: role
    };
    await insertQueuedStrategyVariant({
      experimentId,
      strategyId,
      variantId,
      label: candidate.label,
      position,
      config: mergedConfig,
      role,
      lineageReason: "research_group_generation",
      modifiedComponents: inferModifiedComponentsFromPatch(candidate.configPatch),
      notes: "research_strategy_binding"
    });
    inserted += 1;
    insertedStrategies.push({ strategyId, variantId, label: candidate.label });
  }

  await appendStrategyKnowledge({
    createdAt: nowIso(),
    experimentId,
    kind: "research_group_generation",
    groupId: nextGroup,
    inserted,
    webQueries,
    webSnippetCount: webSnippets.length,
    topFailures: lessons.topFailures.slice(0, 10),
    plannedCount: codeWave.length,
    plannerCandidateCount: planned.length,
    researchGroupTargetSize: targetSize,
    insertedStrategies
  });

  return {
    inserted,
    nextGroup: inserted > 0 ? nextGroup : null,
    plannedCount: codeWave.length,
    insertedStrategies
  };
}

function parseVariantRevision(variantId: string): { base: string; revision: number } {
  const m = String(variantId ?? "").match(/^(.*)\.v(\d+)$/i);
  if (!m) return { base: String(variantId ?? ""), revision: 1 };
  return { base: m[1], revision: Math.max(1, Number(m[2] ?? 1)) };
}

async function enqueueRescueVariant(params: {
  experimentId: string;
  selected: StrategyRow;
  baseConfig: StrategyVariantConfig;
  failure: FailureBreakdown;
}): Promise<string | null> {
  const parsed = parseVariantRevision(params.selected.variant_id);
  if (parsed.revision >= 3) return null;

  const learning = applyLearningAdjustments(params.baseConfig, params.failure);
  if (learning.adjustments.length === 0) return null;

  const nextRevision = parsed.revision + 1;
  const nextVariantId = `${parsed.base}.v${nextRevision}`;
  const existing = await pool.query<{ c: string }>(
    `SELECT COUNT(*)::text AS c
     FROM experiment_strategies
     WHERE experiment_id = $1::uuid
       AND variant_id = $2::text`,
    [params.experimentId, nextVariantId]
  );
  if (Number(existing.rows[0]?.c ?? 0) > 0) return null;

  await pool.query(
    `UPDATE experiment_strategies
        SET position = position + 1
      WHERE experiment_id = $1::uuid
        AND position > $2`,
    [params.experimentId, params.selected.position]
  );

  const rescueConfig: StrategyVariantConfig = {
    ...learning.config,
    rescueFromVariantId: params.selected.variant_id,
    rescueAttempt: nextRevision - 1,
    rescueAdjustments: learning.adjustments.map((a) => ({ ...a })),
    parentStrategyVariantId: params.selected.id,
    parentHypothesisId: params.selected.hypothesis_id ?? undefined,
    lineageReason: "rescue_variant_retry",
    modifiedComponents: inferModifiedComponentsFromPatch(Object.fromEntries(
      learning.adjustments.map((a) => [a.field, a.to])
    ) as Partial<StrategyVariantConfig>)
  };
  await insertQueuedStrategyVariant({
    experimentId: params.experimentId,
    strategyId: params.selected.strategy_id,
    variantId: nextVariantId,
    label: `${params.selected.label} (rescue v${nextRevision})`,
    position: params.selected.position + 1,
    config: rescueConfig,
    role: params.selected.experiment_role ?? "treatment",
    reuseHypothesisId: params.selected.hypothesis_id ?? null,
    parentStrategyVariantId: params.selected.id,
    parentHypothesisId: params.selected.hypothesis_id ?? null,
    modifiedComponents: rescueConfig.modifiedComponents ?? [],
    lineageReason: "rescue_variant_retry",
    notes: "rescue_retry_binding"
  });
  return nextVariantId;
}

type StrategyReviewMode = "retry_same" | "move_next";

interface StrategyReviewDecision {
  mode: StrategyReviewMode;
  rationale: string;
  configPatch: Partial<StrategyVariantConfig>;
  systemActions: string[];
}

interface NoDataDiagnostics {
  hasMissingEvidenceCases: boolean;
  allCasesMissingEvidence: boolean;
  missingEvidenceCaseCount: number;
  totalRan: number;
  retrievalMiss: number;
  timeoutCount: number;
  timeoutRate: number;
  expectedEvidenceCount: number;
  expectedEvidencePublished: number;
  namespacePublished: number;
  staleCaseCount: number;
}

let lastAnalyzeTablesAt = 0;

function parseJsonObjectLike(input: string): Record<string, unknown> | null {
  const raw = String(input ?? "").trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // ignore parse errors
  }
  return null;
}

function fallbackStrategyReview(params: {
  strategyPass: boolean;
  scorecard: EvaluationScorecard;
  config: StrategyVariantConfig;
  timeoutRate: number;
  noData?: NoDataDiagnostics;
}): StrategyReviewDecision {
  if (params.strategyPass) {
    return {
      mode: "move_next",
      rationale: "Strategy passed; continue to next strategy.",
      configPatch: {},
      systemActions: []
    };
  }

  const patch: Partial<StrategyVariantConfig> = {};
  const notes: string[] = [];

  if (params.noData?.hasMissingEvidenceCases) {
    patch.retrievalMode = "hybrid_rerank";
    patch.contextMode = "adaptive";
    patch.plannerMode = "single_agent_sequential";
    patch.refinementMode = "adaptive";
    patch.maxLoops = 3;
    patch.timeoutMs = 0;
    patch.timeoutRetryLimit = 1;
    patch.rescueOnTimeout = true;
    return {
      mode: "retry_same",
      rationale: "Run-health issue detected: one or more executed cases returned empty evidence. Diagnose and retry same strategy with robust retrieval/context defaults.",
      configPatch: patch,
      systemActions: ["analyze_tables"]
    };
  }

  if (params.timeoutRate > 0 || params.scorecard.p95LatencyMs >= 300000) {
    if ((params.config.timeoutMs ?? 0) !== 0) patch.timeoutMs = 0;
    patch.timeoutRetryLimit = 1;
    patch.rescueOnTimeout = true;
    notes.push("Timeout/latency pressure detected; disable hard timeout and keep single retry.");
  }

  if (params.scorecard.p95LatencyMs >= 180000) {
    if (params.config.contextMode === "adaptive") patch.contextMode = "window_thread";
    const loops = Number(params.config.maxLoops ?? 2);
    patch.maxLoops = Math.max(1, Math.min(3, loops - 1));
    notes.push("High latency detected; reduce context expansion and loop depth.");
  }

  if (params.scorecard.failureBreakdown.retrievalMiss > 0 || params.scorecard.failureBreakdown.provenanceMismatch > 0) {
    patch.retrievalMode = "hybrid_rerank";
    notes.push("Retrieval/provenance misses detected; force hybrid rerank retrieval.");
  }

  if (notes.length === 0) {
    return {
      mode: "move_next",
      rationale: "No safe generic strategy patch identified from current metrics.",
      configPatch: {},
      systemActions: []
    };
  }

  return {
    mode: "retry_same",
    rationale: notes.join(" "),
    configPatch: patch,
    systemActions: params.scorecard.p95LatencyMs >= 300000 ? ["analyze_tables"] : []
  };
}

function normalizeReviewMode(value: unknown): StrategyReviewMode {
  const raw = String(value ?? "").trim().toLowerCase();
  return raw === "retry_same" ? "retry_same" : "move_next";
}

function sanitizeConfigPatch(base: StrategyVariantConfig, patchInput: unknown): Partial<StrategyVariantConfig> {
  if (!patchInput || typeof patchInput !== "object" || Array.isArray(patchInput)) return {};
  const patch = patchInput as Record<string, unknown>;
  const out: Partial<StrategyVariantConfig> = {};

  const retrievalMode = String(patch.retrievalMode ?? "").trim();
  if (["baseline", "vector", "lexical", "hybrid", "hybrid_rerank"].includes(retrievalMode)) {
    out.retrievalMode = retrievalMode as StrategyVariantConfig["retrievalMode"];
  }
  const contextMode = String(patch.contextMode ?? "").trim();
  if (["anchor_only", "window", "window_thread", "adaptive"].includes(contextMode)) {
    out.contextMode = contextMode as StrategyVariantConfig["contextMode"];
  }
  const plannerMode = String(patch.plannerMode ?? "").trim();
  if (["baseline", "single_agent_minimal", "single_agent_sequential", "mesh_lean"].includes(plannerMode)) {
    out.plannerMode = plannerMode as StrategyVariantConfig["plannerMode"];
  }
  const composerMode = String(patch.composerMode ?? "").trim();
  if (["heuristic", "minimal_llm"].includes(composerMode)) {
    out.composerMode = composerMode as StrategyVariantConfig["composerMode"];
  }
  const refinementMode = String(patch.refinementMode ?? "").trim();
  if (["fixed", "adaptive"].includes(refinementMode)) {
    out.refinementMode = refinementMode as StrategyVariantConfig["refinementMode"];
  }
  const maxLoops = Number(patch.maxLoops);
  if (Number.isFinite(maxLoops)) out.maxLoops = Math.max(1, Math.min(3, Math.trunc(maxLoops)));

  const timeoutMs = Number(patch.timeoutMs);
  if (Number.isFinite(timeoutMs)) out.timeoutMs = Math.max(0, Math.min(300000, Math.trunc(timeoutMs)));
  const timeoutRetryLimit = Number(patch.timeoutRetryLimit);
  if (Number.isFinite(timeoutRetryLimit)) out.timeoutRetryLimit = Math.max(1, Math.min(3, Math.trunc(timeoutRetryLimit)));
  const noDataRetryLimit = Number(patch.noDataRetryLimit);
  if (Number.isFinite(noDataRetryLimit)) out.noDataRetryLimit = Math.max(1, Math.min(50, Math.trunc(noDataRetryLimit)));

  const rescueOnTimeout = patch.rescueOnTimeout;
  if (typeof rescueOnTimeout === "boolean") out.rescueOnTimeout = rescueOnTimeout;

  // Never allow reviewer to mutate strategy identity.
  out.strategyId = base.strategyId;
  return out;
}

function sanitizeSystemActions(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const allowed = new Set(["analyze_tables"]);
  return value
    .map((item) => String(item ?? "").trim().toLowerCase())
    .filter((item) => allowed.has(item))
    .slice(0, 3);
}

async function collectNoDataDiagnostics(params: {
  experiment: ExperimentRow;
  casesRan: ExperimentCaseRow[];
  totalRan: number;
  retrievalMiss: number;
  timeoutCount: number;
  timeoutRate: number;
}): Promise<NoDataDiagnostics> {
  const expectedEvidenceIds = Array.from(
    new Set(
      params.casesRan
        .flatMap((row) => row.evidence_ids)
        .filter((id) => /^[0-9a-fA-F-]{36}$/.test(String(id)))
    )
  );
  const staleCaseCount = params.casesRan.filter((row) => {
    const meta = JSON.stringify(row.metadata ?? {});
    return /"stale"\s*:\s*true/i.test(meta) || /"needsReseed"\s*:\s*true/i.test(meta);
  }).length;

  const nsPublishedRow = await pool.query<{ c: string }>(
    `SELECT COUNT(*)::text AS c
     FROM canonical_messages
     WHERE chat_namespace = $1::text
       AND artifact_state = 'published'`,
    [params.experiment.chat_namespace]
  );
  const namespacePublished = Number(nsPublishedRow.rows[0]?.c ?? 0);

  let expectedEvidencePublished = 0;
  if (expectedEvidenceIds.length > 0) {
    const expectedRow = await pool.query<{ c: string }>(
      `SELECT COUNT(*)::text AS c
       FROM canonical_messages
       WHERE id = ANY($1::uuid[])
         AND artifact_state = 'published'`,
      [expectedEvidenceIds]
    );
    expectedEvidencePublished = Number(expectedRow.rows[0]?.c ?? 0);
  }

  return {
    hasMissingEvidenceCases: params.retrievalMiss > 0,
    allCasesMissingEvidence: params.totalRan > 0 && params.retrievalMiss >= params.totalRan,
    missingEvidenceCaseCount: Math.max(0, params.retrievalMiss),
    totalRan: params.totalRan,
    retrievalMiss: params.retrievalMiss,
    timeoutCount: params.timeoutCount,
    timeoutRate: params.timeoutRate,
    expectedEvidenceCount: expectedEvidenceIds.length,
    expectedEvidencePublished,
    namespacePublished,
    staleCaseCount
  };
}

function buildNoDataRootFixPatch(configIn: StrategyVariantConfig): Partial<StrategyVariantConfig> {
  const patch: Partial<StrategyVariantConfig> = {
    retrievalMode: "hybrid_rerank",
    contextMode: "adaptive",
    plannerMode: "single_agent_sequential",
    composerMode: configIn.composerMode ?? "minimal_llm",
    refinementMode: "adaptive",
    maxLoops: 3,
    timeoutMs: 0,
    timeoutRetryLimit: 1,
    rescueOnTimeout: true
  };
  return patch;
}

async function runStrategyReviewAgent(params: {
  experiment: ExperimentRow;
  selected: StrategyRow;
  strategyPass: boolean;
  scorecard: EvaluationScorecard;
  timeoutRate: number;
  baseConfig: StrategyVariantConfig;
  noData?: NoDataDiagnostics;
}): Promise<StrategyReviewDecision> {
  const fallback = fallbackStrategyReview({
    strategyPass: params.strategyPass,
    scorecard: params.scorecard,
    config: params.baseConfig,
    timeoutRate: params.timeoutRate,
    noData: params.noData
  });
  const reviewEnabled = String(process.env.OPENBRAIN_STRATEGY_REVIEW_ENABLED ?? "1").trim() !== "0";
  if (!reviewEnabled) return fallback;

  const openAiKey = String(config.openAiApiKey ?? "").trim();
  const openRouterKey = String(config.openRouterApiKey ?? "").trim();
  const hasModel = openAiKey.length > 0 || openRouterKey.length > 0;
  if (!hasModel) return fallback;

  const provider = openAiKey ? "openai" : "openrouter";
  const url = provider === "openai"
    ? `${String(config.openAiBaseUrl || "https://api.openai.com/v1").replace(/\/+$/, "")}/chat/completions`
    : "https://openrouter.ai/api/v1/chat/completions";
  const apiKey = provider === "openai" ? openAiKey : openRouterKey;
  const model = provider === "openai"
    ? String(config.metadataModel || "gpt-4o-mini").replace(/^openai\//i, "")
    : String(config.metadataModel || "openai/gpt-4o-mini");

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    Math.max(8000, Math.min(30000, Number(config.requestTimeoutMs ?? 15000)))
  );
  try {
    const response = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: 260,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              "You are StrategyReviewAgent for OpenBrain experiment orchestration. " +
              "First priority: verify run health. If strategy returned no evidence for one or more executed test cases, investigate root-cause signals and force retry_same with generic fixes. " +
              "Evaluate one completed strategy run and decide if we should retry same strategy with generic config improvements or move to next strategy. " +
              "Do not use case-specific topic logic. " +
              "Return JSON only with keys: mode(retry_same|move_next), rationale(string), configPatch(object), systemActions(string[]). " +
              "Allowed systemActions: analyze_tables. Keep actions minimal and safe."
          },
          {
            role: "user",
            content: JSON.stringify({
              experimentId: params.experiment.id,
              strategyId: params.selected.strategy_id,
              variantId: params.selected.variant_id,
              strategyPass: params.strategyPass,
              timeoutRate: params.timeoutRate,
              noDataDiagnostics: params.noData ?? null,
              scorecard: params.scorecard,
              currentConfig: params.baseConfig
            })
          }
        ]
      })
    });
    if (!response.ok) return fallback;
    const payload = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const raw = String(payload?.choices?.[0]?.message?.content ?? "").trim();
    const parsed = parseJsonObjectLike(raw);
    if (!parsed) return fallback;

    const mode = normalizeReviewMode(parsed.mode);
    const configPatch = sanitizeConfigPatch(params.baseConfig, parsed.configPatch);
    const systemActions = sanitizeSystemActions(parsed.systemActions);
    const rationale = String(parsed.rationale ?? "").trim() || fallback.rationale;
    if (mode === "retry_same" && Object.keys(configPatch).length <= 1 && systemActions.length === 0) {
      return fallback;
    }
    return { mode, rationale, configPatch, systemActions };
  } catch {
    return fallback;
  } finally {
    clearTimeout(timeout);
  }
}

async function applySystemActions(actions: string[]): Promise<string[]> {
  const applied: string[] = [];
  for (const action of actions) {
    if (action === "analyze_tables") {
      const now = Date.now();
      if (now - lastAnalyzeTablesAt < 30 * 60 * 1000) continue;
      await pool.query("ANALYZE memory_items");
      await pool.query("ANALYZE canonical_messages");
      lastAnalyzeTablesAt = now;
      applied.push(action);
    }
  }
  return applied;
}

async function enqueueAgentRetryVariant(params: {
  experimentId: string;
  selected: StrategyRow;
  baseConfig: StrategyVariantConfig;
  configPatch: Partial<StrategyVariantConfig>;
  rationale: string;
}): Promise<string | null> {
  const parsed = parseVariantRevision(params.selected.variant_id);
  if (parsed.revision >= 6) return null;
  const mergedConfig: StrategyVariantConfig = {
    ...params.baseConfig,
    ...params.configPatch,
    strategyId: params.baseConfig.strategyId
  };
  const nextRevision = parsed.revision + 1;
  const nextVariantId = `${parsed.base}.v${nextRevision}`;
  const existing = await pool.query<{ c: string }>(
    `SELECT COUNT(*)::text AS c
     FROM experiment_strategies
     WHERE experiment_id = $1::uuid
       AND variant_id = $2::text`,
    [params.experimentId, nextVariantId]
  );
  if (Number(existing.rows[0]?.c ?? 0) > 0) return null;

  await pool.query(
    `UPDATE experiment_strategies
        SET position = position + 1
      WHERE experiment_id = $1::uuid
        AND position > $2`,
    [params.experimentId, params.selected.position]
  );

  const retryPatchComponents = inferModifiedComponentsFromPatch(params.configPatch);
  await insertQueuedStrategyVariant({
    experimentId: params.experimentId,
    strategyId: params.selected.strategy_id,
    variantId: nextVariantId,
    label: `${params.selected.label} (agent retry v${nextRevision})`,
    position: params.selected.position + 1,
    config: {
      ...mergedConfig,
      agentRetryFromVariantId: params.selected.variant_id,
      agentRetryReason: params.rationale,
      parentStrategyVariantId: params.selected.id,
      parentHypothesisId: params.selected.hypothesis_id ?? undefined,
      modifiedComponents: retryPatchComponents,
      lineageReason: "agent_retry_variant"
    },
    role: params.selected.experiment_role ?? "treatment",
    reuseHypothesisId: params.selected.hypothesis_id ?? null,
    parentStrategyVariantId: params.selected.id,
    parentHypothesisId: params.selected.hypothesis_id ?? null,
    modifiedComponents: retryPatchComponents,
    lineageReason: "agent_retry_variant",
    notes: "agent_retry_binding"
  });
  return nextVariantId;
}

export async function startExperiment(input: ExperimentStartInput): Promise<Record<string, unknown>> {
  const name = String(input.name ?? "OpenBrain Intent + Ambiguity Program v1.4").trim() || "OpenBrain Intent + Ambiguity Program v1.4";
  const chatNamespace = String(input.chatNamespace ?? "personal.main").trim() || "personal.main";
  const targetPassRate = clamp01(Number(input.targetPassRate ?? 0.99), 0.99);
  const criticalTargetPassRate = clamp01(Number(input.criticalTargetPassRate ?? 0.99), 0.99);
  const perDomainFloor = clamp01(Number(input.perDomainFloor ?? 0.97), 0.97);
  const latencyGateMultiplier = Number.isFinite(Number(input.latencyGateMultiplier))
    ? Math.max(1, Math.min(3, Number(input.latencyGateMultiplier)))
    : 1.25;
  const costGateMultiplier = Number.isFinite(Number(input.costGateMultiplier))
    ? Math.max(1, Math.min(3, Number(input.costGateMultiplier)))
    : 1.25;
  const datasetVersion = String(input.datasetVersion ?? `${nowIso()}::realdb`).trim();
  const strategyList = chooseStrategyCatalog(input.strategyIds);
  const maxCasesPerPair = Number.isFinite(Number(input.maxCasesPerPair))
    ? Math.max(1, Math.min(4, Number(input.maxCasesPerPair)))
    : 2;
  const experimentId = randomUUID();
  const taxonomyVersion = await getPublishedTaxonomyVersion(input.taxonomyVersionId ?? null);

  await pool.query(
    `INSERT INTO experiment_runs (
       id, name, chat_namespace, status, target_pass_rate, critical_target_pass_rate, per_domain_floor,
       latency_gate_multiplier, cost_gate_multiplier, dataset_version, taxonomy_version_id, config
     ) VALUES (
       $1::uuid, $2, $3, 'queued', $4, $5, $6, $7, $8, $9, $10::uuid, $11::jsonb
     )`,
    [
      experimentId,
      name,
      chatNamespace,
      targetPassRate,
      criticalTargetPassRate,
      perDomainFloor,
      latencyGateMultiplier,
      costGateMultiplier,
      datasetVersion,
      taxonomyVersion.id,
      JSON.stringify({
        realDataOnly: true,
        naturalDateRanges: true,
        fullPlanCompaction: true,
        maxCasesPerPair,
        taxonomyVersionKey: taxonomyVersion.versionKey
      })
    ]
  );

  for (let i = 0; i < strategyList.length; i += 1) {
    const s = strategyList[i];
    const role = normalizeExperimentRole(i, strategyList.length);
    const configWithMeta: StrategyVariantConfig = {
      ...s.config,
      experimentRole: role
    };
    await insertQueuedStrategyVariant({
      experimentId,
      strategyId: s.strategyId,
      variantId: `${s.strategyId}.v1`,
      label: s.label,
      position: i,
      config: configWithMeta,
      role,
      notes: "bootstrap_strategy_binding"
    });
  }

  const supportRows = await ensureTaxonomySupportRows({
    taxonomyVersionId: taxonomyVersion.id,
    chatNamespace
  });
  const seeded = await seedExperimentCases({
    experimentId,
    chatNamespace,
    maxCasesPerPair,
    taxonomyVersionId: taxonomyVersion.id
  });
  await pool.query(
    `UPDATE experiment_runs
        SET benchmark_generated_at = now(),
            benchmark_support_scanned_at = $2::timestamptz,
            benchmark_stale = false,
            updated_at = now()
      WHERE id = $1::uuid`,
    [experimentId, taxonomyVersion.scanCompletedAt ?? null]
  );

  return {
    ok: true,
    experimentId,
    chatNamespace,
    datasetVersion,
    taxonomyVersionId: taxonomyVersion.id,
    taxonomyVersionKey: taxonomyVersion.versionKey,
    supportedPairs: supportRows.filter((row) => row.supportStatus === "supported").length,
    strategies: strategyList.length,
    casesInserted: seeded.inserted,
    staleCasesMarked: seeded.staleMarked
  };
}

export async function lockExperimentBenchmark(params: {
  experimentId: string;
  lockVersion?: string;
}): Promise<Record<string, unknown>> {
  const experiment = await readExperiment(params.experimentId);
  const freshness = await experimentBenchmarkFreshness({ experimentId: params.experimentId });
  if (freshness.benchmarkStale) {
    throw new Error(`Benchmark is stale: ${freshness.reasons.join(", ")}`);
  }
  const lockVersion =
    String(params.lockVersion ?? "").trim()
    || `v${new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14)}_locked`;

  await pool.query(
    `UPDATE experiment_cases
        SET benchmark_lock_version = $2::text,
            eligible_for_scoring = CASE
              WHEN COALESCE((metadata->'admissionDecision'->>'admitted')::boolean, false) = true
                AND ambiguity_class IN ('clear', 'clarify_required')
                AND owner_validation_state IN ('approved', 'not_required')
              THEN true
              ELSE false
            END,
            updated_at = now()
      WHERE experiment_id = $1::uuid
        AND is_stale = false`,
    [experiment.id, lockVersion]
  );

  const caseRows = await pool.query<{
    id: string;
    ambiguity_class: string;
    owner_validation_state: string;
    eligible_for_scoring: boolean;
    case_set: string;
    case_key: string;
    updated_at: string;
  }>(
    `SELECT
       id::text,
       ambiguity_class,
       owner_validation_state,
       eligible_for_scoring,
       case_set,
       case_key,
       updated_at::text
     FROM experiment_cases
     WHERE experiment_id = $1::uuid
       AND benchmark_lock_version = $2::text
       AND is_stale = false
     ORDER BY id ASC`,
    [experiment.id, lockVersion]
  );

  const counts = caseRows.rows.reduce(
    (acc, row) => {
      acc.total += 1;
      if (row.ambiguity_class === "clear" && row.eligible_for_scoring) acc.clear += 1;
      if (row.ambiguity_class === "clarify_required" && row.eligible_for_scoring) acc.clarify += 1;
      if (row.ambiguity_class === "unresolved" || !row.eligible_for_scoring) acc.unresolved += 1;
      return acc;
    },
    { total: 0, clear: 0, clarify: 0, unresolved: 0 }
  );
  const checksum = createHash("sha256")
    .update(JSON.stringify(caseRows.rows))
    .digest("hex");

  await pool.query(
    `INSERT INTO benchmark_lock_versions (
       experiment_id, lock_version, included_clear, included_clarify, unresolved, total_included, checksum, metadata
     ) VALUES (
       $1::uuid, $2::text, $3, $4, $5, $6, $7, $8::jsonb
     )
     ON CONFLICT (experiment_id, lock_version)
     DO UPDATE SET
       included_clear = EXCLUDED.included_clear,
       included_clarify = EXCLUDED.included_clarify,
       unresolved = EXCLUDED.unresolved,
       total_included = EXCLUDED.total_included,
       checksum = EXCLUDED.checksum,
       metadata = EXCLUDED.metadata`,
    [
      experiment.id,
      lockVersion,
      counts.clear,
      counts.clarify,
      counts.unresolved,
      counts.total,
      checksum,
      JSON.stringify({
        targetClearPass: 0.99,
        targetClarifyPass: 0.99,
        unresolvedDebtMax: 0.01
      })
    ]
  );

  await pool.query(
    `UPDATE experiment_runs
        SET active_benchmark_lock_version = $2::text,
            autonomous_mode = true,
            human_input_allowed = false,
            updated_at = now()
      WHERE id = $1::uuid`,
    [experiment.id, lockVersion]
  );

  const unresolvedRatio = counts.total > 0 ? counts.unresolved / counts.total : 0;
  return {
    ok: true,
    experimentId: experiment.id,
    lockVersion,
    counts,
    unresolvedRatio,
    checksum
  };
}

export async function getExperimentBenchmarkLock(params: {
  experimentId: string;
}): Promise<Record<string, unknown>> {
  const experiment = await readExperiment(params.experimentId);
  const lockVersion = String(experiment.active_benchmark_lock_version ?? "").trim();
  if (!lockVersion) {
    return {
      ok: true,
      experimentId: experiment.id,
      activeLockVersion: null,
      lock: null
    };
  }
  const lock = await pool.query<{
    lock_version: string;
    included_clear: string;
    included_clarify: string;
    unresolved: string;
    total_included: string;
    checksum: string;
    created_at: string;
  }>(
    `SELECT
       lock_version,
       included_clear::text,
       included_clarify::text,
       unresolved::text,
       total_included::text,
       checksum,
       created_at::text
     FROM benchmark_lock_versions
     WHERE experiment_id = $1::uuid
       AND lock_version = $2::text
     LIMIT 1`,
    [experiment.id, lockVersion]
  );
  const row = lock.rows[0] ?? null;
  return {
    ok: true,
    experimentId: experiment.id,
    activeLockVersion: lockVersion,
    lock: row
      ? {
          lockVersion: row.lock_version,
          includedClear: Number(row.included_clear ?? 0),
          includedClarify: Number(row.included_clarify ?? 0),
          unresolved: Number(row.unresolved ?? 0),
          totalIncluded: Number(row.total_included ?? 0),
          checksum: row.checksum,
          createdAt: row.created_at
        }
      : null
  };
}

export async function getExperimentBenchmarkDebt(params: {
  experimentId: string;
}): Promise<Record<string, unknown>> {
  const experiment = await readExperiment(params.experimentId);
  const lockVersion = String(experiment.active_benchmark_lock_version ?? "").trim();
  if (!lockVersion) {
    throw new Error("No active benchmark lock version.");
  }
  const counts = await pool.query<{
    total: string;
    unresolved: string;
    clear: string;
    clarify: string;
  }>(
    `SELECT
       COUNT(*)::text AS total,
       COUNT(*) FILTER (WHERE ambiguity_class = 'unresolved' OR eligible_for_scoring = false)::text AS unresolved,
       COUNT(*) FILTER (WHERE ambiguity_class = 'clear' AND eligible_for_scoring = true)::text AS clear,
       COUNT(*) FILTER (WHERE ambiguity_class = 'clarify_required' AND eligible_for_scoring = true)::text AS clarify
     FROM experiment_cases
     WHERE experiment_id = $1::uuid
       AND benchmark_lock_version = $2::text
       AND is_stale = false`,
    [experiment.id, lockVersion]
  );
  const total = Number(counts.rows[0]?.total ?? 0);
  const unresolved = Number(counts.rows[0]?.unresolved ?? 0);
  const clear = Number(counts.rows[0]?.clear ?? 0);
  const clarify = Number(counts.rows[0]?.clarify ?? 0);
  const unresolvedRatio = total > 0 ? unresolved / total : 0;
  return {
    ok: true,
    experimentId: experiment.id,
    lockVersion,
    counts: { total, clear, clarify, unresolved },
    unresolvedAmbiguousRatio: unresolvedRatio,
    gates: {
      unresolvedDebtMax: 0.01,
      pass: unresolvedRatio <= 0.01
    }
  };
}

export async function runExperimentStep(input: ExperimentStepInput): Promise<Record<string, unknown>> {
  const experiment = await readExperiment(input.experimentId);
  const strategies = await loadExperimentStrategies(experiment.id);
  const selected = input.variantId
    ? strategies.find((s) => s.variant_id === input.variantId)
    : strategies.find((s) => s.status === "queued");
  if (!selected) {
    const hasWinner = Boolean(experiment.winner_variant_id);
    return {
      ok: true,
      experimentId: experiment.id,
      status: experiment.status,
      message: hasWinner ? "No queued strategies remain; winner exists." : "No queued strategies remain.",
      winnerVariantId: experiment.winner_variant_id
    };
  }

  const activeLockVersion = String(experiment.active_benchmark_lock_version ?? "").trim() || null;
  if (!activeLockVersion) {
    throw new Error("No active benchmark lock version. Create a benchmark lock before running autonomous strategy steps.");
  }

  const caseSetFilter = input.caseSet === "all" ? undefined : input.caseSet;
  const cases = await loadExperimentCases(experiment.id, caseSetFilter, activeLockVersion, { eligibleOnly: true });
  if (cases.length === 0) {
    throw new Error("No experiment cases available to run.");
  }

  const previousFailure = await loadPreviousFailureBreakdown(experiment.id, selected.position);
  const learning = previousFailure
    ? applyLearningAdjustments(selected.config, previousFailure)
    : { config: { ...selected.config }, adjustments: [] as LearningAdjustment[] };
  const effectiveConfig = learning.config;
  const leakageFindings = detectBenchmarkLeakage(effectiveConfig, cases);
  if (leakageFindings.length > 0) {
    for (const finding of leakageFindings) {
      await pool.query(
        `INSERT INTO experiment_governance_events (
           experiment_id, strategy_variant_id, event_type, severity, details
         ) VALUES (
           $1::uuid, $2::uuid, $3, $4, $5::jsonb
         )`,
        [experiment.id, selected.id, "benchmark_leakage_detected", "error", JSON.stringify(finding)]
      );
    }
  }

  await pool.query(
    `UPDATE experiment_runs
        SET status = 'running',
            started_at = COALESCE(started_at, now()),
            updated_at = now()
      WHERE id = $1::uuid`,
    [experiment.id]
  );
  await pool.query(
    `UPDATE experiment_strategies
        SET status = 'running',
            config = $2::jsonb,
            started_at = COALESCE(started_at, now()),
            updated_at = now()
      WHERE id = $1::uuid`,
    [
      selected.id,
      JSON.stringify({
        ...effectiveConfig,
        learningAppliedFromPrevious: learning.adjustments.length > 0,
        learningAdjustments: learning.adjustments
      })
    ]
  );

  const principal: V2Principal = { kind: "session", userName: "strategy_runner" };
  const scoredCaseCap = Math.max(
    1,
    cases.filter((c) => (c.ambiguity_class ?? "clear") !== "unresolved" && c.eligible_for_scoring !== false).length
  );
  const failuresAllowed = Math.floor(0.01 * scoredCaseCap);
  const timeoutMsRaw = Number(effectiveConfig.timeoutMs ?? 0);
  const timeoutMs = !Number.isFinite(timeoutMsRaw) || timeoutMsRaw <= 0
    ? 0
    : Math.max(30000, Math.min(300000, timeoutMsRaw));
  const timeoutRetryLimit = Math.max(1, Math.min(3, Number(effectiveConfig.timeoutRetryLimit ?? 1)));
  const rescueOnTimeout = effectiveConfig.rescueOnTimeout !== false;
  const infraMinSample = Math.max(4, Math.min(20, Number(effectiveConfig.infraMinSample ?? 8)));
  const infraTimeoutRateThreshold = Math.max(0.2, Math.min(1, Number(effectiveConfig.infraTimeoutRateThreshold ?? 0.5)));
  const infraRetryLimit = Math.max(0, Math.min(4, Number(effectiveConfig.infraRetryLimit ?? 2)));
  const currentInfraRetries = Math.max(0, Number(effectiveConfig.infraRetryCount ?? 0));
  const noDataRetryLimit = Math.max(1, Math.min(50, Number(effectiveConfig.noDataRetryLimit ?? 20)));
  const currentNoDataRetries = Math.max(0, Number(effectiveConfig.noDataRetryCount ?? 0));

  let failures = 0;
  let passed = 0;
  const latencies: number[] = [];
  const costs: number[] = [];
  const failureRows: Array<{ bucket: string; count: number }> = [];
  const recallAtKs: number[] = [];
  const mrrScores: number[] = [];
  const ndcgScores: number[] = [];
  const evidenceHitRates: number[] = [];
  const perDomain = new Map<string, { total: number; pass: number }>();
  const casesRan: ExperimentCaseRow[] = [];
  let timeoutCount = 0;
  let timeoutRecoveries = 0;
  let confidenceRetries = 0;
  let infraHealthRequeue = false;
  let clearTotal = 0;
  let clearPass = 0;
  let clarifyTotal = 0;
  let clarifyPass = 0;
  let unresolvedTotal = 0;

  for (const testCase of cases) {
    casesRan.push(testCase);
    const askPayload: V2AskRequest = {
      question: testCase.question,
      chatNamespace: testCase.chat_namespace,
      timeframe: "all",
      privacyMode: "private",
      debugMode: false,
      maxLoops: Math.min(3, Math.max(1, Number(effectiveConfig.maxLoops ?? 2))),
      strategyConfig: effectiveConfig
    };

    const firstAttempt = await askWithRescue({
      payload: askPayload,
      principal,
      timeoutMs,
      timeoutRetryLimit,
      rescueOnTimeout
    });
    let attempt = firstAttempt;
    let response = attempt.response;
    let latencyMs = attempt.latencyMs;
    if (attempt.timedOut) timeoutCount += 1;
    if (!attempt.timedOut && attempt.attempts > 1) timeoutRecoveries += 1;
    let evaluated = evaluateCase({ row: testCase, response, latencyMs });
    if (shouldApplyConfidenceRetry({ config: effectiveConfig, response, evaluated })) {
      const correctivePayload: V2AskRequest = {
        ...askPayload,
        maxLoops: Math.min(3, Math.max(1, Number(askPayload.maxLoops ?? 2))),
        strategyConfig: {
          ...(askPayload.strategyConfig ?? {}),
          strategyId: effectiveConfig.strategyId,
          retrievalMode: "hybrid_rerank",
          contextMode: "adaptive",
          confidenceGatedRetry: false
        }
      };
      const retryAttempt = await askWithRescue({
        payload: correctivePayload,
        principal,
        timeoutMs,
        timeoutRetryLimit,
        rescueOnTimeout
      });
      confidenceRetries += 1;
      response = retryAttempt.response;
      latencyMs += retryAttempt.latencyMs;
      if (retryAttempt.timedOut) timeoutCount += 1;
      if (!retryAttempt.timedOut && retryAttempt.attempts > 1) timeoutRecoveries += 1;
      evaluated = evaluateCase({ row: testCase, response, latencyMs });
    }
    latencies.push(latencyMs);
    costs.push(evaluated.estimatedCostPer1k);
    recallAtKs.push(evaluated.recallAtK);
    mrrScores.push(evaluated.mrr);
    ndcgScores.push(evaluated.ndcg);
    evidenceHitRates.push(evaluated.evidenceHitRate);

    if (evaluated.scoringBucket === "unresolved_excluded") {
      unresolvedTotal += 1;
    } else {
      if (evaluated.scoringBucket === "clear") {
        clearTotal += 1;
        if (evaluated.pass) clearPass += 1;
      } else if (evaluated.scoringBucket === "clarify") {
        clarifyTotal += 1;
        if (evaluated.pass) clarifyPass += 1;
      }
      if (evaluated.pass) passed += 1;
      else failures += 1;
    }
    const domainAgg = perDomain.get(testCase.domain) ?? { total: 0, pass: 0 };
    if (evaluated.scoringBucket !== "unresolved_excluded") {
      domainAgg.total += 1;
      if (evaluated.pass) domainAgg.pass += 1;
    }
    perDomain.set(testCase.domain, domainAgg);

    await pool.query(
      `INSERT INTO experiment_case_results (
         experiment_id, strategy_variant_id, case_id, case_set, pass, score, latency_ms,
         estimated_cost_per_1k, failure_buckets, response, returned_evidence_ids,
         clarification_triggered, clarification_quality_score, scoring_bucket
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9::text[], $10::jsonb, $11::uuid[], $12, $13, $14
       )
       ON CONFLICT (strategy_variant_id, case_id)
       DO UPDATE SET
         pass = EXCLUDED.pass,
         score = EXCLUDED.score,
         latency_ms = EXCLUDED.latency_ms,
         estimated_cost_per_1k = EXCLUDED.estimated_cost_per_1k,
         failure_buckets = EXCLUDED.failure_buckets,
         response = EXCLUDED.response,
         returned_evidence_ids = EXCLUDED.returned_evidence_ids,
         clarification_triggered = EXCLUDED.clarification_triggered,
         clarification_quality_score = EXCLUDED.clarification_quality_score,
         scoring_bucket = EXCLUDED.scoring_bucket,
         created_at = now()`,
      [
        experiment.id,
        selected.id,
        testCase.id,
        testCase.case_set,
        evaluated.pass,
        evaluated.score,
        latencyMs,
        evaluated.estimatedCostPer1k,
        evaluated.buckets,
        JSON.stringify(response),
        evaluated.returnedEvidenceIds,
        evaluated.clarificationTriggered,
        evaluated.clarificationQualityScore,
        evaluated.scoringBucket
      ]
    );

    for (const bucket of evaluated.buckets) {
      const current = failureRows.find((r) => r.bucket === bucket);
      if (current) current.count += 1;
      else failureRows.push({ bucket, count: 1 });
      await pool.query(
        `INSERT INTO experiment_failures (
           experiment_id, strategy_variant_id, case_id, bucket, details
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, $4, $5::jsonb
         )`,
        [experiment.id, selected.id, testCase.id, bucket, JSON.stringify({ question: testCase.question })]
      );
    }

    const ranSoFar = passed + failures;
    if (ranSoFar >= infraMinSample) {
      const timeoutRate = timeoutCount / ranSoFar;
      if (timeoutRate >= infraTimeoutRateThreshold) {
        infraHealthRequeue = true;
        break;
      }
    }

    if (failures > failuresAllowed) break;
  }

  const totalRan = passed + failures;
  const passRate = totalRan > 0 ? passed / totalRan : 0;
  const p95LatencyMs = percentile95(latencies);
  const avgLatencyMs = latencies.length > 0
    ? latencies.reduce((a, b) => a + b, 0) / latencies.length
    : 0;
  const estimatedCostPer1kAsks = costs.length > 0
    ? costs.reduce((a, b) => a + b, 0) / costs.length
    : 0;
  const recallAtK = recallAtKs.length > 0 ? recallAtKs.reduce((a, b) => a + b, 0) / recallAtKs.length : 0;
  const mrr = mrrScores.length > 0 ? mrrScores.reduce((a, b) => a + b, 0) / mrrScores.length : 0;
  const ndcg = ndcgScores.length > 0 ? ndcgScores.reduce((a, b) => a + b, 0) / ndcgScores.length : 0;
  const evidenceHitRate = evidenceHitRates.length > 0 ? evidenceHitRates.reduce((a, b) => a + b, 0) / evidenceHitRates.length : 0;

  const failureBreakdown = normalizeFailureCounts(failureRows);
  const scorecard: EvaluationScorecard = {
    strategyId: selected.strategy_id,
    variantId: selected.variant_id,
    caseSet: input.caseSet ?? "all",
    totalCases: totalRan,
    passedCases: passed,
    failedCases: failures,
    passRate,
    p95LatencyMs,
    avgLatencyMs,
    estimatedCostPer1kAsks,
    recallAtK,
    mrr,
    ndcg,
    evidenceHitRate,
    governanceLeakageCount: leakageFindings.length,
    failureBreakdown
  };
  const timeoutRate = totalRan > 0 ? timeoutCount / totalRan : 0;
  const noDataDiagnostics = await collectNoDataDiagnostics({
    experiment,
    casesRan,
    totalRan,
    retrievalMiss: failureBreakdown.retrievalMiss,
    timeoutCount,
    timeoutRate
  });

  if (noDataDiagnostics.hasMissingEvidenceCases && currentNoDataRetries < noDataRetryLimit) {
    const reviewDecision = await runStrategyReviewAgent({
      experiment,
      selected,
      strategyPass: false,
      scorecard,
      timeoutRate,
      baseConfig: effectiveConfig,
      noData: noDataDiagnostics
    });
    const hardPatch = buildNoDataRootFixPatch(effectiveConfig);
    const mergedPatch: Partial<StrategyVariantConfig> = {
      ...hardPatch,
      ...reviewDecision.configPatch,
      strategyId: effectiveConfig.strategyId
    };
    const requeueConfig: StrategyVariantConfig = {
      ...effectiveConfig,
      ...mergedPatch,
      strategyId: effectiveConfig.strategyId,
      noDataRetryCount: currentNoDataRetries + 1,
      noDataRetryLimit
    };

    const requestedSystemActions = Array.from(
      new Set(["analyze_tables", ...(reviewDecision.systemActions ?? [])])
    );
    const appliedSystemActions = await applySystemActions(requestedSystemActions);

    let reseedInfo: { inserted: number; staleMarked: number } | null = null;
    if (
      noDataDiagnostics.expectedEvidencePublished <= 0
      || noDataDiagnostics.staleCaseCount > 0
      || noDataDiagnostics.namespacePublished <= 0
    ) {
      const maxCasesPerPair = Math.max(1, Math.min(4, Number(experiment.config?.maxCasesPerPair ?? 2)));
      const reseedTaxonomyVersion = await getPublishedTaxonomyVersion(experiment.taxonomy_version_id ?? null);
      reseedInfo = await seedExperimentCases({
        experimentId: experiment.id,
        chatNamespace: experiment.chat_namespace,
        maxCasesPerPair,
        taxonomyVersionId: reseedTaxonomyVersion.id
      });
    }

    await pool.query(
      `DELETE FROM experiment_failures
       WHERE strategy_variant_id = $1::uuid`,
      [selected.id]
    );
    await pool.query(
      `DELETE FROM experiment_case_results
       WHERE strategy_variant_id = $1::uuid`,
      [selected.id]
    );
    await pool.query(
      `UPDATE experiment_strategies
          SET status = 'queued',
              config = $2::jsonb,
              metrics = COALESCE(metrics, '{}'::jsonb) || $3::jsonb,
              updated_at = now()
        WHERE id = $1::uuid`,
      [
        selected.id,
        JSON.stringify(requeueConfig),
        JSON.stringify({
          noDataHealthGate: true,
          noDataDiagnostics,
          reviewRationale: reviewDecision.rationale,
          noDataRetryCount: currentNoDataRetries + 1,
          noDataRetryLimit,
          reseedInfo
        })
      ]
    );
    await pool.query(
      `UPDATE experiment_runs
          SET status = 'running',
              notes = $2,
              updated_at = now()
        WHERE id = $1::uuid`,
      [
        experiment.id,
        `no_data_requeue:${selected.variant_id}:retry=${currentNoDataRetries + 1}/${noDataRetryLimit}`
      ]
    );

    await appendStrategyKnowledge({
      createdAt: nowIso(),
      experimentId: experiment.id,
      strategyId: selected.strategy_id,
      variantId: selected.variant_id,
      hypothesis: "Run-health detected missing-evidence cases. Diagnose root cause and requeue same strategy.",
      config: requeueConfig,
      datasetVersion: experiment.dataset_version,
      metrics: {
        ...scorecard,
        timeoutRate,
        timeoutCount,
        timeoutRecoveries,
        confidenceRetries
      },
      failureBuckets: failureBreakdown,
      appliedAdjustments: [
        {
          field: "retrievalMode",
          from: effectiveConfig.retrievalMode ?? "baseline",
          to: requeueConfig.retrievalMode ?? "hybrid_rerank",
          reason: "No-data run health gate."
        }
      ],
      previousFailureBuckets: previousFailure ?? emptyFailureBreakdown(),
      nextHypothesis: "Retry same strategy until all executed cases return evidence."
    });
    await appendStrategyKnowledge({
      createdAt: nowIso(),
      experimentId: experiment.id,
      strategyId: selected.strategy_id,
      variantId: selected.variant_id,
      kind: "strategy_review",
      reviewDecision,
      noDataDiagnostics,
      reseedInfo,
      appliedSystemActions
    });

    return {
      ok: true,
      experimentId: experiment.id,
      strategy: {
        strategyId: selected.strategy_id,
        variantId: selected.variant_id,
        label: selected.label
      },
      noDataRequeue: true,
      noDataDiagnostics,
      review: {
        mode: reviewDecision.mode,
        rationale: reviewDecision.rationale,
        configPatch: reviewDecision.configPatch,
        systemActionsRequested: requestedSystemActions,
        systemActionsApplied: appliedSystemActions
      },
      noDataRetryCount: currentNoDataRetries + 1,
      noDataRetryLimit,
      reseedInfo
    };
  }

  if (infraHealthRequeue && currentInfraRetries < infraRetryLimit) {
    const requeueConfig: StrategyVariantConfig = {
      ...effectiveConfig,
      maxLoops: Math.max(1, Number(effectiveConfig.maxLoops ?? 2) - 1),
      contextMode: effectiveConfig.contextMode === "adaptive" ? "window_thread" : (effectiveConfig.contextMode ?? "window_thread"),
      infraRetryCount: currentInfraRetries + 1
    };
    await pool.query(
      `DELETE FROM experiment_failures
       WHERE strategy_variant_id = $1::uuid`,
      [selected.id]
    );
    await pool.query(
      `DELETE FROM experiment_case_results
       WHERE strategy_variant_id = $1::uuid`,
      [selected.id]
    );
    await pool.query(
      `UPDATE experiment_strategies
          SET status = 'queued',
              config = $2::jsonb,
              metrics = COALESCE(metrics, '{}'::jsonb) || $3::jsonb,
              updated_at = now()
        WHERE id = $1::uuid`,
      [
        selected.id,
        JSON.stringify(requeueConfig),
        JSON.stringify({
          infraHealthGate: true,
          timeoutRate,
          timeoutCount,
          timeoutRecoveries,
          confidenceRetries,
          infraRetryCount: currentInfraRetries + 1,
          infraRetryLimit
        })
      ]
    );
    await pool.query(
      `UPDATE experiment_runs
          SET status = 'running',
              notes = $2,
              updated_at = now()
        WHERE id = $1::uuid`,
      [
        experiment.id,
        `infra_health_requeue:${selected.variant_id}:timeoutRate=${timeoutRate.toFixed(3)}`
      ]
    );
    await appendStrategyKnowledge({
      createdAt: nowIso(),
      experimentId: experiment.id,
      strategyId: selected.strategy_id,
      variantId: selected.variant_id,
      hypothesis: "Infra health gate triggered: requeue same strategy with lower-loop rescue config.",
      config: requeueConfig,
      datasetVersion: experiment.dataset_version,
      metrics: {
        ...scorecard,
        timeoutRate,
        timeoutCount,
        timeoutRecoveries,
        confidenceRetries,
        infraRetryCount: currentInfraRetries + 1
      },
      failureBuckets: failureBreakdown,
      appliedAdjustments: [
        {
          field: "maxLoops",
          from: effectiveConfig.maxLoops ?? null,
          to: requeueConfig.maxLoops ?? null,
          reason: "Infra timeout rate exceeded threshold."
        }
      ],
      previousFailureBuckets: previousFailure ?? emptyFailureBreakdown(),
      nextHypothesis: "Retry same strategy after infra-focused rescue settings."
    });
    return {
      ok: true,
      experimentId: experiment.id,
      strategy: {
        strategyId: selected.strategy_id,
        variantId: selected.variant_id,
        label: selected.label
      },
      infraHealthRequeue: true,
      timeoutRate,
      timeoutCount,
      timeoutRecoveries,
      confidenceRetries,
      infraRetryCount: currentInfraRetries + 1,
      infraRetryLimit
    };
  }

  let domainFloorPass = true;
  for (const [domain, agg] of perDomain.entries()) {
    const domainPassRate = agg.total > 0 ? agg.pass / agg.total : 1;
    if (domainPassRate < experiment.per_domain_floor) {
      domainFloorPass = false;
      await pool.query(
        `INSERT INTO experiment_failures (
           experiment_id, strategy_variant_id, case_id, bucket, details
         ) VALUES (
           $1::uuid, $2::uuid, (SELECT id FROM experiment_cases WHERE experiment_id = $1::uuid LIMIT 1), 'reasoning_synthesis_miss',
           $3::jsonb
         )`,
        [experiment.id, selected.id, JSON.stringify({ domain, domainPassRate, perDomainFloor: experiment.per_domain_floor })]
      );
    }
  }

  const baseline = await resolveBaselineMetrics(experiment.id);
  const latencyGatePass = !baseline || baseline.p95LatencyMs <= 0
    ? true
    : p95LatencyMs <= baseline.p95LatencyMs * experiment.latency_gate_multiplier;
  const costGatePass = !baseline || baseline.costPer1k <= 0
    ? true
    : estimatedCostPer1kAsks <= baseline.costPer1k * experiment.cost_gate_multiplier;
  const leakageGatePass = leakageFindings.length === 0;
  const theoreticalMaxPassRate = scoredCaseCap > 0
    ? (passed + Math.max(0, scoredCaseCap - totalRan)) / scoredCaseCap
    : passRate;
  const clearPassRate = clearTotal > 0 ? clearPass / clearTotal : 1;
  const clarifyPassRate = clarifyTotal > 0 ? clarifyPass / clarifyTotal : 1;
  const unresolvedAmbiguousRatio = cases.length > 0 ? unresolvedTotal / cases.length : 0;

  const threshold = input.caseSet === "critical" ? experiment.critical_target_pass_rate : experiment.target_pass_rate;
  const ambiguityDebtPass = unresolvedAmbiguousRatio <= 0.01;
  const clearGatePass = clearPassRate >= 0.99;
  const clarifyGatePass = clarifyPassRate >= 0.99;
  const strategyPass =
    passRate >= threshold &&
    domainFloorPass &&
    latencyGatePass &&
    costGatePass &&
    leakageGatePass &&
    clearGatePass &&
    clarifyGatePass &&
    ambiguityDebtPass;
  const strategyMetrics = {
    ...scorecard,
    timeoutRate,
    timeoutCount,
    timeoutRecoveries,
    confidenceRetries,
    theoreticalMaxPassRate,
    earlyStopped: totalRan < scoredCaseCap,
    clearPassRate,
    clarifyPassRate,
    unresolvedAmbiguousRatio,
    clearCases: clearTotal,
    clarifyCases: clarifyTotal,
    unresolvedCases: unresolvedTotal,
    clearGatePass,
    clarifyGatePass,
    ambiguityDebtPass,
    latencyGatePass,
    costGatePass,
    domainFloorPass,
    leakageGatePass
  };

  await pool.query(
    `UPDATE experiment_strategies
        SET status = $2,
            metrics = $3::jsonb,
            finished_at = now(),
            updated_at = now()
      WHERE id = $1::uuid`,
    [selected.id, strategyPass ? "completed" : "failed", JSON.stringify(strategyMetrics)]
  );

  await appendStrategyKnowledge({
    createdAt: nowIso(),
    experimentId: experiment.id,
    strategyId: selected.strategy_id,
    variantId: selected.variant_id,
    hypothesis: learning.adjustments.length > 0
      ? `Evaluate ${selected.label} with carry-over learning from prior failure buckets.`
      : `Evaluate ${selected.label} on real DB cases`,
    config: effectiveConfig,
    datasetVersion: experiment.dataset_version,
    metrics: strategyMetrics,
    failureBuckets: failureBreakdown,
    appliedAdjustments: learning.adjustments,
    previousFailureBuckets: previousFailure ?? emptyFailureBreakdown(),
    nextHypothesis: buildNextHypothesis({
      strategyPass,
      failure: failureBreakdown,
      adjustments: learning.adjustments
    }),
    governanceLeakageCount: leakageFindings.length,
    theoreticalMaxPassRate
  });

  const hypothesisEvaluation = await evaluateAndUpdateHypothesis({
    experimentId: experiment.id,
    strategy: selected,
    scorecard
  });
  await updateComponentPerformanceAndStability({
    experimentId: experiment.id,
    strategyVariantId: selected.id,
    caseSet: input.caseSet ?? "all",
    scorecard
  });
  await persistStructuredLesson({
    experimentId: experiment.id,
    strategy: selected,
    hypothesisId: selected.hypothesis_id ?? null,
    failure: failureBreakdown,
    recommendation: buildNextHypothesis({
      strategyPass,
      failure: failureBreakdown,
      adjustments: learning.adjustments
    }),
    confidence: Math.max(0, Math.min(1, passRate)),
    payload: {
      scorecard,
      strategyPass,
      leakageFindings,
      hypothesisEvaluation,
      theoreticalMaxPassRate
    }
  });

  const reviewDecision = await runStrategyReviewAgent({
    experiment,
    selected,
    strategyPass,
    scorecard,
    timeoutRate,
    baseConfig: effectiveConfig,
    noData: noDataDiagnostics
  });
  const appliedSystemActions = await applySystemActions(reviewDecision.systemActions);

  let agentRetryVariantId: string | null = null;
  if (!strategyPass && reviewDecision.mode === "retry_same") {
    agentRetryVariantId = await enqueueAgentRetryVariant({
      experimentId: experiment.id,
      selected,
      baseConfig: effectiveConfig,
      configPatch: reviewDecision.configPatch,
      rationale: reviewDecision.rationale
    });
  }

  let rescueVariantId: string | null = null;
  if (!strategyPass && !agentRetryVariantId) {
    rescueVariantId = await enqueueRescueVariant({
      experimentId: experiment.id,
      selected,
      baseConfig: effectiveConfig,
      failure: failureBreakdown
    });
  }
  const retryVariantId = agentRetryVariantId ?? rescueVariantId;

  await appendStrategyKnowledge({
    createdAt: nowIso(),
    experimentId: experiment.id,
    strategyId: selected.strategy_id,
    variantId: selected.variant_id,
    kind: "strategy_review",
    reviewDecision,
    appliedSystemActions,
    agentRetryVariantId,
    rescueVariantId,
    retryVariantId
  });

  const reason = strategyPass
    ? "Passes threshold and gates on real-data certification slice."
    : (!ambiguityDebtPass && passRate >= threshold && clearGatePass && clarifyGatePass
      ? "Provisional winner blocked: unresolved ambiguity debt exceeds 1%."
      : (!clearGatePass || !clarifyGatePass
        ? "Failed clear/clarify pass gates."
        : null))
      ?? (retryVariantId
        ? `Fails one or more gates; queued retry variant ${retryVariantId}.`
        : "Fails one or more pass/latency/cost/per-domain gates.");
  await pool.query(
    `INSERT INTO experiment_winner_decisions (
       experiment_id, strategy_variant_id, strategy_id, variant_id, pass_rate, p95_latency_ms,
       estimated_cost_per_1k, decision, reason
     ) VALUES (
       $1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9
     )`,
    [
      experiment.id,
      selected.id,
      selected.strategy_id,
      selected.variant_id,
      passRate,
      p95LatencyMs,
      estimatedCostPer1kAsks,
      strategyPass ? "candidate" : "rejected",
      reason
    ]
  );

  let remaining = (await loadExperimentStrategies(experiment.id)).filter((s) => s.status === "queued").length;
  let winnerVariantId: string | null = null;
  if (strategyPass && passRate >= experiment.target_pass_rate) {
    winnerVariantId = selected.variant_id;
    await pool.query(
      `UPDATE experiment_runs
          SET winner_strategy_id = $2,
              winner_variant_id = $3,
              status = CASE WHEN $4::int = 0 THEN 'completed' ELSE 'running' END,
              strategy_cursor = strategy_cursor + 1,
              updated_at = now(),
              finished_at = CASE WHEN $4::int = 0 THEN now() ELSE finished_at END
        WHERE id = $1::uuid`,
      [experiment.id, selected.strategy_id, selected.variant_id, remaining]
    );
    await pool.query(
      `INSERT INTO experiment_winner_decisions (
         experiment_id, strategy_variant_id, strategy_id, variant_id, pass_rate, p95_latency_ms,
         estimated_cost_per_1k, decision, reason
       ) VALUES (
         $1::uuid, $2::uuid, $3, $4, $5, $6, $7, 'winner', $8
       )`,
      [experiment.id, selected.id, selected.strategy_id, selected.variant_id, passRate, p95LatencyMs, estimatedCostPer1kAsks, "Current best passing strategy."]
    );
  } else {
    let queuedAfterResearch = remaining;
    let researchGroup: ResearchEnqueueResult | null = null;
    if (remaining === 0 && !winnerVariantId) {
      researchGroup = await enqueueResearchCandidates(experiment.id, failureBreakdown);
      queuedAfterResearch += researchGroup.inserted;
    }
    remaining = queuedAfterResearch;
    await pool.query(
      `UPDATE experiment_runs
          SET strategy_cursor = strategy_cursor + 1,
              status = CASE WHEN $2::int = 0 THEN 'failed' ELSE 'running' END,
              notes = CASE WHEN $2::int = 0 THEN COALESCE(notes, 'no_more_strategies') ELSE notes END,
              updated_at = now(),
              finished_at = CASE WHEN $2::int = 0 THEN now() ELSE finished_at END
        WHERE id = $1::uuid`,
      [experiment.id, queuedAfterResearch]
    );
    if (researchGroup && researchGroup.inserted > 0) {
      await appendStrategyKnowledge({
        createdAt: nowIso(),
        experimentId: experiment.id,
        kind: "group_transition",
        fromGroup: inferGroupId(selected.strategy_id, selected.config as unknown as Record<string, unknown>),
        toGroup: researchGroup.nextGroup,
        insertedStrategies: researchGroup.insertedStrategies,
        plannedCount: researchGroup.plannedCount
      });
    }
  }

  return {
    ok: true,
    experimentId: experiment.id,
    strategy: {
      strategyId: selected.strategy_id,
      variantId: selected.variant_id,
      label: selected.label
    },
    scorecard,
    thresholds: {
      targetPassRate: threshold,
      clearPassRateTarget: 0.99,
      clarifyPassRateTarget: 0.99,
      unresolvedAmbiguousRatioMax: 0.01,
      perDomainFloor: experiment.per_domain_floor,
      latencyGateMultiplier: experiment.latency_gate_multiplier,
      costGateMultiplier: experiment.cost_gate_multiplier
    },
    runtime: {
      timeoutRate,
      timeoutCount,
      timeoutRecoveries,
      confidenceRetries,
      timeoutMs,
      timeoutRetryLimit
    },
    governance: {
      leakageFindings,
      leakageGatePass
    },
    review: {
      mode: reviewDecision.mode,
      rationale: reviewDecision.rationale,
      configPatch: reviewDecision.configPatch,
      systemActionsRequested: reviewDecision.systemActions,
      systemActionsApplied: appliedSystemActions
    },
    hypothesisEvaluation,
    activeBenchmarkLockVersion: activeLockVersion,
    strategyPass,
    winnerVariantId,
    agentRetryVariantId,
    rescueVariantId,
    retryVariantId,
    remainingQueued: remaining
  };
}

export async function experimentStatus(experimentId: string): Promise<Record<string, unknown>> {
  const experiment = await readExperiment(experimentId);
  const strategies = await loadExperimentStrategies(experimentId);
  const caseCounts = await pool.query<{ case_set: string; c: string }>(
    `SELECT case_set, COUNT(*)::text AS c
     FROM experiment_cases
     WHERE experiment_id = $1::uuid
       AND is_stale = false
     GROUP BY case_set`,
    [experimentId]
  );
  const counts = Object.fromEntries(caseCounts.rows.map((r) => [r.case_set, Number(r.c ?? 0)]));
  return {
    ok: true,
    experiment,
    strategies,
    caseCounts: counts
  };
}

function num(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function getMetricNumber(metrics: Record<string, unknown>, key: string, fallback = 0): number {
  return num(metrics[key], fallback);
}

function parseGroupId(strategy: StrategyRow): number {
  return inferGroupId(strategy.strategy_id, strategy.config as unknown as Record<string, unknown>);
}

function parseComponentSignature(strategy: StrategyRow): Set<string> {
  const out = new Set<string>();
  const components = Array.isArray(strategy.config.components) ? strategy.config.components : [];
  const extra = Array.isArray(strategy.config.extraComponents) ? strategy.config.extraComponents : [];
  for (const raw of [...components, ...extra]) {
    if (!raw || typeof raw !== "object") continue;
    const c = raw as ComponentSelection;
    const ct = String(c.componentType ?? "").trim();
    const cid = String(c.componentId ?? "").trim();
    if (ct && cid) out.add(`${ct}:${cid}`);
  }
  return out;
}

function parseHypothesisTokenSet(strategy: StrategyRow): Set<string> {
  const raw = `${strategy.label ?? ""} ${strategy.config.researchHypothesis ?? ""}`.toLowerCase();
  const tokens = raw
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 4);
  return new Set(tokens);
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection += 1;
  }
  const union = new Set([...a, ...b]).size;
  return union > 0 ? intersection / union : 0;
}

function configSimilarity(a: StrategyVariantConfig, b: StrategyVariantConfig): number {
  const keys: Array<keyof StrategyVariantConfig> = [
    "retrievalMode",
    "contextMode",
    "plannerMode",
    "composerMode",
    "refinementMode",
    "maxLoops"
  ];
  let matches = 0;
  for (const key of keys) {
    const av = a[key];
    const bv = b[key];
    if (String(av ?? "") === String(bv ?? "")) matches += 1;
  }
  return matches / keys.length;
}

function weightedSimilarity(a: StrategyRow, b: StrategyRow): number {
  const cfg = configSimilarity(a.config, b.config);
  const comp = jaccard(parseComponentSignature(a), parseComponentSignature(b));
  const hyp = jaccard(parseHypothesisTokenSet(a), parseHypothesisTokenSet(b));
  return 0.4 * cfg + 0.4 * comp + 0.2 * hyp;
}

function rollingAverage(values: number[], idx: number, windowSize: number): number {
  const start = Math.max(0, idx - windowSize + 1);
  const slice = values.slice(start, idx + 1);
  if (slice.length === 0) return 0;
  return slice.reduce((sum, value) => sum + value, 0) / slice.length;
}

function chooseLatestFinished(strategies: StrategyRow[]): StrategyRow | null {
  const finished = strategies
    .filter((s) => s.status === "completed" || s.status === "failed")
    .sort((a, b) => b.position - a.position);
  return finished[0] ?? null;
}

function chooseBestFinished(strategies: StrategyRow[]): StrategyRow | null {
  const finished = strategies
    .filter((s) => s.status === "completed" || s.status === "failed")
    .sort((a, b) => {
      const ap = getMetricNumber(a.metrics, "passRate", 0);
      const bp = getMetricNumber(b.metrics, "passRate", 0);
      if (bp !== ap) return bp - ap;
      return a.position - b.position;
    });
  return finished[0] ?? null;
}

function computeParetoFlags(
  points: Array<{ variantId: string; passRate: number; latencyMultiplier: number; costMultiplier: number }>
): { latencyPareto: Set<string>; costPareto: Set<string> } {
  const latencyPareto = new Set<string>();
  const costPareto = new Set<string>();
  const dominates = (
    a: { passRate: number; x: number },
    b: { passRate: number; x: number }
  ): boolean => (
    a.passRate >= b.passRate
    && a.x <= b.x
    && (a.passRate > b.passRate || a.x < b.x)
  );
  for (const target of points) {
    let latencyDominated = false;
    let costDominated = false;
    for (const other of points) {
      if (other.variantId === target.variantId) continue;
      if (!latencyDominated && dominates(
        { passRate: other.passRate, x: other.latencyMultiplier },
        { passRate: target.passRate, x: target.latencyMultiplier }
      )) {
        latencyDominated = true;
      }
      if (!costDominated && dominates(
        { passRate: other.passRate, x: other.costMultiplier },
        { passRate: target.passRate, x: target.costMultiplier }
      )) {
        costDominated = true;
      }
      if (latencyDominated && costDominated) break;
    }
    if (!latencyDominated) latencyPareto.add(target.variantId);
    if (!costDominated) costPareto.add(target.variantId);
  }
  return { latencyPareto, costPareto };
}

async function resolveBaselineForMultipliers(experimentId: string): Promise<{ latency: number; cost: number }> {
  const rows = await pool.query<{ latency: string; cost: string }>(
    `SELECT
       metrics->>'p95LatencyMs' AS latency,
       metrics->>'estimatedCostPer1kAsks' AS cost
     FROM experiment_strategies
     WHERE experiment_id = $1::uuid
       AND status IN ('completed', 'failed')
       AND metrics ? 'passRate'
     ORDER BY position ASC
     LIMIT 1`,
    [experimentId]
  );
  const latency = num(rows.rows[0]?.latency, 0);
  const cost = num(rows.rows[0]?.cost, 0);
  return {
    latency: latency > 0 ? latency : 1,
    cost: cost > 0 ? cost : 1
  };
}

async function loadTaxonomyVersionRows(): Promise<TaxonomyVersionRow[]> {
  await ensureBootstrapTaxonomyVersion();
  const rows = await pool.query<{
    id: string;
    version_key: string;
    name: string;
    status: "published" | "archived";
    source_chat_namespace: string;
    parent_version_id: string | null;
    scan_completed_at: string | null;
    published_at: string | null;
    metadata: Record<string, unknown> | null;
    created_at: string;
    updated_at: string;
  }>(
    `SELECT
       id::text,
       version_key,
       name,
       status,
       source_chat_namespace,
       parent_version_id::text,
       scan_completed_at::text,
       published_at::text,
       metadata,
       created_at::text,
       updated_at::text
     FROM taxonomy_versions
     ORDER BY published_at DESC NULLS LAST, created_at DESC`
  );
  return rows.rows.map(normalizeTaxonomyVersionRow);
}

async function buildTaxonomyDraftSummary(versionId: string): Promise<Record<string, unknown>> {
  const domains = await loadTaxonomyDomainKeys(versionId);
  const lenses = await loadTaxonomyLensKeys(versionId);
  const candidateRows = await pool.query<{
    candidate_type: string;
    status: string;
    source_domain_key: string | null;
    source_lens_key: string | null;
    proposed_key: string | null;
    title: string;
    payload: Record<string, unknown> | null;
  }>(
    `SELECT
       candidate_type,
       status,
       source_domain_key,
       source_lens_key,
       proposed_key,
       title,
       payload
     FROM taxonomy_candidate_reviews
     WHERE taxonomy_version_id = $1::uuid
       AND status = 'approved'
     ORDER BY created_at ASC`,
    [versionId]
  );
  const pendingAdds = { domains: new Set<string>(), lenses: new Set<string>() };
  const pendingRemovals = { domains: new Set<string>(), lenses: new Set<string>() };
  const pendingSplits: Array<Record<string, unknown>> = [];
  const pendingMerges: Array<Record<string, unknown>> = [];
  for (const row of candidateRows.rows) {
    if (row.candidate_type === "new_domain_candidate" && row.proposed_key) pendingAdds.domains.add(row.proposed_key);
    if (row.candidate_type === "new_lens_candidate" && row.proposed_key) pendingAdds.lenses.add(row.proposed_key);
    if (row.candidate_type === "split_candidate") {
      pendingSplits.push({
        from: row.source_domain_key,
        to: row.proposed_key,
        title: row.title
      });
      if (row.proposed_key) pendingAdds.domains.add(row.proposed_key);
    }
    if (row.candidate_type === "merge_candidate") {
      const targetKey = String((row.payload ?? {}).targetKey ?? "").trim();
      pendingMerges.push({
        from: row.source_domain_key,
        to: targetKey || row.proposed_key || null,
        title: row.title
      });
      if (row.source_domain_key) pendingRemovals.domains.add(row.source_domain_key);
    }
  }
  return {
    baseDomainCount: domains.length,
    baseLensCount: lenses.length,
    approvedAdds: {
      domains: Array.from(pendingAdds.domains).sort(),
      lenses: Array.from(pendingAdds.lenses).sort()
    },
    approvedRemovals: {
      domains: Array.from(pendingRemovals.domains).sort(),
      lenses: Array.from(pendingRemovals.lenses).sort()
    },
    approvedSplits: pendingSplits,
    approvedMerges: pendingMerges
  };
}

export async function taxonomyVersionsList(): Promise<Record<string, unknown>> {
  const versions = await loadTaxonomyVersionRows();
  const ids = versions.map((item) => item.id);
  const supportRows = ids.length > 0
    ? await pool.query<{ taxonomy_version_id: string; supported_pairs: string; total_pairs: string }>(
      `SELECT
         taxonomy_version_id::text,
         COUNT(*) FILTER (WHERE support_status = 'supported')::text AS supported_pairs,
         COUNT(*)::text AS total_pairs
       FROM taxonomy_pair_support
       WHERE taxonomy_version_id = ANY($1::uuid[])
       GROUP BY taxonomy_version_id`,
      [ids]
    )
    : { rows: [] as Array<{ taxonomy_version_id: string; supported_pairs: string; total_pairs: string }> };
  const candidateRows = ids.length > 0
    ? await pool.query<{ taxonomy_version_id: string; pending_count: string }>(
      `SELECT
         taxonomy_version_id::text,
         COUNT(*) FILTER (WHERE status = 'pending')::text AS pending_count
       FROM taxonomy_candidate_reviews
       WHERE taxonomy_version_id = ANY($1::uuid[])
       GROUP BY taxonomy_version_id`,
      [ids]
    )
    : { rows: [] as Array<{ taxonomy_version_id: string; pending_count: string }> };
  const supportMap = new Map(supportRows.rows.map((row) => [row.taxonomy_version_id, row]));
  const candidateMap = new Map(candidateRows.rows.map((row) => [row.taxonomy_version_id, row]));
  return {
    ok: true,
    versions: versions.map((version) => {
      const support = supportMap.get(version.id);
      const candidates = candidateMap.get(version.id);
      return {
        ...version,
        supportedPairs: Number(support?.supported_pairs ?? 0),
        totalPairs: Number(support?.total_pairs ?? 0),
        candidateBacklog: Number(candidates?.pending_count ?? 0)
      };
    })
  };
}

export async function taxonomyVersionDetail(params: {
  versionId: string;
}): Promise<Record<string, unknown>> {
  const version = await loadTaxonomyVersionRowById(params.versionId);
  const domains = await loadTaxonomyDomainKeys(version.id);
  const lenses = await loadTaxonomyLensKeys(version.id);
  const supportRows = await loadTaxonomySupportRows(version.id, version.sourceChatNamespace);
  const draftSummary = await buildTaxonomyDraftSummary(version.id);
  return {
    ok: true,
    version,
    domainCount: domains.length,
    lensCount: lenses.length,
    supportSummary: {
      supportedPairs: supportRows.filter((row) => row.supportStatus === "supported").length,
      unsupportedPairs: supportRows.filter((row) => row.supportStatus === "unsupported").length,
      supportCoverageRatio: supportRows.length > 0
        ? supportRows.filter((row) => row.supportStatus === "supported").length / supportRows.length
        : null
    },
    draftSummary
  };
}

export async function scanTaxonomyVersionSupport(params: {
  versionId: string;
  chatNamespace?: string;
}): Promise<Record<string, unknown>> {
  const version = await loadTaxonomyVersionRowById(params.versionId);
  const chatNamespace = String(params.chatNamespace ?? version.sourceChatNamespace ?? "personal.main").trim() || "personal.main";
  const summary = await runTaxonomySupportScan({
    taxonomyVersionId: version.id,
    chatNamespace
  });
  return {
    ok: true,
    version,
    summary
  };
}

export async function taxonomySupportMatrix(params: {
  versionId: string;
  chatNamespace?: string;
}): Promise<Record<string, unknown>> {
  const version = await loadTaxonomyVersionRowById(params.versionId);
  const chatNamespace = String(params.chatNamespace ?? version.sourceChatNamespace ?? "personal.main").trim() || "personal.main";
  const supportRows = await ensureTaxonomySupportRows({
    taxonomyVersionId: version.id,
    chatNamespace
  });
  return {
    ok: true,
    version,
    chatNamespace,
    matrix: supportRows,
    summary: {
      supportedPairs: supportRows.filter((row) => row.supportStatus === "supported").length,
      unsupportedPairs: supportRows.filter((row) => row.supportStatus === "unsupported").length,
      supportCoverageRatio: supportRows.length > 0
        ? supportRows.filter((row) => row.supportStatus === "supported").length / supportRows.length
        : 0
    }
  };
}

export async function taxonomyFacetCoverage(params: {
  versionId: string;
  chatNamespace?: string;
  facetType?: string;
  coverageStatus?: string;
  page?: number;
  pageSize?: number;
}): Promise<Record<string, unknown>> {
  const version = await loadTaxonomyVersionRowById(params.versionId);
  const chatNamespace = String(params.chatNamespace ?? version.sourceChatNamespace ?? "personal.main").trim() || "personal.main";
  await ensureTaxonomyFacetCoverageRows({
    taxonomyVersionId: version.id,
    chatNamespace
  });
  const facetType = String(params.facetType ?? "").trim() || null;
  const coverageStatus = String(params.coverageStatus ?? "").trim() || null;
  const pageSize = Number.isFinite(Number(params.pageSize)) ? Math.max(1, Math.min(100, Number(params.pageSize))) : 20;
  const page = Number.isFinite(Number(params.page)) ? Math.max(1, Number(params.page)) : 1;
  const offset = (page - 1) * pageSize;

  const rows = await pool.query<{
    taxonomy_version_id: string;
    chat_namespace: string;
    facet_type: TaxonomyFacetType;
    facet_key: string;
    facet_label: string;
    coverage_status: "covered" | "gap" | "sparse";
    evidence_count: number;
    conversation_count: number;
    benchmark_case_count: number;
    sample_evidence_ids: string[] | string;
    sample_conversation_ids: string[] | string;
    rationale: string | null;
    metadata: Record<string, unknown> | null;
    updated_at: string;
    total_count: string;
  }>(
    `SELECT
       taxonomy_version_id::text,
       chat_namespace,
       facet_type,
       facet_key,
       facet_label,
       coverage_status,
       evidence_count,
       conversation_count,
       benchmark_case_count,
       COALESCE(sample_evidence_ids::text, '{}') AS sample_evidence_ids,
       COALESCE(sample_conversation_ids::text, '{}') AS sample_conversation_ids,
       rationale,
       metadata,
       updated_at::text,
       COUNT(*) OVER()::text AS total_count
     FROM taxonomy_facet_coverage
     WHERE taxonomy_version_id = $1::uuid
       AND chat_namespace = $2
       AND ($3::text IS NULL OR facet_type = $3::text)
       AND ($4::text IS NULL OR coverage_status = $4::text)
     ORDER BY
       CASE coverage_status WHEN 'gap' THEN 0 WHEN 'covered' THEN 1 ELSE 2 END,
       evidence_count DESC,
       facet_label ASC
     LIMIT $5 OFFSET $6`,
    [version.id, chatNamespace, facetType, coverageStatus, pageSize, offset]
  );
  const summaryRows = await pool.query<{
    facet_type: string;
    total_rows: string;
    covered_rows: string;
    gap_rows: string;
    sparse_rows: string;
  }>(
    `SELECT
       facet_type,
       COUNT(*)::text AS total_rows,
       COUNT(*) FILTER (WHERE coverage_status = 'covered')::text AS covered_rows,
       COUNT(*) FILTER (WHERE coverage_status = 'gap')::text AS gap_rows,
       COUNT(*) FILTER (WHERE coverage_status = 'sparse')::text AS sparse_rows
     FROM taxonomy_facet_coverage
     WHERE taxonomy_version_id = $1::uuid
       AND chat_namespace = $2
     GROUP BY facet_type
     ORDER BY facet_type ASC`,
    [version.id, chatNamespace]
  );
  const summary: TaxonomyFacetCoverageSummary = {
    totalRows: summaryRows.rows.reduce((sum, row) => sum + Number(row.total_rows ?? 0), 0),
    coveredRows: summaryRows.rows.reduce((sum, row) => sum + Number(row.covered_rows ?? 0), 0),
    gapRows: summaryRows.rows.reduce((sum, row) => sum + Number(row.gap_rows ?? 0), 0),
    sparseRows: summaryRows.rows.reduce((sum, row) => sum + Number(row.sparse_rows ?? 0), 0),
    byFacetType: summaryRows.rows.map((row) => ({
      facetType: row.facet_type,
      totalRows: Number(row.total_rows ?? 0),
      coveredRows: Number(row.covered_rows ?? 0),
      gapRows: Number(row.gap_rows ?? 0),
      sparseRows: Number(row.sparse_rows ?? 0)
    }))
  };
  const totalRows = Number(rows.rows[0]?.total_count ?? 0);
  return {
    ok: true,
    version,
    chatNamespace,
    rows: rows.rows.map((row): TaxonomyFacetCoverageRow => ({
      taxonomyVersionId: row.taxonomy_version_id,
      chatNamespace: row.chat_namespace,
      facetType: row.facet_type,
      facetKey: row.facet_key,
      facetLabel: row.facet_label,
      coverageStatus: row.coverage_status,
      evidenceCount: Number(row.evidence_count ?? 0),
      conversationCount: Number(row.conversation_count ?? 0),
      benchmarkCaseCount: Number(row.benchmark_case_count ?? 0),
      sampleEvidenceIds: Array.isArray(row.sample_evidence_ids)
        ? row.sample_evidence_ids.map(String)
        : parsePgTextArray(String(row.sample_evidence_ids ?? "{}")),
      sampleConversationIds: Array.isArray(row.sample_conversation_ids)
        ? row.sample_conversation_ids.map(String)
        : parsePgTextArray(String(row.sample_conversation_ids ?? "{}")),
      rationale: row.rationale,
      metadata: row.metadata ?? {},
      updatedAt: row.updated_at
    })),
    summary,
    page,
    pageSize,
    totalRows,
    totalPages: Math.max(1, Math.ceil(totalRows / pageSize))
  };
}

function hasTaxonomyMismatchReason(reasons: string[]): boolean {
  return reasons.some((reason) => [
    "domain_semantic_mismatch",
    "requested_lens_not_supported_by_cluster",
    "support_depth_too_thin_for_requested_lens",
    "lens_fit_mismatch"
  ].includes(String(reason)));
}

async function insertTaxonomyCandidate(params: {
  taxonomyVersionId: string;
  candidateType: OntologyCandidate["candidateType"];
  sourceDomainKey?: string | null;
  sourceLensKey?: string | null;
  proposedKey?: string | null;
  title: string;
  rationale: string;
  recommendationConfidence: number;
  evidenceIds?: string[];
  conversationIds?: string[];
  payload?: Record<string, unknown>;
}): Promise<void> {
  await pool.query(
    `INSERT INTO taxonomy_candidate_reviews (
       taxonomy_version_id, candidate_type, status, source_domain_key, source_lens_key, proposed_key,
       title, rationale, recommendation_confidence, evidence_ids, conversation_ids, payload
     ) VALUES (
       $1::uuid, $2, 'pending', $3, $4, $5, $6, $7, $8, $9::uuid[], $10::text[], $11::jsonb
     )`,
    [
      params.taxonomyVersionId,
      params.candidateType,
      params.sourceDomainKey ?? null,
      params.sourceLensKey ?? null,
      params.proposedKey ?? null,
      params.title,
      params.rationale,
      Math.max(0, Math.min(1, params.recommendationConfidence)),
      uniqueStrings(params.evidenceIds ?? []),
      uniqueStrings(params.conversationIds ?? []),
      JSON.stringify(params.payload ?? {})
    ]
  );
}

export async function generateTaxonomyCandidates(params: {
  versionId: string;
}): Promise<Record<string, unknown>> {
  const version = await loadTaxonomyVersionRowById(params.versionId);
  const activeDomainKeys = new Set(await loadTaxonomyDomainKeys(version.id));
  const activeLensKeys = new Set(await loadTaxonomyLensKeys(version.id));
  await pool.query(
    `DELETE FROM taxonomy_candidate_reviews
     WHERE taxonomy_version_id = $1::uuid
       AND status IN ('pending', 'deferred')`,
    [version.id]
  );

  const caseRows = await pool.query<{
    question: string;
    domain: string;
    lens: string;
    evidence_ids: string[] | string;
    conversation_ids: string[] | string;
    metadata: Record<string, unknown> | null;
  }>(
    `SELECT
       c.question,
       c.domain,
       c.lens,
       COALESCE(c.evidence_ids::text, '{}') AS evidence_ids,
       COALESCE(c.conversation_ids::text, '{}') AS conversation_ids,
       c.metadata
     FROM experiment_cases c
     JOIN experiment_runs e ON e.id = c.experiment_id
     WHERE e.taxonomy_version_id = $1::uuid
       AND c.is_stale = false`,
    [version.id]
  );

  const unmappedGroups = new Map<string, {
    sourceDomainKey: string;
    sourceLensKey: string;
    topicSummary: string;
    evidenceIds: Set<string>;
    conversationIds: Set<string>;
    count: number;
    confidenceSum: number;
  }>();
  const splitGroups = new Map<string, {
    sourceDomainKey: string;
    topicSummary: string;
    evidenceIds: Set<string>;
    conversationIds: Set<string>;
    count: number;
  }>();
  const newLensGroups = new Map<string, {
    title: string;
    evidenceIds: Set<string>;
    conversationIds: Set<string>;
    count: number;
  }>();
  const conversationDomains = new Map<string, Set<string>>();

  for (const row of caseRows.rows) {
    const metadata = row.metadata ?? {};
    const semanticFrame = readSemanticFrame(metadata);
    const admission = readAdmissionDecision(metadata);
    const critique = readAuthoringCritique(metadata);
    const evidenceIds = Array.isArray(row.evidence_ids)
      ? row.evidence_ids.map(String)
      : parsePgTextArray(String(row.evidence_ids ?? "{}"));
    const conversationIds = Array.isArray(row.conversation_ids)
      ? row.conversation_ids.map(String)
      : parsePgTextArray(String(row.conversation_ids ?? "{}"));
    const topicSummary = String(semanticFrame?.topicSummary ?? "").trim();
    const reasons = Array.isArray(admission?.reasons) ? admission.reasons.map(String) : [];

    for (const conversationId of conversationIds) {
      const bucket = conversationDomains.get(conversationId) ?? new Set<string>();
      bucket.add(row.domain);
      conversationDomains.set(conversationId, bucket);
    }

    if (topicSummary) {
      mergeSplitSignal(splitGroups, {
        sourceDomainKey: row.domain,
        topicSummary,
        evidenceIds,
        conversationIds
      });
    }

    const q = String(row.question ?? "").toLowerCase();
    if (/^what did .+ say\b|^what did .+ mention\b/.test(q)) {
      mergeLensSignal(newLensGroups, {
        proposedKey: "actor_attribution",
        title: "Actor attribution lens",
        evidenceIds,
        conversationIds
      });
    }
    if (/find (the )?conversation|which conversation|where did/i.test(q)) {
      mergeLensSignal(newLensGroups, {
        proposedKey: "thread_reconstruction",
        title: "Thread reconstruction lens",
        evidenceIds,
        conversationIds
      });
    }

    if (admission && admission.status !== "accepted" && hasTaxonomyMismatchReason(reasons) && topicSummary) {
      const key = `${row.domain}|${row.lens}|${slugifyTaxonomyKey(topicSummary)}`;
      const agg = unmappedGroups.get(key) ?? {
        sourceDomainKey: row.domain,
        sourceLensKey: row.lens,
        topicSummary,
        evidenceIds: new Set<string>(),
        conversationIds: new Set<string>(),
        count: 0,
        confidenceSum: 0
      };
      agg.count += 1;
      agg.confidenceSum += Number(critique?.score ?? 0);
      evidenceIds.forEach((id) => agg.evidenceIds.add(id));
      conversationIds.forEach((id) => agg.conversationIds.add(id));
      unmappedGroups.set(key, agg);
    }
  }

  const corpusSignals = await collectCorpusOntologySignals({
    taxonomyVersionId: version.id,
    chatNamespace: version.sourceChatNamespace
  });
  for (const group of corpusSignals.splitGroups.values()) {
    mergeSplitSignal(splitGroups, {
      sourceDomainKey: group.sourceDomainKey,
      topicSummary: group.topicSummary,
      evidenceIds: Array.from(group.evidenceIds),
      conversationIds: Array.from(group.conversationIds),
      weight: group.count
    });
  }
  for (const [proposedKey, group] of corpusSignals.newLensGroups.entries()) {
    mergeLensSignal(newLensGroups, {
      proposedKey,
      title: group.title,
      evidenceIds: Array.from(group.evidenceIds),
      conversationIds: Array.from(group.conversationIds),
      weight: group.count
    });
  }

  const topicSpread = new Map<string, {
    proposedKey: string;
    topicSummary: string;
    sourceDomains: Set<string>;
    evidenceIds: Set<string>;
    conversationIds: Set<string>;
    count: number;
  }>();
  for (const group of splitGroups.values()) {
    const proposedKey = normalizeOntologyTopicCandidate(group.topicSummary);
    if (!proposedKey) continue;
    const agg = topicSpread.get(proposedKey) ?? {
      proposedKey,
      topicSummary: group.topicSummary,
      sourceDomains: new Set<string>(),
      evidenceIds: new Set<string>(),
      conversationIds: new Set<string>(),
      count: 0
    };
    agg.sourceDomains.add(group.sourceDomainKey);
    group.evidenceIds.forEach((id) => agg.evidenceIds.add(id));
    group.conversationIds.forEach((id) => agg.conversationIds.add(id));
    agg.count += group.count;
    topicSpread.set(proposedKey, agg);
  }

  let created = 0;
  const createdNewDomainKeys = new Set<string>();
  for (const group of unmappedGroups.values()) {
    const proposedKey = normalizeOntologyTopicCandidate(group.topicSummary) ?? slugifyTaxonomyKey(group.topicSummary);
    const overlap = meaningfulTokens(group.topicSummary).filter((token) => group.sourceDomainKey.includes(token)).length;
    const plausibility = semanticCandidatePlausibility({
      candidateType: "unmapped_cluster",
      sourceDomainKey: group.sourceDomainKey,
      proposedKey,
      topicSummary: group.topicSummary,
      occurrences: group.count
    });
    if (!plausibility.accepted) continue;
    if (plausibility.inferredTopDomain && plausibility.inferredTopDomain === group.sourceDomainKey) continue;
    if (proposedKey && activeDomainKeys.has(proposedKey)) continue;
    await insertTaxonomyCandidate({
      taxonomyVersionId: version.id,
      candidateType: "unmapped_cluster",
      sourceDomainKey: group.sourceDomainKey,
      sourceLensKey: group.sourceLensKey,
      proposedKey,
      title: `Unmapped cluster: ${group.topicSummary}`,
      rationale: `Grounded cluster rejected for taxonomy fit ${group.count} time(s).`,
      recommendationConfidence: Math.min(0.95, Math.max(0.35, group.confidenceSum / Math.max(1, group.count))),
      evidenceIds: Array.from(group.evidenceIds).slice(0, 8),
      conversationIds: Array.from(group.conversationIds).slice(0, 8),
      payload: {
        topicSummary: group.topicSummary,
        overlapWithSourceDomain: overlap,
        occurrences: group.count,
        semanticPlausibility: plausibility
      }
    });
    created += 1;
    if (group.count >= 2 && overlap === 0 && proposedKey) {
      const domainPlausibility = semanticCandidatePlausibility({
        candidateType: "new_domain_candidate",
        sourceDomainKey: group.sourceDomainKey,
        proposedKey,
        topicSummary: group.topicSummary,
        occurrences: group.count
      });
      if (!domainPlausibility.accepted) continue;
      if (activeDomainKeys.has(proposedKey)) continue;
      await insertTaxonomyCandidate({
        taxonomyVersionId: version.id,
        candidateType: "new_domain_candidate",
        sourceDomainKey: group.sourceDomainKey,
        sourceLensKey: group.sourceLensKey,
        proposedKey,
        title: `Candidate domain: ${humanizeTaxonomyKey(proposedKey)}`,
        rationale: `Repeated grounded cluster does not fit ${group.sourceDomainKey}.`,
        recommendationConfidence: Math.min(0.9, 0.5 + group.count * 0.1),
        evidenceIds: Array.from(group.evidenceIds).slice(0, 8),
        conversationIds: Array.from(group.conversationIds).slice(0, 8),
        payload: {
          topicSummary: group.topicSummary,
          sourceDomainKey: group.sourceDomainKey,
          occurrences: group.count,
          semanticPlausibility: domainPlausibility
        }
      });
      created += 1;
      createdNewDomainKeys.add(proposedKey);
    }
  }

  for (const spread of topicSpread.values()) {
    if (spread.sourceDomains.size < 3) continue;
    if (spread.conversationIds.size < 2) continue;
    if (createdNewDomainKeys.has(spread.proposedKey)) continue;
    if (activeDomainKeys.has(spread.proposedKey)) continue;
    if (TAXONOMY_DOMAINS.includes(spread.proposedKey as (typeof TAXONOMY_DOMAINS)[number])) continue;
    const plausibility = semanticCandidatePlausibility({
      candidateType: "new_domain_candidate",
      proposedKey: spread.proposedKey,
      topicSummary: spread.topicSummary,
      occurrences: spread.count
    });
    if (!plausibility.accepted) continue;
    await insertTaxonomyCandidate({
      taxonomyVersionId: version.id,
      candidateType: "new_domain_candidate",
      proposedKey: spread.proposedKey,
      title: `Candidate domain: ${humanizeTaxonomyKey(spread.proposedKey)}`,
      rationale: `Repeated grounded topic appears across ${spread.sourceDomains.size} existing domains, suggesting a missing domain.`,
      recommendationConfidence: Math.min(0.92, 0.5 + spread.sourceDomains.size * 0.08),
      evidenceIds: Array.from(spread.evidenceIds).slice(0, 8),
      conversationIds: Array.from(spread.conversationIds).slice(0, 8),
      payload: {
        topicSummary: spread.topicSummary,
        sourceDomains: Array.from(spread.sourceDomains).sort(),
        occurrences: spread.count,
        semanticPlausibility: plausibility
      }
    });
    created += 1;
    createdNewDomainKeys.add(spread.proposedKey);
  }

  for (const group of splitGroups.values()) {
    if (group.count < 2) continue;
    const proposedKey = normalizeOntologyTopicCandidate(group.topicSummary);
    if (!proposedKey || proposedKey === group.sourceDomainKey) continue;
    const overlap = meaningfulTokens(group.topicSummary).filter((token) => group.sourceDomainKey.includes(token)).length;
    if (overlap > 0) continue;
    const spread = topicSpread.get(proposedKey);
    if ((spread?.sourceDomains.size ?? 0) >= 3) continue;
    if (group.conversationIds.size < 2) continue;
    if (activeDomainKeys.has(proposedKey)) continue;
    const plausibility = semanticCandidatePlausibility({
      candidateType: "split_candidate",
      sourceDomainKey: group.sourceDomainKey,
      proposedKey,
      topicSummary: group.topicSummary,
      occurrences: group.count
    });
    if (!plausibility.accepted) continue;
    await insertTaxonomyCandidate({
      taxonomyVersionId: version.id,
      candidateType: "split_candidate",
      sourceDomainKey: group.sourceDomainKey,
      proposedKey,
      title: `Split ${humanizeTaxonomyKey(group.sourceDomainKey)} into ${humanizeTaxonomyKey(proposedKey)}`,
      rationale: `Repeated topic cluster suggests ${group.sourceDomainKey} may be too broad.`,
      recommendationConfidence: Math.min(0.88, 0.45 + group.count * 0.1),
      evidenceIds: Array.from(group.evidenceIds).slice(0, 8),
      conversationIds: Array.from(group.conversationIds).slice(0, 8),
      payload: {
        topicSummary: group.topicSummary,
        occurrences: group.count,
        semanticPlausibility: plausibility
      }
    });
    created += 1;
  }

  for (const [proposedKey, group] of newLensGroups.entries()) {
    if (group.count < 2) continue;
    if (activeLensKeys.has(proposedKey)) continue;
    await insertTaxonomyCandidate({
      taxonomyVersionId: version.id,
      candidateType: "new_lens_candidate",
      proposedKey,
      title: group.title,
      rationale: `Observed ${group.count} grounded case(s) matching this reasoning mode.`,
      recommendationConfidence: Math.min(0.85, 0.45 + group.count * 0.08),
      evidenceIds: Array.from(group.evidenceIds).slice(0, 8),
      conversationIds: Array.from(group.conversationIds).slice(0, 8),
      payload: {
        heuristic: proposedKey,
        occurrences: group.count
      }
    });
    created += 1;
  }

  const mergeCounts = new Map<string, number>();
  for (const domains of conversationDomains.values()) {
    const sorted = Array.from(domains).sort();
    for (let i = 0; i < sorted.length; i += 1) {
      for (let j = i + 1; j < sorted.length; j += 1) {
        const key = `${sorted[i]}|${sorted[j]}`;
        mergeCounts.set(key, (mergeCounts.get(key) ?? 0) + 1);
      }
    }
  }
  for (const [key, count] of mergeCounts.entries()) {
    if (count < 3) continue;
    const [domainA, domainB] = key.split("|");
    await insertTaxonomyCandidate({
      taxonomyVersionId: version.id,
      candidateType: "merge_candidate",
      sourceDomainKey: domainB,
      proposedKey: domainA,
      title: `Review overlap between ${humanizeTaxonomyKey(domainA)} and ${humanizeTaxonomyKey(domainB)}`,
      rationale: `These domains co-occurred in ${count} conversation cluster(s).`,
      recommendationConfidence: Math.min(0.8, 0.4 + count * 0.07),
      payload: {
        targetKey: domainA,
        occurrences: count,
        domainPair: [domainA, domainB]
      }
    });
    created += 1;
  }

  const list = await taxonomyCandidates({ versionId: version.id });
  return {
    ok: true,
    version,
    created,
    ...list
  };
}

export async function taxonomyCandidates(params: {
  versionId: string;
}): Promise<Record<string, unknown>> {
  const version = await loadTaxonomyVersionRowById(params.versionId);
  const rows = await pool.query<{
    id: string;
    taxonomy_version_id: string;
    candidate_type: OntologyCandidate["candidateType"];
    status: OntologyCandidate["status"];
    source_domain_key: string | null;
    source_lens_key: string | null;
    proposed_key: string | null;
    title: string;
    rationale: string;
    recommendation_confidence: string;
    evidence_ids: string[] | string;
    conversation_ids: string[] | string;
    payload: Record<string, unknown> | null;
    review_notes: string | null;
    reviewed_at: string | null;
    created_at: string;
    updated_at: string;
  }>(
    `SELECT
       id::text,
       taxonomy_version_id::text,
       candidate_type,
       status,
       source_domain_key,
       source_lens_key,
       proposed_key,
       title,
       rationale,
       recommendation_confidence::text,
       COALESCE(evidence_ids::text, '{}') AS evidence_ids,
       COALESCE(conversation_ids::text, '{}') AS conversation_ids,
       payload,
       review_notes,
       reviewed_at::text,
       created_at::text,
       updated_at::text
     FROM taxonomy_candidate_reviews
     WHERE taxonomy_version_id = $1::uuid
     ORDER BY
       CASE status
         WHEN 'pending' THEN 0
         WHEN 'approved' THEN 1
         WHEN 'deferred' THEN 2
         ELSE 3
       END,
       recommendation_confidence DESC,
       created_at DESC`,
    [version.id]
  );
  return {
    ok: true,
    version,
    candidates: rows.rows.map((row) => ({
      id: row.id,
      taxonomyVersionId: row.taxonomy_version_id,
      candidateType: row.candidate_type,
      status: row.status,
      sourceDomainKey: row.source_domain_key,
      sourceLensKey: row.source_lens_key,
      proposedKey: row.proposed_key,
      title: row.title,
      rationale: row.rationale,
      recommendationConfidence: Number(row.recommendation_confidence ?? 0),
      evidenceIds: Array.isArray(row.evidence_ids) ? row.evidence_ids.map(String) : parsePgTextArray(String(row.evidence_ids ?? "{}")),
      conversationIds: Array.isArray(row.conversation_ids) ? row.conversation_ids.map(String) : parsePgTextArray(String(row.conversation_ids ?? "{}")),
      payload: row.payload ?? {},
      reviewNotes: row.review_notes,
      reviewedAt: row.reviewed_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }))
  };
}

export async function reviewTaxonomyCandidate(params: OntologyCandidateReview): Promise<Record<string, unknown>> {
  const status = params.decision;
  const targetKey = String(params.targetKey ?? "").trim() || null;
  const notes = String(params.notes ?? "").trim() || null;
  const row = await pool.query<{ id: string }>(
    `UPDATE taxonomy_candidate_reviews
        SET status = $2,
            review_notes = $3,
            payload = CASE
              WHEN $4::text IS NULL THEN payload
              ELSE COALESCE(payload, '{}'::jsonb) || jsonb_build_object('targetKey', $4::text)
            END,
            reviewed_at = now(),
            updated_at = now()
      WHERE id = $1::uuid
      RETURNING id::text`,
    [params.candidateId, status, notes, targetKey]
  );
  if (!row.rows[0]) throw new Error("Ontology candidate not found");
  return {
    ok: true,
    candidateId: row.rows[0].id,
    status,
    targetKey,
    notes
  };
}

async function nextTaxonomyVersionIdentity(): Promise<{ versionKey: string; name: string }> {
  const rows = await pool.query<{ version_key: string }>(
    `SELECT version_key
     FROM taxonomy_versions
     ORDER BY created_at DESC`
  );
  let maxN = 0;
  for (const row of rows.rows) {
    const match = String(row.version_key).match(/taxonomy_v(\d+)/i);
    if (!match) continue;
    maxN = Math.max(maxN, Number(match[1] ?? 0));
  }
  const next = maxN + 1;
  return {
    versionKey: `taxonomy_v${next}`,
    name: `OpenBrain Taxonomy v${next}`
  };
}

export async function publishTaxonomyVersion(params: {
  versionId: string;
}): Promise<Record<string, unknown>> {
  const sourceVersion = await loadTaxonomyVersionRowById(params.versionId);
  const { versionKey, name } = await nextTaxonomyVersionIdentity();
  const nextVersionId = randomUUID();
  const domainKeys = new Set(await loadTaxonomyDomainKeys(sourceVersion.id));
  const lensKeys = new Set(await loadTaxonomyLensKeys(sourceVersion.id));
  const approvedRows = await pool.query<{
    candidate_type: OntologyCandidate["candidateType"];
    source_domain_key: string | null;
    source_lens_key: string | null;
    proposed_key: string | null;
    payload: Record<string, unknown> | null;
  }>(
    `SELECT
       candidate_type,
       source_domain_key,
       source_lens_key,
       proposed_key,
       payload
     FROM taxonomy_candidate_reviews
     WHERE taxonomy_version_id = $1::uuid
       AND status = 'approved'
     ORDER BY created_at ASC`,
    [sourceVersion.id]
  );

  for (const row of approvedRows.rows) {
    if (row.candidate_type === "new_domain_candidate" && row.proposed_key) domainKeys.add(row.proposed_key);
    if (row.candidate_type === "new_lens_candidate" && row.proposed_key) lensKeys.add(row.proposed_key);
    if (row.candidate_type === "split_candidate" && row.proposed_key) domainKeys.add(row.proposed_key);
    if (row.candidate_type === "merge_candidate" && row.source_domain_key) {
      const targetKey = String((row.payload ?? {}).targetKey ?? row.proposed_key ?? "").trim();
      if (targetKey && domainKeys.has(targetKey) && row.source_domain_key !== targetKey) {
        domainKeys.delete(row.source_domain_key);
      }
    }
  }

  await pool.query(
    `UPDATE taxonomy_versions
        SET status = 'archived',
            updated_at = now()
      WHERE status = 'published'`
  );
  await pool.query(
    `INSERT INTO taxonomy_versions (
       id, version_key, name, status, source_chat_namespace, parent_version_id, published_at, metadata
     ) VALUES (
       $1::uuid, $2, $3, 'published', $4, $5::uuid, now(), $6::jsonb
     )`,
    [
      nextVersionId,
      versionKey,
      name,
      sourceVersion.sourceChatNamespace,
      sourceVersion.id,
      JSON.stringify({
        publishedFromVersionId: sourceVersion.id,
        publishedFromVersionKey: sourceVersion.versionKey,
        approvedCandidateCount: approvedRows.rows.length
      })
    ]
  );
  for (const domain of Array.from(domainKeys).sort()) {
    await pool.query(
      `INSERT INTO taxonomy_domains (
         taxonomy_version_id, domain_key, label, status, metadata
       ) VALUES (
         $1::uuid, $2, $3, 'active', '{}'::jsonb
       )`,
      [nextVersionId, domain, humanizeTaxonomyKey(domain)]
    );
  }
  for (const lens of Array.from(lensKeys).sort()) {
    await pool.query(
      `INSERT INTO taxonomy_lenses (
         taxonomy_version_id, lens_key, label, status, metadata
       ) VALUES (
         $1::uuid, $2, $3, 'active', '{}'::jsonb
       )`,
      [nextVersionId, lens, humanizeTaxonomyKey(lens)]
    );
  }

  const driftSummary = await runTaxonomySupportScan({
    taxonomyVersionId: nextVersionId,
    chatNamespace: sourceVersion.sourceChatNamespace
  });
  await pool.query(
    `UPDATE experiment_runs
        SET benchmark_stale = true,
            updated_at = now()
      WHERE COALESCE(taxonomy_version_id::text, '') <> $1::text`,
    [nextVersionId]
  );

  return {
    ok: true,
    sourceVersionId: sourceVersion.id,
    publishedVersionId: nextVersionId,
    versionKey,
    name,
    driftSummary
  };
}

export async function reseedExperimentFromTaxonomyVersion(params: {
  experimentId: string;
  taxonomyVersionId?: string;
}): Promise<Record<string, unknown>> {
  const experiment = await readExperiment(params.experimentId);
  const taxonomyVersion = await getPublishedTaxonomyVersion(params.taxonomyVersionId ?? null);
  await ensureTaxonomySupportRows({
    taxonomyVersionId: taxonomyVersion.id,
    chatNamespace: experiment.chat_namespace
  });

  await pool.query(
    `DELETE FROM experiment_judge_calibration_labels
     WHERE calibration_item_id IN (
       SELECT id
       FROM experiment_judge_calibration_items
       WHERE experiment_id = $1::uuid
     )`,
    [experiment.id]
  );
  await pool.query(`DELETE FROM experiment_judge_calibration_items WHERE experiment_id = $1::uuid`, [experiment.id]);
  await pool.query(`DELETE FROM experiment_case_results WHERE experiment_id = $1::uuid`, [experiment.id]);
  await pool.query(`DELETE FROM experiment_failures WHERE experiment_id = $1::uuid`, [experiment.id]);
  await pool.query(`DELETE FROM benchmark_lock_versions WHERE experiment_id = $1::uuid`, [experiment.id]);
  await pool.query(`DELETE FROM experiment_winner_decisions WHERE experiment_id = $1::uuid`, [experiment.id]);
  await pool.query(
    `UPDATE experiment_strategies
        SET status = 'queued',
            metrics = '{}'::jsonb,
            updated_at = now()
      WHERE experiment_id = $1::uuid`,
    [experiment.id]
  );

  const maxCasesPerPair = Math.max(1, Math.min(4, Number(experiment.config?.maxCasesPerPair ?? 2)));
  const reseedInfo = await seedExperimentCases({
    experimentId: experiment.id,
    chatNamespace: experiment.chat_namespace,
    maxCasesPerPair,
    taxonomyVersionId: taxonomyVersion.id
  });

  await pool.query(
    `UPDATE experiment_runs
        SET taxonomy_version_id = $2::uuid,
            benchmark_generated_at = now(),
            benchmark_support_scanned_at = $3::timestamptz,
            benchmark_stale = false,
            active_benchmark_lock_version = NULL,
            winner_strategy_id = NULL,
            winner_variant_id = NULL,
            status = 'queued',
            updated_at = now()
      WHERE id = $1::uuid`,
    [experiment.id, taxonomyVersion.id, taxonomyVersion.scanCompletedAt ?? null]
  );

  return {
    ok: true,
    experimentId: experiment.id,
    taxonomyVersionId: taxonomyVersion.id,
    taxonomyVersionKey: taxonomyVersion.versionKey,
    reseedInfo
  };
}

export async function experimentBenchmarkFreshness(params: {
  experimentId: string;
}): Promise<BenchmarkFreshnessStatus & Record<string, unknown>> {
  const experiment = await readExperiment(params.experimentId);
  const latestPublished = await getPublishedTaxonomyVersion(null);
  const experimentVersion = experiment.taxonomy_version_id
    ? await loadTaxonomyVersionRowById(experiment.taxonomy_version_id)
    : null;
  const reasons: string[] = [];
  if (!experimentVersion) reasons.push("experiment_has_no_taxonomy_version");
  if (experimentVersion && latestPublished.id !== experimentVersion.id) reasons.push("newer_published_taxonomy_exists");
  if (experimentVersion?.scanCompletedAt && experiment.benchmark_generated_at && new Date(experimentVersion.scanCompletedAt) > new Date(experiment.benchmark_generated_at)) {
    reasons.push("taxonomy_support_scan_is_newer_than_benchmark");
  }
  if (Boolean(experiment.benchmark_stale)) reasons.push("benchmark_marked_stale");
  const freshness: BenchmarkFreshnessStatus = {
    experimentId: experiment.id,
    taxonomyVersionId: experimentVersion?.id ?? null,
    taxonomyVersionKey: experimentVersion?.versionKey ?? null,
    latestPublishedVersionId: latestPublished.id,
    latestPublishedVersionKey: latestPublished.versionKey,
    benchmarkGeneratedAt: experiment.benchmark_generated_at ?? null,
    benchmarkSupportScannedAt: experiment.benchmark_support_scanned_at ?? null,
    latestScanCompletedAt: experimentVersion?.scanCompletedAt ?? latestPublished.scanCompletedAt ?? null,
    benchmarkStale: reasons.length > 0,
    reasons
  };
  return {
    ok: true,
    ...freshness
  };
}

export async function experimentList(params?: {
  limit?: number;
  status?: string;
  q?: string;
}): Promise<Record<string, unknown>> {
  const limit = Number.isFinite(Number(params?.limit)) ? Math.max(1, Math.min(100, Number(params?.limit))) : 25;
  const status = String(params?.status ?? "").trim() || null;
  const q = String(params?.q ?? "").trim() || null;
  const rows = await pool.query<{
    id: string;
    name: string;
    status: string;
    created_at: string;
    taxonomy_version_id: string | null;
    taxonomy_version_key: string | null;
    active_lock_version: string | null;
    latest_pass_rate: string | null;
    queued_count: string;
    running_count: string;
    completed_count: string;
    failed_count: string;
    pending_calibration: string;
  }>(
    `SELECT
       e.id::text,
       e.name,
       e.status,
       e.created_at::text,
       e.taxonomy_version_id::text,
       tv.version_key AS taxonomy_version_key,
       e.active_benchmark_lock_version AS active_lock_version,
       (
         SELECT wd.pass_rate::text
         FROM experiment_winner_decisions wd
         WHERE wd.experiment_id = e.id
         ORDER BY wd.created_at DESC
         LIMIT 1
       ) AS latest_pass_rate,
       (
         SELECT COUNT(*)::text
         FROM experiment_strategies s
         WHERE s.experiment_id = e.id
           AND s.status = 'queued'
       ) AS queued_count,
       (
         SELECT COUNT(*)::text
         FROM experiment_strategies s
         WHERE s.experiment_id = e.id
           AND s.status = 'running'
       ) AS running_count,
       (
         SELECT COUNT(*)::text
         FROM experiment_strategies s
         WHERE s.experiment_id = e.id
           AND s.status = 'completed'
       ) AS completed_count,
       (
         SELECT COUNT(*)::text
         FROM experiment_strategies s
         WHERE s.experiment_id = e.id
           AND s.status = 'failed'
       ) AS failed_count,
       (
         SELECT COUNT(*)::text
         FROM experiment_judge_calibration_items i
         WHERE i.experiment_id = e.id
           AND i.status = 'pending'
       ) AS pending_calibration
     FROM experiment_runs e
     LEFT JOIN taxonomy_versions tv ON tv.id = e.taxonomy_version_id
     WHERE ($1::text IS NULL OR e.status = $1::text)
       AND ($2::text IS NULL OR e.name ILIKE ('%' || $2::text || '%') OR e.id::text ILIKE ('%' || $2::text || '%'))
     ORDER BY e.created_at DESC
     LIMIT $3`,
    [status, q, limit]
  );
  return {
    ok: true,
    experiments: rows.rows.map((row) => ({
      id: row.id,
      name: row.name,
      status: row.status,
      createdAt: row.created_at,
      taxonomyVersionId: row.taxonomy_version_id ?? null,
      taxonomyVersionKey: row.taxonomy_version_key ?? null,
      activeLockVersion: row.active_lock_version ?? null,
      latestPassRate: row.latest_pass_rate == null ? null : Number(row.latest_pass_rate),
      queueCounts: {
        queued: Number(row.queued_count ?? 0),
        running: Number(row.running_count ?? 0),
        completed: Number(row.completed_count ?? 0),
        failed: Number(row.failed_count ?? 0),
        pendingCalibration: Number(row.pending_calibration ?? 0)
      }
    }))
  };
}

export async function experimentEvolutionOverview(params: {
  experimentId: string;
}): Promise<Record<string, unknown>> {
  const experiment = await readExperiment(params.experimentId);
  const taxonomyVersion = experiment.taxonomy_version_id
    ? await loadTaxonomyVersionRowById(experiment.taxonomy_version_id)
    : null;
  const strategies = await loadExperimentStrategies(params.experimentId);
  const statusCounts = strategies.reduce<Record<string, number>>((acc, strategy) => {
    acc[strategy.status] = (acc[strategy.status] ?? 0) + 1;
    return acc;
  }, {});
  const latest = chooseLatestFinished(strategies);
  const best = chooseBestFinished(strategies);
  const leakageCountRow = await pool.query<{ c: string }>(
    `SELECT COUNT(*)::text AS c
     FROM experiment_governance_events
     WHERE experiment_id = $1::uuid
       AND (
         event_type ILIKE '%leakage%'
         OR (details::text ILIKE '%benchmark%' AND details::text ILIKE '%question%')
       )`,
    [params.experimentId]
  );
  const leakageCount = Number(leakageCountRow.rows[0]?.c ?? 0);

  const debt = String(experiment.active_benchmark_lock_version ?? "").trim()
    ? await getExperimentBenchmarkDebt({ experimentId: params.experimentId })
    : {
        unresolvedAmbiguousRatio: null,
        gates: { pass: false }
      };
  const lock = await getExperimentBenchmarkLock({ experimentId: params.experimentId });

  const latestMetrics = latest?.metrics ?? {};
  const bestMetrics = best?.metrics ?? {};
  const currentRunning = strategies.find((s) => s.status === "running") ?? null;

  const runtimeRows = await pool.query<{
    timeout_count: string;
    timeout_recoveries: string;
    no_data_requeue: string;
    rescue_lineage: string;
  }>(
    `SELECT
       SUM(COALESCE((metrics->>'timeoutCount')::double precision, 0))::text AS timeout_count,
       SUM(COALESCE((metrics->>'timeoutRecoveries')::double precision, 0))::text AS timeout_recoveries,
       SUM(CASE WHEN COALESCE((metrics->>'noDataRequeue')::boolean, false) THEN 1 ELSE 0 END)::text AS no_data_requeue,
       SUM(CASE WHEN lineage_reason = 'rescue_variant_retry' THEN 1 ELSE 0 END)::text AS rescue_lineage
     FROM experiment_strategies
     WHERE experiment_id = $1::uuid`,
    [params.experimentId]
  );
  const authoringRows = await pool.query<{
    accepted_count: string;
    rejected_count: string;
    unresolved_count: string;
    verifier_pass_count: string;
    verifier_total: string;
    calibration_eligible_count: string;
  }>(
    `SELECT
       COUNT(*) FILTER (
         WHERE COALESCE((metadata->'admissionDecision'->>'status')::text, '') = 'accepted'
       )::text AS accepted_count,
       COUNT(*) FILTER (
         WHERE COALESCE((metadata->'admissionDecision'->>'status')::text, '') = 'rejected'
       )::text AS rejected_count,
       COUNT(*) FILTER (
         WHERE COALESCE((metadata->'admissionDecision'->>'status')::text, '') = 'unresolved'
       )::text AS unresolved_count,
       COUNT(*) FILTER (
         WHERE COALESCE((metadata->'feasibilityReport'->>'pass')::boolean, false) = true
       )::text AS verifier_pass_count,
       COUNT(*) FILTER (
         WHERE metadata ? 'feasibilityReport'
       )::text AS verifier_total,
       COUNT(*) FILTER (
         WHERE COALESCE((metadata->'admissionDecision'->>'admitted')::boolean, false) = true
           AND ambiguity_class IN ('clear', 'clarify_required')
           AND owner_validation_state = 'pending'
       )::text AS calibration_eligible_count
     FROM experiment_cases
     WHERE experiment_id = $1::uuid
       AND is_stale = false`,
    [params.experimentId]
  );
  const authoringAcceptedCount = Number(authoringRows.rows[0]?.accepted_count ?? 0);
  const authoringRejectedCount = Number(authoringRows.rows[0]?.rejected_count ?? 0);
  const authoringUnresolvedCount = Number(authoringRows.rows[0]?.unresolved_count ?? 0);
  const verifierPassCount = Number(authoringRows.rows[0]?.verifier_pass_count ?? 0);
  const verifierTotal = Number(authoringRows.rows[0]?.verifier_total ?? 0);
  const calibrationEligibleCount = Number(authoringRows.rows[0]?.calibration_eligible_count ?? 0);
  const supportRows = taxonomyVersion
    ? await loadTaxonomySupportRows(taxonomyVersion.id, experiment.chat_namespace)
    : [];
  const candidateBacklogRow = taxonomyVersion
    ? await pool.query<{ c: string }>(
      `SELECT COUNT(*)::text AS c
       FROM taxonomy_candidate_reviews
       WHERE taxonomy_version_id = $1::uuid
         AND status = 'pending'`,
      [taxonomyVersion.id]
    )
    : { rows: [] as Array<{ c: string }> };
  const candidateBacklog = Number(candidateBacklogRow.rows[0]?.c ?? 0);
  const supportCoverageRatio = supportRows.length > 0
    ? supportRows.filter((row) => row.supportStatus === "supported").length / supportRows.length
    : null;
  const freshness = await experimentBenchmarkFreshness({ experimentId: params.experimentId });

  return {
    ok: true,
    experimentId: params.experimentId,
    experiment: {
      id: experiment.id,
      name: experiment.name,
      status: experiment.status,
      chatNamespace: experiment.chat_namespace,
      activeLockVersion: experiment.active_benchmark_lock_version ?? null,
      winnerVariantId: experiment.winner_variant_id ?? null,
      taxonomyVersionId: experiment.taxonomy_version_id ?? null,
      taxonomyVersionKey: taxonomyVersion?.versionKey ?? null,
      benchmarkStale: freshness.benchmarkStale
    },
    kpis: {
      currentVariantId: currentRunning?.variant_id ?? latest?.variant_id ?? null,
      bestVariantId: best?.variant_id ?? null,
      bestPassRate: getMetricNumber(bestMetrics, "passRate", 0),
      clearPassRate: getMetricNumber(latestMetrics, "clearPassRate", 0),
      clarifyPassRate: getMetricNumber(latestMetrics, "clarifyPassRate", 0),
      unresolvedAmbiguousRatio: debt.unresolvedAmbiguousRatio ?? null,
      unresolvedDebtPass: Boolean((debt.gates as Record<string, unknown> | undefined)?.pass),
      queuedCount: statusCounts.queued ?? 0,
      runningCount: statusCounts.running ?? 0,
      completedCount: statusCounts.completed ?? 0,
      failedCount: statusCounts.failed ?? 0,
      skippedCount: statusCounts.skipped ?? 0,
      leakageCount,
      timeoutCount: Number(runtimeRows.rows[0]?.timeout_count ?? 0),
      timeoutRecoveries: Number(runtimeRows.rows[0]?.timeout_recoveries ?? 0),
      noDataRequeueCount: Number(runtimeRows.rows[0]?.no_data_requeue ?? 0),
      rescueRetryCount: Number(runtimeRows.rows[0]?.rescue_lineage ?? 0),
      authoringAcceptedCount,
      authoringRejectedCount,
      authoringUnresolvedCount,
      verifierPassRate: verifierTotal > 0 ? verifierPassCount / verifierTotal : 0,
      calibrationEligibleCount,
      ontologyCandidateBacklog: candidateBacklog,
      supportCoverageRatio
    },
    lock
  };
}

export async function experimentEvolutionFrontier(params: {
  experimentId: string;
}): Promise<Record<string, unknown>> {
  const baseline = await resolveBaselineForMultipliers(params.experimentId);
  const strategies = await loadExperimentStrategies(params.experimentId);
  const points = strategies
    .filter((s) => s.status === "completed" || s.status === "failed")
    .map((s) => {
      const passRate = getMetricNumber(s.metrics, "passRate", 0);
      const latency = Math.max(0, getMetricNumber(s.metrics, "p95LatencyMs", 0));
      const cost = Math.max(0, getMetricNumber(s.metrics, "estimatedCostPer1kAsks", 0));
      const latencyMultiplier = baseline.latency > 0 ? latency / baseline.latency : 1;
      const costMultiplier = baseline.cost > 0 ? cost / baseline.cost : 1;
      return {
        strategyId: s.strategy_id,
        variantId: s.variant_id,
        label: s.label,
        position: s.position,
        status: s.status,
        groupId: parseGroupId(s),
        passRate,
        latencyP95Ms: latency,
        costPer1k: cost,
        latencyMultiplier,
        costMultiplier
      };
    });
  const pareto = computeParetoFlags(points);
  return {
    ok: true,
    experimentId: params.experimentId,
    baseline: {
      latencyP95Ms: baseline.latency,
      costPer1k: baseline.cost
    },
    points: points.map((point) => ({
      ...point,
      paretoLatency: pareto.latencyPareto.has(point.variantId),
      paretoCost: pareto.costPareto.has(point.variantId)
    }))
  };
}

export async function experimentEvolutionTimeseries(params: {
  experimentId: string;
}): Promise<Record<string, unknown>> {
  const strategies = (await loadExperimentStrategies(params.experimentId))
    .filter((s) => s.status === "completed" || s.status === "failed")
    .sort((a, b) => a.position - b.position);
  const passValues = strategies.map((s) => getMetricNumber(s.metrics, "passRate", 0));
  let bestSoFar = 0;
  const velocity = strategies.map((s, idx) => {
    const passRate = passValues[idx];
    bestSoFar = Math.max(bestSoFar, passRate);
    return {
      position: s.position,
      strategyId: s.strategy_id,
      variantId: s.variant_id,
      passRate,
      bestSoFar,
      movingAverage: rollingAverage(passValues, idx, 5)
    };
  });

  const failures = await pool.query<{ position: string; bucket: string; c: string }>(
    `SELECT
       s.position::text AS position,
       f.bucket,
       COUNT(*)::text AS c
     FROM experiment_failures f
     JOIN experiment_strategies s ON s.id = f.strategy_variant_id
     WHERE f.experiment_id = $1::uuid
     GROUP BY s.position, f.bucket
     ORDER BY s.position ASC`,
    [params.experimentId]
  );
  const positionIndex = new Map<number, number>();
  velocity.forEach((point, idx) => positionIndex.set(point.position, idx));
  const failuresByBucket = FAILURE_BUCKETS.map((bucket) => ({
    bucket,
    series: Array(velocity.length).fill(0)
  }));
  const bucketIndex = new Map<string, number>();
  failuresByBucket.forEach((entry, idx) => bucketIndex.set(entry.bucket, idx));
  for (const row of failures.rows) {
    const pos = Number(row.position ?? -1);
    const idx = positionIndex.get(pos);
    const bucketIdx = bucketIndex.get(row.bucket);
    if (idx == null || bucketIdx == null) continue;
    failuresByBucket[bucketIdx].series[idx] = Number(row.c ?? 0);
  }

  const hypothesisRows = await pool.query<{
    decision: string;
    confidence_after: string;
    created_at: string;
  }>(
    `SELECT hu.decision, hu.confidence_after::text, hu.created_at::text
     FROM hypothesis_updates hu
     JOIN hypotheses h ON h.id = hu.hypothesis_id
     WHERE h.experiment_id = $1::uuid
     ORDER BY hu.created_at ASC`,
    [params.experimentId]
  );
  const outcomeCounts = {
    confirmed: 0,
    partiallyConfirmed: 0,
    rejected: 0
  };
  const updates = hypothesisRows.rows.map((row) => {
    const decision = String(row.decision ?? "");
    if (decision === "confirmed") outcomeCounts.confirmed += 1;
    else if (decision === "partially_confirmed") outcomeCounts.partiallyConfirmed += 1;
    else if (decision === "rejected") outcomeCounts.rejected += 1;
    return {
      decision,
      confidenceAfter: Number(row.confidence_after ?? 0),
      createdAt: row.created_at
    };
  });

  const runtime = strategies.map((strategy) => ({
    position: strategy.position,
    variantId: strategy.variant_id,
    timeoutCount: getMetricNumber(strategy.metrics, "timeoutCount", 0),
    timeoutRecoveries: getMetricNumber(strategy.metrics, "timeoutRecoveries", 0),
    noDataRequeue: strategy.metrics.noDataRequeue === true ? 1 : 0,
    rescueRetry: strategy.lineage_reason === "rescue_variant_retry" ? 1 : 0
  }));

  return {
    ok: true,
    experimentId: params.experimentId,
    velocity,
    failuresByBucket,
    hypothesisOutcomes: {
      counts: outcomeCounts,
      updates
    },
    runtime
  };
}

export async function experimentEvolutionComponentHeatmap(params: {
  experimentId: string;
  maxComponents?: number;
  maxDomains?: number;
}): Promise<Record<string, unknown>> {
  const maxComponents = Math.max(4, Math.min(30, Number(params.maxComponents ?? 12)));
  const maxDomains = Math.max(4, Math.min(30, Number(params.maxDomains ?? 12)));
  const rows = await pool.query<{
    component_name: string;
    domain: string;
    score: string;
    runs: string;
  }>(
    `SELECT
       cr.component_name,
       cp.domain,
       AVG(cp.avg_score)::text AS score,
       SUM(cp.runs)::text AS runs
     FROM component_performance cp
     JOIN component_registry cr ON cr.id = cp.component_id
     WHERE cp.experiment_id = $1::uuid
     GROUP BY cr.component_name, cp.domain`,
    [params.experimentId]
  );
  if (rows.rows.length === 0) {
    return {
      ok: true,
      experimentId: params.experimentId,
      components: [],
      domains: [],
      cells: []
    };
  }

  const componentScores = new Map<string, { sum: number; n: number; runs: number }>();
  const domainScores = new Map<string, { sum: number; n: number; runs: number }>();
  for (const row of rows.rows) {
    const score = Number(row.score ?? 0);
    const runs = Number(row.runs ?? 0);
    const comp = componentScores.get(row.component_name) ?? { sum: 0, n: 0, runs: 0 };
    comp.sum += score;
    comp.n += 1;
    comp.runs += runs;
    componentScores.set(row.component_name, comp);

    const dom = domainScores.get(row.domain) ?? { sum: 0, n: 0, runs: 0 };
    dom.sum += score;
    dom.n += 1;
    dom.runs += runs;
    domainScores.set(row.domain, dom);
  }

  const components = Array.from(componentScores.entries())
    .sort((a, b) => (b[1].sum / Math.max(1, b[1].n)) - (a[1].sum / Math.max(1, a[1].n)))
    .slice(0, maxComponents)
    .map(([name]) => name);
  const domains = Array.from(domainScores.entries())
    .sort((a, b) => (b[1].runs - a[1].runs))
    .slice(0, maxDomains)
    .map(([name]) => name);
  const componentSet = new Set(components);
  const domainSet = new Set(domains);

  const cells = rows.rows
    .filter((row) => componentSet.has(row.component_name) && domainSet.has(row.domain))
    .map((row) => ({
      componentName: row.component_name,
      domain: row.domain,
      score: Number(row.score ?? 0),
      runs: Number(row.runs ?? 0)
    }));

  return {
    ok: true,
    experimentId: params.experimentId,
    components,
    domains,
    cells
  };
}

export async function experimentEvolutionDiversity(params: {
  experimentId: string;
}): Promise<Record<string, unknown>> {
  const strategies = (await loadExperimentStrategies(params.experimentId))
    .filter((s) => s.status === "completed" || s.status === "failed");
  const bins = [
    { min: 0.0, max: 0.2, label: "0.0-0.2", count: 0 },
    { min: 0.2, max: 0.4, label: "0.2-0.4", count: 0 },
    { min: 0.4, max: 0.6, label: "0.4-0.6", count: 0 },
    { min: 0.6, max: 0.8, label: "0.6-0.8", count: 0 },
    { min: 0.8, max: 1.01, label: "0.8-1.0", count: 0 }
  ];
  if (strategies.length < 2) {
    return {
      ok: true,
      experimentId: params.experimentId,
      pairCount: 0,
      averageSimilarity: 0,
      bins
    };
  }
  let pairCount = 0;
  let sumSimilarity = 0;
  for (let i = 0; i < strategies.length; i += 1) {
    for (let j = i + 1; j < strategies.length; j += 1) {
      const sim = weightedSimilarity(strategies[i], strategies[j]);
      sumSimilarity += sim;
      pairCount += 1;
      for (const bin of bins) {
        if (sim >= bin.min && sim < bin.max) {
          bin.count += 1;
          break;
        }
      }
    }
  }
  return {
    ok: true,
    experimentId: params.experimentId,
    pairCount,
    averageSimilarity: pairCount > 0 ? sumSimilarity / pairCount : 0,
    bins
  };
}

export async function experimentEvolutionCoverage(params: {
  experimentId: string;
}): Promise<Record<string, unknown>> {
  const experiment = await readExperiment(params.experimentId);
  const lockVersion = String(experiment.active_benchmark_lock_version ?? "").trim() || null;
  const expectedRows = await pool.query<{ evidence_id: string }>(
    `SELECT DISTINCT u::text AS evidence_id
     FROM experiment_cases c
     CROSS JOIN LATERAL unnest(
       CASE
         WHEN COALESCE(array_length(c.required_evidence_ids, 1), 0) > 0 THEN c.required_evidence_ids
         ELSE c.evidence_ids
       END
     ) AS u
     WHERE c.experiment_id = $1::uuid
       AND c.is_stale = false
       AND ($2::text IS NULL OR c.benchmark_lock_version = $2::text)`,
    [params.experimentId, lockVersion]
  );
  const touchedRows = await pool.query<{ evidence_id: string }>(
    `SELECT DISTINCT u::text AS evidence_id
     FROM experiment_case_results r
     JOIN experiment_cases c ON c.id = r.case_id
     CROSS JOIN LATERAL unnest(r.returned_evidence_ids) AS u
     WHERE r.experiment_id = $1::uuid
       AND c.is_stale = false
       AND ($2::text IS NULL OR c.benchmark_lock_version = $2::text)`,
    [params.experimentId, lockVersion]
  );
  const expectedSet = new Set(expectedRows.rows.map((row) => row.evidence_id));
  const touchedSet = new Set(touchedRows.rows.map((row) => row.evidence_id));
  let overlap = 0;
  for (const id of touchedSet) {
    if (expectedSet.has(id)) overlap += 1;
  }
  const expectedCount = expectedSet.size;
  const touchedCount = overlap;
  return {
    ok: true,
    experimentId: params.experimentId,
    lockVersion,
    expectedEvidenceCount: expectedCount,
    touchedEvidenceCount: touchedCount,
    coverageRatio: expectedCount > 0 ? touchedCount / expectedCount : 0
  };
}

export async function experimentPreloopReadiness(params: {
  experimentId: string;
}): Promise<Record<string, unknown>> {
  const experiment = await readExperiment(params.experimentId);
  const taxonomyVersion = experiment.taxonomy_version_id
    ? await loadTaxonomyVersionRowById(experiment.taxonomy_version_id)
    : null;
  const counts = await pool.query<{
    total: string;
    clear_total: string;
    clarify_total: string;
    unresolved_total: string;
    authoring_accepted: string;
    authoring_rejected: string;
    authoring_unresolved: string;
    verifier_pass_count: string;
    verifier_total: string;
    approved_clear: string;
    approved_clarify: string;
    pending_owner: string;
    rejected_total: string;
    lock_eligible: string;
    calibration_eligible: string;
  }>(
    `SELECT
       COUNT(*)::text AS total,
       COUNT(*) FILTER (WHERE ambiguity_class = 'clear')::text AS clear_total,
       COUNT(*) FILTER (WHERE ambiguity_class = 'clarify_required')::text AS clarify_total,
       COUNT(*) FILTER (WHERE ambiguity_class = 'unresolved')::text AS unresolved_total,
       COUNT(*) FILTER (
         WHERE COALESCE((metadata->'admissionDecision'->>'status')::text, '') = 'accepted'
       )::text AS authoring_accepted,
       COUNT(*) FILTER (
         WHERE COALESCE((metadata->'admissionDecision'->>'status')::text, '') = 'rejected'
       )::text AS authoring_rejected,
       COUNT(*) FILTER (
         WHERE COALESCE((metadata->'admissionDecision'->>'status')::text, '') = 'unresolved'
       )::text AS authoring_unresolved,
       COUNT(*) FILTER (
         WHERE COALESCE((metadata->'feasibilityReport'->>'pass')::boolean, false) = true
       )::text AS verifier_pass_count,
       COUNT(*) FILTER (
         WHERE metadata ? 'feasibilityReport'
       )::text AS verifier_total,
       COUNT(*) FILTER (WHERE ambiguity_class = 'clear' AND owner_validation_state IN ('approved', 'not_required'))::text AS approved_clear,
       COUNT(*) FILTER (WHERE ambiguity_class = 'clarify_required' AND owner_validation_state IN ('approved', 'not_required'))::text AS approved_clarify,
       COUNT(*) FILTER (
         WHERE owner_validation_state = 'pending'
           AND ambiguity_class IN ('clear', 'clarify_required')
           AND COALESCE((metadata->'admissionDecision'->>'admitted')::boolean, false) = true
       )::text AS pending_owner,
       COUNT(*) FILTER (WHERE owner_validation_state = 'rejected')::text AS rejected_total,
       COUNT(*) FILTER (
          WHERE ambiguity_class IN ('clear', 'clarify_required')
           AND COALESCE((metadata->'admissionDecision'->>'admitted')::boolean, false) = true
           AND owner_validation_state IN ('approved', 'not_required')
       )::text AS lock_eligible,
       COUNT(*) FILTER (
         WHERE ambiguity_class IN ('clear', 'clarify_required')
           AND COALESCE((metadata->'admissionDecision'->>'admitted')::boolean, false) = true
           AND owner_validation_state = 'pending'
       )::text AS calibration_eligible
     FROM experiment_cases
     WHERE experiment_id = $1::uuid
       AND is_stale = false`,
    [params.experimentId]
  );
  const queueRows = await pool.query<{ status: string; c: string }>(
    `SELECT status, COUNT(*)::text AS c
     FROM experiment_judge_calibration_items
     WHERE experiment_id = $1::uuid
     GROUP BY status`,
    [params.experimentId]
  );
  const total = Number(counts.rows[0]?.total ?? 0);
  const clearTotal = Number(counts.rows[0]?.clear_total ?? 0);
  const clarifyTotal = Number(counts.rows[0]?.clarify_total ?? 0);
  const unresolvedTotal = Number(counts.rows[0]?.unresolved_total ?? 0);
  const authoringAccepted = Number(counts.rows[0]?.authoring_accepted ?? 0);
  const authoringRejected = Number(counts.rows[0]?.authoring_rejected ?? 0);
  const authoringUnresolved = Number(counts.rows[0]?.authoring_unresolved ?? 0);
  const verifierPassCount = Number(counts.rows[0]?.verifier_pass_count ?? 0);
  const verifierTotal = Number(counts.rows[0]?.verifier_total ?? 0);
  const approvedClear = Number(counts.rows[0]?.approved_clear ?? 0);
  const approvedClarify = Number(counts.rows[0]?.approved_clarify ?? 0);
  const pendingOwner = Number(counts.rows[0]?.pending_owner ?? 0);
  const rejectedTotal = Number(counts.rows[0]?.rejected_total ?? 0);
  const lockEligible = Number(counts.rows[0]?.lock_eligible ?? 0);
  const calibrationEligible = Number(counts.rows[0]?.calibration_eligible ?? 0);
  const queueMap = new Map(queueRows.rows.map((row) => [row.status, Number(row.c ?? 0)]));
  const pendingCalibration = Number(queueMap.get("pending") ?? 0);
  const labeledCalibration = Number(queueMap.get("labeled") ?? 0);
  const skippedCalibration = Number(queueMap.get("skipped") ?? 0);

  const clearPassRate = clearTotal > 0 ? approvedClear / clearTotal : 1;
  const clarifyPassRate = clarifyTotal > 0 ? approvedClarify / clarifyTotal : 1;
  const unresolvedAmbiguousRatio = total > 0 ? unresolvedTotal / total : 0;
  const verifierPassRate = verifierTotal > 0 ? verifierPassCount / verifierTotal : 0;

  const clearGatePass = clearPassRate >= 0.99;
  const clarifyGatePass = clarifyPassRate >= 0.99;
  const debtGatePass = unresolvedAmbiguousRatio <= 0.01;
  const noPendingOwnerPass = pendingOwner === 0;
  const noPendingCalibrationPass = pendingCalibration === 0;
  const readyForLock = clearGatePass
    && clarifyGatePass
    && debtGatePass
    && noPendingOwnerPass
    && noPendingCalibrationPass;
  const activeLockVersion = String(experiment.active_benchmark_lock_version ?? "").trim() || null;
  const readyForStart = Boolean(activeLockVersion) && readyForLock;
  const supportRows = taxonomyVersion
    ? await loadTaxonomySupportRows(taxonomyVersion.id, experiment.chat_namespace)
    : [];
  const candidateBacklogRow = taxonomyVersion
    ? await pool.query<{ c: string }>(
      `SELECT COUNT(*)::text AS c
       FROM taxonomy_candidate_reviews
       WHERE taxonomy_version_id = $1::uuid
         AND status = 'pending'`,
      [taxonomyVersion.id]
    )
    : { rows: [] as Array<{ c: string }> };
  const freshness = await experimentBenchmarkFreshness({ experimentId: params.experimentId });
  const supportCoverageRatio = supportRows.length > 0
    ? supportRows.filter((row) => row.supportStatus === "supported").length / supportRows.length
    : null;

  return {
    ok: true,
    experimentId: params.experimentId,
    activeLockVersion,
    taxonomy: {
      versionId: experiment.taxonomy_version_id ?? null,
      versionKey: taxonomyVersion?.versionKey ?? null,
      scanCompletedAt: taxonomyVersion?.scanCompletedAt ?? null,
      supportCoverageRatio,
      candidateBacklog: Number(candidateBacklogRow.rows[0]?.c ?? 0),
      benchmarkStale: freshness.benchmarkStale
    },
    queueCounts: {
      pending: pendingCalibration,
      labeled: labeledCalibration,
      skipped: skippedCalibration
    },
    datasetCounts: {
      total,
      clear: clearTotal,
      clarifyRequired: clarifyTotal,
      unresolved: unresolvedTotal
    },
    ambiguityCounts: {
      clear: clearTotal,
      clarifyRequired: clarifyTotal,
      unresolved: unresolvedTotal
    },
    authoringCounts: {
      accepted: authoringAccepted,
      rejected: authoringRejected,
      unresolved: authoringUnresolved
    },
    lockEligibilityCounts: {
      approvedClear,
      approvedClarifyRequired: approvedClarify,
      pendingOwner,
      rejected: rejectedTotal,
      eligibleForScoring: lockEligible,
      calibrationEligible
    },
    metrics: {
      clearPassRate,
      clarifyPassRate,
      unresolvedAmbiguousRatio,
      verifierPassRate
    },
    gates: {
      clearPassTarget: 0.99,
      clarifyPassTarget: 0.99,
      unresolvedDebtMax: 0.01,
      clearGatePass,
      clarifyGatePass,
      debtGatePass,
      noPendingOwnerPass,
      noPendingCalibrationPass,
      readyForLock,
      readyForStart
    }
  };
}

export async function experimentLeaderboard(experimentId?: string): Promise<Record<string, unknown>> {
  const expId = experimentId
    ?? (await pool.query<{ id: string }>(
      `SELECT id::text
       FROM experiment_runs
       ORDER BY created_at DESC
       LIMIT 1`
    )).rows[0]?.id;
  if (!expId) return { ok: true, experimentId: null, leaderboard: [] };

  const rows = await pool.query<{
    strategy_id: string;
    variant_id: string;
    decision: string;
    pass_rate: string;
    p95_latency_ms: string;
    estimated_cost_per_1k: string;
    reason: string;
    created_at: string;
  }>(
    `SELECT
       strategy_id,
       variant_id,
       decision,
       pass_rate::text,
       p95_latency_ms::text,
       estimated_cost_per_1k::text,
       reason,
       created_at::text
     FROM experiment_winner_decisions
     WHERE experiment_id = $1::uuid
     ORDER BY
       CASE decision WHEN 'winner' THEN 0 WHEN 'candidate' THEN 1 ELSE 2 END,
       pass_rate DESC,
       p95_latency_ms ASC,
       estimated_cost_per_1k ASC,
       created_at DESC`,
    [expId]
  );
  return {
    ok: true,
    experimentId: expId,
    leaderboard: rows.rows.map((r) => ({
      ...r,
      pass_rate: Number(r.pass_rate ?? 0),
      p95_latency_ms: Number(r.p95_latency_ms ?? 0),
      estimated_cost_per_1k: Number(r.estimated_cost_per_1k ?? 0)
    }))
  };
}

export async function experimentFailures(params: {
  experimentId: string;
  variantId?: string;
  limit?: number;
}): Promise<Record<string, unknown>> {
  const limit = Number.isFinite(Number(params.limit)) ? Math.max(1, Math.min(5000, Number(params.limit))) : 500;
  const rows = await pool.query<{
    variant_id: string;
    strategy_id: string;
    bucket: string;
    details: Record<string, unknown>;
    created_at: string;
  }>(
    `SELECT
       s.variant_id,
       s.strategy_id,
       f.bucket,
       f.details,
       f.created_at::text
     FROM experiment_failures f
     JOIN experiment_strategies s ON s.id = f.strategy_variant_id
     WHERE f.experiment_id = $1::uuid
       AND ($2::text IS NULL OR s.variant_id = $2::text)
     ORDER BY f.created_at DESC
     LIMIT $3`,
    [params.experimentId, params.variantId ?? null, limit]
  );
  const bucketRows = await pool.query<{ bucket: string; c: string }>(
    `SELECT f.bucket, COUNT(*)::text AS c
     FROM experiment_failures f
     JOIN experiment_strategies s ON s.id = f.strategy_variant_id
     WHERE f.experiment_id = $1::uuid
       AND ($2::text IS NULL OR s.variant_id = $2::text)
     GROUP BY f.bucket
     ORDER BY COUNT(*) DESC`,
    [params.experimentId, params.variantId ?? null]
  );
  return {
    ok: true,
    experimentId: params.experimentId,
    variantId: params.variantId ?? null,
    buckets: bucketRows.rows.map((r) => ({ bucket: r.bucket, count: Number(r.c ?? 0) })),
    failures: rows.rows
  };
}

export async function experimentComponentLeaderboard(params: {
  experimentId: string;
  limit?: number;
}): Promise<Record<string, unknown>> {
  const limit = Number.isFinite(Number(params.limit)) ? Math.max(1, Math.min(1000, Number(params.limit))) : 250;
  const rows = await pool.query<{
    component_id: string;
    component_type: string;
    component_name: string;
    runs: string;
    pass_rate: string;
    avg_score: string;
    recall_at_k: string;
    mrr: string;
    ndcg: string;
    evidence_hit_rate: string;
    confidence: string;
    stability_score: string | null;
    stability_confidence: string | null;
  }>(
    `SELECT
       cp.component_id::text AS component_id,
       cr.component_type,
       cr.component_name,
       SUM(cp.runs)::text AS runs,
       AVG(cp.pass_rate)::text AS pass_rate,
       AVG(cp.avg_score)::text AS avg_score,
       AVG(cp.recall_at_k)::text AS recall_at_k,
       AVG(cp.mrr)::text AS mrr,
       AVG(cp.ndcg)::text AS ndcg,
       AVG(cp.evidence_hit_rate)::text AS evidence_hit_rate,
       AVG(cp.confidence)::text AS confidence,
       MAX(cs.component_stability_score)::text AS stability_score,
       MAX(cs.confidence)::text AS stability_confidence
     FROM component_performance cp
     JOIN component_registry cr ON cr.id = cp.component_id
     LEFT JOIN component_stability cs ON cs.component_id = cp.component_id
     WHERE cp.experiment_id = $1::uuid
     GROUP BY cp.component_id, cr.component_type, cr.component_name
     ORDER BY AVG(cp.avg_score) DESC, SUM(cp.runs) DESC
     LIMIT $2`,
    [params.experimentId, limit]
  );
  return {
    ok: true,
    experimentId: params.experimentId,
    leaderboard: rows.rows.map((r) => ({
      componentId: r.component_id,
      componentType: r.component_type,
      componentName: r.component_name,
      runs: Number(r.runs ?? 0),
      passRate: Number(r.pass_rate ?? 0),
      avgScore: Number(r.avg_score ?? 0),
      recallAtK: Number(r.recall_at_k ?? 0),
      mrr: Number(r.mrr ?? 0),
      ndcg: Number(r.ndcg ?? 0),
      evidenceHitRate: Number(r.evidence_hit_rate ?? 0),
      confidence: Number(r.confidence ?? 0),
      stabilityScore: Number(r.stability_score ?? 0),
      stabilityConfidence: Number(r.stability_confidence ?? 0)
    }))
  };
}

export async function experimentComponentStability(params: {
  experimentId: string;
  limit?: number;
}): Promise<Record<string, unknown>> {
  const limit = Number.isFinite(Number(params.limit)) ? Math.max(1, Math.min(1000, Number(params.limit))) : 250;
  const rows = await pool.query<{
    component_id: string;
    component_type: string;
    component_name: string;
    runs: string;
    pass_rate_stddev: string;
    component_stability_score: string;
    confidence: string;
  }>(
    `SELECT
       cs.component_id::text AS component_id,
       cr.component_type,
       cr.component_name,
       cs.runs::text,
       cs.pass_rate_stddev::text,
       cs.component_stability_score::text,
       cs.confidence::text
     FROM component_stability cs
     JOIN component_registry cr ON cr.id = cs.component_id
     WHERE EXISTS (
       SELECT 1
       FROM strategy_component_bindings b
       WHERE b.component_id = cs.component_id
         AND b.experiment_id = $1::uuid
     )
     ORDER BY cs.component_stability_score DESC, cs.runs DESC
     LIMIT $2`,
    [params.experimentId, limit]
  );
  return {
    ok: true,
    experimentId: params.experimentId,
    components: rows.rows.map((r) => ({
      componentId: r.component_id,
      componentType: r.component_type,
      componentName: r.component_name,
      runs: Number(r.runs ?? 0),
      passRateStddev: Number(r.pass_rate_stddev ?? 0),
      componentStabilityScore: Number(r.component_stability_score ?? 0),
      confidence: Number(r.confidence ?? 0)
    }))
  };
}

export async function experimentHypotheses(params: {
  experimentId: string;
  limit?: number;
}): Promise<Record<string, unknown>> {
  const limit = Number.isFinite(Number(params.limit)) ? Math.max(1, Math.min(1000, Number(params.limit))) : 500;
  const rows = await pool.query<{
    id: string;
    title: string;
    confidence: string;
    status: "open" | "confirmed" | "partially_confirmed" | "rejected";
    created_at: string;
    updated_at: string;
    last_decision: string | null;
    updates_count: string;
  }>(
    `SELECT
       h.id::text,
       h.title,
       h.confidence::text,
       h.status,
       h.created_at::text,
       h.updated_at::text,
       (SELECT hu.decision
          FROM hypothesis_updates hu
         WHERE hu.hypothesis_id = h.id
         ORDER BY hu.created_at DESC
         LIMIT 1) AS last_decision,
       (SELECT COUNT(*)::text
          FROM hypothesis_updates hu
         WHERE hu.hypothesis_id = h.id) AS updates_count
     FROM hypotheses h
     WHERE h.experiment_id = $1::uuid
     ORDER BY h.updated_at DESC
     LIMIT $2`,
    [params.experimentId, limit]
  );
  return {
    ok: true,
    experimentId: params.experimentId,
    hypotheses: rows.rows.map((r) => ({
      hypothesisId: r.id,
      title: r.title,
      confidence: Number(r.confidence ?? 0),
      status: r.status,
      lastDecision: r.last_decision,
      updatesCount: Number(r.updates_count ?? 0),
      createdAt: r.created_at,
      updatedAt: r.updated_at
    }))
  };
}

export async function experimentHypothesisDetail(params: {
  experimentId: string;
  hypothesisId: string;
}): Promise<Record<string, unknown>> {
  const row = await pool.query<{
    id: string;
    title: string;
    failure_pattern: Record<string, unknown>;
    causal_claim: string;
    predicted_metric_changes: Record<string, unknown>;
    confidence: string;
    status: "open" | "confirmed" | "partially_confirmed" | "rejected";
    metadata: Record<string, unknown>;
    created_at: string;
    updated_at: string;
  }>(
    `SELECT
       id::text,
       title,
       failure_pattern,
       causal_claim,
       predicted_metric_changes,
       confidence::text,
       status,
       metadata,
       created_at::text,
       updated_at::text
     FROM hypotheses
     WHERE experiment_id = $1::uuid
       AND id = $2::uuid
     LIMIT 1`,
    [params.experimentId, params.hypothesisId]
  );
  if (row.rows.length === 0) {
    return { ok: false, error: "hypothesis_not_found", experimentId: params.experimentId, hypothesisId: params.hypothesisId };
  }
  const predictions = await pool.query<{
    id: string;
    metric_key: string;
    comparator: string;
    target_value: string;
    weight: string;
  }>(
    `SELECT id::text, metric_key, comparator, target_value::text, weight::text
     FROM hypothesis_predictions
     WHERE hypothesis_id = $1::uuid
     ORDER BY created_at ASC`,
    [params.hypothesisId]
  );
  const updates = await pool.query<{
    id: string;
    strategy_variant_id: string;
    decision: string;
    confidence_before: string;
    confidence_after: string;
    metric_deltas: Record<string, unknown>;
    rationale: string;
    created_at: string;
  }>(
    `SELECT
       id::text,
       strategy_variant_id::text,
       decision,
       confidence_before::text,
       confidence_after::text,
       metric_deltas,
       rationale,
       created_at::text
     FROM hypothesis_updates
     WHERE hypothesis_id = $1::uuid
     ORDER BY created_at DESC
     LIMIT 200`,
    [params.hypothesisId]
  );
  const links = await pool.query<{
    strategy_variant_id: string;
    strategy_id: string;
    variant_id: string;
    experiment_role: string;
    notes: string | null;
    created_at: string;
  }>(
    `SELECT
       he.strategy_variant_id::text,
       s.strategy_id,
       s.variant_id,
       he.experiment_role,
       he.notes,
       he.created_at::text
     FROM hypothesis_experiments he
     JOIN experiment_strategies s ON s.id = he.strategy_variant_id
     WHERE he.hypothesis_id = $1::uuid
     ORDER BY he.created_at DESC`,
    [params.hypothesisId]
  );
  const hypothesis = row.rows[0];
  return {
    ok: true,
    experimentId: params.experimentId,
    hypothesis: {
      hypothesisId: hypothesis.id,
      title: hypothesis.title,
      failurePattern: hypothesis.failure_pattern,
      causalClaim: hypothesis.causal_claim,
      predictedMetricChanges: hypothesis.predicted_metric_changes,
      confidence: Number(hypothesis.confidence ?? 0),
      status: hypothesis.status,
      metadata: hypothesis.metadata,
      createdAt: hypothesis.created_at,
      updatedAt: hypothesis.updated_at
    },
    predictions: predictions.rows.map((p) => ({
      predictionId: p.id,
      metricKey: p.metric_key,
      comparator: p.comparator,
      targetValue: Number(p.target_value ?? 0),
      weight: Number(p.weight ?? 0)
    })),
    updates: updates.rows.map((u) => ({
      updateId: u.id,
      strategyVariantId: u.strategy_variant_id,
      decision: u.decision,
      confidenceBefore: Number(u.confidence_before ?? 0),
      confidenceAfter: Number(u.confidence_after ?? 0),
      metricDeltas: u.metric_deltas,
      rationale: u.rationale,
      createdAt: u.created_at
    })),
    strategyLinks: links.rows
  };
}

export async function generateExperimentHypotheses(params: {
  experimentId: string;
  count?: number;
}): Promise<Record<string, unknown>> {
  const count = Number.isFinite(Number(params.count)) ? Math.max(1, Math.min(20, Number(params.count))) : 5;
  const failures = await pool.query<{ bucket: string; c: string }>(
    `SELECT bucket, COUNT(*)::text AS c
     FROM experiment_failures
     WHERE experiment_id = $1::uuid
     GROUP BY bucket
     ORDER BY COUNT(*) DESC
     LIMIT $2`,
    [params.experimentId, count]
  );
  const created: string[] = [];
  for (const row of failures.rows) {
    const title = `Hypothesis from failure bucket: ${row.bucket}`;
    const pattern = {
      primaryBucket: row.bucket,
      observedCount: Number(row.c ?? 0)
    };
    const metricTargets: Record<string, number> = {
      pass_rate_delta_gte: 0.02,
      recall_at_k_delta_gte: row.bucket === "retrieval_miss" ? 0.03 : 0.01,
      ndcg_delta_gte: row.bucket === "ranking_failure" ? 0.03 : 0.01
    };
    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO hypotheses (
         experiment_id, title, failure_pattern, causal_claim, predicted_metric_changes, confidence, status, metadata
       ) VALUES (
         $1::uuid, $2, $3::jsonb, $4, $5::jsonb, 0.50, 'open', $6::jsonb
       )
       RETURNING id::text AS id`,
      [
        params.experimentId,
        title,
        JSON.stringify(pattern),
        "Improving strategy components addressing this failure bucket should improve benchmark outcomes.",
        JSON.stringify(metricTargets),
        JSON.stringify({ generatedBy: "hypothesis_generate_endpoint" })
      ]
    );
    const hypothesisId = inserted.rows[0].id;
    created.push(hypothesisId);
    await pool.query(
      `INSERT INTO hypothesis_predictions (hypothesis_id, metric_key, comparator, target_value, weight)
       VALUES
       ($1::uuid, 'pass_rate', 'delta_gte', 0.02, 1.0),
       ($1::uuid, 'recall_at_k', 'delta_gte', 0.01, 0.7),
       ($1::uuid, 'ndcg', 'delta_gte', 0.01, 0.7)`,
      [hypothesisId]
    );
  }
  return {
    ok: true,
    experimentId: params.experimentId,
    createdCount: created.length,
    hypothesisIds: created
  };
}

export async function evaluateExperimentHypotheses(params: {
  experimentId: string;
  hypothesisId?: string;
}): Promise<Record<string, unknown>> {
  const rows = await pool.query<{
    id: string;
    strategy_id: string;
    variant_id: string;
    label: string;
    position: string;
    status: "queued" | "running" | "completed" | "failed" | "skipped";
    hypothesis_id: string | null;
    experiment_role: ExperimentRole | null;
    config: Record<string, unknown>;
    metrics: Record<string, unknown>;
  }>(
    `SELECT
       id::text,
       strategy_id,
       variant_id,
       label,
       position::text,
       status,
       hypothesis_id::text,
       experiment_role,
       config,
       metrics
     FROM experiment_strategies
     WHERE experiment_id = $1::uuid
       AND status IN ('completed', 'failed')
       AND ($2::uuid IS NULL OR hypothesis_id = $2::uuid)
     ORDER BY finished_at DESC NULLS LAST, position DESC`,
    [params.experimentId, params.hypothesisId ?? null]
  );
  const byHypothesis = new Map<string, StrategyRow>();
  for (const row of rows.rows) {
    const hypothesisId = String(row.hypothesis_id ?? "").trim();
    if (!hypothesisId) continue;
    if (!byHypothesis.has(hypothesisId)) {
      byHypothesis.set(hypothesisId, {
        id: row.id,
        strategy_id: row.strategy_id,
        variant_id: row.variant_id,
        label: row.label,
        position: Number(row.position ?? 0),
        status: row.status,
        hypothesis_id: row.hypothesis_id,
        experiment_role: row.experiment_role ?? undefined,
        config: ((row.config as unknown as StrategyVariantConfig) ?? { strategyId: row.strategy_id }),
        metrics: row.metrics ?? {}
      });
    }
  }
  const updates: HypothesisEvaluation[] = [];
  for (const strategy of byHypothesis.values()) {
    const m = strategy.metrics as Record<string, unknown>;
    const scorecard: EvaluationScorecard = {
      strategyId: strategy.strategy_id,
      variantId: strategy.variant_id,
      caseSet: String(m.caseSet ?? "all"),
      totalCases: Number(m.totalCases ?? 0),
      passedCases: Number(m.passedCases ?? 0),
      failedCases: Number(m.failedCases ?? 0),
      passRate: Number(m.passRate ?? 0),
      p95LatencyMs: Number(m.p95LatencyMs ?? 0),
      avgLatencyMs: Number(m.avgLatencyMs ?? 0),
      estimatedCostPer1kAsks: Number(m.estimatedCostPer1kAsks ?? 0),
      recallAtK: Number(m.recallAtK ?? 0),
      mrr: Number(m.mrr ?? 0),
      ndcg: Number(m.ndcg ?? 0),
      evidenceHitRate: Number(m.evidenceHitRate ?? 0),
      governanceLeakageCount: Number(m.governanceLeakageCount ?? 0),
      failureBreakdown: parseFailureBreakdown(m.failureBreakdown ?? {})
    };
    const update = await evaluateAndUpdateHypothesis({
      experimentId: params.experimentId,
      strategy,
      scorecard
    });
    if (update) updates.push(update);
  }
  return {
    ok: true,
    experimentId: params.experimentId,
    evaluatedCount: updates.length,
    updates
  };
}

export async function recomposeExperimentStrategies(params: {
  experimentId: string;
  count?: number;
}): Promise<Record<string, unknown>> {
  const count = Number.isFinite(Number(params.count)) ? Math.max(1, Math.min(20, Number(params.count))) : 6;
  const strategies = await loadExperimentStrategies(params.experimentId);
  const maxGroup = strategies.reduce(
    (acc, row) => Math.max(acc, inferGroupId(row.strategy_id, row.config as unknown as Record<string, unknown>)),
    1
  );
  let maxStrategyNum = strategies.reduce((acc, row) => Math.max(acc, parseStrategyNumber(row.strategy_id)), 15);
  let position = strategies.reduce((acc, row) => Math.max(acc, Number(row.position ?? 0)), -1);
  const nextGroup = maxGroup + 1;
  const componentRows = await pool.query<{
    component_type: string;
    config: Record<string, unknown>;
    avg_score: string;
    stability_score: string | null;
  }>(
    `SELECT
       cr.component_type,
       cr.config,
       AVG(cp.avg_score)::text AS avg_score,
       MAX(cs.component_stability_score)::text AS stability_score
     FROM component_performance cp
     JOIN component_registry cr ON cr.id = cp.component_id
     LEFT JOIN component_stability cs ON cs.component_id = cp.component_id
     WHERE cp.experiment_id = $1::uuid
       AND cr.status = 'active'
     GROUP BY cr.component_type, cr.config
     ORDER BY AVG(cp.avg_score) DESC, MAX(cs.component_stability_score) DESC NULLS LAST`,
    [params.experimentId]
  );
  const topByType = new Map<string, Record<string, unknown>>();
  for (const row of componentRows.rows) {
    if (!topByType.has(row.component_type)) {
      topByType.set(row.component_type, row.config ?? {});
    }
  }

  const created: Array<{ strategyId: string; variantId: string }> = [];
  for (let i = 0; i < count; i += 1) {
    maxStrategyNum += 1;
    position += 1;
    const strategyId = `S${maxStrategyNum}`;
    const variantId = `${strategyId}.v1`;
    const role = normalizeExperimentRole(i, count);
    const config: StrategyVariantConfig = {
      strategyId,
      retrievalMode: String((topByType.get("retrieval_policy") ?? {})["retrievalMode"] ?? "hybrid_rerank") as StrategyVariantConfig["retrievalMode"],
      contextMode: String((topByType.get("context_policy") ?? {})["contextMode"] ?? "adaptive") as StrategyVariantConfig["contextMode"],
      plannerMode: String((topByType.get("query_policy") ?? {})["plannerMode"] ?? "single_agent_sequential") as StrategyVariantConfig["plannerMode"],
      composerMode: String((topByType.get("synthesis_policy") ?? {})["composerMode"] ?? "minimal_llm") as StrategyVariantConfig["composerMode"],
      refinementMode: String((topByType.get("query_policy") ?? {})["refinementMode"] ?? "adaptive") as StrategyVariantConfig["refinementMode"],
      maxLoops: Math.max(1, Math.min(3, Number((topByType.get("context_policy") ?? {})["maxLoops"] ?? 3))),
      groupId: nextGroup,
      generatedBy: "component_recompose",
      lineageReason: "component_recomposition",
      modifiedComponents: ["query_policy", "retrieval_policy", "ranking_policy", "context_policy", "synthesis_policy"],
      experimentRole: role
    };
    await insertQueuedStrategyVariant({
      experimentId: params.experimentId,
      strategyId,
      variantId,
      label: `Recomposed strategy ${strategyId}`,
      position,
      config,
      role,
      lineageReason: "component_recomposition",
      modifiedComponents: config.modifiedComponents ?? [],
      notes: "component_recompose_binding"
    });
    created.push({ strategyId, variantId });
  }

  return {
    ok: true,
    experimentId: params.experimentId,
    createdCount: created.length,
    nextGroup,
    strategies: created
  };
}

export async function experimentLineage(params: {
  experimentId: string;
}): Promise<Record<string, unknown>> {
  const rows = await pool.query<{
    strategy_variant_id: string;
    strategy_id: string;
    variant_id: string;
    parent_strategy_variant_id: string | null;
    parent_hypothesis_id: string | null;
    modified_components: string[] | null;
    lineage_reason: string | null;
    created_at: string;
  }>(
    `SELECT
       id::text AS strategy_variant_id,
       strategy_id,
       variant_id,
       parent_strategy_variant_id::text,
       parent_hypothesis_id::text,
       modified_components,
       lineage_reason,
       created_at::text
     FROM experiment_strategies
     WHERE experiment_id = $1::uuid
     ORDER BY position ASC`,
    [params.experimentId]
  );
  return {
    ok: true,
    experimentId: params.experimentId,
    lineage: rows.rows.map((r) => ({
      strategyVariantId: r.strategy_variant_id,
      strategyId: r.strategy_id,
      variantId: r.variant_id,
      parentStrategyVariantId: r.parent_strategy_variant_id,
      parentHypothesisId: r.parent_hypothesis_id,
      modifiedComponents: Array.isArray(r.modified_components) ? r.modified_components : [],
      lineageReason: r.lineage_reason,
      createdAt: r.created_at
    }))
  };
}

export async function experimentGovernanceLeakage(params: {
  experimentId: string;
  limit?: number;
}): Promise<Record<string, unknown>> {
  const limit = Number.isFinite(Number(params.limit)) ? Math.max(1, Math.min(2000, Number(params.limit))) : 500;
  const rows = await pool.query<{
    id: string;
    strategy_variant_id: string | null;
    event_type: string;
    severity: string;
    details: Record<string, unknown>;
    created_at: string;
  }>(
    `SELECT
       id::text,
       strategy_variant_id::text,
       event_type,
       severity,
       details,
       created_at::text
     FROM experiment_governance_events
     WHERE experiment_id = $1::uuid
       AND (
         event_type ILIKE '%leakage%'
         OR (details::text ILIKE '%benchmark%' AND details::text ILIKE '%question%')
       )
     ORDER BY created_at DESC
     LIMIT $2`,
    [params.experimentId, limit]
  );
  return {
    ok: true,
    experimentId: params.experimentId,
    count: rows.rows.length,
    events: rows.rows
  };
}

export async function createJudgeCalibrationSample(params: {
  experimentId: string;
  count?: number;
  caseSet?: "dev" | "critical" | "certification" | "stress" | "coverage";
  variantId?: string;
  domain?: string;
}): Promise<Record<string, unknown>> {
  const count = Number.isFinite(Number(params.count)) ? Math.max(1, Math.min(200, Number(params.count))) : 20;
  let strategyVariantDbId: string | null = null;
  if (params.variantId) {
    const variantRow = await pool.query<{ id: string }>(
      `SELECT id::text
       FROM experiment_strategies
       WHERE experiment_id = $1::uuid
         AND variant_id = $2::text
       LIMIT 1`,
      [params.experimentId, params.variantId]
    );
    strategyVariantDbId = variantRow.rows[0]?.id ?? null;
  }

  const candidates = await pool.query<{
    case_id: string;
    case_set: string;
    domain: string;
    lens: string;
    ambiguity_class: string;
    question: string;
    expected_core_claims: string[] | string;
    evidence_ids: string[] | string;
    metadata: Record<string, unknown>;
    score: string | null;
  }>(
    `SELECT
       c.id::text AS case_id,
       c.case_set,
       c.domain,
       c.lens,
       c.ambiguity_class,
       c.question,
       COALESCE(c.expected_core_claims::text, '[]') AS expected_core_claims,
       COALESCE(c.evidence_ids::text, '{}') AS evidence_ids,
       c.metadata,
       cr.score::text AS score
     FROM experiment_cases c
     LEFT JOIN experiment_case_results cr
       ON cr.case_id = c.id
      AND ($4::uuid IS NOT NULL AND cr.strategy_variant_id = $4::uuid)
     WHERE c.experiment_id = $1::uuid
       AND c.is_stale = false
       AND ($2::text IS NULL OR c.case_set = $2::text)
       AND ($5::text IS NULL OR c.domain = $5::text)
       AND c.ambiguity_class IN ('clear', 'clarify_required')
       AND COALESCE((c.metadata->'admissionDecision'->>'admitted')::boolean, false) = true
       AND COALESCE(c.metadata->'qualityGate'->>'status', 'fail') = 'pass'
       AND c.owner_validation_state = 'pending'
       AND NOT EXISTS (
         SELECT 1
         FROM experiment_judge_calibration_items i
         WHERE i.experiment_id = $1::uuid
           AND i.case_id = c.id
       )
     ORDER BY
       CASE
         WHEN cr.score IS NULL THEN 1.0
         ELSE ABS(cr.score - 0.5)
       END ASC,
       c.created_at DESC
     LIMIT $3`,
    [params.experimentId, params.caseSet ?? null, count, strategyVariantDbId, params.domain ?? null]
  );

  const inserted: Array<Record<string, unknown>> = [];
  for (const row of candidates.rows) {
    const expectedCoreClaims = Array.isArray(row.expected_core_claims)
      ? row.expected_core_claims.map(String)
      : parseJsonArray(String(row.expected_core_claims ?? "[]"));
    const expectedEvidenceIds = Array.isArray(row.evidence_ids)
      ? row.evidence_ids.map(String)
      : parsePgTextArray(String(row.evidence_ids ?? "{}"));
    const ambiguityClass = String(row.ambiguity_class || "clear");
    const expectedBehavior = String((row.metadata ?? {}).expectedBehavior ?? "").trim() === "clarify_first"
      ? "clarify_first"
      : "answer_now";
    const expectedAnswer = {
      expectedBehavior,
      expectedAnswerSummaryHuman: String((row.metadata ?? {}).expectedAnswerSummaryHuman ?? "").trim()
        || buildHumanAnswerSummary({
          domain: row.domain,
          lens: row.lens,
          expectedBehavior,
          expectedCoreClaims
        }),
      qualityGate: readCaseQualityGate(row.metadata ?? {}),
      ambiguityClass: ambiguityClass || (expectedBehavior === "clarify_first" ? "clarify_required" : "clear"),
      semanticFrameSummary: readSemanticFrameSummary(row.metadata ?? {}),
      clarificationQuestion: readClarificationQuestion(row.metadata ?? {}),
      resolvedQuestionAfterClarification: readResolvedQuestionAfterClarification(row.metadata ?? {}),
      admissionDecision: readAdmissionDecision(row.metadata ?? {}),
      feasibilityReport: readFeasibilityReport(row.metadata ?? {}),
      scoreHint: Number(row.score ?? 0)
    };
    const created = await pool.query<{ id: string }>(
      `INSERT INTO experiment_judge_calibration_items (
         experiment_id, case_id, strategy_variant_id, question, expected_answer, expected_evidence_ids, sample_type, status
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4, $5::jsonb, $6::uuid[], 'benchmark_case', 'pending'
       )
       RETURNING id::text`,
      [params.experimentId, row.case_id, strategyVariantDbId, row.question, JSON.stringify(expectedAnswer), expectedEvidenceIds]
    );
    inserted.push({
      calibrationItemId: created.rows[0].id,
      caseId: row.case_id,
      caseSet: row.case_set,
      domain: row.domain,
      lens: row.lens,
      question: row.question,
      expectedAnswer,
      expectedEvidenceIds
    });
  }

  return {
    ok: true,
    experimentId: params.experimentId,
    variantId: params.variantId ?? null,
    requested: count,
    created: inserted.length,
    items: inserted
  };
}

export async function listJudgeCalibrationPending(params: {
  experimentId: string;
  limit?: number;
}): Promise<Record<string, unknown>> {
  const limit = Number.isFinite(Number(params.limit)) ? Math.max(1, Math.min(500, Number(params.limit))) : 50;
  const rows = await pool.query<{
    id: string;
    case_id: string;
    case_set: string;
    domain: string;
    lens: string;
    question: string;
    expected_evidence_ids: string[] | string;
    metadata: Record<string, unknown>;
    ambiguity_class: string | null;
    owner_validation_state: string | null;
    created_at: string;
  }>(
    `SELECT
       i.id::text,
       c.id::text AS case_id,
       c.case_set,
       c.domain,
       c.lens,
       i.question,
       COALESCE(i.expected_evidence_ids::text, '{}') AS expected_evidence_ids,
       c.metadata,
       c.ambiguity_class,
       c.owner_validation_state,
       i.created_at::text
     FROM experiment_judge_calibration_items i
     JOIN experiment_cases c ON c.id = i.case_id
     WHERE i.experiment_id = $1::uuid
       AND i.status = 'pending'
     ORDER BY i.created_at ASC
     LIMIT $2`,
    [params.experimentId, limit]
  );
  const evidenceIds = rows.rows.flatMap((row) => (
    Array.isArray(row.expected_evidence_ids)
      ? row.expected_evidence_ids.map(String)
      : parsePgTextArray(String(row.expected_evidence_ids ?? "{}"))
  ));
  const evidenceMap = await loadEvidencePreviewMap(evidenceIds);
  return {
    ok: true,
    experimentId: params.experimentId,
    pending: rows.rows.map((r) => ({
      metadata: r.metadata ?? {},
      calibrationItemId: r.id,
      caseId: r.case_id,
      domain: r.domain,
      lens: r.lens,
      caseSet: r.case_set,
      question: r.question,
      expectedBehavior: String((r.metadata ?? {}).expectedBehavior ?? "").trim() === "clarify_first"
        ? "clarify_first"
        : "answer_now",
      semanticFrame: readSemanticFrame(r.metadata ?? {}),
      semanticFrameSummary: readSemanticFrameSummary(r.metadata ?? {}),
      clarificationQuestion: readClarificationQuestion(r.metadata ?? {}),
      resolvedQuestionAfterClarification: readResolvedQuestionAfterClarification(r.metadata ?? {}),
      expectedAnswerSummaryHuman: String((r.metadata ?? {}).expectedAnswerSummaryHuman ?? "").trim()
        || "Review whether the generated question naturally points to the evidence below.",
      authoringCritique: readAuthoringCritique(r.metadata ?? {}),
      feasibilityReport: readFeasibilityReport(r.metadata ?? {}),
      admissionDecision: readAdmissionDecision(r.metadata ?? {}),
      evidencePreview: (Array.isArray(r.expected_evidence_ids)
        ? r.expected_evidence_ids.map(String)
        : parsePgTextArray(String(r.expected_evidence_ids ?? "{}")))
        .map((id) => evidenceMap.get(id))
        .filter((item): item is {
          evidenceId: string;
          actorName: string | null;
          observedAt: string | null;
          sourceSystem: string;
          snippet: string;
        } => Boolean(item))
        .slice(0, 4),
      qualityGate: readCaseQualityGate(r.metadata ?? {}),
      ambiguityClass: (r.ambiguity_class ?? "clear") as "clear" | "clarify_required" | "unresolved",
      ownerValidationState: (r.owner_validation_state ?? "pending") as "pending" | "approved" | "rejected" | "not_required",
      createdAt: r.created_at
    }))
  };
}

export async function submitJudgeCalibrationLabel(params: {
  calibrationItemId: string;
  verdict: "yes" | "no";
  ambiguityClass?: "clear" | "clarify_required" | "unresolved";
  reviewer?: string;
  notes?: string;
}): Promise<Record<string, unknown>> {
  const reviewer = String(params.reviewer ?? "owner").trim() || "owner";
  const verdict = params.verdict === "yes" ? "yes" : "no";
  await pool.query(
    `INSERT INTO experiment_judge_calibration_labels (
       calibration_item_id, reviewer, verdict, notes
     ) VALUES (
       $1::uuid, $2, $3, $4
     )
     ON CONFLICT (calibration_item_id, reviewer)
     DO UPDATE SET
       verdict = EXCLUDED.verdict,
       notes = EXCLUDED.notes,
       created_at = now()`,
    [params.calibrationItemId, reviewer, verdict, params.notes ?? null]
  );
  await pool.query(
    `UPDATE experiment_judge_calibration_items
     SET status = 'labeled',
         updated_at = now()
     WHERE id = $1::uuid`,
    [params.calibrationItemId]
  );
  const item = await pool.query<{ case_id: string | null }>(
    `SELECT case_id::text
     FROM experiment_judge_calibration_items
     WHERE id = $1::uuid
     LIMIT 1`,
    [params.calibrationItemId]
  );
  const caseId = item.rows[0]?.case_id ?? null;
  if (caseId) {
    const ambiguityClass = params.ambiguityClass;
    await pool.query(
      `UPDATE experiment_cases
          SET ambiguity_class = COALESCE($2::text, ambiguity_class),
              owner_validation_state = $3,
              clarification_quality_expected = CASE
                WHEN $2::text = 'clarify_required' THEN true
                WHEN $2::text IN ('clear', 'unresolved') THEN false
                ELSE clarification_quality_expected
              END,
              benchmark_lock_version = NULL,
              eligible_for_scoring = false,
              updated_at = now()
        WHERE id = $1::uuid`,
      [caseId, ambiguityClass ?? null, verdict === "yes" ? "approved" : "rejected"]
    );
  }
  return {
    ok: true,
    calibrationItemId: params.calibrationItemId,
    reviewer,
    verdict,
    ambiguityClass: params.ambiguityClass ?? null
  };
}

export async function judgeCalibrationReport(params: {
  experimentId: string;
}): Promise<Record<string, unknown>> {
  const summary = await pool.query<{ status: string; c: string }>(
    `SELECT status, COUNT(*)::text AS c
     FROM experiment_judge_calibration_items
     WHERE experiment_id = $1::uuid
     GROUP BY status`,
    [params.experimentId]
  );
  const verdicts = await pool.query<{ verdict: string; c: string }>(
    `SELECT l.verdict, COUNT(*)::text AS c
     FROM experiment_judge_calibration_labels l
     JOIN experiment_judge_calibration_items i ON i.id = l.calibration_item_id
     WHERE i.experiment_id = $1::uuid
     GROUP BY l.verdict`,
    [params.experimentId]
  );
  const recent = await pool.query<{
    calibration_item_id: string;
    reviewer: string;
    verdict: string;
    notes: string | null;
    created_at: string;
  }>(
    `SELECT
       l.calibration_item_id::text,
       l.reviewer,
       l.verdict,
       l.notes,
       l.created_at::text
     FROM experiment_judge_calibration_labels l
     JOIN experiment_judge_calibration_items i ON i.id = l.calibration_item_id
     WHERE i.experiment_id = $1::uuid
     ORDER BY l.created_at DESC
     LIMIT 50`,
    [params.experimentId]
  );
  return {
    ok: true,
    experimentId: params.experimentId,
    statusCounts: Object.fromEntries(summary.rows.map((r) => [r.status, Number(r.c ?? 0)])),
    verdictCounts: Object.fromEntries(verdicts.rows.map((r) => [r.verdict, Number(r.c ?? 0)])),
    recentLabels: recent.rows
  };
}

export function listStrategyCatalog(): StrategyVariant[] {
  return STRATEGY_CATALOG.map((s) => ({
    ...s,
    config: { ...s.config }
  }));
}


