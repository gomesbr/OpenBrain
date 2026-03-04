import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { parseWhatsappExport } from "../importers/whatsapp.js";

test("whatsapp importer parses standard export and skips media lines", () => {
  const dir = mkdtempSync(join(tmpdir(), "openbrain-whatsapp-"));
  try {
    const inputPath = join(dir, "chat_with_agent.txt");
    const raw = [
      "03/01/26, 9:30 AM - Fabio: Morning plan?",
      "03/01/26, 9:31 AM - Agent: <Media omitted>",
      "03/01/26, 9:32 AM - Agent: Use tighter stop and avoid new entries.",
      "Continuation line from same message."
    ].join("\n");

    writeFileSync(inputPath, raw, "utf8");

    const parsed = parseWhatsappExport(inputPath, "personal.main");
    assert.equal(parsed.items.length, 2);
    assert.equal(parsed.items[0]?.sourceSystem, "whatsapp");
    assert.equal(parsed.items[0]?.role, "user");
    assert.equal(parsed.items[1]?.role, "user");
    assert.match(parsed.items[1]?.content ?? "", /Continuation line/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
