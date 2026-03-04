import { parseGrokExport } from "../importers/grok.js";
import { chunkArray, parseCommonArgs, postBatch, printSummary, toBatchRequest } from "./common.js";

async function main(): Promise<void> {
  const args = parseCommonArgs(process.argv.slice(2));
  const parsed = parseGrokExport(args.input, args.namespace, args.account);

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

  printSummary("Grok", { inserted, deduped, failed, items: parsed.items.length });
}

main().catch((error) => {
  process.stderr.write(`Grok import failed: ${String((error as Error)?.message ?? error)}\n`);
  process.exit(1);
});
