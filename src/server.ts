import express, { Request, Response } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { applyCors, applyRateLimit, requireApiKey } from "./auth.js";
import { config } from "./config.js";
import {
  getBehaviorCharts,
  getBrainGraph,
  getBrainJobs,
  getPrivacyAwareTimeline,
  getProfileSummary,
  listBrainInsights,
  pruneOperationalLogs,
  rebuildBrainJob,
  recordQueryFeedback,
  runBrainQuery,
  startBrainWorker
} from "./brain.js";
import { batchCapture, captureMemory, getStats, healthcheck, listRecent, pool, searchMemory } from "./db.js";
import { mountMcpHttp } from "./mcp_http.js";
import { ensureExtendedSchema } from "./schema.js";
import { askV2, submitAskFeedback } from "./v2_ask.js";
import {
  activateBenchmarksBySignal,
  benchmarkReport,
  benchmarkSignalProfile,
  generateBenchmarks,
  runBenchmark
} from "./v2_benchmarks.js";
import {
  evaluateExperimentHypotheses,
  getExperimentBenchmarkDebt,
  getExperimentBenchmarkLock,
  experimentBenchmarkFreshness,
  experimentEvolutionComponentHeatmap,
  experimentEvolutionCoverage,
  experimentEvolutionDiversity,
  experimentEvolutionFrontier,
  experimentEvolutionOverview,
  experimentEvolutionTimeseries,
  experimentComponentLeaderboard,
  experimentComponentStability,
  experimentFailures,
  experimentGovernanceLeakage,
  experimentHypothesisDetail,
  experimentHypotheses,
  experimentLeaderboard,
  experimentList,
  experimentLineage,
  experimentPreloopReadiness,
  createJudgeCalibrationSample,
  autoReviewJudgeCalibration,
  generateTaxonomyCandidates,
  judgeCalibrationReport,
  listJudgeCalibrationPending,
  publishTaxonomyVersion,
  experimentStatus,
  generateExperimentHypotheses,
  lockExperimentBenchmark,
  listStrategyCatalog,
  taxonomyCandidates,
  taxonomyFacetCoverage,
  taxonomySupportMatrix,
  taxonomyVersionDetail,
  taxonomyVersionsList,
  scanTaxonomyVersionSupport,
  reseedExperimentFromTaxonomyVersion,
  reviewTaxonomyCandidate,
  recomposeExperimentStrategies,
  runExperimentStep,
  submitJudgeCalibrationLabel,
  startExperiment
} from "./v2_experiments.js";
import { applyUniversalQualityGate, materializeCandidates, remediateLegacyArtifacts } from "./v2_pipeline.js";
import { adjudicateQuality, evaluateQuality, getQualityMetrics, runCanonicalBootstrap } from "./v2_quality.js";
import { startV2Worker } from "./v2_runtime.js";
import {
  listNetworkSavedArtifacts,
  rebuildNetworkGraphArtifacts,
  saveNetworkSnapshot,
  saveNetworkView,
  searchNetworkGraph
} from "./v2_network.js";
import {
  fetchContextWindow,
  fetchThreadSlice,
  getCapabilitiesPayload,
  searchAnchors,
  searchPublishedFacts
} from "./v2_search.js";
import {
  authenticateService,
  issueServiceToken,
  listApiAudit,
  logApiAuditEvent,
  registerServiceIdentity,
  serviceHasPermission
} from "./v2_services.js";
import {
  bootstrapAuthUser,
  getRequestSession,
  loginWithPassword,
  logoutSessionByToken,
  requireSession,
  rotateUserPassword,
  setSessionPrivacyMode
} from "./session.js";
import type {
  BatchCaptureRequest,
  BrainQueryRequest,
  CaptureMemoryRequest,
  FeedbackRecord,
  PrivacyMode,
  SearchMemoryRequest
} from "./types.js";
import type {
  NetworkGraphRequest,
  V2FeedbackRequest,
  V2Principal,
  V2QualityAdjudicateRequest,
  V2QualityEvaluateRequest,
  V2ServiceRegisterRequest,
  V2ServiceTokenRequest
} from "./v2_types.js";
import { renderAppHtml } from "./ui.js";

const captureSchema = z.object({
  content: z.string().min(1),
  role: z.enum(["user", "assistant", "system", "event"]),
  sourceSystem: z.enum(["codexclaw", "telegram", "chatgpt", "grok", "whatsapp", "manual", "aitrader"]),
  sourceConversationId: z.string().optional().nullable(),
  sourceMessageId: z.string().optional().nullable(),
  sourceTimestamp: z.string().optional().nullable(),
  chatNamespace: z.string().optional().nullable(),
  metadata: z.record(z.unknown()).optional(),
  idempotencyKey: z.string().optional().nullable(),
  skipMetadataExtraction: z.boolean().optional()
});

const batchSchema = z.object({
  sourceSystem: z.enum(["codexclaw", "telegram", "chatgpt", "grok", "whatsapp", "manual", "aitrader"]),
  inputRef: z.string().optional(),
  dryRun: z.boolean().optional(),
  items: z.array(captureSchema.extend({ itemKey: z.string().optional() })).min(1)
});

const searchSchema = z.object({
  query: z.string().min(1),
  limit: z.number().int().min(1).max(50).optional(),
  threshold: z.number().min(0).max(1).optional(),
  chatNamespace: z.string().optional(),
  sourceSystem: z.enum(["codexclaw", "telegram", "chatgpt", "grok", "whatsapp", "manual", "aitrader"]).optional(),
  role: z.enum(["user", "assistant", "system", "event"]).optional()
});

const loginSchema = z.object({
  password: z.string().min(1)
});

const rotatePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8)
});

const privacyModeSchema = z.object({
  mode: z.enum(["private", "share_safe", "demo"])
});

const brainQuerySchema = z.object({
  question: z.string().min(2),
  mode: z.enum(["lookup", "pattern", "diagnosis", "prediction", "recommendation"]).optional(),
  timeframe: z.enum(["7d", "30d", "90d", "365d", "all"]).optional(),
  chatNamespace: z.string().optional(),
  privacyMode: z.enum(["private", "share_safe", "demo"]).optional()
});

const feedbackSchema = z.object({
  queryId: z.string().min(1),
  verdict: z.enum(["correct", "incorrect", "partial"]),
  correction: z.string().optional().nullable()
});

const v2AskSchema = z.object({
  question: z.string().min(2),
  clarificationResponse: z.string().optional(),
  chatNamespace: z.string().optional(),
  timeframe: z.enum(["7d", "30d", "90d", "365d", "all"]).optional(),
  privacyMode: z.enum(["private", "share_safe", "demo"]).optional(),
  debugMode: z.boolean().optional(),
  mode: z.enum(["lookup", "pattern", "diagnosis", "prediction", "recommendation"]).optional(),
  maxLoops: z.number().int().min(1).max(3).optional(),
  conversationId: z.string().optional(),
  context: z.record(z.unknown()).optional(),
  strategyConfig: z.object({
    strategyId: z.string(),
    retrievalMode: z.enum(["baseline", "vector", "lexical", "hybrid", "hybrid_rerank"]).optional(),
    contextMode: z.enum(["anchor_only", "window", "window_thread", "adaptive"]).optional(),
    plannerMode: z.enum(["baseline", "single_agent_minimal", "single_agent_sequential", "mesh_lean"]).optional(),
    composerMode: z.enum(["heuristic", "minimal_llm"]).optional(),
    refinementMode: z.enum(["fixed", "adaptive"]).optional(),
    maxLoops: z.number().int().min(1).max(3).optional()
  }).optional()
});

const v2FeedbackSchema = z
  .object({
    answerRunId: z.string().min(1).optional(),
    traceId: z.string().min(1).optional(),
    verdict: z.enum(["yes", "no", "partial"]),
    correction: z.string().optional(),
    correctedValue: z.record(z.unknown()).optional(),
    asOfDate: z.string().optional(),
    scope: z.string().optional()
  })
  .refine((payload) => Boolean(payload.answerRunId || payload.traceId), {
    message: "answerRunId or traceId is required"
  });

const v2QualityEvaluateSchema = z.object({
  artifactType: z.enum(["canonical_message", "entity", "fact", "relationship", "insight"]),
  artifactId: z.string().optional(),
  payload: z.record(z.unknown()),
  confidence: z.number().min(0).max(1).optional(),
  traceId: z.string().optional(),
  reasons: z.array(z.string()).optional()
});

const v2QualityAdjudicateSchema = z.object({
  artifactType: z.enum(["canonical_message", "entity", "fact", "relationship", "insight"]),
  artifactId: z.string().min(1),
  decision: z.enum(["promote", "hold", "reject", "retry", "deprecate"]),
  confidence: z.number().min(0).max(1),
  reasons: z.array(z.string()).optional(),
  traceId: z.string().optional()
});

const v2BenchGenerateSchema = z.object({
  benchmarkSet: z.string().optional(),
  variantsPerDomainLens: z.number().int().min(1).max(100).optional()
});

const v2BenchRunSchema = z.object({
  benchmarkSet: z.string().optional(),
  limit: z.number().int().min(1).max(36000).optional(),
  chatNamespace: z.string().optional(),
  dataAwareOnly: z.boolean().optional(),
  minDomainScore: z.number().min(0).max(1).optional(),
  minDomainRows: z.number().int().min(1).max(500000).optional()
});

const v2BenchSignalSchema = z.object({
  benchmarkSet: z.string().optional(),
  chatNamespace: z.string().optional(),
  minDomainScore: z.number().min(0).max(1).optional(),
  minDomainRows: z.number().int().min(1).max(500000).optional()
});

const v2ExperimentStartSchema = z.object({
  name: z.string().optional(),
  chatNamespace: z.string().optional(),
  targetPassRate: z.number().min(0).max(1).optional(),
  criticalTargetPassRate: z.number().min(0).max(1).optional(),
  perDomainFloor: z.number().min(0).max(1).optional(),
  latencyGateMultiplier: z.number().min(1).max(3).optional(),
  costGateMultiplier: z.number().min(1).max(3).optional(),
  datasetVersion: z.string().optional(),
  strategyIds: z.array(z.string()).optional(),
  maxCasesPerPair: z.number().int().min(1).max(4).optional(),
  taxonomyVersionId: z.string().optional(),
  selectionProfileId: z.string().optional(),
  selectionProfile: z.record(z.unknown()).optional(),
  certificationProfile: z.record(z.unknown()).optional(),
  readinessProfile: z.record(z.unknown()).optional()
});

const v2ExperimentStepSchema = z.object({
  experimentId: z.string().min(1),
  variantId: z.string().optional(),
  caseSet: z.enum(["dev", "critical", "certification", "all"]).optional()
});

