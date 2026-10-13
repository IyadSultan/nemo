/**
 * "Open my todo.md file"           -> opens wiki/todo.md in its usual app on this Mac.
 * "Find the grant budget on my Mac" -> lists up to three matches from Spotlight (the Finder's search).
 * "Open number two"                 -> opens the second file from that list.
 *
 * "Open" looks in the notes first, then in Spotlight under your home folder.
 * Spotlight results skip Library, hidden folders, apps, and code folders.
 * File names are never logged (they may name patients).
 * Word files (.doc and .docx) open in LibreOffice, so you can read and edit them there.
 * The brain does not change the file itself.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { words } from "./learnings.js";

const OPEN = /^(?:hey,?\s+)?(?:please\s+)?(?:can\s?you\s+|could\s?you\s+|would\s?you\s+)?(?:please\s+)?(?:open|pull up|bring up|edit|read)\s+(?:up\s+)?(?:my\s+|the\s+)?(.+?)(?:\s+(file|note|document|doc|page|word file|pdf))?(?:\s+for me)?(?:\s+please)?[?.!]*$/i;
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
// Word files open in LibreOffice. Other files still use their usual app.
const WORD_EXT = new Set([".doc", ".docx", ".docm", ".odt", ".rtf"]);
const LIBREOFFICE = "/Applications/LibreOffice.app";

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
  // "Read the news" is a question. "Read the protocol word document" is a file.
  const reading = /^(?:hey,?\s+)?(?:please\s+)?(?:can\s?you\s+|could\s?you\s+|would\s?you\s+)?(?:please\s+)?read\b/i.test(q);
  if (reading && !/\b(?:word|docx?|dot\s+docx?)\b/i.test(q)) return null;
  // "protocol word document" means the file "protocol", not a file named "word".
  let name = match[1].trim();
  if (/\b(?:word\s+(?:documents?|docs?|files?)|docx?|dot\s+docx?)\b/i.test(q)) {
    name = name.replace(/\.(?:docx?|dot\s+docx?)\b/gi, " ").replace(/\b(?:word|documents?|docs?|files?|docx)\b/gi, " ");
  }
  name = name.replace(/\s+/g, " ").trim();
  if (!name) return null;
  // "file", ".md", "dot md" say for sure that a file is meant.
  const explicit = Boolean(match[2]) || /(?:\.|\bdot\s+)(?:md|pdf|docx?)\b/i.test(match[1]) || /\bword\b/i.test(q);
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

function isWordFile(full) {
  return WORD_EXT.has(path.extname(full).toLowerCase());
}

/** Open a file. Word files go to LibreOffice so they can be read and edited. */
function openPath(full) {
  const word = isWordFile(full);
  if (word && !fs.existsSync(LIBREOFFICE)) {
    return Promise.reject(new Error("LibreOffice is not installed."));
  }
  const args = word ? ["-a", LIBREOFFICE, full] : [full];
  return new Promise((resolve, reject) => {
    execFile("/usr/bin/open", args, { timeout: 20_000 }, (err) => (err ? reject(err) : resolve()));
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

// "Open the one we discussed" has no file name. These phrases mean the last document.
const VAGUE_NAME = /^(?:it|that|this|one|the one|that one|this one|same one|we discussed|one we discussed|document we discussed|file we discussed|the one we discussed)$/i;
// The last Word file actually opened, so "open it" still works a few minutes later.
let lastOpenedFile = { full: "", at: 0 };

function isVagueName(name) {
  return VAGUE_NAME.test(String(name || "").toLowerCase().replace(/[?.!]+$/g, "").trim());
}

/** Full path of a note, only if it sits inside one of the selected folders. */
function notePath(note, roots) {
  for (const root of roots) {
    const full = path.resolve(root, note.rel || "");
    const rootResolved = path.resolve(root);
    if ((full === rootResolved || full.startsWith(rootResolved + path.sep)) && fs.existsSync(full)) return full;
  }
  return null;
}

/**
 * Word or PDF files whose title was written out in the recent conversation.
 * An Arabic file name matches even when the user asked for it in English,
 * as long as the last answer said that Arabic name.
 */
function filesNamedInTalk(text, notes, roots) {
  const hay = compact(String(text || ""));
  if (hay.length < 8) return [];
  const found = [];
  for (const note of notes) {
    const ext = path.extname(note.rel || "").toLowerCase();
    if (!WORD_EXT.has(ext) && ext !== ".pdf") continue;
    const title = compact(note.title || path.basename(note.rel || ""));
    if (title.length < 8 || !hay.includes(title)) continue;
    const full = notePath(note, roots);
    if (full) found.push({ full, at: hay.lastIndexOf(title) });
  }
  found.sort((a, b) => b.at - a.at);
  const seen = new Set();
  return found.filter((item) => (seen.has(item.full) ? false : seen.add(item.full))).map((item) => item.full);
}

/**
 * English words such as "legal questions" will not be in an Arabic file name.
 * Meaning search still knows which Word file is about that subject.
 * Open it only when one Word file is clearly closer than the rest.
 */
async function wordFileByMeaning(name, notes, roots, findByMeaning) {
  let hits = [];
  try {
    hits = await findByMeaning(name);
  } catch (err) {
    console.error("Failed while matching a Word file by meaning:", err?.message || err);
    return null;
  }
  const ranked = [];
  const seen = new Set();
  for (const hit of hits || []) {
    const rel = hit?.note?.rel || "";
    if (!WORD_EXT.has(path.extname(rel).toLowerCase())) continue;
    const full = notePath(hit.note, roots);
    if (!full || seen.has(full)) continue;
    seen.add(full);
    ranked.push({ full, score: Number(hit.score) || 0 });
  }
  ranked.sort((a, b) => b.score - a.score);
  const first = ranked[0];
  const second = ranked[1];
  if (!first || first.score < 0.26) return null;
  const gap = second ? first.score - second.score : 1;
  // One Word file is clearly about this. A typo still counts when the gap stays wide.
  if ((first.score >= 0.3 && gap >= 0.05) || (first.score >= 0.27 && gap >= 0.06)) return { full: first.full };
  return { files: ranked.slice(0, 3).map((item) => item.full) };
}

/** The one Word file named in the recent chat, when the user's words are in that chat too. */
function discussedFile(name, text, notes, roots) {
  const named = filesNamedInTalk(text, notes, roots).filter((full) => WORD_EXT.has(path.extname(full).toLowerCase()));
  if (named.length !== 1) return null;
  const said = [...words(name)];
  if (!said.length) return null;
  const heard = words(String(text || ""));
  return said.every((word) => heard.has(word)) ? named[0] : null;
}

/** Decide which file to open. Does not open it. */
export async function planOpen(job, notes, roots, help = {}) {
  const pick = String(job.name || "").match(PICK);
  if (pick && Date.now() - lastFound.at < LIST_MS) {
    const item = lastFound.items[PICK_INDEX[pick[1].toLowerCase()]];
    if (!item) return { text: `The last list has only ${lastFound.items.length}.` };
    return { full: item };
  }
  const byName = findFile(job.name, notes, roots);
  if (byName) return { full: byName };

  const fromTalk = discussedFile(job.name, help.recentText, notes, roots);
  if (fromTalk) return { full: fromTalk };

  if (isVagueName(job.name)) {
    let named = filesNamedInTalk(help.recentText, notes, roots);
    if (/\bword\b/i.test(String(help.asked || ""))) named = named.filter((full) => WORD_EXT.has(path.extname(full).toLowerCase()));
    if (named.length === 1) return { full: named[0] };
    if (named.length > 1) return { files: named.slice(0, 3) };
    if (lastOpenedFile.full && Date.now() - lastOpenedFile.at < LIST_MS && fs.existsSync(lastOpenedFile.full)) {
      return { full: lastOpenedFile.full };
    }
    return { text: "I don't know which file you mean yet. Say open, then the name, or what the document is about." };
  }

  const asked = String(help.asked || "");
  if (/\b(?:word|docx?)\b/i.test(asked) && typeof help.findByMeaning === "function") {
    const meant = await wordFileByMeaning(job.name, notes, roots, help.findByMeaning);
    if (meant?.full) return meant;
    if (meant?.files?.length) return { files: meant.files };
  }
  return null;
}

/** Open the file in its usual app and return the sentence to say back, or null to answer normally. */
export async function runOpenFile(job, notes, roots, help = {}) {
  const planned = await planOpen(job, notes, roots, help);
  if (planned?.text) return planned.text;
  if (planned?.full) return openAndSay(planned.full);
  if (planned?.files?.length === 1) return openAndSay(planned.files[0]);
  if (planned?.files?.length) return listSentence(planned.files);

  // Not in the notes: try the whole Mac. One clear match opens; several are listed.
  const hits = await spotlight(job.name);
  console.log(`Spotlight search for open: ${hits.length} match(es)`);
  if (hits.length === 1 || hits[0]?.exact && !hits[1]?.exact) return openAndSay(hits[0].file);
  if (hits.length) return listSentence(hits.map((hit) => hit.file));
  return job.explicit ? `I could not find a file called ${job.name} in your notes or on your Mac.` : null;
}

async function openAndSay(full) {
  const word = isWordFile(full);
  try {
    await openPath(full);
    lastOpenedFile = { full, at: Date.now() };
    const spokenName = path.basename(full, path.extname(full)).replace(/[_]+/g, " ");
    if (word) return `I opened ${spokenName} in LibreOffice. You can read it and edit it there. The Word file itself is not changed until you save.`;
    return `I opened ${spokenName}.`;
  } catch (err) {
    console.error("Failed while opening a file for the user:", err?.message || err);
    if (word && !fs.existsSync(LIBREOFFICE)) {
      return `I found ${path.basename(full)}, but LibreOffice is not installed, so I could not open that Word file.`;
    }
    return `I found ${path.basename(full)} but could not open it.`;
  }
}
