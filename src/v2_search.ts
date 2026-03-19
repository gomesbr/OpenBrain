import { pool, searchMemory } from "./db.js";
import { getOpenBrainCapabilities } from "./v2_capabilities.js";
import type { RetrievalMode, V2ContextMessage, V2RetrievalAnchor } from "./v2_types.js";

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function asIso(value: string | Date | null | undefined): string | null {
  if (!value) return null;
  const dt = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(dt.getTime())) return null;
  return dt.toISOString();
}

function normalizeAnchorRow(row: Record<string, unknown>): V2RetrievalAnchor {
  return {
    canonicalId: String(row.canonical_id ?? ""),
    memoryId: String(row.memory_id ?? ""),
    conversationId: String(row.conversation_id ?? ""),
    sourceConversationId: row.source_conversation_id ? String(row.source_conversation_id) : null,
    sourceConversationLabel: row.source_conversation_label ? String(row.source_conversation_label) : null,
    sourceSystem: String(row.source_system ?? ""),
    sourceMessageId: row.source_message_id ? String(row.source_message_id) : null,
    replyToMessageId: row.reply_to_message_id ? String(row.reply_to_message_id) : null,
    actorId: row.actor_id ? String(row.actor_id) : null,
    actorType: row.actor_type ? String(row.actor_type) : null,
    actorName: row.actor_name ? String(row.actor_name) : null,
    role: row.role ? String(row.role) : null,
    sourceTimestamp: asIso((row.source_timestamp as string | Date | null | undefined) ?? null),
    excerpt: String(row.excerpt ?? ""),
    score: clamp01(Number(row.score ?? 0)),
    matchType: String(row.match_type ?? "lexical") as V2RetrievalAnchor["matchType"]
  };
}

function normalizeContextRow(row: Record<string, unknown>): V2ContextMessage {
  return {
    canonicalId: String(row.canonical_id ?? ""),
    memoryId: String(row.memory_id ?? ""),
    conversationId: String(row.conversation_id ?? ""),
    sourceConversationId: row.source_conversation_id ? String(row.source_conversation_id) : null,
    sourceConversationLabel: row.source_conversation_label ? String(row.source_conversation_label) : null,
    sourceMessageId: row.source_message_id ? String(row.source_message_id) : null,
    replyToMessageId: row.reply_to_message_id ? String(row.reply_to_message_id) : null,
    actorId: row.actor_id ? String(row.actor_id) : null,
    actorType: row.actor_type ? String(row.actor_type) : null,
    actorName: row.actor_name ? String(row.actor_name) : null,
    role: row.role ? String(row.role) : null,
    sourceSystem: String(row.source_system ?? ""),
    sourceTimestamp: asIso((row.source_timestamp as string | Date | null | undefined) ?? null),
    excerpt: String(row.excerpt ?? ""),
    sequence: Number(row.sequence ?? 0)
  };
}

export function getCapabilitiesPayload(): Record<string, unknown> {
  return {
    ok: true,
    capabilities: getOpenBrainCapabilities()
  };
}

