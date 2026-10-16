// "Edit with brain": the deck in a window-sized editor, one slide at a time.
// Type, or say "Hey" and what to change on the slide shown; the brain rewrites only that
// slide, then waits for the next instruction.
// Enhance rewrites the whole deck: more attractive, online data, or a document's data.
import { loadThemes, renderSlide, themeOf, themeVars } from "/deck.js";

const ed = { root: null, id: "", deck: null, index: 0, busy: false, thumbs: null, main: null, status: null, input: null, title: null };

const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
};

function button(label, title, action, cls = "ghost-btn small") {
  const node = el("button", cls, label);
  node.type = "button";
  node.title = title;
  node.addEventListener("click", (event) => {
    event.stopPropagation();
    action(node);
  });
  return node;
}

function status(text) {
  if (ed.status) ed.status.textContent = text;
}

function model() {
  return window.selectedModel?.()?.id || "";
}

function setBusy(on, text = "") {
  ed.busy = on;
  ed.root?.classList.toggle("de-busy", on);
  ed.root?.querySelectorAll("button, input").forEach((node) => {
    if (!node.classList.contains("de-close")) node.disabled = on;
  });
  status(text);
}

/** A slide drawn at width px (the slide is 960 points wide). */
function slideAt(slide, theme, width) {
  const frame = el("div", "de-frame");
  frame.style.width = `${width}px`;
  frame.style.height = `${(width * 540) / 960}px`;
  const node = renderSlide(slide, theme);
  node.style.transform = `scale(${width / 960})`;
  frame.append(node);
  return frame;
}

function draw() {
  if (!ed.root) return;
  const theme = themeOf(ed.deck);
  themeVars(ed.root, theme);
  ed.title.textContent = ed.deck.title;
  ed.index = Math.max(0, Math.min(ed.deck.slides.length - 1, ed.index));
  ed.thumbs.replaceChildren(...ed.deck.slides.map((slide, i) => {
    const item = el("button", `de-thumb${i === ed.index ? " de-on" : ""}`);
    item.type = "button";
    item.title = slide.title || slide.quote || `Slide ${i + 1}`;
    item.append(el("span", "de-num", String(i + 1)), slideAt(slide, theme, 168));
    item.addEventListener("click", () => go(i));
    return item;
  }));
  ed.thumbs.querySelector(".de-on")?.scrollIntoView({ block: "nearest" });
  const room = ed.main.parentElement;
  const width = Math.max(320, Math.min(room.clientWidth - 40, ((room.clientHeight - 130) * 960) / 540));
  ed.main.replaceChildren(slideAt(ed.deck.slides[ed.index], theme, width));
  ed.input.placeholder = `What to change on slide ${ed.index + 1}? (or say "Hey, …")`;
  const notes = ed.deck.slides[ed.index]?.notes;
  ed.root.querySelector(".de-notes").textContent = notes ? `Notes: ${notes}` : "";
}

function go(index) {
  ed.index = index;
  draw();
}

async function post(url, body, headers = { "Content-Type": "application/json" }) {
  const response = await fetch(url, { method: "POST", headers, body });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "That did not work.");
  return data;
}

/** Change the slide on screen the way the user asked. */
async function change(request) {
  const words = String(request || "").trim();
  if (!words || ed.busy) return;
  ed.input.value = "";
  setBusy(true, `Changing slide ${ed.index + 1}: “${words}”…`);
  try {
    const data = await post(`/deck/${encodeURIComponent(ed.id)}/slide`, JSON.stringify({ index: ed.index, request: words, model: model() }));
    ed.deck = data.deck;
    setBusy(false, `Slide ${ed.index + 1} changed. Waiting for your next change (Undo puts it back).`);
    draw();
  } catch (err) {
    setBusy(false, err.message);
  }
}

const ENHANCING = {
  design: "Making it more attractive",
  web: "Searching the web and adding data",
  document: "Reading the document and adding its data",
};

