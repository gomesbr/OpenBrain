import fs from "node:fs";
import path from "node:path";
import {
  backfillCalibrationClarifyCases,
  backfillPositiveCalibrationCases,
  experimentPreloopReadiness
} from "../../src/v2_experiments.ts";

const logPath = path.resolve("generated/strategy_program/whole_corpus_family_backfill.log");
const cursorPath = path.resolve("generated/strategy_program/whole_corpus_family_backfill_cursor.json");
const rejectionPath = path.resolve("generated/strategy_program/whole_corpus_family_backfill_rejections.jsonl");
fs.mkdirSync(path.dirname(logPath), { recursive: true });
const targetCount = Math.max(1, Number(process.env.OB_BACKFILL_TARGET_COUNT || "10"));
const clarifySeedCount = Math.max(0, Number(process.env.OB_BACKFILL_CLARIFY_COUNT || "0"));
const allowFullWrap = String(process.env.OB_BACKFILL_ALLOW_FULL_WRAP || "").toLowerCase() === "true";
const clarifyCritiqueScore = Number(process.env.OB_BACKFILL_CLARIFY_MIN_CRITIQUE || "0.8");
const positiveCritiqueScore = Number(process.env.OB_BACKFILL_MIN_CRITIQUE || "0.88");
fs.appendFileSync(logPath, `\n[start] ${new Date().toISOString()} targetCount=${targetCount}\n`, "utf8");
const append = (line: string) => fs.appendFileSync(logPath, line.endsWith("\n") ? line : `${line}\n`, "utf8");
const appendRejection = (payload: Record<string, unknown>) => fs.appendFileSync(rejectionPath, `${JSON.stringify(payload)}\n`, "utf8");
const origLog = console.log.bind(console);
const origErr = console.error.bind(console);
console.log = (...args: unknown[]) => {
  const line = args.map((arg) => typeof arg === "string" ? arg : JSON.stringify(arg)).join(" ");
  append(line);
  origLog(...args);
};
console.error = (...args: unknown[]) => {
  const line = args.map((arg) => typeof arg === "string" ? arg : JSON.stringify(arg)).join(" ");
  append(`[error] ${line}`);
  origErr(...args);
};

function readCursorOffset(): number {
  try {
    const raw = fs.readFileSync(cursorPath, "utf8");
    const parsed = JSON.parse(raw) as { familyOffset?: number };
    const value = Number(parsed.familyOffset ?? 0);
    return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
  } catch {
    return 0;
  }
}

function writeCursorOffset(params: {
  familyOffset: number;
  nextFamilyOffset: number;
  startFamilyOffset: number;
  familySeedCount: number;
  scannedFamilies: number;
  completedFullPass: boolean;
  at: string;
}): void {
  fs.writeFileSync(cursorPath, JSON.stringify(params, null, 2), "utf8");
}

