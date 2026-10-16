/**
 * Scheduling requests and the Outlook calendar: parse "schedule a meeting with X at 3 pm",
 * read the calendar Outlook keeps on this Mac, and say a day's meetings in words.
 */

import { __dirname } from "./config.js";
import { runCommand } from "./shell.js";
import { numberWord, spokenClock, spokenDay } from "./spoken.js";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";

export const HOUR_WORDS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, noon: 12, midnight: 0,
};

/** Turn "3 pm" or "ten" into an hour from 0 to 23. */
export function meetingHour(hour, mark, question) {
  if (hour === 0) return 0;
  let ap = mark || "";
  if (!ap && /\bmorning\b/.test(question)) ap = "am";
  if (!ap && /\b(?:afternoon|evening|tonight)\b/.test(question)) ap = "pm";
  if (ap === "pm" && hour < 12) return hour + 12;
  if (ap === "am" && hour === 12) return 0;
  if (!ap && hour >= 1 && hour <= 7) return hour + 12;
  return hour;
}

/** The day and clock time inside a scheduling request. Missing pieces get a spoken guess. */
export function meetingWhen(question, now = new Date()) {
  const q = question.toLowerCase();
  const date = new Date(now);
  date.setSeconds(0, 0);
  let assumedDay = false;
  let assumedTime = false;
  const weekday = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"]
    .findIndex((name) => new RegExp(`\\b(?:this\\s+|next\\s+)?${name}\\b`).test(q));

  if (/\btomorrow\b/.test(q)) {
    date.setDate(date.getDate() + 1);
  } else if (weekday >= 0) {
    let delta = (weekday - date.getDay() + 7) % 7;
    if (/\bnext\b/.test(q) && delta === 0) delta = 7;
    else if (delta === 0 && !/\bthis\b/.test(q)) delta = 7;
    date.setDate(date.getDate() + delta);
  } else if (!/\b(?:today|tonight)\b/.test(q)) {
    date.setDate(date.getDate() + 1);
    assumedDay = true;
  }

  let hour = null;
  let minute = 0;
  const clock = q.match(/\bat\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/);
  const wordClock = q.match(/\bat\s+(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|noon|midnight)(?:\s+(fifteen|thirty|forty[- ]five))?\s*(am|pm)?\b/);
  const halfPast = q.match(/\bhalf past\s+(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s*(am|pm)?\b/);
  if (clock) {
    hour = meetingHour(Number(clock[1]), clock[3], q);
    minute = clock[2] ? Number(clock[2]) : 0;
  } else if (wordClock) {
    const extra = wordClock[2] || "";
    if (extra.startsWith("fifteen")) minute = 15;
    else if (extra.startsWith("thirty")) minute = 30;
    else if (extra.startsWith("forty")) minute = 45;
    hour = meetingHour(HOUR_WORDS[wordClock[1]], wordClock[3], q);
  } else if (halfPast) {
    minute = 30;
    const raw = Number.isNaN(Number(halfPast[1])) ? HOUR_WORDS[halfPast[1]] : Number(halfPast[1]);
    hour = meetingHour(raw, halfPast[2], q);
  } else if (/\btonight\b/.test(q)) {
    hour = 19;
    assumedTime = true;
  } else if (/\bmorning\b/.test(q)) {
    hour = 9;
    assumedTime = true;
  } else if (/\bafternoon\b/.test(q)) {
    hour = 14;
    assumedTime = true;
  } else if (/\bevening\b/.test(q)) {
    hour = 17;
    assumedTime = true;
  } else {
    hour = 10;
    assumedTime = true;
  }
  if (minute > 59) minute = 0;
  date.setHours(hour, minute, 0, 0);

  let duration = 60;
  const minuteCount = q.match(/\bfor\s+(\d{1,3})\s+minutes?\b/);
  const hourCount = q.match(/\bfor\s+(\d{1,2})\s+hours?\b/);
  if (/\bfor\s+(?:half an hour|thirty minutes|30 minutes)\b/.test(q)) duration = 30;
  else if (minuteCount) duration = Math.min(240, Number(minuteCount[1]) || 60);
  else if (hourCount) duration = Math.min(240, (Number(hourCount[1]) || 1) * 60);
  return { date, assumedDay, assumedTime, duration };
}

export function titleCaseWords(text) {
  return String(text || "")
    .split(" ")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/** A title the user asked for, such as "titled ward round" or "called lab review". */
export function chosenMeetingTitle(original) {
  const match = String(original || "").match(/\b(?:titled|called|named|call it|title it|the title is|title is)\s+(.+?)(?=\s+(?:with|at|on|tomorrow|today|tonight|this|next|for|in|from|about|regarding)\b|[?.]|$)/i);
  if (!match) return "";
  let title = match[1].replace(/\s+/g, " ").trim();
  title = title.replace(/^(?:a|an|the)\s+/i, "");
  title = title.replace(/[.,]+$/, "").trim();
  if (!title || /^(?:meeting|appointment)s?$/i.test(title)) return "";
  return titleCaseWords(title).slice(0, 120);
}

/** Subject, people, place, and time taken from the request. */
export function parseMeeting(question, now = new Date()) {
  const original = String(question || "").trim().replace(/\?+$/, "");
  const q = original.toLowerCase().replace(/\s+/g, " ");
  const when = meetingWhen(q, now);
  const whoTail = q.match(/\bwith\s+(.+)$/);
  let who = whoTail
    ? whoTail[1].split(/\b(?:about|regarding|titled|called|named|at|on|tomorrow|today|tonight|this|next|for|in|from)\b/)[0]
    : "";
  who = who.replace(/^(?:a|an|the|my)\s+/, "").replace(/\s+/g, " ").replace(/[.,]+$/, "").trim();
  if (/^(?:me|us|them|someone|somebody)$/.test(who)) who = "";
  who = titleCaseWords(who);
  const aboutMatch = q.match(/\b(?:about|regarding)\s+(.+?)(?=\s+(?:with|titled|called|named|at|on|tomorrow|today|tonight|this|next|for|in)\b|$)/);
  let about = aboutMatch ? aboutMatch[1].replace(/^(?:a|an|the)\s+/, "").replace(/\s+/g, " ").trim() : "";
  about = titleCaseWords(about);
  const placeMatch = q.match(/\b(?:in|at)\s+(?:the\s+)?(room\s+[a-z0-9-]+|[a-z][a-z0-9'’ -]{1,30}?)(?=\s+(?:with|about|regarding|titled|called|named|tomorrow|today|tonight|at|on|for)\b|$)/);
  let place = placeMatch ? placeMatch[1].trim() : "";
  if (/^(?:\d|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|noon|midnight|morning|afternoon|evening|night|calendar|outlook)\b/.test(place)) {
    place = "";
  }
  place = titleCaseWords(place);
  const chosen = chosenMeetingTitle(original);
  const subject = (chosen || about || (who ? `Meeting with ${who}` : "Meeting")).slice(0, 120);
  const lines = [];
  if (who) lines.push(`With ${who}.`);
  if (place) lines.push(`Place: ${place}.`);
  return {
    subject,
    body: lines.join(" "),
    location: place,
    who,
    ...when,
  };
}

/** Outlook keeps a small calendar file for the calendar widget. AppleScript cannot see this calendar. */
export function outlookCalendarFile() {
  return path.join(
    os.homedir(),
    "Library/Group Containers/UBF8T346G9.Office/Library/Application Support/Calendar Widget/store.json",
  );
}

/** The widget stores times as seconds since 1 January 2001, UTC. */
export function outlookTime(seconds) {
  return new Date((Date.UTC(2001, 0, 1) / 1000 + Number(seconds)) * 1000);
}

export function startOfDay(date) {
  const day = new Date(date);
  day.setHours(0, 0, 0, 0);
  return day;
}

/** Read the meetings Outlook has ready on this Mac. */
export function loadOutlookCalendar() {
  const data = JSON.parse(fsSync.readFileSync(outlookCalendarFile(), "utf8"));
  if (data.hasError) throw new Error("Outlook said the calendar could not be read.");
  const events = [];
  const seen = new Set();
  const pairs = Array.isArray(data.dayToAppointments) ? data.dayToAppointments : [];
  for (let i = 0; i + 1 < pairs.length; i += 2) {
    const appointments = pairs[i + 1];
    if (!Array.isArray(appointments)) continue;
    for (const item of appointments) {
      if (!item || item.isCancelled) continue;
      const start = outlookTime(item.startTime);
      const end = outlookTime(item.endTime);
      if (Number.isNaN(start.getTime())) continue;
      const subject = String(item.subject || "Untitled").replace(/\[[^\]]*\]/g, " ").replace(/\s+/g, " ").trim() || "Untitled";
      const key = `${start.getTime()}|${subject}`;
      if (seen.has(key)) continue;
      seen.add(key);
      events.push({
        subject,
        location: String(item.location || "").replace(/\s+/g, " ").trim(),
        start,
        end,
        allDay: Boolean(item.isAllDay),
      });
    }
  }
  events.sort((a, b) => a.start - b.start);
  const windowStart = outlookTime(data.dateInterval?.start || 0);
  const windowEnd = outlookTime((data.dateInterval?.start || 0) + (data.dateInterval?.duration || 0));
  return { events, windowStart, windowEnd };
}

export function eventsOnDay(events, day) {
  const start = startOfDay(day);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return events.filter((event) => event.start < end && event.end > start);
}

/** Say one day's meetings in plain words. */
export function spokenDayCalendar(events, day, label) {
  if (!events.length) return `${label}, your calendar is clear.`;
  const count = events.length === 1 ? "one thing" : `${numberWord(events.length)} things`;
  const lines = events.map((event) => {
    const when = event.allDay ? "All day" : `At ${spokenClock(event.start)}`;
    const place = event.location ? `, ${event.location}` : "";
    return `${when}, ${event.subject}${place}.`;
  });
  return `${label}, ${spokenDay(day)}, you have ${count}. ${lines.join(" ")}`;
}

/** Today, tomorrow, or both. */
export function spokenCalendar(when, now = new Date()) {
  let loaded;
  try {
    loaded = loadOutlookCalendar();
  } catch (err) {
    console.error("Failed while reading the Outlook calendar:", err?.message || err);
    return "I could not read the Outlook calendar on this Mac.";
  }
  const today = startOfDay(now);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const wanted = when === "tomorrow" ? [tomorrow] : when === "both" ? [today, tomorrow] : [today];
  const labels = when === "tomorrow" ? ["Tomorrow"] : when === "both" ? ["Today", "Tomorrow"] : ["Today"];
  const parts = [];
  for (let i = 0; i < wanted.length; i += 1) {
    const day = wanted[i];
    if (day < loaded.windowStart || day >= loaded.windowEnd) {
      parts.push(`${labels[i]} is not in the calendar Outlook has ready on this Mac.`);
      continue;
    }
    parts.push(spokenDayCalendar(eventsOnDay(loaded.events, day), day, labels[i]));
  }
  return parts.join(" ");
}

/** What the voice says after the calendar window opens. */
export function spokenMeeting(meeting, opened) {
  const when = `${spokenDay(meeting.date)} at ${spokenClock(meeting.date)}`;
  const lines = [
    opened
      ? `I opened that meeting in Outlook for ${when}.`
      : "Outlook did not open. Is Microsoft Outlook installed?",
    `The title is ${meeting.subject}.`,
  ];
  if (meeting.assumedDay) lines.push("I did not hear a day, so I used tomorrow.");
  if (meeting.assumedTime) lines.push("I did not hear a clock time, so I used ten in the morning.");
  if (opened) lines.push("Press Add in that window. That puts it on the calendar you look at. It is not sent to anyone.");
  return lines.join(" ");
}

export function meetingFromDraft(draft) {
  return {
    subject: draft.subject,
    body: draft.body,
    location: draft.location,
    duration: draft.duration,
    date: new Date(draft.date),
  };
}

/** What the voice says while a meeting is waiting, before Outlook opens. */
export function spokenMeetingWaiting(meeting) {
  const when = `${spokenDay(meeting.date)} at ${spokenClock(meeting.date)}`;
  const lines = [
    `I have a meeting ready for ${when}.`,
    `The title is ${meeting.subject}.`,
  ];
  if (meeting.assumedDay) lines.push("I did not hear a day, so I used tomorrow.");
  if (meeting.assumedTime) lines.push("I did not hear a clock time, so I used ten in the morning.");
  lines.push("Say send it to open it in Outlook, or don't to drop it. It is not on the calendar until you press Add.");
  return lines.join(" ");
}

/** The Outlook event that overlaps the meeting the most, or null. */
export function calendarMeetingAt(start, end) {
  let events;
  try {
    events = loadOutlookCalendar().events;
  } catch (err) {
    console.error("Failed while reading the Outlook calendar for the minutes:", err?.message || err);
    return null;
  }
  let best = null;
  let bestOverlap = 0;
  for (const event of events) {
    if (event.allDay) continue;
    // A meeting often starts a few minutes late or runs over.
    const overlap = Math.min(end, event.end.getTime() + 15 * 60000) - Math.max(start, event.start.getTime() - 15 * 60000);
    if (overlap > bestOverlap) {
      best = event;
      bestOverlap = overlap;
    }
  }
  return best;
}

export const CALENDAR_HELPER = path.join(__dirname, "..", "voice", "calendar-attendees", "calendar-attendees");

/**
 * The calendar invite that overlaps the meeting the most, with the invitees, or null.
 * Read from macOS Calendar, which holds the Exchange account. Outlook's own file has no invitees.
 */
export async function calendarInviteAt(start, end) {
  if (!fsSync.existsSync(CALENDAR_HELPER)) return null;
  try {
    // 15 minutes either side, because a meeting often starts late or runs over.
    const out = await Promise.race([
      runCommand(CALENDAR_HELPER, [String(start - 15 * 60000), String(end + 15 * 60000)]),
      new Promise((_, reject) => setTimeout(() => reject(new Error("The calendar helper took too long.")), 8000)),
    ]);
    const data = JSON.parse(out);
    if (data.error) throw new Error(`Calendar said ${data.error}. Allow it in Privacy & Security, Calendars.`);
    let best = null;
    let bestOverlap = 0;
    for (const event of data.events || []) {
      const overlap = Math.min(end, event.end + 15 * 60000) - Math.max(start, event.start - 15 * 60000);
      if (overlap > bestOverlap) {
        best = event;
        bestOverlap = overlap;
      }
    }
    if (!best) return null;
    const names = [best.organizer, ...(best.attendees || [])].map((name) => String(name || "").trim()).filter(Boolean);
    return { subject: String(best.title || "").trim(), attendees: [...new Set(names)] };
  } catch (err) {
    console.error("Failed while reading the calendar invite:", err?.message || err);
    return null;
  }
}
