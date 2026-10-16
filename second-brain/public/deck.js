// Full-screen presenter for decks the brain makes (second-brain/deck.js).
// Slides are drawn in the same 960 × 540 point layout DeckCraft uses for the .pptx,
// and move by the same rules (deck-motion.js), played with the Web Animations API.
// Live mode: every sentence heard while presenting becomes a slide. A draft slide with
// the spoken words shows at once; the finished slide morphs out of it when it arrives.
import { EASE_MOVE, EASE_OUT, STAGGER_MS, motionFor } from "/deck-motion.js";

const W = 960;
const H = 540;
const FALLBACK_THEME = {
  name: "Nocturne", heading: "Inter", body: "Inter",
  text: "#FFFFFF", bg: "#121826", muted: "#F2F4F8", surface: "#1E2638",
  accents: ["#7C5CFF", "#00C2A8", "#FFB547", "#FF5C7A", "#4CC9F0", "#9AA4B8"],
};

let themes = null;
const show = {
  root: null, stage: null, slideEl: null, hud: null, statusEl: null, heardEl: null, notesEl: null,
  id: "", deck: null, index: 0, pending: [], live: false, busy: false, queue: [], draft: false,
  blank: false, hideTimer: 0, token: 0,
};

const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
};

async function loadThemes() {
  if (themes) return themes;
  try {
    const response = await fetch("/deck/themes");
    const data = await response.json();
    themes = data.themes?.length ? data.themes : [FALLBACK_THEME];
  } catch {
    themes = [FALLBACK_THEME];
  }
  return themes;
}

function themeOf(deck) {
  return (themes || []).find((t) => t.name === deck?.theme) || themes?.find((t) => t.name === "Nocturne") || FALLBACK_THEME;
}

const loadedFonts = new Set();
/** DeckCraft's theme fonts are Google Fonts; load the pair the deck uses. */
function loadFonts(theme) {
  for (const family of [theme.heading, theme.body]) {
    if (!family || loadedFonts.has(family) || /Carlito|Liberation/.test(family)) continue;
    loadedFonts.add(family);
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family)}:wght@400;600;700&display=swap`;
    document.head.append(link);
  }
}

function applyTheme(theme) {
  const s = show.root.style;
  s.setProperty("--d-bg", theme.bg);
  s.setProperty("--d-text", theme.text);
  s.setProperty("--d-muted", theme.muted);
  s.setProperty("--d-accent", theme.accents[0]);
  s.setProperty("--d-accent2", theme.accents[1]);
  s.setProperty("--d-head", `"${theme.heading}", "Inter", -apple-system, "Helvetica Neue", sans-serif`);
  s.setProperty("--d-body", `"${theme.body}", "Inter", -apple-system, "Helvetica Neue", sans-serif`);
  loadFonts(theme);
}

// ---------- drawing slides (positions match deckcraft.js) ----------

function box(cls, part, rect, text) {
  const node = el("div", `d-box ${cls}`);
  if (part) node.dataset.part = part;
  const [x, y, w, h] = rect;
  Object.assign(node.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px` });
  if (text != null) {
    const span = el("span", "d-t", text);
    span.dir = "auto";
    node.append(span);
  }
  return node;
}

function bar(rect) {
  return box("d-bar", "bar", rect);
}

function list(part, rect, items, cls = "") {
  const node = box(`d-list ${cls}`, part, rect);
  const ul = el("ul");
  for (const item of items || []) {
    const li = el("li", "", item);
    li.dir = "auto";
    ul.append(li);
  }
  node.append(ul);
  return node;
}

