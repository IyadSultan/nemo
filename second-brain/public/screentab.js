// Screen recorder panel. Record the whole screen plus sound. While it records, the
// words can show in a strip at the bottom of the screen as they are said (the app
// window draws it; see rust/window/src/captions.rs), and Recap sums up so far with
// questions to ask. When it stops, the captions and the summary are written on their own.
(() => {
  const btn = document.getElementById("screenBtn");
  const sc = {
    root: null,
    status: null,
    list: null,
    main: null,
    title: null,
    recording: null,
    selected: null,
    busy: false,
    timer: 0,
    poll: 0,
    recaps: null,
    lastLine: "",
    captionsOn: localStorage.getItem("screenCaptionsOn") !== "off",
    lang: localStorage.getItem("screenCaptionLang") === "ar" ? "ar" : "en",
  };

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

  /** The caption strip on the screen, drawn by the app window. Nothing happens in a browser tab. */
  function strip(data) {
    if (window.ipc?.postMessage) window.ipc.postMessage(`captions ${JSON.stringify(data)}`);
  }

  function paintCaptionsButton() {
    if (!sc.capBtn) return;
    sc.capBtn.classList.toggle("is-on", sc.captionsOn);
    sc.capBtn.setAttribute("aria-pressed", sc.captionsOn ? "true" : "false");
  }

  function paintLangButton() {
    if (!sc.langBtn) return;
    sc.langBtn.textContent = sc.lang === "ar" ? "عربي" : "English";
  }

  function toggleLang() {
    sc.lang = sc.lang === "ar" ? "en" : "ar";
    localStorage.setItem("screenCaptionLang", sc.lang);
    paintLangButton();
    setNote(sc.recording
      ? "The language changes at the next recording. The saved captions hear both."
      : `The live words will be heard as ${sc.lang === "ar" ? "Arabic" : "English"}. The saved captions after Stop hear both.`);
  }

  function toggleCaptions() {
    sc.captionsOn = !sc.captionsOn;
    localStorage.setItem("screenCaptionsOn", sc.captionsOn ? "on" : "off");
    paintCaptionsButton();
    if (!sc.captionsOn) strip({ hide: true });
    setNote(sc.captionsOn ? "The words will show at the bottom of the screen while it records." : "No words on the screen. The recap and the summary still work.");
  }

  function clock(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const pad = (n) => String(n).padStart(2, "0");
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return h ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
  }

  function setNote(text) {
    if (sc.status) sc.status.textContent = text;
  }

  function say(text) {
    if (typeof addBubble === "function") {
      const bubble = addBubble("assistant", text, false);
      const who = bubble?.querySelector(".who");
      if (who) who.textContent = "Screen";
    }
    if (typeof setStatus === "function") setStatus(text);
  }

  function paintButton() {
    const open = Boolean(sc.root && !sc.root.hidden);
    const on = Boolean(sc.recording);
    btn?.classList.toggle("is-on", open || on);
    btn?.classList.toggle("is-recording", on);
    btn?.setAttribute("aria-pressed", open ? "true" : "false");
    if (on && sc.recording?.startedAt) {
      const elapsed = clock(Date.now() - Date.parse(sc.recording.startedAt));
      btn.title = `Recording ${elapsed}. Click to show the controls. The recording keeps going if you close this panel.`;
    } else {
      btn.title = "Record the whole screen and the sound. Captions, a summary, and a recap can be ticked while it records.";
    }
  }

  async function send(url, body) {
    let response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body || {}),
      });
    } catch (err) {
      console.error("Failed while talking to the screen recorder:", err);
      throw new Error("The screen recorder is not running. Restart Second Brain, then try again.");
    }
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      if (!data && response.status === 404) throw new Error("Restart Second Brain so the screen recorder can start, then try again.");
      throw new Error(data?.error || "The screen recorder could not do that.");
    }
    return data;
  }

  async function loadList() {
    const response = await fetch("/screen/list");
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new Error(data?.error || "The recordings could not be read.");
    return data.recordings || [];
  }

  function show(on) {
    if (!sc.root) build();
    document.querySelector("main.layout")?.classList.toggle("screen-on", on);
    sc.root.hidden = !on;
    paintButton();
    if (on && !sc.busy) refresh().catch((err) => setNote(err.message));
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
    window.brainBrowser?.close();
    show(true);
  }

  function build() {
    const root = el("section", "panel scpanel");
    root.hidden = true;
    const bar = el("div", "sc-bar");
    sc.status = el("span", "sc-status", "");
    sc.title = el("input", "sc-title");
    sc.title.type = "text";
    sc.title.placeholder = "Name, such as budget review";
    sc.title.setAttribute("aria-label", "Recording name");
    sc.title.maxLength = 80;

    sc.recordBtn = button("Record", "Record the whole screen, Zoom or other app sound, and your microphone.", () => start());
    sc.recordBtn.classList.add("sc-record");
    sc.stopBtn = button("Stop", "Stop and save the recording.", () => stop());
    sc.stopBtn.disabled = true;
    sc.capBtn = button("Captions", "Show the words at the bottom of the screen while it records. Click to turn off or on.", toggleCaptions);
    paintCaptionsButton();
    sc.langBtn = button("English", "The language of the live words: English or Arabic, one per recording. Click to switch. The saved captions hear both.", toggleLang);
    paintLangButton();

    bar.append(
      el("span", "cal-title", "Screen"),
      sc.title,
      sc.recordBtn,
      sc.stopBtn,
      sc.capBtn,
      sc.langBtn,
      sc.status,
      el("span", "cal-gap"),
      button("Close", "Show the chat again. A recording that is running keeps going.", () => show(false)),
    );

    const note = el("p", "sc-note", "Records the whole screen, the sound from Zoom or any other app, and your microphone. Put the call or the lesson in front before you press Record. The first time, macOS asks to allow Screen Recording and the Microphone for Second Brain.");
    sc.list = el("div", "sc-list");
    sc.main = el("div", "sc-main");
    const body = el("div", "sc-body");
    body.append(sc.list, sc.main);
    root.append(bar, note, body);
    document.querySelector("main.layout").append(root);
    sc.root = root;

    new MutationObserver(() => {
      const layout = document.querySelector("main.layout");
      if (!root.hidden && [...layout.classList].some((name) => name.endsWith("-on") && name !== "screen-on")) show(false);
    }).observe(document.querySelector("main.layout"), { attributes: true, attributeFilter: ["class"] });
  }

  function drawList(items) {
    sc.list.replaceChildren();
    if (!items.length) {
      sc.list.append(el("p", "sc-empty", "No recordings yet. Press Record."));
      return;
    }
    for (const item of items) {
      const row = button(item.title || "Recording", "Open this recording.", () => select(item.id));
      row.classList.add("sc-item");
      if (sc.selected === item.id) row.classList.add("is-on");
      const when = item.startedAt ? new Date(item.startedAt).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "";
      const state = item.status === "recording" ? "Recording" : item.status === "saving" ? "Saving" : item.status === "failed" ? "Failed" : item.seconds ? clock(item.seconds * 1000) : "Saved";
      row.append(el("span", "sc-item-meta", `${when} · ${state}`));
      sc.list.append(row);
    }
  }

  function addLine(line) {
    if (sc.captionsOn) strip({ text: line.text, prev: sc.lastLine });
    // A partial line is still being said; the finished one replaces it.
    if (!line.partial) sc.lastLine = line.text;
  }

  function addRecap(text) {
    if (!sc.recaps) return;
    sc.recaps.prepend(el("h3", "sc-head", `Recap at ${new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`), el("p", "sc-text", text));
  }

  // A recap while it records. Stop stays usable, so this does not set sc.busy.
  async function liveRecap(node) {
    if (!sc.recording) return;
    node.disabled = true;
    setNote("Writing the recap…");
    try {
      await send(`/screen/${sc.recording.id}/recap`, { model: document.getElementById("modelSelect")?.value || "" });
      setNote("The recap is on the screen.");
      say("The recap is on the screen.");
    } catch (err) {
      console.error("Failed while writing a live recap:", err);
      setNote(err.message);
      say(err.message);
      if (sc.stripRecap) strip({ recap: err.message });
      sc.stripRecap = false;
    } finally {
      node.disabled = false;
    }
  }

  // The ✦ on the caption strip: the same recap, shown in a panel on the screen
  // (the app window calls this; see rust/window/src/captions.rs).
  window.screenStripRecap = () => {
    if (!sc.recording) {
      strip({ recap: "Not recording." });
      return;
    }
    sc.stripRecap = true;
    strip({ recap: "Writing the recap…", busy: true });
    liveRecap({});
  };

  function drawMain(item) {
    sc.main.replaceChildren();
    clearTimeout(sc.poll);
    if (!item) {
      sc.main.append(el("p", "sc-empty", "Choose a recording, or press Record."));
      return;
    }
    if (item.status === "saving") {
      sc.main.append(el("p", "sc-empty", "Saving the video…"));
      return;
    }
    if (item.status === "recording") {
      const where = sc.captionsOn ? "Recording. The words show at the bottom of the screen as they are said." : "Recording. Press Captions in the bar to see the words on the screen.";
      const actions = el("div", "sc-actions");
      actions.append(button("Recap so far", "Sum up what was said so far, with questions you could ask. Press it any time.", (node) => liveRecap(node)));
      sc.recaps = el("div", "sc-recaps");
      if (item.recap) addRecap(item.recap);
      sc.main.append(el("p", "sc-empty", where), actions, sc.recaps, el("p", "sc-note", "Captions on the video and a summary are written when you press Stop."));
      return;
    }
    if (item.status === "failed") {
      const actions = el("div", "sc-actions");
      actions.append(deleteButton(item.id));
      sc.main.append(el("p", "sc-empty", item.error || "This recording did not finish."), actions);
      return;
    }
    const video = el("video", "sc-video");
    video.controls = true;
    video.playsInline = true;
    if (item.captions?.length) {
      const track = el("track");
      track.kind = "captions";
      track.label = "Captions";
      track.srclang = "en";
      track.src = `/screen/${item.id}/captions.vtt?t=${Date.now()}`;
      track.default = true;
      video.append(track);
    }
    video.src = `/screen/${item.id}/video`;
    const actions = el("div", "sc-actions");
    const recap = button(item.recap ? "Recap again" : "Recap", "A short recap with questions to ask next.", () => runJob("recap", item.id));
    const finder = button("Show in Finder", "Show the video file on this Mac.", () => send(`/screen/${item.id}/reveal`).catch((err) => setNote(err.message)));
    actions.append(recap);
    // Captions and the summary are written on their own after Stop. A button only when that failed.
    if (!item.working && !item.captions?.length) actions.append(button("Try captions again", "Listen to the recording and write captions on the video.", () => runJob("captions", item.id)));
    else if (!item.working && !item.summary) actions.append(button("Try the summary again", "Main points, decisions and steps, action items.", () => runJob("summary", item.id)));
    actions.append(finder, deleteButton(item.id));
    if (sc.busy || item.working) for (const node of actions.children) if (!node.classList.contains("sc-delete")) node.disabled = true;
    sc.main.append(video, actions);
    if (item.working) {
      const waiting = { captions: "Writing the captions from the sound. A long meeting can take several minutes. The summary comes next.", summary: "Writing the summary…", recap: "Writing the recap…" };
      sc.main.append(el("p", "sc-note", waiting[item.working] || "Working…"));
      setNote(waiting[item.working] || "Working…");
      sc.poll = setTimeout(() => select(item.id).catch(() => {}), 3000);
    }
    if (item.warning) sc.main.append(el("p", "sc-warn", item.warning));
    if (item.summary) sc.main.append(el("h3", "sc-head", "Summary"), el("p", "sc-text", item.summary));
    if (item.recap) sc.main.append(el("h3", "sc-head", "Recap"), el("p", "sc-text", item.recap));
  }

  // No dialogs in the app window, so the first click asks and the second one deletes.
  function deleteButton(id) {
    const node = button("Delete", "Delete this recording, its video, captions and write-ups.", async () => {
      if (!node.classList.contains("is-asking")) {
        node.classList.add("is-asking");
        node.textContent = "Delete for good?";
        node.asking = setTimeout(() => {
          node.classList.remove("is-asking");
          node.textContent = "Delete";
        }, 5000);
        return;
      }
      clearTimeout(node.asking);
      node.disabled = true;
      try {
        await send(`/screen/${id}/delete`);
        if (sc.selected === id) sc.selected = null;
        drawMain(null);
        drawList(await loadList());
        setNote("Deleted.");
      } catch (err) {
        console.error("Failed while deleting a recording:", err);
        node.disabled = false;
        setNote(err.message);
      }
    });
    node.classList.add("sc-delete");
    return node;
  }

  async function select(id) {
    sc.selected = id;
    setNote("Opening…");
    try {
      const response = await fetch(`/screen/${id}`);
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new Error(data?.error || "That recording could not be opened.");
      drawMain(data.recording);
      const items = await loadList();
      drawList(items);
    } catch (err) {
      console.error("Failed while opening a recording:", err);
      setNote(err.message);
    }
  }

  async function refresh() {
    const [items, activeRes] = await Promise.all([
      loadList(),
      fetch("/screen/active").then((response) => response.json()).catch(() => ({ recording: null })),
    ]);
    sc.recording = activeRes.recording && activeRes.recording.status === "recording" ? activeRes.recording : null;
    syncRecordButtons();
    drawList(items);
    if (!sc.selected && items[0]) sc.selected = items[0].id;
    if (sc.selected) await select(sc.selected);
    else drawMain(null);
  }

  function syncRecordButtons() {
    const on = Boolean(sc.recording);
    if (sc.recordBtn) sc.recordBtn.disabled = on || sc.busy;
    if (sc.stopBtn) sc.stopBtn.disabled = !on || sc.busy;
    sc.stopBtn?.classList.toggle("is-recording", on);
    if (sc.title) sc.title.disabled = on;
    paintButton();
    clearInterval(sc.timer);
    if (on) sc.timer = setInterval(paintButton, 1000);
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // The app window starts the recorder. Keep asking until it is really going.
  async function waitUntilReady(id) {
    const deadline = Date.now() + 180000;
    while (Date.now() < deadline) {
      const response = await fetch(`/screen/${id}/boot`);
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new Error(data?.error || "The recording did not start.");
      if (data?.ready) return data;
      if (data?.error) throw new Error(data.error);
      await sleep(300);
    }
    throw new Error("The recording did not start. If macOS asked, allow Screen Recording and the Microphone for Second Brain, then try again.");
  }

  async function start(title) {
    if (sc.recording || sc.busy) {
      say("A recording is already running.");
      return;
    }
    if (!sc.root) build();
    sc.busy = true;
    if (title && sc.title) sc.title.value = title;
    open();
    syncRecordButtons();
    if (!window.ipc) {
      sc.busy = false;
      syncRecordButtons();
      const message = "Open the Second Brain app to record the screen. A browser tab cannot record the whole screen.";
      setNote(message);
      say(message);
      return;
    }
    setNote("Waiting for the recording to start. If macOS asks, allow Screen Recording and the Microphone for Second Brain.");
    say("Starting the screen recording. Allow it if macOS asks.");
    try {
      const data = await send("/screen/start", { title: sc.title?.value || "", lang: sc.lang });
      window.ipc.postMessage("screen-start " + JSON.stringify(data.spawn));
      const ready = await waitUntilReady(data.recording.id);
      sc.recording = ready.recording || data.recording;
      sc.selected = data.recording.id;
      sc.lastLine = "";
      sc.busy = false;
      syncRecordButtons();
      setNote("Recording. Press Stop when you are done.");
      say("Recording the screen. The words appear as they are said. Ask for a recap at any time.");
      await refresh();
    } catch (err) {
      console.error("Failed while starting the screen recording:", err);
      sc.busy = false;
      sc.recording = null;
      syncRecordButtons();
      setNote(err.message);
      say(err.message);
    }
  }

  async function stop() {
    if (sc.busy) return;
    if (!sc.recording) {
      say("There is no screen recording to stop.");
      return;
    }
    const id = sc.recording.id;
    sc.busy = true;
    syncRecordButtons();
    setNote("Saving the video…");
    try {
      const data = await send("/screen/stop", { id, model: document.getElementById("modelSelect")?.value || "" });
      sc.recording = null;
      strip({ hide: true });
      sc.selected = data.recording.id;
      sc.busy = false;
      syncRecordButtons();
      const extra = data.recording.warning ? ` ${data.recording.warning}` : "";
      const next = data.recording.working ? " Writing the captions and the summary now." : "";
      setNote(`Saved.${extra}${next}`);
      say(`Saved the recording.${extra}${next}`);
      noteChatFile({
        name: data.recording.title || "screen recording",
        title: data.recording.title || "screen recording",
        summary: "A screen recording saved from this chat.",
        made: true,
      });
      await refresh();
    } catch (err) {
      console.error("Failed while stopping the screen recording:", err);
      strip({ hide: true });
      sc.busy = false;
      // The server may have ended it even so. Stop must not stay lit for a recording that is gone.
      await syncActive();
      syncRecordButtons();
      setNote(err.message);
      say(err.message);
      refresh().catch(() => {});
    }
  }

  /** Ask the server which recording runs now, if any. */
  async function syncActive() {
    try {
      const data = await (await fetch("/screen/active")).json();
      sc.recording = data?.recording?.status === "recording" ? data.recording : null;
    } catch {
      sc.recording = null;
    }
  }

  async function runJob(job, id) {
    const target = id || sc.selected;
    if (!target) {
      say("Record something first.");
      return;
    }
    if (sc.busy) return;
    open();
    sc.selected = target;
    sc.busy = true;
    syncRecordButtons();
    const waiting = {
      captions: "Writing captions from the sound. A long meeting can take several minutes.",
      summary: "Writing the summary…",
      recap: "Writing the recap…",
    };
    setNote(waiting[job] || "Working…");
    try {
      const data = await send(`/screen/${target}/${job}`, {
        model: document.getElementById("modelSelect")?.value || "",
      });
      sc.busy = false;
      syncRecordButtons();
      const done = { captions: "Captions are on the video.", summary: "The summary is ready.", recap: "The recap is ready." };
      setNote(done[job] || "Done.");
      say(done[job] || "Done.");
      drawMain(data.recording);
      drawList(await loadList());
    } catch (err) {
      console.error(`Failed while ${waiting[job] || job}:`, err);
      sc.busy = false;
      syncRecordButtons();
      setNote(err.message);
      say(err.message);
    }
  }

  window.brainScreen = {
    get open() {
      return Boolean(sc.root && !sc.root.hidden);
    },
    openPanel: open,
    close: () => sc.root && show(false),
    // A spoken order, such as "record the screen". Returns true when this panel handled it.
    handle(question) {
      if (typeof parseScreenCommand !== "function") return false;
      const order = parseScreenCommand(question);
      if (!order) return false;
      if (order.op === "open") {
        open();
        say("The screen recorder is open.");
        return true;
      }
      if (order.op === "close") {
        show(false);
        say("Closed the screen recorder. A recording that is running keeps going until you press Stop.");
        return true;
      }
      if (order.op === "start") {
        start(order.title);
        return true;
      }
      if (order.op === "stop") {
        stop();
        return true;
      }
      if (sc.recording) {
        open();
        if (order.op === "recap") {
          const node = sc.main?.querySelector(".sc-actions button");
          if (node) liveRecap(node);
        } else {
          if (order.op === "captions" && !sc.captionsOn) toggleCaptions();
          else say(order.op === "captions" ? "The words are already on the screen." : "The summary is written when you press Stop.");
        }
        return true;
      }
      runJob(order.op);
      return true;
    },
  };

  btn?.addEventListener("click", () => {
    if (sc.root && !sc.root.hidden) show(false);
    else open();
  });

  control.addEventListener("screen", (event) => {
    const ev = JSON.parse(event.data || "{}");
    if (ev.type === "line" && sc.recording?.id === ev.id) addLine(ev);
    else if (ev.type === "note" && sc.recording?.id === ev.id) setNote(ev.text);
    else if (ev.type === "recap" && sc.recording?.id === ev.id) {
      addRecap(ev.text);
      if (sc.stripRecap) strip({ recap: ev.text });
      sc.stripRecap = false;
    }
    else if (ev.type === "ready" && sc.selected === ev.id && !sc.recording) {
      select(ev.id).catch(() => {});
      say("The captions and the summary are ready.");
    }
  });

  // After a reload, a recording may still be running. Know that before any spoken order.
  fetch("/screen/active")
    .then((response) => response.json())
    .then((data) => {
      if (data?.recording?.status !== "recording") return;
      if (!sc.root) build();
      sc.recording = data.recording;
      sc.selected = data.recording.id;
      syncRecordButtons();
    })
    .catch(() => {});
})();
