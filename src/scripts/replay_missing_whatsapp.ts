import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { tmpdir } from "node:os";
import AdmZip from "adm-zip";
import { pool } from "../db.js";
import { parseWhatsappExport } from "../importers/whatsapp.js";
import { chunkArray, parseCommonArgs, postBatch, printSummary, toBatchRequest } from "./common.js";
import type { NormalizedMessage } from "../types.js";

function parseWhatsappArgs(argv: string[]): ReturnType<typeof parseCommonArgs> & { weekly: boolean } {
  const weekly = argv.includes("--weekly");
  const sanitized = argv.filter((token) => token !== "--weekly");
  const parsed = parseCommonArgs(sanitized);
  return { ...parsed, weekly };
}

function isTextFile(path: string): boolean {
  const ext = extname(path).toLowerCase();
  return ext === ".txt" || ext === ".text";
}

function isZipFile(path: string): boolean {
  return extname(path).toLowerCase() === ".zip";
}

function sanitizeName(value: string): string {
  return value.replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, " ").trim();
}

function collectTxtFromZip(zip: AdmZip, outputDir: string, prefix: string): string[] {
  const files: string[] = [];

  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;

    const lower = entry.entryName.toLowerCase();
    if (lower.endsWith(".txt") || lower.endsWith(".text")) {
      const safeEntry = sanitizeName(entry.entryName.replace(/[\\/]+/g, "_"));
      const target = join(outputDir, `${prefix}__${safeEntry}`);
      writeFileSync(target, entry.getData());
      files.push(target);
      continue;
    }

    if (lower.endsWith(".zip")) {
      try {
        const nested = new AdmZip(entry.getData());
        const nestedPrefix = `${prefix}__${sanitizeName(entry.name || basename(entry.entryName, ".zip"))}`;
        files.push(...collectTxtFromZip(nested, outputDir, nestedPrefix));
      } catch {
        // Ignore unreadable nested archives.
      }
    }
  }

  return files;
}

function collectInputFiles(inputPath: string, weekly: boolean): { files: string[]; tempDir: string | null } {
  const stat = statSync(inputPath);
  const cutoff = Date.now() - 8 * 24 * 60 * 60 * 1000;
  const tempDir = mkdtempSync(join(tmpdir(), "openbrain-wa-replay-"));

  const tryCollectFromZip = (zipPath: string): string[] => {
    const zip = new AdmZip(zipPath);
    const prefix = sanitizeName(basename(zipPath, extname(zipPath)));
    return collectTxtFromZip(zip, tempDir, prefix);
  };

  let files: string[] = [];
  if (stat.isFile()) {
    if (isTextFile(inputPath)) files = [inputPath];
    else if (isZipFile(inputPath)) files = tryCollectFromZip(inputPath);

    if (files.length === 0) {
      rmSync(tempDir, { recursive: true, force: true });
      return { files: [], tempDir: null };
    }
    return { files, tempDir: files.some((file) => file.startsWith(tempDir)) ? tempDir : null };
  }

  const candidates = readdirSync(inputPath)
    .map((name) => join(inputPath, name))
    .filter((path) => statSync(path).isFile())
    .filter((path) => !weekly || statSync(path).mtimeMs >= cutoff);

  for (const path of candidates) {
    if (isTextFile(path)) files.push(path);
    else if (isZipFile(path)) files.push(...tryCollectFromZip(path));
  }

  files = Array.from(new Set(files));
  if (files.length === 0) {
    rmSync(tempDir, { recursive: true, force: true });
    return { files: [], tempDir: null };
  }
  return { files, tempDir: files.some((file) => file.startsWith(tempDir)) ? tempDir : null };
}

function tupleKey(item: Pick<NormalizedMessage, "sourceConversationId" | "sourceMessageId">): string | null {
  const conversation = String(item.sourceConversationId ?? "").trim();
  const messageId = String(item.sourceMessageId ?? "").trim();
  if (!conversation || !messageId) return null;
  return `${conversation}||${messageId}`;
}

async function loadExistingTupleKeys(namespace: string): Promise<Set<string>> {
  const existing = new Set<string>();
  const rows = await pool.query<{ source_conversation_id: string; source_message_id: string }>(
    `SELECT source_conversation_id, source_message_id
       FROM memory_items
      WHERE source_system = 'whatsapp'
        AND chat_namespace = $1
        AND source_conversation_id IS NOT NULL
        AND source_message_id IS NOT NULL`,
    [namespace]
  );
  for (const row of rows.rows) {
    existing.add(`${row.source_conversation_id}||${row.source_message_id}`);
  }
  return existing;
}

async function main(): Promise<void> {
  const args = parseWhatsappArgs(process.argv.slice(2));
  const { files, tempDir } = collectInputFiles(args.input, args.weekly);
  if (files.length === 0) {
    throw new Error(
      args.weekly
        ? "No recent WhatsApp export TXT/ZIP files found in input path for --weekly mode"
        : "No WhatsApp export TXT/ZIP files found in input path"
    );
  }

  const existing = await loadExistingTupleKeys(args.namespace);
  let parsedItems = 0;
  let skippedExisting = 0;
  let skippedNoTuple = 0;
  let inserted = 0;
  let deduped = 0;
  let failed = 0;

  try {
    for (const file of files) {
      const parsed = parseWhatsappExport(file, args.namespace);
      parsedItems += parsed.items.length;

      const replayItems: NormalizedMessage[] = [];
      for (const item of parsed.items) {
        const key = tupleKey(item);
        if (!key) {
          skippedNoTuple += 1;
          continue;
        }
        if (existing.has(key)) {
          skippedExisting += 1;
          continue;
        }
        replayItems.push(item);
      }

      if (replayItems.length === 0) {
        process.stdout.write(`File ${file} -> no missing tuple rows to replay\n`);
        continue;
      }

      const chunks = chunkArray(replayItems, args.chunkSize);
      for (let i = 0; i < chunks.length; i += 1) {
        const chunk = chunks[i];
        const batch = toBatchRequest(parsed, chunk, args.dryRun);
        const result = await postBatch(args.baseUrl, args.apiKey, batch);
        inserted += result.inserted;
        deduped += result.deduped;
        failed += result.failed;
        process.stdout.write(
          `File ${file} replay batch ${i + 1}/${chunks.length} -> inserted ${result.inserted}, deduped ${result.deduped}, failed ${result.failed} (job ${result.jobId})\n`
        );
      }
    }
  } finally {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    await pool.end();
  }

  printSummary("WhatsApp missing replay", {
    inserted,
    deduped,
    failed,
    items: parsedItems
  });
  process.stdout.write(`Skipped existing tuples: ${skippedExisting}\n`);
  process.stdout.write(`Skipped rows without stable tuple keys: ${skippedNoTuple}\n`);
}

main().catch((error) => {
  process.stderr.write(`WhatsApp missing replay failed: ${String((error as Error)?.message ?? error)}\n`);
  process.exit(1);
});

