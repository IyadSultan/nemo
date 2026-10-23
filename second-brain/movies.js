/**
 * Movie editor routes.
 *
 * The spoken phrases live in public/movieparse.js. This file finds the video
 * on disk and asks the Rust program moviecut to change the timeline or write
 * the mp4. Projects are saved in ~/.brain/movies. Finished files go to ~/Movies.
 */

import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import express from "express";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FFMPEG_BIN, KOKORO_PYTHON, MULTI_VOICE_MODEL, WHISPER_BIN } from "./config.js";
import { askModelOnce } from "./models.js";
import { getModel } from "./pricing.js";

const require = createRequire(import.meta.url);
const { parseMovieOrder } = require("./public/movieparse.cjs");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(HERE, "moviecut", "target", "release", "moviecut");
// The title card template. hyperframes renders it with the words filled in.
const TITLE_DIR = path.join(HERE, "moviecut", "title");
const ROOT = path.join(os.homedir(), ".brain", "movies");
const VIDEO_EXT = new Set([".mp4", ".mov", ".m4v", ".webm", ".mkv", ".avi"]);
const PHOTO_EXT = new Set([".jpg", ".jpeg", ".png", ".heic", ".heif", ".tif", ".tiff", ".webp"]);
const MUSIC_EXT = new Set([".mp3", ".m4a", ".wav", ".aac", ".aif", ".aiff", ".flac"]);
const SUB_EXT = new Set([".srt"]);
const PLACES = {
  desktop: "Desktop",
  downloads: "Downloads",
  movies: "Movies",
  documents: "Documents",
  pictures: "Pictures",
  music: "Music",
};

function ffmpegBin() {
  return fs.existsSync(FFMPEG_BIN) ? FFMPEG_BIN : "ffmpeg";
}

function ffprobeBin() {
  const nextTo = FFMPEG_BIN.replace(/ffmpeg$/, "ffprobe");
  return fs.existsSync(nextTo) ? nextTo : "ffprobe";
}

/** One JSON order in, one JSON reply out. The Rust program does the edit. */
function runMoviecut(order) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(BIN)) {
      reject(new Error("The movie editor is not built yet. In the project folder run: cargo build --release --manifest-path second-brain/moviecut/Cargo.toml"));
      return;
    }
    const child = execFile(
      BIN,
      ["apply", "--root", ROOT],
      {
        timeout: 15 * 60 * 1000,
        maxBuffer: 2 * 1024 * 1024,
        env: { ...process.env, MOVIE_FFMPEG: ffmpegBin(), MOVIE_FFPROBE: ffprobeBin() },
      },
      (err, stdout, stderr) => {
        const text = String(stdout || "").trim();
        let parsed = null;
        try {
          parsed = text ? JSON.parse(text) : null;
        } catch {
          parsed = null;
        }
        if (parsed?.ok === false) {
          reject(new Error(parsed.error || "The movie could not be changed."));
          return;
        }
        if (err || !parsed?.ok) {
          console.error("Failed while running moviecut:", err?.message || stderr || text);
          reject(new Error(parsed?.error || "The movie could not be changed."));
          return;
        }
        resolve(parsed);
      },
    );
    child.stdin.end(JSON.stringify(order));
  });
}

function underHome(file) {
  const home = os.homedir();
  const real = fs.realpathSync(file);
  return real === home || real.startsWith(home + path.sep);
}

