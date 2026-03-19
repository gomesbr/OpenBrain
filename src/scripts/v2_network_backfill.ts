import { ensureExtendedSchema } from "../schema.js";
import { rebuildNetworkGraphArtifacts } from "../v2_network.js";

function readArg(name: string): string | null {
  const prefix = `--${name}=`;
  const hit = process.argv.find((arg) => arg.startsWith(prefix));
  if (!hit) return null;
  return hit.slice(prefix.length).trim() || null;
}

async function main(): Promise<void> {
  await ensureExtendedSchema();
  const chatNamespace = readArg("namespace") ?? "personal.main";
  const clearExisting = process.argv.includes("--clear");
  const result = await rebuildNetworkGraphArtifacts({ chatNamespace, clearExisting });
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error("v2 network backfill failed:", error);
  process.exit(1);
});
