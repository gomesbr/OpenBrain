import test from "node:test";
import assert from "node:assert/strict";
import { inferStructuredSignals } from "../domain_inference.js";

test("inferStructuredSignals flags WhatsApp encryption boilerplate as system event", () => {
  const line = "Messages and calls are end-to-end encrypted. Only people in this chat can read, listen to, or share them.";
  const result = inferStructuredSignals({
    text: line,
    sourceSystem: "whatsapp",
    contextWindow: []
  });

  assert.equal(result.isSystemEvent, true);
  assert.ok(result.noiseReasons.length > 0);
  assert.equal(result.domainTop.length, 0);
  assert.ok(result.confidence <= 0.1);
});

test("inferStructuredSignals keeps real personal semantics", () => {
  const line = "I was talking to my wife about our budget and we need to save more this month.";
  const result = inferStructuredSignals({
    text: line,
    sourceSystem: "whatsapp",
    contextWindow: ["we reviewed our checking account and expenses"]
  });

  assert.equal(result.isSystemEvent, false);
  assert.ok(result.domainScores.romantic_relationship >= 0.25);
  assert.ok(result.domainScores.financial_behavior >= 0.25);
  assert.ok(result.domainTop.includes("romantic_relationship"));
});
