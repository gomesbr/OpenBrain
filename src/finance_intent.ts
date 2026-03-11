export type QueryIntentKind = "default" | "finance_general" | "finance_balance";

export interface QueryIntentProfile {
  kind: QueryIntentKind;
  personal: boolean;
}

export interface FinanceSummaryEvidence {
  excerpt: string;
  similarity: number;
  sourceTimestamp: string | null;
}

function normalize(input: string): string {
  return String(input ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

function isQuestionLike(text: string): boolean {
  const normalized = normalize(text);
  if (!normalized) return false;
  if (/\?$/.test(normalized)) return true;
  return /^(how|what|when|where|who|why|cu[aá]nto|cu[aá]nta|qu[eé]|cuando|d[oó]nde|quien|quanto|qual|onde|quem|porque)\b/.test(
    normalized
  );
}

function isHypotheticalFinance(text: string): boolean {
  const normalized = normalize(text);
  return /\b(if|what if|would|could|should|apr|interest|tax|taxes|scenario|estimate|assuming|projection|projected)\b/.test(
    normalized
  );
}

function hasFinanceAnchor(text: string): boolean {
  const normalized = normalize(text);
  return /\b(money|cash|balance|net worth|worth|assets|liabilities|bank|account|finance|financial|salary|income|expense|dinero|plata|saldo|cuenta|efectivo|dinheiro|saldo|conta|patrim[oô]nio|renda|despesa)\b/.test(
    normalized
  );
}

function hasBalanceAnchor(text: string): boolean {
  const normalized = normalize(text);
  return /\b(current balance|account balance|my balance|balance is|balance was|net worth|total assets|total capital|capital total|saldo atual|saldo da conta|mi saldo|saldo actual)\b/.test(
    normalized
  );
}

function hasOwnershipAnchor(text: string): boolean {
  const normalized = normalize(text);
  return /\b(i|my|mine|we|our|me|eu|meu|minha|nosso|nossa|yo|mi|mio|mia|nuestra|nuestro)\b/.test(normalized);
}

export function hasPersonalOwnershipLanguage(text: string): boolean {
  return hasOwnershipAnchor(text);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

export function detectQueryIntent(question: string): QueryIntentProfile {
  const q = normalize(question);
  const personal = /\b(i|my|me|mine|eu|meu|minha|yo|mi|m[ií]o|m[ií]a)\b/.test(q);
  const finance = /\b(money|balance|cash|net worth|worth|assets|funds|salary|income|expense|dinero|plata|saldo|dinheiro|conta|patrim[oô]nio)\b/.test(
    q
  );
  if (!finance) return { kind: "default", personal };
  const balanceIntent =
    /\b(how much money do i have|how much do i have|what is my balance|what's my balance|my balance|current balance|how much am i worth|net worth)\b/.test(
      q
    ) ||
    /\b(cu[aá]nto dinero tengo|cu[aá]nto tengo|cu[aá]l es mi saldo|saldo actual)\b/.test(q) ||
    /\b(quanto dinheiro eu tenho|quanto eu tenho|qual [ée] meu saldo|saldo atual)\b/.test(q);
  if (balanceIntent) return { kind: "finance_balance", personal };
  return { kind: "finance_general", personal };
}

export function hasMoneyAmount(text: string): boolean {
  return extractMoneyAmounts(text).length > 0;
}

export function extractMoneyAmounts(text: string): string[] {
  const value = String(text ?? "");
  const matches =
    value.match(
      /(?:[$€£]\s?\d[\d,]*(?:\.\d{1,2})?|\b\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?\b|\b\d{4,}(?:\.\d{1,2})?\b|\b\d+(?:\.\d+)?\s?[kKmM]\b)/g
    ) ?? [];
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const raw of matches) {
    const token = raw.trim();
    if (!token) continue;
    const key = token.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(token);
    if (unique.length >= 6) break;
  }
  return unique;
}

export function computeFinanceSignal(
  content: string,
  contextText: string,
  sourceSystem: string | undefined,
  intent: QueryIntentProfile,
  role?: string
): number {
  if (intent.kind === "default") return 0;
  const text = `${content}\n${contextText || ""}`.trim();
  let score = 0;
  const source = String(sourceSystem ?? "").toLowerCase();
  const roleValue = String(role ?? "").toLowerCase();
  const aiAssistantRow = roleValue === "assistant" && (source === "chatgpt" || source === "grok");

  if (hasFinanceAnchor(text)) score += 0.34;
  if (hasBalanceAnchor(text)) score += 0.34;
  if (hasMoneyAmount(text)) score += 0.22;
  const ownership = hasOwnershipAnchor(text);
  if (ownership && !aiAssistantRow) score += 0.1;
  if (isQuestionLike(content)) score -= 0.34;
  if (isHypotheticalFinance(content)) score -= 0.24;
  if (String(content ?? "").trim().length < 24 && !hasMoneyAmount(content)) score -= 0.14;

  if (intent.personal) {
    if (ownership && !aiAssistantRow) {
      score += 0.08;
    } else if (source === "chatgpt" || source === "grok" || aiAssistantRow) {
      score -= 0.16;
    } else {
      score -= 0.08;
    }
  }
  if (intent.kind === "finance_balance") {
    if (source === "whatsapp" || source === "telegram") score += 0.06;
    if (source === "chatgpt" || source === "grok") score -= 0.04;
  }

  return clamp01(score);
}

export function isBalanceEvidenceCandidate(content: string, contextText = ""): boolean {
  void contextText;
  const normalized = normalize(content);
  if (!hasMoneyAmount(normalized)) return false;
  if (hasBalanceAnchor(normalized)) return true;
  return /\b(balance|net worth|worth|account|assets|liabilities|capital|portfolio|savings|current|total|premarital|contribution|saldo|patrim[oô]nio)\b/.test(
    normalized
  );
}

export function isPersonalFinanceEvidenceCandidate(content: string, sourceSystem?: string, role?: string): boolean {
  const source = String(sourceSystem ?? "").toLowerCase();
  const roleValue = String(role ?? "").toLowerCase();
  if (roleValue === "assistant" && (source === "chatgpt" || source === "grok")) {
    return false;
  }
  const normalized = normalize(content);
  if (hasOwnershipAnchor(normalized)) return true;
  return /\b(premarital balance|current balance|marital|account balance at date|monthly contribution|contributed)\b/.test(
    normalized
  );
}

function timeRecencyScore(timestamp: string | null): number {
  if (!timestamp) return 0.25;
  const ms = Date.parse(timestamp);
  if (!Number.isFinite(ms)) return 0.25;
  const ageDays = Math.max(0, (Date.now() - ms) / 86400000);
  if (ageDays <= 7) return 1;
  if (ageDays <= 30) return 0.85;
  if (ageDays <= 90) return 0.65;
  if (ageDays <= 365) return 0.45;
  return 0.25;
}

export function summarizeFinanceBalance(evidence: FinanceSummaryEvidence[]): string {
  if (evidence.length === 0) {
    return "I found no balance-level evidence for this timeframe. Try adding terms like account balance or net worth.";
  }

  const scored = evidence
    .map((item) => {
      const finance = computeFinanceSignal(item.excerpt, "", undefined, { kind: "finance_balance", personal: true });
      const amounts = extractMoneyAmounts(item.excerpt);
      const recency = timeRecencyScore(item.sourceTimestamp);
      const amountStrength = amounts.length > 0 ? 1 : 0;
      const score = finance * 0.45 + Number(item.similarity || 0) * 0.3 + recency * 0.15 + amountStrength * 0.1;
      return { ...item, amounts, score };
    })
    .sort((a, b) => b.score - a.score);

  const best = scored.find((item) => item.amounts.length > 0 && item.score >= 0.45) ?? scored[0];
  if (!best || best.amounts.length === 0) {
    return "I found finance-related messages, but no explicit balance/net-worth amount that can answer this directly.";
  }

  const when = best.sourceTimestamp ? ` (message date: ${new Date(best.sourceTimestamp).toISOString().slice(0, 10)})` : "";
  const amounts = best.amounts.join(", ");
  return `Strongest balance-like evidence points to: ${amounts}${when}. Verify the evidence context before treating this as current exact net worth.`;
}
