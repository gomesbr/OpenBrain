import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";
import AdmZip from "adm-zip";
import type { NormalizedMessage, ParseResult } from "../types.js";

function isPresent<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}

function loadJsonFromPath(inputPath: string): unknown {
  const ext = extname(inputPath).toLowerCase();
  if (ext === ".zip") {
    const zip = new AdmZip(inputPath);
    const entry = zip
      .getEntries()
      .find((e) => /(^|\/)conversations\.json$/i.test(e.entryName));

    if (!entry) {
      throw new Error("ChatGPT ZIP export missing conversations.json");
    }

    const raw = entry.getData().toString("utf8");
    return JSON.parse(raw);
  }

  const raw = readFileSync(inputPath, "utf8");
  return JSON.parse(raw);
}

function joinParts(value: unknown): string {
  if (Array.isArray(value)) {
    return value
      .map((part) => (typeof part === "string" ? part.trim() : ""))
      .filter((part) => part.length > 0)
      .join("\n")
      .trim();
  }

  if (typeof value === "string") {
    return value.trim();
  }

  return "";
}

function roleFromUnknown(value: unknown): "user" | "assistant" | "system" {
  const raw = String(value ?? "").toLowerCase();
  if (raw === "assistant") return "assistant";
  if (raw === "system" || raw === "developer") return "system";
  return "user";
}

function toIso(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value * 1000).toISOString();
  }
  if (typeof value === "string" && value.trim()) {
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) return new Date(ms).toISOString();
  }
  return null;
}

function parseConversationObject(
  conversation: any,
  namespace: string,
  accountAlias: string
): NormalizedMessage[] {
  const conversationId = String(conversation?.id ?? conversation?.conversation_id ?? "").trim();

  const title = typeof conversation?.title === "string" ? conversation.title : "";

  const mapping = conversation?.mapping;
  if (mapping && typeof mapping === "object") {
    const nodes = Object.values(mapping) as Array<any>;

    const normalized = nodes
      .map<NormalizedMessage | null>((node) => {
        const message = node?.message;
        if (!message || typeof message !== "object") return null;

        const role = roleFromUnknown(message?.author?.role ?? node?.role);
        const messageId = String(message?.id ?? node?.id ?? "").trim() || null;
        const timestamp = toIso(message?.create_time ?? node?.create_time ?? node?.update_time);

        const content = joinParts(message?.content?.parts ?? message?.content?.text ?? message?.content);
        if (!content) return null;

        const metadata = {
          title,
          model: message?.metadata?.model_slug ?? conversation?.model_slug ?? null,
          source: "chatgpt_export",
          account: accountAlias
        } as Record<string, unknown>;

        return {
          content,
          role,
          sourceSystem: "chatgpt" as const,
          sourceConversationId: conversationId || null,
          sourceMessageId: messageId,
          sourceTimestamp: timestamp,
          chatNamespace: namespace,
          metadata,
          idempotencyKey: messageId ? `chatgpt:${conversationId}:${messageId}` : null
        } satisfies NormalizedMessage;
      })
      .filter(isPresent)
      .sort((a, b) => {
        const ams = a.sourceTimestamp ? Date.parse(a.sourceTimestamp) : 0;
        const bms = b.sourceTimestamp ? Date.parse(b.sourceTimestamp) : 0;
        return ams - bms;
      });

    if (normalized.length > 0) {
      return normalized;
    }
  }

  const messages = Array.isArray(conversation?.messages)
    ? (conversation.messages as Array<any>)
    : Array.isArray(conversation?.items)
      ? (conversation.items as Array<any>)
      : [];

  return messages
    .map<NormalizedMessage | null>((item, index) => {
      const role = roleFromUnknown(item?.role ?? item?.author?.role);
      const content = joinParts(item?.content?.parts ?? item?.content);
      if (!content) return null;

      const messageId = String(item?.id ?? `${index + 1}`).trim();
      const timestamp = toIso(item?.create_time ?? item?.created_at ?? item?.timestamp);

      return {
        content,
        role,
        sourceSystem: "chatgpt" as const,
        sourceConversationId: conversationId || null,
        sourceMessageId: messageId,
        sourceTimestamp: timestamp,
        chatNamespace: namespace,
        metadata: {
          title,
          source: "chatgpt_export",
          account: accountAlias
        },
        idempotencyKey: `chatgpt:${conversationId || basename(namespace)}:${messageId}`
      } satisfies NormalizedMessage;
    })
    .filter(isPresent);
}

export function parseChatGptExport(inputPath: string, namespace: string, accountAlias: string): ParseResult {
  const raw = loadJsonFromPath(inputPath);
  const conversations = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as any)?.conversations)
      ? (raw as any).conversations
      : [];

  if (!Array.isArray(conversations) || conversations.length === 0) {
    throw new Error("ChatGPT export did not contain conversation objects");
  }

  const items: NormalizedMessage[] = [];
  for (const conversation of conversations) {
    items.push(...parseConversationObject(conversation, namespace, accountAlias));
  }

  return {
    sourceSystem: "chatgpt",
    inputRef: inputPath,
    items
  };
}