/** Chart as SVG, grown by the builds: bars rise, lines draw on, slices sweep in. */
function chartSvg(chart, theme) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 800 350");
  svg.classList.add("d-chart");
  const add = (tag, attrs, parent = svg) => {
    const node = document.createElementNS(ns, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    parent.append(node);
    return node;
  };
  const series = chart.series || [];
  const cats = chart.categories || [];
  const colors = theme.accents;
  if (chart.type === "pie" || chart.type === "doughnut") {
    const values = (series[0]?.values || []).map((v) => Math.max(0, v));
    const total = values.reduce((a, b) => a + b, 0) || 1;
    let angle = -Math.PI / 2;
    const cx = 400; const cy = 165; const r = 150;
    values.forEach((v, i) => {
      const sweep = (v / total) * Math.PI * 2;
      const a2 = angle + sweep;
      const large = sweep > Math.PI ? 1 : 0;
      const p = (a) => `${cx + r * Math.cos(a)} ${cy + r * Math.sin(a)}`;
      const path = add("path", { d: `M ${cx} ${cy} L ${p(angle)} A ${r} ${r} 0 ${large} 1 ${p(a2)} Z`, fill: colors[i % colors.length], class: "d-grow d-slice" });
      path.style.transformOrigin = `${cx}px ${cy}px`;
      const mid = angle + sweep / 2;
      const label = add("text", { x: cx + (r + 26) * Math.cos(mid), y: cy + (r + 26) * Math.sin(mid) + 5, "text-anchor": Math.cos(mid) >= 0 ? "start" : "end", class: "d-label" });
      label.textContent = `${cats[i] ?? ""} ${Math.round((v / total) * 100)}%`;
      angle = a2;
    });
    if (chart.type === "doughnut") add("circle", { cx, cy, r: 78, fill: theme.bg });
    return svg;
  }
  const all = series.flatMap((s) => s.values);
  const max = Math.max(1, ...all);
  const left = 20; const right = 780; const top = 20; const base = 310;
  const step = (right - left) / Math.max(1, cats.length);
  add("line", { x1: left, x2: right, y1: base, y2: base, class: "d-axis" });
  cats.forEach((c, i) => {
    const t = add("text", { x: left + step * (i + 0.5), y: base + 28, "text-anchor": "middle", class: "d-label" });
    t.textContent = c;
  });
  const y = (v) => base - (Math.max(0, v) / max) * (base - top);
  if (chart.type === "line" || chart.type === "area") {
    series.forEach((s, k) => {
      const pts = s.values.map((v, i) => `${left + step * (i + 0.5)},${y(v)}`);
      if (chart.type === "area") {
        const area = add("polygon", { points: `${left + step * 0.5},${base} ${pts.join(" ")} ${left + step * (s.values.length - 0.5)},${base}`, fill: colors[k % colors.length], opacity: 0.25, class: "d-grow" });
        area.style.transformOrigin = `0 ${base}px`;
      }
      add("polyline", { points: pts.join(" "), fill: "none", stroke: colors[k % colors.length], "stroke-width": 5, "stroke-linecap": "round", "stroke-linejoin": "round", class: "d-draw" });
      s.values.forEach((v, i) => {
        const t = add("text", { x: left + step * (i + 0.5), y: y(v) - 14, "text-anchor": "middle", class: "d-label d-value" });
        t.textContent = String(v);
      });
    });
    return svg;
  }
  const horizontal = chart.type === "bar";
  const groupW = step * 0.7;
  const barW = groupW / Math.max(1, series.length);
  if (horizontal) {
    // Horizontal bars: categories down the left, bars to the right.
    svg.innerHTML = "";
    const rowH = (base - top) / Math.max(1, cats.length);
    cats.forEach((c, i) => {
      const t = add("text", { x: 150, y: top + rowH * (i + 0.5) + 6, "text-anchor": "end", class: "d-label" });
      t.textContent = c;
      series.forEach((s, k) => {
        const v = Math.max(0, s.values[i] || 0);
        const h = (rowH * 0.7) / series.length;
        const yy = top + rowH * i + rowH * 0.15 + h * k;
        const w = (v / max) * 560;
        const rect = add("rect", { x: 165, y: yy, width: w, height: h - 4, rx: 4, fill: colors[k % colors.length], class: "d-grow d-hbar" });
        rect.style.transformOrigin = `165px ${yy}px`;
        const label = add("text", { x: 175 + w, y: yy + h / 2 + 4, class: "d-label d-value" });
        label.textContent = String(s.values[i] ?? "");
      });
    });
    return svg;
  }
  cats.forEach((_, i) => {
    series.forEach((s, k) => {
      const v = s.values[i] || 0;
      const x = left + step * i + (step - groupW) / 2 + barW * k;
      const rect = add("rect", { x: x + 3, y: y(v), width: barW - 6, height: base - y(v), rx: 4, fill: colors[k % colors.length], class: "d-grow d-vbar" });
      rect.style.transformOrigin = `0 ${base}px`;
      const t = add("text", { x: x + barW / 2, y: y(v) - 10, "text-anchor": "middle", class: "d-label d-value" });
      t.textContent = String(v);
    });
  });
  if (series.length > 1) {
    series.forEach((s, k) => {
      const lx = left + k * 160;
      add("rect", { x: lx, y: 336, width: 12, height: 12, rx: 2, fill: colors[k % colors.length] });
      const t = add("text", { x: lx + 18, y: 347, class: "d-label" });
      t.textContent = s.name;
    });
  }
  return svg;
}