export async function searchAnchors(params: {
  query: string;
  chatNamespace?: string;
  filters?: Record<string, unknown>;
  k?: number;
  mode?: RetrievalMode;
}): Promise<{ ok: true; query: string; count: number; anchors: V2RetrievalAnchor[] }> {
  const query = String(params.query ?? "").trim();
  if (!query) return { ok: true, query, count: 0, anchors: [] };
  const chatNamespace = String(params.chatNamespace ?? "personal.main").trim() || "personal.main";
  const k = Number.isFinite(Number(params.k)) ? Math.max(1, Math.min(100, Number(params.k))) : 24;
  const mode = params.mode ?? "hybrid";
  const sourceFilter = params.filters?.sourceSystem ? String(params.filters.sourceSystem).trim().toLowerCase() : null;
  const actorTypeFilter = params.filters?.actorType ? String(params.filters.actorType).trim().toLowerCase() : null;

  const lexical = mode === "vector"
    ? { rows: [] as Record<string, unknown>[] }
    : await pool.query<Record<string, unknown>>(
        `SELECT
           c.id::text AS canonical_id,
           c.memory_item_id::text AS memory_id,
           c.conversation_id,
           NULLIF(c.source_conversation_id, '') AS source_conversation_id,
           NULLIF(COALESCE(c.metadata->>'conversationLabel', m.metadata->>'conversationLabel', ''), '') AS source_conversation_label,
           c.source_system,
           c.source_message_id,
           c.reply_to_message_id,
           c.actor_id::text AS actor_id,
           c.actor_type,
           ai.canonical_name AS actor_name,
           m.role,
           COALESCE(c.observed_at, m.source_timestamp, m.created_at)::text AS source_timestamp,
           m.content AS excerpt,
           GREATEST(
             similarity(c.content_normalized, $1),
             ts_rank_cd(to_tsvector('simple', c.content_normalized), plainto_tsquery('simple', $1))
           )::float8 AS score,
           'lexical'::text AS match_type
         FROM canonical_messages c
         JOIN memory_items m ON m.id = c.memory_item_id
         LEFT JOIN actors ai ON ai.actor_id = c.actor_id
         WHERE c.chat_namespace = $2
           AND c.artifact_state = 'published'
           AND (
             c.content_normalized % $1
             OR to_tsvector('simple', c.content_normalized) @@ plainto_tsquery('simple', $1)
             OR c.content_normalized ILIKE '%' || $1 || '%'
           )
           AND ($3::text IS NULL OR lower(c.source_system) = $3::text)
           AND ($4::text IS NULL OR lower(COALESCE(c.actor_type, '')) = $4::text)
         ORDER BY score DESC, COALESCE(c.observed_at, m.source_timestamp, m.created_at) DESC
         LIMIT $5`,
        [query, chatNamespace, sourceFilter, actorTypeFilter, k]
      );

  const anchors = new Map<string, V2RetrievalAnchor>();
  for (const row of lexical.rows) {
    const item = normalizeAnchorRow(row);
    if (!item.memoryId) continue;
    anchors.set(item.memoryId, item);
  }

  const vector = mode === "lexical"
    ? { matches: [] as Array<{ id: string; similarity: number }> }
    : await searchMemory({
        query,
        chatNamespace,
        limit: Math.max(k, 32),
        threshold: 0.35,
        sourceSystem: sourceFilter ? (sourceFilter as any) : undefined
      });

  const vectorIds = vector.matches.map((m) => m.id);
  if (vectorIds.length > 0) {
    const rows = await pool.query<Record<string, unknown>>(
      `SELECT
         c.id::text AS canonical_id,
         c.memory_item_id::text AS memory_id,
         c.conversation_id,
         NULLIF(c.source_conversation_id, '') AS source_conversation_id,
         NULLIF(COALESCE(c.metadata->>'conversationLabel', m.metadata->>'conversationLabel', ''), '') AS source_conversation_label,
         c.source_system,
         c.source_message_id,
         c.reply_to_message_id,
         c.actor_id::text AS actor_id,
         c.actor_type,
         ai.canonical_name AS actor_name,
         m.role,
         COALESCE(c.observed_at, m.source_timestamp, m.created_at)::text AS source_timestamp,
         m.content AS excerpt
       FROM canonical_messages c
       JOIN memory_items m ON m.id = c.memory_item_id
       LEFT JOIN actors ai ON ai.actor_id = c.actor_id
       WHERE c.chat_namespace = $1
         AND c.artifact_state = 'published'
         AND c.memory_item_id = ANY($2::uuid[])
         AND ($3::text IS NULL OR lower(COALESCE(c.actor_type, '')) = $3::text)`,
      [chatNamespace, vectorIds, actorTypeFilter]
    );
    const byMemory = new Map<string, Record<string, unknown>>();
    for (const row of rows.rows) {
      byMemory.set(String(row.memory_id ?? ""), row);
    }
    for (const match of vector.matches) {
      const row = byMemory.get(match.id);
      if (!row) continue;
      const normalized = normalizeAnchorRow({
        ...row,
        score: clamp01(Number(match.similarity ?? 0)),
        match_type: "vector"
      });
      const prev = anchors.get(normalized.memoryId);
      if (!prev || normalized.score > prev.score) {
        anchors.set(normalized.memoryId, {
          ...normalized,
          matchType: prev ? "hybrid" : "vector"
        });
      }
    }
  }

  let merged = Array.from(anchors.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, k * 2);

  if (mode === "hybrid_rerank") {
    const queryTokens = query
      .toLowerCase()
      .split(/[^a-z0-9]+/g)
      .map((token) => token.trim())
      .filter((token) => token.length >= 3)
      .slice(0, 8);
    merged = merged
      .map((item) => {
        const text = String(item.excerpt ?? "").toLowerCase();
        const hits = queryTokens.reduce((acc, token) => acc + (text.includes(token) ? 1 : 0), 0);
        const rerank = clamp01(item.score * 0.85 + Math.min(0.15, hits * 0.03));
        return { ...item, score: rerank };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  } else {
    merged = merged.slice(0, k);
  }

  return { ok: true, query, count: merged.length, anchors: merged };
}

export async function fetchContextWindow(params: {
  chatNamespace?: string;
  conversationId: string;
  anchorMessageId: string;
  beforeN?: number;
  afterN?: number;
}): Promise<{ ok: true; count: number; items: V2ContextMessage[] }> {
  const chatNamespace = String(params.chatNamespace ?? "personal.main").trim() || "personal.main";
  const conversationId = String(params.conversationId ?? "").trim();
  const anchorMessageId = String(params.anchorMessageId ?? "").trim();
  if (!conversationId || !anchorMessageId) return { ok: true, count: 0, items: [] };
  const beforeN = Number.isFinite(Number(params.beforeN)) ? Math.max(0, Math.min(50, Number(params.beforeN))) : 5;
  const afterN = Number.isFinite(Number(params.afterN)) ? Math.max(0, Math.min(50, Number(params.afterN))) : 5;

  const rows = await pool.query<Record<string, unknown>>(
      `WITH ordered AS (
       SELECT
         c.id::text AS canonical_id,
         c.memory_item_id::text AS memory_id,
         c.conversation_id,
         NULLIF(c.source_conversation_id, '') AS source_conversation_id,
         NULLIF(COALESCE(c.metadata->>'conversationLabel', m.metadata->>'conversationLabel', ''), '') AS source_conversation_label,
         c.source_message_id,
         c.reply_to_message_id,
         c.actor_id::text AS actor_id,
         c.actor_type,
         ai.canonical_name AS actor_name,
         m.role,
         c.source_system,
         COALESCE(c.observed_at, m.source_timestamp, m.created_at)::text AS source_timestamp,
         m.content AS excerpt,
         ROW_NUMBER() OVER (
           ORDER BY COALESCE(c.observed_at, m.source_timestamp, m.created_at), c.id
         ) AS sequence
       FROM canonical_messages c
       JOIN memory_items m ON m.id = c.memory_item_id
       LEFT JOIN actors ai ON ai.actor_id = c.actor_id
       WHERE c.chat_namespace = $1
         AND c.artifact_state = 'published'
         AND c.conversation_id = $2
     ),
     anchor AS (
       SELECT sequence
       FROM ordered
       WHERE source_message_id = $3 OR canonical_id = $3 OR memory_id = $3
       ORDER BY sequence
       LIMIT 1
     )
     SELECT *
     FROM ordered
     WHERE sequence BETWEEN ((SELECT sequence FROM anchor) - $4) AND ((SELECT sequence FROM anchor) + $5)
     ORDER BY sequence`,
    [chatNamespace, conversationId, anchorMessageId, beforeN, afterN]
  );

  const items = rows.rows.map((row) => normalizeContextRow(row));
  return { ok: true, count: items.length, items };
}

export async function fetchThreadSlice(params: {
  chatNamespace?: string;
  messageId: string;
  direction?: "up" | "down" | "both";
  depth?: number;
}): Promise<{ ok: true; count: number; items: V2ContextMessage[] }> {
  const chatNamespace = String(params.chatNamespace ?? "personal.main").trim() || "personal.main";
  const messageId = String(params.messageId ?? "").trim();
  if (!messageId) return { ok: true, count: 0, items: [] };
  const direction = params.direction ?? "both";
  const depth = Number.isFinite(Number(params.depth)) ? Math.max(1, Math.min(20, Number(params.depth))) : 6;

  const anchor = await pool.query<{ canonical_id: string; source_message_id: string | null; conversation_id: string }>(
    `SELECT c.id::text AS canonical_id, c.source_message_id, c.conversation_id
       FROM canonical_messages c
      WHERE c.chat_namespace = $1
        AND c.artifact_state = 'published'
        AND (c.id::text = $2 OR c.memory_item_id::text = $2 OR c.source_message_id = $2)
      LIMIT 1`,
    [chatNamespace, messageId]
  );
  if (!anchor.rows[0]) return { ok: true, count: 0, items: [] };

  const startMessageId = anchor.rows[0].source_message_id ?? anchor.rows[0].canonical_id;
  const conversationId = anchor.rows[0].conversation_id;

  const upRows = direction === "down"
    ? { rows: [] as Record<string, unknown>[] }
    : await pool.query<Record<string, unknown>>(
        `WITH RECURSIVE up_chain AS (
           SELECT
             c.id::text AS canonical_id,
             c.memory_item_id::text AS memory_id,
             c.conversation_id,
             NULLIF(c.source_conversation_id, '') AS source_conversation_id,
             NULLIF(COALESCE(c.metadata->>'conversationLabel', m.metadata->>'conversationLabel', ''), '') AS source_conversation_label,
             c.source_message_id,
             c.reply_to_message_id,
             c.actor_id::text AS actor_id,
             c.actor_type,
             ai.canonical_name AS actor_name,
             m.role,
             c.source_system,
             COALESCE(c.observed_at, m.source_timestamp, m.created_at)::text AS source_timestamp,
             m.content AS excerpt,
             0::int AS depth,
             0::int AS sequence
           FROM canonical_messages c
           JOIN memory_items m ON m.id = c.memory_item_id
            LEFT JOIN actors ai ON ai.actor_id = c.actor_id
           WHERE c.chat_namespace = $1
             AND c.artifact_state = 'published'
             AND c.conversation_id = $2
             AND c.source_message_id = $3
           UNION ALL
           SELECT
             p.id::text AS canonical_id,
             p.memory_item_id::text AS memory_id,
             p.conversation_id,
             NULLIF(p.source_conversation_id, '') AS source_conversation_id,
             NULLIF(COALESCE(p.metadata->>'conversationLabel', m.metadata->>'conversationLabel', ''), '') AS source_conversation_label,
             p.source_message_id,
             p.reply_to_message_id,
             p.actor_id::text AS actor_id,
             p.actor_type,
             ai.canonical_name AS actor_name,
             m.role,
             p.source_system,
             COALESCE(p.observed_at, m.source_timestamp, m.created_at)::text AS source_timestamp,
             m.content AS excerpt,
             c.depth + 1 AS depth,
             c.sequence - 1 AS sequence
           FROM up_chain c
           JOIN canonical_messages p
             ON p.chat_namespace = $1
            AND p.artifact_state = 'published'
            AND p.conversation_id = $2
            AND p.source_message_id = c.reply_to_message_id
           JOIN memory_items m ON m.id = p.memory_item_id
            LEFT JOIN actors ai ON ai.actor_id = p.actor_id
           WHERE c.depth < $4
         )
         SELECT * FROM up_chain`,
        [chatNamespace, conversationId, startMessageId, depth]
      );

  const downRows = direction === "up"
    ? { rows: [] as Record<string, unknown>[] }
    : await pool.query<Record<string, unknown>>(
        `WITH RECURSIVE down_chain AS (
           SELECT
             c.id::text AS canonical_id,
             c.memory_item_id::text AS memory_id,
             c.conversation_id,
             NULLIF(c.source_conversation_id, '') AS source_conversation_id,
             NULLIF(COALESCE(c.metadata->>'conversationLabel', m.metadata->>'conversationLabel', ''), '') AS source_conversation_label,
             c.source_message_id,
             c.reply_to_message_id,
             c.actor_id::text AS actor_id,
             c.actor_type,
             ai.canonical_name AS actor_name,
             m.role,
             c.source_system,
             COALESCE(c.observed_at, m.source_timestamp, m.created_at)::text AS source_timestamp,
             m.content AS excerpt,
             0::int AS depth,
             0::int AS sequence
           FROM canonical_messages c
           JOIN memory_items m ON m.id = c.memory_item_id
            LEFT JOIN actors ai ON ai.actor_id = c.actor_id
           WHERE c.chat_namespace = $1
             AND c.artifact_state = 'published'
             AND c.conversation_id = $2
             AND c.source_message_id = $3
           UNION ALL
           SELECT
             ch.id::text AS canonical_id,
             ch.memory_item_id::text AS memory_id,
             ch.conversation_id,
             NULLIF(ch.source_conversation_id, '') AS source_conversation_id,
             NULLIF(COALESCE(ch.metadata->>'conversationLabel', m.metadata->>'conversationLabel', ''), '') AS source_conversation_label,
             ch.source_message_id,
             ch.reply_to_message_id,
             ch.actor_id::text AS actor_id,
             ch.actor_type,
             ai.canonical_name AS actor_name,
             m.role,
             ch.source_system,
             COALESCE(ch.observed_at, m.source_timestamp, m.created_at)::text AS source_timestamp,
             m.content AS excerpt,
             c.depth + 1 AS depth,
             c.sequence + 1 AS sequence
           FROM down_chain c
           JOIN canonical_messages ch
             ON ch.chat_namespace = $1
            AND ch.artifact_state = 'published'
            AND ch.conversation_id = $2
            AND ch.reply_to_message_id = c.source_message_id
           JOIN memory_items m ON m.id = ch.memory_item_id
            LEFT JOIN actors ai ON ai.actor_id = ch.actor_id
           WHERE c.depth < $4
         )
         SELECT * FROM down_chain`,
        [chatNamespace, conversationId, startMessageId, depth]
      );

  const merged = new Map<string, V2ContextMessage>();
  for (const row of [...upRows.rows, ...downRows.rows]) {
    const normalized = normalizeContextRow(row);
    if (!normalized.canonicalId) continue;
    merged.set(normalized.canonicalId, normalized);
  }
  const items = Array.from(merged.values()).sort((a, b) => a.sequence - b.sequence);
  return { ok: true, count: items.length, items };
}

export async function searchPublishedFacts(params: {
  query: string;
  chatNamespace?: string;
  limit?: number;
}): Promise<Record<string, unknown>> {
  const query = String(params.query ?? "").trim();
  if (!query) return { ok: true, count: 0, items: [] };
  const chatNamespace = String(params.chatNamespace ?? "personal.main").trim() || "personal.main";
  const limit = Number.isFinite(Number(params.limit)) ? Math.max(1, Math.min(100, Number(params.limit))) : 20;

  const rows = await pool.query(
    `SELECT
       id,
       domain,
       fact_type,
       value_text,
       confidence,
       source_timestamp,
       metadata,
       ts_rank_cd(to_tsvector('simple', value_text), plainto_tsquery('simple', $1)) AS rank
     FROM fact_candidates
     WHERE chat_namespace = $2
       AND artifact_state = 'published'
       AND to_tsvector('simple', value_text) @@ plainto_tsquery('simple', $1)
     ORDER BY rank DESC, confidence DESC, source_timestamp DESC NULLS LAST
     LIMIT $3`,
    [query, chatNamespace, limit]
  );

  return {
    ok: true,
    count: rows.rowCount ?? 0,
    items: rows.rows.map((row: any) => ({
      id: row.id,
      domain: row.domain,
      factType: row.fact_type,
      valueText: row.value_text,
      confidence: Number(row.confidence ?? 0),
      sourceTimestamp: row.source_timestamp ? new Date(row.source_timestamp).toISOString() : null,
      metadata: row.metadata ?? {}
    }))
  };
}

export async function searchPublishedGraph(params: {
  chatNamespace?: string;
  limit?: number;
}): Promise<Record<string, unknown>> {
  const chatNamespace = String(params.chatNamespace ?? "personal.main").trim() || "personal.main";
  const limit = Number.isFinite(Number(params.limit)) ? Math.max(10, Math.min(500, Number(params.limit))) : 120;

  const rows = await pool.query(
    `SELECT
       r.id,
       r.subject_name,
       r.object_name,
       r.relation_type,
       r.weight,
       r.confidence
     FROM relationship_candidates r
     WHERE r.chat_namespace = $1
       AND r.artifact_state = 'published'
     ORDER BY r.weight DESC, r.confidence DESC
     LIMIT $2`,
    [chatNamespace, limit]
  );

  const nodes = new Map<string, { id: string; label: string; value: number; nodeType: string }>();
  const edges = rows.rows.map((row: any) => {
    const source = String(row.subject_name ?? "").trim();
    const target = String(row.object_name ?? "").trim();
    if (source && !nodes.has(source)) {
      nodes.set(source, { id: source, label: source, value: 1, nodeType: "person" });
    }
    if (target && !nodes.has(target)) {
      nodes.set(target, { id: target, label: target, value: 1, nodeType: "person" });
    }
    return {
      id: row.id,
      source,
      target,
      relationType: row.relation_type,
      weight: Number(row.weight ?? 0),
      confidence: Number(row.confidence ?? 0)
    };
  });

  return {
    ok: true,
    graph: {
      id: "published_relationships",
      title: "Published Relationship Graph",
      nodes: Array.from(nodes.values()),
      edges
    }
  };
}
