import { activateBenchmarksBySignal, benchmarkSignalProfile } from "../v2_benchmarks.js";
import { ensureExtendedSchema } from "../schema.js";

function readArg(prefix: string, fallback: string): string {
  return process.argv.find((arg) => arg.startsWith(prefix))?.split("=")[1] ?? fallback;
}

async function main(): Promise<void> {
  await ensureExtendedSchema();
  const mode = readArg("--mode=", "profile");
  const benchmarkSet = readArg("--set=", "baseline_3600");
  const chatNamespace = readArg("--chat=", "personal.main");
  const minDomainScore = Number(readArg("--min-score=", "0.28"));
  const minDomainRows = Number(readArg("--min-rows=", "80"));

  const payload = { benchmarkSet, chatNamespace, minDomainScore, minDomainRows };
  const result =
    mode === "activate"
      ? await activateBenchmarksBySignal(payload)
      : await benchmarkSignalProfile(payload);

  // eslint-disable-next-line no-console
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error("v2 benchmark signal command failed:", error);
  process.exit(1);
});
