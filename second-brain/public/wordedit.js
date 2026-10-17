// Word documents in the app: WordCraft (vendor/wordcraft, voice/install-wordcraft.sh) in the
// right-hand panel, in place of the transcript. The orb and the ask box on the left talk to it:
// select text and ask for a change, ask about the document (summarize, Q/A, "what is the most
// important point"), or change formatting, by typing or by saying "Hey, …". Small buttons above
// the page open and save files on this Mac, ingest it into the brain, and run common requests.
(() => {
  const btn = document.getElementById("wordBtn");
  const we = { root: null, frame: null, ready: null, path: "", name: "Document.docx", busy: false, log: null, status: null, sel: null, selText: "", poll: 0, closeArmed: false };

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
    return onClick(node, action);
  }

  /** A small square button; tip shows on hover. */
  function tool(icon, tip, action, cls = "") {
    const node = el("button", `we-tool ${cls}`.trim(), icon);
    node.type = "button";
    node.dataset.tip = tip;
    node.setAttribute("aria-label", tip);
    return onClick(node, action);
  }

  function onClick(node, action) {
    node.addEventListener("click", (event) => {
      event.stopPropagation();
      action(node);
    });
    return node;
  }

  function status(text) {
    if (we.status) we.status.textContent = text;
  }

  function setBusy(on, text = "") {
    we.busy = on;
    we.root?.classList.toggle("we-busy", on);
    we.root?.querySelectorAll(".we-ai").forEach((node) => (node.disabled = on));
    status(text);
  }

  // ---- the bridge into WordCraft (window.wordcraftBridge in the iframe) ----

  async function call(method, params = {}) {
    await we.ready;
    const reply = await we.frame.contentWindow.wordcraftBridge(method, JSON.stringify(params));
    if (typeof reply !== "string") return reply;
    const data = JSON.parse(reply);
    if (!data.ok) throw new Error(data.error || "WordCraft could not do that.");
    return data.result;
  }

  const exec = (command, params = {}) => call("engine.execute", { command, params });

  function waitForBridge() {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const tick = () => {
        if (we.frame?.contentWindow?.wordcraftBridge) return resolve();
        if (Date.now() - started > 60_000) return reject(new Error("WordCraft did not start. This needs WebGL2."));
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

  async function openBytes(bytes, name, filePath = "") {
    await exec("file.open", { path: name, data: toBase64(bytes) });
    we.path = filePath;
    we.name = name;
    showTitle();
    status(`Opened ${name}. Select text and ask, or ask about the whole document.`);
  }

  async function openPath(item) {
    setBusy(true, `Opening ${item.name}…`);
    try {
      const response = await fetch(`/word/file?path=${encodeURIComponent(item.path)}`);
      if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || "Could not open it.");
      await openBytes(new Uint8Array(await response.arrayBuffer()), item.name, item.path);
    } catch (err) {
      status(err.message);
    } finally {
      setBusy(false, we.status?.textContent);
    }
  }

  async function newDocument() {
    if (!(await leaveOk())) return;
    await exec("file.new");
    we.path = "";
    we.name = "Document.docx";
    showTitle();
    status("New document.");
  }

  /** The document as bytes in the format of name's extension. */
  async function docBytes(name) {
    const bytes = await call("bridge.save", { name });
    if (!(bytes instanceof Uint8Array)) throw new Error("WordCraft could not write it.");
    return bytes;
  }

  async function save(asName = "") {
    const name = asName || we.name;
    const backToFile = !asName && we.path && /\.(docx|odt|rtf|md|txt|html?)$/i.test(we.path);
    setBusy(true, "Saving…");
    try {
      const bytes = await docBytes(name);
      const headers = { "Content-Type": "application/octet-stream" };
      if (backToFile) headers["X-File-Path"] = encodeURIComponent(we.path);
      else headers["X-File-Name"] = encodeURIComponent(name);
      const response = await fetch("/word/save", { method: "POST", headers, body: bytes });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Could not save it.");
      if (!/\.pdf$/i.test(name)) {
        we.path = data.path;
        we.name = data.name;
        showTitle();
      }
      setBusy(false, backToFile ? `Saved ${data.name}.` : `Saved ${data.name} in Documents.`);
    } catch (err) {
      setBusy(false, err.message);
    }
  }

  async function ingest() {
    setBusy(true, "Adding it to the brain. Long documents take a minute…");
    try {
      const name = we.name.replace(/\.[^.]+$/, "") + ".docx";
      const response = await fetch("/document", {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream", "X-File-Name": encodeURIComponent(name), "X-Model": window.selectedModel?.()?.id || "" },
        body: await docBytes(name),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Could not add it.");
      addTurn("brain", `Added to the brain as "${data.title}". ${data.summary}`);
      setBusy(false, "Added to the brain. You can ask about it in the main chat.");
    } catch (err) {
      setBusy(false, err.message);
    }
  }

  async function leaveOk() {
    const state = await call("bridge.state").catch(() => null);
    if (!state?.dirty || we.closeArmed) return true;
    we.closeArmed = true;
    setTimeout(() => (we.closeArmed = false), 4000);
    status("There are unsaved changes. Click again to go on without saving.");
    return false;
  }

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
    we.log.append(item);
    we.log.scrollTop = we.log.scrollHeight;
  }

  async function selectQuote(quote) {
    try {
      await exec("select.text", { text: quote });
      return true;
    } catch {
      // Models trim or re-punctuate long quotes: try the first part, then the first sentence.
      for (const part of [quote.slice(0, 80), quote.split(/(?<=[.!?])\s/)[0]]) {
        if (part.length < 12 || part === quote) continue;
        try {
          await exec("select.text", { text: part });
          return true;
        } catch {}
      }
      return false;
    }
  }

  /** Run the model's ops. Returns the undo steps they made and any that failed. */
  async function runOps(ops) {
    let steps = 0;
    const missed = [];
    for (const op of ops) {
      const [kind, value] = Object.entries(op)[0];
      try {
        if (kind === "select") {
          if (!(await selectQuote(value))) missed.push("a passage I could not find");
        } else if (kind === "selectAll") {
          await exec("select.all");
        } else if (kind === "replace") {
          const lines = value.split("\n");
          if (lines[0]) await exec("text.insert", { text: lines[0], raw: true });
          else await exec("text.delete");
          steps += 1;
          for (const line of lines.slice(1)) {
            await exec("text.newParagraph");
            steps += 1;
            if (line) {
              await exec("text.insert", { text: line, raw: true });
              steps += 1;
            }
          }
        } else if (kind === "format") {
          await exec("format.set", { props: value });
          steps += 1;
        } else if (kind === "para") {
          await exec("para.set", { props: value });
          steps += 1;
        } else if (kind === "style") {
          await exec("para.style", { style: value });
          steps += 1;
        }
      } catch (err) {
        missed.push(`${kind}: ${err.message}`);
      }
    }
    return { steps, missed };
  }

  async function ask(request) {
    request = String(request || "").trim();
    if (!request || we.busy) return;
    addTurn("you", request);
    setBusy(true, "Thinking…");
    try {
      const [doc, sel, state] = await Promise.all([exec("document.text"), exec("document.selection"), call("bridge.state")]);
      const response = await fetch("/word/ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ request, text: doc?.text || "", selection: sel?.text || "", title: state?.title || we.name, model: window.selectedModel?.()?.id || "" }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "The model did not answer.");
      const { steps, missed } = await runOps(data.ops || []);
      const note = missed.length ? `\n\n(Not done: ${missed.join("; ")}.)` : "";
      addTurn("brain", (data.say || (steps ? "Done." : "I have nothing to change.")) + note, steps);
      setBusy(false, steps ? "Changed. Undo is under the answer." : "");
    } catch (err) {
      addTurn("brain", err.message);
      setBusy(false, "");
    }
  }

  /** Show what is selected, so the user knows what "this" means. */
  async function pollSelection() {
    if (!we.root || we.root.hidden || we.busy) return;
    try {
      const sel = await exec("document.selection");
      const text = String(sel?.text || "").trim();
      if (text === we.selText) return;
      we.selText = text;
      we.sel.textContent = text ? `Selected: “${text.length > 160 ? `${text.slice(0, 160)}…` : text}”` : "";
      we.sel.classList.toggle("we-has", Boolean(text));
    } catch {}
  }

  // ---- the panel ----

  function showTitle() {
    we.root.querySelector(".we-title").textContent = we.name;
  }

  async function recentMenu(menu) {
    menu.replaceChildren(el("div", "we-menu-note", "Loading…"));
    const data = await fetch("/word/recent").then((r) => r.json()).catch(() => ({ files: [] }));
    menu.replaceChildren(
      button("From this Mac…", "Pick a Word, ODT, RTF, Markdown or text file", () => {
        menu.classList.remove("we-open");
        picker.click();
      }),
    );
    if (data.files?.length) menu.append(el("div", "we-menu-note", "Recent in Documents, Desktop, Downloads"));
    for (const item of data.files || []) {
      const row = button(item.name, `${item.where}`, () => {
        menu.classList.remove("we-open");
        openPath(item);
      });
      row.append(el("span", "we-where", item.where));
      menu.append(row);
    }
  }

  const picker = el("input");
  picker.type = "file";
  picker.accept = ".docx,.docm,.dotx,.doc,.odt,.rtf,.md,.txt,.html,.htm";
  picker.hidden = true;
  picker.addEventListener("change", async () => {
    const file = picker.files?.[0];
    picker.value = "";
    if (!file) return;
    setBusy(true, `Opening ${file.name}…`);
    try {
      await openBytes(new Uint8Array(await file.arrayBuffer()), file.name);
    } catch (err) {
      status(err.message);
    } finally {
      setBusy(false, we.status.textContent);
    }
  });

  function saveAsMenu(menu) {
    const name = el("input", "we-name");
    name.value = we.name.replace(/\.[^.]+$/, "");
    const type = el("select", "we-type");
    for (const ext of ["docx", "pdf", "odt", "rtf", "md", "txt", "html"]) type.append(new Option(`.${ext}`, ext));
    const go = button("Save in Documents", "Save a copy in Documents", () => {
      menu.classList.remove("we-open");
      const stem = name.value.trim().replace(/[\/\\:]+/g, "-") || "Document";
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
    ["Σ", "Summarize", "Summarize the document in a short paragraph and 3 to 5 key points."],
    ["★", "Most important point (shown in the page)", "What is the most important point in this document? Show me where it is."],
    ["✎", "Improve the selected text", "Improve the writing of the selected text: clearer and more concise, same meaning."],
    ["✓", "Fix grammar and spelling in the selection", "Fix spelling, grammar and punctuation in the selected text. Change nothing else."],
    ["⇣", "Make the selection shorter", "Make the selected text shorter, keeping the facts."],
    ["Aa", "Make the selection more formal", "Make the selected text more formal and professional."],
    ["H", "Make the selected paragraph a heading", "Make the selected paragraph a Heading 1."],
    ["¶", "Tidy the formatting", "Make the formatting consistent: headings as heading styles, body text Normal, justified body paragraphs."],
  ];

  function build() {
    const root = el("section", "panel wordpanel");
    root.setAttribute("aria-label", "Word document");
    const bar = el("div", "we-bar");
    bar.append(
      el("span", "we-title"),
      el("span", "we-gap"),
      tool("＋", "New document", newDocument),
      dropdown("📂", "Open a document", recentMenu),
      tool("💾", "Save (back to its file, or in Documents)", () => save()),
      dropdown("⤓", "Save as Word, PDF, Markdown…", saveAsMenu),
      tool("🧠", "Ingest: add this document to the brain's notes", ingest, "we-ai"),
      el("span", "we-sep"),
    );
    for (const [icon, tip, request] of QUICK) bar.append(tool(icon, tip, () => ask(request), "we-ai"));
    bar.append(el("span", "we-sep"), tool("✕", "Close Word (the document stays open)", close), picker);
    we.sel = el("div", "we-sel");
    we.log = el("div", "we-log");
    we.status = el("div", "we-status");
    we.frame = el("iframe", "we-frame");
    we.frame.src = "/wordcraft/index.html?embed";
    we.frame.title = "WordCraft";
    root.append(bar, we.sel, we.log, we.status, we.frame);
    document.querySelector("main.layout").append(root);
    document.addEventListener("click", () => document.querySelectorAll(".we-menu.we-open").forEach((m) => m.classList.remove("we-open")));
    we.root = root;
    showTitle();
    we.ready = waitForBridge();
    we.ready
      .then(async () => {
        const state = await call("bridge.state");
        if (!state.hasDocument) await exec("file.new");
      })
      .catch((err) => status(err.message));
  }

  function show(on) {
    document.querySelector("main.layout")?.classList.toggle("word-on", on);
    we.root.hidden = !on;
    btn?.classList.toggle("is-on", on);
  }

  async function open() {
    const installed = await fetch("/word/installed").then((r) => r.json()).catch(() => ({}));
    if (!installed.installed) {
      const statusEl = document.getElementById("statusText");
      if (statusEl) statusEl.textContent = "The Word editor is not installed. Run voice/install-wordcraft.sh, then reload.";
      return;
    }
    if (!we.root) build();
    window.brainSlides?.close();
    window.brainR?.close();
    show(true);
    clearInterval(we.poll);
    we.poll = setInterval(pollSelection, 800);
  }

  function close() {
    if (!we.root) return;
    show(false);
    clearInterval(we.poll);
  }

  /** A sentence heard while the editor is open: only "Hey, …" counts, like the deck editor. */
  let lastHeard = { words: "", at: 0 };
  function hear(raw) {
    const said = window.questionAfterWake ? window.questionAfterWake(raw) : String(raw || "").trim();
    if (said === null || we.busy) return;
    if (!said) {
      status("Listening: say the request.");
      return;
    }
    const key = said.toLowerCase().replace(/[^\p{L}\p{N} ]+/gu, "").trim();
    if (key === lastHeard.words && Date.now() - lastHeard.at < 30_000) return;
    lastHeard = { words: key, at: Date.now() };
    if (/^(close|exit|leave)( the)? (editor|document|word)$|^(done|i'?m done)$/i.test(key)) return close();
    if (/^(save|save it|save the document)$/i.test(key)) return save();
    if (/^undo( that)?$/i.test(key)) return exec("edit.undo").then(() => status("Undone.")).catch((err) => status(err.message));
    if (said.split(/\s+/).length >= 2) ask(said);
  }

  /** "open the word editor" from the main chat. */
  function command(question) {
    if (!/\b(open|show|start)\b.*\b(word (editor|processor|document)|wordcraft|document editor)\b/i.test(String(question || ""))) return false;
    open();
    return true;
  }

  btn?.addEventListener("click", () => (we.root && !we.root.hidden ? close() : open()));
  window.brainWord = {
    get open() {
      return Boolean(we.root && !we.root.hidden);
    },
    openEditor: open,
    close,
    ask,
    hear,
    command,
  };
})();
