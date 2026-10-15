/**
 * Second brain — ask your wiki, get a short answer fast.
 *
 * What this file does, in plain words:
 * 1. On startup it reads the markdown notes in your OneDrive wiki.
 *    The notes stay in OneDrive. Nothing is copied into this git repo.
 * 2. When you ask a question, it searches those notes on your Mac
 *    and keeps only the few pages that match.
 * 3. It sends just those pages to the GPT-6 model you picked and
 *    streams the answer back to the browser.
 * 4. When OpenAI reports how many tokens it used, this server
 *    multiplies those tokens by that model's price.
 *
 * The default is GPT-OSS 20B on this Mac with thinking off: free and fast.
 * You can switch model and reasoning on the page. A higher reasoning
 * level does not change the price per token. It spends more thinking
 * tokens, and those are billed at the output price.
 */

import dotenv from "dotenv";
import express from "express";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { MODELS, VOICE_MODELS, REASONING_LEVELS, getModel, getAnyModel, priceForUsage } from "./pricing.js";
import { createSemanticIndex } from "./embed.js";
import { judgeSpeech, warmJudge } from "./jev.js";
import { cleanMedical, warmMedgem } from "./medgem.js";
import { learningJob, runLearningJob, learningsBlock, closestIndex, siteShortcut } from "./learnings.js";
import { appendDayLog, brainBlock, dayKey, saveConversation, summarizeDay } from "./brain.js";
import { loadDocs } from "./docs.js";
import { ingestDocument } from "./upload.js";
import { openFileJob, runOpenFile, findOnMacJob, runFindOnMac } from "./openfile.js";
import { emailSearchJob, runEmailSearch } from "./emailsearch.js";
import { registerIMessage, sendIMessage, imessageHandle, textMeJob, runTextMe } from "./imessage.js";
import * as desk from "./desk.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// One .env at the repo root holds the OpenAI key for Nemo and this app.
dotenv.config({ path: path.join(__dirname, "..", ".env") });

const DEFAULT_MODEL = "claude-opus";
const DEFAULT_REASONING = "low";
// Chat memory is compressed by a local Ollama model, whatever model answers.
const MEMORY_MODEL = "gpt-oss:20b";
// Same live voice model as Nemo (voice control). It hears the microphone.
const VOICE_MODEL = "gpt-realtime-2.1-mini";
const LOCAL_VOICE_MODEL = path.join(__dirname, "..", "voice", "models", "ggml-small.en.bin");
const WHISPER_BIN = "/opt/homebrew/bin/whisper-cli";
// Keeps the voice model loaded, so each clip skips the model load (about 0.4s down to 0.1s).
// Whisper small.en beat Parakeet v2 on note names and acronyms on this Mac (17% vs 23% word errors).
const WHISPER_SERVER_BIN = "/opt/homebrew/bin/whisper-server";
const WHISPER_SERVER_URL = "http://127.0.0.1:8178/inference";
// Optional: hears English and Arabic and detects which one. Started only when first used.
const MULTI_VOICE_MODEL = path.join(__dirname, "..", "voice", "models", "ggml-large-v3-turbo-q5_0.bin");
const WHISPER_MULTI_URL = "http://127.0.0.1:8180/inference";
// A second copy of the big model, locked to Arabic, so English and Arabic can listen at once.
const WHISPER_AR_URL = "http://127.0.0.1:8182/inference";
let multiWhisperUp = null;
let arabicWhisperUp = null;
// Kokoro: the same local voice the claude-voice app uses. Local models speak with it.
const KOKORO_PYTHON = "/usr/local/bin/python3.11";
const KOKORO_SCRIPT = path.join(__dirname, "..", "voice", "kokoro_server.py");
const KOKORO_URL = "http://127.0.0.1:8179";
const FFMPEG_BIN = "/opt/homebrew/bin/ffmpeg";
// Ollama runs local models on this Mac. Bonsai is already installed there.
const OLLAMA_URL = process.env.OLLAMA_URL || "http://127.0.0.1:11434";
let loadedLocalId = "";
// Meaning search runs next to keyword search. Small local model; ~20 ms per question.
const EMBED_MODEL = "embeddinggemma";
const semantic = createSemanticIndex({
  ollamaUrl: OLLAMA_URL,
  model: EMBED_MODEL,
  cacheFile: path.join(__dirname, "tmp", "embeddings.json"),
});
const DEFAULT_VOICE = "marin";
const PORT = Number(process.env.BRAIN_PORT) || 3001;

// Higher reasoning needs room for hidden thinking tokens.
// Those tokens count toward this cap and toward the bill.
const OUTPUT_CAP = {
  none: 700,
  low: 2000,
  medium: 4000,
  high: 8000,
  xhigh: 12000,
  max: 16000,
};
// Local replies are spoken aloud, so they stay short. A few sentences, then stop.
const LOCAL_REPLY_CAP = {
  none: 120,
  low: 160,
  medium: 220,
  high: 280,
};
// Ollama counts hidden thinking toward num_predict. Bonsai thinks ~800 tokens
// even for "can you hear me", so without this room the reply came back empty.
const LOCAL_THINK_ROOM = {
  none: 0,
  low: 1500,
  medium: 3000,
  high: 6000,
};
const WIKI_PATH =
  process.env.WIKI_PATH ||
  "/Users/USER/Library/CloudStorage/OneDrive-KingHusseinCancerCenter/2nd_brain/wiki";
const FOLDERS_FILE = path.join(__dirname, "folders.json");

// Folders that are not real wiki pages (email-subject lists, Obsidian internals).
const SKIP_DIRS = new Set([".obsidian", "_batches", "_batches2"]);

// Words that show up in almost every question and should not drive the search.
const STOP_WORDS = new Set([
  "the", "and", "for", "with", "what", "who", "how", "why", "when", "where",
  "are", "was", "were", "you", "your", "my", "about", "from", "that", "this",
  "have", "has", "had", "does", "did", "can", "could", "would", "should",
  "tell", "please", "into", "onto", "than", "then", "them", "they", "their",
  "which", "whose", "will", "just", "know", "need", "want", "give", "show",
]);

const app = express();
app.use(express.json({ limit: "15mb" }));
app.use(express.text({ type: ["application/sdp", "text/plain"], limit: "1mb" }));
// deny: hidden files (the session log under public/.claude) are not sent to the browser.
app.use(express.static(path.join(__dirname, "public"), { dotfiles: "deny" }));
// Rive runtime for the Tiny mascot (served from node_modules, no CDN).
app.use("/vendor/rive", express.static(path.join(__dirname, "..", "node_modules", "@rive-app", "canvas"), { dotfiles: "deny" }));

/** @type {{ rel: string, title: string, text: string, lower: string }[]} */
let notes = [];
let folders = [WIKI_PATH];
let selected = [WIKI_PATH];
/** @type {Map<string, string>} code.md text for folders currently in use */
let guides = new Map();
/** @type {Map<string, boolean>} */
let codePresent = new Map();

/**
 * Read every .md file under the wiki into memory once.
 * Searching memory is much faster than opening files on every question.
 */
async function loadWiki(root) {
  const found = [];

  async function walk(dir) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      console.error(`Failed while listing folder: ${dir}`);
      console.error(err?.message || err);
      return;
    }

    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        await walk(full);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;

      try {
        const raw = await fs.readFile(full, "utf8");
        const rel = path.relative(root, full);
        found.push(parseNote(rel, raw));
      } catch (err) {
        console.error(`Failed while reading note: ${full}`);
        console.error(err?.message || err);
      }
    }
  }

  await walk(root);
  return found;
}

/** Pull a title out of the note's top block, or fall back to the file name. */
function parseNote(rel, raw) {
  let title = path.basename(rel, ".md").replace(/-/g, " ");
  let body = raw;

  if (raw.startsWith("---")) {
    const end = raw.indexOf("\n---", 3);
    if (end !== -1) {
      const front = raw.slice(3, end);
      const match = front.match(/^title:\s*["']?(.+?)["']?\s*$/m);
      if (match) title = match[1].trim();
      body = raw.slice(end + 4).trim();
    }
  }

  const text = `${title}\n${body}`;
  return { rel, title, text, lower: text.toLowerCase() };
}

/** Turn a question into the words we should look for. */
function queryTerms(question) {
  const words = (question.toLowerCase().match(/[a-z0-9]{3,}/g) || []).filter(
    (word) => !STOP_WORDS.has(word)
  );
  return words.length ? words : question.toLowerCase().match(/[a-z0-9]{3,}/g) || [];
}

/**
 * Keyword ranking plus meaning ranking, merged by rank (reciprocal rank fusion).
 * A note found by meaning alone gets its closest piece as the excerpt,
 * because the keyword excerpt would have nothing to center on.
 */
async function searchNotes(question, limit = 4) {
  const terms = queryTerms(question);
  const keyword = keywordNotes(terms);
  const meaning = await semantic.search(question, 20);
  const fused = new Map();
  keyword.forEach((hit, rank) => {
    fused.set(hit.note, { note: hit.note, terms, score: 1 / (60 + rank) });
  });
  meaning.forEach((found, rank) => {
    const hit = fused.get(found.note) || { note: found.note, terms, score: 0, override: found.text };
    hit.score += 1 / (60 + rank);
    fused.set(found.note, hit);
  });
  const top = [...fused.values()].sort((a, b) => b.score - a.score).slice(0, limit);
  console.log(
    `Note search: ${keyword.length} by keyword, ${meaning.length} by meaning; ` +
      `sent ${top.length}, ${top.filter((hit) => hit.override).length} found by meaning only`
  );
  return top;
}

/**
 * Score notes by how often the question words appear.
 * A hit in the title counts more than a hit buried in the page.
 */
function keywordNotes(terms) {
  if (!terms.length) return [];

  const ranked = [];
  for (const note of notes) {
    let score = 0;
    const title = note.title.toLowerCase();
    const file = note.rel.toLowerCase();
    for (const term of terms) {
      if (title.includes(term)) score += 12;
      if (file.includes(term)) score += 8;
      let at = 0;
      let hits = 0;
      while (hits < 12 && (at = note.lower.indexOf(term, at)) !== -1) {
        hits += 1;
        at += term.length;
      }
      score += hits;
    }
    if (score > 0) ranked.push({ note, score, terms });
  }

  ranked.sort((a, b) => b.score - a.score);
  return ranked.slice(0, 20);
}

/** Keep a window of text around the first matching word, so we don't send the whole note. */
function excerpt(text, terms, maxLen = 900) {
  const lower = text.toLowerCase();
  let at = -1;
  for (const term of terms) {
    at = lower.indexOf(term);
    if (at !== -1) break;
  }
  const start = Math.max(0, (at === -1 ? 0 : at) - 240);
  let slice = text.slice(start, start + maxLen).trim();
  if (start > 0) slice = `…${slice}`;
  if (start + maxLen < text.length) slice = `${slice}…`;
  return slice;
}

function buildPrompt(question, hits, pages = [], history = [], memory = "", meetingNotes = "", notesKind = "") {
  const blocks = hits.map((hit) => {
    const { note, terms } = hit;
    return [
      `Note: ${note.title}`,
      `File: ${note.rel}`,
      hit.override || noteBody(note, terms),
    ].join("\n");
  });

  const webBlocks = pages.map((page) => {
    return [`Page: ${page.title}`, `Address: ${page.url}`, page.text].join("\n");
  });

  const memoNote = hits.memoJob === "find"
    ? "The user is asking whether one particular memo was saved. Look only at the memos below. If one is about that subject, say yes, say its date, then say the memo in one clear sentence. If none match, say that memo was not saved. Do not invent one. Do not mention a file name."
    : hits.memoJob === "recent" || hits.memoJob === "all"
      ? `These are the user's own memos. The first sentence must be: ${hits.sayThis || "You have no memos."} Then say each memo in clearer words, one short sentence each, newest first. Say the date that is on the Date line, in those words. Do not say the word Saved. Do not add facts that are not there. Do not mention a file name. If there are no memos below, stop after that first sentence.`
      : "";
  const newsNote = wantsNews(question)
    ? "The user wants today's news. Summarize three or four headlines from the web pages in plain sentences. Do not ask which topic."
    : "";
  const vaultNote = wantsFile(question)
    ? "The user asked to find a file. The notes start with lines from wiki/index.md and passages from wiki/log.md. He calls wiki/log.md logs dot md. Use those lines to name the page. If they do not mention the file, say you looked in the index and in the log and did not find it."
    : wantsEmail(question)
    ? hits.emailJob === "read"
      ? `Read this one email aloud. The first sentence must be: ${hits.sayThis || "I could not find that email."} Then say what the message itself asks, in a few short sentences. The arrival time is only the one in that first sentence. Do not mention other files or how many files are in the folder.`
      : hits.emailJob === "reply"
        ? replyDraftNote(hits.outlook)
        : hits.emailJob === "send"
          ? sendDraftNote(hits.outlook)
          : hits.emailJob === "review"
          ? "The user wants to know which emails need an urgent reply. Look at every email below. Name only the ones that need a reply soon, and say why in one short sentence. If none do, say that none of today's emails need an urgent reply. Do not write the reply. Do not list every email. Do not say a date, a clock time, or a file size."
          : hits.emailJob === "list"
          ? `The first sentence must be: ${hits.sayThis || "You have no new emails today."} Then summarize every email below, in order, one short sentence each. Say what it is about. Do not skip one. Do not read the subject from start to finish. Do not say a date, a clock time, or a file size.`
          : `This question is about how many emails arrived. The first sentence must be: ${hits.sayThis || "The raw folder has no email files."} Then summarize two or three of the newest emails, one short sentence each. Say what each one is about. Do not read the subject from start to finish. Do not say a date, a clock time, or a file size. Do not call the whole-folder number today's mail.`
    : isVaultQuestion(question)
      ? "This question is about the user's own second brain. Answer from the notes, especially wiki/todo.md for tasks. Do not use the web. Do not say a listed file is missing if its text is below."
      : "";

  const earlier = history.length
    ? history.map((turn, index) => {
        const label = index === history.length - 1 ? "Last question" : `Earlier question ${index + 1}`;
        return `${label}: ${turn.question}\nAnswer: ${turn.answer}`;
      }).join("\n\n")
    : "(this is the first question in this chat)";
  const chatNote = history.length
    ? "If the user asks what they asked last time, what you just said, or a follow-up, answer from Earlier in this conversation. Do not say that is missing from the notes."
    : "";

  const memoryBlock = memory
    ? `Compressed memory of older turns:\n${memory}`
    : "";
  const talk = notesKind === "lecture";
  const meetingBlock = meetingNotes
    ? talk
      ? [
          "A talk written down in this call, in the order it was heard:",
          meetingNotes,
          "If the user asks about that talk or lecture, answer from those lines. Do not say the talk is missing from the notes. Do not invent people, numbers, or claims that are not written there.",
        ].join("\n")
      : [
          "Meeting written down in this call, in the order it was heard:",
          meetingNotes,
          "If the user asks about that meeting, answer from those lines. Do not say the meeting is missing from the notes. Do not invent people, numbers, or decisions that are not written there. Do not turn a question about this meeting into a new calendar event.",
        ].join("\n")
    : "";

  return [
    // here_and_now already ran. The model must copy these words, not invent a clock time.
    `Here and now: ${hereAndNow()}`,
    learningsBlock(),
    brainBlock(),
    memoryBlock,
    meetingBlock,
    "Earlier in this conversation:",
    earlier,
    "",
    `Question: ${question}`,
    "",
    "Notes:",
    blocks.length ? blocks.join("\n\n---\n\n") : "(no notes matched the words in this question)",
    "",
    "Web pages:",
    webBlocks.length ? webBlocks.join("\n\n---\n\n") : "(no web pages were looked up)",
    "",
    // A messy sentence can still be a real question. Only stop when there is no topic at all.
    "Reminder: if you can tell what the user wants, answer it, even if the wording is clumsy.",
    "Ask one short clarifying question only when there is no topic, for example a noise or 'can you hear me'.",
    newsNote,
    memoNote,
    vaultNote,
    chatNote,
  ].filter(Boolean).join("\n");
}

/** Questions about this chat, not the wiki or the web. */
function isChatQuestion(question) {
  const q = question.toLowerCase();
  return /\b(last time|previous|just asked|did i ask|i ask you|i said|you said|you tell|you told|earlier|a moment ago|before that|repeat that|say that again|what did i)\b/.test(q);
}

/** Keep only recent, short turns. The page sends these with the next question. */
function cleanHistory(raw) {
  if (!Array.isArray(raw)) return [];
  const turns = [];
  for (const item of raw) {
    const question = typeof item?.question === "string" ? item.question.trim().slice(0, 500) : "";
    const answer = typeof item?.answer === "string" ? item.answer.trim().slice(0, 1500) : "";
    if (!question) continue;
    turns.push({ question, answer: answer || "(no answer yet)" });
  }
  return turns.slice(-6);
}

function cleanMemory(raw) {
  return typeof raw === "string" ? raw.trim().slice(0, 2000) : "";
}

/** Recent questions and answers, so "open the one we discussed" can find that file. */
function fileTalk(history) {
  const saved = desk.savedChat();
  const bits = [saved.summary];
  for (const turn of saved.turns || []) bits.push(turn.question, turn.answer);
  for (const turn of history || []) bits.push(turn.question, turn.answer);
  return bits.filter(Boolean).join("\n");
}
/** @type {{ rel: string, title: string, full: string, mtime: number, words: string[] }[]} */
let rawMail = [];

const EMAIL_JOB_SKIP = new Set([
  "last", "night", "read", "reads", "reading", "reply", "replies", "respond",
  "draft", "this", "that", "message", "messages", "write", "back", "send",
  "open", "contents", "body", "please",
]);

const EMAIL_FILLER = new Set([
  "new", "today", "latest", "recent", "mail", "email", "emails", "inbox",
  "any", "got", "get", "did", "from", "sent", "receive", "received",
  "yesterday", "last", "check", "folder", "file", "files", "raw",
]);

function oneEditApart(a, b) {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i += 1;
      j += 1;
      continue;
    }
    edits += 1;
    if (edits > 1) return false;
    if (a.length === b.length) {
      i += 1;
      j += 1;
    } else if (a.length > b.length) i += 1;
    else j += 1;
  }
  if (i < a.length || j < b.length) edits += 1;
  return edits <= 1;
}

function nameMatchesFile(term, words) {
  return words.some((word) => {
    if (word === term) return true;
    // "asim" can mean "asem". A longer word like "qasim" is a different name.
    return term.length >= 4 && word.length === term.length && oneEditApart(term, word);
  });
}

async function indexRawMail() {
  const found = [];

  async function walk(dir, root) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      console.error(`Failed while listing raw mail: ${dir}`);
      console.error(err?.message || err);
      return;
    }
    for (const entry of entries) {
      // Skip hidden folders and cleaned copies such as raw/_clean.
      if (entry.name.startsWith(".") || entry.name.startsWith("_")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // Memos, minutes, and lecture notes live beside the mail. They are not emails.
        if ((entry.name === "notes" || entry.name === "meetings" || entry.name === "lectures") && path.basename(dir) === "raw") continue;
        await walk(full, root);
        continue;
      }
      if (!entry.isFile() || !/\.(txt|md)$/i.test(entry.name)) continue;
      try {
        const stat = await fs.stat(full);
        found.push({
          rel: path.relative(root, full).replaceAll("\\", "/"),
          title: entry.name.replace(/\.(txt|md)$/i, ""),
          full,
          mtime: stat.mtimeMs,
          size: stat.size,
          lowerName: entry.name.toLowerCase(),
          words: entry.name.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length >= 4),
        });
      } catch (err) {
        console.error(`Failed while indexing a raw email: ${full}`);
        console.error(err?.message || err);
      }
    }
  }

  for (const root of selected) {
    const rawDir = path.join(root, "raw");
    try {
      await fs.access(rawDir);
    } catch {
      continue;
    }
    await walk(rawDir, root);
  }

  rawMail = found;
  console.log(`Indexed ${rawMail.length} files in raw/`);
}

function startOfDayMs(dayOffset = 0) {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() + dayOffset);
  return start.getTime();
}

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const MONTH_SHORT = {
  jan: "January", feb: "February", mar: "March", apr: "April",
  jun: "June", jul: "July", aug: "August", sep: "September", sept: "September",
  oct: "October", nov: "November", dec: "December",
};
const SMALL_WORDS = [
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
  "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen",
  "seventeen", "eighteen", "nineteen",
];
const DAY_WORDS = [
  "", "first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth",
  "tenth", "eleventh", "twelfth", "thirteenth", "fourteenth", "fifteenth", "sixteenth",
  "seventeenth", "eighteenth", "nineteenth", "twentieth", "twenty-first", "twenty-second",
  "twenty-third", "twenty-fourth", "twenty-fifth", "twenty-sixth", "twenty-seventh",
  "twenty-eighth", "twenty-ninth", "thirtieth", "thirty-first",
];

function numberWord(n) {
  if (n < 20) return SMALL_WORDS[n];
  const ten = Math.floor(n / 10);
  const one = n % 10;
  const tens = ["", "", "twenty", "thirty", "forty", "fifty"];
  return one ? `${tens[ten]}-${SMALL_WORDS[one]}` : tens[ten];
}

function spokenYear(year) {
  if (year >= 2000 && year < 2100) {
    const rest = year - 2000;
    if (rest === 0) return "two thousand";
    if (rest < 10) return `two thousand ${numberWord(rest)}`;
    return `twenty ${numberWord(rest)}`;
  }
  return String(year);
}

/** A clock time in words, so the voice does not read 21:11 as a code. */
function spokenClock(date) {
  const hour24 = date.getHours();
  const minute = date.getMinutes();
  let part = "in the morning";
  if (hour24 >= 12 && hour24 < 17) part = "in the afternoon";
  else if (hour24 >= 17 && hour24 < 22) part = "in the evening";
  else if (hour24 >= 22 || hour24 < 5) part = "at night";
  let hour = hour24 % 12;
  if (hour === 0) hour = 12;
  if (minute === 0) return `${numberWord(hour)} o'clock ${part}`;
  if (minute < 10) return `${numberWord(hour)} oh ${numberWord(minute)} ${part}`;
  return `${numberWord(hour)} ${numberWord(minute)} ${part}`;
}

/** A date in words. "Oct" is avoided because the voice reads it as "act". */
function spokenDay(date) {
  return `the ${DAY_WORDS[date.getDate()]} of ${MONTH_NAMES[date.getMonth()]}, ${spokenYear(date.getFullYear())}`;
}

function spokenWhen(mtime) {
  const date = new Date(mtime);
  return `${spokenDay(date)}, at ${spokenClock(date)}`;
}

function speakTitle(title) {
  return String(title || "")
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/[_]+/g, " ")
    .replace(/\b(jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\b\.?/gi, (match) => {
      const key = match.toLowerCase().replace(/\.$/, "");
      return MONTH_SHORT[key] || match;
    })
    .replace(/(\d{1,2})\s*[-–]\s*(\d{1,2})/g, "$1 to $2")
    .replace(/\s+/g, " ")
    .trim();
}

function savedLabel(mtime) {
  return spokenWhen(mtime);
}

function dayLabel(mtime) {
  return spokenDay(new Date(mtime));
}

function sizeLabel(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} bytes`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} kilobytes`;
  return `${(n / (1024 * 1024)).toFixed(1)} megabytes`;
}

/** Counts come from the saved time of each file in raw/, not from the model. */
function mailFacts() {
  const todayStart = startOfDayMs(0);
  const yesterdayStart = startOfDayMs(-1);
  let today = 0;
  let yesterday = 0;
  let newest = null;
  for (const file of rawMail) {
    if (file.mtime >= todayStart) today += 1;
    else if (file.mtime >= yesterdayStart && file.mtime < todayStart) yesterday += 1;
    if (!newest || file.mtime > newest.mtime) newest = file;
  }
  return { today, yesterday, total: rawMail.length, newest, todayStart, yesterdayStart };
}

/**
 * today and "new" mean files saved since midnight.
 * The whole folder is a different number and must not be called today.
 */
function emailWindow(question) {
  const q = question.toLowerCase();
  if (/\blast night\b/.test(q)) return "night";
  if (/\byesterday\b/.test(q)) return "yesterday";
  if (/\b(today|tonight|new|latest|recent)\b/.test(q)) return "today";
  if (/\blast\b/.test(q) && !/\blast\s+(week|month|year|few|couple)\b/.test(q)) return "last";
  return "all";
}

