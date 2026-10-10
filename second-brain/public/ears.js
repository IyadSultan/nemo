/**
 * Google speech recognition, built into Chrome.
 *
 * Words arrive while you are still talking (about 0.3 s), so "stop" can cut
 * the voice at once, and a question is ready as soon as you pause.
 * The audio goes to Google's speech servers. This app keeps no recording.
 *
 * With local: true, Chrome recognizes speech on this Mac (its on-device model)
 * and no audio leaves the machine. Call prepareLocalEars() first.
 *
 * createEars() returns null when the browser has no speech recognition,
 * so the page can fall back to whisper on the Mac.
 */

const LOCAL_OPTIONS = { langs: ["en-US"], processLocally: true };

/**
 * Make sure Chrome's on-device English model is ready, downloading it once if needed.
 * Returns "available", or a reason it is not ("unavailable", "download failed", ...).
 */
async function prepareLocalEars() {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition?.available) return "unsupported";
  try {
    const status = await Recognition.available(LOCAL_OPTIONS);
    if (status === "available") return status;
    if (status === "unavailable") return status;
    // "downloadable" or "downloading": ask Chrome to fetch the model.
    const ok = await Recognition.install(LOCAL_OPTIONS);
    return ok ? "available" : "download failed";
  } catch (err) {
    console.error("Failed while checking Chrome's on-device speech:", err);
    return `error: ${err?.message || err}`;
  }
}

function createEars({ onWords, onUtterance, onFail, pauseMs = 900, local = false }) {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition) return null;

  let running = false;
  let rec = null;
  let heard = "";
  let pending = "";
  let quietTimer = 0;

  // Chrome splits one question into several final pieces at short pauses.
  // Join them, and hand the whole sentence over after pauseMs of quiet.
  function armQuietTimer() {
    clearTimeout(quietTimer);
    quietTimer = setTimeout(() => {
      if (pending) return armQuietTimer();
      const text = heard.trim();
      heard = "";
      if (text) onUtterance(text);
    }, pauseMs);
  }

  function open() {
    rec = new Recognition();
    rec.lang = "en-US";
    rec.continuous = true;
    rec.interimResults = true;
    if (local) rec.processLocally = true;
    rec.onresult = (event) => {
      pending = "";
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        const text = result[0].transcript.trim();
        if (!text) continue;
        if (result.isFinal) heard = `${heard} ${text}`;
        else pending = `${pending} ${text}`;
      }
      pending = pending.trim();
      onWords(`${heard} ${pending}`.trim(), pending);
      armQuietTimer();
    };
    rec.onerror = (event) => {
      if (event.error === "no-speech" || event.error === "aborted") return;
      console.error("Google speech error:", event.error);
      if (["not-allowed", "service-not-allowed", "network", "audio-capture"].includes(event.error)) {
        running = false;
        onFail(event.error);
      }
    };
    // Chrome ends a session after a long quiet spell. Open a new one at once.
    rec.onend = () => {
      if (running) setTimeout(() => running && open(), 100);
    };
    rec.start();
  }

  return {
    start() {
      if (running) return;
      running = true;
      heard = "";
      pending = "";
      open();
    },
    stop() {
      running = false;
      clearTimeout(quietTimer);
      heard = "";
      pending = "";
      try { rec?.abort(); } catch { /* already stopped */ }
    },
    /** Forget the words heard so far, so they do not join the next question. */
    reset() {
      clearTimeout(quietTimer);
      heard = "";
      pending = "";
    },
    get running() { return running; },
    local,
  };
}
