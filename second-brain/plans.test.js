/**
 * Plans tab: checking a plan, and when the day-before iMessage is due.
 * Run: node --test second-brain/plans.test.js
 * Times are checked on a CEST Mac. No iMessage is sent.
 */

process.env.TZ = "Europe/Berlin";

import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { meetingIcs } from "./outlook.js";
import { cleanFileName, cleanPlan, plansClash, withConflicts, dueReminders, loadPlans, planCalendarFollowUp, planJob, planMeeting, rememberCalendarAsk, reminderText, runPlanJob, usePlansFile } from "./plans.js";

test("a plan needs a title and a real start day", () => {
  assert.equal(cleanPlan({ from: "2026-11-02" }).error, "Give the plan a title.");
  assert.equal(cleanPlan({ title: "ESMO", from: "2026-02-30" }).error, "Pick the day it starts.");
  assert.equal(cleanPlan({ title: "ESMO", from: "2026-11-05", to: "2026-11-02" }).error, "The end day is before the start day.");
  assert.equal(cleanPlan({ title: "Talk", from: "2026-11-05", time: "25:00" }).error, "The time is not a clock time.");
  const { plan } = cleanPlan({ title: "  ESMO  ", from: "2026-11-02", to: "2026-11-02", place: "Berlin" });
  assert.equal(plan.title, "ESMO");
  assert.equal(plan.to, "", "a one-day plan keeps no end day");
});

test("the reminder is due from 09:00 the day before until the plan starts, once", () => {
  const talk = { id: "a", title: "Grand rounds", from: "2026-11-02", time: "14:00" };
  assert.equal(dueReminders([talk], new Date(2026, 10, 1, 8, 59), "09:00").length, 0);
  assert.equal(dueReminders([talk], new Date(2026, 10, 1, 9, 0), "09:00").length, 1);
  assert.equal(dueReminders([talk], new Date(2026, 10, 2, 13, 0), "09:00").length, 1, "a server off yesterday still reminds before the talk");
  assert.equal(dueReminders([talk], new Date(2026, 10, 2, 14, 0), "09:00").length, 0);
  assert.equal(dueReminders([{ ...talk, remindedFor: "2026-11-02" }], new Date(2026, 10, 1, 10, 0), "09:00").length, 0);
  assert.equal(dueReminders([{ ...talk, from: "2026-11-09", remindedFor: "2026-11-02" }], new Date(2026, 10, 8, 10, 0), "09:00").length, 1, "a moved plan is reminded again");
});

test("a conference with no time stops reminding at midnight", () => {
  const trip = { id: "b", title: "ESMO", from: "2026-11-02", to: "2026-11-05" };
  assert.equal(dueReminders([trip], new Date(2026, 10, 1, 23, 59), "09:00").length, 1);
  assert.equal(dueReminders([trip], new Date(2026, 10, 2, 0, 0), "09:00").length, 0);
});

test("the reminder text says what, when, where, and the comment", () => {
  const text = reminderText({ title: "ESMO", from: "2026-11-02", to: "2026-11-05", place: "Berlin", comment: "Invited by the chair" });
  assert.match(text, /^Reminder: tomorrow you have ESMO in Berlin, until Thu 5 Nov\.\nInvited by the chair$/);
  assert.equal(reminderText({ title: "Talk", from: "2026-11-02", time: "14:00" }), "Reminder: tomorrow you have Talk at 14:00.");
});

test("only requests to add a plan are taken", () => {
  assert.ok(planJob("Add a plan: ESMO in Berlin, 23 to 27 October"));
  assert.ok(planJob("please add a new plan for my grand rounds talk on the 29th at 2 pm"));
  assert.ok(planJob("Put the ASCO trip in my plans"));
  assert.equal(planJob("what are my plans for the weekend"), null);
  assert.equal(planJob("add a sticky note to call Sara"), null);
  assert.equal(planJob("I plan to add more tests"), null);
});

