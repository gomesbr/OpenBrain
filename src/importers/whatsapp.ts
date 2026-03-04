import { readFileSync } from "node:fs";
import { basename } from "node:path";
import type { NormalizedMessage, ParseResult } from "../types.js";

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

function parseDateTime(datePart: string, timePart: string): string | null {
  const date = datePart.trim();
  const time = timePart.trim().toUpperCase();

  const dateMatch = date.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!dateMatch) return null;

  let day = Number(dateMatch[1]);
  let month = Number(dateMatch[2]);
  let year = Number(dateMatch[3]);

  // Heuristic: WhatsApp exports may be DD/MM/YYYY or MM/DD/YYYY.
  if (day <= 12 && month <= 12) {
    month = Number(dateMatch[1]);
    day = Number(dateMatch[2]);
  }

  if (year < 100) {
    year += year >= 70 ? 1900 : 2000;
  }

  const timeMatch = time.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?$/);
  if (!timeMatch) return null;

  let hour = Number(timeMatch[1]);
  const minute = Number(timeMatch[2]);
  const second = Number(timeMatch[3] ?? 0);
  const meridiem = timeMatch[4];

  if (meridiem === "PM" && hour < 12) hour += 12;
  if (meridiem === "AM" && hour === 12) hour = 0;

  const dt = new Date(year, month - 1, day, hour, minute, second);
  if (!Number.isFinite(dt.getTime())) return null;
  return dt.toISOString();
}

function parseLine(line: string): ParsedLine | null {
  // [MM/DD/YY, HH:MM] Name: message
  let m = line.match(/^\[(\d{1,2}\/\d{1,2}\/\d{2,4}),\s*(\d{1,2}:\d{2}(?::\d{2})?\s*(?:AM|PM)?)\]\s([^:]+):\s?(.*)$/i);
  if (m) {
    return {
      timestamp: parseDateTime(m[1], m[2]),
      speaker: m[3].trim(),
      text: m[4] ?? ""
    };
  }

  // MM/DD/YY, HH:MM - Name: message
  m = line.match(/^(\d{1,2}\/\d{1,2}\/\d{2,4}),\s*(\d{1,2}:\d{2}(?::\d{2})?\s*(?:AM|PM)?)\s-\s([^:]+):\s?(.*)$/i);
  if (m) {
    return {
      timestamp: parseDateTime(m[1], m[2]),
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

export function parseWhatsappExport(inputPath: string, namespace: string): ParseResult {
  const raw = readFileSync(inputPath, "utf8");
  const lines = raw.split(/\r?\n/);

  const conversationId = basename(inputPath).replace(/\.[^.]+$/, "");
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
        textOnly: true
      },
      idempotencyKey: `whatsapp:${conversationId}:${index}`
    });

    current = null;
  };

  for (const line of lines) {
    const parsed = parseLine(line);
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
