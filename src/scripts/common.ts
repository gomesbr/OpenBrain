import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { BatchCaptureRequest, NormalizedMessage, ParseResult } from "../types.js";

export interface ScriptArgs {
  input: string;
  namespace: string;
  account: string;
  baseUrl: string;
  apiKey: string;
  dryRun: boolean;
  chunkSize: number;
}

export function parseCommonArgs(argv: string[]): ScriptArgs {
  let input = "";
  let namespace = "default";
  let account = "default";
  let baseUrl = process.env.OPENBRAIN_BASE_URL ?? "http://127.0.0.1:4301";
  let apiKey = process.env.OPENBRAIN_API_KEY ?? "";
  let dryRun = false;
  let chunkSize = 200;

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const next = argv[i + 1];

    if (token === "--input") {
      input = String(next ?? "").trim();
      i += 1;
    } else if (token === "--namespace") {
      namespace = String(next ?? "").trim() || namespace;
      i += 1;
    } else if (token === "--account") {
      account = String(next ?? "").trim() || account;
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

  if (!input) {
    throw new Error("Missing --input <path>");
  }

  const absolute = resolve(input);
  const stat = statSync(absolute);
  if (!stat.isFile() && !stat.isDirectory()) {
    throw new Error(`Invalid --input path: ${absolute}`);
  }

  if (!apiKey) {
    throw new Error("Missing OpenBrain API key. Set OPENBRAIN_API_KEY or use --api-key.");
  }

  return {
    input: absolute,
    namespace,
    account,
    baseUrl: baseUrl.replace(/\/+$/, ""),
    apiKey,
    dryRun,
    chunkSize
  };
}

export function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function postBatch(
  baseUrl: string,
  apiKey: string,
  payload: BatchCaptureRequest
): Promise<{ inserted: number; deduped: number; failed: number; jobId: string }> {
  const maxAttempts = 6;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/v1/memory/batch`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey
        },
        body: JSON.stringify(payload)
      });

      const bodyText = await response.text();
      let body: any = {};
      try {
        body = JSON.parse(bodyText);
      } catch {
        body = { error: bodyText };
      }

      if (response.ok && body?.ok === true) {
        return {
          inserted: Number(body.inserted ?? 0),
          deduped: Number(body.deduped ?? 0),
          failed: Number(body.failed ?? 0),
          jobId: String(body.jobId)
        };
      }

      const retryable = response.status >= 500 || response.status === 429 || response.status === 408;
      if (!retryable || attempt === maxAttempts) {
        throw new Error(`Batch request failed: HTTP ${response.status} ${JSON.stringify(body)}`);
      }

      const delayMs = Math.min(30000, 1000 * 2 ** (attempt - 1));
      process.stderr.write(
        `Batch request retry ${attempt}/${maxAttempts - 1} after HTTP ${response.status}; waiting ${delayMs}ms...\n`
      );
      await sleep(delayMs);
    } catch (error) {
      lastError = error;
      if (attempt === maxAttempts) {
        break;
      }
      const delayMs = Math.min(30000, 1000 * 2 ** (attempt - 1));
      process.stderr.write(
        `Batch request retry ${attempt}/${maxAttempts - 1} after transport error: ${String(
          (error as Error)?.message ?? error
        )}; waiting ${delayMs}ms...\n`
      );
      await sleep(delayMs);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError ?? "Batch request failed"));
}

export function toBatchRequest(parsed: ParseResult, items: NormalizedMessage[], dryRun: boolean): BatchCaptureRequest {
  return {
    sourceSystem: parsed.sourceSystem,
    inputRef: parsed.inputRef,
    dryRun,
    items
  };
}

export function printSummary(label: string, totals: { inserted: number; deduped: number; failed: number; items: number }): void {
  const lines = [
    `${label} import completed`,
    `Items parsed: ${totals.items}`,
    `Inserted: ${totals.inserted}`,
    `Deduped: ${totals.deduped}`,
    `Failed: ${totals.failed}`
  ];

  process.stdout.write(`${lines.join("\n")}\n`);
}
