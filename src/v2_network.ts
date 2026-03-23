import { pool } from "./db.js";
import type { PoolClient } from "pg";
import { fetchContextWindow } from "./v2_search.js";
import type {
  AnswerSceneSeed,
  NetworkConfidenceMode,
  NetworkDetailPanel,
  NetworkDetailPanelSection,
  NetworkEdgeType,
  NetworkEvidencePanel,
  NetworkEvidencePanelItem,
  NetworkEvidenceSummary,
  NetworkGraphCommand,
  NetworkGraphEdge,
  NetworkGraphFilterState,
  NetworkGraphNode,
  NetworkGraphRequest,
  NetworkGraphResponse,
  NetworkLayoutMode,
  NetworkNodeType,
  NetworkProvenanceMode,
  NetworkSceneMode,
  NetworkSavedViewSummary,
  NetworkSnapshotSummary,
  V2EvidenceRef,
  NetworkTickMode
} from "./v2_types.js";

type RelationshipClass = "family_confirmed" | "family_likely" | "friend" | "contact" | "unknown";

type OwnerActor = {
  actorId: string;
  canonicalName: string;
};

type ActorProfile = {
  actorId: string;
  canonicalName: string;
  actorType: string;
  confidence: number;
  messageCount: number;
  aliases: string[];
};

type ConversationAggregate = {
  conversationId: string;
  sourceSystem: string;
  sourceConversationId: string | null;
  conversationLabel: string | null;
  messageCount: number;
  participantIds: string[];
  startAt: string | null;
  endAt: string | null;
};

type ThreadSeedMessage = {
  conversationId: string;
  sourceSystem: string;
  sourceConversationId: string | null;
  actorId: string | null;
  observedAt: string | null;
  content: string;
};

type ThreadCluster = {
  conversationId: string;
  sourceSystem: string;
  sourceConversationId: string | null;
  startAt: string | null;
  endAt: string | null;
  actorIds: string[];
  texts: string[];
  messageCount: number;
};

type FactSeed = {
  factId: string;
  factType: string;
  domain: string;
  valueText: string;
  confidence: number;
  sourceTimestamp: string | null;
  metadata: Record<string, unknown>;
};

type PersistedEntityRow = {
  id: string;
  entity_key: string;
  entity_type: NetworkNodeType;
  actor_id: string | null;
  label: string;
  display_label: string;
  full_label: string | null;
  confidence: number;
  strength: number;
  provenance_mode: NetworkProvenanceMode;
  source_system: string | null;
  metadata: Record<string, unknown>;
  start_at: string | null;
  end_at: string | null;
};

type PersistedLinkRow = {
  id: string;
  source_entity_id: string;
  target_entity_id: string;
  edge_type: NetworkEdgeType;
  confidence: number;
  strength: number;
  provenance_mode: NetworkProvenanceMode;
  evidence_summary: unknown;
  metadata: Record<string, unknown>;
  first_seen_at: string | null;
  last_seen_at: string | null;
};

type SaveGraphPayload = {
  sceneMode?: NetworkSceneMode;
  graph: NetworkGraphResponse["graph"];
  answerSummary: string;
  sceneActions?: string[];
  detailPanel: NetworkDetailPanel | null;
  evidencePanel?: NetworkEvidencePanel | null;
  commandSuggestions: string[];
  weakHiddenCount: number;
};

const DEFAULT_NAMESPACE = "personal.main";
const DEFAULT_LIMIT = 180;
const THREAD_MAX_SPAN_MS = 14 * 24 * 60 * 60 * 1000;
const THREAD_MAX_GAP_MS = 3 * 24 * 60 * 60 * 1000;
const NETWORK_LAYOUTS: NetworkLayoutMode[] = ["radial", "force", "hierarchical"];

const CATEGORY_SHELLS: Array<{
  entityType: NetworkNodeType;
  key: string;
  label: string;
  fullLabel: string;
}> = [
  { entityType: "actor", key: "people", label: "People", fullLabel: "People you interact with or ask about." },
  { entityType: "family_group", key: "family", label: "Family", fullLabel: "Family members inferred conservatively from evidence." },
  { entityType: "friend_group", key: "friends", label: "Friends", fullLabel: "Friends and close contacts with repeated interaction." },
  { entityType: "group_chat", key: "groups", label: "Groups", fullLabel: "Group chats and recurring conversation spaces." },
  { entityType: "thread", key: "threads", label: "Threads", fullLabel: "Compact conversation clusters and topic bursts." },
  { entityType: "topic", key: "topics", label: "Topics", fullLabel: "High-signal topics inferred from repeated discussion." },
  { entityType: "project", key: "projects", label: "Projects", fullLabel: "Strictly inferred ongoing efforts with continuity." },
  { entityType: "location", key: "places", label: "Places", fullLabel: "Locations grounded in published facts and conversation evidence." },
  { entityType: "event", key: "events", label: "Events", fullLabel: "Events grounded in published facts and conversation evidence." },
  { entityType: "time_bucket", key: "time", label: "Time", fullLabel: "Time buckets for exploring how the network changes." },
  { entityType: "agents_tools", key: "agents-tools", label: "Agents & Tools", fullLabel: "Assistants, services, and non-human tools." }
];

const STOPWORDS = new Set([
  "about", "after", "again", "ainda", "alguem", "algo", "alert", "alerts", "all", "alla", "also", "amp", "an", "and",
  "any", "aqui", "assim", "como", "com", "cada", "because", "been", "before", "between", "both", "casa", "chat",
  "comigo", "conversation", "date", "day", "de", "del", "dela", "dele", "dentro", "desde", "discussion", "donde",
  "done", "dos", "ela", "ele", "ellos", "ellas", "esta", "este", "esto", "family", "fazer", "foi", "for", "from",
  "gente", "group", "have", "hola", "hoje", "house", "into", "isso", "isto", "just", "mais", "make", "meeting",
  "message", "more", "name", "near", "need", "nodes", "nossa", "nosso", "nueva", "novo", "off", "para", "per",
  "porque", "por", "pra", "project", "qty", "que", "reply", "run", "said", "semana", "sobre", "some", "talk",
  "talking", "team", "tem", "that", "the", "them", "there", "they", "thread", "this", "todo", "turn", "please", "not", "okay", "yeah", "yep", "turn0image0",
  "turn0image1", "turn0image4", "turn0image8", "with", "vamos", "very", "voc?", "voc?s", "what", "when", "where",
  "your", "yours", "you"
]);

const FAMILY_TERMS = [
  "wife", "husband", "mother", "mom", "father", "dad", "brother", "sister", "son", "daughter", "uncle", "aunt",
  "grandma", "grandmother", "grandpa", "grandfather", "cousin", "niece", "nephew", "partner", "spouse",
  "esposa", "esposo", "mae", "mãe", "pai", "irma", "irmã", "irmao", "irmão", "filho", "filha", "tio", "tia",
  "avó", "avo", "avô", "primo", "prima", "sobrinho", "sobrinha", "marido", "mulher",
  "madre", "padre", "hermana", "hermano", "hijo", "hija", "abuela", "abuelo"
];

const KINSHIP_SUFFIX_TOKENS = new Set([
  "avo", "avô", "avó", "brother", "dad", "daughter", "father", "grandfather", "grandma", "grandmother",
  "grandpa", "hermana", "hermano", "hija", "hijo", "husband", "irma", "irmã", "irmao", "irmão",
  "madre", "mae", "mãe", "mom", "mother", "nephew", "niece", "padre", "pai", "partner", "prima",
  "primo", "sister", "sobrinha", "sobrinho", "son", "spouse", "tia", "tio", "uncle", "wife"
]);

const NON_HUMAN_ACTOR_TYPES = new Set(["assistant", "system"]);

const PROJECT_CUES = [
  "benchmark", "construction", "meal prep", "migration", "paperwork", "purchase",
  "trip planning", "travel plan", "travel planning", "visa", "wedding planning",
  "projeto", "planejamento", "documentos", "empresa", "proyecto", "tramite", "viaje", "viagem"
];

const EVENT_TERMS = [
  "birthday", "meeting", "wedding", "concert", "appointment", "conference call", "road trip",
  "baby shower", "reunion", "holiday market", "aniversario", "festa", "casamento",
  "consulta", "reuniao", "cumpleanos", "boda", "cita"
];

const LOCATION_HINTS = [
  "street", " avenue", "boulevard", " blvd", "beach", "park", "airport", "mall", "restaurant",
  "rua", "avenida", "praia", "parque", "aeroporto", "calle", "playa", "aeropuerto"
];

const LOCATION_PHRASE_TERMS = [
  "coffee shop", "regional park", "state park", "national park", "parking garage", "parking lot",
  "miami beach", "airport", "restaurant", "restaurante", "cafe", "caf?", "mall", "costco", "walmart",
  "park", "beach", "avenue", "street", "boulevard", "blvd", "praia", "parque", "aeroporto",
  "aeropuerto", "playa", "calle", "rua", "avenida"
];

const EVENT_PHRASE_TERMS = [
  "road trip", "baby shower", "birthday party", "birthday", "meeting", "wedding", "concert", "appointment",
  "conference call", "reunion", "reuni?o", "reuniao", "consulta", "boda", "cumplea?os", "cumpleanos",
  "anivers?rio", "aniversario", "festa junina", "festa", "cita"
];

const LOCATION_SINGLE_WORD_REJECT = new Set([
  "airport", "avenida", "avenue", "beach", "blvd", "boulevard", "calle", "cafe", "caf?", "mall",
  "park", "parque", "playa", "praia", "restaurant", "restaurante", "rua", "street"
]);

const EVENT_SINGLE_WORD_REJECT = new Set([
  "appointment", "birthday", "concert", "meeting", "reunion", "reuniao", "reuni?o",
  "aniversario", "anivers?rio", "festa", "cita"
]);

const PROJECT_SINGLE_WORD_REJECT = new Set([
  "benchmark", "booking", "closing", "construction", "documentos", "meal", "migration", "paperwork",
  "planejamento", "project", "projeto", "proyecto", "purchase", "setup", "travel", "trip", "tr?mite",
  "tramite", "viaje", "viagem", "visa"
]);

const WEAK_LABEL_START_TOKENS = new Set([
  "a", "an", "and", "as", "at", "because", "before", "but", "can", "could", "during", "for", "from", "how",
  "i", "if", "im", "i'm", "in", "into", "is", "it", "it's", "its", "let", "lets", "like", "may", "might",
  "my", "of", "on", "or", "our", "should", "so", "that", "the", "their", "there", "these", "this", "those",
  "to", "was", "we", "were", "what", "when", "where", "which", "while", "who", "why", "will", "with",
  "without", "would", "you", "your"
]);

const WEAK_LABEL_END_TOKENS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "been", "being", "but", "can", "did", "do", "does", "for",
  "from", "had", "has", "have", "if", "in", "into", "is", "it", "it's", "its", "let", "like", "of", "on",
  "or", "please", "so", "than", "that", "the", "then", "these", "this", "those", "to", "was", "were",
  "with", "without", "you", "your"
]);

const DERIVED_NOISE_TOKENS = new Set([
  "app", "assistant", "async", "await", "bot", "chatgpt", "codex", "const", "data", "env", "http", "https",
  "image", "json", "metadata", "node", "null", "openbrain", "option", "options", "output", "path", "pdf",
  "price", "prices", "prompt", "search", "session", "signal", "stock", "target", "text", "token", "turn",
  "tsconfig", "tsx", "ts", "url", "vwap", "www", "cwd", "root", "unknown", "official", "website", "sample",
  "current", "upcoming", "next", "within", "using", "goes", "back", "strong", "around", "based", "such"
]);

const ALLOWED_PHRASE_CONTEXT_TOKENS = new Set([
  "a", "an", "at", "da", "de", "del", "do", "el", "in", "la", "na", "near", "no", "of", "the"
]);

function clamp01(value: unknown, fallback = 0): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  if (numeric <= 0) return 0;
  if (numeric >= 1) return 1;
  return numeric;
}

