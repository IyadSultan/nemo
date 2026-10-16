/**
 * Local ears and voice: whisper servers for English and Arabic, Kokoro for speaking,
 * and the /transcribe and /speak routes.
 */

import { FFMPEG_BIN, KOKORO_PYTHON, KOKORO_SCRIPT, KOKORO_URL, LOCAL_VOICE_MODEL, MULTI_VOICE_MODEL, WHISPER_AR_URL, WHISPER_BIN, WHISPER_MULTI_URL, WHISPER_SERVER_BIN, WHISPER_SERVER_URL, __dirname } from "./config.js";
import { runCommand } from "./shell.js";
import express from "express";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

let multiWhisperUp = null;
let arabicWhisperUp = null;

/** Start the local whisper server once. If it dies, /transcribe falls back to whisper-cli. */
export function startWhisperServer(model = LOCAL_VOICE_MODEL, url = WHISPER_SERVER_URL, lang = "en") {
  const port = new URL(url).port;
  const child = spawn(
    WHISPER_SERVER_BIN,
    ["-m", model, "--host", "127.0.0.1", "--port", port, "-l", lang, "-nt", "-bs", "1", "-bo", "1", "-nf", "-t", "4"],
    { stdio: "ignore" }
  );
  child.on("error", (err) => console.error("Failed while starting whisper-server:", err?.message || err));
  child.on("exit", (code) => {
    if (code) console.error(`whisper-server stopped (exit ${code}). Using whisper-cli instead.`);
  });
  process.on("exit", () => child.kill());
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => process.exit(0));
  }
}

/** Start the Kokoro voice once. It takes about 7 seconds to load the model. */
export function startKokoro() {
  const child = spawn(KOKORO_PYTHON, [KOKORO_SCRIPT], { stdio: ["ignore", "ignore", "pipe"] });
  child.stderr.on("data", (chunk) => {
    const text = String(chunk).trim();
    if (text) console.error(`Kokoro: ${text.slice(0, 300)}`);
  });
  child.on("error", (err) => console.error("Failed while starting Kokoro:", err?.message || err));
  child.on("exit", (code) => {
    if (code) console.error(`Kokoro stopped (exit ${code}). The page will use the Mac voice instead.`);
  });
  process.on("exit", () => child.kill());
}