function renderSlide(slide, theme, draft = false) {
  const node = el("div", `d-slide d-${slide.kind}${draft ? " d-draft" : ""}`);
  const kind = slide.kind;
  if (kind === "title" || kind === "closing") {
    node.append(
      box("d-title d-hero d-bottom d-center", "title", [120, 88, 720, 188], slide.title),
      bar([440, 288, 80, 6]),
      box("d-sub d-center", "body", [120, 304, 720, 120], slide.subtitle || ""),
    );
  } else if (kind === "section") {
    node.append(
      box("d-title d-section-t d-bottom", "title", [65, 135, 830, 225], slide.title),
      bar([72, 372, 72, 6]),
      box("d-sub", "body", [65, 388, 830, 100], slide.subtitle || ""),
    );
  } else if (kind === "quote") {
    const q = String(slide.quote || "").replace(/^["“]|["”]$/g, "");
    node.append(
      box("d-quote d-center", "quote", [100, 130, 760, 220], `“${q}”`),
      box("d-by d-center", "by", [100, 370, 760, 50], slide.by ? `— ${slide.by}` : ""),
    );
  } else {
    node.append(box("d-title d-mid", "title", [60, 29, 840, 104], slide.title || ""), bar([67, 135, 72, 6]));
    if (draft) {
      const lines = box("d-shimmer", "", [67, 170, 700, 200]);
      for (let i = 0; i < 3; i += 1) lines.append(el("i"));
      node.append(lines);
    } else if (kind === "bullets") {
      node.append(list("body", [60, 144, 840, 343], slide.bullets));
    } else if (kind === "twoColumn") {
      for (const [side, x] of [["left", 60], ["right", 488]]) {
        node.append(
          box(`d-head d-bottom d-${side}`, `${side}Head`, [x, 133, 412, 62], slide[side]?.heading || ""),
          list(side, [x, 198, 412, 289], slide[side]?.bullets, "d-small"),
        );
      }
    } else if (kind === "stat") {
      node.append(
        box("d-stat d-center d-mid", "value", [60, 160, 840, 170], slide.value || ""),
        box("d-label-t d-center", "label", [100, 340, 760, 80], slide.label || ""),
      );
    } else if (kind === "chart" && slide.chart) {
      const holder = box("d-chartbox", "chart", [80, 150, 800, 350]);
      holder.append(chartSvg(slide.chart, theme));
      node.append(holder);
    }
  }
  if (draft) node.append(box("d-draft-tag", "", [60, 490, 840, 30], "Making the slide…"));
  return node;
}

// ---------- motion ----------

function keyframes(effect, option) {
  if (effect === "fly") {
    const from = { b: "translateY(70px)", t: "translateY(-70px)", l: "translateX(-90px)", r: "translateX(90px)" }[option || "b"] || "translateY(70px)";
    return [{ opacity: 0, transform: from }, { opacity: 1, transform: "none" }];
  }
  if (effect === "wipe") {
    const from = { l: "inset(0 100% 0 0)", r: "inset(0 0 0 100%)", b: "inset(100% 0 0 0)", t: "inset(0 0 100% 0)" }[option || "l"] || "inset(0 100% 0 0)";
    return [{ opacity: 1, clipPath: from }, { opacity: 1, clipPath: "inset(0 0 0 0)" }];
  }
  if (effect === "zoom") return [{ opacity: 0, transform: "scale(0.6)" }, { opacity: 1, transform: "none" }];
  return [{ opacity: 0 }, { opacity: 1 }];
}

/** A number like "87%" or "$1.2M" counts up from zero while it zooms in. */
function countUp(node, duration, begin) {
  const span = node.querySelector(".d-t");
  const match = span?.textContent.match(/^([^\d-]*)(-?[\d,]*\.?\d+)(.*)$/);
  if (!match) return;
  const [, pre, num, post] = match;
  const target = Number(num.replace(/,/g, ""));
  if (!Number.isFinite(target)) return;
  const decimals = (num.split(".")[1] || "").length;
  const token = show.token;
  const start = performance.now() + begin;
  const total = duration + 500;
  const tick = (now) => {
    if (token !== show.token) return;
    const p = Math.min(1, Math.max(0, (now - start) / total));
    const eased = 1 - (1 - p) ** 3;
    span.textContent = `${pre}${(target * eased).toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}${post}`;
    if (p < 1) requestAnimationFrame(tick);
  };
  span.textContent = `${pre}0${post}`;
  requestAnimationFrame(tick);
}

