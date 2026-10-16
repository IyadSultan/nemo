/**
 * Settings shared by every part of the second brain: paths, ports, model
 * defaults, and the token caps. One .env at the repo root holds the keys.
 */

import dotenv from "dotenv";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const __dirname = path.dirname(fileURLToPath(import.meta.url));

// One .env at the repo root holds the OpenAI key for Nemo and this app.
dotenv.config({ path: path.join(__dirname, "..", ".env") });

export const DEFAULT_MODEL = "claude-opus";
export const DEFAULT_REASONING = "low";
// Chat memory is compressed by a local Ollama model, whatever model answers.
export const MEMORY_MODEL = "gpt-oss:20b";
// Same live voice model as Nemo (voice control). It hears the microphone.
export const VOICE_MODEL = "gpt-realtime-2.1-mini";
export const LOCAL_VOICE_MODEL = path.join(__dirname, "..", "voice", "models", "ggml-small.en.bin");
export const WHISPER_BIN = "/opt/homebrew/bin/whisper-cli";
// Keeps the voice model loaded, so each clip skips the model load (about 0.4s down to 0.1s).
// Whisper small.en beat Parakeet v2 on note names and acronyms on this Mac (17% vs 23% word errors).
export const WHISPER_SERVER_BIN = "/opt/homebrew/bin/whisper-server";
export const WHISPER_SERVER_URL = "http://127.0.0.1:8178/inference";
// Optional: hears English and Arabic and detects which one. Started only when first used.
export const MULTI_VOICE_MODEL = path.join(__dirname, "..", "voice", "models", "ggml-large-v3-turbo-q5_0.bin");
export const WHISPER_MULTI_URL = "http://127.0.0.1:8180/inference";
// A second copy of the big model, locked to Arabic, so English and Arabic can listen at once.
export const WHISPER_AR_URL = "http://127.0.0.1:8182/inference";
// Kokoro: the same local voice the claude-voice app uses. Local models speak with it.
export const KOKORO_PYTHON = "/usr/local/bin/python3.11";
export const KOKORO_SCRIPT = path.join(__dirname, "..", "voice", "kokoro_server.py");
export const KOKORO_URL = "http://127.0.0.1:8179";
export const FFMPEG_BIN = "/opt/homebrew/bin/ffmpeg";
// Ollama runs local models on this Mac. Bonsai is already installed there.
export const OLLAMA_URL = process.env.OLLAMA_URL || "http://127.0.0.1:11434";
// Meaning search runs next to keyword search. Small local model; ~20 ms per question.
export const EMBED_MODEL = "embeddinggemma";
export const DEFAULT_VOICE = "marin";
export const PORT = Number(process.env.BRAIN_PORT) || 3001;

// Higher reasoning needs room for hidden thinking tokens.
// Those tokens count toward this cap and toward the bill.
export const OUTPUT_CAP = {
  none: 700,
  low: 2000,
  medium: 4000,
  high: 8000,
  xhigh: 12000,
  max: 16000,
};
// Local replies are spoken aloud, so they stay short. A few sentences, then stop.
export const LOCAL_REPLY_CAP = {
  none: 120,
  low: 160,
  medium: 220,
  high: 280,
};
// Ollama counts hidden thinking toward num_predict. Bonsai thinks ~800 tokens
// even for "can you hear me", so without this room the reply came back empty.
export const LOCAL_THINK_ROOM = {
  none: 0,
  low: 1500,
  medium: 3000,
  high: 6000,
};
export const WIKI_PATH =
  process.env.WIKI_PATH ||
  "/Users/USER/Library/CloudStorage/OneDrive-KingHusseinCancerCenter/2nd_brain/wiki";
export const FOLDERS_FILE = path.join(__dirname, "folders.json");

// The four files the app always reads. They live together in the home folder.
export const BRAIN_DIR = path.join(os.homedir(), ".brain");
export const BRAIN_FILE = path.join(BRAIN_DIR, "brain.md");
export const MEMORIES_FILE = path.join(BRAIN_DIR, "memories.md");
export const MANUAL_FILE = path.join(BRAIN_DIR, "manual.md");
export const CODE_FILE = path.join(BRAIN_DIR, "code.md");

// Folders that are not real wiki pages (email-subject lists, Obsidian internals).
export const SKIP_DIRS = new Set([".obsidian", "_batches", "_batches2"]);

// Words that show up in almost every question and should not drive the search.
export const STOP_WORDS = new Set([
  "the", "and", "for", "with", "what", "who", "how", "why", "when", "where",
  "are", "was", "were", "you", "your", "my", "about", "from", "that", "this",
  "have", "has", "had", "does", "did", "can", "could", "would", "should",
  "tell", "please", "into", "onto", "than", "then", "them", "they", "their",
  "which", "whose", "will", "just", "know", "need", "want", "give", "show",
]);

