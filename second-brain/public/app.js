/**
 * Page logic for the second brain.
 *
 * You type a question, or press Speak and talk.
 * The Mac turns speech into text for free (no OpenAI charge).
 * The server searches your notes, then GPT-6 Luna writes the answer.
 * Words appear as they arrive, so you do not wait for the whole reply.
 */

const questionEl = document.getElementById("question");
const askBtn = document.getElementById("askBtn");
const micBtn = document.getElementById("micBtn");
const readBtn = document.getElementById("readBtn");
const statusEl = document.getElementById("status");
const threadEl = document.getElementById("thread");
const sourcesEl = document.getElementById("sources");
const brandLine = document.getElementById("brandLine");
const modelSelect = document.getElementById("modelSelect");
const reasoningSelect = document.getElementById("reasoningSelect");
const ratesEl = document.getElementById("rates");
const inTokensEl = document.getElementById("inTokens");
const outTokensEl = document.getElementById("outTokens");
const thinkTokensEl = document.getElementById("thinkTokens");
const chatPriceEl = document.getElementById("chatPrice");
const breakdownEl = document.getElementById("breakdown");
const sessionPriceEl = document.getElementById("sessionPrice");

let chosenModelId = "";
let chatTurns = [];
let chatMemory = "";
let compressAbort = null;
let compressGen = 0;
let busy = false;
let catalog = null;
let defaultModelId = "gpt-oss:20b";
let sessionUsd = 0;
let activeTurn = null;
let latestAnswer = "";

function setStatus(text) {
  statusEl.textContent = text;
}

function showSources(sources) {
  sourcesEl.replaceChildren();
  if (!sources.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "None yet";
    sourcesEl.append(li);
    return;
  }
  for (const source of sources) {
    const li = document.createElement("li");
    const title = document.createElement("span");
    title.textContent = source.title;
    const file = document.createElement("span");
    file.className = "file";
    if (/^https?:\/\//.test(source.file || "")) {
      const link = document.createElement("a");
      link.href = source.file;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = source.file;
      file.append(link);
    } else {
      file.textContent = source.file;
    }
    li.append(title, file);
    sourcesEl.append(li);
  }
}

function formatUsd(amount) {
  if (!amount) return "$0.00";
  if (amount < 0.01) return `$${amount.toFixed(6)}`;
  if (amount < 1) return `$${amount.toFixed(4)}`;
  return `$${amount.toFixed(2)}`;
}

function formatRate(amount) {
  return `$${Number(amount).toFixed(2)}`;
}

function selectedModel() {
  return catalog?.models.find((model) => model.id === modelSelect.value) || null;
}

/** Show the price list for whatever model is selected right now. */
function showRates() {
  const model = selectedModel();
  if (!model) {
    ratesEl.textContent = "Prices are still loading.";
    return;
  }
  const billing = model.local
    ? "It runs on this Mac, so the answer is free."
    : "Higher reasoning adds thinking tokens, billed at the output price.";
  ratesEl.textContent = `${model.label}: ${formatRate(model.inputPerMillion)} per million input tokens, ${formatRate(model.outputPerMillion)} per million output tokens. ${model.blurb}. ${billing}`;
}

function fillReasoning() {
  const model = selectedModel();
  const previous = reasoningSelect.value;
  reasoningSelect.replaceChildren();
  if (!model) return;

  for (const level of catalog.reasoning) {
    if (!model.reasoning.includes(level.id)) continue;
    const option = document.createElement("option");
    option.value = level.id;
    option.textContent = level.label;
    reasoningSelect.append(option);
  }

  // First visit: thinking off when this model allows it.
  const fallback = model.reasoning.includes("none") ? "none" : model.reasoning[0];
  reasoningSelect.value = model.reasoning.includes(previous) ? previous : fallback;
}

function fillModels() {
  modelSelect.replaceChildren();
  for (const model of catalog.models) {
    const option = document.createElement("option");
    option.value = model.id;
    option.textContent = `${model.label} — ${formatRate(model.inputPerMillion)} / ${formatRate(model.outputPerMillion)} per 1M`;
    if (model.id === defaultModelId) option.selected = true;
    modelSelect.append(option);
  }
  chosenModelId = modelSelect.value;
  fillReasoning();
  showRates();
}

