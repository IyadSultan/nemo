/**
 * brain.md: the brain's long-term memory, one section per day.
 *
 * During the day, every voice question and answer goes into daylog/YYYY-MM-DD.md.
 * Each night the day's calls, meeting minutes, memos, and Claude Code work
 * (the dated entries in the orchestration wiki) are summarized into ~/.brain/brain.md.
 * The newest part of brain.md goes into every answer's prompt.
 *
 * ~/.brain/memories.md is separate: those are rules the user says out loud.
 */

import { AGENTS_FILE, BRAIN_FILE } from "./config.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export { BRAIN_FILE };
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

/**
 * Notes from one day. Older files are named 2026-10-15-….
 * A meeting or lecture is a folder named 20261015_title, with summary.md inside.
 */
function filesOfDay(folder, day) {
  let names = [];
  try {
    names = fs.readdirSync(folder);
  } catch {
    return "";
  }
  const compact = day.replace(/-/g, "");
  const parts = [];
  for (const name of names.sort()) {
    const full = path.join(folder, name);
    if (name.startsWith(day) && name.endsWith(".md")) {
      parts.push(`### ${name}\n${readText(full).trim()}`);
      continue;
    }
    let info;
    try {
      info = fs.statSync(full);
    } catch {
      continue;
    }
    if (!info.isDirectory() || !name.startsWith(`${compact}_`)) continue;
    const inside = fs.readdirSync(full).filter((item) => item.endsWith(".md")).sort();
    inside.sort((a, b) => Number(a === "summary.md") - Number(b === "summary.md"));
    for (const item of inside) {
      parts.push(`### ${name}/${item}\n${readText(path.join(full, item)).trim()}`);
    }
  }
  return parts.join("\n\n");
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
    ["Agent visits", agentsOfDay(day)],
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

const CONVERSATION_INSTRUCTION = [
  "You keep the long-term memory of Dr Iyad Sultan's second brain.",
  "Below is one conversation between him and his second brain, just before he cleared it.",
  "Write what is worth remembering from it, as short Markdown bullets under these headings, skipping any heading with nothing under it:",
  "### People, ### Work and projects, ### Decisions, ### Preferences, ### Open items.",
  "Only write facts that are in the text. Leave out greetings, small talk, tests, and requests that failed.",
  "At most 15 bullets. Each bullet is one sentence.",
  "Never write a medical record number, a national number, or a patient's name. Say 'a patient' instead.",
  "Do not add a title or a date. Start with the first heading.",
].join("\n");

/**
 * "Clear and save": summarize one conversation into brain.md, under its own heading
 * ("## 2026-10-15 — conversation at 18:48") so the nightly "## 2026-10-15" section is still written.
 * ask(instruction, text) calls the model. Returns the heading.
 */
export async function saveConversation(text, ask, when = new Date()) {
  const summary = String(await ask(CONVERSATION_INSTRUCTION, text)).trim();
  if (summary.length < 20) throw new Error("The model returned no summary.");
  const clock = `${String(when.getHours()).padStart(2, "0")}:${String(when.getMinutes()).padStart(2, "0")}`;
  const heading = `${dayKey(when)} — conversation at ${clock}`;
  fs.mkdirSync(path.dirname(BRAIN_FILE), { recursive: true });
  if (!fs.existsSync(BRAIN_FILE)) {
    fs.writeFileSync(BRAIN_FILE, "# Brain\n\nWhat the second brain learned, one section per day. Written each night.\n", "utf8");
  }
  fs.appendFileSync(BRAIN_FILE, `\n## ${heading}\n\n${summary}\n`, "utf8");
  return heading;
}

/**
 * brain.md as notes, one per "## " section, so days older than the prompt window
 * can still be found by keyword and meaning search like any wiki page.
 */
export function brainNotes() {
  const notes = [];
  for (const part of readText(BRAIN_FILE).split(/\n(?=## )/)) {
    const match = part.match(/^## (.+)\n([\s\S]*)$/);
    if (!match) continue;
    const heading = match[1].trim();
    const body = match[2].trim();
    if (!heading || !body) continue;
    const title = `Memory from ${heading}`;
    const text = `${title}\n${body}`;
    notes.push({ rel: `brain.md#${heading}`, title, text, lower: text.toLowerCase() });
  }
  return notes;
}

/** True when this brain.md section is already inside brainBlock(), so a search hit would repeat it. */
export function inBrainBlock(rel, block) {
  if (!rel.startsWith("brain.md#")) return false;
  return block.includes(`\n## ${rel.slice("brain.md#".length)}\n`);
}

/** Today's agent visits in agents.md, for the nightly memory. */
function agentsOfDay(day) {
  const text = readText(AGENTS_FILE);
  if (!text) return "";
  const parts = [];
  for (const block of text.split(/\n(?=## )/)) {
    if (block.startsWith(`## ${day}`)) parts.push(block.trim());
  }
  return parts.join("\n\n");
}

/** The newest agent visits, so "who worked today" can be answered from the prompt. */
export function agentsBlock() {
  let text = readText(AGENTS_FILE);
  if (!text.includes("\n## ")) return "";
  const cap = 3500;
  if (text.length > cap) {
    const tail = text.slice(-cap);
    const start = tail.indexOf("\n## ");
    text = start >= 0 ? tail.slice(start) : tail;
  } else {
    text = text.slice(text.indexOf("\n## "));
  }
  return `Claude sessions on this Mac, from agents.md (newest last). When the user asks who was working, what an agent did, or when something was finished, answer from this log:\n${text.trim()}`;
}

const TODAY_CHARS = 4000;
// A call starts with "## 14:05". An answer may have its own "## Heading", so the time is part of the test.
const CALL_START = /\n(?=## \d{2}:\d{2}\n)/;

/** Days whose calls are not in brain.md yet: yesterday until that night's summary is written, then today. */
function pendingDays(now) {
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  return [...(hasDay(dayKey(yesterday)) ? [] : [dayKey(yesterday)]), dayKey(now)];
}

function dayLog(key) {
  return readText(path.join(DAYLOG_DIR, `${key}.md`)).trim();
}

/** The newest calls of one day, cut at a call boundary. */
function recentLog(key, max) {
  const text = dayLog(key);
  if (text.length <= max) return text;
  const tail = text.slice(-max);
  const start = tail.search(CALL_START);
  return (start >= 0 ? tail.slice(start) : tail).trim();
}

/**
 * Newest calls that are not in the nightly memory yet.
 * Today, and yesterday until that night's summary is written.
 * Each part names its day, so inTodayBlock() can tell the two apart.
 */
export function todayBlock(now = new Date()) {
  const keys = pendingDays(now);
  const today = keys[keys.length - 1];
  return keys.map((key) => {
    const text = recentLog(key, TODAY_CHARS);
    if (!text) return "";
    const label = key === today
      ? `Today so far (${key}), from the call log. This is not in the nightly memory yet. Use it when the user asks what they asked today, or what you said today:`
      : `Yesterday (${key}), not in the nightly memory yet:`;
    return `${label}\n${text}`;
  }).filter(Boolean).join("\n\n");
}

/** True when this call is already inside todayBlock(), so a search hit would repeat it. */
export function inTodayBlock(rel, block) {
  const match = String(rel).match(/^daylog\/(\d{4}-\d{2}-\d{2})\.md#(\d{2}:\d{2})$/);
  if (!match) return false;
  const start = block.indexOf(`(${match[1]})`);
  if (start < 0) return false;
  const end = block.indexOf("\n\nToday so far (", start + 1);
  return block.slice(start, end < 0 ? undefined : end).includes(`\n## ${match[2]}\n`);
}

/**
 * One searchable note per call. Today, plus yesterday if that night's
 * summary is not in brain.md yet.
 */
export function dayLogNotes(now = new Date()) {
  const notes = [];
  for (const key of pendingDays(now)) {
    for (const part of dayLog(key).split(CALL_START)) {
      const match = part.match(/^## (\d{2}:\d{2})\n([\s\S]*)$/);
      const body = match?.[2].trim();
      if (!body) continue;
      const title = `Call at ${key} ${match[1]}`;
      const full = `${title}\n${body}`;
      notes.push({ rel: `daylog/${key}.md#${match[1]}`, title, text: full, lower: full.toLowerCase() });
    }
  }
  return notes;
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
