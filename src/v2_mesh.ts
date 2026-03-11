import { randomUUID } from "node:crypto";
import { validateV2RequestEnvelope, validateV2ResponseEnvelope } from "./v2_protocol.js";
import type {
  V2AgentName,
  V2AgentRequestEnvelope,
  V2AgentResponseEnvelope,
  V2Decision
} from "./v2_types.js";

function nowIso(): string {
  return new Date().toISOString();
}

function mkResponse(params: {
  req: V2AgentRequestEnvelope;
  fromAgent: V2AgentName;
  status?: "ok" | "retry" | "failed";
  decision?: V2Decision;
  confidence?: number;
  reasons?: string[];
  outputs?: Record<string, unknown>;
  qualitySignals?: Record<string, unknown>;
}): V2AgentResponseEnvelope {
  const response: V2AgentResponseEnvelope = {
    schemaVersion: params.req.schemaVersion,
    messageId: randomUUID(),
    traceId: params.req.traceId,
    inReplyTo: params.req.messageId,
    fromAgent: params.fromAgent,
    toAgent: params.req.fromAgent,
    messageType: "response",
    status: params.status ?? "ok",
    decision: params.decision ?? "hold",
    confidence: Math.max(0, Math.min(1, Number(params.confidence ?? 0.5))),
    reasons: params.reasons ?? [],
    outputs: params.outputs ?? {},
    qualitySignals: params.qualitySignals ?? {},
    createdAt: nowIso()
  };
  validateV2ResponseEnvelope(response);
  return response;
}

function temporalReasoning(req: V2AgentRequestEnvelope): V2AgentResponseEnvelope {
  const question = String(req.payload.question ?? "").toLowerCase();
  let timeframe: string = "all";
  if (/\btoday\b/.test(question)) timeframe = "1d";
  else if (/\byesterday\b/.test(question)) timeframe = "2d";
  else if (/\blast week\b/.test(question)) timeframe = "7d";
  else if (/\blast month\b/.test(question)) timeframe = "30d";
  else if (/\blast year\b/.test(question)) timeframe = "365d";
  return mkResponse({
    req,
    fromAgent: "temporal_reasoning_agent",
    decision: "promote",
    confidence: timeframe === "all" ? 0.6 : 0.82,
    reasons: timeframe === "all" ? ["no_explicit_temporal_constraint"] : ["temporal_constraint_detected"],
    outputs: { inferredTimeframe: timeframe }
  });
}

function sufficiency(req: V2AgentRequestEnvelope): V2AgentResponseEnvelope {
  const evidenceCount = Number(req.payload.evidenceCount ?? 0);
  const strongEvidence = Number(req.payload.strongEvidence ?? 0);
  const signalCoverage = Math.max(0, Math.min(1, Number(req.payload.signalCoverage ?? 0)));
  const coveredQueries = Number(req.payload.coveredQueries ?? 0);
  const queryCount = Math.max(1, Number(req.payload.queryCount ?? 1));
  const queryCoverage = Math.max(0, Math.min(1, coveredQueries / queryCount));
  const topSimilarity = Math.max(0, Math.min(1, Number(req.payload.topSimilarity ?? 0)));
  const numericDensity = Math.max(0, Math.min(1, Number(req.payload.numericDensity ?? 0)));
  const sourceDiversity = Math.max(0, Math.min(1, Number(req.payload.sourceDiversity ?? 0)));
  const strongNormalized = Math.max(0, Math.min(1, strongEvidence / 3));

  const sufficiencyScore =
    signalCoverage * 0.34 +
    queryCoverage * 0.2 +
    topSimilarity * 0.22 +
    strongNormalized * 0.14 +
    numericDensity * 0.06 +
    sourceDiversity * 0.04;

  const sufficient =
    sufficiencyScore >= 0.62 ||
    (topSimilarity >= 0.9 && signalCoverage >= 0.55) ||
    (strongEvidence >= 1 && signalCoverage >= 0.75 && queryCoverage >= 0.7);
  return mkResponse({
    req,
    fromAgent: "sufficiency_agent",
    decision: sufficient ? "promote" : "retry",
    status: sufficient ? "ok" : "retry",
    confidence: sufficient ? Math.max(0.7, sufficiencyScore) : Math.max(0.35, sufficiencyScore),
    reasons: sufficient ? ["evidence_quality_sufficient"] : ["evidence_quality_insufficient"],
    outputs: {
      sufficient,
      sufficiencyScore,
      evidenceCount,
      strongEvidence,
      signalCoverage,
      coveredQueries,
      queryCount,
      queryCoverage,
      topSimilarity,
      numericDensity,
      sourceDiversity
    }
  });
}

