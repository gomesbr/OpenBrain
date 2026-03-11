import { experimentStatus, runExperimentStep } from "../v2_experiments.js";
import { pool } from "../db.js";
import { ensureExtendedSchema } from "../schema.js";

function readArg(prefix: string): string | undefined {
  return process.argv.find((arg) => arg.startsWith(prefix))?.split("=")[1];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error ?? "unknown_error");
}

async function runTimeoutRepairSequence(params: {
  experimentId: string;
  caseSet: "dev" | "critical" | "certification" | "all";
  result: Record<string, unknown>;
  step: number;
}): Promise<void> {
  const runtime = (params.result.runtime ?? {}) as Record<string, unknown>;
  const timeoutCount = Number(runtime.timeoutCount ?? 0);
  if (!Number.isFinite(timeoutCount) || timeoutCount <= 0) return;

  // eslint-disable-next-line no-console
  console.warn(JSON.stringify({
    ok: false,
    done: false,
    reason: "timeout_detected_repair_sequence",
    step: params.step,
    timeoutCount
  }, null, 2));

  // System-side repair.
  await pool.query("ANALYZE memory_items");
  await pool.query("ANALYZE canonical_messages");

  const retryVariantId = String(
    (params.result.retryVariantId ?? params.result.agentRetryVariantId ?? params.result.rescueVariantId ?? "")
  ).trim();
  if (!retryVariantId) return;

  const retryResult = await runExperimentStep({
    experimentId: params.experimentId,
    caseSet: params.caseSet,
    variantId: retryVariantId
  });
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({
    step: params.step,
    timeoutRepairRetry: {
      variantId: retryVariantId,
      result: retryResult
    }
  }, null, 2));
}

async function markStrategyFailedAndAdvance(params: {
  experimentId: string;
  variantId?: string;
  strategyId?: string;
  reason: string;
}): Promise<boolean> {
  if (!params.variantId) return false;
  const detail = {
    loopRecovery: true,
    loopRecoveryAt: new Date().toISOString(),
    reason: params.reason.slice(0, 500)
  };
  const updated = await pool.query<{ c: string }>(
    `UPDATE experiment_strategies
       SET status = 'failed',
           finished_at = COALESCE(finished_at, now()),
           updated_at = now(),
           metrics = COALESCE(metrics, '{}'::jsonb) || $3::jsonb
     WHERE experiment_id = $1::uuid
       AND variant_id = $2::text
       AND status IN ('queued', 'running')
     RETURNING id::text AS c`,
    [params.experimentId, params.variantId, JSON.stringify(detail)]
  );
  if (updated.rows.length === 0) return false;

  await pool.query(
    `UPDATE experiment_runs
        SET strategy_cursor = strategy_cursor + 1,
            status = CASE WHEN winner_variant_id IS NOT NULL THEN status ELSE 'running' END,
            updated_at = now()
      WHERE id = $1::uuid`,
    [params.experimentId]
  );

  await pool.query(
    `INSERT INTO experiment_failures (
       experiment_id, strategy_variant_id, case_id, bucket, details
     )
     SELECT
       s.experiment_id,
       s.id,
       (SELECT id FROM experiment_cases WHERE experiment_id = s.experiment_id LIMIT 1),
       'reasoning_synthesis_miss',
       $2::jsonb
     FROM experiment_strategies s
     WHERE s.experiment_id = $1::uuid
       AND s.variant_id = $3::text
     LIMIT 1`,
    [
      params.experimentId,
      JSON.stringify({
        kind: "loop_strategy_skip",
        variantId: params.variantId,
        strategyId: params.strategyId ?? null,
        reason: params.reason.slice(0, 500)
      }),
      params.variantId
    ]
  );
  return true;
}

