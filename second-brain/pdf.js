// PDFs the brain makes. The model writes PDF_BODY on its own line, then an HTML
// page. The server keeps that part off the voice, prints it with headless
// Chrome, and the page shows the PDF with Save and Open buttons.
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PDF_DIR = path.join(__dirname, "pdfs");
const MARKER = "PDF_BODY";
const CHROME = process.env.CHROME_BIN
  || ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"]
    .find((p) => fsSync.existsSync(p))
  || "";

/**
 * Splits a streamed answer at PDF_BODY. feed(text) returns the words that may go
 * to the voice now; everything after the marker is kept as the page body.
 * A half-arrived marker is held back so the voice never says "PDF".
 */
export function pdfCatcher() {
  let seen = false;
  let held = "";
  let body = "";
  return {
    feed(text) {
      if (seen) {
        body += text;
        return "";
      }
      held += text;
      const at = held.indexOf(MARKER);
      if (at >= 0) {
        seen = true;
        body = held.slice(at + MARKER.length);
        const spoken = held.slice(0, at);
        held = "";
        return spoken;
      }
      let keep = 0;
      for (let size = Math.min(MARKER.length - 1, held.length); size > 0; size -= 1) {
        if (MARKER.startsWith(held.slice(-size))) {
          keep = size;
          break;
        }
      }
      const out = held.slice(0, held.length - keep);
      held = held.slice(held.length - keep);
      return out;
    },
    /** Words held back at the end when no marker came. */
    flush() {
      const out = held;
      held = "";
      return out;
    },
    get seen() {
      return seen;
    },
    get body() {
      return seen ? body : "";
    },
  };
}

/** "Discharge summary: Oct 2026" becomes discharge-summary-oct-2026. */
function slug(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9؀-ۿ]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "document";
}

/** The model may wrap the page in a code fence, or send only the inside of body. */
function wholePage(raw) {
  let html = String(raw || "").trim()
    .replace(/^```(?:html)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  if (!/^<!doctype|^<html/i.test(html)) {
    html = [
      "<!DOCTYPE html><html><head><meta charset=\"utf-8\"><style>",
      "@page{size:A4;margin:14mm}body{font:11pt/1.4 -apple-system,Helvetica,Arial,sans-serif;color:#1E2A32;margin:0}",
      "h1{font-size:22pt;margin:0 0 6pt}h2{font-size:13pt;margin:14pt 0 4pt;color:#0F6E74}table{border-collapse:collapse;width:100%}",
      "td,th{border:1px solid #ccc;padding:4pt 6pt;text-align:left}",
      "</style></head><body>",
      html,
      "</body></html>",
    ].join("");
  }
  return html;
}

function runChrome(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(CHROME, args, { stdio: ["ignore", "ignore", "pipe"] });
    const timer = setTimeout(() => child.kill(), timeoutMs);
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`Chrome exited with ${code}: ${stderr.slice(-300)}`));
    });
  });
}

/**
 * Print the HTML to second-brain/pdfs/<id>.pdf with headless Chrome.
 * Resolves with { id, name, path }. name is the file name offered on Save.
 */
export async function renderPdf(raw) {
  if (!CHROME) throw new Error("Google Chrome is not installed, so a PDF cannot be printed.");
  const html = wholePage(raw);
  const title = html.match(/<title>([^<]{1,120})<\/title>/i)?.[1]
    || html.match(/<h1[^>]*>([^<]{1,120})<\/h1>/i)?.[1]
    || "";
  const id = `${new Date().toISOString().slice(0, 10)}-${crypto.randomBytes(4).toString("hex")}`;
  await fs.mkdir(PDF_DIR, { recursive: true });
  const htmlPath = path.join(PDF_DIR, `${id}.html`);
  const pdfPath = path.join(PDF_DIR, `${id}.pdf`);
  await fs.writeFile(htmlPath, html, "utf8");
  // Its own profile folder, so the user's open Chrome does not hold the lock.
  await runChrome([
    "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
    `--user-data-dir=${path.join(PDF_DIR, ".chrome")}`,
    "--no-pdf-header-footer", "--virtual-time-budget=4000",
    `--print-to-pdf=${pdfPath}`, `file://${htmlPath}`,
  ], 90000);
  const name = `${slug(title) || id}.pdf`;
  await fs.writeFile(path.join(PDF_DIR, `${id}.name`), name, "utf8");
  return { id, name, path: pdfPath };
}

const ID = /^[0-9]{4}-[0-9]{2}-[0-9]{2}-[0-9a-f]{8}$/;

async function lookup(id) {
  if (!ID.test(id)) return null;
  const file = path.join(PDF_DIR, `${id}.pdf`);
  try {
    await fs.access(file);
  } catch {
    return null;
  }
  const name = await fs.readFile(path.join(PDF_DIR, `${id}.name`), "utf8").catch(() => "document.pdf");
  return { file, name: name.trim() || "document.pdf" };
}

/** A path in folder for name that does not overwrite anything there. */
async function freePath(folder, name) {
  const base = name.replace(/\.pdf$/i, "");
  for (let n = 0; n < 100; n += 1) {
    const candidate = path.join(folder, n ? `${base} ${n + 1}.pdf` : `${base}.pdf`);
    try {
      await fs.access(candidate);
    } catch {
      return candidate;
    }
  }
  throw new Error("Too many files with that name.");
}

function run(bin, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`${bin} failed`))));
  });
}

/**
 * GET  /pdf/:id        shows the PDF in the page.
 * POST /pdf/:id/save   copies it to Downloads, or to a folder the user picks
 *                      ({ pick: true }), then shows it in the Finder.
 * POST /pdf/:id/open   opens it in Preview.
 */
export function registerPdf(app) {
  app.get("/pdf/:id", async (req, res) => {
    const found = await lookup(req.params.id);
    if (!found) return res.status(404).json({ error: "That PDF is gone." });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${found.name.replace(/[^\w.-]+/g, "_")}"`);
    res.sendFile(found.file);
  });

  app.post("/pdf/:id/save", async (req, res) => {
    const found = await lookup(req.params.id);
    if (!found) return res.status(404).json({ error: "That PDF is gone." });
    let folder = path.join(os.homedir(), "Downloads");
    if (req.body?.pick === true) {
      try {
        folder = (await run("osascript", ["-e", "POSIX path of (choose folder with prompt \"Save the PDF in:\")"])).trim();
      } catch {
        return res.json({ path: "" });
      }
      if (!folder) return res.json({ path: "" });
    }
    try {
      const target = await freePath(folder, found.name);
      await fs.copyFile(found.file, target);
      run("open", ["-R", target]).catch(() => {});
      res.json({ path: target });
    } catch (err) {
      console.error("Failed while saving a PDF:", err?.message || err);
      res.status(500).json({ error: "Could not save the PDF there." });
    }
  });

  app.post("/pdf/:id/open", async (req, res) => {
    const found = await lookup(req.params.id);
    if (!found) return res.status(404).json({ error: "That PDF is gone." });
    try {
      await run("open", [found.file]);
      res.json({ ok: true });
    } catch {
      res.status(500).json({ error: "Could not open the PDF." });
    }
  });
}
