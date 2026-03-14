import fs from "node:fs";
import path from "node:path";
import { backfillPositiveCalibrationCases } from "../../src/v2_experiments.ts";

const logPath = path.resolve("generated/strategy_program/whole_corpus_family_backfill.log");
const cursorPath = path.resolve("generated/strategy_program/whole_corpus_family_backfill_cursor.json");
const rejectionPath = path.resolve("generated/strategy_program/whole_corpus_family_backfill_rejections.jsonl");
fs.mkdirSync(path.dirname(logPath), { recursive: true });
const targetCount = Math.max(1, Number(process.env.OB_BACKFILL_TARGET_COUNT || "10"));
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
  const result = await backfillPositiveCalibrationCases({
    experimentId: "53761995-3341-4ca2-9af1-b63b9bace516",
    targetCount,
    minCritiqueScore: 0.88
  });
  const nextFamilyOffset = Number(result.nextFamilyOffset ?? familyOffset);
  const familySeedCount = Number(result.familySeedCount ?? 0);
  const scannedFamilies = Number(result.scannedFamilies ?? 0);
  const completedFullPass = familySeedCount > 0
    && scannedFamilies > 0
    && (familyOffset + scannedFamilies) >= familySeedCount;
  writeCursorOffset({
    familyOffset: nextFamilyOffset,
    nextFamilyOffset,
    startFamilyOffset: familyOffset,
    familySeedCount,
    scannedFamilies,
    completedFullPass,
    at: new Date().toISOString()
  });
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
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ""}` : String(error));
  process.exit(1);
});
