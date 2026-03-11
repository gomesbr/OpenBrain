import { ensureExtendedSchema } from "../schema.js";
import { startExperiment } from "../v2_experiments.js";

function readArg(prefix: string): string | undefined {
  return process.argv.find((arg) => arg.startsWith(prefix))?.split("=")[1];
}

async function main(): Promise<void> {
  await ensureExtendedSchema();
  const payload = {
    name: readArg("--name="),
    chatNamespace: readArg("--chat=") ?? "personal.main",
    targetPassRate: readArg("--target=") ? Number(readArg("--target=")) : undefined,
    criticalTargetPassRate: readArg("--critical-target=") ? Number(readArg("--critical-target=")) : undefined,
    perDomainFloor: readArg("--domain-floor=") ? Number(readArg("--domain-floor=")) : undefined,
    latencyGateMultiplier: readArg("--latency-gate=") ? Number(readArg("--latency-gate=")) : undefined,
    costGateMultiplier: readArg("--cost-gate=") ? Number(readArg("--cost-gate=")) : undefined,
    datasetVersion: readArg("--dataset="),
    maxCasesPerPair: readArg("--cases-per-pair=") ? Number(readArg("--cases-per-pair=")) : undefined
  };
  const strategyArg = readArg("--strategies=");
  const strategies = strategyArg
    ? strategyArg.split(",").map((s) => s.trim()).filter(Boolean)
    : undefined;
  const result = await startExperiment({ ...payload, strategyIds: strategies });
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error("v2 strategy start failed:", error);
  process.exit(1);
});
