export type V2ArtifactState = "candidate" | "validated" | "published" | "deprecated";

export type V2Decision = "promote" | "hold" | "reject" | "retry" | "deprecate";

export type V2AgentName =
  | "controller_agent"
  | "ingestion_qa_agent"
  | "entity_resolution_agent"
  | "fact_consistency_agent"
  | "temporal_reasoning_agent"
  | "contradiction_agent"
  | "privacy_policy_agent"
  | "sufficiency_agent"
  | "answer_critic_agent"
  | "quality_adjudicator_agent";

export type V2MessageType =
  | "ask"
  | "retrieve"
  | "evaluate"
  | "adjudicate"
  | "correct"
  | "audit"
  | "response"
  | "signal";

export type V2AnswerStatus = "definitive" | "estimated" | "partial" | "insufficient" | "clarification_needed";
export type V2AskDecision = "answer_now" | "clarify_first" | "insufficient";

export interface V2AgentRequestEnvelope {
  schemaVersion: string;
  messageId: string;
  traceId: string;
  conversationId: string;
  fromAgent: V2AgentName;
  toAgent: V2AgentName;
  messageType: V2MessageType;
  intent: string;
  payload: Record<string, unknown>;
  constraints: Record<string, unknown>;
  context: Record<string, unknown>;
  createdAt: string;
}

export interface V2AgentResponseEnvelope {
  schemaVersion: string;
  messageId: string;
  traceId: string;
  inReplyTo: string;
  fromAgent: V2AgentName;
  toAgent: V2AgentName;
  messageType: V2MessageType;
  status: "ok" | "retry" | "failed";
  decision: V2Decision;
  confidence: number;
  reasons: string[];
  outputs: Record<string, unknown>;
  qualitySignals: Record<string, unknown>;
  createdAt: string;
}

export interface V2AskRequest {
  question: string;
  clarificationResponse?: string;
  chatNamespace?: string;
  timeframe?: "7d" | "30d" | "90d" | "365d" | "all";
  mode?: "lookup" | "pattern" | "diagnosis" | "prediction" | "recommendation";
  maxLoops?: number;
  conversationId?: string;
  privacyMode?: "private" | "share_safe" | "demo";
  debugMode?: boolean;
  context?: Record<string, unknown>;
  strategyConfig?: StrategyVariantConfig;
}

export interface V2ConstraintCheck {
  name: string;
  passed: boolean;
  note: string;
}

export interface V2FinalAnswer {
  direct: string | null;
  estimate: string | null;
  confidence: "low" | "medium" | "high";
  contradictionCallout: string | null;
  definitiveNextData: string;
}

export interface V2AnswerContract {
  decision: V2AskDecision;
  intentSummary: string;
  requiresClarification: boolean;
  clarificationQuestion: string | null;
  assumptionsUsed: string[];
  constraintChecks: V2ConstraintCheck[];
  finalAnswer: V2FinalAnswer | null;
  status: V2AnswerStatus;
}

export interface V2EvidenceRef {
  memoryId: string;
  canonicalId?: string | null;
  sourceMessageId?: string | null;
  replyToMessageId?: string | null;
  sourceSystem: string;
  role?: string;
  actorId?: string | null;
  actorType?: string | null;
  sourceConversationId?: string | null;
  sourceTimestamp: string | null;
  entityLabel?: string | null;
  excerpt: string;
  similarity: number;
  contextRole?: "direct" | "indirect" | "uncertain";
  qualityState: V2ArtifactState;
}

export interface V2AskResponse {
  ok: true;
  traceId: string;
  answerRunId: string;
  decision: V2Decision;
  answerContract: V2AnswerContract;
  answer: V2AnswerContract;
  qualitySignals: Record<string, unknown>;
  evidence: V2EvidenceRef[];
  debugTrace?: {
    runId: string;
    traceUrl: string;
  };
}

export interface V2RetrievalAnchor {
  canonicalId: string;
  memoryId: string;
  conversationId: string;
  sourceSystem: string;
  sourceMessageId: string | null;
  replyToMessageId: string | null;
  actorId: string | null;
  actorType: string | null;
  actorName: string | null;
  role: string | null;
  sourceTimestamp: string | null;
  excerpt: string;
  score: number;
  matchType: "lexical" | "vector" | "hybrid";
}

