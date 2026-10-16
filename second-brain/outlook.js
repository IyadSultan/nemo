/**
 * Open a draft or a calendar event in Microsoft Outlook on this Mac. Nothing is sent;
 * the user still presses Send or Add.
 */

import { runCommand } from "./shell.js";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Tells the Outlook app on this Mac to open a new message. It does not send it.
// "plain text content" is the body. "content" would be HTML, which we do not want.
export const OUTLOOK_SCRIPT = `
on run argv
  set theTo to item 1 of argv
  set theSubject to item 2 of argv
  set theBody to item 3 of argv
  set theName to item 4 of argv
  tell application "Microsoft Outlook"
    set newMessage to make new outgoing message with properties {subject:theSubject, plain text content:theBody}
    if theTo is not "" then
      make new to recipient at newMessage with properties {email address:{name:theName, address:theTo}}
    end if
    open newMessage
    activate
  end tell
end run
`;

/**
 * Open a draft in Outlook, not Apple Mail.
 * First ask Outlook directly. If that app will not listen, hand the same
 * draft to the Outlook app as a mail link.
 */
export function icsEscape(text) {
  return String(text || "")
    .replace(/\\/g, "\\\\")
    .replace(/\r?\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}

export function icsLocal(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}T${pad(date.getHours())}${pad(date.getMinutes())}00`;
}

/** A calendar file Outlook opens as a new event on the calendar the user actually sees. */
export function meetingIcs(meeting) {
  const start = meeting.date;
  const end = new Date(start.getTime() + (meeting.duration || 60) * 60 * 1000);
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//second-brain//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${crypto.randomUUID()}@second-brain`,
    `DTSTAMP:${icsLocal(new Date())}`,
    `DTSTART:${icsLocal(start)}`,
    `DTEND:${icsLocal(end)}`,
    `SUMMARY:${icsEscape(meeting.subject)}`,
  ];
  if (meeting.location) lines.push(`LOCATION:${icsEscape(meeting.location)}`);
  if (meeting.body) lines.push(`DESCRIPTION:${icsEscape(meeting.body)}`);
  lines.push("END:VEVENT", "END:VCALENDAR", "");
  return lines.join("\r\n");
}

export async function openOutlookMeeting(meeting) {
  const file = path.join(os.tmpdir(), `meeting-${Date.now()}.ics`);
  await fs.writeFile(file, meetingIcs(meeting), "utf8");
  // Opening the file shows Outlook's Add Event window. Saving through the
  // script only reached a hidden On My Computer calendar, which is not the
  // calendar the user looks at.
  await runCommand("open", ["-a", "Microsoft Outlook", file]);
}

export async function openOutlookDraft({ to, subject, body, name }) {
  try {
    await runCommand("osascript", ["-e", OUTLOOK_SCRIPT, to, subject, body, name || ""]);
  } catch (err) {
    console.error("Outlook did not take the draft directly:", err?.message || err);
    const mailto = `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    await runCommand("open", ["-b", "com.microsoft.Outlook", mailto]);
  }
}
