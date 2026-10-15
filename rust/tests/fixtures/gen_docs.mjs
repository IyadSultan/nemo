// Regenerate: node rust/tests/fixtures/gen_docs.mjs > rust/tests/fixtures/docs.json
//
// Runs a copy of second-brain/docs.js on a made-up folder with fake pdftotext
// and textutil (they print the file itself; "FAIL" in a file makes them fail).
// Three loads: fresh, cached, and after one file changed. Records the notes,
// which files the fakes read, and the cache file text. Paths use <ROOT>.

import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const base = await fs.mkdtemp(path.join(os.tmpdir(), "docs-fixture-"));
const root = path.join(base, "root");
const bin = path.join(base, "bin");
await fs.mkdir(bin);

const long = "Long report\f" + "word ".repeat(12_000) + "😀 tail";
// [path under root, content, mtime seconds (fractional: tests Math.round on mtimeMs)]
const tree = [
  ["Grant_Budget-final.pdf", "Budget  \t\nline two\n\n\n\n\nafter gap\fpage two   \n", 1_700_000_000.0004],
  ["sub/Protocol v2.DOCX", "Protocol text\r\nwith CRLF  \r\n", 1_700_000_100.0006],
  ["sub/deeper/notes.pdf", "Deep note", 1_700_000_200],
  ["sub/broken.pdf", "FAIL here", 1_700_000_300],
  ["empty.pdf", "", 1_700_000_400],
  ["blank.docx", "   \n\f  ", 1_700_000_500],
  [".hidden.pdf", "hidden", 1_700_000_600],
  ["~$lock.docx", "lock", 1_700_000_700],
  ["node_modules/pkg.pdf", "skipped dir", 1_700_000_800],
  ["old.doc", "not docx", 1_700_000_900],
  ["readme.md", "not a doc", 1_700_001_000],
  ["long.pdf", long, 1_700_001_100],
  ["تقرير الأسئلة.pdf", "نص عربي", 1_700_001_200],
];
for (const [rel, text, mtime] of tree) {
  const full = path.join(root, rel);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, text);
  await fs.utimes(full, mtime, mtime);
}
await fs.symlink(path.join(root, "sub/deeper/notes.pdf"), path.join(root, "link.pdf"));

const calls = path.join(bin, "calls.log");
// pdftotext -q -enc UTF-8 FILE -   |   textutil -convert txt -stdout FILE
await fs.writeFile(path.join(bin, "pdftotext"), `#!/bin/sh\necho "pdftotext $4" >> "${calls}"\ngrep -q FAIL "$4" && { echo "Syntax Error" >&2; exit 1; }\ncat "$4"\n`, { mode: 0o755 });
await fs.writeFile(path.join(bin, "textutil"), `#!/bin/sh\necho "textutil $4" >> "${calls}"\ngrep -q FAIL "$4" && exit 1\ncat "$4"\n`, { mode: 0o755 });

const cacheFile = path.join(base, "tmp", "doc-text.json");
let source = await fs.readFile(path.resolve(here, "../../../second-brain/docs.js"), "utf8");
source = source
  .replace('path.join(path.dirname(fileURLToPath(import.meta.url)), "tmp", "doc-text.json")', JSON.stringify(cacheFile))
  .replace('"/opt/homebrew/bin/pdftotext"', JSON.stringify(path.join(bin, "pdftotext")))
  .replace('"/usr/bin/textutil"', JSON.stringify(path.join(bin, "textutil")));
await fs.writeFile(path.join(bin, "docs.mjs"), source);
const { loadDocs } = await import(path.join(bin, "docs.mjs"));

// Exact nanosecond mtimes, so Rust can set the very same values.
const mtimes = {};
for (const [rel] of tree) mtimes[rel] = fsSync.statSync(path.join(root, rel), { bigint: true }).mtimeNs.toString();

const hide = (v) => JSON.parse(JSON.stringify(v).replaceAll(root, "<ROOT>"));
const skip = new Set(["node_modules"]);
const log = console.log;
const error = console.error;
console.log = () => {};
console.error = () => {};
const loads = [];
async function load(label) {
  await fs.writeFile(calls, "");
  const docs = await loadDocs(root, skip);
  loads.push({
    label,
    docs: hide(docs),
    calls: hide(fsSync.readFileSync(calls, "utf8").split("\n").filter(Boolean)),
    cache: fsSync.readFileSync(cacheFile, "utf8").replaceAll(root, "<ROOT>"),
  });
}
await load("fresh");
await load("cached");
await fs.writeFile(path.join(root, "sub/deeper/notes.pdf"), "Deep note, edited");
await fs.utimes(path.join(root, "sub/deeper/notes.pdf"), 1_700_002_000.5, 1_700_002_000.5);
await load("one file changed");
console.log = log;
console.error = error;

console.log(JSON.stringify({ tree: tree.map(([rel, text]) => [rel, text]), mtimes, changedMtime: fsSync.statSync(path.join(root, "sub/deeper/notes.pdf"), { bigint: true }).mtimeNs.toString(), loads }, null, 1));
await fs.rm(base, { recursive: true });
