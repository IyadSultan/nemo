/**
 * Screen recorder.
 *
 * Press Record (or say "record the screen"). A small Mac program writes a
 * video of the whole screen, the sound from other apps such as Zoom, and the
 * microphone. While it records, the words show at the bottom of the screen as they are
 * said, and a recap (with questions to ask) can be made at any moment. When it
 * stops, the captions and the summary are written on their own.
 *
 * Videos stay on this Mac in second-brain/recordings/. They are not in git.
 */

import { DEFAULT_MODEL, FFMPEG_BIN, MULTI_VOICE_MODEL, WHISPER_BIN, __dirname } from "./config.js";
import { askModelOnce } from "./models.js";
import { getModel } from "./pricing.js";
import { sendControl } from "./control.js";
import {
  captionsToVtt,
  clipTranscript,
  groupCaptionLines,
  recordingId,
  safeRecordingId,
  screenRecapPrompt,
  screenSummaryPrompt,
  summaryMarkdown,
  transcriptFromCaptions,
  wordsFromWhisper,
} from "./screenlogic.js";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const ROOT = path.join(__dirname, "recordings");
const SOURCE = path.join(__dirname, "screenrec.swift");
const BOUNCE = path.join(__dirname, "screenbounce.m");
const BINARY = path.join(__dirname, "bin", "screenrec");
const FFPROBE_BIN = path.join(path.dirname(FFMPEG_BIN), "ffprobe");

// The one recording that is running, if any.
let active = null;
// Captions, summary, or recap already running for a saved recording.
const jobs = new Set();
// The order the jobs run in: the summary and the recap need the captions.
const JOBS = ["captions", "summary", "recap"];

function claim(id, job) {
  const key = `${id}:${job}`;
  if (jobs.has(key)) {
    const err = new Error("That is already running. Wait for it to finish.");
    err.status = 409;
    throw err;
  }
  jobs.add(key);
  return () => jobs.delete(key);
}

