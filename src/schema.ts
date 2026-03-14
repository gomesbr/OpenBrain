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
CREATE INDEX IF NOT EXISTS idx_memory_items_effective_ts
  ON memory_items((COALESCE(source_timestamp, created_at)) DESC);
CREATE INDEX IF NOT EXISTS idx_memory_items_ctx_lookup
  ON memory_items(source_system, source_conversation_id, chat_namespace, (COALESCE(source_timestamp, created_at)) DESC);
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

CREATE TABLE IF NOT EXISTS actors (
  actor_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_name text NOT NULL,
  normalized_name text NOT NULL UNIQUE,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS actor_context (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id uuid NOT NULL REFERENCES actors(actor_id) ON DELETE CASCADE,
  chat_namespace text NOT NULL,
  actor_type text NOT NULL CHECK (actor_type IN ('user', 'contact', 'assistant', 'system', 'unknown')),
  canonical_name text NOT NULL,
  source text,
  confidence double precision NOT NULL DEFAULT 0.5,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (chat_namespace, actor_type, canonical_name)
);

CREATE TABLE IF NOT EXISTS actor_source_profile (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id uuid NOT NULL REFERENCES actors(actor_id) ON DELETE CASCADE,
  chat_namespace text NOT NULL,
  source_system text NOT NULL,
  message_count integer NOT NULL DEFAULT 0,
  first_seen_at timestamptz,
  last_seen_at timestamptz,
  max_quality_score double precision NOT NULL DEFAULT 0,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (actor_id, chat_namespace, source_system)
);

-- Legacy compatibility table kept for existing scripts and prior exports.
CREATE TABLE IF NOT EXISTS actor_identities (
  actor_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_namespace text NOT NULL,
  actor_type text NOT NULL CHECK (actor_type IN ('user', 'contact', 'assistant', 'system', 'unknown')),
  canonical_name text NOT NULL,
  source text,
  confidence double precision NOT NULL DEFAULT 0.5,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (chat_namespace, actor_type, canonical_name)
);

CREATE TABLE IF NOT EXISTS actor_aliases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id uuid NOT NULL REFERENCES actors(actor_id) ON DELETE CASCADE,
  chat_namespace text NOT NULL,
  alias text NOT NULL,
  source_system text,
  confidence double precision NOT NULL DEFAULT 0.5,
  first_seen_at timestamptz,
  last_seen_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (chat_namespace, alias)
);

CREATE TABLE IF NOT EXISTS canonical_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  memory_item_id uuid NOT NULL UNIQUE REFERENCES memory_items(id) ON DELETE CASCADE,
  chat_namespace text NOT NULL,
  conversation_id text NOT NULL DEFAULT '',
  source_conversation_id text,
  source_message_id text,
  reply_to_message_id text,
  actor_id uuid REFERENCES actors(actor_id) ON DELETE SET NULL,
  actor_type text,
  source_system text NOT NULL,
  role text NOT NULL,
  content_normalized text NOT NULL,
  language text NOT NULL DEFAULT 'unknown',
  observed_at timestamptz,
  valid_from timestamptz,
  valid_to timestamptz,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  quality_score double precision NOT NULL DEFAULT 0.5,
  artifact_state text NOT NULL DEFAULT 'candidate' CHECK (artifact_state IN ('candidate', 'validated', 'published', 'deprecated')),
  quality_signals jsonb NOT NULL DEFAULT '{}'::jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE canonical_messages ADD COLUMN IF NOT EXISTS conversation_id text NOT NULL DEFAULT '';
ALTER TABLE canonical_messages ADD COLUMN IF NOT EXISTS source_conversation_id text;
ALTER TABLE canonical_messages ADD COLUMN IF NOT EXISTS source_message_id text;
ALTER TABLE canonical_messages ADD COLUMN IF NOT EXISTS reply_to_message_id text;
ALTER TABLE canonical_messages ADD COLUMN IF NOT EXISTS actor_id uuid;
ALTER TABLE canonical_messages ADD COLUMN IF NOT EXISTS actor_type text;
UPDATE canonical_messages c
   SET actor_id = a.actor_id
  FROM actor_identities ai
  JOIN actors a
    ON a.normalized_name = lower(regexp_replace(regexp_replace(replace(replace(ai.canonical_name, chr(160), ' '), chr(8239), ' '), '^[~\s]+', ''), '\s+', ' ', 'g'))
 WHERE c.actor_id = ai.actor_id
   AND c.actor_id <> a.actor_id;
UPDATE canonical_messages c
   SET actor_id = NULL
 WHERE c.actor_id IS NOT NULL
   AND NOT EXISTS (
     SELECT 1
       FROM actors a
      WHERE a.actor_id = c.actor_id
   );
ALTER TABLE canonical_messages
  DROP CONSTRAINT IF EXISTS canonical_messages_actor_id_fkey;
ALTER TABLE canonical_messages
  ADD CONSTRAINT canonical_messages_actor_id_fkey
  FOREIGN KEY (actor_id) REFERENCES actors(actor_id) ON DELETE SET NULL;

WITH legacy_ranked AS (
  SELECT
    ai.actor_id,
    regexp_replace(replace(replace(ai.canonical_name, chr(160), ' '), chr(8239), ' '), '^[~\s]+', '') AS canonical_name,
    lower(regexp_replace(regexp_replace(replace(replace(ai.canonical_name, chr(160), ' '), chr(8239), ' '), '^[~\s]+', ''), '\s+', ' ', 'g')) AS normalized_name,
    ai.source,
    ai.metadata,
    ai.created_at,
    ai.updated_at,
    ROW_NUMBER() OVER (
      PARTITION BY lower(regexp_replace(regexp_replace(replace(replace(ai.canonical_name, chr(160), ' '), chr(8239), ' '), '^[~\s]+', ''), '\s+', ' ', 'g'))
      ORDER BY ai.confidence DESC NULLS LAST, ai.updated_at DESC NULLS LAST, ai.actor_id
    ) AS rn
  FROM actor_identities ai
  WHERE ai.canonical_name IS NOT NULL
    AND trim(regexp_replace(replace(replace(ai.canonical_name, chr(160), ' '), chr(8239), ' '), '^[~\s]+', '')) <> ''
)
INSERT INTO actors (
  actor_id,
  canonical_name,
  normalized_name,
  metadata,
  created_at,
  updated_at
)
SELECT
  lr.actor_id,
  lr.canonical_name,
  lr.normalized_name,
  jsonb_build_object(
    'legacySource', lr.source,
    'legacyMetadata', COALESCE(lr.metadata, '{}'::jsonb),
    'migratedFrom', 'actor_identities'
  ),
  lr.created_at,
  lr.updated_at
FROM legacy_ranked lr
WHERE lr.rn = 1
  AND NOT EXISTS (
    SELECT 1
      FROM actors existing
     WHERE existing.actor_id = lr.actor_id
  )
