// Word documents in the app: WordCraft (github.com/storytold/wordcraft, MIT/Apache-2.0), its
// browser build with a small JS bridge, served from vendor/wordcraft by voice/install-wordcraft.sh.
// The page (public/wordedit.js) drives it; this file answers the AI requests and opens and saves
// files on disk. File names, paths and document text are never logged (they may name patients).
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { askModelOnce } from "./models.js";
import { getModel } from "./pricing.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.join(__dirname, "vendor", "wordcraft");
const HOME = os.homedir();
const LOOK_IN = ["Documents", "Desktop", "Downloads"].map((name) => path.join(HOME, name));
const SAVE_DIR = path.join(HOME, "Documents");
const WORD_TYPES = new Set([".docx", ".docm", ".dotx", ".doc", ".odt", ".rtf", ".md", ".txt", ".html", ".htm"]);
const SAVE_TYPES = new Set([".docx", ".odt", ".rtf", ".md", ".txt", ".html", ".pdf"]);
// Characters of document text sent with a request.
const DOC_CHARS = 120_000;

const INSTRUCTION = [
  "You read and edit a Word document for the user. Reply with one JSON object only, no other text:",
  '{"say":"…","ops":[…]}.',
  "say is the answer or a short note of what you changed, plain sentences, no markdown symbols. It may be read aloud.",
  "ops run in order on the open document. Each op is one of:",
  '{"select":"exact text"}: selects text copied character for character from the document, inside one paragraph, at most 300 characters.',
  '{"selectAll":true}: selects the whole document.',
  '{"replace":"new text"}: replaces the current selection; separate paragraphs with \\n.',
  '{"format":{…}}: character formatting on the selection. Fields: font, size (points), bold, italic, strike, caps, smallCaps (true/false), underline ("single", "double", "none"), color ("RRGGBB" or "Auto"), highlight ("yellow", "brightGreen", "turquoise", "pink", "none"), vertAlign ("superscript", "subscript", "baseline").',
  '{"para":{…}}: paragraph formatting on the selected paragraphs. Fields: align ("left", "center", "right", "justify"), spaceBefore, spaceAfter, indentLeft, indentFirst (points), lineSpacing ({"rule":"multiple","value":1.5}).',
  '{"style":"Heading 1"}: paragraph style on the selected paragraphs, for example Title, Subtitle, Heading 1, Heading 2, Heading 3, Normal, Quote, List Paragraph.',
  "Rules:",
  "A question about the document (what, why, who, summarize, the main point, find, where): answer in say, using only the document. Add one select op with the passage that best supports the answer, so it is shown, unless the answer is about the whole document.",
  "A change with a selection given: work on the selection. Rewrites use replace with the full new text of the selection. Keep what the user did not ask to change.",
  "A change without a selection: select the text it is about first. For the whole document use selectAll; use replace on selectAll only when the user asks to rewrite the whole text.",
  "Formatting changes use format, para or style, never replace. Do not invent facts. If the request is unclear or the text is not in the document, say so and send no ops.",
].join("\n");

