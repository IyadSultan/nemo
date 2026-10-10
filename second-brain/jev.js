/**
 * No-wake-word listening: decide whether a sentence the mic heard is meant
 * for the second brain.
 *
 * One request per finished sentence, with narrow questions
 * (is it for the assistant? is it complete? which function? is it an echo?).
 * The decision itself is made in code below, from the thresholds in JEV.
 *
 * Backend "gemma" (default): a small local LLM through Ollama. Nothing leaves the machine.
 * Backend "laya": Laya runs on this Mac (voice/laya_server.py). Too inaccurate so far (2026-10-09 tests).
 * Backend "typesafe": Jev on TypeSafe's API. The transcript goes out as text.
 * Both take the same question format and return the same answer shape.
 */

import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TypeSafeClient } from "@typesafe-ai/sdk";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Everything a human tunes lives here: backend, thresholds, questions, functions.
export const JEV = {
  backend: "gemma",
  gemmaModel: "gemma4:e2b-mlx",
  // Pinned so the TypeSafe thresholds keep meaning the same thing after a model release.
  typesafeModel: "jev-1.13.0",
  sendAt: 0.8, // addressed >= this (and complete, not echo): ask the brain now
  askAt: 0.5, // addressed in [askAt, sendAt): show "Was that for me?"
  completeAt: 0.6, // below this, hold the words and judge again with the next sentence
  echoAt: 0.5, // echo >= this: it is the assistant's own voice, ignore it
  // Requests that create something (an email, a meeting) need a higher bar to go without asking.
  actionSendAt: 0.9,
  actionIntents: ["email_write", "meeting"],
  // Laya's bars apply to P(route = assistant) from its trained choice question.
  laya: { sendAt: 0.7, actionSendAt: 0.85, askAt: 0.4, holdAt: 0.5 },
  // Echo is checked in code: share of the sentence's words found in the last answer.
  echoOverlap: 0.6,
  // What the second brain can do. Kept short: Laya reads at most 192 tokens of question and options.
  functions: {
    notes: "question about the user's notes, work, people, or files",
    todo: "tasks, to-dos, or deadlines",
    email_read: "read or summarize emails",
    email_write: "draft or send an email",
    calendar: "what is on the calendar",
    meeting: "create a meeting",
    memo_save: "save a memo",
    memo_find: "find saved memos",
    time: "time, date, or place",
    web: "news or a web search",
    follow_up: "follow-up on the last answer",
    stop: "stop talking",
  },
  canDo:
    "A voice assistant that answers questions from the user's notes, tasks, emails, and calendar, " +
    "drafts emails, creates meetings, saves memos, tells the time, searches the web, and stops talking when told.",
};

const QUESTIONS = {
  addressed: {
    type: "noul",
    instructions: "Is `speech.latest` said to the assistant described in `assistant.can_do`, as a question or request for it?",
    criteria: {
      true: "A question or request the assistant could act on, or telling it to stop",
      false: "Talk with another person, a call, thinking aloud, reading aloud, or TV sound",
    },
  },
  complete: {
    type: "noul",
    instructions: "Is `speech.latest` a complete question or request that can be acted on now, not cut off mid-sentence?",
  },
  echo: {
    type: "noul",
    instructions: "Is `speech.latest` mostly the same words as part of `assistant.last_answer`?",
  },
  intent: {
    type: "choice",
    instructions: "If `speech.latest` is a request to the assistant, which function does it need?",
    criteria: { ...JEV.functions, none_of_the_above: "not a request for any of these" },
  },
};

