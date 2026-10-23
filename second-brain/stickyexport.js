// Export the open sticky board. As text: Markdown, Word or PDF, made here from the notes.
// As a picture: JPEG or PDF. The page sends a copy of the drawn board, headless
// Chrome photographs it, and the file lands in Downloads with the Finder showing it.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { PDFDocument } from "pdf-lib";
import { boardForExport } from "./stickies.js";
import { CHROME, PDF_DIR, runChrome } from "./pdf.js";

export const FORMATS = ["md", "docx", "pdf", "jpg", "image-pdf"];
const WORK_DIR = path.join(PDF_DIR, "stickies-export");
// Big enough for a full 3200 x 2400 board at 2x, small enough that Chrome stays quick.
const MAX_SIDE = 4000;

const escapeHtml = (text) => String(text ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

/** Note HTML (already cleaned by sanitizeHtml) as Markdown: bold, italics, lists and line breaks. */
export function htmlToMarkdown(html) {
  return String(html || "")
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\s*li[^>]*>/gi, "\n- ")
    .replace(/<\/\s*(div|p|li|ul|ol|h[1-6])\s*>/gi, "\n")
    .replace(/<\s*(b|strong)[^>]*>([\s\S]*?)<\/\s*\1\s*>/gi, "**$2**")
    .replace(/<\s*(i|em)[^>]*>([\s\S]*?)<\/\s*\1\s*>/gi, "*$2*")
    .replace(/<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, "[$2]($1)")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** "Task · high · due 30 Oct" under the title, or "" for a plain note. */
function metaLine(note) {
  const bits = [];
  if (note.noteType === "task") bits.push(note.taskStatus === "done" ? "Done" : "To do");
  if (note.priority && note.priority !== "none") bits.push(`${note.priority} priority`);
  if (note.dueAt) bits.push(`due ${new Date(note.dueAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}`);
  return bits.join(" · ");
}

function titleOf(note) {
  return note.title || htmlToMarkdown(note.content).split("\n")[0].replace(/[*#]/g, "").slice(0, 80) || "Untitled note";
}

function today() {
  return new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
}

export function boardMarkdown({ name, notes }) {
  const out = [`# ${name}`, "", `${notes.length} ${notes.length === 1 ? "note" : "notes"}, exported ${today()}.`];
  for (const note of notes) {
    out.push("", `## ${titleOf(note)}`);
    const meta = metaLine(note);
    if (meta) out.push("", `*${meta}*`);
    const body = htmlToMarkdown(note.content);
    if (body) out.push("", body);
    const back = htmlToMarkdown(note.back);
    if (back) out.push("", "Back of the note:", "", back);
    if (note.checklist?.length) out.push("", ...note.checklist.map((item) => `- [${item.done ? "x" : " "}] ${item.text}`));
    if (note.hashtags?.length) out.push("", note.hashtags.map((tag) => `#${tag.display}`).join(" "));
  }
  return `${out.join("\n")}\n`;
}

export function boardHtml({ name, notes }) {
  const parts = notes.map((note) => {
    const meta = metaLine(note);
    const checks = note.checklist?.length
      ? `<ul class="checks">${note.checklist.map((item) => `<li>${item.done ? "☑" : "☐"} ${escapeHtml(item.text)}</li>`).join("")}</ul>`
      : "";
    const tags = note.hashtags?.length ? `<p class="tags">${escapeHtml(note.hashtags.map((tag) => `#${tag.display}`).join(" "))}</p>` : "";
    const back = note.back ? `<p class="meta">Back of the note:</p><div class="back">${note.back}</div>` : "";
    return `<section><h2>${escapeHtml(titleOf(note))}</h2>${meta ? `<p class="meta">${escapeHtml(meta)}</p>` : ""}<div>${note.content || ""}</div>${back}${checks}${tags}</section>`;
  });
  return [
    "<!DOCTYPE html><html><head><meta charset=\"utf-8\"><meta http-equiv=\"Content-Security-Policy\" content=\"script-src 'none'\">",
    `<title>${escapeHtml(name)}</title><style>`,
    "@page{size:A4;margin:16mm}body{font:11pt/1.45 -apple-system,Helvetica,Arial,sans-serif;color:#1E2A32;margin:0}",
    "h1{font-size:22pt;margin:0 0 4pt}h2{font-size:14pt;margin:16pt 0 2pt;color:#0F6E74}.meta,.tags,.when{color:#5b6770;font-size:10pt;margin:2pt 0}",
    "section{break-inside:avoid}ul.checks{list-style:none;padding-left:0}.back{font-size:9.5pt;color:#3a4650}",
    "</style></head><body>",
    `<h1>${escapeHtml(name)}</h1><p class="when">${notes.length} ${notes.length === 1 ? "note" : "notes"}, exported ${today()}.</p>`,
    ...parts,
    "</body></html>",
  ].join("");
}

/**
 * The page's copy of the board as a whole page. Only stylesheets from this app load,
 * and the page blocks scripts, so the copy can only draw.
 */
export function snapshotPage(snap) {
  const width = Math.round(Number(snap?.width));
  const height = Math.round(Number(snap?.height));
  if (!(width > 0 && height > 0 && width <= MAX_SIDE && height <= MAX_SIDE)) throw new Error("The board is too big or empty to make a picture.");
  const css = (Array.isArray(snap.css) ? snap.css : [])
    .filter((href) => /^http:\/\/(127\.0\.0\.1|localhost):\d+\/[\w./-]+\.css$/.test(href))
    .map((href) => `<link rel="stylesheet" href="${escapeHtml(href)}">`)
    .join("");
  const appearance = snap.appearance === "dark" ? "dark" : "light";
  const html = [
    "<!DOCTYPE html><html><head><meta charset=\"utf-8\"><meta http-equiv=\"Content-Security-Policy\" content=\"script-src 'none'\">",
    css,
    `<style>html,body{margin:0;padding:0;width:${width}px;height:${height}px;overflow:hidden}`,
    ".stickies-panel{position:static;inset:auto;width:auto;height:auto;margin:0;padding:0;border:0;border-radius:0;background:none;box-shadow:none;display:block}",
    "*{-webkit-print-color-adjust:exact;print-color-adjust:exact;animation:none!important;transition:none!important}</style>",
    `</head><body><section class="stickies-panel" data-appearance="${appearance}">`,
    String(snap.html || ""),
    "</section></body></html>",
  ].join("");
  return { html, width, height };
}

function run(bin, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${path.basename(bin)} failed: ${stderr.slice(-200)}`))));
  });
}

/** Board name as a file name: "Arranging a conference 2026-10-22.md". */
function fileName(name, ext) {
  const safe = String(name || "Board").replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 60) || "Board";
  return `${safe} ${new Date().toISOString().slice(0, 10)}.${ext}`;
}

/** A path in Downloads that does not overwrite anything there. */
async function freePath(name) {
  const folder = path.join(os.homedir(), "Downloads");
  const ext = path.extname(name);
  const base = name.slice(0, -ext.length);
  for (let n = 0; n < 100; n += 1) {
    const candidate = path.join(folder, n ? `${base} ${n + 1}${ext}` : name);
    try {
      await fs.access(candidate);
    } catch {
      return candidate;
    }
  }
  throw new Error("Too many files with that name in Downloads.");
}

// A fresh profile each time: a Chrome still closing on a shared profile takes the job and writes nothing.
const CHROME_BASE = (profile) => [
  "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
  `--user-data-dir=${profile}`, "--virtual-time-budget=4000",
];

/** Chrome can exit 0 without writing, or crash while closing after it wrote. The file decides. */
async function chrome(args, out) {
  const failed = await runChrome(args, 90000).then(() => null, (err) => err);
  const info = await fs.stat(out).catch(() => null);
  if (!info?.size) throw failed || new Error("Chrome did not make the file. Try again.");
}

async function mustExist(file) {
  const info = await fs.stat(file).catch(() => null);
  if (!info?.size) throw new Error("Could not make the file. Try again.");
}

/** Makes the file in Downloads. Returns its path. */
export async function exportBoard(format, snapshot) {
  if (!FORMATS.includes(format)) throw new Error("Pick Markdown, Word, PDF, JPEG or picture PDF.");
  const data = boardForExport();
  const target = await freePath(fileName(data.name, format === "image-pdf" ? "pdf" : format));
  if (format === "md") {
    await fs.writeFile(target, boardMarkdown(data), "utf8");
    return target;
  }
  if (format !== "docx" && !CHROME) throw new Error("Google Chrome is not installed, so this export cannot be made.");
  await fs.mkdir(WORK_DIR, { recursive: true });
  const id = crypto.randomBytes(4).toString("hex");
  const htmlPath = path.join(WORK_DIR, `${id}.html`);
  const profile = path.join(WORK_DIR, `${id}-chrome`);
  const temp = [htmlPath, profile];
  try {
    if (format === "docx" || format === "pdf") {
      await fs.writeFile(htmlPath, boardHtml(data), "utf8");
      if (format === "docx") await run("/usr/bin/textutil", ["-convert", "docx", "-output", target, htmlPath]);
      else await chrome([...CHROME_BASE(profile), "--no-pdf-header-footer", `--print-to-pdf=${target}`, `file://${htmlPath}`], target);
      return target;
    }
    const page = snapshotPage(snapshot);
    await fs.writeFile(htmlPath, page.html, "utf8");
    const pngPath = path.join(WORK_DIR, `${id}.png`);
    temp.push(pngPath);
    // Twice the pixels, so text stays sharp when zoomed or printed.
    await chrome([
      ...CHROME_BASE(profile), "--hide-scrollbars", "--force-device-scale-factor=2",
      `--window-size=${page.width},${page.height}`, `--screenshot=${pngPath}`, `file://${htmlPath}`,
    ], pngPath);
    if (format === "jpg") {
      await run("/usr/bin/sips", ["-s", "format", "jpeg", "-s", "formatOptions", "90", pngPath, "--out", target]);
      await mustExist(target);
      return target;
    }
    // One page the size of the board (pixels at 96 dpi = 0.75 pt).
    const pdf = await PDFDocument.create();
    pdf.setTitle(data.name);
    const image = await pdf.embedPng(await fs.readFile(pngPath));
    const pageOut = pdf.addPage([page.width * 0.75, page.height * 0.75]);
    pageOut.drawImage(image, { x: 0, y: 0, width: page.width * 0.75, height: page.height * 0.75 });
    await fs.writeFile(target, await pdf.save());
    return target;
  } finally {
    await Promise.all(temp.map((file) => fs.rm(file, { force: true, recursive: true })));
  }
}

/** POST /stickies/export { format, snapshot? }: the file goes to Downloads and the Finder shows it. */
export function registerStickyExport(app) {
  app.post("/stickies/export", async (req, res) => {
    try {
      const target = await exportBoard(String(req.body?.format || ""), req.body?.snapshot);
      spawn("/usr/bin/open", ["-R", target], { stdio: "ignore" }).on("error", () => {});
      res.json({ ok: true, path: target, name: path.basename(target) });
    } catch (err) {
      console.error("Failed while exporting the sticky board:", err?.message || err);
      res.status(400).json({ error: err?.message || "Could not export the board." });
    }
  });
}
