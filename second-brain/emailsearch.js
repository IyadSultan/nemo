/**
 * "Find the email from Sara about the budget" -> lists up to three saved emails (raw/), newest first.
 * "Open number two"                            -> brings Outlook forward and searches for that subject.
 * "Open the email about the IRB renewal"       -> one clear match goes straight to Outlook.
 *
 * The saved copies in raw/ have no Outlook message ID, so Outlook is reached through its
 * search box (Command-Option-F). That needs Accessibility permission for the server once.
 * Subjects and senders are never logged (they may name patients).
 */

import fs from "node:fs";
import { execFile } from "node:child_process";
import { rememberList } from "./openfile.js";

const FIND_MAIL = /^(?:hey,?\s+)?(?:please\s+)?(?:can\s?you\s+|could\s?you\s+)?(?:please\s+)?(find|search for|look for|locate|open|pull up|show me)\s+(?:the\s+|an\s+|my\s+|that\s+)?e-?mails?\s+((?:from|about|regarding|on|with|titled|called|that says)\s+.+?)[?.!]*$/i;
const SEARCH_MAIL = /^(?:hey,?\s+)?(?:please\s+)?(?:can\s?you\s+)?search\s+(?:my\s+|the\s+)?(?:e-?mails?|inbox|outlook|mail)\s+for\s+(.+?)[?.!]*$/i;
const FILLER = new Set(["the", "an", "my", "from", "about", "regarding", "on", "with", "titled", "called", "that", "says", "email", "emails", "mail", "and", "for", "to", "of", "in", "dr", "doctor"]);
// Reading the first lines finds senders, but only for recent mail, to stay fast.
const HEAD_FILES = 1500;
const HEAD_BYTES = 2000;

const OUTLOOK_SEARCH = `
on run argv
  set theQuery to item 1 of argv
  set oldClip to the clipboard
  set the clipboard to theQuery
  tell application "Microsoft Outlook" to activate
  delay 0.8
  tell application "System Events"
    keystroke "f" using {command down, option down}
    delay 0.4
    keystroke "a" using {command down}
    keystroke "v" using {command down}
    delay 0.2
    key code 36
  end tell
  delay 0.5
  set the clipboard to oldClip
end run`;

/** Returns { query, open } when the question asks to find or open an email, else null. */
export function emailSearchJob(question) {
  const q = String(question || "").trim().replace(/^["“'\s.,]+|["”'\s]+$/g, "");
  const find = q.match(FIND_MAIL);
  if (find) return { query: find[2].trim(), open: /^(?:open|pull up)$/i.test(find[1]) };
  const search = q.match(SEARCH_MAIL);
  return search ? { query: search[1].trim(), open: false } : null;
}

function terms(query) {
  return (query.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).filter((word) => word.length >= 3 && !FILLER.has(word));
}

function head(file) {
  try {
    const fd = fs.openSync(file, "r");
    const buffer = Buffer.alloc(HEAD_BYTES);
    const read = fs.readSync(fd, buffer, 0, HEAD_BYTES, 0);
    fs.closeSync(fd);
    return buffer.subarray(0, read).toString("utf8").toLowerCase();
  } catch {
    return "";
  }
}

/** Up to three saved emails whose subject (or, for recent mail, first lines) hold every word. */
export function searchEmails(query, rawMail) {
  const wanted = terms(query);
  if (!wanted.length) return [];
  const newest = [...rawMail].sort((a, b) => b.mtime - a.mtime);
  const hits = newest.filter((mail) => wanted.every((word) => mail.lowerName.includes(word)));
  if (hits.length < 3) {
    for (const mail of newest.slice(0, HEAD_FILES)) {
      if (hits.length >= 3) break;
      if (hits.includes(mail)) continue;
      const text = `${mail.lowerName} ${head(mail.full)}`;
      if (wanted.every((word) => text.includes(word))) hits.push(mail);
    }
    hits.sort((a, b) => b.mtime - a.mtime);
  }
  return hits.slice(0, 3);
}

function subject(mail) {
  return mail.title.replace(/_/g, " ").replace(/\s+/g, " ").trim();
}

function spokenDay(mtime) {
  const day = new Date(mtime);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = Math.round((today - new Date(day).setHours(0, 0, 0, 0)) / 86_400_000);
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  return `on ${day.toLocaleDateString("en-US", { month: "long", day: "numeric" })}`;
}

/** Bring Outlook forward and search for the email's subject. */
async function openInOutlook(mail) {
  // Drop FW / RE prefixes and keep the first words; Outlook matches them anywhere.
  const query = subject(mail).replace(/^(?:(?:fw|fwd|re)\s*:?\s+)+/i, "").split(" ").slice(0, 10).join(" ");
  try {
    await new Promise((resolve, reject) => {
      execFile("/usr/bin/osascript", ["-e", OUTLOOK_SEARCH, query], { timeout: 20_000 }, (err, _out, stderr) => {
        if (err) reject(new Error(stderr || err.message));
        else resolve();
      });
    });
    return `I searched Outlook for ${query}. It should be at the top.`;
  } catch (err) {
    const blocked = /assistive|not allowed|-1719|-25211|1002/i.test(err.message);
    console.error("Failed while searching Outlook:", blocked ? "Accessibility permission missing" : err.message.split("\n")[0]);
    return blocked
      ? "Outlook search needs one permission. Open System Settings, Privacy and Security, Accessibility, and turn on the app that runs the brain server. Then ask again."
      : "I could not search Outlook. Check that Outlook is open.";
  }
}

export async function runEmailSearch(job, rawMail) {
  const hits = searchEmails(job.query, rawMail);
  console.log(`Email search: ${hits.length} match(es)`);
  if (!hits.length) {
    const text = `I could not find an email ${job.query} in your saved mail.`;
    return { text, card: { title: "Emails", lines: [text] } };
  }
  if (job.open && hits.length === 1) {
    const text = await openInOutlook(hits[0]);
    return { text, card: { title: "Emails", lines: [text] } };
  }
  rememberList(hits, openInOutlook);
  const lines = hits.map((mail, index) => `${index + 1}. ${subject(mail)} (${spokenDay(mail.mtime)})`);
  const names = hits.map((mail, index) => `${index + 1}, ${subject(mail)}, ${spokenDay(mail.mtime)}`).join(". ");
  const text = `I found ${hits.length} email${hits.length === 1 ? "" : "s"}. ${names}. Say open number one${hits.length > 1 ? ", two, or three" : ""} to see it in Outlook.`;
  return { text, card: { title: "Emails", lines } };
}