ON CONFLICT (normalized_name)
DO UPDATE SET
  canonical_name = EXCLUDED.canonical_name,
  metadata = COALESCE(actors.metadata, '{}'::jsonb) || EXCLUDED.metadata,
  updated_at = now();

INSERT INTO actor_context (
  actor_id,
  chat_namespace,
  actor_type,
  canonical_name,
  source,
  confidence,
  metadata,
  created_at,
  updated_at
)
SELECT
  a.actor_id,
  ai.chat_namespace,
  ai.actor_type,
  regexp_replace(replace(replace(ai.canonical_name, chr(160), ' '), chr(8239), ' '), '^[~\s]+', ''),
  ai.source,
  ai.confidence,
  COALESCE(ai.metadata, '{}'::jsonb),
  ai.created_at,
  ai.updated_at
FROM actor_identities ai
JOIN actors a
  ON a.normalized_name = lower(regexp_replace(regexp_replace(replace(replace(ai.canonical_name, chr(160), ' '), chr(8239), ' '), '^[~\s]+', ''), '\s+', ' ', 'g'))
ON CONFLICT (chat_namespace, actor_type, canonical_name)
DO UPDATE SET
  actor_id = EXCLUDED.actor_id,
  source = EXCLUDED.source,
  confidence = GREATEST(actor_context.confidence, EXCLUDED.confidence),
  metadata = COALESCE(actor_context.metadata, '{}'::jsonb) || EXCLUDED.metadata,
  updated_at = now();

UPDATE actor_aliases aa
   SET actor_id = a.actor_id
  FROM actor_identities ai
  JOIN actors a
    ON a.normalized_name = lower(regexp_replace(regexp_replace(replace(replace(ai.canonical_name, chr(160), ' '), chr(8239), ' '), '^[~\s]+', ''), '\s+', ' ', 'g'))
 WHERE aa.actor_id = ai.actor_id
   AND aa.actor_id <> a.actor_id;

UPDATE canonical_messages c
   SET actor_id = a.actor_id
  FROM actor_identities ai
  JOIN actors a
    ON a.normalized_name = lower(regexp_replace(regexp_replace(replace(replace(ai.canonical_name, chr(160), ' '), chr(8239), ' '), '^[~\s]+', ''), '\s+', ' ', 'g'))
 WHERE c.actor_id = ai.actor_id
   AND c.actor_id <> a.actor_id;

CREATE TABLE IF NOT EXISTS entity_candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_namespace text NOT NULL,
  entity_type text NOT NULL,
  normalized_name text NOT NULL,
  display_name text NOT NULL,
  confidence double precision NOT NULL DEFAULT 0.5,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  artifact_state text NOT NULL DEFAULT 'candidate' CHECK (artifact_state IN ('candidate', 'validated', 'published', 'deprecated')),
  quality_signals jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (chat_namespace, entity_type, normalized_name)
);

CREATE TABLE IF NOT EXISTS fact_candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_namespace text NOT NULL,
  domain text NOT NULL DEFAULT 'other',
  fact_type text NOT NULL,
  value_text text NOT NULL,
  value_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  confidence double precision NOT NULL DEFAULT 0.5,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  artifact_state text NOT NULL DEFAULT 'candidate' CHECK (artifact_state IN ('candidate', 'validated', 'published', 'deprecated')),
  quality_signals jsonb NOT NULL DEFAULT '{}'::jsonb,
  content_hash text NOT NULL,
  source_timestamp timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (chat_namespace, content_hash)
);

CREATE TABLE IF NOT EXISTS relationship_candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_namespace text NOT NULL,
  subject_name text NOT NULL,
  object_name text NOT NULL,
  relation_type text NOT NULL DEFAULT 'interaction',
  weight double precision NOT NULL DEFAULT 1,
  confidence double precision NOT NULL DEFAULT 0.5,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  artifact_state text NOT NULL DEFAULT 'candidate' CHECK (artifact_state IN ('candidate', 'validated', 'published', 'deprecated')),
  quality_signals jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (chat_namespace, subject_name, object_name, relation_type)
);

CREATE TABLE IF NOT EXISTS insight_candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_namespace text NOT NULL,
  insight_pack text NOT NULL,
  insight_type text NOT NULL,
  title text NOT NULL,
  summary text NOT NULL,
  confidence double precision NOT NULL DEFAULT 0.5,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  artifact_state text NOT NULL DEFAULT 'candidate' CHECK (artifact_state IN ('candidate', 'validated', 'published', 'deprecated')),
  quality_signals jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (chat_namespace, insight_pack, insight_type)
);

CREATE TABLE IF NOT EXISTS quarantine_artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  artifact_type text NOT NULL,
  artifact_id uuid,
  reason text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS quality_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  artifact_type text NOT NULL,
  artifact_id uuid,
  decision text NOT NULL CHECK (decision IN ('promote', 'hold', 'reject', 'retry', 'deprecate')),
  confidence double precision NOT NULL DEFAULT 0.5,
  reason_codes text[] NOT NULL DEFAULT '{}'::text[],
  reasoning jsonb NOT NULL DEFAULT '{}'::jsonb,
  decided_by text NOT NULL,
  trace_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS conflict_sets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  domain text NOT NULL,
  key_hash text NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'ignored')),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (domain, key_hash)
);

CREATE TABLE IF NOT EXISTS fact_supersession_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  old_fact_id uuid REFERENCES fact_candidates(id) ON DELETE CASCADE,
  new_fact_id uuid REFERENCES fact_candidates(id) ON DELETE CASCADE,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (old_fact_id, new_fact_id)
);

