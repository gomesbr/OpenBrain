import { readFileSync } from "node:fs";
import { extname } from "node:path";
import AdmZip from "adm-zip";
import type { NormalizedMessage, ParseResult } from "../types.js";
import { normalizeTimestamp } from "../time.js";

function isPresent<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}

function parseJson(raw: string): unknown {
  return JSON.parse(raw);
}

function rankZipEntry(entryName: string): number {
  const name = entryName.toLowerCase();
  let score = 0;
  if (name.endsWith("prod-grok-backend.json")) score += 1000;
  if (name.includes("grok") && name.includes("backend")) score += 500;
  if (name.endsWith("conversations.json")) score += 300;
  if (name.endsWith(".json")) score += 200;
  if (name.endsWith(".ndjson") || name.endsWith(".jsonl")) score += 150;
  if (name.includes("conversation") || name.includes("chat") || name.includes("export")) score += 30;
  return score;
}

function loadInputContent(inputPath: string): { raw: string; ext: string; inputRef: string } {
  const ext = extname(inputPath).toLowerCase();
  if (ext !== ".zip") {
    return {
      raw: readFileSync(inputPath, "utf8"),
      ext,
      inputRef: inputPath
    };
  }

  const zip = new AdmZip(inputPath);
  const candidates = zip
    .getEntries()
    .filter((entry) => !entry.isDirectory)
    .filter((entry) => {
      const entryExt = extname(entry.entryName).toLowerCase();
      return entryExt === ".json" || entryExt === ".ndjson" || entryExt === ".jsonl" || entryExt === ".txt";
    });

  if (candidates.length === 0) {
    throw new Error("Grok ZIP export did not contain a JSON/NDJSON/TXT payload.");
  }

  const chosen = candidates
    .sort((a, b) => {
      const byScore = rankZipEntry(b.entryName) - rankZipEntry(a.entryName);
      if (byScore !== 0) return byScore;
      return b.header.size - a.header.size;
    })[0];

  if (!chosen) {
    throw new Error("Unable to resolve Grok ZIP payload entry.");
  }

  return {
    raw: chosen.getData().toString("utf8"),
    ext: extname(chosen.entryName).toLowerCase(),
    inputRef: `${inputPath}#${chosen.entryName}`
  };
}

function tryParseNdjson(raw: string): unknown[] {
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const rows: unknown[] = [];
  for (const line of lines) {
    try {
      rows.push(JSON.parse(line));
    } catch {
      return [];
    }
  }

  return rows;
}

function getContent(value: any): string {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) {
    return value
      .map((part) => (typeof part === "string" ? part.trim() : ""))
      .filter(Boolean)
      .join("\n")
      .trim();
  }
  if (value && typeof value === "object") {
    if (typeof value.text === "string") return value.text.trim();
    if (Array.isArray(value.parts)) {
      return value.parts
        .map((part: unknown) => (typeof part === "string" ? part.trim() : ""))
        .filter(Boolean)
        .join("\n")
        .trim();
    }
  }
  return "";
}

function parseRole(value: unknown): "user" | "assistant" | "system" {
  const role = String(value ?? "").toLowerCase();
  if (role === "human" || role === "user") return "user";
  if (role === "assistant" || role === "model" || role === "grok") return "assistant";
  if (role === "system" || role === "developer") return "system";
  return "user";
}

function extractScalarString(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }

  if (!value || typeof value !== "object") {
    return null;
  }

  const obj = value as Record<string, unknown>;
  const nestedCandidates: unknown[] = [obj.$oid, obj.$uuid, obj.$numberLong, obj.id, obj.value];
  for (const candidate of nestedCandidates) {
    const parsed = extractScalarString(candidate);
    if (parsed) return parsed;
  }

  return null;
}

function toIso(value: unknown): string | null {
  const normalized = normalizeTimestamp(value);
  if (normalized) return normalized;
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const embeddedDate = obj.$date;
    if (typeof embeddedDate === "number" || typeof embeddedDate === "string") {
      return toIso(embeddedDate);
    }
    if (embeddedDate && typeof embeddedDate === "object") {
      const numberLong = extractScalarString((embeddedDate as Record<string, unknown>).$numberLong);
      if (numberLong) return toIso(Number(numberLong));
    }

    const numberLong = extractScalarString(obj.$numberLong);
    if (numberLong) return toIso(Number(numberLong));
  }
  return null;
}

