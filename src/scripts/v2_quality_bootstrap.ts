import { ensureExtendedSchema } from "../schema.js";
import { materializeCandidates, applyUniversalQualityGate, remediateLegacyArtifacts } from "../v2_pipeline.js";
import { runCanonicalBootstrap } from "../v2_quality.js";

async function main(): Promise<void> {
  await ensureExtendedSchema();
  const canonicalLimit = Number(process.argv.find((arg) => arg.startsWith("--canonical="))?.split("=")[1] ?? "2000");
  const candidateLimit = Number(process.argv.find((arg) => arg.startsWith("--candidates="))?.split("=")[1] ?? "2500");

  const canonical = await runCanonicalBootstrap(canonicalLimit);
  const candidates = await materializeCandidates(candidateLimit);
  const gate = await applyUniversalQualityGate();
  const remediation = await remediateLegacyArtifacts();

  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ ok: true, canonical, candidates, gate, remediation }, null, 2));
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error("v2 quality bootstrap failed:", error);
  process.exit(1);
});
