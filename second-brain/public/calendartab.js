// Calendar in the app: the days Outlook has ready on this Mac, in place of the transcript.
// The list comes from GET /calendar (the same file the spoken "what meetings" answer uses).
// It is not the whole year. Open in Outlook launches the Outlook app.
(() => {
  const btn = document.getElementById("calendarBtn");
  const cal = { root: null, days: null, form: null, fields: null, status: null, busy: false, saving: false };

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
      action();
    });
    return node;
  }

  function status(text) {
    cal.status.textContent = text;
  }

  function eventCard(event) {
    const card = el("article", "cal-event");
    const when = event.allDay ? "All day" : (event.end ? `${event.start} – ${event.end}` : event.start);
    card.append(el("p", "cal-time", when), el("p", "cal-subject", event.subject || "Untitled"));
    if (event.location) card.append(el("p", "cal-where", event.location));
    return card;
  }

  function draw(board) {
    cal.days.replaceChildren();
    const days = board?.days || [];
    if (!days.length) {
      cal.days.append(el("p", "cal-empty", "Outlook has no days ready. Open Outlook, then press Refresh."));
      return;
    }
    for (const day of days) {
      const column = el("section", day.today ? "cal-day is-today" : "cal-day");
      const head = el("div", "cal-head");
      const row = el("div", "cal-head-row");
      const add = button("+", `Add an appointment on ${day.label}`, () => showForm(day.date));
      add.classList.add("cal-plus");
      row.append(el("p", "cal-weekday", day.today ? `${day.weekday} · today` : day.weekday), add);
      head.append(row, el("p", "cal-date", day.label));
      const list = el("div", "cal-list");
      if (!day.events.length) list.append(el("p", "cal-empty", "Nothing"));
      else day.events.forEach((event) => list.append(eventCard(event)));
      column.append(head, list);
      cal.days.append(column);
    }
    const first = days[0];
    const last = days[days.length - 1];
    const count = days.reduce((sum, day) => sum + day.events.length, 0);
    status(`${first.label} – ${last.label}. ${count === 1 ? "1 meeting" : `${count} meetings`}.`);
    cal.days.querySelector(".is-today")?.scrollIntoView({ inline: "center", block: "nearest" });
  }

  async function load() {
    if (cal.busy) return;
    cal.busy = true;
    cal.root.classList.add("cal-busy");
    status("Reading Outlook…");
    try {
      const response = await fetch("/calendar");
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Could not read the calendar.");
      draw(data);
    } catch (err) {
      console.error("Failed while loading the calendar tab:", err);
      status(err.message || "Could not read the calendar.");
      cal.days.replaceChildren(el("p", "cal-empty", err.message || "Could not read the calendar."));
    } finally {
      cal.busy = false;
      cal.root.classList.remove("cal-busy");
    }
  }

  const pad = (n) => String(n).padStart(2, "0");

  /** The next whole hour, for one hour. Late at night this stays 10 pm to 11 pm, so it does not spill into the next day. */
  function defaultTimes(now = new Date()) {
    const hour = Math.min(now.getHours() + 1, 22);
    return { start: `${pad(hour)}:00`, end: `${pad(hour + 1)}:00` };
  }

  function showForm(date) {
    if (!cal.form) return;
    const times = defaultTimes();
    if (!cal.fields.start.value) cal.fields.start.value = times.start;
    if (!cal.fields.end.value) cal.fields.end.value = times.end;
    if (date) cal.fields.date.value = date;
    else if (!cal.fields.date.value) {
      const today = new Date();
      cal.fields.date.value = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
    }
    cal.form.hidden = false;
    cal.fields.title.focus();
  }

  function hideForm() {
    if (cal.form) cal.form.hidden = true;
  }

  async function saveAppointment() {
    if (cal.saving) return;
    const body = {
      subject: cal.fields.title.value,
      date: cal.fields.date.value,
      start: cal.fields.start.value,
      end: cal.fields.end.value,
      location: cal.fields.place.value,
    };
    cal.saving = true;
    cal.fields.save.disabled = true;
    status("Opening the appointment in Outlook…");
    try {
      const response = await fetch("/calendar/appointment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Outlook did not open.");
      cal.fields.title.value = "";
      cal.fields.place.value = "";
      hideForm();
      status("Outlook opened that appointment. Press Add there if it looks right, then Refresh here.");
    } catch (err) {
      console.error("Failed while adding an appointment from the calendar tab:", err);
      status(err.message || "Outlook did not open.");
    } finally {
      cal.saving = false;
      cal.fields.save.disabled = false;
    }
  }

  function field(label, input) {
    const wrap = el("label", "cal-field");
    wrap.append(el("span", "cal-label", label), input);
    return wrap;
  }

  function textInput(type) {
    const node = document.createElement("input");
    node.type = type;
    node.className = "cal-input";
    return node;
  }

  function buildForm() {
    const form = el("form", "cal-form");
    form.hidden = true;
    const title = textInput("text");
    title.maxLength = 120;
    title.placeholder = "Ward round";
    title.autocomplete = "off";
    const date = textInput("date");
    const start = textInput("time");
    const end = textInput("time");
    const place = textInput("text");
    place.maxLength = 80;
    place.placeholder = "Optional";
    place.autocomplete = "off";
    const save = button("Add in Outlook", "Open this appointment in Outlook. Nothing is saved until you press Add there.", () => {});
    save.classList.add("primary");
    save.type = "submit";
    form.append(
      field("Title", title),
      field("Day", date),
      field("Start", start),
      field("End", end),
      field("Place", place),
      save,
      button("Cancel", "Hide this form", hideForm),
    );
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      saveAppointment();
    });
    cal.form = form;
    cal.fields = { title, date, start, end, place, save };
    return form;
  }

  async function openOutlook() {
    status("Opening Outlook…");
    try {
      const response = await fetch("/calendar/open", { method: "POST" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Microsoft Outlook did not open.");
      status("Outlook is open.");
    } catch (err) {
      console.error("Failed while opening Outlook from the calendar tab:", err);
      status(err.message || "Microsoft Outlook did not open.");
    }
  }

  function build() {
    const root = el("section", "panel calpanel");
    root.hidden = true;
    const bar = el("div", "cal-bar");
    cal.status = el("span", "cal-status", "");
    bar.append(
      el("span", "cal-title", "Calendar"),
      cal.status,
      el("span", "cal-gap"),
      button("Add appointment", "Type a title, a day, and a time", () => showForm()),
      button("Refresh", "Read Outlook's calendar again", load),
      button("Open in Outlook", "Open the Microsoft Outlook app", openOutlook),
      button("Close", "Show the transcript again", () => show(false)),
    );
    cal.days = el("div", "cal-days");
    root.append(bar, buildForm(), cal.days);
    document.querySelector("main.layout").append(root);
    cal.root = root;
  }

  function show(on) {
    if (!cal.root) build();
    document.querySelector("main.layout")?.classList.toggle("cal-on", on);
    cal.root.hidden = !on;
    btn?.classList.toggle("is-on", on);
    btn?.setAttribute("aria-pressed", on ? "true" : "false");
  }

  function open() {
    window.brainWord?.close();
    window.brainSlides?.close();
    window.brainR?.close();
    window.brainPhoto?.close();
    window.brainStickies?.close();
    show(true);
    load();
  }

  /** "Open the calendar" or "close the calendar", with no model call. */
  function command(question) {
    const q = String(question || "").toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
    if (/^(?:please |hey )?(?:open|show)(?: me)? (?:the |my )?(?:outlook )?calendar$/.test(q)) return "open";
    if (/^(?:please |hey )?(?:close|hide)(?: me)? (?:the |my )?(?:outlook )?calendar$/.test(q)) return "close";
    if (/^(?:please |hey )?(?:add|new)(?: me)? (?:an |a )?(?:new )?(?:outlook )?(?:appointment|meeting)(?: on (?:the |my )?calendar)?$/.test(q)) return "add";
    return "";
  }

  window.brainCalendar = {
    get open() {
      return Boolean(cal.root && !cal.root.hidden);
    },
    openPanel: open,
    addAppointment() {
      open();
      showForm();
    },
    close: () => cal.root && show(false),
    command,
  };

  btn?.addEventListener("click", () => {
    if (cal.root && !cal.root.hidden) show(false);
    else open();
  });
})();
