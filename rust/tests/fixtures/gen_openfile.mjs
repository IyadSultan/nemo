// Regenerate: node rust/tests/fixtures/gen_openfile.mjs > rust/tests/fixtures/openfile.json
//
// Runs a copy of second-brain/openfile.js against a made-up home folder, with a
// fake `mdfind` (find by name) and a fake `open` (records its arguments).
// The Rust test builds the same tree from `tree` and replays `steps`.
// Paths in the output use <HOME> for the temp folder.

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const brain = path.resolve(here, "../../../second-brain");

export const tree = [
  // [path under home, mtime seconds]
  ["notes/wiki/todo.md", 1000],
  ["notes/projects/todo.md", 1001],
  ["notes/Grant Budget.docx", 1002],
  ["notes/protocol.docx", 1003],
  ["notes/بروتوكول الأسئلة القانونية.docx", 1004],
  ["notes/مذكرة الاستشارات القانونية.docx", 1005],
  ["notes/report-2026.pdf", 1006],
  ["notes/zzqx-other.md", 1007],
  ["notes/Laziness_Plan.md", 1008],
  ["notes2/todo.md", 1009],
  ["escape.md", 1010],
  ["Downloads/Grant Budget 2026.xlsx", 2000],
  ["Downloads/grant budget.docx", 2001],
  ["Documents/Lonely Plan.pdf", 2002],
  ["Documents/old/Lonely Plan v1.pdf", 1500],
  ["Library/Caches/grant budget.pdf", 3000],
  [".hidden/grant budget.md", 3001],
  ["Documents/Budget Grant Notes.md", 2500],
];

export const notes = [
  { rel: "wiki/todo.md", title: "todo" },
  { rel: "projects/todo.md", title: "todo" },
  { rel: "Grant Budget.docx", title: "Grant Budget" },
  { rel: "protocol.docx", title: "" },
  { rel: "بروتوكول الأسئلة القانونية.docx", title: "بروتوكول الأسئلة القانونية" },
  { rel: "مذكرة الاستشارات القانونية.docx", title: "مذكرة الاستشارات القانونية" },
  { rel: "report-2026.pdf", title: "report 2026" },
  { rel: "zzqx-other.md", title: "zzqx other" },
  { rel: "Laziness_Plan.md", title: "Laziness Plan" },
  { rel: "../escape.md", title: "escape" },
  { rel: "missing.md", title: "missing" },
];

// Meaning-search answers by query, as (rel, score).
const MEANING = {
  "legal questions": [["بروتوكول الأسئلة القانونية.docx", 0.34], ["مذكرة الاستشارات القانونية.docx", 0.27], ["wiki/todo.md", 0.5]],
  "legal advice": [["بروتوكول الأسئلة القانونية.docx", 0.29], ["مذكرة الاستشارات القانونية.docx", 0.28]],
  "weak match": [["protocol.docx", 0.2]],
  "boom": "throw",
};

const steps = [
  ["openFileJob", "open my todo.md file"],
  ["openFileJob", "Hey, can you please open the grant budget document for me please?"],
  ["openFileJob", "Could you read the protocol word document"],
  ["openFileJob", "read the news"],
  ["openFileJob", "open the email from Sara"],
  ["openFileJob", "open to-do dot md"],
  ["openFileJob", "  “Open it.”  "],
  ["openFileJob", "open the protocol dot docx"],
  ["openFileJob", "bring up the lonely plan pdf"],
  ["openFileJob", "open"],
  ["openFileJob", "open the word document"],
  ["findOnMacJob", "Find the grant budget on my Mac"],
  ["findOnMacJob", "search my finder for a lonely plan."],
  ["findOnMacJob", "where is my budget file on the computer?"],
  ["findOnMacJob", "find my keys"],
  ["compact", "To Do.md"],
  ["compact", "to-do dot md"],
  ["compact", "Grant  Budget.DOCX"],
  ["compact", "بروتوكول الأسئلة القانونية"],
  ["words", "the lazy meetings about a memo on Laziness"],
  ["words", "Grant Budget 2026"],
  ["findFile", "todo"],
  ["findFile", "to do dot md"],
  ["findFile", "grant budget"],
  ["findFile", "zzqx report"],
  ["findFile", "escape"],
  ["findFile", "missing"],
  ["findFile", "laziness plan"],
  ["findFile", ""],
  ["run", { name: "todo", explicit: true }, {}],
  ["run", { name: "grant budget", explicit: false }, {}],
  ["run", { name: "lonely plan", explicit: true }, {}],
  ["run", { name: "number two", explicit: false }, {}],
  ["run", { name: "number three", explicit: false }, {}],
  ["run", { name: "nothing like this", explicit: true }, {}],
  ["run", { name: "nothing like this", explicit: false }, {}],
  ["run", { name: "it", explicit: false }, { recentText: "We discussed بروتوكول الأسئلة القانونية yesterday." }],
  ["run", { name: "the one we discussed", explicit: false }, { recentText: "short" }],
  ["run", { name: "that one", explicit: false }, { recentText: "Both مذكرة الاستشارات القانونية and بروتوكول الأسئلة القانونية and report 2026 came up." }],
  ["run", { name: "that one", explicit: false }, { asked: "open that word one", recentText: "Both مذكرة الاستشارات القانونية and report 2026 came up." }],
  ["run", { name: "legal protocol", explicit: false }, { recentText: "The legal protocol is in بروتوكول الأسئلة القانونية, see it." }],
  ["run", { name: "legal questions", explicit: false }, { asked: "open the legal questions word document", meaning: true }],
  ["run", { name: "legal advice", explicit: false }, { asked: "open the legal advice word file", meaning: true }],
  ["run", { name: "weak match", explicit: true }, { asked: "open weak match word document", meaning: true }],
  ["run", { name: "boom", explicit: true }, { asked: "open boom word document", meaning: true }],
  ["find", { name: "grant budget" }],
  ["run", { name: "number two", explicit: false }, {}],
  ["run", { name: "the third one", explicit: false }, {}],
  ["find", { name: "lonely plan file" }],
  ["find", { name: "zebra" }],
  ["find", { name: "the" }],
  ["run", { name: "it", explicit: false }, { recentText: "nothing named here at all" }],
];

