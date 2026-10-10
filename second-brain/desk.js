/**
 * The desk is the work that should still be here after a restart.
 *
 * It is one private file, desk.json, next to this file. The git repo
 * ignores it. Three kinds of things live in it:
 *   jobs         a page to watch, a reminder, or a draft waiting for "send it"
 *   suggestions  short ideas (reply to a recent email) you can do or skip
 *   memory       the last voice conversation, so the next call can continue it
 *
 * This file only stores and understands those things. Opening Outlook,
 * texting the phone, and reading a web page happen in server.js.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "desk.json");
const MAX_WATCHES = 8;
const MAX_SUGGESTIONS = 4;
const MAX_JOBS = 40;

const EMPTY = {
  jobs: [],
  suggestions: [],
  dismissed: [],
  memory: { summary: "", turns: [], savedAt: "" },
};

let state = load();

function load() {
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE, "utf8"));
    return {
      jobs: Array.isArray(parsed.jobs) ? parsed.jobs : [],
      suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions : [],
      dismissed: Array.isArray(parsed.dismissed) ? parsed.dismissed : [],
      memory: {
        summary: typeof parsed.memory?.summary === "string" ? parsed.memory.summary : "",
        turns: Array.isArray(parsed.memory?.turns) ? parsed.memory.turns : [],
        savedAt: typeof parsed.memory?.savedAt === "string" ? parsed.memory.savedAt : "",
      },
    };
  } catch (err) {
    if (err.code !== "ENOENT") console.error("Failed while reading desk.json:", err.message);
    return structuredClone(EMPTY);
  }
}

function save() {
  try {
    const tmp = `${FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, FILE);
  } catch (err) {
    console.error("Failed while saving desk.json:", err.message);
  }
}

function nowIso() {
  return new Date().toISOString();
}

function newId() {
  return crypto.randomBytes(4).toString("hex");
}

function clip(value, max) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

/** Drop finished jobs when the file gets long. Waiting work always stays. */
function trimJobs() {
  const keep = [];
  const done = [];
  for (const job of state.jobs) {
    if (job.status === "waiting" || job.status === "needs-you" || job.status === "alerted") keep.push(job);
    else done.push(job);
  }
  state.jobs = [...keep, ...done.slice(-MAX_JOBS)];
}

function pushJob(job) {
  const saved = {
    id: newId(),
    created: nowIso(),
    updated: nowIso(),
    receipt: "",
    ...job,
  };
  state.jobs.push(saved);
  trimJobs();
  save();
  return saved;
}

/** A newer draft replaces the one that was still waiting. */
function retireDrafts(type) {
  for (const job of state.jobs) {
    if (job.kind === "draft" && job.status === "needs-you" && job.draft?.type === type) {
      job.status = "skipped";
      job.receipt = "Replaced by a newer draft.";
      job.updated = nowIso();
    }
  }
}

export function publicDesk() {
  const openJobs = state.jobs.filter((job) =>
    job.status === "waiting" || job.status === "needs-you" || job.status === "alerted");
  return {
    jobs: openJobs.map((job) => ({
      id: job.id,
      kind: job.kind,
      status: job.status,
      title: job.title,
      detail: job.detail,
      receipt: job.receipt,
      url: job.url || "",
      draftType: job.draft?.type || "",
    })),
    suggestions: state.suggestions.map((item) => ({
      id: item.id,
      title: item.title,
      source: item.source,
      detail: item.detail,
    })),
    memory: {
      summary: state.memory.summary,
      savedAt: state.memory.savedAt,
      lastQuestion: state.memory.turns.at(-1)?.question || "",
      turns: state.memory.turns,
    },
  };
}

export function savedChat() {
  return {
    summary: state.memory.summary,
    turns: state.memory.turns,
  };
}

export function rememberChat(summary, turns) {
  state.memory = {
    summary: clip(summary, 2000),
    turns: (Array.isArray(turns) ? turns : []).slice(-6).map((turn) => ({
      question: clip(turn.question, 500),
      answer: clip(turn.answer, 1500) || "(no answer yet)",
    })).filter((turn) => turn.question),
    savedAt: nowIso(),
  };
  save();
}

export function forgetChat() {
  state.memory = { summary: "", turns: [], savedAt: "" };
  save();
}

