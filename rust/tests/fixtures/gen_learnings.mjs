// Regenerate: node rust/tests/fixtures/gen_learnings.mjs > rust/tests/fixtures/learnings.json
//
// Runs a copy of second-brain/learnings.js on a temp learnings.md and records
// every answer and the file text after it. All content is made up.

import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = await fs.mkdtemp(path.join(os.tmpdir(), "learnings-fixture-"));
const file = path.join(dir, "learnings.md");
let source = await fs.readFile(path.resolve(here, "../../../second-brain/learnings.js"), "utf8");
source = source.replace('path.join(path.dirname(fileURLToPath(import.meta.url)), "learnings.md")', JSON.stringify(file));
await fs.writeFile(path.join(dir, "learnings.mjs"), source);
const m = await import(path.join(dir, "learnings.mjs"));

const parses = [
  "What have you learned about me?", "what do you remember", "show me my memories", "Read the learnings.",
  "Forget that Dr Khaled leads the AML protocol.", "please unlearn about lazy answers", "stop remembering the coffee thing",
  "Learn that Dr Khaled leads the AML protocol!", "keep in mind the tumor board is on Tuesdays", "From now on, keep answers short",
  "Remember: do not be lazy", "remember to always cite the note", "remember that Sara owes me slides", "hello", "",
];

const steps = [
  ["block"],
  ["run", { kind: "list" }],
  ["run", { kind: "forget", text: "anything" }],
  ["run", { kind: "add", text: "dr Khaled leads the AML protocol" }],
  ["run", { kind: "add", text: "keep answers under three sentences." }],
  ["run", { kind: "add", text: "DR KHALED LEADS THE AML PROTOCOL" }],
  ["run", { kind: "add", text: "when I ask you to go to inotes, open https://inotes.example.org/home." }],
  ["run", { kind: "add", text: "go to the portal and https://portal.example.com" }],
  ["run", { kind: "add", text: "If I say go to lab results then open https://lab.example.com/r?x=1), thanks" }],
  ["run", { kind: "add", text: "ß and émile like laziness" }],
  ["run", { kind: "list" }],
  ["run", { kind: "forget", text: "the lazy thing" }],
  ["run", { kind: "forget", text: "zebra crossing" }],
  ["run", { kind: "forget", text: "khaled protocol" }],
  ["block"],
  ["site", "go to inotes"], ["site", "Open ions."], ["site", "please take me to the lab results page"], ["site", "open the portal"],
  ["site", "go to iNotes now"], ["site", "open inotes.example.org"], ["site", "go to"], ["site", "launch the site eyenotes"], ["site", "go to lab"],
  ["closest", "lazy meetings", ["meeting notes", "be lazy about meetings", "nothing"]],
  ["closest", "the one about", ["a", "b"]],
  ["closest", "budget review", ["budget", "review"]],
  ["closest", "x", []],
];

const results = [];
for (const step of steps) {
  let out;
  if (step[0] === "block") out = m.learningsBlock();
  else if (step[0] === "run") out = m.runLearningJob(step[1]);
  else if (step[0] === "site") out = m.siteShortcut(step[1]);
  else out = m.closestIndex(step[1], step[2]);
  results.push({ step, out: out ?? null, file: fsSync.existsSync(file) ? fsSync.readFileSync(file, "utf8") : null });
}

// The size limits: 45 lines, some long.
const many = Array.from({ length: 45 }, (_, i) => `Fact ${i} ${"x".repeat(i % 5 === 0 ? 400 : 10)}`);
await fs.writeFile(file, `# Learnings\n\n${many.map((l) => `- ${l}`).join("\n")}\n  - not a line\n-no space\n`);
const bigBlock = m.learningsBlock();

console.log(JSON.stringify({
  parses: parses.map((q) => ({ q, out: m.learningJob(q) })),
  steps: results,
  big: { file: fsSync.readFileSync(file, "utf8"), block: bigBlock },
}, null, 1));
await fs.rm(dir, { recursive: true });
