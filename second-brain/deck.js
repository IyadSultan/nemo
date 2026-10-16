// Presentations the brain makes. The model writes DECK_BODY on its own line, then one
// JSON deck spec; the server saves it, DeckCraft (deckcraft.js) turns it into a .pptx
// with native motion, and the page presents it full screen (public/deck.js).
// Live mode: each sentence the user says while presenting becomes a slide, or edits one.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import express from "express";
import { fileURLToPath } from "node:url";
import { DECKCRAFT_BIN, buildPptx, deckThemes } from "./deckcraft.js";
import { askModelOnce, clientError } from "./models.js";
import { getModel } from "./pricing.js";
import { DOCUMENT_TYPES, extractDocument } from "./upload.js";
import { fetchPage, searchWeb } from "./web.js";

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

const backupPath = (id) => path.join(DECK_DIR, `${id}.prev.json`);

/** Keep the deck as it is now, so Undo can bring it back after an edit. */
async function backup(id) {
  await fs.copyFile(deckPath(id), backupPath(id)).catch(() => {});
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

// ---------- enhancing a whole deck, editing one slide ----------

const DECK_REPLY = "Answer with the whole deck as one JSON object and nothing else: " +
  '{"title":"…","theme":"…","mood":"calm|lively","slides":[…]}. ' + `theme is one of ${THEMES.join(", ")}. `;

const ENHANCE = {
  design: [
    "You make a slide deck more attractive and easier to follow, keeping its facts.",
    "Vary the slide kinds: a stat slide when one number carries the point, twoColumn for a comparison or before and after, a chart when a slide lists numbers for several items, a quote only for a real quote, section slides to split a deck of more than eight slides into parts.",
    "Rewrite each title as a short headline that states the point. Cut bullets to the few that matter. Split a crowded slide in two, merge thin ones.",
    "Pick the theme and mood that suit the audience. Write speaker notes for every slide: what to say, two or three sentences.",
    "Do not add facts, numbers, names or quotes that are not already in the deck.",
  ].join(" "),
  web: [
    "You add current facts from the web excerpts below to a slide deck, where they make a slide stronger: a number, a recent result, a short example.",
    "Use only facts that the excerpts state, with their numbers exactly as written; a stat or chart slide suits a strong number. Never invent a number or a source.",
    "Keep the deck's own points. Add a slide only when the new facts need one. Put the source site of each new fact in that slide's notes, and add a bullets slide titled Sources before the closing slide, listing the sites used.",
  ].join(" "),
  document: [
    "You add data from the document below to a slide deck where it fits: numbers, results, dates, names, short quotes.",
    "Use only what the document states, exactly as written; a stat or chart slide suits a strong number, twoColumn a comparison. Never invent anything.",
    "Keep the deck's own points; replace vague bullets with the document's specifics; add a slide only when the document has a point the deck lacks. Say in each changed slide's notes that the data comes from the document.",
  ].join(" "),
};

/** Web excerpts for the deck: its title, then its title with two slide titles. */
async function webExcerpts(deck) {
  const queries = [deck.title, ...deck.slides.slice(1, 3).map((s) => `${deck.title} ${s.title || ""}`.trim())];
  const seen = new Set();
  const pages = [];
  for (const query of [...new Set(queries)].slice(0, 3)) {
    const found = await searchWeb(`${query} latest data statistics`, { force: true });
    for (const result of found.slice(0, 3)) {
      if (seen.has(result.url)) continue;
      seen.add(result.url);
      pages.push(pages.length < 3 ? await fetchPage(result) : result);
    }
  }
  return pages.map((p) => `Site: ${new URL(p.url).hostname}\nTitle: ${p.title}\n${String(p.text || "").slice(0, 3000)}`).join("\n\n");
}

// The last document the user uploaded in the app (POST /document), for "use the document I uploaded".
let lastDocument = "";
export function rememberDocument(file) {
  lastDocument = file;
}

async function documentText(bytes, name) {
  if (bytes?.length) {
    const ext = path.extname(name || "").toLowerCase();
    if (!DOCUMENT_TYPES.has(ext)) {
      const err = new Error("That kind of file cannot be read. Use PDF, Word, PowerPoint, RTF, text or Markdown.");
      err.status = 400;
      throw err;
    }
    const file = path.join(os.tmpdir(), `deck-doc-${crypto.randomBytes(4).toString("hex")}${ext}`);
    await fs.writeFile(file, bytes);
    try {
      return await extractDocument(file);
    } finally {
      fs.rm(file, { force: true }).catch(() => {});
    }
  }
  if (lastDocument) return extractDocument(lastDocument);
  const err = new Error("Pick a document first: no document was uploaded.");
  err.status = 400;
  throw err;
}

/** Rewrite the whole deck in one mode. Returns the cleaned deck. */
async function enhanceDeck(deck, mode, request, extra, model, apiKey) {
  const prompt = [
    request ? `What the user asked for: ${request}` : "",
    `The deck now: ${JSON.stringify({ title: deck.title, theme: deck.theme, mood: deck.mood, slides: deck.slides })}`,
    extra,
  ].filter(Boolean).join("\n\n");
  const instruction = [ENHANCE[mode], SLIDE_FORMAT, SLIDE_RULES, DECK_REPLY].join(" ");
  const raw = await askModelOnce(model, instruction, prompt, apiKey, 8000, 240000);
  const parsed = parseJsonObject(raw);
  if (!parsed?.slides?.length) throw new Error("The improved deck did not come back.");
  return cleanDeck(parsed);
}

const EDIT_INSTRUCTION = [
  "You change one slide of a deck the way the user asks: a new title, other bullets, a different kind (make it a chart, a comparison, a big number), shorter, clearer.",
  "Keep everything they did not ask to change. Never invent numbers, quotes or names.",
  'Answer with one JSON object only: {"slide":{…}}.',
  SLIDE_FORMAT,
  SLIDE_RULES,
].join(" ");

async function editSlide(deck, index, request, model, apiKey) {
  const prompt = [
    `Deck: ${deck.title}`,
    "Slides:",
    outline(deck, index),
    `The slide to change: ${JSON.stringify(deck.slides[index])}`,
    `What the user wants: ${request}`,
  ].join("\n");
  const raw = await askModelOnce(model, EDIT_INSTRUCTION, prompt, apiKey, 1500, 90000);
  const slide = cleanSlide(parseJsonObject(raw)?.slide);
  if (!slide) throw new Error("No slide came back.");
  return slide;
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
 * POST /deck/:id/enhance  rewrite the deck: design (more attractive), web (online data), document (a file's data).
 * POST /deck/:id/slide    change one slide: { index, request, model } → { deck, index }.
 * POST /deck/:id/undo     back to the deck before the last enhance or slide change.
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

  // { mode: design|web|document, request?, model? } as JSON, or the document's bytes
  // with x-mode / x-file-name / x-request / x-model headers.
  app.post("/deck/:id/enhance", express.raw({ type: ["application/octet-stream", "application/pdf", "application/*"], limit: "60mb" }), async (req, res) => {
    const deck = await loadDeck(req.params.id);
    if (!deck) return res.status(404).json({ error: "That deck is gone." });
    const bytes = Buffer.isBuffer(req.body) ? req.body : null;
    const header = (name) => {
      try {
        return decodeURIComponent(String(req.get(name) || ""));
      } catch {
        return "";
      }
    };
    const body = bytes ? {} : req.body || {};
    const mode = ["design", "web", "document"].includes(body.mode || header("x-mode")) ? body.mode || header("x-mode") : "design";
    const request = text(body.request || header("x-request"), 600);
    const model = getModel(process.env.DECK_ENHANCE_MODEL || body.model || header("x-model")) || getModel("claude-sonnet");
    try {
      let extra = "";
      if (mode === "web") {
        extra = await webExcerpts(deck);
        if (!extra) throw new Error("The web search found nothing for this deck.");
        extra = `Web excerpts:\n${extra}`;
      } else if (mode === "document") {
        const doc = (await documentText(bytes, header("x-file-name"))).slice(0, 40000);
        if (!doc) throw new Error("No text could be read from that document.");
        extra = `The document:\n${doc}`;
      }
      const better = await enhanceDeck(deck, mode, request, extra, model, process.env.OPENAI_API_KEY);
      await backup(req.params.id);
      await saveDeck(req.params.id, better);
      ensurePptx(req.params.id).catch((err) => console.error("Failed while building a deck:", err?.message || err));
      console.log(`Enhanced a deck (${mode}, ${better.slides.length} slides)`);
      res.json({ id: req.params.id, deck: better, mode });
    } catch (err) {
      if (err?.status === 400) return res.status(400).json({ error: err.message });
      console.error("Failed while enhancing a deck:", err?.message || err);
      res.status(500).json({ error: clientError(err?.message, "Could not improve the deck.") });
    }
  });

  app.post("/deck/:id/slide", async (req, res) => {
    const deck = await loadDeck(req.params.id);
    if (!deck) return res.status(404).json({ error: "That deck is gone." });
    const request = text(req.body?.request, 1000);
    if (!request) return res.status(400).json({ error: "Say what to change on the slide." });
    const index = Math.max(0, Math.min(deck.slides.length - 1, Number(req.body?.index) || 0));
    const model = getModel(process.env.DECK_LIVE_MODEL || req.body?.model) || getModel("claude-sonnet");
    try {
      const slide = await editSlide(deck, index, request, model, process.env.OPENAI_API_KEY);
      await backup(req.params.id);
      deck.slides[index] = slide;
      await saveDeck(req.params.id, deck);
      ensurePptx(req.params.id).catch((err) => console.error("Failed while building a deck:", err?.message || err));
      res.json({ id: req.params.id, deck, index });
    } catch (err) {
      console.error("Failed while editing a slide:", err?.message || err);
      res.status(500).json({ error: clientError(err?.message, "Could not change that slide.") });
    }
  });

  app.post("/deck/:id/undo", async (req, res) => {
    const before = ID.test(req.params.id) ? await fs.readFile(backupPath(req.params.id), "utf8").catch(() => "") : "";
    if (!before) return res.status(404).json({ error: "Nothing to undo." });
    const deck = JSON.parse(before);
    await fs.rm(backupPath(req.params.id), { force: true });
    await saveDeck(req.params.id, deck);
    ensurePptx(req.params.id).catch((err) => console.error("Failed while building a deck:", err?.message || err));
    res.json({ id: req.params.id, deck });
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
