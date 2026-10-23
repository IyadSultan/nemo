/**
 * Mac fan monitor, plus how full memory is and how busy the CPU and GPU are.
 *
 * fanread.c asks the SMC chip for the fan speed. This file builds that
 * small program the first time it is needed, runs it, and turns the
 * numbers into a short sentence. The page asks GET /fans every few seconds.
 * Memory, CPU, and GPU are read here too, with no extra program.
 * When memory gets close to full, the page shows an alert.
 * Agents that are working on code are left running.
 * Nothing here is saved, and nothing leaves this Mac.
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
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

// 85% of real memory (apps + wired + compressed, not the cache macOS can drop)
// is "getting close to full". macOS also has its own warning, which counts too.
// The alarm stays until memory falls back under 75%, so it does not flap.
export const MEMORY_DANGER = 85;
export const MEMORY_CLEAR = 75;

/** "31.1 GB" or "48 GB". */
export function formatGb(bytes) {
  const gb = Number(bytes) / (1024 ** 3);
  if (!Number.isFinite(gb) || gb < 0) return "—";
  const rounded = Math.round(gb * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)} GB`;
}

/** True when memory is close to full, or macOS has already raised a warning. */
export function memoryIsDangerous(memory) {
  const pressure = memory?.pressure;
  if (pressure === "warning" || pressure === "critical") return true;
  return Number(memory?.percent) >= MEMORY_DANGER;
}

/**
 * Turn the vm_stat text into how much memory is really in use.
 * "Used" is active pages + wired pages + compressed pages. File cache is left out,
 * because macOS can give that back. pressureLevel is Apple's own number:
 * 1 normal, 2 warning, 4 urgent, 8 critical.
 */
export function memoryFromVmStat(text, totalBytes, pressureLevel) {
  const pageSize = Number(String(text).match(/page size of (\d+)/)?.[1]) || 4096;
  const pages = {};
  for (const match of String(text).matchAll(/^"?([^":\n]+)"?:\s+(\d+)/gm)) {
    pages[match[1].trim()] = Number(match[2]);
  }
  const usedPages = (pages["Pages active"] || 0)
    + (pages["Pages wired down"] || 0)
    + (pages["Pages occupied by compressor"] || 0);
  const usedBytes = usedPages * pageSize;
  const total = Number(totalBytes) || 0;
  const percent = total > 0 ? Math.min(100, Math.round((usedBytes / total) * 100)) : 0;
  const level = Number(pressureLevel) || 0;
  const pressure = level >= 4 ? "critical" : level >= 2 ? "warning" : "ok";
  const memory = { usedBytes, totalBytes: total, percent, pressure };
  memory.danger = memoryIsDangerous(memory);
  return memory;
}

/** The busiest GPU's "Device Utilization %", from the Apple GPU report. */
export function gpuPercent(text) {
  const found = [...String(text).matchAll(/"Device Utilization %"=(\d+)/g)]
    .map((match) => Number(match[1]))
    .filter((value) => value >= 0 && value <= 100);
  if (!found.length) return null;
  return Math.max(...found);
}

/** One sentence for the alert and the chat. Working agents are not closed. */
export function memoryAlarmMessage(memory) {
  const used = formatGb(memory?.usedBytes);
  const total = formatGb(memory?.totalBytes);
  const why = memory?.pressure === "ok"
    ? `Memory is ${memory?.percent}% full (${used} of ${total}). That is close to a dangerous level.`
    : `Memory is ${memory?.percent}% full (${used} of ${total}), and macOS says it is running out.`;
  return `${why} Agents working on code were left running.`;
}

function loadSentence(load) {
  if (!load?.memory) return "";
  const memory = `Memory is ${formatGb(load.memory.usedBytes)} of ${formatGb(load.memory.totalBytes)}, ${load.memory.percent} percent.`;
  const cpu = load.cpu?.percent == null ? "" : ` CPU is ${load.cpu.percent} percent.`;
  const gpu = load.gpu?.percent == null ? "" : ` GPU is ${load.gpu.percent} percent.`;
  return ` ${memory}${cpu}${gpu}`;
}

// CPU percent needs two looks. The first look only remembers the counters.
let lastCpu = null;

export function cpuPercent(cpus = os.cpus()) {
  let idle = 0;
  let total = 0;
  for (const cpu of cpus || []) {
    const times = cpu?.times || {};
    idle += Number(times.idle) || 0;
    total += (Number(times.user) || 0) + (Number(times.nice) || 0) + (Number(times.sys) || 0) + (Number(times.idle) || 0) + (Number(times.irq) || 0);
  }
  const prev = lastCpu;
  lastCpu = { idle, total };
  if (!prev) return null;
  const dTotal = total - prev.total;
  if (dTotal <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((1 - (idle - prev.idle) / dTotal) * 100)));
}

async function readMemory() {
  const totalBytes = os.totalmem();
  let vm = "";
  let level = 1;
  try {
    const [vmResult, pressureResult] = await Promise.all([
      execFileAsync("vm_stat", [], { timeout: 2000, encoding: "utf8" }),
      execFileAsync("sysctl", ["-n", "kern.memorystatus_vm_pressure_level"], { timeout: 2000, encoding: "utf8" }).catch(() => ({ stdout: "1" })),
    ]);
    vm = vmResult.stdout;
    level = Number(String(pressureResult.stdout).trim()) || 1;
  } catch (err) {
    console.error("Failed while reading memory:", err?.message || err);
    return null;
  }
  return memoryFromVmStat(vm, totalBytes, level);
}

async function readGpu() {
  try {
    const { stdout } = await execFileAsync(
      "ioreg",
      ["-r", "-d", "1", "-w", "0", "-c", "IOAccelerator"],
      { timeout: 2000, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
    );
    return gpuPercent(stdout);
  } catch (err) {
    console.error("Failed while reading the GPU:", err?.message || err);
    return null;
  }
}

export async function readLoad() {
  const [memory, gpu] = await Promise.all([readMemory(), readGpu()]);
  return {
    memory,
    cpu: { percent: cpuPercent() },
    gpu: { percent: gpu },
  };
}

// One alarm per spike. It stays up until memory falls back under the clear line.
let lastAlarm = null;

/**
 * If memory just crossed the line, warn once.
 * Agents that are working on code are not told to exit.
 */
export async function considerMemoryAlarm(data) {
  const memory = data?.load?.memory;
  if (!memory) return data;
  if (memory.danger) {
    if (!lastAlarm) {
      lastAlarm = {
        at: Date.now(),
        message: memoryAlarmMessage(memory),
        exited: [],
        failed: [],
      };
      console.error(lastAlarm.message);
    }
  } else if (memory.percent < MEMORY_CLEAR && memory.pressure === "ok") {
    lastAlarm = null;
  }
  if (data.load) {
    if (lastAlarm) data.load.alarm = lastAlarm;
    else delete data.load.alarm;
  }
  return data;
}

// Two asks close together share one reading. The chip does not need to be poked more often.
let cache = { at: 0, data: null };

export async function readFans() {
  if (cache.data && Date.now() - cache.at < 2000) return cache.data;
  let data;
  try {
    await ensureReader();
    const result = await execFileAsync(binaryPath, [], { timeout: 2000 });
    data = presentFans(JSON.parse(result.stdout));
  } catch (err) {
    console.error("Failed while reading the fan chip:", err?.message || err);
    data = {
      ok: false,
      error: "The fan speed could not be read.",
      fans: [],
      temps: [],
      line: "I could not read the fan speed.",
    };
  }
  try {
    data.load = await readLoad();
  } catch (err) {
    console.error("Failed while reading memory, CPU, or GPU:", err?.message || err);
    data.load = null;
  }
  if (data.line) data.line += loadSentence(data.load);
  cache = { at: Date.now(), data };
  return data;
}

let watchTimer = null;

/** Keep checking memory even when the page is in the background. */
export function startMemoryWatch() {
  if (watchTimer) return;
  const tick = () => {
    readFans()
      .then((data) => considerMemoryAlarm(data))
      .catch((err) => console.error("Failed while checking memory:", err?.message || err));
  };
  tick();
  watchTimer = setInterval(tick, 5000);
  watchTimer.unref?.();
}

export function registerFans(app) {
  app.get("/fans", async (_req, res) => {
    try {
      const data = await readFans();
      await considerMemoryAlarm(data);
      res.json(data);
    } catch (err) {
      res.status(500).json({ ok: false, error: err?.message || "The fan speed could not be read.", fans: [], temps: [] });
    }
  });
  startMemoryWatch();
}
