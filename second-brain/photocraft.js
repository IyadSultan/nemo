// Photo edits with PhotoCraft (github.com/storytold/photocraft, MIT OR Apache-2.0).
// The full editor is the web build, served at /photocraft.
// One-step changes run photocraft-cli, the same engine, installed by voice/install-photocraft.sh.
// File names and picture bytes are never logged (they may name patients).
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { freeName } from "./wordcraft.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "vendor", "photocraft");
const WEB_DIR = path.join(ROOT, "web");
const CLI = path.join(ROOT, "bin", "photocraft-cli");
const SAVE_DIR = path.join(os.homedir(), "Pictures");

// Commands the page may run, and the numbers each one accepts.
// A command with no fields runs with no extra settings.
// image.imageRotation turns the whole picture. edit.transform only turns a layer
// inside the same frame, so a photo would not look rotated.
const EDITS = {
  "image.imageRotation.90cw": {},
  "image.imageRotation.90ccw": {},
  "image.imageRotation.180": {},
  "image.imageRotation.flipCanvasHorizontal": {},
  "image.imageRotation.flipCanvasVertical": {},
  "image.adjustments.desaturate": {},
  "image.autoTone": {},
  "image.autoContrast": {},
  "image.autoColor": {},
  "filter.sharpen.sharpen": {},
  "image.adjustments.brightnessContrast": { brightness: [-150, 150], contrast: [-50, 100] },
  "image.adjustments.vibrance": { vibrance: [-100, 100], saturation: [-100, 100] },
};

const MAGIC = {
  jpeg: (b) => b[0] === 0xff && b[1] === 0xd8,
  png: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  webp: (b) => b.length > 12 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP",
  gif: (b) => b.toString("ascii", 0, 6) === "GIF87a" || b.toString("ascii", 0, 6) === "GIF89a",
};

function installed(file) {
  return fs.stat(file).then((info) => info.isFile()).catch(() => false);
}

/** The picture from a data URL the page sent. Null when it is not a picture we accept. */
export function pictureBytes(dataUrl) {
  const match = String(dataUrl || "").match(/^data:image\/(jpeg|jpg|png|webp|gif);base64,([A-Za-z0-9+/=\s]+)$/);
  if (!match) return null;
  const ext = match[1] === "jpg" ? "jpeg" : match[1];
  const bytes = Buffer.from(match[2].replace(/\s/g, ""), "base64");
  if (bytes.length < 32 || bytes.length > 11_000_000) return null; // server.js reads at most 15 MB of JSON
  if (!MAGIC[ext]?.(bytes)) return null;
  return { ext: ext === "jpeg" ? "jpg" : ext, bytes };
}

/** Only known edits, with numbers inside the ranges PhotoCraft allows. */
export function cleanSteps(raw) {
  if (!Array.isArray(raw) || !raw.length || raw.length > 8) return null;
  const steps = [];
  for (const step of raw) {
    const id = step?.id;
    const fields = EDITS[id];
    if (!fields) return null;
    const params = {};
    const given = step.params && typeof step.params === "object" ? step.params : {};
    for (const [key, range] of Object.entries(fields)) {
      if (given[key] == null || given[key] === "") continue;
      const value = Number(given[key]);
      if (!Number.isFinite(value)) return null;
      params[key] = Math.min(range[1], Math.max(range[0], value));
    }
    steps.push({ id, params });
  }
  return steps;
}

function runCli(args) {
  return new Promise((resolve, reject) => {
    execFile(CLI, args, { timeout: 120_000, maxBuffer: 4_000_000 }, (err, stdout, stderr) => {
      if (!err) return resolve(String(stdout || ""));
      const line = String(stderr || err.message || "").split("\n").map((s) => s.trim()).find(Boolean) || "";
      const clean = line.replace(/\/Users\/\S+/g, "a file").replace(/^error:\s*/i, "").slice(0, 180);
      const error = new Error(clean ? `PhotoCraft could not change that picture. ${clean}` : "PhotoCraft could not change that picture.");
      error.code = err.code;
      reject(error);
    });
  });
}

