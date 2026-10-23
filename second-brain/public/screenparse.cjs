/**
 * Turns a spoken sentence into a screen-recorder order.
 * The page and the tests both load this file, so they agree on every phrase.
 *
 * These phrases are exact on purpose. "Write the minutes" still belongs to the
 * Meeting button. "Write the minutes of the recording" belongs here.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.parseScreenCommand = api.parseScreenCommand;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  function parseScreenCommand(text) {
    const q = String(text || "").toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
    if (!q) return null;
    const called = q.match(/^(.*?)\s+called\s+(.+)$/);
    const body = (called ? called[1] : q).trim();
    const title = called ? called[2].trim() : "";
    const prefix = "^(?:please |hey )?";
    const startScreen = new RegExp(`${prefix}(?:record|start recording) (?:the |my |this |a )?(?:whole )?screen$`);
    const startZoom = new RegExp(`${prefix}(?:record|start recording) (?:this |the |a )?(?:zoom meeting|zoom call|zoom|tutorial)$`);
    const startNamed = new RegExp(`${prefix}start (?:a )?screen recording$`);
    if (startScreen.test(body) || startZoom.test(body) || startNamed.test(body)) {
      return { op: "start", title };
    }
    if (new RegExp(`${prefix}(?:stop|end) (?:the )?(?:screen )?recording$`).test(body)) return { op: "stop" };
    if (new RegExp(`${prefix}(?:open|show) (?:the )?screen (?:recorder|recordings)$`).test(body)) return { op: "open" };
    if (new RegExp(`${prefix}close (?:the )?screen (?:recorder|recordings)$`).test(body)) return { op: "close" };
    const job = new RegExp(`${prefix}(?:write|make|add) (?:the |a )?(?:summary|minutes|captions|caption|recap)\\b`);
    if (/\brecording\b/.test(body) && job.test(body)) {
      if (/\bcaptions?\b/.test(body)) return { op: "captions" };
      if (/\brecap\b/.test(body)) return { op: "recap" };
      return { op: "summary" };
    }
    return null;
  }

  return { parseScreenCommand };
});