// Laya's yes/no answers were unusable, so it gets two choice questions, trained by
// voice/train_laya_listen.py. Keep these in step with that script.
const LAYA_QUESTIONS = {
  route: {
    type: "choice",
    instructions: "Who is this sentence for, and is it finished?",
    criteria: {
      assistant: "a finished question or request for the voice assistant",
      cut_off: "the start of a request to the assistant, cut off mid-sentence",
      other: "talk with other people, thinking aloud, or TV or phone sound",
    },
  },
  intent: {
    type: "choice",
    instructions: "What does the speaker want the voice assistant to do?",
    criteria: {
      notes: "answer from the user's notes",
      todo: "tasks, to-dos, deadlines",
      email_read: "read or summarize emails",
      email_write: "draft or send an email",
      calendar: "say what is on the calendar",
      meeting: "create a meeting",
      memo_save: "save a memo",
      memo_find: "find saved memos",
      time: "time, date, or place",
      web: "news or a web search",
      follow_up: "follow up on the last answer",
      stop: "stop talking",
      none: "nothing for the assistant",
    },
  },
};

/** Share of the sentence's words (3+ letters) that also appear in the last answer. */
function echoShare(latest, lastAnswer) {
  const words = (latest.toLowerCase().match(/\p{L}{3,}/gu) || []);
  if (words.length < 3 || !lastAnswer) return 0;
  const said = new Set(lastAnswer.toLowerCase().match(/\p{L}{3,}/gu) || []);
  return words.filter((w) => said.has(w)).length / words.length;
}

async function judgeWithLaya(heard, started) {
  const { answers, model, usage } = await askLaya(heard.latest, LAYA_QUESTIONS);
  const p = answers.route.probabilities;
  const intent = answers.intent.choice;
  const echo = echoShare(heard.latest, heard.lastAnswer || "");
  const bars = JEV.laya;
  const sendAt = JEV.actionIntents.includes(intent) ? bars.actionSendAt : bars.sendAt;
  let decision = "ignore";
  if (echo >= JEV.echoOverlap) decision = "ignore";
  else if (p.assistant >= sendAt) decision = "send";
  else if (p.cut_off >= bars.holdAt) decision = "hold";
  else if (p.assistant >= bars.askAt) decision = "ask";
  const ms = Date.now() - started;
  console.log(
    `Judge ${model}: ${decision} (assistant ${p.assistant}, cut_off ${p.cut_off}, other ${p.other}, ` +
      `echo ${echo.toFixed(2)}, intent ${intent}), ${usage?.input_tokens ?? "?"} tokens, ${ms} ms`
  );
  return { decision, intent, addressed: p.assistant, complete: 1 - p.cut_off, echo, model, ms };
}

// ---------- Gemma through Ollama, on this Mac ----------
const OLLAMA_URL = process.env.OLLAMA_URL || "http://127.0.0.1:11434";

// Worked examples teach the hard cases, above all questions to colleagues that mention
// emails or meetings. None of these sentences is in voice/laya_listen_data.py TEST or PROBE.
const GEMMA_EXAMPLES = [
  ["What's due on my list tomorrow?", true, true, "todo"],
  ["Rashid, did you send the email to the committee?", false, true, "none"],
  ["Read me the last email from Lina", true, true, "email_read"],
  ["Lina, can you check the grant budget today?", false, true, "none"],
  ["Book a meeting with Omar on Sunday at ten", true, true, "meeting"],
  ["We should meet next Monday about the audit", false, true, "none"],
  ["What do my notes say about the ICU dashboard?", true, true, "notes"],
  ["I told Maha the slides need another pass", false, true, "none"],
  ["Search the web for", true, false, "web"],
  ["Okay, I'll call you back later", false, true, "none"],
  ["Say that again", true, true, "follow_up"],
  ["Sorry, I was on mute, can you repeat?", false, true, "none"],
  ["Stop talking", true, true, "stop"],
  ["Did Omar reply to me yet?", true, true, "email_read"],
  ["Alright, that's plenty, thanks", true, true, "stop"],
  ["Anything urgent I need to handle today?", true, true, "todo"],
  ["Hmm, what did you say about the budget?", true, true, "follow_up"],
  ["Tell me about", true, false, "notes"],
  ["And now the weather for tomorrow", false, true, "none"],
];

