/**
 * Saved emails in raw/: index them, count today's, find one by name or subject,
 * read it aloud, and shape a reply or a new letter for Outlook.
 */

import { emailJob } from "./intents.js";
import { queryTerms } from "./notes.js";
import { savedLabel, speakTitle, startOfDayMs } from "./spoken.js";
import { rawMail, selected, setRawMail } from "./state.js";
import fs from "node:fs/promises";
import path from "node:path";

export const EMAIL_JOB_SKIP = new Set([
  "last", "night", "read", "reads", "reading", "reply", "replies", "respond",
  "draft", "this", "that", "message", "messages", "write", "back", "send",
  "open", "contents", "body", "please",
]);

export const EMAIL_FILLER = new Set([
  "new", "today", "latest", "recent", "mail", "email", "emails", "inbox",
  "any", "got", "get", "did", "from", "sent", "receive", "received",
  "yesterday", "last", "check", "folder", "file", "files", "raw",
]);

export function oneEditApart(a, b) {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i += 1;
      j += 1;
      continue;
    }
    edits += 1;
    if (edits > 1) return false;
    if (a.length === b.length) {
      i += 1;
      j += 1;
    } else if (a.length > b.length) i += 1;
    else j += 1;
  }
  if (i < a.length || j < b.length) edits += 1;
  return edits <= 1;
}

export function nameMatchesFile(term, words) {
  return words.some((word) => {
    if (word === term) return true;
    // "asim" can mean "asem". A longer word like "qasim" is a different name.
    return term.length >= 4 && word.length === term.length && oneEditApart(term, word);
  });
}

export async function indexRawMail() {
  const found = [];

  async function walk(dir, root) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      console.error(`Failed while listing raw mail: ${dir}`);
      console.error(err?.message || err);
      return;
    }
    for (const entry of entries) {
      // Skip hidden folders and cleaned copies such as raw/_clean.
      if (entry.name.startsWith(".") || entry.name.startsWith("_")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // Memos, minutes, and lecture notes live beside the mail. They are not emails.
        if ((entry.name === "notes" || entry.name === "meetings" || entry.name === "lectures") && path.basename(dir) === "raw") continue;
        await walk(full, root);
        continue;
      }
      if (!entry.isFile() || !/\.(txt|md)$/i.test(entry.name)) continue;
      try {
        const stat = await fs.stat(full);
        found.push({
          rel: path.relative(root, full).replaceAll("\\", "/"),
          title: entry.name.replace(/\.(txt|md)$/i, ""),
          full,
          mtime: stat.mtimeMs,
          size: stat.size,
          lowerName: entry.name.toLowerCase(),
          words: entry.name.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length >= 4),
        });
      } catch (err) {
        console.error(`Failed while indexing a raw email: ${full}`);
        console.error(err?.message || err);
      }
    }
  }

  for (const root of selected) {
    const rawDir = path.join(root, "raw");
    try {
      await fs.access(rawDir);
    } catch {
      continue;
    }
    await walk(rawDir, root);
  }

  setRawMail(found);
  console.log(`Indexed ${rawMail.length} files in raw/`);
}

/** Counts come from the saved time of each file in raw/, not from the model. */
export function mailFacts() {
  const todayStart = startOfDayMs(0);
  const yesterdayStart = startOfDayMs(-1);
  let today = 0;
  let yesterday = 0;
  let newest = null;
  for (const file of rawMail) {
    if (file.mtime >= todayStart) today += 1;
    else if (file.mtime >= yesterdayStart && file.mtime < todayStart) yesterday += 1;
    if (!newest || file.mtime > newest.mtime) newest = file;
  }
  return { today, yesterday, total: rawMail.length, newest, todayStart, yesterdayStart };
}

/**
 * today and "new" mean files saved since midnight.
 * The whole folder is a different number and must not be called today.
 */
