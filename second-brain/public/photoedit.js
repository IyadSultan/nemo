// Photos in the app: PhotoCraft (vendor/photocraft, voice/install-photocraft.sh) in the
// right-hand panel, in place of the transcript. The buttons and "Hey, rotate it" run
// PhotoCraft's engine. The large area is PhotoCraft itself, for crop, layers, and the rest.
// A picture taken with Photo, or opened here, is what those edits change.
(() => {
  const btn = document.getElementById("photoEditBtn");
  const pe = {
    root: null,
    frame: null,
    status: null,
    preview: null,
    picker: null,
    image: "",
    name: "Photo.jpg",
    mime: "image/jpeg",
    busy: false,
    past: [],
    onReplace: null,
    ready: null,
  };

  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  };

  function status(text) {
    if (pe.status) pe.status.textContent = text || "";
  }

  function setBusy(on) {
    pe.busy = on;
    pe.root?.classList.toggle("pe-busy", on);
    pe.root?.querySelectorAll(".pe-edit").forEach((node) => {
      node.disabled = on;
    });
  }

  // Words for a change, typed in the ask box or said after Hey.
  function editFor(text) {
    const q = String(text || "").toLowerCase().replace(/[^\p{L}\p{N}& ]+/gu, " ").replace(/\s+/g, " ").trim();
    if (!q) return null;
    if (/^(undo|undo that)$/.test(q)) return { undo: true };
    if (/^(save|save it|save the photo|save the picture)$/.test(q)) return { save: true };
    if (/^(close|close it|done|i m done|im done)$/.test(q) || /^(close|leave) the (editor|photo|picture)$/.test(q)) return { close: true };
    if (/rotate|turn/.test(q) && /left|counter/.test(q)) return { id: "image.imageRotation.90ccw", label: "Rotated left" };
    if (/rotate|turn/.test(q) && /right|clockwise/.test(q)) return { id: "image.imageRotation.90cw", label: "Rotated right" };
    if (/upside down|rotate 180|turn 180/.test(q)) return { id: "image.imageRotation.180", label: "Turned upside down" };
    if (/flip|mirror/.test(q) && /vertical|up and down/.test(q)) return { id: "image.imageRotation.flipCanvasVertical", label: "Flipped vertically" };
    if (/^(flip|flip it|mirror|mirror it)$/.test(q) || /flip horizontal|mirror horizontal/.test(q)) return { id: "image.imageRotation.flipCanvasHorizontal", label: "Flipped" };
    if (/black and white|white and black|black white|white black|grayscale|gr[ae]y ?scale|monochrome|desaturate/.test(q)) return { id: "image.adjustments.desaturate", label: "Black and white" };
    if (/sharpen/.test(q)) return { id: "filter.sharpen.sharpen", label: "Sharpened" };
    if (/auto tone/.test(q)) return { id: "image.autoTone", label: "Auto tone" };
    if (/auto contrast/.test(q)) return { id: "image.autoContrast", label: "Auto contrast" };
    if (/auto colou?r|fix (the )?colou?r/.test(q)) return { id: "image.autoColor", label: "Auto color" };
    if (/more contrast|higher contrast|increase contrast/.test(q)) return { id: "image.adjustments.brightnessContrast", params: { contrast: 25 }, label: "More contrast" };
    if (/less contrast|lower contrast/.test(q)) return { id: "image.adjustments.brightnessContrast", params: { contrast: -15 }, label: "Less contrast" };
    if (/brighter|lighter|brighten/.test(q)) return { id: "image.adjustments.brightnessContrast", params: { brightness: 30 }, label: "Brighter" };
    if (/darker|darken/.test(q)) return { id: "image.adjustments.brightnessContrast", params: { brightness: -30 }, label: "Darker" };
    if (/more colou?r|more vivid|vibrance/.test(q)) return { id: "image.adjustments.vibrance", params: { vibrance: 35 }, label: "More color" };
    if (/less colou?r|muted/.test(q)) return { id: "image.adjustments.vibrance", params: { vibrance: -30, saturation: -10 }, label: "Less color" };
    return null;
  }

  const EXT = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" };

  function mimeOf(dataUrl) {
    const match = /^data:(image\/[a-z]+)[;,]/.exec(dataUrl || "");
    return match && EXT[match[1]] ? match[1] : "image/jpeg";
  }

  // Show this copy here, in the chat, and to the next question.
  function showCopy(next) {
    pe.image = next;
    pe.mime = mimeOf(next);
    pe.name = `${pe.name.replace(/\.[^.]+$/, "") || "Photo"}.${EXT[pe.mime]}`;
    pe.onReplace?.(next);
    window.noteEditedPhoto?.(next);
    showPreview();
  }

  function remember(next) {
    if (pe.image) pe.past.push(pe.image);
    if (pe.past.length > 12) pe.past.shift();
    showCopy(next);
  }

  // A new picture to edit. Undo starts over.
  function setPicture(dataUrl, name, onReplace) {
    pe.past = [];
    pe.image = dataUrl;
    pe.name = name || "Photo.jpg";
    pe.mime = mimeOf(dataUrl);
    pe.onReplace = onReplace || null;
    window.noteEditedPhoto?.(dataUrl);
    showPreview();
  }

  async function pushToEditor() {
    if (!pe.image) return;
    await pe.ready;
    if (!pe.frame?.contentWindow) return;
    const response = await fetch(pe.image);
    const bytes = await response.arrayBuffer();
    pe.frame.contentWindow.postMessage({
      type: "open-photo",
      name: pe.name,
      mime: pe.mime,
      bytes,
    }, location.origin);
  }

  // The big picture in this panel. PhotoCraft's own screen often stays on its
  // start page, so the change has to be visible here.
  function showPreview() {
    if (!pe.preview) return;
    if (!pe.image) {
      pe.preview.hidden = true;
      pe.preview.removeAttribute("src");
      return;
    }
    pe.preview.hidden = false;
    pe.preview.src = pe.image;
  }

  // The line under the orb, as well as the line in this panel.
  function say(text) {
    status(text);
    if (typeof setStatus === "function") setStatus(text);
  }

  async function runStep(step) {
    if (!pe.image) {
      status("Open a picture first, or press Edit under a photo in the chat.");
      return;
    }
    if (pe.busy) return;
    setBusy(true);
    say("Changing the picture…");
    try {
      const response = await fetch("/photoedit/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image: pe.image, steps: [{ id: step.id, params: step.params || {} }] }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "That did not work.");
      remember(data.image);
      await pushToEditor();
      say(`${step.label || "Done"}.`);
    } catch (err) {
      say(err.message);
    } finally {
      setBusy(false);
    }
  }

  function undo() {
    if (pe.busy) return;
    const previous = pe.past.pop();
    if (!previous) {
      status("Nothing to undo.");
      return;
    }
    showCopy(previous);
    pushToEditor().catch(() => {});
    say("Undone.");
  }

  async function save() {
    if (pe.busy) return;
    if (!pe.image) {
      status("There is no picture to save.");
      return;
    }
    if (pe.mime !== "image/jpeg") {
      status("Press a change first, or use PhotoCraft's own Save, which downloads the file.");
      return;
    }
    setBusy(true);
    try {
      const bytes = await (await fetch(pe.image)).arrayBuffer();
      const response = await fetch("/photoedit/save", {
        method: "POST",
        headers: {
          "Content-Type": "image/jpeg",
          "X-File-Name": encodeURIComponent(pe.name || "Photo.jpg"),
        },
        body: bytes,
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Could not save it.");
      status(`Saved ${data.name} in Pictures.`);
    } catch (err) {
      status(err.message);
    } finally {
      setBusy(false);
    }
  }

  function useImage(dataUrl, name, onReplace) {
    setPicture(dataUrl, name, onReplace);
    pushToEditor().catch(() => {});
    say("Picture ready. Type a change in the ask box, or say Hey, rotate it right.");
  }

  function readFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(new Error("Could not read that picture."));
      reader.readAsDataURL(file);
    });
  }

  const BUTTONS = [
    ["Rotate right", { id: "image.imageRotation.90cw", label: "Rotated right" }],
    ["Rotate left", { id: "image.imageRotation.90ccw", label: "Rotated left" }],
    ["Flip", { id: "image.imageRotation.flipCanvasHorizontal", label: "Flipped" }],
    ["Brighter", { id: "image.adjustments.brightnessContrast", params: { brightness: 30 }, label: "Brighter" }],
    ["Darker", { id: "image.adjustments.brightnessContrast", params: { brightness: -30 }, label: "Darker" }],
    ["Black & white", { id: "image.adjustments.desaturate", label: "Black and white" }],
    ["Sharpen", { id: "filter.sharpen.sharpen", label: "Sharpened" }],
    ["Auto color", { id: "image.autoColor", label: "Auto color" }],
  ];

  function build() {
    const root = el("section", "panel photopanel");
    root.setAttribute("aria-label", "Photo editor");
    const bar = el("div", "pe-bar");
    bar.append(el("span", "pe-title", "Edit photo"), el("span", "pe-gap"));
    const openBtn = el("button", "ghost-btn small", "Open");
    openBtn.type = "button";
    openBtn.title = "Open a picture from this Mac";
    openBtn.addEventListener("click", () => pe.picker?.click());
    bar.append(openBtn);
    for (const [label, step] of BUTTONS) {
      const node = el("button", "ghost-btn small pe-edit", label);
      node.type = "button";
      node.addEventListener("click", () => runStep(step));
      bar.append(node);
    }
    for (const [label, action, title] of [
      ["Undo", undo, "Undo the last button or spoken change"],
      ["Save", save, "Save a JPEG in Pictures"],
      ["Close", close, "Close the photo editor"],
    ]) {
      const node = el("button", "ghost-btn small", label);
      node.type = "button";
      node.title = title;
      node.addEventListener("click", action);
      bar.append(node);
    }
    pe.picker = el("input");
    pe.picker.type = "file";
    pe.picker.accept = "image/jpeg,image/png,image/webp,image/gif";
    pe.picker.hidden = true;
    pe.picker.addEventListener("change", async () => {
      const file = pe.picker.files?.[0];
      pe.picker.value = "";
      if (!file) return;
      try {
        useImage(await readFile(file), file.name);
      } catch (err) {
        status(err.message);
      }
    });
    pe.status = el("div", "pe-status");
    // The picture the buttons and the ask box change. Shown large, above PhotoCraft.
    pe.preview = el("img", "pe-preview");
    pe.preview.alt = "The picture being edited";
    pe.preview.hidden = true;
    pe.frame = el("iframe", "pe-frame");
    pe.frame.title = "PhotoCraft";
    pe.ready = new Promise((resolve) => {
      pe.frame.addEventListener("load", () => resolve(), { once: true });
    });
    pe.frame.src = "/photocraft/index.html?webgl";
    root.append(bar, pe.status, pe.preview, pe.frame, pe.picker);
    document.querySelector("main.layout").append(root);
    pe.root = root;
    window.addEventListener("message", (event) => {
      if (event.origin !== location.origin) return;
      if (!pe.frame || event.source !== pe.frame.contentWindow) return;
      if (event.data?.type !== "photo-saved" || !(event.data.bytes instanceof ArrayBuffer)) return;
      // PhotoCraft may save a PNG or WebP. Label the bytes with what they really are.
      const head = new Uint8Array(event.data.bytes, 0, Math.min(12, event.data.bytes.byteLength));
      const type = head[0] === 0xff && head[1] === 0xd8 ? "image/jpeg"
        : head[0] === 0x89 && head[1] === 0x50 ? "image/png"
        : String.fromCharCode(...head.slice(8, 12)) === "WEBP" ? "image/webp" : "";
      if (!type) return;
      const reader = new FileReader();
      reader.onload = () => {
        const url = String(reader.result || "");
        if (!url.startsWith(`data:${type}`)) return;
        pe.name = String(event.data.name || pe.name);
        remember(url);
        status("PhotoCraft saved a copy, and the picture in the chat matches it. Save here puts a JPEG in Pictures.");
      };
      reader.readAsDataURL(new Blob([event.data.bytes], { type }));
    });
  }

  function show(on) {
    document.querySelector("main.layout")?.classList.toggle("photo-on", on);
    if (pe.root) pe.root.hidden = !on;
    btn?.classList.toggle("is-on", on);
  }

  async function open() {
    const installed = await fetch("/photoedit/installed").then((r) => r.json()).catch(() => ({}));
    if (!installed.editor) {
      const statusEl = document.getElementById("statusText");
      if (statusEl) statusEl.textContent = "The photo editor is not installed. Run voice/install-photocraft.sh, then reload.";
      return;
    }
    if (!pe.root) build();
    window.brainWord?.close();
    window.brainSlides?.close();
    window.brainR?.close();
    window.brainCalendar?.close();
    window.brainStickies?.close();
    show(true);
    if (!installed.tools) status("PhotoCraft is open. The one-step buttons need the photo tools. Run voice/install-photocraft.sh, then reload.");
  }

  function close() {
    if (!pe.root) return;
    show(false);
  }

  // The microphone can deliver the same sentence twice. Do the change once.
  let lastEdit = { key: "", at: 0 };

  /** Show this picture in PhotoCraft. onReplace(next) runs after each change. */
  function editShot(dataUrl, onReplace) {
    // Remember the picture before the panel finishes opening, so "rotate it" is not lost.
    setPicture(dataUrl, "Photo.jpg", onReplace);
    open().then(() => {
      showPreview();
      // An edit started with this picture may already have written its own line.
      if (!pe.busy && pe.status && !pe.status.textContent) {
        say("Picture ready. Type a change in the ask box, or say Hey, rotate it right.");
      }
      pushToEditor().catch(() => {});
    });
  }

  /** True when this sentence was a photo edit, so the brain should not also answer it. */
  function ask(question) {
    const step = editFor(question);
    if (!step) return false;
    const editorOpen = Boolean(pe.root && !pe.root.hidden);
    const mentionsPicture = /\b(photos?|pictures?|images?|photocraft)\b/i.test(question);
    const shot = pe.image || window.latestPhotoForEdit?.() || "";
    const otherEditor = window.brainWord?.open || window.brainSlides?.open || window.brainR?.open;
    // A closed editor still takes the change when they name a picture, or a picture is already here.
    // Leave Word, slides, and R alone unless they said photo, picture, or image.
    if (!editorOpen && !mentionsPicture && (!shot || otherEditor)) return false;
    const key = String(question || "").toLowerCase();
    if (key === lastEdit.key && Date.now() - lastEdit.at < 2500) return true;
    lastEdit = { key, at: Date.now() };
    if (step.close) {
      close();
      return true;
    }
    if (step.undo) {
      if (!editorOpen) open();
      undo();
      return true;
    }
    if (step.save) {
      if (!editorOpen) open();
      save();
      return true;
    }
    if (!pe.image) {
      if (!shot) {
        open().then(() => {
          say("Take a photo, or press Open, then ask again.");
        });
        return true;
      }
      editShot(shot, window.followPhoto?.(shot));
    } else if (!editorOpen) open();
    runStep(step);
    return true;
  }

  function hear(raw) {
    const said = window.questionAfterWake ? window.questionAfterWake(raw) : String(raw || "").trim();
    if (said === null) return false;
    if (!said) {
      status("Say the change, for example: rotate it right.");
      return true;
    }
    return ask(said);
  }

  /** "open the photo editor" or "edit this photo" from the main chat. */
  function command(question) {
    const q = String(question || "");
    const openEditor = /\b(open|show|start)\b.*\b(photo editor|picture editor|image editor|photocraft)\b/i.test(q);
    const editThis = /\bedit (this |the )?(photo|picture|image)\b/i.test(q);
    if (!openEditor && !editThis) return false;
    open().then(() => {
      const shot = editThis && window.latestPhotoForEdit?.();
      if (shot) useImage(shot, "Photo.jpg", window.followPhoto?.(shot));
    });
    return true;
  }

  btn?.addEventListener("click", () => (pe.root && !pe.root.hidden ? close() : open()));

  window.brainPhoto = {
    get open() {
      return Boolean(pe.root && !pe.root.hidden);
    },
    openEditor: open,
    close,
    ask,
    hear,
    command,
    editShot,
  };
})();
