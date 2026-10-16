// Presentations the brain makes. The model writes DECK_BODY on its own line, then one
// JSON deck spec; the server saves it, DeckCraft (deckcraft.js) turns it into a .pptx
// with native motion, and the page presents it full screen (public/deck.js).
// Live mode: each sentence the user says while presenting becomes a slide, or edits one.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DECKCRAFT_BIN, buildPptx, deckThemes } from "./deckcraft.js";
import { askModelOnce, clientError } from "./models.js";
import { getModel } from "./pricing.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DECK_DIR = path.join(__dirname, "decks");
const ID = /^[0-9]{4}-[0-9]{2}-[0-9]{2}-[0-9a-f]{8}$/;
const KINDS = ["title", "bullets", "section", "twoColumn", "stat", "quote", "chart", "closing"];
const CHARTS = ["column", "bar", "line", "pie", "doughnut", "area"];
const THEMES = ["DeckCraft", "Harbor", "Ember", "Meadow", "Nocturne", "Paper", "Coral Reef", "Slate"];
const MAX_SLIDES = 40;

// The slide format, shared by the /ask ability and live mode.
const SLIDE_FORMAT = [
  "Each slide is one JSON object with a kind:",
  '{"kind":"title","title":"…","subtitle":"…"} opens the deck;',
  '{"kind":"bullets","title":"…","bullets":["…","…"]};',
  '{"kind":"section","title":"…","subtitle":"…"} starts a part;',
  '{"kind":"twoColumn","title":"…","left":{"heading":"…","bullets":["…"]},"right":{"heading":"…","bullets":["…"]}} compares two things;',
  '{"kind":"stat","title":"…","value":"87%","label":"…"} shows one key number;',
  '{"kind":"quote","quote":"…","by":"…"} only for a real quote;',
  `{"kind":"chart","title":"…","chart":{"type":"column|bar|line|pie|doughnut|area","categories":["…"],"series":[{"name":"…","values":[1,2]}]}} only with real numbers;`,
  '{"kind":"closing","title":"…","subtitle":"…"} ends it.',
  'Any slide may have "notes": what the speaker says, two or three sentences.',
].join(" ");

// Content rules from the motion and slide skills. Motion itself is added by code.
const SLIDE_RULES = [
  "One idea per slide. The title is a short headline that states the point, at most seven words.",
  "At most five bullets, each at most nine words, no full stops at the end.",
  "Use a stat slide when one number carries the point, a chart only for numbers the user said or the notes give, and never invent numbers, quotes, people or dates.",
  "Write the slides in the language the user speaks.",
].join(" ");

export const DECK_ABILITY = [
  "You can make a presentation: slides, a deck, a PowerPoint. Do it when the user asks for slides, a presentation, a deck, or a PowerPoint. Never say you cannot make slides or files.",
  "To make one: say one or two short spoken sentences about the deck. Then put DECK_BODY on its own line. Then write one JSON object and nothing after it:",
  '{"title":"…","theme":"Nocturne","mood":"calm","slides":[…]}.',
  `theme is one of ${THEMES.join(", ")}: Nocturne is dark, Paper is plain and light, Harbor and Slate suit work talks, Ember, Meadow and Coral Reef are warmer.`,
  'mood is "calm" for work, clinical and board talks, or "lively" for teaching and fun talks.',
  "Usually 6 to 12 slides: a title slide first, a closing slide last.",
  SLIDE_FORMAT,
  SLIDE_RULES,
  "The app adds the transitions and animations, shows the deck full screen, and gives the user a PowerPoint file. The voice reads only the words before DECK_BODY, so never read the JSON aloud, and never put DECK_BODY in an answer that has no deck.",
].join(" ");

/** "Board update: Q3" becomes board-update-q3. */
function slug(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9؀-ۿ]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "presentation";
}

const text = (value, max = 200) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const lines = (value, count = 6, max = 120) => (Array.isArray(value) ? value : [])
  .map((line) => text(line, max)).filter(Boolean).slice(0, count);

