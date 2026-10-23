/**
 * Prayer times, next to the weather.
 * The button shows the next prayer and its time. Clicking it opens today's five prayers.
 * The city is the same one this Mac's clock uses, like the weather.
 * The times come from Aladhan, a free service that picks the official method for the place:
 * in Amman that is the Jordan Ministry of Awqaf. No key is needed.
 */

const prayerBtn = document.getElementById("prayerBtn");
const prayerPanel = document.getElementById("prayerPanel");
const prayerMonitor = document.getElementById("prayerMonitor");
const prayerNext = document.getElementById("prayerNext");

const PRAYERS = ["Fajr", "Sunrise", "Dhuhr", "Asr", "Maghrib", "Isha"];

let prayerToday = null;
let prayerTomorrow = null;
let prayerError = "";
let prayerDay = "";

function prEl(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/** The service writes "05:22" or "05:22 (EEST)". Keep minutes since midnight. */
function prayerMinutes(stamp) {
  const [h, m] = String(stamp).slice(0, 5).split(":").map(Number);
  return h * 60 + m;
}

function prayerClock(stamp) {
  const when = new Date();
  const mins = prayerMinutes(stamp);
  when.setHours(Math.floor(mins / 60), mins % 60, 0, 0);
  return when.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/** "DD-MM-YYYY" for this Mac's own day, the date form the service wants. */
function prayerDate(offsetDays) {
  const when = new Date();
  when.setDate(when.getDate() + offsetDays);
  const dd = String(when.getDate()).padStart(2, "0");
  const mm = String(when.getMonth() + 1).padStart(2, "0");
  return `${dd}-${mm}-${when.getFullYear()}`;
}

/** The next prayer from now. After Isha it is tomorrow's Fajr. Sunrise is not a prayer. */
function nextPrayer() {
  if (!prayerToday) return null;
  const now = new Date();
  const mins = now.getHours() * 60 + now.getMinutes();
  for (const name of PRAYERS) {
    if (name === "Sunrise") continue;
    const at = prayerMinutes(prayerToday.timings[name]);
    if (at > mins) return { name, stamp: prayerToday.timings[name], left: at - mins };
  }
  const fajr = prayerTomorrow ? prayerTomorrow.timings.Fajr : prayerToday.timings.Fajr;
  return { name: "Fajr", stamp: fajr, left: 24 * 60 - mins + prayerMinutes(fajr), tomorrow: true };
}

function leftLabel(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h ? `in ${h} h ${m} min` : `in ${m} min`;
}

function paintPrayerPill() {
  if (!prayerNext) return;
  const next = nextPrayer();
  if (!next) {
    prayerNext.textContent = "–:–";
    return;
  }
  prayerNext.textContent = `${next.name} ${prayerClock(next.stamp)}`;
  if (prayerBtn) {
    prayerBtn.title = `${next.name} ${leftLabel(next.left)}`;
    prayerBtn.setAttribute("aria-label", `Next prayer ${next.name} at ${prayerClock(next.stamp)}, ${leftLabel(next.left)}`);
  }
}

function paintPrayerCard() {
  if (!prayerPanel) return;
  try {
    prayerPanel.replaceChildren();
    if (!prayerToday) {
      prayerPanel.append(prEl("p", "fan-note", prayerError || "Loading prayer times…"));
      return;
    }
    const here = macPlace();
    const hijri = prayerToday.date.hijri;
    const next = nextPrayer();
    prayerPanel.append(prEl("p", "fan-title", `Prayer times in ${here.city}`));
    prayerPanel.append(prEl("p", "fan-note pr-hijri", `${hijri.day} ${hijri.month.en} ${hijri.year} AH`));
    const list = prEl("ul", "fan-list pr-list");
    for (const name of PRAYERS) {
      const row = prEl("li", name === "Sunrise" ? "is-sunrise" : "");
      if (next && !next.tomorrow && next.name === name) row.classList.add("is-next");
      row.append(prEl("span", "fan-name", name), prEl("span", "fan-rpm", prayerClock(prayerToday.timings[name])));
      list.append(row);
    }
    prayerPanel.append(list);
    if (next) prayerPanel.append(prEl("p", "pr-left", `${next.name}${next.tomorrow ? " tomorrow" : ""} ${leftLabel(next.left)}`));
    prayerPanel.append(prEl("p", "fan-note", `Method: ${prayerToday.meta.method.name}. From aladhan.com.`));
  } catch (err) {
    console.error("Failed while drawing the prayer card:", err);
  }
}

function placePrayerPanel() {
  placeBarCard(prayerPanel, prayerBtn, 260);
}

function setPrayerOpen(open) {
  if (!prayerPanel || !prayerBtn) return;
  prayerPanel.hidden = !open;
  prayerBtn.setAttribute("aria-expanded", open ? "true" : "false");
  prayerBtn.classList.toggle("is-on", open);
  if (!open) return;
  setFanOpen(false);
  setUsageOpen(false);
  setClockOpen(false);
  if (typeof setWeatherOpen === "function") setWeatherOpen(false);
  paintPrayerCard();
  placePrayerPanel();
}

async function fetchPrayerDay(here, date) {
  const params = new URLSearchParams({
    latitude: String(here.lat),
    longitude: String(here.lon),
    timezonestring: here.timeZone,
  });
  const res = await fetch(`https://api.aladhan.com/v1/timings/${date}?${params}`);
  if (!res.ok) throw new Error("The prayer times service replied " + res.status);
  const body = await res.json();
  return body.data;
}

async function loadPrayer() {
  const here = typeof macPlace === "function" ? macPlace() : null;
  if (!here || here.lat == null) {
    prayerError = "This Mac’s clock has no city, so prayer times are blank.";
  } else {
    try {
      const [today, tomorrow] = await Promise.all([
        fetchPrayerDay(here, prayerDate(0)),
        fetchPrayerDay(here, prayerDate(1)),
      ]);
      prayerToday = today;
      prayerTomorrow = tomorrow;
      prayerDay = prayerDate(0);
      prayerError = "";
    } catch (err) {
      console.error("Failed while loading prayer times:", err);
      if (!prayerToday) prayerError = "Prayer times could not be loaded.";
    }
  }
  paintPrayerPill();
  if (prayerPanel && !prayerPanel.hidden) paintPrayerCard();
}

if (prayerBtn && prayerPanel) {
  prayerBtn.addEventListener("click", () => setPrayerOpen(prayerPanel.hidden));
  document.addEventListener("click", (event) => {
    if (prayerPanel.hidden) return;
    if (prayerMonitor?.contains(event.target) || prayerPanel.contains(event.target)) return;
    setPrayerOpen(false);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || prayerPanel.hidden) return;
    setPrayerOpen(false);
    event.preventDefault();
  });
  window.addEventListener("resize", placePrayerPanel);
  paintPrayerPill();
  const begin = () => {
    loadPrayer();
    // Every minute: move the button to the next prayer, and fetch again once the day changes.
    setInterval(() => {
      if (prayerDay && prayerDay !== prayerDate(0)) loadPrayer();
      paintPrayerPill();
      if (!prayerPanel.hidden) paintPrayerCard();
    }, 60 * 1000);
  };
  if (typeof zoneCoords !== "undefined" && zoneCoords) begin();
  else document.addEventListener("zones-ready", begin, { once: true });
}
