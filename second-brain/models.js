/**
 * Talking to the models: stream an answer from OpenAI, Ollama, or Claude Code, one
 * non-streaming call for small jobs, token usage events, and the PDF catcher around them.
 */

import { LOCAL_REPLY_CAP, LOCAL_THINK_ROOM, OLLAMA_URL, OUTPUT_CAP } from "./config.js";
import { renderPdf } from "./pdf.js";
import { priceForUsage } from "./pricing.js";
import { INSTRUCTIONS, SPOKEN_STYLE, guideBlock } from "./prompt.js";
import { loadedLocalId, selected, setLoadedLocalId } from "./state.js";
import { spawn } from "node:child_process";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * One short answer from the model selected on the page, without streaming.
 * Returns "" when the model could not answer.
 */
export async function askModelOnce(model, instruction, text, apiKey, maxTokens, timeoutMs = 45000) {
  let raw = "";
  if (model.local) {
    const upstream = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: model.id,
        stream: false,
        think: false,
        messages: [
          { role: "system", content: instruction },
          { role: "user", content: text },
        ],
        keep_alive: "30m",
        options: { num_ctx: 4096, num_predict: Math.round(maxTokens * 0.9) },
      }),
    });
    if (!upstream.ok) return "";
    const data = await upstream.json();
    raw = data.message?.content || "";
    setLoadedLocalId(model.id);
  } else if (model.subscription) {
    await askClaude(model, instruction, text, "low", (piece) => { raw += piece; }, timeoutMs);
  } else if (apiKey) {
    const upstream = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      signal: AbortSignal.timeout(30000),
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: model.id,
        input: `${instruction}\n\n${text}`,
        max_output_tokens: maxTokens,
      }),
    });
    if (!upstream.ok) return "";
    const data = await upstream.json();
    raw = data.output_text
      || (data.output || []).flatMap((item) => item.content || []).map((part) => part.text || "").join("");
  }
  return String(raw).replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

/**
 * Read OpenAI's event stream and forward only the answer text.
 * OpenAI sends blocks that look like:
 *   event: response.output_text.delta
 *   data: {"delta":"Hello"}
 */
export async function streamAnswer(apiKey, prompt, res, model, reasoning, spoken, photo = "") {
  let upstream;
  try {
    upstream = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: model.id,
        reasoning: { effort: reasoning },
        instructions: [INSTRUCTIONS, spoken ? SPOKEN_STYLE : "", guideBlock()].filter(Boolean).join("\n\n"),
        input: photo
          ? [{
              role: "user",
              content: [
                { type: "input_text", text: prompt },
                { type: "input_image", image_url: photo },
              ],
            }]
          : prompt,
        max_output_tokens: OUTPUT_CAP[reasoning] || OUTPUT_CAP.medium,
        stream: true,
      }),
    });
  } catch (err) {
    const reason = err?.cause?.message || err?.message || String(err);
    console.error("Failed while calling OpenAI:", reason);
    throw new Error(`Could not reach OpenAI (${reason}).`);
  }

  if (!upstream.ok || !upstream.body) {
    const details = await upstream.text();
    console.error("OpenAI request failed:", upstream.status, redactSecrets(details));
    throw new Error(`OpenAI returned an error (${upstream.status}).`);
  }

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let sentUsage = false;
  const seenEvents = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const chunks = buffer.split("\n\n");
    buffer = chunks.pop() || "";

    for (const chunk of chunks) {
      let eventName = "message";
      let data = "";
      for (const line of chunk.split("\n")) {
        if (line.startsWith("event:")) eventName = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      if (!data || data === "[DONE]") continue;
      seenEvents.push(eventName);

      let payload;
      try {
        payload = JSON.parse(data);
      } catch {
        continue;
      }

      if (eventName === "response.output_text.delta" && payload.delta) {
        writeEvent(res, { type: "delta", text: payload.delta });
      } else if (
        eventName === "response.completed" ||
        eventName === "response.incomplete" ||
        payload.type === "response.completed" ||
        payload.type === "response.incomplete"
      ) {
        const usage = payload.response?.usage || payload.usage;
        if (usage && !sentUsage) {
          sentUsage = true;
          writeEvent(res, usageEvent(model, reasoning, usage));
        }
      } else if (eventName === "response.failed" || eventName === "error") {
        const message = payload.error?.message || payload.message || "OpenAI failed while answering.";
        console.error("OpenAI stream error:", redactSecrets(message));
        writeEvent(res, { type: "error", message: clientError(message, "OpenAI failed while answering.") });
      }
    }
  }

  if (!sentUsage) {
    console.error(
      "OpenAI finished without a token report. Events seen:",
      [...new Set(seenEvents)].join(", ") || "(none)"
    );
  }
}