test("a spoken plan is read by the model and saved", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plans-"));
  usePlansFile(path.join(dir, "plans.json"));
  let told = "";
  const ask = async (instruction) => {
    told = instruction;
    return 'Sure: {"title": "Grand rounds talk", "from": "2026-10-29", "to": "", "time": "14:00", "place": "KHCC", "comment": "Dr. Y invited me"}';
  };
  const said = await runPlanJob("add a plan, grand rounds talk on the 29th at 2 pm at KHCC, Dr. Y invited me", ask, new Date(2026, 9, 21, 9));
  assert.match(told, /Today is Wednesday 2026-10-21/);
  assert.equal(said, "Saved to your plans: Grand rounds talk, Thu 29 Oct at 14:00, in KHCC. I will text you the day before. Should I add this to your calendar?");
  assert.equal(loadPlans()[0].comment, "Dr. Y invited me");
  const noDay = await runPlanJob("add a plan for ESMO", async () => '{"title": "ESMO", "from": ""}');
  assert.match(noDay, /Which day/);
  assert.equal(loadPlans().length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a talk becomes a one-hour event, and a trip becomes whole days", () => {
  const talk = planMeeting({ title: "Grand rounds", from: "2026-10-29", time: "14:00", place: "KHCC", comment: "Dr. Y" });
  assert.equal(talk.duration, 60);
  assert.equal(talk.date.getHours(), 14);
  assert.equal(talk.location, "KHCC");
  assert.match(meetingIcs(talk), /DTSTART:20261029T140000/);
  assert.match(meetingIcs(talk), /DTEND:20261029T150000/);
  const trip = planMeeting({ title: "ESMO", from: "2026-11-02", to: "2026-11-05", place: "Berlin" });
  assert.equal(trip.allDay, true);
  const file = meetingIcs(trip);
  assert.match(file, /DTSTART;VALUE=DATE:20261102/);
  assert.match(file, /DTEND;VALUE=DATE:20261106/);
  assert.match(file, /LOCATION:Berlin/);
});

test("yes opens the calendar offer, and no or another question drops it", async () => {
  let opened = "";
  const open = async (id) => {
    opened = id;
    return { text: "opened" };
  };
  rememberCalendarAsk("plan-1");
  assert.equal(await planCalendarFollowUp("Yes, add it to my calendar.", open), "opened");
  assert.equal(opened, "plan-1");
  assert.equal(await planCalendarFollowUp("yes", open), null, "one yes is enough");

  rememberCalendarAsk("plan-2");
  assert.equal(await planCalendarFollowUp("not now"), "OK. It stays in your plans only.");
  assert.equal(await planCalendarFollowUp("yes", open), null);

  rememberCalendarAsk("plan-3");
  assert.equal(await planCalendarFollowUp("what meetings do I have today"), null);
  assert.equal(await planCalendarFollowUp("sure", open), null, "a different question drops the offer");
});

test("an attached file keeps only a plain name", () => {
  assert.equal(cleanFileName("../../etc/passwd"), "passwd");
  assert.equal(cleanFileName("C:\\Users\\me\\invite.pdf"), "invite.pdf");
  assert.equal(cleanFileName(".hidden"), "hidden");
  assert.equal(cleanFileName("..."), "");
  assert.equal(cleanFileName("ok\u0000name.pdf"), "okname.pdf");
});

test("overlapping plans clash, and only the one added later is marked", () => {
  const esmo = { id: "a", title: "ESMO", from: "2026-11-03", to: "2026-11-06", createdAt: "2026-10-01T00:00:00Z" };
  const talk = { id: "b", title: "Grand rounds", from: "2026-11-05", time: "14:00", createdAt: "2026-10-20T00:00:00Z" };
  const later = { id: "c", title: "Board", from: "2026-11-07", createdAt: "2026-10-21T00:00:00Z" };
  const [a, b, c] = withConflicts([esmo, talk, later]);
  assert.equal(a.conflicts, undefined);
  assert.deepEqual(b.conflicts, [{ id: "a", title: "ESMO", from: "2026-11-05", to: "2026-11-05" }]);
  assert.equal(c.conflicts, undefined, "the day after a conference is free");
  assert.equal(plansClash({ from: "2026-11-05", time: "09:00" }, { from: "2026-11-05", time: "11:00" }), false, "two talks two hours apart");
  assert.equal(plansClash({ from: "2026-11-05", time: "09:00" }, { from: "2026-11-05", time: "09:30" }), true);
  assert.equal(plansClash({ from: "2026-11-05", time: "09:00" }, { from: "2026-11-05" }), true, "a talk on an all-day plan");
});
