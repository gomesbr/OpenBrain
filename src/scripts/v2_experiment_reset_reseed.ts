import { writeFile } from "node:fs/promises";
import path from "node:path";
import { ensureExtendedSchema } from "../schema.js";
import { pool } from "../db.js";
import { startExperiment } from "../v2_experiments.js";

function readArg(prefix: string): string | undefined {
  return process.argv.find((arg) => arg.startsWith(prefix))?.split("=")[1];
}

async function hardResetExperimentTables(): Promise<void> {
  await pool.query(`
    TRUNCATE TABLE
      experiment_case_results,
      experiment_failures,
      experiment_winner_decisions,
      experiment_governance_events,
      experiment_judge_calibration_labels,
      experiment_judge_calibration_items,
      benchmark_lock_versions,
      hypothesis_updates,
      hypothesis_experiments,
      hypothesis_predictions,
      hypotheses,
      strategy_component_bindings,
      component_pair_performance,
      component_stability,
      component_performance,
      strategy_lessons,
      experiment_cases,
      experiment_strategies,
      experiment_runs
    RESTART IDENTITY CASCADE
  `);
}

async function clearKnowledgeAuditLog(): Promise<void> {
  const logPath = path.resolve("generated/strategy_program/strategy_knowledge.jsonl");
  await writeFile(logPath, "", "utf8");
}

async function clearAuthoringTimingLog(): Promise<void> {
  const logPath = path.resolve("generated/strategy_program/benchmark_authoring_call_times.jsonl");
  await writeFile(logPath, "", "utf8");
}

async function main(): Promise<void> {
  const skipSchema = String(readArg("--skip-schema=") ?? "true").trim().toLowerCase() !== "false";
  if (!skipSchema) {
    await ensureExtendedSchema();
  }
  await hardResetExperimentTables();

  const clearKnowledge = String(readArg("--clear-knowledge-log=") ?? "true").trim().toLowerCase() !== "false";
  if (clearKnowledge) {
    await clearKnowledgeAuditLog();
  }
  await clearAuthoringTimingLog();

  const result = await startExperiment({
    name: readArg("--name=") ?? "OpenBrain v1.6 - Agentic Benchmark Authoring + Oracle Feasibility",
    chatNamespace: readArg("--chat=") ?? "personal.main",
    datasetVersion: readArg("--dataset=") ?? "v1.6::hard_reset",
    maxCasesPerPair: readArg("--cases-per-pair=") ? Number(readArg("--cases-per-pair=")) : 2
  });

  // eslint-disable-next-line no-console
  console.log(JSON.stringify({
    ok: true,
    reset: true,
    skippedSchemaStep: skipSchema,
    clearedKnowledgeLog: clearKnowledge,
    authoringTimingLog: path.resolve("generated/strategy_program/benchmark_authoring_call_times.jsonl"),
    result
  }, null, 2));
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error("v2 experiment reset/reseed failed:", error);
  process.exit(1);
});
