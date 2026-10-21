/**
 * Outside weather, next to the clock.
 * The number on the button is the temperature right now.
 * Clicking it opens a card like the iPhone weather screen:
 * the big temperature, the next hours, and the next week.
 * The city is the same one this Mac's clock uses (Rome, if the clock is set to Rome).
 * The numbers come from Open-Meteo, a free weather service. No key is needed.
 */

const weatherBtn = document.getElementById("weatherBtn");
const weatherPanel = document.getElementById("weatherPanel");
const weatherIconBox = document.getElementById("weatherIcon");
const weatherTemp = document.getElementById("weatherTemp");

let weatherReport = null;
let weatherError = "";
let weatherAt = 0;

function wxEl(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/** A short name for the weather service's number code. */
function weatherName(code) {
  const names = {
    0: "Clear",
    1: "Mostly Clear",
    2: "Partly Cloudy",
    3: "Cloudy",
    45: "Fog",
    48: "Fog",
    51: "Light Drizzle",
    53: "Drizzle",
    55: "Heavy Drizzle",
    56: "Freezing Drizzle",
    57: "Freezing Drizzle",
    61: "Light Rain",
    63: "Rain",
    65: "Heavy Rain",
    66: "Freezing Rain",
    67: "Freezing Rain",
    71: "Light Snow",
    73: "Snow",
    75: "Heavy Snow",
    77: "Snow",
    80: "Light Showers",
    81: "Showers",
    82: "Heavy Showers",
    85: "Snow Showers",
    86: "Heavy Snow Showers",
    95: "Thunderstorm",
    96: "Thunderstorm",
    99: "Thunderstorm",
  };
  return names[Number(code)] || "Weather";
}

/** Group the code into a sky type, so one icon and one background can cover many codes. */
function skyKind(code) {
  const n = Number(code);
  if (n === 0 || n === 1) return "clear";
  if (n === 2) return "partly";
  if (n === 3) return "cloudy";
  if (n === 45 || n === 48) return "fog";
  if ((n >= 51 && n <= 67) || (n >= 80 && n <= 82)) return "rain";
  if ((n >= 71 && n <= 77) || n === 85 || n === 86) return "snow";
  if (n >= 95) return "storm";
  return "cloudy";
}

function skyKey(code, isDay) {
  const kind = skyKind(code);
  if (kind === "clear" || kind === "partly") return `${kind}-${Number(isDay) === 0 ? "night" : "day"}`;
  return kind;
}

function iconWrap(body) {
  return `<svg viewBox="0 0 32 32" aria-hidden="true">${body}</svg>`;
}

const SUN = iconWrap(`
  <circle cx="16" cy="16" r="5.5" fill="#FFD60A"/>
  <g stroke="#FFD60A" stroke-width="2" stroke-linecap="round">
    <path d="M16 3.2v3.4M16 25.4v3.4M3.2 16h3.4M25.4 16h3.4M7 7l2.4 2.4M22.6 22.6 25 25M25 7l-2.4 2.4M9.4 22.6 7 25"/>
  </g>`);
const MOON = iconWrap(`<path fill="#F4F1FF" d="M20 5.2a8.2 8.2 0 1 0 6.2 13.6A7.1 7.1 0 0 1 20 5.2z"/>`);
const CLOUD = iconWrap(`<path fill="#fff" d="M11 23.2h11.4a4.3 4.3 0 0 0 .2-8.6 6.1 6.1 0 0 0-11.7-1.2 3.9 3.9 0 0 0 .1 9.8z"/>`);
const SUN_CLOUD = iconWrap(`
  <circle cx="12" cy="11" r="4" fill="#FFD60A"/>
  <g stroke="#FFD60A" stroke-width="1.7" stroke-linecap="round">
    <path d="M12 4.2v2M12 16v2M5.2 11h2M16.8 11h2M7.2 6.2l1.4 1.4M15.4 14.4 16.8 15.8M16.8 6.2 15.4 7.6M8.6 14.4 7.2 15.8"/>
  </g>
  <path fill="#fff" d="M13.2 24h10.2a3.7 3.7 0 0 0 .2-7.4 5.2 5.2 0 0 0-10-1 3.4 3.4 0 0 0-.4 8.4z"/>`);
const MOON_CLOUD = iconWrap(`
  <path fill="#F4F1FF" d="M14 6.2a5.6 5.6 0 0 0 4.4 9.2 4.8 4.8 0 0 1-4.4-9.2z"/>
  <path fill="#fff" d="M12.5 24h10.4a3.8 3.8 0 0 0 .2-7.6 5.3 5.3 0 0 0-10.1-1 3.5 3.5 0 0 0-.5 8.6z"/>`);
const FOG = iconWrap(`
  <path fill="#fff" d="M11.2 15.2h10.6a3.6 3.6 0 0 0 .2-7.2 5.2 5.2 0 0 0-10-1 3.3 3.3 0 0 0-.8 8.2z"/>
  <g stroke="#d5dde6" stroke-width="1.8" stroke-linecap="round">
    <path d="M8 19.2h16M9.5 22.4h13M11 25.6h10"/>
  </g>`);
const RAIN = iconWrap(`
  <path fill="#fff" d="M10.6 18.4h11.6a4.1 4.1 0 0 0 .2-8.2 5.8 5.8 0 0 0-11.2-1.2 3.7 3.7 0 0 0-.6 9.4z"/>
  <g stroke="#7ecbff" stroke-width="1.8" stroke-linecap="round">
    <path d="M13 21.2 11.6 24.6M17 21.2l-1.4 3.4M21 21.2 19.6 24.6"/>
  </g>`);
const SNOW = iconWrap(`
  <path fill="#fff" d="M10.6 17.6h11.6a4.1 4.1 0 0 0 .2-8.2 5.8 5.8 0 0 0-11.2-1.2 3.7 3.7 0 0 0-.6 9.4z"/>
  <g fill="#fff">
    <circle cx="12.5" cy="22" r="1.15"/>
    <circle cx="16.5" cy="24.4" r="1.15"/>
    <circle cx="20.4" cy="21.6" r="1.15"/>
  </g>`);
const STORM = iconWrap(`
  <path fill="#fff" d="M10.2 17.2h12a4.2 4.2 0 0 0 .2-8.4 6 6 0 0 0-11.5-1.2 3.8 3.8 0 0 0-.7 9.6z"/>
  <path fill="#FFD60A" d="M17.2 16.2 13.4 22h3.1l-1.2 5.2 5.2-6.6h-3.2z"/>`);

/** The little picture for a weather code. isDay is 1 in daylight and 0 at night. */
function weatherIcon(code, isDay) {
  const kind = skyKind(code);
  const day = Number(isDay) !== 0;
  if (kind === "clear") return day ? SUN : MOON;
  if (kind === "partly") return day ? SUN_CLOUD : MOON_CLOUD;
  if (kind === "fog") return FOG;
  if (kind === "rain") return RAIN;
  if (kind === "snow") return SNOW;
  if (kind === "storm") return STORM;
  return CLOUD;
}

function hourLabel(iso) {
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return "";
  return when.toLocaleTimeString([], { hour: "numeric" });
}

function dayLabel(iso, index) {
  if (index === 0) return "Today";
  const parts = iso.split("-").map(Number);
  const when = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2], 12));
  return when.toLocaleDateString(undefined, { weekday: "short", timeZone: "UTC" });
}