export function saveEmailDraft({ to, name, subject, body, original }) {
  const letter = String(body || "").trim();
  if (!letter) return null;
  retireDrafts("email");
  return pushJob({
    kind: "draft",
    status: "needs-you",
    title: clip(subject, 180) || "Email draft",
    detail: "Say send it to open this in Outlook, or don't to drop it. Nothing is sent until you press Send.",
    draft: {
      type: "email",
      to: clip(to, 200),
      name: clip(name, 80),
      subject: clip(subject, 200) || "Note",
      body: letter.slice(0, 20000),
      original: String(original || "").slice(0, 8000),
    },
  });
}

export function saveMeetingDraft(plan, detail) {
  retireDrafts("meeting");
  return pushJob({
    kind: "draft",
    status: "needs-you",
    title: clip(plan.subject, 180) || "Meeting",
    detail: clip(detail, 400),
    draft: {
      type: "meeting",
      subject: clip(plan.subject, 180) || "Meeting",
      body: clip(plan.body, 1000),
      location: clip(plan.location, 120),
      who: clip(plan.who, 120),
      duration: Number(plan.duration) || 60,
      date: plan.date instanceof Date ? plan.date.toISOString() : String(plan.date || ""),
      assumedDay: Boolean(plan.assumedDay),
      assumedTime: Boolean(plan.assumedTime),
    },
  });
}

export function latestDraft() {
  return [...state.jobs].reverse().find((job) => job.kind === "draft" && job.status === "needs-you") || null;
}

export function jobById(id) {
  return state.jobs.find((job) => job.id === id) || null;
}

export function finishJob(id, status, receipt) {
  const job = jobById(id);
  if (!job) return null;
  job.status = status;
  job.receipt = clip(receipt, 300);
  job.updated = nowIso();
  save();
  return job;
}

/** Mark the email draft that Outlook just opened, so the card goes away. */
export function finishLatestEmail(receipt) {
  const job = [...state.jobs].reverse().find((item) =>
    item.kind === "draft" && item.status === "needs-you" && item.draft?.type === "email");
  if (!job) return null;
  return finishJob(job.id, "done", receipt);
}

export function addWatch(url, title) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch (err) {
    console.error("Failed while reading a watch address:", err.message);
    return { ok: false, text: "That does not look like a web address." };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, text: "I can only watch a normal web page, starting with https." };
  }
  const href = parsed.href;
  const existing = state.jobs.find((job) =>
    job.kind === "watch" && job.url === href && (job.status === "waiting" || job.status === "alerted"));
  const name = clip(title, 120) || parsed.hostname;
  if (existing) {
    existing.title = name;
    existing.status = "waiting";
    existing.lastText = "";
    existing.receipt = "Watching again from a fresh copy of the page.";
    existing.updated = nowIso();
    save();
    return { ok: true, text: `I am watching ${name} again. I will text you if the page changes.` };
  }
  const active = state.jobs.filter((job) =>
    job.kind === "watch" && (job.status === "waiting" || job.status === "alerted"));
  if (active.length >= MAX_WATCHES) {
    return { ok: false, text: "You already have 8 pages being watched. Say stop watching, then add a new one." };
  }
  pushJob({
    kind: "watch",
    status: "waiting",
    title: name,
    detail: "I will text you if this page changes.",
    url: href,
    lastText: "",
    receipt: "Not checked yet.",
  });
  return { ok: true, text: `I am watching ${name}. I will text you if the page changes. The first check only learns what the page says now.` };
}

export function watchesToCheck() {
  return state.jobs.filter((job) => job.kind === "watch" && (job.status === "waiting" || job.status === "alerted"));
}

/** Remember what the page says. Returns the job when the words changed. */
export function recordWatch(id, hash, errorText) {
  const job = jobById(id);
  if (!job) return null;
  job.updated = nowIso();
  if (errorText) {
    job.receipt = clip(errorText, 200);
    save();
    return null;
  }
  if (!job.lastText) {
    job.lastText = hash;
    job.receipt = "Watching. I will text you if this page changes.";
    job.status = "waiting";
    save();
    return null;
  }
  if (job.lastText === hash) {
    job.receipt = "No change since the last check.";
    save();
    return null;
  }
  job.lastText = hash;
  job.status = "alerted";
  job.receipt = "This page changed.";
  save();
  return job;
}

