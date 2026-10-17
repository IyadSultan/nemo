/**
 * The R tab: one R session (rserver.R) that keeps its variables between runs, like a
 * console, but answers with items the page can draw: text, HTML tables, PNG plots,
 * messages, warnings, errors. It runs in ~/.brain/r; files the user opens are copied
 * there. Code and output are never logged (they may hold patient data).
 *
 * POST /r/run {code} → {items}, POST /r/restart, POST /r/file (X-File-Name, raw body),
 * GET /r/out/<id>/<file> (plots). POST /r/ai {request, recent, model} → {say, code}: the
 * brain writes R for the notebook from what is in the session (names and shapes only).
 */

import express from "express";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { BRAIN_DIR, __dirname } from "./config.js";
import { parseJsonObject } from "./deck.js";
import { askModelOnce } from "./models.js";
import { getModel } from "./pricing.js";

const RSCRIPT = "/usr/local/bin/Rscript";
const SCRIPT = path.join(__dirname, "rserver.R");
export const R_DIR = path.join(BRAIN_DIR, "r");
const OUT_DIR = path.join(R_DIR, ".out");
const RUN_MS = 10 * 60 * 1000;

let child = null;
let buffer = "";
const waiting = new Map(); // id → { resolve, reject, timer }
let counter = 0;

function fail(why) {
  for (const [, w] of waiting) {
    clearTimeout(w.timer);
    w.reject(new Error(why));
  }
  waiting.clear();
}

