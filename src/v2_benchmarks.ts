import { randomUUID } from "node:crypto";
import { pool } from "./db.js";
import type {
  V2BenchGenerateRequest,
  V2BenchRunRequest,
  V2BenchSignalProfileRequest
} from "./v2_types.js";

const TAXONOMY_DOMAINS = [
  "identity_profile",
  "values_beliefs",
  "personality_traits",
  "emotional_baseline",
  "mental_health_signals",
  "cognitive_style",
  "decision_behavior",
  "attention_productivity",
  "habit_systems",
  "sleep_recovery",
  "nutrition_eating_behavior",
  "exercise_sports",
  "medical_context",
  "substance_use",
  "energy_management",
  "romantic_relationship",
  "family_relationships",
  "friendships",
  "social_graph_dynamics",
  "communication_style",
  "memorable_moments",
  "career_trajectory",
  "work_performance",
  "learning_growth",
  "financial_behavior",
  "lifestyle_environment",
  "leisure_creativity",
  "travel_mobility",
  "life_goals_planning",
  "personal_narrative",
  "digital_behavior",
  "reputation_network_capital",
  "ethics_privacy_boundaries",
  "risk_safety",
  "meaning_spirituality",
  "meta_memory_quality"
] as const;

const ANALYSIS_LENSES = [
  "descriptive",
  "diagnostic",
  "predictive",
  "prescriptive",
  "causal_hypotheses",
  "trend_trajectory",
  "outlier_detection",
  "counterfactuals",
  "confidence_scoring",
  "actionability"
] as const;

interface DomainSignalRow {
  domain: string;
  published_rows: number;
  scored_rows: number;
  avg_score: number;
  max_score: number;
  source_breakdown: Record<string, number>;
}

function buildQuestion(domain: string, lens: string, variant: number): string {
  return `(${domain}) (${lens}) Variant ${variant}: what is the best supported conclusion from my memory?`;
}

function expectedContractTemplate(): Record<string, unknown> {
  return {
    decision: true,
    intentSummary: true,
    requiresClarification: true,
    clarificationQuestion: true,
    assumptionsUsed: true,
    constraintChecks: true,
    finalAnswer: true,
    status: true
  };
}

