/**
 * brain.md: the brain's long-term memory, one section per day.
 *
 * During the day, every voice question and answer goes into daylog/YYYY-MM-DD.md.
 * Each night the day's calls, meeting minutes, memos, and Claude Code work
 * (the dated entries in the orchestration wiki) are summarized into ~/.claude/brain.md.
 * The newest part of brain.md goes into every answer's prompt.
 *
 * learnings.md is separate: those are rules the user says out loud.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const BRAIN_FILE = path.join(os.homedir(), ".claude", "brain.md");
const DAYLOG_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "daylog");
const WIKI_AGENTS = path.join(os.homedir(), ".claude", "orchestration", "wiki", "agents");
// How much of brain.md goes into a prompt: the newest days, about two weeks.
const PROMPT_CHARS = 6000;
// How much of each source the nightly summary reads.
const SOURCE_CHARS = 15000;

export function dayKey(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Keep one question and its answer in today's call log. */
export function appendDayLog(question, answer) {
  const asked = String(question || "").trim();
  const said = String(answer || "").trim();
  if (!asked || !said) return;
  const now = new Date();
  const clock = now.toTimeString().slice(0, 5);
  try {
    fs.mkdirSync(DAYLOG_DIR, { recursive: true });
    fs.appendFileSync(
      path.join(DAYLOG_DIR, `${dayKey(now)}.md`),
      `## ${clock}\nQ: ${asked.slice(0, 2000)}\nA: ${said.slice(0, 4000)}\n\n`,
      "utf8",
    );
  } catch (err) {
    console.error("Failed while writing the day log:", err.message);
  }
}

function readText(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

/** Files in a folder whose names start with the day, such as 2026-10-15-0930-budget.md. */
function filesOfDay(folder, day) {
  let names = [];
  try {
    names = fs.readdirSync(folder);
  } catch {
    return "";
  }
  return names
    .filter((name) => name.startsWith(day) && name.endsWith(".md"))
    .sort()
    .map((name) => `### ${name}\n${readText(path.join(folder, name)).trim()}`)
    .join("\n\n");
}

/** Wiki entries headed with the day ("### 2026-10-15 ..."), from every agent page. */
function wikiOfDay(day) {
  let names = [];
  try {
    names = fs.readdirSync(WIKI_AGENTS);
  } catch {
    return "";
  }
  const parts = [];
  for (const name of names.filter((n) => n.endsWith(".md")).sort()) {
    const lines = readText(path.join(WIKI_AGENTS, name)).split("\n");
    let keep = false;
    const kept = [];
    for (const line of lines) {
      if (/^#{1,3} /.test(line)) keep = line.startsWith(`### ${day}`);
      if (keep) kept.push(line);
    }
    if (kept.length) parts.push(`## Agent ${name.replace(/\.md$/, "")}\n${kept.join("\n").trim()}`);
  }
  return parts.join("\n\n");
}

/** Everything that happened on one day, by source. Empty sources are left out. */
export function gatherDay(day, { meetingDir, notesDir, lectureDir }) {
  const sources = [
    ["Voice calls", readText(path.join(DAYLOG_DIR, `${day}.md`))],
    ["Meeting minutes", filesOfDay(meetingDir, day)],
    ["Lectures", lectureDir ? filesOfDay(lectureDir, day) : ""],
    ["Memos", filesOfDay(notesDir, day)],
    ["Claude Code sessions", wikiOfDay(day)],
  ];
  return sources
    .filter(([, text]) => text.trim())
    .map(([label, text]) => `# ${label}\n${text.trim().slice(-SOURCE_CHARS)}`)
    .join("\n\n");
}

export function hasDay(day) {
  return readText(BRAIN_FILE).includes(`\n## ${day}\n`);
}

const SUMMARY_INSTRUCTION = [
  "You keep the long-term memory of Dr Iyad Sultan's second brain.",
  "Below is everything from one day: voice calls, meeting minutes, lectures, memos, and what his Claude Code agents did.",
  "Write what is worth remembering from this day, as short Markdown bullets under these headings, skipping any heading with nothing under it:",
  "### People, ### Work and projects, ### Decisions, ### Preferences, ### Open items.",
  "Only write facts that are in the text. Leave out greetings, small talk, tests, and requests that failed.",
  "At most 25 bullets. Each bullet is one sentence.",
  "Never write a medical record number, a national number, or a patient's name. Say 'a patient' instead.",
  "Do not add a title or a date. Start with the first heading.",
].join("\n");

/**
 * Summarize one day into brain.md. ask(instruction, text) calls the model.
 * Returns "saved", "exists", or "empty".
 */
export async function summarizeDay(day, folders, ask) {
  if (hasDay(day)) return "exists";
  const text = gatherDay(day, folders);
  if (!text) return "empty";
  const summary = String(await ask(SUMMARY_INSTRUCTION, `Day: ${day}\n\n${text}`)).trim();
  if (summary.length < 20) throw new Error("The model returned no summary.");
  fs.mkdirSync(path.dirname(BRAIN_FILE), { recursive: true });
  if (!fs.existsSync(BRAIN_FILE)) {
    fs.writeFileSync(BRAIN_FILE, "# Brain\n\nWhat the second brain learned, one section per day. Written each night.\n", "utf8");
  }
  fs.appendFileSync(BRAIN_FILE, `\n## ${day}\n\n${summary}\n`, "utf8");
  return "saved";
}

/** The newest days of brain.md, for the prompt. */
export function brainBlock() {
  let text = readText(BRAIN_FILE);
  if (!text.includes("\n## ")) return "";
  if (text.length > PROMPT_CHARS) {
    const tail = text.slice(-PROMPT_CHARS);
    const start = tail.indexOf("\n## ");
    text = start >= 0 ? tail.slice(start) : tail;
  } else {
    text = text.slice(text.indexOf("\n## "));
  }
  return `What you learned on past days, from brain.md (newest last). Use it when the user asks about earlier days, people, or work:\n${text.trim()}`;
}