function parseJsonObject(raw) {
  const body = String(raw || "").replace(/```(?:json)?/gi, "");
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}

const OPS = new Set(["select", "selectAll", "replace", "format", "para", "style"]);

/** Only known ops with the right value types reach the page. */
function cleanOps(ops) {
  if (!Array.isArray(ops)) return [];
  return ops
    .filter((op) => op && typeof op === "object")
    .map((op) => Object.fromEntries(Object.entries(op).filter(([key]) => OPS.has(key))))
    .filter((op) => {
      const [key, value] = Object.entries(op)[0] || [];
      if (!key || Object.keys(op).length !== 1) return false;
      if (key === "select" || key === "replace" || key === "style") return typeof value === "string" && value.length > 0 && value.length < 50_000;
      if (key === "selectAll") return value === true;
      return value && typeof value === "object" && !Array.isArray(value);
    })
    .slice(0, 40);
}

/** A file path the page may open or save: under the home folder, a document type, no dot folders. */
export function allowedPath(raw, types) {
  const file = path.resolve(String(raw || ""));
  const rel = path.relative(HOME, file);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  if (rel.split(path.sep).some((part) => part.startsWith("."))) return null;
  return types.has(path.extname(file).toLowerCase()) ? file : null;
}

export async function freeName(folder, name) {
  const ext = path.extname(name);
  const stem = path.basename(name, ext);
  for (let n = 1; n < 1000; n += 1) {
    const file = path.join(folder, n === 1 ? name : `${stem} (${n})${ext}`);
    try {
      await fs.access(file);
    } catch {
      return file;
    }
  }
  throw new Error("Could not find a free file name.");
}

export function registerWordcraft(app) {
  app.use("/wordcraft", express.static(APP_DIR, { dotfiles: "deny" }));

  app.get("/word/installed", async (_req, res) => {
    res.json({ installed: Boolean(await fs.stat(path.join(APP_DIR, "index.html")).catch(() => null)) });
  });

  /** Word documents in Documents, Desktop and Downloads, newest first. */
  app.get("/word/recent", async (_req, res) => {
    const found = [];
    for (const folder of LOOK_IN) {
      const names = (await fs.readdir(folder).catch(() => [])).filter((name) => !name.startsWith(".") && !name.startsWith("~$"));
      for (const name of names) {
        if (!WORD_TYPES.has(path.extname(name).toLowerCase())) continue;
        const file = path.join(folder, name);
        const info = await fs.stat(file).catch(() => null);
        if (info?.isFile()) found.push({ path: file, name, where: path.basename(folder), time: info.mtimeMs });
      }
    }
    res.json({ files: found.sort((a, b) => b.time - a.time).slice(0, 30) });
  });

  app.get("/word/file", async (req, res) => {
    const file = allowedPath(req.query.path, WORD_TYPES);
    if (!file) return res.status(400).json({ error: "That file cannot be opened here." });
    try {
      res.setHeader("Cache-Control", "no-store");
      res.type("application/octet-stream").send(await fs.readFile(file));
    } catch {
      res.status(404).json({ error: "That file is gone." });
    }
  });

  /** Save the document's bytes: back to X-File-Path, or as a new file in Documents named X-File-Name. */
  app.post("/word/save", express.raw({ type: "*/*", limit: "100mb" }), async (req, res) => {
    const bytes = Buffer.isBuffer(req.body) ? req.body : null;
    if (!bytes?.length) return res.status(400).json({ error: "Nothing to save." });
    try {
      let file = null;
      const wanted = decodeURIComponent(String(req.get("x-file-path") || ""));
      if (wanted) {
        file = allowedPath(wanted, SAVE_TYPES);
        if (!file) return res.status(400).json({ error: "It cannot be saved there." });
      } else {
        const name = path.basename(decodeURIComponent(String(req.get("x-file-name") || ""))) || "Document.docx";
        if (!SAVE_TYPES.has(path.extname(name).toLowerCase())) return res.status(400).json({ error: "That file type cannot be saved." });
        await fs.mkdir(SAVE_DIR, { recursive: true });
        file = await freeName(SAVE_DIR, name);
      }
      await fs.writeFile(file, bytes);
      console.log(`Saved a Word document (${path.extname(file)}, ${bytes.length} bytes)`);
      res.json({ path: file, name: path.basename(file) });
    } catch (err) {
      console.error("Failed while saving a Word document:", err?.code || "");
      res.status(400).json({ error: "Could not save it." });
    }
  });

  /** One request about the open document: an answer and the edits to make. */
  app.post("/word/ai", async (req, res) => {
    const request = String(req.body?.request || "").trim().slice(0, 4000);
    if (!request) return res.status(400).json({ error: "Say what to do." });
    const text = String(req.body?.text || "");
    const selection = String(req.body?.selection || "").slice(0, 40_000);
    const title = String(req.body?.title || "Document").slice(0, 200);
    const model = getModel(req.body?.model) || getModel(process.env.WORD_MODEL) || getModel("claude-sonnet");
    const parts = [
      `Document: ${title}`,
      `Text (${text.length > DOC_CHARS ? "first part" : "all"}):\n<<<\n${text.slice(0, DOC_CHARS)}\n>>>`,
      selection ? `Selected text:\n<<<\n${selection}\n>>>` : "Nothing is selected.",
      `Request: ${request}`,
    ];
    try {
      const started = Date.now();
      const raw = await askModelOnce(model, INSTRUCTION, parts.join("\n\n"), process.env.OPENAI_API_KEY, 4000, 180_000);
      const reply = parseJsonObject(raw);
      console.log(`Word AI request: ${text.length} chars, ${Date.now() - started} ms, ${reply ? "ok" : "unreadable reply"}`);
      if (!reply) return res.json({ say: String(raw || "").trim().slice(0, 4000) || "I could not do that.", ops: [] });
      res.json({ say: String(reply.say || "").slice(0, 8000), ops: cleanOps(reply.ops) });
    } catch (err) {
      console.error("Failed while asking about a Word document:", err?.name || "", String(err?.message || "").slice(0, 120));
      res.status(400).json({ error: "The model did not answer. Try again." });
    }
  });
}
