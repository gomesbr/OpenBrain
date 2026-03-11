import { runExperimentStep } from "../v2_experiments.js";
import { ensureExtendedSchema } from "../schema.js";

function readArg(prefix: string): string | undefined {
  return process.argv.find((arg) => arg.startsWith(prefix))?.split("=")[1];
}

async function main(): Promise<void> {
  await ensureExtendedSchema();
  const experimentId = readArg("--id=");
  if (!experimentId) {
    throw new Error("Missing --id=<experimentId>");
  }
  const variantId = readArg("--variant=");
  const caseSetRaw = readArg("--case-set=");
  const caseSet = caseSetRaw as "dev" | "critical" | "certification" | "all" | undefined;
  const result = await runExperimentStep({ experimentId, variantId, caseSet });
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error("v2 strategy step failed:", error);
  process.exit(1);
});