/**
 * A new email, not a reply to one already saved.
 * "Send an email to Haitham" counts. "Reply to this email" does not.
 */
function isComposeEmail(question) {
  const q = question.toLowerCase();
  if (/\b(reply|replies|respond|write\s+back)\b/.test(q)) return false;
  if (/\b(?:this|that|the same)\s+(?:e-?mail|message)\b/.test(q)) return false;
  if (/\b(?:did you|have you|did i)\b/.test(q)) return false;
  if (/\b(?:send|forward)\s+(?:me\s+)?(?:the|that|this)\s+/.test(q)) return false;
  return /\b(?:send|compose|write|draft)\b.{0,40}\b(?:e-?mail|message|letter)\b/.test(q);
}

/** Read one message, draft a reply, write a new email, review the pile, list every email, or just count them. */
function emailJob(question) {
  const q = question.toLowerCase();
  const writingReply = /\b(draft|write)\b/.test(q) || /\b(reply|respond)\s+to\b/.test(q);
  const reviewing = /\b(review|urgent|urgency|important)\b/.test(q)
    || /\bneed(?:s)?\b.{0,30}\brepl(?:y|ies)\b/.test(q)
    || /\bshould\b.{0,30}\brepl(?:y|ies)\b/.test(q);
  // "Send an important email" is still a new email, not a review of the inbox.
  if (isComposeEmail(question)) return "send";
  if (reviewing && !writingReply) return "review";
  if (/\b(reply|replies|respond|draft)\b/.test(q)) return "reply";
  if (/\b(read|reads|reading|open|contents|body)\b/.test(q)) return "read";
  if (/\b(list|all|every|each)\b/.test(q)) return "list";
  return "count";
}

function nightRange() {
  const now = new Date();
  const start = new Date(now);
  const end = new Date(now);
  if (now.getHours() < 18) {
    start.setDate(start.getDate() - 1);
    start.setHours(18, 0, 0, 0);
    end.setHours(5, 0, 0, 0);
    if (now.getHours() >= 5) end.setTime(now.getTime());
  } else {
    start.setHours(18, 0, 0, 0);
    end.setTime(now.getTime());
  }
  return [start.getTime(), end.getTime()];
}

/** The email named in the last answer, when the user says "this email". */
function fileMentionedInHistory(history) {
  const blob = (history || [])
    .slice(-2)
    .map((turn) => `${turn.question || ""} ${turn.answer || ""}`)
    .join(" ")
    .toLowerCase();
  if (!blob.trim()) return null;
  const titled = rawMail.filter((file) => {
    const title = speakTitle(file.title).toLowerCase();
    return title.length >= 12 && blob.includes(title);
  });
  if (titled.length) return titled.sort((a, b) => b.mtime - a.mtime)[0];
  return null;
}
/** A person's name only counts after the word "from", such as "from Asim Mansour". */
function emailNames(question) {
  const match = question.toLowerCase().match(/\bfrom\s+([a-z][a-z'’-]+(?:\s+[a-z][a-z'’-]+){0,2})/);
  if (!match) return [];
  const words = match[1].split(/\s+/);
  // "from today" is a time, not a person. Stop before the name search begins.
  if (EMAIL_FILLER.has(words[0]) || EMAIL_JOB_SKIP.has(words[0])) return [];
  return words.filter((word) => !EMAIL_FILLER.has(word) && !EMAIL_JOB_SKIP.has(word) && word.length >= 4);
}

