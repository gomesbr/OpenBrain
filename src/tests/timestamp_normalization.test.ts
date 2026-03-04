import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeTimestamp } from "../time.js";

test("normalizeTimestamp handles epoch seconds and milliseconds", () => {
  const sec = normalizeTimestamp(1700000000);
  const ms = normalizeTimestamp(1700000000000);
  assert.equal(sec, "2023-11-14T22:13:20.000Z");
  assert.equal(ms, "2023-11-14T22:13:20.000Z");
});

test("normalizeTimestamp handles numeric string epochs", () => {
  const sec = normalizeTimestamp("1700000000");
  const ms = normalizeTimestamp("1700000000000");
  assert.equal(sec, "2023-11-14T22:13:20.000Z");
  assert.equal(ms, "2023-11-14T22:13:20.000Z");
});

test("normalizeTimestamp accepts ISO with explicit timezone and rejects ambiguous slash format", () => {
  assert.equal(normalizeTimestamp("2026-03-04T11:30:00Z"), "2026-03-04T11:30:00.000Z");
  assert.equal(normalizeTimestamp("03/04/2026 11:30"), null);
});

test("normalizeTimestamp rejects far-future values", () => {
  const futureMs = Date.now() + (3 * 24 * 60 * 60 * 1000);
  assert.equal(normalizeTimestamp(futureMs), null);
});

test("normalizeTimestamp rejects years before 1983 floor", () => {
  assert.equal(normalizeTimestamp("1982-12-31T23:59:59Z"), null);
  assert.equal(normalizeTimestamp("1983-01-01T00:00:00Z"), "1983-01-01T00:00:00.000Z");
});