const v2ExperimentBenchmarkLockSchema = z.object({
  lockVersion: z.string().optional(),
  lockStage: z.enum(["core_ready", "selection_ready", "certification_ready"])
});

const v2TaxonomyScanSchema = z.object({
  chatNamespace: z.string().optional()
});

const v2TaxonomyCandidateReviewSchema = z.object({
  decision: z.enum(["approved", "rejected", "deferred"]),
  targetKey: z.string().optional(),
  notes: z.string().optional()
});

const v2ExperimentReseedTaxonomySchema = z.object({
  taxonomyVersionId: z.string().optional()
});

const v2ServiceRegisterSchema = z.object({
  serviceName: z.string().min(1),
  description: z.string().optional(),
  permissions: z.array(
    z.object({
      namespacePattern: z.string().min(1),
      domain: z.string().min(1),
      operation: z.string().min(1)
    })
  ).min(1),
  metadata: z.record(z.unknown()).optional()
});

const v2ServiceTokenSchema = z.object({
  serviceId: z.string().min(1),
  ttlSec: z.number().int().min(60).max(604800).optional()
});

const v2SearchFactsSchema = z.object({
  query: z.string().min(2),
  chatNamespace: z.string().optional(),
  limit: z.number().int().min(1).max(100).optional()
});

const v2SearchGraphSchema = z.object({
  chatNamespace: z.string().optional(),
  limit: z.number().int().min(10).max(500).optional(),
  query: z.string().optional(),
  command: z.string().optional(),
  sceneMode: z.enum(["default", "answer_scene"]).optional(),
  sceneSeed: z.record(z.unknown()).optional(),
  selectedNodeId: z.string().optional(),
  selectedEdgeId: z.string().optional(),
  expandedNodeIds: z.array(z.string()).optional(),
  collapsedNodeIds: z.array(z.string()).optional(),
  overflowState: z.record(z.number().int().min(0).max(12)).optional(),
  filters: z.record(z.unknown()).optional(),
  confidenceMode: z.enum(["strong_only", "include_weak"]).optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  autoplayTickMode: z.enum(["day", "week", "month"]).optional(),
  layoutMode: z.enum(["radial", "force", "hierarchical"]).optional(),
  savedViewId: z.string().optional(),
  snapshotId: z.string().optional()
});

const v2NetworkSaveViewSchema = z.object({
  chatNamespace: z.string().optional(),
  viewName: z.string().min(1),
  ownerActorId: z.string().optional().nullable(),
  queryText: z.string().optional().nullable(),
  config: z.record(z.unknown()).default({})
});

const v2NetworkSnapshotSchema = z.object({
  chatNamespace: z.string().optional(),
  snapshotName: z.string().min(1),
  ownerActorId: z.string().optional().nullable(),
  graph: z.record(z.unknown())
});

const v2AnchorSearchSchema = z.object({
  query: z.string().min(2),
  chatNamespace: z.string().optional(),
  k: z.number().int().min(1).max(100).optional(),
  filters: z.record(z.unknown()).optional()
});

const v2ContextWindowSchema = z.object({
  conversationId: z.string().min(1),
  anchorMessageId: z.string().min(1),
  chatNamespace: z.string().optional(),
  beforeN: z.number().int().min(0).max(50).optional(),
  afterN: z.number().int().min(0).max(50).optional()
});

const v2ThreadSchema = z.object({
  messageId: z.string().min(1),
  chatNamespace: z.string().optional(),
  direction: z.enum(["up", "down", "both"]).optional(),
  depth: z.number().int().min(1).max(20).optional()
});

function sessionOrThrow(req: Request): { token: string; userName: string; privacyMode: PrivacyMode } {
  const session = getRequestSession(req);
  if (!session) {
    throw new Error("Unauthorized session");
  }
  return {
    token: session.token,
    userName: session.userName,
    privacyMode: session.privacyMode
  };
}

function traceIdFromRequest(req: Request): string {
  const headerTrace = String(req.header("x-trace-id") ?? "").trim();
  return headerTrace || randomUUID();
}

function ensureV2Enabled(): void {
  if (!config.v2Enabled) {
    throw new Error("OpenBrain V2 is disabled (OPENBRAIN_V2_ENABLED=0).");
  }
}

async function resolveV2Principal(
  req: Request,
  opts: { allowExternalService: boolean; namespace?: string; domain: string; operation: string }
): Promise<V2Principal> {
  const session = getRequestSession(req);
  if (session) {
    return { kind: "session", userName: session.userName };
  }

  if (!opts.allowExternalService || !config.v2ExternalAgentAccess) {
    throw new Error("Unauthorized session");
  }

  const servicePrincipal = await authenticateService(req);
  if (!servicePrincipal?.serviceId) {
    throw new Error("Unauthorized service");
  }

  const namespace = String(opts.namespace ?? "personal.main");
  const allowed = await serviceHasPermission({
    serviceId: servicePrincipal.serviceId,
    namespace,
    domain: opts.domain,
    operation: opts.operation
  });
  if (!allowed) {
    throw new Error("Service permission denied");
  }

  return servicePrincipal;
}

