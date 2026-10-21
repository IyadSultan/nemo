// Regenerate: node rust/tests/fixtures/gen_desk.mjs > rust/tests/fixtures/desk.json
//
// Runs a copy of second-brain/desk.js with a fixed clock, counting ids, the
// Asia/Amman time zone, and a temp desk.json. Records each call's result and
// the exact file text after it. The Rust test replays the same calls.
// All content below is made up.

process.env.TZ = "Asia/Amman";

import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = await fs.mkdtemp(path.join(os.tmpdir(), "desk-fixture-"));
const file = path.join(dir, "desk.json");

// A file written earlier, with odd values the loader must tolerate and keep.
const seed = {
  jobs: [
    { id: "old00001", created: "2026-10-01T08:00:00.000Z", updated: "2026-10-01T08:00:00.000Z", receipt: "", kind: "draft", status: "needs-you", title: "Budget reply", detail: "d", draft: { type: "email", to: "a@b.c", name: "A", subject: "Budget", body: "  Body text  ", original: "  " }, extra: { kept: [1, 2.5] } },
    { id: "old00002", kind: "watch", status: "alerted", title: "Site", url: "https://example.com/", lastText: "h1", receipt: "This page changed." },
    { id: "old00003", kind: "reminder", status: "waiting", title: "Call back", dueAt: 1760500000000, receipt: "Waiting." },
    { id: "old00004", kind: "reminder", status: "done", title: "Old" },
    7,
  ],
  suggestions: [
    { id: "s1", key: "k1", title: "Reply to Sam", source: "Email", detail: "x", summary: "Subject: hi" },
    { id: "s2", key: "k2", title: "Reply to Lee", source: "Email", detail: "y", summary: "Lee asks about dates." },
  ],
  dismissed: ["k0"],
  memory: { summary: "We talked.", turns: [{ question: "Q1", answer: "A1" }], savedAt: 5 },
  unknownTop: true,
};
await fs.writeFile(file, JSON.stringify(seed, null, 2));

let source = await fs.readFile(path.resolve(here, "../../../second-brain/desk.js"), "utf8");
source = source
  .replace('path.join(path.dirname(fileURLToPath(import.meta.url)), "desk.json")', JSON.stringify(file))
  .replace('crypto.randomBytes(4).toString("hex")', '(globalThis.__id = (globalThis.__id || 0) + 1).toString(16).padStart(8, "0")');
const copy = path.join(dir, "desk.mjs");
await fs.writeFile(copy, source);

const RealDate = Date;
globalThis.__now = 0;
globalThis.Date = class extends RealDate {
  constructor(...args) {
    super(...(args.length ? args : [globalThis.__now]));
  }
  static now() {
    return globalThis.__now;
  }
};

const desk = await import(copy);

