/**
 * Upload a document (PDF, Word, PowerPoint) from the voice page.
 *
 * - A copy of the file goes into the meeting folder, named with the date and time.
 * - Next to it, a wiki page: the model's summary and key points, then the full text.
 *   That page is a note, so later questions can find the document.
 * - The summary also goes into the current conversation, so "what does it say about…" works at once.
 *
 * Text comes from pdftotext (PDF), textutil (Word, RTF), and the slide XML inside a .pptx.
 * File names and text are never logged (they may name patients).
 */

import { eventFolderName, freeChildPath } from "./savedir.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";

const PDFTOTEXT = "/opt/homebrew/bin/pdftotext";
const TEXTUTIL = "/usr/bin/textutil";
const UNZIP = "/usr/bin/unzip";
// The model reads this much; the wiki page keeps more.
const MODEL_CHARS = 60_000;
const PAGE_CHARS = 200_000;

export const DOCUMENT_TYPES = new Set([".pdf", ".docx", ".doc", ".rtf", ".odt", ".pptx", ".txt", ".md"]);

function run(bin, args) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { maxBuffer: 128 * 1024 * 1024, timeout: 120_000 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

function decodeXml(text) {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, "&");
}

/** One line per paragraph from a slide's XML. */
function slideText(xml) {
  return xml
    .split(/<\/a:p>/)
    .map((para) => [...para.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => decodeXml(m[1])).join(""))
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}

/** Slides in order (slide2 before slide10), each with its speaker notes. */
async function pptxText(file) {
  const names = (await run(UNZIP, ["-Z1", file])).split("\n");
  const numbered = (pattern) => names
    .map((name) => [name, name.match(pattern)])
    .filter(([, m]) => m)
    .sort((a, b) => Number(a[1][1]) - Number(b[1][1]))
    .map(([name, m]) => [Number(m[1]), name]);
  const notes = new Map(numbered(/^ppt\/notesSlides\/notesSlide(\d+)\.xml$/));
  const parts = [];
  for (const [n, name] of numbered(/^ppt\/slides\/slide(\d+)\.xml$/)) {
    const body = slideText(await run(UNZIP, ["-p", file, name]));
    let said = "";
    if (notes.has(n)) {
      // Notes slides also hold the slide number as text; keep only real sentences.
      said = slideText(await run(UNZIP, ["-p", file, notes.get(n)])).split("\n").filter((line) => !/^\d+$/.test(line)).join("\n");
    }
    parts.push([`Slide ${n}`, body, said ? `Notes: ${said}` : ""].filter(Boolean).join("\n"));
  }
  return parts.join("\n\n");
}