export function emailWindow(question) {
  const q = question.toLowerCase();
  if (/\blast night\b/.test(q)) return "night";
  if (/\byesterday\b/.test(q)) return "yesterday";
  if (/\b(today|tonight|new|latest|recent)\b/.test(q)) return "today";
  if (/\blast\b/.test(q) && !/\blast\s+(week|month|year|few|couple)\b/.test(q)) return "last";
  return "all";
}

export function nightRange() {
  const now = new Date();
  const start = new Date(now);
  const end = new Date(now);
  if (now.getHours() < 18) {
    start.setDate(start.getDate() - 1);
    start.setHours(18, 0, 0, 0);
    end.setHours(5, 0, 0, 0);
    if (now.getHours() >= 5) end.setTime(now.getTime());
  } else {
    start.setHours(18, 0, 0, 0);
    end.setTime(now.getTime());
  }
  return [start.getTime(), end.getTime()];
}

/** The email named in the last answer, when the user says "this email". */
export function fileMentionedInHistory(history) {
  const blob = (history || [])
    .slice(-2)
    .map((turn) => `${turn.question || ""} ${turn.answer || ""}`)
    .join(" ")
    .toLowerCase();
  if (!blob.trim()) return null;
  const titled = rawMail.filter((file) => {
    const title = speakTitle(file.title).toLowerCase();
    return title.length >= 12 && blob.includes(title);
  });
  if (titled.length) return titled.sort((a, b) => b.mtime - a.mtime)[0];
  return null;
}

/** A person's name only counts after the word "from", such as "from Asim Mansour". */
export function emailNames(question) {
  const match = question.toLowerCase().match(/\bfrom\s+([a-z][a-z'’-]+(?:\s+[a-z][a-z'’-]+){0,2})/);
  if (!match) return [];
  const words = match[1].split(/\s+/);
  // "from today" is a time, not a person. Stop before the name search begins.
  if (EMAIL_FILLER.has(words[0]) || EMAIL_JOB_SKIP.has(words[0])) return [];
  return words.filter((word) => !EMAIL_FILLER.has(word) && !EMAIL_JOB_SKIP.has(word) && word.length >= 4);
}

