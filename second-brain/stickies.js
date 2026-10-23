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
import { fetchForImport, importableUrl } from "./stickyimport.js";
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
  "sticky_board_create",
  "sticky_board_switch",
  "sticky_board_rename",
  "sticky_board_delete",
  "sticky_brainstorm_start",
  "sticky_brainstorm_set",
  "sticky_brainstorm_challenge",
  "sticky_brainstorm_themes",
  "sticky_brainstorm_consolidate",
  "sticky_idea_branch",
  "sticky_idea_more",
  "sticky_idea_accept_all",
  "sticky_idea_reject_all",
  "sticky_note_combine",
  "sticky_note_summarize",
  "sticky_note_create_many",
  "sticky_idea_restore",
  "sticky_ideas_from_files",
  "sticky_board_summary",
  "sticky_board_plan",
  "sticky_board_template",
  "sticky_import_url",
  "sticky_idea_accept",
  "sticky_idea_reject",
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
// Brainstorm waits until typing stops, so one finished edit is one model call.
let brainstormDelay = 5000;
// Set by registerStickies: search the user's wiki and files, and add a plan to the Plans tab.
let fileSearch = null;
let planMaker = null;
let pageReader = fetchForImport;
// The note the last change touched, so "put that on the Work board" knows which one.
let lastNoteId = "";
let notify = (payload) => {
  try {
    sendControl("stickies", payload || {});
  } catch (err) {
    console.error("Failed while telling the page about a sticky note:", err?.message || err);
  }
};

// Light or dark, and how long the trash keeps notes, are the same on every board.
const APP_PREFS = { appearance: "system", trashDays: 30 };
// Every other setting belongs to one board, so each board can look different.
const BOARD_LOOK = {
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
  autoColorByPriority: false,
};
const COLOR_MEANINGS = {
  yellow: "General ideas",
  pink: "Urgent",
  blue: "Work",
  green: "Personal",
  orange: "Follow-up",
  purple: "Research",
  white: "Reference",
  gray: "Someday",
};

function pick(source, keys) {
  const out = {};
  for (const key of keys) if (source && source[key] !== undefined) out[key] = source[key];
  return out;
}

function blankBoard(id, name = "Board") {
  return {
    id,
    name,
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
    look: { ...BOARD_LOOK },
    colorMeanings: { ...COLOR_MEANINGS },
    // brief: what the user cares about; wild: 0 practical to 100 bold. Both go into every prompt.
    brainstorm: { on: false, topic: "", rejected: [], brief: "", wild: 50 },
    // Pen lines, straight lines and arrows drawn on the board itself (stickiestab.js).
    ink: [],
    createdAt: iso(nowFn()),
    updatedAt: iso(nowFn()),
  };
}

function fresh() {
  return {
    version: 1,
    prefs: { ...APP_PREFS },
    boards: [blankBoard("board-main")],
    currentBoardId: "board-main",
    notes: [],
    proposals: [],
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
    prefs: { ...base.prefs, ...pick(raw.prefs, Object.keys(APP_PREFS)) },
    boards: Array.isArray(raw.boards) && raw.boards.length ? raw.boards.map((board) => normalizeBoard(board, raw)) : base.boards,
    notes: Array.isArray(raw.notes) ? raw.notes.map(normalizeNote) : [],
    links: Array.isArray(raw.links) ? raw.links : [],
    proposals: Array.isArray(raw.proposals) ? raw.proposals : [],
    audit: Array.isArray(raw.audit) ? raw.audit.slice(-200) : [],
    pending: raw.pending || null,
  };
  // Before boards had their own settings, the look and the color meanings were shared. Each board starts from those.
  delete next.colorMeanings;
  const ids = new Set(next.boards.map((board) => board.id));
  if (!ids.has(next.currentBoardId)) next.currentBoardId = next.boards[0].id;
  for (const note of next.notes) if (!ids.has(note.boardId)) note.boardId = next.boards[0].id;
  return next;
}

