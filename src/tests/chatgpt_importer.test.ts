import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import AdmZip from "adm-zip";
import { parseChatGptExport } from "../importers/chatgpt.js";

test("chatgpt importer parses ZIP conversation export", () => {
  const dir = mkdtempSync(join(tmpdir(), "openbrain-chatgpt-"));
  try {
    const zipPath = join(dir, "chatgpt_export.zip");
    const data = [
      {
        id: "conv-1",
        title: "Trading brainstorm",
        mapping: {
          "1": {
            id: "1",
            message: {
              id: "m1",
              author: { role: "user" },
              create_time: 1700000000,
              content: { parts: ["What is the setup?"] }
            }
          },
          "2": {
            id: "2",
            message: {
              id: "m2",
              author: { role: "assistant" },
              create_time: 1700000060,
              content: { parts: ["Watch the opening range breakout."] }
            }
          }
        }
      }
    ];

    const zip = new AdmZip();
    zip.addFile("conversations.json", Buffer.from(JSON.stringify(data), "utf8"));
    zip.writeZip(zipPath);

    const parsed = parseChatGptExport(zipPath, "personal.main", "fabio");
    assert.equal(parsed.sourceSystem, "chatgpt");
    assert.equal(parsed.items.length, 2);
    assert.equal(parsed.items[0]?.role, "user");
    assert.equal(parsed.items[1]?.role, "assistant");
    assert.equal(parsed.items[0]?.sourceConversationId, "conv-1");
    assert.equal(parsed.items[0]?.idempotencyKey, "chatgpt:conv-1:m1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("chatgpt importer parses JSON fallback conversation shape", () => {
  const dir = mkdtempSync(join(tmpdir(), "openbrain-chatgpt-json-"));
  try {
    const jsonPath = join(dir, "conversations.json");
    const data = {
      conversations: [
        {
          conversation_id: "conv-2",
          title: "Fallback",
          messages: [
            { id: "a", role: "user", content: ["hi"], create_time: 1700000100 },
            { id: "b", role: "assistant", content: ["hello"], create_time: 1700000200 }
          ]
        }
      ]
    };
    writeFileSync(jsonPath, JSON.stringify(data), "utf8");

    const parsed = parseChatGptExport(jsonPath, "personal.main", "fabio");
    assert.equal(parsed.items.length, 2);
    assert.equal(parsed.items[0]?.role, "user");
    assert.equal(parsed.items[1]?.role, "assistant");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