function play(action) {
  const { node, effect, option, duration, begin } = action;
  node.animate(keyframes(effect, option), { duration, delay: begin, easing: EASE_OUT, fill: "both" });
  if (node.dataset.part === "value") countUp(node, duration, begin);
  // Charts grow inside their box: bars rise, lines draw on, slices sweep in.
  if (node.dataset.part === "chart") {
    node.querySelectorAll(".d-vbar, .d-grow:not(.d-hbar):not(.d-slice)").forEach((g, i) => {
      g.animate([{ transform: "scaleY(0)" }, { transform: "scaleY(1)" }], { duration: 700, delay: begin + 150 + i * STAGGER_MS, easing: EASE_OUT, fill: "both" });
    });
    node.querySelectorAll(".d-hbar").forEach((g, i) => {
      g.animate([{ transform: "scaleX(0)" }, { transform: "scaleX(1)" }], { duration: 700, delay: begin + 150 + i * STAGGER_MS, easing: EASE_OUT, fill: "both" });
    });
    node.querySelectorAll(".d-slice").forEach((g, i) => {
      g.animate([{ opacity: 0, transform: "scale(0.85)" }, { opacity: 1, transform: "none" }], { duration: 500, delay: begin + 150 + i * STAGGER_MS, easing: EASE_OUT, fill: "both" });
    });
    node.querySelectorAll(".d-draw").forEach((line) => {
      const length = line.getTotalLength?.() || 1000;
      line.style.strokeDasharray = String(length);
      line.animate([{ strokeDashoffset: length }, { strokeDashoffset: 0 }], { duration: 1100, delay: begin + 150, easing: EASE_MOVE, fill: "both" });
    });
    node.querySelectorAll(".d-value").forEach((t, i) => {
      t.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 300, delay: begin + 700 + i * 60, fill: "both" });
    });
  }
}

/**
 * Turn the slide's builds into actions: entry (plays by itself, after offset ms) and
 * clicks (one group per click). auto plays the click builds too, one after another.
 */
function prepareBuilds(slideEl, plan, offset, auto) {
  const entry = [];
  const clicks = [];
  let prevStart = offset;
  let prevEnd = offset;
  for (const build of plan.builds) {
    const node = slideEl.querySelector(`[data-part="${build.part}"]`);
    if (!node || (!node.textContent.trim() && build.part !== "chart" && build.part !== "bar")) continue;
    const targets = build.byParagraph ? [...node.querySelectorAll("li")] : [node];
    for (const target of targets) target.style.opacity = "0";
    if (build.start === "onClick" && !auto) {
      for (const target of targets) clicks.push([{ node: target, effect: build.effect, option: build.option, duration: build.duration, begin: 0 }]);
      continue;
    }
    // In live mode a click build plays by itself; its paragraphs follow each other closely.
    const first = build.start === "withPrevious" ? prevStart + (build.delay || 0) : prevEnd + (build.delay || 0);
    targets.forEach((target, k) => {
      const begin = Math.max(offset, first + k * STAGGER_MS);
      entry.push({ node: target, effect: build.effect, option: build.option, duration: build.duration, begin });
      prevStart = begin;
      prevEnd = Math.max(prevEnd, begin + build.duration);
    });
  }
  return { entry, clicks };
}

function rectIn(node) {
  const k = scale();
  const stage = show.stage.getBoundingClientRect();
  const r = node.getBoundingClientRect();
  return { x: (r.left - stage.left) / k, y: (r.top - stage.top) / k, w: r.width / k, h: r.height / k };
}

/** Morph: the new title glides and resizes from where the old one was. */
function morphTitle(oldEl, newEl, duration) {
  const a = oldEl.querySelector('[data-part="title"] .d-t');
  const b = newEl.querySelector('[data-part="title"] .d-t');
  if (!a || !b || !a.textContent.trim()) return false;
  const ra = rectIn(a);
  const rb = rectIn(b);
  const sa = parseFloat(getComputedStyle(a).fontSize);
  const sb = parseFloat(getComputedStyle(b).fontSize);
  const s = sa / sb;
  b.style.display = "inline-block";
  b.style.transformOrigin = "0 0";
  b.animate([
    { transform: `translate(${ra.x - rb.x}px, ${ra.y - rb.y}px) scale(${s})` },
    { transform: "none" },
  ], { duration, easing: EASE_MOVE, fill: "both" });
  // The title is the one thing that does not fade.
  b.closest(".d-box").style.opacity = "1";
  return true;
}