function normalizeBoard(board, old = {}) {
  const blank = blankBoard(board.id || "board-main");
  return {
    ...blank,
    ...board,
    look: { ...blank.look, ...pick(old.prefs, Object.keys(BOARD_LOOK)), ...(board.look || {}) },
    colorMeanings: { ...blank.colorMeanings, ...(old.colorMeanings || {}), ...(board.colorMeanings || {}) },
    brainstorm: { ...blank.brainstorm, ...(board.brainstorm || {}) },
  };
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
    back: sanitizeHtml(note.back || ""),
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

/** The board that is open. The page and the voice share it. */
function board() {
  return db().boards.find((item) => item.id === db().currentBoardId) || db().boards[0];
}

/** A board by id, or by the name someone said. */
function findBoard(args) {
  if (args.boardId) return db().boards.find((item) => item.id === args.boardId) || null;
  const name = String(args.board || "").trim().toLowerCase().replace(/\s+board$/, "");
  if (!name) return null;
  return db().boards.find((item) => item.name.toLowerCase() === name) || null;
}

function noBoard(args) {
  const names = db().boards.map((item) => item.name).join(", ");
  return result({ ok: false, status: "error", error: `I do not have a board called ${args.board || "that"}. Your boards are ${names}.` });
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
    brainstorm: null,
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
    if (note.deletedAt || note.idea) continue;
    const title = note.title.toLowerCase();
    const body = `${plainText(note.content)} ${plainText(note.back)}`.toLowerCase();
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
  const prefs = board().look;
  if (prefs.defaultColorMode === "fixed") return prefs.fixedColor || "yellow";
  return prefs.lastColor || "yellow";
}

function blankNote(args) {
  const spot = nextSpot();
  const prefs = board().look;
  const color = COLORS.includes(args.color) ? args.color : defaultColor();
  return normalizeNote({
    id: newId(),
    boardId: findBoard(args)?.id || board().id,
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
  const used = db().notes.filter((note) => !note.deletedAt && !note.archivedAt && note.boardId === board().id).length;
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
    if (filter.boardId && note.boardId !== filter.boardId) return false;
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

// The page sees the open board's notes. The trash holds every board's, since a deleted board's notes wait there.
function publicView(filter = {}) {
  purgeTrash();
  const current = board();
  const notes = sortNotes(filterNotes(db().notes, { boardId: current.id, ...filter }), filter.sort || current.sort);
  return {
    version: 1,
    board: current,
    boards: db().boards.map((item) => ({ id: item.id, name: item.name })),
    prefs: { ...db().prefs, ...current.look },
    colorMeanings: current.colorMeanings,
    notes: notes.map(present),
    proposals: db().proposals.filter((item) => item.boardId === current.id),
    trash: db().notes.filter((note) => note.deletedAt).map(present),
    groups: groupNotes(notes, filter.group || board().group),
    pending: db().pending,
  };
}

function finish(note, status, extra = {}) {
  if (note?.id) lastNoteId = note.id;
  if (note?.color && note.color !== "custom") board().look.lastColor = note.color;
  save();
  return result({ ok: true, status, note: present(note), ...extra });
}

function toolCreate(args, actor) {
  const note = blankNote(args);
  db().notes.push(note);
  audit(actor, "sticky_note_create", note.id, note.title || plainText(note.content));
  db().pending = null;
  return finish(note, "created", { classifyIds: note.content ? [note.id] : [], brainstorm: (note.content && duplicateJob(note)) || brainstormJob(note), ui: { open: true } });
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
  // The back of the note: more room, small type. Not shown on the board until the corner is turned.
  if (typeof args.back === "string") {
    note.back = sanitizeHtml(args.back.slice(0, 8000));
    touch(note);
  }
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
  return finish(note, "updated", { classifyIds: classify ? [note.id] : [], brainstorm: classify ? (duplicateJob(note) || brainstormJob(note)) : null });
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
    const home = db().boards.find((item) => item.id === note.boardId);
    if (home) home.ink = (home.ink || []).filter((stroke) => stroke.noteId !== note.id);
    db().proposals = db().proposals.filter((item) => item.noteId !== note.id && item.fromId !== note.id);
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
    notes = filterNotes(db().notes, { completedMonth: { year, month }, noteType: "task", boardId: board().id });
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
  // A note whose board was deleted comes back on the first board.
  if (!db().boards.some((item) => item.id === note.boardId)) note.boardId = db().boards[0].id;
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

/** The lines or list items of a note as checklist items, when it already reads as a list. */
function localSteps(html) {
  const items = [...String(html || "").matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)].map((m) => plainText(m[1]));
  const lines = items.length ? items : String(html || "").split(/<br\s*\/?>|<\/(?:div|p)>/i).map(plainText);
  return lines.map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim()).filter((line) => line.length > 1).slice(0, 20);
}

function toolConvert(args, actor, toTask) {
  const found = resolveOne(args);
  if (found.hits) return choose(found.hits, toTask ? "sticky_note_convert_to_task" : "sticky_note_convert_to_note", args);
  if (found.error) return fail(found.error);
  const note = found.note;
  note.noteType = toTask ? "task" : "note";
  if (toTask && note.taskStatus !== "done") note.taskStatus = "open";
  // A to-do gets its parts as checks: at once when the note is already a list, else the model splits it.
  let steps = null;
  if (toTask && !note.checklist.length && plainText(note.content)) {
    const lines = localSteps(note.content);
    if (lines.length >= 2) note.checklist = lines.map((text) => ({ id: newId(), text: clip(text, 240), done: false }));
    else steps = { boardId: note.boardId, noteId: note.id, mode: "steps", now: true };
  }
  if (args.priority && PRIORITIES.includes(args.priority)) {
    note.priority = args.priority;
    note.prioritySource = "user";
    note.priorityLocked = true;
  }
  if (args.dueAt) note.dueAt = args.dueAt;
  touch(note);
  audit(actor, toTask ? "sticky_note_convert_to_task" : "sticky_note_convert_to_note", note.id, note.noteType);
  db().pending = null;
  return finish(note, "converted", { brainstorm: steps, ui: { open: true, view: toTask ? "tasks" : "board" } });
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
  if (args.last) args = { ...args, id: lastNoteId || "missing" };
  const found = resolveOne(args);
  if (found.hits) return choose(found.hits, "sticky_note_move", args);
  if (found.error) return fail(found.error);
  let target = null;
  if (args.boardId || args.board) {
    target = findBoard(args);
    if (!target) return noBoard(args);
  }
  if (Number.isFinite(args.x)) found.note.positionX = args.x;
  if (Number.isFinite(args.y)) found.note.positionY = args.y;
  if (target) found.note.boardId = target.id;
  touch(found.note);
  audit(actor, "sticky_note_move", found.note.id, target ? `Moved to ${target.name}` : "Moved");
  db().pending = null;
  if (target) return finish(found.note, "moved", { board: { id: target.id, name: target.name }, ui: { open: true } });
  return finish(found.note, "updated");
}

function toolBoardCreate(args, actor) {
  const name = clip(String(args.name || "").trim(), 60);
  if (!name) return result({ ok: false, status: "error", error: "Say a name for the board." });
  if (db().boards.some((item) => item.name.toLowerCase() === name.toLowerCase())) {
    return result({ ok: false, status: "error", error: `You already have a board called ${name}.` });
  }
  // A new board starts with the look of the open one, on a plain wood background.
  const from = board();
  const made = { ...blankBoard(newId(), name), look: { ...from.look }, colorMeanings: { ...from.colorMeanings } };
  db().boards.push(made);
  db().currentBoardId = made.id;
  audit(actor, "sticky_board_create", "", name);
  db().pending = null;
  save();
  return result({ ok: true, status: "board_created", board: { id: made.id, name }, ui: { open: true, view: "board" } });
}

function toolBoardSwitch(args, actor) {
  const target = findBoard(args);
  if (!target) return noBoard(args);
  db().currentBoardId = target.id;
  audit(actor, "sticky_board_switch", "", target.name);
  db().pending = null;
  save();
  return result({ ok: true, status: "board_switched", board: { id: target.id, name: target.name }, ui: { open: true, view: "board" } });
}

function toolBoardRename(args, actor) {
  const target = findBoard(args) || board();
  const name = clip(String(args.name || "").trim(), 60);
  if (!name) return result({ ok: false, status: "error", error: "Say a name for the board." });
  if (db().boards.some((item) => item !== target && item.name.toLowerCase() === name.toLowerCase())) {
    return result({ ok: false, status: "error", error: `You already have a board called ${name}.` });
  }
  target.name = name;
  target.updatedAt = iso(nowFn());
  audit(actor, "sticky_board_rename", "", name);
  save();
  return result({ ok: true, status: "board_renamed", board: { id: target.id, name } });
}

/** The board's notes go to the trash, where the usual days to restore apply. The last board stays. */
function toolBoardDelete(args, actor) {
  const target = findBoard(args);
  if (!target) return noBoard(args);
  if (db().boards.length === 1) return result({ ok: false, status: "error", error: "That is your only board, so I kept it." });
  const notes = db().notes.filter((note) => note.boardId === target.id && !note.deletedAt);
  if (!args.confirm) {
    return needConfirm("sticky_board_delete", { boardId: target.id }, `Delete the ${target.name} board? Its ${notes.length} ${notes.length === 1 ? "note goes" : "notes go"} to the trash.`);
  }
  for (const note of notes) note.deletedAt = iso(nowFn());
  db().boards = db().boards.filter((item) => item.id !== target.id);
  if (db().currentBoardId === target.id) db().currentBoardId = db().boards[0].id;
  audit(actor, "sticky_board_delete", "", `${target.name}, ${notes.length} notes to trash`);
  db().pending = null;
  save();
  return result({ ok: true, status: "board_deleted", board: { id: target.id, name: target.name }, notes: notes.map(present), ui: { open: true, view: "board" } });
}

/** A real note changed on a board that is brainstorming. Ideas and the model's own edits do not count. */
function brainstormJob(note) {
  const home = db().boards.find((item) => item.id === note.boardId);
  if (!home?.brainstorm.on || note.idea || !plainText(note.content)) return null;
  const others = db().notes.filter((item) => item.boardId === home.id && item.id !== note.id && alive(item) && !item.archivedAt);
  return { boardId: home.id, noteId: note.id, first: others.length === 0 };
}

/** "Brainstorm about X" opens a board named X with the topic as its first note, then asks for ideas. */
function toolBrainstormStart(args, actor) {
  const topic = clip(String(args.topic || "").replace(/\s+/g, " ").trim(), 200);
  if (!topic) return result({ ok: false, status: "error", error: "Say what to brainstorm about." });
  const name = clip(topic.charAt(0).toUpperCase() + topic.slice(1), 40);
  let target = findBoard({ board: name });
  if (!target) {
    const made = toolBoardCreate({ name }, actor);
    if (!made.ok) return made;
    target = findBoard({ boardId: made.board.id });
  }
  db().currentBoardId = target.id;
  target.brainstorm = { ...target.brainstorm, on: true, topic };
  const seed = blankNote({ content: topic, boardId: target.id });
  db().notes.push(seed);
  audit(actor, "sticky_brainstorm_start", seed.id, topic);
  db().pending = null;
  return finish(seed, "brainstorm_started", {
    board: { id: target.id, name: target.name },
    classifyIds: [seed.id],
    brainstorm: { boardId: target.id, noteId: seed.id, first: true, now: true },
    ui: { open: true, view: "board" },
  });
}

function toolBrainstormSet(args, actor) {
  const target = findBoard(args) || board();
  target.brainstorm = { ...target.brainstorm, on: Boolean(args.on), topic: target.brainstorm.topic || target.name };
  if (!target.brainstorm.on) db().proposals = db().proposals.filter((item) => item.boardId !== target.id);
  audit(actor, "sticky_brainstorm_set", "", `${target.name} ${target.brainstorm.on ? "on" : "off"}`);
  db().pending = null;
  save();
  return result({ ok: true, status: target.brainstorm.on ? "brainstorm_on" : "brainstorm_off", board: { id: target.id, name: target.name }, ui: { open: true } });
}

/**
 * Keep or drop one idea note or one suggestion. A dropped idea is not offered again on that board.
 * A "merge" suggestion folds one note into another: yes writes the combined text into the
 * note that stayed and moves the dragged one to the trash.
 */
function toolIdea(args, actor, keep) {
  const proposal = db().proposals.find((item) => item.id === args.id);
  const note = proposal ? noteById(proposal.noteId) : noteById(args.id);
  if (!note || (!proposal && !note.idea)) return fail("not_found");
  const home = db().boards.find((item) => item.id === note.boardId) || board();
  if (proposal) db().proposals = db().proposals.filter((item) => item.id !== proposal.id);
  if (!keep) {
    if (proposal?.kind !== "merge" && proposal?.kind !== "shorten") home.brainstorm.rejected = [...home.brainstorm.rejected, clip(proposal ? proposal.content : plainText(note.content), 120)].slice(-20);
    if (!proposal) {
      db().notes = db().notes.filter((item) => item.id !== note.id);
      home.ink = (home.ink || []).filter((stroke) => stroke.noteId !== note.id);
    }
    audit(actor, "sticky_idea_reject", note.id, proposal ? "Kept the note as it was" : "Dropped an idea");
    save();
    return result({ ok: true, status: "idea_rejected" });
  }
  if (proposal?.kind === "merge") {
    const from = noteById(proposal.fromId);
    if (from && alive(from)) {
      from.deletedAt = iso(nowFn());
      db().proposals = db().proposals.filter((item) => item.noteId !== from.id && item.fromId !== from.id);
    }
    if (proposal.title) {
      note.title = proposal.title;
      note.titleSource = "ai";
    }
    applyContent(note, proposal.content);
  } else if (proposal?.kind === "shorten") {
    if (!plainText(note.back)) note.back = note.content;
    applyContent(note, proposal.content);
  } else if (proposal) applyContent(note, proposal.content);
  else note.idea = false;
  // The mascot pin marks every note the model wrote or rewrote.
  if (proposal) note.mark = "claude";
  touch(note);
  audit(actor, "sticky_idea_accept", note.id, proposal ? "Took the suggestion" : "Kept an idea");
  return finish(note, "idea_accepted", { classifyIds: [note.id] });
}

/** Every idea and suggestion waiting on the open board, in one go. */
function toolIdeaAll(args, actor, keep) {
  const home = findBoard(args) || board();
  const ids = [
    ...db().proposals.filter((item) => item.boardId === home.id).map((item) => item.id),
    ...db().notes.filter((note) => note.boardId === home.id && note.idea && alive(note)).map((note) => note.id),
  ];
  let count = 0;
  for (const id of ids) if (toolIdea({ id }, actor, keep).ok) count += 1;
  return result({ ok: true, status: keep ? "ideas_kept" : "ideas_dropped", count });
}

/** Ideas that grow out of one note (branch) or say the same thing differently (more). Works with brainstorm off too. */
function toolIdeaFrom(args, actor, mode) {
  const found = resolveOne(args);
  if (found.hits) return choose(found.hits, mode === "more" ? "sticky_idea_more" : "sticky_idea_branch", args);
  if (found.error) return fail(found.error);
  audit(actor, mode === "more" ? "sticky_idea_more" : "sticky_idea_branch", found.note.id, found.note.title || plainText(found.note.content));
  db().pending = null;
  return result({ ok: true, status: "thinking", note: present(found.note), brainstorm: { boardId: found.note.boardId, noteId: found.note.id, mode, now: true } });
}

/** One round over the whole board: poke holes in every kept note, or sort them into themes. */
function toolBrainstormRound(args, actor, mode) {
  const home = findBoard(args) || board();
  const kept = db().notes.filter((note) => note.boardId === home.id && alive(note) && !note.archivedAt && !note.idea);
  if (kept.length < (mode === "themes" ? 3 : 1)) return result({ ok: false, status: "error", error: mode === "themes" ? "Keep at least three notes first." : "There is nothing on this board yet." });
  audit(actor, mode === "themes" ? "sticky_brainstorm_themes" : "sticky_brainstorm_challenge", "", home.name);
  db().pending = null;
  return result({ ok: true, status: "thinking", brainstorm: { boardId: home.id, noteId: kept[0].id, mode, now: true } });
}

/** A pasted list: one note per line, laid out as a grid from the given spot. */
function toolCreateMany(args, actor) {
  const lines = (Array.isArray(args.lines) ? args.lines : String(args.text || "").split(/\r?\n/))
    .map((line) => String(line).replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim())
    .filter(Boolean)
    .slice(0, 40);
  if (!lines.length) return result({ ok: false, status: "error", error: "There is nothing to paste." });
  const home = findBoard(args) || board();
  const startX = Number.isFinite(args.x) ? args.x : 72;
  const startY = Number.isFinite(args.y) ? args.y : 64;
  const notes = lines.map((line, index) => {
    const note = blankNote({ content: line, boardId: home.id, x: startX + 260 * (index % 4), y: startY + 230 * Math.floor(index / 4) });
    db().notes.push(note);
    return note;
  });
  audit(actor, "sticky_note_create_many", notes[0].id, `${notes.length} notes from a list`);
  db().pending = null;
  save();
  return result({ ok: true, status: "created_many", notes: notes.map(present), classifyIds: notes.map((note) => note.id), ui: { open: true } });
}

/** A dropped idea comes back as an idea to tick, and leaves the list of things not to offer again. */
function toolIdeaRestore(args, actor) {
  const home = findBoard(args) || board();
  const text = String(args.text || "").trim();
  const index = home.brainstorm.rejected.indexOf(text);
  if (index < 0) return fail("not_found");
  home.brainstorm.rejected.splice(index, 1);
  const note = blankNote({ content: text, boardId: home.id });
  note.idea = true;
  note.titleLocked = false;
  note.mark = "claude";
  db().notes.push(note);
  audit(actor, "sticky_idea_restore", note.id, text);
  db().pending = null;
  return finish(note, "idea_restored");
}

/** A round that reads the whole board: summary note, plan, or ideas from the user's files. */
function toolBoardRound(args, actor, mode) {
  const home = findBoard(args) || board();
  const kept = db().notes.filter((note) => note.boardId === home.id && alive(note) && !note.archivedAt && !note.idea && !note.summary);
  if (!kept.length && mode !== "files") return result({ ok: false, status: "error", error: "There is nothing on this board yet." });
  if (mode === "files" && !fileSearch) return result({ ok: false, status: "error", error: "File search is not set up on this server." });
  audit(actor, `sticky_board_${mode}`, "", home.name);
  db().pending = null;
  return result({ ok: true, status: "thinking", brainstorm: { boardId: home.id, noteId: kept[0]?.id || "", mode, now: true, topic: clip(String(args.topic || ""), 200) } });
}

// Boards drawn ready to fill in. Each has header notes and lines on the ink layer.
const TEMPLATES = {
  swot: { name: "SWOT", cells: [["Strengths", 0, 0], ["Weaknesses", 1, 0], ["Opportunities", 0, 1], ["Threats", 1, 1]], columns: 2, rows: 2 },
  proscons: { name: "Pros and cons", cells: [["Pros", 0, 0], ["Cons", 1, 0]], columns: 2, rows: 1 },
  eisenhower: { name: "Urgent and important", cells: [["Do now (urgent, important)", 0, 0], ["Schedule (important)", 1, 0], ["Delegate (urgent)", 0, 1], ["Drop (neither)", 1, 1]], columns: 2, rows: 2 },
  week: { name: "Week", cells: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"].map((day, index) => [day, index, 0]), columns: 7, rows: 1 },
};
export const TEMPLATE_NAMES = Object.keys(TEMPLATES);

function toolBoardTemplate(args, actor) {
  const template = TEMPLATES[String(args.template || "").toLowerCase().replace(/[^a-z]/g, "")];
  if (!template) return result({ ok: false, status: "error", error: `Pick one of: ${TEMPLATE_NAMES.join(", ")}.` });
  const made = toolBoardCreate({ name: clip(String(args.name || "").trim(), 40) || template.name }, actor);
  if (!made.ok) return made;
  const home = findBoard({ boardId: made.board.id });
  const left = 60;
  const top = 60;
  const cellW = template.columns > 2 ? 420 : 900;
  const cellH = template.rows > 1 ? 700 : 1300;
  const right = left + cellW * template.columns;
  const bottom = top + cellH * template.rows;
  const ink = [];
  for (let column = 0; column <= template.columns; column += 1) ink.push({ tool: "line", color: "#5a4632", size: 3, points: [[left + cellW * column, top], [left + cellW * column, bottom]] });
  for (let row = 0; row <= template.rows; row += 1) ink.push({ tool: "line", color: "#5a4632", size: 3, points: [[left, top + cellH * row], [right, top + cellH * row]] });
  home.ink = ink;
  for (const [label, column, row] of template.cells) {
    const note = blankNote({ title: label, content: "", boardId: home.id, x: left + cellW * column + 20, y: top + cellH * row + 20, width: Math.min(260, cellW - 40), height: 120, color: "white", rotation: 0 });
    note.isPinned = true;
    db().notes.push(note);
  }
  audit(actor, "sticky_board_template", "", `${home.name} from ${template.name}`);
  save();
  return result({ ok: true, status: "board_created", board: { id: home.id, name: home.name }, ui: { open: true, view: "board" } });
}

/**
 * A note that says much the same as another on its board. The mascot then offers to combine them.
 * Word overlap only, so no model call unless two notes really do look alike.
 */
function duplicateJob(note) {
  const words = (item) => new Set(`${item.title} ${plainText(item.content)}`.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((word) => word.length > 3 && !SEARCH_SKIP.has(word)));
  const mine = words(note);
  if (mine.size < 3) return null;
  let best = null;
  for (const other of db().notes) {
    if (other.id === note.id || other.boardId !== note.boardId || !alive(other) || other.archivedAt || other.idea || other.summary) continue;
    const theirs = words(other);
    if (theirs.size < 3) continue;
    let shared = 0;
    for (const word of mine) if (theirs.has(word)) shared += 1;
    const score = shared / (mine.size + theirs.size - shared);
    if (score >= 0.6 && (!best || score > best.score)) best = { other, score };
  }
  if (!best || db().proposals.some((item) => item.kind === "merge" && (item.fromId === note.id || item.noteId === note.id))) return null;
  return { boardId: note.boardId, noteId: best.other.id, fromId: note.id, mode: "merge", why: "sounds like" };
}

/** A web page (GitHub, a paper, any article) read into at most ten notes. The reading happens in the round. */
function toolImportUrl(args, actor) {
  const url = importableUrl(args.url);
  if (!url) return result({ ok: false, status: "error", error: "Give me a web address that starts with http." });
  const home = findBoard(args) || board();
  audit(actor, "sticky_import_url", "", url.hostname);
  db().pending = null;
  return result({ ok: true, status: "thinking", brainstorm: { boardId: home.id, noteId: "", mode: "import", now: true, url: url.href } });
}

/** The kept notes of a board by their first hashtag, for consolidating. Only themes with two or more notes count. */
function themeGroups(home) {
  const groups = new Map();
  for (const note of db().notes) {
    if (note.boardId !== home.id || !alive(note) || note.archivedAt || note.idea || note.summary || !note.hashtags.length) continue;
    const tag = note.hashtags[0];
    if (!groups.has(tag.key)) groups.set(tag.key, { name: tag.display, notes: [] });
    groups.get(tag.key).notes.push(note);
  }
  return [...groups.values()].filter((group) => group.notes.length >= 2);
}

/** After sorting into themes: one note per theme, the old notes written on its back and moved to the trash. */
function toolConsolidate(args, actor) {
  const home = findBoard(args) || board();
  if (home.group !== "hashtag") return result({ ok: false, status: "error", error: "Sort the board into themes first." });
  const groups = themeGroups(home);
  if (!groups.length) return result({ ok: false, status: "error", error: "No theme has two notes to combine." });
  audit(actor, "sticky_brainstorm_consolidate", "", `${groups.length} themes on ${home.name}`);
  db().pending = null;
  return result({ ok: true, status: "thinking", brainstorm: { boardId: home.id, noteId: groups[0].notes[0].id, mode: "consolidate", now: true } });
}

/** A shorter version of one note, shown before and after for a yes or no. Yes keeps the long text on the back. */
function toolSummarizeNote(args, actor) {
  const found = resolveOne(args);
  if (found.hits) return choose(found.hits, "sticky_note_summarize", args);
  if (found.error) return fail(found.error);
  if (plainText(found.note.content).split(/\s+/).length < 12) return result({ ok: false, status: "error", error: "That note is already short." });
  audit(actor, "sticky_note_summarize", found.note.id, found.note.title || plainText(found.note.content));
  db().pending = null;
  return result({ ok: true, status: "thinking", note: present(found.note), brainstorm: { boardId: found.note.boardId, noteId: found.note.id, mode: "shorten", now: true } });
}

/** One note dropped on another. The model writes the combined text; the bubble asks before anything changes. */
function toolCombine(args, actor) {
  const from = noteById(args.id);
  const into = noteById(args.intoId);
  if (!from || !into || !alive(from) || !alive(into) || from.id === into.id) return fail("not_found");
  if (from.boardId !== into.boardId) return result({ ok: false, status: "error", error: "Those notes are on different boards." });
  audit(actor, "sticky_note_combine", into.id, `${clip(from.title || plainText(from.content), 40)} + ${clip(into.title || plainText(into.content), 40)}`);
  db().pending = null;
  return result({ ok: true, status: "thinking", brainstorm: { boardId: from.boardId, noteId: into.id, fromId: from.id, mode: "merge", now: true } });
}

const brainstormTimers = new Map();
const brainstormBusy = new Map();

export function scheduleBrainstorm(job, ask) {
  if (!job || !ask) return;
  clearTimeout(brainstormTimers.get(job.boardId));
  brainstormTimers.set(job.boardId, setTimeout(() => {
    brainstormTimers.delete(job.boardId);
    runBrainstorm(job, ask).catch((err) => console.error("Failed while brainstorming:", err?.message || err));
  }, job.now ? 0 : brainstormDelay));
}

/**
 * One model call for one finished edit. The reply only makes idea notes and
 * suggested changes; nothing the user wrote changes until they accept it.
 * A second edit during the call runs once the first call ends.
 */
export async function runBrainstorm(job, ask) {
  if (brainstormBusy.has(job.boardId)) {
    brainstormBusy.set(job.boardId, job);
    return result({ ok: false, status: "busy" });
  }
  brainstormBusy.set(job.boardId, null);
  try {
    return await brainstormOnce(job, ask);
  } finally {
    const again = brainstormBusy.get(job.boardId);
    brainstormBusy.delete(job.boardId);
    if (again) scheduleBrainstorm(again, ask);
  }
}

/** What every prompt says about how to think: the user's brief and how bold to be. */
function brainstormStyle(home) {
  const wild = Number.isFinite(home.brainstorm.wild) ? home.brainstorm.wild : 50;
  return [
    home.brainstorm.brief ? `What the user cares about: ${home.brainstorm.brief}.` : "",
    wild <= 33 ? "Keep ideas practical and low-risk: things that could be done this week." : "",
    wild >= 67 ? "Be bold: include unusual, ambitious ideas, even if they are a stretch." : "",
  ].filter(Boolean).join(" ");
}

const ROUND_MESSAGES = {
  merge: "Combining the notes…",
  summary: "Summing up the board…",
  plan: "Turning the board into a plan…",
  files: "Reading your files…",
  import: "Reading the page…",
  challenge: "Looking for weak spots…",
  themes: "Sorting into themes…",
  consolidate: "Consolidating the themes…",
  shorten: "Writing a shorter version…",
  steps: "Listing the steps…",
};

/** Ideas placed in a ring around a note, with an arrow from the note to each, so the board reads as a mind map. */
function placeAround(home, anchor, notes) {
  const radius = 340;
  const cx = anchor.positionX + anchor.width / 2;
  const cy = anchor.positionY + anchor.height / 2;
  notes.forEach((note, index) => {
    const angle = -Math.PI / 2 + (index * 2 * Math.PI) / notes.length + (index ? 0 : 0.0001);
    const nx = cx + radius * Math.cos(angle);
    const ny = cy + radius * Math.sin(angle);
    note.positionX = Math.max(0, Math.round(nx - note.width / 2));
    note.positionY = Math.max(0, Math.round(ny - note.height / 2));
    const dx = Math.cos(angle);
    const dy = Math.sin(angle);
    home.ink = [...(home.ink || []), {
      tool: "arrow", color: "#1e2a32", size: 3, noteId: note.id,
      points: [[Math.round(cx + dx * 130), Math.round(cy + dy * 110)], [Math.round(nx - dx * 130), Math.round(ny - dy * 110)]],
    }];
  });
}

async function brainstormOnce(job, ask) {
  const home = db().boards.find((item) => item.id === job.boardId);
  const changed = noteById(job.noteId);
  const mode = job.mode || "follow";
  const needsNote = !["files", "import"].includes(mode);
  if (!home || (needsNote && !alive(changed)) || (mode === "follow" && !home.brainstorm.on)) return result({ ok: false, status: "off" });
  const from = mode === "merge" ? noteById(job.fromId) : null;
  if (mode === "merge" && !alive(from)) return result({ ok: false, status: "off" });
  const onBoard = db().notes.filter((note) => note.boardId === home.id && alive(note) && !note.archivedAt && !note.summary).slice(-30);
  const line = (note, tag = "") => `- [${note.id}]${tag}${note.idea ? " (idea, not kept yet)" : ""} ${note.title ? `${note.title}: ` : ""}${clip(plainText(note.content), 240)}`;
  const lines = onBoard.map((note) => line(note, changed && note.id === changed.id ? " (CHANGED)" : ""));
  const meanings = Object.entries(home.colorMeanings).map(([color, meaning]) => `${color}=${meaning}`).join(", ");
  const topic = `Topic: ${home.brainstorm.topic || home.name}.`;
  const voice = "Write in the same language as the notes.";
  const shapes = {
    follow: [
      "You help someone brainstorm on a sticky-note board. Reply with JSON only, no markdown.",
      '{"add":[{"title":"short title","content":"the idea","color":"yellow"}],"edit":[{"id":"note id","content":"the whole new text","reason":"why, in a few words"}]}',
      topic, `Each idea is one concrete step or thought, under 25 words. ${voice} Never repeat what the board already has.`,
      job.first
        ? "This is the first note. Give 5 ideas that cover different sides of the topic. No edits."
        : "The note marked CHANGED was just written. Give at most 2 new ideas that follow from it, and at most 1 edit to another note that the change makes out of date or could make better. Empty lists are fine.",
      `Colors and what they mean: ${meanings}.`,
    ],
    branch: [
      "You help someone brainstorm on a sticky-note board. Reply with JSON only, no markdown.",
      '{"add":[{"title":"short title","content":"the idea","color":"yellow"}]}',
      topic, "Give 4 ideas that grow out of the note marked CHANGED: next steps, parts of it, or ways to do it.",
      `Each idea is one concrete step or thought, under 25 words. ${voice} Never repeat what the board already has.`,
      `Colors and what they mean: ${meanings}.`,
    ],
    more: [
      "You help someone brainstorm on a sticky-note board. Reply with JSON only, no markdown.",
      '{"add":[{"title":"short title","content":"the idea","color":"yellow"}]}',
      topic, "Give 3 alternatives to the note marked CHANGED: the same aim, reached a different way.",
      `Each is one concrete step or thought, under 25 words. ${voice} Never repeat what the board already has.`,
      `Colors and what they mean: ${meanings}.`,
    ],
    challenge: [
      "You are a critical friend looking at a sticky-note board. Reply with JSON only, no markdown.",
      '{"holes":[{"id":"note id","title":"two or three words","content":"the risk or the question"}]}',
      topic, "For each kept note (not the ideas), give the one biggest risk, missing piece, or question it raises. Under 20 words each. Skip a note if it has no real weak spot.",
      voice,
    ],
    themes: [
      "You tidy a sticky-note board. Reply with JSON only, no markdown.",
      '{"themes":[{"name":"one or two words","ids":["note id"]}]}',
      topic, "Sort the kept notes (not the ideas) into 2 to 6 themes. Every note goes in exactly one theme. Theme names are short, with no # sign.",
      voice,
    ],
    merge: [
      "You combine two sticky notes into one. Reply with JSON only, no markdown.",
      '{"title":"short title","content":"the combined note"}',
      "Keep every fact from both notes, drop what they repeat, and keep it under 60 words. Keep the tone of the notes.",
      voice,
    ],
  };
  const today = iso(nowFn()).slice(0, 10);
  shapes.summary = [
    "You sum up a sticky-note board. Reply with JSON only, no markdown.",
    '{"content":"the summary"}',
    topic, "Three short lines at most: what the board is about, what has been decided or planned, and what is still open. Plain sentences, no bullets.",
    voice,
  ];
  shapes.plan = [
    "You turn a sticky-note board into a plan. Reply with JSON only, no markdown.",
    '{"plan":{"title":"short title","from":"YYYY-MM-DD","to":"YYYY-MM-DD or empty","place":"place or empty","comment":"who does what, in a few lines"},"tasks":[{"id":"note id","dueAt":"YYYY-MM-DD"}]}',
    topic, `Today is ${today}. Give every kept note (not the ideas) a due date in a sensible order, the earliest first. The plan runs from the first due date to the last.`,
    voice,
  ];
  shapes.steps = [
    "You turn one sticky note into a checklist. Reply with JSON only, no markdown.",
    '{"items":["first step"]}',
    "List the things to do to finish this note, in order, 1 to 6 items, each under 12 words. One item if the note is a single action.",
    voice,
  ];
  shapes.shorten = [
    "You shorten one sticky note. Reply with JSON only, no markdown.",
    '{"content":"the shorter note"}',
    "Keep every fact, name, number and action; drop repeats and filler. Aim for a third of the length, under 40 words. Keep the tone.",
    voice,
  ];
  const themed = mode === "consolidate" ? themeGroups(home) : [];
  if (mode === "consolidate") {
    shapes.consolidate = [
      "You consolidate a sticky-note board. Reply with JSON only, no markdown.",
      '{"themes":[{"name":"the theme name as given","title":"short title","content":"one note that holds every point of the theme"}]}',
      topic, "For each theme, write one note that keeps every fact and action from its notes, drops repeats, and stays under 80 words. Keep the theme names exactly as given.",
      voice,
    ];
  }
  let files = [];
  if (mode === "files") {
    const query = [job.topic, home.brainstorm.topic || home.name, home.brainstorm.brief].filter(Boolean).join(" ");
    try {
      files = (await fileSearch(query)).filter((file) => file && plainText(file.text)).slice(0, 5);
    } catch (err) {
      console.error("Failed while searching files for ideas:", err?.message || err);
    }
    if (!files.length) {
      notify({ reason: "ideas", boardId: home.id, count: 0, error: "I found nothing in your files about this." });
      return result({ ok: false, status: "no_files", error: "I found nothing in your files about this." });
    }
    shapes.files = [
      "You help someone brainstorm on a sticky-note board, using only excerpts from their own files. Reply with JSON only, no markdown.",
      '{"add":[{"title":"short title","content":"the idea","source":"file name"}]}',
      topic, "Give 5 ideas that come from the excerpts: facts, past decisions, names, numbers, or steps the files mention. Each under 25 words, with the file it came from. Nothing the excerpts do not support.",
      voice,
    ];
  }
  let page = null;
  if (mode === "import") {
    notify({ reason: "brainstorming", boardId: home.id, what: ROUND_MESSAGES.import });
    try {
      page = await pageReader(job.url);
    } catch (err) {
      console.error("Failed while reading a page for stickies:", err?.message || err);
      const error = `I could not read that page. ${err?.message || ""}`.trim();
      notify({ reason: "ideas", boardId: home.id, count: 0, error });
      return result({ ok: false, status: "no_page", error });
    }
    shapes.import = [
      "You turn a web page into sticky notes for a board. Reply with JSON only, no markdown.",
      '{"add":[{"title":"short title","content":"the point"}]}',
      page.kind === "paper"
        ? "This is a scientific paper. Give up to 10 notes: the question, the design and setting, the sample, the main findings with their numbers, side effects or limitations, and what it means in practice."
        : page.kind === "github"
          ? "This is a code repository. Give up to 10 notes: what it does, who it is for, how to install, the key commands or API, main features, requirements, and caveats."
          : "Give up to 10 notes with the page's key ideas, facts, numbers, and steps.",
      "Each note is one idea, under 30 words, in the language of the page. Titles under 5 words. Fewer notes is fine when the page says less.",
    ];
  }
  const text = mode === "shorten" || mode === "steps"
    ? `${changed.title ? `${changed.title}: ` : ""}${clip(plainText(changed.content), 1500)}`
    : mode === "consolidate"
    ? themed.map((group) => `Theme: ${group.name}\n${group.notes.map((note) => `- ${note.title ? `${note.title}: ` : ""}${clip(plainText(note.content), 300)}`).join("\n")}`).join("\n\n")
    : mode === "import"
    ? `Page: ${page.title}\n${job.url}\n\n${page.text}`
    : mode === "merge"
    ? `First note: ${from.title ? `${from.title}: ` : ""}${clip(plainText(from.content), 600)}\nSecond note: ${changed.title ? `${changed.title}: ` : ""}${clip(plainText(changed.content), 600)}`
    : mode === "files"
      ? `${lines.length ? `Board:\n${lines.join("\n")}\n\n` : ""}Files:\n${files.map((file) => `### ${clip(plainText(file.name), 120)}\n${clip(String(file.text), 2500)}`).join("\n\n")}`
      : lines.join("\n");
  const instruction = [
    ...shapes[mode],
    ["merge", "summary", "plan", "import", "consolidate", "shorten", "steps"].includes(mode) ? "" : brainstormStyle(home),
    ["merge", "themes", "summary", "plan", "import", "consolidate", "shorten", "steps"].includes(mode) ? "" : (home.brainstorm.rejected.length ? `The user turned down these, so do not offer them again: ${home.brainstorm.rejected.join(" | ")}.` : ""),
  ].filter(Boolean).join(" ");
  if (mode !== "import") notify({ reason: "brainstorming", boardId: home.id, what: ROUND_MESSAGES[mode] || "" });
  let data;
  try {
    const raw = await ask(instruction, text, 900);
    data = JSON.parse(String(raw || "").replace(/```json|```/g, "").trim());
    if (!data || typeof data !== "object") throw new Error("the reply is not an object");
  } catch (err) {
    console.error("Failed while reading brainstorm ideas:", err?.message || err);
    const error = { merge: "I could not combine those just now.", steps: "I could not list the steps just now.", shorten: "I could not shorten that just now.", consolidate: "I could not consolidate the themes just now.", summary: "I could not sum up the board just now.", plan: "I could not make a plan just now." }[mode] || "I could not think of ideas just now.";
    notify({ reason: "ideas", boardId: home.id, count: 0, error });
    return result({ ok: false, status: "ai_down", error });
  }
  const anchor = noteById(job.noteId) || changed;
  const idea = (item, spot) => {
    const note = blankNote({
      content: clip(plainText(item.content), 400),
      title: clip(plainText(item.title), 120),
      color: COLORS.includes(item.color) && item.color !== "custom" ? item.color : "",
      boardId: home.id,
      x: spot.x,
      y: spot.y,
    });
    note.idea = true;
    note.titleLocked = false;
    note.colorSource = "ai";
    note.mark = "claude";
    db().notes.push(note);
    return note;
  };

  if (mode === "merge") {
    if (!plainText(data.content)) {
      notify({ reason: "ideas", boardId: home.id, count: 0, error: "I could not combine those just now." });
      return result({ ok: false, status: "ai_down" });
    }
    db().proposals = db().proposals.filter((old) => old.noteId !== anchor.id && old.fromId !== from.id);
    db().proposals.push({
      id: newId(), kind: "merge", boardId: home.id, noteId: anchor.id, fromId: from.id,
      title: clip(plainText(data.title), 120),
      content: sanitizeHtml(clip(plainText(data.content), 600)),
      reason: job.why === "sounds like" ? `“${clip(from.title || plainText(from.content), 40)}” sounds like “${clip(anchor.title || plainText(anchor.content), 40)}”.` : "",
      at: iso(nowFn()),
    });
    audit("agent", "sticky_note_combine", anchor.id, "Combined text ready");
    save();
    notify({ reason: "ideas", boardId: home.id, count: 1 });
    return result({ ok: true, status: "ideas", proposals: 1 });
  }

  if (mode === "import") {
    const adds = (Array.isArray(data.add) ? data.add : []).filter((item) => plainText(item?.content)).slice(0, 10);
    if (!adds.length) {
      notify({ reason: "ideas", boardId: home.id, count: 0, error: "I found nothing on that page worth a note." });
      return result({ ok: false, status: "ai_down" });
    }
    const spot = nextSpot();
    const safeUrl = String(job.url).replace(/"/g, "%22");
    const source = blankNote({
      title: clip(page.title, 120), boardId: home.id, x: spot.x, y: spot.y, color: "white",
      content: `<a href="${safeUrl}">${safeUrl.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</a>`,
    });
    source.mark = "claude";
    db().notes.push(source);
    const made = adds.map((item, index) => {
      const note = blankNote({
        content: clip(plainText(item.content), 400), title: clip(plainText(item.title), 120), boardId: home.id,
        x: spot.x + 260 * ((index + 1) % 4), y: spot.y + 230 * Math.floor((index + 1) / 4),
      });
      note.mark = "claude";
      db().notes.push(note);
      return note;
    });
    audit("agent", "sticky_import_url", source.id, `${made.length} notes from ${page.title}`);
    save();
    scheduleClassify(made.map((note) => note.id), ask);
    notify({ reason: "ideas", boardId: home.id, count: made.length, error: "" });
    return result({ ok: true, status: "imported", count: made.length, notes: [source, ...made].map(present) });
  }

  if (mode === "steps") {
    const items = (Array.isArray(data.items) ? data.items : []).map((item) => clip(plainText(item), 240)).filter(Boolean).slice(0, 6);
    if (!items.length || changed.checklist.length || changed.noteType !== "task") return result({ ok: false, status: "off" });
    changed.checklist = items.map((text) => ({ id: newId(), text, done: false }));
    touch(changed);
    audit("agent", "sticky_note_steps", changed.id, `${items.length} checks`);
    save();
    notify({ reason: "ideas", boardId: home.id, count: items.length, quiet: true });
    return result({ ok: true, status: "steps", count: items.length });
  }

  if (mode === "shorten") {
    const content = clip(plainText(data.content), 400);
    if (!content || content.length >= plainText(changed.content).length) {
      notify({ reason: "ideas", boardId: home.id, count: 0, error: "I could not make that note shorter." });
      return result({ ok: false, status: "ai_down" });
    }
    db().proposals = db().proposals.filter((old) => old.noteId !== changed.id);
    db().proposals.push({ id: newId(), kind: "shorten", boardId: home.id, noteId: changed.id, content: sanitizeHtml(content), reason: "A shorter version. The full text goes on the back.", at: iso(nowFn()) });
    audit("agent", "sticky_note_summarize", changed.id, "Shorter version ready");
    save();
    notify({ reason: "ideas", boardId: home.id, count: 1 });
    return result({ ok: true, status: "ideas", proposals: 1 });
  }

  if (mode === "consolidate") {
    const escape = (value) => String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const written = [];
    for (const item of Array.isArray(data.themes) ? data.themes : []) {
      const group = themed.find((candidate) => tagKey(candidate.name) === tagKey(item?.name));
      if (!group || !plainText(item.content) || written.includes(group)) continue;
      written.push(group);
      const first = group.notes[0];
      const note = blankNote({
        title: clip(plainText(item.title) || group.name, 120), content: clip(plainText(item.content), 600), boardId: home.id,
        x: first.positionX, y: first.positionY, color: first.color, hashtags: [group.name],
      });
      note.mark = "claude";
      // The old notes, one after another, on the back.
      note.back = sanitizeHtml(group.notes.map((old) => `<b>${escape(old.title || "Note")}</b><br>${old.content}`).join("<br><br>"));
      db().notes.push(note);
      for (const old of group.notes) {
        old.deletedAt = iso(nowFn());
        db().proposals = db().proposals.filter((p) => p.noteId !== old.id && p.fromId !== old.id);
        home.ink = (home.ink || []).filter((stroke) => stroke.noteId !== old.id);
      }
    }
    audit("agent", "sticky_brainstorm_consolidate", "", `${written.length} themes consolidated`);
    save();
    notify({ reason: "ideas", boardId: home.id, count: written.length, error: written.length ? "" : "I could not consolidate the themes just now." });
    return result({ ok: true, status: "consolidated", count: written.length });
  }

  if (mode === "summary") {
    const content = clip(plainText(data.content), 600);
    if (!content) {
      notify({ reason: "ideas", boardId: home.id, count: 0, error: "I could not sum up the board just now." });
      return result({ ok: false, status: "ai_down" });
    }
    let note = db().notes.find((item) => item.boardId === home.id && item.summary && alive(item));
    if (!note) {
      note = blankNote({ title: "Summary", content, boardId: home.id, x: 40, y: 40, color: "white", width: 320, height: 200, rotation: 0 });
      note.summary = true;
      note.isPinned = true;
      note.mark = "claude";
      db().notes.push(note);
    } else applyContent(note, content);
    touch(note);
    audit("agent", "sticky_board_summary", note.id, "Summary written");
    save();
    notify({ reason: "ideas", boardId: home.id, count: 1 });
    return result({ ok: true, status: "summarized", note: present(note) });
  }

  if (mode === "plan") {
    const kept = onBoard.filter((note) => !note.idea);
    const day = (value) => (/^\d{4}-\d{2}-\d{2}$/.test(String(value || "")) && !Number.isNaN(Date.parse(value)) ? String(value) : "");
    let dated = 0;
    for (const task of (Array.isArray(data.tasks) ? data.tasks : []).slice(0, 40)) {
      const note = kept.find((item) => item.id === task?.id);
      const when = day(task?.dueAt);
      if (!note || !when) continue;
      note.noteType = "task";
      if (!note.taskStatus) note.taskStatus = "open";
      note.dueAt = `${when}T09:00:00`;
      touch(note);
      dated += 1;
    }
    const plan = data.plan && typeof data.plan === "object" ? data.plan : {};
    let planTitle = "";
    if (planMaker && day(plan.from)) {
      const made = planMaker({ title: plan.title || home.name, from: day(plan.from), to: day(plan.to), place: plan.place || "", comment: plan.comment || "" });
      if (made?.plan) planTitle = made.plan.title;
      else if (made?.error) console.error("Failed while adding the board plan:", made.error);
    }
    home.taskView = "tasks";
    audit("agent", "sticky_board_plan", "", `${dated} tasks dated${planTitle ? `, plan “${planTitle}”` : ""}`);
    save();
    notify({ reason: "ideas", boardId: home.id, count: dated, error: dated ? "" : "I could not put dates on these notes.", plan: planTitle });
    return result({ ok: true, status: "planned", count: dated, plan: planTitle });
  }

  if (mode === "themes") {
    const kept = onBoard.filter((note) => !note.idea);
    let sorted = 0;
    for (const theme of (Array.isArray(data.themes) ? data.themes : []).slice(0, 8)) {
      const name = clip(plainText(theme?.name).replace(/^#+/, ""), 40);
      if (!name) continue;
      for (const id of Array.isArray(theme.ids) ? theme.ids : []) {
        const note = kept.find((item) => item.id === id);
        if (!note) continue;
        note.hashtags = normalizeTags([...note.hashtags, name], note.hashtags);
        touch(note);
        sorted += 1;
      }
    }
    if (sorted) {
      home.group = "hashtag";
      home.layout = "organized";
    }
    audit("agent", "sticky_brainstorm_themes", "", `${sorted} notes sorted`);
    save();
    notify({ reason: "ideas", boardId: home.id, count: sorted, error: sorted ? "" : "I could not find themes in these notes." });
    return result({ ok: true, status: "ideas", count: sorted });
  }

  let made = [];
  if (mode === "challenge") {
    const kept = onBoard.filter((note) => !note.idea);
    const seen = new Set();
    for (const hole of (Array.isArray(data.holes) ? data.holes : []).slice(0, 12)) {
      const target = kept.find((item) => item.id === hole?.id);
      if (!target || seen.has(target.id) || !plainText(hole.content)) continue;
      seen.add(target.id);
      // Sits just under the note it questions, in the color that means a problem.
      made.push(idea({ ...hole, title: hole.title || "Watch out", color: "pink" }, { x: target.positionX + 24, y: target.positionY + target.height + 16 }));
    }
  } else {
    const limit = { follow: job.first ? 5 : 2, branch: 4, more: 3, files: 5 }[mode];
    const adds = (Array.isArray(data.add) ? data.add : []).filter((item) => plainText(item?.content)).slice(0, limit)
      .map((item) => (mode === "files" && plainText(item.source) ? { ...item, content: `${plainText(item.content)} (from: ${clip(plainText(item.source), 80)})` } : item));
    made = adds.map((item, index) => idea(item, mode === "follow" || mode === "files"
      ? (job.first || mode === "files"
        ? { x: anchor.positionX + 260 * (1 + (index % 3)), y: anchor.positionY + 230 * Math.floor(index / 3) }
        : { x: anchor.positionX + 260, y: anchor.positionY + 230 * index })
      : { x: anchor.positionX, y: anchor.positionY }));
    if (mode !== "follow" && mode !== "files") placeAround(home, anchor, made);
  }
  const edits = mode !== "follow" || job.first ? [] : (Array.isArray(data.edit) ? data.edit : []).slice(0, 1).filter((item) => {
    const target = noteById(item?.id);
    return target && alive(target) && !target.idea && target.boardId === home.id && target.id !== job.noteId && plainText(item.content);
  });
  for (const item of edits) {
    db().proposals = db().proposals.filter((old) => old.noteId !== item.id);
    db().proposals.push({
      id: newId(),
      kind: "edit",
      boardId: home.id,
      noteId: item.id,
      content: sanitizeHtml(clip(plainText(item.content), 400)),
      reason: clip(plainText(item.reason), 120),
      at: iso(nowFn()),
    });
  }
  audit("agent", "sticky_brainstorm", job.noteId, `${made.length} ideas, ${edits.length} changes`);
  save();
  notify({ reason: "ideas", boardId: home.id, count: made.length + edits.length });
  return result({ ok: true, status: "ideas", notes: made.map(present), proposals: edits.length });
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
    db().notes.filter((note) => alive(note) && !note.idea && !note.archivedAt && !note.hashtags.length && plainText(note.content)).forEach((note) => ids.push(note.id));
  } else {
    db().notes.filter((note) => alive(note) && !note.idea && !note.archivedAt && plainText(note.content)).forEach((note) => ids.push(note.id));
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
        // Search looks on every board. The page only shows the open one, so say how many are elsewhere.
        const found = searchHits(args.query || "").slice(0, args.limit || 12).map((hit) => present(hit.note));
        const elsewhere = found.filter((note) => note.boardId !== board().id).length;
        return result({ ok: true, status: "listed", notes: found, elsewhere, ui: { open: true, filter: { q: args.query || "" } } });
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
      case "sticky_board_create": return toolBoardCreate(args, actor);
      case "sticky_board_switch": return toolBoardSwitch(args, actor);
      case "sticky_board_rename": return toolBoardRename(args, actor);
      case "sticky_board_delete": return toolBoardDelete(args, actor);
      case "sticky_brainstorm_start": return toolBrainstormStart(args, actor);
      case "sticky_brainstorm_set": return toolBrainstormSet(args, actor);
      case "sticky_idea_accept": return toolIdea(args, actor, true);
      case "sticky_idea_reject": return toolIdea(args, actor, false);
      case "sticky_idea_accept_all": return toolIdeaAll(args, actor, true);
      case "sticky_idea_reject_all": return toolIdeaAll(args, actor, false);
      case "sticky_idea_branch": return toolIdeaFrom(args, actor, "branch");
      case "sticky_idea_more": return toolIdeaFrom(args, actor, "more");
      case "sticky_brainstorm_challenge": return toolBrainstormRound(args, actor, "challenge");
      case "sticky_brainstorm_themes": return toolBrainstormRound(args, actor, "themes");
      case "sticky_brainstorm_consolidate": return toolConsolidate(args, actor);
      case "sticky_note_combine": return toolCombine(args, actor);
      case "sticky_note_summarize": return toolSummarizeNote(args, actor);
      case "sticky_note_create_many": return toolCreateMany(args, actor);
      case "sticky_idea_restore": return toolIdeaRestore(args, actor);
      case "sticky_ideas_from_files": return toolBoardRound(args, actor, "files");
      case "sticky_board_summary": return toolBoardRound(args, actor, "summary");
      case "sticky_board_plan": return toolBoardRound(args, actor, "plan");
      case "sticky_board_template": return toolBoardTemplate(args, actor);
      case "sticky_import_url": return toolImportUrl(args, actor);
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
  const home = db().boards.find((item) => item.id === note.boardId) || board();
  if (home.look.defaultColorMode === "auto" && note.colorSource !== "user") {
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
  // A web address keeps its punctuation, so it is matched before the cleanup below.
  const link = String(question || "").trim().match(/^(?:please |hey )?(?:import|read) (?:ideas |notes |stickies )?(?:from )?(https?:\/\/\S+)(?: (?:as|into|to) (?:stickies|sticky notes|notes|the board))?[.!]?$/i);
  if (link) return { tool: "sticky_import_url", args: { url: link[1].replace(/[.,;)]+$/, "") } };
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

  // Before the note pattern, so "new sticky board called Work" is a board, not a note.
  let match = said.match(/^(?:please |hey )?(?:create|make|add|start) (?:me )?(?:a )?(?:new )?(?:sticky )?board (?:called|named) (.+)$/i)
    || said.match(/^(?:please |hey )?new (?:sticky )?board (?:called|named) (.+)$/i);
  if (match) return { tool: "sticky_board_create", args: { name: match[1].trim() } };

  match = said.match(/^(?:please |hey )?(?:create|make|add|put|new|save) (?:me )?(?:a |an )?(?:(yellow|pink|blue|green|orange|purple|white|gray|grey) )?(?:sticky(?: note)?|stickie) (?:reminding me (?:to )?|to remind me (?:to )?|that |about |saying |to )?(.+)$/i);
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

  match = said.match(/^(?:please |hey )?(?:let s |lets |let us |help me )?brainstorm(?: ideas)? (?:about |on |for |around |ideas for )?(.+)$/i);
  if (match && !/^(?:mode|(?:mode )?(?:on|off))$/i.test(match[1])) return { tool: "sticky_brainstorm_start", args: { topic: match[1].replace(/\s+/g, " ").trim() } };
  match = q.match(/^(?:please |hey )?(?:turn |switch )?(on|off) brainstorm(?:ing)?(?: mode)?$/) || q.match(/^(?:please |hey )?(?:turn |switch )?brainstorm(?:ing)?(?: mode)? (on|off)$/);
  if (match) return { tool: "sticky_brainstorm_set", args: { on: match[1] === "on" } };
  if (/^(?:please |hey )?stop brainstorming$/.test(q)) return { tool: "sticky_brainstorm_set", args: { on: false } };
  if (/^(?:please |hey )?(?:poke holes|find (?:the )?(?:weak spots|risks|holes))(?: in (?:this|the|my) (?:board|notes|ideas|plan))?$/.test(q)) return { tool: "sticky_brainstorm_challenge", args: {} };
  if (/^(?:please |hey )?(?:sort|group) (?:(?:this|the|my) (?:board|notes) )?(?:in)?to themes$/.test(q)) return { tool: "sticky_brainstorm_themes", args: {} };
  if (/^(?:please |hey )?consolidate (?:the |my )?(?:themes|notes|board)$/.test(q)) return { tool: "sticky_brainstorm_consolidate", args: {} };
  match = q.match(/^(?:please |hey )?(keep|accept|drop|reject) (?:all|every) (?:the |of the )?(?:ideas?|suggestions?)$/);
  if (match) return { tool: /keep|accept/.test(match[1]) ? "sticky_idea_accept_all" : "sticky_idea_reject_all", args: {} };
  match = said.match(/^(?:please |hey )?(?:branch|grow|expand) (?:ideas |more )?(?:from|on|out of) (?:the )?(?:note |sticky )?(?:about |called |titled )?(.+)$/i);
  if (match) return { tool: "sticky_idea_branch", args: { query: match[1].trim() } };
  match = said.match(/^(?:please |hey )?(?:more|other|alternative) (?:ideas |options |ways )?(?:like|for|to) (?:the )?(?:note |sticky |one )?(?:about |called |titled )?(.+)$/i);
  if (match) return { tool: "sticky_idea_more", args: { query: match[1].trim() } };
  if (/^(?:please |hey )?(?:summarize|summarise|sum up) (?:this|the|my) (?:sticky )?board$/.test(q)) return { tool: "sticky_board_summary", args: {} };
  match = said.match(/^(?:please |hey )?(?:summarize|summarise|shorten|sum up) (?:the |my )?(?:note|sticky) (?:about |called |titled )?(.+)$/i);
  if (match) return { tool: "sticky_note_summarize", args: { query: match[1].trim() } };
  if (/^(?:please |hey )?(?:turn|make|convert) (?:this|the|my) (?:sticky )?board into a plan$/.test(q)) return { tool: "sticky_board_plan", args: {} };
  match = said.match(/^(?:please |hey )?ideas from my (?:files|notes|wiki|documents)(?: (?:about|on|for) (.+))?$/i);
  if (match) return { tool: "sticky_ideas_from_files", args: { topic: (match[1] || "").trim() } };
  match = said.match(/^(?:please |hey )?new (?:sticky )?board from (?:the )?(swot|pros and cons|pros\/cons|eisenhower|urgent and important|week) template(?: called (.+))?$/i);
  if (match) return { tool: "sticky_board_template", args: { template: match[1].toLowerCase().replace(/urgent and important/, "eisenhower").replace(/pros.*cons/, "proscons"), name: (match[2] || "").trim() } };

  match = q.match(/^(?:please |hey )?(?:switch|go|change) (?:over )?to (?:the |my )?(.+?) (?:sticky )?board$/);
  if (match && match[1] !== "bulletin") return { tool: "sticky_board_switch", args: { board: match[1] } };

  match = q.match(/^(?:please |hey )?(?:put|move) (?:that|it|this)(?: note| sticky(?: note)?)? (?:on|to|onto|in|into) (?:the |my )?(.+?) board$/);
  if (match) return { tool: "sticky_note_move", args: { last: true, board: match[1] } };
  match = q.match(/^(?:please |hey )?move (?:the |my )?(?:sticky )?note about (.+?) to (?:the |my )?(.+?) board$/);
  if (match) return { tool: "sticky_note_move", args: { query: match[1], board: match[2] } };
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
  scheduleBrainstorm(toolResult.brainstorm, ask);
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
    if (!count) return "I did not find a sticky note for that.";
    const other = toolResult.elsewhere ? ` ${toolResult.elsewhere} ${toolResult.elsewhere === 1 ? "is" : "are"} on another board.` : "";
    return `I found ${count} sticky ${count === 1 ? "note" : "notes"}.${other}`;
  }
  if (toolResult.status === "cancelled") return "Okay, I left the notes as they are.";
  if (toolResult.status === "not_found") return "I could not find that sticky note.";
  if (toolResult.status === "linked") return "Those notes are linked.";
  if (toolResult.status === "moved") return `I moved that note to the ${toolResult.board.name} board.`;
  if (toolResult.status === "brainstorm_started") return `I opened the ${toolResult.board.name} board in brainstorm mode. Ideas will pop up in a moment. Tick the ones you want.`;
  if (toolResult.status === "brainstorm_on") return `Brainstorm mode is on for the ${toolResult.board.name} board. When you finish a note, I will suggest more.`;
  if (toolResult.status === "brainstorm_off") return `Brainstorm mode is off for the ${toolResult.board.name} board.`;
  if (toolResult.status === "thinking") return "Give me a moment. It will show up on the board.";
  if (toolResult.status === "created_many") return `Made ${toolResult.notes.length} notes from the list.`;
  if (toolResult.status === "imported") return `Made ${toolResult.count} notes from the page.`;
  if (toolResult.status === "idea_restored") return "Brought the idea back. Tick it to keep it.";
  if (toolResult.status === "ideas_kept") return toolResult.count ? `Kept ${toolResult.count === 1 ? "the idea" : `all ${toolResult.count} ideas`}.` : "There were no ideas waiting.";
  if (toolResult.status === "ideas_dropped") return toolResult.count ? `Dropped ${toolResult.count === 1 ? "the idea" : `all ${toolResult.count} ideas`}.` : "There were no ideas waiting.";
  if (toolResult.status === "board_created") return `I made the ${toolResult.board.name} board and opened it.`;
  if (toolResult.status === "board_switched") return `Here is the ${toolResult.board.name} board.`;
  if (toolResult.status === "board_renamed") return `The board is now called ${toolResult.board.name}.`;
  if (toolResult.status === "board_deleted") {
    const count = toolResult.notes.length;
    return `I deleted the ${toolResult.board.name} board.${count ? ` Its ${count} ${count === 1 ? "note is" : "notes are"} in the trash.` : ""}`;
  }
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
  scheduleBrainstorm(toolResult.brainstorm, ask);
  if (toolResult.ui) notify({ ...toolResult.ui, reason: toolResult.status });
  if (toolResult.note?.id) toolResult.note = present(noteById(toolResult.note.id)) || toolResult.note;
  return { text: speak(toolResult), result: toolResult };
}

export function setHooksForTests({ findFiles = null, addPlan = null, readPage = fetchForImport } = {}) {
  fileSearch = findFiles;
  planMaker = addPlan;
  pageReader = readPage;
}

export function resetForTests(file, initial = null) {
  filePath = file;
  notify = () => {};
  classifyDelay = 0;
  brainstormDelay = 0;
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

const INK_TOOLS = ["pen", "line", "arrow"];

/** Board drawings as sent by the page, kept to numbers, a hex color and a sane size. */
export function cleanInk(list) {
  return list.slice(-1000).flatMap((stroke) => {
    if (!INK_TOOLS.includes(stroke?.tool) || !Array.isArray(stroke.points)) return [];
    const points = stroke.points.slice(0, 4000)
      .filter((point) => Array.isArray(point) && Number.isFinite(point[0]) && Number.isFinite(point[1]))
      .map((point) => [Math.round(point[0] * 10) / 10, Math.round(point[1] * 10) / 10]);
    if (points.length < 2) return [];
    const color = /^#[0-9a-f]{6}$/i.test(stroke.color) ? stroke.color : "#1e2a32";
    const size = Math.min(40, Math.max(1, Number(stroke.size) || 4));
    const kept = { tool: stroke.tool, color, size, points: stroke.tool === "pen" ? points : [points[0], points.at(-1)] };
    // An arrow drawn for a branched idea goes when the idea goes.
    if (typeof stroke.noteId === "string") kept.noteId = stroke.noteId.slice(0, 40);
    return [kept];
  });
}

/** The open board's kept notes, top to bottom, for Export (stickyexport.js). Ideas not kept yet are left out. */
export function boardForExport() {
  const current = board();
  const notes = sortNotes(filterNotes(db().notes, { boardId: current.id }), "manual").filter((note) => !note.idea);
  return { name: current.name, notes };
}

export function viewForTests(filter) {
  return publicView(filter);
}

export function registerStickies(app, { askModel, findFiles = null, addPlan = null } = {}) {
  const ask = askModel || (async () => "");
  fileSearch = findFiles;
  planMaker = addPlan;

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

  // A pan saved a moment after a switch carries the board it belongs to.
  app.put("/stickies/board", (req, res) => {
    try {
      const body = req.body || {};
      const current = (body.boardId && findBoard({ boardId: body.boardId })) || board();
      if (body.name != null) {
        const renamed = toolBoardRename({ boardId: current.id, name: body.name }, "user");
        if (!renamed.ok) {
          res.status(400).json({ error: renamed.error });
          return;
        }
      }
      for (const key of ["background", "backgroundColor", "layout", "sort", "group", "taskView"]) {
        if (body[key] != null) current[key] = body[key];
      }
      if (body.backgroundImage != null) {
        const image = String(body.backgroundImage);
        current.backgroundImage = image.length > 2_000_000 ? "" : image;
      }
      for (const key of ["zoom", "panX", "panY"]) if (Number.isFinite(body[key])) current[key] = body[key];
      if (Array.isArray(body.ink)) current.ink = cleanInk(body.ink);
      if (body.brief != null) current.brainstorm.brief = clip(String(body.brief).replace(/\s+/g, " ").trim(), 400);
      if (Number.isFinite(body.wild)) current.brainstorm.wild = Math.max(0, Math.min(100, Math.round(body.wild)));
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
      const current = board();
      const sent = req.body?.prefs || {};
      db().prefs = { ...db().prefs, ...pick(sent, Object.keys(APP_PREFS)) };
      current.look = { ...current.look, ...pick(sent, Object.keys(BOARD_LOOK)) };
      if (req.body?.colorMeanings) current.colorMeanings = { ...current.colorMeanings, ...req.body.colorMeanings };
      save();
      res.json({ prefs: { ...db().prefs, ...current.look }, colorMeanings: current.colorMeanings });
    } catch (err) {
      console.error("Failed while saving sticky-note settings:", err?.message || err);
      res.status(500).json({ error: "Could not save those settings." });
    }
  });

  app.post("/stickies/notes", (req, res) => {
    const made = runTool("sticky_note_create", req.body || {}, "user");
    scheduleClassify(made.classifyIds, ask);
    scheduleBrainstorm(made.brainstorm, ask);
    res.status(made.ok ? 200 : 400).json(made);
  });

  app.patch("/stickies/notes/:id", (req, res) => {
    const made = runTool("sticky_note_update", { ...(req.body || {}), id: req.params.id }, "user");
    scheduleClassify(made.classifyIds, ask);
    scheduleBrainstorm(made.brainstorm, ask);
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
    scheduleBrainstorm(made.brainstorm, ask);
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
