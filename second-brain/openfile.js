/**
 * "Open my todo.md file"           -> opens wiki/todo.md in its usual app on this Mac.
 * "Find the grant budget on my Mac" -> lists up to three matches from Spotlight (the Finder's search).
 * "Open number two"                 -> opens the second file from that list.
 *
 * "Open" looks in the notes first, then in Spotlight under your home folder.
 * Spotlight results skip Library, hidden folders, apps, and code folders.
 * File names are never logged (they may name patients).
 * The brain does not write to the file; you edit it yourself in that app.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { words } from "./learnings.js";

const OPEN = /^(?:hey,?\s+)?(?:please\s+)?(?:can\s?you\s+|could\s?you\s+|would\s?you\s+)?(?:please\s+)?(?:open|pull up|bring up)\s+(?:up\s+)?(?:my\s+|the\s+)?(.+?)(?:\s+(file|note|document|doc|page|word file|pdf))?(?:\s+for me)?(?:\s+please)?[?.!]*$/i;
// These "open" requests belong to email and the calendar.
const NOT_A_FILE = /\b(?:e-?mails?|mail|inbox|outlook|calendar|meetings?|messages?)\b/i;

const FIND = /^(?:hey,?\s+)?(?:please\s+)?(?:can\s?you\s+|could\s?you\s+)?(?:please\s+)?(?:find|search for|look for|locate|where is)\s+(?:my\s+|the\s+|a\s+)?(.+?)\s+(?:file\s+|document\s+)?(?:on|in)\s+(?:my\s+|the\s+)?(?:mac|computer|laptop|finder)[?.!]*$/i;
const SEARCH_FINDER = /^(?:hey,?\s+)?(?:please\s+)?(?:can\s?you\s+)?search\s+(?:my\s+|the\s+)?(?:finder|mac|computer)\s+for\s+(?:my\s+|the\s+|a\s+)?(.+?)[?.!]*$/i;
const PICK = /^(?:number\s+|the\s+)?(one|two|three|1|2|3|first|second|third)(?:\s+one)?$/i;
const PICK_INDEX = { one: 0, 1: 0, first: 0, two: 1, 2: 1, second: 1, three: 2, 3: 2, third: 2 };
const SKIP_PATH = /\/(?:Library|node_modules|\.[^/]+|[^/]+\.app|tmp|venv|site-packages)\//;
const KINDS = /\s+(?:file|document|doc|word file|pdf|presentation|spreadsheet)$/i;
// The last numbered list (files or emails), so "open number two" works for a few minutes.
let lastFound = { items: [], open: null, at: 0 };
const LIST_MS = 10 * 60 * 1000;

/** Squash a name so "to-do dot md", "To Do.md" and "todo" all compare equal. */
function compact(name) {
  return name.toLowerCase()
    .replace(/\s+dot\s+(md|pdf|docx?)\b/g, ".$1")
    .replace(/\.(md|pdf|docx?)$/, "")
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

/** Returns { name, explicit } when the question asks to open a file, else null. */
export function openFileJob(question) {
  const q = String(question || "").trim().replace(/^["“'\s.,]+|["”'\s]+$/g, "");
  const match = q.match(OPEN);
  if (!match || NOT_A_FILE.test(match[1])) return null;
  const name = match[1].trim();
  // "file", ".md", "dot md" say for sure that a file is meant.
  const explicit = Boolean(match[2]) || /(?:\.|\bdot\s+)(?:md|pdf|docx?)\b/i.test(name);
  return { name, explicit };
}

/** The full path of the note whose file name best fits what was said, or null. */
export function findFile(name, notes, roots) {
  const wanted = compact(name);
  if (!wanted) return null;
  const base = (note) => path.basename(note.rel).replace(/\.(md|pdf|docx?)$/i, "");
  let pick = notes.filter((note) => compact(base(note)) === wanted);
  if (!pick.length) {
    // Every word said must be in the file name, so "zzqx report" does not open some other report.
    const said = [...words(name.replace(/\s+dot\s+\w+$/i, ""))];
    pick = said.length ? notes.filter((note) => { const own = words(base(note)); return said.every((word) => own.has(word)); }) : [];
  }
  // Several todo.md files: prefer the one in wiki/, then the shortest path.
  pick.sort((a, b) => Number(!a.rel.startsWith("wiki/")) - Number(!b.rel.startsWith("wiki/")) || a.rel.length - b.rel.length);
  for (const note of pick) {
    for (const root of roots) {
      const full = path.join(root, note.rel);
      if (full.startsWith(path.resolve(root) + path.sep) && fs.existsSync(full)) return full;
    }
  }
  return null;
}

/** Files under the home folder whose names hold every word said, best first (up to three). */
function spotlight(name) {
  const clean = name.replace(KINDS, "").replace(/\s+dot\s+(\w+)$/i, ".$1").trim();
  const said = [...words(clean.replace(/\.\w+$/, ""))];
  // Spotlight takes one name piece; the other words are checked below.
  const longest = (clean.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).sort((a, b) => b.length - a.length)[0];
  if (!longest || !said.length) return Promise.resolve([]);
  return new Promise((resolve) => {
    execFile("/usr/bin/mdfind", ["-onlyin", os.homedir(), "-name", longest], { timeout: 10_000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      if (err) {
        console.error("Failed while searching Spotlight:", err.message);
        return resolve([]);
      }
      const wanted = compact(clean);
      const found = stdout.split("\n").filter((file) => file && !SKIP_PATH.test(file))
        .map((file) => ({ file, stat: fs.statSync(file, { throwIfNoEntry: false }) }))
        .filter(({ file, stat }) => {
          if (!stat?.isFile()) return false;
          const own = words(path.basename(file).replace(/\.\w+$/, ""));
          return said.every((word) => own.has(word));
        })
        .map((hit) => ({ ...hit, exact: compact(path.basename(hit.file)) === wanted }))
        .sort((a, b) => Number(b.exact) - Number(a.exact) || b.stat.mtimeMs - a.stat.mtimeMs);
      resolve(found.slice(0, 3).map((hit) => ({ file: hit.file, exact: hit.exact })));
    });
  });
}

function openPath(full) {
  return new Promise((resolve, reject) => {
    execFile("/usr/bin/open", [full], { timeout: 15_000 }, (err) => (err ? reject(err) : resolve()));
  });
}

/** "Grant budget, a Word file in Downloads" */
function spoken(file) {
  const ext = path.extname(file).slice(1).toLowerCase();
  const kind = { docx: "a Word file", doc: "a Word file", pdf: "a PDF", md: "a note", xlsx: "a spreadsheet", pptx: "a slide deck" }[ext] || "a file";
  return `${path.basename(file, path.extname(file))}, ${kind} in ${path.basename(path.dirname(file))}`;
}

/** Remember a numbered list; open(item) runs on "open number N" and returns the sentence to say. */
export function rememberList(items, open) {
  lastFound = { items, open, at: Date.now() };
}

function listSentence(files) {
  rememberList(files, openAndSay);
  const names = files.map((file, index) => `${index + 1}, ${spoken(file)}`).join(". ");
  return `I found ${files.length} file${files.length === 1 ? "" : "s"}. ${names}. Say open number one, two, or three.`;
}

/** "Find the grant budget on my Mac" -> { name }, else null. */
export function findOnMacJob(question) {
  const q = String(question || "").trim().replace(/^["“'\s.,]+|["”'\s]+$/g, "");
  const match = q.match(FIND) || q.match(SEARCH_FINDER);
  return match ? { name: match[1].trim() } : null;
}

export async function runFindOnMac(job) {
  const hits = await spotlight(job.name);
  console.log(`Spotlight search: ${hits.length} match(es)`);
  if (!hits.length) return `I could not find a file called ${job.name.replace(KINDS, "")} on your Mac.`;
  return listSentence(hits.map((hit) => hit.file));
}

/** Open the file in its usual app and return the sentence to say back, or null to answer normally. */
export async function runOpenFile(job, notes, roots) {
  const pick = job.name.match(PICK);
  if (pick && Date.now() - lastFound.at < LIST_MS) {
    const item = lastFound.items[PICK_INDEX[pick[1].toLowerCase()]];
    if (!item) return `The last list has only ${lastFound.items.length}.`;
    return lastFound.open(item);
  }
  const full = findFile(job.name, notes, roots);
  if (full) return openAndSay(full);
  // Not in the notes: try the whole Mac. One clear match opens; several are listed.
  const hits = await spotlight(job.name);
  console.log(`Spotlight search for open: ${hits.length} match(es)`);
  if (hits.length === 1 || hits[0]?.exact && !hits[1]?.exact) return openAndSay(hits[0].file);
  if (hits.length) return listSentence(hits.map((hit) => hit.file));
  return job.explicit ? `I could not find a file called ${job.name} in your notes or on your Mac.` : null;
}

async function openAndSay(full) {
  try {
    await openPath(full);
    return `I opened ${path.basename(full)}.`;
  } catch (err) {
    console.error("Failed while opening a file for the user:", err?.message || err);
    return `I found ${path.basename(full)} but could not open it.`;
  }
}
