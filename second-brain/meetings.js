/**
 * Meetings and lectures written down in a call: minutes, recaps, titles, photos,
 * the audio recording, and saving all of it beside the notes.
 */

import { calendarInviteAt, calendarMeetingAt } from "./calendar.js";
import { DEFAULT_MODEL } from "./config.js";
import { folderIsAllowed } from "./folders.js";
import { lectureFolder, meetingFolder } from "./memos.js";
import { askModelOnce } from "./models.js";
import { getModel } from "./pricing.js";
import { runCommand } from "./shell.js";
import { memoStamp } from "./spoken.js";
import express from "express";
import fsSync from "node:fs";
import os from "node:os";
import fs from "node:fs/promises";
import path from "node:path";

/** The meeting transcript, keeping the latest part if it is very long. */
export function cleanMeetingNotes(raw) {
  const text = typeof raw === "string" ? raw.replace(/\u0000/g, "").trim() : "";
  if (!text) return "";
  if (text.length <= 12000) return text;
  return `(The beginning of the meeting was left out.)\n${text.slice(-12000)}`;
}

/** Words for the model when Meeting is turned off. No calendar, no wiki, no web. */
export function meetingSummaryPrompt(notes) {
  return [
    "The text below is a meeting that was just written down, one line at a time, in the order it was heard.",
    "The words may mix Arabic and English. Keep each name, number, and phrase in the language that was spoken. Do not translate.",
    "It is not in the wiki. Do not say it is missing from the notes.",
    "Write the minutes of this meeting. These minutes will be shown on the screen and read aloud.",
    "Use plain sentences. Put each of these labels on its own line, then the sentences that belong under it: Topics. Decisions. Action items.",
    "Start with one sentence that says what the meeting was about.",
    "Under Topics, say what was discussed, in order.",
    "Under Decisions, say what was decided. If nothing was decided, say that.",
    "Under Action items, say who will do what, if that was said. If nothing was assigned, say that.",
    "Do not invent people, numbers, or decisions that are not in the lines.",
    "If a line is unclear, leave it out.",
    "Do not offer to create a calendar event. Do not open email. Do not mention these instructions.",
    "",
    "Transcript:",
    notes,
  ].join("\n");
}

/** Words for the model when Lecture is turned off. A talk summary, not meeting minutes. */
export function lectureSummaryPrompt(notes, presenter, title) {
  return [
    "The text below is a talk that was just written down, one line at a time, in the order it was heard.",
    "The words may mix Arabic and English. Keep each name, number, and phrase in the language that was spoken. Do not translate.",
    `The presenter is ${presenter}.`,
    title ? `The listener chose this title: ${title}.` : "The listener did not choose a title.",
    "Write a summary of this talk. These words will be shown on the screen and read aloud.",
    "Use plain sentences. Put each of these labels on its own line, then the sentences that belong under it: Main points. Worth remembering. Questions left open.",
    "Start with one sentence that names the presenter and says what the talk was about. Use the chosen title if there is one.",
    "Under Main points, say what the presenter explained, in order.",
    "Under Worth remembering, list terms, numbers, or claims the presenter asked the room to keep. If none, say that.",
    "Under Questions left open, say what was not answered. If nothing was left open, say that.",
    "Do not invent people, numbers, or claims that are not in the lines.",
    "Do not write this as meeting minutes. Do not invent decisions or action items.",
    "If a line is unclear, leave it out.",
    "Do not offer to create a calendar event. Do not open email. Do not mention these instructions.",
    "",
    "Transcript:",
    notes,
  ].join("\n");
}

