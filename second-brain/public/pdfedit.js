/**
 * PDFs to edit, in boxes above the transcript. The PDF tools button (or dropping PDFs on
 * the window) uploads them just for editing: no notes, no summary, no model.
 * Each box has its own tools (PDFCraft's, run by the server in pdftools.js); a result
 * comes back as a new box next to it. The last box has Combine, which merges every box
 * in the order shown. Split asks where to cut (or opens a window of pages), Sign and
 * Bookmarks open their own windows. More shows the rest of the tools.
 */
(() => {
  const desk = document.getElementById("pdfDesk");
  const boxes = document.getElementById("pdfBoxes");
  const count = document.getElementById("pdfCount");
  const picker = document.getElementById("pdfEditFile");
  if (!desk || !boxes || !picker) return;

  // A tool with fields asks first, inside the box; build turns the answers into the request.
  // A tool with open has its own window. Others run at once.
  const PAGES = { key: "pages", placeholder: "Pages, e.g. 2, 5-7" };
  const MAIN = [
    { tool: "rotate", label: "Rotate", fields: [{ key: "angle", type: "select", options: [["90", "90° right"], ["270", "90° left"], ["180", "180°"]] }, { key: "pages", placeholder: "Pages (empty = all)" }] },
    { tool: "delete", label: "Delete pages", fields: [PAGES] },
    { tool: "extract", label: "Keep pages", title: "Keep only these pages", fields: [PAGES] },
    { tool: "split", label: "Split", fields: [{ key: "where", placeholder: "Cut after pages: 3, 7 (or ranges 1-3, 4-9)" }], build: (v, box) => ({ pages: splitRanges(v.where, Number(box.dataset.pages)) }), extra: "split" },
    { tool: "sign", label: "Sign…", open: "sign" },
    { tool: "bookmarks", label: "Bookmarks…", open: "bookmarks" },
  ];
  const MORE = [
    { tool: "numbers", label: "Page numbers" },
    { tool: "headerfooter", label: "Header & footer", fields: [{ key: "header", placeholder: "Header text" }, { key: "footer", placeholder: "Footer text" }, { key: "numbers", type: "check", label: "Page numbers" }] },
    { tool: "watermark", label: "Watermark", fields: [{ key: "text", value: "DRAFT", max: 60 }] },
    { tool: "stamp", label: "Stamp", fields: [{ key: "preset", type: "select", options: [["approved", "Approved"], ["rejected", "Rejected"], ["confidential", "Confidential"], ["draft", "Draft"], ["final", "Final"], ["copy", "Copy"]] }, { key: "pages", placeholder: "Pages (empty = page 1)" }] },
    { tool: "blank", label: "Blank page", fields: [{ key: "after", type: "number", placeholder: "After page (0 = at the start)" }, { key: "count", type: "number", value: "1", placeholder: "How many" }] },
    { tool: "password", label: "Password", title: "Needs a password to open", fields: [{ key: "password", type: "password", placeholder: "New password" }] },
    { tool: "unlock", label: "Unlock", title: "Remove the password", fields: [{ key: "password", type: "password", placeholder: "Its password" }] },
    { tool: "info", label: "Title & author", fields: [{ key: "title", placeholder: "Title" }, { key: "author", placeholder: "Author" }] },
    { tool: "nup", label: "Pages per sheet", fields: [{ key: "perSheet", type: "select", options: [["2", "2 per sheet"], ["4", "4 per sheet"]] }] },
    { tool: "flatten", label: "Flatten forms", title: "Make form fields and notes part of the page" },
    { tool: "noannotations", label: "Remove notes", title: "Remove comments, highlights and links" },
    { tool: "compress", label: "Compress" },
    { tool: "ocr", label: "Searchable", title: "Read the text of a scan (OCR)" },
    { tool: "reverse", label: "Reverse" },
    { tool: "images", label: "To images", title: "Every page as a picture, in a folder in Downloads" },
  ];

  /** Cut points [3, 7] on 10 pages become "1-3, 4-7, 8-10". */
  function cutsToRanges(cuts, pages) {
    const out = [];
    let start = 1;
    for (const cut of [...cuts].filter((c) => c >= 1 && c < pages).sort((a, b) => a - b)) {
      if (cut < start) continue;
      out.push(start === cut ? `${start}` : `${start}-${cut}`);
      start = cut + 1;
    }
    out.push(start === pages ? `${start}` : `${start}-${pages}`);
    return out.length > 1 ? out.join(", ") : "";
  }

  /** What was typed in Split: ranges stay as they are, plain numbers are pages to cut after. */
  function splitRanges(text, pages) {
    const value = String(text || "").trim();
    if (!value) return "";
    if (value.includes("-")) return value;
    return cutsToRanges(value.split(/[\s,;]+/).map(Number).filter(Number.isInteger), pages);
  }

  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  };
  const button = (label, cls, onClick, title) => {
    const b = el("button", `ghost-btn small ${cls || ""}`.trim(), label);
    b.type = "button";
    if (title) b.title = title;
    b.addEventListener("click", onClick);
    return b;
  };

  async function post(url, body) {
    const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "That did not work.");
    return data;
  }

  function refresh() {
    const all = [...boxes.children];
    desk.hidden = !all.length;
    count.textContent = all.length ? `(${all.length})` : "";
    boxes.querySelectorAll(".pdfbox-combine").forEach((b) => b.remove());
    const last = all[all.length - 1];
    if (all.length >= 2) {
      last.append(button(`Combine all ${all.length}`, "pdfbox-combine", combine, "Merge every box, left to right, into one PDF"));
    }
  }

  function setStatus(box, text) {
    box.querySelector(".pdfbox-status").textContent = text || "";
  }

  function busy(box, on) {
    box.classList.toggle("busy", on);
    box.querySelectorAll("button, input, select").forEach((b) => { b.disabled = on; });
  }

  /** One box for one PDF. after: put it right after that box (a result next to its source). */
  function addBox(item, after) {
    const box = el("article", "pdfbox");
    box.dataset.id = item.id;
    box.dataset.pages = item.pages || 0;

    const head = el("div", "pdfbox-head");
    head.append(
      button("‹", "pdfbox-move", () => box.previousElementSibling?.before(box) || null, "Move left"),
      button("›", "pdfbox-move", () => box.nextElementSibling?.after(box) || null, "Move right"),
      button("×", "pdfbox-x", () => { box.remove(); refresh(); }, "Remove this box (the file stays saved)"),
    );
    head.querySelectorAll(".pdfbox-move").forEach((b) => b.addEventListener("click", refresh));

    const thumb = el("img", "pdfbox-thumb");
    thumb.alt = "";
    thumb.loading = "lazy";
    thumb.src = `/pdfedit/${encodeURIComponent(item.id)}/thumb/1`;
    thumb.title = "Open in Preview";
    thumb.addEventListener("click", () => post(`/pdf/${encodeURIComponent(item.id)}/open`).catch(() => {}));

    const name = el("div", "pdfbox-name", item.name);
    name.title = item.name;
    const meta = el("div", "pdfbox-meta", item.pages ? `${item.pages} page${item.pages === 1 ? "" : "s"}` : "");

    const pick = (t) => {
      if (t.open === "sign") openSign(box, item);
      else if (t.open === "bookmarks") openBookmarks(box, item);
      else if (t.fields) ask(box, item, t);
      else runTool(box, item, { tool: t.tool });
    };
    const tools = el("div", "pdfbox-tools");
    const more = el("div", "pdfbox-tools pdfbox-more");
    more.hidden = true;
    for (const t of MAIN) tools.append(button(t.label, "", () => pick(t), t.title));
    for (const t of MORE) more.append(button(t.label, "", () => pick(t), t.title));
    const moreBtn = button("More ▾", "", () => {
      more.hidden = !more.hidden;
      moreBtn.textContent = more.hidden ? "More ▾" : "Less ▴";
    });
    tools.append(moreBtn);

    const askRow = el("div", "pdfbox-ask");
    askRow.hidden = true;

    const save = el("div", "pdfbox-save");
    const saveTo = async (pick) => {
      setStatus(box, pick ? "Choose a folder…" : "Saving…");
      try {
        const data = await post(`/pdf/${encodeURIComponent(item.id)}/save`, { pick });
        setStatus(box, data.path ? `Saved in ${data.path.split("/").slice(-2, -1)[0] || "the folder"}` : "");
      } catch (err) {
        setStatus(box, err.message);
      }
    };
    save.append(
      button("Save", "", () => saveTo(false), "Save in Downloads and show it in the Finder"),
      button("Save to…", "", () => saveTo(true), "Choose a folder"),
    );

    box.append(head, thumb, name, meta, tools, more, askRow, save, el("div", "pdfbox-status"));
    if (after) after.after(box);
    else boxes.append(box);
    refresh();
    box.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
    return box;
  }

  /** The small form inside a box for a tool's fields (pages, an angle, a text…). */
  function ask(box, item, t) {
    const row = box.querySelector(".pdfbox-ask");
    row.replaceChildren();
    row.hidden = false;
    const inputs = {};
    for (const f of t.fields) {
      let input;
      if (f.type === "select") {
        input = el("select");
        for (const [value, label] of f.options) {
          const option = el("option", "", label);
          option.value = value;
          input.append(option);
        }
        row.append(input);
      } else if (f.type === "check") {
        input = el("input");
        input.type = "checkbox";
        const label = el("label", "pdfbox-check");
        label.append(input, document.createTextNode(` ${f.label}`));
        row.append(label);
      } else {
        input = el("input");
        input.type = f.type === "password" ? "password" : f.type === "number" ? "number" : "text";
        if (f.type === "number") input.min = "0";
        if (f.placeholder) input.placeholder = f.placeholder;
        if (f.value) input.value = f.value;
        if (f.max) input.maxLength = f.max;
        if (f.type === "password") input.autocomplete = "new-password";
        row.append(input);
      }
      inputs[f.key] = input;
    }
    const values = () => Object.fromEntries(Object.entries(inputs).map(([key, input]) => [key, input.type === "checkbox" ? input.checked : input.value.trim()]));
    const go = () => {
      const v = values();
      const plan = { tool: t.tool, ...(t.build ? t.build(v, box) : v) };
      if (t.tool === "split" && !plan.pages) {
        setStatus(box, "Type the pages to cut after, or press Every page.");
        return;
      }
      row.hidden = true;
      runTool(box, item, plan);
    };
    row.append(button(t.label.replace("…", ""), "primary", go));
    if (t.extra === "split") {
      row.append(
        button("Every page", "", () => { row.hidden = true; runTool(box, item, { tool: "split", pages: "" }); }),
        button("Pick on pages…", "", () => { row.hidden = true; openSplit(box, item); }),
      );
    }
    row.append(button("Cancel", "", () => { row.hidden = true; }));
    row.querySelectorAll("input").forEach((input) => input.addEventListener("keydown", (e) => e.key === "Enter" && go()));
    row.querySelector("input:not([type=checkbox]), select")?.focus();
  }

  async function runTool(box, item, plan) {
    busy(box, true);
    setStatus(box, "Working…");
    try {
      const data = await post(`/pdfedit/${encodeURIComponent(item.id)}/run`, plan);
      let at = box;
      for (const made of data.items) at = addBox(made, at);
      setStatus(box, data.note || (data.items.length ? "Done: the result is in the next box." : ""));
    } catch (err) {
      setStatus(box, err.message);
    } finally {
      busy(box, false);
    }
  }

  async function combine(event) {
    const last = event.currentTarget.closest(".pdfbox");
    const ids = [...boxes.children].map((b) => b.dataset.id);
    busy(last, true);
    setStatus(last, `Combining ${ids.length} PDFs…`);
    try {
      const data = await post("/pdfedit/merge", { ids });
      for (const made of data.items) addBox(made);
      setStatus(last, "");
    } catch (err) {
      setStatus(last, err.message);
    } finally {
      busy(last, false);
    }
  }

  // ---- The split window: page pictures with a cut between any two pages ----

  function openSplit(box, item) {
    const pages = Number(box.dataset.pages) || 0;
    if (pages < 2) return setStatus(box, "It has only one page.");
    const cuts = new Set();
    const shade = el("div", "pdfsplit-shade");
    const win = el("div", "pdfsplit");
    win.setAttribute("role", "dialog");
    win.setAttribute("aria-label", `Split ${item.name}`);
    const head = el("div", "pdfsplit-head");
    head.append(el("strong", "", `Split ${item.name}`), el("span", "", "Click between two pages to cut there."));
    const grid = el("div", "pdfsplit-grid");
    const ranges = el("input", "pdfsplit-ranges");
    ranges.type = "text";
    ranges.placeholder = "Or type ranges: 1-3, 4-8";

    const rangesFromCuts = () => cutsToRanges(cuts, pages);
    const sync = () => {
      grid.querySelectorAll(".pdfsplit-cut").forEach((c) => c.classList.toggle("on", cuts.has(Number(c.dataset.after))));
      ranges.value = rangesFromCuts();
      info.textContent = cuts.size ? `${cuts.size + 1} files` : "No cuts yet";
    };
    for (let n = 1; n <= pages; n += 1) {
      const page = el("figure", "pdfsplit-page");
      const img = el("img");
      img.loading = "lazy";
      img.alt = `Page ${n}`;
      img.src = `/pdfedit/${encodeURIComponent(item.id)}/thumb/${n}`;
      page.append(img, el("figcaption", "", String(n)));
      grid.append(page);
      if (n < pages) {
        const cut = el("button", "pdfsplit-cut");
        cut.type = "button";
        cut.dataset.after = n;
        cut.title = `Cut after page ${n}`;
        cut.setAttribute("aria-label", `Cut after page ${n}`);
        cut.addEventListener("click", () => {
          if (cuts.has(n)) cuts.delete(n);
          else cuts.add(n);
          sync();
        });
        grid.append(cut);
      }
    }
    const info = el("span", "pdfsplit-info");
    const close = () => {
      shade.remove();
      document.removeEventListener("keydown", onKey);
    };
    const onKey = (e) => e.key === "Escape" && close();
    const split = (pagesText) => {
      close();
      runTool(box, item, { tool: "split", pages: pagesText });
    };
    const foot = el("div", "pdfsplit-foot");
    foot.append(
      ranges,
      info,
      button("Every page", "", () => split(""), `${pages} files, one page each`),
      button("Split", "primary", () => {
        const text = ranges.value.trim();
        if (text) split(text);
        else info.textContent = "Click a gap between pages first, or type ranges.";
      }),
      button("Cancel", "", close),
    );
    ranges.addEventListener("input", () => {
      cuts.clear();
      grid.querySelectorAll(".pdfsplit-cut").forEach((c) => c.classList.remove("on"));
      info.textContent = ranges.value.trim() ? "Typed ranges" : "No cuts yet";
    });
    win.append(head, grid, foot);
    shade.append(win);
    shade.addEventListener("click", (e) => e.target === shade && close());
    document.addEventListener("keydown", onKey);
    document.body.append(shade);
    sync();
  }

  // ---- Windows for Sign and Bookmarks ----

  function modal(title, hint) {
    const shade = el("div", "pdfsplit-shade");
    const win = el("div", "pdfsplit");
    win.setAttribute("role", "dialog");
    win.setAttribute("aria-label", title);
    const head = el("div", "pdfsplit-head");
    head.append(el("strong", "", title), el("span", "", hint));
    const body = el("div", "pdfwin-body");
    const foot = el("div", "pdfsplit-foot");
    win.append(head, body, foot);
    shade.append(win);
    const onKey = (e) => e.key === "Escape" && close();
    const close = () => {
      shade.remove();
      document.removeEventListener("keydown", onKey);
    };
    shade.addEventListener("click", (e) => e.target === shade && close());
    document.addEventListener("keydown", onKey);
    document.body.append(shade);
    return { body, foot, close };
  }

  const SIGNATURE_KEY = "brainSignature";

  /** The drawn part of a canvas, cropped to its ink, as a PNG data URL with its width/height ratio. */
  function inkOf(canvas) {
    const ctx = canvas.getContext("2d");
    const { width, height } = canvas;
    const pixels = ctx.getImageData(0, 0, width, height).data;
    let x0 = width, y0 = height, x1 = -1, y1 = -1;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        if (pixels[(y * width + x) * 4 + 3] > 10) {
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
      }
    }
    if (x1 < 0) return null;
    const pad = 6;
    x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad);
    x1 = Math.min(width - 1, x1 + pad); y1 = Math.min(height - 1, y1 + pad);
    const out = document.createElement("canvas");
    out.width = x1 - x0 + 1;
    out.height = y1 - y0 + 1;
    out.getContext("2d").drawImage(canvas, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
    return { data: out.toDataURL("image/png"), ratio: out.width / out.height };
  }

  /** Draw or type a signature, click the page where it goes, then Sign. */
  function openSign(box, item) {
    const pages = Number(box.dataset.pages) || 1;
    const win = modal(`Sign ${item.name}`, "Draw or type your signature, then click the page where it goes. Drag it to move it.");
    win.body.classList.add("pdfsign");

    // Left: the signature
    const left = el("div", "pdfsign-left");
    const canvas = el("canvas", "pdfsign-pad");
    canvas.width = 600;
    canvas.height = 200;
    const ctx = canvas.getContext("2d");
    ctx.lineWidth = 3.2;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#0b2a6b";
    let drawing = false;
    const at = (e) => {
      const r = canvas.getBoundingClientRect();
      return [((e.clientX - r.left) / r.width) * canvas.width, ((e.clientY - r.top) / r.height) * canvas.height];
    };
    canvas.addEventListener("pointerdown", (e) => {
      drawing = true;
      canvas.setPointerCapture(e.pointerId);
      ctx.beginPath();
      ctx.moveTo(...at(e));
    });
    canvas.addEventListener("pointermove", (e) => {
      if (!drawing) return;
      ctx.lineTo(...at(e));
      ctx.stroke();
    });
    canvas.addEventListener("pointerup", () => { drawing = false; update(); });
    const typed = el("input");
    typed.type = "text";
    typed.placeholder = "Or type your name";
    typed.addEventListener("input", () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "#0b2a6b";
      ctx.font = 'italic 84px "Snell Roundhand", "Apple Chancery", "Brush Script MT", cursive';
      ctx.textBaseline = "middle";
      ctx.fillText(typed.value, 20, canvas.height / 2, canvas.width - 40);
      update();
    });
    const remember = el("label", "pdfbox-check");
    const rememberBox = el("input");
    rememberBox.type = "checkbox";
    rememberBox.checked = Boolean(localStorage.getItem(SIGNATURE_KEY));
    remember.append(rememberBox, document.createTextNode(" Remember it on this Mac"));
    const size = el("input");
    size.type = "range";
    size.min = "10";
    size.max = "60";
    size.value = "28";
    const sizeLabel = el("label", "pdfbox-check", "Size ");
    sizeLabel.append(size);
    left.append(canvas, typed, el("div", "pdfsign-row"), sizeLabel, remember);
    left.querySelector(".pdfsign-row").append(
      button("Clear", "", () => { ctx.clearRect(0, 0, canvas.width, canvas.height); typed.value = ""; update(); }),
    );

    // Right: the page, with the signature on it
    const right = el("div", "pdfsign-right");
    const stage = el("div", "pdfsign-stage");
    const pageImg = el("img");
    pageImg.alt = "";
    const mark = el("img", "pdfsign-mark");
    mark.alt = "Signature";
    mark.hidden = true;
    stage.append(pageImg, mark);
    let page = 1;
    const pageLabel = el("span", "pdfsplit-info");
    const showPage = () => {
      pageImg.src = `/pdfedit/${encodeURIComponent(item.id)}/thumb/${page}?big=1`;
      pageLabel.textContent = `Page ${page} of ${pages}`;
    };
    const nav = el("div", "pdfsign-row");
    nav.append(
      button("‹", "", () => { if (page > 1) { page -= 1; showPage(); } }, "Previous page"),
      pageLabel,
      button("›", "", () => { if (page < pages) { page += 1; showPage(); } }, "Next page"),
    );
    right.append(stage, nav);
    win.body.append(left, right);

    // Where the signature is, as fractions of the page (top-left of the signature).
    const spot = { x: 0.58, y: 0.82 };
    let ink = null;
    function update() {
      ink = inkOf(canvas);
      mark.hidden = !ink;
      if (!ink) return;
      mark.src = ink.data;
      place();
    }
    function place() {
      const w = Number(size.value) / 100;
      mark.style.left = `${spot.x * 100}%`;
      mark.style.top = `${spot.y * 100}%`;
      mark.style.width = `${w * 100}%`;
    }
    size.addEventListener("input", place);
    const moveTo = (e) => {
      const r = pageImg.getBoundingClientRect();
      const w = Number(size.value) / 100;
      const hFrac = ink ? (w * r.width) / ink.ratio / r.height : 0.05;
      spot.x = Math.min(Math.max((e.clientX - r.left) / r.width - w / 2, 0), 1 - w);
      spot.y = Math.min(Math.max((e.clientY - r.top) / r.height - hFrac / 2, 0), 1 - hFrac);
      place();
    };
    let dragging = false;
    stage.addEventListener("pointerdown", (e) => {
      dragging = true;
      stage.setPointerCapture(e.pointerId);
      moveTo(e);
    });
    stage.addEventListener("pointermove", (e) => dragging && moveTo(e));
    stage.addEventListener("pointerup", () => { dragging = false; });

    // A saved signature comes back drawn.
    const saved = localStorage.getItem(SIGNATURE_KEY);
    if (saved) {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(canvas.width / img.width, canvas.height / img.height, 1);
        ctx.drawImage(img, (canvas.width - img.width * scale) / 2, (canvas.height - img.height * scale) / 2, img.width * scale, img.height * scale);
        update();
      };
      img.src = saved;
    }
    showPage();

    const info = el("span", "pdfsplit-info");
    win.foot.append(
      info,
      button("Sign", "primary", () => {
        if (!ink) {
          info.textContent = "Draw or type the signature first.";
          return;
        }
        if (rememberBox.checked) localStorage.setItem(SIGNATURE_KEY, ink.data);
        else localStorage.removeItem(SIGNATURE_KEY);
        win.close();
        runTool(box, item, { tool: "sign", signature: { data: ink.data, ratio: ink.ratio, page, x: spot.x, y: spot.y, w: Number(size.value) / 100 } });
      }),
      button("Cancel", "", win.close),
    );
  }

  /** A list of bookmarks (title and page) to add to the PDF's sidebar. */
  function openBookmarks(box, item) {
    const pages = Number(box.dataset.pages) || 1;
    const win = modal(`Bookmarks for ${item.name}`, `Each bookmark jumps to a page (1 to ${pages}).`);
    win.body.classList.add("pdfmarks");
    const list = el("div", "pdfmarks-list");
    const addRow = (title = "", pageNo = "") => {
      const row = el("div", "pdfmarks-row");
      const t = el("input");
      t.type = "text";
      t.placeholder = "Title, e.g. Results";
      t.value = title;
      t.maxLength = 120;
      const n = el("input");
      n.type = "number";
      n.min = "1";
      n.max = String(pages);
      n.placeholder = "Page";
      n.value = pageNo;
      const thumb = el("img", "pdfmarks-thumb");
      thumb.alt = "";
      const show = () => {
        const v = Number(n.value);
        thumb.hidden = !(v >= 1 && v <= pages);
        if (!thumb.hidden) thumb.src = `/pdfedit/${encodeURIComponent(item.id)}/thumb/${v}`;
      };
      n.addEventListener("input", show);
      row.append(thumb, t, n, button("×", "", () => row.remove(), "Remove this bookmark"));
      list.append(row);
      show();
      t.focus();
    };
    addRow("", "1");
    win.body.append(list);
    const info = el("span", "pdfsplit-info");
    win.foot.append(
      button("Add bookmark", "", () => addRow("", String(Math.min(pages, (Number(list.lastElementChild?.querySelector("input[type=number]")?.value) || 0) + 1)))),
      info,
      button("Save bookmarks", "primary", () => {
        const bookmarks = [...list.children].map((row) => ({
          title: row.querySelector("input[type=text]").value.trim(),
          page: Number(row.querySelector("input[type=number]").value),
        })).filter((b) => b.title && b.page >= 1 && b.page <= pages);
        if (!bookmarks.length) {
          info.textContent = "Give each bookmark a title and a page.";
          return;
        }
        win.close();
        runTool(box, item, { tool: "bookmarks", bookmarks });
      }),
      button("Cancel", "", win.close),
    );
  }

  // ---- Upload ----

  async function upload(files) {
    const pdfs = [...files].filter((f) => f.type === "application/pdf" || /\.pdf$/i.test(f.name));
    if (!pdfs.length) return;
    desk.hidden = false;
    for (const file of pdfs) {
      const holder = el("article", "pdfbox busy");
      holder.append(el("div", "pdfbox-name", file.name), el("div", "pdfbox-status", "Uploading…"));
      boxes.append(holder);
      try {
        const response = await fetch("/pdfedit/upload", {
          method: "POST",
          headers: { "Content-Type": "application/pdf", "X-File-Name": encodeURIComponent(file.name) },
          body: file,
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || "Could not upload it.");
        holder.remove();
        addBox(data);
      } catch (err) {
        holder.classList.remove("busy");
        holder.querySelector(".pdfbox-status").textContent = err.message;
        holder.prepend(button("×", "pdfbox-x", () => { holder.remove(); refresh(); }));
      }
    }
    refresh();
  }

  picker.addEventListener("change", () => {
    upload(picker.files);
    picker.value = "";
  });
  document.getElementById("pdfEditBtn")?.addEventListener("click", () => picker.click());
  document.getElementById("pdfAddBtn")?.addEventListener("click", () => picker.click());
  document.getElementById("pdfClearBtn")?.addEventListener("click", () => { boxes.replaceChildren(); refresh(); });

  // Dropping PDFs anywhere on the window uploads them for editing.
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes("Files");
  document.addEventListener("dragover", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    document.body.classList.add("pdf-drop");
  });
  document.addEventListener("dragleave", (e) => {
    if (!e.relatedTarget) document.body.classList.remove("pdf-drop");
  });
  document.addEventListener("drop", (e) => {
    document.body.classList.remove("pdf-drop");
    if (!hasFiles(e)) return;
    e.preventDefault();
    upload(e.dataTransfer.files);
  });

  window.brainPdfEdit = { pick: () => picker.click(), upload };
})();
