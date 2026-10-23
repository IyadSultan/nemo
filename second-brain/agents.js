/**
 * Claude sessions showing up in the chat.
 *
 * When a Terminal starts work, a small Claude appears with the agent's name
 * and your prompt. When it finishes, the brain reads what it wrote and the
 * small Claude comes back with a short summary. Both moments are appended
 * to ~/.brain/agents.md.
 *
 * Two ways a session is noticed:
 * 1. A hook (agent-hook.js) posts here as soon as you send a prompt, and
 *    again when the reply is done. That is the same kind of signal
 *    claude-voice uses.
 * 2. A watcher reads the session log Claude already writes
 *    (<project>/.claude/logs.md), so a Terminal that was open before the
 *    hook was installed is still noticed.
 */

import { AGENTS_FILE } from "./config.js";
import { sendControl } from "./control.js";
import { askModelOnce } from "./models.js";
import { getModel } from "./pricing.js";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const REGISTRY = path.join(os.homedir(), ".claude", "orchestration", "registry.json");
const HOOK_SCRIPT = fileURLToPath(new URL("./agent-hook.js", import.meta.url));
const HOOK_MARKER = "agent-hook.js";
// Same window as session_logger: a prompt and its reply land together.
const DEDUP_MS = 20000;
const PROMPT_CAP = 600;
const SUMMARY_CAP = 700;
const REPLY_CAP = 6000;

const SUMMARY = [
  "You are the user's second brain.",
  "Read the note below about one Claude session that just finished.",
  "Write two short sentences saying what it did, in plain words.",
  "Do not quote long passages. Do not list every file.",
  "Never write a medical record number, a national number, or a patient's name.",
  "Do not start with the agent's name.",
].join(" ");

// session id -> the user's prompt, so the finish line can name it.
const sessions = new Map();
// Cursor can send "finished" a moment before the reply text. Held until that text arrives.
const pendingStops = new Map();
// "start|name|prompt" -> time, so the hook and the log watcher do not both speak.
const recent = new Map();
// One summary at a time, so many Terminals finishing together do not pile up.
let summaryChain = Promise.resolve();

function stamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Hide long numbers (record numbers and the like) before anything is saved or shown. */
function redact(text) {
  return String(text || "").replace(/\b\d{5,}\b/g, "[REDACTED-DIGITS]");
}

function squeeze(text, cap) {
  const flat = redact(text).replace(/\s+/g, " ").trim();
  if (!flat) return "";
  return flat.length <= cap ? flat : `${flat.slice(0, cap).trimEnd()} […]`;
}

/** Like squeeze, but keeps line breaks so lists and headings still show as markdown. */
function tidy(text, cap) {
  const kept = redact(text)
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!kept) return "";
  return kept.length <= cap ? kept : `${kept.slice(0, cap).trimEnd()} […]`;
}

/** A real prompt from you. Internal "a helper finished" notes are skipped. */
function isUserPrompt(text) {
  const t = String(text || "").trim();
  if (!t) return false;
  if (t.startsWith("<task-notification") || t.startsWith("<task-id")) return false;
  return true;
}

function seenRecently(key) {
  const now = Date.now();
  for (const [old, at] of recent) {
    if (now - at > DEDUP_MS) recent.delete(old);
  }
  if (recent.has(key)) return true;
  recent.set(key, now);
  return false;
}

/**
 * The agent name for a folder, from the orchestration list.
 * The longest matching folder wins, so a nested folder keeps its own name.
 */
export function agentName(cwd) {
  if (!String(cwd || "").trim()) return "Claude";
  const folder = path.basename(String(cwd || "").replace(/\/+$/, "")) || "Claude";
  let reg;
  try {
    reg = JSON.parse(fs.readFileSync(REGISTRY, "utf8"));
  } catch {
    return folder;
  }
  const abs = path.resolve(String(cwd || "."));
  let best = "";
  let bestLen = -1;
  for (const [key, entry] of Object.entries(reg || {})) {
    if (!entry || typeof entry !== "object") continue;
    const norm = path.resolve(String(key));
    if (abs !== norm && !abs.startsWith(norm + path.sep)) continue;
    if (norm.length <= bestLen) continue;
    best = entry.name || folder;
    bestLen = norm.length;
  }
  return best || folder;
}

function workspaceOf(data) {
  const roots = data.workspace_roots || data.workspaceRoots;
  if (Array.isArray(roots) && roots[0]) return String(roots[0]);
  if (typeof data.cwd === "string" && data.cwd) return data.cwd;
  if (typeof data.workspace === "string") return data.workspace;
  return "";
}

function remember(file, block) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (!fs.existsSync(file)) {
      fs.writeFileSync(
        file,
        "# Agents\n\nWho worked, and when. One block when a Claude session starts, and another when it finishes. The finished line is a short summary from the second brain.\n",
        "utf8",
      );
    }
    fs.appendFileSync(file, block, "utf8");
  } catch (err) {
    console.error("Failed while writing agents.md:", err.message);
  }
}

function tellPage(phase, name, session, text, extra = {}) {
  sendControl("agent", {
    phase,
    name,
    session,
    text,
    cwd: extra.cwd || "",
    place: extra.place || "terminal",
  });
}

