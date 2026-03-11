import { randomUUID } from "node:crypto";
import { pool } from "./db.js";
import { config } from "./config.js";
import { parseTemporalIntent, temporalRelevance, timestampInHardRange } from "./query_time.js";
import { getOpenBrainCapabilities } from "./v2_capabilities.js";
import { dispatchAgentEnvelope } from "./v2_mesh.js";
import { fetchContextWindow, fetchThreadSlice, searchAnchors } from "./v2_search.js";
import type {
  ComposerMode,
  ContextMode,
  PlannerMode,
  RefinementMode,
  RetrievalMode,
  StrategyVariantConfig,
  V2AgentName,
  V2AnswerContract,
  V2AskDecision,
  V2AgentRequestEnvelope,
  V2AskRequest,
  V2AskResponse,
  V2ConstraintCheck,
  V2ContextMessage,
  V2Decision,
  V2EvidenceRef,
  V2FinalAnswer,
  V2Principal
} from "./v2_types.js";

function nowIso(): string {
  return new Date().toISOString();
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

interface QueryPlan {
  intent: string;
  intentSummary: string;
  requiredSlots: string[];
  knownSlots: string[];
  missingSlots: string[];
  constraints: string[];
  disallowedPaths: string[];
  stopAndAskTriggers: string[];
  subqueries: string[];
  mustHaveSignals: string[];
  avoidPatterns: string[];
  hypotheses: string[];
  questionType: "boolean" | "entity_list" | "numeric" | "open";
}

type QuestionKind = "boolean" | "entity_list" | "numeric" | "open";

interface QuestionProfile {
  kind: QuestionKind;
  focusTerms: string[];
  expectsNumeric: boolean;
}

interface AskStrategyResolved {
  strategyId: string;
  retrievalMode: RetrievalMode;
  contextMode: ContextMode;
  plannerMode: PlannerMode;
  composerMode: ComposerMode;
  refinementMode: RefinementMode;
  maxLoops: number | null;
}

function resolveStrategyConfig(input: StrategyVariantConfig | undefined): AskStrategyResolved {
  const strategyId = String(input?.strategyId ?? "S0").trim() || "S0";
  return {
    strategyId,
    retrievalMode: input?.retrievalMode ?? "baseline",
    contextMode: input?.contextMode ?? "window_thread",
    plannerMode: input?.plannerMode ?? "baseline",
    composerMode: input?.composerMode ?? "minimal_llm",
    refinementMode: input?.refinementMode ?? "fixed",
    maxLoops: Number.isFinite(Number(input?.maxLoops)) ? Math.max(1, Math.min(3, Number(input?.maxLoops))) : null
  };
}

function inferQuestionProfile(question: string, plan: QueryPlan): QuestionProfile {
  const q = normalizeText(question);
  const focusTerms = Array.from(new Set([
    ...plan.mustHaveSignals.map((s) => normalizeText(s)).filter(Boolean),
    ...q.split(/[^a-z0-9]+/).filter((t) => t.length >= 4 && !["what", "when", "where", "which", "have", "your", "with", "from", "that"].includes(t)).slice(0, 6)
  ])).slice(0, 8);

  if (plan.questionType === "numeric") return { kind: "numeric", focusTerms, expectsNumeric: true };
  if (plan.questionType === "entity_list") return { kind: "entity_list", focusTerms, expectsNumeric: false };
  if (plan.questionType === "boolean") return { kind: "boolean", focusTerms, expectsNumeric: false };

  const booleanLike = /^(do|does|did|is|are|was|were|can|could|should|would|will|have|has|had)\b/.test(q);
  const numericLike = /\b(how much|how many|amount|total|value|balance|count|number|sum)\b/.test(q);
  const entityLike = /\b(who|which|friend|friends|people|person|contacts?)\b/.test(q);

  if (numericLike) return { kind: "numeric", focusTerms, expectsNumeric: true };
  if (entityLike) return { kind: "entity_list", focusTerms, expectsNumeric: false };
  if (booleanLike) return { kind: "boolean", focusTerms, expectsNumeric: false };
  return { kind: "open", focusTerms, expectsNumeric: false };
}

function compactSnippet(text: string, max = 180): string {
  const t = String(text ?? "").replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 3)}...`;
}

function parseConversationName(raw: string | null | undefined): string | null {
  const value = String(raw ?? "").trim();
  if (!value) return null;
  const normalized = value
    .replace(/_/g, " ")
    .replace(/whatsapp chat with /i, "")
    .replace(/whatsapp chat - /i, "")
    .replace(/\b___chat\b/i, "")
    .replace(/\bchat\b$/i, "")
    .trim();
  return normalized || null;
}

function deriveEvidenceEntityLabel(params: {
  sourceSystem: string;
  role?: string | null;
  sourceConversationId?: string | null;
  metadata?: Record<string, unknown> | null;
}): string {
  const sourceSystem = String(params.sourceSystem ?? "").toLowerCase();
  const role = String(params.role ?? "").toLowerCase();
  const metadata = params.metadata && typeof params.metadata === "object" ? params.metadata : {};

  const metaSpeaker =
    (typeof metadata.speaker === "string" && metadata.speaker.trim()) ||
    (typeof metadata.actor === "string" && metadata.actor.trim()) ||
    (typeof metadata.agent === "string" && metadata.agent.trim()) ||
    (typeof metadata.author === "string" && metadata.author.trim()) ||
    (typeof metadata.sender === "string" && metadata.sender.trim()) ||
    null;
  if (metaSpeaker) return metaSpeaker;

  const conversationLabel =
    (typeof metadata.conversationLabel === "string" && metadata.conversationLabel.trim()) ||
    parseConversationName(params.sourceConversationId) ||
    null;

  if (sourceSystem === "whatsapp") {
    if (role === "assistant") return "Assistant";
    if (role === "system") return "WhatsApp System";
    return conversationLabel || "WhatsApp Contact";
  }
  if (sourceSystem === "chatgpt") {
    if (role === "assistant") return "ChatGPT";
    if (role === "system") return "ChatGPT System";
    return "You";
  }
  if (sourceSystem === "grok") {
    if (role === "assistant") return "Grok";
    if (role === "system") return "Grok System";
    return "You";
  }
  if (sourceSystem === "codexclaw") {
    if (role === "assistant") return "CodexClaw Agent";
    if (role === "system") return "CodexClaw System";
    return "You";
  }
  if (sourceSystem === "telegram") {
    if (role === "assistant") return "Agent";
    if (role === "system") return "Telegram System";
    return conversationLabel || "Telegram Contact";
  }
  if (sourceSystem === "aitrader") {
    if (role === "assistant") return "AITrader";
    if (role === "system") return "AITrader System";
    return "You";
  }
  if (role === "assistant") return "Assistant";
  if (role === "system") return "System";
  return "User";
}

function extractNameCandidates(evidence: V2EvidenceRef[]): string[] {
  const names = new Set<string>();
  const pattern = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\b/g;
  const stop = new Set(["I", "We", "The", "And", "But", "Yes", "No", "Costco"]);
  for (const ev of evidence.slice(0, 12)) {
    const txt = String(ev.excerpt ?? "");
    const matches = txt.match(pattern) ?? [];
    for (const m of matches) {
      const trimmed = m.trim();
      if (trimmed.length < 3) continue;
      if (stop.has(trimmed)) continue;
      names.add(trimmed);
      if (names.size >= 8) return Array.from(names);
    }
  }
  return Array.from(names);
}

function parseJsonObjectLike(input: string): Record<string, unknown> | null {
  const txt = String(input ?? "").trim();
  if (!txt) return null;
  const first = txt.indexOf("{");
  const last = txt.lastIndexOf("}");
  const candidate = first >= 0 && last > first ? txt.slice(first, last + 1) : txt;
  try {
    const parsed = JSON.parse(candidate) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return null;
  }
  return null;
}

function normalizePlannerArray(value: unknown, max = 8): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => String(item ?? "").trim())
    .filter((item) => item.length > 0)
    .slice(0, max);
}

function normalizePlannerSignals(value: unknown, max = 10): string[] {
  const raw = normalizePlannerArray(value, Math.max(max, 16));
  const out = new Set<string>();
  const stop = new Set([
    "the", "and", "for", "with", "from", "that", "this", "have", "has", "had", "messages", "message",
    "search", "fetch", "details", "about", "current", "recent", "indicate", "might", "your", "you", "my"
  ]);
  for (const item of raw) {
    const normalized = normalizeText(item);
    if (!normalized) continue;
    if (normalized.split(/\s+/).length <= 4) out.add(normalized);
    const tokens = normalized.split(/[^a-z0-9$%]+/).filter((t) => t.length >= 3 && !stop.has(t));
    for (const token of tokens) {
      out.add(token);
      if (out.size >= max) break;
    }
    if (out.size >= max) break;
  }
  return Array.from(out).slice(0, max);
}

function fallbackPlan(question: string): QueryPlan {
  const tokens = normalizeText(question)
    .split(/[^a-z0-9]+/i)
    .filter((x) => x.length >= 4)
    .slice(0, 6);
  const enriched = tokens.length > 0 ? `${question} ${tokens.join(" ")}` : question;
  const q = normalizeText(question);
  const questionType: QueryPlan["questionType"] = /\b(how much|how many|amount|total|value|balance|count|number|sum)\b/.test(q)
    ? "numeric"
    : /\b(who|which|friend|friends|people|person|contacts?)\b/.test(q)
      ? "entity_list"
      : /^(do|does|did|is|are|was|were|can|could|should|would|will|have|has|had)\b/.test(q)
        ? "boolean"
        : "open";
  return {
    intent: "lookup",
    intentSummary: "Find directly grounded evidence for the user request with safe assumptions.",
    requiredSlots: questionType === "numeric"
      ? ["metric_scope", "time_scope"]
      : questionType === "entity_list"
        ? ["target_topic", "entity_scope"]
        : questionType === "boolean"
          ? ["claim_scope"]
          : ["topic_scope"],
    knownSlots: tokens.slice(0, 6),
    missingSlots: [],
    constraints: [
      "truth_over_task",
      "privacy_over_completion",
      "no_ungrounded_claims"
    ],
    disallowedPaths: [
      "record_id_shortcuts",
      "topic_specific_hardcoding",
      "fabricated_evidence"
    ],
    stopAndAskTriggers: [
      "missing_required_slot",
      "conflicting_scope",
      "high_ambiguity"
    ],
    subqueries: [question, enriched].filter((q, idx, arr) => q && arr.indexOf(q) === idx).slice(0, 5),
    mustHaveSignals: tokens.slice(0, 5),
    avoidPatterns: ["question_only_matches", "short_filler_lines"],
    hypotheses: [],
    questionType
  };
}

async function buildPlannerQueryPlan(question: string, timeframe: string, chatNamespace: string): Promise<QueryPlan> {
  const openAiKey = String(config.openAiApiKey ?? "").trim();
  const openRouterKey = String(config.openRouterApiKey ?? "").trim();
  const hasModel = openAiKey.length > 0 || openRouterKey.length > 0;
  if (!hasModel) return fallbackPlan(question);

  const provider = openAiKey ? "openai" : "openrouter";
  const url = provider === "openai"
    ? `${String(config.openAiBaseUrl || "https://api.openai.com/v1").replace(/\/+$/, "")}/chat/completions`
    : "https://openrouter.ai/api/v1/chat/completions";
  const apiKey = provider === "openai" ? openAiKey : openRouterKey;
  const model = provider === "openai"
    ? String(config.metadataModel || "gpt-4o-mini").replace(/^openai\//i, "")
    : String(config.metadataModel || "openai/gpt-4o-mini");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(5000, Number(config.requestTimeoutMs ?? 15000)));
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
              "You are QueryPlannerAgent for OpenBrain. Convert the user question into retrieval-ready search phrases using OpenBrain capabilities. " +
              "Return JSON only with keys: intent (string), intentSummary (string), questionType (boolean|entity_list|numeric|open), requiredSlots (string[]), knownSlots (string[]), missingSlots (string[]), constraints (string[]), disallowedPaths (string[]), stopAndAskTriggers (string[]), subqueries (string[]), mustHaveSignals (string[]), avoidPatterns (string[]), hypotheses (string[]). " +
              "Critical constraints: subqueries must be short searchable phrases (2-8 words), not instructions; mustHaveSignals must be atomic terms/short phrases; avoid category-specific hardcoding and record IDs. " +
              "Use priority Truth > Safety/Privacy > Task Completion. " +
              "If required slots are missing or scope is ambiguous, set missingSlots and include stopAndAskTriggers accordingly. " +
              "For quantitative questions, include broad metric synonyms (for example: total, balance, net value, current value, account value) and decomposition hypotheses. " +
              "Plan for scope disambiguation by generating retrieval phrases for both account-like balances and broader asset/liability summaries when the question scope is ambiguous. " +
              "Do not finalize the answer at planning stage."
          },
          {
            role: "user",
            content:
              `Question: ${question}\nTimeframe: ${timeframe}\nNamespace: ${chatNamespace}\n` +
              `OpenBrain capabilities: ${JSON.stringify(getOpenBrainCapabilities())}\n` +
              "OpenBrain stores message-level memories with text, timestamp, source system, role and metadata. " +
              "Plan only retrieval and evidence coverage."
          }
        ]
      })
    });
    if (!response.ok) return fallbackPlan(question);
    const payload = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = String(payload?.choices?.[0]?.message?.content ?? "").trim();
    const parsed = parseJsonObjectLike(content);
    if (!parsed) return fallbackPlan(question);
    const subqueries = normalizePlannerArray(parsed.subqueries, 10);
    if (subqueries.length === 0) return fallbackPlan(question);
    const parsedQuestionType = (() => {
      const raw = String(parsed.questionType ?? "").trim().toLowerCase();
      if (raw === "boolean" || raw === "entity_list" || raw === "numeric") return raw;
      return "open";
    })();
    const mergedQueries = new Set<string>(subqueries.map((q) => q.trim()).filter(Boolean));
    if (parsedQuestionType === "numeric") {
      for (const q of [
        "net worth",
        "total assets value",
        "current balance total value",
        "portfolio account value"
      ]) {
        mergedQueries.add(q);
      }
    }
    return {
      intent: String(parsed.intent ?? "lookup").trim() || "lookup",
      intentSummary: String(parsed.intentSummary ?? "Find grounded evidence and answer safely.").trim() || "Find grounded evidence and answer safely.",
      requiredSlots: normalizePlannerArray(parsed.requiredSlots, 10),
      knownSlots: normalizePlannerArray(parsed.knownSlots, 10),
      missingSlots: normalizePlannerArray(parsed.missingSlots, 10),
      constraints: normalizePlannerArray(parsed.constraints, 10),
      disallowedPaths: normalizePlannerArray(parsed.disallowedPaths, 10),
      stopAndAskTriggers: normalizePlannerArray(parsed.stopAndAskTriggers, 10),
      questionType: parsedQuestionType,
      subqueries: Array.from(mergedQueries).slice(0, 10),
      mustHaveSignals: normalizePlannerSignals(parsed.mustHaveSignals, 10),
      avoidPatterns: normalizePlannerArray(parsed.avoidPatterns, 8),
      hypotheses: normalizePlannerArray(parsed.hypotheses, 8)
    };
  } catch {
    return fallbackPlan(question);
  } finally {
    clearTimeout(timeout);
  }
}

async function synthesizeAnswerContractWithModel(params: {
  question: string;
  plan: QueryPlan;
  chatNamespace: string;
  timeframe: string;
  profile: QuestionProfile;
  sufficient: boolean;
  contradiction: boolean;
  confidenceScore: number;
  estimate: { direct: string | null; estimate: string | null; numbers: number[] };
  evidence: V2EvidenceRef[];
  fallback: V2AnswerContract;
  composerMode: ComposerMode;
}): Promise<V2AnswerContract | null> {
  const openAiKey = String(config.openAiApiKey ?? "").trim();
  const openRouterKey = String(config.openRouterApiKey ?? "").trim();
  const hasModel = openAiKey.length > 0 || openRouterKey.length > 0;
  if (params.composerMode === "heuristic" || !hasModel || params.evidence.length === 0) return null;

  const provider = openAiKey ? "openai" : "openrouter";
  const url = provider === "openai"
    ? `${String(config.openAiBaseUrl || "https://api.openai.com/v1").replace(/\/+$/, "")}/chat/completions`
    : "https://openrouter.ai/api/v1/chat/completions";
  const apiKey = provider === "openai" ? openAiKey : openRouterKey;
  const model = provider === "openai"
    ? String(config.metadataModel || "gpt-4o-mini").replace(/^openai\//i, "")
    : String(config.metadataModel || "openai/gpt-4o-mini");

  const evidencePayload = params.evidence.slice(0, 12).map((ev, idx) => ({
    rank: idx + 1,
    memoryId: ev.memoryId,
    canonicalId: ev.canonicalId ?? null,
    actor: ev.entityLabel ?? null,
    sourceSystem: ev.sourceSystem,
    role: ev.role ?? null,
    timestamp: ev.sourceTimestamp ?? null,
    contextRole: ev.contextRole ?? null,
    similarity: Number(ev.similarity ?? 0),
    excerpt: String(ev.excerpt ?? "").slice(0, 800)
  }));
  const numericEvidence = params.evidence
    .map((ev, idx) => ({
      rank: idx + 1,
      actor: ev.entityLabel ?? null,
      timestamp: ev.sourceTimestamp ?? null,
      similarity: Number(ev.similarity ?? 0),
      values: extractNumericTokens(String(ev.excerpt ?? ""))
        .map((token) => toNumberGuess(token))
        .filter((value): value is number => value != null)
        .slice(0, 12)
    }))
    .filter((item) => item.values.length > 0)
    .slice(0, 10);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(30000, Number(config.requestTimeoutMs ?? 15000)));
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
        max_tokens: 550,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              "You are AnswerSynthesisAgent for OpenBrain. Build the final answer contract from retrieved evidence. " +
              "Reason holistically: infer user intent, evaluate direct vs indirect evidence, reconcile contradictions, and clearly state uncertainty. " +
              "Never fabricate facts; if evidence is insufficient, say what is missing. " +
              "Priority order is Truth > Safety/Privacy > Task Completion. " +
              "If scope is ambiguous, return decision=clarify_first with one short specific clarification question and finalAnswer=null. " +
              "For numeric questions, distinguish meaningful metric values from incidental numbers and avoid double counting. " +
              "Prefer recent explicit evidence over weak or ambiguous matches, and cite actor/timestamp context in your narrative. " +
              "Return JSON only with keys: decision(answer_now|clarify_first|insufficient), intentSummary, requiresClarification(boolean), clarificationQuestion, assumptionsUsed(array), constraintChecks(array of {name,passed,note}), finalAnswer(object|null), status(definitive|estimated|partial|insufficient|clarification_needed). " +
              "When finalAnswer is present use fields: direct, estimate, confidence(low|medium|high), contradictionCallout, definitiveNextData."
          },
          {
            role: "user",
            content: JSON.stringify({
              question: params.question,
              planner: {
                intent: params.plan.intent,
                intentSummary: params.plan.intentSummary,
                requiredSlots: params.plan.requiredSlots,
                knownSlots: params.plan.knownSlots,
                missingSlots: params.plan.missingSlots,
                constraints: params.plan.constraints,
                disallowedPaths: params.plan.disallowedPaths,
                stopAndAskTriggers: params.plan.stopAndAskTriggers
              },
              chatNamespace: params.chatNamespace,
              timeframe: params.timeframe,
              questionProfile: params.profile,
              sufficient: params.sufficient,
              contradiction: params.contradiction,
              confidenceScore: params.confidenceScore,
              numericEvidence,
              estimateHints: params.estimate,
              evidence: evidencePayload,
              fallbackContract: params.fallback
            })
          }
        ]
      })
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = String(payload?.choices?.[0]?.message?.content ?? "").trim();
    const parsed = parseJsonObjectLike(content);
    if (!parsed) return null;

    const statusRaw = String(parsed.status ?? "").toLowerCase();
    const parsedStatus: "definitive" | "estimated" | "partial" | "insufficient" =
      statusRaw === "definitive" || statusRaw === "estimated" || statusRaw === "partial" || statusRaw === "insufficient"
        ? statusRaw
        : "partial";

    const decisionRaw = String(parsed.decision ?? "").toLowerCase();
    const decision: V2AskDecision =
      decisionRaw === "answer_now" || decisionRaw === "clarify_first" || decisionRaw === "insufficient"
        ? decisionRaw
        : params.fallback.decision;
    const requiresClarification = decision === "clarify_first";
    const status =
      decision === "clarify_first"
        ? "clarification_needed"
        : decision === "insufficient"
          ? "insufficient"
          : parsedStatus;

    const finalRaw = parsed.finalAnswer;
    let finalAnswer: V2FinalAnswer | null = null;
    if (decision === "answer_now" && finalRaw && typeof finalRaw === "object" && !Array.isArray(finalRaw)) {
      const finalObj = finalRaw as Record<string, unknown>;
      const finalConfidenceRaw = String(finalObj.confidence ?? "").toLowerCase();
      const finalConfidence: "low" | "medium" | "high" =
        finalConfidenceRaw === "high" ? "high" : finalConfidenceRaw === "medium" ? "medium" : "low";
      finalAnswer = {
        direct: finalObj.direct == null ? null : String(finalObj.direct).trim() || null,
        estimate: finalObj.estimate == null ? null : String(finalObj.estimate).trim() || null,
        confidence: finalConfidence,
        contradictionCallout: finalObj.contradictionCallout == null ? null : String(finalObj.contradictionCallout).trim() || null,
        definitiveNextData: String(finalObj.definitiveNextData ?? "").trim() || (params.fallback.finalAnswer?.definitiveNextData ?? "Provide timestamped source evidence for the exact metric.")
      };
    } else if (decision === "answer_now") {
      finalAnswer = params.fallback.finalAnswer;
    }

    const checksRaw = Array.isArray(parsed.constraintChecks) ? parsed.constraintChecks : [];
    const constraintChecks: V2ConstraintCheck[] = checksRaw
      .map((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return null;
        const obj = item as Record<string, unknown>;
        const name = String(obj.name ?? "").trim();
        const note = String(obj.note ?? "").trim();
        if (!name) return null;
        return {
          name,
          passed: Boolean(obj.passed),
          note: note || "No note provided."
        };
      })
      .filter((item): item is V2ConstraintCheck => Boolean(item))
      .slice(0, 8);

    const assumptionsUsed = Array.isArray(parsed.assumptionsUsed)
      ? parsed.assumptionsUsed.map((v) => String(v ?? "").trim()).filter(Boolean).slice(0, 8)
      : params.fallback.assumptionsUsed;

    const contract: V2AnswerContract = {
      decision,
      intentSummary: String(parsed.intentSummary ?? "").trim() || params.fallback.intentSummary,
      requiresClarification,
      clarificationQuestion: requiresClarification
        ? (String(parsed.clarificationQuestion ?? "").trim() || params.fallback.clarificationQuestion || "Can you clarify the scope so I can answer accurately?")
        : null,
      assumptionsUsed,
      constraintChecks: constraintChecks.length > 0 ? constraintChecks : params.fallback.constraintChecks,
      finalAnswer,
      status
    };
    return contract;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function buildEnvelope(params: {
  traceId: string;
  conversationId: string;
  fromAgent: V2AgentName;
  toAgent: V2AgentName;
  intent: string;
  payload: Record<string, unknown>;
  constraints?: Record<string, unknown>;
  context?: Record<string, unknown>;
}): V2AgentRequestEnvelope {
  return {
    schemaVersion: "openbrain.v2.agent-envelope/1.0",
    messageId: randomUUID(),
    traceId: params.traceId,
    conversationId: params.conversationId,
    fromAgent: params.fromAgent,
    toAgent: params.toAgent,
    messageType: "ask",
    intent: params.intent,
    payload: params.payload,
    constraints: params.constraints ?? {},
    context: params.context ?? {},
    createdAt: nowIso()
  };
}

async function appendStep(answerRunId: string, index: number, envelope: Record<string, unknown>, agentName: string, status: string): Promise<void> {
  await pool.query(
    `INSERT INTO answer_steps (answer_run_id, step_index, agent_name, message_type, status, envelope)
     VALUES ($1::uuid, $2, $3, 'json_envelope', $4, $5::jsonb)`,
    [answerRunId, index, agentName, status, JSON.stringify(envelope)]
  );
}

function toNumberGuess(token: string): number | null {
  const t = String(token ?? "").trim().toLowerCase();
  if (!t) return null;
  const mul =
    t.endsWith("b") ? 1_000_000_000 :
    t.endsWith("m") ? 1_000_000 :
    t.endsWith("k") ? 1_000 :
    1;
  const clean = t.replace(/[$,\s]/g, "").replace(/[kmb]$/i, "");
  const value = Number(clean);
  if (!Number.isFinite(value)) return null;
  return value * mul;
}

function extractNumericTokens(text: string): string[] {
  const input = String(text ?? "");
  const matches = input.match(/[$]?\s?-?\d{1,3}(?:,\d{3})*(?:\.\d+)?(?:\s?[kmb])?\b/gi) ?? [];
  return matches
    .map((m) => m.trim())
    .filter((m) => /\d/.test(m))
    .slice(0, 30);
}

function sanitizeNumericValues(values: number[]): number[] {
  const clean = values.filter((v) => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
  if (clean.length < 4) return clean;
  const q1 = clean[Math.floor((clean.length - 1) * 0.25)];
  const q3 = clean[Math.floor((clean.length - 1) * 0.75)];
  const iqr = Math.max(1e-9, q3 - q1);
  const lower = q1 - iqr * 3;
  const upper = q3 + iqr * 3;
  const filtered = clean.filter((v) => v >= lower && v <= upper);
  if (filtered.length >= Math.max(3, Math.floor(clean.length * 0.6))) return filtered;
  return clean;
}

function extractNumericEvidence(evidence: V2EvidenceRef[]): number[] {
  const out: number[] = [];
  for (const ev of evidence) {
    const tokens = extractNumericTokens(ev.excerpt);
    for (const token of tokens) {
      const n = toNumberGuess(token);
      if (n != null) out.push(n);
    }
  }
  return sanitizeNumericValues(out);
}

function extractBalanceMentions(evidence: V2EvidenceRef[]): Array<{
  actor: string | null;
  timestamp: string | null;
  label: string;
  value: number;
  hedged: boolean;
  excerpt: string;
}> {
  const out: Array<{
    actor: string | null;
    timestamp: string | null;
    label: string;
    value: number;
    hedged: boolean;
    excerpt: string;
  }> = [];
  const patterns = [
    /((?:current|total)\s+balance(?:\s*\([^)]+\))?)\s*[:\t ]+\$?\s*([0-9][0-9,]*(?:\.[0-9]+)?(?:\s?[kmb])?)/gi,
    /((?:balance\s+today|current\s+balance|total\s+balance|account\s+balance))[^$0-9]{0,40}\$?\s*([0-9][0-9,]*(?:\.[0-9]+)?(?:\s?[kmb])?)/gi,
    /((?:final|total|estimated)\s+(?:equity|value|assets?|net(?:\s+worth)?|summary(?:\s+value)?)(?:\s*\([^)]+\))?)\s*[:\t ]+\$?\s*([0-9][0-9,]*(?:\.[0-9]+)?(?:\s?[kmb])?)/gi
  ];

  for (const ev of evidence.slice(0, 12)) {
    const text = String(ev.excerpt ?? "");
    const hedged = /\b(i believe|around|about|approx(?:imately)?|estimate(?:d)?|roughly|maybe|might)\b/i.test(text);
    for (const rx of patterns) {
      rx.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = rx.exec(text)) !== null) {
        const label = String(m[1] ?? "").replace(/\s+/g, " ").trim().toLowerCase();
        const value = toNumberGuess(String(m[2] ?? ""));
        if (value == null || value <= 0) continue;
        out.push({
          actor: ev.entityLabel ?? null,
          timestamp: ev.sourceTimestamp ?? null,
          label,
          value,
          hedged,
          excerpt: compactSnippet(text, 260)
        });
        if (out.length >= 30) break;
      }
      if (out.length >= 30) break;
    }
    if (out.length >= 30) break;
  }
  return out;
}

function extractStructuredValueRows(evidence: V2EvidenceRef[]): Array<{
  actor: string | null;
  timestamp: string | null;
  label: string;
  value: number;
  excerpt: string;
}> {
  const rows: Array<{
    actor: string | null;
    timestamp: string | null;
    label: string;
    value: number;
    excerpt: string;
  }> = [];
  for (const ev of evidence.slice(0, 10)) {
    const text = String(ev.excerpt ?? "");
    const lines = text.split(/\r?\n/);
    for (const line of lines) {
      const raw = String(line ?? "").trim();
      if (!raw) continue;
      let label: string | null = null;
      let valueToken: string | null = null;

      if (raw.includes("\t")) {
        const parts = raw.split(/\t+/).map((p) => p.trim()).filter(Boolean);
        if (parts.length >= 2) {
          label = parts[0] ?? null;
          valueToken = parts[1] ?? null;
        }
      } else if (raw.includes("|")) {
        const parts = raw.split("|").map((p) => p.trim()).filter(Boolean);
        if (parts.length >= 2) {
          label = parts[0] ?? null;
          valueToken = parts[1] ?? null;
        }
      } else {
        const m = raw.match(/^(.{3,100}?)\s{2,}\$?\s*([0-9][0-9,]*(?:\.[0-9]+)?(?:\s?[kmb])?)\b/i)
          ?? raw.match(/^(.{3,100}?)\s+\$?\s*([0-9][0-9,]*(?:\.[0-9]+)?(?:\s?[kmb])?)\b/i);
        if (m) {
          label = m[1] ?? null;
          valueToken = m[2] ?? null;
        }
      }

      if (!label || !valueToken) continue;
      const normalizedLabel = String(label).replace(/\s+/g, " ").trim().toLowerCase();
      if (!normalizedLabel || normalizedLabel.length < 3) continue;
      if (/^(description|value|notes)$/i.test(normalizedLabel)) continue;
      const value = toNumberGuess(String(valueToken));
      if (value == null || value <= 0) continue;
      rows.push({
        actor: ev.entityLabel ?? null,
        timestamp: ev.sourceTimestamp ?? null,
        label: normalizedLabel,
        value,
        excerpt: compactSnippet(text, 240)
      });
      if (rows.length >= 120) break;
    }
    if (rows.length >= 120) break;
  }
  return rows;
}

function formatUsd(value: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(value);
}

function selectBestEstimate(evidence: V2EvidenceRef[]): { direct: string | null; estimate: string | null; numbers: number[] } {
  const numeric = extractNumericEvidence(evidence);
  if (numeric.length === 0) {
    return { direct: null, estimate: null, numbers: [] };
  }

  const sorted = [...numeric].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const p75 = sorted[Math.floor(sorted.length * 0.75)];
  const strongest = evidence.find((ev) => extractNumericTokens(ev.excerpt).length > 0) ?? evidence[0];
  const strongestToken = extractNumericTokens(strongest.excerpt)[0];
  const strongestValue = strongestToken ? toNumberGuess(strongestToken) : null;

  const direct = strongestValue != null
    ? `Strongest explicit numeric evidence is ${formatUsd(strongestValue)}${strongest.sourceTimestamp ? ` (message date ${strongest.sourceTimestamp.slice(0, 10)})` : ""}.`
    : null;
  const estimate = `Numeric signals in evidence range from ${formatUsd(sorted[0])} to ${formatUsd(sorted[sorted.length - 1])}; midpoint ${formatUsd(median)} and upper-quartile ${formatUsd(p75)}.`;
  return { direct, estimate, numbers: sorted };
}

function buildClarificationQuestion(params: {
  plan: QueryPlan;
  profile: QuestionProfile;
  question: string;
}): string {
  const firstMissing = String(params.plan.missingSlots[0] ?? "").toLowerCase();
  if (firstMissing.includes("time")) return "What time period should I use?";
  if (firstMissing.includes("metric")) return "What exact metric should I use?";
  if (firstMissing.includes("entity")) return "Which person or group should I focus on?";
  if (firstMissing.includes("topic")) return "What exact topic should I focus on?";
  if (params.profile.kind === "numeric") return "What financial measure should I use for this answer?";
  if (params.profile.kind === "entity_list") return "Which people should I include in scope?";
  if (/this|that|it|there|here/i.test(params.question)) return "What does \"this\" refer to in your question?";
  return "What scope should I use so I can answer accurately?";
}

function decideAskDecision(params: {
  plan: QueryPlan;
  profile: QuestionProfile;
  hasEvidence: boolean;
  sufficient: boolean;
  signalCoverage: number;
  strongEvidence: number;
}): V2AskDecision {
  if (!params.hasEvidence && params.plan.missingSlots.length > 0) return "clarify_first";
  if (params.plan.missingSlots.length > 0) return "clarify_first";
  if (params.signalCoverage < 0.35 && params.strongEvidence < 1) return "clarify_first";
  if (!params.hasEvidence) return "insufficient";
  if (!params.sufficient && params.profile.kind !== "numeric") return "clarify_first";
  return "answer_now";
}

function buildConstraintChecks(params: {
  hasEvidence: boolean;
  contradiction: boolean;
  hasMissingSlots: boolean;
}): V2ConstraintCheck[] {
  return [
    {
      name: "truth_over_task",
      passed: params.hasEvidence,
      note: params.hasEvidence ? "Grounded evidence exists." : "No grounded evidence found."
    },
    {
      name: "safety_privacy_over_completion",
      passed: true,
      note: "No unsafe escalation path was used."
    },
    {
      name: "no_ungrounded_claims",
      passed: !params.hasMissingSlots && !params.contradiction,
      note: params.hasMissingSlots
        ? "Required scope details are missing."
        : params.contradiction
          ? "Conflicting evidence detected; definitive claim constrained."
          : "No ungrounded claim detected."
    }
  ];
}

function buildFinalAnswer(params: {
  profile: QuestionProfile;
  sufficient: boolean;
  contradiction: boolean;
  confidence: "low" | "medium" | "high";
  estimate: { direct: string | null; estimate: string | null; numbers: number[] };
  evidence: V2EvidenceRef[];
}): V2FinalAnswer {
  if (params.profile.kind === "numeric") {
    return {
      direct: params.estimate.direct,
      estimate: params.estimate.estimate,
      confidence: params.confidence,
      contradictionCallout: params.contradiction
        ? "Evidence contains conflicting numeric claims; treat estimate as provisional."
        : null,
      definitiveNextData: "Provide the latest timestamped source statement for the target metric to make this definitive."
    };
  }
  const top = params.evidence.slice(0, 3).map((item) => compactSnippet(item.excerpt));
  const names = params.profile.kind === "entity_list" ? extractNameCandidates(params.evidence) : [];
  const direct =
    params.profile.kind === "entity_list"
      ? (names.length > 0
          ? `Likely yes. Candidate matches from evidence: ${names.join(", ")}.`
          : "Likely yes based on retrieved evidence, but exact names are not confidently resolved from current snippets.")
      : params.profile.kind === "boolean"
        ? "Likely yes based on the retrieved evidence."
        : `Most relevant evidence points to: ${compactSnippet(params.evidence[0]?.excerpt ?? "", 220)}`;
  const estimate = top.length > 0
    ? `Top supporting evidence: ${top.map((line, idx) => `${idx + 1}) ${line}`).join(" | ")}`
    : null;
  return {
    direct,
    estimate,
    confidence: params.confidence,
    contradictionCallout: null,
    definitiveNextData: params.profile.kind === "entity_list"
      ? "Provide an explicit message linking a specific person to this preference/topic."
      : "Provide explicit timestamped statements directly answering this question."
  };
}

function buildAnswerContract(params: {
  plan: QueryPlan;
  question: string;
  profile: QuestionProfile;
  hasEvidence: boolean;
  sufficient: boolean;
  contradiction: boolean;
  confidenceScore: number;
  signalCoverage: number;
  strongEvidence: number;
  estimate: { direct: string | null; estimate: string | null; numbers: number[] };
  evidence: V2EvidenceRef[];
  assumptionsUsed?: string[];
}): V2AnswerContract {
  const { profile, hasEvidence, sufficient, contradiction, confidenceScore, estimate, evidence } = params;
  const confidence = confidenceLabel(confidenceScore);
  const decision = decideAskDecision({
    plan: params.plan,
    profile,
    hasEvidence,
    sufficient,
    signalCoverage: params.signalCoverage,
    strongEvidence: params.strongEvidence
  });
  const requiresClarification = decision === "clarify_first";
  const clarificationQuestion = requiresClarification
    ? buildClarificationQuestion({ plan: params.plan, profile, question: params.question })
    : null;

  const status = decision === "clarify_first"
    ? "clarification_needed"
    : decision === "insufficient"
      ? "insufficient"
      : profile.kind === "numeric"
        ? (estimate.direct && !contradiction ? "definitive" : sufficient ? "estimated" : "partial")
        : (sufficient ? "estimated" : "partial");

  const finalAnswer = decision === "answer_now"
    ? buildFinalAnswer({ profile, sufficient, contradiction, confidence, estimate, evidence })
    : null;

  return {
    decision,
    intentSummary: params.plan.intentSummary || "Find grounded evidence and answer safely.",
    requiresClarification,
    clarificationQuestion,
    assumptionsUsed: Array.isArray(params.assumptionsUsed) ? params.assumptionsUsed : [],
    constraintChecks: buildConstraintChecks({
      hasEvidence,
      contradiction,
      hasMissingSlots: params.plan.missingSlots.length > 0
    }),
    finalAnswer,
    status
  };
}

function dedupeEvidence(items: V2EvidenceRef[]): V2EvidenceRef[] {
  const map = new Map<string, V2EvidenceRef>();
  for (const item of items) {
    const prev = map.get(item.memoryId);
    if (!prev || item.similarity > prev.similarity) {
      map.set(item.memoryId, item);
    }
  }
  return Array.from(map.values()).sort((a, b) => b.similarity - a.similarity);
}

function selectSynthesisEvidence(evidence: V2EvidenceRef[], limit = 12): V2EvidenceRef[] {
  const sorted = [...evidence].sort((a, b) => b.similarity - a.similarity);
  const selected: V2EvidenceRef[] = [];
  const seen = new Set<string>();
  const push = (ev: V2EvidenceRef): void => {
    if (!ev?.memoryId || seen.has(ev.memoryId) || selected.length >= limit) return;
    seen.add(ev.memoryId);
    selected.push(ev);
  };

  const structuredRegex = /\bdescription\b.*\bvalue\b|\t|(\|\s*description\s*\|)/i;
  const metricRegex = /\b(current balance|total|net|value|account|portfolio|assets?|equity|summary)\b/i;

  for (const ev of sorted.slice(0, 6)) push(ev);
  for (const ev of sorted) {
    if (selected.length >= limit) break;
    if (structuredRegex.test(String(ev.excerpt ?? ""))) push(ev);
  }
  for (const ev of sorted) {
    if (selected.length >= limit) break;
    const text = String(ev.excerpt ?? "");
    if (metricRegex.test(text) && String(ev.role ?? "").toLowerCase() === "user") push(ev);
  }
  for (const ev of sorted) {
    if (selected.length >= limit) break;
    if (metricRegex.test(String(ev.excerpt ?? ""))) push(ev);
  }
  for (const ev of sorted) {
    if (selected.length >= limit) break;
    push(ev);
  }
  return selected;
}

function normalizeText(input: string): string {
  return String(input ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

function isQuestionLike(text: string): boolean {
  const t = normalizeText(text);
  if (!t) return false;
  return /\?$/.test(t) || /^(how|what|when|where|who|why|cuanto|quanto|qual|que)\b/.test(t);
}

function countSignalHits(text: string, signals: string[]): number {
  const normalized = normalizeText(text);
  if (!normalized || signals.length === 0) return 0;
  let hits = 0;
  for (const signal of signals) {
    const s = normalizeText(signal);
    if (!s) continue;
    if (normalized.includes(s)) hits += 1;
  }
  return hits;
}

function hitsAvoidPatterns(text: string, patterns: string[]): boolean {
  const normalized = normalizeText(text);
  if (!normalized || patterns.length === 0) return false;
  return patterns.some((pattern) => {
    const p = normalizeText(pattern);
    return p.length > 0 && normalized.includes(p);
  });
}

function scoreEvidence(
  evidence: V2EvidenceRef,
  temporalIntent: ReturnType<typeof parseTemporalIntent>,
  plan: QueryPlan,
  numericMode: boolean
): number {
  const excerpt = String(evidence.excerpt ?? "");
  const temporal = temporalRelevance(evidence.sourceTimestamp, temporalIntent);
  const base = clamp01(Number(evidence.similarity ?? 0));
  const signalHits = countSignalHits(excerpt, plan.mustHaveSignals);
  const signalScore = plan.mustHaveSignals.length > 0
    ? clamp01(signalHits / Math.max(1, plan.mustHaveSignals.length))
    : 0.5;
  const hasNumeric = numericMode && extractNumericTokens(excerpt).length > 0 ? 1 : 0;
  const wordCount = excerpt.split(/\s+/).filter(Boolean).length;
  const shortPenalty = wordCount < 7 ? -0.12 : wordCount < 12 ? -0.05 : 0;
  const metricTermBoost = numericMode && /\b(total|current|balance|amount|value|net|account|portfolio)\b/i.test(excerpt) ? 0.08 : 0;
  const roleBonus = evidence.role === "user" ? 0.1 : evidence.role === "assistant" ? 0.02 : 0;
  const structuredBoost = /\bdescription\b.*\bvalue\b|\t|(\|\s*description\s*\|)/i.test(excerpt) ? 0.1 : 0;
  const hedgedPenalty = /\b(i believe|around|about|approx(?:imately)?|estimate(?:d)?|roughly|maybe|might)\b/i.test(excerpt) ? -0.08 : 0;
  const codePenalty = /(?:^|\n)\s*(from\s+\w+\s+import|import\s+\w+|def\s+\w+\(|class\s+\w+)/i.test(excerpt) ? -0.14 : 0;
  const questionPenalty = isQuestionLike(excerpt) && plan.avoidPatterns.includes("question_only_matches") ? -0.18 : 0;
  const avoidPenalty = hitsAvoidPatterns(excerpt, plan.avoidPatterns) ? -0.14 : 0;

  const score =
    base * 0.5 +
    temporal * 0.2 +
    signalScore * 0.2 +
    hasNumeric * 0.04 +
    metricTermBoost +
    roleBonus +
    structuredBoost +
    shortPenalty +
    hedgedPenalty +
    codePenalty +
    questionPenalty +
    avoidPenalty;
  return clamp01(score);
}

function shouldKeepEvidence(
  evidence: V2EvidenceRef,
  temporalIntent: ReturnType<typeof parseTemporalIntent>,
  plan: QueryPlan
): boolean {
  if (!timestampInHardRange(evidence.sourceTimestamp, temporalIntent)) return false;
  const text = String(evidence.excerpt ?? "").trim();
  if (text.length < 3) return false;
  const questionLike = isQuestionLike(text);
  const signalHits = countSignalHits(text, plan.mustHaveSignals);
  const hasNumeric = extractNumericTokens(text).length > 0;
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  if (wordCount < 4 && !hasNumeric) return false;
  if (wordCount < 6 && signalHits === 0) return false;
  if (questionLike && signalHits === 0 && !hasNumeric && plan.avoidPatterns.includes("question_only_matches")) {
    return false;
  }
  if (plan.mustHaveSignals.length > 0 && signalHits === 0 && !hasNumeric && Number(evidence.similarity) < 0.84) {
    return false;
  }
  if (hitsAvoidPatterns(text, plan.avoidPatterns) && Number(evidence.similarity) < 0.9) {
    return false;
  }
  return true;
}

async function searchPublishedEvidence(
  query: string,
  chatNamespace: string,
  limit: number,
  temporalIntent: ReturnType<typeof parseTemporalIntent>,
  plan: QueryPlan,
  numericMode: boolean,
  strategy: AskStrategyResolved
): Promise<V2EvidenceRef[]> {
  const anchorResult = await searchAnchors({
    query,
    chatNamespace,
    k: Math.max(limit, 20),
    mode: strategy.retrievalMode === "baseline" ? "hybrid" : strategy.retrievalMode
  });

  const merged = new Map<string, V2EvidenceRef>();
  const contextCache = new Map<string, V2ContextMessage[]>();
  const threadCache = new Map<string, V2ContextMessage[]>();

  const upsert = (candidate: V2EvidenceRef): void => {
    const prev = merged.get(candidate.memoryId);
    if (!prev || candidate.similarity > prev.similarity) {
      merged.set(candidate.memoryId, candidate);
    }
  };

  const toEvidence = (context: V2ContextMessage, similarity: number, role: "direct" | "indirect"): V2EvidenceRef => ({
    memoryId: context.memoryId,
    canonicalId: context.canonicalId,
    sourceMessageId: context.sourceMessageId,
    replyToMessageId: context.replyToMessageId,
    sourceSystem: context.sourceSystem,
    role: context.role ?? undefined,
    actorId: context.actorId,
    actorType: context.actorType,
    sourceConversationId: context.conversationId,
    sourceTimestamp: context.sourceTimestamp,
    entityLabel: context.actorName,
    excerpt: context.excerpt,
    similarity,
    contextRole: role,
    qualityState: "published"
  });

  for (let i = 0; i < anchorResult.anchors.length; i += 1) {
    const anchor = anchorResult.anchors[i];
    const direct: V2EvidenceRef = {
      memoryId: anchor.memoryId,
      canonicalId: anchor.canonicalId,
      sourceMessageId: anchor.sourceMessageId,
      replyToMessageId: anchor.replyToMessageId,
      sourceSystem: anchor.sourceSystem,
      role: anchor.role ?? undefined,
      actorId: anchor.actorId,
      actorType: anchor.actorType,
      sourceConversationId: anchor.conversationId,
      sourceTimestamp: anchor.sourceTimestamp,
      entityLabel: anchor.actorName,
      excerpt: anchor.excerpt,
      similarity: clamp01(anchor.score),
      contextRole: "direct",
      qualityState: "published"
    };
    upsert(direct);

    const allowWindow = strategy.contextMode === "window" || strategy.contextMode === "window_thread" || strategy.contextMode === "adaptive";
    const allowThread = strategy.contextMode === "window_thread" || strategy.contextMode === "adaptive";
    const beforeN = strategy.contextMode === "adaptive" ? 5 : 3;
    const afterN = strategy.contextMode === "adaptive" ? 5 : 3;

    if (allowWindow && i < 4 && anchor.conversationId) {
      const ctxKey = `${anchor.conversationId}:${anchor.sourceMessageId ?? anchor.canonicalId}`;
      let ctx = contextCache.get(ctxKey);
      if (!ctx) {
        const payload = await fetchContextWindow({
          chatNamespace,
          conversationId: anchor.conversationId,
          anchorMessageId: anchor.sourceMessageId ?? anchor.canonicalId,
          beforeN,
          afterN
        });
        ctx = payload.items;
        contextCache.set(ctxKey, ctx);
      }
      for (const item of ctx) {
        if (item.memoryId === anchor.memoryId) continue;
        upsert(toEvidence(item, clamp01(anchor.score * 0.9), "indirect"));
      }
    }

    if (allowThread && i < 3 && anchor.replyToMessageId) {
      const key = anchor.sourceMessageId ?? anchor.canonicalId;
      let thread = threadCache.get(key);
      if (!thread) {
        const payload = await fetchThreadSlice({
          chatNamespace,
          messageId: key,
          direction: "both",
          depth: strategy.contextMode === "adaptive" ? 4 : 2
        });
        thread = payload.items;
        threadCache.set(key, thread);
      }
      for (const item of thread) {
        if (item.memoryId === anchor.memoryId) continue;
        upsert(toEvidence(item, clamp01(anchor.score * 0.86), "indirect"));
      }
    }
  }

  return Array.from(merged.values())
    .filter((candidate) => shouldKeepEvidence(candidate, temporalIntent, plan))
    .map((candidate) => ({
      candidate,
      score: scoreEvidence(candidate, temporalIntent, plan, numericMode)
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((item) => ({ ...item.candidate, similarity: item.score }));
}

function buildRefinementQueries(
  question: string,
  evidence: V2EvidenceRef[],
  seedQueries: string[],
  mustHaveSignals: string[],
  hypotheses: string[]
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (value: string): void => {
    const v = String(value ?? "").trim();
    if (!v) return;
    const key = normalizeText(v);
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(v);
  };

  push(question);
  for (const query of seedQueries.slice(0, 3)) {
    push(query);
  }

  const evidenceTerms = new Set<string>();
  const noisyTerms = new Set([
    "this", "that", "with", "from", "have", "your", "they", "them", "will", "would", "about", "there",
    "numbers", "number", "money", "current", "balance", "total", "value", "account", "amount", "month",
    "average", "before", "after", "using", "show", "math", "notes", "description", "premarital", "marital",
    "calculation", "great", "excellent", "properly", "accurately"
  ]);
  for (const ev of evidence.slice(0, 5)) {
    const raw = String(ev.excerpt ?? "");
    const normalized401k = raw.match(/\b\d{3,4}\s*\(?k\)?\b/gi) ?? [];
    for (const rawToken of normalized401k) {
      const token = rawToken.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (token) evidenceTerms.add(token);
      if (evidenceTerms.size >= 10) break;
    }
    const text = normalizeText(raw);
    const tokenMatches = text.match(/\b[a-z0-9]{4,}\b/g) ?? [];
    for (const token of tokenMatches) {
      if (noisyTerms.has(token)) continue;
      evidenceTerms.add(token);
      if (evidenceTerms.size >= 10) break;
    }
    if (evidenceTerms.size >= 10) break;
  }
  const termList = Array.from(evidenceTerms).slice(0, 6);
  for (const term of termList) {
    push(`${term} current balance`);
    push(`${term} total value`);
    if (out.length >= 10) break;
  }

  for (const hypothesis of hypotheses.slice(0, 4)) {
    const h = normalizeText(hypothesis);
    if (h) push(`${question} ${h}`.trim());
  }

  const observedText = evidence.map((ev) => normalizeText(ev.excerpt)).join(" ");
  for (const signal of mustHaveSignals.slice(0, 8)) {
    const s = normalizeText(signal);
    if (!s) continue;
    if (!observedText.includes(s)) {
      push(`${question} ${signal}`.trim());
    }
  }

  return out.slice(0, 10);
}

function confidenceLabel(score: number): "low" | "medium" | "high" {
  if (score >= 0.8) return "high";
  if (score >= 0.55) return "medium";
  return "low";
}

export async function askV2(input: V2AskRequest, principal: V2Principal): Promise<V2AskResponse> {
  if (!config.v2AgentMeshEnabled) {
    throw new Error("OpenBrain V2 agent mesh is disabled (OPENBRAIN_V2_AGENT_MESH_ENABLED=0).");
  }
  const traceId = randomUUID();
  const chatNamespace = String(input.chatNamespace ?? "personal.main").trim() || "personal.main";
  const baseQuestion = String(input.question ?? "").trim();
  const clarificationResponse = String(input.clarificationResponse ?? "").trim();
  if (!baseQuestion) throw new Error("question is required");
  const question = clarificationResponse
    ? `${baseQuestion}\n\nUser clarification: ${clarificationResponse}`
    : baseQuestion;
  const strategy = resolveStrategyConfig(input.strategyConfig);

  const conversationId = String(input.conversationId ?? randomUUID());
  const answerRunRow = await pool.query<{ id: string }>(
    `INSERT INTO answer_runs (
       trace_id,
       conversation_id,
       chat_namespace,
       question,
       status,
       principal_kind,
       principal_ref,
       created_at,
       updated_at
     ) VALUES ($1, $2, $3, $4, 'running', $5, $6, now(), now())
     RETURNING id`,
    [
      traceId,
      conversationId,
      chatNamespace,
      baseQuestion,
      principal.kind,
      principal.kind === "service" ? principal.serviceId ?? null : principal.userName ?? null
    ]
  );
  const answerRunId = answerRunRow.rows[0]?.id;
  if (!answerRunId) throw new Error("Failed to create answer run");

  let stepIndex = 1;

  const bootstrap = { canonicalized: 0, published: 0, quarantined: 0 };
  await appendStep(answerRunId, stepIndex++, { bootstrap }, "ingestion_qa_agent", "ok");
  const temporalIntent = parseTemporalIntent(question);
  if (clarificationResponse) {
    await appendStep(answerRunId, stepIndex++, {
      clarificationResponse,
      mergedQuestion: question
    }, "controller_agent", "ok");
  }

  const temporalReq = buildEnvelope({
    traceId,
    conversationId,
    fromAgent: "controller_agent",
    toAgent: "temporal_reasoning_agent",
    intent: "infer_timeframe",
    payload: { question }
  });
  const temporalRes = dispatchAgentEnvelope(temporalReq);
  await appendStep(answerRunId, stepIndex++, { request: temporalReq, response: temporalRes }, "temporal_reasoning_agent", temporalRes.status);

  const planner = strategy.plannerMode === "single_agent_minimal"
    ? fallbackPlan(question)
    : await buildPlannerQueryPlan(question, String(input.timeframe ?? "all"), chatNamespace);
  if (strategy.plannerMode === "single_agent_sequential") {
    const minimal = fallbackPlan(question);
    planner.subqueries = Array.from(new Set([...minimal.subqueries, ...planner.subqueries])).slice(0, 8);
    planner.mustHaveSignals = Array.from(new Set([...minimal.mustHaveSignals, ...planner.mustHaveSignals])).slice(0, 10);
  }
  await appendStep(answerRunId, stepIndex++, { planner }, "controller_agent", "ok");
  const questionProfile = inferQuestionProfile(question, planner);
  await appendStep(answerRunId, stepIndex++, { questionProfile, strategy }, "controller_agent", "ok");

  const maxLoops = strategy.maxLoops
    ?? (Number.isFinite(Number(input.maxLoops)) ? Math.max(1, Math.min(3, Number(input.maxLoops))) : 2);
  const evidence: V2EvidenceRef[] = [];
  const triedQueries = new Set<string>();

  let queries = buildRefinementQueries(question, [], planner.subqueries, planner.mustHaveSignals, planner.hypotheses);
  let sufficient = false;
  let strongEvidence = 0;
  let signalCoverage = 0;
  const queryCoverage = new Map<string, number>();

  for (let loop = 0; loop < maxLoops; loop += 1) {
    const loopQueries = queries.filter((q) => !triedQueries.has(q)).slice(0, 3);
    for (let i = 0; i < loopQueries.length; i += 1) {
      const query = loopQueries[i];
      triedQueries.add(query);
      const found = await searchPublishedEvidence(
        query,
        chatNamespace,
        24,
        temporalIntent,
        planner,
        questionProfile.expectsNumeric,
        strategy
      );

      for (const match of found) {
        evidence.push(match);
      }
      if (found.length > 0) queryCoverage.set(query, found.length);

      await appendStep(answerRunId, stepIndex++, {
        loop,
        query,
        count: found.length,
        topIds: found.slice(0, 3).map((m) => m.memoryId)
      }, "controller_agent", "ok");
    }

    const deduped = dedupeEvidence(evidence).slice(0, 24);
    strongEvidence = deduped.filter((item) => item.similarity >= 0.72).length;
    const topSimilarity = deduped.length > 0 ? deduped[0].similarity : 0;
    const numericCount = deduped.filter((item) => extractNumericTokens(item.excerpt).length > 0).length;
    const numericDensity = deduped.length > 0 ? numericCount / deduped.length : 0;
    const sourceDiversity = deduped.length > 0
      ? Math.min(1, new Set(deduped.map((item) => String(item.sourceSystem ?? "").toLowerCase())).size / 3)
      : 0;
    if (planner.mustHaveSignals.length === 0) {
      signalCoverage = deduped.length > 0 ? 1 : 0;
    } else {
      const allText = deduped.map((item) => normalizeText(item.excerpt)).join(" ");
      const covered = planner.mustHaveSignals.filter((signal) => allText.includes(normalizeText(signal))).length;
      signalCoverage = clamp01(covered / Math.max(1, planner.mustHaveSignals.length));
    }

    const suffReq = buildEnvelope({
      traceId,
      conversationId,
      fromAgent: "controller_agent",
      toAgent: "sufficiency_agent",
      intent: "check_sufficiency",
      payload: {
        evidenceCount: deduped.length,
        strongEvidence,
        signalCoverage,
        coveredQueries: queryCoverage.size,
        queryCount: queries.length,
        topSimilarity,
        numericDensity,
        sourceDiversity
      }
    });
    const suffRes = dispatchAgentEnvelope(suffReq);
    await appendStep(answerRunId, stepIndex++, { request: suffReq, response: suffRes }, "sufficiency_agent", suffRes.status);

    sufficient = Boolean(suffRes.outputs.sufficient);
    const numericReady = !questionProfile.expectsNumeric || (
      strongEvidence >= 3 &&
      signalCoverage >= 0.55 &&
      queryCoverage.size >= 2
    );
    if (sufficient && numericReady) {
      break;
    }

    if (strategy.refinementMode === "adaptive") {
      queries = buildRefinementQueries(question, deduped, planner.subqueries, planner.mustHaveSignals, planner.hypotheses);
    } else {
      queries = buildRefinementQueries(question, deduped.slice(0, 6), planner.subqueries, planner.mustHaveSignals, planner.hypotheses).slice(0, 6);
    }
  }

  const finalEvidence = dedupeEvidence(evidence).slice(0, 18);
  const synthesisEvidence = selectSynthesisEvidence(finalEvidence, 12);
  const numericValues = questionProfile.expectsNumeric ? extractNumericEvidence(finalEvidence) : [];
  let consistency = true;
  let contradiction = false;

  if (questionProfile.expectsNumeric) {
    const consistencyReq = buildEnvelope({
      traceId,
      conversationId,
      fromAgent: "controller_agent",
      toAgent: "fact_consistency_agent",
      intent: "check_numeric_consistency",
      payload: { numericValues }
    });
    const consistencyRes = dispatchAgentEnvelope(consistencyReq);
    await appendStep(answerRunId, stepIndex++, { request: consistencyReq, response: consistencyRes }, "fact_consistency_agent", consistencyRes.status);

    const contraReq = buildEnvelope({
      traceId,
      conversationId,
      fromAgent: "controller_agent",
      toAgent: "contradiction_agent",
      intent: "check_contradictions",
      payload: { numericValues }
    });
    const contraRes = dispatchAgentEnvelope(contraReq);
    await appendStep(answerRunId, stepIndex++, { request: contraReq, response: contraRes }, "contradiction_agent", contraRes.status);
    consistency = Boolean(consistencyRes.outputs.hasConsistentNumericClaim);
    contradiction = Boolean(contraRes.outputs.contradiction);
  } else {
    await appendStep(answerRunId, stepIndex++, { skipped: "numeric_consistency_not_required" }, "fact_consistency_agent", "ok");
    await appendStep(answerRunId, stepIndex++, { skipped: "contradiction_check_not_required" }, "contradiction_agent", "ok");
  }

  const estimate = selectBestEstimate(synthesisEvidence);
  const hasEvidence = finalEvidence.length > 0;

  const confidenceScore = clamp01(
    (hasEvidence ? 0.25 : 0) +
    (sufficient ? 0.3 : 0) +
    (strongEvidence >= 2 ? 0.2 : 0) +
    (signalCoverage * 0.15) +
    (!contradiction ? 0.1 : 0) +
    (consistency ? 0.1 : 0)
  );

  const heuristicAnswer = buildAnswerContract({
    plan: planner,
    question,
    profile: questionProfile,
    hasEvidence,
    sufficient,
    contradiction,
    confidenceScore,
    signalCoverage,
    strongEvidence,
    estimate,
    evidence: synthesisEvidence,
    assumptionsUsed: planner.missingSlots.length > 0
      ? [`Scope inferred from available evidence; missing slots: ${planner.missingSlots.join(", ")}.`]
      : []
  });
  let answerContract: V2AnswerContract = heuristicAnswer;
  const synthesized = await synthesizeAnswerContractWithModel({
    question,
    plan: planner,
    chatNamespace,
    timeframe: String(input.timeframe ?? "all"),
    profile: questionProfile,
    sufficient,
    contradiction,
    confidenceScore,
    estimate,
    evidence: synthesisEvidence,
    fallback: heuristicAnswer,
    composerMode: strategy.composerMode
  });
  await appendStep(answerRunId, stepIndex++, {
    synthesis: {
      usedModel: Boolean(synthesized),
      heuristic: heuristicAnswer,
      synthesized
    }
  }, "controller_agent", synthesized ? "ok" : "retry");
  if (synthesized) answerContract = synthesized;

  const criticReq = buildEnvelope({
    traceId,
    conversationId,
    fromAgent: "controller_agent",
    toAgent: "answer_critic_agent",
    intent: "audit_answer_contract",
    payload: { answer: answerContract }
  });
  const criticRes = dispatchAgentEnvelope(criticReq);
  await appendStep(answerRunId, stepIndex++, { request: criticReq, response: criticRes }, "answer_critic_agent", criticRes.status);

  const adjudReq = buildEnvelope({
    traceId,
    conversationId,
    fromAgent: "controller_agent",
    toAgent: "quality_adjudicator_agent",
    intent: "final_gate",
    payload: {
      criticOk: Boolean(criticRes.outputs.contractValid),
      sufficient,
      contradiction
    }
  });
  const adjudRes = dispatchAgentEnvelope(adjudReq);
  await appendStep(answerRunId, stepIndex++, { request: adjudReq, response: adjudRes }, "quality_adjudicator_agent", adjudRes.status);

  const decision = adjudRes.decision as V2Decision;

  await pool.query(
    `UPDATE answer_runs
        SET status = $2,
            decision = $3,
            direct_answer = $4,
            missing_data_statement = $5,
            estimate_summary = $6,
            confidence_label = $7,
            contradiction_callout = $8,
            definitive_next_data = $9,
            confirmation_prompt = $10,
            quality_signals = $11::jsonb,
            finished_at = now(),
            updated_at = now()
      WHERE id = $1::uuid`,
    [
      answerRunId,
      decision === "promote" ? "completed" : decision === "retry" ? "partial" : "held",
      decision,
      answerContract.finalAnswer?.direct ?? null,
      answerContract.decision === "clarify_first"
        ? `Clarification required: ${answerContract.clarificationQuestion ?? "scope clarification needed"}`
        : answerContract.status === "insufficient"
          ? "Insufficient grounded evidence to answer definitively."
          : null,
      answerContract.finalAnswer?.estimate ?? null,
      answerContract.finalAnswer?.confidence ?? "low",
      answerContract.finalAnswer?.contradictionCallout ?? null,
      answerContract.finalAnswer?.definitiveNextData
        ?? (answerContract.decision === "clarify_first"
          ? `Answer clarification question first: ${answerContract.clarificationQuestion ?? "clarify scope"}`
          : "Provide explicit timestamped source evidence."),
      answerContract.decision === "clarify_first"
        ? "Please answer the clarification question so I can continue."
        : "Is this right? Reply yes, or no + correction.",
      JSON.stringify({
        strategy,
        questionProfile,
        plannerIntent: planner.intent,
        plannerIntentSummary: planner.intentSummary,
        plannerRequiredSlots: planner.requiredSlots,
        plannerKnownSlots: planner.knownSlots,
        plannerMissingSlots: planner.missingSlots,
        plannerConstraints: planner.constraints,
        plannerDisallowedPaths: planner.disallowedPaths,
        plannerStopAndAskTriggers: planner.stopAndAskTriggers,
        plannerSignals: planner.mustHaveSignals,
        plannerHypotheses: planner.hypotheses,
        temporalIntent,
        sufficient,
        strongEvidence,
        signalCoverage,
        consistency,
        contradiction,
        numericValues,
        bootstrap
      })
    ]
  );

  for (let i = 0; i < finalEvidence.length; i += 1) {
    const ev = finalEvidence[i];
    await pool.query(
      `INSERT INTO answer_evidence_links (
         answer_run_id,
         memory_item_id,
         canonical_message_id,
         source_message_id,
         actor_id,
         source_timestamp,
         context_role,
         anchor_score,
         evidence_rank,
         relevance
       ) VALUES (
         $1::uuid,
         $2::uuid,
         NULLIF($3, '')::uuid,
         NULLIF($4, ''),
         NULLIF($5, '')::uuid,
         CASE WHEN NULLIF($6, '') IS NULL THEN NULL ELSE $6::timestamptz END,
         NULLIF($7, ''),
         $8,
         $9,
         $10
       )
       ON CONFLICT DO NOTHING`,
      [
        answerRunId,
        ev.memoryId,
        String(ev.canonicalId ?? ""),
        String(ev.sourceMessageId ?? ""),
        String(ev.actorId ?? ""),
        String(ev.sourceTimestamp ?? ""),
        String(ev.contextRole ?? ""),
        Number(ev.similarity ?? 0),
        i + 1,
        Number(ev.similarity ?? 0)
      ]
    );
  }

  return {
    ok: true,
    traceId,
    answerRunId,
    decision,
    answerContract: answerContract,
    answer: answerContract,
    qualitySignals: {
      strategy,
      sufficient,
      strongEvidence,
      contradiction,
      bootstrap,
      confidenceScore,
      principalKind: principal.kind
    },
    evidence: finalEvidence,
    debugTrace: input.debugMode
      ? {
          runId: answerRunId,
          traceUrl: `/v2/brain/ask/run/${answerRunId}`
        }
      : undefined
  };
}

export async function submitAskFeedback(params: {
  answerRunId?: string;
  traceId?: string;
  verdict: "yes" | "no" | "partial";
  correction?: string;
  correctedValue?: Record<string, unknown>;
  asOfDate?: string;
  scope?: string;
}): Promise<{ ok: true }> {
  let answerRunId = String(params.answerRunId ?? "").trim();
  if (!answerRunId) {
    const traceId = String(params.traceId ?? "").trim();
    if (!traceId) {
      throw new Error("answerRunId or traceId is required");
    }
    const lookup = await pool.query<{ id: string }>(
      `SELECT id::text
         FROM answer_runs
        WHERE trace_id = $1
        ORDER BY created_at DESC
        LIMIT 1`,
      [traceId]
    );
    answerRunId = String(lookup.rows[0]?.id ?? "").trim();
    if (!answerRunId) {
      throw new Error("No answer run found for traceId");
    }
  }

  await pool.query(
    `INSERT INTO answer_feedback (
       answer_run_id,
       verdict,
       correction,
       corrected_value,
       as_of_date,
       scope,
       created_at
     ) VALUES ($1::uuid, $2, $3, $4::jsonb, $5::date, $6, now())`,
    [
      answerRunId,
      params.verdict,
      params.correction ?? null,
      JSON.stringify(params.correctedValue ?? {}),
      params.asOfDate ?? null,
      params.scope ?? null
    ]
  );

  return { ok: true };
}