/** Turn the Thinking menu into Ollama's think setting. Off means no hidden thinking. */
export function ollamaThink(reasoning) {
  if (!reasoning || reasoning === "none") return false;
  if (reasoning === "low" || reasoning === "medium" || reasoning === "high") return reasoning;
  return "high";
}

/**
 * Ask the local Ollama model and stream the answer the same way OpenAI does.
 * Thinking text is kept out of the spoken answer. Token counts come from Ollama.
 */
export async function streamLocalAnswer(prompt, res, model, reasoning, spoken, longSpoken = false) {
  let upstream;
  try {
    upstream = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: model.id,
        stream: true,
        think: ollamaThink(reasoning),
        messages: [
          {
            role: "system",
            content: [
              INSTRUCTIONS,
              // A short cap keeps Bonsai from talking for minutes.
              // GPT-OSS is uncapped, so it may use as many words as the answer needs.
              model.uncapped || longSpoken
                ? "The answer will be read aloud. Write the full answer. Do not stop early."
                : "The answer will be read aloud. Use at most 3 short sentences, then stop.",
              spoken ? SPOKEN_STYLE : "",
              guideBlock(),
            ].filter(Boolean).join("\n\n"),
          },
          { role: "user", content: prompt },
        ],
        // Bonsai defaults to a 262k-token window, which reserves ~22 GB and
        // made one answer take 90s. The prompt is a few note excerpts, so 16k is plenty.
        // keep_alive keeps the model loaded between questions, so no 4s reload.
        // num_predict is small so a spoken reply cannot run on for minutes.
        // -1 means no output limit. Ollama stops when the model is done.
        keep_alive: "30m",
        options: {
          num_ctx: 16384,
          num_predict: model.uncapped
            ? -1
            : longSpoken
              ? 900 + (LOCAL_THINK_ROOM[reasoning] || 0)
              : (LOCAL_REPLY_CAP[reasoning] || LOCAL_REPLY_CAP.none) + (LOCAL_THINK_ROOM[reasoning] || 0),
        },
      }),
    });
  } catch (err) {
    const reason = err?.cause?.message || err?.message || String(err);
    console.error("Failed while calling the local model:", reason);
    throw new Error("Could not reach the local model. Start Ollama, then try again.");
  }

  if (!upstream.ok || !upstream.body) {
    const details = await upstream.text();
    console.error("Local model request failed:", upstream.status, details);
    throw new Error(`The local model returned an error (${upstream.status}).`);
  }

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.trim()) continue;
      let payload;
      try {
        payload = JSON.parse(line);
      } catch (err) {
        console.error("Failed while reading the local model stream:", err);
        continue;
      }
      if (payload.error) {
        const message = String(payload.error);
        console.error("Local model stream error:", redactSecrets(message));
        writeEvent(res, { type: "error", message: clientError(message, "The local model failed while answering.") });
        continue;
      }
      const piece = payload.message?.content || "";
      if (piece) writeEvent(res, { type: "delta", text: piece });
      if (payload.done) {
        writeEvent(res, usageEvent(model, reasoning, {
          input_tokens: payload.prompt_eval_count || 0,
          output_tokens: payload.eval_count || 0,
        }));
      }
    }
  }
}

// Claude Code on this Mac. The server may start without ~/.local/bin on its PATH.
export const CLAUDE_BIN = process.env.CLAUDE_BIN
  || [path.join(os.homedir(), ".local/bin/claude"), "/opt/homebrew/bin/claude"].find((p) => fsSync.existsSync(p))
  || "claude";