/** Rewrite the whole deck. file: a File for document mode (else the last uploaded document). */
async function enhance(mode, request = "", file = null) {
  if (ed.busy) return;
  setBusy(true, `${ENHANCING[mode]}… this takes about a minute.`);
  try {
    const url = `/deck/${encodeURIComponent(ed.id)}/enhance`;
    const data = file
      ? await post(url, await file.arrayBuffer(), {
        "Content-Type": "application/octet-stream",
        "x-mode": mode,
        "x-file-name": encodeURIComponent(file.name),
        "x-request": encodeURIComponent(request),
        "x-model": model(),
      })
      : await post(url, JSON.stringify({ mode, request, model: model() }));
    ed.deck = data.deck;
    setBusy(false, `Done: ${data.deck.slides.length} slides. Undo goes back.`);
    draw();
  } catch (err) {
    setBusy(false, err.message);
  }
}

async function undo() {
  try {
    const data = await post(`/deck/${encodeURIComponent(ed.id)}/undo`, "{}");
    ed.deck = data.deck;
    status("Undone.");
    draw();
  } catch (err) {
    status(err.message);
  }
}

async function save(pick) {
  status(pick ? "Choose a folder…" : "Building the PowerPoint…");
  try {
    const data = await post(`/deck/${encodeURIComponent(ed.id)}/save`, JSON.stringify({ pick }));
    status(data.path ? `Saved: ${data.path}` : "");
  } catch (err) {
    status(err.message);
  }
}

function onKey(event) {
  if (!ed.root || event.target === ed.input) return;
  if (event.key === "ArrowDown" || event.key === "ArrowRight") go(Math.min(ed.deck.slides.length - 1, ed.index + 1));
  else if (event.key === "ArrowUp" || event.key === "ArrowLeft") go(Math.max(0, ed.index - 1));
  else if (event.key === "Escape") closeEditor();
  else return;
  event.preventDefault();
}

function build() {
  const root = el("div", "deckedit");
  const head = el("div", "de-head");
  ed.title = el("strong", "de-title");
  const menu = el("div", "de-menu");
  const picker = el("input");
  picker.type = "file";
  picker.accept = ".pdf,.docx,.doc,.pptx,.rtf,.odt,.txt,.md";
  picker.hidden = true;
  picker.addEventListener("change", () => {
    const file = picker.files?.[0];
    picker.value = "";
    if (file) enhance("document", "", file);
  });
  const enhanceBtn = button("Enhance ▾", "Improve the whole deck", () => menu.classList.toggle("de-open"));
  menu.append(
    button("More attractive", "Better slide kinds, headlines, theme and speaker notes; same facts", () => { menu.classList.remove("de-open"); enhance("design"); }),
    button("Add online data", "Search the web and add current facts, with sources", () => { menu.classList.remove("de-open"); enhance("web"); }),
    button("Add data from a document…", "Pick a PDF, Word or PowerPoint file", () => { menu.classList.remove("de-open"); picker.click(); }),
    button("Use the last uploaded document", "The document you uploaded in the app", () => { menu.classList.remove("de-open"); enhance("document"); }),
  );
  const enhanceWrap = el("span", "de-enhance");
  enhanceWrap.append(enhanceBtn, menu, picker);
  head.append(
    ed.title,
    el("span", "de-gap"),
    enhanceWrap,
    button("Undo", "Back to before the last change", undo),
    button("▶ Present", "Full screen from this slide", () => {
      const { id, index } = ed;
      closeEditor();
      window.brainDeck?.present(id, { index });
    }),
    button("PowerPoint", "Save the .pptx in Downloads", () => save(false)),
    button("Save to…", "Choose where to save the .pptx", () => save(true)),
    button("✕", "Close the editor (Esc)", closeEditor, "ghost-btn small de-close"),
  );
  const body = el("div", "de-body");
  ed.thumbs = el("div", "de-thumbs");
  const stage = el("div", "de-stage");
  ed.main = el("div", "de-main");
  const form = el("form", "de-form");
  ed.input = el("input", "de-input");
  ed.input.type = "text";
  ed.input.autocomplete = "off";
  form.append(ed.input, button("Change", "Change this slide", () => change(ed.input.value), "ghost-btn"));
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    change(ed.input.value);
  });
  ed.status = el("div", "de-status");
  stage.append(ed.main, el("div", "de-notes"), form, ed.status);
  body.append(ed.thumbs, stage);
  root.append(head, body);
  document.body.append(root);
  ed.root = root;
  document.addEventListener("keydown", onKey, true);
  window.addEventListener("resize", draw);
}

