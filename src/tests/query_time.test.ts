import assert from "node:assert/strict";
import { test } from "node:test";
import { parseTemporalIntent, temporalRelevance, timestampInHardRange } from "../query_time.js";

test("parseTemporalIntent handles yesterday as hard range", () => {
  const now = new Date("2026-03-05T12:00:00.000Z");
  const parsed = parseTemporalIntent("who sent me a kiss yesterday?", now);
  assert.equal(parsed.mode, "hard_range");
  assert.ok(parsed.start);
  assert.ok(parsed.end);
  assert.equal(timestampInHardRange("2026-03-04T15:00:00.000Z", parsed), true);
  assert.equal(timestampInHardRange("2026-03-02T03:00:00.000Z", parsed), false);
});

test("parseTemporalIntent handles month hint without year", () => {
  const parsed = parseTemporalIntent("who was in the meeting about pickleball on february?");
  assert.equal(parsed.mode, "month_hint");
  assert.equal(parsed.targetMonth, 2);
});

test("parseTemporalIntent supports portuguese and spanish month wording", () => {
  const pt = parseTemporalIntent("quem estava na reuniao de pickleball em fevereiro?");
  const es = parseTemporalIntent("quien estuvo en la reunion de pickleball en febrero?");
  assert.equal(pt.targetMonth, 2);
  assert.equal(es.targetMonth, 2);
});

test("temporal relevance favors month-closest and recent records", () => {
  const now = new Date("2026-03-05T12:00:00.000Z");
  const parsed = parseTemporalIntent("meeting in february", now);
  const jan2026 = temporalRelevance("2026-01-15T12:00:00.000Z", parsed, now);
  const jun2025 = temporalRelevance("2025-06-15T12:00:00.000Z", parsed, now);
  const dec2025 = temporalRelevance("2025-12-15T12:00:00.000Z", parsed, now);
  assert.equal(jan2026 > jun2025, true);
  assert.equal(jan2026 > dec2025, true);
});