async function releasePreviousLocalModel(previousId) {
  const previous = catalog?.models.find((model) => model.id === previousId);
  const next = selectedModel();
  if (!previous?.local || !next?.local || previous.id === next.id) return;
  compressAbort?.abort();
  compressGen += 1;
  setStatus(`Stopping ${previous.label}…`);
  try {
    const response = await fetch("/stop-model", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: previous.id }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not stop the previous model.");
    if (data.stopped) {
      setStatus(`${previous.label} was stopped. It is no longer using memory.`);
      return;
    }
    setStatus(`${previous.label} was already out of memory.`);
  } catch (err) {
    console.error("Failed while stopping the previous local model:", err);
    setStatus(err.message || `Could not stop ${previous.label}.`);
  }
}

function resetChatMeter() {
  inTokensEl.textContent = "…";
  outTokensEl.textContent = "…";
  thinkTokensEl.textContent = "…";
  chatPriceEl.textContent = "…";
  breakdownEl.textContent = "Counting tokens for this answer…";
}

function showUsage(usage) {
  inTokensEl.textContent = usage.inputTokens.toLocaleString();
  outTokensEl.textContent = usage.outputTokens.toLocaleString();
  thinkTokensEl.textContent = usage.reasoningTokens.toLocaleString();
  chatPriceEl.textContent = formatUsd(usage.usd);
  if (activeTurn) {
    const total = (usage.inputTokens || 0) + (usage.outputTokens || 0);
    activeTurn.meta.textContent = `This question: ${total.toLocaleString()} tokens · ${formatUsd(usage.usd)}`;
  }

  const freshInput = Math.max(0, usage.inputTokens - usage.cachedTokens);
  const bits = [
    `${freshInput.toLocaleString()} new input × ${formatRate(usage.inputRate)}/M`,
  ];
  if (usage.cachedTokens) {
    bits.push(`${usage.cachedTokens.toLocaleString()} cached input × ${formatRate(usage.cachedRate)}/M`);
  }
  bits.push(`${usage.outputTokens.toLocaleString()} output × ${formatRate(usage.outputRate)}/M`);
  let line = `${bits.join(" + ")} = ${formatUsd(usage.usd)}`;
  if (usage.reasoningTokens) {
    line += `. ${usage.reasoningTokens.toLocaleString()} of the output tokens were thinking.`;
  }
  if (usage.longContext) {
    line += " Long notes used the higher long-context rates.";
  }
  breakdownEl.textContent = line;

  sessionUsd += usage.usd;
  sessionPriceEl.textContent = formatUsd(sessionUsd);
}

async function loadHealth() {
  try {
    const [healthResponse, modelsResponse] = await Promise.all([
      fetch("/health"),
      fetch("/models"),
    ]);
    const health = await healthResponse.json();
    catalog = await modelsResponse.json();
    if (health.defaultModel) defaultModelId = health.defaultModel;
    brandLine.textContent = `${health.notes.toLocaleString()} notes loaded`;
    fillModels();
  } catch (err) {
    console.error("Failed while checking the server:", err);
    brandLine.textContent = "Server did not respond";
    ratesEl.textContent = "Could not load model prices.";
  }
}

function beginTurn(question) {
  threadEl.querySelector(".empty")?.remove();
  const turn = document.createElement("article");
  turn.className = "turn";

  const questionLine = document.createElement("p");
  questionLine.className = "turn-q";
  questionLine.textContent = question;

  const answerLine = document.createElement("div");
  answerLine.className = "turn-a";

  const sources = document.createElement("ul");
  sources.className = "turn-sources";
  sources.hidden = true;

  const meta = document.createElement("p");
  meta.className = "turn-meta";
  meta.textContent = "Counting tokens…";

  turn.append(questionLine, answerLine, sources, meta);
  threadEl.append(turn);
  threadEl.scrollTop = threadEl.scrollHeight;
  return { answerLine, sources, meta };
}