/** Build the Mac recorder when the source is newer than the program. */
async function ensureRecorder() {
  const sourceTime = Math.max(fsSync.statSync(SOURCE).mtimeMs, fsSync.statSync(BOUNCE).mtimeMs);
  let binaryTime = 0;
  try {
    binaryTime = fsSync.statSync(BINARY).mtimeMs;
  } catch {
    // Not built yet. The first Record press compiles it. That takes about a minute.
  }
  if (binaryTime >= sourceTime) return;
  await fs.mkdir(path.dirname(BINARY), { recursive: true });
  const object = path.join(path.dirname(BINARY), "screenbounce.o");
  try {
    // The .m file fixes a macOS crash. The Swift file does the recording.
    await execFileAsync("clang", ["-c", "-O2", "-fobjc-arc", "-o", object, BOUNCE], { timeout: 60000 });
    await execFileAsync("swiftc", ["-swift-version", "5", "-O", "-o", BINARY, SOURCE, object, "-framework", "AppKit"], { timeout: 180000 });
  } catch (err) {
    console.error("Failed while building the screen recorder:", err?.message || err);
    throw new Error("The screen recorder could not be built. Install the Xcode command line tools, then try again.");
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Ask the recorder to finish, and wait until the video file is closed. */
async function stopRecorder(dir) {
  const pidText = await fs.readFile(path.join(dir, "capture.pid"), "utf8").catch(() => "");
  const pid = Number(pidText.trim());
  if (!pid) return;
  try {
    process.kill(pid, "SIGINT");
  } catch {
    // The recorder already quit.
  }
  // The recorder waits for macOS to close the file, up to 30 s on a long recording.
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline && pidAlive(pid)) await sleep(200);
  if (pidAlive(pid)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

/** Run one program and return its text. Throws a short error if it fails. */
function run(bin, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args);
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${path.basename(bin)} took too long.`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error((stderr || stdout || `${path.basename(bin)} failed`).trim().slice(0, 400)));
    });
  });
}

async function writeMeta(dir, meta) {
  const file = path.join(dir, "meta.json");
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(meta, null, 2));
  await fs.rename(tmp, file);
}

async function readMeta(id) {
  const safe = safeRecordingId(id);
  if (!safe) return null;
  try {
    const meta = JSON.parse(await fs.readFile(path.join(ROOT, safe, "meta.json"), "utf8"));
    if (meta.id !== safe) return null;
    return meta;
  } catch {
    return null;
  }
}

function card(meta) {
  return {
    id: meta.id,
    title: meta.title,
    startedAt: meta.startedAt,
    endedAt: meta.endedAt || "",
    status: meta.status,
    seconds: meta.seconds || 0,
    hasCaptions: Boolean(meta.captions?.length),
    hasSummary: Boolean(meta.summary),
    hasRecap: Boolean(meta.recap),
    plan: { ...meta.plan },
    working: meta.working || "",
    warning: meta.warning || "",
    error: meta.error || "",
  };
}

function detail(meta) {
  return {
    ...card(meta),
    summary: meta.summary || "",
    recap: meta.recap || "",
    captions: meta.captions || [],
    live: meta.live || [],
  };
}

function videoPath(meta) {
  const name = meta.file === "video.mp4" ? "video.mp4" : "capture.mp4";
  return path.join(ROOT, meta.id, name);
}

async function audioTrackCount(file) {
  const out = await run(FFPROBE_BIN, ["-v", "error", "-select_streams", "a", "-show_entries", "stream=index", "-of", "csv=p=0", file], 30000);
  return out.split("\n").map((line) => line.trim()).filter(Boolean).length;
}

async function durationSeconds(file) {
  const out = await run(FFPROBE_BIN, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file], 30000);
  const n = Number(String(out).trim());
  return Number.isFinite(n) ? Math.round(n) : 0;
}

/** Two sound tracks (Zoom and the microphone) become one, so the player plays both. */
async function mixAudio(source, target) {
  const filter = "[0:a:0][0:a:1]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0[a]";
  const base = ["-y", "-i", source, "-filter_complex", filter, "-map", "0:v:0", "-map", "[a]", "-c:v", "copy", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", target];
  try {
    await run(FFMPEG_BIN, base, 20 * 60 * 1000);
  } catch (err) {
    console.error("Failed while mixing the two sound tracks, trying a simpler mix:", err?.message || err);
    const simpler = base.slice();
    simpler[4] = "[0:a:0][0:a:1]amix=inputs=2:duration=longest:dropout_transition=0[a]";
    await run(FFMPEG_BIN, simpler, 20 * 60 * 1000);
  }
}

async function listCards() {
  let names = [];
  try {
    names = await fs.readdir(ROOT);
  } catch {
    return [];
  }
  const cards = [];
  for (const name of names) {
    const meta = await readMeta(name);
    if (meta) cards.push(card(meta));
  }
  cards.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
  return cards;
}

function sendError(res, err, step, status = 400) {
  console.error(`Failed while ${step}:`, err?.message || err);
  const code = err?.status || status;
  res.status(code).json({ error: String(err?.message || "The screen recorder could not finish.").slice(0, 300) });
}

function requireFfmpeg() {
  if (!fsSync.existsSync(FFMPEG_BIN) || !fsSync.existsSync(FFPROBE_BIN)) {
    throw new Error("ffmpeg is not installed, so the recording cannot be finished.");
  }
}

/** Listen to the saved video and write caption lines into meta. */
async function makeCaptions(meta) {
  if (meta.status !== "ready") {
    const err = new Error("Stop the recording before adding captions.");
    err.status = 409;
    throw err;
  }
  if (/no sound/i.test(meta.warning || "")) throw new Error("This recording has no sound, so there is nothing to caption.");
  if (!fsSync.existsSync(WHISPER_BIN) || !fsSync.existsSync(MULTI_VOICE_MODEL)) {
    throw new Error("The caption model is not installed on this Mac.");
  }
  const release = claim(meta.id, "captions");
  const dir = path.join(ROOT, meta.id);
  const wav = path.join(dir, "audio.wav");
  const base = path.join(dir, "whisper");
  try {
    await run(FFMPEG_BIN, ["-y", "-i", videoPath(meta), "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wav], 20 * 60 * 1000);
    await run(WHISPER_BIN, ["-m", MULTI_VOICE_MODEL, "-l", "auto", "-ml", "1", "-sow", "-oj", "-of", base, "-np", "-f", wav], 40 * 60 * 1000);
    const parsed = JSON.parse(await fs.readFile(`${base}.json`, "utf8"));
    meta.captions = groupCaptionLines(wordsFromWhisper(parsed));
    if (!meta.captions.length) throw new Error("No words were heard, so there are no captions.");
    await writeMeta(dir, meta);
  } finally {
    release();
    fs.rm(wav, { force: true }).catch(() => {});
    fs.rm(`${base}.json`, { force: true }).catch(() => {});
  }
}

/** Ask the model for the summary or the recap and keep it in meta. */
// Live captions. The recorder hears the sound with Apple's on-device listener and
// prints each result as a JSON line in recorder.out; a line is sent to the page as it
// changes, and kept once it is final.
function watchLines(rec, fromByte = 0) {
  const file = path.join(rec.dir, "recorder.out");
  rec.lines = { at: fromByte, rest: "", busy: false, timer: 0 };
  rec.meta.live = rec.meta.live || [];
  const tick = async () => {
    if (rec.lines.busy) return;
    rec.lines.busy = true;
    try {
      const size = (await fs.stat(file).catch(() => null))?.size || 0;
      if (size <= rec.lines.at) return;
      const handle = await fs.open(file, "r");
      const buffer = Buffer.alloc(size - rec.lines.at);
      try {
        await handle.read(buffer, 0, buffer.length, rec.lines.at);
      } finally {
        await handle.close();
      }
      rec.lines.at = size;
      const parts = (rec.lines.rest + buffer.toString("utf8")).split("\n");
      rec.lines.rest = parts.pop();
      for (const part of parts) {
        if (!part.startsWith("{")) continue;
        let event;
        try {
          event = JSON.parse(part);
        } catch {
          continue;
        }
        if (event.note) {
          sendControl("screen", { type: "note", id: rec.id, text: event.note });
          continue;
        }
        if (!event.text) continue;
        const line = { from: event.from || 0, to: event.to || 0, text: event.text };
        if (event.final) rec.meta.live.push(line);
        sendControl("screen", { type: "line", id: rec.id, partial: !event.final, ...line });
      }
    } catch (err) {
      console.error("Failed while reading the live captions:", err?.message || err);
    } finally {
      rec.lines.busy = false;
    }
  };
  rec.lines.timer = setInterval(tick, 150);
  rec.lines.tick = tick;
}

/** Read the last lines after the recorder has quit, then stop watching. */
async function stopLines(rec) {
  if (!rec.lines) return;
  clearInterval(rec.lines.timer);
  for (let i = 0; i < 20 && rec.lines.busy; i += 1) await sleep(100);
  await rec.lines.tick();
}

/** A recap of what was said so far, while it still records. Shown on the page; the user can ask it again any time. */
async function makeLiveRecap(rec, modelName) {
  if (!rec.meta.live?.length) throw new Error("Nothing has been said yet.");
  const model = getModel(modelName) || getModel(DEFAULT_MODEL);
  if (!model) throw new Error("That model is not available.");
  const release = claim(rec.id, "recap");
  try {
    const transcript = clipTranscript(transcriptFromCaptions(rec.meta.live));
    const text = await askModelOnce(model, screenRecapPrompt(), transcript, process.env.OPENAI_API_KEY || "", 1400, 180000);
    if (!text) throw new Error("The recap came back empty. Try again, or pick another model.");
    rec.meta.recap = text;
    await writeMeta(rec.dir, rec.meta);
    sendControl("screen", { type: "recap", id: rec.id, text });
    return text;
  } finally {
    release();
  }
}

/** summary.md and captions.vtt next to the video, so the folder reads on its own. */
async function writeFiles(meta) {
  const dir = path.join(ROOT, meta.id);
  if (meta.captions?.length) await fs.writeFile(path.join(dir, "captions.vtt"), captionsToVtt(meta.captions));
  if (meta.captions?.length || meta.summary || meta.recap) await fs.writeFile(path.join(dir, "summary.md"), summaryMarkdown(meta));
}

async function makeWriteUp(meta, field, modelName) {
  if (!meta.captions?.length) throw new Error("Add captions first, so there is something to summarize.");
  const model = getModel(modelName) || getModel(DEFAULT_MODEL);
  if (!model) throw new Error("That model is not available.");
  const release = claim(meta.id, field);
  try {
    const prompt = field === "summary" ? screenSummaryPrompt() : screenRecapPrompt();
    const transcript = clipTranscript(transcriptFromCaptions(meta.captions));
    const text = await askModelOnce(model, prompt, transcript, process.env.OPENAI_API_KEY || "", 1400, 180000);
    if (!text) throw new Error("The write-up came back empty. Try again, or pick another model.");
    meta[field] = text;
    await writeMeta(path.join(ROOT, meta.id), meta);
  } finally {
    release();
  }
}

/** After Stop: run the jobs that were ticked during the recording, in order. */
async function finishPlanned(meta, modelName) {
  const dir = path.join(ROOT, meta.id);
  for (const job of JOBS) {
    if (!meta.plan?.[job]) continue;
    meta.working = job;
    await writeMeta(dir, meta);
    try {
      if (job === "captions") await makeCaptions(meta);
      else await makeWriteUp(meta, job, modelName);
    } catch (err) {
      console.error(`Failed while writing the ${job} after the recording:`, err?.message || err);
      meta.warning = [meta.warning, `The ${job} could not be written: ${String(err?.message || err).slice(0, 200)}`].filter(Boolean).join(" ");
      if (job === "captions") break;
    } finally {
      meta.plan[job] = false;
    }
  }
  meta.working = "";
  await writeMeta(dir, meta);
  await writeFiles(meta).catch((err) => console.error("Failed while writing the recording's files:", err?.message || err));
  sendControl("screen", { type: "ready", id: meta.id });
}

/**
 * After the server restarts: a recording that was running is picked up again if its
 * recorder is still alive; otherwise it is closed as it stands.
 */
async function adoptRunning() {
  const names = await fs.readdir(ROOT).catch(() => []);
  for (const name of names) {
    const meta = await readMeta(name);
    if (meta?.status !== "recording" && meta?.status !== "saving") continue;
    const dir = path.join(ROOT, meta.id);
    const pid = Number((await fs.readFile(path.join(dir, "capture.pid"), "utf8").catch(() => "")).trim());
    if (meta.status === "recording" && pid && pidAlive(pid) && !active) {
      active = { id: meta.id, dir, meta, stopping: false };
      // Only the words from now on; what was said before the restart is gone.
      watchLines(active, (await fs.stat(path.join(dir, "recorder.out")).catch(() => null))?.size || 0);
      console.log(`Picked up the screen recording ${meta.id} again.`);
      continue;
    }
    const seconds = await durationSeconds(videoPath(meta)).catch(() => 0);
    if (seconds > 0) {
      meta.status = "ready";
      meta.seconds = seconds;
      meta.endedAt = meta.endedAt || new Date().toISOString();
      meta.warning = "The server restarted while this recorded, so it ended on its own. Captions and a summary were not written.";
    } else {
      meta.status = "failed";
      meta.error = "The server restarted while this recorded, and the video was not saved.";
    }
    await writeMeta(dir, meta);
  }
}

export function registerScreen(app) {
  adoptRunning().catch((err) => console.error("Failed while picking up screen recordings:", err?.message || err));
  // The phrase list is CommonJS so the page and the tests can load it.
  app.get("/screenparse.js", (_req, res) => {
    res.type("application/javascript");
    res.sendFile(path.join(__dirname, "public", "screenparse.cjs"));
  });

  app.get("/screen/list", async (_req, res) => {
    try {
      res.json({ recordings: await listCards() });
    } catch (err) {
      sendError(res, err, "listing screen recordings", 500);
    }
  });

  app.get("/screen/active", (_req, res) => {
    res.json({ recording: active ? card(active.meta) : null });
  });

  app.get("/screen/:id/video", async (req, res) => {
    try {
      const meta = await readMeta(req.params.id);
      if (!meta || meta.status === "recording") return res.status(404).json({ error: "That recording is not ready." });
      const file = videoPath(meta);
      if (!fsSync.existsSync(file)) return res.status(404).json({ error: "The video file is missing." });
      res.sendFile(file);
    } catch (err) {
      sendError(res, err, "sending the recording", 500);
    }
  });

  app.get("/screen/:id/captions.vtt", async (req, res) => {
    try {
      const meta = await readMeta(req.params.id);
      if (!meta?.captions?.length) return res.status(404).type("text/plain").send("No captions yet.");
      res.type("text/vtt").send(captionsToVtt(meta.captions));
    } catch (err) {
      sendError(res, err, "sending the captions", 500);
    }
  });

  // The window starts the recorder. This says whether that has happened yet.
  app.get("/screen/:id/boot", async (req, res) => {
    try {
      const id = safeRecordingId(req.params.id);
      if (!active || active.id !== id) {
        const meta = id ? await readMeta(id) : null;
        const error = meta?.status === "failed" ? meta.error : "The recording did not start.";
        return res.json({ ready: false, error });
      }
      const out = await fs.readFile(path.join(active.dir, "recorder.out"), "utf8").catch(() => "");
      if (out.includes("recording")) {
        if (!active.lines) watchLines(active);
        return res.json({ ready: true, recording: card(active.meta) });
      }
      const errText = (await fs.readFile(path.join(active.dir, "recorder.err"), "utf8").catch(() => "")).trim();
      const pid = Number((await fs.readFile(path.join(active.dir, "capture.pid"), "utf8").catch(() => "")).trim());
      const age = Date.now() - Date.parse(active.meta.startedAt);
      const gaveUp = (pid && !pidAlive(pid)) || (!pid && age > 8000);
      if (gaveUp && (errText || age > 8000)) {
        active.meta.status = "failed";
        active.meta.error = errText.slice(0, 300) || "The recorder did not start. Quit Second Brain and open it again, then press Record.";
        await writeMeta(active.dir, active.meta);
        const error = active.meta.error;
        active = null;
        return res.json({ ready: false, error });
      }
      res.json({ ready: false });
    } catch (err) {
      sendError(res, err, "checking the recording", 500);
    }
  });

  app.get("/screen/:id", async (req, res) => {
    try {
      const meta = await readMeta(req.params.id);
      if (!meta) return res.status(404).json({ error: "That recording was not found." });
      res.json({ recording: detail(meta) });
    } catch (err) {
      sendError(res, err, "reading a recording", 500);
    }
  });

  app.post("/screen/start", async (req, res) => {
    try {
      if (active) {
        const err = new Error("A recording is already running. Press Stop first.");
        err.status = 409;
        throw err;
      }
      requireFfmpeg();
      await ensureRecorder();
      const title = String(req.body?.title || "").trim().slice(0, 80) || "Screen recording";
      const lang = req.body?.lang === "ar" ? "ar" : "en";
      let id = recordingId(title, new Date());
      if (!safeRecordingId(id)) id = recordingId("screen", new Date());
      const dir = path.join(ROOT, id);
      await fs.mkdir(dir, { recursive: true });
      const meta = {
        id,
        title,
        startedAt: new Date().toISOString(),
        endedAt: "",
        status: "recording",
        file: "capture.mp4",
        seconds: 0,
        plan: { captions: true, summary: true, recap: false, lang },
        working: "",
        captions: [],
        summary: "",
        recap: "",
        live: [],
        warning: "",
        error: "",
      };
      await writeMeta(dir, meta);
      const capture = path.join(dir, "capture.mp4");
      // The Second Brain window starts this program. A background server is
      // not allowed to record the screen, and macOS does not ask it.
      active = { id, dir, meta, stopping: false };
      res.json({
        recording: card(meta),
        spawn: {
          bin: BINARY,
          capture,
          out: path.join(dir, "recorder.out"),
          err: path.join(dir, "recorder.err"),
          lang,
        },
      });
    } catch (err) {
      sendError(res, err, "starting the screen recording");
    }
  });

  app.post("/screen/stop", async (req, res) => {
    let dir = "";
    let meta = null;
    try {
      if (!active) {
        const err = new Error("There is no screen recording to stop.");
        err.status = 409;
        throw err;
      }
      const asked = safeRecordingId(req.body?.id);
      if (asked && asked !== active.id) {
        const err = new Error("That recording is not the one that is running.");
        err.status = 409;
        throw err;
      }
      dir = active.dir;
      meta = active.meta;
      active.stopping = true;
      meta.status = "saving";
      await writeMeta(dir, meta);
      await stopRecorder(dir);
      await stopLines(active);
      active = null;
      const capture = path.join(dir, "capture.mp4");
      const stat = await fs.stat(capture).catch(() => null);
      if (!stat || stat.size < 1000) {
        meta.status = "failed";
        meta.error = "The recording was empty. Allow Screen Recording in System Settings, then try again.";
        await writeMeta(dir, meta);
        const err = new Error(meta.error);
        throw err;
      }
      const tracks = await audioTrackCount(capture);
      if (tracks >= 2) {
        const mixed = path.join(dir, "video.mp4");
        try {
          await mixAudio(capture, mixed);
          meta.file = "video.mp4";
        } catch (err) {
          console.error("Failed while mixing the microphone with the Zoom sound:", err?.message || err);
          meta.file = "capture.mp4";
          meta.warning = "The video is saved. The two sound tracks could not be combined, so you may hear only one of them.";
        }
      } else if (tracks === 0) {
        meta.warning = "The picture was saved, but there was no sound. Check Screen Recording permission, then record again.";
      }
      const playable = videoPath(meta);
      meta.seconds = await durationSeconds(playable);
      meta.endedAt = new Date().toISOString();
      meta.status = "ready";
      meta.working = JOBS.find((job) => meta.plan?.[job]) || "";
      await writeMeta(dir, meta);
      res.json({ recording: detail(meta) });
      if (meta.working) finishPlanned(meta, req.body?.model).catch((err) => console.error("Failed after the recording:", err?.message || err));
    } catch (err) {
      if (meta && dir && meta.status === "saving") {
        meta.status = "failed";
        meta.error = String(err?.message || "The recording could not be saved.").slice(0, 300);
        await writeMeta(dir, meta).catch((error) => console.error("Failed while marking a recording as failed:", error?.message || error));
      }
      sendError(res, err, "stopping the screen recording");
    }
  });

  // While recording: tick a job so it runs as soon as the recording stops.
  app.post("/screen/:id/plan", async (req, res) => {
    try {
      const id = safeRecordingId(req.params.id);
      const job = JOBS.includes(req.body?.job) ? req.body.job : "";
      if (!job) throw new Error("Say captions, summary, or recap.");
      if (!active || active.id !== id) {
        const err = new Error("That recording is not running. Use the buttons under the video instead.");
        err.status = 409;
        throw err;
      }
      const on = Boolean(req.body?.on);
      active.meta.plan[job] = on;
      // The summary and the recap are written from the captions.
      if (job !== "captions" && on) active.meta.plan.captions = true;
      if (job === "captions" && !on) active.meta.plan.summary = active.meta.plan.recap = false;
      await writeMeta(active.dir, active.meta);
      res.json({ recording: card(active.meta) });
    } catch (err) {
      sendError(res, err, "planning work for the recording");
    }
  });

  async function jobRoute(req, res, job) {
    try {
      if (job === "recap" && active && active.id === safeRecordingId(req.params.id)) {
        await makeLiveRecap(active, req.body?.model);
        return res.json({ recording: detail(active.meta) });
      }
      const meta = await readMeta(req.params.id);
      if (!meta) return res.status(404).json({ error: "That recording was not found." });
      if (meta.working) {
        const err = new Error(`The ${meta.working} ${meta.working === "captions" ? "are" : "is"} still being written. Wait for it to finish.`);
        err.status = 409;
        throw err;
      }
      if (job === "captions") await makeCaptions(meta);
      else await makeWriteUp(meta, job, req.body?.model);
      await writeFiles(meta);
      res.json({ recording: detail(meta) });
    } catch (err) {
      sendError(res, err, `writing the ${job}`);
    }
  }

  for (const job of JOBS) app.post(`/screen/:id/${job}`, (req, res) => jobRoute(req, res, job));

  // The whole folder goes: video, captions, and write-ups. Not while it records or a job runs.
  app.post("/screen/:id/delete", async (req, res) => {
    try {
      const meta = await readMeta(req.params.id);
      if (!meta) return res.status(404).json({ error: "That recording was not found." });
      if (active && active.id === meta.id) return res.status(409).json({ error: "Stop the recording first." });
      if ([...jobs].some((key) => key.startsWith(`${meta.id}:`))) return res.status(409).json({ error: "Wait for the work on this recording to finish." });
      await fs.rm(path.join(ROOT, meta.id), { recursive: true, force: true });
      res.json({ ok: true });
    } catch (err) {
      sendError(res, err, "deleting the recording");
    }
  });

  app.post("/screen/:id/reveal", async (req, res) => {
    try {
      const meta = await readMeta(req.params.id);
      if (!meta) return res.status(404).json({ error: "That recording was not found." });
      const file = videoPath(meta);
      execFile("/usr/bin/open", ["-R", fsSync.existsSync(file) ? file : path.join(ROOT, meta.id)], () => {});
      res.json({ ok: true });
    } catch (err) {
      sendError(res, err, "showing the recording in Finder");
    }
  });
}
