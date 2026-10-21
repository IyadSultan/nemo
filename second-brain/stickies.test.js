/**
 * Sticky notes: saving, sorting, archive, tasks, and the voice commands.
 * Run: node --test second-brain/stickies.test.js
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { wantsBuild } from "./build.js";
import { learningJob } from "./learnings.js";
import {
  applyClassification,
  chatMemorySticky,
  migrate,
  parseSticky,
  resetForTests,
  runStickyCommand,
  runTool,
  sanitizeHtml,
  setNowForTests,
  sortNotes,
  tagKey,
  viewForTests,
} from "./stickies.js";

const file = path.join(os.tmpdir(), `stickies-test-${process.pid}.json`);
const now = new Date("2026-10-20T12:00:00+03:00");

function setup() {
  resetForTests(file);
  setNowForTests(() => new Date(now));
  const prefs = viewForTests().prefs;
  prefs.slightRotation = false;
  prefs.defaultColorMode = "last";
}

test.beforeEach(setup);
test.after(() => fs.rmSync(file, { force: true }));

test("creates, edits, trashes, and restores a note without losing its place", () => {
  const made = runTool("sticky_note_create", { content: "Buy milk", color: "pink", x: 120, y: 80 });
  assert.equal(made.ok, true);
  assert.equal(made.note.color, "pink");
  assert.equal(made.note.positionX, 120);
  const id = made.note.id;
  const edited = runTool("sticky_note_update", { id, content: "Buy oat milk", baseVersion: 1 });
  assert.equal(edited.note.contentVersion, 2);
  const removed = runTool("sticky_note_delete", { id, confirm: true });
  assert.equal(removed.status, "deleted");
  assert.equal(viewForTests().notes.length, 0);
  const back = runTool("sticky_note_restore", { id });
  assert.equal(back.note.positionX, 120);
  assert.equal(back.note.positionY, 80);
  assert.equal(back.note.deletedAt, null);
});

test("asks before a delete, and does not pick when two notes match", async () => {
  runTool("sticky_note_create", { content: "Canceled meeting on Monday", title: "Canceled meeting" });
  runTool("sticky_note_create", { content: "Team meeting notes", title: "Team meeting" });
  const first = await runStickyCommand("Delete the sticky note about the meeting");
  assert.equal(first.result.status, "choose");
  assert.equal(viewForTests().notes.length, 2);
  const picked = await runStickyCommand("number 1");
  assert.equal(picked.result.status, "confirm");
  assert.equal(viewForTests().notes.length, 2);
  const done = await runStickyCommand("yes");
  assert.equal(done.result.status, "deleted");
  assert.equal(viewForTests().notes.length, 1);
});

test("alphabetical sort uses the stored title and keeps freeform positions", () => {
  const a = runTool("sticky_note_create", { content: "zzz", title: "Zebra", x: 10, y: 10 }).note;
  const b = runTool("sticky_note_create", { content: "aaa", title: "أسد", x: 40, y: 90 }).note;
  const c = runTool("sticky_note_create", { content: "mmm", title: "apple", x: 70, y: 40 }).note;
  const sorted = runTool("sticky_note_sort", { sort: "title-asc", layout: "organized" });
  const titles = sorted.notes.map((note) => note.title);
  const collator = new Intl.Collator(["ar", "en"], { sensitivity: "base", numeric: true });
  assert.deepEqual(titles, ["Zebra", "أسد", "apple"].sort((left, right) => collator.compare(left, right)));
  const again = viewForTests().notes;
  for (const note of [a, b, c]) {
    const found = again.find((item) => item.id === note.id);
    assert.equal(found.positionX, note.positionX);
    assert.equal(found.positionY, note.positionY);
  }
  assert.equal(viewForTests().board.layout, "organized");
  runTool("sticky_note_sort", { layout: "freeform", sort: "manual" });
  assert.equal(viewForTests().board.layout, "freeform");
});

test("groups a note under every hashtag without copying the record", () => {
  runTool("sticky_note_create", { content: "One", hashtags: ["Work", "Urgent"] });
  const view = runTool("sticky_note_sort", { group: "hashtag", layout: "organized" });
  assert.equal(viewForTests().notes.length, 1);
  const keys = view.groups.map((group) => group.key).sort();
  assert.deepEqual(keys, ["urgent", "work"]);
  const ids = view.groups.flatMap((group) => group.noteIds);
  assert.equal(new Set(ids).size, 1);
});

test("converts a note into a task and back without a new id or lost words", () => {
  const made = runTool("sticky_note_create", { content: "Conference slides", title: "Conference", color: "blue" }).note;
  const task = runTool("sticky_note_convert_to_task", { id: made.id, priority: "high" });
  assert.equal(task.note.id, made.id);
  assert.equal(task.note.noteType, "task");
  assert.equal(task.note.priority, "high");
  assert.equal(task.note.content, "Conference slides");
  const back = runTool("sticky_note_convert_to_note", { id: made.id });
  assert.equal(back.note.id, made.id);
  assert.equal(back.note.noteType, "note");
  assert.equal(back.note.content, "Conference slides");
  assert.equal(back.note.priority, "high");
});

test("a locked title survives a newer label, and an old reply is dropped", () => {
  const note = runTool("sticky_note_create", { content: "Need to meet the development team next week to review the mobile application.", title: "My title" }).note;
  note.titleLocked = true;
  note.contentVersion = 3;
  const kept = applyClassification(note, '{"title":"Mobile Application Review Meeting","hashtags":["Mobile App"],"priority":"high","isTask":true}', 3);
  assert.equal(kept.applied, true);
  assert.equal(note.title, "My title");
  assert.equal(note.priority, "high");
  assert.equal(note.isTask, true);
  assert.equal(tagKey(note.hashtags[0].display), "mobileapp");
  const stale = applyClassification(note, '{"title":"Old","hashtags":["Old"],"priority":"low","isTask":false}', 2);
  assert.equal(stale.applied, false);
  assert.equal(note.title, "My title");
  assert.equal(note.priority, "high");
});

test("reuses a hashtag the board already has", () => {
  runTool("sticky_note_create", { content: "Old", hashtags: ["MobileApp"] });
  const note = runTool("sticky_note_create", { content: "New" }).note;
  note.contentVersion = 1;
  applyClassification(note, '{"title":"App","hashtags":["mobile app"],"priority":"low","isTask":false}', 1);
  assert.equal(note.hashtags[0].display, "MobileApp");
});

test("the note stays when labeling fails", async () => {
  const made = await runStickyCommand("Create a yellow sticky note reminding me to review the research proposal tomorrow.", {
    ask: async () => {
      throw new Error("model down");
    },
    wait: true,
  });
  assert.equal(made.result.status, "created");
  assert.equal(made.result.note.color, "yellow");
  assert.match(made.result.note.content, /research proposal/);
  const due = new Date(made.result.note.dueAt);
  assert.equal(due.getDate(), 21);
  assert.equal(viewForTests().notes.length, 1);
  assert.equal(viewForTests().notes[0].title, "");
});

test("labels arrive after the note is saved, and a lock is kept", async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const pending = runStickyCommand("Create a yellow sticky note reminding me to review the research proposal tomorrow.", {
    ask: () => gate,
    wait: false,
  });
  const made = await pending;
  assert.equal(made.result.note.title, "");
  release('{"title":"Research Proposal Review","hashtags":["Research","Proposal"],"priority":"medium","isTask":true}');
  await new Promise((resolve) => setTimeout(resolve, 30));
  const labeled = viewForTests().notes[0];
  assert.equal(labeled.title, "Research Proposal Review");
  runTool("sticky_note_update", { id: labeled.id, title: "Keep this", titleLocked: true });
  const note = viewForTests().notes[0];
  note.contentVersion = labeled.contentVersion;
  applyClassification(note, '{"title":"Other","hashtags":["Other"],"priority":"low","isTask":false}', note.contentVersion);
  assert.equal(note.title, "Keep this");
});

test("voice commands for color, tasks, links, and archive", async () => {
  await runStickyCommand("Create a yellow sticky note reminding me to review the research proposal tomorrow.");
  const pink = await runStickyCommand("Show all my pink sticky notes.");
  assert.equal(pink.result.notes.length, 0);
  const listed = await runStickyCommand("Show all my yellow sticky notes.");
  assert.equal(listed.result.notes.length, 1);

  runTool("sticky_note_create", { content: "The mobile app needs a review", title: "Mobile app" });
  const added = await runStickyCommand("Find my note about the mobile app and add that the deadline is Friday.");
  assert.equal(added.result.status, "updated");
  assert.match(added.result.note.content, /deadline is Friday/);
  assert.equal(new Date(added.result.note.dueAt).getDay(), 5);

  const task = await runStickyCommand("Convert the note about the conference presentation into a high-priority task.");
  assert.equal(task.result.status, "not_found");
  runTool("sticky_note_create", { content: "Conference presentation outline", title: "Conference presentation" });
  const converted = await runStickyCommand("Convert the note about the conference presentation into a high-priority task.");
  assert.equal(converted.result.note.noteType, "task");
  assert.equal(converted.result.note.priority, "high");

  const important = await runStickyCommand("Find my most important unfinished tasks.");
  assert.equal(important.result.notes.length, 1);

  const tags = await runStickyCommand("Generate hashtags for all notes that do not have them.");
  assert.ok(tags.result.classifyIds.length >= 1);

  runTool("sticky_note_update", {
    id: converted.result.note.id,
    taskStatus: "done",
    completedAt: "2026-09-15T10:00:00.000Z",
  });
  const archived = await runStickyCommand("Archive all completed notes from last month.");
  assert.equal(archived.result.status, "confirm");
  const yes = await runStickyCommand("yes");
  assert.equal(yes.result.status, "archived");
  assert.ok(yes.result.note.archivedAt);
  const restored = runTool("sticky_note_restore", { id: yes.result.note.id });
  assert.equal(restored.note.archivedAt, null);
  assert.equal(restored.note.positionX, yes.result.note.positionX);
});

test("links use a stable id, and a hyperlink is kept", () => {
  const left = runTool("sticky_note_create", { content: "Left" }).note;
  const right = runTool("sticky_note_create", { content: "Right" }).note;
  const linked = runTool("sticky_note_link", { fromId: left.id, toId: right.id, kind: "note" });
  assert.equal(linked.note.links[0].toId, right.id);
  assert.equal(linked.note.links[0].href, `note:${right.id}`);
  const html = runTool("sticky_note_update", {
    id: left.id,
    content: 'See <a href="https://example.com">the site</a><script>alert(1)</script>',
  });
  assert.match(html.note.content, /https:\/\/example\.com/);
  assert.doesNotMatch(html.note.content, /script/);
});

test("an older file with no version still opens", () => {
  const raw = migrate({ notes: [{ id: "n1", content: "Hi", title: "Hi" }] });
  assert.equal(raw.version, 1);
  assert.equal(raw.notes[0].content, "Hi");
  assert.equal(raw.boards[0].background, "wood");
});

test("filters combine, and manual order is a choice", () => {
  runTool("sticky_note_create", { content: "A", color: "pink", priority: "low" });
  runTool("sticky_note_create", { content: "B", color: "blue", priority: "high" });
  const both = runTool("sticky_note_list", { color: "blue", priority: "high" });
  assert.equal(both.notes.length, 1);
  const ordered = sortNotes(viewForTests().notes, "manual");
  assert.deepEqual(ordered.map((note) => note.positionY), [...ordered.map((note) => note.positionY)].sort((a, b) => a - b));
});

test("a sentence that is not about stickies is left alone", () => {
  assert.equal(parseSticky("What meetings do I have today?"), null);
  assert.equal(parseSticky("Write a memo that Sara owes the slides"), null);
});

test("save or add a sticky is an ordinary note, and a memory uses the Claude mark", () => {
  const saved = parseSticky("Save a sticky that the lab closes at 4");
  assert.equal(saved.tool, "sticky_note_create");
  assert.equal(saved.args.content, "the lab closes at 4");
  assert.equal(saved.args.mark, undefined);
  const added = parseSticky("Add a sticky call the clinic");
  assert.equal(added.tool, "sticky_note_create");
  assert.match(added.args.content, /call the clinic/);

  const remember = chatMemorySticky("Remember: do not be lazy");
  assert.equal(remember.mark, "claude");
  assert.match(remember.content, /do not be lazy/i);
  const rule = chatMemorySticky("From now on, keep answers short");
  assert.equal(rule.mark, "claude");
  assert.match(rule.content, /keep answers short/i);
  const memory = chatMemorySticky("Save a memory that I like tea");
  assert.equal(memory.mark, "claude");
  assert.match(memory.content, /like tea/i);
  assert.equal(chatMemorySticky("Save a sticky that the lab closes at 4"), null);
  assert.equal(chatMemorySticky("Write a memo that Sara owes the slides"), null);

  const job = learningJob("Save a memory that I like tea");
  assert.equal(job.kind, "add");
  assert.match(job.text, /like tea/i);
  assert.equal(learningJob("From now on, keep answers short").kind, "add");
  assert.equal(learningJob("Remember: do not be lazy").kind, "add");

  const marked = runTool("sticky_note_create", { content: "Do not be lazy", mark: "claude" });
  assert.equal(marked.note.mark, "claude");
  const plain = runTool("sticky_note_create", { content: "Buy milk" });
  assert.equal(plain.note.mark, "");
});

test("arrange by due keeps only notes that have a due time or a reminder", () => {
  const later = runTool("sticky_note_create", { content: "Later task", dueAt: "2026-10-25T09:00:00.000Z" }).note;
  const sooner = runTool("sticky_note_create", { content: "Soon reminder" }).note;
  runTool("sticky_note_set_reminder", { id: sooner.id, reminderAt: "2026-10-21T09:00:00.000Z" });
  runTool("sticky_note_create", { content: "Plain note with no time" });
  const listed = runTool("sticky_note_list", { due: "scheduled", sort: "due" });
  assert.deepEqual(listed.notes.map((note) => note.id), [sooner.id, later.id]);
  const arranged = parseSticky("arrange due");
  assert.equal(arranged.tool, "sticky_note_sort");
  assert.equal(arranged.args.sort, "due");
  assert.equal(arranged.args.layout, "organized");
  assert.equal(parseSticky("arrange by due date").args.sort, "due");
  assert.equal(parseSticky("sort the notes by due").args.sort, "due");
  const spoken = runTool("sticky_note_sort", { sort: "due", layout: "organized" });
  assert.equal(spoken.ui.sort, "due");
  assert.match(spoken.notes.map((note) => note.id).join(","), new RegExp(`^${sooner.id},${later.id}`));
});

test("a note about code is still a sticky, not a request to write code", () => {
  const sticky = parseSticky("save a sticky: we need to optimize our code");
  assert.equal(sticky.tool, "sticky_note_create");
  assert.match(sticky.args.content, /optimize our code/);
  const memory = learningJob("save a memory, we need to optimize our code");
  assert.equal(memory.kind, "add");
  assert.match(memory.text, /optimize our code/);
  assert.equal(chatMemorySticky("save a memory, we need to optimize our code").mark, "claude");
  assert.equal(wantsBuild("save a sticky: we need to optimize our code"), false);
  assert.equal(wantsBuild("save a memory, we need to optimize our code"), false);
  assert.equal(wantsBuild("add a sticky, we need to optimize our code"), false);
  assert.equal(wantsBuild("from now on, we need to optimize our code"), false);
  assert.equal(wantsBuild("remember that we need to optimize our code"), false);
  assert.equal(wantsBuild("write a script to optimize our code"), true);
});

test("a half tag cannot join appended text into a live tag", () => {
  const made = runTool("sticky_note_create", { content: "Hi <img src=x onerror=alert(1) " }).note;
  assert.doesNotMatch(made.content, /<img/);
  const added = runTool("sticky_note_update", { id: made.id, append: '" onmouseover="alert(2)">' });
  assert.doesNotMatch(added.note.content, /<img|<a /);
  const cut = sanitizeHtml(`${"x".repeat(19990)}<a href="https://example.com/a-long-path">link</a>`);
  assert.doesNotMatch(cut, /<a href="[^"]*$/);
  assert.equal(sanitizeHtml("<b>1 < 2</b>"), "<b>1 &lt; 2</b>");
});

test("a number inside another sentence does not answer which note", async () => {
  runTool("sticky_note_create", { content: "Canceled meeting on Monday", title: "Canceled meeting" });
  runTool("sticky_note_create", { content: "Team meeting notes", title: "Team meeting" });
  assert.equal((await runStickyCommand("Delete the sticky note about the meeting")).result.status, "choose");
  assert.equal(await runStickyCommand("What do I have at 3 pm"), null);
  assert.equal((await runStickyCommand("number two")).result.status, "confirm");
});

test("an old question is not answered by a later yes", async () => {
  runTool("sticky_note_create", { content: "Dentist on Monday", title: "Dentist" });
  assert.equal((await runStickyCommand("Delete the sticky note about the dentist")).result.status, "confirm");
  setNowForTests(() => new Date(now.getTime() + 10 * 60000));
  assert.equal(await runStickyCommand("yes"), null);
  assert.equal(viewForTests().notes.length, 1);
});

test("a new note asks the model once", async () => {
  let calls = 0;
  await runStickyCommand("Create a sticky note about the budget", { ask: async () => { calls += 1; return '{"title":"Budget"}'; } });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(calls, 1);
  assert.equal(viewForTests().notes[0].title, "Budget");
});

test("a link needs a real note or a safe address", () => {
  const left = runTool("sticky_note_create", { content: "Left" }).note;
  assert.equal(runTool("sticky_note_link", { fromId: left.id, toId: "missing" }).status, "not_found");
  assert.equal(runTool("sticky_note_link", { fromId: left.id, href: "javascript:alert(1)" }).error, "bad_link");
  assert.equal(runTool("sticky_note_link", { fromId: left.id, href: "https://example.com" }).status, "linked");
});
