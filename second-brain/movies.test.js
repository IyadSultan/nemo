/**
 * Every movie voice order, and a few sentences that must not be stolen.
 * Run: node --test second-brain/movies.test.js
 */

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const { parseMovieOrder, MOVIE_ORDERS } = createRequire(import.meta.url)("./public/movieparse.cjs");

test("every order in the manual is understood with the panel closed", () => {
  for (const row of MOVIE_ORDERS) {
    const order = parseMovieOrder(row.say, false);
    assert.ok(order, row.say);
    assert.notEqual(order.op, "error", `${row.say} -> ${order.error}`);
  }
});

test("the example phrases pick the right edit", () => {
  assert.equal(parseMovieOrder("Open the movie editor", false).op, "open");
  assert.equal(parseMovieOrder("New movie called trip", false).name, "trip");
  assert.deepEqual(parseMovieOrder("Add the video on the Desktop called birthday", false), {
    op: "add",
    folder: "desktop",
    query: "birthday",
  });
  assert.equal(parseMovieOrder("Cut the first 3 seconds of the movie", false).seconds, 3);
  assert.equal(parseMovieOrder("Cut the last 2 seconds of the movie", false).seconds, 2);
  assert.deepEqual(parseMovieOrder("Keep from 10 seconds to 40 seconds of the movie", false), {
    op: "keep",
    from: 10,
    to: 40,
  });
  assert.deepEqual(parseMovieOrder("Remove from 1 minute to 1 minute 20 seconds of the movie", false), {
    op: "remove",
    from: 60,
    to: 80,
  });
  assert.equal(parseMovieOrder("Split the movie at 15 seconds", false).at, 15);
  assert.equal(parseMovieOrder("Drop clip 2", false).clip, 2);
  assert.equal(parseMovieOrder("Drop the last clip", false).clip, 0);
  assert.equal(parseMovieOrder("Speed the movie up twice", false).rate, 2);
  assert.equal(parseMovieOrder("Slow the movie down to half", false).rate, 0.5);
  assert.equal(parseMovieOrder("Set the movie speed to 1.5", false).rate, 1.5);
  assert.equal(parseMovieOrder("Set the movie volume to 80 percent", false).level, 0.8);
  assert.equal(parseMovieOrder("Set the movie volume to half", false).level, 0.5);
  assert.equal(parseMovieOrder("Fade the movie in", false).seconds, 1);
  assert.equal(parseMovieOrder("Fade the movie in for 2 seconds", false).seconds, 2);
  assert.deepEqual(parseMovieOrder("Add a caption saying hello from 2 seconds to 5 seconds", false), {
    op: "caption",
    text: "hello",
    from: 2,
    to: 5,
  });
  assert.equal(
    parseMovieOrder("Add a caption saying see you from the lab from 1:20 to 1:25", false).text,
    "see you from the lab",
  );
  assert.equal(parseMovieOrder("Make the movie", false).op, "export");
  assert.equal(parseMovieOrder("Start the movie over", false).op, "clear");
});

test("short phrases work only while the editor is open", () => {
  assert.equal(parseMovieOrder("Cut the first 3 seconds", false), null);
  assert.equal(parseMovieOrder("Cut the first 3 seconds", true).op, "cut_start");
  assert.equal(parseMovieOrder("undo", false), null);
  assert.equal(parseMovieOrder("undo", true).op, "undo");
  assert.equal(parseMovieOrder("mute it", true).op, "mute");
  assert.equal(parseMovieOrder("fade in for 2 seconds", true).seconds, 2);
});

test("ordinary questions are not movie orders", () => {
  for (const sentence of [
    "What is the weather today?",
    "How do I edit a movie?",
    "Make a movie about the budget",
    "Cut the first page",
    "Open the photo editor",
  ]) {
    assert.equal(parseMovieOrder(sentence, false), null, sentence);
    assert.equal(parseMovieOrder(sentence, true), null, sentence);
  }
});

test("a typed path keeps its capitals and underscores", () => {
  assert.deepEqual(parseMovieOrder("Add the video ~/Downloads/Rome/IMG_8622 2.MOV", true), {
    op: "add",
    query: "~/Downloads/Rome/IMG_8622 2.MOV",
  });
  assert.deepEqual(parseMovieOrder("Add the photo /Users/me/Pictures/Beach_1.HEIC to the movie.", false), {
    op: "add",
    kind: "photo",
    query: "/Users/me/Pictures/Beach_1.HEIC",
  });
});

