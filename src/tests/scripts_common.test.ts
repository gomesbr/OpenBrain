import assert from "node:assert/strict";
import { test } from "node:test";
import { chunkArray, toBatchRequest } from "../scripts/common.js";
import type { ParseResult } from "../types.js";

test("chunkArray splits arrays by size", () => {
  const chunks = chunkArray([1, 2, 3, 4, 5], 2);
  assert.deepEqual(chunks, [[1, 2], [3, 4], [5]]);
});

test("toBatchRequest preserves source metadata and dry run", () => {
  const parsed: ParseResult = {
    sourceSystem: "manual",
    inputRef: "input.txt",
    items: []
  };

  const batch = toBatchRequest(
    parsed,
    [
      {
        content: "hello",
        role: "user",
        sourceSystem: "manual",
        chatNamespace: "test.ns"
      }
    ],
    true
  );

  assert.equal(batch.sourceSystem, "manual");
  assert.equal(batch.inputRef, "input.txt");
  assert.equal(batch.dryRun, true);
  assert.equal(batch.items.length, 1);
});
