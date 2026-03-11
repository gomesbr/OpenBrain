import { ensureExtendedSchema } from "../schema.js";
import { runCanonicalBootstrap } from "../v2_quality.js";
import { reextractMetadata } from "./reextract_metadata.js";

function readArg(prefix: string, fallback: string): string {
  return process.argv.find((arg) => arg.startsWith(prefix))?.split("=")[1] ?? fallback;
}

async function main(): Promise<void> {
  await ensureExtendedSchema();

  const chatNamespace = readArg("--chat=", "personal.main");
  const sourceSystem = readArg("--source=", "");
  const batchSize = Number(readArg("--batch=", "200"));
  const maxRows = Number(readArg("--max=", "0"));
  const onlyMissing = readArg("--only-missing=", "0") !== "0";
  const order = readArg("--order=", "desc").toLowerCase() === "asc" ? "asc" : "desc";
  const canonicalLimit = Number(readArg("--canonical-limit=", "5000"));

  // eslint-disable-next-line no-console
  console.log(`semantic refresh start: chat=${chatNamespace} source=${sourceSystem || "all"} onlyMissing=${onlyMissing} batch=${batchSize} max=${maxRows || "all"} canonicalLimit=${canonicalLimit}`);

  const reextract = await reextractMetadata({
    chatNamespace,
    sourceSystem,
    batchSize,
    maxRows,
    onlyMissing,
    order,
    onProgress: ({ scanned, updated, failed }) => {
      // eslint-disable-next-line no-console
      console.log(`semantic refresh reextract: scanned=${scanned} updated=${updated} failed=${failed}`);
    }
  });

  // eslint-disable-next-line no-console
  console.log(`semantic refresh canonical bootstrap starting (limit=${canonicalLimit})`);
  const canonical = await runCanonicalBootstrap(canonicalLimit);

  // eslint-disable-next-line no-console
  console.log(JSON.stringify({
    ok: true,
    reextract,
    canonical
  }, null, 2));
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error("semantic refresh failed:", error);
  process.exit(1);
});