/** The plain text of a document, tidied. "" when it has none (a scanned PDF, for example). */
export async function extractDocument(file) {
  const ext = path.extname(file).toLowerCase();
  let out;
  if (ext === ".pdf") out = await run(PDFTOTEXT, ["-q", "-enc", "UTF-8", file, "-"]);
  else if (ext === ".pptx") out = await pptxText(file);
  else if (ext === ".txt" || ext === ".md") out = await fs.readFile(file, "utf8");
  else out = await run(TEXTUTIL, ["-convert", "txt", "-stdout", file]);
  return String(out).replace(/\f/g, "\n\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

const WIKI_INSTRUCTION = [
  "You write a wiki page about one document for Dr Iyad Sultan's second brain.",
  "The first line is TITLE: followed by a short title for the document.",
  "Then write Markdown with these sections:",
  "## Summary: three to six sentences.",
  "## Key points: up to twelve bullets.",
  "## Details: short ### subsections by topic, only when the document is long enough to need them.",
  "## Open questions: only when the document leaves something open or undecided.",
  "Only write what is in the document. Keep numbers, dates, and doses exactly as written. Do not add advice.",
].join("\n");

/** "TITLE: x" first line, then the page. */
function splitTitle(raw) {
  const text = String(raw || "").trim();
  const match = text.match(/^TITLE:\s*(.+)\n?/i);
  if (!match) return { title: "", body: text };
  return { title: match[1].replace(/[#*]/g, "").trim().slice(0, 120), body: text.slice(match[0].length).trim() };
}

/** The text under "## Summary", for the conversation. */
function summaryOf(body) {
  const match = String(body).match(/##\s*Summary\s*\n([\s\S]*?)(?:\n##\s|$)/i);
  return (match ? match[1] : body).trim().slice(0, 1400);
}

function stamp(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/**
 * Save the file and its wiki page in `folder`. ask(instruction, text) calls the model.
 * Returns { title, summary, wikiPath, copyPath, wikiText }. Throws for an unsupported type.
 */
export async function ingestDocument({ name, bytes, folder, ask, when = new Date() }) {
  const ext = path.extname(String(name || "")).toLowerCase();
  if (!DOCUMENT_TYPES.has(ext)) throw Object.assign(new Error("Upload a PDF, Word, or PowerPoint file."), { status: 400 });
  if (!bytes?.length) throw Object.assign(new Error("That file is empty."), { status: 400 });
  const original = path.basename(String(name)).replace(/[\r\n]/g, " ");
  const plain = path.basename(original, path.extname(original));
  const slug = plain.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "document";
  const stem = `${stamp(when)}-${slug}`;
  await fs.mkdir(folder, { recursive: true });
  const copyName = `${stem}${ext}`;
  const copyPath = path.join(folder, copyName);
  await fs.writeFile(copyPath, bytes);

  let text = "";
  try {
    text = await extractDocument(copyPath);
  } catch (err) {
    console.error("Failed while reading the text of an uploaded document:", err?.message || err);
  }

  let title = plain;
  let body;
  if (!text) {
    body = "## Summary\n\nNo text could be read from this file. It may be a scanned document or only pictures.";
  } else {
    try {
      const page = splitTitle(await ask(WIKI_INSTRUCTION, `File: ${original}\n\n${text.slice(0, MODEL_CHARS)}`));
      if (page.body.length < 20) throw new Error("The model returned no wiki page.");
      title = page.title || plain;
      body = page.body;
    } catch (err) {
      console.error("Failed while writing the wiki page for an uploaded document:", err?.message || err);
      body = "## Summary\n\nThe summary could not be written. The full text is below.";
    }
  }

  const uploaded = when.toLocaleString("en-GB", {
    weekday: "long", day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit",
  });
  const wikiText = [
    `# ${title}`,
    "",
    `- **Uploaded:** ${uploaded}`,
    `- **Original file:** [${original}](<${copyName}>)`,
    "",
    body,
    ...(text ? ["", "## Full text", "", text.slice(0, PAGE_CHARS)] : []),
    "",
  ].join("\n");
  const wikiPath = path.join(folder, `${stem}.md`);
  await fs.writeFile(wikiPath, wikiText, "utf8");
  return { title, summary: summaryOf(body), wikiPath, copyPath, wikiText };
}

/**
 * Save a document into its own folder, or into a meeting/lecture folder that is already open.
 * into: that open folder, when the user attached the file during a meeting or lecture.
 * Otherwise the folder is yyyymmdd_title under parent (raw/meetings). parent is created if needed.
 */
export async function saveUploadedDocument({ name, bytes, ask, when = new Date(), parent, into = "" }) {
  if (into) {
    await fs.mkdir(into, { recursive: true });
    const doc = await ingestDocument({ name, bytes, folder: into, ask, when });
    return { ...doc, folder: into };
  }
  const staging = await fs.mkdtemp(path.join(os.tmpdir(), "brain-doc-"));
  try {
    const doc = await ingestDocument({ name, bytes, folder: staging, ask, when });
    await fs.mkdir(parent, { recursive: true });
    const dest = freeChildPath(parent, eventFolderName(when, doc.title, "document"));
    await fs.rename(staging, dest);
    return {
      ...doc,
      folder: dest,
      wikiPath: path.join(dest, path.basename(doc.wikiPath)),
      copyPath: path.join(dest, path.basename(doc.copyPath)),
    };
  } catch (err) {
    await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}