function transition(oldEl, newEl, plan, back, morph) {
  const t = morph ? { kind: "morph", duration: 900 } : back ? { kind: "fade", duration: 300 } : plan.transition || { kind: "fade", duration: 600 };
  const d = t.duration || 600;
  if (!oldEl) {
    newEl.animate([{ opacity: 0 }, { opacity: 1 }], { duration: d, easing: EASE_OUT, fill: "both" });
    return d;
  }
  const out = (frames, duration) => oldEl.animate(frames, { duration, easing: EASE_MOVE, fill: "both" });
  if (t.kind === "push") {
    const axis = t.option === "u" || t.option === "d" ? "Y" : "X";
    const sign = t.option === "d" || t.option === "r" ? -1 : 1;
    out([{ transform: "none" }, { transform: `translate${axis}(${-100 * sign}%)` }], d);
    newEl.animate([{ transform: `translate${axis}(${100 * sign}%)` }, { transform: "none" }], { duration: d, easing: EASE_MOVE, fill: "both" });
  } else if (t.kind === "morph") {
    // Everything but the title crossfades; the title moves.
    oldEl.querySelectorAll('.d-box:not([data-part="title"])').forEach((n) => n.animate([{ opacity: 1 }, { opacity: 0 }], { duration: d * 0.35, fill: "both" }));
    oldEl.querySelector('[data-part="title"]')?.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 120, fill: "both" });
    newEl.style.background = "transparent";
    morphTitle(oldEl, newEl, d);
  } else {
    // Exits are quicker than entrances: the old slide is gone at 60% of the time.
    out([{ opacity: 1 }, { opacity: 0 }], d * 0.6);
    newEl.animate([{ opacity: 0 }, { opacity: 1 }], { duration: d, easing: EASE_OUT, fill: "both" });
  }
  setTimeout(() => oldEl.remove(), d + 50);
  return t.kind === "morph" ? d * 0.75 : d * 0.6;
}

function scale() {
  return show.stage ? show.stage.clientWidth / W : 1;
}

function fit() {
  if (!show.root) return;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const w = Math.min(vw, (vh * W) / H);
  Object.assign(show.stage.style, { width: `${w}px`, height: `${(w * H) / W}px` });
  show.root.style.setProperty("--k", String(w / W));
}

/** Show slide index. back: going backwards shows it whole with a quick fade. */
function go(index, { back = false, draftSlide = null, morph = false } = {}) {
  const deck = show.deck;
  if (!deck) return;
  const slide = draftSlide || deck.slides[index];
  if (!slide) return;
  show.token += 1;
  if (!draftSlide) show.index = index;
  show.draft = Boolean(draftSlide);
  const theme = themeOf(deck);
  const view = { ...deck, slides: draftSlide ? [...deck.slides.slice(0, index), draftSlide] : deck.slides };
  const plan = motionFor(view, index);
  const newEl = renderSlide(slide, theme, Boolean(draftSlide));
  const oldEl = show.slideEl;
  show.stage.append(newEl);
  show.slideEl = newEl;
  const offset = transition(oldEl, newEl, plan, back, morph);
  if (back || draftSlide) {
    show.pending = [];
  } else {
    const { entry, clicks } = prepareBuilds(newEl, plan, offset, show.live);
    entry.forEach(play);
    show.pending = clicks;
  }
  updateHud();
}

function next() {
  if (show.pending.length) {
    show.pending.shift().forEach(play);
    return;
  }
  if (show.index < show.deck.slides.length - 1) go(show.index + 1);
}

function prev() {
  if (show.index > 0) go(show.index - 1, { back: true });
}

// ---------- heads-up display ----------

function button(label, title, action, cls = "") {
  const node = el("button", `d-btn ${cls}`, label);
  node.type = "button";
  node.title = title;
  node.addEventListener("click", (event) => {
    event.stopPropagation();
    action(node);
  });
  return node;
}

function updateHud() {
  if (!show.hud) return;
  show.hud.querySelector(".d-count").textContent = `${show.index + 1} / ${show.deck.slides.length}`;
  show.root.classList.toggle("d-live", show.live);
  show.hud.querySelector(".d-livebtn").textContent = show.live ? "● Live" : "Live";
  const mic = show.hud.querySelector(".d-micbtn");
  mic.textContent = micOn() ? "Mic on" : "Mic off";
  mic.classList.toggle("d-on", micOn());
  const slide = show.deck.slides[show.index];
  show.notesEl.textContent = slide?.notes || "";
  if (!show.busy) {
    setStatus(!show.live ? "" : micOn() ? "Live: say what the next slide is about" : "Mic is off: click Mic or press M");
  }
}

function setStatus(text) {
  if (show.statusEl) show.statusEl.textContent = text;
}

function wake() {
  show.root?.classList.remove("d-idle");
  clearTimeout(show.hideTimer);
  show.hideTimer = setTimeout(() => show.root?.classList.add("d-idle"), 2500);
}

