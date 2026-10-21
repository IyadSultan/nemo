/**
 * Work cards on the desk: email ideas with Haiku summaries, drafts waiting for a yes,
 * watched web pages, reminders, and the /desk routes the page uses to act on them.
 */

import { earlyMeetings, loadOutlookCalendar, meetingFromDraft } from "./calendar.js";
import * as desk from "./desk.js";
import { sendControl } from "./control.js";
import { sendIMessage } from "./imessage.js";
import { cleanMailAddress, emailLines, indexRawMail, polishReply, replyWithOriginal } from "./mail.js";
import { askClaude } from "./models.js";
import { openOutlookDraft, openOutlookMeeting } from "./outlook.js";
import { cleanHistory, cleanMemory } from "./prompt.js";
import { speakTitle, spokenWhen } from "./spoken.js";
import { rawMail } from "./state.js";
import crypto from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";

/** Recent saved emails become ideas the user can do or skip. */
export function syncSuggestions() {
  try {
    const cutoff = Date.now() - 2 * 86_400_000;
    const items = [...rawMail]
      .filter((file) => file.mtime >= cutoff)
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, 12)
      .map((file) => ({
        key: file.rel,
        title: `Reply to ${speakTitle(file.title)}`,
        source: spokenWhen(file.mtime),
        detail: speakTitle(file.title),
        at: file.mtime,
      }));
    desk.mergeSuggestions(items);
  } catch (err) {
    console.error("Failed while building suggestions:", err?.message || err);
  }
  // New emails, and drafts that have no summary yet, get a short Haiku note.
  queueWorkSummaries();
}

// Haiku only writes the one-line note on a work card. It does not answer questions.
export const HAIKU_MODEL = { cliModel: "haiku" };

export let workSummaryQueued = false;

export let workSummaryRunning = false;

// OneDrive sometimes answers "try again" for a saved email. After a few tries,
// leave that file alone for 10 minutes so the retry does not keep the disk busy.
const unreadableMail = new Map();

/** Ask again after the current batch, so a draft saved mid-summary is not skipped. */
export function queueWorkSummaries() {
  workSummaryQueued = true;
  if (workSummaryRunning) return;
  workSummaryRunning = true;
  fillWorkSummaries()
    .catch((err) => console.error("Failed while summarizing work cards:", err?.message || err))
    .finally(() => {
      workSummaryRunning = false;
      if (workSummaryQueued) queueWorkSummaries();
    });
}

/** The saved email as plain text, with its subject, for the summary. */
export async function suggestionText(key) {
  const file = rawMail.find((entry) => entry.rel === key);
  if (!file) return "";
  if ((unreadableMail.get(key) || 0) > Date.now()) return "";
  // OneDrive sometimes answers "try again" while the app is still starting.
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const raw = await fsPromises.readFile(file.full, "utf8");
      unreadableMail.delete(key);
      const body = emailLines(raw).slice(0, 3500);
      const subject = speakTitle(file.title);
      return [subject ? `Subject: ${subject}` : "", body].filter(Boolean).join("\n\n");
    } catch (err) {
      const busy = /unknown system error -11|EAGAIN/i.test(err?.message || "");
      if (!busy || attempt === 3) {
        if (!unreadableMail.has(key)) console.error("Failed while reading an email to summarize:", err?.message || err);
        unreadableMail.set(key, Date.now() + 10 * 60_000);
        return "";
      }
      await new Promise((resolve) => setTimeout(resolve, 1500 * (attempt + 1)));
    }
  }
  return "";
}

/**
 * One or two plain sentences about a message.
 * A very short message is already the summary, so Haiku is not called.
 */
export async function summarizeWithHaiku(text, about) {
  const source = String(text || "").replace(/\s+/g, " ").trim().slice(0, 3500);
  if (!source) return "";
  // A few words are already clear. Anything longer is rewritten by Haiku.
  if (source.length < 80) return source;
  const system = about === "draft"
    ? "Summarize this new email in one short sentence. Say what it is about. Use plain words. Do not add a greeting or a subject line."
    : "Summarize the message this person is about to reply to. Use one or two short sentences. Say who it is from, when the message says, and what they want. Use plain words. Do not write the reply.";
  let out = "";
  await askClaude(HAIKU_MODEL, system, source, "", (chunk) => { out += chunk; }, 40000);
  return out.replace(/\s+/g, " ").trim().slice(0, 420);
}

