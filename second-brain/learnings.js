/**
 * Learnings: short facts and preferences the user asks the brain to keep.
 *
 * "Learn that Dr Khaled leads the AML protocol"   -> adds a line
 * "From now on, keep answers under three sentences" -> adds a line
 * "Forget that Dr Khaled leads the AML protocol"   -> removes the closest line
 * "What have you learned about me?"                -> lists them
 *
 * They live in learnings.md next to this file (git-ignored, one "- " line each)
 * and go into every answer's prompt, so they last across calls.
 * Chat memory, by contrast, is cleared when a call ends.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "learnings.md");
// Enough for a page of preferences without crowding out the notes.
const MAX_LINES = 40;
const MAX_CHARS = 3000;

const ADD = /^(?:please\s+)?(?:(?:learn|keep in mind|bear in mind)\s+(?:that\s+)?|from now on,?\s+)(.+)$/i;
const FORGET = /^(?:please\s+)?(?:forget|unlearn|stop remembering)\s+(?:that\s+|about\s+)?(.+)$/i;
const LIST = /\b(?:what (?:have you|did you) (?:learn(?:ed|t)|remember(?:ed)?)|what do you (?:know about me|remember)|what (?:are|is) (?:your|my) memor(?:y|ies)|(?:list|read|show)(?: me)? (?:your|my|the) (?:learnings|memories))\b/i;
// "Remember: do not be lazy" is a rule for the brain, not a memo. Memos are facts ("remember that Sara owes me slides").
const RULE = /^(?:please\s+)?remember[:,]?\s+(?:that\s+|to\s+)?((?:do not|don't|never|always|call me|i prefer|i like|i want|you should|answer|keep|be|use|speak|reply)\b.+)$/i;

export function learningJob(question) {
  const q = String(question || "").trim().replace(/[.!]+$/, "");
  if (LIST.test(q)) return { kind: "list" };
  const forget = q.match(FORGET);
  if (forget) return { kind: "forget", text: forget[1].trim() };
  const add = q.match(ADD) || q.match(RULE);
  if (add) return { kind: "add", text: add[1].trim() };
  return null;
}

function readLines() {
  try {
    return fs.readFileSync(FILE, "utf8").split("\n")
      .filter((line) => line.startsWith("- "))
      .map((line) => line.slice(2).trim());
  } catch (err) {
    if (err.code !== "ENOENT") console.error("Failed while reading learnings.md:", err.message);
    return [];
  }
}

function writeLines(lines) {
  const body = lines.map((line) => `- ${line}`).join("\n");
  fs.writeFileSync(FILE, `# Learnings\n\nThings the user asked the second brain to keep in mind.\n\n${body}\n`, "utf8");
}

// Words that say what to forget, not which one.
const FILLER = new Set(["the", "a", "an", "my", "that", "this", "about", "memo", "memos", "note", "learning", "rule", "one", "thing", "on", "of", "to"]);

/** Content words, cut to 4 letters so "laziness" meets "lazy" and "meetings" meets "meeting". */
export function words(text) {
  const all = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  return new Set(all.filter((w) => !FILLER.has(w)).map((w) => w.slice(0, w.length > 4 ? 4 : w.length).replace(/y$/, "i")));
}

/** Index of the text that shares the most words with what was said, or -1 when none shares half. */
export function closestIndex(said, texts) {
  const wanted = words(said);
  let best = -1;
  let bestShare = 0;
  texts.forEach((text, index) => {
    const own = words(text);
    const share = [...wanted].filter((word) => own.has(word)).length / Math.max(wanted.size, 1);
    if (share > bestShare) [best, bestShare] = [index, share];
  });
  return bestShare >= 0.5 ? best : -1;
}

/** Do what the request asks and return the sentence to say back. */
export function runLearningJob(job) {
  const lines = readLines();
  if (job.kind === "list") {
    if (!lines.length) return "";
    return `I keep ${lines.length} thing${lines.length === 1 ? "" : "s"} in mind. ${lines.map((line) => line.replace(/[.]?$/, ".")).join(" ")}`;
  }
  const text = job.text.charAt(0).toUpperCase() + job.text.slice(1);
  if (job.kind === "add") {
    writeLines([...lines.filter((line) => line.toLowerCase() !== text.toLowerCase()), text]);
    return `Got it. I will keep in mind: ${text}`;
  }
  // Forget the line that shares the most words with what was said.
  const best = closestIndex(text, lines);
  if (best < 0) return null;
  const removed = lines[best];
  writeLines(lines.filter((_, index) => index !== best));
  return `Done. I forgot: ${removed}`;
}

/** The prompt block, newest first, within the size limits. */
export function learningsBlock() {
  const kept = [];
  let size = 0;
  for (const line of readLines().reverse().slice(0, MAX_LINES)) {
    size += line.length;
    if (size > MAX_CHARS) break;
    kept.push(`- ${line}`);
  }
  return kept.length ? `Things the user asked you to always keep in mind:\n${kept.join("\n")}` : "";
}
