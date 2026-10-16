/**
 * Tiny mode, for the Second Brain window app only (not Chrome).
 *
 * After 3 minutes with nothing happening, the window shrinks to Tiny alone,
 * in the bottom-right corner, above other windows. The brain keeps listening
 * and answering while small. Clicking Tiny brings the whole app back.
 *
 * "Nothing happening": no mouse or keys in the window, Tiny not thinking or
 * speaking, and no meeting or lecture running.
 * The window app does the resizing; this page tells it "tiny" or "full".
 */
(function startTinyMode() {
  if (!window.ipc?.postMessage) return;
  const IDLE_MS = 3 * 60_000;
  const capsule = document.getElementById("capsule");
  let lastActive = Date.now();
  let tiny = false;

  const busy = () => {
    const state = capsule?.dataset.state || "idle";
    // meetingOn is voice.js's flag for a meeting or lecture in progress.
    return !["idle", "listening", "muted"].includes(state) || (typeof meetingOn !== "undefined" && meetingOn);
  };
  const touch = () => { lastActive = Date.now(); };

  function setTiny(on) {
    if (tiny === on) return;
    tiny = on;
    document.documentElement.classList.toggle("tiny-mode", on);
    document.body.classList.toggle("tiny-mode", on);
    window.ipc.postMessage(on ? "tiny" : "full");
    touch();
  }

  for (const type of ["pointermove", "pointerdown", "keydown", "wheel"]) {
    document.addEventListener(type, () => { if (!tiny) touch(); }, { passive: true, capture: true });
  }
  // While small, a click anywhere on Tiny opens the app (and does nothing else).
  document.addEventListener("click", (event) => {
    if (!tiny) return;
    event.preventDefault();
    event.stopPropagation();
    setTiny(false);
  }, true);

  setInterval(() => {
    if (busy()) touch();
    else if (!tiny && Date.now() - lastActive >= IDLE_MS) setTiny(true);
  }, 5000);
})();
