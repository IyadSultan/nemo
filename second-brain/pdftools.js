// Change PDFs by voice: "merge the last two PDFs", "rotate it", "delete page 3".
// The tools are PDFCraft's own (github.com/PDFCraftTool/pdfcraft), bundled into
// vendor/pdfcraft-tools.mjs by voice/install-pdfcraft.sh. Compress and OCR use
// Ghostscript and Tesseract here, since PDFCraft runs those as browser WebAssembly.
// The page also uploads PDFs just for editing (registerPdfTools, public/pdfedit.js).
// File names and paths are never logged (they may name patients).
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import express from "express";
import { PDFDocument } from "pdf-lib";
import { askModelOnce, writeEvent } from "./models.js";
import { getModel } from "./pricing.js";
import { PDF_DIR, storePdf } from "./pdf.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOOLS_FILE = path.join(__dirname, "vendor", "pdfcraft-tools.mjs");
const GS = "/opt/homebrew/bin/gs";
const PDFTOPPM = "/opt/homebrew/bin/pdftoppm";
const TESSERACT = "/opt/homebrew/bin/tesseract";
const LOOK_IN = ["Downloads", "Desktop", "Documents"].map((name) => path.join(os.homedir(), name));
// More results than this go into a folder in Downloads instead of the chat.
const MAX_CARDS = 3;

let tools = null;
async function pdfcraft() {
  if (tools) return tools;
  if (!fsSync.existsSync(TOOLS_FILE)) throw new Error("The PDF tools are not installed. Run voice/install-pdfcraft.sh.");
  tools = await import(TOOLS_FILE);
  return tools;
}

const VERB = /\b(?:merge|combine|join|stitch|split|separate|break up|extract|pull out|take out|keep only|delete|remove|drop|rotate|turn|flip|reverse|number|page numbers|watermark|stamp|compress|shrink|smaller|ocr|searchable)\b/;
const THING = /\b(?:pdfs?|scans?|scanned|pages?|documents?)\b/;
const NEW_DOC = /\b(?:make|create|write|generate|draft|build|prepare) (?:me )?(?:a|an|the|one)\b|\binto (?:a |one )?pdf\b|\b(?:how|why|what|can i|should i)\b/;

/** Does the question ask to change a PDF the user already has? The planner still may say no. */
export function wantsPdfTool(question) {
  const q = String(question || "").toLowerCase();
  if (!VERB.test(q) || !THING.test(q)) return false;
  if (/\b(?:merge|combine|join)\b.*\binto (?:a |one )?pdf\b/.test(q)) return true;
  return !NEW_DOC.test(q.replace(/\bmake (?:it|them|this|that|the \w+) (?:smaller|searchable)\b/, ""));
}

// PDFs uploaded on the page (POST /document), newest last.
const uploaded = [];
export function rememberPdf(file) {
  if (path.extname(file).toLowerCase() !== ".pdf") return;
  const at = uploaded.indexOf(file);
  if (at >= 0) uploaded.splice(at, 1);
  uploaded.push(file);
  if (uploaded.length > 10) uploaded.shift();
}

async function stat(file) {
  try {
    return await fs.stat(file);
  } catch {
    return null;
  }
}

/** PDFs the user may mean, newest first: uploaded, made by the brain, then Downloads, Desktop, Documents. */
async function pdfsOnHand() {
  const found = [];
  for (const file of uploaded) {
    const info = await stat(file);
    if (info) found.push({ file, name: path.basename(file), where: "uploaded in the app", time: info.mtimeMs });
  }
  const made = (await fs.readdir(PDF_DIR).catch(() => [])).filter((name) => name.endsWith(".pdf"));
  for (const entry of made) {
    const file = path.join(PDF_DIR, entry);
    const info = uploaded.includes(file) ? null : await stat(file);
    if (!info) continue;
    const name = (await fs.readFile(file.replace(/\.pdf$/, ".name"), "utf8").catch(() => entry)).trim();
    found.push({ file, name, where: "made by the brain", time: info.mtimeMs });
  }
  for (const folder of LOOK_IN) {
    const names = (await fs.readdir(folder).catch(() => [])).filter((name) => /\.pdf$/i.test(name) && !name.startsWith("."));
    for (const name of names) {
      const file = path.join(folder, name);
      const info = await stat(file);
      if (info?.isFile()) found.push({ file, name, where: `in ${path.basename(folder)}`, time: info.mtimeMs });
    }
  }
  return found.sort((a, b) => b.time - a.time).slice(0, 20);
}

