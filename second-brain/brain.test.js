/**
 * Today's calls in the prompt: a search hit is dropped only when that call is already in the block.
 * Run: node --test second-brain/brain.test.js
 */

import assert from "node:assert/strict";
import test from "node:test";
import { inTodayBlock } from "./brain.js";

const block = [
  "Yesterday (2026-10-20), not in the nightly memory yet:\n## 09:15\nQ: budget?\nA: Ten.\n\n## 22:40\nQ: late one\nA: Yes.",
  "Today so far (2026-10-21), from the call log. This is not in the nightly memory yet. Use it when the user asks what they asked today, or what you said today:\n## 08:05\nQ: first\nA: Hi.\n\n## 10:30\nQ: second\nA: Ok.",
].join("\n\n");

test("today's call in the block is not repeated as a note", () => {
  assert.equal(inTodayBlock("daylog/2026-10-21.md#08:05", block), true);
  assert.equal(inTodayBlock("daylog/2026-10-21.md#10:30", block), true);
});

test("yesterday's call in the block is not repeated either", () => {
  assert.equal(inTodayBlock("daylog/2026-10-20.md#09:15", block), true);
  assert.equal(inTodayBlock("daylog/2026-10-20.md#22:40", block), true);
});

test("a time from the other day does not hide this day's call", () => {
  // 09:15 is in yesterday's part only. Today's 09:15 was cut off, so it stays a note.
  assert.equal(inTodayBlock("daylog/2026-10-21.md#09:15", block), false);
  assert.equal(inTodayBlock("daylog/2026-10-20.md#10:30", block), false);
});

test("other notes and days outside the block are kept", () => {
  assert.equal(inTodayBlock("brain.md#2026-10-21", block), false);
  assert.equal(inTodayBlock("daylog/2026-10-19.md#08:05", block), false);
  assert.equal(inTodayBlock("daylog/2026-10-21.md#08:05", ""), false);
});
