import { resolve } from "node:path";
import { parseCodexClawBackfill } from "../importers/codexclaw.js";
import { chunkArray, postBatch, printSummary, toBatchRequest } from "./common.js";

interface Args {
  dbPath: string;
  namespacePrefix: string;
  baseUrl: string;
  apiKey: string;
  dryRun: boolean;
  chunkSize: number;
}

function parseArgs(argv: string[]): Args {
  let dbPath = "";
  let namespacePrefix = "codexclaw";
  let baseUrl = process.env.OPENBRAIN_BASE_URL ?? "http://127.0.0.1:4301";
  let apiKey = process.env.OPENBRAIN_API_KEY ?? "";
  let dryRun = false;
  let chunkSize = 200;

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const next = argv[i + 1];

    if (token === "--db-path") {
      dbPath = String(next ?? "").trim();
      i += 1;
    } else if (token === "--namespace-prefix") {
      namespacePrefix = String(next ?? "").trim() || namespacePrefix;
      i += 1;
    } else if (token === "--base-url") {
      baseUrl = String(next ?? "").trim() || baseUrl;
      i += 1;
    } else if (token === "--api-key") {
      apiKey = String(next ?? "").trim() || apiKey;
      i += 1;
    } else if (token === "--dry-run") {
      dryRun = true;
    } else if (token === "--chunk-size") {
      const n = Number(next ?? "");
      if (Number.isFinite(n) && n > 0) chunkSize = Math.trunc(n);
      i += 1;
    }
  }

  if (!dbPath) {
    throw new Error("Missing --db-path <path to CodexClaw sqlite>");
  }

  if (!apiKey) {
    throw new Error("Missing OpenBrain API key. Set OPENBRAIN_API_KEY or use --api-key.");
  }

  return {
    dbPath: resolve(dbPath),
    namespacePrefix,
    baseUrl: baseUrl.replace(/\/+$/, ""),
    apiKey,
    dryRun,
    chunkSize
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const parsed = parseCodexClawBackfill({
    dbPath: args.dbPath,
    namespacePrefix: args.namespacePrefix
  });

  const chunks = chunkArray(parsed.items, args.chunkSize);
  let inserted = 0;
  let deduped = 0;
  let failed = 0;

  for (let i = 0; i < chunks.length; i += 1) {
    const chunk = chunks[i];
    const batch = toBatchRequest(parsed, chunk, args.dryRun);
    const result = await postBatch(args.baseUrl, args.apiKey, batch);

    inserted += result.inserted;
    deduped += result.deduped;
    failed += result.failed;

    process.stdout.write(`Batch ${i + 1}/${chunks.length} -> inserted ${result.inserted}, deduped ${result.deduped}, failed ${result.failed} (job ${result.jobId})\n`);
  }

  printSummary("CodexClaw backfill", { inserted, deduped, failed, items: parsed.items.length });
}

main().catch((error) => {
  process.stderr.write(`CodexClaw backfill failed: ${String((error as Error)?.message ?? error)}\n`);
  process.exit(1);
});