const T = RealDate.UTC(2026, 9, 15, 10, 30); // 13:30 in Amman, a Thursday
const steps = [
  ["publicDesk", []],
  ["pendingSummaries", []],
  ["jobsSentence", []],
  ["suggestionsSentence", []],
  ["rememberSummary", ["job", "old00001", "  A short   note about the budget.  "]],
  ["rememberSummary", ["job", "old00001", "  A short   note about the budget.  "]],
  ["rememberSummary", ["suggestion", "s1", "Sam says hi."]],
  ["rememberSummary", ["other", "s1", "x"]],
  ["rememberSummary", ["job", "nope", "x"]],
  ["saveEmailDraft", [{ to: "  lee@x.org ", name: "Lee", subject: "  Dates\nfor   the trip ", body: " Dear Lee, ... ", original: "Lee wrote this" }]],
  ["saveEmailDraft", [{ to: "a", subject: "", body: "   " }]],
  ["saveEmailDraft", [{ subject: "", body: "Hi 😀".repeat(3) }]],
  ["pendingSummaries", []],
  ["saveMeetingDraft", [{ subject: "Tumor board", body: "Cases", location: "Room 2", who: "Team", duration: 30, date: "D", assumedDay: true, assumedTime: false }, "  Tomorrow at 9 am.  "]],
  ["saveMeetingDraft", [{ subject: "", body: "", location: "", who: "", duration: 0, date: "", assumedDay: false, assumedTime: true }, ""]],
  ["saveMeetingDraft", [{ subject: "Odd", body: "", location: "", who: "", duration: 1.5, date: "2026-10-16T06:00:00.000Z", assumedDay: false, assumedTime: false }, "x"]],
  ["latestDraft", []],
  ["finishLatestEmail", ["Opened in Outlook."]],
  ["finishJob", ["nope", "done", "x"]],
  ["addWatch", ["not a url", ""]],
  ["addWatch", ["ftp://example.com/", ""]],
  ["addWatch", ["https://Example.COM", ""]],
  ["addWatch", ["https://news.example.org/a b", "  The   news "]],
  ["recordWatch", ["old00002", "", "Timed out after 20 s"]],
  ["recordWatch", ["00000006", "hashA", ""]],
  ["recordWatch", ["00000006", "hashA", ""]],
  ["recordWatch", ["00000006", "hashB", ""]],
  // A draft is not a watch: it is left alone.
  ["recordWatch", ["00000005", "hashA", ""]],
  ["watchesToCheck", []],
  ["addWatch", ["https://example.com/", "Again"]],
  ["jobsSentence", []],
  ["clearAlerts", []],
  ["clearAlerts", []],
  ["addReminder", ["  Call   the lab ", T + 20 * 60000]],
  ["addReminder", ["Midnight", RealDate.UTC(2026, 9, 15, 21, 5)]],
  ["takeDueReminders", [T + 30 * 60000]],
  ["takeDueReminders", [T + 30 * 60000]],
  ["cancelWatches", []],
  ["cancelWatches", []],
  ["mergeSuggestions", [[
    { key: "k2", title: "Reply to Lee again", source: "Email", detail: "y2", at: 1760500000123 },
    { key: "k0", title: "Dismissed", source: "Email", detail: "" },
    { key: "", title: "No key", source: "", detail: "" },
    { key: "k3", title: "Reply   to Kim", source: "Email", detail: "z", at: 1760500000000.5 },
    { key: "k4", title: "Four", source: "Email", detail: "" },
    { key: "k5", title: "Five", source: "Email", detail: "" },
    { key: "k6", title: "Six", source: "Email", detail: "" },
  ]]],
  ["suggestionsSentence", []],
  ["suggestionAt", [1]],
  ["suggestionAt", [9]],
  ["dismissSuggestion", ["nope"]],
  ["rememberChat", ["  So far   we planned. ", [{ question: "q0" }, { question: "", answer: "dropped" }, { question: " q2 ", answer: "" }, { question: "q3", answer: "a3" }, { question: "q4", answer: "a4" }, { question: "q5", answer: "a5" }, { question: "q6", answer: "a6" }, { question: "q7", answer: 7 }]]],
  ["savedChat", []],
  ["publicDesk", []],
  ["forgetChat", []],
  ["jobsSentence", []],
  // Email and meeting watches.
  ["addMailWatch", ["  Eman  "]],
  ["addMailWatch", ["eman"]],
  ["addMailWatch", ["E"]],
  ["addMeetingWatch", [9]],
  ["addMeetingWatch", [0]],
  ["addMeetingWatch", [8]],
  ["setWatchMark", [() => idOf("Email from Eman"), "a.txt", { tell: false, receipt: "Watching." }]],
  ["setWatchMark", [() => idOf("Email from Eman"), "a.txt\nb.txt", { tell: true, receipt: "A new email was saved." }]],
  ["jobsSentence", []],
  // "Got it" ends a page alert but keeps an email watch going.
  ["clearAlerts", []],
  ["jobsSentence", []],
  ["stopWatch", ["meetings"]],
  // A watch stopped while it was being checked stays stopped.
  ["setWatchMark", [() => idOf("Meetings before 8:00 AM", true), "x", { tell: true, receipt: "r" }]],
  ["recordWatch", ["00000006", "hashC", ""]],
  ["stopWatch", ["Eman Sultan"]],
  ["stopWatch", ["nobody"]],
  // Repeating jobs. T is a Thursday afternoon.
  ["addSchedule", [{ days: [1, 2, 3, 4, 5], hour: 8, minute: 0, mode: "ask", ask: "which emails need a reply" }, T]],
  ["addSchedule", [{ days: [5, 4, 3, 2, 1, 1], hour: 8, minute: 0, mode: "ask", ask: "Which emails need a REPLY" }, T]],
  ["addSchedule", [{ days: [1], hour: "8", minute: 0, ask: "x" }, T]],
  ["addSchedule", [{ days: [1], hour: 8.5, minute: 0, ask: "x" }, T]],
  ["addSchedule", [{ days: [6, 6, 9], hour: 21, minute: 30, mode: "remind", ask: "take the medicine" }, T]],
  ["pauseSchedule", ["email"]],
  ["pauseSchedule", ["email"]],
  // Two weeks asleep: the medicine job runs once, the paused one not at all.
  ["takeDueSchedules", [T + 14 * 86_400_000]],
  ["takeDueSchedules", [T + 14 * 86_400_000]],
  // Resumed on a Friday evening: the next run is Monday, not a missed one.
  ["resumeSchedule", ["email", RealDate.UTC(2026, 9, 16, 17, 0)]],
  ["addSchedule", [{ days: [0, 1, 2, 3, 4, 5, 6], hour: 0, minute: 0, mode: "ask", ask: "which emails need a reply from Sara" }, T]],
  ["pauseSchedule", ["emails reply"]],
  ["pauseSchedule", [() => ({ id: idOf("which emails need a reply") })]],
  ["resumeSchedule", [{ id: "nope" }, T]],
  ["moveSchedule", ["need reply", 9, 0, T]],
  ["moveSchedule", [() => ({ id: idOf("which emails need a reply") }), 12, 15, T]],
  ["jobsSentence", []],
  ["dropSchedule", ["sara"]],
  ["dropSchedule", ["missing words here"]],
  ["dropSchedule", ["the job"]],
];