/** Show the start in the chat and keep the prompt for the finish line. */
function noteStart({ name, prompt, session, cwd, place }) {
  const asked = squeeze(prompt, PROMPT_CAP);
  if (!isUserPrompt(asked)) return;
  const who = name || agentName(cwd);
  const where = place || "terminal";
  if (seenRecently(`start|${who}|${asked.slice(0, 160)}`)) return;
  if (session) sessions.set(session, { prompt: asked, name: who, cwd: cwd || "", place: where });
  remember(AGENTS_FILE, `\n## ${stamp()} — ${who} — started\n\nPrompt: ${asked}\n`);
  tellPage("start", who, session || "", asked, { cwd, place: where });
  console.log(`Agent ${who} started.`);
}

/** The reply Claude just wrote: the hook's own text, or the last lines of its transcript. */
function replyText(data) {
  const direct = data.last_assistant_message || data.text;
  if (typeof direct === "string" && direct.trim()) return direct;
  const saved = sessions.get(String(data.session_id || data.conversation_id || ""));
  if (saved?.reply) return saved.reply;
  return lastAssistantText(data.transcript_path);
}

function lastAssistantText(file) {
  if (!file || !fs.existsSync(file)) return "";
  let fd;
  try {
    const stat = fs.statSync(file);
    const size = Math.min(stat.size, 512 * 1024);
    const buf = Buffer.alloc(size);
    fd = fs.openSync(file, "r");
    fs.readSync(fd, buf, 0, size, Math.max(0, stat.size - size));
    const lines = buf.toString("utf8").split("\n").slice(-400);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i].trim();
      if (!line) continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      if (!rec || rec.type !== "assistant") continue;
      const content = rec.message?.content || [];
      const text = content
        .filter((part) => part && part.type === "text" && part.text)
        .map((part) => part.text)
        .join("\n")
        .trim();
      if (text) return text;
    }
  } catch (err) {
    console.error("Failed while reading a Claude transcript:", err.message);
  } finally {
    if (fd != null) {
      try { fs.closeSync(fd); } catch { /* already closed */ }
    }
  }
  return "";
}

function queueSummary(job) {
  const run = summaryChain.then(job, job);
  summaryChain = run.then(() => {}, () => {});
  return run;
}

async function summarizeWork(name, prompt, reply) {
  const model = getModel("claude-sonnet");
  const packet = [
    `Agent: ${name}`,
    `Asked: ${squeeze(prompt, PROMPT_CAP) || "(no prompt was saved)"}`,
    "What it wrote at the end:",
    squeeze(reply, REPLY_CAP),
  ].join("\n");
  if (!model) return tidy(reply, 320) || "It finished, but I could not read what it wrote.";
  try {
    const summary = await askModelOnce(model, SUMMARY, packet, "", 280, 90000);
    const clean = tidy(summary, SUMMARY_CAP);
    if (clean.length >= 20) return clean;
  } catch (err) {
    console.error("Failed while the brain read a finished Claude session:", err?.message || err);
  }
  return tidy(reply, 320) || "It finished, but I could not read what it wrote.";
}

function noteStop({ name, prompt, reply, session, cwd, place }) {
  const wrote = String(reply || "").trim();
  if (!wrote) return;
  const who = name || agentName(cwd);
  const saved = session ? sessions.get(session) : null;
  const asked = squeeze(prompt || saved?.prompt || "", PROMPT_CAP);
  const folder = cwd || saved?.cwd || "";
  const where = place || saved?.place || "terminal";
  if (seenRecently(`done|${who}|${squeeze(wrote, 120)}`)) return;
  const id = session || `${who}-${Date.now()}`;
  tellPage("reading", who, id, "Reading what it did…", { cwd: folder, place: where });
  queueSummary(async () => {
    const summary = await summarizeWork(who, asked, wrote);
    const lines = [`\n## ${stamp()} — ${who} — finished\n`];
    if (asked) lines.push(`\nPrompt: ${asked}\n`);
    lines.push(`\nSummary: ${summary}\n`);
    remember(AGENTS_FILE, lines.join(""));
    tellPage("done", who, id, summary, { cwd: folder, place: where });
    console.log(`Agent ${who} finished.`);
  });
}

function eventName(data) {
  return String(data.hook_event_name || data.hookEventName || "").toLowerCase();
}