const GEMMA_SCHEMA = {
  type: "object",
  properties: {
    for_assistant: { type: "boolean" },
    finished: { type: "boolean" },
    intent: { type: "string", enum: [...Object.keys(JEV.functions), "none"] },
  },
  required: ["for_assistant", "finished", "intent"],
};

function gemmaPrompt(heard) {
  const examples = GEMMA_EXAMPLES.map(([text, forAssistant, finished, intent]) =>
    `Sentence: ${text}\n${JSON.stringify({ for_assistant: forAssistant, finished, intent })}`
  ).join("\n\n");
  return [
    "You decide whether a sentence heard by a voice assistant's microphone is meant for the assistant.",
    JEV.canDo,
    "The microphone also hears the user talking with other people, on calls, thinking aloud, and TV.",
    "for_assistant is true for a question or request to the assistant, or telling it to stop.",
    "It is false when the user speaks to another person: calling them by name to ask or tell them something,",
    "or asking them 'did you...' about their own work. That holds even if it mentions emails or meetings.",
    "A question about what someone did for the user, such as whether they emailed or replied, is for the assistant.",
    "finished is false only when the sentence breaks off before its object, such as 'Send an email to'.",
    "A short or casual request is still finished.",
    heard.justAnswered ? `The assistant just said: ${(heard.lastAnswer || "").slice(0, 200)}` : "",
    "",
    examples,
    "",
    `Sentence: ${heard.latest}`,
  ].join("\n");
}

async function judgeWithGemma(heard, started) {
  const response = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: JEV.gemmaModel,
      prompt: gemmaPrompt(heard),
      stream: false,
      think: false,
      format: GEMMA_SCHEMA,
      keep_alive: "30m",
      options: { temperature: 0, num_predict: 60 },
    }),
    // Loading the model takes ~20 s the first time; warmJudge() normally does that earlier.
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`Ollama returned ${response.status}`);
  const data = await response.json();
  return decideFromVerdict(heard, JSON.parse(data.response), JEV.gemmaModel, started, data.prompt_eval_count);
}

/** Turn Gemma's verdict {for_assistant, finished, intent} into send / ask / hold / ignore. */
function decideFromVerdict(heard, verdict, model, started, tokens) {
  const intent = verdict.intent;
  const echo = echoShare(heard.latest, heard.lastAnswer || "");
  let decision = "ignore";
  if (echo >= JEV.echoOverlap || !verdict.for_assistant) decision = "ignore";
  else if (!verdict.finished) decision = "hold";
  // Gemma gives no probability, so requests that create something always ask first.
  else if (JEV.actionIntents.includes(intent)) decision = "ask";
  else decision = "send";
  const ms = Date.now() - started;
  console.log(
    `Judge ${model}: ${decision} (for_assistant ${verdict.for_assistant}, finished ${verdict.finished}, ` +
      `echo ${echo.toFixed(2)}, intent ${intent}), ${tokens ?? "?"} tokens, ${ms} ms`
  );
  return {
    decision, intent,
    addressed: verdict.for_assistant ? 1 : 0, complete: verdict.finished ? 1 : 0, echo,
    model, ms,
  };
}