/** The closed button: icon plus the temperature, like the corner of an iPhone. */
function paintWeatherPill() {
  if (!weatherTemp || !weatherIconBox) return;
  try {
    const cur = weatherReport && weatherReport.current;
    if (!cur) {
      weatherTemp.textContent = "–°";
      weatherIconBox.innerHTML = CLOUD;
      return;
    }
    const degrees = Math.round(cur.temperature_2m);
    const name = weatherName(cur.weather_code);
    weatherTemp.textContent = `${degrees}°`;
    weatherIconBox.innerHTML = weatherIcon(cur.weather_code, cur.is_day);
    if (weatherBtn) {
      weatherBtn.title = name;
      weatherBtn.setAttribute("aria-label", `Weather outside, ${degrees} degrees, ${name}`);
    }
  } catch (err) {
    console.error("Failed while drawing the weather button:", err);
  }
}

function hourlyBlock() {
  const box = wxEl("div", "wx-glass");
  const row = wxEl("div", "wx-hours");
  const times = weatherReport.hourly.time;
  let start = times.findIndex((stamp) => stamp >= weatherReport.current.time);
  if (start < 0) start = 0;
  const end = Math.min(times.length, start + 24);
  for (let i = start; i < end; i += 1) {
    const col = wxEl("div", "wx-hour");
    col.append(wxEl("span", "", hourLabel(times[i])));
    const glyph = wxEl("span", "wx-glyph");
    glyph.innerHTML = weatherIcon(weatherReport.hourly.weather_code[i], weatherReport.hourly.is_day[i]);
    col.append(glyph);
    const chance = weatherReport.hourly.precipitation_probability[i];
    col.append(wxEl("span", "wx-pop", chance >= 20 ? `${chance}%` : ""));
    col.append(wxEl("span", "", `${Math.round(weatherReport.hourly.temperature_2m[i])}°`));
    row.append(col);
  }
  box.append(row);
  return box;
}

