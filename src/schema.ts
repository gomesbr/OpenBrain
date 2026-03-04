import { pool } from "./db.js";

const SCHEMA_SQL = `
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE IF NOT EXISTS auth_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_name text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  rotated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS brain_entities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_namespace text NOT NULL,
  entity_type text NOT NULL,
  normalized_name text NOT NULL,
  display_name text NOT NULL,
  weight double precision NOT NULL DEFAULT 1,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (chat_namespace, entity_type, normalized_name)
);

CREATE TABLE IF NOT EXISTS brain_entity_aliases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_namespace text NOT NULL,
  entity_type text NOT NULL,
  alias_normalized text NOT NULL,
  entity_id uuid NOT NULL REFERENCES brain_entities(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (chat_namespace, entity_type, alias_normalized)
);

CREATE TABLE IF NOT EXISTS brain_relationship_edges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_namespace text NOT NULL,
  subject_entity_id uuid NOT NULL REFERENCES brain_entities(id) ON DELETE CASCADE,
  object_entity_id uuid NOT NULL REFERENCES brain_entities(id) ON DELETE CASCADE,
  relation_type text NOT NULL,
  weight double precision NOT NULL DEFAULT 0,
  interaction_count integer NOT NULL DEFAULT 0,
  first_seen_at timestamptz,
  last_seen_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (chat_namespace, subject_entity_id, object_entity_id, relation_type)
);

CREATE TABLE IF NOT EXISTS brain_facts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_namespace text NOT NULL,
  domain text NOT NULL,
  fact_type text NOT NULL,
  subject_entity_id uuid REFERENCES brain_entities(id) ON DELETE SET NULL,
  object_entity_id uuid REFERENCES brain_entities(id) ON DELETE SET NULL,
  value_text text NOT NULL,
  value_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  confidence double precision NOT NULL DEFAULT 0.5,
  source_timestamp timestamptz,
  content_hash text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS brain_fact_evidence (
  id bigserial PRIMARY KEY,
  fact_id uuid NOT NULL REFERENCES brain_facts(id) ON DELETE CASCADE,
  memory_item_id uuid NOT NULL REFERENCES memory_items(id) ON DELETE CASCADE,
  evidence_weight double precision NOT NULL DEFAULT 1,
  excerpt text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (fact_id, memory_item_id)
);

CREATE TABLE IF NOT EXISTS brain_daily_rollups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  day date NOT NULL,
  chat_namespace text NOT NULL,
  domain text NOT NULL,
  metric_key text NOT NULL,
  metric_value double precision NOT NULL DEFAULT 0,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (day, chat_namespace, domain, metric_key)
);

CREATE TABLE IF NOT EXISTS brain_insight_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_namespace text NOT NULL,
  insight_pack text NOT NULL,
  insight_type text NOT NULL,
  title text NOT NULL,
  summary text NOT NULL,
  confidence double precision NOT NULL DEFAULT 0.5,
  action_text text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (chat_namespace, insight_pack, insight_type)
);

CREATE TABLE IF NOT EXISTS brain_query_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  query_id text NOT NULL,
  verdict text NOT NULL,
  correction text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS brain_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_type text NOT NULL,
  status text NOT NULL,
  requested_by text NOT NULL DEFAULT 'system',
  scope jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at timestamptz,
  finished_at timestamptz,
  error_text text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS brain_job_items (
  id bigserial PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES brain_jobs(id) ON DELETE CASCADE,
  memory_item_id uuid REFERENCES memory_items(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'pending',
  attempt_count integer NOT NULL DEFAULT 0,
  error_text text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_brain_jobs_running_incremental
  ON brain_jobs(job_type)
  WHERE status = 'running' AND job_type = 'incremental';

CREATE INDEX IF NOT EXISTS idx_memory_items_content_trgm
  ON memory_items USING gin (content gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_memory_items_source_ts
  ON memory_items(source_timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_brain_entities_namespace_type
  ON brain_entities(chat_namespace, entity_type, weight DESC);
CREATE INDEX IF NOT EXISTS idx_brain_edges_namespace
  ON brain_relationship_edges(chat_namespace, weight DESC);
CREATE INDEX IF NOT EXISTS idx_brain_facts_domain_ts
  ON brain_facts(chat_namespace, domain, source_timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_brain_rollups_day
  ON brain_daily_rollups(chat_namespace, day DESC, domain);
CREATE INDEX IF NOT EXISTS idx_brain_insight_pack
  ON brain_insight_snapshots(chat_namespace, insight_pack, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_brain_job_items_status
  ON brain_job_items(status, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_brain_job_items_job_status
  ON brain_job_items(job_id, status, created_at ASC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_brain_job_items_unique_item
  ON brain_job_items(job_id, memory_item_id)
  WHERE memory_item_id IS NOT NULL;

DROP TRIGGER IF EXISTS auth_users_set_updated_at ON auth_users;
CREATE TRIGGER auth_users_set_updated_at
  BEFORE UPDATE ON auth_users
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS brain_entities_set_updated_at ON brain_entities;
CREATE TRIGGER brain_entities_set_updated_at
  BEFORE UPDATE ON brain_entities
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS brain_relationship_edges_set_updated_at ON brain_relationship_edges;
CREATE TRIGGER brain_relationship_edges_set_updated_at
  BEFORE UPDATE ON brain_relationship_edges
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS brain_facts_set_updated_at ON brain_facts;
CREATE TRIGGER brain_facts_set_updated_at
  BEFORE UPDATE ON brain_facts
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS brain_daily_rollups_set_updated_at ON brain_daily_rollups;
CREATE TRIGGER brain_daily_rollups_set_updated_at
  BEFORE UPDATE ON brain_daily_rollups
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS brain_insight_snapshots_set_updated_at ON brain_insight_snapshots;
CREATE TRIGGER brain_insight_snapshots_set_updated_at
  BEFORE UPDATE ON brain_insight_snapshots
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS brain_jobs_set_updated_at ON brain_jobs;
CREATE TRIGGER brain_jobs_set_updated_at
  BEFORE UPDATE ON brain_jobs
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS brain_job_items_set_updated_at ON brain_job_items;
CREATE TRIGGER brain_job_items_set_updated_at
  BEFORE UPDATE ON brain_job_items
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();
`;

export async function ensureExtendedSchema(): Promise<void> {
  await pool.query(SCHEMA_SQL);
}
