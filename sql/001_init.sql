CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS memory_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  content text NOT NULL,
  embedding vector(1536) NOT NULL,
  role text NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'event')),
  source_system text NOT NULL,
  source_conversation_id text,
  source_message_id text,
  source_timestamp timestamptz,
  chat_namespace text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  content_hash text NOT NULL,
  idempotency_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ingestion_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_system text NOT NULL,
  status text NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'partial')),
  input_ref text,
  summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at timestamptz,
  finished_at timestamptz,
  error_text text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ingestion_job_items (
  id bigserial PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES ingestion_jobs(id) ON DELETE CASCADE,
  item_key text NOT NULL,
  status text NOT NULL CHECK (status IN ('inserted', 'deduped', 'failed')),
  error_text text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_memory_items_embedding_hnsw
  ON memory_items USING hnsw (embedding vector_cosine_ops);

CREATE INDEX IF NOT EXISTS idx_memory_items_metadata_gin
  ON memory_items USING gin (metadata);

CREATE INDEX IF NOT EXISTS idx_memory_items_namespace_source_ts
  ON memory_items(chat_namespace, source_system, source_timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_memory_items_content_hash
  ON memory_items(content_hash);

CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_items_source_tuple
  ON memory_items(source_system, source_conversation_id, source_message_id)
  WHERE source_conversation_id IS NOT NULL AND source_message_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_items_idempotency
  ON memory_items(idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ingestion_jobs_created
  ON ingestion_jobs(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ingestion_job_items_job_created
  ON ingestion_job_items(job_id, created_at DESC);

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS memory_items_set_updated_at ON memory_items;
CREATE TRIGGER memory_items_set_updated_at
  BEFORE UPDATE ON memory_items
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

CREATE OR REPLACE FUNCTION match_memory_items(
  query_embedding vector(1536),
  match_threshold float DEFAULT 0.55,
  match_count int DEFAULT 10,
  namespace_filter text DEFAULT NULL,
  source_filter text DEFAULT NULL,
  role_filter text DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
  content text,
  role text,
  source_system text,
  source_conversation_id text,
  source_message_id text,
  source_timestamp timestamptz,
  chat_namespace text,
  metadata jsonb,
  similarity float,
  created_at timestamptz
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    m.id,
    m.content,
    m.role,
    m.source_system,
    m.source_conversation_id,
    m.source_message_id,
    m.source_timestamp,
    m.chat_namespace,
    m.metadata,
    1 - (m.embedding <=> query_embedding) AS similarity,
    m.created_at
  FROM memory_items m
  WHERE 1 - (m.embedding <=> query_embedding) >= match_threshold
    AND (namespace_filter IS NULL OR m.chat_namespace = namespace_filter)
    AND (source_filter IS NULL OR m.source_system = source_filter)
    AND (role_filter IS NULL OR m.role = role_filter)
  ORDER BY m.embedding <=> query_embedding
  LIMIT GREATEST(match_count, 1);
END;
$$;
