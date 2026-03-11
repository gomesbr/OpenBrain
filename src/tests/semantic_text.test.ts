import assert from "node:assert/strict";
import { test } from "node:test";
import {
  expandLexicalTokens,
  extractContextKeywords,
  extractEmojiTerms,
  toSemanticEmbeddingText
} from "../semantic_text.js";

test("extractEmojiTerms maps emoji to semantic words", () => {
  const terms = extractEmojiTerms("\u{1F618}");
  assert.equal(terms.includes("kiss"), true);
  assert.equal(terms.includes("affection"), true);
});

test("toSemanticEmbeddingText preserves source text and appends emoji semantics", () => {
  const value = toSemanticEmbeddingText(`Good night ${"\u{1F618}"}`);
  assert.equal(value.includes("Good night"), true);
  assert.equal(value.includes("emoji_semantics"), true);
  assert.equal(value.includes("kiss"), true);
});

test("toSemanticEmbeddingText appends conversation context terms", () => {
  const value = toSemanticEmbeddingText("ok", { contextTerms: ["meeting", "pickleball"] });
  assert.equal(value.includes("conversation_context"), true);
  assert.equal(value.includes("meeting"), true);
});

test("extractContextKeywords keeps high-signal context tokens", () => {
  const terms = extractContextKeywords([
    "Team meeting about pickleball schedule and court booking",
    "Pickleball meeting moved to next week"
  ]);
  assert.equal(terms.includes("pickleball"), true);
  assert.equal(terms.includes("meeting"), true);
});

test("expandLexicalTokens bridges word query to emoji symbols", () => {
  const expanded = expandLexicalTokens(["kiss", "yesterday"]);
  assert.equal(expanded.includes("\u{1F618}"), true);
  assert.equal(expanded.includes("\u{1F48B}"), true);
  assert.equal(expanded.includes("kiss"), true);
});