export function cancelWatches() {
  let count = 0;
  for (const job of state.jobs) {
    if (job.kind === "watch" && (job.status === "waiting" || job.status === "alerted")) {
      job.status = "skipped";
      job.receipt = "You asked me to stop watching.";
      job.updated = nowIso();
      count += 1;
    }
  }
  if (count) save();
  return count;
}

export function clearAlerts() {
  let count = 0;
  for (const job of state.jobs) {
    if (job.status === "alerted") {
      job.status = "done";
      job.receipt = "You dismissed this alert.";
      job.updated = nowIso();
      count += 1;
    }
  }
  if (count) save();
  return count;
}

export function addReminder(title, dueAt) {
  const when = new Date(dueAt);
  const job = pushJob({
    kind: "reminder",
    status: "waiting",
    title: clip(title, 180),
    detail: `I will text you at ${when.toLocaleString("en-US", { weekday: "long", hour: "numeric", minute: "2-digit" })}.`,
    dueAt: when.getTime(),
    receipt: "Waiting.",
  });
  return job;
}

export function takeDueReminders(now = Date.now()) {
  const due = state.jobs.filter((job) => job.kind === "reminder" && job.status === "waiting" && job.dueAt <= now);
  for (const job of due.slice(0, 5)) {
    job.status = "done";
    job.receipt = "Reminded you.";
    job.updated = nowIso();
  }
  if (due.length) save();
  return due.slice(0, 5);
}

export function jobsSentence() {
  const open = state.jobs.filter((job) =>
    job.status === "waiting" || job.status === "needs-you" || job.status === "alerted");
  if (!open.length) {
    return "Nothing is waiting. You can say watch and a web address, remind me in 20 minutes to, and then the task, or ask me to draft an email.";
  }
  const lines = open.map((job) => {
    if (job.kind === "draft") return `A draft is waiting: ${job.title}. Say send it, or don't.`;
    if (job.kind === "watch") return job.status === "alerted"
      ? `${job.title} changed. Say got it when you have seen it.`
      : `Watching ${job.title}.`;
    return `Reminder: ${job.title}.`;
  });
  const count = open.length === 1 ? "One job" : `${open.length} jobs`;
  return `${count}. ${lines.join(" ")}`;
}

export function suggestionsSentence() {
  if (!state.suggestions.length) return "I have no ideas waiting. Recent emails show up here when there is one from the last two days.";
  const lines = state.suggestions.map((item, index) => `${index + 1}, ${item.title}, ${item.source}`);
  return `Ideas you can skip. ${lines.join(". ")}. Say do number one, or skip number one.`;
}

/**
 * Replace the idea list with the latest emails.
 * Anything you already skipped stays skipped.
 */
export function mergeSuggestions(items) {
  const next = [];
  for (const item of items) {
    const key = String(item.key || "");
    if (!key || state.dismissed.includes(key)) continue;
    if (next.length >= MAX_SUGGESTIONS) break;
    next.push({
      id: crypto.createHash("sha256").update(key).digest("hex").slice(0, 12),
      key,
      title: clip(item.title, 180),
      source: clip(item.source, 80),
      detail: clip(item.detail, 180),
    });
  }
  state.suggestions = next;
  save();
  return next;
}

export function suggestionById(id) {
  return state.suggestions.find((item) => item.id === id) || null;
}

export function suggestionAt(index) {
  return state.suggestions[index] || null;
}

export function dismissSuggestion(id) {
  const item = suggestionById(id);
  if (!item) return null;
  if (!state.dismissed.includes(item.key)) state.dismissed.push(item.key);
  state.dismissed = state.dismissed.slice(-200);
  state.suggestions = state.suggestions.filter((entry) => entry.id !== id);
  save();
  return item;
}

function pullUrl(text) {
  const found = String(text).match(/https?:\/\/[^\s]+/i)
    || String(text).match(/\b(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s]*)?/i);
  if (!found) return "";
  let url = found[0].replace(/[.,!?;)]+$/g, "");
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
    return parsed.href;
  } catch (err) {
    console.error("Failed while reading a web address from speech:", err.message);
    return "";
  }
}