function contradiction(req: V2AgentRequestEnvelope): V2AgentResponseEnvelope {
  const values = Array.isArray(req.payload.numericValues) ? req.payload.numericValues.map((v) => Number(v)).filter(Number.isFinite) : [];
  if (values.length < 2) {
    return mkResponse({
      req,
      fromAgent: "contradiction_agent",
      decision: "promote",
      confidence: 0.7,
      reasons: ["single_or_no_numeric_claim"],
      outputs: { contradiction: false, spreadRatio: 0 }
    });
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  const spreadRatio = min > 0 ? max / min : max;
  const contradiction = spreadRatio >= 3;
  return mkResponse({
    req,
    fromAgent: "contradiction_agent",
    decision: contradiction ? "hold" : "promote",
    confidence: contradiction ? 0.74 : 0.81,
    reasons: contradiction ? ["numeric_claims_conflict"] : ["numeric_claims_consistent"],
    outputs: { contradiction, spreadRatio, min, max }
  });
}

function factConsistency(req: V2AgentRequestEnvelope): V2AgentResponseEnvelope {
  const raw = Array.isArray(req.payload.numericValues) ? req.payload.numericValues : [];
  const values = raw
    .map((v) => Number(v))
    .filter((v) => Number.isFinite(v) && v > 0)
    .sort((a, b) => a - b);
  if (values.length === 0) {
    return mkResponse({
      req,
      fromAgent: "fact_consistency_agent",
      decision: "hold",
      confidence: 0.45,
      reasons: ["no_numeric_claims"],
      outputs: {
        hasConsistentNumericClaim: false,
        median: null,
        low: null,
        high: null
      }
    });
  }
  const low = values[0];
  const high = values[values.length - 1];
  const median = values[Math.floor(values.length / 2)];
  const spreadRatio = low > 0 ? high / low : high;
  const consistent = spreadRatio <= 2.75;
  return mkResponse({
    req,
    fromAgent: "fact_consistency_agent",
    decision: consistent ? "promote" : "hold",
    confidence: consistent ? 0.83 : 0.62,
    reasons: consistent ? ["numeric_claims_consistent"] : ["numeric_claims_wide_spread"],
    outputs: {
      hasConsistentNumericClaim: consistent,
      median,
      low,
      high,
      spreadRatio
    }
  });
}

function answerCritic(req: V2AgentRequestEnvelope): V2AgentResponseEnvelope {
  const answer = req.payload.answer as Record<string, unknown>;
  const required = [
    "decision",
    "intentSummary",
    "requiresClarification",
    "clarificationQuestion",
    "assumptionsUsed",
    "constraintChecks",
    "finalAnswer",
    "status"
  ];
  const missing = required.filter((k) => !(k in (answer ?? {})));
  const decision = String(answer?.decision ?? "");
  const status = String(answer?.status ?? "");
  const decisionOk = decision === "answer_now" || decision === "clarify_first" || decision === "insufficient";
  const statusOk = ["definitive", "estimated", "partial", "insufficient", "clarification_needed"].includes(status);
  const checkArray = Array.isArray(answer?.constraintChecks);
  const assumptionsArray = Array.isArray(answer?.assumptionsUsed);
  const finalAnswerValue = (answer as Record<string, unknown>)?.finalAnswer;
  const finalAnswerOk = finalAnswerValue === null || (typeof finalAnswerValue === "object" && !Array.isArray(finalAnswerValue));
  const clarificationValue = (answer as Record<string, unknown>)?.clarificationQuestion;
  const clarificationOk = clarificationValue === null || typeof clarificationValue === "string";
  const ok = missing.length === 0 && decisionOk && statusOk && checkArray && assumptionsArray && finalAnswerOk && clarificationOk;
  return mkResponse({
    req,
    fromAgent: "answer_critic_agent",
    status: ok ? "ok" : "retry",
    decision: ok ? "promote" : "retry",
    confidence: ok ? 0.85 : 0.4,
    reasons: ok
      ? ["answer_contract_complete"]
      : [
          "answer_contract_incomplete",
          ...missing.map((m) => `missing_${m}`),
          ...(decisionOk ? [] : ["invalid_decision"]),
          ...(statusOk ? [] : ["invalid_status"]),
          ...(checkArray ? [] : ["constraint_checks_not_array"]),
          ...(assumptionsArray ? [] : ["assumptions_not_array"]),
          ...(finalAnswerOk ? [] : ["invalid_final_answer"]),
          ...(clarificationOk ? [] : ["invalid_clarification_question"])
        ],
    outputs: { contractValid: ok, missingFields: missing, decision, status }
  });
}

function adjudicator(req: V2AgentRequestEnvelope): V2AgentResponseEnvelope {
  const criticOk = Boolean(req.payload.criticOk);
  const sufficient = Boolean(req.payload.sufficient);
  const contradiction = Boolean(req.payload.contradiction);

  if (criticOk && sufficient && !contradiction) {
    return mkResponse({
      req,
      fromAgent: "quality_adjudicator_agent",
      decision: "promote",
      confidence: 0.9,
      reasons: ["quality_gate_passed"],
      outputs: { published: true }
    });
  }

  if (criticOk && sufficient && contradiction) {
    return mkResponse({
      req,
      fromAgent: "quality_adjudicator_agent",
      decision: "hold",
      confidence: 0.62,
      reasons: ["conflict_detected"],
      outputs: { published: false, requiresConflictResolution: true }
    });
  }

  return mkResponse({
    req,
    fromAgent: "quality_adjudicator_agent",
    status: "retry",
    decision: "retry",
    confidence: 0.42,
    reasons: ["insufficient_quality"],
    outputs: { published: false }
  });
}

function defaultSpecialist(req: V2AgentRequestEnvelope, agent: V2AgentName): V2AgentResponseEnvelope {
  return mkResponse({
    req,
    fromAgent: agent,
    decision: "hold",
    confidence: 0.5,
    reasons: ["specialist_stub"],
    outputs: { acknowledged: true }
  });
}

export function dispatchAgentEnvelope(input: unknown): V2AgentResponseEnvelope {
  const req = validateV2RequestEnvelope(input) as unknown as V2AgentRequestEnvelope;

  switch (req.toAgent) {
    case "temporal_reasoning_agent":
      return temporalReasoning(req);
    case "fact_consistency_agent":
      return factConsistency(req);
    case "sufficiency_agent":
      return sufficiency(req);
    case "contradiction_agent":
      return contradiction(req);
    case "answer_critic_agent":
      return answerCritic(req);
    case "quality_adjudicator_agent":
      return adjudicator(req);
    case "ingestion_qa_agent":
    case "entity_resolution_agent":
    case "privacy_policy_agent":
      return defaultSpecialist(req, req.toAgent);
    default:
      return mkResponse({
        req,
        fromAgent: "controller_agent",
        status: "failed",
        decision: "reject",
        confidence: 0,
        reasons: ["unknown_target_agent"],
        outputs: {}
      });
  }
}