/** Fill every work card that is still missing its short note. */
export async function fillWorkSummaries() {
  workSummaryQueued = false;
  const tasks = desk.pendingSummaries();
  let retry = false;
  for (const task of tasks) {
    let text = task.text;
    if (task.kind === "suggestion") text = await suggestionText(task.key);
    // A missed file is not saved as a summary, so the next pass can try again.
    if (!text) {
      // A file OneDrive just refused is left alone. Anything else is tried again soon.
      if ((unreadableMail.get(task.key) || 0) <= Date.now()) retry = true;
      continue;
    }
    let summary = "";
    try {
      summary = await summarizeWithHaiku(text, task.about);
    } catch (err) {
      // The card still needs words if Haiku cannot run. Use the opening of the message.
      console.error("Failed while summarizing one work card with Haiku:", err?.message || err);
      summary = text.replace(/\s+/g, " ").trim().slice(0, 220);
    }
    if (summary && desk.rememberSummary(task.kind, task.id, summary)) sendControl("desk", {});
  }
  if (retry) setTimeout(() => queueWorkSummaries(), 8000);
}

/** Open the draft that is waiting. Outlook still needs the user to press Send or Add. */
export async function openSavedDraft(job) {
  if (job.draft?.type === "meeting") {
    await openOutlookMeeting(meetingFromDraft(job.draft));
    desk.finishJob(job.id, "done", "Opened in Outlook. Press Add if it looks right.");
    return "I opened that meeting in Outlook. Press Add if it looks right. It is not sent to anyone.";
  }
  const draft = job.draft || {};
  const letter = polishReply(draft.body || "", draft.name);
  const body = replyWithOriginal(letter, draft.original);
  await openOutlookDraft({
    to: cleanMailAddress(draft.to),
    subject: draft.subject || "Note",
    body,
    name: draft.name || "",
  });
  desk.finishJob(job.id, "done", "Opened in Outlook. Press Send when it looks right.");
  return "I opened that draft in Outlook. Press Send when it looks right. I did not send it.";
}

export async function runDeskCommand(command) {
  if (command.action === "say") return { text: command.text };
  if (command.action === "watch") {
    const saved = desk.addWatch(command.url);
    return { text: saved.text };
  }
  if (command.action === "watch-mail") {
    const saved = desk.addMailWatch(command.who);
    checkWatches().catch((err) => console.error("Failed while starting an email watch:", err?.message || err));
    return { text: saved.text, card: { title: "Watch", lines: [saved.text] } };
  }
  if (command.action === "watch-meeting") {
    const saved = desk.addMeetingWatch(command.beforeHour);
    checkWatches().catch((err) => console.error("Failed while starting an early-meeting watch:", err?.message || err));
    return { text: saved.text, card: { title: "Watch", lines: [saved.text] } };
  }
  if (command.action === "stop-watch") {
    const saved = desk.stopWatch(command.words);
    return { text: saved.text, card: { title: "Watch", lines: [saved.text] } };
  }
  if (command.action === "cancel-watches") {
    const count = desk.cancelWatches();
    const text = count ? `Stopped ${count === 1 ? "that watch" : `${count} watches`}.` : "I was not watching anything.";
    return { text, card: { title: "Watch", lines: [text] } };
  }
  if (command.action === "clear-alerts") {
    const count = desk.clearAlerts();
    const text = count ? "Cleared that alert." : "There is no alert waiting.";
    return { text, card: { title: "Watch", lines: [text] } };
  }
  if (command.action === "jobs") {
    const text = desk.jobsSentence();
    return { text, card: { title: "Jobs", lines: [text] } };
  }
  if (command.action === "suggestions") {
    const text = desk.suggestionsSentence();
    return { text, card: { title: "Ideas", lines: [text] } };
  }
  if (command.action === "remind") {
    const job = desk.addReminder(command.title, command.dueAt);
    return { text: `I will remind you: ${job.title}. ${job.detail}` };
  }
  const scheduled = {
    schedule: () => desk.addSchedule(command),
    "pause-schedule": () => desk.pauseSchedule(command.words),
    "resume-schedule": () => desk.resumeSchedule(command.words),
    "drop-schedule": () => desk.dropSchedule(command.words),
    "move-schedule": () => desk.moveSchedule(command.words, command.hour, command.minute),
  }[command.action];
  if (scheduled) {
    const { text } = scheduled();
    return { text, card: { title: "Scheduled", lines: [text] } };
  }
  if (command.action === "skip-suggestion") {
    const item = desk.suggestionAt(command.index);
    if (!item) return { text: "There is no idea with that number." };
    desk.dismissSuggestion(item.id);
    return { text: `Skipped. ${item.title}.`, card: { title: "Ideas", lines: [`Skipped: ${item.title}`] } };
  }
  if (command.action === "confirm") {
    const job = desk.latestDraft();
    if (!job) return { text: "Nothing is waiting for a yes. Ask me to draft an email or schedule a meeting first." };
    try {
      const text = await openSavedDraft(job);
      return { text, card: { title: job.title, lines: [text] } };
    } catch (err) {
      console.error("Failed while opening a saved draft:", err?.message || err);
      return { text: "I could not open Outlook. Is Microsoft Outlook installed?" };
    }
  }
  if (command.action === "skip") {
    const job = desk.latestDraft();
    if (!job) {
      const watches = desk.cancelWatches();
      if (watches) return { text: "Stopped watching.", card: { title: "Watch", lines: ["Stopped watching."] } };
      return { text: "Nothing is waiting to drop." };
    }
    desk.finishJob(job.id, "skipped", "You dropped this draft.");
    const kind = job.draft?.type === "meeting" ? "meeting" : "draft";
    return { text: `Dropped that ${kind}. Nothing was opened.`, card: { title: job.title, lines: ["Dropped. Nothing was opened."] } };
  }
  return null;
}