test("photos need to the movie from the main chat", () => {
  assert.equal(parseMovieOrder("Add the photo beach", false), null);
  assert.deepEqual(parseMovieOrder("Add the photo beach", true), { op: "add", kind: "photo", query: "beach" });
});

test("a full stop at the end does not stop the order", () => {
  assert.deepEqual(parseMovieOrder("Add the video birthday.", false), { op: "add", query: "birthday" });
  assert.deepEqual(parseMovieOrder("Cut the first 3 seconds of the movie.", false), { op: "cut_start", seconds: 3 });
  assert.deepEqual(parseMovieOrder("Set the movie speed to 1.5.", false), { op: "speed", rate: 1.5 });
});

test("rotation, transitions, music, captions and titles", () => {
  assert.deepEqual(parseMovieOrder("Rotate clip 2 left.", false), { op: "rotate", clip: 2, degrees: -90 });
  assert.deepEqual(parseMovieOrder("Turn the last clip upside down", false), { op: "rotate", clip: 0, degrees: 180 });
  assert.deepEqual(parseMovieOrder("Add crossfades between the clips", false), { op: "transition", kind: "crossfade" });
  assert.deepEqual(parseMovieOrder("Dip to black between clips", false), { op: "transition", kind: "black" });
  assert.deepEqual(parseMovieOrder("Make the transitions 2 seconds", false), { op: "transition", kind: "same", seconds: 2 });
  assert.deepEqual(parseMovieOrder("No transitions", false), { op: "transition", kind: "none" });
  assert.deepEqual(parseMovieOrder("Zoom the photos", false), { op: "photo_zoom", on: true });
  assert.deepEqual(parseMovieOrder("Add the music sunny day", false), { op: "music", query: "sunny day" });
  assert.deepEqual(parseMovieOrder("Set the music volume to 20 percent", false), { op: "music_volume", level: 0.2 });
  assert.deepEqual(parseMovieOrder("Caption the movie.", false), { op: "auto_captions" });
  assert.deepEqual(parseMovieOrder("Add a title card saying Rome in October with the subtitle Family trip.", false), {
    op: "title",
    title: "Rome in October",
    subtitle: "Family trip",
    first: true,
  });
  // "Use a fade" alone is too loose from the main chat.
  assert.equal(parseMovieOrder("Use a fade", false), null);
});