async function main(): Promise<void> {
  await ensureExtendedSchema();
  await bootstrapAuthUser();

  const app = express();
  app.disable("x-powered-by");

  app.use(express.json({ limit: "2mb" }));
  app.use((error: unknown, _req: Request, res: Response, next: (error?: unknown) => void): void => {
    if (error && typeof error === "object" && (error as { type?: string }).type === "entity.parse.failed") {
      res.status(400).json({ ok: false, error: "Invalid JSON body" });
      return;
    }
    next(error as unknown);
  });
  app.use(applyCors);
  app.use(applyRateLimit);

  app.use("/v2", (req: Request, res: Response, next) => {
    const startedAt = Date.now();
    const traceId = traceIdFromRequest(req);
    res.locals.traceId = traceId;

    const requestJson =
      req.body && typeof req.body === "object" && !Array.isArray(req.body)
        ? (req.body as Record<string, unknown>)
        : {};

    res.on("finish", () => {
      const principal = (res.locals.v2Principal ?? null) as V2Principal | null;
      void logApiAuditEvent({
        traceId,
        serviceId: principal?.kind === "service" ? principal.serviceId : null,
        sessionActor: principal?.kind === "session" ? principal.userName : null,
        method: req.method,
        path: req.path,
        statusCode: res.statusCode,
        operation: String(res.locals.v2Operation ?? ""),
        namespace: String(res.locals.v2Namespace ?? ""),
        requestJson,
        responseJson:
          res.locals.v2Response && typeof res.locals.v2Response === "object"
            ? (res.locals.v2Response as Record<string, unknown>)
            : {},
        errorText: res.locals.v2Error ? String(res.locals.v2Error) : null,
        durationMs: Date.now() - startedAt
      }).catch(() => undefined);
    });

    next();
  });

  app.get("/", (_req, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    res.setHeader("Surrogate-Control", "no-store");
    res.send(renderAppHtml());
  });

  app.get("/app", (_req, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    res.setHeader("Surrogate-Control", "no-store");
    res.send(renderAppHtml());
  });

  app.get("/v1/health", async (_req, res) => {
    const status = await healthcheck();
    res.status(status.ok ? 200 : 503).json(status);
  });

  app.post("/v1/auth/login", async (req: Request, res: Response) => {
    try {
      const payload = loginSchema.parse(req.body) as { password: string };
      const session = await loginWithPassword(payload.password);
      if (!session) {
        res.status(401).json({ ok: false, error: "Invalid credentials" });
        return;
      }
      res.json(session);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(400).json({ ok: false, error: message });
    }
  });

  app.post("/v1/auth/logout", requireSession, (req: Request, res: Response) => {
    const session = getRequestSession(req);
    if (session?.token) {
      logoutSessionByToken(session.token);
    }
    res.json({ ok: true });
  });

  app.get("/v1/auth/session", requireSession, (req: Request, res: Response) => {
    const session = getRequestSession(req);
    if (!session) {
      res.status(401).json({ ok: false, error: "Unauthorized" });
      return;
    }
    res.json({ ok: true, expiresAt: session.expiresAt, privacyMode: session.privacyMode, userName: session.userName });
  });

  app.post("/v1/auth/rotate", requireSession, async (req: Request, res: Response) => {
    try {
      const session = sessionOrThrow(req);
      const payload = rotatePasswordSchema.parse(req.body) as { currentPassword: string; newPassword: string };
      const ok = await rotateUserPassword(session.userName, payload.currentPassword, payload.newPassword);
      if (!ok) {
        res.status(400).json({ ok: false, error: "Password rotation failed" });
        return;
      }
      res.json({ ok: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(400).json({ ok: false, error: message });
    }
  });

  app.get("/v1/privacy/mode", requireSession, (req: Request, res: Response) => {
    try {
      const session = sessionOrThrow(req);
      res.json({ ok: true, mode: session.privacyMode });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(401).json({ ok: false, error: message });
    }
  });

  app.post("/v1/privacy/mode", requireSession, (req: Request, res: Response) => {
    try {
      const session = sessionOrThrow(req);
      const payload = privacyModeSchema.parse(req.body) as { mode: PrivacyMode };
      const updated = setSessionPrivacyMode(session.token, payload.mode);
      if (!updated) {
        res.status(401).json({ ok: false, error: "Unauthorized" });
        return;
      }
      res.json({ ok: true, mode: updated.privacyMode });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(400).json({ ok: false, error: message });
    }
  });

  app.post("/v1/memory/capture", requireApiKey, async (req: Request, res: Response) => {
    try {
      const payload = captureSchema.parse(req.body) as CaptureMemoryRequest;
      const result = await captureMemory(payload);
      res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(400).json({ ok: false, error: message });
    }
  });

  app.post("/v1/memory/batch", requireApiKey, async (req: Request, res: Response) => {
    try {
      const payload = batchSchema.parse(req.body) as BatchCaptureRequest;
      const result = await batchCapture(payload);
      res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(400).json({ ok: false, error: message });
    }
  });

  app.post("/v1/memory/search", requireApiKey, async (req: Request, res: Response) => {
    try {
      const payload = searchSchema.parse(req.body) as SearchMemoryRequest;
      const result = await searchMemory(payload);
      res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(400).json({ ok: false, error: message });
    }
  });

  app.get("/v1/memory/recent", requireApiKey, async (req: Request, res: Response) => {
    try {
      const chatNamespace = String(req.query.chatNamespace ?? "").trim() || undefined;
      const sourceSystem = String(req.query.sourceSystem ?? "").trim() || undefined;
      const role = String(req.query.role ?? "").trim() || undefined;
      const limitRaw = Number(req.query.limit ?? "20");
      const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(100, Math.trunc(limitRaw))) : 20;

      const result = await listRecent({ chatNamespace, sourceSystem, role, limit });
      res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(400).json({ ok: false, error: message });
    }
  });

  app.get("/v1/memory/stats", requireApiKey, async (req: Request, res: Response) => {
    try {
      const chatNamespace = String(req.query.chatNamespace ?? "").trim() || null;
      const daysRaw = Number(req.query.days ?? "30");
      const days = Number.isFinite(daysRaw) ? Math.max(1, Math.min(3650, Math.trunc(daysRaw))) : 30;
      const result = await getStats(chatNamespace, days);
      res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(400).json({ ok: false, error: message });
    }
  });

  app.post("/v1/brain/query", requireSession, async (req: Request, res: Response) => {
    try {
      const session = sessionOrThrow(req);
      const payload = brainQuerySchema.parse(req.body) as BrainQueryRequest;
      const mode = payload.privacyMode ?? session.privacyMode;
      const result = await runBrainQuery(payload, mode);
      res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(400).json({ ok: false, error: message });
    }
  });

  app.get("/v1/brain/profile", requireSession, async (req: Request, res: Response) => {
    try {
      const session = sessionOrThrow(req);
      const chatNamespace = String(req.query.chatNamespace ?? "").trim() || "personal.main";
      const timeframe = String(req.query.timeframe ?? "30d");
      const result = await getProfileSummary(chatNamespace, timeframe, session.privacyMode);
      res.json({ ok: true, ...result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(400).json({ ok: false, error: message });
    }
  });

  app.get("/v1/brain/graph", requireSession, async (req: Request, res: Response) => {
    try {
      const session = sessionOrThrow(req);
      const chatNamespace = String(req.query.chatNamespace ?? "").trim() || "personal.main";
      const graphType = String(req.query.graphType ?? "relationships");
      const graph = await getBrainGraph(chatNamespace, session.privacyMode);
      res.json({ ok: true, graphType, graph });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(400).json({ ok: false, error: message });
    }
  });

  app.get("/v1/brain/timeline", requireSession, async (req: Request, res: Response) => {
    try {
      const session = sessionOrThrow(req);
      const chatNamespace = String(req.query.chatNamespace ?? "").trim() || "personal.main";
      const start = String(req.query.start ?? "").trim() || undefined;
      const end = String(req.query.end ?? "").trim() || undefined;
      const domain = String(req.query.domain ?? "").trim() || undefined;
      const timeframe = String(req.query.timeframe ?? "").trim() || undefined;
      const items = await getPrivacyAwareTimeline({
        chatNamespace,
        start,
        end,
        domain,
        timeframe,
        privacyMode: session.privacyMode
      });
      res.json({ ok: true, items });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(400).json({ ok: false, error: message });
    }
  });

  app.get("/v1/brain/insights", requireSession, async (req: Request, res: Response) => {
    try {
      const session = sessionOrThrow(req);
      const chatNamespace = String(req.query.chatNamespace ?? "").trim() || "personal.main";
      const timeframe = String(req.query.timeframe ?? "30d");
      const insights = await listBrainInsights(chatNamespace, session.privacyMode);
      const charts = await getBehaviorCharts(chatNamespace, timeframe === "all" ? "3650 days" : timeframe.replace("d", " days"), session.privacyMode);
      res.json({ ok: true, insights, charts });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(400).json({ ok: false, error: message });
    }
  });

  app.post("/v1/brain/feedback", requireSession, async (req: Request, res: Response) => {
    try {
      const session = sessionOrThrow(req);
      const payload = feedbackSchema.parse(req.body) as FeedbackRecord;
      await recordQueryFeedback(payload, session.privacyMode);
      res.json({ ok: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(400).json({ ok: false, error: message });
    }
  });

  app.get("/v1/brain/jobs", requireSession, async (req: Request, res: Response) => {
    try {
      const limitRaw = Number(req.query.limit ?? "30");
      const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(200, Math.trunc(limitRaw))) : 30;
      const jobs = await getBrainJobs(limit);
      res.json({ ok: true, jobs });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(400).json({ ok: false, error: message });
    }
  });

  app.post("/v1/brain/jobs/rebuild", requireSession, async (req: Request, res: Response) => {
    try {
      const session = sessionOrThrow(req);
      const chatNamespace = String(req.body?.chatNamespace ?? "").trim() || undefined;
      const days = Number(req.body?.days ?? 90);
      const domain = String(req.body?.domain ?? "").trim() || undefined;
      const result = await rebuildBrainJob({ chatNamespace, days, domain, requestedBy: session.userName });
      res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(400).json({ ok: false, error: message });
    }
  });

  app.post("/v1/brain/jobs/prune", requireSession, async (req: Request, res: Response) => {
    try {
      const days = Number(req.body?.days ?? 60);
      const result = await pruneOperationalLogs(days);
      res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(400).json({ ok: false, error: message });
    }
  });

  app.post("/v2/brain/ask", async (req: Request, res: Response) => {
    try {
      ensureV2Enabled();
      const payload = v2AskSchema.parse(req.body);
      const namespace = payload.chatNamespace ?? "personal.main";
      const principal = await resolveV2Principal(req, {
        allowExternalService: true,
        namespace,
        domain: "brain",
        operation: "ask"
      });
      res.locals.v2Principal = principal;
      res.locals.v2Operation = "brain.ask";
      res.locals.v2Namespace = namespace;

      const result = await askV2(payload, principal);
      res.locals.v2Response = result as unknown as Record<string, unknown>;
      res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.locals.v2Error = message;
      res.status(400).json({ ok: false, error: message });
    }
  });

  app.post("/v2/brain/ask/feedback", async (req: Request, res: Response) => {
    try {
      ensureV2Enabled();
      const payload = v2FeedbackSchema.parse(req.body) as V2FeedbackRequest;
      const principal = await resolveV2Principal(req, {
        allowExternalService: true,
        namespace: "personal.main",
        domain: "brain",
        operation: "feedback"
      });
      res.locals.v2Principal = principal;
      res.locals.v2Operation = "brain.feedback";

      const result = await submitAskFeedback(payload);
      res.locals.v2Response = result as unknown as Record<string, unknown>;
      res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.locals.v2Error = message;
      res.status(400).json({ ok: false, error: message });
    }
  });

  app.get("/v2/brain/ask/run/:id", async (req: Request, res: Response) => {
    try {
      ensureV2Enabled();
      const answerRunId = String(req.params.id ?? "").trim();
      if (!/^[0-9a-fA-F-]{36}$/.test(answerRunId)) {
        throw new Error("Invalid answerRunId");
      }
      const principal = await resolveV2Principal(req, {
        allowExternalService: false,
        namespace: "personal.main",
        domain: "brain",
        operation: "ask_debug"
      });
      res.locals.v2Principal = principal;
      res.locals.v2Operation = "brain.ask_debug";

      const run = await pool.query<{
        id: string;
        trace_id: string;
        conversation_id: string;
        chat_namespace: string;
        question: string;
        status: string;
        decision: string | null;
        created_at: string;
        finished_at: string | null;
      }>(
        `SELECT
           id::text,
           trace_id,
           conversation_id,
           chat_namespace,
           question,
           status,
           decision,
           created_at::text,
           finished_at::text
         FROM answer_runs
         WHERE id = $1::uuid`,
        [answerRunId]
      );
      if (run.rows.length === 0) {
        throw new Error("Answer run not found");
      }

      const steps = await pool.query<{
        step_index: number;
        agent_name: string;
        message_type: string;
        status: string;
        envelope: Record<string, unknown>;
        created_at: string;
      }>(
        `SELECT
           step_index,
           agent_name,
           message_type,
           status,
           envelope,
           created_at::text
         FROM answer_steps
         WHERE answer_run_id = $1::uuid
         ORDER BY step_index ASC`,
        [answerRunId]
      );

      const result = {
        ok: true,
        run: run.rows[0],
        steps: steps.rows
      };
      res.locals.v2Response = result as unknown as Record<string, unknown>;
      res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.locals.v2Error = message;
      res.status(400).json({ ok: false, error: message });
    }
  });

  app.get("/v2/capabilities", async (req: Request, res: Response) => {
    try {
      ensureV2Enabled();
      const principal = await resolveV2Principal(req, {
        allowExternalService: true,
        namespace: "personal.main",
        domain: "brain",
        operation: "capabilities"
      });
      res.locals.v2Principal = principal;
      res.locals.v2Operation = "brain.capabilities";
      const result = getCapabilitiesPayload();
      res.locals.v2Response = result as unknown as Record<string, unknown>;
      res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.locals.v2Error = message;
      res.status(400).json({ ok: false, error: message });
    }
  });

  app.post("/v2/retrieval/anchor_search", async (req: Request, res: Response) => {
    try {
      ensureV2Enabled();
      const payload = v2AnchorSearchSchema.parse(req.body);
      const principal = await resolveV2Principal(req, {
        allowExternalService: true,
        namespace: payload.chatNamespace ?? "personal.main",
        domain: "retrieval",
        operation: "anchor_search"
      });
      res.locals.v2Principal = principal;
      res.locals.v2Operation = "retrieval.anchor_search";
      res.locals.v2Namespace = payload.chatNamespace ?? "personal.main";
      const result = await searchAnchors(payload);
      res.locals.v2Response = result as Record<string, unknown>;
      res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.locals.v2Error = message;
      res.status(400).json({ ok: false, error: message });
    }
  });

  app.post("/v2/retrieval/context_window", async (req: Request, res: Response) => {
    try {
      ensureV2Enabled();
      const payload = v2ContextWindowSchema.parse(req.body);
      const principal = await resolveV2Principal(req, {
        allowExternalService: true,
        namespace: payload.chatNamespace ?? "personal.main",
        domain: "retrieval",
        operation: "context_window"
      });
      res.locals.v2Principal = principal;
      res.locals.v2Operation = "retrieval.context_window";
      res.locals.v2Namespace = payload.chatNamespace ?? "personal.main";
      const result = await fetchContextWindow(payload);
      res.locals.v2Response = result as Record<string, unknown>;
      res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.locals.v2Error = message;
      res.status(400).json({ ok: false, error: message });
    }
  });

  app.post("/v2/retrieval/thread", async (req: Request, res: Response) => {
    try {
      ensureV2Enabled();
      const payload = v2ThreadSchema.parse(req.body);
      const principal = await resolveV2Principal(req, {
        allowExternalService: true,
        namespace: payload.chatNamespace ?? "personal.main",
        domain: "retrieval",
        operation: "thread"
      });
      res.locals.v2Principal = principal;
      res.locals.v2Operation = "retrieval.thread";
      res.locals.v2Namespace = payload.chatNamespace ?? "personal.main";
      const result = await fetchThreadSlice(payload);
      res.locals.v2Response = result as Record<string, unknown>;
      res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.locals.v2Error = message;
      res.status(400).json({ ok: false, error: message });
    }
  });

  app.post("/v2/brain/search/facts", async (req: Request, res: Response) => {
    try {
      ensureV2Enabled();
      const payload = v2SearchFactsSchema.parse(req.body);
      const principal = await resolveV2Principal(req, {
        allowExternalService: true,
        namespace: payload.chatNamespace ?? "personal.main",
        domain: "brain",
        operation: "search_facts"
      });
      res.locals.v2Principal = principal;
      res.locals.v2Operation = "brain.search_facts";
      res.locals.v2Namespace = payload.chatNamespace ?? "personal.main";
      const result = await searchPublishedFacts(payload);
      res.locals.v2Response = result as Record<string, unknown>;
      res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.locals.v2Error = message;
      res.status(400).json({ ok: false, error: message });
    }
  });

  app.post("/v2/brain/search/graph", async (req: Request, res: Response) => {
    try {
      ensureV2Enabled();
      const payload = v2SearchGraphSchema.parse(req.body);
      const principal = await resolveV2Principal(req, {
        allowExternalService: true,
        namespace: payload.chatNamespace ?? "personal.main",
        domain: "brain",
        operation: "search_graph"
      });
      res.locals.v2Principal = principal;
      res.locals.v2Operation = "brain.search_graph";
      res.locals.v2Namespace = payload.chatNamespace ?? "personal.main";
      const result = await searchNetworkGraph(payload as unknown as NetworkGraphRequest);
      res.locals.v2Response = result as unknown as Record<string, unknown>;
      res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.locals.v2Error = message;
      res.status(400).json({ ok: false, error: message });
    }
  });

  app.get("/v2/brain/search/graph/saved", async (req: Request, res: Response) => {
    try {
      ensureV2Enabled();
      const chatNamespace = String(req.query.chatNamespace ?? "personal.main").trim() || "personal.main";
      const principal = await resolveV2Principal(req, {
        allowExternalService: true,
        namespace: chatNamespace,
        domain: "brain",
        operation: "search_graph"
      });
      res.locals.v2Principal = principal;
      res.locals.v2Operation = "brain.search_graph.saved";
      res.locals.v2Namespace = chatNamespace;
      const result = await listNetworkSavedArtifacts(chatNamespace);
      res.locals.v2Response = result as Record<string, unknown>;
      res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.locals.v2Error = message;
      res.status(400).json({ ok: false, error: message });
    }
  });

  app.post("/v2/brain/search/graph/save_view", async (req: Request, res: Response) => {
    try {
      ensureV2Enabled();
      const payload = v2NetworkSaveViewSchema.parse(req.body);
      const principal = await resolveV2Principal(req, {
        allowExternalService: false,
        namespace: payload.chatNamespace ?? "personal.main",
        domain: "brain",
        operation: "search_graph"
      });
      res.locals.v2Principal = principal;
      res.locals.v2Operation = "brain.search_graph.save_view";
      res.locals.v2Namespace = payload.chatNamespace ?? "personal.main";
      const result = await saveNetworkView(payload);
      res.locals.v2Response = result as Record<string, unknown>;
      res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.locals.v2Error = message;
      res.status(400).json({ ok: false, error: message });
    }
  });

  app.post("/v2/brain/search/graph/snapshot", async (req: Request, res: Response) => {
    try {
      ensureV2Enabled();
      const payload = v2NetworkSnapshotSchema.parse(req.body);
      const principal = await resolveV2Principal(req, {
        allowExternalService: false,
        namespace: payload.chatNamespace ?? "personal.main",
        domain: "brain",
        operation: "search_graph"
      });
      res.locals.v2Principal = principal;
      res.locals.v2Operation = "brain.search_graph.snapshot";
      res.locals.v2Namespace = payload.chatNamespace ?? "personal.main";
      const result = await saveNetworkSnapshot({
        chatNamespace: payload.chatNamespace,
        snapshotName: payload.snapshotName,
        ownerActorId: payload.ownerActorId,
        graph: payload.graph as Parameters<typeof saveNetworkSnapshot>[0]["graph"]
      });
      res.locals.v2Response = result as Record<string, unknown>;
      res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.locals.v2Error = message;
      res.status(400).json({ ok: false, error: message });
    }
  });

  app.post("/v2/brain/search/graph/backfill", async (req: Request, res: Response) => {
    try {
      ensureV2Enabled();
      const principal = await resolveV2Principal(req, {
        allowExternalService: false,
        namespace: String(req.body?.chatNamespace ?? "personal.main"),
        domain: "brain",
        operation: "search_graph"
      });
      res.locals.v2Principal = principal;
      res.locals.v2Operation = "brain.search_graph.backfill";
      res.locals.v2Namespace = String(req.body?.chatNamespace ?? "personal.main");
      const result = await rebuildNetworkGraphArtifacts({
        chatNamespace: String(req.body?.chatNamespace ?? "personal.main"),
        clearExisting: Boolean(req.body?.clearExisting)
      });
      res.locals.v2Response = result as Record<string, unknown>;
      res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.locals.v2Error = message;
      res.status(400).json({ ok: false, error: message });
    }
  });

  app.post("/v2/quality/evaluate", async (req: Request, res: Response) => {
    try {
      ensureV2Enabled();
      const principal = await resolveV2Principal(req, {
        allowExternalService: false,
        domain: "quality",
        operation: "evaluate"
      });
      res.locals.v2Principal = principal;
      res.locals.v2Operation = "quality.evaluate";
      const payload = v2QualityEvaluateSchema.parse(req.body) as V2QualityEvaluateRequest;
      const result = await evaluateQuality(payload);
      res.locals.v2Response = result as unknown as Record<string, unknown>;
      res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.locals.v2Error = message;
      res.status(400).json({ ok: false, error: message });
    }
  });

  app.post("/v2/quality/adjudicate", async (req: Request, res: Response) => {
    try {
      ensureV2Enabled();
      const principal = await resolveV2Principal(req, {
        allowExternalService: false,
        domain: "quality",
        operation: "adjudicate"
      });
      res.locals.v2Principal = principal;
      res.locals.v2Operation = "quality.adjudicate";
      const payload = v2QualityAdjudicateSchema.parse(req.body) as V2QualityAdjudicateRequest;
      const result = await adjudicateQuality(payload);
      res.locals.v2Response = result as unknown as Record<string, unknown>;
      res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.locals.v2Error = message;
      res.status(400).json({ ok: false, error: message });
    }
  });

  app.get("/v2/quality/metrics", async (req: Request, res: Response) => {
    try {
      ensureV2Enabled();
      const principal = await resolveV2Principal(req, {
        allowExternalService: true,
        domain: "quality",
        operation: "metrics"
      });
      res.locals.v2Principal = principal;
      res.locals.v2Operation = "quality.metrics";
      const daysRaw = Number(req.query.days ?? 30);
      const result = await getQualityMetrics(daysRaw);
      res.locals.v2Response = result as Record<string, unknown>;
      res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.locals.v2Error = message;
      res.status(400).json({ ok: false, error: message });
    }
  });

  app.post("/v2/quality/bootstrap", async (req: Request, res: Response) => {
    try {
      ensureV2Enabled();
      const principal = await resolveV2Principal(req, {
        allowExternalService: false,
        domain: "quality",
        operation: "bootstrap"
      });
      res.locals.v2Principal = principal;
      res.locals.v2Operation = "quality.bootstrap";
      const canonical = await runCanonicalBootstrap(Number(req.body?.canonicalLimit ?? 2000));
      const candidates = await materializeCandidates(Number(req.body?.candidateLimit ?? 2500));
      const gate = await applyUniversalQualityGate();
      const remediation = await remediateLegacyArtifacts();
      const result = { ok: true, canonical, candidates, gate, remediation };
      res.locals.v2Response = result as Record<string, unknown>;
      res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.locals.v2Error = message;
      res.status(400).json({ ok: false, error: message });
    }
  });

  app.post("/v2/benchmarks/generate", async (req: Request, res: Response) => {
    try {
      ensureV2Enabled();
      if (!config.v2BenchmarkMode) {
        throw new Error("OPENBRAIN_V2_BENCHMARK_MODE is disabled.");
      }
      const principal = await resolveV2Principal(req, {
        allowExternalService: false,
        domain: "benchmark",
        operation: "generate"
      });
      res.locals.v2Principal = principal;
      res.locals.v2Operation = "benchmark.generate";
      const payload = v2BenchGenerateSchema.parse(req.body);
      const result = await generateBenchmarks(payload);
      res.locals.v2Response = result as Record<string, unknown>;
      res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.locals.v2Error = message;
      res.status(400).json({ ok: false, error: message });
    }
  });

  app.post("/v2/benchmarks/run", async (req: Request, res: Response) => {
    try {
      ensureV2Enabled();
      if (!config.v2BenchmarkMode) {
        throw new Error("OPENBRAIN_V2_BENCHMARK_MODE is disabled.");
      }
      const principal = await resolveV2Principal(req, {
        allowExternalService: false,
        domain: "benchmark",
        operation: "run"
      });
      res.locals.v2Principal = principal;
      res.locals.v2Operation = "benchmark.run";
      const payload = v2BenchRunSchema.parse(req.body);
      const result = await runBenchmark(payload);
      res.locals.v2Response = result as Record<string, unknown>;
      res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.locals.v2Error = message;
      res.status(400).json({ ok: false, error: message });
    }
  });

  app.get("/v2/benchmarks/signal_profile", async (req: Request, res: Response) => {
    try {
      ensureV2Enabled();
      if (!config.v2BenchmarkMode) {
        throw new Error("OPENBRAIN_V2_BENCHMARK_MODE is disabled.");
      }
      const principal = await resolveV2Principal(req, {
        allowExternalService: false,
        domain: "benchmark",
        operation: "signal_profile"
      });
      res.locals.v2Principal = principal;
      res.locals.v2Operation = "benchmark.signal_profile";
      const payload = v2BenchSignalSchema.parse({
        benchmarkSet: req.query.benchmarkSet,
        chatNamespace: req.query.chatNamespace,
        minDomainScore: req.query.minDomainScore != null ? Number(req.query.minDomainScore) : undefined,
        minDomainRows: req.query.minDomainRows != null ? Number(req.query.minDomainRows) : undefined
      });
      const result = await benchmarkSignalProfile(payload);
      res.locals.v2Response = result as Record<string, unknown>;
      res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.locals.v2Error = message;
      res.status(400).json({ ok: false, error: message });
    }
  });

  app.post("/v2/benchmarks/activate_by_signal", async (req: Request, res: Response) => {
    try {
      ensureV2Enabled();
      if (!config.v2BenchmarkMode) {
        throw new Error("OPENBRAIN_V2_BENCHMARK_MODE is disabled.");
      }
      const principal = await resolveV2Principal(req, {
        allowExternalService: false,
        domain: "benchmark",
        operation: "activate_by_signal"
      });
      res.locals.v2Principal = principal;
      res.locals.v2Operation = "benchmark.activate_by_signal";
      const payload = v2BenchSignalSchema.parse(req.body);
      const result = await activateBenchmarksBySignal(payload);
      res.locals.v2Response = result as Record<string, unknown>;
      res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.locals.v2Error = message;
      res.status(400).json({ ok: false, error: message });
    }
  });

  app.get("/v2/benchmarks/report", async (req: Request, res: Response) => {
    try {
      ensureV2Enabled();
      if (!config.v2BenchmarkMode) {
        throw new Error("OPENBRAIN_V2_BENCHMARK_MODE is disabled.");
      }
      const principal = await resolveV2Principal(req, {
        allowExternalService: false,
        domain: "benchmark",
        operation: "report"
      });
      res.locals.v2Principal = principal;
      res.locals.v2Operation = "benchmark.report";
      const runId = String(req.query.runId ?? "").trim() || undefined;
      const benchmarkSet = String(req.query.benchmarkSet ?? "").trim() || undefined;
      const limit = Number(req.query.limit ?? 300);
      const result = await benchmarkReport({ runId, benchmarkSet, limit });
      res.locals.v2Response = result as Record<string, unknown>;
      res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.locals.v2Error = message;
      res.status(400).json({ ok: false, error: message });
    }
  });

  app.post("/v2/experiments/start", async (req: Request, res: Response) => {
    try {
      ensureV2Enabled();
      if (!config.v2BenchmarkMode) {
        throw new Error("OPENBRAIN_V2_BENCHMARK_MODE is disabled.");
      }
      const principal = await resolveV2Principal(req, {
        allowExternalService: false,
        domain: "benchmark",
        operation: "experiment_start"
      });
      res.locals.v2Principal = principal;
      res.locals.v2Operation = "experiment.start";
      const payload = v2ExperimentStartSchema.parse(req.body);
      const result = await startExperiment(payload as Parameters<typeof startExperiment>[0]);
      res.locals.v2Response = result as Record<string, unknown>;
      res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.locals.v2Error = message;
      res.status(400).json({ ok: false, error: message });
    }
  });

  app.get("/v2/experiments/list", async (req: Request, res: Response) => {
    try {
      ensureV2Enabled();
      if (!config.v2BenchmarkMode) {
        throw new Error("OPENBRAIN_V2_BENCHMARK_MODE is disabled.");
      }
      const principal = await resolveV2Principal(req, {
        allowExternalService: false,
        domain: "benchmark",
        operation: "experiment_list"
      });
      res.locals.v2Principal = principal;
      res.locals.v2Operation = "experiment.list";
      const result = await experimentList({
        limit: req.query.limit != null ? Number(req.query.limit) : undefined,
        status: String(req.query.status ?? "").trim() || undefined,
        q: String(req.query.q ?? "").trim() || undefined
      });
      res.locals.v2Response = result as Record<string, unknown>;
      res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.locals.v2Error = message;
      res.status(400).json({ ok: false, error: message });
    }
  });

  app.get("/v2/taxonomy/versions", async (req: Request, res: Response) => {
    try {
      ensureV2Enabled();
      if (!config.v2BenchmarkMode) {
        throw new Error("OPENBRAIN_V2_BENCHMARK_MODE is disabled.");
      }
      const principal = await resolveV2Principal(req, {
        allowExternalService: false,
        domain: "benchmark",
        operation: "taxonomy_versions_list"
      });
      res.locals.v2Principal = principal;
      res.locals.v2Operation = "taxonomy.versions.list";
      const result = await taxonomyVersionsList();
      res.locals.v2Response = result as Record<string, unknown>;
      res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.locals.v2Error = message;
      res.status(400).json({ ok: false, error: message });
    }
  });

  app.get("/v2/taxonomy/versions/:id", async (req: Request, res: Response) => {
    try {
      ensureV2Enabled();
      if (!config.v2BenchmarkMode) {
        throw new Error("OPENBRAIN_V2_BENCHMARK_MODE is disabled.");
      }
      const principal = await resolveV2Principal(req, {
        allowExternalService: false,
        domain: "benchmark",
        operation: "taxonomy_version_detail"
      });
      res.locals.v2Principal = principal;
      res.locals.v2Operation = "taxonomy.version.detail";
      const result = await taxonomyVersionDetail({ versionId: String(req.params.id ?? "").trim() });
      res.locals.v2Response = result as Record<string, unknown>;
      res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.locals.v2Error = message;
      res.status(400).json({ ok: false, error: message });
    }
  });

  app.post("/v2/taxonomy/versions/:id/scan_support", async (req: Request, res: Response) => {
    try {
      ensureV2Enabled();
      if (!config.v2BenchmarkMode) {
        throw new Error("OPENBRAIN_V2_BENCHMARK_MODE is disabled.");
      }
      const principal = await resolveV2Principal(req, {
        allowExternalService: false,
        domain: "benchmark",
        operation: "taxonomy_scan_support"
      });
      res.locals.v2Principal = principal;
      res.locals.v2Operation = "taxonomy.version.scan_support";
      const payload = v2TaxonomyScanSchema.parse(req.body ?? {});
      const result = await scanTaxonomyVersionSupport({
        versionId: String(req.params.id ?? "").trim(),
        chatNamespace: payload.chatNamespace
      });
      res.locals.v2Response = result as Record<string, unknown>;
      res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.locals.v2Error = message;
      res.status(400).json({ ok: false, error: message });
    }
  });

  app.get("/v2/taxonomy/versions/:id/support_matrix", async (req: Request, res: Response) => {
    try {
      ensureV2Enabled();
      if (!config.v2BenchmarkMode) {
        throw new Error("OPENBRAIN_V2_BENCHMARK_MODE is disabled.");
      }
      const principal = await resolveV2Principal(req, {
        allowExternalService: false,
        domain: "benchmark",
        operation: "taxonomy_support_matrix"
      });
      res.locals.v2Principal = principal;
      res.locals.v2Operation = "taxonomy.version.support_matrix";
      const result = await taxonomySupportMatrix({
        versionId: String(req.params.id ?? "").trim(),
        chatNamespace: String(req.query.chatNamespace ?? "").trim() || undefined
      });
      res.locals.v2Response = result as Record<string, unknown>;
      res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.locals.v2Error = message;
      res.status(400).json({ ok: false, error: message });
    }
  });

  app.get("/v2/taxonomy/versions/:id/facet_coverage", async (req: Request, res: Response) => {
    try {
      if (!res.locals.principal) {
        return res.status(401).json({ ok: false, error: "Unauthorized session" });
      }
      res.locals.v2Operation = "taxonomy.version.facet_coverage";
      const result = await taxonomyFacetCoverage({
        versionId: String(req.params.id ?? "").trim(),
        chatNamespace: typeof req.query.chatNamespace === "string" ? req.query.chatNamespace : undefined,
        facetType: typeof req.query.facetType === "string" ? req.query.facetType : undefined,
        coverageStatus: typeof req.query.coverageStatus === "string" ? req.query.coverageStatus : undefined,
        page: typeof req.query.page === "string" ? Number(req.query.page) : undefined,
        pageSize: typeof req.query.pageSize === "string" ? Number(req.query.pageSize) : undefined
      });
      res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ ok: false, error: message });
    }
  });

  app.post("/v2/taxonomy/versions/:id/generate_candidates", async (req: Request, res: Response) => {
    try {
      ensureV2Enabled();
      if (!config.v2BenchmarkMode) {
        throw new Error("OPENBRAIN_V2_BENCHMARK_MODE is disabled.");
      }
      const principal = await resolveV2Principal(req, {
        allowExternalService: false,
        domain: "benchmark",
        operation: "taxonomy_generate_candidates"
      });
      res.locals.v2Principal = principal;
      res.locals.v2Operation = "taxonomy.version.generate_candidates";
      const result = await generateTaxonomyCandidates({ versionId: String(req.params.id ?? "").trim() });
      res.locals.v2Response = result as Record<string, unknown>;
      res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.locals.v2Error = message;
      res.status(400).json({ ok: false, error: message });
    }
  });

  app.get("/v2/taxonomy/versions/:id/candidates", async (req: Request, res: Response) => {
    try {
      ensureV2Enabled();
      if (!config.v2BenchmarkMode) {
        throw new Error("OPENBRAIN_V2_BENCHMARK_MODE is disabled.");
      }
      const principal = await resolveV2Principal(req, {
        allowExternalService: false,
        domain: "benchmark",
        operation: "taxonomy_candidates_list"
      });
      res.locals.v2Principal = principal;
      res.locals.v2Operation = "taxonomy.version.candidates";
      const result = await taxonomyCandidates({ versionId: String(req.params.id ?? "").trim() });
      res.locals.v2Response = result as Record<string, unknown>;
      res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.locals.v2Error = message;
      res.status(400).json({ ok: false, error: message });
    }
  });

  app.post("/v2/taxonomy/candidates/:id/review", async (req: Request, res: Response) => {
    try {
      ensureV2Enabled();
      if (!config.v2BenchmarkMode) {
        throw new Error("OPENBRAIN_V2_BENCHMARK_MODE is disabled.");
      }
      const principal = await resolveV2Principal(req, {
        allowExternalService: false,
        domain: "benchmark",
        operation: "taxonomy_candidate_review"
      });
      res.locals.v2Principal = principal;
      res.locals.v2Operation = "taxonomy.candidate.review";
      const payload = v2TaxonomyCandidateReviewSchema.parse(req.body ?? {});
      const result = await reviewTaxonomyCandidate({
        candidateId: String(req.params.id ?? "").trim(),
        decision: payload.decision,
        targetKey: payload.targetKey,
        notes: payload.notes
      });
      res.locals.v2Response = result as Record<string, unknown>;
      res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.locals.v2Error = message;
      res.status(400).json({ ok: false, error: message });
    }
  });

  app.post("/v2/taxonomy/versions/:id/publish", async (req: Request, res: Response) => {
    try {
      ensureV2Enabled();
      if (!config.v2BenchmarkMode) {
        throw new Error("OPENBRAIN_V2_BENCHMARK_MODE is disabled.");
      }
      const principal = await resolveV2Principal(req, {
        allowExternalService: false,
        domain: "benchmark",
        operation: "taxonomy_publish"
      });
      res.locals.v2Principal = principal;
      res.locals.v2Operation = "taxonomy.version.publish";
      const result = await publishTaxonomyVersion({ versionId: String(req.params.id ?? "").trim() });
      res.locals.v2Response = result as Record<string, unknown>;
      res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.locals.v2Error = message;
      res.status(400).json({ ok: false, error: message });
    }
  });

  app.post("/v2/experiments/run_step", async (req: Request, res: Response) => {
    try {
      ensureV2Enabled();
      if (!config.v2BenchmarkMode) {
        throw new Error("OPENBRAIN_V2_BENCHMARK_MODE is disabled.");
      }
      const principal = await resolveV2Principal(req, {
        allowExternalService: false,
        domain: "benchmark",
        operation: "experiment_run_step"
      });
      res.locals.v2Principal = principal;
      res.locals.v2Operation = "experiment.run_step";
      const payload = v2ExperimentStepSchema.parse(req.body);
      const result = await runExperimentStep(payload);
      res.locals.v2Response = result as Record<string, unknown>;
      res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.locals.v2Error = message;
      res.status(400).json({ ok: false, error: message });
    }
  });

  app.post("/v2/experiments/:id/benchmark/lock", async (req: Request, res: Response) => {
    try {
      ensureV2Enabled();
      if (!config.v2BenchmarkMode) {
        throw new Error("OPENBRAIN_V2_BENCHMARK_MODE is disabled.");
      }
      const principal = await resolveV2Principal(req, {
        allowExternalService: false,
        domain: "benchmark",
        operation: "experiment_benchmark_lock"
      });
      res.locals.v2Principal = principal;
      res.locals.v2Operation = "experiment.benchmark.lock";
      const payload = v2ExperimentBenchmarkLockSchema.parse(req.body ?? {});
      const result = await lockExperimentBenchmark({
        experimentId: String(req.params.id ?? "").trim(),
        lockVersion: payload.lockVersion,
        lockStage: payload.lockStage
      });
      res.locals.v2Response = result as Record<string, unknown>;
      res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.locals.v2Error = message;
      res.status(400).json({ ok: false, error: message });
    }
  });

  app.get("/v2/experiments/:id/benchmark_freshness", async (req: Request, res: Response) => {
    try {
      ensureV2Enabled();
      if (!config.v2BenchmarkMode) {
        throw new Error("OPENBRAIN_V2_BENCHMARK_MODE is disabled.");
      }
      const principal = await resolveV2Principal(req, {
        allowExternalService: false,
        domain: "benchmark",
        operation: "experiment_benchmark_freshness"
      });
      res.locals.v2Principal = principal;
      res.locals.v2Operation = "experiment.benchmark_freshness";
      const result = await experimentBenchmarkFreshness({ experimentId: String(req.params.id ?? "").trim() });
      res.locals.v2Response = result as Record<string, unknown>;
      res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.locals.v2Error = message;
      res.status(400).json({ ok: false, error: message });
    }
  });

  app.post("/v2/experiments/:id/reseed_from_taxonomy_version", async (req: Request, res: Response) => {
    try {
      ensureV2Enabled();
      if (!config.v2BenchmarkMode) {
        throw new Error("OPENBRAIN_V2_BENCHMARK_MODE is disabled.");
      }
      const principal = await resolveV2Principal(req, {
        allowExternalService: false,
        domain: "benchmark",
        operation: "experiment_reseed_from_taxonomy_version"
      });
      res.locals.v2Principal = principal;
      res.locals.v2Operation = "experiment.reseed_from_taxonomy_version";
      const payload = v2ExperimentReseedTaxonomySchema.parse(req.body ?? {});
      const result = await reseedExperimentFromTaxonomyVersion({
        experimentId: String(req.params.id ?? "").trim(),
        taxonomyVersionId: payload.taxonomyVersionId
      });
      res.locals.v2Response = result as Record<string, unknown>;
      res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.locals.v2Error = message;
      res.status(400).json({ ok: false, error: message });
    }
  });

  app.get("/v2/experiments/:id/benchmark/lock", async (req: Request, res: Response) => {
    try {
      ensureV2Enabled();
      if (!config.v2BenchmarkMode) {
        throw new Error("OPENBRAIN_V2_BENCHMARK_MODE is disabled.");
      }
      const principal = await resolveV2Principal(req, {
        allowExternalService: false,
        domain: "benchmark",
        operation: "experiment_benchmark_lock_status"
      });
      res.locals.v2Principal = principal;
      res.locals.v2Operation = "experiment.benchmark.lock.status";
      const result = await getExperimentBenchmarkLock({
        experimentId: String(req.params.id ?? "").trim()
      });
      res.locals.v2Response = result as Record<string, unknown>;
      res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.locals.v2Error = message;
      res.status(400).json({ ok: false, error: message });
    }
  });

  app.get("/v2/experiments/:id/benchmark/debt", async (req: Request, res: Response) => {
    try {
      ensureV2Enabled();
      if (!config.v2BenchmarkMode) {
        throw new Error("OPENBRAIN_V2_BENCHMARK_MODE is disabled.");
      }
      const principal = await resolveV2Principal(req, {
        allowExternalService: false,
        domain: "benchmark",
        operation: "experiment_benchmark_debt"
      });
      res.locals.v2Principal = principal;
      res.locals.v2Operation = "experiment.benchmark.debt";
      const result = await getExperimentBenchmarkDebt({
        experimentId: String(req.params.id ?? "").trim()
      });
      res.locals.v2Response = result as Record<string, unknown>;
      res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.locals.v2Error = message;
      res.status(400).json({ ok: false, error: message });
    }
  });

  app.get("/v2/experiments/:id/evolution/overview", async (req: Request, res: Response) => {
    try {
      ensureV2Enabled();
      if (!config.v2BenchmarkMode) {
        throw new Error("OPENBRAIN_V2_BENCHMARK_MODE is disabled.");
      }
      const principal = await resolveV2Principal(req, {
        allowExternalService: false,
        domain: "benchmark",
        operation: "experiment_evolution_overview"
      });
      res.locals.v2Principal = principal;
      res.locals.v2Operation = "experiment.evolution.overview";
      const result = await experimentEvolutionOverview({
        experimentId: String(req.params.id ?? "").trim()
      });
      res.locals.v2Response = result as Record<string, unknown>;
      res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.locals.v2Error = message;
      res.status(400).json({ ok: false, error: message });
    }
  });

  app.get("/v2/experiments/:id/evolution/frontier", async (req: Request, res: Response) => {
    try {
      ensureV2Enabled();
      if (!config.v2BenchmarkMode) {
        throw new Error("OPENBRAIN_V2_BENCHMARK_MODE is disabled.");
      }
      const principal = await resolveV2Principal(req, {
        allowExternalService: false,
        domain: "benchmark",
        operation: "experiment_evolution_frontier"
      });
      res.locals.v2Principal = principal;
      res.locals.v2Operation = "experiment.evolution.frontier";
      const result = await experimentEvolutionFrontier({
        experimentId: String(req.params.id ?? "").trim()
      });
      res.locals.v2Response = result as Record<string, unknown>;
      res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.locals.v2Error = message;
      res.status(400).json({ ok: false, error: message });
    }
  });

  app.get("/v2/experiments/:id/evolution/timeseries", async (req: Request, res: Response) => {
    try {
      ensureV2Enabled();
      if (!config.v2BenchmarkMode) {
        throw new Error("OPENBRAIN_V2_BENCHMARK_MODE is disabled.");
      }
      const principal = await resolveV2Principal(req, {
        allowExternalService: false,
        domain: "benchmark",
        operation: "experiment_evolution_timeseries"
      });
      res.locals.v2Principal = principal;
      res.locals.v2Operation = "experiment.evolution.timeseries";
      const result = await experimentEvolutionTimeseries({
        experimentId: String(req.params.id ?? "").trim()
      });
      res.locals.v2Response = result as Record<string, unknown>;
      res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.locals.v2Error = message;
      res.status(400).json({ ok: false, error: message });
    }
  });

  app.get("/v2/experiments/:id/evolution/component_heatmap", async (req: Request, res: Response) => {
    try {
      ensureV2Enabled();
      if (!config.v2BenchmarkMode) {
        throw new Error("OPENBRAIN_V2_BENCHMARK_MODE is disabled.");
      }
      const principal = await resolveV2Principal(req, {
        allowExternalService: false,
        domain: "benchmark",
        operation: "experiment_evolution_component_heatmap"
      });
      res.locals.v2Principal = principal;
      res.locals.v2Operation = "experiment.evolution.component_heatmap";
      const result = await experimentEvolutionComponentHeatmap({
        experimentId: String(req.params.id ?? "").trim(),
        maxComponents: req.query.maxComponents != null ? Number(req.query.maxComponents) : undefined,
        maxDomains: req.query.maxDomains != null ? Number(req.query.maxDomains) : undefined
      });
      res.locals.v2Response = result as Record<string, unknown>;
      res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.locals.v2Error = message;
      res.status(400).json({ ok: false, error: message });
    }
  });

  app.get("/v2/experiments/:id/evolution/diversity", async (req: Request, res: Response) => {
    try {
      ensureV2Enabled();
      if (!config.v2BenchmarkMode) {
        throw new Error("OPENBRAIN_V2_BENCHMARK_MODE is disabled.");
      }
      const principal = await resolveV2Principal(req, {
        allowExternalService: false,
        domain: "benchmark",
        operation: "experiment_evolution_diversity"
      });
      res.locals.v2Principal = principal;
      res.locals.v2Operation = "experiment.evolution.diversity";
      const result = await experimentEvolutionDiversity({
        experimentId: String(req.params.id ?? "").trim()
      });
      res.locals.v2Response = result as Record<string, unknown>;
      res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.locals.v2Error = message;
      res.status(400).json({ ok: false, error: message });
    }
  });

  app.get("/v2/experiments/:id/evolution/coverage", async (req: Request, res: Response) => {
    try {
      ensureV2Enabled();
      if (!config.v2BenchmarkMode) {
        throw new Error("OPENBRAIN_V2_BENCHMARK_MODE is disabled.");
      }
      const principal = await resolveV2Principal(req, {
        allowExternalService: false,
        domain: "benchmark",
        operation: "experiment_evolution_coverage"
      });
      res.locals.v2Principal = principal;
      res.locals.v2Operation = "experiment.evolution.coverage";
      const result = await experimentEvolutionCoverage({
        experimentId: String(req.params.id ?? "").trim()
      });
      res.locals.v2Response = result as Record<string, unknown>;
      res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.locals.v2Error = message;
      res.status(400).json({ ok: false, error: message });
    }
  });

  app.get("/v2/experiments/:id/preloop/readiness", async (req: Request, res: Response) => {
    try {
      ensureV2Enabled();
      if (!config.v2BenchmarkMode) {
        throw new Error("OPENBRAIN_V2_BENCHMARK_MODE is disabled.");
      }
      const principal = await resolveV2Principal(req, {
        allowExternalService: false,
        domain: "benchmark",
        operation: "experiment_preloop_readiness"
      });
      res.locals.v2Principal = principal;
      res.locals.v2Operation = "experiment.preloop.readiness";
      const result = await experimentPreloopReadiness({
        experimentId: String(req.params.id ?? "").trim()
      });
      res.locals.v2Response = result as Record<string, unknown>;
      res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.locals.v2Error = message;
      res.status(400).json({ ok: false, error: message });
    }
  });

  app.get("/v2/experiments/:id/status", async (req: Request, res: Response) => {
    try {
      ensureV2Enabled();
      if (!config.v2BenchmarkMode) {
        throw new Error("OPENBRAIN_V2_BENCHMARK_MODE is disabled.");
      }
      const principal = await resolveV2Principal(req, {
        allowExternalService: false,
        domain: "benchmark",
        operation: "experiment_status"
      });
      res.locals.v2Principal = principal;
      res.locals.v2Operation = "experiment.status";
      const result = await experimentStatus(String(req.params.id ?? "").trim());
      res.locals.v2Response = result as Record<string, unknown>;
      res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.locals.v2Error = message;
      res.status(400).json({ ok: false, error: message });
    }
  });

  app.get("/v2/experiments/leaderboard", async (req: Request, res: Response) => {
    try {
      ensureV2Enabled();
      if (!config.v2BenchmarkMode) {
        throw new Error("OPENBRAIN_V2_BENCHMARK_MODE is disabled.");
      }
      const principal = await resolveV2Principal(req, {
        allowExternalService: false,
        domain: "benchmark",
        operation: "experiment_leaderboard"
      });
      res.locals.v2Principal = principal;
      res.locals.v2Operation = "experiment.leaderboard";
      const experimentId = String(req.query.experimentId ?? "").trim() || undefined;
      const result = await experimentLeaderboard(experimentId);
      res.locals.v2Response = result as Record<string, unknown>;
      res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.locals.v2Error = message;
      res.status(400).json({ ok: false, error: message });
    }
  });

  app.get("/v2/experiments/:id/failures", async (req: Request, res: Response) => {
    try {
      ensureV2Enabled();
      if (!config.v2BenchmarkMode) {
        throw new Error("OPENBRAIN_V2_BENCHMARK_MODE is disabled.");
      }
      const principal = await resolveV2Principal(req, {
        allowExternalService: false,
        domain: "benchmark",
        operation: "experiment_failures"
      });
      res.locals.v2Principal = principal;
      res.locals.v2Operation = "experiment.failures";
      const result = await experimentFailures({
        experimentId: String(req.params.id ?? "").trim(),
        variantId: String(req.query.variantId ?? "").trim() || undefined,
        limit: req.query.limit != null ? Number(req.query.limit) : undefined
      });
      res.locals.v2Response = result as Record<string, unknown>;
      res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.locals.v2Error = message;
      res.status(400).json({ ok: false, error: message });
    }
  });

  app.get("/v2/experiments/:id/components/leaderboard", async (req: Request, res: Response) => {
    try {
      ensureV2Enabled();
      if (!config.v2BenchmarkMode) {
        throw new Error("OPENBRAIN_V2_BENCHMARK_MODE is disabled.");
      }
      const principal = await resolveV2Principal(req, {
        allowExternalService: false,
        domain: "benchmark",
        operation: "experiment_components_leaderboard"
      });
      res.locals.v2Principal = principal;
      res.locals.v2Operation = "experiment.components.leaderboard";
      const result = await experimentComponentLeaderboard({
        experimentId: String(req.params.id ?? "").trim(),
        limit: req.query.limit != null ? Number(req.query.limit) : undefined
      });
      res.locals.v2Response = result as Record<string, unknown>;
      res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.locals.v2Error = message;
      res.status(400).json({ ok: false, error: message });
    }
  });

  app.get("/v2/experiments/:id/components/stability", async (req: Request, res: Response) => {
    try {
      ensureV2Enabled();
      if (!config.v2BenchmarkMode) {
        throw new Error("OPENBRAIN_V2_BENCHMARK_MODE is disabled.");
      }
      const principal = await resolveV2Principal(req, {
        allowExternalService: false,
        domain: "benchmark",
        operation: "experiment_components_stability"
      });
      res.locals.v2Principal = principal;
      res.locals.v2Operation = "experiment.components.stability";
      const result = await experimentComponentStability({
        experimentId: String(req.params.id ?? "").trim(),
        limit: req.query.limit != null ? Number(req.query.limit) : undefined
      });
      res.locals.v2Response = result as Record<string, unknown>;
      res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.locals.v2Error = message;
      res.status(400).json({ ok: false, error: message });
    }
  });

  app.get("/v2/experiments/:id/hypotheses", async (req: Request, res: Response) => {
    try {
      ensureV2Enabled();
      if (!config.v2BenchmarkMode) {
        throw new Error("OPENBRAIN_V2_BENCHMARK_MODE is disabled.");
      }
      const principal = await resolveV2Principal(req, {
        allowExternalService: false,
        domain: "benchmark",
        operation: "experiment_hypotheses_list"
      });
      res.locals.v2Principal = principal;
      res.locals.v2Operation = "experiment.hypotheses.list";
      const result = await experimentHypotheses({
        experimentId: String(req.params.id ?? "").trim(),
        limit: req.query.limit != null ? Number(req.query.limit) : undefined
      });
      res.locals.v2Response = result as Record<string, unknown>;
      res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.locals.v2Error = message;
      res.status(400).json({ ok: false, error: message });
    }
  });

  app.get("/v2/experiments/:id/hypotheses/:hypothesisId", async (req: Request, res: Response) => {
    try {
      ensureV2Enabled();
      if (!config.v2BenchmarkMode) {
        throw new Error("OPENBRAIN_V2_BENCHMARK_MODE is disabled.");
      }
      const principal = await resolveV2Principal(req, {
        allowExternalService: false,
        domain: "benchmark",
        operation: "experiment_hypothesis_detail"
      });
      res.locals.v2Principal = principal;
      res.locals.v2Operation = "experiment.hypothesis.detail";
      const result = await experimentHypothesisDetail({
        experimentId: String(req.params.id ?? "").trim(),
        hypothesisId: String(req.params.hypothesisId ?? "").trim()
      });
      res.locals.v2Response = result as Record<string, unknown>;
      res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.locals.v2Error = message;
      res.status(400).json({ ok: false, error: message });
    }
  });

  app.post("/v2/experiments/:id/hypotheses/generate", async (req: Request, res: Response) => {
    try {
      ensureV2Enabled();
      if (!config.v2BenchmarkMode) {
        throw new Error("OPENBRAIN_V2_BENCHMARK_MODE is disabled.");
      }
      const principal = await resolveV2Principal(req, {
        allowExternalService: false,
        domain: "benchmark",
        operation: "experiment_hypotheses_generate"
      });
      res.locals.v2Principal = principal;
      res.locals.v2Operation = "experiment.hypotheses.generate";
      const result = await generateExperimentHypotheses({
        experimentId: String(req.params.id ?? "").trim(),
        count: req.body && typeof req.body === "object" && (req.body as Record<string, unknown>).count != null
          ? Number((req.body as Record<string, unknown>).count)
          : undefined
      });
      res.locals.v2Response = result as Record<string, unknown>;
      res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.locals.v2Error = message;
      res.status(400).json({ ok: false, error: message });
    }
  });

  app.post("/v2/experiments/:id/hypotheses/evaluate", async (req: Request, res: Response) => {
    try {
      ensureV2Enabled();
      if (!config.v2BenchmarkMode) {
        throw new Error("OPENBRAIN_V2_BENCHMARK_MODE is disabled.");
      }
      const principal = await resolveV2Principal(req, {
        allowExternalService: false,
        domain: "benchmark",
        operation: "experiment_hypotheses_evaluate"
      });
      res.locals.v2Principal = principal;
      res.locals.v2Operation = "experiment.hypotheses.evaluate";
      const body = req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {};
      const result = await evaluateExperimentHypotheses({
        experimentId: String(req.params.id ?? "").trim(),
        hypothesisId: String(body.hypothesisId ?? "").trim() || undefined
      });
      res.locals.v2Response = result as Record<string, unknown>;
      res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.locals.v2Error = message;
      res.status(400).json({ ok: false, error: message });
    }
  });

  app.post("/v2/experiments/:id/recompose", async (req: Request, res: Response) => {
    try {
      ensureV2Enabled();
      if (!config.v2BenchmarkMode) {
        throw new Error("OPENBRAIN_V2_BENCHMARK_MODE is disabled.");
      }
      const principal = await resolveV2Principal(req, {
        allowExternalService: false,
        domain: "benchmark",
        operation: "experiment_recompose"
      });
      res.locals.v2Principal = principal;
      res.locals.v2Operation = "experiment.recompose";
      const result = await recomposeExperimentStrategies({
        experimentId: String(req.params.id ?? "").trim(),
        count: req.body && typeof req.body === "object" && (req.body as Record<string, unknown>).count != null
          ? Number((req.body as Record<string, unknown>).count)
          : undefined
      });
      res.locals.v2Response = result as Record<string, unknown>;
      res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.locals.v2Error = message;
      res.status(400).json({ ok: false, error: message });
    }
  });

  app.get("/v2/experiments/:id/lineage", async (req: Request, res: Response) => {
    try {
      ensureV2Enabled();
      if (!config.v2BenchmarkMode) {
        throw new Error("OPENBRAIN_V2_BENCHMARK_MODE is disabled.");
      }
      const principal = await resolveV2Principal(req, {
        allowExternalService: false,
        domain: "benchmark",
        operation: "experiment_lineage"
      });
      res.locals.v2Principal = principal;
      res.locals.v2Operation = "experiment.lineage";
      const result = await experimentLineage({
        experimentId: String(req.params.id ?? "").trim()
      });
      res.locals.v2Response = result as Record<string, unknown>;
      res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.locals.v2Error = message;
      res.status(400).json({ ok: false, error: message });
    }
  });

  app.get("/v2/experiments/:id/governance/leakage", async (req: Request, res: Response) => {
    try {
      ensureV2Enabled();
      if (!config.v2BenchmarkMode) {
        throw new Error("OPENBRAIN_V2_BENCHMARK_MODE is disabled.");
      }
      const principal = await resolveV2Principal(req, {
        allowExternalService: false,
        domain: "benchmark",
        operation: "experiment_governance_leakage"
      });
      res.locals.v2Principal = principal;
      res.locals.v2Operation = "experiment.governance.leakage";
      const result = await experimentGovernanceLeakage({
        experimentId: String(req.params.id ?? "").trim(),
        limit: req.query.limit != null ? Number(req.query.limit) : undefined
      });
      res.locals.v2Response = result as Record<string, unknown>;
      res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.locals.v2Error = message;
      res.status(400).json({ ok: false, error: message });
    }
  });

  app.post("/v2/experiments/:id/calibration/sample", async (req: Request, res: Response) => {
    try {
      ensureV2Enabled();
      if (!config.v2BenchmarkMode) {
        throw new Error("OPENBRAIN_V2_BENCHMARK_MODE is disabled.");
      }
      const principal = await resolveV2Principal(req, {
        allowExternalService: false,
        domain: "benchmark",
        operation: "experiment_calibration_sample"
      });
      res.locals.v2Principal = principal;
      res.locals.v2Operation = "experiment.calibration.sample";
      const body = req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {};
      const caseSetRaw = String(body.caseSet ?? "").trim();
      const caseSet = (["dev", "critical", "certification", "stress", "coverage"] as const).includes(caseSetRaw as never)
        ? (caseSetRaw as "dev" | "critical" | "certification" | "stress" | "coverage")
        : undefined;
      const result = await createJudgeCalibrationSample({
        experimentId: String(req.params.id ?? "").trim(),
        count: body.count != null ? Number(body.count) : undefined,
        caseSet,
        variantId: String(body.variantId ?? "").trim() || undefined,
        domain: String(body.domain ?? "").trim() || undefined
      });
      res.locals.v2Response = result as Record<string, unknown>;
      res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.locals.v2Error = message;
      res.status(400).json({ ok: false, error: message });
    }
  });

  app.get("/v2/experiments/:id/calibration/pending", async (req: Request, res: Response) => {
    try {
      ensureV2Enabled();
      if (!config.v2BenchmarkMode) {
        throw new Error("OPENBRAIN_V2_BENCHMARK_MODE is disabled.");
      }
      const principal = await resolveV2Principal(req, {
        allowExternalService: false,
        domain: "benchmark",
        operation: "experiment_calibration_pending"
      });
      res.locals.v2Principal = principal;
      res.locals.v2Operation = "experiment.calibration.pending";
      const result = await listJudgeCalibrationPending({
        experimentId: String(req.params.id ?? "").trim(),
        limit: req.query.limit != null ? Number(req.query.limit) : undefined,
        status: req.query.status != null ? String(req.query.status).trim().toLowerCase() as "pending" | "labeled" | "all" : undefined,
        verdict: req.query.verdict != null ? String(req.query.verdict).trim().toLowerCase() as "yes" | "no" : undefined
      });
      res.locals.v2Response = result as Record<string, unknown>;
      res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.locals.v2Error = message;
      res.status(400).json({ ok: false, error: message });
    }
  });

  app.post("/v2/experiments/:id/calibration/label", async (req: Request, res: Response) => {
    try {
      ensureV2Enabled();
      if (!config.v2BenchmarkMode) {
        throw new Error("OPENBRAIN_V2_BENCHMARK_MODE is disabled.");
      }
      const principal = await resolveV2Principal(req, {
        allowExternalService: false,
        domain: "benchmark",
        operation: "experiment_calibration_label"
      });
      res.locals.v2Principal = principal;
      res.locals.v2Operation = "experiment.calibration.label";
      const body = req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {};
      const calibrationItemId = String(body.calibrationItemId ?? "").trim();
      const verdictRaw = String(body.verdict ?? "").trim().toLowerCase();
      const ambiguityRaw = String(body.ambiguityClass ?? "").trim().toLowerCase();
      if (!calibrationItemId) throw new Error("Missing calibrationItemId");
      if (verdictRaw !== "yes" && verdictRaw !== "no") throw new Error("verdict must be yes or no");
      if (ambiguityRaw && ambiguityRaw !== "clear" && ambiguityRaw !== "clarify_required" && ambiguityRaw !== "unresolved") {
        throw new Error("ambiguityClass must be clear | clarify_required | unresolved");
      }
      const result = await submitJudgeCalibrationLabel({
        calibrationItemId,
        verdict: verdictRaw as "yes" | "no",
        ambiguityClass: ambiguityRaw
          ? (ambiguityRaw as "clear" | "clarify_required" | "unresolved")
          : undefined,
        reviewer: String(body.reviewer ?? "owner").trim() || "owner",
        notes: String(body.notes ?? "").trim() || undefined
      });
      res.locals.v2Response = result as Record<string, unknown>;
      res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.locals.v2Error = message;
      res.status(400).json({ ok: false, error: message });
    }
  });

  app.post("/v2/experiments/:id/calibration/auto_review", async (req: Request, res: Response) => {
    try {
      ensureV2Enabled();
      if (!config.v2BenchmarkMode) {
        throw new Error("OPENBRAIN_V2_BENCHMARK_MODE is disabled.");
      }
      const principal = await resolveV2Principal(req, {
        allowExternalService: false,
        domain: "benchmark",
        operation: "experiment_calibration_auto_review"
      });
      res.locals.v2Principal = principal;
      res.locals.v2Operation = "experiment.calibration.auto_review";
      const body = req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {};
        const result = await autoReviewJudgeCalibration({
          experimentId: String(req.params.id ?? "").trim(),
          limit: body.limit != null ? Number(body.limit) : undefined,
          batchSize: body.batchSize != null ? Number(body.batchSize) : undefined,
          status: body.status != null ? String(body.status).trim().toLowerCase() as "pending" | "labeled" | "all" : undefined,
          domain: body.domain != null ? String(body.domain).trim() || undefined : undefined,
          caseSet: body.caseSet != null ? String(body.caseSet).trim() as "dev" | "critical" | "certification" | "stress" | "coverage" : undefined,
          refreshExisting: body.refreshExisting === true
        });
      res.locals.v2Response = result as Record<string, unknown>;
      res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.locals.v2Error = message;
      res.status(400).json({ ok: false, error: message });
    }
  });

  app.get("/v2/experiments/:id/calibration/report", async (req: Request, res: Response) => {
    try {
      ensureV2Enabled();
      if (!config.v2BenchmarkMode) {
        throw new Error("OPENBRAIN_V2_BENCHMARK_MODE is disabled.");
      }
      const principal = await resolveV2Principal(req, {
        allowExternalService: false,
        domain: "benchmark",
        operation: "experiment_calibration_report"
      });
      res.locals.v2Principal = principal;
      res.locals.v2Operation = "experiment.calibration.report";
      const result = await judgeCalibrationReport({
        experimentId: String(req.params.id ?? "").trim()
      });
      res.locals.v2Response = result as Record<string, unknown>;
      res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.locals.v2Error = message;
      res.status(400).json({ ok: false, error: message });
    }
  });

  app.get("/v2/experiments/strategies", async (req: Request, res: Response) => {
    try {
      ensureV2Enabled();
      if (!config.v2BenchmarkMode) {
        throw new Error("OPENBRAIN_V2_BENCHMARK_MODE is disabled.");
      }
      const principal = await resolveV2Principal(req, {
        allowExternalService: false,
        domain: "benchmark",
        operation: "experiment_strategies"
      });
      res.locals.v2Principal = principal;
      res.locals.v2Operation = "experiment.strategies";
      const result = { ok: true, strategies: listStrategyCatalog() };
      res.locals.v2Response = result as Record<string, unknown>;
      res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.locals.v2Error = message;
      res.status(400).json({ ok: false, error: message });
    }
  });

  app.post("/v2/services/register", async (req: Request, res: Response) => {
    try {
      ensureV2Enabled();
      const principal = await resolveV2Principal(req, {
        allowExternalService: false,
        domain: "service",
        operation: "register"
      });
      res.locals.v2Principal = principal;
      res.locals.v2Operation = "service.register";
      const payload = v2ServiceRegisterSchema.parse(req.body) as V2ServiceRegisterRequest;
      const result = await registerServiceIdentity(payload);
      res.locals.v2Response = result as Record<string, unknown>;
      res.json({ ok: true, ...result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.locals.v2Error = message;
      res.status(400).json({ ok: false, error: message });
    }
  });

  app.post("/v2/services/token", async (req: Request, res: Response) => {
    try {
      ensureV2Enabled();
      const principal = await resolveV2Principal(req, {
        allowExternalService: false,
        domain: "service",
        operation: "token"
      });
      res.locals.v2Principal = principal;
      res.locals.v2Operation = "service.token";
      const payload = v2ServiceTokenSchema.parse(req.body) as V2ServiceTokenRequest;
      const ttlSec = payload.ttlSec ?? config.v2ServiceTokenTtlSec;
      const result = await issueServiceToken({ serviceId: payload.serviceId, ttlSec });
      res.locals.v2Response = result as Record<string, unknown>;
      res.json({ ok: true, ...result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.locals.v2Error = message;
      res.status(400).json({ ok: false, error: message });
    }
  });

  app.get("/v2/services/audit", async (req: Request, res: Response) => {
    try {
      ensureV2Enabled();
      const principal = await resolveV2Principal(req, {
        allowExternalService: false,
        domain: "service",
        operation: "audit"
      });
      res.locals.v2Principal = principal;
      res.locals.v2Operation = "service.audit";
      const limit = Number(req.query.limit ?? 100);
      const events = await listApiAudit({ limit });
      const result = { ok: true, events };
      res.locals.v2Response = result as Record<string, unknown>;
      res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.locals.v2Error = message;
      res.status(400).json({ ok: false, error: message });
    }
  });

  app.use("/mcp", requireApiKey);
  await mountMcpHttp(app, "/mcp");

  startBrainWorker();
  if (config.v2BackgroundWorkerEnabled) {
    startV2Worker();
  }

  app.listen(config.port, config.host, () => {
    // eslint-disable-next-line no-console
    console.log(`OpenBrain service listening on http://${config.host}:${config.port}`);
  });
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error("OpenBrain startup failed:", error);
  process.exit(1);
});