/** One hook payload from Claude Code or from Cursor. */
export async function handleHook(data) {
  if (!data || typeof data !== "object") return;
  const event = eventName(data);
  const cwd = workspaceOf(data);
  const session = String(data.session_id || data.conversation_id || "");
  const name = agentName(cwd);
  // Cursor agents (Grok, Claude, Composer, and the rest) live in the Cursor app.
  // Claude Code lives in Terminal. A conversation id with no transcript is Cursor.
  const place = event === "beforesubmitprompt" || event === "afteragentresponse" || event === "agentresponse"
    || (data.conversation_id && !data.transcript_path)
    ? "cursor"
    : "terminal";

  if (event === "userpromptsubmit" || event === "beforesubmitprompt") {
    noteStart({ name, prompt: data.prompt || data.user_prompt || "", session, cwd, place });
    return;
  }

  // Cursor sends the reply on this event, and the "stop" event just after it.
  if (event === "afteragentresponse" || event === "agentresponse") {
    const text = String(data.text || data.last_assistant_message || "").trim();
    if (!session || !text) return;
    const saved = sessions.get(session) || { prompt: "", name, cwd, place: "cursor" };
    saved.reply = text;
    saved.place = saved.place || "cursor";
    sessions.set(session, saved);
    const waiting = pendingStops.get(session);
    if (waiting) {
      pendingStops.delete(session);
      noteStop({ name: waiting.name, prompt: waiting.prompt, reply: text, session, cwd: waiting.cwd, place: waiting.place });
    }
    return;
  }

  if (event !== "stop") return;
  const status = String(data.status || "completed").toLowerCase();
  if (status === "aborted" || status === "error") {
    const saved = sessions.get(session);
    const who = saved?.name || name;
    if (!who) return;
    remember(AGENTS_FILE, `\n## ${stamp()} — ${who} — finished\n\nSummary: It stopped before it finished.\n`);
    tellPage("done", who, session || `${who}-stopped`, "It stopped before it finished.", {
      cwd: saved?.cwd || cwd,
      place: saved?.place || place,
    });
    return;
  }
  const reply = replyText(data);
  const asked = sessions.get(session)?.prompt || "";
  const who = sessions.get(session)?.name || name;
  const folder = sessions.get(session)?.cwd || cwd;
  const where = sessions.get(session)?.place || place;
  if (!reply && session) {
    pendingStops.set(session, { name: who, prompt: asked, cwd: folder, place: where });
    setTimeout(() => pendingStops.delete(session), 4000);
    return;
  }
  noteStop({ name: who, prompt: asked, reply, session, cwd: folder, place: where });
}

function appleQuote(text) {
  return `"${String(text || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function shQuote(text) {
  return `'${String(text || "").replace(/'/g, `'\\''`)}'`;
}