function plainEmailText(raw) {
  let text = String(raw || "");
  text = text.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ");
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<\/(p|div|tr|li|h[1-6]|table)>/gi, "\n");
  text = text.replace(/<[^>]+>/g, " ");
  text = text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, " and ")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, " ");
  text = text.replace(/&#\d+;/g, " ").replace(/&[a-z]+;/gi, " ");
  return text
    .split(/\n+/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line && !/[{}]/.test(line))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

async function readRawExcerpt(file, maxLen = 700, brief = false) {
  const raw = await fs.readFile(file.full, "utf8");
  const body = plainEmailText(raw).slice(0, maxLen);
  // A list should be a short summary. The subject is for the model, not for reading aloud.
  const text = brief
    ? `Use this only to write a short summary. Do not read it aloud. Subject: ${speakTitle(file.title)}. Message: ${body}`
    : `Saved ${savedLabel(file.mtime)}. Subject: ${speakTitle(file.title)}. Message: ${body}`;
  return {
    note: { rel: file.rel, title: brief ? "Email" : speakTitle(file.title), text, lower: text.toLowerCase() },
    terms: [],
  };
}

/** The user's own address, and robots, are not who a reply should go to. */
function isOwnAddress(address) {
  const lower = String(address || "").toLowerCase();
  return lower === "isultan@khcc.jo" || lower.startsWith("donotreply@");
}

/**
 * The filename is the subject, with underscores where spaces were.
 * "Re_ Colony Count" becomes "Re: Colony Count".
 */
function replySubject(title) {
  let subject = String(title || "")
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/_+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  subject = subject.replace(/^(re|fw|fwd)\s+/i, "");
  if (!subject) subject = "your email";
  return `Re: ${subject}`;
}

/** "Haitham Aryan" becomes "Haitham". A title such as Dr is skipped. */
function firstName(full) {
  const words = String(full || "").trim().split(/\s+/);
  for (const raw of words) {
    const word = raw.replace(/[,.]+$/, "");
    if (!/^[A-Za-z][A-Za-z'’-]+$/.test(word)) continue;
    if (/^(dear|dr|doctor|mr|mrs|ms|from|to)$/i.test(word)) continue;
    return word.charAt(0).toUpperCase() + word.slice(1);
  }
  return "";
}

/**
 * How the written reply should look.
 * The voice still hears only the short part before EMAIL_BODY.
 */
function replyDraftNote(outlook) {
  const first = firstName(outlook?.name);
  const greet = first
    ? `The greeting must be Dear ${first}.`
    : "Greet the person who sent the email by their first name. If the message has no name, write Dear colleague.";
  return [
    "Draft a reply to this one email.",
    "First write two or three plain spoken sentences. The voice reads only those.",
    "Tell them to say send it to open the reply in Outlook, or don't to drop it.",
    "Then write one line that is exactly EMAIL_BODY.",
    "After that line write the email the user will send.",
    greet,
    "Leave a blank line after the greeting, a blank line before Best regards, and a blank line before IS.",
    "End the greeting with a comma. End Best regards with a comma. End each sentence with a period.",
    "Do not write brackets. Do not write Sender Name or Your Name.",
    "Do not paste the original message. The app adds it under the reply.",
    "Do not copy Get Outlook for Mac or any phone signature.",
    "The email may use line breaks. The voice must not read it.",
    "Do not ask what they want to say. Do not mention files or other emails.",
  ].join(" ");
}

/**
 * How a brand-new email should look.
 * Same shape as a reply: a short spoken part, then EMAIL_BODY, then the letter.
 * There is no saved message to quote underneath.
 */
function sendDraftNote(outlook) {
  const first = firstName(outlook?.name);
  const greet = first
    ? `The greeting must be Dear ${first}.`
    : "If a person is named, greet them by their first name. If not, write Dear colleague.";
  const who = outlook?.name
    ? `This email is for ${outlook.name}.`
    : "The user did not name who it is for. Still write the letter.";
  return [
    "Draft a new email. This is not a reply to a saved message.",
    who,
    "First write two or three plain spoken sentences. The voice reads only those.",
    "Say that a draft is ready. Tell them to say send it to open it in Outlook, or don't to drop it.",
    "Then write one line that is exactly EMAIL_BODY.",
    "After that line write the email the user will send.",
    "Use what the user asked to say. Do not ask what they want to say.",
    "Do not add facts they did not say. Do not say a file is attached.",
    greet,
    "Do not write a subject line. The app already set the subject.",
    "Leave a blank line after the greeting, a blank line before Best regards, and a blank line before IS.",
    "End the greeting with a comma. End Best regards with a comma. End each sentence with a period.",
    "Do not write brackets. Do not write Sender Name or Your Name.",
    "Do not paste another message. Do not mention files or other emails.",
    "The email may use line breaks. The voice must not read it.",
  ].join(" ");
}

/** "haitham aryan" becomes "Haitham Aryan". Words like "about" end the name. */
function composeRecipient(question) {
  // "Dr. Haitham" is the same name as "Dr Haitham".
  const cleaned = question.replace(/\b(dr|doctor|mr|mrs|ms)\./gi, "$1");
  const to = cleaned.match(/\b(?:to|for)\s+([a-z][a-z'’-]+(?:\s+[a-z][a-z'’-]+){0,2})/i);
  const named = cleaned.match(/\b(?:send|e-?mail)\s+([a-z][a-z'’-]+(?:\s+[a-z][a-z'’-]+){0,2})(?=\s+(?:an?\s+)?(?:e-?mail|message|about|saying|that)\b)/i);
  const raw = (to || named)?.[1] || "";
  const stop = new Set([
    "about", "regarding", "saying", "that", "with", "and", "the", "a", "an",
    "me", "him", "her", "them", "please", "today", "tomorrow", "this", "my",
  ]);
  const titles = new Set(["dr", "doctor", "mr", "mrs", "ms"]);
  const kept = [];
  for (const word of raw.split(/\s+/)) {
    if (!word || stop.has(word.toLowerCase())) break;
    if (titles.has(word.toLowerCase().replace(/[,.]+$/, ""))) continue;
    kept.push(word.charAt(0).toUpperCase() + word.slice(1));
  }
  return kept.join(" ");
}

/** The topic after "about" or "saying", used as the Outlook subject. */
function composeSubject(question) {
  const match = question.match(/\b(?:about|regarding|subject|saying|to say|that)\s+(.+)/i);
  if (!match) return "Note";
  let subject = match[1]
    .replace(/^(?:says\s+)/i, "")
    .replace(/\b(?:saying|and say|tell(?:ing)? (?:him|her|them))\b[\s\S]*$/i, "")
    .replace(/[.?!]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!subject) return "Note";
  subject = subject.charAt(0).toUpperCase() + subject.slice(1);
  if (subject.length > 80) subject = `${subject.slice(0, 77).replace(/\s+\S*$/, "")}…`;
  return subject || "Note";
}

/**
 * Find this person's address in a saved email, when the name is in the file.
 * If none is found, Outlook still opens and the user can type the address.
 */
async function addressForName(fullName) {
  const words = String(fullName || "")
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word.length >= 3 && !/^(dr|doctor|mr|mrs|ms)$/.test(word));
  if (!words.length) return null;
  const ranked = rawMail
    .map((file) => ({
      file,
      score: words.filter((term) => nameMatchesFile(term, file.words)).length,
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || b.file.mtime - a.file.mtime)
    .slice(0, 8)
    .map((item) => item.file);
  const files = ranked.length
    ? ranked
    : [...rawMail].sort((a, b) => b.mtime - a.mtime).slice(0, 20);
  for (const file of files) {
    try {
      const head = (await fs.readFile(file.full, "utf8")).slice(0, 12000);
      if (!words.some((word) => head.toLowerCase().includes(word))) continue;
      const people = peopleInMail(head);
      const match = people.find((person) => {
        if (isOwnAddress(person.address)) return false;
        const name = person.name.toLowerCase();
        return words.every((word) => name.includes(word));
      });
      if (match) return match;
    } catch (err) {
      console.error(`Failed while looking up an address in: ${file.full}`);
      console.error(err?.message || err);
    }
  }
  return null;
}

/** A new email: who it is for, the subject, and an empty quote. */
async function composeEmailHits(question) {
  const spokenName = composeRecipient(question);
  const typed = question.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  const person = typed ? null : await addressForName(spokenName);
  const hits = [];
  hits.emailJob = "send";
  hits.sayThis = "";
  hits.outlook = {
    to: cleanMailAddress(typed?.[0] || "") || person?.address || "",
    name: person?.name || spokenName,
    subject: composeSubject(question),
    original: "",
  };
  return hits;
}

/**
 * Turn a sloppy model draft into the letter that should open in Outlook.
 * [Sender Name] becomes the person's first name. [Your Name] becomes IS.
 */
/** The saved message as plain lines, so a reply can quote it. */
function emailLines(raw) {
  let text = String(raw || "");
  text = text.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ");
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<\/(p|div|tr|li|h[1-6]|table)>/gi, "\n");
  text = text.replace(/<[^>]+>/g, " ");
  text = text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"');
  text = text.replace(/&#\d+;/g, " ").replace(/&[a-z]+;/gi, " ");
  return text
    .split(/\n+/)
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter((line) => line && !/[{}]/.test(line) && !/^Get Outlook for /i.test(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** From, subject, and the message, placed under the new reply. */
function quotedOriginal(raw, person, title) {
  const body = emailLines(raw).slice(0, 5000);
  const who = [person?.name, person?.address ? `<${person.address}>` : ""].filter(Boolean).join(" ");
  const subject = String(title || "")
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/_+/g, " ")
    .replace(/^(re|fw|fwd)\s+/i, "")
    .replace(/\s+/g, " ")
    .trim();
  const header = [
    who ? `From: ${who}` : "",
    subject ? `Subject: ${subject}` : "",
  ].filter(Boolean).join("\n");
  return [header, body].filter(Boolean).join("\n\n");
}

/** The new letter, then a line, then the email being answered. */
function replyWithOriginal(body, original) {
  const quote = String(original || "").trim().slice(0, 6000);
  if (!quote) return body;
  const start = quote.slice(0, 80);
  if (start && body.includes(start)) return body;
  return `${body}\n\n________________________________\n\n${quote}`;
}

/**
 * Turn a flat draft into a short letter.
 * "Dear Anwar / We have to meet tomorrow. / Best regards / IS"
 * becomes a greeting, a blank line, the message, a blank line, then the sign-off.
 */
function polishReply(body, fullName) {
  const first = firstName(fullName);
  let text = String(body || "")
    .replace(/[ \t]*Get Outlook for (?:Mac|iOS|Android|Windows)[^\n]*/gi, "")
    .replace(/\[(?:Sender|Recipient)\s*Name\]/gi, first || "colleague")
    .replace(/\[Your Name\]/gi, "IS");
  if (first) {
    text = text.replace(/^(\s*Dear\s+)(?:colleague|friend|there)\b/i, `$1${first}`);
  }
  text = text.replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n").trim();

  // Words that start the message, so they are not treated as part of the name.
  const sentenceStart = new Set([
    "i", "we", "the", "please", "this", "it", "thank", "thanks", "can", "could",
    "would", "let", "just", "also", "there", "here", "my", "our", "your", "as",
    "if", "when", "after", "before", "a", "an", "so", "and", "but",
  ]);

  let sign = "";
  const signMatch = text.match(/^([\s\S]*?)\s*\bbest regards\b[,.]?\s*(?:\n+\s*)?(?:IS)?\s*$/i);
  if (signMatch) {
    text = signMatch[1].trim();
    sign = "Best regards,\n\nIS";
  }

  let greet = "";
  const dear = text.match(/^dear\s+([\s\S]+)$/i);
  if (dear) {
    const rest = dear[1].trim();
    const withComma = rest.match(/^([^,\n]{1,80}),\s*([\s\S]*)$/);
    const withLine = rest.match(/^([^\n]{1,80})\n+([\s\S]*)$/);
    if (withComma) {
      greet = `Dear ${withComma[1].trim()},`;
      text = withComma[2].trim();
    } else if (withLine && withLine[1].trim().split(/\s+/).length <= 4) {
      greet = `Dear ${withLine[1].replace(/[,.]$/, "").trim()},`;
      text = withLine[2].trim();
    } else {
      const words = rest.split(/\s+/);
      const name = [];
      for (const word of words) {
        const bare = word.replace(/[,.]$/, "");
        if (name.length && sentenceStart.has(bare.toLowerCase())) break;
        if (name.length >= 3) break;
        if (name.length && !/^[A-Z]/.test(bare)) break;
        name.push(bare);
        if (/[,.]$/.test(word)) break;
      }
      greet = `Dear ${name.join(" ")},`;
      text = words.slice(name.length).join(" ").replace(/^[,.\s]+/, "");
    }
  }

  const message = text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => (/[.!?]$/.test(line) ? line : `${line}.`))
    .map((line, index) => (index === 0 ? line.charAt(0).toUpperCase() + line.slice(1) : line))
    .join("\n\n");

  return [greet, message, sign].filter(Boolean).join("\n\n");
}

function plainMail(raw) {
  return String(raw || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ");
}

/**
 * Every "Name <email>" in the saved message, marked from or to.
 * One To line can list several people. All of them count.
 */
function peopleInMail(text) {
  const people = [];
  const pattern = /([A-Za-z][A-Za-z'’. -]{0,60}?)\s*<\s*([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})\s*>/gi;
  let match;
  while ((match = pattern.exec(text))) {
    const before = text.slice(Math.max(0, match.index - 180), match.index).toLowerCase();
    const fromAt = before.lastIndexOf("from:");
    const toAt = Math.max(before.lastIndexOf("to:"), before.lastIndexOf("cc:"));
    let role = "";
    if (fromAt >= 0 || toAt >= 0) role = fromAt > toAt ? "from" : "to";
    people.push({
      role,
      name: match[1].replace(/\s+/g, " ").replace(/^[\s;:,]+|[\s;:,]+$/g, "").trim(),
      address: match[2],
    });
  }
  return people;
}

/**
 * Who this reply goes to.
 * If someone else sent the message, use their address.
 * If the first From line is the user, he is quoted inside a reply,
 * so use the person he greeted, such as Dear Haitham.
 */
function replyAddress(raw) {
  const text = plainMail(raw);
  const people = peopleInMail(text);
  const firstFrom = people.find((person) => person.role === "from");
  if (firstFrom && !isOwnAddress(firstFrom.address)) return firstFrom;

  const seen = new Set();
  const humans = [];
  for (const person of people) {
    if (person.role !== "to" || isOwnAddress(person.address)) continue;
    const key = person.address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    humans.push(person);
  }

  const dearPattern = /\bDear\s+(?:Dr\.?\s+|Mr\.?\s+|Ms\.?\s+)?([A-Za-z][A-Za-z'’-]+)/gi;
  let dear;
  while ((dear = dearPattern.exec(text))) {
    const wanted = dear[1].toLowerCase();
    if (wanted === "iyad") continue;
    const match = humans.find((person) => firstName(person.name).toLowerCase() === wanted);
    if (match) return match;
  }
  return humans[0] || null;
}

function mailSentence(facts, when) {
  if (!facts.total || !facts.newest) return "The raw folder has no email files.";
  if (when === "yesterday") return `You got ${facts.yesterday} emails yesterday.`;
  if (when === "last") return "Here are the latest emails.";
  if (when === "today") return `You have ${facts.today} new emails today.`;
  return `The raw folder has ${facts.total} files in all. ${facts.today} were saved today.`;
}

/** Email questions look at raw/, where each saved message is a text file. */
async function findRawEmails(question, history = []) {
  // The file list is built when the server starts. Mail keeps arriving after that,
  // so look at the folder again before counting "new" emails.
  await indexRawMail();
  // A new email is a draft, not a search of the inbox.
  if (emailJob(question) === "send") return composeEmailHits(question);
  const names = emailNames(question);
  const subjects = queryTerms(question).filter(
    (term) => !EMAIL_FILLER.has(term) && !EMAIL_JOB_SKIP.has(term) && term.length >= 4
  );
  let job = emailJob(question);
  // "List all emails" with no day means today's mail, not the whole archive.
  let when = emailWindow(question);
  if ((job === "list" || job === "review") && when === "all") when = "today";
  // Any question about today's mail gets every file, not a sample of three.
  if (job === "count" && when === "today") job = "list";
  const facts = mailFacts();
  const todayStart = facts.todayStart;
  let pool = rawMail;

  if (when === "night") {
    const [start, end] = nightRange();
    pool = rawMail.filter((file) => file.mtime >= start && file.mtime < end);
  } else if (when === "today") {
    pool = rawMail.filter((file) => file.mtime >= todayStart);
  } else if (when === "yesterday") {
    pool = rawMail.filter((file) => file.mtime >= facts.yesterdayStart && file.mtime < todayStart);
  }

  const lookFor = names.length ? names : subjects;
  let chosen = [];
  if (lookFor.length && (names.length || job === "read" || job === "reply")) {
    const ranked = pool
      .map((file) => ({
        file,
        score: lookFor.filter((term) => nameMatchesFile(term, file.words)).length,
      }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || b.file.mtime - a.file.mtime);
    const top = ranked[0]?.score || 0;
    chosen = ranked.filter((item) => item.score === top).map((item) => item.file);
    if (names.length && top > 0 && top < names.length) {
      chosen = chosen.filter((file) => {
        const shortName = names.some((term) => term.length <= 5 && nameMatchesFile(term, file.words));
        return shortName && /(^|[^a-z])dr([^a-z]|$)/.test(file.lowerName);
      });
    }
    if (!chosen.length && job !== "count") {
      const anywhere = rawMail
        .map((file) => ({
          file,
          score: lookFor.filter((term) => nameMatchesFile(term, file.words)).length,
        }))
        .filter((item) => item.score > 0)
        .sort((a, b) => b.score - a.score || b.file.mtime - a.file.mtime);
      chosen = anywhere.filter((item) => item.score === anywhere[0]?.score).map((item) => item.file);
    }
  } else {
    chosen = [...pool].sort((a, b) => b.mtime - a.mtime);
  }

  const pointsBack = /\b(this|that|same)\b/i.test(question);
  const oneMessage = job === "read" || job === "reply";
  if (oneMessage && (pointsBack || (job === "reply" && !subjects.length && !names.length))) {
    const earlier = fileMentionedInHistory(history);
    if (earlier) chosen = [earlier];
  }
  const listing = job === "list" || job === "count" || job === "review";
  const limit = oneMessage ? 1 : job === "list" || job === "review" ? Math.min(chosen.length, 40) : 3;
  const picks = chosen.slice(0, limit);
  const hits = [];
  if (job === "count") {
    hits.push({
      note: {
        rel: "raw/",
        title: "Email count",
        text: `Saved today: ${facts.today}. The emails below are examples. Summarize them. Do not say dates or file sizes.`,
        lower: "",
      },
      terms: [],
    });
  } else if (job === "list") {
    hits.push({
      note: {
        rel: "raw/",
        title: "Email count",
        text: `These are all ${picks.length} emails in this list, newest first. Summarize every one. Do not say dates or file sizes.`,
        lower: "",
      },
      terms: [],
    });
  } else if (job === "review") {
    hits.push({
      note: {
        rel: "raw/",
        title: "Email count",
        text: `These are all ${picks.length} emails from this period, newest first. Decide which ones need an urgent reply. Do not write a reply.`,
        lower: "",
      },
      terms: [],
    });
  }
  for (const file of picks) {
    try {
      const excerptLen = oneMessage ? 2200 : job === "review" ? 500 : 280;
      hits.push(await readRawExcerpt(file, excerptLen, listing && !oneMessage));
    } catch (err) {
      console.error(`Failed while reading a raw email: ${file.full}`);
      console.error(err?.message || err);
    }
  }
  hits.rawCount = chosen.length;
  hits.rawWhen = when;
  hits.emailJob = job;
  const opened = picks[0];
  if (job === "reply" && opened) {
    // Subject comes from the file name. The address is filled in only when the file has one.
    let person = null;
    let raw = "";
    try {
      raw = await fs.readFile(opened.full, "utf8");
      person = replyAddress(raw.slice(0, 30000));
    } catch (err) {
      console.error(`Failed while reading the reply address: ${opened.full}`);
      console.error(err?.message || err);
    }
    hits.outlook = {
      to: person?.address || "",
      name: person?.name || "",
      subject: replySubject(opened.title),
      original: quotedOriginal(raw, person, opened.title),
    };
  }
  if (oneMessage && opened) {
    const arrived = `saved ${savedLabel(opened.mtime)}`;
    hits.sayThis = job === "read"
      ? `This email is ${speakTitle(opened.title)}, ${arrived}.`
      : "";
  } else if (job === "review") {
    hits.sayThis = "";
  } else if (!oneMessage) {
    hits.sayThis = mailSentence(facts, when);
  } else {
    hits.sayThis = "I could not find that email in the raw folder.";
  }
  return hits;
}

function isVaultQuestion(question) {
  const q = question.toLowerCase();
  if (wantsFile(question)) return true;
  return /\b(todos?|to-dos?|to do|todoist|to-?doist|tasks?|plate|have to do|index|logs?|history|wikis?|finished|second brain|e-?mails?|inbox|raw folder)\b/.test(q);
}

/**
 * True when the user is asking where a file is.
 * "Find the ketamine paper" counts. "What is on my to-do list" does not.
 */
function wantsFile(question) {
  const q = String(question || "").toLowerCase();
  const ask = /\b(find|locate|look(?:ing)? for|search for|where(?:'s| is)|which file)\b/.test(q);
  const noun = /\b(files?|documents?|papers?|pdfs?|docx|xlsx|spreadsheets?|notes?|reports?|decks?|slides?|pages?)\b/.test(q);
  return ask && noun;
}

// Words that mean "go look", not the name of the file. They are ignored inside the index and the log.
const FILE_SEARCH_NOISE = new Set([
  "find", "file", "files", "document", "documents", "paper", "papers",
  "locate", "look", "looking", "where", "search", "note", "notes",
  "report", "reports", "pdf", "pdfs", "docx", "xlsx", "spreadsheet",
  "spreadsheets", "deck", "decks", "slide", "slides", "wiki", "page", "pages",
  "called", "named",
]);

function wantsEmail(question) {
  if (memoJob(question)) return false;
  if (emailJob(question) === "send") return true;
  if (/\b(e-?mails?|inbox|raw folder|invitation)\b/i.test(question)) return true;
  return emailJob(question) === "reply";
}

/**
 * A memo is a short note the user asked to keep.
 * "save" writes a new file. "recent" is the past two weeks. "all" is every memo.
 */
function memoJob(question) {
  const q = String(question || "").toLowerCase().replace(/\s+/g, " ").trim();
  // A complaint must not create a new file.
  const complaint = /\b(stupid|do not save|don't save|stop saving)\b/.test(q) || /\bi asked you\b/.test(q);
  // "did you save the memo" is a question. "can you write a memo" is a request.
  const lookingUp = /\b(?:did you|have you|was it|is it|do you have|is there|where is|show me|list|find|what are|what memos)\b/.test(q);
  const creating = /\b(?:save|remember|jot down|write down|take down|write|make|create|add|draft)\s+(?:me\s+)?(?:a\s+|an\s+|this\s+|the\s+|down\s+)?(?:memo|note)\b/.test(q)
    || /\btake\s+(?:a\s+|down\s+)?(?:a\s+)?note\b/.test(q)
    || /^(?:please\s+)?(?:can you\s+|could you\s+|would you\s+)?(?:save|remember|jot down|write down|take down)\b/.test(q);
  const aboutMemo = /\bmemos?\b/.test(q) || (creating && /\bnotes?\b/.test(q));
  if (complaint) return null;
  if (creating && !lookingUp) return "save";
  if (!aboutMemo) return null;
  if (/\ball\b/.test(q)) return "all";
  const oneMemo = /\b(?:about|regarding|did you|have you|where is)\b/.test(q);
  if (lookingUp && oneMemo && !/\b(?:recent|last|past|this week|two weeks)\b/.test(q)) return "find";
  return "recent";
}

/**
 * A request to put a meeting on the calendar.
 * "did you schedule" is a question, so it does not create one.
 */
function meetingJob(question) {
  const q = String(question || "").toLowerCase().replace(/\s+/g, " ").trim();
  const lookingUp = /\b(?:did you|have you|what meetings|show my calendar|what is on my calendar|what's on my calendar)\b/.test(q);
  const creating = /\b(?:schedule|book|set up|arrange)\s+(?:me\s+)?(?:a\s+|an\s+|the\s+)?(?:meeting|appointment)\b/.test(q)
    || /\b(?:schedule|book|set up|arrange)\b/.test(q) && /\b(?:titled|called|named|title is|call it|title it)\b/.test(q)
    || /\b(?:add|put)\s+(?:a\s+|an\s+|the\s+)?(?:meeting|appointment)\s+(?:on|in|to)\b/.test(q)
    || (/\b(?:meeting|appointment|schedule)\b/.test(q) && /\b(?:on|to|in)\s+(?:my\s+|the\s+)?(?:outlook\s+)?calendar\b/.test(q));
  if (!creating || lookingUp) return null;
  return "schedule";
}

const HOUR_WORDS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, noon: 12, midnight: 0,
};

/** Turn "3 pm" or "ten" into an hour from 0 to 23. */
function meetingHour(hour, mark, question) {
  if (hour === 0) return 0;
  let ap = mark || "";
  if (!ap && /\bmorning\b/.test(question)) ap = "am";
  if (!ap && /\b(?:afternoon|evening|tonight)\b/.test(question)) ap = "pm";
  if (ap === "pm" && hour < 12) return hour + 12;
  if (ap === "am" && hour === 12) return 0;
  if (!ap && hour >= 1 && hour <= 7) return hour + 12;
  return hour;
}

/** The day and clock time inside a scheduling request. Missing pieces get a spoken guess. */
function meetingWhen(question, now = new Date()) {
  const q = question.toLowerCase();
  const date = new Date(now);
  date.setSeconds(0, 0);
  let assumedDay = false;
  let assumedTime = false;
  const weekday = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"]
    .findIndex((name) => new RegExp(`\\b(?:this\\s+|next\\s+)?${name}\\b`).test(q));

  if (/\btomorrow\b/.test(q)) {
    date.setDate(date.getDate() + 1);
  } else if (weekday >= 0) {
    let delta = (weekday - date.getDay() + 7) % 7;
    if (/\bnext\b/.test(q) && delta === 0) delta = 7;
    else if (delta === 0 && !/\bthis\b/.test(q)) delta = 7;
    date.setDate(date.getDate() + delta);
  } else if (!/\b(?:today|tonight)\b/.test(q)) {
    date.setDate(date.getDate() + 1);
    assumedDay = true;
  }

  let hour = null;
  let minute = 0;
  const clock = q.match(/\bat\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/);
  const wordClock = q.match(/\bat\s+(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|noon|midnight)(?:\s+(fifteen|thirty|forty[- ]five))?\s*(am|pm)?\b/);
  const halfPast = q.match(/\bhalf past\s+(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s*(am|pm)?\b/);
  if (clock) {
    hour = meetingHour(Number(clock[1]), clock[3], q);
    minute = clock[2] ? Number(clock[2]) : 0;
  } else if (wordClock) {
    const extra = wordClock[2] || "";
    if (extra.startsWith("fifteen")) minute = 15;
    else if (extra.startsWith("thirty")) minute = 30;
    else if (extra.startsWith("forty")) minute = 45;
    hour = meetingHour(HOUR_WORDS[wordClock[1]], wordClock[3], q);
  } else if (halfPast) {
    minute = 30;
    const raw = Number.isNaN(Number(halfPast[1])) ? HOUR_WORDS[halfPast[1]] : Number(halfPast[1]);
    hour = meetingHour(raw, halfPast[2], q);
  } else if (/\btonight\b/.test(q)) {
    hour = 19;
    assumedTime = true;
  } else if (/\bmorning\b/.test(q)) {
    hour = 9;
    assumedTime = true;
  } else if (/\bafternoon\b/.test(q)) {
    hour = 14;
    assumedTime = true;
  } else if (/\bevening\b/.test(q)) {
    hour = 17;
    assumedTime = true;
  } else {
    hour = 10;
    assumedTime = true;
  }
  if (minute > 59) minute = 0;
  date.setHours(hour, minute, 0, 0);

  let duration = 60;
  const minuteCount = q.match(/\bfor\s+(\d{1,3})\s+minutes?\b/);
  const hourCount = q.match(/\bfor\s+(\d{1,2})\s+hours?\b/);
  if (/\bfor\s+(?:half an hour|thirty minutes|30 minutes)\b/.test(q)) duration = 30;
  else if (minuteCount) duration = Math.min(240, Number(minuteCount[1]) || 60);
  else if (hourCount) duration = Math.min(240, (Number(hourCount[1]) || 1) * 60);
  return { date, assumedDay, assumedTime, duration };
}

function titleCaseWords(text) {
  return String(text || "")
    .split(" ")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/** A title the user asked for, such as "titled ward round" or "called lab review". */
function chosenMeetingTitle(original) {
  const match = String(original || "").match(/\b(?:titled|called|named|call it|title it|the title is|title is)\s+(.+?)(?=\s+(?:with|at|on|tomorrow|today|tonight|this|next|for|in|from|about|regarding)\b|[?.]|$)/i);
  if (!match) return "";
  let title = match[1].replace(/\s+/g, " ").trim();
  title = title.replace(/^(?:a|an|the)\s+/i, "");
  title = title.replace(/[.,]+$/, "").trim();
  if (!title || /^(?:meeting|appointment)s?$/i.test(title)) return "";
  return titleCaseWords(title).slice(0, 120);
}

/** Subject, people, place, and time taken from the request. */
function parseMeeting(question, now = new Date()) {
  const original = String(question || "").trim().replace(/\?+$/, "");
  const q = original.toLowerCase().replace(/\s+/g, " ");
  const when = meetingWhen(q, now);
  const whoTail = q.match(/\bwith\s+(.+)$/);
  let who = whoTail
    ? whoTail[1].split(/\b(?:about|regarding|titled|called|named|at|on|tomorrow|today|tonight|this|next|for|in|from)\b/)[0]
    : "";
  who = who.replace(/^(?:a|an|the|my)\s+/, "").replace(/\s+/g, " ").replace(/[.,]+$/, "").trim();
  if (/^(?:me|us|them|someone|somebody)$/.test(who)) who = "";
  who = titleCaseWords(who);
  const aboutMatch = q.match(/\b(?:about|regarding)\s+(.+?)(?=\s+(?:with|titled|called|named|at|on|tomorrow|today|tonight|this|next|for|in)\b|$)/);
  let about = aboutMatch ? aboutMatch[1].replace(/^(?:a|an|the)\s+/, "").replace(/\s+/g, " ").trim() : "";
  about = titleCaseWords(about);
  const placeMatch = q.match(/\b(?:in|at)\s+(?:the\s+)?(room\s+[a-z0-9-]+|[a-z][a-z0-9'’ -]{1,30}?)(?=\s+(?:with|about|regarding|titled|called|named|tomorrow|today|tonight|at|on|for)\b|$)/);
  let place = placeMatch ? placeMatch[1].trim() : "";
  if (/^(?:\d|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|noon|midnight|morning|afternoon|evening|night|calendar|outlook)\b/.test(place)) {
    place = "";
  }
  place = titleCaseWords(place);
  const chosen = chosenMeetingTitle(original);
  const subject = (chosen || about || (who ? `Meeting with ${who}` : "Meeting")).slice(0, 120);
  const lines = [];
  if (who) lines.push(`With ${who}.`);
  if (place) lines.push(`Place: ${place}.`);
  return {
    subject,
    body: lines.join(" "),
    location: place,
    who,
    ...when,
  };
}

/**
 * A question about what is already on the calendar.
 * "Schedule a meeting" is not this. That still opens a new event.
 */
function calendarRead(question) {
  const q = String(question || "").toLowerCase().replace(/\s+/g, " ").trim();
  const aboutDay = /\b(?:calendar|schedule|agenda|meetings?|appointments?)\b/.test(q);
  if (!aboutDay) return null;
  const asking = /\b(?:what(?:'s| is)|whats|show|tell me|do i have|have i got|anything|list|read)\b/.test(q)
    || /\bon my calendar\b/.test(q);
  const creating = /\b(?:schedule|book|set up|arrange|add|put)\b/.test(q);
  if (creating && !asking) return null;
  if (!asking && !/\b(?:today|tomorrow|tonight)\b/.test(q)) return null;
  if (/\btoday\b/.test(q) && /\btomorrow\b/.test(q)) return "both";
  if (/\btomorrow\b/.test(q)) return "tomorrow";
  return "today";
}

/**
 * The Outlook calendar, as opposed to a meeting that was just written down.
 * "What is still missing from the meeting?" is about the recording.
 * "What meetings do I have today?" is about Outlook.
 */
function asksForOutlookCalendar(question) {
  const q = String(question || "").toLowerCase();
  return /\b(?:calendar|schedule|agenda|appointments?)\b/.test(q)
    || /\b(?:what|which) meetings?\b/.test(q)
    || /\bmeetings? (?:today|tomorrow|tonight|do i have|have i got)\b/.test(q);
}

/** Outlook keeps a small calendar file for the calendar widget. AppleScript cannot see this calendar. */
function outlookCalendarFile() {
  return path.join(
    os.homedir(),
    "Library/Group Containers/UBF8T346G9.Office/Library/Application Support/Calendar Widget/store.json",
  );
}

/** The widget stores times as seconds since 1 January 2001, UTC. */
function outlookTime(seconds) {
  return new Date((Date.UTC(2001, 0, 1) / 1000 + Number(seconds)) * 1000);
}

function startOfDay(date) {
  const day = new Date(date);
  day.setHours(0, 0, 0, 0);
  return day;
}

/** Read the meetings Outlook has ready on this Mac. */
function loadOutlookCalendar() {
  const data = JSON.parse(fsSync.readFileSync(outlookCalendarFile(), "utf8"));
  if (data.hasError) throw new Error("Outlook said the calendar could not be read.");
  const events = [];
  const seen = new Set();
  const pairs = Array.isArray(data.dayToAppointments) ? data.dayToAppointments : [];
  for (let i = 0; i + 1 < pairs.length; i += 2) {
    const appointments = pairs[i + 1];
    if (!Array.isArray(appointments)) continue;
    for (const item of appointments) {
      if (!item || item.isCancelled) continue;
      const start = outlookTime(item.startTime);
      const end = outlookTime(item.endTime);
      if (Number.isNaN(start.getTime())) continue;
      const subject = String(item.subject || "Untitled").replace(/\[[^\]]*\]/g, " ").replace(/\s+/g, " ").trim() || "Untitled";
      const key = `${start.getTime()}|${subject}`;
      if (seen.has(key)) continue;
      seen.add(key);
      events.push({
        subject,
        location: String(item.location || "").replace(/\s+/g, " ").trim(),
        start,
        end,
        allDay: Boolean(item.isAllDay),
      });
    }
  }
  events.sort((a, b) => a.start - b.start);
  const windowStart = outlookTime(data.dateInterval?.start || 0);
  const windowEnd = outlookTime((data.dateInterval?.start || 0) + (data.dateInterval?.duration || 0));
  return { events, windowStart, windowEnd };
}

function eventsOnDay(events, day) {
  const start = startOfDay(day);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return events.filter((event) => event.start < end && event.end > start);
}

/** Say one day's meetings in plain words. */
function spokenDayCalendar(events, day, label) {
  if (!events.length) return `${label}, your calendar is clear.`;
  const count = events.length === 1 ? "one thing" : `${numberWord(events.length)} things`;
  const lines = events.map((event) => {
    const when = event.allDay ? "All day" : `At ${spokenClock(event.start)}`;
    const place = event.location ? `, ${event.location}` : "";
    return `${when}, ${event.subject}${place}.`;
  });
  return `${label}, ${spokenDay(day)}, you have ${count}. ${lines.join(" ")}`;
}

/** Today, tomorrow, or both. */
function spokenCalendar(when, now = new Date()) {
  let loaded;
  try {
    loaded = loadOutlookCalendar();
  } catch (err) {
    console.error("Failed while reading the Outlook calendar:", err?.message || err);
    return "I could not read the Outlook calendar on this Mac.";
  }
  const today = startOfDay(now);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const wanted = when === "tomorrow" ? [tomorrow] : when === "both" ? [today, tomorrow] : [today];
  const labels = when === "tomorrow" ? ["Tomorrow"] : when === "both" ? ["Today", "Tomorrow"] : ["Today"];
  const parts = [];
  for (let i = 0; i < wanted.length; i += 1) {
    const day = wanted[i];
    if (day < loaded.windowStart || day >= loaded.windowEnd) {
      parts.push(`${labels[i]} is not in the calendar Outlook has ready on this Mac.`);
      continue;
    }
    parts.push(spokenDayCalendar(eventsOnDay(loaded.events, day), day, labels[i]));
  }
  return parts.join(" ");
}

/** What the voice says after the calendar window opens. */
function spokenMeeting(meeting, opened) {
  const when = `${spokenDay(meeting.date)} at ${spokenClock(meeting.date)}`;
  const lines = [
    opened
      ? `I opened that meeting in Outlook for ${when}.`
      : "Outlook did not open. Is Microsoft Outlook installed?",
    `The title is ${meeting.subject}.`,
  ];
  if (meeting.assumedDay) lines.push("I did not hear a day, so I used tomorrow.");
  if (meeting.assumedTime) lines.push("I did not hear a clock time, so I used ten in the morning.");
  if (opened) lines.push("Press Add in that window. That puts it on the calendar you look at. It is not sent to anyone.");
  return lines.join(" ");
}

/** The words to keep, after "write a memo" is taken off the front. */
function memoBody(question) {
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
function memoFolder() {
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

/**
 * One short answer from the model selected on the page, without streaming.
 * Returns "" when the model could not answer.
 */
async function askModelOnce(model, instruction, text, apiKey, maxTokens, timeoutMs = 45000) {
  let raw = "";
  if (model.local) {
    const upstream = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: model.id,
        stream: false,
        think: false,
        messages: [
          { role: "system", content: instruction },
          { role: "user", content: text },
        ],
        keep_alive: "30m",
        options: { num_ctx: 4096, num_predict: Math.round(maxTokens * 0.9) },
      }),
    });
    if (!upstream.ok) return "";
    const data = await upstream.json();
    raw = data.message?.content || "";
    loadedLocalId = model.id;
  } else if (model.subscription) {
    await askClaude(model, instruction, text, "low", (piece) => { raw += piece; }, timeoutMs);
  } else if (apiKey) {
    const upstream = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      signal: AbortSignal.timeout(30000),
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: model.id,
        input: `${instruction}\n\n${text}`,
        max_output_tokens: maxTokens,
      }),
    });
    if (!upstream.ok) return "";
    const data = await upstream.json();
    raw = data.output_text
      || (data.output || []).flatMap((item) => item.content || []).map((part) => part.text || "").join("");
  }
  return String(raw).replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

/** Rewrite a memo so it is clearer, without adding new facts. */
async function clarifyMemo(model, text, apiKey) {
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

function memoStamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
  ].join("-") + `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/** Write one memo file. The file name starts with the date so it sorts by time. */
async function saveMemoFile(clear) {
  const folder = memoFolder();
  await fs.mkdir(folder, { recursive: true });
  const slug = clear.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "memo";
  const name = `${memoStamp()}-${slug}.md`;
  // The date is the start of the file name. The file itself is only the memo.
  await fs.writeFile(path.join(folder, name), `${clear}\n`, "utf8");
  return name;
}

/** Drop an old "Saved Saturday, 3 October 2026" line if a file still has one. */
function memoTextOnly(text) {
  return String(text || "")
    .replace(/^Saved\s+[A-Za-z]+,\s+\d{1,2}\s+[A-Za-z]+\s+\d{4}\s*/i, "")
    .trim();
}

/** Read memo files. Recent means the saved date is inside the past 14 days. */
async function loadMemos(job) {
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

function memoCountWords(count) {
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
async function runMemoryJob(job) {
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

async function memosForPrompt(job) {
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
async function spokenSavedMemo(question, model, apiKey) {
  const raw = memoBody(question);
  if (raw.length < 2) {
    return "I did not catch the memo. Say save a memo, then the words you want kept.";
  }
  const clear = await clarifyMemo(model, raw, apiKey);
  const name = await saveMemoFile(clear);
  console.log(`Saved memo ${name}`);
  return `I saved that memo. ${clear}`;
}

/** Find a loaded note by the end of its path, such as wiki/todo.md. */
function findNote(relSuffix) {
  const want = relSuffix.toLowerCase();
  return notes.find((note) => note.rel.replaceAll("\\", "/").toLowerCase().endsWith(want)) || null;
}

/**
 * Keyword search misses todo.md when the question says "to-do" or "today".
 * Pin the real files so the model can see them.
 */
function pinVaultNotes(question, hits) {
  const q = question.toLowerCase();
  const wanted = [];
  if (/\b(todos?|to-dos?|to do|todoist|to-?doist|tasks?|plate|have to do|due|overdue)\b/.test(q)) {
    wanted.push("wiki/todo.md", "wiki/todo_mais.md");
  }
  if (/\b(index|wikis?|where)\b/.test(q)) wanted.push("wiki/index.md");
  if (/\b(logs?|history)\b/.test(q)) wanted.push("wiki/log.md");
  if (/\bfinished\b/.test(q)) wanted.push("wiki/finished.md");

  const pinned = [];
  for (const rel of wanted) {
    const note = findNote(rel);
    if (!note) continue;
    if (hits.some((hit) => hit.note === note || hit.note.rel === note.rel)) continue;
    pinned.push({ note, terms: [], pinned: true });
  }
  return [...pinned, ...hits];
}

/**
 * When the user asks to find a file, read the index and the log on purpose.
 * A normal keyword search often misses them, because the filename is not in the question.
 * wiki/log.md is the file he calls "logs dot md".
 */
function fileCatalogHits(question) {
  if (!wantsFile(question)) return [];
  const terms = queryTerms(question).filter((word) => !FILE_SEARCH_NOISE.has(word));
  const index = findNote("wiki/index.md");
  const log = findNote("wiki/log.md");
  const hits = [];

  if (index) {
    const lines = terms.length ? matchingLines(index.text, terms, 18) : indexHeadings(index.text);
    hits.push({
      note: index,
      terms,
      pinned: true,
      override: lines
        ? `Lines from the index that match this search:\n${lines}`
        : "Looked through wiki/index.md. No line matched those words.",
    });
  }
  if (log) {
    const passages = terms.length ? matchingWindows(log.text, terms, 3, 320) : log.text.slice(-1200).trim();
    hits.push({
      note: log,
      terms,
      pinned: true,
      override: passages
        ? `Passages from the log (he calls this logs dot md):\n${passages}`
        : "Looked through wiki/log.md. No passage matched those words.",
    });
  }
  return hits;
}

/** Index lines that mention the search words. Lines that mention more words come first. */
function matchingLines(text, terms, maxLines) {
  const scored = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line.length < 8) continue;
    const lower = line.toLowerCase();
    let score = 0;
    for (const term of terms) {
      if (lower.includes(term)) score += 1;
    }
    if (score > 0) scored.push({ line, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, maxLines).map((item) => item.line).join("\n");
}

/** The index's section titles, used when the question names no specific file. */
function indexHeadings(text) {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("#"))
    .slice(0, 40)
    .join("\n");
}

/** Short slices of a long file around the search words. Later slices are preferred when scores tie. */
function matchingWindows(text, terms, maxWindows, radius) {
  const lower = text.toLowerCase();
  const spots = [];
  for (const term of terms) {
    let at = 0;
    while (spots.length < 40 && (at = lower.indexOf(term, at)) !== -1) {
      spots.push(at);
      at += term.length;
    }
  }
  if (!spots.length) return "";
  spots.sort((a, b) => a - b);
  const clusters = [];
  for (const at of spots) {
    const last = clusters[clusters.length - 1];
    if (last && at - last.end < radius) {
      last.end = at;
      last.hits += 1;
    } else {
      clusters.push({ start: at, end: at, hits: 1 });
    }
  }
  clusters.sort((a, b) => b.hits - a.hits || b.start - a.start);
  return clusters.slice(0, maxWindows).map((cluster) => {
    const from = Math.max(0, cluster.start - radius);
    let slice = text.slice(from, cluster.end + radius).replace(/\s+/g, " ").trim();
    if (from > 0) slice = `…${slice}`;
    if (cluster.end + radius < text.length) slice = `${slice}…`;
    return slice;
  }).join("\n\n");
}

/** Keyword hits, plus the index and the log when the question is "find a file". */
async function notesForQuestion(question, limit = 4) {
  // "file" and "find" match almost every note. Search the real name only.
  let searchQuestion = question;
  if (wantsFile(question)) {
    const kept = queryTerms(question).filter((word) => !FILE_SEARCH_NOISE.has(word));
    searchQuestion = kept.join(" ");
  }
  const hits = searchQuestion
    ? pinVaultNotes(question, await searchNotes(searchQuestion, limit))
    : [];
  const catalog = fileCatalogHits(question);
  if (!catalog.length) return hits;
  const covered = new Set(catalog.map((hit) => hit.note.rel));
  return [...catalog, ...hits.filter((hit) => !covered.has(hit.note.rel))];
}

function noteBody(note, terms) {
  const rel = note.rel.replaceAll("\\", "/").toLowerCase();
  const keyFile = ["wiki/todo.md", "wiki/todo_mais.md", "wiki/log.md", "wiki/index.md", "wiki/finished.md"]
    .some((suffix) => rel.endsWith(suffix));
  if (keyFile || !terms?.length) {
    if (rel.startsWith("raw/") && note.text.length > 1800) return note.text.slice(0, 2400).trim();
    return vaultExcerpt(note);
  }
  return excerpt(note.text, terms);
}

function vaultExcerpt(note) {
  const rel = note.rel.replaceAll("\\", "/").toLowerCase();
  if (rel.endsWith("wiki/log.md")) return note.text.slice(-1800).trim();
  if (rel.endsWith("wiki/index.md")) return note.text.slice(0, 1800).trim();
  if (rel.endsWith("wiki/todo.md")) return note.text.slice(0, 4500).trim();
  return note.text.slice(0, 1800).trim();
}

/**
 * The here_and_now tool.
 * It reads the Mac clock and says the time and place in full words.
 * The voice reads those words exactly, so this must not use 07:03 or "Oct".
 */
function hereAndNow() {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Amman";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "long",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    hourCycle: "h23",
  }).formatToParts(new Date());
  const pick = (type) => parts.find((part) => part.type === type)?.value || "";
  let hour = Number(pick("hour"));
  if (hour === 24) hour = 0;
  const clock = new Date(Number(pick("year")), Number(pick("month")) - 1, Number(pick("day")), hour, Number(pick("minute")));
  const city = timeZone === "Asia/Amman"
    ? "Amman, Jordan"
    : (timeZone.split("/").pop() || "this Mac").replace(/_/g, " ");
  return `It is ${spokenClock(clock)} on ${pick("weekday")}, ${spokenDay(clock)}. The place is ${city}.`;
}

/** The clock on this Mac, so "today" does not depend on a web search. */
function todayLabel() {
  return new Intl.DateTimeFormat("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "Asia/Amman",
  }).format(new Date());
}

/** Whisper writes room sounds in parentheses. Those are not questions. */
function isNoise(question) {
  const raw = String(question || "").trim();
  if (/^\([^)]*\)$/.test(raw) || /^\[[^\]]*\]$/.test(raw)) return true;
  const cleaned = raw.toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, "").trim();
  const junk = new Set([
    "thank you",
    "thanks for watching",
    "you",
    "bye",
    "silence",
    "music",
    "blank audio",
    "door opens",
    "door closing",
    "sighs",
    "sigh",
    "coughing",
    "laughter",
    "background noise",
  ]);
  return !cleaned || junk.has(cleaned);
}

/** "Latest news today", including a mishearing such as "latest in use today". */
function wantsNews(question) {
  const q = question.toLowerCase();
  if (/\b(news|headline|headlines)\b/.test(q)) return true;
  if (/\blatest\b/.test(q) && /\b(today|tonight|now|in use)\b/.test(q)) return true;
  if (/\b(happening|going on)\b/.test(q) && /\b(today|tonight|now)\b/.test(q)) return true;
  return false;
}

/** Questions whose answer changes over time, or that ask for the web outright. */
function needsFreshFacts(question) {
  const q = question.toLowerCase();
  if (wantsNews(question)) return true;
  if (/\b(search|google|look up|online|on the web|internet)\b/.test(q)) return true;
  return /\b(today|tonight|tomorrow|yesterday|now|current|currently|latest|recent|recently|this (week|month|year)|price|prices|cost of|weather|forecast|score|stock|exchange rate|who won|released?|20[2-9]\d)\b/.test(q);
}

/** The web is slow (1-14s). Look only when the answer needs fresh facts. */
function shouldBrowse(question) {
  const cleaned = question.toLowerCase().replace(/[^a-z0-9\s']/g, " ").replace(/\s+/g, " ").trim();
  const skip = new Set([
    "hi",
    "hello",
    "hey",
    "can you hear me",
    "are you there",
    "thank you",
    "thanks",
  ]);
  if (skip.has(cleaned) || isChatQuestion(question)) return false;
  if (wantsEmail(question)) return false;
  if (wantsFile(question)) return false;
  if (isVaultQuestion(question) && !wantsNews(question)) return false;
  return cleaned.split(" ").filter(Boolean).length >= 2 && needsFreshFacts(question);
}

function decodeHtml(text) {
  return text
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * "Show me cnn.com" or "open https://www.cnn.com" opens that page in the browser.
 * A file name such as todo.md is not a web page.
 */
function showSiteJob(question) {
  const q = String(question || "").trim().replace(/^["“'\s.,]+|["”'\s.?!]+$/g, "");
  const asking = /^(?:please\s+)?(?:can you\s+|could you\s+|would you\s+)?(?:please\s+)?(?:show(?:\s+me)?|open|pull up|bring up|go to)\b/i.test(q);
  if (!asking) return null;
  const found = q.match(/https?:\/\/[^\s]+/i)
    || q.match(/\b(?:[a-z0-9-]+\.)+(?:com|org|net|io|gov|edu|ai|co\.uk|uk|jo|news|tv|info|me)(?:\/[^\s]*)?/i);
  if (!found) return null;
  let url = found[0].replace(/[.,!?;)]+$/g, "");
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  try {
    const parsed = new URL(url);
    if (!isPublicWebUrl(parsed.href)) return null;
    const name = parsed.hostname.replace(/^www\./, "");
    return { url: parsed.href, name };
  } catch (err) {
    console.error("Failed while reading a web address to open:", err.message);
    return null;
  }
}

/** Only fetch normal public web pages. Never call this Mac or a private network. */
function isPublicWebUrl(raw) {
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    const host = url.hostname.toLowerCase();
    if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) return false;
    if (host === "::1" || host === "[::1]") return false;
    if (/^(127\.|10\.|192\.168\.|169\.254\.|0\.|172\.(1[6-9]|2\d|3[0-1])\.)/.test(host)) return false;
    if (/\.(pdf|zip|png|jpe?g|gif|mp3|mp4|wav)$/i.test(url.pathname)) return false;
    return true;
  } catch {
    return false;
  }
}

function unwrapDuckLink(href) {
  if (href.startsWith("//")) href = `https:${href}`;
  try {
    const url = new URL(href);
    const target = url.searchParams.get("uddg");
    return target ? decodeURIComponent(target) : href;
  } catch {
    return href;
  }
}

/** Turn a web page into plain sentences, and keep only the opening part. */
function pageText(html) {
  const stripped = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
    .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
    .replace(/<header[\s\S]*?<\/header>/gi, " ");
  const paragraphs = [...stripped.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)]
    .map((match) => decodeHtml(match[1]))
    .filter((paragraph) => paragraph.length > 40);
  const text = paragraphs.length ? paragraphs.join("\n\n") : decodeHtml(stripped);
  return text.slice(0, 1800);
}

async function readLimitedText(response, maxBytes = 180_000) {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks = [];
  let total = 0;
  while (total < maxBytes) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  try {
    await reader.cancel();
  } catch {
    /* the rest of a long page is not needed */
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Read one search result page. A slow site is skipped so the answer can still start. */
async function fetchPage(result) {
  try {
    const response = await fetch(result.url, {
      signal: AbortSignal.timeout(3000),
      redirect: "follow",
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
        Accept: "text/html,text/plain",
      },
    });
    if (!response.ok) return { ...result, text: result.snippet };
    const kind = response.headers.get("content-type") || "";
    if (kind && !/text\/html|text\/plain/.test(kind)) return { ...result, text: result.snippet };
    const html = await readLimitedText(response);
    const text = pageText(html);
    return { ...result, text: text || result.snippet };
  } catch (err) {
    console.error("Failed while reading a web page:", result.url, err?.message || err);
    return { ...result, text: result.snippet };
  }
}

/**
 * Look the question up on the web from this Mac.
 * DuckDuckGo returns a list of pages. We keep four and use their snippets.
 * Only news reads one full page, since headlines need more than a snippet.
 * The model never connects to the internet itself.
 */
async function searchWeb(question) {
  if (!shouldBrowse(question)) return [];
  let html = "";
  try {
    const query = wantsNews(question) ? `top news headlines ${todayLabel()}` : question;
    const response = await fetch(`https://html.duckduckgo.com/html/?${new URLSearchParams({ q: query })}`, {
      signal: AbortSignal.timeout(3000),
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
        Accept: "text/html",
      },
    });
    if (!response.ok) throw new Error(`Search returned ${response.status}`);
    html = await response.text();
  } catch (err) {
    console.error("Failed while searching the web:", err?.message || err);
    return [];
  }

  const results = [];
  const linkPattern = /<a rel="nofollow" class="result__a" href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snippets = [...html.matchAll(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g)].map((match) =>
    decodeHtml(match[1])
  );
  let match;
  let matchIndex = 0;
  while ((match = linkPattern.exec(html)) && results.length < 4) {
    const snippet = snippets[matchIndex] || "";
    matchIndex += 1;
    const url = unwrapDuckLink(match[1]);
    if (!isPublicWebUrl(url)) continue;
    results.push({
      title: decodeHtml(match[2]) || url,
      url,
      snippet,
    });
  }
  if (!results.length) return [];

  const read = wantsNews(question) ? 1 : 0;
  const opened = await Promise.all(results.slice(0, read).map((result) => fetchPage(result)));
  const rest = results.slice(read).map((result) => ({ ...result, text: result.snippet }));
  return [...opened, ...rest].filter((page) => page.text);
}

// Short map of CLAUDE.md, the vault's operating manual.
// The full manual is long. This is the part the model needs to find files.
const BRAIN_MAP = [
  "The selected folder is a second brain: raw documents in raw/ and wiki pages in wiki/. The user may call wiki/ the wikis folder. There is no folder named wikis.",
  "Notes can also be PDF and Word files. Their File line ends in .pdf or .docx. Treat them like any other note.",
  "Three files are real and matter on every question about his notes. Do not say they are missing when their text is in the notes.",
  "wiki/todo.md holds every to-do, newest on top. He may call it to-do dot md or Todoist. For tasks, today, the to-do list, or Todoist, answer from this file and name the open tasks.",
  "wiki/index.md lists every wiki page. For any other question, start there.",
  "wiki/log.md records where files were added or mentioned. He calls it logs dot md. Answer history questions from it.",
  "When the user asks to find a file, look through wiki/index.md and wiki/log.md before saying it is missing.",
  "New emails are text files in raw/ at the vault root, not wiki pages. Answer email questions from those files.",
].join(" ");

// The app does these itself, before the model sees the question. Reaching the model means the words were not recognized.
const APP_ABILITIES = [
  "This app does these things itself when the user says the matching words. Never say the app cannot do them. If such a request reaches you, the words were not recognized: tell the user the phrase to say.",
  "Text the user's own phone: say text me, then the message, or send me an iMessage saying, then the message.",
  "Save a memo: say remember that, then the fact. List memos: say what are my memos.",
  "Keep a standing rule for every answer: say from now on, then the rule. List rules and memos: say what are your memories. Remove one: say forget, then what it was about.",
  "Draft an email: say send an email to, then the name and what it says. A draft waits on the page. The user says send it, or presses Open. Outlook opens the draft. The user presses Send. Say don't to drop it.",
  "Put a meeting on the calendar: say schedule a meeting with, then the person, day, and time. It waits until the user says send it. Outlook then opens the event to check and save. Say don't to drop it.",
  "Show a web page in the browser: say show me, then the address, such as show me cnn.com. It opens right away. A saved place works the same way: if a memory says go to inotes opens a site, then go to inotes opens that site.",
  "Watch a public web page: say watch, then the address. A change texts the user's phone.",
  "A reminder: say remind me in 20 minutes to, then the task. It still fires after a restart.",
  "The last conversation is saved on this Mac and comes back the next time they press Start talking.",
  "Open a file: say open, then the file name. It looks in the notes first, then the whole Mac. A Word file opens in LibreOffice, where the user can read and edit it. Say open, then what it is about, then word document. This works when the file name is Arabic and the user asks in English. Never say you cannot open a file. Never tell the user to rename it or to save a PDF just so it can be opened.",
  "Find an email: say find the email from, or about, then the name or subject. Then say open number one, two, or three, and Outlook searches for it.",
  "Search the whole Mac like the Finder: say find, then the file name, then on my Mac. Then say open number one, two, or three.",
  "Read today's or tomorrow's calendar, today's emails, and which emails need an urgent reply.",
  "The app cannot change or delete the user's existing files itself, and it never sends an email by itself.",
].join(" ");

const INSTRUCTIONS = [
  "You answer questions from a personal wiki of work notes, and from web pages this Mac looked up.",
  BRAIN_MAP,
  APP_ABILITIES,
  "The prompt may list Things the user asked you to always keep in mind. Follow them in every answer, unless one conflicts with a rule about facts or safety.",
  "Use the note excerpts for the user's own work. Use the web page excerpts only for facts that are not in the notes.",
  "If the wording is clumsy but a topic is clear, answer that topic. A request for the latest news means a short briefing of today's headlines.",
  "Ask what they mean only when there is no topic at all, such as a noise or 'can you hear me'.",
  "For follow-ups and questions about the chat, such as what the user asked last time, use Earlier in this conversation. Do not say a chat question is missing from the notes.",
  "Be brief and direct. Use a note only when that note actually states the fact. If the fact is only on a web page, say you found it on the web. Do not call a web page a note.",
  "Do not invent people, dates, or tasks.",
  "Answer in the language of the question. If the user asks in Arabic, answer in Arabic.",
  "The here_and_now tool already ran. Its words are the Here and now line. Use that line for the time, the date, and the place. Do not guess, and do not look those up on the web.",
  "When the user asks for today's emails, leave out those from donotreply@khcc.jo. Say how many emails there are and who they are from, then summarize each one.",
].join(" ");

// The voice reads every word exactly as it is written. It does not turn abbreviations into speech.
const SPOKEN_STYLE = [
  "Your answer will be read aloud by a voice assistant. The voice reads the words literally. Write only what you want heard.",
  "Use plain spoken sentences only.",
  "No markdown: no headings, bullet points, numbered lists, bold, italics, tables, file size, or code.",
  "No asterisks, hashes, backticks, underscores, slashes, brackets, emoji, links, web addresses, file paths, or HTML tags.",
  "Do not end with a 'Note:' or 'Source:' line. If you name the note, say it inside a sentence, for example: Your to-do list note says...",
  "Turn a list into one sentence, for example: first..., then..., and finally....",
  "Write dates and times as full words. Say October, not a three-letter month. Say nine eleven in the evening, not a clock code. Say kilograms, not an abbreviation.",
].join(" ");

/**
 * Read OpenAI's event stream and forward only the answer text.
 * OpenAI sends blocks that look like:
 *   event: response.output_text.delta
 *   data: {"delta":"Hello"}
 */
async function streamAnswer(apiKey, prompt, res, model, reasoning, spoken, photo = "") {
  let upstream;
  try {
    upstream = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: model.id,
        reasoning: { effort: reasoning },
        instructions: [INSTRUCTIONS, spoken ? SPOKEN_STYLE : "", guideBlock()].filter(Boolean).join("\n\n"),
        input: photo
          ? [{
              role: "user",
              content: [
                { type: "input_text", text: prompt },
                { type: "input_image", image_url: photo },
              ],
            }]
          : prompt,
        max_output_tokens: OUTPUT_CAP[reasoning] || OUTPUT_CAP.medium,
        stream: true,
      }),
    });
  } catch (err) {
    const reason = err?.cause?.message || err?.message || String(err);
    console.error("Failed while calling OpenAI:", reason);
    throw new Error(`Could not reach OpenAI (${reason}).`);
  }

  if (!upstream.ok || !upstream.body) {
    const details = await upstream.text();
    console.error("OpenAI request failed:", upstream.status, redactSecrets(details));
    throw new Error(`OpenAI returned an error (${upstream.status}).`);
  }

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let sentUsage = false;
  const seenEvents = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const chunks = buffer.split("\n\n");
    buffer = chunks.pop() || "";

    for (const chunk of chunks) {
      let eventName = "message";
      let data = "";
      for (const line of chunk.split("\n")) {
        if (line.startsWith("event:")) eventName = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      if (!data || data === "[DONE]") continue;
      seenEvents.push(eventName);

      let payload;
      try {
        payload = JSON.parse(data);
      } catch {
        continue;
      }

      if (eventName === "response.output_text.delta" && payload.delta) {
        writeEvent(res, { type: "delta", text: payload.delta });
      } else if (
        eventName === "response.completed" ||
        eventName === "response.incomplete" ||
        payload.type === "response.completed" ||
        payload.type === "response.incomplete"
      ) {
        const usage = payload.response?.usage || payload.usage;
        if (usage && !sentUsage) {
          sentUsage = true;
          writeEvent(res, usageEvent(model, reasoning, usage));
        }
      } else if (eventName === "response.failed" || eventName === "error") {
        const message = payload.error?.message || payload.message || "OpenAI failed while answering.";
        console.error("OpenAI stream error:", message);
        writeEvent(res, { type: "error", message });
      }
    }
  }

  if (!sentUsage) {
    console.error(
      "OpenAI finished without a token report. Events seen:",
      [...new Set(seenEvents)].join(", ") || "(none)"
    );
  }
}

/** Turn the Thinking menu into Ollama's think setting. Off means no hidden thinking. */
function ollamaThink(reasoning) {
  if (!reasoning || reasoning === "none") return false;
  if (reasoning === "low" || reasoning === "medium" || reasoning === "high") return reasoning;
  return "high";
}

/**
 * Ask the local Ollama model and stream the answer the same way OpenAI does.
 * Thinking text is kept out of the spoken answer. Token counts come from Ollama.
 */
async function streamLocalAnswer(prompt, res, model, reasoning, spoken, longSpoken = false) {
  let upstream;
  try {
    upstream = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: model.id,
        stream: true,
        think: ollamaThink(reasoning),
        messages: [
          {
            role: "system",
            content: [
              INSTRUCTIONS,
              // A short cap keeps Bonsai from talking for minutes.
              // GPT-OSS is uncapped, so it may use as many words as the answer needs.
              model.uncapped || longSpoken
                ? "The answer will be read aloud. Write the full answer. Do not stop early."
                : "The answer will be read aloud. Use at most 3 short sentences, then stop.",
              spoken ? SPOKEN_STYLE : "",
              guideBlock(),
            ].filter(Boolean).join("\n\n"),
          },
          { role: "user", content: prompt },
        ],
        // Bonsai defaults to a 262k-token window, which reserves ~22 GB and
        // made one answer take 90s. The prompt is a few note excerpts, so 16k is plenty.
        // keep_alive keeps the model loaded between questions, so no 4s reload.
        // num_predict is small so a spoken reply cannot run on for minutes.
        // -1 means no output limit. Ollama stops when the model is done.
        keep_alive: "30m",
        options: {
          num_ctx: 16384,
          num_predict: model.uncapped
            ? -1
            : longSpoken
              ? 900 + (LOCAL_THINK_ROOM[reasoning] || 0)
              : (LOCAL_REPLY_CAP[reasoning] || LOCAL_REPLY_CAP.none) + (LOCAL_THINK_ROOM[reasoning] || 0),
        },
      }),
    });
  } catch (err) {
    const reason = err?.cause?.message || err?.message || String(err);
    console.error("Failed while calling the local model:", reason);
    throw new Error("Could not reach the local model. Start Ollama, then try again.");
  }

  if (!upstream.ok || !upstream.body) {
    const details = await upstream.text();
    console.error("Local model request failed:", upstream.status, details);
    throw new Error(`The local model returned an error (${upstream.status}).`);
  }

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.trim()) continue;
      let payload;
      try {
        payload = JSON.parse(line);
      } catch (err) {
        console.error("Failed while reading the local model stream:", err);
        continue;
      }
      if (payload.error) {
        writeEvent(res, { type: "error", message: String(payload.error) });
        continue;
      }
      const piece = payload.message?.content || "";
      if (piece) writeEvent(res, { type: "delta", text: piece });
      if (payload.done) {
        writeEvent(res, usageEvent(model, reasoning, {
          input_tokens: payload.prompt_eval_count || 0,
          output_tokens: payload.eval_count || 0,
        }));
      }
    }
  }
}

