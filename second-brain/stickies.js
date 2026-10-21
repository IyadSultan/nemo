/**
 * Sticky notes on a bulletin board.
 *
 * Notes live in one private file, stickies.json, next to this file (the git
 * repo ignores it). The page and the voice agent both call the tools below.
 * A title, hashtags, and a priority are filled in later by the same model
 * the rest of the app already uses. The page never waits for that.
 *
 * Schema version is 1. load() is the only place that reads old files.
 */

import { sendControl } from "./control.js";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "stickies.json");

export const COLORS = ["yellow", "pink", "blue", "green", "orange", "purple", "white", "gray", "custom"];
export const PRIORITIES = ["critical", "high", "medium", "low", "none"];
export const TOOL_NAMES = [
  "sticky_note_create",
  "sticky_note_update",
  "sticky_note_delete",
  "sticky_note_archive",
  "sticky_note_restore",
  "sticky_note_search",
  "sticky_note_list",
  "sticky_note_classify",
  "sticky_note_set_color",
  "sticky_note_set_priority",
  "sticky_note_convert_to_task",
  "sticky_note_convert_to_note",
  "sticky_note_set_reminder",
  "sticky_note_link",
  "sticky_note_move",
  "sticky_note_sort",
];

const COLOR_WORDS = {
  yellow: "yellow", pink: "pink", blue: "blue", green: "green", orange: "orange",
  purple: "purple", white: "white", gray: "gray", grey: "gray",
};
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const NUMBER_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

const collator = new Intl.Collator(["ar", "en"], { sensitivity: "base", numeric: true });

let filePath = process.env.STICKIES_FILE || DEFAULT_FILE;
let state = null;
let nowFn = () => new Date();
let classifyDelay = 800;
let notify = (payload) => {
  try {
    sendControl("stickies", payload || {});
  } catch (err) {
    console.error("Failed while telling the page about a sticky note:", err?.message || err);
  }
};

function fresh() {
  const board = {
    id: "board-main",
    name: "Board",
    background: "wood",
    backgroundColor: "",
    backgroundImage: "",
    layout: "freeform",
    sort: "manual",
    group: "",
    zoom: 1,
    panX: 40,
    panY: 30,
    taskView: "board",
    createdAt: iso(nowFn()),
    updatedAt: iso(nowFn()),
  };
  return {
    version: 1,
    prefs: {
      appearance: "system",
      defaultColorMode: "last",
      fixedColor: "yellow",
      lastColor: "yellow",
      fontStyle: "hand",
      fontFamily: "caveat",
      fontSize: 22,
      corners: "round",
      shadow: 0.55,
      paperTexture: true,
      slightRotation: true,
      pinStyle: "pin",
      trashDays: 30,
      autoColorByPriority: false,
    },
    colorMeanings: {
      yellow: "General ideas",
      pink: "Urgent",
      blue: "Work",
      green: "Personal",
      orange: "Follow-up",
      purple: "Research",
      white: "Reference",
      gray: "Someday",
    },
    boards: [board],
    notes: [],
    links: [],
    audit: [],
    pending: null,
  };
}

function iso(date) {
  return new Date(date).toISOString();
}

function clip(value, max) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function newId() {
  return crypto.randomUUID();
}

/** A hashtag with the # and spaces removed, so "Mobile App" and "#mobileapp" match. */
export function tagKey(text) {
  return String(text || "").replace(/^#+/, "").trim().toLowerCase().replace(/[\s_-]+/g, "");
}

/**
 * Keep a few plain tags and safe links. Every kept tag is written fresh, and a
 * stray < or > becomes text, so a half tag cannot join the next piece of text.
 * The input is cut before cleaning, so the cut never splits a tag.
 */
export function sanitizeHtml(input) {
  const allowed = new Set(["b", "strong", "i", "em", "u", "br", "p", "div", "ul", "ol", "li", "a"]);
  const html = String(input || "").slice(0, 20000).replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, "");
  return html.replace(/<\/?([a-z0-9]+)([^>]*)>|[<>]/gi, (full, tag, attrs) => {
    if (!tag) return full === "<" ? "&lt;" : "&gt;";
    const name = tag.toLowerCase();
    if (!allowed.has(name)) return "";
    if (full.startsWith("</")) return name === "br" ? "" : `</${name}>`;
    if (name === "br") return "<br>";
    if (name !== "a") return `<${name}>`;
    const hrefMatch = /href\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attrs || "");
    const href = safeHref(hrefMatch ? hrefMatch[1] || hrefMatch[2] : "");
    if (!href) return "";
    return `<a href="${href.replace(/"/g, "&quot;")}">`;
  });
}

function safeHref(value) {
  const href = String(value || "").trim();
  if (/^(https?:|mailto:|note:|sticky:)/i.test(href)) return href;
  return "";
}

function db() {
  if (!state) state = load();
  return state;
}

function load() {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return migrate(JSON.parse(raw));
  } catch (err) {
    if (err.code !== "ENOENT") console.error("Failed while reading stickies.json:", err.message);
    return fresh();
  }
}

/** Turn an older or partial file into schema version 1. */
export function migrate(raw) {
  const base = fresh();
  if (!raw || typeof raw !== "object") return base;
  const next = {
    ...base,
    ...raw,
    version: 1,
    prefs: { ...base.prefs, ...(raw.prefs || {}) },
    colorMeanings: { ...base.colorMeanings, ...(raw.colorMeanings || {}) },
    boards: Array.isArray(raw.boards) && raw.boards.length ? raw.boards.map(normalizeBoard) : base.boards,
    notes: Array.isArray(raw.notes) ? raw.notes.map(normalizeNote) : [],
    links: Array.isArray(raw.links) ? raw.links : [],
    audit: Array.isArray(raw.audit) ? raw.audit.slice(-200) : [],
    pending: raw.pending || null,
  };
  return next;
}

function normalizeBoard(board) {
  const blank = fresh().boards[0];
  return { ...blank, ...board, id: board.id || blank.id };
}

function normalizeNote(note) {
  return {
    checklist: [],
    strokes: [],
    hashtags: [],
    title: "",
    titleSource: "user",
    titleLocked: false,
    priority: "none",
    prioritySource: "user",
    priorityLocked: false,
    noteType: "note",
    taskStatus: "open",
    color: "yellow",
    colorSource: "default",
    customColor: "",
    isPinned: false,
    mark: "",
    fontStyle: "",
    fontFamily: "",
    fontSize: 0,
    textColor: "",
    bold: false,
    italic: false,
    underline: false,
    lineHeight: 1.35,
    align: "start",
    rotation: 0,
    width: 230,
    height: 200,
    contentVersion: 1,
    metadataVersion: 0,
    isTask: false,
    ...note,
    hashtags: Array.isArray(note.hashtags) ? note.hashtags : [],
    checklist: Array.isArray(note.checklist) ? note.checklist : [],
    strokes: Array.isArray(note.strokes) ? note.strokes : [],
    mark: note.mark === "claude" ? "claude" : "",
  };
}

