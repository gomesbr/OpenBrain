import { config } from "./config.js";
import { inferStructuredSignals } from "./domain_inference.js";

const OPENAI_BASE = "https://api.openai.com/v1";

export interface ExtractMetadataOptions {
  contextWindow?: string[];
  sourceSystem?: string;
  sourceConversationId?: string | null;
  chatNamespace?: string | null;
}

interface StructuredTableShape {
  columns: string[];
  rows: Array<Record<string, unknown>>;
  rowCount: number;
}

interface ContentShape {
  kind: "plain_text" | "table" | "number_series";
  confidence: number;
  summary: string;
  cues: string[];
  table?: StructuredTableShape;
}

function normalizeBaseUrl(value: string, fallback: string): string {
  const base = String(value ?? "").trim() || fallback;
  return base.replace(/\/+$/, "");
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((item) => item.length > 0)
    .slice(0, 32);
}

function normalizeDomainScores(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object") return {};
  const out: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const num = Number(raw);
    if (Number.isFinite(num)) {
      out[key] = Math.max(0, Math.min(1, num));
    }
  }
  return out;
}

function mergeNumericMaps(a: Record<string, number>, b: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = { ...a };
  for (const [key, val] of Object.entries(b)) {
    out[key] = key in out ? Math.max(out[key], val) : val;
  }
  return out;
}

function topDomains(scores: Record<string, number>, limit = 8): string[] {
  return Object.entries(scores)
    .filter(([, score]) => score >= 0.25)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([domain]) => domain);
}

function mergeRelationshipHints(base: unknown, inferred: ReturnType<typeof inferStructuredSignals>["relationshipHints"]): Array<Record<string, unknown>> {
  const baseArray = Array.isArray(base)
    ? base
        .filter((item) => item && typeof item === "object")
        .map((item) => item as Record<string, unknown>)
    : [];

  const merged = new Map<string, Record<string, unknown>>();

  for (const item of baseArray) {
    const type = String(item.relationType ?? "").trim();
    const reason = String(item.reason ?? "model_inference").trim();
    const target = String(item.targetHint ?? "").trim();
    const confidence = Number(item.confidence ?? 0.5);
    const key = `${type}|${target}|${reason}`;
    merged.set(key, {
      relationType: type || "community",
      confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0.5,
      reason,
      targetHint: target || undefined
    });
  }

  for (const hint of inferred) {
    const key = `${hint.relationType}|${hint.targetHint ?? ""}|${hint.reason}`;
    const prev = merged.get(key);
    if (!prev || Number(hint.confidence) > Number(prev.confidence ?? 0)) {
      merged.set(key, {
        relationType: hint.relationType,
        confidence: Math.max(0, Math.min(1, hint.confidence)),
        reason: hint.reason,
        targetHint: hint.targetHint
      });
    }
  }

  return Array.from(merged.values()).slice(0, 12);
}

function sanitizeForTransport(input: string): string {
  return String(input ?? "")
    .replace(/^\uFEFF/, "")
    .replace(/\u00A0/g, " ")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
}

function detectMarkdownTable(text: string): StructuredTableShape | null {
  const lines = text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const tableLines = lines.filter((line) => (line.match(/\|/g)?.length ?? 0) >= 2);
  if (tableLines.length < 2) return null;

  const headerCells = tableLines[0].split("|").map((x) => x.trim()).filter(Boolean);
  if (headerCells.length < 2) return null;
  const hasSeparator =
    tableLines.length >= 2 &&
    /^[:\-\|\s]+$/.test(tableLines[1]) &&
    tableLines[1].includes("|");

  const rows: Array<Record<string, unknown>> = [];
  const startIndex = hasSeparator ? 2 : 1;
  for (const line of tableLines.slice(startIndex)) {
    if (/^[:\-\|\s]+$/.test(line)) continue;
    const cells = line.split("|").map((x) => x.trim()).filter(Boolean);
    if (cells.length < 2) continue;
    const row: Record<string, unknown> = {};
    for (let i = 0; i < Math.min(headerCells.length, cells.length); i += 1) {
      row[headerCells[i]] = cells[i];
    }
    if (Object.keys(row).length > 0) {
      rows.push(row);
    }
    if (rows.length >= 80) break;
  }

  // Keep table classification even when rows are sparse; this avoids dropping structural objects.
  if (rows.length === 0 && !hasSeparator) return null;
  return {
    columns: headerCells.slice(0, 24),
    rows,
    rowCount: rows.length
  };
}

