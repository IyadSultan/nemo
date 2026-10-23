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
  boardForExport,
  chatMemorySticky,
  cleanInk,
  migrate,
  parseSticky,
  registerStickies,
  resetForTests,
  runBrainstorm,
  runStickyCommand,
  runTool,
  sanitizeHtml,
  setHooksForTests,
  setNowForTests,
  sortNotes,
  tagKey,
  viewForTests,
} from "./stickies.js";
import { boardHtml, boardMarkdown, htmlToMarkdown, snapshotPage } from "./stickyexport.js";
import { articleText, importableUrl } from "./stickyimport.js";

const file = path.join(os.tmpdir(), `stickies-test-${process.pid}.json`);

// The board route, called the way the page calls it, without a listening server.
async function fetchLike(url, body) {
  const express = (await import("express")).default;
  const app = express();
  app.use(express.json());
  registerStickies(app, {});
  const server = app.listen(0);
  try {
    const port = server.address().port;
    const response = await fetch(`http://127.0.0.1:${port}${url}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return response.json();
  } finally {
    server.close();
  }
}
const now = new Date("2026-10-20T12:00:00+03:00");

function setup() {
  resetForTests(file);
  setNowForTests(() => new Date(now));
  const look = viewForTests().board.look;
  look.slightRotation = false;
  look.defaultColorMode = "last";
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

test("each board keeps its own notes and its own look", () => {
  runTool("sticky_note_create", { content: "Home note" });
  const made = runTool("sticky_board_create", { name: "Work" });
  assert.equal(made.status, "board_created");
  assert.equal(viewForTests().board.name, "Work");
  assert.equal(viewForTests().notes.length, 0);
  runTool("sticky_note_create", { content: "Work note" });
  viewForTests().board.look.corners = "square";
  viewForTests().board.colorMeanings.blue = "Grants";
  assert.equal(runTool("sticky_board_switch", { board: "board" }).status, "board_switched");
  const home = viewForTests();
  assert.deepEqual(home.notes.map((note) => note.content), ["Home note"]);
  assert.equal(home.prefs.corners, "round");
  assert.equal(home.colorMeanings.blue, "Work");
  assert.equal(home.boards.length, 2);
  assert.equal(runTool("sticky_board_create", { name: "work" }).ok, false);
});

test("deleting a board sends its notes to the trash, and restore puts them on the first board", () => {
  runTool("sticky_board_create", { name: "Trip" });
  const note = runTool("sticky_note_create", { content: "Pack bags" }).note;
  const trip = viewForTests().board.id;
  assert.equal(runTool("sticky_board_delete", { boardId: trip }).status, "confirm");
  assert.equal(viewForTests().boards.length, 2);
  const gone = runTool("sticky_board_delete", { boardId: trip, confirm: true });
  assert.equal(gone.status, "board_deleted");
  assert.equal(viewForTests().boards.length, 1);
  assert.equal(viewForTests().trash.length, 1);
  const back = runTool("sticky_note_restore", { id: note.id });
  assert.equal(back.note.boardId, "board-main");
  assert.equal(runTool("sticky_board_delete", { boardId: "board-main", confirm: true }).ok, false);
});

test("voice makes, switches, and moves notes between boards; search looks on every board", async () => {
  assert.equal((await runStickyCommand("New sticky board called Research")).result.status, "board_created");
  await runStickyCommand("Create a sticky note about the grant budget");
  const moved = await runStickyCommand("Put that on the board board");
  assert.equal(moved.result.status, "moved");
  assert.equal(viewForTests().notes.length, 0);
  const found = await runStickyCommand("Show me all sticky notes related to grant");
  assert.equal(found.result.notes.length, 1);
  assert.match(found.text, /1 is on another board/);
  assert.equal((await runStickyCommand("Switch to the board board")).result.status, "board_switched");
  assert.equal(viewForTests().notes.length, 1);
  const missing = await runStickyCommand("Switch to the garden board");
  assert.match(missing.text, /Your boards are Board, Research/);
});

test("an old file gives every board the shared look it had", () => {
  const old = migrate({
    prefs: { appearance: "dark", corners: "square", trashDays: 7 },
    colorMeanings: { blue: "Clinic" },
    boards: [{ id: "board-main", name: "Board" }],
    notes: [{ id: "n1", content: "x" }],
  });
  assert.equal(old.prefs.appearance, "dark");
  assert.equal(old.prefs.corners, undefined);
  assert.equal(old.boards[0].look.corners, "square");
  assert.equal(old.boards[0].colorMeanings.blue, "Clinic");
  assert.equal(old.colorMeanings, undefined);
  assert.equal(old.currentBoardId, "board-main");
  assert.equal(old.notes[0].boardId, "board-main");
});

const IDEAS = JSON.stringify({ add: [
  { title: "Venue", content: "Book a venue for 200 people", color: "blue" },
  { title: "Speakers", content: "Invite three keynote speakers", color: "green" },
  { title: "Budget", content: "Draft the budget", color: "pink" },
  { title: "Dates", content: "Pick two possible dates", color: "yellow" },
  { title: "Catering", content: "Get catering quotes", color: "orange" },
] });

test("brainstorm about a topic opens a board with the topic and five ideas to tick", async () => {
  let asked = "";
  const said = await runStickyCommand("Let's brainstorm about arranging a conference", { ask: async (instruction) => {
    if (instruction.includes("Label")) return "{}";
    asked = instruction;
    return IDEAS;
  } });
  assert.equal(said.result.status, "brainstorm_started");
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.match(asked, /Give 5 ideas/);
  assert.match(asked, /Topic: arranging a conference/);
  const view = viewForTests();
  assert.equal(view.board.name, "Arranging a conference");
  assert.equal(view.board.brainstorm.on, true);
  const ideas = view.notes.filter((note) => note.idea);
  assert.equal(ideas.length, 5);
  assert.equal(viewForTests({ q: "venue" }).notes.length, 0, "an idea is not searched until it is kept");
  assert.equal(runTool("sticky_idea_accept", { id: ideas[0].id }).status, "idea_accepted");
  assert.equal(runTool("sticky_idea_reject", { id: ideas[1].id }).status, "idea_rejected");
  const after = viewForTests();
  assert.equal(after.notes.filter((note) => note.idea).length, 3);
  assert.equal(after.notes.find((note) => note.id === ideas[0].id).idea, false);
  assert.ok(ideas.every((note) => note.mark === "claude"), "the mascot pins every idea the model wrote");
  assert.deepEqual(after.board.brainstorm.rejected, ["Invite three keynote speakers"]);
});

test("an edit on a brainstorm board suggests ideas and a change, and nothing changes until accepted", async () => {
  runTool("sticky_brainstorm_set", { on: true });
  const budget = runTool("sticky_note_create", { content: "Budget is 5000" }).note;
  const venue = runTool("sticky_note_update", { id: runTool("sticky_note_create", { content: "x" }).note.id, content: "Venue: the big hall" });
  assert.deepEqual(venue.brainstorm, { boardId: "board-main", noteId: venue.note.id, first: false });
  let prompt = "";
  const reply = JSON.stringify({ add: [{ content: "Check the hall has a projector" }], edit: [{ id: budget.id, content: "Budget is 5000, hall rent included", reason: "the hall costs money" }] });
  const round = await runBrainstorm(venue.brainstorm, async (instruction, text) => { prompt = text; return reply; });
  assert.equal(round.status, "ideas");
  assert.match(prompt, /\(CHANGED\) Venue: the big hall/);
  const view = viewForTests();
  assert.equal(view.proposals.length, 1);
  assert.equal(view.notes.find((note) => note.id === budget.id).content, "Budget is 5000");
  runTool("sticky_idea_accept", { id: view.proposals[0].id });
  assert.equal(viewForTests().notes.find((note) => note.id === budget.id).content, "Budget is 5000, hall rent included");
  assert.equal(viewForTests().proposals.length, 0);
});

test("brainstorm stays quiet when off, and ideas never start another round", async () => {
  const made = runTool("sticky_note_create", { content: "Plain note" });
  assert.equal(made.brainstorm, null);
  runTool("sticky_brainstorm_set", { on: true });
  const seed = runTool("sticky_note_create", { content: "Seed" });
  await runBrainstorm(seed.brainstorm, async () => JSON.stringify({ add: [{ content: "An idea" }] }));
  const idea = viewForTests().notes.find((note) => note.idea);
  assert.equal(runTool("sticky_note_update", { id: idea.id, content: "An edited idea" }).brainstorm, null);
  assert.equal(runTool("sticky_idea_accept", { id: idea.id }).brainstorm, null);
  assert.equal(parseSticky("turn off brainstorm mode").tool, "sticky_brainstorm_set");
  assert.equal(parseSticky("brainstorm mode on").args.on, true);
  assert.equal(parseSticky("brainstorm on a new logo").args.topic, "a new logo");
});

test("export lists the open board's kept notes top to bottom as Markdown and HTML", () => {
  runTool("sticky_note_create", { content: "Second <b>bold</b><br>line two", title: "Lower", x: 0, y: 500 });
  runTool("sticky_note_create", { content: "Book the hall", title: "Upper", x: 0, y: 10, checklist: [{ text: "Call venue", done: true }] });
  runTool("sticky_note_create", { content: "an idea", title: "Idea", x: 0, y: 0 });
  const idea = boardForExport().notes.find((note) => note.title === "Idea");
  idea.idea = true;
  const data = boardForExport();
  assert.deepEqual(data.notes.map((note) => note.title), ["Upper", "Lower"]);
  const md = boardMarkdown(data);
  assert.match(md, /^# Board\n/);
  assert.ok(md.indexOf("## Upper") < md.indexOf("## Lower"));
  assert.match(md, /- \[x\] Call venue/);
  assert.match(md, /Second \*\*bold\*\*\nline two/);
  assert.doesNotMatch(md, /Idea/);
  assert.match(boardHtml(data), /<h2>Upper<\/h2>/);
  assert.equal(htmlToMarkdown("<div>a &amp; b</div><ul><li>one</li></ul>"), "a & b\n\n- one");
});

test("board drawings keep only pens, lines and arrows with sane values; pictures only load app stylesheets", () => {
  const ink = cleanInk([
    { tool: "pen", color: "#ff0000", size: 4, points: [[1, 2], [3, 4], [5, 6]] },
    { tool: "arrow", color: "red", size: 400, points: [[0, 0], [5, 5], [10, 10]] },
    { tool: "circle", points: [[0, 0], [1, 1]] },
    { tool: "line", points: [[0, 0]] },
  ]);
  assert.equal(ink.length, 2);
  assert.deepEqual(ink[1], { tool: "arrow", color: "#1e2a32", size: 40, points: [[0, 0], [10, 10]] });
  const page = snapshotPage({ html: "<div></div>", width: 300, height: 200, css: ["http://127.0.0.1:3001/stickies.css", "https://evil.example/x.css"] });
  assert.match(page.html, /127\.0\.0\.1:3001\/stickies\.css/);
  assert.doesNotMatch(page.html, /evil/);
  assert.throws(() => snapshotPage({ html: "", width: 9000, height: 10 }));
});

test("dropping a note on another asks before combining; yes folds the first into the second", async () => {
  const a = runTool("sticky_note_create", { content: "Book the hall", title: "Venue" }).note;
  const b = runTool("sticky_note_create", { content: "Hall needs 200 seats", title: "Seats" }).note;
  let sent = "";
  const ask = async (instruction, text) => {
    if (instruction.includes("Label")) return "{}";
    sent = text;
    return JSON.stringify({ title: "Venue", content: "Book the hall with 200 seats" });
  };
  const asked = runTool("sticky_note_combine", { id: a.id, intoId: b.id });
  assert.equal(asked.status, "thinking");
  assert.equal(asked.brainstorm.mode, "merge");
  await runBrainstorm(asked.brainstorm, ask);
  assert.match(sent, /First note: Venue: Book the hall\nSecond note: Seats: Hall needs 200 seats/);
  let view = viewForTests();
  assert.equal(view.proposals.length, 1);
  assert.equal(view.proposals[0].kind, "merge");
  assert.equal(view.notes.find((note) => note.id === b.id).content, "Hall needs 200 seats", "nothing changes before yes");
  assert.equal(runTool("sticky_idea_reject", { id: view.proposals[0].id }).status, "idea_rejected");
  assert.equal(viewForTests().notes.length, 2, "no means both notes stay");
  assert.deepEqual(viewForTests().board.brainstorm.rejected, [], "a refused combine is not a rejected idea");
  await runBrainstorm(runTool("sticky_note_combine", { id: a.id, intoId: b.id }).brainstorm, ask);
  view = viewForTests();
  assert.equal(runTool("sticky_idea_accept", { id: view.proposals[0].id }).status, "idea_accepted");
  view = viewForTests();
  assert.equal(view.notes.length, 1);
  assert.equal(view.notes[0].id, b.id);
  assert.equal(view.notes[0].title, "Venue");
  assert.equal(view.notes[0].content, "Book the hall with 200 seats");
  assert.equal(view.notes[0].mark, "claude", "a rewritten note gets the mascot pin");
  assert.equal(view.trash.length, 1, "the dragged note waits in the trash");
  assert.equal(view.proposals.length, 0);
});

test("branch ideas ring a note with arrows; a dropped idea takes its arrow; keep all keeps the rest", async () => {
  const seed = runTool("sticky_note_create", { content: "Invite speakers", title: "Speakers", x: 800, y: 600 }).note;
  let asked = "";
  const ask = async (instruction) => {
    if (instruction.includes("Label")) return "{}";
    asked = instruction;
    return JSON.stringify({ add: [
      { title: "Shortlist", content: "List ten names" }, { title: "Invite", content: "Send invitations" },
      { title: "Travel", content: "Book flights" }, { title: "Extra", content: "Too many" }, { title: "Five", content: "Dropped by the limit" },
    ] });
  };
  const made = runTool("sticky_idea_branch", { id: seed.id });
  assert.equal(made.brainstorm.mode, "branch");
  await runBrainstorm(made.brainstorm, ask);
  assert.match(asked, /Give 4 ideas that grow out of/);
  let view = viewForTests();
  const ideas = view.notes.filter((note) => note.idea);
  assert.equal(ideas.length, 4);
  assert.equal(view.board.ink.length, 4);
  assert.ok(view.board.ink.every((stroke) => stroke.tool === "arrow" && ideas.some((idea) => idea.id === stroke.noteId)));
  assert.ok(ideas.every((idea) => Math.abs(idea.positionX - seed.positionX) > 100 || Math.abs(idea.positionY - seed.positionY) > 100), "ideas sit away from the note");
  runTool("sticky_idea_reject", { id: ideas[0].id });
  view = viewForTests();
  assert.equal(view.board.ink.length, 3, "the arrow goes with the idea");
  assert.equal(runTool("sticky_idea_accept_all", {}).count, 3);
  view = viewForTests();
  assert.equal(view.notes.filter((note) => note.idea).length, 0);
  assert.equal(view.notes.length, 4);
  assert.equal(view.board.ink.length, 3, "kept ideas keep their arrows");
  const more = runTool("sticky_idea_more", { query: "speakers" });
  assert.equal(more.brainstorm.mode, "more");
});

test("the brief and the wild slider steer every round; poke holes adds a pink note under each kept note", async () => {
  runTool("sticky_brainstorm_set", { on: true });
  const a = runTool("sticky_note_create", { content: "Book the hall", title: "Venue", x: 100, y: 100 }).note;
  const b = runTool("sticky_note_create", { content: "Sell tickets", title: "Tickets", x: 400, y: 100 }).note;
  await fetchLike("/stickies/board", { brief: "budget is 5000 dollars", wild: 90 });
  let asked = "";
  const ask = async (instruction) => {
    if (instruction.includes("Label")) return "{}";
    asked = instruction;
    return JSON.stringify({ holes: [{ id: a.id, title: "Deposit", content: "Who pays the deposit?" }, { id: b.id, content: "What if nobody buys?" }, { id: "nope", content: "x" }] });
  };
  const round = runTool("sticky_brainstorm_challenge", {});
  assert.equal(round.status, "thinking");
  await runBrainstorm(round.brainstorm, ask);
  assert.match(asked, /What the user cares about: budget is 5000 dollars/);
  assert.match(asked, /Be bold/);
  const holes = viewForTests().notes.filter((note) => note.idea);
  assert.equal(holes.length, 2);
  assert.ok(holes.every((note) => note.color === "pink"));
  const under = holes.find((note) => note.title === "Deposit");
  assert.equal(under.positionY, a.positionY + a.height + 16);
  assert.equal(runTool("sticky_idea_reject_all", {}).count, 2);
  assert.equal(viewForTests().notes.length, 2);
});

test("sort into themes tags the kept notes and groups the board by hashtag", async () => {
  const ids = ["Book the hall", "Sell tickets", "Print posters"].map((content) => runTool("sticky_note_create", { content }).note.id);
  const ask = async (instruction) => {
    if (instruction.includes("Label")) return "{}";
    return JSON.stringify({ themes: [{ name: "Venue", ids: [ids[0]] }, { name: "Promotion", ids: [ids[1], ids[2]] }] });
  };
  assert.equal(runTool("sticky_brainstorm_themes", {}).status, "thinking");
  await runBrainstorm({ boardId: viewForTests().board.id, noteId: ids[0], mode: "themes" }, ask);
  const view = viewForTests();
  assert.equal(view.board.group, "hashtag");
  assert.equal(view.board.layout, "organized");
  assert.deepEqual(view.notes.find((note) => note.id === ids[2]).hashtags.map((tag) => tag.display), ["Promotion"]);
  assert.deepEqual(parseSticky("poke holes in my plan"), { tool: "sticky_brainstorm_challenge", args: {} });
  assert.deepEqual(parseSticky("sort the board into themes"), { tool: "sticky_brainstorm_themes", args: {} });
  assert.deepEqual(parseSticky("keep all the ideas"), { tool: "sticky_idea_accept_all", args: {} });
  assert.deepEqual(parseSticky("branch ideas from the note about tickets"), { tool: "sticky_idea_branch", args: { query: "tickets" } });
});

test("a pasted list makes one note per line; a dropped idea can come back", () => {
  const made = runTool("sticky_note_create_many", { text: "- Book the hall\n2. Sell tickets\n\n• Print posters", x: 100, y: 100 });
  assert.equal(made.status, "created_many");
  assert.deepEqual(made.notes.map((note) => note.content), ["Book the hall", "Sell tickets", "Print posters"]);
  assert.equal(made.notes[1].positionX, 360);
  const home = viewForTests().board;
  home.brainstorm.rejected = ["Hire a band"];
  const back = runTool("sticky_idea_restore", { text: "Hire a band" });
  assert.equal(back.status, "idea_restored");
  assert.equal(back.note.idea, true);
  assert.deepEqual(viewForTests().board.brainstorm.rejected, []);
  assert.equal(runTool("sticky_idea_restore", { text: "Hire a band" }).status, "not_found");
});

test("a note that sounds like another makes the mascot offer to combine them, brainstorm off", async () => {
  runTool("sticky_note_create", { content: "Book the big hall at the hotel for the conference dinner" });
  const twin = runTool("sticky_note_create", { content: "Book the big hall at the hotel for the conference dinner on Friday" });
  assert.equal(twin.brainstorm?.mode, "merge");
  assert.equal(twin.brainstorm.why, "sounds like");
  const other = runTool("sticky_note_create", { content: "Completely different: order flowers" });
  assert.equal(other.brainstorm, null);
  await runBrainstorm(twin.brainstorm, async (instruction) => instruction.includes("Label") ? "{}" : JSON.stringify({ title: "Hall", content: "Book the big hall for the dinner on Friday" }));
  const view = viewForTests();
  assert.equal(view.proposals.length, 1);
  assert.match(view.proposals[0].reason, /sounds like/);
});

test("summary writes one pinned note and refreshes it; plan dates the notes and adds a plan", async () => {
  const a = runTool("sticky_note_create", { content: "Book the hall", title: "Venue" }).note;
  const b = runTool("sticky_note_create", { content: "Sell tickets", title: "Tickets" }).note;
  const ask = async (instruction) => {
    if (instruction.includes("Label")) return "{}";
    if (instruction.includes("sum up")) return JSON.stringify({ content: "A conference. Hall and tickets planned. Date still open." });
    return JSON.stringify({ plan: { title: "Conference prep", from: "2026-11-02", to: "2026-11-20", place: "Amman", comment: "Venue first" }, tasks: [{ id: a.id, dueAt: "2026-11-02" }, { id: b.id, dueAt: "2026-11-20" }, { id: "nope", dueAt: "2026-11-01" }] });
  };
  await runBrainstorm(runTool("sticky_board_summary", {}).brainstorm, ask);
  await runBrainstorm(runTool("sticky_board_summary", {}).brainstorm, ask);
  let view = viewForTests();
  const summaries = view.notes.filter((note) => note.summary);
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].isPinned, true);
  assert.match(summaries[0].content, /Date still open/);
  const plans = [];
  setHooksForTests({ addPlan: (body) => { plans.push(body); return { plan: { ...body, id: "p1" } }; } });
  const planned = await runBrainstorm(runTool("sticky_board_plan", {}).brainstorm, ask);
  assert.equal(planned.status, "planned");
  assert.equal(planned.count, 2);
  view = viewForTests();
  const venue = view.notes.find((note) => note.id === a.id);
  assert.equal(venue.noteType, "task");
  assert.equal(venue.dueAt, "2026-11-02T09:00:00");
  assert.deepEqual(plans, [{ title: "Conference prep", from: "2026-11-02", to: "2026-11-20", place: "Amman", comment: "Venue first" }]);
  setHooksForTests({});
});

test("ideas from my files use only the found excerpts and say where each came from", async () => {
  runTool("sticky_note_create", { content: "arranging a conference" });
  let seen = "";
  setHooksForTests({ findFiles: async (query) => { seen = query; return [{ name: "Conference 2025 notes", text: "Last year the hall cost 3000 and the coffee ran out." }]; } });
  const ask = async (instruction, text) => {
    if (instruction.includes("Label")) return "{}";
    assert.match(instruction, /using only excerpts/);
    assert.match(text, /### Conference 2025 notes/);
    return JSON.stringify({ add: [{ title: "Coffee", content: "Order double the coffee", source: "Conference 2025 notes" }] });
  };
  const made = await runBrainstorm(runTool("sticky_ideas_from_files", { topic: "catering" }).brainstorm, ask);
  assert.equal(made.status, "ideas");
  assert.match(seen, /catering/);
  const idea = viewForTests().notes.find((note) => note.idea);
  assert.equal(idea.content, "Order double the coffee (from: Conference 2025 notes)");
  setHooksForTests({ findFiles: async () => [] });
  const none = await runBrainstorm(runTool("sticky_ideas_from_files", {}).brainstorm, ask);
  assert.equal(none.status, "no_files");
  setHooksForTests({});
});

test("a template makes a new board with lines and pinned header notes", () => {
  const made = runTool("sticky_board_template", { template: "SWOT" });
  assert.equal(made.status, "board_created");
  const view = viewForTests();
  assert.equal(view.board.name, "SWOT");
  assert.equal(view.board.ink.length, 6, "three vertical and three horizontal lines");
  assert.deepEqual(view.notes.map((note) => note.title).sort(), ["Opportunities", "Strengths", "Threats", "Weaknesses"]);
  assert.ok(view.notes.every((note) => note.isPinned && note.color === "white"));
  assert.equal(runTool("sticky_board_template", { template: "nope" }).ok, false);
  assert.deepEqual(parseSticky("new board from the week template called Sprint 3"), { tool: "sticky_board_template", args: { template: "week", name: "Sprint 3" } });
  assert.deepEqual(parseSticky("summarize the board"), { tool: "sticky_board_summary", args: {} });
  assert.deepEqual(parseSticky("ideas from my files about catering"), { tool: "sticky_ideas_from_files", args: { topic: "catering" } });
});

test("a web page becomes at most ten notes plus one with the link; the model is told what kind of page it is", async () => {
  setHooksForTests({ readPage: async (url) => ({ kind: "paper", title: "Vaccine trial", text: `Abstract of ${url}` }) });
  let asked = "";
  const ask = async (instruction, text) => {
    if (instruction.includes("Label")) return "{}";
    asked = `${instruction}\n${text}`;
    return JSON.stringify({ add: Array.from({ length: 12 }, (_, i) => ({ title: `Point ${i + 1}`, content: `Finding number ${i + 1}` })) });
  };
  assert.equal(runTool("sticky_import_url", { url: "ftp://x" }).ok, false);
  assert.equal(runTool("sticky_import_url", { url: "http://127.0.0.1:3001/" }).ok, false);
  const made = runTool("sticky_import_url", { url: "https://pubmed.ncbi.nlm.nih.gov/33301246/" });
  assert.equal(made.brainstorm.mode, "import");
  const round = await runBrainstorm(made.brainstorm, ask);
  assert.equal(round.status, "imported");
  assert.equal(round.count, 10);
  assert.match(asked, /scientific paper/);
  assert.match(asked, /Abstract of https:\/\/pubmed/);
  const view = viewForTests();
  assert.equal(view.notes.length, 11);
  const source = view.notes.find((note) => note.title === "Vaccine trial");
  assert.match(source.content, /<a href="https:\/\/pubmed\.ncbi\.nlm\.nih\.gov\/33301246\/">/);
  assert.ok(view.notes.every((note) => note.mark === "claude" && !note.idea), "imported notes are real notes with the mascot pin");
  setHooksForTests({ readPage: async () => { throw new Error("The page answered 404."); } });
  const bad = await runBrainstorm(runTool("sticky_import_url", { url: "https://example.org/gone" }).brainstorm, ask);
  assert.equal(bad.status, "no_page");
  assert.match(bad.error, /404/);
  setHooksForTests({});
  assert.deepEqual(parseSticky("import https://github.com/expressjs/express as stickies"), { tool: "sticky_import_url", args: { url: "https://github.com/expressjs/express" } });
  assert.equal(importableUrl("https://host.local/x"), null);
  const page = articleText("<html><head><title>T</title></head><body><nav><p>menu menu menu menu menu menu menu menu</p></nav><h2>Methods</h2><p>We enrolled forty-three thousand participants in a randomized trial.</p><script>x()</script></body></html>");
  assert.equal(page.title, "T");
  assert.equal(page.text, "## Methods\nWe enrolled forty-three thousand participants in a randomized trial.");
});

test("the back of a note holds more text, is cleaned, searched, and exported", () => {
  const note = runTool("sticky_note_create", { content: "Front side", title: "Card" }).note;
  assert.equal(note.back, "");
  const saved = runTool("sticky_note_update", { id: note.id, back: "Long notes <b>here</b> about zebras <script>x()</script>" });
  assert.equal(saved.note.back, "Long notes <b>here</b> about zebras ");
  assert.equal(viewForTests({ q: "zebras" }).notes.length, 1, "the back is searched");
  const md = boardMarkdown(boardForExport());
  assert.match(md, /Back of the note:\n\nLong notes \*\*here\*\* about zebras/);
});

test("consolidate waits for themes, then folds each theme into one note with the old ones on the back", async () => {
  const ids = ["Book the hall", "Hall needs 200 seats", "Sell tickets", "Print posters"].map((content, i) => runTool("sticky_note_create", { content, title: `N${i}`, x: 100 * i, y: 50 }).note.id);
  assert.match(runTool("sticky_brainstorm_consolidate", {}).error, /Sort the board into themes first/);
  const ask = async (instruction, text) => {
    if (instruction.includes("Label")) return "{}";
    if (instruction.includes("tidy")) return JSON.stringify({ themes: [{ name: "Venue", ids: [ids[0], ids[1]] }, { name: "Promotion", ids: [ids[2], ids[3]] }] });
    assert.match(text, /Theme: Venue\n- N0: Book the hall\n- N1: Hall needs 200 seats/);
    return JSON.stringify({ themes: [{ name: "Venue", title: "Venue", content: "Book the hall with 200 seats" }, { name: "Nope", title: "x", content: "ignored" }] });
  };
  await runBrainstorm(runTool("sticky_brainstorm_themes", {}).brainstorm, ask);
  const round = runTool("sticky_brainstorm_consolidate", {});
  assert.equal(round.status, "thinking");
  const made = await runBrainstorm(round.brainstorm, ask);
  assert.equal(made.status, "consolidated");
  assert.equal(made.count, 1);
  const view = viewForTests();
  assert.equal(view.notes.length, 3, "two Venue notes became one; Promotion was not answered and stays");
  const venue = view.notes.find((note) => note.title === "Venue");
  assert.equal(venue.content, "Book the hall with 200 seats");
  assert.equal(venue.back, "<b>N0</b><br>Book the hall<br><br><b>N1</b><br>Hall needs 200 seats");
  assert.deepEqual(venue.hashtags.map((tag) => tag.display), ["Venue"]);
  assert.equal(venue.mark, "claude");
  assert.equal(venue.positionX, 0, "it sits where the first old note was");
  assert.equal(view.trash.length, 2);
  assert.equal(view.board.group, "hashtag", "the board stays in theme view");
  assert.deepEqual(parseSticky("consolidate the themes"), { tool: "sticky_brainstorm_consolidate", args: {} });
});

test("summarize a note shows a shorter version to approve; yes keeps the long text on the back", async () => {
  const long = "We need to book the big hall at the hotel for the conference dinner on Friday evening, confirm the catering for 200 guests, and check that the projector and microphones work before the speakers arrive.";
  const note = runTool("sticky_note_create", { content: long, title: "Dinner" }).note;
  assert.match(runTool("sticky_note_summarize", { query: "nothing like this" }).status, /not_found/);
  assert.match(runTool("sticky_note_create", { content: "Short one" }).note.id, /./);
  assert.match(runTool("sticky_note_summarize", { query: "short one" }).error, /already short/);
  const ask = async (instruction, text) => {
    if (instruction.includes("Label")) return "{}";
    assert.match(instruction, /shorten one sticky note/);
    assert.match(text, /^Dinner: We need to book/);
    return JSON.stringify({ content: "Book the hotel hall for Friday's dinner, confirm catering for 200, test projector and mics." });
  };
  const asked = runTool("sticky_note_summarize", { id: note.id });
  assert.equal(asked.brainstorm.mode, "shorten");
  await runBrainstorm(asked.brainstorm, ask);
  let view = viewForTests();
  assert.equal(view.proposals.length, 1);
  assert.equal(view.proposals[0].kind, "shorten");
  assert.equal(view.notes.find((item) => item.id === note.id).content, long, "nothing changes before yes");
  runTool("sticky_idea_reject", { id: view.proposals[0].id });
  assert.deepEqual(viewForTests().board.brainstorm.rejected, []);
  await runBrainstorm(runTool("sticky_note_summarize", { id: note.id }).brainstorm, ask);
  view = viewForTests();
  runTool("sticky_idea_accept", { id: view.proposals[0].id });
  const after = viewForTests().notes.find((item) => item.id === note.id);
  assert.equal(after.content, "Book the hotel hall for Friday's dinner, confirm catering for 200, test projector and mics.");
  assert.equal(after.back, long, "the full text waits on the back");
  assert.equal(after.mark, "claude");
  assert.deepEqual(parseSticky("summarize the note about dinner"), { tool: "sticky_note_summarize", args: { query: "dinner" } });
});

test("converting to a to-do turns the note's parts into checks: at once for a list, by the model otherwise", async () => {
  const listed = runTool("sticky_note_create", { content: "<ul><li>Book the hall</li><li>Order coffee</li></ul>" }).note;
  const made = runTool("sticky_note_convert_to_task", { id: listed.id });
  assert.equal(made.brainstorm, null);
  assert.deepEqual(made.note.checklist.map((item) => item.text), ["Book the hall", "Order coffee"]);
  const lines = runTool("sticky_note_create", { content: "1. Call the venue<br>2. Pay the deposit<br>" }).note;
  assert.deepEqual(runTool("sticky_note_convert_to_task", { id: lines.id }).note.checklist.map((item) => item.text), ["Call the venue", "Pay the deposit"]);
  const prose = runTool("sticky_note_create", { content: "Arrange the conference dinner for the speakers" }).note;
  const asked = runTool("sticky_note_convert_to_task", { id: prose.id });
  assert.equal(asked.brainstorm.mode, "steps");
  assert.deepEqual(asked.note.checklist, []);
  const round = await runBrainstorm(asked.brainstorm, async (instruction) => instruction.includes("Label") ? "{}" : JSON.stringify({ items: ["Pick a restaurant", "Book a table for 12", "Send the invitations"] }));
  assert.equal(round.status, "steps");
  const after = viewForTests().notes.find((note) => note.id === prose.id);
  assert.deepEqual(after.checklist.map((item) => item.text), ["Pick a restaurant", "Book a table for 12", "Send the invitations"]);
  assert.ok(after.checklist.every((item) => item.done === false && item.id));
  const again = runTool("sticky_note_convert_to_task", { id: prose.id });
  assert.equal(again.brainstorm, null, "a note that already has checks keeps them");
});