// Claude Code on this Mac. The server may start without ~/.local/bin on its PATH.
const CLAUDE_BIN = process.env.CLAUDE_BIN
  || [path.join(os.homedir(), ".local/bin/claude"), "/opt/homebrew/bin/claude"].find((p) => fsSync.existsSync(p))
  || "claude";

/**
 * Ask Claude through Claude Code (`claude -p`), which uses the logged-in Claude
 * subscription, not an API key. No saved session, no user settings,
 * so hooks and plugins from ~/.claude do not run for every answer.
 * With dirs, Claude may read (never write) files in those folders; without, it has no tools.
 * onText gets each piece of the answer. Resolves with the token usage.
 */
function askClaude(model, system, prompt, effort, onText, timeoutMs = 120000, dirs = []) {
  return new Promise((resolve, reject) => {
    const tools = dirs.length ? "Read,Glob,Grep" : "";
    const args = [
      "-p", "--model", model.cliModel, "--tools", tools, "--no-session-persistence",
      "--setting-sources", "", "--strict-mcp-config", "--system-prompt", system,
      "--output-format", "stream-json", "--include-partial-messages", "--verbose",
    ];
    if (tools) args.push("--allowedTools", tools);
    if (dirs.length > 1) args.push("--add-dir", ...dirs.slice(1));
    if (effort) args.push("--effort", effort);
    const env = { ...process.env };
    // An API key here would bill the API instead of the subscription.
    delete env.ANTHROPIC_API_KEY;
    const child = spawn(CLAUDE_BIN, args, { cwd: dirs[0] || os.tmpdir(), env });
    const timer = setTimeout(() => child.kill(), timeoutMs);
    let buffer = "";
    let stderr = "";
    let result = null;

    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        const delta = msg.type === "stream_event" && msg.event?.type === "content_block_delta" ? msg.event.delta : null;
        if (delta?.type === "text_delta" && delta.text) onText(delta.text);
        if (msg.type === "result") result = msg;
      }
    });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`Could not start Claude Code (${err.message}). Is it installed and logged in?`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (result && !result.is_error) {
        const u = result.usage || {};
        const cached = u.cache_read_input_tokens || 0;
        return resolve({
          input_tokens: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + cached,
          input_tokens_details: { cached_tokens: cached },
          output_tokens: u.output_tokens || 0,
        });
      }
      const why = redactSecrets(result?.result || stderr.trim() || `exit code ${code}`);
      console.error("Claude Code failed:", why);
      reject(new Error(`Claude returned an error (${String(why).slice(0, 200)}).`));
    });
    child.stdin.end(prompt);
  });
}

async function streamClaudeAnswer(prompt, res, model, reasoning, spoken) {
  const files = [
    `You can read the user's chosen folders with the Read, Glob and Grep tools: ${selected.join(", ")}.`,
    "Use them when the question is about a folder or file that the note excerpts do not cover. Read can open PDFs.",
    "You cannot write files or run commands. Never type tool-call markup such as <invoke> in your answer.",
    "Do not narrate your searching. Answer only after you have looked.",
  ].join(" ");
  const system = [INSTRUCTIONS, files, spoken ? SPOKEN_STYLE : "", guideBlock()].filter(Boolean).join("\n\n");
  const usage = await askClaude(model, system, prompt, reasoning, (text) => writeEvent(res, { type: "delta", text }), 180000, selected);
  writeEvent(res, usageEvent(model, reasoning, usage));
}

