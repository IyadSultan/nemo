/**
 * Plans: conferences, trips, and talks, kept apart from Outlook.
 *
 * Plans live in one private file, plans.json, next to this file (the git repo
 * ignores it). A plan is a day or a run of days, with an optional clock time
 * for a lecture, a place, and a free comment for the contact and anything else.
 * After a plan is saved, the app asks whether to open it in Outlook too.
 * The day before a plan starts, an iMessage reminds the user
 * (PLANS_REMIND_AT in .env, 09:00 by default).
 * Files attached to a plan sit in plan-files/<plan id>/ beside plans.json (also ignored by git).
 */

import { sendControl } from "./control.js";
import { sendIMessage } from "./imessage.js";
import { openOutlookMeeting } from "./outlook.js";
import { runCommand } from "./shell.js";
import express from "express";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "plans.json");
// A failed text is tried again after this long, not every tick.
const RETRY_MS = 15 * 60_000;

let filePath = process.env.PLANS_FILE || DEFAULT_FILE;
const failedAt = new Map();
// The plan just saved, waiting for yes or no before Outlook opens. Kept in memory only.
let calendarAsk = null;
const CALENDAR_ASK_MS = 10 * 60 * 1000;
export const CALENDAR_QUESTION = "Should I add this to your calendar?";

/** Tests point this at a scratch file. */
export function usePlansFile(file) {
  filePath = file;
}

/** A missing file is no plans yet. A broken file throws, so it is never saved over. */
export function loadPlans() {
  let text;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  const data = JSON.parse(text);
  return Array.isArray(data.plans) ? data.plans : [];
}

function savePlans(plans) {
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, plans }, null, 2));
  fs.renameSync(tmp, filePath);
}

function validDate(text) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const [y, m, d] = text.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  return date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d;
}

function validTime(text) {
  const match = /^(\d{2}):(\d{2})$/.exec(text);
  return Boolean(match) && Number(match[1]) < 24 && Number(match[2]) < 60;
}

/** The fields the page sent, trimmed and checked. Returns { plan } or { error }. */
export function cleanPlan(body) {
  const text = (value, max) => String(value ?? "").trim().slice(0, max);
  const plan = {
    title: text(body?.title, 120),
    from: text(body?.from, 10),
    to: text(body?.to, 10),
    time: text(body?.time, 5),
    place: text(body?.place, 120),
    comment: text(body?.comment, 4000),
  };
  if (!plan.title) return { error: "Give the plan a title." };
  if (!validDate(plan.from)) return { error: "Pick the day it starts." };
  if (plan.to && !validDate(plan.to)) return { error: "The end day is not a date." };
  if (plan.to && plan.to < plan.from) return { error: "The end day is before the start day." };
  if (plan.to === plan.from) plan.to = "";
  if (plan.time && !validTime(plan.time)) return { error: "The time is not a clock time." };
  return { plan };
}

/** A plan added by another part of the app (the sticky board). No calendar question is asked. */
export function createPlan(body) {
  const { plan, error } = cleanPlan(body);
  if (error) return { error };
  const plans = loadPlans();
  const saved = { id: crypto.randomUUID(), ...plan, createdAt: new Date().toISOString() };
  plans.push(saved);
  savePlans(plans);
  return { plan: saved };
}

function sortPlans(plans) {
  return [...plans].sort((a, b) => a.from.localeCompare(b.from) || (a.time || "").localeCompare(b.time || ""));
}

const minutes = (time) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));

/**
 * Two plans clash when their days overlap. Two talks on the same single day
 * only clash when they start less than an hour apart (a talk has no end time).
 */
export function plansClash(a, b) {
  const aEnd = a.to || a.from;
  const bEnd = b.to || b.from;
  if (a.from > bEnd || b.from > aEnd) return false;
  if (a.time && b.time && !a.to && !b.to) return Math.abs(minutes(a.time) - minutes(b.time)) < 60;
  return true;
}

