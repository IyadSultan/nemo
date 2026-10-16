// DeckCraft (github.com/storytold/deckcraft) builds the PowerPoint files. Its CLI runs a
// headless MCP server on stdio; this module talks to it and turns a deck spec into a
// .pptx with native transitions and animations chosen by public/deck-motion.js.
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { spawn } from "node:child_process";
import { motionFor } from "./public/deck-motion.js";

export const DECKCRAFT_BIN = process.env.DECKCRAFT_BIN
  || [
    path.join(os.homedir(), ".local", "bin", "deckcraft-cli"),
    "/opt/homebrew/bin/deckcraft-cli",
    "/usr/local/bin/deckcraft-cli",
  ].find((p) => fsSync.existsSync(p))
  || "";

/**
 * One headless DeckCraft engine. Release 0.7.0 has no --automation-*-root flags yet,
 * so it runs in root and this server chooses every path it is given.
 */
export class DeckCraft {
  constructor(root) {
    if (!DECKCRAFT_BIN) throw new Error("DeckCraft is not installed. Run voice/install-deckcraft.sh.");
    this.child = spawn(DECKCRAFT_BIN, ["mcp"], { cwd: root, stdio: ["pipe", "pipe", "pipe"] });
    this.next = 0;
    this.waiting = new Map();
    this.stderr = "";
    this.child.stderr.on("data", (chunk) => { this.stderr = (this.stderr + chunk).slice(-2000); });
    readline.createInterface({ input: this.child.stdout }).on("line", (line) => {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      const done = this.waiting.get(msg.id);
      if (!done) return;
      this.waiting.delete(msg.id);
      done(msg);
    });
    this.child.on("close", () => {
      for (const done of this.waiting.values()) done({ error: { message: `DeckCraft stopped. ${this.stderr.slice(-300)}` } });
      this.waiting.clear();
    });
    this.ready = this.rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "second-brain", version: "1" },
    }).then(() => this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`));
  }

  rpc(method, params, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const id = ++this.next;
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error(`DeckCraft did not answer ${method} in time.`));
      }, timeoutMs);
      this.waiting.set(id, (msg) => {
        clearTimeout(timer);
        if (msg.error) reject(new Error(msg.error.message || "DeckCraft failed."));
        else resolve(msg.result);
      });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  /** A tool call; returns the parsed JSON the tool wrote, or its text. */
  async tool(name, args = {}) {
    await this.ready;
    const result = await this.rpc("tools/call", { name, arguments: args });
    const text = (result?.content || []).filter((part) => part.type === "text").map((part) => part.text).join("");
    if (result?.isError) throw new Error(`DeckCraft ${name}: ${text.slice(0, 300)}`);
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  run(command, params = {}) {
    return this.tool("run_command", { command, params });
  }

  close() {
    this.child.stdin.end();
    setTimeout(() => this.child.kill(), 2000).unref();
  }
}

let themeCache = null;

/** DeckCraft's themes as the presenter needs them: name, fonts, and colours. */
export async function deckThemes() {
  if (themeCache) return themeCache;
  const engine = new DeckCraft(os.tmpdir());
  try {
    const data = await engine.run("design.themes");
    // The 12 scheme colours are dk1, lt1, dk2, lt2, accent1..6, hlink, folHlink.
    // A dark theme swaps them (Nocturne's dk1 is white), so lt1 is always the background.
    themeCache = (data.themes || []).map((t) => ({
      name: t.name,
      heading: t.major,
      body: t.minor,
      text: t.colors[0],
      bg: t.colors[1],
      muted: t.colors[2],
      surface: t.colors[3],
      accents: t.colors.slice(4, 10),
    }));
  } finally {
    engine.close();
  }
  return themeCache;
}

const LAYOUT = {
  title: "title",
  section: "sectionHeader",
  closing: "title",
  bullets: "titleAndContent",
  twoColumn: "comparison",
  stat: "titleOnly",
  quote: "blank",
  chart: "titleOnly",
};

const W = 960;
const H = 540;
// Type scale in points. Large enough to read from the back of a room.
const SIZE = { hero: 54, section: 48, title: 36, body: 26, column: 24, heading: 24, sub: 24 };

function bodyText(lines) {
  return (lines || []).map((line) => String(line).trim()).filter(Boolean).join("\n");
}

/** Give all of a shape's text one look: size, colour, bold, alignment, font. */
async function style(engine, id, look) {
  await engine.run("edit.select", { ids: [id] });
  // Formatting a selected shape only changes its default run; select the text itself.
  await engine.run("text.edit");
  await engine.run("text.selectAll");
  if (look.size) await engine.run("format.size", { size: look.size });
  if (look.color) await engine.run("format.color", { color: look.color });
  if (look.bold) await engine.run("format.bold", { on: true });
  if (look.align) await engine.run("format.align", { align: look.align });
  if (look.font) await engine.run("format.font", { family: look.font });
  await engine.run("text.exit");
}

async function textBox(engine, rect, text, look) {
  const made = await engine.run("insert.textBox", { rect, text });
  await style(engine, made.id, look);
  return made.id;
}

/** A short accent bar under a title: the one accent mark on the slide. */
async function accentBar(engine, x, y, width) {
  const made = await engine.run("shape.insert", { preset: "rect", rect: [x, y, width, 6] });
  await engine.run("edit.select", { ids: [made.id] });
  await engine.run("shape.line", { none: true });
  await engine.run("shape.rename", { name: "Accent bar", id: made.id });
  return made.id;
}

/** Add one slide of the spec. Returns { index, parts } where parts maps a role to a shape id. */
async function addSlide(engine, slide, theme) {
  const kind = LAYOUT[slide.kind] ? slide.kind : "bullets";
  const params = { layout: LAYOUT[kind] };
  if (slide.title && kind !== "quote") params.title = slide.title;
  if (kind === "title" || kind === "section" || kind === "closing") params.body = slide.subtitle || "";
  if (kind === "bullets") params.body = bodyText(slide.bullets);
  const made = await engine.run("slide.new", params);
  const index = made.index;
  const parts = {};
  const shapes = (await engine.run("slide.inspect", { index })).shapes || [];
  const placeholders = shapes.filter((s) => s.kind === "placeholder");
  const title = placeholders.find((s) => s.placeholder === "title" || s.placeholder === "ctrTitle");
  const others = placeholders.filter((s) => s !== title);
  const heading = theme?.heading;
  const accent = theme?.accents?.[0];
  const soft = theme?.accents?.[1];

  if (title && kind !== "quote") {
    parts.title = title.id;
    const opening = kind === "title" || kind === "closing";
    await style(engine, title.id, {
      size: opening ? SIZE.hero : kind === "section" ? SIZE.section : SIZE.title,
      bold: true,
      font: heading,
    });
    const [x, y, w, h] = title.box;
    if (opening || kind === "section") {
      // These titles sit on the bottom of their box and the subtitle on the top of its
      // own, so the bar goes in a gap between them that we open up.
      const sub = others[0];
      if (sub) {
        await engine.run("shape.setBounds", { x: sub.box[0], y: y + h + 28, w: sub.box[2], h: sub.box[3], ids: [sub.id] });
      }
      parts.bar = opening ? await accentBar(engine, x + w / 2 - 40, y + h + 12, 80) : await accentBar(engine, x + 7, y + h + 12, 72);
    } else {
      parts.bar = await accentBar(engine, x + 7, y + h + 2, 72);
    }
  }

  if (kind === "title" || kind === "section" || kind === "closing") {
    if (others[0]) {
      parts.body = others[0].id;
      await style(engine, others[0].id, { size: SIZE.sub, color: soft });
    }
  } else if (kind === "bullets") {
    if (others[0]) {
      parts.body = others[0].id;
      await style(engine, others[0].id, { size: SIZE.body });
    }
  } else if (kind === "twoColumn") {
    // Comparison layout: a heading and a content box on each side.
    const sorted = others.slice().sort((a, b) => a.box[0] - b.box[0] || a.box[1] - b.box[1]);
    const sides = [sorted.slice(0, 2), sorted.slice(2, 4)];
    const data = [slide.left, slide.right];
    for (let k = 0; k < 2; k += 1) {
      const [head, content] = sides[k];
      const side = data[k] || {};
      const name = k === 0 ? "left" : "right";
      if (head) {
        await engine.run("edit.select", { ids: [head.id] });
        await engine.run("text.set", { text: String(side.heading || "") });
        await style(engine, head.id, { size: SIZE.heading, bold: true, color: k === 0 ? accent : soft });
        parts[`${name}Head`] = head.id;
      }
      if (content) {
        await engine.run("edit.select", { ids: [content.id] });
        await engine.run("text.set", { text: bodyText(side.bullets) });
        await style(engine, content.id, { size: SIZE.column });
        parts[name] = content.id;
      }
    }
  } else if (kind === "stat") {
    parts.value = await textBox(engine, [60, 160, W - 120, 170], String(slide.value || ""), {
      size: 120, color: accent, bold: true, align: "center", font: heading,
    });
    if (slide.label) {
      parts.label = await textBox(engine, [100, 340, W - 200, 80], String(slide.label), { size: 28, align: "center" });
    }
  } else if (kind === "quote") {
    parts.quote = await textBox(engine, [100, 130, W - 200, 220], `“${String(slide.quote || "").replace(/^["“]|["”]$/g, "")}”`, {
      size: 38, align: "center", font: heading,
    });
    if (slide.by) {
      parts.by = await textBox(engine, [100, 370, W - 200, 50], `— ${slide.by}`, { size: 22, align: "center", color: accent });
    }
  } else if (kind === "chart" && slide.chart?.series?.length) {
    const chart = await engine.run("insert.chart", {
      type: slide.chart.type || "column",
      rect: [80, 150, W - 160, 350],
      categories: (slide.chart.categories || []).map(String),
      series: slide.chart.series.map((s) => ({ name: String(s.name || ""), values: (s.values || []).map(Number) })),
    });
    parts.chart = chart.id;
    await engine.run("chart.options", {
      id: chart.id,
      title: null,
      dataLabels: true,
      gridlines: false,
      legend: slide.chart.series.length > 1 ? "b" : null,
    });
  }
  if (slide.notes) await engine.run("slide.notes", { text: String(slide.notes), index });
  return { index, parts };
}

/** Native PowerPoint motion for one slide, from the shared motion rules. */
async function animate(engine, index, parts, plan) {
  if (plan.transition) {
    const t = { kind: plan.transition.kind, duration: plan.transition.duration, index };
    if (plan.transition.option) t.option = plan.transition.option;
    await engine.run("transition.set", t);
  }
  await engine.run("edit.deselect");
  let first = true;
  for (const build of plan.builds) {
    const id = parts[build.part];
    if (!id) continue;
    await engine.run("animation.add", {
      effect: build.effect,
      class: "entrance",
      ...(build.option ? { option: build.option } : {}),
      start: build.start,
      duration: build.duration,
      delay: build.delay || 0,
      ids: [id],
    });
    if (build.byParagraph) {
      // animation.options works on the effect that was just added (the selected shape's).
      await engine.run("edit.select", { ids: [id] });
      await engine.run("animation.options", { textBuild: "byParagraph" });
    }
    first = false;
  }
  return !first;
}

/**
 * Build the whole deck spec in a fresh engine and export it to outPath (.pptx).
 * outPath must be inside root.
 */
export async function buildPptx(deck, root, outPath) {
  const engine = new DeckCraft(root);
  try {
    const themes = await engine.run("design.themes");
    const names = (themes.themes || []).map((t) => t.name);
    const themeName = names.includes(deck.theme) ? deck.theme : "Nocturne";
    await engine.run("file.new", { theme: themeName });
    const theme = (await deckThemes()).find((t) => t.name === themeName);
    const slides = deck.slides || [];
    for (let i = 0; i < slides.length; i += 1) {
      const { index, parts } = await addSlide(engine, slides[i], theme);
      await animate(engine, index, parts, motionFor(deck, i));
    }
    // file.new starts with one empty slide; ours were added after it.
    if (slides.length) await engine.run("slide.delete", { index: 0 });
    await engine.tool("export", { path: outPath, format: "pptx" });
    return outPath;
  } finally {
    engine.close();
  }
}
