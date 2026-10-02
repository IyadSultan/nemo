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
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { MODELS, VOICE_MODELS, REASONING_LEVELS, getModel, getAnyModel, priceForUsage } from "./pricing.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// One .env at the repo root holds the OpenAI key for Nemo and this app.
dotenv.config({ path: path.join(__dirname, "..", ".env") });

const DEFAULT_MODEL = "gpt-oss:20b";
const DEFAULT_REASONING = "none";
// Same live voice model as Nemo (voice control). It hears the microphone.
const VOICE_MODEL = "gpt-realtime-2.1-mini";
const LOCAL_VOICE_MODEL = path.join(__dirname, "..", "voice", "models", "ggml-small.en.bin");
const WHISPER_BIN = "/opt/homebrew/bin/whisper-cli";
// Keeps the voice model loaded, so each clip skips the model load (about 0.4s down to 0.1s).
// Whisper small.en beat Parakeet v2 on note names and acronyms on this Mac (17% vs 23% word errors).
const WHISPER_SERVER_BIN = "/opt/homebrew/bin/whisper-server";
const WHISPER_SERVER_URL = "http://127.0.0.1:8178/inference";
// Kokoro: the same local voice the claude-voice app uses. Local models speak with it.
const KOKORO_PYTHON = "/usr/local/bin/python3.11";
const KOKORO_SCRIPT = path.join(__dirname, "..", "voice", "kokoro_server.py");
const KOKORO_URL = "http://127.0.0.1:8179";
const FFMPEG_BIN = "/opt/homebrew/bin/ffmpeg";
// Ollama runs local models on this Mac. Bonsai is already installed there.
const OLLAMA_URL = process.env.OLLAMA_URL || "http://127.0.0.1:11434";
let loadedLocalId = "";
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
app.use(express.json({ limit: "1mb" }));
app.use(express.text({ type: ["application/sdp", "text/plain"], limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

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
 * Score notes by how often the question words appear.
 * A hit in the title counts more than a hit buried in the page.
 */
function searchNotes(question, limit = 4) {
  const terms = queryTerms(question);
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
  return ranked.slice(0, limit);
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

function buildPrompt(question, hits, pages = [], history = [], memory = "") {
  const blocks = hits.map(({ note, terms }) => {
    return [
      `Note: ${note.title}`,
      `File: ${note.rel}`,
      noteBody(note, terms),
    ].join("\n");
  });

  const webBlocks = pages.map((page) => {
    return [`Page: ${page.title}`, `Address: ${page.url}`, page.text].join("\n");
  });

  const newsNote = wantsNews(question)
    ? "The user wants today's news. Summarize three or four headlines from the web pages in plain sentences. Do not ask which topic."
    : "";
  const vaultNote = wantsEmail(question)
    ? hits.length
      ? "This question is about email. The files below are from the raw folder. Answer only from those files and name the file. Do not say you only checked notes."
      : "This question is about email. The raw folder was checked and nothing matched. Say that plainly. Do not talk about wiki notes."
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

  return [
    `Today's date is ${todayLabel()}.`,
    memoryBlock,
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
/** @type {{ rel: string, title: string, full: string, mtime: number, words: string[] }[]} */
let rawMail = [];

const EMAIL_FILLER = new Set([
  "new", "today", "latest", "recent", "mail", "email", "emails", "inbox",
  "any", "got", "get", "did", "from", "sent", "receive", "received",
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

function startOfTodayMs() {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  return start.getTime();
}

async function readRawExcerpt(file) {
  const raw = await fs.readFile(file.full, "utf8");
  const text = raw.replace(/\s+/g, " ").trim().slice(0, 1600);
  return {
    note: { rel: file.rel, title: file.title, text, lower: text.toLowerCase() },
    terms: [],
  };
}

/** Email questions look at raw/, where each saved message is a text file. */
async function findRawEmails(question) {
  const personTerms = queryTerms(question).filter((term) => !EMAIL_FILLER.has(term) && term.length >= 4);
  const q = question.toLowerCase();
  const wantsToday = /\b(today|tonight)\b/.test(q);
  const wantsNew = /\b(new|latest|recent)\b/.test(q);
  let chosen = [];

  if (personTerms.length) {
    const ranked = rawMail
      .map((file) => ({
        file,
        score: personTerms.filter((term) => nameMatchesFile(term, file.words)).length,
      }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || b.file.mtime - a.file.mtime);
    const top = ranked[0]?.score || 0;
    chosen = ranked.filter((item) => item.score === top).map((item) => item.file);
    // A first name plus a last name should both match. If only the first name matches,
    // keep it when the file is addressed to a doctor, such as "Dr. Asem".
    if (top > 0 && top < personTerms.length) {
      chosen = chosen.filter((file) => {
        const shortName = personTerms.some((term) => term.length <= 5 && nameMatchesFile(term, file.words));
        return shortName && /(^|[^a-z])dr([^a-z]|$)/.test(file.lowerName);
      });
    }
    if (wantsToday) {
      const todayHits = chosen.filter((file) => file.mtime >= startOfTodayMs());
      if (todayHits.length) chosen = todayHits;
    }
  } else if (wantsToday) {
    chosen = rawMail.filter((file) => file.mtime >= startOfTodayMs()).sort((a, b) => b.mtime - a.mtime);
  } else if (wantsNew || wantsEmail(question)) {
    chosen = [...rawMail].sort((a, b) => b.mtime - a.mtime);
  }

  const picks = chosen.slice(0, 6);
  const hits = [];
  for (const file of picks) {
    try {
      hits.push(await readRawExcerpt(file));
    } catch (err) {
      console.error(`Failed while reading a raw email: ${file.full}`);
      console.error(err?.message || err);
    }
  }
  return hits;
}

function isVaultQuestion(question) {
  const q = question.toLowerCase();
  return /\b(todos?|to-dos?|to do|tasks?|plate|have to do|index|logs?|history|wikis?|finished|second brain|e-?mails?|inbox)\b/.test(q);
}

function wantsEmail(question) {
  return /\b(e-?mails?|inbox)\b/i.test(question);
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
  if (/\b(todos?|to-dos?|to do|tasks?|plate|have to do|due|overdue)\b/.test(q)) {
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

function noteBody(note, terms) {
  const rel = note.rel.replaceAll("\\", "/").toLowerCase();
  const keyFile = ["wiki/todo.md", "wiki/todo_mais.md", "wiki/log.md", "wiki/index.md", "wiki/finished.md"]
    .some((suffix) => rel.endsWith(suffix));
  if (keyFile || !terms?.length) return vaultExcerpt(note);
  return excerpt(note.text, terms);
}

function vaultExcerpt(note) {
  const rel = note.rel.replaceAll("\\", "/").toLowerCase();
  if (rel.endsWith("wiki/log.md")) return note.text.slice(-1800).trim();
  if (rel.endsWith("wiki/index.md")) return note.text.slice(0, 1800).trim();
  if (rel.endsWith("wiki/todo.md")) return note.text.slice(0, 4500).trim();
  return note.text.slice(0, 1800).trim();
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
  const cleaned = raw.toLowerCase().replace(/[^\w\s']/g, "").trim();
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
  "This is Iyad Sultan's KHCC second brain, an Obsidian vault on this Mac. It is not an Azure DevOps wiki and not a Git wiki.",
  "The wiki folder is named wiki/. The user may call it the wikis folder. There is no folder named wikis.",
  "Three files matter on every question about his notes. They are real files. Do not say they are missing when their text is in the notes.",
  "To-do dot md means wiki/todo.md. That file holds all of Iyad's to-dos. Open tasks are at the top. Spoken names for this same file: to-do.md, todo.md, to-do dot md, and the to-do list. There is no separate file named to-do.md.",
  "Index dot md means wiki/index.md. That file is the index of all wiki pages.",
  "Logs dot md means wiki/log.md. That file is the history of the wiki. Spoken names for this same file: logs.md, log.md, logs dot md, and the log. Newest history is at the end. There is no separate file named logs.md.",
  "wiki/todo_mais.md is Mais Tarawneh's open tasks. wiki/finished.md and wiki/finished_mais.md are completed tasks.",
  "When the question is about today, open tasks, or the to-do list, answer from wiki/todo.md. Name the open tasks.",
  "When the question is about the index or what wikis exist, answer from wiki/index.md.",
  "When the question is about history or the log, answer from wiki/log.md.",
  "New emails are text files in the raw/ folder at the vault root. They are not wiki pages. A question about email must be answered from those raw files.",
].join(" ");

const INSTRUCTIONS = [
  "You answer questions from a personal wiki of work notes, and from web pages this Mac looked up.",
  BRAIN_MAP,
  "Use the note excerpts for the user's own work. Use the web page excerpts only for facts that are not in the notes.",
  "First decide whether the question makes sense.",
  "If the wording is clumsy but a topic is clear, answer that topic. A request for the latest news means a short briefing of today's headlines.",
  "Ask what they mean only when there is no topic at all, such as a noise or 'can you hear me'.",
  "The prompt includes Earlier in this conversation. Use that for follow-up questions and for questions about the chat, such as what the user asked last time. Do not say a chat question is missing from the notes.",
  "Be brief and direct. Use a note only when that note actually states the fact. If the fact is only on a web page, say you found it on the web. Do not call a web page a note.",
  "Do not invent people, dates, or tasks.",
].join(" ");

// Added when the answer will be spoken (voice window, Hey my brain).
// Symbols like ** or # are read out loud, or make the voice stumble.
const SPOKEN_STYLE = [
  "Your answer will be read aloud by a voice assistant. Write it the way a helpful assistant talks.",
  "Use plain spoken sentences only.",
  "No markdown: no headings, bullet points, numbered lists, bold, italics, tables, or code.",
  "No asterisks, hashes, backticks, underscores, slashes, brackets, emoji, links, web addresses, file paths, or HTML tags.",
  "Do not end with a 'Note:' or 'Source:' line. If you name the note, say it inside a sentence, for example: Your to-do list note says...",
  "Turn a list into one sentence, for example: first..., then..., and finally....",
  "Write dates and numbers the way you would say them, for example June 25th, not 2026-06-25.",
].join(" ");

/**
 * Read OpenAI's event stream and forward only the answer text.
 * OpenAI sends blocks that look like:
 *   event: response.output_text.delta
 *   data: {"delta":"Hello"}
 */
async function streamAnswer(apiKey, prompt, res, model, reasoning, spoken) {
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
        input: prompt,
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
    console.error("OpenAI request failed:", upstream.status, details);
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
async function streamLocalAnswer(prompt, res, model, reasoning, spoken) {
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
              model.uncapped
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

function writeEvent(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
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

function readSavedFolders() {
  try {
    const data = JSON.parse(fsSync.readFileSync(FOLDERS_FILE, "utf8"));
    const saved = Array.isArray(data.folders) ? data.folders.filter((item) => typeof item === "string") : [];
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

function voiceInstructions() {
  return [
    "You are the user's second brain, in a live voice call.",
    "His to-dos are all in wiki/todo.md. He may call that file to-do dot md.",
    "wiki/index.md is the index of all wiki pages. He may call that file index dot md.",
    "wiki/log.md is the history of the wiki. He may call that file logs dot md. There is no separate logs.md.",
    "Stay silent unless the user's words start with Hey. Otherwise do not speak.",
    "You can hear the user through the microphone. Never say you cannot hear audio.",
    "Finish each reply. Do not stop mid-sentence.",
    "Whenever a folder is in use, follow its code.md. Those rulebooks are included below.",
    "When the user asks about their work, people, projects, or tasks, call search_notes first.",
    "Answer those questions only from the notes the tool returns and from the code.md rulebooks.",
    "If the notes do not contain the answer, say you could not find it in the notes.",
    "For a simple check like can you hear me, just confirm that you can hear them.",
    "",
    guideBlock(),
  ].join("\n");
}

async function reloadNotes() {
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
  guides = nextGuides;
  codePresent = nextPresent;
  await indexRawMail();
  console.log(`Loaded ${notes.length} notes from ${selected.length} folder(s)`);
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
    console.error("Failed while checking a folder:", folderPath, err?.message || err);
    return res.status(400).json({ error: "That folder was not found. Paste the full path." });
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
function startWhisperServer() {
  const port = new URL(WHISPER_SERVER_URL).port;
  const child = spawn(
    WHISPER_SERVER_BIN,
    ["-m", LOCAL_VOICE_MODEL, "--host", "127.0.0.1", "--port", port, "-l", "en", "-nt", "-bs", "1", "-bo", "1", "-nf", "-t", "4"],
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

/** Ask the warm whisper server. Returns null if it is not up, so the caller can use whisper-cli. */
async function transcribeWithServer(wav) {
  try {
    const fd = new FormData();
    fd.set("file", new Blob([await fs.readFile(wav)], { type: "audio/wav" }), "clip.wav");
    fd.set("response_format", "json");
    const response = await fetch(WHISPER_SERVER_URL, { method: "POST", body: fd });
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
    const dir = path.join(__dirname, "tmp");
    const stamp = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
    const source = path.join(dir, `${stamp}.webm`);
    const wav = path.join(dir, `${stamp}.wav`);
    try {
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(source, req.body);
      await runCommand(FFMPEG_BIN, ["-y", "-loglevel", "error", "-i", source, "-ac", "1", "-ar", "16000", wav]);
      const text = (await transcribeWithServer(wav)) ?? await runCommand(WHISPER_BIN, [
        "-m", LOCAL_VOICE_MODEL,
        "-f", wav,
        "-l", "en",
        "-nt",
        "-np",
        "-bs", "1",
        "-bo", "1",
        "-nf",
        "-t", "4",
      ]);
      const cleaned = text.replace(/\s+/g, " ").trim();
      res.json({ text: cleaned });
    } catch (err) {
      console.error("Failed while transcribing locally:", err?.message || err);
      res.status(500).json({ error: "The local voice model could not hear that clip." });
    } finally {
      await fs.rm(source, { force: true }).catch(() => {});
      await fs.rm(wav, { force: true }).catch(() => {});
    }
  }
);

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

app.get("/notes", (req, res) => {
  const query = typeof req.query.q === "string" ? req.query.q.trim() : "";
  if (!query) return res.json({ notes: "No question to search." });
  const hits = searchNotes(query, 5);
  if (!hits.length) return res.json({ notes: "No matching notes." });
  const notes = hits
    .map(({ note, terms }) => `Note: ${note.title}\nFile: ${note.rel}\n${excerpt(note.text, terms, 1200)}`)
    .join("\n\n---\n\n");
  res.json({ notes });
});

/**
 * Live voice session. Same model as Nemo: gpt-realtime-2.1-mini.
 * It receives microphone audio, so it can hear the user.
 */
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
        name: "search_notes",
        description: "Search the user's second-brain wiki and return the matching notes.",
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
      console.error("OpenAI voice session failed:", upstream.status, answerSdp);
      return res.status(upstream.status).json({
        error: "OpenAI voice session failed",
        details: safeJson(answerSdp),
      });
    }
    res.type("application/sdp").send(answerSdp);
  } catch (err) {
    const reason = err?.cause?.message || err?.message || String(err);
    console.error("Failed while starting the voice session:", reason);
    res.status(500).json({ error: `Could not reach OpenAI (${reason}).` });
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

  const model = getModel(DEFAULT_MODEL);
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
    res.json({ memory });
  } catch (err) {
    if (err?.name === "AbortError") return res.status(499).end();
    console.error("Failed while compressing the chat:", err?.message || err);
    res.status(500).json({ error: "Could not compress the chat." });
  }
});

app.post("/ask", async (req, res) => {
  const question = typeof req.body?.question === "string" ? req.body.question.trim() : "";
  if (!question) {
    return res.status(400).json({ error: "Type or say a question first." });
  }
  if (isNoise(question)) {
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.flushHeaders?.();
    writeEvent(res, { type: "ignored", message: "That was a noise, not a question." });
    writeEvent(res, { type: "done" });
    return res.end();
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
  if (!model.local && !apiKey) {
    return res.status(500).json({
      error: "Missing OPENAI_API_KEY. Add it to the .env file in the project folder.",
    });
  }

  const aboutChat = isChatQuestion(question);
  const history = cleanHistory(req.body?.history);
  const aboutEmail = wantsEmail(question);
  const hits = aboutChat
    ? []
    : aboutEmail
      ? await findRawEmails(question)
      : pinVaultNotes(question, searchNotes(question));

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

  if (!aboutChat && shouldBrowse(question)) writeEvent(res, { type: "status", message: "Looking on the web…" });
  const pages = aboutChat ? [] : await searchWeb(question);
  const sources = [
    ...hits.map(({ note }) => ({ title: note.title, file: note.rel })),
    ...pages.map((page) => ({ title: page.title, file: page.url })),
  ];
  writeEvent(res, { type: "sources", sources });

  // No matching notes often means the question was misheard or unclear.
  // The model still sees it, so it can ask what you meant instead of saying "not in the notes".

  try {
    const prompt = buildPrompt(question, hits, pages, history, cleanMemory(req.body?.memory));
    const spoken = req.body?.spoken === true;
    if (model.local) await streamLocalAnswer(prompt, res, model, reasoning, spoken);
    else await streamAnswer(apiKey, prompt, res, model, reasoning, spoken);
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

startWhisperServer();
startKokoro();

try {
  readSavedFolders();
  await reloadNotes();
} catch (err) {
  console.error("Failed while loading the wiki:", err?.message || err);
}

app.listen(PORT, () => {
  console.log(`\nSecond brain → http://localhost:${PORT}`);
  console.log(`Default model: ${DEFAULT_MODEL} (thinking off). Change it on the page.`);
  if (!process.env.OPENAI_API_KEY) {
    console.warn("OPENAI_API_KEY is not set. Copy .env.example to .env first.\n");
  }
  if (!notes.length) {
    console.warn(`No notes loaded. Is this path correct?\n${WIKI_PATH}\n`);
  }
});
