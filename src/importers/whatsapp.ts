import { readFileSync } from "node:fs";
import { basename } from "node:path";
import type { NormalizedMessage, ParseResult } from "../types.js";
import { normalizeTimestamp } from "../time.js";

const MEDIA_PATTERNS = [
  "<media omitted>",
  "image omitted",
  "video omitted",
  "audio omitted",
  "document omitted",
  "sticker omitted"
];

interface ParsedLine {
  timestamp: string | null;
  speaker: string;
  text: string;
}

type DateOrder = "mdy" | "dmy";

const DATE_ORDER_FALLBACK: DateOrder = String(process.env.OPENBRAIN_WHATSAPP_DATE_ORDER ?? "mdy").trim().toLowerCase() === "dmy"
  ? "dmy"
  : "mdy";

function parseDateTime(datePart: string, timePart: string, dateOrder: DateOrder): string | null {
  const date = datePart.trim();
  const time = timePart.trim().toUpperCase();

  const dateMatch = date.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!dateMatch) return null;

  const first = Number(dateMatch[1]);
  const secondPart = Number(dateMatch[2]);
  let day = first;
  let month = secondPart;
  let year = Number(dateMatch[3]);

  // WhatsApp exports may be DD/MM/YYYY or MM/DD/YYYY depending on device locale.
  if (first > 12 && secondPart <= 12) {
    day = first;
    month = secondPart;
  } else if (secondPart > 12 && first <= 12) {
    month = first;
    day = secondPart;
  } else if (first <= 12 && secondPart <= 12) {
    if (dateOrder === "dmy") {
      day = first;
      month = secondPart;
    } else {
      month = first;
      day = secondPart;
    }
  }

  if (year < 100) {
    year += year >= 70 ? 1900 : 2000;
  }

  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }

  const timeMatch = time.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?$/);
  if (!timeMatch) return null;

  let hour = Number(timeMatch[1]);
  const minute = Number(timeMatch[2]);
  const second = Number(timeMatch[3] ?? 0);
  const meridiem = timeMatch[4];

  if (meridiem === "PM" && hour < 12) hour += 12;
  if (meridiem === "AM" && hour === 12) hour = 0;

  const dt = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (!Number.isFinite(dt.getTime())) return null;
  if (dt.getUTCFullYear() !== year || dt.getUTCMonth() !== month - 1 || dt.getUTCDate() !== day) {
    return null;
  }
  return normalizeTimestamp(dt.toISOString());
}

function parseLine(line: string, dateOrder: DateOrder): ParsedLine | null {
  // [MM/DD/YY, HH:MM] Name: message
  let m = line.match(/^\[(\d{1,2}\/\d{1,2}\/\d{2,4}),\s*(\d{1,2}:\d{2}(?::\d{2})?\s*(?:AM|PM)?)\]\s([^:]+):\s?(.*)$/i);
  if (m) {
    return {
      timestamp: parseDateTime(m[1], m[2], dateOrder),
      speaker: m[3].trim(),
      text: m[4] ?? ""
    };
  }

  // MM/DD/YY, HH:MM - Name: message
  m = line.match(/^(\d{1,2}\/\d{1,2}\/\d{2,4}),\s*(\d{1,2}:\d{2}(?::\d{2})?\s*(?:AM|PM)?)\s-\s([^:]+):\s?(.*)$/i);
  if (m) {
    return {
      timestamp: parseDateTime(m[1], m[2], dateOrder),
      speaker: m[3].trim(),
      text: m[4] ?? ""
    };
  }

  return null;
}

function normalizeSpeakerRole(speaker: string): "user" | "assistant" | "system" {
  const value = speaker.toLowerCase();
  if (value.includes("system") || value.includes("whatsapp")) return "system";
  return "user";
}

function deriveConversationLabel(conversationId: string): string {
  const patterns = [
    /whatsapp chat - (.+?)(?:\.zip)?___chat$/i,
    /whatsapp chat with (.+?)(?:\.zip)?___chat$/i,
    /whatsapp chat - (.+)$/i
  ];
  for (const pattern of patterns) {
    const match = conversationId.match(pattern);
    if (match?.[1]) {
      return match[1].replace(/_/g, " ").trim();
    }
  }
  return conversationId;
}

function inferDateOrder(lines: string[]): DateOrder {
  let mdy = 0;
  let dmy = 0;
  const cap = Math.min(lines.length, 5000);
  for (let i = 0; i < cap; i += 1) {
    const line = lines[i];
    const match = line.match(/^(?:\[(\d{1,2})\/(\d{1,2})\/\d{2,4},|(\d{1,2})\/(\d{1,2})\/\d{2,4},)/);
    if (!match) continue;
    const first = Number(match[1] ?? match[3]);
    const second = Number(match[2] ?? match[4]);
    if (!Number.isFinite(first) || !Number.isFinite(second)) continue;
    if (first > 12 && second <= 12) {
      dmy += 1;
    } else if (second > 12 && first <= 12) {
      mdy += 1;
    }
  }
  if (dmy > mdy) return "dmy";
  if (mdy > dmy) return "mdy";
  return DATE_ORDER_FALLBACK;
}

export function parseWhatsappExport(inputPath: string, namespace: string): ParseResult {
  const raw = readFileSync(inputPath, "utf8");
  const lines = raw.split(/\r?\n/);
  const dateOrder = inferDateOrder(lines);

  const conversationId = basename(inputPath).replace(/\.[^.]+$/, "");
  const conversationLabel = deriveConversationLabel(conversationId);
  const items: NormalizedMessage[] = [];

  let current: ParsedLine | null = null;

  const flush = (): void => {
    if (!current) return;
    const text = current.text.trim();
    if (!text) {
      current = null;
      return;
    }

    const lower = text.toLowerCase();
    if (MEDIA_PATTERNS.some((pattern) => lower.includes(pattern))) {
      current = null;
      return;
    }

    const index = items.length + 1;
    items.push({
      content: text,
      role: normalizeSpeakerRole(current.speaker),
      sourceSystem: "whatsapp",
      sourceConversationId: conversationId,
      sourceMessageId: String(index),
      sourceTimestamp: current.timestamp,
      chatNamespace: namespace,
      metadata: {
        source: "whatsapp_export",
        speaker: current.speaker,
        conversationLabel,
        dateOrder,
        textOnly: true
      },
      idempotencyKey: `whatsapp:${conversationId}:${index}`
    });

    current = null;
  };

  for (const line of lines) {
    const parsed = parseLine(line, dateOrder);
    if (parsed) {
      flush();
      current = parsed;
      continue;
    }

    if (!current) continue;
    current.text += `\n${line}`;
  }

  flush();

  return {
    sourceSystem: "whatsapp",
    inputRef: inputPath,
    items
  };
}