CREATE TABLE IF NOT EXISTS answer_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trace_id text NOT NULL,
  conversation_id text NOT NULL,
  chat_namespace text NOT NULL,
  question text NOT NULL,
  status text NOT NULL DEFAULT 'running',
  decision text,
  principal_kind text NOT NULL,
  principal_ref text,
  direct_answer text,
  missing_data_statement text,
  estimate_summary text,
  confidence_label text,
  contradiction_callout text,
  definitive_next_data text,
  confirmation_prompt text,
  quality_signals jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS answer_steps (
  id bigserial PRIMARY KEY,
  answer_run_id uuid NOT NULL REFERENCES answer_runs(id) ON DELETE CASCADE,
  step_index integer NOT NULL,
  agent_name text NOT NULL,
  message_type text NOT NULL,
  status text NOT NULL,
  envelope jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS answer_evidence_links (
  id bigserial PRIMARY KEY,
  answer_run_id uuid NOT NULL REFERENCES answer_runs(id) ON DELETE CASCADE,
  memory_item_id uuid REFERENCES memory_items(id) ON DELETE SET NULL,
  canonical_message_id uuid REFERENCES canonical_messages(id) ON DELETE SET NULL,
  fact_candidate_id uuid REFERENCES fact_candidates(id) ON DELETE SET NULL,
  source_message_id text,
  actor_id uuid REFERENCES actors(actor_id) ON DELETE SET NULL,
  source_timestamp timestamptz,
  context_role text,
  anchor_score double precision,
  evidence_rank integer NOT NULL,
  relevance double precision NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE answer_evidence_links ADD COLUMN IF NOT EXISTS canonical_message_id uuid;
ALTER TABLE answer_evidence_links ADD COLUMN IF NOT EXISTS source_message_id text;
ALTER TABLE answer_evidence_links ADD COLUMN IF NOT EXISTS actor_id uuid;
ALTER TABLE answer_evidence_links ADD COLUMN IF NOT EXISTS source_timestamp timestamptz;
ALTER TABLE answer_evidence_links ADD COLUMN IF NOT EXISTS context_role text;
ALTER TABLE answer_evidence_links ADD COLUMN IF NOT EXISTS anchor_score double precision;
ALTER TABLE answer_evidence_links
  DROP CONSTRAINT IF EXISTS answer_evidence_links_canonical_message_id_fkey;
ALTER TABLE answer_evidence_links
  ADD CONSTRAINT answer_evidence_links_canonical_message_id_fkey
  FOREIGN KEY (canonical_message_id) REFERENCES canonical_messages(id) ON DELETE SET NULL;
ALTER TABLE answer_evidence_links
  DROP CONSTRAINT IF EXISTS answer_evidence_links_actor_id_fkey;
ALTER TABLE answer_evidence_links
  ADD CONSTRAINT answer_evidence_links_actor_id_fkey
  FOREIGN KEY (actor_id) REFERENCES actors(actor_id) ON DELETE SET NULL;

UPDATE answer_evidence_links ael
   SET actor_id = a.actor_id
  FROM actor_identities ai
  JOIN actors a
    ON a.normalized_name = lower(regexp_replace(trim(ai.canonical_name), '\s+', ' ', 'g'))
 WHERE ael.actor_id = ai.actor_id
   AND ael.actor_id <> a.actor_id;

INSERT INTO actor_source_profile (
  actor_id,
  chat_namespace,
  source_system,
  message_count,
  first_seen_at,
  last_seen_at,
  max_quality_score,
  metadata,
  created_at,
  updated_at
)
SELECT
  c.actor_id,
  c.chat_namespace,
  c.source_system,
  COUNT(*)::int AS message_count,
  MIN(c.observed_at) AS first_seen_at,
  MAX(c.observed_at) AS last_seen_at,
  COALESCE(MAX(c.quality_score), 0) AS max_quality_score,
  jsonb_build_object(
    'publishedCount', COUNT(*) FILTER (WHERE c.artifact_state = 'published'),
    'candidateCount', COUNT(*) FILTER (WHERE c.artifact_state = 'candidate')
  ),
  now(),
  now()
FROM canonical_messages c
WHERE c.actor_id IS NOT NULL
GROUP BY c.actor_id, c.chat_namespace, c.source_system
ON CONFLICT (actor_id, chat_namespace, source_system)
DO UPDATE SET
  message_count = EXCLUDED.message_count,
  first_seen_at = COALESCE(LEAST(actor_source_profile.first_seen_at, EXCLUDED.first_seen_at), actor_source_profile.first_seen_at, EXCLUDED.first_seen_at),
  last_seen_at = COALESCE(GREATEST(actor_source_profile.last_seen_at, EXCLUDED.last_seen_at), actor_source_profile.last_seen_at, EXCLUDED.last_seen_at),
  max_quality_score = GREATEST(actor_source_profile.max_quality_score, EXCLUDED.max_quality_score),
  metadata = EXCLUDED.metadata,
  updated_at = now();

CREATE TABLE IF NOT EXISTS answer_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  answer_run_id uuid NOT NULL REFERENCES answer_runs(id) ON DELETE CASCADE,
  verdict text NOT NULL,
  correction text,
  corrected_value jsonb NOT NULL DEFAULT '{}'::jsonb,
  as_of_date date,
  scope text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS question_bank (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  benchmark_set text NOT NULL,
  domain text NOT NULL,
  lens text NOT NULL,
  variant integer NOT NULL,
  question text NOT NULL,
  intent_type text NOT NULL,
  expected_contract jsonb NOT NULL DEFAULT '{}'::jsonb,
  required_signals jsonb NOT NULL DEFAULT '{}'::jsonb,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (benchmark_set, domain, lens, variant)
);

CREATE TABLE IF NOT EXISTS expected_answer_contracts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  question_bank_id uuid NOT NULL UNIQUE REFERENCES question_bank(id) ON DELETE CASCADE,
  contract jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS required_data_signals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  question_bank_id uuid NOT NULL UNIQUE REFERENCES question_bank(id) ON DELETE CASCADE,
  signals jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS benchmark_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  benchmark_set text NOT NULL,
  status text NOT NULL,
  total_cases integer NOT NULL DEFAULT 0,
  answered integer NOT NULL DEFAULT 0,
  partial integer NOT NULL DEFAULT 0,
  insufficient integer NOT NULL DEFAULT 0,
  contradiction_rate double precision NOT NULL DEFAULT 0,
  calibration_score double precision NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);

CREATE TABLE IF NOT EXISTS coverage_support_matrix_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES benchmark_runs(id) ON DELETE CASCADE,
  domain text NOT NULL,
  lens text NOT NULL,
  total integer NOT NULL DEFAULT 0,
  answered integer NOT NULL DEFAULT 0,
  partial integer NOT NULL DEFAULT 0,
  insufficient integer NOT NULL DEFAULT 0,
  contradiction_rate double precision NOT NULL DEFAULT 0,
  calibration_score double precision NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS gap_backlog_ranked_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES benchmark_runs(id) ON DELETE CASCADE,
  capability_category text NOT NULL,
  gap_count integer NOT NULL DEFAULT 0,
  priority_score double precision NOT NULL DEFAULT 0,
  sample_questions jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS service_identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_name text NOT NULL UNIQUE,
  description text,
  is_active boolean NOT NULL DEFAULT true,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS service_permissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_id uuid NOT NULL REFERENCES service_identities(id) ON DELETE CASCADE,
  namespace_pattern text NOT NULL,
  domain text NOT NULL,
  operation text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (service_id, namespace_pattern, domain, operation)
);

