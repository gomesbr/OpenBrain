import { ensureExtendedSchema } from "../schema.js";
import { pool } from "../db.js";

async function main(): Promise<void> {
  await ensureExtendedSchema();

  const summary = await pool.query<{
    source_system: string;
    total_rows: string;
    v21_rows: string;
    has_domain_scores: string;
    system_events: string;
    short_rows: string;
    mid_rows: string;
    long_rows: string;
    punctuation_only: string;
    lang_unknown: string;
  }>(
    `SELECT
       source_system,
       COUNT(*)::text AS total_rows,
       COUNT(*) FILTER (WHERE COALESCE(metadata->>'inference_version','')='v2.1')::text AS v21_rows,
       COUNT(*) FILTER (WHERE metadata ? 'domain_scores')::text AS has_domain_scores,
       COUNT(*) FILTER (WHERE COALESCE(metadata->>'system_event','false')='true')::text AS system_events,
       COUNT(*) FILTER (WHERE length(content)<80)::text AS short_rows,
       COUNT(*) FILTER (WHERE length(content) BETWEEN 80 AND 219)::text AS mid_rows,
       COUNT(*) FILTER (WHERE length(content)>=220)::text AS long_rows,
       COUNT(*) FILTER (WHERE content ~ '^[[:space:][:punct:][:digit:]]+$')::text AS punctuation_only,
       COUNT(*) FILTER (WHERE COALESCE(metadata->>'language','') IN ('', 'unknown'))::text AS lang_unknown
     FROM memory_items
     GROUP BY source_system
     ORDER BY source_system`
  );

  const taxonomyCoverage = await pool.query<{
    domain: string;
    published_rows: string;
    strong_rows: string;
    avg_score: string;
    max_score: string;
  }>(
    `WITH taxonomy AS (
       SELECT unnest(ARRAY[
         'identity_profile','values_beliefs','personality_traits','emotional_baseline','mental_health_signals',
         'cognitive_style','decision_behavior','attention_productivity','habit_systems','sleep_recovery',
         'nutrition_eating_behavior','exercise_sports','medical_context','substance_use','energy_management',
         'romantic_relationship','family_relationships','friendships','social_graph_dynamics','communication_style',
         'memorable_moments','career_trajectory','work_performance','learning_growth','financial_behavior',
         'lifestyle_environment','leisure_creativity','travel_mobility','life_goals_planning','personal_narrative',
         'digital_behavior','reputation_network_capital','ethics_privacy_boundaries','risk_safety','meaning_spirituality',
         'meta_memory_quality'
       ]::text[]) AS domain
     ),
     expanded AS (
       SELECT d.key AS domain_key, COALESCE(NULLIF(d.value,''),'0')::float8 AS score
       FROM canonical_messages c
       CROSS JOIN LATERAL jsonb_each_text(COALESCE(c.metadata->'domain_scores','{}'::jsonb)) d(key,value)
       WHERE c.artifact_state='published'
     )
     SELECT
       t.domain,
       COUNT(*) FILTER (WHERE e.score > 0)::text AS published_rows,
       COUNT(*) FILTER (WHERE e.score >= 0.28)::text AS strong_rows,
       COALESCE(ROUND(AVG(e.score)::numeric,3),0)::text AS avg_score,
       COALESCE(ROUND(MAX(e.score)::numeric,3),0)::text AS max_score
     FROM taxonomy t
     LEFT JOIN expanded e ON e.domain_key=t.domain
     GROUP BY t.domain
     ORDER BY t.domain`
  );

  const nonTaxonomyKeys = await pool.query<{ domain_key: string; rows: string; strong_rows: string }>(
    `WITH taxonomy AS (
       SELECT unnest(ARRAY[
         'identity_profile','values_beliefs','personality_traits','emotional_baseline','mental_health_signals',
         'cognitive_style','decision_behavior','attention_productivity','habit_systems','sleep_recovery',
         'nutrition_eating_behavior','exercise_sports','medical_context','substance_use','energy_management',
         'romantic_relationship','family_relationships','friendships','social_graph_dynamics','communication_style',
         'memorable_moments','career_trajectory','work_performance','learning_growth','financial_behavior',
         'lifestyle_environment','leisure_creativity','travel_mobility','life_goals_planning','personal_narrative',
         'digital_behavior','reputation_network_capital','ethics_privacy_boundaries','risk_safety','meaning_spirituality',
         'meta_memory_quality'
       ]::text[]) AS domain
     ),
     expanded AS (
       SELECT d.key AS domain_key, COALESCE(NULLIF(d.value,''),'0')::float8 AS score
       FROM canonical_messages c
       CROSS JOIN LATERAL jsonb_each_text(COALESCE(c.metadata->'domain_scores','{}'::jsonb)) d(key,value)
       WHERE c.artifact_state='published'
     )
     SELECT
       e.domain_key,
       COUNT(*)::text AS rows,
       COUNT(*) FILTER (WHERE e.score >= 0.28)::text AS strong_rows
     FROM expanded e
     LEFT JOIN taxonomy t ON t.domain=e.domain_key
     WHERE t.domain IS NULL
     GROUP BY e.domain_key
     ORDER BY COUNT(*) DESC, e.domain_key
     LIMIT 25`
  );

  // eslint-disable-next-line no-console
  console.log(JSON.stringify({
    ok: true,
    generatedAt: new Date().toISOString(),
    summaryBySource: summary.rows,
    taxonomyCoverage: taxonomyCoverage.rows,
    nonTaxonomyDomainKeys: nonTaxonomyKeys.rows
  }, null, 2));
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error("dq_audit failed:", error);
  process.exit(1);
});
