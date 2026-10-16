/**
 * Skills like Claude Code: find every SKILL.md on this Mac, match one to a question,
 * and write the instructions the model follows while a skill is on.
 */

import { __dirname } from "./config.js";
import { writeEvent } from "./models.js";
import { folders, selected } from "./state.js";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const SKILLS_DIR = path.join(__dirname, "skills");

export const HOME_SKILLS = path.join(os.homedir(), ".claude", "skills");

export const CLAUDE_SETTINGS = path.join(os.homedir(), ".claude", "settings.json");

export const INSTALLED_PLUGINS = path.join(os.homedir(), ".claude", "plugins", "installed_plugins.json");

// A skill Claude would load is at most 1 MB. The spoken prompt keeps the first 100,000 characters.
export const SKILL_FILE_MAX = 1024 * 1024;

export const SKILL_BODY_MAX = 100_000;

// Do not walk these while looking for project skill folders.
export const SKILL_SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "target", "vendor",
  "__pycache__", ".venv", "venv", ".trash", "cache", "tmp",
]);

/** "PRD simple" becomes the file name prd-simple. */
export function skillFileId(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/\.md$/i, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export function skillIdOk(id) {
  return /^[a-z0-9][a-z0-9_-]{0,80}$/.test(id);
}

/** The name and description between the --- lines at the top of a skill file. */
export function skillFrontMatter(block) {
  const fields = {};
  let key = "";
  let folded = false;
  const lines = [];
  const save = () => {
    if (!key) return;
    let value = lines.join(folded ? " " : "\n").trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    fields[key] = value;
    key = "";
    folded = false;
    lines.length = 0;
  };
  for (const line of String(block || "").split(/\r?\n/)) {
    const next = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/);
    if (next) {
      save();
      key = next[1].toLowerCase();
      const rest = next[2].trim();
      if (rest === ">" || rest === "|") folded = rest === ">";
      else lines.push(rest);
    } else if (key && (line.startsWith(" ") || line.startsWith("\t"))) {
      lines.push(line.trim());
    } else {
      save();
    }
  }
  save();
  return fields;
}

/** A skill file can start with a short name and description between --- lines. */
export function parseSkill(text, id, dir) {
  const raw = String(text || "");
  let name = id;
  let description = "";
  let body = raw.trim();
  const front = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (front) {
    body = raw.slice(front[0].length).trim();
    const fields = skillFrontMatter(front[1]);
    if (fields.name) name = fields.name.replace(/\s+/g, " ").trim();
    if (fields.description) description = fields.description;
  }
  return {
    id,
    name: name.slice(0, 80),
    description: description.replace(/\s+/g, " ").trim().slice(0, 240),
    body: body.slice(0, SKILL_BODY_MAX),
    // The folder that holds this skill, so Claude can open its other files.
    dir: dir || "",
  };
}

/** A cloud-only OneDrive file has a size but no blocks on disk. Skip it. */
export function skillFileReady(stat) {
  if (!stat?.isFile() || stat.size <= 0 || stat.size > SKILL_FILE_MAX) return false;
  if (stat.blocks === 0 && stat.size > 4096) return false;
  return true;
}

export async function skillMarkdownIn(dir) {
  for (const name of ["SKILL.md", "skill.md"]) {
    try {
      const file = path.join(dir, name);
      const stat = await fs.stat(file);
      if (skillFileReady(stat)) return file;
    } catch {
      // This folder is not a skill, or the file is not on disk.
    }
  }
  return "";
}

/**
 * Read one skill into the map. The first folder that has a name wins,
 * so a skill in the notes folder beats the same name in the home folder.
 */
export async function rememberSkill(bag, id, file) {
  if (!skillIdOk(id) || bag.has(id)) return;
  try {
    const text = await fs.readFile(file, "utf8");
    bag.set(id, parseSkill(text, id, path.dirname(file)));
  } catch (err) {
    console.error("Failed while reading a skill:", err?.message || err);
  }
}

/**
 * One skills folder, the way Claude Code reads it.
 * A skill is either name/SKILL.md or a plain name.md file.
 * Folders such as synced/<account>/<name>/SKILL.md are included too.
 */
export async function walkSkillDir(dir, depth, bag, skipNames = new Set()) {
  if (depth > 4) return;
  let entries = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err?.code !== "ENOENT" && err?.code !== "ENOTDIR") {
      console.error("Failed while reading skills:", err?.message || err);
    }
    return;
  }
  if (depth === 0) {
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) continue;
      const id = skillFileId(entry.name);
      await rememberSkill(bag, id, path.join(dir, entry.name));
    }
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") || SKILL_SKIP_DIRS.has(entry.name) || skipNames.has(entry.name)) continue;
    const child = path.join(dir, entry.name);
    let isDirectory = entry.isDirectory();
    if (!isDirectory && entry.isSymbolicLink()) {
      try {
        isDirectory = (await fs.stat(child)).isDirectory();
      } catch {
        isDirectory = false;
      }
    }
    if (!isDirectory) continue;
    const skillFile = await skillMarkdownIn(child);
    if (skillFile) {
      await rememberSkill(bag, skillFileId(entry.name), skillFile);
      continue;
    }
    await walkSkillDir(child, depth + 1, bag);
  }
}

/** .claude/skills and .agents/skills inside one project. */
export async function addProjectSkillDirs(projectDir, bag) {
  await walkSkillDir(path.join(projectDir, ".claude", "skills"), 0, bag);
  await walkSkillDir(path.join(projectDir, ".agents", "skills"), 0, bag);
}

/** The project itself, plus projects nested a couple of folders down. */
export async function addNearbyProjectSkills(dir, depth, bag) {
  await addProjectSkillDirs(dir, bag);
  if (depth <= 0) return;
  let entries = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".") || SKILL_SKIP_DIRS.has(entry.name)) continue;
    await addNearbyProjectSkills(path.join(dir, entry.name), depth - 1, bag);
  }
}