function claudeBin() {
  // The same program you start by typing claude in a Terminal.
  return fs.existsSync("/Users/USER/.local/bin/claude") ? "/Users/USER/.local/bin/claude" : "claude";
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isLocal(req) {
  const ip = req.socket?.remoteAddress || "";
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

/**
 * Find the Terminal window for this agent.
 * focus true brings it forward. focus false only looks, so checking
 * "is it awake?" does not steal the screen.
 * The answer's second part is the window's tty, like /dev/ttys020.
 */
async function findTerminalWindow({ cwd, name, focus }) {
  const folder = String(cwd || "").trim();
  const who = String(name || "").trim() || (folder ? path.basename(folder) : "");
  if (!folder && !who) return { ok: false, error: "I don't know which Terminal that was." };
  const titles = [...new Set([who, folder ? path.basename(folder) : ""].filter(Boolean))];
  const raise = focus
    ? `set miniaturized of target to false
  set index of target to 1
  activate`
    : "";
  const script = `
set titleList to {${titles.map(appleQuote).join(", ")}}
tell application "Terminal"
  if (count of windows) is 0 then return "MISS"
  set titleWin to missing value
  set titleLive to missing value
  repeat with w in windows
    try
      set nm to name of w as text
      set head to nm
      if nm contains " — " then
        set AppleScript's text item delimiters to " — "
        set head to text item 1 of nm
        set AppleScript's text item delimiters to ""
      end if
      ignoring case
        repeat with p in titleList
          if head is (p as text) then
            if nm contains "claude" then set titleLive to id of w
            if titleWin is missing value then set titleWin to id of w
          end if
        end repeat
      end ignoring
    end try
  end repeat
  if titleLive is not missing value then set titleWin to titleLive
  if titleWin is missing value then return "MISS"
  set target to first window whose id is titleWin
  set tabTty to ""
  try
    set tabTty to tty of selected tab of target
  end try
  ${raise}
  return "OK|" & tabTty
end tell
`;
  try {
    const out = (await execFileAsync("/usr/bin/osascript", ["-e", script], { timeout: 8000, encoding: "utf8" })).stdout.trim();
    if (!out.startsWith("OK")) return { ok: false, error: "I could not find that Terminal. It may already be closed." };
    return { ok: true, tty: out.slice(3).trim() };
  } catch (err) {
    console.error("Failed while looking for that Terminal:", String(err.stderr || err.message || err).slice(0, 300));
    return { ok: false, error: "I could not open that Terminal. Allow Terminal for this app if macOS asks." };
  }
}

/** A Claude Code you type to: not the Claude app, and not a one-shot -p summary. */
function isInteractiveClaude(cmd) {
  if (!cmd || cmd.includes("/Applications/Claude.app")) return false;
  if (/(^|\s)(-p|--print)(\s|$)/.test(cmd)) return false;
  return /^\S*(^|\/)claude(\s|$)/.test(cmd);
}

function realFolder(folder) {
  try {
    return fs.realpathSync(folder);
  } catch {
    return path.resolve(folder);
  }
}

/**
 * Every Claude Code you can type to, in any app: Terminal, Cursor, iTerm.
 * The Claude app and one-shot summary jobs are left out.
 * Each row has the process id, the terminal device, the folder, and when it started.
 */
async function listOpenClaudes() {
  let rows = [];
  try {
    const out = (await execFileAsync("ps", ["-axo", "pid=,tty=,command="], { timeout: 4000, encoding: "utf8" })).stdout;
    rows = out.split("\n").map((line) => line.trim().match(/^(\d+)\s+(\S+)\s+(.*)$/)).filter(Boolean)
      .filter((m) => m[2] !== "??" && isInteractiveClaude(m[3]))
      .map((m) => ({ pid: Number(m[1]), tty: `/dev/${m[2]}` }));
  } catch (err) {
    console.error("Failed while listing running Claudes:", err?.message || err);
    return [];
  }
  if (!rows.length) return [];
  let listed = "";
  try {
    // lsof exits 1 when one of the programs has just quit. What it printed is still good.
    listed = (await execFileAsync("lsof", ["-a", "-p", rows.map((r) => r.pid).join(","), "-d", "cwd", "-Fpn"], { timeout: 6000, encoding: "utf8" })).stdout;
  } catch (err) {
    listed = String(err?.stdout || "");
  }
  const cwdOf = new Map();
  let pid = 0;
  for (const line of listed.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n") && pid) cwdOf.set(pid, line.slice(1));
  }
  const started = await startTimes(rows.map((r) => r.pid));
  return rows
    .filter((r) => cwdOf.has(r.pid))
    .map((r) => ({ pid: r.pid, tty: r.tty, cwd: cwdOf.get(r.pid), startedAt: started.get(r.pid) || 0 }));
}

/** When each process started, as a clock time. A missing time stays 0 so we do not guess. */
async function startTimes(pids) {
  const when = new Map();
  await Promise.all(pids.map(async (pid) => {
    try {
      const text = (await execFileAsync("ps", ["-p", String(pid), "-o", "lstart="], { timeout: 3000, encoding: "utf8" })).stdout.trim();
      const at = Date.parse(text);
      if (!Number.isNaN(at)) when.set(pid, at);
    } catch {
      // The process quit while we were looking. Leave it out.
    }
  }));
  return when;
}

/** Every Claude Code running in this folder. Found by the folder, so a window title does not matter. */
async function claudesIn(folder) {
  const want = realFolder(folder);
  return (await listOpenClaudes()).filter((row) => row.cwd === want);
}

/** Type a line into the Terminal tab on this tty, then Return. False when no Terminal tab has it. */
async function typeInTerminal(tty, text) {
  const script = `
on run argv
  tell application "Terminal"
    repeat with w in windows
      repeat with t in tabs of w
        if tty of t is (item 1 of argv) then
          do script (item 2 of argv) in t
          return "OK"
        end if
      end repeat
    end repeat
  end tell
  return "MISS"
end run
`;
  try {
    const out = (await execFileAsync("/usr/bin/osascript", ["-e", script, tty, text], { timeout: 8000, encoding: "utf8" })).stdout.trim();
    return out === "OK";
  } catch (err) {
    console.error("Failed while typing into Terminal:", String(err.stderr || err.message || err).slice(0, 300));
    return false;
  }
}

function stillRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Awake means a Claude Code is still running in that folder. Asleep means none is. */
export async function agentIsAwake({ cwd, place }) {
  if (place === "cursor") return { ok: true, awake: false, place: "cursor" };
  const folder = String(cwd || "").trim();
  if (!folder) return { ok: true, awake: false };
  return { ok: true, awake: (await claudesIn(folder)).length > 0 };
}

/**
 * Quit a Claude that is still running. The chat is saved, so Wake brings it back.
 * In Terminal it types /exit, and Return again if Claude asks about tasks still running.
 * Anywhere else (Cursor's own terminal, iTerm) it asks the program to quit.
 * Both ways the session-end hooks still run.
 */
export async function exitAgent({ cwd, place }) {
  if (place === "cursor") {
    return { ok: false, error: "This one is in Cursor. Exit and Wake are for a Claude in the Terminal." };
  }
  const folder = String(cwd || "").trim();
  if (!folder) return { ok: false, error: "I don't know which folder that Claude is in." };
  const running = await claudesIn(folder);
  if (!running.length) {
    return { ok: false, asleep: true, error: "That Claude is already asleep. Use Wake to bring it back." };
  }
  for (const proc of running) {
    if (await typeInTerminal(proc.tty, "/exit")) {
      await wait(1500);
      // "The following will stop when you exit" waits for Return. Return picks "Exit and stop tasks".
      if (stillRunning(proc.pid)) await typeInTerminal(proc.tty, "");
    } else {
      try {
        process.kill(proc.pid, "SIGTERM");
      } catch (err) {
        console.error("Failed while asking Claude to quit:", err?.message || err);
      }
    }
  }
  for (let i = 0; i < 20 && running.some((p) => stillRunning(p.pid)); i += 1) await wait(250);
  if (running.some((p) => stillRunning(p.pid))) {
    return { ok: false, awake: true, error: "That Claude did not quit. Open it and type /exit." };
  }
  return { ok: true, did: "exit" };
}

/**
 * Tell every Claude that is open in Terminal to quit, by typing /exit.
 * One folder is only told once. A Claude inside Cursor is left alone.
 * The memory warning does not call this: an agent working on code is left running.
 */
export async function exitOpenAgents() {
  const open = await listOpenClaudes();
  const byFolder = new Map();
  for (const proc of open) {
    if (!byFolder.has(proc.cwd)) byFolder.set(proc.cwd, proc);
  }
  const exited = [];
  const failed = [];
  await Promise.all([...byFolder.values()].map(async (proc) => {
    const name = agentName(proc.cwd);
    try {
      const result = await exitAgent({ cwd: proc.cwd });
      if (result.ok) {
        exited.push({ name, cwd: proc.cwd });
        remember(AGENTS_FILE, `\n## ${stamp()} — ${name} — closed\n\nSummary: Memory was getting full, so it was told to /exit.\n`);
        tellPage("done", name, `memory-${proc.pid}`, "Memory was getting full, so it was told to exit.", { cwd: proc.cwd, place: "terminal" });
        console.log(`Exited ${name} because memory was getting full.`);
      } else if (!result.asleep) {
        failed.push({ name, cwd: proc.cwd, error: result.error || "It did not exit." });
        console.error(`Could not exit ${name} while memory was full:`, result.error || "It did not exit.");
      }
    } catch (err) {
      failed.push({ name, cwd: proc.cwd, error: err?.message || "It did not exit." });
      console.error(`Failed while exiting ${name} because memory was full:`, err?.message || err);
    }
  }));
  return { ok: failed.length === 0, exited, failed };
}

/** 30 hours with nothing new. Used by the quiet-agent sweep below. */
export const QUIET_MS = 30 * 60 * 60 * 1000;

/**
 * True when this Claude has been quiet long enough to close.
 * "Quiet" is the latest of: when the program started, when its saved chat was
 * last written, and when you last typed in its Terminal. A Claude you just
 * opened is not quiet, even if the old chat file is old. If we cannot tell when
 * it started, we leave it open.
 */
export function quietLongEnough(startedAt, touchedAt, now = Date.now(), limit = QUIET_MS) {
  const started = Number(startedAt) || 0;
  if (!started) return false;
  const last = Math.max(started, Number(touchedAt) || 0);
  return now - last >= limit;
}

/** The folder where Claude saves this project's chat files. */
function projectDir(folder) {
  const key = realFolder(folder).replace(/[^A-Za-z0-9]/g, "-");
  return path.join(os.homedir(), ".claude", "projects", key);
}

/** When the newest saved chat for this folder was last written. 0 if there is none. */
function lastChatTouch(folder) {
  const dir = projectDir(folder);
  let latest = 0;
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith(".jsonl")) continue;
      const when = fs.statSync(path.join(dir, name)).mtimeMs;
      if (when > latest) latest = when;
    }
  } catch {
    // No saved chat yet. The start time is still enough.
  }
  return latest;
}