/** Read a public page down to plain words, for a watch. */
export async function readWatchedPage(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Only web pages can be watched.");
  }
  const response = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(8000),
    headers: { "User-Agent": "hey-my-brain" },
  });
  if (!response.ok) throw new Error(`The page answered ${response.status}.`);
  const raw = await response.text();
  return raw
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 4000);
}

// The opening lines of recent saved emails, kept until the file changes,
// so a watch check every 3 minutes does not read 400 files again.
const mailHeads = new Map();

function mailHead(mail) {
  const cached = mailHeads.get(mail.full);
  if (cached?.mtime === mail.mtime) return cached.text;
  try {
    const fd = fs.openSync(mail.full, "r");
    const buffer = Buffer.alloc(2000);
    const read = fs.readSync(fd, buffer, 0, 2000, 0);
    fs.closeSync(fd);
    const text = buffer.subarray(0, read).toString("utf8").toLowerCase();
    mailHeads.set(mail.full, { mtime: mail.mtime, text });
    return text;
  } catch (err) {
    console.error("Failed while reading the start of a saved email:", err?.message || err);
    return "";
  }
}

/** Saved emails whose name, or for the last 3 days the opening lines, mention this person. */
function mailFrom(who) {
  const needle = String(who || "").toLowerCase().trim();
  if (needle.length < 2) return [];
  const recent = Date.now() - 3 * 86_400_000;
  for (const [full, head] of mailHeads) {
    if (head.mtime < recent) mailHeads.delete(full);
  }
  const hits = [];
  const unnamed = [];
  for (const mail of rawMail) {
    if (String(mail.lowerName || "").includes(needle)) hits.push(mail.rel);
    else if (mail.mtime >= recent) unnamed.push(mail);
  }
  // Newest first, so the 400-file cap never hides the email that just came in.
  unnamed.sort((a, b) => b.mtime - a.mtime);
  for (const mail of unnamed.slice(0, 400)) {
    if (mailHead(mail).includes(needle)) hits.push(mail.rel);
  }
  return hits;
}

/** The ids a watch already knows. "none" means it looked and found nothing. */
function seenMarks(job) {
  return new Set(String(job.lastText || "").split("\n").filter((id) => id && id !== "none"));
}