test("frame, clip look, redo, guides and subtitles", () => {
  assert.deepEqual(parseMovieOrder("Make the movie portrait", false), { op: "frame", kind: "portrait" });
  assert.deepEqual(parseMovieOrder("Make the movie classic", false), { op: "frame", kind: "classic" });
  assert.equal(parseMovieOrder("Make the movie", false).op, "export");
  assert.deepEqual(parseMovieOrder("Set the movie background to blue", false), { op: "background", color: "blue" });
  assert.equal(parseMovieOrder("Set the background to blue", false), null);
  assert.deepEqual(parseMovieOrder("Set the background to blue", true), { op: "background", color: "blue" });
  assert.deepEqual(parseMovieOrder("Blur the background", false), { op: "blur_background", on: true });
  assert.deepEqual(parseMovieOrder("Move clip 2 left", false), { op: "nudge", clip: 2, way: "left" });
  assert.deepEqual(parseMovieOrder("Move the last clip to the center", false), { op: "nudge", clip: 0, way: "center" });
  assert.deepEqual(parseMovieOrder("Move clip 2 to the start", false), { op: "move_clip", clip: 2, place: "start" });
  assert.deepEqual(parseMovieOrder("Make clip 2 smaller", false), { op: "scale", clip: 2, how: "smaller" });
  assert.deepEqual(parseMovieOrder("Make clip 2 70 percent size", false), { op: "scale", clip: 2, scale: 0.7 });
  assert.deepEqual(parseMovieOrder("Stretch clip 2 wide", false), { op: "stretch", clip: 2, how: "wide" });
  assert.deepEqual(parseMovieOrder("Make clip 2 half see through", false), { op: "opacity", clip: 2, level: 0.5 });
  assert.deepEqual(parseMovieOrder("Mute clip 2", false), { op: "clip_mute", clip: 2, muted: true });
  assert.deepEqual(parseMovieOrder("Set clip 2 volume to 40 percent", false), { op: "clip_volume", clip: 2, level: 0.4 });
  assert.deepEqual(parseMovieOrder("Speed the movie up twice", false).op, "speed");
  assert.deepEqual(parseMovieOrder("Speed clip 2 up twice", false), { op: "clip_speed", clip: 2, rate: 2 });
  assert.deepEqual(parseMovieOrder("Slow clip 2 to half", false), { op: "clip_speed", clip: 2, rate: 0.5 });
  assert.deepEqual(parseMovieOrder("Hide clip 2", false), { op: "hide", clip: 2, hidden: true });
  assert.deepEqual(parseMovieOrder("Duplicate clip 2", false), { op: "duplicate", clip: 2 });
  assert.deepEqual(parseMovieOrder("Blur clip 2", false), { op: "blur_clip", clip: 2, amount: 8 });
  assert.deepEqual(parseMovieOrder("Unblur the last clip", false), { op: "blur_clip", clip: 0, amount: 0 });
  assert.deepEqual(parseMovieOrder("Put a circle mask on clip 2", false), { op: "mask", clip: 2, kind: "circle" });
  assert.deepEqual(parseMovieOrder("Add cinema bars", false), { op: "bars", on: true });
  assert.deepEqual(parseMovieOrder("Blend clip 2 with multiply", false), { op: "blend", clip: 2, kind: "multiply" });
  assert.deepEqual(parseMovieOrder("Zoom the photos", false).op, "photo_zoom");
  assert.deepEqual(parseMovieOrder("Zoom clip 2", false), { op: "zoom_clip", clip: 2, on: true });
  assert.deepEqual(parseMovieOrder("Stop zooming clip 2", false), { op: "zoom_clip", clip: 2, on: false });
  assert.deepEqual(parseMovieOrder("Make the captions yellow", false), { op: "caption_style", color: "yellow", size: "" });
  assert.deepEqual(parseMovieOrder("Add the subtitles birthday", false), { op: "subtitles", query: "birthday" });
  assert.deepEqual(parseMovieOrder("Reset the look of clip 2", false), { op: "reset_look", clip: 2 });
  assert.deepEqual(parseMovieOrder("Show the grid", false), { op: "guide", kind: "grid" });
  assert.deepEqual(parseMovieOrder("Bookmark at 10 seconds", false), { op: "bookmark", at: 10 });
  assert.equal(parseMovieOrder("Bookmark here", false), null);
  assert.deepEqual(parseMovieOrder("Bookmark here", true), { op: "bookmark_here" });
  assert.equal(parseMovieOrder("Step forward one frame", false), null);
  assert.deepEqual(parseMovieOrder("Step forward one frame", true), { op: "step", frames: 1 });
  assert.deepEqual(parseMovieOrder("Redo the movie", false), { op: "redo" });
  assert.equal(parseMovieOrder("Redo", false), null);
  assert.deepEqual(parseMovieOrder("Redo", true), { op: "redo" });
});

test("music can be written for the movie", () => {
  assert.deepEqual(parseMovieOrder("Make calm piano music for the movie.", false), { op: "make_music", mood: "calm piano", engine: "auto" });
  assert.deepEqual(parseMovieOrder("Make music for the movie offline", false), { op: "make_music", mood: "", engine: "local" });
  assert.deepEqual(parseMovieOrder("Make music like a seaside holiday", true), { op: "make_music", mood: "a seaside holiday", engine: "auto" });
  assert.equal(parseMovieOrder("Make music", false), null);
});

test("clips can be moved before, after, earlier and later", () => {
  assert.deepEqual(parseMovieOrder("Move clip 7 before clip 3", true), { op: "move_clip", clip: 7, place: "before", target: 3 });
  assert.deepEqual(parseMovieOrder("Move clip 7 after clip 3", true), { op: "move_clip", clip: 7, place: "after", target: 3 });
  assert.deepEqual(parseMovieOrder("Move the last clip earlier", true), { op: "move_clip", clip: 0, place: "earlier" });
  assert.deepEqual(parseMovieOrder("Move clip 2 to the beginning", true), { op: "move_clip", clip: 2, place: "start" });
});