/**
 * Ask Claude through Claude Code (`claude -p`), which uses the logged-in Claude
 * subscription, not an API key. No saved session, no user settings,
 * so hooks and plugins from ~/.claude do not run for every answer.
 * With dirs, Claude may read (never write) files in those folders, and may start
 * helper agents (Task) that read in parallel; without dirs, it has no tools.
 * onText gets each piece of the answer; onHelpers(n) gets the number of helpers started so far.
 * Resolves with the token usage.
 */
export function askClaude(model, system, prompt, effort, onText, timeoutMs = 120000, dirs = [], onHelpers = () => {}) {
  return new Promise((resolve, reject) => {
    const tools = dirs.length ? "Read,Glob,Grep,Task" : "";
    const args = [
      "-p", "--model", model.cliModel, "--tools", tools, "--no-session-persistence",
      "--setting-sources", "", "--strict-mcp-config", "--system-prompt", system,
      "--output-format", "stream-json", "--include-partial-messages", "--verbose",
    ];
    if (tools) args.push("--allowedTools", tools);
    if (dirs.length > 1) args.push("--add-dir", ...dirs.slice(1));
    if (effort) args.push("--effort", effort);
    const env = { ...process.env };
    // An API key here would bill the API instead of the subscription.
    delete env.ANTHROPIC_API_KEY;
    const child = spawn(CLAUDE_BIN, args, { cwd: dirs[0] || os.tmpdir(), env });
    const timer = setTimeout(() => child.kill(), timeoutMs);
    let buffer = "";
    let stderr = "";
    let result = null;
    let helpers = 0;

    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        // Only the main agent's text is the answer; helpers' own text stays inside.
        if (msg.parent_tool_use_id) continue;
        const delta = msg.type === "stream_event" && msg.event?.type === "content_block_delta" ? msg.event.delta : null;
        if (delta?.type === "text_delta" && delta.text) onText(delta.text);
        if (msg.type === "assistant") {
          const started = (msg.message?.content || []).filter((c) => c.type === "tool_use" && (c.name === "Agent" || c.name === "Task")).length;
          if (started) onHelpers((helpers += started));
        }
        if (msg.type === "result") result = msg;
      }
    });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`Could not start Claude Code (${err.message}). Is it installed and logged in?`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (result && !result.is_error) {
        const u = result.usage || {};
        const cached = u.cache_read_input_tokens || 0;
        return resolve({
          input_tokens: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + cached,
          input_tokens_details: { cached_tokens: cached },
          output_tokens: u.output_tokens || 0,
        });
      }
      const why = redactSecrets(result?.result || stderr.trim() || `exit code ${code}`);
      console.error("Claude Code failed:", why);
      reject(new Error(`Claude returned an error (${String(why).slice(0, 200)}).`));
    });
    child.stdin.end(prompt);
  });
}

export async function streamClaudeAnswer(prompt, res, model, reasoning, spoken, readDirs) {
  const dirs = Array.isArray(readDirs) && readDirs.length ? readDirs : selected;
  const files = [
    `You can read these folders with the Read, Glob and Grep tools: ${dirs.join(", ")}.`,
    "Use them when the question is about a folder or file that the note excerpts do not cover. Read can open PDFs.",
    readDirs ? "When a skill is on, its other files are in the first folder. Read them when the skill tells you to." : "",
    "When a question needs several separate searches (for example notes, email, and documents, or several folders), start helper agents with the Task tool so they search in parallel, then combine what they found. Answer simple questions yourself.",
    "You cannot write files or run commands. To give the user a file, make a PDF with PDF_BODY and the app saves it. Never type tool-call markup such as <invoke> in your answer.",
    "Do not narrate your searching. Answer only after you have looked.",
  ].filter(Boolean).join(" ");
  const system = [INSTRUCTIONS, files, spoken ? SPOKEN_STYLE : "", guideBlock()].filter(Boolean).join("\n\n");
  const onHelpers = (n) => writeEvent(res, { type: "status", message: `Working with ${n} helper${n === 1 ? "" : "s"}…` });
  const usage = await askClaude(model, system, prompt, reasoning, (text) => writeEvent(res, { type: "delta", text }), 300000, dirs, onHelpers);
  writeEvent(res, usageEvent(model, reasoning, usage));
}