/** When a key was last pressed in this terminal. macOS updates a tty's access time on input (the IDLE column of `w`). */
async function lastTyped(tty) {
  try {
    return (await fs.promises.stat(tty)).atimeMs;
  } catch {
    return 0;
  }
}

/**
 * Look at, or act on, the Terminal tab that owns this tty. Found by tty every
 * time, so a tab that closed or moved in between can never be mistaken for another.
 * mode "look":  BUSY (a program runs in it), IDLE (only the shell), or MISS (not a Terminal tab).
 * mode "exit":  types exit into an IDLE tab and answers SENT. A BUSY tab is not touched.
 * mode "close": closes an IDLE tab (the window, when it is the only tab). LEFT when it could not.
 */
async function terminalTab(tty, mode) {
  const script = `
on run argv
  set want to item 1 of argv
  set mode to item 2 of argv
  tell application "Terminal"
    repeat with w in windows
      repeat with t in tabs of w
        set here to false
        try
          set here to ((tty of t) is want)
        end try
        if here then
          if busy of t then return "BUSY"
          if mode is "exit" then
            do script "exit" in t
            return "SENT"
          end if
          if mode is "close" then
            if (count of tabs of w) is 1 then
              close w
              return "OK"
            end if
            try
              close t
              return "OK"
            end try
            return "LEFT"
          end if
          return "IDLE"
        end if
      end repeat
    end repeat
  end tell
  return "MISS"
end run
`;
  try {
    return (await execFileAsync("/usr/bin/osascript", ["-e", script, tty, mode], { timeout: 8000, encoding: "utf8" })).stdout.trim();
  } catch (err) {
    console.error("Failed while checking a Terminal tab:", String(err.stderr || err.message || err).slice(0, 300));
    return "ERROR";
  }
}

/**
 * Quit one quiet Claude with SIGTERM, the same polite stop Exit uses outside Terminal.
 * Typing /exit is not safe here: text left unsent in its prompt box would be sent
 * as a new request, and the "stop running tasks?" question would be answered for you.
 */
async function exitOne(proc) {
  try {
    process.kill(proc.pid, "SIGTERM");
  } catch (err) {
    console.error("Failed while asking a quiet Claude to quit:", err?.message || err);
  }
  for (let i = 0; i < 20 && stillRunning(proc.pid); i += 1) await wait(250);
  return !stillRunning(proc.pid);
}

/**
 * Close the Terminal tab this Claude was using, once Claude has left.
 * First the shell is asked to leave, so macOS does not ask "terminate running processes?".
 * A tab still running something else is left alone. A window with only that tab is closed.
 */
async function closeTerminal(tty) {
  const sent = await terminalTab(tty, "exit");
  if (sent === "MISS") return true;
  if (sent !== "SENT") return false;
  await wait(700);
  // MISS: leaving the shell already closed the tab.
  return ["OK", "MISS"].includes(await terminalTab(tty, "close"));
}

let sweeping = false;

/**
 * Look at every open Claude. Any one in a Terminal tab that has been quiet for
 * 30 hours is told to exit, and its tab is closed. Claudes in Cursor, iTerm, or
 * tmux are not Terminal tabs, so they are left alone.
 */