/**
 * Run PhotoCraft edits on picture bytes. Returns a JPEG.
 * `steps` is [{ id, params }], already checked by cleanSteps.
 */
export async function applyPhotoEdits(bytes, ext, steps) {
  if (!(await installed(CLI))) throw new Error("The photo tools are not installed. Run voice/install-photocraft.sh.");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "photocraft-"));
  const input = path.join(dir, `in.${ext}`);
  const output = path.join(dir, "out.jpg");
  try {
    await fs.writeFile(input, bytes);
    const args = ["run", input];
    for (const step of steps) {
      args.push("--cmd", step.id);
      if (Object.keys(step.params).length) args.push("--params", JSON.stringify(step.params));
    }
    args.push("--out", output, "--format", "jpg", "--quality", "88");
    await runCli(args);
    const jpeg = await fs.readFile(output);
    if (!MAGIC.jpeg(jpeg)) throw new Error("PhotoCraft did not return a picture.");
    return jpeg;
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** A plain file name for Pictures: no folders, no leading dot, always .jpg. */
export function saveName(header) {
  let raw = "";
  try {
    raw = decodeURIComponent(String(header || ""));
  } catch {
    // A broken name falls back to Photo.jpg.
  }
  const stem = path.basename(raw.replace(/\\/g, "/"))
    .replace(/[\u0000-\u001f:]/g, "")
    .replace(/^\.+/, "")
    .replace(/\.[^.]*$/, "")
    .trim()
    .slice(0, 120);
  return `${stem || "Photo"}.jpg`;
}

export function registerPhotocraft(app) {
  app.use("/photocraft", express.static(WEB_DIR, {
    dotfiles: "deny",
    setHeaders(res, filePath) {
      if (filePath.endsWith(".wasm")) res.setHeader("Content-Type", "application/wasm");
      if (filePath.endsWith(".wasm") || /photocraft-web-.*\.js$/.test(filePath)) {
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      } else {
        res.setHeader("Cache-Control", "no-cache");
      }
    },
  }));

  app.get("/photoedit/installed", async (_req, res) => {
    res.json({
      editor: await installed(path.join(WEB_DIR, "index.html")),
      tools: await installed(CLI),
    });
  });

  /** One or more PhotoCraft edits. Body: { image: data URL, steps: [{ id, params }] }. */
  app.post("/photoedit/run", async (req, res) => {
    const picture = pictureBytes(req.body?.image);
    const steps = cleanSteps(req.body?.steps);
    if (!picture || !steps) return res.status(400).json({ error: "That picture cannot be edited." });
    try {
      const jpeg = await applyPhotoEdits(picture.bytes, picture.ext, steps);
      console.log(`Photo edit (${steps.map((step) => step.id).join(", ")}, ${jpeg.length} bytes)`);
      res.json({ image: `data:image/jpeg;base64,${jpeg.toString("base64")}` });
    } catch (err) {
      console.error("Failed while editing a photo:", err?.code || "");
      res.status(400).json({ error: err.message || "PhotoCraft could not change that picture." });
    }
  });

  /** Save JPEG bytes in Pictures, under a new name when that name is taken. */
  app.post("/photoedit/save", express.raw({ type: "*/*", limit: "20mb" }), async (req, res) => {
    const bytes = Buffer.isBuffer(req.body) ? req.body : null;
    if (!bytes?.length || !MAGIC.jpeg(bytes)) return res.status(400).json({ error: "Nothing to save." });
    try {
      await fs.mkdir(SAVE_DIR, { recursive: true });
      const file = await freeName(SAVE_DIR, saveName(req.get("x-file-name")));
      await fs.writeFile(file, bytes, { flag: "wx" });
      console.log(`Saved a photo (${bytes.length} bytes)`);
      res.json({ name: path.basename(file) });
    } catch (err) {
      console.error("Failed while saving a photo:", err?.code || "");
      res.status(400).json({ error: "Could not save it." });
    }
  });
}
