# Sticky notes API

The board is part of Second Brain. The page and the voice both use the same tools. Notes are stored in `second-brain/stickies.json` (schema version 1). That file is not in git.

The running server is the Node app (`second-brain/stickies.js`), because it already holds the file in memory. The Rust copy of the tools is `rust/src/stickies.rs` (`Stickies::dispatch`). It uses the same tool names. Do not run both writers on one file.

## Tools

| Tool | What it does |
|---|---|
| `sticky_note_create` | New note. `content`, `color`, `x`, `y`, `title`, `dueAt`. |
| `sticky_note_update` | Edit. `id` or `query`, plus `content`, `append`, `title`, `titleLocked`, `checklist`, `strokes`, `x`, `y`, `width`, `height`. |
| `sticky_note_delete` | Trash. Needs `confirm: true`. Two matches return `status: "choose"` and do not delete. |
| `sticky_note_archive` | Hide from the board. `completedLastMonth: true` asks first. |
| `sticky_note_restore` | Put an archived or trashed note back, same id and position. |
| `sticky_note_search` | Find notes. `query`. |
| `sticky_note_list` | Filter. `color`, `hashtag`, `priority`, `noteType`, `taskStatus`, `due`, `archived`, `trash`. |
| `sticky_note_classify` | Ask the model for a title, hashtags, and priority. Does not block editing. |
| `sticky_note_set_color` | `color` is yellow, pink, blue, green, orange, purple, white, gray, or custom. |
| `sticky_note_set_priority` | critical, high, medium, low, or none. A user choice is locked. |
| `sticky_note_convert_to_task` | Same id. Words stay. Optional `priority`. |
| `sticky_note_convert_to_note` | Task becomes a note again. |
| `sticky_note_set_reminder` | `reminderAt` as an ISO time, or null to clear. |
| `sticky_note_link` | `fromId`, `toId` or `href`. The link stores ids. |
| `sticky_note_move` | `x`, `y`. |
| `sticky_note_sort` | `sort`, `layout` (`freeform` or `organized`), `group`. Saved positions are not cleared. |

A tool reply looks like `{ ok, status, note, notes, choices, error }`. `status` is `choose` or `confirm` when the agent must ask you before it changes anything.

Spoken lines such as “Create a yellow sticky note…” go through `parseSticky` in `stickies.js`, then into one of these tools. “yes” and “number 2” answer a pending question. The answer has to be the whole sentence, and it has to come within five minutes; after that the question is dropped.

## HTTP

| Method | Path | Body |
|---|---|---|
| GET | `/stickies` | Optional `color`, `hashtag`, `q`, `view` (`archive` or `trash`). |
| PUT | `/stickies/board` | Background, layout, sort, group, zoom, pan. |
| PUT | `/stickies/prefs` | `{ prefs, colorMeanings }`. |
| POST | `/stickies/notes` | Fields for a new note. |
| PATCH | `/stickies/notes/:id` | Fields to change. `409` if `baseVersion` is older than the saved note. |
| POST | `/stickies/tool` | `{ name, args }`. |
| POST | `/stickies/command` | `{ question }` in plain words. |

Labeling uses the model already chosen for Second Brain (`askModelOnce`). It does not add another model provider. A failed label leaves the note as you wrote it.

## Board settings

`background`: `wood` (default), `cork`, `darkwood`, `white`, `black`, `gray`, `color`, `image`.

`appearance`: `light`, `dark`, or `system`. This changes the buttons around the board. The board picture stays what you picked.

`defaultColorMode`: `last`, `fixed`, `ask`, or `auto`. Auto may recolor from priority. A color you picked yourself is kept.

Trash is kept for `trashDays` (default 30), then removed.

## Schema version

`version` is `1`. `migrate()` in `stickies.js` fills in anything an older file is missing. New fields should be optional so an old file still opens.