export async function closeQuietAgents() {
  if (sweeping) return [];
  sweeping = true;
  const closed = [];
  try {
    for (const proc of await listOpenClaudes()) {
      const touched = Math.max(lastChatTouch(proc.cwd), await lastTyped(proc.tty));
      if (!quietLongEnough(proc.startedAt, touched)) continue;
      if ((await terminalTab(proc.tty, "look")) !== "BUSY") continue;
      const name = agentName(proc.cwd);
      if (!(await exitOne(proc))) {
        console.error(`Could not exit quiet Claude ${name}. It is still running.`);
        continue;
      }
      const shut = await closeTerminal(proc.tty);
      const note = shut
        ? "It had been quiet for 30 hours, so it was told to exit and its Terminal tab was closed."
        : "It had been quiet for 30 hours, so it was told to exit. Its Terminal tab was left open.";
      remember(AGENTS_FILE, `\n## ${stamp()} — ${name} — closed\n\nSummary: ${note}\n`);
      tellPage("done", name, `${name}-quiet-${proc.pid}`, note, { cwd: proc.cwd, place: "terminal" });
      console.log(`Closed quiet Claude ${name}.`);
      closed.push({ name, cwd: proc.cwd, terminal: shut });
    }
  } catch (err) {
    console.error("Failed while closing quiet Claudes:", err?.message || err);
  } finally {
    sweeping = false;
  }
  return closed;
}

let idleTimer = null;

/** Check for quiet Claudes every 6 hours, and once shortly after the server starts. */
function startIdleSweep() {
  if (idleTimer) return;
  const run = () => {
    closeQuietAgents().catch((err) => console.error("Failed while closing quiet Claudes:", err?.message || err));
  };
  const first = setTimeout(run, 20_000);
  first.unref?.();
  idleTimer = setInterval(run, 6 * 60 * 60 * 1000);
  idleTimer.unref?.();
  console.log("Quiet Claudes are closed after 30 hours, and their Terminal is closed too.");
}

/** True when Claude has a saved chat for this folder, so claude --continue has something to open. */
function hasSavedChat(folder) {
  try {
    return fs.readdirSync(projectDir(folder)).some((f) => f.endsWith(".jsonl"));
  } catch {
    return false;
  }
}

/**
 * Start Claude again in that folder, with the last chat still remembered.
 * The command is claude --continue. That is the same as claude -c.
 */
export async function wakeAgent({ cwd, name, place }) {
  if (place === "cursor") {
    return { ok: false, error: "This one is in Cursor. Exit and Wake are for a Claude in the Terminal." };
  }
  const folder = String(cwd || "").trim();
  const who = String(name || "").trim() || (folder ? path.basename(folder) : "");
  if (!folder || !fs.existsSync(folder)) return { ok: false, error: "I don't know which folder to wake." };
  const state = await agentIsAwake({ cwd: folder });
  if (state.awake) return { ok: false, awake: true, error: "That Claude is already awake. Use Exit if you want it to stop." };
  // With no saved chat, claude --continue only prints "No conversation found" and quits.
  const cmd = `cd ${shQuote(folder)} && ${shQuote(claudeBin())}${hasSavedChat(folder) ? " --continue" : ""}`;
  const title = `${who || "Claude"} — claude`;
  const script = `
tell application "Terminal"
  set t to do script ${appleQuote(cmd)}
  try
    set custom title of t to ${appleQuote(title)}
  end try
  activate
end tell
`;
  try {
    await execFileAsync("/usr/bin/osascript", ["-e", script], { timeout: 8000, encoding: "utf8" });
  } catch (err) {
    console.error("Failed while waking Claude:", String(err.stderr || err.message || err).slice(0, 300));
    return { ok: false, error: "I could not open a Terminal to wake that Claude." };
  }
  return { ok: true, did: "wake" };
}

/** Bring the Cursor window for this project to the front. Grok and the other Cursor agents live here, not in Terminal. */
async function openCursor(folder) {
  const args = folder ? ["-a", "Cursor", folder] : ["-a", "Cursor"];
  try {
    await execFileAsync("/usr/bin/open", args, { timeout: 8000, encoding: "utf8" });
    return { ok: true, where: "Cursor" };
  } catch (err) {
    console.error("Failed while opening Cursor:", String(err.stderr || err.message || err).slice(0, 300));
    return { ok: false, error: "I could not open Cursor." };
  }
}

/**
 * Bring the Terminal window for this agent to the front.
 * The window whose title starts with the agent name or the folder name.
 * A Cursor agent (including Grok) opens Cursor instead, never Terminal.
 */
export async function openAgentPlace({ cwd, name, place }) {
  const folder = String(cwd || "").trim();
  const who = String(name || "").trim() || (folder ? path.basename(folder) : "");
  if (place === "cursor") return openCursor(folder);
  const found = await findTerminalWindow({ cwd: folder, name: who, focus: true });
  if (!found.ok) return { ok: false, error: found.error || "I could not find that Terminal. It may already be closed." };
  return { ok: true, where: "Terminal" };
}

