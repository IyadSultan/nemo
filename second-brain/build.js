/**
 * Build mode: "write me a script", "make an app", "build a web page".
 * The helper team (rust/src/team.rs) writes and runs code, but only inside one
 * new folder under ~/.brain/workspace. Claude Code's sandbox keeps it there.
 */

import { spawn } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { BRAIN_DIR } from "./config.js";
import { askClaude } from "./models.js";
import { getModel } from "./pricing.js";
import { eventFolderName, freeChildPath } from "./savedir.js";
import { runCommand } from "./shell.js";

export const WORKSPACE_ROOT = path.join(BRAIN_DIR, "workspace");

const MAKE = /\b(write|code|build|make|create|generate|program)\b/i;
const THING = /\b(code|script|program|app|application|web ?page|website|site|game|tool|dashboard|artifact|calculator|extension|bot|function|cli|html|python|javascript|react|node|video|mp4|animation|movie|clip)\b/i;
const ASKING = /^\s*(how (do|can|would|should) (i|u|you|we)|how to|what('s| is| are)|why|explain|tell me about)\b/i;

/** True when the user asks the brain to write code or make an artifact, not how to. */
export function wantsBuild(question) {
  const q = String(question || "");
  if (ASKING.test(q)) return false;
  const verb = q.match(MAKE);
  return Boolean(verb && THING.test(q.slice(verb.index)));
}

// A build waiting for the user's answers. One user, so one at a time; a restart forgets it.
let pending = null;
const PENDING_MS = 15 * 60 * 1000;
const CANCEL = /^\s*(cancel|never ?mind|forget (it|that)|stop|don'?t( build)?)\b/i;

const ASK_FIRST = [
  "You check a request to write code or make an app, page, script, game or tool before a team builds it.",
  "Ask only when the answer would change what gets built a lot and a sensible default would likely be wrong:",
  "for example who it is for, which data or files it uses, or what it must do. Never ask about colors, names, style or anything with an obvious default.",
  "This app or the app means the user's voice assistant, Talk to your brain, so do not ask about it, unless the conversation just made something else that it could mean; then ask which one.",
  "A short request like make a simple game is clear: the team picks. Each question is under 15 words, with no lists of examples, because it is read aloud. Reply with JSON only:",
  '{"questions": ["one short question"]}, at most 3 questions, or {"questions": []} when it is clear enough.',
].join(" ");

/** Up to 3 questions to ask before building, or none. A failed check builds without asking. */
export async function questionsFirst(question, history = []) {
  const earlier = history.slice(-3).map((t) => `User: ${t.question}\nAssistant: ${String(t.answer).slice(0, 400)}`).join("\n\n");
  const asked = earlier ? `Earlier in this conversation:\n${earlier}\n\nRequest: ${question}` : question;
  let text = "";
  try {
    await askClaude(getModel("claude-sonnet"), ASK_FIRST, asked, "low", (t) => { text += t; }, 45000);
    const json = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
    return (Array.isArray(json.questions) ? json.questions : [])
      .filter((q) => typeof q === "string" && q.trim()).slice(0, 3).map((q) => q.trim());
  } catch (err) {
    console.error("Failed while checking a build request:", err?.message || err);
    return [];
  }
}

export function holdBuild(question, questions, skillId = "") {
  pending = { question, questions, skillId, at: Date.now() };
}

/**
 * The user's reply to the build questions: { request, skillId } to build, "cancel", or null
 * when no build is waiting. A new build request replaces the waiting one.
 */
export function answerToPending(reply) {
  const held = pending;
  if (!held || Date.now() - held.at > PENDING_MS || wantsBuild(reply)) {
    pending = null;
    return null;
  }
  pending = null;
  if (CANCEL.test(reply)) return "cancel";
  const asked = held.questions.map((q, i) => `${i + 1}. ${q}`).join("\n");
  const request = `${held.question}\n\nBefore building, you asked:\n${asked}\nThe user answered: ${reply}\nWhere the user leaves a question open or says you decide, pick a sensible default.`;
  return { request, skillId: held.skillId };
}

/** Added to every build prompt: what "this app" is, and how videos are rendered. */
export const BUILD_NOTES = [
  `"This app" or "the app" means the user's voice assistant, Talk to your brain; its manual is ${path.join(BRAIN_DIR, "manual.md")}. Something the team just built is "the game" or "the page", unless the conversation says otherwise.`,
  "For a HyperFrames video, write the project in the workspace and check it with hyperframes lint (the installed command; never npx). Do not run render, preview or publish: they cannot run here. The app renders the MP4 itself when you finish, so say the video is being rendered, not that it is done.",
].join(" ");

/** The prompt for a build that uses a skill, such as /hyperframes. */
export function skillBuildPrompt(skill, request, history) {
  const earlier = history.map((t) => `User: ${t.question}\nAssistant: ${t.answer}`).join("\n\n");
  return [
    `The user wants you to use the skill "${skill.name}". Follow it. Its files are in ${skill.dir}, and the skills it points to sit next to it in ${path.dirname(skill.dir)}.`,
    BUILD_NOTES,
    "",
    skill.body,
    earlier ? `\nEarlier in this conversation:\n${earlier}` : "",
    "",
    `Request: ${request}`,
  ].filter(Boolean).join("\n");
}

/** A new, empty folder for this job: ~/.brain/workspace/20261017_tip-calculator-app. */
export async function makeWorkspace(question) {
  await fs.mkdir(WORKSPACE_ROOT, { recursive: true });
  const words = String(question).split("\n")[0].replace(MAKE, "").replace(/^(\s*\b(me|u|us|a|an|the|some|simple|small)\b)+/i, "");
  const title = words.trim().split(/\s+/).slice(0, 6).join(" ");
  const dir = freeChildPath(WORKSPACE_ROOT, eventFolderName(new Date(), title, "build"));
  await fs.mkdir(dir);
  return dir;
}

/** Files the team wrote, without hidden folders and node_modules. */
async function listFiles(dir, base = dir, out = []) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await listFiles(full, base, out);
    else out.push(path.relative(base, full));
    if (out.length >= 40) break;
  }
  return out;
}

/**
 * The HyperFrames project the team wrote, or null: the folder holding hyperframes.json,
 * or an index.html that declares a composition (render works without the json).
 */
async function videoProject(dir, files) {
  const config = files.filter((f) => path.basename(f) === "hyperframes.json").sort((a, b) => a.length - b.length)[0];
  if (config) return path.join(dir, path.dirname(config));
  for (const page of files.filter((f) => path.basename(f) === "index.html").sort((a, b) => a.length - b.length)) {
    const html = await fs.readFile(path.join(dir, page), "utf8").catch(() => "");
    if (/\bdata-composition-id=/.test(html)) return path.join(dir, path.dirname(page));
  }
  return null;
}

/** Render outside the sandbox (Chrome needs calls the sandbox blocks). Resolves with the MP4 path. */
async function renderVideo(project, onStatus) {
  onStatus("Rendering the video…");
  const out = path.join(project, "video.mp4");
  await new Promise((resolve, reject) => {
    // The global install (npm i -g hyperframes), not npx: the sandboxed team must not be able
    // to plant code in npm's cache that runs here. launchd's PATH is short; ffmpeg sits next to node.
    // process.execPath is in Homebrew's Cellar; the global bin is /opt/homebrew/bin.
    const bin = ["/opt/homebrew/bin", "/usr/local/bin", path.dirname(process.execPath)]
      .find((d) => fsSync.existsSync(path.join(d, "hyperframes"))) || "/opt/homebrew/bin";
    const child = spawn(path.join(bin, "hyperframes"), ["render", "-o", out], {
      cwd: project,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH || ""}`, HYPERFRAMES_SKIP_SKILLS: "1", ANTHROPIC_API_KEY: "" },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let err = "";
    child.stderr.on("data", (d) => { err = (err + d).slice(-600); });
    const timer = setTimeout(() => child.kill("SIGKILL"), 15 * 60 * 1000);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      code === 0 ? resolve() : reject(new Error(err.trim().split("\n").pop() || `render exited ${code}`));
    });
  });
  return out;
}

/** After the team is done: open index.html in the browser (or the folder in Finder) and return a card. */
export async function finishBuild(dir, onStatus = () => {}) {
  const files = await listFiles(dir);
  if (!files.length) return { title: "Nothing was written", lines: [dir] };
  const project = await videoProject(dir, files);
  if (project) {
    try {
      const mp4 = await renderVideo(project, onStatus);
      await runCommand("open", [mp4]);
      return { title: "Video rendered", lines: [mp4], said: "The video is ready. It is open now." };
    } catch (err) {
      console.error("Failed while rendering the video:", err?.message || err);
      return { title: "The video could not be rendered", lines: [project, String(err?.message || err)], said: "The video could not be rendered. The card shows why." };
    }
  }
  const page = files.find((f) => f === "index.html") || files.find((f) => path.basename(f) === "index.html");
  try {
    await runCommand("open", [page ? path.join(dir, page) : dir]);
  } catch (err) {
    console.error("Failed while opening the build:", err?.message || err);
  }
  return { title: `Built in ${path.basename(dir)}`, lines: [dir, ...files.slice(0, 12)] };
}
