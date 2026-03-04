export type MemoryRole = "user" | "assistant" | "system" | "event";

export type SourceSystem =
  | "codexclaw"
  | "telegram"
  | "chatgpt"
  | "grok"
  | "whatsapp"
  | "manual"
  | "aitrader";

export type PrivacyMode = "private" | "share_safe" | "demo";

export type ConfidenceScore = "low" | "medium" | "high";

export type InsightPack = "social_behavior" | "balanced_lite" | "health_diet";

export interface AuthSession {
  ok: true;
  token: string;
  expiresInSec: number;
  expiresAt: string;
}

export interface CaptureMemoryRequest {
  content: string;
  role: MemoryRole;
  sourceSystem: SourceSystem;
  sourceConversationId?: string | null;
  sourceMessageId?: string | null;
  sourceTimestamp?: string | null;
  chatNamespace?: string | null;
  metadata?: Record<string, unknown>;
  idempotencyKey?: string | null;
  skipMetadataExtraction?: boolean;
}

export interface CaptureMemoryResponse {
  ok: true;
  status: "inserted" | "deduped";
  id: string;
  contentHash: string;
  dedupeReason?: string;
}

export interface BatchCaptureItem extends CaptureMemoryRequest {
  itemKey?: string;
}

export interface BatchCaptureRequest {
  sourceSystem: SourceSystem;
  inputRef?: string;
  dryRun?: boolean;
  items: BatchCaptureItem[];
}

export interface BatchCaptureResponse {
  ok: true;
  jobId: string;
  inserted: number;
  deduped: number;
  failed: number;
  dryRun: boolean;
}

export interface SearchMemoryRequest {
  query: string;
  limit?: number;
  threshold?: number;
  chatNamespace?: string;
  sourceSystem?: SourceSystem;
  role?: MemoryRole;
}

export interface SearchMemoryMatch {
  id: string;
  content: string;
  role: MemoryRole;
  sourceSystem: SourceSystem;
  sourceConversationId: string | null;
  sourceMessageId: string | null;
  sourceTimestamp: string | null;
  chatNamespace: string | null;
  metadata: Record<string, unknown>;
  similarity: number;
  createdAt: string;
}

export interface SearchMemoryResponse {
  ok: true;
  query: string;
  count: number;
  matches: SearchMemoryMatch[];
}

export interface RecentMemoryResponse {
  ok: true;
  count: number;
  items: SearchMemoryMatch[];
}

export interface MemoryStatsResponse {
  ok: true;
  chatNamespace: string | null;
  days: number;
  totalItems: number;
  bySourceSystem: Array<{ sourceSystem: string; count: number }>;
  byRole: Array<{ role: string; count: number }>;
  latestCaptureAt: string | null;
}

export interface NormalizedMessage {
  content: string;
  role: MemoryRole;
  sourceSystem: SourceSystem;
  sourceConversationId?: string | null;
  sourceMessageId?: string | null;
  sourceTimestamp?: string | null;
  chatNamespace?: string | null;
  metadata?: Record<string, unknown>;
  idempotencyKey?: string | null;
}

export interface ParseResult {
  sourceSystem: SourceSystem;
  inputRef?: string;
  items: NormalizedMessage[];
}

export interface EvidenceRef {
  memoryId: string;
  sourceSystem: SourceSystem;
  sourceTimestamp: string | null;
  excerpt: string;
  similarity: number;
}

export interface ChartSeries {
  name: string;
  data: number[];
}

export interface ChartPayload {
  id: string;
  title: string;
  chartType: "line" | "area" | "bar" | "scatter" | "heatmap" | "radar" | "sankey";
  labels: string[];
  series: ChartSeries[];
}

export interface GraphNode {
  id: string;
  label: string;
  nodeType: string;
  value: number;
  tags?: string[];
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  relationType: string;
  weight: number;
  direction?: "both" | "forward";
}

export interface GraphPayload {
  id: string;
  title: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface BrainEntity {
  id: string;
  chatNamespace: string;
  entityType: "person" | "topic" | "place" | "habit" | "food" | "activity" | "org" | "other";
  normalizedName: string;
  displayName: string;
  weight: number;
  metadata: Record<string, unknown>;
}

export interface BrainRelation {
  id: string;
  chatNamespace: string;
  subjectEntityId: string;
  objectEntityId: string;
  relationType: string;
  weight: number;
  interactionCount: number;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  metadata: Record<string, unknown>;
}

export interface BrainFact {
  id: string;
  chatNamespace: string;
  domain:
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
  factType: string;
  valueText: string;
  confidence: number;
  sourceTimestamp: string | null;
  metadata: Record<string, unknown>;
}

export interface BrainInsight {
  id: string;
  chatNamespace: string;
  insightPack: InsightPack;
  insightType: string;
  title: string;
  summary: string;
  confidence: number;
  action?: string | null;
  updatedAt: string;
}

export interface BrainQueryRequest {
  question: string;
  mode?: "lookup" | "pattern" | "diagnosis" | "prediction" | "recommendation";
  timeframe?: "7d" | "30d" | "90d" | "365d" | "all";
  chatNamespace?: string;
  privacyMode?: PrivacyMode;
}

export interface BrainQueryResponse {
  ok: true;
  queryId: string;
  answer: string;
  confidence: ConfidenceScore;
  privacyMode: PrivacyMode;
  evidenceRefs: EvidenceRef[];
  charts: ChartPayload[];
  graphRefs: string[];
}

export interface BrainJobStatus {
  id: string;
  jobType: string;
  status: "pending" | "running" | "completed" | "failed" | "partial";
  scope: Record<string, unknown>;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  queuedItems: number;
  processedItems: number;
  failedItems: number;
}

export interface FeedbackRecord {
  queryId: string;
  verdict: "correct" | "incorrect" | "partial";
  correction?: string | null;
}