const PLAN_INSTRUCTION = [
  "You pick one PDF tool for a spoken request and reply with one JSON object only, no other text.",
  "Tools: merge (two or more files, in the order the user said), split (one file; pages as ranges like \"1-3,4-6\", or empty for every page), extract (keep only the pages given), delete (remove the pages given), rotate (angle 90, 180 or 270 clockwise; pages empty means all), reverse (page order), numbers (add page numbers), watermark (text across every page), compress (make the file smaller), ocr (make a scan searchable), none.",
  "Use none when the user does not ask to change an existing PDF, for example when they want a new PDF written, or ask how to do something.",
  'Reply as {"tool":"…","files":[1],"pages":"","angle":90,"text":"","say":"…"}. files are numbers from the list. say is one short spoken sentence of what you are doing, with no file paths and no symbols.',
  "When the user says it, this, or the PDF, or the file is unclear, use number 1 (the newest). For merge with no files named, use the newest ones the user counts, oldest first.",
].join(" ");

function firstJson(text) {
  const raw = String(text || "");
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
}

function run(bin, args, timeout = 300_000) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

async function asFile(item) {
  return new File([await fs.readFile(item.file)], item.name, { type: "application/pdf" });
}

/** "1-3,5" becomes [1, 2, 3, 5], within the page count. */
function pageList(text, count) {
  const pages = [];
  for (const part of String(text || "").split(",")) {
    const m = part.trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/);
    if (!m) continue;
    const from = Number(m[1]);
    const to = Math.min(Number(m[2] || m[1]), count);
    for (let n = from; n <= to; n += 1) if (n >= 1 && !pages.includes(n)) pages.push(n);
  }
  return pages;
}

const stem = (name) => name.replace(/\.pdf$/i, "");

async function compress(item) {
  const out = path.join(os.tmpdir(), `brain-compress-${process.pid}-${Date.now()}.pdf`);
  try {
    await run(GS, ["-sDEVICE=pdfwrite", "-dCompatibilityLevel=1.5", "-dPDFSETTINGS=/ebook", "-dNOPAUSE", "-dQUIET", "-dBATCH", `-sOutputFile=${out}`, item.file]);
    const bytes = await fs.readFile(out);
    const before = (await fs.stat(item.file)).size;
    if (bytes.length >= before) return { outputs: [], note: "It is already as small as it gets, so I left it as it was." };
    const saved = Math.round((1 - bytes.length / before) * 100);
    return { outputs: [{ bytes, name: `${stem(item.name)}_compressed.pdf` }], note: `It is ${saved} percent smaller.` };
  } finally {
    fs.rm(out, { force: true }).catch(() => {});
  }
}