export interface V2ContextMessage {
  canonicalId: string;
  memoryId: string;
  conversationId: string;
  sourceMessageId: string | null;
  replyToMessageId: string | null;
  actorId: string | null;
  actorType: string | null;
  actorName: string | null;
  role: string | null;
  sourceSystem: string;
  sourceTimestamp: string | null;
  excerpt: string;
  sequence: number;
}

export interface V2FeedbackRequest {
  answerRunId?: string;
  traceId?: string;
  verdict: "yes" | "no" | "partial";
  correction?: string;
  correctedValue?: Record<string, unknown>;
  asOfDate?: string;
  scope?: string;
}

export interface V2QualityEvaluateRequest {
  artifactType: "canonical_message" | "entity" | "fact" | "relationship" | "insight";
  artifactId?: string;
  payload: Record<string, unknown>;
  confidence?: number;
  traceId?: string;
  reasons?: string[];
}

export interface V2QualityEvaluateResponse {
  ok: true;
  decision: V2Decision;
  confidence: number;
  reasons: string[];
  qualityDecisionId: string;
}

export interface V2QualityAdjudicateRequest {
  artifactType: "canonical_message" | "entity" | "fact" | "relationship" | "insight";
  artifactId: string;
  decision: V2Decision;
  confidence: number;
  reasons?: string[];
  traceId?: string;
}

export interface V2BenchGenerateRequest {
  benchmarkSet?: string;
  variantsPerDomainLens?: number;
}

export interface V2BenchRunRequest {
  benchmarkSet?: string;
  limit?: number;
  chatNamespace?: string;
  dataAwareOnly?: boolean;
  minDomainScore?: number;
  minDomainRows?: number;
}

export interface V2BenchSignalProfileRequest {
  benchmarkSet?: string;
  chatNamespace?: string;
  minDomainScore?: number;
  minDomainRows?: number;
}

export interface V2ServiceRegisterRequest {
  serviceName: string;
  description?: string;
  permissions: Array<{
    namespacePattern: string;
    domain: string;
    operation: string;
  }>;
  metadata?: Record<string, unknown>;
}

export interface V2ServiceTokenRequest {
  serviceId: string;
  ttlSec?: number;
}

export interface V2Principal {
  kind: "session" | "service";
  userName?: string;
  serviceId?: string;
  serviceName?: string;
}

export interface V2BootstrapResult {
  canonicalized: number;
  published: number;
  quarantined: number;
}

export type RetrievalMode = "baseline" | "vector" | "lexical" | "hybrid" | "hybrid_rerank";
export type ContextMode = "anchor_only" | "window" | "window_thread" | "adaptive";
export type PlannerMode = "baseline" | "single_agent_minimal" | "single_agent_sequential" | "mesh_lean";
export type ComposerMode = "heuristic" | "minimal_llm";
export type RefinementMode = "fixed" | "adaptive";
export type ExperimentRole = "treatment" | "control" | "explore";
export type CoreComponentType =
  | "query_policy"
  | "retrieval_policy"
  | "ranking_policy"
  | "context_policy"
  | "synthesis_policy";

export interface ComponentSelection {
  componentType: string;
  componentId: string;
  isCore?: boolean;
}

export interface StrategyVariantConfig {
  strategyId: string;
  retrievalMode?: RetrievalMode;
  contextMode?: ContextMode;
  plannerMode?: PlannerMode;
  composerMode?: ComposerMode;
  refinementMode?: RefinementMode;
  maxLoops?: number;
  timeoutMs?: number;
  timeoutRetryLimit?: number;
  rescueOnTimeout?: boolean;
  infraTimeoutRateThreshold?: number;
  infraMinSample?: number;
  infraRetryLimit?: number;
  infraRetryCount?: number;
  noDataRetryLimit?: number;
  noDataRetryCount?: number;
  confidenceGatedRetry?: boolean;
  confidenceRetryThreshold?: "low" | "medium";
  groupId?: number;
  generatedBy?: string;
  researchHypothesis?: string;
  researchWebSnippetCount?: number;
  rescueFromVariantId?: string;
  rescueAttempt?: number;
  rescueAdjustments?: Array<Record<string, unknown>>;
  agentRetryFromVariantId?: string;
  agentRetryReason?: string;
  hypothesisId?: string;
  experimentRole?: ExperimentRole;
  components?: ComponentSelection[];
  extraComponents?: ComponentSelection[];
  parentStrategyVariantId?: string;
  parentHypothesisId?: string;
  modifiedComponents?: string[];
  lineageReason?: string;
  leakageGuardVersion?: string;
}

