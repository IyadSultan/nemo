/**
 * Terminals on the page, drawn with xterm.js.
 *
 * 1. The shell: a real login shell from the Rust server (GET /term, a WebSocket),
 *    in a panel at the bottom of the main page. The Terminal button, or saying
 *    "open a terminal", opens it; "close the terminal" or × closes it and ends the shell.
 * 2. A helper's progress: clicking a helper's avatar under an answer opens a
 *    read-only terminal with everything that helper has written and read so far,
 *    and it keeps updating while the helper works.
 */
(() => {
  const THEME = {
    background: "#0a0c10",
    foreground: "#e6e8ee",
    cursor: "#2fc6a0",
    selectionBackground: "#2fc6a055",
  };
  const FONT = '"SF Mono", Menlo, Monaco, monospace';

  function makeTerm(readOnly) {
    const term = new Terminal({
      theme: THEME,
      fontFamily: FONT,
      fontSize: 13,
      cursorBlink: !readOnly,
      disableStdin: readOnly,
      convertEol: readOnly,
      scrollback: 5000,
    });
    const fit = new FitAddon.FitAddon();
    term.loadAddon(fit);
    return { term, fit };
  }

  // ---- 1. The shell on the main page ----

  let shell = null; // { panel, term, fit, ws, observer }

  function openShell() {
    if (shell) {
      shell.term.focus();
      return;
    }
    const panel = document.createElement("section");
    panel.className = "term-dock";
    panel.setAttribute("aria-label", "Terminal");
    panel.innerHTML = `<header class="term-bar"><span class="term-title">Terminal</span>
      <button type="button" class="term-close" aria-label="Close the terminal" title="Close (ends the shell)">×</button></header>
      <div class="term-screen"></div>`;
    document.body.append(panel);
    const { term, fit } = makeTerm(false);
    term.open(panel.querySelector(".term-screen"));
    fit.fit();

    const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/term`);
    ws.binaryType = "arraybuffer";
    const encoder = new TextEncoder();
    const sendSize = () => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ cols: term.cols, rows: term.rows }));
    };
    ws.onopen = sendSize;
    ws.onmessage = (event) => term.write(new Uint8Array(event.data));
    ws.onclose = () => term.write("\r\n\x1b[2m[Disconnected. Close and reopen for a new shell.]\x1b[0m\r\n");
    term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(encoder.encode(data));
    });
    term.onResize(sendSize);
    const observer = new ResizeObserver(() => fit.fit());
    observer.observe(panel);

    panel.querySelector(".term-close").addEventListener("click", closeShell);
    shell = { panel, term, ws, observer };
    term.focus();
  }

  function closeShell() {
    if (!shell) return;
    shell.observer.disconnect();
    shell.ws.close();
    shell.term.dispose();
    shell.panel.remove();
    shell = null;
  }

  // ---- 2. A helper's progress ----

  let popup = null; // { mate, term, back, onKey }

  /** Keep what a helper wrote, and show it live if its terminal is open. */
  function agentLog(mate, text) {
    mate.termLog = (mate.termLog || "") + text;
    if (popup?.mate === mate) popup.term.write(text);
  }

  function showAgent(mate) {
    closeAgent();
    const name = mate.querySelector(".mate-name")?.textContent || "Helper";
    const back = document.createElement("div");
    back.className = "term-backdrop";
    back.innerHTML = `<section class="term-popup" role="dialog" aria-label="${name}'s progress">
      <header class="term-bar"><span class="term-dot"></span><span class="term-title"></span>
      <button type="button" class="term-close" aria-label="Close">×</button></header>
      <div class="term-screen"></div></section>`;
    back.querySelector(".term-title").textContent = `${name} — ${mate.title.replace(/^[^:]*:\s*/, "")}`;
    back.querySelector(".term-dot").style.background = getComputedStyle(mate).getPropertyValue("--mate");
    document.body.append(back);
    const { term, fit } = makeTerm(true);
    term.open(back.querySelector(".term-screen"));
    fit.fit();
    term.write(mate.termLog || "\x1b[2mWaiting for the helper to start…\x1b[0m\n");

    const onKey = (event) => event.key === "Escape" && closeAgent();
    back.addEventListener("click", (event) => event.target === back && closeAgent());
    back.querySelector(".term-close").addEventListener("click", closeAgent);
    document.addEventListener("keydown", onKey);
    popup = { mate, term, back, onKey };
  }

  function closeAgent() {
    if (!popup) return;
    document.removeEventListener("keydown", popup.onKey);
    popup.term.dispose();
    popup.back.remove();
    popup = null;
  }

  // ---- Spoken or typed requests ----

  /**
   * "Open a terminal", "can u show me the terminal", "close the terminal".
   * Short requests only, so "how do I open a terminal on Windows" still goes to the brain.
   * Returns "open", "close", or "".
   */
  function intent(text) {
    const q = String(text || "").toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, " ").replace(/\s+/g, " ").trim();
    if (!q || q.split(" ").length > 9 || !/\bterminal\b/.test(q)) return "";
    if (/^(?:how|what|why|where|when|which|who)\b/.test(q)) return "";
    if (/\b(?:close|hide|exit|quit|kill|end|dismiss)\b/.test(q)) return "close";
    if (/\b(?:open|show|launch|start|bring up|pop up|give me|need|want)\b/.test(q) || /^(?:hey )?terminal(?: please| pls)?$/.test(q)) return "open";
    return "";
  }

  window.brainTerminal = { openShell, closeShell, showAgent, agentLog, intent };
  document.getElementById("terminalBtn")?.addEventListener("click", () => (shell ? closeShell() : openShell()));
})();
