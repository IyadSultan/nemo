// Regenerate: node rust/tests/fixtures/gen_embed.mjs > rust/tests/fixtures/embed.json
//
// Runs the real second-brain/embed.js against a fake Ollama whose "embedding"
// is a letter count (a-z, plus a constant 1). The Rust test uses the same fake,
// so the cache file and search scores must match exactly.

import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createSemanticIndex } from "../../../second-brain/embed.js";

export function fakeEmbedding(text) {
  const v = new Array(27).fill(0);
  for (const ch of text.toLowerCase()) {
    const c = ch.charCodeAt(0) - 97;
    if (c >= 0 && c < 26) v[c] += 1;
  }
  v[26] = 1;
  return v;
}

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    const { input } = JSON.parse(body);
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ embeddings: input.map(fakeEmbedding) }));
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const ollamaUrl = `http://127.0.0.1:${server.address().port}`;

const para = (ch, n) => ch.repeat(n);
const notes = [
  { title: "ASCO talk", text: "ASCO talk\n\nOncology presentation slides for the June meeting.\n\nBring the poster tube." },
  { title: "Groceries", text: "Groceries\nmilk eggs bread zucchini" },
  { title: "Title only", text: "Title only" },
  // Blank lines that hold spaces/tabs, CRLF, and a BOM at the start of the body.
  { title: "Odd spacing", text: "Odd spacing﻿ first para\r\n \t\r\nsecond para\n \nthird para  " },
  // Paragraphs that add up past 1000 chars, so they split into pieces.
  { title: "Long", text: "Long\n\n" + [para("a", 600), para("b", 600), para("c", 300), para("d", 900)].join("\n\n") },
  // One huge paragraph: cut every 1000 chars while over 1500.
  { title: "Wall", text: "Wall\n" + para("w", 4200) },
  // More than 8 pieces: the rest is dropped.
  { title: "Many", text: "Many\n\n" + Array.from({ length: 12 }, (_, i) => para(String.fromCharCode(101 + i), 950)).join("\n\n") },
  // Emoji and Arabic straddling the 1000-unit cut (JS counts UTF-16 units).
  { title: "Unicode", text: "Unicode\n" + para("x", 999) + "😀" + "مرحبا".repeat(200) + "zebra quiz" },
];

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "embed-fixture-"));
const cacheFile = path.join(dir, "embeddings.json");
const index = createSemanticIndex({ ollamaUrl, model: "embeddinggemma", cacheFile });
const log = console.log;
console.log = () => {}; // keep progress lines out of the fixture
await index.build(notes);

const queries = ["oncology slides", "zucchini milk", "wwww", "qqqq jjjj", "spacing para"];
const searches = [];
for (const q of queries) {
  const hits = await index.search(q, q === "wwww" ? 2 : 20);
  searches.push({
    query: q,
    // Buffer round-trip turns a lone surrogate into U+FFFD, as Rust stores it.
    hits: hits.map((h) => ({ note: notes.indexOf(h.note), score: h.score, text: Buffer.from(h.text).toString() })),
  });
}
console.log = log;

const cache = JSON.parse(await fs.readFile(cacheFile, "utf8"));
console.log(JSON.stringify({ notes, cache, searches }, null, 1));
await fs.rm(dir, { recursive: true });
server.close();
