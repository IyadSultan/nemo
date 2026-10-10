/**
 * Text the second brain from your phone, by iMessaging yourself.
 *
 * voice/imessage-bridge (a small helper with Full Disk Access) reads new
 * messages in your self-chat and posts them to /imessage/incoming with a
 * secret token. This server answers through /ask and replies with Messages.
 * The server itself never reads chat.db.
 *
 * Safety:
 *   - Off unless IMESSAGE_HANDLE (your own phone number or Apple ID email) is set in .env.
 *   - Replies go only to that handle. The bridge only passes on your self-chat.
 *   - The token lives in ~/.config/hey-my-brain/imessage.token (only you can read it),
 *     so other programs or other machines on the network cannot post questions.
 *   - Nothing is sent or booked from a text. Emails come back as draft text, and a
 *     meeting only opens Outlook's unsaved event window on the Mac for you to check.
 *   - Replies start with 🧠, so the bridge skips them and the brain never answers itself.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";

const TOKEN_FILE = path.join(os.homedir(), ".config", "hey-my-brain", "imessage.token");
const MAX_IN = 2000;
const MAX_OUT = 4000;
// Texts a few minutes apart still count as one conversation.
const HISTORY_MS = 30 * 60 * 1000;

const SEND_SCRIPT = `
on run argv
  set theText to item 1 of argv
  set theHandle to item 2 of argv
  tell application "Messages"
    set theAccount to first account whose service type = iMessage
    send theText to participant theHandle of theAccount
  end tell
end run`;

// Read when needed: this module loads before server.js has read .env.
export function imessageHandle() {
  return (process.env.IMESSAGE_HANDLE || "").trim();
}

function readOrMakeToken() {
  try {
    return fs.readFileSync(TOKEN_FILE, "utf8").trim();
  } catch {
    const token = crypto.randomBytes(32).toString("hex");
    fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true, mode: 0o700 });
    fs.writeFileSync(TOKEN_FILE, `${token}\n`, { mode: 0o600 });
    return token;
  }
}

function tokenMatches(given, token) {
  const a = Buffer.from(String(given || ""));
  const b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Send a text to the user's own handle. Does nothing when iMessage is off. */
export function sendIMessage(text) {
  if (!imessageHandle()) return Promise.resolve(false);
  const body = `🧠 ${String(text).trim()}`.slice(0, MAX_OUT);
  return new Promise((resolve, reject) => {
    execFile("/usr/bin/osascript", ["-e", SEND_SCRIPT, body, imessageHandle()], { timeout: 30_000 }, (err) => {
      if (err) reject(err);
      else resolve(true);
    });
  });
}

/**
 * "Send me an iMessage saying hi"      -> { words: "hi" }               (sent as written)
 * "Send me an iMessage with my schedule" -> { ask: "my schedule" }       (the brain's answer is sent)
 * Only ever to your own handle. Returns null when the question is not this.
 */
export function textMeJob(question) {
  // Drop quotes and stray punctuation around a typed or heard sentence.
  const q = String(question || "").trim().replace(/^["“'\s.,]+|["”'\s]+$/g, "");
  const unquote = (text) => text.replace(/^["“']|["”']$/g, "").trim();
  const match = q.match(
    /^(?:hey,?\s+)?(?:please\s+)?(?:can\s?you\s+|could\s?you\s+|would\s?you\s+)?(?:please\s+)?(?:send\s+me\s+(?:an?\s+)?(?:i\s?message|text|message)|send\s+(?:an?\s+)?(?:i\s?message|text|message)\s+to\s+me|text\s+me|message\s+me)\b[\s,:]*(saying|that says|that|with|about|containing|listing|of|:)?\s*(.*?)[?.!]*$/i,
  );
  if (match) {
    const link = (match[1] || "").toLowerCase();
    const rest = unquote(match[2]);
    // "with my schedule" asks for content; "saying hi" is the content.
    if (/^(?:with|about|containing|listing|of)$/.test(link) || (!link && /^(?:my|today'?s?|tomorrow'?s?)\b/i.test(rest))) return { ask: rest };
    return { words: rest };
  }
  // Speech often mishears "send me an iMessage" ("Simeon. I message saying hi").
  // Any "iMessage ... saying X" counts, unless it asks about past messages or names someone else.
  const loose = q.match(/\bi\s?messages?\b.*?\b(?:saying|that says)\b[\s,:]*(.*?)[?.!]*$/i);
  const before = loose ? q.split(/\bsaying\b|\bthat says\b/i)[0] : "";
  if (loose && !/\b(?:did|has|have|was|what|who|when|which|read|show|find)\b/i.test(before) && !/\bto\s+(?!me\b)\w+/i.test(before)) {
    return { words: unquote(loose[1]) };
  }
  return null;
}

/** Do the "text me" request and return the sentence to say back. askBrain answers { ask } requests. */
export async function runTextMe(job, askBrain) {
  if (!imessageHandle()) return "iMessage is not set up yet. Add IMESSAGE_HANDLE with your number to the .env file, then restart the server.";
  if (!job.words && !job.ask) return "What should the message say?";
  try {
    const text = job.ask ? await askBrain(`Tell me ${job.ask}`) : job.words;
    if (!text) return "I had nothing to send for that.";
    await sendIMessage(text);
    return job.ask ? `Sent you an iMessage with ${job.ask}.` : `Sent you an iMessage: ${text}`;
  } catch (err) {
    console.error("Failed while sending a text to the user:", err?.message || err);
    return "I could not send the iMessage. Check that Messages is signed in, and allow the permission prompt on the Mac.";
  }
}

/**
 * Add POST /imessage/incoming.
 * askBrain(question, history) returns the answer text.
 */
export function registerIMessage(app, askBrain) {
  if (!imessageHandle()) return;
  const token = readOrMakeToken();
  let history = [];
  let lastAt = 0;
  // One question at a time, in the order they arrived.
  let queue = Promise.resolve();

  app.post("/imessage/incoming", (req, res) => {
    if (!tokenMatches(req.get("X-Bridge-Token"), token)) return res.status(403).json({ error: "Wrong token." });
    const text = typeof req.body?.text === "string" ? req.body.text.trim().slice(0, MAX_IN) : "";
    if (!text || text.startsWith("🧠")) return res.json({ ok: true, ignored: true });
    res.json({ ok: true });
    queue = queue.then(async () => {
      if (Date.now() - lastAt > HISTORY_MS) history = [];
      let answer;
      try {
        answer = await askBrain(text, history);
      } catch (err) {
        console.error("Failed while answering a text:", err?.message || err);
        answer = "Sorry, I could not answer that. Check the server log on the Mac.";
      }
      history = [...history, { question: text, answer }].slice(-6);
      lastAt = Date.now();
      try {
        await sendIMessage(answer || "I have no answer for that.");
        console.log(`Answered a text (${text.length} chars in, ${answer.length} out)`);
      } catch (err) {
        console.error("Failed while sending the iMessage reply:", err?.message || err);
      }
    });
  });
  console.log("iMessage questions are on (self-chat only).");
}