function save() {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(db(), null, 2));
    fs.renameSync(tmp, filePath);
  } catch (err) {
    console.error("Failed while saving stickies.json:", err.message);
  }
}

function board() {
  return db().boards[0];
}

function noteById(id) {
  return db().notes.find((note) => note.id === id) || null;
}

function alive(note) {
  return note && !note.deletedAt;
}

function purgeTrash() {
  const days = Number(db().prefs.trashDays) || 0;
  if (!days) return;
  const cutoff = nowFn().getTime() - days * 86400000;
  const before = db().notes.length;
  db().notes = db().notes.filter((note) => !note.deletedAt || new Date(note.deletedAt).getTime() >= cutoff);
  db().links = db().links.filter((link) => noteById(link.fromId) && (!link.toId || noteById(link.toId)));
  if (db().notes.length !== before) save();
}

function audit(actor, tool, noteId, summary) {
  db().audit.push({ at: iso(nowFn()), actor: actor || "user", tool, noteId: noteId || "", summary: clip(summary, 180) });
  db().audit = db().audit.slice(-200);
}

function present(note) {
  if (!note) return null;
  const links = db().links.filter((link) => link.fromId === note.id || link.toId === note.id);
  return { ...note, links };
}

function result(partial) {
  return {
    ok: false,
    status: "error",
    note: null,
    notes: [],
    choices: [],
    groups: [],
    error: "",
    ui: null,
    classifyIds: [],
    ...partial,
  };
}

function fail(error) {
  return result({ ok: false, status: error === "not_found" ? "not_found" : "error", error });
}

function choose(hits, tool, args) {
  const choices = hits.slice(0, 6).map((hit) => ({
    id: hit.note.id,
    title: hit.note.title || clip(plainText(hit.note.content), 60) || "Untitled note",
  }));
  db().pending = { kind: "choose", tool, args, choices, at: iso(nowFn()) };
  save();
  return result({
    ok: false,
    status: "choose",
    choices,
    error: "Which note did you mean?",
  });
}

function needConfirm(tool, args, summary) {
  db().pending = { kind: "confirm", tool, args: { ...args, confirm: true }, summary, at: iso(nowFn()) };
  save();
  return result({ ok: false, status: "confirm", error: summary });
}