function dailyBlock() {
  const box = wxEl("div", "wx-glass");
  const lows = weatherReport.daily.temperature_2m_min;
  const highs = weatherReport.daily.temperature_2m_max;
  const weekMin = Math.min(...lows);
  const weekMax = Math.max(...highs);
  const span = weekMax - weekMin || 1;
  weatherReport.daily.time.forEach((iso, i) => {
    const line = wxEl("div", "wx-day");
    const glyph = wxEl("span", "wx-day-icon");
    glyph.innerHTML = weatherIcon(weatherReport.daily.weather_code[i], 1);
    const track = wxEl("span", "wx-track");
    const fill = wxEl("span", "wx-fill");
    const lo = lows[i];
    const hi = highs[i];
    fill.style.left = `${((lo - weekMin) / span) * 100}%`;
    fill.style.width = `${Math.max(8, ((hi - lo) / span) * 100)}%`;
    track.append(fill);
    line.append(
      wxEl("span", "", dayLabel(iso, i)),
      glyph,
      wxEl("span", "wx-lo", `${Math.round(lo)}°`),
      track,
      wxEl("span", "wx-hi", `${Math.round(hi)}°`),
    );
    box.append(line);
  });
  return box;
}

function factsBlock() {
  const box = wxEl("div", "wx-glass wx-facts");
  const cur = weatherReport.current;
  const facts = [
    ["Feels like", `${Math.round(cur.apparent_temperature)}°`],
    ["Humidity", `${Math.round(cur.relative_humidity_2m)}%`],
    ["Wind", `${Math.round(cur.wind_speed_10m)} km/h`],
  ];
  facts.forEach(([label, value]) => {
    const cell = wxEl("div", "wx-fact");
    cell.append(wxEl("span", "wx-fact-label", label), wxEl("b", "", value));
    box.append(cell);
  });
  return box;
}

/** Fill the open card: big temperature, hours, the week, then feels-like, humidity, and wind. */
function paintWeatherCard() {
  if (!weatherPanel) return;
  try {
    weatherPanel.replaceChildren();
    const cur = weatherReport && weatherReport.current;
    if (!cur) {
      weatherPanel.dataset.sky = "cloudy";
      weatherPanel.append(wxEl("p", "wx-wait", weatherError || "Checking the sky…"));
      return;
    }
    weatherPanel.dataset.sky = skyKey(cur.weather_code, cur.is_day);
    const hero = wxEl("div", "wx-hero");
    hero.append(
      wxEl("p", "wx-city", weatherReport.city || "Outside"),
      wxEl("p", "wx-now", `${Math.round(cur.temperature_2m)}°`),
      wxEl("p", "wx-cond", weatherName(cur.weather_code)),
      wxEl("p", "wx-range", `H:${Math.round(weatherReport.daily.temperature_2m_max[0])}°   L:${Math.round(weatherReport.daily.temperature_2m_min[0])}°`),
    );
    weatherPanel.append(
      hero,
      hourlyBlock(),
      dailyBlock(),
      factsBlock(),
      wxEl("p", "wx-foot", `Outside in ${weatherReport.city}, where this Mac’s clock is set.`),
    );
  } catch (err) {
    console.error("Failed while drawing the weather card:", err);
  }
}

function placeWeatherPanel() {
  placeBarCard(weatherPanel, weatherBtn, 340);
}

function setWeatherOpen(open) {
  if (!weatherPanel || !weatherBtn) return;
  weatherPanel.hidden = !open;
  weatherBtn.setAttribute("aria-expanded", open ? "true" : "false");
  weatherBtn.classList.toggle("is-on", open);
  if (!open) return;
  setFanOpen(false);
  setUsageOpen(false);
  setClockOpen(false);
  paintWeatherCard();
  placeWeatherPanel();
}

async function loadWeather() {
  const here = typeof macPlace === "function" ? macPlace() : null;
  if (!here || here.lat == null) {
    weatherError = "This Mac’s clock has no city, so the outside temperature is blank.";
    paintWeatherPill();
    if (weatherPanel && !weatherPanel.hidden) paintWeatherCard();
    return;
  }
  try {
    const params = new URLSearchParams({
      latitude: String(here.lat),
      longitude: String(here.lon),
      current: "temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m,is_day",
      hourly: "temperature_2m,weather_code,precipitation_probability,is_day",
      daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max",
      timezone: here.timeZone,
      forecast_days: "7",
      wind_speed_unit: "kmh",
    });
    const res = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`);
    if (!res.ok) throw new Error("The weather service replied " + res.status);
    const data = await res.json();
    data.city = here.city;
    data.timeZone = here.timeZone;
    weatherReport = data;
    weatherError = "";
    weatherAt = Date.now();
  } catch (err) {
    console.error("Failed while loading the outside weather:", err);
    if (!weatherReport) weatherError = "The weather could not be loaded.";
  }
  paintWeatherPill();
  if (weatherPanel && !weatherPanel.hidden) paintWeatherCard();
}

if (weatherBtn && weatherPanel) {
  weatherBtn.addEventListener("click", () => {
    const open = weatherPanel.hidden;
    setWeatherOpen(open);
    if (open && Date.now() - weatherAt > 10 * 60 * 1000) loadWeather();
  });
  paintWeatherPill();
  const begin = () => {
    loadWeather();
    setInterval(() => {
      if (document.hidden) return;
      loadWeather();
    }, 10 * 60 * 1000);
  };
  if (typeof zoneCoords !== "undefined" && zoneCoords) begin();
  else document.addEventListener("zones-ready", begin, { once: true });
}
