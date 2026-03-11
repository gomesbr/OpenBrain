export type TemporalIntentMode = "none" | "hard_range" | "month_hint";

export interface TemporalIntent {
  mode: TemporalIntentMode;
  start: Date | null;
  end: Date | null;
  targetMonth: number | null; // 1..12
  reason: string | null;
}

function stripDiacritics(input: string): string {
  return String(input ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function toStartOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
}

function toEndOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
}

function monthRange(year: number, month1Based: number): { start: Date; end: Date } {
  const month = Math.max(1, Math.min(12, month1Based)) - 1;
  const start = new Date(year, month, 1, 0, 0, 0, 0);
  const end = new Date(year, month + 1, 0, 23, 59, 59, 999);
  return { start, end };
}

const MONTH_ALIASES: Array<{ month: number; aliases: string[] }> = [
  { month: 1, aliases: ["january", "jan", "enero", "ene", "janeiro"] },
  { month: 2, aliases: ["february", "feb", "febrero", "fev", "fevereiro"] },
  { month: 3, aliases: ["march", "mar", "marzo", "marco"] },
  { month: 4, aliases: ["april", "apr", "abril", "abr"] },
  { month: 5, aliases: ["may", "mayo", "maio"] },
  { month: 6, aliases: ["june", "jun", "junio", "junho"] },
  { month: 7, aliases: ["july", "jul", "julio", "julho"] },
  { month: 8, aliases: ["august", "aug", "agosto", "ago"] },
  { month: 9, aliases: ["september", "sep", "sept", "septiembre", "setembro", "set"] },
  { month: 10, aliases: ["october", "oct", "octubre", "outubro", "out"] },
  { month: 11, aliases: ["november", "nov", "noviembre", "novembro"] },
  { month: 12, aliases: ["december", "dec", "diciembre", "dezembro", "dez"] }
];

const MONTH_LOOKUP = new Map<string, number>();
for (const entry of MONTH_ALIASES) {
  for (const alias of entry.aliases) {
    MONTH_LOOKUP.set(alias, entry.month);
  }
}

const MONTH_ALIAS_REGEX = MONTH_ALIASES.flatMap((m) => m.aliases)
  .sort((a, b) => b.length - a.length)
  .join("|");

export function parseTemporalIntent(query: string, now = new Date()): TemporalIntent {
  const raw = stripDiacritics(String(query ?? "").toLowerCase());
  const txt = raw.replace(/\s+/g, " ").trim();

  if (!txt) {
    return { mode: "none", start: null, end: null, targetMonth: null, reason: null };
  }

  if (/\b(yesterday|ayer|ontem)\b/.test(txt)) {
    const d = new Date(now);
    d.setDate(d.getDate() - 1);
    return {
      mode: "hard_range",
      start: toStartOfDay(d),
      end: toEndOfDay(d),
      targetMonth: null,
      reason: "yesterday"
    };
  }

  if (/\b(today|hoy|hoje)\b/.test(txt)) {
    return {
      mode: "hard_range",
      start: toStartOfDay(now),
      end: toEndOfDay(now),
      targetMonth: null,
      reason: "today"
    };
  }

  if (/\b(last month|mes pasado|mes passado|mes anterior)\b/.test(txt)) {
    const d = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const range = monthRange(d.getFullYear(), d.getMonth() + 1);
    return {
      mode: "hard_range",
      start: range.start,
      end: range.end,
      targetMonth: null,
      reason: "last_month"
    };
  }

  if (/\b(this month|este mes|este mes|este mes)\b/.test(txt)) {
    const range = monthRange(now.getFullYear(), now.getMonth() + 1);
    return {
      mode: "hard_range",
      start: range.start,
      end: range.end,
      targetMonth: null,
      reason: "this_month"
    };
  }

  if (/\b(last year|ano pasado|ano anterior|año pasado|año anterior)\b/.test(txt)) {
    const year = now.getFullYear() - 1;
    return {
      mode: "hard_range",
      start: new Date(year, 0, 1, 0, 0, 0, 0),
      end: new Date(year, 11, 31, 23, 59, 59, 999),
      targetMonth: null,
      reason: "last_year"
    };
  }

  const monthYearMatch = txt.match(new RegExp(`\\b(${MONTH_ALIAS_REGEX})\\b(?:\\s+(?:de|of))?\\s+(\\d{4})\\b`, "i"));
  if (monthYearMatch) {
    const month = MONTH_LOOKUP.get(monthYearMatch[1].toLowerCase()) ?? null;
    const year = Number(monthYearMatch[2]);
    if (month && Number.isFinite(year) && year >= 1983 && year <= now.getFullYear() + 1) {
      const range = monthRange(year, month);
      return {
        mode: "hard_range",
        start: range.start,
        end: range.end,
        targetMonth: month,
        reason: "month_year"
      };
    }
  }

  const monthOnlyMatch = txt.match(new RegExp(`\\b(${MONTH_ALIAS_REGEX})\\b`, "i"));
  if (monthOnlyMatch) {
    const month = MONTH_LOOKUP.get(monthOnlyMatch[1].toLowerCase()) ?? null;
    if (month) {
      return {
        mode: "month_hint",
        start: null,
        end: null,
        targetMonth: month,
        reason: "month_hint"
      };
    }
  }

  return { mode: "none", start: null, end: null, targetMonth: null, reason: null };
}

export function timestampInHardRange(value: string | null | undefined, intent: TemporalIntent): boolean {
  if (intent.mode !== "hard_range") return true;
  if (!value || !intent.start || !intent.end) return false;
  const ts = new Date(value);
  if (!Number.isFinite(ts.getTime())) return false;
  return ts >= intent.start && ts <= intent.end;
}

function monthDistance(a: number, b: number): number {
  const diff = Math.abs(a - b) % 12;
  return Math.min(diff, 12 - diff);
}

export function temporalRelevance(
  value: string | null | undefined,
  intent: TemporalIntent,
  now = new Date()
): number {
  if (!value) return 0.3;
  const ts = new Date(value);
  if (!Number.isFinite(ts.getTime())) return 0.3;

  if (intent.mode === "hard_range" && intent.start && intent.end) {
    if (ts >= intent.start && ts <= intent.end) return 1;
    const distMs = ts < intent.start
      ? intent.start.getTime() - ts.getTime()
      : ts.getTime() - intent.end.getTime();
    const distDays = distMs / (24 * 60 * 60 * 1000);
    const tail = Math.exp(-distDays / 14);
    return Math.max(0, Math.min(1, tail * 0.35));
  }

  if (intent.mode === "month_hint" && intent.targetMonth) {
    const m = ts.getMonth() + 1;
    const mDist = monthDistance(m, intent.targetMonth);
    const monthScore = 1 - Math.min(1, mDist / 6);
    const ageMonths = Math.abs(
      (now.getFullYear() - ts.getFullYear()) * 12 + (now.getMonth() - ts.getMonth())
    );
    const recency = Math.exp(-ageMonths / 24);
    return Math.max(0, Math.min(1, monthScore * 0.72 + recency * 0.28));
  }

  return 0.5;
}
