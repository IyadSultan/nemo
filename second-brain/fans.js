/**
 * Mac fan monitor.
 *
 * fanread.c asks the SMC chip for the fan speed. This file builds that
 * small program the first time it is needed, runs it, and turns the
 * numbers into a short sentence. The page asks GET /fans every few seconds.
 * Nothing here is saved, and nothing leaves this Mac.
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { __dirname } from "./config.js";

const execFileAsync = promisify(execFile);
const sourcePath = path.join(__dirname, "fanread.c");
const binaryPath = path.join(__dirname, "bin", "fanread");

// On a MacBook Pro the first fan is on the left and the second is on the right.
const FAN_NAMES = ["Left fan", "Right fan", "Fan 3", "Fan 4"];

/**
 * Build the reader when the C file is newer than the program on disk.
 * A failed build throws, and the caller tells the page.
 */
async function ensureReader() {
  const sourceTime = fs.statSync(sourcePath).mtimeMs;
  let binaryTime = 0;
  try {
    binaryTime = fs.statSync(binaryPath).mtimeMs;
  } catch {
    // The program has not been built yet.
  }
  if (binaryTime >= sourceTime) return;
  fs.mkdirSync(path.dirname(binaryPath), { recursive: true });
  try {
    await execFileAsync("cc", [
      "-O2",
      "-framework", "IOKit",
      "-framework", "CoreFoundation",
      "-o", binaryPath,
      sourcePath,
    ]);
  } catch (err) {
    console.error("Failed while building the fan reader:", err?.message || err);
    throw new Error("The fan reader could not be built.");
  }
}

/**
 * How hard a fan is working, from its slowest allowed speed to its fastest.
 * "quiet" means it is sitting at the slow speed Apple chose for an idle Mac.
 */
export function fanEffort(fan) {
  const rpm = Number(fan?.rpm);
  const min = Number(fan?.min);
  const max = Number(fan?.max);
  const span = max - min;
  if (!Number.isFinite(rpm) || rpm < 0 || !(span > 0)) return "unknown";
  const portion = (rpm - min) / span;
  if (portion < 0.08) return "quiet";
  if (portion < 0.4) return "easy";
  if (portion < 0.75) return "busy";
  return "hard";
}

const EFFORT_WORDS = {
  quiet: "and it is quiet",
  easy: "and it is spinning lightly",
  busy: "and it is working",
  hard: "and it is working hard",
  unknown: "",
};

/** One spoken sentence. The page shows this when you ask about the fan. */
export function describeFans(data) {
  if (!data?.ok) return "I could not read the fan speed.";
  const fans = data.fans || [];
  if (!fans.length) return "This Mac has no fan to report.";
  const parts = fans.map((fan) => {
    const rpm = Math.round(Number(fan.rpm));
    const how = EFFORT_WORDS[fan.effort || fanEffort(fan)] || "";
    const speed = Number.isFinite(rpm) && rpm >= 0 ? rpm.toLocaleString("en-US") : "an unknown speed";
    return `${fan.name} is at ${speed} revolutions per minute${how ? `, ${how}` : ""}`;
  });
  let line = `${parts.join(". ")}.`;
  const temps = (data.temps || [])
    .filter((temp) => Number.isFinite(Number(temp.c)))
    .map((temp) => `${temp.name} ${Math.round(Number(temp.c))} degrees`);
  if (temps.length) line += ` ${temps.join(", ")}.`;
  return line;
}

/** Add names and the quiet / easy / busy / hard word to the raw chip reading. */
export function presentFans(raw) {
  const data = raw && typeof raw === "object" ? raw : { ok: false, error: "The fan chip sent nothing." };
  if (!data.ok) return { ok: false, error: data.error || "The fan speed could not be read.", fans: [], temps: [], line: describeFans(data) };
  const fans = (data.fans || []).map((fan, index) => {
    const named = {
      name: FAN_NAMES[index] || `Fan ${index + 1}`,
      rpm: Number(fan.rpm),
      min: Number(fan.min),
      max: Number(fan.max),
    };
    named.effort = fanEffort(named);
    return named;
  });
  const temps = (data.temps || []).map((temp) => ({ name: String(temp.name || "Chip"), c: Number(temp.c) }));
  const presented = { ok: true, fans, temps };
  presented.line = describeFans(presented);
  return presented;
}

// Two asks close together share one reading. The chip does not need to be poked more often.
let cache = { at: 0, data: null };

export async function readFans() {
  if (cache.data && Date.now() - cache.at < 2000) return cache.data;
  await ensureReader();
  let stdout = "";
  try {
    const result = await execFileAsync(binaryPath, [], { timeout: 2000 });
    stdout = result.stdout;
  } catch (err) {
    console.error("Failed while reading the fan chip:", err?.message || err);
    throw new Error("The fan speed could not be read.");
  }
  let raw;
  try {
    raw = JSON.parse(stdout);
  } catch (err) {
    console.error("Failed while reading the fan chip's answer:", err?.message || err);
    throw new Error("The fan chip's answer was not understood.");
  }
  const data = presentFans(raw);
  cache = { at: Date.now(), data };
  return data;
}

export function registerFans(app) {
  app.get("/fans", async (_req, res) => {
    try {
      res.json(await readFans());
    } catch (err) {
      res.status(500).json({ ok: false, error: err?.message || "The fan speed could not be read.", fans: [], temps: [] });
    }
  });
}
