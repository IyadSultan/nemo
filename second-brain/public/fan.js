/**
 * The fan pill in the top bar.
 * It asks the server for the fan speed, memory, CPU, and GPU every few seconds.
 * Asking "how is the fan?" writes the same sentence into the transcript.
 * If memory gets close to full, this page shows an alert.
 * Agents that are working on code are left running.
 */

const fanBtn = document.getElementById("fanBtn");
const fanPanel = document.getElementById("fanPanel");
const fanSpeed = document.getElementById("fanSpeed");
const fanList = document.getElementById("fanList");
const fanNote = document.getElementById("fanNote");
const fanMonitor = document.getElementById("fanMonitor");

const EFFORT_LABEL = {
  quiet: "Quiet",
  easy: "Light",
  busy: "Working",
  hard: "Working hard",
  unknown: "Unknown",
};

function rpmText(value) {
  const rpm = Math.round(Number(value));
  if (!Number.isFinite(rpm) || rpm < 0) return "—";
  return rpm.toLocaleString("en-US");
}

/**
 * A number from 0 to 100: this fan's speed compared with its fastest.
 * Measured from zero, not from the slow idle speed. A fan at 2,000 rpm
 * on a fan that tops out near 7,800 is about a quarter full, not empty.
 */
function fanPercent(fan) {
  const rpm = Number(fan.rpm);
  const max = Number(fan.max);
  if (!Number.isFinite(rpm) || rpm <= 0 || !(max > 0)) return 0;
  return Math.max(0, Math.min(100, Math.round((rpm / max) * 100)));
}

function louderEffort(fans) {
  const rank = { unknown: 0, quiet: 1, easy: 2, busy: 3, hard: 4 };
  let best = "unknown";
  for (const fan of fans || []) {
    if ((rank[fan.effort] || 0) > (rank[best] || 0)) best = fan.effort;
  }
  return best;
}

/** Quiet / light / working / working hard, from a percent. */
function loadEffort(percent) {
  const n = Number(percent);
  if (!Number.isFinite(n)) return "unknown";
  if (n < 25) return "quiet";
  if (n < 60) return "easy";
  if (n < 85) return "busy";
  return "hard";
}

