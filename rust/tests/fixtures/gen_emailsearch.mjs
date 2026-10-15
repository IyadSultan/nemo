// Regenerate: node rust/tests/fixtures/gen_emailsearch.mjs > rust/tests/fixtures/emailsearch.json
//
// Runs a copy of second-brain/emailsearch.js on made-up saved emails, with a
// fixed clock (Asia/Amman) and a fake osascript that records the search text.
// A query containing "blocked" or "broken" makes the fake fail like Outlook does.

process.env.TZ = "Asia/Amman";

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const brain = path.resolve(here, "../../../second-brain");
const NOW = Date.UTC(2026, 9, 15, 10, 30); // 13:30 in Amman

// [file name, first lines, mtime ms]
const mails = [
  ["FW_ Budget review for Q4.txt", "From: Sara Haddad\nSubject: Budget", NOW - 2 * 3600e3],
  ["RE_ RE_ IRB renewal due.md", "From: Omar\nThe IRB renewal is due Friday.", NOW - 20 * 3600e3],
  ["Budget_draft___v2.txt", "From: Lee\nbudget numbers", NOW - 3 * 86400e3],
  ["Weekly update.txt", "From: Sara Haddad\nNothing about money.", NOW - 5 * 86400e3],
  ["Tumor board agenda.txt", "From: Dr Kim\nبروتوكول budget items " + "x".repeat(1990) + "hidden-word", NOW - 40 * 86400e3],
  ["Lunch.txt", "From: Sara\nSee you", NOW - 1 * 86400e3 + 1],
  ["blocked request.txt", "From: IT", NOW - 6 * 86400e3],
  ["broken thing.txt", "From: IT", NOW - 7 * 86400e3],
  ["Budget final.txt", "From: Finance", NOW - 9 * 86400e3],
  ["Café menu é.txt", "From: Kitchen\nCAFÉ", NOW - 400 * 86400e3],
];

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mail-fixture-"));
const raw = path.join(dir, "raw");
await fs.mkdir(raw);
const rawMail = [];
for (const [name, text, mtime] of mails) {
  const full = path.join(raw, name);
  await fs.writeFile(full, text);
  rawMail.push({
    rel: `raw/${name}`,
    title: name.replace(/\.(txt|md)$/i, ""),
    full,
    mtime,
    size: Buffer.byteLength(text),
    lowerName: name.toLowerCase(),
    words: name.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length >= 4),
  });
}
const calls = path.join(dir, "calls.log");
const fake = path.join(dir, "osascript");
await fs.writeFile(fake, `#!/bin/sh
printf '%s\\n' "$3" >> "${calls}"
case "$3" in
  *blocked*) echo "execution error: System Events got an error: osascript is not allowed assistive access. (-1719)" >&2; exit 1 ;;
  *broken*) echo "execution error: Microsoft Outlook got an error." >&2; echo "second line" >&2; exit 1 ;;
esac
`, { mode: 0o755 });

let source = await fs.readFile(path.join(brain, "emailsearch.js"), "utf8");
const script = source.match(/const OUTLOOK_SEARCH = `([\s\S]*?)`;/)[1];
source = source
  .replace('"/usr/bin/osascript"', JSON.stringify(fake))
  .replace('"./openfile.js"', JSON.stringify(path.join(brain, "openfile.js")));
await fs.writeFile(path.join(dir, "emailsearch.mjs"), source);

const RealDate = Date;
globalThis.Date = class extends RealDate {
  constructor(...args) {
    super(...(args.length ? args : [NOW]));
  }
  static now() {
    return NOW;
  }
};
const m = await import(path.join(dir, "emailsearch.mjs"));

const parses = [
  "Find the email from Sara about the budget",
  "open the email about the IRB renewal.",
  "Hey, can you pull up my emails titled weekly update?",
  "show me that e-mail with Lee",
  "search my inbox for budget numbers!",
  "search outlook for",
  "find the budget file",
  "“Locate an email regarding café”",
];
const searches = ["budget", "sara budget", "from the dr", "irb", "hidden-word", "بروتوكول", "café", "zzz nothing", "money"];
const jobs = [
  { query: "about the budget", open: false },
  { query: "about the IRB renewal", open: true },
  { query: "about budget final", open: true },
  { query: "from Sara about money", open: false },
  { query: "about lunch", open: false },
  { query: "blocked request", open: true },
  { query: "broken thing", open: true },
  { query: "zzz", open: true },
];

const log = console.log;
const error = console.error;
console.log = () => {};
console.error = () => {};
const runs = [];
for (const job of jobs) {
  await fs.writeFile(calls, "");
  const out = await m.runEmailSearch(job, rawMail);
  runs.push({ job, out, queries: (await fs.readFile(calls, "utf8")).split("\n").filter(Boolean) });
}
console.log = log;
console.error = error;

console.log(JSON.stringify({
  now: NOW,
  script,
  mails: rawMail.map(({ full, ...rest }) => rest),
  texts: Object.fromEntries(mails.map(([name, text]) => [name, text])),
  parses: parses.map((q) => ({ q, out: m.emailSearchJob(q) })),
  searches: searches.map((q) => ({ q, out: m.searchEmails(q, rawMail).map((mail) => mail.rel) })),
  runs,
}, null, 1));
await fs.rm(dir, { recursive: true });