async function main() {
  const familyOffset = readCursorOffset();
  process.env.OB_BACKFILL_FAMILY_OFFSET = String(familyOffset);
  const readiness = await experimentPreloopReadiness({
    experimentId: "53761995-3341-4ca2-9af1-b63b9bace516"
  });
  const lockCounts = (readiness.lockEligibilityCounts ?? {}) as Record<string, number>;
  const stageReadiness = (readiness.stageReadiness ?? {}) as Record<string, {
    pass: boolean;
    thresholds?: Record<string, number>;
  }>;
  const stageKeys = ["core_ready", "selection_ready", "certification_ready"] as const;
  const maxStageThreshold = (key: string): number => (
    stageKeys.reduce((max, stage) => {
      const value = Number(stageReadiness[stage]?.thresholds?.[key] ?? 0);
      return Number.isFinite(value) ? Math.max(max, value) : max;
    }, 0)
  );
  const reviewedClarifyTarget = maxStageThreshold("reviewedClarifyMin");
  const criticalReviewedTarget = maxStageThreshold("criticalReviewedSliceMin");
  const ownerReviewedTarget = maxStageThreshold("ownerReviewedTotalMin");
  const reviewedClarifyCount = Number(lockCounts.reviewedClarify || 0);
  const criticalReviewedCount = Number(lockCounts.criticalReviewedSlice || 0);
  const ownerReviewedCount = Number(lockCounts.ownerReviewedTotal || 0);
  const currentClarifyGap = Math.max(0, reviewedClarifyTarget - reviewedClarifyCount);
  const currentCriticalGap = Math.max(0, criticalReviewedTarget - criticalReviewedCount);
  const currentOwnerReviewedGap = Math.max(0, ownerReviewedTarget - ownerReviewedCount);
  const requestedClarify = clarifySeedCount > 0
    ? clarifySeedCount
    : (currentClarifyGap > 0 ? 1 : 0);
  let clarifyResult: { inserted: number } | null = null;
  if (requestedClarify > 0) {
    clarifyResult = await backfillCalibrationClarifyCases({
      experimentId: "53761995-3341-4ca2-9af1-b63b9bace516",
      count: requestedClarify,
      minCritiqueScore: Number.isFinite(clarifyCritiqueScore) ? clarifyCritiqueScore : 0.8
    }) as { inserted: number };
    console.log(`[run] clarify-inserted=${clarifyResult.inserted}`);
  }
  const result = await backfillPositiveCalibrationCases({
    experimentId: "53761995-3341-4ca2-9af1-b63b9bace516",
    targetCount: targetCount,
    minCritiqueScore: Number.isFinite(positiveCritiqueScore) ? positiveCritiqueScore : 0.88
  });
  const nextFamilyOffset = Number(result.nextFamilyOffset ?? familyOffset);
  const familySeedCount = Number(result.familySeedCount ?? 0);
  const scannedFamilies = Number(result.scannedFamilies ?? 0);
  const completedPassRaw = familySeedCount > 0
    && scannedFamilies > 0
    && (familyOffset + scannedFamilies) >= familySeedCount;
  const completedFullPass = allowFullWrap ? false : completedPassRaw;
  writeCursorOffset({
    familyOffset: nextFamilyOffset,
    nextFamilyOffset,
    startFamilyOffset: familyOffset,
    familySeedCount,
    scannedFamilies,
    completedFullPass,
    at: new Date().toISOString()
  });
  if (clarifyResult) {
    appendRejection({
      at: new Date().toISOString(),
      familyOffset,
      familyOffsetKind: "clarify_seed",
      inserted: clarifyResult.inserted
    });
  }
  if (Array.isArray(result.rejectionSamples)) {
    for (const sample of result.rejectionSamples) {
      appendRejection({
        at: new Date().toISOString(),
        familyOffset,
        ...sample
      });
    }
  }
  if (completedFullPass) {
    console.log(`[stop] full traversal completed startOffset=${familyOffset} nextOffset=${nextFamilyOffset} familySeedCount=${familySeedCount} scannedFamilies=${scannedFamilies}`);
  }
  console.log(`[run] result inserted=${result.inserted} calibration=${result.calibrationItemsCreated} scanned=${scannedFamilies} target=${targetCount}`);
  console.log(JSON.stringify({
    readinessBenchmarkStage: String(readiness.benchmarkStage || "draft"),
    allPhaseTargets: {
      ownerReviewedTarget,
      reviewedClarifyTarget,
      criticalReviewedTarget
    },
    allPhaseGaps: {
      ownerReviewedGap: currentOwnerReviewedGap,
      reviewedClarifyGap: currentClarifyGap,
      criticalReviewedGap: currentCriticalGap
    },
    selectedClarifyGap: currentClarifyGap,
    requestedClarify,
    clarifyInserted: clarifyResult ? Number(clarifyResult.inserted) : 0,
    ...result
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ""}` : String(error));
  process.exit(1);
});