function writeEvent(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

/** A short spoken answer, plus an optional card on the voice page. */
function replyNow(res, text, card) {
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.flushHeaders?.();
  if (card) writeEvent(res, { type: "work", card });
  writeEvent(res, { type: "delta", text });
  writeEvent(res, { type: "done" });
  res.end();
}

/** Recent saved emails become ideas the user can do or skip. */
function syncSuggestions() {
  try {
    const cutoff = Date.now() - 2 * 86_400_000;
    const items = [...rawMail]
      .filter((file) => file.mtime >= cutoff)
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, 12)
      .map((file) => ({
        key: file.rel,
        title: `Reply to ${speakTitle(file.title)}`,
        source: spokenWhen(file.mtime),
        detail: speakTitle(file.title),
      }));
    desk.mergeSuggestions(items);
  } catch (err) {
    console.error("Failed while building suggestions:", err?.message || err);
  }
  // New emails, and drafts that have no summary yet, get a short Haiku note.
  queueWorkSummaries();
}

// Haiku only writes the one-line note on a work card. It does not answer questions.
const HAIKU_MODEL = { cliModel: "haiku" };
let workSummaryQueued = false;
let workSummaryRunning = false;

/** Ask again after the current batch, so a draft saved mid-summary is not skipped. */
function queueWorkSummaries() {
  workSummaryQueued = true;
  if (workSummaryRunning) return;
  workSummaryRunning = true;
  fillWorkSummaries()
    .catch((err) => console.error("Failed while summarizing work cards:", err?.message || err))
    .finally(() => {
      workSummaryRunning = false;
      if (workSummaryQueued) queueWorkSummaries();
    });
}

/** The saved email as plain text, with its subject, for the summary. */
async function suggestionText(key) {
  const file = rawMail.find((entry) => entry.rel === key);
  if (!file) return "";
  // OneDrive sometimes answers "try again" while the app is still starting.
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const raw = await fs.readFile(file.full, "utf8");
      const body = emailLines(raw).slice(0, 3500);
      const subject = speakTitle(file.title);
      return [subject ? `Subject: ${subject}` : "", body].filter(Boolean).join("\n\n");
    } catch (err) {
      const busy = /unknown system error -11|EAGAIN/i.test(err?.message || "");
      if (!busy || attempt === 3) {
        console.error("Failed while reading an email to summarize:", err?.message || err);
        return "";
      }
      await new Promise((resolve) => setTimeout(resolve, 1500 * (attempt + 1)));
    }
  }
  return "";
}

/**
 * One or two plain sentences about a message.
 * A very short message is already the summary, so Haiku is not called.
 */
async function summarizeWithHaiku(text, about) {
  const source = String(text || "").replace(/\s+/g, " ").trim().slice(0, 3500);
  if (!source) return "";
  // A few words are already clear. Anything longer is rewritten by Haiku.
  if (source.length < 80) return source;
  const system = about === "draft"
    ? "Summarize this new email in one short sentence. Say what it is about. Use plain words. Do not add a greeting or a subject line."
    : "Summarize the message this person is about to reply to. Use one or two short sentences. Say who it is from, when the message says, and what they want. Use plain words. Do not write the reply.";
  let out = "";
  await askClaude(HAIKU_MODEL, system, source, "", (chunk) => { out += chunk; }, 40000);
  return out.replace(/\s+/g, " ").trim().slice(0, 420);
}

/** Fill every work card that is still missing its short note. */
async function fillWorkSummaries() {
  workSummaryQueued = false;
  const tasks = desk.pendingSummaries();
  let retry = false;
  for (const task of tasks) {
    let text = task.text;
    if (task.kind === "suggestion") text = await suggestionText(task.key);
    // A missed file is not saved as a summary, so the next pass can try again.
    if (!text) {
      retry = true;
      continue;
    }
    let summary = "";
    try {
      summary = await summarizeWithHaiku(text, task.about);
    } catch (err) {
      // The card still needs words if Haiku cannot run. Use the opening of the message.
      console.error("Failed while summarizing one work card with Haiku:", err?.message || err);
      summary = text.replace(/\s+/g, " ").trim().slice(0, 220);
    }
    if (summary && desk.rememberSummary(task.kind, task.id, summary)) sendControl("desk", {});
  }
  if (retry) setTimeout(() => queueWorkSummaries(), 8000);
}

function meetingFromDraft(draft) {
  return {
    subject: draft.subject,
    body: draft.body,
    location: draft.location,
    duration: draft.duration,
    date: new Date(draft.date),
  };
}

/** What the voice says while a meeting is waiting, before Outlook opens. */
function spokenMeetingWaiting(meeting) {
  const when = `${spokenDay(meeting.date)} at ${spokenClock(meeting.date)}`;
  const lines = [
    `I have a meeting ready for ${when}.`,
    `The title is ${meeting.subject}.`,
  ];
  if (meeting.assumedDay) lines.push("I did not hear a day, so I used tomorrow.");
  if (meeting.assumedTime) lines.push("I did not hear a clock time, so I used ten in the morning.");
  lines.push("Say send it to open it in Outlook, or don't to drop it. It is not on the calendar until you press Add.");
  return lines.join(" ");
}

/** Open the draft that is waiting. Outlook still needs the user to press Send or Add. */
async function openSavedDraft(job) {
  if (job.draft?.type === "meeting") {
    await openOutlookMeeting(meetingFromDraft(job.draft));
    desk.finishJob(job.id, "done", "Opened in Outlook. Press Add if it looks right.");
    return "I opened that meeting in Outlook. Press Add if it looks right. It is not sent to anyone.";
  }
  const draft = job.draft || {};
  const letter = polishReply(draft.body || "", draft.name);
  const body = replyWithOriginal(letter, draft.original);
  await openOutlookDraft({
    to: cleanMailAddress(draft.to),
    subject: draft.subject || "Note",
    body,
    name: draft.name || "",
  });
  desk.finishJob(job.id, "done", "Opened in Outlook. Press Send when it looks right.");
  return "I opened that draft in Outlook. Press Send when it looks right. I did not send it.";
}

async function runDeskCommand(command) {
  if (command.action === "say") return { text: command.text };
  if (command.action === "watch") {
    const saved = desk.addWatch(command.url);
    return { text: saved.text };
  }
  if (command.action === "cancel-watches") {
    const count = desk.cancelWatches();
    const text = count ? `Stopped watching ${count === 1 ? "that page" : `${count} pages`}.` : "I was not watching any page.";
    return { text, card: { title: "Watch", lines: [text] } };
  }
  if (command.action === "clear-alerts") {
    const count = desk.clearAlerts();
    const text = count ? "Cleared that alert." : "There is no alert waiting.";
    return { text, card: { title: "Watch", lines: [text] } };
  }
  if (command.action === "jobs") {
    const text = desk.jobsSentence();
    return { text, card: { title: "Jobs", lines: [text] } };
  }
  if (command.action === "suggestions") {
    const text = desk.suggestionsSentence();
    return { text, card: { title: "Ideas", lines: [text] } };
  }
  if (command.action === "remind") {
    const job = desk.addReminder(command.title, command.dueAt);
    return { text: `I will remind you: ${job.title}. ${job.detail}` };
  }
  if (command.action === "skip-suggestion") {
    const item = desk.suggestionAt(command.index);
    if (!item) return { text: "There is no idea with that number." };
    desk.dismissSuggestion(item.id);
    return { text: `Skipped. ${item.title}.`, card: { title: "Ideas", lines: [`Skipped: ${item.title}`] } };
  }
  if (command.action === "confirm") {
    const job = desk.latestDraft();
    if (!job) return { text: "Nothing is waiting for a yes. Ask me to draft an email or schedule a meeting first." };
    try {
      const text = await openSavedDraft(job);
      return { text, card: { title: job.title, lines: [text] } };
    } catch (err) {
      console.error("Failed while opening a saved draft:", err?.message || err);
      return { text: "I could not open Outlook. Is Microsoft Outlook installed?" };
    }
  }
  if (command.action === "skip") {
    const job = desk.latestDraft();
    if (!job) {
      const watches = desk.cancelWatches();
      if (watches) return { text: "Stopped watching.", card: { title: "Watch", lines: ["Stopped watching."] } };
      return { text: "Nothing is waiting to drop." };
    }
    desk.finishJob(job.id, "skipped", "You dropped this draft.");
    const kind = job.draft?.type === "meeting" ? "meeting" : "draft";
    return { text: `Dropped that ${kind}. Nothing was opened.`, card: { title: job.title, lines: ["Dropped. Nothing was opened."] } };
  }
  return null;
}

// Tells the Outlook app on this Mac to open a new message. It does not send it.
// "plain text content" is the body. "content" would be HTML, which we do not want.
const OUTLOOK_SCRIPT = `
on run argv
  set theTo to item 1 of argv
  set theSubject to item 2 of argv
  set theBody to item 3 of argv
  set theName to item 4 of argv
  tell application "Microsoft Outlook"
    set newMessage to make new outgoing message with properties {subject:theSubject, plain text content:theBody}
    if theTo is not "" then
      make new to recipient at newMessage with properties {email address:{name:theName, address:theTo}}
    end if
    open newMessage
    activate
  end tell
end run
`;

/**
 * Open a draft in Outlook, not Apple Mail.
 * First ask Outlook directly. If that app will not listen, hand the same
 * draft to the Outlook app as a mail link.
 */
function icsEscape(text) {
  return String(text || "")
    .replace(/\\/g, "\\\\")
    .replace(/\r?\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}

function icsLocal(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}T${pad(date.getHours())}${pad(date.getMinutes())}00`;
}

/** A calendar file Outlook opens as a new event on the calendar the user actually sees. */
function meetingIcs(meeting) {
  const start = meeting.date;
  const end = new Date(start.getTime() + (meeting.duration || 60) * 60 * 1000);
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//second-brain//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${crypto.randomUUID()}@second-brain`,
    `DTSTAMP:${icsLocal(new Date())}`,
    `DTSTART:${icsLocal(start)}`,
    `DTEND:${icsLocal(end)}`,
    `SUMMARY:${icsEscape(meeting.subject)}`,
  ];
  if (meeting.location) lines.push(`LOCATION:${icsEscape(meeting.location)}`);
  if (meeting.body) lines.push(`DESCRIPTION:${icsEscape(meeting.body)}`);
  lines.push("END:VEVENT", "END:VCALENDAR", "");
  return lines.join("\r\n");
}

async function openOutlookMeeting(meeting) {
  const file = path.join(os.tmpdir(), `meeting-${Date.now()}.ics`);
  await fs.writeFile(file, meetingIcs(meeting), "utf8");
  // Opening the file shows Outlook's Add Event window. Saving through the
  // script only reached a hidden On My Computer calendar, which is not the
  // calendar the user looks at.
  await runCommand("open", ["-a", "Microsoft Outlook", file]);
}

