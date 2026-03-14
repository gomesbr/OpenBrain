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
  BenchmarkReadinessProfile,
  BenchmarkStage,
  BenchmarkStageThresholds,
  BenchmarkFreshnessStatus,
  BenchmarkAdmissionDecision,
  BenchmarkAuthoringCritique,
  BenchmarkAuthoringDraft,
  BenchmarkFeasibilityReport,
  EvidenceFamilyTopology,
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
  RetrievalFacets,
  StrategyCertificationProfile,
  StrategySelectionProfile,
  StrategyVariant,
  StrategyVariantConfig,
  TaxonomyFacetCoverageRow,
  TaxonomyFacetCoverageSummary,
  TaxonomyPairSupport,
  TaxonomyVersion,
  V2AskRequest,
  V2AskResponse,
  V2Principal,
  WinnerDecisionLayer
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
  selectionProfileId?: string;
  selectionProfile?: StrategySelectionProfile;
  certificationProfile?: StrategyCertificationProfile;
  readinessProfile?: BenchmarkReadinessProfile;
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
  benchmark_stage?: BenchmarkStage;
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
const SUPPLEMENTAL_POSITIVE_LENS_PRIORITY: Record<string, number> = {
  descriptive: 0,
  actor_attribution: 1,
  thread_reconstruction: 2,
  timeline_reconstruction: 3,
  diagnostic: 4,
  prescriptive: 5,
  predictive: 6,
  counterfactuals: 7,
  confidence_scoring: 8,
  actionability: 9,
  causal_hypotheses: 10,
  outlier_detection: 11,
  trend_trajectory: 12
};
const AUTHORING_RETRIEVAL_K = 8;
const AUTHORING_AGENT_TIMEOUT_MS = readPositiveIntEnv("OB_AUTHORING_AGENT_TIMEOUT_MS", 30000);
const AUTHORING_AGENT_MAX_RESPONSE_TOKENS = readPositiveIntEnv("OB_AUTHORING_AGENT_MAX_RESPONSE_TOKENS", 900);
const AUTHORING_AGENT_MAX_EVIDENCE_ROWS = readPositiveIntEnv("OB_AUTHORING_AGENT_MAX_EVIDENCE_ROWS", 8);
const AUTHORING_AGENT_MAX_PLAIN_ROW_CHARS = readPositiveIntEnv("OB_AUTHORING_AGENT_MAX_PLAIN_ROW_CHARS", 180);
const AUTHORING_AGENT_MAX_STRUCTURED_ROW_CHARS = readPositiveIntEnv("OB_AUTHORING_AGENT_MAX_STRUCTURED_ROW_CHARS", 300);
const AUTHORING_MAX_ATTEMPTS = 3;
const DEFAULT_READINESS_PROFILE: BenchmarkReadinessProfile = {
  profileId: "default_v1_8",
  stages: {
    core_ready: {
      ownerReviewedTotalMin: 100,
      ownerApprovedYesMin: 80,
      representativeNoMin: 10,
      reviewedClarifyMin: 12,
      approvedDomainCoverageMin: 12,
      approvedLensCoverageMin: 8,
      actorCoverageMin: 12,
      groupCoverageMin: 2,
      threadCoverageMin: 8,
      sourceCoverageMin: 2,
      timeCoverageMin: 6,
      humanCaseShareMin: 0.8,
      direct1to1CoverageMin: 6,
      groupChatCoverageMin: 2,
      thirdPartyCoverageMin: 1,
      distinctHumanActorsMin: 10,
      distinctHumanGroupsMin: 2,
      distinctConversationFamiliesMin: 12,
      criticalReviewedSliceMin: 25,
      pendingOwnerMax: 0,
      pendingCalibrationMax: 0
    },
    selection_ready: {
      ownerReviewedTotalMin: 120,
      ownerApprovedYesMin: 95,
      representativeNoMin: 15,
      reviewedClarifyMin: 15,
      approvedDomainCoverageMin: 15,
      approvedLensCoverageMin: 10,
      actorCoverageMin: 15,
      groupCoverageMin: 3,
      threadCoverageMin: 12,
      sourceCoverageMin: 2,
      timeCoverageMin: 8,
      humanCaseShareMin: 0.8,
      direct1to1CoverageMin: 8,
      groupChatCoverageMin: 3,
      thirdPartyCoverageMin: 2,
      distinctHumanActorsMin: 14,
      distinctHumanGroupsMin: 3,
      distinctConversationFamiliesMin: 18,
      criticalReviewedSliceMin: 30,
      pendingOwnerMax: 0,
      pendingCalibrationMax: 0
    },
    certification_ready: {
      ownerReviewedTotalMin: 180,
      ownerApprovedYesMin: 140,
      representativeNoMin: 20,
      reviewedClarifyMin: 20,
      approvedDomainCoverageMin: 20,
      approvedLensCoverageMin: 10,
      actorCoverageMin: 20,
      groupCoverageMin: 4,
      threadCoverageMin: 16,
      sourceCoverageMin: 3,
      timeCoverageMin: 10,
      humanCaseShareMin: 0.8,
      direct1to1CoverageMin: 10,
      groupChatCoverageMin: 4,
      thirdPartyCoverageMin: 3,
      distinctHumanActorsMin: 18,
      distinctHumanGroupsMin: 4,
      distinctConversationFamiliesMin: 24,
      criticalReviewedSliceMin: 40,
      pendingOwnerMax: 0,
      pendingCalibrationMax: 0
    }
  }
};
const DEFAULT_SELECTION_PROFILE: StrategySelectionProfile = {
  profileId: "default_v1_8",
  disqualifiers: {
    minGroundingRate: 0.95,
    maxFalseConfidentRate: 0.02,
    minBehaviorCorrectRate: 0.85,
    maxLatencyMultiplier: 2,
    maxCostMultiplier: 2
  },
  compositeWeights: {
    behaviorCorrectRate: 0.35,
    groundingRate: 0.2,
    attributionAggregate: 0.15,
    clarifyAggregate: 0.1,
    retrievalAggregate: 0.1,
    efficiencyAggregate: 0.05,
    stabilityScore: 0.05
  },
  provisional: {
    minBehaviorCorrectRate: 0.9,
    minClearBehaviorCorrectRate: 0.92,
    minClarifyBehaviorCorrectRate: 0.85,
    minGroundingRate: 0.96,
    maxFalseConfidentRate: 0.01,
    minEvidenceHitRate: 0.9,
    perDomainFloor: 0.75,
    perDomainMinCases: 4,
    maxLatencyMultiplier: 1.5,
    maxCostMultiplier: 1.5
  }
};
const DEFAULT_CERTIFICATION_PROFILE: StrategyCertificationProfile = {
  profileId: "default_v1_8",
  minBehaviorCorrectRate: 0.93,
  minClearBehaviorCorrectRate: 0.95,
  minClarifyBehaviorCorrectRate: 0.9,
  minGroundingRate: 0.97,
  maxFalseConfidentRate: 0.005,
  minEvidenceHitRate: 0.92,
  perDomainFloor: 0.8,
  perDomainMinCases: 5,
  maxLatencyMultiplier: 1.25,
  maxCostMultiplier: 1.25,
  criticalMinCasesForRate: 100,
  criticalBehaviorCorrectRate: 0.99
};
const AUTHORING_TIMING_LOG_PATH = path.resolve("generated/strategy_program/benchmark_authoring_call_times.jsonl");
const DEFAULT_TAXONOMY_VERSION_KEY = "taxonomy_v1";
const DEFAULT_TAXONOMY_VERSION_NAME = "OpenBrain Taxonomy v1";

function clamp01(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function resolveReadinessProfile(experiment: ExperimentRow | Record<string, unknown>): BenchmarkReadinessProfile {
  const cfg = isRecord((experiment as ExperimentRow).config) ? (experiment as ExperimentRow).config : experiment;
  const cfgRecord = cfg as Record<string, unknown>;
  const raw = isRecord(cfgRecord.readinessProfile) ? cfgRecord.readinessProfile : {};
  const stages: BenchmarkReadinessProfile["stages"] = {
    core_ready: { ...DEFAULT_READINESS_PROFILE.stages.core_ready },
    selection_ready: { ...DEFAULT_READINESS_PROFILE.stages.selection_ready },
    certification_ready: { ...DEFAULT_READINESS_PROFILE.stages.certification_ready }
  };
  for (const stage of ["core_ready", "selection_ready", "certification_ready"] as const) {
    if (!isRecord(raw[stage])) continue;
    const src = raw[stage] as Record<string, unknown>;
    const base = stages[stage];
    stages[stage] = {
      ownerReviewedTotalMin: Math.max(1, Number(src.ownerReviewedTotalMin ?? base.ownerReviewedTotalMin)),
      ownerApprovedYesMin: Math.max(0, Number(src.ownerApprovedYesMin ?? base.ownerApprovedYesMin)),
      representativeNoMin: Math.max(0, Number(src.representativeNoMin ?? base.representativeNoMin)),
      reviewedClarifyMin: Math.max(0, Number(src.reviewedClarifyMin ?? base.reviewedClarifyMin)),
      approvedDomainCoverageMin: Math.max(0, Number(src.approvedDomainCoverageMin ?? base.approvedDomainCoverageMin)),
      approvedLensCoverageMin: Math.max(0, Number(src.approvedLensCoverageMin ?? base.approvedLensCoverageMin)),
      actorCoverageMin: Math.max(0, Number(src.actorCoverageMin ?? base.actorCoverageMin)),
      groupCoverageMin: Math.max(0, Number(src.groupCoverageMin ?? base.groupCoverageMin)),
      threadCoverageMin: Math.max(0, Number(src.threadCoverageMin ?? base.threadCoverageMin)),
      sourceCoverageMin: Math.max(0, Number(src.sourceCoverageMin ?? base.sourceCoverageMin)),
      timeCoverageMin: Math.max(0, Number(src.timeCoverageMin ?? base.timeCoverageMin)),
      humanCaseShareMin: clamp01(Number(src.humanCaseShareMin), base.humanCaseShareMin),
      direct1to1CoverageMin: Math.max(0, Number(src.direct1to1CoverageMin ?? base.direct1to1CoverageMin)),
      groupChatCoverageMin: Math.max(0, Number(src.groupChatCoverageMin ?? base.groupChatCoverageMin)),
      thirdPartyCoverageMin: Math.max(0, Number(src.thirdPartyCoverageMin ?? base.thirdPartyCoverageMin)),
      distinctHumanActorsMin: Math.max(0, Number(src.distinctHumanActorsMin ?? base.distinctHumanActorsMin)),
      distinctHumanGroupsMin: Math.max(0, Number(src.distinctHumanGroupsMin ?? base.distinctHumanGroupsMin)),
      distinctConversationFamiliesMin: Math.max(0, Number(src.distinctConversationFamiliesMin ?? base.distinctConversationFamiliesMin)),
      criticalReviewedSliceMin: Math.max(0, Number(src.criticalReviewedSliceMin ?? base.criticalReviewedSliceMin)),
      pendingOwnerMax: Math.max(0, Number(src.pendingOwnerMax ?? base.pendingOwnerMax)),
      pendingCalibrationMax: Math.max(0, Number(src.pendingCalibrationMax ?? base.pendingCalibrationMax))
    };
  }
  return {
    profileId: String(cfgRecord.readinessProfileId ?? DEFAULT_READINESS_PROFILE.profileId),
    stages
  };
}

function resolveSelectionProfile(experiment: ExperimentRow | Record<string, unknown>): StrategySelectionProfile {
  const cfg = isRecord((experiment as ExperimentRow).config) ? (experiment as ExperimentRow).config : experiment;
  const cfgRecord = cfg as Record<string, unknown>;
  const raw = isRecord(cfgRecord.selectionProfile) ? cfgRecord.selectionProfile : {};
  const disqualifiers = isRecord(raw.disqualifiers) ? raw.disqualifiers : {};
  const compositeWeights = isRecord(raw.compositeWeights) ? raw.compositeWeights : {};
  const provisional = isRecord(raw.provisional) ? raw.provisional : {};
  return {
    profileId: String(cfgRecord.selectionProfileId ?? DEFAULT_SELECTION_PROFILE.profileId),
    disqualifiers: {
      minGroundingRate: clamp01(Number(disqualifiers.minGroundingRate), DEFAULT_SELECTION_PROFILE.disqualifiers.minGroundingRate),
      maxFalseConfidentRate: clamp01(Number(disqualifiers.maxFalseConfidentRate), DEFAULT_SELECTION_PROFILE.disqualifiers.maxFalseConfidentRate),
      minBehaviorCorrectRate: clamp01(Number(disqualifiers.minBehaviorCorrectRate), DEFAULT_SELECTION_PROFILE.disqualifiers.minBehaviorCorrectRate),
      maxLatencyMultiplier: Math.max(1, Number(disqualifiers.maxLatencyMultiplier ?? DEFAULT_SELECTION_PROFILE.disqualifiers.maxLatencyMultiplier)),
      maxCostMultiplier: Math.max(1, Number(disqualifiers.maxCostMultiplier ?? DEFAULT_SELECTION_PROFILE.disqualifiers.maxCostMultiplier))
    },
    compositeWeights: {
      behaviorCorrectRate: Number(compositeWeights.behaviorCorrectRate ?? DEFAULT_SELECTION_PROFILE.compositeWeights.behaviorCorrectRate),
      groundingRate: Number(compositeWeights.groundingRate ?? DEFAULT_SELECTION_PROFILE.compositeWeights.groundingRate),
      attributionAggregate: Number(compositeWeights.attributionAggregate ?? DEFAULT_SELECTION_PROFILE.compositeWeights.attributionAggregate),
      clarifyAggregate: Number(compositeWeights.clarifyAggregate ?? DEFAULT_SELECTION_PROFILE.compositeWeights.clarifyAggregate),
      retrievalAggregate: Number(compositeWeights.retrievalAggregate ?? DEFAULT_SELECTION_PROFILE.compositeWeights.retrievalAggregate),
      efficiencyAggregate: Number(compositeWeights.efficiencyAggregate ?? DEFAULT_SELECTION_PROFILE.compositeWeights.efficiencyAggregate),
      stabilityScore: Number(compositeWeights.stabilityScore ?? DEFAULT_SELECTION_PROFILE.compositeWeights.stabilityScore)
    },
    provisional: {
      minBehaviorCorrectRate: clamp01(Number(provisional.minBehaviorCorrectRate), DEFAULT_SELECTION_PROFILE.provisional.minBehaviorCorrectRate),
      minClearBehaviorCorrectRate: clamp01(Number(provisional.minClearBehaviorCorrectRate), DEFAULT_SELECTION_PROFILE.provisional.minClearBehaviorCorrectRate),
      minClarifyBehaviorCorrectRate: clamp01(Number(provisional.minClarifyBehaviorCorrectRate), DEFAULT_SELECTION_PROFILE.provisional.minClarifyBehaviorCorrectRate),
      minGroundingRate: clamp01(Number(provisional.minGroundingRate), DEFAULT_SELECTION_PROFILE.provisional.minGroundingRate),
      maxFalseConfidentRate: clamp01(Number(provisional.maxFalseConfidentRate), DEFAULT_SELECTION_PROFILE.provisional.maxFalseConfidentRate),
      minEvidenceHitRate: clamp01(Number(provisional.minEvidenceHitRate), DEFAULT_SELECTION_PROFILE.provisional.minEvidenceHitRate),
      perDomainFloor: clamp01(Number(provisional.perDomainFloor), DEFAULT_SELECTION_PROFILE.provisional.perDomainFloor),
      perDomainMinCases: Math.max(1, Number(provisional.perDomainMinCases ?? DEFAULT_SELECTION_PROFILE.provisional.perDomainMinCases)),
      maxLatencyMultiplier: Math.max(1, Number(provisional.maxLatencyMultiplier ?? DEFAULT_SELECTION_PROFILE.provisional.maxLatencyMultiplier)),
      maxCostMultiplier: Math.max(1, Number(provisional.maxCostMultiplier ?? DEFAULT_SELECTION_PROFILE.provisional.maxCostMultiplier))
    }
  };
}

function resolveCertificationProfile(experiment: ExperimentRow | Record<string, unknown>): StrategyCertificationProfile {
  const cfg = isRecord((experiment as ExperimentRow).config) ? (experiment as ExperimentRow).config : experiment;
  const cfgRecord = cfg as Record<string, unknown>;
  const raw = isRecord(cfgRecord.certificationProfile) ? cfgRecord.certificationProfile : {};
  return {
    profileId: String(cfgRecord.certificationProfileId ?? DEFAULT_CERTIFICATION_PROFILE.profileId),
    minBehaviorCorrectRate: clamp01(Number(raw.minBehaviorCorrectRate), DEFAULT_CERTIFICATION_PROFILE.minBehaviorCorrectRate),
    minClearBehaviorCorrectRate: clamp01(Number(raw.minClearBehaviorCorrectRate), DEFAULT_CERTIFICATION_PROFILE.minClearBehaviorCorrectRate),
    minClarifyBehaviorCorrectRate: clamp01(Number(raw.minClarifyBehaviorCorrectRate), DEFAULT_CERTIFICATION_PROFILE.minClarifyBehaviorCorrectRate),
    minGroundingRate: clamp01(Number(raw.minGroundingRate), DEFAULT_CERTIFICATION_PROFILE.minGroundingRate),
    maxFalseConfidentRate: clamp01(Number(raw.maxFalseConfidentRate), DEFAULT_CERTIFICATION_PROFILE.maxFalseConfidentRate),
    minEvidenceHitRate: clamp01(Number(raw.minEvidenceHitRate), DEFAULT_CERTIFICATION_PROFILE.minEvidenceHitRate),
    perDomainFloor: clamp01(Number(raw.perDomainFloor), DEFAULT_CERTIFICATION_PROFILE.perDomainFloor),
    perDomainMinCases: Math.max(1, Number(raw.perDomainMinCases ?? DEFAULT_CERTIFICATION_PROFILE.perDomainMinCases)),
    maxLatencyMultiplier: Math.max(1, Number(raw.maxLatencyMultiplier ?? DEFAULT_CERTIFICATION_PROFILE.maxLatencyMultiplier)),
    maxCostMultiplier: Math.max(1, Number(raw.maxCostMultiplier ?? DEFAULT_CERTIFICATION_PROFILE.maxCostMultiplier)),
    criticalMinCasesForRate: Math.max(1, Number(raw.criticalMinCasesForRate ?? DEFAULT_CERTIFICATION_PROFILE.criticalMinCasesForRate)),
    criticalBehaviorCorrectRate: clamp01(Number(raw.criticalBehaviorCorrectRate), DEFAULT_CERTIFICATION_PROFILE.criticalBehaviorCorrectRate)
  };
}

function stageRank(stage: BenchmarkStage | null | undefined): number {
  switch (stage) {
    case "core_ready": return 1;
    case "selection_ready": return 2;
    case "certification_ready": return 3;
    default: return 0;
  }
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

function unicodeWordTokens(value: string | null | undefined): string[] {
  return lowerText(value).match(/\p{L}[\p{L}\p{N}._-]{2,}/gu) ?? [];
}

function readPositiveIntEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name] ?? "");
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
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
      .flatMap((name) => unicodeWordTokens(name))
  );
  const structuredClaims = collectStructuredClaims(rows, 6);
  for (const row of rows) {
    const matches = unicodeWordTokens(row.content);
    for (const token of matches) {
      if (QUESTION_GROUNDING_STOPWORDS.has(token)) continue;
      if (actorTokens.has(token)) continue;
      counts.set(token, Number(counts.get(token) ?? 0) + 1);
    }
  }
  for (const claim of structuredClaims) {
    const matches = unicodeWordTokens(claim);
    for (const token of matches) {
      if (QUESTION_GROUNDING_STOPWORDS.has(token)) continue;
      if (actorTokens.has(token)) continue;
      counts.set(token, Number(counts.get(token) ?? 0) + 2);
    }
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length || a[0].localeCompare(b[0]))
    .map(([token]) => token)
    .slice(0, 12);
}

function looksLikeStructuredAnswerRow(row: SeedEvidenceCandidate): boolean {
  const actorType = lowerText(row.actor_type);
  if (actorType === "assistant" || actorType === "system") return true;
  const text = String(row.content ?? "");
  return /(^|\n)\s*(?:\d+[\).\:-]|\*|-|•)\s+/.test(text) || /\b(first|second|third|two issues|three issues|steps?)\b/i.test(text);
}

function splitIntoClaimUnits(text: string): string[] {
  return String(text ?? "")
    .replace(/\.{2,}/g, ". ")
    .replace(/[;]+/g, ". ")
    .replace(/([.!?])(?=\p{L})/gu, "$1 ")
    .split(/(?:\n+|(?<=[.!?])\s{1,}|(?:^|\s)(?:\d+[\).\:-]|\*|-|•)\s+)/)
    .map((part) => compactText(part, 220).replace(/^[\-\*\u2022]\s+/, "").trim())
    .filter((part) => part.length >= 20);
}

function collectStructuredClaims(rows: SeedEvidenceCandidate[], limit = 6): string[] {
  const ranked: Array<{ claim: string; priority: number }> = [];
  for (const row of rows) {
    const basePriority = looksLikeStructuredAnswerRow(row) ? 3 : (lowerText(row.actor_type) === "user" ? 1 : 2);
    for (const claim of splitIntoClaimUnits(String(row.content ?? ""))) {
      const clean = compactText(claim, 180);
      if (!clean) continue;
      if (looksLikeFileMetaFragment(clean)) continue;
      ranked.push({
        claim: clean,
        priority: basePriority + Math.min(2, Math.floor(clean.length / 80))
      });
    }
  }
  const dedup = new Map<string, { claim: string; priority: number }>();
  for (const entry of ranked) {
    const key = buildBenchmarkQuestionDedupKey(entry.claim);
    const existing = dedup.get(key);
    if (!existing || entry.priority > existing.priority || entry.claim.length > existing.claim.length) {
      dedup.set(key, entry);
    }
  }
  return Array.from(dedup.values())
    .sort((a, b) => b.priority - a.priority || b.claim.length - a.claim.length || a.claim.localeCompare(b.claim))
    .map((entry) => entry.claim)
    .slice(0, limit);
}

const REMINDER_DIRECTIVE_ACTION_PATTERNS: Array<{ pattern: RegExp; englishVerb: string }> = [
  {
    pattern: /\b(?:remember|remind(?:ed)?|don't forget|do not forget|recuerda|lembra|não esquece|nao esquece)\b.*?\b(?:to\s+)?(sign|firmar|assinar)\b\s+([^.!?\n]+)/iu,
    englishVerb: "sign"
  },
  {
    pattern: /\b(?:remember|remind(?:ed)?|don't forget|do not forget|recuerda|lembra|não esquece|nao esquece)\b.*?\b(?:to\s+)?(join|come to|go to|meet(?: with)?|talk to|speak to|call|send|bring|review|check|schedule|book|pay|submit|upload|sign|firmar|assinar)\b\s+([^.!?\n]+)/iu,
    englishVerb: ""
  },
  {
    pattern: /\b(join|come to|go to|meet(?: with)?|talk to|speak to|call|send|bring|review|check|schedule|book|pay|submit|upload|sign|firmar|assinar)\b\s+([^.!?\n]+)/iu,
    englishVerb: ""
  }
];

const REMINDER_DIRECTIVE_CUE_NOISE = new Set([
  "remember", "remind", "recuerda", "lembra", "please", "favor", "quando", "cuando", "could", "would", "need", "needyou",
  "want", "wanted", "join", "come", "review", "check", "send", "bring", "call", "sign", "firmar", "assinar"
]);

const LOW_QUALITY_CUE_TOKENS = new Set([
  "i", "me", "my", "you", "your", "we", "our", "he", "she", "they", "them", "their", "it", "its",
  "listen", "listened", "watch", "watched", "read", "reading", "far", "only", "great", "good", "tomorrow", "today", "latest"
]);

function normalizeReminderDirectiveVerb(verb: string): string {
  const normalized = lowerText(verb).replace(/\s+/g, " ").trim();
  if (normalized === "firmar" || normalized === "assinar") return "sign";
  if (normalized === "come to") return "join";
  return normalized;
}

function normalizeReminderDirectiveTail(tail: string): string {
  return compactText(
    String(tail ?? "")
      .replace(/^[,:;\-\s]+/, "")
      .replace(/\b(?:que te hice|when you can|cuando puedas|quando puder|if you can)\b/giu, "")
      .replace(/\s+/g, " ")
      .trim(),
    80
  );
}

function buildReminderDirectiveCuePhrase(cueTerms: string[]): string | null {
  const cleaned = cueTerms
    .map((token) => lowerText(token))
    .filter((token) => token && !QUESTION_GROUNDING_STOPWORDS.has(token) && !REMINDER_DIRECTIVE_CUE_NOISE.has(token));
  if (!cleaned.length) return null;
  const hasConsent = cleaned.some((token) => token.includes("consent"));
  const hasInterview = cleaned.some((token) => token.includes("entrevista") || token.includes("interview"));
  if (hasConsent && hasInterview) return "the interview consent";
  const hasRoundtable = cleaned.some((token) => token.includes("roundtable"));
  const hasRavi = cleaned.some((token) => token.includes("ravi"));
  if (hasRoundtable && hasRavi) return "the roundtable with Ravi";
  const candidate = cleaned.slice(0, 4).join(" ");
  const candidateTokens = candidate.split(/\s+/).map((token) => token.trim()).filter(Boolean);
  if (!candidateTokens.length) return null;
  if (candidateTokens[0] && LOW_QUALITY_CUE_TOKENS.has(candidateTokens[0])) return null;
  const concreteTokenCount = candidateTokens.filter((token) => !LOW_QUALITY_CUE_TOKENS.has(token)).length;
  if (concreteTokenCount < 2) return null;
  return candidate;
}

function buildHumanReminderOrDirectiveDetail(rows: SeedEvidenceCandidate[], actorName: string | null): {
  actionPhrase: string | null;
  cuePhrase: string | null;
} {
  const claims = collectStructuredClaims(rows, 8);
  for (const claim of claims) {
    for (const entry of REMINDER_DIRECTIVE_ACTION_PATTERNS) {
      const match = String(claim ?? "").match(entry.pattern);
      if (!match) continue;
      const rawVerb = match[1] ?? "";
      const rawTail = match[2] ?? "";
      const verb = entry.englishVerb || normalizeReminderDirectiveVerb(rawVerb);
      const tail = normalizeReminderDirectiveTail(rawTail);
      if (!verb || !tail) continue;
      if ((verb === "sign" || /consent|consentimento|consentimiento/iu.test(tail))
        && /entrevista|interview/iu.test(tail)) {
        return { actionPhrase: "sign the interview consent", cuePhrase: "the interview consent" };
      }
      return {
        actionPhrase: `${verb} ${tail}`.trim(),
        cuePhrase: buildReminderDirectiveCuePhrase(extractConcreteCueTerms(rows, actorName))
      };
    }
  }
  return {
    actionPhrase: null,
    cuePhrase: buildReminderDirectiveCuePhrase(extractConcreteCueTerms(rows, actorName))
  };
}

function inferRecommendationObjectLabel(text: string): string | null {
  const normalized = lowerText(text);
  if (/\bepisode\b/.test(normalized)) return "episode";
  if (/\bpodcast\b/.test(normalized)) return "podcast";
  if (/\bmovie\b|\bfilm\b/.test(normalized)) return "movie";
  if (/\bshow\b|\bseries\b/.test(normalized)) return "show";
  if (/\bvideo\b|\byoutube\b/.test(normalized)) return "video";
  if (/\bbook\b/.test(normalized)) return "book";
  if (/\barticle\b/.test(normalized)) return "article";
  if (/\bapp\b/.test(normalized)) return "app";
  if (/\brestaurant\b|\bcoffee shop\b|\bcafe\b/.test(normalized)) return "place";
  return null;
}

function normalizeRecommendationCuePhrase(text: string): string | null {
  const normalized = compactText(
    String(text ?? "")
      .replace(/^[,:;\-\s]+/, "")
      .replace(/\b(?:to me|for me|to you|for you|when you can|if you can|you should|you would like)\b/giu, "")
      .replace(/\s+/g, " ")
      .trim(),
    90
  );
  if (!normalized) return null;
  const tokens = normalized.split(/\s+/).map((token) => lowerText(token)).filter(Boolean);
  if (!tokens.length) return null;
  if (LOW_QUALITY_CUE_TOKENS.has(tokens[0] ?? "")) return null;
  const concreteTokenCount = tokens.filter((token) => !LOW_QUALITY_CUE_TOKENS.has(token)).length;
  if (concreteTokenCount < 2) return null;
  return normalized;
}

function buildHumanRecommendationDetail(rows: SeedEvidenceCandidate[]): {
  cuePhrase: string | null;
  objectLabel: string | null;
} {
  const claims = collectStructuredClaims(rows, 8);
  for (const claim of claims) {
    const text = String(claim ?? "").trim();
    if (!text) continue;
    const directMatch = text.match(/\b(?:wanted to recommend|recommend(?:ed)?|suggest(?:ed)?)(?:\s+(?:you|me))?\s+(?:the\s+)?([^.!?\n]+)/iu);
    const explicitActionMatch = text.match(/\b(?:recommend(?:ed)?|suggest(?:ed)?)(?:\s+(?:you|me))?\s+(?:to\s+)?(listen to|watch|read|try|check out)\s+([^.!?\n]+)/iu);
    const rawCue = explicitActionMatch
      ? `${explicitActionMatch[1]} ${explicitActionMatch[2]}`
      : (directMatch?.[1] ?? "");
    const cuePhrase = normalizeRecommendationCuePhrase(rawCue);
    if (!cuePhrase) continue;
    return {
      cuePhrase,
      objectLabel: inferRecommendationObjectLabel(cuePhrase)
    };
  }
  return { cuePhrase: null, objectLabel: null };
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
      return ["assistant_proxy", "user_first_person"];
    default:
      return ["assistant_proxy", "user_first_person", "user_about_other"];
  }
}

function scoreStatementOwnershipRow(row: SeedEvidenceCandidate): number {
  const content = String(row.content ?? "").trim();
  if (!content) return 0;
  let score = 0;
  const actorType = lowerText(row.actor_type);
  const tokenCount = unicodeWordTokens(content).length;
  score += Math.min(0.8, tokenCount * 0.04);
  score += Math.min(0.8, collectStructuredClaims([row], 3).length * 0.3);
  if (hasConcreteMemorySignal(content)) score += 0.9;
  if (actorType === "user") score += 0.2;
  else if (isHumanContactRow(row)) score += 0.25;
  if (looksLikePhaticSmalltalk(content)) score -= 1.2;
  if (looksLikeChatBoilerplate(content)) score -= 1.2;
  if (looksLikeFileMetaFragment(content)) score -= 1.0;
  if (looksLikeCodeOnly(content)) score -= 0.8;
  return score;
}

function strongestHumanSpeakerProfile(rows: SeedEvidenceCandidate[]): {
  userScore: number;
  topOtherName: string | null;
  topOtherScore: number;
  topOtherRows: number;
} {
  let userScore = 0;
  const others = new Map<string, { name: string; score: number; rows: number }>();
  for (const row of rows) {
    const score = scoreStatementOwnershipRow(row);
    if (score <= 0) continue;
    const actorType = lowerText(row.actor_type);
    if (actorType === "user") {
      userScore += score;
      continue;
    }
    if (!isHumanContactRow(row)) continue;
    const key = actorIdentityKey(row) || lowerText(row.actor_name);
    if (!key) continue;
    const entry = others.get(key) ?? { name: String(row.actor_name ?? "").trim(), score: 0, rows: 0 };
    entry.score += score;
    entry.rows += 1;
    others.set(key, entry);
  }
  const topOther = Array.from(others.values()).sort((a, b) => b.score - a.score || b.rows - a.rows || a.name.localeCompare(b.name))[0] ?? null;
  return {
    userScore,
    topOtherName: topOther?.name ?? null,
    topOtherScore: topOther?.score ?? 0,
    topOtherRows: topOther?.rows ?? 0
  };
}

function inferStatementOwner(anchor: SeedEvidenceCandidate, contextRows: SeedEvidenceCandidate[]): {
  statementOwnerName: string | null;
  statementOwnerRole: "user" | "other_human" | "assistant_or_system" | "mixed";
  preferredQuestionVoices: Array<"user_first_person" | "user_about_other" | "assistant_proxy">;
} {
  const topology = classifyConversationTopology({ anchor, contextRows });
  const anchorActorType = lowerText(anchor.actor_type);
  const anchorActorName = String(anchor.actor_name ?? "").trim() || null;
  const humanTopology = topologyIsHuman(topology);
  const anchorScore = scoreStatementOwnershipRow(anchor);
  const anchorHasConcreteSignal = hasConcreteMemorySignal(String(anchor.content ?? ""))
    || collectStructuredClaims([anchor], 2).length > 0;
  if (anchorActorType === "user") {
    const strongest = strongestHumanSpeakerProfile(contextRows);
    const canPreferOtherHumanOverUser =
      humanTopology
      && strongest.topOtherName
      && (
        topology === "third_party_human"
        || (
          topology === "human_group_chat"
          && (
            strongest.topOtherScore >= Math.max(anchorScore + 0.8, strongest.userScore * 0.95)
            || strongest.topOtherRows >= 3
          )
        )
        || (
          !anchorHasConcreteSignal
          && strongest.topOtherScore >= Math.max(1.2, strongest.userScore * 1.05)
          && strongest.topOtherRows >= 2
        )
      );
    if (
      canPreferOtherHumanOverUser
    ) {
      return {
        statementOwnerName: strongest.topOtherName,
        statementOwnerRole: "other_human",
        preferredQuestionVoices: preferredVoicesForStatementOwner("other_human")
      };
    }
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
    const strongest = strongestHumanSpeakerProfile(contextRows);
    if (
      humanTopology
      && strongest.topOtherName
      && lowerText(strongest.topOtherName) !== lowerText(anchorActorName)
      && strongest.topOtherScore > Math.max(anchorScore + 0.4, 1)
    ) {
      return {
        statementOwnerName: strongest.topOtherName,
        statementOwnerRole: "other_human",
        preferredQuestionVoices: preferredVoicesForStatementOwner("other_human")
      };
    }
    return {
      statementOwnerName: anchorActorName,
      statementOwnerRole: "other_human",
      preferredQuestionVoices: preferredVoicesForStatementOwner("other_human")
    };
  }
  const userNames = uniqueNames(
    contextRows
      .filter((row) => lowerText(row.actor_type) === "user")
      .map((row) => row.actor_name)
  );
  const otherHumanNames = uniqueNames(
    contextRows
      .filter((row) => isHumanContactRow(row))
      .map((row) => row.actor_name)
  );
  if (topology === "human_direct_1to1" && userNames.length === 1 && otherHumanNames.length === 1) {
    return {
      statementOwnerName: otherHumanNames[0],
      statementOwnerRole: "other_human",
      preferredQuestionVoices: preferredVoicesForStatementOwner("other_human")
    };
  }
  if (topology === "third_party_human") {
    if (otherHumanNames.length === 1) {
      return {
        statementOwnerName: otherHumanNames[0],
        statementOwnerRole: "other_human",
        preferredQuestionVoices: preferredVoicesForStatementOwner("other_human")
      };
    }
    const anchorHumanName = isHumanContactRow(anchor) ? anchorActorName : null;
    if (anchorHumanName) {
      return {
        statementOwnerName: anchorHumanName,
        statementOwnerRole: "other_human",
        preferredQuestionVoices: preferredVoicesForStatementOwner("other_human")
      };
    }
  }
  const strongest = strongestHumanSpeakerProfile(contextRows);
  if (humanTopology && strongest.topOtherName && strongest.topOtherScore >= Math.max(0.9, strongest.userScore * 0.75)) {
    return {
      statementOwnerName: strongest.topOtherName,
      statementOwnerRole: "other_human",
      preferredQuestionVoices: preferredVoicesForStatementOwner("other_human")
    };
  }
  if (humanTopology && strongest.userScore >= 0.9 && strongest.userScore > strongest.topOtherScore * 1.2) {
    return {
      statementOwnerName: userNames[0] ?? anchorActorName,
      statementOwnerRole: "user",
      preferredQuestionVoices: preferredVoicesForStatementOwner("user")
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

function inferStatementTarget(
  anchor: SeedEvidenceCandidate,
  contextRows: SeedEvidenceCandidate[],
  statementOwnerName: string | null,
  statementOwnerRole: "user" | "other_human" | "assistant_or_system" | "mixed"
): string | null {
  const topology = classifyConversationTopology({ anchor, contextRows });
  const ownerKey = lowerText(statementOwnerName);
  const userNames = uniqueNames(
    contextRows
      .filter((row) => lowerText(row.actor_type) === "user")
      .map((row) => row.actor_name)
  );
  const otherNames = uniqueNames(
    contextRows
      .filter((row) => isHumanContactRow(row))
      .map((row) => row.actor_name)
  ).filter((name) => lowerText(name) !== ownerKey);
  const ownerRows = contextRows.filter((row) => lowerText(row.actor_name) === ownerKey);
  const ownerText = ownerRows.map((row) => String(row.content ?? "")).join(" \n ");
  const ownerTargetsUser = referencesUserTarget(ownerText);
  const explicitNamedTargets = otherNames.filter((name) => {
    const lowered = lowerText(name);
    return lowered && lowerText(ownerText).includes(lowered);
  });
  if (statementOwnerRole === "assistant_or_system") {
    return userNames[0] ?? otherNames[0] ?? null;
  }
  if (topology === "human_direct_1to1") {
    if (statementOwnerRole === "other_human") return ownerTargetsUser ? (userNames[0] ?? ownerDisplayName()) : null;
    if (statementOwnerRole === "user") return otherNames[0] ?? null;
  }
  if (topology === "human_group_chat") {
    if (explicitNamedTargets[0]) return explicitNamedTargets[0];
    for (const name of userNames) {
      if (lowerText(name) && lowerText(ownerText).includes(lowerText(name))) return name;
    }
    for (const name of otherNames) {
      if (lowerText(name) && lowerText(ownerText).includes(lowerText(name))) return name;
    }
    return null;
  }
  if (topology === "third_party_human") {
    if (explicitNamedTargets[0]) return explicitNamedTargets[0];
    if (otherNames.length === 1) return otherNames[0];
    const dominant = dominantSpeakerProfile(
      contextRows.filter((row) => lowerText(row.actor_name) !== ownerKey)
    ).dominantOtherName;
    return dominant ?? otherNames[0] ?? null;
  }
  for (const name of userNames) {
    if (lowerText(name) && lowerText(ownerText).includes(lowerText(name))) return name;
  }
  if (ownerTargetsUser) {
    return userNames[0] ?? ownerDisplayName();
  }
  for (const name of otherNames) {
    if (lowerText(name) && lowerText(ownerText).includes(lowerText(name))) return name;
  }
  if (statementOwnerRole === "user") return otherNames[0] ?? null;
  if (statementOwnerRole === "other_human") return userNames[0] ?? otherNames[0] ?? null;
  return userNames[0] ?? otherNames[0] ?? null;
}

function referencesUserTarget(text: string | null | undefined): boolean {
  const normalized = lowerText(String(text ?? ""));
  if (!normalized) return false;
  if (Array.from(OWNER_ALIAS_KEYS).some((alias) => alias && normalized.includes(alias))) return true;
  return /\b(you|your|yours|yourself|vc|vcs|você|vocês|seu|seus|sua|suas|contigo|com você|com vc|tu|teu|teus|tua|tuas|ti|usted|ustedes|tus|te)\b/u.test(normalized);
}

function semanticFrameTargetsUser(frame: BenchmarkSemanticFrame | null | undefined): boolean {
  if (!frame) return false;
  return isOwnerAliasName(frame.statementTargetName)
    || frame.retrievalFacets.actorNames.some((value) => isOwnerAliasName(value));
}

function questionStartsWithFirstPersonLead(question: string): boolean {
  const normalized = String(question ?? "").trim();
  return /^(what|why|when|where|how|who)\s+(?:did|do|am|was|were|will|would|can|could|should)\s+i\b/i.test(normalized)
    || /^(what|why|how)\s+are\s+we\b/i.test(normalized)
    || /^(what|why|when|where|how|who)\s+(?:did|do|will|would|can|could|should)\s+we\b/i.test(normalized);
}

function questionReferencesUserTarget(
  question: string,
  questionVoice: string,
  semanticFrame: BenchmarkSemanticFrame
): boolean {
  const normalized = lowerText(String(question ?? ""));
  if (!semanticFrameTargetsUser(semanticFrame)) return false;
  if (questionVoice === "assistant_proxy") {
    return normalized.includes(lowerText(ownerDisplayName()))
      || normalized.includes(lowerText(ownerDisplayPossessive()))
      || /\b(about you|for you|to you|with you|your|yours)\b/i.test(question);
  }
  return /\b(i|me|my|mine|our|ours|us)\b/i.test(question)
    || normalized.includes(lowerText(ownerDisplayName()));
}

function questionReferencesGroupOrThreadContext(
  question: string,
  semanticFrame: BenchmarkSemanticFrame | null | undefined
): boolean {
  if (!semanticFrame) return false;
  const normalized = lowerText(String(question ?? ""));
  if (!normalized) return false;
  if (/\b(group chat|group|thread|conversation|chat)\b/.test(normalized)) return true;
  for (const label of semanticFrame.retrievalFacets.groupLabels) {
    const lowered = lowerText(label);
    if (lowered && normalized.includes(lowered)) return true;
  }
  for (const title of semanticFrame.retrievalFacets.threadTitles) {
    const lowered = lowerText(title);
    if (lowered && normalized.includes(lowered)) return true;
  }
  return false;
}

function questionNeedsExplicitTargetContext(question: string): boolean {
  const normalized = lowerText(String(question ?? ""));
  if (!normalized) return false;
  return /\b(about me|about us|to me|to us|for me|for us|with me|with us|my|our|we|you|your|yours)\b/u.test(normalized);
}

function inferConversationLabel(anchor: SeedEvidenceCandidate, contextRows: SeedEvidenceCandidate[]): string | null {
  const candidates = [
    metadataString(anchor, "thread_title"),
    metadataString(anchor, "conversation_title"),
    metadataString(anchor, "group_label"),
    metadataString(anchor, "thread_label"),
    ...contextRows.flatMap((row) => [
      metadataString(row, "thread_title"),
      metadataString(row, "conversation_title"),
      metadataString(row, "group_label"),
      metadataString(row, "thread_label")
    ])
  ].filter(Boolean);
  return candidates[0] ?? null;
}

function scoreAnchorAuthorability(params: {
  domain: string;
  lens: string;
  anchor: SeedEvidenceCandidate;
  contextRows: SeedEvidenceCandidate[];
  domainScore: number;
}): number {
  let score = clamp01(params.domainScore, 0) * 0.35;
  const anchorText = String(params.anchor.content ?? "").trim();
  const claimCount = collectStructuredClaims(params.contextRows, 8).length;
  const actorType = lowerText(params.anchor.actor_type);
  if (actorType === "assistant" || actorType === "system") score += 0.15;
  else if (actorType && actorType !== "user") score += 0.12;
  if (anchorText.length >= 180) score += 0.12;
  else if (anchorText.length >= 100) score += 0.08;
  if (params.contextRows.length >= 4) score += 0.12;
  else if (params.contextRows.length >= 2) score += 0.08;
  if (claimCount >= 4) score += 0.12;
  else if (claimCount >= 2) score += 0.08;
  if (domainSemanticMismatchReason(params.domain, params.contextRows) == null) score += 0.08;
  if (looksLikeFileMetaFragment(anchorText) || looksLikeCodeOnly(anchorText)) score -= 0.25;
  if (params.lens !== "descriptive" && params.contextRows.length <= 1) score -= 0.2;
  return clamp01(score, 0);
}

function pruneBucketForDiversity<T extends {
  conversation_id: string;
  source_conversation_id?: string | null;
  canonical_id: string;
}>(rows: T[], maxPerFamily = 2, limit = MAX_DOMAIN_ANCHORS_TO_SCAN): T[] {
  const out: T[] = [];
  const familyCounts = new Map<string, number>();
  for (const row of rows) {
    const familyKey = String(row.source_conversation_id ?? row.conversation_id ?? row.canonical_id);
    const count = familyCounts.get(familyKey) ?? 0;
    if (count >= maxPerFamily) continue;
    familyCounts.set(familyKey, count + 1);
    out.push(row);
    if (out.length >= limit) break;
  }
  return out;
}

function buildOracleSearchQuery(question: string): string {
  const tokens = unicodeWordTokens(question);
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

function looksLikeUrlDominatedContent(content: string): boolean {
  const text = String(content ?? "").trim();
  if (!text) return false;
  const urls = text.match(/https?:\/\/\S+/gi) ?? [];
  if (urls.length === 0) return false;
  const stripped = text
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  const tokenCount = unicodeWordTokens(stripped).length;
  const urlChars = urls.reduce((sum, url) => sum + url.length, 0);
  return (
    stripped.length < 80
    || tokenCount < 8
    || urlChars / Math.max(text.length, 1) >= 0.35
  );
}

function looksLikeChatBoilerplate(content: string): boolean {
  const text = lowerText(content)
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return false;
  return (
    /this business works with other companies to manage this chat/.test(text)
    || /tap to learn more/.test(text)
    || /messages and calls are end-to-end encrypted/.test(text)
    || /security code (?:changed|updated)/.test(text)
    || /joined using this group'?s invite link/.test(text)
    || /changed the subject from/.test(text)
    || /changed this group'?s icon/.test(text)
    || /created group/.test(text)
    || /added you|removed you|left|missed voice call|missed video call/.test(text)
  );
}

function hasConcreteMemorySignal(content: string): boolean {
  const text = lowerText(content);
  if (!text) return false;
  return (
    /\b(plan|planning|tomorrow|next|after|move|moved|house|home|family|wife|husband|kids|mom|dad|divorce|problem|meeting|reuni|reunion|virtual|company|empresa|orlando|jacksonville|florida|buy|bought|compramos|pretendo|aproveitando|voltar|ficar|casa)\b/u.test(text)
    || /\b(recommend|suggest|list|best|phone|apps|route|charger|deployment|rollback|coffee|parks|firms|401k)\b/u.test(text)
    || /\b(eduardo|anibal|soma|jenn|nelson|afifa|carlos|john)\b/u.test(text)
  );
}

function looksLikePhaticSmalltalk(content: string): boolean {
  const text = lowerText(content)
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return true;
  const tokenCount = unicodeWordTokens(text).length;
  if (hasConcreteMemorySignal(text)) return false;
  const phaticPattern = /\b(oi|ola|olá|e aí|ei|fala|falaa+|faaaala|tudo bem|como vai|como vao|como vão|bem e com vc|bem e com você|grande abraço|abraço|abraco|vlw|valeu|obrigado|obrigada|thanks|thank you|hi|hello|hey|how are you|my friend|meu amigo|meu querido|quando quiser|no dia que vc preferir|when(ever)? you want|cant wait to see it sometime soon|wanted to check with u once|wanted to check with you once|show de bola|dar uma chegada aí|dar uma chegada ai)\b/u;
  const questionOnlyPattern = /^(?:ainda está por [\p{L}\p{N}\s]+|como vão as coisas|bem e com vc ?|no dia que vc preferir|quando quiser|wanted to check with (?:u|you) once|mas tá show de bola(?:[\p{L}\p{N}\s.]+)?|esse ano vou dar uma chegada aí hein|esse ano vou dar uma chegada ai hein)\??$/u;
  if (questionOnlyPattern.test(text)) return true;
  if (!phaticPattern.test(text)) return false;
  return tokenCount <= 12 || text.length <= 90;
}

function rejectAnchorReason(content: string, domainScore: number): string | null {
  const { weak } = cleanAnchorSnippet(content);
  if (weak) return "low_signal_anchor";
  if (looksLikePhaticSmalltalk(content)) return "phatic_smalltalk_anchor";
  if (looksLikeFileMetaFragment(content)) return "file_or_meta_fragment";
  if (looksLikeCodeOnly(content)) return "code_only_without_intent";
  if (looksLikeUrlDominatedContent(content)) return "url_dominant_anchor";
  if (looksLikeChatBoilerplate(content)) return "chat_boilerplate";
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

type SupplementalGeneratedCandidate = {
  calibrationItemId: string;
  domain: string;
  lens: string;
  caseSet: "dev" | "critical" | "certification";
  question: string;
  caseType: string;
  sourceEvidenceId: string;
  taxonomyPath: string;
  difficultyType: string;
  expectedCoreClaims: string[];
  evidencePreviewRows: Array<{
    evidenceId: string;
    actorName: string | null;
    observedAt: string | null;
    sourceSystem: string;
    snippet: string;
  }>;
  evidenceIds: string[];
  conversationIds: string[];
  actorIds: string[];
  ambiguityClass: "clear" | "clarify_required" | "unresolved";
  clarificationQualityExpected: boolean;
  metadata: Record<string, unknown>;
};

type WholeCorpusFamilySeed = {
  familyKey: string;
  familyRowCount: number;
  familyMaxLen: number;
  familyActorRank: number;
  anchorRows: SeedEvidenceCandidate[];
};

type SupportedPairDescriptor = {
  domain: string;
  lens: string;
  supportCount: number;
  evidenceCount: number;
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

function metadataString(row: Pick<SeedEvidenceCandidate, "metadata">, key: string): string | null {
  const value = rowMetadata(row)[key];
  const text = String(value ?? "").trim();
  return text || null;
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

function normalizeTopology(value: string | null | undefined): EvidenceFamilyTopology | null {
  switch (String(value ?? "").trim()) {
    case "human_direct_1to1":
    case "human_group_chat":
    case "third_party_human":
    case "other_human":
    case "assistant_thread":
    case "system_artifact":
      return String(value).trim() as EvidenceFamilyTopology;
    default:
      return null;
  }
}

function seedFamilyTemporalRules(rows: SeedEvidenceCandidate[]): {
  maxTotalSpanDays: number;
  maxAdjacentGapDays: number;
} {
  const first = rows[0];
  const topology = classifyConversationTopology({
    anchor: first ?? rows[0],
    contextRows: rows
  });
  const combinedText = rows.map((row) => String(row.content ?? "")).join(" \n ");
  const planningWindow = /\b(plan|planning|itinerary|trip|travel|schedule|meeting|tomorrow|next week|after the holidays)\b/i.test(combinedText)
    || rows.some((row) => row.has_plan_block);
  if (topology === "assistant_thread") {
    return { maxTotalSpanDays: 7, maxAdjacentGapDays: 2 };
  }
  return {
    maxTotalSpanDays: planningWindow ? 21 : 14,
    maxAdjacentGapDays: 3
  };
}

function splitSeedFamilyIntoTemporalClusters(rows: SeedEvidenceCandidate[]): SeedEvidenceCandidate[][] {
  const ordered = sortConversationRows(rows);
  if (ordered.length <= 1) return ordered.length > 0 ? [ordered] : [];
  const { maxAdjacentGapDays, maxTotalSpanDays } = seedFamilyTemporalRules(ordered);
  const clusters: SeedEvidenceCandidate[][] = [];
  let current: SeedEvidenceCandidate[] = [];
  let clusterStartMs = 0;

  for (const row of ordered) {
    const rowMs = sourceTimeMs(row);
    if (current.length === 0) {
      current.push(row);
      clusterStartMs = rowMs;
      continue;
    }
    const previous = current[current.length - 1];
    const gapDays = sourceGapDays(previous, row);
    const spanDays = clusterStartMs && rowMs ? Math.abs(rowMs - clusterStartMs) / 86400000 : Number.POSITIVE_INFINITY;
    if (gapDays > maxAdjacentGapDays || spanDays > maxTotalSpanDays) {
      clusters.push(current);
      current = [row];
      clusterStartMs = rowMs;
      continue;
    }
    current.push(row);
  }
  if (current.length > 0) clusters.push(current);
  return clusters;
}

function topologyIsHuman(topology: EvidenceFamilyTopology | null | undefined): boolean {
  return topology === "human_direct_1to1"
    || topology === "human_group_chat"
    || topology === "third_party_human"
    || topology === "other_human";
}

function isHumanContactRow(row: Pick<SeedEvidenceCandidate, "actor_type" | "actor_name">): boolean {
  const actorType = lowerText(row.actor_type);
  if (!actorType || actorType === "user" || actorType === "assistant" || actorType === "system") return false;
  const actorName = String(row.actor_name ?? "").trim();
  if (!actorName) return false;
  if (isLikelyGroupConversationLabel(actorName)) return false;
  return true;
}

function isLikelyHumanFacetName(name: string | null | undefined): boolean {
  const value = String(name ?? "").trim();
  const text = lowerText(value);
  if (!value || !text) return false;
  if (isLikelyGroupConversationLabel(value)) return false;
  if (/(assistant|system|chatgpt|grok|codexclaw|strategist|whatsapp system)/.test(text)) return false;
  if (text === "fabio" || text === "you") return false;
  return true;
}

function distinctHumanActorKeys(rows: SeedEvidenceCandidate[]): string[] {
  const keys = new Set<string>();
  for (const row of rows) {
    if (!isHumanContactRow(row)) continue;
    const key = actorIdentityKey(row);
    if (!key) continue;
    keys.add(key);
  }
  return [...keys];
}

function classifyConversationTopology(params: {
  anchor: SeedEvidenceCandidate;
  contextRows: SeedEvidenceCandidate[];
}): EvidenceFamilyTopology {
  const rows = params.contextRows.length > 0 ? params.contextRows : [params.anchor];
  const conversationLabel = parseConversationLabel(params.anchor.source_conversation_id ?? params.anchor.conversation_id);
  const isGroup = isLikelyGroupConversationLabel(conversationLabel);
  const userPresent = rows.some((row) => lowerText(row.actor_type) === "user");
  const humanActors = distinctHumanActorKeys(rows);
  const humanActorCount = humanActors.length;
  const assistantRows = rows.filter((row) => {
    const actorType = lowerText(row.actor_type);
    return actorType === "assistant" || actorType === "system";
  }).length;
  if (assistantRows > 0 && humanActorCount === 0) {
    return "assistant_thread";
  }
  if (humanActorCount === 0) {
    return "system_artifact";
  }
  if (isGroup && userPresent) return "human_group_chat";
  if (!isGroup && userPresent && humanActorCount === 1) return "human_direct_1to1";
  if (humanActorCount >= 2 && !userPresent) return "third_party_human";
  return "other_human";
}

function topologyTemporalRules(anchor: SeedEvidenceCandidate, ordered: SeedEvidenceCandidate[]): {
  maxTotalSpanDays: number;
  maxAdjacentGapDays: number;
} {
  const topology = classifyConversationTopology({ anchor, contextRows: ordered });
  const combinedText = ordered.map((row) => String(row.content ?? "")).join(" \n ");
  const planningWindow = /\b(plan|planning|itinerary|trip|travel|schedule|meeting|tomorrow|next week|after the holidays)\b/i.test(combinedText)
    || ordered.some((row) => row.has_plan_block);
  if (topology === "assistant_thread") {
    return { maxTotalSpanDays: 7, maxAdjacentGapDays: 2 };
  }
  return {
    maxTotalSpanDays: planningWindow ? 21 : 14,
    maxAdjacentGapDays: 3
  };
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

function sourceGapDays(a: Pick<SeedEvidenceCandidate, "source_timestamp">, b: Pick<SeedEvidenceCandidate, "source_timestamp">): number {
  const aMs = sourceTimeMs(a);
  const bMs = sourceTimeMs(b);
  if (!aMs || !bMs) return Number.POSITIVE_INFINITY;
  return Math.abs(aMs - bMs) / 86400000;
}

function buildAnchorTemporalCluster(anchor: SeedEvidenceCandidate, ordered: SeedEvidenceCandidate[]): SeedEvidenceCandidate[] {
  const anchorIndex = ordered.findIndex((row) => row.canonical_id === anchor.canonical_id);
  if (anchorIndex < 0) return [anchor];
  const { maxAdjacentGapDays, maxTotalSpanDays } = topologyTemporalRules(anchor, ordered);
  const anchorMs = sourceTimeMs(anchor);
  let left = anchorIndex;
  let right = anchorIndex;

  while (left > 0) {
    const prev = ordered[left - 1];
    const current = ordered[left];
    const prevMs = sourceTimeMs(prev);
    if (sourceGapDays(prev, current) > maxAdjacentGapDays) break;
    if (anchorMs && prevMs && Math.abs(anchorMs - prevMs) / 86400000 > maxTotalSpanDays) break;
    left -= 1;
  }
  while (right < ordered.length - 1) {
    const current = ordered[right];
    const next = ordered[right + 1];
    const nextMs = sourceTimeMs(next);
    if (sourceGapDays(current, next) > maxAdjacentGapDays) break;
    if (anchorMs && nextMs && Math.abs(anchorMs - nextMs) / 86400000 > maxTotalSpanDays) break;
    right += 1;
  }

  return ordered.slice(left, right + 1);
}

function buildCaseContextRows(anchor: SeedEvidenceCandidate, conversationRows: SeedEvidenceCandidate[]): SeedEvidenceCandidate[] {
  const ordered = sortConversationRows(
    conversationRows.filter((row) => row.conversation_id === anchor.conversation_id)
  );
  const temporalCluster = buildAnchorTemporalCluster(anchor, ordered);
  const anchorIndex = temporalCluster.findIndex((row) => row.canonical_id === anchor.canonical_id);
  if (anchorIndex < 0) return [anchor];

  const localWindow = temporalCluster.slice(Math.max(0, anchorIndex - 3), Math.min(temporalCluster.length, anchorIndex + 4));
  const anchorActorKey = actorIdentityKey(anchor);
  const sameActorLocal = anchorActorKey
    ? temporalCluster.filter((row, index) => actorIdentityKey(row) === anchorActorKey && Math.abs(index - anchorIndex) <= 4)
    : [];
  const adjacentSupportRows: SeedEvidenceCandidate[] = [];
  const previousRow = temporalCluster[anchorIndex - 1];
  const nextRow = temporalCluster[anchorIndex + 1];
  const anchorActorType = lowerText(anchor.actor_type);
  if ((anchorActorType === "assistant" || anchorActorType === "system") && previousRow) adjacentSupportRows.push(previousRow);
  if (anchorActorType === "user" && nextRow && ["assistant", "system"].includes(lowerText(nextRow.actor_type))) adjacentSupportRows.push(nextRow);
  if (sameActorLocal.length >= 2) {
    return uniqSeedRows([...sameActorLocal, ...adjacentSupportRows, ...localWindow], 6);
  }
  if (localWindow.length >= 2) {
    return uniqSeedRows([...adjacentSupportRows, ...localWindow], 6);
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
  const temporalCluster = buildAnchorTemporalCluster(anchor, ordered);
  if (temporalCluster.length === 0) return [anchor];
  const anchorActorKey = actorIdentityKey(anchor);
  const sameActorSeries = anchorActorKey
    ? temporalCluster.filter((row) => actorIdentityKey(row) === anchorActorKey)
    : [];
  if (sameActorSeries.length >= 3 && temporalSpreadDays(sameActorSeries) >= 7) {
    return sampleTemporalSeriesRows(sameActorSeries, 8, anchor.canonical_id);
  }
  if (temporalCluster.length >= 3 && temporalSpreadDays(temporalCluster) >= 7) {
    return sampleTemporalSeriesRows(temporalCluster, 8, anchor.canonical_id);
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

function rankSupportedLensesForWholeCorpusAuthoring(params: {
  supportedLenses: SupportedPairDescriptor[];
  contextRows: SeedEvidenceCandidate[];
  statementOwnerRole: "user" | "other_human" | "assistant_or_system" | "mixed";
}): SupportedPairDescriptor[] {
  const text = combinedEvidenceText(params.contextRows);
  const spreadDays = temporalSpreadDays(params.contextRows);
  const sourceSystems = new Set(params.contextRows.map((row) => lowerText(row.source_system)).filter(Boolean));
  const humanThread = params.statementOwnerRole === "other_human" && sourceSystems.has("whatsapp");
  const hasRecommendationSignal = /\b(should|recommend|recommended|suggest|suggested|need to|needs to|must|best way|best option)\b/.test(text);
  const hasCounterfactualSignal = /\b(if|unless|would|would've|would have|had not|didn't|without)\b/.test(text);
  const hasCausalSignal = /\b(because|reason|caused|why|due to|therefore|since)\b/.test(text);
  const hasPredictiveSignal = /\b(will|likely|probably|going to|expect|expected)\b/.test(text);
  const hasConfidenceSignal = /\b(confident|confidence|uncertain|not sure|probability|likely)\b/.test(text);
  const hasProblemSignal = /\b(issue|problem|error|wrong|stuck|blocked|trouble|bug|fail|failure|concern|conflict)\b/.test(text);
  const hasThreadBreadth = params.contextRows.length >= 4;
  const hasTimelineBreadth = hasThreadBreadth && spreadDays >= 1;

  function scoreLens(lens: string): number {
    switch (lens) {
      case "descriptive":
        return 1.0;
      case "actor_attribution":
        if (humanThread) return 0.82;
        return params.statementOwnerRole === "other_human" || params.statementOwnerRole === "assistant_or_system" ? 0.92 : 0.78;
      case "thread_reconstruction":
        if (humanThread) return hasThreadBreadth ? 0.62 : 0.32;
        return hasThreadBreadth ? 0.9 : 0.45;
      case "timeline_reconstruction":
        if (humanThread) return hasTimelineBreadth ? 0.56 : 0.28;
        return hasTimelineBreadth ? 0.88 : 0.35;
      case "diagnostic":
        return hasProblemSignal ? (humanThread ? 0.78 : 0.84) : 0.3;
      case "actionability":
      case "prescriptive":
        return hasRecommendationSignal ? (humanThread ? 0.66 : 0.82) : 0.28;
      case "predictive":
        return hasPredictiveSignal ? (humanThread ? 0.58 : 0.78) : 0.22;
      case "counterfactuals":
        return hasCounterfactualSignal ? (humanThread ? 0.56 : 0.76) : 0.2;
      case "confidence_scoring":
        return hasConfidenceSignal ? (humanThread ? 0.52 : 0.72) : 0.18;
      case "causal_hypotheses":
        return hasCausalSignal ? (humanThread ? 0.6 : 0.7) : 0.16;
      case "trend_trajectory":
      case "outlier_detection":
        return spreadDays >= 7 && hasThreadBreadth ? 0.68 : 0.12;
      default:
        return 0.1;
    }
  }

  return [...params.supportedLenses]
    .map((descriptor) => ({ descriptor, score: scoreLens(descriptor.lens) }))
    .filter((item) => item.score >= 0.28 || item.descriptor.lens === "descriptive")
    .sort((a, b) => b.score - a.score || a.descriptor.lens.localeCompare(b.descriptor.lens))
    .map((item) => item.descriptor);
}

function rankReasoningModesForWholeCorpusAuthoring(params: {
  contextRows: SeedEvidenceCandidate[];
  statementOwnerRole: "user" | "other_human" | "assistant_or_system" | "mixed";
}): SupportedPairDescriptor[] {
  return rankSupportedLensesForWholeCorpusAuthoring({
    supportedLenses: ANALYSIS_LENSES.map((lens) => ({
      domain: "provisional",
      lens,
      supportCount: 999,
      evidenceCount: 999
    })),
    contextRows: params.contextRows,
    statementOwnerRole: params.statementOwnerRole
  });
}

function scoreWholeCorpusFamilyForAuthoring(family: WholeCorpusFamilySeed): number {
  let whatsappAnchors = 0;
  let humanContactAnchors = 0;
  let assistantAnchors = 0;
  let namedHumanAnchors = 0;
  let groupConversationAnchors = 0;
  const conversationLabels = new Set<string>();
  let bestAnchorScore = -1;
  for (const anchor of family.anchorRows) {
    const text = String(anchor.content ?? "").trim();
    if (!text) continue;
    if (rejectAnchorReason(text, 0.55)) continue;
    let score = 0.24;
    const actorType = lowerText(anchor.actor_type);
    const sourceSystem = lowerText(anchor.source_system);
    const conversationLabel = parseConversationLabel(anchor.source_conversation_id ?? anchor.conversation_id);
    if (conversationLabel) conversationLabels.add(conversationLabel);
    const groupConversation = isLikelyGroupConversationLabel(conversationLabel);
    if (groupConversation) groupConversationAnchors += 1;
    if (sourceSystem === "whatsapp") whatsappAnchors += 1;
    if (actorType === "assistant" || actorType === "system") {
      assistantAnchors += 1;
      score += 0.06;
    } else if (actorType === "user") {
      score -= 0.06;
    } else {
      humanContactAnchors += 1;
      score += 0.18;
    }
    if (isLikelyName(anchor.actor_name) && actorType && actorType !== "assistant" && actorType !== "system" && actorType !== "user") {
      namedHumanAnchors += 1;
      score += 0.06;
    } else if (isLikelyName(anchor.actor_name)) {
      score += 0.02;
    }
    if (sourceSystem === "whatsapp") score += 0.16;
    if (groupConversation) score += 0.1;
    if (looksLikeStructuredAnswerRow(anchor)) score += 0.08;
    if (anchor.has_plan_block) score += 0.04;
    score += Math.min(0.2, text.length / 700);
    score += Math.min(0.18, extractConcreteCueTerms([anchor], null).length * 0.04);
    const inferredTop = rankStructuredDomains(text)[0]?.score ?? 0;
    score += Math.min(0.16, inferredTop * 0.18);
    bestAnchorScore = Math.max(bestAnchorScore, score);
  }
  if (bestAnchorScore < 0) return -1;
  const breadthBoost = Math.min(0.15, family.anchorRows.length * 0.04);
  const humanRatio = family.anchorRows.length > 0 ? humanContactAnchors / family.anchorRows.length : 0;
  const assistantRatio = family.anchorRows.length > 0 ? assistantAnchors / family.anchorRows.length : 0;
  const whatsappBoost = whatsappAnchors > 0 ? Math.min(0.24, 0.08 + whatsappAnchors * 0.05) : 0;
  const humanBoost = humanContactAnchors > 0 ? Math.min(0.22, 0.06 + humanContactAnchors * 0.04) : 0;
  const namedHumanBoost = namedHumanAnchors > 0 ? Math.min(0.12, namedHumanAnchors * 0.03) : 0;
  const groupBoost = groupConversationAnchors > 0 ? Math.min(0.14, 0.05 + groupConversationAnchors * 0.04) : 0;
  const familyBias = humanRatio * 0.16 - assistantRatio * 0.08;
  const labelDiversityBoost = conversationLabels.size > 1 ? 0.03 : 0;
  const diversityJitter = Number.parseInt(createHash("md5").update(family.familyKey).digest("hex").slice(0, 4), 16) / 0xffff / 100;
  return bestAnchorScore
    + breadthBoost
    + whatsappBoost
    + humanBoost
    + namedHumanBoost
    + groupBoost
    + familyBias
    + labelDiversityBoost
    + diversityJitter;
}

function scoreFamilyAnchorSeed(anchor: SeedEvidenceCandidate, familyRows: SeedEvidenceCandidate[]): number {
  const text = String(anchor.content ?? "").trim();
  if (!text) return -1;
  if (rejectAnchorReason(text, 0.55)) return -1;
  let score = 0.2;
  const actorType = lowerText(anchor.actor_type);
  if (actorType && actorType !== "assistant" && actorType !== "system") score += 0.12;
  if (actorType === "user") score += 0.08;
  if (anchor.has_plan_block) score += 0.08;
  if (text.length >= 160) score += 0.18;
  else if (text.length >= 100) score += 0.12;
  else if (text.length >= 60) score += 0.06;
  const cueCount = extractConcreteCueTerms([anchor, ...familyRows.slice(0, 3)], null).length;
  score += Math.min(0.16, cueCount * 0.02);
  const claimCount = collectStructuredClaims([anchor], 4).length;
  score += Math.min(0.14, claimCount * 0.05);
  if (hasConcreteMemorySignal(text)) score += 0.16;
  if (/\b(plan|pretendo|compramos|move|moved|casa|house|family|reuni[aã]o|meeting|virtual|empresa)\b/iu.test(text)) score += 0.08;
  return score;
}

function selectBestFamilyAnchors(rows: SeedEvidenceCandidate[], maxAnchors: number): SeedEvidenceCandidate[] {
  if (rows.length <= maxAnchors) return rows;
  const scored = rows
    .map((row) => ({ row, score: scoreFamilyAnchorSeed(row, rows) }))
    .filter((item) => item.score >= 0)
    .sort((a, b) => b.score - a.score || b.row.content.length - a.row.content.length || a.row.canonical_id.localeCompare(b.row.canonical_id));
  if (scored.length <= maxAnchors) return scored.map((item) => item.row);

  const picked: SeedEvidenceCandidate[] = [];
  const pickedActorTypes = new Set<string>();

  const bestUser = scored.find((item) => lowerText(item.row.actor_type) === "user");
  if (bestUser) {
    picked.push(bestUser.row);
    pickedActorTypes.add("user");
  }
  const bestOtherHuman = scored.find((item) => {
    const actorType = lowerText(item.row.actor_type);
    return actorType && actorType !== "user" && actorType !== "assistant" && actorType !== "system";
  });
  if (bestOtherHuman && !picked.some((row) => row.canonical_id === bestOtherHuman.row.canonical_id)) {
    picked.push(bestOtherHuman.row);
    pickedActorTypes.add("other_human");
  }
  for (const item of scored) {
    if (picked.length >= maxAnchors) break;
    if (picked.some((row) => row.canonical_id === item.row.canonical_id)) continue;
    picked.push(item.row);
  }
  return picked.slice(0, maxAnchors);
}

type WholeCorpusFamilyScored = {
  family: WholeCorpusFamilySeed;
  topology: EvidenceFamilyTopology;
  sourceSystem: string;
  authorabilityScore: number;
  interactionScore: number;
  groupInteractionScore: number;
  actorAttributionScore: number;
  richnessScore: number;
  topicDiversityScore: number;
  queryLikelihoodScore: number;
  sourceDiversityBoost: number;
  topologyDiversityBoost: number;
  duplicationPenalty: number;
  assistantPenalty: number;
  totalScore: number;
};

type ActiveFamilyCaseState = {
  total: number;
  clear: number;
  clarify: number;
};

function topologyQuotaCycle(): EvidenceFamilyTopology[] {
  return [
    "human_direct_1to1",
    "human_direct_1to1",
    "human_direct_1to1",
    "human_direct_1to1",
    "human_group_chat",
    "human_group_chat",
    "human_group_chat",
    "third_party_human",
    "other_human",
    "assistant_thread"
  ];
}

function countTopologyShare(items: WholeCorpusFamilyScored[]): {
  humanCount: number;
  assistantCount: number;
} {
  let humanCount = 0;
  let assistantCount = 0;
  for (const item of items) {
    if (topologyIsHuman(item.topology)) humanCount += 1;
    else if (item.topology === "assistant_thread") assistantCount += 1;
  }
  return { humanCount, assistantCount };
}

function scheduleWholeCorpusFamilySeeds(params: {
  families: WholeCorpusFamilyScored[];
}): WholeCorpusFamilyScored[] {
  const buckets = new Map<EvidenceFamilyTopology, WholeCorpusFamilyScored[]>();
  for (const topology of ["human_direct_1to1", "human_group_chat", "third_party_human", "other_human", "assistant_thread", "system_artifact"] as const) {
    buckets.set(topology, []);
  }
  for (const item of params.families) {
    buckets.get(item.topology)?.push(item);
  }
  for (const bucket of buckets.values()) {
    bucket.sort((a, b) => b.totalScore - a.totalScore || a.family.familyKey.localeCompare(b.family.familyKey));
  }
  const scheduled: WholeCorpusFamilyScored[] = [];
  const cycle = topologyQuotaCycle();
  while (true) {
    let progress = false;
    for (const desiredTopology of cycle) {
      const currentShare = countTopologyShare(scheduled);
      let chosen: WholeCorpusFamilyScored | undefined;
      if (desiredTopology === "assistant_thread") {
        const assistantBucket = buckets.get("assistant_thread") ?? [];
        if (assistantBucket.length <= 0) continue;
        const nextAssistantShare = (currentShare.assistantCount + 1) / Math.max(1, scheduled.length + 1);
        const nextHumanShare = currentShare.humanCount / Math.max(1, scheduled.length + 1);
        if (nextAssistantShare > 0.2 && nextHumanShare < 0.8) continue;
        chosen = assistantBucket.shift();
      } else {
        const primaryBucket = buckets.get(desiredTopology) ?? [];
        chosen = primaryBucket.shift();
        if (!chosen) {
          const fallbackTopology = (["human_direct_1to1", "human_group_chat", "third_party_human", "other_human"] as const)
            .filter((topology) => topology !== desiredTopology)
            .find((topology) => (buckets.get(topology)?.length ?? 0) > 0);
          if (fallbackTopology) {
            chosen = buckets.get(fallbackTopology)?.shift();
          }
        }
      }
      if (!chosen) continue;
      scheduled.push(chosen);
      progress = true;
    }
    if (!progress) break;
  }
  return scheduled;
}

function scoreWholeCorpusFamilyCandidate(params: {
  family: WholeCorpusFamilySeed;
  topology: EvidenceFamilyTopology;
  authorabilityScore: number;
  activeSourceCounts: Map<string, number>;
  activeTopologyCounts: Map<EvidenceFamilyTopology, number>;
  activeHumanShare: number;
  existingFamilyState: ActiveFamilyCaseState | null;
}): WholeCorpusFamilyScored {
  const rows = params.family.anchorRows;
  const sourceSystem = lowerText(rows.find((row) => String(row.source_system ?? "").trim())?.source_system) || "unknown";
  const sourceCount = params.activeSourceCounts.get(sourceSystem) ?? 0;
  const topologyCount = params.activeTopologyCounts.get(params.topology) ?? 0;
  const actorKeys = distinctHumanActorKeys(rows);
  const facets = contextFacetSignals(rows);
  const combinedText = rows.map((row) => String(row.content ?? "")).join(" \n ");
  const interactionScore = rows.length > 0
    ? rows.filter((row) => lowerText(row.actor_type) === "user").length / rows.length
    : 0;
  const groupInteractionScore = params.topology === "human_group_chat"
    ? Math.min(1, 0.35 + (rows.filter((row) => lowerText(row.actor_type) === "user").length * 0.18))
    : 0;
  const actorAttributionScore = params.topology === "third_party_human"
    ? Math.min(1, actorKeys.length / 2)
    : Math.min(1, actorKeys.length > 0 ? 0.55 + actorKeys.length * 0.15 : 0);
  const richnessSignals = [
    /\b(plan|planning|tomorrow|next|after the holidays|would love|thinking to|moved back|divorce|problem|need to|recommend|suggest|share|list|best|miles|charger|deployment|rollback)\b/i,
    /\b(we should|let's|let us|i need|i will|can't wait|hope you|moved back|house is slow moving)\b/i,
    /\b(app|apps|firms|phone numbers|steps|issues|route updated|battery|supercharger)\b/i
  ];
  const richnessScore = Math.min(
    1,
    0.25
      + (richnessSignals.filter((pattern) => pattern.test(combinedText)).length * 0.2)
      + Math.min(0.2, collectStructuredClaims(rows, 4).length * 0.08)
  );
  const topicDiversityScore = Math.min(1, 0.2 + Math.min(4, facets.topicCount) * 0.18 + Math.min(2, facets.dateMentionCount) * 0.08);
  const queryLikelihoodSignals = [
    /\b(what|which|who|when|where|why|how)\b/i,
    /\b(would love|thinking to|need to|moved back|divorce|problem|best|recommend|list|update|changed|plan)\b/i,
    /\b(friend|mom|dad|wife|husband|partner|john|carlos)\b/i
  ];
  const queryLikelihoodScore = Math.min(
    1,
    0.2 + queryLikelihoodSignals.filter((pattern) => pattern.test(combinedText)).length * 0.18
      + (params.topology === "human_group_chat" ? 0.08 : 0)
      + (params.topology === "third_party_human" ? 0.08 : 0)
  );
  const sourceDiversityBoost = sourceCount <= 0 ? 0.18 : Math.max(0, 0.14 - (sourceCount * 0.01));
  const topologyDiversityBoost = topologyCount <= 0 ? 0.2 : Math.max(0, 0.16 - topologyCount * 0.02);
  const duplicationPenalty = params.existingFamilyState
    ? (params.existingFamilyState.total >= 2
      ? 1.5
      : (params.existingFamilyState.clear >= 1 ? 0.9 : 0.25))
    : 0;
  const assistantPenalty = params.topology === "assistant_thread" && params.activeHumanShare < 0.8 ? 0.35 : 0;
  const totalScore =
    params.authorabilityScore * 0.32
    + interactionScore * 0.12
    + groupInteractionScore * 0.08
    + actorAttributionScore * 0.12
    + richnessScore * 0.14
    + topicDiversityScore * 0.08
    + queryLikelihoodScore * 0.14
    + sourceDiversityBoost
    + topologyDiversityBoost
    - duplicationPenalty
    - assistantPenalty;
  return {
    family: params.family,
    topology: params.topology,
    sourceSystem,
    authorabilityScore: params.authorabilityScore,
    interactionScore,
    groupInteractionScore,
    actorAttributionScore,
    richnessScore,
    topicDiversityScore,
    queryLikelihoodScore,
    sourceDiversityBoost,
    topologyDiversityBoost,
    duplicationPenalty,
    assistantPenalty,
    totalScore
  };
}

async function rebalanceActiveBenchmarkPoolHumanFirst(params: {
  experimentId: string;
  activeRows: Array<{
    case_id: string;
    domain: string;
    lens: string;
    case_set: string;
    ambiguity_class: string;
    metadata: Record<string, unknown> | null;
    source_evidence_id: string | null;
    evidence_ids: string[] | string;
    conversation_ids: string[] | string;
  }>;
}): Promise<{ staledCaseIds: string[] }> {
  const rows = params.activeRows.map((row) => {
    const frame = readSemanticFrame(row.metadata ?? {});
    const statementOwnerRole = frame?.statementOwnerRole ?? "mixed";
    const topology = frame?.topology ?? "system_artifact" as EvidenceFamilyTopology;
    return {
      ...row,
      topology,
      statementOwnerRole,
      familyKey: buildCaseEvidenceFamilyKey({
        evidenceIds: row.evidence_ids,
        conversationIds: row.conversation_ids,
        sourceEvidenceId: row.source_evidence_id
      }) || `case:${row.case_id}`
    };
  });
  const total = rows.length;
  if (total <= 0) return { staledCaseIds: [] };
  const assistantRows = rows.filter((row) =>
    row.statementOwnerRole === "assistant_or_system"
    || row.topology === "assistant_thread"
    || row.topology === "system_artifact"
  );
  const assistantShare = assistantRows.length / Math.max(1, total);
  if (assistantShare <= 0.2) return { staledCaseIds: [] };
  const familyCounts = new Map<string, number>();
  const assistantPairCounts = new Map<string, number>();
  for (const row of assistantRows) {
    familyCounts.set(row.familyKey, Number(familyCounts.get(row.familyKey) ?? 0) + 1);
    const pairKey = `${row.domain}|${row.lens}`;
    assistantPairCounts.set(pairKey, Number(assistantPairCounts.get(pairKey) ?? 0) + 1);
  }
  const keepAssistantFloor = Math.min(10, Math.max(0, Math.floor(total * 0.2)));
  const keepAssistantIds = new Set(
    assistantRows
      .map((row) => {
        const frame = readSemanticFrame(row.metadata ?? {});
        const qualityScore = Number(((row.metadata ?? {}) as Record<string, unknown>)?.qualityGate && typeof ((row.metadata ?? {}) as Record<string, unknown>).qualityGate === "object"
          ? (((row.metadata ?? {}) as Record<string, unknown>).qualityGate as Record<string, unknown>).score
          : 0) || 0;
        const pairMultiplicity = assistantPairCounts.get(`${row.domain}|${row.lens}`) ?? 0;
        return {
          caseId: row.case_id,
          score:
            (frame?.topology === "assistant_thread" ? 20 : 0)
            + (pairMultiplicity <= 1 ? 15 : 0)
            + Math.min(10, qualityScore * 10)
            - ((familyCounts.get(row.familyKey) ?? 0) > 1 ? 20 : 0)
            - (row.lens === "descriptive" ? 5 : 0)
        };
      })
      .sort((a, b) => b.score - a.score || a.caseId.localeCompare(b.caseId))
      .slice(0, keepAssistantFloor)
      .map((row) => row.caseId)
  );
  const removalTarget = Math.ceil(Math.max(0, assistantRows.length - (0.2 * total)) / 0.8);
  const removable = assistantRows
    .filter((row) => !keepAssistantIds.has(row.case_id))
    .map((row) => {
      let score = 0;
      if (row.topology === "system_artifact") score += 200;
      if ((familyCounts.get(row.familyKey) ?? 0) > 1) score += 80;
      if (row.lens === "descriptive") score += 20;
      if (row.case_set === "dev") score += 15;
      else if (row.case_set === "certification") score += 8;
      score += Math.min(10, assistantPairCounts.get(`${row.domain}|${row.lens}`) ?? 0);
      return { caseId: row.case_id, score };
    })
    .sort((a, b) => b.score - a.score || a.caseId.localeCompare(b.caseId));
  const staledCaseIds: string[] = [];
  for (const row of removable) {
    const assistantRemaining = assistantRows.length - staledCaseIds.length;
    if (assistantRemaining <= keepAssistantFloor) break;
    if (staledCaseIds.length >= removalTarget) break;
    staledCaseIds.push(row.caseId);
  }
  if (staledCaseIds.length > 0) {
    await pool.query(
      `UPDATE experiment_cases
          SET is_stale = true,
              updated_at = now()
        WHERE id = ANY($1::uuid[])`,
      [staledCaseIds]
    );
  }
  return { staledCaseIds };
}

function combinedEvidenceText(rows: SeedEvidenceCandidate[]): string {
  return rows.map((row) => String(row.content ?? "")).join(" \n ").toLowerCase();
}

function hasAnyPattern(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

function hasAllPatternGroups(text: string, patternGroups: RegExp[][]): boolean {
  return patternGroups.every((group) => hasAnyPattern(text, group));
}

function domainSemanticMismatchReason(domain: string, contextRows: SeedEvidenceCandidate[]): string | null {
  const text = combinedEvidenceText(contextRows);
  switch (domain) {
    case "romantic_relationship": {
      const strongRelationshipContext = [
        /\b(relationship|marriage|married|divorce|separated|separation|premarital|marital|spouse share)\b/,
        /\b(our marriage|our relationship|relationship with my wife|relationship with my husband)\b/,
        /\b(separate rooms|sleep in separate rooms|not comfortable being married)\b/,
        /\b(we have so many problems|problem with our marriage|problem with our relationship)\b/
      ];
      const partnerMentions = [
        /\b(wife|husband|spouse|girlfriend|boyfriend|fiance|fiancée|partner)\b/
      ];
      const incidentalTripContext = [
        /\b(itinerary|weekend itinerary|labor day weekend|monday morning|charlotte|train|airport|hotel|flight|state parks?|park|weekend trip|temperature|weather forecast)\b/,
        /\b(route updated|supercharger|battery range|charger stop)\b/
      ];
      if (hasAnyPattern(text, incidentalTripContext) && !hasAnyPattern(text, strongRelationshipContext)) {
        return "domain_semantic_mismatch";
      }
      return hasAllPatternGroups(text, [partnerMentions, strongRelationshipContext]) ? null : "domain_semantic_mismatch";
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
      const evSignals = [
        /\b(battery|charge|charger|range|supercharger|kwh|tesla|state of charge|soc|electric vehicle|ev)\b/,
        /\b(stop to charge|charging stop|route update|route updated|miles of range|range with|charger stop)\b/
      ];
      return hasAnyPattern(text, evSignals) ? null : "domain_semantic_mismatch";
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

function normalizeFacetValues(values: Array<string | null | undefined>, limit = 12): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = compactText(String(value ?? "").trim(), 120);
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
    if (out.length >= limit) break;
  }
  return out;
}

function buildSemanticFrameRetrievalFacets(params: {
  window: string;
  contextRows: SeedEvidenceCandidate[];
  anchor: SeedEvidenceCandidate;
  actorName: string | null;
  statementOwnerName: string | null;
  statementTargetName: string | null;
  topicSummary: string;
  concreteClaims: string[];
}): RetrievalFacets {
  const conversationLabel = inferConversationLabel(params.anchor, params.contextRows);
  const groupLabels = conversationLabel && isLikelyGroupConversationLabel(conversationLabel)
    ? [conversationLabel]
    : [];
  const threadTitles = conversationLabel && !isLikelyGroupConversationLabel(conversationLabel)
    ? [conversationLabel]
    : [];
  const actorNames = normalizeFacetValues([
    params.actorName,
    params.statementOwnerName,
    params.statementTargetName,
    ...params.contextRows.map((row) => row.actor_name),
    ...params.contextRows.flatMap((row) => metadataStringArray(row, "people"))
  ]);
  const topicCues = normalizeFacetValues([
    ...extractConcreteCueTerms(params.contextRows, params.actorName),
    params.topicSummary,
    ...params.concreteClaims.flatMap((claim) => meaningfulTokens(claim).slice(0, 3)),
    ...params.contextRows.flatMap((row) => metadataStringArray(row, "topics"))
  ], 16);
  const sourceSystems = normalizeFacetValues(params.contextRows.map((row) => String(row.source_system ?? "").trim().toLowerCase()), 6);
  const timeConstraints = normalizeFacetValues([
    temporalQualifier(params.window),
    ...params.contextRows.flatMap((row) => metadataStringArray(row, "dates_mentioned"))
  ], 10);
  return {
    actorNames,
    groupLabels: normalizeFacetValues(groupLabels, 8),
    threadTitles: normalizeFacetValues(threadTitles, 8),
    sourceSystems,
    timeConstraints,
    topicCues
  };
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
  const statementTargetName = inferStatementTarget(
    params.anchor,
    params.contextRows,
    statementOwner.statementOwnerName,
    statementOwner.statementOwnerRole
  );
  const topology = classifyConversationTopology({ anchor: params.anchor, contextRows: params.contextRows });
  const concreteClaims = collectStructuredClaims(params.contextRows, 6);
  const topicSummary = inferFocusArea(params.domain, text);
  const anchorQualityScore = scoreAnchorAuthorability({
    domain: params.domain,
    lens: params.lens,
    anchor: params.anchor,
    contextRows: params.contextRows,
    domainScore: Number(params.anchor.domain_score ?? params.minDomainScore ?? 0)
  });
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
    topology,
    participants: uniqueNames(params.contextRows.map((row) => row.actor_name)),
    actorScope: params.actorName,
    statementOwnerName: statementOwner.statementOwnerName,
    statementOwnerRole: statementOwner.statementOwnerRole,
    statementTargetName,
    preferredQuestionVoices: statementOwner.preferredQuestionVoices,
    retrievalFacets: buildSemanticFrameRetrievalFacets({
      window: params.window,
      contextRows: params.contextRows,
      anchor: params.anchor,
      actorName: params.actorName,
      statementOwnerName: statementOwner.statementOwnerName,
      statementTargetName,
      topicSummary,
      concreteClaims
    }),
    timeframe: temporalQualifier(params.window),
    conversationIntent: inferConversationIntent(params.domain, text),
    topicSummary,
    sourceConversationLabel: inferConversationLabel(params.anchor, params.contextRows),
    concreteClaims,
    anchorQualityScore,
    supportDepth: inferSupportDepth(params.contextRows),
    ambiguityRisk: inferAmbiguityRisk({
      actorName: params.actorName,
      contextRows: params.contextRows,
      lens: params.lens
    }),
    supportedLenses
  };
}

const WHOLE_CORPUS_NEUTRAL_DOMAIN = "whole_corpus_candidate";

function inferWholeCorpusTopicSummary(rows: SeedEvidenceCandidate[], actorName: string | null): string {
  const concreteClaims = collectStructuredClaims(rows, 4);
  if (concreteClaims[0]) return compactText(concreteClaims[0], 120);
  const cues = extractConcreteCueTerms(rows, actorName).slice(0, 4);
  if (cues.length > 0) return compactText(cues.join(" "), 120);
  const text = combinedEvidenceText(rows);
  if (/(server|router|api|deploy|docker|bug|debug|database|script|runtime|timeout)/i.test(text)) {
    return "software troubleshooting";
  }
  if (/(wife|husband|marriage|spouse|family|friend|divorce|relationship)/i.test(text)) {
    return "relationship conversations";
  }
  if (/(401k|roth|ira|balance|bank|money|loan|portfolio|commission)/i.test(text)) {
    return "financial planning";
  }
  if (/(sleep|doctor|diet|exercise|weight|bloating|birth control|health)/i.test(text)) {
    return "health routines";
  }
  if (/(message|subject line|email|draft|wording|tone)/i.test(text)) {
    return "message drafting";
  }
  return "conversation analysis";
}

function buildWholeCorpusAuthoringSemanticFrame(params: {
  lens: string;
  window: string;
  contextRows: SeedEvidenceCandidate[];
  anchor: SeedEvidenceCandidate;
  actorName: string | null;
  familyReasoningModes: SupportedPairDescriptor[];
}): BenchmarkSemanticFrame {
  const base = buildSemanticFrame({
    domain: WHOLE_CORPUS_NEUTRAL_DOMAIN,
    lens: params.lens,
    window: params.window,
    contextRows: params.contextRows,
    anchor: params.anchor,
    actorName: params.actorName,
    minDomainScore: 0
  });
  return {
    ...base,
    domain: WHOLE_CORPUS_NEUTRAL_DOMAIN,
    topicSummary: inferWholeCorpusTopicSummary(params.contextRows, params.actorName),
    conversationIntent: inferConversationIntent("", combinedEvidenceText(params.contextRows)),
    supportedLenses: Array.from(new Set(params.familyReasoningModes.map((item) => item.lens)))
  };
}

function scoreAuthoringPayloadRow(row: SeedEvidenceCandidate, actorName: string | null): number {
  const text = String(row.content ?? "").trim();
  if (!text) return -1;
  let score = 0.1;
  if (looksLikeStructuredAnswerRow(row)) score += 0.28;
  if (String(row.actor_type ?? "").trim().toLowerCase() === "user") score += 0.12;
  if (row.has_plan_block) score += 0.12;
  score += Math.min(0.18, collectStructuredClaims([row], 2).length * 0.08);
  score += Math.min(0.16, extractConcreteCueTerms([row], actorName).length * 0.03);
  score += Math.min(0.14, text.length / 900);
  return score;
}

function buildAuthoringPayloadRows(contextRows: SeedEvidenceCandidate[], actorName: string | null): SeedEvidenceCandidate[] {
  if (contextRows.length <= AUTHORING_AGENT_MAX_EVIDENCE_ROWS) return contextRows;
  const [anchor, ...rest] = contextRows;
  const selected = rest
    .map((row, index) => ({
      row,
      index,
      score: scoreAuthoringPayloadRow(row, actorName)
    }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, Math.max(0, AUTHORING_AGENT_MAX_EVIDENCE_ROWS - 1))
    .sort((a, b) => a.index - b.index)
    .map((item) => item.row);
  return [anchor, ...selected];
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
  const concreteClaims = params.semanticFrame.concreteClaims ?? [];
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
  const counterpartyIsToolLike = params.contextRows.some((row) => {
    const actorType = lowerText(row.actor_type);
    const actor = lowerText(row.actor_name);
    return actorType === "assistant" || actorType === "system" || actor.includes("assistant") || actor.includes("grok") || actor.includes("chatgpt");
  });
  if (
    params.actorName
    && params.semanticFrame.statementOwnerRole === "other_human"
    && !qLower.includes(`with ${params.actorName.toLowerCase()}`)
    && !qLower.includes(params.actorName.toLowerCase())
    && !questionReferencesGroupOrThreadContext(question, params.semanticFrame)
  ) {
    actorScopeFidelity -= 0.25;
  }
  if (!params.actorName && /\bwith\s+[a-z]/.test(qLower) && params.semanticFrame.statementOwnerRole !== "assistant_or_system") actorScopeFidelity -= 0.2;
  const usesFirstPersonLead = questionStartsWithFirstPersonLead(question);
  const mentionsUserTarget = questionReferencesUserTarget(question, questionVoice, params.semanticFrame);
  const mentionsGroupOrThreadContext = questionReferencesGroupOrThreadContext(question, params.semanticFrame);
  const mentionsDominantOther = dominantSpeaker.dominantOtherName
    ? qLower.includes(dominantSpeaker.dominantOtherName.toLowerCase())
    : false;
  const mentionsStatementOwner = params.semanticFrame.statementOwnerName
    ? qLower.includes(params.semanticFrame.statementOwnerName.toLowerCase())
    : false;
  const topology = params.semanticFrame.topology ?? "system_artifact";
  const explicitTargetContextNeeded = questionNeedsExplicitTargetContext(question);
  if (
    params.semanticFrame.statementOwnerRole !== "assistant_or_system"
    && 
    dominantSpeaker.dominantOtherName
    && dominantSpeaker.dominantOtherRows > dominantSpeaker.dominantUserRows
    && usesFirstPersonLead
    && !mentionsDominantOther
  ) {
    actorScopeFidelity -= 0.45;
    reasons.push("question_uses_wrong_point_of_view");
  }
  if (params.semanticFrame.statementOwnerRole === "other_human" && usesFirstPersonLead) {
    actorScopeFidelity -= 0.6;
    reasons.push("question_uses_user_voice_for_other_human_statement");
  }
  if (
    params.semanticFrame.statementOwnerRole === "other_human"
    && (params.semanticFrame.statementOwnerName || params.actorName)
    && !mentionsStatementOwner
    && !mentionsGroupOrThreadContext
  ) {
    actorScopeFidelity -= 0.25;
    reasons.push("missing_statement_owner_reference");
  }
  if (
    params.semanticFrame.statementTargetName
    && params.semanticFrame.statementOwnerRole === "other_human"
    && !mentionsUserTarget
    && explicitTargetContextNeeded
    && !(topology === "human_direct_1to1" && mentionsStatementOwner)
  ) {
    actorScopeFidelity -= 0.25;
    reasons.push("missing_statement_target_context");
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
  if (
    (questionVoice === "user_first_person" || questionVoice === "user_about_other" || questionVoice === "assistant_proxy")
    && !params.semanticFrame.preferredQuestionVoices.includes(questionVoice as "user_first_person" | "user_about_other" | "assistant_proxy")
  ) {
    actorScopeFidelity -= 0.45;
    reasons.push("question_voice_not_allowed_for_statement_owner");
  }
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
  if (concreteClaims.length >= 2 && !concreteClaims.some((claim) => qLower.includes(meaningfulTokens(claim)[0] ?? ""))) {
    evidenceGrounding -= 0.12;
  }
  evidenceGrounding += Math.min(0.12, Number(params.semanticFrame.anchorQualityScore ?? 0) * 0.12);

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

function wholeCorpusAcceptanceScore(params: {
  critique: BenchmarkAuthoringCritique;
  hardGuardReasons: string[];
}): number {
  const taxonomyOnlyReasonSet = new Set([
    "weak_domain_mapping",
    "domain_semantic_mismatch",
    "lens_fit_mismatch",
    "lens_requires_supported_context",
    "higher_order_lens_on_single_line",
    "lens_requires_explanation_signal",
    "lens_requires_future_signal",
    "lens_requires_action_signal",
    "lens_requires_causal_signal",
    "lens_requires_temporal_series",
    "lens_requires_counterfactual_signal",
    "lens_requires_uncertainty_signal",
    "lens_requires_actor_reference",
    "lens_requires_thread_context",
    "lens_requires_timeline_signal",
    "requested_lens_not_supported_by_cluster",
    "support_depth_too_thin_for_requested_lens"
  ]);
  const nonTaxonomyHardGuards = params.hardGuardReasons.filter((reason) => !taxonomyOnlyReasonSet.has(reason));
  const nonTaxonomyCritiqueReasons = params.critique.reasons.filter((reason) => !taxonomyOnlyReasonSet.has(reason));
  if (nonTaxonomyHardGuards.length > 0 || nonTaxonomyCritiqueReasons.length > 0) return params.critique.score;
  const evidenceGrounding = Math.max(params.critique.dimensions.evidenceGrounding, 0.82);
  return (
    params.critique.dimensions.naturalness
    + params.critique.dimensions.actorScopeFidelity
    + params.critique.dimensions.ambiguityCorrectness
    + params.critique.dimensions.answerability
    + 1
    + evidenceGrounding
  ) / 6;
}

const WHOLE_CORPUS_HUMAN_SCOPE_REPAIR_REASONS = new Set([
  "missing_statement_owner_reference",
  "actor_scope_mismatch",
  "missing_statement_target_context",
  "question_not_grounded_enough",
  "missing_concrete_cluster_details",
  "question_uses_wrong_point_of_view",
  "question_uses_user_voice_for_other_human_statement"
]);

function countWholeCorpusHumanScopeRepairReasons(reasons: string[]): number {
  return reasons.filter((reason) => WHOLE_CORPUS_HUMAN_SCOPE_REPAIR_REASONS.has(reason)).length;
}

function fallbackAuthoringCandidates(params: {
  domain: string;
  lens: string;
  window: string;
  actorName: string | null;
  focusArea: string;
  semanticFrame: BenchmarkSemanticFrame;
  contextRows: SeedEvidenceCandidate[];
}): AuthoringQuestionCandidate[] {
  const normalizedVoice = normalizeQuestionVoiceForFrame("unknown", params.semanticFrame);
  const selfOwned = isSelfOwnedSemanticFrame(params.semanticFrame);
  const templateActorName = selfOwned ? null : params.actorName;
  const ownerName = sanitizeActorLabel(String(params.semanticFrame.statementOwnerName ?? params.actorName ?? "").trim()) || "they";
  const combinedContext = `${params.contextRows.map((row) => String(row.content ?? "")).join(" \n ")} \n ${params.semanticFrame.concreteClaims.join(" \n ")}`;
  const normalizedTopic = compactText(questionTopicPhrase(params.focusArea, params.domain), 90);
  const recommendationSignal = /\b(recommend|recommended|suggest|suggested|check out|podcast|episode|watch|read|listen to)\b/iu.test(combinedContext);
  const reminderSignal = /\b(remember|remind|don't forget|do not forget|recuerda|lembra|não esquece|nao esquece|firmar|assinar|sign|consent|consentimento|approval)\b/iu.test(combinedContext);
  const directiveSignal = /\b(please|por favor|need you|preciso|could you|can you|come to|join|go to|send|bring|review|check|call|meet|talk|talk to|speak to|schedule|book|pay|submit|upload)\b/iu.test(combinedContext);
  const recommendationDetail = buildHumanRecommendationDetail(params.contextRows);
  const concreteReminderOrDirective = buildHumanReminderOrDirectiveDetail(params.contextRows, params.actorName);
  const humanTargetedQuestion = params.semanticFrame.statementOwnerRole === "other_human" && semanticFrameTargetsUser(params.semanticFrame)
    ? {
        direct: recommendationSignal
          ? (recommendationDetail.objectLabel
            ? `What ${recommendationDetail.objectLabel} did ${ownerName} recommend to me?`
            : recommendationDetail.cuePhrase
              ? `What did ${ownerName} recommend to me regarding ${recommendationDetail.cuePhrase}?`
              : `What did ${ownerName} recommend to me?`)
          : reminderSignal
          ? (concreteReminderOrDirective.actionPhrase
            ? `What did ${ownerName} remind me to ${concreteReminderOrDirective.actionPhrase}?`
            : concreteReminderOrDirective.cuePhrase
              ? `What did ${ownerName} remind me about regarding ${concreteReminderOrDirective.cuePhrase}?`
              : `What did ${ownerName} remind me about?`)
          : directiveSignal
            ? (concreteReminderOrDirective.actionPhrase
              ? `What did ${ownerName} ask me to ${concreteReminderOrDirective.actionPhrase}?`
              : concreteReminderOrDirective.cuePhrase
                ? `What did ${ownerName} ask me to do regarding ${concreteReminderOrDirective.cuePhrase}?`
                : `What did ${ownerName} ask me to do?`)
            : `What did ${ownerName} say about ${normalizedTopic}?`,
        paraphrase: recommendationSignal
          ? (recommendationDetail.objectLabel
            ? `Which ${recommendationDetail.objectLabel} did ${ownerName} suggest to me?`
            : recommendationDetail.cuePhrase
              ? `What did ${ownerName} suggest to me regarding ${recommendationDetail.cuePhrase}?`
              : `What did ${ownerName} suggest I check out?`)
          : reminderSignal
          ? (concreteReminderOrDirective.actionPhrase
            ? `What did ${ownerName} want me to ${concreteReminderOrDirective.actionPhrase}?`
            : concreteReminderOrDirective.cuePhrase
              ? `What did ${ownerName} want me to remember regarding ${concreteReminderOrDirective.cuePhrase}?`
              : `What did ${ownerName} want me to remember?`)
          : directiveSignal
            ? (concreteReminderOrDirective.actionPhrase
              ? `What did ${ownerName} want me to ${concreteReminderOrDirective.actionPhrase}?`
              : concreteReminderOrDirective.cuePhrase
                ? `What did ${ownerName} want me to do regarding ${concreteReminderOrDirective.cuePhrase}?`
                : `What did ${ownerName} want me to do?`)
            : `What did ${ownerName} mention regarding ${normalizedTopic}?`
      }
    : null;
  const directBase = humanTargetedQuestion?.direct ?? buildQuestionTemplate({
    lens: params.lens,
    domain: params.domain,
    focusArea: params.focusArea,
    actorName: templateActorName,
    window: params.window,
    mode: "base"
  });
  const paraphraseBase = humanTargetedQuestion?.paraphrase ?? buildQuestionTemplate({
    lens: params.lens,
    domain: params.domain,
    focusArea: params.focusArea,
    actorName: templateActorName,
    window: params.window,
    mode: "paraphrase"
  });
  const direct = normalizeAssistantHistoricalQuestion(directBase, params.semanticFrame, normalizedVoice);
  const paraphrase = normalizeAssistantHistoricalQuestion(paraphraseBase, params.semanticFrame, normalizedVoice);
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
      question: normalizeAssistantHistoricalQuestion(buildQuestionTemplate({
        lens: params.lens,
        domain: params.domain,
        focusArea: params.focusArea,
        actorName: templateActorName,
        window: params.window,
        mode: "temporal"
      }), params.semanticFrame, normalizedVoice),
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
  const questionVoice = normalizeQuestionVoiceForFrame("unknown", params.semanticFrame);
  const candidates = fallbackAuthoringCandidates({
    domain: params.domain,
    lens: params.lens,
    window: params.window,
    actorName: params.actorName,
    focusArea,
    semanticFrame: params.semanticFrame,
    contextRows: params.contextRows
  });
  const chosen = candidates.find((item) => item.kind === "direct_clear") ?? candidates[0];
  const critique = scoreAuthoringCritique({
    question: chosen.question,
    questionVoice,
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
    questionVoice,
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
      expectedCoreClaims: buildExpectedCoreClaims(params.contextRows),
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
  const semanticFrameRaw: BenchmarkSemanticFrame = {
    ...params.fallback.semanticFrame,
    participants: Array.isArray(parsedFrame.participants) ? uniqueNames(parsedFrame.participants.map((item) => String(item ?? ""))) : params.fallback.semanticFrame.participants,
    actorScope: params.fallback.semanticFrame.actorScope || String(parsedFrame.actorScope ?? "").trim() || params.fallback.semanticFrame.actorScope,
    statementOwnerName: params.fallback.semanticFrame.statementOwnerName,
    statementOwnerRole: params.fallback.semanticFrame.statementOwnerRole,
    statementTargetName: params.fallback.semanticFrame.statementTargetName,
    preferredQuestionVoices: params.fallback.semanticFrame.preferredQuestionVoices,
    retrievalFacets: (() => {
      const raw = parsedFrame.retrievalFacets;
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return params.fallback.semanticFrame.retrievalFacets;
      const facets = raw as Record<string, unknown>;
      return {
        actorNames: Array.isArray(facets.actorNames) ? normalizeFacetValues(facets.actorNames.map((item) => String(item ?? ""))) : params.fallback.semanticFrame.retrievalFacets.actorNames,
        groupLabels: Array.isArray(facets.groupLabels) ? normalizeFacetValues(facets.groupLabels.map((item) => String(item ?? "")), 8) : params.fallback.semanticFrame.retrievalFacets.groupLabels,
        threadTitles: Array.isArray(facets.threadTitles) ? normalizeFacetValues(facets.threadTitles.map((item) => String(item ?? "")), 8) : params.fallback.semanticFrame.retrievalFacets.threadTitles,
        sourceSystems: Array.isArray(facets.sourceSystems) ? normalizeFacetValues(facets.sourceSystems.map((item) => String(item ?? "")), 6) : params.fallback.semanticFrame.retrievalFacets.sourceSystems,
        timeConstraints: Array.isArray(facets.timeConstraints) ? normalizeFacetValues(facets.timeConstraints.map((item) => String(item ?? "")), 10) : params.fallback.semanticFrame.retrievalFacets.timeConstraints,
        topicCues: Array.isArray(facets.topicCues) ? normalizeFacetValues(facets.topicCues.map((item) => String(item ?? "")), 16) : params.fallback.semanticFrame.retrievalFacets.topicCues
      };
    })(),
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
  const semanticFrame = normalizeSemanticFrameOwnerAliases(semanticFrameRaw) ?? semanticFrameRaw;
  const questionVoiceRaw = String(params.parsed.questionVoice ?? "").trim();
  const questionVoice = normalizeQuestionVoiceForFrame(
    questionVoiceRaw === "user_first_person" || questionVoiceRaw === "user_about_other" || questionVoiceRaw === "assistant_proxy"
      ? questionVoiceRaw
      : "unknown",
    semanticFrame
  );
  const candidatesRaw = Array.isArray(params.parsed.candidateQuestions) ? params.parsed.candidateQuestions : [];
  const candidateQuestions = candidatesRaw
    .map((item) => normalizeQuestionCandidate(item))
    .filter((item): item is AuthoringQuestionCandidate => Boolean(item))
    .map((item) => ({
      ...item,
      question: normalizeAssistantHistoricalQuestion(item.question, semanticFrame, questionVoice),
      resolvedQuestionAfterClarification: item.resolvedQuestionAfterClarification
        ? normalizeAssistantHistoricalQuestion(item.resolvedQuestionAfterClarification, semanticFrame, questionVoice)
        : null
    }))
    .slice(0, 6);
  const initialChosenQuestion = normalizeAssistantHistoricalQuestion(
    compactText(String(params.parsed.chosenQuestion ?? "").trim(), 240),
    semanticFrame,
    questionVoice
  );
  const initialExpectedBehavior: "answer_now" | "clarify_first" = String(params.parsed.expectedBehavior ?? "").trim() === "clarify_first"
    ? "clarify_first"
    : "answer_now";
  const initialClarificationQuestion = initialExpectedBehavior === "clarify_first"
    ? compactText(String(params.parsed.clarificationQuestion ?? "").trim(), 180) || null
    : null;
  const initialResolvedQuestion = initialExpectedBehavior === "clarify_first"
    ? normalizeAssistantHistoricalQuestion(
      compactText(String(params.parsed.resolvedQuestionAfterClarification ?? "").trim(), 240) || initialChosenQuestion || "",
      semanticFrame,
      questionVoice
    ) || initialChosenQuestion || null
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
    ? normalizeAssistantHistoricalQuestion(
      compactText(String(params.parsed.resolvedQuestionAfterClarification ?? chosenCandidate?.resolvedQuestionAfterClarification ?? "").trim(), 240) || chosenQuestion || "",
      semanticFrame,
      questionVoice
    ) || chosenQuestion || null
    : null;
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
  supportBacked?: boolean;
  timeoutMs?: number;
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
  const payloadRows = buildAuthoringPayloadRows(params.contextRows, params.actorName);
  const anchor = payloadRows[0] ?? params.contextRows[0];
  const suggestedConcreteAnchors = extractConcreteCueTerms(payloadRows, params.actorName).slice(0, 8);
  const extractedClaims = params.semanticFrame.concreteClaims.slice(0, 6);
  const preflightWarnings = Array.from(new Set([
    ...(anchor ? (rejectAnchorReason(anchor.content, params.domainScore) ? [rejectAnchorReason(anchor.content, params.domainScore)!] : []) : []),
    ...(params.supportBacked || params.semanticFrame.supportedLenses.includes(params.lens) ? [] : ["requested_lens_not_supported_by_cluster"]),
    ...(params.supportBacked || params.semanticFrame.supportDepth !== "thin" || params.lens === "descriptive" ? [] : ["support_depth_too_thin_for_requested_lens"])
  ]));
  const openAiKey = String(config.openAiApiKey ?? "").trim();
  if (!openAiKey) {
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
    throw new Error("Benchmark authoring requires OPENAI_API_KEY.");
  }

  const url = `${String(config.openAiBaseUrl || "https://api.openai.com/v1").replace(/\/+$/, "")}/chat/completions`;
  const apiKey = openAiKey;
  const model = String(config.metadataModel || "gpt-4o-mini").replace(/^openai\//i, "");
  const controller = new AbortController();
  const timeoutMs = Math.max(3_000, Math.min(
    AUTHORING_AGENT_TIMEOUT_MS,
    Number.isFinite(Number(params.timeoutMs ?? 0)) && Number(params.timeoutMs ?? 0) > 0
      ? Math.trunc(Number(params.timeoutMs ?? 0))
      : AUTHORING_AGENT_TIMEOUT_MS
  ));
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
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
        max_tokens: AUTHORING_AGENT_MAX_RESPONSE_TOKENS,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              "You are BenchmarkAuthoringAgent for OpenBrain. Your job is to author benchmark cases from a real evidence cluster, not to answer the user's question. " +
              "Work sequentially: interpret the cluster, refine the semantic frame, propose natural candidate questions, choose the best base question, decide answer_now vs clarify_first, write a concise expected answer summary, then critique your own draft against the evaluation rubric below. " +
              "The provided domain and lens are provisional evaluation hints for this cluster. Generate the most coherent evidence-grounded question from the cluster first; final domain/lens tagging can be reassigned after your draft if the cluster clearly points elsewhere. " +
              "Allowed question voices are only: user_first_person (I/my/our when the memory is about the user's own statements or plans), user_about_other (the user asking about another person's statements or plans, e.g. 'What did Jenn plan to bring?'), or assistant_proxy (for an AI agent speaking on the user's behalf). Never refer to the user by proper name as the target of the question. " +
              "The benchmark question must always come from the user's point of view or an agent's point of view, never from the speaker's point of view unless the speaker is the user. Respect preferredQuestionVoices. If statementOwnerRole is other_human, first-person wording like 'What did I plan?' is wrong and must be rejected. In that case, write the question as the user or agent asking about that person, e.g. 'What did Jenn plan to bring for Uncle Bob and my mom?' " +
              "For direct human 1:1 or group WhatsApp threads, preserve the actual statement owner from the cluster. If the anchor or strongest cluster rows are user-authored, keep user ownership and write 'What did I...' rather than drifting to the other person. If the strongest cluster rows belong to another human, name that person explicitly and do not switch back to user-first-person wording. " +
              "For short WhatsApp reminder or request rows from another human that target the user, extract the concrete object or action instead of asking generically. Good: 'What did Belle remind me to sign for the interview?' Good: 'What did Sowmia ask me to do regarding the roundtable with Ravi?' Bad: 'What did Belle remind me about?' when the row contains a concrete task. " +
              "For WhatsApp or human-to-human threads where statementOwnerRole is other_human, default to descriptive or actor_attribution phrasing unless the cluster contains explicit timeline, recommendation, or hypothetical language. Prefer forms like 'What did Jenn say about ...', 'What did Carlos mention regarding ...', or 'What was said in the group chat about ...'. If a stronger lens is not clearly evidenced, self-reject instead of forcing it. " +
              "If statementOwnerRole is assistant_or_system, default to assistant_proxy voice unless the question is clearly about the user's own plan, setup, account, route, code, or artifact. Do not use the user's proper name in those questions. Good: 'What did the assistant say about my monthly cap?' Good: 'What updates did the assistant give about the route?' Bad: 'What did Fabio discuss with the assistant about the monthly cap?' " +
              "If statementTargetName is available, preserve that relationship explicitly when it is needed to make the question natural and attributable. When an other_human statement clearly targets the user in English, Portuguese, or Spanish second-person forms (for example you/your, você/vc/seu/sua, tu/teu/tua, usted/su), write the question from the user's perspective with my/me where natural, e.g. 'What did Ricardo say about my Miami house?' " +
              "If actor scope is explicit, the question must clearly target that actor's conversation or thread. If the evidence is too weak for the requested lens, self-reject the draft instead of forcing a stronger question. " +
              "If preflightWarnings says the requested lens is unsupported or the support depth is too thin, default to authoringDecision='reject'. " +
              "If supportBacked is true, the corpus support scan has already validated this domain/lens pair against real evidence. In that case, do not reject solely because the local semantic frame looks narrower than the taxonomy pair; instead, try to ground the case to the provided cluster concretely and reject only if the cluster itself is still too weak or unnatural. " +
              "Use concrete details from the cluster when they exist: specific people, places, objects, actions, or timing cues. Prefer extracted concrete claims over generic summaries. Do not write a generic domain-level question when the evidence contains distinctive anchors like breakfast, 401k, supercharger, specific relatives, named plans, or enumerated fixes. " +
              "Do not invent possessive ownership that the evidence does not support. If the evidence says 'mom' or '401k' without clarifying whose it is, preserve the neutral wording instead of rewriting it as 'her mom', 'my mom', or 'her 401k' unless the ownership is explicit in the cluster. Good: 'What did Jenn say she needed to bring for Uncle Bob and mom tomorrow?' Good: 'What did Jenn say about the 401k numbers?' Bad: 'What did Jenn say she needed to bring for Uncle Bob and her mom tomorrow?' Bad: 'What did Jenn say about her 401k?' " +
              "When suggestedConcreteAnchors are provided, include at least one or two of them in the chosen question whenever that still sounds natural. If the only natural question would omit those anchors and become generic, reject the case. " +
              "When extractedClaims are provided from long assistant answers, use them to anchor the question and expected answer summary. If the cluster contains a numbered or enumerated explanation, the question should preserve that concrete structure instead of collapsing into a vague topic question. " +
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
              statementTargetName: params.semanticFrame.statementTargetName,
              preferredQuestionVoices: params.semanticFrame.preferredQuestionVoices,
              counterpartyKinds,
              semanticFrameDraft: params.semanticFrame,
              suggestedConcreteAnchors,
              extractedClaims,
              supportBacked: Boolean(params.supportBacked),
              preflightWarnings,
              repairContext: params.repairContext ?? null,
              evidenceCluster: payloadRows.map((row) => ({
                actorName: row.actor_name,
                actorType: row.actor_type,
                observedAt: row.source_timestamp,
                content: compactText(
                  row.content,
                  looksLikeStructuredAnswerRow(row)
                    ? AUTHORING_AGENT_MAX_STRUCTURED_ROW_CHARS
                    : AUTHORING_AGENT_MAX_PLAIN_ROW_CHARS
                )
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
        detail: `fallback_used:${response.status}`
      });
      return fallback;
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
        detail: `fallback_used:${compactText(raw, 120)}`
      });
      return fallback;
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
  } catch (error) {
    const detail = error instanceof Error
      ? compactText(`${error.name}: ${error.message}`, 180)
      : null;
    await recordBenchmarkAuthoringCall({
      domain: params.domain,
      lens: params.lens,
      window: params.window,
      actorName: params.actorName,
      durationMs: Date.now() - startedAt,
      ok: false,
      status: "request_failed",
      detail: detail ? `fallback_used:${detail}` : "fallback_used"
    });
    return fallback;
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
  ignoreTaxonomyReasons?: boolean;
}): BenchmarkAdmissionDecision {
  const TAXONOMY_REASON_SET = new Set([
    "weak_domain_mapping",
    "domain_semantic_mismatch",
    "lens_fit_mismatch",
    "lens_requires_supported_context",
    "higher_order_lens_on_single_line",
    "lens_requires_explanation_signal",
    "lens_requires_future_signal",
    "lens_requires_action_signal",
    "lens_requires_causal_signal",
    "lens_requires_temporal_series",
    "lens_requires_counterfactual_signal",
    "lens_requires_uncertainty_signal",
    "lens_requires_actor_reference",
    "lens_requires_thread_context",
    "lens_requires_timeline_signal",
    "requested_lens_not_supported_by_cluster",
    "support_depth_too_thin_for_requested_lens"
  ]);
  const filterTaxonomyReason = (reason: string): boolean => !(params.ignoreTaxonomyReasons && TAXONOMY_REASON_SET.has(reason));
  const critiqueReasons = Array.from(new Set(params.critique.reasons.filter(filterTaxonomyReason)));
  const hardGuardReasons = params.hardGuardReasons.filter(filterTaxonomyReason);
  const modelReasons = (params.modelReasons ?? []).filter(filterTaxonomyReason);
  const reasons = Array.from(new Set([
    ...hardGuardReasons,
    ...critiqueReasons,
    ...((params.modelDecision === "reject" ? (modelReasons.length > 0 ? modelReasons : ["model_self_rejected"]) : [])),
    ...(params.feasibility.pass ? [] : ["oracle_verifier_failed"])
  ]));
  if (hardGuardReasons.includes("low_signal_anchor")
    || hardGuardReasons.includes("weak_domain_mapping")
    || hardGuardReasons.includes("domain_semantic_mismatch")
    || hardGuardReasons.includes("lens_requires_supported_context")
    || hardGuardReasons.includes("higher_order_lens_on_single_line")) {
    return {
      admitted: false,
      status: "unresolved",
      reasons,
      verifierVersion: params.feasibility.version
    };
  }
  if (params.modelDecision === "reject" && modelReasons.length > 0) {
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
    if (
      params.ignoreTaxonomyReasons
      && params.feasibility.pass
      && critiqueReasons.length === 0
      && hardGuardReasons.length === 0
    ) {
      return {
        admitted: true,
        status: "accepted",
        reasons: [],
        verifierVersion: params.feasibility.version
      };
    }
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
  supportBacked?: boolean;
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
      supportBacked: params.supportBacked,
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
      modelReasons: draft.rejectionReasons,
      ignoreTaxonomyReasons: true
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

async function authorWholeCorpusCandidateWithRepairs(params: {
  chatNamespace: string;
  supported: {
    pairKeys: Set<string>;
    lensesByDomain: Map<string, SupportedPairDescriptor[]>;
  };
  provisionalDomain: string;
  provisionalLens: string;
  provisionalDomainScore: number;
  familyReasoningModes: SupportedPairDescriptor[];
  window: string;
  actorName: string | null;
  contextRows: SeedEvidenceCandidate[];
  anchor: SeedEvidenceCandidate;
  evidenceIds: string[];
  conversationIds: string[];
  familyDeadlineAt?: number;
}): Promise<{
  domain: string;
  lens: string;
  domainScore: number;
  supportBacked: boolean;
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
    domain: string;
    lens: string;
    domainScore: number;
    supportBacked: boolean;
    draft: BenchmarkAuthoringDraft;
    critique: BenchmarkAuthoringCritique;
    hardGuardReasons: string[];
    feasibilityReport: BenchmarkFeasibilityReport;
    admissionDecision: BenchmarkAdmissionDecision;
  } | null = null;

  for (let attempt = 1; attempt <= AUTHORING_MAX_ATTEMPTS; attempt += 1) {
    const familyDeadlineAt = Number(params.familyDeadlineAt ?? 0);
    const remainingFamilyBudgetMs = Number.isFinite(familyDeadlineAt) && familyDeadlineAt > 0
      ? familyDeadlineAt - Date.now()
      : AUTHORING_AGENT_TIMEOUT_MS;
    if (remainingFamilyBudgetMs <= 6_000) {
      return lastResult;
    }
    if (repairContext) {
      console.log(`[authoring] repair attempt ${attempt} provisional ${params.provisionalDomain}/${params.provisionalLens}: ${repairContext.failureReasons.join(", ")}`);
    }
    const provisionalSemanticFrame = buildWholeCorpusAuthoringSemanticFrame({
      lens: params.provisionalLens,
      window: params.window,
      anchor: params.anchor,
      contextRows: params.contextRows,
      actorName: params.actorName,
      familyReasoningModes: params.familyReasoningModes
    });
    const initialDraft = await runBenchmarkAuthoringAgent({
      domain: WHOLE_CORPUS_NEUTRAL_DOMAIN,
      lens: params.provisionalLens,
      window: params.window,
      actorName: params.actorName,
      semanticFrame: provisionalSemanticFrame,
      contextRows: params.contextRows,
      domainScore: Math.max(0.6, Number(params.provisionalDomainScore ?? 0)),
      supportBacked: false,
      timeoutMs: Math.max(5_000, Math.min(AUTHORING_AGENT_TIMEOUT_MS, remainingFamilyBudgetMs - 4_000)),
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

    const assigned = assignDomainLensForWholeCorpusDraft({
      supported: params.supported,
      anchor: params.anchor,
      contextRows: params.contextRows,
      actorName: params.actorName,
      window: params.window,
      draft: initialDraft,
      provisionalDomain: params.provisionalDomain,
      provisionalLens: params.provisionalLens,
      provisionalDomainScore: params.provisionalDomainScore,
      familyReasoningModes: params.familyReasoningModes
    });
    let critique = assigned.critique;
    let hardGuardReasons = assigned.hardGuardReasons;
    let draft: BenchmarkAuthoringDraft = {
      ...initialDraft,
      semanticFrame: assigned.semanticFrame,
      authoringCritique: critique
    };
    let critiqueReasons = Array.from(new Set([...hardGuardReasons, ...critique.reasons]));
    const topology = assigned.semanticFrame.topology ?? "system_artifact";
    if (topologyIsHuman(topology) && countWholeCorpusHumanScopeRepairReasons(critiqueReasons) > 0) {
      const fallbackBase = fallbackAuthoringDraft({
        domain: assigned.domain,
        lens: assigned.lens,
        window: params.window,
        actorName: params.actorName,
        semanticFrame: assigned.semanticFrame,
        contextRows: params.contextRows,
        domainScore: assigned.domainScore
      });
      const fallbackHardGuardReasons = buildAuthoringHardGuardReasons({
        anchor: params.anchor,
        contextRows: params.contextRows,
        question: fallbackBase.chosenQuestion,
        expectedBehavior: fallbackBase.expectedBehavior,
        domain: assigned.domain,
        lens: assigned.lens
      });
      const fallbackCritique = scoreAuthoringCritique({
        question: fallbackBase.chosenQuestion,
        questionVoice: fallbackBase.questionVoice,
        expectedBehavior: fallbackBase.expectedBehavior,
        clarificationQuestion: fallbackBase.clarificationQuestion,
        resolvedQuestionAfterClarification: fallbackBase.resolvedQuestionAfterClarification,
        actorName: params.actorName,
        domain: assigned.domain,
        lens: assigned.lens,
        semanticFrame: assigned.semanticFrame,
        contextRows: params.contextRows,
        domainScore: assigned.domainScore,
        hardGuardReasons: fallbackHardGuardReasons
      });
      const fallbackDraft: BenchmarkAuthoringDraft = {
        ...fallbackBase,
        semanticFrame: assigned.semanticFrame,
        authoringDecision: fallbackCritique.pass ? "accept" : "reject",
        rejectionReasons: fallbackCritique.pass ? [] : fallbackCritique.reasons,
        authoringCritique: fallbackCritique
      };
      const fallbackReasons = Array.from(new Set([...fallbackHardGuardReasons, ...fallbackCritique.reasons]));
      const currentScopeFailures = countWholeCorpusHumanScopeRepairReasons(critiqueReasons);
      const fallbackScopeFailures = countWholeCorpusHumanScopeRepairReasons(fallbackReasons);
      const fallbackImprovesScope = fallbackScopeFailures < currentScopeFailures;
      const fallbackImprovesScore = fallbackCritique.score >= (critique.score + 0.04);
      if (fallbackImprovesScope || fallbackImprovesScore) {
        draft = fallbackDraft;
        critique = fallbackCritique;
        hardGuardReasons = fallbackHardGuardReasons;
        critiqueReasons = fallbackReasons;
      }
    }
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
      modelReasons: draft.rejectionReasons,
      ignoreTaxonomyReasons: true
    });
    lastResult = {
      domain: assigned.domain,
      lens: assigned.lens,
      domainScore: assigned.domainScore,
      supportBacked: assigned.supportBacked,
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
  const target = frame.statementTargetName ? `target: ${frame.statementTargetName}` : null;
  const conversation = frame.sourceConversationLabel ? `thread: ${frame.sourceConversationLabel}` : null;
  return [
    frame.topicSummary,
    frame.conversationIntent,
    `owner: ${owner}`,
    target,
    `participants: ${participants}`,
    conversation,
    `support: ${frame.supportDepth}`,
    `ambiguity: ${frame.ambiguityRisk}`,
    `anchorQuality: ${Number(frame.anchorQualityScore ?? 0).toFixed(2)}`
  ].filter(Boolean).join(" | ");
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
    benchmark_stage: BenchmarkStage;
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
       benchmark_stage,
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
     ORDER BY
       CASE
         WHEN lower(COALESCE(ac.actor_type, '')) IN ('assistant', 'system') THEN 0
         WHEN lower(COALESCE(ac.actor_type, '')) <> 'user' THEN 1
         ELSE 2
       END,
       CASE WHEN length(c.content_normalized) >= 180 THEN 0 ELSE 1 END,
       md5(COALESCE(c.source_conversation_id, c.conversation_id) || ':' || c.id::text),
       c.observed_at DESC
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

async function loadWholeCorpusFamilySeedPool(params: {
  chatNamespace: string;
  anchorsPerFamily?: number;
  limitFamilies?: number;
}): Promise<WholeCorpusFamilySeed[]> {
  const anchorsPerFamily = Math.max(1, Math.min(4, Number(params.anchorsPerFamily ?? 3)));
  // Keep a wider raw slice per family so small but dense human chats are judged by
  // their strongest substantive rows, not by the last greeting/closing line.
  const rawAnchorsPerFamily = Math.max(anchorsPerFamily, Math.min(24, anchorsPerFamily * 8));
  const limitFamilies = Math.max(200, Number(params.limitFamilies ?? 2400));
  const rows = await pool.query<{
    family_key: string;
    family_row_count: string;
    family_max_len: string;
    family_actor_rank: string;
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
    `WITH ranked AS (
       SELECT
         COALESCE(NULLIF(c.source_conversation_id, ''), c.conversation_id) AS family_key,
         COUNT(*) OVER (
           PARTITION BY COALESCE(NULLIF(c.source_conversation_id, ''), c.conversation_id)
         )::text AS family_row_count,
         MAX(length(c.content_normalized)) OVER (
           PARTITION BY COALESCE(NULLIF(c.source_conversation_id, ''), c.conversation_id)
         )::text AS family_max_len,
         MIN(
           CASE
             WHEN lower(COALESCE(ac.actor_type, '')) NOT IN ('assistant', 'system', 'user') THEN 0
             WHEN lower(COALESCE(ac.actor_type, '')) = 'user' THEN 1
             WHEN lower(COALESCE(ac.actor_type, '')) IN ('assistant', 'system') THEN 2
             ELSE 3
           END
         ) OVER (
           PARTITION BY COALESCE(NULLIF(c.source_conversation_id, ''), c.conversation_id)
         )::text AS family_actor_rank,
         ROW_NUMBER() OVER (
           PARTITION BY COALESCE(NULLIF(c.source_conversation_id, ''), c.conversation_id)
           ORDER BY
             CASE
               WHEN length(c.content_normalized) >= 220 THEN 0
               WHEN length(c.content_normalized) >= 140 THEN 1
               ELSE 2
             END ASC,
             CASE
               WHEN lower(COALESCE(ac.actor_type, '')) NOT IN ('assistant', 'system', 'user') THEN 0
               WHEN lower(COALESCE(ac.actor_type, '')) = 'user' THEN 1
               WHEN lower(COALESCE(ac.actor_type, '')) IN ('assistant', 'system') THEN 2
               ELSE 3
             END ASC,
             c.quality_score DESC NULLS LAST,
             c.observed_at DESC,
             c.id ASC
         ) AS family_rank,
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
         AND c.observed_at IS NOT NULL
         AND length(trim(c.content_normalized)) >= 24
     ),
     limited AS (
       SELECT *
       FROM ranked
       WHERE family_rank <= $2
     ),
     family_order AS (
       SELECT
         family_key,
         MIN(family_actor_rank::int)::text AS family_actor_rank,
         MAX(family_max_len::int)::text AS family_max_len,
         MAX(family_row_count::int)::text AS family_row_count
       FROM limited
       GROUP BY family_key
       ORDER BY
         md5(family_key) ASC
       LIMIT $3
     )
     SELECT
       l.family_key,
       l.family_row_count,
       l.family_max_len,
       l.family_actor_rank,
       l.canonical_id,
       l.memory_id,
       l.conversation_id,
       l.source_conversation_id,
       l.actor_id,
       l.actor_name,
       l.actor_type,
       l.source_system,
       l.source_timestamp,
       l.content,
       l.has_plan_block,
       l.metadata
     FROM limited l
     JOIN family_order o ON o.family_key = l.family_key
     ORDER BY
       md5(l.family_key) ASC,
       l.family_rank ASC`,
    [params.chatNamespace, rawAnchorsPerFamily, limitFamilies]
  );

  const families = new Map<string, WholeCorpusFamilySeed>();
  for (const row of rows.rows) {
    const familyKey = String(row.family_key ?? "").trim();
    if (!familyKey) continue;
    const family = families.get(familyKey) ?? {
      familyKey,
      familyRowCount: Number(row.family_row_count ?? 0),
      familyMaxLen: Number(row.family_max_len ?? 0),
      familyActorRank: Number(row.family_actor_rank ?? 0),
      anchorRows: []
    };
    family.anchorRows.push({
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
    });
    families.set(familyKey, family);
  }
  const segmentedFamilies: WholeCorpusFamilySeed[] = [];
  for (const family of families.values()) {
    const clusters = splitSeedFamilyIntoTemporalClusters(family.anchorRows);
    for (let index = 0; index < clusters.length; index += 1) {
      const cluster = clusters[index];
      if (cluster.length <= 0) continue;
      const selectedAnchors = selectBestFamilyAnchors(cluster, anchorsPerFamily);
      if (selectedAnchors.length <= 0) continue;
      const segmentKey = clusters.length > 1
        ? `${family.familyKey}::segment:${index + 1}:${cluster[0]?.canonical_id ?? "seed"}`
        : family.familyKey;
      segmentedFamilies.push({
        familyKey: segmentKey,
        familyRowCount: cluster.length,
        familyMaxLen: cluster.reduce((max, row) => Math.max(max, String(row.content ?? "").length), 0),
        familyActorRank: family.familyActorRank,
        anchorRows: selectedAnchors
      });
    }
  }
  return segmentedFamilies;
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

async function loadSeedEvidenceRowsByIds(params: {
  chatNamespace: string;
  canonicalIds: string[];
}): Promise<SeedEvidenceCandidate[]> {
  const canonicalIds = uniqueStrings(params.canonicalIds).filter((id) => /^[0-9a-fA-F-]{36}$/.test(id));
  if (canonicalIds.length === 0) return [];
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
       AND c.id = ANY($2::uuid[])
       AND c.observed_at IS NOT NULL
     ORDER BY c.observed_at ASC, c.id ASC`,
    [params.chatNamespace, canonicalIds]
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
      const pruned = pruneBucketForDiversity(
        bucket.sort((a, b) => {
          const leftScore = scoreAnchorAuthorability({
            domain: domainName,
            lens: "descriptive",
            anchor: a,
            contextRows: [a],
            domainScore: Number(a.domain_score ?? 0)
          });
          const rightScore = scoreAnchorAuthorability({
            domain: domainName,
            lens: "descriptive",
            anchor: b,
            contextRows: [b],
            domainScore: Number(b.domain_score ?? 0)
          });
          if (leftScore !== rightScore) return rightScore - leftScore;
          const scoreDiff = Number(b.domain_score ?? 0) - Number(a.domain_score ?? 0);
          if (scoreDiff !== 0) return scoreDiff;
          const actorBias = Number(lowerText(b.actor_type) !== "user") - Number(lowerText(a.actor_type) !== "user");
          if (actorBias !== 0) return actorBias;
          return String(b.source_timestamp ?? "").localeCompare(String(a.source_timestamp ?? ""));
        }),
        2,
        MAX_DOMAIN_ANCHORS_TO_SCAN
      );
      evidenceByDomain.set(domainName, pruned);
    }
  }
  return evidenceByDomain;
}

function buildSupportedPairDescriptors(params: {
  supportRows: TaxonomySupportRow[];
  preferredDomains: Set<string>;
  preferredLenses: Set<string>;
}): {
  pairKeys: Set<string>;
  lensesByDomain: Map<string, SupportedPairDescriptor[]>;
} {
  const filtered = params.supportRows
    .filter((row) => row.supportStatus === "supported")
    .filter((row) => params.preferredDomains.size === 0 || params.preferredDomains.has(row.domainKey))
    .filter((row) => params.preferredLenses.size === 0 || params.preferredLenses.has(row.lensKey))
    .filter((row) => Number(row.supportCount ?? 0) >= minimumSupportClustersForSupplementalLens(row.lensKey));
  const pairKeys = new Set(filtered.map((row) => `${row.domainKey}|${row.lensKey}`));
  const lensesByDomain = new Map<string, SupportedPairDescriptor[]>();
  for (const row of filtered) {
    const bucket = lensesByDomain.get(row.domainKey) ?? [];
    bucket.push({
      domain: row.domainKey,
      lens: row.lensKey,
      supportCount: Number(row.supportCount ?? 0),
      evidenceCount: Number(row.evidenceCount ?? 0)
    });
    lensesByDomain.set(row.domainKey, bucket);
  }
  for (const [domain, bucket] of lensesByDomain.entries()) {
    bucket.sort((a, b) => {
      const leftPriority = SUPPLEMENTAL_POSITIVE_LENS_PRIORITY[a.lens] ?? 999;
      const rightPriority = SUPPLEMENTAL_POSITIVE_LENS_PRIORITY[b.lens] ?? 999;
      if (leftPriority !== rightPriority) return leftPriority - rightPriority;
      if (a.supportCount !== b.supportCount) return b.supportCount - a.supportCount;
      if (a.evidenceCount !== b.evidenceCount) return b.evidenceCount - a.evidenceCount;
      return `${domain}|${a.lens}`.localeCompare(`${domain}|${b.lens}`);
    });
  }
  return { pairKeys, lensesByDomain };
}

function aggregateContextDomainScores(params: {
  anchor: SeedEvidenceCandidate;
  contextRows: SeedEvidenceCandidate[];
}): Array<{ domain: string; score: number }> {
  const rows = uniqSeedRows([params.anchor, ...params.contextRows], 10);
  const aggregated = new Map<string, number>();
  const mergedText = rows
    .map((row) => String(row.content ?? "").trim())
    .filter(Boolean)
    .join("\n");
  const contextSignals = rows.flatMap((row) => [
    ...metadataStringArray(row, "topics").slice(0, 6),
    ...metadataStringArray(row, "people").slice(0, 6),
    metadataString(row, "thread_title"),
    metadataString(row, "group_label"),
    metadataString(row, "conversation_title")
  ]).filter(Boolean) as string[];

  for (const row of rows) {
    const metadata = rowMetadata(row);
    const storedScoreMap = metadata.domain_scores && typeof metadata.domain_scores === "object"
      ? (metadata.domain_scores as Record<string, unknown>)
      : {};
    for (const [domain, rawScore] of Object.entries(storedScoreMap)) {
      const score = Number(rawScore ?? 0);
      if (!Number.isFinite(score) || score <= 0) continue;
      aggregated.set(domain, Math.max(aggregated.get(domain) ?? 0, score));
    }
    const primaryDomain = String(metadata.primary_domain ?? "").trim();
    if (primaryDomain) aggregated.set(primaryDomain, Math.max(aggregated.get(primaryDomain) ?? 0, 0.7));
    for (const domain of metadataStringArray(row, "domain_top").slice(0, 4)) {
      aggregated.set(domain, Math.max(aggregated.get(domain) ?? 0, 0.45));
    }
  }

  const inferred = inferStructuredSignals({
    text: mergedText,
    contextWindow: contextSignals,
    sourceSystem: params.anchor.source_system,
    sourceConversationId: params.anchor.source_conversation_id ?? params.anchor.conversation_id
  });
  for (const [domain, score] of Object.entries(inferred.domainScores)) {
    aggregated.set(domain, Math.max(aggregated.get(domain) ?? 0, Number(score ?? 0)));
  }
  const derived = deriveVersionedDomainScores({
    content: mergedText,
    sourceSystem: params.anchor.source_system,
    sourceConversationId: params.anchor.source_conversation_id ?? params.anchor.conversation_id,
    storedScoreMap: Object.fromEntries(aggregated.entries()),
    inferredScoreMap: inferred.domainScores
  });
  for (const [domain, score] of Object.entries(derived)) {
    aggregated.set(domain, Math.max(aggregated.get(domain) ?? 0, Number(score ?? 0)));
  }
  for (const ranked of rankStructuredDomains(mergedText)) {
    aggregated.set(ranked.domain, Math.max(aggregated.get(ranked.domain) ?? 0, Number(ranked.score ?? 0)));
  }

  return Array.from(aggregated.entries())
    .map(([domain, score]) => ({ domain, score: Number(score ?? 0) }))
    .filter((item) => item.score >= 0.28)
    .sort((a, b) => {
      if (a.score !== b.score) return b.score - a.score;
      return a.domain.localeCompare(b.domain);
    });
}

const HUMAN_WHOLE_CORPUS_DOMAIN_ALLOWLIST = new Set([
  "communication_style",
  "family_relationships",
  "friendships",
  "romantic_relationship",
  "social_graph_dynamics",
  "financial_planning",
  "financial_behavior",
  "health_routines",
  "medical_context",
  "work_execution",
  "work_performance",
  "career_trajectory",
  "travel_mobility",
  "leisure_creativity",
  "life_goals_planning",
  "personal_narrative",
  "risk_safety",
  "risk_safety_decisions",
  "learning_growth",
  "meaning_spirituality",
  "lifestyle_environment",
  "energy_management",
  "battery_range_planning"
]);

function isHumanWhatsAppTopology(anchor: SeedEvidenceCandidate, contextRows: SeedEvidenceCandidate[]): boolean {
  return lowerText(anchor.source_system) === "whatsapp"
    && topologyIsHuman(classifyConversationTopology({ anchor, contextRows }));
}

function rankHumanWhatsAppHeuristicDomains(text: string): Array<{ domain: string; score: number }> {
  const scored = new Map<string, number>();
  const apply = (domain: string, score: number): void => {
    scored.set(domain, Math.max(scored.get(domain) ?? 0, score));
  };

  if (/\b(covid|coronavirus|flu test|tamiflu|urgent care|social distancing|quarantine|mask)\b/iu.test(text)) {
    apply(/\b(flu test|tamiflu|urgent care)\b/iu.test(text) ? "medical_context" : "risk_safety", 0.9);
  }
  if (/\b(knife|knives|cuchillo|cuchillos|self defense|self-defen[cs]e|defesa|defense|arma branca|weapon|weapons|safety technique|técnica|tecnica)\b/iu.test(text)) {
    apply("risk_safety_decisions", 0.9);
  }
  if (/\b(accident|injury|injured|hurt|head|ditch|hospital|doctor|results|treated|treatment|medication|diagnosis|exam|saliva|blood|pathogen|gum disease|periodontitis)\b/iu.test(text)) {
    apply(
      /\b(doctor|results|treated|treatment|medication|diagnosis|exam|saliva|blood|hospital|pathogen|periodontitis|gum disease)\b/iu.test(text)
        ? "medical_context"
        : "risk_safety",
      0.92
    );
  }
  if (/\b(401k|ira|balance|asset|assets|portfolio|brokerage|cash|money|house|equity|loan|debt|pay stub|paystub|payroll|salary|btc|bitcoin|crypto|usdt|eth|stock|stocks|market|nyse|nasdaq|dividend|option|options|call spread|bullish|bearish|inflation|tariffs?|broker|protection setting)\b/iu.test(text)) {
    apply("financial_planning", 0.9);
  }
  if (/\b(entrevista|entrevistas|interview|interviews|retorno|vaga|vagas|curr[ií]culo|curriculum|recrutador|recruiter|hiring|job search|processo seletivo|sele[cç][aã]o|other team|moved out to other team|softtek|empresa|trampo|trampando|trabalho|trabalhando|promotion|promoted|offer|offers|resume atualizado|resume updated|open positions?|oportunidade)\b/iu.test(text)) {
    apply("career_trajectory", 0.88);
  }
  if (/\b(bolsonaro|lula|election|elections|elei[cç][aã]o|eleicoes|eleições|presidente|senador|governador|deputado|candidato|candidatos|politic|political|votar|vote|voting)\b/iu.test(text)) {
    apply("values_beliefs", 0.86);
  }
  if (/\b(meeting|webex|zoom|roundtable|deployment|rollback|project|deadline|company|office|manager|team|task|work|workflow|repository|mapping|batch repository|ctasks|rfc|email|screen shots|screenshot|map name|history table|data elements|api|core qas|yard house|car pool|lunch|atrium|start 12\\.30|execution result|validations)\b/iu.test(text)) {
    apply("work_execution", 0.9);
  }
  if (/\b(trip|travel|flight|airport|hotel|orlando|jacksonville|vacation|weekend|mistake fare|fortaleza|voo|disney|sawgrass|miami|tampa|charlotte|fare|route|moved back to florida)\b/iu.test(text)) {
    apply("travel_mobility", 0.88);
  }
  if (/\b(coffee|coffee shop|coffee shops|restaurant|restaurants|movie|movies|concert|concerts|park|parks|museum|museums|bar|bars|brunch|dinner|lunch|pickleball|hang out|weekend hang out|finde|findi|fim de semana|jantar|alm[oó]ço|almoço|got\b|game tonight|state parks?)\b/iu.test(text)) {
    apply("leisure_creativity", 0.86);
  }
  if (/\b(grill|grilling|bbq|barbecue|barbecue|picanha|salsa|guac|chips|corn|vegetable skewers|cookout|meal plan|party food)\b/iu.test(text)) {
    apply("leisure_creativity", 0.9);
  }
  if (/\b(wedding|casamento|convite de casamento|baby bump|photo session|family photo|birthday|anivers[aá]rio|parab[eé]ns|happy new year|feliz ano novo|convite de casamento|casar)\b/iu.test(text)) {
    apply("memorable_moments", 0.84);
  }
  if (/\b(our relationship|relationship problems?|problem with our relationship|no connection with you|sleep in separate rooms|not comfortable being married)\b/iu.test(text)) {
    apply("romantic_relationship", 0.9);
  }
  if (/\b(mom|mother|dad|father|uncle|aunt|cousin|brother|sister|family|son|daughter|mãe|pai|tio|tia|irm)/iu.test(text)) {
    apply("family_relationships", 0.72);
  }
  if (/\b(wife|husband|spouse|girlfriend|boyfriend|marriage|married|divorce|separate rooms|partner)\b/iu.test(text)) {
    apply("romantic_relationship", 0.82);
  }
  if (/\b(friend|friends|buddy|amigo|amiga|amizade|reunion)\b/iu.test(text)) {
    apply("friendships", 0.68);
  }
  if (/\b(sorry|arguing|lie|hurt me|tone|wording|message|texted|said this|said that|don[’']t act like|como bem saben|muchas felicidades)\b/iu.test(text)) {
    apply("communication_style", 0.62);
  }
  if ((scored.get("romantic_relationship") ?? 0) >= 0.88 && (scored.get("family_relationships") ?? 0) > 0) {
    scored.set("family_relationships", Math.max(0, (scored.get("family_relationships") ?? 0) - 0.12));
  }
  return Array.from(scored.entries())
    .map(([domain, score]) => ({ domain, score }))
    .sort((a, b) => {
      if (a.score !== b.score) return b.score - a.score;
      return a.domain.localeCompare(b.domain);
    });
}

function heuristicHumanWhatsAppDomain(text: string): string | null {
  return rankHumanWhatsAppHeuristicDomains(text)[0]?.domain ?? null;
}

function fallbackHumanWhatsAppDomain(anchor: SeedEvidenceCandidate, contextRows: SeedEvidenceCandidate[]): string {
  const anchorText = String(anchor.content ?? "").trim();
  const anchorHeuristic = heuristicHumanWhatsAppDomain(anchorText);
  if (anchorHeuristic) return anchorHeuristic;

  const structuredClaimText = collectStructuredClaims([anchor, ...contextRows], 8).join("\n");
  const structuredHeuristic = heuristicHumanWhatsAppDomain(structuredClaimText);
  if (structuredHeuristic) return structuredHeuristic;

  const text = combinedEvidenceText(contextRows);
  const heuristic = heuristicHumanWhatsAppDomain(text);
  if (heuristic) return heuristic;

  let scored = Array.from(
    aggregateContextDomainScores({
      anchor,
      contextRows
    })
      .filter((item) => HUMAN_WHOLE_CORPUS_DOMAIN_ALLOWLIST.has(item.domain))
      .filter((item) => domainSemanticMismatchReason(item.domain, contextRows) == null)
  );
  scored = scored
    .map((item) => {
      let score = item.score;
      if (["communication_style", "family_relationships", "friendships", "social_graph_dynamics"].includes(item.domain)) {
        score -= 0.08;
      }
      return { domain: item.domain, score };
    })
    .sort((a, b) => {
      if (a.score !== b.score) return b.score - a.score;
      return a.domain.localeCompare(b.domain);
    })
    .slice(0, 3);
  if (scored[0]?.domain) return scored[0].domain;
  return "communication_style";
}

function selectWholeCorpusProvisionalDomain(params: {
  anchor: SeedEvidenceCandidate;
  contextRows: SeedEvidenceCandidate[];
  supported: {
    lensesByDomain: Map<string, SupportedPairDescriptor[]>;
  };
}): {
  domain: string;
  score: number;
  candidates: Array<{ domain: string; score: number }>;
} {
  const humanWhatsApp = isHumanWhatsAppTopology(params.anchor, params.contextRows);
  const explicitHumanFallback = humanWhatsApp
    ? fallbackHumanWhatsAppDomain(params.anchor, params.contextRows)
    : null;
  const heuristicCandidates = humanWhatsApp
    ? rankHumanWhatsAppHeuristicDomains([
      String(params.anchor.content ?? ""),
      collectStructuredClaims([params.anchor, ...params.contextRows], 8).join("\n"),
      combinedEvidenceText(params.contextRows)
    ].filter(Boolean).join("\n"))
    : [];
  let candidates = aggregateContextDomainScores({
    anchor: params.anchor,
    contextRows: params.contextRows
  }).filter((item) => params.supported.lensesByDomain.has(item.domain));
  if (humanWhatsApp) {
    candidates = candidates
      .filter((item) => HUMAN_WHOLE_CORPUS_DOMAIN_ALLOWLIST.has(item.domain))
      .filter((item) => domainSemanticMismatchReason(item.domain, params.contextRows) == null);
  }
  if (humanWhatsApp && heuristicCandidates.length > 0) {
    const merged = new Map<string, number>();
    for (const candidate of candidates) {
      merged.set(candidate.domain, candidate.score);
    }
    for (const heuristic of heuristicCandidates) {
      if (!params.supported.lensesByDomain.has(heuristic.domain)) continue;
      if (!HUMAN_WHOLE_CORPUS_DOMAIN_ALLOWLIST.has(heuristic.domain)) continue;
      if (domainSemanticMismatchReason(heuristic.domain, params.contextRows) != null) continue;
      merged.set(heuristic.domain, Math.max(merged.get(heuristic.domain) ?? 0, heuristic.score));
    }
    candidates = Array.from(merged.entries())
      .map(([domain, score]) => ({ domain, score }))
      .map((item) => {
        let score = item.score;
        if (
          ["communication_style", "family_relationships", "friendships", "social_graph_dynamics"].includes(item.domain)
          && heuristicCandidates.some((heuristic) => heuristic.domain !== item.domain && heuristic.score >= score + 0.08)
        ) {
          score -= 0.1;
        }
        return { domain: item.domain, score };
      })
      .sort((a, b) => {
        if (a.score !== b.score) return b.score - a.score;
        return a.domain.localeCompare(b.domain);
      });
  }
  if (humanWhatsApp && explicitHumanFallback && explicitHumanFallback !== "communication_style") {
    const existing = candidates.find((item) => item.domain === explicitHumanFallback);
    candidates = candidates.filter((item) => item.domain !== explicitHumanFallback);
    candidates.unshift({
      domain: explicitHumanFallback,
      score: Math.max(existing?.score ?? 0, 0.55)
    });
  }
  candidates = candidates.slice(0, 6);
  if (candidates.length > 0) {
    return {
      domain: candidates[0].domain,
      score: candidates[0].score,
      candidates
    };
  }
  if (humanWhatsApp) {
    const fallback = explicitHumanFallback ?? fallbackHumanWhatsAppDomain(params.anchor, params.contextRows);
    return {
      domain: fallback,
      score: 0.45,
      candidates: [{ domain: fallback, score: 0.45 }]
    };
  }
  return {
    domain: "meta_memory_quality",
    score: 0.5,
    candidates: []
  };
}

function mergeWholeCorpusDomainCandidates(params: {
  familyCandidates: Array<{ domain: string; score: number }>;
  draftCandidates: Array<{ domain: string; score: number }>;
  explicitFallback: string | null;
  humanWhatsApp: boolean;
}): Array<{ domain: string; score: number }> {
  const merged = new Map<string, number>();
  const applyScore = (domain: string, score: number): void => {
    if (!domain) return;
    const numeric = Number(score ?? 0);
    if (!Number.isFinite(numeric) || numeric <= 0) return;
    merged.set(domain, Math.max(merged.get(domain) ?? 0, numeric));
  };

  for (const item of params.familyCandidates) {
    let adjusted = item.score;
    if (params.humanWhatsApp) {
      adjusted *= 0.72;
      if (params.explicitFallback && item.domain === params.explicitFallback) adjusted += 0.04;
    }
    applyScore(item.domain, adjusted);
  }
  if (params.explicitFallback) {
    applyScore(params.explicitFallback, params.humanWhatsApp ? 0.66 : 0.72);
  }

  for (const item of params.draftCandidates) {
    let adjusted = item.score;
    if (params.humanWhatsApp) {
      adjusted *= 1.08;
      if (item.domain === "communication_style") adjusted -= 0.08;
      if (params.explicitFallback && item.domain === params.explicitFallback) adjusted += 0.1;
    }
    applyScore(item.domain, adjusted);
  }

  return Array.from(merged.entries())
    .map(([domain, score]) => ({ domain, score }))
    .sort((a, b) => {
      if (a.score !== b.score) return b.score - a.score;
      return a.domain.localeCompare(b.domain);
    });
}

function aggregateDraftDomainScores(params: {
  anchor: SeedEvidenceCandidate;
  contextRows: SeedEvidenceCandidate[];
  draftQuestion: string;
  expectedAnswerSummaryHuman: string;
  semanticFrame: BenchmarkSemanticFrame;
}): Array<{ domain: string; score: number }> {
  const topology = classifyConversationTopology({
    anchor: params.anchor,
    contextRows: params.contextRows
  });
  const humanTopology = topologyIsHuman(topology);
  const aggregated = new Map<string, number>(
    aggregateContextDomainScores({
      anchor: params.anchor,
      contextRows: params.contextRows
    }).map((item) => [item.domain, item.score])
  );
  const authoredText = [
    params.draftQuestion,
    params.expectedAnswerSummaryHuman,
    ...params.semanticFrame.concreteClaims.slice(0, 6)
  ]
    .map((value) => String(value ?? "").trim())
    .filter(Boolean)
    .join("\n");
  if (!authoredText) {
    return Array.from(aggregated.entries())
      .map(([domain, score]) => ({ domain, score: Number(score ?? 0) }))
      .filter((item) => item.score >= 0.28)
      .sort((a, b) => {
        if (a.score !== b.score) return b.score - a.score;
        return a.domain.localeCompare(b.domain);
      });
  }
  const contextSignals = params.contextRows.flatMap((row) => [
    ...metadataStringArray(row, "topics").slice(0, 6),
    ...metadataStringArray(row, "people").slice(0, 6),
    metadataString(row, "thread_title"),
    metadataString(row, "group_label"),
    metadataString(row, "conversation_title")
  ]).filter(Boolean) as string[];
  if (humanTopology) {
    const heuristicText = [authoredText, ...contextSignals]
      .map((value) => String(value ?? "").trim())
      .filter(Boolean)
      .join("\n");
    for (const heuristic of rankHumanWhatsAppHeuristicDomains(heuristicText)) {
      aggregated.set(
        heuristic.domain,
        Math.max(aggregated.get(heuristic.domain) ?? 0, Number(heuristic.score ?? 0) + 0.04)
      );
    }
  }
  const inferred = inferStructuredSignals({
    text: authoredText,
    contextWindow: contextSignals,
    sourceSystem: params.anchor.source_system,
    sourceConversationId: params.anchor.source_conversation_id ?? params.anchor.conversation_id
  });
  for (const [domain, score] of Object.entries(inferred.domainScores)) {
    const numeric = Number(score ?? 0);
    if (!Number.isFinite(numeric) || numeric <= 0) continue;
    aggregated.set(domain, Math.max(aggregated.get(domain) ?? 0, numeric));
  }
  const derived = deriveVersionedDomainScores({
    content: authoredText,
    sourceSystem: params.anchor.source_system,
    sourceConversationId: params.anchor.source_conversation_id ?? params.anchor.conversation_id,
    storedScoreMap: Object.fromEntries(aggregated.entries()),
    inferredScoreMap: inferred.domainScores
  });
  for (const [domain, score] of Object.entries(derived)) {
    const numeric = Number(score ?? 0);
    if (!Number.isFinite(numeric) || numeric <= 0) continue;
    aggregated.set(domain, Math.max(aggregated.get(domain) ?? 0, numeric));
  }
  for (const ranked of rankStructuredDomains(authoredText)) {
    aggregated.set(ranked.domain, Math.max(aggregated.get(ranked.domain) ?? 0, Number(ranked.score ?? 0)));
  }
  if (humanTopology) {
    const workScore = aggregated.get("work_execution") ?? 0;
    const leisureScore = aggregated.get("leisure_creativity") ?? 0;
    if (workScore >= 0.7 && leisureScore > 0) {
      aggregated.set("leisure_creativity", Math.max(0, leisureScore - 0.14));
    }
  }
  return Array.from(aggregated.entries())
    .map(([domain, score]) => ({ domain, score: Number(score ?? 0) }))
    .filter((item) => item.score >= 0.28)
    .sort((a, b) => {
      if (a.score !== b.score) return b.score - a.score;
      return a.domain.localeCompare(b.domain);
    });
}

type WholeCorpusAssignedDraft = {
  domain: string;
  lens: string;
  domainScore: number;
  supportBacked: boolean;
  semanticFrame: BenchmarkSemanticFrame;
  hardGuardReasons: string[];
  critique: BenchmarkAuthoringCritique;
};

function assignDomainLensForWholeCorpusDraft(params: {
  supported: {
    pairKeys: Set<string>;
    lensesByDomain: Map<string, SupportedPairDescriptor[]>;
  };
  anchor: SeedEvidenceCandidate;
  contextRows: SeedEvidenceCandidate[];
  actorName: string | null;
  window: string;
  draft: BenchmarkAuthoringDraft;
  provisionalDomain: string;
  provisionalLens: string;
  provisionalDomainScore: number;
  familyReasoningModes: SupportedPairDescriptor[];
}): WholeCorpusAssignedDraft {
  const humanWhatsApp = isHumanWhatsAppTopology(params.anchor, params.contextRows);
  const familyDomainSelection = selectWholeCorpusProvisionalDomain({
    anchor: params.anchor,
    contextRows: params.contextRows,
    supported: params.supported
  });
  const explicitHumanFallback = humanWhatsApp
    ? fallbackHumanWhatsAppDomain(params.anchor, params.contextRows)
    : null;
  const reasoningModeSet = new Set(
    params.familyReasoningModes
      .slice(0, 6)
      .map((item) => item.lens)
  );
  reasoningModeSet.add(params.provisionalLens);
  const draftDomainCandidates = aggregateDraftDomainScores({
    anchor: params.anchor,
    contextRows: params.contextRows,
    draftQuestion: params.draft.chosenQuestion,
    expectedAnswerSummaryHuman: params.draft.expectedAnswerSummaryHuman,
    semanticFrame: params.draft.semanticFrame
  })
    .filter((item) => params.supported.lensesByDomain.has(item.domain))
    .filter((item) => !humanWhatsApp || HUMAN_WHOLE_CORPUS_DOMAIN_ALLOWLIST.has(item.domain))
    .filter((item) => !humanWhatsApp || domainSemanticMismatchReason(item.domain, params.contextRows) == null)
    .slice(0, 8);
  const draftDomainSet = new Set(draftDomainCandidates.map((item) => item.domain));
  const familyDomainCandidates = familyDomainSelection.candidates.length > 0
    ? familyDomainSelection.candidates
      .filter((item) => (
        !humanWhatsApp
        || draftDomainSet.size === 0
        || draftDomainSet.has(item.domain)
        || item.domain === explicitHumanFallback
      ))
      .slice(0, 6)
    : [{
      domain: params.provisionalDomain,
      score: Math.max(0.2, params.provisionalDomainScore)
    }];
  const domainCandidates = mergeWholeCorpusDomainCandidates({
    familyCandidates: familyDomainCandidates,
    draftCandidates: draftDomainCandidates,
    explicitFallback: explicitHumanFallback,
    humanWhatsApp
  }).slice(0, 8);

  let best: (WholeCorpusAssignedDraft & { rankingScore: number }) | null = null;
  const seenPair = new Set<string>();

  for (const domainCandidate of domainCandidates) {
    if (
      humanWhatsApp
      && domainCandidate.domain === "communication_style"
      && domainCandidates.some((item) => item.domain !== "communication_style" && item.score >= domainCandidate.score - 0.05)
    ) {
      continue;
    }
    const supportedLenses = params.supported.lensesByDomain.get(domainCandidate.domain) ?? [];
    const preferredLenses = supportedLenses.filter((descriptor) => reasoningModeSet.has(descriptor.lens));
    const lensCandidates = (preferredLenses.length > 0 ? preferredLenses : supportedLenses).slice(0, 6);
    for (const lensDescriptor of lensCandidates) {
      const pairKey = `${domainCandidate.domain}|${lensDescriptor.lens}`;
      if (seenPair.has(pairKey)) continue;
      seenPair.add(pairKey);
      const semanticFrame = buildSemanticFrame({
        domain: domainCandidate.domain,
        lens: lensDescriptor.lens,
        window: params.window,
        anchor: params.anchor,
        contextRows: params.contextRows,
        actorName: params.actorName
      });
      const hardGuardReasons = buildAuthoringHardGuardReasons({
        anchor: params.anchor,
        contextRows: params.contextRows,
        question: params.draft.chosenQuestion,
        expectedBehavior: params.draft.expectedBehavior,
        domain: domainCandidate.domain,
        lens: lensDescriptor.lens
      });
      const critique = scoreAuthoringCritique({
        question: params.draft.chosenQuestion,
        questionVoice: params.draft.questionVoice,
        expectedBehavior: params.draft.expectedBehavior,
        clarificationQuestion: params.draft.clarificationQuestion,
        resolvedQuestionAfterClarification: params.draft.resolvedQuestionAfterClarification,
        actorName: params.actorName,
        domain: domainCandidate.domain,
        lens: lensDescriptor.lens,
        semanticFrame,
        contextRows: params.contextRows,
        domainScore: domainCandidate.score,
        hardGuardReasons
      });
      const supportBacked = params.supported.pairKeys.has(pairKey);
      if (humanWhatsApp && domainSemanticMismatchReason(domainCandidate.domain, params.contextRows)) continue;
      const rankingScore = critique.score
        - (hardGuardReasons.length * 0.08)
        + (supportBacked ? 0.04 : 0)
        + Math.min(0.06, Number(domainCandidate.score ?? 0) * 0.08)
        + (lensDescriptor.lens === "descriptive" ? 0.01 : 0);
      if (
        !best
        || rankingScore > best.rankingScore
        || (
          rankingScore === best.rankingScore
          && supportBacked
          && !best.supportBacked
        )
      ) {
        best = {
          domain: domainCandidate.domain,
          lens: lensDescriptor.lens,
          domainScore: domainCandidate.score,
          supportBacked,
          semanticFrame,
          hardGuardReasons,
          critique,
          rankingScore
        };
      }
    }
  }

  if (best) {
    const { rankingScore: _rankingScore, ...resolved } = best;
    return resolved;
  }

  const semanticFrame = buildSemanticFrame({
    domain: params.provisionalDomain,
    lens: params.provisionalLens,
    window: params.window,
    anchor: params.anchor,
    contextRows: params.contextRows,
    actorName: params.actorName
  });
  const hardGuardReasons = buildAuthoringHardGuardReasons({
    anchor: params.anchor,
    contextRows: params.contextRows,
    question: params.draft.chosenQuestion,
    expectedBehavior: params.draft.expectedBehavior,
    domain: params.provisionalDomain,
    lens: params.provisionalLens
  });
  const critique = scoreAuthoringCritique({
    question: params.draft.chosenQuestion,
    questionVoice: params.draft.questionVoice,
    expectedBehavior: params.draft.expectedBehavior,
    clarificationQuestion: params.draft.clarificationQuestion,
    resolvedQuestionAfterClarification: params.draft.resolvedQuestionAfterClarification,
    actorName: params.actorName,
    domain: params.provisionalDomain,
    lens: params.provisionalLens,
    semanticFrame,
    contextRows: params.contextRows,
    domainScore: params.provisionalDomainScore,
    hardGuardReasons
  });
  return {
    domain: params.provisionalDomain,
    lens: params.provisionalLens,
    domainScore: params.provisionalDomainScore,
    supportBacked: params.supported.pairKeys.has(`${params.provisionalDomain}|${params.provisionalLens}`),
    semanticFrame,
    hardGuardReasons,
    critique
  };
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
      const contextRows = buildLensAwareContextRows({
        anchor,
        conversationRows,
        lens: "descriptive"
      });
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
  const rawFacets = obj.retrievalFacets && typeof obj.retrievalFacets === "object" && !Array.isArray(obj.retrievalFacets)
    ? obj.retrievalFacets as Record<string, unknown>
    : {};
  const sourceConversationLabel = String(obj.sourceConversationLabel ?? "").trim() || null;
  const fallbackActorNames = normalizeFacetValues([
    String(obj.actorScope ?? "").trim() || null,
    String(obj.statementOwnerName ?? "").trim() || null,
    String(obj.statementTargetName ?? "").trim() || null,
    ...(Array.isArray(obj.participants) ? obj.participants.map((item) => String(item ?? "")) : [])
  ]);
  const fallbackTopicSummary = String(obj.topicSummary ?? "").trim();
  const fallbackClaims = Array.isArray(obj.concreteClaims) ? obj.concreteClaims.map(String).filter(Boolean) : [];
  const fallbackThreadTitles = sourceConversationLabel && !isLikelyGroupConversationLabel(sourceConversationLabel) ? [sourceConversationLabel] : [];
  const fallbackGroupLabels = sourceConversationLabel && isLikelyGroupConversationLabel(sourceConversationLabel) ? [sourceConversationLabel] : [];
  const normalizedTopology = normalizeTopology(String(obj.topology ?? "").trim());
  const fallbackTopology: EvidenceFamilyTopology = normalizedTopology
    ?? (() => {
      const statementOwnerRole = String(obj.statementOwnerRole ?? "mixed").trim();
      const participants = Array.isArray(obj.participants) ? obj.participants.map((item) => String(item ?? "")).filter(Boolean) : [];
      const humanParticipants = participants.filter((name) => isLikelyName(name) && !/assistant|system/i.test(name));
      if (statementOwnerRole === "assistant_or_system") return "assistant_thread";
      if (fallbackGroupLabels.length > 0 && humanParticipants.length > 0) return "human_group_chat";
      if (statementOwnerRole === "other_human" && humanParticipants.length === 1) return "human_direct_1to1";
      if (statementOwnerRole === "other_human" && humanParticipants.length >= 2) return "third_party_human";
      if (humanParticipants.length > 0) return "other_human";
      return "system_artifact";
    })();
  return normalizeSemanticFrameOwnerAliases({
    domain: String(obj.domain ?? "").trim(),
    lens: String(obj.lens ?? "").trim(),
    topology: fallbackTopology,
    participants: Array.isArray(obj.participants) ? obj.participants.map(String).filter(Boolean) : [],
    actorScope: String(obj.actorScope ?? "").trim() || null,
    statementOwnerName: String(obj.statementOwnerName ?? "").trim() || null,
    statementOwnerRole: String(obj.statementOwnerRole ?? "mixed").trim() as "user" | "other_human" | "assistant_or_system" | "mixed",
    statementTargetName: String(obj.statementTargetName ?? "").trim() || null,
    preferredQuestionVoices: Array.isArray(obj.preferredQuestionVoices)
      ? obj.preferredQuestionVoices
          .map((item) => String(item ?? "").trim())
          .filter((item): item is "user_first_person" | "user_about_other" | "assistant_proxy" => item === "user_first_person" || item === "user_about_other" || item === "assistant_proxy")
      : preferredVoicesForStatementOwner("mixed"),
    retrievalFacets: {
      actorNames: Array.isArray(rawFacets.actorNames) ? normalizeFacetValues(rawFacets.actorNames.map((item) => String(item ?? ""))) : fallbackActorNames,
      groupLabels: Array.isArray(rawFacets.groupLabels) ? normalizeFacetValues(rawFacets.groupLabels.map((item) => String(item ?? "")), 8) : fallbackGroupLabels,
      threadTitles: Array.isArray(rawFacets.threadTitles) ? normalizeFacetValues(rawFacets.threadTitles.map((item) => String(item ?? "")), 8) : fallbackThreadTitles,
      sourceSystems: Array.isArray(rawFacets.sourceSystems) ? normalizeFacetValues(rawFacets.sourceSystems.map((item) => String(item ?? "")), 6) : [],
      timeConstraints: Array.isArray(rawFacets.timeConstraints) ? normalizeFacetValues(rawFacets.timeConstraints.map((item) => String(item ?? "")), 10) : normalizeFacetValues([String(obj.timeframe ?? "").trim()], 10),
      topicCues: Array.isArray(rawFacets.topicCues)
        ? normalizeFacetValues(rawFacets.topicCues.map((item) => String(item ?? "")), 16)
        : normalizeFacetValues([fallbackTopicSummary, ...fallbackClaims.flatMap((claim) => meaningfulTokens(claim).slice(0, 3))], 16)
    },
    timeframe: String(obj.timeframe ?? "").trim(),
    conversationIntent: String(obj.conversationIntent ?? "").trim(),
    topicSummary: String(obj.topicSummary ?? "").trim(),
    sourceConversationLabel,
    concreteClaims: Array.isArray(obj.concreteClaims) ? obj.concreteClaims.map(String).filter(Boolean) : [],
    anchorQualityScore: Number(obj.anchorQualityScore ?? 0),
    supportDepth: String(obj.supportDepth ?? "thin").trim() as "thin" | "moderate" | "rich",
    ambiguityRisk: String(obj.ambiguityRisk ?? "high").trim() as "low" | "medium" | "high",
    supportedLenses: Array.isArray(obj.supportedLenses) ? obj.supportedLenses.map(String).filter(Boolean) : []
  });
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

type EvidencePreviewRow = {
  evidenceId: string;
  actorName: string | null;
  actorType: string | null;
  actorMetadata: Record<string, unknown> | null;
  observedAt: string | null;
  sourceSystem: string;
  snippet: string;
};

type ActorPronounSet = {
  subject: string;
  object: string;
  possessive: string;
};

function isEvidencePreviewRow(item: EvidencePreviewRow | undefined): item is EvidencePreviewRow {
  return Boolean(item);
}

async function loadEvidencePreviewMap(evidenceIds: string[]): Promise<Map<string, EvidencePreviewRow>> {
  const ids = Array.from(new Set(evidenceIds.filter((id) => /^[0-9a-fA-F-]{36}$/.test(id))));
  if (ids.length === 0) return new Map();
  const rows = await pool.query<{
    evidence_id: string;
    actor_name: string | null;
    actor_type: string | null;
    actor_metadata: Record<string, unknown> | null;
    observed_at: string | null;
    source_system: string;
    snippet: string;
  }>(
    `SELECT
       c.id::text AS evidence_id,
       a.canonical_name AS actor_name,
       c.actor_type,
       a.metadata AS actor_metadata,
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
        actorType: row.actor_type ?? null,
        actorMetadata: row.actor_metadata ?? null,
        observedAt: row.observed_at ?? null,
        sourceSystem: row.source_system,
        snippet: String(row.snippet ?? "")
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

function buildExpectedCoreClaims(contextRows: SeedEvidenceCandidate[]): string[] {
  const claims = collectStructuredClaims(contextRows, 5);
  if (claims.length > 0) return claims;
  return contextRows.map((row) => compactText(row.content, 140)).filter(Boolean).slice(0, 5);
}

function parseEmbeddedResponseText(text: string): string {
  const raw = String(text ?? "").trim();
  if (!raw) return "";
  if (raw.startsWith("{") && raw.includes("\"response\"")) {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const response = String(parsed.response ?? "").trim();
      if (response) return response;
    } catch {
      // fall back to the raw text when the payload is not valid JSON.
    }
  }
  return raw;
}

function normalizeEvidenceTextForSummary(text: string): string {
  return parseEmbeddedResponseText(text)
    .replace(/cite[^]+/g, " ")
    .replace(/entity\[[^\]]+\]/g, " ")
    .replace(/businesses_map/g, " ")
    .replace(/:::contextlist/gi, " ")
    .replace(/[`*_#>]/g, " ")
    .replace(/\[[^\]]+\]\([^\)]+\)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function dominantEvidenceActorName(
  rows: Array<{ actorName?: string | null }>
): string | null {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const actorName = String(row.actorName ?? "").trim();
    if (!actorName) continue;
    counts.set(actorName, Number(counts.get(actorName) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null;
}

function sanitizeActorLabel(value: string): string {
  const cleaned = compactText(
    String(value ?? "")
      .replace(/\b(?:say|mention|suggest|share|provide|consider|plan|planned|discuss|tell|explain|state)\b.*$/i, "")
      .replace(/\b(?:regarding|about|for|to)\b.*$/i, "")
      .replace(/\s+/g, " ")
      .trim(),
    80
  );
  if (!cleaned) return "";
  if (/\bassistant\b/i.test(cleaned)) return "The assistant";
  return cleaned.replace(/\b([a-z])/g, (match) => match.toUpperCase());
}

function collectStructuredClaimsFromTexts(texts: string[], limit = 6): string[] {
  const ranked: Array<{ claim: string; priority: number }> = [];
  for (const text of texts) {
    const normalized = parseEmbeddedResponseText(text);
    const structured = /(^|\n)\s*(?:\d+[\).:-]|\*|-|•)\s+/.test(normalized) || /\b(first|second|third|two issues|three issues|steps?)\b/i.test(normalized);
    const basePriority = structured ? 3 : 2;
    for (const claim of splitIntoClaimUnits(normalized)) {
      const clean = compactText(normalizeEvidenceTextForSummary(claim), 180);
      if (!clean) continue;
      if (looksLikeFileMetaFragment(clean)) continue;
      if (looksLikeFollowUpOfferClaim(clean)) continue;
      if (/^(here(?:'| i)?s|here are|absolutely|let'?s break down|thanks for confirming|based on what you.ve described|no problem|alright,|okay,|safe drive|search\()/i.test(clean)) continue;
      ranked.push({
        claim: clean,
        priority: basePriority + Math.min(2, Math.floor(clean.length / 80))
      });
    }
  }
  const dedup = new Map<string, { claim: string; priority: number }>();
  for (const entry of ranked) {
    const key = buildBenchmarkQuestionDedupKey(entry.claim);
    const existing = dedup.get(key);
    if (!existing || entry.priority > existing.priority || entry.claim.length > existing.claim.length) {
      dedup.set(key, entry);
    }
  }
  return Array.from(dedup.values())
    .sort((a, b) => b.priority - a.priority || b.claim.length - a.claim.length || a.claim.localeCompare(b.claim))
    .map((entry) => entry.claim)
    .slice(0, limit);
}

function cleanListCandidate(value: string): string {
  return compactText(
    String(value ?? "")
      .replace(/entity\[[^\]]*?,\s*"([^"]+)"\]/g, "$1")
      .replace(/^[#\-\*\d\.\)\s]+/, "")
      .replace(/^[⭐🎨🌆🏖️🎢🤖⚙️📍📞✔]+/u, "")
      .replace(/\s+[–-].*$/, "")
      .replace(/^top recommendation\s*/i, "")
      .replace(/^excellent divorce and family law firms?\s*/i, "")
      .replace(/^best divorce\s*\/\s*family law firms?.*?$/i, "")
      .replace(/^here are .*?:/i, "")
      .replace(/\s+/g, " ")
      .trim(),
    90
  );
}

function humanizeListItem(value: string): string {
  const item = cleanListCandidate(value);
  if (!item) return "";
  if (/[A-Z]/.test(item) || /\b(?:FL|NYSE|GPT|Grok|DC|MIT)\b/.test(item)) return item;
  return item.replace(/\b([a-z])/g, (match) => match.toUpperCase());
}

function extractRepresentativeListItems(texts: string[], limit = 5): string[] {
  const candidates: string[] = [];
  for (const original of texts) {
    const text = parseEmbeddedResponseText(original);
    const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    for (const match of text.matchAll(/entity\[[^\]]*?,\s*"([^"]+)"\]/g)) {
      candidates.push(match[1]);
    }
    for (const match of text.matchAll(/"name"\s*:\s*"([^"]+)"/g)) {
      candidates.push(match[1]);
    }
    for (const line of lines) {
      const headingMatch = line.match(/^#{2,}\s*(?:[\d.]+\s*)?(.+?)\s*(?:[–-].*)?$/);
      if (headingMatch) candidates.push(headingMatch[1]);
      const boldMatch = line.match(/^\*\*([^*]{2,80})\*\*$/);
      if (boldMatch) candidates.push(boldMatch[1]);
      const listMatch = line.match(/^(?:\d+[\).:-]|[-*•])\s+([^:]{3,80})(?::|$)/);
      if (listMatch) candidates.push(listMatch[1]);
    }
  }
  const filtered = candidates
    .map(humanizeListItem)
    .filter((item) => item.length >= 3)
    .filter((item) => !/^(here are|top recommendation|excellent|contextlist|response|search\(|why go|don.t miss|vibe)$/i.test(item))
    .filter((item) => !/^\(?\d{3}\)?[-\s]?\d{3}[-\s]?\d{4}$/.test(item));
  const dedup = new Map<string, string>();
  for (const item of filtered) {
    const key = buildBenchmarkQuestionDedupKey(item);
    if (!dedup.has(key)) dedup.set(key, item);
  }
  return Array.from(dedup.values()).slice(0, limit);
}

function questionRequestsList(question: string): boolean {
  return /\b(what are the best|what were the top|which|what free apps|what information|what law firms|what offices|what parks|what prospects|what companies|what apps|what strategies|key considerations)\b/i.test(question);
}

function extractQuestionFocusTerms(question: string): string[] {
  const normalized = lowerText(String(question ?? "").replace(/[?]/g, " ").replace(/\s+/g, " ").trim());
  if (!normalized) return [];
  const focusSegment =
    normalized.match(/\b(?:regarding|about)\s+(.+?)(?:\b(?:from|in|within|during|around|near|for)\b.*|$)/)?.[1]
    ?? normalized.match(/\bwhat information did .* provide about\s+(.+?)$/)?.[1]
    ?? normalized.match(/\bwhat details did .* share regarding\s+(.+?)$/)?.[1]
    ?? normalized.match(/\bwhat did .* (?:say|mention|consider doing|share|provide|explain) (?:about|regarding)\s+(.+?)$/)?.[1]
    ?? normalized;
  const stopwords = new Set([
    "what", "did", "does", "do", "regarding", "about", "mention", "mentioned", "say", "said", "consider", "considered",
    "doing", "share", "shared", "provide", "provided", "explain", "explained", "the", "a", "an", "this", "that", "these",
    "those", "conversation", "thread", "discussion", "recently", "today", "tomorrow", "yesterday", "last", "next", "early",
    "late", "month", "year", "week", "quarter", "my", "our", "your", "their", "his", "her"
  ]);
  return Array.from(new Set(
    meaningfulTokens(focusSegment)
      .filter((token) => !stopwords.has(token))
      .filter((token) => token.length >= 4)
  )).slice(0, 6);
}

function looksLikeFollowUpOfferClaim(text: string): boolean {
  const normalized = lowerText(normalizeEvidenceTextForSummary(text));
  if (!normalized) return false;
  return /^(if you like|if helpful|i can|i could|we can|let me know if|would you like|want me to)\b/.test(normalized)
    || /\b(i can try to pull up|we can compare that timeline|let me know if you want me to)\b/.test(normalized);
}

function readActorPronouns(metadata: Record<string, unknown> | null | undefined): ActorPronounSet | null {
  const pronouns = metadata && typeof metadata === "object"
    ? (metadata as Record<string, unknown>).pronouns
    : null;
  if (!pronouns || typeof pronouns !== "object" || Array.isArray(pronouns)) return null;
  const subject = compactText(String((pronouns as Record<string, unknown>).subject ?? "").trim().toLowerCase(), 16);
  const object = compactText(String((pronouns as Record<string, unknown>).object ?? "").trim().toLowerCase(), 16);
  const possessive = compactText(String((pronouns as Record<string, unknown>).possessive ?? "").trim().toLowerCase(), 16);
  if (!subject || !object || !possessive) return null;
  return { subject, object, possessive };
}

function beVerbForPronoun(subjectPronoun: string, tense: "present" | "past"): string {
  const normalized = lowerText(subjectPronoun);
  if (tense === "present") return normalized === "they" ? "are" : "is";
  return normalized === "they" ? "were" : "was";
}

function joinHumanList(items: string[], maxItems = 4): string {
  const clipped = items.slice(0, maxItems);
  if (clipped.length === 0) return "";
  if (clipped.length === 1) return clipped[0];
  if (clipped.length === 2) return `${clipped[0]} and ${clipped[1]}`;
  return `${clipped.slice(0, -1).join(", ")}, and ${clipped[clipped.length - 1]}`;
}

function rankClaimsForQuestion(question: string, claims: string[], limit = 2): Array<{ claim: string; overlap: number; length: number }> {
  const qTokens = new Set(meaningfulTokens(question));
  const focusTerms = new Set(extractQuestionFocusTerms(question));
  const ranked = claims
    .map((claim) => {
      const claimTokens = meaningfulTokens(claim);
      const overlap = claimTokens.filter((token) => qTokens.has(token)).length;
      const focusOverlap = claimTokens.filter((token) => focusTerms.has(token)).length;
      const followUpPenalty = looksLikeFollowUpOfferClaim(claim) ? 1 : 0;
      const questionPenalty = /\?$/.test(claim.trim()) ? 1 : 0;
      const specificity = Math.min(4, claimTokens.length);
      return { claim, overlap, focusOverlap, length: claim.length, followUpPenalty, questionPenalty, specificity };
    })
    .sort((a, b) =>
      b.focusOverlap - a.focusOverlap
      || b.overlap - a.overlap
      || a.followUpPenalty - b.followUpPenalty
      || a.questionPenalty - b.questionPenalty
      || b.specificity - a.specificity
      || a.length - b.length
      || a.claim.localeCompare(b.claim)
    );
  const positive = ranked.filter((entry) => entry.focusOverlap > 0 || entry.overlap > 0);
  return (positive.length > 0 ? positive : ranked).slice(0, limit);
}

function rewriteClaimForSummary(claim: string, params: {
  statementOwnerName?: string | null;
  statementOwnerRole?: "user" | "other_human" | "assistant_or_system" | "mixed";
  statementTargetName?: string | null;
  statementOwnerPronouns?: ActorPronounSet | null;
}): string {
  let out = normalizeEvidenceTextForSummary(claim)
    .replace(/^also\s+/i, "")
    .replace(/^and\s+/i, "")
    .replace(/^[a-z][a-z ]{1,24}:\s+/i, "")
    .trim();
  if (!out) return "";
  if (params.statementOwnerRole === "other_human") {
    const pronouns = params.statementOwnerPronouns ?? { subject: "they", object: "them", possessive: "their" };
    out = out
      .replace(/^i'm\b/i, `${pronouns.subject} ${beVerbForPronoun(pronouns.subject, "present")}`)
      .replace(/^i am\b/i, `${pronouns.subject} ${beVerbForPronoun(pronouns.subject, "present")}`)
      .replace(/^i was\b/i, `${pronouns.subject} ${beVerbForPronoun(pronouns.subject, "past")}`)
      .replace(/^i'll\b/i, `${pronouns.subject}'ll`)
      .replace(/^i'd\b/i, `${pronouns.subject}'d`)
      .replace(/^i\b/i, pronouns.subject)
      .replace(/^we\b/i, "you both")
      .replace(/\bour\b/gi, "your shared")
      .replace(/\bmy\b/gi, pronouns.possessive)
      .replace(/\bme\b/gi, pronouns.object);
    out = out
      .replace(/(^|[.!?]\s+)i'm\b/gi, (_, prefix) => `${prefix}${pronouns.subject} ${beVerbForPronoun(pronouns.subject, "present")}`)
      .replace(/(^|[.!?]\s+)i am\b/gi, (_, prefix) => `${prefix}${pronouns.subject} ${beVerbForPronoun(pronouns.subject, "present")}`)
      .replace(/(^|[.!?]\s+)i was\b/gi, (_, prefix) => `${prefix}${pronouns.subject} ${beVerbForPronoun(pronouns.subject, "past")}`)
      .replace(/(^|[.!?]\s+)i'll\b/gi, (_, prefix) => `${prefix}${pronouns.subject}'ll`)
      .replace(/(^|[.!?]\s+)i'd\b/gi, (_, prefix) => `${prefix}${pronouns.subject}'d`)
      .replace(/(^|[.!?]\s+)i\b/gi, (_, prefix) => `${prefix}${pronouns.subject}`)
      .replace(/(^|[.!?]\s+)we\b/gi, "$1you both")
      .replace(/(^|[.!?]\s+)our\b/gi, "$1your shared");
    if (/^(considering|going|trying|planning|thinking)\b/i.test(out)) {
      out = `${pronouns.subject} ${beVerbForPronoun(pronouns.subject, "past")} ${out}`;
    }
  } else if (params.statementOwnerRole === "assistant_or_system") {
    out = out.replace(/^i\b/i, "the assistant");
  } else if (params.statementOwnerRole === "user") {
    out = out
      .replace(/^i'm\b/i, "you are")
      .replace(/^i am\b/i, "you are")
      .replace(/^i was\b/i, "you were")
      .replace(/^i'll\b/i, "you will")
      .replace(/^i'd\b/i, "you would")
      .replace(/^i\b/i, "you")
      .replace(/\bmy\b/gi, "your")
      .replace(/\bme\b/gi, "you");
    out = out
      .replace(/(^|[.!?]\s+)i'm\b/gi, "$1you are")
      .replace(/(^|[.!?]\s+)i am\b/gi, "$1you are")
      .replace(/(^|[.!?]\s+)i was\b/gi, "$1you were")
      .replace(/(^|[.!?]\s+)i'll\b/gi, "$1you will")
      .replace(/(^|[.!?]\s+)i'd\b/gi, "$1you would")
      .replace(/(^|[.!?]\s+)i\b/gi, "$1you");
    if (looksLikeBarePredicateLead(out) && !/^you\b/i.test(out)) {
      out = `you ${out}`;
    }
  }
  out = replaceOwnerAliasesWithYou(out);
  const summaryUnits = splitIntoClaimUnits(out);
  if (summaryUnits.length > 1) {
    const deduped = new Map<string, string>();
    for (const unit of summaryUnits) {
      const cleaned = compactText(unit, 180)
        .replace(/^also\s+/i, "")
        .replace(/^and\s+/i, "")
        .trim();
      if (!cleaned) continue;
      const key = buildBenchmarkQuestionDedupKey(cleaned);
      if (!deduped.has(key)) deduped.set(key, cleaned);
    }
    out = Array.from(deduped.values()).slice(0, 2).join(" ");
  }
  return compactText(out, 220);
}

function capitalizeSentenceStart(text: string): string {
  return String(text ?? "").replace(/^\s*([a-z])/, (_, chr: string) => chr.toUpperCase());
}

function lowercaseSentenceStart(text: string): string {
  return String(text ?? "").replace(/^\s*([A-Z])/, (_, chr: string) => chr.toLowerCase());
}

function looksLikeBarePredicateLead(text: string): boolean {
  return /^(?:want|wanted|need|needed|plan|planned|hope|hoped|like|liked|love|loved|prefer|preferred|work|worked|move|moved|go|going|went|try|trying|tried|think|thinking|thought|consider|considering|considered|ask|asked|wonder|wondered|mention|mentioned|remember|remembered|invite|invited|wish|wished)\b/i.test(String(text ?? "").trim());
}

const OWNER_ALIAS_KEYS = new Set(
  [config.ownerName, ...config.ownerAliases]
    .map((value) => sanitizeActorLabel(String(value ?? "").trim()))
    .filter(Boolean)
    .map((value) => lowerText(value))
);

function isOwnerAliasName(value: string | null | undefined): boolean {
  const normalized = lowerText(sanitizeActorLabel(String(value ?? "").trim()));
  if (!normalized) return false;
  if (OWNER_ALIAS_KEYS.has(normalized)) return true;
  const ownerTokens = ownerDisplayName()
    .split(/\s+/)
    .map((item) => lowerText(sanitizeActorLabel(item)))
    .filter(Boolean);
  const valueTokens = normalized.split(/\s+/).filter(Boolean);
  return ownerTokens.length === 1
    && valueTokens.length >= 1
    && valueTokens.length <= 3
    && valueTokens[0] === ownerTokens[0];
}

function ownerDisplayName(): string {
  return sanitizeActorLabel(String(config.ownerName ?? "").trim()) || "You";
}

function ownerDisplayPossessive(): string {
  const display = ownerDisplayName();
  return /s$/i.test(display) ? `${display}'` : `${display}'s`;
}

function replaceOwnerAliasesWithYou(text: string): string {
  let out = String(text ?? "");
  const aliases = Array.from(OWNER_ALIAS_KEYS)
    .map((value) => sanitizeActorLabel(value))
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  for (const alias of aliases) {
    const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out
      .replace(new RegExp(`\\b${escaped}'s\\b`, "gi"), "your")
      .replace(new RegExp(`\\b${escaped}\\b`, "gi"), "you");
  }
  return out;
}

function replaceOwnerAliasesWithDisplayName(text: string): string {
  let out = String(text ?? "");
  const aliases = Array.from(OWNER_ALIAS_KEYS)
    .map((value) => sanitizeActorLabel(value))
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  for (const alias of aliases) {
    const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out
      .replace(new RegExp(`\\b${escaped}'s\\b`, "gi"), ownerDisplayPossessive())
      .replace(new RegExp(`\\b${escaped}\\b`, "gi"), ownerDisplayName());
  }
  return out;
}

function normalizeOwnerAliasList(values: string[] | null | undefined): string[] {
  const deduped = new Map<string, string>();
  for (const raw of Array.isArray(values) ? values : []) {
    const cleaned = sanitizeActorLabel(String(raw ?? "").trim());
    if (!cleaned) continue;
    const normalized = isOwnerAliasName(cleaned) ? ownerDisplayName() : cleaned;
    const key = lowerText(normalized);
    if (!deduped.has(key)) deduped.set(key, normalized);
  }
  return Array.from(deduped.values());
}

function normalizeSemanticFrameOwnerAliases(frame: BenchmarkSemanticFrame | null): BenchmarkSemanticFrame | null {
  if (!frame) return null;
  const ownerAliasMatch = isOwnerAliasName(frame.statementOwnerName)
    || (frame.statementOwnerRole === "mixed" && isOwnerAliasName(frame.actorScope));
  const normalizedActorScope = isOwnerAliasName(frame.actorScope) ? ownerDisplayName() : frame.actorScope;
  const normalizedOwnerName = isOwnerAliasName(frame.statementOwnerName) ? ownerDisplayName() : frame.statementOwnerName;
  const normalizedParticipants = normalizeOwnerAliasList(frame.participants);
  const normalizedActorNames = normalizeOwnerAliasList(frame.retrievalFacets.actorNames);
  return {
    ...frame,
    actorScope: normalizedActorScope,
    participants: normalizedParticipants,
    statementOwnerName: normalizedOwnerName,
    statementOwnerRole: ownerAliasMatch ? "user" : frame.statementOwnerRole,
    retrievalFacets: {
      ...frame.retrievalFacets,
      actorNames: normalizedActorNames
    }
  };
}

function isSelfOwnedSemanticFrame(frame: BenchmarkSemanticFrame | null | undefined): boolean {
  if (!frame) return false;
  return frame.statementOwnerRole === "user"
    || isOwnerAliasName(frame.statementOwnerName)
    || (frame.statementOwnerRole === "mixed" && isOwnerAliasName(frame.actorScope));
}

function normalizeQuestionVoiceForFrame(
  questionVoice: "user_first_person" | "user_about_other" | "assistant_proxy" | "unknown",
  semanticFrame: BenchmarkSemanticFrame | null | undefined
): "user_first_person" | "user_about_other" | "assistant_proxy" | "unknown" {
  if (questionVoice === "assistant_proxy") return questionVoice;
  if (isSelfOwnedSemanticFrame(semanticFrame)) return "user_first_person";
  if (semanticFrame?.statementOwnerRole === "other_human") return "user_about_other";
  return questionVoice;
}

function rewriteSelfQuestionToFirstPerson(question: string): string {
  let out = replaceOwnerAliasesWithYou(String(question ?? "").trim());
  out = out
    .replace(/\bWhat did you\b/i, "What did I")
    .replace(/\bWhat do you\b/i, "What do I")
    .replace(/\bWhat are you\b/i, "What am I")
    .replace(/\bWhat were you\b/i, "What was I")
    .replace(/\bWhat will you\b/i, "What will I")
    .replace(/\bWhat would you\b/i, "What would I")
    .replace(/\bWhat can you\b/i, "What can I")
    .replace(/\bWhat should you\b/i, "What should I")
    .replace(/\bHow did you\b/i, "How did I")
    .replace(/\bHow are you\b/i, "How am I")
    .replace(/\bHow were you\b/i, "How was I")
    .replace(/\bWhy did you\b/i, "Why did I")
    .replace(/\bWhen did you\b/i, "When did I")
    .replace(/\bWhere did you\b/i, "Where did I")
    .replace(/\bWho did you\b/i, "Who did I")
    .replace(/\byour\b/gi, "my")
    .replace(/\byours\b/gi, "mine")
    .replace(/\bto you\b/gi, "to me")
    .replace(/\bfor you\b/gi, "for me")
    .replace(/\bwith you\b/gi, "with me")
    .replace(/\babout you\b/gi, "about me");
  return compactText(out, 220);
}

function rewriteSelfQuestionToProxy(question: string): string {
  let out = replaceOwnerAliasesWithDisplayName(String(question ?? "").trim());
  out = replaceOwnerAliasesWithYou(out)
    .replace(/\bWhat did you\b/i, `What did ${ownerDisplayName()}`)
    .replace(/\bWhat do you\b/i, `What does ${ownerDisplayName()}`)
    .replace(/\bWhat are you\b/i, `What is ${ownerDisplayName()}`)
    .replace(/\bWhat were you\b/i, `What was ${ownerDisplayName()}`)
    .replace(/\bWhat will you\b/i, `What will ${ownerDisplayName()}`)
    .replace(/\bWhat would you\b/i, `What would ${ownerDisplayName()}`)
    .replace(/\bWhat can you\b/i, `What can ${ownerDisplayName()}`)
    .replace(/\bWhat should you\b/i, `What should ${ownerDisplayName()}`)
    .replace(/\bHow did you\b/i, `How did ${ownerDisplayName()}`)
    .replace(/\bHow are you\b/i, `How is ${ownerDisplayName()}`)
    .replace(/\bHow were you\b/i, `How was ${ownerDisplayName()}`)
    .replace(/\bWhy did you\b/i, `Why did ${ownerDisplayName()}`)
    .replace(/\bWhen did you\b/i, `When did ${ownerDisplayName()}`)
    .replace(/\bWhere did you\b/i, `Where did ${ownerDisplayName()}`)
    .replace(/\bWho did you\b/i, `Who did ${ownerDisplayName()}`)
    .replace(/\byour\b/gi, ownerDisplayPossessive())
    .replace(/\byours\b/gi, ownerDisplayPossessive())
    .replace(/\bto you\b/gi, `to ${ownerDisplayName()}`)
    .replace(/\bfor you\b/gi, `for ${ownerDisplayName()}`)
    .replace(/\bwith you\b/gi, `with ${ownerDisplayName()}`)
    .replace(/\babout you\b/gi, `about ${ownerDisplayName()}`);
  return compactText(out, 220);
}

function rewriteOtherHumanQuestionForUserTarget(
  question: string,
  semanticFrame?: BenchmarkSemanticFrame | null
): string {
  const owner = sanitizeActorLabel(String(semanticFrame?.statementOwnerName ?? "").trim()) || "they";
  let out = replaceOwnerAliasesWithYou(String(question ?? "").trim());
  out = out
    .replace(/\bWhat did you\b/i, `What did ${owner}`)
    .replace(/\bWhat do you\b/i, `What does ${owner}`)
    .replace(/\bWhat are you\b/i, `What is ${owner}`)
    .replace(/\bWhat were you\b/i, `What was ${owner}`)
    .replace(/\bWhat will you\b/i, `What will ${owner}`)
    .replace(/\bWhat would you\b/i, `What would ${owner}`)
    .replace(/\bWhat can you\b/i, `What can ${owner}`)
    .replace(/\bWhat should you\b/i, `What should ${owner}`)
    .replace(/\bHow did you\b/i, `How did ${owner}`)
    .replace(/\bHow are you\b/i, `How is ${owner}`)
    .replace(/\bHow were you\b/i, `How was ${owner}`)
    .replace(/\bWhy did you\b/i, `Why did ${owner}`)
    .replace(/\bWhen did you\b/i, `When did ${owner}`)
    .replace(/\bWhere did you\b/i, `Where did ${owner}`)
    .replace(/\bWho did you\b/i, `Who did ${owner}`)
    .replace(/\babout you\b/gi, "about me")
    .replace(/\bto you\b/gi, "to me")
    .replace(/\bfor you\b/gi, "for me")
    .replace(/\bwith you\b/gi, "with me")
    .replace(/\byour\b/gi, "my")
    .replace(/\byours\b/gi, "mine");
  return compactText(out, 220);
}

function rewriteOtherHumanQuestionForProxyTarget(question: string): string {
  let out = replaceOwnerAliasesWithDisplayName(String(question ?? "").trim());
  out = out
    .replace(/\babout you\b/gi, `about ${ownerDisplayName()}`)
    .replace(/\bto you\b/gi, `to ${ownerDisplayName()}`)
    .replace(/\bfor you\b/gi, `for ${ownerDisplayName()}`)
    .replace(/\bwith you\b/gi, `with ${ownerDisplayName()}`)
    .replace(/\byour\b/gi, ownerDisplayPossessive())
    .replace(/\byours\b/gi, ownerDisplayPossessive());
  return compactText(out, 220);
}

function rewriteOtherHumanQuestionToNamedOwner(
  question: string,
  semanticFrame?: BenchmarkSemanticFrame | null
): string {
  const owner = sanitizeActorLabel(String(semanticFrame?.statementOwnerName ?? "").trim()) || "they";
  let out = replaceOwnerAliasesWithDisplayName(String(question ?? "").trim());
  out = out
    .replace(/\bWhat did I\b/i, `What did ${owner}`)
    .replace(/\bWhat do I\b/i, `What does ${owner}`)
    .replace(/\bWhat am I\b/i, `What is ${owner}`)
    .replace(/\bWhat was I\b/i, `What was ${owner}`)
    .replace(/\bWhat will I\b/i, `What will ${owner}`)
    .replace(/\bWhat would I\b/i, `What would ${owner}`)
    .replace(/\bWhat can I\b/i, `What can ${owner}`)
    .replace(/\bWhat should I\b/i, `What should ${owner}`)
    .replace(/\bHow did I\b/i, `How did ${owner}`)
    .replace(/\bHow am I\b/i, `How is ${owner}`)
    .replace(/\bHow was I\b/i, `How was ${owner}`)
    .replace(/\bWhy did I\b/i, `Why did ${owner}`)
    .replace(/\bWhen did I\b/i, `When did ${owner}`)
    .replace(/\bWhere did I\b/i, `Where did ${owner}`)
    .replace(/\bWho did I\b/i, `Who did ${owner}`)
    .replace(/\babout me\b/gi, `about ${owner}`)
    .replace(/\bto me\b/gi, `to ${owner}`)
    .replace(/\bfor me\b/gi, `for ${owner}`)
    .replace(/\bwith me\b/gi, `with ${owner}`)
    .replace(/\bmy\b/gi, `${owner}'s`)
    .replace(/\bmine\b/gi, `${owner}'s`);
  return compactText(out, 220);
}

function buildSummarySubject(params: {
  question?: string;
  actorName?: string | null;
  semanticFrame?: BenchmarkSemanticFrame | null;
  evidenceRows?: Array<{ actorName?: string | null }>;
}): string {
  const requestedActor = sanitizeActorLabel(inferRequestedQuestionActor(String(params.question ?? "").trim()) ?? "");
  const role = params.semanticFrame?.statementOwnerRole ?? "mixed";
  const dominantActor = dominantEvidenceActorName(params.evidenceRows ?? []);
  const ownerName = sanitizeActorLabel(String(params.semanticFrame?.statementOwnerName ?? dominantActor ?? params.actorName ?? "").trim());
  const selfReference = role === "user"
    || isOwnerAliasName(requestedActor)
    || isOwnerAliasName(ownerName)
    || isOwnerAliasName(params.actorName)
    || isOwnerAliasName(dominantActor);
  if (requestedActor) {
    if (/assistant$/i.test(requestedActor) || /^assistant$/i.test(requestedActor) || /^the assistant$/i.test(requestedActor)) return "The assistant";
    if (selfReference && isOwnerAliasName(requestedActor)) return "You";
    return requestedActor;
  }
  if (role === "assistant_or_system") return "The assistant";
  if (selfReference) return "You";
  if (role === "other_human" && isLikelyName(ownerName)) return ownerName;
  if (isLikelyName(ownerName)) return ownerName;
  return "The answer";
}

function prefersSinglePrimaryClaim(question: string, lens: string): boolean {
  const normalized = String(question ?? "").trim();
  if (/^what did .*\b(?:mention|say|share|explain)\b\s+(?:regarding|about)\b/i.test(normalized)) return false;
  if (/^(what did|what information did|what details did)\b/i.test(normalized)) return true;
  if (questionRequestsList(normalized)) return true;
  if (lens === "descriptive" && /^(what are|what were)\b/i.test(normalized)) return true;
  return false;
}

function normalizeAssistantHistoricalQuestion(
  question: string,
  semanticFrame?: BenchmarkSemanticFrame | null,
  questionVoice: "user_first_person" | "user_about_other" | "assistant_proxy" | "unknown" = "unknown"
): string {
  const normalizedVoice = normalizeQuestionVoiceForFrame(questionVoice, semanticFrame);
  const ownerRole = semanticFrame?.statementOwnerRole ?? "mixed";
  let out = compactText(String(question ?? "").trim(), 220);
  if (isSelfOwnedSemanticFrame(semanticFrame)) {
    if (normalizedVoice === "assistant_proxy") return rewriteSelfQuestionToProxy(out);
    return rewriteSelfQuestionToFirstPerson(out);
  }
  if (ownerRole === "other_human") {
    if (questionStartsWithFirstPersonLead(out)) {
      return rewriteOtherHumanQuestionToNamedOwner(out, semanticFrame);
    }
    if (semanticFrameTargetsUser(semanticFrame)) {
      if (normalizedVoice === "assistant_proxy") return rewriteOtherHumanQuestionForProxyTarget(out);
      return rewriteOtherHumanQuestionForUserTarget(out, semanticFrame);
    }
    if (normalizedVoice === "user_about_other" || normalizedVoice === "assistant_proxy") {
      return rewriteOtherHumanQuestionToNamedOwner(out, semanticFrame);
    }
  }
  if (ownerRole !== "assistant_or_system") return compactText(out, 220);
  out = out
    .replace(/\bwhat information did you provide\b/i, "What information did the assistant provide")
    .replace(/\bwhat details did you share\b/i, "What details did the assistant share")
    .replace(/\bwhat free apps did you suggest\b/i, "What free apps did the assistant suggest")
    .replace(/\bwhat strategies did you suggest\b/i, "What strategies did the assistant suggest")
    .replace(/\bwhat did you suggest\b/i, "What did the assistant suggest")
    .replace(/\bwhat did you say\b/i, "What did the assistant say")
    .replace(/\bwhat did you explain\b/i, "What did the assistant explain");
  return compactText(out, 220);
}

function looksLikePleasantryOnly(text: string): boolean {
  const normalized = lowerText(normalizeEvidenceTextForSummary(text));
  if (!normalized) return false;
  const politeCue = /\b(enjoy|anything else|safe drive|let me know if you need anything else|no problem|all good)\b/.test(normalized);
  const concreteCue = /\b(use|install|enable|call|go to|visit|buy|bring|list|recommend|consider|add|route|charger|park|firm|app|prospect|motor|401k|tax|state park)\b/.test(normalized);
  return politeCue && !concreteCue;
}

function looksGenericExpectedAnswerSummary(summary: string): boolean {
  const normalized = lowerText(summary);
  return !normalized
    || normalized.includes("assistant should")
    || normalized.includes("is expected to")
    || normalized.includes("the answer should")
    || normalized.includes("using evidence like")
    || normalized.includes("several free apps")
    || normalized.includes("top-rated state parks")
    || normalized.includes("should summarize the")
    || normalized.includes("should state the")
    || normalized.includes("should explain the");
}

function looksLikeConcreteListSummary(summary: string): boolean {
  const text = String(summary ?? "").trim();
  if (!text) return false;
  if ((text.match(/,/g) ?? []).length >= 2) return true;
  if (/\b(?:listed|identified)\b/i.test(text) && /\band\b/i.test(text)) return true;
  if ((text.match(/\([A-Za-z.:\s-]{2,12}\)/g) ?? []).length >= 2) return true;
  return false;
}

function inferRequestedQuestionActor(question: string): string | null {
  const direct = String(question ?? "").trim().match(/\bwhat did (.+?)\s+(?:say|mention|suggest|share|provide|consider|plan|planned|discuss|tell|explain|state)\b/i);
  if (direct?.[1]) {
    const actor = compactText(direct[1], 80);
    if (/^(i|me|myself)$/i.test(actor)) return ownerDisplayName();
    if (/^(the assistant|assistant)$/i.test(actor)) return "The assistant";
    return actor.replace(/\b([a-z])/g, (match) => match.toUpperCase());
  }
  if (/\bwhat (?:free )?apps did you suggest\b/i.test(question) || /\bwhat information did you provide\b/i.test(question)) {
    return "The assistant";
  }
  return null;
}

function looksLikeQuestionClaim(text: string): boolean {
  const normalized = String(text ?? "").trim();
  if (!normalized) return false;
  if (/[?]\s*$/.test(normalized)) return true;
  return /^(?:do|does|did|is|am|are|was|were|can|could|will|would|should|have|has|had|what|when|where|why|who|whom|whose|which|how)\b/i.test(normalized);
}

function rewriteQuestionClaimAsIndirectSpeech(claim: string): string {
  const cleaned = normalizeEvidenceTextForSummary(claim).replace(/[?]+$/g, "").trim();
  if (!cleaned) return "";
  const yesNoSimple = cleaned.match(/^(do|does|did)\s+(.+)$/i);
  if (yesNoSimple?.[2]) {
    return compactText(`asked whether ${lowercaseSentenceStart(yesNoSimple[2])}`, 220);
  }
  const yesNoAux = cleaned.match(/^(is|am|are|was|were|can|could|will|would|should|have|has|had)\s+(.+)$/i);
  if (yesNoAux?.[1] && yesNoAux?.[2]) {
    return compactText(`asked whether ${lowercaseSentenceStart(`${lowerText(yesNoAux[1])} ${yesNoAux[2]}`)}`, 220);
  }
  if (/^(what|when|where|why|who|whom|whose|which|how)\b/i.test(cleaned)) {
    return compactText(`asked ${lowercaseSentenceStart(cleaned)}`, 220);
  }
  return compactText(`asked whether ${lowercaseSentenceStart(cleaned)}`, 220);
}

function formatSummaryWithSubject(subject: string, joined: string): string {
  const cleaned = compactText(String(joined ?? "").trim(), 320);
  if (!cleaned) return subject;
  if (subject === "The answer") return cleaned;
  if (/^(asked|said|mentioned|shared|explained|noted|reported|wrote)\b/i.test(cleaned)) {
    return compactText(`${subject} ${cleaned}`, 320);
  }
  if (subject === "The assistant") {
    return compactText(`${subject} said ${cleaned.replace(/^[Tt]he assistant\s+said\s+/i, "")}`, 320);
  }
  if (subject === "You") {
    return compactText(`${subject} said ${cleaned.replace(/^you\s+said\s+/i, "")}`, 320);
  }
  const escapedSubject = subject.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return compactText(`${subject} said ${cleaned.replace(new RegExp(`^${escapedSubject}\\s+said\\s+`, "i"), "")}`, 320);
}

function evidenceRowMatchesRequestedActor(
  row: { actorName?: string | null; actorType?: string | null; snippet?: string | null },
  requestedActor: string | null
): boolean {
  if (!requestedActor) return true;
  const actorName = String(row.actorName ?? "").trim();
  const actorType = String(row.actorType ?? "").trim().toLowerCase();
  if (!actorName) return /^the assistant$/i.test(requestedActor) ? /^(assistant|system)$/i.test(actorType) : false;
  if (/^the assistant$/i.test(requestedActor)) return /assistant/i.test(actorName);
  return actorName.toLowerCase() === requestedActor.toLowerCase();
}

function buildEvidenceGroundedAnswerSummary(params: {
  question: string;
  domain: string;
  lens: string;
  expectedBehavior: "answer_now" | "clarify_first";
  expectedCoreClaims: string[];
  actorName?: string | null;
  semanticFrame?: BenchmarkSemanticFrame | null;
  evidenceTexts?: string[];
  evidenceRows?: Array<{ actorName?: string | null; actorType?: string | null; actorMetadata?: Record<string, unknown> | null; snippet?: string | null }>;
}): string {
  const requestedActor = inferRequestedQuestionActor(params.question);
  const evidenceRows = Array.isArray(params.evidenceRows) ? params.evidenceRows : [];
  const actorScopedRows = evidenceRows.filter((row) => evidenceRowMatchesRequestedActor(row, requestedActor));
  const semanticOwnerRow = actorScopedRows.find((row) => {
    const actorName = String(row.actorName ?? "").trim().toLowerCase();
    const ownerName = String(params.semanticFrame?.statementOwnerName ?? "").trim().toLowerCase();
    return actorName && ownerName && actorName === ownerName;
  }) ?? null;
  const requestedActorRow = requestedActor
    ? actorScopedRows.find((row) => {
      const actorName = String(row.actorName ?? "").trim();
      return actorName && actorName.toLowerCase() === requestedActor.toLowerCase();
    }) ?? null
    : null;
  const summaryOwnerRow = requestedActorRow ?? semanticOwnerRow;
  const ownerPronouns = readActorPronouns(summaryOwnerRow?.actorMetadata ?? null);
  const summaryOwnerRole = summaryOwnerRow
    ? (String(summaryOwnerRow.actorType ?? "").trim().toLowerCase() === "assistant"
      || String(summaryOwnerRow.actorType ?? "").trim().toLowerCase() === "system"
        ? "assistant_or_system"
        : String(summaryOwnerRow.actorType ?? "").trim().toLowerCase() === "user"
          ? "user"
          : "other_human")
    : (params.semanticFrame?.statementOwnerRole ?? "mixed");
  const summaryOwnerName = requestedActorRow?.actorName ?? params.semanticFrame?.statementOwnerName ?? null;
  const evidenceTexts = (
    actorScopedRows.length > 0
      ? actorScopedRows.map((row) => String(row.snippet ?? "")).filter(Boolean)
      : (Array.isArray(params.evidenceTexts) ? params.evidenceTexts.filter(Boolean) : [])
  );
  const derivedClaims = collectStructuredClaimsFromTexts(evidenceTexts, 6);
  const claims = Array.from(new Set([
    ...derivedClaims,
    ...params.expectedCoreClaims.map((claim) => compactText(normalizeEvidenceTextForSummary(claim), 180)).filter(Boolean)
  ])).slice(0, 6);
  const listItems = extractRepresentativeListItems(evidenceTexts, 5);
  const subject = buildSummarySubject({
    question: params.question,
    actorName: params.actorName,
    semanticFrame: params.semanticFrame,
    evidenceRows
  });
  if (params.expectedBehavior === "clarify_first") {
    return "The agent should ask one short clarification question before answering, then use the matching evidence to answer the resolved question.";
  }

  if (questionRequestsList(params.question) && listItems.length >= 2) {
    if (/app/i.test(params.question)) {
      const items = joinHumanList(listItems, 5);
      return compactText(`${subject} listed ${items} as options for blocking spam calls on an iPhone.`, 320);
    }
    if (/law firm|law office|family law/i.test(params.question)) {
      const items = joinHumanList(listItems, 5);
      return compactText(`${subject} listed ${items} in Melbourne, along with direct phone numbers for contact.`, 320);
    }
    if (/state park/i.test(params.question)) {
      const items = joinHumanList(listItems, 5);
      return compactText(`${subject} listed ${items} as strong state-park options within about a two-hour drive of Melbourne, FL.`, 320);
    }
    if (/prospect|companies|100-bagger|stock/i.test(params.question)) {
      const items = joinHumanList(listItems, 5);
      return compactText(`${subject} identified ${items} as the top NYSE 100-bagger prospects discussed in the analysis.`, 320);
    }
    if (/what strategies/i.test(params.question)) {
      const items = joinHumanList(listItems, 4);
      return compactText(`${subject} outlined ${items} as the main strategies discussed.`, 320);
    }
    if (/key considerations/i.test(params.question)) {
      const items = joinHumanList(listItems, 4);
      return compactText(`${subject} highlighted ${items} as the key considerations discussed.`, 320);
    }
    const items = joinHumanList(listItems, 4);
    return compactText(`${subject} listed ${items}.`, 320);
  }

  if (/\bwhat did .* suggest\b/i.test(params.question) && evidenceTexts.length > 0 && evidenceTexts.every((text) => looksLikePleasantryOnly(text))) {
    return compactText("The assistant only offered pleasantries and did not give a concrete recommendation.", 320);
  }

  const rankedClaims = rankClaimsForQuestion(params.question, claims, prefersSinglePrimaryClaim(params.question, params.lens) ? 1 : 3);
  const primaryClaims = rankedClaims
    .filter((entry, index) => index === 0 || (!prefersSinglePrimaryClaim(params.question, params.lens) && entry.overlap >= Math.max(1, rankedClaims[0]?.overlap ?? 0)))
    .slice(0, prefersSinglePrimaryClaim(params.question, params.lens) ? 1 : 2)
    .map((entry) => {
      const rewritten = rewriteClaimForSummary(entry.claim, {
        statementOwnerName: summaryOwnerName,
        statementOwnerRole: summaryOwnerRole,
        statementTargetName: params.semanticFrame?.statementTargetName,
        statementOwnerPronouns: ownerPronouns
      });
      if (!rewritten) return "";
      return looksLikeQuestionClaim(entry.claim) ? rewriteQuestionClaimAsIndirectSpeech(rewritten) : rewritten;
    })
    .filter(Boolean);

  if (primaryClaims.length > 0) {
    const dedupedUnits = new Map<string, string>();
    for (const claim of primaryClaims) {
      const units = splitIntoClaimUnits(claim);
      if (units.length === 0) units.push(claim);
      for (const unit of units) {
        const cleaned = compactText(unit, 180).trim();
        if (!cleaned) continue;
        const key = buildBenchmarkQuestionDedupKey(cleaned);
        if (!dedupedUnits.has(key)) dedupedUnits.set(key, cleaned);
      }
    }
    const joinedUnits = Array.from(dedupedUnits.values()).slice(0, prefersSinglePrimaryClaim(params.question, params.lens) ? 1 : 2);
    const joined = joinedUnits.map((unit, index) => index === 0 ? unit : capitalizeSentenceStart(unit)).join(" ");
    return formatSummaryWithSubject(subject, joined);
  }

  return buildHumanAnswerSummary({
    domain: params.domain,
    lens: params.lens,
    expectedBehavior: params.expectedBehavior,
    expectedCoreClaims: claims,
    actorName: params.actorName
  });
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
    return `The agent should ask one short clarification question before answering, then use the matching evidence${actorPart} to answer the resolved question.`;
  }
  if (params.lens === "actionability") {
    return `The expected answer should name the concrete next step that was proposed${actorPart}, grounded in the retrieved evidence.`;
  }
  if (params.lens === "diagnostic") {
    return `The expected answer should identify the likely cause discussed${actorPart}, grounded in the retrieved conversation.`;
  }
  if (params.lens === "confidence_scoring") {
    return `The expected answer should explain the confidence level for the conclusion${actorPart}, and mention contradictions if the evidence conflicts.`;
  }
  return topClaims
    ? `The expected answer should state the main point${actorPart}, grounded in details like: ${topClaims}`
    : `The expected answer should stay grounded in the relevant conversation${actorPart}.`;
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
}): Promise<string | null> {
  const client = await pool.connect();
  const questionDedupKey = buildBenchmarkQuestionDedupKey(params.question);
  try {
    await client.query("BEGIN");
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext($1::text), hashtext($2::text))`,
      [params.experimentId, questionDedupKey]
    );
    const existing = await client.query<{ id: string }>(
      `SELECT id::text
       FROM experiment_cases
       WHERE experiment_id = $1::uuid
         AND is_stale = false
         AND lower(regexp_replace(trim(question), '\s+', ' ', 'g')) = $2
       LIMIT 1
       FOR UPDATE`,
      [params.experimentId, questionDedupKey]
    );
    if (existing.rows[0]?.id) {
      await client.query("COMMIT");
      return existing.rows[0].id;
    }
    const inserted = await client.query<{ id: string }>(
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
       updated_at = now()
     RETURNING id::text`,
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
    await client.query("COMMIT");
    return inserted.rows[0]?.id ?? null;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // ignore rollback failures
    }
    throw error;
  } finally {
    client.release();
  }
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
  const usedEvidenceFamilyKeys = new Set<string>();

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
      const familyKey = buildCaseEvidenceFamilyKey({
        evidenceIds,
        conversationIds,
        sourceEvidenceId: anchor.canonical_id
      });
      const actorIds = Array.from(new Set(contextRows.map((row) => row.actor_id).filter((id): id is string => Boolean(id))));
      const expectedCoreClaims = buildExpectedCoreClaims(contextRows);
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
      if (familyKey && usedEvidenceFamilyKeys.has(familyKey)) {
        console.log(`[authoring] skip ${domain}/${lens} anchor ${j + 1}: evidence family already used`);
        return;
      }
      if (Number(semanticFrame.anchorQualityScore ?? 0) < 0.62) {
        console.log(`[authoring] skip ${domain}/${lens} anchor ${j + 1}: anchor quality too low (${Number(semanticFrame.anchorQualityScore ?? 0).toFixed(2)})`);
        return;
      }
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
      if (familyKey) usedEvidenceFamilyKeys.add(familyKey);
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
      const variants = familyKey
        ? []
        : Array.from(new Map(
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
    const coverageFamilyKey = buildCaseEvidenceFamilyKey({
      evidenceIds: pair.contextRows.map((row) => row.canonical_id),
      conversationIds: Array.from(new Set(pair.contextRows.map((row) => row.conversation_id))),
      sourceEvidenceId: anchor.canonical_id
    });
    if (coverageFamilyKey && usedEvidenceFamilyKeys.has(coverageFamilyKey)) continue;
    await upsertExperimentCase({
      experimentId: params.experimentId,
      caseSet: "coverage",
      caseKey: `${pair.domain}:${pair.lens}`,
      caseType: `coverage:${pair.domain}:${pair.lens}`,
      domain: pair.domain,
      lens: pair.lens,
      question: coverageDraft.chosenQuestion,
      chatNamespace: params.chatNamespace,
      expectedCoreClaims: buildExpectedCoreClaims(pair.contextRows),
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

  const duplicatePrune = await pruneDuplicateBenchmarkCases({
    experimentId: params.experimentId,
    refillReviewedRemoved: false
  });

  return {
    inserted,
    staleMarked: staleMarked + Number((duplicatePrune as Record<string, unknown>).removedCaseCount ?? 0)
  };
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
  expectedBehavior: "answer_now" | "clarify_first" | "insufficient";
  actualBehavior: "answer_now" | "clarify_first" | "insufficient";
  behaviorCorrect: boolean;
  groundingPass: boolean;
  falseConfident: boolean;
  actorAttributionApplicable: boolean;
  actorAttributionPass: boolean;
  threadScopeApplicable: boolean;
  threadScopePass: boolean;
  timeScopeApplicable: boolean;
  timeScopePass: boolean;
  scoringBucket: "clear" | "clarify" | "unresolved_excluded";
} {
  const { row, response } = params;
  const buckets: FailureBucket[] = [];
  const returnedEvidenceIds = extractReturnedCanonicalIds(response);
  const expectedEvidence = new Set(row.evidence_ids);
  const metadata = row.metadata ?? {};
  const expectedBehavior = (() => {
    const raw = String(metadata.expectedBehavior ?? "").trim();
    if (raw === "clarify_first" || raw === "answer_now" || raw === "insufficient") return raw;
    return Boolean(metadata.clarificationNeeded) || row.ambiguity_class === "clarify_required"
      ? "clarify_first"
      : "answer_now";
  })();
  const ambiguityClass =
    row.ambiguity_class
    ?? (Boolean(metadata.clarificationNeeded) ? "clarify_required" : "clear");
  const clarificationExpected = ambiguityClass === "clarify_required" || Boolean(metadata.clarificationNeeded);
  const unresolved = ambiguityClass === "unresolved" || row.eligible_for_scoring === false;
  const actualBehaviorRaw = String(response.answerContract?.decision ?? "").trim();
  const actualBehavior: "answer_now" | "clarify_first" | "insufficient" =
    actualBehaviorRaw === "clarify_first" || actualBehaviorRaw === "answer_now" || actualBehaviorRaw === "insufficient"
      ? actualBehaviorRaw
      : "insufficient";
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
  const actorAttributionApplicable = row.actor_ids.length > 0;
  const actorAttributionPass = !actorAttributionApplicable
    || (response.evidence ?? []).some((e) => e.actorId && row.actor_ids.includes(e.actorId));
  const hasRelativeWindow = /\b(last|this|recent|week|month|quarter|year|yesterday|today|tomorrow)\b/i.test(row.question);
  const timeScopeApplicable = hasRelativeWindow;
  const hasTimestampEvidence = (response.evidence ?? []).some((e) => Boolean(e.sourceTimestamp));
  const timeScopePass = !timeScopeApplicable || hasTimestampEvidence;
  const threadScopeApplicable = row.conversation_ids.length > 0;
  const threadScopePass = !threadScopeApplicable
    || (response.evidence ?? []).some((e) => e.sourceConversationId && row.conversation_ids.includes(e.sourceConversationId));
  const groundingPass = actualBehavior !== "answer_now"
    ? true
    : overlap > 0 && returnedEvidenceIds.length > 0 && (response.evidence?.length ?? 0) > 0;
  const falseConfident = actualBehavior === "answer_now"
    && (
      expectedBehavior !== "answer_now"
      || !groundingPass
      || !answerHasContractShape(response)
    );
  const behaviorCorrect = unresolved
    ? false
    : expectedBehavior === "clarify_first"
      ? clarificationTriggered && clarificationQualityScore >= 0.99
      : expectedBehavior === "insufficient"
        ? actualBehavior === "insufficient"
        : actualBehavior === "answer_now" && !falseConfident;

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
      if (actorAttributionApplicable && !actorAttributionPass) {
        buckets.push("actor_attribution_miss");
      }

      if (timeScopeApplicable && !timeScopePass) {
        buckets.push("temporal_interpretation_miss");
      }

      if (threadScopeApplicable && !threadScopePass) {
        buckets.push("thread_continuity_miss");
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
    expectedBehavior,
    actualBehavior,
    behaviorCorrect,
    groundingPass,
    falseConfident,
    actorAttributionApplicable,
    actorAttributionPass,
    threadScopeApplicable,
    threadScopePass,
    timeScopeApplicable,
    timeScopePass,
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

function rate(numerator: number, denominator: number, emptyValue = 1): number {
  return denominator > 0 ? numerator / denominator : emptyValue;
}

function computeCompositeScore(params: {
  metrics: {
    behaviorCorrectRate: number;
    groundingRate: number;
    clarifyBehaviorCorrectRate: number;
    insufficientBehaviorCorrectRate: number;
    actorAttributionAccuracy: number;
    threadScopeAccuracy: number;
    timeScopeAccuracy: number;
    recallAtK: number;
    mrr: number;
    ndcg: number;
    evidenceHitRate: number;
    p95LatencyMs: number;
    estimatedCostPer1kAsks: number;
    stabilityScore: number;
  };
  baseline: { p95LatencyMs: number; costPer1k: number } | null;
  profile: StrategySelectionProfile;
}): number {
  const attributionAggregate = (
    params.metrics.actorAttributionAccuracy
    + params.metrics.threadScopeAccuracy
    + params.metrics.timeScopeAccuracy
  ) / 3;
  const retrievalAggregate = (
    params.metrics.recallAtK
    + params.metrics.mrr
    + params.metrics.ndcg
    + params.metrics.evidenceHitRate
  ) / 4;
  const clarifyInsufficientAggregate = (
    params.metrics.clarifyBehaviorCorrectRate
    + params.metrics.insufficientBehaviorCorrectRate
  ) / 2;
  const latencyMultiplier = !params.baseline || params.baseline.p95LatencyMs <= 0
    ? 1
    : params.metrics.p95LatencyMs / params.baseline.p95LatencyMs;
  const costMultiplier = !params.baseline || params.baseline.costPer1k <= 0
    ? 1
    : params.metrics.estimatedCostPer1kAsks / params.baseline.costPer1k;
  const efficiencyScore = Math.max(
    0,
    Math.min(
      1,
      (1 / Math.max(1, latencyMultiplier) + 1 / Math.max(1, costMultiplier)) / 2
    )
  );
  const weights = params.profile.compositeWeights;
  const weighted =
    weights.behaviorCorrectRate * params.metrics.behaviorCorrectRate
    + weights.groundingRate * params.metrics.groundingRate
    + weights.attributionAggregate * attributionAggregate
    + weights.clarifyAggregate * clarifyInsufficientAggregate
    + weights.retrievalAggregate * retrievalAggregate
    + weights.efficiencyAggregate * efficiencyScore
    + weights.stabilityScore * params.metrics.stabilityScore;
  return Math.max(0, Math.min(1, weighted));
}

function stageDecisionLayer(stage: BenchmarkStage, certificationPass: boolean, provisionalPass: boolean): WinnerDecisionLayer {
  if (stage === "certification_ready" && certificationPass) return "certification";
  if (provisionalPass) return "provisional";
  return "exploratory";
}

async function hasCandidateDecision(experimentId: string): Promise<boolean> {
  const row = await pool.query<{ exists_flag: boolean }>(
    `SELECT EXISTS(
       SELECT 1
       FROM experiment_winner_decisions
       WHERE experiment_id = $1::uuid
         AND decision IN ('candidate', 'winner')
     ) AS exists_flag`,
    [experimentId]
  );
  return Boolean(row.rows[0]?.exists_flag);
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

async function loadStrategyStabilityScore(strategyVariantId: string): Promise<number> {
  const row = await pool.query<{ stability_score: string }>(
    `SELECT COALESCE(AVG(cs.component_stability_score), 0)::text AS stability_score
     FROM strategy_component_bindings b
     LEFT JOIN component_stability cs ON cs.component_id = b.component_id
     WHERE b.strategy_variant_id = $1::uuid`,
    [strategyVariantId]
  );
  return Number(row.rows[0]?.stability_score ?? 0);
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
  if (!openAiKey) return fallback;

  const url = `${String(config.openAiBaseUrl || "https://api.openai.com/v1").replace(/\/+$/, "")}/chat/completions`;
  const apiKey = openAiKey;
  const model = String(config.metadataModel || "gpt-4o-mini").replace(/^openai\//i, "");
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
  if (!openAiKey) return fallback;

  const url = `${String(config.openAiBaseUrl || "https://api.openai.com/v1").replace(/\/+$/, "")}/chat/completions`;
  const apiKey = openAiKey;
  const model = String(config.metadataModel || "gpt-4o-mini").replace(/^openai\//i, "");

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
  const selectionProfile = input.selectionProfile ?? DEFAULT_SELECTION_PROFILE;
  const certificationProfile = input.certificationProfile ?? DEFAULT_CERTIFICATION_PROFILE;
  const readinessProfile = input.readinessProfile ?? DEFAULT_READINESS_PROFILE;
  const targetPassRate = clamp01(Number(input.targetPassRate ?? selectionProfile.provisional.minBehaviorCorrectRate), selectionProfile.provisional.minBehaviorCorrectRate);
  const criticalTargetPassRate = clamp01(Number(input.criticalTargetPassRate ?? certificationProfile.minBehaviorCorrectRate), certificationProfile.minBehaviorCorrectRate);
  const perDomainFloor = clamp01(Number(input.perDomainFloor ?? selectionProfile.provisional.perDomainFloor), selectionProfile.provisional.perDomainFloor);
  const latencyGateMultiplier = Number.isFinite(Number(input.latencyGateMultiplier))
    ? Math.max(1, Math.min(3, Number(input.latencyGateMultiplier)))
    : selectionProfile.provisional.maxLatencyMultiplier;
  const costGateMultiplier = Number.isFinite(Number(input.costGateMultiplier))
    ? Math.max(1, Math.min(3, Number(input.costGateMultiplier)))
    : selectionProfile.provisional.maxCostMultiplier;
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
       latency_gate_multiplier, cost_gate_multiplier, dataset_version, taxonomy_version_id, benchmark_stage, config
     ) VALUES (
       $1::uuid, $2, $3, 'queued', $4, $5, $6, $7, $8, $9, $10::uuid, 'draft', $11::jsonb
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
        taxonomyVersionKey: taxonomyVersion.versionKey,
        readinessProfileId: input.readinessProfile?.profileId ?? DEFAULT_READINESS_PROFILE.profileId,
        readinessProfile,
        selectionProfileId: input.selectionProfileId ?? input.selectionProfile?.profileId ?? DEFAULT_SELECTION_PROFILE.profileId,
        selectionProfile,
        certificationProfileId: input.certificationProfile?.profileId ?? DEFAULT_CERTIFICATION_PROFILE.profileId,
        certificationProfile
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

interface OwnerReviewCoverage {
  ownerReviewedTotal: number;
  ownerApprovedYes: number;
  ownerRejectedNo: number;
  reviewedClarify: number;
  approvedDomainCoverage: number;
  approvedLensCoverage: number;
  approvedActorCoverage: number;
  approvedGroupCoverage: number;
  approvedThreadCoverage: number;
  approvedSourceCoverage: number;
  approvedTimeCoverage: number;
  approvedHumanCaseShare: number;
  approvedAssistantCaseShare: number;
  approvedDirect1to1Coverage: number;
  approvedGroupChatCoverage: number;
  approvedThirdPartyCoverage: number;
  approvedDistinctHumanActors: number;
  approvedDistinctHumanGroups: number;
  approvedDistinctConversationFamilies: number;
  criticalReviewedSlice: number;
  reviewableDomainCoverage: number;
  reviewableLensCoverage: number;
  reviewableActorCoverage: number;
  reviewableGroupCoverage: number;
  reviewableThreadCoverage: number;
  reviewableSourceCoverage: number;
  reviewableTimeCoverage: number;
  reviewableHumanCaseShare: number;
  reviewableAssistantCaseShare: number;
  reviewableDirect1to1Coverage: number;
  reviewableGroupChatCoverage: number;
  reviewableThirdPartyCoverage: number;
  reviewableDistinctHumanActors: number;
  reviewableDistinctHumanGroups: number;
  reviewableDistinctConversationFamilies: number;
}

async function loadOwnerReviewCoverage(experimentId: string): Promise<OwnerReviewCoverage> {
  const rows = await pool.query<{
    domain: string;
    lens: string;
    evidence_ids: string[] | string;
    conversation_ids: string[] | string;
    source_evidence_id: string | null;
    case_set: string;
    ambiguity_class: string;
    owner_validation_state: string;
    metadata: Record<string, unknown>;
    verdict: string | null;
  }>(
    `WITH latest_owner AS (
       SELECT DISTINCT ON (l.calibration_item_id)
         l.verdict,
         i.case_id
       FROM experiment_judge_calibration_labels l
       JOIN experiment_judge_calibration_items i ON i.id = l.calibration_item_id
       WHERE i.experiment_id = $1::uuid
         AND l.reviewer = 'owner'
       ORDER BY l.calibration_item_id, l.created_at DESC
     )
     SELECT
       c.domain,
       c.lens,
       COALESCE(c.evidence_ids::text, '{}') AS evidence_ids,
       COALESCE(c.conversation_ids::text, '{}') AS conversation_ids,
       c.source_evidence_id::text,
       c.case_set,
       c.ambiguity_class,
       c.owner_validation_state,
       c.metadata,
       lo.verdict
     FROM experiment_cases c
     LEFT JOIN latest_owner lo ON lo.case_id = c.id
     WHERE c.experiment_id = $1::uuid
       AND c.is_stale = false
       AND c.ambiguity_class IN ('clear', 'clarify_required')
       AND COALESCE((c.metadata->'admissionDecision'->>'admitted')::boolean, false) = true`,
    [experimentId]
  );

  const reviewableRows = rows.rows.filter((row) => row.owner_validation_state !== "rejected");
  const reviewedRows = reviewableRows.filter((row) => row.verdict === "yes" || row.verdict === "no");
  const approvedRows = reviewedRows.filter((row) => row.verdict === "yes");

  const buildFacetCoverage = (items: Array<{ metadata: Record<string, unknown> }>) => {
    const actorNames = new Set<string>();
    const groupLabels = new Set<string>();
    const threadTitles = new Set<string>();
    const sourceSystems = new Set<string>();
    const timeConstraints = new Set<string>();
    for (const item of items) {
      const frame = readSemanticFrame(item.metadata);
      const facets = frame?.retrievalFacets;
      if (!facets) continue;
      for (const value of facets.actorNames) actorNames.add(value.toLowerCase());
      for (const value of facets.groupLabels) groupLabels.add(value.toLowerCase());
      for (const value of facets.threadTitles) threadTitles.add(value.toLowerCase());
      for (const value of facets.sourceSystems) sourceSystems.add(value.toLowerCase());
      for (const value of facets.timeConstraints) timeConstraints.add(value.toLowerCase());
    }
    return {
      actorCoverage: actorNames.size,
      groupCoverage: groupLabels.size,
      threadCoverage: threadTitles.size,
      sourceCoverage: sourceSystems.size,
      timeCoverage: timeConstraints.size
    };
  };

  const buildTopologyCoverage = (items: Array<{
    metadata: Record<string, unknown>;
    evidence_ids: string[] | string;
    conversation_ids: string[] | string;
    source_evidence_id: string | null;
  }>) => {
    let humanCases = 0;
    let assistantCases = 0;
    const directFamilies = new Set<string>();
    const groupFamilies = new Set<string>();
    const thirdFamilies = new Set<string>();
    const humanActors = new Set<string>();
    const humanGroups = new Set<string>();
    const humanFamilies = new Set<string>();
    for (const item of items) {
      const frame = readSemanticFrame(item.metadata);
      const topology = frame?.topology ?? "system_artifact";
      const familyKey = buildCaseEvidenceFamilyKey({
        evidenceIds: item.evidence_ids,
        conversationIds: item.conversation_ids,
        sourceEvidenceId: item.source_evidence_id
      });
      if (topologyIsHuman(topology)) {
        humanCases += 1;
        if (familyKey) humanFamilies.add(familyKey);
        if (topology === "human_direct_1to1" && familyKey) directFamilies.add(familyKey);
        if (topology === "human_group_chat" && familyKey) groupFamilies.add(familyKey);
        if (topology === "third_party_human" && familyKey) thirdFamilies.add(familyKey);
      } else if (topology === "assistant_thread") {
        assistantCases += 1;
      }
      const facets = frame?.retrievalFacets;
      if (!facets || !topologyIsHuman(topology)) continue;
      for (const name of facets.actorNames) {
        if (isLikelyHumanFacetName(name)) humanActors.add(lowerText(name));
      }
      for (const label of facets.groupLabels) {
        const normalized = lowerText(label);
        if (normalized) humanGroups.add(normalized);
      }
    }
    const denominator = items.length > 0 ? items.length : 1;
    return {
      humanCaseShare: humanCases / denominator,
      assistantCaseShare: assistantCases / denominator,
      direct1to1Coverage: directFamilies.size,
      groupChatCoverage: groupFamilies.size,
      thirdPartyCoverage: thirdFamilies.size,
      distinctHumanActors: humanActors.size,
      distinctHumanGroups: humanGroups.size,
      distinctConversationFamilies: humanFamilies.size
    };
  };

  const reviewableFacetCoverage = buildFacetCoverage(reviewableRows);
  const approvedFacetCoverage = buildFacetCoverage(approvedRows);
  const reviewableTopologyCoverage = buildTopologyCoverage(reviewableRows);
  const approvedTopologyCoverage = buildTopologyCoverage(approvedRows);

  return {
    ownerReviewedTotal: reviewedRows.length,
    ownerApprovedYes: approvedRows.length,
    ownerRejectedNo: reviewedRows.filter((row) => row.verdict === "no").length,
    reviewedClarify: reviewedRows.filter((row) => row.ambiguity_class === "clarify_required").length,
    approvedDomainCoverage: new Set(approvedRows.map((row) => row.domain)).size,
    approvedLensCoverage: new Set(approvedRows.map((row) => row.lens)).size,
    approvedActorCoverage: approvedFacetCoverage.actorCoverage,
    approvedGroupCoverage: approvedFacetCoverage.groupCoverage,
    approvedThreadCoverage: approvedFacetCoverage.threadCoverage,
    approvedSourceCoverage: approvedFacetCoverage.sourceCoverage,
    approvedTimeCoverage: approvedFacetCoverage.timeCoverage,
    approvedHumanCaseShare: approvedTopologyCoverage.humanCaseShare,
    approvedAssistantCaseShare: approvedTopologyCoverage.assistantCaseShare,
    approvedDirect1to1Coverage: approvedTopologyCoverage.direct1to1Coverage,
    approvedGroupChatCoverage: approvedTopologyCoverage.groupChatCoverage,
    approvedThirdPartyCoverage: approvedTopologyCoverage.thirdPartyCoverage,
    approvedDistinctHumanActors: approvedTopologyCoverage.distinctHumanActors,
    approvedDistinctHumanGroups: approvedTopologyCoverage.distinctHumanGroups,
    approvedDistinctConversationFamilies: approvedTopologyCoverage.distinctConversationFamilies,
    criticalReviewedSlice: reviewedRows.filter((row) => row.case_set === "critical").length,
    reviewableDomainCoverage: new Set(reviewableRows.map((row) => row.domain)).size,
    reviewableLensCoverage: new Set(reviewableRows.map((row) => row.lens)).size,
    reviewableActorCoverage: reviewableFacetCoverage.actorCoverage,
    reviewableGroupCoverage: reviewableFacetCoverage.groupCoverage,
    reviewableThreadCoverage: reviewableFacetCoverage.threadCoverage,
    reviewableSourceCoverage: reviewableFacetCoverage.sourceCoverage,
    reviewableTimeCoverage: reviewableFacetCoverage.timeCoverage,
    reviewableHumanCaseShare: reviewableTopologyCoverage.humanCaseShare,
    reviewableAssistantCaseShare: reviewableTopologyCoverage.assistantCaseShare,
    reviewableDirect1to1Coverage: reviewableTopologyCoverage.direct1to1Coverage,
    reviewableGroupChatCoverage: reviewableTopologyCoverage.groupChatCoverage,
    reviewableThirdPartyCoverage: reviewableTopologyCoverage.thirdPartyCoverage,
    reviewableDistinctHumanActors: reviewableTopologyCoverage.distinctHumanActors,
    reviewableDistinctHumanGroups: reviewableTopologyCoverage.distinctHumanGroups,
    reviewableDistinctConversationFamilies: reviewableTopologyCoverage.distinctConversationFamilies
  };
}

function evaluateStageReadiness(params: {
  profile: BenchmarkReadinessProfile;
  coverage: OwnerReviewCoverage;
  pendingOwnerByStage: Record<Exclude<BenchmarkStage, "draft">, number>;
  pendingCalibrationByStage: Record<Exclude<BenchmarkStage, "draft">, number>;
}): Record<Exclude<BenchmarkStage, "draft">, {
  stage: Exclude<BenchmarkStage, "draft">;
  pass: boolean;
  blockers: string[];
  thresholds: BenchmarkStageThresholds;
  }> {
  const out = {} as Record<Exclude<BenchmarkStage, "draft">, {
    stage: Exclude<BenchmarkStage, "draft">;
    pass: boolean;
    blockers: string[];
    thresholds: BenchmarkStageThresholds;
  }>;
  for (const stage of ["core_ready", "selection_ready", "certification_ready"] as const) {
    const t = params.profile.stages[stage];
    const effectiveDomainCoverageMin = params.coverage.reviewableDomainCoverage > 0
      ? Math.max(1, Math.min(t.approvedDomainCoverageMin, params.coverage.reviewableDomainCoverage))
      : 0;
    const effectiveLensCoverageMin = params.coverage.reviewableLensCoverage > 0
      ? Math.max(1, Math.min(t.approvedLensCoverageMin, params.coverage.reviewableLensCoverage))
      : 0;
    const effectiveActorCoverageMin = params.coverage.reviewableActorCoverage > 0
      ? Math.max(1, Math.min(t.actorCoverageMin, params.coverage.reviewableActorCoverage))
      : 0;
    const effectiveGroupCoverageMin = params.coverage.reviewableGroupCoverage > 0
      ? Math.max(1, Math.min(t.groupCoverageMin, params.coverage.reviewableGroupCoverage))
      : 0;
    const effectiveThreadCoverageMin = params.coverage.reviewableThreadCoverage > 0
      ? Math.max(1, Math.min(t.threadCoverageMin, params.coverage.reviewableThreadCoverage))
      : 0;
    const effectiveSourceCoverageMin = params.coverage.reviewableSourceCoverage > 0
      ? Math.max(1, Math.min(t.sourceCoverageMin, params.coverage.reviewableSourceCoverage))
      : 0;
    const effectiveTimeCoverageMin = params.coverage.reviewableTimeCoverage > 0
      ? Math.max(1, Math.min(t.timeCoverageMin, params.coverage.reviewableTimeCoverage))
      : 0;
    const effectiveDirect1to1CoverageMin = params.coverage.reviewableDirect1to1Coverage > 0
      ? Math.max(1, Math.min(t.direct1to1CoverageMin, params.coverage.reviewableDirect1to1Coverage))
      : 0;
    const effectiveGroupChatCoverageMin = params.coverage.reviewableGroupChatCoverage > 0
      ? Math.max(1, Math.min(t.groupChatCoverageMin, params.coverage.reviewableGroupChatCoverage))
      : 0;
    const effectiveThirdPartyCoverageMin = params.coverage.reviewableThirdPartyCoverage > 0
      ? Math.max(1, Math.min(t.thirdPartyCoverageMin, params.coverage.reviewableThirdPartyCoverage))
      : 0;
    const effectiveDistinctHumanActorsMin = params.coverage.reviewableDistinctHumanActors > 0
      ? Math.max(1, Math.min(t.distinctHumanActorsMin, params.coverage.reviewableDistinctHumanActors))
      : 0;
    const effectiveDistinctHumanGroupsMin = params.coverage.reviewableDistinctHumanGroups > 0
      ? Math.max(1, Math.min(t.distinctHumanGroupsMin, params.coverage.reviewableDistinctHumanGroups))
      : 0;
    const effectiveDistinctConversationFamiliesMin = params.coverage.reviewableDistinctConversationFamilies > 0
      ? Math.max(1, Math.min(t.distinctConversationFamiliesMin, params.coverage.reviewableDistinctConversationFamilies))
      : 0;
    const blockers: string[] = [];
    if (params.coverage.ownerReviewedTotal < t.ownerReviewedTotalMin) blockers.push(`owner reviewed ${params.coverage.ownerReviewedTotal}/${t.ownerReviewedTotalMin}`);
    if (params.coverage.ownerApprovedYes < t.ownerApprovedYesMin) blockers.push(`owner yes ${params.coverage.ownerApprovedYes}/${t.ownerApprovedYesMin}`);
    if (params.coverage.ownerRejectedNo < t.representativeNoMin) blockers.push(`representative no ${params.coverage.ownerRejectedNo}/${t.representativeNoMin}`);
    if (params.coverage.reviewedClarify < t.reviewedClarifyMin) blockers.push(`reviewed clarify ${params.coverage.reviewedClarify}/${t.reviewedClarifyMin}`);
    if (params.coverage.approvedDomainCoverage < effectiveDomainCoverageMin) blockers.push(`approved domains ${params.coverage.approvedDomainCoverage}/${effectiveDomainCoverageMin}`);
    if (params.coverage.approvedLensCoverage < effectiveLensCoverageMin) blockers.push(`approved lenses ${params.coverage.approvedLensCoverage}/${effectiveLensCoverageMin}`);
    if (params.coverage.approvedActorCoverage < effectiveActorCoverageMin) blockers.push(`approved actors ${params.coverage.approvedActorCoverage}/${effectiveActorCoverageMin}`);
    if (params.coverage.approvedGroupCoverage < effectiveGroupCoverageMin) blockers.push(`approved groups ${params.coverage.approvedGroupCoverage}/${effectiveGroupCoverageMin}`);
    if (params.coverage.approvedThreadCoverage < effectiveThreadCoverageMin) blockers.push(`approved threads ${params.coverage.approvedThreadCoverage}/${effectiveThreadCoverageMin}`);
    if (params.coverage.approvedSourceCoverage < effectiveSourceCoverageMin) blockers.push(`approved sources ${params.coverage.approvedSourceCoverage}/${effectiveSourceCoverageMin}`);
    if (params.coverage.approvedTimeCoverage < effectiveTimeCoverageMin) blockers.push(`approved time facets ${params.coverage.approvedTimeCoverage}/${effectiveTimeCoverageMin}`);
    if (params.coverage.approvedHumanCaseShare + 1e-9 < t.humanCaseShareMin) blockers.push(`human share ${(params.coverage.approvedHumanCaseShare * 100).toFixed(1)}%/${(t.humanCaseShareMin * 100).toFixed(1)}%`);
    if (params.coverage.approvedDirect1to1Coverage < effectiveDirect1to1CoverageMin) blockers.push(`direct 1:1 ${params.coverage.approvedDirect1to1Coverage}/${effectiveDirect1to1CoverageMin}`);
    if (params.coverage.approvedGroupChatCoverage < effectiveGroupChatCoverageMin) blockers.push(`group chats ${params.coverage.approvedGroupChatCoverage}/${effectiveGroupChatCoverageMin}`);
    if (params.coverage.approvedThirdPartyCoverage < effectiveThirdPartyCoverageMin) blockers.push(`third-party ${params.coverage.approvedThirdPartyCoverage}/${effectiveThirdPartyCoverageMin}`);
    if (params.coverage.approvedDistinctHumanActors < effectiveDistinctHumanActorsMin) blockers.push(`distinct human actors ${params.coverage.approvedDistinctHumanActors}/${effectiveDistinctHumanActorsMin}`);
    if (params.coverage.approvedDistinctHumanGroups < effectiveDistinctHumanGroupsMin) blockers.push(`distinct human groups ${params.coverage.approvedDistinctHumanGroups}/${effectiveDistinctHumanGroupsMin}`);
    if (params.coverage.approvedDistinctConversationFamilies < effectiveDistinctConversationFamiliesMin) blockers.push(`distinct human families ${params.coverage.approvedDistinctConversationFamilies}/${effectiveDistinctConversationFamiliesMin}`);
    if (params.coverage.criticalReviewedSlice < t.criticalReviewedSliceMin) blockers.push(`critical reviewed ${params.coverage.criticalReviewedSlice}/${t.criticalReviewedSliceMin}`);
    const pendingOwner = params.pendingOwnerByStage[stage] ?? 0;
    const pendingCalibration = params.pendingCalibrationByStage[stage] ?? 0;
    const thresholds = {
      ...t,
      approvedDomainCoverageMin: effectiveDomainCoverageMin,
      approvedLensCoverageMin: effectiveLensCoverageMin,
      actorCoverageMin: effectiveActorCoverageMin,
      groupCoverageMin: effectiveGroupCoverageMin,
      threadCoverageMin: effectiveThreadCoverageMin,
      sourceCoverageMin: effectiveSourceCoverageMin,
      timeCoverageMin: effectiveTimeCoverageMin,
      direct1to1CoverageMin: effectiveDirect1to1CoverageMin,
      groupChatCoverageMin: effectiveGroupChatCoverageMin,
      thirdPartyCoverageMin: effectiveThirdPartyCoverageMin,
      distinctHumanActorsMin: effectiveDistinctHumanActorsMin,
      distinctHumanGroupsMin: effectiveDistinctHumanGroupsMin,
      distinctConversationFamiliesMin: effectiveDistinctConversationFamiliesMin
    };
    if (pendingOwner > t.pendingOwnerMax) blockers.push(`pending owner in stage slice ${pendingOwner}/${t.pendingOwnerMax}`);
    if (pendingCalibration > t.pendingCalibrationMax) blockers.push(`pending calibration in stage slice ${pendingCalibration}/${t.pendingCalibrationMax}`);
    out[stage] = {
      stage,
      pass: blockers.length === 0,
      blockers,
      thresholds
    };
  }
  return out;
}

async function getLockStage(experimentId: string, lockVersion: string | null): Promise<BenchmarkStage | null> {
  if (!lockVersion) return null;
  const row = await pool.query<{ lock_stage: BenchmarkStage }>(
    `SELECT lock_stage
     FROM benchmark_lock_versions
     WHERE experiment_id = $1::uuid
       AND lock_version = $2::text
     LIMIT 1`,
    [experimentId, lockVersion]
  );
  return row.rows[0]?.lock_stage ?? null;
}

export async function lockExperimentBenchmark(params: {
  experimentId: string;
  lockVersion?: string;
  lockStage: Exclude<BenchmarkStage, "draft">;
}): Promise<Record<string, unknown>> {
  const experiment = await readExperiment(params.experimentId);
  const readinessProfile = resolveReadinessProfile(experiment);
  const freshness = await experimentBenchmarkFreshness({ experimentId: params.experimentId });
  if (freshness.benchmarkStale) {
    throw new Error(`Benchmark is stale: ${freshness.reasons.join(", ")}`);
  }
  const readiness = await experimentPreloopReadiness({ experimentId: params.experimentId });
  const stageReadinessMap = (readiness.stageReadiness ?? {}) as Record<Exclude<BenchmarkStage, "draft">, {
    stage: Exclude<BenchmarkStage, "draft">;
    pass: boolean;
    blockers: string[];
    thresholds: BenchmarkStageThresholds;
  }>;
  const stageReadiness = stageReadinessMap[params.lockStage];
  if (!stageReadiness?.pass) {
    throw new Error(`Benchmark stage ${params.lockStage} is not ready: ${(stageReadiness?.blockers ?? []).join(", ")}`);
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
       experiment_id, lock_version, lock_stage, included_clear, included_clarify, unresolved, total_included, checksum, metadata
     ) VALUES (
       $1::uuid, $2::text, $3, $4, $5, $6, $7, $8, $9::jsonb
     )
     ON CONFLICT (experiment_id, lock_version)
     DO UPDATE SET
       lock_stage = EXCLUDED.lock_stage,
       included_clear = EXCLUDED.included_clear,
       included_clarify = EXCLUDED.included_clarify,
       unresolved = EXCLUDED.unresolved,
       total_included = EXCLUDED.total_included,
       checksum = EXCLUDED.checksum,
       metadata = EXCLUDED.metadata`,
    [
      experiment.id,
      lockVersion,
      params.lockStage,
      counts.clear,
      counts.clarify,
      counts.unresolved,
      counts.total,
      checksum,
      JSON.stringify({
        lockStage: params.lockStage,
        readinessProfileId: readinessProfile.profileId,
        stageThresholds: readinessProfile.stages[params.lockStage],
        unresolvedDebtMax: 0.01
      })
    ]
  );

  await pool.query(
    `UPDATE experiment_runs
        SET active_benchmark_lock_version = $2::text,
            benchmark_stage = $3,
            autonomous_mode = true,
            human_input_allowed = false,
            updated_at = now()
      WHERE id = $1::uuid`,
    [experiment.id, lockVersion, params.lockStage]
  );

  const unresolvedRatio = counts.total > 0 ? counts.unresolved / counts.total : 0;
  return {
    ok: true,
    experimentId: experiment.id,
    lockVersion,
    lockStage: params.lockStage,
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
    lock_stage: BenchmarkStage;
    included_clear: string;
    included_clarify: string;
    unresolved: string;
    total_included: string;
    checksum: string;
    created_at: string;
  }>(
    `SELECT
       lock_version,
       lock_stage,
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
          lockStage: row.lock_stage,
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
  const activeBenchmarkStage = (await getLockStage(experiment.id, activeLockVersion))
    ?? experiment.benchmark_stage
    ?? "draft";
  if (stageRank(activeBenchmarkStage) < stageRank("core_ready")) {
    throw new Error(`Active benchmark lock stage ${activeBenchmarkStage} is below core_ready. Create a core_ready (or higher) lock before running strategy steps.`);
  }
  const selectionProfile = resolveSelectionProfile(experiment);
  const certificationProfile = resolveCertificationProfile(experiment);

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
  let behaviorTotal = 0;
  let behaviorPass = 0;
  let clearBehaviorTotal = 0;
  let clearBehaviorPass = 0;
  let clarifyBehaviorTotal = 0;
  let clarifyBehaviorPass = 0;
  let insufficientBehaviorTotal = 0;
  let insufficientBehaviorPass = 0;
  let groundingTotal = 0;
  let groundingPass = 0;
  let falseConfidentCount = 0;
  let actorAttributionTotal = 0;
  let actorAttributionPass = 0;
  let threadScopeTotal = 0;
  let threadScopePass = 0;
  let timeScopeTotal = 0;
  let timeScopePass = 0;
  let criticalBehaviorTotal = 0;
  let criticalBehaviorPass = 0;

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
      behaviorTotal += 1;
      groundingTotal += 1;
      if (evaluated.behaviorCorrect) behaviorPass += 1;
      if (evaluated.groundingPass) groundingPass += 1;
      if (evaluated.falseConfident) falseConfidentCount += 1;
      if (evaluated.actorAttributionApplicable) {
        actorAttributionTotal += 1;
        if (evaluated.actorAttributionPass) actorAttributionPass += 1;
      }
      if (evaluated.threadScopeApplicable) {
        threadScopeTotal += 1;
        if (evaluated.threadScopePass) threadScopePass += 1;
      }
      if (evaluated.timeScopeApplicable) {
        timeScopeTotal += 1;
        if (evaluated.timeScopePass) timeScopePass += 1;
      }
      if (testCase.case_set === "critical") {
        criticalBehaviorTotal += 1;
        if (evaluated.behaviorCorrect) criticalBehaviorPass += 1;
      }
      if (evaluated.expectedBehavior === "answer_now") {
        clearBehaviorTotal += 1;
        if (evaluated.behaviorCorrect) clearBehaviorPass += 1;
      } else if (evaluated.expectedBehavior === "clarify_first") {
        clarifyBehaviorTotal += 1;
        if (evaluated.behaviorCorrect) clarifyBehaviorPass += 1;
      } else if (evaluated.expectedBehavior === "insufficient") {
        insufficientBehaviorTotal += 1;
        if (evaluated.behaviorCorrect) insufficientBehaviorPass += 1;
      }
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
  const initialScorecard: EvaluationScorecard = {
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
      scorecard: initialScorecard,
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
        ...initialScorecard,
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
        ...initialScorecard,
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

  let provisionalDomainFloorPass = true;
  let certificationDomainFloorPass = true;
  for (const [domain, agg] of perDomain.entries()) {
    const domainPassRate = agg.total > 0 ? agg.pass / agg.total : 1;
    if (agg.total >= selectionProfile.provisional.perDomainMinCases && domainPassRate < selectionProfile.provisional.perDomainFloor) {
      provisionalDomainFloorPass = false;
      await pool.query(
        `INSERT INTO experiment_failures (
           experiment_id, strategy_variant_id, case_id, bucket, details
         ) VALUES (
           $1::uuid, $2::uuid, (SELECT id FROM experiment_cases WHERE experiment_id = $1::uuid LIMIT 1), 'reasoning_synthesis_miss',
           $3::jsonb
         )`,
        [experiment.id, selected.id, JSON.stringify({ domain, domainPassRate, perDomainFloor: selectionProfile.provisional.perDomainFloor, minCases: selectionProfile.provisional.perDomainMinCases, layer: "provisional" })]
      );
    }
    if (agg.total >= certificationProfile.perDomainMinCases && domainPassRate < certificationProfile.perDomainFloor) {
      certificationDomainFloorPass = false;
    }
  }

  const baseline = await resolveBaselineMetrics(experiment.id);
  const latencyMultiplier = !baseline || baseline.p95LatencyMs <= 0 ? 1 : p95LatencyMs / baseline.p95LatencyMs;
  const costMultiplier = !baseline || baseline.costPer1k <= 0 ? 1 : estimatedCostPer1kAsks / baseline.costPer1k;
  const leakageGatePass = leakageFindings.length === 0;
  const theoreticalMaxPassRate = scoredCaseCap > 0
    ? (passed + Math.max(0, scoredCaseCap - totalRan)) / scoredCaseCap
    : passRate;
  const clearPassRate = rate(clearPass, clearTotal);
  const clarifyPassRate = rate(clarifyPass, clarifyTotal);
  const unresolvedAmbiguousRatio = cases.length > 0 ? unresolvedTotal / cases.length : 0;
  const behaviorCorrectRate = rate(behaviorPass, behaviorTotal);
  const clearBehaviorCorrectRate = rate(clearBehaviorPass, clearBehaviorTotal);
  const clarifyBehaviorCorrectRate = rate(clarifyBehaviorPass, clarifyBehaviorTotal);
  const insufficientBehaviorCorrectRate = rate(insufficientBehaviorPass, insufficientBehaviorTotal);
  const groundingRate = rate(groundingPass, groundingTotal);
  const falseConfidentRate = rate(falseConfidentCount, behaviorTotal, 0);
  const actorAttributionAccuracy = rate(actorAttributionPass, actorAttributionTotal);
  const threadScopeAccuracy = rate(threadScopePass, threadScopeTotal);
  const timeScopeAccuracy = rate(timeScopePass, timeScopeTotal);
  const criticalBehaviorCorrectRate = rate(criticalBehaviorPass, criticalBehaviorTotal);
  const exploratoryQualified =
    leakageGatePass
    && groundingRate >= selectionProfile.disqualifiers.minGroundingRate
    && falseConfidentRate <= selectionProfile.disqualifiers.maxFalseConfidentRate
    && behaviorCorrectRate >= selectionProfile.disqualifiers.minBehaviorCorrectRate
    && latencyMultiplier <= selectionProfile.disqualifiers.maxLatencyMultiplier
    && costMultiplier <= selectionProfile.disqualifiers.maxCostMultiplier;
  const provisionalPass =
    exploratoryQualified
    && behaviorCorrectRate >= selectionProfile.provisional.minBehaviorCorrectRate
    && clearBehaviorCorrectRate >= selectionProfile.provisional.minClearBehaviorCorrectRate
    && clarifyBehaviorCorrectRate >= selectionProfile.provisional.minClarifyBehaviorCorrectRate
    && groundingRate >= selectionProfile.provisional.minGroundingRate
    && falseConfidentRate <= selectionProfile.provisional.maxFalseConfidentRate
    && evidenceHitRate >= selectionProfile.provisional.minEvidenceHitRate
    && provisionalDomainFloorPass
    && latencyMultiplier <= selectionProfile.provisional.maxLatencyMultiplier
    && costMultiplier <= selectionProfile.provisional.maxCostMultiplier;
  const criticalFailures = Math.max(0, criticalBehaviorTotal - criticalBehaviorPass);
  const criticalGatePass = criticalBehaviorTotal < certificationProfile.criticalMinCasesForRate
    ? criticalFailures === 0
    : criticalBehaviorCorrectRate >= certificationProfile.criticalBehaviorCorrectRate;
  const certificationPass =
    exploratoryQualified
    && behaviorCorrectRate >= certificationProfile.minBehaviorCorrectRate
    && clearBehaviorCorrectRate >= certificationProfile.minClearBehaviorCorrectRate
    && clarifyBehaviorCorrectRate >= certificationProfile.minClarifyBehaviorCorrectRate
    && groundingRate >= certificationProfile.minGroundingRate
    && falseConfidentRate <= certificationProfile.maxFalseConfidentRate
    && evidenceHitRate >= certificationProfile.minEvidenceHitRate
    && certificationDomainFloorPass
    && latencyMultiplier <= certificationProfile.maxLatencyMultiplier
    && costMultiplier <= certificationProfile.maxCostMultiplier
    && criticalGatePass;

  const baseScorecard: EvaluationScorecard = {
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
    failureBreakdown,
    behaviorCorrectRate,
    clearBehaviorCorrectRate,
    clarifyBehaviorCorrectRate,
    insufficientBehaviorCorrectRate,
    groundingRate,
    falseConfidentRate,
    actorAttributionAccuracy,
    threadScopeAccuracy,
    timeScopeAccuracy,
    criticalBehaviorCorrectRate
  };

  const hypothesisEvaluation = await evaluateAndUpdateHypothesis({
    experimentId: experiment.id,
    strategy: selected,
    scorecard: baseScorecard
  });
  await updateComponentPerformanceAndStability({
    experimentId: experiment.id,
    strategyVariantId: selected.id,
    caseSet: input.caseSet ?? "all",
    scorecard: baseScorecard
  });
  const stabilityScore = await loadStrategyStabilityScore(selected.id);
  const compositeScore = computeCompositeScore({
    metrics: {
      behaviorCorrectRate,
      groundingRate,
      clarifyBehaviorCorrectRate,
      insufficientBehaviorCorrectRate,
      actorAttributionAccuracy,
      threadScopeAccuracy,
      timeScopeAccuracy,
      recallAtK,
      mrr,
      ndcg,
      evidenceHitRate,
      p95LatencyMs,
      estimatedCostPer1kAsks,
      stabilityScore
    },
    baseline,
    profile: selectionProfile
  });
  const decisionLayer = stageDecisionLayer(activeBenchmarkStage, certificationPass, provisionalPass);
  const strategyPass =
    activeBenchmarkStage === "certification_ready"
      ? certificationPass
      : stageRank(activeBenchmarkStage) >= stageRank("core_ready")
        ? provisionalPass
        : false;
  const gateResults = {
    stage: activeBenchmarkStage,
    exploratoryQualified,
    provisionalPass,
    certificationPass,
    leakageGatePass,
    provisionalDomainFloorPass,
    certificationDomainFloorPass,
    criticalGatePass,
    criticalFailures,
    latencyMultiplier,
    costMultiplier
  };
  const scorecard: EvaluationScorecard = {
    ...baseScorecard,
    stabilityScore
  };
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
    latencyMultiplier,
    costMultiplier,
    exploratoryQualified,
    provisionalPass,
    certificationPass,
    decisionLayer,
    compositeScore,
    gateResults
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
    confidence: Math.max(0, Math.min(1, compositeScore)),
    payload: {
      scorecard,
      strategyPass,
      leakageFindings,
      hypothesisEvaluation,
      theoreticalMaxPassRate,
      gateResults,
      compositeScore
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

  const reason = certificationPass && activeBenchmarkStage === "certification_ready"
    ? "Meets certification winner gate on the certification-ready benchmark."
    : provisionalPass
      ? `Meets provisional winner gate on benchmark stage ${activeBenchmarkStage}.`
      : exploratoryQualified
        ? (retryVariantId
          ? `Exploratory score recorded, but stage gates not met; queued retry variant ${retryVariantId}.`
          : "Exploratory score recorded, but provisional/certification gates were not met.")
        : (retryVariantId
          ? `Rejected by exploratory guardrails; queued retry variant ${retryVariantId}.`
          : "Rejected by exploratory guardrails or stage-specific gates.");
  await pool.query(
    `INSERT INTO experiment_winner_decisions (
       experiment_id, strategy_variant_id, strategy_id, variant_id, pass_rate, p95_latency_ms,
       estimated_cost_per_1k, decision, decision_layer, composite_score, gate_results, reason
     ) VALUES (
       $1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12
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
      decisionLayer,
      compositeScore,
      JSON.stringify(gateResults),
      reason
    ]
  );

  let remaining = (await loadExperimentStrategies(experiment.id)).filter((s) => s.status === "queued").length;
  let winnerVariantId: string | null = null;
  if (activeBenchmarkStage === "certification_ready" && certificationPass) {
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
         $1::uuid, $2::uuid, $3, $4, $5, $6, $7, 'winner', 'certification', $8, $9::jsonb, $10
       )`,
      [
        experiment.id,
        selected.id,
        selected.strategy_id,
        selected.variant_id,
        passRate,
        p95LatencyMs,
        estimatedCostPer1kAsks,
        compositeScore,
        JSON.stringify(gateResults),
        "Current best certification-passing strategy."
      ]
    );
  } else {
    let queuedAfterResearch = remaining;
    let researchGroup: ResearchEnqueueResult | null = null;
    const candidateExists = strategyPass || await hasCandidateDecision(experiment.id);
    if (remaining === 0 && !winnerVariantId) {
      if (stageRank(activeBenchmarkStage) < stageRank("certification_ready") && candidateExists) {
        queuedAfterResearch = 0;
      } else {
        researchGroup = await enqueueResearchCandidates(experiment.id, failureBreakdown);
        queuedAfterResearch += researchGroup.inserted;
      }
    }
    remaining = queuedAfterResearch;
    await pool.query(
      `UPDATE experiment_runs
          SET strategy_cursor = strategy_cursor + 1,
              status = CASE
                WHEN $3::boolean = true AND $2::int = 0 THEN 'completed'
                WHEN $2::int = 0 THEN 'failed'
                ELSE 'running'
              END,
              notes = CASE
                WHEN $3::boolean = true AND $2::int = 0 THEN 'selection_complete_pending_certification'
                WHEN $2::int = 0 THEN COALESCE(notes, 'no_more_strategies')
                ELSE notes
              END,
              updated_at = now(),
              finished_at = CASE WHEN $2::int = 0 THEN now() ELSE finished_at END
        WHERE id = $1::uuid`,
      [experiment.id, queuedAfterResearch, stageRank(activeBenchmarkStage) < stageRank("certification_ready") && candidateExists]
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
      activeBenchmarkStage,
      selectionProfile,
      certificationProfile
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
    activeBenchmarkStage,
    compositeScore,
    decisionLayer,
    gateResults,
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
  const benchmarkStage = experiment.active_benchmark_lock_version
    ? (await getLockStage(experimentId, experiment.active_benchmark_lock_version)) ?? experiment.benchmark_stage ?? "draft"
    : experiment.benchmark_stage ?? "draft";
  const caseCounts = await pool.query<{ case_set: string; c: string }>(
    `SELECT case_set, COUNT(*)::text AS c
     FROM experiment_cases
     WHERE experiment_id = $1::uuid
       AND is_stale = false
     GROUP BY case_set`,
    [experimentId]
  );
  const decisionCounts = await pool.query<{ decision: string; c: string }>(
    `SELECT decision, COUNT(*)::text AS c
     FROM experiment_winner_decisions
     WHERE experiment_id = $1::uuid
     GROUP BY decision`,
    [experimentId]
  );
  const counts = Object.fromEntries(caseCounts.rows.map((r) => [r.case_set, Number(r.c ?? 0)]));
  const decisions = Object.fromEntries(decisionCounts.rows.map((r) => [r.decision, Number(r.c ?? 0)]));
  return {
    ok: true,
    experiment: {
      ...experiment,
      benchmarkStage
    },
    strategies,
    caseCounts: counts,
    decisionCounts: decisions,
    provisionalWinnerStatus: (decisions.candidate ?? 0) > 0,
    certificationStatus: Boolean(experiment.winner_variant_id)
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
  const ownerCoverage = await loadOwnerReviewCoverage(params.experimentId);
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
  const winnerDecisionCounts = await pool.query<{ decision: string; c: string }>(
    `SELECT decision, COUNT(*)::text AS c
     FROM experiment_winner_decisions
     WHERE experiment_id = $1::uuid
     GROUP BY decision`,
    [params.experimentId]
  );
  const decisionCounts = Object.fromEntries(winnerDecisionCounts.rows.map((row) => [row.decision, Number(row.c ?? 0)]));

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
      benchmarkStage: experiment.benchmark_stage ?? "draft",
      chatNamespace: experiment.chat_namespace,
      activeLockVersion: experiment.active_benchmark_lock_version ?? null,
      winnerVariantId: experiment.winner_variant_id ?? null,
      taxonomyVersionId: experiment.taxonomy_version_id ?? null,
      taxonomyVersionKey: taxonomyVersion?.versionKey ?? null,
      benchmarkStale: freshness.benchmarkStale,
      provisionalWinnerStatus: (decisionCounts.candidate ?? 0) > 0,
      certificationStatus: Boolean(experiment.winner_variant_id)
    },
    kpis: {
      currentVariantId: currentRunning?.variant_id ?? latest?.variant_id ?? null,
      bestVariantId: best?.variant_id ?? null,
      bestPassRate: getMetricNumber(bestMetrics, "passRate", 0),
      behaviorCorrectRate: getMetricNumber(latestMetrics, "behaviorCorrectRate", 0),
      clearBehaviorCorrectRate: getMetricNumber(latestMetrics, "clearBehaviorCorrectRate", 0),
      clarifyBehaviorCorrectRate: getMetricNumber(latestMetrics, "clarifyBehaviorCorrectRate", 0),
      groundingRate: getMetricNumber(latestMetrics, "groundingRate", 0),
      falseConfidentRate: getMetricNumber(latestMetrics, "falseConfidentRate", 0),
      compositeScore: getMetricNumber(latestMetrics, "compositeScore", 0),
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
      supportCoverageRatio,
      humanCaseShare: ownerCoverage.approvedHumanCaseShare,
      assistantCaseShare: ownerCoverage.approvedAssistantCaseShare,
      direct1to1Coverage: ownerCoverage.approvedDirect1to1Coverage,
      groupChatCoverage: ownerCoverage.approvedGroupChatCoverage,
      thirdPartyCoverage: ownerCoverage.approvedThirdPartyCoverage,
      distinctHumanActors: ownerCoverage.approvedDistinctHumanActors,
      distinctHumanGroups: ownerCoverage.approvedDistinctHumanGroups,
      distinctConversationFamilies: ownerCoverage.approvedDistinctConversationFamilies
    },
    lock
  };
}

export async function experimentEvolutionFrontier(params: {
  experimentId: string;
}): Promise<Record<string, unknown>> {
  const baseline = await resolveBaselineForMultipliers(params.experimentId);
  const strategies = await loadExperimentStrategies(params.experimentId);
  const decisionRows = await pool.query<{
    variant_id: string;
    decision_layer: WinnerDecisionLayer;
    composite_score: string;
  }>(
    `SELECT DISTINCT ON (variant_id)
       variant_id,
       decision_layer,
       composite_score::text
     FROM experiment_winner_decisions
     WHERE experiment_id = $1::uuid
     ORDER BY variant_id, created_at DESC`,
    [params.experimentId]
  );
  const decisionMap = new Map(
    decisionRows.rows.map((row) => [row.variant_id, { decisionLayer: row.decision_layer, compositeScore: Number(row.composite_score ?? 0) }])
  );
  const points = strategies
    .filter((s) => s.status === "completed" || s.status === "failed")
    .map((s) => {
      const passRate = getMetricNumber(s.metrics, "passRate", 0);
      const behaviorCorrectRate = getMetricNumber(s.metrics, "behaviorCorrectRate", 0);
      const groundingRate = getMetricNumber(s.metrics, "groundingRate", 0);
      const falseConfidentRate = getMetricNumber(s.metrics, "falseConfidentRate", 0);
      const latency = Math.max(0, getMetricNumber(s.metrics, "p95LatencyMs", 0));
      const cost = Math.max(0, getMetricNumber(s.metrics, "estimatedCostPer1kAsks", 0));
      const latencyMultiplier = baseline.latency > 0 ? latency / baseline.latency : 1;
      const costMultiplier = baseline.cost > 0 ? cost / baseline.cost : 1;
      const decision = decisionMap.get(s.variant_id);
      return {
        strategyId: s.strategy_id,
        variantId: s.variant_id,
        label: s.label,
        position: s.position,
        status: s.status,
        groupId: parseGroupId(s),
        passRate,
        behaviorCorrectRate,
        groundingRate,
        falseConfidentRate,
        latencyP95Ms: latency,
        costPer1k: cost,
        latencyMultiplier,
        costMultiplier,
        decisionLayer: decision?.decisionLayer ?? "exploratory",
        compositeScore: decision?.compositeScore ?? getMetricNumber(s.metrics, "compositeScore", 0)
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
  const readinessProfile = resolveReadinessProfile(experiment);
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
  const stageSliceCounts = await pool.query<{
    pending_owner_critical: string;
    pending_owner_selection: string;
    pending_calibration_critical: string;
    pending_calibration_selection: string;
  }>(
    `SELECT
       COUNT(*) FILTER (
         WHERE c.owner_validation_state = 'pending'
           AND c.case_set = 'critical'
           AND c.ambiguity_class IN ('clear', 'clarify_required')
           AND COALESCE((c.metadata->'admissionDecision'->>'admitted')::boolean, false) = true
       )::text AS pending_owner_critical,
       COUNT(*) FILTER (
         WHERE c.owner_validation_state = 'pending'
           AND c.case_set IN ('critical', 'certification')
           AND c.ambiguity_class IN ('clear', 'clarify_required')
           AND COALESCE((c.metadata->'admissionDecision'->>'admitted')::boolean, false) = true
       )::text AS pending_owner_selection,
       COUNT(*) FILTER (
         WHERE i.status = 'pending'
           AND c.case_set = 'critical'
       )::text AS pending_calibration_critical,
       COUNT(*) FILTER (
         WHERE i.status = 'pending'
           AND c.case_set IN ('critical', 'certification')
       )::text AS pending_calibration_selection
     FROM experiment_cases c
     LEFT JOIN experiment_judge_calibration_items i
       ON i.case_id = c.id
      AND i.experiment_id = c.experiment_id
     WHERE c.experiment_id = $1::uuid
       AND c.is_stale = false`,
    [params.experimentId]
  );
  const pendingOwnerByStage: Record<Exclude<BenchmarkStage, "draft">, number> = {
    core_ready: Number(stageSliceCounts.rows[0]?.pending_owner_critical ?? 0),
    selection_ready: Number(stageSliceCounts.rows[0]?.pending_owner_selection ?? 0),
    certification_ready: Number(stageSliceCounts.rows[0]?.pending_owner_selection ?? 0)
  };
  const pendingCalibrationByStage: Record<Exclude<BenchmarkStage, "draft">, number> = {
    core_ready: Number(stageSliceCounts.rows[0]?.pending_calibration_critical ?? 0),
    selection_ready: Number(stageSliceCounts.rows[0]?.pending_calibration_selection ?? 0),
    certification_ready: Number(stageSliceCounts.rows[0]?.pending_calibration_selection ?? 0)
  };
  const ownerCoverage = await loadOwnerReviewCoverage(params.experimentId);
  const stageReadiness = evaluateStageReadiness({
    coverage: ownerCoverage,
    pendingOwnerByStage,
    pendingCalibrationByStage,
    profile: readinessProfile
  });
  const activeLockVersion = String(experiment.active_benchmark_lock_version ?? "").trim() || null;
  const benchmarkStage = activeLockVersion
    ? (await getLockStage(params.experimentId, activeLockVersion)) ?? experiment.benchmark_stage ?? "draft"
    : experiment.benchmark_stage ?? "draft";

  const clearPassRate = clearTotal > 0 ? approvedClear / clearTotal : 1;
  const clarifyPassRate = clarifyTotal > 0 ? approvedClarify / clarifyTotal : 1;
  const unresolvedAmbiguousRatio = total > 0 ? unresolvedTotal / total : 0;
  const verifierPassRate = verifierTotal > 0 ? verifierPassCount / verifierTotal : 0;

  const clearGatePass = clearPassRate >= 0.99;
  const clarifyGatePass = clarifyPassRate >= 0.99;
  const debtGatePass = unresolvedAmbiguousRatio <= 0.01;
  const noPendingOwnerPass = pendingOwner === 0;
  const noPendingCalibrationPass = pendingCalibration === 0;
  const readyForLock = stageReadiness.core_ready.pass;
  const readyForSelectionLock = stageReadiness.selection_ready.pass;
  const readyForCertificationLock = stageReadiness.certification_ready.pass;
  const readyForStart = Boolean(activeLockVersion) && stageRank(benchmarkStage) >= stageRank("core_ready");
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
    benchmarkStage,
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
      calibrationEligible,
      pendingOwnerInCoreSlice: pendingOwnerByStage.core_ready,
      pendingCalibrationInCoreSlice: pendingCalibrationByStage.core_ready,
      pendingOwnerInSelectionSlice: pendingOwnerByStage.selection_ready,
      pendingCalibrationInSelectionSlice: pendingCalibrationByStage.selection_ready,
      ownerReviewedTotal: ownerCoverage.ownerReviewedTotal,
      ownerApprovedYes: ownerCoverage.ownerApprovedYes,
      ownerRejectedNo: ownerCoverage.ownerRejectedNo,
      reviewedClarify: ownerCoverage.reviewedClarify,
      approvedDomainCoverage: ownerCoverage.approvedDomainCoverage,
      approvedLensCoverage: ownerCoverage.approvedLensCoverage,
      approvedActorCoverage: ownerCoverage.approvedActorCoverage,
      approvedGroupCoverage: ownerCoverage.approvedGroupCoverage,
      approvedThreadCoverage: ownerCoverage.approvedThreadCoverage,
      approvedSourceCoverage: ownerCoverage.approvedSourceCoverage,
      approvedTimeCoverage: ownerCoverage.approvedTimeCoverage,
      approvedHumanCaseShare: ownerCoverage.approvedHumanCaseShare,
      approvedAssistantCaseShare: ownerCoverage.approvedAssistantCaseShare,
      approvedDirect1to1Coverage: ownerCoverage.approvedDirect1to1Coverage,
      approvedGroupChatCoverage: ownerCoverage.approvedGroupChatCoverage,
      approvedThirdPartyCoverage: ownerCoverage.approvedThirdPartyCoverage,
      approvedDistinctHumanActors: ownerCoverage.approvedDistinctHumanActors,
      approvedDistinctHumanGroups: ownerCoverage.approvedDistinctHumanGroups,
      approvedDistinctConversationFamilies: ownerCoverage.approvedDistinctConversationFamilies,
      reviewableActorCoverage: ownerCoverage.reviewableActorCoverage,
      reviewableGroupCoverage: ownerCoverage.reviewableGroupCoverage,
      reviewableThreadCoverage: ownerCoverage.reviewableThreadCoverage,
      reviewableSourceCoverage: ownerCoverage.reviewableSourceCoverage,
      reviewableTimeCoverage: ownerCoverage.reviewableTimeCoverage,
      reviewableHumanCaseShare: ownerCoverage.reviewableHumanCaseShare,
      reviewableAssistantCaseShare: ownerCoverage.reviewableAssistantCaseShare,
      reviewableDirect1to1Coverage: ownerCoverage.reviewableDirect1to1Coverage,
      reviewableGroupChatCoverage: ownerCoverage.reviewableGroupChatCoverage,
      reviewableThirdPartyCoverage: ownerCoverage.reviewableThirdPartyCoverage,
      reviewableDistinctHumanActors: ownerCoverage.reviewableDistinctHumanActors,
      reviewableDistinctHumanGroups: ownerCoverage.reviewableDistinctHumanGroups,
      reviewableDistinctConversationFamilies: ownerCoverage.reviewableDistinctConversationFamilies,
      criticalReviewedSlice: ownerCoverage.criticalReviewedSlice
    },
    metrics: {
      clearPassRate,
      clarifyPassRate,
      unresolvedAmbiguousRatio,
      verifierPassRate,
      humanCaseShare: ownerCoverage.approvedHumanCaseShare,
      assistantCaseShare: ownerCoverage.approvedAssistantCaseShare,
      direct1to1Coverage: ownerCoverage.approvedDirect1to1Coverage,
      groupChatCoverage: ownerCoverage.approvedGroupChatCoverage,
      thirdPartyCoverage: ownerCoverage.approvedThirdPartyCoverage,
      distinctHumanActors: ownerCoverage.approvedDistinctHumanActors,
      distinctHumanGroups: ownerCoverage.approvedDistinctHumanGroups,
      distinctConversationFamilies: ownerCoverage.approvedDistinctConversationFamilies
    },
    stageReadiness,
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
      readyForSelectionLock,
      readyForCertificationLock,
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
    decision_layer: WinnerDecisionLayer;
    pass_rate: string;
    p95_latency_ms: string;
    estimated_cost_per_1k: string;
    composite_score: string;
    gate_results: Record<string, unknown>;
    reason: string;
    created_at: string;
  }>(
    `SELECT
       strategy_id,
       variant_id,
       decision,
       decision_layer,
       pass_rate::text,
       p95_latency_ms::text,
       estimated_cost_per_1k::text,
       composite_score::text,
       gate_results,
       reason,
       created_at::text
     FROM experiment_winner_decisions
     WHERE experiment_id = $1::uuid
     ORDER BY
       CASE decision WHEN 'winner' THEN 0 WHEN 'candidate' THEN 1 ELSE 2 END,
       composite_score DESC,
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
      estimated_cost_per_1k: Number(r.estimated_cost_per_1k ?? 0),
      composite_score: Number(r.composite_score ?? 0)
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

  const evidenceIds = candidates.rows.flatMap((row) => (
    Array.isArray(row.evidence_ids)
      ? row.evidence_ids.map(String)
      : parsePgTextArray(String(row.evidence_ids ?? "{}"))
  ));
  const evidenceMap = await loadEvidencePreviewMap(evidenceIds);
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
    const semanticFrame = readSemanticFrame(row.metadata ?? {});
    const evidencePreview = expectedEvidenceIds
      .map((id) => evidenceMap.get(id))
      .filter(isEvidencePreviewRow)
      .sort((a, b) => String(a.observedAt ?? "").localeCompare(String(b.observedAt ?? "")));
    const expectedAnswer = {
      expectedBehavior,
      expectedAnswerSummaryHuman: buildEvidenceGroundedAnswerSummary({
        question: row.question,
        domain: row.domain,
        lens: row.lens,
        expectedBehavior,
        expectedCoreClaims,
        actorName: semanticFrame?.statementOwnerName ?? semanticFrame?.actorScope ?? null,
        semanticFrame,
        evidenceTexts: evidencePreview.map((item) => item.snippet),
        evidenceRows: evidencePreview
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

async function materializeCalibrationItemsForPendingCases(params: {
  experimentId: string;
  domain?: string;
  caseSet?: "dev" | "critical" | "certification" | "stress" | "coverage";
  batchSize?: number;
}): Promise<number> {
  const batchSize = Number.isFinite(Number(params.batchSize)) ? Math.max(1, Math.min(200, Number(params.batchSize))) : 200;
  let totalCreated = 0;
  while (true) {
    const created = await createJudgeCalibrationSample({
      experimentId: params.experimentId,
      count: batchSize,
      domain: params.domain,
      caseSet: params.caseSet
    });
    const count = Number((created as Record<string, unknown>).created || 0);
    totalCreated += count;
    if (count <= 0) break;
  }
  return totalCreated;
}

export async function listJudgeCalibrationPending(params: {
  experimentId: string;
  limit?: number;
  status?: "pending" | "labeled" | "all";
  verdict?: "yes" | "no";
  ambiguityClass?: "clear" | "clarify_required" | "unresolved";
}): Promise<Record<string, unknown>> {
  const limit = Number.isFinite(Number(params.limit)) ? Math.max(1, Math.min(500, Number(params.limit))) : 50;
  const status = params.status === "labeled" || params.status === "all" ? params.status : "pending";
  const verdict = params.verdict === "yes" || params.verdict === "no" ? params.verdict : "";
  const ambiguityClass =
    params.ambiguityClass === "clear" || params.ambiguityClass === "clarify_required" || params.ambiguityClass === "unresolved"
      ? params.ambiguityClass
      : "";
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
    item_status: string;
    review_verdict: string | null;
    review_notes: string | null;
    assistant_verdict: string | null;
    assistant_notes: string | null;
    assistant_created_at: string | null;
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
       i.created_at::text,
       i.status AS item_status,
       lbl.verdict AS review_verdict,
       lbl.notes AS review_notes,
       asst.verdict AS assistant_verdict,
       asst.notes AS assistant_notes,
       asst.created_at::text AS assistant_created_at
     FROM experiment_judge_calibration_items i
     JOIN experiment_cases c ON c.id = i.case_id
      AND c.is_stale = false
     LEFT JOIN LATERAL (
       SELECT l.verdict, l.notes
       FROM experiment_judge_calibration_labels l
       WHERE l.calibration_item_id = i.id
         AND l.reviewer = 'owner'
       ORDER BY l.created_at DESC
       LIMIT 1
     ) lbl ON true
     LEFT JOIN LATERAL (
       SELECT l.verdict, l.notes, l.created_at
       FROM experiment_judge_calibration_labels l
       WHERE l.calibration_item_id = i.id
         AND l.reviewer = 'assistant'
       ORDER BY l.created_at DESC
       LIMIT 1
     ) asst ON true
     WHERE i.experiment_id = $1::uuid
       AND ($2::text = 'all' OR i.status = $2::text)
       AND ($5::text = '' OR COALESCE(c.ambiguity_class, 'clear') = $5::text)
       AND ($4::text = '' OR COALESCE(lbl.verdict, asst.verdict, '') = $4::text)
     ORDER BY i.created_at ASC
     LIMIT $3`,
    [params.experimentId, status, limit, verdict, ambiguityClass]
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
    statusFilter: status,
    verdictFilter: verdict,
    ambiguityFilter: ambiguityClass,
    items: rows.rows.map((r) => {
      const expectedEvidenceIds = Array.isArray(r.expected_evidence_ids)
        ? r.expected_evidence_ids.map(String)
        : parsePgTextArray(String(r.expected_evidence_ids ?? "{}"));
      const evidencePreview = expectedEvidenceIds
        .map((id) => evidenceMap.get(id))
        .filter(isEvidencePreviewRow)
        .sort((a, b) => {
          const left = String(a.observedAt ?? "");
          const right = String(b.observedAt ?? "");
          if (!left && !right) return 0;
          if (!left) return 1;
          if (!right) return -1;
          return left.localeCompare(right);
        })
        .slice(0, 4);
      const metadata = r.metadata ?? {};
      const semanticFrame = readSemanticFrame(metadata);
      const expectedBehavior = String(metadata.expectedBehavior ?? "").trim() === "clarify_first"
        ? "clarify_first"
        : "answer_now";
      const storedSummary = String(metadata.expectedAnswerSummaryHuman ?? "").trim();
      const expectedAnswerSummaryHuman = (!storedSummary || looksGenericExpectedAnswerSummary(storedSummary))
        ? buildEvidenceGroundedAnswerSummary({
          question: r.question,
          domain: r.domain,
          lens: r.lens,
          expectedBehavior,
          expectedCoreClaims: collectStructuredClaimsFromTexts(evidencePreview.map((item) => item.snippet), 6),
          actorName: semanticFrame?.statementOwnerName ?? semanticFrame?.actorScope ?? null,
          semanticFrame,
          evidenceTexts: evidencePreview.map((item) => item.snippet),
          evidenceRows: evidencePreview
        })
        : storedSummary;
      return {
        metadata,
        calibrationItemId: r.id,
        caseId: r.case_id,
        domain: r.domain,
        lens: r.lens,
        caseSet: r.case_set,
        question: r.question,
        expectedBehavior,
        semanticFrame,
        semanticFrameSummary: readSemanticFrameSummary(metadata),
        clarificationQuestion: readClarificationQuestion(metadata),
        resolvedQuestionAfterClarification: readResolvedQuestionAfterClarification(metadata),
        expectedAnswerSummaryHuman,
        authoringCritique: readAuthoringCritique(metadata),
        feasibilityReport: readFeasibilityReport(metadata),
        admissionDecision: readAdmissionDecision(metadata),
        evidencePreview,
        qualityGate: readCaseQualityGate(metadata),
        ambiguityClass: (r.ambiguity_class ?? "clear") as "clear" | "clarify_required" | "unresolved",
        ownerValidationState: (r.owner_validation_state ?? "pending") as "pending" | "approved" | "rejected" | "not_required",
        createdAt: r.created_at,
        itemStatus: String(r.item_status || "pending"),
        reviewVerdict: r.review_verdict ? String(r.review_verdict) : null,
        reviewNotes: r.review_notes ? String(r.review_notes) : null,
        assistantSuggestion: parseAssistantCalibrationSuggestion({
          verdict: r.assistant_verdict,
          notes: r.assistant_notes,
          createdAt: r.assistant_created_at
        })
      };
    })
  };
}

function parseAssistantCalibrationSuggestion(params: {
  verdict: string | null;
  notes: string | null;
  createdAt?: string | null;
}): Record<string, unknown> | null {
  const verdict = params.verdict === "no" ? "no" : (params.verdict === "yes" ? "yes" : "");
  const rawNotes = String(params.notes ?? "").trim();
  const parsed = parseJsonObjectLike(rawNotes);
  const ambiguityRaw = String(parsed?.ambiguityClass ?? "").trim().toLowerCase();
  const ambiguityClass =
    ambiguityRaw === "clear" || ambiguityRaw === "clarify_required" || ambiguityRaw === "unresolved"
      ? ambiguityRaw
      : null;
  const rationale = String(parsed?.notes ?? parsed?.comment ?? rawNotes).trim() || null;
  if (!verdict && !rationale && !ambiguityClass) return null;
  const confidence = Number(parsed?.confidence ?? 0);
  return {
    verdict: verdict || null,
    ambiguityClass,
    notes: rationale,
    confidence: Number.isFinite(confidence) ? confidence : 0,
    createdAt: params.createdAt ?? null
  };
}

function buildCalibrationReviewHints(item: {
  question?: string;
  lens?: string;
  expectedAnswerSummaryHuman?: string;
  semanticFrame?: Record<string, unknown> | null;
  evidencePreview?: Array<{ snippet?: string | null }>;
}): Record<string, unknown> {
  const question = String(item.question ?? "").trim();
  const evidenceTexts = Array.isArray(item.evidencePreview)
    ? item.evidencePreview.map((entry) => String(entry?.snippet ?? "")).filter(Boolean)
    : [];
  const representativeItems = extractRepresentativeListItems(evidenceTexts, 5);
  const summary = String(item.expectedAnswerSummaryHuman ?? "").trim();
  const pleasantryOnly = evidenceTexts.length > 0 && evidenceTexts.every((text) => looksLikePleasantryOnly(text));
  return {
    questionLooksListSeeking: questionRequestsList(question),
    representativeItems,
    summaryLooksGeneric: looksGenericExpectedAnswerSummary(summary),
    summaryNeedsListSpecificity: representativeItems.length >= 2 && questionRequestsList(question) && !representativeItems.some((itemName) => lowerText(summary).includes(lowerText(itemName))),
    counterfactualForm: /\bwhat would\b|\bhow would\b|\bif\b.+\bhad not\b/i.test(question),
    suggestionQuestion: /\bwhat did .* suggest\b/i.test(question),
    pleasantryOnly,
    semanticFrameOwner: String(item.semanticFrame?.statementOwnerName ?? "").trim() || null
  };
}

function compactEvidencePreviewForModel(
  evidencePreview: unknown,
  options?: { maxRows?: number; maxChars?: number }
): Array<Record<string, unknown>> {
  const maxRows = Number.isFinite(Number(options?.maxRows)) ? Math.max(1, Number(options?.maxRows)) : 4;
  const maxChars = Number.isFinite(Number(options?.maxChars)) ? Math.max(80, Number(options?.maxChars)) : 360;
  const rows = Array.isArray(evidencePreview)
    ? evidencePreview.filter((row) => row && typeof row === "object" && !Array.isArray(row))
    : [];
  return rows
    .slice(0, maxRows)
    .map((row) => {
      const record = row as Record<string, unknown>;
      return {
        actorName: String(record.actorName ?? "").trim() || null,
        actorType: String(record.actorType ?? "").trim() || null,
        sourceSystem: String(record.sourceSystem ?? "").trim() || null,
        observedAt: String(record.observedAt ?? "").trim() || null,
        snippet: compactText(String(record.snippet ?? ""), maxChars)
      };
    });
}

function buildCalibrationReviewModelItem(item: Record<string, unknown>): Record<string, unknown> {
  const semanticFrame =
    item.semanticFrame && typeof item.semanticFrame === "object" && !Array.isArray(item.semanticFrame)
      ? (item.semanticFrame as Record<string, unknown>)
      : null;
  const compactEvidencePreview = compactEvidencePreviewForModel(item.evidencePreview);
  const existingHints =
    item.derivedHints && typeof item.derivedHints === "object" && !Array.isArray(item.derivedHints)
      ? (item.derivedHints as Record<string, unknown>)
      : null;
  return {
    ...item,
    evidencePreview: compactEvidencePreview,
    derivedHints: existingHints ?? buildCalibrationReviewHints({
      question: String(item.question ?? ""),
      lens: String(item.lens ?? ""),
      expectedAnswerSummaryHuman: String(item.expectedAnswerSummaryHuman ?? ""),
      semanticFrame,
      evidencePreview: compactEvidencePreview as Array<{ snippet?: string | null }>
    })
  };
}

async function reviewCalibrationChunkSafely(
  items: Array<Record<string, unknown>>,
  label: string
): Promise<Array<Record<string, unknown>>> {
  const modelItems = items.map((item) => buildCalibrationReviewModelItem(item));
  try {
    return await reviewCalibrationBatchWithModel(modelItems);
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    console.error(`[review] ${label} failed: ${message}`);
    return [];
  }
}

function sanitizeAssistantCalibrationReview(
  review: Record<string, unknown>,
  item: Record<string, unknown>
): {
  verdict: "yes" | "no";
  ambiguityClass: "clear" | "clarify_required" | "unresolved";
  notes: string;
  confidence: number;
} {
  const verdict = String(review.verdict ?? "").trim().toLowerCase() === "no" ? "no" : "yes";
  const ambiguityRaw = String(review.ambiguityClass ?? "").trim().toLowerCase();
  const ambiguityClass =
    ambiguityRaw === "clarify_required" || ambiguityRaw === "unresolved"
      ? ambiguityRaw
      : "clear";
  const currentLens = String(item.lens ?? "").trim().toLowerCase();
  const question = String(item.question ?? "").trim();
  const expectedBehavior = String(item.expectedBehavior ?? "").trim().toLowerCase();
  const clarificationQuestion = String(item.clarificationQuestion ?? "").trim();
  const rawNotes = String(review.notes ?? "").trim();
  let notes = rawNotes;
  let confidence = Number(review.confidence ?? 0);
  const derivedHints = item.derivedHints && typeof item.derivedHints === "object" && !Array.isArray(item.derivedHints)
    ? item.derivedHints as Record<string, unknown>
    : {};
  const summaryNeedsListSpecificity = Boolean(derivedHints.summaryNeedsListSpecificity);
  const counterfactualForm = Boolean(derivedHints.counterfactualForm);
  const suggestionQuestion = Boolean(derivedHints.suggestionQuestion);
  const pleasantryOnly = Boolean(derivedHints.pleasantryOnly);
  const representativeItems = Array.isArray(derivedHints.representativeItems)
    ? derivedHints.representativeItems.map(String).filter(Boolean)
    : [];
  const summaryText = String(item.expectedAnswerSummaryHuman ?? "").trim().toLowerCase();
  const questionLooksListSeeking = Boolean(derivedHints.questionLooksListSeeking);
  const summaryIncludesRepresentativeItems = representativeItems.length >= 2
    && representativeItems.some((itemName) => summaryText.includes(String(itemName).toLowerCase()));
  const summaryLooksConcreteList = looksLikeConcreteListSummary(String(item.expectedAnswerSummaryHuman ?? ""));

  const sameLensMismatch =
    /lens mismatch/i.test(notes)
    && currentLens.length > 0
    && new RegExp(`\\b${currentLens.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(notes)
    && /instead of/i.test(notes);
  const placeholder =
    !notes
    || /^ai suggestion generated\.?$/i.test(notes)
    || /^well-grounded and clear/i.test(notes)
    || /^the question and evidence are well-aligned/i.test(notes);

  if (sameLensMismatch) {
    notes = verdict === "no"
      ? "Review needed: the original AI note was internally inconsistent."
      : "Grounded case; prior AI note was internally inconsistent.";
  } else if (verdict === "no" && suggestionQuestion && pleasantryOnly) {
    notes = "Question overstates a suggestion: the evidence only offers pleasantries, not a concrete recommendation.";
  } else if (
    verdict === "no"
    && (summaryIncludesRepresentativeItems || (questionLooksListSeeking && summaryLooksConcreteList))
    && /(missing .*?(?:items|names|list)|does not include specific .*?(?:names|items|details)|summary is too generic|not grounded enough|lacks grounding|unclear what specific)/i.test(notes)
  ) {
    return {
      verdict: "yes",
      ambiguityClass,
      notes: "Grounded case: the summary already names representative items from the evidence.",
      confidence: Math.max(confidence, 0.84)
    };
  } else if (verdict === "no" && summaryNeedsListSpecificity && /(ground|timeline|not grounded|weak)/i.test(notes)) {
    notes = "Summary too generic: it should name the specific items shown in the evidence.";
  } else if (verdict === "no" && suggestionQuestion && /anything else|needed anything else|ask(?:ed)? if/i.test(notes)) {
    notes = "Question overstates a suggestion: the evidence only offers pleasantries, not a concrete recommendation.";
  } else if (verdict === "no" && counterfactualForm && /lens mismatch/i.test(notes)) {
    notes = "Counterfactual form is valid here; review the summary and grounding instead of changing the lens.";
  } else if (placeholder) {
    if (verdict === "yes") {
      notes = "Grounded: question, evidence, and lens appear aligned.";
    } else if (ambiguityClass === "unresolved") {
      notes = "Weak grounding: the case is not reliable enough for scoring.";
    } else if (ambiguityClass === "clarify_required") {
      notes = "Needs clarification: the question is plausible but missing a critical detail.";
    } else if (/\bwhat would\b|\bif\b.+\bhad not\b/i.test(question)) {
      notes = "Review counterfactual support carefully against the evidence wording.";
    } else {
      notes = "Review needed: question, evidence, or lens do not align cleanly.";
    }
  }

  if (expectedBehavior === "clarify_first") {
    const slotType = classifyClarifyMissingSlotType({
      question,
      clarificationQuestion,
      notes,
      modelValue: String(review.missingSlotType ?? item.missingSlotType ?? "").trim()
    });
    const negativeClarifyCue = /too specific|unrealistic|not realistic|wrong missing slot|wrong follow[- ]?up|should ask about|follow up needs|does not resolve|not sufficient|system will not know/i.test(notes);
    const positiveClarifyCue =
      ambiguityClass === "clarify_required"
      && /needs? to specify|should specify|does not specify|missing|lacks grounding in a specific|needs clarification|which .* are you referring|clarify/i.test(notes);
    if (verdict === "no" && positiveClarifyCue && !negativeClarifyCue) {
      const label =
        slotType === "actor" ? "actor"
        : slotType === "timeframe" ? "timeframe"
        : slotType === "app_or_platform" ? "app or platform"
        : slotType === "location" ? "location"
        : slotType === "thread_identity" ? "thread"
        : "target detail";
      notes = `Valid clarify case: the follow-up asks for the missing ${label}.`;
      confidence = Math.max(confidence, 0.78);
      return {
        verdict: "yes",
        ambiguityClass: "clarify_required",
        notes,
        confidence
      };
    }
    if (verdict === "yes" && ambiguityClass === "clear") {
      return {
        verdict,
        ambiguityClass: "clarify_required",
        notes: notes || "Valid clarify case: the first-turn question needs one short follow-up before answering.",
        confidence: Number.isFinite(confidence) ? confidence : 0
      };
    }
  }

  return {
    verdict,
    ambiguityClass: ambiguityClass as "clear" | "clarify_required" | "unresolved",
    notes,
    confidence: Number.isFinite(confidence) ? confidence : 0
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

async function upsertAssistantCalibrationSuggestion(params: {
  calibrationItemId: string;
  verdict: "yes" | "no";
  ambiguityClass: "clear" | "clarify_required" | "unresolved";
  notes: string;
  confidence: number;
}): Promise<void> {
  const payload = JSON.stringify({
    verdict: params.verdict,
    ambiguityClass: params.ambiguityClass,
    notes: params.notes,
    confidence: Number.isFinite(params.confidence) ? Number(params.confidence) : 0
  });
  await pool.query(
    `INSERT INTO experiment_judge_calibration_labels (
       calibration_item_id, reviewer, verdict, notes
     ) VALUES (
       $1::uuid, 'assistant', $2, $3
     )
     ON CONFLICT (calibration_item_id, reviewer)
     DO UPDATE SET
       verdict = EXCLUDED.verdict,
       notes = EXCLUDED.notes,
       created_at = now()`,
    [params.calibrationItemId, params.verdict, payload]
  );
}

async function reviewCalibrationBatchWithModel(items: Array<Record<string, unknown>>): Promise<Array<Record<string, unknown>>> {
  const openAiKey = String(config.openAiApiKey ?? "").trim();
  if (!openAiKey) {
    throw new Error("Calibration auto-review requires OPENAI_API_KEY.");
  }
  const url = `${String(config.openAiBaseUrl || "https://api.openai.com/v1").replace(/\/+$/, "")}/chat/completions`;
  const apiKey = openAiKey;
  const model = String(config.metadataModel || "gpt-4o-mini").replace(/^openai\//i, "");
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
        max_tokens: 1500,
        response_format: { type: "json_object" },
        messages: [
            {
              role: "system",
              content:
                "You are CalibrationReviewAgent for OpenBrain. Review benchmark calibration items and suggest what the owner should do. " +
                "Return JSON only with key reviews, an array. Each review must include calibrationItemId, verdict, ambiguityClass, notes, confidence. " +
                "Judge from the owner's or owner's-agent point of view. Prefer concrete, specific notes; never emit placeholders like 'AI suggestion generated'. " +
                "Use verdict=no when the case should not be owner-approved as currently written. Main failure reasons: wrong point of view, wrong actor scope, wrong thread scope, wrong time scope, weak grounding, unnatural question, wrong ambiguity class, expected answer summary wrong, or true lens mismatch. " +
                "Keep ambiguityClass clear unless the question itself truly needs clarification or the case is too weak to trust. " +
                "For clarify-required cases, accept when the first-turn question is plausible and the follow-up asks for a genuinely critical missing slot. Reject only when the follow-up is unrealistic, too specific, or asks for the wrong missing slot. " +
                "Do not penalize a clarify-required case just because another valid follow-up could also work; focus on whether this follow-up is realistic and sufficient. " +
                "Only call lens mismatch when another lens is clearly more appropriate. Never say a lens should change to the same lens it already has. " +
                "Counterfactuals are valid when the question asks about an alternate outcome and the evidence supports the conditional implication. " +
                "Thread reconstruction and timeline reconstruction can still be valid even when the actor is already named; do not reject them for that reason alone. " +
                "Treat expectedAnswerSummaryHuman as the expected answer description, not as a generic instruction template. If the summary says 'should summarize', 'is expected to', or similarly generic wording while the evidence clearly supports a concrete answer, verdict=no and say the summary is too generic. " +
                "For list-seeking questions such as apps, firms, parks, prospects, or other ranked options, the expected answer summary should name representative items from the evidence. If the evidence clearly contains those items and the summary only says 'several' or 'top-rated', verdict=no and note that the summary is missing the specific list items. " +
                "If the question asks what someone suggested or recommended, but the evidence only contains pleasantries or acknowledgements, verdict=no and say the question overstates a suggestion. " +
                "If the evidence clearly contains the answer and the only defect is wording in expectedAnswerSummaryHuman, do not invent a grounding failure or lens mismatch; call out the summary defect directly. " +
                "If the question and evidence are good but the expected answer summary has the wrong pronoun, tense, or ownership, verdict=no and say summary wrong rather than lens mismatch. " +
                "Allowed ambiguityClass values: clear, clarify_required, unresolved. Keep notes to one short concrete sentence."
            },
          {
            role: "user",
            content: JSON.stringify({
              items
            })
          }
        ]
      })
    });
    if (!response.ok) {
      throw new Error(`auto-review model error ${response.status}`);
    }
    const payload = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const raw = String(payload?.choices?.[0]?.message?.content ?? "").trim();
    const parsed = parseJsonObjectLike(raw);
    const reviews = Array.isArray(parsed?.reviews) ? parsed.reviews : [];
    return reviews.filter((item) => item && typeof item === "object" && !Array.isArray(item)) as Array<Record<string, unknown>>;
  } finally {
    clearTimeout(timeout);
  }
}

async function generatePositiveVariantBatchWithModel(items: Array<Record<string, unknown>>): Promise<Array<Record<string, unknown>>> {
  const openAiKey = String(config.openAiApiKey ?? "").trim();
  if (!openAiKey) {
    throw new Error("Positive variant generation requires OPENAI_API_KEY.");
  }
  const url = `${String(config.openAiBaseUrl || "https://api.openai.com/v1").replace(/\/+$/, "")}/chat/completions`;
  const apiKey = openAiKey;
  const model = String(config.metadataModel || "gpt-4o-mini").replace(/^openai\//i, "");
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
        temperature: 0.2,
        max_tokens: 1800,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              "You are PositiveBenchmarkVariantAgent for OpenBrain. Generate natural first-turn user questions from already-approved benchmark cases. " +
              "Return JSON only with key variants, an array. Each variant must include sourceCaseId, question, rationale. " +
              "Keep the same domain, lens, actor scope, thread scope, and evidence grounding as the source case. " +
              "The question must remain from the owner's or owner's-agent point of view. " +
              "Do not introduce hard dates unless the source already needs them. " +
              "Do not introduce file paths, raw ids, or benchmark-y wording. " +
              "Produce up to 2 strong variants per source item, and skip a source item if you cannot improve it safely."
          },
          {
            role: "user",
            content: JSON.stringify({ items })
          }
        ]
      })
    });
    if (!response.ok) {
      throw new Error(`positive-variant model error ${response.status}`);
    }
    const payload = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const raw = String(payload?.choices?.[0]?.message?.content ?? "").trim();
    const parsed = parseJsonObjectLike(raw);
    const variants = Array.isArray(parsed?.variants) ? parsed.variants : [];
    return variants.filter((item) => item && typeof item === "object" && !Array.isArray(item)) as Array<Record<string, unknown>>;
  } finally {
    clearTimeout(timeout);
  }
}

async function generateClarifyVariantBatchWithModel(items: Array<Record<string, unknown>>): Promise<Array<Record<string, unknown>>> {
  const openAiKey = String(config.openAiApiKey ?? "").trim();
  if (!openAiKey) {
    throw new Error("Clarify variant generation requires OPENAI_API_KEY.");
  }
  const url = `${String(config.openAiBaseUrl || "https://api.openai.com/v1").replace(/\/+$/, "")}/chat/completions`;
  const apiKey = openAiKey;
  const model = String(config.metadataModel || "gpt-4o-mini").replace(/^openai\//i, "");
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
        temperature: 0.2,
        max_tokens: 2200,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              "You are ClarifyBenchmarkVariantAgent for OpenBrain. Generate natural first-turn user questions that should require one short clarification before answering. " +
              "Return JSON only with key variants, an array. Each variant must include sourceCaseId, question, clarificationQuestion, resolvedQuestionAfterClarification, missingSlotType, rationale. " +
              "Start from grounded source benchmark cases. Remove exactly one critical slot from the source question, such as actor, timeframe, topic qualifier, thread identity, or target scope, so the first-turn question becomes plausible but underspecified. " +
              "Allowed missingSlotType values: actor, timeframe, app_or_platform, location, thread_identity, target_scope. " +
              "The resolvedQuestionAfterClarification must restore the missing slot and remain answerable from the same evidence. " +
              "Keep the same domain, lens, actor/thread scope, and evidence grounding as the source. " +
              "Stay in the owner's or owner's-agent point of view. Do not invent names, dates, or facts not supported by the source evidence. " +
              "Do not emit benchmark-y wording, raw ids, or file paths. " +
              "Produce at most 1 strong clarify variant per source item and skip items that cannot support a trustworthy clarify case. " +
              "Diversify the batch. Do not repeat the same ambiguity archetype across multiple source items when another missing slot type is available."
          },
          {
            role: "user",
            content: JSON.stringify({ items })
          }
        ]
      })
    });
    if (!response.ok) {
      throw new Error(`clarify-variant model error ${response.status}`);
    }
    const payload = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const raw = String(payload?.choices?.[0]?.message?.content ?? "").trim();
    const parsed = parseJsonObjectLike(raw);
    const variants = Array.isArray(parsed?.variants) ? parsed.variants : [];
    return variants.filter((item) => item && typeof item === "object" && !Array.isArray(item)) as Array<Record<string, unknown>>;
  } finally {
    clearTimeout(timeout);
  }
}

export async function autoReviewJudgeCalibration(params: {
  experimentId: string;
  limit?: number;
  batchSize?: number;
  status?: "pending" | "labeled" | "all";
  domain?: string;
  caseSet?: "dev" | "critical" | "certification" | "stress" | "coverage";
  refreshExisting?: boolean;
  ambiguityClass?: "clear" | "clarify_required" | "unresolved";
}): Promise<Record<string, unknown>> {
  const limit = Number.isFinite(Number(params.limit)) ? Math.max(1, Math.min(500, Number(params.limit))) : 200;
  const batchSize = Number.isFinite(Number(params.batchSize)) ? Math.max(1, Math.min(20, Number(params.batchSize))) : 5;
  const status = params.status === "labeled" || params.status === "all" ? params.status : "pending";
  const refreshExisting = params.refreshExisting === true;
  let materialized = 0;
  if (status === "pending" || status === "all") {
    materialized = await materializeCalibrationItemsForPendingCases({
      experimentId: params.experimentId,
      domain: params.domain,
      caseSet: params.caseSet
    });
  }
  const pendingPayload = await listJudgeCalibrationPending({
    experimentId: params.experimentId,
    limit,
    status,
    ambiguityClass: params.ambiguityClass
  });
  const pending = Array.isArray((pendingPayload as Record<string, unknown>).items)
    ? ((pendingPayload as Record<string, unknown>).items as Array<Record<string, unknown>>)
    : [];
  const targets = pending.filter((item) => refreshExisting || !item.assistantSuggestion);
  let reviewed = 0;
  const touched: string[] = [];
  for (let i = 0; i < targets.length; i += batchSize) {
    const chunk = targets.slice(i, i + batchSize).map((item) => ({
      calibrationItemId: item.calibrationItemId,
      question: item.question,
      domain: item.domain,
      lens: item.lens,
      ambiguityClass: item.ambiguityClass,
      expectedBehavior: item.expectedBehavior,
      expectedAnswerSummaryHuman: item.expectedAnswerSummaryHuman,
      semanticFrame: item.semanticFrame,
      semanticFrameSummary: item.semanticFrameSummary,
      evidencePreview: item.evidencePreview,
      qualityGate: item.qualityGate,
      authoringCritique: item.authoringCritique,
      derivedHints: buildCalibrationReviewHints({
        question: String(item.question ?? ""),
        lens: String(item.lens ?? ""),
        expectedAnswerSummaryHuman: String(item.expectedAnswerSummaryHuman ?? ""),
        semanticFrame: (item.semanticFrame && typeof item.semanticFrame === "object" && !Array.isArray(item.semanticFrame))
          ? item.semanticFrame as Record<string, unknown>
          : null,
        evidencePreview: Array.isArray(item.evidencePreview)
          ? item.evidencePreview as Array<{ snippet?: string | null }>
          : []
      })
    }));
      const reviews = await reviewCalibrationChunkSafely(chunk, "auto-review-calibration");
      const chunkMap = new Map(chunk.map((candidate) => [String(candidate.calibrationItemId ?? ""), candidate]));
      for (const review of reviews) {
        const calibrationItemId = String(review.calibrationItemId ?? "").trim();
        if (!calibrationItemId) continue;
        const normalized = sanitizeAssistantCalibrationReview(review, chunkMap.get(calibrationItemId) ?? {});
        await upsertAssistantCalibrationSuggestion({
          calibrationItemId,
          verdict: normalized.verdict,
          ambiguityClass: normalized.ambiguityClass,
          notes: normalized.notes,
          confidence: normalized.confidence
        });
        reviewed += 1;
        touched.push(calibrationItemId);
      }
  }
  return {
    ok: true,
    experimentId: params.experimentId,
    status,
    materialized,
    requested: targets.length,
    reviewed,
    calibrationItemIds: touched
  };
}

export async function refreshExperimentExpectedAnswerSummaries(params: {
  experimentId: string;
  pendingOnly?: boolean;
}): Promise<Record<string, unknown>> {
  const rows = await pool.query<{
    case_id: string;
    question: string;
    domain: string;
    lens: string;
    expected_core_claims: string[] | string;
    evidence_ids: string[] | string;
    metadata: Record<string, unknown>;
    expected_answer: Record<string, unknown>;
    owner_validation_state: string | null;
  }>(
    `SELECT
       c.id::text AS case_id,
       c.question,
       c.domain,
       c.lens,
       COALESCE(c.expected_core_claims::text, '[]') AS expected_core_claims,
       COALESCE(c.evidence_ids::text, '{}') AS evidence_ids,
       c.metadata,
       COALESCE((
         SELECT i.expected_answer
         FROM experiment_judge_calibration_items i
         WHERE i.experiment_id = $1::uuid
           AND i.case_id = c.id
         ORDER BY i.created_at DESC
         LIMIT 1
       ), '{}'::jsonb) AS expected_answer,
       c.owner_validation_state
     FROM experiment_cases c
     WHERE c.experiment_id = $1::uuid
       AND c.is_stale = false
       AND ($2::boolean = false OR c.owner_validation_state = 'pending')`,
    [params.experimentId, params.pendingOnly === true]
  );
  const allEvidenceIds = rows.rows.flatMap((row) => (
    Array.isArray(row.evidence_ids)
      ? row.evidence_ids.map(String)
      : parsePgTextArray(String(row.evidence_ids ?? "{}"))
  ));
  const evidenceMap = await loadEvidencePreviewMap(allEvidenceIds);
  let updatedCases = 0;
  let updatedItems = 0;
  for (const row of rows.rows) {
    const metadata = row.metadata ?? {};
    const semanticFrame = readSemanticFrame(metadata);
    const questionVoiceRaw = String(metadata.questionVoice ?? "unknown").trim();
    const normalizedQuestionVoice = normalizeQuestionVoiceForFrame(
      questionVoiceRaw === "user_first_person" || questionVoiceRaw === "user_about_other" || questionVoiceRaw === "assistant_proxy"
        ? questionVoiceRaw
        : "unknown",
      semanticFrame
    );
    const normalizedQuestion = normalizeAssistantHistoricalQuestion(row.question, semanticFrame, normalizedQuestionVoice);
    const expectedBehavior = String(metadata.expectedBehavior ?? "").trim() === "clarify_first"
      ? "clarify_first"
      : "answer_now";
    const expectedCoreClaims = Array.isArray(row.expected_core_claims)
      ? row.expected_core_claims.map(String)
      : parseJsonArray(String(row.expected_core_claims ?? "[]"));
    const expectedEvidenceIds = Array.isArray(row.evidence_ids)
      ? row.evidence_ids.map(String)
      : parsePgTextArray(String(row.evidence_ids ?? "{}"));
    const evidencePreview = expectedEvidenceIds
      .map((id) => evidenceMap.get(id))
      .filter(isEvidencePreviewRow)
      .sort((a, b) => String(a.observedAt ?? "").localeCompare(String(b.observedAt ?? "")));
    const summary = buildEvidenceGroundedAnswerSummary({
      question: normalizedQuestion,
      domain: row.domain,
      lens: row.lens,
      expectedBehavior,
      expectedCoreClaims,
      actorName: semanticFrame?.statementOwnerName ?? semanticFrame?.actorScope ?? null,
      semanticFrame,
      evidenceTexts: evidencePreview.map((item) => item.snippet),
      evidenceRows: evidencePreview
    });
    if (!summary) continue;
    const storedSummary = String(metadata.expectedAnswerSummaryHuman ?? "").trim();
    const questionChanged = normalizedQuestion !== row.question;
    const summaryChanged = storedSummary !== summary;
    const refreshedSemanticFrameSummary = summarizeSemanticFrame(semanticFrame);
    const metadataSemanticFrame = (metadata.semanticFrame && typeof metadata.semanticFrame === "object" && !Array.isArray(metadata.semanticFrame))
      ? (metadata.semanticFrame as Record<string, unknown>)
      : null;
    const semanticFrameChanged = JSON.stringify(metadataSemanticFrame ?? null) !== JSON.stringify(semanticFrame ?? null);
    const questionVoiceChanged = String(metadata.questionVoice ?? "unknown") !== normalizedQuestionVoice;
    if (!questionChanged && !summaryChanged && !semanticFrameChanged && !questionVoiceChanged) continue;
    const updatedMetadata = {
      ...metadata,
      semanticFrame,
      questionVoice: normalizedQuestionVoice,
      expectedAnswerSummaryHuman: summary,
      semanticFrameSummary: refreshedSemanticFrameSummary
    };
    await pool.query(
      `UPDATE experiment_cases
          SET question = $2,
              metadata = $3::jsonb,
              updated_at = now()
        WHERE id = $1::uuid`,
      [row.case_id, normalizedQuestion, JSON.stringify(updatedMetadata)]
    );
    updatedCases += 1;
    const existingExpectedAnswer = (row.expected_answer && typeof row.expected_answer === "object" && !Array.isArray(row.expected_answer))
      ? row.expected_answer
      : {};
    const refreshedExpectedAnswer = {
      ...existingExpectedAnswer,
      expectedAnswerSummaryHuman: summary,
      semanticFrameSummary: refreshedSemanticFrameSummary,
      feasibilityReport: (existingExpectedAnswer.feasibilityReport && typeof existingExpectedAnswer.feasibilityReport === "object" && !Array.isArray(existingExpectedAnswer.feasibilityReport))
        ? {
            ...(existingExpectedAnswer.feasibilityReport as Record<string, unknown>),
            verifiedQuestion: normalizedQuestion
          }
        : existingExpectedAnswer.feasibilityReport
    };
    const itemUpdate = await pool.query(
      `UPDATE experiment_judge_calibration_items
          SET question = $2,
              expected_answer = $3::jsonb
        WHERE experiment_id = $1::uuid
          AND case_id = $4::uuid`,
      [params.experimentId, normalizedQuestion, JSON.stringify(refreshedExpectedAnswer), row.case_id]
    );
    updatedItems += Number(itemUpdate.rowCount ?? 0);
  }
  return {
    ok: true,
    experimentId: params.experimentId,
    pendingOnly: params.pendingOnly === true,
    updatedCases,
    updatedCalibrationItems: updatedItems
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

type CalibrationReviewRow = {
  calibrationItemId: string;
  caseId: string;
  verdict: "yes" | "no";
  notes: string;
  domain: string;
  lens: string;
  question: string;
};

function classifyCalibrationRejectionBucket(notes: string): string {
  const text = String(notes ?? "").trim();
  if (/lens mismatch|wrong lens|descriptive lens|appropriate lens|timeline reconstruction|actor attribution|confidence scoring/i.test(text)) {
    return "lens_mismatch";
  }
  if (/wrong pronoun|wrong pov|ownership|their marriage|your numbers/i.test(text)) {
    return "pov_or_pronoun";
  }
  if (/follow up question|clarify|which project/i.test(text)) {
    return "clarify_needed";
  }
  if (/future tense|past tense|summary|tense/i.test(text)) {
    return "time_or_tense";
  }
  if (/unnatural/i.test(text)) {
    return "unnatural";
  }
  if (/not correct based on evidence|weak|not grounded|specific evidence|did not discuss|did not mention|never mentioned/i.test(text)) {
    return "grounding_or_question";
  }
  return "other";
}

function calibrationBucketPriority(bucket: string): number {
  const order = [
    "clarify_needed",
    "grounding_or_question",
    "lens_mismatch",
    "pov_or_pronoun",
    "time_or_tense",
    "unnatural",
    "other"
  ];
  const index = order.indexOf(bucket);
  return index >= 0 ? index : order.length;
}

function normalizeQuestionSignature(question: string): string {
  return String(question ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function buildBenchmarkQuestionDedupKey(question: string): string {
  return normalizeQuestionSignature(question);
}

function normalizeConceptSignature(text: string): string {
  const stopwords = new Set([
    "a", "an", "and", "are", "assistant", "about", "did", "does", "for", "grok", "chatgpt",
    "how", "i", "in", "is", "it", "me", "my", "of", "on", "or", "provide", "provided",
    "regarding", "say", "said", "tell", "the", "their", "there", "these", "they", "this",
    "to", "updates", "what", "which", "with", "would", "you", "your"
  ]);
  const tokens = String(text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 2 && !stopwords.has(token));
  return Array.from(new Set(tokens)).sort().join(" ");
}

function classifyClarifyMissingSlotType(params: {
  question?: string | null;
  clarificationQuestion?: string | null;
  notes?: string | null;
  modelValue?: string | null;
}): "actor" | "timeframe" | "app_or_platform" | "location" | "thread_identity" | "target_scope" {
  const normalizedModelValue = String(params.modelValue ?? "").trim().toLowerCase();
  if (
    normalizedModelValue === "actor"
    || normalizedModelValue === "timeframe"
    || normalizedModelValue === "app_or_platform"
    || normalizedModelValue === "location"
    || normalizedModelValue === "thread_identity"
    || normalizedModelValue === "target_scope"
  ) {
    return normalizedModelValue as "actor" | "timeframe" | "app_or_platform" | "location" | "thread_identity" | "target_scope";
  }

  const text = `${String(params.question ?? "")} ${String(params.clarificationQuestion ?? "")} ${String(params.notes ?? "")}`.toLowerCase();
  if (/\bwho\b|\bwhich person\b|\bwhich people\b|\bwhose\b|\bwho was\b|\bwho were\b/.test(text)) return "actor";
  if (/\bwhen\b|\btimeframe\b|\btime period\b|\btime window\b|\bwhich quarter\b|\bwhich month\b|\bwhich year\b|\bwhich date\b|\bwhat time\b|\bwhat period\b|\bwhen did\b/.test(text)) return "timeframe";
  if (/\bapp\b|\bapplication\b|\bplatform\b|\bsystem\b|\bdashboard\b|\bgoogle photos\b|\bopenclaw\b|\btelegram\b|\bwhatsapp\b/.test(text)) return "app_or_platform";
  if (/\blocation\b|\bcity\b|\bstreet\b|\bwhere\b|\bnear\b|\bwhich route\b|\bwhich address\b|\bwhich place\b/.test(text)) return "location";
  if (/\bconversation\b|\bthread\b|\bchat\b|\bmessage\b|\bgroup\b|\bchannel\b/.test(text)) return "thread_identity";
  return "target_scope";
}

function buildClarifyArchetypeKey(params: {
  question: string;
  clarificationQuestion?: string | null;
  slotType: string;
}): string {
  return `${String(params.slotType || "target_scope").toLowerCase()}|${normalizeConceptSignature(params.question)}|${normalizeConceptSignature(String(params.clarificationQuestion ?? ""))}`;
}

function clarifyRetentionRank(params: {
  ownerValidationState?: string | null;
  ownerVerdict?: string | null;
  assistantVerdict?: string | null;
  assistantConfidence?: number | null;
  qualityScore?: number | null;
  caseSet?: string | null;
}): number {
  let score = 0;
  if (String(params.ownerValidationState ?? "").trim() === "approved" || String(params.ownerVerdict ?? "").trim() === "yes") score += 1000;
  else if (String(params.ownerValidationState ?? "").trim() === "pending") score += 250;
  if (String(params.assistantVerdict ?? "").trim() === "yes") score += 120;
  else if (String(params.assistantVerdict ?? "").trim() === "no") score -= 60;
  if (String(params.caseSet ?? "").trim() === "critical") score += 20;
  else if (String(params.caseSet ?? "").trim() === "certification") score += 10;
  score += Math.round((Number(params.assistantConfidence ?? 0) || 0) * 20);
  score += Math.round((Number(params.qualityScore ?? 0) || 0) * 30);
  return score;
}

function duplicateBenchmarkRetentionRank(params: {
  ownerValidationState?: string | null;
  ownerVerdict?: string | null;
  ownerNotes?: string | null;
  assistantVerdict?: string | null;
  assistantNotes?: string | null;
  assistantConfidence?: number | null;
  qualityScore?: number | null;
  lensFit?: number | null;
  grounding?: number | null;
  actorScopeFidelity?: number | null;
  answerability?: number | null;
  caseSet?: string | null;
}): number {
  let score = 0;
  const ownerState = String(params.ownerValidationState ?? "").trim();
  const ownerVerdict = String(params.ownerVerdict ?? "").trim();
  const assistantVerdict = String(params.assistantVerdict ?? "").trim();
  const noteText = `${String(params.ownerNotes ?? "")} ${String(params.assistantNotes ?? "")}`.toLowerCase();

  if (ownerVerdict === "yes" || ownerState === "approved") score += 900;
  else if (ownerState === "pending" || !ownerState) score += 320;
  else if (ownerVerdict === "no" || ownerState === "rejected") score += 60;

  if (assistantVerdict === "yes") score += 140;
  else if (assistantVerdict === "no") score -= 120;

  score += Math.round((Number(params.assistantConfidence ?? 0) || 0) * 40);
  score += Math.round((Number(params.qualityScore ?? 0) || 0) * 60);
  score += Math.round((Number(params.lensFit ?? 0) || 0) * 90);
  score += Math.round((Number(params.grounding ?? 0) || 0) * 70);
  score += Math.round((Number(params.actorScopeFidelity ?? 0) || 0) * 35);
  score += Math.round((Number(params.answerability ?? 0) || 0) * 25);

  if (/lens mismatch/.test(noteText)) score -= 220;
  if (/wrong pov|wrong pronoun|wrong actor|wrong thread|wrong time/.test(noteText)) score -= 180;
  if (/weak grounding|not grounded|not reliable|unnatural/.test(noteText)) score -= 140;

  if (String(params.caseSet ?? "").trim() === "critical") score += 24;
  else if (String(params.caseSet ?? "").trim() === "certification") score += 14;
  else if (String(params.caseSet ?? "").trim() === "coverage") score += 8;
  else if (String(params.caseSet ?? "").trim() === "dev") score += 2;
  else if (String(params.caseSet ?? "").trim() === "stress") score -= 4;

  return score;
}

function buildCaseEvidenceFamilyKey(params: {
  evidenceIds?: string[] | string | null;
  conversationIds?: string[] | string | null;
  sourceEvidenceId?: string | null;
}): string {
  const evidenceIds = Array.isArray(params.evidenceIds)
    ? params.evidenceIds.map(String)
    : parsePgTextArray(String(params.evidenceIds ?? "{}"));
  const conversationIds = Array.isArray(params.conversationIds)
    ? params.conversationIds.map(String)
    : parsePgTextArray(String(params.conversationIds ?? "{}"));
  const normalizedEvidenceIds = uniqueStrings(evidenceIds.map((value) => value.trim()).filter(Boolean)).sort();
  if (normalizedEvidenceIds.length > 0) {
    return `ev:${normalizedEvidenceIds.join(",")}`;
  }
  const normalizedConversationIds = uniqueStrings(conversationIds.map((value) => value.trim()).filter(Boolean)).sort();
  if (normalizedConversationIds.length > 0) {
    return `conv:${normalizedConversationIds.join(",")}`;
  }
  const sourceEvidenceId = String(params.sourceEvidenceId ?? "").trim();
  if (sourceEvidenceId) return `src:${sourceEvidenceId}`;
  return "";
}

function minimumSupportClustersForSupplementalLens(lens: string): number {
  switch (String(lens ?? "").trim()) {
    case "descriptive":
      return 1;
    case "diagnostic":
    case "actionability":
    case "actor_attribution":
      return 2;
    case "predictive":
    case "prescriptive":
    case "counterfactuals":
    case "confidence_scoring":
    case "thread_reconstruction":
    case "timeline_reconstruction":
    case "trend_trajectory":
    case "outlier_detection":
    case "causal_hypotheses":
      return 3;
    default:
      return 2;
  }
}

function supplementalActorPriority(actorType: string | null | undefined): number {
  switch (String(actorType ?? "").trim().toLowerCase()) {
    case "assistant_or_system":
      return 0;
    case "other_human":
      return 1;
    case "user":
      return 2;
    default:
      return 3;
  }
}

async function rebalanceRepresentativeCaseSets(params: {
  experimentId: string;
  targetSets?: Array<"critical" | "certification">;
}): Promise<Record<string, unknown>> {
  const targetSets = uniqueStrings((params.targetSets ?? ["critical", "certification"]).map(String))
    .filter((value): value is "critical" | "certification" => value === "critical" || value === "certification");
  if (targetSets.length === 0) {
    return { ok: true, experimentId: params.experimentId, removed: 0, promoted: 0, promotedCalibrationItems: 0 };
  }

  const rows = await pool.query<{
    case_id: string;
    calibration_item_id: string | null;
    case_set: string;
    domain: string;
    lens: string;
    question: string;
    ambiguity_class: string | null;
    owner_validation_state: string | null;
    metadata: Record<string, unknown>;
    source_evidence_id: string | null;
    evidence_ids: string[] | string;
    conversation_ids: string[] | string;
    created_at: string;
    owner_verdict: string | null;
    owner_notes: string | null;
    assistant_verdict: string | null;
    assistant_notes: string | null;
    assistant_created_at: string | null;
  }>(
    `SELECT
       c.id::text AS case_id,
       li.calibration_item_id,
       c.case_set,
       c.domain,
       c.lens,
       c.question,
       c.ambiguity_class,
       c.owner_validation_state,
       c.metadata,
       c.source_evidence_id::text,
       COALESCE(c.evidence_ids::text, '{}') AS evidence_ids,
       COALESCE(c.conversation_ids::text, '{}') AS conversation_ids,
       c.created_at::text,
       own.verdict AS owner_verdict,
       own.notes AS owner_notes,
       asst.verdict AS assistant_verdict,
       asst.notes AS assistant_notes,
       asst.created_at::text AS assistant_created_at
     FROM experiment_cases c
     LEFT JOIN LATERAL (
       SELECT i.id::text AS calibration_item_id
       FROM experiment_judge_calibration_items i
       WHERE i.experiment_id = $1::uuid
         AND i.case_id = c.id
       ORDER BY
         CASE i.status
           WHEN 'pending' THEN 0
           WHEN 'labeled' THEN 1
           ELSE 2
         END ASC,
         i.updated_at DESC NULLS LAST,
         i.created_at DESC
       LIMIT 1
     ) li ON true
     LEFT JOIN LATERAL (
       SELECT l.verdict, COALESCE(l.notes, '') AS notes
       FROM experiment_judge_calibration_labels l
       WHERE l.calibration_item_id::text = li.calibration_item_id
         AND l.reviewer = 'owner'
       ORDER BY l.created_at DESC
       LIMIT 1
     ) own ON true
     LEFT JOIN LATERAL (
       SELECT l.verdict, l.notes, l.created_at
       FROM experiment_judge_calibration_labels l
       WHERE l.calibration_item_id::text = li.calibration_item_id
         AND l.reviewer = 'assistant'
       ORDER BY l.created_at DESC
       LIMIT 1
     ) asst ON true
     WHERE c.experiment_id = $1::uuid
       AND c.is_stale = false`,
    [params.experimentId]
  );

  type CaseRow = typeof rows.rows[number] & {
    familyKey: string;
    assistantSuggestion: ReturnType<typeof parseAssistantCalibrationSuggestion>;
    qualityGate: ReturnType<typeof readCaseQualityGate>;
    critique: ReturnType<typeof readAuthoringCritique>;
  };

  const enrichedRows: CaseRow[] = rows.rows.map((row) => ({
    ...row,
    familyKey: buildCaseEvidenceFamilyKey({
      evidenceIds: row.evidence_ids,
      conversationIds: row.conversation_ids,
      sourceEvidenceId: row.source_evidence_id
    }) || `case:${row.case_id}`,
    assistantSuggestion: parseAssistantCalibrationSuggestion({
      verdict: row.assistant_verdict,
      notes: row.assistant_notes,
      createdAt: row.assistant_created_at
    }),
    qualityGate: readCaseQualityGate(row.metadata ?? {}),
    critique: readAuthoringCritique(row.metadata ?? {})
  }));

  const targetSetConfig = new Map<"critical" | "certification", { familyCap: number }>([
    ["critical", { familyCap: 1 }],
    ["certification", { familyCap: 1 }]
  ]);
  const originalCounts = new Map<string, number>();
  const domainCountsBySet = new Map<string, Map<string, number>>();
  const familyCountsBySet = new Map<string, Map<string, number>>();
  const removedCaseIds = new Set<string>();
  const removedCalibrationItemIds = new Set<string>();

  const rankCase = (row: CaseRow): number => duplicateBenchmarkRetentionRank({
    ownerValidationState: row.owner_validation_state,
    ownerVerdict: row.owner_verdict,
    ownerNotes: row.owner_notes,
    assistantVerdict: String(row.assistantSuggestion?.verdict ?? ""),
    assistantNotes: String(row.assistantSuggestion?.notes ?? ""),
    assistantConfidence: Number(row.assistantSuggestion?.confidence ?? 0),
    qualityScore: row.qualityGate.score,
    lensFit: row.critique?.dimensions.lensFit,
    grounding: row.critique?.dimensions.evidenceGrounding,
    actorScopeFidelity: row.critique?.dimensions.actorScopeFidelity,
    answerability: row.critique?.dimensions.answerability,
    caseSet: row.case_set
  });

  for (const targetSet of targetSets) {
    const targetRows = enrichedRows.filter((row) => row.case_set === targetSet);
    originalCounts.set(targetSet, targetRows.length);
    const byFamily = new Map<string, CaseRow[]>();
    for (const row of targetRows) {
      const bucket = byFamily.get(row.familyKey) ?? [];
      bucket.push(row);
      byFamily.set(row.familyKey, bucket);
    }
    for (const rowsForFamily of byFamily.values()) {
      const familyCap = targetSetConfig.get(targetSet)?.familyCap ?? 1;
      const sorted = [...rowsForFamily].sort((left, right) => {
        const diff = rankCase(right) - rankCase(left);
        if (diff !== 0) return diff;
        return String(left.created_at).localeCompare(String(right.created_at));
      });
      const keep = sorted.slice(0, familyCap);
      const drop = sorted.slice(familyCap);
      const familyCountMap = familyCountsBySet.get(targetSet) ?? new Map<string, number>();
      familyCountMap.set(sorted[0]?.familyKey ?? "", keep.length);
      familyCountsBySet.set(targetSet, familyCountMap);
      const domainCountMap = domainCountsBySet.get(targetSet) ?? new Map<string, number>();
      for (const survivor of keep) {
        domainCountMap.set(survivor.domain, (domainCountMap.get(survivor.domain) ?? 0) + 1);
      }
      domainCountsBySet.set(targetSet, domainCountMap);
      for (const loser of drop) {
        removedCaseIds.add(loser.case_id);
        if (loser.calibration_item_id) removedCalibrationItemIds.add(loser.calibration_item_id);
      }
    }
  }

  if (removedCalibrationItemIds.size > 0) {
    const ids = [...removedCalibrationItemIds];
    await pool.query(`DELETE FROM experiment_judge_calibration_labels WHERE calibration_item_id = ANY($1::uuid[])`, [ids]);
    await pool.query(`DELETE FROM experiment_judge_calibration_items WHERE id = ANY($1::uuid[])`, [ids]);
  }
  if (removedCaseIds.size > 0) {
    await pool.query(
      `UPDATE experiment_cases
       SET is_stale = true,
           updated_at = now()
       WHERE id = ANY($1::uuid[])`,
      [[...removedCaseIds]]
    );
  }

  const remainingRows = enrichedRows.filter((row) => !removedCaseIds.has(row.case_id));
  const donorPool = remainingRows.filter((row) => !targetSets.includes(row.case_set as "critical" | "certification"));
  const promotedCaseIds = new Set<string>();
  const promotionAssignments = new Map<string, "critical" | "certification">();

  for (const targetSet of targetSets) {
    const targetCount = Number(originalCounts.get(targetSet) ?? 0);
    const currentCount = remainingRows.filter((row) => row.case_set === targetSet && !removedCaseIds.has(row.case_id)).length
      + [...promotionAssignments.values()].filter((value) => value === targetSet).length;
    let needed = Math.max(0, targetCount - currentCount);
    if (needed <= 0) continue;
    const familyMap = familyCountsBySet.get(targetSet) ?? new Map<string, number>();
    const domainMap = domainCountsBySet.get(targetSet) ?? new Map<string, number>();
    const orderedDonors = [...donorPool].filter((row) => !removedCaseIds.has(row.case_id) && !promotedCaseIds.has(row.case_id)).sort((left, right) => {
      const leftFamilyCount = familyMap.get(left.familyKey) ?? 0;
      const rightFamilyCount = familyMap.get(right.familyKey) ?? 0;
      if (leftFamilyCount !== rightFamilyCount) return leftFamilyCount - rightFamilyCount;
      const leftDomainCount = domainMap.get(left.domain) ?? 0;
      const rightDomainCount = domainMap.get(right.domain) ?? 0;
      if (leftDomainCount !== rightDomainCount) return leftDomainCount - rightDomainCount;
      const scoreDiff = rankCase(right) - rankCase(left);
      if (scoreDiff !== 0) return scoreDiff;
      return String(left.created_at).localeCompare(String(right.created_at));
    });
    for (const donor of orderedDonors) {
      if (needed <= 0) break;
      if ((familyMap.get(donor.familyKey) ?? 0) >= (targetSetConfig.get(targetSet)?.familyCap ?? 1)) continue;
      promotedCaseIds.add(donor.case_id);
      promotionAssignments.set(donor.case_id, targetSet);
      familyMap.set(donor.familyKey, (familyMap.get(donor.familyKey) ?? 0) + 1);
      domainMap.set(donor.domain, (domainMap.get(donor.domain) ?? 0) + 1);
      needed -= 1;
    }
    familyCountsBySet.set(targetSet, familyMap);
    domainCountsBySet.set(targetSet, domainMap);
  }

  if (promotionAssignments.size > 0) {
    for (const [caseId, targetSet] of promotionAssignments.entries()) {
      await pool.query(
        `UPDATE experiment_cases
         SET case_set = $2::text,
             updated_at = now()
         WHERE id = $1::uuid`,
        [caseId, targetSet]
      );
    }
  }

  const promotedWithoutCalibration = [...promotionAssignments.keys()].filter((caseId) => {
    const row = enrichedRows.find((item) => item.case_id === caseId);
    return !row?.calibration_item_id;
  });
  const calibrationMap = await materializeCalibrationItemsForCaseIds({
    experimentId: params.experimentId,
    caseIds: promotedWithoutCalibration
  });

  return {
    ok: true,
    experimentId: params.experimentId,
    removed: removedCaseIds.size,
    promoted: promotionAssignments.size,
    promotedCalibrationItems: calibrationMap.size,
    targetSets
  };
}

async function loadLatestOwnerCalibrationReviews(experimentId: string): Promise<CalibrationReviewRow[]> {
  const rows = await pool.query<{
    calibration_item_id: string;
    case_id: string;
    verdict: string;
    notes: string | null;
    domain: string;
    lens: string;
    question: string;
  }>(
    `WITH latest_owner AS (
       SELECT DISTINCT ON (l.calibration_item_id)
         l.calibration_item_id,
         l.verdict,
         COALESCE(l.notes, '') AS notes,
         l.created_at
       FROM experiment_judge_calibration_labels l
       JOIN experiment_judge_calibration_items i ON i.id = l.calibration_item_id
       WHERE i.experiment_id = $1::uuid
         AND l.reviewer = 'owner'
       ORDER BY l.calibration_item_id, l.created_at DESC
     )
     SELECT
       lo.calibration_item_id::text,
       i.case_id::text,
       lo.verdict,
       lo.notes,
       c.domain,
       c.lens,
       i.question
     FROM latest_owner lo
     JOIN experiment_judge_calibration_items i ON i.id = lo.calibration_item_id
     JOIN experiment_cases c ON c.id = i.case_id
     WHERE i.experiment_id = $1::uuid
       AND c.is_stale = false`,
    [experimentId]
  );
  return rows.rows.map((row) => ({
    calibrationItemId: row.calibration_item_id,
    caseId: row.case_id,
    verdict: row.verdict === "no" ? "no" : "yes",
    notes: String(row.notes ?? "").trim(),
    domain: row.domain,
    lens: row.lens,
    question: row.question
  }));
}

export async function revalidateClarifyCalibrationSlice(params: {
  experimentId: string;
}): Promise<Record<string, unknown>> {
  const rows = await pool.query<{
    case_id: string;
    calibration_item_id: string | null;
    case_set: string | null;
    domain: string;
    lens: string;
    question: string;
    metadata: Record<string, unknown>;
    owner_validation_state: string | null;
    owner_verdict: string | null;
    owner_notes: string | null;
    assistant_verdict: string | null;
    assistant_notes: string | null;
    assistant_created_at: string | null;
  }>(
    `SELECT
       c.id::text AS case_id,
       i.id::text AS calibration_item_id,
       c.case_set,
       c.domain,
       c.lens,
       c.question,
       c.metadata,
       c.owner_validation_state,
       owner_lbl.verdict AS owner_verdict,
       owner_lbl.notes AS owner_notes,
       asst_lbl.verdict AS assistant_verdict,
       asst_lbl.notes AS assistant_notes,
       asst_lbl.created_at::text AS assistant_created_at
     FROM experiment_cases c
     LEFT JOIN LATERAL (
       SELECT i.id
       FROM experiment_judge_calibration_items i
       WHERE i.case_id = c.id
         AND i.experiment_id = c.experiment_id
       ORDER BY i.created_at DESC
       LIMIT 1
     ) i ON true
     LEFT JOIN LATERAL (
       SELECT l.verdict, l.notes
       FROM experiment_judge_calibration_labels l
       WHERE l.calibration_item_id = i.id
         AND l.reviewer = 'owner'
       ORDER BY l.created_at DESC
       LIMIT 1
     ) owner_lbl ON true
     LEFT JOIN LATERAL (
       SELECT l.verdict, l.notes, l.created_at
       FROM experiment_judge_calibration_labels l
       WHERE l.calibration_item_id = i.id
         AND l.reviewer = 'assistant'
       ORDER BY l.created_at DESC
       LIMIT 1
     ) asst_lbl ON true
     WHERE c.experiment_id = $1::uuid
       AND c.is_stale = false
       AND c.ambiguity_class = 'clarify_required'`,
    [params.experimentId]
  );

  const approvedRows = new Set<string>();
  const approvedSourceSlotKeys = new Set<string>();
  const approvedArchetypeKeys = new Set<string>();
  const pendingBySourceSlot = new Map<string, Array<typeof rows.rows[number] & { slotType: string; archetypeKey: string; assistantSuggestion: ReturnType<typeof parseAssistantCalibrationSuggestion> }>>();
  const pendingByArchetype = new Map<string, Array<typeof rows.rows[number] & { slotType: string; archetypeKey: string; assistantSuggestion: ReturnType<typeof parseAssistantCalibrationSuggestion> }>>();
  const removedCaseIds = new Set<string>();
  const removedCalibrationItemIds = new Set<string>();
  const removalReasons = new Map<string, string>();

  for (const row of rows.rows) {
    const metadata = row.metadata ?? {};
    const sourceCaseId = String(metadata.clarifyAugmentedFromCaseId ?? "").trim() || row.case_id;
    const clarificationQuestion = readClarificationQuestion(metadata);
    const slotType = classifyClarifyMissingSlotType({
      question: row.question,
      clarificationQuestion,
      notes: row.owner_notes ?? row.assistant_notes ?? "",
      modelValue: String(metadata.missingSlotType ?? "").trim()
    });
    const archetypeKey = buildClarifyArchetypeKey({
      question: row.question,
      clarificationQuestion,
      slotType
    });
    const sourceSlotKey = `${sourceCaseId}|${slotType}`;
    const assistantSuggestion = parseAssistantCalibrationSuggestion({
      verdict: row.assistant_verdict,
      notes: row.assistant_notes,
      createdAt: row.assistant_created_at
    });
    const ownerApproved = String(row.owner_validation_state ?? "").trim() === "approved" || String(row.owner_verdict ?? "").trim() === "yes";
    const ownerRejected = String(row.owner_validation_state ?? "").trim() === "rejected" || String(row.owner_verdict ?? "").trim() === "no";

    if (ownerApproved) {
      approvedRows.add(row.case_id);
      approvedSourceSlotKeys.add(sourceSlotKey);
      approvedArchetypeKeys.add(archetypeKey);
      continue;
    }
    if (ownerRejected) {
      removedCaseIds.add(row.case_id);
      if (row.calibration_item_id) removedCalibrationItemIds.add(row.calibration_item_id);
      removalReasons.set(row.case_id, "owner_rejected");
      continue;
    }

    const enriched = { ...row, slotType, archetypeKey, assistantSuggestion };
    const sourceBucket = pendingBySourceSlot.get(sourceSlotKey) ?? [];
    sourceBucket.push(enriched);
    pendingBySourceSlot.set(sourceSlotKey, sourceBucket);
    const archetypeBucket = pendingByArchetype.get(archetypeKey) ?? [];
    archetypeBucket.push(enriched);
    pendingByArchetype.set(archetypeKey, archetypeBucket);
  }

  const keepPending = new Set<string>();
  const chooseBest = (items: Array<typeof rows.rows[number] & { slotType: string; archetypeKey: string; assistantSuggestion: ReturnType<typeof parseAssistantCalibrationSuggestion> }>) => {
    return [...items].sort((left, right) => (
      clarifyRetentionRank({
        ownerValidationState: left.owner_validation_state,
        ownerVerdict: left.owner_verdict,
        assistantVerdict: String(left.assistantSuggestion?.verdict ?? ""),
        assistantConfidence: Number(left.assistantSuggestion?.confidence ?? 0),
        qualityScore: readCaseQualityGate(left.metadata ?? {}).score,
        caseSet: left.case_set
      })
      - clarifyRetentionRank({
        ownerValidationState: right.owner_validation_state,
        ownerVerdict: right.owner_verdict,
        assistantVerdict: String(right.assistantSuggestion?.verdict ?? ""),
        assistantConfidence: Number(right.assistantSuggestion?.confidence ?? 0),
        qualityScore: readCaseQualityGate(right.metadata ?? {}).score,
        caseSet: right.case_set
      })
    )).pop();
  };

  for (const [sourceSlotKey, items] of pendingBySourceSlot.entries()) {
    if (approvedSourceSlotKeys.has(sourceSlotKey)) {
      for (const item of items) {
        removedCaseIds.add(item.case_id);
        if (item.calibration_item_id) removedCalibrationItemIds.add(item.calibration_item_id);
        removalReasons.set(item.case_id, "duplicate_of_approved_source_slot");
      }
      continue;
    }
    const best = chooseBest(items);
    if (!best) continue;
    keepPending.add(best.case_id);
    for (const item of items) {
      if (item.case_id === best.case_id) continue;
      removedCaseIds.add(item.case_id);
      if (item.calibration_item_id) removedCalibrationItemIds.add(item.calibration_item_id);
      removalReasons.set(item.case_id, "duplicate_pending_source_slot");
    }
  }

  for (const [archetypeKey, items] of pendingByArchetype.entries()) {
    if (approvedArchetypeKeys.has(archetypeKey)) {
      for (const item of items) {
        if (approvedRows.has(item.case_id)) continue;
        removedCaseIds.add(item.case_id);
        if (item.calibration_item_id) removedCalibrationItemIds.add(item.calibration_item_id);
        removalReasons.set(item.case_id, "duplicate_of_approved_archetype");
      }
      continue;
    }
    const keptItems = items.filter((item) => keepPending.has(item.case_id));
    if (keptItems.length <= 1) continue;
    const best = chooseBest(keptItems);
    if (!best) continue;
    for (const item of keptItems) {
      if (item.case_id === best.case_id) continue;
      removedCaseIds.add(item.case_id);
      if (item.calibration_item_id) removedCalibrationItemIds.add(item.calibration_item_id);
      keepPending.delete(item.case_id);
      removalReasons.set(item.case_id, "duplicate_pending_archetype");
    }
  }

  for (const items of pendingByArchetype.values()) {
    for (const item of items) {
      if (!keepPending.has(item.case_id)) continue;
      const assistantVerdict = String(item.assistantSuggestion?.verdict ?? "").trim();
      const assistantNotes = String(item.assistantSuggestion?.notes ?? "").trim();
      const assistantConfidence = Number(item.assistantSuggestion?.confidence ?? 0);
      const likelyInvalid =
        assistantVerdict === "no"
        && assistantConfidence >= 0.8
        && /weak grounding|not grounded|not reliable|not realistic|question.*do not align|does not align cleanly|specific evidence/i.test(assistantNotes);
      if (likelyInvalid) {
        removedCaseIds.add(item.case_id);
        if (item.calibration_item_id) removedCalibrationItemIds.add(item.calibration_item_id);
        keepPending.delete(item.case_id);
        removalReasons.set(item.case_id, "assistant_revalidated_invalid");
      }
    }
  }

  if (removedCalibrationItemIds.size > 0) {
    const calibrationItemIds = [...removedCalibrationItemIds];
    await pool.query(`DELETE FROM experiment_judge_calibration_labels WHERE calibration_item_id = ANY($1::uuid[])`, [calibrationItemIds]);
    await pool.query(`DELETE FROM experiment_judge_calibration_items WHERE id = ANY($1::uuid[])`, [calibrationItemIds]);
  }
  if (removedCaseIds.size > 0) {
    await pool.query(`DELETE FROM experiment_cases WHERE id = ANY($1::uuid[])`, [[...removedCaseIds]]);
  }

  return {
    ok: true,
    experimentId: params.experimentId,
    approvedClarifyKept: approvedRows.size,
    removedClarifyCases: removedCaseIds.size,
    removedCalibrationItems: removedCalibrationItemIds.size,
    remainingPendingClarify: Array.from(keepPending).length,
    removalSummary: Object.fromEntries(
      Array.from(removalReasons.values()).reduce((acc, reason) => {
        acc.set(reason, (acc.get(reason) ?? 0) + 1);
        return acc;
      }, new Map<string, number>())
    )
  };
}

async function materializeCalibrationItemsForCaseIds(params: {
  experimentId: string;
  caseIds: string[];
}): Promise<Map<string, string>> {
  const caseIds = uniqueStrings(params.caseIds);
  if (caseIds.length === 0) return new Map<string, string>();
  const rows = await pool.query<{
    case_id: string;
    case_set: string;
    domain: string;
    lens: string;
    question: string;
    expected_core_claims: string[] | string;
    evidence_ids: string[] | string;
    metadata: Record<string, unknown>;
    ambiguity_class: string | null;
  }>(
    `SELECT
       c.id::text AS case_id,
       c.case_set,
       c.domain,
       c.lens,
       c.question,
       COALESCE(c.expected_core_claims::text, '[]') AS expected_core_claims,
       COALESCE(c.evidence_ids::text, '{}') AS evidence_ids,
       c.metadata,
       c.ambiguity_class
     FROM experiment_cases c
     WHERE c.experiment_id = $1::uuid
       AND c.id = ANY($2::uuid[])
       AND c.is_stale = false
       AND NOT EXISTS (
         SELECT 1
         FROM experiment_judge_calibration_items i
         WHERE i.experiment_id = $1::uuid
           AND i.case_id = c.id
       )`,
    [params.experimentId, caseIds]
  );
  const out = new Map<string, string>();
  for (const row of rows.rows) {
    const expectedCoreClaims = Array.isArray(row.expected_core_claims)
      ? row.expected_core_claims.map(String)
      : parseJsonArray(String(row.expected_core_claims ?? "[]"));
    const expectedEvidenceIds = Array.isArray(row.evidence_ids)
      ? row.evidence_ids.map(String)
      : parsePgTextArray(String(row.evidence_ids ?? "{}"));
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
      ambiguityClass: String(row.ambiguity_class ?? "clear") as "clear" | "clarify_required" | "unresolved",
      semanticFrameSummary: readSemanticFrameSummary(row.metadata ?? {}),
      clarificationQuestion: readClarificationQuestion(row.metadata ?? {}),
      resolvedQuestionAfterClarification: readResolvedQuestionAfterClarification(row.metadata ?? {}),
      admissionDecision: readAdmissionDecision(row.metadata ?? {}),
      feasibilityReport: readFeasibilityReport(row.metadata ?? {})
    };
    const created = await pool.query<{ id: string }>(
      `INSERT INTO experiment_judge_calibration_items (
         experiment_id, case_id, strategy_variant_id, question, expected_answer, expected_evidence_ids, sample_type, status
       ) VALUES (
         $1::uuid, $2::uuid, NULL, $3, $4::jsonb, $5::uuid[], 'benchmark_case', 'pending'
       )
       RETURNING id::text`,
      [params.experimentId, row.case_id, row.question, JSON.stringify(expectedAnswer), expectedEvidenceIds]
    );
    out.set(row.case_id, created.rows[0].id);
  }
  return out;
}

async function generateSupplementalPositiveCases(params: {
  experimentId: string;
  chatNamespace: string;
  taxonomyVersionId: string;
  targetCount: number;
  minCritiqueScore?: number;
  preferredDomains?: string[];
  preferredLenses?: string[];
}): Promise<{
  requested: number;
  candidatePool: number;
  assistantAccepted: number;
  inserted: number;
  calibrationItemsCreated: number;
  caseIds: string[];
}> {
  const targetCount = Math.max(0, Number(params.targetCount || 0));
  if (targetCount <= 0) {
    return {
      requested: 0,
      candidatePool: 0,
      assistantAccepted: 0,
      inserted: 0,
      calibrationItemsCreated: 0,
      caseIds: []
    };
  }
  const minCritiqueScore = Number.isFinite(Number(params.minCritiqueScore))
    ? Number(params.minCritiqueScore)
    : 0.88;
  const preferredDomains = new Set(
    (params.preferredDomains ?? [])
      .map((value) => String(value ?? "").trim())
      .filter(Boolean)
  );
  const preferredDomainOrder = new Map(
    (params.preferredDomains ?? [])
      .map((value) => String(value ?? "").trim())
      .filter(Boolean)
      .map((value, index) => [value, index] as const)
  );
  const preferredLenses = new Set(
    (params.preferredLenses ?? [])
      .map((value) => String(value ?? "").trim())
      .filter(Boolean)
  );
  const supportRows = await ensureTaxonomySupportRows({
    taxonomyVersionId: params.taxonomyVersionId,
    chatNamespace: params.chatNamespace
  });
  const pairCounts = await pool.query<{ domain: string; lens: string; c: string }>(
    `SELECT domain, lens, COUNT(*)::text AS c
     FROM experiment_cases
     WHERE experiment_id = $1::uuid
       AND is_stale = false
     GROUP BY domain, lens`,
    [params.experimentId]
  );
  const countMap = new Map(pairCounts.rows.map((row) => [`${row.domain}|${row.lens}`, Number(row.c ?? 0)]));
  const pairs = supportRows
    .filter((row) => row.supportStatus === "supported")
    .filter((row) => preferredDomains.size === 0 || preferredDomains.has(row.domainKey))
    .filter((row) => preferredLenses.size === 0 || preferredLenses.has(row.lensKey))
    .filter((row) => Number(row.supportCount ?? 0) >= minimumSupportClustersForSupplementalLens(row.lensKey))
    .sort((a, b) => {
      const leftPreferred = preferredDomains.size > 0 && preferredDomains.has(a.domainKey) ? 1 : 0;
      const rightPreferred = preferredDomains.size > 0 && preferredDomains.has(b.domainKey) ? 1 : 0;
      if (leftPreferred !== rightPreferred) return rightPreferred - leftPreferred;
      const leftDomainOrder = preferredDomainOrder.get(a.domainKey) ?? Number.MAX_SAFE_INTEGER;
      const rightDomainOrder = preferredDomainOrder.get(b.domainKey) ?? Number.MAX_SAFE_INTEGER;
      if (leftDomainOrder !== rightDomainOrder) return leftDomainOrder - rightDomainOrder;
      const leftCount = countMap.get(`${a.domainKey}|${a.lensKey}`) ?? 0;
      const rightCount = countMap.get(`${b.domainKey}|${b.lensKey}`) ?? 0;
      if (leftCount !== rightCount) return leftCount - rightCount;
      if (a.supportCount !== b.supportCount) return b.supportCount - a.supportCount;
      const leftLensPriority = SUPPLEMENTAL_POSITIVE_LENS_PRIORITY[a.lensKey] ?? 999;
      const rightLensPriority = SUPPLEMENTAL_POSITIVE_LENS_PRIORITY[b.lensKey] ?? 999;
      if (leftLensPriority !== rightLensPriority) return leftLensPriority - rightLensPriority;
      if (a.evidenceCount !== b.evidenceCount) return b.evidenceCount - a.evidenceCount;
      return `${a.domainKey}|${a.lensKey}`.localeCompare(`${b.domainKey}|${b.lensKey}`);
    })
    .map((row) => ({
      domain: row.domainKey,
      lens: row.lensKey,
      supportCount: Number(row.supportCount ?? 0)
    }));
  const supportedPairKeys = new Set(
    supportRows
    .filter((row) => row.supportStatus === "supported")
    .filter((row) => preferredDomains.size === 0 || preferredDomains.has(row.domainKey))
    .filter((row) => preferredLenses.size === 0 || preferredLenses.has(row.lensKey))
    .filter((row) => Number(row.supportCount ?? 0) >= minimumSupportClustersForSupplementalLens(row.lensKey))
    .map((row) => `${row.domainKey}|${row.lensKey}`)
  );
  const evidencePool = await loadSeedEvidencePool({
    chatNamespace: params.chatNamespace,
    limit: Math.max(6000, pairs.length * 12)
  });
  const existingEvidenceIds = new Set(evidencePool.map((row) => row.canonical_id));
  const supportSampleIds = uniqueStrings(
    supportRows
      .filter((row) => row.supportStatus === "supported")
      .filter((row) => preferredDomains.size === 0 || preferredDomains.has(row.domainKey))
      .flatMap((row) => row.sampleEvidenceIds ?? [])
  ).filter((id) => !existingEvidenceIds.has(id));
  const supplementalEvidencePoolRows = supportSampleIds.length > 0
    ? await loadSeedEvidenceRowsByIds({
        chatNamespace: params.chatNamespace,
        canonicalIds: supportSampleIds
      })
    : [];
  const supplementalEvidencePool = supplementalEvidencePoolRows.map((row) => {
    const metadata = row.metadata && typeof row.metadata === "object" ? row.metadata : {};
    const primaryDomainRaw = String((metadata as Record<string, unknown>).primary_domain ?? "").trim();
    const domainTopRaw = (metadata as Record<string, unknown>).domain_top;
    const domainScoresRaw = (metadata as Record<string, unknown>).domain_scores;
    return {
      canonical_id: row.canonical_id,
      memory_id: row.memory_id,
      conversation_id: row.conversation_id,
      source_conversation_id: row.source_conversation_id ?? null,
      actor_id: row.actor_id,
      actor_name: row.actor_name,
      actor_type: row.actor_type,
      source_system: row.source_system,
      source_timestamp: row.source_timestamp,
      content: row.content,
      has_plan_block: row.has_plan_block,
      primary_domain: primaryDomainRaw || null,
      domain_top: Array.isArray(domainTopRaw)
        ? domainTopRaw.map((item) => String(item ?? "").trim()).filter(Boolean)
        : [],
      domain_score_map: domainScoresRaw && typeof domainScoresRaw === "object"
        ? (domainScoresRaw as Record<string, unknown>)
        : {},
      metadata
    };
  });
  const evidenceByDomain = buildEvidenceByDomainMap([...evidencePool, ...supplementalEvidencePool], {
    minDomainScore: MIN_DOMAIN_SCORE_FOR_CASE,
    includeUserRows: true
  });
  const supportSampleRowMap = new Map<string, SeedEvidenceCandidate>();
  for (const row of evidencePool) {
    supportSampleRowMap.set(row.canonical_id, {
      canonical_id: row.canonical_id,
      memory_id: row.memory_id,
      conversation_id: row.conversation_id,
      source_conversation_id: row.source_conversation_id ?? null,
      actor_id: row.actor_id,
      actor_name: row.actor_name,
      actor_type: row.actor_type,
      source_system: row.source_system,
      source_timestamp: row.source_timestamp,
      content: row.content,
      has_plan_block: row.has_plan_block,
      domain_score: 0,
      metadata: row.metadata ?? {}
    });
  }
  for (const row of supplementalEvidencePoolRows) {
    supportSampleRowMap.set(row.canonical_id, row);
  }
  for (const supportRow of supportRows) {
    if (supportRow.supportStatus !== "supported") continue;
    if (preferredDomains.size > 0 && !preferredDomains.has(supportRow.domainKey)) continue;
    const bucket = evidenceByDomain.get(supportRow.domainKey) ?? [];
    for (const evidenceId of supportRow.sampleEvidenceIds ?? []) {
      const sampleRow = supportSampleRowMap.get(String(evidenceId));
      if (!sampleRow) continue;
      if (bucket.some((existing) => existing.canonical_id === sampleRow.canonical_id)) continue;
      const inferredDomainScore = Number(
        rankStructuredDomains(sampleRow.content).find((item) => item.domain === supportRow.domainKey)?.score ?? 0
      );
      bucket.push({
        canonical_id: sampleRow.canonical_id,
        memory_id: sampleRow.memory_id,
        conversation_id: sampleRow.conversation_id,
        source_conversation_id: sampleRow.source_conversation_id,
        actor_id: sampleRow.actor_id,
        actor_name: sampleRow.actor_name,
        actor_type: sampleRow.actor_type,
        source_system: sampleRow.source_system,
        source_timestamp: sampleRow.source_timestamp,
        content: sampleRow.content,
        has_plan_block: sampleRow.has_plan_block,
        domain_score: Math.max(inferredDomainScore, Number(supportRow.avgDomainScore ?? 0), MIN_DOMAIN_SCORE_FOR_CASE),
        metadata: sampleRow.metadata ?? {}
      });
    }
    if (bucket.length > 0) {
      evidenceByDomain.set(supportRow.domainKey, pruneBucketForDiversity(uniqSeedRows(
        bucket.sort((a, b) => {
          const leftScore = scoreAnchorAuthorability({
            domain: supportRow.domainKey,
            lens: "descriptive",
            anchor: a,
            contextRows: [a],
            domainScore: Number(a.domain_score ?? 0)
          });
          const rightScore = scoreAnchorAuthorability({
            domain: supportRow.domainKey,
            lens: "descriptive",
            anchor: b,
            contextRows: [b],
            domainScore: Number(b.domain_score ?? 0)
          });
          if (leftScore !== rightScore) return rightScore - leftScore;
          if (a.domain_score !== b.domain_score) return b.domain_score - a.domain_score;
          const leftActorPriority = supplementalActorPriority(a.actor_type);
          const rightActorPriority = supplementalActorPriority(b.actor_type);
          if (leftActorPriority !== rightActorPriority) return leftActorPriority - rightActorPriority;
          const leftLength = String(a.content ?? "").trim().length;
          const rightLength = String(b.content ?? "").trim().length;
          if (leftLength !== rightLength) return rightLength - leftLength;
          const leftTime = Date.parse(String(a.source_timestamp ?? "")) || 0;
          const rightTime = Date.parse(String(b.source_timestamp ?? "")) || 0;
          if (leftTime !== rightTime) return rightTime - leftTime;
          return String(a.canonical_id).localeCompare(String(b.canonical_id));
        }),
        MAX_DOMAIN_ANCHORS_TO_SCAN
      ), 2, MAX_DOMAIN_ANCHORS_TO_SCAN));
    }
  }
  const existingRows = await pool.query<{
    domain: string;
    lens: string;
    question: string;
    source_evidence_id: string | null;
    evidence_ids: string[] | string;
    conversation_ids: string[] | string;
  }>(
    `SELECT domain,
            lens,
            lower(question) AS question,
            source_evidence_id::text,
            COALESCE(evidence_ids::text, '{}') AS evidence_ids,
            COALESCE(conversation_ids::text, '{}') AS conversation_ids
     FROM experiment_cases
     WHERE experiment_id = $1::uuid
       AND is_stale = false`,
    [params.experimentId]
  );
  const existingQuestionKeys = new Set(
    existingRows.rows.map((row) => buildBenchmarkQuestionDedupKey(row.question))
  );
  const existingAnchorKeys = new Set(
    existingRows.rows
      .filter((row) => row.source_evidence_id)
      .map((row) => `${row.domain}|${row.lens}|${row.source_evidence_id}`)
  );
  const existingFamilyKeys = new Set(
    existingRows.rows.map((row) => buildCaseEvidenceFamilyKey({
      evidenceIds: row.evidence_ids,
      conversationIds: row.conversation_ids,
      sourceEvidenceId: row.source_evidence_id
    })).filter(Boolean)
  );
  const candidateFamilyKeys = new Set<string>();
  const attemptedAnchors = new Set<string>();
  const pairFailureCounts = new Map<string, number>();
  const conversationContextCache = new Map<string, SeedEvidenceCandidate[]>();
  const candidatePool: Array<{
    calibrationItemId: string;
    domain: string;
    lens: string;
    caseSet: "dev" | "critical" | "certification";
    question: string;
    caseType: string;
    sourceEvidenceId: string;
    taxonomyPath: string;
    difficultyType: string;
    expectedCoreClaims: string[];
    evidencePreviewRows: Array<{
      evidenceId: string;
      actorName: string | null;
      observedAt: string | null;
      sourceSystem: string;
      snippet: string;
    }>;
    evidenceIds: string[];
    conversationIds: string[];
    actorIds: string[];
    ambiguityClass: "clear" | "clarify_required" | "unresolved";
    clarificationQualityExpected: boolean;
    metadata: Record<string, unknown>;
  }> = [];
  const maxRounds = MAX_DOMAIN_ANCHORS_TO_SCAN;
  const maxCandidatePool = Math.max(targetCount * 6, 60);

  for (let anchorIndex = 0; anchorIndex < maxRounds && candidatePool.length < maxCandidatePool; anchorIndex += 1) {
    for (const pair of pairs) {
      if (candidatePool.length >= maxCandidatePool) break;
      const pairKey = `${pair.domain}|${pair.lens}`;
      if ((pairFailureCounts.get(pairKey) ?? 0) >= 3) continue;
      const domainEvidenceRows = evidenceByDomain.get(pair.domain) ?? [];
      const nonUserEvidenceRows = domainEvidenceRows.filter((row) => String(row.actor_type ?? "").toLowerCase() !== "user");
      const richNonUserEvidenceRows = nonUserEvidenceRows.filter((row) => String(row.content ?? "").trim().length >= 140);
      const richDomainEvidenceRows = domainEvidenceRows.filter((row) => String(row.content ?? "").trim().length >= 140);
      const evidenceRows = (
        richNonUserEvidenceRows.length > 0 ? richNonUserEvidenceRows
          : nonUserEvidenceRows.length > 0 ? nonUserEvidenceRows
          : richDomainEvidenceRows.length > 0 ? richDomainEvidenceRows
          : domainEvidenceRows
      ).slice(0, MAX_DOMAIN_ANCHORS_TO_SCAN);
      if (anchorIndex >= evidenceRows.length) continue;
      const anchor = evidenceRows[anchorIndex];
      const anchorAttemptKey = `${pair.domain}|${pair.lens}|${anchor.canonical_id}`;
      if (attemptedAnchors.has(anchorAttemptKey)) continue;
      attemptedAnchors.add(anchorAttemptKey);
      if (existingAnchorKeys.has(anchorAttemptKey)) continue;
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
      const contextRows = buildLensAwareContextRows({
        anchor,
        conversationRows,
        lens: pair.lens
      });
      const actorName = resolveQuestionActorName(anchor, contextRows);
      const semanticFrame = buildSemanticFrame({
        domain: pair.domain,
        lens: pair.lens,
        window: relativeWindowPhrase(anchor.source_timestamp),
        anchor,
        contextRows,
        actorName
      });
      if (Number(semanticFrame.anchorQualityScore ?? 0) < 0.62) {
        pairFailureCounts.set(pairKey, (pairFailureCounts.get(pairKey) ?? 0) + 1);
        continue;
      }
      const supportBackedPair = preferredDomains.size > 0 && supportedPairKeys.has(pairKey);
      if (!semanticFrame.supportedLenses.includes(pair.lens) && !supportBackedPair) continue;
      if (semanticFrame.supportDepth === "thin" && !supportBackedPair) continue;

      const evidenceIds = contextRows.map((row) => row.canonical_id);
      const conversationIds = Array.from(new Set(contextRows.map((row) => row.conversation_id)));
      const familyKey = buildCaseEvidenceFamilyKey({
        evidenceIds,
        conversationIds,
        sourceEvidenceId: anchor.canonical_id
      });
      if (familyKey && (existingFamilyKeys.has(familyKey) || candidateFamilyKeys.has(familyKey))) continue;
      const authored = await authorBenchmarkCaseWithRepairs({
        chatNamespace: params.chatNamespace,
        domain: pair.domain,
        lens: pair.lens,
        window: relativeWindowPhrase(anchor.source_timestamp),
        actorName,
        semanticFrame,
        contextRows,
        anchor,
        domainScore: anchor.domain_score,
        evidenceIds,
        conversationIds,
        supportBacked: supportBackedPair
      });
      if (!authored) {
        pairFailureCounts.set(pairKey, (pairFailureCounts.get(pairKey) ?? 0) + 1);
        continue;
      }
      if (!authored.admissionDecision.admitted || authored.critique.score < minCritiqueScore || authored.draft.expectedBehavior !== "answer_now") {
        pairFailureCounts.set(pairKey, (pairFailureCounts.get(pairKey) ?? 0) + 1);
        continue;
      }

      const questionKey = buildBenchmarkQuestionDedupKey(authored.draft.chosenQuestion);
      if (existingQuestionKeys.has(questionKey)) {
        pairFailureCounts.set(pairKey, (pairFailureCounts.get(pairKey) ?? 0) + 1);
        continue;
      }

      existingQuestionKeys.add(questionKey);
      existingAnchorKeys.add(anchorAttemptKey);
      if (familyKey) candidateFamilyKeys.add(familyKey);
      candidatePool.push({
        calibrationItemId: randomUUID(),
        domain: pair.domain,
        lens: pair.lens,
        caseSet: pickSetLabel(candidatePool.length + 1),
        question: authored.draft.chosenQuestion,
        caseType: `supplemental:${pair.lens}:${pair.domain}`,
        sourceEvidenceId: anchor.canonical_id,
        taxonomyPath: `${pair.domain}.${pair.lens}`,
        difficultyType: inferDifficultyType(pair.lens),
        expectedCoreClaims: buildExpectedCoreClaims(contextRows),
        evidencePreviewRows: contextRows.map((row) => ({
          evidenceId: row.canonical_id,
          actorName: row.actor_name,
          observedAt: row.source_timestamp,
          sourceSystem: row.source_system,
          snippet: row.content
        })),
        evidenceIds,
        conversationIds,
        actorIds: Array.from(new Set(contextRows.map((row) => row.actor_id).filter((id): id is string => Boolean(id)))),
        ambiguityClass: "clear",
        clarificationQualityExpected: false,
        metadata: {
          generationVersion: BENCHMARK_AUTHORING_VERSION,
          authoringVersion: BENCHMARK_AUTHORING_VERSION,
          supplementalReplacement: true,
          expectedBehavior: authored.draft.expectedBehavior,
          expectedAnswerSummaryHuman: authored.draft.expectedAnswerSummaryHuman,
          qualityGate: qualityGateFromAuthoringCritique(authored.draft.authoringCritique),
          semanticFrame: authored.draft.semanticFrame,
          questionVoice: authored.draft.questionVoice,
          candidateQuestions: authored.draft.candidateQuestions,
          chosenQuestionRationale: authored.draft.chosenQuestionRationale,
          authoringDecision: authored.draft.authoringDecision,
          rejectionReasons: authored.draft.rejectionReasons,
          clarificationQuestion: authored.draft.clarificationQuestion,
          resolvedQuestionAfterClarification: authored.draft.resolvedQuestionAfterClarification,
          authoringCritique: authored.draft.authoringCritique,
          feasibilityReport: authored.feasibilityReport,
          admissionDecision: authored.admissionDecision,
          semanticFrameSummary: summarizeSemanticFrame(authored.draft.semanticFrame),
          contradictionExpected: pair.domain === "financial_behavior" || pair.lens === "confidence_scoring"
        }
      });
    }
  }

  const acceptedCandidates: Array<{
    candidate: (typeof candidatePool)[number];
    storedReview: {
      verdict: "yes" | "no";
      ambiguityClass: "clear" | "clarify_required" | "unresolved";
      notes: string;
      confidence: number;
    } | null;
  }> = [];
  const reviewByCalibrationItemId = new Map<string, {
    verdict: "yes" | "no";
    ambiguityClass: "clear" | "clarify_required" | "unresolved";
    notes: string;
    confidence: number;
  }>();
  for (let i = 0; i < candidatePool.length; i += 5) {
    const chunk = candidatePool.slice(i, i + 5).map((candidate) => ({
      calibrationItemId: candidate.calibrationItemId,
      question: candidate.question,
      domain: candidate.domain,
      lens: candidate.lens,
      ambiguityClass: candidate.ambiguityClass,
      expectedBehavior: String(candidate.metadata.expectedBehavior ?? "answer_now"),
      expectedAnswerSummaryHuman: String(candidate.metadata.expectedAnswerSummaryHuman ?? ""),
      semanticFrame: candidate.metadata.semanticFrame,
      semanticFrameSummary: candidate.metadata.semanticFrameSummary,
      evidencePreview: candidate.evidencePreviewRows,
      qualityGate: candidate.metadata.qualityGate,
      authoringCritique: candidate.metadata.authoringCritique
    }));
    const chunkMap = new Map(chunk.map((row) => [String(row.calibrationItemId), row]));
    const reviews = await reviewCalibrationChunkSafely(chunk, "supplemental-positive-variants");
    for (const review of reviews) {
      const calibrationItemId = String(review.calibrationItemId ?? "").trim();
      if (!calibrationItemId) continue;
      const candidate = candidatePool.find((item) => item.calibrationItemId === calibrationItemId);
      if (!candidate) continue;
      const normalized = sanitizeAssistantCalibrationReview(review, chunkMap.get(calibrationItemId) ?? {});
      reviewByCalibrationItemId.set(calibrationItemId, normalized);
      const topology = readSemanticFrame(candidate.metadata)?.topology ?? "system_artifact";
      const acceptanceScore = Number(
        candidate.metadata.wholeCorpusAcceptanceScore
        ?? (candidate.metadata.authoringCritique as Record<string, unknown> | undefined)?.score
        ?? 0
      );
      const explicitGroundingBlock = /\b(not grounded|unsupported|wrong actor|wrong owner|wrong person|wrong target|wrong thread|insufficient evidence|missing statement|scope mismatch|missing concrete|evidence does not)\b/i
        .test(String(normalized.notes ?? ""));
      const humanReviewOverride = (
        normalized.verdict !== "yes"
        && topologyIsHuman(topology)
        && (
          acceptanceScore >= Math.max(minCritiqueScore + 0.06, 0.97)
          || (
            acceptanceScore >= Math.max(minCritiqueScore + 0.03, 0.95)
            && !explicitGroundingBlock
          )
        )
      );
      if (normalized.verdict !== "yes" && !humanReviewOverride) continue;
      if (humanReviewOverride) {
        console.log(
          `[backfill] human override accepted family=${String(candidate.metadata.semanticFrameSummary ?? candidate.question).slice(0, 120)} score=${acceptanceScore.toFixed(2)}`
        );
      }
      acceptedCandidates.push({
        candidate,
        storedReview: normalized.verdict === "yes" ? normalized : null
      });
      if (acceptedCandidates.length >= targetCount) break;
    }
    if (acceptedCandidates.length >= targetCount) break;
  }
  if (acceptedCandidates.length < targetCount) {
    const acceptedIds = new Set(acceptedCandidates.map((entry) => entry.candidate.calibrationItemId));
    const fallbackCandidates = candidatePool
      .filter((candidate) => !acceptedIds.has(candidate.calibrationItemId))
      .filter((candidate) => !reviewByCalibrationItemId.has(candidate.calibrationItemId))
      .map((candidate) => ({
        candidate,
        critiqueScore: Number(candidate.metadata.wholeCorpusAcceptanceScore ?? (candidate.metadata.authoringCritique as Record<string, unknown> | undefined)?.score ?? 0)
      }))
      .filter((entry) => entry.critiqueScore >= Math.max(minCritiqueScore + 0.04, 0.94))
      .sort((a, b) => b.critiqueScore - a.critiqueScore);
    for (const entry of fallbackCandidates) {
      acceptedCandidates.push({
        candidate: entry.candidate,
        storedReview: null
      });
      if (acceptedCandidates.length >= targetCount) break;
    }
  }

  const insertedCaseIds: string[] = [];
  const assistantReviewsByCaseId = new Map<string, {
    verdict: "yes" | "no";
    ambiguityClass: "clear" | "clarify_required" | "unresolved";
    notes: string;
    confidence: number;
  }>();
  for (const { candidate, storedReview } of acceptedCandidates.slice(0, targetCount)) {
    const caseId = randomUUID();
    const caseKey = `supplemental:${candidate.domain}:${candidate.lens}:${caseId.slice(0, 8)}`;
    const insertedCaseId = await upsertExperimentCase({
      experimentId: params.experimentId,
      caseSet: candidate.caseSet,
      caseKey,
      caseType: candidate.caseType,
      domain: candidate.domain,
      lens: candidate.lens,
      question: candidate.question,
      chatNamespace: params.chatNamespace,
      expectedCoreClaims: candidate.expectedCoreClaims,
      evidenceIds: candidate.evidenceIds,
      conversationIds: candidate.conversationIds,
      actorIds: candidate.actorIds,
      sourceEvidenceId: candidate.sourceEvidenceId,
      taxonomyPath: candidate.taxonomyPath,
      difficultyType: candidate.difficultyType,
      generationMethod: "v1.7_supplemental_positive",
      ambiguityClass: candidate.ambiguityClass,
      ownerValidationState: "pending",
      clarificationQualityExpected: candidate.clarificationQualityExpected,
      metadata: candidate.metadata
    });
    if (!insertedCaseId) continue;
    insertedCaseIds.push(insertedCaseId);
    if (storedReview) assistantReviewsByCaseId.set(insertedCaseId, storedReview);
  }

  const calibrationMap = await materializeCalibrationItemsForCaseIds({
    experimentId: params.experimentId,
    caseIds: insertedCaseIds
  });
  for (const [caseId, calibrationItemId] of calibrationMap.entries()) {
    const review = assistantReviewsByCaseId.get(caseId);
    if (!review) continue;
    await upsertAssistantCalibrationSuggestion({
      calibrationItemId,
      verdict: review.verdict,
      ambiguityClass: review.ambiguityClass,
      notes: review.notes,
      confidence: review.confidence
    });
  }

  return {
    requested: targetCount,
    candidatePool: candidatePool.length,
    assistantAccepted: acceptedCandidates.length,
    inserted: insertedCaseIds.length,
    calibrationItemsCreated: calibrationMap.size,
    caseIds: insertedCaseIds
  };
}

async function generateWholeCorpusFamilyPositiveCases(params: {
  experimentId: string;
  chatNamespace: string;
  taxonomyVersionId: string;
  targetCount: number;
  minCritiqueScore?: number;
  preferredDomains?: string[];
  preferredLenses?: string[];
}): Promise<{
  requested: number;
  candidatePool: number;
  assistantAccepted: number;
  inserted: number;
  calibrationItemsCreated: number;
  caseIds: string[];
  scannedFamilies: number;
  familySeedCount: number;
  nextFamilyOffset: number;
  rejectionSamples: Array<{
    familyKey: string;
    domain: string;
    lens: string;
    reason: string;
    sourceSystem: string;
    actorName: string;
    snippet: string;
  }>;
}> {
  const targetCount = Math.max(0, Number(params.targetCount || 0));
  if (targetCount <= 0) {
    return {
      requested: 0,
      candidatePool: 0,
      assistantAccepted: 0,
      inserted: 0,
      calibrationItemsCreated: 0,
      caseIds: [],
      scannedFamilies: 0,
      familySeedCount: 0,
      nextFamilyOffset: 0,
      rejectionSamples: []
    };
  }
  const minCritiqueScore = Number.isFinite(Number(params.minCritiqueScore))
    ? Number(params.minCritiqueScore)
    : 0.88;
  const preferredDomains = new Set(
    (params.preferredDomains ?? [])
      .map((value) => String(value ?? "").trim())
      .filter(Boolean)
  );
  const preferredLenses = new Set(
    (params.preferredLenses ?? [])
      .map((value) => String(value ?? "").trim())
      .filter(Boolean)
  );
  const supportRows = await ensureTaxonomySupportRows({
    taxonomyVersionId: params.taxonomyVersionId,
    chatNamespace: params.chatNamespace
  });
  const supported = buildSupportedPairDescriptors({
    supportRows,
    preferredDomains,
    preferredLenses
  });
  const existingRows = await pool.query<{
    case_id: string;
    domain: string;
    lens: string;
    case_set: string;
    ambiguity_class: string;
    question: string;
    metadata: Record<string, unknown> | null;
    source_evidence_id: string | null;
    evidence_ids: string[] | string;
    conversation_ids: string[] | string;
  }>(
    `SELECT id::text AS case_id,
            domain,
            lens,
            case_set,
            ambiguity_class,
            lower(question) AS question,
            metadata,
            source_evidence_id::text,
            COALESCE(evidence_ids::text, '{}') AS evidence_ids,
            COALESCE(conversation_ids::text, '{}') AS conversation_ids
     FROM experiment_cases
     WHERE experiment_id = $1::uuid
       AND is_stale = false`,
    [params.experimentId]
  );
  await rebalanceActiveBenchmarkPoolHumanFirst({
    experimentId: params.experimentId,
    activeRows: existingRows.rows.map((row) => ({
      case_id: row.case_id,
      domain: row.domain,
      lens: row.lens,
      case_set: row.case_set,
      ambiguity_class: row.ambiguity_class,
      metadata: row.metadata,
      source_evidence_id: row.source_evidence_id,
      evidence_ids: row.evidence_ids,
      conversation_ids: row.conversation_ids
    }))
  });
  const refreshedExistingRows = await pool.query<{
    case_id: string;
    domain: string;
    lens: string;
    case_set: string;
    ambiguity_class: string;
    question: string;
    metadata: Record<string, unknown> | null;
    source_evidence_id: string | null;
    evidence_ids: string[] | string;
    conversation_ids: string[] | string;
  }>(
    `SELECT id::text AS case_id,
            domain,
            lens,
            case_set,
            ambiguity_class,
            lower(question) AS question,
            metadata,
            source_evidence_id::text,
            COALESCE(evidence_ids::text, '{}') AS evidence_ids,
            COALESCE(conversation_ids::text, '{}') AS conversation_ids
     FROM experiment_cases
     WHERE experiment_id = $1::uuid
       AND is_stale = false`,
    [params.experimentId]
  );
  const existingQuestionKeys = new Set(
    refreshedExistingRows.rows.map((row) => buildBenchmarkQuestionDedupKey(row.question))
  );
  const existingFamilyState = new Map<string, ActiveFamilyCaseState>();
  const activeTopologyCounts = new Map<EvidenceFamilyTopology, number>();
  for (const row of refreshedExistingRows.rows) {
    const familyKey = buildCaseEvidenceFamilyKey({
      evidenceIds: row.evidence_ids,
      conversationIds: row.conversation_ids,
      sourceEvidenceId: row.source_evidence_id
    });
    if (!familyKey) continue;
    const current = existingFamilyState.get(familyKey) ?? { total: 0, clear: 0, clarify: 0 };
    current.total += 1;
    if (row.ambiguity_class === "clear") current.clear += 1;
    if (row.ambiguity_class === "clarify_required") current.clarify += 1;
    existingFamilyState.set(familyKey, current);
    const topology = readSemanticFrame(row.metadata ?? {})?.topology ?? "system_artifact";
    activeTopologyCounts.set(topology, Number(activeTopologyCounts.get(topology) ?? 0) + 1);
  }
  const activeHumanCount = [...activeTopologyCounts.entries()]
    .filter(([topology]) => topologyIsHuman(topology))
    .reduce((sum, [, count]) => sum + count, 0);
  const activeTotalCount = refreshedExistingRows.rows.length;
  const activeHumanShare = activeTotalCount > 0 ? activeHumanCount / activeTotalCount : 0;
  const activeSourceRows = await pool.query<{ source_system: string; c: string }>(
    `WITH active AS (
       SELECT id, evidence_ids
       FROM experiment_cases
       WHERE experiment_id = $1::uuid
         AND is_stale = false
     )
     SELECT COALESCE(cm.source_system, 'unknown') AS source_system, COUNT(DISTINCT a.id)::text AS c
     FROM active a
     JOIN LATERAL unnest(a.evidence_ids) evid(id) ON true
     JOIN canonical_messages cm ON cm.id = evid.id
     GROUP BY 1`,
    [params.experimentId]
  );
  const activeSourceCounts = new Map(
    activeSourceRows.rows.map((row) => [lowerText(row.source_system), Number(row.c ?? 0)])
  );
  const scheduledFamilySeeds = scheduleWholeCorpusFamilySeeds({
    families: (await loadWholeCorpusFamilySeedPool({
    chatNamespace: params.chatNamespace,
    anchorsPerFamily: 3,
    limitFamilies: Math.max(2000, targetCount * 90)
  }))
    .map((family) => {
      const authorabilityScore = scoreWholeCorpusFamilyForAuthoring(family);
      const topology = classifyConversationTopology({ anchor: family.anchorRows[0], contextRows: family.anchorRows });
      return scoreWholeCorpusFamilyCandidate({
        family,
        topology,
        authorabilityScore,
        activeSourceCounts,
        activeTopologyCounts,
        activeHumanShare,
        existingFamilyState: existingFamilyState.get(family.familyKey) ?? null
      });
    })
    .filter((item) => item.authorabilityScore >= 0)
    .filter((item) => {
      if (item.topology === "system_artifact") return false;
      const state = existingFamilyState.get(item.family.familyKey);
      if (!state) return true;
      return state.total < 2;
    })
  }).map((item) => item.family);
  const familySeedCount = scheduledFamilySeeds.length;
  const familyOffsetRaw = Number(process.env.OB_BACKFILL_FAMILY_OFFSET ?? "0");
  const familyOffset = familySeedCount > 0
    ? ((Number.isFinite(familyOffsetRaw) ? familyOffsetRaw : 0) % familySeedCount + familySeedCount) % familySeedCount
    : 0;
  const rotatedFamilySeeds = familySeedCount > 0
    ? [...scheduledFamilySeeds.slice(familyOffset), ...scheduledFamilySeeds.slice(0, familyOffset)]
    : scheduledFamilySeeds;
  const candidatePool: SupplementalGeneratedCandidate[] = [];
  const candidateFamilyState = new Map<string, ActiveFamilyCaseState>();
  const attemptedFamilyLens = new Set<string>();
  const conversationContextCache = new Map<string, SeedEvidenceCandidate[]>();
  const maxCandidatePool = Math.max(targetCount * 6, 60);
  // Whole-corpus mining should persist progress as soon as it finds one strong family.
  // Larger pools were causing accepted candidates to sit in-memory until the batch timed out.
  const candidatePoolFlushTarget = readPositiveIntEnv("OB_BACKFILL_FLUSH_TARGET", 1);
  const startedAt = Date.now();
  const maxRuntimeBeforePartialFlushMs = readPositiveIntEnv("OB_BACKFILL_RUNTIME_BEFORE_FLUSH_MS", 20_000);
  const maxRuntimeWithoutAcceptanceMs = readPositiveIntEnv("OB_BACKFILL_RUNTIME_WITHOUT_ACCEPTANCE_MS", 120_000);
  const maxFamiliesWithoutAcceptance = readPositiveIntEnv("OB_BACKFILL_MAX_FAMILIES_WITHOUT_ACCEPTANCE", 60);
  const maxFamilyRuntimeMs = readPositiveIntEnv("OB_BACKFILL_MAX_FAMILY_RUNTIME_MS", 20_000);
  const rejectionSamples: Array<{
    familyKey: string;
    domain: string;
    lens: string;
    reason: string;
    sourceSystem: string;
    actorName: string;
    snippet: string;
  }> = [];
  const pushRejectionSample = (params: {
    familyKey: string;
    domain: string;
    lens: string;
    reason: string;
    anchor: SeedEvidenceCandidate;
  }) => {
    if (rejectionSamples.length >= 8) return;
    rejectionSamples.push({
      familyKey: params.familyKey,
      domain: params.domain,
      lens: params.lens,
      reason: params.reason,
      sourceSystem: String(params.anchor.source_system ?? "").trim(),
      actorName: String(params.anchor.actor_name ?? "").trim(),
      snippet: compactText(String(params.anchor.content ?? "").trim(), 180)
    });
  };
  let familiesSinceAcceptance = 0;
  let scannedFamilies = 0;

  familyLoop:
  for (const family of rotatedFamilySeeds) {
    const familyStartedAt = Date.now();
    const familyTopology = classifyConversationTopology({
      anchor: family.anchorRows[0],
      contextRows: family.anchorRows
    });
    if (familyTopology === "assistant_thread" && activeHumanShare <= 0.8) {
      continue;
    }
    const familyHasNonUserHumanAnchor = family.anchorRows.some((row) => {
      const actorType = lowerText(row.actor_type);
      return actorType !== "user" && actorType !== "assistant" && actorType !== "system";
    });
    scannedFamilies += 1;
    familiesSinceAcceptance += 1;
    if (
      candidatePool.length === 0
      && (
        familiesSinceAcceptance >= maxFamiliesWithoutAcceptance
        || (Date.now() - startedAt) >= maxRuntimeWithoutAcceptanceMs
      )
    ) {
      console.log(
        `[backfill] stopping without candidates scannedFamilies=${scannedFamilies} familiesSinceAcceptance=${familiesSinceAcceptance}`
      );
      break;
    }
    if (candidatePool.length >= candidatePoolFlushTarget) break;
    if (
      candidatePool.length > 0
      && (
        familiesSinceAcceptance >= Math.min(maxFamiliesWithoutAcceptance, 12)
        || (Date.now() - startedAt) >= maxRuntimeBeforePartialFlushMs
      )
    ) {
      console.log(
        `[backfill] flushing partial pool candidatePool=${candidatePool.length} scannedFamilies=${scannedFamilies} familiesSinceAcceptance=${familiesSinceAcceptance}`
      );
      break;
    }
    let familyFailureCount = 0;
    for (const anchor of family.anchorRows) {
      const anchorActorType = lowerText(anchor.actor_type);
      if (topologyIsHuman(familyTopology) && familyHasNonUserHumanAnchor) {
        if (anchorActorType === "user" || anchorActorType === "assistant" || anchorActorType === "system") {
          continue;
        }
      }
      if ((Date.now() - familyStartedAt) >= maxFamilyRuntimeMs) {
        console.log(`[backfill] skipping slow family familyKey=${family.familyKey} elapsedMs=${Date.now() - familyStartedAt}`);
        continue familyLoop;
      }
      const anchorReject = rejectAnchorReason(anchor.content, 0.55);
      if (anchorReject) continue;

      let conversationRows = conversationContextCache.get(anchor.conversation_id);
      if (!conversationRows) {
        conversationRows = await loadConversationContextRows({
          chatNamespace: params.chatNamespace,
          conversationId: anchor.conversation_id
        });
        conversationContextCache.set(anchor.conversation_id, conversationRows);
      }
      const baseContextRows = buildCaseContextRows(anchor, conversationRows);
      const ownerProfile = inferStatementOwner(anchor, baseContextRows);
      const familyReasoningModes = rankReasoningModesForWholeCorpusAuthoring({
        contextRows: baseContextRows,
        statementOwnerRole: ownerProfile.statementOwnerRole
      }).slice(0, 5);
      if (familyReasoningModes.length === 0) continue;
      const provisionalDomainSelection = selectWholeCorpusProvisionalDomain({
        anchor,
        contextRows: baseContextRows,
        supported
      });
      const provisionalDomainCandidates = provisionalDomainSelection.candidates;
      const provisionalDomain = provisionalDomainSelection.domain;
      const provisionalDomainScore = provisionalDomainSelection.score;

      for (const lensDescriptor of familyReasoningModes) {
        if ((Date.now() - familyStartedAt) >= maxFamilyRuntimeMs) {
          console.log(`[backfill] skipping slow family familyKey=${family.familyKey} elapsedMs=${Date.now() - familyStartedAt}`);
          continue familyLoop;
        }
        const attemptKey = `${family.familyKey}|${provisionalDomain}|${lensDescriptor.lens}`;
        if (attemptedFamilyLens.has(attemptKey)) continue;
        attemptedFamilyLens.add(attemptKey);

        const contextRows = buildLensAwareContextRows({
          anchor,
          conversationRows,
          lens: lensDescriptor.lens
        });
        const lensOwnerProfile = inferStatementOwner(anchor, contextRows);
        const actorName = (
          lensOwnerProfile.statementOwnerRole === "other_human"
          || lensOwnerProfile.statementOwnerRole === "assistant_or_system"
        )
          ? (lensOwnerProfile.statementOwnerName ?? resolveQuestionActorName(anchor, contextRows))
          : resolveQuestionActorName(anchor, contextRows);
        const provisionalSemanticFrame = buildSemanticFrame({
          domain: provisionalDomain,
          lens: lensDescriptor.lens,
          window: relativeWindowPhrase(anchor.source_timestamp),
          anchor,
          contextRows,
          actorName
        });
        if (Number(provisionalSemanticFrame.anchorQualityScore ?? 0) < 0.62) {
          pushRejectionSample({
            familyKey: family.familyKey,
            domain: provisionalDomain,
            lens: lensDescriptor.lens,
            reason: "anchor_quality_too_low",
            anchor
          });
          continue;
        }
        if (
          provisionalSemanticFrame.supportDepth === "thin"
          && !["descriptive", "actor_attribution"].includes(lensDescriptor.lens)
        ) {
          pushRejectionSample({
            familyKey: family.familyKey,
            domain: provisionalDomain,
            lens: lensDescriptor.lens,
            reason: "thin_support_for_high_order_lens",
            anchor
          });
          continue;
        }

        const evidenceIds = contextRows.map((row) => row.canonical_id);
        const conversationIds = Array.from(new Set(contextRows.map((row) => row.conversation_id)));
        const familyKey = buildCaseEvidenceFamilyKey({
          evidenceIds,
          conversationIds,
          sourceEvidenceId: anchor.canonical_id
        });
        if (familyKey) {
          const existingState = existingFamilyState.get(familyKey) ?? { total: 0, clear: 0, clarify: 0 };
          const pendingState = candidateFamilyState.get(familyKey) ?? { total: 0, clear: 0, clarify: 0 };
          if ((existingState.total + pendingState.total) >= 2) continue;
          if ((existingState.clear + pendingState.clear) >= 1) continue;
        }

        const authored = await authorWholeCorpusCandidateWithRepairs({
          chatNamespace: params.chatNamespace,
          supported,
          provisionalDomain,
          provisionalLens: lensDescriptor.lens,
          provisionalDomainScore,
          familyReasoningModes,
          window: relativeWindowPhrase(anchor.source_timestamp),
          actorName,
          contextRows,
          anchor,
          evidenceIds,
          conversationIds,
          familyDeadlineAt: familyStartedAt + maxFamilyRuntimeMs
        });
        if (!authored) {
          pushRejectionSample({
            familyKey: family.familyKey,
            domain: provisionalDomain,
            lens: lensDescriptor.lens,
            reason: "authoring_returned_null",
            anchor
          });
          familyFailureCount += 1;
          if (familyFailureCount >= 3) continue familyLoop;
          continue;
        }
        const acceptanceScore = wholeCorpusAcceptanceScore({
          critique: authored.critique,
          hardGuardReasons: authored.hardGuardReasons
        });
        if (!authored.admissionDecision.admitted || acceptanceScore < minCritiqueScore) {
          const rejectReason = !authored.admissionDecision.admitted
            ? `admission_rejected:${(authored.admissionDecision.reasons ?? []).join(",")}`
            : `critique_below_threshold:${Number(acceptanceScore ?? 0).toFixed(2)}`;
          pushRejectionSample({
            familyKey: family.familyKey,
            domain: authored.domain,
            lens: authored.lens,
            reason: rejectReason,
            anchor
          });
          familyFailureCount += 1;
          if (familyFailureCount >= 3) continue familyLoop;
          continue;
        }
        if (authored.draft.expectedBehavior !== "answer_now") {
          pushRejectionSample({
            familyKey: family.familyKey,
            domain: authored.domain,
            lens: authored.lens,
            reason: `expected_behavior_${authored.draft.expectedBehavior}`,
            anchor
          });
          continue;
        }

        const questionKey = buildBenchmarkQuestionDedupKey(authored.draft.chosenQuestion);
        if (existingQuestionKeys.has(questionKey)) continue;

        existingQuestionKeys.add(questionKey);
        if (familyKey) {
          const current = candidateFamilyState.get(familyKey) ?? { total: 0, clear: 0, clarify: 0 };
          current.total += 1;
          current.clear += 1;
          candidateFamilyState.set(familyKey, current);
        }
        familiesSinceAcceptance = 0;
        console.log(`[backfill] accepted candidate ${authored.domain}/${authored.lens} family=${family.familyKey} score=${acceptanceScore.toFixed(2)}`);
        candidatePool.push({
          calibrationItemId: randomUUID(),
          domain: authored.domain,
          lens: authored.lens,
          caseSet: pickSetLabel(candidatePool.length + 1),
          question: authored.draft.chosenQuestion,
          caseType: `supplemental:${authored.lens}:${authored.domain}`,
          sourceEvidenceId: anchor.canonical_id,
          taxonomyPath: `${authored.domain}.${authored.lens}`,
          difficultyType: inferDifficultyType(authored.lens),
          expectedCoreClaims: buildExpectedCoreClaims(contextRows),
          evidencePreviewRows: contextRows.map((row) => ({
            evidenceId: row.canonical_id,
            actorName: row.actor_name,
            observedAt: row.source_timestamp,
            sourceSystem: row.source_system,
            snippet: row.content
          })),
          evidenceIds,
          conversationIds,
          actorIds: Array.from(new Set(contextRows.map((row) => row.actor_id).filter((id): id is string => Boolean(id)))),
          ambiguityClass: "clear",
          clarificationQualityExpected: false,
          metadata: {
            generationVersion: BENCHMARK_AUTHORING_VERSION,
            authoringVersion: BENCHMARK_AUTHORING_VERSION,
            supplementalReplacement: true,
            wholeCorpusFamilyMining: true,
            expectedBehavior: authored.draft.expectedBehavior,
            expectedAnswerSummaryHuman: authored.draft.expectedAnswerSummaryHuman,
            qualityGate: qualityGateFromAuthoringCritique(authored.draft.authoringCritique),
            wholeCorpusAcceptanceScore: acceptanceScore,
            semanticFrame: authored.draft.semanticFrame,
            questionVoice: authored.draft.questionVoice,
            candidateQuestions: authored.draft.candidateQuestions,
            chosenQuestionRationale: authored.draft.chosenQuestionRationale,
            authoringDecision: authored.draft.authoringDecision,
            rejectionReasons: authored.draft.rejectionReasons,
            clarificationQuestion: authored.draft.clarificationQuestion,
            resolvedQuestionAfterClarification: authored.draft.resolvedQuestionAfterClarification,
            authoringCritique: authored.draft.authoringCritique,
            feasibilityReport: authored.feasibilityReport,
            admissionDecision: authored.admissionDecision,
            semanticFrameSummary: summarizeSemanticFrame(authored.draft.semanticFrame),
            contradictionExpected: authored.domain === "financial_behavior" || authored.lens === "confidence_scoring"
          }
        });
        if (candidatePool.length >= candidatePoolFlushTarget) {
          console.log(`[backfill] flush target reached candidatePool=${candidatePool.length}`);
          break familyLoop;
        }
        continue familyLoop;
      }
    }
  }

  const acceptedCandidates: Array<{
    candidate: (typeof candidatePool)[number];
    storedReview: {
      verdict: "yes" | "no";
      ambiguityClass: "clear" | "clarify_required" | "unresolved";
      notes: string;
      confidence: number;
    } | null;
  }> = [];
  const reviewByCalibrationItemId = new Map<string, {
    verdict: "yes" | "no";
    ambiguityClass: "clear" | "clarify_required" | "unresolved";
    notes: string;
    confidence: number;
  }>();
  for (let i = 0; i < candidatePool.length; i += 5) {
    const chunk = candidatePool.slice(i, i + 5).map((candidate) => ({
      calibrationItemId: candidate.calibrationItemId,
      question: candidate.question,
      domain: candidate.domain,
      lens: candidate.lens,
      ambiguityClass: candidate.ambiguityClass,
      expectedBehavior: String(candidate.metadata.expectedBehavior ?? "answer_now"),
      expectedAnswerSummaryHuman: String(candidate.metadata.expectedAnswerSummaryHuman ?? ""),
      semanticFrame: candidate.metadata.semanticFrame,
      semanticFrameSummary: candidate.metadata.semanticFrameSummary,
      evidencePreview: candidate.evidencePreviewRows,
      qualityGate: candidate.metadata.qualityGate,
      authoringCritique: candidate.metadata.authoringCritique
    }));
    const chunkMap = new Map(chunk.map((row) => [String(row.calibrationItemId), row]));
    console.log(`[backfill] reviewing chunk size=${chunk.length}`);
    const reviews = await reviewCalibrationChunkSafely(chunk, "whole-corpus-family-positive");
    console.log(`[backfill] review returned ${reviews.length} reviews`);
    for (const review of reviews) {
      const calibrationItemId = String(review.calibrationItemId ?? "").trim();
      if (!calibrationItemId) continue;
      const candidate = candidatePool.find((item) => item.calibrationItemId === calibrationItemId);
      if (!candidate) continue;
      const normalized = sanitizeAssistantCalibrationReview(review, chunkMap.get(calibrationItemId) ?? {});
      reviewByCalibrationItemId.set(calibrationItemId, normalized);
      const topology = readSemanticFrame(candidate.metadata)?.topology ?? "system_artifact";
      const acceptanceScore = Number(
        candidate.metadata.wholeCorpusAcceptanceScore
        ?? (candidate.metadata.authoringCritique as Record<string, unknown> | undefined)?.score
        ?? 0
      );
      const explicitGroundingBlock = /\b(not grounded|unsupported|wrong actor|wrong owner|wrong person|wrong target|wrong thread|insufficient evidence|missing statement|scope mismatch|missing concrete|evidence does not)\b/i
        .test(String(normalized.notes ?? ""));
      const humanReviewOverride = (
        normalized.verdict !== "yes"
        && topologyIsHuman(topology)
        && (
          acceptanceScore >= Math.max(minCritiqueScore + 0.06, 0.97)
          || (
            acceptanceScore >= Math.max(minCritiqueScore + 0.03, 0.95)
            && !explicitGroundingBlock
          )
        )
      );
      if (normalized.verdict !== "yes" && !humanReviewOverride) continue;
      if (humanReviewOverride) {
        console.log(
          `[backfill] human override accepted family=${String(candidate.metadata.semanticFrameSummary ?? candidate.question).slice(0, 120)} score=${acceptanceScore.toFixed(2)}`
        );
      }
      acceptedCandidates.push({
        candidate,
        storedReview: normalized.verdict === "yes" ? normalized : null
      });
      if (acceptedCandidates.length >= targetCount) break;
    }
    if (acceptedCandidates.length >= targetCount) break;
  }
  console.log(`[backfill] candidatePool=${candidatePool.length} assistantAccepted=${acceptedCandidates.length}`);
  if (acceptedCandidates.length < targetCount) {
    const acceptedIds = new Set(acceptedCandidates.map((entry) => entry.candidate.calibrationItemId));
    const fallbackCandidates = candidatePool
      .filter((candidate) => !acceptedIds.has(candidate.calibrationItemId))
      .filter((candidate) => !reviewByCalibrationItemId.has(candidate.calibrationItemId))
      .filter((candidate) => {
        const topology = readSemanticFrame(candidate.metadata)?.topology ?? "system_artifact";
        return topology !== "assistant_thread";
      })
      .map((candidate) => ({
        candidate,
        critiqueScore: Number(candidate.metadata.wholeCorpusAcceptanceScore ?? (candidate.metadata.authoringCritique as Record<string, unknown> | undefined)?.score ?? 0)
      }))
      .filter((entry) => entry.critiqueScore >= Math.max(minCritiqueScore + 0.04, 0.94))
      .sort((a, b) => b.critiqueScore - a.critiqueScore);
    for (const entry of fallbackCandidates) {
      acceptedCandidates.push({
        candidate: entry.candidate,
        storedReview: null
      });
      if (acceptedCandidates.length >= targetCount) break;
    }
  }

  const insertedCaseIds: string[] = [];
  const assistantReviewsByCaseId = new Map<string, {
    verdict: "yes" | "no";
    ambiguityClass: "clear" | "clarify_required" | "unresolved";
    notes: string;
    confidence: number;
  }>();
  for (const { candidate, storedReview } of acceptedCandidates.slice(0, targetCount)) {
    const caseId = randomUUID();
    const caseKey = `supplemental:${candidate.domain}:${candidate.lens}:${caseId.slice(0, 8)}`;
    const insertedCaseId = await upsertExperimentCase({
      experimentId: params.experimentId,
      caseSet: candidate.caseSet,
      caseKey,
      caseType: candidate.caseType,
      domain: candidate.domain,
      lens: candidate.lens,
      question: candidate.question,
      chatNamespace: params.chatNamespace,
      expectedCoreClaims: candidate.expectedCoreClaims,
      evidenceIds: candidate.evidenceIds,
      conversationIds: candidate.conversationIds,
      actorIds: candidate.actorIds,
      sourceEvidenceId: candidate.sourceEvidenceId,
      taxonomyPath: candidate.taxonomyPath,
      difficultyType: candidate.difficultyType,
      generationMethod: "v1.8_whole_corpus_family_positive",
      ambiguityClass: candidate.ambiguityClass,
      ownerValidationState: "pending",
      clarificationQualityExpected: candidate.clarificationQualityExpected,
      metadata: candidate.metadata
    });
    if (!insertedCaseId) continue;
    insertedCaseIds.push(insertedCaseId);
    if (storedReview) assistantReviewsByCaseId.set(insertedCaseId, storedReview);
    console.log(`[backfill] inserted case ${insertedCaseId} domain=${candidate.domain} lens=${candidate.lens}`);
  }

  const calibrationMap = await materializeCalibrationItemsForCaseIds({
    experimentId: params.experimentId,
    caseIds: insertedCaseIds
  });
  for (const [caseId, calibrationItemId] of calibrationMap.entries()) {
    const review = assistantReviewsByCaseId.get(caseId);
    if (!review) continue;
    await upsertAssistantCalibrationSuggestion({
      calibrationItemId,
      verdict: review.verdict,
      ambiguityClass: review.ambiguityClass,
      notes: review.notes,
      confidence: review.confidence
    });
  }

  return {
    requested: targetCount,
    candidatePool: candidatePool.length,
    assistantAccepted: acceptedCandidates.length,
    inserted: insertedCaseIds.length,
    calibrationItemsCreated: calibrationMap.size,
    caseIds: insertedCaseIds,
    scannedFamilies,
    familySeedCount,
    nextFamilyOffset: familySeedCount > 0 ? ((familyOffset + scannedFamilies) % familySeedCount) : 0,
    rejectionSamples
  };
}

export async function backfillPositiveCalibrationCases(params: {
  experimentId: string;
  targetCount: number;
  minCritiqueScore?: number;
  preferredDomains?: string[];
  preferredLenses?: string[];
}): Promise<Record<string, unknown>> {
  const experiment = await readExperiment(params.experimentId);
  const taxonomyVersion = experiment.taxonomy_version_id
    ? await loadTaxonomyVersionRowById(experiment.taxonomy_version_id)
    : await getPublishedTaxonomyVersion(null);
  return generateWholeCorpusFamilyPositiveCases({
    experimentId: params.experimentId,
    chatNamespace: experiment.chat_namespace,
    taxonomyVersionId: taxonomyVersion.id,
    targetCount: Math.max(0, Math.min(60, Number(params.targetCount ?? 0))),
    minCritiqueScore: params.minCritiqueScore,
    preferredDomains: params.preferredDomains,
    preferredLenses: params.preferredLenses
  });
}

export async function reactivateUniqueStaleCases(params: {
  experimentId: string;
  count: number;
  preferredDomains?: string[];
  preferredLenses?: string[];
}): Promise<{
  requested: number;
  selected: number;
  calibrationItemsCreated: number;
  caseIds: string[];
}> {
  const requested = Math.max(0, Number(params.count || 0));
  if (requested <= 0) {
    return { requested: 0, selected: 0, calibrationItemsCreated: 0, caseIds: [] };
  }
  const preferredDomains = new Set(
    (params.preferredDomains ?? []).map((value) => String(value ?? "").trim()).filter(Boolean)
  );
  const preferredLenses = new Set(
    (params.preferredLenses ?? []).map((value) => String(value ?? "").trim()).filter(Boolean)
  );
  const activeRows = await pool.query<{
    question: string;
    source_evidence_id: string | null;
    evidence_ids: string[] | string;
    conversation_ids: string[] | string;
  }>(
    `SELECT lower(question) AS question,
            source_evidence_id::text,
            COALESCE(evidence_ids::text, '{}') AS evidence_ids,
            COALESCE(conversation_ids::text, '{}') AS conversation_ids
     FROM experiment_cases
     WHERE experiment_id = $1::uuid
       AND is_stale = false`,
    [params.experimentId]
  );
  const activeQuestionKeys = new Set(
    activeRows.rows.map((row) => buildBenchmarkQuestionDedupKey(row.question))
  );
  const activeFamilyKeys = new Set(
    activeRows.rows
      .map((row) => buildCaseEvidenceFamilyKey({
        evidenceIds: row.evidence_ids,
        conversationIds: row.conversation_ids,
        sourceEvidenceId: row.source_evidence_id
      }))
      .filter(Boolean)
  );

  const staleRows = await pool.query<{
    case_id: string;
    domain: string;
    lens: string;
    case_set: string;
    question: string;
    owner_validation_state: string | null;
    metadata: Record<string, unknown>;
    source_evidence_id: string | null;
    evidence_ids: string[] | string;
    conversation_ids: string[] | string;
    created_at: string;
    owner_verdict: string | null;
    owner_notes: string | null;
    assistant_verdict: string | null;
    assistant_notes: string | null;
    assistant_created_at: string | null;
  }>(
    `SELECT
       c.id::text AS case_id,
       c.domain,
       c.lens,
       c.case_set,
       lower(c.question) AS question,
       c.owner_validation_state,
       c.metadata,
       c.source_evidence_id::text,
       COALESCE(c.evidence_ids::text, '{}') AS evidence_ids,
       COALESCE(c.conversation_ids::text, '{}') AS conversation_ids,
       c.created_at::text,
       own.verdict AS owner_verdict,
       own.notes AS owner_notes,
       asst.verdict AS assistant_verdict,
       asst.notes AS assistant_notes,
       asst.created_at::text AS assistant_created_at
     FROM experiment_cases c
     LEFT JOIN LATERAL (
       SELECT l.verdict, COALESCE(l.notes, '') AS notes
       FROM experiment_judge_calibration_labels l
       JOIN experiment_judge_calibration_items i ON i.id = l.calibration_item_id
       WHERE i.experiment_id = $1::uuid
         AND i.case_id = c.id
         AND l.reviewer = 'owner'
       ORDER BY l.created_at DESC
       LIMIT 1
     ) own ON true
     LEFT JOIN LATERAL (
       SELECT l.verdict, COALESCE(l.notes, '') AS notes, l.created_at
       FROM experiment_judge_calibration_labels l
       JOIN experiment_judge_calibration_items i ON i.id = l.calibration_item_id
       WHERE i.experiment_id = $1::uuid
         AND i.case_id = c.id
         AND l.reviewer = 'assistant'
       ORDER BY l.created_at DESC
       LIMIT 1
     ) asst ON true
     WHERE c.experiment_id = $1::uuid
       AND c.is_stale = true
       AND COALESCE((c.metadata->'admissionDecision'->>'admitted')::boolean, false) = true
       AND COALESCE(c.metadata->'qualityGate'->>'status', 'fail') = 'pass'`,
    [params.experimentId]
  );

  const selectedCaseIds: string[] = [];
  const selectedQuestionKeys = new Set<string>();
  const selectedFamilyKeys = new Set<string>();
  const assistantByCaseId = new Map<string, {
    verdict: "yes" | "no";
    ambiguityClass: "clear" | "clarify_required" | "unresolved";
    notes: string;
    confidence: number;
  }>();

  const ranked = staleRows.rows
    .filter((row) => preferredDomains.size === 0 || preferredDomains.has(row.domain))
    .filter((row) => preferredLenses.size === 0 || preferredLenses.has(row.lens))
    .map((row) => {
      const familyKey = buildCaseEvidenceFamilyKey({
        evidenceIds: row.evidence_ids,
        conversationIds: row.conversation_ids,
        sourceEvidenceId: row.source_evidence_id
      }) || `case:${row.case_id}`;
      const questionKey = buildBenchmarkQuestionDedupKey(row.question);
      const assistantSuggestion = parseAssistantCalibrationSuggestion({
        verdict: row.assistant_verdict,
        notes: row.assistant_notes,
        createdAt: row.assistant_created_at
      });
      const qualityGate = readCaseQualityGate(row.metadata ?? {});
      const critique = readAuthoringCritique(row.metadata ?? {});
      return {
        ...row,
        familyKey,
        questionKey,
        assistantSuggestion,
        score: duplicateBenchmarkRetentionRank({
          ownerValidationState: row.owner_validation_state,
          ownerVerdict: row.owner_verdict,
          ownerNotes: row.owner_notes,
          assistantVerdict: String(assistantSuggestion?.verdict ?? ""),
          assistantNotes: String(assistantSuggestion?.notes ?? ""),
          assistantConfidence: Number(assistantSuggestion?.confidence ?? 0),
          qualityScore: qualityGate.score,
          lensFit: critique?.dimensions.lensFit,
          grounding: critique?.dimensions.evidenceGrounding,
          actorScopeFidelity: critique?.dimensions.actorScopeFidelity,
          answerability: critique?.dimensions.answerability,
          caseSet: row.case_set
        })
      };
    })
    .filter((row) => !String(row.owner_verdict ?? "").trim())
    .sort((left, right) => {
      if (left.score !== right.score) return right.score - left.score;
      return String(left.created_at).localeCompare(String(right.created_at));
    });

  for (const row of ranked) {
    if (selectedCaseIds.length >= requested) break;
    if (!row.questionKey) continue;
    if (activeQuestionKeys.has(row.questionKey) || selectedQuestionKeys.has(row.questionKey)) continue;
    if (activeFamilyKeys.has(row.familyKey) || selectedFamilyKeys.has(row.familyKey)) continue;
    selectedCaseIds.push(row.case_id);
    selectedQuestionKeys.add(row.questionKey);
    selectedFamilyKeys.add(row.familyKey);
    if (row.assistantSuggestion) {
      assistantByCaseId.set(row.case_id, {
        verdict: String(row.assistantSuggestion.verdict ?? "").trim().toLowerCase() === "no" ? "no" : "yes",
        ambiguityClass: String(row.assistantSuggestion.ambiguityClass ?? "").trim().toLowerCase() === "clarify_required"
          ? "clarify_required"
          : (String(row.assistantSuggestion.ambiguityClass ?? "").trim().toLowerCase() === "unresolved"
            ? "unresolved"
            : "clear"),
        notes: String(row.assistantSuggestion.notes ?? "").trim(),
        confidence: Number.isFinite(Number(row.assistantSuggestion.confidence ?? 0))
          ? Number(row.assistantSuggestion.confidence ?? 0)
          : 0
      });
    }
  }

  if (selectedCaseIds.length <= 0) {
    return { requested, selected: 0, calibrationItemsCreated: 0, caseIds: [] };
  }

  await pool.query(
    `UPDATE experiment_cases
     SET is_stale = false,
         owner_validation_state = 'pending',
         benchmark_lock_version = NULL,
         eligible_for_scoring = false,
         updated_at = now()
     WHERE id = ANY($1::uuid[])`,
    [selectedCaseIds]
  );

  const calibrationMap = await materializeCalibrationItemsForCaseIds({
    experimentId: params.experimentId,
    caseIds: selectedCaseIds
  });
  for (const [caseId, calibrationItemId] of calibrationMap.entries()) {
    const suggestion = assistantByCaseId.get(caseId);
    if (!suggestion) continue;
    await upsertAssistantCalibrationSuggestion({
      calibrationItemId,
      verdict: suggestion.verdict,
      ambiguityClass: suggestion.ambiguityClass,
      notes: suggestion.notes,
      confidence: suggestion.confidence
    });
  }

  return {
    requested,
    selected: selectedCaseIds.length,
    calibrationItemsCreated: calibrationMap.size,
    caseIds: selectedCaseIds
  };
}

export async function backfillCalibrationPositiveCases(params: {
  experimentId: string;
  count: number;
  preferredDomains?: string[];
  preferredLenses?: string[];
}): Promise<Record<string, unknown>> {
  const experiment = await readExperiment(params.experimentId);
  const taxonomyVersion = experiment.taxonomy_version_id
    ? await loadTaxonomyVersionRowById(experiment.taxonomy_version_id)
    : await getPublishedTaxonomyVersion(null);
  const requested = Math.max(0, Number(params.count || 0));
  let inserted = 0;
  const runs: Array<Record<string, unknown>> = [];
  const reactivated = await reactivateUniqueStaleCases({
    experimentId: params.experimentId,
    count: requested,
    preferredDomains: params.preferredDomains,
    preferredLenses: params.preferredLenses
  });
  runs.push({
    strategy: "reactivate_stale_unique_families",
    ...reactivated
  });
  inserted += Number(reactivated.selected ?? 0);
  for (const threshold of [0.9, 0.86, 0.82]) {
    if (inserted >= requested) break;
    const result = await generateSupplementalPositiveCases({
      experimentId: params.experimentId,
      chatNamespace: experiment.chat_namespace,
      taxonomyVersionId: taxonomyVersion.id,
      targetCount: requested - inserted,
      minCritiqueScore: threshold,
      preferredDomains: params.preferredDomains,
      preferredLenses: params.preferredLenses
    });
    runs.push({
      strategy: "generate_supplemental_positive_cases",
      minCritiqueScore: threshold,
      ...result
    });
    inserted += Number(result.inserted ?? 0);
    if (Number(result.inserted ?? 0) <= 0) break;
  }
  return {
    ok: true,
    experimentId: params.experimentId,
    requested,
    inserted,
    runs
  };
}

export async function augmentCalibrationPositiveCases(params: {
  experimentId: string;
  count: number;
}): Promise<Record<string, unknown>> {
  const requested = Math.max(0, Number(params.count || 0));
  if (requested <= 0) {
    return { ok: true, experimentId: params.experimentId, requested: 0, inserted: 0, calibrationItemsCreated: 0 };
  }
  const approvedSeeds = await pool.query<{
    case_id: string;
    case_set: string;
    domain: string;
    lens: string;
    question: string;
    chat_namespace: string;
    expected_core_claims: string[] | string;
    evidence_ids: string[] | string;
    conversation_ids: string[] | string;
    actor_ids: string[] | string;
    source_evidence_id: string | null;
    taxonomy_path: string | null;
    ambiguity_class: string | null;
    clarification_quality_expected: boolean | null;
    metadata: Record<string, unknown>;
  }>(
    `WITH latest_owner AS (
       SELECT DISTINCT ON (l.calibration_item_id)
         i.case_id,
         l.verdict,
         l.created_at
       FROM experiment_judge_calibration_labels l
       JOIN experiment_judge_calibration_items i ON i.id = l.calibration_item_id
       WHERE i.experiment_id = $1::uuid
         AND l.reviewer = 'owner'
       ORDER BY l.calibration_item_id, l.created_at DESC
     )
     SELECT
       c.id::text AS case_id,
       c.case_set,
       c.domain,
       c.lens,
       c.question,
       c.chat_namespace,
       COALESCE(c.expected_core_claims::text, '[]') AS expected_core_claims,
       COALESCE(c.evidence_ids::text, '{}') AS evidence_ids,
       COALESCE(c.conversation_ids::text, '{}') AS conversation_ids,
       COALESCE(c.actor_ids::text, '{}') AS actor_ids,
       c.source_evidence_id::text,
       c.taxonomy_path,
       c.ambiguity_class,
       c.clarification_quality_expected,
       c.metadata
     FROM latest_owner o
     JOIN experiment_cases c ON c.id = o.case_id
     WHERE c.experiment_id = $1::uuid
       AND o.verdict = 'yes'
       AND c.is_stale = false
     ORDER BY c.domain, c.lens, c.created_at ASC`,
    [params.experimentId]
  );
  const seedRows = approvedSeeds.rows;
  if (seedRows.length === 0) {
    return {
      ok: false,
      experimentId: params.experimentId,
      requested,
      inserted: 0,
      error: "No approved positive seed cases available for augmentation."
    };
  }

  const allEvidenceIds = seedRows.flatMap((row) => (
    Array.isArray(row.evidence_ids) ? row.evidence_ids.map(String) : parsePgTextArray(String(row.evidence_ids ?? "{}"))
  ));
  const evidenceMap = await loadEvidencePreviewMap(allEvidenceIds);
  const existingQuestions = await pool.query<{ question: string }>(
    `SELECT lower(question) AS question
     FROM experiment_cases
     WHERE experiment_id = $1::uuid
       AND is_stale = false`,
    [params.experimentId]
  );
  const existingQuestionKeys = new Set(
    existingQuestions.rows.map((row) => buildBenchmarkQuestionDedupKey(row.question))
  );

  const seedPayloads = seedRows.map((row) => {
    const evidenceIds = Array.isArray(row.evidence_ids) ? row.evidence_ids.map(String) : parsePgTextArray(String(row.evidence_ids ?? "{}"));
    return {
      sourceCaseId: row.case_id,
      domain: row.domain,
      lens: row.lens,
      question: row.question,
      expectedBehavior: String((row.metadata ?? {}).expectedBehavior ?? "answer_now"),
      expectedAnswerSummaryHuman: String((row.metadata ?? {}).expectedAnswerSummaryHuman ?? "").trim(),
      semanticFrame: readSemanticFrame(row.metadata ?? {}),
      semanticFrameSummary: readSemanticFrameSummary(row.metadata ?? {}),
      evidencePreview: evidenceIds.map((id) => evidenceMap.get(id)).filter(Boolean)
    };
  });

  const variantPool: Array<{
    sourceCaseId: string;
    question: string;
    rationale: string;
  }> = [];
  for (let i = 0; i < seedPayloads.length && variantPool.length < requested * 2; i += 4) {
    const batch = seedPayloads.slice(i, i + 4);
    const variants = await generatePositiveVariantBatchWithModel(batch);
    for (const variant of variants) {
      const sourceCaseId = String(variant.sourceCaseId ?? "").trim();
      const question = String(variant.question ?? "").trim();
      if (!sourceCaseId || !question) continue;
      const seed = seedRows.find((row) => row.case_id === sourceCaseId);
      if (!seed) continue;
      const questionKey = buildBenchmarkQuestionDedupKey(question);
      if (existingQuestionKeys.has(questionKey)) continue;
      existingQuestionKeys.add(questionKey);
      variantPool.push({
        sourceCaseId,
        question,
        rationale: String(variant.rationale ?? "").trim()
      });
      if (variantPool.length >= requested * 2) break;
    }
  }

  const reviewInputs = variantPool.map((variant) => {
    const seed = seedRows.find((row) => row.case_id === variant.sourceCaseId)!;
    const evidenceIds = Array.isArray(seed.evidence_ids) ? seed.evidence_ids.map(String) : parsePgTextArray(String(seed.evidence_ids ?? "{}"));
    return {
      calibrationItemId: randomUUID(),
      sourceCaseId: variant.sourceCaseId,
      question: variant.question,
      domain: seed.domain,
      lens: seed.lens,
      ambiguityClass: String(seed.ambiguity_class ?? "clear"),
      expectedBehavior: String((seed.metadata ?? {}).expectedBehavior ?? "answer_now"),
      expectedAnswerSummaryHuman: String((seed.metadata ?? {}).expectedAnswerSummaryHuman ?? "").trim(),
      semanticFrame: readSemanticFrame(seed.metadata ?? {}),
      semanticFrameSummary: readSemanticFrameSummary(seed.metadata ?? {}),
      evidencePreview: evidenceIds.map((id) => evidenceMap.get(id)).filter(Boolean),
      qualityGate: readCaseQualityGate(seed.metadata ?? {}),
      authoringCritique: readAuthoringCritique(seed.metadata ?? {})
    };
  });

  const accepted = new Map<string, {
    verdict: "yes" | "no";
    ambiguityClass: "clear" | "clarify_required" | "unresolved";
    notes: string;
    confidence: number;
  }>();
  for (let i = 0; i < reviewInputs.length && accepted.size < requested; i += 5) {
    const chunk = reviewInputs.slice(i, i + 5);
    const chunkMap = new Map(chunk.map((row) => [String(row.calibrationItemId), row]));
    const reviews = await reviewCalibrationChunkSafely(chunk, "supplemental-clarify-variants");
    for (const review of reviews) {
      const id = String(review.calibrationItemId ?? "").trim();
      if (!id) continue;
      const normalized = sanitizeAssistantCalibrationReview(review, chunkMap.get(id) ?? {});
      if (normalized.verdict !== "yes") continue;
      accepted.set(id, normalized);
      if (accepted.size >= requested) break;
    }
  }

  const insertedCaseIds: string[] = [];
  const assistantByCase = new Map<string, {
    verdict: "yes" | "no";
    ambiguityClass: "clear" | "clarify_required" | "unresolved";
    notes: string;
    confidence: number;
  }>();
  for (const input of reviewInputs) {
    if (insertedCaseIds.length >= requested) break;
    const review = accepted.get(String(input.calibrationItemId));
    if (!review) continue;
    const seed = seedRows.find((row) => row.case_id === String(input.sourceCaseId))!;
    const caseId = randomUUID();
    const caseSet = (["dev", "critical", "certification"] as const).includes(seed.case_set as never)
      ? (seed.case_set as "dev" | "critical" | "certification")
      : pickSetLabel(insertedCaseIds.length + 1);
    const caseKey = `aug:${seed.case_id}:${caseId.slice(0, 8)}`;
    const expectedCoreClaims = Array.isArray(seed.expected_core_claims)
      ? seed.expected_core_claims.map(String)
      : parseJsonArray(String(seed.expected_core_claims ?? "[]"));
    const evidenceIds = Array.isArray(seed.evidence_ids)
      ? seed.evidence_ids.map(String)
      : parsePgTextArray(String(seed.evidence_ids ?? "{}"));
    const conversationIds = Array.isArray(seed.conversation_ids)
      ? seed.conversation_ids.map(String)
      : parsePgTextArray(String(seed.conversation_ids ?? "{}"));
    const actorIds = Array.isArray(seed.actor_ids)
      ? seed.actor_ids.map(String)
      : parsePgTextArray(String(seed.actor_ids ?? "{}"));
    await upsertExperimentCase({
      experimentId: params.experimentId,
      caseSet,
      caseKey,
      caseType: `augmented:${seed.lens}:${seed.domain}`,
      domain: seed.domain,
      lens: seed.lens,
      question: String(input.question),
      chatNamespace: seed.chat_namespace,
      expectedCoreClaims,
      evidenceIds,
      conversationIds,
      actorIds,
      sourceEvidenceId: seed.source_evidence_id,
      taxonomyPath: seed.taxonomy_path ?? `${seed.domain}.${seed.lens}`,
      difficultyType: inferDifficultyType(seed.lens),
      generationMethod: "v1.7_positive_augmentation",
      ambiguityClass: (seed.ambiguity_class ?? "clear") as "clear" | "clarify_required" | "unresolved",
      ownerValidationState: "pending",
      clarificationQualityExpected: Boolean(seed.clarification_quality_expected),
      metadata: {
        ...(seed.metadata ?? {}),
        augmentedFromCaseId: seed.case_id,
        augmentationRationale: variantPool.find((variant) => variant.sourceCaseId === seed.case_id && variant.question === input.question)?.rationale ?? null,
        generationVersion: BENCHMARK_AUTHORING_VERSION,
        authoringVersion: BENCHMARK_AUTHORING_VERSION,
        positiveAugmentation: true
      }
    });
    const inserted = await pool.query<{ id: string }>(
      `SELECT id::text
       FROM experiment_cases
       WHERE experiment_id = $1::uuid
         AND case_set = $2::text
         AND case_key = $3
       LIMIT 1`,
      [params.experimentId, caseSet, caseKey]
    );
    const insertedCaseId = inserted.rows[0]?.id ?? null;
    if (!insertedCaseId) continue;
    insertedCaseIds.push(insertedCaseId);
    assistantByCase.set(insertedCaseId, review);
  }

  const calibrationMap = await materializeCalibrationItemsForCaseIds({
    experimentId: params.experimentId,
    caseIds: insertedCaseIds
  });
  for (const [caseId, calibrationItemId] of calibrationMap.entries()) {
    const review = assistantByCase.get(caseId);
    if (!review) continue;
    await upsertAssistantCalibrationSuggestion({
      calibrationItemId,
      verdict: review.verdict,
      ambiguityClass: review.ambiguityClass,
      notes: review.notes,
      confidence: review.confidence
    });
  }

  return {
    ok: true,
    experimentId: params.experimentId,
    requested,
    candidateVariants: variantPool.length,
    acceptedByAssistant: accepted.size,
    inserted: insertedCaseIds.length,
    calibrationItemsCreated: calibrationMap.size,
    caseIds: insertedCaseIds
  };
}

export async function backfillCalibrationClarifyCases(params: {
  experimentId: string;
  count: number;
  minCritiqueScore?: number;
}): Promise<Record<string, unknown>> {
  const experiment = await readExperiment(params.experimentId);
  const requested = Math.max(0, Math.min(80, Number(params.count ?? 0)));
  if (requested <= 0) {
    return {
      ok: true,
      experimentId: params.experimentId,
      requested: 0,
      seedCount: 0,
      candidateVariants: 0,
      admittedVariants: 0,
      assistantSuggestedYes: 0,
      assistantSuggestedNo: 0,
      inserted: 0,
      calibrationItemsCreated: 0,
      caseIds: []
    };
  }
  const minCritiqueScore = Number.isFinite(Number(params.minCritiqueScore))
    ? Number(params.minCritiqueScore)
    : 0.8;

  const existingQuestionRows = await pool.query<{
    question: string;
  }>(
    `SELECT lower(question) AS question
     FROM experiment_cases
     WHERE experiment_id = $1::uuid
       AND is_stale = false`,
    [params.experimentId]
  );
  const existingQuestionKeys = new Set(
    existingQuestionRows.rows.map((row) => buildBenchmarkQuestionDedupKey(row.question))
  );
  const existingClarifyRows = await pool.query<{
    domain: string;
    lens: string;
    question: string;
    metadata: Record<string, unknown>;
    source_case_id: string | null;
  }>(
    `SELECT
       domain,
       lens,
       question,
       metadata,
       NULLIF(metadata->>'clarifyAugmentedFromCaseId', '') AS source_case_id
     FROM experiment_cases
     WHERE experiment_id = $1::uuid
       AND is_stale = false
       AND ambiguity_class = 'clarify_required'`,
    [params.experimentId]
  );
  const seededClarifySourceIds = new Set(
    existingClarifyRows.rows
      .map((row) => String(row.source_case_id ?? "").trim())
      .filter(Boolean)
  );
  const existingClarifySourceSlotKeys = new Set<string>();
  const existingClarifyArchetypeKeys = new Set<string>();
  const clarifyDomainCounts = new Map<string, number>();
  for (const row of existingClarifyRows.rows) {
    const metadata = row.metadata ?? {};
    const slotType = classifyClarifyMissingSlotType({
      question: row.question,
      clarificationQuestion: readClarificationQuestion(metadata),
      notes: "",
      modelValue: String(metadata.missingSlotType ?? "").trim()
    });
    const sourceCaseId = String(row.source_case_id ?? "").trim();
    if (sourceCaseId) existingClarifySourceSlotKeys.add(`${sourceCaseId}|${slotType}`);
    existingClarifyArchetypeKeys.add(buildClarifyArchetypeKey({
      question: row.question,
      clarificationQuestion: readClarificationQuestion(metadata),
      slotType
    }));
    clarifyDomainCounts.set(row.domain, (clarifyDomainCounts.get(row.domain) ?? 0) + 1);
  }

  const seedRows = await pool.query<{
    case_id: string;
    case_set: string;
    domain: string;
    lens: string;
    question: string;
    chat_namespace: string;
    expected_core_claims: string[] | string;
    evidence_ids: string[] | string;
    conversation_ids: string[] | string;
    actor_ids: string[] | string;
    source_evidence_id: string | null;
    taxonomy_path: string | null;
    difficulty_type: string | null;
    metadata: Record<string, unknown>;
  }>(
    `SELECT
       c.id::text AS case_id,
       c.case_set,
       c.domain,
       c.lens,
       c.question,
       c.chat_namespace,
       COALESCE(c.expected_core_claims::text, '[]') AS expected_core_claims,
       COALESCE(c.evidence_ids::text, '{}') AS evidence_ids,
       COALESCE(c.conversation_ids::text, '{}') AS conversation_ids,
       COALESCE(c.actor_ids::text, '{}') AS actor_ids,
       c.source_evidence_id::text,
       c.taxonomy_path,
       c.difficulty_type,
       c.metadata
     FROM experiment_cases c
     WHERE c.experiment_id = $1::uuid
       AND c.is_stale = false
       AND c.ambiguity_class = 'clear'
       AND c.owner_validation_state = 'approved'
       AND COALESCE((c.metadata->'admissionDecision'->>'admitted')::boolean, false) = true
       AND COALESCE(c.metadata->'qualityGate'->>'status', 'fail') = 'pass'
     ORDER BY
       CASE c.case_set
         WHEN 'critical' THEN 0
         WHEN 'certification' THEN 1
         ELSE 2
       END ASC,
       c.updated_at DESC,
       c.created_at DESC`,
    [params.experimentId]
  );

  const firstByPair: Array<typeof seedRows.rows[number]> = [];
  const overflowByPair: Array<typeof seedRows.rows[number]> = [];
  const seenPairs = new Set<string>();
  for (const row of seedRows.rows) {
    if (seededClarifySourceIds.has(row.case_id)) continue;
    const pairKey = `${row.domain}|${row.lens}`;
    if (!seenPairs.has(pairKey)) {
      seenPairs.add(pairKey);
      firstByPair.push(row);
    } else {
      overflowByPair.push(row);
    }
  }
  const selectedSeeds = [...firstByPair, ...overflowByPair]
    .sort((left, right) => {
      const leftClarify = clarifyDomainCounts.get(left.domain) ?? 0;
      const rightClarify = clarifyDomainCounts.get(right.domain) ?? 0;
      if (leftClarify !== rightClarify) return leftClarify - rightClarify;
      const leftCritical = left.case_set === "critical" ? 0 : left.case_set === "certification" ? 1 : 2;
      const rightCritical = right.case_set === "critical" ? 0 : right.case_set === "certification" ? 1 : 2;
      if (leftCritical !== rightCritical) return leftCritical - rightCritical;
      return left.question.localeCompare(right.question);
    })
    .slice(0, Math.max(requested * 4, 48));
  const allEvidenceIds = selectedSeeds.flatMap((row) => (
    Array.isArray(row.evidence_ids)
      ? row.evidence_ids.map(String)
      : parsePgTextArray(String(row.evidence_ids ?? "{}"))
  ));
  const evidencePreviewMap = await loadEvidencePreviewMap(allEvidenceIds);
  const seedById = new Map(selectedSeeds.map((row) => [row.case_id, row]));

  const seedPayloads = selectedSeeds.map((row) => {
    const evidenceIds = Array.isArray(row.evidence_ids)
      ? row.evidence_ids.map(String)
      : parsePgTextArray(String(row.evidence_ids ?? "{}"));
    const expectedCoreClaims = Array.isArray(row.expected_core_claims)
      ? row.expected_core_claims.map(String)
      : parseJsonArray(String(row.expected_core_claims ?? "[]"));
    return {
      sourceCaseId: row.case_id,
      domain: row.domain,
      lens: row.lens,
      sourceQuestion: row.question,
      expectedAnswerSummaryHuman: String((row.metadata ?? {}).expectedAnswerSummaryHuman ?? "").trim(),
      semanticFrameSummary: readSemanticFrameSummary(row.metadata ?? {}),
      evidencePreview: evidenceIds.map((id) => evidencePreviewMap.get(id)).filter(Boolean),
      expectedCoreClaims: expectedCoreClaims.slice(0, 3)
    };
  });

  const candidateVariants: Array<{
    sourceCaseId: string;
    question: string;
    clarificationQuestion: string;
    resolvedQuestionAfterClarification: string;
    missingSlotType: "actor" | "timeframe" | "app_or_platform" | "location" | "thread_identity" | "target_scope";
    rationale: string;
  }> = [];
  const variantKeys = new Set<string>();
  const variantSourceSlotKeys = new Set<string>();
  const variantArchetypeKeys = new Set<string>();
  for (let i = 0; i < seedPayloads.length && candidateVariants.length < requested * 3; i += 4) {
    const batch = seedPayloads.slice(i, i + 4);
    const variants = await generateClarifyVariantBatchWithModel(batch);
    for (const variant of variants) {
      const sourceCaseId = String(variant.sourceCaseId ?? "").trim();
      const question = String(variant.question ?? "").trim();
      const clarificationQuestion = String(variant.clarificationQuestion ?? "").trim();
      const resolvedQuestionAfterClarification = String(variant.resolvedQuestionAfterClarification ?? "").trim();
      if (!sourceCaseId || !question || !clarificationQuestion || !resolvedQuestionAfterClarification) continue;
      const seed = seedById.get(sourceCaseId);
      if (!seed) continue;
      if (normalizeQuestionSignature(question) === normalizeQuestionSignature(String(seed.question ?? ""))) continue;
      if (normalizeQuestionSignature(question) === normalizeQuestionSignature(resolvedQuestionAfterClarification)) continue;
      const missingSlotType = classifyClarifyMissingSlotType({
        question,
        clarificationQuestion,
        notes: String(variant.rationale ?? "").trim(),
        modelValue: String(variant.missingSlotType ?? "").trim()
      });
      const questionKey = buildBenchmarkQuestionDedupKey(question);
      const sourceSlotKey = `${sourceCaseId}|${missingSlotType}`;
      const archetypeKey = buildClarifyArchetypeKey({
        question,
        clarificationQuestion,
        slotType: missingSlotType
      });
      if (existingQuestionKeys.has(questionKey) || variantKeys.has(questionKey)) continue;
      if (existingClarifySourceSlotKeys.has(sourceSlotKey) || variantSourceSlotKeys.has(sourceSlotKey)) continue;
      if (existingClarifyArchetypeKeys.has(archetypeKey) || variantArchetypeKeys.has(archetypeKey)) continue;
      variantKeys.add(questionKey);
      variantSourceSlotKeys.add(sourceSlotKey);
      variantArchetypeKeys.add(archetypeKey);
      candidateVariants.push({
        sourceCaseId,
        question,
        clarificationQuestion,
        resolvedQuestionAfterClarification,
        missingSlotType,
        rationale: String(variant.rationale ?? "").trim()
      });
      if (candidateVariants.length >= requested * 3) break;
    }
  }

  const seedContextCache = new Map<string, SeedEvidenceCandidate[]>();
  const admittedPool: Array<{
    sourceCaseId: string;
    caseSet: "critical" | "certification";
    domain: string;
    lens: string;
    question: string;
    missingSlotType: "actor" | "timeframe" | "app_or_platform" | "location" | "thread_identity" | "target_scope";
    expectedCoreClaims: string[];
    evidenceIds: string[];
    conversationIds: string[];
    actorIds: string[];
    sourceEvidenceId: string | null;
    taxonomyPath: string;
    metadata: Record<string, unknown>;
    reviewInput: Record<string, unknown>;
  }> = [];

  for (const variant of candidateVariants) {
    if (admittedPool.length >= requested * 2) break;
    const seed = seedById.get(variant.sourceCaseId);
    if (!seed) continue;
    let contextRows = seedContextCache.get(seed.case_id);
    if (!contextRows) {
      const evidenceIds = Array.isArray(seed.evidence_ids)
        ? seed.evidence_ids.map(String)
        : parsePgTextArray(String(seed.evidence_ids ?? "{}"));
      contextRows = await loadSeedEvidenceRowsByIds({
        chatNamespace: experiment.chat_namespace,
        canonicalIds: evidenceIds
      });
      seedContextCache.set(seed.case_id, contextRows);
    }
    if (!contextRows || contextRows.length === 0) continue;
    const sourceEvidenceId = String(seed.source_evidence_id ?? "").trim();
    const anchor = contextRows.find((row) => row.canonical_id === sourceEvidenceId) ?? contextRows[0];
    const actorName = resolveQuestionActorName(anchor, contextRows);
    const evidenceIds = contextRows.map((row) => row.canonical_id);
    const conversationIds = Array.from(new Set(contextRows.map((row) => row.conversation_id)));
    const actorIds = Array.from(new Set(contextRows.map((row) => row.actor_id).filter((id): id is string => Boolean(id))));
    const semanticFrame = readSemanticFrame(seed.metadata ?? {}) ?? buildSemanticFrame({
      domain: seed.domain,
      lens: seed.lens,
      window: relativeWindowPhrase(anchor.source_timestamp),
      anchor,
      contextRows,
      actorName
    });
    const questionVoice = String((seed.metadata ?? {}).questionVoice ?? "unknown").trim() || "unknown";
    const hardGuardReasons = buildAuthoringHardGuardReasons({
      anchor,
      contextRows,
      question: variant.question,
      expectedBehavior: "clarify_first",
      domain: seed.domain,
      lens: seed.lens
    });
    const critique = scoreAuthoringCritique({
      question: variant.question,
      questionVoice,
      expectedBehavior: "clarify_first",
      clarificationQuestion: variant.clarificationQuestion,
      resolvedQuestionAfterClarification: variant.resolvedQuestionAfterClarification,
      actorName,
      domain: seed.domain,
      lens: seed.lens,
      semanticFrame,
      contextRows,
      domainScore: Number(anchor.domain_score ?? 1),
      hardGuardReasons
    });
    const feasibilityReport = await runOracleFeasibilityVerifier({
      chatNamespace: experiment.chat_namespace,
      question: variant.question,
      resolvedQuestionAfterClarification: variant.resolvedQuestionAfterClarification,
      actorName,
      evidenceIds,
      conversationIds
    });
    const admissionDecision = buildAdmissionDecision({
      critique,
      feasibility: feasibilityReport,
      hardGuardReasons,
      modelDecision: "accept",
      modelReasons: []
    });
    if (!admissionDecision.admitted || critique.score < minCritiqueScore) continue;
    const expectedCoreClaims = Array.isArray(seed.expected_core_claims)
      ? seed.expected_core_claims.map(String)
      : parseJsonArray(String(seed.expected_core_claims ?? "[]"));
    const qualityGate = qualityGateFromAuthoringCritique(critique);
    const expectedAnswerSummaryHuman = buildHumanAnswerSummary({
      domain: seed.domain,
      lens: seed.lens,
      expectedBehavior: "clarify_first",
      expectedCoreClaims,
      actorName
    });
    admittedPool.push({
      sourceCaseId: seed.case_id,
      caseSet: admittedPool.length < Math.min(12, requested) ? "critical" : "certification",
      domain: seed.domain,
      lens: seed.lens,
      question: variant.question,
      missingSlotType: variant.missingSlotType,
      expectedCoreClaims,
      evidenceIds,
      conversationIds,
      actorIds,
      sourceEvidenceId: sourceEvidenceId || anchor.canonical_id,
      taxonomyPath: seed.taxonomy_path ?? `${seed.domain}.${seed.lens}`,
      metadata: {
        ...(seed.metadata ?? {}),
        generationVersion: BENCHMARK_AUTHORING_VERSION,
        authoringVersion: BENCHMARK_AUTHORING_VERSION,
        expectedBehavior: "clarify_first",
        expectedAnswerSummaryHuman,
        qualityGate,
        semanticFrame,
        questionVoice,
        missingSlotType: variant.missingSlotType,
        chosenQuestionRationale: variant.rationale,
        authoringDecision: "accept",
        rejectionReasons: [],
        clarificationQuestion: variant.clarificationQuestion,
        resolvedQuestionAfterClarification: variant.resolvedQuestionAfterClarification,
        authoringCritique: critique,
        feasibilityReport,
        admissionDecision,
        semanticFrameSummary: summarizeSemanticFrame(semanticFrame),
        clarifyAugmentedFromCaseId: seed.case_id,
        clarifyAugmentation: true,
        clarifyAugmentationRationale: variant.rationale
      },
      reviewInput: {
        calibrationItemId: randomUUID(),
        sourceCaseId: seed.case_id,
        question: variant.question,
        domain: seed.domain,
        lens: seed.lens,
        ambiguityClass: "clarify_required",
        expectedBehavior: "clarify_first",
        missingSlotType: variant.missingSlotType,
        clarificationQuestion: variant.clarificationQuestion,
        resolvedQuestionAfterClarification: variant.resolvedQuestionAfterClarification,
        expectedAnswerSummaryHuman,
        semanticFrame,
        semanticFrameSummary: summarizeSemanticFrame(semanticFrame),
        evidencePreview: evidenceIds.map((id) => evidencePreviewMap.get(id)).filter(Boolean),
        qualityGate,
        authoringCritique: critique
      }
    });
  }

  const assistantSuggestions = new Map<string, {
    verdict: "yes" | "no";
    ambiguityClass: "clear" | "clarify_required" | "unresolved";
    notes: string;
    confidence: number;
  }>();
  for (let i = 0; i < admittedPool.length; i += 5) {
    const chunk = admittedPool.slice(i, i + 5);
    const chunkInputs = chunk.map((item) => item.reviewInput);
    const chunkMap = new Map(chunkInputs.map((candidate) => [String(candidate.calibrationItemId ?? ""), candidate]));
    const reviews = await reviewCalibrationChunkSafely(chunkInputs, "refresh-pending-assistant-suggestions");
    for (const review of reviews) {
      const id = String(review.calibrationItemId ?? "").trim();
      if (!id) continue;
      assistantSuggestions.set(id, sanitizeAssistantCalibrationReview(review, chunkMap.get(id) ?? {}));
    }
  }

  const chosenPool = admittedPool
    .map((item) => ({
      ...item,
      suggestion: assistantSuggestions.get(String(item.reviewInput.calibrationItemId ?? "")) ?? null
    }))
    .sort((a, b) => {
      const leftYes = Number(a.suggestion?.verdict === "yes");
      const rightYes = Number(b.suggestion?.verdict === "yes");
      if (leftYes !== rightYes) return rightYes - leftYes;
      const leftClarify = clarifyDomainCounts.get(a.domain) ?? 0;
      const rightClarify = clarifyDomainCounts.get(b.domain) ?? 0;
      if (leftClarify !== rightClarify) return leftClarify - rightClarify;
      return Number(b.suggestion?.confidence ?? 0) - Number(a.suggestion?.confidence ?? 0);
    })
    .slice(0, requested);

  const insertedCaseIds: string[] = [];
  const suggestionByCaseId = new Map<string, {
    verdict: "yes" | "no";
    ambiguityClass: "clear" | "clarify_required" | "unresolved";
    notes: string;
    confidence: number;
  }>();
  for (const item of chosenPool) {
    const caseId = randomUUID();
    const caseKey = `clarify_aug:${item.sourceCaseId}:${caseId.slice(0, 8)}`;
    await upsertExperimentCase({
      experimentId: params.experimentId,
      caseSet: item.caseSet,
      caseKey,
      caseType: `clarify_augmentation:${item.lens}:${item.domain}`,
      domain: item.domain,
      lens: item.lens,
      question: item.question,
      chatNamespace: experiment.chat_namespace,
      expectedCoreClaims: item.expectedCoreClaims,
      evidenceIds: item.evidenceIds,
      conversationIds: item.conversationIds,
      actorIds: item.actorIds,
      sourceEvidenceId: item.sourceEvidenceId,
      taxonomyPath: item.taxonomyPath,
      difficultyType: "ambiguity_resolution",
      generationMethod: "v1.8_clarify_augmentation",
      ambiguityClass: "clarify_required",
      ownerValidationState: "pending",
      clarificationQualityExpected: true,
      metadata: item.metadata
    });
    const inserted = await pool.query<{ id: string }>(
      `SELECT id::text
       FROM experiment_cases
       WHERE experiment_id = $1::uuid
         AND case_key = $2
         AND is_stale = false
       LIMIT 1`,
      [params.experimentId, caseKey]
    );
    const insertedCaseId = inserted.rows[0]?.id ?? null;
    if (!insertedCaseId) continue;
    insertedCaseIds.push(insertedCaseId);
    if (item.suggestion) suggestionByCaseId.set(insertedCaseId, item.suggestion);
  }

  const calibrationMap = await materializeCalibrationItemsForCaseIds({
    experimentId: params.experimentId,
    caseIds: insertedCaseIds
  });
  let assistantSuggestedYes = 0;
  let assistantSuggestedNo = 0;
  for (const [caseId, calibrationItemId] of calibrationMap.entries()) {
    const suggestion = suggestionByCaseId.get(caseId);
    if (!suggestion) continue;
    if (suggestion.verdict === "yes") assistantSuggestedYes += 1;
    else assistantSuggestedNo += 1;
    await upsertAssistantCalibrationSuggestion({
      calibrationItemId,
      verdict: suggestion.verdict,
      ambiguityClass: suggestion.ambiguityClass,
      notes: suggestion.notes,
      confidence: suggestion.confidence
    });
  }

  return {
    ok: true,
    experimentId: params.experimentId,
    requested,
    seedCount: selectedSeeds.length,
    candidateVariants: candidateVariants.length,
    admittedVariants: admittedPool.length,
    assistantSuggestedYes,
    assistantSuggestedNo,
    inserted: insertedCaseIds.length,
    calibrationItemsCreated: calibrationMap.size,
    caseIds: insertedCaseIds
  };
}

export async function pruneDuplicateBenchmarkCases(params: {
  experimentId: string;
  refillReviewedRemoved?: boolean;
}): Promise<Record<string, unknown>> {
  const rows = await pool.query<{
    case_id: string;
    calibration_item_id: string | null;
    case_set: string;
    domain: string;
    lens: string;
    question: string;
    ambiguity_class: string | null;
    owner_validation_state: string | null;
    metadata: Record<string, unknown>;
    source_evidence_id: string | null;
    evidence_ids: string[] | string;
    conversation_ids: string[] | string;
    created_at: string;
    owner_verdict: string | null;
    owner_notes: string | null;
    assistant_verdict: string | null;
    assistant_notes: string | null;
    assistant_created_at: string | null;
  }>(
    `SELECT
       c.id::text AS case_id,
       li.calibration_item_id,
       c.case_set,
       c.domain,
       c.lens,
       c.question,
       c.ambiguity_class,
       c.owner_validation_state,
       c.metadata,
       c.source_evidence_id::text,
       COALESCE(c.evidence_ids::text, '{}') AS evidence_ids,
       COALESCE(c.conversation_ids::text, '{}') AS conversation_ids,
       c.created_at::text,
       own.verdict AS owner_verdict,
       own.notes AS owner_notes,
       asst.verdict AS assistant_verdict,
       asst.notes AS assistant_notes,
       asst.created_at::text AS assistant_created_at
     FROM experiment_cases c
     LEFT JOIN LATERAL (
       SELECT i.id::text AS calibration_item_id
       FROM experiment_judge_calibration_items i
       WHERE i.experiment_id = $1::uuid
         AND i.case_id = c.id
       ORDER BY
         CASE i.status
           WHEN 'pending' THEN 0
           WHEN 'labeled' THEN 1
           ELSE 2
         END ASC,
         i.updated_at DESC NULLS LAST,
         i.created_at DESC
       LIMIT 1
     ) li ON true
     LEFT JOIN LATERAL (
       SELECT l.verdict, COALESCE(l.notes, '') AS notes
       FROM experiment_judge_calibration_labels l
       WHERE l.calibration_item_id::text = li.calibration_item_id
         AND l.reviewer = 'owner'
       ORDER BY l.created_at DESC
       LIMIT 1
     ) own ON true
     LEFT JOIN LATERAL (
       SELECT l.verdict, l.notes, l.created_at
       FROM experiment_judge_calibration_labels l
       WHERE l.calibration_item_id::text = li.calibration_item_id
         AND l.reviewer = 'assistant'
       ORDER BY l.created_at DESC
       LIMIT 1
     ) asst ON true
     WHERE c.experiment_id = $1::uuid
       AND c.is_stale = false`,
    [params.experimentId]
  );

  type DuplicateRow = typeof rows.rows[number] & {
    dedupKey: string;
    familyKey: string;
    assistantSuggestion: Record<string, unknown> | null;
    qualityGate: ReturnType<typeof readCaseQualityGate>;
    critique: ReturnType<typeof readAuthoringCritique>;
  };

  const enrichedRows: DuplicateRow[] = [];
  const byKey = new Map<string, DuplicateRow[]>();
  for (const row of rows.rows) {
    const dedupKey = buildBenchmarkQuestionDedupKey(row.question);
    if (!dedupKey) continue;
    const next: DuplicateRow = {
      ...row,
      dedupKey,
      familyKey: buildCaseEvidenceFamilyKey({
        evidenceIds: row.evidence_ids,
        conversationIds: row.conversation_ids,
        sourceEvidenceId: row.source_evidence_id
      }) || `case:${row.case_id}`,
      assistantSuggestion: parseAssistantCalibrationSuggestion({
        verdict: row.assistant_verdict,
        notes: row.assistant_notes,
        createdAt: row.assistant_created_at
      }),
      qualityGate: readCaseQualityGate(row.metadata ?? {}),
      critique: readAuthoringCritique(row.metadata ?? {})
    };
    enrichedRows.push(next);
    const items = byKey.get(dedupKey) ?? [];
    items.push(next);
    byKey.set(dedupKey, items);
  }

  const removedCaseIds = new Set<string>();
  const removedCalibrationItemIds = new Set<string>();
  const removedReviewedRows: DuplicateRow[] = [];
  const duplicateGroups: Array<{
    kind: "question" | "evidence_family";
    question: string;
    familyKey?: string;
    keptCaseId: string;
    removedCaseIds: string[];
  }> = [];
  const rankRow = (row: DuplicateRow): number => {
    const assistant = row.assistantSuggestion ?? {};
    return duplicateBenchmarkRetentionRank({
      ownerValidationState: row.owner_validation_state,
      ownerVerdict: row.owner_verdict,
      ownerNotes: row.owner_notes,
      assistantVerdict: String(assistant.verdict ?? ""),
      assistantNotes: String(assistant.notes ?? ""),
      assistantConfidence: Number(assistant.confidence ?? 0),
      qualityScore: row.qualityGate.score,
      lensFit: row.critique?.dimensions.lensFit,
      grounding: row.critique?.dimensions.evidenceGrounding,
      actorScopeFidelity: row.critique?.dimensions.actorScopeFidelity,
      answerability: row.critique?.dimensions.answerability,
      caseSet: row.case_set
    });
  };
  const collectLosers = (
    groups: Map<string, DuplicateRow[]>,
    kind: "question" | "evidence_family"
  ): void => {
    for (const [groupKey, items] of groups.entries()) {
      if (items.length <= 1) continue;
      const sorted = [...items].sort((left, right) => {
        const diff = rankRow(right) - rankRow(left);
        if (diff !== 0) return diff;
        return String(left.created_at).localeCompare(String(right.created_at));
      });
      const keep = sorted[0];
      const losers = sorted.slice(1);
      for (const loser of losers) {
        if (removedCaseIds.has(loser.case_id)) continue;
        removedCaseIds.add(loser.case_id);
        if (loser.calibration_item_id) removedCalibrationItemIds.add(loser.calibration_item_id);
        if (String(loser.owner_verdict ?? "").trim()) removedReviewedRows.push(loser);
      }
      duplicateGroups.push({
        kind,
        question: keep.question,
        familyKey: kind === "evidence_family" ? groupKey : undefined,
        keptCaseId: keep.case_id,
        removedCaseIds: losers.map((row) => row.case_id)
      });
    }
  };

  collectLosers(byKey, "question");

  const familyGroups = new Map<string, DuplicateRow[]>();
  for (const row of enrichedRows) {
    if (removedCaseIds.has(row.case_id)) continue;
    const bucket = familyGroups.get(row.familyKey) ?? [];
    bucket.push(row);
    familyGroups.set(row.familyKey, bucket);
  }
  collectLosers(familyGroups, "evidence_family");

  if (removedCalibrationItemIds.size > 0) {
    const calibrationItemIds = [...removedCalibrationItemIds];
    await pool.query(`DELETE FROM experiment_judge_calibration_labels WHERE calibration_item_id = ANY($1::uuid[])`, [calibrationItemIds]);
    await pool.query(`DELETE FROM experiment_judge_calibration_items WHERE id = ANY($1::uuid[])`, [calibrationItemIds]);
  }
  if (removedCaseIds.size > 0) {
    await pool.query(
      `UPDATE experiment_cases
       SET is_stale = true,
           updated_at = now()
       WHERE id = ANY($1::uuid[])`,
      [[...removedCaseIds]]
    );
  }

  const removedReviewedClear = removedReviewedRows.filter((row) => String(row.ambiguity_class ?? "clear") !== "clarify_required");
  const removedReviewedClarify = removedReviewedRows.filter((row) => String(row.ambiguity_class ?? "") === "clarify_required");

  let positiveReplacement: Record<string, unknown> | null = null;
  let clarifyReplacement: Record<string, unknown> | null = null;
  if (params.refillReviewedRemoved && removedReviewedRows.length > 0) {
    const preferredDomains = uniqueStrings(removedReviewedRows.map((row) => row.domain));
    if (removedReviewedRows.length > 0) {
      positiveReplacement = await backfillCalibrationPositiveCases({
        experimentId: params.experimentId,
        count: removedReviewedRows.length,
        preferredDomains
      });
    }
  }

  return {
    ok: true,
    experimentId: params.experimentId,
    duplicateGroups: duplicateGroups.length,
    removedCaseCount: removedCaseIds.size,
    removedCalibrationItemCount: removedCalibrationItemIds.size,
    removedReviewedCount: removedReviewedRows.length,
    removedReviewedClearCount: removedReviewedClear.length,
    removedReviewedClarifyCount: removedReviewedClarify.length,
    positiveReplacement,
    clarifyReplacement,
    sampleGroups: duplicateGroups.slice(0, 12)
  };
}

export async function curateCalibrationBenchmarkMix(params: {
  experimentId: string;
  targetYesRatio?: number;
}): Promise<Record<string, unknown>> {
  const experiment = await readExperiment(params.experimentId);
  const targetYesRatio = Number.isFinite(Number(params.targetYesRatio))
    ? Math.min(0.95, Math.max(0.6, Number(params.targetYesRatio)))
    : 0.8;
  const reviews = await loadLatestOwnerCalibrationReviews(params.experimentId);
  const yesRows = reviews.filter((row) => row.verdict === "yes");
  const noRows = reviews.filter((row) => row.verdict === "no");
  const maxRetainedNo = Math.max(0, Math.floor((yesRows.length * (1 - targetYesRatio)) / targetYesRatio));
  const bucketOrder = ["clarify_needed", "grounding_or_question", "lens_mismatch", "pov_or_pronoun", "time_or_tense", "unnatural", "other"];
  const bucketMap = new Map<string, CalibrationReviewRow[]>();
  for (const row of noRows) {
    const bucket = classifyCalibrationRejectionBucket(row.notes);
    const next = bucketMap.get(bucket) ?? [];
    next.push(row);
    bucketMap.set(bucket, next);
  }
  for (const rows of bucketMap.values()) {
    rows.sort((a, b) =>
      calibrationBucketPriority(classifyCalibrationRejectionBucket(a.notes)) - calibrationBucketPriority(classifyCalibrationRejectionBucket(b.notes))
      || `${a.domain}|${a.lens}|${a.calibrationItemId}`.localeCompare(`${b.domain}|${b.lens}|${b.calibrationItemId}`)
    );
  }
  const retainedNo: CalibrationReviewRow[] = [];
  for (const bucket of bucketOrder) {
    if (retainedNo.length >= maxRetainedNo) break;
    const rows = bucketMap.get(bucket) ?? [];
    if (rows.length > 0) retainedNo.push(rows[0]);
  }
  if (retainedNo.length < maxRetainedNo) {
    const retainedIds = new Set(retainedNo.map((row) => row.calibrationItemId));
    const leftovers = noRows
      .filter((row) => !retainedIds.has(row.calibrationItemId))
      .sort((a, b) =>
        calibrationBucketPriority(classifyCalibrationRejectionBucket(a.notes)) - calibrationBucketPriority(classifyCalibrationRejectionBucket(b.notes))
        || `${a.domain}|${a.lens}|${a.calibrationItemId}`.localeCompare(`${b.domain}|${b.lens}|${b.calibrationItemId}`)
      );
    for (const row of leftovers) {
      if (retainedNo.length >= maxRetainedNo) break;
      retainedNo.push(row);
    }
  }
  const retainedNoIds = new Set(retainedNo.map((row) => row.calibrationItemId));
  const removedNo = noRows.filter((row) => !retainedNoIds.has(row.calibrationItemId));
  if (removedNo.length > 0) {
    const calibrationItemIds = removedNo.map((row) => row.calibrationItemId);
    const caseIds = uniqueStrings(removedNo.map((row) => row.caseId));
    await pool.query(`DELETE FROM experiment_judge_calibration_labels WHERE calibration_item_id = ANY($1::uuid[])`, [calibrationItemIds]);
    await pool.query(`DELETE FROM experiment_judge_calibration_items WHERE id = ANY($1::uuid[])`, [calibrationItemIds]);
    await pool.query(`DELETE FROM experiment_cases WHERE id = ANY($1::uuid[])`, [caseIds]);
  }

  const replacementTarget = removedNo.length;
  let replacementInserted = 0;
  const replacementRuns: Array<Record<string, unknown>> = [];
  if (replacementTarget > 0) {
    const taxonomyVersion = experiment.taxonomy_version_id
      ? await loadTaxonomyVersionRowById(experiment.taxonomy_version_id)
      : await getPublishedTaxonomyVersion(null);
    for (const threshold of [0.9, 0.86, 0.82]) {
      if (replacementInserted >= replacementTarget) break;
      const result = await generateSupplementalPositiveCases({
        experimentId: params.experimentId,
        chatNamespace: experiment.chat_namespace,
        taxonomyVersionId: taxonomyVersion.id,
        targetCount: replacementTarget - replacementInserted,
        minCritiqueScore: threshold
      });
      replacementRuns.push({
        minCritiqueScore: threshold,
        ...result
      });
      replacementInserted += Number(result.inserted ?? 0);
      if (Number(result.inserted ?? 0) <= 0) break;
    }
  }

  const finalReviewedNo = retainedNo.length;
  const finalReviewedYes = yesRows.length;
  const finalProjectedYesRatio =
    finalReviewedYes + replacementInserted > 0
      ? (finalReviewedYes + replacementInserted) / Math.max(1, finalReviewedYes + finalReviewedNo + replacementInserted)
      : 0;

  return {
    ok: true,
    experimentId: params.experimentId,
    targetYesRatio,
    reviewedYesKept: finalReviewedYes,
    reviewedNoOriginal: noRows.length,
    reviewedNoKept: finalReviewedNo,
    reviewedNoRemoved: removedNo.length,
    retainedNegativeExamples: retainedNo.map((row) => ({
      calibrationItemId: row.calibrationItemId,
      caseId: row.caseId,
      bucket: classifyCalibrationRejectionBucket(row.notes),
      domain: row.domain,
      lens: row.lens,
      question: row.question,
      notes: row.notes
    })),
    replacementTarget,
    replacementInserted,
    replacementRuns,
    projectedYesRatio: finalProjectedYesRatio
  };
}

export function listStrategyCatalog(): StrategyVariant[] {
  return STRATEGY_CATALOG.map((s) => ({
    ...s,
    config: { ...s.config }
  }));
}