function normalizeMessages(
  messages: any[],
  conversationId: string | null,
  namespace: string,
  accountAlias: string,
  baseMetadata: Record<string, unknown> = {}
): NormalizedMessage[] {
  return messages
    .map<NormalizedMessage | null>((row, idx) => {
      const content = getContent(row?.content ?? row?.text ?? row?.body ?? row?.message);
      if (!content) return null;

      const role = parseRole(row?.role ?? row?.author?.role ?? row?.sender ?? row?.sender?.role);
      const messageId = extractScalarString(row?.id ?? row?._id ?? row?.message_id ?? row?.response_id) ?? `${idx + 1}`;
      const sourceTimestamp = toIso(row?.created_at ?? row?.create_time ?? row?.timestamp ?? row?.sent_at);
      const convId = extractScalarString(row?.conversation_id) ?? conversationId;

      return {
        content,
        role,
        sourceSystem: "grok",
        sourceConversationId: convId,
        sourceMessageId: messageId,
        sourceTimestamp,
        chatNamespace: namespace,
        metadata: {
          source: "grok_export",
          account: accountAlias,
          model: row?.model ?? row?.model_slug ?? null,
          response_parent_id: extractScalarString(row?.parent_response_id),
          ...baseMetadata
        },
        idempotencyKey: `grok:${convId ?? "unknown"}:${messageId}`
      } satisfies NormalizedMessage;
    })
    .filter(isPresent);
}

function parseStructured(input: unknown, namespace: string, accountAlias: string): NormalizedMessage[] {
  const roots = Array.isArray(input)
    ? input
    : Array.isArray((input as any)?.conversations)
      ? (input as any).conversations
      : Array.isArray((input as any)?.items)
        ? (input as any).items
        : [input];

  const out: NormalizedMessage[] = [];

  for (const root of roots) {
    const conversationId =
      extractScalarString((root as any)?.conversation?.id ?? (root as any)?.id ?? (root as any)?.conversation_id) ??
      null;

    const responseRows = Array.isArray((root as any)?.responses)
      ? ((root as any).responses as Array<any>)
          .map((entry) => (entry?.response && typeof entry.response === "object" ? entry.response : entry))
          .filter((entry) => entry && typeof entry === "object")
      : [];

    if (responseRows.length > 0) {
      out.push(
        ...normalizeMessages(responseRows, conversationId, namespace, accountAlias, {
          source: "grok_backend_export",
          conversation_title:
            typeof (root as any)?.conversation?.title === "string" ? (root as any).conversation.title : null
        })
      );
      continue;
    }

    const messages = Array.isArray((root as any)?.messages)
      ? (root as any).messages
      : Array.isArray((root as any)?.turns)
        ? (root as any).turns
        : Array.isArray((root as any)?.items)
          ? (root as any).items
          : [];

    if (messages.length > 0) {
      out.push(...normalizeMessages(messages, conversationId, namespace, accountAlias));
      continue;
    }

    if ((root as any)?.content || (root as any)?.text || (root as any)?.message) {
      out.push(...normalizeMessages([root], conversationId, namespace, accountAlias));
    }
  }

  return out;
}

function parseTextFallback(raw: string, namespace: string, accountAlias: string): NormalizedMessage[] {
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  return lines.map((line, index) => {
    const separatorIndex = line.indexOf(":");
    const hasSpeaker = separatorIndex > 0 && separatorIndex < 60;
    const speaker = hasSpeaker ? line.slice(0, separatorIndex).trim() : "user";
    const content = hasSpeaker ? line.slice(separatorIndex + 1).trim() : line;

    return {
      content,
      role: parseRole(speaker),
      sourceSystem: "grok",
      sourceConversationId: null,
      sourceMessageId: String(index + 1),
      sourceTimestamp: null,
      chatNamespace: namespace,
      metadata: {
        source: "grok_text_dump",
        account: accountAlias,
        speaker
      },
      idempotencyKey: `grok:${namespace}:${index + 1}`
    } satisfies NormalizedMessage;
  });
}

export function parseGrokExport(inputPath: string, namespace: string, accountAlias: string): ParseResult {
  const { raw, ext, inputRef } = loadInputContent(inputPath);

  let items: NormalizedMessage[] = [];
  if (ext === ".json") {
    items = parseStructured(parseJson(raw), namespace, accountAlias);
  } else if (ext === ".ndjson" || ext === ".jsonl") {
    items = parseStructured(tryParseNdjson(raw), namespace, accountAlias);
  } else {
    try {
      const parsed = parseJson(raw);
      items = parseStructured(parsed, namespace, accountAlias);
    } catch {
      items = parseTextFallback(raw, namespace, accountAlias);
    }
  }

  return {
    sourceSystem: "grok",
    inputRef,
    items
  };
}
