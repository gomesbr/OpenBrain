export interface NormalizeTimestampOptions {
  minYear?: number;
  maxFutureMinutes?: number;
  allowDateOnly?: boolean;
}

export const DEFAULT_MIN_YEAR = 1983;
export const DEFAULT_MAX_FUTURE_MINUTES = 24 * 60;

function numberToEpochMs(value: number): number | null {
  if (!Number.isFinite(value)) return null;
  const abs = Math.abs(value);

  // Microseconds (or larger) to milliseconds.
  if (abs >= 1_000_000_000_000_000) return value / 1000;
  // Milliseconds.
  if (abs >= 1_000_000_000_000) return value;
  // Seconds.
  if (abs >= 100_000_000) return value * 1000;

  return null;
}

function parseIsoLikeString(value: string, allowDateOnly: boolean): number | null {
  const text = value.trim();
  if (!text) return null;

  // Numeric epoch in string form.
  if (/^-?\d+(\.\d+)?$/.test(text)) {
    const asNumber = Number(text);
    return numberToEpochMs(asNumber);
  }

  // Date-only strings can be normalized as UTC midnight.
  if (allowDateOnly && /^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const ms = Date.parse(`${text}T00:00:00.000Z`);
    return Number.isFinite(ms) ? ms : null;
  }

  // Reject slash-style strings to avoid DD/MM vs MM/DD ambiguity.
  if (text.includes("/")) {
    return null;
  }

  // Datetime strings must include an explicit timezone offset or Z.
  if (/^\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}/.test(text)) {
    if (!/(Z|[+-]\d{2}:?\d{2})$/i.test(text)) {
      return null;
    }
  }

  const ms = Date.parse(text);
  return Number.isFinite(ms) ? ms : null;
}

export function normalizeTimestamp(
  value: unknown,
  options: NormalizeTimestampOptions = {}
): string | null {
  const minYear = options.minYear ?? DEFAULT_MIN_YEAR;
  const maxFutureMinutes = options.maxFutureMinutes ?? DEFAULT_MAX_FUTURE_MINUTES;
  const allowDateOnly = options.allowDateOnly ?? false;

  let epochMs: number | null = null;
  if (typeof value === "number") {
    epochMs = numberToEpochMs(value);
  } else if (typeof value === "string") {
    epochMs = parseIsoLikeString(value, allowDateOnly);
  } else if (value instanceof Date && Number.isFinite(value.getTime())) {
    epochMs = value.getTime();
  }

  if (!Number.isFinite(epochMs ?? NaN)) {
    return null;
  }

  const dt = new Date(epochMs as number);
  const nowMs = Date.now();
  const maxFutureMs = nowMs + maxFutureMinutes * 60 * 1000;
  if (dt.getTime() > maxFutureMs) {
    return null;
  }
  if (dt.getUTCFullYear() < minYear) {
    return null;
  }

  return dt.toISOString();
}