/** The id of the newest job with this title. stopped also finds one that is no longer open. */
function idOf(title, stopped = false) {
  const jobs = JSON.parse(readFileSync(file, "utf8")).jobs;
  return jobs.filter((job) => job?.title === title && (stopped || job.status !== "skipped")).at(-1)?.id;
}

const parses = [
  "stop watching", "Please cancel the watch.", "got it", "what's waiting?", "What should I do",
  "yes, send it", "send it!", "don't", "never mind.", "do number two", "skip the third idea", "Do 4 suggestion",
  "watch https://example.com/page).", "can you keep an eye on news.example.org/today, please", "track my weight",
  "watch", "remind me in 20 minutes to call the lab", "remind me in 2 hours check results", "remind me in 0 minutes x",
  "remind me in 9999 hours x", "remind me at 3 pm to call Sara", "remind me at 1:15 pm to eat", "remind me at 12 am to sleep",
  "remind me at 12 pm lunch", "remind me tomorrow at 9:30 am to round", "remind me at 13 pm x", "remind me at 9:75 am x",
  "remind me about it", "“open the file”", "", "   ",
  "every weekday at 8 am, text me which emails need a reply",
  "Every day at 9:30 pm remind me to take the medicine",
  "every weekday at 8 text me the emails",
  "pause the email job",
  "change the email job to 9:30 am",
  "tell me when Eman emails", "Tell me when Eman emails me", "let me know when I get new emails",
  "watch for email from Dr. Sara", "please tell me when there is a new email from the dean",
  "text me if I have a meeting before 9", "tell me if there's a meeting before 7:30 am",
  "text me if I have a meeting before 12 am", "text me if I have a meeting before 5 pm",
  "stop watching emails from Eman", "stop watching for email from Eman", "stop watching meetings",
  "move the meeting to 3 pm", "pause the music", "resume the email job", "drop the email job", "cancel the meeting",
  "change the email job to 13 pm", "every cell in the body has DNA", "every Monday morning at 8 am text me x",
  "every weekends at 10 am remind me to call mom", "every Sunday at 12 am ask what is due this week",
];

const log = console.log;
const error = console.error;
console.log = () => {};
console.error = () => {};
const results = [];
for (let [i, [fn, args]] of steps.entries()) {
  globalThis.__now = T + i * 1000;
  // An id only known once earlier steps ran is filled in now, and recorded as the value.
  args = args.map((arg) => (typeof arg === "function" ? arg() : arg));
  let callArgs = args;
  if (fn === "saveMeetingDraft" && args[0].date === "2026-10-16T06:00:00.000Z") {
    callArgs = [{ ...args[0], date: new globalThis.Date(args[0].date) }, args[1]]; // the patched Date, so instanceof works
  }
  const out = desk[fn](...callArgs);
  // Snapshot now: desk.js returns live objects that later calls change.
  results.push({ fn, args, now: globalThis.__now, out: out === undefined ? null : JSON.parse(JSON.stringify(out)), file: await fs.readFile(file, "utf8") });
}
globalThis.__now = T;
const parsed = parses.map((q) => ({ q, out: desk.parseDesk(q) }));
console.log = log;
console.error = error;

console.log(JSON.stringify({ seed, now: T, steps: results, parses: parsed }, null, 1));
await fs.rm(dir, { recursive: true });
