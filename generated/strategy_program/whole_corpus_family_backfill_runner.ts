import fs from "node:fs";
import path from "node:path";
import {
  backfillCalibrationClarifyCases,
  backfillPositiveCalibrationCases,
  experimentActivePoolGapSnapshot,
  experimentPreloopReadiness
} from "../../src/v2_experiments.ts";

const logPath = path.resolve("generated/strategy_program/whole_corpus_family_backfill.log");
const cursorPath = path.resolve("generated/strategy_program/whole_corpus_family_backfill_cursor.json");
const rejectionPath = path.resolve("generated/strategy_program/whole_corpus_family_backfill_rejections.jsonl");
const blocklistPath = path.resolve("generated/strategy_program/whole_corpus_family_backfill_blocklist.json");
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

function readBlocklist(): Record<string, { expiresAt: string; reason: string }> {
  try {
    const raw = JSON.parse(fs.readFileSync(blocklistPath, "utf8")) as Record<string, { expiresAt?: string; reason?: string }>;
    const now = Date.now();
    const out: Record<string, { expiresAt: string; reason: string }> = {};
    for (const [familyKey, value] of Object.entries(raw ?? {})) {
      const expiresAt = Date.parse(String(value?.expiresAt ?? ""));
      if (Number.isFinite(expiresAt) && expiresAt > now) {
        out[familyKey] = {
          expiresAt: new Date(expiresAt).toISOString(),
          reason: String(value?.reason ?? "slow_family")
        };
      }
    }
    return out;
  } catch {
    return {};
  }
}

function writeBlocklist(entries: Record<string, { expiresAt: string; reason: string }>): void {
  fs.writeFileSync(blocklistPath, JSON.stringify(entries, null, 2), "utf8");
}

function mergeBlockedFamilies(familyKeys: string[], reason = "slow_family"): void {
  if (!Array.isArray(familyKeys) || familyKeys.length <= 0) return;
  const entries = readBlocklist();
  const expiresAt = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();
  for (const familyKey of familyKeys) {
    const key = String(familyKey ?? "").trim();
    if (!key) continue;
    entries[key] = { expiresAt, reason };
  }
  writeBlocklist(entries);
}

function activeGapKeys(gap: Record<string, unknown>): string[] {
  return Object.entries(gap)
    .filter(([key, value]) => {
      if (key === "hasAnyGap" || key === "humanShare" || key === "humanShareGap") {
        return key === "humanShareGap" ? Boolean(value) : false;
      }
      return Number(value ?? 0) > 0;
    })
    .map(([key]) => key);
}

async function main() {
  const familyOffset = readCursorOffset();
  process.env.OB_BACKFILL_FAMILY_OFFSET = String(familyOffset);
  process.env.OB_BACKFILL_BLOCKLIST_PATH = blocklistPath;
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
  const activePoolSnapshot = await experimentActivePoolGapSnapshot({
    experimentId: "53761995-3341-4ca2-9af1-b63b9bace516"
  });
  const activeClarifyGap = Number(activePoolSnapshot.gap.clarifyGap ?? 0);
  const activeGapKeyList = activeGapKeys(activePoolSnapshot.gap as Record<string, unknown>);
  const clarifyOnlyGap = activeGapKeyList.length > 0 && activeGapKeyList.every((key) => key === "clarifyGap");
  const requestedClarify = clarifySeedCount > 0
    ? clarifySeedCount
    : (activeClarifyGap > 0 ? (clarifyOnlyGap ? activeClarifyGap : Math.min(3, activeClarifyGap)) : 0);
  let clarifyResult: { inserted: number } | null = null;
  if (requestedClarify > 0) {
    clarifyResult = await backfillCalibrationClarifyCases({
      experimentId: "53761995-3341-4ca2-9af1-b63b9bace516",
      count: requestedClarify,
      minCritiqueScore: Number.isFinite(clarifyCritiqueScore)
        ? (clarifyOnlyGap ? Math.min(clarifyCritiqueScore, 0.74) : clarifyCritiqueScore)
        : (clarifyOnlyGap ? 0.74 : 0.8)
    }) as { inserted: number };
    console.log(`[run] clarify-inserted=${clarifyResult.inserted}`);
  }
  const result = clarifyOnlyGap
    ? {
        requested: 0,
        candidatePool: 0,
        assistantAccepted: 0,
        inserted: 0,
        calibrationItemsCreated: 0,
        caseIds: [],
        scannedFamilies: 0,
        familySeedCount: 0,
        nextFamilyOffset: familyOffset,
        rejectionSamples: [],
        blockedFamilyKeys: []
      }
    : await backfillPositiveCalibrationCases({
        experimentId: "53761995-3341-4ca2-9af1-b63b9bace516",
        targetCount: targetCount,
        minCritiqueScore: Number.isFinite(positiveCritiqueScore) ? positiveCritiqueScore : 0.88
      });
  const nextFamilyOffset = Number(result.nextFamilyOffset ?? familyOffset);
  const familySeedCount = Number(result.familySeedCount ?? 0);
  const scannedFamilies = Number(result.scannedFamilies ?? 0);
  const postRunActivePoolSnapshot = await experimentActivePoolGapSnapshot({
    experimentId: "53761995-3341-4ca2-9af1-b63b9bace516"
  });
  const activePoolGapSatisfied = !Boolean(postRunActivePoolSnapshot.gap?.hasAnyGap);
  const completedPassRaw = familySeedCount > 0
    && scannedFamilies > 0
    && (familyOffset + scannedFamilies) >= familySeedCount;
  const completedFullPass = activePoolGapSatisfied || (allowFullWrap ? false : completedPassRaw);
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
  if (Array.isArray(result.blockedFamilyKeys) && result.blockedFamilyKeys.length > 0) {
    mergeBlockedFamilies(result.blockedFamilyKeys.map((value) => String(value)));
    console.log(`[run] blocked_slow_families=${result.blockedFamilyKeys.length}`);
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
    activePoolGaps: postRunActivePoolSnapshot.gap,
    selectedClarifyGap: activeClarifyGap,
    requestedClarify,
    clarifyInserted: clarifyResult ? Number(clarifyResult.inserted) : 0,
    ...result
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ""}` : String(error));
  process.exit(1);
});