/** One slide from the model, cut down to the fields and sizes the builders know. */
export function cleanSlide(raw) {
  if (!raw || typeof raw !== "object") return null;
  const kind = KINDS.includes(raw.kind) ? raw.kind : "bullets";
  const slide = { kind };
  if (kind !== "quote") slide.title = text(raw.title, 120);
  if (["title", "section", "closing"].includes(kind) && raw.subtitle) slide.subtitle = text(raw.subtitle, 160);
  if (kind === "bullets") slide.bullets = lines(raw.bullets);
  if (kind === "twoColumn") {
    for (const side of ["left", "right"]) {
      slide[side] = { heading: text(raw[side]?.heading, 60), bullets: lines(raw[side]?.bullets, 5) };
    }
  }
  if (kind === "stat") {
    slide.value = text(raw.value, 16);
    slide.label = text(raw.label, 120);
  }
  if (kind === "quote") {
    slide.quote = text(raw.quote, 300);
    if (raw.by) slide.by = text(raw.by, 80);
  }
  if (kind === "chart") {
    const chart = raw.chart || {};
    const categories = lines(chart.categories, 12, 40);
    const series = (Array.isArray(chart.series) ? chart.series : []).slice(0, 4).map((s) => ({
      name: text(s?.name, 40),
      values: (Array.isArray(s?.values) ? s.values : []).slice(0, categories.length).map(Number).map((v) => (Number.isFinite(v) ? v : 0)),
    })).filter((s) => s.values.length);
    if (!categories.length || !series.length) return { kind: "bullets", title: slide.title, bullets: [] };
    slide.chart = { type: CHARTS.includes(chart.type) ? chart.type : "column", categories, series };
  }
  if (raw.notes) slide.notes = text(raw.notes, 1200);
  return slide;
}

/** The whole deck from the model: title, theme, mood, slides. */
export function cleanDeck(raw) {
  const deck = {
    title: text(raw?.title, 120) || "Presentation",
    theme: THEMES.includes(raw?.theme) ? raw.theme : "Nocturne",
    mood: raw?.mood === "lively" ? "lively" : "calm",
    slides: (Array.isArray(raw?.slides) ? raw.slides : []).map(cleanSlide).filter(Boolean).slice(0, MAX_SLIDES),
  };
  if (!deck.slides.length) deck.slides.push({ kind: "title", title: deck.title });
  return deck;
}