function detectFinancialTable(text: string): StructuredTableShape | null {
  const month = "(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)";
  const rowRegex = new RegExp(`${month}\\s+\\d{1,2}(?:,\\s*\\d{4})?\\s+([0-9][0-9,]*(?:\\.[0-9]+)?)\\s+([A-Za-z][A-Za-z\\s]{1,40})`, "gi");
  const rows: Array<Record<string, unknown>> = [];
  let match: RegExpExecArray | null;

  while ((match = rowRegex.exec(text)) !== null) {
    rows.push({
      date: match[0].replace(/\s+([0-9][0-9,]*(?:\.[0-9]+)?)\s+([A-Za-z][A-Za-z\s]{1,40})$/, "").trim(),
      value: Number(String(match[2]).replace(/,/g, "")),
      source: String(match[3]).trim()
    });
    if (rows.length >= 120) break;
  }

  if (rows.length < 3) return null;
  return {
    columns: ["date", "value", "source"],
    rows,
    rowCount: rows.length
  };
}

function detectNumberSeries(text: string): { count: number; sample: number[] } | null {
  const nums = Array.from(text.matchAll(/[$]?\b[0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]+)?\b/g))
    .map((m) => Number(String(m[0]).replace(/[$,]/g, "")))
    .filter((n) => Number.isFinite(n));

  if (nums.length < 6) return null;
  return { count: nums.length, sample: nums.slice(0, 8) };
}

function detectContentShape(text: string): ContentShape {
  const mdTable = detectMarkdownTable(text);
  if (mdTable) {
    return {
      kind: "table",
      confidence: 0.95,
      summary: `Detected markdown-style table with ${mdTable.rowCount} rows.`,
      cues: ["pipe_table"],
      table: mdTable
    };
  }

  const finTable = detectFinancialTable(text);
  if (finTable) {
    return {
      kind: "table",
      confidence: 0.9,
      summary: `Detected financial row table with ${finTable.rowCount} rows.`,
      cues: ["financial_rows", "date_value_source"],
      table: finTable
    };
  }

  const numberSeries = detectNumberSeries(text);
  if (numberSeries) {
    return {
      kind: "number_series",
      confidence: 0.75,
      summary: `Detected numeric series with ${numberSeries.count} values.`,
      cues: ["numeric_series", "aggregation_candidate"]
    };
  }

  return {
    kind: "plain_text",
    confidence: 0.5,
    summary: "No structured object detected.",
    cues: []
  };
}

function withContentShape(metadata: Record<string, unknown>, shape: ContentShape): Record<string, unknown> {
  const out: Record<string, unknown> = {
    ...metadata,
    content_kind: shape.kind,
    structure_confidence: shape.confidence,
    structure_summary: shape.summary,
    structure_cues: shape.cues,
    is_structured_object: shape.kind !== "plain_text"
  };
  if (shape.table) {
    out.structured_table = shape.table;
  }
  return out;
}

function fallbackMetadata(text: string, options?: ExtractMetadataOptions): Record<string, unknown> {
  const safeText = sanitizeForTransport(text);
  const topics = text
    .toLowerCase()
    .split(/[^a-z0-9_]+/i)
    .map((x) => x.trim())
    .filter((x) => x.length >= 4)
    .slice(0, 6);

  const inferred = inferStructuredSignals({
    text: safeText,
    contextWindow: options?.contextWindow ?? [],
    sourceSystem: options?.sourceSystem,
    sourceConversationId: options?.sourceConversationId
  });
  const shape = detectContentShape(safeText);

  return withContentShape({
    topics: topics.length > 0 ? topics : ["uncategorized"],
    type: "observation",
    people: [],
    action_items: [],
    dates_mentioned: [],
    language: inferred.language,
    domain_scores: inferred.domainScores,
    domain_top: inferred.domainTop,
    domain_evidence: inferred.domainEvidence,
    trait_scores: inferred.traitScores,
    relationship_hints: inferred.relationshipHints,
    inference_confidence: inferred.confidence,
    inference_version: "v2.1",
    system_event: inferred.isSystemEvent,
    noise_reasons: inferred.noiseReasons,
    metadata_provider_used: "local_inference"
  }, shape);
}

function fallbackWithError(text: string, reason: string, options?: ExtractMetadataOptions): Record<string, unknown> {
  return {
    ...fallbackMetadata(text, options),
    metadata_extraction_error: reason.slice(0, 220)
  };
}

