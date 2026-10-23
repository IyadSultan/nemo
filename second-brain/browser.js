/**
 * The browser agent (rust/src/browser, rebuilt after browser-use). An order said or typed,
 * such as "browser: order a large pizza on dominos.jo", becomes a short plan. After one yes,
 * the Rust front drives its own Chrome window until the task is done.
 * Progress goes to the page as `browser` control events; the result is read aloud as a `job`.
 */
import fsSync from "node:fs";
import path from "node:path";
import { sendControl } from "./control.js";

const TOKEN_FILE = path.join(path.dirname(new URL(import.meta.url).pathname), "tmp", "team.token");
// A plan waits this long for its yes.
const PENDING_MS = 15 * 60 * 1000;

let pending = null; // { task, plan, questions, at }
let running = false;

// Read when used: .env is loaded after imports run.
const frontUrl = () => process.env.BROWSER_URL || "http://127.0.0.1:3001";

function plain(question) {
  return String(question || "").toLowerCase().replace(/[^\p{L}\p{N}\s'./:-]/gu, " ").replace(/\s+/g, " ").trim();
}

/** A browser order, or null. Returns the task in the user's words. */
export function parseBrowserJob(question) {
  const q = String(question || "").trim();
  const named = q.match(/^\/?browser\s*[:,-]?\s+(.+)$/is)
    || q.match(/^(?:please |pls |can (?:you|u) |could (?:you|u) )?(?:use (?:the |my )?browser (?:to|and)|in the browser,?|go online and)\s+(.+)$/is);
  if (named) return { task: named[1].trim() };
  const site = String.raw`[a-z0-9-]+\.[a-z]{2,}(?:\.[a-z]{2})?(?:/\S*)?`;
  const asks = [
    new RegExp(String.raw`^(?:please |pls )?(?:go to|open|visit) (?:https?://)?${site},? (?:and|then) .+`, "is"),
    /\bfill (?:in |out )?(?:the |this |a |my )?(?:\w+ )?(?:form|application)\b.*\b(?:on|at) /is,
    new RegExp(String.raw`\b(?:order|buy|book|reserve|sign up for|register for|apply for) .+ (?:on|from|at|with) (?:https?://)?${site}`, "is"),
  ];
  return asks.some((re) => re.test(q)) ? { task: q } : null;
}

function token() {
  return fsSync.readFileSync(TOKEN_FILE, "utf8").trim();
}

async function front(route, body, signal) {
  return fetch(`${frontUrl()}/browser/${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-team-token": token() },
    body: JSON.stringify(body || {}),
    signal,
  });
}

function planReply(made) {
  const lines = made.plan.map((step, i) => `${i + 1}. ${step}`);
  const ask = made.questions.length
    ? `Before I start: ${made.questions.join(" ")} Tell me, or say yes to go ahead without it.`
    : "Say yes to start, or no to cancel.";
  return {
    text: `${made.spoken ? made.spoken + " " : ""}Here is my plan.\n${lines.join("\n")}\n${ask}`,
    card: { title: "Browser plan", lines },
  };
}

async function makePlan(task) {
  const res = await front("plan", { task }, AbortSignal.timeout(180000));
  const made = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(made.error || `status ${res.status}`);
  pending = { task, plan: made.plan, questions: made.questions || [], at: Date.now() };
  sendControl("browser", { type: "plan" });
  return planReply(made);
}

/** Start the approved task. The page hears each step; the result is spoken when it ends. */
async function startRun(task, plan) {
  const res = await front("run", { task, plan }, AbortSignal.timeout(60 * 60 * 1000));
  if (res.status === 409) return { text: "The browser is still busy with the last task. Say stop the browser to end it." };
  if (!res.ok) throw new Error(`status ${res.status}`);
  running = true;
  sendControl("browser", { type: "start", task, plan });
  (async () => {
    const decoder = new TextDecoder();
    let buffer = "";
    let ended = false;
    try {
      for await (const chunk of res.body) {
        buffer += decoder.decode(chunk, { stream: true });
        const parts = buffer.split("\n\n");
        buffer = parts.pop() || "";
        for (const part of parts) {
          if (!part.startsWith("data:")) continue;
          let ev;
          try {
            ev = JSON.parse(part.slice(5));
          } catch {
            continue;
          }
          sendControl("browser", ev);
          if (ev.type === "done") {
            ended = true;
            sendControl("job", { text: ev.text });
          }
        }
      }
    } catch (err) {
      console.error("Failed while reading the browser task:", err?.message || err);
    } finally {
      running = false;
      if (!ended) sendControl("job", { text: "The browser task ended without a result." });
    }
  })();
  return { text: "Starting now in the browser window. I'll tell you when it's done." };
}

const YES = /^(?:yes|yeah|yep|yup|ok|okay|sure|go|go ahead|start|do it|run it|sounds good|perfect|نعم|ايوه|أيوه|تمام|ماشي)(?:\s|$)/u;
const NO = /^(?:no|nope|cancel|never ?mind|don't|dont|لا|الغي|إلغاء)(?:\s|$)/u;

/**
 * Answers that belong to the browser: yes or no to a waiting plan, the missing facts it
 * asked for, "stop the browser", and "tell the browser …" while a task runs. Null otherwise.
 */
export async function browserFollowUp(question) {
  const q = plain(question);
  if (/^(?:stop|cancel|halt|end) (?:the )?(?:browser|browsing|web task|browser task)\b/.test(q)) {
    pending = null;
    if (!running) return { text: "The browser is not doing anything." };
    await front("stop");
    return { text: "Stopping the browser after this step." };
  }
  const note = String(question || "").trim().match(/^(?:tell the browser|browser note)[:,]?\s+(.+)$/is)
    || (running && String(question || "").trim().match(/^\/?browser\s*[:,-]?\s+(.+)$/is));
  if (note) {
    if (!running) return null;
    await front("say", { text: note[1] });
    return { text: "Got it. The browser will use that from the next step." };
  }
  if (!pending) return null;
  if (Date.now() - pending.at > PENDING_MS) {
    pending = null;
    return null;
  }
  const job = pending;
  if (YES.test(q)) {
    pending = null;
    return startRun(job.task, job.plan);
  }
  if (NO.test(q)) {
    pending = null;
    return { text: "OK, I won't do it." };
  }
  if (job.questions.length) return makePlan(`${job.task}\nThe user added: ${String(question).trim()}`);
  // Something else: the plan is dropped, and the question goes on as usual.
  pending = null;
  return null;
}

/**
 * A new browser order: make the plan and wait for yes. Null when it is not one.
 * `inTab`: the Browser tab is open, so anything typed or said is for the browser.
 */
export async function browserJob(question, inTab = false) {
  const job = parseBrowserJob(question) || (inTab && String(question || "").trim() ? { task: String(question).trim() } : null);
  if (!job) return null;
  if (running) return { text: "The browser is busy with a task. Say stop the browser, or tell the browser what to change." };
  return makePlan(job.task);
}