async function ask() {
  const question = questionEl.value.trim();
  if (!question || busy) return;

  busy = true;
  askBtn.disabled = true;
  readBtn.hidden = true;
  latestAnswer = "";
  activeTurn = beginTurn(question);
  showSources([]);
  resetChatMeter();
  setStatus("Searching your notes…");

  try {
    const response = await fetch("/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        question,
        history: chatTurns,
        memory: chatMemory,
        model: modelSelect.value,
        reasoning: reasoningSelect.value,
      }),
    });

    if (!response.ok || !response.body) {
      let message = "The server could not answer.";
      try {
        const data = await response.json();
        if (data.error) message = data.error;
      } catch {
        /* The error body was not JSON. Keep the plain message above. */
      }
      throw new Error(message);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let started = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const chunks = buffer.split("\n\n");
      buffer = chunks.pop() || "";

      for (const chunk of chunks) {
        const line = chunk.split("\n").find((item) => item.startsWith("data:"));
        if (!line) continue;
        let event;
        try {
          event = JSON.parse(line.slice(5).trim());
        } catch (err) {
          console.error("Failed while reading an answer chunk:", err);
          continue;
        }

        if (event.type === "status") {
          setStatus(event.message || "Looking on the web…");
        } else if (event.type === "sources") {
          showSources(event.sources || []);
          fillTurnSources(activeTurn, event.sources || []);
          setStatus(event.sources?.length ? "Writing the answer…" : "No matching notes");
        } else if (event.type === "delta") {
          if (!started) {
            activeTurn.answerLine.textContent = "";
            started = true;
          }
          latestAnswer += event.text || "";
          activeTurn.answerLine.textContent = latestAnswer;
          threadEl.scrollTop = threadEl.scrollHeight;
        } else if (event.type === "usage") {
          showUsage(event);
        } else if (event.type === "error") {
          throw new Error(event.message || "Something went wrong while answering.");
        } else if (event.type === "done") {
          setStatus("Done");
        }
      }
    }

    if (latestAnswer.trim()) readBtn.hidden = false;
  } catch (err) {
    console.error("Failed while asking:", err);
    setStatus(err.message || "Something went wrong.");
    if (activeTurn && !activeTurn.answerLine.textContent) {
      activeTurn.answerLine.textContent = err.message || "Something went wrong.";
    }
  } finally {
    if (question) {
      chatTurns.push({
        question,
        answer: latestAnswer.trim() || "(The answer was stopped.)",
      });
      if (chatTurns.length > 8) chatTurns = chatTurns.slice(-8);
      compressInBackground();
    }
    busy = false;
    askBtn.disabled = false;
  }
}

function compressInBackground() {
  const size = chatMemory.length + chatTurns.reduce((sum, turn) => sum + turn.question.length + turn.answer.length, 0);
  if (size < 500) return;
  compressAbort?.abort();
  const controller = new AbortController();
  compressAbort = controller;
  const generation = ++compressGen;
  const snapshot = chatTurns.slice();
  const prior = chatMemory;
  fetch("/compress", {
    method: "POST",
    signal: controller.signal,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ history: snapshot, memory: prior }),
  }).then(async (response) => {
    if (!response.ok || generation !== compressGen) return;
    const data = await response.json();
    if (!data.memory || generation !== compressGen) return;
    chatMemory = data.memory;
    const last = snapshot[snapshot.length - 1];
    const stillThere = chatTurns.findIndex((turn) => turn.question === last?.question && turn.answer === last?.answer);
    if (stillThere >= 0) chatTurns = chatTurns.slice(stillThere);
  }).catch((err) => {
    if (err?.name === "AbortError") return;
    console.error("Failed while compressing the chat:", err);
  });
}

function setupMic() {
  const Speech = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Speech) {
    micBtn.hidden = true;
    return;
  }

  const recognition = new Speech();
  recognition.lang = "en-US";
  recognition.interimResults = false;

  recognition.onstart = () => {
    micBtn.classList.add("listening");
    micBtn.textContent = "Listening…";
    setStatus("Listening…");
  };

  recognition.onend = () => {
    micBtn.classList.remove("listening");
    micBtn.textContent = "Speak";
  };

  recognition.onerror = (event) => {
    console.error("Failed while listening:", event.error);
    setStatus("Could not hear you. Try again, or type the question.");
  };

  recognition.onresult = (event) => {
    const said = event.results[0][0].transcript;
    questionEl.value = said;
    ask();
  };

  micBtn.addEventListener("click", () => {
    try {
      recognition.start();
    } catch (err) {
      console.error("Failed while starting the microphone:", err);
      setStatus("The microphone is already listening.");
    }
  });
}

function fillTurnSources(turn, sources) {
  if (!turn) return;
  turn.sources.replaceChildren();
  const named = sources.filter((source) => source.title || source.file);
  turn.sources.hidden = named.length === 0;
  for (const source of named) {
    const item = document.createElement("li");
    item.textContent = source.title || source.file;
    turn.sources.append(item);
  }
}

readBtn.addEventListener("click", () => {
  const text = latestAnswer.trim();
  if (!text || !window.speechSynthesis) return;
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(new SpeechSynthesisUtterance(text));
});

modelSelect.addEventListener("change", () => {
  const previousId = chosenModelId;
  chosenModelId = modelSelect.value;
  fillReasoning();
  showRates();
  releasePreviousLocalModel(previousId);
});
reasoningSelect.addEventListener("change", showRates);

askBtn.addEventListener("click", ask);
questionEl.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    ask();
  }
});

setupMic();
loadHealth();
