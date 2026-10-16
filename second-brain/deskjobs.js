/**
 * Work cards on the desk: email ideas with Haiku summaries, drafts waiting for a yes,
 * watched web pages, reminders, and the /desk routes the page uses to act on them.
 */

import { meetingFromDraft } from "./calendar.js";
import * as desk from "./desk.js";
import { sendControl } from "./control.js";
import { sendIMessage } from "./imessage.js";
import { cleanMailAddress, emailLines, polishReply, replyWithOriginal } from "./mail.js";
import { askClaude } from "./models.js";
import { openOutlookDraft, openOutlookMeeting } from "./outlook.js";
import { cleanHistory, cleanMemory } from "./prompt.js";
import { speakTitle, spokenWhen } from "./spoken.js";
import { rawMail } from "./state.js";
import crypto from "node:crypto";
import fs from "node:fs/promises";

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
  // OneDrive sometimes answers "try again" while the app is still starting.
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const raw = await fs.readFile(file.full, "utf8");
      const body = emailLines(raw).slice(0, 3500);
      const subject = speakTitle(file.title);
      return [subject ? `Subject: ${subject}` : "", body].filter(Boolean).join("\n\n");
    } catch (err) {
      const busy = /unknown system error -11|EAGAIN/i.test(err?.message || "");
      if (!busy || attempt === 3) {
        console.error("Failed while reading an email to summarize:", err?.message || err);
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
      retry = true;
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
  if (command.action === "cancel-watches") {
    const count = desk.cancelWatches();
    const text = count ? `Stopped watching ${count === 1 ? "that page" : `${count} pages`}.` : "I was not watching any page.";
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

export async function checkWatches() {
  for (const job of desk.watchesToCheck()) {
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
