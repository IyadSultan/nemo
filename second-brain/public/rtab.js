// R in the app: a notebook in the right-hand panel, in place of the transcript, like Word and
// Slides. Type R in the box, press Run (or Cmd+Enter); the output comes back as text, tables,
// and plots, in order, like running an .R file. One R session keeps the variables between runs
// (rsession.js, rserver.R, in ~/.brain/r). Open file copies data files there and reads them in.
// While the panel is open, the orb and the question box talk to it: the brain writes the R
// (POST /r/ai), the notebook runs it, and the reply is shown above the cell.
// Each cell has a checkbox; Export writes the ticked cells (code, replies, text, tables, plots)
// to one HTML file, saved where the user picks (POST /r/export).
(() => {
  const btn = document.getElementById("rBtn");
  const r = { root: null, out: null, code: null, run: null, status: null, picker: null, busy: false, cells: [], notes: [] };

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
    r.status.textContent = text;
  }

  function setBusy(on) {
    r.busy = on;
    r.run.disabled = on;
    r.root.classList.toggle("rt-busy", on);
  }

  function scrollToEnd() {
    r.out.scrollTop = r.out.scrollHeight;
  }

  /** The R line that reads a file, by its extension, into a variable named after the file. */
  function readLine(name) {
    const ext = (name.match(/\.([^.]+)$/)?.[1] || "").toLowerCase();
    let variable = name.replace(/\.[^.]+$/, "").replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
    if (!/^[A-Za-z]/.test(variable)) variable = `d_${variable}`;
    const file = JSON.stringify(name);
    const readers = {
      csv: `readr::read_csv(${file}, show_col_types = FALSE)`,
      tsv: `readr::read_tsv(${file}, show_col_types = FALSE)`,
      txt: `readr::read_delim(${file}, show_col_types = FALSE)`,
      xlsx: `readxl::read_excel(${file})`,
      xls: `readxl::read_excel(${file})`,
      rds: `readRDS(${file})`,
      sav: `haven::read_sav(${file})`,
      dta: `haven::read_dta(${file})`,
      json: `jsonlite::fromJSON(${file})`,
    };
    if (ext === "rdata" || ext === "rda") return `load(${file}, verbose = TRUE)`;
    if (!readers[ext]) return "";
    return `${variable} <- ${readers[ext]}\ncat(nrow(${variable}), "rows,", ncol(${variable}), "columns\\n")\nhead(${variable})`;
  }

  // ---- copy and save ----

  function download(href, name) {
    const a = document.createElement("a");
    a.href = href;
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
  }

  async function copyImage(url) {
    try {
      const blob = await (await fetch(url)).blob();
      await navigator.clipboard.write([new ClipboardItem({ [blob.type || "image/png"]: blob })]);
      status("Plot copied.");
    } catch (err) {
      status(`Could not copy the plot (${err.message}). Use Save instead.`);
    }
  }

  /** Rows of a table, as arrays of cell text. */
  function tableRows(table) {
    return [...table.querySelectorAll("tr")].map((tr) => [...tr.querySelectorAll("th,td")].map((c) => c.textContent.trim()));
  }

  function csvOf(rows) {
    const cell = (v) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
    return rows.map((row) => row.map(cell).join(",")).join("\n");
  }

  async function copyTable(box) {
    const table = box.querySelector("table");
    if (!table) return;
    const rows = tableRows(table);
    const tsv = rows.map((row) => row.join("\t")).join("\n");
    try {
      await navigator.clipboard.write([new ClipboardItem({
        "text/html": new Blob([table.outerHTML], { type: "text/html" }),
        "text/plain": new Blob([tsv], { type: "text/plain" }),
      })]);
      status("Table copied. It pastes into Excel, Word, or Numbers.");
    } catch {
      try {
        await navigator.clipboard.writeText(tsv);
        status("Table copied as text.");
      } catch (err) {
        status(`Could not copy the table (${err.message}).`);
      }
    }
  }

  function saveTable(box, n) {
    const table = box.querySelector("table");
    if (!table) return;
    const blob = new Blob([csvOf(tableRows(table))], { type: "text/csv" });
    download(URL.createObjectURL(blob), `table-${n}.csv`);
  }

  function tools(...buttons) {
    const bar = el("div", "rt-tools");
    bar.append(...buttons);
    return bar;
  }

  // ---- output cells ----

  let cellCount = 0;

  /** A line from the user or the brain. It joins the next cell, so Export keeps it. */
  function addNote(who, text) {
    const note = el("p", `rt-note rt-${who}`, text);
    r.out.append(note);
    r.notes.push({ who, text, node: note });
    scrollToEnd();
  }

  function addCell(code) {
    cellCount += 1;
    const cell = { n: cellCount, code, items: [], output: "", notes: r.notes.splice(0), node: null, box: null };
    const node = el("section", "rt-cell");
    const head = el("div", "rt-head");
    const pick = el("label", "rt-pick");
    cell.box = el("input");
    cell.box.type = "checkbox";
    cell.box.title = "Include this cell in Export";
    pick.append(cell.box, el("span", null, `Cell ${cell.n}`));
    head.append(pick, el("span", "rt-gap"), button("Run again", "Put this code back in the box and run it", () => { r.code.value = code; run(code); }));
    const pre = el("pre", "rt-code", code);
    const body = el("div", "rt-body");
    node.append(head, pre, body);
    r.out.append(node);
    cell.node = node;
    cell.body = body;
    r.cells.push(cell);
    r.cells = r.cells.slice(-200);
    scrollToEnd();
    return cell;
  }

  function renderItems(cell, items) {
    const body = cell.body;
    body.replaceChildren();
    if (!items.length) body.append(el("p", "rt-quiet", "Done. Nothing was printed."));
    let plots = 0;
    let tables = 0;
    for (const item of items) {
      if (item.type === "plot") {
        plots += 1;
        const figure = el("figure", "rt-figure");
        const img = el("img", "rt-plot");
        img.src = item.url;
        img.alt = `Plot ${plots}`;
        // The picture arrives after the cell; keep the end in view once it has its height.
        img.addEventListener("load", scrollToEnd, { once: true });
        const name = `plot-${cell.n}-${plots}.png`;
        figure.append(img, tools(
          button("Copy", "Copy the picture", () => copyImage(item.url), "ghost-btn tiny"),
          button("Save", "Save the picture as PNG", () => download(item.url, name), "ghost-btn tiny"),
        ));
        body.append(figure);
      } else if (item.type === "table") {
        tables += 1;
        const wrap = el("div", "rt-tablewrap");
        const box = el("div", "rt-table");
        box.innerHTML = item.html; // escaped by knitr::kable(escape = TRUE)
        const n = `${cell.n}-${tables}`;
        wrap.append(box, tools(
          button("Copy", "Copy the table (pastes into Excel or Word)", () => copyTable(box), "ghost-btn tiny"),
          button("Save", "Save the table as CSV", () => saveTable(box, n), "ghost-btn tiny"),
        ));
        body.append(wrap);
      } else {
        body.append(el("pre", `rt-text rt-${item.type || "text"}`, item.text || ""));
      }
    }
    scrollToEnd();
  }

  async function run(code) {
    const text = String(code || "").trim();
    if (!text || r.busy) return;
    if (!r.root) build();
    show(true);
    const cell = addCell(text);
    cell.body.append(el("p", "rt-quiet", "Running…"));
    setBusy(true);
    status("");
    try {
      const response = await fetch("/r/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: text }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "R did not answer.");
      cell.items = data.items || [];
    } catch (err) {
      cell.items = [{ type: "error", text: err.message }];
    }
    renderItems(cell, cell.items);
    // What the brain may be asked about next: the code and its printed text.
    cell.output = cell.items.map((i) => (i.type === "plot" ? "[plot]" : i.type === "table" ? "[table]" : i.text || "")).join("\n").slice(0, 3000);
    setBusy(false);
    r.code.focus();
  }

  /** The brain wrote this: show it in the box with a pulse, so the change is seen. */
  function fillCode(code) {
    r.code.value = code;
    r.code.classList.remove("rt-pulse");
    void r.code.offsetWidth;
    r.code.classList.add("rt-pulse");
  }

  /** Copy the picked files into ~/.brain/r, then read each one in. */
  async function openFiles(files) {
    for (const file of files) {
      status(`Copying ${file.name}…`);
      try {
        const response = await fetch("/r/file", {
          method: "POST",
          headers: { "Content-Type": "application/octet-stream", "X-File-Name": encodeURIComponent(file.name) },
          body: file,
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || "Could not copy that file.");
        const line = readLine(data.name);
        status(line ? "" : `${data.name} is in ~/.brain/r. I do not know that file type; read it yourself.`);
        if (line) {
          fillCode(line);
          await run(line);
        }
      } catch (err) {
        status(err.message);
      }
    }
  }

  /** The brain writes the R for a request, the notebook runs it. */
  async function ask(request) {
    request = String(request || "").trim();
    if (!request || r.busy) return;
    if (!r.root) build();
    show(true);
    addNote("you", request);
    setBusy(true);
    status("Thinking…");
    const started = Date.now();
    const tick = setInterval(() => {
      const seconds = Math.round((Date.now() - started) / 1000);
      if (seconds >= 3) status(`Still writing the R… ${seconds}s`);
    }, 1000);
    try {
      const recent = r.cells.slice(-4).map((c) => ({ code: c.code, output: c.output }));
      const response = await fetch("/r/ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ request, recent, model: document.getElementById("modelSelect")?.value || "" }),
      });
      const data = await response.json().catch(() => ({}));
      clearInterval(tick);
      if (!response.ok) throw new Error(data.error || "The model did not answer.");
      if (data.say) addNote("brain", data.say);
      setBusy(false);
      status("");
      if (data.code) {
        fillCode(data.code);
        await run(data.code);
      }
    } catch (err) {
      clearInterval(tick);
      addNote("brain", err.message);
      setBusy(false);
      status("");
    }
  }

  /** A sentence heard while the panel is open: only "Hey, …" counts, like the Word editor. */
  let lastHeard = { words: "", at: 0 };
  function hear(raw) {
    const said = window.questionAfterWake ? window.questionAfterWake(raw) : String(raw || "").trim();
    if (said === null || r.busy) return;
    if (!said) {
      status("Listening: say the request.");
      return;
    }
    const key = said.toLowerCase().replace(/[^\p{L}\p{N} ]+/gu, "").trim();
    if (key === lastHeard.words && Date.now() - lastHeard.at < 30_000) return;
    lastHeard = { words: key, at: Date.now() };
    if (/^(close|exit|leave)( the)? (r|notebook|r notebook|r panel)$|^(done|i'?m done)$/i.test(key)) return show(false);
    if (/^(clear|clear the output)$/i.test(key)) return clearOutput();
    if (said.split(/\s+/).length >= 2) ask(said);
  }

  /** "open R" or "open the R notebook" from the main chat. */
  function command(question) {
    if (!/\b(open|show|start)\b.*\b(r notebook|r panel|r console|r editor|r studio|rstudio|\br\b)\s*$/i.test(String(question || "").trim())) return false;
    open();
    return true;
  }

  // ---- export ----

  const escapeHtml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  async function dataUrl(url) {
    const blob = await (await fetch(url)).blob();
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error("Could not read a plot."));
      reader.readAsDataURL(blob);
    });
  }

  /** One self-contained HTML page of the chosen cells: replies, code, text, tables, plots inline. */
  async function exportHtml(cells) {
    const parts = [];
    for (const cell of cells) {
      const bits = [];
      for (const note of cell.notes) bits.push(`<p class="note ${note.who}">${escapeHtml(note.text)}</p>`);
      bits.push(`<pre class="code">${escapeHtml(cell.code)}</pre>`);
      for (const item of cell.items) {
        if (item.type === "plot") bits.push(`<img src="${await dataUrl(item.url)}" alt="Plot">`);
        else if (item.type === "table") bits.push(`<div class="table">${item.html}</div>`);
        else bits.push(`<pre class="out ${escapeHtml(item.type || "text")}">${escapeHtml(item.text || "")}</pre>`);
      }
      parts.push(`<section class="cell">${bits.join("\n")}</section>`);
    }
    const when = new Date().toLocaleString("en-GB", { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" });
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>R analysis</title>
<style>
body{font:15px/1.5 -apple-system,"Helvetica Neue",Arial,sans-serif;color:#1d1d1f;max-width:960px;margin:2rem auto;padding:0 1.25rem}
h1{font-size:1.5rem;margin:0 0 .25rem}.when{color:#666;margin:0 0 1.5rem}
.cell{border:1px solid #e3e3e8;border-radius:12px;margin:0 0 1.25rem;overflow:hidden}
.note{margin:0;padding:.6rem 1rem;font-size:.95rem}.note.you{background:#eef3ff}.note.brain{background:#f7f7f9;border-bottom:1px solid #e3e3e8}
pre{margin:0;padding:.75rem 1rem;font:13px/1.45 "SF Mono",Menlo,monospace;white-space:pre-wrap;word-break:break-word}
.code{background:#f3faf7;color:#444;border-bottom:1px solid #e3e3e8}.out{background:#fff}.error{color:#b00020}.warning{color:#8a5a00}.message{color:#666}
img{display:block;max-width:100%;height:auto;margin:.75rem 1rem}
.table{padding:.75rem 1rem;overflow-x:auto}table{border-collapse:collapse;font-size:13px}th,td{padding:4px 10px;border-bottom:1px solid #e3e3e8;white-space:nowrap}th{text-align:left;background:#f7f7f9}
.rt-more{color:#666;font-size:.85rem}
@media print{.cell{break-inside:avoid}}
</style></head><body>
<h1>R analysis</h1><p class="when">${escapeHtml(when)} · ${cells.length} cell${cells.length === 1 ? "" : "s"}</p>
${parts.join("\n")}
</body></html>`;
  }

  async function exportCells() {
    const chosen = r.cells.filter((c) => c.box.checked);
    const cells = chosen.length ? chosen : r.cells;
    if (!cells.length) return status("Nothing to export yet. Run some R first.");
    status(chosen.length ? `Exporting ${cells.length} ticked cell${cells.length === 1 ? "" : "s"}…` : `No cell is ticked, so all ${cells.length} are exported…`);
    try {
      const html = await exportHtml(cells);
      const response = await fetch("/r/export", {
        method: "POST",
        headers: { "Content-Type": "text/html", "X-File-Name": encodeURIComponent(`R analysis ${new Date().toISOString().slice(0, 10)}.html`) },
        body: html,
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Could not save the export.");
      status(data.cancelled ? "Export cancelled." : `Saved ${data.path}`);
      if (!data.cancelled && data.path) {
        const name = String(data.path).split("/").pop();
        if (name) noteChatFile({ name, title: name, summary: "An R export saved from this chat.", made: true });
      }
    } catch (err) {
      status(err.message);
    }
  }

  function clearOutput() {
    r.out.replaceChildren();
    r.cells = [];
    r.notes = [];
  }

  async function restart() {
    await fetch("/r/restart", { method: "POST" }).catch(() => {});
    clearOutput();
    status("R restarted. Variables are gone; files in ~/.brain/r stay.");
    setBusy(false);
  }

  // ---- the panel ----

  function build() {
    const root = el("section", "panel rpanel");
    root.hidden = true;
    const bar = el("div", "rt-bar");
    r.status = el("span", "rt-status", "");
    bar.append(
      el("span", "rt-title", "R"),
      el("span", "rt-where", "~/.brain/r"),
      r.status,
      el("span", "rt-gap"),
      button("Open files", "Pick CSV, Excel, RDS, or RData files. They are copied into ~/.brain/r and read into R.", () => r.picker.click()),
      button("Export", "Save the ticked cells (or all) as one HTML file, where you choose", exportCells),
      button("Clear", "Clear the output (R keeps its variables)", clearOutput),
      button("Restart R", "End this R session and start a new one", restart),
      button("Transcript", "Show the transcript again (R keeps running)", () => show(false)),
      button("Close", "Close the R panel (R keeps running until restarted)", () => show(false)),
    );
    r.out = el("div", "rt-out");
    const editor = el("div", "rt-editor");
    r.code = el("textarea", "rt-input");
    r.code.placeholder = "R code. Cmd+Enter runs it. Or ask the brain in the box on the left.";
    r.code.spellcheck = false;
    r.code.rows = 4;
    r.code.addEventListener("keydown", (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        run(r.code.value);
      }
    });
    r.code.addEventListener("animationend", () => r.code.classList.remove("rt-pulse"));
    r.run = button("Run", "Run the code (Cmd+Enter)", () => run(r.code.value), "ghost-btn small rt-run");
    editor.append(r.code, r.run);
    r.picker = el("input");
    r.picker.type = "file";
    r.picker.multiple = true;
    r.picker.accept = ".csv,.tsv,.txt,.xlsx,.xls,.rds,.RData,.rda,.sav,.dta,.json";
    r.picker.hidden = true;
    r.picker.addEventListener("change", () => {
      const files = [...(r.picker.files || [])];
      r.picker.value = "";
      if (files.length) openFiles(files);
    });
    root.append(bar, r.out, editor, r.picker);
    document.querySelector("main.layout").append(root);
    r.root = root;
  }

  function show(on) {
    if (!r.root) build();
    document.querySelector("main.layout")?.classList.toggle("r-on", on);
    r.root.hidden = !on;
    btn?.classList.toggle("is-on", on);
    if (on) r.code.focus();
  }

  function open() {
    if (!r.root) build();
    window.brainWord?.close();
    window.brainSlides?.close();
    window.brainPhoto?.close();
    window.brainMovie?.close();
    window.brainCalendar?.close();
    window.brainStickies?.close();
    window.brainPlans?.close();
    window.brainScreen?.close();
    show(true);
  }

  window.brainR = {
    get open() {
      return Boolean(r.root && !r.root.hidden);
    },
    openPanel: open,
    close: () => show(false),
    run,
    ask,
    hear,
    command,
  };
  btn?.addEventListener("click", () => {
    const showing = r.root && !r.root.hidden;
    if (showing) show(false);
    else open();
  });
})();