async function savePptx(pick, node) {
  const was = node.textContent;
  node.disabled = true;
  node.textContent = pick ? "Choose a folder…" : "Building…";
  try {
    const response = await fetch(`/deck/${encodeURIComponent(show.id)}/save`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pick }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not save.");
    setStatus(data.path ? `Saved: ${data.path}` : "");
  } catch (err) {
    setStatus(err.message || "Could not save the PowerPoint file.");
  } finally {
    node.disabled = false;
    node.textContent = was;
  }
}

function openPptx() {
  fetch(`/deck/${encodeURIComponent(show.id)}/open`, { method: "POST" }).catch(() => {});
  setStatus("Opening in PowerPoint…");
}

/** voice.js's call state (globals of a classic script). Live mode needs the mic listening. */
function micOn() {
  return typeof connected !== "undefined" && connected && !(typeof muted !== "undefined" && muted) && !(typeof paused !== "undefined" && paused);
}

/** Start the call (the Start talking button) if it is off, so dictation is heard. */
function ensureMic() {
  if (typeof connected !== "undefined" && !connected) document.getElementById("talkBtn")?.click();
}

/** The presenter's own mic button: the same as Start talking / Stop under the deck. */
function toggleMic() {
  if (typeof connected !== "undefined" && connected && typeof muted !== "undefined" && muted) document.getElementById("muteBtn")?.click();
  else document.getElementById("talkBtn")?.click();
  setTimeout(updateHud, 1500);
}

function setLive(on) {
  show.live = on;
  if (on) ensureMic();
  updateHud();
}

function onKey(event) {
  if (!show.root) return;
  const key = event.key;
  if (["ArrowRight", "ArrowDown", "PageDown", " ", "Enter"].includes(key)) next();
  else if (["ArrowLeft", "ArrowUp", "PageUp", "Backspace"].includes(key)) prev();
  else if (key === "Home") go(0, { back: true });
  else if (key === "End") go(show.deck.slides.length - 1, { back: true });
  else if (key === "Escape") close();
  else if (key === "b" || key === "B" || key === ".") toggleBlank();
  else if (key === "l" || key === "L") setLive(!show.live);
  else if (key === "m" || key === "M") toggleMic();
  else if (key === "n" || key === "N") show.root.classList.toggle("d-notes-on");
  else return;
  event.preventDefault();
  event.stopPropagation();
  wake();
}

function toggleBlank() {
  show.blank = !show.blank;
  show.root.classList.toggle("d-blank", show.blank);
}

function buildRoot() {
  const root = el("div", "deckshow");
  const stage = el("div", "d-stage");
  const hud = el("div", "d-hud");
  const status = el("span", "d-status");
  const heard = el("div", "d-heard");
  const notes = el("div", "d-notes");
  hud.append(
    button("‹", "Previous slide (←)", prev),
    el("span", "d-count"),
    button("›", "Next (→ or Space)", next),
    button("Mic off", "Start or stop listening (M)", toggleMic, "d-micbtn"),
    button("Live", "Live: every sentence you say becomes a slide (L)", () => setLive(!show.live), "d-livebtn"),
    status,
    el("span", "d-gap"),
    button("PowerPoint", "Save the .pptx in Downloads", (node) => savePptx(false, node)),
    button("Save to…", "Choose where to save the .pptx", (node) => savePptx(true, node)),
    button("Open", "Open in PowerPoint or Keynote", openPptx),
    button("Notes", "Speaker notes (N)", () => show.root.classList.toggle("d-notes-on")),
    button("✕", "End the show (Esc)", close, "d-close"),
  );
  root.append(stage, heard, notes, hud);
  root.addEventListener("click", (event) => {
    if (event.target.closest(".d-hud")) return;
    next();
  });
  root.addEventListener("pointermove", wake, { passive: true });
  Object.assign(show, { root, stage, hud, statusEl: status, heardEl: heard, notesEl: notes });
  document.body.append(root);
  window.addEventListener("resize", fit);
  document.addEventListener("keydown", onKey, true);
  fit();
  wake();
}

function fullscreen(on) {
  if (window.ipc?.postMessage) {
    window.ipc.postMessage(on ? "fullscreen-on" : "fullscreen-off");
    return;
  }
  if (on) document.documentElement.requestFullscreen?.().catch(() => {});
  else if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
}