CREATE TABLE IF NOT EXISTS service_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_id uuid NOT NULL REFERENCES service_identities(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS api_audit_events (
  id bigserial PRIMARY KEY,
  trace_id text NOT NULL,
  service_id uuid REFERENCES service_identities(id) ON DELETE SET NULL,
  session_actor text,
  method text NOT NULL,
  path text NOT NULL,
  status_code integer NOT NULL,
  operation text,
  namespace text,
  request_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  response_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_text text,
  duration_ms integer,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS experiment_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  chat_namespace text NOT NULL DEFAULT 'personal.main',
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  target_pass_rate double precision NOT NULL DEFAULT 0.90,
  critical_target_pass_rate double precision NOT NULL DEFAULT 0.93,
  per_domain_floor double precision NOT NULL DEFAULT 0.75,
  latency_gate_multiplier double precision NOT NULL DEFAULT 1.50,
  cost_gate_multiplier double precision NOT NULL DEFAULT 1.50,
  dataset_version text NOT NULL DEFAULT '',
  strategy_cursor integer NOT NULL DEFAULT 0,
  winner_strategy_id text,
  winner_variant_id text,
  notes text,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE experiment_runs
  ADD COLUMN IF NOT EXISTS terminal_state text NOT NULL DEFAULT 'normal' CHECK (terminal_state IN ('normal', 'interrupted', 'aborted'));
ALTER TABLE experiment_runs
  ADD COLUMN IF NOT EXISTS interrupted_at timestamptz;
ALTER TABLE experiment_runs
  ADD COLUMN IF NOT EXISTS aborted_at timestamptz;
ALTER TABLE experiment_runs
  ADD COLUMN IF NOT EXISTS benchmark_stage text NOT NULL DEFAULT 'draft'
    CHECK (benchmark_stage IN ('draft', 'core_ready', 'selection_ready', 'certification_ready'));
ALTER TABLE experiment_runs
  ADD COLUMN IF NOT EXISTS active_benchmark_lock_version text;
ALTER TABLE experiment_runs
  ADD COLUMN IF NOT EXISTS autonomous_mode boolean NOT NULL DEFAULT true;
ALTER TABLE experiment_runs
  ADD COLUMN IF NOT EXISTS human_input_allowed boolean NOT NULL DEFAULT false;
ALTER TABLE experiment_runs
  ADD COLUMN IF NOT EXISTS benchmark_generated_at timestamptz;
ALTER TABLE experiment_runs
  ADD COLUMN IF NOT EXISTS benchmark_support_scanned_at timestamptz;
ALTER TABLE experiment_runs
  ADD COLUMN IF NOT EXISTS benchmark_stale boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS experiment_strategies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  experiment_id uuid NOT NULL REFERENCES experiment_runs(id) ON DELETE CASCADE,
  strategy_id text NOT NULL,
  variant_id text NOT NULL,
  label text NOT NULL,
  position integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'completed', 'failed', 'skipped')),
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (experiment_id, variant_id)
);

ALTER TABLE experiment_strategies
  ADD COLUMN IF NOT EXISTS hypothesis_id uuid;
ALTER TABLE experiment_strategies
  ADD COLUMN IF NOT EXISTS experiment_role text NOT NULL DEFAULT 'explore' CHECK (experiment_role IN ('treatment', 'control', 'explore'));
ALTER TABLE experiment_strategies
  ADD COLUMN IF NOT EXISTS parent_strategy_variant_id uuid;
ALTER TABLE experiment_strategies
  ADD COLUMN IF NOT EXISTS parent_hypothesis_id uuid;
ALTER TABLE experiment_strategies
  ADD COLUMN IF NOT EXISTS modified_components text[] NOT NULL DEFAULT '{}'::text[];
ALTER TABLE experiment_strategies
  ADD COLUMN IF NOT EXISTS lineage_reason text;

CREATE TABLE IF NOT EXISTS experiment_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  experiment_id uuid NOT NULL REFERENCES experiment_runs(id) ON DELETE CASCADE,
  case_set text NOT NULL CHECK (case_set IN ('dev', 'critical', 'certification', 'stress', 'coverage')),
  case_key text NOT NULL,
  case_type text NOT NULL,
  domain text NOT NULL,
  lens text NOT NULL,
  question text NOT NULL,
  chat_namespace text NOT NULL,
  expected_contract jsonb NOT NULL DEFAULT '{}'::jsonb,
  expected_core_claims jsonb NOT NULL DEFAULT '[]'::jsonb,
  evidence_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  conversation_ids text[] NOT NULL DEFAULT '{}'::text[],
  actor_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  fact_id uuid,
  source_evidence_id uuid,
  taxonomy_path text,
  acceptable_answer_forms jsonb NOT NULL DEFAULT '[]'::jsonb,
  required_evidence_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  difficulty_type text NOT NULL DEFAULT 'direct',
  generation_method text NOT NULL DEFAULT 'reverse_engineered',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_stale boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (experiment_id, case_set, case_key)
);

ALTER TABLE experiment_cases
  ADD COLUMN IF NOT EXISTS fact_id uuid;
ALTER TABLE experiment_cases
  ADD COLUMN IF NOT EXISTS source_evidence_id uuid;
ALTER TABLE experiment_cases
  ADD COLUMN IF NOT EXISTS taxonomy_path text;
ALTER TABLE experiment_cases
  ADD COLUMN IF NOT EXISTS acceptable_answer_forms jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE experiment_cases
  ADD COLUMN IF NOT EXISTS required_evidence_ids uuid[] NOT NULL DEFAULT '{}'::uuid[];
ALTER TABLE experiment_cases
  ADD COLUMN IF NOT EXISTS difficulty_type text NOT NULL DEFAULT 'direct';
ALTER TABLE experiment_cases
  ADD COLUMN IF NOT EXISTS generation_method text NOT NULL DEFAULT 'reverse_engineered';
ALTER TABLE experiment_cases
  ADD COLUMN IF NOT EXISTS ambiguity_class text NOT NULL DEFAULT 'clear'
    CHECK (ambiguity_class IN ('clear', 'clarify_required', 'unresolved'));
ALTER TABLE experiment_cases
  ADD COLUMN IF NOT EXISTS owner_validation_state text NOT NULL DEFAULT 'pending'
    CHECK (owner_validation_state IN ('pending', 'approved', 'rejected', 'not_required'));
ALTER TABLE experiment_cases
  ADD COLUMN IF NOT EXISTS clarification_quality_expected boolean NOT NULL DEFAULT false;
ALTER TABLE experiment_cases
  ADD COLUMN IF NOT EXISTS benchmark_lock_version text;
ALTER TABLE experiment_cases
  ADD COLUMN IF NOT EXISTS eligible_for_scoring boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS experiment_case_results (
  id bigserial PRIMARY KEY,
  experiment_id uuid NOT NULL REFERENCES experiment_runs(id) ON DELETE CASCADE,
  strategy_variant_id uuid NOT NULL REFERENCES experiment_strategies(id) ON DELETE CASCADE,
  case_id uuid NOT NULL REFERENCES experiment_cases(id) ON DELETE CASCADE,
  case_set text NOT NULL,
  pass boolean NOT NULL DEFAULT false,
  score double precision NOT NULL DEFAULT 0,
  latency_ms integer NOT NULL DEFAULT 0,
  estimated_cost_per_1k double precision NOT NULL DEFAULT 0,
  failure_buckets text[] NOT NULL DEFAULT '{}'::text[],
  response jsonb NOT NULL DEFAULT '{}'::jsonb,
  returned_evidence_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (strategy_variant_id, case_id)
);
ALTER TABLE experiment_case_results
  ADD COLUMN IF NOT EXISTS clarification_triggered boolean NOT NULL DEFAULT false;