function gbText(bytes) {
  const gb = Number(bytes) / (1024 ** 3);
  if (!Number.isFinite(gb) || gb < 0) return "—";
  const rounded = Math.round(gb * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)} GB`;
}

function meterRow(name, value, how, percent, effort) {
  const row = document.createElement("li");
  row.className = "fan-meter";
  row.dataset.effort = effort || "unknown";
  row.innerHTML = `
    <span class="fan-name"></span>
    <span class="fan-rpm"></span>
    <span class="fan-how"></span>
    <span class="fan-bar" aria-hidden="true"><span></span></span>
  `;
  row.querySelector(".fan-name").textContent = name;
  row.querySelector(".fan-rpm").textContent = value;
  row.querySelector(".fan-how").textContent = how;
  row.querySelector(".fan-bar span").style.width = `${Math.max(0, Math.min(100, Number(percent) || 0))}%`;
  return row;
}

// The alert is shown once per spike. A new spike has a new time.
let shownMemoryAlarm = 0;

function warnIfMemoryFull(data) {
  const alarm = data?.load?.alarm;
  if (!alarm?.at || alarm.at === shownMemoryAlarm) return;
  shownMemoryAlarm = alarm.at;
  setFanOpen(true);
  const message = alarm.message || "Memory is getting full. Agents working on code were left running.";
  if (typeof addBubble === "function") addBubble("assistant", message);
  if (typeof setStatus === "function") setStatus("Memory is getting full.");
  window.alert(message);
}

/** The closed button shows RAM, CPU, and GPU. The open menu has the same numbers in more detail. */
function paintUse(load) {
  const ram = document.getElementById("fanRam");
  const cpu = document.getElementById("fanCpu");
  const gpu = document.getElementById("fanGpu");
  if (!ram || !cpu || !gpu) return;
  const memory = load?.memory;
  ram.textContent = memory ? `RAM ${memory.percent}%` : "RAM —";
  cpu.textContent = load?.cpu?.percent == null ? "CPU —" : `CPU ${load.cpu.percent}%`;
  gpu.textContent = load?.gpu?.percent == null ? "GPU —" : `GPU ${load.gpu.percent}%`;
  if (fanBtn) fanBtn.dataset.memory = memory?.danger ? "danger" : "ok";
}

function paintLoad(load) {
  paintUse(load);
  if (!fanList || !load) return;
  const memory = load.memory;
  const memoryEffort = memory?.danger ? "hard" : loadEffort(memory?.percent);
  const memoryRow = meterRow(
    "Memory",
    memory ? `${gbText(memory.usedBytes)} / ${gbText(memory.totalBytes)}` : "—",
    memory ? `${memory.percent}%` : "—",
    memory?.percent || 0,
    memoryEffort,
  );
  memoryRow.classList.add("is-split");
  fanList.appendChild(memoryRow);
  fanList.appendChild(meterRow(
    "CPU use",
    load.cpu?.percent == null ? "—" : `${load.cpu.percent}%`,
    EFFORT_LABEL[loadEffort(load.cpu?.percent)] || "—",
    load.cpu?.percent || 0,
    loadEffort(load.cpu?.percent),
  ));
  fanList.appendChild(meterRow(
    "GPU use",
    load.gpu?.percent == null ? "—" : `${load.gpu.percent}%`,
    load.gpu?.percent == null ? "—" : (EFFORT_LABEL[loadEffort(load.gpu.percent)] || "—"),
    load.gpu?.percent || 0,
    loadEffort(load.gpu?.percent),
  ));
}

function paintFans(data) {
  if (!fanBtn || !fanSpeed) return;
  const fans = data?.fans || [];
  const missing = !data?.ok || !fans.length;
  if (missing) {
    fanSpeed.textContent = "No fan";
    fanBtn.dataset.effort = "unknown";
    fanBtn.title = data?.error || "This Mac did not report a fan.";
  } else {
    const fastest = fans.reduce((best, fan) => (Number(fan.rpm) > Number(best.rpm) ? fan : best), fans[0]);
    const effort = louderEffort(fans);
    fanSpeed.textContent = `${rpmText(fastest.rpm)} rpm`;
    fanBtn.dataset.effort = effort;
    fanBtn.title = data.line || "Mac fan speed";
  }

  if (fanList) {
    fanList.replaceChildren();
    if (!missing) {
      for (const fan of fans) {
        const row = document.createElement("li");
        row.dataset.effort = fan.effort || "unknown";
        const percent = fanPercent(fan);
        row.innerHTML = `
          <span class="fan-name"></span>
          <span class="fan-rpm"></span>
          <span class="fan-how"></span>
          <span class="fan-bar" aria-hidden="true"><span></span></span>
        `;
        row.querySelector(".fan-name").textContent = fan.name;
        row.querySelector(".fan-rpm").textContent = `${rpmText(fan.rpm)} rpm`;
        row.querySelector(".fan-how").textContent = EFFORT_LABEL[fan.effort] || "Unknown";
        row.querySelector(".fan-bar span").style.width = `${percent}%`;
        fanList.appendChild(row);
      }
      for (const temp of data.temps || []) {
        const row = document.createElement("li");
        row.className = "fan-temp";
        const name = document.createElement("span");
        name.className = "fan-name";
        name.textContent = temp.name;
        const value = document.createElement("span");
        value.className = "fan-rpm";
        value.textContent = `${Math.round(Number(temp.c))}°`;
        row.append(name, value);
        fanList.appendChild(row);
      }
    }
    paintLoad(data?.load);
  }
  if (!fanList) paintUse(data?.load);
  if (fanNote) {
    if (data?.load?.alarm?.message) {
      fanNote.textContent = data.load.alarm.message;
      fanNote.classList.add("is-alarm");
    } else if (missing) {
      fanNote.textContent = fanBtn.title;
      fanNote.classList.remove("is-alarm");
    } else {
      fanNote.textContent = "Each fan bar is that fan's speed compared with its fastest. Memory is the part the Mac cannot easily free.";
      fanNote.classList.remove("is-alarm");
    }
  }
  warnIfMemoryFull(data);
}

async function refreshFans() {
  try {
    const response = await fetch("/fans");
    const data = await response.json();
    paintFans(data);
    placeFanPanel();
    return data;
  } catch (err) {
    console.error("Failed while asking for the fan speed:", err);
    paintFans({ ok: false, error: "The fan speed could not be read." });
    return null;
  }
}

/**
 * Keep a detail card on screen, under its button.
 * The card is moved onto the page itself so the character cannot paint over it.
 * The top bar blurs what is behind it, and that blur would otherwise hold the card underneath.
 */
function placeBarCard(panel, button, width) {
  if (!panel || panel.hidden || !button) return;
  if (panel.parentElement !== document.body) document.body.appendChild(panel);
  const btn = button.getBoundingClientRect();
  const cardWidth = Math.min(width, window.innerWidth - 16);
  let left = btn.left;
  if (left + cardWidth > window.innerWidth - 8) left = window.innerWidth - 8 - cardWidth;
  if (left < 8) left = 8;
  panel.style.position = "fixed";
  panel.style.top = `${Math.round(btn.bottom + 8)}px`;
  panel.style.left = `${Math.round(left)}px`;
  panel.style.width = `${Math.round(cardWidth)}px`;
}

function placeFanPanel() {
  placeBarCard(fanPanel, fanBtn, 300);
}

function setFanOpen(open) {
  if (!fanPanel || !fanBtn) return;
  fanPanel.hidden = !open;
  fanBtn.setAttribute("aria-expanded", open ? "true" : "false");
  fanBtn.classList.toggle("is-on", open);
  if (open) {
    setUsageOpen(false);
    setClockOpen(false);
    if (typeof setWeatherOpen === "function") setWeatherOpen(false);
    placeFanPanel();
  }
}

const usageBtn = document.getElementById("usageBtn");
const usagePanel = document.getElementById("usagePanel");
const usageMonitor = document.getElementById("usageMonitor");
const usageSummary = document.getElementById("usageSummary");
const clockTime = document.getElementById("clockTime");

/** The closed usage button shows the last answer time and the cost. The rest is in the card. */
function paintUsagePill() {
  if (!usageSummary) return;
  const wait = document.getElementById("lastWait")?.textContent || "–";
  const price = document.getElementById("chatPrice")?.textContent || "$0.00";
  usageSummary.textContent = `${wait} · ${price}`;
}

function placeUsagePanel() {
  placeBarCard(usagePanel, usageBtn, 240);
}

function setUsageOpen(open) {
  if (!usagePanel || !usageBtn) return;
  usagePanel.hidden = !open;
  usageBtn.setAttribute("aria-expanded", open ? "true" : "false");
  usageBtn.classList.toggle("is-on", open);
  if (open) {
    setFanOpen(false);
    setClockOpen(false);
    if (typeof setWeatherOpen === "function") setWeatherOpen(false);
    placeUsagePanel();
  }
}

const clockBtn = document.getElementById("clockBtn");
const clockPanel = document.getElementById("clockPanel");
const clockMonitor = document.getElementById("clockMonitor");
const clockList = document.getElementById("clockList");

/* Clocks only. Sunrise and sunset use wherever this Mac's clock is set, not these cities. */
const CLOCK_PLACES = [
  { name: "Amman", timeZone: "Asia/Amman" },
  { name: "Iowa", timeZone: "America/Chicago" },
];

/* City coordinates for each clock zone, loaded once from zone-coords.json.
   null means "not loaded yet". An empty object means the file failed. */
let zoneCoords = null;

/**
 * Noon today in that city's own calendar, as a universal instant.
 * Sunrise math needs a moment in the middle of *that* city's day.
 * Using "now" would show yesterday's sun in Iowa while it is already morning in Amman.
 */
function localNoon(timeZone, now) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const piece = (type) => parts.find((part) => part.type === type).value;
  const guess = new Date(Date.UTC(Number(piece("year")), Number(piece("month")) - 1, Number(piece("day")), 12, 0, 0));
  const shown = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(guess);
  const num = (type) => Number(shown.find((part) => part.type === type).value);
  const asUTC = Date.UTC(num("year"), num("month") - 1, num("day"), num("hour"), num("minute"), num("second"));
  const offsetMinutes = Math.round((asUTC - guess.getTime()) / 60000);
  return new Date(guess.getTime() - offsetMinutes * 60000);
}

/**
 * Sunrise and sunset for a latitude and longitude.
 * This is the usual solar math (the same idea as the SunCalc library):
 * where the sun is in the sky, then the moment it crosses the horizon.
 * The horizon includes a little bend from the air, so the times match a clock.
 * Returns two Date values in universal time. Missing sun (polar day) comes back blank.
 */
function sunRiseSet(date, lat, lon) {
  const rad = Math.PI / 180;
  const dayMs = 86400000;
  const J1970 = 2440588;
  const J2000 = 2451545;
  const toDays = (d) => d.valueOf() / dayMs - 0.5 + J1970 - J2000;
  const fromDays = (n) => new Date((n + J2000 + 0.5 - J1970) * dayMs);
  const obliquity = rad * 23.4397;
  const solarMean = (d) => rad * (357.5291 + 0.98560028 * d);
  const ecliptic = (m) => m + rad * (1.9148 * Math.sin(m) + 0.02 * Math.sin(2 * m) + 0.0003 * Math.sin(3 * m)) + rad * 102.9372 + Math.PI;
  const declination = (l) => Math.asin(Math.sin(l) * Math.sin(obliquity));
  const lw = rad * -lon;
  const phi = rad * lat;
  const n = Math.round(toDays(date) - 0.0009 - lw / (2 * Math.PI));
  const ds = 0.0009 + lw / (2 * Math.PI) + n;
  const m = solarMean(ds);
  const l = ecliptic(m);
  const dec = declination(l);
  const noon = J2000 + ds + 0.0053 * Math.sin(m) - 0.0069 * Math.sin(2 * l);
  const h0 = -0.833 * rad;
  const cosHour = (Math.sin(h0) - Math.sin(phi) * Math.sin(dec)) / (Math.cos(phi) * Math.cos(dec));
  if (cosHour < -1 || cosHour > 1) return { sunrise: null, sunset: null };
  const hour = Math.acos(cosHour);
  const setApprox = 0.0009 + (hour + lw) / (2 * Math.PI) + n;
  const set = J2000 + setApprox + 0.0053 * Math.sin(m) - 0.0069 * Math.sin(2 * l);
  return { sunrise: fromDays(noon - (set - noon) - J2000), sunset: fromDays(set - J2000) };
}

/** A clock time in one city, not in whatever zone this Mac is using. */
function timeIn(date, timeZone) {
  if (!date) return "—";
  return new Intl.DateTimeFormat(undefined, {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function clockRow(label, value, kind) {
  const row = document.createElement("li");
  if (kind) row.className = kind;
  const name = document.createElement("span");
  name.className = "fan-name";
  name.textContent = label;
  const shown = document.createElement("span");
  shown.className = "fan-rpm";
  shown.textContent = value;
  row.append(name, shown);
  return row;
}

/**
 * The place this Mac's clock is set to.
 * Europe/Rome becomes the city name Rome, plus that city's spot on the map.
 */
function macPlace() {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const pair = zoneCoords && zoneCoords[timeZone];
  const city = timeZone.split("/").pop().replace(/_/g, " ");
  if (!pair) return { timeZone, city, lat: null, lon: null };
  return { timeZone, city, lat: pair[0], lon: pair[1] };
}

/** Fill the card: Amman and Iowa clocks, then sunrise and sunset where this Mac is set. */
function paintClockCard() {
  if (!clockList) return;
  const now = new Date();
  const here = macPlace();
  const note = document.getElementById("clockNote");
  clockList.replaceChildren();
  for (const place of CLOCK_PLACES) {
    clockList.append(clockRow(place.name, timeIn(now, place.timeZone), "is-place"));
  }
  if (zoneCoords === null) {
    clockList.append(clockRow("Sunrise", "…", "is-sun"), clockRow("Sunset", "…"));
    return;
  }
  if (here.lat == null) {
    clockList.append(clockRow("Sunrise", "—", "is-sun"), clockRow("Sunset", "—"));
    if (note) note.textContent = "This Mac’s clock has no city, so sunrise is blank.";
    return;
  }
  const sun = sunRiseSet(localNoon(here.timeZone, now), here.lat, here.lon);
  clockList.append(
    clockRow("Sunrise", timeIn(sun.sunrise, here.timeZone), "is-sun"),
    clockRow("Sunset", timeIn(sun.sunset, here.timeZone)),
  );
  if (note) note.textContent = `Sunrise and sunset are for ${here.city}, where this Mac’s clock is set.`;
}

function placeClockPanel() {
  placeBarCard(clockPanel, clockBtn, 280);
}

function setClockOpen(open) {
  if (!clockPanel || !clockBtn) return;
  clockPanel.hidden = !open;
  clockBtn.setAttribute("aria-expanded", open ? "true" : "false");
  clockBtn.classList.toggle("is-on", open);
  if (open) {
    setFanOpen(false);
    setUsageOpen(false);
    if (typeof setWeatherOpen === "function") setWeatherOpen(false);
    paintClockCard();
    placeClockPanel();
  }
}

/** The pill stays this Mac's time. The card is Amman and Iowa, wherever the Mac is set. */
function paintClock() {
  if (!clockTime) return;
  const now = new Date();
  clockTime.dateTime = now.toISOString();
  clockTime.textContent = now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (clockPanel && !clockPanel.hidden) paintClockCard();
}

if (fanBtn && fanMonitor) {
  fanBtn.addEventListener("click", () => {
    const open = fanPanel.hidden;
    setFanOpen(open);
    if (open) refreshFans();
  });
  refreshFans();
  setInterval(() => {
    if (document.hidden) return;
    refreshFans();
  }, 3000);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refreshFans();
  });
}

/** Unload every Ollama model at once, so their memory comes back. */
async function clearOllamaModels(button) {
  button.disabled = true;
  button.textContent = "Clearing…";
  try {
    const response = await fetch("/stop-models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not stop the local models.");
    const count = Array.isArray(data.stopped) ? data.stopped.length : 0;
    button.textContent = count ? `Cleared ${count} model${count === 1 ? "" : "s"}` : "No models were loaded";
    refreshFans();
  } catch (err) {
    console.error("Failed while clearing Ollama models:", err);
    button.textContent = "Could not clear models";
  }
  setTimeout(() => {
    button.disabled = false;
    button.textContent = "Clear Ollama models";
  }, 2500);
}

const fanClearModels = document.getElementById("fanClearModels");
if (fanClearModels) fanClearModels.addEventListener("click", () => clearOllamaModels(fanClearModels));

if (usageBtn && usageMonitor) {
  usageBtn.addEventListener("click", () => setUsageOpen(usagePanel.hidden));
  paintUsagePill();
}

if (clockTime) {
  paintClock();
  setInterval(paintClock, 1000);
}
if (clockBtn && clockMonitor) {
  clockBtn.addEventListener("click", () => setClockOpen(clockPanel.hidden));
}
/* The city list is a small file next to this page. One load is enough for the whole visit. */
fetch("/zone-coords.json")
  .then((res) => res.json())
  .then((data) => {
    zoneCoords = data;
    if (clockPanel && !clockPanel.hidden) paintClockCard();
    document.dispatchEvent(new Event("zones-ready"));
  })
  .catch(() => {
    zoneCoords = {};
    if (clockPanel && !clockPanel.hidden) paintClockCard();
    document.dispatchEvent(new Event("zones-ready"));
  });

document.addEventListener("click", (event) => {
  const inFan = fanMonitor?.contains(event.target) || fanPanel?.contains(event.target);
  const inUsage = usageMonitor?.contains(event.target) || usagePanel?.contains(event.target);
  const inClock = clockMonitor?.contains(event.target) || clockPanel?.contains(event.target);
  const weatherPanel = document.getElementById("weatherPanel");
  const weatherMonitor = document.getElementById("weatherMonitor");
  const inWeather = weatherMonitor?.contains(event.target) || weatherPanel?.contains(event.target);
  if (!inFan && fanPanel && !fanPanel.hidden) setFanOpen(false);
  if (!inUsage && usagePanel && !usagePanel.hidden) setUsageOpen(false);
  if (!inClock && clockPanel && !clockPanel.hidden) setClockOpen(false);
  if (!inWeather && weatherPanel && !weatherPanel.hidden && typeof setWeatherOpen === "function") setWeatherOpen(false);
});
document.addEventListener("keydown", (event) => {
  const fanOpen = fanPanel && !fanPanel.hidden;
  const usageOpen = usagePanel && !usagePanel.hidden;
  const clockOpen = clockPanel && !clockPanel.hidden;
  const weatherPanel = document.getElementById("weatherPanel");
  const weatherOpen = weatherPanel && !weatherPanel.hidden;
  if (event.key !== "Escape" || (!fanOpen && !usageOpen && !clockOpen && !weatherOpen)) return;
  setFanOpen(false);
  setUsageOpen(false);
  setClockOpen(false);
  if (typeof setWeatherOpen === "function") setWeatherOpen(false);
  event.preventDefault();
});
window.addEventListener("resize", () => {
  placeFanPanel();
  placeUsagePanel();
  placeClockPanel();
  if (typeof placeWeatherPanel === "function") placeWeatherPanel();
});

/**
 * "How is the fan?" is answered here, without asking a model.
 * Returns true when this question was about the fans.
 */
function runFanAsk(question) {
  const q = String(question || "").toLowerCase().replace(/[^\w\s']/g, " ").replace(/\s+/g, " ").trim();
  if (!/\bfans?\b/.test(q)) return false;
  const aboutSpeed = /\b(how|speed|rpm|loud|hot|heat|spin|monitor|check|status|temperature|temp|running|fast)\b/.test(q);
  const namesTheFan = /\b(my|the|mac|laptop) fans?\b/.test(q);
  if (!aboutSpeed && !namesTheFan) return false;
  setFanOpen(true);
  setStatus("Checking the fans…");
  refreshFans().then((data) => {
    const line = data?.line || data?.error || "I could not read the fan speed.";
    addBubble("assistant", line);
    setStatus(listenStatus());
  }).catch((err) => {
    console.error("Failed while answering about the fan:", err);
    addBubble("assistant", "I could not read the fan speed.");
    setStatus(listenStatus());
  });
  return true;
}
