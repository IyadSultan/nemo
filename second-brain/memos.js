/**
 * Memos the user asked to keep (raw/notes): save one, list recent ones, find one,
 * forget one. Also where meetings and lectures are saved, next to the memos.
 */

import { WIKI_PATH } from "./config.js";
import { closestIndex, runLearningJob } from "./learnings.js";
import { askModelOnce } from "./models.js";
import { memoStamp, numberWord, spokenDay } from "./spoken.js";
import { selected } from "./state.js";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

/** The words to keep, after "write a memo" is taken off the front. */
export function memoBody(question) {
  const original = String(question || "").trim();
  let body = original
    .replace(/^(?:please\s+)?(?:can you\s+|could you\s+|would you\s+)?/i, "")
    .replace(/^(?:save|remember|jot down|write down|take down|write|make|create|add|draft|take)\s+(?:me\s+)?(?:a\s+|an\s+|this\s+|down\s+)?(?:memo|note)\s*/i, "")
    .replace(/^(?:that|about|regarding|saying|to say|:|-)\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
  // The question mark belongs to "can you write a memo?", not to the memo.
  if (/^(?:please\s+|can you\s+|could you\s+|would you\s+)/i.test(original)) {
    body = body.replace(/\?+$/, "").trim();
  }
  return body;
}

/** The raw/notes folder inside the chosen second-brain vault. */
export function memoFolder() {
  for (const root of selected) {
    const rawDir = path.join(root, "raw");
    try {
      fsSync.accessSync(rawDir);
      return path.join(rawDir, "notes");
    } catch {
      // This chosen folder has no raw mail folder.
    }
  }
  const root = selected[0] || path.dirname(WIKI_PATH);
  return path.join(root, "raw", "notes");
}

/** Rewrite a memo so it is clearer, without adding new facts. */
export async function clarifyMemo(model, text, apiKey) {
  const instruction = [
    "Rewrite this memo as one complete sentence.",
    "Keep every fact and every name exactly as given. Do not invent a person.",
    "If the words are a fragment, add only the small words needed to make a sentence.",
    "For example, 'my meeting tomorrow with nobody' becomes 'I have a meeting tomorrow with nobody.'",
    "No title, no date, no bullet list, no question mark unless the memo itself is a question.",
  ].join(" ");
  const fallback = text;
  try {
    const raw = await askModelOnce(model, instruction, `Memo:\n${text}`, apiKey, 200);
    let clear = raw.replace(/\s+/g, " ").trim();
    clear = clear.replace(/^["']|["']$/g, "").trim();
    if (clear.length < 2) return fallback;
    return clear.slice(0, 2000);
  } catch (err) {
    console.error("Failed while rewriting a memo:", err?.message || err);
    return fallback;
  }
}

/** Write one memo file. The file name starts with the date so it sorts by time. */
export async function saveMemoFile(clear) {
  const folder = memoFolder();
  await fs.mkdir(folder, { recursive: true });
  const slug = clear.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "memo";
  const name = `${memoStamp()}-${slug}.md`;
  // The date is the start of the file name. The file itself is only the memo.
  await fs.writeFile(path.join(folder, name), `${clear}\n`, "utf8");
  return name;
}

/** Drop an old "Saved Saturday, 3 October 2026" line if a file still has one. */
export function memoTextOnly(text) {
  return String(text || "")
    .replace(/^Saved\s+[A-Za-z]+,\s+\d{1,2}\s+[A-Za-z]+\s+\d{4}\s*/i, "")
    .trim();
}

/** Read memo files. Recent means the saved date is inside the past 14 days. */
export async function loadMemos(job) {
  const folder = memoFolder();
  let names = [];
  try {
    names = await fs.readdir(folder);
  } catch {
    return [];
  }
  const cutoff = new Date();
  cutoff.setHours(0, 0, 0, 0);
  cutoff.setDate(cutoff.getDate() - 14);
  const memos = [];
  for (const name of names) {
    if (!/\.md$/i.test(name) || name.startsWith(".")) continue;
    const match = name.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!match) continue;
    const saved = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    if (job === "recent" && saved < cutoff) continue;
    const full = path.join(folder, name);
    try {
      const text = memoTextOnly(await fs.readFile(full, "utf8"));
      if (!text) continue;
      memos.push({
        name,
        saved: saved.getTime(),
        text: `Date: ${spokenDay(saved)}\n${text}`,
      });
    } catch (err) {
      console.error(`Failed while reading a memo: ${full}`);
      console.error(err?.message || err);
    }
  }
  memos.sort((a, b) => b.name.localeCompare(a.name));
  return memos;
}

export function memoCountWords(count) {
  if (count === 1) return "one memo";
  const word = count < 60 ? numberWord(count) : "many";
  return `${word} memos`;
}

/** Turn saved memo files into notes the answer can read. */
/**
 * Learnings and memos are both "memories" to the user.
 * List shows both; forget removes the closest learning, else the closest memo.
 * A forgotten memo moves to a .deleted folder next to the memos, so it can be brought back.
 */
export async function runMemoryJob(job) {
  const said = runLearningJob(job);
  if (job.kind === "add" || (job.kind === "forget" && said)) return said;
  const memos = await loadMemos("all");
  if (job.kind === "list") {
    const latest = memos.slice(0, 5).map((memo) => memo.text.split("\n").slice(1).join(" ").trim().replace(/[.]?$/, "."));
    const memoPart = memos.length
      ? `You have ${memos.length} saved memo${memos.length === 1 ? "" : "s"}. The newest: ${latest.join(" ")}`
      : "You have no saved memos.";
    return [said || "I have not learned any rules yet.", memoPart].join(" ");
  }
  const best = closestIndex(job.text, memos.map((memo) => memo.text));
  if (best < 0) return "I could not find that among your memos or the things I learned.";
  const memo = memos[best];
  const folder = memoFolder();
  await fs.mkdir(path.join(folder, ".deleted"), { recursive: true });
  await fs.rename(path.join(folder, memo.name), path.join(folder, ".deleted", memo.name));
  return `Done. I deleted the memo: ${memo.text.split("\n").slice(1).join(" ").trim()}`;
}

export async function memosForPrompt(job) {
  const memos = await loadMemos(job === "find" ? "all" : job);
  const hits = memos.slice(0, job === "recent" ? 20 : 40).map((memo) => ({
    note: {
      rel: `raw/notes/${memo.name}`,
      title: "Memo",
      text: memo.text,
      lower: memo.text.toLowerCase(),
    },
    terms: [],
  }));
  const count = memos.length;
  hits.memoJob = job;
  if (job === "find") {
    hits.sayThis = "";
    return hits;
  }
  hits.sayThis = count
    ? job === "all"
      ? `You have ${memoCountWords(count)} saved.`
      : `You have ${memoCountWords(count)} from the past two weeks.`
    : job === "all"
      ? "You have no memos saved."
      : "You have no memos from the past two weeks.";
  return hits;
}

/** Save one memo, then the sentence the voice should say. */
export async function spokenSavedMemo(question, model, apiKey) {
  const raw = memoBody(question);
  if (raw.length < 2) {
    return "I did not catch the memo. Say save a memo, then the words you want kept.";
  }
  const clear = await clarifyMemo(model, raw, apiKey);
  const name = await saveMemoFile(clear);
  console.log(`Saved memo ${name}`);
  return `I saved that memo. ${clear}`;
}

/** Saved minutes go to raw/meetings, next to raw/notes. */
export function meetingFolder() {
  return path.join(path.dirname(memoFolder()), "meetings");
}

/** Saved lecture notes go to raw/lectures, next to raw/meetings. */
export function lectureFolder() {
  return path.join(path.dirname(memoFolder()), "lectures");
}