/** The plan added later is the one marked. Each gets the plans it clashes with and the shared days. */
export function withConflicts(plans) {
  const added = (plan) => `${plan.createdAt || ""}|${plan.id}`;
  return plans.map((plan) => {
    const conflicts = plans
      .filter((other) => other.id !== plan.id && added(other) < added(plan) && plansClash(plan, other))
      .map((other) => ({
        id: other.id,
        title: other.title,
        from: plan.from > other.from ? plan.from : other.from,
        to: [plan.to || plan.from, other.to || other.from].sort()[0],
      }));
    return conflicts.length ? { ...plan, conflicts } : plan;
  });
}

/** When the plan starts: its time on the first day, or that midnight. */
function startOf(plan) {
  const [y, m, d] = plan.from.split("-").map(Number);
  const [hour, minute] = plan.time ? plan.time.split(":").map(Number) : [0, 0];
  return new Date(y, m - 1, d, hour, minute);
}

function remindClock() {
  const at = (process.env.PLANS_REMIND_AT || "").trim();
  return validTime(at.padStart(5, "0")) ? at.padStart(5, "0") : "09:00";
}

/** The day before the plan, at the reminder clock time. */
export function remindAt(plan, clock = remindClock()) {
  const [y, m, d] = plan.from.split("-").map(Number);
  const [hour, minute] = clock.split(":").map(Number);
  return new Date(y, m - 1, d - 1, hour, minute);
}

/** Plans whose reminder time has come and that have not started yet. A moved plan is reminded again. */
export function dueReminders(plans, now = new Date(), clock = remindClock()) {
  return plans.filter((plan) => plan.remindedFor !== plan.from && now >= remindAt(plan, clock) && now < startOf(plan));
}

function shortDay(text) {
  const [y, m, d] = text.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
}

export function reminderText(plan) {
  let line = `Reminder: tomorrow you have ${plan.title}`;
  if (plan.time) line += ` at ${plan.time}`;
  if (plan.place) line += ` in ${plan.place}`;
  if (plan.to) line += `, until ${shortDay(plan.to)}`;
  line += ".";
  return plan.comment ? `${line}\n${plan.comment.slice(0, 600)}` : line;
}

/** Text the reminders that are due. Called from the server's 20-second loop. */
export async function deliverPlanReminders(now = new Date()) {
  const plans = loadPlans();
  const due = dueReminders(plans, now).filter((plan) => !(now - (failedAt.get(plan.id) || 0) < RETRY_MS));
  if (!due.length) return;
  for (const plan of due) {
    const text = reminderText(plan);
    try {
      // false means iMessage is off. The voice page still shows it, once.
      await sendIMessage(text);
      sendControl("job", { title: plan.title, text });
      plan.remindedFor = plan.from;
      failedAt.delete(plan.id);
    } catch (err) {
      console.error("Failed while texting a plan reminder:", err?.message || err);
      failedAt.set(plan.id, now.getTime());
    }
  }
  savePlans(plans);
}

/**
 * "Add a plan: ESMO in Berlin, 23 to 27 October" or "put my grand rounds talk on the 29th at 2 pm in my plans".
 * Returns the request text, or null when the question is not about adding a plan.
 */
export function planJob(question) {
  const q = String(question || "").trim();
  if (/^(?:please |hey |can you |could you )*(?:add|save|put|create|make|new|log)\b(?: me)?(?: an?| my)?(?: new)? (?:plan|conference|trip|talk|lecture)s?\b/i.test(q)
    && /\bplans?\b/i.test(q)) return q;
  if (/\b(?:add|save|put)\b.*\b(?:to|in|on|into) (?:my |the )?plans\b/i.test(q)) return q;
  return null;
}