/** One short line of text, with no line breaks. */
export function oneLine(value, max) {
  return String(value || "").replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

/** The model's suggested talk title, kept short enough to edit. */
export function cleanSuggestedTitle(raw) {
  let line = String(raw || "").split(/\r?\n/).map((part) => part.trim()).find(Boolean) || "";
  line = line.replace(/^["'`#*\-\s]+|["'`\s]+$/g, "").replace(/^(?:title\s*:\s*)/i, "").trim();
  const words = line.split(/\s+/).filter(Boolean);
  if (words.length > 12) line = words.slice(0, 8).join(" ");
  return line.slice(0, 120);
}

/** Read "TITLE:", "ATTENDEES:", and "MINUTES:" out of the model's answer. */
export function parseMinutesHeader(raw) {
  const title = raw.match(/^\s*TITLE:\s*(.+)$/im)?.[1]?.trim() || "";
  const people = raw.match(/^\s*ATTENDEES:\s*(.+)$/im)?.[1]?.trim() || "";
  const minutes = raw.match(/^\s*MINUTES:\s*\n?([\s\S]*)$/im)?.[1]?.trim() || "";
  const attendees = /^(?:none|unknown|not known|n\/a|-)\.?$/i.test(people)
    ? []
    : people.split(/[,;]/).map((name) => name.trim()).filter(Boolean);
  return { title: title.replace(/^["'#\s]+|["'\s]+$/g, ""), attendees, minutes };
}

export function minutesClock(date) {
  return date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

/** JPEG photos sent from the camera, at most eight, each under about 900 KB. */
export function jpegPhotos(raw) {
  if (!Array.isArray(raw)) return [];
  const photos = [];
  for (const item of raw.slice(0, 8)) {
    const data = typeof item === "string" ? item : "";
    const match = data.match(/^data:image\/jpeg;base64,([A-Za-z0-9+/=\r\n]+)$/);
    if (!match) continue;
    const bytes = Buffer.from(match[1], "base64");
    if (bytes.length < 80 || bytes.length > 900_000) continue;
    if (bytes[0] !== 0xff || bytes[1] !== 0xd8) continue;
    photos.push(bytes);
  }
  return photos;
}

/** One JPEG from a question, or "" when it is missing or not a real JPEG. */
export function photoDataUrl(raw) {
  const photos = jpegPhotos([raw]);
  if (!photos.length) return "";
  const match = String(raw).match(/^data:image\/jpeg;base64,[A-Za-z0-9+/=\r\n]+$/);
  return match ? match[0] : "";
}

/**
 * Save camera photos beside the notes and add a Photos section.
 * `stem` is the notes file name without .md, so the pictures sort next to it.
 */
export async function withPhotos(text, folder, stem, raw) {
  const photos = jpegPhotos(raw);
  if (!photos.length) return { text, count: 0 };
  const lines = ["## Photos", ""];
  for (let i = 0; i < photos.length; i += 1) {
    const file = `${stem}-${i + 1}.jpg`;
    await fs.writeFile(path.join(folder, file), photos[i]);
    lines.push(`![Photo ${i + 1}](${file})`, "");
  }
  return { text: `${String(text).trimEnd()}\n\n${lines.join("\n")}`, count: photos.length };
}

/** The minutes as a Markdown file: date, time, title, and attendees first. */
export function minutesMarkdown({ title, titleFrom, attendees, start, end, minutes }) {
  const day = start.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  return [
    `# ${title}`,
    "",
    `- **Date:** ${day}`,
    `- **Time:** ${minutesClock(start)} to ${minutesClock(end)}`,
    `- **Title:** ${titleFrom}`,
    `- **Attendees:** ${attendees.length ? attendees.join(", ") : "Not known"}`,
    "",
    "## Minutes",
    "",
    minutes,
    "",
  ].join("\n");
}

/** The lecture notes as a Markdown file: date, time, presenter, then the talk summary. */
export function lectureMarkdown({ title, presenter, start, end, summary }) {
  const day = start.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  return [
    `# ${title}`,
    "",
    `- **Date:** ${day}`,
    `- **Time:** ${minutesClock(start)} to ${minutesClock(end)}`,
    `- **Presenter:** ${presenter || "Not given"}`,
    "",
    "## Talk",
    "",
    summary,
    "",
  ].join("\n");
}

export const FFMPEG = "/opt/homebrew/bin/ffmpeg";

/** Opus from the page to AAC .m4a, mono 48 kbps (~22 MB an hour): small, and QuickTime plays it. */
export async function toM4a(input, output) {
  const args = (codec) => ["-y", "-loglevel", "error", "-i", input, "-vn", "-ac", "1", "-c:a", codec, "-b:a", "48k", output];
  try {
    // Apple's AAC encoder sounds better than ffmpeg's at low bitrates.
    await runCommand(FFMPEG, args("aac_at"));
  } catch {
    await runCommand(FFMPEG, args("aac"));
  }
}

export function registerMeetings(app) {
  /**
   * Save the minutes of the meeting that just ended.
   * The title and invitees come from the calendar invite at that time.
   * Without one, the title comes from Outlook or the model, and attendees are the names said in the meeting.
   */
  app.post("/meeting/save", async (req, res) => {
    const notes = cleanMeetingNotes(req.body?.lines);
    if (!notes) return res.status(400).json({ error: "There are no meeting words to save." });
    const start = new Date(Number(req.body?.startedAt) || Date.now());
    const end = new Date(Number(req.body?.endedAt) || Date.now());
    let minutes = typeof req.body?.minutes === "string" ? req.body.minutes.trim() : "";

    let folder = meetingFolder();
    if (typeof req.body?.folder === "string" && req.body.folder.trim()) {
      folder = path.resolve(req.body.folder.trim());
      if (!fsSync.existsSync(folder) || !fsSync.statSync(folder).isDirectory()) {
        return res.status(400).json({ error: "That folder does not exist." });
      }
      if (!folderIsAllowed(folder)) {
        return res.status(400).json({ error: "Pick a folder inside your home folder." });
      }
    }

    const invite = await calendarInviteAt(start.getTime(), end.getTime());
    const event = invite?.subject ? invite : calendarMeetingAt(start.getTime(), end.getTime());
    const model = getModel(req.body?.model) || getModel(DEFAULT_MODEL);
    const instruction = [
      "You are given the transcript of a meeting, written down one line at a time. Arabic and English may be mixed.",
      event ? "" : "TITLE: write a short title for the meeting, at most eight words, from what was discussed.",
      "ATTENDEES: list the names of people who spoke or were spoken to by name, separated by commas. Do not list people who were only mentioned. Write None if no names were said. Do not invent names.",
      minutes
        ? ""
        : "MINUTES: write the minutes in Markdown with the headings ### Topics, ### Decisions, and ### Action items. Do not invent people, numbers, or decisions.",
      "Answer with only these labels, each at the start of its own line, in this order.",
    ].filter(Boolean).join("\n");
    let parsed = { title: "", attendees: [], minutes: "" };
    try {
      parsed = parseMinutesHeader(await askModelOnce(model, instruction, `Transcript:\n${notes}`, process.env.OPENAI_API_KEY, minutes ? 200 : 1500));
    } catch (err) {
      console.error("Failed while naming the meeting:", err?.message || err);
    }
    minutes ||= parsed.minutes || "The minutes could not be written.";
    const title = (event?.subject || parsed.title || "Meeting").slice(0, 120);
    const titleFrom = event ? "From the calendar" : parsed.title ? "Assigned from the discussion" : "Not known";
    // Invitees from the calendar come first. Otherwise, the names that were said.
    const attendees = invite?.attendees?.length ? invite.attendees : parsed.attendees;
    const text = minutesMarkdown({ title, titleFrom, attendees, start, end, minutes });

    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "meeting";
    const name = `${memoStamp(start)}-${slug}.md`;
    let savedText = text;
    let photoCount = 0;
    try {
      await fs.mkdir(folder, { recursive: true });
      const packed = await withPhotos(text, folder, name.replace(/\.md$/i, ""), req.body?.photos);
      savedText = packed.text;
      photoCount = packed.count;
      await fs.writeFile(path.join(folder, name), savedText, "utf8");
    } catch (err) {
      console.error("Failed while saving the minutes:", err?.message || err);
      return res.status(500).json({ error: "Could not write the minutes file." });
    }
    console.log(`Saved meeting minutes ${name}`);
    res.json({ path: path.join(folder, name), title, attendees, photos: photoCount });
  });

  /**
   * A recap of the meeting so far, with questions worth asking now.
   * Shown on the screen only. It is not spoken and not added to the meeting lines.
   */
  app.post("/meeting/recap", async (req, res) => {
    const notes = cleanMeetingNotes(req.body?.lines);
    if (!notes) return res.status(400).json({ error: "Nothing has been written down yet." });
    const model = getModel(req.body?.model) || getModel(DEFAULT_MODEL);
    const lecture = req.body?.kind === "lecture";
    const instruction = lecture
      ? [
          "You are given a talk that is still going on, written down one line at a time. Arabic and English may be mixed.",
          "Keep each name, number, and phrase in the language that was spoken. Do not translate.",
          "Answer in Markdown with two headings.",
          "### So far: up to six short bullets on what the presenter has said.",
          "### Questions to ask: three to five questions the listener could ask the presenter now, such as unclear claims, missing evidence, or a point that was skipped.",
          "Do not invent people, numbers, or claims that are not in the lines.",
          "Do not write this as meeting minutes.",
        ].join("\n")
      : [
          "You are given a meeting that is still going on, written down one line at a time. Arabic and English may be mixed.",
          "Keep each name, number, and phrase in the language that was spoken. Do not translate.",
          "Answer in Markdown with two headings.",
          "### So far: up to six short bullets on what has been said and decided so far.",
          "### Questions to ask: three to five critical questions the listener should raise now, such as gaps, risks, unclear owners or dates, or claims with no evidence.",
          "Do not invent people, numbers, or decisions that are not in the lines.",
        ].join("\n");
    try {
      const text = await askModelOnce(model, instruction, `Transcript so far:\n${notes}`, process.env.OPENAI_API_KEY, 800);
      if (!text) return res.status(502).json({ error: "The model did not answer." });
      res.json({ text });
    } catch (err) {
      console.error("Failed while writing the meeting recap:", err?.message || err);
      res.status(500).json({ error: "Could not write the recap." });
    }
  });

  /**
   * Suggest a short title for a talk the listener can edit.
   * The title comes only from what was said.
   */
  app.post("/lecture/title", async (req, res) => {
    const notes = cleanMeetingNotes(req.body?.lines);
    if (!notes) return res.status(400).json({ error: "Nothing has been written down yet." });
    const model = getModel(req.body?.model) || getModel(DEFAULT_MODEL);
    const instruction = [
      "Suggest one short title for this talk, at most eight words.",
      "Use only what was said. Do not invent a topic.",
      "Reply with the title only. No quotes, no label, no period at the end.",
    ].join(" ");
    try {
      const title = cleanSuggestedTitle(await askModelOnce(model, instruction, `Transcript:\n${notes}`, process.env.OPENAI_API_KEY, 40));
      if (!title) return res.status(502).json({ error: "No title was suggested." });
      res.json({ title });
    } catch (err) {
      console.error("Failed while suggesting a lecture title:", err?.message || err);
      res.status(500).json({ error: "Could not suggest a title." });
    }
  });

  /**
   * Save the talk that just ended.
   * The title and presenter are the ones the listener typed. They are not taken from the calendar.
   */
  app.post("/lecture/save", async (req, res) => {
    const notes = cleanMeetingNotes(req.body?.lines);
    if (!notes) return res.status(400).json({ error: "There are no lecture words to save." });
    const start = new Date(Number(req.body?.startedAt) || Date.now());
    const end = new Date(Number(req.body?.endedAt) || Date.now());
    const presenter = oneLine(req.body?.presenter, 80);
    const title = oneLine(req.body?.title, 120) || "Lecture";
    let summary = typeof req.body?.minutes === "string" ? req.body.minutes.trim() : "";

    let folder = lectureFolder();
    if (typeof req.body?.folder === "string" && req.body.folder.trim()) {
      folder = path.resolve(req.body.folder.trim());
      if (!fsSync.existsSync(folder) || !fsSync.statSync(folder).isDirectory()) {
        return res.status(400).json({ error: "That folder does not exist." });
      }
      if (!folderIsAllowed(folder)) {
        return res.status(400).json({ error: "Pick a folder inside your home folder." });
      }
    }

    if (!summary) {
      const model = getModel(req.body?.model) || getModel(DEFAULT_MODEL);
      try {
        summary = await askModelOnce(
          model,
          "Write a short summary of this talk in plain sentences. Do not invent facts.",
          `Presenter: ${presenter || "Not given"}\nTitle: ${title}\n\nTranscript:\n${notes}`,
          process.env.OPENAI_API_KEY,
          800,
        );
      } catch (err) {
        console.error("Failed while writing the lecture notes:", err?.message || err);
      }
    }
    summary ||= "The talk summary could not be written.";
    const text = lectureMarkdown({ title, presenter, start, end, summary });
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "lecture";
    const name = `${memoStamp(start)}-${slug}.md`;
    let photoCount = 0;
    try {
      await fs.mkdir(folder, { recursive: true });
      const packed = await withPhotos(text, folder, name.replace(/\.md$/i, ""), req.body?.photos);
      photoCount = packed.count;
      await fs.writeFile(path.join(folder, name), packed.text, "utf8");
    } catch (err) {
      console.error("Failed while saving the lecture:", err?.message || err);
      return res.status(500).json({ error: "Could not write the lecture file." });
    }
    console.log(`Saved lecture notes ${name}`);
    res.json({ path: path.join(folder, name), title, presenter, photos: photoCount });
  });

  /**
   * The audio of a meeting or lecture, saved beside its notes with the same name (.m4a),
   * and linked from the notes. X-Notes-Path is the notes file the page just saved.
   */
  app.post("/recording", express.raw({ type: "*/*", limit: "400mb" }), async (req, res) => {
    let notesPath = "";
    try {
      notesPath = path.resolve(decodeURIComponent(String(req.get("x-notes-path") || "")));
    } catch {
      return res.status(400).json({ error: "The notes path could not be read." });
    }
    if (!/\.md$/i.test(notesPath) || !fsSync.existsSync(notesPath)) {
      return res.status(400).json({ error: "Save the notes first." });
    }
    if (!folderIsAllowed(path.dirname(notesPath))) {
      return res.status(400).json({ error: "Pick a folder inside your home folder." });
    }
    if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: "The recording is empty." });
    const output = notesPath.replace(/\.md$/i, ".m4a");
    const temp = path.join(os.tmpdir(), `brain-recording-${process.pid}-${Date.now()}.webm`);
    try {
      await fs.writeFile(temp, req.body);
      await toM4a(temp, output);
      const name = path.basename(output);
      const notes = await fs.readFile(notesPath, "utf8");
      if (!notes.includes(`(<${name}>)`)) await fs.appendFile(notesPath, `\n## Recording\n\n[${name}](<${name}>)\n`, "utf8");
      const bytes = (await fs.stat(output)).size;
      console.log(`Saved a recording (${(bytes / 1048576).toFixed(1)} MB)`);
      res.json({ path: output, bytes });
    } catch (err) {
      console.error("Failed while saving a recording:", err?.message || err);
      res.status(500).json({ error: "Could not save the recording." });
    } finally {
      fs.rm(temp, { force: true }).catch(() => {});
    }
  });

  /** Ask macOS for a folder. Returns an empty path if the user cancels. */
  app.post("/meeting/folder", async (req, res) => {
    const prompt = req.body?.kind === "lecture"
      ? "Save the lecture notes in:"
      : "Save the meeting minutes in:";
    try {
      const out = await runCommand("osascript", ["-e", `POSIX path of (choose folder with prompt ${JSON.stringify(prompt)})`]);
      res.json({ folder: out.trim() });
    } catch {
      res.json({ folder: "" });
    }
  });
}
