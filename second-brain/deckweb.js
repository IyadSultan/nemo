// Presentations in the app: DeckCraft's browser build (vendor/deckcraft, voice/install-deckcraft-web.sh)
// in the right-hand panel, driven by public/slidesedit.js. This file answers the AI requests
// with DeckCraft commands and opens and saves .pptx files on disk. File names, paths and slide
// text are never logged (they may name patients).
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { parseJsonObject } from "./deck.js";
import { deckThemes } from "./deckcraft.js";
import { askModelOnce } from "./models.js";
import { getModel } from "./pricing.js";
import { allowedPath, freeName } from "./wordcraft.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.join(__dirname, "vendor", "deckcraft");
const HOME = os.homedir();
const LOOK_IN = ["Documents", "Desktop", "Downloads"].map((name) => path.join(HOME, name));
const SAVE_DIR = path.join(HOME, "Documents");
const OPEN_TYPES = new Set([".pptx", ".potx", ".ppsx", ".deckcraft"]);
const SAVE_TYPES = new Set([".pptx", ".deckcraft"]);
// Characters of deck description sent with a request.
const DECK_CHARS = 120_000;

// The DeckCraft commands the model may use, with their parameters (from commands.list).
const COMMANDS = [
  "slide.new {layout?: title|titleAndContent|sectionHeader|twoContent|comparison|titleOnly|blank, at?: index, title?, body?: text with \\n between bullets}",
  "slide.duplicate {index?}  slide.delete {index?}  slide.move {from?, to}  slide.go {index}",
  "slide.layout {layout, index?}  slide.notes {text, index?}  slide.hide {index?, hidden?}",
  "text.set {id, text}: replaces the shape's whole text (\\n = new paragraph), keeping its first run's formatting",
  "edit.select {ids: [shape id]}: select shapes on the current slide; the format.*, shape.*, arrange.*, animation.* commands below act on the selection, or on ids where they take ids",
  "text.edit {id} then text.selectAll: select all the text of a shape (needed before format.* changes its text); text.exit when done",
  "format.size {size: pt}  format.bold {on}  format.italic {on}  format.color {color: #RRGGBB or accent1..6}  format.font {family}",
  "format.align {align: left|center|right|justify}  format.bullets {on}  format.numbering {on}  format.lineSpacing {lines}  format.anchor {anchor: top|middle|bottom}  format.autofit {mode: none|shrink|resize}",
  "shape.insert {preset: rect|roundRect|ellipse|triangle|rightArrow|chevron|star5, rect: [x,y,w,h], text?}  insert.textBox {rect: [x,y,w,h], text}",
  "insert.table {rows, cols, rect}  insert.chart {type: column|bar|line|pie|doughnut, rect, categories: [..], series: [{name, values}]}  chart.options {title?, legend?, dataLabels?}",
  "shape.setBounds {x, y, w, h, ids}  shape.move {x?, y?, ids}  shape.fill {color? | none: true | gradient: {stops: [[0,\"#RRGGBB\"],[1,\"#RRGGBB\"]], angle}, ids}  shape.line {color?, none?, width?, ids}",
  "shape.effects {shadow?: none|outer, glow?, ids}  shape.rename {name, id}  edit.delete {ids}  arrange.align {edge, ids}  arrange.bringToFront {ids}  arrange.sendToBack {ids}",
  "design.theme {name}  design.background {color? | gradient?, all?: bool, index?}",
  "transition.set {kind: none|morph|fade|push|wipe|split|reveal|cover|zoom, option?, duration?: ms, index?}  transition.applyAll {}",
  "animation.add {effect: fade|fly|zoom|wipe|appear|float|split, class?: entrance|emphasis|exit, option?, start?: onClick|withPrevious|afterPrevious, duration?: ms, delay?: ms, ids}",
  "animation.options {textBuild?: asOne|byParagraph}  animation.clear {index?: slide}",
];
const ALLOWED = /^(slide\.(new|duplicate|delete|move|go|layout|notes|hide)|text\.(set|edit|selectAll|exit|insert)|edit\.(select|deselect|delete|duplicate)|format\.[a-zA-Z]+|shape\.(insert|setBounds|move|resize|fill|line|effects|rename|rotate|change)|insert\.(textBox|table|chart)|chart\.(options|data|type)|table\.[a-zA-Z]+|arrange\.[a-zA-Z]+|design\.(theme|background|colors|fonts)|transition\.(set|options|timing|applyAll)|animation\.(add|set|options|timing|remove|clear))$/;

const INSTRUCTION = [
  "You read and edit a PowerPoint presentation open in DeckCraft for the user. Reply with one JSON object only, no other text:",
  '{"say":"…","ops":[{"command":"…","params":{…}},…]}.',
  "say is the answer or a short note of what you changed, plain sentences, no markdown symbols. It may be read aloud.",
  "ops are DeckCraft commands run in order on the open presentation. Slides are 960 × 540 points; x, y from the top left.",
  "Commands you may use:",
  ...COMMANDS,
  "Rules:",
  "Shapes you create (shape.insert, insert.textBox, insert.table, insert.chart) are \"$1\", \"$2\", … in the order you create them: use these strings as ids in later ops, for example text.edit {\"id\":\"$1\"} or shape.fill {\"ids\":[\"$2\"]}.",
  "Shape ids are the numbers given in the description. Commands that act on shapes act on the current slide: put slide.go {index} first when you change another slide. After slide.new the new slide is current; its shapes have ids you do not know yet, so give it title and body in slide.new.",
  "A question about the presentation (what, summarize, the main point, which slide): answer in say from the slides and notes, and add slide.go to the slide that best answers it.",
  "\"This slide\" or \"here\" means the current slide. A specific change touches only what was asked; keep the rest.",
  "A general change (the whole deck, every slide, more attractive, consistent) works through every slide in turn: slide.go {index}, then that slide's changes. Do the whole job, not a sample. Keep facts; never invent numbers.",
  "say describes only what your ops do. Never claim a change you did not send as an op.",
  "Rewrite text with text.set. To restyle text: text.edit {id}, text.selectAll, the format commands, text.exit. Style what you create: sizes, bold, colours that fit the theme and background.",
  "Keep text inside its box; keep at most 6 bullets per slide. If the request is unclear, say so and send no ops.",
].join("\n");