ALTER TABLE experiment_case_results
  ADD COLUMN IF NOT EXISTS clarification_quality_score double precision NOT NULL DEFAULT 0;
ALTER TABLE experiment_case_results
  ADD COLUMN IF NOT EXISTS scoring_bucket text NOT NULL DEFAULT 'clear'
    CHECK (scoring_bucket IN ('clear', 'clarify', 'unresolved_excluded'));

CREATE TABLE IF NOT EXISTS benchmark_lock_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  experiment_id uuid NOT NULL REFERENCES experiment_runs(id) ON DELETE CASCADE,
  lock_version text NOT NULL,
  lock_stage text NOT NULL DEFAULT 'draft'
    CHECK (lock_stage IN ('draft', 'core_ready', 'selection_ready', 'certification_ready')),
  included_clear integer NOT NULL DEFAULT 0,
  included_clarify integer NOT NULL DEFAULT 0,
  unresolved integer NOT NULL DEFAULT 0,
  total_included integer NOT NULL DEFAULT 0,
  checksum text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (experiment_id, lock_version)
);

ALTER TABLE benchmark_lock_versions
  ADD COLUMN IF NOT EXISTS lock_stage text NOT NULL DEFAULT 'draft'
    CHECK (lock_stage IN ('draft', 'core_ready', 'selection_ready', 'certification_ready'));

CREATE TABLE IF NOT EXISTS taxonomy_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version_key text NOT NULL UNIQUE,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'published' CHECK (status IN ('published', 'archived')),
  source_chat_namespace text NOT NULL DEFAULT 'personal.main',
  parent_version_id uuid REFERENCES taxonomy_versions(id) ON DELETE SET NULL,
  scan_completed_at timestamptz,
  published_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS taxonomy_domains (
  id bigserial PRIMARY KEY,
  taxonomy_version_id uuid NOT NULL REFERENCES taxonomy_versions(id) ON DELETE CASCADE,
  domain_key text NOT NULL,
  label text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deprecated')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (taxonomy_version_id, domain_key)
);

CREATE TABLE IF NOT EXISTS taxonomy_lenses (
  id bigserial PRIMARY KEY,
  taxonomy_version_id uuid NOT NULL REFERENCES taxonomy_versions(id) ON DELETE CASCADE,
  lens_key text NOT NULL,
  label text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deprecated')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (taxonomy_version_id, lens_key)
);

CREATE TABLE IF NOT EXISTS taxonomy_pair_support (
  id bigserial PRIMARY KEY,
  taxonomy_version_id uuid NOT NULL REFERENCES taxonomy_versions(id) ON DELETE CASCADE,
  chat_namespace text NOT NULL DEFAULT 'personal.main',
  domain_key text NOT NULL,
  lens_key text NOT NULL,
  support_status text NOT NULL DEFAULT 'unsupported' CHECK (support_status IN ('supported', 'unsupported')),
  evidence_count integer NOT NULL DEFAULT 0,
  support_count integer NOT NULL DEFAULT 0,
  avg_domain_score double precision NOT NULL DEFAULT 0,
  sample_evidence_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  sample_conversation_ids text[] NOT NULL DEFAULT '{}'::text[],
  rationale text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (taxonomy_version_id, chat_namespace, domain_key, lens_key)
);

CREATE TABLE IF NOT EXISTS taxonomy_candidate_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  taxonomy_version_id uuid NOT NULL REFERENCES taxonomy_versions(id) ON DELETE CASCADE,
  candidate_type text NOT NULL CHECK (
    candidate_type IN ('new_domain_candidate', 'new_lens_candidate', 'merge_candidate', 'split_candidate', 'unmapped_cluster')
  ),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'deferred')),
  source_domain_key text,
  source_lens_key text,
  proposed_key text,
  title text NOT NULL,
  rationale text NOT NULL,
  recommendation_confidence double precision NOT NULL DEFAULT 0.5,
  evidence_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  conversation_ids text[] NOT NULL DEFAULT '{}'::text[],
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  review_notes text,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS taxonomy_facet_coverage (
  id bigserial PRIMARY KEY,
  taxonomy_version_id uuid NOT NULL REFERENCES taxonomy_versions(id) ON DELETE CASCADE,
  chat_namespace text NOT NULL DEFAULT 'personal.main',
  facet_type text NOT NULL CHECK (
    facet_type IN ('actor_name', 'group_label', 'thread_title', 'source_system', 'month_bucket')
  ),
  facet_key text NOT NULL,
  facet_label text NOT NULL,
  coverage_status text NOT NULL DEFAULT 'sparse' CHECK (
    coverage_status IN ('covered', 'gap', 'sparse')
  ),
  evidence_count integer NOT NULL DEFAULT 0,
  conversation_count integer NOT NULL DEFAULT 0,
  benchmark_case_count integer NOT NULL DEFAULT 0,
  sample_evidence_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  sample_conversation_ids text[] NOT NULL DEFAULT '{}'::text[],
  rationale text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (taxonomy_version_id, chat_namespace, facet_type, facet_key)
);

