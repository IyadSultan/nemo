/**
 * Remote control of the voice page over one SSE stream (/control): Hammerspoon posts
 * stop or listen, and the server pushes desk, job and briefing events to every open page.
 */



/**
 * Remote control for the voice page.
 * Hammerspoon's Cmd+Opt+S posts /control/stop (stop the answer).
 * Hammerspoon's Command and Control together posts /control/listen (start listening, like saying Hey).
 * Every open voice page hears these on /control.
 */
export const controlClients = new Set();

export function sendControl(event, data = {}) {
  for (const client of controlClients) client.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export function registerControl(app) {
  app.get("/control", (req, res) => {
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache");
    res.flushHeaders?.();
    controlClients.add(res);
    req.on("close", () => controlClients.delete(res));
  });

  app.post("/control/stop", (_req, res) => {
    for (const client of controlClients) client.write("event: stop\ndata: {}\n\n");
    res.json({ ok: true, pages: controlClients.size });
  });

  app.post("/control/listen", (_req, res) => {
    sendControl("listen");
    res.json({ ok: true, pages: controlClients.size });
  });
}
