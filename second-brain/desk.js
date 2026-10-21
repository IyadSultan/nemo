/**
 * The desk is the work that should still be here after a restart.
 *
 * It is one private file, desk.json, next to this file. The git repo
 * ignores it. Three kinds of things live in it:
 *   jobs         a page to watch, a reminder, a repeating job, or a draft waiting for "send it"
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
const MAX_SCHEDULES = 8;
const MAX_SUGGESTIONS = 4;
const MAX_JOBS = 40;
const DAY_WORDS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
// Words that do not help pick one scheduled job out of the list.
const SCHEDULE_STOP = new Set(["the", "my", "job", "jobs", "scheduled", "schedule", "reminder", "one"]);

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

/** Still on the work list: waiting, paused, needing a yes, or a page that changed. */
function isOpen(job) {
  return job.status === "waiting" || job.status === "paused" || job.status === "needs-you" || job.status === "alerted";
}

/** A web page, email, or meeting watch that is still on. */
function isActiveWatch(job) {
  return job.kind === "watch" && (job.status === "waiting" || job.status === "alerted");
}

/** Drop finished jobs when the file gets long. Waiting work always stays. */
function trimJobs() {
  const keep = [];
  const done = [];
  for (const job of state.jobs) {
    if (isOpen(job)) keep.push(job);
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

/** "reply" when a draft answers a message, "draft" when it is a new email, otherwise blank. */
function emailAbout(job) {
  if (job.kind !== "draft" || job.draft?.type !== "email") return "";
  return String(job.draft?.original || "").trim() ? "reply" : "draft";
}

/**
 * Email drafts and reply ideas that still need a short summary.
 * The server fills these with Haiku, then stores the result.
 */
export function pendingSummaries() {
  const tasks = [];
  for (const job of state.jobs) {
    if (job.status !== "needs-you" || !emailAbout(job) || job.summary) continue;
    const original = String(job.draft?.original || "").trim();
    const body = String(job.draft?.body || "").trim();
    const text = (original || body).slice(0, 3500);
    if (!text) continue;
    tasks.push({
      kind: "job",
      id: job.id,
      about: emailAbout(job),
      text,
      fallback: "",
    });
  }
  for (const item of state.suggestions) {
    // A summary that is only the title, or still starts with "Subject:", was not written by Haiku yet.
    if (item.summary && item.summary !== item.title && !/^subject:/i.test(item.summary)) continue;
    tasks.push({
      kind: "suggestion",
      id: item.id,
      key: item.key,
      about: "reply",
      text: "",
      fallback: item.title || "",
    });
  }
  return tasks;
}

/** Save the short note Haiku wrote for one work card. */
export function rememberSummary(kind, id, summary) {
  const text = clip(summary, 420);
  if (!text) return false;
  if (kind === "job") {
    const job = jobById(id);
    if (!job || job.summary === text) return false;
    job.summary = text;
    job.updated = nowIso();
  } else if (kind === "suggestion") {
    const item = suggestionById(id);
    if (!item || item.summary === text) return false;
    item.summary = text;
  } else {
    return false;
  }
  save();
  return true;
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
  const openJobs = state.jobs.filter((job) => isOpen(job));
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
      // For an email draft: a short note about the message being answered.
      summary: job.summary || "",
      about: emailAbout(job),
    })),
    suggestions: state.suggestions.map((item) => ({
      id: item.id,
      title: item.title,
      source: item.source,
      detail: item.detail,
      at: item.at || 0,
      // Short note about the email this idea would answer. Empty until Haiku writes it.
      summary: item.summary || "",
      about: "reply",
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
  const existing = state.jobs.find((job) => isActiveWatch(job) && job.url === href);
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
  if (watchesToCheck().length >= MAX_WATCHES) {
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
  return state.jobs.filter(isActiveWatch);
}

/**
 * Remember what the page says. Returns the job when the words changed.
 * A watch stopped while its page was loading stays stopped.
 */
export function recordWatch(id, hash, errorText) {
  const job = jobById(id);
  if (!job || !isActiveWatch(job)) return null;
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

/** A watch that is not a web page. type is "mail" or "meeting". */
function addStandingWatch(job) {
  if (watchesToCheck().length >= MAX_WATCHES) {
    return { ok: false, text: "You already have 8 watches. Say stop watching, then add a new one." };
  }
  pushJob(job);
  return { ok: true };
}

/** Text when a new saved email from this person shows up. The first check only learns what is already saved. */
export function addMailWatch(who) {
  const name = clip(who, 80);
  if (name.length < 2) return { ok: false, text: "Say the person's name. For example, tell me when Eman emails." };
  const key = name.toLowerCase();
  const existing = watchesToCheck().find((job) => job.watch?.type === "mail" && String(job.watch.who || "").toLowerCase() === key);
  if (existing) {
    existing.receipt = "Still watching.";
    existing.updated = nowIso();
    save();
    return { ok: true, text: `I am already watching for email from ${existing.watch.who}.` };
  }
  const saved = addStandingWatch({
    kind: "watch",
    status: "waiting",
    title: `Email from ${name}`,
    detail: `I will text you when a new email from ${name} is saved on this Mac.`,
    watch: { type: "mail", who: name },
    lastText: "",
    receipt: "Not checked yet.",
  });
  if (!saved.ok) return saved;
  return { ok: true, text: `I will text you when a new email from ${name} is saved. The first check only learns what is already there.` };
}

/** Text when a meeting starts before this hour, today if it is not over, or tomorrow. */
export function addMeetingWatch(beforeHour) {
  const hour = Number(beforeHour);
  if (!Number.isInteger(hour) || hour < 1 || hour > 23) {
    return { ok: false, text: "Say a time like before 9, or before 9 am." };
  }
  const label = clockPhrase(hour, 0);
  const existing = watchesToCheck().find((job) => job.watch?.type === "meeting");
  if (existing) {
    existing.watch.beforeHour = hour;
    existing.title = `Meetings before ${label}`;
    existing.detail = `I will text you if a meeting starts before ${label}.`;
    existing.lastText = "";
    existing.receipt = "Watching again from now.";
    existing.status = "waiting";
    existing.updated = nowIso();
    save();
    return { ok: true, text: `I will text you if a meeting starts before ${label}.` };
  }
  const saved = addStandingWatch({
    kind: "watch",
    status: "waiting",
    title: `Meetings before ${label}`,
    detail: `I will text you if a meeting starts before ${label}.`,
    watch: { type: "meeting", beforeHour: hour },
    lastText: "",
    receipt: "Not checked yet.",
  });
  if (!saved.ok) return saved;
  return { ok: true, text: `I will text you if a meeting starts before ${label}. That means later today, if it is not over, or tomorrow.` };
}

/**
 * Remember the latest mark for a mail or meeting watch.
 * Returns the job when the caller should text the user.
 * A watch stopped while it was being checked stays stopped.
 */
export function setWatchMark(id, mark, { tell, receipt }) {
  const job = jobById(id);
  if (!job || !isActiveWatch(job)) return null;
  job.updated = nowIso();
  job.lastText = mark;
  job.receipt = clip(receipt, 200);
  if (tell) job.status = "alerted";
  save();
  return tell ? job : null;
}

/**
 * Stop one watch. "meeting" stops the early-meeting watch. Other words match an email name,
 * either way round, so "Eman" stops a watch on "Eman Sultan".
 */
export function stopWatch(words) {
  const key = clip(words, 200).toLowerCase();
  const hits = watchesToCheck().filter((job) => {
    if (job.watch?.type === "meeting") return /\bmeetings?\b/.test(key);
    const who = String(job.watch?.who || "").toLowerCase();
    if (job.watch?.type === "mail") return Boolean(key && who) && (key.includes(who) || who.includes(key));
    return false;
  });
  if (!hits.length) return { ok: false, text: "I am not watching that." };
  for (const job of hits) {
    job.status = "skipped";
    job.receipt = "You asked me to stop watching.";
    job.updated = nowIso();
  }
  save();
  const name = hits.length === 1 ? hits[0].title : `${hits.length} watches`;
  return { ok: true, text: `Stopped watching ${name}.` };
}

export function cancelWatches() {
  let count = 0;
  for (const job of state.jobs) {
    if (isActiveWatch(job)) {
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
      // An email or meeting watch keeps going. A web page watch is finished.
      job.status = job.watch?.type ? "waiting" : "done";
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

/** 8 pm is 20. 12 am is midnight. The hour must already be 1–12. */
function clockHour(hour, mark) {
  if (mark === "pm" && hour < 12) return hour + 12;
  if (mark === "am" && hour === 12) return 0;
  return hour;
}

/** "weekday" is Monday–Friday. "day" is all seven. One name is that weekday, Sunday = 0. */
function daysFromWord(word) {
  const name = String(word || "").toLowerCase();
  if (name === "day") return [0, 1, 2, 3, 4, 5, 6];
  if (name === "weekday" || name === "weekdays") return [1, 2, 3, 4, 5];
  if (name === "weekend" || name === "weekends") return [0, 6];
  const index = DAY_WORDS.findIndex((day) => day.toLowerCase() === name);
  return index < 0 ? [] : [index];
}

/** "8:00 AM", with the minutes always two digits. */
export function clockPhrase(hour, minute) {
  const mark = hour >= 12 ? "PM" : "AM";
  const shown = hour % 12 || 12;
  return `${shown}:${String(minute).padStart(2, "0")} ${mark}`;
}

/** "Every weekday" or "Every Monday". days is sorted, Sunday = 0. */
function dayPhrase(days) {
  const key = days.join(",");
  if (key === "0,1,2,3,4,5,6") return "Every day";
  if (key === "1,2,3,4,5") return "Every weekday";
  if (key === "0,6") return "Every weekend";
  return `Every ${days.map((day) => DAY_WORDS[day]).join(", ")}`;
}

/**
 * The next time this clock time falls on one of these days, strictly after afterMs.
 * Uses this Mac's clock. Returns 0 when no day in the next week matches.
 */
function nextFire(days, hour, minute, afterMs) {
  for (let add = 0; add < 8; add += 1) {
    const when = new Date(afterMs);
    when.setDate(when.getDate() + add);
    when.setHours(hour, minute, 0, 0);
    if (days.includes(when.getDay()) && when.getTime() > afterMs) return when.getTime();
  }
  return 0;
}

/**
 * Point a repeating job at its next clock time after now, and say it on the card.
 * Returns false, and changes nothing, when there is no next time.
 */
function retime(job, now, hour = job.schedule?.hour, minute = job.schedule?.minute) {
  const days = job.schedule?.days || [];
  const dueAt = nextFire(days, hour, minute, now);
  if (!dueAt) return false;
  const when = new Date(dueAt).toLocaleString("en-US", { weekday: "long", hour: "numeric", minute: "2-digit" });
  job.dueAt = dueAt;
  job.detail = `${dayPhrase(days)} at ${clockPhrase(hour, minute)}. Next: ${when}.`;
  return true;
}

/** Scheduled jobs that are still on or paused. */
function liveSchedules() {
  return state.jobs.filter((job) => job.kind === "schedule" && (job.status === "waiting" || job.status === "paused"));
}

/**
 * Save a repeating job. plan is { days, hour, minute, mode, ask }.
 * mode "ask" runs that question through the brain. mode "remind" only texts the words.
 * now is the clock in milliseconds, so a test can pretend what time it is.
 */
export function addSchedule(plan, now = Date.now()) {
  const days = [...new Set(plan?.days || [])].filter((day) => Number.isInteger(day) && day >= 0 && day <= 6).sort((a, b) => a - b);
  const hour = plan?.hour;
  const minute = plan?.minute;
  const mode = plan?.mode === "remind" ? "remind" : "ask";
  const ask = clip(plan?.ask, 300);
  if (!ask || !days.length || !Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) {
    return { ok: false, text: "Say every weekday at 8 am, text me, and then the question." };
  }
  const active = liveSchedules();
  const same = active.find((job) => {
    const saved = job.schedule || {};
    return saved.mode === mode
      && saved.hour === hour
      && saved.minute === minute
      && String(saved.ask || "").toLowerCase() === ask.toLowerCase()
      && (saved.days || []).join(",") === days.join(",");
  });
  if (same) return { ok: true, text: `You already have that job: ${same.title}.` };
  if (active.length >= MAX_SCHEDULES) {
    return { ok: false, text: "You already have 8 scheduled jobs. Say drop, then a few words from one of them." };
  }
  const fields = {
    kind: "schedule",
    status: "waiting",
    title: clip(ask, 180),
    detail: "",
    dueAt: 0,
    receipt: "Waiting.",
    schedule: { days, hour, minute, mode, ask },
  };
  if (!retime(fields, now)) return { ok: false, text: "I could not find a next time for that." };
  const job = pushJob(fields);
  const how = mode === "ask" ? "I will ask that and text you the answer." : "I will text you that reminder.";
  return { ok: true, text: `${job.detail} ${how}`, job };
}

/** Jobs whose title or question contains every useful word the user said. */
function schedulesMatching(words) {
  const terms = String(words || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 2 && !SCHEDULE_STOP.has(word));
  if (!terms.length) return [];
  return liveSchedules().filter((job) => {
    const hay = `${job.title} ${job.schedule?.ask || ""}`.toLowerCase();
    return terms.every((term) => hay.includes(term));
  });
}

/**
 * One scheduled job, or a sentence when there is none or more than one.
 * target is the words the user said, or { id } from a button on the card.
 */
function oneSchedule(target) {
  if (target?.id) {
    const job = liveSchedules().find((item) => item.id === target.id);
    return job ? { ok: true, job } : { ok: false, text: "That scheduled job is not here." };
  }
  const hits = schedulesMatching(target);
  if (!hits.length) return { ok: false, text: "I don't have a scheduled job with those words. Say what jobs to hear them." };
  if (hits.length > 1) return { ok: false, text: `More than one job matches. ${hits.map((job) => job.title).join("; ")}.` };
  return { ok: true, job: hits[0] };
}

/** Stop a repeating job until the user says resume. */
export function pauseSchedule(target) {
  const found = oneSchedule(target);
  if (!found.ok) return found;
  if (found.job.status === "paused") return { ok: true, text: `Already paused: ${found.job.title}.` };
  found.job.status = "paused";
  found.job.receipt = "Paused.";
  found.job.updated = nowIso();
  save();
  return { ok: true, text: `Paused: ${found.job.title}. It will not run until you say resume.` };
}

/** Turn a paused job back on. The next run is the next future clock time, not a missed one. */
export function resumeSchedule(target, now = Date.now()) {
  const found = oneSchedule(target);
  if (!found.ok) return found;
  if (!retime(found.job, now)) return { ok: false, text: "I could not find a next time for that." };
  found.job.status = "waiting";
  found.job.receipt = "Waiting.";
  found.job.updated = nowIso();
  save();
  return { ok: true, text: `On again: ${found.job.title}. ${found.job.detail}` };
}

/** Remove a repeating job. It does not come back. */
export function dropSchedule(target) {
  const found = oneSchedule(target);
  if (!found.ok) return found;
  found.job.status = "skipped";
  found.job.receipt = "You dropped this job.";
  found.job.updated = nowIso();
  save();
  return { ok: true, text: `Dropped: ${found.job.title}.` };
}

/** Keep the same question, change the clock time. A paused job stays paused. */
export function moveSchedule(target, hour, minute, now = Date.now()) {
  const found = oneSchedule(target);
  if (!found.ok) return found;
  if (!retime(found.job, now, hour, minute)) return { ok: false, text: "I could not find a next time for that." };
  found.job.schedule.hour = hour;
  found.job.schedule.minute = minute;
  found.job.receipt = found.job.status === "paused" ? "Paused." : "Waiting.";
  found.job.updated = nowIso();
  save();
  return { ok: true, text: `Moved: ${found.job.title}. ${found.job.detail}` };
}

/**
 * Repeating jobs whose time has arrived. Each one is moved to its next future
 * time before it is returned, so a slow answer cannot send the same job twice,
 * and a Mac that slept through several runs sends one, not a burst.
 * At most 3 run on one check. now is the clock in milliseconds.
 */
export function takeDueSchedules(now = Date.now()) {
  const due = state.jobs.filter((job) => job.kind === "schedule" && job.status === "waiting" && job.dueAt <= now);
  const taken = [];
  for (const job of due.slice(0, 3)) {
    if (!retime(job, now)) continue;
    job.receipt = "Ran.";
    job.updated = nowIso();
    taken.push(job);
  }
  if (taken.length) save();
  return taken;
}

export function jobsSentence() {
  const open = state.jobs.filter((job) => isOpen(job));
  if (!open.length) {
    return "Nothing is waiting. You can say watch and a web address, remind me in 20 minutes to, and then the task, every weekday at 8 am text me, and then a question, or ask me to draft an email.";
  }
  const lines = open.map((job) => {
    if (job.kind === "draft") return `A draft is waiting: ${job.title}. Say send it, or don't.`;
    if (job.kind === "watch" && job.watch?.type === "mail") {
      return job.status === "alerted"
        ? `New email from ${job.watch.who}. Say got it when you have seen it.`
        : `Watching for email from ${job.watch.who}.`;
    }
    if (job.kind === "watch" && job.watch?.type === "meeting") {
      return job.status === "alerted"
        ? `An early meeting showed up. Say got it when you have seen it.`
        : `Watching for a meeting before ${clockPhrase(job.watch.beforeHour, 0)}.`;
    }
    if (job.kind === "watch") return job.status === "alerted"
      ? `${job.title} changed. Say got it when you have seen it.`
      : `Watching ${job.title}.`;
    if (job.kind === "schedule") return job.status === "paused" ? `Paused: ${job.title}.` : `Scheduled: ${job.title}.`;
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
    const previous = state.suggestions.find((entry) => entry.key === key);
    next.push({
      id: crypto.createHash("sha256").update(key).digest("hex").slice(0, 12),
      key,
      title: clip(item.title, 180),
      source: clip(item.source, 80),
      detail: clip(item.detail, 180),
      // When the email arrived (ms), so the card can show the date in numbers.
      at: Number(item.at) || undefined,
      // Keep a summary we already paid Haiku to write for this same email.
      summary: previous?.summary || "",
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
  const when = new Date(day);
  when.setHours(clockHour(hour, mark), minute, 0, 0);
  return when;
}

/**
 * Turn a spoken request into a desk action.
 * Returns null when the sentence is about something else.
 */
export function parseDesk(question) {
  const q = String(question || "").trim().replace(/^["“'\s.,]+|["”'\s.?!]+$/g, "");
  if (!q) return null;

  const stopMail = q.match(/^(?:please\s+)?stop watching (?:for )?(?:new )?(?:e-?mails?|mail) from (.+)$/i);
  if (stopMail) return { action: "stop-watch", words: stopMail[1].trim() };
  if (/^(?:please\s+)?stop watching (?:the )?(?:early )?meetings?(?: before \d{1,2}(?::\d{2})?\s*(?:am|pm)?)?$/i.test(q)) {
    return { action: "stop-watch", words: "meeting" };
  }
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

  const mailWatch = q.match(/^(?:please\s+)?(?:tell me|let me know|text me) when (?:i get |there is |there's )?(?:an? |the )?(?:new )?e-?mails? from (.+)$/i)
    || q.match(/^(?:please\s+)?(?:watch|keep an eye on) (?:for )?(?:e-?mails?|mail) from (.+)$/i)
    || q.match(/^(?:please\s+)?(?:tell me|let me know|text me) when (.+?) e-?mails?(?: me)?$/i);
  // "Tell me when I get emails" names nobody, so it is not a watch.
  if (mailWatch && !/^(?:i|we|you|it|they|there|someone|anyone)\b/i.test(mailWatch[1])) {
    return { action: "watch-mail", who: mailWatch[1].replace(/^(?:an?|the)\s+/i, "").trim() };
  }

  const meetingWatch = q.match(/^(?:please\s+)?(?:tell me|text me|let me know) if (?:i have |there is |there's |tomorrow has )?(?:a |an )?meetings?(?: that starts?)? before (\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (meetingWatch) {
    if (meetingWatch[2]) return { action: "say", text: "Say before 9, or before 9 am. I watch the hour, not the minutes." };
    const hour12 = Number(meetingWatch[1]);
    const hour = clockHour(hour12, (meetingWatch[3] || "").toLowerCase());
    // 12 am is midnight: nothing starts before it.
    if (hour12 < 1 || hour12 > 12 || hour < 1) return { action: "say", text: "Say a time like before 9, or before 9 am." };
    return { action: "watch-meeting", beforeHour: hour };
  }

  if (/^(?:please\s+)?(?:can you\s+|could you\s+)?(?:watch|keep an eye on|track)\b/i.test(q)) {
    const url = pullUrl(q);
    if (!url) return { action: "say", text: "Say watch, then the web address. For example, watch https://example.com." };
    return { action: "watch", url };
  }

  // "Change the email job to 9:30 am" keeps the question and moves the clock.
  // These all need the word job, so "move the meeting to 3 pm" or "pause the music"
  // is left for the rest of the app.
  const move = q.match(/^(?:please\s+)?(?:change|move) (?:the |my )?(.+?) job to (\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i);
  if (move) {
    const hour12 = Number(move[2]);
    const minute = move[3] ? Number(move[3]) : 0;
    if (hour12 < 1 || hour12 > 12 || minute > 59) return { action: "say", text: "Say the hour like 9 am, or 9:30 pm." };
    return { action: "move-schedule", words: move[1].trim(), hour: clockHour(hour12, move[4].toLowerCase()), minute };
  }
  const tune = q.match(/^(?:please\s+)?(pause|resume) (?:the |my )?(.+?) job$/i);
  if (tune) {
    return { action: tune[1].toLowerCase() === "resume" ? "resume-schedule" : "pause-schedule", words: tune[2].trim() };
  }
  const drop = q.match(/^(?:please\s+)?(?:drop|cancel) (?:the |my )?(.+?) job$/i);
  if (drop) return { action: "drop-schedule", words: drop[1].trim() };

  // "Every weekday at 8 am, text me which emails need a reply."
  // Only "every ... at 8" gets help, so "every cell has DNA" still reaches the brain.
  if (/^(?:please\s+)?every (?:\S+ ){1,2}at \d/i.test(q)) {
    const parsed = q.match(/^(?:please\s+)?every (day|weekdays?|weekends?|monday|tuesday|wednesday|thursday|friday|saturday|sunday) at (\d{1,2})(?::(\d{2}))?\s*(am|pm)[,:]?\s+(.+)$/i);
    if (!parsed) {
      return { action: "say", text: "Say every weekday at 8 am, text me, and then the question. Or say every day at 9 pm, remind me to, and the task." };
    }
    const hour12 = Number(parsed[2]);
    const minute = parsed[3] ? Number(parsed[3]) : 0;
    if (hour12 < 1 || hour12 > 12 || minute > 59) return { action: "say", text: "Say the hour like 8 am, or 9:30 pm." };
    const remind = parsed[5].trim().match(/^(?:remind me(?: to)?|remember to)\s+(.+)$/i);
    const ask = (remind ? remind[1] : parsed[5].replace(/^(?:text me|tell me|ask me|ask)\s+/i, "")).trim();
    if (!ask) return { action: "say", text: "Say what I should do at that time." };
    return {
      action: "schedule",
      days: daysFromWord(parsed[1]),
      hour: clockHour(hour12, parsed[4].toLowerCase()),
      minute,
      mode: remind ? "remind" : "ask",
      ask,
    };
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