async function openOutlookDraft({ to, subject, body, name }) {
  try {
    await runCommand("osascript", ["-e", OUTLOOK_SCRIPT, to, subject, body, name || ""]);
  } catch (err) {
    console.error("Outlook did not take the draft directly:", err?.message || err);
    const mailto = `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    await runCommand("open", ["-b", "com.microsoft.Outlook", mailto]);
  }
}

function cleanMailAddress(value) {
  const address = typeof value === "string" ? value.trim() : "";
  if (!address) return "";
  if (!/^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i.test(address)) return "";
  return address;
}

/** Package token counts and the dollar price for this one chat. */
function usageEvent(model, reasoning, usage) {
  const priced = priceForUsage(model, usage);
  return {
    type: "usage",
    model: model.id,
    reasoning,
    ...priced,
  };
}

function folderState() {
  return {
    folders: folders.map((folderPath) => ({
      path: folderPath,
      name: path.basename(folderPath),
      selected: selected.includes(folderPath),
      hasCode: Boolean(codePresent.get(folderPath)),
    })),
    selected,
    notes: notes.length,
    instructions: voiceInstructions(),
  };
}

/**
 * A notes folder must be your home folder, something inside it, or a folder on an
 * external drive (/Volumes/...). OneDrive lives inside home, so the folders you
 * already use still load. System folders such as /etc are refused.
 */
function isAllowedPlace(folderPath) {
  const home = path.resolve(os.homedir());
  const relHome = path.relative(home, folderPath);
  if (relHome === "" || (!relHome.startsWith("..") && !path.isAbsolute(relHome))) return true;
  const relVol = path.relative("/Volumes", folderPath);
  return relVol !== "" && !relVol.startsWith("..") && !path.isAbsolute(relVol);
}

function hasBlockedPart(folderPath) {
  const blocked = new Set([".ssh", ".aws", ".gnupg", ".kube"]);
  return String(folderPath).split(path.sep).some((part) => blocked.has(part));
}

/** True when the folder exists and both the path and its real location are allowed. */
function folderIsAllowed(folderPath) {
  const resolved = path.resolve(String(folderPath || ""));
  if (!isAllowedPlace(resolved) || hasBlockedPart(resolved)) return false;
  try {
    const real = fsSync.realpathSync(resolved);
    return isAllowedPlace(real) && !hasBlockedPart(real);
  } catch {
    return false;
  }
}

/** Saved list: keep a path under home even if the drive is still waking up. */
function savedFolderOk(folderPath) {
  const resolved = path.resolve(String(folderPath || ""));
  if (!isAllowedPlace(resolved) || hasBlockedPart(resolved)) return false;
  try {
    const real = fsSync.realpathSync(resolved);
    return isAllowedPlace(real) && !hasBlockedPart(real);
  } catch {
    return true;
  }
}

/** Hide key-shaped text in logs and error lines. OpenAI and Claude are still called. */
function redactSecrets(text) {
  return String(text || "")
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-hidden")
    .replace(/AIza[0-9A-Za-z_-]{10,}/g, "AIza-hidden")
    .replace(/apikey_[A-Za-z0-9_]+/g, "apikey-hidden");
}

function readSavedFolders() {
  try {
    const data = JSON.parse(fsSync.readFileSync(FOLDERS_FILE, "utf8"));
    const saved = Array.isArray(data.folders)
      ? data.folders.filter((item) => typeof item === "string" && savedFolderOk(item))
      : [];
    folders = saved.length ? saved : [WIKI_PATH];
    if (Array.isArray(data.selected)) {
      selected = data.selected.filter((item) => folders.includes(item));
    } else if (data.active === "all") {
      selected = [...folders];
    } else if (typeof data.active === "string" && folders.includes(data.active)) {
      selected = [data.active];
    } else {
      selected = [folders[0]];
    }
  } catch {
    folders = [WIKI_PATH];
    selected = [WIKI_PATH];
  }
}

function saveFolders() {
  fsSync.writeFileSync(FOLDERS_FILE, JSON.stringify({ folders, selected }, null, 2));
}

async function readCode(folderPath) {
  try {
    const text = await fs.readFile(path.join(folderPath, "code.md"), "utf8");
    return text.trim().slice(0, 8000);
  } catch {
    return "";
  }
}

async function folderHasCode(folderPath) {
  try {
    await fs.access(path.join(folderPath, "code.md"));
    return true;
  } catch {
    return false;
  }
}

/** The rulebook the model must follow for every folder it is using. */
function guideBlock() {
  if (!selected.length) return "No second-brain folder is selected.";
  return selected
    .map((folderPath) => {
      const name = path.basename(folderPath);
      const guide = guides.get(folderPath) || "";
      if (!guide) {
        return `Folder ${name} has no code.md. Treat its notes as a normal wiki.`;
      }
      return [
        `You landed in ${name}.`,
        "Read and follow this code.md. It explains how this second brain works:",
        guide,
      ].join("\n");
    })
    .join("\n\n");
}

// What Tiny, the character on the page, says while doing a move the user asked for.
const TINY_LINES = {
  dancing: "Sure, watch this.",
  hand_wave: "Hello there!",
  coffeedrink: "Coffee break. Don't mind if I do.",
  bobbateadrink: "Bubble tea time.",
  celebration: "Woohoo! Let's celebrate.",
};

function voiceInstructions() {
  return [
    "On the screen you are Tiny, a small cartoon character. When the user asks you to dance, wave, drink coffee or bubble tea, or celebrate, the screen shows Tiny doing it. Say yes in a few words. Do not say you have no body.",
    "You are the user's second brain, in a live voice call.",
    "His to-dos are all in wiki/todo.md. He may call that file to-do dot md or Todoist. Todoist is this file, not the Todoist app.",
    "wiki/index.md is the index of all wiki pages. He may call that file index dot md.",
    "wiki/log.md is the history of the wiki. He may call that file logs dot md. There is no separate logs.md.",
    "Notes can also be PDF and Word files. search_notes finds those too.",
    "When he asks you to find a file, call search_notes. That search reads the index and logs dot md. Look carefully at both before you say the file is missing.",
    "Stay silent unless the user's words start with Hey. Otherwise do not speak.",
    "You can hear the user through the microphone. Never say you cannot hear audio.",
    "Finish each reply. Do not stop mid-sentence.",
    "The voice reads every word literally. Say full month names and say the time in words, such as nine eleven in the evening.",
    "Whenever a folder is in use, follow its code.md. Those rulebooks are included below.",
    "When the user asks the time, the date, or where they are, call here_and_now. Say the words that tool returns.",
    "When the user asks about their work, people, projects, or tasks, call search_notes first.",
    "Answer those questions only from the notes the tool returns and from the code.md rulebooks.",
    "If the notes do not contain the answer, say you could not find it in the notes.",
    "For a simple check like can you hear me, just confirm that you can hear them.",
    "In this live call you can only search notes and tell the time. The app can also text his phone, save memos and rules, open files, show a web page, draft emails, and open meetings in Outlook, but only in the regular voice mode. If he asks for one of those, say so and ask him to switch modes. Never say the app cannot do them.",
    "Follow the things the user asked you to always keep in mind, listed below.",
    "",
    learningsBlock(),
    brainBlock(),
    guideBlock(),
  ].join("\n");
}

// Bumped on every reload, so a slow document read for old folders is dropped.
let notesGeneration = 0;

async function reloadNotes() {
  const generation = ++notesGeneration;
  const loaded = [];
  const nextGuides = new Map();
  const nextPresent = new Map();
  for (const root of folders) {
    nextPresent.set(root, await folderHasCode(root));
  }
  for (const root of selected) {
    loaded.push(...(await loadWiki(root)));
    if (nextPresent.get(root)) nextGuides.set(root, await readCode(root));
  }
  notes = loaded;
  semantic.build(notes).catch((err) => console.error("Failed while building the meaning index:", err?.message || err));
  guides = nextGuides;
  codePresent = nextPresent;
  await indexRawMail();
  syncSuggestions();
  console.log(`Loaded ${notes.length} notes from ${selected.length} folder(s)`);
  // PDFs and Word files can take minutes the first time, so they join the notes in the background.
  addDocuments(generation, [...selected]).catch((err) => console.error("Failed while reading PDF and Word files:", err?.message || err));
}

async function addDocuments(generation, roots) {
  const docs = [];
  for (const root of roots) docs.push(...(await loadDocs(root, SKIP_DIRS)));
  if (generation !== notesGeneration || !docs.length) return;
  notes = [...notes, ...docs];
  semantic.build(notes).catch((err) => console.error("Failed while building the meaning index:", err?.message || err));
}

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    notes: notes.length,
    wiki: selected,
    defaultModel: DEFAULT_MODEL,
    defaultReasoning: DEFAULT_REASONING,
  });
});

app.get("/here", (_req, res) => {
  res.json({ text: hereAndNow() });
});

app.get("/models", (_req, res) => {
  res.json({ models: [...VOICE_MODELS, ...MODELS], reasoning: REASONING_LEVELS });
});

app.get("/folders", (_req, res) => {
  res.json(folderState());
});

app.post("/folders", async (req, res) => {
  const folderPath = typeof req.body?.path === "string" ? req.body.path.trim() : "";
  try {
    const stat = await fs.stat(folderPath);
    if (!stat.isDirectory()) {
      return res.status(400).json({ error: "That path is not a folder." });
    }
  } catch (err) {
    console.error("Failed while checking a folder:", err?.message || err);
    return res.status(400).json({ error: "That folder was not found. Paste the full path." });
  }
  if (!folderIsAllowed(folderPath)) {
    return res.status(400).json({ error: "Pick a folder inside your home folder." });
  }
  if (!folders.includes(folderPath)) folders.push(folderPath);
  if (!selected.includes(folderPath)) selected.push(folderPath);
  saveFolders();
  try {
    await reloadNotes();
  } catch (err) {
    console.error("Failed while loading the new folder:", err?.message || err);
    return res.status(500).json({ error: "The folder exists, but the notes could not be read." });
  }
  res.json(folderState());
});

app.post("/folders/select", async (req, res) => {
  const paths = Array.isArray(req.body?.paths) ? req.body.paths.filter((item) => typeof item === "string") : [];
  const unknown = paths.filter((item) => !folders.includes(item));
  if (unknown.length) {
    return res.status(400).json({ error: "Add that folder first." });
  }
  selected = paths;
  saveFolders();
  try {
    await reloadNotes();
  } catch (err) {
    console.error("Failed while switching folders:", err?.message || err);
    return res.status(500).json({ error: "Could not read that folder." });
  }
  res.json(folderState());
});

app.post("/folders/remove", async (req, res) => {
  const folderPath = typeof req.body?.path === "string" ? req.body.path : "";
  if (!folders.includes(folderPath)) {
    return res.status(400).json({ error: "That folder is not on the list." });
  }
  folders = folders.filter((item) => item !== folderPath);
  selected = selected.filter((item) => item !== folderPath);
  saveFolders();
  try {
    await reloadNotes();
  } catch (err) {
    console.error("Failed while removing a folder:", err?.message || err);
    return res.status(500).json({ error: "Could not refresh the notes after removing that folder." });
  }
  res.json(folderState());
});

function runCommand(bin, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (err) => {
      reject(err);
    });
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error((stderr || stdout || `${bin} failed`).slice(0, 500)));
    });
  });
}

/** Start the local whisper server once. If it dies, /transcribe falls back to whisper-cli. */
function startWhisperServer(model = LOCAL_VOICE_MODEL, url = WHISPER_SERVER_URL, lang = "en") {
  const port = new URL(url).port;
  const child = spawn(
    WHISPER_SERVER_BIN,
    ["-m", model, "--host", "127.0.0.1", "--port", port, "-l", lang, "-nt", "-bs", "1", "-bo", "1", "-nf", "-t", "4"],
    { stdio: "ignore" }
  );
  child.on("error", (err) => console.error("Failed while starting whisper-server:", err?.message || err));
  child.on("exit", (code) => {
    if (code) console.error(`whisper-server stopped (exit ${code}). Using whisper-cli instead.`);
  });
  process.on("exit", () => child.kill());
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => process.exit(0));
  }
}

/** Start the Kokoro voice once. It takes about 7 seconds to load the model. */
function startKokoro() {
  const child = spawn(KOKORO_PYTHON, [KOKORO_SCRIPT], { stdio: ["ignore", "ignore", "pipe"] });
  child.stderr.on("data", (chunk) => {
    const text = String(chunk).trim();
    if (text) console.error(`Kokoro: ${text.slice(0, 300)}`);
  });
  child.on("error", (err) => console.error("Failed while starting Kokoro:", err?.message || err));
  child.on("exit", (code) => {
    if (code) console.error(`Kokoro stopped (exit ${code}). The page will use the Mac voice instead.`);
  });
  process.on("exit", () => child.kill());
}

/** Start one whisper server and wait until it answers. The model takes a few seconds to load. */
function ensureWhisper(slot, model, url, lang) {
  if (!slot.current) {
    slot.current = (async () => {
      await fs.access(model);
      startWhisperServer(model, url, lang);
      const health = url.replace("/inference", "/");
      for (let i = 0; i < 60; i += 1) {
        try {
          await fetch(health);
          return;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      }
      throw new Error("The voice model did not start.");
    })();
    slot.current.catch(() => { slot.current = null; });
  }
  return slot.current;
}

/** Start the English + Arabic whisper once, and wait until it answers (the model takes a few seconds to load). */
function ensureMultiWhisper() {
  return ensureWhisper({ get current() { return multiWhisperUp; }, set current(value) { multiWhisperUp = value; } }, MULTI_VOICE_MODEL, WHISPER_MULTI_URL, "auto");
}

/** Start the Arabic-only whisper once. It is a second listener, not a replacement for the English one. */
function ensureArabicWhisper() {
  return ensureWhisper({ get current() { return arabicWhisperUp; }, set current(value) { arabicWhisperUp = value; } }, MULTI_VOICE_MODEL, WHISPER_AR_URL, "ar");
}

// "Hey" as the English model writes it, including an Arabic accent (hay, hi, hei).
const WAKE_HEARD = /^[\s"'“”]*(hey|hay|hei|hi)\b/i;
// The wake word written in Arabic letters, or still in English, at the start of the Arabic text.
const ARABIC_WAKE = /^[\s"'“”]*(?:هاي|هاى|هي|هيه|هاي|اي|hey|hay|hi)[\s,.:;!?،\-]*/i;

/** One clip to text. auto = the English + Arabic model; otherwise the fast English one. */
async function whisperText(wav, auto) {
  const text = (await transcribeWithServer(wav, auto ? WHISPER_MULTI_URL : WHISPER_SERVER_URL)) ?? await runCommand(WHISPER_BIN, [
    "-m", auto ? MULTI_VOICE_MODEL : LOCAL_VOICE_MODEL,
    "-f", wav,
    "-l", auto ? "auto" : "en",
    "-nt",
    "-np",
    "-bs", "1",
    "-bo", "1",
    "-nf",
    "-t", "4",
  ]);
  return text.replace(/\s+/g, " ").trim();
}

/** The Arabic listener. Same kind of model as the big one, but it is told the speech is Arabic. */
async function whisperArabic(wav) {
  const text = (await transcribeWithServer(wav, WHISPER_AR_URL)) ?? await runCommand(WHISPER_BIN, [
    "-m", MULTI_VOICE_MODEL,
    "-f", wav,
    "-l", "ar",
    "-nt",
    "-np",
    "-bs", "1",
    "-bo", "1",
    "-nf",
    "-t", "4",
  ]);
  return text.replace(/\s+/g, " ").trim();
}

/** Whisper writes these on a quiet room. They are not speech. */
function whisperJunk(text) {
  const raw = String(text || "").trim();
  if (/^\([^)]*\)$/.test(raw) || /^\[[^\]]*\]$/.test(raw)) return true;
  const cleaned = raw.toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, "").trim();
  if (cleaned.length < 2) return true;
  if (["thank you", "thanks for watching", "you", "bye", "silence", "music", "blank audio"].includes(cleaned)) return true;
  // Arabic YouTube-style captions the model invents when the speech was English.
  const arabic = raw.normalize("NFKD").replace(/\p{M}/gu, "").replace(/[^\p{L}\p{N}\s]/gu, "").replace(/\s+/g, " ").trim();
  return ["شكرا للمشاهدة", "المترجم للقناة", "اشتركوا في القناة", "ترجمة نانسي قنقر"].includes(arabic);
}

/** Put the English line and the Arabic line one under the other. */
function combineLanguages(english, arabic) {
  const en = whisperJunk(english) ? "" : String(english || "").trim();
  const ar = whisperJunk(arabic) ? "" : String(arabic || "").trim();
  const lines = [];
  if (en) lines.push(`English: ${en}`);
  if (ar) lines.push(`Arabic: ${ar}`);
  return {
    text: lines.join("\n"),
    english: en,
    arabic: ar,
    language: en && ar ? "both" : ar ? "ar" : "en",
  };
}

/** Ask the warm whisper server. Returns null if it is not up, so the caller can use whisper-cli. */
async function transcribeWithServer(wav, url = WHISPER_SERVER_URL) {
  try {
    const fd = new FormData();
    fd.set("file", new Blob([await fs.readFile(wav)], { type: "audio/wav" }), "clip.wav");
    fd.set("response_format", "json");
    const response = await fetch(url, { method: "POST", body: fd });
    if (!response.ok) throw new Error(`whisper-server returned ${response.status}`);
    const data = await response.json();
    return data.text || "";
  } catch (err) {
    console.error("Failed while using whisper-server, falling back to whisper-cli:", err?.message || err);
    return null;
  }
}

/**
 * Local listening. The small voice model on this Mac writes down the words.
 * Nothing is sent to OpenAI for this step.
 */
app.post(
  "/transcribe",
  express.raw({ type: ["audio/*", "application/octet-stream", "video/webm"], limit: "20mb" }),
  async (req, res) => {
    if (!req.body || !req.body.length) {
      return res.status(400).json({ error: "No audio was sent." });
    }
    // ?lang=auto: "Hey" in English starts the question; the question itself may be English or Arabic.
    // ?lang=any: hear the whole clip in whichever language was spoken. No Hey needed.
    // ?lang=both: the English whisper and the Arabic whisper both listen, and both lines come back.
    const auto = req.query.lang === "auto";
    const hearAny = req.query.lang === "any";
    const hearBoth = req.query.lang === "both";
    const dir = path.join(__dirname, "tmp");
    const stamp = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
    const source = path.join(dir, `${stamp}.webm`);
    const wav = path.join(dir, `${stamp}.wav`);
    try {
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(source, req.body);
      await runCommand(FFMPEG_BIN, ["-y", "-loglevel", "error", "-i", source, "-ac", "1", "-ar", "16000", wav]);
      let text = "";
      let language = "en";
      if (hearBoth) {
        // Two listeners at once. The English one is already running. The Arabic one starts on first use.
        try {
          await ensureArabicWhisper();
        } catch (err) {
          console.error("Failed while starting the Arabic whisper:", err?.message || err);
          return res.status(503).json({ error: "The Arabic voice model is not installed." });
        }
        const [english, arabic] = await Promise.all([whisperText(wav, false), whisperArabic(wav)]);
        const combined = combineLanguages(english, arabic);
        text = combined.text;
        language = combined.language;
      } else if (hearAny) {
        // Medical speech may be Arabic with no Hey. The English-only model would miss it.
        try {
          await ensureMultiWhisper();
        } catch (err) {
          console.error("Failed while starting the English + Arabic whisper:", err?.message || err);
          return res.status(503).json({ error: "The English + Arabic voice model is not installed." });
        }
        text = await whisperText(wav, true);
        if (/[\u0600-\u06FF]/.test(text)) language = "ar";
      } else {
        // The fast English model always listens first. It hears an Arabic-accented "hey" as hay or hi.
        const english = await whisperText(wav, false);
        text = english;
        if (auto && WAKE_HEARD.test(english)) {
          // Wake word found: now write the whole clip in whichever language was spoken.
          try {
            await ensureMultiWhisper();
          } catch (err) {
            console.error("Failed while starting the English + Arabic whisper:", err?.message || err);
            return res.status(503).json({ error: "The English + Arabic voice model is not installed." });
          }
          const heard = await whisperText(wav, true);
          // Whisper may write the wake word as هاي or Hi. The page looks for "Hey", so put that back.
          text = `Hey ${heard.replace(ARABIC_WAKE, "")}`;
          if (/[\u0600-\u06FF]/.test(heard)) language = "ar";
        }
      }
      const mode = hearBoth ? "both" : hearAny ? "any" : auto ? "auto" : "english";
      console.log(`Transcribed (${mode}): ${language}, ${text.length} chars, wake ${WAKE_HEARD.test(text) ? "yes" : "no"}`);
      res.json({ text, language });
    } catch (err) {
      console.error("Failed while transcribing locally:", err?.message || err);
      res.status(500).json({ error: "The local voice model could not hear that clip." });
    } finally {
      await fs.rm(source, { force: true }).catch(() => {});
      await fs.rm(wav, { force: true }).catch(() => {});
    }
  }
);

/** Load the English + Arabic whisper now, so the first medical clip is not a cold start. */
app.post("/transcribe/warm", (req, res) => {
  const start = req.query.lang === "both" ? ensureArabicWhisper() : ensureMultiWhisper();
  start.catch((err) => console.error("Failed while loading a whisper:", err?.message || err));
  res.json({ ok: true });
});

/** Turn one piece of the answer into speech with Kokoro, on this Mac. */
app.post("/speak", async (req, res) => {
  const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
  if (!text) return res.status(400).json({ error: "No text to speak." });
  try {
    const upstream = await fetch(`${KOKORO_URL}/speak`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!upstream.ok) throw new Error(`Kokoro returned ${upstream.status}`);
    res.type("audio/wav").send(Buffer.from(await upstream.arrayBuffer()));
  } catch (err) {
    console.error("Failed while speaking with Kokoro:", err?.message || err);
    res.status(503).json({ error: "The Kokoro voice is not ready." });
  }
});

app.get("/notes", async (req, res) => {
  const query = typeof req.query.q === "string" ? req.query.q.trim() : "";
  if (!query) return res.json({ notes: "No question to search." });
  const hits = await notesForQuestion(query, 5);
  if (!hits.length) return res.json({ notes: "No matching notes." });
  const notesText = hits
    .map((hit) => {
      const body = hit.override || excerpt(hit.note.text, hit.terms, 1200);
      return `Note: ${hit.note.title}\nFile: ${hit.note.rel}\n${body}`;
    })
    .join("\n\n---\n\n");
  res.json({ notes: notesText });
});

/**
 * Live voice session. Same model as Nemo: gpt-realtime-2.1-mini.
 * It receives microphone audio, so it can hear the user.
 */
// Gemini has its own voices. Pick the closest one to the voice chosen on the page.
const GEMINI_VOICES = { marin: "Aoede", cedar: "Charon", alloy: "Puck", ash: "Orus", coral: "Kore", sage: "Leda" };

/**
 * Gemini Live: mint a short-lived Google token so the browser can open the
 * voice line itself. The GEMINI_API_KEY never leaves this server.
 * The token is locked to one session, this model, and this setup.
 */
app.post("/gemini-session", async (req, res) => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "Missing GEMINI_API_KEY. Add it to the .env file." });
  const model = getAnyModel(req.query.model);
  if (!model?.gemini) return res.status(400).json({ error: "That is not a Gemini Live model." });

  const setup = {
    model: `models/${model.id}`,
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: GEMINI_VOICES[req.query.voice] || "Aoede" } } },
    },
    // Gemini answers every turn; the Hey rule would only make it go quiet.
    systemInstruction: { parts: [{ text: voiceInstructions().replace(/^Stay silent unless.*\n/m, "") }] },
    tools: [{
      functionDeclarations: [
        {
          name: "here_and_now",
          description: "Read this Mac's clock. Returns the current time and place in words the voice can say.",
        },
        {
          name: "search_notes",
          description: "Search the user's second-brain notes. When he asks to find a file, this also reads wiki/index.md and wiki/log.md and returns the matching lines.",
          parameters: {
            type: "OBJECT",
            properties: { query: { type: "STRING", description: "What to look up in the notes, in a few words." } },
            required: ["query"],
          },
        },
      ],
    }],
    inputAudioTranscription: {},
    outputAudioTranscription: {},
  };
  const now = Date.now();
  try {
    const response = await fetch("https://generativelanguage.googleapis.com/v1beta/auth_tokens", {
      method: "POST",
      headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        uses: 1,
        expireTime: new Date(now + 30 * 60_000).toISOString(),
        newSessionExpireTime: new Date(now + 2 * 60_000).toISOString(),
      }),
    });
    const data = await response.json();
    if (!response.ok) {
      const geminiError = redactSecrets(data.error?.message || "Gemini refused the token.");
      console.error("Gemini refused the token:", geminiError);
      return res.status(502).json({ error: geminiError });
    }
    res.json({ token: data.name, setup });
  } catch (err) {
    console.error("Failed while minting a Gemini token:", err?.message || err);
    res.status(502).json({ error: "Could not reach Gemini." });
  }
});

/**
 * Remote control for the voice page.
 * Hammerspoon's Cmd+Opt+S posts /control/stop (stop the answer).
 * Hammerspoon's Command and Control together posts /control/listen (start listening, like saying Hey).
 * Every open voice page hears these on /control.
 */
const controlClients = new Set();
app.get("/control", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.flushHeaders?.();
  controlClients.add(res);
  req.on("close", () => controlClients.delete(res));
});
function sendControl(event, data = {}) {
  for (const client of controlClients) client.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

app.post("/control/stop", (_req, res) => {
  for (const client of controlClients) client.write("event: stop\ndata: {}\n\n");
  res.json({ ok: true, pages: controlClients.size });
});

app.post("/control/listen", (_req, res) => {
  sendControl("listen");
  res.json({ ok: true, pages: controlClients.size });
});

/**
 * Medical speech (medgem.js). GPT-OSS 20B on this Mac turns a transcript into
 * English medical words with identifiers removed. It does not answer.
 * A question, when there is one, is forwarded to the brain by the page.
 */
app.post("/medgem/warm", (_req, res) => {
  warmMedgem().catch((err) => console.error("Failed while loading GPT-OSS:", err?.message || err));
  res.json({ ok: true });
});
app.post("/medgem/clean", async (req, res) => {
  const text = typeof req.body?.text === "string" ? req.body.text.trim().slice(0, 4000) : "";
  if (!text) return res.status(400).json({ error: "No words to clean." });
  try {
    res.json(await cleanMedical(text));
  } catch (err) {
    console.error("Failed while cleaning medical speech:", err?.message || err);
    res.status(502).json({ error: "GPT-OSS could not clean that." });
  }
});

/** Jev listening: is this heard sentence meant for the second brain? (jev.js) */
app.post("/jev/warm", (_req, res) => {
  warmJudge().catch((err) => console.error("Failed while loading the judge model:", err?.message || err));
  res.json({ ok: true });
});
app.post("/jev/judge", async (req, res) => {
  const latest = typeof req.body?.latest === "string" ? req.body.latest.trim().slice(0, 1000) : "";
  if (!latest) return res.status(400).json({ error: "No words to judge." });
  try {
    res.json(await judgeSpeech({
      latest,
      earlier: Array.isArray(req.body.earlier) ? req.body.earlier.filter((t) => typeof t === "string").map((t) => t.slice(0, 300)) : [],
      lastAnswer: typeof req.body.lastAnswer === "string" ? req.body.lastAnswer : "",
      justAnswered: Boolean(req.body.justAnswered),
      backend: ["gemma", "typesafe"].includes(req.body.backend) ? req.body.backend : undefined,
    }));
  } catch (err) {
    console.error("Failed while asking Jev:", err?.message || err);
    res.status(502).json({ error: "Jev could not judge that sentence." });
  }
});

app.post("/session", async (req, res) => {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error: "Missing OPENAI_API_KEY. Add it to the .env file in the project folder.",
    });
  }

  const sdp = req.body;
  if (!sdp || typeof sdp !== "string" || !sdp.includes("v=0")) {
    return res.status(400).json({ error: "Expected an SDP offer in the request body." });
  }

  const voice = typeof req.query.voice === "string" ? req.query.voice : DEFAULT_VOICE;
  const speakOnly = req.query.speak === "1";
  const chosen = getAnyModel(req.query.model) || getAnyModel(VOICE_MODEL);
  let reasoning = typeof req.query.reasoning === "string" ? req.query.reasoning : chosen.reasoning[0];
  if (!chosen.reasoning.includes(reasoning)) reasoning = chosen.reasoning[0];

  // A GPT-6 model never sits on the live voice line.
  // Listening is the local model on this Mac.
  // This session is only the voice-control model reading the answer aloud.
  const ears = speakOnly || !chosen.hears ? getAnyModel(VOICE_MODEL) : chosen;

  const sessionConfig = {
    type: "realtime",
    model: ears.id,
    output_modalities: ["audio"],
    instructions: speakOnly || !chosen.hears
      ? "Speak only the script you are given. Do not add anything. Do not answer on your own."
      : voiceInstructions(),
    tools: speakOnly ? undefined : [
      {
        type: "function",
        name: "here_and_now",
        description: "Read this Mac's clock. Returns the current time and place in words the voice can say.",
        parameters: { type: "object", properties: {} },
      },
      {
        type: "function",
        name: "search_notes",
        description: "Search the user's second-brain wiki. When he asks to find a file, this also reads wiki/index.md and wiki/log.md (logs dot md) and returns the matching lines.",
        parameters: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "What to look up in the notes, in a few words.",
            },
          },
          required: ["query"],
        },
      },
    ],
    audio: {
      input: {
        turn_detection: {
          type: "semantic_vad",
          // Low eagerness so the speaker's own voice does not cut the reply off.
          eagerness: "low",
          interrupt_response: !speakOnly,
          // The page decides when to answer. It only does that after "Hey".
          create_response: false,
        },
        transcription: {
          model: "gpt-4o-mini-transcribe",
        },
      },
      output: { voice },
    },
  };
  if (speakOnly) delete sessionConfig.tools;
  if (chosen.hears && !speakOnly && reasoning !== "none") sessionConfig.reasoning = { effort: reasoning };

  try {
    const fd = new FormData();
    fd.set("sdp", sdp);
    fd.set("session", JSON.stringify(sessionConfig));
    const safetyId = crypto
      .createHash("sha256")
      .update(`brain-voice-${apiKey.slice(-8)}`)
      .digest("hex")
      .slice(0, 32);

    const upstream = await fetch("https://api.openai.com/v1/realtime/calls", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "OpenAI-Safety-Identifier": safetyId,
      },
      body: fd,
    });
    const answerSdp = await upstream.text();
    if (!upstream.ok) {
      // Logged here, not sent to the browser. The voice call to OpenAI still happens.
      console.error("OpenAI voice session failed:", upstream.status, redactSecrets(answerSdp));
      return res.status(upstream.status).json({
        error: "OpenAI voice session failed",
        status: upstream.status,
      });
    }
    res.type("application/sdp").send(answerSdp);
  } catch (err) {
    const reason = err?.cause?.message || err?.message || String(err);
    console.error("Failed while starting the voice session:", redactSecrets(reason));
    res.status(500).json({ error: "Could not reach OpenAI." });
  }
});

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function ollamaNamesMatch(runningName, modelId) {
  const name = String(runningName || "").toLowerCase();
  const want = String(modelId || "").toLowerCase();
  if (!name || !want) return false;
  return name === want || name.startsWith(`${want}:`) || want.startsWith(`${name}:`);
}

async function ollamaLoadedModels() {
  const response = await fetch(`${OLLAMA_URL}/api/ps`);
  if (!response.ok) return [];
  const data = await response.json();
  return Array.isArray(data.models) ? data.models : [];
}

/** Tell Ollama to drop a local model so it no longer uses memory. */
async function stopOllamaModel(modelId) {
  const running = await ollamaLoadedModels();
  const hit = running.find((item) => ollamaNamesMatch(item.name || item.model, modelId));
  if (!hit) return { stopped: false, wasLoaded: false };
  const name = hit.name || hit.model || modelId;
  const response = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: name, keep_alive: 0 }),
  });
  if (!response.ok) {
    const details = await response.text();
    console.error("Failed while stopping a local model:", response.status, details);
    throw new Error("Ollama could not stop the previous model.");
  }
  await response.text();
  if (loadedLocalId && ollamaNamesMatch(loadedLocalId, modelId)) loadedLocalId = "";
  return { stopped: true, wasLoaded: true, name };
}

/** Drop every model Ollama still has loaded, so none of them keep using memory. */
async function stopAllOllamaModels() {
  const running = await ollamaLoadedModels();
  const stopped = [];
  for (const item of running) {
    const name = item.name || item.model;
    if (!name) continue;
    try {
      const result = await stopOllamaModel(name);
      if (result.stopped) stopped.push(result.name || name);
    } catch (err) {
      console.error(`Failed while stopping ${name}:`, err?.message || err);
    }
  }
  loadedLocalId = "";
  return { stopped };
}

app.post("/stop-models", async (_req, res) => {
  try {
    res.json(await stopAllOllamaModels());
  } catch (err) {
    console.error("Failed while stopping local models:", err?.message || err);
    res.status(502).json({ error: err?.message || "Could not stop the local models." });
  }
});

app.post("/stop-model", async (req, res) => {
  const id = typeof req.body?.model === "string" ? req.body.model.trim() : "";
  const model = getModel(id);
  if (!model?.local) return res.json({ stopped: false, wasLoaded: false });
  try {
    const result = await stopOllamaModel(model.id);
    res.json({ ...result, label: model.label });
  } catch (err) {
    console.error("Failed while stopping a local model:", err?.message || err);
    res.status(502).json({ error: err?.message || "Could not stop the previous model." });
  }
});

app.post("/compress", async (req, res) => {
  const history = cleanHistory(req.body?.history);
  const prior = cleanMemory(req.body?.memory);
  if (!history.length && !prior) return res.json({ memory: "" });

  const model = getModel(MEMORY_MODEL);
  const source = [
    prior ? `Older memory:\n${prior}` : "",
    ...history.map((turn) => `User asked: ${turn.question}\nAnswered: ${turn.answer}`),
  ].filter(Boolean).join("\n\n");

  try {
    const controller = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) controller.abort();
    });
    const upstream = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model: model.id,
        stream: false,
        think: false,
        messages: [
          {
            role: "system",
            content: [
              "Compress this voice chat into a short memory for the next question.",
              "Keep every user question in the user's exact words, each on its own line starting with User asked:",
              "After each question, write one short sentence starting with Answered:",
              "Put the newest question last. Do not add anything that was not said.",
            ].join(" "),
          },
          { role: "user", content: source },
        ],
        keep_alive: "30m",
        options: { num_ctx: 4096, num_predict: 220 },
      }),
    });
    if (!upstream.ok) {
      const details = await upstream.text();
      console.error("Failed while compressing the chat:", upstream.status, details);
      return res.status(502).json({ error: "The local model could not compress the chat." });
    }
    const data = await upstream.json();
    const memory = cleanMemory(data.message?.content || "");
    if (memory) desk.rememberChat(memory, history);
    res.json({ memory });
  } catch (err) {
    if (err?.name === "AbortError") return res.status(499).end();
    console.error("Failed while compressing the chat:", err?.message || err);
    res.status(500).json({ error: "Could not compress the chat." });
  }
});

app.post("/open-outlook", async (req, res) => {
  const to = cleanMailAddress(req.body?.to);
  const name = String(req.body?.name || "").replace(/[\r\n]+/g, " ").trim().slice(0, 80);
  const subject = String(req.body?.subject || "Re: your email").replace(/[\r\n]+/g, " ").trim().slice(0, 200);
  const letter = polishReply(String(req.body?.body || "").replace(/\u0000/g, ""), name);
  const body = replyWithOriginal(letter, req.body?.original).slice(0, 20000);
  if (!body) return res.status(400).json({ error: "There is no reply to open." });
  try {
    await openOutlookDraft({ to, subject, body, name });
    desk.finishLatestEmail("Opened in Outlook. Press Send when it looks right.");
    sendControl("desk", {});
    res.json({ ok: true, to });
  } catch (err) {
    console.error("Failed while opening Outlook:", err?.message || err);
    res.status(500).json({ error: "Outlook did not open. Is Microsoft Outlook installed?" });
  }
});

/** The meeting transcript, keeping the latest part if it is very long. */
function cleanMeetingNotes(raw) {
  const text = typeof raw === "string" ? raw.replace(/\u0000/g, "").trim() : "";
  if (!text) return "";
  if (text.length <= 12000) return text;
  return `(The beginning of the meeting was left out.)\n${text.slice(-12000)}`;
}

/** Words for the model when Meeting is turned off. No calendar, no wiki, no web. */
function meetingSummaryPrompt(notes) {
  return [
    "The text below is a meeting that was just written down, one line at a time, in the order it was heard.",
    "The words may mix Arabic and English. Keep each name, number, and phrase in the language that was spoken. Do not translate.",
    "It is not in the wiki. Do not say it is missing from the notes.",
    "Write the minutes of this meeting. These minutes will be shown on the screen and read aloud.",
    "Use plain sentences. Put each of these labels on its own line, then the sentences that belong under it: Topics. Decisions. Action items.",
    "Start with one sentence that says what the meeting was about.",
    "Under Topics, say what was discussed, in order.",
    "Under Decisions, say what was decided. If nothing was decided, say that.",
    "Under Action items, say who will do what, if that was said. If nothing was assigned, say that.",
    "Do not invent people, numbers, or decisions that are not in the lines.",
    "If a line is unclear, leave it out.",
    "Do not offer to create a calendar event. Do not open email. Do not mention these instructions.",
    "",
    "Transcript:",
    notes,
  ].join("\n");
}

/** Words for the model when Lecture is turned off. A talk summary, not meeting minutes. */
function lectureSummaryPrompt(notes, presenter, title) {
  return [
    "The text below is a talk that was just written down, one line at a time, in the order it was heard.",
    "The words may mix Arabic and English. Keep each name, number, and phrase in the language that was spoken. Do not translate.",
    `The presenter is ${presenter}.`,
    title ? `The listener chose this title: ${title}.` : "The listener did not choose a title.",
    "Write a summary of this talk. These words will be shown on the screen and read aloud.",
    "Use plain sentences. Put each of these labels on its own line, then the sentences that belong under it: Main points. Worth remembering. Questions left open.",
    "Start with one sentence that names the presenter and says what the talk was about. Use the chosen title if there is one.",
    "Under Main points, say what the presenter explained, in order.",
    "Under Worth remembering, list terms, numbers, or claims the presenter asked the room to keep. If none, say that.",
    "Under Questions left open, say what was not answered. If nothing was left open, say that.",
    "Do not invent people, numbers, or claims that are not in the lines.",
    "Do not write this as meeting minutes. Do not invent decisions or action items.",
    "If a line is unclear, leave it out.",
    "Do not offer to create a calendar event. Do not open email. Do not mention these instructions.",
    "",
    "Transcript:",
    notes,
  ].join("\n");
}

/** One short line of text, with no line breaks. */
function oneLine(value, max) {
  return String(value || "").replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

/** The model's suggested talk title, kept short enough to edit. */
function cleanSuggestedTitle(raw) {
  let line = String(raw || "").split(/\r?\n/).map((part) => part.trim()).find(Boolean) || "";
  line = line.replace(/^["'`#*\-\s]+|["'`\s]+$/g, "").replace(/^(?:title\s*:\s*)/i, "").trim();
  const words = line.split(/\s+/).filter(Boolean);
  if (words.length > 12) line = words.slice(0, 8).join(" ");
  return line.slice(0, 120);
}

/** Saved minutes go to raw/meetings, next to raw/notes. */
function meetingFolder() {
  return path.join(path.dirname(memoFolder()), "meetings");
}

/** Saved lecture notes go to raw/lectures, next to raw/meetings. */
function lectureFolder() {
  return path.join(path.dirname(memoFolder()), "lectures");
}

/** The Outlook event that overlaps the meeting the most, or null. */
function calendarMeetingAt(start, end) {
  let events;
  try {
    events = loadOutlookCalendar().events;
  } catch (err) {
    console.error("Failed while reading the Outlook calendar for the minutes:", err?.message || err);
    return null;
  }
  let best = null;
  let bestOverlap = 0;
  for (const event of events) {
    if (event.allDay) continue;
    // A meeting often starts a few minutes late or runs over.
    const overlap = Math.min(end, event.end.getTime() + 15 * 60000) - Math.max(start, event.start.getTime() - 15 * 60000);
    if (overlap > bestOverlap) {
      best = event;
      bestOverlap = overlap;
    }
  }
  return best;
}

const CALENDAR_HELPER = path.join(__dirname, "..", "voice", "calendar-attendees", "calendar-attendees");

/**
 * The calendar invite that overlaps the meeting the most, with the invitees, or null.
 * Read from macOS Calendar, which holds the Exchange account. Outlook's own file has no invitees.
 */
async function calendarInviteAt(start, end) {
  if (!fsSync.existsSync(CALENDAR_HELPER)) return null;
  try {
    // 15 minutes either side, because a meeting often starts late or runs over.
    const out = await Promise.race([
      runCommand(CALENDAR_HELPER, [String(start - 15 * 60000), String(end + 15 * 60000)]),
      new Promise((_, reject) => setTimeout(() => reject(new Error("The calendar helper took too long.")), 8000)),
    ]);
    const data = JSON.parse(out);
    if (data.error) throw new Error(`Calendar said ${data.error}. Allow it in Privacy & Security, Calendars.`);
    let best = null;
    let bestOverlap = 0;
    for (const event of data.events || []) {
      const overlap = Math.min(end, event.end + 15 * 60000) - Math.max(start, event.start - 15 * 60000);
      if (overlap > bestOverlap) {
        best = event;
        bestOverlap = overlap;
      }
    }
    if (!best) return null;
    const names = [best.organizer, ...(best.attendees || [])].map((name) => String(name || "").trim()).filter(Boolean);
    return { subject: String(best.title || "").trim(), attendees: [...new Set(names)] };
  } catch (err) {
    console.error("Failed while reading the calendar invite:", err?.message || err);
    return null;
  }
}

/** Read "TITLE:", "ATTENDEES:", and "MINUTES:" out of the model's answer. */
function parseMinutesHeader(raw) {
  const title = raw.match(/^\s*TITLE:\s*(.+)$/im)?.[1]?.trim() || "";
  const people = raw.match(/^\s*ATTENDEES:\s*(.+)$/im)?.[1]?.trim() || "";
  const minutes = raw.match(/^\s*MINUTES:\s*\n?([\s\S]*)$/im)?.[1]?.trim() || "";
  const attendees = /^(?:none|unknown|not known|n\/a|-)\.?$/i.test(people)
    ? []
    : people.split(/[,;]/).map((name) => name.trim()).filter(Boolean);
  return { title: title.replace(/^["'#\s]+|["'\s]+$/g, ""), attendees, minutes };
}

function minutesClock(date) {
  return date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

/** JPEG photos sent from the camera, at most eight, each under about 900 KB. */
function jpegPhotos(raw) {
  if (!Array.isArray(raw)) return [];
  const photos = [];
  for (const item of raw.slice(0, 8)) {
    const data = typeof item === "string" ? item : "";
    const match = data.match(/^data:image\/jpeg;base64,([A-Za-z0-9+/=\r\n]+)$/);
    if (!match) continue;
    const bytes = Buffer.from(match[1], "base64");
    if (bytes.length < 80 || bytes.length > 900_000) continue;
    if (bytes[0] !== 0xff || bytes[1] !== 0xd8) continue;
    photos.push(bytes);
  }
  return photos;
}

/** One JPEG from a question, or "" when it is missing or not a real JPEG. */
function photoDataUrl(raw) {
  const photos = jpegPhotos([raw]);
  if (!photos.length) return "";
  const match = String(raw).match(/^data:image\/jpeg;base64,[A-Za-z0-9+/=\r\n]+$/);
  return match ? match[0] : "";
}

/**
 * Save camera photos beside the notes and add a Photos section.
 * `stem` is the notes file name without .md, so the pictures sort next to it.
 */
async function withPhotos(text, folder, stem, raw) {
  const photos = jpegPhotos(raw);
  if (!photos.length) return { text, count: 0 };
  const lines = ["## Photos", ""];
  for (let i = 0; i < photos.length; i += 1) {
    const file = `${stem}-${i + 1}.jpg`;
    await fs.writeFile(path.join(folder, file), photos[i]);
    lines.push(`![Photo ${i + 1}](${file})`, "");
  }
  return { text: `${String(text).trimEnd()}\n\n${lines.join("\n")}`, count: photos.length };
}

/** The minutes as a Markdown file: date, time, title, and attendees first. */
function minutesMarkdown({ title, titleFrom, attendees, start, end, minutes }) {
  const day = start.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  return [
    `# ${title}`,
    "",
    `- **Date:** ${day}`,
    `- **Time:** ${minutesClock(start)} to ${minutesClock(end)}`,
    `- **Title:** ${titleFrom}`,
    `- **Attendees:** ${attendees.length ? attendees.join(", ") : "Not known"}`,
    "",
    "## Minutes",
    "",
    minutes,
    "",
  ].join("\n");
}

/**
 * Save the minutes of the meeting that just ended.
 * The title and invitees come from the calendar invite at that time.
 * Without one, the title comes from Outlook or the model, and attendees are the names said in the meeting.
 */
app.post("/meeting/save", async (req, res) => {
  const notes = cleanMeetingNotes(req.body?.lines);
  if (!notes) return res.status(400).json({ error: "There are no meeting words to save." });
  const start = new Date(Number(req.body?.startedAt) || Date.now());
  const end = new Date(Number(req.body?.endedAt) || Date.now());
  let minutes = typeof req.body?.minutes === "string" ? req.body.minutes.trim() : "";

  let folder = meetingFolder();
  if (typeof req.body?.folder === "string" && req.body.folder.trim()) {
    folder = path.resolve(req.body.folder.trim());
    if (!fsSync.existsSync(folder) || !fsSync.statSync(folder).isDirectory()) {
      return res.status(400).json({ error: "That folder does not exist." });
    }
    if (!folderIsAllowed(folder)) {
      return res.status(400).json({ error: "Pick a folder inside your home folder." });
    }
  }

  const invite = await calendarInviteAt(start.getTime(), end.getTime());
  const event = invite?.subject ? invite : calendarMeetingAt(start.getTime(), end.getTime());
  const model = getModel(req.body?.model) || getModel(DEFAULT_MODEL);
  const instruction = [
    "You are given the transcript of a meeting, written down one line at a time. Arabic and English may be mixed.",
    event ? "" : "TITLE: write a short title for the meeting, at most eight words, from what was discussed.",
    "ATTENDEES: list the names of people who spoke or were spoken to by name, separated by commas. Do not list people who were only mentioned. Write None if no names were said. Do not invent names.",
    minutes
      ? ""
      : "MINUTES: write the minutes in Markdown with the headings ### Topics, ### Decisions, and ### Action items. Do not invent people, numbers, or decisions.",
    "Answer with only these labels, each at the start of its own line, in this order.",
  ].filter(Boolean).join("\n");
  let parsed = { title: "", attendees: [], minutes: "" };
  try {
    parsed = parseMinutesHeader(await askModelOnce(model, instruction, `Transcript:\n${notes}`, process.env.OPENAI_API_KEY, minutes ? 200 : 1500));
  } catch (err) {
    console.error("Failed while naming the meeting:", err?.message || err);
  }
  minutes ||= parsed.minutes || "The minutes could not be written.";
  const title = (event?.subject || parsed.title || "Meeting").slice(0, 120);
  const titleFrom = event ? "From the calendar" : parsed.title ? "Assigned from the discussion" : "Not known";
  // Invitees from the calendar come first. Otherwise, the names that were said.
  const attendees = invite?.attendees?.length ? invite.attendees : parsed.attendees;
  const text = minutesMarkdown({ title, titleFrom, attendees, start, end, minutes });

  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "meeting";
  const name = `${memoStamp(start)}-${slug}.md`;
  let savedText = text;
  let photoCount = 0;
  try {
    await fs.mkdir(folder, { recursive: true });
    const packed = await withPhotos(text, folder, name.replace(/\.md$/i, ""), req.body?.photos);
    savedText = packed.text;
    photoCount = packed.count;
    await fs.writeFile(path.join(folder, name), savedText, "utf8");
  } catch (err) {
    console.error("Failed while saving the minutes:", err?.message || err);
    return res.status(500).json({ error: "Could not write the minutes file." });
  }
  console.log(`Saved meeting minutes ${name}`);
  res.json({ path: path.join(folder, name), title, attendees, photos: photoCount });
});

/**
 * A recap of the meeting so far, with questions worth asking now.
 * Shown on the screen only. It is not spoken and not added to the meeting lines.
 */
app.post("/meeting/recap", async (req, res) => {
  const notes = cleanMeetingNotes(req.body?.lines);
  if (!notes) return res.status(400).json({ error: "Nothing has been written down yet." });
  const model = getModel(req.body?.model) || getModel(DEFAULT_MODEL);
  const lecture = req.body?.kind === "lecture";
  const instruction = lecture
    ? [
        "You are given a talk that is still going on, written down one line at a time. Arabic and English may be mixed.",
        "Keep each name, number, and phrase in the language that was spoken. Do not translate.",
        "Answer in Markdown with two headings.",
        "### So far: up to six short bullets on what the presenter has said.",
        "### Questions to ask: three to five questions the listener could ask the presenter now, such as unclear claims, missing evidence, or a point that was skipped.",
        "Do not invent people, numbers, or claims that are not in the lines.",
        "Do not write this as meeting minutes.",
      ].join("\n")
    : [
        "You are given a meeting that is still going on, written down one line at a time. Arabic and English may be mixed.",
        "Keep each name, number, and phrase in the language that was spoken. Do not translate.",
        "Answer in Markdown with two headings.",
        "### So far: up to six short bullets on what has been said and decided so far.",
        "### Questions to ask: three to five critical questions the listener should raise now, such as gaps, risks, unclear owners or dates, or claims with no evidence.",
        "Do not invent people, numbers, or decisions that are not in the lines.",
      ].join("\n");
  try {
    const text = await askModelOnce(model, instruction, `Transcript so far:\n${notes}`, process.env.OPENAI_API_KEY, 800);
    if (!text) return res.status(502).json({ error: "The model did not answer." });
    res.json({ text });
  } catch (err) {
    console.error("Failed while writing the meeting recap:", err?.message || err);
    res.status(500).json({ error: "Could not write the recap." });
  }
});

/**
 * Suggest a short title for a talk the listener can edit.
 * The title comes only from what was said.
 */
app.post("/lecture/title", async (req, res) => {
  const notes = cleanMeetingNotes(req.body?.lines);
  if (!notes) return res.status(400).json({ error: "Nothing has been written down yet." });
  const model = getModel(req.body?.model) || getModel(DEFAULT_MODEL);
  const instruction = [
    "Suggest one short title for this talk, at most eight words.",
    "Use only what was said. Do not invent a topic.",
    "Reply with the title only. No quotes, no label, no period at the end.",
  ].join(" ");
  try {
    const title = cleanSuggestedTitle(await askModelOnce(model, instruction, `Transcript:\n${notes}`, process.env.OPENAI_API_KEY, 40));
    if (!title) return res.status(502).json({ error: "No title was suggested." });
    res.json({ title });
  } catch (err) {
    console.error("Failed while suggesting a lecture title:", err?.message || err);
    res.status(500).json({ error: "Could not suggest a title." });
  }
});

/** The lecture notes as a Markdown file: date, time, presenter, then the talk summary. */
function lectureMarkdown({ title, presenter, start, end, summary }) {
  const day = start.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  return [
    `# ${title}`,
    "",
    `- **Date:** ${day}`,
    `- **Time:** ${minutesClock(start)} to ${minutesClock(end)}`,
    `- **Presenter:** ${presenter || "Not given"}`,
    "",
    "## Talk",
    "",
    summary,
    "",
  ].join("\n");
}

/**
 * Save the talk that just ended.
 * The title and presenter are the ones the listener typed. They are not taken from the calendar.
 */
app.post("/lecture/save", async (req, res) => {
  const notes = cleanMeetingNotes(req.body?.lines);
  if (!notes) return res.status(400).json({ error: "There are no lecture words to save." });
  const start = new Date(Number(req.body?.startedAt) || Date.now());
  const end = new Date(Number(req.body?.endedAt) || Date.now());
  const presenter = oneLine(req.body?.presenter, 80);
  const title = oneLine(req.body?.title, 120) || "Lecture";
  let summary = typeof req.body?.minutes === "string" ? req.body.minutes.trim() : "";

  let folder = lectureFolder();
  if (typeof req.body?.folder === "string" && req.body.folder.trim()) {
    folder = path.resolve(req.body.folder.trim());
    if (!fsSync.existsSync(folder) || !fsSync.statSync(folder).isDirectory()) {
      return res.status(400).json({ error: "That folder does not exist." });
    }
    if (!folderIsAllowed(folder)) {
      return res.status(400).json({ error: "Pick a folder inside your home folder." });
    }
  }

  if (!summary) {
    const model = getModel(req.body?.model) || getModel(DEFAULT_MODEL);
    try {
      summary = await askModelOnce(
        model,
        "Write a short summary of this talk in plain sentences. Do not invent facts.",
        `Presenter: ${presenter || "Not given"}\nTitle: ${title}\n\nTranscript:\n${notes}`,
        process.env.OPENAI_API_KEY,
        800,
      );
    } catch (err) {
      console.error("Failed while writing the lecture notes:", err?.message || err);
    }
  }
  summary ||= "The talk summary could not be written.";
  const text = lectureMarkdown({ title, presenter, start, end, summary });
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "lecture";
  const name = `${memoStamp(start)}-${slug}.md`;
  let photoCount = 0;
  try {
    await fs.mkdir(folder, { recursive: true });
    const packed = await withPhotos(text, folder, name.replace(/\.md$/i, ""), req.body?.photos);
    photoCount = packed.count;
    await fs.writeFile(path.join(folder, name), packed.text, "utf8");
  } catch (err) {
    console.error("Failed while saving the lecture:", err?.message || err);
    return res.status(500).json({ error: "Could not write the lecture file." });
  }
  console.log(`Saved lecture notes ${name}`);
  res.json({ path: path.join(folder, name), title, presenter, photos: photoCount });
});

/** Ask macOS for a folder. Returns an empty path if the user cancels. */
app.post("/meeting/folder", async (req, res) => {
  const prompt = req.body?.kind === "lecture"
    ? "Save the lecture notes in:"
    : "Save the meeting minutes in:";
  try {
    const out = await runCommand("osascript", ["-e", `POSIX path of (choose folder with prompt ${JSON.stringify(prompt)})`]);
    res.json({ folder: out.trim() });
  } catch {
    res.json({ folder: "" });
  }
});

const SKILLS_DIR = path.join(__dirname, "skills");

/** "PRD simple" becomes the file name prd-simple. */
function skillFileId(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/\.md$/i, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

/** A skill file can start with a short name and description between --- lines. */
function parseSkill(text, id) {
  const raw = String(text || "");
  let name = id;
  let description = "";
  let body = raw.trim();
  const front = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (front) {
    body = raw.slice(front[0].length).trim();
    for (const line of front[1].split(/\r?\n/)) {
      const match = line.match(/^([A-Za-z]+):\s*(.*)$/);
      if (!match) continue;
      const key = match[1].toLowerCase();
      if (key === "name" && match[2].trim()) name = match[2].trim();
      if (key === "description") description = match[2].trim();
    }
  }
  return {
    id,
    name: name.slice(0, 80),
    description: description.slice(0, 240),
    body: body.slice(0, 20000),
  };
}

/** Every markdown file in second-brain/skills is one skill the voice can use. */
async function listSkills() {
  let names = [];
  try {
    names = await fs.readdir(SKILLS_DIR);
  } catch (err) {
    if (err?.code !== "ENOENT") console.error("Failed while reading skills:", err?.message || err);
    return [];
  }
  const skills = [];
  for (const file of names) {
    if (!file.endsWith(".md")) continue;
    const id = file.slice(0, -3);
    if (!/^[a-z0-9][a-z0-9-]{0,59}$/.test(id)) continue;
    try {
      const text = await fs.readFile(path.join(SKILLS_DIR, file), "utf8");
      skills.push(parseSkill(text, id));
    } catch (err) {
      console.error("Failed while reading a skill:", err?.message || err);
    }
  }
  skills.sort((a, b) => a.name.localeCompare(b.name));
  return skills;
}

/** "Stop the skill" puts the current skill away. */
function mentionsSkillStop(question) {
  const q = String(question || "").toLowerCase();
  return /\b(stop|drop|done with|forget|close|put away|turn off)\b/.test(q) && /\bskills?\b/.test(q);
}

/** "Use the PRD simple skill" or "write a PRD" picks a skill by its name. */
function matchSkill(question, skills) {
  const q = String(question || "").toLowerCase().replace(/['’]/g, "");
  let found = null;
  for (const skill of skills) {
    const names = [skill.name, skill.id.replace(/-/g, " ")]
      .map((name) => name.toLowerCase().trim())
      .filter((name) => name.length >= 3);
    const mentioned = names.some((name) => q.includes(name));
    const asksToUse = /\b(use|using|grab|open|follow|start|load|switch to|with the)\b/.test(q) || /\bskills?\b/.test(q);
    if (mentioned && asksToUse) found = skill;
    if (/\bprd\b/.test(skill.id) && /\bprds?\b/.test(q) && /\b(write|create|draft|make|build|start|use)\b/.test(q)) {
      found = skill;
    }
  }
  return found;
}

/** Calendar, email, and the other built-in jobs still win unless the user named a skill. */
function looksLikeOwnJob(question) {
  return Boolean(
    desk.parseDesk(question)
    || textMeJob(question)
    || learningJob(question)
    || showSiteJob(question)
    || siteShortcut(question)
    || emailSearchJob(question)
    || openFileJob(question)
    || findOnMacJob(question)
    || meetingJob(question)
    || calendarRead(question)
    || memoJob(question)
    || wantsEmail(question)
  );
}

/** The words the model follows when a skill is on. The voice reads only the part before SKILL_BODY. */
function skillInstructions(skill, question, history, memory, meetingNotes, notesKind = "") {
  const earlier = history.length
    ? history.map((turn) => `User: ${turn.question}\nAssistant: ${turn.answer}`).join("\n\n")
    : "";
  return [
    `The user wants you to use the skill "${skill.name}".`,
    "Follow the skill below. It decides the shape of the answer.",
    "Say a short spoken intro first. If the skill produces a document, put the marker SKILL_BODY on its own line, then write the document.",
    "The voice reads only the words before SKILL_BODY. Do not read the document aloud.",
    "After SKILL_BODY, short labels on their own lines are fine.",
    "Do not invent facts. Write TBD when something was not said.",
    "Keep Arabic and English as the user said them.",
    "",
    skill.body,
    meetingNotes
      ? `${notesKind === "lecture" ? "Talk" : "Meeting"} that was just written down:\n${meetingNotes}`
      : "",
    memory ? `What you remember:\n${memory}` : "",
    earlier ? `Earlier in this conversation:\n${earlier}` : "",
    "",
    `Question: ${question}`,
  ].filter(Boolean).join("\n");
}

function replySkillStop(res) {
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.flushHeaders?.();
  writeEvent(res, { type: "skill", id: "", name: "" });
  writeEvent(res, { type: "delta", text: "I put that skill away." });
  writeEvent(res, { type: "done" });
  return res.end();
}

/**
 * Speak one prepared prompt with the model selected on the page.
 * Used for the meeting summary, which must not run the calendar or email tools.
 * firstEvent is sent before the words, so the page can highlight a skill.
 */
async function streamSpokenPrompt(req, res, prompt, firstEvent) {
  const model = getModel(req.body?.model) || getModel(DEFAULT_MODEL);
  let reasoning = typeof req.body?.reasoning === "string" ? req.body.reasoning : DEFAULT_REASONING;
  if (!model.reasoning.includes(reasoning)) reasoning = model.reasoning[0];
  const apiKey = process.env.OPENAI_API_KEY;
  if (!model.local && !model.subscription && !apiKey) {
    return res.status(500).json({
      error: "Missing OPENAI_API_KEY. Add it to the .env file in the project folder.",
    });
  }

  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();
  if (firstEvent) writeEvent(res, firstEvent);

  if (model.local && loadedLocalId && !ollamaNamesMatch(loadedLocalId, model.id)) {
    try {
      await stopOllamaModel(loadedLocalId);
    } catch (err) {
      console.error("Failed while switching local models:", err?.message || err);
    }
  }
  if (model.local) loadedLocalId = model.id;

  try {
    // longSpoken so a real meeting can be more than three sentences.
    if (model.local) await streamLocalAnswer(prompt, res, model, reasoning, true, true);
    else if (model.subscription) await streamClaudeAnswer(prompt, res, model, reasoning, true);
    else await streamAnswer(apiKey, prompt, res, model, reasoning, true);
    writeEvent(res, { type: "done" });
    res.end();
  } catch (err) {
    console.error("Failed while summarizing the meeting:", err?.message || err);
    writeEvent(res, {
      type: "error",
      message: err?.message || "Could not summarize the meeting.",
    });
    res.end();
  }
}

/** The names of the skills on this Mac. The page shows this list. */
app.get("/skills", async (_req, res) => {
  const skills = await listSkills();
  res.json({
    skills: skills.map((skill) => ({
      id: skill.id,
      name: skill.name,
      description: skill.description,
    })),
  });
});

/** Save a markdown skill the user uploaded from the voice page. */
app.post("/skills", async (req, res) => {
  const text = typeof req.body?.text === "string" ? req.body.text : "";
  if (text.trim().length < 20) {
    return res.status(400).json({ error: "That file is too short to be a skill." });
  }
  if (text.length > 80000) {
    return res.status(400).json({ error: "That skill file is too long." });
  }
  const hinted = parseSkill(text, "draft");
  const id = skillFileId(req.body?.name || hinted.name || "skill");
  if (!id || !/^[a-z0-9][a-z0-9-]{0,59}$/.test(id)) {
    return res.status(400).json({ error: "Give the skill a name made of letters and numbers." });
  }
  await fs.mkdir(SKILLS_DIR, { recursive: true });
  const filePath = path.join(SKILLS_DIR, `${id}.md`);
  if (path.dirname(filePath) !== SKILLS_DIR) {
    return res.status(400).json({ error: "That name is not allowed." });
  }
  let saved = text.trim();
  if (!saved.startsWith("---")) {
    const title = String(req.body?.name || hinted.name || id).replace(/[\r\n]/g, " ").slice(0, 80);
    saved = `---\nname: ${title}\ndescription: A skill you uploaded.\n---\n\n${saved}\n`;
  }
  await fs.writeFile(filePath, `${saved.trim()}\n`, "utf8");
  const skill = parseSkill(saved, id);
  res.json({ id: skill.id, name: skill.name, description: skill.description });
});

app.post("/ask", async (req, res) => {
  let question = typeof req.body?.question === "string" ? req.body.question.trim() : "";
  if (!question) {
    return res.status(400).json({ error: "Type or say a question first." });
  }
  // A meeting or lecture summary must not open the calendar or search the wiki.
  if (req.body?.summarizeLecture === true) {
    const notes = cleanMeetingNotes(req.body?.meetingNotes);
    if (!notes) return replyNow(res, "The lecture was quiet. I did not catch any words.");
    const presenter = oneLine(req.body?.presenter, 80) || "the presenter";
    const title = oneLine(req.body?.title, 120);
    await streamSpokenPrompt(req, res, lectureSummaryPrompt(notes, presenter, title));
    return;
  }
  if (req.body?.summarizeMeeting === true) {
    const notes = cleanMeetingNotes(req.body?.meetingNotes);
    if (!notes) return replyNow(res, "The meeting was quiet. I did not catch any words.");
    await streamSpokenPrompt(req, res, meetingSummaryPrompt(notes));
    return;
  }
  // The page already started Tiny's move. Say a few words while Tiny does it.
  const tinyLine = TINY_LINES[req.body?.tinyMove];
  if (tinyLine) return replyNow(res, tinyLine);
  // A skill is a saved set of instructions. "Use the PRD skill" loads that file.
  const skills = await listSkills();
  const requestedId = typeof req.body?.skill === "string" ? req.body.skill : "";
  if (mentionsSkillStop(question)) return replySkillStop(res);
  const named = matchSkill(question, skills);
  const kept = skills.find((skill) => skill.id === requestedId) || null;
  let activeSkill = named || kept;
  const asksForASkill = /\b(use|grab|open|start|follow) (?:the |a )?skills?\b/i.test(question);
  if (asksForASkill && !named && !kept) {
    if (skills.length === 1) activeSkill = skills[0];
    else if (!skills.length) return replyNow(res, "There are no skills yet. Upload one on the page.");
    else {
      const names = skills.map((skill) => skill.name).join(", ");
      return replyNow(res, `Which skill should I use? I have ${names}.`);
    }
  }
  if (activeSkill && (named || asksForASkill || !looksLikeOwnJob(question))) {
    const notes = cleanMeetingNotes(req.body?.meetingNotes);
    const prompt = skillInstructions(
      activeSkill,
      question,
      cleanHistory(req.body?.history),
      cleanMemory(req.body?.memory),
      notes,
      req.body?.notesKind === "lecture" ? "lecture" : "",
    );
    await streamSpokenPrompt(req, res, prompt, {
      type: "skill",
      id: activeSkill.id,
      name: activeSkill.name,
    });
    return;
  }
  if (isNoise(question)) {
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.flushHeaders?.();
    writeEvent(res, { type: "ignored", message: "That was a noise, not a question." });
    writeEvent(res, { type: "done" });
    return res.end();
  }
  const deskCommand = desk.parseDesk(question);
  if (deskCommand?.action === "do") {
    const item = desk.suggestionAt(deskCommand.index);
    if (!item) return replyNow(res, "There is no idea with that number.");
    desk.dismissSuggestion(item.id);
    sendControl("desk", {});
    question = `Draft a reply to the email about ${item.detail}`;
  } else if (deskCommand) {
    try {
      const result = await runDeskCommand(deskCommand);
      if (result) {
        sendControl("desk", {});
        return replyNow(res, result.text, result.card);
      }
    } catch (err) {
      console.error("Failed while running a saved job:", err?.message || err);
      return replyNow(res, "I could not update that job.");
    }
  }
  const textMe = textMeJob(question);
  if (textMe) {
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.flushHeaders?.();
    writeEvent(res, { type: "delta", text: await runTextMe(textMe, askBrain) });
    writeEvent(res, { type: "done" });
    return res.end();
  }
  const learning = learningJob(question);
  if (learning) {
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.flushHeaders?.();
    writeEvent(res, { type: "delta", text: await runMemoryJob(learning) });
    writeEvent(res, { type: "done" });
    return res.end();
  }
  // "Show me cnn.com" opens the browser. A file name is not a web address.
  const site = showSiteJob(question) || siteShortcut(question);
  if (site) {
    try {
      await runCommand("open", [site.url]);
      const label = site.name.toLowerCase() === "inotes" ? "iNotes" : site.name;
      return replyNow(res, `I opened ${label} in your browser.`, { title: label, lines: [site.url] });
    } catch (err) {
      console.error("Failed while opening a web page:", err?.message || err);
      return replyNow(res, `I could not open ${site.name}.`);
    }
  }
  // Email first: "open the email from Sara" must not look for a file called "email from Sara".
  const mailSearch = emailSearchJob(question);
  const openFile = mailSearch ? null : openFileJob(question);
  const findOnMac = mailSearch || openFile ? null : findOnMacJob(question);
  const opened = mailSearch ? await runEmailSearch(mailSearch, rawMail)
    : openFile ? await runOpenFile(openFile, notes, selected, {
      asked: question,
      recentText: fileTalk(cleanHistory(req.body?.history)),
      findByMeaning: (text) => semantic.search(text, 100),
    })
    : findOnMac ? await runFindOnMac(findOnMac) : null;
  if (opened) {
    const text = typeof opened === "string" ? opened : opened.text;
    const card = opened && typeof opened === "object" ? opened.card : { title: "Done", lines: [text] };
    return replyNow(res, text, card);
  }
  if (!notes.length) {
    return res.status(500).json({
      error: "No wiki notes are loaded. Check WIKI_PATH and restart the server.",
    });
  }

  const model = getModel(req.body?.model) || getModel(DEFAULT_MODEL);
  let reasoning = typeof req.body?.reasoning === "string" ? req.body.reasoning : DEFAULT_REASONING;
  if (!model.reasoning.includes(reasoning)) {
    reasoning = model.reasoning[0];
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!model.local && !model.subscription && !apiKey) {
    return res.status(500).json({
      error: "Missing OPENAI_API_KEY. Add it to the .env file in the project folder.",
    });
  }

  const aboutChat = isChatQuestion(question);
  const history = cleanHistory(req.body?.history);
  const recordedMeeting = cleanMeetingNotes(req.body?.meetingNotes);
  // A question about the recording must not open today's Outlook calendar.
  const aboutRecorded = Boolean(recordedMeeting) && !asksForOutlookCalendar(question);
  const meeting = aboutChat ? null : meetingJob(question);
  const calendarWhen = aboutChat || meeting || aboutRecorded ? null : calendarRead(question);
  const memo = aboutChat || meeting || calendarWhen ? null : memoJob(question);
  const aboutEmail = wantsEmail(question);
  const hits = aboutChat || memo === "save" || meeting || calendarWhen || aboutRecorded
    ? []
    : memo
      ? await memosForPrompt(memo)
      : aboutEmail
        ? await findRawEmails(question, history)
        : await notesForQuestion(question);

  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  if (model.local && loadedLocalId && !ollamaNamesMatch(loadedLocalId, model.id)) {
    const previous = getModel(loadedLocalId);
    try {
      const unloaded = await stopOllamaModel(loadedLocalId);
      if (unloaded.stopped) {
        writeEvent(res, {
          type: "status",
          message: `${previous?.label || loadedLocalId} was stopped.`,
        });
      }
    } catch (err) {
      console.error("Failed while switching local models:", err?.message || err);
    }
  }
  if (model.local) loadedLocalId = model.id;

  if (!aboutChat && !memo && !meeting && !calendarWhen && !aboutRecorded && shouldBrowse(question)) writeEvent(res, { type: "status", message: "Looking on the web…" });
  const pages = aboutChat || memo || meeting || calendarWhen || aboutRecorded ? [] : await searchWeb(question);
  const sources = [
    ...hits.map(({ note }) => ({ title: note.title, file: note.rel })),
    ...pages.map((page) => ({ title: page.title, file: page.url })),
  ];
  writeEvent(res, { type: "sources", sources });
  if (hits.outlook) writeEvent(res, { type: "outlook", ...hits.outlook });

  // No matching notes often means the question was misheard or unclear.
  // The model still sees it, so it can ask what you meant instead of saying "not in the notes".

  try {
    if (calendarWhen) {
      writeEvent(res, { type: "delta", text: spokenCalendar(calendarWhen) });
      writeEvent(res, { type: "done" });
      return res.end();
    }
    if (meeting) {
      const plan = parseMeeting(question);
      const waiting = spokenMeetingWaiting(plan);
      desk.saveMeetingDraft(plan, waiting);
      sendControl("desk", {});
      writeEvent(res, { type: "work", card: { title: plan.subject, lines: [waiting] } });
      writeEvent(res, { type: "delta", text: waiting });
      writeEvent(res, { type: "done" });
      return res.end();
    }
    if (memo === "save") {
      const said = await spokenSavedMemo(question, model, apiKey);
      writeEvent(res, { type: "delta", text: said });
      writeEvent(res, { type: "done" });
      return res.end();
    }
    const notesKind = req.body?.notesKind === "lecture" ? "lecture" : "";
    let prompt = buildPrompt(question, hits, pages, history, cleanMemory(req.body?.memory), recordedMeeting, notesKind);
    const photo = photoDataUrl(req.body?.photo);
    if (photo && (model.local || model.subscription)) {
      prompt += "\n\nThe user attached a photo. You cannot see pictures. If they ask what the photo shows, say you cannot see it. Do not invent what is in it.";
    } else if (photo) {
      prompt += "\n\nA photo is attached. If the question is about that photo, answer only from what is visible in it. Do not invent words or numbers that are not in the photo.";
    }
    const spoken = req.body?.spoken === true;
    const longSpoken = hits.emailJob === "read" || hits.emailJob === "reply" || hits.emailJob === "send" || hits.emailJob === "list" || hits.emailJob === "review" || hits.memoJob === "recent" || hits.memoJob === "all" || hits.memoJob === "find";
    if (model.local) await streamLocalAnswer(prompt, res, model, reasoning, spoken, longSpoken);
    else if (model.subscription) await streamClaudeAnswer(prompt, res, model, reasoning, spoken);
    else await streamAnswer(apiKey, prompt, res, model, reasoning, spoken, photo);
    writeEvent(res, { type: "done" });
    res.end();
  } catch (err) {
    console.error("Failed while answering:", err?.message || err);
    writeEvent(res, {
      type: "error",
      message: err?.message || "Something went wrong while answering.",
    });
    res.end();
  }
});

/** Ask through /ask, the same way the page does, and return the whole answer as text. */
async function askBrain(question, history = []) {
  const response = await fetch(`http://127.0.0.1:${PORT}/ask`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question, history }),
  });
  const raw = await response.text();
  if (!response.ok) throw new Error(safeJson(raw)?.error || `ask failed with ${response.status}`);
  let answer = "";
  for (const line of raw.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const event = safeJson(line.slice(6));
    if (event?.type === "delta") answer += event.text;
    if (event?.type === "error") throw new Error(event.message);
  }
  return answer.trim();
}

registerIMessage(app, askBrain);

/**
 * Morning briefing: today's meetings, tasks due, and emails that need a reply.
 * BRIEFING_AT=08:00 in .env sends it each day; it goes to your iMessage (when on)
 * and an open voice page reads it aloud. GET /briefing makes one now without sending.
 */
async function briefingText() {
  const parts = [`Good morning. ${spokenCalendar("today")}`];
  for (const question of ["Which tasks on my to-do list are due today or overdue? Answer in two or three short sentences.", "Which emails need an urgent reply?"]) {
    try {
      parts.push(await askBrain(question));
    } catch (err) {
      console.error("Failed while building the briefing:", err?.message || err);
    }
  }
  return parts.filter(Boolean).join("\n\n");
}

async function deliverBriefing() {
  const text = await briefingText();
  sendControl("briefing", { text });
  try {
    await sendIMessage(text);
  } catch (err) {
    console.error("Failed while texting the briefing:", err?.message || err);
  }
  console.log(`Briefing delivered (voice pages: ${controlClients.size}, iMessage: ${imessageHandle() ? "on" : "off"})`);
  return text;
}

app.get("/desk", (_req, res) => {
  res.json(desk.publicDesk());
});

app.post("/desk/memory", (req, res) => {
  try {
    desk.rememberChat(cleanMemory(req.body?.memory), cleanHistory(req.body?.turns));
    res.json(desk.publicDesk());
  } catch (err) {
    console.error("Failed while saving the conversation:", err?.message || err);
    res.status(500).json({ error: "Could not save the conversation." });
  }
});

app.delete("/desk/memory", (_req, res) => {
  desk.forgetChat();
  res.json(desk.publicDesk());
});

app.post("/desk/draft", (req, res) => {
  try {
    const job = desk.saveEmailDraft({
      to: req.body?.to,
      name: req.body?.name,
      subject: req.body?.subject,
      body: req.body?.body,
      original: req.body?.original,
    });
    if (!job) return res.status(400).json({ error: "There is no draft to save." });
    sendControl("desk", {});
    queueWorkSummaries();
    res.json({ ok: true, id: job.id });
  } catch (err) {
    console.error("Failed while saving an email draft:", err?.message || err);
    res.status(500).json({ error: "Could not save that draft." });
  }
});

app.post("/desk/jobs/:id/open", async (req, res) => {
  const job = desk.jobById(req.params.id);
  if (!job || job.status !== "needs-you") {
    return res.status(404).json({ error: "That draft is not waiting." });
  }
  try {
    const text = await openSavedDraft(job);
    sendControl("desk", {});
    res.json({ ok: true, text });
  } catch (err) {
    console.error("Failed while opening a saved draft from the page:", err?.message || err);
    res.status(500).json({ error: "Outlook did not open. Is Microsoft Outlook installed?" });
  }
});

app.post("/desk/jobs/:id/skip", (req, res) => {
  const job = desk.finishJob(req.params.id, "skipped", "You dropped this.");
  if (!job) return res.status(404).json({ error: "That job is not here." });
  sendControl("desk", {});
  res.json({ ok: true });
});

app.post("/desk/suggestions/:id/skip", (req, res) => {
  const item = desk.dismissSuggestion(req.params.id);
  if (!item) return res.status(404).json({ error: "That idea is not here." });
  sendControl("desk", {});
  res.json({ ok: true });
});

app.post("/desk/suggestions/:id/do", (req, res) => {
  const item = desk.suggestionById(req.params.id);
  if (!item) return res.status(404).json({ error: "That idea is not here." });
  desk.dismissSuggestion(item.id);
  sendControl("desk", {});
  res.json({ question: `Draft a reply to the email about ${item.detail}` });
});

/** Read a public page down to plain words, for a watch. */
async function readWatchedPage(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Only web pages can be watched.");
  }
  const response = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(8000),
    headers: { "User-Agent": "hey-my-brain" },
  });
  if (!response.ok) throw new Error(`The page answered ${response.status}.`);
  const raw = await response.text();
  return raw
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 4000);
}

async function checkWatches() {
  for (const job of desk.watchesToCheck()) {
    try {
      const text = await readWatchedPage(job.url);
      const hash = crypto.createHash("sha256").update(text).digest("hex");
      const changed = desk.recordWatch(job.id, hash);
      if (!changed) continue;
      const notice = `The page ${job.title} changed.`;
      sendControl("job", { title: job.title, text: notice });
      sendControl("desk", {});
      try {
        await sendIMessage(notice);
      } catch (err) {
        console.error("Failed while texting a page change:", err?.message || err);
      }
    } catch (err) {
      console.error("Failed while checking a watched page:", err?.message || err);
      desk.recordWatch(job.id, "", "I could not read that page just now. I will try again.");
    }
  }
}

async function deliverReminders() {
  const due = desk.takeDueReminders();
  if (!due.length) return;
  for (const job of due) {
    const notice = `Reminder: ${job.title}.`;
    sendControl("job", { title: job.title, text: notice });
    try {
      await sendIMessage(notice);
    } catch (err) {
      console.error("Failed while texting a reminder:", err?.message || err);
    }
  }
  sendControl("desk", {});
}

// Watches and reminders keep going while this server is open, including after a restart.
setInterval(() => {
  deliverReminders().catch((err) => console.error("Failed while sending reminders:", err?.message || err));
}, 20_000);
setTimeout(() => {
  deliverReminders().catch((err) => console.error("Failed while sending reminders:", err?.message || err));
}, 5_000);
setInterval(() => {
  checkWatches().catch((err) => console.error("Failed while checking watches:", err?.message || err));
}, 3 * 60_000);
setInterval(() => {
  indexRawMail()
    .then(() => syncSuggestions())
    .catch((err) => console.error("Failed while refreshing suggestions:", err?.message || err));
}, 15 * 60_000);

app.get("/briefing", async (_req, res) => {
  try {
    res.json({ text: await briefingText() });
  } catch (err) {
    console.error("Failed while making the briefing:", err?.message || err);
    res.status(500).json({ error: "Could not make the briefing." });
  }
});

app.post("/briefing/send", async (_req, res) => {
  try {
    res.json({ text: await deliverBriefing() });
  } catch (err) {
    console.error("Failed while sending the briefing:", err?.message || err);
    res.status(500).json({ error: "Could not send the briefing." });
  }
});

/** Keep one voice question and answer for tonight's brain.md summary. */
app.post("/daylog", (req, res) => {
  appendDayLog(req.body?.question, req.body?.answer);
  res.json({ ok: true });
});

/** Summarize one day (default today) into ~/.claude/brain.md with the default model. */
async function summarizeBrainDay(day) {
  const model = getModel(DEFAULT_MODEL);
  const folders = { meetingDir: meetingFolder(), notesDir: memoFolder(), lectureDir: lectureFolder() };
  const result = await summarizeDay(day, folders, (instruction, text) =>
    askModelOnce(model, instruction, text, process.env.OPENAI_API_KEY, 2000, 240000));
  console.log(`brain.md for ${day}: ${result}`);
  return result;
}

app.post("/brain/summarize", async (req, res) => {
  const day = /^\d{4}-\d{2}-\d{2}$/.test(req.body?.day || "") ? req.body.day : dayKey();
  try {
    res.json({ day, result: await summarizeBrainDay(day) });
  } catch (err) {
    console.error("Failed while writing brain.md:", err?.message || err);
    res.status(500).json({ error: err?.message || "Could not write brain.md." });
  }
});

/**
 * Upload a document from the voice page: a copy and a wiki page go to the meeting folder,
 * and the wiki page joins the notes at once so questions can find it.
 * The page sends the file as raw bytes, its name in X-File-Name.
 */
app.post("/document", express.raw({ type: "*/*", limit: "60mb" }), async (req, res) => {
  let name = "";
  try {
    name = decodeURIComponent(String(req.get("x-file-name") || ""));
  } catch {
    return res.status(400).json({ error: "The file name could not be read." });
  }
  const folder = meetingFolder();
  const model = getModel(req.get("x-model")) || getModel(DEFAULT_MODEL);
  try {
    const doc = await ingestDocument({
      name,
      bytes: Buffer.isBuffer(req.body) ? req.body : null,
      folder,
      ask: (instruction, text) => askModelOnce(model, instruction, text, process.env.OPENAI_API_KEY, 3000, 240000),
    });
    // The meeting folder is <root>/raw/meetings, so the note is relative to that root.
    const root = path.dirname(path.dirname(folder));
    notes = [...notes, parseNote(path.relative(root, doc.wikiPath), doc.wikiText)];
    semantic.build(notes).catch((err) => console.error("Failed while building the meaning index:", err?.message || err));
    console.log(`Saved an uploaded document and its wiki page (${path.extname(doc.copyPath)})`);
    res.json({ title: doc.title, summary: doc.summary, wiki: doc.wikiPath, copy: doc.copyPath });
  } catch (err) {
    if (err?.status === 400) return res.status(400).json({ error: err.message });
    console.error("Failed while saving an uploaded document:", err?.message || err);
    res.status(500).json({ error: "Could not save that document." });
  }
});

/** "Clear and save": summarize the conversation on screen into brain.md before the page clears it. */
app.post("/brain/conversation", async (req, res) => {
  const text = typeof req.body?.text === "string" ? req.body.text.trim().slice(0, 30000) : "";
  if (text.length < 20) return res.status(400).json({ error: "There is no conversation to save yet." });
  try {
    const heading = await saveConversation(text, (instruction, input) =>
      askModelOnce(getModel(DEFAULT_MODEL), instruction, input, process.env.OPENAI_API_KEY, 2000, 240000));
    // Never log the conversation itself. It can name a patient.
    console.log(`brain.md: saved ${heading}`);
    res.json({ ok: true, heading });
  } catch (err) {
    console.error("Failed while saving the conversation to brain.md:", err?.message || err);
    res.status(500).json({ error: "Could not save the conversation to brain.md." });
  }
});

// Each night, write the day into brain.md. If the Mac was off, catch up on yesterday at start.
const BRAIN_SUMMARY_AT = /^\d{1,2}:\d{2}$/.test(process.env.BRAIN_SUMMARY_AT || "") ? process.env.BRAIN_SUMMARY_AT : "23:30";
// Days already tried since this server started, so a day is never written twice.
const brainTried = new Set();
function runBrainSummary(day) {
  if (brainTried.has(day)) return;
  brainTried.add(day);
  summarizeBrainDay(day).catch((err) => console.error("Failed while writing brain.md:", err?.message || err));
}
setInterval(() => {
  const now = new Date();
  const [hour, minute] = BRAIN_SUMMARY_AT.split(":").map(Number);
  if (now.getHours() * 60 + now.getMinutes() < hour * 60 + minute) return;
  runBrainSummary(dayKey(now));
}, 60_000);
setTimeout(() => {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  runBrainSummary(dayKey(yesterday));
}, 60_000);
console.log(`brain.md summary set for ${BRAIN_SUMMARY_AT} each night.`);

const BRIEFING_AT = (process.env.BRIEFING_AT || "").trim();
if (/^\d{1,2}:\d{2}$/.test(BRIEFING_AT)) {
  let briefedOn = "";
  setInterval(() => {
    const now = new Date();
    const [hour, minute] = BRIEFING_AT.split(":").map(Number);
    const today = now.toDateString();
    const late = now.getHours() * 60 + now.getMinutes() - (hour * 60 + minute);
    // Only within the first half hour, so a restart at noon does not send a morning briefing.
    if (briefedOn === today || late < 0 || late > 30) return;
    briefedOn = today;
    deliverBriefing().catch((err) => console.error("Failed while sending the briefing:", err?.message || err));
  }, 30_000);
  console.log(`Morning briefing set for ${BRIEFING_AT}.`);
}

startWhisperServer();
startKokoro();

try {
  readSavedFolders();
  await reloadNotes();
} catch (err) {
  console.error("Failed while loading the wiki:", err?.message || err);
}

// Only this Mac can connect; other machines on the network cannot.
app.listen(PORT, "127.0.0.1", () => {
  console.log(`\nSecond brain → http://localhost:${PORT}`);
  console.log(`Default model: ${DEFAULT_MODEL} (thinking ${DEFAULT_REASONING}). Change it on the page.`);
  if (!process.env.OPENAI_API_KEY) {
    console.warn("OPENAI_API_KEY is not set. Copy .env.example to .env first.\n");
  }
  if (!notes.length) {
    console.warn(`No notes loaded. Is this path correct?\n${WIKI_PATH}\n`);
  }
});
