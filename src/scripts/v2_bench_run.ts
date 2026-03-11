import { runBenchmark } from "../v2_benchmarks.js";
import { ensureExtendedSchema } from "../schema.js";

async function main(): Promise<void> {
  await ensureExtendedSchema();
  const limitArg = Number(process.argv.find((arg) => arg.startsWith("--limit="))?.split("=")[1] ?? "3600");
  const setArg = process.argv.find((arg) => arg.startsWith("--set="))?.split("=")[1] ?? "baseline_3600";
  const chatNamespace = process.argv.find((arg) => arg.startsWith("--chat="))?.split("=")[1] ?? "personal.main";
  const dataAwareOnly = process.argv.includes("--data-aware");
  const minDomainScore = Number(process.argv.find((arg) => arg.startsWith("--min-score="))?.split("=")[1] ?? "0.28");
  const minDomainRows = Number(process.argv.find((arg) => arg.startsWith("--min-rows="))?.split("=")[1] ?? "80");
  const result = await runBenchmark({
    benchmarkSet: setArg,
    limit: limitArg,
    chatNamespace,
    dataAwareOnly,
    minDomainScore,
    minDomainRows
  });
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error("v2 benchmark run failed:", error);
  process.exit(1);
});
