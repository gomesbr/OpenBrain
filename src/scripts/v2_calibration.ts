import { ensureExtendedSchema } from "../schema.js";
import {
  createJudgeCalibrationSample,
  judgeCalibrationReport,
  listJudgeCalibrationPending,
  submitJudgeCalibrationLabel
} from "../v2_experiments.js";

function readArg(prefix: string): string | undefined {
  return process.argv.find((arg) => arg.startsWith(prefix))?.split("=")[1];
}

async function main(): Promise<void> {
  await ensureExtendedSchema();
  const mode = String(readArg("--mode=") ?? "pending").trim().toLowerCase();
  const experimentId = String(readArg("--id=") ?? "").trim();
  if (!experimentId) throw new Error("Missing --id=<experimentId>");

  if (mode === "sample") {
    const caseSetRaw = String(readArg("--case-set=") ?? "").trim();
    const caseSet = (["dev", "critical", "certification", "stress", "coverage"] as const).includes(caseSetRaw as never)
      ? (caseSetRaw as "dev" | "critical" | "certification" | "stress" | "coverage")
      : undefined;
    const result = await createJudgeCalibrationSample({
      experimentId,
      count: readArg("--count=") ? Number(readArg("--count=")) : undefined,
      caseSet,
      variantId: String(readArg("--variant=") ?? "").trim() || undefined
    });
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (mode === "label") {
    const calibrationItemId = String(readArg("--item=") ?? "").trim();
    const verdict = String(readArg("--verdict=") ?? "").trim().toLowerCase();
    if (!calibrationItemId) throw new Error("Missing --item=<calibrationItemId>");
    if (verdict !== "yes" && verdict !== "no") throw new Error("Missing --verdict=yes|no");
    const result = await submitJudgeCalibrationLabel({
      calibrationItemId,
      verdict: verdict as "yes" | "no",
      reviewer: String(readArg("--reviewer=") ?? "owner").trim() || "owner",
      notes: String(readArg("--notes=") ?? "").trim() || undefined
    });
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (mode === "report") {
    const result = await judgeCalibrationReport({ experimentId });
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const result = await listJudgeCalibrationPending({
    experimentId,
    limit: readArg("--limit=") ? Number(readArg("--limit=")) : undefined
  });
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error("v2 calibration command failed:", error);
  process.exit(1);
});