export function registerAgents(app) {
  // The hook on this Mac posts here. The page hears the result on /control.
  app.post("/agents/hook", (req, res) => {
    if (!isLocal(req)) return res.status(403).json({ ok: false });
    res.json({ ok: true });
    handleHook(req.body).catch((err) => {
      console.error("Failed while handling a Claude session hook:", err?.message || err);
    });
  });

  // A click on the little Claude brings that Terminal (or Cursor) to the front.
  app.post("/agents/open", async (req, res) => {
    if (!isLocal(req)) return res.status(403).json({ ok: false });
    try {
      const result = await openAgentPlace(req.body || {});
      res.json(result);
    } catch (err) {
      console.error("Failed while opening an agent's Terminal:", err?.message || err);
      res.status(500).json({ ok: false, error: "I could not open that Terminal." });
    }
  });

  // Is this Claude still running, or has it quit?
  app.post("/agents/alive", async (req, res) => {
    if (!isLocal(req)) return res.status(403).json({ ok: false });
    try {
      res.json(await agentIsAwake(req.body || {}));
    } catch (err) {
      console.error("Failed while checking if a Claude is awake:", err?.message || err);
      res.status(500).json({ ok: false, error: "I could not check that Claude." });
    }
  });

  // Exit quits a Claude that is still running. Wake starts it again with the old chat.
  app.post("/agents/exit", async (req, res) => {
    if (!isLocal(req)) return res.status(403).json({ ok: false });
    try {
      res.json(await exitAgent(req.body || {}));
    } catch (err) {
      console.error("Failed while exiting a Claude:", err?.message || err);
      res.status(500).json({ ok: false, error: "I could not exit that Claude." });
    }
  });

  app.post("/agents/wake", async (req, res) => {
    if (!isLocal(req)) return res.status(403).json({ ok: false });
    try {
      res.json(await wakeAgent(req.body || {}));
    } catch (err) {
      console.error("Failed while waking a Claude:", err?.message || err);
      res.status(500).json({ ok: false, error: "I could not wake that Claude." });
    }
  });
}

function hookCommand() {
  // The Homebrew name stays valid after a Node upgrade. The cellar path does not.
  const node = fs.existsSync("/opt/homebrew/bin/node") ? "/opt/homebrew/bin/node" : process.execPath;
  return `"${node}" "${HOOK_SCRIPT}"`;
}

function atomicWrite(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

/**
 * Add our hook next to the ones already installed (claude-voice and the
 * session log). Existing hooks are left as they are. Already-open Terminals
 * keep using the session log until that Claude is started again.
 */
export function installAgentHooks() {
  installClaudeSettings();
  installCursorHooks();
}

function installClaudeSettings() {
  const file = path.join(os.homedir(), ".claude", "settings.json");
  let raw = "";
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    console.error("Failed while reading Claude settings for the agent hook:", err.message);
    return;
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    console.error("Failed while reading Claude settings for the agent hook:", err.message);
    return;
  }
  const hooks = data.hooks && typeof data.hooks === "object" ? data.hooks : {};
  data.hooks = hooks;
  const command = hookCommand();
  let changed = false;
  for (const event of ["UserPromptSubmit", "Stop"]) {
    const groups = Array.isArray(hooks[event]) ? hooks[event] : [];
    let found = false;
    for (const group of groups) {
      for (const hook of group.hooks || []) {
        if (!String(hook.command || "").includes(HOOK_MARKER)) continue;
        found = true;
        if (hook.command !== command) {
          hook.command = command;
          changed = true;
        }
      }
    }
    if (!found) {
      groups.push({
        matcher: "",
        hooks: [{ type: "command", command, timeout: 5, async: true }],
      });
      changed = true;
    }
    hooks[event] = groups;
  }
  if (!changed) return;
  try {
    atomicWrite(file, `${JSON.stringify(data, null, 2)}\n`);
    JSON.parse(fs.readFileSync(file, "utf8"));
    console.log("Agent hook installed for Claude Code.");
  } catch (err) {
    try {
      fs.writeFileSync(file, raw);
    } catch {
      // The original text could not be put back. The error below names this step.
    }
    console.error("Failed while saving the agent hook into Claude settings:", err.message);
  }
}

function installCursorHooks() {
  const file = path.join(os.homedir(), ".cursor", "hooks.json");
  let raw = "";
  let data = { version: 1, hooks: {} };
  try {
    raw = fs.readFileSync(file, "utf8");
    data = JSON.parse(raw);
  } catch (err) {
    if (err?.code !== "ENOENT") {
      console.error("Failed while reading Cursor hooks for the agent hook:", err.message);
      return;
    }
  }
  const hooks = data.hooks && typeof data.hooks === "object" ? data.hooks : {};
  data.hooks = hooks;
  data.version = data.version || 1;
  const command = hookCommand();
  let changed = false;
  for (const event of ["beforeSubmitPrompt", "afterAgentResponse", "stop"]) {
    const list = Array.isArray(hooks[event]) ? hooks[event] : [];
    let found = false;
    for (const entry of list) {
      if (!String(entry?.command || "").includes(HOOK_MARKER)) continue;
      found = true;
      if (entry.command !== command) {
        entry.command = command;
        changed = true;
      }
    }
    if (!found) {
      list.push({ command });
      changed = true;
    }
    hooks[event] = list;
  }
  if (!changed) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    atomicWrite(file, `${JSON.stringify(data, null, 2)}\n`);
    JSON.parse(fs.readFileSync(file, "utf8"));
    console.log("Agent hook installed for Cursor.");
  } catch (err) {
    if (raw) {
      try {
        fs.writeFileSync(file, raw);
      } catch {
        // Putting the old file back failed. The error below names this step.
      }
    }
    console.error("Failed while saving the agent hook into Cursor:", err.message);
  }
}