function localDay(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

const PLAN_INSTRUCTION = (now) => `Turn the user's request into one plan for their own calendar.
Today is ${now.toLocaleDateString("en-GB", { weekday: "long" })} ${localDay(now)}. A date with no year is the next one on or after today.
Reply with JSON only, no prose: {"title": "", "from": "YYYY-MM-DD", "to": "YYYY-MM-DD or empty", "time": "HH:MM 24-hour or empty", "place": "", "comment": ""}.
"to" is only for a run of days, like a conference. "time" is only for a set time, like a talk.
Put contact names, emails, phone numbers, topics, and anything else in "comment". Do not invent anything that was not said.
If no day was said, leave "from" empty.`;

/**
 * One plan as an Outlook event.
 * A talk with a clock time is one hour. A trip with no time covers whole days.
 * The end day Outlook wants is the morning after the last day.
 */
export function planMeeting(plan) {
  const [year, month, day] = plan.from.split("-").map(Number);
  const lines = [];
  if (plan.comment) lines.push(plan.comment);
  if (plan.to) lines.push(`Until ${plan.to}.`);
  const meeting = {
    subject: plan.title,
    body: lines.join("\n"),
    location: plan.place || "",
  };
  if (plan.time) {
    const [hour, minute] = plan.time.split(":").map(Number);
    return { ...meeting, duration: 60, date: new Date(year, month - 1, day, hour, minute, 0, 0) };
  }
  const last = (plan.to || plan.from).split("-").map(Number);
  const end = new Date(last[0], last[1] - 1, last[2]);
  end.setDate(end.getDate() + 1);
  return { ...meeting, allDay: true, date: new Date(year, month - 1, day), end };
}

/** Remember the plan that was just saved, so the next yes can open Outlook. */
export function rememberCalendarAsk(id) {
  calendarAsk = { id, at: Date.now() };
}

/** Tell the page to show the question and the two buttons. */
function showCalendarAsk(plan) {
  rememberCalendarAsk(plan.id);
  sendControl("plans", { ask: { id: plan.id, title: plan.title, text: CALENDAR_QUESTION } });
}

/** Drop the question. The plan itself stays saved. */
export function declineCalendarAsk() {
  calendarAsk = null;
  sendControl("plans", { clearAsk: true });
  return "OK. It stays in your plans only.";
}

/**
 * Open one saved plan in Outlook. The user still presses Add.
 * `keep` means the button should stay, because Outlook did not open.
 */
export async function openPlanOnCalendar(id) {
  const asked = calendarAsk?.id === id;
  if (asked) calendarAsk = null;
  const plan = loadPlans().find((item) => item.id === id);
  if (!plan) {
    if (asked) sendControl("plans", { clearAsk: true });
    return { error: "That plan is gone. Refresh the list." };
  }
  try {
    await openOutlookMeeting(planMeeting(plan));
  } catch (err) {
    console.error("Failed while opening a plan in Outlook:", err?.message || err);
    if (asked) calendarAsk = { id, at: Date.now() };
    return { error: "Microsoft Outlook did not open. Is it installed?", keep: true };
  }
  if (asked) sendControl("plans", { clearAsk: true });
  const span = plan.time ? "for one hour" : "as an all-day event";
  return { text: `I opened ${plan.title} in Outlook ${span}. Press Add in that window. It is not on the calendar until you do.` };
}

/** "yes", "add it", or "yes, add it to my calendar". Nothing longer. */
function isCalendarYes(q) {
  if (/^(?:please )?(?:yes|yeah|yep|yup|sure|نعم|ايوه|أيوه)$/u.test(q)) return true;
  if (/^(?:please )?(?:add it|add this|do it|please do)(?: to (?:my |the )?calendar)?$/u.test(q)) return true;
  return /^(?:please )?(?:yes|yeah|yep|yup|sure) (?:add it|add this|do it)(?: to (?:my |the )?calendar)?$/u.test(q);
}

/**
 * Yes or no to "Should I add this to your calendar?"
 * Returns the sentence to say, or null when the words are about something else.
 * `open` is replaced in tests so Outlook is not launched.
 */
export async function planCalendarFollowUp(question, open = openPlanOnCalendar) {
  if (!calendarAsk) return null;
  if (Date.now() - calendarAsk.at > CALENDAR_ASK_MS) {
    calendarAsk = null;
    return null;
  }
  const q = String(question || "").toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, " ").replace(/\s+/g, " ").trim();
  const no = /^(?:please )?(?:no|nope|nah|don'?t|do not|not now|leave it|skip it|no thanks|لا)$/u;
  if (isCalendarYes(q)) {
    const id = calendarAsk.id;
    const result = await open(id);
    if (result.keep) calendarAsk = { id, at: Date.now() };
    else if (calendarAsk?.id === id) calendarAsk = null;
    return result.error || result.text;
  }
  if (no.test(q)) return declineCalendarAsk();
  // A different question drops the offer. The button on the page still works.
  calendarAsk = null;
  return null;
}

/** Read the plan out of the request with the model, save it, and return the sentence to say back. */
export async function runPlanJob(question, ask, now = new Date()) {
  let raw = "";
  try {
    raw = String(await ask(PLAN_INSTRUCTION(now), question) || "");
  } catch (err) {
    console.error("Failed while reading a plan from a request:", err?.message || err);
    return "I could not read that plan. Try the Plans tab instead.";
  }
  let fields = null;
  try {
    fields = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
  } catch {
    console.error("The model's plan was not JSON:", raw.slice(0, 200));
    return "I could not read that plan. Try the Plans tab instead.";
  }
  const { plan, error } = cleanPlan(fields);
  let clashes = [];
  if (error) return error === "Pick the day it starts." ? "Which day is it? Say the plan again with the date." : error;
  let savedId = "";
  try {
    const plans = loadPlans();
    savedId = crypto.randomUUID();
    plans.push({ id: savedId, ...plan, createdAt: new Date().toISOString() });
    savePlans(plans);
    clashes = withConflicts(plans).at(-1).conflicts || [];
  } catch (err) {
    console.error("Failed while saving a plan from a request:", err?.message || err);
    return "I could not save the plan. plans.json could not be read or saved.";
  }
  showCalendarAsk({ id: savedId, title: plan.title });
  let said = `Saved to your plans: ${plan.title}, ${shortDay(plan.from)}`;
  if (plan.to) said += ` to ${shortDay(plan.to)}`;
  if (plan.time) said += ` at ${plan.time}`;
  if (plan.place) said += `, in ${plan.place}`;
  said += ". I will text you the day before.";
  if (clashes.length) said += ` It clashes with ${clashes.map((other) => other.title).join(" and ")}. I marked it red.`;
  said += ` ${CALENDAR_QUESTION}`;
  return said;
}

function filesDir(planId) {
  return path.join(path.dirname(filePath), "plan-files", planId);
}

/** A plain file name: no folders, no control characters, no leading dot. */
export function cleanFileName(name) {
  const base = path.basename(String(name || "").replace(/\\/g, "/")).replace(/[\u0000-\u001f\u007f]/g, "").trim().replace(/^\.+/, "");
  return base.slice(-150);
}

/** "notes.pdf" becomes "notes (2).pdf" when the plan already has one. */
function freeName(name, taken) {
  if (!taken.has(name)) return name;
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let n = 2; ; n += 1) {
    const next = `${stem} (${n})${ext}`;
    if (!taken.has(next)) return next;
  }
}