/** Start one whisper server and wait until it answers. The model takes a few seconds to load. */
export function ensureWhisper(slot, model, url, lang) {
  if (!slot.current) {
    slot.current = (async () => {
      await fs.access(model);
      startWhisperServer(model, url, lang);
      const health = url.replace("/inference", "/");
      for (let i = 0; i < 60; i += 1) {
        try {
          await fetch(health);
          return;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      }
      throw new Error("The voice model did not start.");
    })();
    slot.current.catch(() => { slot.current = null; });
  }
  return slot.current;
}

/** Start the English + Arabic whisper once, and wait until it answers (the model takes a few seconds to load). */
export function ensureMultiWhisper() {
  return ensureWhisper({ get current() { return multiWhisperUp; }, set current(value) { multiWhisperUp = value; } }, MULTI_VOICE_MODEL, WHISPER_MULTI_URL, "auto");
}

/** Start the Arabic-only whisper once. It is a second listener, not a replacement for the English one. */
export function ensureArabicWhisper() {
  return ensureWhisper({ get current() { return arabicWhisperUp; }, set current(value) { arabicWhisperUp = value; } }, MULTI_VOICE_MODEL, WHISPER_AR_URL, "ar");
}

// "Hey" as the English model writes it, including an Arabic accent (hay, hi, hei).
export const WAKE_HEARD = /^[\s"'“”]*(hey|hay|hei|hi)\b/i;

// The wake word written in Arabic letters, or still in English, at the start of the Arabic text.
export const ARABIC_WAKE = /^[\s"'“”]*(?:هاي|هاى|هي|هيه|هاي|اي|hey|hay|hi)[\s,.:;!?،\-]*/i;

/** One clip to text. auto = the English + Arabic model; otherwise the fast English one. */
export async function whisperText(wav, auto) {
  const text = (await transcribeWithServer(wav, auto ? WHISPER_MULTI_URL : WHISPER_SERVER_URL)) ?? await runCommand(WHISPER_BIN, [
    "-m", auto ? MULTI_VOICE_MODEL : LOCAL_VOICE_MODEL,
    "-f", wav,
    "-l", auto ? "auto" : "en",
    "-nt",
    "-np",
    "-bs", "1",
    "-bo", "1",
    "-nf",
    "-t", "4",
  ]);
  return text.replace(/\s+/g, " ").trim();
}

/** The Arabic listener. Same kind of model as the big one, but it is told the speech is Arabic. */
export async function whisperArabic(wav) {
  const text = (await transcribeWithServer(wav, WHISPER_AR_URL)) ?? await runCommand(WHISPER_BIN, [
    "-m", MULTI_VOICE_MODEL,
    "-f", wav,
    "-l", "ar",
    "-nt",
    "-np",
    "-bs", "1",
    "-bo", "1",
    "-nf",
    "-t", "4",
  ]);
  return text.replace(/\s+/g, " ").trim();
}

/** Whisper writes these on a quiet room. They are not speech. */
export function whisperJunk(text) {
  const raw = String(text || "").trim();
  if (/^\([^)]*\)$/.test(raw) || /^\[[^\]]*\]$/.test(raw)) return true;
  const cleaned = raw.toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, "").trim();
  if (cleaned.length < 2) return true;
  if (["thank you", "thanks for watching", "you", "bye", "silence", "music", "blank audio"].includes(cleaned)) return true;
  // Arabic YouTube-style captions the model invents when the speech was English.
  const arabic = raw.normalize("NFKD").replace(/\p{M}/gu, "").replace(/[^\p{L}\p{N}\s]/gu, "").replace(/\s+/g, " ").trim();
  return ["شكرا للمشاهدة", "المترجم للقناة", "اشتركوا في القناة", "ترجمة نانسي قنقر"].includes(arabic);
}

/** Put the English line and the Arabic line one under the other. */
export function combineLanguages(english, arabic) {
  const en = whisperJunk(english) ? "" : String(english || "").trim();
  const ar = whisperJunk(arabic) ? "" : String(arabic || "").trim();
  const lines = [];
  if (en) lines.push(`English: ${en}`);
  if (ar) lines.push(`Arabic: ${ar}`);
  return {
    text: lines.join("\n"),
    english: en,
    arabic: ar,
    language: en && ar ? "both" : ar ? "ar" : "en",
  };
}

/** Ask the warm whisper server. Returns null if it is not up, so the caller can use whisper-cli. */
export async function transcribeWithServer(wav, url = WHISPER_SERVER_URL) {
  try {
    const fd = new FormData();
    fd.set("file", new Blob([await fs.readFile(wav)], { type: "audio/wav" }), "clip.wav");
    fd.set("response_format", "json");
    const response = await fetch(url, { method: "POST", body: fd });
    if (!response.ok) throw new Error(`whisper-server returned ${response.status}`);
    const data = await response.json();
    return data.text || "";
  } catch (err) {
    console.error("Failed while using whisper-server, falling back to whisper-cli:", err?.message || err);
    return null;
  }
}

