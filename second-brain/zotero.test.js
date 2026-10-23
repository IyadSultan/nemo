/**
 * Zotero questions turn on read-only Zotero tools for Claude; other questions do not.
 * Run: node --test second-brain/zotero.test.js
 */

import assert from "node:assert/strict";
import test from "node:test";
import { wantsZotero } from "./intents.js";
import { ZOTERO_TOOLS } from "./models.js";

test("questions about Zotero or my library turn it on", () => {
  for (const q of ["Search my Zotero for neuroblastoma", "what's in my library on ketamine?", "find my papers on DNR", "ابحث في زوتيرو"]) {
    assert.equal(wantsZotero(q), true, q);
  }
});

test("other questions leave it off", () => {
  for (const q of ["What is on my calendar today?", "find the ketamine paper in my notes", "library hours tomorrow"]) {
    assert.equal(wantsZotero(q), false, q);
  }
});

test("only read tools are allowed", () => {
  assert.ok(ZOTERO_TOOLS.includes("mcp__zotero__zotero_search_items"));
  assert.ok(!ZOTERO_TOOLS.some((t) => /create|update|delete|add_|merge|batch|manage|switch/.test(t)));
});
