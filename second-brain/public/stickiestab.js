// The bulletin board. Notes are saved on the Mac (stickies.js). Typing saves itself.
// The voice can change the same notes. This file only draws them.
(() => {
  const btn = document.getElementById("stickiesBtn");
  const COLORS = ["yellow", "pink", "blue", "green", "orange", "purple", "white", "gray"];
  const VIEWS = ["board", "tasks", "archive", "trash"];
  // The view box also offers these, which are the task list with a filter.
  const VIEW_FILTERS = {
    today: { due: "today" },
    upcoming: { due: "upcoming" },
    overdue: { due: "overdue" },
    completed: { taskStatus: "done" },
  };
  // The same words the server skips when it searches (stickies.js), so a spoken search shows what it found.
  const SEARCH_SKIP = new Set(["the", "a", "an", "my", "to", "of", "and", "for", "about", "that", "this", "note", "notes"]);
  const ui = {
    root: null, stage: null, world: null, board: null, status: null, menu: null, map: null,
    data: null, selected: "", filter: {}, view: "board", timers: new Map(), undo: new Map(),
    zoom: 1, panX: 40, panY: 30, drawing: false, stale: false,
    // Drawing on the board itself (not inside a note): pen, line, arrow or eraser.
    ink: { on: false, tool: "pen", color: "#d1342f", size: 4, live: null },
  };
  const SVG = "http://www.w3.org/2000/svg";

  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  };

  function say(text) {
    if (ui.status) ui.status.textContent = text;
  }

  function prefs() { return ui.data?.prefs || {}; }
  function board() { return ui.data?.board || {}; }

  function notes() {
    if (!ui.data) return [];
    if (ui.view === "trash") return ui.data.trash || [];
    return ui.data.notes || [];
  }

  // Priority shows as 1 to 3 stars. A click goes 1 → 2 → 3 → 1. The server still stores low/medium/high.
  const STARS = { critical: 3, high: 3, medium: 2, low: 1, none: 1 };
  const STAR_PRIORITY = ["", "low", "medium", "high"];
  function starButton(note) {
    const count = STARS[note.priority] || 1;
    const button = el("button", "sticky-stars", "★".repeat(count) + "☆".repeat(3 - count));
    button.type = "button";
    button.title = `${count} of 3 stars. Click for ${count === 3 ? 1 : count + 1}.`;
    button.setAttribute("aria-label", `Priority ${count} of 3 stars`);
    button.addEventListener("pointerdown", (event) => event.stopPropagation());
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      tool("sticky_note_set_priority", { id: note.id, priority: STAR_PRIORITY[count === 3 ? 1 : count + 1] }).then(() => load()).catch((err) => say(err.message));
    });
    return button;
  }

  // Same rule as tagKey() in stickies.js, so "#Mobile App" finds the tag mobileapp.
  const tagKey = (text) => String(text || "").replace(/^#+/, "").trim().toLowerCase().replace(/[\s_-]+/g, "");

  function visible() {
    const f = ui.filter;
    const tag = tagKey(f.hashtag);
    const words = String(f.q || "").toLowerCase().split(/\s+/).filter((word) => word.length > 1 && !SEARCH_SKIP.has(word));
    return notes().filter((note) => {
      if (f.color && note.color !== f.color) return false;
      if (tag && !note.hashtags.some((item) => item.key === tag)) return false;
      if (f.priority === "high+") {
        if (note.priority !== "high" && note.priority !== "critical") return false;
      } else if (f.priority && note.priority !== f.priority) return false;
      if (words.length) {
        const hay = `${note.title} ${strip(note.content)} ${note.hashtags.map((item) => `${item.display} ${item.key}`).join(" ")}`.toLowerCase();
        if (!words.some((word) => hay.includes(word))) return false;
      }
      if (ui.view === "archive") return Boolean(note.archivedAt);
      if (ui.view === "trash") return true;
      if (note.archivedAt) return false;
      if (board().sort === "due" && !note.dueAt && !note.reminderAt) return false;
      if (ui.view === "tasks" && note.noteType !== "task") return false;
      if (f.due === "today" && !sameDay(note.dueAt)) return false;
      if (f.due === "upcoming" && !(note.dueAt && new Date(note.dueAt) > new Date() && note.taskStatus !== "done")) return false;
      if (f.due === "overdue" && !(note.dueAt && new Date(note.dueAt) < new Date() && note.taskStatus !== "done")) return false;
      if (f.taskStatus === "done" && note.taskStatus !== "done") return false;
      if (f.taskStatus === "open" && note.taskStatus === "done") return false;
      return true;
    });
  }

  function sameDay(value) {
    if (!value) return false;
    const date = new Date(value);
    const now = new Date();
    return date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
  }

  function arabic(note) {
    return /[\u0600-\u06FF]/.test(`${note.title || ""} ${note.content || ""}`);
  }

  // The server leaves archived notes out unless the archive is asked for.
  async function load() {
    const response = await fetch(ui.view === "archive" ? "/stickies?view=archive" : "/stickies");
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Could not read the sticky notes.");
    ui.data = data;
    ui.zoom = data.board?.zoom || 1;
    ui.panX = Number.isFinite(data.board?.panX) ? data.board.panX : 40;
    ui.panY = Number.isFinite(data.board?.panY) ? data.board.panY : 30;
    applyLook();
    if (ui.sortBox) ui.sortBox.value = data.board?.sort || "manual";
    if (ui.groupBox) ui.groupBox.value = data.board?.group || "";
    fillBoards();
    draw();
  }

  const NEW_BOARD = "__new";

  function fillBoards() {
    if (!ui.boardBox) return;
    ui.boardBox.replaceChildren();
    (ui.data?.boards || []).forEach((item) => {
      const option = el("option", "", item.name);
      option.value = item.id;
      ui.boardBox.append(option);
    });
    const add = el("option", "", "+ New board…");
    add.value = NEW_BOARD;
    ui.boardBox.append(add);
    ui.boardBox.value = board().id || "";
  }

  async function pickBoard(value) {
    if (value !== NEW_BOARD) {
      const made = await tool("sticky_board_switch", { boardId: value });
      if (!made.ok) say(made.error);
      await load();
      return;
    }
    ui.boardBox.value = board().id || "";
    const rect = ui.boardBox.getBoundingClientRect();
    ui.menuAt = [rect.left, rect.bottom + 4];
    const field = el("input");
    field.placeholder = "Board name";
    const name = await askIn("New board", field, "Make board");
    if (!name?.trim()) return;
    const made = await tool("sticky_board_create", { name });
    say(made.ok ? `Made the ${made.board.name} board.` : made.error);
    await load();
  }

  function applyLook() {
    const mode = prefs().appearance || "system";
    const dark = mode === "system" ? matchMedia("(prefers-color-scheme: dark)").matches : mode === "dark";
    ui.root.dataset.appearance = dark ? "dark" : "light";
    const current = board();
    ui.board.dataset.bg = current.background || "wood";
    ui.board.dataset.texture = prefs().paperTexture === false ? "0" : "1";
    ui.board.dataset.corners = prefs().corners || "round";
    ui.board.dataset.pin = prefs().pinStyle || "pin";
    ui.board.style.backgroundColor = current.background === "color" ? (current.backgroundColor || "#c4a574") : "";
    ui.board.style.backgroundImage = current.background === "image" && current.backgroundImage ? `url("${current.backgroundImage}")` : "";
  }

  function applyTransform() {
    const organized = board().layout === "organized" || ui.view !== "board";
    ui.stage.classList.toggle("is-scroll", organized);
    if (organized) return;
    ui.world.style.transform = `translate(${ui.panX}px, ${ui.panY}px) scale(${ui.zoom})`;
  }

  function draw() {
    const typing = document.activeElement?.closest?.(".sticky");
    if (typing && ui.root.contains(typing)) {
      const note = notes().find((item) => item.id === typing.dataset.id);
      const title = typing.querySelector(".sticky-title");
      if (note && title && document.activeElement !== title && !title.value && note.title) title.value = note.title;
      ui.stale = true;
      // Ideas can arrive while you type. The mascot can still ask about them.
      drawHelper();
      return;
    }
    ui.stale = false;
    ui.board.replaceChildren();
    ui.board.classList.toggle("is-organized", board().layout === "organized" && ui.view === "board");
    ui.board.classList.toggle("is-list", ui.view === "tasks" || ui.view === "archive" || ui.view === "trash");
    const list = visible();
    if (!list.length) ui.board.append(el("p", "stick-status", emptyLine()));
    else if (ui.view === "tasks") list.forEach((note) => ui.board.append(taskRow(note)));
    else if (board().layout === "organized" && ui.view === "board" && board().group) drawGroups(list);
    else if (board().layout === "organized" && ui.view === "board") {
      const grid = el("div", "stick-grid");
      list.forEach((note) => grid.append(noteCard(note)));
      ui.board.append(grid);
    } else list.forEach((note) => ui.board.append(noteCard(note)));
    applyTransform();
    drawInk();
    drawMap();
    drawHelper();
    if (ui.brainBtn) {
      ui.brainBtn.classList.toggle("is-on", Boolean(board().brainstorm?.on));
      ui.brainBtn.setAttribute("aria-pressed", board().brainstorm?.on ? "true" : "false");
    }
    if (ui.brainBar) {
      ui.brainBar.hidden = !(board().brainstorm?.on && ui.view === "board");
      if (document.activeElement !== ui.briefBox) ui.briefBox.value = board().brainstorm?.brief || "";
      ui.wildBox.value = String(board().brainstorm?.wild ?? 50);
      const themed = board().group === "hashtag";
      ui.themesBtn.classList.toggle("is-on", themed);
      ui.themesBtn.setAttribute("aria-pressed", themed ? "true" : "false");
      ui.themesBtn.textContent = themed ? "Themes on" : "Sort into themes";
      ui.consolidateBtn.disabled = !(themed && (ui.data?.groups || []).some((group) => group.noteIds.length >= 2));
      const gone = (board().brainstorm?.rejected || []).length;
      ui.droppedBtn.textContent = gone ? `Dropped (${gone})` : "Dropped";
    }
    if (ui.clearBtn) ui.clearBtn.hidden = ui.view === "board" && !Object.values(ui.filter).some(Boolean);
    const count = list.length;
    say(`${count} ${count === 1 ? "note" : "notes"}.`);
  }

  function emptyLine() {
    if (ui.view === "trash") return "The trash is empty.";
    if (ui.view === "archive") return "Nothing is archived.";
    if (board().sort === "due") return "No notes have a due time or a reminder yet.";
    return "Double-click the board, or press New note.";
  }

  // A note with two hashtags shows in both groups.
  function groupLabels(note, by) {
    if (by === "hashtag") return note.hashtags.length ? note.hashtags.map((tag) => `#${tag.display}`) : ["No hashtag"];
    if (by === "date") return [note.createdAt.slice(0, 10)];
    if (by === "task") return [note.noteType === "task" ? note.taskStatus : "Notes"];
    return [note[by] || "Other"];
  }

  function drawGroups(list) {
    const groups = new Map();
    for (const note of list) {
      for (const label of groupLabels(note, board().group)) {
        if (!groups.has(label)) groups.set(label, []);
        groups.get(label).push(note);
      }
    }
    for (const [label, items] of groups) {
      const group = el("section", "stick-group");
      group.append(el("h3", "", label));
      const grid = el("div", "stick-grid");
      items.forEach((note) => grid.append(noteCard(note)));
      group.append(grid);
      ui.board.append(group);
    }
  }

  // The pin on a note the model wrote or rewrote: the mascot chosen in Settings. Tiny has no
  // drawing to copy, so the Claude critter stands in; the emoji mascot keeps its face.
  function claudeMark() {
    const mark = el("span", "sticky-claude");
    mark.setAttribute("aria-hidden", "true");
    const source = document.getElementById("claudeMark");
    const critter = source?.querySelector(".critter");
    mark.dataset.mascot = critter ? source.dataset.mascot || "claude" : "claude";
    mark.innerHTML = `<svg viewBox="20 0 560 470">${critter ? critter.outerHTML : `<g class="critter">
      <rect class="arm arm-l" x="35" y="140" width="52" height="105"/>
      <rect class="arm arm-r" x="513" y="140" width="52" height="105"/>
      <rect class="leg" x="85" y="340" width="50" height="110"/>
      <rect class="leg" x="180" y="340" width="50" height="110"/>
      <rect class="leg" x="370" y="340" width="50" height="110"/>
      <rect class="leg" x="465" y="340" width="50" height="110"/>
      <rect class="body" x="85" y="35" width="430" height="310"/>
      <g class="eyes"><rect x="160" y="120" width="40" height="80"/><rect x="400" y="120" width="40" height="80"/></g>
      <rect class="mouth" x="270" y="235" width="60" height="40"/>
    </g>`}</svg>`;
    return mark;
  }

  function clockPin(note) {
    const pin = el("span", "sticky-clock");
    const when = new Date(note.reminderAt);
    const label = Number.isNaN(when.getTime()) ? "Reminder set" : `Reminder ${when.toLocaleString()}`;
    pin.title = label;
    pin.setAttribute("aria-label", label);
    pin.innerHTML = `<svg viewBox="0 0 32 32" aria-hidden="true">
      <circle cx="16" cy="16" r="13" fill="#f7f1e4" stroke="#2a2416" stroke-width="2"/>
      <line x1="16" y1="16" x2="16" y2="8" stroke="#2a2416" stroke-width="2" stroke-linecap="round"/>
      <line x1="16" y1="16" x2="22" y2="18" stroke="#c45c26" stroke-width="2" stroke-linecap="round"/>
      <circle cx="16" cy="16" r="1.6" fill="#2a2416"/>
    </svg>`;
    return pin;
  }

  function noteCard(note) {
    const card = el("article", note.id === ui.selected ? "sticky is-selected" : "sticky");
    card.dataset.id = note.id;
    card.dataset.color = note.color;
    card.dataset.font = note.fontStyle || prefs().fontStyle || "hand";
    if ((note.fontFamily || prefs().fontFamily) === "patrick") card.dataset.font = "patrick";
    if ((note.fontStyle || prefs().fontStyle) === "type") card.dataset.font = "type";
    card.dataset.bold = note.bold ? "1" : "0";
    card.dataset.italic = note.italic ? "1" : "0";
    card.dataset.underline = note.underline ? "1" : "0";
    card.dir = arabic(note) ? "rtl" : "auto";
    card.style.left = `${note.positionX}px`;
    card.style.top = `${note.positionY}px`;
    card.style.width = `${note.width}px`;
    card.style.height = `${note.height}px`;
    card.style.setProperty("--rot", `${note.rotation || 0}deg`);
    card.style.setProperty("--shade", String(prefs().shadow ?? 0.55));
    card.style.setProperty("--note-size", `${note.fontSize || prefs().fontSize || 22}px`);
    card.style.setProperty("--note-leading", String(note.lineHeight || 1.35));
    card.style.textAlign = note.align || "start";
    if (note.color === "custom" && note.customColor) card.style.backgroundColor = note.customColor;
    if (note.textColor) card.style.color = note.textColor;
    card.setAttribute("aria-label", note.title || "Sticky note");

    if (note.reminderAt) card.append(clockPin(note));
    else if (note.mark === "claude") card.append(claudeMark());
    else if ((prefs().pinStyle || "pin") !== "none") card.append(el("span", prefs().pinStyle === "tape" ? "sticky-tape" : "sticky-pin"));
    const head = el("div", "sticky-head");
    const title = el("input", "sticky-title");
    title.value = note.title || "";
    title.placeholder = "Title";
    title.setAttribute("aria-label", "Title");
    title.addEventListener("change", () => savePatch(note.id, { title: title.value, titleLocked: true }));
    const lock = el("button", "sticky-lock", note.titleLocked ? "Locked" : "Lock");
    lock.type = "button";
    lock.title = note.titleLocked ? "The model will not rename this note" : "Keep this title when the model labels the note";
    lock.addEventListener("click", () => savePatch(note.id, { titleLocked: !note.titleLocked, title: title.value }));
    const more = el("button", "sticky-more", "•••");
    more.type = "button";
    more.setAttribute("aria-label", "Note actions");
    more.addEventListener("click", (event) => {
      event.stopPropagation();
      openMenu(event.clientX, event.clientY, noteMenu(note));
    });
    head.append(title, lock, more);
    if (note.noteType === "task") head.append(el("span", "sticky-badge", note.taskStatus === "done" ? "Done" : "Task"));
    head.append(starButton(note));

    const body = el("div", "sticky-body");
    body.contentEditable = ui.view === "trash" ? "false" : "true";
    body.setAttribute("role", "textbox");
    body.setAttribute("aria-label", "Note text");
    body.innerHTML = localStorage.getItem(`stickies-draft-${note.id}`) ?? note.content ?? "";
    undoStack(note.id).current = body.innerHTML;
    body.addEventListener("input", () => {
      rememberUndo(note.id, body.innerHTML);
      scheduleSave(note.id, body.innerHTML);
    });
    body.addEventListener("pointerdown", (event) => {
      select(note.id);
      event.stopPropagation();
    });

    const tags = el("div", "sticky-tags");
    note.hashtags.forEach((tag) => {
      const chip = el("button", "sticky-tag", `#${tag.display}`);
      chip.type = "button";
      chip.addEventListener("click", () => {
        ui.filter = { ...ui.filter, hashtag: tag.key };
        draw();
      });
      tags.append(chip);
    });

    const checks = el("ul", "sticky-checks");
    (note.checklist || []).forEach((item) => {
      const row = el("li");
      const box = el("input");
      box.type = "checkbox";
      box.checked = item.done;
      box.addEventListener("change", () => {
        const checklist = note.checklist.map((entry) => entry.id === item.id ? { ...entry, done: box.checked } : entry);
        savePatch(note.id, { checklist });
      });
      row.append(box, el("span", "", item.text));
      checks.append(row);
    });
    const done = (note.checklist || []).filter((item) => item.done).length;
    const progress = note.checklist?.length ? el("p", "sticky-progress", `${done} of ${note.checklist.length} done`) : null;

    const canvas = el("canvas", "sticky-draw");
    canvas.width = 400;
    canvas.height = 300;
    drawStrokes(canvas, note.strokes || []);
    if (ui.drawing && ui.selected === note.id) {
      card.classList.add("is-draw");
      paint(canvas, note, card);
    }

    const resize = el("button", "sticky-resize");
    resize.type = "button";
    resize.setAttribute("aria-label", "Resize note");
    resize.addEventListener("pointerdown", (event) => startResize(event, card, note));

    card.append(head, body, tags, checks);
    if (progress) card.append(progress);
    card.append(canvas, resize);
    // The back: small type, more room. A turned-down corner shows there is something there.
    const back = el("div", "sticky-back");
    back.contentEditable = ui.view === "trash" ? "false" : "true";
    back.setAttribute("role", "textbox");
    back.setAttribute("aria-label", "Back of the note");
    back.dataset.placeholder = "Write on the back…";
    back.innerHTML = note.back || "";
    back.addEventListener("input", () => scheduleSave(note.id, back.innerHTML, 400, "back"));
    back.addEventListener("pointerdown", (event) => { select(note.id); event.stopPropagation(); });
    const flip = el("button", "sticky-flip", ui.flipped === note.id ? "Front" : "Back");
    flip.type = "button";
    flip.title = ui.flipped === note.id ? "Turn the note over to the front" : "Turn the note over and write on the back";
    flip.addEventListener("pointerdown", (event) => event.stopPropagation());
    flip.addEventListener("click", (event) => {
      event.stopPropagation();
      ui.flipped = ui.flipped === note.id ? "" : note.id;
      // A focused side keeps draw() from redrawing, so let go of it first.
      if (card.contains(document.activeElement)) document.activeElement.blur();
      draw();
      if (ui.flipped === note.id) ui.board.querySelector(`[data-id="${note.id}"] .sticky-back`)?.focus();
    });
    const corner = el("button", "sticky-corner");
    corner.type = "button";
    corner.setAttribute("aria-label", "There is writing on the back. Turn the note over.");
    corner.addEventListener("pointerdown", (event) => event.stopPropagation());
    corner.addEventListener("click", (event) => { event.stopPropagation(); flip.click(); });
    card.append(back, flip, corner);
    card.classList.toggle("has-back", Boolean(strip(note.back || "").trim()));
    card.classList.toggle("is-flipped", ui.flipped === note.id);
    head.addEventListener("pointerdown", (event) => startDrag(event, card, note));
    card.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      openMenu(event.clientX, event.clientY, noteMenu(note));
    });
    // A long press opens the menu on a touch screen. A mouse has the right click.
    let press;
    card.addEventListener("pointerdown", (event) => {
      select(note.id);
      if (event.pointerType !== "mouse") press = setTimeout(() => openMenu(event.clientX, event.clientY, noteMenu(note)), 550);
    });
    card.addEventListener("pointerup", () => clearTimeout(press));
    card.addEventListener("pointermove", () => clearTimeout(press));
    if (note.summary) card.classList.add("is-summary");
    if (note.idea) {
      card.classList.add("is-idea");
      card.append(ideaButtons(note.id));
    }
    if ((ui.data?.proposals || []).some((item) => item.noteId === note.id)) card.classList.add("is-proposed");
    return card;
  }

  // ✓ keeps an idea or a suggested change, ✗ drops it. Both the note and the mascot use these.
  function ideaButtons(id) {
    const row = el("div", "stick-idea-btns");
    [["✓", "Keep", true], ["✗", "Drop", false]].forEach(([mark, name, keep]) => {
      const button = el("button", keep ? "stick-yes" : "stick-no", mark);
      button.type = "button";
      button.setAttribute("aria-label", name);
      button.addEventListener("pointerdown", (event) => event.stopPropagation());
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        tool(keep ? "sticky_idea_accept" : "sticky_idea_reject", { id }).then(() => load()).catch((err) => say(err.message));
      });
      row.append(button);
    });
    return row;
  }

  // The mascot from the top of the app, copied. Tiny and Brain are drawn elsewhere, so they get a stand-in.
  function helperFace() {
    const source = document.getElementById("claudeMark");
    if (source?.querySelector(".critter")) {
      const face = source.cloneNode(true);
      face.removeAttribute("id");
      return face;
    }
    return el("span", "stick-helper-emoji", "💡");
  }

  // One suggestion at a time: a combined note first, then changes to your notes, then new ideas.
  // Shows with brainstorm off too, since two notes can be combined on any board.
  function drawHelper() {
    if (!ui.helper) return;
    const proposals = ui.data?.proposals || [];
    const merges = proposals.filter((item) => item.kind === "merge").map((item) => ({ kind: "merge", item }));
    const changes = proposals.filter((item) => item.kind !== "merge").map((item) => ({ kind: "edit", item }));
    const ideas = (ui.data?.notes || []).filter((note) => note.idea).map((item) => ({ kind: "idea", item }));
    const next = [...merges, ...changes, ...ideas][0];
    const left = merges.length + changes.length + ideas.length;
    if (ui.view !== "board" || (!next && !ui.thinking && !ui.helperNote)) {
      ui.helper.hidden = true;
      return;
    }
    const noteText = (id) => {
      const note = (ui.data?.notes || []).find((item) => item.id === id);
      return note ? `${note.title ? `${note.title}: ` : ""}${strip(note.content)}` : "(gone)";
    };
    const bubble = el("div", "stick-helper-bubble");
    if (next?.kind === "merge") {
      bubble.append(el("p", "", "Combine these two notes?"));
      bubble.append(el("blockquote", "stick-helper-part", noteText(next.item.fromId)));
      bubble.append(el("p", "stick-helper-sign", "+"));
      bubble.append(el("blockquote", "stick-helper-part", noteText(next.item.noteId)));
      bubble.append(el("p", "stick-helper-sign", "="));
      bubble.append(el("blockquote", "", `${next.item.title ? `${next.item.title}: ` : ""}${strip(next.item.content)}`));
      bubble.append(el("p", "stick-helper-why", "Yes keeps the combined note and moves the dragged one to the trash."));
      bubble.append(ideaButtons(next.item.id));
    } else if (next?.kind === "edit") {
      const target = (ui.data?.notes || []).find((note) => note.id === next.item.noteId);
      const shorter = next.item.kind === "shorten";
      bubble.append(el("p", "", `${shorter ? "Shorten" : "Change"} “${target?.title || strip(target?.content || "").slice(0, 40) || "this note"}”?`));
      bubble.append(el("p", "stick-helper-sign", "Before"));
      bubble.append(el("blockquote", "stick-helper-part", strip(target?.content || "")));
      bubble.append(el("p", "stick-helper-sign", "After"));
      bubble.append(el("blockquote", "", strip(next.item.content)));
      if (next.item.reason) bubble.append(el("p", "stick-helper-why", next.item.reason));
      bubble.append(ideaButtons(next.item.id));
    } else if (next) {
      bubble.append(el("p", "", "Add this idea?"));
      bubble.append(el("blockquote", "", strip(next.item.content) || next.item.title));
      bubble.append(ideaButtons(next.item.id));
    } else bubble.append(el("p", "", ui.thinking ? (ui.thinkingWhat || "Thinking of ideas…") : ui.helperNote));
    if (left > 1) {
      bubble.append(el("p", "stick-helper-why", `${left - 1} more after this one.`));
      const all = el("div", "stick-helper-all");
      [["Keep all", "sticky_idea_accept_all"], ["Drop all", "sticky_idea_reject_all"]].forEach(([label, name]) => {
        const button = el("button", "ghost-btn small", label);
        button.type = "button";
        button.addEventListener("click", () => tool(name, {}).then(() => load()).catch((err) => say(err.message)));
        all.append(button);
      });
      bubble.append(all);
    }
    ui.helper.replaceChildren(helperFace(), bubble);
    ui.helper.classList.toggle("is-thinking", Boolean(ui.thinking && !next));
    ui.helper.hidden = false;
    if (next?.kind === "idea") ui.board.querySelector(`[data-id="${next.item.id}"]`)?.classList.add("is-asking");
    if (next?.kind === "merge") [next.item.fromId, next.item.noteId].forEach((id) => ui.board.querySelector(`[data-id="${id}"]`)?.classList.add("is-proposed"));
  }

  function taskRow(note) {
    const row = el("div", "stick-task");
    const box = el("input");
    box.type = "checkbox";
    box.checked = note.taskStatus === "done";
    box.setAttribute("aria-label", `Mark ${note.title || "task"} done`);
    box.addEventListener("change", () => savePatch(note.id, { taskStatus: box.checked ? "done" : "open" }));
    const text = el("div");
    text.append(el("strong", "", note.title || "Untitled"), el("p", "", strip(note.content)));
    row.append(box, text, starButton(note));
    if (note.dueAt) row.append(el("span", "sticky-badge", note.dueAt.slice(0, 10)));
    return row;
  }

  function strip(html) {
    const node = el("div");
    node.innerHTML = html || "";
    return node.textContent || "";
  }

  function select(id) {
    ui.selected = id;
    ui.board.querySelectorAll(".sticky").forEach((card) => card.classList.toggle("is-selected", card.dataset.id === id));
  }

  function startDrag(event, card, note) {
    if (event.button != null && event.button !== 0) return;
    if (board().layout === "organized" || ui.view !== "board") return;
    select(note.id);
    event.stopPropagation();
    const startX = event.clientX;
    const startY = event.clientY;
    let x = null;
    let y = null;
    const move = (ev) => {
      x = note.positionX + (ev.clientX - startX) / ui.zoom;
      y = note.positionY + (ev.clientY - startY) / ui.zoom;
      card.style.left = `${x}px`;
      card.style.top = `${y}px`;
    };
    // Listen on the window, so a fast move or a release off the card still lands.
    const up = (ev) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (x == null) return;
      note.positionX = x;
      note.positionY = y;
      // Let go over another note: the move stays, and the mascot offers to combine the two.
      const under = document.elementsFromPoint(ev.clientX, ev.clientY).find((node) => node.classList?.contains("sticky") && node !== card);
      savePatch(note.id, { x, y }).then(() => {
        if (under?.dataset.id) return tool("sticky_note_combine", { id: note.id, intoId: under.dataset.id }).then(() => load());
        return null;
      }).catch((err) => say(err.message));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  function startResize(event, card, note) {
    event.stopPropagation();
    event.preventDefault();
    const startX = event.clientX;
    const startY = event.clientY;
    let width = 0;
    let height = 0;
    const move = (ev) => {
      width = Math.max(140, note.width + (ev.clientX - startX) / ui.zoom);
      height = Math.max(120, note.height + (ev.clientY - startY) / ui.zoom);
      card.style.width = `${width}px`;
      card.style.height = `${height}px`;
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (!width) return;
      note.width = width;
      note.height = height;
      savePatch(note.id, { width, height });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  // current is the text on screen. past and future hold the text before and after it.
  function undoStack(id) {
    if (!ui.undo.has(id)) ui.undo.set(id, { past: [], future: [], current: "" });
    return ui.undo.get(id);
  }

  function rememberUndo(id, html) {
    const stack = undoStack(id);
    stack.past = [...stack.past, stack.current].slice(-30);
    stack.future = [];
    stack.current = html;
  }

  function undo(id, redo) {
    const stack = undoStack(id);
    const content = redo ? stack.future.pop() : stack.past.pop();
    if (content == null) return;
    (redo ? stack.past : stack.future).push(stack.current);
    stack.current = content;
    const body = ui.board.querySelector(`[data-id="${id}"] .sticky-body`);
    if (body) body.innerHTML = content;
    scheduleSave(id, content, 0);
  }

  // The board copy is updated at once, so a redraw before the save lands still shows the latest typing.
  function scheduleSave(id, content, wait = 400, field = "content") {
    const note = (ui.data?.notes || []).find((item) => item.id === id);
    if (note) note[field] = content;
    clearTimeout(ui.timers.get(`${id}:${field}`));
    ui.timers.set(`${id}:${field}`, setTimeout(() => savePatch(id, { [field]: content }), wait));
  }

  async function savePatch(id, body) {
    try {
      const response = await fetch(`/stickies/notes/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await response.json().catch(() => ({}));
      if (response.status === 409) {
        if (body.content != null) localStorage.setItem(`stickies-draft-${id}`, body.content);
        say("That note changed somewhere else. Your typing is kept on this Mac.");
        ui.data.notes = ui.data.notes.map((note) => note.id === id ? data.note : note);
        return;
      }
      if (!response.ok) throw new Error(data.error || "Could not save that note.");
      localStorage.removeItem(`stickies-draft-${id}`);
      ui.data.notes = (ui.data.notes || []).map((note) => note.id === id ? data.note : note);
      if (data.note.deletedAt) ui.data.trash = [...(ui.data.trash || []).filter((note) => note.id !== id), data.note];
      if (!document.activeElement?.closest?.(`[data-id="${id}"]`)) draw();
      say("Saved.");
    } catch (err) {
      console.error("Failed while saving a sticky note:", err);
      if (body.content != null) localStorage.setItem(`stickies-draft-${id}`, body.content);
      say(err.message || "Could not save that note.");
    }
  }

  async function tool(name, args) {
    const response = await fetch("/stickies/tool", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, args }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok && !data.status) throw new Error(data.error || "Could not do that.");
    return data;
  }

  async function createAt(x, y, color) {
    const mode = prefs().defaultColorMode;
    if (mode === "ask" && !color) {
      askColor(x, y);
      return;
    }
    const response = await fetch("/stickies/notes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ x, y, color: color || "", content: "" }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Could not add a note.");
    ui.selected = data.note.id;
    await load();
    ui.board.querySelector(`[data-id="${data.note.id}"] .sticky-body`)?.focus();
  }

  function askColor(x, y) {
    const row = el("div", "stick-ask");
    COLORS.forEach((color) => {
      const dot = el("button", "stick-dot");
      dot.type = "button";
      dot.style.background = paper(color);
      dot.setAttribute("aria-label", color);
      dot.addEventListener("click", () => {
        row.remove();
        createAt(x, y, color).catch((err) => say(err.message));
      });
      row.append(dot);
    });
    row.style.left = `${(x ?? 80) * ui.zoom + ui.panX}px`;
    row.style.top = `${(y ?? 80) * ui.zoom + ui.panY}px`;
    ui.stage.append(row);
  }

  function paper(color) {
    return { yellow: "#ffe56a", pink: "#ffb3c7", blue: "#a8d4ff", green: "#b6f0c2", orange: "#ffd0a1", purple: "#ddc6ff", white: "#fffdf8", gray: "#e6e6e6" }[color] || "#ffe56a";
  }

  function boardPoint(event) {
    const rect = ui.board.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) / (board().layout === "organized" ? 1 : ui.zoom),
      y: (event.clientY - rect.top) / (board().layout === "organized" ? 1 : ui.zoom),
    };
  }

  function openMenu(x, y, items) {
    ui.menu.replaceChildren();
    items.forEach((item) => {
      if (item.colors) {
        const row = el("div", "stick-colors");
        COLORS.forEach((color) => {
          const dot = el("button", "stick-dot");
          dot.type = "button";
          dot.style.background = paper(color);
          dot.setAttribute("aria-label", color);
          dot.addEventListener("click", () => {
            ui.menu.hidden = true;
            item.colors(color);
          });
          row.append(dot);
        });
        ui.menu.append(row);
        return;
      }
      const button = el("button", item.danger ? "danger" : "", item.label);
      button.type = "button";
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        ui.menu.hidden = true;
        item.action();
      });
      ui.menu.append(button);
    });
    ui.menuAt = [x, y];
    placeMenu(x, y);
  }

  // Keep the whole menu on screen, measured after it is filled.
  function placeMenu(x, y) {
    ui.menu.hidden = false;
    const { width, height } = ui.menu.getBoundingClientRect();
    ui.menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - width - 8))}px`;
    ui.menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - height - 8))}px`;
  }

  function noteMenu(note) {
    return [
      { label: "Edit", action: () => ui.board.querySelector(`[data-id="${note.id}"] .sticky-body`)?.focus() },
      { colors: (color) => savePatch(note.id, { color }) },
      { label: "Handwriting", action: () => savePatch(note.id, { fontStyle: "hand" }) },
      { label: "Typing", action: () => savePatch(note.id, { fontStyle: "type" }) },
      { label: "Add link", action: () => addLink(note) },
      { label: "Link to a note", action: () => linkNote(note) },
      { label: "Copy note link", action: () => navigator.clipboard.writeText(`sticky:${note.id}`).then(() => say("Copied the link.")) },
      { label: "Add a check", action: () => savePatch(note.id, { checklist: [...(note.checklist || []), { text: "New item", done: false }] }) },
      { label: note.noteType === "task" ? "Make a note again" : "Convert to to-do", action: () => tool(note.noteType === "task" ? "sticky_note_convert_to_note" : "sticky_note_convert_to_task", { id: note.id }).then(() => load()) },
      { label: "Set reminder", action: () => remind(note) },
      { label: note.isPinned ? "Unpin" : "Pin", action: () => savePatch(note.id, { isPinned: !note.isPinned }).then(load) },
      { label: "Duplicate", action: () => duplicate(note) },
      { label: "Summarize this note", action: () => tool("sticky_note_summarize", { id: note.id }).then((made) => { if (made.error) say(made.error); return load(); }) },
      { label: "Branch ideas from this", action: () => tool("sticky_idea_branch", { id: note.id }).then(() => load()) },
      { label: "More like this", action: () => tool("sticky_idea_more", { id: note.id }).then(() => load()) },
      { label: "Draw", action: () => { ui.drawing = true; ui.selected = note.id; draw(); } },
      { label: note.archivedAt || note.deletedAt ? "Restore" : "Archive", action: () => tool(note.archivedAt || note.deletedAt ? "sticky_note_restore" : "sticky_note_archive", { id: note.id }).then(() => load()) },
      { label: "Delete", danger: true, action: () => confirmDelete(note) },
    ];
  }

  // The app window (WebKit via wry) has no prompt() or confirm(), so questions open in the menu.
  function askIn(label, input, okText = "OK") {
    return new Promise((resolve) => {
      const [x, y] = ui.menuAt || [ui.stage.clientWidth / 2, ui.stage.clientHeight / 2];
      ui.menu.replaceChildren();
      const form = el("form", "stick-askform");
      const ok = el("button", "", okText);
      ok.type = "submit";
      const cancel = el("button", "", "Cancel");
      cancel.type = "button";
      const done = (value) => {
        ui.menu.hidden = true;
        resolve(value);
      };
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        done(input ? input.value : true);
      });
      cancel.addEventListener("click", () => done(null));
      form.append(el("span", "", label));
      if (input) form.append(input);
      form.append(ok, cancel);
      ui.menu.append(form);
      placeMenu(x, y);
      (input || ok).focus();
    });
  }

  async function addLink(note) {
    const picked = window.getSelection()?.toString() || "link";
    const field = el("input");
    field.type = "url";
    field.value = "https://";
    const href = await askIn("Link address", field);
    if (!href) return;
    const html = `${note.content || ""} <a href="${href.replace(/"/g, "")}">${picked}</a>`;
    savePatch(note.id, { content: html });
  }

  async function linkNote(note) {
    const others = notes().filter((item) => item.id !== note.id);
    if (!others.length) return say("There is no other note to link.");
    const field = el("select");
    others.forEach((item) => {
      const option = el("option", "", item.title || strip(item.content).slice(0, 40) || "Untitled");
      option.value = item.id;
      field.append(option);
    });
    const toId = await askIn("Link to", field, "Link");
    if (!toId) return;
    tool("sticky_note_link", { fromId: note.id, toId }).then(() => {
      say("Linked.");
      load();
    });
  }

  async function remind(note) {
    const field = el("input");
    field.type = "datetime-local";
    if (note.reminderAt) {
      const at = new Date(note.reminderAt);
      field.value = new Date(at.getTime() - at.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    }
    const value = await askIn("Remind me at (empty clears it)", field, "Save");
    if (value == null) return;
    tool("sticky_note_set_reminder", { id: note.id, reminderAt: value ? new Date(value).toISOString() : null }).then(() => load());
  }

  async function duplicate(note) {
    await fetch("/stickies/notes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...note, id: undefined, x: note.positionX + 24, y: note.positionY + 24, title: note.title }),
    });
    load();
  }

  async function confirmDelete(note) {
    const yes = await askIn(`Move “${note.title || "this note"}” to the trash?`, null, "Move to trash");
    if (!yes) return;
    tool("sticky_note_delete", { id: note.id, confirm: true }).then(() => load());
  }

  function drawStrokes(canvas, strokes) {
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = "#2a2416";
    ctx.lineWidth = 2;
    for (const stroke of strokes) {
      ctx.beginPath();
      (stroke.points || []).forEach((point, index) => {
        const x = point[0] * canvas.width;
        const y = point[1] * canvas.height;
        if (index === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
    }
  }

  function stopDrawing() {
    ui.drawing = false;
    ui.board?.querySelectorAll(".sticky.is-draw").forEach((card) => card.classList.remove("is-draw"));
  }

  // Drawing stays on after each line. It ends on a double-click, or a click outside the note.
  function paint(canvas, note, card) {
    let points = [];
    let drawingStroke = false;
    const endStroke = () => {
      if (!drawingStroke) return;
      drawingStroke = false;
      if (points.length >= 2) {
        const strokes = [...(note.strokes || []), { id: String(Date.now()), points: points.slice() }];
        note.strokes = strokes;
        savePatch(note.id, { strokes });
      }
      points = [];
    };
    canvas.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      drawingStroke = true;
      try { canvas.setPointerCapture(event.pointerId); } catch (err) { /* the stroke still follows the canvas */ }
      points = [pointOf(event, canvas)];
    });
    canvas.addEventListener("pointermove", (event) => {
      if (!drawingStroke) return;
      points.push(pointOf(event, canvas));
      drawStrokes(canvas, [...(note.strokes || []), { points }]);
    });
    canvas.addEventListener("pointerup", endStroke);
    canvas.addEventListener("pointercancel", endStroke);
    card.addEventListener("dblclick", (event) => {
      if (!card.classList.contains("is-draw")) return;
      event.preventDefault();
      event.stopPropagation();
      drawingStroke = false;
      points = [];
      stopDrawing();
    });
  }

  function pointOf(event, canvas) {
    const rect = canvas.getBoundingClientRect();
    return [(event.clientX - rect.left) / rect.width, (event.clientY - rect.top) / rect.height];
  }

  // The green rectangle on the little map, in the map's own pixels.
  function mapBox() {
    const sx = ui.map.width / 3200;
    const sy = ui.map.height / 2400;
    const stage = ui.stage.getBoundingClientRect();
    return {
      sx,
      sy,
      x: -ui.panX / ui.zoom * sx,
      y: -ui.panY / ui.zoom * sy,
      w: stage.width / ui.zoom * sx,
      h: stage.height / ui.zoom * sy,
    };
  }

  function drawMap() {
    const ctx = ui.map.getContext("2d");
    ctx.clearRect(0, 0, ui.map.width, ui.map.height);
    const box = mapBox();
    ctx.fillStyle = "rgba(255,255,255,.85)";
    visible().forEach((note) => {
      ctx.fillRect(note.positionX * box.sx, note.positionY * box.sy, Math.max(4, note.width * box.sx), Math.max(3, note.height * box.sy));
    });
    ctx.fillStyle = "rgba(47, 198, 160, .35)";
    ctx.strokeStyle = "#2fc6a0";
    ctx.lineWidth = 2;
    ctx.fillRect(box.x, box.y, box.w, box.h);
    ctx.strokeRect(box.x, box.y, box.w, box.h);
  }

  // Turn a click on the little map into a spot on the big board.
  function boardFromMap(event) {
    const rect = ui.map.getBoundingClientRect();
    return {
      boardX: (event.clientX - rect.left) / rect.width * 3200,
      boardY: (event.clientY - rect.top) / rect.height * 2400,
    };
  }

  function mapPixel(event) {
    const rect = ui.map.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) / rect.width * ui.map.width,
      y: (event.clientY - rect.top) / rect.height * ui.map.height,
    };
  }

  // grabX/grabY is the spot inside the green box that the pointer is holding,
  // measured in board pixels. Moving the pointer keeps that same grip.
  let mapDrag = null;

  function panByGrab(boardX, boardY) {
    ui.panX = -(boardX - mapDrag.grabX) * ui.zoom;
    ui.panY = -(boardY - mapDrag.grabY) * ui.zoom;
    applyTransform();
    drawMap();
  }

  function pointerInBox(event) {
    const pixel = mapPixel(event);
    const box = mapBox();
    return pixel.x >= box.x - 4 && pixel.x <= box.x + box.w + 4
      && pixel.y >= box.y - 4 && pixel.y <= box.y + box.h + 4;
  }

  function zoomAt(next, px, py) {
    const zoom = Math.min(3, Math.max(0.25, next));
    const wx = (px - ui.panX) / ui.zoom;
    const wy = (py - ui.panY) / ui.zoom;
    ui.zoom = zoom;
    ui.panX = px - wx * zoom;
    ui.panY = py - wy * zoom;
    applyTransform();
    drawMap();
    scheduleBoard();
  }

  function fit() {
    const list = visible();
    if (!list.length) return;
    const minX = Math.min(...list.map((note) => note.positionX));
    const minY = Math.min(...list.map((note) => note.positionY));
    const maxX = Math.max(...list.map((note) => note.positionX + note.width));
    const maxY = Math.max(...list.map((note) => note.positionY + note.height));
    const rect = ui.stage.getBoundingClientRect();
    ui.zoom = Math.min(3, Math.max(0.25, Math.min((rect.width - 48) / (maxX - minX || 1), (rect.height - 48) / (maxY - minY || 1))));
    ui.panX = 24 - minX * ui.zoom;
    ui.panY = 24 - minY * ui.zoom;
    applyTransform();
    scheduleBoard();
  }

  // Board drawings live in an SVG over the notes. It moves and zooms with them,
  // and only catches the pointer while Draw is on.
  function freeform() {
    return board().layout !== "organized" && ui.view === "board";
  }

  function inkShape(stroke) {
    const style = (node) => {
      node.setAttribute("stroke", stroke.color);
      node.setAttribute("stroke-width", String(stroke.size));
      node.setAttribute("stroke-linecap", "round");
      node.setAttribute("stroke-linejoin", "round");
      node.setAttribute("fill", "none");
      return node;
    };
    const pts = stroke.points;
    if (stroke.tool === "pen") {
      const path = style(document.createElementNS(SVG, "path"));
      path.setAttribute("d", pts.map((p, i) => `${i ? "L" : "M"}${p[0]} ${p[1]}`).join(" "));
      return path;
    }
    const group = document.createElementNS(SVG, "g");
    const [a, b] = [pts[0], pts[pts.length - 1]];
    const line = style(document.createElementNS(SVG, "line"));
    line.setAttribute("x1", a[0]); line.setAttribute("y1", a[1]);
    line.setAttribute("x2", b[0]); line.setAttribute("y2", b[1]);
    group.append(line);
    if (stroke.tool === "arrow") {
      // Two short lines back from the tip, 28 degrees either side.
      const angle = Math.atan2(b[1] - a[1], b[0] - a[0]);
      const len = stroke.size * 3 + 10;
      const wing = (turn) => [b[0] - len * Math.cos(angle + turn), b[1] - len * Math.sin(angle + turn)];
      const [l, r] = [wing(0.49), wing(-0.49)];
      const head = style(document.createElementNS(SVG, "path"));
      head.setAttribute("d", `M${l[0]} ${l[1]} L${b[0]} ${b[1]} L${r[0]} ${r[1]}`);
      group.append(head);
    }
    return group;
  }

  function drawInk() {
    if (!ui.inkLayer) return;
    ui.inkLayer.style.display = freeform() ? "" : "none";
    const strokes = [...(board().ink || []), ...(ui.ink.live ? [ui.ink.live] : [])];
    ui.inkLayer.replaceChildren(...strokes.map(inkShape));
    ui.stage.classList.toggle("is-inking", ui.ink.on && freeform());
    ui.inkBar.hidden = !(ui.ink.on && freeform());
    ui.inkBar.querySelectorAll("[data-tool]").forEach((button) => button.classList.toggle("is-on", button.dataset.tool === ui.ink.tool));
    ui.inkBtn.classList.toggle("is-on", ui.ink.on);
    ui.inkBtn.setAttribute("aria-pressed", ui.ink.on ? "true" : "false");
  }

  function inkPoint(event) {
    const rect = ui.world.getBoundingClientRect();
    return [(event.clientX - rect.left) / ui.zoom, (event.clientY - rect.top) / ui.zoom];
  }

  function saveInk(ink) {
    board().ink = ink;
    drawInk();
    fetch("/stickies/board", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ boardId: board().id, ink }),
    }).then((response) => { if (!response.ok) say("Could not save the drawing."); })
      .catch(() => say("Could not save the drawing."));
  }

  /** Strokes that pass within reach of the point (board units). */
  function inkNear(point, reach) {
    const near = (p, a, b) => {
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const t = dx || dy ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy))) : 0;
      return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
    };
    return (board().ink || []).filter((stroke) => stroke.points.some((p, i) => i > 0 && near(point, stroke.points[i - 1], p) <= reach + stroke.size / 2));
  }

  function startInk(event) {
    if (!ui.ink.on || !freeform() || event.button > 0) return;
    event.preventDefault();
    event.stopPropagation();
    try { ui.inkLayer.setPointerCapture(event.pointerId); } catch (err) { /* the pointer can already be gone */ }
    const first = inkPoint(event);
    let erased = false;
    const erase = (point) => {
      const hit = inkNear(point, 8 / ui.zoom);
      if (!hit.length) return;
      board().ink = board().ink.filter((stroke) => !hit.includes(stroke));
      erased = true;
      drawInk();
    };
    if (ui.ink.tool === "eraser") erase(first);
    else ui.ink.live = { tool: ui.ink.tool, color: ui.ink.color, size: ui.ink.size, points: [first, first] };
    const move = (ev) => {
      const point = inkPoint(ev);
      if (ui.ink.tool === "eraser") return erase(point);
      if (ui.ink.tool === "pen") ui.ink.live.points.push(point);
      else ui.ink.live.points = [first, point];
      drawInk();
    };
    const up = () => {
      ui.inkLayer.removeEventListener("pointermove", move);
      ui.inkLayer.removeEventListener("pointerup", up);
      ui.inkLayer.removeEventListener("pointercancel", up);
      const done = ui.ink.live;
      ui.ink.live = null;
      if (erased) saveInk(board().ink);
      else if (done) {
        const [a, b] = [done.points[0], done.points[done.points.length - 1]];
        // A click without a drag leaves nothing.
        if (done.points.length > 2 || Math.hypot(b[0] - a[0], b[1] - a[1]) > 2) saveInk([...(board().ink || []), done]);
        else drawInk();
      }
    };
    ui.inkLayer.addEventListener("pointermove", move);
    ui.inkLayer.addEventListener("pointerup", up);
    ui.inkLayer.addEventListener("pointercancel", up);
  }

  function inkBar() {
    const bar = el("div", "stick-inkbar");
    bar.hidden = true;
    [["pen", "✎ Pen"], ["line", "╱ Line"], ["arrow", "↗ Arrow"], ["eraser", "⌫ Eraser"]].forEach(([name, label]) => {
      const button = el("button", "ghost-btn small", label);
      button.type = "button";
      button.dataset.tool = name;
      button.addEventListener("click", () => { ui.ink.tool = name; drawInk(); });
      bar.append(button);
    });
    const color = el("input");
    color.type = "color";
    color.value = ui.ink.color;
    color.setAttribute("aria-label", "Pen color");
    color.addEventListener("input", () => { ui.ink.color = color.value; if (ui.ink.tool === "eraser") ui.ink.tool = "pen"; drawInk(); });
    const size = selectOf(["2", "4", "8", "14"], String(ui.ink.size));
    size.setAttribute("aria-label", "Line thickness");
    size.addEventListener("change", () => { ui.ink.size = Number(size.value); });
    const clear = el("button", "ghost-btn small danger", "Clear all");
    clear.type = "button";
    clear.addEventListener("click", (event) => {
      event.stopPropagation();
      if (!(board().ink || []).length) return say("Nothing is drawn on this board.");
      openMenu(event.clientX, event.clientY, [
        { label: "Clear every drawing on this board", danger: true, action: () => { saveInk([]); say("Cleared the drawings."); } },
        { label: "Keep them", action: () => {} },
      ]);
    });
    const done = el("button", "ghost-btn small", "Done");
    done.type = "button";
    done.addEventListener("click", () => { ui.ink.on = false; drawInk(); });
    bar.append(color, size, clear, done);
    return bar;
  }

  /**
   * A copy of the board as drawn, cropped to the notes and drawings, for a picture export.
   * Typed titles, ticks and note drawings are not in the HTML, so they are written in.
   */
  function snapshot() {
    const copy = ui.world.cloneNode(true);
    const pairs = (selector) => [...ui.world.querySelectorAll(selector)].map((node, i) => [node, copy.querySelectorAll(selector)[i]]);
    pairs("input").forEach(([live, dead]) => {
      if (live.type === "checkbox") dead.toggleAttribute("checked", live.checked);
      else dead.setAttribute("value", live.value);
    });
    pairs("canvas").forEach(([live, dead]) => {
      const img = document.createElement("img");
      img.className = live.className;
      img.src = live.toDataURL("image/png");
      dead.replaceWith(img);
    });
    copy.querySelectorAll(".sticky.is-idea, .sticky-resize, .sticky-more, .sticky-lock, .stick-yes, .stick-no").forEach((node) => node.remove());
    copy.querySelectorAll(".is-selected, .is-proposed").forEach((node) => node.classList.remove("is-selected", "is-proposed"));
    const scale = freeform() ? ui.zoom : 1;
    const origin = ui.board.getBoundingClientRect();
    const boxes = [...ui.board.querySelectorAll(".sticky:not(.is-idea)")].map((card) => {
      const rect = card.getBoundingClientRect();
      return [(rect.left - origin.left) / scale, (rect.top - origin.top) / scale, (rect.right - origin.left) / scale, (rect.bottom - origin.top) / scale];
    });
    if (freeform()) (board().ink || []).forEach((stroke) => stroke.points.forEach(([x, y]) => boxes.push([x - stroke.size, y - stroke.size, x + stroke.size, y + stroke.size])));
    if (!boxes.length) throw new Error("This board is empty, so there is nothing to picture.");
    const pad = 40;
    const left = Math.max(0, Math.min(...boxes.map((b) => b[0])) - pad);
    const top = Math.max(0, Math.min(...boxes.map((b) => b[1])) - pad);
    const width = Math.ceil(Math.max(...boxes.map((b) => b[2])) + pad - left);
    const height = Math.ceil(Math.max(...boxes.map((b) => b[3])) + pad - top);
    copy.style.transform = "none";
    copy.style.position = "absolute";
    copy.style.left = `${-left}px`;
    copy.style.top = `${-top}px`;
    const frame = el("div");
    frame.style.cssText = `position:relative;overflow:hidden;width:${width}px;height:${height}px`;
    frame.append(copy);
    const css = [...document.styleSheets].map((sheet) => sheet.href).filter(Boolean);
    return { html: frame.outerHTML, width, height, css, appearance: ui.root.dataset.appearance };
  }

  async function exportBoard(format) {
    say("Exporting…");
    const body = { format };
    if (format === "jpg" || format === "image-pdf") body.snapshot = snapshot();
    const response = await fetch("/stickies/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Could not export the board.");
    say(`Saved ${data.name} in Downloads.`);
  }

  // Things done to the whole board: from the Board button and a right-click on the bare board.
  function boardMenu(point) {
    const run = (name, args = {}, after = "") => () => tool(name, args)
      .then((made) => { if (made.error) say(made.error); else if (after) say(after); return load(); })
      .catch((err) => say(err.message));
    return [
      { label: "New note", action: () => createAt(point?.x, point?.y) },
      { label: "Paste a list…", action: () => pasteList(point) },
      { label: "Summarize this board", action: run("sticky_board_summary", {}, "Summing up…") },
      { label: "Turn board into a plan", action: run("sticky_board_plan", {}, "Planning…") },
      { label: "Ideas from my files", action: run("sticky_ideas_from_files", {}, "Reading your files…") },
      { label: "Import a web page…", action: () => importPage() },
      { label: "New board from template…", action: () => templateBoard() },
    ];
  }

  // One note per line. Bullets and numbers at the start of a line are dropped.
  async function pasteList(point, text = "") {
    const box = el("textarea");
    box.rows = 6;
    box.placeholder = "One note per line";
    box.value = text;
    const lines = await askIn("Paste a list", box, "Make notes");
    if (!lines) return;
    const made = await tool("sticky_note_create_many", { text: lines, x: point?.x, y: point?.y });
    if (made.error) say(made.error);
    else say(`Made ${made.notes.length} notes.`);
    await load();
  }

  // A GitHub repo, a paper, or any article becomes up to ten notes plus one with the link.
  async function importPage(url = "") {
    let address = url;
    if (!address) {
      const box = el("input");
      box.type = "url";
      box.placeholder = "https://github.com/… or a paper";
      box.style.width = "260px";
      address = await askIn("Import a web page", box, "Import");
    }
    if (!address) return;
    const made = await tool("sticky_import_url", { url: address });
    if (made.error) say(made.error);
    else say("Reading the page…");
    await load();
  }

  async function templateBoard() {
    const pick = selectOf(["swot", "proscons", "eisenhower", "week"], "swot", { swot: "SWOT", proscons: "Pros and cons", eisenhower: "Urgent and important", week: "Week" });
    const template = await askIn("New board from", pick, "Create");
    if (!template) return;
    const made = await tool("sticky_board_template", { template });
    if (made.error) say(made.error);
    await load();
    fit();
  }

  // Ideas you dropped on this board, to bring back.
  function droppedMenu() {
    const list = board().brainstorm?.rejected || [];
    if (!list.length) return [{ label: "Nothing dropped yet", action: () => {} }];
    return list.slice().reverse().map((text) => ({
      label: `↩ ${text.length > 60 ? `${text.slice(0, 57)}…` : text}`,
      action: () => tool("sticky_idea_restore", { text }).then(() => load()).catch((err) => say(err.message)),
    }));
  }

  function exportMenu() {
    const run = (format) => () => exportBoard(format).catch((err) => say(err.message));
    return [
      { label: "Text: Markdown (.md)", action: run("md") },
      { label: "Text: Word (.docx)", action: run("docx") },
      { label: "Text: PDF", action: run("pdf") },
      { label: "Picture: JPEG", action: run("jpg") },
      { label: "Picture: PDF", action: run("image-pdf") },
    ];
  }

  // Shown while the board is brainstorming: what matters, how bold to be, and two whole-board rounds.
  function brainBar() {
    const bar = el("div", "stick-brainbar");
    bar.hidden = true;
    const brief = el("input");
    brief.type = "text";
    brief.placeholder = "What matters: budget, deadline, audience…";
    brief.setAttribute("aria-label", "What the ideas should keep in mind");
    brief.addEventListener("change", () => saveBoard({ brief: brief.value }).catch((err) => say(err.message)));
    ui.briefBox = brief;
    const wildWrap = el("label", "stick-wild");
    const wild = el("input");
    wild.type = "range";
    wild.min = "0";
    wild.max = "100";
    wild.step = "10";
    wild.setAttribute("aria-label", "Practical to wild");
    wild.addEventListener("change", () => saveBoard({ wild: Number(wild.value) }).catch((err) => say(err.message)));
    ui.wildBox = wild;
    wildWrap.append(el("span", "", "Practical"), wild, el("span", "", "Wild"));
    const round = (label, name, title) => {
      const button = el("button", "ghost-btn small", label);
      button.type = "button";
      button.title = title;
      button.addEventListener("click", () => tool(name, {}).then((made) => { if (made.error) say(made.error); return load(); }).catch((err) => say(err.message)));
      return button;
    };
    // Themes is a switch: on sorts the board into theme groups, off is the free board again (the tags stay).
    const themes = el("button", "ghost-btn small", "Sort into themes");
    themes.type = "button";
    themes.title = "Tag the kept notes by theme and group the board by those tags. Click again for the free board.";
    ui.themesBtn = themes;
    themes.addEventListener("click", () => {
      if (board().group === "hashtag") return saveBoard({ group: "", layout: "freeform" }).catch((err) => say(err.message));
      return tool("sticky_brainstorm_themes", {}).then((made) => { if (made.error) say(made.error); return load(); }).catch((err) => say(err.message));
    });
    // Greyed out until the board is sorted into themes and a theme has two notes to merge.
    const consolidate = el("button", "ghost-btn small", "Consolidate");
    consolidate.type = "button";
    consolidate.disabled = true;
    consolidate.title = "One note per theme, with the old notes written on its back. Sort into themes first.";
    ui.consolidateBtn = consolidate;
    consolidate.addEventListener("click", () => tool("sticky_brainstorm_consolidate", {})
      .then((made) => { if (made.error) say(made.error); return load(); }).catch((err) => say(err.message)));
    const dropped = el("button", "ghost-btn small", "Dropped");
    dropped.type = "button";
    dropped.title = "Ideas you said no to on this board. Click one to bring it back.";
    ui.droppedBtn = dropped;
    dropped.addEventListener("click", (event) => {
      event.stopPropagation();
      const rect = dropped.getBoundingClientRect();
      openMenu(rect.left, rect.bottom + 4, droppedMenu());
    });
    bar.append(
      brief, wildWrap,
      round("Poke holes", "sticky_brainstorm_challenge", "One pink note under each kept note with its biggest risk or open question"),
      themes, consolidate, dropped,
    );
    return bar;
  }

  function scheduleBoard() {
    clearTimeout(ui.timers.get("board"));
    // Remember which board was moved, in case another board opens before this saves.
    const boardId = board().id;
    const view = { zoom: ui.zoom, panX: ui.panX, panY: ui.panY };
    ui.timers.set("board", setTimeout(() => {
      fetch("/stickies/board", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ boardId, ...view }),
      }).catch((err) => console.error("Failed while saving the board view:", err));
    }, 300));
  }

  async function saveBoard(patch) {
    const response = await fetch("/stickies/board", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Could not save the board.");
    await load();
  }

  async function deleteBoard() {
    const current = board();
    // The server counts the notes, archived ones too, and words the question.
    const asked = await tool("sticky_board_delete", { boardId: current.id });
    if (asked.status !== "confirm") return say(asked.error || "Could not delete that board.");
    const yes = await askIn(asked.error, null, "Delete board");
    await tool("sticky_note_cancel", {});
    if (!yes) return;
    const made = await tool("sticky_board_delete", { boardId: current.id, confirm: true });
    say(made.ok ? `Deleted the ${current.name} board.` : made.error);
    await load();
  }

  async function savePrefs(patch) {
    const response = await fetch("/stickies/prefs", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Could not save those settings.");
    await load();
  }

  function settingsPanel() {
    const box = el("form", "stick-settings");
    box.hidden = true;
    box.append(el("h3", "", "This board"));
    const name = el("input");
    name.value = board().name || "";
    name.maxLength = 60;
    box.append(labeled("Name", name));
    const background = selectOf(["wood", "cork", "darkwood", "white", "black", "gray", "color", "image"], board().background);
    const appearance = selectOf(["system", "light", "dark"], prefs().appearance);
    const font = selectOf(["hand", "type"], prefs().fontStyle);
    const corners = selectOf(["round", "square"], prefs().corners);
    const pin = selectOf(["pin", "tape", "none"], prefs().pinStyle);
    const colorMode = selectOf(["last", "fixed", "ask", "auto"], prefs().defaultColorMode);
    box.append(
      labeled("Background", background),
      labeled("Appearance", appearance),
      labeled("Writing", font),
      labeled("Corners", corners),
      labeled("Pin", pin),
      labeled("New note color", colorMode),
    );
    const shadow = el("input");
    shadow.type = "range";
    shadow.min = "0.15";
    shadow.max = "1";
    shadow.step = "0.05";
    shadow.value = String(prefs().shadow ?? 0.55);
    box.append(labeled("Shadow", shadow));
    const meanings = ui.data?.colorMeanings || {};
    COLORS.forEach((color) => {
      const input = el("input");
      input.value = meanings[color] || "";
      input.dataset.color = color;
      box.append(labeled(`${color} means`, input));
    });
    const swatch = el("input");
    swatch.type = "color";
    swatch.value = board().backgroundColor || "#c4a574";
    box.append(labeled("Custom color", swatch));
    const file = el("input");
    file.type = "file";
    file.accept = "image/*";
    file.addEventListener("change", () => {
      const image = file.files?.[0];
      if (!image) return;
      const reader = new FileReader();
      reader.onload = () => saveBoard({ background: "image", backgroundImage: String(reader.result || "") }).catch((err) => say(err.message));
      reader.readAsDataURL(image);
    });
    box.append(labeled("Background photo", file));
    const save = el("button", "ghost-btn", "Save settings");
    save.type = "button";
    box.append(save);
    if ((ui.data?.boards || []).length > 1) {
      const remove = el("button", "ghost-btn danger", "Delete this board");
      remove.type = "button";
      remove.addEventListener("click", () => {
        box.remove();
        if (ui.settings === box) ui.settings = null;
        deleteBoard().catch((err) => say(err.message));
      });
      box.append(remove);
    }
    box.append(el("p", "stick-hint", "Light or dark applies to every board. The rest is for this board only."));
    box.addEventListener("submit", (event) => event.preventDefault());
    save.addEventListener("click", async () => {
      const colorMeanings = {};
      box.querySelectorAll("input[data-color]").forEach((input) => { colorMeanings[input.dataset.color] = input.value; });
      const saved = {
        prefs: {
          appearance: appearance.value,
          fontStyle: font.value,
          corners: corners.value,
          pinStyle: pin.value,
          defaultColorMode: colorMode.value,
          shadow: Number(shadow.value),
        },
        colorMeanings,
        background: background.value,
        backgroundColor: swatch.value,
        name: name.value.trim() || board().name,
      };
      // Close first, so the panel is gone even while the save is still finishing.
      box.remove();
      if (ui.settings === box) ui.settings = null;
      try {
        await savePrefs({ prefs: saved.prefs, colorMeanings: saved.colorMeanings });
        await saveBoard({ name: saved.name, background: saved.background, backgroundColor: saved.backgroundColor });
        say("Settings saved.");
      } catch (err) {
        console.error("Failed while saving sticky-note settings:", err);
        say("Could not save those settings.");
      }
    });
    return box;
  }

  function selectOf(values, current, labels = {}) {
    const node = el("select");
    values.forEach((value) => {
      const option = el("option", "", labels[value] || value || "none");
      option.value = value;
      if (value === current) option.selected = true;
      node.append(option);
    });
    return node;
  }

  function labeled(text, input) {
    const wrap = el("label");
    wrap.append(el("span", "", text), input);
    return wrap;
  }

  function build() {
    const root = el("section", "panel stickies-panel");
    root.hidden = true;
    root.setAttribute("aria-label", "Sticky notes");
    const bar = el("div", "stick-bar");
    ui.status = el("span", "stick-status", "");
    const add = el("button", "ghost-btn stick-new", "+ New note");
    add.type = "button";
    // No position: the server staggers new notes so they do not stack.
    add.addEventListener("click", () => createAt().catch((err) => say(err.message)));
    const boardBox = el("select", "stick-boards");
    boardBox.setAttribute("aria-label", "Board");
    ui.boardBox = boardBox;
    boardBox.addEventListener("change", () => pickBoard(boardBox.value).catch((err) => say(err.message)));
    bar.append(el("span", "stick-title", "Stickies"), boardBox, ui.status, add, el("span", "stick-gap"));
    ["In", "Out", "100%", "Fit"].forEach((label) => {
      const button = el("button", "ghost-btn small", label);
      button.type = "button";
      button.addEventListener("click", () => {
        if (label === "In") zoomAt(ui.zoom * 1.15, ui.stage.clientWidth / 2, ui.stage.clientHeight / 2);
        else if (label === "Out") zoomAt(ui.zoom / 1.15, ui.stage.clientWidth / 2, ui.stage.clientHeight / 2);
        else if (label === "100%") zoomAt(1, ui.stage.clientWidth / 2, ui.stage.clientHeight / 2);
        else fit();
      });
      bar.append(button);
    });
    const brainBtn = el("button", "ghost-btn small stick-brainbtn", "💡 Brainstorm");
    brainBtn.type = "button";
    brainBtn.title = "When you finish a note, suggest more notes and changes to tick or drop";
    ui.brainBtn = brainBtn;
    brainBtn.addEventListener("click", () => {
      tool("sticky_brainstorm_set", { on: !board().brainstorm?.on })
        .then((made) => { say(made.status === "brainstorm_on" ? "Brainstorm is on. Finish a note and ideas pop up." : "Brainstorm is off."); return load(); })
        .catch((err) => say(err.message));
    });
    bar.append(brainBtn);
    const inkBtn = el("button", "ghost-btn small", "✏️ Draw");
    inkBtn.type = "button";
    inkBtn.title = "Draw on the board: pen, straight line, arrow, eraser";
    ui.inkBtn = inkBtn;
    inkBtn.addEventListener("click", () => {
      if (!freeform()) return say("Drawing works on the free board. Set Sort to manual first.");
      ui.ink.on = !ui.ink.on;
      drawInk();
    });
    const exportBtn = el("button", "ghost-btn small", "Export");
    exportBtn.type = "button";
    exportBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      const rect = exportBtn.getBoundingClientRect();
      openMenu(rect.left, rect.bottom + 4, exportMenu());
    });
    const boardBtn = el("button", "ghost-btn small", "Board ▾");
    boardBtn.type = "button";
    boardBtn.title = "Summarize, turn into a plan, ideas from your files, paste a list, templates";
    boardBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      const rect = boardBtn.getBoundingClientRect();
      ui.menuAt = [rect.left, rect.bottom + 4];
      openMenu(rect.left, rect.bottom + 4, boardMenu(null));
    });
    bar.append(inkBtn, exportBtn, boardBtn);
    const settingsBtn = el("button", "ghost-btn small", "Settings");
    settingsBtn.type = "button";
    const close = el("button", "ghost-btn small", "Close");
    close.type = "button";
    close.addEventListener("click", () => show(false));
    bar.append(settingsBtn, close);

    const filters = el("div", "stick-filters");
    const search = el("input");
    search.type = "search";
    search.placeholder = "Search notes";
    search.setAttribute("aria-label", "Search sticky notes");
    search.addEventListener("input", () => { ui.filter = { ...ui.filter, q: search.value }; draw(); });
    // Only Show and the search box hide notes. Order and Group arrange what is shown.
    const sort = selectOf(["manual", "color", "created-desc", "created-asc", "updated", "title-asc", "title-desc", "hashtag", "priority", "due"], "manual", {
      manual: "Order: where I put them", color: "Order: by color", "created-desc": "Order: newest first", "created-asc": "Order: oldest first",
      updated: "Order: last edited", "title-asc": "Order: title A–Z", "title-desc": "Order: title Z–A", hashtag: "Order: by hashtag",
      priority: "Order: by priority", due: "Order: by due date",
    });
    sort.setAttribute("aria-label", "Sort notes");
    ui.sortBox = sort;
    sort.addEventListener("change", () => saveBoard({ sort: sort.value, layout: sort.value === "manual" ? "freeform" : "organized" }));
    const group = selectOf(["", "color", "hashtag", "priority", "date", "task"], "", {
      "": "No groups", color: "Group by color", hashtag: "Group by hashtag", priority: "Group by priority", date: "Group by day made", task: "Group by to-do status",
    });
    group.setAttribute("aria-label", "Group notes");
    ui.groupBox = group;
    group.addEventListener("change", () => saveBoard({ group: group.value, layout: group.value ? "organized" : board().layout }));
    const view = selectOf(["board", "tasks", "today", "upcoming", "overdue", "completed", "archive", "trash"], "board", {
      board: "Show: all notes", tasks: "Show: to-do list", today: "Show: due today", upcoming: "Show: due later", overdue: "Show: overdue",
      completed: "Show: done", archive: "Show: archive", trash: "Show: trash",
    });
    view.setAttribute("aria-label", "Which notes to show");
    ui.viewBox = view;
    view.addEventListener("change", () => setView(view.value));
    const clear = el("button", "ghost-btn small", "Clear filters");
    clear.type = "button";
    clear.hidden = true;
    ui.clearBtn = clear;
    // Back to every note on the board: the search, a clicked hashtag, and Show.
    clear.addEventListener("click", () => {
      search.value = "";
      view.value = "board";
      ui.filter = {};
      setView("board");
    });
    filters.append(view, search, sort, group, clear);
    ui.brainBar = brainBar();

    ui.stage = el("div", "stick-stage");
    ui.world = el("div", "stick-world");
    ui.board = el("div", "stick-board");
    ui.inkLayer = document.createElementNS(SVG, "svg");
    ui.inkLayer.setAttribute("class", "stick-ink");
    ui.inkLayer.setAttribute("width", "3200");
    ui.inkLayer.setAttribute("height", "2400");
    ui.inkLayer.addEventListener("pointerdown", startInk);
    ui.world.append(ui.board, ui.inkLayer);
    ui.inkBar = inkBar();
    ui.stage.append(ui.world, ui.inkBar);
    const mapWrap = el("div", "stick-mapwrap");
    const zoomCol = el("div", "stick-zoomcol");
    const zoomButton = (label, factor, name) => {
      const button = el("button", "stick-zoom", label);
      button.type = "button";
      button.setAttribute("aria-label", name);
      button.addEventListener("click", () => {
        zoomAt(ui.zoom * factor, ui.stage.clientWidth / 2, ui.stage.clientHeight / 2);
      });
      return button;
    };
    zoomCol.append(zoomButton("+", 1.15, "Zoom in"), zoomButton("−", 1 / 1.15, "Zoom out"));
    ui.map = el("canvas", "stick-map");
    ui.map.width = 160;
    ui.map.height = 110;
    ui.map.setAttribute("aria-label", "Board map. Click to jump there, or drag the green box to move the board.");
    ui.map.addEventListener("pointerdown", (event) => {
      event.stopPropagation();
      try { ui.map.setPointerCapture(event.pointerId); } catch (err) { /* the pointer can already be gone */ }
      const { boardX, boardY } = boardFromMap(event);
      if (pointerInBox(event)) {
        mapDrag = {
          grabX: boardX - (-ui.panX / ui.zoom),
          grabY: boardY - (-ui.panY / ui.zoom),
        };
      } else {
        const stage = ui.stage.getBoundingClientRect();
        mapDrag = { grabX: stage.width / 2 / ui.zoom, grabY: stage.height / 2 / ui.zoom };
        panByGrab(boardX, boardY);
      }
      ui.map.classList.add("is-drag");
    });
    ui.map.addEventListener("pointermove", (event) => {
      if (!mapDrag) {
        ui.map.classList.toggle("is-over", pointerInBox(event));
        return;
      }
      const { boardX, boardY } = boardFromMap(event);
      panByGrab(boardX, boardY);
    });
    const endMapDrag = () => {
      if (!mapDrag) return;
      mapDrag = null;
      ui.map.classList.remove("is-drag");
      scheduleBoard();
    };
    ui.map.addEventListener("pointerup", endMapDrag);
    ui.map.addEventListener("pointercancel", endMapDrag);
    mapWrap.append(zoomCol, ui.map);
    ui.stage.append(mapWrap);
    ui.helper = el("div", "stick-helper");
    ui.helper.hidden = true;
    ui.helper.setAttribute("aria-live", "polite");
    ui.stage.append(ui.helper);
    ui.menu = el("div", "stick-menu");
    ui.menu.hidden = true;
    ui.menu.setAttribute("role", "menu");
    root.append(bar, filters, ui.brainBar, ui.stage, ui.menu);
    document.querySelector("main.layout").append(root);
    ui.root = root;
    settingsBtn.addEventListener("click", () => {
      ui.settings?.remove();
      ui.settings = settingsPanel();
      ui.settings.hidden = false;
      root.append(ui.settings);
    });

    ui.board.addEventListener("dblclick", (event) => {
      if (event.target !== ui.board) return;
      const point = boardPoint(event);
      createAt(point.x, point.y).catch((err) => say(err.message));
    });
    ui.board.addEventListener("contextmenu", (event) => {
      if (event.target !== ui.board) return;
      event.preventDefault();
      const point = boardPoint(event);
      openMenu(event.clientX, event.clientY, boardMenu(point));
    });
    ui.stage.addEventListener("pointerdown", (event) => {
      if (event.target !== ui.board && event.target !== ui.stage) return;
      const startX = event.clientX;
      const startY = event.clientY;
      const ox = ui.panX;
      const oy = ui.panY;
      const move = (ev) => {
        ui.panX = ox + ev.clientX - startX;
        ui.panY = oy + ev.clientY - startY;
        applyTransform();
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        scheduleBoard();
        drawMap();
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    });
    ui.stage.addEventListener("wheel", (event) => {
      if (ui.stage.classList.contains("is-scroll") && !event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const rect = ui.stage.getBoundingClientRect();
      if (event.ctrlKey || event.metaKey) zoomAt(ui.zoom * (event.deltaY < 0 ? 1.08 : 0.92), event.clientX - rect.left, event.clientY - rect.top);
      else {
        ui.panX -= event.deltaX;
        ui.panY -= event.deltaY;
        applyTransform();
        drawMap();
        scheduleBoard();
      }
    }, { passive: false });
    document.addEventListener("click", (event) => {
      if (ui.menu && !ui.menu.contains(event.target)) ui.menu.hidden = true;
      // A change that came in while typing was not drawn. Draw it once the click leaves the notes.
      // The note can keep focus after a click on the bare board, so let go of it first.
      if (ui.stale && !event.target.closest?.(".sticky, .stick-menu")) {
        if (ui.board.contains(document.activeElement)) document.activeElement.blur();
        draw();
      }
    });
    document.addEventListener("pointerdown", (event) => {
      if (!ui.drawing || !ui.board) return;
      const card = ui.board.querySelector(".sticky.is-draw");
      if (card && card.contains(event.target)) return;
      stopDrawing();
    }, true);
    document.addEventListener("keydown", onKey);
    // Pasting a multi-line list onto the board makes one note per line.
    document.addEventListener("paste", (event) => {
      if (!ui.root || ui.root.hidden || ui.view !== "board") return;
      if (event.target.closest?.("input, textarea, [contenteditable=true]")) return;
      const text = event.clipboardData?.getData("text/plain") || "";
      if (/^https?:\/\/\S+$/.test(text.trim())) {
        event.preventDefault();
        importPage(text.trim()).catch((err) => say(err.message));
        return;
      }
      if (text.split(/\r?\n/).filter((line) => line.trim()).length < 2) return;
      event.preventDefault();
      ui.menuAt = [ui.stage.clientWidth / 2, ui.stage.clientHeight / 3];
      pasteList(null, text).catch((err) => say(err.message));
    });
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applyLook);
  }

  // The search box stays as typed. The archive is fetched, since the board leaves it out.
  function setView(value) {
    const reload = ui.view === "archive" || value === "archive";
    ui.view = VIEWS.includes(value) ? value : "tasks";
    ui.filter = { ...(VIEW_FILTERS[value] || {}), q: ui.filter.q };
    if (reload) load().catch((err) => say(err.message));
    else draw();
  }

  function onKey(event) {
    if (!ui.root || ui.root.hidden) return;
    const typing = event.target.closest && (event.target.closest("input, textarea, [contenteditable=true]"));
    // Undo belongs to the note. A title or the search box keeps its own undo.
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z" && ui.selected && (!typing || event.target.closest(".sticky-body"))) {
      event.preventDefault();
      undo(ui.selected, event.shiftKey);
      return;
    }
    if (typing || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === "n") createAt().catch((err) => say(err.message));
    else if (event.key === "Escape") {
      ui.menu.hidden = true;
      if (ui.ink.on) { ui.ink.on = false; drawInk(); }
    }
    else if ((event.key === "Delete" || event.key === "Backspace") && ui.selected) {
      const note = notes().find((item) => item.id === ui.selected);
      const rect = ui.board.querySelector(`[data-id="${ui.selected}"]`)?.getBoundingClientRect();
      if (rect) ui.menuAt = [rect.left, rect.top];
      if (note) confirmDelete(note);
    } else if (event.key === "0") zoomAt(1, ui.stage.clientWidth / 2, ui.stage.clientHeight / 2);
    else if (event.key === "+" || event.key === "=") zoomAt(ui.zoom * 1.1, ui.stage.clientWidth / 2, ui.stage.clientHeight / 2);
    else if (event.key === "-") zoomAt(ui.zoom / 1.1, ui.stage.clientWidth / 2, ui.stage.clientHeight / 2);
  }

  function show(on) {
    if (!ui.root) build();
    document.querySelector("main.layout")?.classList.toggle("stick-on", on);
    ui.root.hidden = !on;
    btn?.classList.toggle("is-on", on);
    btn?.setAttribute("aria-pressed", on ? "true" : "false");
  }

  function open() {
    if (!ui.root) build();
    window.brainWord?.close();
    window.brainSlides?.close();
    window.brainR?.close();
    window.brainPhoto?.close();
    window.brainMovie?.close();
    window.brainCalendar?.close();
    window.brainPlans?.close();
    window.brainScreen?.close();
    show(true);
    load().catch((err) => {
      console.error("Failed while opening sticky notes:", err);
      say(err.message || "Could not open the board.");
    });
  }

  function command(question) {
    const q = String(question || "").toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
    if (/^(?:please |hey )?(?:open|show)(?: me)? (?:the |my )?(?:sticky notes|stickies|bulletin board)$/.test(q)) return "open";
    if (/^(?:please |hey )?(?:close|hide)(?: me)? (?:the |my )?(?:sticky notes|stickies|bulletin board)$/.test(q)) return "close";
    return "";
  }

  window.brainStickies = {
    get open() { return Boolean(ui.root && !ui.root.hidden); },
    openPanel: open,
    close: () => show(false),
    command,
    apply(data) {
      if (data?.open) open();
      if (data?.reason === "brainstorming") {
        ui.thinking = true;
        ui.thinkingWhat = data.what || "";
      }
      if (data?.reason === "ideas") {
        ui.thinking = false;
        ui.helperNote = data.error || (data.plan ? `Added “${data.plan}” to Plans.` : "") || (data.count || data.quiet ? "" : "No new ideas this time.");
        clearTimeout(ui.helperTimer);
        if (ui.helperNote) ui.helperTimer = setTimeout(() => { ui.helperNote = ""; drawHelper(); }, 4000);
      }
      if (data?.filter) ui.filter = { ...ui.filter, ...data.filter };
      if (VIEWS.includes(data?.view)) {
        ui.view = data.view;
        if (ui.viewBox) ui.viewBox.value = data.view;
      }
      if (ui.root && !ui.root.hidden) load().catch((err) => say(err.message));
    },
  };

  btn?.addEventListener("click", () => {
    if (ui.root && !ui.root.hidden) show(false);
    else open();
  });

  const control = new EventSource("/control");
  control.addEventListener("stickies", (event) => {
    try {
      window.brainStickies.apply(JSON.parse(event.data || "{}"));
    } catch (err) {
      console.error("Failed while updating sticky notes from the voice:", err);
    }
  });
})();