function normalizeSpace(value: string): string {
  return String(value ?? "")
    .replaceAll("\u00a0", " ")
    .replaceAll("\u202f", " ")
    .replace(/^[~\s]+/u, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function normalizeKey(value: string): string {
  return normalizeSpace(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function toTitleCase(value: string): string {
  return normalizeSpace(value)
    .split(/\s+/u)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function compactText(value: string, max = 180): string {
  const text = normalizeSpace(value);
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 3)).trimEnd()}...`;
}


function cleanConversationLabel(rawLabel: string | null | undefined, preferredLabel?: string | null): string {
  let label = normalizeSpace(preferredLabel || rawLabel || "");
  if (!label) return "";
  label = label
    .replace(/^whatsappdump__/iu, "")
    .replace(/^whatsapp chat\s*-\s*/iu, "")
    .replace(/^whatsappdump__whatsapp chat\s*-\s*/iu, "")
    .replace(/\.zip___chat$/iu, "")
    .replace(/___chat$/iu, "")
    .replace(/\.zip$/iu, "")
    .replace(/[_]+/gu, " ")
    .replace(/\s{2,}/gu, " ")
    .trim();
  return label;
}
function stripPossessiveSuffix(token: string): string {
  return token.replace(/['\u2019]s$/iu, "");
}

function buildOwnerLabels(owner: OwnerActor | null): { label: string; displayLabel: string; fullLabel: string } {
  return {
    label: "You",
    displayLabel: "You",
    fullLabel: normalizeSpace(owner?.canonicalName ?? "You") || "You"
  };
}

function buildActorLabels(canonicalName: string, actorType: string, isOwner = false): {
  label: string;
  displayLabel: string;
  fullLabel: string;
} {
  const fullLabel = normalizeSpace(canonicalName) || (isOwner ? "You" : "Unknown");
  if (isOwner) return buildOwnerLabels({ actorId: "", canonicalName: fullLabel });

  const actorTypeKey = normalizeKey(actorType);
  if (NON_HUMAN_ACTOR_TYPES.has(actorTypeKey)) {
    const normalized = normalizeKey(fullLabel);
    let label = fullLabel;
    if (normalized === "chatgpt assistant" || normalized === "chatgpt") label = "ChatGPT assistant";
    else if (normalized === "grok assistant") label = "Grok assistant";
    else if (normalized === "whatsapp system") label = "WhatsApp system";
    return {
      label,
      displayLabel: compactText(label, 28),
      fullLabel
    };
  }

  let tokens = fullLabel.split(/\s+/u).filter(Boolean);
  if (tokens.length >= 2) {
    while (tokens.length >= 2 && normalizeKey(tokens[tokens.length - 1]) === normalizeKey(tokens[tokens.length - 2])) {
      tokens = tokens.slice(0, -1);
    }
  }
  if (tokens.length >= 2) {
    const lastToken = normalizeKey(tokens[tokens.length - 1]);
    if (KINSHIP_SUFFIX_TOKENS.has(lastToken)) {
      const previousToken = tokens[tokens.length - 2];
      if (/['’]s$/u.test(previousToken)) {
        const leading = tokens.slice(0, -2);
        const possessor = stripPossessiveSuffix(previousToken);
        tokens = leading.length > 0 ? leading : [possessor];
      } else {
        tokens = tokens.slice(0, -1);
      }
    }
  }
  const label = normalizeSpace(tokens.join(" ")) || fullLabel;
  return {
    label,
    displayLabel: compactText(label, 28),
    fullLabel
  };
}

function asIso(value: string | Date | null | undefined): string | null {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

function extractTokens(value: string): string[] {
  return Array.from(normalizeSpace(value).toLowerCase().matchAll(/[\p{L}\p{N}]{3,}/gu), (match) => match[0])
    .filter((token) => !STOPWORDS.has(token) && !isDerivedNoiseToken(token));
}


function tokenizeWords(value: string): string[] {
  return Array.from(normalizeSpace(value).toLowerCase().matchAll(/[\p{L}\p{N}'&.-]+/gu), (match) => match[0]);
}

function isDerivedNoiseToken(token: string): boolean {
  const normalized = normalizeKey(token);
  return !normalized
    || DERIVED_NOISE_TOKENS.has(normalized)
    || /^turn\d+(?:image|search)\d+$/u.test(normalized)
    || /^whatsappdump/u.test(normalized)
    || /^https?$/u.test(normalized)
    || /^www\d*$/u.test(normalized)
    || /[_.\/]/u.test(normalized)
    || /^\d+([:.]\d+)?$/u.test(normalized);
}

function cleanDerivedCandidate(
  value: string,
  opts: { maxWords?: number; minWords?: number; rejectSingles?: Set<string> } = {}
): string | null {
  const rejectSingles = opts.rejectSingles ?? new Set<string>();
  let words = normalizeSpace(value)
    .split(/\s+/u)
    .map((part) => part.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
    .filter(Boolean);
  while (words.length > 0) {
    const first = normalizeKey(words[0]);
    if (!first || /^[a-z]$/iu.test(words[0]) || STOPWORDS.has(first) || WEAK_LABEL_START_TOKENS.has(first)) {
      words = words.slice(1);
      continue;
    }
    break;
  }
  while (words.length > 0) {
    const last = normalizeKey(words[words.length - 1]);
    if (!last || STOPWORDS.has(last) || WEAK_LABEL_END_TOKENS.has(last)) {
      words = words.slice(0, -1);
      continue;
    }
    break;
  }
  if (opts.maxWords && words.length > opts.maxWords) {
    words = words.slice(0, opts.maxWords);
  }
  if (words.length === 0) return null;
  const normalizedWords = words.map((word) => normalizeKey(word));
  if (normalizedWords.some((word) => isDerivedNoiseToken(word))) return null;
  if (opts.minWords && words.length < opts.minWords) return null;
  if (words.length === 1 && rejectSingles.has(normalizedWords[0])) return null;
  const informative = normalizedWords.filter((word) => (
    word
    && !STOPWORDS.has(word)
    && !WEAK_LABEL_START_TOKENS.has(word)
    && !WEAK_LABEL_END_TOKENS.has(word)
    && !rejectSingles.has(word)
    && !isDerivedNoiseToken(word)
  ));
  if (informative.length === 0) return null;
  if (words.length >= 3 && informative.length < 2) return null;
  if (new Set(informative).size === 1 && informative.length > 1) return null;
  return toTitleCase(words.join(" "));
}

function extractPhraseCandidates(
  texts: string[],
  terms: string[],
  rejectSingles: Set<string>,
  opts: {
    minWords?: number;
    maxWords?: number;
    minMentions?: number;
    maxPrefixWords?: number;
    maxSuffixWords?: number;
    allowedPrefixTokens?: Set<string>;
    allowedSuffixTokens?: Set<string>;
  } = {}
): string[] {
  const counts = new Map<string, number>();
  const sortedTerms = [...terms].sort((a, b) => b.length - a.length);
  const minMentions = Math.max(1, Number(opts.minMentions ?? 1) || 1);
  const maxPrefixWords = Math.max(0, Number(opts.maxPrefixWords ?? 2) || 0);
  const maxSuffixWords = Math.max(0, Number(opts.maxSuffixWords ?? 2) || 0);
  const allowedPrefixTokens = opts.allowedPrefixTokens ?? null;
  const allowedSuffixTokens = opts.allowedSuffixTokens ?? null;
  for (const text of texts) {
    const words = tokenizeWords(text);
    if (words.length === 0) continue;
    const seen = new Set<string>();
    for (const term of sortedTerms) {
      const termWords = term.split(/\s+/u).filter(Boolean);
      if (termWords.length === 0 || termWords.length > words.length) continue;
      for (let index = 0; index <= words.length - termWords.length; index += 1) {
        const window = words.slice(index, index + termWords.length);
        if (window.join(" ") !== termWords.join(" ")) continue;
        const phraseWords = [...window];
        let prefixed = 0;
        for (let cursor = index - 1; cursor >= 0 && prefixed < maxPrefixWords; cursor -= 1) {
          const token = words[cursor];
          if (/^\d+([:.]\d+)?$/u.test(token)) break;
          if (allowedPrefixTokens && !allowedPrefixTokens.has(token)) break;
          if (STOPWORDS.has(token) && token !== "the" && token !== "of" && token !== "de" && token !== "da" && token !== "do") {
            if (prefixed === 0) continue;
            break;
          }
          phraseWords.unshift(token);
          prefixed += 1;
          if (token === "the" || token === "of" || token === "de" || token === "da" || token === "do") break;
        }
        let suffixed = 0;
        for (let cursor = index + termWords.length; cursor < words.length && suffixed < maxSuffixWords; cursor += 1) {
          const token = words[cursor];
          if (/^\d+([:.]\d+)?$/u.test(token)) break;
          if (allowedSuffixTokens && !allowedSuffixTokens.has(token)) break;
          if (STOPWORDS.has(token) && token !== "of" && token !== "de" && token !== "da" && token !== "do") {
            if (suffixed === 0) continue;
            break;
          }
          phraseWords.push(token);
          suffixed += 1;
          if (token === "of" || token === "de" || token === "da" || token === "do") break;
        }
        const cleaned = cleanDerivedCandidate(phraseWords.join(" "), {
          minWords: opts.minWords ?? 2,
          maxWords: opts.maxWords ?? 4,
          rejectSingles
        });
        if (!cleaned) continue;
        const cleanedWords = tokenizeWords(cleaned);
        if (!termWords.every((word) => cleanedWords.includes(word))) continue;
        seen.add(cleaned);
      }
    }
    for (const candidate of seen) {
      counts.set(candidate, (counts.get(candidate) ?? 0) + 1);
    }
  }
  return Array.from(counts.entries())
    .filter(([, count]) => count >= minMentions)
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length || a[0].localeCompare(b[0]))
    .map(([label]) => label);
}

function extractLocationLabels(texts: string[]): string[] {
  return extractPhraseCandidates(texts, LOCATION_PHRASE_TERMS, LOCATION_SINGLE_WORD_REJECT, {
    minWords: 2,
    maxWords: 4,
    minMentions: 1,
    maxPrefixWords: 2,
    maxSuffixWords: 0,
    allowedPrefixTokens: ALLOWED_PHRASE_CONTEXT_TOKENS
  }).slice(0, 10);
}

function extractEventLabels(texts: string[]): string[] {
  return extractPhraseCandidates(texts, EVENT_PHRASE_TERMS, EVENT_SINGLE_WORD_REJECT, {
    minWords: 2,
    maxWords: 4,
    minMentions: 1,
    maxPrefixWords: 2,
    maxSuffixWords: 0,
    allowedPrefixTokens: ALLOWED_PHRASE_CONTEXT_TOKENS
  }).slice(0, 10);
}
function buildEvidenceSummary(
  excerpt: string,
  opts: Partial<NetworkEvidenceSummary> = {}
): NetworkEvidenceSummary {
  return {
    kind: String(opts.kind ?? "derived"),
    excerpt: compactText(excerpt, 220),
    sourceSystem: opts.sourceSystem ?? null,
    sourceTimestamp: opts.sourceTimestamp ?? null,
    actorName: opts.actorName ?? null,
    conversationLabel: opts.conversationLabel ?? null
  };
}

function summarizeEvidence(value: unknown): NetworkEvidenceSummary[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const source = item as Record<string, unknown>;
      const excerpt = compactText(String(source.excerpt ?? source.snippet ?? source.value ?? ""), 220);
      if (!excerpt) return null;
      return buildEvidenceSummary(excerpt, {
        kind: String(source.kind ?? source.type ?? "derived"),
        sourceSystem: source.sourceSystem ? String(source.sourceSystem) : null,
        sourceTimestamp: source.sourceTimestamp ? asIso(String(source.sourceTimestamp)) : null,
        actorName: source.actorName ? String(source.actorName) : null,
        conversationLabel: source.conversationLabel ? String(source.conversationLabel) : null
      });
    })
    .filter((item): item is NetworkEvidenceSummary => Boolean(item));
}

function buildCategoryCountBullets(nodesById: Map<string, NetworkGraphNode>): string[] {
  return CATEGORY_SHELLS.map((shell) => {
    const count = Array.from(nodesById.values()).filter((node) => {
      if (node.isShell) return false;
      if (shell.key === "family") {
        return node.relationshipClass === "family_confirmed" || node.relationshipClass === "family_likely";
      }
      if (shell.key === "friends") {
        return node.relationshipClass === "friend";
      }
      if (shell.key === "people") {
        return node.nodeType === "actor";
      }
      return node.nodeType === shell.entityType;
    }).length;
    return `${shell.label}: ${count}`;
  });
}

export function buildCompactThreadLabel(texts: string[], fallback = "Conversation"): { displayLabel: string; fullLabel: string } {
  const counts = new Map<string, number>();
  for (const text of texts) {
    for (const token of extractTokens(text)) {
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }
  }
  const topTokens = Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([token]) => token)
    .slice(0, 3);

  if (topTokens.length === 0) {
    const label = compactText(fallback, 28);
    return { displayLabel: label, fullLabel: label };
  }

  const displayLabel = toTitleCase(topTokens.slice(0, 2).join(" "));
  const fullLabel = toTitleCase(topTokens.join(" "));
  return {
    displayLabel: compactText(displayLabel, 28),
    fullLabel: compactText(fullLabel, 80)
  };
}

export function parseNetworkCommand(input: string): NetworkGraphCommand {
  const raw = normalizeSpace(input);
  const lower = raw.toLowerCase();
  if (!raw) return { action: "none", target: null, raw: "" };
  if (/^collapse all\b/u.test(lower)) return { action: "collapse_all", target: null, raw };
  if (/^hide weak(?: links?)?\b/u.test(lower)) return { action: "hide_weak", target: null, raw };
  if (/^show weak(?: links?)?\b/u.test(lower)) return { action: "show_weak", target: null, raw };
  const expand = lower.match(/^expand\s+(.+)$/u);
  if (expand) return { action: "expand", target: normalizeSpace(raw.slice(raw.indexOf(" ") + 1)), raw };
  const collapse = lower.match(/^collapse\s+(.+)$/u);
  if (collapse) return { action: "collapse", target: normalizeSpace(raw.slice(raw.indexOf(" ") + 1)), raw };
  const focus = lower.match(/^focus on\s+(.+)$/u);
  if (focus) return { action: "focus", target: normalizeSpace(raw.slice("focus on".length)), raw };
  return { action: "none", target: null, raw };
}

function monthBucketLabel(value: string | null): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 7);
}

function niceMonthLabel(bucket: string): string {
  const dt = new Date(`${bucket}-01T00:00:00.000Z`);
  if (Number.isNaN(dt.getTime())) return bucket;
  return dt.toLocaleString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
}

async function resolveOwnerActor(chatNamespace: string): Promise<OwnerActor | null> {
  const result = await pool.query<{ actor_id: string; canonical_name: string }>(
    `SELECT
       a.actor_id::text,
       a.canonical_name
     FROM actors a
     JOIN actor_context ac ON ac.actor_id = a.actor_id
     WHERE ac.chat_namespace = $1
       AND ac.actor_type = 'user'
     ORDER BY ac.confidence DESC, a.updated_at DESC
    LIMIT 1`,
    [chatNamespace]
  );
  return result.rows[0]
    ? {
        actorId: result.rows[0].actor_id,
        canonicalName: result.rows[0].canonical_name
      }
    : null;
}

async function listSavedViews(chatNamespace: string): Promise<NetworkSavedViewSummary[]> {
  const result = await pool.query<{ id: string; view_name: string; query_text: string | null; updated_at: string }>(
    `SELECT id::text, view_name, query_text, updated_at::text
       FROM network_saved_views
      WHERE chat_namespace = $1
      ORDER BY updated_at DESC, view_name ASC
      LIMIT 30`,
    [chatNamespace]
  );
  return result.rows.map((row) => ({
    id: row.id,
    viewName: row.view_name,
    queryText: row.query_text,
    updatedAt: row.updated_at
  }));
}

async function listSnapshots(chatNamespace: string): Promise<NetworkSnapshotSummary[]> {
  const result = await pool.query<{ id: string; snapshot_name: string; created_at: string }>(
    `SELECT id::text, snapshot_name, created_at::text
       FROM network_snapshots
      WHERE chat_namespace = $1
      ORDER BY created_at DESC, snapshot_name ASC
      LIMIT 30`,
    [chatNamespace]
  );
  return result.rows.map((row) => ({
    id: row.id,
    snapshotName: row.snapshot_name,
    createdAt: row.created_at
  }));
}

async function loadActorProfiles(chatNamespace: string): Promise<ActorProfile[]> {
  const result = await pool.query<{
    actor_id: string;
    canonical_name: string;
    actor_type: string;
    confidence: number;
    message_count: string;
    aliases: string[] | null;
  }>(
    `SELECT
       a.actor_id::text,
       a.canonical_name,
       COALESCE(
         (
           SELECT ac2.actor_type
           FROM actor_context ac2
           WHERE ac2.actor_id = a.actor_id
             AND ac2.chat_namespace = $1
           ORDER BY ac2.confidence DESC, ac2.updated_at DESC
           LIMIT 1
         ),
         'unknown'
       ) AS actor_type,
       COALESCE(
         (
           SELECT ac3.confidence
           FROM actor_context ac3
           WHERE ac3.actor_id = a.actor_id
             AND ac3.chat_namespace = $1
           ORDER BY ac3.confidence DESC, ac3.updated_at DESC
           LIMIT 1
         ),
         0.5
       )::float8 AS confidence,
       COALESCE(SUM(asp.message_count), 0)::text AS message_count,
       ARRAY_REMOVE(ARRAY_AGG(DISTINCT aa.alias), NULL) AS aliases
     FROM actors a
     LEFT JOIN actor_source_profile asp
       ON asp.actor_id = a.actor_id
      AND asp.chat_namespace = $1
     LEFT JOIN actor_aliases aa
       ON aa.actor_id = a.actor_id
      AND aa.chat_namespace = $1
     WHERE EXISTS (
       SELECT 1
       FROM actor_context ac
       WHERE ac.actor_id = a.actor_id
         AND ac.chat_namespace = $1
     )
     GROUP BY a.actor_id, a.canonical_name
     HAVING COALESCE(SUM(asp.message_count), 0) > 0
     ORDER BY COALESCE(SUM(asp.message_count), 0) DESC, a.canonical_name ASC`,
    [chatNamespace]
  );

  return result.rows.map((row) => ({
    actorId: row.actor_id,
    canonicalName: normalizeSpace(row.canonical_name),
    actorType: String(row.actor_type ?? "unknown").trim().toLowerCase(),
    confidence: clamp01(row.confidence, 0.5),
    messageCount: Number(row.message_count ?? 0) || 0,
    aliases: Array.from(
      new Set(
        [row.canonical_name, ...(Array.isArray(row.aliases) ? row.aliases : [])]
          .map((value) => normalizeSpace(String(value ?? "")))
          .filter(Boolean)
      )
    )
  }));
}

async function inferRelationshipClass(chatNamespace: string, actor: ActorProfile): Promise<RelationshipClass> {
  if (actor.actorType !== "contact" && actor.actorType !== "user") {
    return "unknown";
  }

  const patterns = Array.from(new Set(actor.aliases.map((alias) => `%${normalizeSpace(alias)}%`))).slice(0, 6);
  if (patterns.length === 0) return actor.messageCount >= 18 ? "friend" : "contact";

  const result = await pool.query<{ content_normalized: string }>(
    `SELECT c.content_normalized
       FROM canonical_messages c
      WHERE c.chat_namespace = $1
        AND c.artifact_state = 'published'
        AND c.content_normalized ILIKE ANY($2::text[])
      ORDER BY c.observed_at DESC NULLS LAST
      LIMIT 40`,
    [chatNamespace, patterns]
  );

  const familyHits = result.rows.filter((row) => {
    const hay = normalizeSpace(row.content_normalized).toLowerCase();
    return FAMILY_TERMS.some((term) => {
      const re = new RegExp(`(^|[^\\p{L}\\p{N}])${term}([^\\p{L}\\p{N}]|$)`, "iu");
      return re.test(hay);
    });
  }).length;

  if (familyHits >= 3) return "family_confirmed";
  if (familyHits >= 2) return "family_likely";
  if (actor.messageCount >= 18) return "friend";
  return "contact";
}

function mapRelationType(raw: string): NetworkEdgeType {
  const value = normalizeKey(raw);
  if (value.includes("mention")) return "mentioned";
  if (value.includes("group")) return "in_group_with";
  if (value.includes("tool")) return "uses_tool";
  return "talked_to";
}

function deriveProjectLabel(texts: string[]): string | null {
  const joined = texts.join(" ").toLowerCase();
  const hits = PROJECT_CUES.filter((cue) => joined.includes(cue));
  if (hits.length < 1) return null;
  const candidates = extractPhraseCandidates(texts, PROJECT_CUES, PROJECT_SINGLE_WORD_REJECT, {
    minWords: 2,
    maxWords: 4,
    minMentions: 1,
    maxPrefixWords: 2,
    maxSuffixWords: 1,
    allowedPrefixTokens: ALLOWED_PHRASE_CONTEXT_TOKENS,
    allowedSuffixTokens: ALLOWED_PHRASE_CONTEXT_TOKENS
  });
  return candidates[0] ?? null;
}

function looksLikeHumanNameLabel(label: string, humanNameTokens: Set<string>): boolean {
  const tokens = extractTokens(label);
  if (tokens.length === 0 || tokens.length > 3) return false;
  return tokens.every((token) => humanNameTokens.has(token));
}

function deriveFallbackProjectLabel(
  texts: string[],
  threadLabel: string,
  humanNameTokens: Set<string>,
  messageCount: number,
  startAt: string | null,
  endAt: string | null
): string | null {
  if (messageCount < 4) return null;
  const startMs = startAt ? new Date(startAt).getTime() : Number.NaN;
  const endMs = endAt ? new Date(endAt).getTime() : Number.NaN;
  const spanMs = Number.isFinite(startMs) && Number.isFinite(endMs) ? Math.max(0, endMs - startMs) : 0;
  if (spanMs < 5 * 24 * 60 * 60 * 1000) return null;
  const candidate = cleanDerivedCandidate(threadLabel, { minWords: 2, maxWords: 3, rejectSingles: PROJECT_SINGLE_WORD_REJECT });
  if (!candidate) return null;
  if (looksLikeHumanNameLabel(candidate, humanNameTokens)) return null;
  return candidate;
}

function looksLikeEvent(label: string): boolean {
  const hay = normalizeKey(label);
  return EVENT_TERMS.some((term) => hay.includes(term));
}

function looksLikeLocation(label: string): boolean {
  const hay = normalizeKey(label);
  return LOCATION_HINTS.some((term) => hay.includes(term));
}

function buildThreadClusters(messages: ThreadSeedMessage[]): ThreadCluster[] {
  const byConversation = new Map<string, ThreadSeedMessage[]>();
  for (const message of messages) {
    const key = `${message.sourceSystem}::${message.conversationId}`;
    const bucket = byConversation.get(key) ?? [];
    bucket.push(message);
    byConversation.set(key, bucket);
  }

  const clusters: ThreadCluster[] = [];
  for (const bucket of byConversation.values()) {
    bucket.sort((a, b) => {
      const aTs = a.observedAt ? new Date(a.observedAt).getTime() : 0;
      const bTs = b.observedAt ? new Date(b.observedAt).getTime() : 0;
      return aTs - bTs;
    });
    let current: ThreadSeedMessage[] = [];
    let clusterStartMs = 0;
    let previousMs = 0;
    const flush = () => {
      if (current.length < 3) {
        current = [];
        clusterStartMs = 0;
        previousMs = 0;
        return;
      }
      const actorIds = Array.from(new Set(current.map((item) => item.actorId).filter((value): value is string => Boolean(value))));
      const texts = current.map((item) => item.content).filter(Boolean);
      clusters.push({
        conversationId: current[0].conversationId,
        sourceSystem: current[0].sourceSystem,
        sourceConversationId: current[0].sourceConversationId,
        startAt: asIso(current[0].observedAt),
        endAt: asIso(current[current.length - 1].observedAt),
        actorIds,
        texts,
        messageCount: current.length
      });
      current = [];
      clusterStartMs = 0;
      previousMs = 0;
    };

    for (const message of bucket) {
      const currentMs = message.observedAt ? new Date(message.observedAt).getTime() : 0;
      if (current.length === 0) {
        current = [message];
        clusterStartMs = currentMs;
        previousMs = currentMs;
        continue;
      }
      const gap = currentMs - previousMs;
      const span = currentMs - clusterStartMs;
      if ((gap > THREAD_MAX_GAP_MS && previousMs > 0 && currentMs > 0) || (span > THREAD_MAX_SPAN_MS && clusterStartMs > 0 && currentMs > 0)) {
        flush();
        current = [message];
        clusterStartMs = currentMs;
        previousMs = currentMs;
        continue;
      }
      current.push(message);
      previousMs = currentMs;
    }
    flush();
  }
  return clusters;
}

async function upsertEntity(
  client: PoolClient,
  params: {
    chatNamespace: string;
    entityType: NetworkNodeType;
    entityKey: string;
    actorId?: string | null;
    label: string;
    displayLabel: string;
    fullLabel?: string | null;
    confidence: number;
    strength: number;
    provenanceMode: NetworkProvenanceMode;
    sourceSystem?: string | null;
    startAt?: string | null;
    endAt?: string | null;
    metadata?: Record<string, unknown>;
  }
): Promise<string> {
  const result = await client.query<{ id: string }>(
    `INSERT INTO network_entities (
       chat_namespace,
       entity_type,
       entity_key,
       actor_id,
       label,
       display_label,
       full_label,
       confidence,
       strength,
       provenance_mode,
       source_system,
       start_at,
       end_at,
       metadata
     ) VALUES (
       $1, $2, $3, $4::uuid, $5, $6, $7, $8, $9, $10, $11, $12::timestamptz, $13::timestamptz, $14::jsonb
     )
     ON CONFLICT (chat_namespace, entity_type, entity_key)
     DO UPDATE SET
       actor_id = COALESCE(EXCLUDED.actor_id, network_entities.actor_id),
       label = EXCLUDED.label,
       display_label = EXCLUDED.display_label,
       full_label = EXCLUDED.full_label,
       confidence = GREATEST(network_entities.confidence, EXCLUDED.confidence),
       strength = GREATEST(network_entities.strength, EXCLUDED.strength),
       provenance_mode = EXCLUDED.provenance_mode,
       source_system = COALESCE(EXCLUDED.source_system, network_entities.source_system),
       start_at = COALESCE(EXCLUDED.start_at, network_entities.start_at),
       end_at = COALESCE(EXCLUDED.end_at, network_entities.end_at),
       metadata = COALESCE(network_entities.metadata, '{}'::jsonb) || EXCLUDED.metadata,
       updated_at = now()
     RETURNING id::text`,
    [
      params.chatNamespace,
      params.entityType,
      params.entityKey,
      params.actorId ?? null,
      params.label,
      params.displayLabel,
      params.fullLabel ?? null,
      clamp01(params.confidence, 0.5),
      clamp01(params.strength, 0.5),
      params.provenanceMode,
      params.sourceSystem ?? null,
      params.startAt ?? null,
      params.endAt ?? null,
      JSON.stringify(params.metadata ?? {})
    ]
  );
  return result.rows[0].id;
}

async function upsertLink(
  client: PoolClient,
  params: {
    chatNamespace: string;
    sourceEntityId: string;
    targetEntityId: string;
    edgeType: NetworkEdgeType;
    confidence: number;
    strength: number;
    provenanceMode: NetworkProvenanceMode;
    firstSeenAt?: string | null;
    lastSeenAt?: string | null;
    evidenceSummary?: NetworkEvidenceSummary[];
    metadata?: Record<string, unknown>;
  }
): Promise<void> {
  await client.query(
    `INSERT INTO network_links (
       chat_namespace,
       source_entity_id,
       target_entity_id,
       edge_type,
       confidence,
       strength,
       provenance_mode,
       first_seen_at,
       last_seen_at,
       evidence_summary,
       metadata
     ) VALUES (
       $1, $2::uuid, $3::uuid, $4, $5, $6, $7, $8::timestamptz, $9::timestamptz, $10::jsonb, $11::jsonb
     )
     ON CONFLICT (chat_namespace, source_entity_id, target_entity_id, edge_type)
     DO UPDATE SET
       confidence = GREATEST(network_links.confidence, EXCLUDED.confidence),
       strength = GREATEST(network_links.strength, EXCLUDED.strength),
       provenance_mode = EXCLUDED.provenance_mode,
       first_seen_at = COALESCE(network_links.first_seen_at, EXCLUDED.first_seen_at),
       last_seen_at = COALESCE(EXCLUDED.last_seen_at, network_links.last_seen_at),
       evidence_summary = CASE
         WHEN jsonb_array_length(COALESCE(network_links.evidence_summary, '[]'::jsonb)) = 0 THEN EXCLUDED.evidence_summary
         ELSE network_links.evidence_summary
       END,
       metadata = COALESCE(network_links.metadata, '{}'::jsonb) || EXCLUDED.metadata,
       updated_at = now()`,
    [
      params.chatNamespace,
      params.sourceEntityId,
      params.targetEntityId,
      params.edgeType,
      clamp01(params.confidence, 0.5),
      clamp01(params.strength, 0.5),
      params.provenanceMode,
      params.firstSeenAt ?? null,
      params.lastSeenAt ?? null,
      JSON.stringify(params.evidenceSummary ?? []),
      JSON.stringify(params.metadata ?? {})
    ]
  );
}

export async function rebuildNetworkGraphArtifacts(params: {
  chatNamespace?: string;
  clearExisting?: boolean;
} = {}): Promise<{ ok: true; chatNamespace: string; entities: number; links: number; ownerActorId: string | null }> {
  const chatNamespace = String(params.chatNamespace ?? DEFAULT_NAMESPACE).trim() || DEFAULT_NAMESPACE;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (params.clearExisting) {
      await client.query("DELETE FROM network_links WHERE chat_namespace = $1", [chatNamespace]);
      await client.query("DELETE FROM network_entities WHERE chat_namespace = $1", [chatNamespace]);
    }

    const owner = await resolveOwnerActor(chatNamespace);
    const ownerLabels = buildOwnerLabels(owner);
    const ownerEntityId = await upsertEntity(client, {
      chatNamespace,
      entityType: "owner",
      entityKey: `owner:${owner?.actorId ?? "unknown"}`,
      actorId: owner?.actorId ?? null,
      label: ownerLabels.label,
      displayLabel: ownerLabels.displayLabel,
      fullLabel: ownerLabels.fullLabel,
      confidence: 1,
      strength: 1,
      provenanceMode: "direct",
      metadata: { shell: false, owner: true, canonicalName: owner?.canonicalName ?? ownerLabels.fullLabel }
    });

    const shellIds = new Map<string, string>();
    for (const shell of CATEGORY_SHELLS) {
      const shellId = await upsertEntity(client, {
        chatNamespace,
        entityType: shell.entityType,
        entityKey: `shell:${shell.key}`,
        label: shell.label,
        displayLabel: shell.label,
        fullLabel: shell.fullLabel,
        confidence: 1,
        strength: 1,
        provenanceMode: "derived",
        metadata: { shell: true, shellKey: shell.key }
      });
      shellIds.set(shell.key, shellId);
      await upsertLink(client, {
        chatNamespace,
        sourceEntityId: ownerEntityId,
        targetEntityId: shellId,
        edgeType: "belongs_to_category",
        confidence: 1,
        strength: 1,
        provenanceMode: "derived",
        evidenceSummary: [buildEvidenceSummary(shell.fullLabel, { kind: "category" })],
        metadata: { shell: true }
      });
    }

    const actorProfiles = await loadActorProfiles(chatNamespace);
    const maxActorMessages = actorProfiles.reduce((max, actor) => Math.max(max, actor.messageCount), 1);
    const actorIdToEntityId = new Map<string, string>();
    const aliasToActorId = new Map<string, string>();
    const relationClassByActor = new Map<string, RelationshipClass>();
    const humanNameTokens = new Set<string>(
      actorProfiles
        .filter((actor) => !NON_HUMAN_ACTOR_TYPES.has(normalizeKey(actor.actorType)))
        .flatMap((actor) => extractTokens(actor.canonicalName))
    );

    for (const actor of actorProfiles) {
      const relationClass = actor.actorId === owner?.actorId
        ? "unknown"
        : await inferRelationshipClass(chatNamespace, actor);
      relationClassByActor.set(actor.actorId, relationClass);

      const nodeType: NetworkNodeType =
        actor.actorId === owner?.actorId
          ? "owner"
          : (actor.actorType === "assistant" || actor.actorType === "system" ? "agents_tools" : "actor");

      const labels = buildActorLabels(actor.canonicalName, actor.actorType, actor.actorId === owner?.actorId);
      const entityId = actor.actorId === owner?.actorId
        ? ownerEntityId
        : await upsertEntity(client, {
            chatNamespace,
            entityType: nodeType,
            entityKey: `${nodeType}:${actor.actorId}`,
            actorId: actor.actorId,
            label: labels.label,
            displayLabel: labels.displayLabel,
            fullLabel: labels.fullLabel,
            confidence: actor.confidence,
            strength: clamp01(actor.messageCount / maxActorMessages, 0.05),
            provenanceMode: "direct",
            metadata: {
              actorType: actor.actorType,
              aliases: actor.aliases,
              messageCount: actor.messageCount,
              relationshipClass: relationClass,
              canonicalName: actor.canonicalName
            }
          });
      actorIdToEntityId.set(actor.actorId, entityId);
      for (const alias of actor.aliases) {
        aliasToActorId.set(normalizeKey(alias), actor.actorId);
      }

      if (actor.actorId !== owner?.actorId) {
        const primaryShellKey = nodeType === "agents_tools" ? "agents-tools" : "people";
        const categoryLabel = primaryShellKey === "agents-tools" ? "Agents & Tools" : "People";
        await upsertLink(client, {
          chatNamespace,
          sourceEntityId: shellIds.get(primaryShellKey)!,
          targetEntityId: entityId,
          edgeType: "belongs_to_category",
          confidence: actor.confidence,
          strength: clamp01(actor.messageCount / maxActorMessages, 0.05),
          provenanceMode: "derived",
          evidenceSummary: [buildEvidenceSummary(`${labels.label} belongs to ${categoryLabel} in your canonical network graph.`, { kind: "actor" })],
          metadata: { relationshipClass: relationClass }
        });
        if (relationClass === "family_confirmed" || relationClass === "family_likely") {
          await upsertLink(client, {
            chatNamespace,
            sourceEntityId: shellIds.get("family")!,
            targetEntityId: entityId,
            edgeType: "belongs_to_category",
            confidence: relationClass === "family_confirmed" ? 0.9 : 0.7,
            strength: clamp01(actor.messageCount / maxActorMessages, 0.05),
            provenanceMode: "derived",
            evidenceSummary: [buildEvidenceSummary(`${actor.canonicalName} has repeated family evidence.`, { kind: "family" })],
            metadata: { relationshipClass: relationClass }
          });
        } else if (relationClass === "friend") {
          await upsertLink(client, {
            chatNamespace,
            sourceEntityId: shellIds.get("friends")!,
            targetEntityId: entityId,
            edgeType: "belongs_to_category",
            confidence: 0.7,
            strength: clamp01(actor.messageCount / maxActorMessages, 0.05),
            provenanceMode: "derived",
            evidenceSummary: [buildEvidenceSummary(`${actor.canonicalName} has repeated human interaction.`, { kind: "friend" })],
            metadata: { relationshipClass: relationClass }
          });
        }
      }
    }

    const relationshipRows = await client.query<{
      subject_name: string;
      object_name: string;
      relation_type: string;
      weight: number;
      confidence: number;
      evidence: unknown;
    }>(
      `SELECT subject_name, object_name, relation_type, weight, confidence, evidence
         FROM relationship_candidates
        WHERE chat_namespace = $1
          AND artifact_state = 'published'
        ORDER BY weight DESC, confidence DESC`,
      [chatNamespace]
    );

    for (const row of relationshipRows.rows) {
      const subjectActorId = aliasToActorId.get(normalizeKey(row.subject_name));
      const objectActorId = aliasToActorId.get(normalizeKey(row.object_name));
      if (!subjectActorId || !objectActorId || subjectActorId === objectActorId) continue;
      const sourceEntityId = actorIdToEntityId.get(subjectActorId);
      const targetEntityId = actorIdToEntityId.get(objectActorId);
      if (!sourceEntityId || !targetEntityId) continue;
      await upsertLink(client, {
        chatNamespace,
        sourceEntityId,
        targetEntityId,
        edgeType: mapRelationType(row.relation_type),
        confidence: clamp01(row.confidence, 0.5),
        strength: clamp01(Number(row.weight ?? 0) / 10, 0.1),
        provenanceMode: "derived",
        evidenceSummary: summarizeEvidence(row.evidence),
        metadata: {
          rawRelationType: row.relation_type,
          subjectRelationshipClass: relationClassByActor.get(subjectActorId) ?? "unknown",
          objectRelationshipClass: relationClassByActor.get(objectActorId) ?? "unknown"
        }
      });
    }

    const conversationRows = await client.query<ConversationAggregate>(
      `SELECT
         c.conversation_id AS "conversationId",
         c.source_system AS "sourceSystem",
         NULLIF(MAX(COALESCE(c.source_conversation_id, '')), '') AS "sourceConversationId",
         NULLIF(MAX(COALESCE(c.metadata->>'conversationLabel', '')), '') AS "conversationLabel",
         COUNT(*)::int AS "messageCount",
         ARRAY_REMOVE(ARRAY_AGG(DISTINCT c.actor_id::text), NULL) AS "participantIds",
         MIN(c.observed_at)::text AS "startAt",
         MAX(c.observed_at)::text AS "endAt"
       FROM canonical_messages c
       WHERE c.chat_namespace = $1
         AND c.artifact_state = 'published'
         AND c.conversation_id <> ''
       GROUP BY c.conversation_id, c.source_system
       HAVING COUNT(*) >= 3`,
      [chatNamespace]
    );

    const groupEntityIdsByConversation = new Map<string, string>();
    for (const row of conversationRows.rows) {
      const participantIds = Array.isArray(row.participantIds) ? row.participantIds.filter(Boolean) : [];
      if (participantIds.length < 3) continue;
      const baseLabel = cleanConversationLabel(row.sourceConversationId || row.conversationId, row.conversationLabel) || row.conversationId;
      const entityId = await upsertEntity(client, {
        chatNamespace,
        entityType: "group_chat",
        entityKey: `group:${row.conversationId}`,
        label: baseLabel,
        displayLabel: compactText(baseLabel, 36),
        fullLabel: baseLabel,
        confidence: 0.85,
        strength: clamp01(row.messageCount / 120, 0.1),
        provenanceMode: "direct",
        sourceSystem: row.sourceSystem,
        startAt: row.startAt,
        endAt: row.endAt,
        metadata: {
          shell: false,
          participantCount: participantIds.length,
          messageCount: row.messageCount
        }
      });
      groupEntityIdsByConversation.set(row.conversationId, entityId);

      await upsertLink(client, {
        chatNamespace,
        sourceEntityId: shellIds.get("groups")!,
        targetEntityId: entityId,
        edgeType: "belongs_to_category",
        confidence: 0.85,
        strength: clamp01(row.messageCount / 120, 0.1),
        provenanceMode: "derived",
        evidenceSummary: [buildEvidenceSummary(`${baseLabel} is a recurring group conversation.`, { kind: "group" })],
        metadata: { participantCount: participantIds.length }
      });

      if (owner?.actorId && participantIds.includes(owner.actorId)) {
        await upsertLink(client, {
          chatNamespace,
          sourceEntityId: ownerEntityId,
          targetEntityId: entityId,
          edgeType: "participated_in",
          confidence: 0.95,
          strength: clamp01(row.messageCount / 120, 0.1),
          provenanceMode: "direct",
          firstSeenAt: row.startAt,
          lastSeenAt: row.endAt,
          evidenceSummary: [buildEvidenceSummary(`You participated in ${baseLabel}.`, { kind: "participation", conversationLabel: baseLabel, sourceSystem: row.sourceSystem })]
        });
      }

      for (const participantId of participantIds.slice(0, 20)) {
        const actorEntityId = actorIdToEntityId.get(participantId);
        if (!actorEntityId) continue;
        await upsertLink(client, {
          chatNamespace,
          sourceEntityId: actorEntityId,
          targetEntityId: entityId,
          edgeType: "participated_in",
          confidence: 0.8,
          strength: clamp01(row.messageCount / 120, 0.1),
          provenanceMode: "direct",
          firstSeenAt: row.startAt,
          lastSeenAt: row.endAt,
          evidenceSummary: [buildEvidenceSummary(`${baseLabel} includes this actor.`, { kind: "participation", conversationLabel: baseLabel, sourceSystem: row.sourceSystem })]
        });
      }

      for (let index = 0; index < participantIds.length; index += 1) {
        for (let inner = index + 1; inner < participantIds.length; inner += 1) {
          const leftId = actorIdToEntityId.get(participantIds[index]);
          const rightId = actorIdToEntityId.get(participantIds[inner]);
          if (!leftId || !rightId) continue;
          await upsertLink(client, {
            chatNamespace,
            sourceEntityId: leftId,
            targetEntityId: rightId,
            edgeType: "in_group_with",
            confidence: 0.75,
            strength: clamp01(row.messageCount / 160, 0.08),
            provenanceMode: "derived",
            firstSeenAt: row.startAt,
            lastSeenAt: row.endAt,
            evidenceSummary: [buildEvidenceSummary(`${baseLabel} contains both actors.`, {
              kind: "co_presence",
              conversationLabel: baseLabel,
              sourceSystem: row.sourceSystem
            })]
          });
        }
      }
    }

    const threadMessages = await client.query<ThreadSeedMessage>(
      `SELECT
         c.conversation_id AS "conversationId",
         c.source_system AS "sourceSystem",
         NULLIF(c.source_conversation_id, '') AS "sourceConversationId",
         c.actor_id::text AS "actorId",
         c.observed_at::text AS "observedAt",
         c.content_normalized AS "content"
       FROM canonical_messages c
       WHERE c.chat_namespace = $1
         AND c.artifact_state = 'published'
         AND c.conversation_id <> ''
         AND length(trim(c.content_normalized)) >= 10
       ORDER BY c.conversation_id, c.observed_at ASC NULLS LAST`,
      [chatNamespace]
    );
    const clusters = buildThreadClusters(threadMessages.rows);
    const maxClusterMessages = clusters.reduce((max, cluster) => Math.max(max, cluster.messageCount), 1);

    for (const cluster of clusters.slice(0, 350)) {
      const label = buildCompactThreadLabel(cluster.texts, cluster.sourceConversationId || cluster.conversationId || "Conversation");
      const entityId = await upsertEntity(client, {
        chatNamespace,
        entityType: "thread",
        entityKey: `thread:${cluster.conversationId}:${cluster.startAt ?? "na"}`,
        label: label.fullLabel,
        displayLabel: label.displayLabel,
        fullLabel: label.fullLabel,
        confidence: 0.7,
        strength: clamp01(cluster.messageCount / maxClusterMessages, 0.08),
        provenanceMode: "derived",
        sourceSystem: cluster.sourceSystem,
        startAt: cluster.startAt,
        endAt: cluster.endAt,
        metadata: {
          shell: false,
          participantCount: cluster.actorIds.length,
          messageCount: cluster.messageCount,
          conversationId: cluster.conversationId,
          sourceConversationId: cluster.sourceConversationId
        }
      });

      await upsertLink(client, {
        chatNamespace,
        sourceEntityId: shellIds.get("threads")!,
        targetEntityId: entityId,
        edgeType: "belongs_to_category",
        confidence: 0.7,
        strength: clamp01(cluster.messageCount / maxClusterMessages, 0.08),
        provenanceMode: "derived",
        evidenceSummary: [buildEvidenceSummary(`Thread cluster ${label.fullLabel}.`, {
          kind: "thread",
          conversationLabel: cluster.sourceConversationId ?? cluster.conversationId,
          sourceSystem: cluster.sourceSystem
        })],
        metadata: { conversationId: cluster.conversationId }
      });

      const groupId = groupEntityIdsByConversation.get(cluster.conversationId);
      if (groupId) {
        await upsertLink(client, {
          chatNamespace,
          sourceEntityId: groupId,
          targetEntityId: entityId,
          edgeType: "shared_thread",
          confidence: 0.75,
          strength: clamp01(cluster.messageCount / maxClusterMessages, 0.08),
          provenanceMode: "derived",
          firstSeenAt: cluster.startAt,
          lastSeenAt: cluster.endAt,
          evidenceSummary: [buildEvidenceSummary(`Thread ${label.displayLabel} belongs to ${cluster.sourceConversationId ?? cluster.conversationId}.`, {
            kind: "thread",
            conversationLabel: cluster.sourceConversationId ?? cluster.conversationId,
            sourceSystem: cluster.sourceSystem
          })]
        });
      }

      for (const actorId of cluster.actorIds.slice(0, 12)) {
        const actorEntityId = actorIdToEntityId.get(actorId);
        if (!actorEntityId) continue;
        await upsertLink(client, {
          chatNamespace,
          sourceEntityId: actorEntityId,
          targetEntityId: entityId,
          edgeType: "shared_thread",
          confidence: 0.72,
          strength: clamp01(cluster.messageCount / maxClusterMessages, 0.08),
          provenanceMode: "derived",
          firstSeenAt: cluster.startAt,
          lastSeenAt: cluster.endAt,
          evidenceSummary: [buildEvidenceSummary(`${label.displayLabel} includes this actor.`, {
            kind: "thread",
            conversationLabel: cluster.sourceConversationId ?? cluster.conversationId,
            sourceSystem: cluster.sourceSystem
          })]
        });
      }

      const topicLabel = buildCompactThreadLabel(cluster.texts, "Topic");
      const topicEntityId = await upsertEntity(client, {
        chatNamespace,
        entityType: "topic",
        entityKey: `topic:${normalizeKey(topicLabel.displayLabel)}`,
        label: topicLabel.fullLabel,
        displayLabel: topicLabel.displayLabel,
        fullLabel: topicLabel.fullLabel,
        confidence: 0.6,
        strength: clamp01(cluster.messageCount / maxClusterMessages, 0.06),
        provenanceMode: "derived",
        metadata: { shell: false }
      });
      await upsertLink(client, {
        chatNamespace,
        sourceEntityId: shellIds.get("topics")!,
        targetEntityId: topicEntityId,
        edgeType: "belongs_to_category",
        confidence: 0.6,
        strength: clamp01(cluster.messageCount / maxClusterMessages, 0.06),
        provenanceMode: "derived",
        evidenceSummary: [buildEvidenceSummary(`${topicLabel.fullLabel} is a recurring topic.`, { kind: "topic" })]
      });
      await upsertLink(client, {
        chatNamespace,
        sourceEntityId: entityId,
        targetEntityId: topicEntityId,
        edgeType: "discussed_topic",
        confidence: 0.6,
        strength: clamp01(cluster.messageCount / maxClusterMessages, 0.06),
        provenanceMode: "derived",
        evidenceSummary: [buildEvidenceSummary(`${topicLabel.fullLabel} summarizes this thread.`, { kind: "topic" })]
      });

      const bucket = monthBucketLabel(cluster.startAt);
      if (bucket) {
        const timeEntityId = await upsertEntity(client, {
          chatNamespace,
          entityType: "time_bucket",
          entityKey: `time:${bucket}`,
          label: niceMonthLabel(bucket),
          displayLabel: niceMonthLabel(bucket),
          fullLabel: niceMonthLabel(bucket),
          confidence: 1,
          strength: 0.6,
          provenanceMode: "derived",
          metadata: { shell: false, bucket }
        });
        await upsertLink(client, {
          chatNamespace,
          sourceEntityId: shellIds.get("time")!,
          targetEntityId: timeEntityId,
          edgeType: "belongs_to_category",
          confidence: 1,
          strength: 0.6,
          provenanceMode: "derived",
          evidenceSummary: [buildEvidenceSummary(`Time bucket ${niceMonthLabel(bucket)}.`, { kind: "time" })]
        });
        await upsertLink(client, {
          chatNamespace,
          sourceEntityId: entityId,
          targetEntityId: timeEntityId,
          edgeType: "active_in_time",
          confidence: 1,
          strength: 0.6,
          provenanceMode: "derived",
          firstSeenAt: cluster.startAt,
          lastSeenAt: cluster.endAt,
          evidenceSummary: [buildEvidenceSummary(`${label.displayLabel} was active in ${niceMonthLabel(bucket)}.`, { kind: "time" })]
        });
      }

      const projectLabel = deriveProjectLabel(cluster.texts)
        ?? deriveFallbackProjectLabel(cluster.texts, label.displayLabel, humanNameTokens, cluster.messageCount, cluster.startAt, cluster.endAt);
      if (projectLabel) {
        const projectEntityId = await upsertEntity(client, {
          chatNamespace,
          entityType: "project",
          entityKey: `project:${normalizeKey(projectLabel)}`,
          label: projectLabel,
          displayLabel: projectLabel,
          fullLabel: projectLabel,
          confidence: 0.58,
          strength: clamp01(cluster.messageCount / maxClusterMessages, 0.06),
          provenanceMode: "derived",
          metadata: { shell: false }
        });
        await upsertLink(client, {
          chatNamespace,
          sourceEntityId: shellIds.get("projects")!,
          targetEntityId: projectEntityId,
          edgeType: "belongs_to_category",
          confidence: 0.58,
          strength: clamp01(cluster.messageCount / maxClusterMessages, 0.06),
          provenanceMode: "derived",
          evidenceSummary: [buildEvidenceSummary(`${projectLabel} was inferred as an ongoing effort.`, { kind: "project" })]
        });
        await upsertLink(client, {
          chatNamespace,
          sourceEntityId: entityId,
          targetEntityId: projectEntityId,
          edgeType: "related_to_project",
          confidence: 0.58,
          strength: clamp01(cluster.messageCount / maxClusterMessages, 0.06),
          provenanceMode: "derived",
          evidenceSummary: [buildEvidenceSummary(`${label.displayLabel} contains repeated project-like planning language.`, { kind: "project" })]
        });
      }

      for (const locationLabel of extractLocationLabels(cluster.texts)) {
        const locationId = await upsertEntity(client, {
          chatNamespace,
          entityType: "location",
          entityKey: `location:${normalizeKey(locationLabel)}`,
          label: locationLabel,
          displayLabel: compactText(locationLabel, 36),
          fullLabel: locationLabel,
          confidence: 0.58,
          strength: clamp01(cluster.messageCount / maxClusterMessages, 0.05),
          provenanceMode: "derived",
          sourceSystem: cluster.sourceSystem,
          startAt: cluster.startAt,
          endAt: cluster.endAt,
          metadata: { shell: false, conversationId: cluster.conversationId }
        });
        await upsertLink(client, {
          chatNamespace,
          sourceEntityId: shellIds.get("places")!,
          targetEntityId: locationId,
          edgeType: "belongs_to_category",
          confidence: 0.58,
          strength: clamp01(cluster.messageCount / maxClusterMessages, 0.05),
          provenanceMode: "derived",
          evidenceSummary: [buildEvidenceSummary(`${locationLabel} appeared repeatedly in conversation context.`, {
            kind: "location",
            conversationLabel: cleanConversationLabel(cluster.sourceConversationId ?? cluster.conversationId),
            sourceSystem: cluster.sourceSystem
          })]
        });
        await upsertLink(client, {
          chatNamespace,
          sourceEntityId: entityId,
          targetEntityId: locationId,
          edgeType: "happened_at",
          confidence: 0.58,
          strength: clamp01(cluster.messageCount / maxClusterMessages, 0.05),
          provenanceMode: "derived",
          firstSeenAt: cluster.startAt,
          lastSeenAt: cluster.endAt,
          evidenceSummary: [buildEvidenceSummary(`${label.displayLabel} references ${locationLabel}.`, {
            kind: "location",
            conversationLabel: cleanConversationLabel(cluster.sourceConversationId ?? cluster.conversationId),
            sourceSystem: cluster.sourceSystem
          })]
        });
      }

      for (const eventLabel of extractEventLabels(cluster.texts)) {
        const eventId = await upsertEntity(client, {
          chatNamespace,
          entityType: "event",
          entityKey: `event:${normalizeKey(eventLabel)}`,
          label: eventLabel,
          displayLabel: compactText(eventLabel, 36),
          fullLabel: eventLabel,
          confidence: 0.56,
          strength: clamp01(cluster.messageCount / maxClusterMessages, 0.05),
          provenanceMode: "derived",
          sourceSystem: cluster.sourceSystem,
          startAt: cluster.startAt,
          endAt: cluster.endAt,
          metadata: { shell: false, conversationId: cluster.conversationId }
        });
        await upsertLink(client, {
          chatNamespace,
          sourceEntityId: shellIds.get("events")!,
          targetEntityId: eventId,
          edgeType: "belongs_to_category",
          confidence: 0.56,
          strength: clamp01(cluster.messageCount / maxClusterMessages, 0.05),
          provenanceMode: "derived",
          evidenceSummary: [buildEvidenceSummary(`${eventLabel} appeared repeatedly in conversation context.`, {
            kind: "event",
            conversationLabel: cleanConversationLabel(cluster.sourceConversationId ?? cluster.conversationId),
            sourceSystem: cluster.sourceSystem
          })]
        });
        await upsertLink(client, {
          chatNamespace,
          sourceEntityId: entityId,
          targetEntityId: eventId,
          edgeType: "happened_at",
          confidence: 0.56,
          strength: clamp01(cluster.messageCount / maxClusterMessages, 0.05),
          provenanceMode: "derived",
          firstSeenAt: cluster.startAt,
          lastSeenAt: cluster.endAt,
          evidenceSummary: [buildEvidenceSummary(`${label.displayLabel} references ${eventLabel}.`, {
            kind: "event",
            conversationLabel: cleanConversationLabel(cluster.sourceConversationId ?? cluster.conversationId),
            sourceSystem: cluster.sourceSystem
          })]
        });
      }
    }

    const factSeeds = await client.query<FactSeed>(
      `SELECT
         id::text AS "factId",
         fact_type AS "factType",
         domain,
         value_text AS "valueText",
         confidence,
         source_timestamp::text AS "sourceTimestamp",
         value_json AS metadata
       FROM fact_candidates
       WHERE chat_namespace = $1
         AND artifact_state = 'published'
         AND confidence >= 0.65
       ORDER BY confidence DESC, source_timestamp DESC NULLS LAST
       LIMIT 250`,
      [chatNamespace]
    );

    for (const fact of factSeeds.rows) {
      const lowerLabel = normalizeKey(fact.valueText);
      if (!lowerLabel) continue;
      if (looksLikeLocation(fact.valueText) || normalizeKey(fact.factType).includes("location")) {
        const locationId = await upsertEntity(client, {
          chatNamespace,
          entityType: "location",
          entityKey: `location:${lowerLabel}`,
          label: fact.valueText,
          displayLabel: compactText(fact.valueText, 28),
          fullLabel: fact.valueText,
          confidence: fact.confidence,
          strength: 0.45,
          provenanceMode: "direct",
          startAt: fact.sourceTimestamp,
          metadata: { shell: false, factId: fact.factId, domain: fact.domain, factType: fact.factType }
        });
        await upsertLink(client, {
          chatNamespace,
          sourceEntityId: shellIds.get("places")!,
          targetEntityId: locationId,
          edgeType: "belongs_to_category",
          confidence: fact.confidence,
          strength: 0.45,
          provenanceMode: "direct",
          evidenceSummary: [buildEvidenceSummary(fact.valueText, { kind: "location", sourceTimestamp: fact.sourceTimestamp })]
        });
      }
      if (looksLikeEvent(fact.valueText) || normalizeKey(fact.factType).includes("event")) {
        const eventId = await upsertEntity(client, {
          chatNamespace,
          entityType: "event",
          entityKey: `event:${lowerLabel}`,
          label: fact.valueText,
          displayLabel: compactText(fact.valueText, 28),
          fullLabel: fact.valueText,
          confidence: fact.confidence,
          strength: 0.45,
          provenanceMode: "direct",
          startAt: fact.sourceTimestamp,
          metadata: { shell: false, factId: fact.factId, domain: fact.domain, factType: fact.factType }
        });
        await upsertLink(client, {
          chatNamespace,
          sourceEntityId: shellIds.get("events")!,
          targetEntityId: eventId,
          edgeType: "belongs_to_category",
          confidence: fact.confidence,
          strength: 0.45,
          provenanceMode: "direct",
          evidenceSummary: [buildEvidenceSummary(fact.valueText, { kind: "event", sourceTimestamp: fact.sourceTimestamp })]
        });
      }
      if (normalizeKey(fact.factType).includes("project") || normalizeKey(fact.domain).includes("project")) {
        const projectId = await upsertEntity(client, {
          chatNamespace,
          entityType: "project",
          entityKey: `project:${lowerLabel}`,
          label: fact.valueText,
          displayLabel: compactText(fact.valueText, 28),
          fullLabel: fact.valueText,
          confidence: fact.confidence,
          strength: 0.4,
          provenanceMode: "direct",
          startAt: fact.sourceTimestamp,
          metadata: { shell: false, factId: fact.factId, domain: fact.domain, factType: fact.factType }
        });
        await upsertLink(client, {
          chatNamespace,
          sourceEntityId: shellIds.get("projects")!,
          targetEntityId: projectId,
          edgeType: "belongs_to_category",
          confidence: fact.confidence,
          strength: 0.4,
          provenanceMode: "direct",
          evidenceSummary: [buildEvidenceSummary(fact.valueText, { kind: "project", sourceTimestamp: fact.sourceTimestamp })]
        });
      }
    }

    const entityCountResult = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM network_entities WHERE chat_namespace = $1`,
      [chatNamespace]
    );
    const linkCountResult = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM network_links WHERE chat_namespace = $1`,
      [chatNamespace]
    );

    await client.query("COMMIT");
    return {
      ok: true,
      chatNamespace,
      entities: Number(entityCountResult.rows[0]?.count ?? 0),
      links: Number(linkCountResult.rows[0]?.count ?? 0),
      ownerActorId: owner?.actorId ?? null
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

type EffectiveGraphState = {
  chatNamespace: string;
  limit: number;
  query: string;
  command: NetworkGraphCommand;
  sceneMode: NetworkSceneMode;
  sceneSeed: AnswerSceneSeed | null;
  selectedNodeId: string | null;
  selectedEdgeId: string | null;
  expandedNodeIds: Set<string>;
  collapsedNodeIds: Set<string>;
  overflowState: Record<string, number>;
  filters: NetworkGraphFilterState;
  confidenceMode: NetworkConfidenceMode;
  startDate: string | null;
  endDate: string | null;
  autoplayTickMode: NetworkTickMode;
  layoutMode: NetworkLayoutMode;
  savedViewId: string | null;
  snapshotId: string | null;
};

function buildDefaultShellGraph(owner: OwnerActor | null, layoutMode: NetworkLayoutMode): NetworkGraphResponse["graph"] {
  const ownerLabels = buildOwnerLabels(owner);
  const ownerNode: NetworkGraphNode = {
    id: `owner:${owner?.actorId ?? "unknown"}`,
    entityKey: `owner:${owner?.actorId ?? "unknown"}`,
    nodeType: "owner",
    label: ownerLabels.label,
    displayLabel: ownerLabels.displayLabel,
    fullLabel: ownerLabels.fullLabel,
    confidence: 1,
    certainty: 1,
    strength: 1,
    provenanceMode: "direct",
    evidenceSummary: [],
    actorId: owner?.actorId ?? null,
    metadata: { owner: true, canonicalName: owner?.canonicalName ?? ownerLabels.fullLabel }
  };

  const shellNodes: NetworkGraphNode[] = CATEGORY_SHELLS.map((shell) => ({
    id: `shell:${shell.key}`,
    entityKey: `shell:${shell.key}`,
    nodeType: shell.entityType,
    label: shell.label,
    displayLabel: shell.label,
    fullLabel: shell.fullLabel,
    confidence: 1,
    certainty: 1,
    strength: 1,
    provenanceMode: "derived",
    evidenceSummary: [buildEvidenceSummary(shell.fullLabel, { kind: "category" })],
    isShell: true,
    metadata: { shell: true, shellKey: shell.key }
  }));

  const edges: NetworkGraphEdge[] = shellNodes.map((node) => ({
    id: `edge:${ownerNode.id}:${node.id}:belongs_to_category`,
    source: ownerNode.id,
    target: node.id,
    edgeType: "belongs_to_category",
    label: "category",
    confidence: 1,
    certainty: 1,
    strength: 1,
    provenanceMode: "derived",
    evidenceSummary: [buildEvidenceSummary(String(node.fullLabel ?? node.label), { kind: "category" })]
  }));

  return {
    id: "network_shell",
    title: "Network",
    layoutMode,
    selectedNodeId: ownerNode.id,
    nodes: [ownerNode, ...shellNodes],
    edges
  };
}

async function loadSnapshotGraph(chatNamespace: string, snapshotId: string): Promise<SaveGraphPayload | null> {
  const result = await pool.query<{ graph_json: SaveGraphPayload }>(
    `SELECT graph_json
       FROM network_snapshots
      WHERE chat_namespace = $1
        AND id = $2::uuid
      LIMIT 1`,
    [chatNamespace, snapshotId]
  );
  return result.rows[0]?.graph_json ?? null;
}

async function loadSavedViewConfig(chatNamespace: string, viewId: string): Promise<Record<string, unknown> | null> {
  const result = await pool.query<{ config: Record<string, unknown> }>(
    `SELECT config
       FROM network_saved_views
      WHERE chat_namespace = $1
        AND id = $2::uuid
      LIMIT 1`,
    [chatNamespace, viewId]
  );
  return result.rows[0]?.config ?? null;
}

function toEffectiveState(params: NetworkGraphRequest, savedConfig: Record<string, unknown> | null): EffectiveGraphState {
  const merged = { ...(savedConfig ?? {}), ...(params ?? {}) } as Record<string, unknown>;
  const query = normalizeSpace(String(merged.query ?? ""));
  const explicitCommand = normalizeSpace(String(merged.command ?? ""));
  return {
    chatNamespace: String(merged.chatNamespace ?? DEFAULT_NAMESPACE).trim() || DEFAULT_NAMESPACE,
    limit: Math.max(12, Math.min(500, Number(merged.limit ?? DEFAULT_LIMIT) || DEFAULT_LIMIT)),
    query,
    command: parseNetworkCommand(explicitCommand || query),
    sceneMode: merged.sceneMode === "answer_scene" ? "answer_scene" : "default",
    sceneSeed: merged.sceneSeed && typeof merged.sceneSeed === "object" ? (merged.sceneSeed as AnswerSceneSeed) : null,
    selectedNodeId: normalizeSpace(String(merged.selectedNodeId ?? "")) || null,
    selectedEdgeId: normalizeSpace(String(merged.selectedEdgeId ?? "")) || null,
    expandedNodeIds: new Set(Array.isArray(merged.expandedNodeIds) ? merged.expandedNodeIds.map((item) => String(item)) : []),
    collapsedNodeIds: new Set(Array.isArray(merged.collapsedNodeIds) ? merged.collapsedNodeIds.map((item) => String(item)) : []),
    overflowState: Object.fromEntries(
      Object.entries(merged.overflowState && typeof merged.overflowState === "object" ? merged.overflowState as Record<string, unknown> : {})
        .map(([key, value]) => [String(key), Math.max(0, Math.min(6, Number(value) || 0))])
        .filter(([, value]) => Number.isFinite(value))
    ),
    filters: (merged.filters && typeof merged.filters === "object" ? merged.filters : {}) as NetworkGraphFilterState,
    confidenceMode: merged.confidenceMode === "include_weak" ? "include_weak" : "strong_only",
    startDate: merged.startDate ? asIso(String(merged.startDate)) : null,
    endDate: merged.endDate ? asIso(String(merged.endDate)) : null,
    autoplayTickMode: merged.autoplayTickMode === "day" || merged.autoplayTickMode === "month" ? merged.autoplayTickMode : "week",
    layoutMode: NETWORK_LAYOUTS.includes(merged.layoutMode as NetworkLayoutMode) ? (merged.layoutMode as NetworkLayoutMode) : "radial",
    savedViewId: normalizeSpace(String(merged.savedViewId ?? "")) || null,
    snapshotId: normalizeSpace(String(merged.snapshotId ?? "")) || null
  };
}

function entityToNode(row: PersistedEntityRow): NetworkGraphNode {
  const metadata = row.metadata ?? {};
  const relationClass = typeof metadata.relationshipClass === "string" ? (metadata.relationshipClass as RelationshipClass) : null;
  const evidenceSummary = summarizeEvidence(metadata.evidenceSummary);
  return {
    id: row.id,
    entityKey: row.entity_key,
    nodeType: row.entity_type,
    label: row.label,
    displayLabel: row.display_label,
    fullLabel: row.full_label,
    confidence: clamp01(row.confidence, 0.5),
    certainty: clamp01(row.confidence, 0.5),
    strength: clamp01(row.strength, 0.5),
    provenanceMode: row.provenance_mode,
    evidenceSummary,
    isShell: Boolean(metadata.shell),
    actorId: row.actor_id,
    sourceSystem: row.source_system,
    relationshipClass: relationClass,
    metadata: {
      ...metadata,
      startAt: row.start_at,
      endAt: row.end_at
    }
  };
}

function linkToEdge(row: PersistedLinkRow, source: string, target: string): NetworkGraphEdge {
  return {
    id: row.id,
    source,
    target,
    edgeType: row.edge_type,
    label: row.edge_type.replaceAll("_", " "),
    confidence: clamp01(row.confidence, 0.5),
    certainty: clamp01(row.confidence, 0.5),
    strength: clamp01(row.strength, 0.5),
    provenanceMode: row.provenance_mode,
    evidenceSummary: summarizeEvidence(row.evidence_summary),
    metadata: row.metadata ?? {}
  };
}

function withinRange(row: { start_at?: string | null; end_at?: string | null; metadata?: Record<string, unknown> }, startDate: string | null, endDate: string | null): boolean {
  if (!startDate && !endDate) return true;
  const start = startDate ? new Date(startDate).getTime() : Number.NEGATIVE_INFINITY;
  const end = endDate ? new Date(endDate).getTime() : Number.POSITIVE_INFINITY;
  const rowStart = row.start_at ? new Date(row.start_at).getTime() : Number.NaN;
  const rowEnd = row.end_at ? new Date(row.end_at).getTime() : rowStart;
  const bucket = typeof row.metadata?.bucket === "string" ? new Date(`${row.metadata.bucket}-01T00:00:00.000Z`).getTime() : Number.NaN;
  const probeStart = Number.isFinite(rowStart) ? rowStart : bucket;
  const probeEnd = Number.isFinite(rowEnd) ? rowEnd : probeStart;
  if (!Number.isFinite(probeStart) && !Number.isFinite(probeEnd)) return true;
  return probeStart <= end && probeEnd >= start;
}

async function loadPersistedGraphRows(state: EffectiveGraphState): Promise<{
  entities: PersistedEntityRow[];
  links: PersistedLinkRow[];
}> {
  const confidenceClause = state.confidenceMode === "include_weak" ? "" : "AND confidence >= 0.55";
  const entityResult = await pool.query<PersistedEntityRow>(
    `SELECT
       id::text,
       entity_key,
       entity_type,
       actor_id::text,
       label,
       display_label,
       full_label,
       confidence,
       strength,
       provenance_mode,
       source_system,
       metadata,
       start_at::text,
       end_at::text
     FROM network_entities
     WHERE chat_namespace = $1
       ${confidenceClause}
     ORDER BY strength DESC, confidence DESC, updated_at DESC
     LIMIT 5000`,
    [state.chatNamespace]
  );

  const linkResult = await pool.query<PersistedLinkRow>(
    `SELECT
       id::text,
       source_entity_id::text,
       target_entity_id::text,
       edge_type,
       confidence,
       strength,
       provenance_mode,
       evidence_summary,
       metadata,
       first_seen_at::text,
       last_seen_at::text
     FROM network_links
     WHERE chat_namespace = $1
       ${confidenceClause}
     ORDER BY strength DESC, confidence DESC, updated_at DESC
     LIMIT 8000`,
    [state.chatNamespace]
  );

  const entities = entityResult.rows.filter((row) => withinRange({ start_at: row.start_at, end_at: row.end_at, metadata: row.metadata }, state.startDate, state.endDate));
  const links = linkResult.rows.filter((row) => withinRange({ start_at: row.first_seen_at, end_at: row.last_seen_at, metadata: row.metadata }, state.startDate, state.endDate));
  return { entities, links };
}

function searchMatchingNodes(nodes: NetworkGraphNode[], query: string): NetworkGraphNode[] {
  const tokens = extractTokens(query);
  if (tokens.length === 0) return [];
  return nodes
    .map((node) => {
      const hay = `${node.label} ${node.displayLabel} ${node.fullLabel ?? ""} ${JSON.stringify(node.metadata ?? {})}`.toLowerCase();
      const hits = tokens.reduce((score, token) => score + (hay.includes(token) ? 1 : 0), 0);
      return { node, hits };
    })
    .filter((item) => item.hits > 0)
    .sort((a, b) => b.hits - a.hits || b.node.strength - a.node.strength)
    .map((item) => item.node);
}

function scoreNeighbor(node: NetworkGraphNode, edge: NetworkGraphEdge): number {
  return edge.strength * 0.65 + edge.certainty * 0.35 + node.strength * 0.2;
}

function buildAnswerSummary(query: string | null, seedNodes: NetworkGraphNode[]): string {
  const cleanedQuery = normalizeSpace(query ?? "");
  if (cleanedQuery) {
    if (seedNodes.length === 0) {
      return `I didn’t find a strong network match for "${cleanedQuery}" yet.`;
    }
    if (seedNodes.length === 1) {
      return `I found one strong match for "${cleanedQuery}": ${seedNodes[0].displayLabel}.`;
    }
    return `I found ${seedNodes.length} relevant matches for "${cleanedQuery}".`;
  }
  if (seedNodes.length === 0) {
    return "Showing your default network shells.";
  }
  if (seedNodes.length === 1) {
    return `Showing ${seedNodes[0].displayLabel} and its strongest related nodes.`;
  }
  return `Showing ${seedNodes.length} related network nodes.`;
}

function buildDetailPanel(node: NetworkGraphNode | undefined, edges: NetworkGraphEdge[], nodesById: Map<string, NetworkGraphNode>): NetworkDetailPanel | null {
  if (!node) return null;
  if (node.nodeType === "owner") {
    return {
      title: node.displayLabel,
      subtitle: "You",
      sections: [
        {
          title: "Why this exists",
          body: "You are the root of this network. Expand category shells or ask a question from the left rail to reveal more structure.",
          bullets: [
            "The default view stays compact so the graph remains readable.",
            "Saved views can reopen this graph from current data or as a frozen snapshot."
          ]
        },
        {
          title: "Available categories",
          body: "These counts reflect the current evidence-backed network graph.",
          bullets: buildCategoryCountBullets(nodesById)
        }
      ]
    };
  }
  if (node.nodeType === "overflow") {
    const hiddenCount = Number(node.metadata?.hiddenCount ?? 0) || 0;
    const overflowForLabel = String(node.metadata?.overflowForLabel ?? "this cluster");
    return {
      title: node.displayLabel,
      subtitle: "More nodes",
      sections: [
        {
          title: "Why this exists",
          body: `This count bubble keeps the graph readable by batching additional nodes for ${overflowForLabel}.`,
          bullets: [
            `Hidden nodes available: ${hiddenCount}`,
            "Select this bubble to expand the next batch inline."
          ]
        }
      ]
    };
  }
  if (node.isShell) {
    const relatedLabels = edges
      .filter((edge) => edge.source === node.id || edge.target === node.id)
      .map((edge) => {
        const otherId = edge.source === node.id ? edge.target : edge.source;
        return nodesById.get(otherId);
      })
      .filter((item): item is NetworkGraphNode => item != null && !item.isShell && item.nodeType !== "owner" && item.nodeType !== "overflow")
      .sort((a, b) => b.strength - a.strength)
      .slice(0, 8)
      .map((item) => item?.displayLabel ?? "")
      .filter(Boolean);
    return {
      title: node.displayLabel,
      subtitle: "Category shell",
      sections: [
        {
          title: "Why this exists",
          body: String(node.fullLabel ?? node.label),
          bullets: relatedLabels.length > 0
            ? relatedLabels.map((label) => `Contains ${label}`)
            : ["Expand this category to reveal the strongest related nodes."]
        }
      ]
    };
  }

  const relatedEdges = edges
    .filter((edge) => edge.source === node.id || edge.target === node.id)
    .sort((a, b) => b.strength - a.strength)
    .slice(0, 8);
  const whyBullets = relatedEdges.map((edge) => {
    const otherId = edge.source === node.id ? edge.target : edge.source;
    const other = nodesById.get(otherId);
    return `${edge.label} ${other ? other.displayLabel : otherId} (${Math.round(edge.strength * 100)} strength / ${Math.round(edge.certainty * 100)} certainty)`;
  });
  const evidenceBullets = relatedEdges
    .flatMap((edge) => edge.evidenceSummary.slice(0, 2).map((item) => compactText(item.excerpt, 120)))
    .slice(0, 6);

  const sections: NetworkDetailPanelSection[] = [
    {
      title: "Why this exists",
      body: `This ${node.nodeType.replaceAll("_", " ")} is present because it is grounded in canonical actors, published artifacts, or repeated derived structure.`,
      bullets: whyBullets.length > 0 ? whyBullets : ["No strong relationships are loaded yet for this selection."]
    },
    {
      title: "Strength vs certainty",
      body: `${Math.round(node.strength * 100)} strength reflects network centrality or recurrence. ${Math.round(node.certainty * 100)} certainty reflects how directly grounded the node is.`,
      bullets: []
    }
  ];
  if (evidenceBullets.length > 0) {
    sections.push({
      title: "Evidence",
      body: "Top evidence supporting this node or its strongest visible links.",
      bullets: evidenceBullets
    });
  }

  return {
    title: node.displayLabel,
    subtitle: `${node.nodeType.replaceAll("_", " ")}${node.relationshipClass ? ` - ${node.relationshipClass.replaceAll("_", " ")}` : ""}`,
    sections
  };
}

function buildCommandSuggestions(selected: NetworkGraphNode | undefined): string[] {
  const base = ["collapse all", "focus on family", "focus on groups", "show weak links", "hide weak links"];
  if (!selected) return base;
  if (selected.nodeType === "owner") {
    return ["expand People", "expand Family", "expand Groups", ...base];
  }
  if (selected.nodeType === "actor") {
    return [
      `expand ${selected.displayLabel}`,
      `focus on ${selected.displayLabel}`,
      `collapse ${selected.displayLabel}`,
      `show shared friends of ${selected.displayLabel}`,
      ...base
    ];
  }
  return [`expand ${selected.displayLabel}`, `collapse ${selected.displayLabel}`, ...base];
}

function resolveNodeByTarget(nodes: NetworkGraphNode[], target: string | null): NetworkGraphNode | undefined {
  if (!target) return undefined;
  const normalizedTarget = normalizeKey(target);
  return nodes.find((node) => normalizeKey(node.id) === normalizedTarget)
    ?? nodes.find((node) => normalizeKey(node.displayLabel) === normalizedTarget)
    ?? nodes.find((node) => normalizeKey(node.label) === normalizedTarget)
    ?? nodes.find((node) => normalizeKey(String(node.metadata?.shellKey ?? "")) === normalizedTarget);
}

function sceneNodeId(kind: string, raw: string): string {
  return `scene:${kind}:${normalizeKey(raw) || "unknown"}`;
}

function evidenceToSummary(evidence: V2EvidenceRef, kind = "evidence"): NetworkEvidenceSummary {
  return buildEvidenceSummary(evidence.excerpt, {
    kind,
    sourceSystem: evidence.sourceSystem,
    sourceTimestamp: evidence.sourceTimestamp,
    actorName: evidence.entityLabel ?? null,
    conversationLabel: evidence.sourceConversationLabel ?? null
  });
}

function asSceneEvidenceRefs(value: unknown): V2EvidenceRef[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (item && typeof item === "object" ? item as V2EvidenceRef : null))
    .filter((item): item is V2EvidenceRef => Boolean(item?.memoryId));
}

async function buildEvidencePanelFromSelection(params: {
  title: string;
  subtitle: string;
  evidenceRefs: V2EvidenceRef[];
  chatNamespace: string;
}): Promise<NetworkEvidencePanel | null> {
  const refs = params.evidenceRefs.filter((item) => item && item.memoryId).slice(0, 6);
  if (refs.length === 0) return null;
  const items: NetworkEvidencePanelItem[] = [];
  for (const ref of refs) {
    let contextBefore: string[] = [];
    let contextAfter: string[] = [];
    if (ref.sourceConversationId && (ref.sourceMessageId || ref.canonicalId || ref.memoryId)) {
      const windowPayload = await fetchContextWindow({
        chatNamespace: params.chatNamespace,
        conversationId: ref.sourceConversationId,
        anchorMessageId: String(ref.sourceMessageId ?? ref.canonicalId ?? ref.memoryId),
        beforeN: 2,
        afterN: 2
      });
      const contextItems = windowPayload.items;
      const anchorIndex = contextItems.findIndex((item) =>
        item.memoryId === ref.memoryId
        || String(item.sourceMessageId ?? "") === String(ref.sourceMessageId ?? "")
        || String(item.canonicalId ?? "") === String(ref.canonicalId ?? "")
      );
      if (anchorIndex >= 0) {
        contextBefore = contextItems.slice(Math.max(0, anchorIndex - 2), anchorIndex).map((item) => compactText(item.excerpt, 220));
        contextAfter = contextItems.slice(anchorIndex + 1, anchorIndex + 3).map((item) => compactText(item.excerpt, 220));
      }
    }
    items.push({
      title: ref.entityLabel ?? params.title,
      kind: ref.contextRole ?? "evidence",
      excerpt: compactText(ref.excerpt, 360),
      contextBefore,
      contextAfter,
      sourceSystem: ref.sourceSystem,
      sourceTimestamp: ref.sourceTimestamp,
      actorName: ref.entityLabel ?? null,
      conversationLabel: ref.sourceConversationLabel ?? null,
      sourceMessageId: ref.sourceMessageId ?? null,
      memoryId: ref.memoryId
    });
  }
  return {
    title: params.title,
    subtitle: params.subtitle,
    items
  };
}

function buildSceneActionSuggestions(seed: AnswerSceneSeed): string[] {
  const base = ["Open evidence", "See related chat"];
  if (seed.sceneShape === "latest_mention" || seed.sceneShape === "earliest_mention") {
    return [...base, "See earlier mentions"];
  }
  return base;
}

async function buildAnswerSceneResponse(params: {
  state: EffectiveGraphState;
  owner: OwnerActor | null;
  savedViews: NetworkSavedViewSummary[];
  snapshots: NetworkSnapshotSummary[];
}): Promise<NetworkGraphResponse> {
  const { state, owner, savedViews, snapshots } = params;
  const seed = state.sceneSeed;
  const ownerLabels = buildOwnerLabels(owner);
  const ownerNode: NetworkGraphNode = {
    id: `owner:${owner?.actorId ?? "unknown"}`,
    entityKey: `owner:${owner?.actorId ?? "unknown"}`,
    nodeType: "owner",
    label: ownerLabels.label,
    displayLabel: ownerLabels.displayLabel,
    fullLabel: ownerLabels.fullLabel,
    confidence: 1,
    certainty: 1,
    strength: 1,
    provenanceMode: "direct",
    evidenceSummary: seed?.primaryEvidence?.slice(0, 2).map((item) => evidenceToSummary(item, "answer")) ?? [],
    actorId: owner?.actorId ?? null,
    metadata: {
      owner: true,
      sceneEvidenceRefs: seed?.primaryEvidence ?? []
    }
  };

  if (!seed) {
    return {
      ok: true,
      sceneMode: "answer_scene",
      graph: {
        id: "network_answer_scene",
        title: "Answer Scene",
        layoutMode: state.layoutMode,
        selectedNodeId: ownerNode.id,
        selectedEdgeId: null,
        nodes: [ownerNode],
        edges: []
      },
      answerSummary: "No answer scene is available yet.",
      sceneActions: [],
      commandSuggestions: buildCommandSuggestions(ownerNode),
      detailPanel: buildDetailPanel(ownerNode, [], new Map([[ownerNode.id, ownerNode]])),
      evidencePanel: null,
      savedViews,
      snapshots,
      weakHiddenCount: 0
    };
  }

  const nodes: NetworkGraphNode[] = [ownerNode];
  const edges: NetworkGraphEdge[] = [];
  const nodesById = new Map<string, NetworkGraphNode>([[ownerNode.id, ownerNode]]);

  const addNode = (node: NetworkGraphNode): void => {
    if (!nodesById.has(node.id)) {
      nodesById.set(node.id, node);
      nodes.push(node);
    }
  };
  const addEdge = (edge: NetworkGraphEdge): void => {
    if (!edges.some((item) => item.id === edge.id)) edges.push(edge);
  };

  const ownerActorId = owner?.actorId ?? null;
  const actorRoleById = new Map<string, string | null>(seed.orderedEntities.map((item) => [String(item.actorId ?? ""), item.role ?? null]));
  const actorLabelById = new Map<string, string>(seed.orderedEntities.map((item) => [String(item.actorId ?? ""), item.label]));
  const sceneActors = seed.actorIds.map((actorId, index) => ({
    actorId,
    label: actorLabelById.get(actorId) ?? seed.actorLabels[index] ?? `Actor ${index + 1}`,
    role: actorRoleById.get(actorId) ?? null
  }));
  const primaryEvidence = Array.isArray(seed.primaryEvidence) ? seed.primaryEvidence : [];

  for (const actor of sceneActors) {
    if (!actor.actorId || actor.actorId === ownerActorId) continue;
    const actorEvidence = primaryEvidence.filter((item) => String(item.actorId ?? "") === actor.actorId);
    const actorNode: NetworkGraphNode = {
      id: sceneNodeId("actor", actor.actorId || actor.label),
      entityKey: sceneNodeId("actor", actor.actorId || actor.label),
      nodeType: "actor",
      label: actor.label,
      displayLabel: actor.label,
      fullLabel: actor.label,
      confidence: 0.9,
      certainty: 0.9,
      strength: 0.8,
      provenanceMode: "direct",
      evidenceSummary: actorEvidence.slice(0, 3).map((item) => evidenceToSummary(item, "actor")),
      actorId: actor.actorId,
      metadata: { sceneEvidenceRefs: actorEvidence, role: actor.role }
    };
    addNode(actorNode);
    addEdge({
      id: `edge:${ownerNode.id}:${actorNode.id}:talked_to`,
      source: ownerNode.id,
      target: actorNode.id,
      edgeType: "talked_to",
      label: "talked to",
      confidence: 0.8,
      certainty: 0.8,
      strength: 0.7,
      provenanceMode: "derived",
      evidenceSummary: actorEvidence.slice(0, 2).map((item) => evidenceToSummary(item, "actor")),
      metadata: { sceneEvidenceRefs: actorEvidence }
    });
  }

  const conversationEntries = seed.conversationIds.map((conversationId, index) => ({
    conversationId,
    label: seed.conversationLabels[index] ?? seed.conversationLabels[0] ?? conversationId
  }));
  for (const entry of conversationEntries.slice(0, 4)) {
    const conversationEvidence = primaryEvidence.filter((item) => String(item.sourceConversationId ?? "") === entry.conversationId);
    const groupNode: NetworkGraphNode = {
      id: sceneNodeId("conversation", entry.conversationId),
      entityKey: sceneNodeId("conversation", entry.conversationId),
      nodeType: "group_chat",
      label: entry.label,
      displayLabel: compactText(entry.label, 36),
      fullLabel: entry.label,
      confidence: 0.9,
      certainty: 0.9,
      strength: 0.78,
      provenanceMode: "direct",
      evidenceSummary: conversationEvidence.slice(0, 3).map((item) => evidenceToSummary(item, "conversation")),
      metadata: {
        conversationId: entry.conversationId,
        sceneEvidenceRefs: conversationEvidence
      }
    };
    addNode(groupNode);
    addEdge({
      id: `edge:${ownerNode.id}:${groupNode.id}:participated_in`,
      source: ownerNode.id,
      target: groupNode.id,
      edgeType: "participated_in",
      label: "participated in",
      confidence: 0.9,
      certainty: 0.9,
      strength: 0.7,
      provenanceMode: "derived",
      evidenceSummary: conversationEvidence.slice(0, 2).map((item) => evidenceToSummary(item, "conversation")),
      metadata: { sceneEvidenceRefs: conversationEvidence }
    });
    for (const actor of sceneActors) {
      if (!actor.actorId || actor.actorId === ownerActorId) continue;
      const actorNodeId = sceneNodeId("actor", actor.actorId || actor.label);
      if (!nodesById.has(actorNodeId)) continue;
      addEdge({
        id: `edge:${actorNodeId}:${groupNode.id}:in_group_with`,
        source: actorNodeId,
        target: groupNode.id,
        edgeType: "in_group_with",
        label: "in group with",
        confidence: 0.78,
        certainty: 0.78,
        strength: 0.62,
        provenanceMode: "derived",
        evidenceSummary: conversationEvidence.slice(0, 2).map((item) => evidenceToSummary(item, "conversation")),
        metadata: { sceneEvidenceRefs: conversationEvidence }
      });
    }
  }

  for (const evidence of primaryEvidence.slice(0, 4)) {
    const threadLabel = buildCompactThreadLabel([evidence.excerpt], evidence.sourceConversationLabel || evidence.entityLabel || "Message");
    const threadNode: NetworkGraphNode = {
      id: sceneNodeId("thread", evidence.memoryId),
      entityKey: sceneNodeId("thread", evidence.memoryId),
      nodeType: "thread",
      label: threadLabel.fullLabel,
      displayLabel: threadLabel.displayLabel,
      fullLabel: threadLabel.fullLabel,
      confidence: clamp01(evidence.similarity, 0.7),
      certainty: clamp01(evidence.similarity, 0.7),
      strength: clamp01(evidence.similarity, 0.68),
      provenanceMode: "direct",
      evidenceSummary: [evidenceToSummary(evidence, "thread")],
      metadata: {
        sourceMessageId: evidence.sourceMessageId ?? null,
        conversationId: evidence.sourceConversationId ?? null,
        sceneEvidenceRefs: [evidence]
      }
    };
    addNode(threadNode);
    const matchingConversation = conversationEntries.find((entry) => entry.conversationId === String(evidence.sourceConversationId ?? ""));
    if (matchingConversation) {
      addEdge({
        id: `edge:${sceneNodeId("conversation", matchingConversation.conversationId)}:${threadNode.id}:shared_thread`,
        source: sceneNodeId("conversation", matchingConversation.conversationId),
        target: threadNode.id,
        edgeType: "shared_thread",
        label: "shared thread",
        confidence: 0.88,
        certainty: 0.88,
        strength: 0.72,
        provenanceMode: "direct",
        evidenceSummary: [evidenceToSummary(evidence, "thread")],
        metadata: { sceneEvidenceRefs: [evidence] }
      });
    } else {
      addEdge({
        id: `edge:${ownerNode.id}:${threadNode.id}:shared_thread`,
        source: ownerNode.id,
        target: threadNode.id,
        edgeType: "shared_thread",
        label: "shared thread",
        confidence: 0.75,
        certainty: 0.75,
        strength: 0.6,
        provenanceMode: "derived",
        evidenceSummary: [evidenceToSummary(evidence, "thread")],
        metadata: { sceneEvidenceRefs: [evidence] }
      });
    }
  }

  const monthBucket = seed.timeAnchor ? monthBucketLabel(seed.timeAnchor) : null;
  if (monthBucket) {
    const timeEvidence = primaryEvidence.filter((item) => item.sourceTimestamp);
    const timeNode: NetworkGraphNode = {
      id: sceneNodeId("time", monthBucket),
      entityKey: sceneNodeId("time", monthBucket),
      nodeType: "time_bucket",
      label: niceMonthLabel(monthBucket),
      displayLabel: niceMonthLabel(monthBucket),
      fullLabel: niceMonthLabel(monthBucket),
      confidence: 1,
      certainty: 1,
      strength: 0.58,
      provenanceMode: "derived",
      evidenceSummary: timeEvidence.slice(0, 2).map((item) => evidenceToSummary(item, "time")),
      metadata: { bucket: monthBucket, sceneEvidenceRefs: timeEvidence }
    };
    addNode(timeNode);
    for (const node of nodes.filter((item) => item.nodeType === "thread")) {
      addEdge({
        id: `edge:${node.id}:${timeNode.id}:active_in_time`,
        source: node.id,
        target: timeNode.id,
        edgeType: "active_in_time",
        label: "active in",
        confidence: 0.82,
        certainty: 0.82,
        strength: 0.55,
        provenanceMode: "derived",
        evidenceSummary: asSceneEvidenceRefs(node.metadata?.sceneEvidenceRefs).slice(0, 2).map((item) => evidenceToSummary(item, "time")),
        metadata: { sceneEvidenceRefs: node.metadata?.sceneEvidenceRefs ?? [] }
      });
    }
  }

  for (const cue of seed.topicCues.slice(0, 2)) {
    const topicNode: NetworkGraphNode = {
      id: sceneNodeId("topic", cue),
      entityKey: sceneNodeId("topic", cue),
      nodeType: "topic",
      label: cue,
      displayLabel: compactText(cue, 24),
      fullLabel: cue,
      confidence: 0.72,
      certainty: 0.72,
      strength: 0.52,
      provenanceMode: "derived",
      evidenceSummary: primaryEvidence.slice(0, 2).map((item) => evidenceToSummary(item, "topic")),
      metadata: { sceneEvidenceRefs: primaryEvidence.slice(0, 2) }
    };
    addNode(topicNode);
    for (const node of nodes.filter((item) => item.nodeType === "thread")) {
      addEdge({
        id: `edge:${node.id}:${topicNode.id}:discussed_topic`,
        source: node.id,
        target: topicNode.id,
        edgeType: "discussed_topic",
        label: "discussed topic",
        confidence: 0.68,
        certainty: 0.68,
        strength: 0.48,
        provenanceMode: "derived",
        evidenceSummary: asSceneEvidenceRefs(node.metadata?.sceneEvidenceRefs).slice(0, 2).map((item) => evidenceToSummary(item, "topic")),
        metadata: { sceneEvidenceRefs: node.metadata?.sceneEvidenceRefs ?? [] }
      });
    }
  }

  const selectedNode =
    (state.selectedNodeId ? nodesById.get(state.selectedNodeId) : null)
    ?? nodes.find((item) => item.nodeType === "thread")
    ?? nodes.find((item) => item.nodeType === "group_chat")
    ?? nodes.find((item) => item.nodeType === "actor")
    ?? ownerNode;
  const selectedEdge = state.selectedEdgeId ? edges.find((item) => item.id === state.selectedEdgeId) ?? null : null;
  const hasExplicitSelection = Boolean(state.selectedNodeId || state.selectedEdgeId);
  const evidenceRefs = selectedEdge
    ? asSceneEvidenceRefs(selectedEdge.metadata?.sceneEvidenceRefs)
    : hasExplicitSelection
      ? asSceneEvidenceRefs(selectedNode?.metadata?.sceneEvidenceRefs)
      : primaryEvidence;
  const evidencePanel = await buildEvidencePanelFromSelection({
    title: selectedEdge
      ? selectedEdge.label
      : hasExplicitSelection
        ? String(selectedNode?.displayLabel ?? selectedNode?.label ?? "Evidence")
        : String(seed.answerSummary || seed.answerText || "Answer evidence"),
    subtitle: selectedEdge
      ? "Supporting evidence for the selected connection."
      : hasExplicitSelection
        ? `Supporting evidence for ${String(selectedNode?.displayLabel ?? selectedNode?.label ?? "this selection")}.`
        : "Supporting evidence for the current answer.",
    evidenceRefs,
    chatNamespace: state.chatNamespace
  });

  return {
    ok: true,
    sceneMode: "answer_scene",
    graph: {
      id: "network_answer_scene",
      title: "Answer Scene",
      layoutMode: state.layoutMode,
      selectedNodeId: selectedNode?.id ?? null,
      selectedEdgeId: selectedEdge?.id ?? null,
      nodes,
      edges
    },
    answerSummary: seed.answerSummary || seed.answerText,
    sceneActions: buildSceneActionSuggestions(seed),
    commandSuggestions: buildCommandSuggestions(selectedNode),
    detailPanel: buildDetailPanel(selectedNode ?? undefined, edges, nodesById),
    evidencePanel,
    savedViews,
    snapshots,
    weakHiddenCount: 0
  };
}

export async function searchNetworkGraph(params: NetworkGraphRequest): Promise<NetworkGraphResponse> {
  const savedConfig = params.savedViewId ? await loadSavedViewConfig(String(params.chatNamespace ?? DEFAULT_NAMESPACE), params.savedViewId) : null;
  const state = toEffectiveState(params, savedConfig);
  const savedViews = await listSavedViews(state.chatNamespace);
  const snapshots = await listSnapshots(state.chatNamespace);

  if (state.snapshotId) {
    const snapshot = await loadSnapshotGraph(state.chatNamespace, state.snapshotId);
    if (snapshot) {
      return {
        ok: true,
        sceneMode: snapshot.sceneMode ?? "default",
        graph: snapshot.graph,
        answerSummary: snapshot.answerSummary,
        sceneActions: snapshot.sceneActions ?? [],
        detailPanel: snapshot.detailPanel,
        evidencePanel: snapshot.evidencePanel ?? null,
        commandSuggestions: snapshot.commandSuggestions,
        savedViews,
        snapshots,
        weakHiddenCount: snapshot.weakHiddenCount
      };
    }
  }

  const owner = await resolveOwnerActor(state.chatNamespace);
  if (state.sceneMode === "answer_scene" && state.sceneSeed) {
    return buildAnswerSceneResponse({
      state,
      owner,
      savedViews,
      snapshots
    });
  }
  const fallbackGraph = buildDefaultShellGraph(owner, state.layoutMode);
  const persisted = await loadPersistedGraphRows(state);
  if (persisted.entities.length === 0) {
    return {
      ok: true,
      sceneMode: "default",
      graph: fallbackGraph,
      answerSummary: "Showing the default network shells. Run the network backfill to populate the richer graph.",
      sceneActions: [],
      detailPanel: buildDetailPanel(fallbackGraph.nodes[0], fallbackGraph.edges, new Map(fallbackGraph.nodes.map((node) => [node.id, node]))),
      evidencePanel: null,
      commandSuggestions: buildCommandSuggestions(fallbackGraph.nodes[0]),
      savedViews,
      snapshots,
      weakHiddenCount: 0
    };
  }

  const allNodes = persisted.entities.map(entityToNode);
  const nodesById = new Map(allNodes.map((node) => [node.id, node]));
  const allEdges = persisted.links
    .filter((row) => nodesById.has(row.source_entity_id) && nodesById.has(row.target_entity_id))
    .map((row) => linkToEdge(row, row.source_entity_id, row.target_entity_id));

  const ownerNode = allNodes.find((node) => node.nodeType === "owner") ?? fallbackGraph.nodes[0];
  const shellNodes = allNodes.filter((node) => node.isShell);

  if (state.command.action === "collapse_all") {
    const shellOnlyIds = new Set<string>([ownerNode.id, ...shellNodes.map((node) => node.id)]);
    const shellOnlyNodes = [ownerNode, ...shellNodes];
    const shellOnlyEdges = allEdges.filter((edge) => shellOnlyIds.has(edge.source) && shellOnlyIds.has(edge.target));
    return {
      ok: true,
      sceneMode: "default",
      graph: {
        id: "network_graph",
        title: "Network",
        layoutMode: state.layoutMode,
        selectedNodeId: ownerNode.id,
        selectedEdgeId: null,
        nodes: shellOnlyNodes,
        edges: shellOnlyEdges
      },
      answerSummary: "Collapsed the graph back to your category shells.",
      sceneActions: [],
      detailPanel: buildDetailPanel(ownerNode, shellOnlyEdges, new Map(allNodes.map((node) => [node.id, node]))),
      evidencePanel: null,
      commandSuggestions: buildCommandSuggestions(ownerNode),
      savedViews,
      snapshots,
      weakHiddenCount: Math.max(0, allNodes.length - shellOnlyNodes.length)
    };
  }

  let focusNode = state.selectedNodeId ? nodesById.get(state.selectedNodeId) : undefined;
  const commandTargetNode = resolveNodeByTarget(allNodes, state.command.target);
  if (!focusNode && commandTargetNode) {
    focusNode = commandTargetNode;
  }

  const queryMatches = state.query && state.command.action === "none"
    ? searchMatchingNodes(allNodes.filter((node) => !node.isShell), state.query).slice(0, 6)
    : [];

  const seedNodes: NetworkGraphNode[] = [];
  if (focusNode && focusNode.id !== ownerNode.id) seedNodes.push(focusNode);
  for (const node of queryMatches) {
    if (!seedNodes.some((item) => item.id === node.id)) {
      seedNodes.push(node);
    }
  }
  for (const expandedId of state.expandedNodeIds) {
    const node = nodesById.get(expandedId);
    if (node && !seedNodes.some((item) => item.id === node.id)) {
      seedNodes.push(node);
    }
  }

  if (state.command.action === "focus" && state.command.target) {
    const targetLower = normalizeKey(state.command.target);
    const matchingShell = shellNodes.find((node) => normalizeKey(node.displayLabel) === targetLower || normalizeKey(String(node.metadata?.shellKey ?? "")) === targetLower);
    if (matchingShell) {
      seedNodes.length = 0;
      seedNodes.push(matchingShell);
    }
  }

  const includedNodeIds = new Set<string>(seedNodes.length === 0 ? [ownerNode.id, ...shellNodes.map((node) => node.id)] : [ownerNode.id]);

  const adjacency = new Map<string, NetworkGraphEdge[]>();
  for (const edge of allEdges) {
    const left = adjacency.get(edge.source) ?? [];
    left.push(edge);
    adjacency.set(edge.source, left);
    const right = adjacency.get(edge.target) ?? [];
    right.push(edge);
    adjacency.set(edge.target, right);
  }

  const overflowNodes: NetworkGraphNode[] = [];
  const overflowEdges: NetworkGraphEdge[] = [];

  for (const seedNode of seedNodes) {
    includedNodeIds.add(seedNode.id);
    const edges = (adjacency.get(seedNode.id) ?? [])
      .filter((edge) => !state.collapsedNodeIds.has(edge.source) && !state.collapsedNodeIds.has(edge.target))
      .sort((a, b) => {
        const aOther = nodesById.get(a.source === seedNode.id ? a.target : a.source);
        const bOther = nodesById.get(b.source === seedNode.id ? b.target : b.source);
        return scoreNeighbor(bOther ?? seedNode, b) - scoreNeighbor(aOther ?? seedNode, a);
      });

    const baseBucketLimits: Partial<Record<NetworkNodeType, number>> =
      seedNode.isShell
        ? { actor: 14, group_chat: 10, thread: 8, topic: 6, project: 6, location: 6, event: 6, time_bucket: 6, agents_tools: 6 }
        : { actor: 6, group_chat: 5, thread: 5, topic: 4, project: 4, location: 3, event: 3, time_bucket: 3, agents_tools: 3 };
    const overflowPage = Math.max(0, Number(state.overflowState[seedNode.id] ?? 0) || 0);
    const perBucketLimits: Partial<Record<NetworkNodeType, number>> = overflowPage > 0
      ? Object.fromEntries(
          Object.entries(baseBucketLimits).map(([key]) => [key, Number.MAX_SAFE_INTEGER])
        ) as Partial<Record<NetworkNodeType, number>>
      : Object.fromEntries(
          Object.entries(baseBucketLimits).map(([key, value]) => [key, Number(value) || 0])
        ) as Partial<Record<NetworkNodeType, number>>;
    const usedPerType = new Map<NetworkNodeType, number>();
    const hiddenNodeIds = new Set<string>();

    for (const edge of edges) {
      const otherId = edge.source === seedNode.id ? edge.target : edge.source;
      const otherNode = nodesById.get(otherId);
      if (!otherNode) continue;
      const currentCount = usedPerType.get(otherNode.nodeType) ?? 0;
      const maxAllowed = perBucketLimits[otherNode.nodeType] ?? 4;
      if (!otherNode.isShell && currentCount >= maxAllowed) {
        hiddenNodeIds.add(otherId);
        continue;
      }
      includedNodeIds.add(otherId);
      usedPerType.set(otherNode.nodeType, currentCount + 1);
    }

    if (hiddenNodeIds.size === 1) {
      includedNodeIds.add(Array.from(hiddenNodeIds)[0]);
    } else if (hiddenNodeIds.size > 1) {
      const overflowNodeId = `overflow:${seedNode.id}`;
      const hiddenCount = hiddenNodeIds.size;
      overflowNodes.push({
        id: overflowNodeId,
        entityKey: overflowNodeId,
        nodeType: "overflow",
        label: `+${hiddenCount} more`,
        displayLabel: `+${hiddenCount}`,
        fullLabel: `Show ${hiddenCount} more nodes for ${seedNode.displayLabel}`,
        confidence: 1,
        certainty: 1,
        strength: Math.min(0.82, 0.28 + hiddenCount / 80),
        provenanceMode: "derived",
        evidenceSummary: [buildEvidenceSummary(`Show ${hiddenCount} more nodes for ${seedNode.displayLabel}.`, { kind: "overflow" })],
        metadata: {
          overflowForNodeId: seedNode.id,
          overflowForLabel: seedNode.displayLabel,
          hiddenCount,
          nextPage: overflowPage + 1
        }
      });
      overflowEdges.push({
        id: `edge:${seedNode.id}:${overflowNodeId}:overflow`,
        source: seedNode.id,
        target: overflowNodeId,
        edgeType: "overflow",
        label: "more",
        confidence: 1,
        certainty: 1,
        strength: 0.4,
        provenanceMode: "derived",
        evidenceSummary: [buildEvidenceSummary(`Additional nodes are available for ${seedNode.displayLabel}.`, { kind: "overflow" })],
        metadata: {
          overflowForNodeId: seedNode.id,
          hiddenCount
        }
      });
      includedNodeIds.add(overflowNodeId);
    }
  }

  const graphNodes = [...allNodes, ...overflowNodes];
  const graphEdges = [...allEdges, ...overflowEdges];
  const graphNodesById = new Map(graphNodes.map((node) => [node.id, node]));

  let visibleNodes = graphNodes.filter((node) => includedNodeIds.has(node.id));
  if (state.filters.nodeTypes && state.filters.nodeTypes.length > 0) {
    const allowed = new Set(state.filters.nodeTypes);
    visibleNodes = visibleNodes.filter((node) => node.nodeType === "owner" || node.nodeType === "overflow" || allowed.has(node.nodeType) || node.isShell);
  }
  if (state.filters.relationshipClasses && state.filters.relationshipClasses.length > 0) {
    const allowed = new Set(state.filters.relationshipClasses);
    visibleNodes = visibleNodes.filter((node) => !node.relationshipClass || allowed.has(node.relationshipClass));
  }

  const visibleNodeIds = new Set(visibleNodes.map((node) => node.id));
  let visibleEdges = graphEdges.filter((edge) => visibleNodeIds.has(edge.source) && visibleNodeIds.has(edge.target));
  if (state.filters.edgeTypes && state.filters.edgeTypes.length > 0) {
    const allowedEdges = new Set(state.filters.edgeTypes);
    visibleEdges = visibleEdges.filter((edge) => allowedEdges.has(edge.edgeType));
  }

  const weakHiddenCount = Math.max(
    0,
    allNodes.length - visibleNodes.filter((node) => node.nodeType !== "overflow").length
  );
  visibleNodes = visibleNodes
    .sort((a, b) =>
      Number(b.nodeType === "owner") - Number(a.nodeType === "owner")
      || Number(b.isShell) - Number(a.isShell)
      || Number(b.nodeType === "overflow") - Number(a.nodeType === "overflow")
      || b.strength - a.strength
    )
    .slice(0, state.limit);
  const finalNodeIds = new Set(visibleNodes.map((node) => node.id));
  visibleEdges = visibleEdges.filter((edge) => finalNodeIds.has(edge.source) && finalNodeIds.has(edge.target));

  const selectedNode = focusNode
    ?? visibleNodes.find((node) => node.id === state.selectedNodeId)
    ?? visibleNodes.find((node) => !node.isShell && node.nodeType !== "overflow")
    ?? ownerNode;
  const answerSummary = buildAnswerSummary(state.query, seedNodes);

  return {
    ok: true,
    sceneMode: "default",
    graph: {
      id: "network_graph",
      title: "Network",
      layoutMode: state.layoutMode,
      selectedNodeId: selectedNode?.id ?? null,
      selectedEdgeId: null,
      nodes: visibleNodes,
      edges: visibleEdges
    },
    answerSummary,
    sceneActions: [],
    commandSuggestions: buildCommandSuggestions(selectedNode),
    detailPanel: buildDetailPanel(selectedNode, visibleEdges, graphNodesById),
    evidencePanel: null,
    savedViews,
    snapshots,
    weakHiddenCount
  };
}

export async function saveNetworkView(params: {
  chatNamespace?: string;
  viewName: string;
  queryText?: string | null;
  ownerActorId?: string | null;
  config: Record<string, unknown>;
}): Promise<{ ok: true; id: string }> {
  const chatNamespace = String(params.chatNamespace ?? DEFAULT_NAMESPACE).trim() || DEFAULT_NAMESPACE;
  const result = await pool.query<{ id: string }>(
    `INSERT INTO network_saved_views (
       chat_namespace,
       view_name,
       owner_actor_id,
       query_text,
       config
     ) VALUES ($1, $2, $3::uuid, $4, $5::jsonb)
     ON CONFLICT (chat_namespace, view_name)
     DO UPDATE SET
       owner_actor_id = COALESCE(EXCLUDED.owner_actor_id, network_saved_views.owner_actor_id),
       query_text = EXCLUDED.query_text,
       config = EXCLUDED.config,
       updated_at = now()
     RETURNING id::text`,
    [
      chatNamespace,
      normalizeSpace(params.viewName),
      params.ownerActorId ?? null,
      params.queryText ?? null,
      JSON.stringify(params.config ?? {})
    ]
  );
  return { ok: true, id: result.rows[0].id };
}

export async function saveNetworkSnapshot(params: {
  chatNamespace?: string;
  snapshotName: string;
  ownerActorId?: string | null;
  graph: SaveGraphPayload;
}): Promise<{ ok: true; id: string }> {
  const chatNamespace = String(params.chatNamespace ?? DEFAULT_NAMESPACE).trim() || DEFAULT_NAMESPACE;
  const result = await pool.query<{ id: string }>(
    `INSERT INTO network_snapshots (
       chat_namespace,
       snapshot_name,
       owner_actor_id,
       graph_json
     ) VALUES ($1, $2, $3::uuid, $4::jsonb)
     ON CONFLICT (chat_namespace, snapshot_name)
     DO UPDATE SET
       owner_actor_id = COALESCE(EXCLUDED.owner_actor_id, network_snapshots.owner_actor_id),
       graph_json = EXCLUDED.graph_json,
       updated_at = now()
     RETURNING id::text`,
    [
      chatNamespace,
      normalizeSpace(params.snapshotName),
      params.ownerActorId ?? null,
      JSON.stringify(params.graph)
    ]
  );
  return { ok: true, id: result.rows[0].id };
}

export async function listNetworkSavedArtifacts(chatNamespace?: string): Promise<{
  ok: true;
  savedViews: NetworkSavedViewSummary[];
  snapshots: NetworkSnapshotSummary[];
}> {
  const namespace = String(chatNamespace ?? DEFAULT_NAMESPACE).trim() || DEFAULT_NAMESPACE;
  const [savedViews, snapshots] = await Promise.all([listSavedViews(namespace), listSnapshots(namespace)]);
  return { ok: true, savedViews, snapshots };
}
