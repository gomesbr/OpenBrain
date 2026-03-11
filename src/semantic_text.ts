const E = {
  kissFace: "\u{1F618}",
  kissMark: "\u{1F48B}",
  kissFaceAlt1: "\u{1F617}",
  kissFaceAlt2: "\u{1F619}",
  kissFaceAlt3: "\u{1F61A}",
  heartRed: "\u{2764}\u{FE0F}",
  heartBlack: "\u{2665}",
  heartEyes: "\u{1F60D}",
  smileBlush: "\u{1F60A}",
  smileOpen: "\u{1F604}",
  tearsJoy: "\u{1F602}",
  rofl: "\u{1F923}",
  cry: "\u{1F622}",
  sob: "\u{1F62D}",
  angry: "\u{1F621}",
  thumbsUp: "\u{1F44D}",
  pray: "\u{1F64F}",
  fire: "\u{1F525}",
  party: "\u{1F389}",
  moneyBag: "\u{1F4B0}",
  house: "\u{1F3E0}",
  plate: "\u{1F37D}"
} as const;

const EMOJI_TO_TERMS: Record<string, string[]> = {
  [E.kissFace]: ["kiss", "affection", "love"],
  [E.kissMark]: ["kiss", "affection"],
  [E.kissFaceAlt1]: ["kiss", "affection"],
  [E.kissFaceAlt2]: ["kiss", "affection"],
  [E.kissFaceAlt3]: ["kiss", "affection"],
  [E.heartRed]: ["love", "heart", "affection"],
  [E.heartBlack]: ["love", "heart", "affection"],
  [E.heartEyes]: ["love", "adore"],
  [E.smileBlush]: ["smile", "happy"],
  [E.smileOpen]: ["smile", "happy"],
  [E.tearsJoy]: ["laugh", "funny"],
  [E.rofl]: ["laugh", "funny"],
  [E.cry]: ["sad", "cry"],
  [E.sob]: ["sad", "cry"],
  [E.angry]: ["angry", "mad"],
  [E.thumbsUp]: ["agree", "approve", "yes"],
  [E.pray]: ["thanks", "gratitude", "prayer"],
  [E.fire]: ["fire", "hot", "excited"],
  [E.party]: ["celebrate", "party", "congrats"],
  [E.moneyBag]: ["money", "cash", "finance"],
  [E.house]: ["home", "house"],
  [E.plate]: ["food", "meal", "eat"]
};

const WORD_TO_EMOJIS: Record<string, string[]> = {
  kiss: [E.kissFace, E.kissMark, E.kissFaceAlt1, E.kissFaceAlt2, E.kissFaceAlt3],
  love: [E.heartRed, E.heartBlack, E.heartEyes],
  heart: [E.heartRed, E.heartBlack],
  laugh: [E.tearsJoy, E.rofl],
  funny: [E.tearsJoy, E.rofl],
  sad: [E.cry, E.sob],
  cry: [E.cry, E.sob],
  angry: [E.angry],
  mad: [E.angry],
  agree: [E.thumbsUp],
  approve: [E.thumbsUp],
  thanks: [E.pray],
  gratitude: [E.pray],
  celebrate: [E.party],
  congrats: [E.party],
  money: [E.moneyBag],
  cash: [E.moneyBag],
  finance: [E.moneyBag],
  home: [E.house],
  house: [E.house],
  food: [E.plate],
  meal: [E.plate],
  eat: [E.plate]
};

const CONTEXT_STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "to",
  "is",
  "are",
  "i",
  "you",
  "my",
  "me",
  "of",
  "in",
  "for",
  "on",
  "at",
  "do",
  "did",
  "have",
  "has",
  "what",
  "how",
  "much",
  "que",
  "de",
  "la",
  "el",
  "y",
  "en",
  "por",
  "para",
  "com",
  "uma",
  "um",
  "na",
  "no"
]);

function normalizeEmojiPresentation(text: string): string {
  return text.replace(/\uFE0F/g, "");
}

function unique<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}

export function containsEmoji(text: string): boolean {
  return /\p{Extended_Pictographic}/u.test(String(text ?? ""));
}

export function extractEmojiTerms(text: string): string[] {
  const normalized = normalizeEmojiPresentation(String(text ?? ""));
  const terms: string[] = [];
  for (const [emoji, labels] of Object.entries(EMOJI_TO_TERMS)) {
    if (normalized.includes(normalizeEmojiPresentation(emoji))) {
      terms.push(...labels);
    }
  }
  return unique(terms);
}

export function extractContextKeywords(messages: string[], maxTerms = 14): string[] {
  const freq = new Map<string, number>();
  for (const message of messages) {
    const tokens = String(message ?? "")
      .toLowerCase()
      .split(/[^a-z0-9_]+/i)
      .map((t) => t.trim())
      .filter((t) => t.length >= 3 && !CONTEXT_STOPWORDS.has(t));
    for (const token of tokens) {
      freq.set(token, (freq.get(token) ?? 0) + 1);
    }
  }
  return Array.from(freq.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, Math.max(0, maxTerms))
    .map((entry) => entry[0]);
}

export function toSemanticEmbeddingText(
  text: string,
  options?: { contextTerms?: string[] | null }
): string {
  const base = String(text ?? "").trim();
  const emojiTerms = extractEmojiTerms(base);
  const contextTerms = unique(
    (options?.contextTerms ?? []).map((x) => String(x ?? "").trim()).filter(Boolean)
  );
  const parts: string[] = [];
  if (emojiTerms.length > 0) parts.push(`[emoji_semantics: ${emojiTerms.join(" ")}]`);
  if (contextTerms.length > 0) parts.push(`[conversation_context: ${contextTerms.join(" ")}]`);
  if (parts.length === 0) return base;
  return `${base}\n\n${parts.join("\n")}`;
}

export function expandLexicalTokens(tokens: string[]): string[] {
  const normalized = tokens.map((t) => String(t ?? "").trim()).filter(Boolean);
  const expanded: string[] = [...normalized];
  for (const token of normalized) {
    const emojis = WORD_TO_EMOJIS[token.toLowerCase()];
    if (emojis?.length) expanded.push(...emojis);
  }
  return unique(expanded);
}
