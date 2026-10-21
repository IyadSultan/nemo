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
    high: { priority: "high+", taskStatus: "open" },
  };
  // The same words the server skips when it searches (stickies.js), so a spoken search shows what it found.
  const SEARCH_SKIP = new Set(["the", "a", "an", "my", "to", "of", "and", "for", "about", "that", "this", "note", "notes"]);
  const ui = {
    root: null, stage: null, world: null, board: null, status: null, menu: null, map: null,
    data: null, selected: "", filter: {}, view: "board", timers: new Map(), undo: new Map(),
    zoom: 1, panX: 40, panY: 30, drawing: false, stale: false,
  };

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
    draw();
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
    drawMap();
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

  function claudeMark() {
    const mark = el("span", "sticky-claude");
    mark.setAttribute("aria-hidden", "true");
    mark.innerHTML = `<svg viewBox="20 0 560 470"><g class="critter">
      <rect class="arm arm-l" x="35" y="140" width="52" height="105"/>
      <rect class="arm arm-r" x="513" y="140" width="52" height="105"/>
      <rect class="leg" x="85" y="340" width="50" height="110"/>
      <rect class="leg" x="180" y="340" width="50" height="110"/>
      <rect class="leg" x="370" y="340" width="50" height="110"/>
      <rect class="leg" x="465" y="340" width="50" height="110"/>
      <rect class="body" x="85" y="35" width="430" height="310"/>
      <g class="eyes"><rect x="160" y="120" width="40" height="80"/><rect x="400" y="120" width="40" height="80"/></g>
      <rect class="mouth" x="270" y="235" width="60" height="40"/>
    </g></svg>`;
    return mark;
  }

  // A reminder replaces the pin with a small clock, so a timed note is easy to spot.
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
    if (note.noteType === "task" || (note.priority && note.priority !== "none")) {
      const bits = [];
      if (note.noteType === "task") bits.push(note.taskStatus === "done" ? "Done" : "Task");
      if (note.priority && note.priority !== "none") bits.push(note.priority);
      head.append(el("span", "sticky-badge", bits.join(" · ")));
    }

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
    return card;
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
    const when = el("span", "sticky-badge", [note.priority, note.dueAt ? note.dueAt.slice(0, 10) : ""].filter(Boolean).join(" · "));
    row.append(box, text, when);
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
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (x == null) return;
      note.positionX = x;
      note.positionY = y;
      savePatch(note.id, { x, y });
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
  function scheduleSave(id, content, wait = 400) {
    const note = (ui.data?.notes || []).find((item) => item.id === id);
    if (note) note.content = content;
    clearTimeout(ui.timers.get(id));
    ui.timers.set(id, setTimeout(() => savePatch(id, { content }), wait));
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
      { label: "Priority: high", action: () => tool("sticky_note_set_priority", { id: note.id, priority: "high" }).then(() => load()) },
      { label: "Set reminder", action: () => remind(note) },
      { label: note.isPinned ? "Unpin" : "Pin", action: () => savePatch(note.id, { isPinned: !note.isPinned }).then(load) },
      { label: "Duplicate", action: () => duplicate(note) },
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

  function scheduleBoard() {
    clearTimeout(ui.timers.get("board"));
    ui.timers.set("board", setTimeout(() => {
      fetch("/stickies/board", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ zoom: ui.zoom, panX: ui.panX, panY: ui.panY }),
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
    box.append(el("h3", "", "Board"));
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
      };
      // Close first, so the panel is gone even while the save is still finishing.
      box.remove();
      if (ui.settings === box) ui.settings = null;
      try {
        await savePrefs({ prefs: saved.prefs, colorMeanings: saved.colorMeanings });
        await saveBoard({ background: saved.background, backgroundColor: saved.backgroundColor });
        say("Settings saved.");
      } catch (err) {
        console.error("Failed while saving sticky-note settings:", err);
        say("Could not save those settings.");
      }
    });
    return box;
  }

  function selectOf(values, current) {
    const node = el("select");
    values.forEach((value) => {
      const option = el("option", "", value || "none");
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
    bar.append(el("span", "stick-title", "Stickies"), ui.status, add, el("span", "stick-gap"));
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
    const sort = selectOf(["manual", "color", "created-desc", "created-asc", "updated", "title-asc", "title-desc", "hashtag", "priority", "due"], "manual");
    sort.setAttribute("aria-label", "Sort notes");
    ui.sortBox = sort;
    sort.addEventListener("change", () => saveBoard({ sort: sort.value, layout: sort.value === "manual" ? "freeform" : "organized" }));
    const group = selectOf(["", "color", "hashtag", "priority", "date", "task"], "");
    group.setAttribute("aria-label", "Group notes");
    ui.groupBox = group;
    group.addEventListener("change", () => saveBoard({ group: group.value, layout: group.value ? "organized" : board().layout }));
    const view = selectOf(["board", "tasks", "today", "upcoming", "overdue", "completed", "high", "archive", "trash"], "board");
    view.setAttribute("aria-label", "Which notes to show");
    ui.viewBox = view;
    view.addEventListener("change", () => setView(view.value));
    const clear = el("button", "ghost-btn small", "Clear filters");
    clear.type = "button";
    clear.addEventListener("click", () => { ui.filter = {}; search.value = ""; draw(); });
    filters.append(search, sort, group, view, clear);

    ui.stage = el("div", "stick-stage");
    ui.world = el("div", "stick-world");
    ui.board = el("div", "stick-board");
    ui.world.append(ui.board);
    ui.stage.append(ui.world);
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
    ui.menu = el("div", "stick-menu");
    ui.menu.hidden = true;
    ui.menu.setAttribute("role", "menu");
    root.append(bar, filters, ui.stage, ui.menu);
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
      openMenu(event.clientX, event.clientY, [{ label: "New note", action: () => createAt(point.x, point.y) }]);
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
    else if (event.key === "Escape") ui.menu.hidden = true;
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
    window.brainCalendar?.close();
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
