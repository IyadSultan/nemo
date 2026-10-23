/**
 * Screen recorder helpers: spoken orders, caption lines, and the summary prompt.
 * Run: node --test second-brain/screen.test.js
 */

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import {
  captionsToVtt,
  clipTranscript,
  groupCaptionLines,
  recordingId,
  safeRecordingId,
  screenRecapPrompt,
  screenSummaryPrompt,
  summaryMarkdown,
  transcriptFromCaptions,
  wordsFromWhisper,
} from "./screenlogic.js";

const { parseScreenCommand } = createRequire(import.meta.url)("./public/screenparse.cjs");

test("spoken orders start, stop, and do not steal the meeting button", () => {
  assert.equal(parseScreenCommand("record the screen").op, "start");
  assert.deepEqual(parseScreenCommand("record a tutorial called how to export"), { op: "start", title: "how to export" });
  assert.equal(parseScreenCommand("record this zoom meeting").op, "start");
  assert.equal(parseScreenCommand("stop the recording").op, "stop");
  assert.equal(parseScreenCommand("open the screen recorder").op, "open");
  assert.equal(parseScreenCommand("add captions to the recording").op, "captions");
  assert.equal(parseScreenCommand("write the summary of the recording").op, "summary");
  assert.equal(parseScreenCommand("write the recap of the recording").op, "recap");
  // "Write the minutes" belongs to the Meeting button, not the screen recorder.
  assert.equal(parseScreenCommand("write the minutes"), null);
  assert.equal(parseScreenCommand("what did we decide in the meeting"), null);
  assert.equal(parseScreenCommand("stop"), null);
});

test("folder names stay inside the recordings folder", () => {
  const id = recordingId("Zoom meeting", new Date(2026, 9, 21, 21, 46, 3));
  assert.equal(id, "20261021214603-zoom-meeting");
  assert.equal(safeRecordingId(id), id);
  assert.equal(safeRecordingId("../secret"), "");
  assert.equal(safeRecordingId("has space"), "");
});

test("whisper words become short caption lines and a transcript", () => {
  const words = wordsFromWhisper({
    transcription: [
      { text: " Hello", offsets: { from: 0, to: 400 } },
      { text: " team", offsets: { from: 400, to: 800 } },
      { text: "[Music]", offsets: { from: 800, to: 1200 } },
      { text: " Done.", offsets: { from: 2000, to: 2400 } },
    ],
  });
  assert.equal(words.length, 3);
  const lines = groupCaptionLines(words);
  assert.equal(lines[0].text, "Hello team");
  assert.equal(lines[1].text, "Done.");
  assert.match(captionsToVtt(lines), /^WEBVTT\n\n1\n00:00:00\.000 --> /);
  const md = summaryMarkdown({ title: "Budget", startedAt: "2026-10-22T07:00:00Z", seconds: 130, summary: "Short.", recap: "", captions: lines });
  assert.match(md, /^# Budget\n\n.*2 min\n\n## Summary\n\nShort\.\n\n## Transcript\n\n\(0 min\)/);
  assert.ok(!md.includes("## Recap"));
  assert.match(transcriptFromCaptions(lines), /\(0 min\)\nHello team/);
});

test("a long transcript keeps the start and the end", () => {
  const text = `${"a".repeat(10000)}END-MARK`;
  const clipped = clipTranscript(text, 1000);
  assert.ok(clipped.length < text.length);
  assert.match(clipped, /middle of the recording was left out/);
  assert.match(clipped, /END-MARK/);
});

test("the summary asks for decisions and steps, the recap asks for questions", () => {
  assert.match(screenSummaryPrompt(), /Decisions and steps/);
  assert.match(screenSummaryPrompt(), /Action items/);
  assert.match(screenRecapPrompt(), /Questions/);
});