ALTER TABLE experiment_runs
  ADD COLUMN IF NOT EXISTS taxonomy_version_id uuid REFERENCES taxonomy_versions(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS experiment_failures (
  id bigserial PRIMARY KEY,
  experiment_id uuid NOT NULL REFERENCES experiment_runs(id) ON DELETE CASCADE,
  strategy_variant_id uuid NOT NULL REFERENCES experiment_strategies(id) ON DELETE CASCADE,
  case_id uuid NOT NULL REFERENCES experiment_cases(id) ON DELETE CASCADE,
  bucket text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS experiment_winner_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  experiment_id uuid NOT NULL REFERENCES experiment_runs(id) ON DELETE CASCADE,
  strategy_variant_id uuid NOT NULL REFERENCES experiment_strategies(id) ON DELETE CASCADE,
  strategy_id text NOT NULL,
  variant_id text NOT NULL,
  pass_rate double precision NOT NULL DEFAULT 0,
  p95_latency_ms double precision NOT NULL DEFAULT 0,
  estimated_cost_per_1k double precision NOT NULL DEFAULT 0,
  decision text NOT NULL CHECK (decision IN ('winner', 'candidate', 'rejected')),
  decision_layer text NOT NULL DEFAULT 'exploratory'
    CHECK (decision_layer IN ('exploratory', 'provisional', 'certification')),
  composite_score double precision NOT NULL DEFAULT 0,
  gate_results jsonb NOT NULL DEFAULT '{}'::jsonb,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE experiment_winner_decisions
  ADD COLUMN IF NOT EXISTS decision_layer text NOT NULL DEFAULT 'exploratory'
    CHECK (decision_layer IN ('exploratory', 'provisional', 'certification'));
ALTER TABLE experiment_winner_decisions
  ADD COLUMN IF NOT EXISTS composite_score double precision NOT NULL DEFAULT 0;
ALTER TABLE experiment_winner_decisions
  ADD COLUMN IF NOT EXISTS gate_results jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS hypotheses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  experiment_id uuid NOT NULL REFERENCES experiment_runs(id) ON DELETE CASCADE,
  title text NOT NULL,
  failure_pattern jsonb NOT NULL DEFAULT '{}'::jsonb,
  causal_claim text NOT NULL,
  predicted_metric_changes jsonb NOT NULL DEFAULT '{}'::jsonb,
  confidence double precision NOT NULL DEFAULT 0.5,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'confirmed', 'partially_confirmed', 'rejected')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  ALTER TABLE experiment_strategies
    ADD CONSTRAINT fk_experiment_strategies_hypothesis
    FOREIGN KEY (hypothesis_id) REFERENCES hypotheses(id) ON DELETE SET NULL;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END$$;

DO $$
BEGIN
  ALTER TABLE experiment_strategies
    ADD CONSTRAINT fk_experiment_strategies_parent_hypothesis
    FOREIGN KEY (parent_hypothesis_id) REFERENCES hypotheses(id) ON DELETE SET NULL;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END$$;

DO $$
BEGIN
  ALTER TABLE experiment_strategies
    ADD CONSTRAINT fk_experiment_strategies_parent_strategy
    FOREIGN KEY (parent_strategy_variant_id) REFERENCES experiment_strategies(id) ON DELETE SET NULL;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END$$;

CREATE TABLE IF NOT EXISTS hypothesis_predictions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hypothesis_id uuid NOT NULL REFERENCES hypotheses(id) ON DELETE CASCADE,
  metric_key text NOT NULL,
  comparator text NOT NULL CHECK (comparator IN ('gte', 'lte', 'delta_gte', 'delta_lte')),
  target_value double precision NOT NULL,
  weight double precision NOT NULL DEFAULT 1.0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS hypothesis_experiments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hypothesis_id uuid NOT NULL REFERENCES hypotheses(id) ON DELETE CASCADE,
  strategy_variant_id uuid NOT NULL REFERENCES experiment_strategies(id) ON DELETE CASCADE,
  experiment_role text NOT NULL CHECK (experiment_role IN ('treatment', 'control', 'explore')),
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (hypothesis_id, strategy_variant_id)
);

CREATE TABLE IF NOT EXISTS hypothesis_updates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hypothesis_id uuid NOT NULL REFERENCES hypotheses(id) ON DELETE CASCADE,
  strategy_variant_id uuid NOT NULL REFERENCES experiment_strategies(id) ON DELETE CASCADE,
  decision text NOT NULL CHECK (decision IN ('confirmed', 'partially_confirmed', 'rejected')),
  confidence_before double precision NOT NULL,
  confidence_after double precision NOT NULL,
  metric_deltas jsonb NOT NULL DEFAULT '{}'::jsonb,
  rationale text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS component_registry (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  component_type text NOT NULL,
  component_name text NOT NULL,
  version integer NOT NULL DEFAULT 1,
  is_core boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deprecated')),
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (component_type, component_name, version)
);

CREATE TABLE IF NOT EXISTS strategy_component_bindings (
  id bigserial PRIMARY KEY,
  experiment_id uuid NOT NULL REFERENCES experiment_runs(id) ON DELETE CASCADE,
  strategy_variant_id uuid NOT NULL REFERENCES experiment_strategies(id) ON DELETE CASCADE,
  component_type text NOT NULL,
  component_id uuid NOT NULL REFERENCES component_registry(id) ON DELETE CASCADE,
  binding_order integer NOT NULL DEFAULT 0,
  is_core boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (strategy_variant_id, component_type, binding_order)
);

CREATE TABLE IF NOT EXISTS component_performance (
  id bigserial PRIMARY KEY,
  experiment_id uuid REFERENCES experiment_runs(id) ON DELETE CASCADE,
  component_id uuid NOT NULL REFERENCES component_registry(id) ON DELETE CASCADE,
  domain text NOT NULL DEFAULT '__all__',
  lens text NOT NULL DEFAULT '__all__',
  difficulty_type text NOT NULL DEFAULT 'mixed',
  case_set text NOT NULL DEFAULT 'all',
  runs integer NOT NULL DEFAULT 0,
  pass_rate double precision NOT NULL DEFAULT 0,
  avg_score double precision NOT NULL DEFAULT 0,
  recall_at_k double precision NOT NULL DEFAULT 0,
  mrr double precision NOT NULL DEFAULT 0,
  ndcg double precision NOT NULL DEFAULT 0,
  evidence_hit_rate double precision NOT NULL DEFAULT 0,
  latency_ms_p95 double precision NOT NULL DEFAULT 0,
  cost_per_1k double precision NOT NULL DEFAULT 0,
  confidence double precision NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (component_id, domain, lens, difficulty_type, case_set)
);

