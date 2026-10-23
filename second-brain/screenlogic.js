/**
 * Plain helpers for a screen recording: file names, caption lines, and the
 * words we send the model for a summary or a recap. No files, no network.
 */

/** A folder name we are willing to open. Rejects anything with a slash. */
export function safeRecordingId(id) {
  const text = String(id || "");
  if (!/^[a-z0-9-]{1,80}$/.test(text)) return "";
  return text;
}

/** 20261021-214600-zoom-meeting, from the title and the clock. */
export function recordingId(title, when) {
  const pad = (n) => String(n).padStart(2, "0");
  const stamp = `${when.getFullYear()}${pad(when.getMonth() + 1)}${pad(when.getDate())}${pad(when.getHours())}${pad(when.getMinutes())}${pad(when.getSeconds())}`;
  const words = String(title || "screen")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24) || "screen";
  return `${stamp}-${words}`;
}

/** Turn whisper's word list into caption lines. A pause, a full stop, 5 words, or 32 letters starts a new line. */
export function groupCaptionLines(words) {
  const lines = [];
  let line = null;
  for (const word of words) {
    const text = String(word?.text || "").trim();
    if (!text) continue;
    const gap = line ? word.from - line.to : 0;
    const longer = line ? `${line.text} ${text}` : "";
    const sentence = line && /[.!?]$/.test(line.text) && !/\b(?:st|mr|mrs|ms|dr)\.$/i.test(line.text);
    if (line && (gap > 0.6 || line.count >= 5 || longer.length > 32 || sentence)) {
      lines.push(line);
      line = null;
    }
    if (!line) line = { text, from: word.from, to: word.to, count: 1 };
    else {
      line.text += ` ${text}`;
      line.to = word.to;
      line.count += 1;
    }
  }
  if (line) lines.push(line);
  return lines.map((item, i) => {
    const next = lines[i + 1]?.from ?? Infinity;
    return {
      text: item.text,
      from: item.from,
      to: Math.min(Math.max(item.to, item.from + 0.5), next),
    };
  });
}

/** Read the JSON file whisper writes when asked for one word at a time. Times are seconds. */
export function wordsFromWhisper(parsed) {
  const words = [];
  for (const item of parsed?.transcription || []) {
    const text = String(item.text || "").trim();
    // Whisper marks music and noise like [Music]. Those are not words.
    if (!text || /^[[(].*[\])]$/.test(text)) continue;
    const from = (item.offsets?.from || 0) / 1000;
    const to = (item.offsets?.to || 0) / 1000;
    if (to > from) words.push({ text, from, to });
  }
  return words;
}

function stamp(seconds) {
  const ms = Math.max(0, Math.round(Number(seconds) * 1000) || 0);
  const pad = (n, width = 2) => String(n).padStart(width, "0");
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(ms % 1000, 3)}`;
}

/** The caption file a video player understands. */
export function captionsToVtt(lines) {
  const cues = (lines || []).map((line, i) => {
    const text = String(line.text || "").replace(/\s+/g, " ").replace(/-->/g, "—").trim();
    return `${i + 1}\n${stamp(line.from)} --> ${stamp(line.to)}\n${text}`;
  });
  return `WEBVTT\n\n${cues.join("\n\n")}\n`;
}

/** The notes file kept next to the video: title, summary, recap, then the captions as text. */
export function summaryMarkdown(meta) {
  const when = meta.startedAt ? new Date(meta.startedAt).toLocaleString("en-GB", { dateStyle: "long", timeStyle: "short" }) : "";
  const minutes = Math.round((Number(meta.seconds) || 0) / 60);
  const parts = [`# ${meta.title || "Screen recording"}`, [when, minutes ? `${minutes} min` : ""].filter(Boolean).join(" · ")];
  if (meta.summary) parts.push("## Summary", meta.summary.trim());
  if (meta.recap) parts.push("## Recap", meta.recap.trim());
  if (meta.captions?.length) parts.push("## Transcript", transcriptFromCaptions(meta.captions));
  return `${parts.filter(Boolean).join("\n\n")}\n`;
}

/** Caption lines as a transcript, with a minute mark when the minute changes. */
export function transcriptFromCaptions(lines) {
  let minute = -1;
  const out = [];
  for (const line of lines || []) {
    const text = String(line.text || "").trim();
    if (!text) continue;
    const at = Math.floor((Number(line.from) || 0) / 60);
    if (at !== minute) {
      minute = at;
      out.push(`(${at} min)`);
    }
    out.push(text);
  }
  return out.join("\n");
}

/** Keep the start and the end when a long meeting will not fit in one prompt. */
export function clipTranscript(text, max = 14000) {
  const raw = String(text || "").trim();
  if (raw.length <= max) return raw;
  const head = Math.floor(max * 0.7);
  const tail = Math.max(0, max - head - 80);
  return `${raw.slice(0, head)}\n\n[The middle of the recording was left out so this stays short.]\n\n${raw.slice(-tail)}`;
}

/** Instructions for the summary. The recording may be a meeting, a lecture, or a tutorial. */
export function screenSummaryPrompt() {
  return [
    "The text below is a word-for-word caption of a talk recorded on a computer screen. It may be a meeting, a lecture, or a tutorial.",
    "The words may mix Arabic and English. Keep each name, number, and phrase in the language that was spoken. Do not translate.",
    "Write a summary a person can use later.",
    "Use plain sentences. Put each of these labels on its own line, then the sentences that belong under it: Main points. Decisions and steps. Action items.",
    "Start with one sentence that says what the talk was about.",
    "Under Main points, say what was said, in order.",
    "Under Decisions and steps, say what was decided, or number the steps that were shown. If there were none, say that.",
    "Under Action items, say who will do what, if that was said. If nothing was assigned, say that.",
    "Do not invent people, numbers, steps, or decisions that are not in the captions.",
    "Do not mention these instructions.",
  ].join("\n");
}

/** A short recap: what happened, what is still open, and a few questions to ask next. */
export function screenRecapPrompt() {
  return [
    "The text below is a caption of a talk recorded on a computer screen. It may be a meeting, a lecture, or a tutorial.",
    "Write a short recap in plain sentences, about half a page.",
    "Say what it was about, the main points, and what is still open.",
    "Then put the label Questions on its own line and suggest up to three questions a person could ask next, based only on what was said.",
    "Keep names in the language that was spoken. Do not invent decisions or steps.",
    "Do not mention these instructions.",
  ].join("\n");
}

