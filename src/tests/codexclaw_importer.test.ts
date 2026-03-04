import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import Database from "better-sqlite3";
import { parseCodexClawBackfill } from "../importers/codexclaw.js";

test("codexclaw importer normalizes seconds and milliseconds timestamps", () => {
  const dir = mkdtempSync(join(tmpdir(), "openbrain-codexclaw-"));
  try {
    const dbPath = join(dir, "codexclaw.db");
    const db = new Database(dbPath);

    db.exec(`
      CREATE TABLE memory_chunks (
        id INTEGER PRIMARY KEY,
        chat_id TEXT NOT NULL,
        source_path TEXT,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE reports (
        id INTEGER PRIMARY KEY,
        chat_id TEXT NOT NULL,
        agent TEXT NOT NULL,
        file_path TEXT,
        summary TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);

    // Seconds epoch.
    db.prepare(
      "INSERT INTO memory_chunks (id, chat_id, source_path, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(1, "8041307210", "telegram", "user", "Need scheduler status.", 1772416147);

    // Milliseconds epoch.
    db.prepare(
      "INSERT INTO reports (id, chat_id, agent, file_path, summary, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(1, "8041307210", "strategist", "report.md", "Scheduler checked.", 1772416164212);

    db.close();

    const parsed = parseCodexClawBackfill({
      dbPath,
      namespacePrefix: "codexclaw"
    });

    const memoryItem = parsed.items.find((item) => item.sourceMessageId === "memory:1");
    const reportItem = parsed.items.find((item) => item.sourceMessageId === "report:1");

    assert.ok(memoryItem);
    assert.ok(reportItem);
    assert.equal(memoryItem?.sourceTimestamp, "2026-03-02T01:49:07.000Z");
    assert.equal(reportItem?.sourceTimestamp, "2026-03-02T01:49:24.212Z");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