/** Open deck id full screen. */
async function present(id, { live = false, index = 0 } = {}) {
  const response = await fetch(`/deck/${encodeURIComponent(id)}`);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "That deck is gone.");
  await loadThemes();
  if (!show.root) buildRoot();
  show.id = id;
  show.deck = data.deck;
  show.live = live;
  show.queue = [];
  localStorage.setItem("lastDeck", id);
  applyTheme(themeOf(show.deck));
  fullscreen(true);
  show.slideEl?.remove();
  show.slideEl = null;
  // Wait a frame so the stage has its full-screen size before measuring anything.
  await new Promise((resolve) => requestAnimationFrame(() => { fit(); resolve(); }));
  go(Math.min(index, show.deck.slides.length - 1));
  if (live) {
    ensureMic();
    // The call takes a moment to start; say so if it still is not listening.
    setTimeout(updateHud, 3000);
  }
}

function close() {
  if (!show.root) return;
  show.token += 1;
  document.removeEventListener("keydown", onKey, true);
  window.removeEventListener("resize", fit);
  show.root.remove();
  Object.assign(show, { root: null, stage: null, slideEl: null, hud: null, live: false, busy: false, queue: [], pending: [] });
  fullscreen(false);
}

/** A new live deck titled from the topic, opened full screen in live mode. */
async function startLive(topic) {
  const title = String(topic || "").replace(/[.?!]+$/, "").trim();
  const response = await fetch("/deck/new", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: title ? title[0].toUpperCase() + title.slice(1) : "Live presentation" }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Could not start a deck.");
  await present(data.id, { live: true });
}

// ---------- voice ----------

const NUMBERS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };

/** Spoken navigation that needs no model. Returns true when handled. */
function navigate(said) {
  const s = said.toLowerCase().replace(/[.,!?]+/g, " ").replace(/\s+/g, " ").trim();
  if (/^(next|next slide|forward|go on|continue|go ahead)( please)?$/.test(s)) next();
  else if (/^(back|go back|previous|previous slide|back one|last one)( please)?$/.test(s)) prev();
  else if (/^(first slide|go to the start|start again|from the top)$/.test(s)) go(0, { back: true });
  else if (/^(last slide|go to the end)$/.test(s)) go(show.deck.slides.length - 1, { back: true });
  else if (/^(?:go to |show )?slide (\d+|\w+)$/.test(s)) {
    const word = s.match(/slide (\d+|\w+)$/)[1];
    const n = Number(word) || NUMBERS[word];
    if (!n) return false;
    go(Math.max(0, Math.min(show.deck.slides.length - 1, n - 1)), { back: true });
  } else if (/\b(end|stop|exit|close|finish)( the)? (show|presentation|slides|slideshow)\b/.test(s)) close();
  else if (/\b(stop|pause|end) (live|listening)\b|\blive (off|mode off)\b/.test(s)) setLive(false);
  else if (/^(go live|start live|live mode|live on)$/.test(s)) setLive(true);
  else if (/^(blank|black)( the)?( screen)?$/.test(s)) toggleBlank();
  else return false;
  return true;
}

function showHeard(said) {
  show.heardEl.textContent = said;
  show.heardEl.animate([{ opacity: 0, transform: "translateY(8px)" }, { opacity: 1, transform: "none" }], { duration: 300, easing: EASE_OUT, fill: "both" });
}

/** The draft title: the first words they said, until the real slide arrives. */
function draftTitle(said) {
  const words = said.replace(/^(and|so|then|now|next|okay|ok)[, ]+/i, "").split(/\s+/);
  return words.slice(0, 8).join(" ") + (words.length > 8 ? "…" : "");
}

async function liveSlide(said) {
  show.busy = true;
  const from = show.index;
  setStatus("Making the slide…");
  go(from + 1, { draftSlide: { kind: "bullets", title: draftTitle(said) } });
  try {
    const response = await fetch(`/deck/${encodeURIComponent(show.id)}/live`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ said, current: from, model: window.selectedModel?.()?.id || "" }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not make that slide.");
    if (!show.root) return;
    show.deck = data.deck;
    applyTheme(themeOf(show.deck));
    show.busy = false;
    if (data.action === "none") {
      go(from, { back: true });
      setStatus(data.say || "");
    } else {
      // From the draft into the real slide: the title glides into place.
      const made = data.action === "add" || data.action === "edit";
      go(data.index, { back: !made, morph: made });
    }
  } catch (err) {
    show.busy = false;
    if (!show.root) return;
    go(from, { back: true });
    setStatus(err.message || "Could not make that slide.");
  }
}

async function drain() {
  if (show.busy) return;
  while (show.queue.length && show.root) await liveSlide(show.queue.shift());
  // The caption was only there while the slide was being made.
  show.heardEl?.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 600, delay: 1200, fill: "both" });
}