const home = await fs.mkdtemp(path.join(os.tmpdir(), "openfile-home-"));
const bin = await fs.mkdtemp(path.join(os.tmpdir(), "openfile-bin-"));
for (const [rel, mtime] of tree) {
  const full = path.join(home, rel);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, "x");
  await fs.utimes(full, mtime, mtime);
}
const libre = path.join(home, "LibreOffice.app");
await fs.mkdir(libre);
const openLog = path.join(bin, "open.log");
// mdfind -onlyin DIR -name WORD
await fs.writeFile(path.join(bin, "mdfind"), `#!/bin/sh\nfind "$2" -iname "*$4*" | sort\n`, { mode: 0o755 });
await fs.writeFile(path.join(bin, "open"), `#!/bin/sh\nprintf '%s|' "$@" >> "${openLog}"\nprintf '\\n' >> "${openLog}"\n`, { mode: 0o755 });

let source = await fs.readFile(path.join(brain, "openfile.js"), "utf8");
source = source
  .replace('"/usr/bin/mdfind"', JSON.stringify(path.join(bin, "mdfind")))
  .replace('"/usr/bin/open"', JSON.stringify(path.join(bin, "open")))
  .replace('"/Applications/LibreOffice.app"', JSON.stringify(libre))
  .replace("os.homedir()", JSON.stringify(home))
  .replace('"./learnings.js"', JSON.stringify(path.join(brain, "learnings.js")));
source += "\nexport { compact };\n";
const copy = path.join(bin, "openfile.mjs");
await fs.writeFile(copy, source);
const m = await import(copy);
const { words } = await import(path.join(brain, "learnings.js"));

const roots = [path.join(home, "notes"), path.join(home, "notes2")];
const hide = (v) => JSON.parse(JSON.stringify(v ?? null).replaceAll(home, "<HOME>"));
const findByMeaning = async (q) => {
  const hits = MEANING[q];
  if (hits === "throw") throw new Error("meaning search is down");
  return (hits || []).map(([rel, score]) => ({ note: notes.find((n) => n.rel === rel), score }));
};

const log = console.log;
const error = console.error;
console.log = () => {};
console.error = () => {};
const results = [];
for (const [kind, arg, help] of steps) {
  await fs.writeFile(openLog, "");
  let out;
  if (kind === "openFileJob") out = m.openFileJob(arg);
  else if (kind === "findOnMacJob") out = m.findOnMacJob(arg);
  else if (kind === "compact") out = m.compact(arg);
  else if (kind === "words") out = [...words(arg)];
  else if (kind === "findFile") out = m.findFile(arg, notes, roots);
  else if (kind === "find") out = await m.runFindOnMac(arg);
  else {
    const h = { asked: help.asked, recentText: help.recentText, findByMeaning: help.meaning ? findByMeaning : undefined };
    out = await m.runOpenFile(arg, notes, roots, h);
  }
  const opened = (await fs.readFile(openLog, "utf8")).split("\n").filter(Boolean);
  results.push({ kind, arg, help: help ?? null, out: hide(out), opened: hide(opened) });
}

// The email list: rememberList() stores an opener, but "open number one" ignores it.
m.rememberList([{ subject: "Budget" }], async () => "opened in Outlook");
let emailPick;
try {
  emailPick = { out: await m.runOpenFile({ name: "number one", explicit: false }, notes, roots, {}) };
} catch (err) {
  emailPick = { error: err.code || err.message };
}
console.log = log;
console.error = error;

console.log(JSON.stringify({ tree, notes, meaning: MEANING, steps: results, emailPick }, null, 1));
await fs.rm(home, { recursive: true });
await fs.rm(bin, { recursive: true });