function isLikelyNoiseText(text: string): boolean {
  const raw = String(text ?? "").trim();
  if (!raw) return true;
  if (raw.length < 2) return true;
  if (/^[\p{P}\p{S}\p{N}\s]+$/u.test(raw)) return true;
  const alnum = raw.replace(/[^\p{L}\p{N}]+/gu, "");
  if (alnum.length < 2) return true;
  return false;
}

function hasHighValueCue(text: string): boolean {
  const t = String(text ?? "").toLowerCase();
  return /\b(balance|net worth|account|bank|portfolio|invest|budget|salary|tax|expense|money|cash|dollar|usd|401k|roth|robinhood|doctor|hospital|therapy|anxiety|depress|wife|husband|spouse|marriage|girlfriend|boyfriend|friend|family|mom|dad|risk|legal|privacy|security)\b/i.test(t);
}

function shouldUseModelMetadata(params: {
  text: string;
  options?: ExtractMetadataOptions;
  inferred: ReturnType<typeof inferStructuredSignals>;
}): boolean {
  if (config.metadataForceModel) return true;
  if (params.inferred.isSystemEvent) return false;
  if (isLikelyNoiseText(params.text)) return false;

  const sourceSystem = String(params.options?.sourceSystem ?? "").toLowerCase();
  const allowlist = (config.metadataModelSourceAllowlist ?? []).map((s) => s.toLowerCase());
  const inAllowlist = allowlist.length > 0 && allowlist.includes(sourceSystem);
  const charLen = String(params.text ?? "").trim().length;
  const minChars = Math.max(20, Number(config.metadataModelMinChars ?? 120));

  if (inAllowlist) {
    return true;
  }
  if (charLen >= minChars) {
    return true;
  }
  if (hasHighValueCue(params.text)) {
    return true;
  }
  if (params.inferred.confidence >= 0.72) {
    return false;
  }
  if (sourceSystem === "whatsapp" && charLen < 180) {
    return false;
  }
  return false;
}

function resolveMetadataProvider(): "mock" | "openai" {
  const raw = config.metadataProvider.toLowerCase();
  if (raw === "openai" || raw === "mock") {
    return raw;
  }

  const embeddingMode = config.embeddingMode.toLowerCase();
  if (embeddingMode === "openai") return "openai";
  return "mock";
}

function resolveMetadataModel(provider: "openai", model: string): string {
  const trimmed = String(model ?? "").trim();
  return trimmed.replace(/^openai\//i, "") || "gpt-4o-mini";
}

function composePrompt(text: string, options?: ExtractMetadataOptions): string {
  const safeText = sanitizeForTransport(text);
  const context = (options?.contextWindow ?? [])
    .slice(-8)
    .map((line) => sanitizeForTransport(line))
    .join("\n")
    .slice(0, 2400);
  if (!context) return safeText;
  return `Current message:\n${safeText}\n\nPrevious conversation context:\n${context}`;
}

function toAsciiQuotes(input: string): string {
  return input
    .replace(/[\u201C\u201D]/g, "\"")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/\u00A0/g, " ");
}

function stripCodeFences(input: string): string {
  const match = input.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (match?.[1]) return match[1].trim();
  return input;
}

function sliceLikelyJsonObject(input: string): string {
  const first = input.indexOf("{");
  const last = input.lastIndexOf("}");
  if (first >= 0 && last > first) {
    return input.slice(first, last + 1).trim();
  }
  return input;
}

function sanitizeJsonCandidate(input: string): string {
  return toAsciiQuotes(input)
    .replace(/^\uFEFF/, "")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "")
    .replace(/,\s*([}\]])/g, "$1")
    .trim();
}

function parseLooseJsonObject(content: string): Record<string, unknown> | null {
  const variants = new Set<string>();
  const push = (value: string): void => {
    const v = String(value ?? "").trim();
    if (v) variants.add(v);
  };

  const base = String(content ?? "").trim();
  push(base);
  push(stripCodeFences(base));
  push(sliceLikelyJsonObject(base));
  push(sliceLikelyJsonObject(stripCodeFences(base)));

  for (const variant of Array.from(variants)) {
    const cleaned = sanitizeJsonCandidate(variant);
    if (!cleaned) continue;
    try {
      const parsed = JSON.parse(cleaned) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Try next candidate
    }
  }
  return null;
}

