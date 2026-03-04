import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import AdmZip from "adm-zip";
import { parseGrokExport } from "../importers/grok.js";

test("grok importer parses structured JSON export", () => {
  const dir = mkdtempSync(join(tmpdir(), "openbrain-grok-json-"));
  try {
    const jsonPath = join(dir, "grok_export.json");
    const data = {
      conversations: [
        {
          id: "g-1",
          messages: [
            { id: "1", role: "user", text: "Analyze TSLA setup", created_at: "2026-03-01T10:00:00Z" },
            { id: "2", role: "assistant", text: "TSLA has an opening range pattern.", created_at: "2026-03-01T10:01:00Z" }
          ]
        }
      ]
    };
    writeFileSync(jsonPath, JSON.stringify(data), "utf8");

    const parsed = parseGrokExport(jsonPath, "personal.main", "fabio");
    assert.equal(parsed.sourceSystem, "grok");
    assert.equal(parsed.items.length, 2);
    assert.equal(parsed.items[0]?.role, "user");
    assert.equal(parsed.items[1]?.role, "assistant");
    assert.equal(parsed.items[0]?.sourceConversationId, "g-1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("grok importer falls back to text dumps", () => {
  const dir = mkdtempSync(join(tmpdir(), "openbrain-grok-text-"));
  try {
    const txtPath = join(dir, "grok_dump.txt");
    writeFileSync(txtPath, "User: first line\nGrok: second line", "utf8");

    const parsed = parseGrokExport(txtPath, "personal.main", "fabio");
    assert.equal(parsed.items.length, 2);
    assert.equal(parsed.items[0]?.role, "user");
    assert.equal(parsed.items[1]?.role, "assistant");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("grok importer parses prod-grok-backend ZIP exports", () => {
  const dir = mkdtempSync(join(tmpdir(), "openbrain-grok-zip-"));
  try {
    const zipPath = join(dir, "grok_dump.zip");
    const backendPayload = {
      conversations: [
        {
          conversation: {
            id: "conv-zip-1",
            title: "Zip conversation"
          },
          responses: [
            {
              response: {
                _id: "resp-1",
                conversation_id: "conv-zip-1",
                sender: "human",
                message: "first user message",
                create_time: { $date: { $numberLong: "1772416147414" } },
                model: "grok-4"
              }
            },
            {
              response: {
                _id: "resp-2",
                conversation_id: "conv-zip-1",
                sender: "assistant",
                message: "assistant answer",
                parent_response_id: "resp-1",
                create_time: { $date: { $numberLong: "1772416164212" } },
                model: "grok-4"
              }
            }
          ]
        }
      ]
    };

    const zip = new AdmZip();
    zip.addFile(
      "ttl/30d/export_data/abc/prod-grok-backend.json",
      Buffer.from(JSON.stringify(backendPayload), "utf8")
    );
    zip.writeZip(zipPath);

    const parsed = parseGrokExport(zipPath, "personal.main", "fabio");
    assert.equal(parsed.items.length, 2);
    assert.equal(parsed.items[0]?.role, "user");
    assert.equal(parsed.items[1]?.role, "assistant");
    assert.equal(parsed.items[0]?.sourceConversationId, "conv-zip-1");
    assert.equal(parsed.items[0]?.sourceMessageId, "resp-1");
    assert.equal(parsed.items[0]?.sourceTimestamp, "2026-03-02T01:49:07.414Z");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
