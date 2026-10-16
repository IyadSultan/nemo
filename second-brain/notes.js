/**
 * The wiki notes in memory: load them, search by keyword and by meaning, and cut the
 * excerpts that go into a prompt. Pinned files such as todo.md and index.md live here too.
 */

import { EMBED_MODEL, OLLAMA_URL, SKIP_DIRS, STOP_WORDS, __dirname } from "./config.js";
import { createSemanticIndex } from "./embed.js";
import { wantsFile } from "./intents.js";
import { notes } from "./state.js";
import fs from "node:fs/promises";
import path from "node:path";

// Meaning search runs next to keyword search. Small local model; ~20 ms per question.
export const semantic = createSemanticIndex({
  ollamaUrl: OLLAMA_URL,
  model: EMBED_MODEL,
  cacheFile: path.join(__dirname, "tmp", "embeddings.json"),
});

/**
 * Read every .md file under the wiki into memory once.
 * Searching memory is much faster than opening files on every question.
 */
export async function loadWiki(root) {
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
export function parseNote(rel, raw) {
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
export function queryTerms(question) {
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
export async function searchNotes(question, limit = 4) {
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
export function keywordNotes(terms) {
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
export function excerpt(text, terms, maxLen = 900) {
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

// Words that mean "go look", not the name of the file. They are ignored inside the index and the log.
export const FILE_SEARCH_NOISE = new Set([
  "find", "file", "files", "document", "documents", "paper", "papers",
  "locate", "look", "looking", "where", "search", "note", "notes",
  "report", "reports", "pdf", "pdfs", "docx", "xlsx", "spreadsheet",
  "spreadsheets", "deck", "decks", "slide", "slides", "wiki", "page", "pages",
  "called", "named",
]);

/** Find a loaded note by the end of its path, such as wiki/todo.md. */
export function findNote(relSuffix) {
  const want = relSuffix.toLowerCase();
  return notes.find((note) => note.rel.replaceAll("\\", "/").toLowerCase().endsWith(want)) || null;
}

/**
 * Keyword search misses todo.md when the question says "to-do" or "today".
 * Pin the real files so the model can see them.
 */
export function pinVaultNotes(question, hits) {
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
export function fileCatalogHits(question) {
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
export function matchingLines(text, terms, maxLines) {
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
export function indexHeadings(text) {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("#"))
    .slice(0, 40)
    .join("\n");
}

/** Short slices of a long file around the search words. Later slices are preferred when scores tie. */
export function matchingWindows(text, terms, maxWindows, radius) {
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
export async function notesForQuestion(question, limit = 4) {
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

export function noteBody(note, terms) {
  const rel = note.rel.replaceAll("\\", "/").toLowerCase();
  const keyFile = ["wiki/todo.md", "wiki/todo_mais.md", "wiki/log.md", "wiki/index.md", "wiki/finished.md"]
    .some((suffix) => rel.endsWith(suffix));
  if (keyFile || !terms?.length) {
    if (rel.startsWith("raw/") && note.text.length > 1800) return note.text.slice(0, 2400).trim();
    return vaultExcerpt(note);
  }
  return excerpt(note.text, terms);
}

export function vaultExcerpt(note) {
  const rel = note.rel.replaceAll("\\", "/").toLowerCase();
  if (rel.endsWith("wiki/log.md")) return note.text.slice(-1800).trim();
  if (rel.endsWith("wiki/index.md")) return note.text.slice(0, 1800).trim();
  if (rel.endsWith("wiki/todo.md")) return note.text.slice(0, 4500).trim();
  return note.text.slice(0, 1800).trim();
}