async function requestMetadata(params: {
  providerLabel: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  text: string;
  options?: ExtractMetadataOptions;
}): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);
  const safeText = sanitizeForTransport(params.text);

  const inferred = inferStructuredSignals({
    text: safeText,
    contextWindow: params.options?.contextWindow ?? [],
    sourceSystem: params.options?.sourceSystem,
    sourceConversationId: params.options?.sourceConversationId
  });
  const shape = detectContentShape(safeText);

  // Robust path for heavy structured content: avoid model JSON fragility.
  if (shape.kind === "table" && shape.confidence >= 0.72) {
    return {
      ...fallbackMetadata(safeText, params.options),
      metadata_provider_used: "local_structure_parser",
      model_skipped_reason: "structured_table_detected"
    };
  }

  if (!shouldUseModelMetadata({ text: safeText, options: params.options, inferred })) {
    return fallbackMetadata(safeText, params.options);
  }

  try {
    const response = await fetch(`${params.baseUrl}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${params.apiKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: params.model,
        max_tokens: config.metadataMaxTokens,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              "Extract structured metadata from the message + conversation context. Return ONLY JSON with keys: people (array), action_items (array), dates_mentioned (array YYYY-MM-DD), topics (array), type (observation|task|idea|reference|person_note), domain_scores (object with 36 taxonomy domains and 0..1 scores), trait_scores (object), relationship_hints (array of {relationType, confidence, reason, targetHint}), language (en|pt|es|mixed|unknown). Use semantics and context, not only keywords."
          },
          { role: "user", content: composePrompt(safeText, params.options) }
        ]
      })
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      return fallbackWithError(safeText, `${params.providerLabel.toLowerCase()}_http_${response.status}:${body.slice(0, 120)}`, params.options);
    }

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };

    const content = payload?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) {
      return fallbackMetadata(safeText, params.options);
    }

    try {
      const parsed = parseLooseJsonObject(content);
      if (!parsed) {
        return fallbackWithError(safeText, "invalid_json_content", params.options);
      }
      const people = normalizeStringArray(parsed.people);
      const actionItems = normalizeStringArray(parsed.action_items);
      const datesMentioned = normalizeStringArray(parsed.dates_mentioned);
      const topics = normalizeStringArray(parsed.topics);

      const modelDomainScores = normalizeDomainScores(parsed.domain_scores);
      const modelTraitScores = normalizeDomainScores(parsed.trait_scores);
      const mergedDomainScores = mergeNumericMaps(modelDomainScores, inferred.domainScores);
      const mergedTraitScores = mergeNumericMaps(modelTraitScores, inferred.traitScores);
      const relationshipHints = mergeRelationshipHints(parsed.relationship_hints, inferred.relationshipHints);

      return withContentShape({
        people,
        action_items: actionItems,
        dates_mentioned: datesMentioned,
        topics: topics.length > 0 ? topics : ["uncategorized"],
        type: typeof parsed.type === "string" && parsed.type.trim() ? parsed.type.trim() : "observation",
        language: typeof parsed.language === "string" ? parsed.language : inferred.language,
        domain_scores: mergedDomainScores,
        domain_top: topDomains(mergedDomainScores),
        domain_evidence: inferred.domainEvidence,
        trait_scores: mergedTraitScores,
        relationship_hints: relationshipHints,
        inference_confidence: Math.max(0, Math.min(1, Number(parsed.inference_confidence ?? inferred.confidence))),
        inference_version: "v2.1",
        system_event: inferred.isSystemEvent,
        noise_reasons: inferred.noiseReasons,
        metadata_provider_used: params.providerLabel.toLowerCase()
      }, shape);
    } catch {
      return fallbackWithError(safeText, "invalid_json_content", params.options);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fallbackWithError(safeText, `${params.providerLabel.toLowerCase()}_exception:${message}`, params.options);
  } finally {
    clearTimeout(timeout);
  }
}

export async function extractMetadata(text: string, options?: ExtractMetadataOptions): Promise<Record<string, unknown>> {
  const provider = resolveMetadataProvider();

  if (provider === "mock") {
    return fallbackMetadata(text, options);
  }

  if (provider === "openai") {
    if (!config.openAiApiKey) {
      return fallbackWithError(text, "missing_openai_api_key", options);
    }

    return requestMetadata({
      providerLabel: "OpenAI",
      baseUrl: normalizeBaseUrl(config.openAiBaseUrl, OPENAI_BASE),
      apiKey: config.openAiApiKey,
      model: resolveMetadataModel("openai", config.metadataModel),
      text,
      options
    });
  }

  return fallbackWithError(text, "unsupported_metadata_provider", options);
}