export function plainEmailText(raw) {
  let text = String(raw || "");
  text = text.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ");
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<\/(p|div|tr|li|h[1-6]|table)>/gi, "\n");
  text = text.replace(/<[^>]+>/g, " ");
  text = text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, " and ")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, " ");
  text = text.replace(/&#\d+;/g, " ").replace(/&[a-z]+;/gi, " ");
  return text
    .split(/\n+/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line && !/[{}]/.test(line))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

export async function readRawExcerpt(file, maxLen = 700, brief = false) {
  const raw = await fs.readFile(file.full, "utf8");
  const body = plainEmailText(raw).slice(0, maxLen);
  // A list should be a short summary. The subject is for the model, not for reading aloud.
  const text = brief
    ? `Use this only to write a short summary. Do not read it aloud. Subject: ${speakTitle(file.title)}. Message: ${body}`
    : `Saved ${savedLabel(file.mtime)}. Subject: ${speakTitle(file.title)}. Message: ${body}`;
  return {
    note: { rel: file.rel, title: brief ? "Email" : speakTitle(file.title), text, lower: text.toLowerCase() },
    terms: [],
  };
}

/** The user's own address, and robots, are not who a reply should go to. */
export function isOwnAddress(address) {
  const lower = String(address || "").toLowerCase();
  return lower === "isultan@khcc.jo" || lower.startsWith("donotreply@");
}

/**
 * The filename is the subject, with underscores where spaces were.
 * "Re_ Colony Count" becomes "Re: Colony Count".
 */
export function replySubject(title) {
  let subject = String(title || "")
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/_+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  subject = subject.replace(/^(re|fw|fwd)\s+/i, "");
  if (!subject) subject = "your email";
  return `Re: ${subject}`;
}

/** "Haitham Aryan" becomes "Haitham". A title such as Dr is skipped. */
export function firstName(full) {
  const words = String(full || "").trim().split(/\s+/);
  for (const raw of words) {
    const word = raw.replace(/[,.]+$/, "");
    if (!/^[A-Za-z][A-Za-z'’-]+$/.test(word)) continue;
    if (/^(dear|dr|doctor|mr|mrs|ms|from|to)$/i.test(word)) continue;
    return word.charAt(0).toUpperCase() + word.slice(1);
  }
  return "";
}

/**
 * How the written reply should look.
 * The voice still hears only the short part before EMAIL_BODY.
 */
export function replyDraftNote(outlook) {
  const first = firstName(outlook?.name);
  const greet = first
    ? `The greeting must be Dear ${first}.`
    : "Greet the person who sent the email by their first name. If the message has no name, write Dear colleague.";
  return [
    "Draft a reply to this one email.",
    "First write two or three plain spoken sentences. The voice reads only those.",
    "Tell them to say send it to open the reply in Outlook, or don't to drop it.",
    "Then write one line that is exactly EMAIL_BODY.",
    "After that line write the email the user will send.",
    greet,
    "Leave a blank line after the greeting, a blank line before Best regards, and a blank line before IS.",
    "End the greeting with a comma. End Best regards with a comma. End each sentence with a period.",
    "Do not write brackets. Do not write Sender Name or Your Name.",
    "Do not paste the original message. The app adds it under the reply.",
    "Do not copy Get Outlook for Mac or any phone signature.",
    "The email may use line breaks. The voice must not read it.",
    "Do not ask what they want to say. Do not mention files or other emails.",
  ].join(" ");
}

/**
 * How a brand-new email should look.
 * Same shape as a reply: a short spoken part, then EMAIL_BODY, then the letter.
 * There is no saved message to quote underneath.
 */
export function sendDraftNote(outlook) {
  const first = firstName(outlook?.name);
  const greet = first
    ? `The greeting must be Dear ${first}.`
    : "If a person is named, greet them by their first name. If not, write Dear colleague.";
  const who = outlook?.name
    ? `This email is for ${outlook.name}.`
    : "The user did not name who it is for. Still write the letter.";
  return [
    "Draft a new email. This is not a reply to a saved message.",
    who,
    "First write two or three plain spoken sentences. The voice reads only those.",
    "Say that a draft is ready. Tell them to say send it to open it in Outlook, or don't to drop it.",
    "Then write one line that is exactly EMAIL_BODY.",
    "After that line write the email the user will send.",
    "Use what the user asked to say. Do not ask what they want to say.",
    "Do not add facts they did not say. Do not say a file is attached.",
    greet,
    "Do not write a subject line. The app already set the subject.",
    "Leave a blank line after the greeting, a blank line before Best regards, and a blank line before IS.",
    "End the greeting with a comma. End Best regards with a comma. End each sentence with a period.",
    "Do not write brackets. Do not write Sender Name or Your Name.",
    "Do not paste another message. Do not mention files or other emails.",
    "The email may use line breaks. The voice must not read it.",
  ].join(" ");
}

/** "haitham aryan" becomes "Haitham Aryan". Words like "about" end the name. */
export function composeRecipient(question) {
  // "Dr. Haitham" is the same name as "Dr Haitham".
  const cleaned = question.replace(/\b(dr|doctor|mr|mrs|ms)\./gi, "$1");
  const to = cleaned.match(/\b(?:to|for)\s+([a-z][a-z'’-]+(?:\s+[a-z][a-z'’-]+){0,2})/i);
  const named = cleaned.match(/\b(?:send|e-?mail)\s+([a-z][a-z'’-]+(?:\s+[a-z][a-z'’-]+){0,2})(?=\s+(?:an?\s+)?(?:e-?mail|message|about|saying|that)\b)/i);
  const raw = (to || named)?.[1] || "";
  const stop = new Set([
    "about", "regarding", "saying", "that", "with", "and", "the", "a", "an",
    "me", "him", "her", "them", "please", "today", "tomorrow", "this", "my",
  ]);
  const titles = new Set(["dr", "doctor", "mr", "mrs", "ms"]);
  const kept = [];
  for (const word of raw.split(/\s+/)) {
    if (!word || stop.has(word.toLowerCase())) break;
    if (titles.has(word.toLowerCase().replace(/[,.]+$/, ""))) continue;
    kept.push(word.charAt(0).toUpperCase() + word.slice(1));
  }
  return kept.join(" ");
}

/** The topic after "about" or "saying", used as the Outlook subject. */
export function composeSubject(question) {
  const match = question.match(/\b(?:about|regarding|subject|saying|to say|that)\s+(.+)/i);
  if (!match) return "Note";
  let subject = match[1]
    .replace(/^(?:says\s+)/i, "")
    .replace(/\b(?:saying|and say|tell(?:ing)? (?:him|her|them))\b[\s\S]*$/i, "")
    .replace(/[.?!]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!subject) return "Note";
  subject = subject.charAt(0).toUpperCase() + subject.slice(1);
  if (subject.length > 80) subject = `${subject.slice(0, 77).replace(/\s+\S*$/, "")}…`;
  return subject || "Note";
}

/**
 * Find this person's address in a saved email, when the name is in the file.
 * If none is found, Outlook still opens and the user can type the address.
 */
export async function addressForName(fullName) {
  const words = String(fullName || "")
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word.length >= 3 && !/^(dr|doctor|mr|mrs|ms)$/.test(word));
  if (!words.length) return null;
  const ranked = rawMail
    .map((file) => ({
      file,
      score: words.filter((term) => nameMatchesFile(term, file.words)).length,
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || b.file.mtime - a.file.mtime)
    .slice(0, 8)
    .map((item) => item.file);
  const files = ranked.length
    ? ranked
    : [...rawMail].sort((a, b) => b.mtime - a.mtime).slice(0, 20);
  for (const file of files) {
    try {
      const head = (await fs.readFile(file.full, "utf8")).slice(0, 12000);
      if (!words.some((word) => head.toLowerCase().includes(word))) continue;
      const people = peopleInMail(head);
      const match = people.find((person) => {
        if (isOwnAddress(person.address)) return false;
        const name = person.name.toLowerCase();
        return words.every((word) => name.includes(word));
      });
      if (match) return match;
    } catch (err) {
      console.error(`Failed while looking up an address in: ${file.full}`);
      console.error(err?.message || err);
    }
  }
  return null;
}

/** A new email: who it is for, the subject, and an empty quote. */
export async function composeEmailHits(question) {
  const spokenName = composeRecipient(question);
  const typed = question.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  const person = typed ? null : await addressForName(spokenName);
  const hits = [];
  hits.emailJob = "send";
  hits.sayThis = "";
  hits.outlook = {
    to: cleanMailAddress(typed?.[0] || "") || person?.address || "",
    name: person?.name || spokenName,
    subject: composeSubject(question),
    original: "",
  };
  return hits;
}

/**
 * Turn a sloppy model draft into the letter that should open in Outlook.
 * [Sender Name] becomes the person's first name. [Your Name] becomes IS.
 */
/** The saved message as plain lines, so a reply can quote it. */
export function emailLines(raw) {
  let text = String(raw || "");
  text = text.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ");
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<\/(p|div|tr|li|h[1-6]|table)>/gi, "\n");
  text = text.replace(/<[^>]+>/g, " ");
  text = text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"');
  text = text.replace(/&#\d+;/g, " ").replace(/&[a-z]+;/gi, " ");
  return text
    .split(/\n+/)
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter((line) => line && !/[{}]/.test(line) && !/^Get Outlook for /i.test(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** From, subject, and the message, placed under the new reply. */
export function quotedOriginal(raw, person, title) {
  const body = emailLines(raw).slice(0, 5000);
  const who = [person?.name, person?.address ? `<${person.address}>` : ""].filter(Boolean).join(" ");
  const subject = String(title || "")
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/_+/g, " ")
    .replace(/^(re|fw|fwd)\s+/i, "")
    .replace(/\s+/g, " ")
    .trim();
  const header = [
    who ? `From: ${who}` : "",
    subject ? `Subject: ${subject}` : "",
  ].filter(Boolean).join("\n");
  return [header, body].filter(Boolean).join("\n\n");
}

/** The new letter, then a line, then the email being answered. */
export function replyWithOriginal(body, original) {
  const quote = String(original || "").trim().slice(0, 6000);
  if (!quote) return body;
  const start = quote.slice(0, 80);
  if (start && body.includes(start)) return body;
  return `${body}\n\n________________________________\n\n${quote}`;
}

/**
 * Turn a flat draft into a short letter.
 * "Dear Anwar / We have to meet tomorrow. / Best regards / IS"
 * becomes a greeting, a blank line, the message, a blank line, then the sign-off.
 */
export function polishReply(body, fullName) {
  const first = firstName(fullName);
  let text = String(body || "")
    .replace(/[ \t]*Get Outlook for (?:Mac|iOS|Android|Windows)[^\n]*/gi, "")
    .replace(/\[(?:Sender|Recipient)\s*Name\]/gi, first || "colleague")
    .replace(/\[Your Name\]/gi, "IS");
  if (first) {
    text = text.replace(/^(\s*Dear\s+)(?:colleague|friend|there)\b/i, `$1${first}`);
  }
  text = text.replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n").trim();

  // Words that start the message, so they are not treated as part of the name.
  const sentenceStart = new Set([
    "i", "we", "the", "please", "this", "it", "thank", "thanks", "can", "could",
    "would", "let", "just", "also", "there", "here", "my", "our", "your", "as",
    "if", "when", "after", "before", "a", "an", "so", "and", "but",
  ]);

  let sign = "";
  const signMatch = text.match(/^([\s\S]*?)\s*\bbest regards\b[,.]?\s*(?:\n+\s*)?(?:IS)?\s*$/i);
  if (signMatch) {
    text = signMatch[1].trim();
    sign = "Best regards,\n\nIS";
  }

  let greet = "";
  const dear = text.match(/^dear\s+([\s\S]+)$/i);
  if (dear) {
    const rest = dear[1].trim();
    const withComma = rest.match(/^([^,\n]{1,80}),\s*([\s\S]*)$/);
    const withLine = rest.match(/^([^\n]{1,80})\n+([\s\S]*)$/);
    if (withComma) {
      greet = `Dear ${withComma[1].trim()},`;
      text = withComma[2].trim();
    } else if (withLine && withLine[1].trim().split(/\s+/).length <= 4) {
      greet = `Dear ${withLine[1].replace(/[,.]$/, "").trim()},`;
      text = withLine[2].trim();
    } else {
      const words = rest.split(/\s+/);
      const name = [];
      for (const word of words) {
        const bare = word.replace(/[,.]$/, "");
        if (name.length && sentenceStart.has(bare.toLowerCase())) break;
        if (name.length >= 3) break;
        if (name.length && !/^[A-Z]/.test(bare)) break;
        name.push(bare);
        if (/[,.]$/.test(word)) break;
      }
      greet = `Dear ${name.join(" ")},`;
      text = words.slice(name.length).join(" ").replace(/^[,.\s]+/, "");
    }
  }

  const message = text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => (/[.!?]$/.test(line) ? line : `${line}.`))
    .map((line, index) => (index === 0 ? line.charAt(0).toUpperCase() + line.slice(1) : line))
    .join("\n\n");

  return [greet, message, sign].filter(Boolean).join("\n\n");
}

export function plainMail(raw) {
  return String(raw || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ");
}

/**
 * Every "Name <email>" in the saved message, marked from or to.
 * One To line can list several people. All of them count.
 */
export function peopleInMail(text) {
  const people = [];
  const pattern = /([A-Za-z][A-Za-z'’. -]{0,60}?)\s*<\s*([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})\s*>/gi;
  let match;
  while ((match = pattern.exec(text))) {
    const before = text.slice(Math.max(0, match.index - 180), match.index).toLowerCase();
    const fromAt = before.lastIndexOf("from:");
    const toAt = Math.max(before.lastIndexOf("to:"), before.lastIndexOf("cc:"));
    let role = "";
    if (fromAt >= 0 || toAt >= 0) role = fromAt > toAt ? "from" : "to";
    people.push({
      role,
      name: match[1].replace(/\s+/g, " ").replace(/^[\s;:,]+|[\s;:,]+$/g, "").trim(),
      address: match[2],
    });
  }
  return people;
}

/**
 * Who this reply goes to.
 * If someone else sent the message, use their address.
 * If the first From line is the user, he is quoted inside a reply,
 * so use the person he greeted, such as Dear Haitham.
 */
export function replyAddress(raw) {
  const text = plainMail(raw);
  const people = peopleInMail(text);
  const firstFrom = people.find((person) => person.role === "from");
  if (firstFrom && !isOwnAddress(firstFrom.address)) return firstFrom;

  const seen = new Set();
  const humans = [];
  for (const person of people) {
    if (person.role !== "to" || isOwnAddress(person.address)) continue;
    const key = person.address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    humans.push(person);
  }

  const dearPattern = /\bDear\s+(?:Dr\.?\s+|Mr\.?\s+|Ms\.?\s+)?([A-Za-z][A-Za-z'’-]+)/gi;
  let dear;
  while ((dear = dearPattern.exec(text))) {
    const wanted = dear[1].toLowerCase();
    if (wanted === "iyad") continue;
    const match = humans.find((person) => firstName(person.name).toLowerCase() === wanted);
    if (match) return match;
  }
  return humans[0] || null;
}

export function mailSentence(facts, when) {
  if (!facts.total || !facts.newest) return "The raw folder has no email files.";
  if (when === "yesterday") return `You got ${facts.yesterday} emails yesterday.`;
  if (when === "last") return "Here are the latest emails.";
  if (when === "today") return `You have ${facts.today} new emails today.`;
  return `The raw folder has ${facts.total} files in all. ${facts.today} were saved today.`;
}

/** Email questions look at raw/, where each saved message is a text file. */
export async function findRawEmails(question, history = []) {
  // The file list is built when the server starts. Mail keeps arriving after that,
  // so look at the folder again before counting "new" emails.
  await indexRawMail();
  // A new email is a draft, not a search of the inbox.
  if (emailJob(question) === "send") return composeEmailHits(question);
  const names = emailNames(question);
  const subjects = queryTerms(question).filter(
    (term) => !EMAIL_FILLER.has(term) && !EMAIL_JOB_SKIP.has(term) && term.length >= 4
  );
  let job = emailJob(question);
  // "List all emails" with no day means today's mail, not the whole archive.
  let when = emailWindow(question);
  if ((job === "list" || job === "review") && when === "all") when = "today";
  // Any question about today's mail gets every file, not a sample of three.
  if (job === "count" && when === "today") job = "list";
  const facts = mailFacts();
  const todayStart = facts.todayStart;
  let pool = rawMail;

  if (when === "night") {
    const [start, end] = nightRange();
    pool = rawMail.filter((file) => file.mtime >= start && file.mtime < end);
  } else if (when === "today") {
    pool = rawMail.filter((file) => file.mtime >= todayStart);
  } else if (when === "yesterday") {
    pool = rawMail.filter((file) => file.mtime >= facts.yesterdayStart && file.mtime < todayStart);
  }

  const lookFor = names.length ? names : subjects;
  let chosen = [];
  if (lookFor.length && (names.length || job === "read" || job === "reply")) {
    const ranked = pool
      .map((file) => ({
        file,
        score: lookFor.filter((term) => nameMatchesFile(term, file.words)).length,
      }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || b.file.mtime - a.file.mtime);
    const top = ranked[0]?.score || 0;
    chosen = ranked.filter((item) => item.score === top).map((item) => item.file);
    if (names.length && top > 0 && top < names.length) {
      chosen = chosen.filter((file) => {
        const shortName = names.some((term) => term.length <= 5 && nameMatchesFile(term, file.words));
        return shortName && /(^|[^a-z])dr([^a-z]|$)/.test(file.lowerName);
      });
    }
    if (!chosen.length && job !== "count") {
      const anywhere = rawMail
        .map((file) => ({
          file,
          score: lookFor.filter((term) => nameMatchesFile(term, file.words)).length,
        }))
        .filter((item) => item.score > 0)
        .sort((a, b) => b.score - a.score || b.file.mtime - a.file.mtime);
      chosen = anywhere.filter((item) => item.score === anywhere[0]?.score).map((item) => item.file);
    }
  } else {
    chosen = [...pool].sort((a, b) => b.mtime - a.mtime);
  }

  const pointsBack = /\b(this|that|same)\b/i.test(question);
  const oneMessage = job === "read" || job === "reply";
  if (oneMessage && (pointsBack || (job === "reply" && !subjects.length && !names.length))) {
    const earlier = fileMentionedInHistory(history);
    if (earlier) chosen = [earlier];
  }
  const listing = job === "list" || job === "count" || job === "review";
  const limit = oneMessage ? 1 : job === "list" || job === "review" ? Math.min(chosen.length, 40) : 3;
  const picks = chosen.slice(0, limit);
  const hits = [];
  if (job === "count") {
    hits.push({
      note: {
        rel: "raw/",
        title: "Email count",
        text: `Saved today: ${facts.today}. The emails below are examples. Summarize them. Do not say dates or file sizes.`,
        lower: "",
      },
      terms: [],
    });
  } else if (job === "list") {
    hits.push({
      note: {
        rel: "raw/",
        title: "Email count",
        text: `These are all ${picks.length} emails in this list, newest first. Summarize every one. Do not say dates or file sizes.`,
        lower: "",
      },
      terms: [],
    });
  } else if (job === "review") {
    hits.push({
      note: {
        rel: "raw/",
        title: "Email count",
        text: `These are all ${picks.length} emails from this period, newest first. Decide which ones need an urgent reply. Do not write a reply.`,
        lower: "",
      },
      terms: [],
    });
  }
  for (const file of picks) {
    try {
      const excerptLen = oneMessage ? 2200 : job === "review" ? 500 : 280;
      hits.push(await readRawExcerpt(file, excerptLen, listing && !oneMessage));
    } catch (err) {
      console.error(`Failed while reading a raw email: ${file.full}`);
      console.error(err?.message || err);
    }
  }
  hits.rawCount = chosen.length;
  hits.rawWhen = when;
  hits.emailJob = job;
  const opened = picks[0];
  if (job === "reply" && opened) {
    // Subject comes from the file name. The address is filled in only when the file has one.
    let person = null;
    let raw = "";
    try {
      raw = await fs.readFile(opened.full, "utf8");
      person = replyAddress(raw.slice(0, 30000));
    } catch (err) {
      console.error(`Failed while reading the reply address: ${opened.full}`);
      console.error(err?.message || err);
    }
    hits.outlook = {
      to: person?.address || "",
      name: person?.name || "",
      subject: replySubject(opened.title),
      original: quotedOriginal(raw, person, opened.title),
    };
  }
  if (oneMessage && opened) {
    const arrived = `saved ${savedLabel(opened.mtime)}`;
    hits.sayThis = job === "read"
      ? `This email is ${speakTitle(opened.title)}, ${arrived}.`
      : "";
  } else if (job === "review") {
    hits.sayThis = "";
  } else if (!oneMessage) {
    hits.sayThis = mailSentence(facts, when);
  } else {
    hits.sayThis = "I could not find that email in the raw folder.";
  }
  return hits;
}

export function cleanMailAddress(value) {
  const address = typeof value === "string" ? value.trim() : "";
  if (!address) return "";
  if (!/^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i.test(address)) return "";
  return address;
}