async function checkMailWatch(job) {
  // Before the saved emails are listed, every one of them would look new.
  if (!rawMail.length) return;
  const ids = mailFrom(job.watch?.who);
  const first = !job.lastText;
  const seen = seenMarks(job);
  const fresh = ids.filter((id) => !seen.has(id));
  // Keep every id still saved, so an email that drops out of the 3-day scan and comes back is not new.
  const saved = new Set(rawMail.map((mail) => mail.rel));
  const mark = [...new Set([...[...seen].filter((id) => saved.has(id)), ...ids])].sort().join("\n") || "none";
  const told = desk.setWatchMark(job.id, mark, {
    tell: !first && fresh.length > 0,
    receipt: first ? "Watching. I will text you when a new one is saved." : fresh.length ? "A new email was saved." : "No new email.",
  });
  if (!told) return;
  const count = fresh.length === 1 ? "A new email" : `${fresh.length} new emails`;
  const notice = `${count} from ${job.watch.who} ${fresh.length === 1 ? "is" : "are"} saved.`;
  sendControl("job", { title: job.title, text: notice });
  sendControl("desk", {});
  try {
    await sendIMessage(notice);
  } catch (err) {
    console.error("Failed while texting a new email watch:", err?.message || err);
  }
}

/** Unlike email, the first check tells you: an early meeting already there is the point. */
async function checkMeetingWatch(job) {
  const hour = Number(job.watch?.beforeHour);
  let events = [];
  try {
    events = earlyMeetings(loadOutlookCalendar().events, hour);
  } catch (err) {
    console.error("Failed while reading the calendar for an early-meeting watch:", err?.message || err);
    desk.setWatchMark(job.id, job.lastText || "", { tell: false, receipt: "I could not read the calendar just now. I will try again." });
    return;
  }
  // Start and subject, so two meetings at the same time are both seen.
  const key = (event) => `${event.start.getTime()} ${event.subject}`;
  const seen = seenMarks(job);
  const fresh = events.filter((event) => !seen.has(key(event)));
  const told = desk.setWatchMark(job.id, events.map(key).join("\n") || "none", {
    tell: fresh.length > 0,
    receipt: fresh.length ? "An early meeting is on the calendar." : "No early meeting.",
  });
  if (!told) return;
  const lines = fresh.slice(0, 4).map((event) => {
    const when = event.start.toLocaleString("en-US", { weekday: "long", hour: "numeric", minute: "2-digit" });
    return `${when}, ${event.subject}`;
  });
  const notice = `You have ${fresh.length === 1 ? "a meeting" : `${fresh.length} meetings`} before ${desk.clockPhrase(hour, 0)}. ${lines.join(". ")}.`;
  sendControl("job", { title: job.title, text: notice });
  sendControl("desk", {});
  try {
    await sendIMessage(notice);
  } catch (err) {
    console.error("Failed while texting an early-meeting watch:", err?.message || err);
  }
}

export async function checkWatches() {
  const jobs = desk.watchesToCheck();
  if (jobs.some((job) => job.watch?.type === "mail")) {
    try {
      await indexRawMail();
    } catch (err) {
      console.error("Failed while refreshing saved email before a watch check:", err?.message || err);
    }
  }
  for (const job of jobs) {
    const standing = { mail: checkMailWatch, meeting: checkMeetingWatch }[job.watch?.type];
    if (standing) {
      try {
        await standing(job);
      } catch (err) {
        console.error(`Failed while checking a ${job.watch.type} watch:`, err?.message || err);
      }
      continue;
    }
    try {
      const text = await readWatchedPage(job.url);
      const hash = crypto.createHash("sha256").update(text).digest("hex");
      const changed = desk.recordWatch(job.id, hash);
      if (!changed) continue;
      const notice = `The page ${job.title} changed.`;
      sendControl("job", { title: job.title, text: notice });
      sendControl("desk", {});
      try {
        await sendIMessage(notice);
      } catch (err) {
        console.error("Failed while texting a page change:", err?.message || err);
      }
    } catch (err) {
      console.error("Failed while checking a watched page:", err?.message || err);
      desk.recordWatch(job.id, "", "I could not read that page just now. I will try again.");
    }
  }
}

export async function deliverReminders() {
  const due = desk.takeDueReminders();
  if (!due.length) return;
  for (const job of due) {
    const notice = `Reminder: ${job.title}.`;
    sendControl("job", { title: job.title, text: notice });
    try {
      await sendIMessage(notice);
    } catch (err) {
      console.error("Failed while texting a reminder:", err?.message || err);
    }
  }
  sendControl("desk", {});
}

// One batch of scheduled jobs at a time. A slow answer must not start a second batch.
let schedulesRunning = false;