async function start() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  const proc = spawn(RSCRIPT, ["--vanilla", SCRIPT, OUT_DIR], {
    cwd: R_DIR,
    env: { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || ""}`, ANTHROPIC_API_KEY: "" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  buffer = "";
  proc.stdout.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      const w = waiting.get(msg.id);
      if (!w) continue;
      waiting.delete(msg.id);
      clearTimeout(w.timer);
      w.resolve(Array.isArray(msg.items) ? msg.items : []);
    }
  });
  let stderr = "";
  proc.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-2000); });
  proc.on("error", (err) => {
    console.error("Could not start R:", err.message);
    if (child === proc) child = null;
    fail(`R could not start (${err.message}). Is R installed at ${RSCRIPT}?`);
  });
  proc.on("close", (code) => {
    if (child === proc) child = null;
    // The startup failure (a missing package, for example) is the useful part of stderr.
    const why = stderr.trim().split("\n").filter((l) => /error|Error|there is no package/i.test(l)).pop() || `R stopped (exit ${code}).`;
    fail(why);
  });
  child = proc;
  return proc;
}

/** Run code in the session. Resolves with the items; rejects when R dies or takes over 10 minutes. */
export async function runR(code) {
  const proc = child || await start();
  const id = `${Date.now().toString(36)}-${(counter += 1)}`;
  const items = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waiting.delete(id);
      reject(new Error("R did not finish in 10 minutes. Restart R to stop it."));
    }, RUN_MS);
    waiting.set(id, { resolve, reject, timer });
    proc.stdin.write(`${JSON.stringify({ id, code })}\n`);
  });
  return items.map((item) => (item.type === "plot" ? { ...item, url: `/r/out/${id}/${item.file}` } : item));
}

/** End the session (and its variables). The next run starts a fresh one. */
export function restartR() {
  const proc = child;
  child = null;
  fail("R was restarted.");
  if (proc) proc.kill("SIGKILL");
}

// What the session holds: each object's name, class and shape, and data frame columns.
// Values are never listed; a table can hold patients.
const SUMMARY_CODE = `local({
  objs <- ls(globalenv())
  if (!length(objs)) cat("No objects yet.\\n")
  for (n in objs) {
    x <- get(n, globalenv())
    if (is.data.frame(x)) {
      cols <- paste(sprintf("%s (%s)", names(x), vapply(x, function(c) class(c)[1], "")), collapse = ", ")
      cat(sprintf("%s: data frame, %d rows x %d cols: %s\\n", n, nrow(x), ncol(x), substr(cols, 1, 4000)))
    } else if (is.function(x)) cat(sprintf("%s: function\\n", n))
    else cat(sprintf("%s: %s, length %d\\n", n, class(x)[1], length(x)))
  }
  files <- list.files()
  if (length(files)) cat("Files in the working folder:", paste(head(files, 40), collapse = ", "), "\\n")
})`;

async function sessionSummary() {
  try {
    const items = await runR(SUMMARY_CODE);
    return items.filter((i) => i.type === "text").map((i) => i.text).join("").slice(0, 8000);
  } catch {
    return "";
  }
}

const R_INSTRUCTION = [
  "You write R for Dr Iyad Sultan's notebook in his second brain. One R session holds the objects listed; your code runs there and the user sees its output as text, tables, and plots.",
  'Reply with JSON only: {"say": "...", "code": "..."}. say is one or two short plain sentences (it is shown next to the output, so do not repeat the numbers the output will show). code is the R to run, or "" when nothing needs running.',
  "Code: use the objects by name; column names with spaces or symbols need backticks. dplyr, tidyr, ggplot2 and readr are already attached. Also installed (call with library() or ::): readxl, haven, jsonlite, knitr, gtsummary, survival, survminer. Never install packages. Never write files outside the working folder.",
  "Show results by printing them: a data frame or tibble for a table, a ggplot object for a plot (base graphics are fine too), cat() for a single value. Keep code short and readable; a comment line per step is enough.",
  "The table may hold patients or staff: show counts, summaries and figures, not rows of names or identifiers, unless the user asks for them.",
  "When the user asks about results already in the recent cells, answer in say and leave code empty. When the request is unclear, pick the sensible reading and say what you assumed.",
].join(" ");

export function registerR(app) {
  app.post("/r/ai", async (req, res) => {
    const request = String(req.body?.request || "").trim().slice(0, 4000);
    if (!request) return res.status(400).json({ error: "Say what to do." });
    const recent = (Array.isArray(req.body?.recent) ? req.body.recent : []).slice(-4)
      .map((c) => `Code:\n${String(c?.code || "").slice(0, 2000)}\nOutput:\n${String(c?.output || "").slice(0, 1500)}`)
      .join("\n\n");
    const model = getModel(req.body?.model) || getModel("claude-sonnet");
    const parts = [
      `In the R session now:\n${(await sessionSummary()) || "(could not be read)"}`,
      recent ? `Recent cells:\n${recent}` : "No cells have run yet.",
      `Request: ${request}`,
    ];
    try {
      const raw = await askModelOnce(model, R_INSTRUCTION, parts.join("\n\n"), process.env.OPENAI_API_KEY, 3000, 180_000);
      const reply = parseJsonObject(raw);
      if (!reply) return res.json({ say: String(raw || "").trim().slice(0, 4000) || "I could not write that.", code: "" });
      res.json({ say: String(reply.say || "").slice(0, 4000), code: String(reply.code || "").slice(0, 20_000) });
    } catch (err) {
      console.error("Failed while writing R for the notebook:", err?.name || "", String(err?.message || "").slice(0, 120));
      res.status(400).json({ error: "The model did not answer. Try again." });
    }
  });

  app.post("/r/run", async (req, res) => {
    const code = typeof req.body?.code === "string" ? req.body.code : "";
    if (!code.trim()) return res.status(400).json({ error: "Type some R first." });
    try {
      res.json({ items: await runR(code) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/r/restart", (_req, res) => {
    restartR();
    res.json({ ok: true });
  });

  /** Copy a data file into ~/.brain/r, where the session runs. */
  app.post("/r/file", express.raw({ type: "*/*", limit: "500mb" }), async (req, res) => {
    let name = "";
    try {
      name = path.basename(decodeURIComponent(String(req.get("x-file-name") || ""))).replace(/[^\w.-]+/g, "_");
    } catch {
      return res.status(400).json({ error: "The file name could not be read." });
    }
    if (!name || name.startsWith(".") || !Buffer.isBuffer(req.body) || !req.body.length) {
      return res.status(400).json({ error: "Pick a file with something in it." });
    }
    try {
      await fs.mkdir(R_DIR, { recursive: true });
      await fs.writeFile(path.join(R_DIR, name), req.body);
      res.json({ name });
    } catch (err) {
      console.error("Failed while saving a file for R:", err?.message || err);
      res.status(500).json({ error: "Could not save that file." });
    }
  });

  app.use("/r/out", express.static(OUT_DIR, { dotfiles: "deny", index: false }));

  /** Export: the page's HTML, saved where the user picks in a macOS save dialog. */
  app.post("/r/export", express.text({ type: "text/html", limit: "300mb" }), async (req, res) => {
    const html = typeof req.body === "string" ? req.body : "";
    if (!html.trim()) return res.status(400).json({ error: "There is nothing to export." });
    let suggested = "R analysis.html";
    try {
      suggested = path.basename(decodeURIComponent(String(req.get("x-file-name") || ""))).replace(/[/:\\]/g, "-") || suggested;
    } catch {}
    const script = `POSIX path of (choose file name with prompt "Save the R analysis as:" default name ${JSON.stringify(suggested)} default location (path to desktop))`;
    let target = "";
    try {
      target = await new Promise((resolve, reject) => {
        execFile("/usr/bin/osascript", ["-e", script], { timeout: 300_000 }, (err, stdout, stderr) => {
          if (err) reject(Object.assign(err, { stderr: String(stderr || "") }));
          else resolve(String(stdout).trim());
        });
      });
    } catch (err) {
      if (/-128|User cancel/i.test(`${err.message} ${err.stderr || ""}`)) return res.json({ cancelled: true });
      console.error("Failed while asking where to save the R export:", err?.message || err);
      return res.status(500).json({ error: "The save dialog could not open." });
    }
    if (!target) return res.json({ cancelled: true });
    if (!/\.html?$/i.test(target)) target += ".html";
    try {
      await fs.writeFile(target, html, "utf8");
      execFile("/usr/bin/open", ["-R", target]);
      res.json({ path: target });
    } catch (err) {
      console.error("Failed while writing the R export:", err?.message || err);
      res.status(500).json({ error: "Could not write the file there." });
    }
  });
}