/** Only allowed commands with object params reach the page. */
function cleanOps(ops) {
  if (!Array.isArray(ops)) return [];
  return ops
    .filter((op) => op && typeof op.command === "string" && ALLOWED.test(op.command))
    .map((op) => ({ command: op.command, params: op.params && typeof op.params === "object" && !Array.isArray(op.params) ? op.params : {} }))
    .slice(0, 200);
}

export function registerDeckweb(app) {
  app.use("/deckcraft", express.static(APP_DIR, { dotfiles: "deny" }));

  app.get("/slides/installed", async (_req, res) => {
    res.json({ installed: Boolean(await fs.stat(path.join(APP_DIR, "index.html")).catch(() => null)) });
  });

  /** Presentations in Documents, Desktop and Downloads, newest first. */
  app.get("/slides/recent", async (_req, res) => {
    const found = [];
    for (const folder of LOOK_IN) {
      const names = (await fs.readdir(folder).catch(() => [])).filter((name) => !name.startsWith(".") && !name.startsWith("~$"));
      for (const name of names) {
        if (!OPEN_TYPES.has(path.extname(name).toLowerCase())) continue;
        const file = path.join(folder, name);
        const info = await fs.stat(file).catch(() => null);
        if (info?.isFile()) found.push({ path: file, name, where: path.basename(folder), time: info.mtimeMs });
      }
    }
    res.json({ files: found.sort((a, b) => b.time - a.time).slice(0, 30) });
  });

  app.get("/slides/file", async (req, res) => {
    const file = allowedPath(req.query.path, OPEN_TYPES);
    if (!file) return res.status(400).json({ error: "That file cannot be opened here." });
    try {
      res.setHeader("Cache-Control", "no-store");
      res.type("application/octet-stream").send(await fs.readFile(file));
    } catch {
      res.status(404).json({ error: "That file is gone." });
    }
  });

  /** Save the deck's bytes: back to X-File-Path, or as a new file in Documents named X-File-Name. */
  app.post("/slides/save", express.raw({ type: "*/*", limit: "300mb" }), async (req, res) => {
    const bytes = Buffer.isBuffer(req.body) ? req.body : null;
    if (!bytes?.length) return res.status(400).json({ error: "Nothing to save." });
    try {
      let file = null;
      const wanted = decodeURIComponent(String(req.get("x-file-path") || ""));
      if (wanted) {
        file = allowedPath(wanted, SAVE_TYPES);
        if (!file) return res.status(400).json({ error: "It cannot be saved there." });
      } else {
        const name = path.basename(decodeURIComponent(String(req.get("x-file-name") || ""))) || "Presentation.pptx";
        if (!SAVE_TYPES.has(path.extname(name).toLowerCase())) return res.status(400).json({ error: "That file type cannot be saved." });
        await fs.mkdir(SAVE_DIR, { recursive: true });
        file = await freeName(SAVE_DIR, name);
      }
      await fs.writeFile(file, bytes);
      console.log(`Saved a presentation (${path.extname(file)}, ${bytes.length} bytes)`);
      res.json({ path: file, name: path.basename(file) });
    } catch (err) {
      console.error("Failed while saving a presentation:", err?.code || "");
      res.status(400).json({ error: "Could not save it." });
    }
  });

  /** One request about the open presentation: an answer and the DeckCraft commands to run. */
  app.post("/slides/ai", async (req, res) => {
    const request = String(req.body?.request || "").trim().slice(0, 4000);
    if (!request) return res.status(400).json({ error: "Say what to do." });
    const deck = String(req.body?.deck || "");
    const title = String(req.body?.title || "Presentation").slice(0, 200);
    const current = Number(req.body?.slide) || 0;
    const model = getModel(req.body?.model) || getModel(process.env.SLIDES_MODEL) || getModel("claude-sonnet");
    const themes = await deckThemes().catch(() => []);
    const parts = [
      `Presentation: ${title}`,
      themes.length ? `Themes for design.theme: ${themes.map((t) => t.name).join(", ")}.` : "",
      `Current slide: index ${current} (slide ${current + 1}).`,
      `Slides (${deck.length > DECK_CHARS ? "first part" : "all"}), each with its shapes as id, name, box [x,y,w,h], fill and text:\n<<<\n${deck.slice(0, DECK_CHARS)}\n>>>`,
      `Request: ${request}`,
    ].filter(Boolean);
    try {
      const started = Date.now();
      const raw = await askModelOnce(model, INSTRUCTION, parts.join("\n\n"), process.env.OPENAI_API_KEY, 8000, 240_000);
      const reply = parseJsonObject(raw);
      console.log(`Slides AI request: ${deck.length} chars, ${Date.now() - started} ms, ${reply ? "ok" : "unreadable reply"}`);
      if (!reply) return res.json({ say: String(raw || "").trim().slice(0, 4000) || "I could not do that.", ops: [] });
      res.json({ say: String(reply.say || "").slice(0, 8000), ops: cleanOps(reply.ops) });
    } catch (err) {
      console.error("Failed while asking about a presentation:", err?.name || "", String(err?.message || "").slice(0, 120));
      res.status(400).json({ error: "The model did not answer. Try again." });
    }
  });
}
