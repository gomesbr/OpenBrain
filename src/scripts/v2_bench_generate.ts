import { generateBenchmarks } from "../v2_benchmarks.js";
import { ensureExtendedSchema } from "../schema.js";

async function main(): Promise<void> {
  await ensureExtendedSchema();
  const variantsArg = Number(process.argv.find((arg) => arg.startsWith("--variants="))?.split("=")[1] ?? "10");
  const setArg = process.argv.find((arg) => arg.startsWith("--set="))?.split("=")[1] ?? "baseline_3600";
  const result = await generateBenchmarks({ benchmarkSet: setArg, variantsPerDomainLens: variantsArg });
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error("v2 benchmark generation failed:", error);
  process.exit(1);
});
