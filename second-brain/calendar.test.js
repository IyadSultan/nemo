/**
 * Calendar tab: Outlook's widget file, the board, the appointment form, and the early-meeting watch.
 * Run: node --test second-brain/calendar.test.js
 * Times are checked on a CEST Mac, across the October clock change. Outlook is never opened.
 */

process.env.TZ = "Europe/Berlin";

import assert from "node:assert/strict";
import test from "node:test";
import { appointmentPlan, calendarBoard, earlyMeetings, eventsOnDay, readOutlookStore } from "./calendar.js";

/** Seconds since 1 January 2001 UTC, the way Outlook's widget file stores times. */
const cocoa = (iso) => (Date.parse(iso) - Date.UTC(2001, 0, 1)) / 1000;

// Wed 21 Oct 2026 00:00 CEST to Mon 26 Oct 00:00 CET, as Outlook wrote it on this Mac.
const store = {
  hasError: false,
  dateInterval: { start: cocoa("2026-10-21T00:00:00+02:00"), duration: 435600 },
  dayToAppointments: [
    cocoa("2026-10-21T00:00:00+02:00"),
    [
      { subject: "Ward round [External]", location: "Room 4", startTime: cocoa("2026-10-21T08:00:00+02:00"), endTime: cocoa("2026-10-21T09:00:00+02:00") },
      { subject: "Dropped", isCancelled: true, startTime: cocoa("2026-10-21T10:00:00+02:00"), endTime: cocoa("2026-10-21T11:00:00+02:00") },
    ],
    cocoa("2026-10-25T00:00:00+02:00"),
    [
      // All-day events are stored at midnight UTC of their day.
      { subject: "Holiday", isAllDay: true, startTime: cocoa("2026-10-25T00:00:00Z"), endTime: cocoa("2026-10-26T00:00:00Z") },
      { subject: "<img src=x onerror=alert(1)>", startTime: cocoa("2026-10-25T09:00:00+01:00"), endTime: cocoa("2026-10-25T10:00:00+01:00") },
    ],
  ],
};

test("an all-day event stays on its own day, east of UTC and on the clock-change day", () => {
  const { events } = readOutlookStore(store);
  const holiday = events.find((event) => event.allDay);
  assert.equal(holiday.start.getTime(), new Date(2026, 9, 25).getTime());
  assert.equal(holiday.end.getTime(), new Date(2026, 9, 26).getTime());
  assert.equal(eventsOnDay(events, new Date(2026, 9, 25)).some((event) => event.allDay), true);
  assert.equal(eventsOnDay(events, new Date(2026, 9, 26)).length, 0);
});

test("the widget file drops cancelled events and tags in brackets", () => {
  const { events } = readOutlookStore(store);
  assert.equal(events.length, 3);
  assert.equal(events[0].subject, "Ward round");
  assert.throws(() => readOutlookStore({ hasError: true }));
});

test("the board has one card per day, today marked, with clock times", () => {
  const { days } = calendarBoard(readOutlookStore(store), new Date("2026-10-21T12:00:00+02:00"));
  assert.deepEqual(days.map((day) => day.date), ["2026-10-21", "2026-10-22", "2026-10-23", "2026-10-24", "2026-10-25"]);
  assert.equal(days[0].today, true);
  assert.deepEqual(days[0].events[0], { subject: "Ward round", location: "Room 4", allDay: false, start: "8:00 AM", end: "9:00 AM" });
  assert.deepEqual(days[4].events.map((event) => [event.allDay, event.start]), [[true, ""], [false, "9:00 AM"]]);
  // The title goes to the page as text; the tab never uses innerHTML.
  assert.equal(days[4].events[1].subject, "<img src=x onerror=alert(1)>");
});

test("a broken window gives no days instead of a year of empty cards", () => {
  assert.deepEqual(calendarBoard({ events: [], windowStart: new Date(NaN), windowEnd: new Date(NaN) }), { days: [] });
  const start = new Date(2026, 0, 1);
  assert.deepEqual(calendarBoard({ events: [], windowStart: start, windowEnd: new Date(2026, 11, 31) }), { days: [] });
});

test("the appointment form becomes one meeting at that local time", () => {
  const plan = appointmentPlan({ subject: "  Tumor\n board ", date: "2026-10-25", start: "09:30", end: "10:15", location: "Hall" });
  assert.equal(plan.meeting.subject, "Tumor board");
  assert.equal(plan.meeting.date.getTime(), new Date(2026, 9, 25, 9, 30).getTime());
  assert.equal(plan.meeting.duration, 45);
  assert.equal(plan.meeting.body, "Place: Hall.");
});

test("on the clock-change night the length is clock minutes", () => {
  const plan = appointmentPlan({ subject: "Night shift", date: "2026-10-25", start: "01:00", end: "04:00" });
  assert.equal(plan.meeting.duration, 180);
});

test("a bad form comes back as a short error", () => {
  const good = { subject: "A", date: "2026-10-22", start: "09:00", end: "10:00" };
  for (const bad of [
    { ...good, subject: "  " },
    { ...good, date: "22/10/2026" },
    { ...good, date: "2026-02-30" },
    { ...good, date: "2026-13-01" },
    { ...good, start: "24:00" },
    { ...good, end: "09:61" },
    { ...good, start: "9:00" },
    { ...good, end: "09:02" },
    { ...good, end: "08:00" },
    { ...good, start: "08:00", end: "20:30" },
  ]) {
    assert.ok(appointmentPlan(bad).error, JSON.stringify(bad));
  }
  assert.ok(appointmentPlan(null).error);
});

test("early meetings: later today and tomorrow, not over, not all day, not begun yesterday", () => {
  const at = (iso, hours = 1, extra = {}) => ({ subject: iso, start: new Date(iso), end: new Date(Date.parse(iso) + hours * 3600000), allDay: false, ...extra });
  const now = new Date("2026-10-21T07:30:00+02:00");
  const events = [
    at("2026-10-20T06:00:00+02:00", 50),
    at("2026-10-21T06:00:00+02:00"),
    at("2026-10-21T07:00:00+02:00"),
    at("2026-10-21T10:00:00+02:00"),
    at("2026-10-22T00:00:00+02:00", 24, { allDay: true }),
    at("2026-10-22T08:45:00+02:00"),
    at("2026-10-22T09:00:00+02:00"),
    at("2026-10-23T07:00:00+02:00"),
  ];
  assert.deepEqual(earlyMeetings(events, 9, now).map((event) => event.subject), ["2026-10-21T07:00:00+02:00", "2026-10-22T08:45:00+02:00"]);
  assert.deepEqual(earlyMeetings(events, 0, now), []);
  assert.deepEqual(earlyMeetings(events, "x", now), []);
});