/**
 * Run repeating jobs whose clock time has arrived.
 * ask(question) is the brain. A "remind" job only sends its words.
 * An "ask" job asks the brain and sends the answer. The voice page reads it
 * aloud when it is quiet, and the same text goes to iMessage when that is on.
 */
export async function deliverSchedules(ask) {
  if (schedulesRunning) return;
  const due = desk.takeDueSchedules();
  if (!due.length) return;
  schedulesRunning = true;
  try {
    for (const job of due) {
      const question = String(job.schedule?.ask || job.title || "").trim();
      let notice = `Reminder: ${question}.`;
      if (job.schedule?.mode === "ask" && question && !desk.parseDesk(question)) {
        try {
          const answer = String(await ask(question) || "").trim();
          notice = answer ? answer.slice(0, 1500) : `Nothing came back for: ${question}.`;
        } catch (err) {
          console.error("Failed while running a scheduled job:", err?.message || err);
          notice = `I could not run “${job.title}”.`;
        }
      }
      sendControl("job", { title: job.title, text: notice });
      try {
        await sendIMessage(notice);
      } catch (err) {
        console.error("Failed while texting a scheduled job:", err?.message || err);
      }
    }
    sendControl("desk", {});
  } finally {
    schedulesRunning = false;
  }
}

export function registerDeskjobs(app) {
  app.get("/desk", (_req, res) => {
    res.json(desk.publicDesk());
  });

  app.post("/desk/memory", (req, res) => {
    try {
      desk.rememberChat(cleanMemory(req.body?.memory), cleanHistory(req.body?.turns));
      res.json(desk.publicDesk());
    } catch (err) {
      console.error("Failed while saving the conversation:", err?.message || err);
      res.status(500).json({ error: "Could not save the conversation." });
    }
  });

  app.delete("/desk/memory", (_req, res) => {
    desk.forgetChat();
    res.json(desk.publicDesk());
  });

  app.post("/desk/draft", (req, res) => {
    try {
      const job = desk.saveEmailDraft({
        to: req.body?.to,
        name: req.body?.name,
        subject: req.body?.subject,
        body: req.body?.body,
        original: req.body?.original,
      });
      if (!job) return res.status(400).json({ error: "There is no draft to save." });
      sendControl("desk", {});
      queueWorkSummaries();
      res.json({ ok: true, id: job.id });
    } catch (err) {
      console.error("Failed while saving an email draft:", err?.message || err);
      res.status(500).json({ error: "Could not save that draft." });
    }
  });

  app.post("/desk/jobs/:id/open", async (req, res) => {
    const job = desk.jobById(req.params.id);
    if (!job || job.status !== "needs-you") {
      return res.status(404).json({ error: "That draft is not waiting." });
    }
    try {
      const text = await openSavedDraft(job);
      sendControl("desk", {});
      res.json({ ok: true, text });
    } catch (err) {
      console.error("Failed while opening a saved draft from the page:", err?.message || err);
      res.status(500).json({ error: "Outlook did not open. Is Microsoft Outlook installed?" });
    }
  });

  // By id, not by title words: two jobs can share words.
  for (const [verb, act] of [["pause", desk.pauseSchedule], ["resume", desk.resumeSchedule]]) {
    app.post(`/desk/jobs/:id/${verb}`, (req, res) => {
      const saved = act({ id: req.params.id });
      if (!saved.ok) return res.status(404).json({ error: saved.text });
      sendControl("desk", {});
      res.json({ ok: true, text: saved.text });
    });
  }

  app.post("/desk/jobs/:id/skip", (req, res) => {
    const job = desk.finishJob(req.params.id, "skipped", "You dropped this.");
    if (!job) return res.status(404).json({ error: "That job is not here." });
    sendControl("desk", {});
    res.json({ ok: true });
  });

  app.post("/desk/suggestions/:id/skip", (req, res) => {
    const item = desk.dismissSuggestion(req.params.id);
    if (!item) return res.status(404).json({ error: "That idea is not here." });
    sendControl("desk", {});
    res.json({ ok: true });
  });

  app.post("/desk/suggestions/:id/do", (req, res) => {
    const item = desk.suggestionById(req.params.id);
    if (!item) return res.status(404).json({ error: "That idea is not here." });
    desk.dismissSuggestion(item.id);
    sendControl("desk", {});
    res.json({ question: `Draft a reply to the email about ${item.detail}` });
  });
}