export interface CaseProvenance {
  caseId: string;
  caseSet: string;
  type: string;
  domain: string;
  question: string;
  chatNamespace: string;
  evidenceIds: string[];
  conversationIds: string[];
  actorIds: string[];
  expectedContract: Record<string, unknown>;
  expectedCoreClaims: string[];
  createdAt: string;
}

export interface FailureBreakdown {
  retrievalMiss: number;
  rankingFailure: number;
  contextExpansionMiss: number;
  threadContinuityMiss: number;
  actorAttributionMiss: number;
  temporalInterpretationMiss: number;
  reasoningSynthesisMiss: number;
  answerFormatMiss: number;
  contradictionHandlingMiss: number;
  provenanceMismatch: number;
  planWindowCompactionMiss: number;
}

export interface EvaluationScorecard {
  strategyId: string;
  variantId: string;
  caseSet: string;
  totalCases: number;
  passedCases: number;
  failedCases: number;
  passRate: number;
  p95LatencyMs: number;
  avgLatencyMs: number;
  estimatedCostPer1kAsks: number;
  recallAtK?: number;
  mrr?: number;
  ndcg?: number;
  evidenceHitRate?: number;
  governanceLeakageCount?: number;
  failureBreakdown: FailureBreakdown;
}

export interface HypothesisRecord {
  hypothesisId: string;
  experimentId: string;
  title: string;
  failurePattern: Record<string, unknown>;
  causalClaim: string;
  predictedMetricChanges: Record<string, unknown>;
  confidence: number;
  status: "open" | "confirmed" | "partially_confirmed" | "rejected";
  createdAt: string;
  updatedAt: string;
}

export interface HypothesisPrediction {
  predictionId: string;
  hypothesisId: string;
  metricKey: string;
  comparator: "gte" | "lte" | "delta_gte" | "delta_lte";
  targetValue: number;
  weight: number;
}

export interface HypothesisEvaluation {
  hypothesisId: string;
  strategyVariantId: string;
  decision: "confirmed" | "partially_confirmed" | "rejected";
  confidenceBefore: number;
  confidenceAfter: number;
  deltas: Record<string, number>;
  rationale: string;
}

export interface ComponentRecord {
  componentId: string;
  componentType: string;
  componentName: string;
  version: number;
  isCore: boolean;
  status: "active" | "deprecated";
  config: Record<string, unknown>;
}

export interface ComponentBinding {
  strategyVariantId: string;
  componentType: string;
  componentId: string;
  bindingOrder: number;
  isCore: boolean;
}

export interface ComponentPerformance {
  componentId: string;
  domain: string;
  lens: string;
  difficultyType: string;
  caseSet: string;
  runs: number;
  passRate: number;
  avgScore: number;
  recallAtK: number;
  ndcg: number;
  evidenceHitRate: number;
  confidence: number;
}

export interface ComponentStability {
  componentId: string;
  runs: number;
  passRateStddev: number;
  score: number;
  confidence: number;
}

export interface ComponentPairPerformance {
  componentAId: string;
  componentBId: string;
  runs: number;
  jointScore: number;
  confidence: number;
}

export interface StrategyLineageRecord {
  strategyVariantId: string;
  parentStrategyVariantId: string | null;
  parentHypothesisId: string | null;
  modifiedComponents: string[];
  lineageReason: string | null;
}

export interface StrategyVariant {
  strategyId: string;
  label: string;
  config: StrategyVariantConfig;
}