/**
 * A sentence the page heard while the deck is open. Navigation works always;
 * in live mode anything else becomes a slide. Returns true when it was for the deck.
 */
function hear(text) {
  if (!show.root) return false;
  const said = String(text || "").replace(/^(hey|okay|ok)[, ]+/i, "").trim();
  if (!said) return true;
  wake();
  if (navigate(said)) return true;
  if (!show.live) return true;
  // Noise and one-word mumbles are not slides.
  if (said.split(/\s+/).length < 3) return true;
  showHeard(said);
  show.queue.push(said);
  drain();
  return true;
}

/**
 * Typed or spoken requests in the main chat that open a deck:
 * "start a live presentation about our Q3 results", "present it".
 */
function command(question) {
  const q = String(question || "").trim();
  const live = q.match(/\b(?:start|begin|open|make|create|do|let'?s do|let us do)\b.*?\blive (?:presentation|deck|slides?|slide ?show)\b(?:\s+(?:about|on|for|called|titled)\s+(.+))?/i);
  if (live) {
    startLive(live[1] || "").catch((err) => console.error("Failed while starting a live deck:", err));
    return true;
  }
  const last = localStorage.getItem("lastDeck");
  if (last && /^(?:please )?(?:present|show|play|start|open)\s+(?:it|this|that|the (?:deck|presentation|slides|slide ?show))(?: (?:full ?screen|now))?[.!]?$/i.test(q)) {
    present(last).catch((err) => console.error("Failed while opening the deck:", err));
    return true;
  }
  return false;
}

/** The card under the brain's answer: a preview of the first slide and its buttons. */
function attach(bubble, event) {
  if (!bubble || bubble.querySelector(".deck-card")) return;
  localStorage.setItem("lastDeck", event.id);
  const card = el("div", "deck-card");
  const thumb = el("div", "deck-thumb");
  const meta = el("div", "deck-meta");
  meta.append(el("strong", "", event.title || "Presentation"), el("span", "", `${event.slides || ""} slides`));
  const row = el("div", "minutes-actions");
  const status = el("span", "minutes-saved");
  const ghost = (label, title, action) => {
    const b = el("button", "ghost-btn small", label);
    b.type = "button";
    b.title = title;
    b.addEventListener("click", () => action(b));
    return b;
  };
  const save = async (pick, b) => {
    b.disabled = true;
    status.textContent = pick ? "Choose a folder…" : "Building the PowerPoint…";
    try {
      const response = await fetch(`/deck/${encodeURIComponent(event.id)}/save`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pick }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not save.");
      status.textContent = data.path ? `Saved: ${data.path}` : "";
    } catch (err) {
      status.textContent = err.message || "Could not save the PowerPoint file.";
    } finally {
      b.disabled = false;
    }
  };
  row.append(
    ghost("▶ Present", "Full screen (Esc ends)", () => present(event.id).catch((err) => { status.textContent = err.message; })),
    ghost("Present live", "Full screen; every sentence you say adds a slide", () => present(event.id, { live: true }).catch((err) => { status.textContent = err.message; })),
    ghost("PowerPoint", "Save the .pptx in Downloads", (b) => save(false, b)),
    ghost("Save to…", "Choose where to save the .pptx", (b) => save(true, b)),
    ghost("Open", "Open in PowerPoint or Keynote", () => fetch(`/deck/${encodeURIComponent(event.id)}/open`, { method: "POST" }).catch(() => {})),
    status,
  );
  card.append(thumb, meta);
  bubble.append(card, row);
  thumb.addEventListener("click", () => present(event.id).catch(() => {}));
  // A still preview of the first slide, drawn by the same renderer.
  Promise.all([loadThemes(), fetch(`/deck/${encodeURIComponent(event.id)}`).then((r) => r.json())]).then(([, data]) => {
    if (!data.deck) return;
    const theme = themeOf(data.deck);
    loadFonts(theme);
    const slide = renderSlide(data.deck.slides[0], theme);
    for (const [k, v] of Object.entries({ "--d-bg": theme.bg, "--d-text": theme.text, "--d-muted": theme.muted, "--d-accent": theme.accents[0], "--d-accent2": theme.accents[1], "--d-head": `"${theme.heading}", "Inter", sans-serif`, "--d-body": `"${theme.body}", "Inter", sans-serif` })) thumb.style.setProperty(k, v);
    thumb.append(slide);
  }).catch(() => {});
}

window.brainDeck = {
  get open() { return Boolean(show.root); },
  get live() { return Boolean(show.root && show.live); },
  present,
  startLive,
  hear,
  command,
  attach,
  close,
};
