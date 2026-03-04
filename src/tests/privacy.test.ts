import assert from "node:assert/strict";
import { test } from "node:test";
import { pseudonymFor, redactText } from "../privacy.js";

test("pseudonymFor is deterministic", () => {
  const a = pseudonymFor("John Martinez");
  const b = pseudonymFor("John Martinez");
  assert.equal(a, b);
  assert.match(a, /^Person-[A-Z0-9]{6}$/);
});

test("redactText masks obvious contact pii in share_safe mode", () => {
  const raw = "Email me at john@example.com or +1 (555) 222-3333.";
  const redacted = redactText(raw, "share_safe");
  assert.match(redacted, /\[redacted-email\]/);
  assert.match(redacted, /\[redacted-phone\]/);
});

test("redactText returns synthetic summaries in demo mode", () => {
  const text = "This is highly personal data about my routine.";
  const result = redactText(text, "demo");
  assert.match(result, /^Synthetic summary [a-f0-9]{8}\.$/);
});