function plainText(html) {
  return String(html || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

const SEARCH_SKIP = new Set(["the", "a", "an", "my", "to", "of", "and", "for", "about", "that", "this", "note", "notes"]);

function searchHits(query) {
  const terms = String(query || "").toLowerCase().split(/\s+/).filter((word) => word.length > 1 && !SEARCH_SKIP.has(word));
  if (!terms.length) return [];
  const hits = [];
  for (const note of db().notes) {
    if (note.deletedAt) continue;
    const title = note.title.toLowerCase();
    const body = plainText(note.content).toLowerCase();
    const tags = note.hashtags.map((tag) => `${tag.display} ${tag.key}`.toLowerCase()).join(" ");
    let score = 0;
    let matched = 0;
    for (const term of terms) {
      if (title.includes(term)) {
        score += 5;
        matched += 1;
      } else if (tags.includes(term)) {
        score += 4;
        matched += 1;
      } else if (body.includes(term)) {
        score += 3;
        matched += 1;
      }
    }
    if (matched) hits.push({ note, score, matched });
  }
  hits.sort((a, b) => b.score - a.score || collator.compare(a.note.title, b.note.title));
  return hits;
}

/** One note, or a list to ask about, or an error. Never picks a random match. */
function resolveOne(args) {
  if (args.id) {
    const note = noteById(args.id);
    if (!note || note.deletedAt) return { error: "not_found" };
    return { note };
  }
  const hits = searchHits(args.query);
  if (!hits.length) return { error: "not_found" };
  const best = hits.filter((hit) => hit.score === hits[0].score);
  if (best.length > 1) return { hits: best };
  if (hits.length > 1 && hits[0].score < hits[1].score * 1.6) return { hits: hits.slice(0, 5) };
  return { note: hits[0].note };
}

function defaultColor() {
  const prefs = db().prefs;
  if (prefs.defaultColorMode === "fixed") return prefs.fixedColor || "yellow";
  return prefs.lastColor || "yellow";
}

function blankNote(args) {
  const spot = nextSpot();
  const prefs = db().prefs;
  const color = COLORS.includes(args.color) ? args.color : defaultColor();
  return normalizeNote({
    id: newId(),
    boardId: args.boardId || board().id,
    content: sanitizeHtml(args.content || ""),
    title: clip(args.title || "", 120),
    titleSource: args.title ? "user" : "ai",
    titleLocked: Boolean(args.title),
    color,
    colorSource: args.color ? "user" : "default",
    customColor: args.color === "custom" ? clip(args.customColor, 32) : "",
    priority: PRIORITIES.includes(args.priority) ? args.priority : "none",
    prioritySource: args.priority ? "user" : "ai",
    priorityLocked: Boolean(args.priority),
    noteType: args.noteType === "task" ? "task" : "note",
    dueAt: args.dueAt || null,
    reminderAt: args.reminderAt || null,
    isPinned: Boolean(args.isPinned),
    mark: args.mark === "claude" ? "claude" : "",
    archivedAt: null,
    deletedAt: null,
    createdAt: iso(nowFn()),
    updatedAt: iso(nowFn()),
    completedAt: null,
    positionX: Number.isFinite(args.x) ? args.x : spot.x,
    positionY: Number.isFinite(args.y) ? args.y : spot.y,
    width: Number(args.width) || 230,
    height: Number(args.height) || 200,
    rotation: Number.isFinite(args.rotation) ? args.rotation : (prefs.slightRotation ? Math.round((Math.random() * 5 - 2.5) * 10) / 10 : 0),
    fontStyle: args.fontStyle || "",
    fontFamily: args.fontFamily || "",
    fontSize: Number(args.fontSize) || 0,
    checklist: Array.isArray(args.checklist) ? args.checklist : [],
    hashtags: normalizeTags(args.hashtags, []),
  });
}

function nextSpot() {
  const used = db().notes.filter((note) => !note.deletedAt && !note.archivedAt).length;
  return { x: 72 + (used % 7) * 26, y: 64 + (used % 5) * 22 };
}

function normalizeTags(list, existing) {
  const known = new Map();
  for (const note of db().notes) {
    for (const tag of note.hashtags || []) known.set(tag.key, tag.display);
  }
  for (const tag of existing || []) known.set(tag.key, tag.display);
  const out = [];
  const seen = new Set();
  for (const item of list || []) {
    const display = clip(typeof item === "string" ? item : item?.display, 40).replace(/^#+/, "");
    const key = tagKey(display);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ key, display: known.get(key) || display });
  }
  return out.slice(0, 8);
}

function touch(note) {
  note.updatedAt = iso(nowFn());
}

function applyContent(note, content) {
  const clean = sanitizeHtml(content);
  if (clean === note.content) return false;
  note.content = clean;
  note.contentVersion += 1;
  touch(note);
  return true;
}

export function sortNotes(notes, sort) {
  const list = [...notes];
  const priorityRank = (note) => PRIORITIES.indexOf(note.priority);
  const by = {
    color: (a, b) => COLORS.indexOf(a.color) - COLORS.indexOf(b.color),
    "created-desc": (a, b) => new Date(b.createdAt) - new Date(a.createdAt),
    "created-asc": (a, b) => new Date(a.createdAt) - new Date(b.createdAt),
    updated: (a, b) => new Date(b.updatedAt) - new Date(a.updatedAt),
    "title-asc": (a, b) => collator.compare(a.title || plainText(a.content), b.title || plainText(b.content)),
    "title-desc": (a, b) => collator.compare(b.title || plainText(b.content), a.title || plainText(a.content)),
    hashtag: (a, b) => collator.compare(a.hashtags[0]?.display || "", b.hashtags[0]?.display || ""),
    priority: (a, b) => priorityRank(a) - priorityRank(b),
    due: (a, b) => scheduleTime(a) - scheduleTime(b),
    manual: (a, b) => a.positionY - b.positionY || a.positionX - b.positionX,
  };
  list.sort(by[sort] || by.manual);
  list.sort((a, b) => Number(b.isPinned) - Number(a.isPinned));
  return list;
}

export function filterNotes(notes, filter = {}) {
  const tag = filter.hashtag ? tagKey(filter.hashtag) : "";
  return notes.filter((note) => {
    if (filter.trash) return Boolean(note.deletedAt);
    if (note.deletedAt) return false;
    if (filter.archived) {
      if (!note.archivedAt) return false;
    } else if (note.archivedAt && !filter.includeArchived) return false;
    if (filter.color && note.color !== filter.color) return false;
    if (tag && !note.hashtags.some((item) => item.key === tag)) return false;
    if (filter.priority === "high+") {
      if (note.priority !== "high" && note.priority !== "critical") return false;
    } else if (filter.priority && note.priority !== filter.priority) return false;
    if (filter.pinned === true && !note.isPinned) return false;
    if (filter.noteType && note.noteType !== filter.noteType) return false;
    if (filter.taskStatus === "open" && note.taskStatus === "done") return false;
    if (filter.taskStatus === "done" && note.taskStatus !== "done") return false;
    if (filter.q && !searchHits(filter.q).some((hit) => hit.note.id === note.id)) return false;
    if (filter.due === "today" && !sameDay(note.dueAt, nowFn())) return false;
    if (filter.due === "upcoming" && !(note.dueAt && new Date(note.dueAt) > endOfDay(nowFn()) && note.taskStatus !== "done")) return false;
    if (filter.due === "overdue" && !(note.dueAt && new Date(note.dueAt) < nowFn() && note.taskStatus !== "done")) return false;
    if (filter.due === "scheduled" && !note.dueAt && !note.reminderAt) return false;
    if (filter.completedMonth) {
      if (note.taskStatus !== "done" || !note.completedAt) return false;
      const when = new Date(note.completedAt);
      if (when.getFullYear() !== filter.completedMonth.year || when.getMonth() !== filter.completedMonth.month) return false;
    }
    return true;
  });
}

/** The soonest due time or reminder. Notes with neither sort last. */
function scheduleTime(note) {
  const times = [note.dueAt, note.reminderAt]
    .filter(Boolean)
    .map((value) => new Date(value).getTime())
    .filter((value) => Number.isFinite(value));
  return times.length ? Math.min(...times) : Number.POSITIVE_INFINITY;
}

function sameDay(value, day) {
  if (!value) return false;
  const date = new Date(value);
  return date.getFullYear() === day.getFullYear() && date.getMonth() === day.getMonth() && date.getDate() === day.getDate();
}

function endOfDay(day) {
  const date = new Date(day);
  date.setHours(23, 59, 0, 0);
  return date;
}

/** Virtual groups. A note with two hashtags is listed twice and stored once. */
export function groupNotes(notes, by) {
  if (!by) return [];
  const groups = new Map();
  const put = (key, label, note) => {
    if (!groups.has(key)) groups.set(key, { key, label, noteIds: [] });
    groups.get(key).noteIds.push(note.id);
  };
  for (const note of notes) {
    if (by === "hashtag") {
      if (!note.hashtags.length) put("none", "No hashtag", note);
      else note.hashtags.forEach((tag) => put(tag.key, `#${tag.display}`, note));
    } else if (by === "color") put(note.color, note.color, note);
    else if (by === "priority") put(note.priority, note.priority, note);
    else if (by === "date") put(note.createdAt.slice(0, 10), note.createdAt.slice(0, 10), note);
    else if (by === "task") put(note.noteType === "task" ? note.taskStatus : "note", note.noteType === "task" ? note.taskStatus : "Notes", note);
  }
  return [...groups.values()];
}

function publicView(filter = {}) {
  purgeTrash();
  const notes = sortNotes(filterNotes(db().notes, filter), filter.sort || board().sort);
  return {
    version: 1,
    board: board(),
    prefs: db().prefs,
    colorMeanings: db().colorMeanings,
    notes: notes.map(present),
    trash: db().notes.filter((note) => note.deletedAt).map(present),
    groups: groupNotes(notes, filter.group || board().group),
    pending: db().pending,
  };
}

function finish(note, status, extra = {}) {
  if (note?.color && note.color !== "custom") db().prefs.lastColor = note.color;
  save();
  return result({ ok: true, status, note: present(note), ...extra });
}

function toolCreate(args, actor) {
  const note = blankNote(args);
  db().notes.push(note);
  audit(actor, "sticky_note_create", note.id, note.title || plainText(note.content));
  db().pending = null;
  return finish(note, "created", { classifyIds: note.content ? [note.id] : [], ui: { open: true } });
}

function toolUpdate(args, actor) {
  const found = resolveOne(args);
  if (found.hits) return choose(found.hits, "sticky_note_update", args);
  if (found.error) return fail(found.error);
  const note = found.note;
  if (args.baseVersion && args.content != null && note.contentVersion !== args.baseVersion) {
    return result({ ok: false, status: "conflict", note: present(note), error: "This note changed somewhere else." });
  }
  let classify = false;
  if (args.content != null && applyContent(note, args.content)) classify = true;
  if (args.color && COLORS.includes(args.color)) {
    note.color = args.color;
    note.colorSource = "user";
    if (args.customColor) note.customColor = clip(args.customColor, 32);
    touch(note);
  }
  if (typeof args.title === "string") {
    note.title = clip(args.title, 120);
    note.titleSource = "user";
    note.titleLocked = args.titleLocked !== false;
    touch(note);
  }
  if (args.titleLocked != null) note.titleLocked = Boolean(args.titleLocked);
  if (Array.isArray(args.hashtags)) note.hashtags = normalizeTags(args.hashtags, note.hashtags);
  if (Array.isArray(args.checklist)) note.checklist = args.checklist.slice(0, 40).map((item) => ({
    id: item.id || newId(),
    text: clip(item.text, 240),
    done: Boolean(item.done),
  }));
  if (Array.isArray(args.strokes)) note.strokes = args.strokes.slice(0, 80);
  const fields = ["fontStyle", "fontFamily", "textColor", "align", "bold", "italic", "underline", "isPinned", "customColor"];
  for (const field of fields) if (args[field] != null) note[field] = args[field];
  if (args.fontSize) note.fontSize = Number(args.fontSize) || 0;
  if (args.lineHeight) note.lineHeight = Number(args.lineHeight) || 1.35;
  if (args.width) note.width = Math.max(140, Math.min(640, Number(args.width)));
  if (args.height) note.height = Math.max(120, Math.min(800, Number(args.height)));
  if (Number.isFinite(args.x)) note.positionX = args.x;
  if (Number.isFinite(args.y)) note.positionY = args.y;
  if (Number.isFinite(args.rotation)) note.rotation = args.rotation;
  if (args.dueAt) note.dueAt = args.dueAt;
  if (args.dueAt === null) note.dueAt = null;
  if (args.reminderAt) note.reminderAt = args.reminderAt;
  if (args.reminderAt === null) note.reminderAt = null;
  if (args.append) {
    note.content = sanitizeHtml(`${note.content}${note.content ? "<br>" : ""}${args.append}`);
    note.contentVersion += 1;
    classify = true;
    touch(note);
  }
  if (args.taskStatus) {
    note.taskStatus = args.taskStatus === "done" ? "done" : "open";
    note.completedAt = note.taskStatus === "done" ? (args.completedAt || note.completedAt || iso(nowFn())) : null;
    touch(note);
  }
  if (args.completedAt && note.taskStatus === "done") note.completedAt = args.completedAt;
  audit(actor, "sticky_note_update", note.id, "Edited a note");
  db().pending = null;
  return finish(note, "updated", { classifyIds: classify ? [note.id] : [] });
}

function toolDelete(args, actor) {
  let notes;
  if (args.ids && !args.id) {
    notes = args.ids.map(noteById).filter(Boolean);
    if (!notes.length) return fail("not_found");
    if (!args.confirm) return needConfirm("sticky_note_delete", args, `Delete ${notes.length} ${notes.length === 1 ? "note" : "notes"}? Say yes to delete, or no to keep them.`);
  } else {
    const found = resolveOne(args);
    if (found.hits) return choose(found.hits, "sticky_note_delete", args);
    if (found.error) return fail(found.error);
    if (!args.confirm) {
      const label = found.note.title || "that note";
      return needConfirm("sticky_note_delete", { ...args, id: found.note.id }, `Delete “${label}”? Say yes to move it to the trash, or no to keep it.`);
    }
    notes = [found.note];
  }
  for (const note of notes) {
    if (args.permanent) {
      db().notes = db().notes.filter((item) => item.id !== note.id);
      db().links = db().links.filter((link) => link.fromId !== note.id && link.toId !== note.id);
    } else note.deletedAt = iso(nowFn());
    audit(actor, "sticky_note_delete", note.id, args.permanent ? "Deleted forever" : "Moved to trash");
  }
  db().pending = null;
  save();
  return result({ ok: true, status: "deleted", note: present(notes[0]), notes: notes.map(present) });
}

function toolArchive(args, actor) {
  let notes = [];
  if (args.completedLastMonth) {
    const now = nowFn();
    const month = now.getMonth() === 0 ? 11 : now.getMonth() - 1;
    const year = now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear();
    notes = filterNotes(db().notes, { completedMonth: { year, month }, noteType: "task" });
    if (!notes.length) return fail("not_found");
    if (!args.confirm) return needConfirm("sticky_note_archive", { ...args, ids: notes.map((note) => note.id) }, `Archive ${notes.length} completed ${notes.length === 1 ? "note" : "notes"} from last month? Say yes to archive them.`);
  } else if (args.ids) {
    notes = args.ids.map(noteById).filter(alive);
  } else {
    const found = resolveOne(args);
    if (found.hits) return choose(found.hits, "sticky_note_archive", args);
    if (found.error) return fail(found.error);
    notes = [found.note];
  }
  for (const note of notes) {
    note.archivedAt = iso(nowFn());
    touch(note);
    audit(actor, "sticky_note_archive", note.id, "Archived");
  }
  db().pending = null;
  save();
  return result({ ok: true, status: "archived", note: present(notes[0]), notes: notes.map(present), ui: { open: true, view: "archive" } });
}

function toolRestore(args, actor) {
  const note = noteById(args.id) || resolveOne(args).note;
  if (!note) return fail("not_found");
  note.archivedAt = null;
  note.deletedAt = null;
  touch(note);
  audit(actor, "sticky_note_restore", note.id, "Restored");
  db().pending = null;
  return finish(note, "restored", { ui: { open: true, view: "board" } });
}

function toolList(args) {
  const filter = {
    color: args.color || "",
    hashtag: args.hashtag || "",
    priority: args.priority || "",
    pinned: args.pinned,
    noteType: args.noteType || "",
    taskStatus: args.taskStatus || "",
    q: args.q || args.query || "",
    due: args.due || "",
    archived: Boolean(args.archived),
    trash: Boolean(args.trash),
    includeArchived: Boolean(args.includeArchived),
    sort: args.sort || board().sort,
    group: args.group || "",
  };
  const view = publicView(filter);
  db().pending = null;
  save();
  return result({
    ok: true,
    status: "listed",
    notes: view.notes,
    groups: view.groups,
    ui: { open: true, filter, view: args.view || (args.archived ? "archive" : args.trash ? "trash" : "board") },
  });
}

function toolColor(args, actor) {
  const found = resolveOne(args);
  if (found.hits) return choose(found.hits, "sticky_note_set_color", args);
  if (found.error) return fail(found.error);
  if (!COLORS.includes(args.color)) return fail("bad_color");
  found.note.color = args.color;
  found.note.colorSource = "user";
  if (args.customColor) found.note.customColor = clip(args.customColor, 32);
  touch(found.note);
  audit(actor, "sticky_note_set_color", found.note.id, args.color);
  db().pending = null;
  return finish(found.note, "updated");
}

function toolPriority(args, actor) {
  const found = resolveOne(args);
  if (found.hits) return choose(found.hits, "sticky_note_set_priority", args);
  if (found.error) return fail(found.error);
  if (!PRIORITIES.includes(args.priority)) return fail("bad_priority");
  found.note.priority = args.priority;
  found.note.prioritySource = "user";
  found.note.priorityLocked = true;
  touch(found.note);
  audit(actor, "sticky_note_set_priority", found.note.id, args.priority);
  db().pending = null;
  return finish(found.note, "updated");
}

function toolConvert(args, actor, toTask) {
  const found = resolveOne(args);
  if (found.hits) return choose(found.hits, toTask ? "sticky_note_convert_to_task" : "sticky_note_convert_to_note", args);
  if (found.error) return fail(found.error);
  const note = found.note;
  note.noteType = toTask ? "task" : "note";
  if (toTask && note.taskStatus !== "done") note.taskStatus = "open";
  if (args.priority && PRIORITIES.includes(args.priority)) {
    note.priority = args.priority;
    note.prioritySource = "user";
    note.priorityLocked = true;
  }
  if (args.dueAt) note.dueAt = args.dueAt;
  touch(note);
  audit(actor, toTask ? "sticky_note_convert_to_task" : "sticky_note_convert_to_note", note.id, note.noteType);
  db().pending = null;
  return finish(note, "converted", { ui: { open: true, view: toTask ? "tasks" : "board" } });
}

function toolReminder(args, actor) {
  const found = resolveOne(args);
  if (found.hits) return choose(found.hits, "sticky_note_set_reminder", args);
  if (found.error) return fail(found.error);
  found.note.reminderAt = args.reminderAt || null;
  if (args.dueAt) found.note.dueAt = args.dueAt;
  touch(found.note);
  audit(actor, "sticky_note_set_reminder", found.note.id, args.reminderAt || "cleared");
  db().pending = null;
  return finish(found.note, "updated");
}

function toolLink(args, actor) {
  const from = noteById(args.fromId);
  if (!from || (args.toId && !noteById(args.toId))) return fail("not_found");
  const link = {
    id: newId(),
    fromId: from.id,
    toId: args.toId || "",
    kind: args.toId ? "note" : "url",
    href: args.toId ? `note:${args.toId}` : safeHref(args.href),
    label: clip(args.label || "", 120),
    createdAt: iso(nowFn()),
  };
  if (!link.href) return fail("bad_link");
  db().links.push(link);
  audit(actor, "sticky_note_link", from.id, link.href);
  db().pending = null;
  save();
  return result({ ok: true, status: "linked", note: present(from) });
}

function toolMove(args, actor) {
  const found = resolveOne(args);
  if (found.hits) return choose(found.hits, "sticky_note_move", args);
  if (found.error) return fail(found.error);
  if (Number.isFinite(args.x)) found.note.positionX = args.x;
  if (Number.isFinite(args.y)) found.note.positionY = args.y;
  if (args.boardId) found.note.boardId = args.boardId;
  touch(found.note);
  audit(actor, "sticky_note_move", found.note.id, "Moved");
  db().pending = null;
  return finish(found.note, "updated");
}

function toolSort(args, actor) {
  const current = board();
  if (args.sort) current.sort = args.sort;
  if (args.layout) current.layout = args.layout === "organized" ? "organized" : "freeform";
  if (args.group !== undefined) current.group = args.group || "";
  if (args.layout === "organized" && !args.sort && current.sort === "manual") current.sort = "title-asc";
  current.updatedAt = iso(nowFn());
  audit(actor, "sticky_note_sort", "", `${current.layout} ${current.sort} ${current.group}`);
  db().pending = null;
  save();
  const view = publicView({ sort: current.sort, group: current.group });
  return result({
    ok: true,
    status: "sorted",
    notes: view.notes,
    groups: view.groups,
    ui: { open: true, sort: current.sort, layout: current.layout, group: current.group },
  });
}

function toolClassifyRequest(args) {
  const ids = [];
  if (args.id) {
    const note = noteById(args.id);
    if (!note) return fail("not_found");
    ids.push(note.id);
  } else if (args.missing) {
    db().notes.filter((note) => alive(note) && !note.archivedAt && !note.hashtags.length && plainText(note.content)).forEach((note) => ids.push(note.id));
  } else {
    db().notes.filter((note) => alive(note) && !note.archivedAt && plainText(note.content)).forEach((note) => ids.push(note.id));
  }
  db().pending = null;
  return result({ ok: true, status: "classifying", classifyIds: ids, ui: { open: true } });
}

export function runTool(name, args = {}, actor = "user") {
  try {
    purgeTrash();
    switch (name) {
      case "sticky_note_create": return toolCreate(args, actor);
      case "sticky_note_update": return toolUpdate(args, actor);
      case "sticky_note_delete": return toolDelete(args, actor);
      case "sticky_note_archive": return toolArchive(args, actor);
      case "sticky_note_restore": return toolRestore(args, actor);
      case "sticky_note_search": {
        const hits = searchHits(args.query || "");
        return result({ ok: true, status: "listed", notes: hits.slice(0, args.limit || 12).map((hit) => present(hit.note)), ui: { open: true, filter: { q: args.query || "" } } });
      }
      case "sticky_note_list": return toolList(args);
      case "sticky_note_classify": return toolClassifyRequest(args);
      case "sticky_note_set_color": return toolColor(args, actor);
      case "sticky_note_set_priority": return toolPriority(args, actor);
      case "sticky_note_convert_to_task": return toolConvert(args, actor, true);
      case "sticky_note_convert_to_note": return toolConvert(args, actor, false);
      case "sticky_note_set_reminder": return toolReminder(args, actor);
      case "sticky_note_link": return toolLink(args, actor);
      case "sticky_note_move": return toolMove(args, actor);
      case "sticky_note_sort": return toolSort(args, actor);
      case "sticky_note_cancel":
        db().pending = null;
        save();
        return result({ ok: true, status: "cancelled" });
      default:
        return fail("unknown_tool");
    }
  } catch (err) {
    console.error(`Failed while running ${name}:`, err?.message || err);
    return fail("failed");
  }
}

/**
 * Apply one model reply to a note.
 * A locked title is kept. A reply for an older edit is ignored.
 * Hashtags reuse a tag the user already has when the words match.
 */
export function applyClassification(note, raw, responseVersion) {
  if (!note || note.contentVersion !== responseVersion) return { note, applied: false, reason: "stale" };
  let data;
  try {
    const text = String(raw || "").replace(/```json|```/g, "").trim();
    data = JSON.parse(text);
    if (!data || typeof data !== "object") throw new Error("the reply is not an object");
  } catch (err) {
    console.error("Failed while reading sticky-note labels:", err?.message || err);
    return { note, applied: false, reason: "bad_json" };
  }
  if (!note.titleLocked && data.title) {
    note.title = clip(data.title, 120);
    note.titleSource = "ai";
  }
  if (Array.isArray(data.hashtags)) note.hashtags = normalizeTags(data.hashtags, note.hashtags);
  if (!note.priorityLocked && PRIORITIES.includes(data.priority)) {
    note.priority = data.priority;
    note.prioritySource = "ai";
  }
  if (typeof data.isTask === "boolean") note.isTask = data.isTask;
  if (db().prefs.defaultColorMode === "auto" && note.colorSource !== "user") {
    const map = { critical: "pink", high: "pink", medium: "orange", low: "green", none: "yellow" };
    note.color = map[note.priority] || note.color;
    note.colorSource = "ai";
  }
  note.metadataVersion = responseVersion;
  return { note, applied: true, reason: "ok" };
}

export async function classifyNote(id, ask) {
  const note = noteById(id);
  if (!note) return result({ ok: false, status: "not_found", error: "not_found" });
  const version = note.contentVersion;
  const body = plainText(note.content);
  if (!body) return result({ ok: false, status: "empty", note: present(note) });
  const known = [...new Set(db().notes.flatMap((item) => item.hashtags.map((tag) => tag.display)))].slice(0, 40);
  const instruction = [
    "Label this sticky note. Reply with JSON only, no markdown.",
    '{"title":"short title","hashtags":["Tag"],"priority":"none|low|medium|high|critical","isTask":false}',
    "Title: under 8 words, in the same language as the note.",
    "Hashtags: 2 to 5, no hash mark. Reuse an existing tag when it fits.",
    `Existing tags: ${known.join(", ") || "none"}.`,
    "Priority is how urgent the note is. isTask is true only when the note asks for an action.",
  ].join(" ");
  let raw = "";
  try {
    raw = await ask(instruction, body);
  } catch (err) {
    console.error("Failed while labeling a sticky note:", err?.message || err);
    return result({ ok: false, status: "ai_down", note: present(noteById(id)), error: "The model could not label that note. The note is still saved." });
  }
  if (!raw) return result({ ok: false, status: "ai_down", note: present(noteById(id)), error: "The model could not label that note. The note is still saved." });
  const current = noteById(id);
  const applied = applyClassification(current, raw, version);
  if (!applied.applied) return result({ ok: false, status: applied.reason, note: present(current) });
  save();
  notify({ id, reason: "classified" });
  return result({ ok: true, status: "classified", note: present(current) });
}

const classifyTimers = new Map();

/** Label each note once typing pauses. A newer save restarts its wait, so one burst of typing asks the model once. */
function scheduleClassify(ids, ask) {
  if (!ask || !ids?.length) return;
  for (const id of ids) {
    clearTimeout(classifyTimers.get(id));
    const timer = setTimeout(() => {
      classifyTimers.delete(id);
      classifyNote(id, ask).catch((err) => console.error("Failed while labeling a sticky note:", err?.message || err));
    }, classifyDelay);
    timer.unref?.();
    classifyTimers.set(id, timer);
  }
}

/** "2", "number two", or "choice 2" on its own. A number inside another sentence is not a pick. */
function spokenNumber(text) {
  const match = text.match(/^(?:number |note |choice )?(\d{1,2}|[a-z]+)$/);
  if (!match) return 0;
  return Number(match[1]) || NUMBER_WORDS[match[1]] || 0;
}

function parseWhen(text) {
  const q = text.toLowerCase();
  const now = nowFn();
  if (/\btomorrow\b/.test(q)) return endOfDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)).toISOString();
  if (/\btoday\b/.test(q)) return endOfDay(now).toISOString();
  if (/\bnext week\b/.test(q)) return endOfDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 7)).toISOString();
  for (let i = 0; i < WEEKDAYS.length; i += 1) {
    if (new RegExp(`\\b${WEEKDAYS[i]}\\b`).test(q)) {
      const delta = (i - now.getDay() + 7) % 7 || 7;
      return endOfDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() + delta)).toISOString();
    }
  }
  return null;
}