// ---- watcher: the session log already written by session_logger.py ----
// These reads used to be synchronous. One slow OneDrive folder then froze the
// whole server, including the R notebook, until the disk call returned.

const offsets = new Map();
const tails = new Map();
const skipUntil = new Map(); // path -> do not touch again before this time
let watchTimer = null;
let folderCache = [];
let foldersAt = 0;
let polling = false;

function skip(file, ms) {
  skipUntil.set(file, Date.now() + ms);
}

function skipping(file) {
  return (skipUntil.get(file) || 0) > Date.now();
}

async function projectFolders() {
  const now = Date.now();
  if (folderCache.length && now - foldersAt < 5 * 60_000) return folderCache;
  foldersAt = now;
  const found = [];
  try {
    const reg = JSON.parse(await fs.promises.readFile(REGISTRY, "utf8"));
    for (const key of Object.keys(reg)) {
      const dir = path.resolve(String(key));
      if (skipping(dir)) continue;
      const started = Date.now();
      try {
        if ((await fs.promises.stat(dir)).isDirectory()) found.push(dir);
        else skip(dir, 10 * 60_000);
      } catch {
        // Missing, or OneDrive did not answer. Leave it alone for a while.
        skip(dir, Date.now() - started > 1000 ? 10 * 60_000 : 5 * 60_000);
      }
    }
  } catch (err) {
    console.error("Failed while reading the agent list:", err.message);
    return folderCache;
  }
  folderCache = found;
  return found;
}

/** Read a slice of a file. The handle is always closed, including when the read fails. */
async function readSlice(file, start, length) {
  const handle = await fs.promises.open(file, "r");
  try {
    const buf = Buffer.alloc(length);
    await handle.read(buf, 0, length, start);
    return buf.toString("utf8");
  } finally {
    await handle.close();
  }
}

async function baseline(file, size) {
  const take = Math.min(size, 2500);
  let text = "";
  try {
    text = await readSlice(file, Math.max(0, size - take), take);
  } catch {
    text = "";
  }
  const state = { extra: "", name: "", prompt: "" };
  for (const line of text.split("\n")) {
    const head = line.match(/^## \d{4}-\d{2}-\d{2} \d{2}:\d{2} — (.+)$/);
    if (head) state.name = head[1].trim();
    const prompt = line.match(/^\*\*Prompt:\*\* (.*)$/);
    if (prompt) state.prompt = prompt[1];
  }
  tails.set(file, state);
  offsets.set(file, size);
}

function consumeLog(file, chunk) {
  const state = tails.get(file) || { extra: "", name: "", prompt: "" };
  const lines = (state.extra + chunk).split("\n");
  state.extra = lines.pop() || "";
  for (const line of lines) {
    const head = line.match(/^## \d{4}-\d{2}-\d{2} \d{2}:\d{2} — (.+)$/);
    if (head) {
      state.name = head[1].trim();
      continue;
    }
    const prompt = line.match(/^\*\*Prompt:\*\* (.*)$/);
    if (prompt) {
      state.prompt = prompt[1];
      noteStart({ name: state.name || "Claude", prompt: prompt[1], session: "", cwd: path.dirname(path.dirname(file)) });
      continue;
    }
    const response = line.match(/^\*\*Response:\*\* (.*)$/);
    if (response) {
      noteStop({
        name: state.name || "Claude",
        prompt: state.prompt || "",
        reply: response[1],
        session: "",
        cwd: path.dirname(path.dirname(file)),
      });
    }
  }
  tails.set(file, state);
}

async function pollLogs() {
  if (polling) return;
  polling = true;
  try {
    for (const dir of await projectFolders()) {
      const file = path.join(dir, ".claude", "logs.md");
      if (skipping(file)) continue;
      const started = Date.now();
      let stat;
      try {
        stat = await fs.promises.stat(file);
      } catch {
        // No log, or the cloud file did not answer. A slow one is left alone longer.
        skip(file, Date.now() - started > 1000 ? 10 * 60_000 : 5 * 60_000);
        continue;
      }
      if (Date.now() - started > 1000) skip(file, 60_000);
      const prev = offsets.get(file);
      if (prev == null || stat.size < prev) {
        await baseline(file, stat.size);
        continue;
      }
      if (stat.size === prev) continue;
      try {
        consumeLog(file, await readSlice(file, prev, stat.size - prev));
        offsets.set(file, stat.size);
      } catch (err) {
        console.error("Failed while reading a Claude session log:", err.message);
        skip(file, 60_000);
      }
    }
  } finally {
    polling = false;
  }
}

/** Start noticing session logs. The first look only remembers how long each log is. */
export function startAgentWatch() {
  if (watchTimer) return;
  pollLogs().catch((err) => console.error("Failed while starting the agent watch:", err.message));
  watchTimer = setInterval(() => {
    pollLogs().catch((err) => console.error("Failed while watching Claude session logs:", err.message));
  }, 2000);
  watchTimer.unref?.();
  console.log("Watching Claude session logs for agents.md.");
  startIdleSweep();
}
