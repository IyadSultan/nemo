// Plans in the app: conferences, trips, and talks, in place of the transcript.
// They come from GET /plans (plans.json on this Mac), not from Outlook.
// List, Month, and Year views. The server texts a reminder the day before each one.
(() => {
  const btn = document.getElementById("plansBtn");
  const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const pl = { root: null, body: null, form: null, fields: null, status: null, tabs: {}, title: null, plans: [], view: "list", cursor: new Date(), editing: null, pending: [], showPast: false, saving: false };

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

  function status(text) {
    pl.status.textContent = text;
  }

  const pad = (n) => String(n).padStart(2, "0");
  const dayKey = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const fromKey = (key) => {
    const [y, m, d] = key.split("-").map(Number);
    return new Date(y, m - 1, d);
  };
  const shortDay = (key) => fromKey(key).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
  const lastDay = (plan) => plan.to || plan.from;
  const onDay = (plan, key) => plan.from <= key && key <= lastDay(plan);
  // The server marks the plan added later with the plans it clashes with and the shared days.
  const clashOnDay = (key) => pl.plans.some((plan) => plan.conflicts?.some((c) => c.from <= key && key <= c.to));
  const clashText = (plan) => `Clashes with ${plan.conflicts.map((c) => c.title).join(", ")}`;

  function whenText(plan) {
    const days = plan.to ? `${shortDay(plan.from)} – ${shortDay(plan.to)}` : shortDay(plan.from);
    return plan.time ? `${days} · ${plan.time}` : days;
  }

  // ---- views ----

  function planCard(plan) {
    const card = el("article", plan.time ? "pl-card is-talk" : "pl-card");
    if (plan.conflicts) card.classList.add("is-clash");
    const head = el("div", "pl-card-head");
    head.append(el("p", "pl-when", whenText(plan)), button("Edit", "Change this plan", () => showForm(plan)));
    card.append(head, el("p", "pl-name", plan.title));
    if (plan.conflicts) card.append(el("p", "pl-clash", clashText(plan)));
    if (plan.place) card.append(el("p", "pl-place", plan.place));
    if (plan.comment) card.append(el("p", "pl-comment", plan.comment));
    if (plan.files?.length) {
      const files = el("div", "pl-card-files");
      plan.files.forEach((file) => files.append(button(`📎 ${file.name}`, "Open on this Mac", () => openFile(plan, file))));
      card.append(files);
    }
    return card;
  }

  function drawList() {
    const today = dayKey(new Date());
    const shown = pl.plans.filter((plan) => pl.showPast || lastDay(plan) >= today);
    const wrap = el("div", "pl-list");
    const toggle = button(pl.showPast ? "Hide past plans" : "Show past plans", "Past plans stay saved", () => {
      pl.showPast = !pl.showPast;
      draw();
    });
    toggle.classList.add("pl-past-toggle");
    wrap.append(toggle);
    if (!shown.length) wrap.append(el("p", "pl-empty", "No plans yet. Press Add plan."));
    let month = "";
    for (const plan of shown) {
      const date = fromKey(plan.from);
      const label = `${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
      if (label !== month) {
        month = label;
        wrap.append(el("h3", "pl-month-label", label));
      }
      const card = planCard(plan);
      if (lastDay(plan) < today) card.classList.add("is-past");
      wrap.append(card);
    }
    pl.title.textContent = "Upcoming";
    pl.body.replaceChildren(wrap);
  }

  /** Day cells for one month, Sunday first, padded with the days around it. */
  function monthCells(year, month) {
    const first = new Date(year, month, 1);
    const cells = [];
    for (let i = 0; i < 42; i += 1) cells.push(new Date(year, month, 1 - first.getDay() + i));
    // Drop a last row that is all next month.
    return cells[35].getMonth() !== month ? cells.slice(0, 35) : cells;
  }

  function drawMonth() {
    const year = pl.cursor.getFullYear();
    const month = pl.cursor.getMonth();
    const today = dayKey(new Date());
    const grid = el("div", "pl-grid");
    WEEKDAYS.forEach((name) => grid.append(el("div", "pl-weekday", name)));
    for (const date of monthCells(year, month)) {
      const key = dayKey(date);
      const cell = el("div", "pl-cell");
      if (date.getMonth() !== month) cell.classList.add("is-other");
      if (key === today) cell.classList.add("is-today");
      if (clashOnDay(key)) cell.classList.add("has-clash");
      cell.title = `Add a plan on ${shortDay(key)}`;
      cell.append(el("span", "pl-num", String(date.getDate())));
      for (const plan of pl.plans.filter((item) => onDay(item, key))) {
        const chip = el("button", plan.time ? "pl-chip is-talk" : "pl-chip", plan.time && key === plan.from ? `${plan.time} ${plan.title}` : plan.title);
        chip.type = "button";
        chip.title = `${plan.title} · ${whenText(plan)}${plan.place ? ` · ${plan.place}` : ""}${plan.conflicts ? ` · ${clashText(plan)}` : ""}`;
        if (plan.conflicts) chip.classList.add("is-clash");
        chip.addEventListener("click", (event) => {
          event.stopPropagation();
          showForm(plan);
        });
        cell.append(chip);
      }
      cell.addEventListener("click", () => showForm(null, key));
      grid.append(cell);
    }
    pl.title.textContent = `${MONTHS[month]} ${year}`;
    pl.body.replaceChildren(grid);
  }

  function drawYear() {
    const year = pl.cursor.getFullYear();
    const today = dayKey(new Date());
    const wrap = el("div", "pl-year");
    for (let month = 0; month < 12; month += 1) {
      const box = el("section", "pl-mini");
      const name = button(MONTHS[month], `Open ${MONTHS[month]} ${year}`, () => {
        pl.cursor = new Date(year, month, 1);
        setView("month");
      });
      name.classList.add("pl-mini-name");
      const grid = el("div", "pl-mini-grid");
      WEEKDAYS.forEach((day) => grid.append(el("span", "pl-mini-head", day[0])));
      let count = 0;
      for (const date of monthCells(year, month)) {
        const key = dayKey(date);
        const cell = el("span", "pl-mini-day", date.getMonth() === month ? String(date.getDate()) : "");
        if (date.getMonth() === month) {
          const hits = pl.plans.filter((plan) => onDay(plan, key));
          if (hits.length) {
            cell.classList.add("has-plan");
            cell.title = hits.map((plan) => plan.title).join(", ");
          }
          if (key === today) cell.classList.add("is-today");
          if (clashOnDay(key)) cell.classList.add("has-clash");
        }
        grid.append(cell);
      }
      for (const plan of pl.plans) {
        const start = fromKey(plan.from);
        const end = fromKey(lastDay(plan));
        if (start <= new Date(year, month + 1, 0) && end >= new Date(year, month, 1)) count += 1;
      }
      box.append(name, grid);
      if (count) box.append(el("p", "pl-mini-count", count === 1 ? "1 plan" : `${count} plans`));
      wrap.append(box);
    }
    pl.title.textContent = String(year);
    pl.body.replaceChildren(wrap);
  }

  function draw() {
    for (const [name, tab] of Object.entries(pl.tabs)) tab.classList.toggle("is-on", name === pl.view);
    pl.nav.hidden = pl.view === "list";
    if (pl.view === "month") drawMonth();
    else if (pl.view === "year") drawYear();
    else drawList();
  }

  function setView(view) {
    pl.view = view;
    draw();
  }

  function step(by) {
    const c = pl.cursor;
    pl.cursor = pl.view === "year" ? new Date(c.getFullYear() + by, c.getMonth(), 1) : new Date(c.getFullYear(), c.getMonth() + by, 1);
    draw();
  }

  async function load() {
    status("Reading plans…");
    try {
      const response = await fetch("/plans");
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Could not read the plans.");
      pl.plans = data.plans || [];
      const ahead = pl.plans.filter((plan) => lastDay(plan) >= dayKey(new Date())).length;
      status(ahead === 1 ? "1 plan ahead." : `${ahead} plans ahead.`);
      draw();
    } catch (err) {
      console.error("Failed while loading the plans tab:", err);
      status(err.message || "Could not read the plans.");
    }
  }

  // ---- form ----

  function field(label, input, cls) {
    const wrap = el("label", cls ? `pl-field ${cls}` : "pl-field");
    wrap.append(el("span", "pl-label", label), input);
    return wrap;
  }

  function input(type, placeholder, max) {
    const node = document.createElement(type === "textarea" ? "textarea" : "input");
    if (type !== "textarea") node.type = type;
    node.className = "pl-input";
    if (placeholder) node.placeholder = placeholder;
    if (max) node.maxLength = max;
    node.autocomplete = "off";
    return node;
  }

  function buildForm() {
    const form = el("form", "pl-form");
    form.hidden = true;
    const title = input("text", "ESMO 2026, or Grand rounds talk", 120);
    const from = input("date");
    const to = input("date");
    const time = input("time");
    const place = input("text", "Berlin, or KHCC auditorium", 120);
    const comment = input("textarea", "Who invited you, their email, the topic, anything else", 4000);
    comment.rows = 3;
    const save = button("Save", "Save this plan", () => {});
    save.type = "submit";
    save.classList.add("primary");
    const remove = button("Delete", "Delete this plan", (node) => removePlan(node));
    from.addEventListener("change", () => {
      if (to.value && to.value < from.value) to.value = "";
    });
    const row = el("div", "pl-form-row");
    row.append(
      field("Title", title, "is-wide"),
      field("From", from),
      field("To (optional)", to),
      field("Time (for a talk)", time),
      field("Place", place, "is-wide"),
    );
    const picker = document.createElement("input");
    picker.type = "file";
    picker.multiple = true;
    picker.hidden = true;
    picker.addEventListener("change", () => {
      addFiles(picker.files);
      picker.value = "";
    });
    const files = el("div", "pl-files");
    pl.fileList = el("div", "pl-file-list");
    files.append(
      el("span", "pl-label", "Files"),
      pl.fileList,
      button("Attach files", "Pick files, or drop them on this form", () => picker.click()),
      picker,
    );
    // Dropped files belong to the plan, not to the PDF editor behind it.
    form.addEventListener("dragover", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    form.addEventListener("drop", (event) => {
      event.preventDefault();
      event.stopPropagation();
      addFiles(event.dataTransfer?.files);
    });
    const actions = el("div", "pl-form-actions");
    actions.append(save, button("Cancel", "Hide this form", hideForm), remove);
    form.append(row, field("Comment", comment, "is-full"), files, actions);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      savePlan();
    });
    pl.form = form;
    pl.fields = { title, from, to, time, place, comment, save, remove };
    return form;
  }

  function showForm(plan, day) {
    const f = pl.fields;
    pl.editing = plan || null;
    f.title.value = plan?.title || "";
    f.from.value = plan?.from || day || dayKey(new Date());
    f.to.value = plan?.to || "";
    f.time.value = plan?.time || "";
    f.place.value = plan?.place || "";
    f.comment.value = plan?.comment || "";
    f.remove.hidden = !plan;
    f.remove.textContent = "Delete";
    pl.pending = [];
    drawFiles();
    pl.form.hidden = false;
    f.title.focus();
  }

  function hideForm() {
    pl.form.hidden = true;
    pl.editing = null;
    pl.pending = [];
  }

  // ---- files ----

  const sizeText = (bytes) => (bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);
  const fileUrl = (plan, file) => `/plans/${encodeURIComponent(plan.id)}/files/${encodeURIComponent(file.name)}`;

  function addFiles(list) {
    const files = [...(list || [])].filter((file) => file.size > 0);
    const big = files.filter((file) => file.size > 60 * 1048576);
    pl.pending.push(...files.filter((file) => !big.includes(file)));
    if (big.length) status(`Too big to attach (over 60 MB): ${big.map((file) => file.name).join(", ")}`);
    drawFiles();
  }

  function drawFiles() {
    const rows = [];
    for (const file of pl.editing?.files || []) {
      const row = el("div", "pl-file");
      row.append(
        el("span", "pl-file-name", file.name),
        el("span", "pl-file-size", sizeText(file.size)),
        button("Open", "Open on this Mac", () => openFile(pl.editing, file)),
        button("Remove", "Remove this file from the plan", (node) => removeFile(file, node)),
      );
      rows.push(row);
    }
    pl.pending.forEach((file, index) => {
      const row = el("div", "pl-file is-pending");
      row.append(
        el("span", "pl-file-name", file.name),
        el("span", "pl-file-size", `${sizeText(file.size)} · attached when you press Save`),
        button("Drop", "Do not attach this file", () => {
          pl.pending.splice(index, 1);
          drawFiles();
        }),
      );
      rows.push(row);
    });
    pl.fileList.replaceChildren(...rows);
  }

  async function openFile(plan, file) {
    try {
      await send("POST", `${fileUrl(plan, file)}/open`);
      status(`Opened ${file.name}.`);
    } catch (err) {
      console.error("Failed while opening a plan file:", err);
      status(err.message || "The file did not open.");
    }
  }

  // Two clicks instead of a confirm dialog.
  async function removeFile(file, node) {
    if (node.textContent !== "Sure? Remove") {
      node.textContent = "Sure? Remove";
      setTimeout(() => {
        node.textContent = "Remove";
      }, 4000);
      return;
    }
    try {
      await send("DELETE", fileUrl(pl.editing, file));
      pl.editing.files = pl.editing.files.filter((item) => item !== file);
      drawFiles();
      await load();
      status(`Removed ${file.name}.`);
    } catch (err) {
      console.error("Failed while removing a plan file:", err);
      status(err.message || "The file was not removed.");
    }
  }

  /** Send the waiting files one at a time. Returns the names that failed. */
  async function uploadPending(planId) {
    const failed = [];
    for (const file of pl.pending) {
      try {
        const response = await fetch(`/plans/${encodeURIComponent(planId)}/files`, {
          method: "POST",
          headers: { "Content-Type": "application/octet-stream", "X-File-Name": encodeURIComponent(file.name) },
          body: file,
        });
        if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || "Upload failed.");
      } catch (err) {
        console.error("Failed while attaching a file to a plan:", err);
        failed.push(file.name);
      }
    }
    return failed;
  }

  async function send(method, url, body) {
    const response = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "The plan was not saved.");
    return data;
  }

  async function savePlan() {
    if (pl.saving) return;
    const f = pl.fields;
    const body = { title: f.title.value, from: f.from.value, to: f.to.value, time: f.time.value, place: f.place.value, comment: f.comment.value };
    pl.saving = true;
    f.save.disabled = true;
    try {
      const data = pl.editing
        ? await send("PUT", `/plans/${encodeURIComponent(pl.editing.id)}`, body)
        : await send("POST", "/plans", body);
      if (pl.pending.length) status(pl.pending.length === 1 ? "Attaching 1 file…" : `Attaching ${pl.pending.length} files…`);
      const failed = await uploadPending(data.plan.id);
      hideForm();
      await load();
      const saved = pl.plans.find((plan) => plan.id === data.plan.id);
      if (failed.length) status(`Saved, but these files did not attach: ${failed.join(", ")}`);
      else if (saved?.conflicts) status(`Saved. ${clashText(saved)}, so it is marked red.`);
      else status("Saved. You get an iMessage the day before.");
    } catch (err) {
      console.error("Failed while saving a plan:", err);
      status(err.message || "The plan was not saved.");
    } finally {
      pl.saving = false;
      f.save.disabled = false;
    }
  }

  // Two clicks instead of a confirm dialog.
  async function removePlan(node) {
    if (!pl.editing) return;
    if (node.textContent !== "Sure? Delete") {
      node.textContent = "Sure? Delete";
      setTimeout(() => {
        node.textContent = "Delete";
      }, 4000);
      return;
    }
    try {
      await send("DELETE", `/plans/${encodeURIComponent(pl.editing.id)}`);
      hideForm();
      await load();
      status("Deleted.");
    } catch (err) {
      console.error("Failed while deleting a plan:", err);
      status(err.message || "The plan was not deleted.");
    }
  }

  // ---- panel ----

  function build() {
    const root = el("section", "panel plpanel");
    root.hidden = true;
    const bar = el("div", "pl-bar");
    pl.status = el("span", "pl-status", "");
    const tabs = el("div", "pl-tabs");
    for (const [view, label] of [["list", "List"], ["month", "Month"], ["year", "Year"]]) {
      pl.tabs[view] = button(label, `${label} view`, () => setView(view));
      tabs.append(pl.tabs[view]);
    }
    pl.nav = el("div", "pl-nav");
    pl.nav.append(
      button("‹", "Back", () => step(-1)),
      button("Today", "Go to this month", () => {
        pl.cursor = new Date();
        draw();
      }),
      button("›", "Forward", () => step(1)),
    );
    pl.title = el("span", "pl-title", "");
    bar.append(
      el("span", "cal-title", "Plans"),
      tabs,
      pl.nav,
      pl.title,
      pl.status,
      el("span", "cal-gap"),
      button("Add plan", "A conference, a trip, or a talk", () => showForm()),
      button("Close", "Show the transcript again", () => show(false)),
    );
    pl.body = el("div", "pl-body");
    root.append(bar, buildForm(), pl.body);
    document.querySelector("main.layout").append(root);
    pl.root = root;
  }

  function show(on) {
    if (!pl.root) build();
    document.querySelector("main.layout")?.classList.toggle("plans-on", on);
    pl.root.hidden = !on;
    btn?.classList.toggle("is-on", on);
    btn?.setAttribute("aria-pressed", on ? "true" : "false");
  }

  function open() {
    window.brainWord?.close();
    window.brainSlides?.close();
    window.brainR?.close();
    window.brainPhoto?.close();
    window.brainStickies?.close();
    window.brainCalendar?.close();
    show(true);
    load();
  }

  window.brainPlans = {
    get open() {
      return Boolean(pl.root && !pl.root.hidden);
    },
    openPanel: open,
    close: () => pl.root && show(false),
    refresh: () => pl.root && !pl.root.hidden && load(),
  };

  btn?.addEventListener("click", () => {
    if (pl.root && !pl.root.hidden) show(false);
    else open();
  });
})();
