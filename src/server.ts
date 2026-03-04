import express, { Request, Response } from "express";
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
import { batchCapture, captureMemory, getStats, healthcheck, listRecent, searchMemory } from "./db.js";
import { mountMcpHttp } from "./mcp_http.js";
import { ensureExtendedSchema } from "./schema.js";
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

async function main(): Promise<void> {
  await ensureExtendedSchema();
  await bootstrapAuthUser();

  const app = express();
  app.disable("x-powered-by");

  app.use(express.json({ limit: "2mb" }));
  app.use(applyCors);
  app.use(applyRateLimit);

  app.get("/", (_req, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.send(renderAppHtml());
  });

  app.get("/app", (_req, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8");
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
      const items = await getPrivacyAwareTimeline({
        chatNamespace,
        start,
        end,
        domain,
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

  app.use("/mcp", requireApiKey);
  await mountMcpHttp(app, "/mcp");

  startBrainWorker();

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