async function main(): Promise<void> {
  await ensureExtendedSchema();
  const experimentId = readArg("--id=");
  if (!experimentId) {
    throw new Error("Missing --id=<experimentId>");
  }
  const caseSet = (readArg("--case-set=") as "dev" | "critical" | "certification" | "all" | undefined) ?? "all";
  // One week at a 300ms heartbeat is ~2,016,000 iterations.
  const maxSteps = Number(readArg("--max-steps=") ?? "2016000");
  const maxRuntimeHours = Number(readArg("--max-runtime-hours=") ?? "168");
  const pauseMs = Number(readArg("--pause-ms=") ?? "300");
  const idleWaitMs = Number(readArg("--idle-wait-ms=") ?? "15000");
  const errorWaitMs = Number(readArg("--error-wait-ms=") ?? "10000");
  const startedAt = Date.now();

  for (let step = 1; step <= maxSteps; step += 1) {
    const elapsedHours = (Date.now() - startedAt) / (1000 * 60 * 60);
    if (elapsedHours >= maxRuntimeHours) {
      // eslint-disable-next-line no-console
      console.log(JSON.stringify({
        ok: false,
        done: false,
        reason: "max_runtime_reached",
        maxRuntimeHours,
        step
      }, null, 2));
      return;
    }

    let status: Awaited<ReturnType<typeof experimentStatus>>;
    try {
      status = await experimentStatus(experimentId);
    } catch (error) {
      const message = normalizeErrorMessage(error);
      // eslint-disable-next-line no-console
      console.error(JSON.stringify({
        ok: false,
        done: false,
        reason: "status_error_retrying",
        step,
        error: message
      }, null, 2));
      await sleep(errorWaitMs);
      continue;
    }

    const exp = status.experiment as { winner_variant_id?: string | null; status?: string };
    const queuedStrategies = Array.isArray(status.strategies)
      ? [...status.strategies]
        .filter((s: { status?: string }) => s.status === "queued")
        .sort((a: { position?: number }, b: { position?: number }) => Number(a.position ?? 0) - Number(b.position ?? 0))
      : [];
    const queued = queuedStrategies.length;
    const running = Array.isArray(status.strategies)
      ? status.strategies.filter((s: { status?: string }) => s.status === "running").length
      : 0;

    // Stop only when all queued work is exhausted and experiment is fully completed.
    if (queued === 0 && running === 0 && exp?.status === "completed") {
      // eslint-disable-next-line no-console
      console.log(JSON.stringify({
        ok: true,
        done: true,
        reason: "completed_all_available_strategies",
        winnerVariantId: exp?.winner_variant_id ?? null,
        step
      }, null, 2));
      return;
    }

    // During research/new-group generation, keep waiting instead of stopping.
    if (queued === 0) {
      // eslint-disable-next-line no-console
      console.log(JSON.stringify({
        ok: true,
        done: false,
        reason: "waiting_for_new_strategies",
        experimentStatus: exp?.status ?? "unknown",
        winnerVariantId: exp?.winner_variant_id ?? null,
        step
      }, null, 2));
      await sleep(idleWaitMs);
      continue;
    }

    const next = queuedStrategies[0] as { variant_id?: string; strategy_id?: string } | undefined;

    try {
      const result = await runExperimentStep({
        experimentId,
        caseSet,
        variantId: next?.variant_id
      });
      // eslint-disable-next-line no-console
      console.log(JSON.stringify({ step, result }, null, 2));
      await runTimeoutRepairSequence({
        experimentId,
        caseSet,
        result: result as Record<string, unknown>,
        step
      });
    } catch (error) {
      const message = normalizeErrorMessage(error);
      const skipped = await markStrategyFailedAndAdvance({
        experimentId,
        variantId: next?.variant_id,
        strategyId: next?.strategy_id,
        reason: message
      });
      // eslint-disable-next-line no-console
      console.error(JSON.stringify({
        ok: false,
        done: false,
        reason: skipped ? "strategy_error_skipped_to_next" : "step_error_retrying",
        step,
        variantId: next?.variant_id ?? null,
        strategyId: next?.strategy_id ?? null,
        error: message
      }, null, 2));
      await sleep(errorWaitMs);
      continue;
    }

    await sleep(pauseMs);
  }

  // eslint-disable-next-line no-console
  console.log(JSON.stringify({
    ok: false,
    done: false,
    reason: "max_steps_reached",
    maxSteps
  }, null, 2));
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error("v2 strategy loop failed:", error);
  process.exit(1);
});