/** Plugins turned on in Claude's settings. Old copies in the cache are left out. */
export function enabledPluginDirs() {
  let enabled = {};
  let installed = {};
  try {
    enabled = JSON.parse(fsSync.readFileSync(CLAUDE_SETTINGS, "utf8")).enabledPlugins || {};
  } catch {
    enabled = {};
  }
  try {
    installed = JSON.parse(fsSync.readFileSync(INSTALLED_PLUGINS, "utf8")).plugins || {};
  } catch {
    installed = {};
  }
  const root = path.join(os.homedir(), ".claude", "plugins") + path.sep;
  const dirs = [];
  for (const [name, on] of Object.entries(enabled)) {
    if (!on || !Array.isArray(installed[name])) continue;
    for (const item of installed[name]) {
      const installPath = typeof item?.installPath === "string" ? path.resolve(item.installPath) : "";
      if (installPath.startsWith(root)) dirs.push(installPath);
    }
  }
  return dirs;
}

export let skillCache = { key: "", at: 0, skills: [] };

/**
 * Every skill Claude Code can see.
 * Local skills (the notes folders, this app, and other projects) come first.
 * Then the global skills in ~/.claude/skills, including ones synced from claude.ai.
 * Then the plugins that are turned on.
 * The same name is kept once: the earlier place wins.
 */
export async function listSkills() {
  const orderedFolders = [
    ...selected,
    ...folders.filter((folder) => !selected.includes(folder)),
  ];
  const key = orderedFolders.join("\n");
  if (skillCache.skills.length && skillCache.key === key && Date.now() - skillCache.at < 60_000) {
    return skillCache.skills;
  }
  const bag = new Map();
  try {
    for (const folder of orderedFolders) {
      await addNearbyProjectSkills(folder, 2, bag);
    }
    await addProjectSkillDirs(path.join(__dirname, ".."), bag);
    await walkSkillDir(SKILLS_DIR, 0, bag);
    // User skills before the synced copies, so the copy in ~/.claude/skills wins.
    await walkSkillDir(HOME_SKILLS, 0, bag, new Set(["synced"]));
    await walkSkillDir(path.join(os.homedir(), ".agents", "skills"), 0, bag);
    for (const pluginDir of enabledPluginDirs()) {
      await walkSkillDir(pluginDir, 0, bag);
    }
    await walkSkillDir(path.join(HOME_SKILLS, "synced"), 0, bag);
    await addNearbyProjectSkills(path.join(os.homedir(), "code"), 2, bag);
  } catch (err) {
    console.error("Failed while reading skills:", err?.message || err);
  }
  const skills = [...bag.values()].sort((a, b) => a.name.localeCompare(b.name));
  if (skills.length !== skillCache.skills.length) {
    console.log(`Skills: ${skills.length} ready. Type / in the question box.`);
  }
  skillCache = { key, at: Date.now(), skills };
  return skills;
}

/** "Stop the skill" puts the current skill away. */
export function mentionsSkillStop(question) {
  const q = String(question || "").toLowerCase();
  return /\b(stop|drop|done with|forget|close|put away|turn off)\b/.test(q) && /\bskills?\b/.test(q);
}

/** "Use the PRD simple skill" or "write a PRD" picks a skill by its name. */
export function matchSkill(question, skills) {
  const q = String(question || "").toLowerCase().replace(/['’]/g, "");
  let found = null;
  let foundLength = 0;
  for (const skill of skills) {
    const names = [skill.name, skill.id.replace(/-/g, " ")]
      .map((name) => name.toLowerCase().trim())
      .filter((name) => name.length >= 3);
    // The longest name wins: "one page summary" beats "pdf" in "use the one page summary skill to make a PDF".
    const mentioned = Math.max(0, ...names.filter((name) => q.includes(name)).map((name) => name.length));
    const asksToUse = /\b(use|using|grab|open|follow|start|load|switch to|with the)\b/.test(q) || /\bskills?\b/.test(q);
    if (mentioned > foundLength && asksToUse) {
      found = skill;
      foundLength = mentioned;
    }
    if (/\bprd\b/.test(skill.id) && /\bprds?\b/.test(q) && /\b(write|create|draft|make|build|start|use)\b/.test(q)) {
      found = skill;
    }
  }
  return found;
}

/** The words the model follows when a skill is on. The voice reads only the part before SKILL_BODY. */
export function skillInstructions(skill, question, history, memory, meetingNotes, notesKind = "") {
  const earlier = history.length
    ? history.map((turn) => `User: ${turn.question}\nAssistant: ${turn.answer}`).join("\n\n")
    : "";
  return [
    `The user wants you to use the skill "${skill.name}".`,
    "Follow the skill below. It decides the shape of the answer.",
    "Say a short spoken intro first. If the skill produces a document, put the marker SKILL_BODY on its own line, then write the document.",
    "If the skill produces a PDF, put PDF_BODY on its own line instead, then the complete HTML page, as the PDF rule says.",
    "The voice reads only the words before SKILL_BODY or PDF_BODY. Do not read the document aloud.",
    "After SKILL_BODY, short labels on their own lines are fine.",
    "Do not invent facts. Write TBD when something was not said.",
    "Keep Arabic and English as the user said them.",
    "If the skill tells you to open another file, that file is in the skill's folder.",
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

export function replySkillStop(res) {
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.flushHeaders?.();
  writeEvent(res, { type: "skill", id: "", name: "" });
  writeEvent(res, { type: "delta", text: "I put that skill away." });
  writeEvent(res, { type: "done" });
  return res.end();
}

export function registerSkills(app) {
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
}
