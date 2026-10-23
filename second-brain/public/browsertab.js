// The Browser tab, in place of the transcript. A real web view (WebKit, made by the app
// window, rust/window/src/pane.rs) sits over the empty area; this page tells the window where.
// You browse in it, and the browser agent (rust/src/browser) works in it while you watch.
// Orders go through the chat box: while this tab is open, what you type or say is for the browser.
// The agent's steps are written in the chat, as one Browser message per task.
// Bookmarks are kept by the Rust server (GET/POST /browser/bookmarks).
(() => {
  const btn = document.getElementById("browserBtn");
  const inApp = Boolean(window.ipc && window.ipc.postMessage);
  const br = { root: null, view: null, address: null, status: null, star: null, marks: null, url: "", title: "", bookmarks: [], run: null };

  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  };

  function button(label, title, action) {
    const node = el("button", "ghost-btn small", label);
    node.type = "button";
    node.title = title;
    node.addEventListener("click", (event) => {
      event.stopPropagation();
      action(node);
    });
    return node;
  }

  const tell = (data) => inApp && window.ipc.postMessage(`browser ${JSON.stringify(data)}`);

  /** "cnn.com" opens the site; words with spaces are a search. */
  function addressFor(text) {
    const t = text.trim();
    if (!t) return "";
    if (/^[a-z]+:\/\//i.test(t) || t.startsWith("about:")) return t;
    if (!/\s/.test(t) && /\.[a-z]{2,}(?:[/:?#]|$)/i.test(t)) return `https://${t}`;
    return `https://duckduckgo.com/?q=${encodeURIComponent(t)}`;
  }

  function go(url) {
    if (!url) return;
    tell({ go: url });
    // The app answers with loaded(); an older copy of the app has no browser view.
    clearTimeout(br.waiting);
    br.waiting = setTimeout(() => {
      br.status.textContent = "No answer from the app's browser. Quit Second Brain (Cmd+Q) and open it again.";
    }, 4000);
  }

  // ---- where the web view goes ----

  function place() {
    if (!br.root || br.root.hidden) return;
    const r = br.view.getBoundingClientRect();
    tell({ bounds: { x: r.left, y: r.top, w: r.width, h: r.height } });
  }

  // ---- bookmarks ----

  const marked = () => br.bookmarks.some((b) => b.url === br.url);

  function drawBookmarks() {
    br.star.textContent = marked() ? "★" : "☆";
    br.star.title = marked() ? "Remove this bookmark" : "Bookmark this page";
    br.star.disabled = !/^https?:/.test(br.url);
    br.marks.replaceChildren(...br.bookmarks.map((b) => {
      const chip = el("span", "br-mark");
      // One click opens it; a double click edits it, so the click waits a moment first.
      let clickTimer = null;
      const open = button(b.title || b.url, `${b.url}\nDouble-click to edit`, () => {
        clearTimeout(clickTimer);
        clickTimer = setTimeout(() => go(b.url), 250);
      });
      open.addEventListener("dblclick", (event) => {
        event.stopPropagation();
        clearTimeout(clickTimer);
        editBookmark(chip, b);
      });
      const remove = button("×", "Remove this bookmark", () => saveBookmarks(br.bookmarks.filter((x) => x.url !== b.url)));
      remove.classList.add("br-mark-x");
      chip.append(open, remove);
      return chip;
    }));
    br.marks.hidden = !br.bookmarks.length;
    requestAnimationFrame(place);
  }

  /** The chip becomes a small form: name and address. Enter saves, Esc cancels. */
  function editBookmark(chip, b) {
    const form = el("form", "br-mark-edit");
    const name = el("input", "br-mark-name");
    name.value = b.title || "";
    name.placeholder = "Name";
    name.setAttribute("aria-label", "Bookmark name");
    const address = el("input", "br-mark-url");
    address.value = b.url;
    address.placeholder = "Address";
    address.setAttribute("aria-label", "Bookmark address");
    address.spellcheck = false;
    const save = el("button", "ghost-btn small", "Save");
    save.type = "submit";
    form.append(name, address, save, button("Cancel", "Keep it as it was", drawBookmarks));
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      let url = address.value.trim();
      if (url && !/^https?:\/\//i.test(url)) url = `https://${url}`;
      if (!/^https?:\/\/\S+$/i.test(url)) {
        address.focus();
        br.status.textContent = "A bookmark needs a web address.";
        return;
      }
      const title = name.value.trim() || url;
      saveBookmarks(br.bookmarks.map((x) => (x.url === b.url ? { url, title } : x)).filter((x, i, all) => all.findIndex((y) => y.url === x.url) === i));
    });
    form.addEventListener("keydown", (event) => {
      if (event.key === "Escape") drawBookmarks();
    });
    chip.replaceWith(form);
    name.focus();
    name.select();
    requestAnimationFrame(place);
  }

  async function loadBookmarks() {
    try {
      const res = await fetch("/browser/bookmarks");
      br.bookmarks = (await res.json()).bookmarks || [];
    } catch (err) {
      console.error("Failed while loading bookmarks:", err);
    }
    drawBookmarks();
  }

  async function saveBookmarks(list) {
    try {
      const res = await fetch("/browser/bookmarks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bookmarks: list }),
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
      br.bookmarks = (await res.json()).bookmarks || [];
    } catch (err) {
      console.error("Failed while saving bookmarks:", err);
      br.status.textContent = "The bookmark was not saved.";
    }
    drawBookmarks();
  }

  function toggleBookmark() {
    if (marked()) saveBookmarks(br.bookmarks.filter((b) => b.url !== br.url));
    else saveBookmarks([...br.bookmarks, { url: br.url, title: (br.title || br.url).slice(0, 60) }]);
  }

  // ---- panel ----

  function build() {
    const root = el("section", "panel brpanel");
    root.hidden = true;

    const bar = el("form", "br-bar");
    br.address = el("input", "br-address");
    br.address.placeholder = "Address or search";
    br.address.setAttribute("aria-label", "Address");
    br.address.spellcheck = false;
    bar.addEventListener("submit", (event) => {
      event.preventDefault();
      go(addressFor(br.address.value));
    });
    br.status = el("span", "br-status", "");
    br.star = button("☆", "Bookmark this page", toggleBookmark);
    const chat = button("Chat", "Back to the chat (Shift-Cmd-B switches)", () => show(false));
    chat.classList.add("br-chat");
    bar.append(
      chat,
      button("‹", "Back", () => tell({ history: "back" })),
      button("›", "Forward", () => tell({ history: "forward" })),
      button("↻", "Reload", () => tell({ history: "reload" })),
      br.address,
      br.star,
      br.status,
    );
    br.marks = el("div", "br-marks");
    br.marks.hidden = true;

    br.view = el("div", "br-view");
    if (!inApp) br.view.append(el("p", "br-note", "Open this in the Second Brain app to browse here."));
    root.append(bar, br.marks, br.view);
    document.querySelector("main.layout").append(root);
    br.root = root;
    new ResizeObserver(place).observe(br.view);
    window.addEventListener("resize", place);
    // Another tab opening in its place (Plans, Calendar, …) closes this one.
    new MutationObserver(() => {
      const layout = document.querySelector("main.layout");
      if (!root.hidden && [...layout.classList].some((c) => c.endsWith("-on") && c !== "browser-on")) show(false);
    }).observe(document.querySelector("main.layout"), { attributes: true, attributeFilter: ["class"] });
    drawBookmarks();
    loadBookmarks();
  }

  function show(on) {
    if (!br.root) build();
    document.querySelector("main.layout")?.classList.toggle("browser-on", on);
    br.root.hidden = !on;
    btn?.classList.toggle("is-on", on);
    btn?.setAttribute("aria-pressed", on ? "true" : "false");
    if (on) requestAnimationFrame(place);
    else tell({ hide: true });
    const typeInput = document.getElementById("typeInput");
    if (typeInput) typeInput.placeholder = on ? "Tell the browser what to do" : typeInput.dataset.chatPlaceholder || "";
  }

  function open() {
    window.brainWord?.close();
    window.brainSlides?.close();
    window.brainR?.close();
    window.brainPhoto?.close();
    window.brainMovie?.close();
    window.brainStickies?.close();
    window.brainCalendar?.close();
    window.brainPlans?.close();
    window.brainScreen?.close();
    show(true);
  }

  const typeInput = document.getElementById("typeInput");
  if (typeInput) typeInput.dataset.chatPlaceholder = typeInput.placeholder;

  // ---- the agent's steps, written in the chat ----

  function runBubble() {
    const bubble = addBubble("browser", "");
    bubble.querySelector(".who").textContent = "Browser";
    const body = bubble.querySelector(".text");
    const head = el("div", "br-run-head", "Starting…");
    const plan = el("ol", "br-run-plan");
    const log = el("ul", "br-run-log");
    body.append(head, plan, log);
    return { bubble, head, plan, log };
  }

  function note(text, cls) {
    if (!br.run) br.run = runBubble();
    br.run.log.append(el("li", cls || "", text));
    followTranscript();
  }

  function showPlan(plan, current) {
    if (!br.run) return;
    br.run.plan.replaceChildren(...(plan || []).map((item, i) => el("li", i < current ? "past" : i === current ? "now" : "", item)));
  }

  control.addEventListener("browser", (event) => {
    const ev = JSON.parse(event.data || "{}");
    if (!br.root) build();
    if (ev.type === "plan") {
      br.status.textContent = "Plan ready in Chat. Say yes to start.";
    } else if (ev.type === "start") {
      br.run = runBubble();
      showPlan(ev.plan, 0);
      br.status.textContent = "Starting";
    } else if (ev.type === "where" && ev.in === "chrome") {
      note("The app window was not open, so it is working in its own Chrome window.");
    } else if (ev.type === "thinking") {
      if (br.run) br.run.head.textContent = `Step ${ev.step} of ${ev.max}: deciding what to do`;
      br.status.textContent = `Step ${ev.step}/${ev.max}`;
    } else if (ev.type === "step") {
      if (br.run) br.run.head.textContent = `Step ${ev.step} of ${ev.max}: ${ev.goal || ""}`;
      showPlan(ev.plan, ev.current);
      if (ev.evaluation) note(ev.evaluation, "eval");
    } else if (ev.type === "action") {
      note(`→ ${ev.text}`);
    } else if (ev.type === "error") {
      note(ev.message, "err");
    } else if (ev.type === "done") {
      if (br.run) br.run.head.textContent = ev.success ? `Done in ${ev.steps} steps` : `Stopped after ${ev.steps} steps`;
      note(ev.text, ev.success ? "done" : "err");
      br.status.textContent = ev.success ? "Done" : "Stopped";
      br.run = null;
    }
  });

  window.brainBrowser = {
    get open() {
      return Boolean(br.root && !br.root.hidden);
    },
    openPanel: open,
    close: () => br.root && show(false),
    toggle: () => (br.root && !br.root.hidden ? show(false) : open()),
    // From the app window, as the web view loads.
    loaded(url, done) {
      if (!br.root) return;
      clearTimeout(br.waiting);
      br.url = url === "about:blank" ? "" : url;
      if (document.activeElement !== br.address) br.address.value = br.url;
      if (!/^Step|^Starting|^Plan/.test(br.status.textContent)) br.status.textContent = done ? "" : "Loading…";
      drawBookmarks();
    },
    titled(title) {
      br.title = title;
      if (br.root) br.address.title = title;
    },
  };

  btn?.addEventListener("click", () => window.brainBrowser.toggle());
})();