export function writeEvent(res, obj) {
  // While a PDF is being written, its HTML stays here instead of going to the voice.
  const pdf = res.locals?.pdf;
  if (pdf && obj.type === "delta") {
    const text = pdf.feed(obj.text);
    if (pdf.seen && !pdf.told) {
      pdf.told = true;
      res.write(`data: ${JSON.stringify({ type: "status", message: "Making the PDF…" })}\n\n`);
    }
    if (!text) return;
    obj = { type: "delta", text };
  }
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

/** After the answer: release held words, print the PDF if one was written, and tell the page. */
export async function finishPdf(res) {
  const pdf = res.locals?.pdf;
  if (!pdf) return;
  res.locals.pdf = null;
  const tail = pdf.flush();
  if (tail) writeEvent(res, { type: "delta", text: tail });
  if (!pdf.body.trim()) return;
  try {
    const made = await renderPdf(pdf.body);
    console.log(`Made a PDF (${made.name})`);
    writeEvent(res, { type: "pdf", id: made.id, name: made.name, url: `/pdf/${made.id}` });
  } catch (err) {
    console.error("Failed while making a PDF:", err?.message || err);
    writeEvent(res, { type: "delta", text: " The PDF could not be made." });
  }
}

/** A short spoken answer, plus an optional card on the voice page. */
export function replyNow(res, text, card) {
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.flushHeaders?.();
  if (card) writeEvent(res, { type: "work", card });
  writeEvent(res, { type: "delta", text });
  writeEvent(res, { type: "done" });
  res.end();
}

/** Package token counts and the dollar price for this one chat. */
export function usageEvent(model, reasoning, usage) {
  const priced = priceForUsage(model, usage);
  return {
    type: "usage",
    model: model.id,
    reasoning,
    ...priced,
  };
}

/** Hide key-shaped text in logs and error lines. OpenAI and Claude are still called. */
export function redactSecrets(text) {
  return String(text || "")
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-hidden")
    .replace(/AIza[0-9A-Za-z_-]{10,}/g, "AIza-hidden")
    .replace(/apikey_[A-Za-z0-9_]+/g, "apikey-hidden");
}

/** A short line for the browser. The full detail stays in the server log. */
export function clientError(text, fallback) {
  const clean = redactSecrets(text).replace(/\s+/g, " ").trim().slice(0, 240);
  return clean || fallback;
}

export function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function ollamaNamesMatch(runningName, modelId) {
  const name = String(runningName || "").toLowerCase();
  const want = String(modelId || "").toLowerCase();
  if (!name || !want) return false;
  return name === want || name.startsWith(`${want}:`) || want.startsWith(`${name}:`);
}

export async function ollamaLoadedModels() {
  const response = await fetch(`${OLLAMA_URL}/api/ps`);
  if (!response.ok) return [];
  const data = await response.json();
  return Array.isArray(data.models) ? data.models : [];
}

/** Tell Ollama to drop a local model so it no longer uses memory. */
export async function stopOllamaModel(modelId) {
  const running = await ollamaLoadedModels();
  const hit = running.find((item) => ollamaNamesMatch(item.name || item.model, modelId));
  if (!hit) return { stopped: false, wasLoaded: false };
  const name = hit.name || hit.model || modelId;
  const response = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: name, keep_alive: 0 }),
  });
  if (!response.ok) {
    const details = await response.text();
    console.error("Failed while stopping a local model:", response.status, details);
    throw new Error("Ollama could not stop the previous model.");
  }
  await response.text();
  if (loadedLocalId && ollamaNamesMatch(loadedLocalId, modelId)) setLoadedLocalId("");
  return { stopped: true, wasLoaded: true, name };
}

/** Drop every model Ollama still has loaded, so none of them keep using memory. */
export async function stopAllOllamaModels() {
  const running = await ollamaLoadedModels();
  const stopped = [];
  for (const item of running) {
    const name = item.name || item.model;
    if (!name) continue;
    try {
      const result = await stopOllamaModel(name);
      if (result.stopped) stopped.push(result.name || name);
    } catch (err) {
      console.error(`Failed while stopping ${name}:`, err?.message || err);
    }
  }
  setLoadedLocalId("");
  return { stopped };
}