export interface ExperimentRun {
  experimentId: string;
  name: string;
  status: "queued" | "running" | "completed" | "failed";
  targetPassRate: number;
  chatNamespace: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface WinnerDecision {
  experimentId: string;
  strategyId: string;
  variantId: string;
  passRate: number;
  p95LatencyMs: number;
  estimatedCostPer1kAsks: number;
  decision: "winner" | "candidate" | "rejected";
  reason: string;
  createdAt: string;
}

export interface V2ExperimentStartRequest {
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
}

export interface V2ExperimentStepRequest {
  experimentId: string;
  variantId?: string;
  caseSet?: "dev" | "critical" | "certification" | "all";
}

export interface EvolutionOverview {
  experimentId: string;
  experiment: {
    id: string;
    name: string;
    status: string;
    chatNamespace: string;
    activeLockVersion: string | null;
    winnerVariantId: string | null;
    taxonomyVersionId?: string | null;
    taxonomyVersionKey?: string | null;
    benchmarkStale?: boolean;
  };
  kpis: {
    currentVariantId: string | null;
    bestVariantId: string | null;
    bestPassRate: number;
    clearPassRate: number;
    clarifyPassRate: number;
    unresolvedAmbiguousRatio: number | null;
    unresolvedDebtPass: boolean;
    queuedCount: number;
    runningCount: number;
    completedCount: number;
    failedCount: number;
    skippedCount: number;
    leakageCount: number;
    timeoutCount: number;
    timeoutRecoveries: number;
    noDataRequeueCount: number;
    rescueRetryCount: number;
    authoringAcceptedCount: number;
    authoringRejectedCount: number;
    authoringUnresolvedCount: number;
    verifierPassRate: number;
    calibrationEligibleCount: number;
    ontologyCandidateBacklog?: number;
    supportCoverageRatio?: number | null;
  };
}

export interface StrategyFrontierPoint {
  strategyId: string;
  variantId: string;
  label: string;
  position: number;
  status: string;
  groupId: number;
  passRate: number;
  latencyP95Ms: number;
  costPer1k: number;
  latencyMultiplier: number;
  costMultiplier: number;
  paretoLatency: boolean;
  paretoCost: boolean;
}

export interface LearningVelocityPoint {
  position: number;
  strategyId: string;
  variantId: string;
  passRate: number;
  bestSoFar: number;
  movingAverage: number;
}

export interface FailureTimeSeriesPoint {
  bucket: string;
  series: number[];
}

export interface ComponentHeatmapCell {
  componentName: string;
  domain: string;
  score: number;
  runs: number;
}

export interface HypothesisOutcomePoint {
  decision: string;
  confidenceAfter: number;
  createdAt: string;
}

export interface DiversityHistogramBin {
  label: string;
  min: number;
  max: number;
  count: number;
}

export interface CoverageSummary {
  experimentId: string;
  lockVersion: string | null;
  expectedEvidenceCount: number;
  touchedEvidenceCount: number;
  coverageRatio: number;
}

export interface ExperimentListItem {
  id: string;
  name: string;
  status: string;
  createdAt: string;
  activeLockVersion: string | null;
  latestPassRate: number | null;
  taxonomyVersionId?: string | null;
  taxonomyVersionKey?: string | null;
  queueCounts: {
    queued: number;
    running: number;
    completed: number;
    failed: number;
    pendingCalibration: number;
  };
}

export interface CaseQualityGateResult {
  status: "pass" | "fail";
  score: number;
  reasons: string[];
  dimensions: {
    naturalness: number;
    answerability: number;
    ambiguityCorrectness: number;
    evidenceGrounding: number;
  };
}

export interface BenchmarkSemanticFrame {
  domain: string;
  lens: string;
  participants: string[];
  actorScope: string | null;
  statementOwnerName: string | null;
  statementOwnerRole: "user" | "other_human" | "assistant_or_system" | "mixed";
  preferredQuestionVoices: Array<"user_first_person" | "user_about_other" | "assistant_proxy">;
  timeframe: string;
  conversationIntent: string;
  topicSummary: string;
  supportDepth: "thin" | "moderate" | "rich";
  ambiguityRisk: "low" | "medium" | "high";
  supportedLenses: string[];
}

export interface BenchmarkAuthoringCritique {
  pass: boolean;
  score: number;
  reasons: string[];
  dimensions: {
    naturalness: number;
    actorScopeFidelity: number;
    ambiguityCorrectness: number;
    answerability: number;
    lensFit: number;
    evidenceGrounding: number;
  };
}

export interface BenchmarkFeasibilityReport {
  version: string;
  verifiedQuestion: string;
  pass: boolean;
  modesTried: string[];
  exactEvidenceHit: boolean;
  conversationHit: boolean;
  actorConstrainedHit: boolean;
  topHits: Array<{
    mode: string;
    canonicalId: string | null;
    conversationId: string | null;
    actorName: string | null;
    score: number;
  }>;
  rationale: string;
}

export interface BenchmarkAdmissionDecision {
  admitted: boolean;
  status: "accepted" | "rejected" | "unresolved";
  reasons: string[];
  verifierVersion: string;
}

export interface BenchmarkAuthoringDraft {
  authoringVersion: string;
  semanticFrame: BenchmarkSemanticFrame;
  authoringDecision?: "accept" | "reject";
  rejectionReasons?: string[];
  questionVoice?: "user_first_person" | "user_about_other" | "assistant_proxy" | "unknown";
  candidateQuestions: Array<{
    kind: string;
    question: string;
    rationale: string;
    expectedBehavior: "answer_now" | "clarify_first";
    clarificationQuestion: string | null;
    resolvedQuestionAfterClarification: string | null;
  }>;
  chosenQuestion: string;
  chosenQuestionRationale: string;
  expectedBehavior: "answer_now" | "clarify_first";
  clarificationQuestion: string | null;
  resolvedQuestionAfterClarification: string | null;
  expectedAnswerSummaryHuman: string;
  authoringCritique: BenchmarkAuthoringCritique;
}

export interface PreloopReadiness {
  experimentId: string;
  activeLockVersion: string | null;
  taxonomy: {
    versionId: string | null;
    versionKey: string | null;
    scanCompletedAt: string | null;
    supportCoverageRatio: number | null;
    candidateBacklog: number;
    benchmarkStale: boolean;
  };
  queueCounts: {
    pending: number;
    labeled: number;
    skipped: number;
  };
  datasetCounts: {
    total: number;
    clear: number;
    clarifyRequired: number;
    unresolved: number;
  };
  ambiguityCounts: {
    clear: number;
    clarifyRequired: number;
    unresolved: number;
  };
  authoringCounts: {
    accepted: number;
    rejected: number;
    unresolved: number;
  };
  lockEligibilityCounts: {
    approvedClear: number;
    approvedClarifyRequired: number;
    pendingOwner: number;
    rejected: number;
    eligibleForScoring: number;
    calibrationEligible: number;
  };
  metrics: {
    clearPassRate: number;
    clarifyPassRate: number;
    unresolvedAmbiguousRatio: number;
    verifierPassRate: number;
  };
  gates: {
    clearPassTarget: number;
    clarifyPassTarget: number;
    unresolvedDebtMax: number;
    clearGatePass: boolean;
    clarifyGatePass: boolean;
    debtGatePass: boolean;
    noPendingOwnerPass: boolean;
    noPendingCalibrationPass: boolean;
    readyForLock: boolean;
    readyForStart: boolean;
  };
}

export interface PreloopQueueItem {
  calibrationItemId: string;
  caseId: string;
  domain: string;
  lens: string;
  caseSet: string;
  question: string;
  expectedBehavior: "answer_now" | "clarify_first";
  semanticFrame: BenchmarkSemanticFrame | null;
  semanticFrameSummary: string;
  clarificationQuestion: string | null;
  resolvedQuestionAfterClarification: string | null;
  expectedAnswerSummaryHuman: string;
  evidencePreview: Array<{
    evidenceId: string;
    actorName: string | null;
    observedAt: string | null;
    sourceSystem: string;
    snippet: string;
  }>;
  authoringCritique: BenchmarkAuthoringCritique | null;
  feasibilityReport: BenchmarkFeasibilityReport | null;
  admissionDecision: BenchmarkAdmissionDecision | null;
  qualityGate: CaseQualityGateResult;
  ambiguityClass: "clear" | "clarify_required" | "unresolved";
  ownerValidationState: "pending" | "approved" | "rejected" | "not_required";
  createdAt: string;
}

export interface PreloopDecisionPayload {
  calibrationItemId: string;
  verdict: "yes" | "no";
  ambiguityClass: "clear" | "clarify_required" | "unresolved";
  notes?: string;
}

export interface TaxonomyVersion {
  id: string;
  versionKey: string;
  name: string;
  status: "published" | "archived";
  sourceChatNamespace: string;
  parentVersionId: string | null;
  scanCompletedAt: string | null;
  publishedAt: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface TaxonomyDomain {
  taxonomyVersionId: string;
  domainKey: string;
  label: string;
  status: "active" | "deprecated";
  metadata: Record<string, unknown>;
}

export interface TaxonomyLens {
  taxonomyVersionId: string;
  lensKey: string;
  label: string;
  status: "active" | "deprecated";
  metadata: Record<string, unknown>;
}

export interface TaxonomyPairSupport {
  taxonomyVersionId: string;
  chatNamespace: string;
  domainKey: string;
  lensKey: string;
  supportStatus: "supported" | "unsupported";
  evidenceCount: number;
  supportCount: number;
  avgDomainScore: number;
  sampleEvidenceIds: string[];
  sampleConversationIds: string[];
  rationale: string | null;
  metadata: Record<string, unknown>;
  updatedAt: string;
}

export interface TaxonomyFacetCoverageRow {
  taxonomyVersionId: string;
  chatNamespace: string;
  facetType: "actor_name" | "group_label" | "thread_title" | "source_system" | "month_bucket";
  facetKey: string;
  facetLabel: string;
  coverageStatus: "covered" | "gap" | "sparse";
  evidenceCount: number;
  conversationCount: number;
  benchmarkCaseCount: number;
  sampleEvidenceIds: string[];
  sampleConversationIds: string[];
  rationale: string | null;
  metadata: Record<string, unknown>;
  updatedAt: string;
}

export interface TaxonomyFacetCoverageSummary {
  totalRows: number;
  coveredRows: number;
  gapRows: number;
  sparseRows: number;
  byFacetType: Array<{
    facetType: string;
    totalRows: number;
    coveredRows: number;
    gapRows: number;
    sparseRows: number;
  }>;
}

export interface OntologyCandidate {
  id: string;
  taxonomyVersionId: string;
  candidateType: "new_domain_candidate" | "new_lens_candidate" | "merge_candidate" | "split_candidate" | "unmapped_cluster";
  status: "pending" | "approved" | "rejected" | "deferred";
  sourceDomainKey: string | null;
  sourceLensKey: string | null;
  proposedKey: string | null;
  title: string;
  rationale: string;
  recommendationConfidence: number;
  evidenceIds: string[];
  conversationIds: string[];
  payload: Record<string, unknown>;
  reviewNotes: string | null;
  reviewedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface OntologyCandidateReview {
  candidateId: string;
  decision: "approved" | "rejected" | "deferred";
  targetKey?: string;
  notes?: string;
}

export interface OntologyDriftSummary {
  taxonomyVersionId: string;
  chatNamespace: string;
  supportedPairs: number;
  unsupportedPairs: number;
  supportCoverageRatio: number;
  candidateBacklog: number;
  repeatedMismatchCount: number;
  latestScanAt: string | null;
  facetSummary?: TaxonomyFacetCoverageSummary;
}

export interface BenchmarkFreshnessStatus {
  experimentId: string;
  taxonomyVersionId: string | null;
  taxonomyVersionKey: string | null;
  latestPublishedVersionId: string | null;
  latestPublishedVersionKey: string | null;
  benchmarkGeneratedAt: string | null;
  benchmarkSupportScannedAt: string | null;
  latestScanCompletedAt: string | null;
  benchmarkStale: boolean;
  reasons: string[];
}