/** Finds one video, or one photo when kind is "photo", whose file name contains every word. */
async function findVideo(query, folder, kind) {
  const exts = kind === "photo" ? PHOTO_EXT
    : kind === "music" ? MUSIC_EXT
    : kind === "subtitles" ? SUB_EXT
    : kind === "any" ? new Set([...VIDEO_EXT, ...PHOTO_EXT]) : VIDEO_EXT;
  const noun = kind === "photo" ? "photo" : kind === "music" ? "song" : kind === "subtitles" ? "subtitle file" : "video";
  const raw = String(query || "").trim();
  if (!raw) throw new Error("Say the name of the video, such as add the video birthday.");
  if (raw.startsWith("/") || raw.startsWith("~") || raw.includes("/")) {
    const expanded = raw.startsWith("~") ? path.join(os.homedir(), raw.slice(1)) : raw;
    let real;
    try {
      real = fs.realpathSync(expanded);
    } catch {
      throw new Error("That video could not be found.");
    }
    if (!underHome(real)) throw new Error("The video has to be inside your home folder, such as Movies or Desktop.");
    if (!exts.has(path.extname(real).toLowerCase())) {
      throw new Error(kind === "music"
        ? "That file is not music. Use mp3, m4a, wav, aac, aiff, or flac."
        : kind === "subtitles"
          ? "That file is not subtitles. Use an srt file."
          : "That file is not a video or a photo. Use mp4, mov, m4v, webm, mkv, avi, jpg, png, or heic.");
    }
    return real;
  }

  const words = raw.toLowerCase().split(/\s+/).filter((word) => word && !["the", "video", "movie", "clip", "file", "photo", "picture", "image", "music", "song", "subtitles", "subtitle", "captions"].includes(word));
  if (!words.length) throw new Error("Say the name of the video, such as add the video birthday.");
  const places = folder ? [PLACES[folder]].filter(Boolean)
    : kind === "music" ? ["Music", "Downloads", "Desktop", "Documents"]
    : kind === "subtitles" ? ["Desktop", "Downloads", "Documents", "Movies"]
    : Object.values(PLACES);
  const hits = [];
  for (const place of places) {
    await walk(path.join(os.homedir(), place), 0, words, hits, exts);
    if (hits.length > 8) break;
  }
  if (!hits.length) {
    const where = folder ? `on the ${folder}` : "in Movies, Desktop, Downloads, Documents, Pictures, or Music";
    throw new Error(`I could not find a ${noun} named ${raw} ${where}.`);
  }
  if (hits.length > 1) {
    const names = hits.slice(0, 5).map((file) => path.basename(file)).join(", ");
    throw new Error(`I found more than one ${noun}: ${names}. Say the name more fully, or say which folder.`);
  }
  return hits[0];
}

async function walk(dir, depth, words, hits, exts) {
  if (depth > 3 || hits.length > 8) return;
  let entries = [];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (hits.length > 8) return;
    if (entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // The Photos library holds copies under made-up names, so it is skipped.
      if (entry.name === "node_modules" || entry.name === "Library" || entry.name.endsWith(".photoslibrary")) continue;
      await walk(full, depth + 1, words, hits, exts);
      continue;
    }
    if (!exts.has(path.extname(entry.name).toLowerCase())) continue;
    const lower = entry.name.toLowerCase();
    if (words.every((word) => lower.includes(word))) hits.push(full);
  }
}