/** The first {...} in the model's text, even inside a code fence or after a sentence. */
export function parseJsonObject(raw) {
  const body = String(raw || "").replace(/```(?:json)?/gi, "");
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}

const deckPath = (id) => path.join(DECK_DIR, `${id}.json`);
const pptxPath = (id) => path.join(DECK_DIR, `${id}.pptx`);

async function saveDeck(id, deck) {
  await fs.mkdir(DECK_DIR, { recursive: true });
  deck.updated = Date.now();
  await fs.writeFile(deckPath(id), JSON.stringify(deck, null, 2), "utf8");
}

async function loadDeck(id) {
  if (!ID.test(id)) return null;
  try {
    return JSON.parse(await fs.readFile(deckPath(id), "utf8"));
  } catch {
    return null;
  }
}

function newId() {
  return `${new Date().toISOString().slice(0, 10)}-${crypto.randomBytes(4).toString("hex")}`;
}

// One build per deck at a time; a newer change waits for the running one, then builds again.
const building = new Map();

/** The deck's .pptx, rebuilt when the spec changed after the last build. */
async function ensurePptx(id) {
  while (building.has(id)) await building.get(id).catch(() => {});
  const deck = await loadDeck(id);
  if (!deck) return null;
  const file = pptxPath(id);
  const made = await fs.stat(file).then((s) => s.mtimeMs, () => 0);
  if (made && made >= (deck.updated || 0)) return file;
  const job = buildPptx(deck, DECK_DIR, file);
  building.set(id, job);
  try {
    await job;
  } finally {
    building.delete(id);
  }
  return file;
}

/** Save a deck the model wrote after DECK_BODY. Resolves with the event the page gets. */
export async function makeDeck(raw) {
  const parsed = parseJsonObject(raw);
  if (!parsed) throw new Error("The slides did not come out as JSON.");
  const deck = cleanDeck(parsed);
  const id = newId();
  await saveDeck(id, deck);
  // Build the PowerPoint now, so Download is instant later.
  ensurePptx(id).catch((err) => console.error("Failed while building a deck:", err?.message || err));
  return { type: "deck", id, title: deck.title, slides: deck.slides.length };
}

const LIVE_INSTRUCTION = [
  "You build a slide deck live while the user presents. You get the deck so far, the slide on screen, and what the user just said.",
  "Answer with one JSON object only, no other text:",
  '{"action":"add","slide":{…}} makes a new slide from what they said and puts it after the one on screen. This is the usual answer: when they talk about content, turn it into a slide.',
  '{"action":"edit","slide":{…}} replaces the slide on screen, when they ask to change it: a new title, another bullet, make it a chart, shorter.',
  '{"action":"delete"} removes the slide on screen. {"action":"goto","index":n} shows slide n (0 is the first).',
  '{"action":"theme","theme":"…"} changes the look; themes: ' + THEMES.join(", ") + ". " + '{"action":"mood","mood":"calm|lively"} changes the motion.',
  '{"action":"none","say":"…"} when it is not about the deck at all.',
  SLIDE_FORMAT,
  SLIDE_RULES,
  "Keep what they said, in their own terms; tidy it into a headline and short bullets. Do not repeat a slide that is already in the deck.",
].join(" ");

function outline(deck, current) {
  return deck.slides.map((s, i) => `${i}${i === current ? " (on screen)" : ""}: ${s.kind} — ${s.title || s.quote || ""}`).join("\n");
}

/** Apply one live sentence to the deck. Returns { deck, index, action, say }. */
async function liveStep(deck, current, said, model, apiKey) {
  const onScreen = deck.slides[current] || null;
  const prompt = [
    `Deck: ${deck.title}`,
    "Slides so far:",
    outline(deck, current),
    `Slide on screen: ${JSON.stringify(onScreen)}`,
    `The user just said: ${said}`,
  ].join("\n");
  const raw = await askModelOnce(model, LIVE_INSTRUCTION, prompt, apiKey, 1500, 90000);
  const reply = parseJsonObject(raw);
  if (!reply) throw new Error("No slide came back.");
  let index = current;
  const action = String(reply.action || "add");
  if (action === "add" || action === "edit") {
    const slide = cleanSlide(reply.slide);
    if (!slide) throw new Error("No slide came back.");
    if (action === "edit" && onScreen) deck.slides[current] = slide;
    else {
      index = Math.min(current + 1, deck.slides.length);
      deck.slides.splice(index, 0, slide);
      deck.slides = deck.slides.slice(0, MAX_SLIDES);
    }
  } else if (action === "delete" && deck.slides.length > 1) {
    deck.slides.splice(current, 1);
    index = Math.max(0, current - 1);
  } else if (action === "goto") {
    index = Math.max(0, Math.min(deck.slides.length - 1, Number(reply.index) || 0));
  } else if (action === "theme" && THEMES.includes(reply.theme)) {
    deck.theme = reply.theme;
  } else if (action === "mood") {
    deck.mood = reply.mood === "lively" ? "lively" : "calm";
  }
  return { deck, index, action, say: text(reply.say, 200) };
}

/** A path in folder for name that does not overwrite anything there. */
async function freePath(folder, name) {
  const base = name.replace(/\.pptx$/i, "");
  for (let n = 0; n < 100; n += 1) {
    const candidate = path.join(folder, n ? `${base} ${n + 1}.pptx` : `${base}.pptx`);
    try {
      await fs.access(candidate);
    } catch {
      return candidate;
    }
  }
  throw new Error("Too many files with that name.");
}

function run(bin, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`${bin} failed`))));
  });
}

/**
 * GET  /deck/themes       DeckCraft's themes (colours and fonts) for the presenter.
 * POST /deck/new          an empty live deck: { title } → { id, deck }.
 * GET  /deck/:id          the deck spec.
 * POST /deck/:id/live     one spoken sentence: { said, current, model } → { deck, index, action, say }.
 * GET  /deck/:id/pptx     the PowerPoint file (built on demand by DeckCraft).
 * POST /deck/:id/save     copies the .pptx to Downloads, or a folder the user picks ({ pick: true }).
 * POST /deck/:id/open     opens it in the Mac's app for .pptx (PowerPoint or Keynote).
 */
export function registerDeck(app) {
  app.get("/deck/themes", async (_req, res) => {
    try {
      res.json({ themes: await deckThemes() });
    } catch (err) {
      console.error("Failed while reading DeckCraft themes:", err?.message || err);
      res.status(500).json({ error: DECKCRAFT_BIN ? "DeckCraft did not answer." : "DeckCraft is not installed." });
    }
  });

  app.post("/deck/new", async (req, res) => {
    const title = text(req.body?.title, 120) || "Live presentation";
    const deck = cleanDeck({ title, theme: req.body?.theme, mood: req.body?.mood, slides: [{ kind: "title", title, subtitle: text(req.body?.subtitle, 160) }] });
    const id = newId();
    await saveDeck(id, deck);
    res.json({ id, deck });
  });

  app.get("/deck/:id", async (req, res) => {
    const deck = await loadDeck(req.params.id);
    if (!deck) return res.status(404).json({ error: "That deck is gone." });
    res.json({ id: req.params.id, deck });
  });

  app.post("/deck/:id/live", async (req, res) => {
    const deck = await loadDeck(req.params.id);
    if (!deck) return res.status(404).json({ error: "That deck is gone." });
    const said = text(req.body?.said, 1500);
    if (!said) return res.status(400).json({ error: "Say something for the slide." });
    const model = getModel(process.env.DECK_LIVE_MODEL || req.body?.model) || getModel("claude-sonnet");
    const apiKey = process.env.OPENAI_API_KEY;
    const current = Math.max(0, Math.min(deck.slides.length - 1, Number(req.body?.current) || 0));
    try {
      const step = await liveStep(deck, current, said, model, apiKey);
      if (step.action !== "none" && step.action !== "goto") {
        await saveDeck(req.params.id, step.deck);
        // Keep the PowerPoint file a step behind at most.
        ensurePptx(req.params.id).catch((err) => console.error("Failed while building a deck:", err?.message || err));
      }
      res.json({ id: req.params.id, ...step });
    } catch (err) {
      console.error("Failed while making a live slide:", err?.message || err);
      res.status(500).json({ error: clientError(err?.message, "Could not make that slide.") });
    }
  });

  app.get("/deck/:id/pptx", async (req, res) => {
    try {
      const file = await ensurePptx(req.params.id);
      if (!file) return res.status(404).json({ error: "That deck is gone." });
      const deck = await loadDeck(req.params.id);
      res.download(file, `${slug(deck?.title)}.pptx`);
    } catch (err) {
      console.error("Failed while building a deck:", err?.message || err);
      res.status(500).json({ error: clientError(err?.message, "Could not make the PowerPoint file.") });
    }
  });

  app.post("/deck/:id/save", async (req, res) => {
    try {
      const file = await ensurePptx(req.params.id);
      if (!file) return res.status(404).json({ error: "That deck is gone." });
      const deck = await loadDeck(req.params.id);
      let folder = path.join(os.homedir(), "Downloads");
      if (req.body?.pick === true) {
        try {
          folder = (await run("osascript", ["-e", "POSIX path of (choose folder with prompt \"Save the presentation in:\")"])).trim();
        } catch {
          return res.json({ path: "" });
        }
        if (!folder) return res.json({ path: "" });
      }
      const target = await freePath(folder, `${slug(deck?.title)}.pptx`);
      await fs.copyFile(file, target);
      run("open", ["-R", target]).catch(() => {});
      res.json({ path: target });
    } catch (err) {
      console.error("Failed while saving a deck:", err?.message || err);
      res.status(500).json({ error: clientError(err?.message, "Could not save the presentation there.") });
    }
  });

  app.post("/deck/:id/open", async (req, res) => {
    try {
      const file = await ensurePptx(req.params.id);
      if (!file) return res.status(404).json({ error: "That deck is gone." });
      await run("open", [file]);
      res.json({ ok: true });
    } catch (err) {
      console.error("Failed while opening a deck:", err?.message || err);
      res.status(500).json({ error: "Could not open the presentation." });
    }
  });
}
