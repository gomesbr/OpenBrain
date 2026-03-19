import assert from "node:assert/strict";
import test from "node:test";
import { buildCompactThreadLabel, parseNetworkCommand } from "../v2_network.js";
import { detectTemporalAnswerOperator } from "../v2_ask.js";

test("buildCompactThreadLabel compresses thread labels to short map labels", () => {
  const result = buildCompactThreadLabel([
    "Need to sort the HOA dues and late fee question this week.",
    "The HOA dues discussion needs a payment follow-up.",
    "Can you confirm the dues amount with the HOA office?"
  ]);

  assert.ok(result.displayLabel.length <= 28);
  assert.match(result.displayLabel, /HOA|Dues/i);
});

test("parseNetworkCommand recognizes graph control commands", () => {
  assert.deepEqual(parseNetworkCommand("collapse all"), {
    action: "collapse_all",
    target: null,
    raw: "collapse all"
  });
  assert.equal(parseNetworkCommand("expand Nelson").action, "expand");
  assert.equal(parseNetworkCommand("focus on family").action, "focus");
  assert.equal(parseNetworkCommand("show weak links").action, "show_weak");
});

test("detectTemporalAnswerOperator recognizes latest and earliest style questions", () => {
  assert.equal(detectTemporalAnswerOperator("What was the last thing I told John about Batman?"), "latest");
  assert.equal(detectTemporalAnswerOperator("What was the first thing Jenn said about Costco?"), "earliest");
  assert.equal(detectTemporalAnswerOperator("Who of my friends loves Costco?"), null);
});
