// Presentations in the app: DeckCraft (vendor/deckcraft, voice/install-deckcraft-web.sh) in the
// right-hand panel, in place of the transcript, like Word (wordedit.js). The orb and the ask box
// on the left talk to it: ask about the deck, change this slide, or change the whole deck, by
// typing or by saying "Hey, …". Small buttons above open and save .pptx files on this Mac, show
// the deck full screen, and run common requests. Decks the brain made open here from their card.
(() => {
  const btn = document.getElementById("slidesBtn");
  const sl = { root: null, frame: null, ready: null, path: "", name: "Presentation.pptx", busy: false, log: null, status: null, info: null, poll: 0, showing: false, closeArmed: false };

  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  };

  function onClick(node, action) {
    node.addEventListener("click", (event) => {
      event.stopPropagation();
      action(node);
    });
    return node;
  }

  function button(label, title, action, cls = "ghost-btn small") {
    const node = el("button", cls, label);
    node.type = "button";
    node.title = title;
    return onClick(node, action);
  }

  /** A small square button; tip shows on hover (the Word panel's style). */
  function tool(icon, tip, action, cls = "") {
    const node = el("button", `we-tool ${cls}`.trim(), icon);
    node.type = "button";
    node.dataset.tip = tip;
    node.setAttribute("aria-label", tip);
    return onClick(node, action);
  }

  function status(text) {
    if (sl.status) sl.status.textContent = text;
  }

  function setBusy(on, text = "") {
    sl.busy = on;
    sl.root?.classList.toggle("we-busy", on);
    sl.root?.querySelectorAll(".we-ai").forEach((node) => (node.disabled = on));
    status(text);
  }

  // ---- the bridge into DeckCraft (window.deckcraftBridge in the iframe) ----

  async function call(method, params = {}) {
    await sl.ready;
    const reply = await sl.frame.contentWindow.deckcraftBridge(method, JSON.stringify(params));
    if (typeof reply !== "string") return reply;
    const data = JSON.parse(reply);
    if (!data.ok) throw new Error(data.error || "DeckCraft could not do that.");
    return data.result;
  }

  const exec = (command, params = {}) => call("engine.execute", { command, params });

  function waitForBridge() {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const tick = () => {
        if (sl.frame?.contentWindow?.deckcraftBridge) return resolve();
        if (Date.now() - started > 60_000) return reject(new Error("DeckCraft did not start. This needs WebGPU or WebGL2."));
        setTimeout(tick, 150);
      };
      tick();
    });
  }

  function toBase64(bytes) {
    let out = "";
    for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(out);
  }

  // ---- files ----

  /** One presentation at a time, so every command reaches the one on screen. */
  async function closeAll() {
    const docs = (await call("ui.inspect").catch(() => null))?.documents || [];
    for (let i = 0; i < docs.length; i += 1) await exec("file.close").catch(() => {});
  }

  async function openBytes(bytes, name, filePath = "") {
    await closeAll();
    await exec("file.openBytes", { name, data: toBase64(bytes) });
    sl.path = filePath;
    sl.name = name;
    showTitle();
    status(`Opened ${name}. Ask about it, or say what to change on this slide or the whole deck.`);
  }

  async function openUrl(url, name, filePath = "", { force = false } = {}) {
    if (!force && !(await leaveOk())) return;
    setBusy(true, `Opening ${name}…`);
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || "Could not open it.");
      await openBytes(new Uint8Array(await response.arrayBuffer()), name, filePath);
      setBusy(false, sl.status.textContent);
    } catch (err) {
      setBusy(false, err.message);
    }
  }

  const openPath = (item) => openUrl(`/slides/file?path=${encodeURIComponent(item.path)}`, item.name, item.path);

  async function newDeck() {
    if (!(await leaveOk())) return;
    await closeAll();
    await exec("file.new");
    sl.path = "";
    sl.name = "Presentation.pptx";
    showTitle();
    status("New presentation. Say what it is about, or what to add.");
  }

  /** The deck as file bytes (pptx or deckcraft); marks it saved. */
  async function deckBytes(format) {
    const bytes = await call("bridge.save", { format });
    // The bytes come from the iframe's realm, where instanceof Uint8Array is false here.
    if (!ArrayBuffer.isView(bytes)) throw new Error("DeckCraft could not write it.");
    return new Uint8Array(bytes);
  }

  async function save(asName = "") {
    const name = asName || sl.name;
    const backToFile = !asName && sl.path && /\.(pptx|deckcraft)$/i.test(sl.path);
    setBusy(true, "Saving…");
    try {
      const bytes = await deckBytes(/\.deckcraft$/i.test(name) ? "deckcraft" : "pptx");
      const headers = { "Content-Type": "application/octet-stream" };
      if (backToFile) headers["X-File-Path"] = encodeURIComponent(sl.path);
      else headers["X-File-Name"] = encodeURIComponent(name.replace(/\.(potx|ppsx)$/i, ".pptx"));
      const response = await fetch("/slides/save", { method: "POST", headers, body: bytes });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Could not save it.");
      sl.path = data.path;
      sl.name = data.name;
      showTitle();
      setBusy(false, backToFile ? `Saved ${data.name}.` : `Saved ${data.name} in Documents.`);
    } catch (err) {
      setBusy(false, err.message);
    }
  }

  async function leaveOk() {
    if (!sl.root) return true;
    const state = await call("bridge.state").catch(() => null);
    if (!state?.dirty || sl.closeArmed) return true;
    sl.closeArmed = true;
    setTimeout(() => (sl.closeArmed = false), 4000);
    status("There are unsaved changes. Click again to go on without saving.");
    return false;
  }

  // ---- the slide show ----

  async function present() {
    try {
      const state = await call("bridge.state");
      if (!state.hasDocument) return status("Open a presentation first.");
      sl.root.classList.add("sl-showing");
      if (document.fullscreenEnabled) await sl.root.requestFullscreen?.().catch(() => {});
      else window.ipc?.postMessage("fullscreen-on");
      sl.frame.focus();
      await call("show.start", { from: state.slide || 0 });
      sl.showing = true;
      watchShow();
    } catch (err) {
      endShowLayout();
      status(err.message);
    }
  }

  function endShowLayout() {
    sl.showing = false;
    sl.root?.classList.remove("sl-showing");
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else window.ipc?.postMessage("fullscreen-off");
  }

  /** The show ends inside DeckCraft (Esc, or past the last slide): put the panel back. */
  function watchShow() {
    const tick = async () => {
      if (!sl.showing) return;
      const ui = await call("ui.inspect").catch(() => null);
      if (!ui?.showing) return endShowLayout();
      setTimeout(tick, 700);
    };
    setTimeout(tick, 1200);
  }

  const showKey = (key) => call("ui.key", { key }).catch(() => {});

  // ---- the Brain panel ----

  function addTurn(who, text, undoSteps = 0) {
    const item = el("div", `we-turn we-${who}`);
    item.append(el("div", "we-text", text));
    if (undoSteps > 0) {
      item.append(
        button("Undo", "Undo this change", async (node) => {
          node.disabled = true;
          try {
            for (let i = 0; i < undoSteps; i += 1) await exec("edit.undo");
            status("Undone.");
          } catch (err) {
            status(err.message);
          }
        }, "ghost-btn small we-undo"),
      );
    }
    sl.log.append(item);
    sl.log.scrollTop = sl.log.scrollHeight;
  }

  /** Every slide in a few lines: shapes (id, name, box, fill, text) and notes. */
  async function describeDeck() {
    const doc = await exec("document.inspect");
    const slides = await Promise.all((doc.slides || []).map((_, i) => exec("slide.inspect", { index: i }).catch(() => null)));
    const lines = [];
    slides.forEach((s, i) => {
      if (!s) return;
      lines.push(`Slide ${i + 1} (index ${i}), layout ${s.layout}${s.hidden ? ", hidden" : ""}, background ${s.background || "theme"}, transition ${s.transition?.kind || "none"}, ${s.animations?.length || 0} animations`);
      for (const shape of s.shapes || []) {
        const text = shape.text ? ` text: ${JSON.stringify(shape.text.length > 1500 ? `${shape.text.slice(0, 1500)}…` : shape.text)}` : "";
        lines.push(`  shape ${shape.id} "${shape.name}" ${shape.kind}${shape.placeholder ? `/${shape.placeholder}` : ""} box [${(shape.box || []).map(Math.round).join(",")}] fill ${shape.fill}${text}`);
      }
      if (s.notes) lines.push(`  notes: ${JSON.stringify(s.notes)}`);
    });
    return { text: lines.join("\n"), selected: doc.selection?.shapes || [], slide: doc.selection?.slide || 0 };
  }

  // Commands that move or select without changing the deck: they make no undo step.
  const NO_UNDO = /^(slide\.(go|next|previous|first|last|selectSlides)|edit\.(select|selectAll|deselect)|text\.(edit|exit|select|selectAll|selectWord|selectParagraph|move))$/;

  // "$1", "$2": the shapes this request created, in order (the model cannot know their ids).
  const resolve = (value, made) => {
    if (typeof value === "string" && /^\$\d+$/.test(value)) return made[Number(value.slice(1)) - 1] ?? value;
    if (Array.isArray(value)) return value.map((v) => resolve(v, made));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolve(v, made)]));
    return value;
  };

  async function runOps(ops) {
    let steps = 0;
    const missed = [];
    const made = [];
    for (const op of ops) {
      try {
        const result = await exec(op.command, resolve(op.params || {}, made));
        if (/^(shape\.insert|insert\.)/.test(op.command) && result?.id != null) made.push(result.id);
        if (!NO_UNDO.test(op.command)) steps += 1;
      } catch (err) {
        missed.push(`${op.command}: ${err.message}`);
        if (/^text\.edit$/.test(op.command)) continue;
      }
    }
    await exec("text.exit").catch(() => {});
    return { steps, missed };
  }

  async function ask(request) {
    request = String(request || "").trim();
    if (!request || sl.busy) return;
    const live = request.replace(/[.!?]+$/, "").match(LIVE_ASK);
    if (live) return startLive(live[1] || "");
    addTurn("you", request);
    setBusy(true, "Thinking…");
    try {
      const state = await call("bridge.state");
      if (!state.hasDocument) throw new Error("Open or start a presentation first.");
      const deck = await describeDeck();
      const selected = deck.selected.length ? `\nSelected shapes on the current slide: ${deck.selected.join(", ")}.` : "";
      const response = await fetch("/slides/ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ request: request + selected, deck: deck.text, slide: deck.slide, title: state.title || sl.name, model: window.selectedModel?.()?.id || "" }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "The model did not answer.");
      setBusy(true, data.ops?.length ? "Changing the slides…" : "");
      const { steps, missed } = await runOps(data.ops || []);
      const note = missed.length ? `\n\n(Not done: ${missed.slice(0, 4).join("; ")}${missed.length > 4 ? "; …" : ""}.)` : "";
      addTurn("brain", (data.say || (steps ? "Done." : "I have nothing to change.")) + note, steps);
      setBusy(false, steps ? "Changed. Undo is under the answer. Waiting for your next request." : "");
    } catch (err) {
      addTurn("brain", err.message);
      setBusy(false, "");
    }
  }

  /** The slide on screen, so "this slide" is clear. */
  async function pollState() {
    if (!sl.root || sl.root.hidden || sl.busy || sl.showing || sl.parked) return;
    try {
      const state = await call("bridge.state");
      sl.info.textContent = state.hasDocument ? `Slide ${state.slide + 1} of ${state.slides}${state.dirty ? " · not saved" : ""}` : "";
    } catch {}
  }

  // ---- the panel ----

  function showTitle() {
    sl.root.querySelector(".we-title").textContent = sl.name;
  }

  const picker = el("input");
  picker.type = "file";
  picker.accept = ".pptx,.potx,.ppsx,.deckcraft";
  picker.hidden = true;
  picker.addEventListener("change", async () => {
    const file = picker.files?.[0];
    picker.value = "";
    if (!file || !(await leaveOk())) return;
    setBusy(true, `Opening ${file.name}…`);
    try {
      await openBytes(new Uint8Array(await file.arrayBuffer()), file.name);
      setBusy(false, sl.status.textContent);
    } catch (err) {
      setBusy(false, err.message);
    }
  });

  async function recentMenu(menu) {
    menu.replaceChildren(el("div", "we-menu-note", "Loading…"));
    const data = await fetch("/slides/recent").then((r) => r.json()).catch(() => ({ files: [] }));
    menu.replaceChildren(
      button("From this Mac…", "Pick a PowerPoint or DeckCraft file", () => {
        menu.classList.remove("we-open");
        picker.click();
      }),
    );
    if (data.files?.length) menu.append(el("div", "we-menu-note", "Recent in Documents, Desktop, Downloads"));
    for (const item of data.files || []) {
      const row = button(item.name, item.where, () => {
        menu.classList.remove("we-open");
        openPath(item);
      });
      row.append(el("span", "we-where", item.where));
      menu.append(row);
    }
  }

  function saveAsMenu(menu) {
    const name = el("input", "we-name");
    name.value = sl.name.replace(/\.[^.]+$/, "");
    const type = el("select", "we-type");
    for (const ext of ["pptx", "deckcraft"]) type.append(new Option(`.${ext}`, ext));
    const go = button("Save in Documents", "Save a copy in Documents", () => {
      menu.classList.remove("we-open");
      const stem = name.value.trim().replace(/[\/\\:]+/g, "-") || "Presentation";
      save(`${stem}.${type.value}`);
    });
    menu.replaceChildren(el("div", "we-menu-note", "Save as"), name, type, go);
    name.focus();
  }

  function dropdown(icon, tip, fill) {
    const wrap = el("span", "we-drop");
    const menu = el("div", "we-menu");
    const open = tool(icon, tip, () => {
      const show = !menu.classList.contains("we-open");
      document.querySelectorAll(".we-menu.we-open").forEach((m) => m.classList.remove("we-open"));
      if (show) {
        menu.classList.add("we-open");
        fill(menu);
      }
    });
    menu.addEventListener("click", (event) => event.stopPropagation());
    wrap.append(open, menu);
    return wrap;
  }

  // Common requests: [icon, hover text, request].
  const QUICK = [
    ["Σ", "Summarize the deck", "Summarize this presentation in a short paragraph and its 3 to 5 key messages."],
    ["★", "Most important slide (go to it)", "Which slide carries the most important message? Go to it and say why."],
    ["✎", "Improve this slide", "Improve the current slide: a clearer headline that states the point, tighter bullets, same facts."],
    ["⇣", "Shorten this slide", "Make the text on the current slide shorter, keeping the facts."],
    ["✦", "Make the whole deck more attractive", "Make the whole presentation more attractive and consistent: headline titles, short bullets, a fitting theme, accent colours, tasteful transitions and entrance animations. Keep every fact."],
    ["♪", "Speaker notes for every slide", "Write short speaker notes for every slide that has none, from the slide's content."],
    ["¶", "Tidy the formatting", "Make fonts, sizes, colours and alignment consistent across all slides, and fix text that overflows its box."],
  ];

  function build() {
    const root = el("section", "panel wordpanel slidespanel");
    root.setAttribute("aria-label", "Presentation");
    const bar = el("div", "we-bar");
    sl.info = el("span", "we-where sl-info");
    bar.append(
      el("span", "we-title"),
      sl.info,
      el("span", "we-gap"),
      tool("＋", "New presentation", newDeck),
      dropdown("📂", "Open a presentation", recentMenu),
      tool("💾", "Save (back to its file, or in Documents)", () => save()),
      dropdown("⤓", "Save as PowerPoint or DeckCraft…", saveAsMenu),
      tool("▶", "Present full screen from this slide (Esc ends)", present),
      dropdown("●", "Live presentation: dictate new slides full screen, then edit them here", liveMenu),
      el("span", "we-sep"),
    );
    for (const [icon, tip, request] of QUICK) bar.append(tool(icon, tip, () => ask(request), "we-ai"));
    bar.append(el("span", "we-sep"), tool("✕", "Close (the presentation stays open)", close), picker);
    sl.log = el("div", "we-log");
    sl.status = el("div", "we-status");
    sl.frame = el("iframe", "we-frame sl-frame");
    sl.frame.title = "DeckCraft";
    sl.frame.allow = "fullscreen";
    root.append(bar, sl.log, sl.status, sl.frame);
    document.querySelector("main.layout").append(root);
    document.addEventListener("click", () => document.querySelectorAll(".we-menu.we-open").forEach((m) => m.classList.remove("we-open")));
    document.addEventListener("fullscreenchange", () => {
      if (!document.fullscreenElement && sl.showing) call("show.end").catch(() => {}).then(endShowLayout);
    });
    sl.root = root;
    showTitle();
    loadFrame("/deckcraft/index.html?blank");
  }

  function show(on) {
    if (on) window.brainWord?.close?.();
    document.querySelector("main.layout")?.classList.toggle("word-on", on);
    sl.root.hidden = !on;
    btn?.classList.toggle("is-on", on);
  }

  async function open() {
    const installed = await fetch("/slides/installed").then((r) => r.json()).catch(() => ({}));
    if (!installed.installed) {
      const statusEl = document.getElementById("statusText");
      if (statusEl) statusEl.textContent = "The slides editor is not installed. Run voice/install-deckcraft-web.sh, then reload.";
      return false;
    }
    if (!sl.root) build();
    window.brainR?.close();
    window.brainPhoto?.close();
    window.brainCalendar?.close();
    window.brainStickies?.close();
    show(true);
    clearInterval(sl.poll);
    sl.poll = setInterval(pollState, 800);
    return true;
  }

  function close() {
    if (!sl.root) return;
    show(false);
    clearInterval(sl.poll);
  }

  /** A deck the brain made (its card's DeckCraft button): its .pptx opens here. */
  async function openDeck(id, title = "Presentation", { force = false } = {}) {
    if (!(await open())) return;
    const name = `${String(title).replace(/[\/\\:]+/g, "-").trim().slice(0, 80) || "Presentation"}.pptx`;
    await openUrl(`/deck/${encodeURIComponent(id)}/pptx`, name, "", { force });
  }

  // ---- a live presentation started from here ----

  /**
   * Full screen in live mode: every sentence said becomes a slide (deck.js). The panel stays
   * behind the presenter, "parked" so speech goes to the presenter, with DeckCraft unloaded:
   * its GPU canvas resizing while the presenter goes full screen and animates crashed the page.
   * When the show ends DeckCraft loads again and the new deck opens here, ready to edit.
   */
  function loadFrame(src) {
    sl.frame.src = src;
    sl.ready = src.startsWith("/deckcraft/") ? waitForBridge() : new Promise(() => {});
    sl.ready.catch((err) => status(err.message));
  }

  async function startLive(topic = "") {
    if (sl.busy || !window.brainDeck?.startLive) return;
    if (!(await leaveOk())) return;
    sl.parked = true;
    loadFrame("about:blank");
    status("Live presentation running. It opens here when it ends.");
    try {
      await window.brainDeck.startLive(topic, { onClose: (id) => backFromLive(id) });
    } catch (err) {
      backFromLive("");
      status(err.message);
    }
  }

  async function backFromLive(id) {
    sl.parked = false;
    loadFrame("/deckcraft/index.html?blank");
    if (!id) return;
    const data = await fetch(`/deck/${encodeURIComponent(id)}`).then((r) => r.json()).catch(() => ({}));
    await openDeck(id, data.deck?.title || "Live presentation", { force: true });
    status(`Back from the live presentation: ${data.deck?.slides?.length ?? 0} slides. Edit them here, or say Hey and the change.`);
  }

  function liveMenu(menu) {
    const topic = el("input", "we-name");
    topic.placeholder = "What is it about? (optional)";
    const go = button("Start live presentation", "Full screen; every sentence you say adds a slide. Esc ends and brings the slides back here.", () => {
      menu.classList.remove("we-open");
      startLive(topic.value.trim());
    });
    topic.addEventListener("keydown", (event) => {
      if (event.key === "Enter") go.click();
    });
    menu.replaceChildren(el("div", "we-menu-note", "Live presentation: dictate it slide by slide"), topic, go);
    topic.focus();
  }

  // "start a live presentation about …" while the panel is open.
  const LIVE_ASK = /^(?:please |can you |let'?s )?(?:start|begin|open|do|make)(?: a| the)? live (?:presentation|deck|slides?|show)(?:\s+(?:about|on|for|called|titled)\s+(.+))?$/i;

  /** A sentence heard while the panel is open: only "Hey, …" counts, one request at a time. */
  let lastHeard = { words: "", at: 0 };
  function hear(raw) {
    const said = window.questionAfterWake ? window.questionAfterWake(raw) : String(raw || "").trim();
    if (said === null || sl.busy) return;
    if (!said) {
      status("Listening: say the request.");
      return;
    }
    const key = said.toLowerCase().replace(/[^\p{L}\p{N} ]+/gu, "").trim();
    if (key === lastHeard.words && Date.now() - lastHeard.at < 30_000) return;
    lastHeard = { words: key, at: Date.now() };
    if (sl.showing) {
      if (/^(next|next slide|forward)( please)?$/.test(key)) return showKey("ArrowRight");
      if (/^(back|go back|previous|previous slide)( please)?$/.test(key)) return showKey("ArrowLeft");
      if (/^(stop|end|end the show|stop the show|exit)$/.test(key)) return call("show.end").catch(() => {}).then(endShowLayout);
    }
    if (/^(next|next slide)( please)?$/.test(key)) return exec("slide.next").catch((err) => status(err.message));
    if (/^(back|previous|previous slide)( please)?$/.test(key)) return exec("slide.previous").catch((err) => status(err.message));
    if (/^(?:go to |show )?slide (\d+)$/.test(key)) return exec("slide.go", { index: Number(key.match(/(\d+)$/)[1]) - 1 }).catch((err) => status(err.message));
    if (/^(close|exit|leave)( the)? (editor|presentation|slides|deckcraft)$|^(done|im done)$/.test(key)) return close();
    if (/^(save|save it|save the (presentation|deck))$/.test(key)) return save();
    if (/^(present|present it|start the (show|slide show|presentation))$/.test(key)) return present();
    if (/^undo( that)?$/.test(key)) return exec("edit.undo").then(() => status("Undone.")).catch((err) => status(err.message));
    if (said.split(/\s+/).length >= 2) ask(said);
  }

  /** "open the slides editor" / "open the presentation in deckcraft" from the main chat. */
  function command(question) {
    const q = String(question || "");
    if (!/\b(open|show|start)\b.*\b(slides? editor|deckcraft|presentation editor|powerpoint editor)\b/i.test(q)) return false;
    const lastDeck = localStorage.getItem("lastDeck");
    if (lastDeck && /\b(it|the (deck|presentation|slides))\b/i.test(q)) openDeck(lastDeck, "Presentation");
    else open();
    return true;
  }

  btn?.addEventListener("click", () => (sl.root && !sl.root.hidden ? close() : open()));
  window.brainSlides = {
    get open() {
      return Boolean(sl.root && !sl.root.hidden && !sl.parked);
    },
    openEditor: open,
    openDeck,
    close,
    ask,
    hear,
    command,
  };
})();
