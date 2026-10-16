/**
 * The notes folders: the saved list, which ones are selected, the allow-list that keeps
 * the server inside the home folder, and reloading every note when the selection changes.
 */

import { FOLDERS_FILE, SKIP_DIRS, WIKI_PATH } from "./config.js";
import { syncSuggestions } from "./deskjobs.js";
import { brainNotes } from "./brain.js";
import { loadDocs } from "./docs.js";
import { indexRawMail } from "./mail.js";
import { loadWiki, semantic } from "./notes.js";
import { voiceInstructions } from "./prompt.js";
import { runCommand } from "./shell.js";
import { folders, notes, selected, setFolders, setNotes, setSelected } from "./state.js";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export function folderState() {
  return {
    folders: folders.map((folderPath) => ({
      path: folderPath,
      name: path.basename(folderPath),
      selected: selected.includes(folderPath),
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
export function isAllowedPlace(folderPath) {
  const home = path.resolve(os.homedir());
  const relHome = path.relative(home, folderPath);
  if (relHome === "" || (!relHome.startsWith("..") && !path.isAbsolute(relHome))) return true;
  const relVol = path.relative("/Volumes", folderPath);
  return relVol !== "" && !relVol.startsWith("..") && !path.isAbsolute(relVol);
}

export function hasBlockedPart(folderPath) {
  const blocked = new Set([".ssh", ".aws", ".gnupg", ".kube"]);
  return String(folderPath).split(path.sep).some((part) => blocked.has(part));
}

/** True when the folder exists and both the path and its real location are allowed. */
export function folderIsAllowed(folderPath) {
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
export function savedFolderOk(folderPath) {
  const resolved = path.resolve(String(folderPath || ""));
  if (!isAllowedPlace(resolved) || hasBlockedPart(resolved)) return false;
  try {
    const real = fsSync.realpathSync(resolved);
    return isAllowedPlace(real) && !hasBlockedPart(real);
  } catch {
    return true;
  }
}

export function readSavedFolders() {
  try {
    const data = JSON.parse(fsSync.readFileSync(FOLDERS_FILE, "utf8"));
    const saved = Array.isArray(data.folders)
      ? data.folders.filter((item) => typeof item === "string" && savedFolderOk(item))
      : [];
    setFolders(saved.length ? saved : [WIKI_PATH]);
    if (Array.isArray(data.selected)) {
      setSelected(data.selected.filter((item) => folders.includes(item)));
    } else if (data.active === "all") {
      setSelected([...folders]);
    } else if (typeof data.active === "string" && folders.includes(data.active)) {
      setSelected([data.active]);
    } else {
      setSelected([folders[0]]);
    }
  } catch {
    setFolders([WIKI_PATH]);
    setSelected([WIKI_PATH]);
  }
}

export function saveFolders() {
  fsSync.writeFileSync(FOLDERS_FILE, JSON.stringify({ folders, selected }, null, 2));
}

// Bumped on every reload, so a slow document read for old folders is dropped.
export let notesGeneration = 0;

export async function reloadNotes() {
  const generation = ++notesGeneration;
  const loaded = [];
  for (const root of selected) {
    loaded.push(...(await loadWiki(root)));
  }
  // brain.md sections are notes too, so older days can be found by search.
  loaded.push(...brainNotes());
  setNotes(loaded);
  semantic.build(notes).catch((err) => console.error("Failed while building the meaning index:", err?.message || err));
  await indexRawMail();
  syncSuggestions();
  console.log(`Loaded ${notes.length} notes from ${selected.length} folder(s)`);
  // PDFs and Word files can take minutes the first time, so they join the notes in the background.
  addDocuments(generation, [...selected]).catch((err) => console.error("Failed while reading PDF and Word files:", err?.message || err));
}

export async function addDocuments(generation, roots) {
  const docs = [];
  for (const root of roots) docs.push(...(await loadDocs(root, SKIP_DIRS)));
  if (generation !== notesGeneration || !docs.length) return;
  setNotes([...notes, ...docs]);
  semantic.build(notes).catch((err) => console.error("Failed while building the meaning index:", err?.message || err));
}

export function registerFolders(app) {
  app.get("/folders", (_req, res) => {
    res.json(folderState());
  });

  // Opens the Mac folder window (the same one Finder and other apps use).
  // An empty path means the user pressed Cancel.
  app.post("/folders/pick", async (_req, res) => {
    try {
      const out = await runCommand("osascript", [
        "-e",
        'POSIX path of (choose folder with prompt "Add this folder:")',
      ]);
      res.json({ path: path.resolve(out.trim()) });
    } catch {
      res.json({ path: "" });
    }
  });

  app.post("/folders", async (req, res) => {
    const raw = typeof req.body?.path === "string" ? req.body.path.trim() : "";
    const folderPath = raw ? path.resolve(raw) : "";
    try {
      const stat = await fs.stat(folderPath);
      if (!stat.isDirectory()) {
        return res.status(400).json({ error: "That path is not a folder." });
      }
    } catch (err) {
      console.error("Failed while checking a folder:", err?.message || err);
      return res.status(400).json({ error: "That folder was not found. Browse for it, or paste the full path." });
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
    setSelected(paths);
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
    setFolders(folders.filter((item) => item !== folderPath));
    setSelected(selected.filter((item) => item !== folderPath));
    saveFolders();
    try {
      await reloadNotes();
    } catch (err) {
      console.error("Failed while removing a folder:", err?.message || err);
      return res.status(500).json({ error: "Could not refresh the notes after removing that folder." });
    }
    res.json(folderState());
  });
}

/** brain.md changed (nightly summary or Clear & save): swap its sections in the notes. */
export function refreshBrainNotes() {
  setNotes([...notes.filter((note) => !note.rel.startsWith("brain.md#")), ...brainNotes()]);
  semantic.build(notes).catch((err) => console.error("Failed while building the meaning index:", err?.message || err));
}