/** Load the judge model now (an empty prompt only loads it), so the first sentence is fast. */
export async function warmJudge() {
  await fetch(`${OLLAMA_URL}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: JEV.gemmaModel, prompt: "", keep_alive: "30m" }),
  });
}

// ---------- Laya, on this Mac ----------
const LAYA_URL = "http://127.0.0.1:8181";
const LAYA_PYTHON = path.join(os.homedir(), "code", "laya_mlx", ".venv", "bin", "python");
const LAYA_SCRIPT = path.join(__dirname, "..", "voice", "laya_server.py");
let layaUp = null;

/** Start the Laya judge once (it loads the model in a few seconds) and wait until it answers. */
function ensureLaya() {
  if (!layaUp) {
    layaUp = (async () => {
      try {
        if ((await fetch(`${LAYA_URL}/health`)).ok) return;
      } catch { /* not running yet */ }
      // HF_HUB_OFFLINE: use the downloaded model and never call Hugging Face.
      const child = spawn(LAYA_PYTHON, [LAYA_SCRIPT], {
        stdio: ["ignore", "ignore", "pipe"],
        env: { ...process.env, HF_HUB_OFFLINE: "1" },
      });
      child.stderr.on("data", (chunk) => {
        const text = String(chunk).trim();
        if (text) console.error(`Laya: ${text.slice(0, 300)}`);
      });
      child.on("exit", (code) => {
        layaUp = null;
        if (code) console.error(`Laya stopped (exit ${code}).`);
      });
      process.on("exit", () => child.kill());
      for (let i = 0; i < 120; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        try {
          if ((await fetch(`${LAYA_URL}/health`)).ok) return;
        } catch { /* still loading */ }
      }
      throw new Error("Laya did not start.");
    })();
    layaUp.catch(() => { layaUp = null; });
  }
  return layaUp;
}

async function askLaya(state, questions) {
  await ensureLaya();
  const response = await fetch(`${LAYA_URL}/system_one`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ state, questions }),
    signal: AbortSignal.timeout(4000),
  });
  if (!response.ok) throw new Error(`Laya returned ${response.status}`);
  return response.json();
}

// ---------- Jev, on TypeSafe's API ----------
let client = null;

function askTypeSafe(state, questions) {
  if (!client) {
    if (!process.env.TYPESAFE_API_KEY && process.env.typesafe_api_key) {
      process.env.TYPESAFE_API_KEY = process.env.typesafe_api_key;
    }
    if (!process.env.TYPESAFE_API_KEY) throw new Error("Missing TYPESAFE_API_KEY in .env.");
    client = new TypeSafeClient({ defaultModel: JEV.typesafeModel, timeout: 4000 });
  }
  return client.systemOne({ state, questions });
}

/**
 * @param {{ latest: string, earlier?: string[], lastAnswer?: string, justAnswered?: boolean }} heard
 * @returns {Promise<{ decision: "send"|"ask"|"hold"|"ignore", intent: string, addressed: number, complete: number, echo: number, model: string, ms: number }>}
 */
export async function judgeSpeech(heard) {
  const started = Date.now();
  // The page's Wake menu picks the backend; JEV.backend is the default.
  const backend = heard.backend || JEV.backend;
  if (backend === "gemma") return judgeWithGemma(heard, started);
  if (backend === "laya") return judgeWithLaya(heard, started);
  const state = {
    speech: {
      latest: heard.latest,
      earlier: (heard.earlier || []).slice(-2),
    },
    assistant: {
      can_do: JEV.canDo,
      last_answer: (heard.lastAnswer || "").slice(0, 300),
      just_answered: Boolean(heard.justAnswered),
    },
  };
  const { answers, model, usage } = await askTypeSafe(state, QUESTIONS);

  const addressed = answers.addressed.noul;
  const complete = answers.complete.noul;
  const echo = answers.echo.noul;
  const intent = answers.intent.choice;

  const sendAt = JEV.actionIntents.includes(intent) ? JEV.actionSendAt : JEV.sendAt;
  let decision = "ignore";
  if (echo >= JEV.echoAt) decision = "ignore";
  // Maybe for the assistant but cut off: wait for the rest before deciding.
  else if (addressed >= JEV.askAt && complete < JEV.completeAt) decision = "hold";
  else if (addressed >= sendAt) decision = "send";
  else if (addressed >= JEV.askAt) decision = "ask";

  const ms = Date.now() - started;
  // Log the judgment, not the words: the transcript can hold private talk.
  console.log(
    `Judge ${model}: ${decision} (addressed ${addressed}, complete ${complete}, echo ${echo}, intent ${intent}), ` +
      `${usage?.input_tokens ?? "?"} tokens, ${ms} ms`
  );
  return { decision, intent, addressed, complete, echo, model, ms };
}
