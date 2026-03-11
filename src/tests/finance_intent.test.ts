import assert from "node:assert/strict";
import { test } from "node:test";
import {
  computeFinanceSignal,
  detectQueryIntent,
  extractMoneyAmounts,
  isPersonalFinanceEvidenceCandidate,
  isBalanceEvidenceCandidate,
  summarizeFinanceBalance
} from "../finance_intent.js";

test("detectQueryIntent identifies balance intent", () => {
  const intent = detectQueryIntent("How much money do I have?");
  assert.equal(intent.kind, "finance_balance");
  assert.equal(intent.personal, true);
});

test("extractMoneyAmounts ignores tiny unlabeled numbers", () => {
  const amounts = extractMoneyAmounts("I found 20 ideas, 360 days and $300 in one account, plus 178317.30 total.");
  assert.equal(amounts.includes("20"), false);
  assert.equal(amounts.includes("360"), false);
  assert.equal(amounts.includes("$300"), true);
  assert.equal(amounts.includes("178317.30"), true);
});

test("computeFinanceSignal penalizes question-like lines", () => {
  const weak = computeFinanceSignal("how much money?", "", "whatsapp", { kind: "finance_balance", personal: true });
  const strong = computeFinanceSignal("My account balance is $180,345.13", "", "whatsapp", {
    kind: "finance_balance",
    personal: true
  });
  assert.equal(strong > weak, true);
});

test("isBalanceEvidenceCandidate keeps explicit balance and filters generic money mentions", () => {
  assert.equal(isBalanceEvidenceCandidate("My account balance was 180,345.13 before marriage."), true);
  assert.equal(isBalanceEvidenceCandidate("You dont have to pay any money."), false);
});

test("isPersonalFinanceEvidenceCandidate keeps personal statements and rejects generic calc text", () => {
  assert.equal(isPersonalFinanceEvidenceCandidate("My account balance was $180,345.13 before marriage."), true);
  assert.equal(
    isPersonalFinanceEvidenceCandidate("To calculate total deposits, sum all rows and return total amount."),
    false
  );
  assert.equal(
    isPersonalFinanceEvidenceCandidate(
      "I will sum all deposits and return the total balance table.",
      "grok",
      "assistant"
    ),
    false
  );
});

test("summarizeFinanceBalance favors strong balance evidence", () => {
  const answer = summarizeFinanceBalance([
    {
      excerpt: "How much money?",
      similarity: 0.75,
      sourceTimestamp: "2026-03-01T00:00:00Z"
    },
    {
      excerpt: "My account balance was $180,345.13 before marriage.",
      similarity: 0.69,
      sourceTimestamp: "2026-03-02T00:00:00Z"
    }
  ]);
  assert.equal(answer.includes("$180,345.13"), true);
});
