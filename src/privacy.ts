import { createHash } from "node:crypto";
import { config } from "./config.js";
import type {
  BrainInsight,
  ChartPayload,
  EvidenceRef,
  GraphPayload,
  PrivacyMode
} from "./types.js";

const PII_KEYWORDS = [
  "email",
  "phone",
  "address",
  "ssn",
  "cpf",
  "credit",
  "account",
  "password",
  "medical",
  "diagnosis",
  "bank"
];

function stableDigest(input: string): string {
  return createHash("sha256").update(`${config.pseudonymSeed}:${input}`).digest("hex");
}

export function pseudonymFor(name: string): string {
  const clean = name.trim();
  if (!clean) return "Person-Unknown";
  const digest = stableDigest(clean).slice(0, 6).toUpperCase();
  return `Person-${digest}`;
}

export function redactText(value: string, mode: PrivacyMode): string {
  if (mode === "private") return value;
  if (!value) return value;

  if (mode === "demo") {
    return `Synthetic summary ${stableDigest(value).slice(0, 8)}.`;
  }

  let out = value;
  out = out.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-email]");
  out = out.replace(/\+?\d[\d\s().-]{7,}\d/g, "[redacted-phone]");
  out = out.replace(/\b\d{3}[- ]?\d{2}[- ]?\d{4}\b/g, "[redacted-id]");
  out = out.replace(/\b(?:Rua|Street|St|Avenue|Ave|Road|Rd|Drive|Dr)\b[^,\n]*/gi, "[redacted-address]");
  return out;
}

function scrubTags(tags: string[] | undefined, mode: PrivacyMode): string[] | undefined {
  if (!tags || tags.length === 0) return undefined;
  if (mode === "private") return tags;
  return tags.filter((tag) => !PII_KEYWORDS.some((p) => tag.toLowerCase().includes(p)));
}

export function applyPrivacyToEvidence(rows: EvidenceRef[], mode: PrivacyMode): EvidenceRef[] {
  return rows.map((row) => ({
    ...row,
    excerpt: redactText(row.excerpt, mode)
  }));
}

export function applyPrivacyToInsights(rows: BrainInsight[], mode: PrivacyMode): BrainInsight[] {
  return rows.map((row) => ({
    ...row,
    title: mode === "demo" ? `Synthetic ${row.insightType} insight` : redactText(row.title, mode),
    summary: redactText(row.summary, mode),
    action: row.action ? redactText(row.action, mode) : row.action
  }));
}

export function applyPrivacyToGraph(graph: GraphPayload, mode: PrivacyMode): GraphPayload {
  const nodes = graph.nodes.map((node) => ({
    ...node,
    label: mode === "private" ? node.label : pseudonymFor(node.label),
    tags: scrubTags(node.tags, mode)
  }));
  return {
    ...graph,
    nodes
  };
}

export function applyPrivacyToCharts(charts: ChartPayload[], mode: PrivacyMode): ChartPayload[] {
  if (mode === "private") return charts;
  return charts.map((chart) => ({
    ...chart,
    title: mode === "demo" ? `Synthetic ${chart.title}` : chart.title,
    series: chart.series.map((series) => ({
      ...series,
      name: mode === "share_safe" ? pseudonymFor(series.name) : series.name
    }))
  }));
}
