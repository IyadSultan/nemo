/**
 * PDF and Word files as notes, so keyword and meaning search can find them.
 *
 * Text comes from pdftotext (Poppler) for .pdf and macOS textutil for .docx.
 * Extracted text is cached in tmp/doc-text.json by path, size and date,
 * so each file is read once until it changes.
 * OneDrive files that are only in the cloud (not downloaded) are skipped:
 * reading them would download every PDF in the folder.
 */

import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

const CACHE_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "tmp", "doc-text.json");
const PDFTOTEXT = "/opt/homebrew/bin/pdftotext";
const TEXTUTIL = "/usr/bin/textutil";
const MAX_BYTES = 25 * 1024 * 1024;
const MAX_DOCS_PER_FOLDER = 500;
// Search reads the whole text; long reports only need their first pages.
const MAX_TEXT = 60_000;
// macOS marks cloud-only files with this st_flags bit (SF_DATALESS).
const DATALESS = 0x40000000;

let cache = null;

function run(bin, args) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { maxBuffer: 64 * 1024 * 1024, timeout: 60_000 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

async function loadCache() {
  if (cache) return cache;
  try {
    cache = JSON.parse(await fs.readFile(CACHE_FILE, "utf8"));
  } catch {
    cache = {};
  }
  return cache;
}

async function saveCache() {
  await fs.mkdir(path.dirname(CACHE_FILE), { recursive: true });
  await fs.writeFile(CACHE_FILE, JSON.stringify(cache), "utf8");
}

async function isCloudOnly(file) {
  try {
    const flags = Number(await run("/usr/bin/stat", ["-f", "%f", file]));
    return (flags & DATALESS) !== 0;
  } catch {
    return false;
  }
}

export async function extractText(file) {
  const out = file.toLowerCase().endsWith(".pdf")
    ? await run(PDFTOTEXT, ["-q", "-enc", "UTF-8", file, "-"])
    : await run(TEXTUTIL, ["-convert", "txt", "-stdout", file]);
  return out.replace(/\f/g, "\n\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, MAX_TEXT);
}

function listDocs(root, skipDirs) {
  const found = [];
  function walk(dir) {
    let entries;
    try {
      entries = fsSync.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      console.error(`Failed while listing folder for documents: ${dir}`, err?.message || err);
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name.startsWith("~$")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!skipDirs.has(entry.name)) walk(full);
      } else if (entry.isFile() && /\.(pdf|docx)$/i.test(entry.name)) {
        found.push(full);
      }
    }
  }
  walk(root);
  return found;
}

/** Read the PDFs and Word files under root and return them as notes. */
export async function loadDocs(root, skipDirs) {
  const store = await loadCache();
  const files = listDocs(root, skipDirs);
  if (files.length > MAX_DOCS_PER_FOLDER) {
    console.warn(`${files.length} documents in ${root}; reading the newest ${MAX_DOCS_PER_FOLDER}.`);
  }
  const withStats = files.map((file) => ({ file, stat: fsSync.statSync(file, { throwIfNoEntry: false }) }))
    .filter(({ stat }) => stat && stat.size > 0 && stat.size <= MAX_BYTES)
    .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)
    .slice(0, MAX_DOCS_PER_FOLDER);

  const docs = [];
  let cloudOnly = 0;
  let failed = 0;
  let changed = false;
  for (const { file, stat } of withStats) {
    const key = `${stat.size}:${Math.round(stat.mtimeMs)}`;
    let text = store[file]?.key === key ? store[file].text : null;
    if (text === null) {
      if (await isCloudOnly(file)) {
        cloudOnly += 1;
        continue;
      }
      try {
        text = await extractText(file);
      } catch (err) {
        failed += 1;
        console.error(`Failed while reading document: ${path.basename(file)}`, err?.message || err);
        text = "";
      }
      store[file] = { key, text };
      changed = true;
    }
    if (!text) continue;
    const rel = path.relative(root, file);
    const title = path.basename(file).replace(/\.(pdf|docx)$/i, "").replace(/[-_]+/g, " ");
    const full = `${title}\n${text}`;
    docs.push({ rel, title, text: full, lower: full.toLowerCase() });
  }
  if (changed) await saveCache();
  console.log(`Read ${docs.length} PDF/Word file(s) from ${root}` +
    (cloudOnly ? `; ${cloudOnly} skipped because they are only in OneDrive (not downloaded)` : "") +
    (failed ? `; ${failed} could not be read` : ""));
  return docs;
}
