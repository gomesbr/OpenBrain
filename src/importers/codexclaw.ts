import Database from "better-sqlite3";
import { resolve } from "node:path";
import type { NormalizedMessage, ParseResult } from "../types.js";
import { normalizeTimestamp } from "../time.js";

interface ImportOptions {
  dbPath: string;
  namespacePrefix: string;
}

function toIso(value: unknown): string | null {
  return normalizeTimestamp(value);
}

function chatNamespace(prefix: string, chatId: string): string {
  return `${prefix}:${chatId}`;
}

export function parseCodexClawBackfill(options: ImportOptions): ParseResult {
  const dbPath = resolve(options.dbPath);
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });

  try {
    const items: NormalizedMessage[] = [];

    const memoryRows = db
      .prepare(
        `SELECT id, chat_id, source_path, role, content, created_at
           FROM memory_chunks
          ORDER BY created_at ASC, id ASC`
      )
      .all() as Array<{
      id: number;
      chat_id: string;
      source_path: string;
      role: string;
      content: string;
      created_at: number;
    }>;

    for (const row of memoryRows) {
      const role = row.role === "assistant" ? "assistant" : row.role === "user" ? "user" : "system";
      items.push({
        content: row.content,
        role,
        sourceSystem: "codexclaw",
        sourceConversationId: row.chat_id,
        sourceMessageId: `memory:${row.id}`,
        sourceTimestamp: toIso(row.created_at),
        chatNamespace: chatNamespace(options.namespacePrefix, row.chat_id),
        metadata: {
          source_table: "memory_chunks",
          source_path: row.source_path
        },
        idempotencyKey: `codexclaw:memory:${row.id}`
      });
    }

    const reportRows = db
      .prepare(
        `SELECT id, chat_id, agent, file_path, summary, created_at
           FROM reports
          ORDER BY created_at ASC, id ASC`
      )
      .all() as Array<{
      id: number;
      chat_id: string;
      agent: string;
      file_path: string;
      summary: string;
      created_at: number;
    }>;

    for (const row of reportRows) {
      const role = row.agent.toLowerCase() === "strategist" ? "assistant" : "event";
      items.push({
        content: row.summary,
        role,
        sourceSystem: "codexclaw",
        sourceConversationId: row.chat_id,
        sourceMessageId: `report:${row.id}`,
        sourceTimestamp: toIso(row.created_at),
        chatNamespace: chatNamespace(options.namespacePrefix, row.chat_id),
        metadata: {
          source_table: "reports",
          agent: row.agent,
          file_path: row.file_path
        },
        idempotencyKey: `codexclaw:report:${row.id}`
      });
    }

    const hasStoryEvents = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='story_events'`)
      .get() as { name: string } | undefined;

    if (hasStoryEvents) {
      const eventRows = db
        .prepare(
          `SELECT id, chat_id, role, actor, event_type, content, visibility, created_at
             FROM story_events
            WHERE visibility = 'user'
               OR event_type IN ('status_change', 'manual_close', 'blocker', 'completion')
            ORDER BY created_at ASC, id ASC`
        )
        .all() as Array<{
        id: number;
        chat_id: string;
        role: string;
        actor: string;
        event_type: string;
        content: string;
        visibility: string | null;
        created_at: number;
      }>;

      for (const row of eventRows) {
        const role = row.role === "assistant" || row.actor === "strategist" ? "assistant" : "event";
        items.push({
          content: row.content,
          role,
          sourceSystem: "codexclaw",
          sourceConversationId: row.chat_id,
          sourceMessageId: `event:${row.id}`,
          sourceTimestamp: toIso(row.created_at),
          chatNamespace: chatNamespace(options.namespacePrefix, row.chat_id),
          metadata: {
            source_table: "story_events",
            event_type: row.event_type,
            actor: row.actor,
            visibility: row.visibility
          },
          idempotencyKey: `codexclaw:event:${row.id}`
        });
      }
    }

    const hasRoutingDecisions = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='routing_decisions'`)
      .get() as { name: string } | undefined;

    if (hasRoutingDecisions) {
      const routingRows = db
        .prepare(
          `SELECT id, chat_id, story_key, decision, delegated_agents, explicit_target, route_reason, created_at
             FROM routing_decisions
            WHERE route_reason IS NOT NULL AND length(trim(route_reason)) > 0
            ORDER BY created_at ASC, id ASC`
        )
        .all() as Array<{
        id: number;
        chat_id: string;
        story_key: string | null;
        decision: string;
        delegated_agents: string | null;
        explicit_target: string | null;
        route_reason: string;
        created_at: number;
      }>;

      for (const row of routingRows) {
        const content = `Routing decision: ${row.decision}. Reason: ${row.route_reason}`;
        items.push({
          content,
          role: "event",
          sourceSystem: "codexclaw",
          sourceConversationId: row.chat_id,
          sourceMessageId: `routing:${row.id}`,
          sourceTimestamp: toIso(row.created_at),
          chatNamespace: chatNamespace(options.namespacePrefix, row.chat_id),
          metadata: {
            source_table: "routing_decisions",
            story_key: row.story_key,
            delegated_agents: row.delegated_agents,
            explicit_target: row.explicit_target
          },
          idempotencyKey: `codexclaw:routing:${row.id}`
        });
      }
    }

    return {
      sourceSystem: "codexclaw",
      inputRef: dbPath,
      items
    };
  } finally {
    db.close();
  }
}