/** Open deck id in the editor at slide index. Optionally start an enhance right away. */
export async function openEditor(id, index = 0, start = null) {
  const response = await fetch(`/deck/${encodeURIComponent(id)}`);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "That deck is gone.");
  await loadThemes();
  if (!ed.root) build();
  Object.assign(ed, { id, deck: data.deck, index });
  localStorage.setItem("lastDeck", id);
  draw();
  status("Type a change, or say Hey and the change. Hey next / Hey back moves.");
  if (typeof connected !== "undefined" && !connected) document.getElementById("talkBtn")?.click();
  if (start) enhance(start.mode, start.request || "");
}

export function closeEditor() {
  if (!ed.root) return;
  document.removeEventListener("keydown", onKey, true);
  window.removeEventListener("resize", draw);
  ed.root.remove();
  ed.root = null;
}

export function editorOpen() {
  return Boolean(ed.root);
}

const NUMBERS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };

let lastHeard = { words: "", at: 0 };

/**
 * Speech while the editor is open. Only sentences that start with Hey count, one at a
 * time: anything else (talk, noise, whisper's made-up "thank you") is ignored, and so is
 * speech while a change is still running or the same words heard again within 30 s.
 */
export function editorHear(raw) {
  const said = window.questionAfterWake ? window.questionAfterWake(raw) : String(raw || "").trim();
  if (said === null || ed.busy) return;
  if (!said) {
    status("Listening: say the change.");
    return;
  }
  const key = said.toLowerCase().replace(/[^\p{L}\p{N} ]+/gu, "").trim();
  if (key === lastHeard.words && Date.now() - lastHeard.at < 30_000) return;
  lastHeard = { words: key, at: Date.now() };
  const s = said.toLowerCase().replace(/[.,!?]+/g, " ").replace(/\s+/g, " ").trim();
  if (/^(next|next slide|forward)( please)?$/.test(s)) go(Math.min(ed.deck.slides.length - 1, ed.index + 1));
  else if (/^(back|go back|previous|previous slide)( please)?$/.test(s)) go(Math.max(0, ed.index - 1));
  else if (/^(?:go to |show )?slide (\d+|\w+)$/.test(s)) {
    const word = s.match(/slide (\d+|\w+)$/)[1];
    const n = Number(word) || NUMBERS[word];
    if (n) go(Math.max(0, Math.min(ed.deck.slides.length - 1, n - 1)));
  } else if (/^(undo|undo that|put it back)$/.test(s)) undo();
  else if (/\b(close|exit|leave)( the)? editor\b|^(done|i'?m done)$/.test(s)) closeEditor();
  else if (/^(present|present it|start the (show|presentation))$/.test(s)) {
    const { id, index } = ed;
    closeEditor();
    window.brainDeck?.present(id, { index });
  } else if (/\b(online|web|internet)\b.*\b(data|facts|numbers|statistics|stats|sources)\b|\bsearch (the )?(web|online)\b/.test(s)) enhance("web", said);
  else if (/\b(uploaded|attached)\b.*\b(document|file|pdf|report)\b|\bfrom the (document|file|pdf|report)\b/.test(s)) enhance("document", said);
  else if (/\b(whole|entire|all the|every) (deck|presentation|slides?)\b.*\b(attractive|better|nicer|prettier|beautiful|engaging)\b|^(enhance|improve|polish)( it| the deck| the presentation)?$/.test(s)) enhance("design", said);
  else if (said.split(/\s+/).length >= 2) change(said);
}