/**
 * Turn a spoken or typed request into one tool call.
 * Returns null when the sentence is not about sticky notes.
 */
export function parseSticky(question, { pending = null } = {}) {
  const said = String(question || "").replace(/[^\p{L}\p{N}\s#]/gu, " ").replace(/\s+/g, " ").trim();
  const q = said.toLowerCase();
  if (!q) return null;
  if (pending?.kind === "confirm" && /^(?:yes|yes do it|confirm|go ahead|do it)$/.test(q)) {
    return { tool: pending.tool, args: pending.args };
  }
  if (pending?.kind === "confirm" && /^(?:no|cancel|stop|dont|don t|keep it)$/.test(q)) {
    return { tool: "sticky_note_cancel", args: {} };
  }
  if (pending?.kind === "choose") {
    const pick = spokenNumber(q);
    if (pick) {
      const choice = pending.choices[pick - 1];
      if (!choice) return { tool: "sticky_note_cancel", args: {} };
      return { tool: pending.tool, args: { ...pending.args, id: choice.id, query: "" } };
    }
  }

  const color = Object.keys(COLOR_WORDS).find((word) => new RegExp(`\\b${word}\\b`).test(q));
  const colorName = color ? COLOR_WORDS[color] : "";

  let match = said.match(/^(?:please |hey )?(?:create|make|add|put|new|save) (?:me )?(?:a |an )?(?:(yellow|pink|blue|green|orange|purple|white|gray|grey) )?(?:sticky(?: note)?|stickie) (?:reminding me (?:to )?|to remind me (?:to )?|that |about |saying |to )?(.+)$/i);
  if (match) {
    const body = match[2].replace(/\s+/g, " ").trim();
    const dueAt = parseWhen(body);
    return {
      tool: "sticky_note_create",
      args: {
        color: COLOR_WORDS[(match[1] || "").toLowerCase()] || "",
        content: body,
        noteType: /remind/.test(q) ? "task" : "note",
        ...(dueAt ? { dueAt } : {}),
      },
    };
  }

  match = said.match(/^(?:please |hey )?find my note about (.+?) and add (?:that )?(.+)$/i);
  if (match) {
    const dueAt = parseWhen(match[2]);
    return { tool: "sticky_note_update", args: { query: match[1], append: match[2], ...(dueAt ? { dueAt } : {}) } };
  }

  match = q.match(/^(?:please |hey )?(?:delete|remove|trash) (?:the )?sticky note about (.+)$/);
  if (match) return { tool: "sticky_note_delete", args: { query: match[1] } };

  match = q.match(/^(?:please |hey )?show (?:me )?all my (yellow|pink|blue|green|orange|purple|white|gray|grey) sticky notes$/);
  if (match) return { tool: "sticky_note_list", args: { color: COLOR_WORDS[match[1]], view: "board" } };

  if (/^(?:please |hey )?(?:arrange|sort) (?:all )?(?:the |my )?notes alphabetically$/.test(q)) {
    return { tool: "sticky_note_sort", args: { sort: "title-asc", layout: "organized", group: "" } };
  }
  if (/^(?:please |hey )?(?:arrange|sort) (?:all )?(?:the |my )?(?:sticky )?(?:notes )?(?:by |according to )?(?:their )?(?:due(?: date)?|schedule|scheduled)$/.test(q)) {
    return { tool: "sticky_note_sort", args: { sort: "due", layout: "organized", group: "" } };
  }
  if (/^(?:please |hey )?group (?:all )?my notes (?:according to|by) (?:their )?hashtags$/.test(q)) {
    return { tool: "sticky_note_sort", args: { layout: "organized", group: "hashtag", sort: "hashtag" } };
  }

  match = q.match(/^(?:please |hey )?convert the note about (.+?) into (?:a )?(?:(critical|high|medium|low)(?: priority)? )?task$/);
  if (match) return { tool: "sticky_note_convert_to_task", args: { query: match[1], priority: (match[2] || "").toLowerCase() } };

  if (/^(?:please |hey )?find my most important unfinished tasks$/.test(q)) {
    return { tool: "sticky_note_list", args: { noteType: "task", taskStatus: "open", priority: "high+", view: "tasks" } };
  }
  if (/^(?:please |hey )?generate hashtags for all notes that do not have them$/.test(q)) {
    return { tool: "sticky_note_classify", args: { missing: true } };
  }

  match = q.match(/^(?:please |hey )?show me all sticky notes related to (.+)$/);
  if (match) return { tool: "sticky_note_search", args: { query: match[1] } };

  if (/^(?:please |hey )?archive all completed notes from last month$/.test(q)) {
    return { tool: "sticky_note_archive", args: { completedLastMonth: true } };
  }

  if (/^(?:please |hey )?(?:open|show)(?: me)? (?:the |my )?(?:sticky notes|stickies|bulletin board)$/.test(q)) {
    return { tool: "sticky_note_list", args: { view: "board" } };
  }
  if (colorName && /\bsticky notes\b|\bstickies\b/.test(q) && /\bshow\b/.test(q)) {
    return { tool: "sticky_note_list", args: { color: colorName } };
  }
  return null;
}

/**
 * A chat line that should also become a sticky tied to system memory.
 * "Remember…", "from now on…", and "save a memory…" use the Claude mark.
 * An ordinary "save a sticky" is not this.
 */
export function chatMemorySticky(question) {
  const said = String(question || "").trim()
    .replace(/^(?:please\s+)?(?:hey\s+)?(?:can you\s+|could you\s+|would you\s+)?/i, "")
    .replace(/[.!]+$/, "")
    .trim();
  if (!said) return null;
  const patterns = [
    /^(?:save|add|keep)\s+(?:me\s+)?(?:a\s+|this\s+)?memor(?:y|ies)\s*[:,-]?\s*(?:that\s+|about\s+|saying\s+)?(.+)$/i,
    /^from now on,?\s+(.+)$/i,
    /^remember[:,]?\s+(?:that\s+|to\s+)?(.+)$/i,
    /^(?:learn|keep in mind|bear in mind)\s+(?:that\s+)?(.+)$/i,
  ];
  for (const pattern of patterns) {
    const match = said.match(pattern);
    const content = match?.[1]?.replace(/\s+/g, " ").trim();
    if (content && content.length >= 2) return { content, mark: "claude" };
  }
  return null;
}

/** Put one note on the board and tell the open page. Used when chat saves a memory. */
export function placeChatSticky(content, mark, ask) {
  const text = String(content || "").replace(/\s+/g, " ").trim();
  if (text.length < 2) return null;
  const toolResult = runTool("sticky_note_create", { content: text, mark }, "agent");
  if (ask && toolResult.classifyIds?.length) scheduleClassify(toolResult.classifyIds, ask);
  if (toolResult.ui) notify({ ...toolResult.ui, reason: toolResult.status });
  return toolResult;
}

export function speak(toolResult) {
  if (!toolResult) return "";
  if (toolResult.status === "choose") {
    const lines = toolResult.choices.map((choice, index) => `number ${index + 1}, ${choice.title}`);
    return `I found ${toolResult.choices.length} notes. Say ${lines.join(". Say ")}.`;
  }
  if (toolResult.status === "confirm") return toolResult.error;
  if (toolResult.status === "created") {
    const color = toolResult.note?.color || "new";
    return `I put a ${color} sticky note on the board.`;
  }
  if (toolResult.status === "updated") return "I updated that sticky note.";
  if (toolResult.status === "deleted") return "I moved that sticky note to the trash.";
  if (toolResult.status === "archived") return `Archived ${toolResult.notes?.length || 1} sticky ${toolResult.notes?.length === 1 ? "note" : "notes"}.`;
  if (toolResult.status === "restored") return "That sticky note is back on the board.";
  if (toolResult.status === "converted") return toolResult.note?.noteType === "task" ? "That note is now a task." : "That task is a sticky note again.";
  if (toolResult.status === "sorted" && toolResult.ui?.sort === "due") {
    return "I arranged the notes that have a due time or a reminder. Notes without one stay hidden until you pick another arrangement.";
  }
  if (toolResult.status === "sorted") return "I rearranged the board. Your saved positions are still there when you switch back to the free board.";
  if (toolResult.status === "classifying") return toolResult.classifyIds?.length ? `I am labeling ${toolResult.classifyIds.length} ${toolResult.classifyIds.length === 1 ? "note" : "notes"}. You can keep editing.` : "Every note already has hashtags.";
  if (toolResult.status === "listed") {
    const count = toolResult.notes?.length || 0;
    return count ? `I found ${count} sticky ${count === 1 ? "note" : "notes"}.` : "I did not find a sticky note for that.";
  }
  if (toolResult.status === "cancelled") return "Okay, I left the notes as they are.";
  if (toolResult.status === "not_found") return "I could not find that sticky note.";
  if (toolResult.status === "linked") return "Those notes are linked.";
  return toolResult.error || "I could not change the sticky notes.";
}

/** A question the agent asked is only answered by the next few minutes of talk. */
const PENDING_MS = 5 * 60000;

function freshPending() {
  const pending = db().pending;
  if (!pending || !(nowFn().getTime() - new Date(pending.at).getTime() < PENDING_MS)) return null;
  return pending;
}

export async function runStickyCommand(question, { ask = null, wait = false } = {}) {
  const parsed = parseSticky(question, { pending: freshPending() });
  if (!parsed) return null;
  const toolResult = runTool(parsed.tool, parsed.args, "agent");
  if (ask && toolResult.classifyIds.length) {
    if (wait) await Promise.all(toolResult.classifyIds.map((id) => classifyNote(id, ask)));
    else scheduleClassify(toolResult.classifyIds, ask);
  }
  if (toolResult.ui) notify({ ...toolResult.ui, reason: toolResult.status });
  if (toolResult.note?.id) toolResult.note = present(noteById(toolResult.note.id)) || toolResult.note;
  return { text: speak(toolResult), result: toolResult };
}

export function resetForTests(file, initial = null) {
  filePath = file;
  notify = () => {};
  classifyDelay = 0;
  try {
    if (initial) fs.writeFileSync(file, JSON.stringify(initial));
    else fs.rmSync(file, { force: true });
  } catch (err) {
    console.error("Failed while preparing the sticky-note test file:", err.message);
  }
  state = null;
  db();
}

export function setNowForTests(fn) {
  nowFn = fn || (() => new Date());
}

export function viewForTests(filter) {
  return publicView(filter);
}

export function registerStickies(app, { askModel } = {}) {
  const ask = askModel || (async () => "");

  app.get("/stickies", (req, res) => {
    try {
      const filter = {
        archived: req.query.view === "archive",
        trash: req.query.view === "trash",
        includeArchived: req.query.view === "archive",
        color: req.query.color || "",
        hashtag: req.query.hashtag || "",
        priority: req.query.priority || "",
        q: req.query.q || "",
        noteType: req.query.noteType || "",
        taskStatus: req.query.taskStatus || "",
        due: req.query.due || "",
        sort: req.query.sort || "",
        group: req.query.group || "",
      };
      res.json(publicView(filter));
    } catch (err) {
      console.error("Failed while reading sticky notes:", err?.message || err);
      res.status(500).json({ error: "Could not read the sticky notes." });
    }
  });

  app.put("/stickies/board", (req, res) => {
    try {
      const current = board();
      const body = req.body || {};
      for (const key of ["name", "background", "backgroundColor", "layout", "sort", "group", "taskView"]) {
        if (body[key] != null) current[key] = body[key];
      }
      if (body.backgroundImage != null) {
        const image = String(body.backgroundImage);
        current.backgroundImage = image.length > 2_000_000 ? "" : image;
      }
      for (const key of ["zoom", "panX", "panY"]) if (Number.isFinite(body[key])) current[key] = body[key];
      current.updatedAt = iso(nowFn());
      save();
      res.json({ board: current });
    } catch (err) {
      console.error("Failed while saving the board:", err?.message || err);
      res.status(500).json({ error: "Could not save the board." });
    }
  });

  app.put("/stickies/prefs", (req, res) => {
    try {
      db().prefs = { ...db().prefs, ...(req.body?.prefs || {}) };
      if (req.body?.colorMeanings) db().colorMeanings = { ...db().colorMeanings, ...req.body.colorMeanings };
      save();
      res.json({ prefs: db().prefs, colorMeanings: db().colorMeanings });
    } catch (err) {
      console.error("Failed while saving sticky-note settings:", err?.message || err);
      res.status(500).json({ error: "Could not save those settings." });
    }
  });

  app.post("/stickies/notes", (req, res) => {
    const made = runTool("sticky_note_create", req.body || {}, "user");
    scheduleClassify(made.classifyIds, ask);
    res.status(made.ok ? 200 : 400).json(made);
  });

  app.patch("/stickies/notes/:id", (req, res) => {
    const made = runTool("sticky_note_update", { ...(req.body || {}), id: req.params.id }, "user");
    scheduleClassify(made.classifyIds, ask);
    const code = made.status === "conflict" ? 409 : made.ok ? 200 : 400;
    res.status(code).json(made);
  });

  app.post("/stickies/tool", (req, res) => {
    const name = req.body?.name;
    if (!TOOL_NAMES.includes(name) && name !== "sticky_note_cancel") {
      res.status(400).json({ error: "Unknown sticky-note tool." });
      return;
    }
    const made = runTool(name, req.body?.args || {}, "user");
    scheduleClassify(made.classifyIds, ask);
    res.status(made.ok || made.status === "choose" || made.status === "confirm" ? 200 : 400).json(made);
  });

  app.post("/stickies/command", async (req, res) => {
    try {
      const spoken = await runStickyCommand(req.body?.question || "", { ask });
      if (!spoken) {
        res.json({ ok: false, status: "ignored" });
        return;
      }
      res.json({ ok: spoken.result.ok, text: spoken.text, result: spoken.result });
    } catch (err) {
      console.error("Failed while running a sticky-note command:", err?.message || err);
      res.status(500).json({ error: "Could not change the sticky notes." });
    }
  });
}