export function registerPlans(app) {
  const fail = (res, err, doing) => {
    console.error(`Failed while ${doing}:`, err?.message || err);
    res.status(500).json({ error: "plans.json could not be read or saved." });
  };

  app.get("/plans", (_req, res) => {
    try {
      res.json({ plans: sortPlans(withConflicts(loadPlans())) });
    } catch (err) {
      fail(res, err, "reading the plans");
    }
  });

  app.post("/plans", (req, res) => {
    const { plan, error } = cleanPlan(req.body);
    if (error) return res.status(400).json({ error });
    try {
      const plans = loadPlans();
      const saved = { id: crypto.randomUUID(), ...plan, createdAt: new Date().toISOString() };
      plans.push(saved);
      savePlans(plans);
      showCalendarAsk(saved);
      // The form has no spoken reply of its own, so read the question aloud.
      sendControl("job", { text: CALENDAR_QUESTION });
      res.json({ plan: saved });
    } catch (err) {
      fail(res, err, "adding a plan");
    }
  });

  app.put("/plans/:id", (req, res) => {
    const { plan, error } = cleanPlan(req.body);
    if (error) return res.status(400).json({ error });
    try {
      const plans = loadPlans();
      const index = plans.findIndex((item) => item.id === req.params.id);
      if (index < 0) return res.status(404).json({ error: "That plan is gone. Refresh the list." });
      plans[index] = { ...plans[index], ...plan };
      savePlans(plans);
      res.json({ plan: plans[index] });
    } catch (err) {
      fail(res, err, "changing a plan");
    }
  });

  app.post("/plans/calendar/skip", (_req, res) => {
    res.json({ text: declineCalendarAsk() });
  });

  app.post("/plans/:id/calendar", async (req, res) => {
    const result = await openPlanOnCalendar(req.params.id);
    if (result.error) {
      res.status(result.error.includes("gone") ? 404 : 500).json({ error: result.error });
      return;
    }
    res.json(result);
  });

  app.delete("/plans/:id", (req, res) => {
    try {
      const plans = loadPlans();
      const kept = plans.filter((item) => item.id !== req.params.id);
      if (kept.length === plans.length) return res.status(404).json({ error: "That plan is gone. Refresh the list." });
      savePlans(kept);
      fs.rmSync(filesDir(req.params.id), { recursive: true, force: true });
      res.json({ ok: true });
    } catch (err) {
      fail(res, err, "deleting a plan");
    }
  });

  /** The page sends the file as raw bytes, its name in X-File-Name. */
  app.post("/plans/:id/files", express.raw({ type: "*/*", limit: "60mb" }), (req, res) => {
    let name = "";
    try {
      name = cleanFileName(decodeURIComponent(String(req.get("x-file-name") || "")));
    } catch {
      return res.status(400).json({ error: "The file name could not be read." });
    }
    if (!name) return res.status(400).json({ error: "The file has no name." });
    if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: "The file is empty." });
    try {
      const plans = loadPlans();
      const plan = plans.find((item) => item.id === req.params.id);
      if (!plan) return res.status(404).json({ error: "That plan is gone. Refresh the list." });
      plan.files = Array.isArray(plan.files) ? plan.files : [];
      const file = { name: freeName(name, new Set(plan.files.map((item) => item.name))), size: req.body.length, addedAt: new Date().toISOString() };
      fs.mkdirSync(filesDir(plan.id), { recursive: true });
      fs.writeFileSync(path.join(filesDir(plan.id), file.name), req.body);
      plan.files.push(file);
      savePlans(plans);
      res.json({ file });
    } catch (err) {
      fail(res, err, "attaching a file to a plan");
    }
  });

  /** Only a name the plan lists is used, so a request cannot reach outside its folder. */
  const attached = (req, res) => {
    const plan = loadPlans().find((item) => item.id === req.params.id);
    const file = plan?.files?.find((item) => item.name === req.params.name);
    if (!file) {
      res.status(404).json({ error: "That file is gone. Refresh the list." });
      return null;
    }
    return path.join(filesDir(plan.id), file.name);
  };

  app.post("/plans/:id/files/:name/open", async (req, res) => {
    try {
      const full = attached(req, res);
      if (!full) return;
      await runCommand("open", [full]);
      res.json({ ok: true });
    } catch (err) {
      console.error("Failed while opening a plan file:", err?.message || err);
      res.status(500).json({ error: "The file did not open." });
    }
  });

  app.delete("/plans/:id/files/:name", (req, res) => {
    try {
      const plans = loadPlans();
      const plan = plans.find((item) => item.id === req.params.id);
      const kept = (plan?.files || []).filter((item) => item.name !== req.params.name);
      if (!plan || kept.length === (plan.files || []).length) return res.status(404).json({ error: "That file is gone. Refresh the list." });
      fs.rmSync(path.join(filesDir(plan.id), req.params.name), { force: true });
      plan.files = kept;
      savePlans(plans);
      res.json({ ok: true });
    } catch (err) {
      fail(res, err, "removing a plan file");
    }
  });
}