function requiredSignalsTemplate(domain: string, lens: string): Record<string, unknown> {
  return {
    domain,
    lens,
    requiresTemporalReasoning: ["trend_trajectory", "predictive", "counterfactuals"].includes(lens),
    requiresContradictionHandling: ["confidence_scoring", "diagnostic"].includes(lens),
    requiresActionOutput: ["prescriptive", "actionability"].includes(lens)
  };
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

async function computeDomainSignalProfile(params: {
  chatNamespace: string;
  minDomainScore: number;
}): Promise<DomainSignalRow[]> {
  const rows = await pool.query<{
    domain: string;
    published_rows: string;
    scored_rows: string;
    avg_score: string;
    max_score: string;
    source_breakdown: Record<string, unknown>;
  }>(
    `WITH src AS (
       SELECT
         c.chat_namespace,
         c.source_system,
         c.metadata
       FROM canonical_messages c
       WHERE c.artifact_state = 'published'
         AND c.chat_namespace = $1
     ),
     expanded AS (
       SELECT
         s.source_system,
         d.key::text AS domain,
         LEAST(1.0, GREATEST(0.0, COALESCE(NULLIF(d.value, '')::float8, 0.0))) AS score
       FROM src s
       CROSS JOIN LATERAL jsonb_each_text(COALESCE(s.metadata->'domain_scores', '{}'::jsonb)) d(key, value)
     ),
     top_expanded AS (
       SELECT
         s.source_system,
         top.value::text AS domain,
         0.35::float8 AS score
       FROM src s
       CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(s.metadata->'domain_top', '[]'::jsonb)) top(value)
     ),
     combined AS (
       SELECT * FROM expanded
       UNION ALL
       SELECT * FROM top_expanded
     ),
     agg AS (
       SELECT
         domain,
         COUNT(*) FILTER (WHERE score > 0)::int AS published_rows,
         COUNT(*) FILTER (WHERE score >= $2)::int AS scored_rows,
         AVG(score)::float8 AS avg_score,
         MAX(score)::float8 AS max_score
       FROM combined
       WHERE domain = ANY($3::text[])
       GROUP BY domain
     ),
     src_agg AS (
       SELECT
         domain,
         source_system,
         COUNT(*) FILTER (WHERE score >= $2)::int AS c
       FROM combined
       GROUP BY domain, source_system
     ),
     canonical_domain AS (
       SELECT
         a.domain,
         a.published_rows,
         a.scored_rows,
         COALESCE(a.avg_score, 0)::float8 AS avg_score,
         COALESCE(a.max_score, 0)::float8 AS max_score,
         COALESCE(
           (
             SELECT jsonb_object_agg(sa.source_system, sa.c)
             FROM src_agg sa
             WHERE sa.domain = a.domain
           ),
           '{}'::jsonb
         ) AS source_breakdown
       FROM agg a
     ),
     fact_domain AS (
       SELECT
         f.domain,
         COUNT(*)::int AS published_rows,
         COUNT(*) FILTER (WHERE f.confidence >= $2)::int AS scored_rows,
         COALESCE(AVG(f.confidence), 0)::float8 AS avg_score,
         COALESCE(MAX(f.confidence), 0)::float8 AS max_score,
         jsonb_build_object('fact_candidates', COUNT(*)::int) AS source_breakdown
       FROM fact_candidates f
       WHERE f.chat_namespace = $1
         AND f.artifact_state IN ('candidate', 'validated', 'published')
         AND f.domain = ANY($3::text[])
       GROUP BY f.domain
     )
     SELECT
       COALESCE(c.domain, f.domain) AS domain,
       (COALESCE(c.published_rows, 0) + COALESCE(f.published_rows, 0))::text AS published_rows,
       (COALESCE(c.scored_rows, 0) + COALESCE(f.scored_rows, 0))::text AS scored_rows,
       (
         CASE
           WHEN (COALESCE(c.published_rows, 0) + COALESCE(f.published_rows, 0)) = 0 THEN 0
           ELSE (
             (COALESCE(c.avg_score, 0) * COALESCE(c.published_rows, 0))
             + (COALESCE(f.avg_score, 0) * COALESCE(f.published_rows, 0))
           ) / NULLIF(COALESCE(c.published_rows, 0) + COALESCE(f.published_rows, 0), 0)
         END
       )::text AS avg_score,
       GREATEST(COALESCE(c.max_score, 0), COALESCE(f.max_score, 0))::text AS max_score,
       COALESCE(c.source_breakdown, '{}'::jsonb) || COALESCE(f.source_breakdown, '{}'::jsonb) AS source_breakdown
     FROM canonical_domain c
     FULL OUTER JOIN fact_domain f ON f.domain = c.domain
     ORDER BY
       (COALESCE(c.scored_rows, 0) + COALESCE(f.scored_rows, 0)) DESC,
       GREATEST(COALESCE(c.max_score, 0), COALESCE(f.max_score, 0)) DESC,
       COALESCE(c.domain, f.domain) ASC`,
    [params.chatNamespace, params.minDomainScore, TAXONOMY_DOMAINS]
  );

  return rows.rows.map((row) => ({
    domain: row.domain,
    published_rows: Number(row.published_rows ?? 0),
    scored_rows: Number(row.scored_rows ?? 0),
    avg_score: Number(row.avg_score ?? 0),
    max_score: Number(row.max_score ?? 0),
    source_breakdown:
      row.source_breakdown && typeof row.source_breakdown === "object"
        ? Object.fromEntries(
            Object.entries(row.source_breakdown).map(([k, v]) => [k, Number(v ?? 0)])
          )
        : {}
  }));
}

export async function benchmarkSignalProfile(input: V2BenchSignalProfileRequest): Promise<Record<string, unknown>> {
  const chatNamespace = String(input.chatNamespace ?? "personal.main").trim() || "personal.main";
  const benchmarkSet = String(input.benchmarkSet ?? "baseline_3600").trim() || "baseline_3600";
  const minDomainScore = clamp01(Number(input.minDomainScore ?? 0.28));
  const minDomainRows = Number.isFinite(Number(input.minDomainRows))
    ? Math.max(1, Math.min(500000, Number(input.minDomainRows)))
    : 80;

  const profile = await computeDomainSignalProfile({ chatNamespace, minDomainScore });
  const activeDomains = new Set(
    profile
      .filter((row) => row.scored_rows >= minDomainRows)
      .map((row) => row.domain)
  );
  const inactiveDomains = TAXONOMY_DOMAINS.filter((domain) => !activeDomains.has(domain));

  const benchmarkRows = await pool.query<{ total: string; active: string }>(
    `SELECT
       COUNT(*)::text AS total,
       COUNT(*) FILTER (WHERE active = true)::text AS active
     FROM question_bank
     WHERE benchmark_set = $1`,
    [benchmarkSet]
  );
  const totalScenarios = Number(benchmarkRows.rows[0]?.total ?? 0);
  const activeScenarios = Number(benchmarkRows.rows[0]?.active ?? 0);

  return {
    ok: true,
    benchmarkSet,
    chatNamespace,
    minDomainScore,
    minDomainRows,
    profile,
    activeDomains: Array.from(activeDomains).sort(),
    inactiveDomains,
    totalScenarios,
    activeScenarios
  };
}

export async function activateBenchmarksBySignal(input: V2BenchSignalProfileRequest): Promise<Record<string, unknown>> {
  const benchmarkSet = String(input.benchmarkSet ?? "baseline_3600").trim() || "baseline_3600";
  const chatNamespace = String(input.chatNamespace ?? "personal.main").trim() || "personal.main";
  const minDomainScore = clamp01(Number(input.minDomainScore ?? 0.28));
  const minDomainRows = Number.isFinite(Number(input.minDomainRows))
    ? Math.max(1, Math.min(500000, Number(input.minDomainRows)))
    : 80;

  const profile = await computeDomainSignalProfile({ chatNamespace, minDomainScore });
  const activeDomains = profile
    .filter((row) => row.scored_rows >= minDomainRows)
    .map((row) => row.domain);

  await pool.query(
    `UPDATE question_bank
        SET active = (domain = ANY($2::text[]))
      WHERE benchmark_set = $1`,
    [benchmarkSet, activeDomains]
  );

  const counts = await pool.query<{ total: string; active: string }>(
    `SELECT
       COUNT(*)::text AS total,
       COUNT(*) FILTER (WHERE active = true)::text AS active
      FROM question_bank
      WHERE benchmark_set = $1`,
    [benchmarkSet]
  );

  return {
    ok: true,
    benchmarkSet,
    chatNamespace,
    minDomainScore,
    minDomainRows,
    selectedDomains: activeDomains.sort(),
    totalScenarios: Number(counts.rows[0]?.total ?? 0),
    activeScenarios: Number(counts.rows[0]?.active ?? 0)
  };
}

export async function generateBenchmarks(input: V2BenchGenerateRequest): Promise<Record<string, unknown>> {
  const benchmarkSet = String(input.benchmarkSet ?? "baseline_3600").trim() || "baseline_3600";
  const variants = Number.isFinite(Number(input.variantsPerDomainLens))
    ? Math.max(1, Math.min(100, Number(input.variantsPerDomainLens)))
    : 10;

  let inserted = 0;
  for (const domain of TAXONOMY_DOMAINS) {
    for (const lens of ANALYSIS_LENSES) {
      for (let variant = 1; variant <= variants; variant += 1) {
        const question = buildQuestion(domain, lens, variant);
        const row = await pool.query<{ id: string }>(
          `INSERT INTO question_bank (
             benchmark_set,
             domain,
             lens,
             variant,
             question,
             intent_type,
             expected_contract,
             required_signals,
             active
           ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, true)
           ON CONFLICT (benchmark_set, domain, lens, variant)
           DO UPDATE SET question = EXCLUDED.question, expected_contract = EXCLUDED.expected_contract, required_signals = EXCLUDED.required_signals
           RETURNING id`,
          [
            benchmarkSet,
            domain,
            lens,
            variant,
            question,
            lens,
            JSON.stringify(expectedContractTemplate()),
            JSON.stringify(requiredSignalsTemplate(domain, lens))
          ]
        );
        const questionId = row.rows[0]?.id;
        if (!questionId) continue;
        inserted += 1;

        await pool.query(
          `INSERT INTO expected_answer_contracts (question_bank_id, contract)
           VALUES ($1, $2::jsonb)
           ON CONFLICT (question_bank_id)
           DO UPDATE SET contract = EXCLUDED.contract`,
          [questionId, JSON.stringify(expectedContractTemplate())]
        );
        await pool.query(
          `INSERT INTO required_data_signals (question_bank_id, signals)
           VALUES ($1, $2::jsonb)
           ON CONFLICT (question_bank_id)
           DO UPDATE SET signals = EXCLUDED.signals`,
          [questionId, JSON.stringify(requiredSignalsTemplate(domain, lens))]
        );
      }
    }
  }

  return {
    ok: true,
    benchmarkSet,
    inserted,
    totalDomains: TAXONOMY_DOMAINS.length,
    totalLenses: ANALYSIS_LENSES.length,
    variantsPerDomainLens: variants,
    totalScenarios: TAXONOMY_DOMAINS.length * ANALYSIS_LENSES.length * variants
  };
}

function classifyResult(matchCount: number): "answered" | "partial" | "insufficient" {
  if (matchCount >= 4) return "answered";
  if (matchCount >= 1) return "partial";
  return "insufficient";
}

async function estimateScenarioEvidence(params: {
  chatNamespace: string;
  domain: string;
  question: string;
  limit?: number;
}): Promise<{ count: number; timestamps: string[] }> {
  const rows = await pool.query<{ ts: string | null }>(
    `SELECT
       COALESCE(m.source_timestamp, m.created_at)::text AS ts
     FROM canonical_messages c
     JOIN memory_items m ON m.id = c.memory_item_id
     WHERE c.chat_namespace = $1
       AND c.artifact_state = 'published'
       AND (
         lower(c.content_normalized) % lower($2)
         OR lower(c.content_normalized) LIKE '%' || lower($2) || '%'
         OR (
           CASE
             WHEN COALESCE(c.metadata->'domain_scores'->>$3, '') ~ '^[0-9]+(\\.[0-9]+)?$'
             THEN (c.metadata->'domain_scores'->>$3)::float8
             ELSE 0
           END
         ) >= 0.22
         OR EXISTS (
           SELECT 1
           FROM jsonb_array_elements_text(COALESCE(c.metadata->'domain_top', '[]'::jsonb)) t(v)
           WHERE t.v = $3
         )
       )
     ORDER BY
       GREATEST(similarity(lower(c.content_normalized), lower($2)), 0) DESC,
       COALESCE(c.observed_at, c.recorded_at) DESC
     LIMIT $4`,
    [params.chatNamespace, params.question, params.domain, Math.max(4, Math.min(40, Number(params.limit ?? 12)))]
  );

  return {
    count: rows.rowCount ?? 0,
    timestamps: rows.rows.map((row) => String(row.ts ?? "")).filter((ts) => ts.length > 0)
  };
}

export async function runBenchmark(input: V2BenchRunRequest): Promise<Record<string, unknown>> {
  const benchmarkSet = String(input.benchmarkSet ?? "baseline_3600").trim() || "baseline_3600";
  const limit = Number.isFinite(Number(input.limit)) ? Math.max(1, Math.min(36000, Number(input.limit))) : 3600;
  const chatNamespace = String(input.chatNamespace ?? "personal.main").trim() || "personal.main";
  const minDomainScore = clamp01(Number(input.minDomainScore ?? 0.28));
  const minDomainRows = Number.isFinite(Number(input.minDomainRows))
    ? Math.max(1, Math.min(500000, Number(input.minDomainRows)))
    : 80;
  const dataAwareOnly = Boolean(input.dataAwareOnly);
  const runId = randomUUID();

  let dataAwareDomains: string[] = [];
  if (dataAwareOnly) {
    const profile = await computeDomainSignalProfile({ chatNamespace, minDomainScore });
    dataAwareDomains = profile
      .filter((row) => row.scored_rows >= minDomainRows)
      .map((row) => row.domain);
  }

  await pool.query(
    `INSERT INTO benchmark_runs (
       id,
       benchmark_set,
       status,
       total_cases,
       answered,
       partial,
       insufficient,
       contradiction_rate,
       calibration_score,
       created_at
     ) VALUES ($1::uuid, $2, 'running', 0, 0, 0, 0, 0, 0, now())`,
    [runId, benchmarkSet]
  );

  const scenarios = await pool.query<{
    id: string;
    domain: string;
    lens: string;
    question: string;
  }>(
    `SELECT id, domain, lens, question
       FROM question_bank
      WHERE benchmark_set = $1
        AND active = true
        AND (
          $3::boolean = false
          OR domain = ANY($4::text[])
        )
      ORDER BY domain, lens, variant
      LIMIT $2`,
    [benchmarkSet, limit, dataAwareOnly, dataAwareDomains]
  );

  let answered = 0;
  let partial = 0;
  let insufficient = 0;
  let contradictionCount = 0;

  const counters = new Map<string, { total: number; answered: number; partial: number; insufficient: number }>();

  for (const scenario of scenarios.rows) {
    const result = await estimateScenarioEvidence({
      question: scenario.question,
      domain: scenario.domain,
      chatNamespace,
      limit: 12
    });

    const status = classifyResult(result.count);
    if (status === "answered") answered += 1;
    else if (status === "partial") partial += 1;
    else insufficient += 1;

    if (result.count >= 2) {
      const dates = result.timestamps;
      if (dates.length >= 2) {
        const first = Date.parse(String(dates[0]));
        const last = Date.parse(String(dates[dates.length - 1]));
        if (Number.isFinite(first) && Number.isFinite(last) && Math.abs(first - last) > 365 * 86400000 * 2) {
          contradictionCount += 1;
        }
      }
    }

    const key = `${scenario.domain}|${scenario.lens}`;
    const agg = counters.get(key) ?? { total: 0, answered: 0, partial: 0, insufficient: 0 };
    agg.total += 1;
    if (status === "answered") agg.answered += 1;
    if (status === "partial") agg.partial += 1;
    if (status === "insufficient") agg.insufficient += 1;
    counters.set(key, agg);
  }

  const contradictionRate = scenarios.rowCount ? contradictionCount / scenarios.rowCount : 0;
  const calibrationScore = scenarios.rowCount ? (answered + partial * 0.5) / scenarios.rowCount : 0;

  for (const [key, agg] of counters.entries()) {
    const [domain, lens] = key.split("|");
    await pool.query(
      `INSERT INTO coverage_support_matrix_snapshots (
         run_id,
         domain,
         lens,
         total,
         answered,
         partial,
         insufficient,
         contradiction_rate,
         calibration_score
       ) VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [runId, domain, lens, agg.total, agg.answered, agg.partial, agg.insufficient, contradictionRate, calibrationScore]
    );
  }

  await pool.query(
    `UPDATE benchmark_runs
        SET status = 'completed',
            total_cases = $2,
            answered = $3,
            partial = $4,
            insufficient = $5,
            contradiction_rate = $6,
            calibration_score = $7,
            finished_at = now()
      WHERE id = $1::uuid`,
    [runId, scenarios.rowCount, answered, partial, insufficient, contradictionRate, calibrationScore]
  );

  const gapCategories: Array<{ capability: string; count: number; score: number }> = [
    { capability: "insufficient_evidence", count: insufficient, score: insufficient * 1.0 },
    { capability: "partial_synthesis", count: partial, score: partial * 0.6 },
    { capability: "contradiction_handling", count: contradictionCount, score: contradictionCount * 0.8 }
  ];

  for (const gap of gapCategories) {
    await pool.query(
      `INSERT INTO gap_backlog_ranked_snapshots (
         run_id,
         capability_category,
         gap_count,
         priority_score,
         sample_questions
       ) VALUES ($1::uuid, $2, $3, $4, $5::jsonb)`,
      [runId, gap.capability, gap.count, gap.score, JSON.stringify([])]
    );
  }

  return {
    ok: true,
    runId,
    benchmarkSet,
    chatNamespace,
    total: scenarios.rowCount,
    answered,
    partial,
    insufficient,
    contradictionRate,
    calibrationScore,
    dataAwareOnly,
    selectedDomains: dataAwareDomains
  };
}

export async function benchmarkReport(params: { runId?: string; benchmarkSet?: string; limit?: number }): Promise<Record<string, unknown>> {
  const limit = Number.isFinite(Number(params.limit)) ? Math.max(1, Math.min(1000, Number(params.limit))) : 300;
  let runRows;
  if (params.runId) {
    runRows = await pool.query(`SELECT * FROM benchmark_runs WHERE id = $1::uuid LIMIT 1`, [params.runId]);
  } else {
    runRows = await pool.query(
      `SELECT *
         FROM benchmark_runs
        WHERE ($1::text IS NULL OR benchmark_set = $1)
        ORDER BY created_at DESC
        LIMIT 1`,
      [params.benchmarkSet ?? null]
    );
  }

  const run = runRows.rows[0];
  if (!run) {
    return { ok: true, report: null, matrix: [], gaps: [] };
  }

  const matrixRows = await pool.query(
    `SELECT domain, lens, total, answered, partial, insufficient, contradiction_rate, calibration_score
       FROM coverage_support_matrix_snapshots
      WHERE run_id = $1::uuid
      ORDER BY domain, lens
      LIMIT $2`,
    [run.id, limit]
  );

  const gapRows = await pool.query(
    `SELECT capability_category, gap_count, priority_score, sample_questions, created_at
       FROM gap_backlog_ranked_snapshots
      WHERE run_id = $1::uuid
      ORDER BY priority_score DESC, gap_count DESC
      LIMIT 100`,
    [run.id]
  );

  return {
    ok: true,
    report: {
      runId: run.id,
      benchmarkSet: run.benchmark_set,
      status: run.status,
      totalCases: Number(run.total_cases ?? 0),
      answered: Number(run.answered ?? 0),
      partial: Number(run.partial ?? 0),
      insufficient: Number(run.insufficient ?? 0),
      contradictionRate: Number(run.contradiction_rate ?? 0),
      calibrationScore: Number(run.calibration_score ?? 0),
      createdAt: run.created_at ? new Date(run.created_at).toISOString() : null,
      finishedAt: run.finished_at ? new Date(run.finished_at).toISOString() : null
    },
    matrix: matrixRows.rows,
    gaps: gapRows.rows
  };
}