/** Each page becomes an image, Tesseract reads it and writes a page with a text layer. */
async function ocr(item) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "brain-ocr-"));
  try {
    await run(PDFTOPPM, ["-r", "300", "-png", item.file, path.join(dir, "p")]);
    const images = (await fs.readdir(dir)).filter((name) => name.endsWith(".png")).sort();
    const merged = await PDFDocument.create();
    for (const image of images) {
      const base = path.join(dir, image.replace(/\.png$/, ""));
      await run(TESSERACT, [path.join(dir, image), base, "-l", "eng", "pdf"]);
      const page = await PDFDocument.load(await fs.readFile(`${base}.pdf`));
      for (const copied of await merged.copyPages(page, page.getPageIndices())) merged.addPage(copied);
    }
    return { outputs: [{ bytes: Buffer.from(await merged.save()), name: `${stem(item.name)}_searchable.pdf` }] };
  } finally {
    fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Ghostscript writes a copy that needs a password to open (128-bit), or a copy without one. */
async function password(item, plan) {
  const secret = String(plan.password || "");
  if (!secret) throw new Error("Type the password.");
  if (secret.length > 100 || /[\0\n]/.test(secret)) throw new Error("That password cannot be used.");
  const out = path.join(os.tmpdir(), `brain-pw-${process.pid}-${Date.now()}.pdf`);
  const args = plan.tool === "password"
    ? [`-sOwnerPassword=${secret}`, `-sUserPassword=${secret}`, "-dEncryptionR=3", "-dKeyLength=128", "-dPermissions=-4"]
    : [`-sPDFPassword=${secret}`];
  try {
    await run(GS, ["-sDEVICE=pdfwrite", "-dNOPAUSE", "-dQUIET", "-dBATCH", ...args, `-sOutputFile=${out}`, item.file]);
    const bytes = await fs.readFile(out);
    // A wrong password makes Ghostscript write an error page instead of failing.
    if (plan.tool === "unlock" && (await pageCount(out)) !== (await pageCount(item.file))) throw new Error("bad password");
    const suffix = plan.tool === "password" ? "protected" : "unlocked";
    return { outputs: [{ bytes, name: `${stem(item.name)}_${suffix}.pdf` }] };
  } catch {
    // Never pass the command (it holds the password) to the log.
    throw new Error(plan.tool === "unlock" ? "That password did not open it." : "Could not add the password.");
  } finally {
    fs.rm(out, { force: true }).catch(() => {});
  }
}

/** Every page as a PNG, in a new folder in Downloads. */
async function toImages(item) {
  const downloads = path.join(os.homedir(), "Downloads");
  let folder = path.join(downloads, `${stem(item.name)} pages`);
  for (let n = 2; fsSync.existsSync(folder); n += 1) folder = path.join(downloads, `${stem(item.name)} pages ${n}`);
  await fs.mkdir(folder);
  await run(PDFTOPPM, ["-r", "150", "-png", item.file, path.join(folder, "page")]);
  run("open", [folder]).catch(() => {});
  return { outputs: [], note: `The pages are pictures in a new folder in Downloads: ${path.basename(folder)}.` };
}

const STAMPS = ["approved", "rejected", "draft", "confidential", "final", "copy"];

/** Pages to work on: the ones given, else page 1 (or every page when all is true). */
function pagesOr(pages, count, all) {
  if (pages.length) return pages;
  return all ? Array.from({ length: count }, (_, i) => i + 1) : [1];
}

/** Run one plan. Resolves with { outputs: [{ bytes, name }], note }. */
async function runPlan(plan, files) {
  if (plan.tool === "compress") return compress(files[0]);
  if (plan.tool === "ocr") return ocr(files[0]);
  if (plan.tool === "password" || plan.tool === "unlock") return password(files[0], plan);
  if (plan.tool === "images") return toImages(files[0]);
  const t = await pdfcraft();
  const file = await asFile(files[0]);
  const count = plan.tool === "merge" ? 0 : (await PDFDocument.load(await file.arrayBuffer(), { ignoreEncryption: true })).getPageCount();
  const pages = pageList(plan.pages, count);
  const needPages = () => {
    if (!pages.length) throw new Error(`Which pages? It has ${count} pages.`);
  };
  let out;
  // Split and extract try PyMuPDF (browser only) first and then use pdf-lib. Keep that warning out of the log.
  const warn = console.warn;
  console.warn = (...args) => (/PyMuPDF/.test(String(args[0])) ? undefined : warn(...args));
  try {
    switch (plan.tool) {
      case "merge":
        if (files.length < 2) throw new Error("Merging needs two or more PDFs.");
        out = await t.mergePDFs(await Promise.all(files.map(asFile)));
        break;
      case "split":
        out = await t.splitPDF(file, { ranges: plan.pages ? t.parsePageRanges(plan.pages, count) : t.createSplitEveryPage(count) });
        break;
      case "extract":
        needPages();
        out = await t.extractPages(file, pages);
        break;
      case "delete":
        needPages();
        if (pages.length >= count) throw new Error("That would delete every page.");
        out = await t.deletePages(file, pages);
        break;
      case "rotate": {
        const angle = [90, 180, 270, -90].includes(Number(plan.angle)) ? (Number(plan.angle) + 360) % 360 : 90;
        out = await t.rotatePDF(file, pages.length ? { angle, pages } : { angle });
        break;
      }
      case "reverse":
        out = await t.reversePages(file);
        break;
      case "numbers":
        out = await t.addPageNumbers(file, { position: "bottom-center", format: "page-of-total" });
        break;
      case "watermark":
        out = await t.addWatermark(file, { type: "text", text: String(plan.text || "DRAFT").slice(0, 60), position: "diagonal", opacity: 0.18, fontSize: 64 });
        break;
      case "sign": {
        // Position comes from the page as fractions from the top-left; PDF points start bottom-left.
        const sig = plan.signature || {};
        const data = String(sig.data || "");
        if (!/^data:image\/(png|jpeg);base64,/.test(data) || data.length > 3_000_000) throw new Error("Draw or type the signature first.");
        const doc = await PDFDocument.load(await file.arrayBuffer(), { ignoreEncryption: true });
        const pageNo = Math.min(Math.max(1, Math.round(Number(sig.page) || 1)), count);
        const { width, height } = doc.getPage(pageNo - 1).getSize();
        const frac = (v, d) => Math.min(Math.max(Number.isFinite(Number(v)) ? Number(v) : d, 0), 1);
        const w = frac(sig.w, 0.3) * width;
        const h = w / Math.max(Number(sig.ratio) || 3, 0.2);
        out = await t.signPDF(file, { signatures: [{ type: "image", data, pageNumber: pageNo, x: frac(sig.x, 0.6) * width, y: height - frac(sig.y, 0.8) * height - h, width: w, height: h }] });
        break;
      }
      case "bookmarks": {
        const marks = (Array.isArray(plan.bookmarks) ? plan.bookmarks : [])
          .map((b, i) => ({ id: `b${i}`, title: String(b?.title || "").trim().slice(0, 120), pageNumber: Math.round(Number(b?.page)) }))
          .filter((b) => b.title && b.pageNumber >= 1 && b.pageNumber <= count)
          .slice(0, 200);
        if (!marks.length) throw new Error("Add at least one bookmark with a title and a page.");
        out = await t.processBookmarks(file, { action: "add", bookmarks: marks });
        break;
      }
      case "headerfooter": {
        const header = String(plan.header || "").slice(0, 120);
        const footer = String(plan.footer || "").slice(0, 120);
        if (!header && !footer && !plan.numbers) throw new Error("Type a header or a footer.");
        // PDFCraft fills {page} and {total} in the text.
        out = await t.addHeaderFooter(file, { header: { center: header }, footer: { center: footer, right: plan.numbers ? "Page {page} of {total}" : "" }, fontSize: 10 });
        break;
      }
      case "stamp": {
        const preset = STAMPS.includes(plan.preset) ? plan.preset : "approved";
        const stamps = [];
        const doc = await PDFDocument.load(await file.arrayBuffer(), { ignoreEncryption: true });
        for (const n of pagesOr(pages, count, false)) {
          const { width, height } = doc.getPage(n - 1).getSize();
          stamps.push({ type: "preset", preset, pageNumber: n, x: width - 200, y: height - 90, width: 170, height: 50, rotation: 0, opacity: 0.85 });
        }
        out = await t.addStamps(file, { stamps });
        break;
      }
      case "blank": {
        const after = Math.min(Math.max(0, Math.round(Number(plan.after) || 0)), count);
        out = await t.addBlankPages(file, after, Math.min(Math.max(1, Math.round(Number(plan.count) || 1)), 50));
        break;
      }
      case "info":
        out = await t.editPDFMetadata(file, { title: String(plan.title || "").slice(0, 200), author: String(plan.author || "").slice(0, 120) });
        break;
      case "flatten":
        out = await t.flattenPDF(file, { flattenForms: true, flattenAnnotations: true });
        break;
      case "noannotations":
        out = await t.removeAnnotations(file, { removeAll: true, pages: "all" });
        break;
      case "nup":
        out = await t.createNUpPDF(file, { pagesPerSheet: Number(plan.perSheet) === 4 ? 4 : 2, pageSize: "A4", orientation: "auto" });
        break;
      default:
        throw new Error("I do not know that PDF tool.");
    }
  } finally {
    console.warn = warn;
  }
  if (!out?.success) throw new Error(out?.error?.message || "The PDF tool failed.");
  const blobs = Array.isArray(out.result) ? out.result : [out.result];
  const names = String(out.filename || "").split(/,\s*/);
  const outputs = [];
  for (let i = 0; i < blobs.length; i += 1) {
    outputs.push({ bytes: Buffer.from(await blobs[i].arrayBuffer()), name: names[i] || `${stem(files[0].name)}_${plan.tool}_${i + 1}.pdf` });
  }
  return { outputs };
}

/** Many results (a split into pages) go into one new folder in Downloads, shown in the Finder. */
async function saveFolder(outputs, base) {
  const downloads = path.join(os.homedir(), "Downloads");
  let folder = path.join(downloads, `${base} parts`);
  for (let n = 2; fsSync.existsSync(folder); n += 1) folder = path.join(downloads, `${base} parts ${n}`);
  await fs.mkdir(folder);
  for (const out of outputs) await fs.writeFile(path.join(folder, path.basename(out.name)), out.bytes);
  run("open", [folder]).catch(() => {});
  return folder;
}

/**
 * Answer a PDF-tool request on res as a stream: one spoken sentence, then a PDF card per result.
 * Returns false (nothing written) when the planner says it is not a PDF-tool request.
 */
export async function answerPdfTool(question, res) {
  const files = await pdfsOnHand();
  const model = getModel(process.env.PDF_TOOL_MODEL) || getModel("claude-sonnet");
  const list = files.length
    ? files.map((f, i) => `${i + 1}. ${f.name} (${f.where}, ${new Date(f.time).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })})`).join("\n")
    : "(no PDFs found)";
  const started = Date.now();
  const plan = firstJson(await askModelOnce(model, PLAN_INSTRUCTION, `PDFs on hand, newest first:\n${list}\n\nRequest: ${question}`, process.env.OPENAI_API_KEY, 400, 60000));
  if (!plan || !plan.tool || plan.tool === "none") return false;
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.flushHeaders?.();
  const say = (text) => writeEvent(res, { type: "delta", text });
  const picked = (Array.isArray(plan.files) ? plan.files : [1]).map((n) => files[Number(n) - 1]).filter(Boolean);
  try {
    if (!picked.length) throw new Error("I could not find a PDF. Upload it, or put it in Downloads, then ask again.");
    const { outputs, note } = await runPlan(plan, picked);
    say(String(plan.say || "Done.").trim());
    if (note) say(` ${note}`);
    if (outputs.length > MAX_CARDS) {
      await saveFolder(outputs, stem(picked[0].name));
      say(` There are ${outputs.length} files, so I put them in a new folder in Downloads and opened it.`);
    } else {
      for (const out of outputs) writeEvent(res, { type: "pdf", ...(await storePdf(out.bytes, path.basename(out.name))) });
    }
    console.log(`PDF tool ${plan.tool}: ${picked.length} in, ${outputs.length} out, ${Date.now() - started} ms`);
  } catch (err) {
    console.error(`PDF tool ${plan.tool} failed:`, err?.code || "", String(err?.message || err).slice(0, 200));
    say(err?.message && !err.code ? err.message : "That PDF tool did not work on this file.");
  }
  writeEvent(res, { type: "done" });
  res.end();
  return true;
}

const ID = /^[0-9]{4}-[0-9]{2}-[0-9]{2}-[0-9a-f]{8}$/;
const THUMB_DIR = path.join(__dirname, "tmp", "pdfthumbs");
// A split into more parts than this goes into a folder in Downloads instead of boxes.
const MAX_PARTS = 20;

/** A PDF kept in PDF_DIR (uploaded for editing, or a result), by its id. */
async function editItem(id) {
  if (!ID.test(String(id))) return null;
  const file = path.join(PDF_DIR, `${id}.pdf`);
  if (!(await stat(file))) return null;
  const name = (await fs.readFile(path.join(PDF_DIR, `${id}.name`), "utf8").catch(() => "document.pdf")).trim();
  return { id, file, name };
}

async function pageCount(file) {
  try {
    return (await PDFDocument.load(await fs.readFile(file), { ignoreEncryption: true })).getPageCount();
  } catch {
    return 0;
  }
}

/** Keep each result as a new box: { id, name, url, pages }. */
async function keepOutputs(outputs) {
  const items = [];
  for (const out of outputs) {
    const kept = await storePdf(out.bytes, path.basename(out.name));
    items.push({ ...kept, pages: await pageCount(path.join(PDF_DIR, `${kept.id}.pdf`)) });
  }
  return items;
}

function sendError(res, err, what) {
  // Messages thrown here and by PDFCraft are for the user; tool crashes (err.code) are not.
  console.error(`Failed while ${what}:`, err?.code || "", String(err?.message || err).slice(0, 200));
  res.status(400).json({ error: err?.message && !err.code ? err.message : `Could not ${what}.` });
}

/**
 * PDFs to edit on the page, in boxes (pdfedit.js). Nothing goes to the notes or a model.
 * POST /pdfedit/upload          raw PDF bytes, name in X-File-Name → { id, name, url, pages }
 * GET  /pdfedit/:id/thumb/:page a PNG of that page
 * POST /pdfedit/:id/run         { tool, pages, angle, text } → { items, note }
 * POST /pdfedit/merge           { ids } → { items }
 * Save and Open use /pdf/:id/save and /pdf/:id/open (pdf.js).
 */
export function registerPdfTools(app) {
  app.post("/pdfedit/upload", express.raw({ type: "*/*", limit: "100mb" }), async (req, res) => {
    let name = "";
    try {
      name = path.basename(decodeURIComponent(String(req.get("x-file-name") || ""))) || "document.pdf";
    } catch {
      return res.status(400).json({ error: "The file name could not be read." });
    }
    const bytes = Buffer.isBuffer(req.body) ? req.body : null;
    if (!bytes || bytes.subarray(0, 1024).indexOf("%PDF-") < 0) return res.status(400).json({ error: `${name} is not a PDF.` });
    try {
      const [item] = await keepOutputs([{ bytes, name: /\.pdf$/i.test(name) ? name : `${name}.pdf` }]);
      rememberPdf(path.join(PDF_DIR, `${item.id}.pdf`));
      res.json(item);
    } catch (err) {
      sendError(res, err, "keep that PDF");
    }
  });

  app.get("/pdfedit/:id/thumb/:page", async (req, res) => {
    const item = await editItem(req.params.id);
    const page = Number(req.params.page);
    if (!item || !Number.isInteger(page) || page < 1 || page > 5000) return res.status(404).end();
    const big = req.query.big === "1";
    const out = path.join(THUMB_DIR, `${item.id}-${page}${big ? "-big" : ""}`);
    try {
      if (!(await stat(`${out}.png`))) {
        await fs.mkdir(THUMB_DIR, { recursive: true });
        await run(PDFTOPPM, ["-f", String(page), "-l", String(page), "-scale-to", big ? "1000" : "360", "-png", "-singlefile", item.file, out], 60_000);
      }
      res.setHeader("Cache-Control", "private, max-age=3600");
      res.sendFile(`${out}.png`);
    } catch {
      res.status(404).end();
    }
  });

  app.post("/pdfedit/merge", async (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.slice(0, 50) : [];
    const items = (await Promise.all(ids.map(editItem))).filter(Boolean);
    try {
      const { outputs } = await runPlan({ tool: "merge" }, items);
      res.json({ items: await keepOutputs(outputs) });
    } catch (err) {
      sendError(res, err, "combine the PDFs");
    }
  });

  app.post("/pdfedit/:id/run", async (req, res) => {
    const item = await editItem(req.params.id);
    if (!item) return res.status(404).json({ error: "That PDF is gone." });
    const body = req.body || {};
    const plan = { ...body, tool: String(body.tool || ""), pages: String(body.pages || "").slice(0, 200) };
    if (plan.tool === "merge") return res.status(400).json({ error: "Use Combine for that." });
    try {
      const { outputs, note } = await runPlan(plan, [item]);
      if (outputs.length > MAX_PARTS) {
        const folder = await saveFolder(outputs, stem(item.name));
        return res.json({ items: [], note: `${outputs.length} files are in a new folder in Downloads: ${path.basename(folder)}.` });
      }
      res.json({ items: await keepOutputs(outputs), note: note || "" });
    } catch (err) {
      sendError(res, err, `run ${plan.tool || "that tool"}`);
    }
  });
}
