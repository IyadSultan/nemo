/**
 * Meaning search for the notes, next to the keyword search.
 *
 * Keyword search misses a note that says the same thing in other words
 * ("ASCO talk" vs "oncology presentation"). This file turns each note into
 * a few number lists (embeddings) with a small local Ollama model, and finds
 * the notes whose meaning is closest to the question.
 *
 * - Runs on this Mac (Ollama). Note text never leaves the machine.
 * - Embeddings are cached in second-brain/tmp (git-ignored), keyed by a hash
 *   of each piece of text, so only new or changed notes are embedded again.
 * - If Ollama is down or the index is still building, search() returns
 *   nothing and the keyword search works alone.
 */

import fs from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";

const CHUNK_CHARS = 1000;
const MAX_CHUNKS_PER_NOTE = 8;
const BATCH = 32;

// Each embedding model was trained with its own query/document wording.
const PREFIXES = {
  "nomic-embed-text": { minScore: 0.6, query: (q) => `search_query: ${q}`, doc: (t, x) => `search_document: ${t}\n${x}` },
  embeddinggemma: { minScore: 0.25, query: (q) => `task: search result | query: ${q}`, doc: (t, x) => `title: ${t} | text: ${x}` },
  "qwen3-embedding:0.6b": {
    minScore: 0.5,
    query: (q) => `Instruct: Given a question, find the personal notes that answer it\nQuery: ${q}`,
    doc: (t, x) => `${t}\n${x}`,
  },
};

/** Split a note into pieces of about CHUNK_CHARS, cutting at blank lines where possible. */
function chunkNote(note, docPrefix) {
  const body = note.text.slice(note.title.length).trim();
  const pieces = [];
  let current = "";
  for (const para of body.split(/\n\s*\n/)) {
    if (current && current.length + para.length > CHUNK_CHARS) {
      pieces.push(current);
      current = "";
    }
    current = current ? `${current}\n\n${para}` : para;
    while (current.length > CHUNK_CHARS * 1.5) {
      pieces.push(current.slice(0, CHUNK_CHARS));
      current = current.slice(CHUNK_CHARS);
    }
    if (pieces.length >= MAX_CHUNKS_PER_NOTE) break;
  }
  if (current && pieces.length < MAX_CHUNKS_PER_NOTE) pieces.push(current);
  if (!pieces.length) pieces.push("");
  return pieces.map((text) => ({ text, input: docPrefix(note.title, text) }));
}

function hashOf(text) {
  return crypto.createHash("sha1").update(text).digest("hex");
}

function normalize(vec) {
  let sum = 0;
  for (const x of vec) sum += x * x;
  const len = Math.sqrt(sum) || 1;
  return Float32Array.from(vec, (x) => x / len);
}

export function createSemanticIndex({ ollamaUrl, model, cacheFile }) {
  /** @type {{ note: object, text: string, vec: Float32Array }[]} */
  let chunks = [];
  let ready = false;
  let buildId = 0;
  const prefix = PREFIXES[model] || PREFIXES["nomic-embed-text"];

  async function embed(inputs, timeoutMs) {
    const res = await fetch(`${ollamaUrl}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, input: inputs, keep_alive: "1h" }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`Ollama embed ${res.status}: ${await res.text()}`);
    const data = await res.json();
    return data.embeddings.map(normalize);
  }

  async function loadCache() {
    try {
      const raw = JSON.parse(await fs.readFile(cacheFile, "utf8"));
      if (raw.model !== model) return new Map();
      return new Map(
        Object.entries(raw.vectors).map(([hash, b64]) => {
          const buf = Buffer.from(b64, "base64");
          return [hash, new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4)];
        })
      );
    } catch {
      return new Map();
    }
  }

  async function saveCache(cache) {
    const vectors = {};
    for (const [hash, vec] of cache) {
      vectors[hash] = Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength).toString("base64");
    }
    await fs.mkdir(path.dirname(cacheFile), { recursive: true });
    const tmp = `${cacheFile}.tmp`;
    await fs.writeFile(tmp, JSON.stringify({ model, vectors }));
    await fs.rename(tmp, cacheFile);
  }

  /** Embed every note (reusing the cache). Safe to call again after a reload. */
  async function build(notes) {
    const id = ++buildId;
    ready = false;
    const started = Date.now();
    const cache = await loadCache();
    const wanted = [];
    for (const note of notes) {
      for (const piece of chunkNote(note, prefix.doc)) {
        wanted.push({ note, text: piece.text, input: piece.input, hash: hashOf(piece.input) });
      }
    }
    const missing = [...new Map(wanted.filter((c) => !cache.has(c.hash)).map((c) => [c.hash, c])).values()];
    for (let i = 0; i < missing.length; i += BATCH) {
      if (id !== buildId) return; // A newer reload started; let it finish instead.
      const batch = missing.slice(i, i + BATCH);
      const vecs = await embed(batch.map((c) => c.input), 120000);
      batch.forEach((c, j) => cache.set(c.hash, vecs[j]));
      if (i && i % (BATCH * 20) === 0) console.log(`Meaning index: ${i}/${missing.length} new pieces embedded`);
    }
    if (id !== buildId) return;
    // Keep vectors for folders that are not selected now, so switching back is instant.
    if (missing.length) await saveCache(cache);
    chunks = wanted.map((c) => ({ note: c.note, text: c.text, vec: cache.get(c.hash) }));
    ready = true;
    console.log(
      `Meaning index ready: ${chunks.length} pieces from ${notes.length} notes ` +
        `(${missing.length} newly embedded, ${((Date.now() - started) / 1000).toFixed(1)}s)`
    );
  }

  /**
   * Notes ranked by meaning. Each note scores as its closest piece.
   * Pieces below the model's minScore are dropped, so an off-topic question finds nothing.
   * @returns {Promise<{ note: object, score: number, text: string }[]>}
   */
  async function search(question, limit = 20) {
    if (!ready || !chunks.length) return [];
    let query;
    try {
      [query] = await embed([prefix.query(question)], 1500);
    } catch (err) {
      console.error("Meaning search skipped:", err?.message || err);
      return [];
    }
    const best = new Map();
    for (const chunk of chunks) {
      let score = 0;
      for (let i = 0; i < query.length; i += 1) score += query[i] * chunk.vec[i];
      if (score < prefix.minScore) continue;
      const prev = best.get(chunk.note);
      if (!prev || score > prev.score) best.set(chunk.note, { note: chunk.note, score, text: chunk.text });
    }
    return [...best.values()].sort((a, b) => b.score - a.score).slice(0, limit);
  }

  return { build, search, isReady: () => ready };
}