// launchd starts the app with a short PATH. hyperframes is a node script, so it needs node on it.
const TOOL_ENV = { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || "/usr/bin:/bin"}` };
const HYPERFRAMES_BIN = fs.existsSync("/opt/homebrew/bin/hyperframes") ? "/opt/homebrew/bin/hyperframes" : "hyperframes";

function run(bin, args, timeout) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout, maxBuffer: 8 * 1024 * 1024, env: TOOL_ENV }, (err, stdout, stderr) => {
      if (err) reject(new Error(String(stderr || err.message).trim().split("\n").slice(-3).join(" ")));
      else resolve(String(stdout || ""));
    });
  });
}

/**
 * Captions from what is said in the clips. whisper-cli writes one word per
 * segment; words are joined into short lines that sit on the movie clock.
 */
async function speechCaptions() {
  const { project } = await runMoviecut({ op: "status" });
  const clips = project?.clips || [];
  if (!clips.length) throw new Error("Add a video first.");
  if (!clips.some((clip) => clip.hasAudio)) throw new Error("The clips have no sound, so there is nothing to caption.");
  const speed = project.speed || 1;
  const work = await fsp.mkdtemp(path.join(os.tmpdir(), "movie-captions-"));
  const words = [];
  try {
    let cursor = 0;
    for (const [index, clip] of clips.entries()) {
      const t0 = cursor;
      cursor += (clip.end - clip.start) / speed;
      if (!clip.hasAudio) continue;
      const wav = path.join(work, `${index}.wav`);
      await run(ffmpegBin(), ["-y", "-v", "error", "-ss", String(clip.start), "-to", String(clip.end), "-i", clip.path, "-vn", "-ac", "1", "-ar", "16000", wav], 120_000);
      const base = path.join(work, String(index));
      await run(WHISPER_BIN, ["-m", MULTI_VOICE_MODEL, "-l", "auto", "-ml", "1", "-sow", "-oj", "-of", base, "-np", "-f", wav], 10 * 60_000);
      const parsed = JSON.parse(await fsp.readFile(`${base}.json`, "utf8"));
      for (const item of parsed.transcription || []) {
        const text = String(item.text || "").trim();
        // Whisper marks music and noise like [Music]. Those are not words.
        if (!text || /^[[(].*[\])]$/.test(text)) continue;
        const from = t0 + (item.offsets?.from || 0) / 1000 / speed;
        const to = t0 + (item.offsets?.to || 0) / 1000 / speed;
        if (to > from) words.push({ text, from, to: Math.min(to, cursor) });
      }
    }
  } finally {
    fsp.rm(work, { recursive: true, force: true }).catch(() => {});
  }
  // Up to 5 words or 32 letters on a line. A pause or a full stop starts a new line.
  const lines = [];
  let line = null;
  for (const word of words) {
    const gap = line ? word.from - line.to : 0;
    if (line && (gap > 0.6 || line.count >= 5 || (line.text + " " + word.text).length > 32 || (/[.!?]$/.test(line.text) && !/\b(?:st|mr|mrs|ms|dr)\.$/i.test(line.text)))) {
      lines.push(line);
      line = null;
    }
    if (!line) line = { text: word.text, from: word.from, to: word.to, count: 1 };
    else {
      line.text += " " + word.text;
      line.to = word.to;
      line.count += 1;
    }
  }
  if (line) lines.push(line);
  // Each line stays at least half a second, unless the next one starts sooner.
  return lines.map((item, i) => {
    const next = lines[i + 1]?.from ?? Infinity;
    return { text: item.text, from: item.from, to: Math.min(Math.max(item.to, item.from + 0.5), next) };
  });
}

const MUSIC_PY = path.join(HERE, "moviecut", "music.py");
const MUSIC_PROMPT = [
  "You write one-line prompts for a music generator.",
  "From the notes about a home movie, answer with ONE line of at most 20 words describing instrumental background music:",
  "genre, instruments, mood, tempo. No lyrics, no vocals, no title, no quotes, no explanation.",
].join(" ");

/** Words for the music model: the mood asked for, or one the brain reads off the movie. */
async function musicPrompt(project, mood) {
  const theme = [
    `Movie name: ${project.name}`,
    project.clips?.length ? `Clips: ${project.clips.map((clip) => clip.name.replace(/\.[a-z0-9]+$/i, "")).slice(0, 12).join(", ")}` : "",
    project.captions?.length ? `Words heard in it: ${project.captions.map((caption) => caption.text).join(" ").slice(0, 600)}` : "",
    mood ? `The person asked for: ${mood}` : "",
    `Length: ${Math.round(project.seconds)} seconds`,
  ].filter(Boolean).join("\n");
  const model = getModel("claude-sonnet");
  let line = "";
  if (model) {
    try {
      line = (await askModelOnce(model, MUSIC_PROMPT, theme, "", 60, 40000)).split("\n")[0].trim();
    } catch (err) {
      console.error("Could not ask for a music prompt:", err?.message || err);
    }
  }
  line = line.replace(/^["'`]+|["'`.]+$/g, "");
  if (!line || line.length > 200 || /\b(?:sorry|cannot|can't)\b/i.test(line)) {
    line = mood ? `${mood}, instrumental background music` : "warm instrumental background music, gentle, cinematic";
  }
  return line;
}

/** Makes a music bed for the movie and returns the file plus a sentence about it. */
async function makeMusic(project, mood, engine = "auto") {
  const dir = path.join(ROOT, project.slug, "music");
  await fsp.mkdir(dir, { recursive: true });
  const prompt = await musicPrompt(project, mood);
  const file = path.join(dir, `Music ${Date.now()}.wav`);
  const seconds = Math.min(600, Math.max(20, Math.ceil(project.seconds || 0) + 4));
  let out;
  try {
    // launchd's PATH finds Apple's python3, which has no torch. Kokoro's Python has the music libraries.
    out = await run(fs.existsSync(KOKORO_PYTHON) ? KOKORO_PYTHON : "python3", ["-I", MUSIC_PY, "--output", file, "--seconds", String(seconds), "--prompt", prompt, "--engine", engine], 20 * 60_000);
  } catch (err) {
    console.error("Failed while making music:", err.message);
    throw new Error(engine === "online"
      ? "The online music service did not answer. Say make music offline to use this Mac."
      : "The music could not be made. Check that python3 has torch, transformers, and soundfile.");
  }
  const line = String(out).trim().split("\n").pop();
  let parsed = null;
  try {
    parsed = JSON.parse(line);
  } catch {
    parsed = null;
  }
  if (!parsed?.ok || !fs.existsSync(file)) throw new Error(parsed?.error || "The music could not be made.");
  const where = parsed.engine === "online" ? "online with Lyria" : "on this Mac with MusicGen, as a loop";
  return { file, said: `Wrote ${Math.round(parsed.seconds)} seconds of music ${where}: ${prompt}.` };
}

/** Renders the title card with hyperframes into the movie's own folder. */
async function renderTitle(slug, title, subtitle) {
  if (!/^[a-z0-9-]+$/.test(slug || "")) throw new Error("The movie name could not be read.");
  const dir = path.join(ROOT, slug, "titles");
  await fsp.mkdir(dir, { recursive: true });
  // The clip list shows the file name, so the file is named after the words.
  const words = String(title).replace(/[^\p{L}\p{N} ,'-]/gu, "").trim().slice(0, 40) || "Title";
  let out = path.join(dir, `Title ${words}.mp4`);
  for (let n = 2; fs.existsSync(out); n += 1) out = path.join(dir, `Title ${words} ${n}.mp4`);
  const variables = JSON.stringify({ title: String(title).slice(0, 60), subtitle: String(subtitle || "").slice(0, 80) });
  try {
    await run(HYPERFRAMES_BIN, ["render", TITLE_DIR, "--quality", "looks", "--quiet", "--output", out, "--variables", variables], 5 * 60_000);
  } catch (err) {
    console.error("Failed while rendering the title card:", err.message);
    throw new Error("The title card could not be made. Check that hyperframes is installed.");
  }
  if (!fs.existsSync(out)) throw new Error("The title card could not be made.");
  return out;
}

/** Turns an srt file into caption times. The Rust editor replaces the captions with these. */
function parseSrt(text) {
  const items = [];
  for (const block of String(text || "").replace(/^\uFEFF/, "").split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const time = lines.find((line) => line.includes("-->"));
    if (!time) continue;
    const match = time.match(/(\d+):(\d+):(\d+)[,.](\d+)\s*-->\s*(\d+):(\d+):(\d+)[,.](\d+)/);
    if (!match) continue;
    const stamp = (h, m, s, ms) => Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(ms) / 1000;
    const words = lines.slice(lines.indexOf(time) + 1).join(" ").replace(/<[^>]+>/g, "").trim();
    if (!words) continue;
    items.push({ text: words, from: stamp(match[1], match[2], match[3], match[4]), to: stamp(match[5], match[6], match[7], match[8]) });
  }
  if (!items.length) throw new Error("That subtitle file has no lines.");
  return items;
}

/** The Mac file chooser. Videos and photos can be picked several at a time. Returns paths, or [] when cancelled. */
function chooseVideo(kind) {
  const script = kind === "music"
    ? 'POSIX path of (choose file with prompt "Choose a song" default location (path to music folder))'
    : kind === "subtitles"
      ? 'POSIX path of (choose file with prompt "Choose an srt subtitle file" default location (path to documents folder))'
      : [
        'set picked to choose file with prompt "Choose videos or photos" default location (path to movies folder) with multiple selections allowed',
        'set out to ""',
        "repeat with f in picked",
        "  set out to out & POSIX path of f & linefeed",
        "end repeat",
        "return out",
      ].join("\n");
  return new Promise((resolve, reject) => {
    execFile("/usr/bin/osascript", ["-e", script], { timeout: 300_000 }, (err, stdout, stderr) => {
      if (err) {
        if (/-128|User cancel/i.test(`${err.message} ${stderr || ""}`)) resolve([]);
        else reject(err);
        return;
      }
      resolve(String(stdout || "").split("\n").map((line) => line.trim()).filter(Boolean));
    });
  });
}

async function currentSummary() {
  try {
    return await runMoviecut({ op: "status" });
  } catch (err) {
    return { ok: true, said: err.message, project: null };
  }
}

async function clipFile(id, wantMusic) {
  const status = await runMoviecut({ op: "status" });
  const project = status.project;
  if (!project) return "";
  if (wantMusic) {
    const file = project.musicPath || "";
    return file && fs.existsSync(file) && underHome(file) ? file : "";
  }
  if (!/^c\d+$/.test(id || "")) return "";
  const clip = (project.clips || []).find((item) => item.id === id);
  if (!clip?.path || !fs.existsSync(clip.path) || !underHome(clip.path)) return "";
  return clip.path;
}

function sendFile(req, res, file) {
  const stat = fs.statSync(file);
  const type = {
    ".mp4": "video/mp4",
    ".mov": "video/quicktime",
    ".m4v": "video/x-m4v",
    ".webm": "video/webm",
    ".mkv": "video/x-matroska",
    ".avi": "video/x-msvideo",
    ".jpg": "image/jpeg",
    ".mp3": "audio/mpeg",
    ".m4a": "audio/mp4",
    ".aac": "audio/aac",
    ".wav": "audio/wav",
    ".flac": "audio/flac",
    ".aif": "audio/aiff",
    ".aiff": "audio/aiff",
  }[path.extname(file).toLowerCase()] || "application/octet-stream";
  res.setHeader("Content-Type", type);
  res.setHeader("Accept-Ranges", "bytes");
  const range = String(req.headers.range || "");
  const match = /bytes=(\d+)-(\d*)/.exec(range);
  if (!match) {
    res.setHeader("Content-Length", stat.size);
    fs.createReadStream(file).pipe(res);
    return;
  }
  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) : stat.size - 1;
  if (!Number.isFinite(start) || start >= stat.size || end < start) {
    res.status(416).end();
    return;
  }
  res.status(206);
  res.setHeader("Content-Range", `bytes ${start}-${end}/${stat.size}`);
  res.setHeader("Content-Length", end - start + 1);
  fs.createReadStream(file, { start, end }).pipe(res);
}

export function registerMovies(app) {
  // The phrase list is CommonJS so the server and the tests can load it.
  // The page asks for it as ordinary JavaScript.
  app.get("/movieparse.js", (_req, res) => {
    res.type("application/javascript");
    res.sendFile(path.join(HERE, "public", "movieparse.cjs"));
  });

  app.get("/movie/installed", (_req, res) => {
    res.json({
      installed: fs.existsSync(BIN),
      ffmpeg: fs.existsSync(FFMPEG_BIN),
    });
  });

  app.get("/movie/status", async (_req, res) => {
    try {
      const reply = await currentSummary();
      res.json(reply);
    } catch (err) {
      console.error("Failed while reading the movie:", err?.message || err);
      res.status(500).json({ error: "The movie could not be read." });
    }
  });

  /** The Ask box and the microphone send the sentence here. */
  app.post("/movie/hear", express.json(), async (req, res) => {
    try {
      const order = parseMovieOrder(req.body?.text, Boolean(req.body?.open));
      if (!order) return res.json({ handled: false });
      if (order.op === "error") return res.status(400).json({ error: order.error });
      if (order.op === "open" || order.op === "close" || order.op === "orders") {
        return res.json({ handled: true, said: "" });
      }
      // The preview does these. They are not cuts, so they never reach the editor.
      if (order.op === "step" || order.op === "go_bookmark" || order.op === "bookmark_here") {
        return res.json({ handled: true, local: order });
      }
      let payload = order;
      if (order.op === "add") {
        if (order.picked) return res.status(400).json({ error: "Press Add video, or say add the video and the file name." });
        payload = { op: "add", file: await findVideo(order.query, order.folder, order.kind) };
      }
      if (order.op === "music") payload = { op: "music", file: await findVideo(order.query, undefined, "music") };
      if (order.op === "make_music") {
        const status = await runMoviecut({ op: "status" });
        if (!status.project) throw new Error("Start a movie first. Say new movie called, then a name.");
        if (!status.project.clips?.length) throw new Error("Add a video or a photo first, so the music can fit the movie.");
        const made = await makeMusic(status.project, order.mood, order.engine);
        const reply = await runMoviecut({ op: "music", file: made.file });
        return res.json({ handled: true, said: `${made.said} ${reply.said}`, project: reply.project });
      }
      if (order.op === "subtitles") payload = { op: "captions", items: parseSrt(await fsp.readFile(await findVideo(order.query, undefined, "subtitles"), "utf8")) };
      if (order.op === "auto_captions") payload = { op: "captions", items: await speechCaptions() };
      if (order.op === "title") {
        const status = await runMoviecut({ op: "status" });
        if (!status.project) throw new Error("Start a movie first. Say new movie called, then a name.");
        payload = { op: "add", first: order.first, file: await renderTitle(status.project.slug, order.title, order.subtitle) };
      }
      const reply = await runMoviecut(payload);
      if (order.op === "export" && reply.project?.exportPath) {
        execFile("/usr/bin/open", ["-R", reply.project.exportPath], () => {});
      }
      res.json({ handled: true, said: reply.said, project: reply.project });
    } catch (err) {
      console.error("Failed while changing the movie:", err?.message || err);
      res.status(400).json({ error: err.message || "The movie could not be changed." });
    }
  });

  /** The Add video button. macOS asks which file, then the Rust editor adds it. */
  app.post("/movie/pick", async (req, res) => {
    try {
      const kind = ["music", "subtitles"].includes(req.query.kind) ? req.query.kind : "any";
      const picked = await chooseVideo(kind);
      if (!picked.length) return res.json({ cancelled: true });
      if (kind !== "any") {
        const file = await findVideo(picked[0], undefined, kind);
        const order = kind === "music" ? { op: "music", file } : { op: "captions", items: parseSrt(await fsp.readFile(file, "utf8")) };
        const reply = await runMoviecut(order);
        return res.json({ handled: true, said: reply.said, project: reply.project });
      }
      // Several files go on the timeline in the order they were picked.
      let reply = null;
      const skipped = [];
      for (const one of picked) {
        try {
          reply = await runMoviecut({ op: "add", file: await findVideo(one, undefined, "any") });
        } catch (err) {
          skipped.push(`${path.basename(one)}: ${err.message}`);
        }
      }
      if (!reply) throw new Error(skipped[0] || "Those files could not be added.");
      const said = picked.length === 1 ? reply.said : `Added ${picked.length - skipped.length} files.${skipped.length ? ` Skipped ${skipped.join("; ")}` : ""}`;
      res.json({ handled: true, said, project: reply.project });
    } catch (err) {
      if (/-128|User cancel/i.test(err?.message || "")) return res.json({ cancelled: true });
      console.error("Failed while adding a video:", err?.message || err);
      res.status(400).json({ error: err.message || "That video could not be added." });
    }
  });

  app.get("/movie/media", async (req, res) => {
    try {
      const file = await clipFile(String(req.query.clip || ""), req.query.music === "1");
      if (!file) return res.status(404).end();
      sendFile(req, res, file);
    } catch (err) {
      console.error("Failed while playing the movie:", err?.message || err);
      res.status(404).end();
    }
  });
}
