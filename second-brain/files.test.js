/**
 * A file added to the chat stays with the chat.
 * "What is this document about? I just uploaded it" must use that file, not a search of old notes.
 * Run: node --test second-brain/files.test.js
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { asksAboutChatFile, buildPrompt, cleanChatFiles, wikiExcerpt } from "./prompt.js";

const lung = {
  name: "lungdiff.pdf",
  title: "LungDiff KHCC Case Report Form",
  summary: "The case report form for the LungDiff study at KHCC.",
  made: false,
};

test("the question about a file just uploaded is about that file", () => {
  assert.equal(asksAboutChatFile("what is this document about? I just uploaded it."), true);
  assert.equal(asksAboutChatFile("what did the file you made say?"), true);
});

test("a search for a different paper is not about the chat file", () => {
  assert.equal(asksAboutChatFile("find the ketamine paper"), false);
  assert.equal(asksAboutChatFile("what is on my calendar today"), false);
});

test("a file with no name is dropped", () => {
  const files = cleanChatFiles([{ name: "  " }, { title: "orphan" }, lung]);
  assert.equal(files.length, 1);
  assert.equal(files[0].name, "lungdiff.pdf");
  assert.equal(files[0].made, false);
});

test("the prompt names the file and tells the model not to pick a different note", () => {
  const prompt = buildPrompt("what is this document about? I just uploaded it.", [], [], [], "", "", "", [lung]);
  assert.match(prompt, /Added to this chat: lungdiff\.pdf/);
  assert.match(prompt, /LungDiff KHCC Case Report Form/);
  assert.match(prompt, /Do not say the file has no name/);
  assert.match(prompt, /Do not answer about a different note/);
});

test("a wiki page outside the vault is not read", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "brain-vault-"));
  const outside = path.join(os.tmpdir(), `secret-${Date.now()}.md`);
  fs.writeFileSync(outside, "a private note that must not be read");
  try {
    assert.equal(wikiExcerpt(outside, root), "");
    const inside = path.join(root, "lung.md");
    fs.writeFileSync(inside, "LungDiff form text");
    assert.equal(wikiExcerpt(inside, root), "LungDiff form text");
  } finally {
    fs.rmSync(outside, { force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});