export function registerSpeech(app) {
  /**
   * Local listening. The small voice model on this Mac writes down the words.
   * Nothing is sent to OpenAI for this step.
   */
  app.post(
    "/transcribe",
    express.raw({ type: ["audio/*", "application/octet-stream", "video/webm"], limit: "20mb" }),
    async (req, res) => {
      if (!req.body || !req.body.length) {
        return res.status(400).json({ error: "No audio was sent." });
      }
      // ?lang=auto: "Hey" in English starts the question; the question itself may be English or Arabic.
      // ?lang=any: hear the whole clip in whichever language was spoken. No Hey needed.
      // ?lang=both: the English whisper and the Arabic whisper both listen, and both lines come back.
      const auto = req.query.lang === "auto";
      const hearAny = req.query.lang === "any";
      const hearBoth = req.query.lang === "both";
      const dir = path.join(__dirname, "tmp");
      const stamp = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
      const source = path.join(dir, `${stamp}.webm`);
      const wav = path.join(dir, `${stamp}.wav`);
      try {
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(source, req.body);
        await runCommand(FFMPEG_BIN, ["-y", "-loglevel", "error", "-i", source, "-ac", "1", "-ar", "16000", wav]);
        let text = "";
        let language = "en";
        if (hearBoth) {
          // Two listeners at once. The English one is already running. The Arabic one starts on first use.
          try {
            await ensureArabicWhisper();
          } catch (err) {
            console.error("Failed while starting the Arabic whisper:", err?.message || err);
            return res.status(503).json({ error: "The Arabic voice model is not installed." });
          }
          const [english, arabic] = await Promise.all([whisperText(wav, false), whisperArabic(wav)]);
          const combined = combineLanguages(english, arabic);
          text = combined.text;
          language = combined.language;
        } else if (hearAny) {
          // Medical speech may be Arabic with no Hey. The English-only model would miss it.
          try {
            await ensureMultiWhisper();
          } catch (err) {
            console.error("Failed while starting the English + Arabic whisper:", err?.message || err);
            return res.status(503).json({ error: "The English + Arabic voice model is not installed." });
          }
          text = await whisperText(wav, true);
          if (/[\u0600-\u06FF]/.test(text)) language = "ar";
        } else {
          // The fast English model always listens first. It hears an Arabic-accented "hey" as hay or hi.
          const english = await whisperText(wav, false);
          text = english;
          if (auto && WAKE_HEARD.test(english)) {
            // Wake word found: now write the whole clip in whichever language was spoken.
            try {
              await ensureMultiWhisper();
            } catch (err) {
              console.error("Failed while starting the English + Arabic whisper:", err?.message || err);
              return res.status(503).json({ error: "The English + Arabic voice model is not installed." });
            }
            const heard = await whisperText(wav, true);
            // Whisper may write the wake word as هاي or Hi. The page looks for "Hey", so put that back.
            text = `Hey ${heard.replace(ARABIC_WAKE, "")}`;
            if (/[\u0600-\u06FF]/.test(heard)) language = "ar";
          }
        }
        const mode = hearBoth ? "both" : hearAny ? "any" : auto ? "auto" : "english";
        console.log(`Transcribed (${mode}): ${language}, ${text.length} chars, wake ${WAKE_HEARD.test(text) ? "yes" : "no"}`);
        res.json({ text, language });
      } catch (err) {
        console.error("Failed while transcribing locally:", err?.message || err);
        res.status(500).json({ error: "The local voice model could not hear that clip." });
      } finally {
        await fs.rm(source, { force: true }).catch(() => {});
        await fs.rm(wav, { force: true }).catch(() => {});
      }
    }
  );

  /** Load the English + Arabic whisper now, so the first medical clip is not a cold start. */
  app.post("/transcribe/warm", (req, res) => {
    const start = req.query.lang === "both" ? ensureArabicWhisper() : ensureMultiWhisper();
    start.catch((err) => console.error("Failed while loading a whisper:", err?.message || err));
    res.json({ ok: true });
  });

  /** Turn one piece of the answer into speech with Kokoro, on this Mac. */
  app.post("/speak", async (req, res) => {
    const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
    if (!text) return res.status(400).json({ error: "No text to speak." });
    // A Kokoro voice name, like af_heart. Anything else gets Kokoro's default.
    const voice = /^[ab][fm]_[a-z]+$/.test(req.body?.voice) ? req.body.voice : undefined;
    try {
      const upstream = await fetch(`${KOKORO_URL}/speak`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, voice }),
      });
      if (!upstream.ok) throw new Error(`Kokoro returned ${upstream.status}`);
      res.type("audio/wav").send(Buffer.from(await upstream.arrayBuffer()));
    } catch (err) {
      console.error("Failed while speaking with Kokoro:", err?.message || err);
      res.status(503).json({ error: "The Kokoro voice is not ready." });
    }
  });
}