CREATE TABLE IF NOT EXISTS component_stability (
  component_id uuid PRIMARY KEY REFERENCES component_registry(id) ON DELETE CASCADE,
  runs integer NOT NULL DEFAULT 0,
  pass_rate_stddev double precision NOT NULL DEFAULT 0,
  component_stability_score double precision NOT NULL DEFAULT 0,
  confidence double precision NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS component_pair_performance (
  id bigserial PRIMARY KEY,
  component_a_id uuid NOT NULL REFERENCES component_registry(id) ON DELETE CASCADE,
  component_b_id uuid NOT NULL REFERENCES component_registry(id) ON DELETE CASCADE,
  domain text NOT NULL DEFAULT '__all__',
  difficulty_type text NOT NULL DEFAULT 'mixed',
  runs integer NOT NULL DEFAULT 0,
  joint_score double precision NOT NULL DEFAULT 0,
  confidence double precision NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (component_a_id, component_b_id, domain, difficulty_type)
);

CREATE TABLE IF NOT EXISTS strategy_lessons (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  experiment_id uuid NOT NULL REFERENCES experiment_runs(id) ON DELETE CASCADE,
  strategy_variant_id uuid REFERENCES experiment_strategies(id) ON DELETE SET NULL,
  hypothesis_id uuid REFERENCES hypotheses(id) ON DELETE SET NULL,
  lesson_type text NOT NULL DEFAULT 'strategy',
  failure_reason text,
  causal_explanation text,
  affected_domains text[] NOT NULL DEFAULT '{}'::text[],
  affected_taxonomies text[] NOT NULL DEFAULT '{}'::text[],
  recommendation text,
  confidence double precision NOT NULL DEFAULT 0.5,
  evidence_refs jsonb NOT NULL DEFAULT '{}'::jsonb,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS experiment_governance_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  experiment_id uuid NOT NULL REFERENCES experiment_runs(id) ON DELETE CASCADE,
  strategy_variant_id uuid REFERENCES experiment_strategies(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  severity text NOT NULL DEFAULT 'warning' CHECK (severity IN ('info', 'warning', 'error')),
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS experiment_judge_calibration_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  experiment_id uuid NOT NULL REFERENCES experiment_runs(id) ON DELETE CASCADE,
  case_id uuid REFERENCES experiment_cases(id) ON DELETE SET NULL,
  strategy_variant_id uuid REFERENCES experiment_strategies(id) ON DELETE SET NULL,
  question text NOT NULL,
  expected_answer jsonb NOT NULL DEFAULT '{}'::jsonb,
  expected_evidence_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  sample_type text NOT NULL DEFAULT 'benchmark_case',
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'labeled', 'skipped')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS experiment_judge_calibration_labels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  calibration_item_id uuid NOT NULL REFERENCES experiment_judge_calibration_items(id) ON DELETE CASCADE,
  reviewer text NOT NULL DEFAULT 'owner',
  verdict text NOT NULL CHECK (verdict IN ('yes', 'no')),
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (calibration_item_id, reviewer)
);

CREATE INDEX IF NOT EXISTS idx_canonical_messages_namespace_observed
  ON canonical_messages(chat_namespace, observed_at DESC, artifact_state);
CREATE INDEX IF NOT EXISTS idx_canonical_messages_conversation_seq
  ON canonical_messages(chat_namespace, conversation_id, observed_at, source_message_id);
CREATE INDEX IF NOT EXISTS idx_canonical_messages_actor_ts
  ON canonical_messages(chat_namespace, actor_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_canonical_messages_reply_to
  ON canonical_messages(chat_namespace, conversation_id, reply_to_message_id);
CREATE INDEX IF NOT EXISTS idx_canonical_messages_content_trgm
  ON canonical_messages USING gin (content_normalized gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_canonical_messages_content_tsv
  ON canonical_messages USING gin (to_tsvector('simple', content_normalized));
CREATE INDEX IF NOT EXISTS idx_canonical_messages_primary_domain
  ON canonical_messages((metadata->>'primary_domain'));
CREATE INDEX IF NOT EXISTS idx_canonical_messages_domain_top_gin
  ON canonical_messages USING gin ((metadata->'domain_top'));
CREATE INDEX IF NOT EXISTS idx_actor_identities_lookup
  ON actor_identities(chat_namespace, actor_type, canonical_name);
CREATE INDEX IF NOT EXISTS idx_actors_name_lookup
  ON actors(normalized_name, canonical_name);
CREATE INDEX IF NOT EXISTS idx_actor_context_lookup
  ON actor_context(chat_namespace, actor_type, canonical_name, actor_id);
CREATE INDEX IF NOT EXISTS idx_actor_source_profile_lookup
  ON actor_source_profile(chat_namespace, source_system, actor_id);
CREATE INDEX IF NOT EXISTS idx_actor_aliases_lookup
  ON actor_aliases(chat_namespace, alias);
CREATE INDEX IF NOT EXISTS idx_entity_candidates_state
  ON entity_candidates(chat_namespace, artifact_state, confidence DESC);
CREATE INDEX IF NOT EXISTS idx_fact_candidates_state
  ON fact_candidates(chat_namespace, artifact_state, confidence DESC, source_timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_relationship_candidates_state
  ON relationship_candidates(chat_namespace, artifact_state, confidence DESC);
CREATE INDEX IF NOT EXISTS idx_quality_decisions_trace
  ON quality_decisions(trace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_answer_runs_trace
  ON answer_runs(trace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_answer_steps_run
  ON answer_steps(answer_run_id, step_index);
CREATE INDEX IF NOT EXISTS idx_question_bank_lookup
  ON question_bank(benchmark_set, domain, lens, variant);
CREATE INDEX IF NOT EXISTS idx_benchmark_runs_recent
  ON benchmark_runs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_api_audit_events_created
  ON api_audit_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_api_audit_events_trace
  ON api_audit_events(trace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_answer_evidence_links_run_rank
  ON answer_evidence_links(answer_run_id, evidence_rank);
CREATE INDEX IF NOT EXISTS idx_answer_evidence_links_actor_ts
  ON answer_evidence_links(actor_id, source_timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_experiment_runs_status_created
  ON experiment_runs(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_experiment_runs_taxonomy_version
  ON experiment_runs(taxonomy_version_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_experiment_strategies_lookup
  ON experiment_strategies(experiment_id, position, status);
CREATE INDEX IF NOT EXISTS idx_experiment_cases_lookup
  ON experiment_cases(experiment_id, case_set, domain, lens);
CREATE INDEX IF NOT EXISTS idx_experiment_cases_lock
  ON experiment_cases(experiment_id, benchmark_lock_version, ambiguity_class, eligible_for_scoring);
CREATE INDEX IF NOT EXISTS idx_taxonomy_versions_status_published
  ON taxonomy_versions(status, published_at DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_taxonomy_domains_version
  ON taxonomy_domains(taxonomy_version_id, domain_key);
CREATE INDEX IF NOT EXISTS idx_taxonomy_lenses_version
  ON taxonomy_lenses(taxonomy_version_id, lens_key);
CREATE INDEX IF NOT EXISTS idx_taxonomy_pair_support_lookup
  ON taxonomy_pair_support(taxonomy_version_id, chat_namespace, domain_key, lens_key);
CREATE INDEX IF NOT EXISTS idx_taxonomy_pair_support_status
  ON taxonomy_pair_support(taxonomy_version_id, support_status, domain_key, lens_key);
CREATE INDEX IF NOT EXISTS idx_taxonomy_candidate_reviews_lookup
  ON taxonomy_candidate_reviews(taxonomy_version_id, status, candidate_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_taxonomy_facet_coverage_lookup
  ON taxonomy_facet_coverage(taxonomy_version_id, chat_namespace, facet_type, coverage_status, evidence_count DESC);
CREATE INDEX IF NOT EXISTS idx_experiment_case_results_strategy
  ON experiment_case_results(experiment_id, strategy_variant_id, case_set);
CREATE INDEX IF NOT EXISTS idx_benchmark_lock_versions_experiment
  ON benchmark_lock_versions(experiment_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_experiment_failures_bucket
  ON experiment_failures(experiment_id, strategy_variant_id, bucket);
CREATE INDEX IF NOT EXISTS idx_experiment_winner_decisions_recent
  ON experiment_winner_decisions(experiment_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_hypotheses_experiment_status
  ON hypotheses(experiment_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_hypothesis_updates_recent
  ON hypothesis_updates(hypothesis_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_component_registry_type_status
  ON component_registry(component_type, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_strategy_component_bindings_lookup
  ON strategy_component_bindings(experiment_id, strategy_variant_id, component_type);
CREATE INDEX IF NOT EXISTS idx_component_performance_lookup
  ON component_performance(component_id, domain, lens, difficulty_type, case_set);
CREATE INDEX IF NOT EXISTS idx_component_stability_score
  ON component_stability(component_stability_score DESC, runs DESC);
CREATE INDEX IF NOT EXISTS idx_component_pair_performance_lookup
  ON component_pair_performance(component_a_id, component_b_id, domain, difficulty_type);
CREATE INDEX IF NOT EXISTS idx_strategy_lessons_lookup
  ON strategy_lessons(experiment_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_governance_events_lookup
  ON experiment_governance_events(experiment_id, created_at DESC, severity);
CREATE INDEX IF NOT EXISTS idx_experiment_judge_calibration_items_lookup
  ON experiment_judge_calibration_items(experiment_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_experiment_judge_calibration_labels_lookup
  ON experiment_judge_calibration_labels(calibration_item_id, created_at DESC);

DROP TRIGGER IF EXISTS canonical_messages_set_updated_at ON canonical_messages;
CREATE TRIGGER canonical_messages_set_updated_at
  BEFORE UPDATE ON canonical_messages
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS actor_identities_set_updated_at ON actor_identities;
CREATE TRIGGER actor_identities_set_updated_at
  BEFORE UPDATE ON actor_identities
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS actors_set_updated_at ON actors;
CREATE TRIGGER actors_set_updated_at
  BEFORE UPDATE ON actors
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS actor_context_set_updated_at ON actor_context;
CREATE TRIGGER actor_context_set_updated_at
  BEFORE UPDATE ON actor_context
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS actor_source_profile_set_updated_at ON actor_source_profile;
CREATE TRIGGER actor_source_profile_set_updated_at
  BEFORE UPDATE ON actor_source_profile
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS entity_candidates_set_updated_at ON entity_candidates;
CREATE TRIGGER entity_candidates_set_updated_at
  BEFORE UPDATE ON entity_candidates
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS fact_candidates_set_updated_at ON fact_candidates;
CREATE TRIGGER fact_candidates_set_updated_at
  BEFORE UPDATE ON fact_candidates
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS relationship_candidates_set_updated_at ON relationship_candidates;
CREATE TRIGGER relationship_candidates_set_updated_at
  BEFORE UPDATE ON relationship_candidates
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS insight_candidates_set_updated_at ON insight_candidates;
CREATE TRIGGER insight_candidates_set_updated_at
  BEFORE UPDATE ON insight_candidates
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS conflict_sets_set_updated_at ON conflict_sets;
CREATE TRIGGER conflict_sets_set_updated_at
  BEFORE UPDATE ON conflict_sets
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS answer_runs_set_updated_at ON answer_runs;
CREATE TRIGGER answer_runs_set_updated_at
  BEFORE UPDATE ON answer_runs
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS service_identities_set_updated_at ON service_identities;
CREATE TRIGGER service_identities_set_updated_at
  BEFORE UPDATE ON service_identities
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS experiment_runs_set_updated_at ON experiment_runs;
CREATE TRIGGER experiment_runs_set_updated_at
  BEFORE UPDATE ON experiment_runs
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS experiment_strategies_set_updated_at ON experiment_strategies;
CREATE TRIGGER experiment_strategies_set_updated_at
  BEFORE UPDATE ON experiment_strategies
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS experiment_cases_set_updated_at ON experiment_cases;
CREATE TRIGGER experiment_cases_set_updated_at
  BEFORE UPDATE ON experiment_cases
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS hypotheses_set_updated_at ON hypotheses;
CREATE TRIGGER hypotheses_set_updated_at
  BEFORE UPDATE ON hypotheses
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS component_registry_set_updated_at ON component_registry;
CREATE TRIGGER component_registry_set_updated_at
  BEFORE UPDATE ON component_registry
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS component_performance_set_updated_at ON component_performance;
CREATE TRIGGER component_performance_set_updated_at
  BEFORE UPDATE ON component_performance
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS component_pair_performance_set_updated_at ON component_pair_performance;
CREATE TRIGGER component_pair_performance_set_updated_at
  BEFORE UPDATE ON component_pair_performance
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS taxonomy_versions_set_updated_at ON taxonomy_versions;
CREATE TRIGGER taxonomy_versions_set_updated_at
  BEFORE UPDATE ON taxonomy_versions
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS taxonomy_domains_set_updated_at ON taxonomy_domains;
CREATE TRIGGER taxonomy_domains_set_updated_at
  BEFORE UPDATE ON taxonomy_domains
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS taxonomy_lenses_set_updated_at ON taxonomy_lenses;
CREATE TRIGGER taxonomy_lenses_set_updated_at
  BEFORE UPDATE ON taxonomy_lenses
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS taxonomy_pair_support_set_updated_at ON taxonomy_pair_support;
CREATE TRIGGER taxonomy_pair_support_set_updated_at
  BEFORE UPDATE ON taxonomy_pair_support
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS taxonomy_candidate_reviews_set_updated_at ON taxonomy_candidate_reviews;
CREATE TRIGGER taxonomy_candidate_reviews_set_updated_at
  BEFORE UPDATE ON taxonomy_candidate_reviews
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS taxonomy_facet_coverage_set_updated_at ON taxonomy_facet_coverage;
CREATE TRIGGER taxonomy_facet_coverage_set_updated_at
  BEFORE UPDATE ON taxonomy_facet_coverage
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS experiment_judge_calibration_items_set_updated_at ON experiment_judge_calibration_items;
CREATE TRIGGER experiment_judge_calibration_items_set_updated_at
  BEFORE UPDATE ON experiment_judge_calibration_items
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS metadata_enrichment_queue (
  id bigserial PRIMARY KEY,
  memory_item_id uuid NOT NULL UNIQUE REFERENCES memory_items(id) ON DELETE CASCADE,
  chat_namespace text,
  source_system text NOT NULL,
  source_timestamp timestamptz,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'done', 'failed')),
  attempt_count integer NOT NULL DEFAULT 0,
  last_error text,
  locked_by text,
  locked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_meta_enrich_queue_status
  ON metadata_enrichment_queue(status, source_system, chat_namespace, source_timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_meta_enrich_queue_locked
  ON metadata_enrichment_queue(status, locked_at);

DROP TRIGGER IF EXISTS metadata_enrichment_queue_set_updated_at ON metadata_enrichment_queue;
CREATE TRIGGER metadata_enrichment_queue_set_updated_at
  BEFORE UPDATE ON metadata_enrichment_queue
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();
`;

export async function ensureExtendedSchema(): Promise<void> {
  const lockKey = 99422631;
  await pool.query("SELECT pg_advisory_lock($1)", [lockKey]);
  try {
    await pool.query(SCHEMA_SQL);
  } finally {
    await pool.query("SELECT pg_advisory_unlock($1)", [lockKey]);
  }
}