const NUMBER = { one: 0, first: 0, "1": 0, two: 1, second: 1, "2": 1, three: 2, third: 2, "3": 2, four: 3, fourth: 3, "4": 3 };

function clockOnDay(day, hour, minute, mark) {
  let h = hour;
  if (mark === "pm" && h < 12) h += 12;
  if (mark === "am" && h === 12) h = 0;
  if (!mark) return null;
  const when = new Date(day);
  when.setHours(h, minute, 0, 0);
  return when;
}

/**
 * Turn a spoken request into a desk action.
 * Returns null when the sentence is about something else.
 */
export function parseDesk(question) {
  const q = String(question || "").trim().replace(/^["“'\s.,]+|["”'\s.?!]+$/g, "");
  if (!q) return null;

  if (/^(?:please\s+)?(?:stop watching|cancel (?:the )?watches|cancel (?:the )?watch|stop the watch)\b/i.test(q)) {
    return { action: "cancel-watches" };
  }
  if (/^(?:please\s+)?(?:got it|dismiss that|clear the alert)\b/i.test(q)) {
    return { action: "clear-alerts" };
  }
  if (/^(?:please\s+)?(?:what(?:'s| is) (?:waiting|on your list)|what jobs|my jobs|what are you watching|list (?:the )?jobs)\b/i.test(q)) {
    return { action: "jobs" };
  }
  if (/^(?:please\s+)?(?:what should i do|any suggestions|what are the ideas|list (?:the )?ideas)\b/i.test(q)) {
    return { action: "suggestions" };
  }
  if (/^(?:please\s+)?(?:yes[, ]+)?(?:send it|open it|go ahead|open that|yes send it)[.!]*$/i.test(q)) {
    return { action: "confirm" };
  }
  if (/^(?:please\s+)?(?:don'?t|do not send it|drop it|cancel that|never mind|nevermind)[.!]*$/i.test(q)) {
    return { action: "skip" };
  }

  const picked = q.match(/^(?:please\s+)?(do|skip) (?:the )?(?:number )?(one|two|three|four|first|second|third|fourth|1|2|3|4)(?: suggestion| idea)?$/i);
  if (picked) {
    return { action: picked[1].toLowerCase() === "do" ? "do" : "skip-suggestion", index: NUMBER[picked[2].toLowerCase()] };
  }

  if (/^(?:please\s+)?(?:can you\s+|could you\s+)?(?:watch|keep an eye on|track)\b/i.test(q)) {
    const url = pullUrl(q);
    if (!url) return { action: "say", text: "Say watch, then the web address. For example, watch https://example.com." };
    return { action: "watch", url };
  }

  if (/^remind me\b/i.test(q)) {
    const soon = q.match(/^remind me in (\d{1,4}) (minute|minutes|hour|hours)(?: to)? (.+)$/i);
    if (soon) {
      const count = Number(soon[1]);
      const ms = /hour/i.test(soon[2]) ? count * 3_600_000 : count * 60_000;
      if (count < 1 || ms > 14 * 86_400_000) {
        return { action: "say", text: "Say a time from one minute up to two weeks." };
      }
      return { action: "remind", title: soon[3].trim(), dueAt: Date.now() + ms };
    }
    const at = q.match(/^remind me (tomorrow )?at (\d{1,2})(?::(\d{2}))?\s*(am|pm)(?: to)? (.+)$/i);
    if (at) {
      const day = new Date();
      if (at[1]) day.setDate(day.getDate() + 1);
      const hour = Number(at[2]);
      const minute = at[3] ? Number(at[3]) : 0;
      if (hour > 12 || minute > 59) return { action: "say", text: "Say the hour like 3 pm, or 9:30 am." };
      const when = clockOnDay(day, hour, minute, at[4].toLowerCase());
      if (!at[1] && when.getTime() <= Date.now()) when.setDate(when.getDate() + 1);
      return { action: "remind", title: at[5].trim(), dueAt: when.getTime() };
    }
    return { action: "say", text: "Say remind me in 20 minutes to, and then what I should remind you about. Or say remind me tomorrow at 9 am to, and the task." };
  }

  return null;
}
